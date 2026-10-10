//! T6b full-source streaming validation. Sinks are private staging, never a live
//! published file: only the opaque final proof permits a later atomic commit.
use super::unindexed_capture::Utf8;
use crate::{
    attachments::{AttachmentReader, Need, PlainSink, StreamError, WholeFileHasher},
    crypto::{
        blob,
        chunked_blob::{
            AttachmentContextV1, AttachmentLimits, AttachmentRefV1, CHUNK_BYTES, ExpectedFileV1,
        },
    },
    seal::Sealer,
};
use mdbn_wire::{
    attachment::FileContent,
    common::{Hash, Uuid},
    intent::BlobRef,
    unindexed_markdown::RECORD_SOURCE_CAP_BYTES,
};

/// Full authenticated source proof, bound to the entire descriptor. No plaintext
/// buffer and no public constructor. It is not current holder/authority proof.
#[derive(Debug)]
pub struct AuthenticatedUnindexedSource {
    content: FileContent,
}
impl AuthenticatedUnindexedSource {
    /// Exact authenticated descriptor, including epoch/manifest/reseal identity.
    pub fn content(&self) -> &FileContent {
        &self.content
    }
    /// Verified full plaintext digest.
    pub fn plain_hash(&self) -> Hash {
        self.content.plain_hash()
    }
    /// Verified full byte count.
    pub fn size(&self) -> u64 {
        self.content.size()
    }
}

/// Full-read outcome: source invalidity is distinct from transport/authentication.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UnindexedSourceError {
    /// Incomplete, unavailable, corrupt or failed staging; not a writer rejection.
    Read(StreamError),
    /// Complete authenticated hash/count matched, but plaintext was not UTF8.
    /// Receiving records unindexed_markdown_invalid_utf8 without holder effects.
    InvalidUtf8,
}
impl From<StreamError> for UnindexedSourceError {
    fn from(error: StreamError) -> Self {
        Self::Read(error)
    }
}

/// Next bounded encrypted object. Fetch into private memory subject to the bound.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnindexedSourceNeed {
    /// Attachment's existing authenticated manifest/chunk inventory.
    Attachment(Need),
    /// Legacy keyed part; at most one16MiB plaintext part, never a file Vec.
    Blob {
        /// Exact next part ordinal; full reads only, no resume shortcut.
        index: u64,
        /// Collection/epoch-keyed part address.
        address: Hash,
        /// Bound before fetching/decoding the complete sealed envelope.
        max_sealed_bytes: u64,
    },
}

