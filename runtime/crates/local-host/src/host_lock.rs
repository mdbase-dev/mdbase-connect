//! The folder host lock: one host per collection folder per machine.
//!
//! A native host (the daemon, the `mdbase` library, the CLI) takes an exclusive
//! OS advisory lock on `<root>/<private_dir>/host.lock` (`flock` on Unix,
//! `LockFileEx` on Windows, through `File::try_lock`) before it mutates the
//! folder, and holds it until it has drained, stopped and joined. The OS
//! releases it when the process dies, so a crash never leaves a stale lock.
//!
//! **The lock is the only exclusion.** The descriptor next to it,
//! `host.json`, is diagnostics: it tells a refused opener *who* holds the folder
//! and lets hosts that cannot `flock` (Obsidian on mobile) announce themselves.
//! A present descriptor denies writes; an absent or stale one never *grants*
//! anything, because a paused mobile host may still own the folder. Taking
//! over such a folder is an explicit caller decision.
//!
//! Lock lifetime and path-safety rules: the lock file is a stable inode
//! that is never unlinked or recreated; the private dir, the lock and the
//! descriptor are refused when they are symlinks and opened without following
//! symlinks (Unix `O_NOFOLLOW`, Windows reparse points not followed); the
//! descriptor is small, published atomically (temp file + rename + directory
//! fsync) and carries no credentials or selectors.
//!
//! **Assumption.** The collection root is caller-trusted and its hierarchy is
//! stable while open: operations are path-based, not pinned to a directory
//! handle, so they are not hardened against a hostile party substituting
//! directories under the root between check and use. This is an explicit,
//! weaker guarantee than the native platform's handle-based operations, not a
//! claim to their qualification.

use std::fs::{File, OpenOptions};
use std::io::{self, Read, Seek, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

/// `host.lock`'s name inside the private dir.
pub const LOCK_NAME: &str = "host.lock";
/// `host.json`'s name inside the private dir.
pub const DESCRIPTOR_NAME: &str = "host.json";
/// A descriptor larger than this is treated as malformed.
pub const MAX_DESCRIPTOR_BYTES: u64 = 4096;

// Serialize diagnostic publication and directory inspection within this process.
// This is not the folder's OS lock and grants no ownership over foreign writers.
static DESCRIPTOR_IO: Mutex<()> = Mutex::new(());

fn descriptor_io_lock() -> Result<MutexGuard<'static, ()>, LockError> {
    DESCRIPTOR_IO
        .lock()
        .map_err(|_| LockError::Io(io::Error::other("host descriptor I/O unavailable")))
}

/// Inspect a directory without observing this process's partially published
/// diagnostic descriptor. Other filesystem writers are not excluded; unknown
/// files, stale temporary files and unsafe paths still require normal refusal.
/// The inspection must not publish descriptors or reenter this function.
pub fn inspect_descriptor_directory<T>(inspect: impl FnOnce() -> T) -> Result<T, LockError> {
    let _publication = descriptor_io_lock()?;
    Ok(inspect())
}

/// Who hosts a folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HostKind {
    /// The desktop daemon (`mdbase` CLI/daemon).
    Daemon,
    /// The Obsidian shared runtime.
    Obsidian,
    /// The standalone library (Rust crate or Node package).
    Library,
    /// Something else, by name.
    #[serde(untagged)]
    Other(String),
}

impl std::fmt::Display for HostKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HostKind::Daemon => f.write_str("the mdbase daemon"),
            HostKind::Obsidian => f.write_str("Obsidian"),
            HostKind::Library => f.write_str("another mdbase library process"),
            HostKind::Other(s) => write!(f, "{s}"),
        }
    }
}

/// The diagnostic descriptor a host publishes while hosting. No secrets.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Descriptor {
    /// Who.
    pub host: HostKind,
    /// The host process, when it has one (informational).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    /// The host's device ID, when it has one (informational).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device: Option<String>,
    /// When hosting started, Unix milliseconds.
    pub since_ms: u64,
    /// Last refresh, Unix milliseconds. Hosts without an OS lock refresh it.
    pub heartbeat_ms: u64,
}

