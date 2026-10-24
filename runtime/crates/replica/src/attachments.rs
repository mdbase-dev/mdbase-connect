//! Attachment-v1 streaming, sans-IO: the consumer and producer state machines
//! every host drives with its own transport (daemon, hosted Worker, Obsidian).
//!
//! - **Bounded memory.** One chunk at a time: at most one sealed chunk
//!   (`CHUNK_BYTES` plus overhead) and its plaintext, wiped when dropped. Nothing is
//!   ever proportional to the file.
//! - **Authenticated before release.** The manifest is opened only through the
//!   held-key [`Sealer`] adapter under the descriptor and the signed whole-file
//!   size/hash ([`ExpectedFileV1`]); a chunk's plaintext is released only after its
//!   whole object authenticated and its plaintext hash matched the manifest.
//! - **Whole-file check.** A full read hashes every released byte and refuses to
//!   finish unless the result equals the signed whole-file hash. A resumed read
//!   can't carry that hash across a restart, so it reports the bytes the host must
//!   re-hash from its staged file ([`WholeFileHasher`]) before publishing.
//! - **Ranges.** A plaintext range touches only the chunks it needs, and each
//!   chunk is authenticated in full before its slice is released.
//!
//! No wire is invented: hosts fetch the manifest and chunks by address with the
//! existing object read (`get_object`); sealed chunks fit the 9 MiB object cap.

use mdbn_wire::common::{B32, Hash, Uuid};
use sha2::{Digest, Sha256};
use zeroize::{Zeroize, Zeroizing};

use crate::crypto::CsprngEntropy;
use crate::crypto::chunked_blob::{
    AttachmentContextV1, AttachmentLimits, AttachmentRefV1, CHUNK_BYTES, ChunkContextV1,
    ChunkRefV1, ExpectedFileV1, MANIFEST_BYTES, MAX_CHUNKS, ManifestV1, SealedChunkSpan,
    SealedObject, VerifiedManifestV1,
};
use crate::seal::Sealer;

/// Largest complete sealed chunk object a host should accept for one fetch: the
/// log's sealed object cap (9 MiB). The exact size always comes from the
/// authenticated manifest and is checked before the host buffers anything.
pub const MAX_SEALED_CHUNK: u64 = 9 << 20;
/// Largest complete sealed manifest object a host should accept.
pub const MAX_SEALED_MANIFEST: u64 = MANIFEST_BYTES as u64 + (64 << 10);

/// Why a read or write stopped. Never a partial success.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamError {
    /// The object failed authentication, decoding, or its manifest binding.
    Corrupt(&'static str),
    /// No key for the attachment's epoch: wait for a key, then retry.
    NoKey,
    /// Out of order, oversized, or past the end.
    Protocol(&'static str),
    /// The host's sink failed (disk full, cancelled).
    Sink(String),
    /// Over the file-size policy.
    TooLarge,
}

/// The object the host must fetch next (by complete-object address).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Need {
    /// The encrypted manifest.
    Manifest {
        /// Complete-object address.
        address: Hash,
    },
    /// One encrypted chunk.
    Chunk {
        /// Chunk index.
        index: u64,
        /// Complete-object address.
        address: Hash,
        /// Exact complete-object size (check before buffering).
        sealed_bytes: u64,
    },
}

/// Where authenticated plaintext goes (a staging file, a response stream).
pub trait PlainSink {
    /// Write `plain` at plaintext `offset` (offsets only increase).
    fn write(&mut self, offset: u64, plain: &[u8]) -> Result<(), String>;

    /// Take one authenticated chunk without copying its backing allocation.
    /// Its accessors expose only the requested slice and its file offset. The
    /// default preserves existing staging sinks; bounded response hosts may
    /// retain this zeroizing allocation while draining <=1 MiB app frames.
    fn write_owned(&mut self, chunk: AuthenticatedReadChunk) -> Result<(), String> {
        self.write(chunk.offset(), chunk.bytes())
    }
}

/// One completely authenticated chunk's requested plaintext slice. Construction
/// is private; holding it transfers, rather than copies, the zeroizing allocation.
/// No key or ciphertext is exposed and drop wipes the entire chunk allocation.
pub struct AuthenticatedReadChunk {
    offset: u64,
    plain: Zeroizing<Vec<u8>>,
    range: std::ops::Range<usize>,
}

