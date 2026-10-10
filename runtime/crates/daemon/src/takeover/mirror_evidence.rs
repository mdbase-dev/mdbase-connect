//! Immutable mirror-join capture in the daemon's private profile, not ingest authority.
//!
//! This is the pre-install evidence seam. The future driver must obtain the head,
//! complete descriptors and certified checkpoint from authenticated/verified sources,
//! capture actual disk bytes/generation, and preserve original state/journal separately.
//! Reading this file never authenticates those claims, changes disk-known provenance,
//! queues a mutation or unfences a mirror. Effects require fresh proof and guarded consumption.

use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use mdbn_takeover::mirror_join::{self, Base, Decision, MirrorBase, Revisions};
use mdbn_wire::attachment::FileContent;
use mdbn_wire::schema::Wire;
use serde::{Deserialize, Serialize};

const MAX_BYTES: u64 = 16 * 1024 * 1024;

/// A certified checkpoint must not be inferred from a missing row/state file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Checkpoint {
    /// Exact whole plaintext revision accepted at this legacy cursor.
    Present {
        /// Whole plaintext revision.
        hash: [u8; 32],
        /// Certified legacy sequence.
        cursor: u64,
    },
    /// Caller verified complete checkpoint AND namespace absence.
    CertifiedAbsent {
        /// Complete checkpoint sequence.
        cursor: u64,
    },
    /// No trustworthy base evidence; never permission for a fresh create.
    Unavailable,
}

/// Stored semantic kind; no record/oversized-file downcast.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileKind {
    /// Ordinary non-record file.
    Ordinary,
    /// Oversized Markdown, retaining its preserved record ID as a file.
    UnindexedOversizedMarkdown,
}

/// Complete server content, rather than just its digest or a download URL.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Descriptor {
    /// Exact verified record source, including formatting.
    Record {
        /// Complete record source, not a hash-only placeholder.
        source: String,
    },
    /// Canonical FileContent wire bytes retain ALL BlobRef/AttachmentContentV1 fields.
    File {
        /// Stored semantic kind.
        file_kind: FileKind,
        /// Complete canonical descriptor bytes.
        content: Vec<u8>,
    },
}
impl Descriptor {
    /// Retain the complete typed descriptor without inventing a new wire format.
    pub fn file(file_kind: FileKind, content: &FileContent) -> io::Result<Self> {
        Ok(Self::File {
            file_kind,
            content: content
                .to_bytes()
                .map_err(|_| invalid("file descriptor encoding"))?,
        })
    }

    pub(super) fn hash(&self, collection: [u8; 16]) -> io::Result<[u8; 32]> {
        match self {
            Self::Record { source } => {
                if source.len() > 1_048_576 {
                    return Err(invalid("oversized source is not a record descriptor"));
                }
                Ok(mdbn_wire::hash::sha256(source.as_bytes()).0)
            }
            Self::File { file_kind, content } => {
                let decoded = FileContent::from_bytes(content)
                    .map_err(|_| invalid("invalid complete file descriptor"))?;
                if decoded
                    .to_bytes()
                    .map_err(|_| invalid("file descriptor encoding"))?
                    != *content
                {
                    return Err(invalid("noncanonical file descriptor"));
                }
                match &decoded {
                    FileContent::AttachmentV1(a) if a.reference.collection.0 != collection => {
                        return Err(invalid("file descriptor collection mismatch"));
                    }
                    FileContent::Blob(_) if *file_kind == FileKind::UnindexedOversizedMarkdown => {
                        return Err(invalid(
                            "unindexed file requires native attachment descriptor",
                        ));
                    }
                    _ => {}
                }
                Ok(decoded.plain_hash().0)
            }
        }
    }
}

/// An ambiguous legacy action, retained verbatim as evidence, never re-emitted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UnknownOutcome {
    /// Original ID; never reminted or resent by this seam.
    pub mutation_id: String,
    /// Original preserved resource ID.
    pub record_id: String,
    /// Original operation name.
    pub operation: String,
    /// Original destination, if present.
    pub path: Option<String>,
}

