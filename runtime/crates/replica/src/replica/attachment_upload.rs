//! Attachment-v1 upload and emit (`intent.md` §3.9, §3.11): the replica drives
//! the streaming [`AttachmentWriter`] over a bounded host reader, stores every
//! sealed chunk and then the manifest through the log's object store, and only
//! then captures a `file_attach` whose entry lists the complete object refs.
//!
//! ```text
//!  start ──► Probe (resume only: has_objects of the recorded chunks)
//!              │
//!              ▼
//!            Chunks: read ≤ 8 MiB ─► adopt (stored) | seal ─► put_object ─► next
//!              │       unknown outcome / transient error ─► has_objects ─► re-seal if absent
//!              ▼
//!            Manifest: authenticate own manifest ─► put_object (last)
//!              │
//!              ▼
//!            Verify: has_objects(every ref) ─► missing? back to Chunks, keeping the rest
//!              │
//!              ▼
//!            Capture: re-check write authority, plan, pending row with refs ─► append loop
//! ```
//!
//! - **Bounded memory.** One plaintext chunk (≤ 8 MiB, wiped) and one sealed chunk
//!   (≤ 9 MiB, owned by the queued call) at a time on the device FIFO. Delegated
//!   hosted uploads progress independently under bounded native admission; the
//!   fixed-region driver queues no file bodies. The whole file is never buffered.
//! - **Refs.** `Item.refs` is the sorted, distinct union of the CIPHERTEXT chunk
//!   Item hashes and the manifest Item hash, taken from the writer's own manifest
//!   after it authenticated (`log-entry.md` §2.1). Plaintext chunk hashes stay in
//!   the encrypted manifest. At most [`MAX_REFS`] (1 GiB: 128 chunks + 1).
//! - **Objects.** Attachment objects are complete kind-18 Items (`chunked_blob`),
//!   stored by their SHA-256 with `put_object`; the transport performs the staged
//!   direct PUT and `commit_object` for anything over 1 MiB (no multipart).
//! - **Resume.** A stored object is never sealed twice: an unknown outcome or a
//!   transient error asks `has_objects` before re-sealing, and a host that
//!   persisted an [`AttachmentUploadCheckpoint`] resumes after a restart. Chunks
//!   are re-read either way, so the signed whole-file hash covers every byte and a
//!   changed source is refused.
//! - **Authority.** Upload precedes append. Collection mode, write permission and
//!   the CURRENT write epoch are checked at start and again at capture, after
//!   every await; a rekey in between restarts the upload under the new epoch.
//!   Plain `submit` still refuses `file_attach`; this is the only way to emit it.
//!
//! Not here: applying `put_attachment_file` (T5; until then a build that appends
//! one stalls on it as `attachment_apply_not_yet`, like every other replica),
//! store-file ingest (T6) and the app upload API (T10).

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use mdbn_wire::attachment::{
    AttachmentContentV1, AttachmentRefV1 as WireRef, FileAttach, FileContent,
};
use mdbn_wire::attachment_runtime_v1 as rt;
use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::client::{Problem, Receipt};
use mdbn_wire::common::{B32, Hash, Uuid};
use mdbn_wire::envelope::ItemKind;
use mdbn_wire::intent::{Level, OpClock, Source};
use mdbn_wire::schema::Wire;
use zeroize::Zeroizing;

use super::Replica;
use crate::api::{ApiError, ApiResult, ErrorCode};
use crate::attachments::{AttachmentWriter, StreamError};
use crate::convert;
use crate::crypto::chunked_blob::{
    AttachmentContextV1, AttachmentLimits, AttachmentRefV1, CHUNK_BYTES, ChunkRefV1, ExpectedFileV1,
};
use crate::log::{CallId, LogError, LogErrorCode, LogReply, LogRequest, LogResponse};
use crate::store::{PendingRow, Store, Tx, meta_keys};

mod hosted_limits;
use hosted_limits::HostedLifetime;
mod region_upload;
pub use region_upload::{HostedAttachmentTransferParams, HostedAttachmentTransferProgress};

/// Largest `refs` list on one item (`log-entry.md` §10).
pub const MAX_REFS: usize = 1024;

/// How many times an upload goes back for objects that went missing before it
/// gives up (a log that keeps losing fresh objects is not retried forever).
const MAX_ROUNDS: u32 = 3;

/// How many `refs_missing` refusals a captured attachment row takes before it
/// fails terminally. Its objects never come back on their own (the log collects
/// unreferenced objects after its grace period; v1 has no transfer lease), so a
/// second refusal is final; the first may be a transient service answer.
const MAX_REFS_MISSING: u32 = 2;

/// A host's bounded, positional reader of the file being uploaded.
pub trait AttachmentSource {
    /// The exact plaintext length. It must not change during the upload.
    fn len(&self) -> u64;
    /// Whether the file is empty.
    fn is_empty(&self) -> bool {
        self.len() == 0
    }
    /// Fill all of `buf` (never more than 8 MiB) with the bytes at `offset`. A
    /// short read, or any change to the file, is an error.
    fn read_at(&mut self, offset: u64, buf: &mut [u8]) -> Result<(), String>;
}

/// What to upload, and where it goes.
#[derive(Debug, Clone, PartialEq)]
pub struct AttachmentUploadParams {
    /// Stable File ID: a new ID creates the file, a live File's ID replaces its
    /// content (v1 re-uploads the whole file).
    pub file: Uuid,
    /// The exact file path.
    pub path: String,
    /// Compare-and-swap on the current whole-plaintext revision.
    pub if_revision: Option<Hash>,
    /// The mutation ID; minted when absent. It names the upload.
    pub mutation: Option<Uuid>,
}

/// Where an upload stands.
#[derive(Debug, Clone, PartialEq)]
pub enum AttachmentUploadStatus {
    /// Storing objects: `stored` of `total` (every chunk, then the manifest).
    Uploading {
        /// Objects stored (or found already stored).
        stored: u64,
        /// Objects in the upload.
        total: u64,
    },
    /// Every object is stored and the `file_attach` is captured: pending until
    /// the append loop confirms it.
    Captured(Receipt),
    /// A later external save was collected into a device-local hold, not a
    /// mutation or receipt. Its exact bytes remain on disk; resolving them
    /// requires a fresh upload (unreferenced objects may expire).
    Held {
        /// Held file identity.
        file: Uuid,
    },
    /// Stopped before capture. Objects already stored are unreferenced; the log
    /// service collects them after its grace period.
    Failed(Problem),
}

/// Everything needed to resume an upload after a restart. Persist it locally
/// only: it holds plaintext chunk hashes (never sent anywhere).
#[derive(Debug, Clone, PartialEq)]
pub struct AttachmentUploadCheckpoint {
    mutation: Uuid,
    file: Uuid,
    path: String,
    if_revision: Option<Hash>,
    context: AttachmentContextV1,
    total: u64,
    chunks: Vec<ChunkRefV1>,
}

impl AttachmentUploadCheckpoint {
    /// The upload's mutation ID.
    pub fn mutation(&self) -> Uuid {
        self.mutation
    }

    /// The file ID and path it uploads, and the file's length.
    pub(crate) fn target(&self) -> (Uuid, &str, u64) {
        (self.file, &self.path, self.total)
    }

    /// Chunks recorded so far.
    pub(crate) fn chunk_count(&self) -> usize {
        self.chunks.len()
    }

