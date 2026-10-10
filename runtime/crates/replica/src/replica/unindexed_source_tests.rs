use super::unindexed_source::*;
use crate::attachments::{AttachmentWriter, Need, PlainSink, StreamError};
use crate::crypto::{
    CsprngEntropy, Entropy, Secret32, blob,
    chunked_blob::{AttachmentLimits, CHUNK_BYTES},
};
use crate::seal::{KeyringSealer, Sealer};
use mdbn_wire::{
    attachment::{AttachmentContentV1, AttachmentRefV1, FileContent},
    common::{B16, Hash},
};
use std::collections::BTreeMap;
use zeroize::Zeroizing;
const COL: B16 = B16([3; 16]);
type Objects = BTreeMap<Hash, Vec<u8>>;
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
fn sealer_at(collection: B16, second_key: u8) -> KeyringSealer {
    let mut keys = crate::crypto::keys::Keyring::new();
    keys.insert(1, Secret32([9; 32]));
    keys.insert(2, Secret32([second_key; 32]));
    let bytes = keys.to_bytes();
    let mut stored = Zeroizing::new((bytes.len() as u64).to_be_bytes().to_vec());
    stored.extend_from_slice(&bytes);
    let mut s = KeyringSealer::new(collection, B16([2; 16]), &[6; 32], &[7; 32]);
    s.import(&stored).unwrap();
    s.set_epoch(1);
    s
}
fn sealer() -> KeyringSealer {
    sealer_at(COL, 10)
}
fn objects(plain: &[u8]) -> (FileContent, Objects) {
    let (r, parts) = blob::seal_blob(
        &Secret32([9; 32]),
        1,
        &COL,
        plain,
        blob::MIN_PART_SIZE,
        false,
        &mut Rng(1),
    )
    .unwrap();
    (
        FileContent::Blob(r),
        parts.into_iter().map(|p| (p.address, p.bytes)).collect(),
    )
}
fn attachments(plain: &[u8]) -> (FileContent, Objects) {
    let s = sealer();
    let mut rng = Rng(1);
    let mut writer = AttachmentWriter::new(
        &s,
        COL,
        plain.len() as u64,
        AttachmentLimits::default(),
        &mut rng,
    )
    .unwrap();
    let mut objects = Objects::new();
    let mut at = 0;
    while at < plain.len() {
        let length = writer.next_chunk_len() as usize;
        let o = writer
            .push_chunk(&s, &plain[at..at + length], &mut rng)
            .unwrap();
        objects.insert(o.cipher_hash, o.bytes);
        at += length;
    }
    let done = writer.finish(&s, &mut rng).unwrap();
    objects.insert(done.manifest.cipher_hash, done.manifest.bytes);
    let d = done.descriptor;
    (
        FileContent::AttachmentV1(AttachmentContentV1 {
            reference: AttachmentRefV1 {
                collection: d.context.collection,
                key_epoch: d.context.key_epoch,
                attachment_id: d.context.attachment_id,
                manifest_cipher_hash: d.manifest_cipher_hash,
            },
            whole_plain_hash: done.expected.whole_plain_hash,
            total_plain_bytes: done.expected.total_plain_bytes,
        }),
        objects,
    )
}
#[derive(Default)]
struct Count(u64);
impl PlainSink for Count {
    fn write(&mut self, offset: u64, plain: &[u8]) -> Result<(), String> {
        assert_eq!(offset, self.0);
        self.0 += plain.len() as u64;
        Ok(())
    }
}
fn address(n: UnindexedSourceNeed) -> Hash {
    match n {
        UnindexedSourceNeed::Blob { address, .. }
        | UnindexedSourceNeed::Attachment(
            Need::Manifest { address } | Need::Chunk { address, .. },
        ) => address,
    }
}
fn drive(
    r: &mut UnindexedSourceReader,
    s: &dyn Sealer,
    objects: &Objects,
    sink: &mut dyn PlainSink,
) -> Result<(), StreamError> {
    while let Some(n) = r.need() {
        r.supply(s, &objects[&address(n)], sink)?;
    }
    Ok(())
}
#[test]
fn production_profiles_stream_utf8_across_part_boundary_and_return_exact_descriptor() {
    for (make, boundary) in [
        (objects as fn(&[u8]) -> _, 1 << 20),
        (attachments, CHUNK_BYTES as usize),
    ] {
        let mut plain = vec![b'a'; boundary + 8];
        plain[boundary - 2..boundary + 2].copy_from_slice("🌾".as_bytes());
        let (content, objects) = make(&plain);
        let s = sealer();
        let mut r = UnindexedSourceReader::new(&s, content.clone(), COL).unwrap();
        let mut sink = Count::default();
        drive(&mut r, &s, &objects, &mut sink).unwrap();
        let proof = r.finish().unwrap();
        assert_eq!(proof.content(), &content);
        assert_eq!(proof.size(), plain.len() as u64);
        assert_eq!(proof.plain_hash(), content.plain_hash());
        assert_eq!(sink.0, proof.size());
    }
}
#[test]
fn authenticated_invalid_and_truncated_utf8_are_deterministic_only_after_full_read() {
    for make in [objects, attachments] {
        for suffix in [&[0xff][..], &[0xf0, 0x9f][..]] {
            let mut plain = vec![b'a'; (1 << 20) + 8];
            plain.extend_from_slice(suffix);
            let (content, objects) = make(&plain);
            let s = sealer();
            let mut r = UnindexedSourceReader::new(&s, content, COL).unwrap();
            let mut sink = Count::default();
            drive(&mut r, &s, &objects, &mut sink).unwrap();
            assert_eq!(sink.0, plain.len() as u64);
            assert!(matches!(r.finish(), Err(UnindexedSourceError::InvalidUtf8)));
        }
    }
}
#[test]
fn corrupt_ciphertext_and_late_sink_failure_are_terminal() {
    struct Fail;
    impl PlainSink for Fail {
        fn write(&mut self, _: u64, _: &[u8]) -> Result<(), String> {
            Err("disk full".into())
        }
    }
    for make in [objects, attachments] {
        let (content, objects) = make(&vec![b'a'; (1 << 20) + 8]);
        let s = sealer();
        let mut r = UnindexedSourceReader::new(&s, content.clone(), COL).unwrap();
        let n = r.need().unwrap();
        let mut raw = objects[&address(n)].clone();
        *raw.last_mut().unwrap() ^= 1;
        assert!(r.supply(&s, &raw, &mut Count::default()).is_err());
        assert!(r.need().is_none());
        assert!(matches!(r.finish(), Err(UnindexedSourceError::Read(_))));
        let mut r = UnindexedSourceReader::new(&s, content, COL).unwrap();
        assert!(matches!(
            drive(&mut r, &s, &objects, &mut Fail),
            Err(StreamError::Sink(_))
        ));
        assert!(matches!(r.finish(), Err(UnindexedSourceError::Read(_))));
    }
}
#[test]
fn incomplete_read_and_descriptor_full_hash_change_never_return_valid_or_utf8_proof() {
    for make in [objects, attachments] {
        let (content, objects) = make(&vec![b'a'; (1 << 20) + 8]);
        let s = sealer();
        let r = UnindexedSourceReader::new(&s, content.clone(), COL).unwrap();
        assert!(matches!(r.finish(), Err(UnindexedSourceError::Read(_))));
        let mut changed = content;
        match &mut changed {
            FileContent::Blob(d) => d.plain_hash.0[0] ^= 1,
            FileContent::AttachmentV1(d) => d.whole_plain_hash.0[0] ^= 1,
            _ => panic!(),
        }
        let mut r = UnindexedSourceReader::new(&s, changed, COL).unwrap();
        assert!(drive(&mut r, &s, &objects, &mut Count::default()).is_err());
        assert!(matches!(r.finish(), Err(UnindexedSourceError::Read(_))));
    }
}
#[test]
fn source_caps_are_checked_before_fetch_without_file_sized_allocation() {
    let s = sealer();
    let (base, _) = objects(&vec![b'a'; (1 << 20) + 1]);
    for size in [0, 1 << 20, (1 << 30) + 1] {
        let mut content = base.clone();
        let FileContent::Blob(b) = &mut content else {
            panic!()
        };
        b.size = size;
        assert!(matches!(
            UnindexedSourceReader::new(&s, content, COL),
            Err(StreamError::TooLarge)
        ));
    }
    let mut content = base;
    let FileContent::Blob(b) = &mut content else {
        panic!()
    };
    b.size = 1 << 30;
    let r = UnindexedSourceReader::new(&s, content, COL).unwrap();
    assert!(
        matches!(r.need(),Some(UnindexedSourceNeed::Blob{index:0,max_sealed_bytes,..}) if max_sealed_bytes<2<<20)
    );
    assert!(matches!(r.finish(), Err(UnindexedSourceError::Read(_))));
}
#[test]
fn descriptor_epoch_collection_and_missing_key_cannot_be_inferred_from_hash() {
    let plain = vec![b'a'; (1 << 20) + 8];
    let no_keys = KeyringSealer::new(COL, B16([2; 16]), &[6; 32], &[7; 32]);
    for make in [objects, attachments] {
        let (content, objects) = make(&plain);
        let mut changed = content.clone();
        match &mut changed {
            FileContent::Blob(d) => d.id_epoch = 2,
            FileContent::AttachmentV1(d) => d.reference.key_epoch = 2,
            _ => panic!(),
        }
        // Identical key material does not make a different epoch label authentic.
        let s = sealer_at(COL, 9);
        let mut r = UnindexedSourceReader::new(&s, changed, COL).unwrap();
        assert!(drive(&mut r, &s, &objects, &mut Count::default()).is_err());
        assert!(matches!(r.finish(), Err(UnindexedSourceError::Read(_))));
        match UnindexedSourceReader::new(&no_keys, content.clone(), COL) {
            Err(StreamError::NoKey) => {}
            Ok(mut r) => assert!(matches!(
                drive(&mut r, &no_keys, &objects, &mut Count::default()),
                Err(StreamError::NoKey)
            )),
            _ => panic!(),
        }
        let other = sealer_at(B16([4; 16]), 10);
        let mut r = UnindexedSourceReader::new(&other, content.clone(), COL).unwrap();
        let first = match &content {
            FileContent::Blob(b) => sealer().blob_part_addresses(b).unwrap()[0],
            FileContent::AttachmentV1(a) => a.reference.manifest_cipher_hash,
            _ => panic!(),
        };
        assert!(
            r.supply(&other, &objects[&first], &mut Count::default())
                .is_err()
        );
        assert!(matches!(r.finish(), Err(UnindexedSourceError::Read(_))));
    }
}
#[test]
fn bad_utf8_prefix_does_not_mask_later_authentication_failure() {
    for (make, length) in [
        (objects as fn(&[u8]) -> _, (1 << 20) + 8),
        (attachments, CHUNK_BYTES as usize + 8),
    ] {
        let mut plain = vec![b'a'; length];
        plain[0] = 0xff;
        let (content, objects) = make(&plain);
        let s = sealer();
        let mut r = UnindexedSourceReader::new(&s, content, COL).unwrap();
        let mut sink = Count::default();
        while sink.0 == 0 {
            let n = r.need().unwrap();
            r.supply(&s, &objects[&address(n)], &mut sink).unwrap();
        }
        let n = r.need().unwrap();
        let mut raw = objects[&address(n)].clone();
        *raw.last_mut().unwrap() ^= 1;
        assert!(r.supply(&s, &raw, &mut sink).is_err());
        assert!(matches!(r.finish(), Err(UnindexedSourceError::Read(_))));
    }
}
