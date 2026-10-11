//! Adopt: turn sync on for a local collection whose folder already holds files
//! The replica seals generation 0 from the folder
//! ([`mdbn_replica::AdoptSource`]); this module keeps the daemon's resumable state.
//!
//! `<state>/collections/<id>.adopt.json` is written once the local-only runtime is
//! stopped and the inventory (record IDs and paths, resource paths) is taken. It
//! lives beside, not inside, the collection's state directory, which is moved
//! aside when the collection is linked. Its presence means:
//! - registry mode local, no `created`: stopped, nothing remote happened yet
//!   (resume abandons the adopt);
//! - registry mode local, `created`: Connect created the log; `sync enable` links it;
//! - registry mode synced: the synced runtime adopts the folder on every open until
//!   its base is applied, then the journal is removed.

use std::io;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use mdbn_replica::{AdoptRecords, AdoptSource};
use mdbn_wire::common::B16;

/// The current journal schema.
pub const SCHEMA_VERSION: u32 = 1;

/// Larger files are left to ordinary ingest after the base (the replica's own
/// record-size admission is far below this).
const MAX_READ: u64 = 16 * 1024 * 1024;

/// The mode adopt creates the log in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    /// End-to-end encrypted; only the user's own devices are keyed.
    Private,
    /// With the hosted replica (hosted and escrow wraps).
    CloudCopy,
}

/// What Connect returned when it created the log.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Created {
    /// Log service origin.
    pub log_url: String,
    /// The candidate genesis item (hex), verified before it was journaled.
    pub genesis: String,
}

/// `<state>/collections/<id>.adopt.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Journal {
    /// Always [`SCHEMA_VERSION`].
    pub schema_version: u32,
    /// The chosen mode (a re-run must ask for the same one).
    pub mode: Mode,
    /// `(record ID, path)` as the local-only store had them.
    pub records: Vec<(String, String)>,
    /// Resource paths.
    pub resources: Vec<String>,
    /// Set once Connect created the log.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created: Option<Created>,
}

impl Journal {
    /// The journal's path for a collection.
    pub fn path(collections_dir: &Path, id: &str) -> PathBuf {
        collections_dir.join(format!("{id}.adopt.json"))
    }

    /// Load; only a missing file is `None`.
    pub fn load(path: &Path) -> io::Result<Option<Journal>> {
        let Some(bytes) = crate::fsutil::read_optional(path)? else {
            return Ok(None);
        };
        let j: Journal = serde_json::from_slice(&bytes)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "malformed adopt journal"))?;
        if j.schema_version != SCHEMA_VERSION {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "unsupported adopt journal",
            ));
        }
        Ok(Some(j))
    }

    /// Save atomically and durably.
    pub fn save(&self, path: &Path) -> io::Result<()> {
        let bytes = serde_json::to_vec(self).map_err(io::Error::other)?;
        crate::fsutil::write_atomic(path, &bytes)
    }

    /// Remove (a missing file is fine).
    pub fn remove(path: &Path) -> io::Result<()> {
        match std::fs::remove_file(path) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
            _ => {
                if let Some(dir) = path.parent() {
                    crate::fsutil::sync_dir(dir)?;
                }
                Ok(())
            }
        }
    }

    /// What generation 0 adopts. Malformed IDs are dropped (those files are then
    /// ingested after the base with fresh IDs).
    pub fn plan(&self) -> AdoptRecords {
        AdoptRecords {
            records: self
                .records
                .iter()
                .filter_map(|(id, path)| Some((B16(crate::attest::uuid_bytes(id)?), path.clone())))
                .collect(),
            resources: self.resources.clone(),
            settings: None,
        }
    }

    /// The created log's genesis bytes.
    pub fn genesis(&self) -> Option<Vec<u8>> {
        unhex(&self.created.as_ref()?.genesis)
    }
}

/// The inventory with record IDs from the takeover's imported ID map preferred
/// over the local-only store's (the ID follows the path). A legacy ID already
/// used by another path keeps the store's ID.
pub fn prefer_legacy_ids(
    records: Vec<([u8; 16], String)>,
    hints: &[([u8; 16], String)],
) -> Vec<([u8; 16], String)> {
    use std::collections::{BTreeMap, BTreeSet};
    let by_path: BTreeMap<String, [u8; 16]> = hints
        .iter()
        .map(|(id, p)| (mdbn_core::paths::path_key(p), *id))
        .collect();
    let wanted: Vec<([u8; 16], String, Option<[u8; 16]>)> = records
        .into_iter()
        .map(|(id, p)| {
            let legacy = by_path
                .get(&mdbn_core::paths::path_key(&p))
                .copied()
                .filter(|l| *l != id);
            (id, p, legacy)
        })
        .collect();
    // Unhinted IDs are kept first; a legacy ID colliding with a kept ID loses and
    // the record keeps the store's ID.
    let mut taken: BTreeSet<[u8; 16]> = wanted
        .iter()
        .filter(|w| w.2.is_none())
        .map(|w| w.0)
        .collect();
    wanted
        .into_iter()
        .map(|(id, p, legacy)| match legacy {
            Some(l) if taken.insert(l) => (l, p),
            _ => (id, p),
        })
        .collect()
}

