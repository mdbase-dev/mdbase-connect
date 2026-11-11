//! Paging confirmed-state rows out of the store, and what a file row holds.

use super::*;

/// Every record in ID order, paged through the store, or `None` as soon as the
/// text passes `limit`.
pub(super) fn records_within(
    s: &dyn Store,
    limit: u64,
) -> Result<Option<Vec<RecordRow>>, StoreError> {
    let mut out = Vec::new();
    let mut after = None;
    let mut bytes = 0u64;
    loop {
        let p = s.records(Page { after, limit: 1024 })?;
        let Some(l) = p.last() else {
            break;
        };
        after = Some(l.id);
        bytes += p.iter().map(|r| r.doc.len() as u64).sum::<u64>();
        if bytes > limit {
            return Ok(None);
        }
        out.extend(p);
    }
    Ok(Some(out))
}

pub(super) fn all_files(s: &dyn Store) -> Result<Vec<FileRow>, StoreError> {
    let mut out = Vec::new();
    let mut after = None;
    loop {
        let p = s.files(Page { after, limit: 1024 })?;
        let Some(l) = p.last() else {
            break;
        };
        after = Some(l.id);
        out.extend(p);
    }
    Ok(out)
}

pub(super) fn all_tombstones(s: &dyn Store) -> Result<Vec<TombstoneRow>, StoreError> {
    let mut out = Vec::new();
    let mut after = None;
    loop {
        let p = s.tombstones(Page { after, limit: 1024 })?;
        let Some(l) = p.last() else {
            break;
        };
        after = Some(l.id);
        out.extend(p);
    }
    Ok(out)
}

pub(super) fn all_receipts(s: &dyn Store) -> Result<Vec<ReceiptRow>, StoreError> {
    let mut out = Vec::new();
    let mut after = None;
    loop {
        let p = s.receipts(after, 1024)?;
        let Some(l) = p.last() else {
            break;
        };
        after = Some(l.mutation);
        out.extend(p);
    }
    Ok(out)
}

pub(super) fn tomb_revision(t: &TombstoneRow) -> Hash {
    match &t.last {
        TombstoneLast::Doc(d) => mdbn_wire::hash::sha256(d.as_bytes()),
        TombstoneLast::Blob(b) => b.plain_hash,
        TombstoneLast::Attachment(a) => a.whole_plain_hash,
        TombstoneLast::UnindexedMarkdown(p) => p.content.plain_hash(),
    }
}

/// What a file row holds, for the section it belongs to: a legacy blob goes to
/// `Files` (4), attachment content to the critical `AttachmentFiles` (10). A
/// content form this replica does not know is never written as either.
pub(super) enum RowContent<'a> {
    Blob(&'a mdbn_wire::intent::BlobRef),
    Attachment(&'a AttachmentContentV1),
}

pub(super) fn row_content(content: &FileContent) -> Result<RowContent<'_>, StoreError> {
    match content {
        FileContent::Blob(b) => Ok(RowContent::Blob(b)),
        FileContent::AttachmentV1(a) => Ok(RowContent::Attachment(a)),
        _ => Err(StoreError::Corrupt(
            "file row content form unknown to this replica".into(),
        )),
    }
}

/// Every attachment the state holds (live files, retained file tombstones and
/// conflict sides), by manifest address.
#[derive(Default)]
pub(super) struct Held(pub(super) BTreeMap<Hash, AttachmentContentV1>);

impl Held {
    pub(super) fn add(&mut self, a: &AttachmentContentV1) {
        self.0
            .entry(a.reference.manifest_cipher_hash)
            .or_insert_with(|| a.clone());
    }
}