impl Descriptor {
    /// A descriptor for this process.
    pub fn new(host: HostKind, now_ms: u64) -> Descriptor {
        Descriptor {
            host,
            pid: Some(std::process::id()),
            device: None,
            since_ms: now_ms,
            heartbeat_ms: now_ms,
        }
    }

    /// Whether `heartbeat_ms` is older than `max_age_ms` at `now_ms`.
    pub fn is_stale(&self, now_ms: u64, max_age_ms: u64) -> bool {
        now_ms.saturating_sub(self.heartbeat_ms) > max_age_ms
    }
}

/// What `host.json` says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DescriptorState {
    /// No descriptor file.
    Absent,
    /// A well-formed descriptor.
    Present(Descriptor),
    /// A descriptor file exists but is refused (symlink, not a regular file,
    /// oversize or malformed). Treat as "someone may host this folder".
    Unreadable(String),
}

impl DescriptorState {
    /// The descriptor, if well-formed.
    pub fn descriptor(&self) -> Option<&Descriptor> {
        match self {
            DescriptorState::Present(d) => Some(d),
            _ => None,
        }
    }
}

/// Why the lock was not taken.
#[derive(Debug)]
pub enum LockError {
    /// Another process holds the lock. The descriptor says who, when readable.
    Held(Option<Descriptor>),
    /// A path under the root is a symlink or escapes it.
    Unsafe(PathBuf),
    /// I/O failure.
    Io(io::Error),
}

impl std::fmt::Display for LockError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LockError::Held(Some(d)) => write!(f, "{} hosts this folder", d.host),
            LockError::Held(None) => f.write_str("another process hosts this folder"),
            LockError::Unsafe(p) => {
                write!(f, "{} is a symlink or leaves the collection", p.display())
            }
            LockError::Io(e) => write!(f, "host lock: {e}"),
        }
    }
}

impl std::error::Error for LockError {}

impl From<io::Error> for LockError {
    fn from(e: io::Error) -> Self {
        LockError::Io(e)
    }
}

/// The held lock. Dropping it releases the lock and removes this process's
/// descriptor (only if it is still ours).
#[derive(Debug)]
pub struct HostLock {
    file: File,
    dir: PathBuf,
    descriptor: Option<Descriptor>,
}

/// Reject anything at `p` that is not a regular file (the path need not
/// exist): symlinks, directories, FIFOs, devices. A final check on the opened
/// handle follows, since this one is by path.
fn reject_non_regular(p: &Path) -> Result<(), LockError> {
    match std::fs::symlink_metadata(p) {
        Ok(m) if m.file_type().is_file() => Ok(()),
        Ok(_) => Err(LockError::Unsafe(p.to_owned())),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(LockError::Io(e)),
    }
}

/// Reject symlinks at `p` (the path need not exist).
fn reject_symlink(p: &Path) -> Result<(), LockError> {
    match std::fs::symlink_metadata(p) {
        Ok(m) if m.file_type().is_symlink() => Err(LockError::Unsafe(p.to_owned())),
        Ok(_) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(LockError::Io(e)),
    }
}

/// The private dir under `root`, checked: a plain directory (created if
/// missing), not a symlink, not escaping the root.
/// A private dir name is one plain path segment.
fn check_private_name(root: &Path, private: &str) -> Result<PathBuf, LockError> {
    if private.is_empty() || private.contains(['/', '\\']) || private == "." || private == ".." {
        return Err(LockError::Unsafe(root.join(private)));
    }
    Ok(root.join(private))
}

fn private_dir(root: &Path, private: &str) -> Result<PathBuf, LockError> {
    let dir = check_private_name(root, private)?;
    reject_symlink(&dir)?;
    if !dir.is_dir() {
        std::fs::create_dir(&dir)?;
    }
    Ok(dir)
}

