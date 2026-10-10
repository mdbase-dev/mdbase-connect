//! Reference publish protocols over a simulated [`Proc`].
//!
//! These are what the file workstream implements for real (`mdbn-store-file`);
//! the simulator carries reference strategies so it can
//! exercise save-loss races (including stalls during Linux publication) and
//! check retention and restore rules. When the real store lands,
//! the `race` scenarios run it the same way.
//!
//! | Strategy | Source |
//! |---|---|
//! | `N` | read + compare + rename over (today's engine) |
//! | `X` | Exchange, verify displaced, stash ours after a swap-back |
//! | `P` | reference `publish_if_unchanged` |
//! | `PS` | `P` + amendment 2 (never unlink our own inode on restore; stash it) |
//! | `PSE` | `PS` + amendment 3 (an empty base is suspect: hold, never publish over it) |
//! | `D` | Windows protocol D: lock RW share R, verify, write at 0, set length, flush |
//!
//! Temps, stashes and preserved copies live under `.mdb/` on the same volume.

use crate::platform::{Access, Disposition, FsError, Proc};

/// Publish outcome.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// Our bytes are at the path.
    Published,
    /// The path holds someone else's bytes; nothing of ours is there.
    HeldAtPath,
    /// The path vanished.
    HeldAbsent,
    /// A displaced user version was kept under `.mdb/preserved`.
    HeldPreserved,
    /// Try again later (sharing violation, suspect base).
    Retry(&'static str),
    /// A syscall failed unexpectedly (crash included).
    Error(FsError),
}

impl Outcome {
    /// Counter key.
    pub fn key(&self) -> String {
        match self {
            Outcome::Published => "published".into(),
            Outcome::HeldAtPath => "held_at_path".into(),
            Outcome::HeldAbsent => "held_absent".into(),
            Outcome::HeldPreserved => "held_preserved".into(),
            Outcome::Retry(r) => format!("retry_{r}"),
            Outcome::Error(e) => format!("error_{e}"),
        }
    }
}

/// A protocol.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Strategy {
    /// Naive.
    N,
    /// Exchange with amended restore.
    X,
    /// Prototype.
    P,
    /// Prototype + amendment 2.
    PS,
    /// PS + amendment 3.
    PSE,
    /// Windows protocol D.
    D,
    /// The real `mdbn_store_file::publish` and `stash::settle` (with the
    /// `FileStore`'s rule that an empty file with a known non-empty size is
    /// suspect and never published over), on [`crate::fileplatform::SimFilePlatform`].
    Real,
    /// PSE + a lease-checked settle (Linux `F_SETLEASE`): a parked inode is
    /// released only when no other process has it open.
    PSL,
}

impl Strategy {
    /// Name.
    pub fn name(self) -> &'static str {
        match self {
            Strategy::N => "N",
            Strategy::X => "X",
            Strategy::P => "P",
            Strategy::PS => "PS",
            Strategy::PSE => "PSE",
            Strategy::D => "D",
            Strategy::PSL => "PSL",
            Strategy::Real => "R",
        }
    }
    /// Parse.
    pub fn parse(s: &str) -> Option<Strategy> {
        [
            Strategy::N,
            Strategy::X,
            Strategy::P,
            Strategy::PS,
            Strategy::PSE,
            Strategy::D,
            Strategy::PSL,
            Strategy::Real,
        ]
        .into_iter()
        .find(|x| x.name() == s)
    }
}

/// A displaced or restored inode kept for the retention period.
#[derive(Debug, Clone)]
pub struct Pending {
    /// Where it is parked.
    pub file: String,
    /// Bytes it must still hold to be released.
    pub expect: Vec<u8>,
    /// Parked at (machine ms).
    pub since: u64,
    /// For [`Strategy::Real`]: what the real store retained.
    pub real: Option<mdbn_store_file::publish::Retained>,
}

/// Publisher state.
#[derive(Debug, Default)]
pub struct Env {
    /// Name counter.
    pub seq: u64,
    /// Fsync temps.
    pub sync: bool,
    /// Stash retention (amendment 3: about 2 s).
    pub settle_ms: u64,
    /// Parked inodes.
    pub pending: Vec<Pending>,
    /// Release a parked inode only if no other process has it open (PSL).
    pub lease_check: bool,
    /// Counters.
    pub counters: std::collections::BTreeMap<String, u64>,
}

