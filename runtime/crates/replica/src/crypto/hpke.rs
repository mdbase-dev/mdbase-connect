//! HPKE (RFC 9180), base mode, single shot, for exactly one suite:
//! DHKEM(X25519, HKDF-SHA256) `0x0020`, HKDF-SHA256 `0x0001`,
//! ChaCha20Poly1305 `0x0003` (`sealed-envelope.md` §5.2).
//!
//! Implemented directly from the RFC on audited primitives (curve25519-dalek's
//! X25519 (`MontgomeryPoint::mul_clamped`, as x25519-dalek uses), hkdf,
//! chacha20poly1305) rather than through a generic HPKE crate, to keep OS entropy
//! out of the dependency tree: the ephemeral key comes from `DeriveKeyPair` over
//! 32 bytes of injected entropy. Checked against RFC 9180 Appendix A.2.1.
//!
//! **Flagged for the external crypto audit** (independent cryptographic validation required): this is a hand-rolled
//! implementation of RFC 9180 on audited primitives, not an audited HPKE library.

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use curve25519_dalek::montgomery::MontgomeryPoint;
use hkdf::Hkdf;
use sha2::Sha256;
use zeroize::{Zeroize, Zeroizing};

use super::{CryptoError, CsprngEntropy, Secret32};

const KEM_ID: u16 = 0x0020;
const KDF_ID: u16 = 0x0001;
const AEAD_ID: u16 = 0x0003;

fn suite_kem() -> Vec<u8> {
    let mut s = b"KEM".to_vec();
    s.extend_from_slice(&KEM_ID.to_be_bytes());
    s
}

fn suite_hpke() -> Vec<u8> {
    let mut s = b"HPKE".to_vec();
    s.extend_from_slice(&KEM_ID.to_be_bytes());
    s.extend_from_slice(&KDF_ID.to_be_bytes());
    s.extend_from_slice(&AEAD_ID.to_be_bytes());
    s
}

fn labeled_extract(suite: &[u8], salt: &[u8], label: &[u8], ikm: &[u8]) -> Zeroizing<Vec<u8>> {
    let mut m = Zeroizing::new(b"HPKE-v1".to_vec());
    m.extend_from_slice(suite);
    m.extend_from_slice(label);
    m.extend_from_slice(ikm);
    let (prk, _) = Hkdf::<Sha256>::extract(Some(salt), &m);
    Zeroizing::new(prk.to_vec())
}

fn labeled_expand(suite: &[u8], prk: &[u8], label: &[u8], info: &[u8], out: &mut [u8]) {
    let mut li = (out.len() as u16).to_be_bytes().to_vec();
    li.extend_from_slice(b"HPKE-v1");
    li.extend_from_slice(suite);
    li.extend_from_slice(label);
    li.extend_from_slice(info);
    // A 32-byte PRK is a valid HKDF-SHA256 PRK, and outputs here are ≤ 32 bytes.
    if let Ok(hk) = Hkdf::<Sha256>::from_prk(prk) {
        let _ = hk.expand(&li, out);
    }
}

/// An X25519 KEM key pair. The private half is zeroized on drop.
pub struct KemKeyPair {
    sk: Secret32,
    /// Public key.
    pub pk: [u8; 32],
}

impl std::fmt::Debug for KemKeyPair {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "KemKeyPair(pk={})", mdbn_wire::render::hex(&self.pk))
    }
}

impl KemKeyPair {
    /// RFC 9180 `DeriveKeyPair(ikm)` for DHKEM(X25519, HKDF-SHA256).
    pub fn derive(ikm: &[u8]) -> KemKeyPair {
        let suite = suite_kem();
        let prk = labeled_extract(&suite, b"", b"dkp_prk", ikm);
        let mut sk = [0u8; 32];
        labeled_expand(&suite, &prk, b"sk", b"", &mut sk);
        let pair = KemKeyPair::from_secret(&sk);
        sk.zeroize();
        pair
    }

    /// From a stored private key.
    pub fn from_secret(sk: &[u8; 32]) -> KemKeyPair {
        let pk = MontgomeryPoint::mul_base_clamped(*sk).to_bytes();
        KemKeyPair {
            sk: Secret32(*sk),
            pk,
        }
    }

