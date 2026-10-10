//! An in-memory [`FilePlatform`] for unit tests of the protocols.
//!
//! Not the simulator's OS model (that lives in `mdbn-sim`, with editor and
//! crash models): this is a small, exact file system with inodes, open-file
//! writes into displaced inodes, Windows-style locks, case-insensitive lookup
//! and **hooks** that run "another process" just before the n-th platform
//! operation. That is enough to drive every branch of the publish and
//! recovery protocols deterministically.

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet};
use std::future::{Future, ready};
use std::rc::Rc;

use crate::platform::{
    Capabilities, CaseSensitivity, DirEntry, Durability, EventFidelity, FileId, FileKind, FileMeta,
    FilePlatform, FlushScope, FsError, FsErrorKind, FsResult, Guarded, Holders, LockHandle,
    LockShare, MAX_READ_AT, RangeHandle, ReadResult, RelPath, ReplaceStrategy,
};

/// The replica crate, for tests in crates that may not depend on it directly
/// (`mdbn-platform-native` runs `FileStore` over `MemStore` on real disks).
pub use mdbn_replica as replica;
/// The wire crate, for native tests that drive a whole replica (the app
/// composition over a real SQLite index) without a direct wire dependency.
pub use mdbn_wire as wire;
/// Typed file-content fixtures for native tests without a direct wire dependency.
pub use mdbn_wire::attachment::{AttachmentContentV1, AttachmentRefV1, FileContent};
/// Wire ID constructor for tests of store traits in native-only crates.
pub use mdbn_wire::common::{B16, Sem};
pub use mdbn_wire::intent::{BlobRef, MediaClass};
pub use mdbn_wire::snapshot::EntityKind as FileEntityKind;
/// Stored semantic kind and payload for native persistence tests.
pub use mdbn_wire::unindexed_markdown::{FileKindV1, UnindexedMarkdownPayloadV1};

type Hook = Box<dyn FnOnce(&MemFs)>;

#[derive(Clone)]
struct Inode {
    bytes: Vec<u8>,
    mtime_ns: i64,
}

#[derive(Clone)]
struct Lock {
    ino: u64,
    path: String,
    share: LockShare,
}

#[derive(Default)]
struct State {
    /// key (case-folded if insensitive) -> (display path, ino)
    files: BTreeMap<String, (String, u64)>,
    dirs: BTreeSet<String>,
    inodes: BTreeMap<u64, Inode>,
    next_ino: u64,
    clock_ns: i64,
    locks: BTreeMap<u64, Lock>,
    next_lock: u64,
    ops: u64,
    hooks: BTreeMap<u64, Vec<Hook>>,
    fail: BTreeMap<u64, FsErrorKind>,
    crash_at: Option<u64>,
    open_fds: BTreeMap<u64, u32>,
    fail_flushes: bool,
    fail_full_flushes: bool,
    log: Vec<String>,
    /// Open range readers: handle -> inode.
    ranges: BTreeMap<u64, u64>,
    next_range: u64,
    /// Synthetic inodes: content generated from the offset, never stored.
    synthetic: BTreeMap<u64, u64>,
    /// Largest single ranged read (`read_range`/`read_at`).
    max_ranged_read: usize,
    /// Whole reads (`read`) of a synthetic inode: always refused.
    synthetic_whole_reads: u64,
}

/// The byte at `offset` of a synthetic file with `seed`.
pub fn synthetic_byte(seed: u64, offset: u64) -> u8 {
    let x = offset
        .wrapping_add(seed)
        .wrapping_mul(0x9E37_79B9_7F4A_7C15)
        .rotate_left(17);
    (x >> 56) as u8
}

/// The shared in-memory file system. Clone the `Rc` to act as "another
/// process" from hooks and tests.
pub struct MemFs {
    st: RefCell<State>,
    insensitive: bool,
}