    /// Canonical bytes, for the host to persist.
    pub fn to_bytes(&self) -> Vec<u8> {
        let h = |h: &Hash| Cbor::Bytes(h.0.to_vec());
        let c = Cbor::Array(vec![
            Cbor::Uint(1),
            self.mutation.to_cbor(),
            self.file.to_cbor(),
            Cbor::Text(self.path.clone()),
            self.if_revision.as_ref().map_or(Cbor::Null, h),
            self.context.collection.to_cbor(),
            Cbor::Uint(self.context.key_epoch),
            Cbor::Bytes(self.context.attachment_id.0.to_vec()),
            Cbor::Uint(self.total),
            Cbor::Array(
                self.chunks
                    .iter()
                    .map(|c| {
                        Cbor::Array(vec![
                            h(&c.cipher_hash),
                            Cbor::Uint(c.sealed_bytes),
                            h(&c.plain_hash),
                            Cbor::Uint(c.plain_bytes),
                        ])
                    })
                    .collect(),
            ),
        ]);
        cbor::encode(&c).unwrap_or_default()
    }

    /// Decode [`Self::to_bytes`].
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, mdbn_wire::schema::SchemaError> {
        use mdbn_wire::schema::SchemaError;
        let bad = |reason| SchemaError::Invalid {
            ty: "AttachmentUploadCheckpoint",
            reason,
        };
        let c = cbor::decode(bytes)?;
        let a = mdbn_wire::schema::array(&c, "AttachmentUploadCheckpoint")?;
        let [v, m, f, p, r, col, e, id, t, cs] = a else {
            return Err(bad("wrong number of elements"));
        };
        if u64::from_cbor(v)? != 1 {
            return Err(bad("version"));
        }
        let hash = |c: &Cbor| B32::from_cbor(c);
        let path = match p {
            Cbor::Text(s) => s.clone(),
            _ => return Err(bad("path")),
        };
        let chunks = mdbn_wire::schema::array(cs, "chunks")?
            .iter()
            .map(|c| {
                let [ch, sb, ph, pb] = mdbn_wire::schema::array(c, "chunk")? else {
                    return Err(bad("chunk"));
                };
                Ok(ChunkRefV1 {
                    cipher_hash: hash(ch)?,
                    sealed_bytes: u64::from_cbor(sb)?,
                    plain_hash: hash(ph)?,
                    plain_bytes: u64::from_cbor(pb)?,
                })
            })
            .collect::<Result<Vec<_>, SchemaError>>()?;
        Ok(Self {
            mutation: Uuid::from_cbor(m)?,
            file: Uuid::from_cbor(f)?,
            path,
            if_revision: match r {
                Cbor::Null => None,
                r => Some(hash(r)?),
            },
            context: AttachmentContextV1 {
                collection: Uuid::from_cbor(col)?,
                key_epoch: u64::from_cbor(e)?,
                attachment_id: hash(id)?,
                chunk_bytes: CHUNK_BYTES,
            },
            total: u64::from_cbor(t)?,
            chunks,
        })
    }
}

/// The upload driver's state for one file.
enum Phase {
    /// Asking which recorded chunks are already stored.
    Probe,
    /// Reading, sealing and storing chunks.
    Chunks,
    /// Waiting for the bounded hosted region input or authenticated rehash.
    HostedChunks,
    /// Storing the manifest (after every chunk).
    Manifest,
    /// Confirming every ref is stored, just before capture.
    Verify,
    /// Finished.
    Done(Box<AttachmentUploadStatus>),
}

/// What an outstanding call was for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Call {
    /// `has_objects` of the recorded chunks.
    Probe,
    /// `put_object` of chunk `index` at `address`.
    PutChunk { index: u64, address: Hash },
    /// `has_objects` of one object whose put had no known outcome.
    Recheck { address: Hash },
    /// `put_object` of the manifest.
    PutManifest,
    /// `has_objects` of every ref.
    Verify,
    /// Native LS confirmation of the externally staged sealed chunk, NOT a host boolean.
    HostedVerifyChunk { address: Hash },
    /// Storing encrypted resume metadata only AFTER native confirmed chunk storage.
    HostedPutResume {
        reference: crate::crypto::chunked_blob::upload_resume::UploadResumeRefV1,
        chunks: u64,
        expires_at_ms: u64,
    },
}

/// The sealed, self-authenticated manifest and what the entry needs from it.
struct Finished {
    bytes: Vec<u8>,
    descriptor: AttachmentRefV1,
    expected: ExpectedFileV1,
    refs: Vec<Hash>,
}

struct Upload {
    mutation: Uuid,
    params: AttachmentUploadParams,
    source: Option<Box<dyn AttachmentSource>>,
    total: u64,
    limits: AttachmentLimits,
    writer: Option<AttachmentWriter>,
    /// The writer before the chunk whose put is outstanding: restored when that
    /// object turns out not to be stored, so only that chunk is sealed again.
    before: Option<AttachmentWriter>,
    /// Chunk objects an earlier attempt sealed, by index, and whether each is
    /// known to be stored.
    recorded: Vec<(ChunkRefV1, bool)>,
    finished: Option<Finished>,
    phase: Phase,
    /// The outstanding call, if any.
    call: Option<(CallId, Call)>,
    /// A put whose outcome must be checked before going on.
    unsure: Option<Call>,
    retry_at: Option<i64>,
    rounds: u32,
    /// Who asked for it, and what the capture commits with it.
    origin: Origin,
    /// Only the new fixed-region hosted driver; never device/owned/external.
    hosted: Option<region_upload::HostedRegion>,
    /// Delegated native admission only; persists through terminal slot retention.
    lifetime: Option<HostedLifetime>,
}

/// Who started an upload. An app upload is an `api` write; ingest of a file
/// edited on disk is an `external` write with its capture base, and its capture
/// acknowledges the store's observation (recording that the disk holds exactly
/// the uploaded content) and retires the persisted checkpoint atomically.
#[derive(Debug, Clone, Default)]
pub(crate) struct Origin {
    /// Native-owned app authorization; never populated on device/external paths.
    pub(crate) delegated: Option<super::hosted_attachment_upload::DelegatedAttachmentCreate>,
    pub(crate) external: bool,
    /// Device-local hold generation selected before opening the source. Never
    /// populated by API/delegated inputs; changes across awaits refuse capture.
    pub(crate) held: Option<Hash>,
    pub(crate) base: Option<Hash>,
    pub(crate) acks: Vec<crate::store::ObservationId>,
    pub(crate) meta: Vec<crate::store::MetaPut>,
}

impl Upload {
    fn chunk_count(&self) -> u64 {
        self.total.div_ceil(u64::from(CHUNK_BYTES)).max(1)
    }

    fn status(&self) -> AttachmentUploadStatus {
        match &self.phase {
            Phase::Done(s) => (**s).clone(),
            _ => {
                let chunks = match &self.writer {
                    Some(w) => w.chunks().len() as u64,
                    None => self.recorded.len() as u64,
                };
                let in_flight = matches!(self.call, Some((_, Call::PutChunk { .. })))
                    || matches!(self.unsure, Some(Call::PutChunk { .. }));
                let chunks = match &self.hosted {
                    Some(h) => h.committed_chunks,
                    None => chunks - u64::from(in_flight && chunks > 0),
                };
                let manifest = u64::from(matches!(self.phase, Phase::Verify));
                AttachmentUploadStatus::Uploading {
                    stored: chunks + manifest,
                    total: self.chunk_count() + 1,
                }
            }
        }
    }

    fn checkpoint(&self) -> Option<AttachmentUploadCheckpoint> {
        if matches!(self.phase, Phase::Done(_)) {
            return None;
        }
        let (context, chunks) = match (&self.writer, &self.finished) {
            (Some(w), _) => {
                // Recorded chunks not yet re-adopted stay in the checkpoint.
                let mut chunks: Vec<ChunkRefV1> = w.chunks().to_vec();
                chunks.extend(self.recorded.iter().skip(chunks.len()).map(|(c, _)| *c));
                (w.context(), chunks)
            }
            // Sealed: the manifest's chunks (the manifest is sealed again).
            (None, Some(f)) => (
                f.descriptor.context,
                self.recorded.iter().map(|(c, _)| *c).collect(),
            ),
            (None, None) => return None,
        };
        Some(AttachmentUploadCheckpoint {
            mutation: self.mutation,
            file: self.params.file,
            path: self.params.path.clone(),
            if_revision: self.params.if_revision,
            context,
            total: self.total,
            chunks,
        })
    }