impl AuthenticatedReadChunk {
    /// File offset of the requested slice.
    pub fn offset(&self) -> u64 {
        self.offset
    }
    /// Only the requested, authenticated plaintext slice.
    pub fn bytes(&self) -> &[u8] {
        &self.plain[self.range.clone()]
    }
}

impl std::fmt::Debug for AuthenticatedReadChunk {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AuthenticatedReadChunk")
            .field("offset", &self.offset)
            .field("len", &self.range.len())
            .finish()
    }
}

/// Authenticated requested slice in a caller-owned fixed region. No ownership
/// transfer, key export, or plaintext copy; the caller must wipe its region on
/// cancellation/drop and recheck admission before every emission.
#[derive(Debug)]
pub struct AuthenticatedReadSpan {
    offset: u64,
    range: std::ops::Range<usize>,
}
impl AuthenticatedReadSpan {
    /// File offset of this requested slice.
    pub fn offset(&self) -> u64 {
        self.offset
    }
    /// Authenticated requested bytes inside the original private region.
    pub fn range(&self) -> std::ops::Range<usize> {
        self.range.clone()
    }
}

/// Streaming whole-file SHA-256, for re-checking a staged file after a resume.
#[derive(Default, Clone)]
pub struct WholeFileHasher(Sha256);

impl WholeFileHasher {
    /// Feed the next bytes, in order.
    pub fn update(&mut self, bytes: &[u8]) {
        self.0.update(bytes);
    }
    /// Whether the bytes fed equal the signed whole-file hash.
    pub fn matches(self, expected: &ExpectedFileV1) -> bool {
        self.finish() == expected.whole_plain_hash
    }
    /// The SHA-256 of the bytes fed.
    pub fn finish(self) -> Hash {
        B32(self.0.finalize().into())
    }
}

/// A sans-IO reader of one attachment (whole file, resumed, or a range).
pub struct AttachmentReader {
    descriptor: AttachmentRefV1,
    expected: ExpectedFileV1,
    limits: AttachmentLimits,
    manifest: Option<VerifiedManifestV1>,
    /// Plaintext range `[start, end)` to release.
    start: u64,
    end: u64,
    /// Next chunk to fetch.
    next: u64,
    /// Running whole-file hash (only for a full read from byte 0).
    whole: Option<WholeFileHasher>,
    /// A resumed whole-file read: the host re-hashes its staging at the end.
    resumed: bool,
}

impl std::fmt::Debug for AttachmentReader {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AttachmentReader")
            .field("start", &self.start)
            .field("end", &self.end)
            .field("next", &self.next)
            .finish_non_exhaustive()
    }
}

fn chunk_of(offset: u64) -> u64 {
    offset / u64::from(CHUNK_BYTES)
}

impl AttachmentReader {
    /// Read the whole file, checking the signed whole-file hash at the end.
    pub fn whole(
        descriptor: AttachmentRefV1,
        expected: ExpectedFileV1,
        limits: AttachmentLimits,
    ) -> Result<Self, StreamError> {
        let mut r = Self::range(descriptor, expected, limits, 0, expected.total_plain_bytes)?;
        r.whole = Some(WholeFileHasher::default());
        Ok(r)
    }

    /// Resume a whole-file read at chunk `next` (chunks before it are already in
    /// the host's staging). The host re-hashes the staged file before publishing.
    pub fn resume(
        descriptor: AttachmentRefV1,
        expected: ExpectedFileV1,
        limits: AttachmentLimits,
        next: u64,
    ) -> Result<Self, StreamError> {
        let start = next
            .checked_mul(u64::from(CHUNK_BYTES))
            .ok_or(StreamError::Protocol("resume position"))?
            .min(expected.total_plain_bytes);
        let mut r = Self::range(
            descriptor,
            expected,
            limits,
            start,
            expected.total_plain_bytes,
        )?;
        r.resumed = true;
        Ok(r)
    }

