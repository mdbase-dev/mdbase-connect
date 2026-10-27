//! Opening a collection folder as a library host.
//!
//! The sequence every in-process host of a plain folder follows: refuse a
//! folder another host announced, take the folder host lock, load or create the
//! replica identity, open the store and the local-only replica, and walk the
//! folder for edits made while nobody hosted it. The `mdbase` crate and the
//! CLI's in-process data commands both open folders through [`open_folder`].
//! The daemon has its own composition (middleware, synced replicas).

use std::path::{Path, PathBuf};

use mdbn_core::types::Catalog;
use mdbn_replica::Store;
use mdbn_store_file::SqlStoreLimits;

use crate::host::now_ms;
use crate::host_lock::{DescriptorState, descriptor_state};
use crate::{
    Descriptor, Error, HostKind, HostLock, Identity, LocalReplica, LockError, OsEntropy,
    ReplicaOptions, StoreOptions, SystemClock, SystemZones, open_store,
};

/// The config file every collection has at its root.
pub const CONFIG_FILE: &str = "mdbase.yaml";

/// A descriptor whose heartbeat is older than this is reported as stale.
const STALE_MS: u64 = 60_000;

/// How to open a folder.
#[derive(Debug, Clone)]
pub struct FolderOptions {
    /// Where to keep this host's index and identity. `None` means
    /// `<root>/.mdbase/library`.
    pub state_dir: Option<PathBuf>,
    /// Desktop resource limits rather than the constrained (mobile) profile.
    pub desktop: bool,
    /// The IANA zone for `today()` and lifecycle dates. `None` uses the
    /// collection's `settings.timezone`, else the machine's zone.
    pub timezone: Option<String>,
    /// Open even if another host's descriptor is present. Never overrides a
    /// held OS lock.
    pub take_over: bool,
    /// The host session's client name and version (diagnostics).
    pub client: (String, String),
}

/// An open folder: the replica and the lock that makes this process its host.
#[derive(Debug)]
pub struct OpenFolder {
    /// The absolute collection root.
    pub root: PathBuf,
    /// The local-only replica.
    pub replica: LocalReplica,
    /// Held until dropped.
    pub lock: HostLock,
}

/// Why a folder could not be opened.
#[derive(Debug)]
pub enum FolderError {
    /// There is no `mdbase.yaml` at the root.
    NotACollection {
        /// The absolute root.
        root: PathBuf,
    },
    /// The daemon, Obsidian or another process hosts the folder. `host` is
    /// `None` when its descriptor is missing or unreadable.
    AlreadyHosted {
        /// The absolute root.
        root: PathBuf,
        /// Who announced itself.
        host: Option<HostKind>,
        /// Whether that announcement's heartbeat is old.
        stale: bool,
    },
    /// The lock or private dir is a symlink or escapes the collection.
    Unsafe(PathBuf),
    /// Composing the folder failed.
    Host(Error),
}

impl From<Error> for FolderError {
    fn from(e: Error) -> Self {
        FolderError::Host(e)
    }
}

impl From<std::io::Error> for FolderError {
    fn from(e: std::io::Error) -> Self {
        FolderError::Host(Error::Io(e))
    }
}

/// Open the collection at `root` as a library host. See the module docs.
pub fn open_folder(root: &Path, o: &FolderOptions) -> Result<OpenFolder, FolderError> {
    let root = std::path::absolute(root)?;
    if !root.join(CONFIG_FILE).is_file() {
        return Err(FolderError::NotACollection { root });
    }
    let store_opts = StoreOptions {
        state_dir: o.state_dir.clone(),
        limits: if o.desktop {
            SqlStoreLimits::DESKTOP
        } else {
            SqlStoreLimits::MOBILE
        },
        ..StoreOptions::default()
    };
    // Someone who cannot take the OS lock (Obsidian) announces itself in the
    // descriptor. Present means hosted, fresh or not (a paused mobile host
    // still owns the folder), and a descriptor that exists but cannot be read
    // counts as present; only an explicit take-over proceeds.
    if !o.take_over {
        match descriptor_state(&root, &store_opts.private_dir) {
            DescriptorState::Present(d) if d.host != HostKind::Library => {
                return Err(FolderError::AlreadyHosted {
                    root,
                    stale: d.is_stale(now_ms(), STALE_MS),
                    host: Some(d.host),
                });
            }
            DescriptorState::Unreadable(_) => {
                return Err(FolderError::AlreadyHosted {
                    root,
                    stale: false,
                    host: None,
                });
            }
            _ => {}
        }
    }
    let now = now_ms();
    let lock = match HostLock::try_acquire(
        &root,
        &store_opts.private_dir,
        Some(Descriptor::new(HostKind::Library, now)),
    ) {
        Ok(l) => l,
        Err(LockError::Held(d)) => {
            return Err(FolderError::AlreadyHosted {
                root,
                stale: d.as_ref().is_some_and(|d| d.is_stale(now, STALE_MS)),
                host: d.map(|d| d.host),
            });
        }
        Err(LockError::Unsafe(p)) => return Err(FolderError::Unsafe(p)),
        Err(LockError::Io(e)) => return Err(e.into()),
    };
    let state_dir = store_opts.state_dir(&root);
    std::fs::create_dir_all(&state_dir)?;
    let identity = Identity::load_or_create(&state_dir.join("identity.json"), now, &mut OsEntropy)?;
    let store = open_store(&root, &store_opts, Box::new(SystemClock))?;
    let zone = o.timezone.clone().or_else(|| {
        let cat = Catalog::load(
            store
                .resources()
                .ok()?
                .iter()
                .map(|(p, s)| (p.as_str(), s.as_str())),
        );
        cat.settings().timezone.clone()
    });
    let mut replica = LocalReplica::open(
        store,
        &identity,
        ReplicaOptions {
            client: o.client.clone(),
            zones: Some(Box::new(match zone {
                Some(z) => SystemZones::new(z),
                None => SystemZones::default(),
            })),
            ..ReplicaOptions::default()
        },
    )?;
    replica.rescan().map_err(Error::Store)?;
    Ok(OpenFolder {
        root,
        replica,
        lock,
    })
}
