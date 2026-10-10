//! Blobs: keyed content addressing and part sealing (`sealed-envelope.md` §4.2).
//!
//! ```text
//! K_cid(e)  = HKDF-SHA256(ikm = K_e, salt = collection_id, info = "mdbase/v1/content-id")
//! blob_id   = MAC(K_cid, "mdbase/v1/blob-id", SHA-256(B) ‖ u64be(size))
//! address_i = MAC(K_cid, "mdbase/v1/blob-part", blob_id ‖ u32be(i))
//! ```

use mdbn_wire::common::{B32, Bytes, Uuid};
use mdbn_wire::envelope::{Item, ItemKind};
use mdbn_wire::intent::BlobRef;

use super::seal::seal_item_body;
use super::sign::finish;
use super::{CryptoError, CsprngEntropy, Secret32, ct_eq, hkdf32, mac_parts};

/// Default plaintext bytes per part (8 MiB).
pub const PART_SIZE: u64 = 8 << 20;
/// Smallest `part_size` a reference may declare.
pub const MIN_PART_SIZE: u64 = 1 << 20;
/// Largest `part_size` a reference may declare. Writers use
/// [`PART_SIZE`]; the log service's 9 MiB object limit (I13) bounds what can
/// actually be uploaded.
pub const MAX_PART_SIZE: u64 = 16 << 20;
/// Most parts one `blob-ref` may have: 8 GiB at the default part size.
pub const MAX_PARTS: u64 = 1_024;

/// Check a blob reference's declared shape **before** allocating or fetching
/// anything for it: `part_size` in [1 MiB, 16 MiB] and at most 1,024
/// parts. An entry carrying a reference outside these bounds is **void (V7)**;
/// replicas check every `blob-ref` at replay and before any download.
pub fn validate_blob_ref(r: &BlobRef) -> Result<(), CryptoError> {
    if r.part_size < MIN_PART_SIZE || r.part_size > MAX_PART_SIZE {
        return Err(CryptoError::TooLarge);
    }
    if r.size.div_ceil(r.part_size).max(1) > MAX_PARTS {
        return Err(CryptoError::TooLarge);
    }
    Ok(())
}

/// The plaintext length of part `i` of a (validated) reference.
pub fn expected_part_len(r: &BlobRef, i: u64) -> Option<u64> {
    let parts = r.size.div_ceil(r.part_size).max(1);
    if i >= parts {
        return None;
    }
    let start = i * r.part_size;
    Some((r.size - start.min(r.size)).min(r.part_size))
}

/// The largest sealed envelope a part of `len` plaintext bytes can be.
pub(crate) fn max_sealed_len(len: u64) -> u64 {
    let padded = super::seal::padme(len + 9);
    padded + 16 * (padded / super::seal::SEGMENT as u64 + 1) + 512
}

/// The per-epoch content-addressing key.
pub fn content_key(epoch_key: &Secret32, collection: &Uuid) -> Secret32 {
    hkdf32(epoch_key.expose(), &collection.0, b"mdbase/v1/content-id")
}

/// The keyed blob ID of content with this digest and size.
pub fn blob_id(k_cid: &Secret32, plain_hash: &[u8; 32], size: u64) -> [u8; 32] {
    mac_parts(
        k_cid.expose(),
        "mdbase/v1/blob-id",
        &[plain_hash, &size.to_be_bytes()],
    )
}

/// The address of part `i` of a blob.
pub fn part_address(k_cid: &Secret32, blob_id: &[u8; 32], i: u32) -> [u8; 32] {
    mac_parts(
        k_cid.expose(),
        "mdbase/v1/blob-part",
        &[blob_id, &i.to_be_bytes()],
    )
}

/// Every part address of a blob reference (`k_cid` of the ref's `id_epoch`).
/// Validates the reference first, so a hostile `size`/`part_size` cannot make it
/// allocate.
pub fn part_addresses(k_cid: &Secret32, r: &BlobRef) -> Result<Vec<B32>, CryptoError> {
    validate_blob_ref(r)?;
    Ok((0..r.part_count())
        .map(|i| B32(part_address(k_cid, &r.blob_id.0, i as u32)))
        .collect())
}

