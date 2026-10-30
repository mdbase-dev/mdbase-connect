//! Client-only full-source Blob read pins. Attachment-only entry points remain
//! unchanged; neither app input nor a file extension selects this reader.
use super::unindexed_source::{UnindexedSourceError, UnindexedSourceNeed, UnindexedSourceReader};
use super::{AttachmentRead, Replica};
use crate::{
    Store,
    api::{ApiResult, ClientApi, ErrorCode, SessionId, Target},
    attachments::{Need, PlainSink},
    store::FileRow,
};
use mdbn_wire::{
    attachment::FileContent,
    client::FileView,
    common::{Hash, Uuid},
    unindexed_markdown::FileKindV1,
};

pub(crate) enum ClientFileReadPin {
    Attachment(Box<AttachmentRead>),
    Unindexed(Box<UnindexedRead>),
}
/// Native next object: Blob sealed length is bounded, not known before fetch.
#[derive(Clone, Copy)]
pub(crate) enum ClientFileReadNeed {
    Attachment(Need),
    Blob {
        address: Hash,
        max_sealed_bytes: u64,
        offset: u64,
        plain_bytes: u64,
    },
}
pub(crate) struct UnindexedRead {
    session: SessionId,
    collection: Uuid,
    wake: u64,
    generation: u64,
    view: FileView,
    reader: UnindexedSourceReader,
    part_size: u64,
}

// The client staging exception covers canonical parts only, not the legacy
// reader's 16MiB maximum. This does not change the Blob crypto/reader profile.
const CLIENT_BLOB_PART_BYTES: u64 = 8 << 20;
impl ClientFileReadPin {
    pub(crate) fn view(&self) -> &FileView {
        match self {
            Self::Attachment(a) => a.view(),
            Self::Unindexed(a) => &a.view,
        }
    }
    pub(crate) fn need(&self) -> Option<ClientFileReadNeed> {
        match self {
            Self::Attachment(a) => a.need().map(ClientFileReadNeed::Attachment),
            Self::Unindexed(a) => match a.reader.need()? {
                UnindexedSourceNeed::Blob {
                    index,
                    address,
                    max_sealed_bytes,
                } => {
                    let offset = index.checked_mul(a.part_size)?;
                    Some(ClientFileReadNeed::Blob {
                        address,
                        max_sealed_bytes,
                        offset,
                        plain_bytes: a.view.size.checked_sub(offset)?.min(a.part_size),
                    })
                }
                // This constructor only accepts the Blob profile.
                UnindexedSourceNeed::Attachment(_) => None,
            },
        }
    }
}
impl<S: Store> Replica<S> {
    pub(crate) fn client_file_read_pin(
        &mut self,
        session: SessionId,
        target: Target,
        range: Option<(u64, u64)>,
        revision: Option<Hash>,
    ) -> ApiResult<ClientFileReadPin> {
        self.attachment_read_gate(session, None)?;
        let view = self.get_file(session, target.clone())?;
        let row: FileRow = self
            .store
            .file(&view.id)
            .map_err(super::submit::store_err)?
            .ok_or_else(|| ErrorCode::NotFound.err("no such file"))?;
        if row.kind != FileKindV1::UnindexedOversizedMarkdown
            || !matches!(row.content, FileContent::Blob(_))
        {
            return self
                .attachment_read(session, target, range, revision)
                .map(|pin| ClientFileReadPin::Attachment(Box::new(pin)));
        }
        if revision.is_some_and(|expected| expected != view.digest) {
            return Err(ErrorCode::Conflict.err_with_reason(
                "revision_mismatch",
                "the file revision differs from the requested revision",
            ));
        }
        if range.is_some_and(|r| r != (0, view.size)) {
            return Err(ErrorCode::InvalidRequest.err_with_reason(
                "unindexed_full_read_required",
                "unindexed Blob Markdown requires a full-source read",
            ));
        }
        let FileContent::Blob(blob) = &row.content else {
            unreachable!("Blob profile checked above")
        };
        let part_size = blob.part_size;
        if part_size > CLIENT_BLOB_PART_BYTES {
            return Err(ErrorCode::TooLarge.err_with_reason(
                "hosted_read_budget",
                "Blob plaintext part exceeds the client read staging budget",
            ));
        }
        let reader =
            UnindexedSourceReader::new(self.sealer.as_ref(), row.content, self.cfg.collection)
                .map_err(super::hosted_attachment_read::stream_error)?;
        Ok(ClientFileReadPin::Unindexed(Box::new(UnindexedRead {
            session,
            collection: self.cfg.collection,
            wake: self.wake_instance(),
            generation: self.store_generation,
            view,
            reader,
            part_size,
        })))
    }
    /// Hosted resource preflight only; the actual ClientApi repeats every check.
    /// Attachment-only APIs still reject Blob; this is the generic client path.
    pub fn hosted_client_file_read_preflight(
        &mut self,
        session: SessionId,
        target: Target,
        range: Option<(u64, u64)>,
        revision: Option<Hash>,
    ) -> ApiResult<()> {
        self.hosted_attachment_gate(session)?;
        self.client_file_read_pin(session, target, range, revision)
            .map(|_| ())
    }
    pub(crate) fn client_file_read_check(&self, pin: &ClientFileReadPin) -> ApiResult<()> {
        match pin {
            ClientFileReadPin::Attachment(a) => self.attachment_read_check(a),
            ClientFileReadPin::Unindexed(a) => {
                if a.collection != self.cfg.collection
                    || a.wake != self.wake_instance()
                    || a.generation != self.store_generation
                {
                    return Err(ErrorCode::Unavailable.err_with_reason(
                        "attachment_read_lifetime",
                        "file read belongs to another wake or store lifetime",
                    ));
                }
                self.attachment_read_gate(a.session, Some(&a.view.path))
            }
        }
    }
    pub(crate) fn client_file_read_blob(
        &self,
        pin: &mut ClientFileReadPin,
        raw: &[u8],
        sink: &mut dyn PlainSink,
    ) -> ApiResult<()> {
        self.client_file_read_check(pin)?;
        let ClientFileReadPin::Unindexed(a) = pin else {
            return Err(ErrorCode::InvalidRequest.err("not a Blob read"));
        };
        a.reader
            .supply(self.sealer.as_ref(), raw, sink)
            .map_err(super::hosted_attachment_read::stream_error)
    }
    pub(crate) fn client_file_read_finish(&self, pin: ClientFileReadPin) -> ApiResult<()> {
        self.client_file_read_check(&pin)?;
        match pin {
            ClientFileReadPin::Attachment(a) => self.attachment_read_finish(*a),
            ClientFileReadPin::Unindexed(a) => {
                a.reader.finish().map(|_| ()).map_err(|error| match error {
                    UnindexedSourceError::Read(e) => super::hosted_attachment_read::stream_error(e),
                    UnindexedSourceError::InvalidUtf8 => ErrorCode::Unavailable.err_with_reason(
                        "unindexed_invalid_utf8",
                        "unindexed Markdown source is not valid UTF-8",
                    ),
                })
            }
        }
    }
}