/// `FILE_FLAG_OPEN_REPARSE_POINT`: open the reparse point itself, never its target.
#[cfg(windows)]
const OPEN_REPARSE_POINT: u32 = 0x0020_0000;

/// Platform flags for opening a file without following a symlink or reparse point.
pub(crate) fn no_follow(opts: &mut OpenOptions) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        opts.custom_flags(OPEN_REPARSE_POINT);
    }
}

fn open_no_follow(path: &Path, create: bool) -> io::Result<File> {
    let mut opts = OpenOptions::new();
    opts.read(true).write(true).create(create).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    no_follow(&mut opts);
    opts.open(path)
}

impl HostLock {
    /// Try to take the folder lock without waiting, then publish `descriptor`
    /// (if given). `private` is the private dir name, usually `.mdbase`.
    pub fn try_acquire(
        root: &Path,
        private: &str,
        descriptor: Option<Descriptor>,
    ) -> Result<HostLock, LockError> {
        let dir = private_dir(root, private)?;
        let path = dir.join(LOCK_NAME);
        reject_non_regular(&path)?;
        let mut file = open_no_follow(&path, true)?;
        if !file.metadata()?.is_file() {
            return Err(LockError::Unsafe(path));
        }
        match file.try_lock() {
            Ok(()) => {}
            Err(std::fs::TryLockError::WouldBlock) => {
                return Err(LockError::Held(read_descriptor_in(&dir)));
            }
            Err(std::fs::TryLockError::Error(e)) => return Err(LockError::Io(e)),
        }
        // Informational only: the lock, not this PID, is the source of truth.
        // Never truncate-and-recreate the file; rewrite in place.
        let _ = file.set_len(0);
        let _ = file.rewind();
        let _ = writeln!(file, "{}", std::process::id());
        let _ = file.flush();
        let mut lock = HostLock {
            file,
            dir,
            descriptor: None,
        };
        if let Some(d) = descriptor {
            lock.publish(d)?;
        }
        Ok(lock)
    }

    /// Whether some process holds the folder lock (without taking it for long).
    pub fn is_held(root: &Path, private: &str) -> Result<bool, LockError> {
        let path = check_private_name(root, private)?.join(LOCK_NAME);
        reject_non_regular(&path)?;
        let file = match open_no_follow(&path, false) {
            Ok(f) => f,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(e) => return Err(LockError::Io(e)),
        };
        if !file.metadata()?.is_file() {
            return Err(LockError::Unsafe(path));
        }
        match file.try_lock() {
            Ok(()) => {
                let _ = file.unlock();
                Ok(false)
            }
            Err(std::fs::TryLockError::WouldBlock) => Ok(true),
            Err(std::fs::TryLockError::Error(e)) => Err(LockError::Io(e)),
        }
    }

    /// Publish (or replace) this host's descriptor atomically.
    pub fn publish(&mut self, descriptor: Descriptor) -> Result<(), LockError> {
        write_descriptor_in(&self.dir, &descriptor)?;
        self.descriptor = Some(descriptor);
        Ok(())
    }

    /// Refresh the heartbeat of the published descriptor.
    pub fn heartbeat(&mut self, now_ms: u64) -> Result<(), LockError> {
        if let Some(mut d) = self.descriptor.clone() {
            d.heartbeat_ms = now_ms;
            self.publish(d)?;
        }
        Ok(())
    }

    /// The published descriptor.
    pub fn descriptor(&self) -> Option<&Descriptor> {
        self.descriptor.as_ref()
    }

    /// The private dir the lock lives in.
    pub fn dir(&self) -> &Path {
        &self.dir
    }
}

impl Drop for HostLock {
    fn drop(&mut self) {
        // Remove our descriptor only if it is still ours (conditional delete),
        // then release. The lock inode stays.
        if let Some(mine) = &self.descriptor
            && read_descriptor_in(&self.dir).as_ref() == Some(mine)
        {
            let _ = std::fs::remove_file(self.dir.join(DESCRIPTOR_NAME));
        }
        let _ = self.file.unlock();
    }
}