impl MemFs {
    /// An empty file system.
    pub fn new(case: CaseSensitivity) -> Rc<MemFs> {
        let fs = MemFs {
            st: RefCell::new(State {
                next_ino: 1,
                ..State::default()
            }),
            insensitive: case == CaseSensitivity::Insensitive,
        };
        fs.st.borrow_mut().dirs.insert(String::new());
        Rc::new(fs)
    }

    fn key(&self, p: &str) -> String {
        if self.insensitive {
            p.to_lowercase()
        } else {
            p.to_string()
        }
    }

    fn tick(st: &mut State) -> i64 {
        st.clock_ns += 1_000_000;
        st.clock_ns
    }

    /// Run `f` just before platform operation number `n` (0-based, counting
    /// every [`FilePlatform`] call made through any [`MemPlatform`] on this fs).
    pub fn before_op(&self, n: u64, f: impl FnOnce(&MemFs) + 'static) {
        self.st
            .borrow_mut()
            .hooks
            .entry(n)
            .or_default()
            .push(Box::new(f));
    }

    /// Make operation number `n` fail with `kind` without doing anything.
    pub fn fail_op(&self, n: u64, kind: FsErrorKind) {
        self.st.borrow_mut().fail.insert(n, kind);
    }

    /// Simulate a crash: operation `n` and every later one fail without effect,
    /// until [`MemFs::restart`]. Locks are released at restart.
    pub fn crash_at(&self, n: u64) {
        self.st.borrow_mut().crash_at = Some(n);
    }

    /// Recover from [`MemFs::crash_at`]: operations work again, locks are gone.
    pub fn restart(&self) {
        let mut st = self.st.borrow_mut();
        st.crash_at = None;
        st.locks.clear();
    }

    /// Make every `flush` fail (a volume that refuses fsync, a sharing
    /// violation on the file) until turned off.
    pub fn set_fail_flushes(&self, on: bool) {
        self.st.borrow_mut().fail_flushes = on;
    }

    /// Fail only the device-level commit point, after File/Dir flush succeeds.
    pub fn set_fail_full_flushes(&self, on: bool) {
        self.st.borrow_mut().fail_full_flushes = on;
    }

    /// Create a synthetic file of `len` bytes at `path` ([`synthetic_byte`] with
    /// the inode as seed): it occupies no memory, ranged reads generate it, and a
    /// whole `read` is refused (and counted), so a test proves large files are
    /// only ever streamed.
    pub fn write_synthetic(&self, path: &str, len: u64) -> u64 {
        self.write_replace(path, b"").expect("write");
        let ino = self.ino(path).expect("ino");
        self.st.borrow_mut().synthetic.insert(ino, len);
        ino
    }

    /// The bytes of a synthetic inode in `[offset, offset + len)` (clipped).
    pub fn synthetic_range(&self, ino: u64, offset: u64, len: u64) -> Vec<u8> {
        let size = self.st.borrow().synthetic.get(&ino).copied().unwrap_or(0);
        let end = offset.saturating_add(len).min(size);
        (offset.min(end)..end)
            .map(|o| synthetic_byte(ino, o))
            .collect()
    }

    /// Largest single ranged read so far.
    pub fn max_ranged_read(&self) -> usize {
        self.st.borrow().max_ranged_read
    }

    /// Whole reads of a synthetic file (refused).
    pub fn synthetic_whole_reads(&self) -> u64 {
        self.st.borrow().synthetic_whole_reads
    }

    /// Range readers currently open.
    pub fn open_ranges(&self) -> usize {
        self.st.borrow().ranges.len()
    }

    fn ranged(&self, ino: u64, offset: u64, len: u32) -> FsResult<Vec<u8>> {
        let synthetic = self.st.borrow().synthetic.contains_key(&ino);
        let out = if synthetic {
            self.synthetic_range(ino, offset, u64::from(len))
        } else {
            let st = self.st.borrow();
            let b = &st
                .inodes
                .get(&ino)
                .ok_or_else(|| FsError::new(FsErrorKind::NotFound, "inode"))?
                .bytes;
            let start = (offset as usize).min(b.len());
            let end = start.saturating_add(len as usize).min(b.len());
            b[start..end].to_vec()
        };
        let mut st = self.st.borrow_mut();
        st.max_ranged_read = st.max_ranged_read.max(out.len());
        Ok(out)
    }

