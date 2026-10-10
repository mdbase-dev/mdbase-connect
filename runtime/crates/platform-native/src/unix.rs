//! Linux and macOS primitives. Safe code only: renames, `syncfs`,
//! `F_FULLFSYNC` and Linux xattrs go through `rustix`; the macOS calls rustix
//! lacks are in `crate::macos`.
//!
//! | need | Linux | macOS |
//! |---|---|---|
//! | swap | `renameat2(RENAME_EXCHANGE)` | `renameatx_np(RENAME_SWAP)`, only with `VOL_CAP_INT_RENAME_SWAP` (FAT32 "succeeds" with a plain rename) |
//! | no-replace rename | `renameat2(RENAME_NOREPLACE)`, else `link` + `unlink` | `renameatx_np(RENAME_EXCL)` |
//! | barrier | `syncfs` | `fcntl(F_BARRIERFSYNC)` |
//! | full | `syncfs` | `fcntl(F_FULLFSYNC)` |
//! | metadata carry-over | mode + `user.*` xattrs | `copyfile(ACL\|XATTR)`, mode, creation date |

use std::fs;
use std::io;
use std::os::fd::OwnedFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

use mdbn_store_file::platform::{
    Capabilities, CaseSensitivity, DirEntry, Durability, EventFidelity, FileId, FileKind, FileMeta,
    FsError, FsResult, LockHandle, LockShare, ReadResult, RelPath, ReplaceStrategy,
};
use rustix::fs::{
    AtFlags, Mode, OFlags, RenameFlags, linkat, mkdirat, openat, renameat_with, statat,
};
use rustix::io::Errno;

use crate::native::kind_of;

// ------------------------------------------------------- root-relative paths
//
// Path confinement: every collection path is resolved from
// a directory descriptor of the root, one component at a time, with
// `O_NOFOLLOW`. A symlink anywhere in the path (to outside the root or to
// inside it) is never followed: it fails with `ELOOP`/`ENOTDIR`, so neither a
// read nor a write can land outside the root, and a component swapped for a
// symlink between checks cannot redirect the operation (no check-then-use).

/// The collection root, held open as a directory.
pub(crate) struct Root {
    fd: OwnedFd,
    path: PathBuf,
}

const DIR: OFlags = OFlags::RDONLY
    .union(OFlags::DIRECTORY)
    .union(OFlags::NOFOLLOW)
    .union(OFlags::CLOEXEC);

/// A file's directory, held open, and its name in it.
struct At {
    dir: OwnedFd,
    name: String,
}

impl Root {
    pub(crate) fn open(path: &Path) -> io::Result<Root> {
        // The root itself is the caller's choice and may be reached through a
        // symlink; nothing under it is.
        let fd = rustix::fs::open(
            path,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
            Mode::empty(),
        )?;
        Ok(Root {
            fd,
            path: path.to_path_buf(),
        })
    }

    /// The path, for the path-based macOS metadata calls.
    #[cfg(target_os = "macos")]
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    /// The directory `segs` under the root. `create`: make missing components.
    fn dir(&self, segs: &[&str], create: bool) -> io::Result<OwnedFd> {
        let mut cur = openat(&self.fd, ".", DIR, Mode::empty())?;
        for s in segs {
            cur = match openat(&cur, *s, DIR, Mode::empty()) {
                Ok(fd) => fd,
                Err(Errno::NOENT) if create => {
                    match mkdirat(&cur, *s, Mode::from_raw_mode(0o777)) {
                        Ok(()) | Err(Errno::EXIST) => {}
                        Err(e) => return Err(e.into()),
                    }
                    openat(&cur, *s, DIR, Mode::empty())?
                }
                Err(e) => return Err(e.into()),
            };
        }
        Ok(cur)
    }

    fn at(&self, p: &RelPath, create_parent: bool) -> io::Result<At> {
        let segs = segs(p)?;
        let Some((name, parents)) = segs.split_last() else {
            return Err(io::Error::from(io::ErrorKind::InvalidInput));
        };
        Ok(At {
            dir: self.dir(parents, create_parent)?,
            name: (*name).to_string(),
        })
    }

