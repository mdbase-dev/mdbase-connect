//! Simulated machines and the per-OS file platform models.
//!
//! A [`Machine`] owns a [`Disk`], an open-handle table, a machine-local clock and a
//! machine-local event queue for the processes running on it (editors, git, a sync
//! tool). A [`Proc`] is one process's view: every call goes through it, and every
//! call first runs the machine's [`Hook`], which may:
//! - let another local process act right now (an editor save landing between two
//!   of the replica's syscalls);
//! - **stall** the caller: the machine clock runs ahead and local processes act
//!   while the caller is descheduled (modelling overloaded-host stalls during
//!   publication);
//! - crash the calling process. A crashed process's calls all fail with
//!   [`FsError::Crashed`] and change nothing; the world discards its outputs.
//!
//! OS semantics ([`Os`]):
//! - **Linux:** `renameat2` exchange and no-replace, POSIX unlink, no share modes.
//! - **macOS:** `renamex_np` swap and excl. A swap shows the path missing to a
//!   concurrent `stat` with a configurable probability: modelled as a swap that, with
//!   [`MacOs::p_swap_window`], runs the hook between unlinking and relinking the
//!   path. `fat32: true` models a volume where swap "succeeds" as a plain rename.
//! - **Windows:** share modes on every open, rename and delete (Windows share-mode contract), no
//!   exchange, classic replace fails if any handle is open on the target.
//! - The **Obsidian vault adapter** is a layer over another OS: see `crate::vault`.

use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::fmt;
use std::rc::Rc;

use crate::disk::{Disk, Ino, NsDurability, parent};
use crate::kv::Kv;
use crate::rng::{Ppm, SimRng};
use crate::sched::{Queue, SimTime};

/// Operating system model.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    /// Linux ext4.
    Linux,
    /// macOS.
    MacOs(MacOs),
    /// Windows NTFS.
    Windows,
}

/// macOS parameters.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MacOs {
    /// Chance a swap exposes a missing-path window to other processes.
    pub p_swap_window: Ppm,
    /// The volume lacks `VOL_CAP_INT_RENAME_SWAP` but lies (FAT32/msdos): a swap is
    /// a plain rename that clobbers the target.
    pub fat32: bool,
    /// Chance `proc_listpidspath` misses a process that has the file open
    /// (sandboxed apps and other users' processes are invisible without
    /// privileges).
    pub p_hidden_holder: Ppm,
}

impl MacOs {
    /// Local APFS model parameters.
    pub fn apfs() -> Self {
        MacOs {
            p_swap_window: 1_000,
            fat32: false,
            p_hidden_holder: 0,
        }
    }
}

impl Os {
    /// Short name for traces.
    pub fn name(&self) -> &'static str {
        match self {
            Os::Linux => "linux",
            Os::MacOs(m) if m.fat32 => "macos-fat32",
            Os::MacOs(_) => "macos",
            Os::Windows => "windows",
        }
    }
}

/// A file system error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FsError {
    /// ENOENT / ERROR_FILE_NOT_FOUND.
    NotFound,
    /// EEXIST / STATUS_OBJECT_NAME_COLLISION.
    Exists,
    /// ERROR_SHARING_VIOLATION (Windows).
    SharingViolation,
    /// ERROR_ACCESS_DENIED (Windows classic replace with handles open).
    AccessDenied,
    /// ENOTSUP / EINVAL: the operation does not exist on this platform.
    Unsupported,
    /// The calling process has crashed.
    Crashed,
    /// A bad file descriptor.
    BadFd,
}

impl fmt::Display for FsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(self, f)
    }
}

/// Result of a file system call.
pub type FsResult<T> = Result<T, FsError>;

/// `stat` result.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Meta {
    /// Size in bytes.
    pub size: u64,
    /// Modification time, ns.
    pub mtime_ns: u64,
    /// Inode / file ID.
    pub ino: Ino,
    /// A directory.
    pub is_dir: bool,
}

/// Windows access bits (also used, without enforcement, on POSIX).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Access {
    /// GENERIC_READ.
    pub read: bool,
    /// GENERIC_WRITE.
    pub write: bool,
    /// DELETE.
    pub delete: bool,
}

