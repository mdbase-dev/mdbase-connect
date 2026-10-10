//! Hosted attachment read pins. The host supplies one bounded ciphertext object
//! at a time; the replica retains keys and authenticates before a sink sees bytes.
//! This is not host admission: the Worker must still recheck its live verified
//! admission immediately before every effect and output (including after awaits).

use mdbn_wire::attachment::FileContent;
use mdbn_wire::client::FileView;
use mdbn_wire::common::{Hash, Uuid};

use super::Replica;
use crate::api::{ApiResult, ClientApi, ErrorCode, SessionId, Target};
use crate::attachments::{AttachmentReader, Need, PlainSink, StreamError};
use crate::crypto::chunked_blob::AttachmentLimits;
use crate::store::Store;

/// One session's pinned, log-derived attachment revision, bound to this wake.
/// Contains no key or ciphertext. Cannot be constructed from a client's descriptor.
pub struct HostedAttachmentRead {
    session: SessionId,
    collection: Uuid,
    wake: u64,
    view: FileView,
    reader: AttachmentReader,
}

impl std::fmt::Debug for HostedAttachmentRead {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostedAttachmentRead")
            .finish_non_exhaustive()
    }
}

impl HostedAttachmentRead {
    /// The pinned file metadata returned to the caller of `read_file`.
    pub fn view(&self) -> &FileView {
        &self.view
    }

    /// The next complete encrypted object to fetch, never a caller-selected URL.
    pub fn need(&self) -> Option<Need> {
        self.reader.need()
    }
}

fn stream_error(e: StreamError) -> crate::api::ApiError {
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
    fn hosted_attachment_gate(&self, session: SessionId, path: Option<&str>) -> ApiResult<()> {
        self.require(session, crate::policy::capability::READ)?;
        if !self.is_hosted() || self.cfg.key_grants_only || !self.hosted_serving() {
            return Err(ErrorCode::Unavailable.err_with_reason(
                "hosted_attachment_unavailable",
                "the hosted attachment reader is unavailable",
            ));
        }
        if path.is_some_and(|p| !self.file_visible(session, p)) {
            return Err(ErrorCode::NotFound.err("no such file"));
        }
        Ok(())
    }

    /// Capture a READ/file-folder-gated attachment from the confirmed store.
    /// `range` is `[offset, length]`; overflow/out-of-file bounds are refused.
    /// `revision` is the expected whole-file digest, not a supplied descriptor.
    pub fn hosted_attachment_read(
        &mut self,
        session: SessionId,
        target: Target,
        range: Option<(u64, u64)>,
        revision: Option<Hash>,
    ) -> ApiResult<HostedAttachmentRead> {
        self.hosted_attachment_gate(session, None)?;
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
        Ok(HostedAttachmentRead {
            session,
            collection: self.cfg.collection,
            wake: self.wake_instance(),
            view,
            reader,
        })
    }

    /// Current READ/folder/health authority for this exact pin, before and after I/O.
    /// A concurrent replacement does not disturb the immutable pinned revision.
    pub fn hosted_attachment_read_check(&self, read: &HostedAttachmentRead) -> ApiResult<()> {
        if read.collection != self.cfg.collection || read.wake != self.wake_instance() {
            return Err(ErrorCode::Unavailable.err("attachment read belongs to another wake"));
        }
        self.hosted_attachment_gate(read.session, Some(&read.view.path))
    }

    /// Authenticate the manifest through held keys and the signed descriptor.
    pub fn hosted_attachment_manifest(
        &self,
        read: &mut HostedAttachmentRead,
        raw: &[u8],
    ) -> ApiResult<()> {
        self.hosted_attachment_read_check(read)?;
        read.reader
            .supply_manifest(self.sealer.as_ref(), raw)
            .map_err(stream_error)
    }

    /// Authenticate one complete chunk, then release only its requested slice.
    /// The reader wipes plaintext after the sink returns, including on failure.
    pub fn hosted_attachment_chunk(
        &self,
        read: &mut HostedAttachmentRead,
        index: u64,
        raw: &[u8],
        sink: &mut dyn PlainSink,
    ) -> ApiResult<()> {
        self.hosted_attachment_read_check(read)?;
        read.reader
            .supply_chunk(self.sealer.as_ref(), index, raw, sink)
            .map_err(stream_error)
    }

    /// Authenticate inside the host's fixed private region; the returned span
    /// grants no continuing admission permit and exposes no held keys.
    pub fn hosted_attachment_chunk_in_place(
        &self,
        read: &mut HostedAttachmentRead,
        index: u64,
        raw: &mut [u8],
    ) -> ApiResult<crate::attachments::AuthenticatedReadSpan> {
        self.hosted_attachment_read_check(read)?;
        read.reader
            .supply_chunk_in_place(self.sealer.as_ref(), index, raw)
            .map_err(stream_error)
    }

    /// Complete the read. Full reads independently check the whole-file digest;
    /// ranges authenticate every touched chunk and the signed manifest binding.
    pub fn hosted_attachment_finish(&self, read: HostedAttachmentRead) -> ApiResult<()> {
        self.hosted_attachment_read_check(&read)?;
        read.reader.finish().map(|_| ()).map_err(stream_error)
    }
}