    fn fail(&mut self, problem: Problem) {
        self.source = None;
        self.writer = None;
        self.before = None;
        self.recorded.clear();
        self.finished = None;
        self.call = None;
        self.unsure = None;
        self.retry_at = None;
        self.hosted = None;
        self.phase = Phase::Done(Box::new(AttachmentUploadStatus::Failed(problem)));
    }
}

/// Device/external uploads retain FIFO; bounded delegated uploads drive independently.
#[derive(Default)]
pub(crate) struct Uploads {
    map: BTreeMap<Uuid, Upload>,
    queue: VecDeque<Uuid>,
    /// Captured attachment rows the log refused as `refs_missing`, and how often.
    refs_missing: BTreeMap<Uuid, u32>,
}

impl Uploads {
    /// All delegated deadlines/retries plus the first device/external retry.
    pub(crate) fn next_wakeup(&self) -> Option<i64> {
        let native = self
            .queue
            .iter()
            .filter_map(|id| self.map.get(id))
            .find(|up| up.origin.delegated.is_none())
            .and_then(|up| up.retry_at);
        self.map
            .values()
            .filter(|up| up.origin.delegated.is_some())
            .flat_map(|up| [up.hosted_deadline(), up.retry_at])
            .flatten()
            .chain(native)
            .min()
    }
}

/// New attachment content carried by a trusted upload operation. Native kind
/// and authority are checked separately; this selects object-ref handling only.
fn uploaded_attachment(op: &rt::Op) -> Option<&AttachmentContentV1> {
    match op {
        rt::Op::FileAttach(f) => Some(&f.content),
        rt::Op::UnindexedMarkdownPut(f) => match &f.payload.content {
            FileContent::AttachmentV1(c) => Some(c),
            _ => None,
        },
        rt::Op::RecordToUnindexedMarkdown(f) => match &f.payload.content {
            FileContent::AttachmentV1(c) => Some(c),
            _ => None,
        },
        _ => None,
    }
}
/// Whether a pending row carries newly uploaded attachment objects.
pub(crate) fn attaches(m: &rt::Mutation) -> bool {
    m.ops.iter().any(|o| uploaded_attachment(o).is_some())
}
/// Native14–16 always need the critical runtime family, including reverse16
/// and legacy Blob content. This is codec selection, never authority.
pub(crate) fn native(m: &rt::Mutation) -> bool {
    m.ops.iter().any(|o| {
        matches!(
            o,
            rt::Op::UnindexedMarkdownPut(_)
                | rt::Op::RecordToUnindexedMarkdown(_)
                | rt::Op::UnindexedMarkdownToRecord(_)
        )
    })
}

/// The refs a captured attachment row carries are complete and well formed:
/// sorted, distinct, at most [`MAX_REFS`], and naming the manifest of its one
/// `file_attach`. Anything else is a bug, never a partial inventory.
pub(crate) fn check_row_refs(row: &PendingRow) -> ApiResult<()> {
    let bad = |m: &str| ErrorCode::Internal.err(format!("attachment refs: {m}"));
    let attaches: Vec<&AttachmentContentV1> = row
        .mutation
        .ops
        .iter()
        .filter_map(uploaded_attachment)
        .collect();
    let [one] = attaches.as_slice() else {
        return Err(bad("one file_attach per mutation"));
    };
    if row.mutation.ops.len() != 1 {
        return Err(bad("file_attach is the only operation"));
    }
    if row.refs.is_empty() || row.refs.len() > MAX_REFS {
        return Err(bad("count"));
    }
    if !row.refs.windows(2).all(|w| w[0] < w[1]) {
        return Err(bad("not sorted and distinct"));
    }
    if row
        .refs
        .binary_search(&one.reference.manifest_cipher_hash)
        .is_err()
    {
        return Err(bad("manifest missing"));
    }
    Ok(())
}

/// The canonical runtime-family payload of an attachment row.
pub(crate) fn entry_plain(
    mutation: rt::Mutation,
    planned: &mdbn_core::plan::Planned,
    resurrect: Option<u64>,
) -> ApiResult<Vec<u8>> {
    entry_payload(mutation, planned, resurrect)?
        .to_bytes()
        .map_err(|_| ErrorCode::InvalidRequest.err("result does not encode"))
}

pub(crate) fn entry_payload(
    mutation: rt::Mutation,
    planned: &mdbn_core::plan::Planned,
    resurrect: Option<u64>,
) -> ApiResult<rt::EntryPayload> {
    let effects = planned
        .effects
        .iter()
        .map(convert::wruntime_effect)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| ApiError::from(super::unencodable_result(&e)))?;
    let conflicts = if planned.conflicts.is_empty() {
        None
    } else {
        Some(
            planned
                .conflicts
                .iter()
                .map(convert::wruntime_conflict)
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| ApiError::from(super::unencodable_result(&e)))?,
        )
    };
    Ok(rt::EntryPayload {
        sem: mdbn_wire::common::Version {
            major: planned.sem.major,
            minor: planned.sem.minor,
        },
        mutation,
        status: convert::wstatus(planned.status),
        effects,
        conflicts,
        aliases: if planned.aliases.is_empty() {
            None
        } else {
            Some(planned.aliases.iter().map(convert::walias).collect())
        },
        texts: None,
        resurrect,
    })
}

fn stream_problem(e: &StreamError) -> Problem {
    match e {
        StreamError::TooLarge => ErrorCode::TooLarge.problem_with_reason(
            "attachment_too_large",
            "the file exceeds the attachment cap",
        ),
        StreamError::NoKey => ErrorCode::Unavailable.problem_with_reason(
            "waiting_for_key",
            "no current write key for this collection",
        ),
        StreamError::Protocol("adopted chunk does not match") => ErrorCode::Conflict
            .problem_with_reason("source_changed", "the file changed during the upload"),
        StreamError::Sink(m) => ErrorCode::Unavailable.problem(format!("read: {m}")),
        StreamError::Corrupt(m) | StreamError::Protocol(m) => {
            ErrorCode::Internal.problem(format!("attachment writer: {m}"))
        }
    }
}

/// The sorted, distinct ref union of an authenticated manifest.
fn refs_of(chunks: &[ChunkRefV1], manifest: Hash) -> ApiResult<Vec<Hash>> {
    let set: BTreeSet<Hash> = chunks
        .iter()
        .map(|c| c.cipher_hash)
        .chain(std::iter::once(manifest))
        .collect();
    if set.len() != chunks.len() + 1 {
        return Err(ErrorCode::Internal.err("attachment objects share an address"));
    }
    if set.len() > MAX_REFS {
        return Err(ErrorCode::TooLarge
            .err_with_reason("attachment_too_large", "too many attachment objects"));
    }
    Ok(set.into_iter().collect())
}

fn wire_ref(r: &AttachmentRefV1) -> WireRef {
    WireRef {
        collection: r.context.collection,
        key_epoch: r.context.key_epoch,
        attachment_id: r.context.attachment_id,
        manifest_cipher_hash: r.manifest_cipher_hash,
    }
}

impl<S: Store> Replica<S> {
    /// Start uploading one file as an attachment. The replica reads it in chunks
    /// of at most 8 MiB with [`AttachmentSource::read_at`], stores every sealed
    /// object, and then captures the `file_attach`. Drive it as usual (log calls,
    /// [`Replica::tick`]); [`Self::attachment_upload_status`] reports progress.
    /// Returns the upload's mutation ID.
    ///
    /// Refused up front (nothing read or stored) when this replica cannot write an
    /// attachment to a synced log now, the path is not a file path, or the file is
    /// over the 1 GiB cap.
    pub fn start_attachment_upload(
        &mut self,
        params: AttachmentUploadParams,
        source: Box<dyn AttachmentSource>,
    ) -> ApiResult<Uuid> {
        self.start_upload_with(params, source, Origin::default())
    }

