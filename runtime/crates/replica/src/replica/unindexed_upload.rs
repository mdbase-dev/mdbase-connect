//! Trusted T6b upload preparation. Stored objects and returned capsules never
//! grant capture/emission authority; every final capture must recheck the proof.
use super::{PreparedUnindexedCapture, Replica};
use crate::{
    api::{ApiResult, ErrorCode},
    attachments::{AttachmentWriter, WrittenAttachment},
    crypto::chunked_blob::{AttachmentLimits, SealedObject},
    log::{CallId, LogReply, LogRequest, LogResponse},
    store::Store,
};
use mdbn_wire::{
    attachment::{AttachmentContentV1, AttachmentRefV1, FileContent},
    client::Problem,
    common::{Hash, Uuid},
    envelope::ItemKind,
};
use std::collections::{BTreeMap, VecDeque};
use zeroize::Zeroizing;
/// Upload progress only; `Prepared` does not mean captured or appended.
#[derive(Debug, Clone, PartialEq)]
pub enum UnindexedUploadStatus {
    /// Objects acknowledged stored.
    Uploading {
        /// Stored chunks and manifest.
        stored: u64,
    },
    /// Complete object closure checked; take the opaque capsule.
    Prepared,
    /// Stopped with no pending mutation.
    Failed(Problem),
}
/// Opaque uploaded source; content/refs are data, not current-holder authority.
pub struct PreparedUnindexedUpload {
    pub(super) proof: PreparedUnindexedCapture,
    pub(super) content: AttachmentContentV1,
    pub(super) refs: Vec<Hash>,
    pub(super) epoch: u64,
}
impl PreparedUnindexedUpload {
    /// Complete authenticated writer descriptor.
    pub fn content(&self) -> &AttachmentContentV1 {
        &self.content
    }
    /// Sorted complete encrypted object closure.
    pub fn refs(&self) -> &[Hash] {
        &self.refs
    }
}
#[derive(Default)]
pub(crate) struct Uploads {
    jobs: BTreeMap<Uuid, Upload>,
    queue: VecDeque<Uuid>,
}
struct Upload {
    proof: Option<PreparedUnindexedCapture>,
    writer: Option<AttachmentWriter>,
    epoch: u64,
    object: Option<SealedObject>,
    finished: Option<WrittenAttachment>,
    call: Option<(CallId, Call)>,
    probe_object: bool,
    retry_at: Option<i64>,
    stored: u64,
    status: UnindexedUploadStatus,
}
#[derive(Clone, Copy)]
enum Call {
    Put,
    Probe,
    Verify,
}
impl Uploads {
    pub(crate) fn next_wakeup(&self) -> Option<i64> {
        self.jobs.get(self.queue.front()?)?.retry_at
    }
}
fn content(w: &WrittenAttachment) -> AttachmentContentV1 {
    let d = w.descriptor;
    AttachmentContentV1 {
        reference: AttachmentRefV1 {
            collection: d.context.collection,
            key_epoch: d.context.key_epoch,
            attachment_id: d.context.attachment_id,
            manifest_cipher_hash: d.manifest_cipher_hash,
        },
        whole_plain_hash: w.expected.whole_plain_hash,
        total_plain_bytes: w.expected.total_plain_bytes,
    }
}
impl<S: Store> Replica<S> {
    /// Start bounded object upload from an already verified opaque source. No
    /// generic facade/Submit path exists and no pending/log mutation is created.
    pub fn start_unindexed_markdown_upload(
        &mut self,
        proof: PreparedUnindexedCapture,
    ) -> ApiResult<Uuid> {
        self.recheck_unindexed_markdown_capture(&proof)?;
        let writer = AttachmentWriter::new(
            &*self.sealer,
            self.cfg.collection,
            proof.size(),
            AttachmentLimits::default(),
            &mut *self.host.entropy,
        )
        .map_err(|e| ErrorCode::Unavailable.err(format!("unindexed writer: {e:?}")))?;
        let epoch = writer.context().key_epoch;
        let id = self.mint_v7();
        self.unindexed_uploads.jobs.insert(
            id,
            Upload {
                proof: Some(proof),
                writer: Some(writer),
                epoch,
                object: None,
                finished: None,
                call: None,
                probe_object: false,
                retry_at: None,
                stored: 0,
                status: UnindexedUploadStatus::Uploading { stored: 0 },
            },
        );
        self.unindexed_uploads.queue.push_back(id);
        self.unindexed_upload_step();
        Ok(id)
    }
    /// Cancel and discard private source/job state. Stored objects stay orphaned
    /// for the normal log-service grace-period collector.
    pub fn cancel_unindexed_markdown_upload(&mut self, id: &Uuid) {
        if let Some(u) = self.unindexed_uploads.jobs.remove(id)
            && let Some((call, _)) = u.call
        {
            self.inflight.remove(&call);
        }
        self.unindexed_uploads.queue.retain(|n| n != id);
        self.unindexed_upload_step();
    }
    /// Inspect progress; prepared does not imply capture/emission.
    pub fn unindexed_markdown_upload_status(&self, id: &Uuid) -> Option<UnindexedUploadStatus> {
        self.unindexed_uploads
            .jobs
            .get(id)
            .map(|u| u.status.clone())
    }
    /// Recheck the complete capsule's current authority; byte/object preparation
    /// alone is never a capture or current-holder witness.
    pub fn recheck_prepared_unindexed_upload(&self, p: &PreparedUnindexedUpload) -> ApiResult<()> {
        self.recheck_unindexed_markdown_capture(&p.proof)?;
        if self.sealer.current_epoch() != Some(p.epoch) || self.policy.epoch != p.epoch {
            return Err(ErrorCode::Conflict
                .err_with_reason("unindexed_capture_changed", "upload epoch changed"));
        }
        p.proof
            .operation(FileContent::AttachmentV1(p.content.clone()))?;
        Ok(())
    }
    /// Take a complete capsule only after fresh health/holder/catalog/epoch fences.
    pub fn take_prepared_unindexed_upload(
        &mut self,
        id: &Uuid,
    ) -> ApiResult<PreparedUnindexedUpload> {
        let u = self
            .unindexed_uploads
            .jobs
            .get(id)
            .ok_or_else(|| ErrorCode::NotFound.err("unknown upload"))?;
        if !matches!(u.status, UnindexedUploadStatus::Prepared) {
            return Err(ErrorCode::Conflict.err("upload not prepared"));
        }
        let p = u
            .proof
            .as_ref()
            .ok_or_else(|| ErrorCode::Conflict.err("source missing"))?;
        self.recheck_unindexed_markdown_capture(p)?;
        if self.sealer.current_epoch() != Some(u.epoch) || self.policy.epoch != u.epoch {
            return Err(ErrorCode::Conflict
                .err_with_reason("unindexed_capture_changed", "upload epoch changed"));
        }
        let mut u = self
            .unindexed_uploads
            .jobs
            .remove(id)
            .expect("checked upload");
        let finished = u.finished.take().expect("prepared closure");
        let c = content(&finished);
        let mut refs = finished.refs;
        refs.sort();
        refs.dedup();
        Ok(PreparedUnindexedUpload {
            proof: u.proof.take().expect("checked proof"),
            content: c,
            refs,
            epoch: u.epoch,
        })
    }
    pub(crate) fn unindexed_upload_step(&mut self) {
        let Some(id) = self.unindexed_uploads.queue.front().copied() else {
            return;
        };
        let Some(mut u) = self.unindexed_uploads.jobs.remove(&id) else {
            self.unindexed_uploads.queue.pop_front();
            return;
        };
        if u.call.is_some() || u.retry_at.is_some_and(|t| self.now() < t) {
            self.unindexed_uploads.jobs.insert(id, u);
            return;
        }
        u.retry_at = None;
        let result = (|| {
            let p = u
                .proof
                .as_mut()
                .ok_or_else(|| ErrorCode::Conflict.err("source missing"))?;
            self.recheck_unindexed_markdown_capture(p)?;
            if self.sealer.current_epoch() != Some(u.epoch) || self.policy.epoch != u.epoch {
                return Err(ErrorCode::Conflict
                    .err_with_reason("unindexed_capture_changed", "upload epoch changed"));
            }
            if u.object.is_none()
                && let Some(w) = u.writer.as_mut()
            {
                let n = w.next_chunk_len();
                if n > 0 {
                    let offset = w.chunks().iter().map(|c| c.plain_bytes).sum();
                    let mut plain = Zeroizing::new(vec![0; n as usize]);
                    p.source_mut()
                        .read_at(offset, &mut plain)
                        .map_err(|e| ErrorCode::Conflict.err_with_reason("source_changed", e))?;
                    u.object = Some(
                        w.push_chunk(&*self.sealer, &plain, &mut *self.host.entropy)
                            .map_err(|e| {
                                ErrorCode::Unavailable.err(format!("unindexed chunk: {e:?}"))
                            })?,
                    );
                } else {
                    let w = u.writer.take().expect("writer present");
                    let finished =
                        w.finish(&*self.sealer, &mut *self.host.entropy)
                            .map_err(|e| {
                                ErrorCode::Unavailable.err(format!("unindexed manifest: {e:?}"))
                            })?;
                    p.operation(FileContent::AttachmentV1(content(&finished)))?;
                    u.object = Some(SealedObject {
                        cipher_hash: finished.manifest.cipher_hash,
                        bytes: finished.manifest.bytes.clone(),
                    });
                    u.finished = Some(finished);
                }
            }
            let (request, kind) = if let Some(o) = &u.object {
                if u.probe_object {
                    (
                        LogRequest::HasObjects {
                            collection: self.cfg.collection,
                            addresses: vec![o.cipher_hash],
                        },
                        Call::Probe,
                    )
                } else {
                    (
                        LogRequest::PutObject {
                            collection: self.cfg.collection,
                            address: o.cipher_hash,
                            kind: if u.finished.is_some() {
                                ItemKind::Manifest
                            } else {
                                ItemKind::Chunk
                            },
                            bytes: o.bytes.clone(),
                        },
                        Call::Put,
                    )
                }
            } else {
                let f = u
                    .finished
                    .as_ref()
                    .ok_or_else(|| ErrorCode::Internal.err("upload lost closure"))?;
                (
                    LogRequest::HasObjects {
                        collection: self.cfg.collection,
                        addresses: f.refs.clone(),
                    },
                    Call::Verify,
                )
            };
            let call = self.queue(request);
            self.inflight
                .insert(call, super::append::Inflight::UnindexedUpload(id));
            u.call = Some((call, kind));
            Ok(())
        })();
        if let Err(e) = result {
            u.status = UnindexedUploadStatus::Failed(e.into_problem());
            u.proof = None;
            u.writer = None;
            u.object = None;
            u.finished = None;
            self.unindexed_uploads.queue.pop_front();
        }
        self.unindexed_uploads.jobs.insert(id, u);
    }
    pub(crate) fn on_unindexed_upload_reply(&mut self, id: Uuid, call: CallId, reply: LogReply) {
        let Some(mut u) = self.unindexed_uploads.jobs.remove(&id) else {
            return;
        };
        let Some((expected, kind)) = u.call else {
            self.unindexed_uploads.jobs.insert(id, u);
            return;
        };
        if expected != call {
            self.unindexed_uploads.jobs.insert(id, u);
            return;
        }
        u.call = None;
        match (kind, reply) {
            (Call::Put, Ok(LogResponse::PutObject { .. })) => {
                u.object = None;
                u.probe_object = false;
                u.stored += 1;
                u.status = UnindexedUploadStatus::Uploading { stored: u.stored };
            }
            (Call::Probe, Ok(LogResponse::HasObjects(flags))) if flags == vec![true] => {
                u.object = None;
                u.probe_object = false;
                u.stored += 1;
                u.status = UnindexedUploadStatus::Uploading { stored: u.stored };
            }
            (Call::Probe, Ok(LogResponse::HasObjects(flags))) if flags == vec![false] => {
                u.probe_object = false
            }
            (Call::Verify, Ok(LogResponse::HasObjects(flags)))
                if u.finished
                    .as_ref()
                    .is_some_and(|f| flags.len() == f.refs.len())
                    && flags.iter().all(|b| *b) =>
            {
                let valid = u
                    .proof
                    .as_ref()
                    .is_some_and(|p| self.recheck_unindexed_markdown_capture(p).is_ok())
                    && self.sealer.current_epoch() == Some(u.epoch)
                    && self.policy.epoch == u.epoch;
                if valid {
                    u.status = UnindexedUploadStatus::Prepared;
                } else {
                    u.status =
                        UnindexedUploadStatus::Failed(ErrorCode::Conflict.problem_with_reason(
                            "unindexed_capture_changed",
                            "capture authority changed",
                        ));
                    u.proof = None;
                    u.finished = None;
                }
                self.unindexed_uploads.queue.pop_front();
            }
            (Call::Verify, Ok(LogResponse::HasObjects(_))) => {
                u.status =
                    UnindexedUploadStatus::Failed(ErrorCode::Unavailable.problem_with_reason(
                        "refs_missing",
                        "uploaded object closure is incomplete",
                    ));
                u.proof = None;
                u.finished = None;
                self.unindexed_uploads.queue.pop_front();
            }
            _ => {
                if matches!(kind, Call::Put) {
                    u.probe_object = true;
                }
                u.retry_at = Some(
                    self.now().saturating_add(
                        i64::try_from(self.tuning.retry_ms)
                            .unwrap_or(1000)
                            .max(1000),
                    ),
                );
            }
        }
        self.unindexed_uploads.jobs.insert(id, u);
        self.unindexed_upload_step();
    }
}
