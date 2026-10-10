//! `SimFilePlatform`: the simulator's OS models for the
//! [`FilePlatform`] trait, so the real `mdbn-store-file` code (publish, settle,
//! recovery, the `FileStore`) runs against simulated disks, editors, stalls and
//! crashes.
//!
//! Every call goes through a hooked [`Proc`], so the machine hook can interleave
//! editors, stall the store or crash it between any two platform operations.
//! The futures it returns are always ready; [`block_on`] drives the store's
//! `async` code to completion with a no-op waker (the store crate's own model).
//!
//! Capabilities per OS:
//!
//! | OS | strategy | ids | durability | case | missing-path window |
//! |---|---|---|---|---|---|
//! | Linux | Exchange | inode | fsync | sensitive | no |
//! | macOS | Exchange | inode | fsync | sensitive (sim) | yes |
//! | macOS FAT32 | ReadOnly (the capability check must refuse the lying swap) | inode | fsync | sensitive | no |
//! | Windows | LockedInPlace | file ID | fsync | sensitive (sim) | no |

use std::future::{Future, ready};
use std::pin::pin;
use std::task::{Context, Poll, Waker};

use mdbn_store_file::platform::{
    Capabilities, CaseSensitivity, DirEntry, Durability, EventFidelity, FileId, FileKind, FileMeta,
    FilePlatform, FlushScope, FsError, FsErrorKind, FsResult, Holders, LockHandle, LockShare,
    ReadResult, RelPath, ReplaceStrategy,
};

use crate::platform::{self as sim, Access, Disposition, Os, Proc};

/// Drive a future that never actually waits (every [`SimFilePlatform`] call is
/// ready immediately). Panics if it would block, which would be a bug in the
/// adapter, not in the code under test.
pub fn block_on<F: Future>(f: F) -> F::Output {
    let mut f = pin!(f);
    let mut cx = Context::from_waker(Waker::noop());
    match f.as_mut().poll(&mut cx) {
        Poll::Ready(v) => v,
        Poll::Pending => panic!("a SimFilePlatform future was pending"),
    }
}

/// The simulated file platform for one process.
#[derive(Debug)]
pub struct SimFilePlatform {
    /// The process making the calls (hooked).
    pub proc: Proc,
    caps: Capabilities,
}

fn err(e: sim::FsError, op: &str) -> FsError {
    let kind = match e {
        sim::FsError::NotFound => FsErrorKind::NotFound,
        sim::FsError::Exists => FsErrorKind::AlreadyExists,
        sim::FsError::SharingViolation => FsErrorKind::Busy,
        sim::FsError::AccessDenied => FsErrorKind::PermissionDenied,
        sim::FsError::Unsupported => FsErrorKind::Unsupported,
        sim::FsError::BadFd => FsErrorKind::BadHandle,
        sim::FsError::Crashed => FsErrorKind::Other,
    };
    FsError::new(kind, format!("{op}: {e}"))
}

fn meta(m: sim::Meta) -> FileMeta {
    FileMeta {
        kind: if m.is_dir {
            FileKind::Dir
        } else {
            FileKind::File
        },
        size: m.size,
        mtime_ns: m.mtime_ns as i64,
        ctime_ns: Some(m.mtime_ns as i64),
        id: (!m.is_dir).then_some(FileId(u128::from(m.ino))),
    }
}

impl SimFilePlatform {
    /// A platform for `proc`, with the capabilities of its machine's OS.
    pub fn new(proc: Proc) -> Self {
        let os = proc.os();
        let private_dir = RelPath::new(".mdbase").expect("valid");
        let replace = match os {
            Os::Linux => ReplaceStrategy::Exchange,
            Os::MacOs(m) if m.fat32 => ReplaceStrategy::ReadOnly,
            Os::MacOs(_) => ReplaceStrategy::Exchange,
            Os::Windows => ReplaceStrategy::LockedInPlace,
        };
        let caps = Capabilities {
            replace,
            exclusive_create: true,
            durability: Durability::Fsync,
            case: CaseSensitivity::Sensitive,
            file_ids: true,
            mtime_resolution_ns: 1,
            events: EventFidelity::Precise,
            transient_missing: matches!(os, Os::MacOs(_)),
            private_dir,
        };
        SimFilePlatform { proc, caps }
    }

    fn stat_now(&self, path: &str, op: &str) -> FsResult<FileMeta> {
        self.proc.stat(path).map(meta).map_err(|e| err(e, op))
    }
}

impl FilePlatform for SimFilePlatform {
    fn capabilities(&self) -> &Capabilities {
        &self.caps
    }

    fn stat(&self, path: &RelPath) -> impl Future<Output = FsResult<FileMeta>> {
        ready(self.stat_now(path.as_str(), "stat"))
    }

    fn read(&self, path: &RelPath) -> impl Future<Output = FsResult<ReadResult>> {
        let r = (|| {
            let bytes = self.proc.read(path.as_str()).map_err(|e| err(e, "read"))?;
            // fstat on the same handle: the inode we read (no second lookup).
            let m = self.stat_now(path.as_str(), "read")?;
            Ok(ReadResult { bytes, meta: m })
        })();
        ready(r)
    }

    fn read_range(
        &self,
        path: &RelPath,
        offset: u64,
        len: u32,
    ) -> impl Future<Output = FsResult<Vec<u8>>> {
        let r = self
            .proc
            .read(path.as_str())
            .map_err(|e| err(e, "read_range"))
            .map(|b| {
                let s = (offset as usize).min(b.len());
                let e = (s + len as usize).min(b.len());
                b[s..e].to_vec()
            });
        ready(r)
    }

