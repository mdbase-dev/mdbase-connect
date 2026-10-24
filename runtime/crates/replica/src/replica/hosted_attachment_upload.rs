//! Canonical native attachment CREATE authority for real device/host/grant
//! subjects. Existing hosted entry points remain HOSTED+Grant only; transport
//! admission/resource ownership is also checked by the hosted caller after awaits.
//! Replacement of a live Ordinary File (same ID and path, `records.edit`, whole
//! revision CAS) uses the same authority with a replace destination check.
use super::Replica;
use crate::api::{ApiResult, ErrorCode, SessionAuth, SessionId};
use crate::crypto::chunked_blob::AttachmentLimits;
use crate::store::Store;
use mdbn_core::state::StateView;
use mdbn_wire::common::Uuid;
use mdbn_wire::policy::DeviceKind;

/// Native-derived identity/scope, never an adapter-supplied permit or file ID.
#[derive(Debug, Clone)]
pub(crate) struct AttachmentCreateContext {
    session: SessionId,
    subject: SessionAuth,
    device: Uuid,
    account: Uuid,
    collection: Uuid,
    wake: u64,
    generation: u64,
    epoch: u64,
    file: Uuid,
    path: String,
    total: u64,
    replace: Option<FileReplacement>,
}

/// Replace a live Ordinary File's content: its ID and the whole-plaintext
/// revision the caller last saw (required CAS).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileReplacement {
    /// The live file.
    pub file: Uuid,
    /// Its current whole-plaintext revision.
    pub if_revision: mdbn_wire::common::Hash,
}
impl AttachmentCreateContext {
    pub(crate) fn session(&self) -> SessionId {
        self.session
    }
    pub(crate) fn grant(&self) -> Option<Uuid> {
        match self.subject {
            SessionAuth::Grant { grant, .. } => Some(grant),
            SessionAuth::Host => None,
        }
    }
    pub(crate) fn file(&self) -> Uuid {
        self.file
    }
    pub(crate) fn replace(&self) -> Option<FileReplacement> {
        self.replace
    }
    fn capability(&self) -> &'static str {
        if self.replace.is_some() {
            crate::policy::capability::EDIT
        } else {
            crate::policy::capability::CREATE
        }
    }
    // Expected owner comes from native session admission, never journal claims.
    pub(crate) fn resume_owner(
        &self,
        transfer: Uuid,
    ) -> crate::crypto::chunked_blob::upload_resume::UploadResumeOwner {
        use crate::crypto::chunked_blob::upload_resume::{UploadResumeOwner, UploadResumeOwnerV1};
        match self.subject {
            SessionAuth::Grant { grant, client_pk } => UploadResumeOwnerV1 {
                grant,
                client_pk: mdbn_wire::common::B32(client_pk),
                account: self.account,
                transfer,
            }
            .into(),
            SessionAuth::Host => UploadResumeOwner::HostV2 {
                device: self.device,
                account: self.account,
                transfer,
            },
        }
    }
}
fn destination_exists() -> crate::api::ApiError {
    ErrorCode::Conflict.err_with_reason(
        "attachment_destination_exists",
        "the destination exists; replace it with its file ID and revision",
    )
}
impl<S: Store> Replica<S> {
    /// Pure caller identity check, also for owner-only cleanup after a refusal.
    pub(super) fn attachment_create_caller_check(
        &self,
        session: SessionId,
        context: &AttachmentCreateContext,
    ) -> ApiResult<()> {
        if session != context.session || self.session(session)?.auth != context.subject {
            return Err(ErrorCode::Forbidden.err_with_reason(
                "attachment_upload_owner_mismatch",
                "the upload belongs to another authenticated subject",
            ));
        }
        Ok(())
    }
    pub(super) fn hosted_attachment_upload_caller_check(
        &self,
        session: SessionId,
        context: &AttachmentCreateContext,
    ) -> ApiResult<()> {
        if !self.is_hosted() || !matches!(context.subject, SessionAuth::Grant { .. }) {
            return Err(ErrorCode::Forbidden.err("not a hosted grant upload"));
        }
        self.attachment_create_caller_check(session, context)
    }
    /// Original native-minted CREATE UUID and mutation from the existing bounded
    /// positional-source writer, not a post-confirmation path lookup. The source
    /// driver may read its first chunk at start; this is not wire open_upload.
    pub fn start_attachment_create(
        &mut self,
        session: SessionId,
        path: String,
        mutation: Option<Uuid>,
        source: Box<dyn super::attachment_upload::AttachmentSource>,
    ) -> ApiResult<(Uuid, Uuid)> {
        let context = self.attachment_create_context(session, &path, source.len(), None)?;
        let file = context.file();
        let params = super::attachment_upload::AttachmentUploadParams {
            file,
            path,
            if_revision: None,
            mutation,
        };
        let mutation = self.start_upload_with(
            params,
            source,
            super::attachment_upload::Origin {
                delegated: Some(context),
                ..Default::default()
            },
        )?;
        Ok((mutation, file))
    }
    /// Existing HOSTED+Grant source seam, backed by the same native writer.
    pub fn start_hosted_attachment_upload(
        &mut self,
        session: SessionId,
        path: String,
        mutation: Uuid,
        source: Box<dyn super::attachment_upload::AttachmentSource>,
    ) -> ApiResult<Uuid> {
        self.require_hosted_attachment_subject(session)?;
        self.start_attachment_create(session, path, Some(mutation), source)
            .map(|(mutation, _)| mutation)
    }
    pub(super) fn require_hosted_attachment_subject(&self, session: SessionId) -> ApiResult<()> {
        self.require(session, crate::policy::capability::CREATE)?;
        if !self.is_hosted() || !matches!(self.session(session)?.auth, SessionAuth::Grant { .. }) {
            return Err(
                ErrorCode::Forbidden.err("hosted uploads require a hosted profile and app grant")
            );
        }
        Ok(())
    }
    pub(super) fn attachment_create_context(
        &mut self,
        session: SessionId,
        path: &str,
        total: u64,
        replace: Option<FileReplacement>,
    ) -> ApiResult<AttachmentCreateContext> {
        let context = self.attachment_upload_authority_context(session, path, total, replace)?;
        self.attachment_create_check(&context, path, total, &context.file)?;
        Ok(context)
    }
    /// Current upload subject/scope, without claiming a new CREATE destination.
    pub(super) fn attachment_upload_authority_context(
        &mut self,
        session: SessionId,
        path: &str,
        total: u64,
        replace: Option<FileReplacement>,
    ) -> ApiResult<AttachmentCreateContext> {
        self.require(
            session,
            if replace.is_some() {
                crate::policy::capability::EDIT
            } else {
                crate::policy::capability::CREATE
            },
        )?;
        let subject = self.session(session)?.auth.clone();
        let account = match subject {
            SessionAuth::Grant { grant, client_pk } => {
                self.grant_for_client(&grant, &client_pk)
                    .ok_or_else(|| ErrorCode::Unauthenticated.err("the grant is no longer active"))?
                    .account
            }
            SessionAuth::Host => {
                self.policy
                    .devices
                    .get(&self.cfg.device_id)
                    .ok_or_else(|| {
                        ErrorCode::Unavailable.err("the writing device is not enrolled")
                    })?
                    .account
            }
        };
        let context = AttachmentCreateContext {
            session,
            subject,
            device: self.cfg.device_id,
            account,
            collection: self.cfg.collection,
            wake: self.wake_instance(),
            generation: self.store_generation,
            epoch: self.policy.epoch,
            file: match replace {
                Some(r) => r.file,
                None => self.mint_v7(),
            },
            path: path.to_owned(),
            total,
            replace,
        };
        self.attachment_upload_authority_check(&context, path, total, &context.file)?;
        Ok(context)
    }
    /// Restore ONLY an identity from authenticated metadata for the current native owner.
    pub(super) fn attachment_resume_context(
        &mut self,
        session: SessionId,
        path: &str,
        total: u64,
        resume: &crate::crypto::chunked_blob::upload_resume::AuthenticatedUploadResumeV1,
        replace: Option<FileReplacement>,
    ) -> ApiResult<AttachmentCreateContext> {
        let context =
            self.attachment_resume_authority_context(session, path, total, resume, replace)?;
        self.attachment_create_check(&context, path, total, &context.file)?;
        Ok(context)
    }
    /// Authenticated original identity for receipt recovery, not permission to CREATE.
    pub(super) fn attachment_resume_authority_context(
        &mut self,
        session: SessionId,
        path: &str,
        total: u64,
        resume: &crate::crypto::chunked_blob::upload_resume::AuthenticatedUploadResumeV1,
        replace: Option<FileReplacement>,
    ) -> ApiResult<AttachmentCreateContext> {
        let metadata = resume.metadata();
        // The journal binds the original mode, replaced file and revision; the
        // reopening request must restate them exactly (an old or create
        // journal never gains replacement intent, nor the reverse).
        if metadata.path != path
            || metadata.replace_revision != replace.map(|r| r.if_revision)
            || replace.is_some_and(|r| r.file != metadata.file)
            || metadata.total_plain_bytes != total
            || metadata.context.collection != self.cfg.collection
            || metadata.context.key_epoch != self.policy.epoch
        {
            return Err(ErrorCode::Conflict.err_with_reason(
                "attachment_upload_scope_changed",
                "the resumed upload context changed",
            ));
        }
        let mut context =
            self.attachment_upload_authority_context(session, path, total, replace)?;
        if context.resume_owner(metadata.owner.transfer()) != metadata.owner {
            return Err(ErrorCode::Unauthenticated.err("the resumed upload owner changed"));
        }
        context.file = metadata.file;
        self.attachment_upload_authority_check(&context, path, total, &context.file)?;
        Ok(context)
    }
    /// Existing hosted fence remains mandatory for the hosted region/resume seam.
    pub(crate) fn hosted_attachment_create_check(
        &self,
        context: &AttachmentCreateContext,
        path: &str,
        total: u64,
        file: &Uuid,
    ) -> ApiResult<()> {
        self.require_hosted_attachment_subject(context.session)?;
        self.attachment_create_check(context, path, total, file)
    }
    /// Current authority at every native source/object/capture boundary.
    pub(crate) fn attachment_create_check(
        &self,
        context: &AttachmentCreateContext,
        path: &str,
        total: u64,
        file: &Uuid,
    ) -> ApiResult<()> {
        self.attachment_upload_authority_check(context, path, total, file)?;
        match context.replace {
            Some(r) => self.attachment_replace_destination_check(path, file, &r),
            None => self.attachment_create_destination_check(path, file),
        }
    }
    pub(super) fn attachment_upload_authority_check(
        &self,
        context: &AttachmentCreateContext,
        path: &str,
        total: u64,
        file: &Uuid,
    ) -> ApiResult<()> {
        if context.collection != self.cfg.collection
            || context.wake != self.wake_instance()
            || context.generation != self.store_generation
            || context.device != self.cfg.device_id
            || context.epoch != self.policy.epoch
            || context.path != path
            || context.file != *file
            || context.total != total
        {
            return Err(ErrorCode::Unavailable.err_with_reason(
                "attachment_upload_scope_changed",
                "the upload no longer belongs to this scope and epoch",
            ));
        }
        let hosted_identity = self
            .policy
            .devices
            .get(&context.device)
            .is_some_and(|d| d.kind == DeviceKind::Hosted);
        if self.is_hosted() != hosted_identity
            || self.local_only()
            || self.cfg.key_grants_only
            || !self.hosted_serving()
            || !self.policy.device_can_write(&context.device)
            || (self.is_hosted()
                && (!matches!(context.subject, SessionAuth::Grant { .. })
                    || !matches!(
                        self.verified_hosted_admission(),
                        super::HostedAdmission::Verified(_)
                    )))
        {
            return Err(ErrorCode::Unavailable.err_with_reason(
                "attachment_writer_unavailable",
                "the native attachment writer is unavailable",
            ));
        }
        if self.key_untrusted
            || self.policy.frozen
            || self.policy.rekey_required
            || self.sealer.current_epoch() != Some(context.epoch)
        {
            return Err(ErrorCode::Unavailable.err_with_reason(
                "waiting_for_key",
                "no current write key for this collection",
            ));
        }
        self.require(context.session, context.capability())?;
        if context.replace.is_some_and(|r| r.file != *file) {
            return Err(ErrorCode::Unavailable.err_with_reason(
                "attachment_upload_scope_changed",
                "the upload no longer names the replaced file",
            ));
        }
        self.attachment_create_caller_check(context.session, context)?;
        let account = match context.subject {
            SessionAuth::Grant { grant, client_pk } => {
                self.grant_for_client(&grant, &client_pk)
                    .ok_or_else(|| ErrorCode::Unauthenticated.err("the grant is no longer active"))?
                    .account
            }
            SessionAuth::Host => {
                self.policy
                    .devices
                    .get(&context.device)
                    .ok_or_else(|| {
                        ErrorCode::Unavailable.err("the writing device is not enrolled")
                    })?
                    .account
            }
        };
        if account != context.account || !self.file_visible(context.session, path) {
            return Err(ErrorCode::Forbidden.err_with_reason(
                "file_folders",
                "the upload is outside the current subject scope",
            ));
        }
        if total > AttachmentLimits::default().max_file_bytes {
            return Err(ErrorCode::TooLarge.err("attachment exceeds the file limit"));
        }
        mdbn_core::paths::check_path(path)
            .map_err(|_| ErrorCode::InvalidRequest.err("invalid attachment destination path"))?;
        let catalog = &self.catalog;
        if catalog.is_record_path(path)
            || catalog.is_resource_path(path)
            || catalog.is_excluded(path)
        {
            return Err(ErrorCode::InvalidRequest.err_with_reason(
                "not_a_file_path",
                "the upload destination is not an included file path",
            ));
        }
        Ok(())
    }
    /// The replaced file is the live Ordinary File `file` at exactly `path`,
    /// with whole revision `if_revision` and no pending local change.
    fn attachment_replace_destination_check(
        &self,
        path: &str,
        file: &Uuid,
        replace: &FileReplacement,
    ) -> ApiResult<()> {
        let row = self
            .store
            .file(file)
            .map_err(super::submit::store_err)?
            .ok_or_else(|| ErrorCode::NotFound.err("no such file to replace"))?;
        if row.kind != mdbn_wire::unindexed_markdown::FileKindV1::Ordinary || row.path != path {
            return Err(ErrorCode::Conflict.err_with_reason(
                "attachment_replace_target_changed",
                "the replaced file is not an ordinary file at this path",
            ));
        }
        let reserved_id = crate::plan::id_key(file);
        let reserved_path = format!("p:{}", mdbn_core::paths::path_key(path));
        if self.layer.touches(&crate::convert::uuid(file))
            || self.pending_keys.values().any(|keys| {
                keys.iter()
                    .any(|key| key == &reserved_id || key == &reserved_path)
            })
        {
            return Err(ErrorCode::Conflict.err_with_reason(
                "attachment_replace_pending",
                "the replaced file has a pending local change",
            ));
        }
        if row.content.plain_hash() != replace.if_revision {
            return Err(ErrorCode::Conflict.err_with_reason(
                crate::api::conflict_reason::REVISION,
                "the file changed since the given revision",
            ));
        }
        Ok(())
    }
    fn attachment_create_destination_check(&self, path: &str, file: &Uuid) -> ApiResult<()> {
        if self
            .store
            .file(file)
            .map_err(super::submit::store_err)?
            .is_some()
            || self
                .store
                .record(file)
                .map_err(super::submit::store_err)?
                .is_some()
            || self
                .store
                .tombstone(file)
                .map_err(super::submit::store_err)?
                .is_some()
            || self.layer.touches(&crate::convert::uuid(file))
        {
            return Err(destination_exists());
        }
        let path_key = mdbn_core::paths::path_key(path);
        let reserved_path = format!("p:{path_key}");
        let reserved_id = crate::plan::id_key(file);
        if self.pending_keys.values().any(|keys| {
            keys.iter()
                .any(|key| key == &reserved_path || key == &reserved_id)
        }) {
            return Err(destination_exists());
        }
        let view = crate::plan::StoreView::new(&self.store, self.catalog.clone());
        let layer = crate::layer::LayerView {
            base: &view,
            layer: &self.layer,
        };
        if view.at_path_key(&path_key).is_some() || layer.at_path_key(&path_key).is_some() {
            return Err(destination_exists());
        }
        if let Some(error) = view.error() {
            return Err(super::submit::store_err(error));
        }
        Ok(())
    }
}
