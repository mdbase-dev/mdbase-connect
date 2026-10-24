//! The one native store composition: `FileStore<NativePlatform, SqlStore<SqliteIndex>, SqlDiskDb<SqliteIndex>>`.
//!
//! Both the replicated state (`SqlStore`) and the disk state (`SqlDiskDb`)
//! live in one SQLite database behind one connection; a second open of the
//! same file fails with `Busy`, which is the index's own one-writer rule.

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::rc::Rc;

use mdbn_core::host::Clock;
use mdbn_platform_native::{NativePlatform, OpenOptions, SqliteIndex};
use mdbn_store_file::diskdb::SqlDiskDb;
use mdbn_store_file::index::IndexDurability;
use mdbn_store_file::{Config, FileStore, SqlStore, SqlStoreLimits};

use crate::Error;

/// The native store type.
pub type NativeStore = FileStore<NativePlatform, SqlStore<SqliteIndex>, SqlDiskDb<SqliteIndex>>;

/// Default name of the private dir inside the collection.
pub const DEFAULT_PRIVATE_DIR: &str = ".mdbase";
/// Default name of the index database inside the state dir.
pub const INDEX_FILE: &str = "index.sqlite";

/// How to open the store.
#[derive(Debug, Clone)]
pub struct StoreOptions {
    /// The private dir name inside the collection root (`.mdbase`).
    pub private_dir: String,
    /// Where this host keeps its replica state (the SQLite index, identity).
    /// `None` means `<root>/<private_dir>/library`.
    pub state_dir: Option<PathBuf>,
    /// Blob size limits. The portable, constrained profile is the default;
    /// a desktop host selects [`SqlStoreLimits::DESKTOP`] explicitly.
    pub limits: SqlStoreLimits,
    /// File-store timing and extensions.
    pub fs: Config,
    /// Open the platform read-only (no publishes).
    pub force_read_only: bool,
}

impl Default for StoreOptions {
    fn default() -> Self {
        StoreOptions {
            private_dir: DEFAULT_PRIVATE_DIR.into(),
            state_dir: None,
            limits: SqlStoreLimits::MOBILE,
            fs: Config::default(),
            force_read_only: false,
        }
    }
}

impl StoreOptions {
    /// The state dir for `root`.
    pub fn state_dir(&self, root: &Path) -> PathBuf {
        self.state_dir
            .clone()
            .unwrap_or_else(|| root.join(&self.private_dir).join("library"))
    }

    /// The index database path for `root`.
    pub fn index_path(&self, root: &Path) -> PathBuf {
        self.state_dir(root).join(INDEX_FILE)
    }
}

/// Open the store for the collection at `root`. Creates the private dir, the
/// state dir and the index database if missing. The caller holds the folder
/// lock first ([`crate::HostLock`]).
pub fn open_store(
    root: &Path,
    opts: &StoreOptions,
    clock: Box<dyn Clock>,
) -> Result<NativeStore, Error> {
    let state_dir = opts.state_dir(root);
    std::fs::create_dir_all(&state_dir)?;
    // Caller still takes the folder host lock first. Acquire and retain the
    // exclusive private index before any platform probe/private directory IO;
    // a separate daemon preflight is diagnostic, not a TOCTOU-safe gate.
    let index =
        SqliteIndex::open(opts.index_path(root), IndexDurability::Durable).map_err(Error::Index)?;
    let index = Rc::new(RefCell::new(index));
    let inner = SqlStore::open_with_limits(index.clone(), opts.limits)?;
    mdbn_replica::mirror_admission::ensure_open(&inner)?;
    let platform = NativePlatform::open(
        root,
        &OpenOptions {
            private_dir: opts.private_dir.clone(),
            force_read_only: opts.force_read_only,
        },
    )
    .map_err(Error::Platform)?;
    // The same connection stays live through FileStore::open and for the
    // store's lifetime. No competing opener can change admission in between.
    let db = SqlDiskDb::open(index).map_err(|e| Error::Identity(format!("disk db: {e:?}")))?;
    Ok(FileStore::open(
        Rc::new(platform),
        inner,
        db,
        clock,
        opts.fs.clone(),
    )?)
}