impl Access {
    /// Read only.
    pub const R: Access = Access {
        read: true,
        write: false,
        delete: false,
    };
    /// Read and write.
    pub const RW: Access = Access {
        read: true,
        write: true,
        delete: false,
    };
    /// Write only.
    pub const W: Access = Access {
        read: false,
        write: true,
        delete: false,
    };
    /// Read and delete.
    pub const RD: Access = Access {
        read: true,
        write: false,
        delete: true,
    };
    /// Attributes only (no data access).
    pub const NONE: Access = Access {
        read: false,
        write: false,
        delete: false,
    };
}

/// Windows share mask: what other handles may do while this one is open.
pub type Share = Access;

/// Share everything (POSIX default; libuv on Windows).
pub const SHARE_ALL: Share = Access {
    read: true,
    write: true,
    delete: true,
};

/// How `open` treats the path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Disposition {
    /// Must exist (OPEN_EXISTING).
    Existing,
    /// Create if missing (OPEN_IF / OPEN_ALWAYS / O_CREAT).
    OpenOrCreate,
    /// Create if missing, truncate if present (CREATE_ALWAYS / O_CREAT|O_TRUNC).
    Truncate,
    /// Must not exist (CREATE_NEW / O_EXCL).
    CreateNew,
    /// Must exist; truncate (TRUNCATE_EXISTING / O_TRUNC without O_CREAT).
    TruncateExisting,
}

/// An open file handle.
#[derive(Debug, Clone)]
pub struct Handle {
    /// The inode it refers to (follows renames).
    pub ino: Ino,
    /// Owning process.
    pub proc: String,
    /// Granted access.
    pub access: Access,
    /// Share mask.
    pub share: Share,
}

/// A machine-local event: a step of some local process.
#[derive(Debug, Clone)]
pub struct LocalEv {
    /// Which local process.
    pub proc: usize,
    /// Process-defined tag.
    pub tag: u64,
}

/// What the hook decided for one call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookAction {
    /// Run the call.
    Proceed,
    /// Crash the caller before the call.
    Crash,
}

/// Runs before every call a hooked process makes. It gets the machine (not
/// borrowed) and may run other local processes or advance machine time.
pub trait Hook {
    /// Called before `op` on `path` by `proc`.
    fn before(&mut self, m: &MachineRef, proc: &str, op: &str, path: &str) -> HookAction;
}

/// A shared machine.
pub type MachineRef = Rc<RefCell<Machine>>;

/// One simulated computer.
pub struct Machine {
    /// Index in the world.
    pub id: usize,
    /// Name for traces.
    pub name: String,
    /// OS model.
    pub os: Os,
    /// The disk.
    pub disk: Disk,
    /// Open handles.
    pub handles: BTreeMap<u64, Handle>,
    next_fd: u64,
    /// The world clock.
    pub world: SimTime,
    /// Machine-local time when it runs ahead of the world (a stalled process).
    pub ahead_ms: u64,
    /// Local process steps.
    pub queue: Queue<LocalEv>,
    /// The hook, if any.
    pub hook: Option<Rc<RefCell<dyn Hook>>>,
    /// Hook recursion guard: a hook running local processes doesn't re-enter.
    pub in_hook: bool,
    /// Trace lines produced by local activity (drained by the world).
    pub trace: Vec<String>,
    /// Transactional stores on this machine (the `IndexStorage` model), by name.
    pub kv: BTreeMap<String, Kv>,
    /// Machine-level randomness (kernel timing choices).
    pub rng: SimRng,
    /// Record every syscall as a detail trace line.
    pub verbose: bool,
    /// Detail lines (drained by the world, never digested).
    pub detail: Vec<String>,
}

impl fmt::Debug for Machine {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Machine")
            .field("name", &self.name)
            .field("os", &self.os)
            .finish()
    }
}