    /// Open a file under the root without following a symlink in any component.
    fn open_file(&self, p: &RelPath, flags: OFlags) -> io::Result<fs::File> {
        let at = self.at(p, false)?;
        let fd = openat(
            &at.dir,
            at.name.as_str(),
            flags | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::from_raw_mode(0o666),
        )?;
        Ok(fs::File::from(fd))
    }
}

/// The plain segments of a validated collection path.
fn segs(p: &RelPath) -> io::Result<Vec<&str>> {
    p.as_str()
        .split('/')
        .filter(|s| !s.is_empty())
        .map(|s| {
            if s == "." || s == ".." {
                Err(io::Error::from(io::ErrorKind::InvalidInput))
            } else {
                Ok(s)
            }
        })
        .collect()
}

/// Apply the macOS sticky backup exclusion through a no-follow directory
/// descriptor, never a check-then-use absolute path.
#[cfg(target_os = "macos")]
pub(crate) fn exclude_from_backup(root: &Root, p: &RelPath) -> io::Result<()> {
    let fd = root.dir(&segs(p)?, false)?;
    crate::macos::exclude_from_backup(&fd)
}

/// A path component is a symlink (or not a directory): not collection content.
pub(crate) fn is_link_refusal(e: &io::Error) -> bool {
    matches!(
        e.raw_os_error().map(Errno::from_raw_os_error),
        Some(Errno::LOOP) | Some(Errno::NOTDIR) | Some(Errno::MLINK)
    )
}

// Field widths differ between Linux and macOS (`st_dev` is `i32` there).
#[allow(clippy::unnecessary_cast)]
fn meta_of(st: &rustix::fs::Stat) -> FileMeta {
    let kind = match rustix::fs::FileType::from_raw_mode(st.st_mode as _) {
        rustix::fs::FileType::RegularFile => FileKind::File,
        rustix::fs::FileType::Directory => FileKind::Dir,
        _ => FileKind::Other,
    };
    let (mtime, mtime_nsec) = (st.st_mtime as i64, st.st_mtime_nsec as i64);
    let (ctime, ctime_nsec) = (st.st_ctime as i64, st.st_ctime_nsec as i64);
    FileMeta {
        kind,
        size: st.st_size as u64,
        mtime_ns: mtime
            .saturating_mul(1_000_000_000)
            .saturating_add(mtime_nsec),
        ctime_ns: Some(
            ctime
                .saturating_mul(1_000_000_000)
                .saturating_add(ctime_nsec),
        ),
        id: Some(FileId(
            (u128::from(st.st_dev as u64) << 64) | u128::from(st.st_ino as u64),
        )),
    }
}

/// What `p` is. A path under a symlinked (or non-directory) component is not
/// in the collection: it reports [`FileKind::Other`], never what the link
/// points at.
pub(crate) fn stat_at(root: &Root, p: &RelPath) -> io::Result<FileMeta> {
    let segs = segs(p)?;
    let Some((name, parents)) = segs.split_last() else {
        return file_meta(&fs::File::from(openat(&root.fd, ".", DIR, Mode::empty())?));
    };
    let dir = match root.dir(parents, false) {
        Ok(d) => d,
        Err(e) if is_link_refusal(&e) => {
            return Ok(FileMeta {
                kind: FileKind::Other,
                size: 0,
                mtime_ns: 0,
                ctime_ns: None,
                id: None,
            });
        }
        Err(e) => return Err(e),
    };
    Ok(meta_of(&statat(&dir, *name, AtFlags::SYMLINK_NOFOLLOW)?))
}

/// Open `p` for reading: never through a symlink, never blocking on a FIFO.
/// The caller checks the handle is a regular file.
pub(crate) fn open_read(root: &Root, p: &RelPath) -> io::Result<fs::File> {
    root.open_file(p, OFlags::RDONLY | OFlags::NONBLOCK)
}

