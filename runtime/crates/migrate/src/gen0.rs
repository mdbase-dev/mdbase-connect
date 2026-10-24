//! Generation 0 of a hosted collection (hosted adoption, H2–H4).
//!
//! [`Gen0`] is the collection's confirmed state at the snapshot sequence `S0`, in
//! new-system terms:
//! - resources as text;
//! - records with their **legacy IDs** and exact documents;
//! - live files as `blob-ref`s already sealed and uploaded by [`crate::reseal`].
//!
//! It is what the replica's import call takes, to build the sealed generation-0
//! manifest and append `base {hosted-import, legacy_collection}` (requested from the
//! replica workstream; not yet on main).
//!
//! History, tombstones and change logs are deliberately absent (§7: history is not
//! imported).
//!
//! **Documents too large to index.** Legacy hosted documents go up to the provider's
//! 2 MiB quota, but a synced record is capped at [`MAX_RECORD_DOCUMENT_BYTES`]. A larger
//! document is imported as an attachment-backed **file at the same path**, bytes
//! preserved exactly (its legacy record ID becomes the file ID), and listed in the
//! per-account migration report as [`IMPORTED_AS_FILE_REASON`]. Nothing is dropped or
//! truncated. The file uses the typed
//! "unindexed oversized markdown" kind; until that representation
//! lands, [`MediaClass::Other`] here is a placeholder that does not by itself admit a
//! file at a record-extension path.

use std::collections::{BTreeMap, BTreeSet};

use mdbn_legacy::hosted::{FileMeta, Record};
use mdbn_wire::common::{Hash, Uuid};
use mdbn_wire::intent::{BlobRef, MediaClass};

use crate::{Error, Result, ids, preflight};

/// The largest document a synced record may carry
/// (`mdbn_migrate_portable::oversize::MAX_RECORD_DOCUMENT_BYTES`): strictly larger
/// legacy documents are imported as files.
pub const MAX_RECORD_DOCUMENT_BYTES: usize =
    mdbn_migrate_portable::oversize::MAX_RECORD_DOCUMENT_BYTES as usize;

pub use mdbn_migrate_portable::oversize::{IMPORTED_AS_FILE_REASON, ImportedAsFile};

/// Whether a legacy record's document exceeds [`MAX_RECORD_DOCUMENT_BYTES`] and so is
/// imported as a file. The same rule applies to legacy changes read after `S0`.
pub fn is_oversize(record: &Record) -> bool {
    mdbn_migrate_portable::oversize::is_oversize(record.document.len() as u64)
}

/// The records of a read that are imported as files, in input order. H3 seals their
/// documents as blobs (`reseal::reseal_oversize_records`) before [`build`].
pub fn oversize_records(records: &[Record]) -> impl Iterator<Item = &Record> {
    records.iter().filter(|r| is_oversize(r))
}

/// A record at generation 0.
#[derive(Clone, Debug, PartialEq)]
pub struct Gen0Record {
    /// Legacy record ID, kept.
    pub id: Uuid,
    /// Collection-relative path.
    pub path: String,
    /// The exact Markdown.
    pub doc: String,
    /// SHA-256 of `doc`.
    pub revision: Hash,
}

/// A live file at generation 0.
#[derive(Clone, Debug, PartialEq)]
pub struct Gen0File {
    /// Legacy file ID, kept.
    pub id: Uuid,
    /// Collection-relative path.
    pub path: String,
    /// The sealed blob (`plain_hash` = the legacy `content_digest`).
    pub blob: BlobRef,
    /// Media class.
    pub media: MediaClass,
}

/// A hosted collection's generation 0.
#[derive(Clone, Debug, PartialEq)]
pub struct Gen0 {
    /// The collection ID (the legacy ID, `00-overview.md` §5).
    pub collection: Uuid,
    /// The legacy `head` this was read at (`S0`): where the shadow continues.
    pub legacy_head: i64,
    /// Resources by path.
    pub resources: Vec<(String, String)>,
    /// Records by ID.
    pub records: Vec<Gen0Record>,
    /// Files by ID, including documents imported as files.
    pub files: Vec<Gen0File>,
    /// Documents imported as files (also present in `files`), by ID. Every entry goes
    /// into the per-account migration report.
    pub imported_as_files: Vec<ImportedAsFile>,
}