impl Machine {
    /// A machine.
    pub fn new(id: usize, name: &str, os: Os, world: SimTime, rng: SimRng) -> MachineRef {
        let ns = match os {
            Os::Linux => NsDurability::Strict,
            _ => NsDurability::Journaled,
        };
        Rc::new(RefCell::new(Machine {
            id,
            name: name.into(),
            os,
            disk: Disk::new(ns),
            handles: BTreeMap::new(),
            next_fd: 1,
            world,
            ahead_ms: 0,
            queue: Queue::default(),
            hook: None,
            in_hook: false,
            trace: Vec::new(),
            kv: BTreeMap::new(),
            rng,
            verbose: false,
            detail: Vec::new(),
        }))
    }

    /// The machine's current time: the world's, or later while a process stalls.
    pub fn now(&self) -> u64 {
        self.world.now().max(self.ahead_ms)
    }

    /// Sync the disk's notion of time; now and then free unreachable inodes.
    pub fn tick(&mut self) {
        self.disk.now_ms = self.now();
        if self.disk.inodes.len() > 256 + 2 * self.disk.names.len() {
            let open = self.handles.values().map(|h| h.ino).collect();
            self.disk.gc(&open);
        }
    }

    /// Close every handle of `proc` (process exit or crash).
    pub fn close_all(&mut self, proc: &str) {
        self.handles.retain(|_, h| h.proc != proc);
    }

    fn share_ok(&self, ino: Ino, access: Access, share: Share, me: Option<&str>) -> bool {
        if self.os != Os::Windows {
            return true;
        }
        for h in self.handles.values().filter(|h| h.ino == ino) {
            let _ = me;
            // New access must be within the existing handle's share mask, and the new
            // share mask must cover the existing handle's access.
            if (access.read && !h.share.read)
                || (access.write && !h.share.write)
                || (access.delete && !h.share.delete)
                || (h.access.read && !share.read)
                || (h.access.write && !share.write)
                || (h.access.delete && !share.delete)
            {
                return false;
            }
        }
        true
    }

    fn any_handle(&self, ino: Ino) -> bool {
        self.handles.values().any(|h| h.ino == ino)
    }

    /// Record a trace line stamped with machine time.
    pub fn log(&mut self, line: String) {
        let t = self.now();
        self.trace.push(format!(
            "t={} {} {}",
            t - crate::sched::EPOCH_MS,
            self.name,
            line
        ));
    }
}

/// A file descriptor.
pub type Fd = u64;

/// One process's handle on a machine's file system.
#[derive(Clone)]
pub struct Proc {
    /// The machine.
    pub m: MachineRef,
    /// Process name (unique on the machine).
    pub name: String,
    /// Crashed: every call fails.
    pub crashed: Rc<Cell<bool>>,
    /// Calls run the machine hook.
    pub hooked: bool,
}

impl fmt::Debug for Proc {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Proc({})", self.name)
    }
}

impl Proc {
    /// A process on `m`.
    pub fn new(m: &MachineRef, name: &str, hooked: bool) -> Self {
        Proc {
            m: m.clone(),
            name: name.into(),
            crashed: Rc::new(Cell::new(false)),
            hooked,
        }
    }

    /// The OS.
    pub fn os(&self) -> Os {
        self.m.borrow().os
    }

    /// Machine time.
    pub fn now(&self) -> u64 {
        self.m.borrow().now()
    }

    pub(crate) fn hook_point(&self, op: &str, path: &str) -> FsResult<()> {
        if self.crashed.get() {
            return Err(FsError::Crashed);
        }
        if self.hooked {
            let hook = {
                let m = self.m.borrow();
                if m.in_hook { None } else { m.hook.clone() }
            };
            if let Some(h) = hook {
                self.m.borrow_mut().in_hook = true;
                let a = h.borrow_mut().before(&self.m, &self.name, op, path);
                self.m.borrow_mut().in_hook = false;
                if a == HookAction::Crash {
                    self.crash();
                    return Err(FsError::Crashed);
                }
            }
        }
        if self.crashed.get() {
            return Err(FsError::Crashed);
        }
        let mut m = self.m.borrow_mut();
        m.tick();
        if m.verbose {
            let t = m.now() - crate::sched::EPOCH_MS;
            let ino = m
                .disk
                .ino(path)
                .map_or(String::new(), |i| format!(" ino={i}"));
            let l = format!("t={t} {}/{} {op} {path}{ino}", m.name, self.name);
            m.detail.push(l);
        }
        Ok(())
    }

