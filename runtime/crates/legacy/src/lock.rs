//! The old system's exclusive locks.
//!
//! - `<state>/daemon.lock`: held by a running connector daemon for its lifetime
//!   (`MC/crates/connect-agent/src/lib.rs:285-292`). While migration holds it, no old
//!   daemon can start on that state directory.
//! - `<root>/.mdbase/write.lock`: the mdbase-rs engine's write lock, taken by every
//!   engine host for every transaction (`RS/src/transactions.rs:764-850`).
//!
//! The old code locks them with `fs2`/`fs4`: `flock` on Unix, `LockFileEx` on Windows.
//! `std::fs::File::try_lock` uses the same primitives, so the locks exclude each
//! other. Opening a lock may create the empty lock file, exactly as the old code does.
//! This is the only write this crate makes.

use std::fs::{File, OpenOptions, TryLockError};
use std::path::{Path, PathBuf};

use crate::{Error, Result};

/// A held exclusive lock. Dropping it releases the lock.
#[derive(Debug)]
pub struct Held {
    _file: File,
    path: PathBuf,
}

impl Held {
    /// The lock file.
    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// Try to take `path` exclusively without blocking. `Ok(None)` means another process
/// holds it: for `daemon.lock`, an old daemon is running.
pub fn try_exclusive(path: &Path) -> Result<Option<Held>> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|e| Error::io(path, e))?;
    match file.try_lock() {
        Ok(()) => Ok(Some(Held {
            _file: file,
            path: path.to_path_buf(),
        })),
        Err(TryLockError::WouldBlock) => Ok(None),
        Err(TryLockError::Error(e)) => Err(Error::io(path, e)),
    }
}

/// `daemon.lock` of a connector state directory.
pub fn daemon_lock_path(state_dir: &Path) -> PathBuf {
    state_dir.join("daemon.lock")
}

/// `.mdbase/write.lock` of a collection folder.
pub fn write_lock_path(root: &Path) -> PathBuf {
    root.join(".mdbase").join("write.lock")
}
