use super::*;
use crate::attachments::AttachmentWriter;
use crate::crypto::chunked_blob::CHUNK_BYTES;
use crate::crypto::{CsprngEntropy, Entropy, Secret32};
use crate::seal::{KeyringSealer, Sealer};
use mdbn_wire::attachment::{AttachmentContentV1, AttachmentRefV1};
use mdbn_wire::common::{B16, B32};
use std::collections::BTreeMap;
const COL: B16 = B16([3; 16]);
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
fn sealer(collection: B16) -> KeyringSealer {
    sealer_with_second_key(collection, 10)
}
fn sealer_with_second_key(collection: B16, second_key: u8) -> KeyringSealer {
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
fn blob(plain: &[u8]) -> (FileContent, BTreeMap<Hash, Vec<u8>>) {
    let (r, parts) = crate::crypto::blob::seal_blob(
        &Secret32([9; 32]),
        1,
        &COL,
        plain,
        crate::crypto::blob::MIN_PART_SIZE,
        false,
        &mut Rng(1),
    )
    .unwrap();
    (
        FileContent::Blob(r),
        parts.into_iter().map(|p| (p.address, p.bytes)).collect(),
    )
}
fn attachment(plain: &[u8]) -> (FileContent, BTreeMap<Hash, Vec<u8>>) {
    let s = sealer(COL);
    let mut rng = Rng(1);
    let mut w = AttachmentWriter::new(
        &s,
        COL,
        plain.len() as u64,
        AttachmentLimits::default(),
        &mut rng,
    )
    .unwrap();
    let mut objects = BTreeMap::new();
    let mut at = 0;
    loop {
        let n = w.next_chunk_len() as usize;
        let o = w.push_chunk(&s, &plain[at..at + n], &mut rng).unwrap();
        objects.insert(o.cipher_hash, o.bytes);
        at += n;
        if at == plain.len() {
            break;
        }
    }
    let done = w.finish(&s, &mut rng).unwrap();
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
fn drive(
    s: &dyn Sealer,
    mut r: FileSourceReader,
    objects: &BTreeMap<Hash, Vec<u8>>,
) -> Result<AuthenticatedFileBytes, StreamError> {
    while let Some(n) = r.need()? {
        let address = match n {
            SourceNeed::BlobPart { address, .. }
            | SourceNeed::Manifest { address, .. }
            | SourceNeed::Chunk { address, .. } => address,
        };
        r.supply(s, n, &objects[&address])?;
    }
    r.finish()
}
type Make = fn(&[u8]) -> (FileContent, BTreeMap<Hash, Vec<u8>>);
const MAKERS: [Make; 2] = [blob, attachment];
#[test]
fn exact_empty_crlf_and_invalid_utf8_sources_authenticate_under_both_profiles() {
    let s = sealer(COL);
    for make in MAKERS {
        for plain in [&b""[..], &b"# exact\r\nviews: []\r\n"[..], &[255, 0, 1][..]] {
            let (d, o) = make(plain);
            let r = FileSourceReader::new(&s, d.clone(), 1 << 20).unwrap();
            let source = drive(&s, r, &o).unwrap();
            assert_eq!(source.bytes(), plain);
            assert_eq!(source.descriptor(), &d);
        }
    }
}
#[test]
fn admission_cap_is_inclusive_and_applies_before_fetches() {
    let s = sealer(COL);
    let plain = vec![b'x'; 1 << 20];
    for make in MAKERS {
        let (d, o) = make(&plain);
        assert!(matches!(
            FileSourceReader::new(&s, d.clone(), (1 << 20) - 1),
            Err(StreamError::TooLarge)
        ));
        let source = drive(&s, FileSourceReader::new(&s, d, 1 << 20).unwrap(), &o).unwrap();
        assert_eq!(source.bytes(), plain);
    }
    let (d, _) = blob(b"x");
    assert!(matches!(
        FileSourceReader::new(&s, d, MAX_SOURCE_BYTES + 1),
        Err(StreamError::TooLarge)
    ));
}
#[test]
fn incomplete_and_failed_readers_never_become_empty_success() {
    let s = sealer(COL);
    for make in MAKERS {
        let (d, o) = make(b"views: []\n");
        assert!(
            FileSourceReader::new(&s, d.clone(), 1 << 20)
                .unwrap()
                .finish()
                .is_err()
        );
        let mut r = FileSourceReader::new(&s, d, 1 << 20).unwrap();
        let n = r.need().unwrap().unwrap();
        let address = match n {
            SourceNeed::BlobPart { address, .. }
            | SourceNeed::Manifest { address, .. }
            | SourceNeed::Chunk { address, .. } => address,
        };
        let mut raw = o[&address].clone();
        let last = raw.len() - 1;
        raw[last] ^= 1;
        assert!(r.supply(&s, n, &raw).is_err());
        assert!(r.need().is_err());
        assert!(r.supply(&s, n, &o[&address]).is_err());
        assert!(r.finish().is_err());
    }
}
#[test]
fn wrong_whole_hash_and_collection_are_authentication_failures() {
    let s = sealer(COL);
    for make in MAKERS {
        let (mut d, o) = make(b"views: []\n");
        let wrong = sealer(B16([4; 16]));
        let r = FileSourceReader::new(&s, d.clone(), 1 << 20).unwrap();
        assert!(drive(&wrong, r, &o).is_err());
        match &mut d {
            FileContent::Blob(b) => b.plain_hash = B32([1; 32]),
            FileContent::AttachmentV1(a) => a.whole_plain_hash = B32([1; 32]),
            _ => unreachable!(),
        };
        let r = FileSourceReader::new(&s, d, 1 << 20).unwrap();
        assert!(drive(&s, r, &o).is_err());
    }
}
#[test]
fn historical_held_epoch_reads_but_missing_or_relabelled_epoch_refuses() {
    let mut s = sealer(COL);
    s.set_epoch(2);
    for make in MAKERS {
        let (d, o) = make(b"old bytes");
        assert_eq!(
            drive(
                &s,
                FileSourceReader::new(&s, d.clone(), 1 << 20).unwrap(),
                &o
            )
            .unwrap()
            .bytes(),
            b"old bytes"
        );
        let mut wrong = d;
        match &mut wrong {
            FileContent::Blob(b) => b.id_epoch = 99,
            FileContent::AttachmentV1(a) => a.reference.key_epoch = 99,
            _ => unreachable!(),
        };
        let result = FileSourceReader::new(&s, wrong, 1 << 20).and_then(|r| drive(&s, r, &o));
        assert!(result.is_err());
    }
    let (FileContent::Blob(mut d), o) = blob(b"old bytes") else {
        unreachable!()
    };
    let raw = o.values().next().unwrap();
    d.id_epoch = 2;
    let same_key = sealer_with_second_key(COL, 9);
    assert!(
        same_key.open_blob_part(&d, 0, raw, 1 << 20).is_err(),
        "header epoch must match even if key bytes coincide"
    );
}
#[test]
fn malformed_descriptor_and_unsupported_sealer_cannot_supply_plaintext_proof() {
    let s = sealer(COL);
    let (FileContent::Blob(mut d), o) = blob(b"x") else {
        unreachable!()
    };
    d.part_size = 0;
    assert!(FileSourceReader::new(&s, FileContent::Blob(d), 1 << 20).is_err());
    let (d, _) = blob(b"x");
    let plain = crate::seal::PlainSealer::for_device(B16([2; 16]));
    let mut r = FileSourceReader::new(&s, d, 1 << 20).unwrap();
    let n = r.need().unwrap().unwrap();
    assert!(r.supply(&plain, n, o.values().next().unwrap()).is_err());
    assert!(r.finish().is_err());
}
#[test]
fn final_whole_digest_cannot_be_replaced_by_successful_part_authentication() {
    let s = sealer(COL);
    let (FileContent::Blob(mut d), objects) = blob(b"actual") else {
        unreachable!()
    };
    d.plain_hash = mdbn_wire::hash::sha256(b"others");
    let cid = crate::crypto::blob::content_key(&Secret32([9; 32]), &COL);
    d.blob_id = B32(crate::crypto::blob::blob_id(&cid, &d.plain_hash.0, d.size));
    let mut r = FileSourceReader::new(&s, FileContent::Blob(d), 1 << 20).unwrap();
    let need = r.need().unwrap().unwrap();
    r.supply(&s, need, objects.values().next().unwrap())
        .unwrap();
    assert_eq!(r.need().unwrap(), None);
    assert!(matches!(
        r.finish(),
        Err(StreamError::Corrupt("whole blob hash"))
    ));
}

#[test]
fn wrong_requested_object_is_a_sticky_protocol_failure() {
    let s = sealer(COL);
    let (d, o) = blob(b"x");
    let mut r = FileSourceReader::new(&s, d, 1 << 20).unwrap();
    let n = r.need().unwrap().unwrap();
    let SourceNeed::BlobPart {
        index, max_bytes, ..
    } = n
    else {
        unreachable!()
    };
    assert!(
        r.supply(
            &s,
            SourceNeed::BlobPart {
                index,
                address: B32([0; 32]),
                max_bytes
            },
            o.values().next().unwrap()
        )
        .is_err()
    );
    assert!(r.finish().is_err());
}
#[test]
fn compressed_frame_raw_length_is_consumer_bounded_before_inflation() {
    let s = sealer(COL);
    let declared = vec![b'x'; 1 << 20];
    let (d, _) = blob(&declared);
    let mut r = FileSourceReader::new(&s, d, 1 << 20).unwrap();
    let need = r.need().unwrap().unwrap();
    let SourceNeed::BlobPart { address, .. } = need else {
        unreachable!()
    };
    let raw = crate::crypto::blob::seal_part(
        &Secret32([9; 32]),
        1,
        &COL,
        address,
        &vec![b'y'; 2 << 20],
        true,
        &mut Rng(1),
    )
    .unwrap()
    .bytes;
    assert!(r.supply(&s, need, &raw).is_err());
    assert!(r.finish().is_err());
}

#[test]
fn larger_whole_sources_require_a_separate_streaming_consumer() {
    let s = sealer(COL);
    let plain = vec![b'p'; CHUNK_BYTES as usize + 3];
    for make in MAKERS {
        let (d, _) = make(&plain);
        assert!(matches!(
            FileSourceReader::new(&s, d, MAX_SOURCE_BYTES),
            Err(StreamError::TooLarge)
        ));
    }
}

#[test]
fn shared_primitive_cap_is_per_part_even_for_a_one_gib_descriptor() {
    let s = sealer(COL);
    let part = vec![b'p'; 1 << 20];
    let (FileContent::Blob(mut d), _) = blob(&part) else {
        unreachable!()
    };
    d.size = 1 << 30;
    let cid = crate::crypto::blob::content_key(&Secret32([9; 32]), &COL);
    d.blob_id = B32(crate::crypto::blob::blob_id(&cid, &d.plain_hash.0, d.size));
    let address = s.blob_part_addresses(&d).unwrap()[0];
    let raw = crate::crypto::blob::seal_part(
        &Secret32([9; 32]),
        1,
        &COL,
        address,
        &part,
        false,
        &mut Rng(1),
    )
    .unwrap()
    .bytes;
    assert!(matches!(
        FileSourceReader::new(&s, FileContent::Blob(d.clone()), MAX_SOURCE_BYTES),
        Err(StreamError::TooLarge)
    ));
    let opened = s.open_blob_part(&d, 0, &raw, 1 << 20).unwrap();
    assert_eq!(&opened[..], part);
    assert!(s.open_blob_part(&d, 0, &raw, (1 << 20) - 1).is_err());
    assert!(
        s.open_blob_part(&d, 0, &raw, crate::crypto::blob::MAX_PART_SIZE + 1)
            .is_err()
    );
    // This only authenticates ONE part, not the hypothetical complete file.
}
