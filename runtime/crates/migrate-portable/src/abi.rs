//! The preflight over a canonical-CBOR description of one consistent legacy read, for
//! a WASM export (`mig_resolve`, in the hosted Worker module) and any non-Rust importer.
//! Metadata only.
//!
//! Input: [`Read`] (`rows.rs`). Output: [`Outcome`], a tagged union:
//! - `1` [`Resolved`]: rows in input order, renamed where needed, plus every rename;
//! - `2` [`Report`]: the complete path report (invalid paths and collisions) when the
//!   read cannot be imported without review;
//! - `3` [`Failed`]: the input could not be decoded, or an ID was malformed.
//!
//! The report carries names because the importer must show them for review; this
//! crate never logs them.
//!
//! [`prehistory_segment`] canonicalises and validates one pre-history archive segment
//! (`mdbn-hosted-worker` `mig_prehistory_segment`): the Worker builds the segment's rows from
//! the versions page, this returns the exact bytes to seal, or why it is malformed.

use mdbn_wire::common::Bytes;
use mdbn_wire::schema::Wire;
use mdbn_wire::{wire_enum, wire_struct, wire_union};

use crate::Error;
use crate::preflight::{self, EntityKind, PathEntity};
use crate::rows::{FileRow, Read, RecordRow, ResourceRow};

wire_enum! {
    /// [`EntityKind`] on the wire.
    pub enum Kind {
        /// A resource.
        Resource = 0,
        /// A record.
        Record = 1,
        /// A file.
        File = 2,
    }
}

impl From<EntityKind> for Kind {
    fn from(k: EntityKind) -> Self {
        match k {
            EntityKind::Resource => Self::Resource,
            EntityKind::Record => Self::Record,
            EntityKind::File => Self::File,
        }
    }
}

wire_struct! {
    /// A row's identity and original name.
    pub struct Entity {
        /// Kind.
        1 req kind: Kind,
        /// Legacy ID; resources have none.
        2 opt id: String,
        /// Original collection-relative path.
        3 req path: String,
    }
}

impl From<&PathEntity> for Entity {
    fn from(e: &PathEntity) -> Self {
        Self {
            kind: e.kind.into(),
            id: e.id.clone(),
            path: e.path.clone(),
        }
    }
}

wire_struct! {
    /// One rename the import makes.
    pub struct Rename {
        /// The entity, with its original path.
        1 req entity: Entity,
        /// The new, portable, collision-free path.
        2 req to: String,
        /// The core policy's reason code, or `collision`.
        3 req reason: String,
        /// Inside a known tool/configuration directory: report separately.
        4 req tool_folder: bool,
    }
}

wire_struct! {
    /// A path the policy refuses.
    pub struct Invalid {
        /// The entity.
        1 req entity: Entity,
        /// The core policy's reason code.
        2 req reason: String,
    }
}

wire_struct! {
    /// All rows claiming one normalized path.
    pub struct Collision {
        /// The NFC/case-folded comparison key.
        1 req path_key: String,
        /// Every claimant, in deterministic order.
        2 req entities: Vec<Entity>,
    }
}

wire_struct! {
    /// Every path portable and unique after renames.
    pub struct Resolved {
        /// Resources, renamed where needed, in input order.
        1 req resources: Vec<ResourceRow>,
        /// Records, renamed where needed, in input order.
        2 req records: Vec<RecordRow>,
        /// Files, renamed where needed, in input order.
        3 req files: Vec<FileRow>,
        /// Every rename, in entity order; each must be reported.
        4 req renames: Vec<Rename>,
    }
}

wire_struct! {
    /// The read needs review: the complete report.
    pub struct Report {
        /// Non-portable paths.
        1 req invalid: Vec<Invalid>,
        /// Colliding paths.
        2 req collisions: Vec<Collision>,
    }
}

wire_struct! {
    /// The input could not be processed.
    pub struct Failed {
        /// Why; never content.
        1 req error: String,
    }
}

wire_union! {
    /// The result of [`resolve`].
    pub enum Outcome {
        /// Importable after the listed renames.
        1 => Resolved(Resolved),
        /// Needs review.
        2 => Report(Report),
        /// Could not be processed.
        3 => Failed(Failed),
    }
}

wire_struct! {
    /// A canonical pre-history segment, ready to seal.
    pub struct SegmentBytes {
        /// The segment's canonical CBOR (`prehistory::ArchiveSegment`, validated).
        1 req bytes: Bytes,
    }
}

wire_union! {
    /// The result of [`prehistory_segment`].
    pub enum SegmentOutcome {
        /// Canonical bytes to seal.
        1 => Segment(SegmentBytes),
        /// The segment is malformed or breaks the archive invariants.
        2 => Failed(Failed),
    }
}

/// Validate one pre-history segment given as (any) CBOR encoding of
/// `prehistory::ArchiveSegment` and return its canonical bytes, for the Worker import
/// to seal (`prehistory::decode_segment` is the exact check a reader applies).
pub fn prehistory_segment(input: &[u8]) -> Vec<u8> {
    let out = match crate::prehistory::decode_segment(input) {
        Ok(seg) => match seg.to_bytes() {
            Ok(bytes) => SegmentOutcome::Segment(SegmentBytes {
                bytes: Bytes(bytes),
            }),
            Err(e) => SegmentOutcome::Failed(Failed {
                error: format!("segment encode: {e:?}"),
            }),
        },
        Err(e) => SegmentOutcome::Failed(Failed {
            error: e.to_string(),
        }),
    };
    out.to_bytes().unwrap_or_default()
}

