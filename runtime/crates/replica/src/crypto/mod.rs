//! The replica's crypto layer (`docs/contracts/sealed-envelope.md`).
//!
//! | Module | What |
//! |---|---|
//! | [`seal`] | the §3 payload construction (age v1 STREAM + DEFLATE + Padmé), item bodies |
//! | [`sign`] | Ed25519 device signing and strict verification of items |
//! | [`hpke`] | RFC 9180 base mode, the one suite the contracts use (epoch key wraps) |
//! | [`keys`] | epoch keys, rekey and key grants, key history, commitments, SAS, idempotency tokens, stream IDs |
//! | [`raw`] | AAD, signed digest and opening over an item's received bytes |
//! | [`blob`] | keyed content addressing and blob-part sealing (§4.2) |
//! | [`recovery`] | the offline recovery key and the device keys derived from it |
//! | [`proof`] | the control-plane request proof digests every host signs |
//!
//! **Rules.**
//! - The only randomness is the injected [`Entropy`]: salts, epoch keys, HPKE
//!   ephemeral keys, recovery keys. Nothing here seeds a generator from configuration.
//! - Every comparison of secret-derived bytes (tags, MACs, commitments, tokens, SAS)
//!   is constant time ([`ct_eq`]).
//! - Key material is zeroized on drop ([`Secret32`], `Zeroizing`), and no type here
//!   prints a secret in `Debug`.
//! - Every failure to open is the same opaque [`CryptoError`]: callers map it to the
//!   void reason V3 (`log-entry.md` §4.3) without learning which check failed.

use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use subtle::ConstantTimeEq;
use zeroize::{Zeroize, ZeroizeOnDrop};

pub use mdbn_core::host::Entropy;

/// Entropy from a cryptographically secure generator.
///
/// Sealing and key generation take this, not plain [`Entropy`], so a seeded
/// simulator generator cannot reach production by accident. Only the platform
/// hosts implement it: `mdbn-platform-native` over the OS CSPRNG, and the WASM
/// host import over `crypto.getRandomValues`. [`TestEntropy`] implements it only
/// under `cfg(test)` or the `testing` feature.
pub trait CsprngEntropy: Entropy {}

pub mod account_key;
pub mod blob;
pub mod chunked_blob;
pub mod hpke;
pub mod keys;
pub mod proof;
pub mod raw;
pub mod recovery;
pub mod seal;
pub mod sign;
#[cfg(test)]
mod tests;

/// A crypto operation failed. Deliberately opaque.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CryptoError {
    /// Authentication or decoding failed (AEAD, frame, padding, decompression).
    Open,
    /// A signature did not verify.
    Signature,
    /// A key or point was invalid (e.g. an all-zero X25519 shared secret).
    Key,
    /// Input over a limit (16 MiB payload).
    TooLarge,
    /// An unwrapped epoch key does not match its epoch's commitment
    /// (`key_inconsistent`). The key must not be used.
    KeyInconsistent,
    /// Bad text encoding (recovery key) or checksum.
    Encoding,
    /// The value could not be encoded canonically.
    Encode,
}

impl std::fmt::Display for CryptoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            CryptoError::Open => "open failed",
            CryptoError::Signature => "bad signature",
            CryptoError::Key => "invalid key",
            CryptoError::TooLarge => "too large",
            CryptoError::KeyInconsistent => "key inconsistent with its commitment",
            CryptoError::Encoding => "bad encoding",
            CryptoError::Encode => "encode failed",
        };
        f.write_str(s)
    }
}

impl std::error::Error for CryptoError {}

/// 32 secret bytes, zeroized on drop, redacted in `Debug`.
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct Secret32(pub [u8; 32]);

impl Secret32 {
    /// 32 fresh bytes from the injected entropy.
    pub fn random(entropy: &mut dyn CsprngEntropy) -> Secret32 {
        let mut b = [0u8; 32];
        entropy.fill(&mut b);
        let s = Secret32(b);
        b.zeroize();
        s
    }

    /// The bytes.
    pub fn expose(&self) -> &[u8; 32] {
        &self.0
    }
}

impl std::fmt::Debug for Secret32 {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secret32(..)")
    }
}

impl PartialEq for Secret32 {
    fn eq(&self, other: &Secret32) -> bool {
        ct_eq(&self.0, &other.0)
    }
}

impl Eq for Secret32 {}

/// Constant-time equality of two byte strings (length is not secret).
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && bool::from(a.ct_eq(b))
}

/// `MAC(k, tag, m) = HMAC-SHA256(k, u8(len(tag)) ‖ tag ‖ m)` (00-overview.md §4).
pub fn mac(key: &[u8], tag: &str, m: &[u8]) -> [u8; 32] {
    mac_parts(key, tag, &[m])
}

/// [`mac`] over the concatenation of `parts`.
pub fn mac_parts(key: &[u8], tag: &str, parts: &[&[u8]]) -> [u8; 32] {
    let len = u8::try_from(tag.len()).unwrap_or(u8::MAX);
    // HMAC accepts keys of any length; this cannot fail.
    let mut h = match <Hmac<Sha256> as Mac>::new_from_slice(key) {
        Ok(h) => h,
        Err(_) => return [0; 32],
    };
    h.update(&[len]);
    h.update(tag.as_bytes());
    for p in parts {
        h.update(p);
    }
    h.finalize().into_bytes().into()
}

/// `HKDF-SHA256(ikm, salt, info)` → 32 bytes, zeroized on drop.
pub fn hkdf32(ikm: &[u8], salt: &[u8], info: &[u8]) -> Secret32 {
    let hk = Hkdf::<Sha256>::new(Some(salt), ikm);
    let mut out = [0u8; 32];
    // 32 bytes is far below HKDF-SHA256's 8160-byte limit.
    let _ = hk.expand(info, &mut out);
    let s = Secret32(out);
    out.zeroize();
    s
}

/// Deterministic entropy for tests and fixtures only: a counter-mode SHA-256 stream.
/// **Never** use it in production; hosts inject a CSPRNG. Available only under
/// `cfg(test)` or the `testing` feature.
#[cfg(any(test, feature = "testing"))]
#[derive(Debug, Clone)]
pub struct TestEntropy {
    seed: [u8; 32],
    counter: u64,
}

#[cfg(any(test, feature = "testing"))]
impl TestEntropy {
    /// A stream from a seed.
    pub fn new(seed: u8) -> TestEntropy {
        TestEntropy {
            seed: [seed; 32],
            counter: 0,
        }
    }
}

#[cfg(any(test, feature = "testing"))]
impl CsprngEntropy for TestEntropy {}

#[cfg(any(test, feature = "testing"))]
impl Entropy for TestEntropy {
    fn fill(&mut self, buf: &mut [u8]) {
        for chunk in buf.chunks_mut(32) {
            let mut m = self.seed.to_vec();
            m.extend_from_slice(&self.counter.to_be_bytes());
            self.counter += 1;
            let d = mdbn_wire::hash::sha256(&m);
            chunk.copy_from_slice(&d.0[..chunk.len()]);
        }
    }
}
