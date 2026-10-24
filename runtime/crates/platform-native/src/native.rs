//! `NativePlatform`: `FilePlatform` over a real directory.

use std::fs;
use std::future::{Future, ready};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use mdbn_store_file::platform::{
    Capabilities, DirEntry, FileKind, FileMeta, FilePlatform, FlushScope, FsError, FsErrorKind,
    FsResult, Holders, LockHandle, LockShare, MAX_READ_AT, PlatformEnvironment, RangeHandle,
    ReadResult, RelPath, ReplaceStrategy,
};

use crate::error::fs_err;
#[cfg(unix)]
use crate::unix as os;
#[cfg(windows)]
use crate::windows as os;

/// How to open a [`NativePlatform`].
#[derive(Clone, Debug)]
pub struct OpenOptions {
    /// The private directory for temps and stashes, relative to the root.
    pub private_dir: String,
    /// Use this strategy instead of the probed one (tests; forcing
    /// `ReadOnly`). Never upgrades a volume that lacks the primitives.
    pub force_read_only: bool,
}

impl Default for OpenOptions {
    fn default() -> Self {
        OpenOptions {
            private_dir: ".mdbase".into(),
            force_read_only: false,
        }
    }
}

/// Content-free local platform diagnostics. Never includes collection paths.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PlatformDiagnostics {
    /// Best-effort Time Machine exclusion failed; retained bytes may be backed up.
    pub backup_exclusion_failures: u64,
}

impl PlatformDiagnostics {
    #[cfg(any(test, target_os = "macos"))]
    fn record_backup_exclusion(&mut self, result: std::io::Result<()>) {
        if result.is_err() {
            self.backup_exclusion_failures = self.backup_exclusion_failures.saturating_add(1);
            // Local warning only; never format the error's potentially private path.
            eprintln!("mdbase: backup exclusion unavailable; retained files may reach backups");
        }
    }
}

/// A collection root on a local file system.
pub struct NativePlatform {
    root: PathBuf,
    /// The root, held open: every collection path resolves under it without
    /// following a symlink.
    dir: os::Root,
    caps: Capabilities,
    diagnostics: PlatformDiagnostics,
    pub(crate) locks: os::Locks,
    /// Open range readers ([`FilePlatform::open_range_read`]).
    ranges: std::sync::Mutex<RangeTable>,
}

#[derive(Default)]
struct RangeTable {
    next: u64,
    open: std::collections::BTreeMap<u64, fs::File>,
}

impl NativePlatform {
    /// Open `root` (which must exist), create the private directory and probe
    /// the volume's capabilities.
    pub fn open(root: impl Into<PathBuf>, opts: &OpenOptions) -> FsResult<NativePlatform> {
        let root: PathBuf = root.into();
        let private_dir = RelPath::new(opts.private_dir.clone())?;
        if !fs::metadata(&root).map_err(|e| fs_err(e, "root"))?.is_dir() {
            return Err(FsError::new(
                FsErrorKind::WrongKind,
                "root is not a directory",
            ));
        }
        let private_abs = abs(&root, &private_dir)?;
        let dir = os::Root::open(&root).map_err(|e| fs_err(e, "root"))?;
        // Never through a symlinked private directory.
        os::create_dir_all(&dir, &private_dir).map_err(|e| fs_err(e, "private dir"))?;
        let mut caps = os::probe(&root, &private_abs).map_err(|e| fs_err(e, "probe"))?;
        #[cfg(target_os = "macos")]
        let diagnostics = {
            let retained = private_dir.join("retained.nosync")?;
            os::create_dir_all(&dir, &retained).map_err(|e| fs_err(e, "retained dir"))?;
            let mut diagnostics = PlatformDiagnostics::default();
            diagnostics.record_backup_exclusion(os::exclude_from_backup(&dir, &retained));
            diagnostics
        };
        #[cfg(not(target_os = "macos"))]
        let diagnostics = PlatformDiagnostics::default();
        caps.private_dir = private_dir;
        if opts.force_read_only {
            caps.replace = ReplaceStrategy::ReadOnly;
        }
        Ok(NativePlatform {
            root,
            dir,
            caps,
            diagnostics,
            locks: os::Locks::default(),
            ranges: std::sync::Mutex::default(),
        })
    }

    /// Local, content-free diagnostic counters for doctor/status.
    pub fn diagnostics(&self) -> PlatformDiagnostics {
        self.diagnostics
    }

