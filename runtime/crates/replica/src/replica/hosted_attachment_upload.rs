//! Delegated hosted attachment CREATE authority. This is not a host permit:
//! Worker admission/resource ownership must also be rechecked after every await.
//! Replacement stays closed until the required-prior Op18 path is qualified.

use mdbn_core::state::StateView;
use mdbn_wire::common::Uuid;

use super::Replica;
use crate::api::{ApiResult, ErrorCode, SessionAuth, SessionId};
use crate::crypto::chunked_blob::AttachmentLimits;
use crate::store::Store;

/// Native-owned context for one new-file upload, never a caller-selected grant,
/// file ID, epoch or authorization result. Contains no content or held key.
#[derive(Debug, Clone)]
pub(crate) struct DelegatedAttachmentCreate {
    session: SessionId,
    grant: Uuid,
    client_pk: [u8; 32],
    account: Uuid,
    collection: Uuid,
    wake: u64,
    epoch: u64,
    file: Uuid,
    path: String,
    total: u64,
}

impl DelegatedAttachmentCreate {
    pub(crate) fn session(&self) -> SessionId {
        self.session
    }
    pub(crate) fn grant(&self) -> Uuid {
        self.grant
    }
    pub(crate) fn file(&self) -> Uuid {
        self.file
    }
    pub(crate) fn resume_owner(
        &self,
        transfer: Uuid,
    ) -> crate::crypto::chunked_blob::upload_resume::UploadResumeOwnerV1 {
        crate::crypto::chunked_blob::upload_resume::UploadResumeOwnerV1 {
            grant: self.grant,
            client_pk: mdbn_wire::common::B32(self.client_pk),
            account: self.account,
            transfer,
        }
    }
}

fn replacement_unsupported() -> crate::api::ApiError {
    ErrorCode::UpgradeRequired.err_with_reason(
        "attachment_replace_requires_op18",
        "hosted attachment replacement is unsupported until Op18",
    )
}

impl<S: Store> Replica<S> {
    /// Authenticated caller identity, not the stored owner's continuing permit.
    /// Also used for owner-only cleanup after policy/health/expiry refusal.
    pub(super) fn hosted_attachment_upload_caller_check(
        &self,
        session: SessionId,
        context: &DelegatedAttachmentCreate,
    ) -> ApiResult<()> {
        if session != context.session {
            return Err(ErrorCode::Forbidden.err_with_reason(
                "attachment_upload_owner_mismatch",
                "the upload belongs to another authenticated session",
            ));
        }
        match self.session(session)?.auth {
            SessionAuth::Grant { grant, client_pk }
                if grant == context.grant && client_pk == context.client_pk =>
            {
                Ok(())
            }
            _ => Err(ErrorCode::Forbidden.err_with_reason(
                "attachment_upload_owner_mismatch",
                "the upload belongs to another authenticated subject",
            )),
        }
    }
    /// Start a new-file attachment upload for a Noise-authenticated app grant.
    /// The adapter owns the bounded source; neither file ID nor grant is supplied
    /// by the caller. This seam alone does not enable the hosted wire upload API.
    /// Storage quota is authoritative at LS PUT/commit, before capture.
    pub fn start_hosted_attachment_upload(
        &mut self,
        session: SessionId,
        path: String,
        mutation: Uuid,
        source: Box<dyn super::attachment_upload::AttachmentSource>,
    ) -> ApiResult<Uuid> {
        let context = self.hosted_attachment_create_context(session, &path, source.len())?;
        let params = super::attachment_upload::AttachmentUploadParams {
            file: context.file(),
            path,
            if_revision: None,
            mutation: Some(mutation),
        };
        self.start_upload_with(
            params,
            source,
            super::attachment_upload::Origin {
                delegated: Some(context),
                ..Default::default()
            },
        )
    }

    pub(crate) fn hosted_attachment_create_context(
        &mut self,
        session: SessionId,
        path: &str,
        total: u64,
    ) -> ApiResult<DelegatedAttachmentCreate> {
        // CREATE is this contract's file-add capability; no new capability name.
        self.require(session, crate::policy::capability::CREATE)?;
        let SessionAuth::Grant { grant, client_pk } = self.session(session)?.auth else {
            return Err(ErrorCode::Forbidden.err("hosted uploads require an app grant"));
        };
        let account = self
            .grant_for_client(&grant, &client_pk)
            .ok_or_else(|| ErrorCode::Unauthenticated.err("the grant is no longer active"))?
            .account;
        let context = DelegatedAttachmentCreate {
            session,
            grant,
            client_pk,
            account,
            collection: self.cfg.collection,
            wake: self.wake_instance(),
            epoch: self.policy.epoch,
            file: self.mint_v7(),
            path: path.to_owned(),
            total,
        };
        self.hosted_attachment_create_check(&context, path, total, &context.file)?;
        Ok(context)
    }