    pub(crate) fn start_upload_with(
        &mut self,
        params: AttachmentUploadParams,
        source: Box<dyn AttachmentSource>,
        origin: Origin,
    ) -> ApiResult<Uuid> {
        if origin.delegated.is_none() {
            self.attachment_upload_admission(&params.path)?;
        }
        let total = source.len();
        if let Some(context) = &origin.delegated {
            self.hosted_attachment_create_check(context, &params.path, total, &params.file)?;
            if params.if_revision.is_some() || origin.external || origin.base.is_some() {
                return Err(ErrorCode::UpgradeRequired.err_with_reason(
                    "attachment_replace_requires_op18",
                    "hosted attachment replacement is unsupported until Op18",
                ));
            }
            self.hosted_upload_capacity(context.grant())?;
        }
        let limits = AttachmentLimits::default();
        if total > limits.max_file_bytes {
            return Err(stream_problem(&StreamError::TooLarge).into());
        }
        let mutation = match params.mutation {
            Some(id) => {
                if self.attachment_uploads.map.contains_key(&id)
                    || self.receipt_exists(&id).map_err(super::submit::store_err)?
                {
                    return Err(ErrorCode::InvalidRequest
                        .err_with_reason("mutation_id_in_use", "this mutation ID is in use"));
                }
                id
            }
            None => self.mint_v7(),
        };
        let writer = AttachmentWriter::new(
            &*self.sealer,
            self.cfg.collection,
            total,
            limits,
            self.host.entropy.as_mut(),
        )
        .map_err(|e| stream_problem(&e))?;
        let params = AttachmentUploadParams {
            mutation: Some(mutation),
            ..params
        };
        let lifetime = origin
            .delegated
            .as_ref()
            .map(|_| HostedLifetime::new(self.now(), self.region_expiry()));
        self.attachment_uploads.map.insert(
            mutation,
            Upload {
                mutation,
                params,
                source: Some(source),
                total,
                limits,
                writer: Some(writer),
                before: None,
                recorded: Vec::new(),
                finished: None,
                phase: Phase::Chunks,
                call: None,
                unsure: None,
                retry_at: None,
                rounds: 0,
                origin,
                hosted: None,
                lifetime,
            },
        );
        self.attachment_uploads.queue.push_back(mutation);
        self.attachment_upload_step();
        Ok(mutation)
    }

    /// Resume an upload from a checkpoint the host persisted, over the same file.
    /// Chunks the log already stores are re-read and verified, never sealed or
    /// sent again. A checkpoint from another epoch starts over under the current
    /// one. An already captured upload reports its receipt.
    pub fn resume_attachment_upload(
        &mut self,
        checkpoint: AttachmentUploadCheckpoint,
        source: Box<dyn AttachmentSource>,
    ) -> ApiResult<Uuid> {
        self.resume_upload_with(checkpoint, source, Origin::default())
    }

    pub(crate) fn resume_upload_with(
        &mut self,
        checkpoint: AttachmentUploadCheckpoint,
        source: Box<dyn AttachmentSource>,
        origin: Origin,
    ) -> ApiResult<Uuid> {
        let mutation = checkpoint.mutation;
        if self.attachment_uploads.map.contains_key(&mutation) {
            return Err(ErrorCode::InvalidRequest
                .err_with_reason("mutation_id_in_use", "this upload is already running"));
        }
        if let Some(r) = self
            .known_receipt_for(&mutation, None)
            .map_err(super::submit::store_err)?
        {
            self.attachment_uploads.map.insert(
                mutation,
                Upload {
                    mutation,
                    params: AttachmentUploadParams {
                        file: checkpoint.file,
                        path: checkpoint.path.clone(),
                        if_revision: checkpoint.if_revision,
                        mutation: Some(mutation),
                    },
                    source: None,
                    total: checkpoint.total,
                    limits: AttachmentLimits::default(),
                    writer: None,
                    before: None,
                    recorded: Vec::new(),
                    finished: None,
                    phase: Phase::Done(Box::new(AttachmentUploadStatus::Captured(r))),
                    call: None,
                    unsure: None,
                    retry_at: None,
                    rounds: 0,
                    origin,
                    hosted: None,
                    lifetime: None,
                },
            );
            return Ok(mutation);
        }
        self.attachment_upload_admission(&checkpoint.path)?;
        if source.len() != checkpoint.total {
            return Err(ErrorCode::Conflict
                .err_with_reason("source_changed", "the file changed since the checkpoint"));
        }
        let limits = AttachmentLimits::default();
        let same = checkpoint.context.collection == self.cfg.collection;
        let (writer, recorded, phase) = match AttachmentWriter::resume(
            &*self.sealer,
            checkpoint.context,
            checkpoint.total,
            limits,
        ) {
            Ok(w) if same && !checkpoint.chunks.is_empty() => (
                w,
                checkpoint.chunks.iter().map(|c| (*c, false)).collect(),
                Phase::Probe,
            ),
            Ok(w) if same => (w, Vec::new(), Phase::Chunks),
            // Another epoch (a rekey since) or collection: start over.
            _ => (
                AttachmentWriter::new(
                    &*self.sealer,
                    self.cfg.collection,
                    checkpoint.total,
                    limits,
                    self.host.entropy.as_mut(),
                )
                .map_err(|e| stream_problem(&e))?,
                Vec::new(),
                Phase::Chunks,
            ),
        };
        self.attachment_uploads.map.insert(
            mutation,
            Upload {
                mutation,
                params: AttachmentUploadParams {
                    file: checkpoint.file,
                    path: checkpoint.path,
                    if_revision: checkpoint.if_revision,
                    mutation: Some(mutation),
                },
                source: Some(source),
                total: checkpoint.total,
                limits,
                writer: Some(writer),
                before: None,
                recorded,
                finished: None,
                phase,
                call: None,
                unsure: None,
                retry_at: None,
                rounds: 0,
                origin,
                hosted: None,
                lifetime: None,
            },
        );
        self.attachment_uploads.queue.push_back(mutation);
        self.attachment_upload_step();
        Ok(mutation)
    }

    /// Repeat native authority before a hosted adapter's asynchronous effect.
    /// The adapter must also fence its own engine/session/live admission. This
    /// does not authorize output or unrelated transfers and exposes no content.
    pub fn recheck_hosted_attachment_upload(
        &self,
        session: crate::api::SessionId,
        mutation: &Uuid,
    ) -> ApiResult<()> {
        let up = self
            .attachment_uploads
            .map
            .get(mutation)
            .ok_or_else(|| ErrorCode::Unavailable.err("the hosted upload is not active"))?;
        let context = up
            .origin
            .delegated
            .as_ref()
            .ok_or_else(|| ErrorCode::Forbidden.err("not a delegated hosted upload"))?;
        self.hosted_attachment_upload_caller_check(session, context)?;
        if matches!(up.phase, Phase::Done(_)) {
            return Err(ErrorCode::Unavailable.err("the hosted upload is not active"));
        }
        if up.hosted.is_some() {
            return self.region_check(session, up);
        }
        self.hosted_upload_lifetime_check(up)?;
        self.hosted_attachment_create_check(context, &up.params.path, up.total, &up.params.file)
    }

    /// Where an upload stands, until it is closed. Host-adapter access only;
    /// delegated client output must use current session and owner-scoped receipts.
    pub fn attachment_upload_status(&self, mutation: &Uuid) -> Option<AttachmentUploadStatus> {
        self.attachment_uploads.map.get(mutation).map(|up| {
            if !matches!(up.phase, Phase::Done(_))
                && let Err(error) = self.hosted_upload_lifetime_check(up)
            {
                return AttachmentUploadStatus::Failed(error.into_problem());
            }
            up.status()
        })
    }

