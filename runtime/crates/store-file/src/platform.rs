//! `FilePlatform`: the file system as one platform sees it.
//!
//! The file-backed store runs the never-clobber publish protocol, recovery,
//! ingest and move detection in portable Rust. Everything that touches a real
//! file goes through this trait, so the same protocol code runs on:
//! - Linux, macOS and Windows (`mdbn-platform-native`);
//! - the Obsidian vault API (TS, through the WASM host queue, [`crate::host`]);
//! - the simulator's OS models (`mdbn-sim`).
//!
//! # Sync vs async
//!
//! Every I/O method returns a future. A WASM host (Obsidian) only has
//! promise-based file APIs and no way to block the WASM thread on one (no JSPI
//! on Android WebView 133), so an operation must be able to complete later.
//! - Native platforms do blocking I/O inside the call and return an
//!   already-completed future. There is no async runtime anywhere.
//! - The WASM host and the simulator use [`crate::host::QueuedPlatform`]: each
//!   call becomes a [`crate::host::FileOp`] request that the host performs and
//!   completes by id. The simulator completes them in any order it likes and can
//!   crash between any two, which is how the protocol gets explored.
//!
//! Futures are `!Send` and polled by the store's own single-threaded task loop
//! with a no-op waker. Methods take `&self`; implementations use interior
//! mutability where they need state (handle tables).
//!
//! [`FilePlatform::capabilities`] is synchronous: it is probed once when the
//! platform is constructed (which a host may do asynchronously) and does not
//! change while the store is open.
//!
//! # Paths
//!
//! Every path is a [`RelPath`]: relative to the collection root, `/`-separated,
//! as the bytes are named on disk (not a path key; case folding and NFC belong to
//! `mdbn_core::paths`). The store's own files (temps, stashes, preserved copies)
//! live under [`Capabilities::private_dir`] on the same volume.
//!
//! # Platform strategies
//!
//! Platforms differ in which primitives exist, not just in how fast they are.
//! [`Capabilities`] says which publish strategy the store must use, and the
//! primitives a strategy does not need may return [`FsErrorKind::Unsupported`]
//! (the default implementations do). The strategies are:
//!
//! | Strategy | Platforms | Primitives |
//! |---|---|---|
//! | [`ReplaceStrategy::Exchange`] | Linux (`renameat2(RENAME_EXCHANGE)`), macOS APFS (`renamex_np(RENAME_SWAP)`) | `write_new`, `copy_metadata`, `exchange`, `rename_noreplace`, `flush` |
//! | [`ReplaceStrategy::LockedInPlace`] | Windows (protocol D) | `lock`, `locked_read`, `locked_overwrite`, `locked_move_aside`, `unlock` |
//! | [`ReplaceStrategy::GuardedInPlace`] | Obsidian vault | `guarded_replace`, `guarded_create`, `guarded_trash` |
//! | [`ReplaceStrategy::ReadOnly`] | volumes without a safe primitive (macOS FAT/exFAT/SMB) | none: the store never publishes |

use std::fmt;
use std::future::Future;

/// A path relative to the collection root, `/`-separated.
///
/// Syntactic checks only: non-empty segments, no `.`/`..`, no leading or
/// trailing `/`, no `\`, no NUL. The empty path is the root (valid for
/// directory operations only).
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct RelPath(String);

impl RelPath {
    /// The collection root.
    pub const ROOT: RelPath = RelPath(String::new());

    /// Validate and wrap a relative path.
    pub fn new(s: impl Into<String>) -> Result<RelPath, FsError> {
        let s = s.into();
        if s.is_empty() {
            return Ok(RelPath(s));
        }
        // `:` (drive prefixes such as `C:x.md`, NTFS alternate data
        // streams) and control characters never reach a platform.
        let bad = s.starts_with('/')
            || s.ends_with('/')
            || s.contains('\\')
            || s.contains(':')
            || s.chars().any(char::is_control)
            || s.split('/')
                .any(|seg| seg.is_empty() || seg == "." || seg == "..");
        if bad {
            return Err(FsError::new(FsErrorKind::InvalidPath, s));
        }
        Ok(RelPath(s))
    }