impl Env {
    fn inc(&mut self, k: &str) {
        *self.counters.entry(k.to_string()).or_default() += 1;
    }
    fn next(&mut self) -> u64 {
        self.seq += 1;
        self.seq
    }

    /// Create the private directories.
    pub fn init(&mut self, p: &Proc) -> Result<(), FsError> {
        for d in [".mdb/tmp", ".mdb/stash", ".mdb/preserved"] {
            p.mkdir_all(d)?;
        }
        Ok(())
    }

    fn preserve(&mut self, p: &Proc, file: &str) -> Result<(), FsError> {
        let dst = format!(".mdb/preserved/v{}", self.next());
        p.rename(file, &dst, false)?;
        self.inc("preserved_files");
        Ok(())
    }

    fn stash(&mut self, p: &Proc, file: &str, expect: &[u8]) -> Result<(), FsError> {
        let dst = format!(".mdb/stash/s{}", self.next());
        p.rename(file, &dst, false)?;
        let since = p.now();
        self.pending.push(Pending {
            file: dst,
            expect: expect.to_vec(),
            since,
            real: None,
        });
        Ok(())
    }

    /// Release parked inodes older than the retention (all of them if `all`),
    /// re-reading each: still the expected bytes → delete; anything else → an
    /// editor wrote into it through an fd → preserve.
    pub fn settle(&mut self, p: &Proc, all: bool) -> Result<(), FsError> {
        let now = p.now();
        let pending = std::mem::take(&mut self.pending);
        let mut keep = Vec::new();
        let mut it = pending.into_iter();
        while let Some(x) = it.next() {
            if !all && now < x.since + self.settle_ms {
                keep.push(x);
                continue;
            }
            if let Some(r) = &x.real {
                use mdbn_store_file::stash::{Settled, settle};
                let fp = crate::fileplatform::SimFilePlatform::new(p.clone());
                match crate::fileplatform::block_on(settle(&fp, r)) {
                    Settled::Released => self.inc("settle_ok"),
                    Settled::Gone => self.inc("settle_missing"),
                    Settled::LateWrite => self.inc("settle_mismatch"),
                    Settled::Busy | Settled::Error => {
                        if p.crashed.get() {
                            keep.push(x);
                            keep.extend(it);
                            self.pending = keep;
                            return Err(FsError::Crashed);
                        }
                        self.inc("settle_busy");
                        keep.push(x);
                    }
                }
                continue;
            }
            if self.lease_check && !all {
                match p.lease_free(&x.file) {
                    Ok(false) => {
                        self.inc("settle_lease_busy");
                        keep.push(x);
                        continue;
                    }
                    Ok(true) | Err(FsError::NotFound) => {}
                    Err(e) => {
                        keep.push(x);
                        keep.extend(it);
                        self.pending = keep;
                        return Err(e);
                    }
                }
            }
            let r = match p.read(&x.file) {
                Ok(b) if b == x.expect => {
                    self.inc("settle_ok");
                    p.unlink(&x.file)
                }
                Ok(_) => {
                    self.inc("settle_mismatch");
                    self.preserve(p, &x.file)
                }
                Err(FsError::NotFound) => {
                    self.inc("settle_missing");
                    Ok(())
                }
                Err(e) => Err(e),
            };
            if let Err(e) = r {
                // Crashed mid-settle: keep the rest (and this one) parked.
                keep.push(x);
                keep.extend(it);
                self.pending = keep;
                return Err(e);
            }
        }
        self.pending = keep;
        Ok(())
    }

    /// Publish `new` at `path` if it still holds `expected`.
    pub fn publish(
        &mut self,
        p: &Proc,
        s: Strategy,
        path: &str,
        expected: &[u8],
        new: &[u8],
    ) -> Outcome {
        let r = match s {
            Strategy::D => protocol_d(p, path, expected, new),
            Strategy::Real => self.real(p, path, expected, new),
            _ => self.via_temp(p, s, path, expected, new),
        };
        match r {
            Ok(o) => o,
            Err(e) => Outcome::Error(e),
        }
    }