    /// A device-local checkpoint, never a hosted DO journal: it contains
    /// plaintext chunk hashes. Delegated uploads require a separate metadata-only
    /// sealed-boundary resume implementation and therefore return `None` here.
    pub fn attachment_upload_checkpoint(
        &self,
        mutation: &Uuid,
    ) -> Option<AttachmentUploadCheckpoint> {
        self.attachment_uploads
            .map
            .get(mutation)
            .filter(|up| up.origin.delegated.is_none())
            .and_then(Upload::checkpoint)
    }

    /// Stop an upload (if running) and forget it. A captured `file_attach` is not
    /// withdrawn. Returns whether there was such an upload.
    pub fn close_attachment_upload(&mut self, mutation: &Uuid) -> bool {
        // Legacy device/external API must never be a mutation-ID-only backdoor
        // into grant-owned hosted work. Hosted cleanup uses the caller-bound API.
        if self
            .attachment_uploads
            .map
            .get(mutation)
            .is_some_and(|up| up.origin.delegated.is_some())
        {
            return false;
        }
        self.remove_attachment_upload(mutation)
    }

    /// Exact authenticated owner-session cleanup, including terminal/refused
    /// work. Does not withdraw a captured mutation or certify an unknown abort.
    pub fn close_hosted_attachment_upload(
        &mut self,
        session: crate::api::SessionId,
        mutation: &Uuid,
    ) -> ApiResult<bool> {
        let Some(up) = self.attachment_uploads.map.get(mutation) else {
            return Ok(false);
        };
        let context = up
            .origin
            .delegated
            .as_ref()
            .ok_or_else(|| ErrorCode::Forbidden.err("not a delegated hosted upload"))?;
        self.hosted_attachment_upload_caller_check(session, context)?;
        Ok(self.remove_attachment_upload(mutation))
    }

    fn remove_attachment_upload(&mut self, mutation: &Uuid) -> bool {
        self.attachment_uploads.queue.retain(|m| m != mutation);
        match self.attachment_uploads.map.remove(mutation) {
            Some(mut up) => {
                self.retire_upload_call(&mut up);
                true
            }
            None => false,
        }
    }

    /// Whether this replica may write an attachment now: a synced device log,
    /// write permission under the current epoch with its key held, a file path.
    fn attachment_upload_admission(&self, path: &str) -> ApiResult<()> {
        let me = self.cfg.device_id;
        if self.is_hosted() {
            return Err(ErrorCode::UpgradeRequired.err_with_reason(
                "attachment_write_unsupported",
                "the hosted replica does not upload attachments",
            ));
        }
        if self.local_only() {
            return Err(ErrorCode::UpgradeRequired.err_with_reason(
                "attachment_write_unsupported",
                "attachments need a synced collection",
            ));
        }
        if !self.policy.device_can_write(&me) {
            return Err(ErrorCode::Forbidden.err("this device cannot write this collection"));
        }
        if self.key_untrusted
            || self.policy.frozen
            || self.policy.rekey_required
            || self.sealer.current_epoch() != Some(self.policy.epoch)
        {
            return Err(ErrorCode::Unavailable.err_with_reason(
                "waiting_for_key",
                "no current write key for this collection",
            ));
        }
        let c = &self.catalog;
        if c.is_record_path(path) || c.is_resource_path(path) || c.is_excluded(path) {
            return Err(ErrorCode::InvalidRequest.err_with_reason(
                "not_a_file_path",
                format!("`{path}` is a record or resource path, or excluded"),
            ));
        }
        Ok(())
    }

    /// A reply to an upload's call.
    pub(crate) fn on_attachment_reply(&mut self, mutation: Uuid, id: CallId, reply: LogReply) {
        let Some(mut up) = self.attachment_uploads.map.remove(&mutation) else {
            return;
        };
        match up.call {
            Some((c, call)) if c == id => {
                up.call = None;
                let known = reply.is_ok();
                self.attachment_reply(&mut up, call, reply);
                if known
                    && !matches!(up.phase, Phase::Done(ref status) if matches!(**status, AttachmentUploadStatus::Failed(_)))
                    && let Some(lifetime) = &mut up.lifetime
                {
                    lifetime.progress(self.now());
                }
            }
            _ => {} // stale
        }
        self.attachment_uploads.map.insert(mutation, up);
    }

    fn attachment_reply(&mut self, up: &mut Upload, call: Call, reply: LogReply) {
        // Known refusal/unknown outcome semantics retain priority. Successful
        // late replies may neither advance progress nor initiate further effects.
        if reply.is_ok()
            && let Err(error) = self.hosted_upload_lifetime_check(up)
        {
            return up.fail(error.into_problem());
        }
        if matches!(
            call,
            Call::HostedVerifyChunk { .. } | Call::HostedPutResume { .. }
        ) {
            return self.hosted_region_reply(up, call, reply);
        }
        let retry = |r: &Self, after: Option<u64>| {
            r.now()
                .saturating_add(i64::try_from(after.unwrap_or(r.tuning.retry_ms)).unwrap_or(0))
        };
        match (call, reply) {
            (Call::PutChunk { .. } | Call::PutManifest, Ok(LogResponse::PutObject { .. })) => {
                up.before = None;
                if call == Call::PutManifest {
                    up.phase = Phase::Verify;
                }
            }
            (Call::Probe, Ok(LogResponse::HasObjects(flags)))
                if flags.len() == up.recorded.len() =>
            {
                for ((_, present), f) in up.recorded.iter_mut().zip(flags) {
                    *present = f;
                }
                up.phase = Phase::Chunks;
            }
            (Call::Recheck { .. }, Ok(LogResponse::HasObjects(flags))) if flags.len() == 1 => {
                if flags[0] {
                    if let Some(Call::PutManifest) = up.unsure {
                        up.phase = Phase::Verify;
                    }
                    up.unsure = None;
                    up.before = None;
                } else if let Some(Call::PutChunk { .. }) = up.unsure.take() {
                    // Not stored: roll the writer back and seal that chunk again.
                    match up.before.take() {
                        Some(w) => up.writer = Some(w),
                        None => up.fail(ErrorCode::Internal.problem("attachment: no rollback")),
                    }
                }
                // A manifest not stored is simply sent again (same bytes).
            }
            (Call::Verify, Ok(LogResponse::HasObjects(flags))) => {
                let Some(f) = up.finished.as_ref() else {
                    return up.fail(ErrorCode::Internal.problem("attachment: no manifest"));
                };
                if flags.len() != f.refs.len() {
                    return up.fail(ErrorCode::Internal.problem("has_objects: wrong length"));
                }
                if flags.iter().all(|p| *p) {
                    self.capture_attachment(up);
                } else {
                    let missing: BTreeSet<Hash> = f
                        .refs
                        .iter()
                        .zip(&flags)
                        .filter(|(_, p)| !**p)
                        .map(|(h, _)| *h)
                        .collect();
                    self.restart_missing(up, &missing);
                }
            }
            (_, Ok(_)) => {
                up.fail(ErrorCode::Internal.problem("unexpected object store response"));
            }
            (call, Err(LogError::NoResponse)) => {
                // Outcome unknown: ask before sealing anything again.
                self.attachment_unsure(up, call);
            }
            (call, Err(LogError::Offline)) => {
                self.attachment_unsure(up, call);
                up.retry_at = Some(retry(self, None));
            }
            (
                call,
                Err(LogError::Service {
                    code,
                    retry_after_ms,
                    ..
                }),
            ) => match code {
                LogErrorCode::Unavailable
                | LogErrorCode::RateLimited
                | LogErrorCode::Unauthenticated
                | LogErrorCode::Frozen => {
                    self.attachment_unsure(up, call);
                    up.retry_at = Some(retry(self, retry_after_ms));
                }
                LogErrorCode::QuotaExceeded => up
                    .fail(ErrorCode::QuotaExceeded.problem("the log's storage quota is exhausted")),
                LogErrorCode::Forbidden => {
                    up.fail(ErrorCode::Forbidden.problem("the log refused the object"))
                }
                LogErrorCode::TooLarge => {
                    up.fail(ErrorCode::TooLarge.problem("the log refused the object as too large"))
                }
                other => up.fail(
                    ErrorCode::Internal
                        .problem(format!("the log refused the object: {}", other.as_str())),
                ),
            },
        }
    }

