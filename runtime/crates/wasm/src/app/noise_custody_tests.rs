use super::{device::DeviceIdentity, noise_custody::NoiseCustody};
use mdbn_core::host::Entropy;
use mdbn_replica::crypto::{
    CsprngEntropy,
    hpke::KemKeyPair,
    sign::{DeviceSigner, verify_digest},
};
use mdbn_wire::{
    cbor::{self, Cbor},
    common::B16,
    schema::Wire,
};
struct Rng(u8);
impl Entropy for Rng {
    fn fill(&mut self, b: &mut [u8]) {
        b.fill(self.0);
        self.0 += 1;
    }
}
impl CsprngEntropy for Rng {}
fn custody() -> NoiseCustody {
    NoiseCustody::new(&[0x33; 32], &[0x55; 32], B16([0x44; 16]))
}
fn init(mode: u64, blob: Vec<u8>) -> Vec<u8> {
    cbor::encode(&Cbor::Map(vec![
        (Cbor::Uint(0), B16([0x88; 16]).to_cbor()),
        (Cbor::Uint(1), Cbor::Uint(mode)),
        (Cbor::Uint(2), Cbor::Bytes(blob)),
    ]))
    .unwrap()
}
fn fields(out: &[u8]) -> Vec<(Cbor, Cbor)> {
    let Cbor::Map(f) = cbor::decode(out).unwrap() else {
        panic!("map")
    };
    f
}
fn blob(out: &[u8]) -> Vec<u8> {
    let Cbor::Bytes(b) = &fields(out)[3].1 else {
        panic!("blob")
    };
    b.clone()
}
#[test]
fn independent_noise_generation_and_exact_reopen_preserve_identity_without_seed_export() {
    let mut c = custody();
    let created = c
        .init(B16([0x66; 16]), &init(0, vec![]), &mut Rng(0x11))
        .unwrap();
    let f = fields(&created);
    assert_eq!(f.len(), 4);
    assert_eq!(
        f[0].1,
        Cbor::Bytes(DeviceSigner::from_seed(&[0x33; 32]).public().to_vec())
    );
    assert_eq!(
        f[1].1,
        Cbor::Bytes(KemKeyPair::from_secret(&[0x55; 32]).pk.to_vec())
    );
    assert_eq!(
        f[2].1,
        Cbor::Bytes(KemKeyPair::from_secret(&[0x11; 32]).pk.to_vec())
    );
    assert!(
        !created
            .windows(32)
            .any(|w| w == [0x11; 32] || w == [0x33; 32] || w == [0x55; 32])
    );
    let mut reopened = custody();
    assert_eq!(
        reopened
            .init(B16([0x66; 16]), &init(1, blob(&created)), &mut Rng(0x77))
            .unwrap(),
        created
    );
    assert!(
        c.init(B16([0x66; 16]), &init(0, vec![]), &mut Rng(0x22))
            .is_none()
    );
    c.retire();
    assert!(
        c.init(B16([0x66; 16]), &init(1, blob(&created)), &mut Rng(0x33))
            .is_none()
    );
}
#[test]
fn mismatch_corruption_version_trailing_budget_and_failed_reopen_never_regenerate() {
    let created = custody()
        .init(B16([0x66; 16]), &init(0, vec![]), &mut Rng(0x11))
        .unwrap();
    let original = blob(&created);
    let mut corrupt = original.clone();
    *corrupt.last_mut().unwrap() ^= 1;
    let mut version = fields(&original);
    version[0].1 = Cbor::Uint(2);
    let mut pk = fields(&original);
    pk[2].1 = Cbor::Bytes(vec![9; 32]);
    let mut salt = fields(&original);
    salt[3].1 = Cbor::Bytes(vec![9; 16]);
    let mut trailing = original.clone();
    trailing.push(0);
    let mut cases = vec![
        vec![],
        corrupt,
        cbor::encode(&Cbor::Map(version)).unwrap(),
        cbor::encode(&Cbor::Map(pk)).unwrap(),
        cbor::encode(&Cbor::Map(salt)).unwrap(),
        trailing,
        vec![0; 1025],
    ];
    for end in 0..original.len() {
        cases.push(original[..end].to_vec());
    }
    for b in cases {
        let mut c = custody();
        assert!(
            c.init(B16([0x66; 16]), &init(1, b), &mut Rng(0x11))
                .is_none()
        );
        assert!(
            c.init(B16([0x66; 16]), &init(0, vec![]), &mut Rng(0x22))
                .is_none()
        );
    }
    for mismatch in 0..4 {
        let mut c = match mismatch {
            0 => NoiseCustody::new(&[0x34; 32], &[0x55; 32], B16([0x44; 16])),
            1 => NoiseCustody::new(&[0x33; 32], &[0x56; 32], B16([0x44; 16])),
            2 => NoiseCustody::new(&[0x33; 32], &[0x55; 32], B16([0x45; 16])),
            _ => custody(),
        };
        let con = if mismatch == 3 {
            B16([0x67; 16])
        } else {
            B16([0x66; 16])
        };
        assert!(
            c.init(con, &init(1, original.clone()), &mut Rng(0x11))
                .is_none()
        );
    }
    let mut installation = fields(&init(1, original));
    installation[0].1 = B16([0x89; 16]).to_cbor();
    assert!(
        custody()
            .init(
                B16([0x66; 16]),
                &cbor::encode(&Cbor::Map(installation)).unwrap(),
                &mut Rng(0x11)
            )
            .is_none()
    );
}
#[test]
fn fixed_cp_enrol_public_tuple_signature_matches_actual_receiver_concat_domain() {
    let mut envelope = cbor::encode(&Cbor::Map(vec![
        (Cbor::Uint(0), Cbor::Uint(1)),
        (Cbor::Uint(1), B16([0x66; 16]).to_cbor()),
        (Cbor::Uint(2), B16([0x44; 16]).to_cbor()),
        (Cbor::Uint(3), B16([0x88; 16]).to_cbor()),
        (Cbor::Uint(4), Cbor::Uint(0)),
        (Cbor::Uint(5), Cbor::Bytes(vec![0x33; 32])),
        (Cbor::Uint(6), Cbor::Bytes(vec![0x55; 32])),
        (Cbor::Uint(7), Cbor::Bytes(vec![])),
    ]))
    .unwrap();
    let (mut s, _) = DeviceIdentity::open_consuming(&mut envelope, &mut Rng(0x11)).unwrap();
    assert!(envelope.iter().all(|b| *b == 0));
    let out = s.sign_cp_enrol_consuming(&mut [0x11; 32]);
    let f = fields(&out);
    let mut transcript = vec![0x11; 32];
    transcript.extend_from_slice(&[0x66; 16]);
    transcript.extend_from_slice(&[0x44; 16]);
    for field in &f[..3] {
        let Cbor::Bytes(b) = &field.1 else {
            panic!("pub")
        };
        transcript.extend_from_slice(b);
    }
    let Cbor::Bytes(pk) = &f[0].1 else {
        panic!("pk")
    };
    let Cbor::Bytes(sig) = &f[3].1 else {
        panic!("sig")
    };
    assert!(verify_digest(
        &pk.as_slice().try_into().unwrap(),
        &mdbn_wire::hash::h("mdbase/v1/cp-enrol", &transcript).0,
        &sig.as_slice().try_into().unwrap()
    ));
    assert!(!verify_digest(
        &pk.as_slice().try_into().unwrap(),
        &mdbn_wire::hash::h("mdbase/v1/collection-log-token", &transcript).0,
        &sig.as_slice().try_into().unwrap()
    ));
    for len in [0, 31, 33, 1024] {
        let mut input = vec![1; len];
        assert!(s.sign_cp_enrol_consuming(&mut input).is_empty());
        assert!(input.iter().all(|b| *b == 0));
    }
    s.retire();
    assert!(s.sign_cp_enrol_consuming(&mut [0x11; 32]).is_empty());
}
