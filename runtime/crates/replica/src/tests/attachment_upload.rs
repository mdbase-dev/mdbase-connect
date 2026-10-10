//! Attachment upload and emit (T4) over the in-memory store and fake log: chunks
//! stored before the manifest, the manifest before the entry, refs exactly the
//! sorted ciphertext object union, resume without re-sending stored objects,
//! bounded reads and calls, and the size cap.

use std::cell::{Cell, RefCell};
use std::collections::BTreeSet;
use std::rc::Rc;

use mdbn_wire::attachment_runtime_v1 as rt;
use mdbn_wire::common::{B16, B32, Hash, Uuid};
use mdbn_wire::envelope::{Item, ItemKind, KeyGrantPayload, RekeyPayload, RekeyReason};
use mdbn_wire::schema::Wire;
use zeroize::Zeroizing;

use super::engine::{COL, Node, node, settle};
use crate::Store;
use crate::attachments::{AttachmentReader, MAX_SEALED_CHUNK, PlainSink};
use crate::crypto::chunked_blob::{
    self, AttachmentLimits, AttachmentRefV1, CHUNK_BYTES, ChunkContextV1, ChunkRefV1,
    ExpectedFileV1, ManifestV1, SealedObject, VerifiedManifestV1,
};
use crate::crypto::{CsprngEntropy, Secret32, keys::Recipient};
use crate::fake::FakeLogService;
use crate::log::{LogClient, LogPort, LogRequest};
use crate::mem::MemStore;
use crate::policy::SigVerifier;
use crate::replica::{
    AttachmentSource, AttachmentUploadCheckpoint, AttachmentUploadParams, AttachmentUploadStatus,
};
use crate::seal::{KeyEvent, OpenError, SealError, Sealer};

const CHUNK: u64 = CHUNK_BYTES as u64;

/// The test sealer plus attachment-v1 crypto under a fixed per-epoch key.
struct AttachSealer {
    inner: Box<dyn Sealer>,
}

fn epoch_key(epoch: u64) -> Secret32 {
    Secret32([0xa0 ^ (epoch as u8); 32])
}

