//! Linux FFI that `rustix` does not cover: `F_SETLEASE`.
//!
//! A write lease (`F_WRLCK`) is granted only when no other open file
//! description exists for the file. That answers "can anyone still write into
//! this retained inode?" exactly, for
//! files the caller owns (or with `CAP_LEASE`). NFS and most FUSE file systems
//! refuse leases; the answer is then `Unknown`.

use std::fs;
use std::io;
use std::os::fd::AsRawFd;

use mdbn_store_file::platform::Holders;

/// Whether any other open file description exists for the file `f` names
/// (opened read-only by the caller, without following a symlink).
pub(crate) fn other_holders(f: &fs::File) -> io::Result<Holders> {
    let fd = f.as_raw_fd();
    // SAFETY: `fd` is open for the duration of the call; F_SETLEASE takes an
    // int argument.
    let r = unsafe { libc::fcntl(fd, libc::F_SETLEASE, libc::F_WRLCK) };
    if r == 0 {
        // SAFETY: as above; releases the lease we just took.
        unsafe { libc::fcntl(fd, libc::F_SETLEASE, libc::F_UNLCK) };
        return Ok(Holders::None);
    }
    let e = io::Error::last_os_error();
    Ok(match e.raw_os_error() {
        Some(libc::EAGAIN) | Some(libc::EBUSY) => Holders::Some,
        _ => Holders::Unknown,
    })
}
