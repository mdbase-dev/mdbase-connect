//! The hosted service device's keys (Connect cloud-copy bootstrap; interface note
//! 2026-10-04-control-hosted-replica.md §2). The deployment generates them from the
//! host CSPRNG, custody wraps the 96-byte secret `signSeed ‖ kemSk ‖ noiseSk` with KMS,
//! and only the public halves and the envelope leave the Worker. After an unwrap,
//! custody re-derives the public keys with [`public_keys`] and compares them with the
//! service record and the log's enrolment before any key is used.

use mdbn_replica::crypto::hpke::KemKeyPair;
use mdbn_replica::crypto::sign::DeviceSigner;
use mdbn_replica::crypto::{CsprngEntropy, Secret32};

/// Length of the wrapped secret: sign seed, KEM private key, Noise private key.
pub const SECRET_LEN: usize = 96;

/// Public keys: `sign_pk` (Ed25519), `kem_pk` and `noise_pk` (X25519).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PublicKeys {
    /// Ed25519 signing public key.
    pub sign: [u8; 32],
    /// X25519 KEM public key (HPKE key wraps).
    pub kem: [u8; 32],
    /// X25519 Noise static public key.
    pub noise: [u8; 32],
}

/// The 96-byte secret, wiped on drop.
pub struct Secret96(pub [u8; SECRET_LEN]);

impl Drop for Secret96 {
    fn drop(&mut self) {
        crate::runtime::wipe(&mut self.0);
    }
}

/// A freshly generated device: the secret (wiped on drop) and its public keys.
pub struct Generated {
    /// `signSeed ‖ kemSk ‖ noiseSk`, for KMS wrap only.
    pub secret: Secret96,
    /// Its public keys.
    pub public: PublicKeys,
}

/// Generate a hosted service device from the injected CSPRNG.
pub fn generate(entropy: &mut dyn CsprngEntropy) -> Generated {
    let signer = DeviceSigner::generate(entropy);
    let kem = KemKeyPair::generate(entropy);
    let noise = KemKeyPair::generate(entropy);
    let mut secret = Secret96([0u8; SECRET_LEN]);
    secret.0[..32].copy_from_slice(signer.seed().expose());
    secret.0[32..64].copy_from_slice(kem.secret().expose());
    secret.0[64..].copy_from_slice(noise.secret().expose());
    let public = PublicKeys {
        sign: signer.public(),
        kem: kem.pk,
        noise: noise.pk,
    };
    Generated { secret, public }
}

/// The public keys of a 96-byte secret, or `None` if it is not 96 bytes.
pub fn public_keys(secret: &[u8]) -> Option<PublicKeys> {
    let secret: &[u8; SECRET_LEN] = secret.try_into().ok()?;
    let part = |range: std::ops::Range<usize>| {
        let mut b = Secret32([0u8; 32]);
        b.0.copy_from_slice(&secret[range]);
        b
    };
    let (sign, kem, noise) = (part(0..32), part(32..64), part(64..96));
    Some(PublicKeys {
        sign: DeviceSigner::from_seed(sign.expose()).public(),
        kem: KemKeyPair::from_secret(kem.expose()).pk,
        noise: KemKeyPair::from_secret(noise.expose()).pk,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use mdbn_replica::crypto::TestEntropy;

    #[test]
    fn generated_keys_derive_back_and_differ() {
        let g = generate(&mut TestEntropy::new(7));
        assert_eq!(public_keys(&g.secret.0), Some(g.public));
        assert_ne!(g.public.kem, g.public.noise);
        assert_ne!(g.public.noise, [0; 32]);
        let h = generate(&mut TestEntropy::new(8));
        assert_ne!(g.public, h.public);
        assert_eq!(public_keys(&g.secret.0[..95]), None);
    }

    #[test]
    fn a_changed_secret_byte_changes_the_public_keys() {
        let g = generate(&mut TestEntropy::new(9));
        for i in [0usize, 40, 70] {
            let mut s = g.secret.0;
            s[i] ^= 1;
            assert_ne!(public_keys(&s), Some(g.public), "byte {i}");
        }
    }
}