/// Exclusive create of `p` (its directory must exist).
pub(crate) fn create_new(root: &Root, p: &RelPath) -> io::Result<fs::File> {
    root.open_file(p, OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL)
}

/// Open `p` for appending.
pub(crate) fn open_append(root: &Root, p: &RelPath) -> io::Result<fs::File> {
    root.open_file(p, OFlags::WRONLY | OFlags::APPEND)
}

/// The entries of directory `p`. Symlinks are listed as [`FileKind::Other`].
pub(crate) fn list(root: &Root, p: &RelPath) -> io::Result<Vec<DirEntry>> {
    let dir = root.dir(&segs(p)?, false)?;
    let mut out = Vec::new();
    for e in rustix::fs::Dir::read_from(&dir)? {
        let e = e?;
        let raw = e.file_name().to_bytes();
        if raw == b"." || raw == b".." {
            continue;
        }
        let ft = match e.file_type() {
            rustix::fs::FileType::Unknown => rustix::fs::FileType::from_raw_mode(
                statat(&dir, e.file_name(), AtFlags::SYMLINK_NOFOLLOW)?.st_mode as _,
            ),
            t => t,
        };
        let kind = match ft {
            rustix::fs::FileType::RegularFile => FileKind::File,
            rustix::fs::FileType::Directory => FileKind::Dir,
            _ => FileKind::Other,
        };
        match std::ffi::OsStr::from_bytes(raw).to_str() {
            Some(n) => out.push(DirEntry {
                name: n.to_string(),
                kind,
            }),
            // Not UTF-8: cannot be a collection path. Report it as "other" so
            // the store can surface it, never touch it.
            None => out.push(DirEntry {
                name: String::from_utf8_lossy(raw).into_owned(),
                kind: FileKind::Other,
            }),
        }
    }
    Ok(out)
}

/// `mkdir -p` of `p`, refusing to pass through a symlink.
pub(crate) fn create_dir_all(root: &Root, p: &RelPath) -> io::Result<()> {
    root.dir(&segs(p)?, true).map(drop)
}

pub(crate) fn remove_file(root: &Root, p: &RelPath) -> io::Result<()> {
    let at = root.at(p, false)?;
    Ok(rustix::fs::unlinkat(
        &at.dir,
        at.name.as_str(),
        AtFlags::empty(),
    )?)
}

fn renamex(root: &Root, a: &RelPath, b: &RelPath, flags: RenameFlags) -> io::Result<()> {
    let (a, b) = (root.at(a, false)?, root.at(b, false)?);
    Ok(renameat_with(
        &a.dir,
        a.name.as_str(),
        &b.dir,
        b.name.as_str(),
        flags,
    )?)
}

pub(crate) fn exchange(root: &Root, a: &RelPath, b: &RelPath) -> io::Result<()> {
    renamex(root, a, b, RenameFlags::EXCHANGE)
}

pub(crate) fn rename_noreplace(root: &Root, a: &RelPath, b: &RelPath) -> io::Result<()> {
    match renamex(root, a, b, RenameFlags::NOREPLACE) {
        // Linux file systems without RENAME_NOREPLACE: link() refuses an
        // existing target atomically, then drop the old name.
        Err(e)
            if cfg!(target_os = "linux")
                && e.raw_os_error() == Some(Errno::INVAL.raw_os_error()) =>
        {
            let (fa, fb) = (root.at(a, false)?, root.at(b, false)?);
            linkat(
                &fa.dir,
                fa.name.as_str(),
                &fb.dir,
                fb.name.as_str(),
                AtFlags::empty(),
            )?;
            Ok(rustix::fs::unlinkat(
                &fa.dir,
                fa.name.as_str(),
                AtFlags::empty(),
            )?)
        }
        r => r,
    }
}

pub(crate) fn sync_file(root: &Root, p: &RelPath) -> io::Result<()> {
    open_read(root, p)?.sync_all()
}

