//! Bounded wire fragments use the Replica's existing leased attachment region.
use super::*;
use crate::api::{ApiResult, ErrorCode, SessionId};
use crate::file_io::{RegionLease, RegionOwner};
use mdbn_wire::client::{OpenUploadParams, OpenUploadResult, UploadChunkParams};

use super::client_upload_resume::UploadLane;

pub(super) const FRAGMENT: u64 = 1 << 20;
pub(super) const WINDOW: u64 = 8 << 20;

pub(super) struct UploadWindow {
    pub(super) session: SessionId,
    pub(super) transfer: Uuid,
    pub(super) mutation: Uuid,
    pub(super) file: Uuid,
    pub(super) request: OpenUploadParams,
    pub(super) size: u64,
    pub(super) lease: RegionLease,
    pub(super) start: u64,
    pub(super) mask: u8,
    pub(super) staged: bool,
}

/// Replace needs both the file ID and the revision it was read at.
pub(super) fn open_replacement(
    params: &OpenUploadParams,
) -> ApiResult<Option<crate::replica::FileReplacement>> {
    match (params.file_id, params.if_revision) {
        (None, None) => Ok(None),
        (Some(file), Some(if_revision)) => {
            Ok(Some(crate::replica::FileReplacement { file, if_revision }))
        }
        _ => Err(ErrorCode::InvalidRequest.err_with_reason(
            "attachment_replace_requires_revision",
            "replacing a file needs both file_id and if_revision",
        )),
    }
}

impl<S: Store> Replica<S> {
    pub(crate) fn client_open_upload(
        &mut self,
        session: SessionId,
        params: OpenUploadParams,
    ) -> ApiResult<OpenUploadResult> {
        let replace = open_replacement(&params)?;
        self.client_upload_resume_step();
        self.retire_captured_slot_for_reopen(session, &params)?;
        if let Some(result) = self.client_upload_open_existing(session, &params) {
            return result;
        }
        let context =
            self.attachment_upload_authority_context(session, &params.path, params.size, replace)?;
        let owner = context.resume_owner(params.transfer);
        if let Some(reference) = self
            .client_resume_reference(owner)
            .map_err(super::submit::store_err)?
        {
            return self.begin_client_upload_resume(session, params, context, reference);
        }
        let request = params.clone();
        let native = crate::HostedAttachmentTransferParams {
            transfer: params.transfer,
            path: params.path,
            size: params.size,
            digest: params.digest,
            mutation: params.mutation_id,
            replace,
        };
        let (mutation, file) = self.start_attachment_region_upload(session, native)?;
        let result = self
            .with_client_files(|r, io| {
                if io.upload.is_some() {
                    return Err(crate::file_io::busy());
                }
                r.attachment_region_progress(session, &mutation)?;
                let lease = io
                    .region
                    .acquire(RegionOwner::Upload { session, mutation })
                    .ok_or_else(crate::file_io::busy)?;
                io.upload = Some(UploadLane::Active(Box::new(UploadWindow {
                    session,
                    transfer: params.transfer,
                    mutation,
                    file,
                    request,
                    size: params.size,
                    lease,
                    start: 0,
                    mask: 0,
                    staged: false,
                })));
                Ok(())
            })
            .and_then(|()| self.start_client_upload_journal(session, &mutation));
        if let Err(error) = result {
            self.client_upload_close(session);
            let _ = self.close_attachment_create(session, &mutation);
            return Err(error);
        }
        Err(super::client_upload_resume::pending())
    }