    fn via_temp(
        &mut self,
        p: &Proc,
        s: Strategy,
        path: &str,
        expected: &[u8],
        new: &[u8],
    ) -> Result<Outcome, FsError> {
        if matches!(s, Strategy::PSE | Strategy::PSL) && expected.is_empty() {
            // Amendment 3: a zero-length base is suspect (an editor between
            // truncate and write). Never publish over it.
            return Ok(Outcome::Retry("empty_base"));
        }
        let tmp = format!(".mdb/tmp/t{}", self.next());
        p.create_new(&tmp, new, self.sync)?;
        match s {
            Strategy::N => naive(p, path, expected, &tmp),
            Strategy::X => self.exchange_simple(p, path, expected, new, &tmp),
            Strategy::P => self.prototype(p, path, expected, new, &tmp, false),
            Strategy::PS | Strategy::PSE | Strategy::PSL => {
                self.prototype(p, path, expected, new, &tmp, true)
            }
            Strategy::D | Strategy::Real => unreachable!(),
        }
    }

    fn real(
        &mut self,
        p: &Proc,
        path: &str,
        expected: &[u8],
        new: &[u8],
    ) -> Result<Outcome, FsError> {
        use mdbn_store_file::platform::RelPath;
        use mdbn_store_file::publish::{self as rp, Expect, Names, Options, PublishOp};
        if expected.is_empty() {
            // FileStore: an empty read of a non-empty known file is suspect.
            return Ok(Outcome::Retry("empty_base"));
        }
        let fp = crate::fileplatform::SimFilePlatform::new(p.clone());
        let private = RelPath::new(".mdbase").expect("valid");
        for d in Names::dirs(&private) {
            p.mkdir_all(d.as_str())?;
        }
        let names = Names::for_op(&private, self.next());
        let op = PublishOp {
            path: RelPath::new(path).expect("valid"),
            expect: Expect::Rev(rp::revision(expected)),
            new: Some(new.to_vec()),
        };
        let since = p.now();
        let o = crate::fileplatform::block_on(rp::publish(&fp, &op, &names, &Options::default()));
        if p.crashed.get() {
            return Err(FsError::Crashed);
        }
        let mut park = |r: Option<rp::Retained>| {
            if let Some(r) = r {
                self.pending.push(Pending {
                    file: r.path.as_str().to_string(),
                    expect: Vec::new(),
                    since,
                    real: Some(r),
                });
            }
        };
        Ok(match o {
            rp::Outcome::Published { retained } => {
                park(retained);
                Outcome::Published
            }
            rp::Outcome::Drifted {
                retained,
                preserved,
            } => {
                park(retained);
                if preserved.is_some() {
                    Outcome::HeldPreserved
                } else {
                    Outcome::HeldAtPath
                }
            }
            rp::Outcome::Busy => Outcome::Retry("busy"),
            rp::Outcome::Failed(e) => {
                self.inc(&format!("real_failed_{:?}", e.kind));
                Outcome::Retry("failed")
            }
        })
    }

    fn exchange_simple(
        &mut self,
        p: &Proc,
        path: &str,
        expected: &[u8],
        new: &[u8],
        tmp: &str,
    ) -> Result<Outcome, FsError> {
        let our_ino = p.stat(tmp)?.ino;
        match p.exchange(tmp, path) {
            Ok(()) => {}
            Err(FsError::NotFound) => {
                p.unlink(tmp)?;
                return Ok(Outcome::HeldAbsent);
            }
            Err(e) => return Err(e),
        }
        let displaced = p.read(tmp)?;
        if displaced == expected {
            self.stash(p, tmp, expected)?;
            return Ok(Outcome::Published);
        }
        let at_path_ours = p.stat(path).map(|m| m.ino == our_ino).unwrap_or(false)
            && p.read(path).map(|b| b == new).unwrap_or(false);
        if at_path_ours && p.exchange(tmp, path).is_ok() {
            // Amended restore: never unlink our inode here, stash it.
            self.stash(p, tmp, new)?;
            self.inc("x_swapped_back");
            return Ok(Outcome::HeldAtPath);
        }
        self.preserve(p, tmp)?;
        Ok(Outcome::HeldPreserved)
    }