    /// A new pair from the injected entropy.
    pub fn generate(entropy: &mut dyn CsprngEntropy) -> KemKeyPair {
        let ikm = Secret32::random(entropy);
        KemKeyPair::derive(ikm.expose())
    }

    /// The private key, for the host to store.
    pub fn secret(&self) -> &Secret32 {
        &self.sk
    }
}

fn dh(sk: &[u8; 32], pk: &[u8; 32]) -> Result<Secret32, CryptoError> {
    let s = Secret32(MontgomeryPoint(*pk).mul_clamped(*sk).to_bytes());
    // An all-zero output means a small-order peer key (RFC 9180 §7.1.4).
    if super::ct_eq(s.expose(), &[0u8; 32]) {
        return Err(CryptoError::Key);
    }
    Ok(s)
}

fn extract_and_expand(dh: &[u8], enc: &[u8; 32], pk_r: &[u8; 32]) -> Secret32 {
    let suite = suite_kem();
    let prk = labeled_extract(&suite, b"", b"eae_prk", dh);
    let mut ctx = enc.to_vec();
    ctx.extend_from_slice(pk_r);
    let mut out = [0u8; 32];
    labeled_expand(&suite, &prk, b"shared_secret", &ctx, &mut out);
    let s = Secret32(out);
    out.zeroize();
    s
}

/// The base-mode key schedule: `(key, base_nonce)`.
fn key_schedule(shared: &[u8], info: &[u8]) -> (Secret32, [u8; 12]) {
    let suite = suite_hpke();
    let psk_id_hash = labeled_extract(&suite, b"", b"psk_id_hash", b"");
    let info_hash = labeled_extract(&suite, b"", b"info_hash", info);
    let mut ctx = vec![0u8];
    ctx.extend_from_slice(&psk_id_hash);
    ctx.extend_from_slice(&info_hash);
    let secret = labeled_extract(&suite, shared, b"secret", b"");
    let mut key = [0u8; 32];
    labeled_expand(&suite, &secret, b"key", &ctx, &mut key);
    let mut nonce = [0u8; 12];
    labeled_expand(&suite, &secret, b"base_nonce", &ctx, &mut nonce);
    let k = Secret32(key);
    key.zeroize();
    (k, nonce)
}

/// Single-shot seal to `pk_r` with an explicit ephemeral key pair (tests, vectors).
pub fn seal_with_ephemeral(
    eph: &KemKeyPair,
    pk_r: &[u8; 32],
    info: &[u8],
    aad: &[u8],
    pt: &[u8],
) -> Result<([u8; 32], Vec<u8>), CryptoError> {
    let d = dh(eph.sk.expose(), pk_r)?;
    let shared = extract_and_expand(d.expose(), &eph.pk, pk_r);
    let (key, nonce) = key_schedule(shared.expose(), info);
    let ct = ChaCha20Poly1305::new(Key::from_slice(key.expose()))
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: pt, aad })
        .map_err(|_| CryptoError::Open)?;
    Ok((eph.pk, ct))
}

/// Single-shot seal to `pk_r`: returns `(enc, ct)`. The ephemeral key comes from
/// the injected entropy.
pub fn seal(
    pk_r: &[u8; 32],
    info: &[u8],
    aad: &[u8],
    pt: &[u8],
    entropy: &mut dyn CsprngEntropy,
) -> Result<([u8; 32], Vec<u8>), CryptoError> {
    let eph = KemKeyPair::generate(entropy);
    seal_with_ephemeral(&eph, pk_r, info, aad, pt)
}

/// Single-shot open by the recipient.
pub fn open(
    recipient: &KemKeyPair,
    enc: &[u8; 32],
    info: &[u8],
    aad: &[u8],
    ct: &[u8],
) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    let d = dh(recipient.sk.expose(), enc)?;
    let shared = extract_and_expand(d.expose(), enc, &recipient.pk);
    let (key, nonce) = key_schedule(shared.expose(), info);
    ChaCha20Poly1305::new(Key::from_slice(key.expose()))
        .decrypt(Nonce::from_slice(&nonce), Payload { msg: ct, aad })
        .map(Zeroizing::new)
        .map_err(|_| CryptoError::Open)
}
