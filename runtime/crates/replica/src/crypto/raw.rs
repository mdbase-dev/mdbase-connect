//! AAD and signature inputs over the **received bytes** of an item.
//!
//! A newer writer may add item fields an older replica doesn't know. Decoding drops
//! them, so recomputing the AAD or signed digest from a decoded struct would differ
//! from what the writer covered, and the older replica would void a valid item.
//! These functions work on the bytes as received: they keep every map entry's
//! bytes exactly and only drop keys 11/12, rewriting the map header's count.
//!
//! Use the `*_bytes` functions for every item received from the log or the object
//! store. The struct-based `Item::aad`/`Item::signed_digest` are for items this
//! replica builds itself, where both agree.

use mdbn_wire::envelope::Item;
use mdbn_wire::schema::Wire;
use sha2::{Digest, Sha256};
use zeroize::Zeroize;

/// Preallocation data only, not permission to allocate or native authority.
/// Reserve the entire peak in the caller's shared account before allocating the
/// workspace or decoding. Retain that reservation while the receipt lives (a
/// conservative overcharge); never reset it independently per object.
#[derive(Debug, Clone, Copy)]
pub struct EnvelopeWorkspacePlan {
    metadata_bytes: usize,
    decoder_peak_bytes: usize,
    body_value_start: usize,
    body_value_end: usize,
    body_start: usize,
}
impl EnvelopeWorkspacePlan {
    /// Exact caller workspace length.
    pub fn metadata_bytes(&self) -> usize {
        self.metadata_bytes
    }
    /// Conservative logical workspace/decoder/retained-header peak. This is not
    /// an allocator/process/SQLite physical memory certificate.
    pub fn decoder_peak_bytes(&self) -> usize {
        self.decoder_peak_bytes
    }
}

