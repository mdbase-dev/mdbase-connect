use std::collections::BTreeMap;

use mdbn_wire::common::{B16, Hash};
use zeroize::Zeroizing;

use super::*;
use crate::crypto::Secret32;
use crate::seal::KeyringSealer;

const COL: B16 = B16([3; 16]);
const CHUNK: u64 = CHUNK_BYTES as u64;

struct Rng(u8);
impl crate::crypto::Entropy for Rng {
    fn fill(&mut self, out: &mut [u8]) {
        for b in out.iter_mut() {
            self.0 = self.0.wrapping_mul(31).wrapping_add(7);
            *b = self.0;
        }
    }
}
impl CsprngEntropy for Rng {}

fn sealer() -> KeyringSealer {
    let mut keys = crate::crypto::keys::Keyring::new();
    keys.insert(1, Secret32([9; 32]));
    let bytes = keys.to_bytes();
    let mut stored = Zeroizing::new((bytes.len() as u64).to_be_bytes().to_vec());
    stored.extend_from_slice(&bytes);
    let mut s = KeyringSealer::new(COL, B16([2; 16]), &[6; 32], &[7; 32]);
    s.import(&stored).unwrap();
    s.set_epoch(1);
    s
}

fn data(len: u64) -> Vec<u8> {
    (0..len).map(|i| (i * 7 % 251) as u8).collect()
}

/// Write `plain` and return the objects by address, plus the descriptor.
fn write(s: &KeyringSealer, plain: &[u8]) -> (BTreeMap<Hash, Vec<u8>>, WrittenAttachment) {
    let mut rng = Rng(1);
    let limits = AttachmentLimits::default();
    let mut w = AttachmentWriter::new(s, COL, plain.len() as u64, limits, &mut rng).unwrap();
    let mut objects = BTreeMap::new();
    let mut at = 0usize;
    loop {
        let n = usize::try_from(w.next_chunk_len()).unwrap();
        let o = w.push_chunk(s, &plain[at..at + n], &mut rng).unwrap();
        objects.insert(o.cipher_hash, o.bytes);
        at += n;
        if at == plain.len() {
            break;
        }
    }
    let done = w.finish(s, &mut rng).unwrap();
    objects.insert(done.manifest.cipher_hash, done.manifest.bytes.clone());
    (objects, done)
}

#[derive(Default)]
struct Collect(Vec<(u64, Vec<u8>)>);
impl PlainSink for Collect {
    fn write(&mut self, offset: u64, plain: &[u8]) -> Result<(), String> {
        self.0.push((offset, plain.to_vec()));
        Ok(())
    }
}
impl Collect {
    fn bytes(&self) -> Vec<u8> {
        self.0.iter().flat_map(|(_, b)| b.clone()).collect()
    }
}

/// Drive a reader against the object map; count chunk fetches.
fn drive(
    s: &KeyringSealer,
    r: &mut AttachmentReader,
    objects: &BTreeMap<Hash, Vec<u8>>,
    sink: &mut Collect,
) -> Result<usize, StreamError> {
    let mut fetched = 0;
    while let Some(need) = r.need() {
        match need {
            Need::Manifest { address } => r.supply_manifest(s, &objects[&address])?,
            Need::Chunk { index, address, .. } => {
                fetched += 1;
                r.supply_chunk(s, index, &objects[&address], sink)?;
            }
        }
    }
    Ok(fetched)
}

