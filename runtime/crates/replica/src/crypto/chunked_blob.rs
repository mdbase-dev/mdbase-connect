//! Explicit attachment-v1 crypto: strict complete Item18 framing, single
//! placement-bound HKDF, bounded STREAM and private verified-manifest contexts.
//! This is not a legacy BlobRef dispatch; callers must verify the critical wrapper.
//! No whole padded frame, ciphertext-body decode clone or compression buffer.

pub mod upload_resume;

use chacha20poly1305::aead::{AeadInPlace, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce, Tag};
use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::common::{B16, B32, Hash, Uuid};
use std::collections::BTreeSet;
use zeroize::{Zeroize, Zeroizing};

use super::seal::{SEGMENT, SEGMENT_CT, padme};
use super::{CryptoError, CsprngEntropy, Secret32, ct_eq, hkdf32};

const MAX_CHUNK_PLAIN: usize = 8 << 20;
const MAX_SEALED: usize = 9 << 20;
const FRAME_HEADER: usize = 9;

fn frame_header(len: usize) -> Result<[u8; FRAME_HEADER], CryptoError> {
    let n = u32::try_from(len).map_err(|_| CryptoError::TooLarge)?;
    let mut header = [0; FRAME_HEADER]; // ALG_NONE only for this profile.
    header[1..5].copy_from_slice(&n.to_be_bytes());
    header[5..9].copy_from_slice(&n.to_be_bytes());
    Ok(header)
}

fn shape(len: usize) -> Result<(usize, usize, usize), CryptoError> {
    if len > MAX_CHUNK_PLAIN {
        return Err(CryptoError::TooLarge);
    }
    let padded =
        usize::try_from(padme((len + FRAME_HEADER) as u64)).map_err(|_| CryptoError::TooLarge)?;
    let segments = padded.div_ceil(SEGMENT);
    let sealed = padded
        .checked_add(16 * segments)
        .ok_or(CryptoError::TooLarge)?;
    if sealed > MAX_SEALED {
        return Err(CryptoError::TooLarge);
    }
    Ok((padded, segments, sealed))
}

// EXACT existing ageSTREAM nonce, private: no caller-supplied nonce API.
fn nonce(segment: u64, last: bool) -> [u8; 12] {
    let mut out = [0; 12];
    out[3..11].copy_from_slice(&segment.to_be_bytes());
    out[11] = u8::from(last);
    out
}

/// Copy an overlap from a virtual frame component into the segment scratch.
fn overlap(dst: &mut [u8], start: usize, src: &[u8], at: usize) {
    let begin = start.max(at);
    let end = (start + dst.len()).min(at + src.len());
    if begin < end {
        dst[begin - start..end - start].copy_from_slice(&src[begin - at..end - at]);
    }
}

/// Key is already derived by the attachment KDF. Do NOT call legacy cipher()
/// here: that would silently add a second payload-domain HKDF.
#[cfg(test)]
fn seal_stream(key: &Secret32, aad: &[u8], plain: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let mut output = Vec::with_capacity(shape(plain.len())?.2);
    seal_stream_into(key, aad, plain, &mut output)?;
    Ok(output)
}

// Append directly to the complete Item output: no intermediate large body copy.
fn seal_stream_into(
    key: &Secret32,
    aad: &[u8],
    plain: &[u8],
    output: &mut Vec<u8>,
) -> Result<(), CryptoError> {
    let (padded, segments, _) = shape(plain.len())?;
    let header = frame_header(plain.len())?;
    let cipher = ChaCha20Poly1305::new(Key::from_slice(key.expose()));
    let mut scratch = Zeroizing::new(Vec::with_capacity(SEGMENT));
    for i in 0..segments {
        let start = i * SEGMENT;
        scratch.resize((padded - start).min(SEGMENT), 0);
        scratch.fill(0);
        overlap(&mut scratch, start, &header, 0);
        overlap(&mut scratch, start, plain, FRAME_HEADER);
        let tag = cipher
            .encrypt_in_place_detached(
                Nonce::from_slice(&nonce(i as u64, i + 1 == segments)),
                aad,
                &mut scratch,
            )
            .map_err(|_| CryptoError::Open)?;
        output.extend_from_slice(&scratch);
        output.extend_from_slice(&tag);
    }
    Ok(())
}

/// Accumulate privately and zeroize on any failure; do not return authenticated
/// prefix segments. The caller still must check whole-chunk plaintext/hash and
/// verified manifest context BEFORE handing this output to a consumer.
#[cfg(test)]
fn open_stream(
    key: &Secret32,
    aad: &[u8],
    body: &[u8],
    expected_plain: usize,
) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    open_stream_bounded(key, aad, body, Some(expected_plain), MAX_CHUNK_PLAIN)
}

fn open_stream_bounded(
    key: &Secret32,
    aad: &[u8],
    body: &[u8],
    expected: Option<usize>,
    limit: usize,
) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    if body.len() > shape(limit)?.2 || expected.is_some_and(|n| n > limit) {
        return Err(CryptoError::TooLarge);
    }
    if body.len() <= 16 {
        return Err(CryptoError::Open);
    }
    let segments = body.len().div_ceil(SEGMENT_CT);
    let cipher = ChaCha20Poly1305::new(Key::from_slice(key.expose()));
    let mut output = Zeroizing::new(Vec::new());
    let mut scratch = Zeroizing::new(Vec::with_capacity(SEGMENT));
    let mut expected_plain = 0;
    let mut padded = 0;
    let mut header = [0; FRAME_HEADER];
    for (i, segment) in body.chunks(SEGMENT_CT).enumerate() {
        let split = segment.len().checked_sub(16).ok_or(CryptoError::Open)?;
        scratch.as_mut_slice().zeroize();
        scratch.clear();
        scratch.extend_from_slice(&segment[..split]);
        cipher
            .decrypt_in_place_detached(
                Nonce::from_slice(&nonce(i as u64, i + 1 == segments)),
                aad,
                &mut scratch,
                Tag::from_slice(&segment[split..]),
            )
            .map_err(|_| CryptoError::Open)?;
        if i == 0 {
            let h = scratch.get(..FRAME_HEADER).ok_or(CryptoError::Open)?;
            expected_plain =
                u32::from_be_bytes(h[5..9].try_into().map_err(|_| CryptoError::Open)?) as usize;
            if expected_plain > limit || expected.is_some_and(|n| n != expected_plain) {
                return Err(CryptoError::Open);
            }
            let s = shape(expected_plain)?;
            padded = s.0;
            if s.2 != body.len() {
                return Err(CryptoError::Open);
            }
            header = frame_header(expected_plain)?;
            if h != header {
                return Err(CryptoError::Open);
            }
            output.reserve_exact(expected_plain);
        }
        let start = i * SEGMENT;
        let end = start + scratch.len();
        // Authenticate the exact ALG_NONE header/declared lengths, not just data.
        if start < FRAME_HEADER {
            let n = end.min(FRAME_HEADER) - start;
            if scratch[..n] != header[start..start + n] {
                return Err(CryptoError::Open);
            }
        }
        let data_start = start.max(FRAME_HEADER);
        let data_end = end.min(FRAME_HEADER + expected_plain);
        if data_start < data_end {
            output.extend_from_slice(&scratch[data_start - start..data_end - start]);
        }
        let zeros = (FRAME_HEADER + expected_plain)
            .saturating_sub(start)
            .min(scratch.len());
        if scratch[zeros..].iter().any(|b| *b != 0) {
            return Err(CryptoError::Open);
        }
    }
    if output.len() != expected_plain || padded + 16 * segments != body.len() {
        return Err(CryptoError::Open);
    }
    Ok(output)
}

// Strict bounded CBOR cursor: exact types/arity, minimal heads, no tree/body clone.
struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
}
impl<'a> Reader<'a> {
    fn head(&mut self, major: u8) -> Result<u64, CryptoError> {
        let first = *self.bytes.get(self.pos).ok_or(CryptoError::Open)?;
        self.pos += 1;
        if first >> 5 != major {
            return Err(CryptoError::Open);
        }
        let info = first & 31;
        if info <= 23 {
            return Ok(u64::from(info));
        }
        if !(24..=27).contains(&info) {
            return Err(CryptoError::Open);
        }
        let count = 1usize << (info - 24);
        let end = self.pos.checked_add(count).ok_or(CryptoError::Open)?;
        let bytes = self.bytes.get(self.pos..end).ok_or(CryptoError::Open)?;
        self.pos = end;
        let mut value = 0u64;
        for b in bytes {
            value = (value << 8) | u64::from(*b);
        }
        let minimum = match info {
            24 => 24,
            25 => 256,
            26 => 65_536,
            _ => 4_294_967_296,
        };
        if value < minimum {
            return Err(CryptoError::Open);
        }
        Ok(value)
    }
    fn uint(&mut self) -> Result<u64, CryptoError> {
        self.head(0)
    }
    fn want(&mut self, value: u64) -> Result<(), CryptoError> {
        if self.uint()? != value {
            return Err(CryptoError::Open);
        }
        Ok(())
    }
    fn bytes(&mut self) -> Result<&'a [u8], CryptoError> {
        let size = usize::try_from(self.head(2)?).map_err(|_| CryptoError::Open)?;
        let end = self.pos.checked_add(size).ok_or(CryptoError::Open)?;
        let bytes = self.bytes.get(self.pos..end).ok_or(CryptoError::Open)?;
        self.pos = end;
        Ok(bytes)
    }
    fn fixed<const N: usize>(&mut self) -> Result<[u8; N], CryptoError> {
        self.bytes()?.try_into().map_err(|_| CryptoError::Open)
    }
    fn finish(&self) -> Result<(), CryptoError> {
        if self.pos != self.bytes.len() {
            return Err(CryptoError::Open);
        }
        Ok(())
    }
}

fn item_header(collection: Uuid, epoch: u64, salt: B16) -> Result<Vec<u8>, CryptoError> {
    cbor::encode(&Cbor::Map(vec![
        (Cbor::Uint(0), Cbor::Uint(1)),
        (Cbor::Uint(1), Cbor::Uint(18)),
        (Cbor::Uint(2), Cbor::Bytes(collection.0.to_vec())),
        (Cbor::Uint(5), Cbor::Uint(epoch)),
        (Cbor::Uint(7), Cbor::Bytes(salt.0.to_vec())),
    ]))
    .map_err(|_| CryptoError::Encode)
}