/// Fsync `dir` after a rename in it. Unix only (plain `fsync`, not macOS
/// `F_FULLFSYNC`); on Windows there is no directory barrier and this returns
/// `Ok` without doing anything. Callers must not describe the result as
/// portable crash durability.
pub(crate) fn sync_dir(dir: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        File::open(dir)?.sync_all()
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
        Ok(())
    }
}

/// Read the descriptor under `root/private`, if present and well-formed.
pub fn read_descriptor(root: &Path, private: &str) -> Option<Descriptor> {
    match descriptor_state(root, private) {
        DescriptorState::Present(d) => Some(d),
        _ => None,
    }
}

/// The state of the descriptor under `root/private`: absent, present, or
/// present but refused. Callers that treat "present" as "hosted" must treat
/// `Unreadable` the same way.
pub fn descriptor_state(root: &Path, private: &str) -> DescriptorState {
    match check_private_name(root, private) {
        Ok(dir) => descriptor_state_in(&dir),
        Err(e) => DescriptorState::Unreadable(e.to_string()),
    }
}

fn read_descriptor_in(dir: &Path) -> Option<Descriptor> {
    match descriptor_state_in(dir) {
        DescriptorState::Present(d) => Some(d),
        _ => None,
    }
}

fn descriptor_state_in(dir: &Path) -> DescriptorState {
    let path = dir.join(DESCRIPTOR_NAME);
    let unreadable = |why: &str| DescriptorState::Unreadable(format!("{}: {why}", path.display()));
    match std::fs::symlink_metadata(&path) {
        Ok(m) if m.file_type().is_file() => {}
        Ok(_) => return unreadable("not a regular file"),
        Err(e) if e.kind() == io::ErrorKind::NotFound => return DescriptorState::Absent,
        Err(e) => return unreadable(&e.to_string()),
    }
    let mut opts = OpenOptions::new();
    opts.read(true);
    no_follow(&mut opts);
    let f = match opts.open(&path) {
        Ok(f) => f,
        Err(e) => return unreadable(&e.to_string()),
    };
    match f.metadata() {
        Ok(m) if m.is_file() => {}
        Ok(_) => return unreadable("not a regular file"),
        Err(e) => return unreadable(&e.to_string()),
    }
    // Read one byte past the limit: a file that grew after `stat` is refused.
    let mut buf = String::new();
    if let Err(e) = f.take(MAX_DESCRIPTOR_BYTES + 1).read_to_string(&mut buf) {
        return unreadable(&e.to_string());
    }
    if buf.len() as u64 > MAX_DESCRIPTOR_BYTES {
        return unreadable("larger than the descriptor bound");
    }
    match serde_json::from_str(&buf) {
        Ok(d) => DescriptorState::Present(d),
        Err(e) => unreadable(&format!("malformed: {e}")),
    }
}

