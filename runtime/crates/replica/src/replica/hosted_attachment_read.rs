//! Native attachment read pins. Hosts supply one bounded ciphertext object at
//! a time; the replica retains keys and authenticates before a sink sees bytes.
//! This is not transport admission: hosts must still recheck live admission
//! immediately before every effect and output, including after awaits.

use mdbn_wire::attachment::FileContent;
use mdbn_wire::client::FileView;
use mdbn_wire::common::{Hash, Uuid};

use super::Replica;
use crate::api::{ApiResult, ClientApi, ErrorCode, SessionId, Target};
use crate::attachments::{AttachmentReader, Need, PlainSink, StreamError};
use crate::crypto::chunked_blob::AttachmentLimits;
use crate::store::Store;

/// One session's confirmed attachment revision, bound to this collection, wake
/// and store lifetime. Cannot be constructed from a client's descriptor.
pub struct AttachmentRead {
    session: SessionId,
    collection: Uuid,
    wake: u64,
    generation: u64,
    view: FileView,
    reader: AttachmentReader,
}

/// Existing hosted native API name; both hosts use the same opaque pin.
pub type HostedAttachmentRead = AttachmentRead;

impl std::fmt::Debug for AttachmentRead {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AttachmentRead").finish_non_exhaustive()
    }
}

impl AttachmentRead {
    /// The pinned file metadata returned to the caller of `read_file`.
    pub fn view(&self) -> &FileView {
        &self.view
    }

    /// The next exact encrypted object from the native descriptor/manifest.
    pub fn need(&self) -> Option<Need> {
        self.reader.need()
    }
}

pub(super) fn stream_error(e: StreamError) -> crate::api::ApiError {
    match e {
        StreamError::TooLarge => ErrorCode::TooLarge.err("attachment exceeds the file limit"),
        StreamError::NoKey => ErrorCode::Unavailable.err_with_reason(
            "attachment_key_unavailable",
            "attachment key is unavailable",
        ),
        StreamError::Corrupt(_) => ErrorCode::Unavailable
            .err_with_reason("attachment_unavailable", "attachment failed authentication"),
        StreamError::Protocol(_) | StreamError::Sink(_) => ErrorCode::InvalidRequest
            .err_with_reason(
                "attachment_read_protocol",
                "attachment read did not complete",
            ),
    }
}

impl<S: Store> Replica<S> {
    pub(super) fn attachment_read_gate(
        &self,
        session: SessionId,
        path: Option<&str>,
    ) -> ApiResult<()> {
        self.require(session, crate::policy::capability::READ)?;
        let hosted_identity = self
            .policy
            .devices
            .get(&self.cfg.device_id)
            .is_some_and(|d| d.kind == mdbn_wire::policy::DeviceKind::Hosted);
        if self.is_hosted() != hosted_identity
            || self.local_only()
            || self.cfg.key_grants_only
            || !self.hosted_serving()
            || !self.policy.device_can_read(&self.cfg.device_id)
        {
            return Err(ErrorCode::Unavailable.err_with_reason(
                "attachment_reader_unavailable",
                "the native attachment reader is unavailable",
            ));
        }
        if path.is_some_and(|p| !self.file_visible(session, p)) {
            return Err(ErrorCode::NotFound.err("no such file"));
        }
        Ok(())
    }

    // Preserve the old hosted API's mode fence; generic device serving is a
    // distinct caller boundary, never a fake hosted profile or grant.
    pub(super) fn hosted_attachment_gate(&self, session: SessionId) -> ApiResult<()> {
        self.require(session, crate::policy::capability::READ)?;
        if !self.is_hosted() || self.cfg.key_grants_only || !self.hosted_serving() {
            return Err(ErrorCode::Unavailable.err_with_reason(
                "hosted_attachment_unavailable",
                "the hosted attachment reader is unavailable",
            ));
        }
        Ok(())
    }

    /// Pin a confirmed attachment for an eligible synced device/hosted reader.
    /// `range` is `[offset, length]`; `revision` is the expected whole-file digest.
    pub fn attachment_read(
        &mut self,
        session: SessionId,
        target: Target,
        range: Option<(u64, u64)>,
        revision: Option<Hash>,
    ) -> ApiResult<AttachmentRead> {
        self.attachment_read_gate(session, None)?;
        let view = self.get_file(session, target)?;
        if revision.is_some_and(|r| r != view.digest) {
            return Err(ErrorCode::Conflict.err_with_reason(
                "revision_mismatch",
                "the file revision differs from the requested revision",
            ));
        }
        let row = self
            .store
            .file(&view.id)
            .map_err(super::submit::store_err)?
            .ok_or_else(|| ErrorCode::NotFound.err("no such file"))?;
        let FileContent::AttachmentV1(content) = &row.content else {
            return Err(ErrorCode::Unavailable.err_with_reason(
                "attachment_required",
                "this reader requires attachment-v1 content",
            ));
        };
        let (descriptor, expected) = super::attachment_fetch::descriptor(content);
        let (start, end) = match range {
            None => (0, view.size),
            Some((start, len)) => {
                let end = start
                    .checked_add(len)
                    .filter(|e| *e <= view.size)
                    .ok_or_else(|| ErrorCode::InvalidRequest.err("range is outside the file"))?;
                (start, end)
            }
        };
        let reader = if start == 0 && end == view.size {
            AttachmentReader::whole(descriptor, expected, AttachmentLimits::default())
        } else {
            AttachmentReader::range(
                descriptor,
                expected,
                AttachmentLimits::default(),
                start,
                end,
            )
        }
        .map_err(stream_error)?;
        Ok(AttachmentRead {
            session,
            collection: self.cfg.collection,
            wake: self.wake_instance(),
            generation: self.store_generation,
            view,
            reader,
        })
    }