// Count encoded metadata nodes without creating a CBOR tree. Strict canonical
// profile/schema validation is delegated to the existing decoder AFTER admission.
fn metadata_nodes(raw: &[u8], p: usize, depth: usize) -> Result<(usize, usize), CryptoError> {
    if depth > mdbn_wire::cbor::MAX_DEPTH {
        return Err(CryptoError::Open);
    }
    let (major, count, size) = head(raw, p)?;
    let mut end = p.checked_add(size).ok_or(CryptoError::Open)?;
    let mut nodes = 1usize;
    match major {
        0 | 1 | 7 => {}
        2 | 3 => {
            end = end
                .checked_add(usize::try_from(count).map_err(|_| CryptoError::Open)?)
                .ok_or(CryptoError::Open)?;
        }
        4 | 5 => {
            let children = if major == 5 {
                count.checked_mul(2).ok_or(CryptoError::Open)?
            } else {
                count
            };
            for _ in 0..children {
                let (next, n) = metadata_nodes(raw, end, depth + 1)?;
                end = next;
                nodes = nodes.checked_add(n).ok_or(CryptoError::Open)?;
            }
        }
        _ => return Err(CryptoError::Open),
    }
    if end > raw.len() {
        return Err(CryptoError::Open);
    }
    Ok((end, nodes))
}
fn shortest_head_size(value: u64) -> usize {
    match value {
        0..=23 => 1,
        24..=0xff => 2,
        0x100..=0xffff => 3,
        0x1_0000..=0xffff_ffff => 5,
        _ => 9,
    }
}
/// Locate the one byte-string body and compute metadata admission without copying
/// it. Error mapping equals the old crypto raw opener's Wire-decode mapping, not
/// the detailed ordinary log decoder's schema/stall classification. This plan is
/// NOT canonical admission: decode_envelope_borrowed must still succeed.
pub fn envelope_workspace_plan(raw: &[u8]) -> Result<EnvelopeWorkspacePlan, CryptoError> {
    let (major, count, mut p) = head(raw, 0)?;
    if major != 5 {
        return Err(CryptoError::Open);
    }
    let mut body = None;
    let mut nodes = 1usize;
    for _ in 0..count {
        let (major, key, _) = head(raw, p)?;
        if major != 0 {
            return Err(CryptoError::Open);
        }
        p = skip(raw, p, 1)?;
        nodes = nodes.checked_add(1).ok_or(CryptoError::Open)?;
        if key == 11 {
            if body.is_some() {
                return Err(CryptoError::Open);
            }
            let value_start = p;
            let (major, bytes, size) = head(raw, p)?;
            if major != 2 || size != shortest_head_size(bytes) {
                return Err(CryptoError::Open);
            }
            let body_start = p.checked_add(size).ok_or(CryptoError::Open)?;
            p = skip(raw, p, 1)?;
            body = Some((value_start, p, body_start));
            nodes = nodes.checked_add(1).ok_or(CryptoError::Open)?;
        } else {
            let (end, n) = metadata_nodes(raw, p, 1)?;
            p = end;
            nodes = nodes.checked_add(n).ok_or(CryptoError::Open)?;
        }
    }
    if p != raw.len() {
        return Err(CryptoError::Open);
    }
    let (body_value_start, body_value_end, body_start) = body.ok_or(CryptoError::Open)?;
    let metadata_bytes = raw
        .len()
        .checked_sub(body_value_end - body_value_start)
        .and_then(|n| n.checked_add(1))
        .ok_or(CryptoError::Open)?;
    // Input workspace + up to two copies of metadata byte/text material; ample
    // fixed logical node charge for tree/Vec capacity, map key tracking and typed
    // refs. No ciphertext body contributes to this decoder allocation charge.
    let decoder_peak_bytes = metadata_bytes
        .checked_mul(3)
        .and_then(|n| nodes.checked_mul(384).and_then(|m| n.checked_add(m)))
        .ok_or(CryptoError::Open)?;
    Ok(EnvelopeWorkspacePlan {
        metadata_bytes,
        decoder_peak_bytes,
        body_value_start,
        body_value_end,
        body_start,
    })
}
/// Parsed DATA only. Body and exact received bytes stay borrowed from immutable
/// caller storage; no signature, policy, key or native authority is conferred.
/// The owned internal Item has an EMPTY body and must never be passed to an old
/// body-dependent policy/signature API. No public Item projection is provided.
pub struct BorrowedEnvelope<'a> {
    metadata: Item,
    raw: &'a [u8],
    body: &'a [u8],
}
impl std::fmt::Debug for BorrowedEnvelope<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BorrowedEnvelope")
            .field("received_bytes", &self.raw.len())
            .field("body_bytes", &self.body.len())
            .finish_non_exhaustive()
    }
}
impl<'a> BorrowedEnvelope<'a> {
    /// Exact received source, including unknown fields.
    pub fn received(&self) -> &'a [u8] {
        self.raw
    }
    /// Ciphertext (or clear opaque payload), never decrypted by this receipt.
    pub fn body(&self) -> &'a [u8] {
        self.body
    }
    /// Wire field data, not continuing native key authority.
    pub fn epoch(&self) -> Option<u64> {
        self.metadata.epoch
    }
    /// Parsed kind data, not an authorization verdict.
    pub fn kind(&self) -> mdbn_wire::envelope::ItemKind {
        self.metadata.kind
    }
    /// Parsed device/key identifier, not evidence of an active signer.
    pub fn signer(&self) -> Option<mdbn_wire::common::B16> {
        self.metadata.signer
    }
    /// Received signature bytes, not a verified signature.
    pub fn signature(&self) -> Option<mdbn_wire::common::B64> {
        self.metadata.sig
    }
    /// Received salt; opening continues to use the existing crypto construction.
    pub fn salt(&self) -> Option<mdbn_wire::common::B16> {
        self.metadata.salt
    }
    /// Borrowed parsed refs, not authenticated reference closure.
    pub fn refs(&self) -> Option<&[mdbn_wire::common::B32]> {
        self.metadata.refs.as_deref()
    }
    /// Equivalent to the OLD typed Item::signed_digest, NOT the received-byte
    /// digest: unknown fields are dropped exactly as in typed re-encoding. This
    /// preserves old policy semantics; never substitute it for received checks.
    /// Precharge two metadata traversals plus hashing before this call.
    pub fn typed_signed_digest(&self) -> Result<[u8; 32], CryptoError> {
        let (count, _) = self.visit_known(|_| {})?;
        // Twelve possible known fields (0..11), so a one-byte map header.
        let mut hash = Sha256::new();
        const DOMAIN: &[u8] = b"mdbase/v1/item-sig";
        hash.update([DOMAIN.len() as u8]);
        hash.update(DOMAIN);
        hash.update([0xa0 | count]);
        self.visit_known(|span| hash.update(span))?;
        Ok(hash.finalize().into())
    }
    fn visit_known(&self, mut consume: impl FnMut(&[u8])) -> Result<(u8, usize), CryptoError> {
        let (_, count, mut p) = head(self.raw, 0)?;
        let mut kept = 0u8;
        for _ in 0..count {
            let start = p;
            let (_, key, _) = head(self.raw, p)?;
            p = skip(self.raw, p, 1)?;
            p = skip(self.raw, p, 1)?;
            if key <= 11 {
                consume(self.raw.get(start..p).ok_or(CryptoError::Open)?);
                kept = kept.checked_add(1).ok_or(CryptoError::Open)?;
            }
        }
        if p != self.raw.len() || kept > 12 {
            return Err(CryptoError::Open);
        }
        Ok((kept, p))
    }
    /// Structural presence rules remain the existing Item implementation.
    pub fn check_shape(&self) -> Result<(), mdbn_wire::schema::SchemaError> {
        self.metadata.check_shape()
    }
}
/// Decode under caller-reserved peak using exactly sized metadata workspace.
/// Caller must precharge worst repeated-pass work from the bounded input BEFORE
/// planning/execution: two metadata planning passes plus strict decode. The
/// numeric admitted_peak_bytes is data, not evidence of a real shared reservation.
/// Reservation refusal is TooLarge before mutation/allocation. Strict Wire
/// errors map to Open exactly as the old crypto raw decode stage. Workspace is
/// wiped on decode failure; immutable source is never modified. No ordinary
/// log/policy decoding or its detailed format-error classification is replaced.
///
/// ```compile_fail,E0597
/// use mdbn_replica::crypto::raw::decode_envelope_borrowed;
/// let mut workspace = vec![0; 128];
/// let receipt = {
///     let source = vec![0xa0];
///     decode_envelope_borrowed(&source, &mut workspace, usize::MAX).unwrap()
/// };
/// let _ = receipt.received(); // cannot outlive immutable source storage
/// ```
pub fn decode_envelope_borrowed<'a>(
    raw: &'a [u8],
    workspace: &mut [u8],
    admitted_peak_bytes: usize,
) -> Result<BorrowedEnvelope<'a>, CryptoError> {
    let plan = envelope_workspace_plan(raw)?;
    if plan.decoder_peak_bytes > admitted_peak_bytes {
        return Err(CryptoError::TooLarge);
    }
    if workspace.len() != plan.metadata_bytes {
        return Err(CryptoError::Open);
    }
    workspace[..plan.body_value_start].copy_from_slice(&raw[..plan.body_value_start]);
    workspace[plan.body_value_start] = 0x40;
    workspace[plan.body_value_start + 1..].copy_from_slice(&raw[plan.body_value_end..]);
    let metadata = match Item::from_bytes(workspace) {
        Ok(item) => item,
        Err(_) => {
            workspace.zeroize();
            return Err(CryptoError::Open);
        }
    };
    Ok(BorrowedEnvelope {
        metadata,
        raw,
        body: &raw[plan.body_start..plan.body_value_end],
    })
}