    /// The path as a `/`-separated string.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// True for the collection root.
    pub fn is_root(&self) -> bool {
        self.0.is_empty()
    }

    /// The parent directory (the root's parent is the root).
    pub fn parent(&self) -> RelPath {
        match self.0.rsplit_once('/') {
            Some((p, _)) => RelPath(p.to_string()),
            None => RelPath::ROOT,
        }
    }

    /// The last segment (empty for the root).
    pub fn file_name(&self) -> &str {
        self.0.rsplit_once('/').map_or(self.0.as_str(), |(_, n)| n)
    }

    /// `self/rest`, validated as a whole (`rest` may hold several segments).
    pub fn join(&self, name: &str) -> Result<RelPath, FsError> {
        if self.is_root() {
            RelPath::new(name)
        } else {
            RelPath::new(format!("{}/{name}", self.0))
        }
    }
}

/// Why a collection path is not portable, if it is not. Delegates to
/// `mdbn_core::paths::check_path`, the one policy submit, ingest, V7 and
/// publish share: hidden and private segments, reserved characters, control
/// and ignorable characters, trailing dot or space, Windows device names, 8.3
/// short-name aliases, and length limits. `RelPath` itself also admits the
/// store's private dot-directory, which this rejects.
pub fn portable_violation(path: &str) -> Option<&'static str> {
    mdbn_core::paths::check_path(path).err().map(|v| v.reason())
}

impl fmt::Debug for RelPath {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}", self.0)
    }
}

impl fmt::Display for RelPath {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// A stable file identity: an inode (with device) on Unix, a 128-bit file ID on
/// Windows. Used to pair renames (move detection) and to tell
/// our inode from a user's after a swap. Platforms without one report `None`.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub struct FileId(pub u128);

/// What kind of object a path names.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum FileKind {
    /// A regular file.
    File,
    /// A directory.
    Dir,
    /// A symlink, socket, device, ... The store ignores these.
    Other,
}

/// File metadata. Change detection uses it as a hint only: equal metadata means
/// "probably unchanged"; the content hash decides because metadata misses
/// same-size, same-mtime replaces.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct FileMeta {
    /// What the path names.
    pub kind: FileKind,
    /// Size in bytes.
    pub size: u64,
    /// Modification time, nanoseconds since the Unix epoch, at the platform's
    /// resolution ([`Capabilities::mtime_resolution_ns`]).
    pub mtime_ns: i64,
    /// Status-change time (Unix `ctime`) where the platform has one. Catches
    /// in-place rewrites that restore the mtime.
    pub ctime_ns: Option<i64>,
    /// Stable identity, if the platform has one.
    pub id: Option<FileId>,
}

/// One directory entry.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct DirEntry {
    /// The entry's name (one segment).
    pub name: String,
    /// What it is. Symlinks are [`FileKind::Other`] and are not followed.
    pub kind: FileKind,
}

/// Bytes plus the metadata of the file they were read from.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ReadResult {
    /// The whole content.
    pub bytes: Vec<u8>,
    /// Metadata taken from the same open file after reading (`fstat` on the
    /// handle, not a second path lookup).
    pub meta: FileMeta,
}

/// What a durability barrier covers. Platforms without durable writes
/// ([`Durability::None`]) treat every scope as a no-op.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum FlushScope {
    /// One file's data and metadata (`fsync`).
    File(RelPath),
    /// A directory's entries, so renames and creates in it survive a crash.
    Dir(RelPath),
    /// Order every earlier write before every later one, without forcing the
    /// device cache (macOS `F_BARRIERFSYNC`; elsewhere the same as `Full`). One
    /// per publish batch, before the swaps.
    Barrier,
    /// Everything written so far is on stable storage (Linux `syncfs`, macOS
    /// `F_FULLFSYNC`). The commit point of a batch.
    Full,
}