    /// Recheck current READ/folder/health and exact wake/store lifetime.
    /// A normal concurrent replacement does not disturb the immutable revision.
    pub fn attachment_read_check(&self, read: &AttachmentRead) -> ApiResult<()> {
        if read.collection != self.cfg.collection
            || read.wake != self.wake_instance()
            || read.generation != self.store_generation
        {
            return Err(ErrorCode::Unavailable.err_with_reason(
                "attachment_read_lifetime",
                "attachment read belongs to another wake or store lifetime",
            ));
        }
        self.attachment_read_gate(read.session, Some(&read.view.path))
    }

    /// Authenticate the manifest using held keys and the confirmed descriptor.
    pub fn attachment_read_manifest(&self, read: &mut AttachmentRead, raw: &[u8]) -> ApiResult<()> {
        self.attachment_read_check(read)?;
        read.reader
            .supply_manifest(self.sealer.as_ref(), raw)
            .map_err(stream_error)
    }

    /// Authenticate one complete chunk, releasing only its requested slice.
    /// Plaintext is wiped after the sink returns, including on failure.
    pub fn attachment_read_chunk(
        &self,
        read: &mut AttachmentRead,
        index: u64,
        raw: &[u8],
        sink: &mut dyn PlainSink,
    ) -> ApiResult<()> {
        self.attachment_read_check(read)?;
        read.reader
            .supply_chunk(self.sealer.as_ref(), index, raw, sink)
            .map_err(stream_error)
    }

    /// Authenticate inside the fixed private region; no continuing authority is granted.
    pub fn attachment_read_chunk_in_place(
        &self,
        read: &mut AttachmentRead,
        index: u64,
        raw: &mut [u8],
    ) -> ApiResult<crate::attachments::AuthenticatedReadSpan> {
        self.attachment_read_check(read)?;
        read.reader
            .supply_chunk_in_place(self.sealer.as_ref(), index, raw)
            .map_err(stream_error)
    }

    /// Complete a whole-file digest-checked read or authenticated chunk range.
    pub fn attachment_read_finish(&self, read: AttachmentRead) -> ApiResult<()> {
        self.attachment_read_check(&read)?;
        read.reader.finish().map(|_| ()).map_err(stream_error)
    }

    /// Existing HOSTED-only entry point, delegated to the shared native reader.
    pub fn hosted_attachment_read(
        &mut self,
        session: SessionId,
        target: Target,
        range: Option<(u64, u64)>,
        revision: Option<Hash>,
    ) -> ApiResult<HostedAttachmentRead> {
        self.hosted_attachment_gate(session)?;
        self.attachment_read(session, target, range, revision)
    }

    /// Existing hosted pin check; the hosted mode fence remains mandatory.
    pub fn hosted_attachment_read_check(&self, read: &HostedAttachmentRead) -> ApiResult<()> {
        self.attachment_read_check(read)?;
        self.hosted_attachment_gate(read.session)
    }

    /// Existing hosted manifest callback, with current hosted and native checks.
    pub fn hosted_attachment_manifest(
        &self,
        read: &mut HostedAttachmentRead,
        raw: &[u8],
    ) -> ApiResult<()> {
        self.hosted_attachment_read_check(read)?;
        self.attachment_read_manifest(read, raw)
    }

    /// Existing hosted chunk/sink callback, with current hosted and native checks.
    pub fn hosted_attachment_chunk(
        &self,
        read: &mut HostedAttachmentRead,
        index: u64,
        raw: &[u8],
        sink: &mut dyn PlainSink,
    ) -> ApiResult<()> {
        self.hosted_attachment_read_check(read)?;
        self.attachment_read_chunk(read, index, raw, sink)
    }

    /// Existing hosted fixed-region callback; no keys or continuing permits escape.
    pub fn hosted_attachment_chunk_in_place(
        &self,
        read: &mut HostedAttachmentRead,
        index: u64,
        raw: &mut [u8],
    ) -> ApiResult<crate::attachments::AuthenticatedReadSpan> {
        self.hosted_attachment_read_check(read)?;
        self.attachment_read_chunk_in_place(read, index, raw)
    }

    /// Existing hosted completion callback, delegated to the same native reader.
    pub fn hosted_attachment_finish(&self, read: HostedAttachmentRead) -> ApiResult<()> {
        self.hosted_attachment_read_check(&read)?;
        self.attachment_read_finish(read)
    }
}