    /// A put (or check) without a known outcome: remember what to re-check.
    fn attachment_unsure(&mut self, up: &mut Upload, call: Call) {
        match call {
            Call::PutChunk { .. } | Call::PutManifest => up.unsure = Some(call),
            // A failed check is simply asked again; a failed probe, the same.
            Call::Recheck { .. } | Call::Probe | Call::Verify => {}
            Call::HostedVerifyChunk { .. } | Call::HostedPutResume { .. } => {
                up.fail(ErrorCode::Unavailable.problem_with_reason(
                    "hosted_upload_commit_unknown",
                    "the hosted boundary outcome is unknown; no progress is claimed",
                ))
            }
        }
    }

    /// Some refs are missing at the final check (an endpoint change, an early
    /// collection): go back for those chunks, keeping every stored one.
    fn restart_missing(&mut self, up: &mut Upload, missing: &BTreeSet<Hash>) {
        if up.hosted.is_some() {
            return up.fail(ErrorCode::Unavailable.problem_with_reason(
                "attachment_objects_missing",
                "the hosted upload's committed objects are missing; upload again",
            ));
        }
        up.rounds += 1;
        if up.rounds > MAX_ROUNDS {
            return up.fail(
                ErrorCode::Unavailable.problem("the log keeps losing this upload's objects"),
            );
        }
        let Some(f) = up.finished.take() else {
            return up.fail(ErrorCode::Internal.problem("attachment: no manifest"));
        };
        let context = f.descriptor.context;
        // The finished manifest listed every chunk in order.
        let chunks: Vec<ChunkRefV1> = std::mem::take(&mut up.recorded)
            .into_iter()
            .map(|(c, _)| c)
            .collect();
        match AttachmentWriter::resume(&*self.sealer, context, up.total, up.limits) {
            Ok(w) => {
                up.recorded = chunks
                    .into_iter()
                    .map(|c| (c, !missing.contains(&c.cipher_hash)))
                    .collect();
                up.writer = Some(w);
                up.phase = Phase::Chunks;
            }
            Err(_) => self.restart_fresh(up),
        }
    }

    /// The write epoch moved on: start over under the current one.
    fn restart_fresh(&mut self, up: &mut Upload) {
        if up.hosted.is_some() {
            return up.fail(ErrorCode::Unavailable.problem_with_reason(
                "attachment_upload_scope_changed",
                "the hosted upload's epoch changed; upload again",
            ));
        }
        up.rounds += 1;
        if up.rounds > MAX_ROUNDS {
            return up.fail(ErrorCode::Unavailable.problem("the write epoch keeps changing"));
        }
        match AttachmentWriter::new(
            &*self.sealer,
            self.cfg.collection,
            up.total,
            up.limits,
            self.host.entropy.as_mut(),
        ) {
            Ok(w) => {
                up.writer = Some(w);
                up.recorded.clear();
                up.finished = None;
                up.unsure = None;
                up.phase = Phase::Chunks;
            }
            Err(e) => up.fail(stream_problem(&e)),
        }
    }

    /// The log refused an append as `refs_missing`. Captured attachment rows of
    /// the batch whose refs are among `missing` (all of them when the service
    /// named none) fail with a typed terminal problem after
    /// [`MAX_REFS_MISSING`] refusals: rejected receipt, upload status and an
    /// incident. Returns whether any row was failed (the batch is re-planned).
    pub(crate) fn fail_attachment_refs_missing(
        &mut self,
        mutations: &[Uuid],
        missing: &[Hash],
    ) -> Result<bool, crate::store::StoreError> {
        let missing: BTreeSet<Hash> = missing.iter().copied().collect();
        let mut failed = Vec::new();
        for id in mutations {
            let Some(row) = self.store.pending_get(id)? else {
                continue;
            };
            if !(attaches(&row.mutation)
                || super::unindexed_reverse_entry::is_reverse(&row.mutation))
                || !(missing.is_empty() || row.refs.iter().any(|r| missing.contains(r)))
            {
                continue;
            }
            let strikes = self.attachment_uploads.refs_missing.entry(*id).or_insert(0);
            *strikes += 1;
            if *strikes < MAX_REFS_MISSING {
                continue;
            }
            self.attachment_uploads.refs_missing.remove(id);
            let problem = ErrorCode::NotFound.problem_with_reason(
                "attachment_objects_missing",
                "the log no longer has this attachment's uploaded objects; upload it again",
            );
            failed.push((*id, row.grant, problem));
        }
        if failed.is_empty() {
            return Ok(false);
        }
        for (id, _, problem) in &failed {
            if let Some(up) = self.attachment_uploads.map.get_mut(id) {
                up.phase = Phase::Done(Box::new(AttachmentUploadStatus::Failed(problem.clone())));
            }
            self.incident(
                mdbn_wire::client::IncidentKind::Integrity,
                Some(mdbn_wire::common::Value::Text(format!(
                    "attachment_objects_missing: mutation {} was refused as refs_missing",
                    id.to_hex()
                ))),
            );
        }
        self.resolve_rejected(failed)?;
        Ok(true)
    }

    /// Independent bounded hosted progress, preserving the device/external FIFO.
    pub(crate) fn attachment_upload_step(&mut self) {
        self.prune_hosted_uploads();
        if self.log_move != super::LogMove::None || self.apply_fault {
            return;
        }
        self.drive_uploads();
        self.attachment_ingest_step();
    }

    fn drive_uploads(&mut self) {
        let ids: Vec<_> = self.attachment_uploads.queue.iter().copied().collect();
        let mut native_waiting = false;
        for id in ids {
            let Some(mut up) = self.attachment_uploads.map.remove(&id) else {
                self.attachment_uploads.queue.retain(|queued| *queued != id);
                continue;
            };
            let delegated = up.origin.delegated.is_some();
            if delegated || !native_waiting {
                self.drive_upload(&mut up);
            }
            let done = matches!(up.phase, Phase::Done(_));
            if !delegated && !done {
                native_waiting = true;
            }
            self.attachment_uploads.map.insert(id, up);
            if done {
                self.attachment_uploads.queue.retain(|queued| *queued != id);
            }
        }
    }