#[test]
fn in_place_writer_matches_owned_chunks_and_manifest_with_current_custody() {
    let s = sealer();
    for total in [0, 31, CHUNK + 99] {
        let plain = data(total);
        let mut a_rng = Rng(1);
        let mut b_rng = Rng(1);
        let mut a =
            AttachmentWriter::new(&s, COL, total, AttachmentLimits::default(), &mut a_rng).unwrap();
        let mut b =
            AttachmentWriter::new(&s, COL, total, AttachmentLimits::default(), &mut b_rng).unwrap();
        let mut region = vec![0xad; MAX_SEALED_CHUNK as usize];
        let pointer = region.as_ptr();
        let capacity = region.capacity();
        let mut at = 0;
        loop {
            let n = a.next_chunk_len() as usize;
            region[..n].copy_from_slice(&plain[at..at + n]);
            let span = a
                .push_chunk_in_place(&s, &mut region, n, &mut a_rng)
                .unwrap();
            let owned = b.push_chunk(&s, &plain[at..at + n], &mut b_rng).unwrap();
            assert_eq!(span.cipher_hash(), owned.cipher_hash);
            assert_eq!(&region[span.range()], &owned.bytes);
            assert!(region[span.range().end..].iter().all(|b| *b == 0));
            assert_eq!(a.chunks(), b.chunks());
            assert_eq!(region.as_ptr(), pointer);
            assert_eq!(region.capacity(), capacity);
            at += n;
            if at == plain.len() {
                break;
            }
        }
        let a = a.finish(&s, &mut a_rng).unwrap();
        let b = b.finish(&s, &mut b_rng).unwrap();
        assert_eq!(a.expected, b.expected);
        assert_eq!(a.refs, b.refs);
        assert_eq!(a.manifest.bytes, b.manifest.bytes);
        let manifest = s
            .open_attachment_manifest(
                &a.descriptor,
                a.expected,
                &a.manifest.bytes,
                AttachmentLimits::default(),
            )
            .unwrap();
        let last = manifest.manifest().chunks.len() as u64 - 1;
        let sealed_bytes = manifest.manifest().chunks[last as usize].sealed_bytes as usize;
        let range = s
            .open_attachment_chunk_in_place(&manifest, last, &mut region[..sealed_bytes])
            .unwrap();
        assert_eq!(&region[range], &plain[last as usize * CHUNK as usize..]);
    }
}

#[test]
fn in_place_writer_refusals_wipe_before_entropy_without_digest_ref_or_written_progress() {
    struct NoEntropy;
    impl crate::crypto::Entropy for NoEntropy {
        fn fill(&mut self, _: &mut [u8]) {
            panic!("refusal before entropy");
        }
    }
    impl CsprngEntropy for NoEntropy {}
    for case in 0..4 {
        let mut s = sealer();
        let collection = if case == 3 { B16([55; 16]) } else { COL };
        let mut rng = Rng(1);
        let mut w = AttachmentWriter::new(&s, collection, 3, AttachmentLimits::default(), &mut rng)
            .unwrap();
        let before = w.whole.clone().finalize();
        let mut region = vec![
            0xab;
            if case == 1 {
                3
            } else {
                MAX_SEALED_CHUNK as usize
            }
        ];
        if case == 0 {
            s.set_epoch(2);
        }
        let n = if case == 2 { 4 } else { 3 };
        assert!(
            w.push_chunk_in_place(&s, &mut region, n, &mut NoEntropy)
                .is_err()
        );
        assert!(region.iter().all(|b| *b == 0));
        assert_eq!(w.written, 0);
        assert!(w.chunks.is_empty());
        assert_eq!(w.whole.clone().finalize(), before);
    }
    let mut unsupported = crate::seal::PlainSealer::for_device(B16([2; 16]));
    unsupported.set_epoch(1);
    let context = ChunkContextV1 {
        attachment: AttachmentContextV1 {
            collection: COL,
            key_epoch: 1,
            attachment_id: mdbn_wire::common::B32([4; 32]),
            chunk_bytes: CHUNK_BYTES,
        },
        index: 0,
        final_chunk: true,
        plain_bytes: 3,
    };
    let mut region = vec![0xab; MAX_SEALED_CHUNK as usize];
    assert!(
        unsupported
            .seal_attachment_chunk_in_place(&context, &mut region, 3, &mut NoEntropy)
            .is_err()
    );
    assert!(region.iter().all(|b| *b == 0));
}