impl Sealer for AttachSealer {
    fn set_epoch(&mut self, epoch: u64) {
        self.inner.set_epoch(epoch);
    }
    fn current_epoch(&self) -> Option<u64> {
        self.inner.current_epoch()
    }
    fn idem_token(&self, mutation: &Uuid) -> Option<B16> {
        self.inner.idem_token(mutation)
    }
    fn seal(
        &mut self,
        item: &mut Item,
        plain: &[u8],
        compress: bool,
        entropy: &mut dyn CsprngEntropy,
    ) -> Result<(), SealError> {
        self.inner.seal(item, plain, compress, entropy)
    }
    fn seal_object(
        &mut self,
        item: &mut Item,
        plain: &[u8],
        compress: bool,
        sign: bool,
        entropy: &mut dyn CsprngEntropy,
    ) -> Result<(), SealError> {
        self.inner.seal_object(item, plain, compress, sign, entropy)
    }
    fn seal_attachment_chunk(
        &self,
        context: &ChunkContextV1,
        plain: &[u8],
        entropy: &mut dyn CsprngEntropy,
    ) -> Result<(SealedObject, ChunkRefV1), SealError> {
        let epoch = self.current_epoch().ok_or(SealError::NotKeyed)?;
        if context.attachment.collection != COL || context.attachment.key_epoch != epoch {
            return Err(SealError::Failed("not current".into()));
        }
        chunked_blob::seal_chunk(&epoch_key(epoch), context, plain, entropy)
            .map_err(SealError::from)
    }
    fn seal_attachment_manifest(
        &self,
        manifest: &ManifestV1,
        limits: AttachmentLimits,
        entropy: &mut dyn CsprngEntropy,
    ) -> Result<SealedObject, SealError> {
        let epoch = self.current_epoch().ok_or(SealError::NotKeyed)?;
        if manifest.context.collection != COL || manifest.context.key_epoch != epoch {
            return Err(SealError::Failed("not current".into()));
        }
        chunked_blob::seal_manifest(&epoch_key(epoch), manifest, limits, entropy)
            .map_err(SealError::from)
    }
    fn open_attachment_manifest(
        &self,
        descriptor: &AttachmentRefV1,
        expected: ExpectedFileV1,
        raw: &[u8],
        limits: AttachmentLimits,
    ) -> Result<VerifiedManifestV1, OpenError> {
        let key = epoch_key(descriptor.context.key_epoch);
        chunked_blob::open_manifest(&key, descriptor, expected, raw, limits)
            .map_err(|_| OpenError::Aead)
    }
    fn open_attachment_chunk(
        &self,
        manifest: &VerifiedManifestV1,
        index: u64,
        raw: &[u8],
    ) -> Result<Zeroizing<Vec<u8>>, OpenError> {
        let key = epoch_key(manifest.descriptor().context.key_epoch);
        chunked_blob::open_chunk(&key, manifest, index, raw).map_err(|_| OpenError::Aead)
    }
    fn blob_part_addresses(&self, blob: &mdbn_wire::intent::BlobRef) -> Option<Vec<B32>> {
        self.inner.blob_part_addresses(blob)
    }
    fn sign(&self, item: &mut Item) -> Result<(), SealError> {
        self.inner.sign(item)
    }
    fn open(&self, item: &Item, raw: &[u8]) -> Result<Vec<u8>, OpenError> {
        self.inner.open(item, raw)
    }
    fn verifier(&self) -> &dyn SigVerifier {
        self.inner.verifier()
    }
    fn accept_rekey(&mut self, p: &RekeyPayload) -> KeyEvent {
        self.inner.accept_rekey(p)
    }
    fn accept_key_grant(&mut self, p: &KeyGrantPayload) -> KeyEvent {
        self.inner.accept_key_grant(p)
    }
    fn build_rekey(
        &mut self,
        from: u64,
        recipients: &[Recipient],
        reason: RekeyReason,
        entropy: &mut dyn CsprngEntropy,
    ) -> Result<RekeyPayload, SealError> {
        self.inner.build_rekey(from, recipients, reason, entropy)
    }
    fn export(&self) -> Option<Zeroizing<Vec<u8>>> {
        self.inner.export()
    }
    fn import(&mut self, bytes: &[u8]) -> Result<(), SealError> {
        self.inner.import(bytes)
    }
}

/// Deterministic file bytes.
pub(super) fn data(len: u64) -> Vec<u8> {
    (0..len)
        .map(|i| (i.wrapping_mul(131) % 251) as u8)
        .collect()
}

/// What a source was asked for.
#[derive(Default)]
pub(super) struct Reads {
    /// Largest single read.
    max: Cell<usize>,
    /// Bytes read in total.
    total: Cell<u64>,
}

/// A file the replica reads only through bounded positional reads.
pub(super) struct Source {
    pub(super) bytes: Rc<Vec<u8>>,
    pub(super) reads: Rc<Reads>,
}

impl AttachmentSource for Source {
    fn len(&self) -> u64 {
        self.bytes.len() as u64
    }
    fn read_at(&mut self, offset: u64, buf: &mut [u8]) -> Result<(), String> {
        let start = usize::try_from(offset).map_err(|e| e.to_string())?;
        let end = start + buf.len();
        let src = self.bytes.get(start..end).ok_or("short read")?;
        buf.copy_from_slice(src);
        self.reads.max.set(self.reads.max.get().max(buf.len()));
        self.reads
            .total
            .set(self.reads.total.get() + buf.len() as u64);
        Ok(())
    }
}

/// A length with no bytes behind it: any read is a test failure.
struct Unreadable(u64);

impl AttachmentSource for Unreadable {
    fn len(&self) -> u64 {
        self.0
    }
    fn read_at(&mut self, _: u64, _: &mut [u8]) -> Result<(), String> {
        panic!("an over-cap file must not be read");
    }
}