    /// Mark this process crashed and close its handles.
    pub fn crash(&self) {
        self.crashed.set(true);
        let mut m = self.m.borrow_mut();
        m.close_all(&self.name);
        m.log(format!("{} CRASH", self.name));
    }

    /// `stat`.
    pub fn stat(&self, path: &str) -> FsResult<Meta> {
        self.hook_point("stat", path)?;
        let m = self.m.borrow();
        if let Some(i) = m.disk.ino(path) {
            let n = &m.disk.inodes[&i];
            return Ok(Meta {
                size: n.data.len() as u64,
                mtime_ns: n.mtime_ns,
                ino: i,
                is_dir: false,
            });
        }
        if m.disk.is_dir(path) {
            return Ok(Meta {
                size: 0,
                mtime_ns: 0,
                ino: 0,
                is_dir: true,
            });
        }
        Err(FsError::NotFound)
    }

    /// Read a whole file (opens with share RWD and closes).
    pub fn read(&self, path: &str) -> FsResult<Vec<u8>> {
        self.hook_point("read", path)?;
        let m = self.m.borrow();
        let i = m.disk.ino(path).ok_or(FsError::NotFound)?;
        if !m.share_ok(i, Access::R, SHARE_ALL, Some(&self.name)) {
            return Err(FsError::SharingViolation);
        }
        Ok(m.disk.inodes[&i].data.clone())
    }

    /// Read with a specific share mask (Windows readers differ in share modes).
    pub fn read_shared(&self, path: &str, share: Share) -> FsResult<Vec<u8>> {
        self.hook_point("read", path)?;
        let m = self.m.borrow();
        let i = m.disk.ino(path).ok_or(FsError::NotFound)?;
        if !m.share_ok(i, Access::R, share, Some(&self.name)) {
            return Err(FsError::SharingViolation);
        }
        Ok(m.disk.inodes[&i].data.clone())
    }

    /// List a directory.
    pub fn list(&self, dir: &str) -> FsResult<Vec<(String, bool)>> {
        self.hook_point("list", dir)?;
        let m = self.m.borrow();
        if !m.disk.is_dir(dir) {
            return Err(FsError::NotFound);
        }
        Ok(m.disk.list(dir))
    }

    /// Create directories.
    pub fn mkdir_all(&self, dir: &str) -> FsResult<()> {
        self.hook_point("mkdir", dir)?;
        self.m.borrow_mut().disk.mkdir(dir);
        Ok(())
    }

    /// Open a file.
    pub fn open(
        &self,
        path: &str,
        disp: Disposition,
        access: Access,
        share: Share,
    ) -> FsResult<Fd> {
        self.hook_point("open", path)?;
        let mut m = self.m.borrow_mut();
        let existing = m.disk.ino(path);
        let ino = match (existing, disp) {
            (Some(_), Disposition::CreateNew) => return Err(FsError::Exists),
            (None, Disposition::Existing | Disposition::TruncateExisting) => {
                return Err(FsError::NotFound);
            }
            (Some(i), _) => {
                if !m.share_ok(i, access, share, Some(&self.name)) {
                    return Err(FsError::SharingViolation);
                }
                if matches!(disp, Disposition::Truncate | Disposition::TruncateExisting) {
                    let me = self.name.clone();
                    m.disk.set_len(i, 0, &me);
                }
                i
            }
            (None, _) => {
                let i = m.disk.new_inode(Vec::new(), false);
                let me = self.name.clone();
                m.disk.link(path, i, &me);
                i
            }
        };
        let fd = m.next_fd;
        m.next_fd += 1;
        m.handles.insert(
            fd,
            Handle {
                ino,
                proc: self.name.clone(),
                access,
                share,
            },
        );
        Ok(fd)
    }

    fn fd_ino(&self, fd: Fd) -> FsResult<Ino> {
        let m = self.m.borrow();
        m.handles
            .get(&fd)
            .filter(|h| h.proc == self.name)
            .map(|h| h.ino)
            .ok_or(FsError::BadFd)
    }

