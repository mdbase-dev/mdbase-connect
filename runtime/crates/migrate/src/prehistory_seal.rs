//! Hosted-service-only second pass: retain old bytes, not a history read API.

use std::collections::{BTreeMap, BTreeSet};

use mdbn_legacy::hosted::FileVersion;
use mdbn_migrate_portable::prehistory::{
    ArchiveSegment, ArchiveSource, SegmentBuilder, SegmentHeader, decode_segment, validate,
};
use mdbn_replica::crypto::CsprngEntropy;
use mdbn_replica::crypto::blob::{content_key, part_addresses};
use mdbn_wire::common::{B32, Uuid};
use mdbn_wire::intent::BlobRef;

use crate::reseal::{
    ObjectSource, ObjectStore, SealKey, Stats, reseal_prehistory, seal_and_upload,
};
use crate::{Error, Result};

/// A sealed archive and all of its GC roots, including old file content parts.
/// The importer must put `prehistory` and `refs` into the same `base` item.
pub struct RetainedArchive {
    /// Ordered archive segment blobs for the base item's prehistory field.
    pub prehistory: Vec<BlobRef>,
    /// Every old-content and archive-part address, sorted and deduplicated.
    /// Archive ciphertext is opaque to GC; rooting only archive parts loses bytes.
    pub refs: Vec<B32>,
    /// Counts of sealed versions and archive segments; never plaintext content.
    pub stats: Stats,
}

/// One original version sealed before its page-bound source handle expires.
/// Native import composition pushes `version` into its bounded segment builder
/// and adds `refs` to the same base's GC roots; no old bytes are returned.
pub struct RetainedFileVersion {
    /// Original version metadata with sealed content, absent for a deletion.
    pub version: mdbn_migrate_portable::prehistory::FileVersion,
    /// Old-content part addresses; deleted versions have no addresses.
    pub refs: Vec<B32>,
    /// Counts for this version's sealing only.
    pub stats: Stats,
}

fn checked_version(
    row: &FileVersion,
    s0: u64,
    collection: Uuid,
) -> Result<mdbn_migrate_portable::prehistory::FileVersion> {
    if row.deleted
        && (row.path.is_some()
            || row.size.is_some()
            || row.content_digest.is_some()
            || row.object_key.is_some()
            || row.media_type.is_some()
            || row.media_class.is_some())
    {
        return Err(Error::Legacy(
            "pre-history: deleted version carries metadata".into(),
        ));
    }
    if !row.deleted && (row.path.is_none() || row.object_key.as_deref().is_none_or(str::is_empty)) {
        return Err(Error::Legacy(
            "pre-history: retained path or object key missing".into(),
        ));
    }
    let version = super::file_version(row)?;
    validate(&ArchiveSegment {
        header: SegmentHeader {
            legacy_collection: collection,
            s0,
            source: ArchiveSource::HostedProvider,
            segment: 0,
            last: true,
        },
        records: Vec::new(),
        files: vec![version.clone()],
    })?;
    Ok(version)
}

/// Seal a single exact historical version through the existing native object
/// seams. Consume a page's source handles before fetching another page; the
/// caller checks whole-checkpoint inventory and version order before publication.
/// `s0` is the original checkpoint head, never a substituted current head.
/// Missing/mismatched objects fail before upload; deletions read no object.
pub fn seal_file_version(
    row: &FileVersion,
    s0: u64,
    source: &mut dyn ObjectSource,
    seal: &SealKey<'_>,
    store: &mut dyn ObjectStore,
    entropy: &mut dyn CsprngEntropy,
) -> Result<RetainedFileVersion> {
    let mut version = checked_version(row, s0, seal.collection)?;
    let mut stats = Stats::default();
    let refs = if version.deleted {
        Vec::new()
    } else {
        let object_key = row
            .object_key
            .as_deref()
            .ok_or_else(|| Error::Legacy("pre-history: retained object key missing".into()))?;
        let bytes = source.get(object_key).map_err(|error| {
            Error::Legacy(format!(
                "file {} version {}: {error}",
                row.file_id, row.sequence
            ))
        })?;
        if version.size != Some(bytes.len() as u64)
            || version.content_digest != Some(mdbn_wire::hash::sha256(&bytes))
        {
            return Err(Error::Legacy(format!(
                "file {} version {}: retained bytes differ from row",
                row.file_id, row.sequence
            )));
        }
        let blob = seal_and_upload(&bytes, &row.file_id, seal, store, entropy, &mut stats)?;
        let refs = part_addresses(&content_key(seal.key, &seal.collection), &blob)
            .map_err(|error| Error::Crypto(format!("pre-history file parts: {error:?}")))?;
        version.content = Some(blob);
        refs
    };
    Ok(RetainedFileVersion {
        version,
        refs,
        stats,
    })
}