    /// Read plaintext `[start, end)` (clamped to the file), touching only the
    /// chunks it needs.
    pub fn range(
        descriptor: AttachmentRefV1,
        expected: ExpectedFileV1,
        limits: AttachmentLimits,
        start: u64,
        end: u64,
    ) -> Result<Self, StreamError> {
        if expected.total_plain_bytes > limits.max_file_bytes {
            return Err(StreamError::TooLarge);
        }
        let end = end.min(expected.total_plain_bytes);
        if start > end {
            return Err(StreamError::Protocol("range start after end"));
        }
        Ok(Self {
            descriptor,
            expected,
            limits,
            manifest: None,
            start,
            end,
            next: chunk_of(start),
            whole: None,
            resumed: false,
        })
    }

    /// The authenticated manifest, once supplied.
    pub fn manifest(&self) -> Option<&VerifiedManifestV1> {
        self.manifest.as_ref()
    }

    /// The next chunk index (persist it to resume a whole-file read).
    pub fn next_chunk(&self) -> u64 {
        self.next
    }

    /// The last chunk index this read needs, exclusive.
    fn end_chunk(&self, m: &VerifiedManifestV1) -> u64 {
        let chunks = m.manifest().chunks.len() as u64;
        if self.end == 0 || self.start == self.end {
            // An empty range (or empty file) still authenticates its manifest
            // and, for an empty file, its single empty chunk.
            return if self.expected.total_plain_bytes == 0 && self.whole.is_some() {
                1
            } else {
                chunk_of(self.start).min(chunks)
            };
        }
        chunk_of(self.end - 1).saturating_add(1).min(chunks)
    }

    /// What to fetch next, or `None` when the read is complete.
    pub fn need(&self) -> Option<Need> {
        let Some(m) = &self.manifest else {
            return Some(Need::Manifest {
                address: self.descriptor.manifest_cipher_hash,
            });
        };
        if self.next >= self.end_chunk(m) {
            return None;
        }
        let i = usize::try_from(self.next).ok()?;
        let c = m.manifest().chunks.get(i)?;
        Some(Need::Chunk {
            index: self.next,
            address: c.cipher_hash,
            sealed_bytes: c.sealed_bytes,
        })
    }

    /// Supply the fetched manifest object.
    pub fn supply_manifest(&mut self, sealer: &dyn Sealer, raw: &[u8]) -> Result<(), StreamError> {
        if self.manifest.is_some() {
            return Err(StreamError::Protocol("manifest already supplied"));
        }
        if raw.len() as u64 > MAX_SEALED_MANIFEST {
            return Err(StreamError::Corrupt("manifest object too large"));
        }
        let m = sealer
            .open_attachment_manifest(&self.descriptor, self.expected, raw, self.limits)
            .map_err(|e| match e {
                crate::seal::OpenError::NoKey => StreamError::NoKey,
                crate::seal::OpenError::Aead => StreamError::Corrupt("manifest"),
            })?;
        if m.manifest().chunks.len() as u64 > MAX_CHUNKS {
            return Err(StreamError::TooLarge);
        }
        self.manifest = Some(m);
        Ok(())
    }

    /// Supply the fetched chunk `index` (the one [`Self::need`] asked for); its
    /// authenticated plaintext in range goes to `sink`, then is wiped.
    pub fn supply_chunk(
        &mut self,
        sealer: &dyn Sealer,
        index: u64,
        raw: &[u8],
        sink: &mut dyn PlainSink,
    ) -> Result<(), StreamError> {
        let Some(Need::Chunk {
            index: want,
            sealed_bytes,
            ..
        }) = self.need()
        else {
            return Err(StreamError::Protocol("no chunk expected"));
        };
        if index != want {
            return Err(StreamError::Protocol("chunk out of order"));
        }
        if raw.len() as u64 != sealed_bytes || sealed_bytes > MAX_SEALED_CHUNK {
            return Err(StreamError::Corrupt("chunk size"));
        }
        let m = self
            .manifest
            .as_ref()
            .ok_or(StreamError::Protocol("no manifest"))?;
        let plain: Zeroizing<Vec<u8>> =
            sealer
                .open_attachment_chunk(m, index, raw)
                .map_err(|e| match e {
                    crate::seal::OpenError::NoKey => StreamError::NoKey,
                    crate::seal::OpenError::Aead => StreamError::Corrupt("chunk"),
                })?;
        if let Some(h) = self.whole.as_mut() {
            h.update(&plain);
        }
        let base = index * u64::from(CHUNK_BYTES);
        let from = self.start.max(base) - base;
        let to = self.end.min(base + plain.len() as u64).saturating_sub(base);
        if from < to {
            let range = usize::try_from(from).map_err(|_| StreamError::TooLarge)?
                ..usize::try_from(to).map_err(|_| StreamError::TooLarge)?;
            sink.write_owned(AuthenticatedReadChunk {
                offset: base + from,
                plain,
                range,
            })
            .map_err(StreamError::Sink)?;
        }
        self.next += 1;
        Ok(())
    }

