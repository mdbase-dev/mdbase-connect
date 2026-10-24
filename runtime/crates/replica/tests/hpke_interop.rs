//! Native-only, dev-only interop with the independently maintained `rust-hpke`
//! implementation. Exactly RFC 9180 Base mode, X25519/HKDF-SHA256/ChaCha20Poly1305,
//! sequence zero. Deterministic fixture randomness is never production entropy.
#![cfg(not(target_arch = "wasm32"))]

use std::convert::Infallible;

use hpke::{
    Deserializable, Kem, OpModeR, OpModeS, Serializable,
    aead::{Aead, ChaCha20Poly1305},
    kdf::{HkdfSha256, Kdf},
    kem::X25519HkdfSha256,
    rand_core::{TryCryptoRng, TryRng},
};
use mdbn_replica::crypto::{CsprngEntropy, Entropy, hpke as ours};
use rand_chacha::{
    ChaCha20Rng,
    rand_core::{RngCore, SeedableRng},
};

type IndependentKem = X25519HkdfSha256;
type IndependentSecret = <IndependentKem as Kem>::PrivateKey;
type IndependentEnc = <IndependentKem as Kem>::EncappedKey;

// Reuse rand_chacha's existing pinned generator rather than inventing one or
// enabling OS entropy. The adapter bridges the two rand_core API versions and
// our injected Entropy API; it lives exclusively in this integration test.
struct FixtureRng {
    rng: ChaCha20Rng,
    vector_ikm: Option<[u8; 32]>,
    fills: usize,
}

impl FixtureRng {
    fn seeded(seed: u8) -> Self {
        Self {
            rng: ChaCha20Rng::from_seed([seed; 32]),
            vector_ikm: None,
            fills: 0,
        }
    }

    fn vector(ikm: [u8; 32]) -> Self {
        Self {
            vector_ikm: Some(ikm),
            ..Self::seeded(0)
        }
    }

    fn bytes(&mut self, len: usize) -> Vec<u8> {
        let mut bytes = vec![0; len];
        self.fill(&mut bytes);
        bytes
    }
}

impl Entropy for FixtureRng {
    fn fill(&mut self, dest: &mut [u8]) {
        self.fills += 1;
        if let Some(ikm) = self.vector_ikm.take() {
            assert_eq!(dest.len(), 32, "RFC vector must supply exactly one IKM");
            dest.copy_from_slice(&ikm);
        } else {
            self.rng.fill_bytes(dest);
        }
    }
}
impl CsprngEntropy for FixtureRng {}
impl TryCryptoRng for FixtureRng {}
impl TryRng for FixtureRng {
    type Error = Infallible;

    fn try_next_u32(&mut self) -> Result<u32, Self::Error> {
        let mut bytes = [0; 4];
        self.fill(&mut bytes);
        Ok(u32::from_le_bytes(bytes))
    }

    fn try_next_u64(&mut self) -> Result<u64, Self::Error> {
        let mut bytes = [0; 8];
        self.fill(&mut bytes);
        Ok(u64::from_le_bytes(bytes))
    }

    fn try_fill_bytes(&mut self, dest: &mut [u8]) -> Result<(), Self::Error> {
        self.fill(dest);
        Ok(())
    }
}

fn decode(hex: &str) -> Vec<u8> {
    assert_eq!(hex.len() % 2, 0);
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
        .collect()
}

fn independent_open(
    recipient: &IndependentSecret,
    enc: &[u8; 32],
    info: &[u8],
    aad: &[u8],
    ct: &[u8],
) -> Result<Vec<u8>, hpke::HpkeError> {
    hpke::single_shot_open::<ChaCha20Poly1305, HkdfSha256, IndependentKem>(
        &OpModeR::Base,
        recipient,
        &IndependentEnc::from_bytes(enc)?,
        info,
        ct,
        aad,
    )
}

fn independent_seal(
    pk: &[u8; 32],
    info: &[u8],
    aad: &[u8],
    pt: &[u8],
    rng: &mut FixtureRng,
) -> ([u8; 32], Vec<u8>) {
    let pk = <IndependentKem as Kem>::PublicKey::from_bytes(pk).unwrap();
    let (enc, ct) =
        hpke::single_shot_seal_with_rng::<ChaCha20Poly1305, HkdfSha256, IndependentKem>(
            &OpModeS::Base,
            &pk,
            info,
            pt,
            aad,
            rng,
        )
        .unwrap();
    (enc.to_bytes().as_slice().try_into().unwrap(), ct)
}

