//! Additive grant-owned fixed-region upload driver. No source/body ownership:
//! the hosted Engine lends its ONE region. LS HasObjects/PutObject callbacks
//! retain the existing authenticated native reply scopes; no host boolean
//! confirms storage. SQL progress is possible only after the encrypted resume
//! object has a known native successful PUT reply. Unknown outcomes are terminal.

use super::*;
use crate::api::SessionId;
use crate::crypto::chunked_blob::{
    SealedChunkSpan,
    upload_resume::{AuthenticatedUploadResumeV1, UploadResumeMetadataV1, UploadResumeRefV1},
};
use zeroize::Zeroize;

/// Native input for CREATE only; adapter replacement fields must be refused.
#[derive(Debug, Clone)]
pub struct HostedAttachmentTransferParams {
    /// Wire transfer identity, scoped to current grant/client/account.
    pub transfer: Uuid,
    /// Exact destination.
    pub path: String,
    /// Declared total; typed hosted bound1GiB.
    pub size: u64,
    /// Optional immutable whole digest.
    pub digest: Option<Hash>,
    /// Delegated mutation; minted natively when omitted.
    pub mutation: Option<Uuid>,
}
/// Trusted-host metadata only, NOT current authority or a SQL commit receipt.
/// A newly reported checkpoint has a known native encrypted-object PUT reply.
#[derive(Debug, Clone)]
pub struct HostedAttachmentTransferProgress {
    /// Native mutation identity.
    pub mutation: Uuid,
    /// Wire transfer identity.
    pub transfer: Uuid,
    /// Complete committed crypto chunks only (partial wire ACKs excluded).
    pub committed_chunks: u64,
    /// Encrypted resume object reference only, never plaintext checkpoint bytes.
    pub checkpoint: Option<UploadResumeRefV1>,
    /// Native-clock metadata expiry; does not extend LS grace.
    pub expires_at_ms: u64,
}
pub(super) struct HostedRegion {
    pub(super) transfer: Uuid,
    digest: Option<Hash>,
    expires_at_ms: u64,
    pub(super) committed_chunks: u64,
    checkpoint: Option<UploadResumeRefV1>,
    pending: Option<ChunkRefV1>,
    resume: Option<AuthenticatedUploadResumeV1>,
}
impl<S: Store> Replica<S> {
    /// Start a native grant-owned CREATE that waits for fixed-region chunks.
    /// Does not activate wire upload, allocate a file buffer or authorize R2/SQL.
    pub fn start_hosted_attachment_region_upload(
        &mut self,
        session: SessionId,
        params: HostedAttachmentTransferParams,
    ) -> ApiResult<Uuid> {
        let context = self.hosted_attachment_create_context(session, &params.path, params.size)?;
        self.hosted_upload_capacity(context.grant())?;
        let mutation = params.mutation.unwrap_or_else(|| self.mint_v7());
        self.region_mutation_free(mutation)?;
        let limits = AttachmentLimits::default();
        let writer = AttachmentWriter::new(
            &*self.sealer,
            self.cfg.collection,
            params.size,
            limits,
            self.host.entropy.as_mut(),
        )
        .map_err(|e| stream_problem(&e))?;
        let expires = self.region_expiry();
        let up = Upload {
            mutation,
            params: AttachmentUploadParams {
                file: context.file(),
                path: params.path,
                if_revision: None,
                mutation: Some(mutation),
            },
            source: None,
            total: params.size,
            limits,
            writer: Some(writer),
            before: None,
            recorded: vec![],
            finished: None,
            phase: Phase::HostedChunks,
            call: None,
            unsure: None,
            retry_at: None,
            rounds: 0,
            origin: Origin {
                delegated: Some(context),
                ..Default::default()
            },
            hosted: Some(HostedRegion {
                transfer: params.transfer,
                digest: params.digest,
                expires_at_ms: expires,
                committed_chunks: 0,
                checkpoint: None,
                pending: None,
                resume: None,
            }),
            lifetime: Some(HostedLifetime::new(self.now(), expires)),
        };
        self.attachment_uploads.map.insert(mutation, up);
        self.attachment_uploads.queue.push_back(mutation);
        Ok(mutation)
    }
    /// Authenticate the encrypted journal for the fresh CURRENT native subject,
    /// restore original server file/context only from it, and wait for rehash.
    /// Entire region wiped on every path. No stale session/wake permit survives.
    pub fn resume_hosted_attachment_region_upload(
        &mut self,
        session: SessionId,
        params: HostedAttachmentTransferParams,
        reference: UploadResumeRefV1,
        region: &mut [u8],
    ) -> ApiResult<Uuid> {
        let result = (|| {
            // Native policy/folder/health/currentness BEFORE decrypt/digest work.
            let preflight =
                self.hosted_attachment_create_context(session, &params.path, params.size)?;
            self.hosted_upload_capacity(preflight.grant())?;
            let owner = preflight.resume_owner(params.transfer);
            let resume = self
                .sealer
                .open_hosted_upload_resume(&reference, owner, region)
                .map_err(|_| {
                    ErrorCode::Unavailable.err_with_reason(
                        "attachment_resume_unavailable",
                        "the encrypted resume metadata could not be authenticated",
                    )
                })?;
            let m = resume.metadata();
            if m.expires_at_ms <= u64::try_from(self.now()).unwrap_or(u64::MAX)
                || m.expected_whole_hash != params.digest
                || params.mutation.is_some_and(|id| id != m.mutation)
            {
                return Err(ErrorCode::Conflict.err_with_reason(
                    "attachment_upload_scope_changed",
                    "the resume request or expiry changed",
                ));
            }
            let context =
                self.hosted_attachment_resume_context(session, &params.path, params.size, &resume)?;
            let mutation = m.mutation;
            self.region_mutation_free(mutation)?;
            let limits = AttachmentLimits::default();
            let writer =
                AttachmentWriter::resume(&*self.sealer, m.context, m.total_plain_bytes, limits)
                    .map_err(|e| stream_problem(&e))?;
            let committed = m.chunks.len() as u64;
            let expires = m.expires_at_ms;
            let up = Upload {
                mutation,
                params: AttachmentUploadParams {
                    file: context.file(),
                    path: params.path,
                    if_revision: None,
                    mutation: Some(mutation),
                },
                source: None,
                total: params.size,
                limits,
                writer: Some(writer),
                before: None,
                recorded: vec![],
                finished: None,
                phase: Phase::HostedChunks,
                call: None,
                unsure: None,
                retry_at: None,
                rounds: 0,
                origin: Origin {
                    delegated: Some(context),
                    ..Default::default()
                },
                hosted: Some(HostedRegion {
                    transfer: params.transfer,
                    digest: params.digest,
                    expires_at_ms: expires,
                    committed_chunks: committed,
                    checkpoint: Some(reference),
                    pending: None,
                    resume: if committed == 0 { None } else { Some(resume) },
                }),
                lifetime: Some(HostedLifetime::new(self.now(), expires)),
            };
            self.attachment_uploads.map.insert(mutation, up);
            self.attachment_uploads.queue.push_back(mutation);
            Ok(mutation)
        })();
        region.zeroize();
        result
    }
    pub(super) fn region_expiry(&self) -> u64 {
        u64::try_from(self.now())
            .unwrap_or(0)
            .saturating_add(86_400_000)
            .min((1 << 53) - 1)
    }
    fn region_mutation_free(&self, mutation: Uuid) -> ApiResult<()> {
        if self.attachment_uploads.map.contains_key(&mutation)
            || self
                .receipt_exists(&mutation)
                .map_err(super::super::submit::store_err)?
        {
            return Err(ErrorCode::InvalidRequest
                .err_with_reason("mutation_id_in_use", "this mutation ID is in use"));
        }
        Ok(())
    }
    pub(super) fn region_check(&self, session: SessionId, up: &Upload) -> ApiResult<()> {
        let context = up
            .origin
            .delegated
            .as_ref()
            .filter(|_| up.hosted.is_some() && !matches!(up.phase, Phase::Done(_)))
            .ok_or_else(|| ErrorCode::Unavailable.err("the hosted region upload is not active"))?;
        self.hosted_attachment_upload_caller_check(session, context)?;
        self.hosted_upload_lifetime_check(up)?;
        self.hosted_attachment_create_check(context, &up.params.path, up.total, &up.params.file)?;
        if up
            .hosted
            .as_ref()
            .is_none_or(|h| h.expires_at_ms <= u64::try_from(self.now()).unwrap_or(u64::MAX))
        {
            return Err(ErrorCode::Unavailable
                .err_with_reason("attachment_upload_expired", "the hosted upload has expired"));
        }
        Ok(())
    }
    fn with_region_upload<T>(
        &mut self,
        session: SessionId,
        mutation: &Uuid,
        action: impl FnOnce(&mut Self, &mut Upload) -> ApiResult<T>,
    ) -> ApiResult<T> {
        let mut up = self
            .attachment_uploads
            .map
            .remove(mutation)
            .ok_or_else(|| ErrorCode::NotFound.err("the hosted upload is not active"))?;
        let result = self
            .region_check(session, &up)
            .and_then(|()| action(self, &mut up))
            .and_then(|value| {
                self.hosted_upload_lifetime_check(&up)?;
                if let Some(lifetime) = &mut up.lifetime {
                    lifetime.progress(self.now());
                }
                Ok(value)
            });
        self.attachment_uploads.map.insert(*mutation, up);
        result
    }
    /// Next committed prefix object to rehash. Only ciphertext identities leave
    /// native memory; progress cannot proceed until all rehash chunks authenticate.
    pub fn hosted_attachment_rehash_need(
        &self,
        session: SessionId,
        mutation: &Uuid,
    ) -> ApiResult<Option<(u64, Hash, u64)>> {
        let up = self
            .attachment_uploads
            .map
            .get(mutation)
            .ok_or_else(|| ErrorCode::NotFound.err("the hosted upload is not active"))?;
        self.region_check(session, up)?;
        let h = up
            .hosted
            .as_ref()
            .ok_or_else(|| ErrorCode::Internal.err("no hosted region state"))?;
        let Some(resume) = &h.resume else {
            return Ok(None);
        };
        let index = up
            .writer
            .as_ref()
            .ok_or_else(|| ErrorCode::Internal.err("no hosted writer"))?
            .chunks()
            .len();
        Ok(resume
            .metadata()
            .chunks
            .get(index)
            .map(|c| (index as u64, c.cipher_hash, c.sealed_bytes)))
    }
    /// Authenticate next committed-prefix chunk, feed native digest and wipe the
    /// SAME region. New authority checks precede plaintext work; no app output.
    pub fn supply_hosted_attachment_rehash(
        &mut self,
        session: SessionId,
        mutation: &Uuid,
        index: u64,
        region: &mut [u8],
    ) -> ApiResult<()> {
        let result = self.with_region_upload(session, mutation, |r, up| {
            let h = up
                .hosted
                .as_mut()
                .ok_or_else(|| ErrorCode::Internal.err("no hosted region state"))?;
            let resume = h
                .resume
                .as_ref()
                .ok_or_else(|| ErrorCode::InvalidRequest.err("the upload is not rehashing"))?;
            let w = up
                .writer
                .as_mut()
                .ok_or_else(|| ErrorCode::Internal.err("no hosted writer"))?;
            if index != w.chunks().len() as u64 {
                return Err(ErrorCode::InvalidRequest.err("rehash chunk is out of order"));
            }
            let range = r
                .sealer
                .open_hosted_upload_committed_chunk_in_place(resume, index, region)
                .map_err(|_| {
                    ErrorCode::Unavailable.err_with_reason(
                        "attachment_resume_unavailable",
                        "the committed chunk could not be authenticated",
                    )
                })?;
            let chunk = *resume
                .metadata()
                .chunks
                .get(index as usize)
                .ok_or_else(|| ErrorCode::InvalidRequest.err("no committed rehash chunk"))?;
            w.adopt_chunk(&region[range], chunk)
                .map_err(|e| stream_problem(&e))?;
            if w.chunks().len() == resume.metadata().chunks.len() {
                h.resume = None;
            }
            Ok(())
        });
        region.zeroize();
        result
    }
    /// Seal next exact crypto chunk in the lent region. This is tentative RAM
    /// progress ONLY; neither plaintext nor ciphertext is copied into the queue.
    pub fn push_hosted_attachment_region_chunk(
        &mut self,
        session: SessionId,
        mutation: &Uuid,
        region: &mut [u8],
        plain_bytes: usize,
    ) -> ApiResult<SealedChunkSpan> {
        let result = self.with_region_upload(session, mutation, |r, up| {
            let h = up
                .hosted
                .as_mut()
                .ok_or_else(|| ErrorCode::Internal.err("no hosted region state"))?;
            if !matches!(up.phase, Phase::HostedChunks)
                || up.call.is_some()
                || h.pending.is_some()
                || h.resume.is_some()
            {
                return Err(
                    ErrorCode::InvalidRequest.err("the upload is not ready for another chunk")
                );
            }
            let w = up
                .writer
                .as_mut()
                .ok_or_else(|| ErrorCode::Internal.err("no hosted writer"))?;
            let span = w
                .push_chunk_in_place(&*r.sealer, region, plain_bytes, r.host.entropy.as_mut())
                .map_err(|e| stream_problem(&e))?;
            h.pending = Some(span.reference());
            Ok(span)
        });
        if result.is_err() {
            region.zeroize();
        }
        result
    }
    /// After adapter's staged PUT/commit, ask authoritative LS whether the exact
    /// pending native object is committed. Host claims confer NO progress.
    pub fn verify_hosted_attachment_region_chunk(
        &mut self,
        session: SessionId,
        mutation: &Uuid,
    ) -> ApiResult<()> {
        self.with_region_upload(session, mutation, |r, up| {
            let h = up
                .hosted
                .as_ref()
                .ok_or_else(|| ErrorCode::Internal.err("no hosted region state"))?;
            let chunk = h
                .pending
                .ok_or_else(|| ErrorCode::InvalidRequest.err("no sealed chunk pending"))?;
            if up.call.is_some() {
                return Err(ErrorCode::InvalidRequest.err("chunk verification already pending"));
            }
            r.attachment_call(
                up,
                Call::HostedVerifyChunk {
                    address: chunk.cipher_hash,
                },
                LogRequest::HasObjects {
                    collection: r.cfg.collection,
                    addresses: vec![chunk.cipher_hash],
                },
            );
            Ok(())
        })
    }
    /// Current native confirmed checkpoint only; adapter still checks its engine/
    /// wake/socket/live admission/resource before SQL progress/output/after await.
    pub fn hosted_attachment_region_progress(
        &self,
        session: SessionId,
        mutation: &Uuid,
    ) -> ApiResult<HostedAttachmentTransferProgress> {
        let up = self
            .attachment_uploads
            .map
            .get(mutation)
            .ok_or_else(|| ErrorCode::NotFound.err("the hosted upload is not active"))?;
        self.region_check(session, up)?;
        let h = up
            .hosted
            .as_ref()
            .ok_or_else(|| ErrorCode::Internal.err("no hosted region state"))?;
        Ok(HostedAttachmentTransferProgress {
            mutation: *mutation,
            transfer: h.transfer,
            committed_chunks: h.committed_chunks,
            checkpoint: h.checkpoint,
            expires_at_ms: h.expires_at_ms,
        })
    }
    /// Every chunk must have known metadata commit/rehash before final native
    /// manifest PUT + authoritative HasObjects + delegated capture loop.
    pub fn commit_hosted_attachment_region_upload(
        &mut self,
        session: SessionId,
        mutation: &Uuid,
    ) -> ApiResult<()> {
        self.with_region_upload(session, mutation, |r, up| {
            let h = up
                .hosted
                .as_ref()
                .ok_or_else(|| ErrorCode::Internal.err("no hosted region state"))?;
            if !matches!(up.phase, Phase::HostedChunks)
                || up.call.is_some()
                || h.pending.is_some()
                || h.resume.is_some()
                || h.committed_chunks != up.chunk_count()
            {
                return Err(ErrorCode::InvalidRequest.err("hosted upload is incomplete"));
            }
            let digest = h.digest;
            if !r.seal_manifest(up) {
                return Err(ErrorCode::Unavailable.err("the hosted manifest could not be sealed"));
            }
            if digest.is_some_and(|digest| {
                up.finished
                    .as_ref()
                    .is_none_or(|f| f.expected.whole_plain_hash != digest)
            }) {
                up.fail(ErrorCode::Conflict.problem_with_reason(
                    "digest_mismatch",
                    "the uploaded file digest did not match",
                ));
                return Err(ErrorCode::Conflict
                    .err_with_reason("digest_mismatch", "the uploaded file digest did not match"));
            }
            r.drive_upload(up);
            Ok(())
        })
    }
    pub(super) fn hosted_region_reply(&mut self, up: &mut Upload, call: Call, reply: LogReply) {
        // Preserve authoritative quota/refusal instead of replacing it with a
        // later admission error. Unknown outcomes never adopt possible storage.
        let response = match reply {
            Ok(response) => response,
            Err(LogError::Service {
                code: LogErrorCode::QuotaExceeded,
                ..
            }) => {
                return up.fail(
                    ErrorCode::QuotaExceeded.problem("the log's storage quota is exhausted"),
                );
            }
            Err(LogError::Service {
                code: LogErrorCode::Forbidden,
                ..
            }) => {
                return up.fail(ErrorCode::Forbidden.problem("the log refused the hosted object"));
            }
            Err(LogError::Service {
                code: LogErrorCode::TooLarge,
                ..
            }) => {
                return up.fail(
                    ErrorCode::TooLarge.problem("the log refused the hosted object as too large"),
                );
            }
            Err(_) => {
                return up.fail(ErrorCode::Unavailable.problem_with_reason(
                    "hosted_upload_commit_unknown",
                    "the hosted boundary outcome is unknown; no progress is claimed",
                ));
            }
        };
        // Log reply scopes identify native-owned work, never an adapter/client ID.
        let Some(session) = up.origin.delegated.as_ref().map(|c| c.session()) else {
            return up.fail(ErrorCode::Internal.problem("no native hosted owner"));
        };
        if let Err(e) = self.region_check(session, up) {
            return up.fail(e.into_problem());
        }
        match (call, response) {
            (Call::HostedVerifyChunk { address }, LogResponse::HasObjects(flags))
                if flags == [true] =>
            {
                let Some(h) = up.hosted.as_ref() else {
                    return up.fail(ErrorCode::Internal.problem("no hosted region state"));
                };
                if h.pending.is_none_or(|c| c.cipher_hash != address) {
                    return up.fail(ErrorCode::Internal.problem("staged chunk identity changed"));
                }
                let Some(w) = up.writer.as_ref() else {
                    return up.fail(ErrorCode::Internal.problem("no hosted writer"));
                };
                let Some(ctx) = up.origin.delegated.as_ref() else {
                    return up.fail(ErrorCode::Internal.problem("no hosted owner"));
                };
                let expiry = h.expires_at_ms;
                let metadata = UploadResumeMetadataV1 {
                    context: w.context(),
                    owner: ctx.resume_owner(h.transfer),
                    file: up.params.file,
                    mutation: up.mutation,
                    path: up.params.path.clone(),
                    total_plain_bytes: up.total,
                    expected_whole_hash: h.digest,
                    expires_at_ms: expiry,
                    chunks: w.chunks().to_vec(),
                };
                let chunks = metadata.chunks.len() as u64;
                match self
                    .sealer
                    .seal_hosted_upload_resume(&metadata, self.host.entropy.as_mut())
                {
                    Ok((object, reference)) => self.attachment_call(
                        up,
                        Call::HostedPutResume {
                            reference,
                            chunks,
                            expires_at_ms: expiry,
                        },
                        LogRequest::PutObject {
                            collection: self.cfg.collection,
                            address: object.cipher_hash,
                            kind: ItemKind::BlobPart,
                            bytes: object.bytes,
                        },
                    ),
                    Err(_) => up.fail(
                        ErrorCode::Unavailable
                            .problem("the encrypted resume metadata could not be sealed"),
                    ),
                }
            }
            (
                Call::HostedPutResume {
                    reference,
                    chunks,
                    expires_at_ms,
                },
                LogResponse::PutObject { .. },
            ) => {
                let Some(h) = up.hosted.as_mut() else {
                    return up.fail(ErrorCode::Internal.problem("no hosted region state"));
                };
                h.committed_chunks = chunks;
                h.checkpoint = Some(reference);
                h.pending = None;
                // Retain EXACT expiry authenticated in the native request;
                // a delayed reply never extends metadata/object grace.
                h.expires_at_ms = expires_at_ms;
            }
            (Call::HostedVerifyChunk { .. }, LogResponse::HasObjects(_)) => {
                up.fail(ErrorCode::Unavailable.problem_with_reason(
                    "attachment_objects_missing",
                    "the staged sealed chunk is not committed",
                ))
            }
            _ => up.fail(ErrorCode::Internal.problem("unexpected hosted object store response")),
        }
    }
}
