//! The recovery device (`sealed-envelope.md` §5.4): a device of kind `recovery`
//! whose secret the user holds on paper. Rekeys wrap the epoch key for it like for
//! any device, so a new device that imports the key can unwrap the current epoch,
//! check its commitment, and sign a `key_grant` for itself as the recovery device.
//!
//! **Exactly per the contract** (a key printed by the Rust runtime or by the TS
//! Obsidian runtime must parse in both; `conformance/crypto/recovery-key/` pins it):
//! ```text
//! R          = 32 bytes from the CSPRNG
//! check      = first 2 bytes of H("mdbase/v1/recovery-key-check", R)
//! text       = "MDB1-" ‖ Crockford base32(R ‖ check), groups of five joined by "-"
//! seed_sign  = HKDF-SHA256(ikm = R, salt = collection, info = "mdbase/v1/recovery-sign")
//! seed_kem   = HKDF-SHA256(ikm = R, salt = collection, info = "mdbase/v1/recovery-kem")
//! device ID  = first 16 bytes of H("mdbase/v1/recovery-id", collection ‖ sign_pk)
//! noise_pk   = 32 zero bytes
//! ```
//!
//! Crockford alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, most significant bits
//! first, no padding characters (34 bytes → 55 characters; the 3 trailing bits must
//! be zero, so each key has one spelling). Parsing upper-cases, removes whitespace
//! and `-`, maps `O`→`0` and `I`/`L`→`1`, then requires the `MDB1` prefix. The
//! check catches typos only; it adds no security.

use zeroize::{Zeroize, Zeroizing};

use super::hpke::KemKeyPair;
use super::sign::DeviceSigner;
use super::{CryptoError, CsprngEntropy, Secret32, ct_eq, hkdf32};

const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const PREFIX: &str = "MDB1";

/// A recovery key. Zeroized on drop; never printed.
#[derive(Clone, PartialEq, Eq)]
pub struct RecoveryKey(Secret32);

impl std::fmt::Debug for RecoveryKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RecoveryKey(..)")
    }
}

/// The recovery device of one collection, derived from a recovery key.
#[derive(Debug)]
pub struct RecoveryKeys {
    /// Device ID.
    pub device: mdbn_wire::common::Uuid,
    /// Ed25519 signing key (its public half is the recovery device's `sign_pk`).
    pub signer: DeviceSigner,
    /// X25519 KEM key (its public half is the recovery device's `kem_pk`).
    pub kem: KemKeyPair,
}

/// The recovery device's `noise_pk`: 32 zero bytes (never a routing target).
pub const RECOVERY_NOISE_PK: [u8; 32] = [0; 32];

fn check(r: &[u8; 32]) -> [u8; 2] {
    let d = mdbn_wire::hash::h("mdbase/v1/recovery-key-check", r);
    [d.0[0], d.0[1]]
}

impl RecoveryKeys {
    /// Whether an enrolment's public keys are exactly the ones derived here
    /// (check before any `rekey` or `key_grant` includes the recovery
    /// device, so the control plane cannot substitute its own `kem_pk`).
    pub fn matches_enrolment(
        &self,
        device: &mdbn_wire::common::Uuid,
        sign_pk: &[u8; 32],
        kem_pk: &[u8; 32],
        noise_pk: &[u8; 32],
    ) -> bool {
        ct_eq(&self.device.0, &device.0)
            & ct_eq(&self.signer.public(), sign_pk)
            & ct_eq(&self.kem.pk, kem_pk)
            & ct_eq(&RECOVERY_NOISE_PK, noise_pk)
    }
}

impl RecoveryKey {
    /// A new recovery key from the injected entropy.
    pub fn generate(entropy: &mut dyn CsprngEntropy) -> RecoveryKey {
        RecoveryKey(Secret32::random(entropy))
    }