    /// Fixed-region counterpart: all authentication completes before producing
    /// a span, including whole-chunk hash. No body-sized allocation/fallback.
    pub fn supply_chunk_in_place(
        &mut self,
        sealer: &dyn Sealer,
        index: u64,
        raw: &mut [u8],
    ) -> Result<AuthenticatedReadSpan, StreamError> {
        let Some(Need::Chunk {
            index: want,
            sealed_bytes,
            ..
        }) = self.need()
        else {
            return Err(StreamError::Protocol("no chunk expected"));
        };
        if index != want {
            return Err(StreamError::Protocol("chunk out of order"));
        }
        if raw.len() as u64 != sealed_bytes || sealed_bytes > MAX_SEALED_CHUNK {
            return Err(StreamError::Corrupt("chunk size"));
        }
        let m = self
            .manifest
            .as_ref()
            .ok_or(StreamError::Protocol("no manifest"))?;
        let plain = sealer
            .open_attachment_chunk_in_place(m, index, raw)
            .map_err(|e| match e {
                crate::seal::OpenError::NoKey => StreamError::NoKey,
                crate::seal::OpenError::Aead => StreamError::Corrupt("chunk"),
            })?;
        let bytes = raw
            .get(plain.clone())
            .ok_or(StreamError::Corrupt("chunk bounds"))?;
        if let Some(h) = self.whole.as_mut() {
            h.update(bytes);
        }
        let base = index * u64::from(CHUNK_BYTES);
        let from = self.start.max(base) - base;
        let to = self.end.min(base + bytes.len() as u64).saturating_sub(base);
        let range = plain.start + usize::try_from(from).map_err(|_| StreamError::TooLarge)?
            ..plain.start + usize::try_from(to).map_err(|_| StreamError::TooLarge)?;
        self.next += 1;
        Ok(AuthenticatedReadSpan {
            offset: base + from,
            range,
        })
    }

    /// Finish: complete, and (for a full read) the whole-file hash matched.
    /// Returns whether the host still has to re-hash its staged file (resumed).
    pub fn finish(self) -> Result<bool, StreamError> {
        if self.need().is_some() {
            return Err(StreamError::Protocol("read incomplete"));
        }
        match self.whole {
            Some(h) => {
                if h.matches(&self.expected) {
                    Ok(false)
                } else {
                    Err(StreamError::Corrupt("whole-file hash"))
                }
            }
            None => Ok(self.resumed),
        }
    }
}

/// A sans-IO writer: chunk, seal and describe one attachment under the sealer's
/// current epoch. The host uploads each returned sealed object (chunks first, the
/// manifest last), then writes the descriptor and expected file metadata into
/// the signed entry, with the complete ref union in `Item.refs`. Cloning keeps
/// a rollback point (no plaintext is held, only the running digest).
#[derive(Clone)]
pub struct AttachmentWriter {
    context: AttachmentContextV1,
    limits: AttachmentLimits,
    total: u64,
    chunks: Vec<ChunkRefV1>,
    whole: Sha256,
    written: u64,
}

impl std::fmt::Debug for AttachmentWriter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AttachmentWriter")
            .field("total", &self.total)
            .field("written", &self.written)
            .finish_non_exhaustive()
    }
}

