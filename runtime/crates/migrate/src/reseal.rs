//! Sealing hosted attachments into blob parts (hosted attachment re-sealing and estimates).
//!
//! The old R2 objects are plaintext, so this is a **first** sealing:
//! 1. read the object;
//! 2. check it against the row's digest and size;
//! 3. seal it into 8 MiB parts under the collection's epoch key
//!    (`sealed-envelope.md` §4.2);
//! 4. upload only the parts the log service doesn't have: inline up to 1 MiB, otherwise
//!    through the direct transfer and `commit_object`.
//!
//! Identical content gets the same keyed `blob_id`, so it is uploaded once, and a
//! re-run after a crash skips every part already stored.
//!
//! **Old objects are never written or deleted.** [`ObjectSource`] has only `get`.
//!
//! Documents too large to index (`gen0::oversize_records`) are sealed the same way by
//! [`reseal_oversize_records`], from the H2 read itself: no old object is involved.
//!
//! **Memory:** one file at a time, whole. That fits the old limits (250 MiB per file
//! on the beta tiers, 1 GiB hard ceiling). Streaming is a follow-up if LAB shows
//! pressure.

use std::collections::BTreeMap;

use mdbn_legacy::hosted::verify_object;
use mdbn_replica::crypto::blob::{PART_SIZE, seal_blob};
use mdbn_replica::crypto::{CsprngEntropy, Secret32};
use mdbn_wire::common::{B32, Bytes, Uuid};
use mdbn_wire::envelope::ItemKind;
use mdbn_wire::intent::BlobRef;
use mdbn_wire::log_service::{
    CommitObjectParams, DirectTransfer, PutObjectParams, PutObjectResult, PutStatus,
};

use crate::preflight::Resolved;
use crate::{Error, Result};

/// The largest object `put_object` accepts inline (`log-service-api.md` §6). Anything
/// larger goes through a direct, pre-signed transfer and `commit_object`.
pub const INLINE_MAX: usize = 1 << 20;

/// The log service's object API at the wire level (`log-service-api.md` §6). The hosted
/// service implements it over its authenticated log-service connection and plain HTTPS
/// for the pre-signed `direct` PUT.
pub trait ObjectStore {
    /// `has_objects` (≤ 1,024 addresses).
    fn has_objects(
        &mut self,
        collection: &Uuid,
        addresses: &[B32],
    ) -> std::result::Result<Vec<bool>, String>;
    /// `put_object`. `bytes` is set only for objects of at most [`INLINE_MAX`] bytes.
    fn put_object(
        &mut self,
        params: PutObjectParams,
    ) -> std::result::Result<PutObjectResult, String>;
    /// PUT `bytes` to a pre-signed `direct` transfer, sending its headers (they include
    /// the SHA-256 checksum the object store verifies).
    fn upload_direct(
        &mut self,
        direct: &DirectTransfer,
        bytes: &[u8],
    ) -> std::result::Result<(), String>;
    /// `commit_object`, after a direct upload.
    fn commit_object(&mut self, params: CommitObjectParams) -> std::result::Result<(), String>;
}

/// Read-only access to old objects (R2 in production and LAB, files in tests).
pub trait ObjectSource {
    /// The exact bytes stored under `object_key`.
    fn get(&mut self, object_key: &str) -> std::result::Result<Vec<u8>, String>;
}

/// The key the blobs are sealed under: the new collection's current epoch.
///
/// **Key custody.** This borrows an epoch key, so re-sealing runs **only inside the
/// escrow/hosted service boundary**, the one role with KMS decrypt for the escrow keys
/// (control-plane §4.2). It never runs in Connect, in a CLI, or on an operator's
/// machine. The module is compiled only with the `hosted-service` feature (and in this
/// crate's own unit tests), which only
/// the hosted service enables, and no `mdbase migrate` or `mdbn-rehearse` command
/// exposes it.
pub struct SealKey<'a> {
    /// The epoch key.
    pub key: &'a Secret32,
    /// The epoch.
    pub epoch: u64,
    /// The collection.
    pub collection: Uuid,
}

/// What a re-seal did. Counts only.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Stats {
    /// Files sealed.
    pub files: u64,
    /// Their plaintext bytes.
    pub bytes: u64,
    /// Parts in total.
    pub parts: u64,
    /// Parts uploaded by this run.
    pub uploaded: u64,
    /// Parts already present (dedup, or a resumed run).
    pub present: u64,
}

/// Seal and upload every live file of a resolved read. Returns the `blob-ref` per legacy
/// file ID.
///
/// Taking [`Resolved`] enforces the driver order in code. The full path preflight and
/// the per-collection rename step (`preflight::resolve`) must have run on the same H2
/// read before any object is read or uploaded.
pub fn reseal_files(
    resolved: &Resolved,
    source: &mut dyn ObjectSource,
    seal: &SealKey<'_>,
    store: &mut dyn ObjectStore,
    entropy: &mut dyn CsprngEntropy,
) -> Result<(BTreeMap<String, BlobRef>, Stats)> {
    let files = resolved.files();
    let mut out = BTreeMap::new();
    let mut stats = Stats::default();
    for f in files {
        let bytes = source
            .get(&f.object_key)
            .map_err(|e| Error::Legacy(format!("file {}: {e}", f.file_id)))?;
        verify_object(f, &bytes).map_err(|e| Error::Legacy(e.to_string()))?;
        let blob = seal_and_upload(&bytes, &f.file_id, seal, store, entropy, &mut stats)?;
        out.insert(f.file_id.clone(), blob);
    }
    Ok((out, stats))
}