    fn list(&self, dir: &RelPath) -> impl Future<Output = FsResult<Vec<DirEntry>>> {
        let r = self
            .proc
            .list(dir.as_str())
            .map_err(|e| err(e, "list"))
            .map(|v| {
                v.into_iter()
                    .map(|(name, is_dir)| DirEntry {
                        name,
                        kind: if is_dir {
                            FileKind::Dir
                        } else {
                            FileKind::File
                        },
                    })
                    .collect()
            });
        ready(r)
    }

    fn create_dir_all(&self, dir: &RelPath) -> impl Future<Output = FsResult<()>> {
        ready(
            self.proc
                .mkdir_all(dir.as_str())
                .map_err(|e| err(e, "mkdir")),
        )
    }

    fn write_new(
        &self,
        path: &RelPath,
        bytes: &[u8],
        durable: bool,
    ) -> impl Future<Output = FsResult<FileMeta>> {
        let r = self
            .proc
            .create_new(path.as_str(), bytes, durable)
            .map_err(|e| err(e, "write_new"))
            .and_then(|()| self.stat_now(path.as_str(), "write_new"));
        ready(r)
    }

    fn rename_noreplace(&self, from: &RelPath, to: &RelPath) -> impl Future<Output = FsResult<()>> {
        ready(
            self.proc
                .rename(from.as_str(), to.as_str(), false)
                .map_err(|e| err(e, "rename_noreplace")),
        )
    }

    fn remove_file(&self, path: &RelPath) -> impl Future<Output = FsResult<()>> {
        ready(
            self.proc
                .unlink(path.as_str())
                .map_err(|e| err(e, "remove")),
        )
    }

    fn flush(&self, scope: FlushScope) -> impl Future<Output = FsResult<()>> {
        let r = match scope {
            FlushScope::File(p) => self
                .proc
                .open(
                    p.as_str(),
                    Disposition::Existing,
                    Access::NONE,
                    sim::SHARE_ALL,
                )
                .and_then(|fd| {
                    let r = self.proc.fsync(fd);
                    let _ = self.proc.close(fd);
                    r
                }),
            FlushScope::Dir(d) => self.proc.fsync_dir(d.as_str()),
            FlushScope::Barrier | FlushScope::Full => self.proc.syncfs(),
        };
        ready(r.map_err(|e| err(e, "flush")))
    }

    fn exchange(&self, a: &RelPath, b: &RelPath) -> impl Future<Output = FsResult<()>> {
        ready(
            self.proc
                .exchange(a.as_str(), b.as_str())
                .map_err(|e| err(e, "exchange")),
        )
    }

    fn lock(&self, path: &RelPath, share: LockShare) -> impl Future<Output = FsResult<LockHandle>> {
        let share = match share {
            LockShare::Read => Access::R,
            LockShare::None => Access::NONE,
        };
        // Protocol D: GENERIC_READ|GENERIC_WRITE (+ DELETE for move-aside).
        let access = Access {
            read: true,
            write: true,
            delete: true,
        };
        ready(
            self.proc
                .open(path.as_str(), Disposition::Existing, access, share)
                .map(LockHandle)
                .map_err(|e| err(e, "lock")),
        )
    }

    fn locked_read(&self, h: LockHandle) -> impl Future<Output = FsResult<ReadResult>> {
        let r = (|| {
            let bytes = self.proc.read_fd(h.0).map_err(|e| err(e, "locked_read"))?;
            let ino = self.proc.fd_inode(h.0).map_err(|e| err(e, "locked_read"))?;
            let m = self.proc.m.borrow();
            let n = &m.disk.inodes[&ino];
            Ok(ReadResult {
                meta: FileMeta {
                    kind: FileKind::File,
                    size: n.data.len() as u64,
                    mtime_ns: n.mtime_ns as i64,
                    ctime_ns: Some(n.mtime_ns as i64),
                    id: Some(FileId(u128::from(ino))),
                },
                bytes,
            })
        })();
        ready(r)
    }

    fn locked_overwrite(
        &self,
        h: LockHandle,
        bytes: &[u8],
        durable: bool,
    ) -> impl Future<Output = FsResult<()>> {
        let r = (|| {
            self.proc.write_at(h.0, 0, bytes)?;
            self.proc.set_len(h.0, bytes.len() as u64)?;
            if durable {
                self.proc.fsync(h.0)?;
            }
            Ok(())
        })();
        ready(r.map_err(|e| err(e, "locked_overwrite")))
    }

    fn locked_move_aside(&self, h: LockHandle, to: &RelPath) -> impl Future<Output = FsResult<()>> {
        ready(
            self.proc
                .rename_by_handle(h.0, to.as_str())
                .map_err(|e| err(e, "locked_move_aside")),
        )
    }

    fn other_holders(&self, path: &RelPath) -> impl Future<Output = FsResult<Holders>> {
        // Linux: `F_SETLEASE(F_WRLCK)` is refused while any other open file
        // description exists. macOS: `proc_listpidspath` lists processes with the
        // path open (modelled as exact). Windows settles through its own lock.
        let r = match self.proc.os() {
            Os::MacOs(m) if m.p_hidden_holder >= crate::rng::PPM => Ok(Holders::Unknown),
            Os::Linux | Os::MacOs(_) => self
                .proc
                .lease_free(path.as_str())
                .map(|free| if free { Holders::None } else { Holders::Some })
                .map_err(|e| err(e, "other_holders")),
            Os::Windows => Ok(Holders::Unknown),
        };
        ready(r)
    }

    fn unlock(&self, h: LockHandle) -> impl Future<Output = FsResult<()>> {
        ready(self.proc.close(h.0).map_err(|e| err(e, "unlock")))
    }
}