/// A finished attachment, ready for the signed entry.
#[derive(Debug)]
pub struct WrittenAttachment {
    /// The sealed manifest object to upload last.
    pub manifest: SealedObject,
    /// The descriptor for the entry.
    pub descriptor: AttachmentRefV1,
    /// The signed whole-file metadata for the entry.
    pub expected: ExpectedFileV1,
    /// The complete public ref union: every chunk object, then the manifest.
    pub refs: Vec<Hash>,
}

impl AttachmentWriter {
    /// Start a file of exactly `total` plaintext bytes under the current epoch.
    pub fn new(
        sealer: &dyn Sealer,
        collection: Uuid,
        total: u64,
        limits: AttachmentLimits,
        entropy: &mut dyn CsprngEntropy,
    ) -> Result<Self, StreamError> {
        if total > limits.max_file_bytes || total.div_ceil(u64::from(CHUNK_BYTES)) > MAX_CHUNKS {
            return Err(StreamError::TooLarge);
        }
        let key_epoch = sealer.current_epoch().ok_or(StreamError::NoKey)?;
        let mut id = [0u8; 32];
        entropy.fill(&mut id);
        Ok(Self {
            context: AttachmentContextV1 {
                collection,
                key_epoch,
                attachment_id: B32(id),
                chunk_bytes: CHUNK_BYTES,
            },
            limits,
            total,
            chunks: Vec::new(),
            whole: Sha256::new(),
            written: 0,
        })
    }

    /// Continue an interrupted upload under its original context. Chunks the
    /// earlier attempt stored are re-supplied with [`Self::adopt_chunk`] (the host
    /// re-reads them, so the whole-file hash still covers every byte); the rest
    /// are sealed again with [`Self::push_chunk`]. The context must still be the
    /// sealer's collection and CURRENT epoch: historical keys never write.
    pub fn resume(
        sealer: &dyn Sealer,
        context: AttachmentContextV1,
        total: u64,
        limits: AttachmentLimits,
    ) -> Result<Self, StreamError> {
        if total > limits.max_file_bytes || total.div_ceil(u64::from(CHUNK_BYTES)) > MAX_CHUNKS {
            return Err(StreamError::TooLarge);
        }
        if context.chunk_bytes != CHUNK_BYTES {
            return Err(StreamError::Protocol("chunk profile"));
        }
        if sealer.current_epoch() != Some(context.key_epoch) {
            return Err(StreamError::NoKey);
        }
        Ok(Self {
            context,
            limits,
            total,
            chunks: Vec::new(),
            whole: Sha256::new(),
            written: 0,
        })
    }

    /// The attachment's stable context (collection, epoch, attachment ID).
    pub fn context(&self) -> AttachmentContextV1 {
        self.context
    }

    /// The chunk references so far, in order (a resumable checkpoint).
    pub fn chunks(&self) -> &[ChunkRefV1] {
        &self.chunks
    }

    /// Take over the next chunk from an earlier attempt that already stored its
    /// object, without sealing it again. `plain` is the next chunk exactly as
    /// re-read; it must have the stored chunk's length and plaintext hash, so a
    /// changed source is refused rather than described by a stale manifest.
    pub fn adopt_chunk(&mut self, plain: &[u8], stored: ChunkRefV1) -> Result<(), StreamError> {
        let index = self.chunks.len() as u64;
        let len = self.next_chunk_len();
        let done = self.written == self.total && !(self.total == 0 && index == 0);
        if done || plain.len() as u64 != len {
            return Err(StreamError::Protocol("chunk length"));
        }
        if stored.plain_bytes != len
            || stored.sealed_bytes > MAX_SEALED_CHUNK
            || mdbn_wire::hash::sha256(plain) != stored.plain_hash
        {
            return Err(StreamError::Protocol("adopted chunk does not match"));
        }
        self.whole.update(plain);
        self.written += len;
        self.chunks.push(stored);
        Ok(())
    }

    /// The plaintext size of the next chunk the writer expects.
    pub fn next_chunk_len(&self) -> u64 {
        (self.total - self.written).min(u64::from(CHUNK_BYTES))
    }