    /// The collection root.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The absolute path of a collection path.
    pub fn abs(&self, p: &RelPath) -> FsResult<PathBuf> {
        abs(&self.root, p)
    }
}

/// The absolute path of `p` under `root`. Every segment must be a
/// plain name (no drive or UNC prefix, no root, no `..`, no `:`), so
/// `PathBuf::push` can never replace or leave the root; the result is checked
/// to start with `root` as well.
pub(crate) fn abs(root: &Path, p: &RelPath) -> FsResult<PathBuf> {
    use std::path::Component;
    let escape = || {
        FsError::new(
            FsErrorKind::InvalidPath,
            format!("{p} would leave the collection root"),
        )
    };
    let mut out = root.to_path_buf();
    for seg in p.as_str().split('/').filter(|s| !s.is_empty()) {
        if seg.contains(':') || seg.contains('\\') {
            return Err(escape());
        }
        let mut comps = Path::new(seg).components();
        match (comps.next(), comps.next()) {
            (Some(Component::Normal(_)), None) => out.push(seg),
            _ => return Err(escape()),
        }
    }
    if !out.starts_with(root) {
        return Err(escape());
    }
    Ok(out)
}

pub(crate) fn kind_of(ft: fs::FileType) -> FileKind {
    if ft.is_symlink() {
        FileKind::Other
    } else if ft.is_dir() {
        FileKind::Dir
    } else if ft.is_file() {
        FileKind::File
    } else {
        FileKind::Other
    }
}

/// Open `p` for reading, refusing anything but a regular file reached without
/// a symlink (no FIFO, device or link is ever read).
fn open_regular(root: &os::Root, p: &RelPath, what: &str) -> FsResult<(fs::File, FileMeta)> {
    let f = os::open_read(root, p).map_err(|e| fs_err(e, what))?;
    let meta = os::file_meta(&f).map_err(|e| fs_err(e, what))?;
    if meta.kind != FileKind::File {
        return Err(FsError::new(
            FsErrorKind::WrongKind,
            format!("{what}: not a regular file"),
        ));
    }
    Ok((f, meta))
}

/// `self.abs(p)`, returning the error as the method's ready future.
macro_rules! abs {
    ($s:expr, $p:expr) => {
        match $s.abs($p) {
            Ok(x) => x,
            Err(e) => return ready(Err(e)),
        }
    };
}

impl FilePlatform for NativePlatform {
    fn capabilities(&self) -> &Capabilities {
        &self.caps
    }

    fn retained_nosync(&self) -> bool {
        cfg!(target_os = "macos")
    }

