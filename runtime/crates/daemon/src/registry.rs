//! The durable list of collections this daemon hosts.
//!
//! `<state>/collections.json`, written with [`crate::fsutil::write_atomic`]. The
//! registry is the daemon's only startup input besides the device identity: it is
//! loaded before any collection opens, and a registry that fails to parse is
//! **never** replaced (the daemon reports `initialization_failed` and keeps the
//! file for diagnosis).
//!
//! Invariants, checked on load and on every change:
//! - collection IDs are unique;
//! - roots are absolute, and no root contains another (one replica per folder).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::fsutil;

/// Current registry schema.
pub const SCHEMA_VERSION: u32 = 1;

/// A collection's state (`docs/collection-states-and-pricing.md` §2). User-facing
/// names are still open; these are the stable protocol names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncMode {
    /// On this device only: no log. The daemon serves it to apps with the same
    /// replica service; a write is confirmed once durably published to the file.
    Local,
    /// Synced: the hosted log plus the hosted replica holding the escrowed
    /// collection key.
    Synced,
    /// Synced, end-to-end encrypted: the hosted blind log only. mdbase cannot read
    /// it; new devices join by a six-digit code.
    SyncedE2e,
}

impl SyncMode {
    /// Stable lower-case name.
    pub fn as_str(self) -> &'static str {
        match self {
            SyncMode::Local => "local",
            SyncMode::Synced => "synced",
            SyncMode::SyncedE2e => "synced_e2e",
        }
    }
}

/// How a collection came to be registered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Origin {
    /// A new collection created here.
    Created,
    /// A folder adopted in place (a plain mdbase folder, no prior connector).
    Adopted,
    /// Taken over from today's connector (drain, adopt, v2 marker).
    MigratedLocal,
    /// Joined from an existing log (another device or a hosted collection).
    Joined,
}

/// One registered collection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    /// Collection ID (UUID, lower-case hyphenated).
    pub id: String,
    /// Display name.
    pub name: String,
    /// Absolute folder path.
    pub root: PathBuf,
    /// This device's replica ID for the collection.
    pub replica_id: String,
    /// Where the log lives.
    pub mode: SyncMode,
    /// How it was registered.
    pub origin: Origin,
    /// When it was registered (ms since the epoch).
    pub added_at_ms: u64,
    /// Paused by the user: registered, but not opened.
    #[serde(default)]
    pub paused: bool,
    /// Whether this collection was ever end-to-end on this device. Set
    /// only by this device (enabling e2e sync, or verifying an e2e log); never
    /// taken from the account or the control plane, and never cleared. While set,
    /// new app grants always need approval here.
    #[serde(default)]
    pub ever_e2e: bool,
    /// Paired account at LOCAL registration; never authority for synced/shared.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_account: Option<String>,
    /// Keychain device bound at registration; missing legacy metadata denies.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device: Option<String>,
}

/// The registry document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Registry {
    /// Schema version; readers refuse a newer one.
    pub schema_version: u32,
    /// Collections, in registration order.
    pub collections: Vec<Entry>,
}

impl Default for Registry {
    fn default() -> Self {
        Registry {
            schema_version: SCHEMA_VERSION,
            collections: Vec::new(),
        }
    }
}

/// Registry failures.
#[derive(Debug)]
pub enum RegistryError {
    /// I/O.
    Io(std::io::Error),
    /// The file did not parse or violated an invariant. It is left in place.
    Malformed(String),
    /// Written by a newer daemon.
    NewerSchema(u32),
    /// A change would violate an invariant.
    Rejected {
        /// Stable reason (`duplicate_id`, `overlapping_root`, `not_found`, ...).
        reason: &'static str,
        /// For people.
        message: String,
    },
}

impl std::fmt::Display for RegistryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RegistryError::Io(e) => write!(f, "registry I/O: {e}"),
            RegistryError::Malformed(m) => write!(f, "registry is malformed: {m}"),
            RegistryError::NewerSchema(v) => {
                write!(
                    f,
                    "registry schema {v} is newer than this daemon understands"
                )
            }
            RegistryError::Rejected { message, .. } => f.write_str(message),
        }
    }
}

impl std::error::Error for RegistryError {}

impl From<std::io::Error> for RegistryError {
    fn from(e: std::io::Error) -> Self {
        RegistryError::Io(e)
    }
}