/// Map the provider's media class string.
pub fn media_class(s: &str) -> MediaClass {
    match s {
        "image" => MediaClass::Image,
        "audio" => MediaClass::Audio,
        "video" => MediaClass::Video,
        "pdf" => MediaClass::Pdf,
        _ => MediaClass::Other,
    }
}

/// Build generation 0 from a consistent legacy read and the sealed blobs.
///
/// A record over [`MAX_RECORD_DOCUMENT_BYTES`] becomes a file at the same path with the
/// record's ID, from the sealed blob under that ID in `sealed`, and a report entry.
///
/// Fails, and so stops this collection's migration, if:
/// - a record's revision is not the SHA-256 of its document;
/// - a live file, or a document imported as a file, has no sealed blob, or one whose
///   digest or size differs;
/// - a resource is not UTF-8 (`resource-row` holds text);
/// - any path fails the portable policy or collides under NFC/case folding across
///   resources, records and files (the complete report is returned in `Error::Paths`);
/// - an ID repeats.
///
/// Run `preflight::inspect_paths` on the same read before sealing attachments too.
pub fn build(
    collection: &str,
    legacy_head: i64,
    resources: &[(String, Vec<u8>)],
    records: &[Record],
    files: &[FileMeta],
    sealed: &BTreeMap<String, BlobRef>,
) -> Result<Gen0> {
    preflight::inspect_paths(resources, records, files).ensure_clear()?;
    let mut seen_ids = BTreeSet::new();

    let mut out_resources = Vec::with_capacity(resources.len());
    for (path, bytes) in resources {
        let text = String::from_utf8(bytes.clone())
            .map_err(|_| Error::Invalid(format!("resource {path} is not UTF-8")))?;
        out_resources.push((path.clone(), text));
    }
    out_resources.sort_by(|a, b| a.0.cmp(&b.0));

    let mut out_records = Vec::with_capacity(records.len());
    let mut out_files = Vec::with_capacity(files.len());
    let mut imported_as_files = Vec::new();
    for r in records {
        let id = ids::uuid(&r.record_id)?;
        if !seen_ids.insert(id) {
            return Err(Error::Invalid(format!("duplicate id {}", r.record_id)));
        }
        let revision = ids::revision(&r.revision)?;
        if mdbn_legacy::revision_of(r.document.as_bytes()) != r.revision {
            return Err(Error::Invalid(format!(
                "record {}: revision does not match its document",
                r.record_id
            )));
        }
        if is_oversize(r) {
            let size = r.document.len() as u64;
            let blob = sealed.get(&r.record_id).ok_or_else(|| {
                Error::Invalid(format!(
                    "record {}: too large to index and not re-sealed as a file",
                    r.record_id
                ))
            })?;
            if blob.plain_hash != revision || blob.size != size {
                return Err(Error::Invalid(format!(
                    "record {}: sealed blob differs from the document",
                    r.record_id
                )));
            }
            out_files.push(Gen0File {
                id,
                path: r.path.clone(),
                blob: blob.clone(),
                media: MediaClass::Other,
            });
            imported_as_files.push(ImportedAsFile {
                id,
                path: r.path.clone(),
                bytes: size,
            });
            continue;
        }
        out_records.push(Gen0Record {
            id,
            path: r.path.clone(),
            doc: r.document.clone(),
            revision,
        });
    }
    out_records.sort_by(|a, b| a.id.cmp(&b.id));

    for f in files {
        let id = ids::uuid(&f.file_id)?;
        if !seen_ids.insert(id) {
            return Err(Error::Invalid(format!("duplicate id {}", f.file_id)));
        }
        let blob = sealed
            .get(&f.file_id)
            .ok_or_else(|| Error::Invalid(format!("file {}: not re-sealed", f.file_id)))?;
        if blob.plain_hash != ids::revision(&f.content_digest)? || blob.size != f.size {
            return Err(Error::Invalid(format!(
                "file {}: sealed blob differs from the row",
                f.file_id
            )));
        }
        out_files.push(Gen0File {
            id,
            path: f.path.clone(),
            blob: blob.clone(),
            media: media_class(&f.media_class),
        });
    }
    out_files.sort_by(|a, b| a.id.cmp(&b.id));
    imported_as_files.sort_by(|a, b| a.id.cmp(&b.id));

    Ok(Gen0 {
        collection: ids::uuid(collection)?,
        legacy_head,
        resources: out_resources,
        records: out_records,
        files: out_files,
        imported_as_files,
    })
}