fn put_head(out: &mut Vec<u8>, major: u8, value: u64) {
    let m = major << 5;
    match value {
        0..=23 => out.push(m | value as u8),
        24..=255 => out.extend_from_slice(&[m | 24, value as u8]),
        256..=65_535 => {
            out.push(m | 25);
            out.extend_from_slice(&(value as u16).to_be_bytes());
        }
        65_536..=4_294_967_295 => {
            out.push(m | 26);
            out.extend_from_slice(&(value as u32).to_be_bytes());
        }
        _ => {
            out.push(m | 27);
            out.extend_from_slice(&value.to_be_bytes());
        }
    }
}

fn item_prefix(header: &[u8], body_bytes: usize) -> Result<Vec<u8>, CryptoError> {
    let mut prefix = bounded_item_prefix(header, body_bytes)?;
    prefix.reserve_exact(body_bytes);
    Ok(prefix)
}

// Shared exact framing writer, without reserving the not-yet-received body.
fn bounded_item_prefix(header: &[u8], body_bytes: usize) -> Result<Vec<u8>, CryptoError> {
    if header.first() != Some(&0xa5) {
        return Err(CryptoError::Encode);
    }
    let mut prefix = header.to_vec();
    prefix[0] = 0xa6;
    put_head(&mut prefix, 0, 11);
    put_head(&mut prefix, 2, body_bytes as u64);
    let total = prefix
        .len()
        .checked_add(body_bytes)
        .ok_or(CryptoError::TooLarge)?;
    if total > MAX_SEALED {
        return Err(CryptoError::TooLarge);
    }
    Ok(prefix)
}

struct BorrowedItem<'a> {
    salt: B16,
    header: Vec<u8>,
    body: &'a [u8],
}
fn read_item(raw: &[u8], collection: Uuid, epoch: u64) -> Result<BorrowedItem<'_>, CryptoError> {
    if raw.len() > MAX_SEALED {
        return Err(CryptoError::TooLarge);
    }
    let mut r = Reader { bytes: raw, pos: 0 };
    if r.head(5)? != 6 {
        return Err(CryptoError::Open);
    }
    r.want(0)?;
    r.want(1)?;
    r.want(1)?;
    r.want(18)?;
    r.want(2)?;
    if r.fixed::<16>()? != collection.0 {
        return Err(CryptoError::Open);
    }
    r.want(5)?;
    if r.uint()? != epoch {
        return Err(CryptoError::Open);
    }
    r.want(7)?;
    let salt = B16(r.fixed::<16>()?);
    // Only a fixed small header is copied. The ciphertext body stays borrowed.
    let mut header = raw[..r.pos].to_vec();
    header[0] = 0xa5;
    r.want(11)?;
    let body = r.bytes()?;
    r.finish()?;
    Ok(BorrowedItem { salt, header, body })
}

/// Fixed attachment-v1 plaintext chunk size.
pub const CHUNK_BYTES: u32 = 8 << 20;
/// Maximum canonical manifest plaintext bytes.
pub const MANIFEST_BYTES: usize = 64 << 10;

/// Maximum complete sealed manifest Item18 bytes for this epoch. Use this before
/// transport allocation; the plaintext limit alone omits Padmé/STREAM/envelope
/// overhead. `u64::MAX` gives the global bound for every CBOR epoch width.
/// This uses the same exact shape/header/prefix writers as sealing and reserves
/// only the small header, never a manifest/ciphertext body or a key.
pub fn max_manifest_sealed_bytes(epoch: u64) -> Result<usize, CryptoError> {
    let body_bytes = shape(MANIFEST_BYTES)?.2;
    // Collection and salt have fixed 16-byte encodings irrespective of value.
    let header = item_header(B16([0; 16]), epoch, B16([0; 16]))?;
    bounded_item_prefix(&header, body_bytes)?
        .len()
        .checked_add(body_bytes)
        .ok_or(CryptoError::TooLarge)
}
/// Per-attachment ceiling; the caller also enforces the all-item union cap.
pub const MAX_CHUNKS: u64 = 1_023;
const CHUNK_DOMAIN: &str = "mdbase/v1/attachment-chunk";
const MANIFEST_DOMAIN: &str = "mdbase/v1/attachment-manifest";

/// Stable attachment context, supplied by an authenticated reference.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AttachmentContextV1 {
    /// Collection UUID.
    pub collection: Uuid,
    /// Held epoch, not a caller permission to use a key.
    pub key_epoch: u64,
    /// Random logical ID, stable only for permitted same-context edits.
    pub attachment_id: B32,
    /// Must equal CHUNK_BYTES for version1.
    pub chunk_bytes: u32,
}
impl AttachmentContextV1 {
    fn validate(&self) -> Result<(), CryptoError> {
        if self.chunk_bytes != CHUNK_BYTES {
            return Err(CryptoError::Open);
        }
        Ok(())
    }
    fn fields(&self) -> Vec<Cbor> {
        vec![
            Cbor::Uint(1),
            Cbor::Bytes(self.collection.0.to_vec()),
            Cbor::Uint(self.key_epoch),
            Cbor::Bytes(self.attachment_id.0.to_vec()),
            Cbor::Uint(u64::from(self.chunk_bytes)),
        ]
    }
}

/// Explicit new-profile descriptor; never infer this from legacy BlobRef/kind18.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AttachmentRefV1 {
    /// Stable context.
    pub context: AttachmentContextV1,
    /// SHA256 of the COMPLETE encoded manifest Item.
    pub manifest_cipher_hash: Hash,
}
/// Required signed file metadata, checked against the authenticated manifest.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExpectedFileV1 {
    /// Whole-file plaintext SHA256.
    pub whole_plain_hash: Hash,
    /// Whole-file plaintext size.
    pub total_plain_bytes: u64,
}
/// Caller policy limit, independent of object/item/manifest caps.
#[derive(Debug, Clone, Copy)]
pub struct AttachmentLimits {
    /// Largest permitted whole attachment.
    pub max_file_bytes: u64,
}
impl Default for AttachmentLimits {
    fn default() -> Self {
        Self {
            max_file_bytes: 1 << 30,
        }
    }
}
/// Authenticated per-chunk identities and lengths.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChunkRefV1 {
    /// SHA256 of the COMPLETE encoded chunk Item.
    pub cipher_hash: Hash,
    /// COMPLETE encoded Item size.
    pub sealed_bytes: u64,
    /// Plaintext chunk SHA256.
    pub plain_hash: Hash,
    /// Plaintext chunk size.
    pub plain_bytes: u64,
}
/// Writer-side stable chunk AAD; readers obtain it from VerifiedManifestV1.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChunkContextV1 {
    /// Stable attachment context.
    pub attachment: AttachmentContextV1,
    /// Ordered chunk index.
    pub index: u64,
    /// External attachment finality, distinct from internal STREAM segment last.
    pub final_chunk: bool,
    /// Exact plaintext size.
    pub plain_bytes: u64,
}
impl ChunkContextV1 {
    fn validate(&self) -> Result<(), CryptoError> {
        self.attachment.validate()?;
        if self.index >= MAX_CHUNKS
            || self.plain_bytes > u64::from(CHUNK_BYTES)
            || (!self.final_chunk && self.plain_bytes != u64::from(CHUNK_BYTES))
            || (self.plain_bytes == 0 && (!self.final_chunk || self.index != 0))
        {
            return Err(CryptoError::Open);
        }
        Ok(())
    }
    fn cbor(&self) -> Cbor {
        let mut fields = self.attachment.fields();
        fields.extend([
            Cbor::Uint(self.index),
            Cbor::Bool(self.final_chunk),
            Cbor::Uint(self.plain_bytes),
        ]);
        Cbor::Array(fields)
    }
}
/// Writer manifest. Its validation does not establish ciphertext authentication.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestV1 {
    /// Stable context.
    pub context: AttachmentContextV1,
    /// Mutable whole-file metadata.
    pub file: ExpectedFileV1,
    /// Authoritative order; finality derives from the last index.
    pub chunks: Vec<ChunkRefV1>,
}
/// Authenticated, strictly decoded manifest. No unchecked constructor or From.
#[derive(Debug)]
pub struct VerifiedManifestV1 {
    manifest: ManifestV1,
    descriptor: AttachmentRefV1,
}
impl VerifiedManifestV1 {
    /// Immutable authenticated metadata.
    pub fn manifest(&self) -> &ManifestV1 {
        &self.manifest
    }
    /// The verified pointer.
    pub fn descriptor(&self) -> &AttachmentRefV1 {
        &self.descriptor
    }
    /// Authenticated expected context for an in-range index.
    pub fn chunk_context(&self, index: u64) -> Result<ChunkContextV1, CryptoError> {
        let i = usize::try_from(index).map_err(|_| CryptoError::Open)?;
        let chunk = self.manifest.chunks.get(i).ok_or(CryptoError::Open)?;
        Ok(ChunkContextV1 {
            attachment: self.manifest.context,
            index,
            final_chunk: i + 1 == self.manifest.chunks.len(),
            plain_bytes: chunk.plain_bytes,
        })
    }
}
/// Immutable complete encoded object, ready for bounded transport.
#[derive(Debug)]
pub struct SealedObject {
    /// Complete canonical Item bytes, not just its body.
    pub bytes: Vec<u8>,
    /// Complete-object SHA256/address/checksum.
    pub cipher_hash: Hash,
}