    /// Operations performed so far.
    pub fn ops(&self) -> u64 {
        self.st.borrow().ops
    }

    /// The operation log (`"<n> <op> <path>"`).
    pub fn log(&self) -> Vec<String> {
        self.st.borrow().log.clone()
    }

    fn begin(&self, op: &str, path: &str) -> FsResult<()> {
        let (n, hooks) = {
            let mut st = self.st.borrow_mut();
            let n = st.ops;
            st.ops += 1;
            st.log.push(format!("{n} {op} {path}"));
            (n, st.hooks.remove(&n).unwrap_or_default())
        };
        for h in hooks {
            h(self);
        }
        if self.st.borrow().crash_at.is_some_and(|c| n >= c) {
            return Err(FsError::new(FsErrorKind::Other, "crashed"));
        }
        if let Some(kind) = self.st.borrow_mut().fail.remove(&n) {
            return Err(FsError::new(kind, format!("injected at op {n}")));
        }
        Ok(())
    }

    // ---- "other process" actions (no hooks, no op counting) ---------------

    /// Bytes at `path`, if a file.
    pub fn get(&self, path: &str) -> Option<Vec<u8>> {
        let st = self.st.borrow();
        let (_, ino) = st.files.get(&self.key(path))?;
        Some(st.inodes[ino].bytes.clone())
    }

    /// The inode at `path`.
    pub fn ino(&self, path: &str) -> Option<u64> {
        self.st.borrow().files.get(&self.key(path)).map(|(_, i)| *i)
    }

    /// Bytes of an inode, wherever it is (or unlinked).
    pub fn inode_bytes(&self, ino: u64) -> Option<Vec<u8>> {
        self.st.borrow().inodes.get(&ino).map(|i| i.bytes.clone())
    }

    /// Every file path (display form), sorted by key.
    pub fn paths(&self) -> Vec<String> {
        self.st
            .borrow()
            .files
            .values()
            .map(|(p, _)| p.clone())
            .collect()
    }

    fn mkparents(&self, st: &mut State, path: &str) {
        let mut cur = String::new();
        for seg in path
            .split('/')
            .collect::<Vec<_>>()
            .split_last()
            .map(|x| x.1)
            .unwrap_or(&[])
        {
            if !cur.is_empty() {
                cur.push('/');
            }
            cur.push_str(seg);
            st.dirs.insert(self.key(&cur));
        }
    }

    fn locked_against_write(st: &State, ino: u64) -> bool {
        st.locks.values().any(|l| l.ino == ino)
    }

    /// An editor's in-place save (`open(O_TRUNC)` + write): same inode, or a new
    /// file if absent. Fails with `Busy` if we hold a lock on it.
    pub fn write_in_place(&self, path: &str, bytes: &[u8]) -> FsResult<()> {
        let mut st = self.st.borrow_mut();
        let k = self.key(path);
        let t = Self::tick(&mut st);
        if let Some((_, ino)) = st.files.get(&k).cloned() {
            if Self::locked_against_write(&st, ino) {
                return Err(FsError::new(FsErrorKind::Busy, path));
            }
            st.synthetic.remove(&ino);
            st.inodes.insert(
                ino,
                Inode {
                    bytes: bytes.to_vec(),
                    mtime_ns: t,
                },
            );
        } else {
            self.mkparents(&mut st, path);
            let ino = st.next_ino;
            st.next_ino += 1;
            st.inodes.insert(
                ino,
                Inode {
                    bytes: bytes.to_vec(),
                    mtime_ns: t,
                },
            );
            st.files.insert(k, (path.to_string(), ino));
        }
        Ok(())
    }