fn write_descriptor_in(dir: &Path, d: &Descriptor) -> Result<(), LockError> {
    let _publication = descriptor_io_lock()?;
    let tmp = dir.join(format!("{DESCRIPTOR_NAME}.{}.tmp", std::process::id()));
    let dest = dir.join(DESCRIPTOR_NAME);
    reject_symlink(&dest)?;
    let text = serde_json::to_string_pretty(d).map_err(|e| LockError::Io(io::Error::other(e)))?;
    // A stale temp file from a crashed writer is ours to remove; a planted
    // symlink is not followed because `create_new` never opens an existing path.
    let _ = std::fs::remove_file(&tmp);
    {
        let mut opts = OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o644)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
        }
        let mut f = opts.open(&tmp)?;
        f.write_all(text.as_bytes())?;
        f.sync_data()?;
    }
    if let Err(e) = std::fs::rename(&tmp, &dest) {
        let _ = std::fs::remove_file(&tmp);
        return Err(LockError::Io(e));
    }
    // Diagnostics only: the barrier is best effort here.
    let _ = sync_dir(dir);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "mdbn-local-host-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn second_acquire_fails_until_release_and_reports_the_holder() {
        let root = tmp("lock");
        assert!(!HostLock::is_held(&root, ".mdbase").unwrap());
        let a = HostLock::try_acquire(
            &root,
            ".mdbase",
            Some(Descriptor::new(HostKind::Library, 1)),
        )
        .unwrap();
        assert!(HostLock::is_held(&root, ".mdbase").unwrap());
        match HostLock::try_acquire(&root, ".mdbase", None) {
            Err(LockError::Held(Some(d))) => assert_eq!(d.host, HostKind::Library),
            other => panic!("{other:?}"),
        }
        assert_eq!(
            read_descriptor(&root, ".mdbase").unwrap().host,
            HostKind::Library
        );
        drop(a);
        assert!(!HostLock::is_held(&root, ".mdbase").unwrap());
        assert!(read_descriptor(&root, ".mdbase").is_none());
        assert!(
            root.join(".mdbase/host.lock").exists(),
            "stable inode stays"
        );
        let _b = HostLock::try_acquire(&root, ".mdbase", None).unwrap();
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn foreign_descriptor_survives_our_release() {
        let root = tmp("foreign");
        std::fs::create_dir_all(root.join(".mdbase")).unwrap();
        let obsidian = Descriptor {
            host: HostKind::Obsidian,
            pid: None,
            device: None,
            since_ms: 5,
            heartbeat_ms: 5,
        };
        write_descriptor_in(&root.join(".mdbase"), &obsidian).unwrap();
        let lock = HostLock::try_acquire(&root, ".mdbase", None).unwrap();
        drop(lock);
        assert_eq!(read_descriptor(&root, ".mdbase"), Some(obsidian));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn oversized_or_malformed_descriptor_is_unreadable_not_absent() {
        let root = tmp("bad");
        assert_eq!(descriptor_state(&root, ".mdbase"), DescriptorState::Absent);
        std::fs::create_dir_all(root.join(".mdbase")).unwrap();
        std::fs::write(root.join(".mdbase/host.json"), "{not json").unwrap();
        assert!(read_descriptor(&root, ".mdbase").is_none());
        assert!(matches!(
            descriptor_state(&root, ".mdbase"),
            DescriptorState::Unreadable(_)
        ));
        std::fs::write(root.join(".mdbase/host.json"), vec![b' '; 5000]).unwrap();
        assert!(matches!(
            descriptor_state(&root, ".mdbase"),
            DescriptorState::Unreadable(_)
        ));
        std::fs::remove_file(root.join(".mdbase/host.json")).unwrap();
        std::fs::create_dir(root.join(".mdbase/host.json")).unwrap();
        assert!(matches!(
            descriptor_state(&root, ".mdbase"),
            DescriptorState::Unreadable(_)
        ));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn non_regular_lock_file_is_refused_before_open() {
        let root = tmp("fifo");
        std::fs::create_dir_all(root.join(".mdbase")).unwrap();
        let ok = std::process::Command::new("mkfifo")
            .arg(root.join(".mdbase/host.lock"))
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        assert!(ok, "mkfifo");
        assert!(matches!(
            HostLock::try_acquire(&root, ".mdbase", None),
            Err(LockError::Unsafe(_))
        ));
        assert!(matches!(
            HostLock::is_held(&root, ".mdbase"),
            Err(LockError::Unsafe(_))
        ));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_private_dir_is_refused() {
        let root = tmp("sym");
        let elsewhere = tmp("elsewhere");
        std::os::unix::fs::symlink(&elsewhere, root.join(".mdbase")).unwrap();
        assert!(matches!(
            HostLock::try_acquire(&root, ".mdbase", None),
            Err(LockError::Unsafe(_))
        ));
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&elsewhere);
    }
}
