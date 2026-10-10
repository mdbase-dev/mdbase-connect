//! The **pre-history archive**: a legacy collection's version history, imported at
//! `S0` as sealed archive segments referenced from the `base` item.
//! The v1.1 history reader
//! presents these versions, marked "imported", on the same per-record timeline as
//! log/archive history. A restore writes a new entry; pre-history is never replayed.
//!
//! **Format (pinned, fmt 1).** Each segment is one canonical-CBOR [`ArchiveSegment`]
//! map: a [`SegmentHeader`] and the record and file versions it holds, each sorted by
//! `(id, sequence)` strictly increasing; the order continues across segments, so the
//! segments of one archive are read in index order. Every value a legacy version row
//! has is kept exactly (`revision` is the legacy token as stored, `created_at` is the
//! row's timestamp in milliseconds); nothing is normalised. A deleted version carries
//! no document/content. Old file bytes are a second pass ([`FileVersion::content`]).
//!
//! Segments are sealed and uploaded like attachments (parts under the collection
//! epoch key, content-addressed) by the importer; the `base` item lists the ordered
//! `blob-ref`s and every part address in `refs`, so GC retains them with the
//! generation-0 manifest. A [`SegmentBuilder`] bounds plaintext per segment so the
//! importer never holds a whole history in memory.

use mdbn_wire::common::{Hash, Uuid};
use mdbn_wire::intent::BlobRef;
use mdbn_wire::schema::Wire;
use mdbn_wire::{wire_enum, wire_struct};

use crate::Error;

/// This module's result (the wire macros need the std `Result` name).
type PResult<T> = crate::Result<T>;

wire_enum! {
    /// Where the versions came from.
    pub enum ArchiveSource {
        /// Today's hosted provider (`hosted_provider_record_versions` / `_file_versions`).
        HostedProvider = 0,
        /// A local connector's journals.
        LocalConnector = 1,
    }
}

wire_struct! {
    /// One segment's header.
    pub struct SegmentHeader {
        /// The Connect collection the versions belong to (also the new collection ID).
        1 req legacy_collection: Uuid,
        /// The legacy head the current state was imported at; every version here has
        /// `sequence <= s0`.
        2 req s0: u64,
        /// Source system.
        3 req source: ArchiveSource,
        /// Zero-based index of this segment in the archive.
        4 req segment: u64,
        /// Whether this is the archive's last segment.
        5 req last: bool,
    }
}

wire_struct! {
    /// One version of a record.
    pub struct RecordVersion {
        /// Legacy record ID (kept by the import).
        1 req record_id: Uuid,
        /// Legacy sequence of this version.
        2 req sequence: u64,
        /// The legacy revision token exactly as stored (`sha256:<hex>` for documents).
        3 req revision: String,
        /// Path at this version, when the row carried it.
        4 opt path: String,
        /// The exact document; absent when `deleted`.
        5 opt document: String,
        /// Row timestamp, milliseconds since the Unix epoch.
        6 req created_at: i64,
        /// A deletion version.
        7 req deleted: bool,
    }
}

wire_struct! {
    /// One version of a file.
    pub struct FileVersion {
        /// Legacy file ID (kept by the import).
        1 req file_id: Uuid,
        /// Legacy sequence of this version.
        2 req sequence: u64,
        /// The legacy revision token exactly as stored.
        3 req revision: String,
        /// Path at this version, when the row carried it.
        4 opt path: String,
        /// Size in bytes; absent when `deleted`.
        5 opt size: u64,
        /// SHA-256 of the bytes; absent when `deleted`.
        6 opt content_digest: Hash,
        /// Row timestamp, milliseconds since the Unix epoch.
        7 req created_at: i64,
        /// A deletion version.
        8 req deleted: bool,
        /// The old bytes, sealed by a second pass; absent until then.
        9 opt content: BlobRef,
    }
}

wire_struct! {
    /// One archive segment (`fmt` 1).
    pub struct ArchiveSegment [fmt = 1] {
        /// Header.
        1 req header: SegmentHeader,
        /// Record versions, sorted by `(record_id, sequence)` strictly increasing.
        2 req records: Vec<RecordVersion>,
        /// File versions, sorted by `(file_id, sequence)` strictly increasing.
        3 req files: Vec<FileVersion>,
    }
}

