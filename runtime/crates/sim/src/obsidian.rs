//! The Obsidian editor model (`TextFileView`, Obsidian 1.12–1.13).
//!
//! One open note. Behaviour modelled:
//! - **Typing** appends lines (each a fresh token) in bursts of keystrokes 80–400 ms
//!   apart, with idle pauses of seconds.
//! - **Save** is `throttle(save, 2000)`. The first unsaved keystroke schedules a save
//!   2 s later; typing continuously saves about every 2 s. The save sets
//!   `dirty = false`, captures the buffer and writes it blind and whole in place
//!   (libuv: `O_TRUNC` then `write`). It never checks the disk.
//! - **External changes** are seen through change detection (polling here). While
//!   `saving`, the event is ignored. When clean, the note silently reloads. When
//!   dirty, the user's unsaved additions are patched onto the new disk content
//!   (diff-match-patch; append-only typing makes this exact).
//! - **Revert on save.** A write that lands while the editor is saving, or after the
//!   buffer was captured, is overwritten by the save. This includes writes via
//!   atomic renames.
//! - **Missing path.** The note closes when the path is still missing 100 ms after a
//!   removal. Later keystrokes are lost.
//! - **The editor fence** (open-editor publication): with the plugin, a publish to the
//!   open note is applied to the buffer as a minimal edit, which Obsidian then saves.
//!   [`ObsidianEditor::fence_apply`] is that path.

use std::any::Any;

use crate::oracle::{Kind, tokens_in};
use crate::platform::{Access, Disposition, Fd, Proc, SHARE_ALL};
use crate::world::{LocalCx, LocalProc};

const TYPE: u64 = 1;
const SAVE: u64 = 2;
const SAVE_WRITE: u64 = 3;
const POLL: u64 = 4;
const RECHECK: u64 = 5;

/// One Obsidian window with one note open.
pub struct ObsidianEditor {
    /// Name.
    pub name: String,
    /// The note.
    pub path: String,
    proc: Option<Proc>,
    /// The editor buffer.
    pub buf: Vec<u8>,
    last_saved: Vec<u8>,
    /// Unsaved changes in the buffer.
    pub dirty: bool,
    saving: bool,
    save_due: bool,
    capture: Vec<u8>,
    fd: Option<Fd>,
    seen: Option<(u64, u64, u64)>,
    missing_since: Option<u64>,
    /// The note is open.
    pub open: bool,
    stopped: bool,
    /// Counters.
    pub saves: u64,
    /// External changes ignored because a save was running.
    pub ignored: u64,
    /// External changes reloaded or merged.
    pub reloads: u64,
    /// Fenced edits applied.
    pub fenced: u64,
}

impl ObsidianEditor {
    /// An editor with `path` open.
    pub fn new(name: &str, path: &str) -> Self {
        ObsidianEditor {
            name: name.into(),
            path: path.into(),
            proc: None,
            buf: Vec::new(),
            last_saved: Vec::new(),
            dirty: false,
            saving: false,
            save_due: false,
            capture: Vec::new(),
            fd: None,
            seen: None,
            missing_since: None,
            open: true,
            stopped: false,
            saves: 0,
            ignored: 0,
            reloads: 0,
            fenced: 0,
        }
    }

    fn sig(p: &Proc, path: &str) -> Option<(u64, u64, u64)> {
        p.stat(path).ok().map(|m| (m.ino, m.mtime_ns, m.size))
    }

    fn request_save(&mut self, cx: &mut LocalCx) {
        if !self.save_due {
            self.save_due = true;
            cx.at(2_000, SAVE);
        }
    }

    /// The editor fence: apply `line` to the buffer as the plugin would through
    /// `editor.transaction`. Obsidian saves it with its next throttled save.
    pub fn fence_apply(&mut self, cx: &mut LocalCx, line: &[u8]) -> bool {
        if !self.open || self.stopped {
            return false;
        }
        self.buf.extend_from_slice(line);
        self.dirty = true;
        self.fenced += 1;
        self.request_save(cx);
        true
    }

