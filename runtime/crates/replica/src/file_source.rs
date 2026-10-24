//! Bounded sans-IO authentication of an EXISTING Blob/Attachment descriptor.
//! Fetch encrypted objects with the host transport; never accept cached/plain
//! Store bytes as descriptor proof. This proves cryptographic source binding,
//! not current holder, role, capture or publication authority. Callers must bind
//! the descriptor to a verified wrapper and recheck authority/state across awaits.
use crate::attachments::{
    AttachmentReader, MAX_SEALED_CHUNK, MAX_SEALED_MANIFEST, Need, PlainSink, StreamError,
};
use crate::crypto::chunked_blob::{AttachmentLimits, ExpectedFileV1};
use crate::seal::{OpenError, Sealer};
use mdbn_wire::attachment::FileContent;
use mdbn_wire::common::Hash;
use zeroize::{Zeroize, Zeroizing};

/// Hard upper bound for the Ordinary setup/promotion whole-source adapter.
/// Larger T6b sources require their separate streaming consumer.
pub const MAX_SOURCE_BYTES: u64 = 1 << 20;
/// One bounded encrypted-object fetch. Addresses for Blob parts are keyed;
/// attachment addresses are SHA-256 of the complete object.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceNeed {
    /// Legacy Blob part in index order.
    BlobPart {
        /// Expected part index, starting at zero.
        index: u64,
        /// Descriptor-derived keyed object address.
        address: Hash,
        /// Maximum encoded object bytes, checked before opening.
        max_bytes: u64,
    },
    /// Attachment-v1 manifest.
    Manifest {
        /// SHA-256 address of the complete manifest object.
        address: Hash,
        /// Maximum encoded object bytes.
        max_bytes: u64,
    },
    /// Attachment-v1 chunk with an authenticated exact object size.
    Chunk {
        /// Index in the authenticated manifest.
        index: u64,
        /// SHA-256 address of the complete chunk object.
        address: Hash,
        /// Exact encoded bytes declared by the authenticated manifest.
        bytes: u64,
    },
}
enum Profile {
    Blob {
        descriptor: mdbn_wire::intent::BlobRef,
        addresses: Vec<Hash>,
        next: usize,
    },
    Attachment(Box<AttachmentReader>),
}
/// Only returned after complete authenticated reads AND whole length/hash checks.
/// No partial plaintext escape; contents are wiped on drop. It is not an authority.
pub struct AuthenticatedFileBytes {
    descriptor: FileContent,
    bytes: Zeroizing<Vec<u8>>,
}
impl AuthenticatedFileBytes {
    /// Exact bytes, possibly invalid UTF-8. Parsing failures do not undo source authentication.
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
    /// The full descriptor this source authenticated against.
    pub fn descriptor(&self) -> &FileContent {
        &self.descriptor
    }
}
/// Whole-source reader; failure is sticky and wipes all collected plaintext.
pub struct FileSourceReader {
    descriptor: FileContent,
    profile: Profile,
    bytes: Zeroizing<Vec<u8>>,
    max: u64,
    failed: bool,
}
struct Sink<'a> {
    bytes: &'a mut Zeroizing<Vec<u8>>,
    max: u64,
}
impl PlainSink for Sink<'_> {
    fn write(&mut self, offset: u64, plain: &[u8]) -> Result<(), String> {
        if offset != self.bytes.len() as u64
            || offset
                .checked_add(plain.len() as u64)
                .is_none_or(|n| n > self.max)
        {
            return Err("bounded source sink".into());
        }
        self.bytes.extend_from_slice(plain);
        Ok(())
    }
}
impl FileSourceReader {
    /// Descriptor must come from a trusted verified wrapper; possession alone
    /// grants nothing. Enforce the consumer cap before addresses/fetch/allocation.
    pub fn new(
        sealer: &dyn Sealer,
        descriptor: FileContent,
        max: u64,
    ) -> Result<Self, StreamError> {
        if max > MAX_SOURCE_BYTES {
            return Err(StreamError::TooLarge);
        }
        let profile = match &descriptor {
            FileContent::Blob(b) => {
                if b.size > max {
                    return Err(StreamError::TooLarge);
                }
                crate::crypto::blob::validate_blob_ref(b)
                    .map_err(|_| StreamError::Corrupt("blob descriptor"))?;
                let addresses = sealer.blob_part_addresses(b).ok_or(StreamError::NoKey)?;
                if addresses.len() as u64 != b.part_count() {
                    return Err(StreamError::Corrupt("blob addresses"));
                }
                Profile::Blob {
                    descriptor: b.clone(),
                    addresses,
                    next: 0,
                }
            }
            FileContent::AttachmentV1(a) => {
                if a.total_plain_bytes > max {
                    return Err(StreamError::TooLarge);
                }
                let expected = ExpectedFileV1 {
                    whole_plain_hash: a.whole_plain_hash,
                    total_plain_bytes: a.total_plain_bytes,
                };
                Profile::Attachment(Box::new(AttachmentReader::whole(
                    crate::crypto::chunked_blob::AttachmentRefV1 {
                        context: crate::crypto::chunked_blob::AttachmentContextV1 {
                            collection: a.reference.collection,
                            key_epoch: a.reference.key_epoch,
                            attachment_id: a.reference.attachment_id,
                            chunk_bytes: crate::crypto::chunked_blob::CHUNK_BYTES,
                        },
                        manifest_cipher_hash: a.reference.manifest_cipher_hash,
                    },
                    expected,
                    AttachmentLimits {
                        max_file_bytes: max,
                    },
                )?))
            }
            _ => return Err(StreamError::Corrupt("unsupported file content")),
        };
        Ok(Self {
            descriptor,
            profile,
            bytes: Zeroizing::new(Vec::new()),
            max,
            failed: false,
        })
    }
    /// Next bounded fetch, or None only after all objects have been supplied.
    /// `finish` remains mandatory for whole-source verification.
    pub fn need(&self) -> Result<Option<SourceNeed>, StreamError> {
        if self.failed {
            return Err(StreamError::Protocol("source read failed"));
        }
        Ok(match &self.profile {
            Profile::Blob {
                addresses,
                next,
                descriptor,
            } => {
                if let Some(address) = addresses.get(*next) {
                    let len = crate::crypto::blob::expected_part_len(descriptor, *next as u64)
                        .ok_or(StreamError::Corrupt("blob index"))?;
                    Some(SourceNeed::BlobPart {
                        index: *next as u64,
                        address: *address,
                        max_bytes: crate::crypto::blob::max_sealed_len(len),
                    })
                } else {
                    None
                }
            }
            Profile::Attachment(a) => a.need().map(|n| match n {
                Need::Manifest { address } => SourceNeed::Manifest {
                    address,
                    max_bytes: MAX_SEALED_MANIFEST,
                },
                Need::Chunk {
                    index,
                    address,
                    sealed_bytes,
                } => SourceNeed::Chunk {
                    index,
                    address,
                    bytes: sealed_bytes,
                },
            }),
        })
    }
    /// Supply exactly the requested object. Incorrect order, size, hash or
    /// authentication is fatal to this reader; no retry can turn it into success.
    pub fn supply(
        &mut self,
        sealer: &dyn Sealer,
        need: SourceNeed,
        raw: &[u8],
    ) -> Result<(), StreamError> {
        let result = self.supply_inner(sealer, need, raw);
        if result.is_err() {
            self.failed = true;
            self.bytes.zeroize();
            self.bytes.clear();
        }
        result
    }
    fn supply_inner(
        &mut self,
        sealer: &dyn Sealer,
        need: SourceNeed,
        raw: &[u8],
    ) -> Result<(), StreamError> {
        if self.need()? != Some(need) {
            return Err(StreamError::Protocol("source object out of order"));
        }
        match (&mut self.profile, need) {
            (
                Profile::Blob {
                    descriptor, next, ..
                },
                SourceNeed::BlobPart {
                    index, max_bytes, ..
                },
            ) => {
                if raw.len() as u64 > max_bytes {
                    return Err(StreamError::Corrupt("blob object size"));
                }
                let plain = sealer
                    .open_blob_part(descriptor, index, raw, self.max)
                    .map_err(|e| match e {
                        OpenError::NoKey => StreamError::NoKey,
                        OpenError::Aead => StreamError::Corrupt("blob authentication"),
                    })?;
                let expected = crate::crypto::blob::expected_part_len(descriptor, index)
                    .ok_or(StreamError::Corrupt("blob index"))?;
                if plain.len() as u64 != expected {
                    return Err(StreamError::Corrupt("blob plaintext size"));
                }
                let mut sink = Sink {
                    bytes: &mut self.bytes,
                    max: self.max,
                };
                sink.write(index * descriptor.part_size, &plain)
                    .map_err(StreamError::Sink)?;
                *next += 1;
                Ok(())
            }
            (Profile::Attachment(a), SourceNeed::Manifest { address, max_bytes }) => {
                if raw.len() as u64 > max_bytes || mdbn_wire::hash::sha256(raw) != address {
                    return Err(StreamError::Corrupt("manifest object address"));
                }
                a.supply_manifest(sealer, raw)
            }
            (
                Profile::Attachment(a),
                SourceNeed::Chunk {
                    index,
                    address,
                    bytes,
                },
            ) => {
                if bytes > MAX_SEALED_CHUNK
                    || raw.len() as u64 != bytes
                    || mdbn_wire::hash::sha256(raw) != address
                {
                    return Err(StreamError::Corrupt("chunk object address"));
                }
                a.supply_chunk(
                    sealer,
                    index,
                    raw,
                    &mut Sink {
                        bytes: &mut self.bytes,
                        max: self.max,
                    },
                )
            }
            _ => Err(StreamError::Protocol("source profile")),
        }
    }
    /// Complete authenticated output only. Never reinterpret a partial/failing
    /// read as empty bytes, missing content, a parse diagnostic or a cache hit.
    pub fn finish(self) -> Result<AuthenticatedFileBytes, StreamError> {
        if self.need()?.is_some() {
            return Err(StreamError::Protocol("source incomplete"));
        }
        match self.profile {
            Profile::Blob { descriptor, .. } => {
                if !crate::crypto::blob::check_blob(&descriptor, &self.bytes) {
                    return Err(StreamError::Corrupt("whole blob hash"));
                }
            }
            Profile::Attachment(a) => {
                if (*a).finish()? {
                    return Err(StreamError::Protocol("source cannot be resumed"));
                }
            }
        }
        if self.bytes.len() as u64 > self.max {
            return Err(StreamError::TooLarge);
        }
        Ok(AuthenticatedFileBytes {
            descriptor: self.descriptor,
            bytes: self.bytes,
        })
    }
}

#[cfg(test)]
mod tests;
