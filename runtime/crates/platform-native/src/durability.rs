//! Required device commit points. Never downgrade Full to ordinary fsync.

#[cfg(any(target_os = "macos", test))]
use std::io;

#[cfg(any(target_os = "macos", test))]
fn retry_full(mut attempt: impl FnMut() -> io::Result<()>) -> io::Result<()> {
    for n in 0..8 {
        match attempt() {
            Err(e) if e.kind() == io::ErrorKind::Interrupted && n < 7 => continue,
            r => return r,
        }
    }
    unreachable!()
}

#[cfg(target_os = "macos")]
pub(crate) fn full_sync_fd(f: &std::fs::File) -> io::Result<()> {
    retry_full(|| rustix::fs::fcntl_fullfsync(f).map_err(Into::into))
}

#[cfg(feature = "sqlite")]
pub(crate) struct CommitBarrier {
    required: bool,
    #[cfg(target_os = "macos")]
    files: Option<MacFiles>,
    #[cfg(test)]
    fail_next: std::cell::Cell<usize>,
}

#[cfg(all(feature = "sqlite", target_os = "macos"))]
struct MacFiles {
    db: std::fs::File,
    parent: std::fs::File,
    wal_path: std::path::PathBuf,
    wal: std::cell::RefCell<Option<std::fs::File>>,
}

#[cfg(feature = "sqlite")]
impl CommitBarrier {
    // Called immediately after sqlite3_open, before SQL can restart/recycle an
    // existing WAL. The caller supplies a stable, owned private database path;
    // this is a durability barrier, not a new containment/custody adapter.
    pub(crate) fn open(_path: &std::path::Path, required: bool) -> std::io::Result<Self> {
        #[cfg(target_os = "macos")]
        let files = if required {
            use std::os::unix::fs::OpenOptionsExt;
            let open = |p: &std::path::Path| {
                let f = std::fs::OpenOptions::new()
                    .read(true)
                    .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
                    .open(p)?;
                if !f.metadata()?.is_file() {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidInput,
                        "nonregular SQLite file",
                    ));
                }
                Ok(f)
            };
            let db = open(_path)?;
            let parent = std::fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(
                    _path
                        .parent()
                        .filter(|p| !p.as_os_str().is_empty())
                        .unwrap_or(std::path::Path::new(".")),
                )?;
            let mut w = _path.as_os_str().to_os_string();
            w.push("-wal");
            let wal_path = std::path::PathBuf::from(w);
            let wal = match open(&wal_path) {
                Ok(f) => Some(f),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                Err(e) => return Err(e),
            };
            Some(MacFiles {
                db,
                parent,
                wal_path,
                wal: std::cell::RefCell::new(wal),
            })
        } else {
            None
        };
        Ok(Self {
            required,
            #[cfg(target_os = "macos")]
            files,
            #[cfg(test)]
            fail_next: std::cell::Cell::new(0),
        })
    }

    pub(crate) fn sync(&self) -> std::io::Result<()> {
        if !self.required {
            return Ok(());
        }
        #[cfg(test)]
        {
            let left = self.fail_next.get();
            if left > 0 {
                self.fail_next.set(left - 1);
            }
            if left == 1 {
                return Err(std::io::Error::other("injected required Full failure"));
            }
        }
        #[cfg(target_os = "macos")]
        if let Some(f) = &self.files {
            use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
            // Pin a newly-created WAL before acknowledging its first commit.
            let mut wal = f.wal.borrow_mut();
            if wal.is_none() {
                match std::fs::OpenOptions::new()
                    .read(true)
                    .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
                    .open(&f.wal_path)
                {
                    Ok(w) if w.metadata()?.is_file() => *wal = Some(w),
                    Ok(_) => {
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::InvalidInput,
                            "nonregular SQLite WAL",
                        ));
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(e),
                }
            }
            if let Some(w) = wal.as_ref() {
                let got = w.metadata()?;
                let at = std::fs::symlink_metadata(&f.wal_path)?;
                if !at.is_file()
                    || got.dev() != at.dev()
                    || got.ino() != at.ino()
                    || got.dev() != f.db.metadata()?.dev()
                {
                    return Err(std::io::Error::other("SQLite WAL custody changed"));
                }
            }
            // Directory metadata first; ordinary fsync is not the device commit
            // point. Strict Full on both DB and WAL then covers their data and
            // prior namespace writes. Neither error gets an fsync fallback.
            f.parent.sync_all()?;
            full_sync_fd(&f.db)?;
            if let Some(w) = wal.as_ref() {
                full_sync_fd(w)?;
            }
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn fail_once(&self) {
        self.fail_on_call(1);
    }
    #[cfg(test)]
    pub(crate) fn fail_on_call(&self, n: usize) {
        self.fail_next.set(n);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn full_retries_only_interrupts_and_never_downgrades() {
        let mut calls = 0;
        let e = retry_full(|| {
            calls += 1;
            Err(io::Error::new(io::ErrorKind::Unsupported, "no Full"))
        })
        .unwrap_err();
        assert_eq!(e.kind(), io::ErrorKind::Unsupported);
        assert_eq!(calls, 1);
        calls = 0;
        retry_full(|| {
            calls += 1;
            if calls < 3 {
                Err(io::ErrorKind::Interrupted.into())
            } else {
                Ok(())
            }
        })
        .unwrap();
        assert_eq!(calls, 3);
        calls = 0;
        assert_eq!(
            retry_full(|| {
                calls += 1;
                Err(io::ErrorKind::Interrupted.into())
            })
            .unwrap_err()
            .kind(),
            io::ErrorKind::Interrupted
        );
        assert_eq!(calls, 8);
    }
}