/// The takeover's imported ID map for a migrated collection (empty when there is
/// none or it cannot be read).
pub fn legacy_hints(state_dir: &Path, id: &str) -> Vec<([u8; 16], String)> {
    match crate::takeover::adapter::Evidence::load(&state_dir.join("legacy"), id) {
        Ok(Some(e)) => e
            .record_ids
            .iter()
            .filter_map(|r| Some((crate::attest::uuid_bytes(&r.record_id)?, r.path.clone())))
            .collect(),
        Ok(None) => Vec::new(),
        Err(e) => {
            tracing::warn!(collection = %id, error = %e, "takeover record IDs unreadable");
            Vec::new()
        }
    }
}

/// Files held when the takeover imported this collection (both versions kept).
pub fn takeover_holds(state_dir: &Path, id: &str) -> io::Result<u64> {
    Ok(
        crate::takeover::record::Record::load(&state_dir.join("takeover.json"))?
            .and_then(|r| r.collections.get(id).map(|c| c.holds))
            .unwrap_or(0),
    )
}

/// The live folder, read for generation 0.
pub struct FolderSource {
    root: PathBuf,
    plan: AdoptRecords,
}

impl FolderSource {
    /// A source over `root` adopting `plan`.
    pub fn new(root: &Path, plan: AdoptRecords) -> FolderSource {
        FolderSource {
            root: root.to_path_buf(),
            plan,
        }
    }
}

impl AdoptSource for FolderSource {
    fn records(&mut self) -> Result<AdoptRecords, String> {
        Ok(self.plan.clone())
    }

    fn read(&mut self, path: &str) -> Result<Option<String>, String> {
        let rel = Path::new(path);
        if path.is_empty() || !rel.components().all(|c| matches!(c, Component::Normal(_))) {
            return Ok(None);
        }
        // No component may be a symlink: the file must be inside the folder.
        let mut at = self.root.clone();
        for c in rel.components() {
            at.push(c);
            match std::fs::symlink_metadata(&at) {
                Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
                Err(e) => return Err(format!("stat: {}", e.kind())),
                Ok(m) if m.file_type().is_symlink() => return Ok(None),
                Ok(_) => {}
            }
        }
        let meta = std::fs::symlink_metadata(&at).map_err(|e| format!("stat: {}", e.kind()))?;
        if !meta.is_file() || meta.len() > MAX_READ {
            return Ok(None);
        }
        match std::fs::read(&at) {
            Ok(b) => Ok(String::from_utf8(b).ok()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("read: {}", e.kind())),
        }
    }
}

/// Lower-case hex.
pub fn hex(b: &[u8]) -> String {
    crate::secrets::hex(b)
}

fn unhex(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_ids_win_by_path_unless_taken() {
        let (a, b, l1, l2) = ([1; 16], [2; 16], [9; 16], [2; 16]);
        let got = prefer_legacy_ids(
            vec![
                (a, "x.md".into()),
                (b, "y.md".into()),
                ([3; 16], "z.md".into()),
            ],
            // x.md takes its legacy ID; z.md's legacy ID is y.md's kept ID.
            &[(l1, "x.md".into()), (l2, "z.md".into())],
        );
        assert_eq!(
            got,
            vec![
                (l1, "x.md".into()),
                (b, "y.md".into()),
                ([3; 16], "z.md".into())
            ]
        );
    }

    #[test]
    fn folder_source_reads_only_regular_files_inside_the_folder() {
        let base = std::env::temp_dir().join(format!("mdbn-adopt-src-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let (dir, outside) = (base.join("folder"), base.join("outside"));
        std::fs::create_dir_all(dir.join("n")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.md"), "s").unwrap();
        std::fs::write(dir.join("n/a.md"), "a").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, dir.join("link")).unwrap();
        let mut s = FolderSource::new(&dir, AdoptRecords::default());
        assert_eq!(s.read("n/a.md").unwrap().as_deref(), Some("a"));
        assert_eq!(s.read("../secret.md").unwrap(), None);
        assert_eq!(s.read("link/secret.md").unwrap(), None);
        assert_eq!(s.read("gone.md").unwrap(), None);
        assert_eq!(s.read("n").unwrap(), None);
        let _ = std::fs::remove_dir_all(&base);
    }
}