/// Default plaintext bound per segment (32 MiB).
pub const DEFAULT_SEGMENT_BYTES: usize = 32 << 20;

fn invalid(what: impl Into<String>) -> Error {
    Error::Invalid(what.into())
}

fn check_version(
    sequence: u64,
    s0: u64,
    deleted: bool,
    has_content: bool,
    what: &str,
) -> PResult<()> {
    if sequence == 0 || sequence > s0 {
        return Err(invalid(format!(
            "{what}: sequence {sequence} is not in 1..=s0"
        )));
    }
    if deleted == has_content {
        return Err(invalid(format!(
            "{what}: a deleted version carries no content and a live one must"
        )));
    }
    Ok(())
}

fn check_order(prev: &mut Option<(Uuid, u64)>, id: Uuid, sequence: u64, what: &str) -> PResult<()> {
    if let Some((pid, pseq)) = *prev
        && (id, sequence) <= (pid, pseq)
    {
        return Err(invalid(format!(
            "{what}: versions must be strictly increasing by (id, sequence)"
        )));
    }
    *prev = Some((id, sequence));
    Ok(())
}

fn check_file_version(f: &FileVersion, s0: u64) -> PResult<()> {
    check_version(
        f.sequence,
        s0,
        f.deleted,
        f.size.is_some() && f.content_digest.is_some(),
        "file version",
    )?;
    if f.deleted && (f.size.is_some() || f.content_digest.is_some() || f.content.is_some()) {
        return Err(invalid(
            "file version: a deleted version has no file metadata or bytes",
        ));
    }
    Ok(())
}

/// Validate a decoded segment: header consistency, every version in `1..=s0`,
/// deleted/content agreement, and strict `(id, sequence)` order of each list.
pub fn validate(segment: &ArchiveSegment) -> PResult<()> {
    let s0 = segment.header.s0;
    let mut prev = None;
    for r in &segment.records {
        check_version(
            r.sequence,
            s0,
            r.deleted,
            r.document.is_some(),
            "record version",
        )?;
        check_order(&mut prev, r.record_id, r.sequence, "record versions")?;
    }
    let mut prev = None;
    for f in &segment.files {
        check_file_version(f, s0)?;
        check_order(&mut prev, f.file_id, f.sequence, "file versions")?;
    }
    Ok(())
}

/// Decode and validate one segment's plaintext.
pub fn decode_segment(bytes: &[u8]) -> PResult<ArchiveSegment> {
    let segment =
        ArchiveSegment::from_bytes(bytes).map_err(|e| invalid(format!("segment: {e:?}")))?;
    validate(&segment)?;
    Ok(segment)
}

/// Builds an archive's segments in order, bounding each segment's plaintext.
///
/// Push versions in `(id, sequence)` order per kind (records and files are
/// independent lists). When a segment would exceed the bound, the versions so far
/// are emitted as one segment and the new version starts the next; a single version
/// over the bound gets a segment of its own. Nothing is ever dropped.
pub struct SegmentBuilder {
    collection: Uuid,
    s0: u64,
    source: ArchiveSource,
    max_bytes: usize,
    index: u64,
    records: Vec<RecordVersion>,
    files: Vec<FileVersion>,
    bytes: usize,
    last_record: Option<(Uuid, u64)>,
    last_file: Option<(Uuid, u64)>,
}

impl SegmentBuilder {
    /// A builder for `collection`'s archive at `s0`.
    pub fn new(collection: Uuid, s0: u64, source: ArchiveSource, max_bytes: usize) -> Self {
        Self {
            collection,
            s0,
            source,
            max_bytes: max_bytes.max(1),
            index: 0,
            records: Vec::new(),
            files: Vec::new(),
            bytes: 0,
            last_record: None,
            last_file: None,
        }
    }

    fn header(&self, last: bool) -> SegmentHeader {
        SegmentHeader {
            legacy_collection: self.collection,
            s0: self.s0,
            source: self.source,
            segment: self.index,
            last,
        }
    }

    fn is_empty(&self) -> bool {
        self.records.is_empty() && self.files.is_empty()
    }

    fn flush(&mut self, last: bool) -> PResult<Vec<u8>> {
        let segment = ArchiveSegment {
            header: self.header(last),
            records: std::mem::take(&mut self.records),
            files: std::mem::take(&mut self.files),
        };
        self.bytes = 0;
        self.index += 1;
        segment
            .to_bytes()
            .map_err(|e| invalid(format!("segment encode: {e:?}")))
    }