/// One immutable capture. No progress/success/authorization flag is stored here.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Evidence {
    /// Only schema 1 is understood.
    pub schema_version: u32,
    /// New collection identity.
    pub collection: [u8; 16],
    /// Legacy identity must be preserved exactly.
    pub legacy_collection: [u8; 16],
    /// The stopped old mirror, not the new replica identity.
    pub legacy_replica: [u8; 16],
    /// None only for a fresh, not-yet-minted candidate.
    pub resource_id: Option<[u8; 16]>,
    /// Drained legacy head certified by the migration record.
    pub s_final: u64,
    /// Cutover policy position C.
    pub cutover_seq: u64,
    /// Verified drain barrier F, distinct from C.
    pub barrier_f: u64,
    /// Final migration state digest.
    pub final_digest: [u8; 32],
    /// Actual verified installed head, at or past F.
    pub verified_seq: u64,
    /// Chain of that verified head.
    pub verified_chain: [u8; 32],
    /// Distinct base/absence/unavailable evidence.
    pub checkpoint: Checkpoint,
    /// Legacy path; never substituted for ID lookup.
    pub old_path: String,
    /// Resolved new path at the verified head.
    pub resolved_path: String,
    /// Complete verified server content, or verified absence.
    pub server: Option<Descriptor>,
    /// Actual captured whole bytes; never a synthetic server revision.
    pub observed: Option<[u8; 32]>,
    /// Host source generation must be rechecked against a fresh observation.
    pub source_generation: u64,
    /// Only read-write mirrors propose local deletion.
    pub read_write: bool,
    /// Original ambiguous legacy actions remain unknown outcomes.
    pub unknown_outcomes: Vec<UnknownOutcome>,
}
impl std::fmt::Debug for Evidence {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Evidence")
            .field("schema_version", &self.schema_version)
            .field("verified_seq", &self.verified_seq)
            .field("source_generation", &self.source_generation)
            .field("unknown_outcomes", &self.unknown_outcomes.len())
            .finish_non_exhaustive()
    }
}
impl Evidence {
    fn validate(&self) -> io::Result<()> {
        if self.schema_version != 1
            || self.collection != self.legacy_collection
            || self.collection == [0; 16]
            || self.legacy_replica == [0; 16]
            || self.resource_id == Some([0; 16])
            || self.cutover_seq == 0
            || self.cutover_seq > self.barrier_f
            || self.verified_seq < self.barrier_f
            || self.unknown_outcomes.len() > 10_000
        {
            return Err(invalid("invalid mirror capture metadata"));
        }
        for p in [&self.old_path, &self.resolved_path] {
            mdbn_core::paths::check_path(p).map_err(|_| invalid("nonportable mirror path"))?;
        }
        if self.server.is_some() && self.resource_id.is_none() {
            return Err(invalid("server descriptor needs preserved ID"));
        }
        if let Some(s) = &self.server {
            s.hash(self.collection)?;
        }
        Ok(())
    }

    /// A diagnostic proposal only. A loaded capture cannot authorize this action.
    pub fn decision(&self) -> io::Result<Decision> {
        self.validate()?;
        let base = match self.checkpoint {
            Checkpoint::Present { hash, cursor } => Base::Present(MirrorBase { hash, cursor }),
            Checkpoint::CertifiedAbsent { cursor } => Base::Absent { cursor },
            Checkpoint::Unavailable => Base::Unavailable,
        };
        Ok(mirror_join::classify(Revisions {
            base,
            s_final: self.s_final,
            server: self
                .server
                .as_ref()
                .map(|s| s.hash(self.collection))
                .transpose()?,
            local: self.observed,
            unresolved_outcome: !self.unknown_outcomes.is_empty(),
            read_write: self.read_write,
        }))
    }

    /// Compare all fields, including descriptor context, head, path and generation.
    /// The future caller must authenticate `fresh`; this is not an authority check.
    pub fn same_capture(&self, fresh: &Self) -> bool {
        self == fresh
    }

