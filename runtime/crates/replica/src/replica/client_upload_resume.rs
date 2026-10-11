//! Deferred native open: original authenticated journal GET, then leased rehash.
use super::client_uploads::{FRAGMENT, UploadWindow, WINDOW};
use super::hosted_attachment_upload::AttachmentCreateContext;
use super::*;
use crate::api::{ApiResult, ErrorCode, SessionId};
use crate::crypto::chunked_blob::upload_resume::UploadResumeRefV1;
use crate::file_io::RegionOwner;
use crate::log::{CallId, LogReply, LogRequest, LogResponse};
use mdbn_wire::client::{OpenUploadParams, OpenUploadResult, Problem};
use mdbn_wire::common::Hash;

pub(super) enum UploadLane {
    Active(Box<UploadWindow>),
    Opening(Box<ResumeOpen>),
}
pub(super) struct ResumeOpen {
    pub(super) session: SessionId,
    pub(super) params: OpenUploadParams,
    context: AttachmentCreateContext,
    reference: UploadResumeRefV1,
    started: i64,
    phase: ResumePhase,
}
enum ResumePhase {
    Journal(CallId),
    Rehash {
        window: Box<UploadWindow>,
        call: Option<(CallId, u64, Hash, u64)>,
    },
    Captured {
        mutation: Uuid,
        opened: OpenUploadResult,
    },
    Failed(Problem),
}
pub(super) fn pending() -> crate::api::ApiError {
    ErrorCode::Unavailable.err_with_reason("file_upload_pending", "native upload resume is pending")
}
impl UploadLane {
    pub(super) fn blocks_read(&self) -> bool {
        matches!(self, Self::Opening(open) if !matches!(open.phase, ResumePhase::Captured { .. }))
    }
    pub(super) fn active(&self) -> Option<&UploadWindow> {
        match self {
            Self::Active(window) => Some(window),
            _ => None,
        }
    }
    pub(super) fn active_mut(&mut self) -> ApiResult<&mut UploadWindow> {
        match self {
            Self::Active(window) => Ok(window),
            Self::Opening(open) => match &open.phase {
                ResumePhase::Failed(p) => Err(p.clone().into()),
                ResumePhase::Captured { .. } => Err(ErrorCode::Conflict.err_with_reason(
                    "file_upload_already_captured",
                    "captured file upload cannot accept more bytes",
                )),
                _ => Err(pending()),
            },
        }
    }
    pub(super) fn transfer(&self) -> Uuid {
        match self {
            Self::Active(window) => window.transfer,
            Self::Opening(open) => open.params.transfer,
        }
    }
    pub(super) fn session(&self) -> SessionId {
        match self {
            Self::Active(window) => window.session,
            Self::Opening(open) => open.session,
        }
    }
}
impl<S: Store> Replica<S> {
    pub(super) fn begin_client_upload_resume(
        &mut self,
        session: SessionId,
        params: OpenUploadParams,
        context: AttachmentCreateContext,
        reference: UploadResumeRefV1,
    ) -> ApiResult<OpenUploadResult> {
        if reference.context.collection != self.cfg.collection
            || reference.context.key_epoch != self.policy.epoch
        {
            return Err(ErrorCode::Unavailable.err_with_reason(
                "attachment_upload_scope_changed",
                "the stored resume epoch or collection is no longer current",
            ));
        }
        self.with_client_files(|r, io| {
            if io.upload.is_some() || !io.region.available() {
                return Err(crate::file_io::busy());
            }
            let call = r.queue(LogRequest::GetObject {
                collection: r.cfg.collection,
                address: reference.cipher_hash,
                range: None,
            });
            r.inflight
                .insert(call, super::append::Inflight::ClientUploadResume);
            io.upload = Some(UploadLane::Opening(Box::new(ResumeOpen {
                session,
                params,
                context,
                reference,
                started: r.now(),
                phase: ResumePhase::Journal(call),
            })));
            Err(pending())
        })
    }
    /// Terminal native slots are retired by idle cleanup or rejection. A live
    /// caller retry reauthenticates captured work, never resurrects its writer.
    pub(super) fn retire_captured_slot_for_reopen(
        &mut self,
        session: SessionId,
        params: &OpenUploadParams,
    ) -> ApiResult<()> {
        let captured_successor = self.with_client_files(|r, io| -> ApiResult<bool> {
            let Some(lane) = io.upload.as_ref() else {
                return Ok(false);
            };
            if lane.session() != session || lane.transfer() == params.transfer {
                return Ok(false);
            }
            match r.client_captured_upload_receipt(lane) {
                Some(actual) => {
                    actual?;
                    Ok(true)
                }
                None => Ok(false),
            }
        })?;
        if captured_successor {
            self.client_upload_close(session);
            return Ok(());
        }
        let Some(window) = self
            .client_files
            .as_ref()
            .and_then(|io| io.upload.as_ref())
            .and_then(UploadLane::active)
        else {
            return Ok(());
        };
        if window.session != session
            || window.request != *params
            || !matches!(
                self.attachment_upload_status(&window.mutation),
                None | Some(crate::AttachmentUploadStatus::Failed(_))
            )
        {
            return Ok(());
        }
        let context = self.attachment_upload_authority_context(
            session,
            &params.path,
            params.size,
            super::client_uploads::open_replacement(params)?,
        )?;
        if self
            .client_captured_reference(context.resume_owner(params.transfer))
            .map_err(super::submit::store_err)?
            .is_some()
        {
            self.client_upload_close(session);
        }
        Ok(())
    }
    /// Returns only native original identities and known committed indexes.
    pub(super) fn client_upload_open_existing(
        &mut self,
        session: SessionId,
        params: &OpenUploadParams,
    ) -> Option<ApiResult<OpenUploadResult>> {
        self.client_files
            .as_ref()
            .and_then(|io| io.upload.as_ref())?;
        Some(self.with_client_files(|r, io| {
            let lane = io.upload.as_ref().expect("existing lane");
            if lane.session() != session {
                return Err(crate::file_io::busy());
            }
            let original = match lane {
                UploadLane::Active(w) => &w.request,
                UploadLane::Opening(o) => &o.params,
            };
            if original != params {
                return Err(ErrorCode::Conflict.err_with_reason(
                    "attachment_upload_scope_changed",
                    "the live upload request changed",
                ));
            }
            match lane {
                UploadLane::Opening(o) => match &o.phase {
                    ResumePhase::Failed(p) => Err(p.clone().into()),
                    ResumePhase::Captured { opened, .. } => {
                        r.resume_allowed(o)?;
                        r.captured_resume_receipt(o)?;
                        Ok(opened.clone())
                    }
                    _ => Err(pending()),
                },
                UploadLane::Active(w) => {
                    if let Some(opened) = r.client_live_captured_open(session, w.mutation) {
                        io.region.release(w.lease);
                        return opened;
                    }
                    if let Some(crate::AttachmentUploadStatus::Failed(problem)) =
                        r.attachment_upload_status(&w.mutation)
                    {
                        return Err(problem.into());
                    }
                    let progress = r.attachment_region_progress(session, &w.mutation)?;
                    if progress.checkpoint.is_none() {
                        return Err(pending());
                    }
                    let bytes = (progress.committed_chunks * WINDOW).min(w.size);
                    Ok(OpenUploadResult {
                        transfer: w.transfer,
                        chunk_size: FRAGMENT,
                        received: (0..bytes.div_ceil(FRAGMENT)).collect(),
                        expires_at: progress.expires_at_ms as i64,
                        file_id: Some(w.file),
                    })
                }
            }
        }))
    }
    fn resume_allowed(&self, open: &ResumeOpen) -> ApiResult<()> {
        if matches!(open.phase, ResumePhase::Journal(_))
            && open.started.saturating_add(60_000) <= self.now()
        {
            return Err(ErrorCode::Unavailable
                .err_with_reason("attachment_resume_unavailable", "resume open expired"));
        }
        match &open.phase {
            ResumePhase::Journal(_) | ResumePhase::Captured { .. } => self
                .attachment_upload_authority_check(
                    &open.context,
                    &open.params.path,
                    open.params.size,
                    &open.context.file(),
                ),
            ResumePhase::Rehash { window, .. } => self
                .attachment_rehash_need(open.session, &window.mutation)
                .map(|_| ()),
            ResumePhase::Failed(p) => Err(p.clone().into()),
        }
    }
    fn retire_resume_call(&mut self, id: CallId) {
        self.inflight.remove(&id);
        self.forget_log_reply_scope(id);
        self.calls.retain(|call| call.id != id);
    }
    fn fail_resume(
        &mut self,
        io: &mut super::client_files::ClientFiles,
        open: &mut ResumeOpen,
        error: crate::api::ApiError,
    ) {
        match &open.phase {
            ResumePhase::Journal(call) => self.retire_resume_call(*call),
            ResumePhase::Rehash { window, call } => {
                if let Some((id, ..)) = call {
                    self.retire_resume_call(*id);
                }
                io.region.release(window.lease);
                let _ = self.close_attachment_create(open.session, &window.mutation);
            }
            ResumePhase::Captured { .. } | ResumePhase::Failed(_) => {}
        }
        open.phase = ResumePhase::Failed(error.into_problem());
    }
    /// Retire exact scopes before an authenticated decoder can see stale bytes.
    pub(crate) fn client_upload_resume_prune(&mut self) {
        if !self
            .client_files
            .as_ref()
            .and_then(|io| io.upload.as_ref())
            .is_some_and(|lane| matches!(lane, UploadLane::Opening(_)))
        {
            return;
        }
        self.with_client_files(|r, io| {
            let Some(UploadLane::Opening(mut open)) = io.upload.take() else {
                unreachable!("opening lane checked");
            };
            if !matches!(open.phase, ResumePhase::Failed(_)) {
                let call = match &open.phase {
                    ResumePhase::Journal(id) => Some(*id),
                    ResumePhase::Rehash { call, .. } => call.as_ref().map(|(id, ..)| *id),
                    _ => None,
                };
                let result = if call.is_some_and(|id| !r.inflight.contains_key(&id)) {
                    Err(ErrorCode::Unavailable.err_with_reason(
                        "attachment_resume_unavailable",
                        "the original resume call was retired",
                    ))
                } else {
                    r.resume_allowed(&open)
                };
                if let Err(error) = result {
                    r.fail_resume(io, &mut open, error);
                }
            }
            io.upload = Some(UploadLane::Opening(open));
        });
    }
    pub(crate) fn on_client_upload_resume_reply(&mut self, id: CallId, reply: LogReply) {
        self.with_client_files(|r, io| {
            let Some(lane) = io.upload.take() else {
                return;
            };
            let UploadLane::Opening(mut open) = lane else {
                io.upload = Some(lane);
                return;
            };
            let expected = match &open.phase {
                ResumePhase::Journal(call) if *call == id => {
                    Some((open.reference.cipher_hash, open.reference.sealed_bytes))
                }
                ResumePhase::Rehash {
                    call: Some((call, _, address, size)),
                    ..
                } if *call == id => Some((*address, *size)),
                _ => None,
            };
            let Some((address, expected_size)) = expected else {
                io.upload = Some(UploadLane::Opening(open));
                return;
            };
            let result = (|| {
                r.resume_allowed(&open)?;
                let (bytes, size, checksum) = match reply {
                    Ok(LogResponse::GetObject {
                        bytes,
                        size,
                        checksum,
                    }) => (zeroize::Zeroizing::new(bytes), size, checksum),
                    _ => {
                        return Err(ErrorCode::Unavailable.err_with_reason(
                            "attachment_resume_unavailable",
                            "the original resume object could not be read",
                        ));
                    }
                };
                if size != expected_size
                    || bytes.len() as u64 != size
                    || checksum != address
                    || mdbn_wire::hash::sha256(&bytes) != address
                {
                    return Err(ErrorCode::Unavailable.err_with_reason(
                        "attachment_resume_unavailable",
                        "the resume object size or checksum changed",
                    ));
                }
                match &mut open.phase {
                    ResumePhase::Journal(_) => {
                        let mut bytes = bytes;
                        let params = crate::HostedAttachmentTransferParams {
                            transfer: open.params.transfer,
                            path: open.params.path.clone(),
                            size: open.params.size,
                            digest: open.params.digest,
                            mutation: open.params.mutation_id,
                            replace: super::client_uploads::open_replacement(&open.params)?,
                        };
                        let resume = r.authenticate_attachment_region_resume(
                            open.session,
                            &params,
                            open.reference,
                            &mut bytes,
                        )?;
                        let owner = open.context.resume_owner(open.params.transfer);
                        if let Some(captured) = r
                            .client_captured_reference(owner)
                            .map_err(super::submit::store_err)?
                        {
                            if captured != open.reference {
                                return Err(ErrorCode::Unavailable.err_with_reason(
                                    "attachment_resume_unavailable",
                                    "captured journal binding changed",
                                ));
                            }
                            let metadata = resume.metadata();
                            if metadata.chunks.len() as u64
                                != metadata.total_plain_bytes.div_ceil(WINDOW).max(1)
                            {
                                return Err(ErrorCode::Internal
                                    .err("captured journal has incomplete native chunks"));
                            }
                            let mutation = metadata.mutation;
                            let opened = OpenUploadResult {
                                transfer: open.params.transfer,
                                chunk_size: FRAGMENT,
                                received: (0..metadata.total_plain_bytes.div_ceil(FRAGMENT))
                                    .collect(),
                                expires_at: metadata.expires_at_ms as i64,
                                file_id: Some(metadata.file),
                            };
                            open.context = r.attachment_resume_authority_context(
                                open.session,
                                &params.path,
                                params.size,
                                &resume,
                                params.replace,
                            )?;
                            open.phase = ResumePhase::Captured { mutation, opened };
                            r.captured_resume_receipt(&open)?;
                            return Ok(());
                        }
                        let (mutation, file) = r.start_authenticated_attachment_region_resume(
                            open.session,
                            params,
                            open.reference,
                            resume,
                        )?;
                        r.stage_client_capture_reference(open.session, mutation, open.reference)?;
                        let Some(lease) = io.region.acquire(RegionOwner::Rehash {
                            session: open.session,
                            mutation,
                        }) else {
                            let _ = r.close_attachment_create(open.session, &mutation);
                            return Err(crate::file_io::busy());
                        };
                        open.phase = ResumePhase::Rehash {
                            window: Box::new(UploadWindow {
                                session: open.session,
                                transfer: open.params.transfer,
                                mutation,
                                file,
                                request: open.params.clone(),
                                size: open.params.size,
                                lease,
                                start: 0,
                                mask: 0,
                                staged: false,
                            }),
                            call: None,
                        };
                    }
                    ResumePhase::Rehash { window, call } => {
                        let (_, index, ..) = call.take().expect("exact original rehash call");
                        let region = io.region.borrow(window.lease).ok_or_else(|| {
                            ErrorCode::Internal.err("resume lost exact region lease")
                        })?;
                        if bytes.len() > region.len() {
                            return Err(
                                ErrorCode::Internal.err("native resume object exceeds backing")
                            );
                        }
                        region[..bytes.len()].copy_from_slice(&bytes);
                        r.supply_attachment_rehash(
                            open.session,
                            &window.mutation,
                            index,
                            &mut region[..bytes.len()],
                        )?;
                        io.region.scrub(window.lease);
                    }
                    ResumePhase::Captured { .. } | ResumePhase::Failed(_) => {
                        unreachable!("terminal phase has no call")
                    }
                }
                Ok(())
            })();
            if let Err(error) = result {
                r.fail_resume(io, &mut open, error);
            }
            io.upload = Some(UploadLane::Opening(open));
        });
        self.client_upload_resume_step();
    }
    pub(crate) fn client_upload_resume_step(&mut self) {
        self.client_upload_resume_prune();
        if !self
            .client_files
            .as_ref()
            .and_then(|io| io.upload.as_ref())
            .is_some_and(|lane| matches!(lane, UploadLane::Opening(_)))
        {
            return;
        }
        self.with_client_files(|r, io| {
            let Some(UploadLane::Opening(mut open)) = io.upload.take() else {
                unreachable!("opening lane checked");
            };
            if let ResumePhase::Rehash { window, call } = &mut open.phase
                && call.is_none()
            {
                match r.attachment_rehash_need(open.session, &window.mutation) {
                    Ok(Some((index, address, size))) => {
                        let id = r.queue(LogRequest::GetObject {
                            collection: r.cfg.collection,
                            address,
                            range: None,
                        });
                        r.inflight
                            .insert(id, super::append::Inflight::ClientUploadResume);
                        *call = Some((id, index, address, size));
                    }
                    Ok(None) => {
                        let progress = r
                            .attachment_region_progress(open.session, &window.mutation)
                            .expect("rehash check established current upload");
                        io.region.release(window.lease);
                        window.lease = io
                            .region
                            .acquire(RegionOwner::Upload {
                                session: open.session,
                                mutation: window.mutation,
                            })
                            .expect("exact lease was released");
                        window.start = (progress.committed_chunks * WINDOW).min(window.size);
                        window.staged =
                            progress.committed_chunks > 0 && window.start == window.size;
                        let ResumePhase::Rehash { window, .. } = open.phase else {
                            unreachable!();
                        };
                        io.upload = Some(UploadLane::Active(window));
                        return;
                    }
                    Err(error) => r.fail_resume(io, &mut open, error),
                }
            }
            io.upload = Some(UploadLane::Opening(open));
        });
    }
    fn captured_resume_receipt(
        &mut self,
        open: &ResumeOpen,
    ) -> ApiResult<mdbn_wire::client::Receipt> {
        self.resume_allowed(open)?;
        let ResumePhase::Captured { mutation, .. } = open.phase else {
            return Err(ErrorCode::Internal.err("receipt recovery requires authenticated capture"));
        };
        let owner = self.client_resume_open_owner(open)?;
        if self
            .client_captured_reference(owner)
            .map_err(super::submit::store_err)?
            != Some(open.reference)
        {
            return Err(ErrorCode::Unavailable.err_with_reason(
                "attachment_resume_unavailable",
                "captured journal binding changed",
            ));
        }
        self.client_actual_upload_receipt(open.session, mutation)
    }
    pub(super) fn client_captured_upload_receipt(
        &mut self,
        lane: &UploadLane,
    ) -> Option<ApiResult<mdbn_wire::client::Receipt>> {
        match lane {
            UploadLane::Opening(open) if matches!(open.phase, ResumePhase::Captured { .. }) => {
                Some(self.captured_resume_receipt(open))
            }
            UploadLane::Active(window) => self
                .client_live_captured_open(window.session, window.mutation)
                .map(|opened| {
                    opened?;
                    self.client_actual_upload_receipt(window.session, window.mutation)
                }),
            _ => None,
        }
    }
    pub(super) fn client_resume_open_owner(
        &self,
        open: &ResumeOpen,
    ) -> ApiResult<crate::crypto::chunked_blob::upload_resume::UploadResumeOwner> {
        self.attachment_create_caller_check(open.session, &open.context)?;
        Ok(open.context.resume_owner(open.params.transfer))
    }
    pub(super) fn client_resume_close_lane(
        &mut self,
        io: &mut super::client_files::ClientFiles,
        mut open: Box<ResumeOpen>,
    ) -> ApiResult<()> {
        self.attachment_create_caller_check(open.session, &open.context)?;
        self.fail_resume(
            io,
            &mut open,
            ErrorCode::Cancelled.err("native resume closed"),
        );
        Ok(())
    }
}
