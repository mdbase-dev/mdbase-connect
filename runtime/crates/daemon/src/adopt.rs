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

use std::future::Future;
use std::io;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::task::{Context, Poll, Waker};

use serde::{Deserialize, Serialize};

use mdbn_replica::{AdoptRecords, AdoptSource};
use mdbn_store_file::platform::{FilePlatform, FsErrorKind, RelPath};
use mdbn_wire::common::B16;

/// The current journal schema.
pub const SCHEMA_VERSION: u32 = 1;

/// Larger files are left to ordinary ingest after the base (the replica's own
/// record-size admission is far below this).
const MAX_READ: u32 = 16 * 1024 * 1024;

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

/// The live folder, read for generation 0 through the collection's own file
/// platform: on the desktop that is the native platform, which resolves every
/// path from the held collection root and opens each component without
/// following a symlink or reparse point, so the file read is the file checked.
pub struct FolderSource<P: FilePlatform> {
    platform: Rc<P>,
    plan: AdoptRecords,
}

impl<P: FilePlatform> FolderSource<P> {
    /// A source over `platform`'s folder adopting `plan`.
    pub fn new(platform: Rc<P>, plan: AdoptRecords) -> FolderSource<P> {
        FolderSource { platform, plan }
    }
}

impl<P: FilePlatform> AdoptSource for FolderSource<P> {
    fn records(&mut self) -> Result<AdoptRecords, String> {
        Ok(self.plan.clone())
    }

    fn read(&mut self, path: &str) -> Result<Option<String>, String> {
        let Ok(rel) = RelPath::new(path) else {
            return Ok(None);
        };
        if rel.is_root() {
            return Ok(None);
        }
        // One bounded read of the opened regular file: a file larger than the
        // cap is refused by what was read, not by an earlier stat.
        match now(self.platform.read_range(&rel, 0, MAX_READ + 1)) {
            Ok(b) if b.len() as u64 <= u64::from(MAX_READ) => Ok(String::from_utf8(b).ok()),
            Ok(_) => Ok(None),
            Err(e) if e.kind == FsErrorKind::Other || e.kind == FsErrorKind::Busy => {
                Err(format!("read: {:?}", e.kind))
            }
            // Gone, not a regular file, a link, or not ours to read: left to
            // ordinary ingest after the base.
            Err(_) => Ok(None),
        }
    }
}

/// The platform's synchronous IO, which completes on first poll.
fn now<F: Future>(f: F) -> F::Output {
    let mut f = std::pin::pin!(f);
    match f.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
        Poll::Ready(v) => v,
        Poll::Pending => unreachable!("platform IO is synchronous"),
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
    fn folder_source_reads_through_the_confined_platform_with_a_bounded_read() {
        use mdbn_store_file::platform::{CaseSensitivity, ReplaceStrategy};
        use mdbn_store_file::testing::MemPlatform;
        let p = Rc::new(MemPlatform::new(
            ReplaceStrategy::Exchange,
            CaseSensitivity::Sensitive,
        ));
        p.fs.write_in_place("n/a.md", b"a").unwrap();
        p.fs.write_in_place("bin.md", &[0xff]).unwrap();
        // Larger than the cap: refused by a bounded read, never read whole.
        p.fs.write_synthetic("big.md", u64::from(MAX_READ) + 1);
        let mut s = FolderSource::new(p.clone(), AdoptRecords::default());
        assert_eq!(s.read("n/a.md").unwrap().as_deref(), Some("a"));
        assert_eq!(s.read("big.md").unwrap(), None);
        assert_eq!(p.fs.synthetic_whole_reads(), 0);
        assert_eq!(s.read("bin.md").unwrap(), None);
        assert_eq!(s.read("../a.md").unwrap(), None);
        assert_eq!(s.read("gone.md").unwrap(), None);
        assert_eq!(s.read("n").unwrap(), None);
        assert!(p.fs.log().iter().any(|l| l.contains("read_range n/a.md")));
    }

    #[cfg(unix)]
    #[test]
    fn folder_source_never_follows_a_link_out_of_the_folder() {
        use mdbn_platform_native::{NativePlatform, OpenOptions};
        let base = std::env::temp_dir().join(format!("mdbn-adopt-src-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let (dir, outside) = (base.join("folder"), base.join("outside"));
        std::fs::create_dir_all(dir.join("n")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.md"), "s").unwrap();
        std::fs::write(dir.join("n/a.md"), "a").unwrap();
        std::os::unix::fs::symlink(&outside, dir.join("link")).unwrap();
        std::os::unix::fs::symlink(outside.join("secret.md"), dir.join("s.md")).unwrap();
        let p = Rc::new(NativePlatform::open(&dir, &OpenOptions::default()).unwrap());
        let mut s = FolderSource::new(p, AdoptRecords::default());
        assert_eq!(s.read("n/a.md").unwrap().as_deref(), Some("a"));
        assert_eq!(s.read("link/secret.md").unwrap(), None);
        assert_eq!(s.read("s.md").unwrap(), None);
        let _ = std::fs::remove_dir_all(&base);
    }
}