    /// Seal the next chunk (exactly [`Self::next_chunk_len`] bytes). Returns the
    /// object to upload.
    pub fn push_chunk(
        &mut self,
        sealer: &dyn Sealer,
        plain: &[u8],
        entropy: &mut dyn CsprngEntropy,
    ) -> Result<SealedObject, StreamError> {
        let index = self.chunks.len() as u64;
        let len = self.next_chunk_len();
        let done = self.written == self.total && !(self.total == 0 && index == 0);
        if done || plain.len() as u64 != len {
            return Err(StreamError::Protocol("chunk length"));
        }
        let final_chunk = self.written + len == self.total;
        let context = ChunkContextV1 {
            attachment: self.context,
            index,
            final_chunk,
            plain_bytes: len,
        };
        let (object, reference) = sealer
            .seal_attachment_chunk(&context, plain, entropy)
            .map_err(|_| StreamError::Corrupt("seal chunk"))?;
        self.whole.update(plain);
        self.written += len;
        self.chunks.push(reference);
        Ok(object)
    }

    /// Seal the next exact chunk into a fixed caller-owned private region.
    /// Eligibility/current held epoch/cap/context precede digest work; the sealer
    /// checks again before entropy/encryption. Commit digest/ref/written ONLY on
    /// success. Any refusal, including a sealer that partially wrote, wipes the
    /// entire region. No owned/copy fallback and no resumable storage is added.
    pub fn push_chunk_in_place(
        &mut self,
        sealer: &dyn Sealer,
        region: &mut [u8],
        plain_bytes: usize,
        entropy: &mut dyn CsprngEntropy,
    ) -> Result<SealedChunkSpan, StreamError> {
        let result = (|| {
            let index = self.chunks.len() as u64;
            let len = self.next_chunk_len();
            let done = self.written == self.total && !(self.total == 0 && index == 0);
            if done || plain_bytes as u64 != len {
                return Err(StreamError::Protocol("chunk length"));
            }
            if sealer.current_epoch() != Some(self.context.key_epoch) {
                return Err(StreamError::NoKey);
            }
            let context = ChunkContextV1 {
                attachment: self.context,
                index,
                final_chunk: self.written + len == self.total,
                plain_bytes: len,
            };
            crate::crypto::chunked_blob::chunk_in_place_len(&context, plain_bytes, region.len())
                .map_err(|_| StreamError::Corrupt("seal chunk"))?;
            sealer
                .attachment_chunk_in_place_check(&context, plain_bytes, region.len())
                .map_err(|_| StreamError::Corrupt("seal chunk"))?;
            // Clone only bounded digest state, never the plaintext region.
            let mut whole = self.whole.clone();
            whole.update(&region[..plain_bytes]);
            let span = sealer
                .seal_attachment_chunk_in_place(&context, region, plain_bytes, entropy)
                .map_err(|_| StreamError::Corrupt("seal chunk"))?;
            self.whole = whole;
            self.written += len;
            self.chunks.push(span.reference());
            Ok(span)
        })();
        if result.is_err() {
            region.zeroize();
        }
        result
    }

    /// Seal the manifest once every chunk is in.
    pub fn finish(
        self,
        sealer: &dyn Sealer,
        entropy: &mut dyn CsprngEntropy,
    ) -> Result<WrittenAttachment, StreamError> {
        let complete = self.written == self.total && !self.chunks.is_empty();
        if !complete {
            return Err(StreamError::Protocol("writer incomplete"));
        }
        let expected = ExpectedFileV1 {
            whole_plain_hash: B32(self.whole.finalize().into()),
            total_plain_bytes: self.total,
        };
        let manifest = ManifestV1 {
            context: self.context,
            file: expected,
            chunks: self.chunks,
        };
        let sealed = sealer
            .seal_attachment_manifest(&manifest, self.limits, entropy)
            .map_err(|_| StreamError::Corrupt("seal manifest"))?;
        let mut refs: Vec<Hash> = manifest.chunks.iter().map(|c| c.cipher_hash).collect();
        refs.push(sealed.cipher_hash);
        Ok(WrittenAttachment {
            descriptor: AttachmentRefV1 {
                context: manifest.context,
                manifest_cipher_hash: sealed.cipher_hash,
            },
            expected,
            refs,
            manifest: sealed,
        })
    }
}

#[cfg(test)]
mod tests;
