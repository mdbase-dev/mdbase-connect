//! External editors, modelled syscall by syscall.
//!
//! [`StressEditor`] is the stress editor emulator: one file, a buffer that only
//! grows (one unique line per save), whole-buffer saves, never reloads. Each save
//! is a sequence of syscalls ([`SaveMode`]), one per local step, with a small gap
//! between steps and occasionally a long stall (an overloaded host descheduling
//! the editor between `open(O_TRUNC)` and `write`). A step can also run early,
//! between two of the replica's syscalls, through the machine hook.
//!
//! Oracle (including saves after stalls): before each save, and at the end, the
//! editor's last successful save must still exist byte-exact as a prefix of some
//! file on the machine (the path, a stash, a preserved copy, a temp). Bytes that
//! are nowhere cannot come back, so a miss is a real loss.

use std::any::Any;

use crate::disk::{basename, parent};
use crate::oracle::Kind;
use crate::platform::{Access, Disposition, Fd, FsError, Os, Proc, SHARE_ALL, Share};
use crate::rng::Ppm;
use crate::world::{LocalCx, LocalProc};

/// How an editor writes a save.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SaveMode {
    /// libuv `fs.writeFile`: `O_CREAT|O_TRUNC` (Windows CREATE_ALWAYS, share RWD)
    /// + write. Obsidian on every platform.
    LibuvTrunc,
    /// `O_TRUNC` without create (TRUNCATE_EXISTING, share R) + write.
    Trunc,
    /// open or create without truncating (share RW), write at 0, then set length.
    SetEof,
    /// Notepad 11: OPEN_IF share R, write at 0, SetEndOfFile, no flush.
    Notepad,
    /// VS Code: OPEN_EXISTING RW share RWD, truncate to 0, write, flush.
    VsCode,
    /// Notepad++: OPEN_EXISTING RW share RW, truncate to 0, write, flush.
    Npp,
    /// Temp in the same directory, then rename over (classic replace).
    Rename,
    /// gVim/vim backup-rename: path → path~ (no replace), create path, write,
    /// delete path~. The path is missing for a moment.
    VimBackup,
    /// git checkout: unlink, then create and write.
    DeleteCreate,
}

impl SaveMode {
    /// Every mode.
    pub const ALL: [SaveMode; 9] = [
        SaveMode::LibuvTrunc,
        SaveMode::Trunc,
        SaveMode::SetEof,
        SaveMode::Notepad,
        SaveMode::VsCode,
        SaveMode::Npp,
        SaveMode::Rename,
        SaveMode::VimBackup,
        SaveMode::DeleteCreate,
    ];