/// The blob reference for `plain` under epoch `epoch`.
pub fn blob_ref(k_cid: &Secret32, epoch: u64, plain: &[u8], part_size: u64) -> BlobRef {
    let h = mdbn_wire::hash::sha256(plain);
    let size = plain.len() as u64;
    BlobRef {
        plain_hash: h,
        size,
        blob_id: B32(blob_id(k_cid, &h.0, size)),
        id_epoch: epoch,
        part_size,
    }
}

/// A sealed blob part ready to upload.
#[derive(Debug, Clone, PartialEq)]
pub struct SealedPart {
    /// Keyed address.
    pub address: B32,
    /// Canonical envelope bytes.
    pub bytes: Vec<u8>,
}

/// Seal one part (`i`) of a blob as a `blob-part` object under epoch `epoch`.
pub fn seal_part(
    epoch_key: &Secret32,
    epoch: u64,
    collection: &Uuid,
    address: B32,
    part: &[u8],
    compress: bool,
    entropy: &mut dyn CsprngEntropy,
) -> Result<SealedPart, CryptoError> {
    let mut item = Item {
        kind: ItemKind::BlobPart,
        collection: *collection,
        seq: None,
        prev: None,
        epoch: Some(epoch),
        signer: None,
        salt: None,
        idem: None,
        refs: None,
        stream: None,
        body: Bytes::default(),
        sig: None,
    };
    seal_item_body(epoch_key.expose(), &mut item, part, compress, entropy)?;
    Ok(SealedPart {
        address,
        bytes: finish(&item)?.bytes,
    })
}

/// Split `plain` into parts and seal each. Returns the reference and the parts.
pub fn seal_blob(
    epoch_key: &Secret32,
    epoch: u64,
    collection: &Uuid,
    plain: &[u8],
    part_size: u64,
    compress: bool,
    entropy: &mut dyn CsprngEntropy,
) -> Result<(BlobRef, Vec<SealedPart>), CryptoError> {
    let k_cid = content_key(epoch_key, collection);
    let r = blob_ref(&k_cid, epoch, plain, part_size);
    let ps = usize::try_from(part_size).map_err(|_| CryptoError::TooLarge)?;
    let mut parts = Vec::new();
    for (i, addr) in part_addresses(&k_cid, &r)?.into_iter().enumerate() {
        let start = (i * ps).min(plain.len());
        let end = (start + ps).min(plain.len());
        parts.push(seal_part(
            epoch_key,
            epoch,
            collection,
            addr,
            &plain[start..end],
            compress,
            entropy,
        )?);
    }
    Ok((r, parts))
}

/// Open part `i` of blob `r` from its received envelope bytes. Checks the size
/// bound before decrypting, the kind and collection, the AAD over the received
/// bytes, and that the plaintext has exactly the expected length. The whole-blob
/// digest is checked after reassembly with [`check_blob`].
pub fn open_part(
    epoch_key: &Secret32,
    collection: &Uuid,
    r: &BlobRef,
    i: u64,
    bytes: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    use mdbn_wire::schema::Wire;
    validate_blob_ref(r)?;
    let want = expected_part_len(r, i).ok_or(CryptoError::Open)?;
    if bytes.len() as u64 > max_sealed_len(want) {
        return Err(CryptoError::TooLarge);
    }
    let item = Item::from_bytes(bytes).map_err(|_| CryptoError::Open)?;
    if item.kind != ItemKind::BlobPart || item.collection != *collection {
        return Err(CryptoError::Open);
    }
    let plain = super::raw::open_item_bytes_bounded(
        epoch_key.expose(),
        bytes,
        usize::try_from(want).map_err(|_| CryptoError::TooLarge)?,
    )?;
    if plain.len() as u64 != want {
        return Err(CryptoError::Open);
    }
    Ok(plain)
}

/// Whether reassembled bytes match the reference (digest and length).
pub fn check_blob(r: &BlobRef, plain: &[u8]) -> bool {
    plain.len() as u64 == r.size && ct_eq(&mdbn_wire::hash::sha256(plain).0, &r.plain_hash.0)
}