use super::CryptoError;
use super::seal::open_with_salt;
use super::sign::verify_digest;

const MAX_DEPTH: u32 = 128;

/// Read a head: `(major, argument, head length)`.
fn head(b: &[u8], pos: usize) -> Result<(u8, u64, usize), CryptoError> {
    let first = *b.get(pos).ok_or(CryptoError::Open)?;
    let major = first >> 5;
    let info = first & 31;
    let (arg, len) = match info {
        0..=23 => (u64::from(info), 1),
        24..=27 => {
            let n = 1usize << (info - 24);
            let bytes = b.get(pos + 1..pos + 1 + n).ok_or(CryptoError::Open)?;
            let mut v = 0u64;
            for x in bytes {
                v = (v << 8) | u64::from(*x);
            }
            (v, 1 + n)
        }
        _ => return Err(CryptoError::Open),
    };
    Ok((major, arg, len))
}

/// Position just after the data item starting at `pos`.
fn skip(b: &[u8], pos: usize, depth: u32) -> Result<usize, CryptoError> {
    if depth > MAX_DEPTH {
        return Err(CryptoError::Open);
    }
    let (major, arg, hl) = head(b, pos)?;
    let mut p = pos.checked_add(hl).ok_or(CryptoError::Open)?;
    match major {
        0 | 1 | 7 => {}
        2 | 3 => {
            let n = usize::try_from(arg).map_err(|_| CryptoError::Open)?;
            p = p.checked_add(n).ok_or(CryptoError::Open)?;
            if p > b.len() {
                return Err(CryptoError::Open);
            }
        }
        4 | 5 => {
            let items = if major == 5 {
                arg.checked_mul(2).ok_or(CryptoError::Open)?
            } else {
                arg
            };
            // Every item takes at least one byte: bound before looping.
            if items > (b.len() - p.min(b.len())) as u64 {
                return Err(CryptoError::Open);
            }
            for _ in 0..items {
                p = skip(b, p, depth + 1)?;
            }
        }
        _ => return Err(CryptoError::Open),
    }
    Ok(p)
}

