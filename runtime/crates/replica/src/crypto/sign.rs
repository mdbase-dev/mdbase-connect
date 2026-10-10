//! Ed25519 signatures on items (`sealed-envelope.md` §2.2, §6).
//!
//! Verification is strict and deterministic, because every replica evaluates it at
//! replay and all must agree: cofactorless, `S < L`, canonical `A` and `R`, and
//! neither `A` nor `R` of small order (`ed25519-dalek` 2.x `verify_strict`, plus an
//! explicit canonical-encoding check of `A`).

use curve25519_dalek::edwards::CompressedEdwardsY;
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use mdbn_wire::common::{B64, Hash};
use mdbn_wire::envelope::{Item, item_chain_hash};
use mdbn_wire::schema::Wire;

use super::seal::seal_item_body;
use super::{CryptoError, CsprngEntropy};

/// A device (or recovery, or control-plane) Ed25519 signing key. Zeroized on drop.
pub struct DeviceSigner {
    key: SigningKey,
}

impl std::fmt::Debug for DeviceSigner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "DeviceSigner(pk={})",
            mdbn_wire::render::hex(&self.public())
        )
    }
}

impl DeviceSigner {
    /// From a 32-byte seed (the stored private key).
    pub fn from_seed(seed: &[u8; 32]) -> DeviceSigner {
        DeviceSigner {
            key: SigningKey::from_bytes(seed),
        }
    }

    /// A new key from the injected entropy.
    pub fn generate(entropy: &mut dyn CsprngEntropy) -> DeviceSigner {
        let s = super::Secret32::random(entropy);
        DeviceSigner::from_seed(s.expose())
    }

    /// The seed, for the host to store (zeroized on drop).
    pub fn seed(&self) -> super::Secret32 {
        super::Secret32(self.key.to_bytes())
    }

    /// The public key (`sign_pk`).
    pub fn public(&self) -> [u8; 32] {
        self.key.verifying_key().to_bytes()
    }

    /// Sign a 32-byte digest.
    pub fn sign_digest(&self, digest: &[u8; 32]) -> [u8; 64] {
        self.key.sign(digest).to_bytes()
    }

    /// Sign an item: sets `item.sig` over `Item::signed_digest`.
    pub fn sign_item(&self, item: &mut Item) -> Result<(), CryptoError> {
        item.sig = None;
        let d = item.signed_digest().map_err(|_| CryptoError::Encode)?;
        item.sig = Some(B64(self.sign_digest(&d.0)));
        Ok(())
    }
}

/// Whether `pk` is a usable Ed25519 public key to pin: a canonical encoding of a
/// point that is not of small order (`ed25519-dalek` `is_weak`). The same canonical
/// decompress/recompress check [`verify_digest`] applies.
pub fn strong_public_key(pk: &[u8; 32]) -> bool {
    match CompressedEdwardsY(*pk).decompress() {
        Some(p) if p.compress().0 == *pk => {}
        _ => return false,
    }
    VerifyingKey::from_bytes(pk).is_ok_and(|vk| !vk.is_weak())
}

/// Strict Ed25519 verification of a signature over a 32-byte digest.
pub fn verify_digest(pk: &[u8; 32], digest: &[u8; 32], sig: &[u8; 64]) -> bool {
    // Canonical A: decompress and recompress must give the same bytes.
    match CompressedEdwardsY(*pk).decompress() {
        Some(p) if p.compress().0 == *pk => {}
        _ => return false,
    }
    let Ok(vk) = VerifyingKey::from_bytes(pk) else {
        return false;
    };
    let sig = Signature::from_bytes(sig);
    vk.verify_strict(digest, &sig).is_ok()
}

/// Strict verification, in the shape the policy module's `SigVerifier` expects.
#[derive(Debug, Clone, Copy, Default)]
pub struct Ed25519Verifier;

impl Ed25519Verifier {
    /// Verify `sig` by `pk` over `digest`.
    pub fn verify(&self, pk: &[u8; 32], digest: &[u8; 32], sig: &[u8; 64]) -> bool {
        verify_digest(pk, digest, sig)
    }
}

/// Verify an item's signature by `pk` (`false` when absent or invalid).
pub fn verify_item(pk: &[u8; 32], item: &Item) -> bool {
    let Some(sig) = item.sig else {
        return false;
    };
    let Ok(d) = item.signed_digest() else {
        return false;
    };
    verify_digest(pk, &d.0, &sig.0)
}

/// A finished item: its canonical bytes and `chain(p)`.
#[derive(Debug, Clone, PartialEq)]
pub struct Finished {
    /// Canonical envelope bytes, exactly as appended or stored.
    pub bytes: Vec<u8>,
    /// Chain hash of those bytes (log items).
    pub chain: Hash,
}

/// Canonical bytes and chain hash of an item.
pub fn finish(item: &Item) -> Result<Finished, CryptoError> {
    let bytes = item.to_bytes().map_err(|_| CryptoError::Encode)?;
    let chain = item_chain_hash(&bytes);
    Ok(Finished { bytes, chain })
}

/// Seal `plain` into `header` under `epoch_key`, sign it, and return the canonical
/// bytes. `header` carries every header field except `salt`, `body` and `sig`.
pub fn seal_and_sign(
    epoch_key: &[u8; 32],
    mut header: Item,
    plain: &[u8],
    compress: bool,
    signer: &DeviceSigner,
    entropy: &mut dyn CsprngEntropy,
) -> Result<(Item, Finished), CryptoError> {
    seal_item_body(epoch_key, &mut header, plain, compress, entropy)?;
    signer.sign_item(&mut header)?;
    let f = finish(&header)?;
    Ok((header, f))
}

/// Sign a clear item (policy, rekey, key_grant): `header.body` holds the payload's
/// canonical bytes.
pub fn sign_clear(mut item: Item, signer: &DeviceSigner) -> Result<(Item, Finished), CryptoError> {
    signer.sign_item(&mut item)?;
    let f = finish(&item)?;
    Ok((item, f))
}
