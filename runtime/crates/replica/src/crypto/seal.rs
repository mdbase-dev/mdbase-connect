//! Sealing a payload (`sealed-envelope.md` §3).
//!
//! ```text
//! frame   = u8(alg) ‖ u32be(len(data)) ‖ u32be(raw_len) ‖ data
//! padded  = frame ‖ zeros up to padme(len(frame))
//! k       = HKDF-SHA256(ikm = K, salt, info = "mdbase/v1/payload")
//! c_i     = ChaCha20-Poly1305(k, u88be(i) ‖ u8(final), segment_i, aad)   (64 KiB segments)
//! body    = c_0 ‖ … ‖ c_{n-1}
//! ```

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use mdbn_wire::common::B16;
use mdbn_wire::envelope::Item;
use zeroize::Zeroizing;

use super::{CryptoError, CsprngEntropy, hkdf32};

/// Plaintext segment size.
pub const SEGMENT: usize = 65_536;
/// Ciphertext segment size (segment + 16-byte tag).
pub const SEGMENT_CT: usize = SEGMENT + 16;
/// Largest payload (decompression-bomb guard, `log-entry.md` §10).
pub const MAX_PLAIN: usize = 16 << 20;

/// Compression algorithm IDs.
const ALG_NONE: u8 = 0;
const ALG_DEFLATE: u8 = 1;
const FRAME_HEADER: usize = 9;

/// `floor(log2(x))` for `x ≥ 1`, without floats.
fn ilog2(x: u64) -> u64 {
    u64::from(63 - x.leading_zeros())
}

/// Padmé (Nikitin et al. 2019): the padded length of `l`.
pub fn padme(l: u64) -> u64 {
    if l < 2 {
        return l;
    }
    let e = ilog2(l);
    let s = ilog2(e.max(1)) + 1;
    let z = e.saturating_sub(s);
    let m = (1u64 << z) - 1;
    (l + m) & !m
}

/// Build the padded frame for `plain`.
fn frame(plain: &[u8], compress: bool) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    if plain.len() > MAX_PLAIN {
        return Err(CryptoError::TooLarge);
    }
    let deflated = if compress && !plain.is_empty() {
        let c = Zeroizing::new(miniz_oxide::deflate::compress_to_vec(plain, 6));
        // Use DEFLATE only when it saves at least 5%.
        (c.len() * 20 <= plain.len() * 19).then_some(c)
    } else {
        None
    };
    let (alg, data): (u8, &[u8]) = match &deflated {
        Some(c) => (ALG_DEFLATE, c.as_slice()),
        None => (ALG_NONE, plain),
    };
    let len = u32::try_from(data.len()).map_err(|_| CryptoError::TooLarge)?;
    let raw = u32::try_from(plain.len()).map_err(|_| CryptoError::TooLarge)?;
    let flen = FRAME_HEADER + data.len();
    let padded = usize::try_from(padme(flen as u64)).map_err(|_| CryptoError::TooLarge)?;
    let mut out = Zeroizing::new(Vec::with_capacity(padded));
    out.push(alg);
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(&raw.to_be_bytes());
    out.extend_from_slice(data);
    out.resize(padded, 0);
    Ok(out)
}

/// Parse a padded frame back into the plaintext.
fn unframe(padded: &[u8], max_plain: usize) -> Result<Vec<u8>, CryptoError> {
    if padded.len() < FRAME_HEADER {
        return Err(CryptoError::Open);
    }
    let alg = padded[0];
    let len = u32::from_be_bytes([padded[1], padded[2], padded[3], padded[4]]) as usize;
    let raw = u32::from_be_bytes([padded[5], padded[6], padded[7], padded[8]]) as usize;
    if raw > max_plain || raw > MAX_PLAIN || len > padded.len() - FRAME_HEADER {
        return Err(CryptoError::Open);
    }
    // One encoding: the padded length is exactly padme(frame length).
    if padded.len() as u64 != padme((FRAME_HEADER + len) as u64) {
        return Err(CryptoError::Open);
    }
    let data = &padded[FRAME_HEADER..FRAME_HEADER + len];
    if padded[FRAME_HEADER + len..].iter().any(|b| *b != 0) {
        return Err(CryptoError::Open);
    }
    match alg {
        ALG_NONE if len == raw => Ok(data.to_vec()),
        ALG_DEFLATE => {
            let out = miniz_oxide::inflate::decompress_to_vec_with_limit(data, raw)
                .map_err(|_| CryptoError::Open)?;
            if out.len() == raw {
                Ok(out)
            } else {
                Err(CryptoError::Open)
            }
        }
        _ => Err(CryptoError::Open),
    }
}