    /// An editor's atomic save (temp + `rename(2)` over): a new inode at `path`.
    pub fn write_replace(&self, path: &str, bytes: &[u8]) -> FsResult<()> {
        let mut st = self.st.borrow_mut();
        let k = self.key(path);
        if let Some((_, old)) = st.files.get(&k).cloned()
            && Self::locked_against_write(&st, old)
        {
            return Err(FsError::new(FsErrorKind::Busy, path));
        }
        let t = Self::tick(&mut st);
        self.mkparents(&mut st, path);
        let ino = st.next_ino;
        st.next_ino += 1;
        st.inodes.insert(
            ino,
            Inode {
                bytes: bytes.to_vec(),
                mtime_ns: t,
            },
        );
        st.files.insert(k, (path.to_string(), ino));
        Ok(())
    }

    /// An editor opens the file at `path` (holds an fd on its inode).
    pub fn open_fd(&self, path: &str) -> Option<u64> {
        let ino = self.ino(path)?;
        *self.st.borrow_mut().open_fds.entry(ino).or_default() += 1;
        Some(ino)
    }

    /// The editor closes its fd on `ino`.
    pub fn close_fd(&self, ino: u64) {
        let mut st = self.st.borrow_mut();
        if let Some(n) = st.open_fds.get_mut(&ino) {
            *n -= 1;
            if *n == 0 {
                st.open_fds.remove(&ino);
            }
        }
    }

    /// Write through an fd opened earlier: lands in that inode wherever it is.
    pub fn write_inode(&self, ino: u64, bytes: &[u8]) {
        let mut st = self.st.borrow_mut();
        let t = Self::tick(&mut st);
        st.synthetic.remove(&ino);
        if let Some(i) = st.inodes.get_mut(&ino) {
            i.bytes = bytes.to_vec();
            i.mtime_ns = t;
        }
    }

    /// Remove a path (the inode survives while referenced by tests).
    pub fn unlink(&self, path: &str) {
        let k = self.key(path);
        self.st.borrow_mut().files.remove(&k);
    }

    /// Rename, replacing.
    pub fn rename_over(&self, from: &str, to: &str) {
        let mut st = self.st.borrow_mut();
        if let Some((_, ino)) = st.files.remove(&self.key(from)) {
            self.mkparents(&mut st, to);
            st.files.insert(self.key(to), (to.to_string(), ino));
        }
    }

    fn meta_of(&self, st: &State, ino: u64) -> FileMeta {
        let i = &st.inodes[&ino];
        FileMeta {
            kind: FileKind::File,
            size: st
                .synthetic
                .get(&ino)
                .copied()
                .unwrap_or(i.bytes.len() as u64),
            mtime_ns: i.mtime_ns,
            ctime_ns: Some(i.mtime_ns),
            id: Some(FileId(u128::from(ino))),
        }
    }

    fn lookup(&self, path: &RelPath) -> FsResult<u64> {
        self.st
            .borrow()
            .files
            .get(&self.key(path.as_str()))
            .map(|(_, i)| *i)
            .ok_or_else(|| FsError::new(FsErrorKind::NotFound, path.as_str()))
    }

    fn parent_exists(&self, path: &RelPath) -> FsResult<()> {
        if self
            .st
            .borrow()
            .dirs
            .contains(&self.key(path.parent().as_str()))
        {
            Ok(())
        } else {
            Err(FsError::new(FsErrorKind::NotFound, path.parent().as_str()))
        }
    }

    fn range_ino(&self, h: RangeHandle) -> FsResult<u64> {
        self.st
            .borrow()
            .ranges
            .get(&h.0)
            .copied()
            .ok_or_else(|| FsError::new(FsErrorKind::BadHandle, format!("{h:?}")))
    }

    fn check_lock(&self, h: LockHandle) -> FsResult<Lock> {
        self.st
            .borrow()
            .locks
            .get(&h.0)
            .cloned()
            .ok_or_else(|| FsError::new(FsErrorKind::BadHandle, format!("{h:?}")))
    }
}