    pub(crate) fn client_upload_chunk(
        &mut self,
        session: SessionId,
        params: UploadChunkParams,
    ) -> ApiResult<u64> {
        let UploadChunkParams {
            transfer,
            index,
            bytes,
        } = params;
        let bytes = zeroize::Zeroizing::new(bytes.0);
        self.client_upload_prune();
        self.with_client_files(|r, io| {
            let lane = io
                .upload
                .as_mut()
                .ok_or_else(|| ErrorCode::NotFound.err("no active file upload"))?;
            if lane.session() != session {
                return Err(ErrorCode::Forbidden.err("file upload belongs to another session"));
            }
            let up = lane.active_mut()?;
            if up.session != session || up.transfer != transfer {
                return Err(ErrorCode::Forbidden.err_with_reason(
                    "attachment_upload_owner_mismatch",
                    "file upload belongs to another session",
                ));
            }
            if let Some(crate::AttachmentUploadStatus::Failed(problem)) =
                r.attachment_upload_status(&up.mutation)
            {
                return Err(problem.into());
            }
            let progress = r.attachment_region_progress(session, &up.mutation)?;
            if progress.checkpoint.is_none() {
                return Err(super::client_upload_resume::pending());
            }
            if up.staged && up.start < up.size {
                if progress.committed_chunks * WINDOW <= up.start {
                    return Err(ErrorCode::Unavailable.err_with_reason(
                        "file_upload_pending",
                        "native upload window is awaiting its journal commit",
                    ));
                }
                up.start = (up.start + WINDOW).min(up.size);
                up.mask = 0;
                up.staged = up.start == up.size;
            }
            let offset = index
                .checked_mul(FRAGMENT)
                .ok_or_else(|| ErrorCode::InvalidRequest.err("file chunk index overflow"))?;
            if offset >= up.size || bytes.len() as u64 != FRAGMENT.min(up.size - offset) {
                return Err(ErrorCode::InvalidRequest.err("file chunk size or index is invalid"));
            }
            // Previously committed indexes are immutable; retransmission does not replace them.
            if offset < up.start {
                return Ok(up.start);
            }
            if offset >= up.start + WINDOW {
                return Err(ErrorCode::Unavailable.err_with_reason(
                    "file_upload_pending",
                    "fragment is ahead of the bounded upload window",
                ));
            }
            let slot = ((offset - up.start) / FRAGMENT) as u8;
            let bit = 1u8 << slot;
            let region = io
                .region
                .borrow(up.lease)
                .ok_or_else(|| ErrorCode::Internal.err("upload lost its region lease"))?;
            let at = (offset - up.start) as usize;
            if up.mask & bit != 0 {
                if region[at..at + bytes.len()] != *bytes {
                    return Err(ErrorCode::Conflict.err("retransmitted file chunk changed"));
                }
            } else {
                region[at..at + bytes.len()].copy_from_slice(&bytes);
                up.mask |= bit;
                r.attachment_region_accept_fragment(session, &up.mutation)?;
            }
            let plain = WINDOW.min(up.size - up.start);
            let count = plain.div_ceil(FRAGMENT);
            let expected = ((1u16 << count) - 1) as u8;
            let accepted = up.start
                + (0..count)
                    .filter(|slot| up.mask & (1 << slot) != 0)
                    .map(|slot| FRAGMENT.min(plain - slot * FRAGMENT))
                    .sum::<u64>();
            if up.mask == expected {
                let span =
                    r.push_attachment_region_chunk(session, &up.mutation, region, plain as usize)?;
                r.put_attachment_region_chunk(session, &up.mutation, region, span)?;
                up.staged = true;
            }
            Ok(accepted)
        })
    }

    pub(crate) fn client_commit_upload(
        &mut self,
        session: SessionId,
        transfer: Uuid,
    ) -> ApiResult<mdbn_wire::client::Receipt> {
        self.with_client_files(|r, io| {
            let lane = io
                .upload
                .as_mut()
                .ok_or_else(|| ErrorCode::NotFound.err("no active file upload"))?;
            if lane.session() != session {
                return Err(ErrorCode::Forbidden.err("file upload belongs to another session"));
            }
            if lane.transfer() != transfer {
                return Err(ErrorCode::Forbidden.err("file upload belongs to another transfer"));
            }
            if let Some(receipt) = r.client_captured_upload_receipt(lane) {
                if let Some(window) = lane.active() {
                    io.region.release(window.lease);
                }
                return receipt;
            }
            let up = lane.active_mut()?;
            match r.attachment_upload_status(&up.mutation) {
                Some(crate::AttachmentUploadStatus::Captured(_)) => {
                    let receipt = crate::api::ClientApi::receipt(r, session, up.mutation)?;
                    io.region.release(up.lease);
                    return Ok(receipt);
                }
                Some(crate::AttachmentUploadStatus::Failed(problem)) => {
                    io.region.release(up.lease);
                    return Err(problem.into());
                }
                _ => {}
            }
            let progress = r.attachment_region_progress(session, &up.mutation)?;
            if progress.checkpoint.is_none() {
                return Err(super::client_upload_resume::pending());
            }
            if up.size == 0 && !up.staged {
                let region = io
                    .region
                    .borrow(up.lease)
                    .ok_or_else(|| ErrorCode::Internal.err("upload lost its region lease"))?;
                let span = r.push_attachment_region_chunk(session, &up.mutation, region, 0)?;
                r.put_attachment_region_chunk(session, &up.mutation, region, span)?;
                up.staged = true;
            }
            if !up.staged || up.start + WINDOW < up.size {
                return Err(ErrorCode::InvalidRequest.err("file upload has missing fragments"));
            }
            if progress.committed_chunks == up.size.div_ceil(WINDOW).max(1) {
                r.commit_attachment_region_upload(session, &up.mutation)?;
            }
            // Internal deferral signal consumed by Frames, not a synthetic receipt.
            Err(ErrorCode::Unavailable
                .err_with_reason("file_upload_pending", "native file capture is pending"))
        })
    }