/// How a locked handle shares the file with other processes while we hold it.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum LockShare {
    /// Others may read, not write or delete (`FILE_SHARE_READ`, protocol D).
    /// Readers can see a torn mix for the duration of the overwrite.
    Read,
    /// Nobody else may open the file. This avoids exposing torn reads:
    /// editors then see sharing violations instead of torn content.
    None,
}

/// An open positional reader of one regular file ([`FilePlatform::open_range_read`]).
/// Opaque; valid until [`FilePlatform::close_range_read`] or until the platform is
/// dropped. It stays bound to the file it opened: a rename or replace of the path
/// never retargets it.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub struct RangeHandle(pub u64);

/// Largest single [`FilePlatform::read_at`]: one attachment chunk (8 MiB). Large
/// files are read in pieces of at most this, never whole.
pub const MAX_READ_AT: u32 = 8 << 20;

/// An open, locked file (protocol D). Opaque; valid until [`FilePlatform::unlock`]
/// or until the platform is dropped. A crash releases every lock.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub struct LockHandle(pub u64);

/// Result of a guarded vault operation.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Guarded {
    /// The guard held and the write (or trash) was issued.
    Done,
    /// The path holds other bytes. Nothing was written. Carries what is there.
    Mismatch(Vec<u8>),
    /// The path does not exist.
    Missing,
    /// The path exists (create only). Nothing was written.
    Exists,
}

/// Whether processes other than the caller have a file open (see
/// [`FilePlatform::other_holders`]).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Holders {
    /// Nobody else has it open: no write can land in it any more.
    None,
    /// Someone has it open and may still write into it.
    Some,
    /// The platform cannot tell (macOS, network and FUSE volumes, the vault).
    Unknown,
}

/// Which publish strategy the store must use (see the module docs).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ReplaceStrategy {
    /// Write a temp, swap it with the target atomically, verify what was
    /// displaced, restore on mismatch (Linux/macOS, guarded exchange and verification).
    Exchange,
    /// Windows protocol D: lock, verify, overwrite in place through the handle.
    LockedInPlace,
    /// The Obsidian vault: hash-guarded in-place write, serialised only against
    /// the vault's own writers.
    GuardedInPlace,
    /// No safe primitive on this volume: never publish; ingest only.
    ReadOnly,
}

/// Whether completed writes survive power loss.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Durability {
    /// `fsync` and friends work; [`FilePlatform::flush`] is meaningful.
    Fsync,
    /// No durability primitive (the vault adapter never fsyncs). Recovery
    /// must assume torn or missing tails after power loss.
    None,
}

/// How the volume compares names.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CaseSensitivity {
    /// `a.md` and `A.md` are different files.
    Sensitive,
    /// Case-insensitive, case-preserving (NTFS, APFS default, Android shared
    /// storage). A case-only rename needs a temporary name.
    Insensitive,
}

/// How much the platform's change events can be trusted.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum EventFidelity {
    /// Events name the changed path promptly (inotify, FSEvents, RDCW). Overflow
    /// is reported as [`FileEventKind::Rescan`].
    Precise,
    /// Events are hints: intermediate states, missed same-size replaces, no
    /// catch-up after a restart (Obsidian vault). The store re-hashes
    /// and runs a slow background pass.
    Hint,
}

