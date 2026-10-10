//! One daemon per profile.
//!
//! The daemon takes an exclusive OS lock on `<state>/daemon.lock` before it touches
//! anything else and holds it for its lifetime (`flock` on Unix, `LockFileEx` on
//! Windows, via `File::try_lock`). The OS releases it when the process dies, so a
//! crash never leaves a stale lock. Only the lock holder may remove a stale Unix
//! socket or create the first pipe instance, so a second daemon can neither steal
//! the endpoint nor open the same collections.

use std::fs::{File, OpenOptions};
use std::io::{self, Seek, Write};
use std::path::Path;

/// The held instance lock. Dropping it releases the lock.
#[derive(Debug)]
pub struct InstanceLock {
    file: File,
}

/// Why the lock was not taken.
#[derive(Debug)]
pub enum LockError {
    /// Another daemon holds it.
    AlreadyRunning,
    /// I/O failure.
    Io(io::Error),
}

impl std::fmt::Display for LockError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LockError::AlreadyRunning => f.write_str("another daemon is running for this profile"),
            LockError::Io(e) => write!(f, "instance lock: {e}"),
        }
    }
}

impl std::error::Error for LockError {}

impl InstanceLock {
    /// Try to take the lock without waiting.
    pub fn acquire(path: &Path) -> Result<InstanceLock, LockError> {
        let mut opts = OpenOptions::new();
        opts.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut file = opts.open(path).map_err(LockError::Io)?;
        match file.try_lock() {
            Ok(()) => {}
            Err(std::fs::TryLockError::WouldBlock) => return Err(LockError::AlreadyRunning),
            Err(std::fs::TryLockError::Error(e)) => return Err(LockError::Io(e)),
        }
        // Informational only: the lock, not this PID, is the source of truth.
        let _ = file.set_len(0);
        let _ = file.rewind();
        let _ = writeln!(file, "{}", std::process::id());
        let _ = file.flush();
        Ok(InstanceLock { file })
    }

    /// Whether some process holds the lock (without taking it for long).
    pub fn is_held(path: &Path) -> io::Result<bool> {
        let file = match OpenOptions::new().read(true).write(true).open(path) {
            Ok(f) => f,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(e) => return Err(e),
        };
        match file.try_lock() {
            Ok(()) => {
                let _ = file.unlock();
                Ok(false)
            }
            Err(std::fs::TryLockError::WouldBlock) => Ok(true),
            Err(std::fs::TryLockError::Error(e)) => Err(e),
        }
    }
}

impl Drop for InstanceLock {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn second_acquire_fails_until_release() {
        let dir = crate::testutil::TestDir::new("lock");
        let p = dir.path().join("daemon.lock");
        assert!(!InstanceLock::is_held(&p).unwrap());
        let a = InstanceLock::acquire(&p).unwrap();
        assert!(matches!(
            InstanceLock::acquire(&p),
            Err(LockError::AlreadyRunning)
        ));
        assert!(InstanceLock::is_held(&p).unwrap());
        drop(a);
        assert!(!InstanceLock::is_held(&p).unwrap());
        let _b = InstanceLock::acquire(&p).unwrap();
    }
}