#[test]
fn keyring_in_place_refuses_held_historical_epoch_and_foreign_collection_before_entropy() {
    struct NoEntropy;
    impl crate::crypto::Entropy for NoEntropy {
        fn fill(&mut self, _: &mut [u8]) {
            panic!("custody refusal before entropy");
        }
    }
    impl CsprngEntropy for NoEntropy {}
    let mut s = sealer();
    let mut keys = crate::crypto::keys::Keyring::new();
    keys.insert(1, Secret32([9; 32]));
    keys.insert(2, Secret32([10; 32]));
    let bytes = keys.to_bytes();
    let mut stored = Zeroizing::new((bytes.len() as u64).to_be_bytes().to_vec());
    stored.extend_from_slice(&bytes);
    s.import(&stored).unwrap();
    s.set_epoch(2);
    assert_eq!(s.current_epoch(), Some(2));
    for case in 0..2 {
        let context = ChunkContextV1 {
            attachment: AttachmentContextV1 {
                collection: if case == 0 { COL } else { B16([55; 16]) },
                key_epoch: if case == 0 { 1 } else { 2 },
                attachment_id: mdbn_wire::common::B32([4; 32]),
                chunk_bytes: CHUNK_BYTES,
            },
            index: 0,
            final_chunk: true,
            plain_bytes: 3,
        };
        let mut region = vec![0xab; MAX_SEALED_CHUNK as usize];
        assert!(
            s.attachment_chunk_in_place_check(&context, 3, region.len())
                .is_err()
        );
        assert!(
            s.seal_attachment_chunk_in_place(&context, &mut region, 3, &mut NoEntropy)
                .is_err()
        );
        assert!(region.iter().all(|b| *b == 0));
    }
}

// Test-only custody fault AFTER the preflight, including a deliberately dirty
// region. No production Sealer or unsupported default is weakened for this.
struct AfterWriteFault(KeyringSealer);
impl Sealer for AfterWriteFault {
    fn set_epoch(&mut self, e: u64) {
        self.0.set_epoch(e);
    }
    fn current_epoch(&self) -> Option<u64> {
        self.0.current_epoch()
    }
    fn idem_token(&self, m: &Uuid) -> Option<mdbn_wire::common::B16> {
        self.0.idem_token(m)
    }
    fn seal(
        &mut self,
        i: &mut mdbn_wire::envelope::Item,
        p: &[u8],
        c: bool,
        e: &mut dyn CsprngEntropy,
    ) -> Result<(), crate::seal::SealError> {
        self.0.seal(i, p, c, e)
    }
    fn seal_object(
        &mut self,
        i: &mut mdbn_wire::envelope::Item,
        p: &[u8],
        c: bool,
        s: bool,
        e: &mut dyn CsprngEntropy,
    ) -> Result<(), crate::seal::SealError> {
        self.0.seal_object(i, p, c, s, e)
    }
    fn blob_part_addresses(
        &self,
        b: &mdbn_wire::intent::BlobRef,
    ) -> Option<Vec<mdbn_wire::common::B32>> {
        self.0.blob_part_addresses(b)
    }
    fn sign(&self, i: &mut mdbn_wire::envelope::Item) -> Result<(), crate::seal::SealError> {
        self.0.sign(i)
    }
    fn open(
        &self,
        i: &mdbn_wire::envelope::Item,
        r: &[u8],
    ) -> Result<Vec<u8>, crate::seal::OpenError> {
        self.0.open(i, r)
    }
    fn verifier(&self) -> &dyn crate::policy::SigVerifier {
        self.0.verifier()
    }
    fn accept_rekey(&mut self, p: &mdbn_wire::envelope::RekeyPayload) -> crate::seal::KeyEvent {
        self.0.accept_rekey(p)
    }
    fn accept_key_grant(
        &mut self,
        p: &mdbn_wire::envelope::KeyGrantPayload,
    ) -> crate::seal::KeyEvent {
        self.0.accept_key_grant(p)
    }
    fn build_rekey(
        &mut self,
        f: u64,
        r: &[crate::crypto::keys::Recipient],
        why: mdbn_wire::envelope::RekeyReason,
        e: &mut dyn CsprngEntropy,
    ) -> Result<mdbn_wire::envelope::RekeyPayload, crate::seal::SealError> {
        self.0.build_rekey(f, r, why, e)
    }
    fn export(&self) -> Option<Zeroizing<Vec<u8>>> {
        self.0.export()
    }
    fn import(&mut self, b: &[u8]) -> Result<(), crate::seal::SealError> {
        self.0.import(b)
    }
    fn attachment_chunk_in_place_check(
        &self,
        c: &ChunkContextV1,
        n: usize,
        r: usize,
    ) -> Result<(), crate::seal::SealError> {
        self.0.attachment_chunk_in_place_check(c, n, r)
    }
    fn seal_attachment_chunk_in_place(
        &self,
        _: &ChunkContextV1,
        r: &mut [u8],
        _: usize,
        e: &mut dyn CsprngEntropy,
    ) -> Result<SealedChunkSpan, crate::seal::SealError> {
        e.fill(&mut [0; 16]);
        r.fill(0x55);
        Err(crate::seal::SealError::Failed(
            "injected after-write fault".into(),
        ))
    }
}