/// What a platform can do, probed once at construction.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Capabilities {
    /// The publish strategy for replacing an existing file.
    pub replace: ReplaceStrategy,
    /// `write_new` fails atomically on an existing path (`O_EXCL`,
    /// `CREATE_NEW`). False on the vault (check-then-write).
    pub exclusive_create: bool,
    /// Whether flushes make data durable.
    pub durability: Durability,
    /// Name comparison on this volume.
    pub case: CaseSensitivity,
    /// [`FileMeta::id`] is populated and stable across renames.
    pub file_ids: bool,
    /// Modification time granularity in nanoseconds (2 s on FAT).
    pub mtime_resolution_ns: u64,
    /// Watcher quality.
    pub events: EventFidelity,
    /// The path can briefly appear missing during a swap (macOS concurrent
    /// `stat` calls). Ingest re-checks before treating "missing" as a
    /// delete on every platform; this lengthens the re-check.
    pub transient_missing: bool,
    /// Directory for the store's temps, stashes and preserved files, on the same
    /// volume (renames into and out of it must not copy). Usually `.mdbase`.
    pub private_dir: RelPath,
}

/// What the host knows about other sync tools on this collection, beyond what
/// the store can see in the file tree (marker files such as `.stfolder` are
/// detected portably by listing the root).
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct PlatformEnvironment {
    /// The absolute root as the user would recognise it, for path-pattern
    /// detection (iCloud `Mobile Documents`, `Dropbox`, `OneDrive`). `None` where
    /// the platform cannot say.
    pub root_display: Option<String>,
    /// Signals only the host can observe (enabled Obsidian Sync with a remote
    /// vault, sync plugins, a cloud-files provider owning the folder).
    pub signals: Vec<ForeignSyncSignal>,
}

/// A host-observed sign that another sync tool manages the collection.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ForeignSyncSignal {
    /// Tool name for the user ("Obsidian Sync", "Syncthing", "OneDrive").
    pub tool: String,
    /// How sure the host is.
    pub strength: SignalStrength,
    /// What was seen, for diagnostics.
    pub evidence: String,
}

/// Confidence of a [`ForeignSyncSignal`].
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum SignalStrength {
    /// Behavioural guess.
    Weak,
    /// Path pattern or conflict-copy names.
    Medium,
    /// Configuration or marker files.
    Strong,
}

/// A change notification from the platform's watcher. Hosts push these into the
/// store; the store treats them as hints and always re-reads after its
/// quiescence window.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct FileEvent {
    /// What happened.
    pub kind: FileEventKind,
    /// The path concerned (for `Rescan`, the subtree to rescan; root = all).
    pub path: RelPath,
    /// The file's identity if the watcher reports one (FSEvents inode, Windows
    /// file ID), for pairing renames.
    pub id: Option<FileId>,
    /// Watcher-provided rename cookie (inotify), pairing `RenamedFrom`/`To`.
    pub cookie: Option<u64>,
}

/// Kinds of [`FileEvent`].
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum FileEventKind {
    /// Something may have changed at the path.
    Changed,
    /// The path was created.
    Created,
    /// The path was removed. The store re-checks before treating it as a
    /// delete.
    Removed,
    /// The path was renamed away (half of a pair).
    RenamedFrom,
    /// The path was renamed in (half of a pair).
    RenamedTo,
    /// Events were lost (queue overflow, sleep, restart): rescan `path`.
    Rescan,
}

/// Error categories the protocols branch on.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum FsErrorKind {
    /// The path (or a parent) does not exist.
    NotFound,
    /// The target exists (exclusive create, no-replace rename).
    AlreadyExists,
    /// Another process holds the file open in a conflicting mode (Windows).
    /// Back off and retry; never treat as a change.
    Busy,
    /// A path component is not a directory, or a file was expected.
    WrongKind,
    /// Access denied.
    PermissionDenied,
    /// The volume is full or over quota.
    NoSpace,
    /// The path failed [`RelPath`] validation or the platform's own naming rules.
    InvalidPath,
    /// This platform does not provide the primitive (see [`ReplaceStrategy`]).
    Unsupported,
    /// The lock handle is unknown or already released.
    BadHandle,
    /// Anything else.
    Other,
}

/// A platform error: a kind to branch on and a message for logs.
#[derive(Clone, PartialEq, Eq)]
pub struct FsError {
    /// What went wrong.
    pub kind: FsErrorKind,
    /// Detail for diagnostics only. Never parsed.
    pub detail: String,
}

