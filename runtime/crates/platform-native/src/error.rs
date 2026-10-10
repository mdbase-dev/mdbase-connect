//! `std::io::Error` → `FsError`.

use std::io;

use mdbn_store_file::platform::{FsError, FsErrorKind};

/// Map an OS error to the categories the protocols branch on.
pub(crate) fn fs_err(e: io::Error, what: &str) -> FsError {
    FsError::new(kind_of(&e), format!("{what}: {e}"))
}

fn kind_of(e: &io::Error) -> FsErrorKind {
    if let Some(code) = e.raw_os_error()
        && let Some(k) = os_kind(code)
    {
        return k;
    }
    match e.kind() {
        io::ErrorKind::NotFound => FsErrorKind::NotFound,
        io::ErrorKind::AlreadyExists => FsErrorKind::AlreadyExists,
        io::ErrorKind::PermissionDenied => FsErrorKind::PermissionDenied,
        io::ErrorKind::Unsupported => FsErrorKind::Unsupported,
        io::ErrorKind::StorageFull | io::ErrorKind::QuotaExceeded => FsErrorKind::NoSpace,
        io::ErrorKind::NotADirectory | io::ErrorKind::IsADirectory => FsErrorKind::WrongKind,
        io::ErrorKind::InvalidFilename => FsErrorKind::InvalidPath,
        _ => FsErrorKind::Other,
    }
}

#[cfg(unix)]
fn os_kind(code: i32) -> Option<FsErrorKind> {
    use rustix::io::Errno;
    let e = Errno::from_raw_os_error(code);
    Some(if e == Errno::NOENT {
        FsErrorKind::NotFound
    } else if e == Errno::EXIST || e == Errno::NOTEMPTY {
        FsErrorKind::AlreadyExists
    } else if e == Errno::BUSY || e == Errno::TXTBSY {
        FsErrorKind::Busy
    } else if e == Errno::NOSPC || e == Errno::DQUOT {
        FsErrorKind::NoSpace
    } else if e == Errno::NOTDIR || e == Errno::ISDIR || e == Errno::LOOP || e == Errno::MLINK {
        // LOOP/MLINK: `O_NOFOLLOW` met a symlink, never followed.
        FsErrorKind::WrongKind
    } else if e == Errno::NOSYS || e == Errno::NOTSUP || e == Errno::INVAL {
        FsErrorKind::Unsupported
    } else if e == Errno::NAMETOOLONG {
        FsErrorKind::InvalidPath
    } else {
        return None;
    })
}

#[cfg(windows)]
fn os_kind(code: i32) -> Option<FsErrorKind> {
    use windows_sys::Win32::Foundation::*;
    match code as u32 {
        ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND => Some(FsErrorKind::NotFound),
        ERROR_ALREADY_EXISTS | ERROR_FILE_EXISTS => Some(FsErrorKind::AlreadyExists),
        // Another handle is open in a conflicting mode: back off. (Access
        // denied at lock time is mapped to Busy by the lock itself.)
        ERROR_SHARING_VIOLATION | ERROR_LOCK_VIOLATION => Some(FsErrorKind::Busy),
        ERROR_ACCESS_DENIED => Some(FsErrorKind::PermissionDenied),
        ERROR_DISK_FULL | ERROR_HANDLE_DISK_FULL => Some(FsErrorKind::NoSpace),
        ERROR_INVALID_NAME | ERROR_FILENAME_EXCED_RANGE => Some(FsErrorKind::InvalidPath),
        ERROR_NOT_SUPPORTED => Some(FsErrorKind::Unsupported),
        _ => None,
    }
}