    /// Write at an offset through a handle.
    pub fn write_at(&self, fd: Fd, offset: u64, bytes: &[u8]) -> FsResult<()> {
        self.hook_point("write", "")?;
        let ino = self.fd_ino(fd)?;
        let me = self.name.clone();
        self.m
            .borrow_mut()
            .disk
            .write_at(ino, offset as usize, bytes, &me);
        Ok(())
    }

    /// Set the length through a handle (`ftruncate` / `SetEndOfFile`).
    pub fn set_len(&self, fd: Fd, len: u64) -> FsResult<()> {
        self.hook_point("truncate", "")?;
        let ino = self.fd_ino(fd)?;
        let me = self.name.clone();
        self.m.borrow_mut().disk.set_len(ino, len as usize, &me);
        Ok(())
    }

    /// Read everything through a handle.
    pub fn read_fd(&self, fd: Fd) -> FsResult<Vec<u8>> {
        self.hook_point("read", "")?;
        let ino = self.fd_ino(fd)?;
        Ok(self.m.borrow().disk.inodes[&ino].data.clone())
    }

    /// `fsync` / `FlushFileBuffers`.
    pub fn fsync(&self, fd: Fd) -> FsResult<()> {
        self.hook_point("fsync", "")?;
        let ino = self.fd_ino(fd)?;
        self.m.borrow_mut().disk.sync_inode(ino);
        Ok(())
    }

    /// The inode behind a handle.
    pub fn fd_inode(&self, fd: Fd) -> FsResult<Ino> {
        self.fd_ino(fd)
    }

    /// Rename the file behind our handle to `to`, without replacing
    /// (`SetFileInformationByHandle(FileRenameInfo)`, protocol D's move-aside).
    /// The handle must have DELETE access; other handles' share modes were
    /// checked when it was opened.
    pub fn rename_by_handle(&self, fd: Fd, to: &str) -> FsResult<()> {
        self.hook_point("rename_by_handle", to)?;
        let ino = self.fd_ino(fd)?;
        let mut m = self.m.borrow_mut();
        if m.disk.ino(to).is_some() {
            return Err(FsError::Exists);
        }
        let from = m
            .disk
            .names
            .iter()
            .find(|(_, i)| **i == ino)
            .map(|(p, _)| p.clone())
            .ok_or(FsError::NotFound)?;
        let me = self.name.clone();
        m.disk.rename(&from, to, &me);
        Ok(())
    }

    /// Linux `fcntl(F_SETLEASE, F_WRLCK)` probe: true iff no other process has
    /// the inode at `path` open (any access). A write lease is refused while any
    /// other open file description exists, so this is the one POSIX-adjacent way
    /// to learn that no editor still holds an fd on a parked inode.
    pub fn lease_free(&self, path: &str) -> FsResult<bool> {
        self.hook_point("setlease", path)?;
        let m = self.m.borrow();
        let i = m.disk.ino(path).ok_or(FsError::NotFound)?;
        Ok(!m
            .handles
            .values()
            .any(|h| h.ino == i && h.proc != self.name))
    }

    /// Close a handle.
    pub fn close(&self, fd: Fd) -> FsResult<()> {
        // Closing never fails and never runs the hook: a crash already closed it.
        if self.crashed.get() {
            return Err(FsError::Crashed);
        }
        self.m.borrow_mut().handles.remove(&fd);
        Ok(())
    }

    /// Create a new file with `bytes` (O_EXCL), optionally fsynced.
    pub fn create_new(&self, path: &str, bytes: &[u8], sync: bool) -> FsResult<()> {
        self.hook_point("create", path)?;
        let mut m = self.m.borrow_mut();
        if m.disk.ino(path).is_some() {
            return Err(FsError::Exists);
        }
        let i = m.disk.new_inode(bytes.to_vec(), sync);
        let me = self.name.clone();
        m.disk.link(path, i, &me);
        Ok(())
    }

    fn check_delete(&self, m: &Machine, path: &str) -> FsResult<Ino> {
        let i = m.disk.ino(path).ok_or(FsError::NotFound)?;
        if !m.share_ok(i, Access::RD, SHARE_ALL, Some(&self.name)) {
            return Err(FsError::SharingViolation);
        }
        Ok(i)
    }