    pub(crate) fn client_upload_prune(&mut self) {
        self.client_upload_resume_prune();
        let stale = self
            .client_files
            .as_ref()
            .and_then(|io| io.upload.as_ref())
            .and_then(UploadLane::active)
            .filter(|u| {
                !matches!(
                    self.attachment_upload_status(&u.mutation),
                    Some(crate::AttachmentUploadStatus::Captured(_))
                ) && (self
                    .attachment_region_progress(u.session, &u.mutation)
                    .is_err()
                    || matches!(
                        self.attachment_upload_status(&u.mutation),
                        Some(crate::AttachmentUploadStatus::Failed(_))
                    ))
            })
            .map(|u| u.session);
        if let Some(session) = stale {
            // Retain the exact native terminal result until the owning RPC
            // observes it. Scrub/release only this lease, never a successor.
            if let Some(io) = self.client_files.as_mut()
                && let Some(up) = io.upload.as_ref().and_then(UploadLane::active)
                && up.session == session
            {
                io.region.release(up.lease);
            }
        }
    }

    pub(crate) fn client_abort_upload(
        &mut self,
        session: SessionId,
        transfer: Uuid,
    ) -> ApiResult<()> {
        let lane = self
            .client_files
            .as_ref()
            .and_then(|io| io.upload.as_ref())
            .ok_or_else(|| ErrorCode::NotFound.err("no active file upload"))?;
        if lane.session() != session || lane.transfer() != transfer {
            return Err(ErrorCode::Forbidden.err_with_reason(
                "attachment_upload_owner_mismatch",
                "file upload belongs to another session or transfer",
            ));
        }
        let owner = match lane {
            UploadLane::Active(up) => self.client_resume_owner(session, up.mutation)?,
            UploadLane::Opening(open) => self.client_resume_open_owner(open)?,
        };
        // Fencing may close sessions: do not do it while I/O is borrowed out.
        if self
            .client_captured_reference(owner)
            .map_err(super::submit::store_err)?
            .is_none()
            && self
                .client_resume_reference(owner)
                .map_err(super::submit::store_err)?
                .is_some()
            && let Err(error) = self.persist_client_resume_reference(owner, None)
        {
            if !matches!(error, crate::store::StoreError::CommitAborted(_)) {
                self.terminal_store_fault("file_upload_checkpoint_store_unknown");
            }
            return Err(super::submit::store_err(error));
        }
        self.with_client_files(
            |r, io| match io.upload.take().expect("exact lane checked") {
                UploadLane::Active(up) => {
                    r.close_attachment_create(session, &up.mutation)?;
                    io.region.release(up.lease);
                    Ok(())
                }
                UploadLane::Opening(open) => r.client_resume_close_lane(io, open),
            },
        )
    }
    pub(crate) fn client_upload_tracks(&self, session: SessionId, mutation: Uuid) -> bool {
        self.client_files
            .as_ref()
            .and_then(|io| io.upload.as_ref())
            .and_then(UploadLane::active)
            .is_some_and(|up| up.session == session && up.mutation == mutation)
    }

    pub(super) fn client_upload_close(&mut self, session: SessionId) {
        self.with_client_files(|r, io| {
            if io.upload.as_ref().is_some_and(|u| u.session() == session) {
                match io.upload.take().unwrap() {
                    UploadLane::Active(up) => {
                        let _ = r.close_attachment_create(session, &up.mutation);
                        io.region.release(up.lease);
                    }
                    UploadLane::Opening(open) => {
                        let _ = r.client_resume_close_lane(io, open);
                    }
                }
            }
        });
    }
}