fn add_stats(total: &mut Stats, additional: Stats) {
    total.files += additional.files;
    total.bytes += additional.bytes;
    total.parts += additional.parts;
    total.uploaded += additional.uploaded;
    total.present += additional.present;
}

/// Seal exact retained legacy objects into each live `FileVersion.content`, then
/// seal the bounded archive segments and return their complete GC roots.
///
/// Version identity/metadata and the complete row inventory are checked before
/// uploading. Missing objects or wrong size/digest stop migration; current bytes
/// are never substituted. Deleted versions carry no content. Old objects are
/// read-only, and keys remain inside the existing hosted-service sealing boundary.
pub fn seal_retained_history(
    segments: &[Vec<u8>],
    versions: &[FileVersion],
    max_bytes: usize,
    source: &mut dyn ObjectSource,
    seal: &SealKey<'_>,
    store: &mut dyn ObjectStore,
    entropy: &mut dyn CsprngEntropy,
) -> Result<RetainedArchive> {
    let decoded = segments
        .iter()
        .map(|bytes| decode_segment(bytes).map_err(Error::from))
        .collect::<Result<Vec<_>>>()?;
    let first = decoded
        .first()
        .ok_or_else(|| Error::Invalid("pre-history: missing archive segment".into()))?;
    if first.header.legacy_collection != seal.collection {
        return Err(Error::Invalid(
            "pre-history: sealing collection differs".into(),
        ));
    }
    let mut rows = BTreeMap::new();
    for row in versions {
        let version = checked_version(row, first.header.s0, seal.collection)?;
        if rows
            .insert((version.file_id, version.sequence), row)
            .is_some()
        {
            return Err(Error::Invalid("pre-history: duplicate file version".into()));
        }
    }
    // Check the whole metadata inventory first, not after sealing a prefix.
    let mut seen = BTreeSet::new();
    for (index, segment) in decoded.iter().enumerate() {
        if segment.header.segment != index as u64
            || segment.header.last != (index + 1 == decoded.len())
            || segment.header.legacy_collection != first.header.legacy_collection
            || segment.header.s0 != first.header.s0
            || segment.header.source != first.header.source
        {
            return Err(Error::Invalid(
                "pre-history: segment headers disagree".into(),
            ));
        }
        for version in &segment.files {
            let identity = (version.file_id, version.sequence);
            let row = rows.get(&identity).ok_or_else(|| {
                Error::Invalid("pre-history: file version source row missing".into())
            })?;
            if !seen.insert(identity) || super::file_version(row)? != *version {
                return Err(Error::Invalid(
                    "pre-history: file version metadata differs".into(),
                ));
            }
        }
    }
    if seen.len() != rows.len() {
        return Err(Error::Invalid(
            "pre-history: file version inventory differs".into(),
        ));
    }
    let mut builder = SegmentBuilder::new(
        first.header.legacy_collection,
        first.header.s0,
        first.header.source,
        max_bytes,
    );
    let mut retained = Vec::new();
    let mut refs = BTreeSet::new();
    let mut stats = Stats::default();
    let key = content_key(seal.key, &seal.collection);
    let first_s0 = first.header.s0;
    for segment in decoded {
        for record in segment.records {
            if let Some(bytes) = builder.push_record(record)? {
                retained.push(bytes);
            }
        }
        for version in segment.files {
            let row = rows[&(version.file_id, version.sequence)];
            let sealed = seal_file_version(row, first_s0, source, seal, store, entropy)?;
            refs.extend(sealed.refs);
            add_stats(&mut stats, sealed.stats);
            if let Some(bytes) = builder.push_file(sealed.version)? {
                retained.push(bytes);
            }
        }
    }
    let (last, _) = builder.finish()?;
    retained.push(last);
    let (prehistory, archive_stats) = reseal_prehistory(&retained, seal, store, entropy)?;
    for blob in &prehistory {
        refs.extend(
            part_addresses(&key, blob)
                .map_err(|error| Error::Crypto(format!("pre-history archive parts: {error:?}")))?,
        );
    }
    add_stats(&mut stats, archive_stats);
    Ok(RetainedArchive {
        prehistory,
        refs: refs.into_iter().collect(),
        stats,
    })
}
