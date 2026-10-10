//! The `base` item of generation 0 (`snapshot.md` §7): what a generation-0 import
//! supplies ([`Gen0Base`]), how the payload and its item `refs` are built
//! ([`build_base`]), and the payload-level validity checks the import and the future
//! install path apply to a `base` ([`check_base`]).
//!
//! **Pre-history** (field 6, migration): ordered sealed segments of the legacy
//! version-history archive. They are ordinary sealed blobs that the replica never
//! reads: opaque to replay, apply, policy and indexing. Every segment's part
//! addresses are in the item's `refs`, so the log service retains them like the
//! manifest. A base with more than [`MAX_PREHISTORY_SEGMENTS`] segments, or a segment
//! part missing from `refs`, is refused at import and install time. Nothing here is a
//! log verdict: a replica that cannot install a base stalls before it (`apply.rs`).

use std::fmt;

use mdbn_wire::common::{B32, Hash, Uuid};
use mdbn_wire::intent::BlobRef;
pub use mdbn_wire::snapshot::MAX_PREHISTORY_SEGMENTS;
use mdbn_wire::snapshot::{BasePayload, BaseSource};

use crate::crypto::blob::validate_blob_ref;

/// What a generation-0 import supplies for the `base` item. The manifest and the
/// segments are already sealed and uploaded; the adopting replica adds its own ID.
#[derive(Debug, Clone, PartialEq)]
pub struct Gen0Base {
    /// Address of the generation-0 manifest.
    pub manifest: B32,
    /// The manifest's state digest.
    pub state_digest: Hash,
    /// Where the state came from.
    pub source: BaseSource,
    /// The Connect collection imported (migration).
    pub legacy_collection: Option<Uuid>,
    /// Pre-history archive segments, in order (migration), or none.
    pub prehistory: Option<Vec<BlobRef>>,
}

impl Gen0Base {
    /// A base for `manifest` with no legacy collection and no pre-history.
    pub fn new(manifest: B32, state_digest: Hash, source: BaseSource) -> Gen0Base {
        Gen0Base {
            manifest,
            state_digest,
            source,
            legacy_collection: None,
            prehistory: None,
        }
    }

    /// Name the Connect collection this base imports.
    pub fn legacy_collection(mut self, collection: Uuid) -> Gen0Base {
        self.legacy_collection = Some(collection);
        self
    }

    /// Attach the pre-history archive segments (an empty list means none).
    pub fn prehistory(mut self, segments: Vec<BlobRef>) -> Gen0Base {
        self.prehistory = (!segments.is_empty()).then_some(segments);
        self
    }
}

/// Why a `base` payload is refused at import or install time (`snapshot.md` §7).
/// [`BaseError::PrehistoryKeyMissing`] is transient: the key of the segment's epoch
/// is not held yet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BaseError {
    /// The manifest is not in the item's `refs`.
    ManifestNotInRefs,
    /// More than [`MAX_PREHISTORY_SEGMENTS`] segments.
    TooManyPrehistorySegments {
        /// How many the payload carries.
        count: usize,
    },
    /// A segment's blob reference is malformed.
    PrehistorySegmentMalformed {
        /// Index of the segment in field 6.
        index: usize,
    },
    /// The key of a segment's `id_epoch` is not held, so its part addresses are
    /// unknown.
    PrehistoryKeyMissing {
        /// Index of the segment in field 6.
        index: usize,
        /// Its `id_epoch`.
        epoch: u64,
    },
    /// A segment's part address is missing from the item's `refs`.
    PrehistoryPartNotInRefs {
        /// Index of the segment in field 6.
        index: usize,
        /// Index of the part within the segment.
        part: u64,
    },
}

impl BaseError {
    /// A stable rule identifier for reports.
    pub fn rule(&self) -> &'static str {
        match self {
            BaseError::ManifestNotInRefs => "base: manifest not in refs",
            BaseError::TooManyPrehistorySegments { .. } => "base: too many prehistory segments",
            BaseError::PrehistorySegmentMalformed { .. } => "base: prehistory segment malformed",
            BaseError::PrehistoryKeyMissing { .. } => "base: prehistory segment key missing",
            BaseError::PrehistoryPartNotInRefs { .. } => "base: prehistory part not in refs",
        }
    }
}