pub(super) fn attach_node(svc: &FakeLogService, n: u8) -> Node {
    attach_node_with(svc, n, MemStore::new())
}

/// [`attach_node`] over a chosen store.
pub(super) fn attach_node_with(svc: &FakeLogService, n: u8, store: MemStore) -> Node {
    let mut a = attach_node_without_drive(svc, n, store);
    settle(&mut [&mut a]);
    a
}

/// Open the attachment test composition without exchanging log calls. Fault
/// tests need to choose the exact first apply batch before any prefix lands.
pub(super) fn attach_node_without_drive(svc: &FakeLogService, n: u8, store: MemStore) -> Node {
    let mut a = node(svc, n, store);
    a.r.planner = Box::new(crate::plan::CorePlanner);
    let inner = std::mem::replace(
        &mut a.r.sealer,
        Box::new(crate::seal::PlainSealer::for_device(B16([0; 16]))),
    );
    a.r.sealer = Box::new(AttachSealer { inner });
    a
}

pub(super) fn params(path: &str) -> AttachmentUploadParams {
    AttachmentUploadParams {
        file: B16([0x5a; 16]),
        path: path.into(),
        if_revision: None,
        mutation: None,
    }
}

/// Every call one exchange delivered, as `(method, bytes queued)`.
pub(super) type Calls = Rc<RefCell<Vec<Vec<(&'static str, usize)>>>>;

/// Exchange calls one batch at a time over the legacy port, recording each
/// batch, letting `hook` act on the service (or fail the call) before delivery.
pub(super) fn drive(
    a: &mut Node,
    calls: &Calls,
    hook: &mut dyn FnMut(&LogRequest, &FakeLogService) -> Option<crate::log::LogReply>,
) {
    for _ in 0..500 {
        let mut batch = a.r.take_log_calls();
        if batch.is_empty() {
            a.r.tick();
            batch = a.r.take_log_calls();
            if batch.is_empty() {
                return;
            }
        }
        calls.borrow_mut().push(
            batch
                .iter()
                .map(|c| {
                    let bytes = match &c.request {
                        LogRequest::PutObject { bytes, .. } => bytes.len(),
                        _ => 0,
                    };
                    (c.request.method(), bytes)
                })
                .collect(),
        );
        for call in batch {
            let reply = match hook(&call.request, a.log.service()) {
                Some(r) => r,
                None => a.log.call(call.request),
            };
            a.r.on_log_reply(call.id, reply);
        }
    }
}

pub(super) fn status(a: &Node, m: &Uuid) -> AttachmentUploadStatus {
    a.r.attachment_upload_status(m).expect("upload")
}

/// The last entry in the log, opened with the runtime family, and its refs.
pub(super) fn last_entry(a: &Node, svc: &FakeLogService) -> (rt::EntryPayload, Vec<Hash>) {
    let raw = svc.items(&COL).last().cloned().expect("an entry");
    let item = Item::from_bytes(&raw).unwrap();
    assert_eq!(item.kind, ItemKind::Entry);
    let plain = a.r.sealer.open(&item, &raw).unwrap();
    (
        rt::EntryPayload::from_bytes(&plain).unwrap(),
        item.refs.unwrap_or_default(),
    )
}

#[derive(Default)]
struct Collect(Vec<u8>);
impl PlainSink for Collect {
    fn write(&mut self, offset: u64, plain: &[u8]) -> Result<(), String> {
        assert_eq!(offset, self.0.len() as u64);
        self.0.extend_from_slice(plain);
        Ok(())
    }
}

/// Read the attachment an entry names back out of the log, as device B would.
fn read_back(a: &Node, svc: &FakeLogService, entry: &rt::EntryPayload) -> Vec<u8> {
    let rt::Op::FileAttach(f) = &entry.mutation.ops[0] else {
        panic!("not a file_attach");
    };
    let r = &f.content.reference;
    let descriptor = AttachmentRefV1 {
        context: chunked_blob::AttachmentContextV1 {
            collection: r.collection,
            key_epoch: r.key_epoch,
            attachment_id: r.attachment_id,
            chunk_bytes: CHUNK_BYTES,
        },
        manifest_cipher_hash: r.manifest_cipher_hash,
    };
    let expected = ExpectedFileV1 {
        whole_plain_hash: f.content.whole_plain_hash,
        total_plain_bytes: f.content.total_plain_bytes,
    };
    let objects: std::collections::BTreeMap<Hash, Vec<u8>> =
        svc.objects(&COL).into_iter().collect();
    let mut reader =
        AttachmentReader::whole(descriptor, expected, AttachmentLimits::default()).unwrap();
    let mut sink = Collect::default();
    while let Some(need) = reader.need() {
        match need {
            crate::attachments::Need::Manifest { address } => reader
                .supply_manifest(&*a.r.sealer, &objects[&address])
                .unwrap(),
            crate::attachments::Need::Chunk { index, address, .. } => reader
                .supply_chunk(&*a.r.sealer, index, &objects[&address], &mut sink)
                .unwrap(),
        }
    }
    assert!(!reader.finish().unwrap());
    sink.0
}

#[test]
fn device_fifo_and_held_call_survive_hosted_idle_interval() {
    let svc = FakeLogService::new();
    let mut a = attach_node(&svc, 1);
    let first_reads = Rc::new(Reads::default());
    let second_reads = Rc::new(Reads::default());
    let first =
        a.r.start_attachment_upload(
            params("files/first.bin"),
            Box::new(Source {
                bytes: Rc::new(data(1234)),
                reads: first_reads.clone(),
            }),
        )
        .unwrap();
    let held = a.r.take_log_calls();
    assert!(
        held.iter()
            .any(|c| matches!(c.request, LogRequest::PutObject { .. }))
    );
    let mut second_params = params("files/second.bin");
    second_params.file = B16([0x5b; 16]);
    let second =
        a.r.start_attachment_upload(
            second_params,
            Box::new(Source {
                bytes: Rc::new(data(1234)),
                reads: second_reads.clone(),
            }),
        )
        .unwrap();
    assert_eq!(first_reads.total.get(), 1234);
    assert_eq!(
        second_reads.total.get(),
        0,
        "device source FIFO is unchanged"
    );
    a.clock.set(a.clock.get() + 60_000);
    a.r.tick();
    assert!(matches!(
        status(&a, &first),
        AttachmentUploadStatus::Uploading { .. }
    ));
    assert_eq!(second_reads.total.get(), 0);
    for call in held {
        let reply = a.log.call(call.request);
        a.r.on_log_reply(call.id, reply);
    }
    drive(&mut a, &Rc::default(), &mut |_, _| None);
    assert!(matches!(
        status(&a, &first),
        AttachmentUploadStatus::Captured(_)
    ));
    assert!(matches!(
        status(&a, &second),
        AttachmentUploadStatus::Captured(_)
    ));
    assert_eq!(second_reads.total.get(), 1234);
}

#[test]
fn multi_chunk_upload_stores_objects_then_appends_with_cipher_refs() {
    let svc = FakeLogService::new();
    let mut a = attach_node(&svc, 1);
    let bytes = Rc::new(data(2 * CHUNK + 1000));
    let reads = Rc::new(Reads::default());
    let m =
        a.r.start_attachment_upload(
            params("files/big.bin"),
            Box::new(Source {
                bytes: bytes.clone(),
                reads: reads.clone(),
            }),
        )
        .unwrap();
    let calls: Calls = Rc::default();
    let order: RefCell<Vec<(&'static str, ItemKind)>> = RefCell::default();
    drive(&mut a, &calls, &mut |req, _| {
        match req {
            LogRequest::PutObject { kind, .. } => order.borrow_mut().push(("put", *kind)),
            LogRequest::Append(_) => order.borrow_mut().push(("append", ItemKind::Entry)),
            _ => {}
        }
        None
    });
    let AttachmentUploadStatus::Captured(receipt) = status(&a, &m) else {
        panic!("not captured: {:?}", status(&a, &m));
    };
    assert_eq!(receipt.mutation, m);

    // Three chunk objects, then the manifest, then the one append.
    let order = order.into_inner();
    assert_eq!(
        order,
        vec![
            ("put", ItemKind::BlobPart),
            ("put", ItemKind::BlobPart),
            ("put", ItemKind::BlobPart),
            ("put", ItemKind::BlobPart),
            ("append", ItemKind::Entry),
        ]
    );

    // Refs: sorted, distinct, exactly the stored objects (3 chunks + manifest),
    // the manifest among them, and no plaintext hash.
    let (entry, refs) = last_entry(&a, &svc);
    let stored: BTreeSet<Hash> = svc.objects(&COL).into_iter().map(|(h, _)| h).collect();
    assert_eq!(refs.len(), 4);
    assert!(refs.windows(2).all(|w| w[0] < w[1]));
    assert_eq!(refs.iter().copied().collect::<BTreeSet<_>>(), stored);
    for (h, b) in svc.objects(&COL) {
        assert_eq!(
            mdbn_wire::hash::sha256(&b),
            h,
            "refs are ciphertext Item hashes"
        );
    }
    let rt::Op::FileAttach(f) = &entry.mutation.ops[0] else {
        panic!("not a file_attach");
    };
    assert_eq!(entry.mutation.ops.len(), 1);
    assert!(refs.contains(&f.content.reference.manifest_cipher_hash));
    assert_eq!(f.content.total_plain_bytes, bytes.len() as u64);
    assert_eq!(f.content.whole_plain_hash, mdbn_wire::hash::sha256(&bytes));
    assert_eq!(f.path, "files/big.bin");
    let plain_hashes: Vec<Hash> = bytes
        .chunks(CHUNK as usize)
        .map(mdbn_wire::hash::sha256)
        .chain(std::iter::once(mdbn_wire::hash::sha256(&bytes)))
        .collect();
    assert!(plain_hashes.iter().all(|h| !refs.contains(h)));
    assert!(
        entry
            .effects
            .iter()
            .any(|e| matches!(e, rt::Effect::PutAttachmentFile(p) if p.path == "files/big.bin"))
    );

    // The objects decrypt to exactly the file.
    assert_eq!(read_back(&a, &svc, &entry), *bytes);
    // Every byte read once, never more than a chunk at a time.
    assert_eq!(reads.total.get(), bytes.len() as u64);
    assert!(reads.max.get() <= CHUNK as usize);

    // The writer applies its own entry (T5): confirmed, descriptor in the row.
    assert_eq!(a.r.stalled, None);
    let row =
        a.r.store()
            .file(&B16([0x5a; 16]))
            .unwrap()
            .expect("applied");
    assert_eq!(
        row.content,
        mdbn_wire::attachment::FileContent::AttachmentV1(f.content.clone())
    );
}

#[test]
fn upload_keeps_one_bounded_object_in_flight() {
    let svc = FakeLogService::new();
    let mut a = attach_node(&svc, 1);
    let bytes = Rc::new(data(3 * CHUNK));
    let reads = Rc::new(Reads::default());
    a.r.start_attachment_upload(
        params("files/three.bin"),
        Box::new(Source {
            bytes: bytes.clone(),
            reads: reads.clone(),
        }),
    )
    .unwrap();
    let calls: Calls = Rc::default();
    drive(&mut a, &calls, &mut |_, _| None);
    let calls = calls.borrow();
    let puts: Vec<usize> = calls
        .iter()
        .flatten()
        .filter(|(m, _)| *m == "put_object")
        .map(|(_, b)| *b)
        .collect();
    assert_eq!(puts.len(), 4);
    for batch in calls.iter() {
        let queued: usize = batch.iter().map(|(_, b)| b).sum();
        assert!(
            batch.iter().filter(|(m, _)| *m == "put_object").count() <= 1,
            "one object at a time"
        );
        assert!(
            queued as u64 <= MAX_SEALED_CHUNK,
            "never more than one sealed chunk queued"
        );
    }
    assert!(reads.max.get() <= CHUNK as usize);
    assert_eq!(reads.total.get(), bytes.len() as u64);
}

#[test]
fn lost_reply_is_checked_not_resent_and_lost_request_is_resealed() {
    let svc = FakeLogService::new();
    let mut a = attach_node(&svc, 1);
    let bytes = Rc::new(data(2 * CHUNK + 7));
    let m =
        a.r.start_attachment_upload(
            params("files/lossy.bin"),
            Box::new(Source {
                bytes: bytes.clone(),
                reads: Rc::default(),
            }),
        )
        .unwrap();
    let calls: Calls = Rc::default();
    let mut puts = 0;
    drive(&mut a, &calls, &mut |req, svc| {
        if !matches!(req, LogRequest::PutObject { .. }) {
            return None;
        }
        puts += 1;
        match puts {
            // Chunk 0 is stored but its reply is lost: has_objects says so.
            1 => {
                let mut c = svc.client(B16([101; 16]));
                let _ = c.call(req.clone());
                Some(Err(crate::log::LogError::NoResponse))
            }
            // Chunk 1 never arrives: it is sealed again (a new object).
            2 => Some(Err(crate::log::LogError::NoResponse)),
            _ => None,
        }
    });
    assert!(matches!(
        status(&a, &m),
        AttachmentUploadStatus::Captured(_)
    ));
    // 3 chunks + manifest stored, plus the one lost request re-sent.
    assert_eq!(puts, 5);
    let methods: Vec<&str> = calls.borrow().iter().flatten().map(|(m, _)| *m).collect();
    assert_eq!(
        methods.iter().filter(|m| **m == "has_objects").count(),
        3,
        "two rechecks and the final check"
    );
    let (entry, refs) = last_entry(&a, &svc);
    // Nothing orphaned, nothing missing.
    let stored: BTreeSet<Hash> = svc.objects(&COL).into_iter().map(|(h, _)| h).collect();
    assert_eq!(refs.iter().copied().collect::<BTreeSet<_>>(), stored);
    assert_eq!(read_back(&a, &svc, &entry), *bytes);
}

#[test]
fn interrupted_upload_resumes_from_a_checkpoint_without_resending() {
    let svc = FakeLogService::new();
    let mut a = attach_node(&svc, 1);
    let bytes = Rc::new(data(3 * CHUNK + 5));
    let m =
        a.r.start_attachment_upload(
            params("files/resume.bin"),
            Box::new(Source {
                bytes: bytes.clone(),
                reads: Rc::default(),
            }),
        )
        .unwrap();
    // Two chunks go up; then the log is unreachable.
    let calls: Calls = Rc::default();
    let mut puts = 0;
    drive(&mut a, &calls, &mut |req, _| {
        if matches!(req, LogRequest::PutObject { .. }) {
            puts += 1;
            if puts > 2 {
                return Some(Err(crate::log::LogError::Offline));
            }
        }
        None
    });
    assert!(matches!(
        status(&a, &m),
        AttachmentUploadStatus::Uploading { .. }
    ));
    assert_eq!(svc.objects(&COL).len(), 2);
    // The host persists a checkpoint, and the process goes away.
    let saved = a.r.attachment_upload_checkpoint(&m).unwrap().to_bytes();
    assert!(a.r.close_attachment_upload(&m));
    assert!(a.r.attachment_upload_status(&m).is_none());

    let checkpoint = AttachmentUploadCheckpoint::from_bytes(&saved).unwrap();
    assert_eq!(checkpoint.to_bytes(), saved);
    let reads = Rc::new(Reads::default());
    let resumed =
        a.r.resume_attachment_upload(
            checkpoint,
            Box::new(Source {
                bytes: bytes.clone(),
                reads: reads.clone(),
            }),
        )
        .unwrap();
    assert_eq!(resumed, m);
    let calls: Calls = Rc::default();
    let mut puts = Vec::new();
    drive(&mut a, &calls, &mut |req, _| {
        if let LogRequest::PutObject { address, .. } = req {
            puts.push(*address);
        }
        None
    });
    assert!(matches!(
        status(&a, &m),
        AttachmentUploadStatus::Captured(_)
    ));
    let first = calls.borrow()[0].clone();
    assert!(
        first.contains(&("has_objects", 0)) && first.iter().all(|(m, _)| *m != "put_object"),
        "resume asks before sending"
    );
    // Only chunks 2 and 3 and the manifest are sent; chunks 0 and 1 are adopted.
    assert_eq!(puts.len(), 3);
    // Adopted chunks are re-read, so the signed hash still covers every byte.
    assert_eq!(reads.total.get(), bytes.len() as u64);
    let (entry, refs) = last_entry(&a, &svc);
    assert_eq!(refs.len(), 5);
    let stored: BTreeSet<Hash> = svc.objects(&COL).into_iter().map(|(h, _)| h).collect();
    // The chunk lost to the outage was never stored, so nothing is orphaned.
    assert_eq!(refs.iter().copied().collect::<BTreeSet<_>>(), stored);
    assert_eq!(read_back(&a, &svc, &entry), *bytes);
}

#[test]
fn resume_refuses_a_changed_source() {
    let svc = FakeLogService::new();
    let mut a = attach_node(&svc, 1);
    let bytes = Rc::new(data(2 * CHUNK + 5));
    let m =
        a.r.start_attachment_upload(
            params("files/changed.bin"),
            Box::new(Source {
                bytes: bytes.clone(),
                reads: Rc::default(),
            }),
        )
        .unwrap();
    let calls: Calls = Rc::default();
    let mut puts = 0;
    drive(&mut a, &calls, &mut |req, _| {
        if matches!(req, LogRequest::PutObject { .. }) {
            puts += 1;
            if puts > 1 {
                return Some(Err(crate::log::LogError::Offline));
            }
        }
        None
    });
    let checkpoint = a.r.attachment_upload_checkpoint(&m).unwrap();
    a.r.close_attachment_upload(&m);
    let mut edited = (*bytes).clone();
    edited[10] ^= 1;
    a.r.resume_attachment_upload(
        checkpoint,
        Box::new(Source {
            bytes: Rc::new(edited),
            reads: Rc::default(),
        }),
    )
    .unwrap();
    drive(&mut a, &calls, &mut |_, _| None);
    let AttachmentUploadStatus::Failed(p) = status(&a, &m) else {
        panic!("a changed source must not be described by the old manifest");
    };
    assert_eq!(p.reason.as_deref(), Some("source_changed"));
    assert!(a.r.store().pending_get(&m).unwrap().is_none());
}

#[test]
fn objects_missing_at_the_final_check_are_sent_again() {
    let svc = FakeLogService::new();
    let mut a = attach_node(&svc, 1);
    let bytes = Rc::new(data(CHUNK + 3));
    let m =
        a.r.start_attachment_upload(
            params("files/gc.bin"),
            Box::new(Source {
                bytes: bytes.clone(),
                reads: Rc::default(),
            }),
        )
        .unwrap();
    let calls: Calls = Rc::default();
    let mut dropped = false;
    drive(&mut a, &calls, &mut |req, svc| {
        if let LogRequest::HasObjects { addresses, .. } = req
            && addresses.len() == 3
            && !dropped
        {
            // A chunk vanished (say, collected) before the final check.
            dropped = true;
            let victim = svc
                .objects(&COL)
                .into_iter()
                .map(|(h, _)| h)
                .find(|h| addresses.contains(h))
                .unwrap();
            svc.forget_object(&COL, &victim);
        }
        None
    });
    assert!(dropped);
    assert!(matches!(
        status(&a, &m),
        AttachmentUploadStatus::Captured(_)
    ));
    let (entry, refs) = last_entry(&a, &svc);
    let stored: BTreeSet<Hash> = svc.objects(&COL).into_iter().map(|(h, _)| h).collect();
    assert!(refs.iter().all(|r| stored.contains(r)));
    assert_eq!(read_back(&a, &svc, &entry), *bytes);
}

#[test]
fn over_the_cap_is_refused_before_anything_is_read_or_sent() {
    let svc = FakeLogService::new();
    let mut a = attach_node(&svc, 1);
    let before = svc.items(&COL).len();
    let e =
        a.r.start_attachment_upload(
            params("files/huge.bin"),
            Box::new(Unreadable((1 << 30) + 1)),
        )
        .unwrap_err();
    assert_eq!(e.problem().code, "too_large");
    assert_eq!(e.problem().reason.as_deref(), Some("attachment_too_large"));
    assert!(a.r.take_log_calls().is_empty());
    assert!(svc.objects(&COL).is_empty());
    assert_eq!(svc.items(&COL).len(), before);
}

#[test]
fn record_paths_and_local_only_are_refused_up_front() {
    let svc = FakeLogService::new();
    let mut a = attach_node(&svc, 1);
    let e =
        a.r.start_attachment_upload(params("notes/big.md"), Box::new(Unreadable(10)))
            .unwrap_err();
    assert_eq!(e.problem().reason.as_deref(), Some("not_a_file_path"));
    a.r.cfg.mode = mdbn_wire::client::SyncMode::LocalOnly;
    let e =
        a.r.start_attachment_upload(params("files/x.bin"), Box::new(Unreadable(10)))
            .unwrap_err();
    assert_eq!(e.problem().code, "upgrade_required");
    assert!(a.r.take_log_calls().is_empty());
}

#[test]
fn pending_row_codec_keeps_legacy_bytes_and_round_trips_refs() {
    let svc = FakeLogService::new();
    let mut a = attach_node(&svc, 1);
    let bytes = Rc::new(data(5));
    let m =
        a.r.start_attachment_upload(
            params("files/tiny.bin"),
            Box::new(Source {
                bytes,
                reads: Rc::default(),
            }),
        )
        .unwrap();
    // Capture without letting the append through.
    a.log.faults.offline = false;
    let calls: Calls = Rc::default();
    drive(&mut a, &calls, &mut |req, _| {
        matches!(req, LogRequest::Append(_)).then_some(Err(crate::log::LogError::Offline))
    });
    let row = a.r.store().pending_get(&m).unwrap().unwrap();
    assert_eq!(row.refs.len(), 2, "one chunk and the manifest");
    let back = crate::store::PendingRow::from_bytes(&row.to_bytes()).unwrap();
    assert_eq!(back, row);
    assert!(crate::replica::attachment_upload::check_row_refs(&row).is_ok());
    let mut unsorted = row.clone();
    unsorted.refs.reverse();
    assert!(crate::replica::attachment_upload::check_row_refs(&unsorted).is_err());
    let mut partial = row.clone();
    partial.refs.retain(|r| {
        let rt::Op::FileAttach(f) = &row.mutation.ops[0] else {
            unreachable!()
        };
        *r != f.content.reference.manifest_cipher_hash
    });
    assert!(crate::replica::attachment_upload::check_row_refs(&partial).is_err());

    // A row without refs keeps the earlier six-element bytes.
    let mut legacy = row.clone();
    legacy.refs.clear();
    let c = mdbn_wire::cbor::decode(&legacy.to_bytes()).unwrap();
    assert!(matches!(c, mdbn_wire::cbor::Cbor::Array(ref a) if a.len() == 6));
}

#[test]
fn plain_submit_still_cannot_carry_file_attach() {
    // The client submit union is the legacy operation union: no Op13 decodes.
    let entry = rt::EntryPayload::from_bytes(include_bytes!(
        "../../../../conformance/wire/entry/runtime-v1-mixed.cbor"
    ))
    .unwrap();
    let op = entry
        .mutation
        .ops
        .iter()
        .find(|o| matches!(o, rt::Op::FileAttach(_)))
        .unwrap()
        .to_cbor();
    assert!(
        mdbn_wire::intent::Op::from_cbor(&op)
            .unwrap_err()
            .is_unknown()
    );
}