    /// Name used in scenario names.
    pub fn name(self) -> &'static str {
        match self {
            SaveMode::LibuvTrunc => "libuv_trunc",
            SaveMode::Trunc => "trunc",
            SaveMode::SetEof => "seteof",
            SaveMode::Notepad => "notepad",
            SaveMode::VsCode => "vscode",
            SaveMode::Npp => "npp",
            SaveMode::Rename => "rename",
            SaveMode::VimBackup => "vim_backup",
            SaveMode::DeleteCreate => "delete_create",
        }
    }

    /// Parse a name.
    pub fn parse(s: &str) -> Option<SaveMode> {
        SaveMode::ALL.into_iter().find(|m| m.name() == s)
    }

    fn ops(self) -> Vec<Op> {
        use Op::*;
        match self {
            SaveMode::LibuvTrunc => vec![
                Open(Disposition::Truncate, Access::W, SHARE_ALL),
                Write,
                Close,
            ],
            SaveMode::Trunc => vec![
                Open(Disposition::TruncateExisting, Access::W, Access::R),
                Write,
                Close,
            ],
            SaveMode::SetEof => vec![
                Open(Disposition::OpenOrCreate, Access::RW, Access::RW),
                Write,
                SetLen,
                Close,
            ],
            SaveMode::Notepad => vec![
                Open(Disposition::OpenOrCreate, Access::RW, Access::R),
                Write,
                SetLen,
                Close,
            ],
            SaveMode::VsCode => vec![
                Open(Disposition::Existing, Access::RW, SHARE_ALL),
                Truncate0,
                Write,
                Flush,
                Close,
            ],
            SaveMode::Npp => vec![
                Open(Disposition::Existing, Access::RW, Access::RW),
                Truncate0,
                Write,
                Flush,
                Close,
            ],
            SaveMode::Rename => vec![WriteTemp, RenameTempOver],
            SaveMode::VimBackup => vec![
                UnlinkBackup,
                BackupRename,
                Open(Disposition::Truncate, Access::W, Access::RW),
                Write,
                Close,
                UnlinkBackup,
            ],
            SaveMode::DeleteCreate => vec![
                UnlinkPath,
                Open(Disposition::Truncate, Access::W, Access::R),
                Write,
                Close,
            ],
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Op {
    Open(Disposition, Access, Share),
    Write,
    SetLen,
    Truncate0,
    Flush,
    Close,
    WriteTemp,
    RenameTempOver,
    BackupRename,
    UnlinkBackup,
    UnlinkPath,
}

impl Op {
    /// After this op succeeds, a failure of the save has destroyed the old content
    /// (self-inflicted, not charged to the publisher).
    fn destructive(self) -> bool {
        matches!(
            self,
            Op::Open(Disposition::Truncate | Disposition::TruncateExisting, _, _)
                | Op::Truncate0
                | Op::Write
                | Op::BackupRename
                | Op::UnlinkPath
        )
    }
}

/// Timing of an editor's syscalls.
#[derive(Debug, Clone, Copy)]
pub struct EditorTiming {
    /// Gap between syscalls within a save, ms (uniform).
    pub gap_ms: (u64, u64),
    /// Pause between saves, ms (uniform).
    pub pause_ms: (u64, u64),
    /// Chance a gap is a long stall instead (the editor descheduled).
    pub p_stall: Ppm,
    /// Longest stall, ms (log-uniform).
    pub stall_max_ms: u64,
}

impl Default for EditorTiming {
    fn default() -> Self {
        EditorTiming {
            gap_ms: (0, 1),
            pause_ms: (0, 2),
            p_stall: 10_000,
            stall_max_ms: 200,
        }
    }
}

/// Stress editor on one file.
pub struct StressEditor {
    /// Name (unique on the machine).
    pub name: String,
    /// Editor index (goes into every line).
    pub idx: usize,
    /// The file.
    pub path: String,
    /// Save mode.
    pub mode: SaveMode,
    /// Timing.
    pub timing: EditorTiming,
    proc: Option<Proc>,
    generation: u64,
    n: u64,
    buf: Vec<u8>,
    /// The bytes of the last successful save.
    pub last_good: Option<Vec<u8>>,
    ops: Vec<Op>,
    at: usize,
    fd: Option<Fd>,
    temp_seq: u64,
    stopped: bool,
    /// Counters.
    pub saves_ok: u64,
    /// Counters.
    pub saves_failed: u64,
    /// Counters.
    pub self_destroyed: u64,
    /// Counters.
    pub losses: u64,
}

const GEN_LINES: u64 = 200;
const TAG_STEP: u64 = 1;

impl StressEditor {
    /// An editor for `path`.
    pub fn new(name: &str, idx: usize, path: &str, mode: SaveMode, timing: EditorTiming) -> Self {
        StressEditor {
            name: name.into(),
            idx,
            path: path.into(),
            mode,
            timing,
            proc: None,
            generation: 0,
            n: 0,
            buf: Vec::new(),
            last_good: None,
            ops: Vec::new(),
            at: 0,
            fd: None,
            temp_seq: 0,
            stopped: false,
            saves_ok: 0,
            saves_failed: 0,
            self_destroyed: 0,
            losses: 0,
        }
    }

    fn header(&self) -> Vec<u8> {
        format!("# e{} g{}\n", self.idx, self.generation).into_bytes()
    }

    fn backup(&self) -> String {
        format!("{}~", self.path)
    }

    fn temp(&self) -> String {
        let dir = parent(&self.path);
        let leaf = basename(&self.path);
        let t = format!(".{leaf}.e{}.tmp", self.temp_seq);
        if dir.is_empty() {
            t
        } else {
            format!("{dir}/{t}")
        }
    }

    /// Is `want` a prefix of some file on the machine? Returns where.
    pub fn find(p: &Proc, want: &[u8]) -> Option<String> {
        let m = p.m.borrow();
        m.disk
            .names
            .iter()
            .find(|(_, i)| m.disk.inodes[*i].data.starts_with(want))
            .map(|(n, _)| n.clone())
    }

    /// Describe what's at the path (for loss forensics).
    pub fn path_state(&self, p: &Proc) -> String {
        let m = p.m.borrow();
        match m.disk.read(&self.path) {
            None => "missing".into(),
            Some(b) => {
                let text = String::from_utf8_lossy(b);
                let last = text
                    .lines()
                    .rfind(|l| l.starts_with('e'))
                    .unwrap_or("-")
                    .to_string();
                let pubs = text.lines().filter(|l| l.starts_with('p')).count();
                format!(
                    "len={} last_editor_line={last} publisher_lines={pubs}",
                    b.len()
                )
            }
        }
    }

    /// Check the last good save is somewhere; record a loss if not.
    pub fn check(&mut self, cx: &mut LocalCx, when: &str) {
        let (Some(want), Some(p)) = (self.last_good.clone(), self.proc.clone()) else {
            return;
        };
        if Self::find(&p, &want).is_none() {
            self.losses += 1;
            let last = String::from_utf8_lossy(&want)
                .lines()
                .last()
                .unwrap_or("")
                .to_string();
            let detail = format!(
                "{} ({}) {when}: save ending {last:?} ({} bytes) is nowhere; path {}",
                self.name,
                self.mode.name(),
                want.len(),
                self.path_state(&p)
            );
            cx.log(&self.name, &format!("LOSS {detail}"));
            cx.shared.violate(Kind::LostEdit, detail);
            self.last_good = None;
        }
    }

    fn begin_save(&mut self, cx: &mut LocalCx) {
        self.check(cx, "before next save");
        if self.n == GEN_LINES || self.buf.is_empty() {
            if self.n == GEN_LINES {
                self.generation += 1;
            }
            self.n = 0;
            self.buf = self.header();
        }
        self.buf.extend_from_slice(
            format!("e{}g{}n{}\n", self.idx, self.generation, self.n).as_bytes(),
        );
        self.n += 1;
        self.ops = self.mode.ops();
        self.at = 0;
        self.temp_seq += 1;
    }

    fn fail(&mut self, cx: &mut LocalCx, op: Op, e: FsError) {
        self.saves_failed += 1;
        let destroyed = self.ops[..self.at].iter().any(|o| o.destructive());
        if destroyed {
            self.self_destroyed += 1;
            self.last_good = None;
        }
        if let (Some(fd), Some(p)) = (self.fd.take(), &self.proc) {
            let _ = p.close(fd);
        }
        if matches!(op, Op::RenameTempOver)
            && let Some(p) = &self.proc
        {
            let _ = p.unlink(&self.temp());
        }
        cx.log(
            &self.name,
            &format!("save failed at {op:?}: {e} destroyed={destroyed}"),
        );
        self.ops.clear();
    }

    fn do_op(&mut self, cx: &mut LocalCx) {
        let Some(p) = self.proc.clone() else { return };
        let Some(&op) = self.ops.get(self.at) else {
            return;
        };
        let r: Result<(), FsError> = match op {
            Op::Open(d, a, s) => p.open(&self.path, d, a, s).map(|fd| {
                self.fd = Some(fd);
            }),
            Op::Write => match self.fd {
                Some(fd) => p.write_at(fd, 0, &self.buf),
                None => Err(FsError::BadFd),
            },
            Op::SetLen => match self.fd {
                Some(fd) => p.set_len(fd, self.buf.len() as u64),
                None => Err(FsError::BadFd),
            },
            Op::Truncate0 => match self.fd {
                Some(fd) => p.set_len(fd, 0),
                None => Err(FsError::BadFd),
            },
            Op::Flush => match self.fd {
                Some(fd) => p.fsync(fd),
                None => Err(FsError::BadFd),
            },
            Op::Close => {
                if let Some(fd) = self.fd.take() {
                    let _ = p.close(fd);
                }
                Ok(())
            }
            Op::WriteTemp => p.create_new(&self.temp(), &self.buf, false),
            Op::RenameTempOver => p.rename(&self.temp(), &self.path, true),
            Op::BackupRename => match p.rename(&self.path, &self.backup(), false) {
                Err(FsError::NotFound) => Ok(()),
                r => r,
            },
            Op::UnlinkBackup => match p.unlink(&self.backup()) {
                Err(FsError::NotFound) => Ok(()),
                r => r,
            },
            Op::UnlinkPath => match p.unlink(&self.path) {
                Err(FsError::NotFound) => Ok(()),
                r => r,
            },
        };
        match r {
            Ok(()) => {
                self.at += 1;
                if self.at == self.ops.len() {
                    cx.detail(
                        &self.name,
                        &format!("saved n{} len={}", self.n - 1, self.buf.len()),
                    );
                    self.saves_ok += 1;
                    self.last_good = Some(self.buf.clone());
                    self.ops.clear();
                }
            }
            Err(e) => self.fail(cx, op, e),
        }
    }

    fn schedule(&mut self, cx: &mut LocalCx) {
        if self.stopped && self.ops.is_empty() {
            return;
        }
        let t = self.timing;
        let d = if cx.rng.chance(t.p_stall) {
            cx.rng.log_uniform(t.stall_max_ms)
        } else if self.ops.is_empty() {
            cx.rng.between(t.pause_ms.0, t.pause_ms.1)
        } else {
            cx.rng.between(t.gap_ms.0, t.gap_ms.1)
        };
        cx.at(d, TAG_STEP);
    }

    fn advance(&mut self, cx: &mut LocalCx) {
        if self.ops.is_empty() {
            if self.stopped {
                return;
            }
            self.begin_save(cx);
        } else {
            self.do_op(cx);
        }
    }
}

impl LocalProc for StressEditor {
    fn name(&self) -> &str {
        &self.name
    }
    fn start(&mut self, cx: &mut LocalCx) {
        self.proc = Some(Proc::new(cx.m, &self.name, false));
        self.schedule(cx);
    }
    fn step(&mut self, cx: &mut LocalCx, _tag: u64) {
        self.advance(cx);
        self.schedule(cx);
    }
    fn interleave(&mut self, cx: &mut LocalCx, _op: &str, _path: &str) {
        // Run the next syscall of an in-flight save right now. The normally
        // scheduled step still fires later and simply continues.
        if !self.ops.is_empty() {
            self.do_op(cx);
        }
    }
    fn power_loss(&mut self, _cx: &mut LocalCx) {
        self.ops.clear();
        self.fd = None;
        self.stopped = true;
    }
    fn quiesce(&mut self, cx: &mut LocalCx) {
        // Finish the in-flight save, then stop.
        while !self.ops.is_empty() {
            self.do_op(cx);
        }
        self.stopped = true;
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
}

/// Is `os` able to run `mode` as captured? (All modes run everywhere; Windows
/// share modes only bite on Windows.)
pub fn supported(_os: Os, _mode: SaveMode) -> bool {
    true
}