impl fmt::Display for BaseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            BaseError::ManifestNotInRefs => f.write_str("manifest not in refs"),
            BaseError::TooManyPrehistorySegments { count } => write!(
                f,
                "{count} prehistory segments, at most {MAX_PREHISTORY_SEGMENTS}"
            ),
            BaseError::PrehistorySegmentMalformed { index } => {
                write!(f, "prehistory segment {index}: malformed blob reference")
            }
            BaseError::PrehistoryKeyMissing { index, epoch } => {
                write!(f, "prehistory segment {index}: no key for epoch {epoch}")
            }
            BaseError::PrehistoryPartNotInRefs { index, part } => {
                write!(f, "prehistory segment {index} part {part}: not in refs")
            }
        }
    }
}

impl std::error::Error for BaseError {}

/// The keyed part addresses of a blob, or `None` when the key of its `id_epoch` is
/// not held ([`crate::seal::Sealer::blob_part_addresses`]).
pub type PartAddresses<'a> = dyn Fn(&BlobRef) -> Option<Vec<B32>> + 'a;

/// Build the `base` payload for `spec` adopted by `adopter`, and the `refs` of its
/// item: the manifest and every pre-history segment's part addresses, sorted and
/// deduplicated. Refuses more than [`MAX_PREHISTORY_SEGMENTS`] segments, a malformed
/// segment reference, or a segment whose epoch key is not held.
pub fn build_base(
    adopter: Uuid,
    spec: &Gen0Base,
    parts: &PartAddresses<'_>,
) -> Result<(BasePayload, Vec<B32>), BaseError> {
    let payload = BasePayload {
        manifest: spec.manifest,
        state_digest: spec.state_digest,
        adopter,
        source: spec.source,
        legacy_collection: spec.legacy_collection,
        prehistory: spec.prehistory.as_ref().filter(|s| !s.is_empty()).cloned(),
    };
    let mut refs = vec![payload.manifest];
    for (index, seg) in segments(&payload)?.iter().enumerate() {
        refs.extend(segment_parts(index, seg, parts)?);
    }
    refs.sort();
    refs.dedup();
    Ok((payload, refs))
}

/// Payload-level validity of a `base` whose item carries `refs` (`snapshot.md` §7):
/// the manifest is in `refs`, there are at most [`MAX_PREHISTORY_SEGMENTS`] segments,
/// and `refs` holds every part address of every segment. Nothing here reads a
/// segment.
pub fn check_base(
    payload: &BasePayload,
    refs: &[B32],
    parts: &PartAddresses<'_>,
) -> Result<(), BaseError> {
    if !refs.contains(&payload.manifest) {
        return Err(BaseError::ManifestNotInRefs);
    }
    for (index, seg) in segments(payload)?.iter().enumerate() {
        for (part, address) in segment_parts(index, seg, parts)?.into_iter().enumerate() {
            if !refs.contains(&address) {
                return Err(BaseError::PrehistoryPartNotInRefs {
                    index,
                    part: part as u64,
                });
            }
        }
    }
    Ok(())
}

fn segments(payload: &BasePayload) -> Result<&[BlobRef], BaseError> {
    let segs = payload.prehistory.as_deref().unwrap_or(&[]);
    if segs.len() > MAX_PREHISTORY_SEGMENTS {
        return Err(BaseError::TooManyPrehistorySegments { count: segs.len() });
    }
    Ok(segs)
}