impl FsError {
    /// Build an error.
    pub fn new(kind: FsErrorKind, detail: impl Into<String>) -> FsError {
        FsError {
            kind,
            detail: detail.into(),
        }
    }

    /// The `Unsupported` error for a primitive.
    pub fn unsupported(op: &str) -> FsError {
        FsError::new(FsErrorKind::Unsupported, op)
    }

    /// True for `NotFound`.
    pub fn is_not_found(&self) -> bool {
        self.kind == FsErrorKind::NotFound
    }
}

impl fmt::Debug for FsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}({})", self.kind, self.detail)
    }
}

impl fmt::Display for FsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(self, f)
    }
}

/// Result alias for platform calls.
pub type FsResult<T> = Result<T, FsError>;

fn unsupported<T>(op: &'static str) -> impl Future<Output = FsResult<T>> {
    std::future::ready(Err(FsError::unsupported(op)))
}

/// The file system under one collection root, as one platform sees it.
///
/// See the module docs for the async model, paths and strategies. Every method
/// must be safe to call concurrently with other processes changing the same
/// files: the store assumes nothing between two calls.
pub trait FilePlatform {
    /// What this platform can do. Constant while the store is open.
    fn capabilities(&self) -> &Capabilities;

    /// Default retained-inode schedule. Native macOS overrides this;
    /// older hosts and queued/vault platforms retain timed behavior.
    fn release_policy(&self) -> crate::ReleasePolicy {
        crate::ReleasePolicy::AfterRetention
    }

    /// Native macOS places new retained inodes in a private `.nosync` directory.
    /// Persist the selection in each intent so legacy recovery uses its old name.
    fn retained_nosync(&self) -> bool {
        false
    }

    /// Host-side knowledge about other sync tools. Called at open and
    /// occasionally after.
    fn environment(&self) -> impl Future<Output = FsResult<PlatformEnvironment>> {
        std::future::ready(Ok(PlatformEnvironment::default()))
    }

    // ---- reading -------------------------------------------------------

    /// Metadata of `path`, not following symlinks. `NotFound` if absent.
    fn stat(&self, path: &RelPath) -> impl Future<Output = FsResult<FileMeta>>;

    /// The whole file plus the metadata of the handle it was read through.
    fn read(&self, path: &RelPath) -> impl Future<Output = FsResult<ReadResult>>;

    /// Up to `len` bytes at `offset`, for hashing large files without holding
    /// them in memory. Returns fewer bytes at end of file.
    fn read_range(
        &self,
        path: &RelPath,
        offset: u64,
        len: u32,
    ) -> impl Future<Output = FsResult<Vec<u8>>>;

    /// Open `path` (a regular file, not following symlinks) for bounded
    /// positional reads, with the metadata of the opened handle. Platforms
    /// without a stable handle return `Unsupported`, and the store does not
    /// ingest large files there.
    fn open_range_read(
        &self,
        path: &RelPath,
    ) -> impl Future<Output = FsResult<(RangeHandle, FileMeta)>> {
        let _ = path;
        unsupported("open_range_read")
    }

    /// Exactly `len` (at most [`MAX_READ_AT`]) bytes at `offset` through the
    /// handle, or fewer at end of file. `Busy`/`WrongKind` when the file under
    /// the handle changed in a way the platform can see (the caller restarts).
    fn read_at(
        &self,
        h: RangeHandle,
        offset: u64,
        len: u32,
    ) -> impl Future<Output = FsResult<Vec<u8>>> {
        let _ = (h, offset, len);
        unsupported("read_at")
    }

    /// Current metadata of the handle's file (`fstat`), to detect a change
    /// during a read.
    fn range_meta(&self, h: RangeHandle) -> impl Future<Output = FsResult<FileMeta>> {
        let _ = h;
        unsupported("range_meta")
    }