#[test]
fn rfc9180_a21_both_implementations() {
    assert_eq!(IndependentKem::KEM_ID, 0x0020);
    assert_eq!(HkdfSha256::KDF_ID, 0x0001);
    assert_eq!(ChaCha20Poly1305::AEAD_ID, 0x0003);
    // Reuse the official A.2.1 inputs already checked by crypto::tests.
    let ikm_e: [u8; 32] =
        decode("909a9b35d3dc4713a5e72a4da274b55d3d3821a37e5d099e74a647db583a904b")
            .try_into()
            .unwrap();
    let ikm_r = decode("1ac01f181fdf9f352797655161c58b75c656a6cc2716dcb66372da835542e1df");
    let info = decode("4f6465206f6e2061204772656369616e2055726e");
    let pt = decode("4265617574792069732074727574682c20747275746820626561757479");
    let aad = decode("436f756e742d30");
    let expected_enc = decode("1afa08d3dec047a643885163f1180476fa7ddb54c6a8029ea33f95796bf2ac4a");
    let expected_ct = decode(concat!(
        "1c5250d8034ec2b784ba2cfd69dbdb8af406cfe3ff938e131f0def8c8b60b4db",
        "21993c62ce81883d2dd1b51a28"
    ));
    let recipient = ours::KemKeyPair::derive(&ikm_r);
    let (sk, pk) = IndependentKem::derive_keypair(&ikm_r);
    assert_eq!(pk.to_bytes().as_slice(), &recipient.pk);

    let mut ours_rng = FixtureRng::vector(ikm_e);
    let (enc, ct) = ours::seal(&recipient.pk, &info, &aad, &pt, &mut ours_rng).unwrap();
    assert_eq!(ours_rng.fills, 1);
    assert_eq!(enc.as_slice(), expected_enc);
    assert_eq!(ct, expected_ct);
    assert_eq!(independent_open(&sk, &enc, &info, &aad, &ct).unwrap(), pt);

    let mut their_rng = FixtureRng::vector(ikm_e);
    let (their_enc, their_ct) = independent_seal(&recipient.pk, &info, &aad, &pt, &mut their_rng);
    assert_eq!(their_rng.fills, 1);
    assert_eq!(their_enc, enc);
    assert_eq!(their_ct, expected_ct);
    assert_eq!(
        *ours::open(&recipient, &their_enc, &info, &aad, &their_ct).unwrap(),
        pt
    );
}

#[test]
fn reproducible_random_cases_both_directions_and_binding_refusals() {
    let mut rng = FixtureRng::seeded(83);
    let lengths = [0, 1, 15, 16, 17, 31, 32, 33, 255, 256, 4096];
    for case in 0..75 {
        let len = if case < lengths.len() {
            lengths[case]
        } else {
            rng.rng.next_u32() as usize % 4097
        };
        let ikm = rng.bytes(32);
        let recipient = ours::KemKeyPair::derive(&ikm);
        let (sk, pk) = IndependentKem::derive_keypair(&ikm);
        assert_eq!(pk.to_bytes().as_slice(), &recipient.pk);
        let info = rng.bytes(case % 65);
        let aad = rng.bytes(case % 97);
        let pt = rng.bytes(len);
        let (enc, ct) = ours::seal(&recipient.pk, &info, &aad, &pt, &mut rng).unwrap();
        assert_eq!(independent_open(&sk, &enc, &info, &aad, &ct).unwrap(), pt);
        let (their_enc, their_ct) = independent_seal(&recipient.pk, &info, &aad, &pt, &mut rng);
        assert_eq!(
            *ours::open(&recipient, &their_enc, &info, &aad, &their_ct).unwrap(),
            pt
        );

        let mut other_info = info.clone();
        other_info.push(1);
        let mut other_aad = aad.clone();
        other_aad.push(1);
        assert!(independent_open(&sk, &enc, &other_info, &aad, &ct).is_err());
        assert!(independent_open(&sk, &enc, &info, &other_aad, &ct).is_err());
        assert!(ours::open(&recipient, &their_enc, &other_info, &aad, &their_ct).is_err());
        assert!(ours::open(&recipient, &their_enc, &info, &other_aad, &their_ct).is_err());
        assert_ne!(enc, their_enc, "fresh fixture encapsulation for each seal");
        let mut bad_ct = ct.clone();
        bad_ct[0] ^= 1;
        let mut bad_their_ct = their_ct.clone();
        bad_their_ct[0] ^= 1;
        assert!(independent_open(&sk, &enc, &info, &aad, &bad_ct).is_err());
        assert!(ours::open(&recipient, &their_enc, &info, &aad, &bad_their_ct).is_err());
        let wrong = ours::KemKeyPair::generate(&mut rng);
        let wrong_sk = IndependentSecret::from_bytes(wrong.secret().expose()).unwrap();
        assert!(independent_open(&wrong_sk, &enc, &info, &aad, &ct).is_err());
        assert!(ours::open(&wrong, &their_enc, &info, &aad, &their_ct).is_err());
    }
}