fn segment_parts(
    index: usize,
    seg: &BlobRef,
    parts: &PartAddresses<'_>,
) -> Result<Vec<B32>, BaseError> {
    if validate_blob_ref(seg).is_err() {
        return Err(BaseError::PrehistorySegmentMalformed { index });
    }
    parts(seg).ok_or(BaseError::PrehistoryKeyMissing {
        index,
        epoch: seg.id_epoch,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use mdbn_wire::common::B16;
    use mdbn_wire::hash::h;

    fn seg(i: u8, size: u64) -> BlobRef {
        BlobRef {
            plain_hash: mdbn_wire::hash::sha256(&[i]),
            size,
            blob_id: B32([i; 32]),
            id_epoch: 1,
            part_size: 8 << 20,
        }
    }

    /// Deterministic test addresses: `H(blob_id ‖ i)`.
    fn parts(b: &BlobRef) -> Option<Vec<B32>> {
        Some(
            (0..b.part_count())
                .map(|i| {
                    let mut m = b.blob_id.0.to_vec();
                    m.extend_from_slice(&(i as u32).to_be_bytes());
                    h("test/part", &m)
                })
                .collect(),
        )
    }

    fn spec(segs: Vec<BlobRef>) -> Gen0Base {
        Gen0Base::new(B32([0xa2; 32]), B32([0xd0; 32]), BaseSource::HostedImport)
            .legacy_collection(B16([0x4c; 16]))
            .prehistory(segs)
    }

    #[test]
    fn build_lists_manifest_and_every_part_in_refs() {
        let (p, refs) = build_base(
            B16([9; 16]),
            &spec(vec![seg(1, 20 << 20), seg(2, 10)]),
            &parts,
        )
        .unwrap();
        assert_eq!(p.prehistory.as_ref().map(Vec::len), Some(2));
        assert_eq!(p.legacy_collection, Some(B16([0x4c; 16])));
        // manifest + 3 parts + 1 part
        assert_eq!(refs.len(), 5);
        assert!(refs.contains(&B32([0xa2; 32])));
        assert!(refs.windows(2).all(|w| w[0] < w[1]), "sorted and unique");
        assert_eq!(check_base(&p, &refs, &parts), Ok(()));
    }

    #[test]
    fn no_prehistory_builds_the_plain_base() {
        let (p, refs) = build_base(B16([9; 16]), &spec(vec![]), &parts).unwrap();
        assert_eq!(p.prehistory, None);
        assert_eq!(refs, vec![B32([0xa2; 32])]);
        let (p, _) = build_base(
            B16([9; 16]),
            &Gen0Base::new(B32([0xa2; 32]), B32([0xd0; 32]), BaseSource::Folder),
            &parts,
        )
        .unwrap();
        assert_eq!((p.prehistory, p.legacy_collection), (None, None));
    }

    #[test]
    fn a_part_missing_from_refs_is_refused() {
        let (p, mut refs) =
            build_base(B16([9; 16]), &spec(vec![seg(1, 20 << 20)]), &parts).unwrap();
        let last = parts(&p.prehistory.as_ref().unwrap()[0]).unwrap()[2];
        refs.retain(|r| *r != last);
        assert_eq!(
            check_base(&p, &refs, &parts),
            Err(BaseError::PrehistoryPartNotInRefs { index: 0, part: 2 })
        );
        assert_eq!(
            check_base(&p, &[], &parts),
            Err(BaseError::ManifestNotInRefs)
        );
    }

    #[test]
    fn sixty_five_segments_are_refused_on_both_sides() {
        let segs: Vec<BlobRef> = (0..65).map(|i| seg(i, 10)).collect();
        assert_eq!(
            build_base(B16([9; 16]), &spec(segs.clone()), &parts),
            Err(BaseError::TooManyPrehistorySegments { count: 65 })
        );
        let (mut p, refs) = build_base(
            B16([9; 16]),
            &spec(segs[..MAX_PREHISTORY_SEGMENTS].to_vec()),
            &parts,
        )
        .unwrap();
        assert_eq!(check_base(&p, &refs, &parts), Ok(()));
        p.prehistory.as_mut().unwrap().push(seg(65, 10));
        assert_eq!(
            check_base(&p, &refs, &parts),
            Err(BaseError::TooManyPrehistorySegments { count: 65 })
        );
    }

    #[test]
    fn malformed_and_unkeyed_segments() {
        let mut bad = seg(1, 10);
        bad.part_size = 1;
        let (p, refs) = build_base(B16([9; 16]), &spec(vec![seg(2, 10)]), &parts).unwrap();
        let mut p2 = p.clone();
        p2.prehistory = Some(vec![bad]);
        assert_eq!(
            check_base(&p2, &refs, &parts),
            Err(BaseError::PrehistorySegmentMalformed { index: 0 })
        );
        let no_key = |_: &BlobRef| None;
        assert_eq!(
            check_base(&p, &refs, &no_key),
            Err(BaseError::PrehistoryKeyMissing { index: 0, epoch: 1 })
        );
        assert_eq!(
            BaseError::PrehistoryKeyMissing { index: 0, epoch: 1 }.rule(),
            "base: prehistory segment key missing"
        );
    }
}