    /// Release the handle. Never fails for a valid handle.
    fn close_range_read(&self, h: RangeHandle) -> impl Future<Output = FsResult<()>> {
        let _ = h;
        unsupported("close_range_read")
    }

    /// Entries of a directory, in any order (the store sorts). Symlinks are
    /// listed as [`FileKind::Other`].
    fn list(&self, dir: &RelPath) -> impl Future<Output = FsResult<Vec<DirEntry>>>;

    // ---- writing (all strategies) ---------------------------------------

    /// Create `dir` and its parents. Succeeds if it exists.
    fn create_dir_all(&self, dir: &RelPath) -> impl Future<Output = FsResult<()>>;

    /// Create `path` with `bytes`, failing with `AlreadyExists` if it exists
    /// (atomically when [`Capabilities::exclusive_create`]). With `durable`, the
    /// data is flushed before returning. Returns the new file's metadata.
    fn write_new(
        &self,
        path: &RelPath,
        bytes: &[u8],
        durable: bool,
    ) -> impl Future<Output = FsResult<FileMeta>>;

    /// Append to a file the store created (chunked materialization of large
    /// blobs into a temp). Never used on user files.
    fn append(&self, path: &RelPath, bytes: &[u8]) -> impl Future<Output = FsResult<()>> {
        let _ = (path, bytes);
        unsupported("append")
    }

    /// Rename `from` to `to`, failing with `AlreadyExists` if `to` exists
    /// (`RENAME_NOREPLACE`, `MoveFileEx` without replace). Must never replace.
    fn rename_noreplace(&self, from: &RelPath, to: &RelPath) -> impl Future<Output = FsResult<()>>;

    /// Remove a file. Used only on the store's own private files and on user
    /// files already moved aside and verified.
    fn remove_file(&self, path: &RelPath) -> impl Future<Output = FsResult<()>>;

    /// Make earlier writes durable (see [`FlushScope`]).
    fn flush(&self, scope: FlushScope) -> impl Future<Output = FsResult<()>>;

    // ---- Exchange strategy (Linux, macOS) --------------------------------

    /// Atomically swap the files at `a` and `b`; both must exist.
    fn exchange(&self, a: &RelPath, b: &RelPath) -> impl Future<Output = FsResult<()>> {
        let _ = (a, b);
        unsupported("exchange")
    }

    /// Copy user-visible metadata (permissions, xattrs and Finder tags, ACLs,
    /// creation date) from `from` onto `to` before a swap.
    /// Platforms with nothing to copy return `Ok(())`.
    fn copy_metadata(&self, from: &RelPath, to: &RelPath) -> impl Future<Output = FsResult<()>> {
        let _ = (from, to);
        std::future::ready(Ok(()))
    }

    // ---- LockedInPlace strategy (Windows protocol D) ----------------------

    /// Open an existing file for read and write, sharing as `share`. `Busy` on a
    /// sharing violation (back off), `NotFound` if absent (hold).
    fn lock(&self, path: &RelPath, share: LockShare) -> impl Future<Output = FsResult<LockHandle>> {
        let _ = (path, share);
        unsupported("lock")
    }

    /// Read the whole file through the lock handle.
    fn locked_read(&self, h: LockHandle) -> impl Future<Output = FsResult<ReadResult>> {
        let _ = h;
        unsupported("locked_read")
    }

    /// Overwrite through the handle: write at offset 0, set end of file, and
    /// flush (`FlushFileBuffers`) when `durable`.
    fn locked_overwrite(
        &self,
        h: LockHandle,
        bytes: &[u8],
        durable: bool,
    ) -> impl Future<Output = FsResult<()>> {
        let _ = (h, bytes, durable);
        unsupported("locked_overwrite")
    }

    /// Rename the locked file to `to` by handle, without replacing (deletes:
    /// lock, verify, move aside into the private dir).
    fn locked_move_aside(&self, h: LockHandle, to: &RelPath) -> impl Future<Output = FsResult<()>> {
        let _ = (h, to);
        unsupported("locked_move_aside")
    }