fn map_header(count: u64) -> Vec<u8> {
    let m = 5u8 << 5;
    match count {
        0..=23 => vec![m | count as u8],
        24..=0xff => vec![m | 24, count as u8],
        0x100..=0xffff => {
            let mut v = vec![m | 25];
            v.extend_from_slice(&(count as u16).to_be_bytes());
            v
        }
        0x1_0000..=0xffff_ffff => {
            let mut v = vec![m | 26];
            v.extend_from_slice(&(count as u32).to_be_bytes());
            v
        }
        _ => {
            let mut v = vec![m | 27];
            v.extend_from_slice(&count.to_be_bytes());
            v
        }
    }
}

/// The received item with the struct keys in `drop` removed, every other entry's
/// bytes copied exactly.
pub fn item_without(raw: &[u8], drop: &[u64]) -> Result<Vec<u8>, CryptoError> {
    let (major, count, hl) = head(raw, 0)?;
    if major != 5 {
        return Err(CryptoError::Open);
    }
    let mut p = hl;
    let mut kept = Vec::with_capacity(raw.len());
    let mut n = 0u64;
    for _ in 0..count {
        let start = p;
        let (km, key, _) = head(raw, p)?;
        if km != 0 {
            return Err(CryptoError::Open);
        }
        p = skip(raw, p, 1)?;
        p = skip(raw, p, 1)?;
        if !drop.contains(&key) {
            kept.extend_from_slice(&raw[start..p]);
            n += 1;
        }
    }
    if p != raw.len() {
        return Err(CryptoError::Open);
    }
    let mut out = map_header(n);
    out.extend_from_slice(&kept);
    Ok(out)
}