pub(crate) fn sync_dir(root: &Root, p: &RelPath) -> io::Result<()> {
    fs::File::from(root.dir(&segs(p)?, false)?).sync_all()
}

/// Unix has no lock primitives ([`Locks`] refuses); the path is never opened.
pub(crate) fn lock_path(root: &Root, p: &RelPath) -> io::Result<PathBuf> {
    crate::native::abs(&root.path, p).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))
}

pub(crate) fn meta(m: &fs::Metadata) -> FileMeta {
    FileMeta {
        kind: kind_of(m.file_type()),
        size: m.len(),
        mtime_ns: m
            .mtime()
            .saturating_mul(1_000_000_000)
            .saturating_add(m.mtime_nsec()),
        ctime_ns: Some(
            m.ctime()
                .saturating_mul(1_000_000_000)
                .saturating_add(m.ctime_nsec()),
        ),
        id: Some(FileId((u128::from(m.dev()) << 64) | u128::from(m.ino()))),
    }
}

pub(crate) fn file_meta(f: &fs::File) -> io::Result<FileMeta> {
    Ok(meta(&f.metadata()?))
}

/// Swap two paths in the private probe (absolute paths, not collection paths).
fn exchange_paths(a: &Path, b: &Path) -> io::Result<()> {
    Ok(renameat_with(
        rustix::fs::CWD,
        a,
        rustix::fs::CWD,
        b,
        RenameFlags::EXCHANGE,
    )?)
}

#[cfg(target_os = "linux")]
pub(crate) fn barrier(root: &Path) -> io::Result<()> {
    Ok(rustix::fs::syncfs(fs::File::open(root)?)?)
}

#[cfg(target_os = "linux")]
pub(crate) fn full_sync(root: &Path) -> io::Result<()> {
    Ok(rustix::fs::syncfs(fs::File::open(root)?)?)
}

#[cfg(target_os = "macos")]
pub(crate) fn barrier(root: &Path) -> io::Result<()> {
    let f = fs::File::open(root)?;
    // Some volumes refuse F_BARRIERFSYNC: fall back to fsync.
    crate::macos::barrier_fsync(&f).or_else(|_| f.sync_all())
}

#[cfg(target_os = "macos")]
pub(crate) fn full_sync(root: &Path) -> io::Result<()> {
    let f = fs::File::open(root)?;
    // Full is a required device commit point, not ordinary fsync. Refusing
    // volumes fail closed; retry only bounded EINTR, never downgrade.
    crate::durability::full_sync_fd(&f)
}

/// Copy permissions and user xattrs (Linux), through handles opened without
/// following a symlink in any component.
#[cfg(target_os = "linux")]
pub(crate) fn copy_metadata(root: &Root, from: &RelPath, to: &RelPath) -> io::Result<()> {
    use rustix::fs::{XattrFlags, fgetxattr, flistxattr, fsetxattr};
    let from = open_read(root, from)?;
    let to = open_read(root, to)?;
    let m = from.metadata()?;
    if !m.is_file() || !to.metadata()?.is_file() {
        return Err(io::Error::from(io::ErrorKind::InvalidInput));
    }
    to.set_permissions(m.permissions())?;
    let n = match flistxattr(&from, &mut [0u8; 0][..]) {
        Ok(n) if n > 0 => n,
        _ => return Ok(()),
    };
    let mut names = vec![0u8; n];
    let Ok(n) = flistxattr(&from, &mut names[..]) else {
        return Ok(());
    };
    for name in names[..n].split(|b| *b == 0).filter(|s| !s.is_empty()) {
        // Only user.* attributes are ours to carry; security.* and trusted.*
        // need privileges and are set by the system.
        if !name.starts_with(b"user.") {
            continue;
        }
        let Ok(name) = std::str::from_utf8(name) else {
            continue;
        };
        let Ok(len) = fgetxattr(&from, name, &mut [0u8; 0][..]) else {
            continue;
        };
        let mut val = vec![0u8; len];
        let Ok(len) = fgetxattr(&from, name, &mut val[..]) else {
            continue;
        };
        let _ = fsetxattr(&to, name, &val[..len], XattrFlags::empty());
    }
    Ok(())
}