fn context_crypto(
    key: &Secret32,
    salt: B16,
    domain: &str,
    context: &Cbor,
    header: &[u8],
) -> Result<(Secret32, Vec<u8>), CryptoError> {
    let info = cbor::encode(&Cbor::Array(vec![
        Cbor::Text(domain.into()),
        context.clone(),
    ]))
    .map_err(|_| CryptoError::Encode)?;
    let derived = hkdf32(key.expose(), &salt.0, &info);
    let aad = cbor::encode(&Cbor::Array(vec![
        Cbor::Text(domain.into()),
        context.clone(),
        Cbor::Bytes(header.to_vec()),
    ]))
    .map_err(|_| CryptoError::Encode)?;
    Ok((derived, aad))
}
fn seal_object(
    key: &Secret32,
    attachment: AttachmentContextV1,
    domain: &str,
    context: Cbor,
    plain: &[u8],
    entropy: &mut dyn CsprngEntropy,
) -> Result<SealedObject, CryptoError> {
    attachment.validate()?;
    let body_len = shape(plain.len())?.2;
    let mut salt = B16([0; 16]);
    entropy.fill(&mut salt.0);
    let header = item_header(attachment.collection, attachment.key_epoch, salt)?;
    let (derived, aad) = context_crypto(key, salt, domain, &context, &header)?;
    let mut bytes = item_prefix(&header, body_len)?;
    seal_stream_into(&derived, &aad, plain, &mut bytes)?;
    let cipher_hash = mdbn_wire::hash::sha256(&bytes);
    Ok(SealedObject { bytes, cipher_hash })
}
fn open_object(
    key: &Secret32,
    attachment: AttachmentContextV1,
    purpose: (&str, Cbor),
    raw: &[u8],
    expected_hash: Hash,
    expected_len: Option<usize>,
    limit: usize,
) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    attachment.validate()?;
    if raw.len() > MAX_SEALED {
        return Err(CryptoError::TooLarge);
    }
    if !ct_eq(&mdbn_wire::hash::sha256(raw).0, &expected_hash.0) {
        return Err(CryptoError::Open);
    }
    let object = read_item(raw, attachment.collection, attachment.key_epoch)?;
    let (derived, aad) = context_crypto(key, object.salt, purpose.0, &purpose.1, &object.header)?;
    open_stream_bounded(&derived, &aad, object.body, expected_len, limit)
}
/// Seal one validated chunk with fresh CSPRNG salt and placement-bound KDF/AAD.
pub fn seal_chunk(
    key: &Secret32,
    context: &ChunkContextV1,
    plain: &[u8],
    entropy: &mut dyn CsprngEntropy,
) -> Result<(SealedObject, ChunkRefV1), CryptoError> {
    context.validate()?;
    if plain.len() as u64 != context.plain_bytes {
        return Err(CryptoError::Open);
    }
    let object = seal_object(
        key,
        context.attachment,
        CHUNK_DOMAIN,
        context.cbor(),
        plain,
        entropy,
    )?;
    let reference = ChunkRefV1 {
        cipher_hash: object.cipher_hash,
        sealed_bytes: object.bytes.len() as u64,
        plain_hash: mdbn_wire::hash::sha256(plain),
        plain_bytes: context.plain_bytes,
    };
    Ok((object, reference))
}
/// Exact complete sealed chunk in the caller's private region. Construction is
/// private: no caller-selected range or plaintext/held key can escape this type.
/// The caller must wipe the region on cancellation and recheck live authority
/// before sending any of these ciphertext bytes.
#[derive(Debug)]
pub struct SealedChunkSpan {
    range: std::ops::Range<usize>,
    reference: ChunkRefV1,
}

impl SealedChunkSpan {
    /// Only the complete sealed Item's bytes in the original region.
    pub fn range(&self) -> std::ops::Range<usize> {
        self.range.clone()
    }
    /// Complete ciphertext Item address, not a plaintext hash or key.
    pub fn cipher_hash(&self) -> Hash {
        self.reference.cipher_hash
    }
    pub(crate) fn reference(&self) -> ChunkRefV1 {
        self.reference
    }
}

/// Pure preflight: reject context, length and region caps before plaintext work
/// or entropy. This is eligibility only, never a continuing authority permit.
pub(crate) fn chunk_in_place_len(
    context: &ChunkContextV1,
    plain_bytes: usize,
    region_bytes: usize,
) -> Result<usize, CryptoError> {
    context.validate()?;
    if region_bytes > MAX_SEALED || plain_bytes > region_bytes {
        return Err(CryptoError::TooLarge);
    }
    if plain_bytes as u64 != context.plain_bytes {
        return Err(CryptoError::Open);
    }
    let sealed = shape(plain_bytes)?.2;
    // Salt has fixed encoded width. Never use item_prefix here: it reserves a
    // body-sized allocation. Only bounded header metadata is allocated.
    let header = item_header(
        context.attachment.collection,
        context.attachment.key_epoch,
        B16([0; 16]),
    )?;
    let total = bounded_item_prefix(&header, sealed)?.len() + sealed;
    if total > region_bytes {
        return Err(CryptoError::TooLarge);
    }
    Ok(total)
}

/// Seal plaintext at region[0..plain_bytes] into the SAME backing region. Exact
/// existing Item18/STREAM/KDF/AAD/salt/tag/padding profile; no body allocation or
/// segment plaintext copy. Errors wipe the ENTIRE supplied region, not a prefix.
pub fn seal_chunk_in_place(
    key: &Secret32,
    context: &ChunkContextV1,
    region: &mut [u8],
    plain_bytes: usize,
    entropy: &mut dyn CsprngEntropy,
) -> Result<SealedChunkSpan, CryptoError> {
    let result = (|| {
        let total = chunk_in_place_len(context, plain_bytes, region.len())?;
        let (padded, segments, sealed) = shape(plain_bytes)?;
        let frame = frame_header(plain_bytes)?;
        let plain_hash = mdbn_wire::hash::sha256(&region[..plain_bytes]);
        let mut salt = B16([0; 16]);
        entropy.fill(&mut salt.0);
        let header = item_header(
            context.attachment.collection,
            context.attachment.key_epoch,
            salt,
        )?;
        let prefix = bounded_item_prefix(&header, sealed)?;
        let (derived, aad) = context_crypto(key, salt, CHUNK_DOMAIN, &context.cbor(), &header)?;
        // Expand right-to-left: a destination is always to the RIGHT of its
        // plaintext source, never over an earlier segment still to be moved.
        for i in (0..segments).rev() {
            let start = i * SEGMENT;
            let end = (start + SEGMENT).min(padded);
            let data_start = start.max(FRAME_HEADER);
            let data_end = end.min(FRAME_HEADER + plain_bytes);
            if data_start < data_end {
                region.copy_within(
                    data_start - FRAME_HEADER..data_end - FRAME_HEADER,
                    prefix.len() + i * SEGMENT_CT + data_start - start,
                );
            }
        }
        region[..prefix.len()].copy_from_slice(&prefix);
        region[prefix.len()..prefix.len() + FRAME_HEADER].copy_from_slice(&frame);
        let cipher = ChaCha20Poly1305::new(Key::from_slice(derived.expose()));
        for i in 0..segments {
            let start = i * SEGMENT;
            let count = (padded - start).min(SEGMENT);
            let at = prefix.len() + i * SEGMENT_CT;
            let zeros = (FRAME_HEADER + plain_bytes)
                .saturating_sub(start)
                .min(count);
            region[at + zeros..at + count].fill(0);
            let tag = cipher
                .encrypt_in_place_detached(
                    Nonce::from_slice(&nonce(i as u64, i + 1 == segments)),
                    &aad,
                    &mut region[at..at + count],
                )
                .map_err(|_| CryptoError::Open)?;
            region[at + count..at + count + 16].copy_from_slice(&tag);
        }
        region[total..].zeroize();
        Ok(SealedChunkSpan {
            range: 0..total,
            reference: ChunkRefV1 {
                cipher_hash: mdbn_wire::hash::sha256(&region[..total]),
                sealed_bytes: total as u64,
                plain_hash,
                plain_bytes: context.plain_bytes,
            },
        })
    })();
    if result.is_err() {
        region.zeroize();
    }
    result
}

/// Authenticate the entire object and chunk before returning any plaintext.
pub fn open_chunk(
    key: &Secret32,
    manifest: &VerifiedManifestV1,
    index: u64,
    raw: &[u8],
) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    let context = manifest.chunk_context(index)?;
    let reference =
        &manifest.manifest.chunks[usize::try_from(index).map_err(|_| CryptoError::Open)?];
    if raw.len() as u64 != reference.sealed_bytes {
        return Err(CryptoError::Open);
    }
    let plain = open_object(
        key,
        context.attachment,
        (CHUNK_DOMAIN, context.cbor()),
        raw,
        reference.cipher_hash,
        Some(usize::try_from(context.plain_bytes).map_err(|_| CryptoError::TooLarge)?),
        MAX_CHUNK_PLAIN,
    )?;
    if !ct_eq(&mdbn_wire::hash::sha256(&plain).0, &reference.plain_hash.0) {
        return Err(CryptoError::Open);
    }
    Ok(plain)
}
/// Authenticate and compact a complete sealed chunk inside the caller's fixed
/// private region. The returned range is the ONLY releasable plaintext. On any
/// failure the entire supplied region is wiped, including authenticated prefixes.
/// No body-sized allocation; STREAM tags, exact padding/header, complete-object
/// checksum, placement context and whole-chunk plaintext hash all remain required.
pub fn open_chunk_in_place(
    key: &Secret32,
    manifest: &VerifiedManifestV1,
    index: u64,
    raw: &mut [u8],
) -> Result<std::ops::Range<usize>, CryptoError> {
    let result = (|| {
        let context = manifest.chunk_context(index)?;
        let reference =
            &manifest.manifest.chunks[usize::try_from(index).map_err(|_| CryptoError::Open)?];
        open_bound_chunk_in_place(key, &context, reference, raw)
    })();
    if result.is_err() {
        raw.zeroize();
    }
    result
}

