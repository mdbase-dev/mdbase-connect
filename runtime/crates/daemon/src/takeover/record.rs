//! The durable local-takeover record, `<state>/takeover.json`, shared with packaging
//! and the old desktop bridge. The bridge only reads it.
//! Packaging and the bridge share this record schema.
//!
//! The driver ([`super::run`]) writes `Started` before T1 and only writes `Complete`
//! once every collection is complete or held. Unknown states conservatively mean
//! `Started`. Missing state is distinct from a missing *file*: malformed or newer
//! records must fail closed, never become permission to restart the old service.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The current record schema.
pub const SCHEMA_VERSION: u32 = 1;

/// Overall takeover state. Unknown future state strings are treated as started.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    /// Every collection is complete or safely held.
    Complete,
    /// T1 could not stop/disable the old service or acquire its lock.
    Postponed,
    /// Explicit local rollback finished (not inferred from an error).
    RolledBack,
    /// Takeover has begun, or the reader cannot recognize a future state.
    #[serde(other)]
    Started,
}
impl State {
    /// At every start, stop/disable a revived old service and show
    /// `old_connector_revived` for these states. Never repeat T2–T6 on completed
    /// collections. Rollback is a separate, explicitly authorized path.
    pub fn fences_old_service(self) -> bool {
        matches!(self, Self::Started | Self::Complete)
    }
}

/// Per-collection takeover state. Unknown states remain pending.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CollectionState {
    /// This collection could not safely be taken over yet.
    Postponed,
    /// Its import and registration finished.
    Complete,
    /// Safely held with the user's bytes/restoration inputs preserved.
    Held,
    /// Explicit local rollback finished.
    RolledBack,
    /// Not completed, or a future state not understood by this reader.
    #[serde(other)]
    Pending,
}
impl CollectionState {
    /// Sufficient for the overall takeover to finish. A hold is visible and
    /// durable, not permission to overwrite user bytes or discard receipts.
    pub fn settled(self) -> bool {
        matches!(self, Self::Complete | Self::Held)
    }
}

/// One old collection's progress.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Collection {
    /// Durable state.
    pub state: CollectionState,
    /// Optional stable reason; do not put secrets or payloads here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Old engine transaction entries rolled forward at T4 (counts only).
    #[serde(default, skip_serializing_if = "is_zero")]
    pub rolled_forward: u64,
    /// Files held at T4, both versions kept (counts only; paths are in the evidence).
    #[serde(default, skip_serializing_if = "is_zero")]
    pub holds: u64,
    /// Whether the daemon serves it yet (registration needs a signed-in account).
    #[serde(default)]
    pub registered: bool,
    /// Sticky: the folder's v2 marker was found missing or altered after the
    /// takeover (takeover marker contract). Never cleared or "fixed" by rewriting the marker.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub marker_incident: bool,
}

impl Collection {
    /// A collection with `state` and nothing else.
    pub fn new(state: CollectionState) -> Collection {
        Collection {
            state,
            reason: None,
            rolled_forward: 0,
            holds: 0,
            registered: false,
            marker_incident: false,
        }
    }
}

fn is_zero(n: &u64) -> bool {
    *n == 0
}

/// `<state>/takeover.json` (schema 1, atomic, Unix 0600).
///
/// This is a local diagnostic/bridge contract, not authority for migration or
/// rollback. In particular, `Complete` does not prove receipt-import correctness.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Record {
    /// Schema version; unknown versions fail closed.
    pub schema_version: u32,
    /// Overall state.
    pub state: State,
    /// RFC3339 timestamp produced by the driver. Readers do not use this value
    /// for authorization, ordering or lease expiry.
    pub updated_at: String,
    /// Old connector state directory (local-only diagnostic data).
    pub old_state_dir: PathBuf,
    /// Legacy collection ID → progress.
    pub collections: BTreeMap<String, Collection>,
}
impl std::fmt::Debug for Record {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Record")
            .field("schema_version", &self.schema_version)
            .field("state", &self.state)
            .field("updated_at", &self.updated_at)
            .field("collections", &self.collections.len())
            .finish_non_exhaustive()
    }
}
impl Record {
    /// Parse a record; malformed or unknown-schema data is not a missing record.
    pub fn from_bytes(bytes: &[u8]) -> std::io::Result<Self> {
        let record: Self =
            serde_json::from_slice(bytes).map_err(|_| invalid("malformed takeover record"))?;
        record.validate()?;
        Ok(record)
    }

    fn validate(&self) -> std::io::Result<()> {
        if self.schema_version != SCHEMA_VERSION {
            return Err(invalid("unsupported takeover schema"));
        }
        if self.updated_at.is_empty() || !self.old_state_dir.is_absolute() {
            return Err(invalid("invalid takeover record metadata"));
        }
        if self.state == State::Complete && !self.all_settled() {
            return Err(invalid("complete takeover has unsettled collections"));
        }
        Ok(())
    }