/// Capabilities for a given strategy, as the real platforms declare them.
pub fn caps_for(replace: ReplaceStrategy, case: CaseSensitivity) -> Capabilities {
    Capabilities {
        replace,
        exclusive_create: replace != ReplaceStrategy::GuardedInPlace,
        durability: if replace == ReplaceStrategy::GuardedInPlace {
            Durability::None
        } else {
            Durability::Fsync
        },
        case,
        file_ids: replace != ReplaceStrategy::GuardedInPlace,
        mtime_resolution_ns: 1,
        events: EventFidelity::Precise,
        transient_missing: false,
        private_dir: RelPath::new(".mdbase").expect("valid"),
    }
}

/// A [`FilePlatform`] over a [`MemFs`]. Every call completes immediately.
pub struct MemPlatform {
    /// The file system.
    pub fs: Rc<MemFs>,
    /// Fixture-only retained-directory recommendation.
    pub retained_nosync: Cell<bool>,
    /// Fixture-only release-policy recommendation.
    pub release: Cell<crate::ReleasePolicy>,
    caps: Capabilities,
}

impl MemPlatform {
    /// A platform using `replace` over a fresh file system.
    pub fn new(replace: ReplaceStrategy, case: CaseSensitivity) -> MemPlatform {
        MemPlatform {
            fs: MemFs::new(case),
            retained_nosync: Cell::new(false),
            release: Cell::new(crate::ReleasePolicy::AfterRetention),
            caps: caps_for(replace, case),
        }
    }

    fn strategy_only(&self, s: ReplaceStrategy, op: &str) -> FsResult<()> {
        if self.caps.replace == s {
            Ok(())
        } else {
            Err(FsError::unsupported(op))
        }
    }
}

impl FilePlatform for MemPlatform {
    fn retained_nosync(&self) -> bool {
        self.retained_nosync.get()
    }

    fn release_policy(&self) -> crate::ReleasePolicy {
        self.release.get()
    }

    fn capabilities(&self) -> &Capabilities {
        &self.caps
    }

    fn stat(&self, path: &RelPath) -> impl Future<Output = FsResult<FileMeta>> {
        ready((|| {
            self.fs.begin("stat", path.as_str())?;
            let st = self.fs.st.borrow();
            if let Some((_, ino)) = st.files.get(&self.fs.key(path.as_str())) {
                return Ok(self.fs.meta_of(&st, *ino));
            }
            if st.dirs.contains(&self.fs.key(path.as_str())) {
                return Ok(FileMeta {
                    kind: FileKind::Dir,
                    size: 0,
                    mtime_ns: 0,
                    ctime_ns: None,
                    id: None,
                });
            }
            Err(FsError::new(FsErrorKind::NotFound, path.as_str()))
        })())
    }

    fn read(&self, path: &RelPath) -> impl Future<Output = FsResult<ReadResult>> {
        ready((|| {
            self.fs.begin("read", path.as_str())?;
            let ino = self.fs.lookup(path)?;
            if self.fs.st.borrow().synthetic.contains_key(&ino) {
                self.fs.st.borrow_mut().synthetic_whole_reads += 1;
                return Err(FsError::new(
                    FsErrorKind::Other,
                    "whole read of a synthetic (large) file",
                ));
            }
            let st = self.fs.st.borrow();
            Ok(ReadResult {
                bytes: st.inodes[&ino].bytes.clone(),
                meta: self.fs.meta_of(&st, ino),
            })
        })())
    }

    fn read_range(
        &self,
        path: &RelPath,
        offset: u64,
        len: u32,
    ) -> impl Future<Output = FsResult<Vec<u8>>> {
        ready((|| {
            self.fs.begin("read_range", path.as_str())?;
            let ino = self.fs.lookup(path)?;
            self.fs.ranged(ino, offset, len)
        })())
    }

    fn open_range_read(
        &self,
        path: &RelPath,
    ) -> impl Future<Output = FsResult<(RangeHandle, FileMeta)>> {
        ready((|| {
            self.fs.begin("open_range_read", path.as_str())?;
            let ino = self.fs.lookup(path)?;
            let mut st = self.fs.st.borrow_mut();
            st.next_range += 1;
            let h = st.next_range;
            st.ranges.insert(h, ino);
            let meta = self.fs.meta_of(&st, ino);
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
            self.fs.begin("read_at", &format!("{h:?}"))?;
            if len > MAX_READ_AT {
                return Err(FsError::new(FsErrorKind::Other, "read_at over 8 MiB"));
            }
            let ino = self.fs.range_ino(h)?;
            self.fs.ranged(ino, offset, len)
        })())
    }