/// The AEAD associated data of a received item (without keys 11 and 12).
pub fn aad_from_bytes(raw: &[u8]) -> Result<Vec<u8>, CryptoError> {
    item_without(raw, &[11, 12])
}

/// The signed digest of a received item: `H("mdbase/v1/item-sig", item without key 12)`.
pub fn signed_digest_from_bytes(raw: &[u8]) -> Result<[u8; 32], CryptoError> {
    Ok(mdbn_wire::hash::h("mdbase/v1/item-sig", &item_without(raw, &[12])?).0)
}

// Walk the same received spans as item_without without allocating/copying them.
// These transcript helpers deliberately preserve its validation/error behavior;
// they do not replace the upstream canonical Wire/shape/size admission.
fn visit_kept(
    raw: &[u8],
    drop: &[u64],
    mut consume: impl FnMut(&[u8]) -> Result<(), CryptoError>,
) -> Result<u64, CryptoError> {
    let (major, count, mut p) = head(raw, 0)?;
    if major != 5 {
        return Err(CryptoError::Open);
    }
    let mut n = 0u64;
    for _ in 0..count {
        let start = p;
        let (major, key, _) = head(raw, p)?;
        if major != 0 {
            return Err(CryptoError::Open);
        }
        p = skip(raw, p, 1)?;
        p = skip(raw, p, 1)?;
        if !drop.contains(&key) {
            consume(raw.get(start..p).ok_or(CryptoError::Open)?)?;
            n += 1;
        }
    }
    if p != raw.len() {
        return Err(CryptoError::Open);
    }
    Ok(n)
}
fn map_header_stack(count: u64, out: &mut [u8; 9]) -> usize {
    match count {
        0..=23 => {
            out[0] = 0xa0 | count as u8;
            1
        }
        24..=0xff => {
            out[0] = 0xb8;
            out[1] = count as u8;
            2
        }
        0x100..=0xffff => {
            out[0] = 0xb9;
            out[1..3].copy_from_slice(&(count as u16).to_be_bytes());
            3
        }
        0x1_0000..=0xffff_ffff => {
            out[0] = 0xba;
            out[1..5].copy_from_slice(&(count as u32).to_be_bytes());
            5
        }
        _ => {
            out[0] = 0xbb;
            out[1..9].copy_from_slice(&count.to_be_bytes());
            9
        }
    }
}
/// Allocation-free received-byte digest variant. The borrowed input must already
/// be admitted by its transport/codec/working account. No second raw body or
/// serialized transcript is made. Signing domain and original helper semantics
/// are identical; this is not an envelope, signature or policy verdict.
pub fn signed_digest_from_bytes_borrowed(raw: &[u8]) -> Result<[u8; 32], CryptoError> {
    let count = visit_kept(raw, &[12], |_| Ok(()))?;
    let mut header = [0; 9];
    let size = map_header_stack(count, &mut header);
    const DOMAIN: &[u8] = b"mdbase/v1/item-sig";
    let mut hash = Sha256::new();
    hash.update([DOMAIN.len() as u8]);
    hash.update(DOMAIN);
    hash.update(&header[..size]);
    visit_kept(raw, &[12], |span| {
        hash.update(span);
        Ok(())
    })?;
    Ok(hash.finalize().into())
}
/// Exact received AAD workspace length, computed without allocating. A caller
/// must charge/admit this length BEFORE allocating its destination. The count is
/// data, never authority or permission to allocate an unbounded transport body.
pub fn aad_workspace_len(raw: &[u8]) -> Result<usize, CryptoError> {
    let mut bytes = 0usize;
    let count = visit_kept(raw, &[11, 12], |span| {
        bytes = bytes.checked_add(span.len()).ok_or(CryptoError::Open)?;
        Ok(())
    })?;
    let mut header = [0; 9];
    bytes
        .checked_add(map_header_stack(count, &mut header))
        .ok_or(CryptoError::Open)
}
/// Fill an exactly sized, caller-admitted AAD workspace with the same bytes as
/// aad_from_bytes, without an intermediate Vec or ciphertext copy. Invalid raw
/// input or wrong destination size refuses BEFORE mutating the destination.
/// The immutable received input and mutable output cannot alias in safe Rust.
pub fn aad_from_bytes_into(raw: &[u8], out: &mut [u8]) -> Result<(), CryptoError> {
    if aad_workspace_len(raw)? != out.len() {
        return Err(CryptoError::Open);
    }
    let count = visit_kept(raw, &[11, 12], |_| Ok(()))?;
    let mut header = [0; 9];
    let mut at = map_header_stack(count, &mut header);
    out[..at].copy_from_slice(&header[..at]);
    visit_kept(raw, &[11, 12], |span| {
        let end = at.checked_add(span.len()).ok_or(CryptoError::Open)?;
        out.get_mut(at..end)
            .ok_or(CryptoError::Open)?
            .copy_from_slice(span);
        at = end;
        Ok(())
    })?;
    Ok(())
}