enum Reader {
    Attachment(Box<AttachmentReader>),
    Blob {
        descriptor: BlobRef,
        addresses: Vec<Hash>,
        next: u64,
    },
}
/// Sans-IO full-source reader. No range/resume shortcut can produce a proof.
pub struct UnindexedSourceReader {
    content: FileContent,
    reader: Reader,
    count: u64,
    hash: WholeFileHasher,
    utf8: Utf8,
    invalid_utf8: bool,
    failed: bool,
}
impl UnindexedSourceReader {
    /// Validate descriptor shape/declared source cap before fetching anything.
    pub fn new(
        sealer: &dyn Sealer,
        content: FileContent,
        collection: Uuid,
    ) -> Result<Self, StreamError> {
        if content.size() <= RECORD_SOURCE_CAP_BYTES
            || content.size() > AttachmentLimits::default().max_file_bytes
        {
            return Err(StreamError::TooLarge);
        }
        let reader = match &content {
            FileContent::AttachmentV1(a) => {
                if a.reference.collection != collection {
                    return Err(StreamError::Corrupt("source collection"));
                }
                Reader::Attachment(Box::new(AttachmentReader::whole(
                    AttachmentRefV1 {
                        context: AttachmentContextV1 {
                            collection: a.reference.collection,
                            key_epoch: a.reference.key_epoch,
                            attachment_id: a.reference.attachment_id,
                            chunk_bytes: CHUNK_BYTES,
                        },
                        manifest_cipher_hash: a.reference.manifest_cipher_hash,
                    },
                    ExpectedFileV1 {
                        whole_plain_hash: a.whole_plain_hash,
                        total_plain_bytes: a.total_plain_bytes,
                    },
                    AttachmentLimits::default(),
                )?))
            }
            FileContent::Blob(b) => {
                blob::validate_blob_ref(b).map_err(|_| StreamError::Corrupt("blob descriptor"))?;
                let addresses = sealer.blob_part_addresses(b).ok_or(StreamError::NoKey)?;
                if addresses.len() as u64 != b.part_count() {
                    return Err(StreamError::Corrupt("blob part inventory"));
                }
                Reader::Blob {
                    descriptor: b.clone(),
                    addresses,
                    next: 0,
                }
            }
            _ => return Err(StreamError::Protocol("unsupported source content")),
        };
        Ok(Self {
            content,
            reader,
            count: 0,
            hash: WholeFileHasher::default(),
            utf8: Utf8::default(),
            invalid_utf8: false,
            failed: false,
        })
    }
    /// Exact next object and its bound. Once a supply fails, this reader is terminal.
    pub fn need(&self) -> Option<UnindexedSourceNeed> {
        if self.failed {
            return None;
        }
        match &self.reader {
            Reader::Attachment(r) => r.need().map(UnindexedSourceNeed::Attachment),
            Reader::Blob {
                descriptor,
                addresses,
                next,
            } => {
                let length = blob::expected_part_len(descriptor, *next)?;
                let address = *addresses.get(usize::try_from(*next).ok()?)?;
                Some(UnindexedSourceNeed::Blob {
                    index: *next,
                    address,
                    max_sealed_bytes: blob::max_sealed_len(length),
                })
            }
        }
    }
    /// Supply precisely the requested authenticated object. Bytes go only to the
    /// caller's private staging sink; on error discard staging, preserve live bytes.
    pub fn supply(
        &mut self,
        sealer: &dyn Sealer,
        raw: &[u8],
        sink: &mut dyn PlainSink,
    ) -> Result<(), StreamError> {
        if self.failed {
            return Err(StreamError::Protocol("source reader failed"));
        }
        let Some(need) = self.need() else {
            self.failed = true;
            return Err(StreamError::Protocol("no source object expected"));
        };
        let mut checked = CheckedSink {
            sink,
            count: &mut self.count,
            hash: &mut self.hash,
            utf8: &mut self.utf8,
            invalid_utf8: &mut self.invalid_utf8,
            total: self.content.size(),
        };
        let result = (|| match (&mut self.reader, need) {
            (Reader::Attachment(r), UnindexedSourceNeed::Attachment(Need::Manifest { .. })) => {
                r.supply_manifest(sealer, raw)
            }
            (Reader::Attachment(r), UnindexedSourceNeed::Attachment(Need::Chunk { index, .. })) => {
                r.supply_chunk(sealer, index, raw, &mut checked)
            }
            (
                Reader::Blob {
                    descriptor, next, ..
                },
                UnindexedSourceNeed::Blob {
                    index,
                    max_sealed_bytes,
                    ..
                },
            ) => {
                if raw.len() as u64 > max_sealed_bytes {
                    Err(StreamError::Corrupt("blob sealed part size"))
                } else {
                    let plain = open_blob_part(sealer, descriptor, index, raw)?;
                    checked
                        .write(index.saturating_mul(descriptor.part_size), &plain)
                        .map_err(StreamError::Sink)?;
                    *next += 1;
                    Ok(())
                }
            }
            _ => Err(StreamError::Protocol("source object type")),
        })();
        if result.is_err() {
            self.failed = true;
        }
        result
    }
    /// Only a complete full read, exact count/hash and valid UTF8 returns a proof.
    pub fn finish(self) -> Result<AuthenticatedUnindexedSource, UnindexedSourceError> {
        if self.failed || self.need().is_some() {
            return Err(StreamError::Protocol("source incomplete or failed").into());
        }
        if self.count != self.content.size() || self.hash.finish() != self.content.plain_hash() {
            return Err(StreamError::Corrupt("source full hash/count").into());
        }
        if let Reader::Attachment(r) = self.reader
            && r.finish()?
        {
            return Err(StreamError::Protocol("resumed source is not full proof").into());
        }
        if self.invalid_utf8 || self.utf8.finish().is_err() {
            return Err(UnindexedSourceError::InvalidUtf8);
        }
        Ok(AuthenticatedUnindexedSource {
            content: self.content,
        })
    }
}
struct CheckedSink<'a> {
    sink: &'a mut dyn PlainSink,
    count: &'a mut u64,
    hash: &'a mut WholeFileHasher,
    utf8: &'a mut Utf8,
    invalid_utf8: &'a mut bool,
    total: u64,
}
impl PlainSink for CheckedSink<'_> {
    fn write(&mut self, offset: u64, plain: &[u8]) -> Result<(), String> {
        if offset != *self.count
            || offset
                .checked_add(plain.len() as u64)
                .is_none_or(|n| n > self.total)
        {
            return Err("source range/count".into());
        }
        // A deterministic writer rejection needs COMPLETE authentication, not
        // merely a bad prefix. Keep reading/hashing; never publish staging.
        if !*self.invalid_utf8 && self.utf8.push(plain).is_err() {
            *self.invalid_utf8 = true;
        }
        self.sink.write(offset, plain)?;
        self.hash.update(plain);
        *self.count += plain.len() as u64;
        Ok(())
    }
}
// Views-owned low-level primitive, merged9f2bfc79. No cached Store-byte authority.
fn open_blob_part(
    sealer: &dyn Sealer,
    descriptor: &BlobRef,
    index: u64,
    raw: &[u8],
) -> Result<zeroize::Zeroizing<Vec<u8>>, StreamError> {
    sealer
        .open_blob_part(descriptor, index, raw, blob::MAX_PART_SIZE)
        .map_err(|e| match e {
            crate::seal::OpenError::NoKey => StreamError::NoKey,
            crate::seal::OpenError::Aead => StreamError::Corrupt("blob part authentication"),
        })
}