    fn range_meta(&self, h: RangeHandle) -> impl Future<Output = FsResult<FileMeta>> {
        ready((|| {
            self.fs.begin("range_meta", &format!("{h:?}"))?;
            let ino = self.fs.range_ino(h)?;
            let st = self.fs.st.borrow();
            Ok(self.fs.meta_of(&st, ino))
        })())
    }

    fn close_range_read(&self, h: RangeHandle) -> impl Future<Output = FsResult<()>> {
        ready((|| {
            self.fs.begin("close_range_read", &format!("{h:?}"))?;
            self.fs.st.borrow_mut().ranges.remove(&h.0);
            Ok(())
        })())
    }

    fn list(&self, dir: &RelPath) -> impl Future<Output = FsResult<Vec<DirEntry>>> {
        ready((|| {
            self.fs.begin("list", dir.as_str())?;
            let st = self.fs.st.borrow();
            let dk = self.fs.key(dir.as_str());
            if !st.dirs.contains(&dk) {
                return Err(FsError::new(FsErrorKind::NotFound, dir.as_str()));
            }
            let child = |k: &str| -> Option<String> {
                let rest = if dk.is_empty() {
                    k
                } else {
                    k.strip_prefix(dk.as_str())?.strip_prefix('/')?
                };
                (!rest.is_empty() && !rest.contains('/')).then(|| rest.to_string())
            };
            let mut out = Vec::new();
            for (k, (disp, _)) in &st.files {
                if child(k).is_some() {
                    out.push(DirEntry {
                        name: disp.rsplit('/').next().unwrap_or(disp).to_string(),
                        kind: FileKind::File,
                    });
                }
            }
            for d in &st.dirs {
                if let Some(name) = child(d) {
                    out.push(DirEntry {
                        name,
                        kind: FileKind::Dir,
                    });
                }
            }
            Ok(out)
        })())
    }

    fn create_dir_all(&self, dir: &RelPath) -> impl Future<Output = FsResult<()>> {
        ready((|| {
            self.fs.begin("create_dir_all", dir.as_str())?;
            let mut st = self.fs.st.borrow_mut();
            let mut cur = String::new();
            for seg in dir.as_str().split('/').filter(|s| !s.is_empty()) {
                if !cur.is_empty() {
                    cur.push('/');
                }
                cur.push_str(seg);
                st.dirs.insert(self.fs.key(&cur));
            }
            Ok(())
        })())
    }

    fn write_new(
        &self,
        path: &RelPath,
        bytes: &[u8],
        _durable: bool,
    ) -> impl Future<Output = FsResult<FileMeta>> {
        ready((|| {
            self.fs.begin("write_new", path.as_str())?;
            self.fs.parent_exists(path)?;
            if self.fs.lookup(path).is_ok() {
                return Err(FsError::new(FsErrorKind::AlreadyExists, path.as_str()));
            }
            self.fs.write_replace(path.as_str(), bytes)?;
            let ino = self.fs.lookup(path)?;
            let st = self.fs.st.borrow();
            Ok(self.fs.meta_of(&st, ino))
        })())
    }

    fn append(&self, path: &RelPath, bytes: &[u8]) -> impl Future<Output = FsResult<()>> {
        ready((|| {
            self.fs.begin("append", path.as_str())?;
            let ino = self.fs.lookup(path)?;
            let mut st = self.fs.st.borrow_mut();
            st.inodes
                .get_mut(&ino)
                .expect("inode")
                .bytes
                .extend_from_slice(bytes);
            Ok(())
        })())
    }

