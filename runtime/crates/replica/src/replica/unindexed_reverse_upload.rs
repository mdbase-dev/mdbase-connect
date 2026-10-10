//! Reverse16 data-only upload through the existing object transport. No capture authority.
use super::{PreparedUnindexedReindex, Replica, UnindexedUploadStatus};
use crate::{
    api::{ApiResult, ErrorCode},
    crypto::blob::SealedPart,
    log::{CallId, LogReply, LogRequest, LogResponse},
    store::Store,
};
use mdbn_wire::{
    common::{Hash, Uuid},
    envelope::ItemKind,
    intent::BlobRef,
};
use std::collections::{BTreeMap, VecDeque};
/// Opaque complete reverse source upload, still requiring fresh final capture.
pub struct PreparedUnindexedReindexUpload {
    pub(super) proof: PreparedUnindexedReindex,
    pub(super) source: BlobRef,
    pub(super) refs: Vec<Hash>,
}
impl PreparedUnindexedReindexUpload {
    /// Data-only source descriptor.
    pub fn source(&self) -> &BlobRef {
        &self.source
    }
    /// Complete sorted Blob part closure; not holder/publication authority.
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
    prepared: Option<PreparedUnindexedReindexUpload>,
    parts: VecDeque<SealedPart>,
    call: Option<(CallId, Call)>,
    probe: bool,
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
impl<S: Store> Replica<S> {
    /// Seal and upload the <=1MiB exact replacement for a current native holder.
    /// Uses PutObject/HasObjects, including staged direct upload in the transport.
    pub fn start_unindexed_markdown_reindex_upload(
        &mut self,
        proof: PreparedUnindexedReindex,
    ) -> ApiResult<Uuid> {
        let (source, parts) = self.seal_unindexed_markdown_reindex_source(&proof)?;
        let refs = self
            .sealer
            .blob_part_addresses(&source)
            .ok_or_else(|| ErrorCode::Unavailable.err("reverse source key unavailable"))?;
        if parts.len() != refs.len()
            || parts.iter().map(|p| p.address).collect::<Vec<_>>() != refs
            || refs.is_empty()
        {
            return Err(ErrorCode::Internal.err("reverse source closure mismatch"));
        }
        let mut refs = refs;
        refs.sort();
        if !refs.windows(2).all(|w| w[0] < w[1]) {
            return Err(ErrorCode::Internal.err("reverse source duplicate address"));
        }
        let id = self.mint_v7();
        self.unindexed_reverse_uploads.jobs.insert(
            id,
            Upload {
                prepared: Some(PreparedUnindexedReindexUpload {
                    proof,
                    source,
                    refs,
                }),
                parts: parts.into(),
                call: None,
                probe: false,
                retry_at: None,
                stored: 0,
                status: UnindexedUploadStatus::Uploading { stored: 0 },
            },
        );
        self.unindexed_reverse_uploads.queue.push_back(id);
        self.unindexed_reverse_upload_step();
        Ok(id)
    }
    /// Upload progress, never an append receipt.
    pub fn unindexed_markdown_reindex_upload_status(
        &self,
        id: &Uuid,
    ) -> Option<UnindexedUploadStatus> {
        self.unindexed_reverse_uploads
            .jobs
            .get(id)
            .map(|u| u.status.clone())
    }
    /// Discard private job state; existing orphan collection applies to stored parts.
    pub fn cancel_unindexed_markdown_reindex_upload(&mut self, id: &Uuid) {
        if let Some(u) = self.unindexed_reverse_uploads.jobs.remove(id)
            && let Some((call, _)) = u.call
        {
            self.inflight.remove(&call);
        }
        self.unindexed_reverse_uploads.queue.retain(|n| n != id);
        self.unindexed_reverse_upload_step();
    }
    /// Fresh authority/current epoch check, not satisfied by object inventory.
    pub fn recheck_prepared_unindexed_reindex_upload(
        &self,
        p: &PreparedUnindexedReindexUpload,
    ) -> ApiResult<()> {
        self.recheck_unindexed_markdown_reindex(&p.proof)?;
        if self.sealer.current_epoch() != Some(p.source.id_epoch)
            || self.policy.epoch != p.source.id_epoch
        {
            return Err(ErrorCode::Conflict
                .err_with_reason("unindexed_capture_changed", "reverse upload epoch changed"));
        }
        let mut refs = self
            .sealer
            .blob_part_addresses(&p.source)
            .ok_or_else(|| ErrorCode::Unavailable.err("reverse source key unavailable"))?;
        refs.sort();
        if refs != p.refs {
            return Err(ErrorCode::Internal.err("reverse source refs changed"));
        }
        Ok(())
    }
    /// Take only a complete upload after fresh holder/catalog/generation/epoch checks.
    pub fn take_prepared_unindexed_reindex_upload(
        &mut self,
        id: &Uuid,
    ) -> ApiResult<PreparedUnindexedReindexUpload> {
        let u = self
            .unindexed_reverse_uploads
            .jobs
            .get(id)
            .ok_or_else(|| ErrorCode::NotFound.err("unknown reverse upload"))?;
        if !matches!(u.status, UnindexedUploadStatus::Prepared) {
            return Err(ErrorCode::Conflict.err("reverse upload not prepared"));
        }
        let p = u
            .prepared
            .as_ref()
            .ok_or_else(|| ErrorCode::Internal.err("reverse upload lost source"))?;
        self.recheck_prepared_unindexed_reindex_upload(p)?;
        Ok(self
            .unindexed_reverse_uploads
            .jobs
            .remove(id)
            .expect("checked upload")
            .prepared
            .expect("checked source"))
    }
    pub(crate) fn unindexed_reverse_upload_step(&mut self) {
        let Some(id) = self.unindexed_reverse_uploads.queue.front().copied() else {
            return;
        };
        let Some(mut u) = self.unindexed_reverse_uploads.jobs.remove(&id) else {
            self.unindexed_reverse_uploads.queue.pop_front();
            return;
        };
        if let Some((call, kind)) = u.call
            && !self.inflight.contains_key(&call)
        {
            u.call = None;
            if matches!(kind, Call::Put) {
                u.probe = true;
            }
        }
        if u.call.is_some() || u.retry_at.is_some_and(|t| self.now() < t) {
            self.unindexed_reverse_uploads.jobs.insert(id, u);
            return;
        }
        u.retry_at = None;
        let result: ApiResult<()> = (|| {
            let p = u
                .prepared
                .as_ref()
                .ok_or_else(|| ErrorCode::Internal.err("reverse source missing"))?;
            self.recheck_prepared_unindexed_reindex_upload(p)?;
            let (request, kind) = if let Some(part) = u.parts.front() {
                if u.probe {
                    (
                        LogRequest::HasObjects {
                            collection: self.cfg.collection,
                            addresses: vec![part.address],
                        },
                        Call::Probe,
                    )
                } else {
                    (
                        LogRequest::PutObject {
                            collection: self.cfg.collection,
                            address: part.address,
                            kind: ItemKind::BlobPart,
                            bytes: part.bytes.clone(),
                        },
                        Call::Put,
                    )
                }
            } else {
                (
                    LogRequest::HasObjects {
                        collection: self.cfg.collection,
                        addresses: p.refs.clone(),
                    },
                    Call::Verify,
                )
            };
            let call = self.queue(request);
            self.inflight
                .insert(call, super::append::Inflight::UnindexedReindexUpload(id));
            u.call = Some((call, kind));
            Ok(())
        })();
        if let Err(e) = result {
            u.status = UnindexedUploadStatus::Failed(e.into_problem());
            u.prepared = None;
            u.parts.clear();
            self.unindexed_reverse_uploads.queue.pop_front();
        }
        self.unindexed_reverse_uploads.jobs.insert(id, u);
    }
    pub(crate) fn on_unindexed_reverse_upload_reply(
        &mut self,
        id: Uuid,
        call: CallId,
        reply: LogReply,
    ) {
        let Some(mut u) = self.unindexed_reverse_uploads.jobs.remove(&id) else {
            return;
        };
        let Some((expected, kind)) = u.call else {
            self.unindexed_reverse_uploads.jobs.insert(id, u);
            return;
        };
        if call != expected {
            self.unindexed_reverse_uploads.jobs.insert(id, u);
            return;
        }
        u.call = None;
        match (kind, reply) {
            (Call::Put, Ok(LogResponse::PutObject { .. })) => {
                u.parts.pop_front();
                u.probe = false;
                u.stored += 1;
                u.status = UnindexedUploadStatus::Uploading { stored: u.stored };
            }
            (Call::Probe, Ok(LogResponse::HasObjects(flags))) if flags == vec![true] => {
                u.parts.pop_front();
                u.probe = false;
                u.stored += 1;
                u.status = UnindexedUploadStatus::Uploading { stored: u.stored };
            }
            (Call::Probe, Ok(LogResponse::HasObjects(flags))) if flags == vec![false] => {
                u.probe = false;
            }
            (Call::Verify, Ok(LogResponse::HasObjects(flags))) => {
                let complete = u
                    .prepared
                    .as_ref()
                    .is_some_and(|p| flags.len() == p.refs.len() && flags.iter().all(|f| *f));
                let valid = u
                    .prepared
                    .as_ref()
                    .is_some_and(|p| self.recheck_prepared_unindexed_reindex_upload(p).is_ok());
                if complete && valid {
                    u.status = UnindexedUploadStatus::Prepared;
                } else {
                    u.status =
                        UnindexedUploadStatus::Failed(ErrorCode::Conflict.problem_with_reason(
                            if complete {
                                "unindexed_capture_changed"
                            } else {
                                "refs_missing"
                            },
                            "reverse closure or authority changed",
                        ));
                    u.prepared = None;
                }
                self.unindexed_reverse_uploads.queue.pop_front();
            }
            _ => {
                if matches!(kind, Call::Put) {
                    u.probe = true;
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
        self.unindexed_reverse_uploads.jobs.insert(id, u);
        self.unindexed_reverse_upload_step();
    }
}