// The pinned miniz non-wrapping inflate path owns one fixed-size boxed control
// structure, not a separate sliding-window allocation. Keep this conservative
// logical charge checked on every target and dependency upgrade.
const INFLATE_CONTROL_CHARGE: usize = 64 * 1024;
const _: () = assert!(
    std::mem::size_of::<miniz_oxide::inflate::core::DecompressorOxide>() <= INFLATE_CONTROL_CHARGE
);

/// Checked allocation data for the existing bounded crypto construction.
/// Caller must reserve this entire overlapping peak in its SHARED working
/// account BEFORE allocating AAD workspace or opening, and retain the output
/// charge until the returned Vec is dropped. Input/receipt reservations remain
/// live separately; this plan does not confer native key/policy authority.
#[derive(Debug, Clone, Copy)]
pub struct OpenWorkspacePlan {
    aad_bytes: usize,
    peak_bytes: usize,
}
impl OpenWorkspacePlan {
    /// Exact caller-owned AAD workspace size.
    pub fn aad_bytes(&self) -> usize {
        self.aad_bytes
    }
    /// AAD workspace + padded/segment plaintext + output-capacity/control charge.
    /// Logical charge, not a universal process/allocator/RSS certificate.
    pub fn peak_bytes(&self) -> usize {
        self.peak_bytes
    }
}
/// Plan the unchanged bounded opener, without allocating or exposing any key.
/// Precharge worst metadata traversals and segment/hash/decompression work from
/// bounded source/plain limits BEFORE planning/execution. Salt/error/segment
/// gates preserve the existing raw bounded-open ordering after Wire admission.
pub fn open_workspace_plan(
    item: &BorrowedEnvelope<'_>,
    max_plain: usize,
) -> Result<OpenWorkspacePlan, CryptoError> {
    use super::seal::{MAX_PLAIN, SEGMENT, SEGMENT_CT, padme};
    item.salt().ok_or(CryptoError::Open)?;
    let aad_bytes = aad_workspace_len(item.received())?;
    if max_plain > MAX_PLAIN {
        return Err(CryptoError::TooLarge);
    }
    if item.body().is_empty() {
        return Err(CryptoError::Open);
    }
    let segments = item.body().len().div_ceil(SEGMENT_CT);
    let frame = max_plain.checked_add(9).ok_or(CryptoError::TooLarge)?;
    let max_padded = padme(u64::try_from(frame).map_err(|_| CryptoError::TooLarge)?);
    let preceding = segments
        .checked_sub(1)
        .and_then(|n| n.checked_mul(SEGMENT))
        .ok_or(CryptoError::TooLarge)?;
    if u64::try_from(preceding).map_err(|_| CryptoError::TooLarge)? >= max_padded {
        return Err(CryptoError::TooLarge);
    }
    // Existing opener reserves a padded Vec (segments*SEGMENT), at most one
    // SEGMENT_CT-capacity AEAD temporary, and <=3*max(limit,8) output growth
    // peak: a growth step overlaps old <=limit and new <=2*limit capacities;
    // byte Vec growth has a minimum capacity of 8 in the pinned Rust toolchain.
    // The fixed control charge is checked against the miniz boxed type above.
    let peak_bytes = segments
        .checked_mul(SEGMENT)
        .and_then(|n| {
            max_plain
                .max(8)
                .checked_mul(3)
                .and_then(|m| n.checked_add(m))
        })
        .and_then(|n| n.checked_add(SEGMENT_CT))
        .and_then(|n| n.checked_add(INFLATE_CONTROL_CHARGE))
        .and_then(|n| n.checked_add(aad_bytes))
        .ok_or(CryptoError::TooLarge)?;
    Ok(OpenWorkspacePlan {
        aad_bytes,
        peak_bytes,
    })
}
/// Open parsed DATA with borrowed ciphertext/caller-admitted AAD, using exactly
/// the old key derivation, nonce, STREAM, padding and compression construction.
/// Numeric admitted_peak is NOT evidence of a real shared reservation. New
/// workspace/admission refusals precede mutation/crypto allocation. No output
/// prefix escapes on AEAD/frame failure. No ordinary owned API is replaced.
pub fn open_envelope_borrowed_bounded(
    key: &[u8; 32],
    item: &BorrowedEnvelope<'_>,
    aad_workspace: &mut [u8],
    max_plain: usize,
    admitted_peak: usize,
) -> Result<Vec<u8>, CryptoError> {
    let plan = open_workspace_plan(item, max_plain)?;
    if admitted_peak < plan.peak_bytes {
        return Err(CryptoError::TooLarge);
    }
    if aad_workspace.len() != plan.aad_bytes {
        return Err(CryptoError::Open);
    }
    aad_from_bytes_into(item.received(), aad_workspace)?;
    let salt = item.salt().ok_or(CryptoError::Open)?;
    let result =
        super::seal::open_with_salt_bounded(key, &salt.0, aad_workspace, item.body(), max_plain);
    if result.is_err() {
        aad_workspace.zeroize();
    }
    result
}