    /// Rename. `replace: false` is `RENAME_NOREPLACE` / `RENAME_EXCL` / no-replace
    /// `MoveFileEx`. Windows `replace: true` is classic `MoveFileExW(REPLACE_EXISTING)`:
    /// ACCESS_DENIED if any handle is open on the target.
    pub fn rename(&self, from: &str, to: &str, replace: bool) -> FsResult<()> {
        self.hook_point("rename", to)?;
        let mut m = self.m.borrow_mut();
        let _src = self.check_delete(&m, from)?;
        if let Some(t) = m.disk.ino(to) {
            if !replace {
                return Err(FsError::Exists);
            }
            if m.os == Os::Windows && m.any_handle(t) {
                return Err(FsError::AccessDenied);
            }
        }
        let me = self.name.clone();
        m.disk.rename(from, to, &me);
        Ok(())
    }

    /// POSIX-semantics replace on Windows (`FILE_RENAME_POSIX_SEMANTICS`): succeeds
    /// over open handles whose share includes DELETE.
    pub fn rename_posix(&self, from: &str, to: &str) -> FsResult<()> {
        self.hook_point("rename", to)?;
        let mut m = self.m.borrow_mut();
        self.check_delete(&m, from)?;
        if m.disk.ino(to).is_some() {
            self.check_delete(&m, to)?;
        }
        let me = self.name.clone();
        m.disk.rename(from, to, &me);
        Ok(())
    }

    /// Atomically exchange two names: Linux `RENAME_EXCHANGE`, macOS `RENAME_SWAP`.
    pub fn exchange(&self, a: &str, b: &str) -> FsResult<()> {
        let os = self.os();
        match os {
            Os::Windows => Err(FsError::Unsupported),
            Os::Linux => {
                self.hook_point("exchange", b)?;
                let mut m = self.m.borrow_mut();
                let me = self.name.clone();
                if m.disk.exchange(a, b, &me) {
                    Ok(())
                } else {
                    Err(FsError::NotFound)
                }
            }
            Os::MacOs(mac) => {
                self.hook_point("exchange", b)?;
                if mac.fat32 {
                    // The swap "succeeds" as a plain rename: b is clobbered, a vanishes.
                    let mut m = self.m.borrow_mut();
                    if m.disk.ino(a).is_none() || m.disk.ino(b).is_none() {
                        return Err(FsError::NotFound);
                    }
                    let me = self.name.clone();
                    m.disk.rename(a, b, &me);
                    return Ok(());
                }
                let (ia, ib) = {
                    let m = self.m.borrow();
                    match (m.disk.ino(a), m.disk.ino(b)) {
                        (Some(x), Some(y)) => (x, y),
                        _ => return Err(FsError::NotFound),
                    }
                };
                let window = self.m.borrow_mut().rng.chance(mac.p_swap_window);
                let me = self.name.clone();
                if window {
                    // Path b briefly missing: unlink, let others observe, relink swapped.
                    {
                        let mut m = self.m.borrow_mut();
                        m.disk.unlink(b, &me);
                        m.log(format!("swap-window {b}"));
                    }
                    let hook = self.m.borrow().hook.clone();
                    if let Some(h) = hook
                        && !self.m.borrow().in_hook
                    {
                        self.m.borrow_mut().in_hook = true;
                        let _ = h.borrow_mut().before(&self.m, "kernel", "swap-window", b);
                        self.m.borrow_mut().in_hook = false;
                    }
                    let mut m = self.m.borrow_mut();
                    // Whatever is at `a` and `b` now; anything created at b during
                    // the window is displaced to `a`, as the kernel's swap would.
                    let now_b = m.disk.ino(b);
                    m.disk.link(b, ia, &me);
                    match now_b {
                        Some(x) => m.disk.link(a, x, &me),
                        None => m.disk.link(a, ib, &me),
                    }
                    return Ok(());
                }
                let mut m = self.m.borrow_mut();
                m.disk.exchange(a, b, &me);
                Ok(())
            }
        }
    }

