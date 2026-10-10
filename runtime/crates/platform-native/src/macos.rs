//! macOS FFI that `rustix` does not cover: `F_BARRIERFSYNC`,
//! `copyfile(ACL|XATTR)`, creation date via `setattrlist`, and the
//! `VOL_CAP_INT_RENAME_SWAP` capability via `getattrlist`.

use std::ffi::CString;
use std::fs;
use std::io;
use std::os::fd::{AsFd, AsRawFd};
use std::os::macos::fs::MetadataExt;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

/// Sticky Time Machine exclusion. These are the binary-plist bytes written
/// by tmutil, applied to an already opened no-follow directory descriptor.
pub(crate) fn exclude_from_backup(fd: impl AsFd) -> io::Result<()> {
    const NAME: &str = "com.apple.metadata:com_apple_backup_excludeItem";
    const VALUE: &[u8] = b"bplist00_\x10\x11com.apple.backupd\x08\x00\x00\x00\x00\x00\x00\x01\x01\x00\x00\x00\x00\x00\x00\x00\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x1c";
    rustix::fs::fsetxattr(fd, NAME, VALUE, rustix::fs::XattrFlags::empty())?;
    Ok(())
}

fn cstr(p: &Path) -> io::Result<CString> {
    CString::new(p.as_os_str().as_bytes()).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))
}

/// One `F_BARRIERFSYNC`.
pub(crate) fn barrier_fsync(f: &fs::File) -> io::Result<()> {
    // SAFETY: `f` is an open file for the duration of the call; the command
    // takes no argument.
    if unsafe { libc::fcntl(f.as_raw_fd(), libc::F_BARRIERFSYNC) } == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// `copyfile(from, to, NULL, COPYFILE_ACL | COPYFILE_XATTR)`.
pub(crate) fn copy_acl_xattr(from: &Path, to: &Path) -> io::Result<()> {
    let (cf, ct) = (cstr(from)?, cstr(to)?);
    // SAFETY: both are valid NUL-terminated paths; a null state is allowed.
    let r = unsafe {
        libc::copyfile(
            cf.as_ptr(),
            ct.as_ptr(),
            std::ptr::null_mut(),
            libc::COPYFILE_ACL | libc::COPYFILE_XATTR,
        )
    };
    if r != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Give `to` the creation date of `from` (`setattrlist(ATTR_CMN_CRTIME)`).
pub(crate) fn copy_crtime(from: &Path, to: &Path) -> io::Result<()> {
    let m = fs::symlink_metadata(from)?;
    let ct = cstr(to)?;
    // SAFETY: an all-zero attrlist is a valid value; fields are set below.
    let mut al: libc::attrlist = unsafe { std::mem::zeroed() };
    al.bitmapcount = libc::ATTR_BIT_MAP_COUNT;
    al.commonattr = libc::ATTR_CMN_CRTIME;
    let mut ts = libc::timespec {
        tv_sec: m.st_birthtime(),
        tv_nsec: m.st_birthtime_nsec(),
    };
    // SAFETY: valid path; the attribute buffer is exactly one timespec, as
    // ATTR_CMN_CRTIME requires, and lives across the call.
    let r = unsafe {
        libc::setattrlist(
            ct.as_ptr(),
            (&mut al as *mut libc::attrlist).cast(),
            (&mut ts as *mut libc::timespec).cast(),
            std::mem::size_of::<libc::timespec>(),
            0,
        )
    };
    if r != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// `VOL_CAP_INT_RENAME_SWAP` and `VOL_CAP_INT_RENAME_EXCL` on the volume
/// holding `p`. Never trust `renamex_np`'s return code instead: FAT32
/// returns 0 and performs a plain rename.
pub(crate) fn volume_can_swap(p: &Path) -> io::Result<bool> {
    let c = cstr(p)?;
    // SAFETY: an all-zero attrlist is a valid value; fields are set below.
    let mut al: libc::attrlist = unsafe { std::mem::zeroed() };
    al.bitmapcount = libc::ATTR_BIT_MAP_COUNT;
    al.volattr = libc::ATTR_VOL_INFO | libc::ATTR_VOL_CAPABILITIES;
    #[repr(C)]
    struct Buf {
        len: u32,
        caps: libc::vol_capabilities_attr_t,
    }
    // SAFETY: `Buf` is plain old data; all-zero is valid.
    let mut buf: Buf = unsafe { std::mem::zeroed() };
    // SAFETY: valid path; the buffer layout matches the requested volume
    // attributes (length word, then the capabilities) and its size is passed.
    let r = unsafe {
        libc::getattrlist(
            c.as_ptr(),
            (&mut al as *mut libc::attrlist).cast(),
            (&mut buf as *mut Buf).cast(),
            std::mem::size_of::<Buf>(),
            0,
        )
    };
    if r != 0 {
        return Err(io::Error::last_os_error());
    }
    let i = buf.caps.capabilities[libc::VOL_CAPABILITIES_INTERFACES];
    let v = buf.caps.valid[libc::VOL_CAPABILITIES_INTERFACES];
    let has = |bit: u32| v & bit != 0 && i & bit != 0;
    Ok(has(libc::VOL_CAP_INT_RENAME_SWAP) && has(libc::VOL_CAP_INT_RENAME_EXCL))
}
