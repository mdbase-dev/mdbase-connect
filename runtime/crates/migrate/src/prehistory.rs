//! Building a collection's pre-history archive from the legacy version rows
//! (pre-history preservation). The format and the segment builder
//! are portable (`mdbn_migrate_portable::prehistory`); this is the native glue over
//! `mdbn-legacy`'s decoded version rows, and the sealing goes through
//! [`crate::reseal::reseal_prehistory`].

use mdbn_legacy::hosted::{FileVersion, RecordVersion};
use mdbn_migrate_portable::prehistory::{self, ArchiveSource, SegmentBuilder};

use crate::{Error, Result, ids};

/// A legacy record version in archive form.
pub fn record_version(v: &RecordVersion) -> Result<prehistory::RecordVersion> {
    Ok(prehistory::RecordVersion {
        record_id: ids::uuid(&v.record_id)?,
        sequence: v.sequence,
        revision: v.revision.clone(),
        path: v.path.clone(),
        document: v.document.clone(),
        created_at: v.created_at_ms,
        deleted: v.deleted,
    })
}

/// A legacy file version in archive form. The old bytes (`content`) are a second pass.
pub fn file_version(v: &FileVersion) -> Result<prehistory::FileVersion> {
    Ok(prehistory::FileVersion {
        file_id: ids::uuid(&v.file_id)?,
        sequence: v.sequence,
        revision: v.revision.clone(),
        path: v.path.clone(),
        size: v.size,
        content_digest: v.content_digest.as_deref().map(ids::revision).transpose()?,
        created_at: v.created_at_ms,
        deleted: v.deleted,
        content: None,
    })
}

/// Build the archive segments of `collection` at `s0` from legacy version rows read in
/// `(id, sequence)` order (`HostedDb::record_versions` / `file_versions` pages). Each
/// segment's plaintext is bounded by `max_bytes`. Nothing is dropped: a row that cannot
/// be converted stops the collection.
pub fn build_segments<R, F>(
    collection: &str,
    s0: u64,
    max_bytes: usize,
    records: R,
    files: F,
) -> Result<Vec<Vec<u8>>>
where
    R: IntoIterator<Item = Result<RecordVersion>>,
    F: IntoIterator<Item = Result<FileVersion>>,
{
    let mut b = SegmentBuilder::new(
        ids::uuid(collection)?,
        s0,
        ArchiveSource::HostedProvider,
        max_bytes,
    );
    let mut out = Vec::new();
    for r in records {
        if let Some(seg) = b.push_record(record_version(&r?)?)? {
            out.push(seg);
        }
    }
    for f in files {
        if let Some(seg) = b.push_file(file_version(&f?)?)? {
            out.push(seg);
        }
    }
    let (last, n) = b.finish()?;
    out.push(last);
    if out.len() != n as usize {
        return Err(Error::Invalid("pre-history: segment count mismatch".into()));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use mdbn_migrate_portable::prehistory::decode_segment;

    const CID: &str = "4c18af2e-b04a-4b77-b83e-493c3695962e";
    const R1: &str = "0192f0c1-7e1a-7b3c-8d4e-000000000001";
    const F1: &str = "0192f0c1-7e1a-7b3c-8d4e-0000000000f1";

    #[test]
    fn legacy_rows_become_bounded_segments() {
        let rows = vec![
            Ok(RecordVersion {
                record_id: R1.into(),
                sequence: 1,
                revision: mdbn_legacy::revision_of(b"a"),
                created_at_ms: 1,
                deleted: false,
                path: Some("notes/a.md".into()),
                document: Some("a".into()),
            }),
            Ok(RecordVersion {
                record_id: R1.into(),
                sequence: 3,
                revision: "gone".into(),
                created_at_ms: 3,
                deleted: true,
                path: None,
                document: None,
            }),
        ];
        let files = vec![Ok(FileVersion {
            file_id: F1.into(),
            sequence: 2,
            revision: "r".into(),
            created_at_ms: 2,
            deleted: false,
            path: Some("att/a.png".into()),
            content_digest: Some(mdbn_legacy::revision_of(b"png")),
            size: Some(3),
            object_key: Some("v1/blobs/x".into()),
            media_type: None,
            media_class: Some("image".into()),
        })];
        let segs = build_segments(CID, 3, 64, rows, files).unwrap();
        assert!(segs.len() >= 2, "a 64-byte bound splits the archive");
        let mut records = 0;
        let mut files_n = 0;
        for (i, s) in segs.iter().enumerate() {
            let seg = decode_segment(s).unwrap();
            assert_eq!(seg.header.segment as usize, i);
            assert_eq!(seg.header.last, i + 1 == segs.len());
            records += seg.records.len();
            files_n += seg.files.len();
            for f in &seg.files {
                assert!(f.content.is_none(), "old bytes are a second pass");
            }
        }
        assert_eq!((records, files_n), (2, 1));
        // A malformed legacy ID stops the collection.
        let bad = vec![Ok(RecordVersion {
            record_id: "not-a-uuid".into(),
            sequence: 1,
            revision: "x".into(),
            created_at_ms: 0,
            deleted: true,
            path: None,
            document: None,
        })];
        assert!(build_segments(CID, 3, 64, bad, Vec::<Result<FileVersion>>::new()).is_err());
    }
}