impl Registry {
    /// Load from `path`; a missing file is an empty registry.
    pub fn load(path: &Path) -> Result<Registry, RegistryError> {
        let Some(bytes) = fsutil::read_optional(path)? else {
            return Ok(Registry::default());
        };
        let probe: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|e| RegistryError::Malformed(e.to_string()))?;
        let version = probe
            .get("schema_version")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| RegistryError::Malformed("missing schema_version".into()))?;
        if version > u64::from(SCHEMA_VERSION) {
            return Err(RegistryError::NewerSchema(version as u32));
        }
        let reg: Registry =
            serde_json::from_value(probe).map_err(|e| RegistryError::Malformed(e.to_string()))?;
        reg.check()
            .map_err(|e| RegistryError::Malformed(e.to_string()))?;
        Ok(reg)
    }

    /// Write durably to `path`.
    pub fn save(&self, path: &Path) -> Result<(), RegistryError> {
        self.check()?;
        let mut bytes =
            serde_json::to_vec_pretty(self).map_err(|e| RegistryError::Malformed(e.to_string()))?;
        bytes.push(b'\n');
        fsutil::write_atomic(path, &bytes)?;
        Ok(())
    }

    /// Find by collection ID.
    pub fn get(&self, id: &str) -> Option<&Entry> {
        self.collections.iter().find(|e| e.id == id)
    }

    /// Find by collection ID, mutably.
    pub fn get_mut(&mut self, id: &str) -> Option<&mut Entry> {
        self.collections.iter_mut().find(|e| e.id == id)
    }

    /// Add an entry, enforcing the invariants.
    pub fn add(&mut self, entry: Entry) -> Result<(), RegistryError> {
        let mut next = self.clone();
        next.collections.push(entry);
        next.check()?;
        *self = next;
        Ok(())
    }

    /// Remove by ID.
    pub fn remove(&mut self, id: &str) -> Result<Entry, RegistryError> {
        let i = self
            .collections
            .iter()
            .position(|e| e.id == id)
            .ok_or_else(|| RegistryError::Rejected {
                reason: "not_found",
                message: format!("no registered collection {id}"),
            })?;
        Ok(self.collections.remove(i))
    }

    fn check(&self) -> Result<(), RegistryError> {
        for (i, a) in self.collections.iter().enumerate() {
            if !a.root.is_absolute() {
                return Err(RegistryError::Rejected {
                    reason: "relative_root",
                    message: format!("collection root {} is not absolute", a.root.display()),
                });
            }
            for b in &self.collections[i + 1..] {
                if a.id == b.id {
                    return Err(RegistryError::Rejected {
                        reason: "duplicate_id",
                        message: format!("collection {} is already registered", a.id),
                    });
                }
                if overlaps(&a.root, &b.root) {
                    return Err(RegistryError::Rejected {
                        reason: "overlapping_root",
                        message: format!(
                            "{} overlaps the registered collection at {}",
                            b.root.display(),
                            a.root.display()
                        ),
                    });
                }
            }
        }
        Ok(())
    }
}

/// Whether one root equals or contains the other (component-wise; callers
/// canonicalize first so symlinks and `..` cannot hide an overlap).
pub fn overlaps(a: &Path, b: &Path) -> bool {
    a.starts_with(b) || b.starts_with(a)
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use super::*;

    #[cfg(unix)]
    fn entry(id: &str, root: &str) -> Entry {
        Entry {
            id: id.into(),
            name: id.into(),
            root: PathBuf::from(root),
            replica_id: format!("r-{id}"),
            mode: SyncMode::Local,
            origin: Origin::Created,
            added_at_ms: 1,
            paused: false,
            ever_e2e: false,
            owner_account: None,
            device: None,
        }
    }

    #[cfg(unix)]
    #[test]
    fn rejects_duplicates_and_overlaps() {
        let mut r = Registry::default();
        r.add(entry("a", "/notes")).unwrap();
        r.add(entry("b", "/notes2")).unwrap();
        let dup = r.add(entry("a", "/other")).unwrap_err();
        assert!(matches!(
            dup,
            RegistryError::Rejected {
                reason: "duplicate_id",
                ..
            }
        ));
        let nested = r.add(entry("c", "/notes/sub")).unwrap_err();
        assert!(matches!(
            nested,
            RegistryError::Rejected {
                reason: "overlapping_root",
                ..
            }
        ));
        let parent = r.add(entry("d", "/")).unwrap_err();
        assert!(matches!(
            parent,
            RegistryError::Rejected {
                reason: "overlapping_root",
                ..
            }
        ));
        assert_eq!(r.collections.len(), 2);
    }

    #[cfg(unix)]
    #[test]
    fn round_trips_and_refuses_newer_or_malformed() {
        let dir = crate::testutil::TestDir::new("reg");
        let p = dir.path().join("collections.json");
        assert_eq!(Registry::load(&p).unwrap(), Registry::default());
        let mut r = Registry::default();
        r.add(entry("a", "/notes")).unwrap();
        r.save(&p).unwrap();
        assert_eq!(Registry::load(&p).unwrap(), r);

        std::fs::write(&p, br#"{"schema_version": 9, "collections": []}"#).unwrap();
        assert!(matches!(
            Registry::load(&p),
            Err(RegistryError::NewerSchema(9))
        ));
        std::fs::write(&p, b"{not json").unwrap();
        assert!(matches!(
            Registry::load(&p),
            Err(RegistryError::Malformed(_))
        ));
        assert_eq!(std::fs::read(&p).unwrap(), b"{not json", "left in place");
    }
}

/// The store IDs this daemon issued, per collection (`<state>/store-ids.json`).
///
/// The takeover asks for one (`takeover::Daemon::store_id`) before it writes the
/// v2 marker, so the ID is durable before any folder names it. A folder whose v2
/// marker names an ID not in this map belongs to someone else.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoreIds {
    /// Collection → store (replica) ID.
    pub ids: std::collections::BTreeMap<String, String>,
}

impl StoreIds {
    /// Load; missing is empty.
    pub fn load(path: &Path) -> Result<StoreIds, RegistryError> {
        match fsutil::read_optional(path)? {
            None => Ok(StoreIds::default()),
            Some(b) => {
                serde_json::from_slice(&b).map_err(|e| RegistryError::Malformed(e.to_string()))
            }
        }
    }

    /// The ID for `collection`, if issued.
    pub fn get(&self, collection: &str) -> Option<&str> {
        self.ids.get(collection).map(String::as_str)
    }

    /// The ID for `collection`, minting and saving one durably on first use.
    pub fn get_or_issue(path: &Path, collection: &str) -> Result<String, RegistryError> {
        let mut s = StoreIds::load(path)?;
        if let Some(id) = s.ids.get(collection) {
            return Ok(id.clone());
        }
        let id = crate::secrets::new_uuid().map_err(|e| RegistryError::Malformed(e.to_string()))?;
        s.ids.insert(collection.to_string(), id.clone());
        let b =
            serde_json::to_vec_pretty(&s).map_err(|e| RegistryError::Malformed(e.to_string()))?;
        fsutil::write_atomic(path, &b)?;
        Ok(id)
    }
}