    /// The human-readable text to show once and have the user write down.
    pub fn to_text(&self) -> Zeroizing<String> {
        let mut raw = Zeroizing::new(self.0.expose().to_vec());
        raw.extend_from_slice(&check(self.0.expose()));
        let mut chars = Zeroizing::new(Vec::with_capacity(55));
        let mut acc: u32 = 0;
        let mut bits = 0u32;
        for b in raw.iter() {
            acc = (acc << 8) | u32::from(*b);
            bits += 8;
            while bits >= 5 {
                bits -= 5;
                chars.push(ALPHABET[((acc >> bits) & 31) as usize]);
            }
            acc &= (1 << bits) - 1;
        }
        if bits > 0 {
            chars.push(ALPHABET[((acc << (5 - bits)) & 31) as usize]);
        }
        acc.zeroize();
        let mut out = Zeroizing::new(String::from(PREFIX));
        for (i, c) in chars.iter().enumerate() {
            if i % 5 == 0 {
                out.push('-');
            }
            out.push(char::from(*c));
        }
        out
    }

    /// Parse the text form, verifying the checksum.
    pub fn from_text(text: &str) -> Result<RecoveryKey, CryptoError> {
        let norm: Zeroizing<String> = Zeroizing::new(
            text.chars()
                .filter(|c| *c != '-' && !c.is_whitespace())
                .map(|c| match c.to_ascii_uppercase() {
                    'O' => '0',
                    'I' | 'L' => '1',
                    u => u,
                })
                .collect(),
        );
        let Some(body) = norm.strip_prefix(PREFIX) else {
            return Err(CryptoError::Encoding);
        };
        let mut vals = Zeroizing::new(Vec::with_capacity(55));
        for c in body.chars() {
            let v = ALPHABET
                .iter()
                .position(|a| char::from(*a) == c)
                .ok_or(CryptoError::Encoding)?;
            vals.push(v as u32);
        }
        if vals.len() != 55 {
            return Err(CryptoError::Encoding);
        }
        let mut raw = Zeroizing::new(Vec::with_capacity(34));
        let mut acc: u32 = 0;
        let mut bits = 0u32;
        for v in vals.iter() {
            acc = (acc << 5) | v;
            bits += 5;
            if bits >= 8 {
                bits -= 8;
                raw.push(((acc >> bits) & 0xff) as u8);
            }
            acc &= (1 << bits) - 1;
        }
        // 55 × 5 = 275 bits: 272 data bits and 3 zero padding bits.
        if raw.len() != 34 || acc != 0 {
            return Err(CryptoError::Encoding);
        }
        let mut r = [0u8; 32];
        r.copy_from_slice(&raw[..32]);
        let key = RecoveryKey(Secret32(r));
        r.zeroize();
        if !ct_eq(&check(key.0.expose()), &raw[32..34]) {
            return Err(CryptoError::Encoding);
        }
        Ok(key)
    }

    /// Derive this collection's recovery device.
    pub fn derive(&self, collection: &mdbn_wire::common::Uuid) -> RecoveryKeys {
        let seed = hkdf32(self.0.expose(), &collection.0, b"mdbase/v1/recovery-sign");
        let kem = hkdf32(self.0.expose(), &collection.0, b"mdbase/v1/recovery-kem");
        let signer = DeviceSigner::from_seed(seed.expose());
        let mut m = collection.0.to_vec();
        m.extend_from_slice(&signer.public());
        let d = mdbn_wire::hash::h("mdbase/v1/recovery-id", &m);
        let mut id = [0u8; 16];
        id.copy_from_slice(&d.0[..16]);
        RecoveryKeys {
            device: mdbn_wire::common::B16(id),
            signer,
            kem: KemKeyPair::from_secret(kem.expose()),
        }
    }

    /// The raw secret (for fixtures and the setup "type the last group back" check).
    pub fn expose(&self) -> &[u8; 32] {
        self.0.expose()
    }

    /// From raw bytes (fixtures; a restored backup).
    pub fn from_bytes(b: [u8; 32]) -> RecoveryKey {
        RecoveryKey(Secret32(b))
    }
}

/// Parse a recovery key's text and derive its device keys.
pub fn import_recovery_key(
    text: &str,
    collection: &mdbn_wire::common::Uuid,
) -> Result<RecoveryKeys, CryptoError> {
    Ok(RecoveryKey::from_text(text)?.derive(collection))
}