/// Verify a received item's signature by `pk`, over its exact bytes.
pub fn verify_item_bytes(pk: &[u8; 32], raw: &[u8]) -> bool {
    let Ok(item) = Item::from_bytes(raw) else {
        return false;
    };
    let Some(sig) = item.sig else {
        return false;
    };
    let Ok(d) = signed_digest_from_bytes(raw) else {
        return false;
    };
    verify_digest(pk, &d, &sig.0)
}

/// Open a received sealed item's body, with the AAD taken from its exact bytes.
pub fn open_item_bytes(key: &[u8; 32], raw: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let item = Item::from_bytes(raw).map_err(|_| CryptoError::Open)?;
    let salt = item.salt.ok_or(CryptoError::Open)?;
    let aad = aad_from_bytes(raw)?;
    open_with_salt(key, &salt.0, &aad, &item.body.0)
}

/// Open exact received AAD with a consumer plaintext limit before inflation.
pub(crate) fn open_item_bytes_bounded(
    key: &[u8; 32],
    raw: &[u8],
    max_plain: usize,
) -> Result<Vec<u8>, CryptoError> {
    let item = Item::from_bytes(raw).map_err(|_| CryptoError::Open)?;
    let salt = item.salt.ok_or(CryptoError::Open)?;
    let aad = aad_from_bytes(raw)?;
    super::seal::open_with_salt_bounded(key, &salt.0, &aad, &item.body.0, max_plain)
}

#[cfg(test)]
#[path = "raw_metadata_tests.rs"]
mod metadata_tests;

#[cfg(test)]
#[path = "raw_borrowed_tests.rs"]
mod borrowed_tests;

#[cfg(test)]
#[path = "raw_open_tests.rs"]
mod open_tests;