/// Copy ACLs, xattrs (Finder tags), mode and creation date. Never
/// `COPYFILE_STAT`/`METADATA`: those also copy timestamps.
///
/// `copyfile` and `setattrlist` take paths: both paths are first checked to be
/// regular files reached without a symlink. Metadata only (never content); a
/// local race can at most misdirect this metadata copy.
#[cfg(target_os = "macos")]
pub(crate) fn copy_metadata(root: &Root, from: &RelPath, to: &RelPath) -> io::Result<()> {
    for p in [from, to] {
        if stat_at(root, p)?.kind != FileKind::File {
            return Err(io::Error::from(io::ErrorKind::InvalidInput));
        }
    }
    let from = &crate::native::abs(root.path(), from)
        .map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
    let to = &crate::native::abs(root.path(), to)
        .map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
    let m = fs::symlink_metadata(from)?;
    crate::macos::copy_acl_xattr(from, to)?;
    fs::set_permissions(to, m.permissions())?;
    // Creation date is best effort (some volumes have none).
    let _ = crate::macos::copy_crtime(from, to);
    Ok(())
}

/// Probe the volume under `private` (inside `root`).
pub(crate) fn probe(_root: &Path, private: &Path) -> io::Result<Capabilities> {
    let pid = std::process::id();
    let a = private.join(format!("probe-{pid}-Aa"));
    let b = private.join(format!("probe-{pid}-b"));
    let _ = fs::remove_file(&a);
    let _ = fs::remove_file(&b);
    fs::write(&a, b"a")?;
    fs::write(&b, b"b")?;
    let case = if fs::symlink_metadata(private.join(format!("probe-{pid}-aa"))).is_ok() {
        CaseSensitivity::Insensitive
    } else {
        CaseSensitivity::Sensitive
    };
    #[cfg(target_os = "macos")]
    let gate = crate::macos::volume_can_swap(private).unwrap_or(false);
    #[cfg(target_os = "linux")]
    let gate = true;
    // Swap only counts if it really swapped (never trust the return code alone).
    let swaps =
        gate && exchange_paths(&a, &b).is_ok() && fs::read(&a)? == b"b" && fs::read(&b)? == b"a";
    let _ = fs::remove_file(&a);
    let _ = fs::remove_file(&b);
    Ok(Capabilities {
        replace: if swaps {
            ReplaceStrategy::Exchange
        } else {
            ReplaceStrategy::ReadOnly
        },
        exclusive_create: true,
        durability: Durability::Fsync,
        case,
        file_ids: true,
        mtime_resolution_ns: 1,
        events: EventFidelity::Precise,
        transient_missing: cfg!(target_os = "macos"),
        private_dir: RelPath::ROOT,
    })
}

/// No locked-handle primitives on Unix (no mandatory locks).
#[derive(Default)]
pub(crate) struct Locks {
    _none: (),
}

impl Locks {
    pub(crate) fn lock(&self, _p: &Path, _s: LockShare) -> FsResult<LockHandle> {
        Err(FsError::unsupported("lock"))
    }
    pub(crate) fn read(&self, _h: LockHandle) -> FsResult<ReadResult> {
        Err(FsError::unsupported("locked_read"))
    }
    pub(crate) fn overwrite(&self, _h: LockHandle, _b: &[u8], _d: bool) -> FsResult<()> {
        Err(FsError::unsupported("locked_overwrite"))
    }
    pub(crate) fn move_aside(&self, _h: LockHandle, _to: &Path) -> FsResult<()> {
        Err(FsError::unsupported("locked_move_aside"))
    }
    pub(crate) fn unlock(&self, _h: LockHandle) -> FsResult<()> {
        Err(FsError::unsupported("unlock"))
    }
}