    fn release_policy(&self) -> mdbn_store_file::ReleasePolicy {
        #[cfg(target_os = "macos")]
        {
            mdbn_store_file::ReleasePolicy::NextLaunch {
                cap_bytes: 256 << 20,
                max_age_ms: mdbn_store_file::MAX_RETENTION_AGE_MS,
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            mdbn_store_file::ReleasePolicy::AfterRetention
        }
    }

    fn environment(&self) -> impl Future<Output = FsResult<PlatformEnvironment>> {
        ready(Ok(PlatformEnvironment {
            root_display: Some(self.root.display().to_string()),
            signals: Vec::new(),
        }))
    }

    fn stat(&self, path: &RelPath) -> impl Future<Output = FsResult<FileMeta>> {
        let _ = abs!(self, path);
        ready(os::stat_at(&self.dir, path).map_err(|e| fs_err(e, "stat")))
    }

    fn read(&self, path: &RelPath) -> impl Future<Output = FsResult<ReadResult>> {
        let _ = abs!(self, path);
        ready((|| {
            // Never follow a symlink, in any component, out of the collection.
            let (mut f, _) = open_regular(&self.dir, path, "read")?;
            let mut bytes = Vec::new();
            f.read_to_end(&mut bytes).map_err(|e| fs_err(e, "read"))?;
            let meta = os::file_meta(&f).map_err(|e| fs_err(e, "read"))?;
            Ok(ReadResult { bytes, meta })
        })())
    }

    fn read_range(
        &self,
        path: &RelPath,
        offset: u64,
        len: u32,
    ) -> impl Future<Output = FsResult<Vec<u8>>> {
        let _ = abs!(self, path);
        ready((|| {
            let (mut f, _) = open_regular(&self.dir, path, "read_range")?;
            (|| {
                f.seek(SeekFrom::Start(offset))?;
                let mut buf = Vec::with_capacity(len as usize);
                f.take(u64::from(len)).read_to_end(&mut buf)?;
                Ok(buf)
            })()
            .map_err(|e| fs_err(e, "read_range"))
        })())
    }

    fn open_range_read(
        &self,
        path: &RelPath,
    ) -> impl Future<Output = FsResult<(RangeHandle, FileMeta)>> {
        let _ = abs!(self, path);
        ready((|| {
            // Never follow a symlink out of the collection: the path must name a
            // regular file, and the opened handle must be that same file.
            let before = os::stat_at(&self.dir, path).map_err(|e| fs_err(e, "open_range_read"))?;
            if before.kind != FileKind::File {
                return Err(FsError::new(
                    FsErrorKind::WrongKind,
                    "open_range_read: not a regular file",
                ));
            }
            let (f, meta) = open_regular(&self.dir, path, "open_range_read")?;
            if before.id.is_some() && meta.id != before.id {
                return Err(FsError::new(
                    FsErrorKind::Busy,
                    "open_range_read: the path changed while opening",
                ));
            }
            let mut t = self
                .ranges
                .lock()
                .map_err(|_| FsError::new(FsErrorKind::Other, "range table poisoned"))?;
            t.next += 1;
            let h = t.next;
            t.open.insert(h, f);
            Ok((RangeHandle(h), meta))
        })())
    }

    fn read_at(
        &self,
        h: RangeHandle,
        offset: u64,
        len: u32,
    ) -> impl Future<Output = FsResult<Vec<u8>>> {
        ready((|| {
            if len > MAX_READ_AT {
                return Err(FsError::new(FsErrorKind::Other, "read_at over 8 MiB"));
            }
            let mut t = self
                .ranges
                .lock()
                .map_err(|_| FsError::new(FsErrorKind::Other, "range table poisoned"))?;
            let f = t
                .open
                .get_mut(&h.0)
                .ok_or_else(|| FsError::new(FsErrorKind::BadHandle, format!("{h:?}")))?;
            (|| {
                f.seek(SeekFrom::Start(offset))?;
                let mut buf = Vec::with_capacity(len as usize);
                f.take(u64::from(len)).read_to_end(&mut buf)?;
                Ok(buf)
            })()
            .map_err(|e| fs_err(e, "read_at"))
        })())
    }

    fn range_meta(&self, h: RangeHandle) -> impl Future<Output = FsResult<FileMeta>> {
        ready((|| {
            let t = self
                .ranges
                .lock()
                .map_err(|_| FsError::new(FsErrorKind::Other, "range table poisoned"))?;
            let f = t
                .open
                .get(&h.0)
                .ok_or_else(|| FsError::new(FsErrorKind::BadHandle, format!("{h:?}")))?;
            os::file_meta(f).map_err(|e| fs_err(e, "range_meta"))
        })())
    }

    fn close_range_read(&self, h: RangeHandle) -> impl Future<Output = FsResult<()>> {
        ready(
            self.ranges
                .lock()
                .map_err(|_| FsError::new(FsErrorKind::Other, "range table poisoned"))
                .map(|mut t| {
                    t.open.remove(&h.0);
                }),
        )
    }

    fn list(&self, dir: &RelPath) -> impl Future<Output = FsResult<Vec<DirEntry>>> {
        let _ = abs!(self, dir);
        ready(os::list(&self.dir, dir).map_err(|e| fs_err(e, "list")))
    }

    fn create_dir_all(&self, dir: &RelPath) -> impl Future<Output = FsResult<()>> {
        let _ = abs!(self, dir);
        ready(os::create_dir_all(&self.dir, dir).map_err(|e| fs_err(e, "create_dir_all")))
    }

    fn write_new(
        &self,
        path: &RelPath,
        bytes: &[u8],
        durable: bool,
    ) -> impl Future<Output = FsResult<FileMeta>> {
        let _ = abs!(self, path);
        ready(
            (|| {
                let mut f = os::create_new(&self.dir, path)?;
                f.write_all(bytes)?;
                if durable {
                    f.sync_all()?;
                }
                os::file_meta(&f)
            })()
            .map_err(|e| fs_err(e, "write_new")),
        )
    }

    fn append(&self, path: &RelPath, bytes: &[u8]) -> impl Future<Output = FsResult<()>> {
        let _ = abs!(self, path);
        ready(
            os::open_append(&self.dir, path)
                .and_then(|mut f| f.write_all(bytes))
                .map_err(|e| fs_err(e, "append")),
        )
    }

    fn rename_noreplace(&self, from: &RelPath, to: &RelPath) -> impl Future<Output = FsResult<()>> {
        let (_, _) = (abs!(self, from), abs!(self, to));
        ready(os::rename_noreplace(&self.dir, from, to).map_err(|e| fs_err(e, "rename_noreplace")))
    }

    fn remove_file(&self, path: &RelPath) -> impl Future<Output = FsResult<()>> {
        let _ = abs!(self, path);
        ready(os::remove_file(&self.dir, path).map_err(|e| fs_err(e, "remove_file")))
    }

    fn flush(&self, scope: FlushScope) -> impl Future<Output = FsResult<()>> {
        ready(
            match scope {
                FlushScope::File(p) => {
                    let _ = abs!(self, &p);
                    os::sync_file(&self.dir, &p)
                }
                FlushScope::Dir(p) => {
                    let _ = abs!(self, &p);
                    os::sync_dir(&self.dir, &p)
                }
                FlushScope::Barrier => os::barrier(&self.root),
                FlushScope::Full => os::full_sync(&self.root),
            }
            .map_err(|e| fs_err(e, "flush")),
        )
    }

    fn exchange(&self, a: &RelPath, b: &RelPath) -> impl Future<Output = FsResult<()>> {
        ready(if self.caps.replace == ReplaceStrategy::Exchange {
            let (_, _) = (abs!(self, a), abs!(self, b));
            os::exchange(&self.dir, a, b).map_err(|e| fs_err(e, "exchange"))
        } else {
            Err(FsError::unsupported("exchange"))
        })
    }

    fn copy_metadata(&self, from: &RelPath, to: &RelPath) -> impl Future<Output = FsResult<()>> {
        let (_, _) = (abs!(self, from), abs!(self, to));
        ready(os::copy_metadata(&self.dir, from, to).map_err(|e| fs_err(e, "copy_metadata")))
    }

    fn lock(&self, path: &RelPath, share: LockShare) -> impl Future<Output = FsResult<LockHandle>> {
        let _ = abs!(self, path);
        ready(
            os::lock_path(&self.dir, path)
                .map_err(|e| fs_err(e, "lock"))
                .and_then(|p| self.locks.lock(&p, share)),
        )
    }

    fn locked_read(&self, h: LockHandle) -> impl Future<Output = FsResult<ReadResult>> {
        ready(self.locks.read(h))
    }

    fn locked_overwrite(
        &self,
        h: LockHandle,
        bytes: &[u8],
        durable: bool,
    ) -> impl Future<Output = FsResult<()>> {
        ready(self.locks.overwrite(h, bytes, durable))
    }

    fn locked_move_aside(&self, h: LockHandle, to: &RelPath) -> impl Future<Output = FsResult<()>> {
        let _ = abs!(self, to);
        ready(
            os::lock_path(&self.dir, to)
                .map_err(|e| fs_err(e, "locked_move_aside"))
                .and_then(|p| self.locks.move_aside(h, &p)),
        )
    }

    fn unlock(&self, h: LockHandle) -> impl Future<Output = FsResult<()>> {
        ready(self.locks.unlock(h))
    }

    fn other_holders(&self, path: &RelPath) -> impl Future<Output = FsResult<Holders>> {
        #[cfg(target_os = "linux")]
        {
            let _ = abs!(self, path);
            ready(
                os::open_read(&self.dir, path)
                    .and_then(|f| crate::linux::other_holders(&f))
                    .map_err(|e| fs_err(e, "other_holders")),
            )
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = path;
            ready(Ok(Holders::Unknown))
        }
    }
}

#[cfg(test)]
mod retention_diagnostics_tests {
    use super::PlatformDiagnostics;

    #[test]
    fn retention_backup_exclusion_fault_is_content_free_and_nonfatal() {
        let mut diagnostics = PlatformDiagnostics::default();
        diagnostics.record_backup_exclusion(Err(std::io::Error::other("private-note-path")));
        assert_eq!(diagnostics.backup_exclusion_failures, 1);
        assert!(!format!("{diagnostics:?}").contains("private-note-path"));
        diagnostics.record_backup_exclusion(Ok(()));
        assert_eq!(diagnostics.backup_exclusion_failures, 1);
    }
}