    fn prototype(
        &mut self,
        p: &Proc,
        path: &str,
        expected: &[u8],
        new: &[u8],
        tmp: &str,
        stash_ours: bool,
    ) -> Result<Outcome, FsError> {
        let our_ino = p.stat(tmp)?.ino;
        match p.exchange(tmp, path) {
            Ok(()) => {}
            Err(FsError::NotFound) => {
                p.unlink(tmp)?;
                return Ok(Outcome::HeldAbsent);
            }
            Err(e) => return Err(e),
        }
        let displaced = p.read(tmp)?;
        if displaced == expected {
            self.stash(p, tmp, expected)?;
            return Ok(Outcome::Published);
        }
        self.inc("p_displaced_mismatch");
        let ino = |x: &str| p.stat(x).ok().map(|m| m.ino);
        for _round in 0..8 {
            if ino(path) != Some(our_ino) {
                break;
            }
            match p.exchange(tmp, path) {
                Ok(()) => {}
                Err(FsError::NotFound) => break,
                Err(e) => return Err(e),
            }
            match ino(tmp) {
                Some(i) if i == our_ino => {
                    let ours_intact = p.read(tmp).map(|b| b == new).unwrap_or(false);
                    if ours_intact {
                        if stash_ours {
                            self.stash(p, tmp, new)?;
                        } else {
                            p.unlink(tmp)?;
                        }
                        self.inc("p_restored");
                        return Ok(Outcome::HeldAtPath);
                    }
                    // An editor wrote into our inode in place while it was at the
                    // path: those are the user's newest bytes; put them back.
                    self.inc("p_inplace_into_ours");
                    let _ = p.exchange(tmp, path);
                    break;
                }
                Some(_) => {
                    self.inc("p_replaced_between");
                    match p.exchange(tmp, path) {
                        Ok(()) => continue,
                        Err(FsError::NotFound) => break,
                        Err(e) => return Err(e),
                    }
                }
                None => break,
            }
        }
        if p.stat(tmp).is_ok() {
            self.preserve(p, tmp)?;
            Ok(Outcome::HeldPreserved)
        } else {
            Ok(Outcome::HeldAtPath)
        }
    }
}

fn naive(p: &Proc, path: &str, expected: &[u8], tmp: &str) -> Result<Outcome, FsError> {
    match p.read(path) {
        Ok(cur) if cur == expected => {}
        Ok(_) => {
            p.unlink(tmp)?;
            return Ok(Outcome::HeldAtPath);
        }
        Err(FsError::NotFound) => {
            p.unlink(tmp)?;
            return Ok(Outcome::HeldAbsent);
        }
        Err(e) => return Err(e),
    }
    match p.rename(tmp, path, true) {
        Ok(()) => Ok(Outcome::Published),
        Err(FsError::AccessDenied | FsError::SharingViolation) => {
            p.unlink(tmp)?;
            Ok(Outcome::Retry("sharing"))
        }
        Err(e) => Err(e),
    }
}

/// Windows protocol D: lock with RW share R, verify through the handle,
/// write at 0, set length, flush, close. No rename: the path never disappears.
fn protocol_d(p: &Proc, path: &str, expected: &[u8], new: &[u8]) -> Result<Outcome, FsError> {
    let l = match p.open(path, Disposition::Existing, Access::RW, Access::R) {
        Ok(l) => l,
        Err(FsError::SharingViolation | FsError::AccessDenied) => {
            return Ok(Outcome::Retry("sharing"));
        }
        Err(FsError::NotFound) => return Ok(Outcome::HeldAbsent),
        Err(e) => return Err(e),
    };
    let cur = p.read_fd(l)?;
    if cur != expected {
        p.close(l)?;
        return Ok(Outcome::HeldAtPath);
    }
    p.write_at(l, 0, new)?;
    p.set_len(l, new.len() as u64)?;
    p.fsync(l)?;
    p.close(l)?;
    Ok(Outcome::Published)
}