    fn admit(&mut self, size: usize, record: bool) -> PResult<Option<Vec<u8>>> {
        // Include the envelope and the growing array heads, not just encoded rows.
        // A single oversized row remains allowed in its own segment.
        fn head_bytes(n: usize) -> usize {
            match n as u64 {
                0..=23 => 1,
                24..=255 => 2,
                256..=65535 => 3,
                65536..=4294967295 => 5,
                _ => 9,
            }
        }
        let empty = ArchiveSegment {
            header: self.header(false),
            records: Vec::new(),
            files: Vec::new(),
        }
        .to_bytes()
        .map_err(|e| invalid(format!("segment encode: {e:?}")))?;
        let overhead = empty.len() - 2
            + head_bytes(self.records.len() + usize::from(record))
            + head_bytes(self.files.len() + usize::from(!record));
        let rows = self
            .bytes
            .checked_add(size)
            .ok_or_else(|| invalid("segment too large"))?;
        let encoded = rows
            .checked_add(overhead)
            .ok_or_else(|| invalid("segment too large"))?;
        if !self.is_empty() && encoded > self.max_bytes {
            let out = self.flush(false)?;
            self.bytes = size;
            return Ok(Some(out));
        }
        self.bytes = rows;
        Ok(None)
    }

    /// Add a record version. Returns a finished segment when one was completed.
    pub fn push_record(&mut self, v: RecordVersion) -> PResult<Option<Vec<u8>>> {
        check_version(
            v.sequence,
            self.s0,
            v.deleted,
            v.document.is_some(),
            "record version",
        )?;
        check_order(
            &mut self.last_record,
            v.record_id,
            v.sequence,
            "record versions",
        )?;
        let size = v
            .to_bytes()
            .map_err(|e| invalid(format!("record version encode: {e:?}")))?
            .len();
        let out = self.admit(size, true)?;
        self.records.push(v);
        Ok(out)
    }

    /// Add a file version. Returns a finished segment when one was completed.
    pub fn push_file(&mut self, v: FileVersion) -> PResult<Option<Vec<u8>>> {
        check_file_version(&v, self.s0)?;
        check_order(&mut self.last_file, v.file_id, v.sequence, "file versions")?;
        let size = v
            .to_bytes()
            .map_err(|e| invalid(format!("file version encode: {e:?}")))?
            .len();
        let out = self.admit(size, false)?;
        self.files.push(v);
        Ok(out)
    }