    /// Release the lock. Never fails for a valid handle.
    fn unlock(&self, h: LockHandle) -> impl Future<Output = FsResult<()>> {
        let _ = h;
        unsupported("unlock")
    }

    /// Whether any other open file description exists for `path` (Linux:
    /// a write lease, `F_SETLEASE`, is granted only when none does). Settling a
    /// retained file asks this first, so a file an editor opened before the swap
    /// and has not written yet is kept instead of released, preserving any
    /// delayed write into the displaced inode.
    fn other_holders(&self, path: &RelPath) -> impl Future<Output = FsResult<Holders>> {
        let _ = path;
        std::future::ready(Ok(Holders::Unknown))
    }

    // ---- GuardedInPlace strategy (Obsidian vault) --------------------------

    /// Replace `path` with `new` only if it holds exactly `expect`, serialised
    /// against the vault's own writers (`vault.process` with a byte comparison).
    /// Not atomic against outside processes. The comparison is on
    /// bytes, not hashes, because the guard runs synchronously in JS.
    fn guarded_replace(
        &self,
        path: &RelPath,
        expect: &[u8],
        new: &[u8],
    ) -> impl Future<Output = FsResult<Guarded>> {
        let _ = (path, expect, new);
        unsupported("guarded_replace")
    }

    /// Create `path` if absent (`vault.create`: check-then-write).
    fn guarded_create(
        &self,
        path: &RelPath,
        bytes: &[u8],
    ) -> impl Future<Output = FsResult<Guarded>> {
        let _ = (path, bytes);
        unsupported("guarded_create")
    }

    /// Move `path` to the trash if it holds exactly `expect`.
    fn guarded_trash(
        &self,
        path: &RelPath,
        expect: &[u8],
    ) -> impl Future<Output = FsResult<Guarded>> {
        let _ = (path, expect);
        unsupported("guarded_trash")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relpath_validation() {
        for ok in ["", "a", "a/b.md", ".mdbase/tmp/1", "notes/ünïcode.md"] {
            assert!(RelPath::new(ok).is_ok(), "{ok}");
        }
        for bad in [
            "/a",
            "a/",
            "a//b",
            "./a",
            "a/../b",
            "..",
            "a\\b",
            "a\0",
            "C:evil.md",
            "d/C:x",
            "a.md:stream",
            "x\ny",
        ] {
            assert!(RelPath::new(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn portable_policy() {
        for ok in ["a.md", "notes/ünï code.md", "x/y.z.md", "console.md"] {
            assert_eq!(portable_violation(ok), None, "{ok}");
        }
        for bad in [
            ".obsidian/plugins/x/main.js",
            ".git/hooks/pre-commit",
            ".MDBASE/stash/1",
            ".mdbase./x",
            "a/.vscode/tasks.json",
            "C:evil.md",
            "a|b.md",
            "q?.md",
            "trail.",
            "trail ",
            "CON",
            "nul.md",
            "com1.txt",
            "LPT9",
            "",
            "GIT~1/config",
            "MDBASE~1/x",
            "a\u{200c}.md",
            "COM\u{b9}.md",
        ] {
            assert!(portable_violation(bad).is_some(), "{bad:?}");
        }
        assert!(portable_violation(&"x".repeat(256)).is_some());
    }

    #[test]
    fn relpath_parts() {
        let p = RelPath::new("a/b/c.md").unwrap();
        assert_eq!(p.parent().as_str(), "a/b");
        assert_eq!(p.file_name(), "c.md");
        assert_eq!(RelPath::new("c.md").unwrap().parent(), RelPath::ROOT);
        assert_eq!(RelPath::ROOT.join("x").unwrap().as_str(), "x");
        assert_eq!(p.parent().join("d").unwrap().as_str(), "a/b/d");
        assert!(p.join("x/y").is_ok()); // join validates the result, not segment count
        assert!(p.join("..").is_err());
    }
}