// Private common authenticator. Public read callers need VerifiedManifestV1;
// staged resume callers need the separately authenticated purpose-bound journal.
// No raw-context public opener or unchecked VerifiedManifest constructor.
fn open_bound_chunk_in_place(
    key: &Secret32,
    context: &ChunkContextV1,
    reference: &ChunkRefV1,
    raw: &mut [u8],
) -> Result<std::ops::Range<usize>, CryptoError> {
    let result = (|| {
        context.validate()?;
        if raw.len() > MAX_SEALED
            || raw.len() as u64 != reference.sealed_bytes
            || !ct_eq(&mdbn_wire::hash::sha256(raw).0, &reference.cipher_hash.0)
        {
            return Err(CryptoError::Open);
        }
        let expected = usize::try_from(context.plain_bytes).map_err(|_| CryptoError::TooLarge)?;
        let (padded, segments, sealed) = shape(expected)?;
        let (offset, length, derived, aad) = {
            let object = read_item(
                raw,
                context.attachment.collection,
                context.attachment.key_epoch,
            )?;
            let offset = object.body.as_ptr() as usize - raw.as_ptr() as usize;
            let (derived, aad) = context_crypto(
                key,
                object.salt,
                CHUNK_DOMAIN,
                &context.cbor(),
                &object.header,
            )?;
            (offset, object.body.len(), derived, aad)
        };
        if length != sealed {
            return Err(CryptoError::Open);
        }
        let body = &mut raw[offset..offset + length];
        let cipher = ChaCha20Poly1305::new(Key::from_slice(derived.expose()));
        let header = frame_header(expected)?;
        let mut written = 0usize;
        for i in 0..segments {
            let frame_start = i * SEGMENT;
            let plain_len = (padded - frame_start).min(SEGMENT);
            let cipher_start = i * SEGMENT_CT;
            {
                let segment = &mut body[cipher_start..cipher_start + plain_len + 16];
                let (plain, tag) = segment.split_at_mut(plain_len);
                cipher
                    .decrypt_in_place_detached(
                        Nonce::from_slice(&nonce(i as u64, i + 1 == segments)),
                        &aad,
                        plain,
                        Tag::from_slice(tag),
                    )
                    .map_err(|_| CryptoError::Open)?;
                if i == 0 && plain.get(..FRAME_HEADER) != Some(header.as_slice()) {
                    return Err(CryptoError::Open);
                }
                let zeros = (FRAME_HEADER + expected)
                    .saturating_sub(frame_start)
                    .min(plain_len);
                if plain[zeros..].iter().any(|b| *b != 0) {
                    return Err(CryptoError::Open);
                }
            }
            let data_start = frame_start.max(FRAME_HEADER);
            let data_end = (frame_start + plain_len).min(FRAME_HEADER + expected);
            if data_start < data_end {
                let start = cipher_start + data_start - frame_start;
                let count = data_end - data_start;
                // Destination trails the ciphertext cursor, never a future tag.
                body.copy_within(start..start + count, written);
                written += count;
            }
        }
        if written != expected
            || !ct_eq(
                &mdbn_wire::hash::sha256(&body[..written]).0,
                &reference.plain_hash.0,
            )
        {
            return Err(CryptoError::Open);
        }
        body[written..].zeroize();
        Ok(offset..offset + written)
    })();
    if result.is_err() {
        raw.zeroize();
    }
    result
}
fn expected_count(total: u64, limits: AttachmentLimits) -> Result<u64, CryptoError> {
    let n = total.div_ceil(u64::from(CHUNK_BYTES)).max(1);
    if total > limits.max_file_bytes || n > MAX_CHUNKS {
        return Err(CryptoError::TooLarge);
    }
    Ok(n)
}
fn head_size(value: u64) -> usize {
    match value {
        0..=23 => 1,
        24..=255 => 2,
        256..=65_535 => 3,
        65_536..=4_294_967_295 => 5,
        _ => 9,
    }
}
fn object_size(plain: u64, context: AttachmentContextV1) -> Result<u64, CryptoError> {
    let body = shape(usize::try_from(plain).map_err(|_| CryptoError::TooLarge)?)?.2;
    let header = item_header(context.collection, context.key_epoch, B16([0; 16]))?;
    let n = header.len() + 1 + head_size(body as u64) + body;
    if n > MAX_SEALED {
        return Err(CryptoError::TooLarge);
    }
    Ok(n as u64)
}
fn encoded_manifest_size(m: &ManifestV1) -> usize {
    1 + 1
        + 17
        + head_size(m.context.key_epoch)
        + 34
        + head_size(u64::from(CHUNK_BYTES))
        + head_size(m.file.total_plain_bytes)
        + 34
        + head_size(m.chunks.len() as u64)
        + m.chunks
            .iter()
            .map(|c| 1 + 34 + head_size(c.sealed_bytes) + 34 + head_size(c.plain_bytes))
            .sum::<usize>()
}
fn validate_manifest(m: &ManifestV1, limits: AttachmentLimits) -> Result<(), CryptoError> {
    m.context.validate()?;
    let n = expected_count(m.file.total_plain_bytes, limits)?;
    if m.chunks.len() as u64 != n || encoded_manifest_size(m) > MANIFEST_BYTES {
        return Err(CryptoError::Open);
    }
    let mut hashes = BTreeSet::new();
    for (i, c) in m.chunks.iter().enumerate() {
        let start = (i as u64)
            .checked_mul(u64::from(CHUNK_BYTES))
            .ok_or(CryptoError::Open)?;
        let want = m
            .file
            .total_plain_bytes
            .checked_sub(start)
            .ok_or(CryptoError::Open)?
            .min(u64::from(CHUNK_BYTES));
        if c.plain_bytes != want
            || c.sealed_bytes != object_size(want, m.context)?
            || !hashes.insert(c.cipher_hash)
        {
            return Err(CryptoError::Open);
        }
    }
    if m.file.total_plain_bytes == 0
        && (!ct_eq(&m.file.whole_plain_hash.0, &mdbn_wire::hash::sha256(&[]).0)
            || !ct_eq(&m.chunks[0].plain_hash.0, &m.file.whole_plain_hash.0))
    {
        return Err(CryptoError::Open);
    }
    Ok(())
}
fn put_bytes(out: &mut Vec<u8>, bytes: &[u8]) {
    put_head(out, 2, bytes.len() as u64);
    out.extend_from_slice(bytes);
}
/// Encode the exact File manifest tuple; validates shape before allocation.
pub fn encode_manifest(
    m: &ManifestV1,
    limits: AttachmentLimits,
) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    validate_manifest(m, limits)?;
    let mut out = Zeroizing::new(Vec::with_capacity(encoded_manifest_size(m)));
    put_head(&mut out, 4, 8);
    put_head(&mut out, 0, 1);
    put_bytes(&mut out, &m.context.collection.0);
    put_head(&mut out, 0, m.context.key_epoch);
    put_bytes(&mut out, &m.context.attachment_id.0);
    put_head(&mut out, 0, u64::from(CHUNK_BYTES));
    put_head(&mut out, 0, m.file.total_plain_bytes);
    put_bytes(&mut out, &m.file.whole_plain_hash.0);
    put_head(&mut out, 4, m.chunks.len() as u64);
    for c in &m.chunks {
        put_head(&mut out, 4, 4);
        put_bytes(&mut out, &c.cipher_hash.0);
        put_head(&mut out, 0, c.sealed_bytes);
        put_bytes(&mut out, &c.plain_hash.0);
        put_head(&mut out, 0, c.plain_bytes);
    }
    Ok(out)
}
fn decode_manifest(
    raw: &[u8],
    descriptor: &AttachmentRefV1,
    expected: ExpectedFileV1,
    limits: AttachmentLimits,
) -> Result<ManifestV1, CryptoError> {
    if raw.len() > MANIFEST_BYTES {
        return Err(CryptoError::TooLarge);
    }
    let mut r = Reader { bytes: raw, pos: 0 };
    if r.head(4)? != 8 {
        return Err(CryptoError::Open);
    }
    r.want(1)?;
    let context = AttachmentContextV1 {
        collection: B16(r.fixed::<16>()?),
        key_epoch: r.uint()?,
        attachment_id: B32(r.fixed::<32>()?),
        chunk_bytes: u32::try_from(r.uint()?).map_err(|_| CryptoError::Open)?,
    };
    if context != descriptor.context {
        return Err(CryptoError::Open);
    }
    let file = ExpectedFileV1 {
        total_plain_bytes: r.uint()?,
        whole_plain_hash: B32(r.fixed::<32>()?),
    };
    if file.total_plain_bytes != expected.total_plain_bytes
        || !ct_eq(&file.whole_plain_hash.0, &expected.whole_plain_hash.0)
    {
        return Err(CryptoError::Open);
    }
    let count = r.head(4)?;
    if count != expected_count(file.total_plain_bytes, limits)? || count > (raw.len() / 71) as u64 {
        return Err(CryptoError::Open);
    }
    let mut chunks = Vec::with_capacity(usize::try_from(count).map_err(|_| CryptoError::Open)?);
    for _ in 0..count {
        if r.head(4)? != 4 {
            return Err(CryptoError::Open);
        }
        chunks.push(ChunkRefV1 {
            cipher_hash: B32(r.fixed::<32>()?),
            sealed_bytes: r.uint()?,
            plain_hash: B32(r.fixed::<32>()?),
            plain_bytes: r.uint()?,
        });
    }
    r.finish()?;
    let m = ManifestV1 {
        context,
        file,
        chunks,
    };
    validate_manifest(&m, limits)?;
    Ok(m)
}
/// Validate and seal the manifest with a separate domain and fresh salt.
pub fn seal_manifest(
    key: &Secret32,
    manifest: &ManifestV1,
    limits: AttachmentLimits,
    entropy: &mut dyn CsprngEntropy,
) -> Result<SealedObject, CryptoError> {
    let plain = encode_manifest(manifest, limits)?;
    seal_object(
        key,
        manifest.context,
        MANIFEST_DOMAIN,
        Cbor::Array(manifest.context.fields()),
        &plain,
        entropy,
    )
}
/// The ONLY VerifiedManifest constructor: full hash/AEAD, strict bounded decode,
/// descriptor equality and REQUIRED signed whole-file metadata equality.
pub fn open_manifest(
    key: &Secret32,
    descriptor: &AttachmentRefV1,
    expected: ExpectedFileV1,
    raw: &[u8],
    limits: AttachmentLimits,
) -> Result<VerifiedManifestV1, CryptoError> {
    if raw.len() > max_manifest_sealed_bytes(descriptor.context.key_epoch)? {
        return Err(CryptoError::TooLarge);
    }
    expected_count(expected.total_plain_bytes, limits)?;
    let plain = open_object(
        key,
        descriptor.context,
        (MANIFEST_DOMAIN, Cbor::Array(descriptor.context.fields())),
        raw,
        descriptor.manifest_cipher_hash,
        None,
        MANIFEST_BYTES,
    )?;
    let manifest = decode_manifest(&plain, descriptor, expected, limits)?;
    Ok(VerifiedManifestV1 {
        manifest,
        descriptor: *descriptor,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FixedSalt(u8);
    impl super::super::Entropy for FixedSalt {
        fn fill(&mut self, out: &mut [u8]) {
            out.fill(self.0);
        }
    }
    impl CsprngEntropy for FixedSalt {}
    fn context() -> AttachmentContextV1 {
        AttachmentContextV1 {
            collection: B16([3; 16]),
            key_epoch: 7,
            attachment_id: B32([4; 32]),
            chunk_bytes: CHUNK_BYTES,
        }
    }
    fn chunk_context(index: u64, final_chunk: bool, plain_bytes: u64) -> ChunkContextV1 {
        ChunkContextV1 {
            attachment: context(),
            index,
            final_chunk,
            plain_bytes,
        }
    }
    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }
    fn file(plain: &[u8]) -> ExpectedFileV1 {
        ExpectedFileV1 {
            total_plain_bytes: plain.len() as u64,
            whole_plain_hash: mdbn_wire::hash::sha256(plain),
        }
    }
    fn verified(key: &Secret32, m: &ManifestV1) -> VerifiedManifestV1 {
        let sealed = seal_manifest(key, m, AttachmentLimits::default(), &mut FixedSalt(6)).unwrap();
        let descriptor = AttachmentRefV1 {
            context: m.context,
            manifest_cipher_hash: sealed.cipher_hash,
        };
        open_manifest(
            key,
            &descriptor,
            m.file,
            &sealed.bytes,
            AttachmentLimits::default(),
        )
        .unwrap()
    }
    fn small() -> (Secret32, SealedObject, ManifestV1) {
        let key = Secret32([9; 32]);
        let (chunk, reference) =
            seal_chunk(&key, &chunk_context(0, true, 3), b"abc", &mut FixedSalt(5)).unwrap();
        let m = ManifestV1 {
            context: context(),
            file: file(b"abc"),
            chunks: vec![reference],
        };
        (key, chunk, m)
    }

    #[test]
    fn manifest_transport_bound_matches_exact_writer_at_every_epoch_width() {
        use mdbn_wire::schema::Wire;
        let key = Secret32([9; 32]);
        let global = max_manifest_sealed_bytes(u64::MAX).unwrap();
        // Independent CBOR/Padmé/STREAM accounting: 67,584 padded bytes,
        // two 16-byte tags, and 57 complete-envelope prefix bytes at MAX epoch.
        assert_eq!(global, 67_673);
        for epoch in [
            0,
            23,
            24,
            255,
            256,
            65_535,
            65_536,
            u32::MAX as u64,
            u32::MAX as u64 + 1,
            u64::MAX,
        ] {
            let attachment = AttachmentContextV1 {
                key_epoch: epoch,
                ..context()
            };
            let object = seal_object(
                &key,
                attachment,
                MANIFEST_DOMAIN,
                Cbor::Array(attachment.fields()),
                &vec![0; MANIFEST_BYTES],
                &mut FixedSalt(6),
            )
            .unwrap();
            let bound = max_manifest_sealed_bytes(epoch).unwrap();
            assert_eq!(object.bytes.len(), bound);
            assert!(bound <= global);
            mdbn_wire::envelope::Item::from_bytes(&object.bytes)
                .unwrap()
                .check_shape()
                .unwrap();
        }
        let header = item_header(context().collection, 7, B16([6; 16])).unwrap();
        for plain_bytes in 0..=MANIFEST_BYTES {
            let body_bytes = shape(plain_bytes).unwrap().2;
            let prefix = bounded_item_prefix(&header, body_bytes).unwrap();
            assert!(prefix.len() + body_bytes <= max_manifest_sealed_bytes(7).unwrap());
            assert!(
                prefix.capacity() < MANIFEST_BYTES,
                "bound computation must not reserve a body"
            );
        }
    }

    #[test]
    fn manifest_raw_ceiling_is_checked_before_identity_or_decryption() {
        let key = Secret32([9; 32]);
        for epoch in [0, 24, 256, 65_536, u64::MAX] {
            let attachment = AttachmentContextV1 {
                key_epoch: epoch,
                ..context()
            };
            let bound = max_manifest_sealed_bytes(epoch).unwrap();
            let raw = vec![0; bound + 1];
            let descriptor = AttachmentRefV1 {
                context: attachment,
                manifest_cipher_hash: mdbn_wire::hash::sha256(&raw),
            };
            assert!(matches!(
                open_manifest(
                    &key,
                    &descriptor,
                    file(b""),
                    &raw,
                    AttachmentLimits::default()
                ),
                Err(CryptoError::TooLarge)
            ));
            // The exact ceiling is inclusive; this invalid Item fails opening,
            // not the transport-size guard.
            assert!(matches!(
                open_manifest(
                    &key,
                    &descriptor,
                    file(b""),
                    &raw[..bound],
                    AttachmentLimits::default()
                ),
                Err(CryptoError::Open)
            ));
            // Padmé can give cap+1 plaintext the same complete-object length.
            // The authenticated plaintext cap still independently rejects it.
            let object = seal_object(
                &key,
                attachment,
                MANIFEST_DOMAIN,
                Cbor::Array(attachment.fields()),
                &vec![0; MANIFEST_BYTES + 1],
                &mut FixedSalt(6),
            )
            .unwrap();
            assert!(object.bytes.len() <= bound);
            let descriptor = AttachmentRefV1 {
                context: attachment,
                manifest_cipher_hash: object.cipher_hash,
            };
            assert!(matches!(
                open_manifest(
                    &key,
                    &descriptor,
                    file(b""),
                    &object.bytes,
                    AttachmentLimits::default()
                ),
                Err(CryptoError::Open)
            ));
        }
    }

    #[test]
    fn deterministic_transcript_and_complete_object_goldens() {
        // Independently generated with Python cryptography HKDF/ChaCha20Poly1305
        // and a minimal CBOR encoder, separate from the implementation under test.
        let (key, chunk, m) = small();
        let header = item_header(context().collection, 7, B16([5; 16])).unwrap();
        let c = chunk_context(0, true, 3).cbor();
        let info = cbor::encode(&Cbor::Array(vec![
            Cbor::Text(CHUNK_DOMAIN.into()),
            c.clone(),
        ]))
        .unwrap();
        assert_eq!(
            hex(&info),
            "82781a6d64626173652f76312f6174746163686d656e742d6368756e6b8801500303030303030303030303030303030307582004040404040404040404040404040404040404040404040404040404040404041a0080000000f503"
        );
        let (derived, aad) = context_crypto(&key, B16([5; 16]), CHUNK_DOMAIN, &c, &header).unwrap();
        assert_eq!(
            hex(derived.expose()),
            "6c8281852d762d103eb0faf4074fc44b903187ddbf1fabc6faee3340c842041d"
        );
        assert_eq!(
            hex(&aad),
            "83781a6d64626173652f76312f6174746163686d656e742d6368756e6b8801500303030303030303030303030303030307582004040404040404040404040404040404040404040404040404040404040404041a0080000000f503582ba5000101120250030303030303030303030303030303030507075005050505050505050505050505050505"
        );
        assert_eq!(
            hex(&chunk.bytes),
            "a60001011202500303030303030303030303030303030305070750050505050505050505050505050505050b581c57ca46af11022c5ca0ff1f55a6a0fd7507fd24c7ea44f04d16a4db6a"
        );
        assert_eq!(
            hex(&chunk.cipher_hash.0),
            "0dda281d73f466a4dfa4f83b3900723d02e5122fb110c73e7d281289256bdfa9"
        );
        assert_eq!(
            hex(&encode_manifest(&m, AttachmentLimits::default()).unwrap()),
            "8801500303030303030303030303030303030307582004040404040404040404040404040404040404040404040404040404040404041a00800000035820ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad818458200dda281d73f466a4dfa4f83b3900723d02e5122fb110c73e7d281289256bdfa9184a5820ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad03"
        );
        let sealed =
            seal_manifest(&key, &m, AttachmentLimits::default(), &mut FixedSalt(6)).unwrap();
        assert_eq!(
            hex(&sealed.bytes),
            "a60001011202500303030303030303030303030303030305070750060606060606060606060606060606060b58c07e5d3e5526251e02f61b8726f1329fdc8fe325e07baaae09bd1c9898017794f6b084ac9e25a3b5a80d51ce92e47322fc5136d67dcb38da8a346e3bdbc7432e94b724b496f8119a055fd77e88b8362f2331b6f922d039e94eda42f233f3253fe2a2bc445f00efa127bd32719970b2c167b4667529c11d791ac5830a8867a14a9dafa91d5e030c4c8fabf4644484bdce7aa15f7728a04349fbbd142c10ed81b828f5a29120fd7cee2b558c409ab3bcc405167649052f2d9678fb34645f59f31fe8"
        );
        assert_eq!(
            hex(&sealed.cipher_hash.0),
            "a8416ec086d075cb92a6d747f7bb0223d1f88b6414eb35d521ec419d4f4b183c"
        );
        assert_eq!(
            open_chunk(&key, &verified(&key, &m), 0, &chunk.bytes)
                .unwrap()
                .as_slice(),
            b"abc"
        );
        // New domain/profile objects must not decrypt as legacy bodies.
        assert!(super::super::raw::open_item_bytes(key.expose(), &chunk.bytes).is_err());
        assert!(super::super::raw::open_item_bytes(key.expose(), &sealed.bytes).is_err());
    }

    #[test]
    fn in_place_seal_matches_owned_bytes_and_authenticated_roundtrip() {
        let key = Secret32([9; 32]);
        for size in [0, 1, SEGMENT - FRAME_HEADER, SEGMENT + 1, MAX_CHUNK_PLAIN] {
            let plain: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
            let c = chunk_context(0, true, size as u64);
            let (owned, reference) = seal_chunk(&key, &c, &plain, &mut FixedSalt(5)).unwrap();
            let mut region = vec![0xad; MAX_SEALED];
            region[..size].copy_from_slice(&plain);
            let pointer = region.as_ptr();
            let capacity = region.capacity();
            let span = seal_chunk_in_place(&key, &c, &mut region, size, &mut FixedSalt(5)).unwrap();
            assert_eq!(span.reference(), reference);
            assert_eq!(span.cipher_hash(), owned.cipher_hash);
            assert_eq!(&region[span.range()], &owned.bytes);
            assert!(region[span.range().end..].iter().all(|b| *b == 0));
            assert_eq!(region.as_ptr(), pointer);
            assert_eq!(region.capacity(), capacity);
            let m = ManifestV1 {
                context: context(),
                file: file(&plain),
                chunks: vec![reference],
            };
            let verified = verified(&key, &m);
            let range = open_chunk_in_place(&key, &verified, 0, &mut region[span.range()]).unwrap();
            assert_eq!(&region[range], &plain);
        }
    }

    #[test]
    fn in_place_seal_rejects_caps_context_and_short_region_before_entropy_and_wipes() {
        struct NoEntropy;
        impl super::super::Entropy for NoEntropy {
            fn fill(&mut self, _: &mut [u8]) {
                panic!("refusal must precede entropy");
            }
        }
        impl CsprngEntropy for NoEntropy {}
        let key = Secret32([9; 32]);
        for case in 0..7 {
            let mut c = chunk_context(0, true, 3);
            let mut size = MAX_SEALED;
            let mut plain_bytes = 3;
            match case {
                0 => size = 3,
                1 => size = MAX_SEALED + 1,
                2 => plain_bytes = 4,
                3 => c.attachment.chunk_bytes = 1,
                4 => c.index = MAX_CHUNKS,
                5 => c.final_chunk = false,
                _ => {
                    c.plain_bytes = (MAX_CHUNK_PLAIN + 1) as u64;
                    plain_bytes = MAX_CHUNK_PLAIN + 1;
                }
            }
            let mut region = vec![0xab; size];
            assert!(
                seal_chunk_in_place(&key, &c, &mut region, plain_bytes, &mut NoEntropy).is_err()
            );
            assert!(region.iter().all(|b| *b == 0), "case {case}: FULL wipe");
        }
    }

    #[test]
    fn in_place_chunk_keeps_region_and_authenticates_every_segment() {
        let key = Secret32([9; 32]);
        for size in [
            0,
            3,
            SEGMENT - FRAME_HEADER,
            SEGMENT + 1,
            CHUNK_BYTES as usize,
        ] {
            let plain = vec![7; size];
            let (object, reference) = seal_chunk(
                &key,
                &chunk_context(0, true, size as u64),
                &plain,
                &mut FixedSalt(5),
            )
            .unwrap();
            let m = ManifestV1 {
                context: context(),
                file: file(&plain),
                chunks: vec![reference],
            };
            let mut raw = object.bytes;
            let pointer = raw.as_ptr();
            let capacity = raw.capacity();
            let range = open_chunk_in_place(&key, &verified(&key, &m), 0, &mut raw).unwrap();
            assert_eq!(&raw[range.clone()], plain.as_slice());
            assert!(raw[range.end..].iter().all(|b| *b == 0));
            assert_eq!(raw.as_ptr(), pointer);
            assert_eq!(raw.capacity(), capacity);
        }
    }

    #[test]
    fn in_place_failure_wipes_even_authenticated_prefix() {
        let key = Secret32([9; 32]);
        let plain = vec![7; SEGMENT + 1];
        let (object, reference) = seal_chunk(
            &key,
            &chunk_context(0, true, plain.len() as u64),
            &plain,
            &mut FixedSalt(5),
        )
        .unwrap();
        let m = ManifestV1 {
            context: context(),
            file: file(&plain),
            chunks: vec![reference],
        };
        for failure in 0..4 {
            let mut bad = m.clone();
            let mut raw = object.bytes.clone();
            let wrong = Secret32([0; 32]);
            let mut chosen_key = &key;
            match failure {
                0 => {
                    raw.pop();
                }
                1 => {
                    *raw.last_mut().unwrap() ^= 1;
                    // Authenticate the altered complete-object checksum, so this
                    // specifically reaches a late AEAD failure after the prefix.
                    bad.chunks[0].cipher_hash = mdbn_wire::hash::sha256(&raw);
                }
                2 => {
                    bad.chunks[0].plain_hash.0[0] ^= 1;
                }
                _ => chosen_key = &wrong,
            }
            assert!(open_chunk_in_place(chosen_key, &verified(&key, &bad), 0, &mut raw).is_err());
            assert!(raw.iter().all(|b| *b == 0));
        }
    }

    #[test]
    fn empty_exact_multiple_and_short_final_are_unambiguous() {
        use sha2::{Digest, Sha256};
        let key = Secret32([9; 32]);
        let (empty, e) =
            seal_chunk(&key, &chunk_context(0, true, 0), &[], &mut FixedSalt(5)).unwrap();
        let m = ManifestV1 {
            context: context(),
            file: file(&[]),
            chunks: vec![e],
        };
        assert!(
            open_chunk(&key, &verified(&key, &m), 0, &empty.bytes)
                .unwrap()
                .is_empty()
        );
        let plain = vec![7; CHUNK_BYTES as usize];
        let (exact, r) = seal_chunk(
            &key,
            &chunk_context(0, true, plain.len() as u64),
            &plain,
            &mut FixedSalt(5),
        )
        .unwrap();
        let exact_m = ManifestV1 {
            context: context(),
            file: file(&plain),
            chunks: vec![r],
        };
        let v = verified(&key, &exact_m);
        assert_eq!(v.manifest().chunks.len(), 1);
        assert_eq!(
            open_chunk(&key, &v, 0, &exact.bytes).unwrap().as_slice(),
            plain
        );
        drop(exact);
        let (first, r1) = seal_chunk(
            &key,
            &chunk_context(0, false, plain.len() as u64),
            &plain,
            &mut FixedSalt(5),
        )
        .unwrap();
        let (last, r2) =
            seal_chunk(&key, &chunk_context(1, true, 3), b"abc", &mut FixedSalt(6)).unwrap();
        let mut hash = Sha256::new();
        hash.update(&plain);
        hash.update(b"abc");
        let m = ManifestV1 {
            context: context(),
            file: ExpectedFileV1 {
                total_plain_bytes: plain.len() as u64 + 3,
                whole_plain_hash: B32(hash.finalize().into()),
            },
            chunks: vec![r1, r2],
        };
        let v = verified(&key, &m);
        assert!(!v.chunk_context(0).unwrap().final_chunk);
        assert!(v.chunk_context(1).unwrap().final_chunk);
        assert_eq!(
            open_chunk(&key, &v, 0, &first.bytes).unwrap().as_slice(),
            plain
        );
        assert_eq!(
            open_chunk(&key, &v, 1, &last.bytes).unwrap().as_slice(),
            b"abc"
        );
        assert!(open_chunk(&key, &v, 2, &last.bytes).is_err());
        assert!(open_chunk(&key, &v, u64::MAX, &last.bytes).is_err());
        assert!(open_chunk(&key, &v, 0, &last.bytes).is_err());
        // Changing mutable whole metadata and the later final chunk permits
        // exact unchanged reuse of the original non-final first object.
        let (new_last, new_r2) =
            seal_chunk(&key, &chunk_context(1, true, 4), b"abcd", &mut FixedSalt(7)).unwrap();
        let mut new_hash = Sha256::new();
        new_hash.update(&plain);
        new_hash.update(b"abcd");
        let edited = ManifestV1 {
            context: context(),
            file: ExpectedFileV1 {
                total_plain_bytes: plain.len() as u64 + 4,
                whole_plain_hash: B32(new_hash.finalize().into()),
            },
            chunks: vec![r1, new_r2],
        };
        let edited_v = verified(&key, &edited);
        assert_eq!(
            open_chunk(&key, &edited_v, 0, &first.bytes)
                .unwrap()
                .as_slice(),
            plain
        );
        assert_eq!(
            open_chunk(&key, &edited_v, 1, &new_last.bytes)
                .unwrap()
                .as_slice(),
            b"abcd"
        );
        assert!(open_chunk(&key, &edited_v, 1, &last.bytes).is_err());
        // Exact old final bytes can't become a non-final chunk, even at index0.
        let mut shifted = m.clone();
        shifted.chunks[0] = r;
        assert!(
            open_chunk(&key, &verified(&key, &shifted), 0, &{
                seal_chunk(
                    &key,
                    &chunk_context(0, true, plain.len() as u64),
                    &plain,
                    &mut FixedSalt(5),
                )
                .unwrap()
                .0
                .bytes
            })
            .is_err()
        );
    }

    #[test]
    fn cipher_plain_hash_size_and_late_tag_fail_without_plaintext() {
        let (key, chunk, m) = small();
        let v = verified(&key, &m);
        for len in 0..chunk.bytes.len() {
            assert!(open_chunk(&key, &v, 0, &chunk.bytes[..len]).is_err());
        }
        let mut bytes = chunk.bytes.clone();
        *bytes.last_mut().unwrap() ^= 1;
        assert!(open_chunk(&key, &v, 0, &bytes).is_err());
        // Recompute the ciphertext identity so rejection must reach AEAD.
        let mut bad = m.clone();
        bad.chunks[0].cipher_hash = mdbn_wire::hash::sha256(&bytes);
        assert!(open_chunk(&key, &verified(&key, &bad), 0, &bytes).is_err());
        let mut bad = m.clone();
        bad.chunks[0].plain_hash.0[0] ^= 1;
        assert!(open_chunk(&key, &verified(&key, &bad), 0, &chunk.bytes).is_err());
        let mut extra = chunk.bytes.clone();
        extra.push(0);
        assert!(open_chunk(&key, &v, 0, &extra).is_err());
        let mut bad = m.clone();
        bad.chunks[0].sealed_bytes += 1;
        assert!(seal_manifest(&key, &bad, AttachmentLimits::default(), &mut FixedSalt(6)).is_err());
        // Even a size that pads to the same ciphertext size is a different
        // authenticated expected length/context, never a truncation permission.
        bad = m.clone();
        bad.file = file(b"ab");
        bad.chunks[0].plain_bytes = 2;
        assert!(open_chunk(&key, &verified(&key, &bad), 0, &chunk.bytes).is_err());
        assert!(open_chunk(&Secret32([0; 32]), &v, 0, &chunk.bytes).is_err());
    }

    #[test]
    fn placement_and_profile_splices_fail() {
        let (key, chunk, m) = small();
        for changed in [
            AttachmentContextV1 {
                collection: B16([8; 16]),
                ..context()
            },
            AttachmentContextV1 {
                key_epoch: 8,
                ..context()
            },
            AttachmentContextV1 {
                attachment_id: B32([8; 32]),
                ..context()
            },
        ] {
            let mut bad = m.clone();
            bad.context = changed;
            assert!(open_chunk(&key, &verified(&key, &bad), 0, &chunk.bytes).is_err());
        }
        let invalid = AttachmentContextV1 {
            chunk_bytes: CHUNK_BYTES / 2,
            ..context()
        };
        let mut bad = m.clone();
        bad.context = invalid;
        assert!(seal_manifest(&key, &bad, AttachmentLimits::default(), &mut FixedSalt(6)).is_err());
        for c in [
            chunk_context(0, false, 3),
            chunk_context(1, true, 0),
            chunk_context(MAX_CHUNKS, true, 3),
            chunk_context(0, true, u64::MAX),
        ] {
            assert!(seal_chunk(&key, &c, b"abc", &mut FixedSalt(5)).is_err());
        }
        assert!(seal_chunk(&key, &chunk_context(0, true, 2), b"abc", &mut FixedSalt(5)).is_err());
        // Same bytes at a different valid index bind a different KDF and AAD.
        let p = vec![1; CHUNK_BYTES as usize];
        let (one, _) = seal_chunk(
            &key,
            &chunk_context(0, false, p.len() as u64),
            &p,
            &mut FixedSalt(5),
        )
        .unwrap();
        let object = read_item(&one.bytes, context().collection, 7).unwrap();
        let (derived, aad) = context_crypto(
            &key,
            object.salt,
            CHUNK_DOMAIN,
            &chunk_context(1, false, p.len() as u64).cbor(),
            &object.header,
        )
        .unwrap();
        assert!(open_stream(&derived, &aad, object.body, p.len()).is_err());
    }

    #[test]
    fn strict_manifest_codec_and_required_signed_metadata() {
        let (key, _, m) = small();
        let sealed =
            seal_manifest(&key, &m, AttachmentLimits::default(), &mut FixedSalt(6)).unwrap();
        let d = AttachmentRefV1 {
            context: context(),
            manifest_cipher_hash: sealed.cipher_hash,
        };
        let plain = encode_manifest(&m, AttachmentLimits::default()).unwrap();
        assert_eq!(
            decode_manifest(&plain, &d, m.file, AttachmentLimits::default()).unwrap(),
            m
        );
        for len in 0..plain.len() {
            assert!(
                decode_manifest(&plain[..len], &d, m.file, AttachmentLimits::default()).is_err()
            );
        }
        let mut changed = plain.to_vec();
        changed.push(0);
        assert!(decode_manifest(&changed, &d, m.file, AttachmentLimits::default()).is_err());
        for first in [0x87, 0x89, 0x9f, 0xa8] {
            let mut changed = plain.to_vec();
            changed[0] = first;
            assert!(decode_manifest(&changed, &d, m.file, AttachmentLimits::default()).is_err());
        }
        let mut changed = plain.to_vec();
        changed[1] = 2;
        assert!(decode_manifest(&changed, &d, m.file, AttachmentLimits::default()).is_err());
        let mut changed = plain.to_vec();
        changed.splice(1..2, [0x18, 1]);
        assert!(decode_manifest(&changed, &d, m.file, AttachmentLimits::default()).is_err());
        let mut expected = m.file;
        expected.whole_plain_hash.0[0] ^= 1;
        assert!(
            open_manifest(
                &key,
                &d,
                expected,
                &sealed.bytes,
                AttachmentLimits::default()
            )
            .is_err()
        );
        expected = m.file;
        expected.total_plain_bytes += 1;
        assert!(
            open_manifest(
                &key,
                &d,
                expected,
                &sealed.bytes,
                AttachmentLimits::default()
            )
            .is_err()
        );
        let mut bad_d = d;
        bad_d.context.attachment_id.0[0] ^= 1;
        assert!(
            open_manifest(
                &key,
                &bad_d,
                m.file,
                &sealed.bytes,
                AttachmentLimits::default()
            )
            .is_err()
        );
        bad_d = d;
        bad_d.manifest_cipher_hash.0[0] ^= 1;
        assert!(
            open_manifest(
                &key,
                &bad_d,
                m.file,
                &sealed.bytes,
                AttachmentLimits::default()
            )
            .is_err()
        );
        assert!(
            open_manifest(
                &key,
                &d,
                m.file,
                &sealed.bytes,
                AttachmentLimits { max_file_bytes: 2 }
            )
            .is_err()
        );
        // Authenticated malformed plaintext cannot manufacture VerifiedManifest.
        let wrong = seal_object(
            &key,
            context(),
            MANIFEST_DOMAIN,
            Cbor::Array(context().fields()),
            &changed,
            &mut FixedSalt(6),
        )
        .unwrap();
        let wrong_d = AttachmentRefV1 {
            manifest_cipher_hash: wrong.cipher_hash,
            ..d
        };
        assert!(
            open_manifest(
                &key,
                &wrong_d,
                m.file,
                &wrong.bytes,
                AttachmentLimits::default()
            )
            .is_err()
        );
        assert!(
            open_manifest(
                &key,
                &d,
                m.file,
                &sealed.bytes[..sealed.bytes.len() - 1],
                AttachmentLimits::default()
            )
            .is_err()
        );
    }

    #[test]
    fn shape_counts_duplicates_caps_overflow_checked_before_allocation() {
        let (_, _, m) = small();
        assert_eq!(expected_count(0, AttachmentLimits::default()), Ok(1));
        assert_eq!(
            expected_count(u64::from(CHUNK_BYTES), AttachmentLimits::default()),
            Ok(1)
        );
        assert_eq!(
            expected_count(u64::from(CHUNK_BYTES) + 1, AttachmentLimits::default()),
            Ok(2)
        );
        assert_eq!(
            expected_count(1 << 30, AttachmentLimits::default()),
            Ok(128)
        );
        assert!(expected_count((1 << 30) + 1, AttachmentLimits::default()).is_err());
        assert!(
            expected_count(
                u64::MAX,
                AttachmentLimits {
                    max_file_bytes: u64::MAX
                }
            )
            .is_err()
        );
        let mut bad = m.clone();
        bad.chunks.push(bad.chunks[0]);
        assert!(encode_manifest(&bad, AttachmentLimits::default()).is_err());
        bad.file.total_plain_bytes = u64::from(CHUNK_BYTES) + 3;
        bad.chunks[0].plain_bytes = u64::from(CHUNK_BYTES);
        bad.chunks[0].sealed_bytes = object_size(u64::from(CHUNK_BYTES), context()).unwrap();
        // Duplicate complete object hash with otherwise-correct shape.
        assert!(encode_manifest(&bad, AttachmentLimits::default()).is_err());
        bad = m.clone();
        bad.chunks[0].plain_bytes = u64::MAX;
        assert!(encode_manifest(&bad, AttachmentLimits::default()).is_err());
        bad = m.clone();
        bad.file.total_plain_bytes = u64::MAX;
        assert!(
            encode_manifest(
                &bad,
                AttachmentLimits {
                    max_file_bytes: u64::MAX
                }
            )
            .is_err()
        );
        bad = m.clone();
        bad.chunks.clear();
        assert!(encode_manifest(&bad, AttachmentLimits::default()).is_err());
        bad = m.clone();
        bad.file.total_plain_bytes = 0;
        assert!(encode_manifest(&bad, AttachmentLimits::default()).is_err());
        // The declared array count is rejected before Vec allocation.
        let p = encode_manifest(&m, AttachmentLimits::default()).unwrap();
        let mut r = Reader { bytes: &p, pos: 0 };
        r.head(4).unwrap();
        r.uint().unwrap();
        r.bytes().unwrap();
        r.uint().unwrap();
        r.bytes().unwrap();
        r.uint().unwrap();
        r.uint().unwrap();
        r.bytes().unwrap();
        let mut malicious = p[..r.pos].to_vec();
        put_head(&mut malicious, 4, u64::MAX);
        let d = AttachmentRefV1 {
            context: context(),
            manifest_cipher_hash: B32([0; 32]),
        };
        assert!(decode_manifest(&malicious, &d, m.file, AttachmentLimits::default()).is_err());
        // Manifest cap can be tighter than the attachment's 1023-chunk cap.
        let n = MAX_CHUNKS;
        let mut many = ManifestV1 {
            context: context(),
            file: ExpectedFileV1 {
                total_plain_bytes: n * u64::from(CHUNK_BYTES),
                whole_plain_hash: B32([0; 32]),
            },
            chunks: Vec::new(),
        };
        for i in 0..n {
            let mut h = [0; 32];
            h[..8].copy_from_slice(&i.to_be_bytes());
            many.chunks.push(ChunkRefV1 {
                cipher_hash: B32(h),
                sealed_bytes: object_size(u64::from(CHUNK_BYTES), context()).unwrap(),
                plain_hash: B32([0; 32]),
                plain_bytes: u64::from(CHUNK_BYTES),
            });
        }
        assert!(
            encode_manifest(
                &many,
                AttachmentLimits {
                    max_file_bytes: u64::MAX
                }
            )
            .is_err()
        );
    }

    #[test]
    fn bounded_authenticated_frame_rejects_alg_lengths_and_padding() {
        let key = Secret32([9; 32]);
        let plain = vec![8; 64];
        let (padded, _, _) = shape(plain.len()).unwrap();
        let mut frame = frame_header(plain.len()).unwrap().to_vec();
        frame.extend_from_slice(&plain);
        frame.resize(padded, 0);
        for field in [0, 1, 5, padded - 1] {
            let mut f = frame.clone();
            f[field] ^= 1;
            let cipher = ChaCha20Poly1305::new(Key::from_slice(key.expose()));
            let tag = cipher
                .encrypt_in_place_detached(Nonce::from_slice(&nonce(0, true)), b"aad", &mut f)
                .unwrap();
            f.extend_from_slice(&tag);
            assert!(open_stream_bounded(&key, b"aad", &f, None, MANIFEST_BYTES).is_err());
        }
        let mut oversized = frame.clone();
        oversized[1..5].copy_from_slice(&u32::MAX.to_be_bytes());
        oversized[5..9].copy_from_slice(&u32::MAX.to_be_bytes());
        let tag = ChaCha20Poly1305::new(Key::from_slice(key.expose()))
            .encrypt_in_place_detached(Nonce::from_slice(&nonce(0, true)), b"aad", &mut oversized)
            .unwrap();
        oversized.extend_from_slice(&tag);
        assert!(open_stream_bounded(&key, b"aad", &oversized, None, MANIFEST_BYTES).is_err());
    }

    #[test]
    fn unchanged_reuse_is_exact_and_fresh_sealing_changes_identity() {
        let (key, chunk, m) = small();
        let mut entropy = super::super::TestEntropy::new(5);
        let (a, _) = seal_chunk(&key, &chunk_context(0, true, 3), b"abc", &mut entropy).unwrap();
        let (b, _) = seal_chunk(&key, &chunk_context(0, true, 3), b"abc", &mut entropy).unwrap();
        assert_ne!(a.cipher_hash, b.cipher_hash);
        assert_eq!(
            open_chunk(&key, &verified(&key, &m), 0, &chunk.bytes)
                .unwrap()
                .as_slice(),
            b"abc"
        );
        let mut bad = m.clone();
        bad.context.attachment_id.0[0] ^= 1;
        assert!(open_chunk(&key, &verified(&key, &bad), 0, &chunk.bytes).is_err());
    }

    #[test]
    fn held_key_adapters_require_current_writes_and_bound_historical_reads() {
        use crate::seal::{KeyringSealer, OpenError, PlainSealer, Sealer};
        fn sealer(include_old: bool) -> KeyringSealer {
            let mut keys = super::super::keys::Keyring::new();
            if include_old {
                keys.insert(7, Secret32([9; 32]));
            }
            keys.insert(8, Secret32([10; 32]));
            let bytes = keys.to_bytes();
            let mut stored = Zeroizing::new((bytes.len() as u64).to_be_bytes().to_vec());
            stored.extend_from_slice(&bytes);
            let mut s = KeyringSealer::new(context().collection, B16([2; 16]), &[6; 32], &[7; 32]);
            s.import(&stored).unwrap();
            s.set_epoch(7);
            s
        }
        let mut s = sealer(true);
        let (chunk, r) = s
            .seal_attachment_chunk(&chunk_context(0, true, 3), b"abc", &mut FixedSalt(5))
            .unwrap();
        let m = ManifestV1 {
            context: context(),
            file: file(b"abc"),
            chunks: vec![r],
        };
        let sealed = s
            .seal_attachment_manifest(&m, AttachmentLimits::default(), &mut FixedSalt(6))
            .unwrap();
        let d = AttachmentRefV1 {
            context: context(),
            manifest_cipher_hash: sealed.cipher_hash,
        };
        s.set_epoch(8);
        assert!(
            s.seal_attachment_chunk(&chunk_context(0, true, 3), b"abc", &mut FixedSalt(5))
                .is_err()
        );
        assert!(
            s.seal_attachment_manifest(&m, AttachmentLimits::default(), &mut FixedSalt(6))
                .is_err()
        );
        let v = s
            .open_attachment_manifest(&d, m.file, &sealed.bytes, AttachmentLimits::default())
            .unwrap();
        assert_eq!(
            s.open_attachment_chunk(&v, 0, &chunk.bytes)
                .unwrap()
                .as_slice(),
            b"abc"
        );
        let mut no_old = sealer(false);
        no_old.set_epoch(8);
        assert!(matches!(
            no_old.open_attachment_manifest(&d, m.file, &sealed.bytes, AttachmentLimits::default()),
            Err(OpenError::NoKey)
        ));
        assert_eq!(
            no_old.open_attachment_chunk(&v, 0, &chunk.bytes),
            Err(OpenError::NoKey)
        );
        let mut bad_d = d;
        bad_d.context.collection = B16([8; 16]);
        assert!(matches!(
            s.open_attachment_manifest(&bad_d, m.file, &sealed.bytes, AttachmentLimits::default()),
            Err(OpenError::Aead)
        ));
        let mut current = chunk_context(0, true, 3);
        current.attachment.key_epoch = 8;
        current.attachment.collection = B16([8; 16]);
        assert!(
            s.seal_attachment_chunk(&current, b"abc", &mut FixedSalt(5))
                .is_err()
        );
        current.attachment.collection = context().collection;
        assert!(
            s.seal_attachment_chunk(&current, b"abc", &mut FixedSalt(5))
                .is_ok()
        );
        let plain = PlainSealer::for_device(B16([2; 16]));
        assert!(
            plain
                .seal_attachment_chunk(&chunk_context(0, true, 3), b"abc", &mut FixedSalt(5))
                .is_err()
        );
        assert!(
            plain
                .open_attachment_manifest(&d, m.file, &sealed.bytes, AttachmentLimits::default())
                .is_err()
        );
    }

    #[test]
    fn bounded_substrate_matches_existing_stream_layout_without_second_kdf() {
        let epoch = Secret32([1; 32]);
        let salt = [2; 16];
        // Reference ONLY: legacy seal derives this payload key. New attachment
        // production uses its own single purpose/context-bound HKDF instead.
        let derived = super::super::hkdf32(epoch.expose(), &salt, b"mdbase/v1/payload");
        for len in [0, 1, SEGMENT - FRAME_HEADER, SEGMENT, SEGMENT + 1] {
            let plain = vec![7; len];
            let actual = seal_stream(&derived, b"layout", &plain).unwrap();
            let old =
                super::super::seal::seal_with_salt(epoch.expose(), &salt, b"layout", &plain, false)
                    .unwrap();
            assert_eq!(actual, old);
            assert_eq!(
                open_stream(&derived, b"layout", &actual, len)
                    .unwrap()
                    .as_slice(),
                plain
            );
        }
    }

    #[test]
    fn strict_item_codec_borrows_body_and_matches_existing_shape() {
        use mdbn_wire::envelope::Item;
        use mdbn_wire::schema::Wire;
        let col = B16([1; 16]);
        let salt = B16([2; 16]);
        let key = Secret32([3; 32]);
        let plain = vec![4; SEGMENT + 1];
        let header = item_header(col, u64::MAX, salt).unwrap();
        let mut encoded = item_prefix(&header, shape(plain.len()).unwrap().2).unwrap();
        let offset = encoded.len();
        seal_stream_into(&key, &header, &plain, &mut encoded).unwrap();
        let borrowed = read_item(&encoded, col, u64::MAX).unwrap();
        assert_eq!(borrowed.salt, salt);
        assert_eq!(borrowed.header, header);
        assert_eq!(borrowed.body.as_ptr(), encoded[offset..].as_ptr());
        assert_eq!(
            open_stream(&key, &header, borrowed.body, plain.len())
                .unwrap()
                .as_slice(),
            plain
        );
        let item = Item::from_bytes(&encoded).unwrap();
        item.check_shape().unwrap();
        assert_eq!(item.to_bytes().unwrap(), encoded);
        assert!(read_item(&encoded, B16([9; 16]), u64::MAX).is_err());
        assert!(read_item(&encoded, col, 7).is_err());
        encoded.push(0);
        assert!(read_item(&encoded, col, u64::MAX).is_err());
        // Reject non-shortest integer encoding, indefinite form, wrong major.
        for raw in [&[0x18, 1][..], &[0x1f][..], &[0x20][..]] {
            assert!(Reader { bytes: raw, pos: 0 }.uint().is_err());
        }
        assert!(item_prefix(&header, MAX_SEALED).is_err());
    }

    #[test]
    fn maximum_chunk_is_bounded_and_round_trips() {
        let key = Secret32([3; 32]);
        let plain = vec![4; MAX_CHUNK_PLAIN];
        let sealed = seal_stream(&key, b"max", &plain).unwrap();
        assert!(sealed.len() < MAX_SEALED);
        assert_eq!(
            open_stream(&key, b"max", &sealed, plain.len())
                .unwrap()
                .as_slice(),
            plain
        );
        assert_eq!(shape(MAX_CHUNK_PLAIN + 1), Err(CryptoError::TooLarge));
        assert_eq!(
            open_stream(&key, b"max", &sealed, MAX_CHUNK_PLAIN + 1),
            Err(CryptoError::TooLarge)
        );
    }

    #[test]
    fn later_tag_truncation_and_context_fail_without_returning_prefix() {
        let key = Secret32([5; 32]);
        let plain = vec![6; SEGMENT * 2];
        let sealed = seal_stream(&key, b"context", &plain).unwrap();
        assert_eq!(
            open_stream(&key, b"other", &sealed, plain.len()),
            Err(CryptoError::Open)
        );
        assert_eq!(
            open_stream(&key, b"context", &sealed[..sealed.len() - 1], plain.len()),
            Err(CryptoError::Open)
        );
        let mut changed = sealed.clone();
        *changed.last_mut().unwrap() ^= 1;
        assert_eq!(
            open_stream(&key, b"context", &changed, plain.len()),
            Err(CryptoError::Open)
        );
        assert_eq!(
            open_stream(&key, b"context", &sealed, plain.len() - 1),
            Err(CryptoError::Open)
        );
    }
}