    /// Emit the last segment (always one, even for an empty history, so the archive
    /// is never ambiguous) and the total number of segments.
    pub fn finish(mut self) -> PResult<(Vec<u8>, u64)> {
        let out = self.flush(true)?;
        Ok((out, self.index))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mdbn_wire::common::{B16, B32};

    const CID: Uuid = B16([7; 16]);

    fn rec(n: u8, seq: u64, doc: Option<&str>) -> RecordVersion {
        RecordVersion {
            record_id: B16([n; 16]),
            sequence: seq,
            revision: format!("sha256:{}", "ab".repeat(32)),
            path: Some(format!("notes/{n}.md")),
            document: doc.map(str::to_owned),
            created_at: 1_790_000_000_000 + seq as i64,
            deleted: doc.is_none(),
        }
    }

    fn file(n: u8, seq: u64, live: bool) -> FileVersion {
        FileVersion {
            file_id: B16([0xf0 + n; 16]),
            sequence: seq,
            revision: "r".into(),
            path: Some(format!("att/{n}.png")),
            size: live.then_some(10),
            content_digest: live.then_some(B32([1; 32])),
            created_at: 1_790_000_000_000,
            deleted: !live,
            content: None,
        }
    }

    #[test]
    fn segments_are_bounded_ordered_and_round_trip() {
        let mut b = SegmentBuilder::new(CID, 10, ArchiveSource::HostedProvider, 300);
        let mut segments = Vec::new();
        let versions = [
            rec(1, 1, Some("# a\n")),
            rec(1, 2, None),
            rec(2, 3, Some(&"x".repeat(500))),
        ];
        for v in versions.iter().cloned() {
            if let Some(s) = b.push_record(v).unwrap() {
                segments.push(s);
            }
        }
        segments.push(b.push_file(file(1, 4, true)).unwrap().unwrap_or_default());
        segments.retain(|s| !s.is_empty());
        let (last, n) = b.finish().unwrap();
        segments.push(last);
        assert_eq!(n as usize, segments.len());
        assert!(
            n >= 3,
            "a 500-byte version exceeds the 300-byte bound and gets its own segment"
        );
        let mut all_records = Vec::new();
        let mut all_files = Vec::new();
        for (i, s) in segments.iter().enumerate() {
            let seg = decode_segment(s).unwrap();
            assert_eq!(seg.header.segment, i as u64);
            assert_eq!(seg.header.last, i + 1 == segments.len());
            assert_eq!(seg.header.legacy_collection, CID);
            assert_eq!(seg.header.s0, 10);
            all_records.extend(seg.records);
            all_files.extend(seg.files);
        }
        assert_eq!(
            all_records,
            versions.to_vec(),
            "every version, exact, in order"
        );
        assert_eq!(all_files, vec![file(1, 4, true)]);
    }

    #[test]
    fn bound_includes_segment_envelope_and_array_heads() {
        // Small rows exercise the array-head transition at 24, in both lists.
        let mut b = SegmentBuilder::new(CID, 100, ArchiveSource::HostedProvider, 4000);
        let mut segments = Vec::new();
        for seq in 1..=40 {
            if let Some(s) = b.push_record(rec(1, seq, None)).unwrap() {
                segments.push(s);
            }
        }
        for seq in 1..=40 {
            if let Some(s) = b.push_file(file(1, seq, false)).unwrap() {
                segments.push(s);
            }
        }
        segments.push(b.finish().unwrap().0);
        let mut count = 0;
        for bytes in segments {
            assert!(
                bytes.len() <= 4000,
                "the complete plaintext obeys the bound"
            );
            let segment = decode_segment(&bytes).unwrap();
            count += segment.records.len() + segment.files.len();
        }
        assert_eq!(count, 80);
    }

    #[test]
    fn deleted_file_metadata_is_absent_in_builder_and_decoder() {
        for digest in [false, true] {
            let mut f = file(1, 1, false);
            if digest {
                f.content_digest = Some(B32([1; 32]));
            } else {
                f.size = Some(10);
            }
            let mut b = SegmentBuilder::new(CID, 1, ArchiveSource::HostedProvider, 4000);
            assert!(b.push_file(f.clone()).is_err());
            let segment = ArchiveSegment {
                header: b.header(true),
                records: Vec::new(),
                files: vec![f],
            };
            assert!(decode_segment(&segment.to_bytes().unwrap()).is_err());
        }
    }

    #[test]
    fn invariants_are_enforced() {
        let mut b =
            SegmentBuilder::new(CID, 5, ArchiveSource::LocalConnector, DEFAULT_SEGMENT_BYTES);
        b.push_record(rec(1, 2, Some("a"))).unwrap();
        assert!(
            b.push_record(rec(1, 2, Some("b"))).is_err(),
            "same (id, sequence)"
        );
        assert!(
            b.push_record(rec(1, 1, Some("b"))).is_err(),
            "going backwards"
        );
        assert!(b.push_record(rec(2, 6, Some("b"))).is_err(), "beyond s0");
        assert!(b.push_record(rec(2, 0, Some("b"))).is_err(), "sequence 0");
        let mut bad = rec(2, 3, None);
        bad.deleted = false;
        assert!(b.push_record(bad).is_err(), "live without a document");
        let mut bad = file(1, 3, false);
        bad.content = Some(BlobRef {
            plain_hash: B32([0; 32]),
            size: 0,
            blob_id: B32([0; 32]),
            id_epoch: 1,
            part_size: 1,
        });
        assert!(b.push_file(bad).is_err(), "deleted file version with bytes");
        let (last, n) = b.finish().unwrap();
        assert_eq!(n, 1);
        let seg = decode_segment(&last).unwrap();
        assert!(seg.header.last);
        assert_eq!(seg.records.len(), 1);
        // A tampered segment (order broken) is refused on decode.
        let mut seg2 = seg.clone();
        seg2.records.push(rec(0, 1, Some("z")));
        assert!(decode_segment(&seg2.to_bytes().unwrap()).is_err());
        assert!(decode_segment(b"garbage").is_err());
    }
}
