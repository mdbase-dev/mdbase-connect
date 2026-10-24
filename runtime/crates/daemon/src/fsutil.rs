//! Small durable-file helpers for the daemon's own state (never collection files:
//! those go through `FilePlatform`).

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::Path;

/// Create `dir` (and parents) and make it owner-only (0700 on Unix). On Unix it
/// must be a real directory (not a symlink) owned by this user, or this fails. On
/// Windows the directory inherits `%LOCALAPPDATA%`'s per-user ACL.
pub fn ensure_private_dir(dir: &Path) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let meta = fs::symlink_metadata(dir)?;
        if !meta.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!(
                    "{} is not a directory (symlinks are refused)",
                    dir.display()
                ),
            ));
        }
        if meta.uid() != euid() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!(
                    "{} is owned by uid {}, not this user",
                    dir.display(),
                    meta.uid()
                ),
            ));
        }
        if meta.permissions().mode() & 0o777 != 0o700 {
            fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
        }
    }
    Ok(())
}

/// This process's effective user ID.
#[cfg(unix)]
#[allow(unsafe_code)]
pub fn euid() -> u32 {
    // SAFETY: geteuid has no preconditions and cannot fail.
    unsafe { libc::geteuid() }
}

/// Check that `path` can be trusted as written only by this user: on
/// Unix, not a symlink, owned by this user, and not writable by group or others.
/// On Windows the location (`%LOCALAPPDATA%`, a per-user profile directory) is the
/// guarantee, so this checks only that it is not a reparse point.
pub fn verify_owner_only(path: &Path) -> io::Result<()> {
    let meta = fs::symlink_metadata(path)?;
    if meta.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("{} is a symlink", path.display()),
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if meta.uid() != euid() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!("{} is not owned by this user", path.display()),
            ));
        }
        if meta.permissions().mode() & 0o022 != 0 {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!("{} is writable by other users", path.display()),
            ));
        }
    }
    Ok(())
}

/// Write `bytes` to `path` atomically and durably: a temp file in the same
/// directory, fsync, rename over `path`, fsync the directory. A crash leaves either
/// the old or the new content, never a torn file.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no parent"))?;
    let name = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no file name"))?;
    let tmp = dir.join(format!(
        ".{}.tmp-{}",
        name.to_string_lossy(),
        std::process::id()
    ));
    {
        let mut opts = OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    sync_dir(dir)
}

/// fsync a directory so a rename in it is durable (no-op on Windows, where
/// `MoveFileEx` metadata is journaled by NTFS).
pub fn sync_dir(dir: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        fs::File::open(dir)?.sync_all()?;
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
    }
    Ok(())
}

/// Read a file, or `None` if it does not exist.
pub fn read_optional(path: &Path) -> io::Result<Option<Vec<u8>>> {
    match fs::read(path) {
        Ok(b) => Ok(Some(b)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// Move a malformed state file aside (`<name>.corrupt-<ms>`) so it is preserved
/// for diagnosis and never silently overwritten.
pub fn quarantine(path: &Path, now_ms: u128) -> io::Result<std::path::PathBuf> {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".corrupt-{now_ms}"));
    let to = path.with_file_name(name);
    fs::rename(path, &to)?;
    Ok(to)
}

/// Milliseconds since the Unix epoch (wall clock; daemon bookkeeping only, never
/// replica semantics, which take time from `mdbn_core::host::Clock`).
pub fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_write_replaces_and_reads_back() {
        let dir = crate::testutil::TestDir::new("fsutil");
        let p = dir.path().join("x.json");
        assert_eq!(read_optional(&p).unwrap(), None);
        write_atomic(&p, b"one").unwrap();
        write_atomic(&p, b"two").unwrap();
        assert_eq!(read_optional(&p).unwrap().as_deref(), Some(&b"two"[..]));
        let names: Vec<_> = fs::read_dir(dir.path()).unwrap().collect();
        assert_eq!(names.len(), 1, "no temp files left behind");
    }
}