    /// Unlink. Windows: needs DELETE access compatible with open handles (POSIX
    /// delete: the name disappears immediately).
    pub fn unlink(&self, path: &str) -> FsResult<()> {
        self.hook_point("unlink", path)?;
        let mut m = self.m.borrow_mut();
        self.check_delete(&m, path)?;
        let me = self.name.clone();
        m.disk.unlink(path, &me);
        Ok(())
    }

    /// fsync a directory.
    pub fn fsync_dir(&self, dir: &str) -> FsResult<()> {
        self.hook_point("fsync_dir", dir)?;
        self.m.borrow_mut().disk.sync_dir(dir);
        Ok(())
    }

    /// syncfs.
    pub fn syncfs(&self) -> FsResult<()> {
        self.hook_point("syncfs", "")?;
        self.m.borrow_mut().disk.sync_all();
        Ok(())
    }

    /// Convenience: write a whole new file through a temp + fsync + no-replace
    /// rename + fsync of the directory. Used by test actors and the journal.
    pub fn write_atomic_new(&self, tmp: &str, path: &str, bytes: &[u8]) -> FsResult<()> {
        self.create_new(tmp, bytes, true)?;
        self.rename(tmp, path, false)?;
        self.fsync_dir(parent(path))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn machine(os: Os) -> MachineRef {
        Machine::new(0, "m0", os, SimTime::default(), SimRng::new(1))
    }

    #[test]
    fn windows_share_modes() {
        let m = machine(Os::Windows);
        let p = Proc::new(&m, "replica", false);
        let e = Proc::new(&m, "editor", false);
        p.create_new("a.md", b"x", true).unwrap();
        // Protocol D lock: RW, share R.
        let l = p
            .open("a.md", Disposition::Existing, Access::RW, Access::R)
            .unwrap();
        assert_eq!(
            e.open("a.md", Disposition::Truncate, Access::W, SHARE_ALL),
            Err(FsError::SharingViolation)
        );
        assert!(e.read("a.md").is_ok()); // libuv reader, share RWD
        assert_eq!(
            e.read_shared("a.md", Access::R),
            Err(FsError::SharingViolation)
        ); // .NET reader, share R
        assert_eq!(e.unlink("a.md"), Err(FsError::SharingViolation));
        p.close(l).unwrap();
        // Classic replace fails while any handle is open.
        let h = e
            .open("a.md", Disposition::Existing, Access::NONE, SHARE_ALL)
            .unwrap();
        p.create_new("t", b"y", true).unwrap();
        assert_eq!(p.rename("t", "a.md", true), Err(FsError::AccessDenied));
        e.close(h).unwrap();
        assert!(p.rename("t", "a.md", true).is_ok());
    }

    #[test]
    fn writes_follow_the_inode() {
        let m = machine(Os::Linux);
        let p = Proc::new(&m, "replica", false);
        let e = Proc::new(&m, "editor", false);
        p.create_new("a.md", b"old", true).unwrap();
        let fd = e
            .open("a.md", Disposition::Truncate, Access::W, SHARE_ALL)
            .unwrap();
        p.create_new("t", b"ours", true).unwrap();
        p.exchange("t", "a.md").unwrap();
        e.write_at(fd, 0, b"user").unwrap();
        // The user's write landed in the displaced inode, now at "t".
        assert_eq!(p.read("t").unwrap(), b"user");
        assert_eq!(p.read("a.md").unwrap(), b"ours");
    }

    #[test]
    fn fat32_swap_clobbers() {
        let m = machine(Os::MacOs(MacOs {
            p_swap_window: 0,
            fat32: true,
            p_hidden_holder: 0,
        }));
        let p = Proc::new(&m, "replica", false);
        p.create_new("a.md", b"user", true).unwrap();
        p.create_new("t", b"ours", true).unwrap();
        p.exchange("t", "a.md").unwrap();
        assert_eq!(p.read("t"), Err(FsError::NotFound));
    }

    #[test]
    fn crashed_process_changes_nothing() {
        let m = machine(Os::Linux);
        let p = Proc::new(&m, "replica", false);
        p.crash();
        assert_eq!(p.create_new("a", b"x", true), Err(FsError::Crashed));
        assert!(m.borrow().disk.names.is_empty());
    }
}
