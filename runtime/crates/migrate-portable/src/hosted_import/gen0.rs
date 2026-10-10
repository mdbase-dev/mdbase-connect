//! Metadata-only plan for the bounded generation-0 traversal.

use super::{Class, Key, Meta};
use crate::{Error, Result};

/// Counts known before the streamed snapshot digest starts. No content is held.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ImportStats {
    /// Resource rows.
    pub resources: u64,
    /// Indexed records.
    pub records: u64,
    /// Attachment files (not including oversized Markdown).
    pub attachments: u64,
    /// Oversized Markdown files.
    pub unindexed: u64,
    /// Indexed record text bytes; oversized Markdown is streamed as files.
    pub doc_bytes: u64,
    /// Conservative file-object refs: each file's manifest plus its parts at
    /// AttachmentV1's fixed 8 MiB or a legacy BlobRef's minimum 1 MiB.
    pub file_object_refs_upper_bound: u64,
}

impl ImportStats {
    pub(crate) fn add(&mut self, meta: &Meta) -> Result<()> {
        let mut next = *self;
        if matches!(meta.class, Class::Attachment | Class::UnindexedMarkdown) {
            let part_size = if meta.class == Class::Attachment {
                mdbn_wire::attachment::CHUNK_BYTES_V1
            } else {
                1 << 20 // Native BlobRef validation requires at least 1 MiB.
            };
            let refs = meta
                .size
                .div_ceil(part_size)
                .max(1)
                .checked_add(1)
                .ok_or_else(overflow)?;
            next.file_object_refs_upper_bound = next
                .file_object_refs_upper_bound
                .checked_add(refs)
                .ok_or_else(overflow)?;
        }
        let count = match meta.class {
            Class::Resource => &mut next.resources,
            Class::Record => {
                next.doc_bytes = next.doc_bytes.checked_add(meta.size).ok_or_else(overflow)?;
                &mut next.records
            }
            Class::Attachment => &mut next.attachments,
            Class::UnindexedMarkdown => &mut next.unindexed,
        };
        *count = count.checked_add(1).ok_or_else(overflow)?;
        *self = next;
        Ok(())
    }

    /// Refuse before the first generation-0 import action unless the complete
    /// generated refs inventory is conservatively within the direct-ref limit.
    /// This is temporary: hosted fmt2 installation needs separate heap qualification.
    /// An overestimate is a refusal, not proof that a particular manifest is fmt2.
    pub fn hosted_fmt1_preflight(self) -> Result<u64> {
        // Every record/file has an index row and one content row. A split emits
        // at most one chunk per row, plus one empty chunk per section/bucket.
        // Resources are unbucketed; finish adds five non-bucketed chunks.
        let files = self
            .attachments
            .checked_add(self.unindexed)
            .ok_or_else(overflow)?;
        if self.file_object_refs_upper_bound < files {
            return Err(Error::Invalid(
                "hosted_ref_index_import_unqualified: incomplete file-object refs bound".into(),
            ));
        }
        let rows = self.records.checked_add(files).ok_or_else(overflow)?;
        // Writer flags can declare attachment/unindexed sections even with no
        // rows. Until a bridge enforces exact flags, reserve all five sections.
        let refs = rows
            .checked_mul(2)
            .and_then(|n| n.checked_add((1u64 << self.bucket_bits()) * 5))
            .and_then(|n| n.checked_add(self.resources.max(1)))
            .and_then(|n| n.checked_add(5))
            .and_then(|n| n.checked_add(self.file_object_refs_upper_bound))
            .ok_or_else(overflow)?;
        // Replica::REF_INDEX_THRESHOLD = 2048, excluding the manifest itself.
        // Do not raise this without qualified hosted fmt2 composition/install.
        if refs > 2048 {
            return Err(Error::Invalid(format!(
                "hosted_ref_index_import_unqualified: conservative generated refs bound {refs} exceeds direct-ref limit 2048"
            )));
        }
        Ok(refs)
    }

    /// Bucket bits, using the snapshot's 512 KiB text target and a metadata-row
    /// target of 500. These are planning targets, NOT per-bucket safety bounds:
    /// skewed buckets must still be refused by the host/writer before hydration.
    pub fn bucket_bits(self) -> u64 {
        let rows = self
            .records
            .saturating_add(self.attachments)
            .saturating_add(self.unindexed);
        let buckets = self
            .doc_bytes
            .div_ceil(512 << 10)
            .max(rows.div_ceil(500))
            .max(1);
        u64::from(64 - (buckets - 1).leading_zeros()).min(16)
    }
}

fn overflow() -> Error {
    Error::Invalid("generation-0 counts overflow".into())
}

/// The full 16-bit snapshot bucket: SHA-256 of the UUID's **16 raw bytes**, not
/// its textual representation. Resources are not bucketed.
pub fn bucket16(key: &Key) -> Result<u16> {
    let id = crate::ids::uuid(&key.id)?;
    let hash = mdbn_wire::hash::sha256(&id.0);
    Ok(u16::from_be_bytes([hash.0[0], hash.0[1]]))
}

/// Validate a traversal bucket and return its inclusive full-16-bit range.
pub fn bucket_range(bits: u64, bucket: u64) -> Result<(u16, u16)> {
    if bits > 16 || bucket >= (1u64 << bits) {
        return Err(Error::Invalid("generation-0 bucket out of range".into()));
    }
    let width = 1u64 << (16 - bits);
    Ok(((bucket * width) as u16, ((bucket + 1) * width - 1) as u16))
}