#[test]
fn in_place_writer_after_write_error_wipes_and_can_retry_without_digest_advancement() {
    let s = sealer();
    let mut rng = Rng(1);
    let mut w = AttachmentWriter::new(&s, COL, 3, AttachmentLimits::default(), &mut rng).unwrap();
    let before = w.whole.clone().finalize();
    let mut region = vec![0xab; MAX_SEALED_CHUNK as usize];
    region[..3].copy_from_slice(b"abc");
    assert!(
        w.push_chunk_in_place(&AfterWriteFault(sealer()), &mut region, 3, &mut rng)
            .is_err()
    );
    assert!(region.iter().all(|b| *b == 0));
    assert_eq!(w.written, 0);
    assert!(w.chunks.is_empty());
    assert_eq!(w.whole.clone().finalize(), before);
    region[..3].copy_from_slice(b"abc");
    w.push_chunk_in_place(&s, &mut region, 3, &mut rng).unwrap();
    let done = w.finish(&s, &mut rng).unwrap();
    assert_eq!(
        done.expected.whole_plain_hash,
        mdbn_wire::hash::sha256(b"abc")
    );
}

#[test]
fn a_multi_chunk_file_round_trips_one_chunk_at_a_time() {
    let s = sealer();
    let plain = data(2 * CHUNK + 1234);
    let (objects, w) = write(&s, &plain);
    assert_eq!(w.refs.len(), 4, "3 chunks + manifest");
    assert_eq!(*w.refs.last().unwrap(), w.descriptor.manifest_cipher_hash);
    let mut r =
        AttachmentReader::whole(w.descriptor, w.expected, AttachmentLimits::default()).unwrap();
    let mut sink = Collect::default();
    assert_eq!(drive(&s, &mut r, &objects, &mut sink).unwrap(), 3);
    assert_eq!(sink.0.len(), 3, "one release per authenticated chunk");
    assert!(sink.0.iter().all(|(_, b)| b.len() as u64 <= CHUNK));
    assert_eq!(sink.bytes(), plain);
    assert_eq!(r.finish(), Ok(false), "whole hash checked in-stream");
}

#[test]
fn a_range_touches_only_its_chunks_and_releases_exactly_its_bytes() {
    let s = sealer();
    let plain = data(3 * CHUNK);
    let (objects, w) = write(&s, &plain);
    let (start, end) = (CHUNK - 10, CHUNK + 10);
    let mut r = AttachmentReader::range(
        w.descriptor,
        w.expected,
        AttachmentLimits::default(),
        start,
        end,
    )
    .unwrap();
    let mut sink = Collect::default();
    assert_eq!(drive(&s, &mut r, &objects, &mut sink).unwrap(), 2);
    assert_eq!(sink.0[0].0, start);
    assert_eq!(sink.bytes(), plain[start as usize..end as usize]);
    assert_eq!(r.finish(), Ok(false));
}

#[test]
fn owned_sink_receives_one_authenticated_allocation_with_only_the_requested_slice() {
    struct Owned(Option<AuthenticatedReadChunk>);
    impl PlainSink for Owned {
        fn write(&mut self, _: u64, _: &[u8]) -> Result<(), String> {
            panic!("owned delivery must not copy through write");
        }
        fn write_owned(&mut self, chunk: AuthenticatedReadChunk) -> Result<(), String> {
            assert!(self.0.is_none());
            self.0 = Some(chunk);
            Ok(())
        }
    }
    let s = sealer();
    let plain = data(2 * CHUNK);
    let (objects, w) = write(&s, &plain);
    let start = CHUNK + 3;
    let end = start + 5;
    let mut r = AttachmentReader::range(
        w.descriptor,
        w.expected,
        AttachmentLimits::default(),
        start,
        end,
    )
    .unwrap();
    let Need::Manifest { address } = r.need().unwrap() else {
        panic!()
    };
    r.supply_manifest(&s, &objects[&address]).unwrap();
    let Need::Chunk { index, address, .. } = r.need().unwrap() else {
        panic!()
    };
    assert_eq!(index, 1);
    let mut sink = Owned(None);
    r.supply_chunk(&s, index, &objects[&address], &mut sink)
        .unwrap();
    let chunk = sink.0.take().unwrap();
    assert_eq!(chunk.offset(), start);
    assert_eq!(chunk.bytes(), &plain[start as usize..end as usize]);
    assert_eq!(
        chunk.plain.len() as u64,
        CHUNK,
        "retain the original authenticated allocation, not a copied slice"
    );
    assert!(format!("{chunk:?}").len() < 128, "Debug is metadata-only");
    assert_eq!(r.finish(), Ok(false));
}