    fn on_change(&mut self, cx: &mut LocalCx, p: &Proc) {
        let now = Self::sig(p, &self.path);
        match now {
            None => {
                if self.missing_since.is_none() {
                    self.missing_since = Some(cx.now());
                    cx.at(100, RECHECK);
                }
            }
            Some(sig) => {
                self.missing_since = None;
                if Some(sig) == self.seen {
                    return;
                }
                self.seen = Some(sig);
                if self.saving {
                    // `onModify` ignores events while `view.saving`.
                    self.ignored += 1;
                    return;
                }
                let Ok(disk) = p.read(&self.path) else { return };
                if disk == self.buf {
                    self.last_saved = disk;
                    return;
                }
                self.reloads += 1;
                if self.dirty {
                    // patch_apply(patch_make(lastSaved → buf), disk): with
                    // append-only typing, the user's additions are the buffer's
                    // suffix beyond what was last saved.
                    let extra = if self.buf.starts_with(&self.last_saved) {
                        self.buf[self.last_saved.len()..].to_vec()
                    } else {
                        Vec::new()
                    };
                    let mut merged = disk.clone();
                    merged.extend_from_slice(&extra);
                    self.buf = merged;
                } else {
                    self.buf = disk.clone();
                }
                self.last_saved = disk;
            }
        }
    }
}

impl LocalProc for ObsidianEditor {
    fn name(&self) -> &str {
        &self.name
    }
    fn start(&mut self, cx: &mut LocalCx) {
        let p = Proc::new(cx.m, &self.name, false);
        self.buf = p.read(&self.path).unwrap_or_default();
        self.last_saved = self.buf.clone();
        self.seen = Self::sig(&p, &self.path);
        self.proc = Some(p);
        let d = cx.rng.between(50, 500);
        cx.at(d, TYPE);
        cx.at(2, POLL);
    }
    fn step(&mut self, cx: &mut LocalCx, tag: u64) {
        let Some(p) = self.proc.clone() else { return };
        match tag {
            TYPE => {
                if self.stopped {
                    return;
                }
                let tok = cx.shared.tokens.borrow_mut().fresh(&self.name);
                if self.open {
                    self.buf.extend_from_slice(format!("- {tok}\n").as_bytes());
                    self.dirty = true;
                    self.request_save(cx);
                } else {
                    // Typing into a closed note: the keystrokes go nowhere.
                    cx.shared.violate(
                        Kind::LostEdit,
                        format!(
                            "{}: keystroke {tok} typed into a note Obsidian closed",
                            self.name
                        ),
                    );
                }
                let d = if cx.rng.chance(50_000) {
                    cx.rng.between(2_000, 8_000)
                } else {
                    cx.rng.between(80, 400)
                };
                cx.at(d, TYPE);
            }
            SAVE => {
                self.save_due = false;
                if !self.open || !self.dirty || self.saving {
                    return;
                }
                self.saving = true;
                self.dirty = false;
                self.capture = self.buf.clone();
                match p.open(&self.path, Disposition::Truncate, Access::W, SHARE_ALL) {
                    Ok(fd) => {
                        self.fd = Some(fd);
                        let d = if cx.rng.chance(20_000) {
                            cx.rng.log_uniform(500)
                        } else {
                            cx.rng.between(0, 2)
                        };
                        cx.at(d, SAVE_WRITE);
                    }
                    Err(_) => self.saving = false,
                }
            }
            SAVE_WRITE => {
                if let Some(fd) = self.fd.take() {
                    let _ = p.write_at(fd, 0, &self.capture);
                    let _ = p.close(fd);
                }
                self.saves += 1;
                self.last_saved = self.capture.clone();
                self.seen = Self::sig(&p, &self.path);
                self.saving = false;
                cx.detail(&self.name, &format!("saved {} bytes", self.capture.len()));
                if self.dirty {
                    self.request_save(cx);
                }
            }
            POLL => {
                if self.open {
                    self.on_change(cx, &p);
                }
                if !self.stopped || self.saving || self.dirty {
                    let d = cx.rng.between(2, 6);
                    cx.at(d, POLL);
                }
            }
            RECHECK => {
                if self.open && Self::sig(&p, &self.path).is_none() {
                    self.open = false;
                    cx.log(&self.name, "note closed: path missing for 100 ms");
                    cx.shared.violate(
                        Kind::LostEdit,
                        format!("{}: Obsidian closed the open note {}", self.name, self.path),
                    );
                }
                self.missing_since = None;
            }
            _ => {}
        }
    }
    fn settled(&self) -> bool {
        !(self.open && (self.dirty || self.saving || self.save_due))
    }
    fn power_loss(&mut self, _cx: &mut LocalCx) {
        self.stopped = true;
        self.open = false;
    }
    fn quiesce(&mut self, cx: &mut LocalCx) {
        // Stop typing; let pending saves and polls run out (on_change keeps
        // merging until the buffer is saved).
        self.stopped = true;
        if self.dirty && !self.save_due {
            self.request_save(cx);
        }
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
}

/// Tokens the editor's user typed that are not in `text`.
pub fn missing_tokens(written: &[String], text: &[u8]) -> Vec<String> {
    let present = tokens_in(text);
    written
        .iter()
        .filter(|t| !present.contains(t))
        .cloned()
        .collect()
}