    /// Load; only a nonexistent file is `None`. Symlinks/untrusted owner or
    /// permissions, parse errors and newer schemas return an error.
    pub fn load(path: &Path) -> std::io::Result<Option<Self>> {
        match std::fs::symlink_metadata(path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e),
            Ok(_) => crate::fsutil::verify_owner_only(path)?,
        }
        Self::from_bytes(&std::fs::read(path)?).map(Some)
    }

    /// Recorded interrupted legacy write/delete intents held at T4. Diagnostic
    /// only (including historical evidence); never an authorization predicate.
    pub fn held_interrupted_writes(&self) -> u64 {
        self.collections
            .values()
            .fold(0_u64, |n, c| n.saturating_add(c.holds))
    }

    /// Save atomically/durably in the daemon's state directory, never a collection
    /// folder. The driver supplies the RFC 3339 timestamp.
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        self.validate()?;
        let parent = path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .ok_or_else(|| invalid("takeover record requires a state directory"))?;
        crate::fsutil::ensure_private_dir(parent)?;
        let mut bytes = serde_json::to_vec_pretty(self)
            .map_err(|_| invalid("takeover record encoding failed"))?;
        bytes.push(b'\n');
        crate::fsutil::write_atomic(path, &bytes)
    }

    /// Every collection is complete or held (an empty old registry is settled).
    pub fn all_settled(&self) -> bool {
        self.collections.values().all(|c| c.state.settled())
    }
}
fn invalid(message: &'static str) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn record(root: &Path) -> Record {
        Record {
            schema_version: 1,
            state: State::Started,
            updated_at: "2026-10-04T13:47:00Z".into(),
            old_state_dir: root.join("old"),
            collections: BTreeMap::from([(
                "legacy".into(),
                Collection::new(CollectionState::Pending),
            )]),
        }
    }
    #[test]
    fn round_trip_and_final_state_gate() {
        let dir = crate::testutil::TestDir::new("takeover-record");
        let path = dir.path().join("state/takeover.json");
        assert!(Record::load(&path).unwrap().is_none());
        let mut r = record(dir.path());
        r.save(&path).unwrap();
        assert_eq!(Record::load(&path).unwrap().unwrap(), r);
        assert!(!r.all_settled());
        r.state = State::Complete;
        assert!(r.save(&path).is_err());
        assert_eq!(Record::load(&path).unwrap().unwrap().state, State::Started);
        for state in [CollectionState::Held, CollectionState::Complete] {
            r.collections.get_mut("legacy").unwrap().state = state;
            assert!(r.all_settled());
            r.save(&path).unwrap();
            assert_eq!(Record::load(&path).unwrap().unwrap(), r);
        }
        assert!(State::Complete.fences_old_service());
        assert!(State::Started.fences_old_service());
        assert!(!State::Postponed.fences_old_service());
        assert!(!State::RolledBack.fences_old_service());
    }
    #[test]
    fn unknown_states_fence_but_missing_or_newer_schema_is_not_none() {
        let dir = crate::testutil::TestDir::new("takeover-future");
        let r = record(dir.path());
        let mut v = serde_json::to_value(&r).unwrap();
        v["state"] = serde_json::json!("future_state");
        v["collections"]["legacy"]["state"] = serde_json::json!("future_collection_state");
        let future = Record::from_bytes(&serde_json::to_vec(&v).unwrap()).unwrap();
        assert!(future.state.fences_old_service());
        assert_eq!(future.collections["legacy"].state, CollectionState::Pending);
        v["schema_version"] = serde_json::json!(2);
        assert!(Record::from_bytes(&serde_json::to_vec(&v).unwrap()).is_err());
        v.as_object_mut().unwrap().remove("schema_version");
        assert!(Record::from_bytes(&serde_json::to_vec(&v).unwrap()).is_err());
        assert!(Record::from_bytes(b"{}").is_err());
        assert!(Record::from_bytes(b"torn").is_err());
    }
    #[test]
    fn malformed_record_is_preserved_and_debug_redacts_paths() {
        let dir = crate::testutil::TestDir::new("takeover-corrupt");
        let path = dir.path().join("takeover.json");
        std::fs::write(&path, b"torn").unwrap();
        assert!(Record::load(&path).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"torn");
        let r = record(dir.path());
        assert!(!format!("{r:?}").contains(&dir.path().to_string_lossy().to_string()));
    }
    #[cfg(unix)]
    #[test]
    fn atomic_record_is_private_and_untrusted_read_is_refused() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let dir = crate::testutil::TestDir::new("takeover-private");
        let path = dir.path().join("state/takeover.json");
        record(dir.path()).save(&path).unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        let link = path.with_file_name("link.json");
        symlink(&path, &link).unwrap();
        assert!(Record::load(&link).is_err());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o666)).unwrap();
        assert!(Record::load(&path).is_err());
    }
}
