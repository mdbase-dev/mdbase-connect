use super::*;
use crate::crypto::{Entropy, keys::Keyring};
use mdbn_wire::{common::B16, envelope::ItemKind, schema::Wire};
struct Rng(u8);
impl Entropy for Rng {
    fn fill(&mut self, out: &mut [u8]) {
        for b in out {
            self.0 = self.0.wrapping_mul(31).wrapping_add(7);
            *b = self.0;
        }
    }
}
impl CsprngEntropy for Rng {}
struct NoEntropy;
impl Entropy for NoEntropy {
    fn fill(&mut self, _: &mut [u8]) {
        panic!("refusal consumed entropy")
    }
}
impl CsprngEntropy for NoEntropy {}
fn keyed() -> KeyringSealer {
    let mut keys = Keyring::new();
    keys.insert(1, Secret32([9; 32]));
    keys.insert(2, Secret32([10; 32]));
    let b = keys.to_bytes();
    let mut data = Zeroizing::new((b.len() as u64).to_be_bytes().to_vec());
    data.extend_from_slice(&b);
    let mut s = KeyringSealer::new(B16([3; 16]), B16([2; 16]), &[6; 32], &[7; 32]);
    s.import(&data).unwrap();
    s.set_epoch(1);
    s
}
#[test]
fn bounded_record_source_roundtrip_empty_unicode_cap_and_current_epoch() {
    let mut s = keyed();
    for plain in [
        Vec::new(),
        "exact\r\n\0🪴é".as_bytes().to_vec(),
        vec![b'x'; 1048576],
    ] {
        for epoch in [1, 2] {
            s.set_epoch(epoch);
            let (r, parts) = s.seal_bounded_record_source(&plain, &mut Rng(11)).unwrap();
            assert_eq!(r.id_epoch, epoch);
            assert_eq!(r.size, plain.len() as u64);
            assert_eq!(r.plain_hash, mdbn_wire::hash::sha256(&plain));
            assert_eq!(parts.len(), 1);
            assert_eq!(
                s.blob_part_addresses(&r).unwrap(),
                parts.iter().map(|p| p.address).collect::<Vec<_>>()
            );
            let item = Item::from_bytes(&parts[0].bytes).unwrap();
            assert_eq!(item.kind, ItemKind::BlobPart);
            assert_eq!(item.epoch, Some(epoch));
            assert!(item.signer.is_none() && item.sig.is_none());
            assert_eq!(
                &*s.open_blob_part(&r, 0, &parts[0].bytes, 1048576).unwrap(),
                &plain
            );
            let mut wrong = r.clone();
            wrong.id_epoch = 3;
            assert!(
                s.open_blob_part(&wrong, 0, &parts[0].bytes, 1048576)
                    .is_err()
            );
        }
    }
}
#[test]
fn record_source_refuses_oversize_before_entropy_and_requires_current_key() {
    let mut s = keyed();
    let big = vec![0; 1048577];
    assert!(s.seal_bounded_record_source(&big, &mut NoEntropy).is_err());
    s.set_epoch(3);
    assert_eq!(
        s.seal_bounded_record_source(b"x", &mut NoEntropy),
        Err(SealError::NotKeyed)
    );
    assert!(s.seal_bounded_record_source(&big, &mut NoEntropy).is_err());
}
#[test]
fn unsupported_sealer_never_falls_back_to_clear_or_generic_object_writer() {
    let s = PlainSealer::for_device(B16([2; 16]));
    assert!(matches!(
        s.seal_bounded_record_source(b"x", &mut NoEntropy),
        Err(SealError::Failed(_))
    ));
}