    fn rename_noreplace(&self, from: &RelPath, to: &RelPath) -> impl Future<Output = FsResult<()>> {
        ready((|| {
            self.fs
                .begin("rename_noreplace", &format!("{from} -> {to}"))?;
            let ino = self.fs.lookup(from)?;
            self.fs.parent_exists(to)?;
            if self.fs.lookup(to).is_ok() {
                return Err(FsError::new(FsErrorKind::AlreadyExists, to.as_str()));
            }
            let mut st = self.fs.st.borrow_mut();
            st.files.remove(&self.fs.key(from.as_str()));
            st.files
                .insert(self.fs.key(to.as_str()), (to.as_str().to_string(), ino));
            Ok(())
        })())
    }

    fn remove_file(&self, path: &RelPath) -> impl Future<Output = FsResult<()>> {
        ready((|| {
            self.fs.begin("remove_file", path.as_str())?;
            self.fs.lookup(path)?;
            self.fs.unlink(path.as_str());
            Ok(())
        })())
    }

    fn flush(&self, scope: FlushScope) -> impl Future<Output = FsResult<()>> {
        ready(
            self.fs
                .begin("flush", &format!("{scope:?}"))
                .and_then(|()| {
                    let st = self.fs.st.borrow();
                    if st.fail_flushes || (st.fail_full_flushes && scope == FlushScope::Full) {
                        Err(FsError::new(FsErrorKind::Other, "flush refused"))
                    } else {
                        Ok(())
                    }
                }),
        )
    }

    fn exchange(&self, a: &RelPath, b: &RelPath) -> impl Future<Output = FsResult<()>> {
        ready((|| {
            self.strategy_only(ReplaceStrategy::Exchange, "exchange")?;
            self.fs.begin("exchange", &format!("{a} <-> {b}"))?;
            let ia = self.fs.lookup(a)?;
            let ib = self.fs.lookup(b)?;
            let mut st = self.fs.st.borrow_mut();
            st.files
                .insert(self.fs.key(a.as_str()), (a.as_str().to_string(), ib));
            st.files
                .insert(self.fs.key(b.as_str()), (b.as_str().to_string(), ia));
            Ok(())
        })())
    }

    fn copy_metadata(&self, from: &RelPath, to: &RelPath) -> impl Future<Output = FsResult<()>> {
        ready((|| {
            self.fs.begin("copy_metadata", &format!("{from} -> {to}"))?;
            self.fs.lookup(from)?;
            self.fs.lookup(to)?;
            Ok(())
        })())
    }

    fn lock(&self, path: &RelPath, share: LockShare) -> impl Future<Output = FsResult<LockHandle>> {
        ready((|| {
            self.strategy_only(ReplaceStrategy::LockedInPlace, "lock")?;
            self.fs.begin("lock", path.as_str())?;
            let ino = self.fs.lookup(path)?;
            let mut st = self.fs.st.borrow_mut();
            if st.locks.values().any(|l| l.ino == ino) {
                return Err(FsError::new(FsErrorKind::Busy, path.as_str()));
            }
            let h = st.next_lock;
            st.next_lock += 1;
            st.locks.insert(
                h,
                Lock {
                    ino,
                    path: path.as_str().to_string(),
                    share,
                },
            );
            Ok(LockHandle(h))
        })())
    }

    fn locked_read(&self, h: LockHandle) -> impl Future<Output = FsResult<ReadResult>> {
        ready((|| {
            let l = self.fs.check_lock(h)?;
            self.fs.begin("locked_read", &l.path)?;
            let st = self.fs.st.borrow();
            Ok(ReadResult {
                bytes: st.inodes[&l.ino].bytes.clone(),
                meta: self.fs.meta_of(&st, l.ino),
            })
        })())
    }

    fn locked_overwrite(
        &self,
        h: LockHandle,
        bytes: &[u8],
        _durable: bool,
    ) -> impl Future<Output = FsResult<()>> {
        ready((|| {
            let l = self.fs.check_lock(h)?;
            self.fs.begin("locked_overwrite", &l.path)?;
            let mut st = self.fs.st.borrow_mut();
            let t = MemFs::tick(&mut st);
            let i = st.inodes.get_mut(&l.ino).expect("inode");
            i.bytes = bytes.to_vec();
            i.mtime_ns = t;
            Ok(())
        })())
    }