/// Seal and upload every document of a resolved read that is too large to index
/// (`gen0::oversize_records`), so `gen0::build` can import each as a file at the same
/// path. Returns the `blob-ref` per legacy **record** ID. Same driver order and dedup
/// as [`reseal_files`]; a document whose revision is not its SHA-256 stops the
/// collection before anything is sealed.
pub fn reseal_oversize_records(
    resolved: &Resolved,
    seal: &SealKey<'_>,
    store: &mut dyn ObjectStore,
    entropy: &mut dyn CsprngEntropy,
) -> Result<(BTreeMap<String, BlobRef>, Stats)> {
    let mut out = BTreeMap::new();
    let mut stats = Stats::default();
    for r in crate::gen0::oversize_records(resolved.records()) {
        if mdbn_legacy::revision_of(r.document.as_bytes()) != r.revision {
            return Err(Error::Legacy(format!(
                "record {}: revision does not match its document",
                r.record_id
            )));
        }
        let blob = seal_and_upload(
            r.document.as_bytes(),
            &r.record_id,
            seal,
            store,
            entropy,
            &mut stats,
        )?;
        out.insert(r.record_id.clone(), blob);
    }
    Ok((out, stats))
}

/// Seal and upload the pre-history archive segments of a collection, in order
/// (`mdbn_migrate_portable::prehistory`). Each segment's plaintext is
/// validated (`decode_segment`) before sealing, so a malformed or misordered segment
/// stops the import rather than landing an unreadable archive. Returns the `blob-ref`
/// per segment, in order, for the `base` item's `prehistory` field; the parts of every
/// returned blob must go into that item's `refs`.
pub fn reseal_prehistory(
    segments: &[Vec<u8>],
    seal: &SealKey<'_>,
    store: &mut dyn ObjectStore,
    entropy: &mut dyn CsprngEntropy,
) -> Result<(Vec<BlobRef>, Stats)> {
    use mdbn_migrate_portable::prehistory::decode_segment;
    let mut out = Vec::with_capacity(segments.len());
    let mut stats = Stats::default();
    for (i, bytes) in segments.iter().enumerate() {
        let seg = decode_segment(bytes)?;
        if seg.header.segment != i as u64 || seg.header.last != (i + 1 == segments.len()) {
            return Err(Error::Invalid(format!(
                "pre-history segment {i}: header index/last flag do not match its position"
            )));
        }
        let blob = seal_and_upload(
            bytes,
            &format!("prehistory segment {i}"),
            seal,
            store,
            entropy,
            &mut stats,
        )?;
        out.push(blob);
    }
    Ok((out, stats))
}

/// Seal `bytes` into parts and upload the parts the log service doesn't have.
fn seal_and_upload(
    bytes: &[u8],
    id: &str,
    seal: &SealKey<'_>,
    store: &mut dyn ObjectStore,
    entropy: &mut dyn CsprngEntropy,
    stats: &mut Stats,
) -> Result<BlobRef> {
    let (blob, parts) = seal_blob(
        seal.key,
        seal.epoch,
        &seal.collection,
        bytes,
        PART_SIZE,
        true,
        entropy,
    )
    .map_err(|e| Error::Crypto(format!("{id}: {e:?}")))?;
    let addresses: Vec<B32> = parts.iter().map(|p| p.address).collect();
    let mut present = Vec::with_capacity(addresses.len());
    for batch in addresses.chunks(1024) {
        let flags = store
            .has_objects(&seal.collection, batch)
            .map_err(|e| Error::Log(format!("has_objects: {e}")))?;
        if flags.len() != batch.len() {
            return Err(Error::Log("has_objects: wrong answer length".into()));
        }
        present.extend(flags);
    }
    for (part, there) in parts.into_iter().zip(present) {
        stats.parts += 1;
        if there {
            stats.present += 1;
            continue;
        }
        if upload_part(store, &seal.collection, part.address, &part.bytes)? {
            stats.uploaded += 1;
        } else {
            stats.present += 1;
        }
    }
    stats.files += 1;
    stats.bytes += bytes.len() as u64;
    Ok(blob)
}

/// Upload one sealed part. Returns `true` if it was stored now, or `false` if it already
/// existed. Parts larger than [`INLINE_MAX`] (an 8 MiB part always is) use the direct
/// transfer and `commit_object`.
fn upload_part(
    store: &mut dyn ObjectStore,
    collection: &Uuid,
    address: B32,
    bytes: &[u8],
) -> Result<bool> {
    let inline = bytes.len() <= INLINE_MAX;
    let result = store
        .put_object(PutObjectParams {
            collection: *collection,
            address,
            kind: ItemKind::BlobPart,
            size: bytes.len() as u64,
            checksum: mdbn_wire::hash::sha256(bytes),
            bytes: inline.then(|| Bytes(bytes.to_vec())),
        })
        .map_err(|e| Error::Log(format!("put_object: {e}")))?;
    match (result.status, result.direct) {
        (PutStatus::Exists, _) => Ok(false),
        (PutStatus::Stored, _) if inline => Ok(true),
        (PutStatus::Upload, Some(direct)) => {
            store
                .upload_direct(&direct, bytes)
                .map_err(|e| Error::Log(format!("direct upload: {e}")))?;
            store
                .commit_object(CommitObjectParams {
                    collection: *collection,
                    address,
                })
                .map_err(|e| Error::Log(format!("commit_object: {e}")))?;
            Ok(true)
        }
        (status, direct) => Err(Error::Log(format!(
            "put_object: unexpected {status:?} (direct transfer offered: {})",
            direct.is_some()
        ))),
    }
}

#[cfg(test)]
#[path = "reseal_testing.rs"]
mod testing;

#[cfg(test)]
#[path = "reseal_tests.rs"]
mod tests;