    /// Restore ONLY a file identity/context from authenticated encrypted native
    /// resume metadata, never a caller-selected file ID or an old wake permit.
    pub(crate) fn hosted_attachment_resume_context(
        &mut self,
        session: SessionId,
        path: &str,
        total: u64,
        resume: &crate::crypto::chunked_blob::upload_resume::AuthenticatedUploadResumeV1,
    ) -> ApiResult<DelegatedAttachmentCreate> {
        let metadata = resume.metadata();
        if metadata.path != path
            || metadata.total_plain_bytes != total
            || metadata.context.collection != self.cfg.collection
            || metadata.context.key_epoch != self.policy.epoch
        {
            return Err(ErrorCode::Conflict.err_with_reason(
                "attachment_upload_scope_changed",
                "the resumed upload context changed",
            ));
        }
        // Fresh current subject/wake checks; freshly minted placeholder is NOT
        // adopted. The original file below comes ONLY from AEAD-authenticated
        // server metadata and is checked against confirmed/optimistic/pending.
        let mut context = self.hosted_attachment_create_context(session, path, total)?;
        if context.resume_owner(metadata.owner.transfer) != metadata.owner {
            return Err(ErrorCode::Unauthenticated.err("the resumed upload owner changed"));
        }
        context.file = metadata.file;
        self.hosted_attachment_create_check(&context, path, total, &context.file)?;
        Ok(context)
    }

    /// Repeat authority, exact ownership and destination absence at every native
    /// send/capture boundary. A previously valid context grants no continuing right.
    pub(crate) fn hosted_attachment_create_check(
        &self,
        context: &DelegatedAttachmentCreate,
        path: &str,
        total: u64,
        file: &Uuid,
    ) -> ApiResult<()> {
        if context.collection != self.cfg.collection
            || context.wake != self.wake_instance()
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
        if !self.is_hosted()
            || self.cfg.key_grants_only
            || !self.hosted_serving()
            || !matches!(
                self.verified_hosted_admission(),
                super::HostedAdmission::Verified(_)
            )
        {
            return Err(ErrorCode::Unavailable.err_with_reason(
                "hosted_attachment_unavailable",
                "the hosted attachment writer is unavailable",
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
        self.require(context.session, crate::policy::capability::CREATE)?;
        match self.session(context.session)?.auth {
            SessionAuth::Grant { grant, client_pk }
                if grant == context.grant && client_pk == context.client_pk => {}
            _ => return Err(ErrorCode::Unauthenticated.err("the upload session changed")),
        }
        let grant = self
            .grant_for_client(&context.grant, &context.client_pk)
            .ok_or_else(|| ErrorCode::Unauthenticated.err("the grant is no longer active"))?;
        if grant.account != context.account || !self.file_visible(context.session, path) {
            return Err(ErrorCode::Forbidden.err_with_reason(
                "file_folders",
                "the upload is outside the current grant scope",
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
        // Both confirmed and optimistic destinations count. Never turn an Op13
        // creation into replacement because a concurrent holder arrived.
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
            return Err(replacement_unsupported());
        }
        let path_key = mdbn_core::paths::path_key(path);
        let reserved_path = format!("p:{path_key}");
        let reserved_id = crate::plan::id_key(file);
        // FileAttach pending rows carry empty legacy effects, so Layer alone
        // cannot reserve their destinations. Capture records these metadata-only
        // touch keys, and local-view rebuilding retains them. Fail closed on any
        // pending reservation without fetching/scanning pending content or blobs.
        if self.pending_keys.values().any(|keys| {
            keys.iter()
                .any(|key| key == &reserved_path || key == &reserved_id)
        }) {
            return Err(replacement_unsupported());
        }
        let view = crate::plan::StoreView::new(&self.store, self.catalog.clone());
        let layer = crate::layer::LayerView {
            base: &view,
            layer: &self.layer,
        };
        if view.at_path_key(&path_key).is_some() || layer.at_path_key(&path_key).is_some() {
            return Err(replacement_unsupported());
        }
        if let Some(error) = view.error() {
            return Err(super::submit::store_err(error));
        }
        Ok(())
    }
}