    /// Missing is distinct from torn, oversized, untrusted or future-schema data.
    pub fn load(path: &Path) -> io::Result<Option<Self>> {
        match fs::symlink_metadata(path) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e),
            Ok(m) if !m.is_file() => return Err(invalid("capture is not a regular file")),
            Ok(_) => crate::fsutil::verify_owner_only(path)?,
        }
        let mut bytes = Vec::new();
        fs::File::open(path)?
            .take(MAX_BYTES + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_BYTES {
            return Err(invalid("mirror capture too large"));
        }
        let capture: Self =
            serde_json::from_slice(&bytes).map_err(|_| invalid("malformed mirror capture"))?;
        capture.validate()?;
        Ok(Some(capture))
    }

    /// Immutable, no-replace publication ONLY in the daemon's private state.
    /// Conflicting ID reuse and corrupt files are preserved, never rewritten.
    /// Retry after an unknown result re-syncs the SAME exact capture.
    pub fn persist(&self, state_dir: &Path, capture_id: [u8; 16]) -> io::Result<PathBuf> {
        self.persist_with(state_dir, capture_id, |_| Ok(()))
    }

    fn persist_with(
        &self,
        state_dir: &Path,
        capture_id: [u8; 16],
        mut boundary: impl FnMut(Boundary) -> io::Result<()>,
    ) -> io::Result<PathBuf> {
        self.validate()?;
        if capture_id == [0; 16] || !state_dir.is_absolute() {
            return Err(invalid("invalid private capture location"));
        }
        let dir = state_dir.join("mirror-join");
        crate::fsutil::ensure_private_dir(&dir)?;
        let path = dir.join(format!("{}.json", crate::secrets::uuid_string(&capture_id)));
        if let Some(existing) = Self::load(&path)? {
            if existing != *self {
                return Err(invalid("conflicting immutable mirror capture"));
            }
            fs::File::open(&path)?.sync_all()?;
            crate::fsutil::sync_dir(&dir)?;
            return Ok(path);
        }
        let bytes = serde_json::to_vec(self).map_err(|_| invalid("capture encoding"))?;
        if bytes.len() as u64 > MAX_BYTES {
            return Err(invalid("mirror capture too large"));
        }
        // Random create-new stage. No predictable-name cleanup or replacement.
        let stage_id = crate::secrets::new_uuid().map_err(io::Error::other)?;
        let stage = dir.join(format!(".capture-{stage_id}"));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&stage)?;
        boundary(Boundary::Created)?;
        file.write_all(&bytes)?;
        boundary(Boundary::Written)?;
        file.sync_all()?;
        boundary(Boundary::Synced)?;
        match fs::hard_link(&stage, &path) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                if Self::load(&path)?.as_ref() != Some(self) {
                    return Err(invalid("conflicting immutable mirror capture"));
                }
                fs::File::open(&path)?.sync_all()?;
            }
            Err(e) => return Err(e),
        }
        boundary(Boundary::Linked)?;
        crate::fsutil::sync_dir(&dir)?;
        boundary(Boundary::Durable)?;
        // Only OUR successfully created stage is removed, after final durability.
        fs::remove_file(&stage)?;
        crate::fsutil::sync_dir(&dir)?;
        Ok(path)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Boundary {
    Created,
    Written,
    Synced,
    Linked,
    Durable,
}
fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use mdbn_wire::attachment::{AttachmentContentV1, AttachmentRefV1};
    use mdbn_wire::common::{B16, B32};

    fn capture_id() -> [u8; 16] {
        let mut id = [0; 16];
        getrandom::fill(&mut id).unwrap();
        id
    }

    fn capture() -> Evidence {
        let source = "---\ntitle: base\n---\n".to_owned();
        let hash = mdbn_wire::hash::sha256(source.as_bytes()).0;
        Evidence {
            schema_version: 1,
            collection: [1; 16],
            legacy_collection: [1; 16],
            legacy_replica: [2; 16],
            resource_id: Some([3; 16]),
            s_final: 7,
            cutover_seq: 4,
            barrier_f: 9,
            final_digest: [4; 32],
            verified_seq: 9,
            verified_chain: [5; 32],
            checkpoint: Checkpoint::Present { hash, cursor: 6 },
            old_path: "old.md".into(),
            resolved_path: "renamed.md".into(),
            server: Some(Descriptor::Record { source }),
            observed: Some([6; 32]),
            source_generation: 17,
            read_write: true,
            unknown_outcomes: Vec::new(),
        }
    }
    #[test]
    fn queued_edit_retains_actual_hash_not_server_known_state() {
        let dir = crate::testutil::TestDir::new("mirror-evidence");
        let e = capture();
        let path = e.persist(dir.path(), capture_id()).unwrap();
        let reopened = Evidence::load(&path).unwrap().unwrap();
        assert_eq!(reopened, e);
        match reopened.decision().unwrap() {
            Decision::ExternalEdit { actual, .. } => assert_eq!(actual, [6; 32]),
            other => panic!("unexpected classification {other:?}"),
        }
        assert_eq!(reopened.observed, Some([6; 32]));
    }
    #[test]
    fn every_crash_boundary_retries_same_id_without_removing_other_evidence() {
        for fail in [
            Boundary::Created,
            Boundary::Written,
            Boundary::Synced,
            Boundary::Linked,
            Boundary::Durable,
        ] {
            let dir = crate::testutil::TestDir::new("mirror-evidence-crash");
            let e = capture();
            let id = capture_id();
            let parent = dir.path().join("mirror-join");
            crate::fsutil::ensure_private_dir(&parent).unwrap();
            let unrelated = parent.join(".capture-previous-crash");
            fs::write(&unrelated, b"retain").unwrap();
            assert!(
                e.persist_with(dir.path(), id, |b| if b == fail {
                    Err(io::Error::other("simulated interruption"))
                } else {
                    Ok(())
                })
                .is_err()
            );
            let path = e.persist(dir.path(), id).unwrap();
            assert_eq!(Evidence::load(&path).unwrap().unwrap(), e);
            assert_eq!(fs::read(&unrelated).unwrap(), b"retain");
        }
    }
    #[test]
    fn conflicting_reuse_and_torn_capture_never_replace_bytes() {
        let dir = crate::testutil::TestDir::new("mirror-evidence-conflict");
        let e = capture();
        let id = capture_id();
        let path = e.persist(dir.path(), id).unwrap();
        let before = fs::read(&path).unwrap();
        let mut changed = e.clone();
        changed.source_generation += 1;
        assert!(changed.persist(dir.path(), id).is_err());
        assert_eq!(fs::read(&path).unwrap(), before);
        fs::write(&path, b"{").unwrap();
        assert!(Evidence::load(&path).is_err());
        assert!(e.persist(dir.path(), id).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"{");
    }
    #[test]
    fn unknown_and_future_checkpoint_evidence_survives_reopen() {
        let dir = crate::testutil::TestDir::new("mirror-evidence-unknown");
        let mut e = capture();
        e.unknown_outcomes.push(UnknownOutcome {
            mutation_id: "original-id".into(),
            record_id: "original-record".into(),
            operation: "put".into(),
            path: Some("old.md".into()),
        });
        let path = e.persist(dir.path(), capture_id()).unwrap();
        let mut reopened = Evidence::load(&path).unwrap().unwrap();
        assert_eq!(reopened.decision().unwrap(), Decision::UnknownOutcome);
        assert_eq!(reopened.unknown_outcomes, e.unknown_outcomes);
        reopened.unknown_outcomes.clear();
        reopened.checkpoint = Checkpoint::Present {
            hash: [7; 32],
            cursor: 8,
        };
        assert_eq!(reopened.decision().unwrap(), Decision::FutureBase);
        reopened.checkpoint = Checkpoint::Unavailable;
        assert_eq!(reopened.decision().unwrap(), Decision::UnknownBase);
    }
    #[test]
    fn complete_attachment_context_and_kind_are_not_downcast_or_hash_only() {
        let mut e = capture();
        let full = FileContent::AttachmentV1(AttachmentContentV1 {
            reference: AttachmentRefV1 {
                collection: B16(e.collection),
                key_epoch: 3,
                attachment_id: B32([8; 32]),
                manifest_cipher_hash: B32([9; 32]),
            },
            whole_plain_hash: B32([10; 32]),
            total_plain_bytes: 1_100_000,
        });
        e.server = Some(Descriptor::file(FileKind::UnindexedOversizedMarkdown, &full).unwrap());
        e.validate().unwrap();
        let mut changed = e.clone();
        let mut other = full.clone();
        if let FileContent::AttachmentV1(a) = &mut other {
            a.reference.manifest_cipher_hash = B32([11; 32]);
        }
        changed.server =
            Some(Descriptor::file(FileKind::UnindexedOversizedMarkdown, &other).unwrap());
        assert!(!e.same_capture(&changed));
        changed = e.clone();
        changed.verified_chain[0] ^= 1;
        assert!(!e.same_capture(&changed));
        changed = e.clone();
        changed.resolved_path = "other.md".into();
        assert!(!e.same_capture(&changed));
        changed = e.clone();
        changed.source_generation += 1;
        assert!(!e.same_capture(&changed));
    }
    #[test]
    fn identical_concurrent_capture_has_one_immutable_result() {
        let dir = crate::testutil::TestDir::new("mirror-evidence-race");
        let e = capture();
        let id = capture_id();
        let joins: Vec<_> = (0..4)
            .map(|_| {
                let e = e.clone();
                let root = dir.path().to_owned();
                std::thread::spawn(move || e.persist(&root, id).unwrap())
            })
            .collect();
        let paths: Vec<_> = joins.into_iter().map(|j| j.join().unwrap()).collect();
        assert!(paths.iter().all(|p| p == &paths[0]));
        assert_eq!(Evidence::load(&paths[0]).unwrap().unwrap(), e);
    }

    #[test]
    fn matching_and_absence_are_distinct_from_unavailable_provenance() {
        let mut e = capture();
        e.observed = e.server.as_ref().map(|d| d.hash(e.collection).unwrap());
        assert_eq!(
            e.decision().unwrap(),
            Decision::Matching {
                actual: e.observed.unwrap()
            }
        );
        e.server = None;
        e.resource_id = None;
        e.checkpoint = Checkpoint::Unavailable;
        assert_eq!(e.decision().unwrap(), Decision::UnknownBase);
        e.checkpoint = Checkpoint::CertifiedAbsent { cursor: 6 };
        assert_eq!(
            e.decision().unwrap(),
            Decision::ExternalCreate {
                actual: e.observed.unwrap()
            }
        );
    }

    #[test]
    fn ordinary_storage_errors_do_not_become_success_or_missing() {
        let dir = crate::testutil::TestDir::new("mirror-evidence-io");
        fs::write(dir.path().join("mirror-join"), b"not a directory").unwrap();
        assert!(capture().persist(dir.path(), capture_id()).is_err());
        assert_eq!(
            fs::read(dir.path().join("mirror-join")).unwrap(),
            b"not a directory"
        );
    }

    #[test]
    fn unsupported_schema_and_collection_descriptor_drift_fail_closed() {
        let mut e = capture();
        e.schema_version = 2;
        assert!(e.decision().is_err());
        e = capture();
        e.legacy_collection = [4; 16];
        assert!(e.decision().is_err());
        e = capture();
        e.resolved_path = "../outside.md".into();
        assert!(e.decision().is_err());
        e = capture();
        e.server = Some(Descriptor::File {
            file_kind: FileKind::Ordinary,
            content: vec![0],
        });
        assert!(e.decision().is_err());
    }
}
