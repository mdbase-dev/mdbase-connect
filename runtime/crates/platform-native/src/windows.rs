//! Windows primitives for protocol D (guarded in-place publication).
//!
//! - Replace: lock with `GENERIC_READ|GENERIC_WRITE|DELETE`, share `FILE_SHARE_READ`
//!   (or none), verify through the handle, overwrite in place, `SetEndOfFile`,
//!   `FlushFileBuffers`. The path never disappears; file ID, ACLs, ADS and
//!   creation time survive.
//! - Create: temp + `MoveFileExW` without `MOVEFILE_REPLACE_EXISTING`.
//! - Delete: the same lock, verify, rename by handle into the private directory
//!   (`FileRenameInfo`, no replace).
//!
//! `DELETE` access in the lock means the lock also fails while another handle
//! without `FILE_SHARE_DELETE` is open: that is reported as `Busy`, like a
//! sharing violation, and the store retries later.

use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};

use mdbn_store_file::platform::{
    Capabilities, CaseSensitivity, DirEntry, Durability, EventFidelity, FileId, FileMeta, FsError,
    FsErrorKind, FsResult, LockHandle, LockShare, ReadResult, RelPath, ReplaceStrategy,
};
use windows_sys::Win32::Foundation::{ERROR_ACCESS_DENIED, GENERIC_READ, GENERIC_WRITE, HANDLE};
use windows_sys::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, DELETE, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_RENAME_INFO, FILE_SHARE_DELETE,
    FILE_SHARE_READ, FILE_SHARE_WRITE, FileRenameInfo, GetFileInformationByHandle,
    MOVEFILE_WRITE_THROUGH, MoveFileExW, SetFileInformationByHandle,
};

use crate::error::fs_err;
use crate::native::kind_of;

/// 100 ns ticks between 1601-01-01 and 1970-01-01.
const EPOCH_DIFF: i64 = 116_444_736_000_000_000;