fn nonce(i: u64, last: bool) -> [u8; 12] {
    let mut n = [0u8; 12];
    // u88be(i): the counter fills bytes 0..11; i < 2^64 fits in the low 8.
    n[3..11].copy_from_slice(&i.to_be_bytes());
    n[11] = u8::from(last);
    n
}

fn cipher(key: &[u8; 32], salt: &[u8; 16]) -> ChaCha20Poly1305 {
    let k = hkdf32(key, salt, b"mdbase/v1/payload");
    ChaCha20Poly1305::new(Key::from_slice(k.expose()))
}

/// Seal `plain` under `key` with an explicit `salt` and associated data
/// (steps 1–7). The salt must be fresh from the injected entropy; only fixtures
/// pass a recorded one.
pub fn seal_with_salt(
    key: &[u8; 32],
    salt: &[u8; 16],
    aad: &[u8],
    plain: &[u8],
    compress: bool,
) -> Result<Vec<u8>, CryptoError> {
    let padded = frame(plain, compress)?;
    let c = cipher(key, salt);
    let n = padded.len().div_ceil(SEGMENT).max(1);
    let mut body = Vec::with_capacity(padded.len() + 16 * n);
    for (i, seg) in padded.chunks(SEGMENT).enumerate() {
        let last = i + 1 == n;
        let ct = c
            .encrypt(
                Nonce::from_slice(&nonce(i as u64, last)),
                Payload { msg: seg, aad },
            )
            .map_err(|_| CryptoError::Open)?;
        body.extend_from_slice(&ct);
    }
    Ok(body)
}

/// Open a body sealed by [`seal_with_salt`].
pub fn open_with_salt(
    key: &[u8; 32],
    salt: &[u8; 16],
    aad: &[u8],
    body: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    open_with_salt_bounded(key, salt, aad, body, MAX_PLAIN)
}

/// Consumer-bound opening: check framed raw length before decompressing/cloning.
pub(crate) fn open_with_salt_bounded(
    key: &[u8; 32],
    salt: &[u8; 16],
    aad: &[u8],
    body: &[u8],
    max_plain: usize,
) -> Result<Vec<u8>, CryptoError> {
    if max_plain > MAX_PLAIN {
        return Err(CryptoError::TooLarge);
    }
    if body.is_empty() {
        return Err(CryptoError::Open);
    }
    let c = cipher(key, salt);
    let n = body.len().div_ceil(SEGMENT_CT);
    // No valid body holds more segments than the largest padded frame needs.
    let max_padded = padme((max_plain + FRAME_HEADER) as u64);
    if (n as u64 - 1) * SEGMENT as u64 >= max_padded {
        return Err(CryptoError::TooLarge);
    }
    let mut padded = Zeroizing::new(Vec::with_capacity(n * SEGMENT));
    for (i, seg) in body.chunks(SEGMENT_CT).enumerate() {
        if seg.len() <= 16 {
            return Err(CryptoError::Open);
        }
        let last = i + 1 == n;
        let pt = Zeroizing::new(
            c.decrypt(
                Nonce::from_slice(&nonce(i as u64, last)),
                Payload { msg: seg, aad },
            )
            .map_err(|_| CryptoError::Open)?,
        );
        padded.extend_from_slice(&pt);
    }
    unframe(&padded, max_plain)
}

/// Seal a payload into an item: draws a fresh salt from `entropy`, sets
/// `item.salt`, and sets `item.body` to the ciphertext bound to the item's header
/// (`Item::aad`). Call before signing.
pub fn seal_item_body(
    key: &[u8; 32],
    item: &mut Item,
    plain: &[u8],
    compress: bool,
    entropy: &mut dyn CsprngEntropy,
) -> Result<(), CryptoError> {
    let mut salt = [0u8; 16];
    entropy.fill(&mut salt);
    item.salt = Some(B16(salt));
    item.sig = None;
    let aad = item.aad().map_err(|_| CryptoError::Encode)?;
    item.body.0 = seal_with_salt(key, &salt, &aad, plain, compress)?;
    Ok(())
}

/// Open a sealed item's body (V3 on failure).
pub fn open_item_body(key: &[u8; 32], item: &Item) -> Result<Vec<u8>, CryptoError> {
    let salt = item.salt.ok_or(CryptoError::Open)?;
    let aad = item.aad().map_err(|_| CryptoError::Open)?;
    open_with_salt(key, &salt.0, &aad, &item.body.0)
}
