//! Existing HOSTED+Grant API boundary over the one native region writer.
use super::*;
use crate::api::SessionId;
use crate::crypto::chunked_blob::{SealedChunkSpan, upload_resume::UploadResumeRefV1};
use zeroize::Zeroize;

impl<S: Store> Replica<S> {
    /// Existing hosted CREATE seam, retaining the actual Hosted/Grant fence.
    pub fn start_hosted_attachment_region_upload(
        &mut self,
        session: SessionId,
        params: HostedAttachmentTransferParams,
    ) -> ApiResult<Uuid> {
        self.require_hosted_attachment_subject(session)?;
        self.start_attachment_region_upload(session, params)
            .map(|(mutation, _)| mutation)
    }
    /// Existing hosted authenticated-journal resume; always wipe supplied bytes.
    pub fn resume_hosted_attachment_region_upload(
        &mut self,
        session: SessionId,
        params: HostedAttachmentTransferParams,
        reference: UploadResumeRefV1,
        region: &mut [u8],
    ) -> ApiResult<Uuid> {
        if let Err(error) = self.require_hosted_attachment_subject(session) {
            region.zeroize();
            return Err(error);
        }
        self.resume_attachment_region_upload(session, params, reference, region)
            .map(|(mutation, _)| mutation)
    }
    /// Existing hosted next committed-prefix object query, with current authority.
    pub fn hosted_attachment_rehash_need(
        &self,
        session: SessionId,
        mutation: &Uuid,
    ) -> ApiResult<Option<(u64, Hash, u64)>> {
        self.require_hosted_attachment_subject(session)?;
        self.attachment_rehash_need(session, mutation)
    }
    /// Existing hosted native digest rebuild; every supplied region is wiped.
    pub fn supply_hosted_attachment_rehash(
        &mut self,
        session: SessionId,
        mutation: &Uuid,
        index: u64,
        region: &mut [u8],
    ) -> ApiResult<()> {
        if let Err(error) = self.require_hosted_attachment_subject(session) {
            region.zeroize();
            return Err(error);
        }
        self.supply_attachment_rehash(session, mutation, index, region)
    }
    /// Existing hosted tentative in-place seal; no adapter storage claim advances it.
    pub fn push_hosted_attachment_region_chunk(
        &mut self,
        session: SessionId,
        mutation: &Uuid,
        region: &mut [u8],
        plain_bytes: usize,
    ) -> ApiResult<SealedChunkSpan> {
        if let Err(error) = self.require_hosted_attachment_subject(session) {
            region.zeroize();
            return Err(error);
        }
        self.push_attachment_region_chunk(session, mutation, region, plain_bytes)
    }
    /// Existing hosted authoritative native LS verification request.
    pub fn verify_hosted_attachment_region_chunk(
        &mut self,
        session: SessionId,
        mutation: &Uuid,
    ) -> ApiResult<()> {
        self.require_hosted_attachment_subject(session)?;
        self.verify_attachment_region_chunk(session, mutation)
    }
    /// Existing hosted known encrypted-journal progress, not a packet ACK.
    pub fn hosted_attachment_region_progress(
        &self,
        session: SessionId,
        mutation: &Uuid,
    ) -> ApiResult<HostedAttachmentTransferProgress> {
        self.require_hosted_attachment_subject(session)?;
        self.attachment_region_progress(session, mutation)
    }
    /// Existing hosted manifest/verification/capture driver, not synthetic durability.
    pub fn commit_hosted_attachment_region_upload(
        &mut self,
        session: SessionId,
        mutation: &Uuid,
    ) -> ApiResult<()> {
        self.require_hosted_attachment_subject(session)?;
        self.commit_attachment_region_upload(session, mutation)
    }
}