fn wide(p: &Path) -> Vec<u16> {
    p.as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

fn ticks_to_ns(t: u64) -> i64 {
    (t as i64 - EPOCH_DIFF).saturating_mul(100)
}

fn handle_info(h: HANDLE) -> io::Result<BY_HANDLE_FILE_INFORMATION> {
    // SAFETY: BY_HANDLE_FILE_INFORMATION is plain old data; all-zero is valid.
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: `h` is a valid open handle and `info` a valid out-parameter.
    if unsafe { GetFileInformationByHandle(h, &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(info)
}

fn meta_from(m: &fs::Metadata, info: Option<&BY_HANDLE_FILE_INFORMATION>) -> FileMeta {
    FileMeta {
        kind: kind_of(m.file_type()),
        size: m.len(),
        mtime_ns: ticks_to_ns(m.last_write_time()),
        ctime_ns: None,
        id: info.map(|i| {
            FileId(
                (u128::from(i.dwVolumeSerialNumber) << 64)
                    | (u128::from(i.nFileIndexHigh) << 32)
                    | u128::from(i.nFileIndexLow),
            )
        }),
    }
}

pub(crate) fn meta(m: &fs::Metadata) -> FileMeta {
    meta_from(m, None)
}

// ------------------------------------------------------- root-relative paths
//
// Path confinement: no collection operation passes through a
// symlink, junction or other reparse point under the root. Windows has no
// `openat` in std, so each existing ancestor is checked (`FindFirstFile`-style
// metadata, never traversing) before the path is used, and final components
// are opened with `FILE_FLAG_OPEN_REPARSE_POINT` and checked through the
// handle. Residual: a local process that swaps a checked directory for a
// junction between the check and the call; a remote peer cannot create one.

/// The collection root.
pub(crate) struct Root {
    path: PathBuf,
}

impl Root {
    pub(crate) fn open(path: &Path) -> io::Result<Root> {
        Ok(Root {
            path: path.to_path_buf(),
        })
    }
}

fn link_refusal() -> io::Error {
    io::Error::new(
        io::ErrorKind::NotADirectory,
        "a path component is a symlink, junction or not a directory",
    )
}

/// A path component is a link (or not a directory): not collection content.
pub(crate) fn is_link_refusal(e: &io::Error) -> bool {
    e.kind() == io::ErrorKind::NotADirectory
}

fn is_link(m: &fs::Metadata) -> bool {
    m.file_type().is_symlink() || m.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

/// The absolute path of `p` once no existing ancestor under the root is a
/// link or a non-directory.
fn checked(root: &Root, p: &RelPath) -> io::Result<PathBuf> {
    let full = crate::native::abs(&root.path, p)
        .map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
    let segs: Vec<&str> = p.as_str().split('/').filter(|s| !s.is_empty()).collect();
    let mut cur = root.path.clone();
    for s in segs.iter().take(segs.len().saturating_sub(1)) {
        cur.push(s);
        match fs::symlink_metadata(&cur) {
            Ok(m) if is_link(&m) || !m.is_dir() => return Err(link_refusal()),
            Ok(_) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => break,
            Err(e) => return Err(e),
        }
    }
    Ok(full)
}

/// `checked`, and the final component, if it exists, is not a link either.
fn checked_dir(root: &Root, p: &RelPath) -> io::Result<PathBuf> {
    let full = checked(root, p)?;
    match fs::symlink_metadata(&full) {
        Ok(m) if is_link(&m) => Err(link_refusal()),
        _ => Ok(full),
    }
}

fn other_meta() -> FileMeta {
    FileMeta {
        kind: mdbn_store_file::platform::FileKind::Other,
        size: 0,
        mtime_ns: 0,
        ctime_ns: None,
        id: None,
    }
}

/// What `p` is; a path under a link reports `Other`.
pub(crate) fn stat_at(root: &Root, p: &RelPath) -> io::Result<FileMeta> {
    match checked(root, p) {
        Ok(full) => stat(&full),
        Err(e) if is_link_refusal(&e) => Ok(other_meta()),
        Err(e) => Err(e),
    }
}

/// Open with `FILE_FLAG_OPEN_REPARSE_POINT` and refuse a reparse point.
fn open_no_reparse(opts: &mut fs::OpenOptions, p: &Path) -> io::Result<fs::File> {
    let f = opts.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT).open(p)?;
    let info = handle_info(f.as_raw_handle() as HANDLE)?;
    if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(link_refusal());
    }
    Ok(f)
}

pub(crate) fn open_read(root: &Root, p: &RelPath) -> io::Result<fs::File> {
    open_no_reparse(fs::OpenOptions::new().read(true), &checked(root, p)?)
}

pub(crate) fn create_new(root: &Root, p: &RelPath) -> io::Result<fs::File> {
    open_no_reparse(
        fs::OpenOptions::new().write(true).create_new(true),
        &checked(root, p)?,
    )
}

pub(crate) fn open_append(root: &Root, p: &RelPath) -> io::Result<fs::File> {
    open_no_reparse(fs::OpenOptions::new().append(true), &checked(root, p)?)
}

/// The entries of directory `p`. Links are listed as `Other`.
pub(crate) fn list(root: &Root, p: &RelPath) -> io::Result<Vec<DirEntry>> {
    let mut out = Vec::new();
    for e in fs::read_dir(checked_dir(root, p)?)? {
        let e = e?;
        let m = e.metadata()?;
        let kind = if is_link(&m) {
            mdbn_store_file::platform::FileKind::Other
        } else {
            kind_of(m.file_type())
        };
        match e.file_name().into_string() {
            Ok(name) => out.push(DirEntry { name, kind }),
            Err(os) => out.push(DirEntry {
                name: os.to_string_lossy().into_owned(),
                kind: mdbn_store_file::platform::FileKind::Other,
            }),
        }
    }
    Ok(out)
}

pub(crate) fn create_dir_all(root: &Root, p: &RelPath) -> io::Result<()> {
    fs::create_dir_all(checked_dir(root, p)?)
}

pub(crate) fn remove_file(root: &Root, p: &RelPath) -> io::Result<()> {
    fs::remove_file(checked(root, p)?)
}

/// The checked path for a lock handle (the lock refuses reparse points itself).
pub(crate) fn lock_path(root: &Root, p: &RelPath) -> io::Result<PathBuf> {
    checked(root, p)
}

/// Metadata plus file ID, through a handle opened for attributes only with
/// full sharing (never conflicts with an editor's handle).
pub(crate) fn stat(p: &Path) -> io::Result<FileMeta> {
    let m = fs::symlink_metadata(p)?;
    if is_link(&m) {
        return Ok(other_meta());
    }
    if !m.is_file() {
        return Ok(meta(&m));
    }
    let f = fs::OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
        .open(p)?;
    file_meta(&f)
}

pub(crate) fn file_meta(f: &fs::File) -> io::Result<FileMeta> {
    let m = f.metadata()?;
    let info = handle_info(f.as_raw_handle() as HANDLE)?;
    Ok(meta_from(&m, Some(&info)))
}

pub(crate) fn exchange(_root: &Root, _a: &RelPath, _b: &RelPath) -> io::Result<()> {
    Err(io::Error::from(io::ErrorKind::Unsupported))
}

pub(crate) fn rename_noreplace(root: &Root, a: &RelPath, b: &RelPath) -> io::Result<()> {
    let (wa, wb) = (wide(&checked(root, a)?), wide(&checked(root, b)?));
    // No MOVEFILE_REPLACE_EXISTING: an existing target fails with
    // ERROR_ALREADY_EXISTS. Write-through makes the rename durable on return.
    // SAFETY: both are NUL-terminated wide strings.
    if unsafe { MoveFileExW(wa.as_ptr(), wb.as_ptr(), MOVEFILE_WRITE_THROUGH) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

pub(crate) fn sync_file(root: &Root, p: &RelPath) -> io::Result<()> {
    open_no_reparse(fs::OpenOptions::new().write(true), &checked(root, p)?)?.sync_all()
}

/// NTFS journals metadata and renames use write-through: nothing to do.
pub(crate) fn sync_dir(_root: &Root, _p: &RelPath) -> io::Result<()> {
    Ok(())
}

/// Every write that matters is flushed through its own handle on Windows.
pub(crate) fn barrier(_root: &Path) -> io::Result<()> {
    Ok(())
}

pub(crate) fn full_sync(_root: &Path) -> io::Result<()> {
    Ok(())
}

/// Protocol D writes in place, so the file keeps its own metadata.
pub(crate) fn copy_metadata(_root: &Root, _from: &RelPath, _to: &RelPath) -> io::Result<()> {
    Ok(())
}

pub(crate) fn probe(_root: &Path, private: &Path) -> io::Result<Capabilities> {
    let pid = std::process::id();
    let a = private.join(format!("probe-{pid}-Aa"));
    fs::write(&a, b"a")?;
    let case = if fs::symlink_metadata(private.join(format!("probe-{pid}-aa"))).is_ok() {
        CaseSensitivity::Insensitive
    } else {
        CaseSensitivity::Sensitive
    };
    let _ = fs::remove_file(&a);
    Ok(Capabilities {
        replace: ReplaceStrategy::LockedInPlace,
        exclusive_create: true,
        durability: Durability::Fsync,
        case,
        file_ids: true,
        // NTFS: 100 ns. FAT volumes (2 s) are detected later by the store's
        // foreign/volume checks.
        mtime_resolution_ns: 100,
        events: EventFidelity::Precise,
        transient_missing: false,
        private_dir: RelPath::ROOT,
    })
}

struct Locked {
    file: fs::File,
    path: PathBuf,
}

/// Open lock handles.
#[derive(Default)]
pub(crate) struct Locks {
    next: Cell<u64>,
    open: RefCell<BTreeMap<u64, Locked>>,
}

fn lock_err(e: io::Error, what: &str) -> FsError {
    // ACCESS_DENIED at lock time is another handle's share mode, not a
    // permission problem: back off.
    if e.raw_os_error() == Some(ERROR_ACCESS_DENIED as i32) {
        return FsError::new(FsErrorKind::Busy, format!("{what}: {e}"));
    }
    fs_err(e, what)
}

impl Locks {
    pub(crate) fn lock(&self, p: &Path, share: LockShare) -> FsResult<LockHandle> {
        let share_mode = match share {
            LockShare::Read => FILE_SHARE_READ,
            LockShare::None => 0,
        };
        let file = fs::OpenOptions::new()
            .access_mode(GENERIC_READ | GENERIC_WRITE | DELETE)
            .share_mode(share_mode)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(p)
            .map_err(|e| lock_err(e, "lock"))?;
        // Only plain files with one link (plain-file confinement): never write through a
        // reparse point or into a hard-linked file another path shares.
        let info =
            handle_info(file.as_raw_handle() as HANDLE).map_err(|e| fs_err(e, "lock info"))?;
        if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 || info.nNumberOfLinks != 1 {
            return Err(FsError::new(
                FsErrorKind::WrongKind,
                "lock: not a plain single-link file",
            ));
        }
        let id = self.next.get();
        self.next.set(id + 1);
        self.open.borrow_mut().insert(
            id,
            Locked {
                file,
                path: p.to_path_buf(),
            },
        );
        Ok(LockHandle(id))
    }

    fn with<T>(
        &self,
        h: LockHandle,
        f: impl FnOnce(&mut Locked) -> io::Result<T>,
        what: &str,
    ) -> FsResult<T> {
        let mut open = self.open.borrow_mut();
        let l = open
            .get_mut(&h.0)
            .ok_or_else(|| FsError::new(FsErrorKind::BadHandle, format!("{h:?}")))?;
        f(l).map_err(|e| fs_err(e, what))
    }

    pub(crate) fn read(&self, h: LockHandle) -> FsResult<ReadResult> {
        self.with(
            h,
            |l| {
                l.file.seek(SeekFrom::Start(0))?;
                let mut bytes = Vec::new();
                l.file.read_to_end(&mut bytes)?;
                let meta = file_meta(&l.file)?;
                Ok(ReadResult { bytes, meta })
            },
            "locked_read",
        )
    }

    pub(crate) fn overwrite(&self, h: LockHandle, bytes: &[u8], durable: bool) -> FsResult<()> {
        self.with(
            h,
            |l| {
                // Write before truncating, so a reader never sees an empty file.
                l.file.seek(SeekFrom::Start(0))?;
                l.file.write_all(bytes)?;
                l.file.set_len(bytes.len() as u64)?;
                if durable {
                    l.file.sync_all()?;
                }
                Ok(())
            },
            "locked_overwrite",
        )
    }

    pub(crate) fn move_aside(&self, h: LockHandle, to: &Path) -> FsResult<()> {
        self.with(
            h,
            |l| {
                let name: Vec<u16> = to.as_os_str().encode_wide().collect();
                let header = std::mem::size_of::<FILE_RENAME_INFO>();
                let size = header + name.len() * 2;
                // u64 storage keeps the struct aligned.
                let mut buf = vec![0u64; size.div_ceil(8)];
                let info = buf.as_mut_ptr().cast::<FILE_RENAME_INFO>();
                // SAFETY: `buf` holds at least `size` bytes, aligned for the
                // struct; the name is copied into the trailing array.
                unsafe {
                    (*info).Anonymous.ReplaceIfExists = false;
                    (*info).RootDirectory = std::ptr::null_mut();
                    (*info).FileNameLength = (name.len() * 2) as u32;
                    std::ptr::copy_nonoverlapping(
                        name.as_ptr(),
                        (*info).FileName.as_mut_ptr(),
                        name.len(),
                    );
                }
                // SAFETY: valid handle with DELETE access and a well-formed buffer.
                let ok = unsafe {
                    SetFileInformationByHandle(
                        l.file.as_raw_handle() as HANDLE,
                        FileRenameInfo,
                        info.cast(),
                        size as u32,
                    )
                };
                if ok == 0 {
                    return Err(io::Error::last_os_error());
                }
                l.path = to.to_path_buf();
                Ok(())
            },
            "locked_move_aside",
        )
    }

    pub(crate) fn unlock(&self, h: LockHandle) -> FsResult<()> {
        self.open
            .borrow_mut()
            .remove(&h.0)
            .map(drop)
            .ok_or_else(|| FsError::new(FsErrorKind::BadHandle, format!("{h:?}")))
    }
}