    fn drive_upload(&mut self, up: &mut Upload) {
        loop {
            if up.origin.delegated.is_some() && matches!(up.phase, Phase::Done(_)) {
                return;
            }
            if let Err(error) = self.hosted_upload_lifetime_check(up) {
                self.retire_upload_call(up);
                return up.fail(error.into_problem());
            }
            if let Some(context) = &up.origin.delegated
                && let Err(error) = self.hosted_attachment_create_check(
                    context,
                    &up.params.path,
                    up.total,
                    &up.params.file,
                )
            {
                return up.fail(error.into_problem());
            }
            if let Some((call, _)) = up.call {
                // A call dropped by a repoint has no reply coming: its outcome is
                // unknown.
                if self.inflight.contains_key(&call) {
                    return;
                }
                if let Some((_, what)) = up.call.take() {
                    self.attachment_unsure(up, what);
                }
            }
            if let Some(t) = up.retry_at {
                if self.now() < t {
                    return;
                }
                up.retry_at = None;
            }
            if let Some(unsure) = up.unsure {
                let address = match unsure {
                    Call::PutChunk { address, .. } => address,
                    _ => match up.finished.as_ref() {
                        Some(f) => f.descriptor.manifest_cipher_hash,
                        None => {
                            return up.fail(ErrorCode::Internal.problem("attachment: no manifest"));
                        }
                    },
                };
                self.attachment_call(
                    up,
                    Call::Recheck { address },
                    LogRequest::HasObjects {
                        collection: self.cfg.collection,
                        addresses: vec![address],
                    },
                );
                return;
            }
            match up.phase {
                Phase::Done(_) | Phase::HostedChunks => return,
                Phase::Probe => {
                    let addresses = up.recorded.iter().map(|(c, _)| c.cipher_hash).collect();
                    self.attachment_call(
                        up,
                        Call::Probe,
                        LogRequest::HasObjects {
                            collection: self.cfg.collection,
                            addresses,
                        },
                    );
                    return;
                }
                Phase::Chunks => {
                    if !self.next_chunk(up) {
                        return;
                    }
                }
                Phase::Manifest => {
                    let Some(f) = up.finished.as_ref() else {
                        return up.fail(ErrorCode::Internal.problem("attachment: no manifest"));
                    };
                    let request = LogRequest::PutObject {
                        collection: self.cfg.collection,
                        address: f.descriptor.manifest_cipher_hash,
                        kind: ItemKind::BlobPart,
                        bytes: f.bytes.clone(),
                    };
                    self.attachment_call(up, Call::PutManifest, request);
                    return;
                }
                Phase::Verify => {
                    let Some(f) = up.finished.as_ref() else {
                        return up.fail(ErrorCode::Internal.problem("attachment: no manifest"));
                    };
                    let addresses = f.refs.clone();
                    self.attachment_call(
                        up,
                        Call::Verify,
                        LogRequest::HasObjects {
                            collection: self.cfg.collection,
                            addresses,
                        },
                    );
                    return;
                }
            }
        }
    }

    fn attachment_call(&mut self, up: &mut Upload, call: Call, request: LogRequest) {
        if let Err(error) = self.hosted_upload_lifetime_check(up) {
            return up.fail(error.into_problem());
        }
        if let Some(context) = &up.origin.delegated
            && let Err(error) = self.hosted_attachment_create_check(
                context,
                &up.params.path,
                up.total,
                &up.params.file,
            )
        {
            return up.fail(error.into_problem());
        }
        let id = self.queue(request);
        self.inflight
            .insert(id, super::append::Inflight::Attachment(up.mutation));
        up.call = Some((id, call));
    }

    /// Process the next chunk. Returns whether to keep going without a call
    /// (a chunk adopted, or the manifest sealed).
    fn next_chunk(&mut self, up: &mut Upload) -> bool {
        let chunk_count = up.chunk_count();
        let Some(w) = up.writer.as_mut() else {
            up.fail(ErrorCode::Internal.problem("attachment: no writer"));
            return false;
        };
        // Sealing needs the attachment's epoch to still be current.
        if self.sealer.current_epoch() != Some(w.context().key_epoch) {
            self.restart_fresh(up);
            return !matches!(up.phase, Phase::Done(_));
        }
        let index = w.chunks().len() as u64;
        if index == chunk_count {
            return self.seal_manifest(up);
        }
        let len = w.next_chunk_len();
        let mut plain = Zeroizing::new(vec![0u8; usize::try_from(len).unwrap_or(0)]);
        let read = match up.source.as_mut() {
            Some(s) if s.len() == up.total => {
                s.read_at(index * u64::from(CHUNK_BYTES), plain.as_mut_slice())
            }
            Some(_) => Err("the file's length changed".to_string()),
            None => Err("no source".to_string()),
        };
        if let Err(e) = read {
            up.fail(
                ErrorCode::Conflict
                    .problem_with_reason("source_changed", format!("reading the file: {e}")),
            );
            return false;
        }
        let i = usize::try_from(index).unwrap_or(usize::MAX);
        let earlier = up.recorded.get(i).copied();
        if let Some((stored, present)) = earlier {
            if present {
                if let Err(e) = w.adopt_chunk(&plain, stored) {
                    up.fail(stream_problem(&e));
                    return false;
                }
                return true;
            }
            // Recorded but not stored: the source must still match before the
            // chunk is sealed again under a fresh salt.
            if mdbn_wire::hash::sha256(&plain) != stored.plain_hash {
                up.fail(stream_problem(&StreamError::Protocol(
                    "adopted chunk does not match",
                )));
                return false;
            }
        }
        let before = w.clone();
        let sealed = match w.push_chunk(&*self.sealer, &plain, self.host.entropy.as_mut()) {
            Ok(o) => o,
            Err(e) => {
                up.fail(stream_problem(&e));
                return false;
            }
        };
        drop(plain);
        up.before = Some(before);
        let address = sealed.cipher_hash;
        let request = LogRequest::PutObject {
            collection: self.cfg.collection,
            address,
            kind: ItemKind::BlobPart,
            bytes: sealed.bytes,
        };
        self.attachment_call(up, Call::PutChunk { index, address }, request);
        false
    }

    /// Every chunk is in: seal the manifest, authenticate it as a reader would,
    /// and derive the refs from the verified manifest only.
    fn seal_manifest(&mut self, up: &mut Upload) -> bool {
        let Some(w) = up.writer.take() else {
            up.fail(ErrorCode::Internal.problem("attachment: no writer"));
            return false;
        };
        let done = match w.finish(&*self.sealer, self.host.entropy.as_mut()) {
            Ok(d) => d,
            Err(e) => {
                up.fail(stream_problem(&e));
                return false;
            }
        };
        let verified = match self.sealer.open_attachment_manifest(
            &done.descriptor,
            done.expected,
            &done.manifest.bytes,
            up.limits,
        ) {
            Ok(v) => v,
            Err(_) => {
                up.fail(ErrorCode::Internal.problem("own attachment manifest does not open"));
                return false;
            }
        };
        let m = verified.manifest();
        if m.file != done.expected
            || m.context != done.descriptor.context
            || m.file.total_plain_bytes != up.total
            || m.chunks.len() as u64 != up.chunk_count()
        {
            up.fail(ErrorCode::Internal.problem("own attachment manifest does not reconcile"));
            return false;
        }
        let refs = match refs_of(&m.chunks, done.descriptor.manifest_cipher_hash) {
            Ok(r) => r,
            Err(p) => {
                up.fail(p.into_problem());
                return false;
            }
        };
        // Kept for a later round that finds objects missing.
        up.recorded = m.chunks.iter().map(|c| (*c, true)).collect();
        up.finished = Some(Finished {
            bytes: done.manifest.bytes,
            descriptor: done.descriptor,
            expected: done.expected,
            refs,
        });
        up.phase = Phase::Manifest;
        true
    }

    /// Every object is stored: re-check authority now (after the awaits), then
    /// capture the `file_attach` with its refs into the pending queue.
    fn capture_attachment(&mut self, up: &mut Upload) {
        if let Err(error) = self.hosted_upload_lifetime_check(up) {
            return up.fail(error.into_problem());
        }
        let Some(f) = up.finished.take() else {
            return up.fail(ErrorCode::Internal.problem("attachment: no manifest"));
        };
        let admission = match &up.origin.delegated {
            Some(context) => self.hosted_attachment_create_check(
                context,
                &up.params.path,
                up.total,
                &up.params.file,
            ),
            None => self.attachment_upload_admission(&up.params.path),
        };
        if let Err(e) = admission {
            let p = e.into_problem();
            if up.origin.delegated.is_none() && p.code == ErrorCode::Unavailable.as_str() {
                // Device path only: a delegated scope/epoch failure is terminal.
                // No current key right now (a rekey in progress): check again later.
                up.finished = Some(f);
                up.retry_at = Some(
                    self.now()
                        .saturating_add(i64::try_from(self.tuning.retry_ms).unwrap_or(0)),
                );
                return;
            }
            return up.fail(p);
        }
        if f.descriptor.context.key_epoch != self.policy.epoch
            || f.descriptor.context.collection != self.cfg.collection
        {
            // A rekey while uploading: historical keys never write.
            up.finished = None;
            self.restart_fresh(up);
            return;
        }
        match self.collect_held_attachment(up, &f) {
            Ok(true) => {
                up.source = None;
                up.writer = None;
                up.recorded.clear();
                up.phase = Phase::Done(Box::new(AttachmentUploadStatus::Held {
                    file: up.params.file,
                }));
                return;
            }
            Ok(false) => {}
            Err(error) => return up.fail(error.into_problem()),
        }
        match self.capture_file_attach(up, &f) {
            Ok(receipt) => {
                up.source = None;
                up.writer = None;
                up.recorded.clear();
                up.phase = Phase::Done(Box::new(AttachmentUploadStatus::Captured(receipt)));
            }
            Err(p) => up.fail(p.into_problem()),
        }
    }