/// Run [`preflight::resolve`] over `read`.
pub fn resolve(read: &Read) -> Outcome {
    match preflight::resolve(&read.resources, &read.records, &read.files) {
        Ok(resolved) => Outcome::Resolved(Resolved {
            resources: resolved.resources().to_vec(),
            records: resolved.records().to_vec(),
            files: resolved.files().to_vec(),
            renames: resolved
                .renames()
                .iter()
                .map(|r| Rename {
                    entity: Entity::from(&r.entity),
                    to: r.to.clone(),
                    reason: r.reason.to_owned(),
                    tool_folder: r.tool_folder,
                })
                .collect(),
        }),
        Err(Error::Paths(report)) => Outcome::Report(Report {
            invalid: report
                .invalid
                .iter()
                .map(|i| Invalid {
                    entity: Entity::from(&i.entity),
                    reason: i.violation.reason().to_owned(),
                })
                .collect(),
            collisions: report
                .collisions
                .iter()
                .map(|c| Collision {
                    path_key: c.path_key.clone(),
                    entities: c.entities.iter().map(Entity::from).collect(),
                })
                .collect(),
        }),
        Err(e) => Outcome::Failed(Failed {
            error: e.to_string(),
        }),
    }
}

/// [`resolve`] over canonical CBOR: a [`Read`] in, an [`Outcome`] out. A read that
/// does not decode yields `Outcome::Failed`. Encoding these plain values cannot fail.
pub fn resolve_cbor(input: &[u8]) -> Vec<u8> {
    let out = match Read::from_bytes(input) {
        Ok(read) => resolve(&read),
        Err(e) => Outcome::Failed(Failed {
            error: format!("input: {e:?}"),
        }),
    };
    out.to_bytes().unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prehistory_segment_canonicalises_and_validates() {
        use crate::prehistory::{ArchiveSegment, ArchiveSource, RecordVersion, SegmentHeader};
        use mdbn_wire::common::B16;
        let seg = ArchiveSegment {
            header: SegmentHeader {
                legacy_collection: B16([7; 16]),
                s0: 3,
                source: ArchiveSource::HostedProvider,
                segment: 0,
                last: true,
            },
            records: vec![RecordVersion {
                record_id: B16([1; 16]),
                sequence: 2,
                revision: "sha256:x".into(),
                path: Some("notes/a.md".into()),
                document: Some("# a\n".into()),
                created_at: 1,
                deleted: false,
            }],
            files: vec![],
        };
        let canonical = seg.to_bytes().unwrap();
        let SegmentOutcome::Segment(b) =
            SegmentOutcome::from_bytes(&prehistory_segment(&canonical)).unwrap()
        else {
            panic!("expected segment")
        };
        assert_eq!(b.bytes.0, canonical);
        let mut bad = seg.clone();
        bad.records[0].sequence = 9; // beyond s0
        let SegmentOutcome::Failed(f) =
            SegmentOutcome::from_bytes(&prehistory_segment(&bad.to_bytes().unwrap())).unwrap()
        else {
            panic!("expected failed")
        };
        assert!(f.error.contains("sequence"));
        assert!(matches!(
            SegmentOutcome::from_bytes(&prehistory_segment(b"nope")).unwrap(),
            SegmentOutcome::Failed(_)
        ));
    }

    #[test]
    fn cbor_round_trip_and_report() {
        let read = Read {
            resources: vec![ResourceRow {
                path: "mdbase.yaml".into(),
            }],
            records: vec![RecordRow {
                record_id: "0192f0c1-7e1a-7b3c-8d4e-000000000001".into(),
                path: "notes/why?.md".into(),
            }],
            files: vec![],
        };
        let out = Outcome::from_bytes(&resolve_cbor(&read.to_bytes().unwrap())).unwrap();
        let Outcome::Resolved(r) = out else {
            panic!("expected resolved")
        };
        assert_eq!(r.records[0].path, "notes/why_.md");
        assert_eq!(r.renames.len(), 1);
        assert_eq!(r.renames[0].entity.path, "notes/why?.md");
        assert_eq!(r.renames[0].entity.kind, Kind::Record);
        assert_eq!(r.renames[0].reason, "forbidden_character");
        assert!(!r.renames[0].tool_folder);

        let too_long = format!("{}x.png", "a/".repeat(600));
        let read = Read {
            resources: vec![],
            records: vec![],
            files: vec![FileRow {
                file_id: "0192f0c1-7e1a-7b3c-8d4e-0000000000f1".into(),
                path: too_long,
            }],
        };
        let Outcome::Report(rep) =
            Outcome::from_bytes(&resolve_cbor(&read.to_bytes().unwrap())).unwrap()
        else {
            panic!("expected report")
        };
        assert_eq!(rep.invalid.len(), 1);
        assert_eq!(rep.invalid[0].entity.kind, Kind::File);
        assert!(rep.collisions.is_empty());

        let Outcome::Failed(f) = Outcome::from_bytes(&resolve_cbor(b"nonsense")).unwrap() else {
            panic!("expected failed")
        };
        assert!(f.error.starts_with("input:"));
    }
}
