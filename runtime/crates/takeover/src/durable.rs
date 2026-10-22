//! Making a marker's directory entry durable after a link or rename.
//!
//! Unix: fsync the containing directory. Windows has no directory fsync (std cannot
//! open a directory without `FILE_FLAG_BACKUP_SEMANTICS`), so the just-published entry
//! itself is opened for writing and flushed with `FlushFileBuffers` (`sync_all`).
//! Microsoft documents that this writes the specified file's buffered data and cached
//! metadata to disk, and recommends it for flushing cached file metadata after a
//! rename ("File system metadata is always cached. Therefore, to store any metadata
//! changes to disk, the file must either be flushed or be opened with
//! FILE_FLAG_WRITE_THROUGH":
//! <https://learn.microsoft.com/windows/win32/fileio/file-caching>; see also
//! <https://learn.microsoft.com/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers>
//! and the NTFS rename note in CreateFileW). That per-file guarantee is all this
//! relies on; it is not a volume-wide barrier for other namespace operations. FAT has
//! no hard links, so a takeover there already fails closed at the no-replace publish.
//! Every error is returned, never ignored.

use crate::{Error, Result};
use std::path::Path;

/// Make the entry `dir/name`, created by a link or rename, survive a crash.
pub(crate) fn sync_entry(dir: &Path, name: &str) -> Result<()> {
    imp(dir, name).map_err(|e| Error::Invalid(format!("marker directory durability: {e}")))
}

#[cfg(unix)]
fn imp(dir: &Path, _name: &str) -> std::io::Result<()> {
    std::fs::File::open(dir)?.sync_all()
}

#[cfg(windows)]
fn imp(dir: &Path, name: &str) -> std::io::Result<()> {
    // Write access is required by FlushFileBuffers; never create or truncate.
    std::fs::OpenOptions::new()
        .write(true)
        .open(dir.join(name))?
        .sync_all()
}

#[cfg(test)]
mod tests {
    #[test]
    fn missing_entries_are_errors_not_successes() {
        let absent = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("Cargo.toml")
            .join("not-a-directory");
        assert!(super::sync_entry(&absent, "connect-role.json").is_err());
    }
}