    fn collect_held_attachment(&mut self, up: &Upload, f: &Finished) -> ApiResult<bool> {
        if !up.origin.external || up.origin.delegated.is_some() {
            return Ok(false);
        }
        let store_problem = super::submit::store_err;
        let hold = self.store.hold(&up.params.file).map_err(store_problem)?;
        match (up.origin.held, hold) {
            (None, None) => Ok(false),
            (Some(stamp), Some(mut hold))
                if hold.path == up.params.path
                    && mdbn_wire::hash::sha256(
                        &hold
                            .to_bytes()
                            .map_err(|e| ErrorCode::Internal.err(e.to_string()))?,
                    ) == stamp =>
            {
                hold.mine = mdbn_wire::snapshot::TextOrBlob::Attachment(AttachmentContentV1 {
                    reference: wire_ref(&f.descriptor),
                    whole_plain_hash: f.expected.whole_plain_hash,
                    total_plain_bytes: f.expected.total_plain_bytes,
                });
                hold.saves = hold.saves.saturating_add(1);
                if let Err(error) = self.store.commit(Tx {
                    holds_put: vec![hold],
                    ack_observations: up.origin.acks.clone(),
                    meta: up.origin.meta.clone(),
                    ..Tx::default()
                }) {
                    if matches!(error, crate::store::StoreError::CommitAborted(_)) {
                        // The save was not collected. Keep its observation so
                        // a new scan/reopen can upload the raw bytes afresh.
                        return Err(ErrorCode::Unavailable.err_with_reason(
                            "attachment_hold_commit_aborted",
                            "the held save was not durably collected",
                        ));
                    }
                    // Neither cleanup nor a retry may guess whether the hold
                    // and its observation ACK landed. Reopen reads authority.
                    self.terminal_store_fault("attachment_hold_durability_unknown");
                    return Err(store_problem(error));
                }
                self.status_dirty = true;
                self.push_holds();
                Ok(true)
            }
            _ => Err(ErrorCode::Conflict.err_with_reason(
                "attachment_hold_changed",
                "the hold changed while collecting this save",
            )),
        }
    }

    fn capture_file_attach(&mut self, up: &Upload, f: &Finished) -> ApiResult<Receipt> {
        use mdbn_core::plan::{PlanOptions, Stage};
        let store_problem = super::submit::store_err;
        let id = up.mutation;
        let grant = up.origin.delegated.as_ref().map(|context| context.grant());
        if let Some(r) = self.known_receipt_for(&id, grant).map_err(store_problem)? {
            return Ok(r);
        }
        if grant.is_some() && self.receipt_exists(&id).map_err(store_problem)? {
            return Err(ErrorCode::Forbidden.err_with_reason(
                "mutation_owner",
                "this mutation ID belongs to another caller",
            ));
        }
        if let Some(context) = &up.origin.delegated {
            self.hosted_attachment_create_check(
                context,
                &up.params.path,
                up.total,
                &up.params.file,
            )?;
        }
        let instant = self.capture_instant();
        let tz = self.host.zones.default_zone();
        let local_date = self
            .host
            .zones
            .local_date(instant, &tz)
            .ok_or_else(|| ErrorCode::Internal.err("no local date"))?;
        let mut seed = [0u8; 32];
        self.host.entropy.fill(&mut seed);
        let m = rt::Mutation {
            id,
            origin: self.cfg.replica_id,
            base_seq: self.head.seq,
            clock: OpClock {
                instant,
                tz,
                local_date,
            },
            seed: B32(seed),
            source: if up.origin.external {
                Source::External
            } else {
                Source::Api
            },
            ops: vec![rt::Op::FileAttach(FileAttach {
                id: up.params.file,
                path: up.params.path.clone(),
                content: AttachmentContentV1 {
                    reference: wire_ref(&f.descriptor),
                    whole_plain_hash: f.expected.whole_plain_hash,
                    total_plain_bytes: f.expected.total_plain_bytes,
                },
                if_revision: up.params.if_revision,
                base: up.origin.base,
            })],
            on_behalf: grant,
            conflict_mode: None,
            validated_at: Some(Level::Error),
            room: None,
        };
        let planned = {
            let cm = convert::runtime_mutation(&m, &convert::inline_only)
                .map_err(|e| ErrorCode::InvalidRequest.err(e.to_string()))?;
            let view = crate::plan::StoreView::new(&self.store, self.catalog.clone());
            let lv = crate::layer::LayerView {
                base: &view,
                layer: &self.layer,
            };
            let r = self.planner.plan(
                &cm,
                &lv,
                &PlanOptions {
                    stage: Stage::Submit {
                        level: mdbn_core::intent::Level::Error,
                    },
                },
            );
            if let Some(e) = view.error() {
                return Err(store_problem(e));
            }
            super::check_paths(r)
                .map_err(|r| ApiError::from(super::submit::rejection_problem(&r)))?
        };
        if let Some(context) = &up.origin.delegated {
            for effect in &planned.effects {
                if let mdbn_core::plan::Effect::PutAttachmentFile { id, path, .. } = effect {
                    self.hosted_attachment_create_check(
                        context,
                        path,
                        up.total,
                        &convert::wuuid(id),
                    )?;
                }
            }
        }
        // The entry must encode before anything is captured.
        entry_plain(m.clone(), &planned, None)?;
        self.hosted_upload_lifetime_check(up)?;
        let mut touches = crate::plan::runtime_mutation_keys(&m);
        for e in &planned.effects {
            if let mdbn_core::plan::Effect::PutAttachmentFile { id, path, .. } = e {
                touches.push(crate::plan::id_key(&convert::wuuid(id)));
                touches.push(format!("p:{}", mdbn_core::paths::path_key(path)));
            }
        }
        touches.sort();
        touches.dedup();
        let order = self.next_order;
        self.next_order += 1;
        let row = PendingRow {
            order,
            mutation: m,
            // Layering attachment content lands with apply (T5).
            effects: Vec::new(),
            touches: touches.clone(),
            grant,
            uploads: Vec::new(),
            refs: f.refs.clone(),
        };
        check_row_refs(&row)?;
        let committed = self.store.commit(Tx {
            pending_put: vec![row],
            meta: std::iter::once((
                meta_keys::COUNTERS.into(),
                super::i64_meta(self.clock_floor),
            ))
            .chain(up.origin.meta.iter().cloned())
            // The complete object inventory, for later snapshots' refs.
            .chain(std::iter::once(
                super::attachment_inventory::inventory_meta_of_refs(
                    f.descriptor.manifest_cipher_hash,
                    &f.refs,
                ),
            ))
            .collect(),
            ack_observations: up.origin.acks.clone(),
            ..Tx::default()
        });
        if let Err(error) = committed {
            if up.origin.delegated.is_some() {
                if matches!(error, crate::store::StoreError::CommitAborted(_)) {
                    self.next_order = order;
                } else {
                    // No adoption, rollback, receipt or retry on an uncertain
                    // capture. Existing fault helper closes/quarantines sessions.
                    self.committed_read_fault();
                }
            }
            return Err(store_problem(error));
        }
        self.touch.add(order, &touches);
        self.pending_keys.insert(order, touches);
        self.status_dirty = true;
        self.pump();
        Ok(self.pending_receipt(&id))
    }
}