#[test]
fn a_tampered_chunk_releases_nothing_and_stops() {
    let s = sealer();
    let plain = data(CHUNK + 5);
    let (mut objects, w) = write(&s, &plain);
    let second = w.refs[1];
    let o = objects.get_mut(&second).unwrap();
    let n = o.len();
    o[n - 1] ^= 1;
    let mut r =
        AttachmentReader::whole(w.descriptor, w.expected, AttachmentLimits::default()).unwrap();
    let mut sink = Collect::default();
    assert_eq!(
        drive(&s, &mut r, &objects, &mut sink),
        Err(StreamError::Corrupt("chunk"))
    );
    assert_eq!(
        sink.bytes(),
        plain[..CHUNK as usize],
        "only the first chunk released"
    );
}

#[test]
fn a_resumed_read_continues_and_asks_the_host_to_rehash() {
    let s = sealer();
    let plain = data(2 * CHUNK + 1);
    let (objects, w) = write(&s, &plain);
    let mut r =
        AttachmentReader::resume(w.descriptor, w.expected, AttachmentLimits::default(), 1).unwrap();
    let mut sink = Collect::default();
    assert_eq!(drive(&s, &mut r, &objects, &mut sink).unwrap(), 2);
    assert_eq!(sink.0[0].0, CHUNK);
    assert_eq!(r.finish(), Ok(true), "host must re-hash its staging");
    let mut h = WholeFileHasher::default();
    h.update(&plain);
    assert!(h.matches(&w.expected));
    let mut bad = WholeFileHasher::default();
    bad.update(&plain[1..]);
    assert!(!bad.matches(&w.expected));
}

#[test]
fn the_manifest_must_match_the_signed_file_metadata() {
    let s = sealer();
    let plain = data(100);
    let (objects, w) = write(&s, &plain);
    let mut wrong = w.expected;
    wrong.total_plain_bytes += 1;
    let mut r = AttachmentReader::whole(w.descriptor, wrong, AttachmentLimits::default()).unwrap();
    let mut sink = Collect::default();
    assert_eq!(
        drive(&s, &mut r, &objects, &mut sink),
        Err(StreamError::Corrupt("manifest"))
    );
    assert!(sink.0.is_empty());
}

#[test]
fn small_and_empty_files_round_trip() {
    let s = sealer();
    for len in [0u64, 1, 100] {
        let plain = data(len);
        let (objects, w) = write(&s, &plain);
        let mut r =
            AttachmentReader::whole(w.descriptor, w.expected, AttachmentLimits::default()).unwrap();
        let mut sink = Collect::default();
        drive(&s, &mut r, &objects, &mut sink).unwrap();
        assert_eq!(sink.bytes(), plain, "{len}");
        assert_eq!(r.finish(), Ok(false), "{len}");
    }
}

#[test]
fn no_key_and_policy_limits_are_explicit() {
    let s = KeyringSealer::new(COL, B16([2; 16]), &[6; 32], &[7; 32]);
    let e =
        AttachmentWriter::new(&s, COL, 10, AttachmentLimits::default(), &mut Rng(1)).unwrap_err();
    assert_eq!(e, StreamError::NoKey);
    let small = AttachmentLimits { max_file_bytes: 10 };
    let e = AttachmentWriter::new(&sealer(), COL, 11, small, &mut Rng(1)).unwrap_err();
    assert_eq!(e, StreamError::TooLarge);
}