    fn locked_move_aside(&self, h: LockHandle, to: &RelPath) -> impl Future<Output = FsResult<()>> {
        ready((|| {
            let l = self.fs.check_lock(h)?;
            self.fs
                .begin("locked_move_aside", &format!("{} -> {to}", l.path))?;
            self.fs.parent_exists(to)?;
            if self.fs.lookup(to).is_ok() {
                return Err(FsError::new(FsErrorKind::AlreadyExists, to.as_str()));
            }
            let mut st = self.fs.st.borrow_mut();
            // The handle follows the file, wherever its path currently is.
            let cur = st
                .files
                .iter()
                .find(|(_, (_, i))| *i == l.ino)
                .map(|(k, _)| k.clone())
                .ok_or_else(|| FsError::new(FsErrorKind::NotFound, l.path.clone()))?;
            st.files.remove(&cur);
            st.files
                .insert(self.fs.key(to.as_str()), (to.as_str().to_string(), l.ino));
            if let Some(lk) = st.locks.get_mut(&h.0) {
                lk.path = to.as_str().to_string();
            }
            Ok(())
        })())
    }

    fn unlock(&self, h: LockHandle) -> impl Future<Output = FsResult<()>> {
        ready((|| {
            let l = self.fs.check_lock(h)?;
            self.fs.begin("unlock", &l.path)?;
            self.fs.st.borrow_mut().locks.remove(&h.0);
            let _ = l.share;
            Ok(())
        })())
    }

    fn guarded_replace(
        &self,
        path: &RelPath,
        expect: &[u8],
        new: &[u8],
    ) -> impl Future<Output = FsResult<Guarded>> {
        ready((|| {
            self.strategy_only(ReplaceStrategy::GuardedInPlace, "guarded_replace")?;
            self.fs.begin("guarded_replace", path.as_str())?;
            match self.fs.get(path.as_str()) {
                None => Ok(Guarded::Missing),
                Some(cur) if cur != expect => Ok(Guarded::Mismatch(cur)),
                Some(_) => {
                    self.fs.write_in_place(path.as_str(), new)?;
                    Ok(Guarded::Done)
                }
            }
        })())
    }

    fn guarded_create(
        &self,
        path: &RelPath,
        bytes: &[u8],
    ) -> impl Future<Output = FsResult<Guarded>> {
        ready((|| {
            self.strategy_only(ReplaceStrategy::GuardedInPlace, "guarded_create")?;
            self.fs.begin("guarded_create", path.as_str())?;
            if self.fs.get(path.as_str()).is_some() {
                return Ok(Guarded::Exists);
            }
            self.fs.write_in_place(path.as_str(), bytes)?;
            Ok(Guarded::Done)
        })())
    }

    fn other_holders(&self, path: &RelPath) -> impl Future<Output = FsResult<Holders>> {
        ready((|| {
            // Only the exchange strategy models Linux leases.
            if self.caps.replace != ReplaceStrategy::Exchange {
                return Ok(Holders::Unknown);
            }
            self.fs.begin("other_holders", path.as_str())?;
            let ino = self.fs.lookup(path)?;
            Ok(if self.fs.st.borrow().open_fds.contains_key(&ino) {
                Holders::Some
            } else {
                Holders::None
            })
        })())
    }

    fn guarded_trash(
        &self,
        path: &RelPath,
        expect: &[u8],
    ) -> impl Future<Output = FsResult<Guarded>> {
        ready((|| {
            self.strategy_only(ReplaceStrategy::GuardedInPlace, "guarded_trash")?;
            self.fs.begin("guarded_trash", path.as_str())?;
            match self.fs.get(path.as_str()) {
                None => Ok(Guarded::Missing),
                Some(cur) if cur != expect => Ok(Guarded::Mismatch(cur)),
                Some(_) => {
                    self.fs.unlink(path.as_str());
                    Ok(Guarded::Done)
                }
            }
        })())
    }
}
