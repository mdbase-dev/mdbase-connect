//! The simulated disk: inodes, a namespace, and an explicit durability model.
//!
//! One [`Disk`] per simulated machine. Processes on the machine (the replica, the
//! user's editors, a sync tool) share it. The OS-specific behaviour (exchange vs
//! swap, Windows share modes, the Obsidian vault adapter) lives in
//! [`crate::platform`]; this module only stores bytes and decides what survives a
//! power loss.
//!
//! **Data durability.** Each inode has its live bytes and its durable bytes.
//! `fsync` makes the live bytes durable. On power loss an unsynced inode comes back
//! as one of: its old durable bytes, the new bytes, a torn mix (a prefix of the new
//! over the old), or empty (the delayed-allocation case after a truncate, which is
//! how in-place savers lose files on ext4 without `auto_da_alloc`).
//!
//! **Namespace durability.** Names change in memory first. Two models:
//! - [`NsDurability::Strict`] (POSIX worst case, the default): an entry is durable
//!   only after `fsync_dir` of its directory. On power loss every directory that
//!   was not synced since its last change reverts as a whole.
//! - [`NsDurability::Journaled`] (ext4/APFS/NTFS): namespace operations are durable
//!   in order. Any fsync commits every earlier operation. On power loss a prefix of
//!   the operations after the last commit survives.
//!
//! A protocol that is safe under `Strict` is safe on a journaling file system.
//!
//! **Change log.** Every namespace or data change is appended to [`Disk::changes`],
//! which watchers ([`crate::platform::Watcher`]) consume.

use std::collections::{BTreeMap, BTreeSet};

use crate::rng::{Ppm, SimRng};

/// Inode number.
pub type Ino = u64;

/// Parent directory of a relative path (`""` for the root).
pub fn parent(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(p, _)| p)
}

/// Last component of a path.
pub fn basename(path: &str) -> &str {
    path.rsplit_once('/').map_or(path, |(_, b)| b)
}

/// One file's bytes.
#[derive(Debug, Clone)]
pub struct Inode {
    /// Live bytes: what a read sees.
    pub data: Vec<u8>,
    /// What survives a power loss for certain.
    pub durable: Vec<u8>,
    /// Live bytes differ from durable bytes.
    pub dirty: bool,
    /// Truncated since the last sync (delayed allocation may lose the new bytes).
    pub truncated: bool,
    /// Modification time, ns.
    pub mtime_ns: u64,
    /// Change counter (bumped on every data change).
    pub version: u64,
}

/// Namespace durability model.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NsDurability {
    /// Per-directory, only through `fsync_dir`.
    Strict,
    /// Ordered journal; any fsync commits all earlier namespace operations.
    Journaled,
}

/// What a watcher or the oracles can learn about a change.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Change {
    /// When, ms.
    pub at: u64,
    /// Path.
    pub path: String,
    /// The process that made it.
    pub by: String,
}

/// File system statistics.
#[derive(Debug, Clone, Default)]
pub struct DiskStats {
    /// Data writes.
    pub writes: u64,
    /// fsync / fsync_dir / syncfs calls.
    pub syncs: u64,
    /// Power losses.
    pub power_losses: u64,
    /// Inodes torn by a power loss.
    pub torn: u64,
}

#[derive(Debug, Clone)]
struct NsOp {
    /// (path, new inode or None for removal), applied in order.
    edits: Vec<(String, Option<Ino>)>,
}

/// A machine's disk.
#[derive(Debug, Clone)]
pub struct Disk {
    /// Inodes by number.
    pub inodes: BTreeMap<Ino, Inode>,
    /// The live namespace.
    pub names: BTreeMap<String, Ino>,
    /// Explicitly created directories (others exist implicitly while non-empty).
    pub dirs: BTreeSet<String>,
    /// Namespace durability model.
    pub ns_model: NsDurability,
    /// Strict: durable namespace. Journaled: namespace as of the last commit.
    durable_names: BTreeMap<String, Ino>,
    /// Strict: directories changed since their last sync.
    unsynced_dirs: BTreeSet<String>,
    /// Journaled: operations after the last commit.
    journal: Vec<NsOp>,
    next_ino: Ino,
    /// Change log for watchers (recorded only while [`Disk::track_changes`]).
    pub changes: Vec<Change>,
    /// Record changes (a watcher is attached and drains them).
    pub track_changes: bool,
    /// Current time (ms), set by the world before each step.
    pub now_ms: u64,
    tick: u64,
    /// mtime granularity in ns (1 = exact; 1_000_000 = ms, as the vault adapter sees).
    pub mtime_granularity_ns: u64,
    /// Counters.
    pub stats: DiskStats,
}

impl Disk {
    /// An empty disk.
    pub fn new(ns_model: NsDurability) -> Self {
        Disk {
            inodes: BTreeMap::new(),
            names: BTreeMap::new(),
            dirs: BTreeSet::new(),
            ns_model,
            durable_names: BTreeMap::new(),
            unsynced_dirs: BTreeSet::new(),
            journal: Vec::new(),
            next_ino: 1,
            changes: Vec::new(),
            track_changes: false,
            now_ms: 0,
            tick: 0,
            mtime_granularity_ns: 1,
            stats: DiskStats::default(),
        }
    }

    fn mtime(&mut self) -> u64 {
        self.tick += 1;
        let ns = self.now_ms * 1_000_000 + (self.tick % 1_000_000);
        ns - ns % self.mtime_granularity_ns.max(1)
    }

    fn note(&mut self, path: &str, by: &str) {
        if !self.track_changes {
            return;
        }
        self.changes.push(Change {
            at: self.now_ms,
            path: path.to_string(),
            by: by.to_string(),
        });
    }

    // ---------------------------------------------------------------- queries

    /// The inode at `path`.
    pub fn ino(&self, path: &str) -> Option<Ino> {
        self.names.get(path).copied()
    }

    /// Live bytes at `path`.
    pub fn read(&self, path: &str) -> Option<&[u8]> {
        self.ino(path)
            .and_then(|i| self.inodes.get(&i))
            .map(|n| n.data.as_slice())
    }

    /// Is `path` a directory (explicit, or a prefix of some name)?
    pub fn is_dir(&self, path: &str) -> bool {
        if path.is_empty() || self.dirs.contains(path) {
            return true;
        }
        let pre = format!("{path}/");
        self.names
            .range(pre.clone()..)
            .next()
            .is_some_and(|(k, _)| k.starts_with(&pre))
    }

    /// Entries directly under `dir`: (name, is_dir).
    pub fn list(&self, dir: &str) -> Vec<(String, bool)> {
        let pre = if dir.is_empty() {
            String::new()
        } else {
            format!("{dir}/")
        };
        let mut out: BTreeMap<String, bool> = BTreeMap::new();
        let keys = self.names.keys().chain(self.dirs.iter());
        for k in keys {
            if let Some(rest) = k.strip_prefix(&pre) {
                if rest.is_empty() {
                    continue;
                }
                match rest.split_once('/') {
                    Some((d, _)) => {
                        out.insert(d.to_string(), true);
                    }
                    None => {
                        let is_dir = self.dirs.contains(k);
                        out.entry(rest.to_string()).or_insert(is_dir);
                    }
                }
            }
        }
        out.into_iter().collect()
    }

    /// Every file path under `prefix`.
    pub fn files_under(&self, prefix: &str) -> Vec<String> {
        self.names
            .keys()
            .filter(|p| p.starts_with(prefix))
            .cloned()
            .collect()
    }

    /// Free inodes that no name links and no open handle (`open`) refers to.
    pub fn gc(&mut self, open: &std::collections::BTreeSet<Ino>) {
        let linked: std::collections::BTreeSet<Ino> = self
            .names
            .values()
            .chain(self.durable_names.values())
            .chain(
                self.journal
                    .iter()
                    .flat_map(|op| op.edits.iter().filter_map(|e| e.1.as_ref())),
            )
            .copied()
            .collect();
        self.inodes
            .retain(|i, _| linked.contains(i) || open.contains(i));
    }

    /// Is the inode linked anywhere?
    pub fn linked(&self, ino: Ino) -> bool {
        self.names.values().any(|i| *i == ino)
    }

    // ---------------------------------------------------------------- data

    /// A new inode with `data`, not linked. `synced` makes the data durable now.
    pub fn new_inode(&mut self, data: Vec<u8>, synced: bool) -> Ino {
        let ino = self.next_ino;
        self.next_ino += 1;
        let mtime_ns = self.mtime();
        self.inodes.insert(
            ino,
            Inode {
                durable: if synced { data.clone() } else { Vec::new() },
                dirty: !synced,
                truncated: false,
                data,
                mtime_ns,
                version: 1,
            },
        );
        self.stats.writes += 1;
        ino
    }

    /// Replace an inode's bytes in place (truncate + write, without fsync).
    pub fn write_inode(&mut self, ino: Ino, data: Vec<u8>, by: &str) {
        let mtime_ns = self.mtime();
        let paths: Vec<String> = self
            .names
            .iter()
            .filter(|(_, i)| **i == ino)
            .map(|(p, _)| p.clone())
            .collect();
        if let Some(n) = self.inodes.get_mut(&ino) {
            if data.len() < n.data.len() || n.data.is_empty() || data != n.data {
                n.truncated |= data.len() < n.data.len() || !n.data.is_empty();
            }
            n.data = data;
            n.dirty = true;
            n.mtime_ns = mtime_ns;
            n.version += 1;
        }
        self.stats.writes += 1;
        for p in paths {
            self.note(&p, by);
        }
    }

    /// Write `bytes` at `offset` (extending as needed), without truncating.
    pub fn write_at(&mut self, ino: Ino, offset: usize, bytes: &[u8], by: &str) {
        let Some(cur) = self.inodes.get(&ino).map(|n| n.data.clone()) else {
            return;
        };
        let mut d = cur;
        if d.len() < offset + bytes.len() {
            d.resize(offset + bytes.len(), 0);
        }
        d[offset..offset + bytes.len()].copy_from_slice(bytes);
        self.write_inode_keep_trunc(ino, d, by);
    }

    /// Set the length (truncate or zero-extend).
    pub fn set_len(&mut self, ino: Ino, len: usize, by: &str) {
        let Some(mut d) = self.inodes.get(&ino).map(|n| n.data.clone()) else {
            return;
        };
        let shrink = len < d.len();
        d.resize(len, 0);
        self.write_inode_keep_trunc(ino, d, by);
        if shrink && let Some(n) = self.inodes.get_mut(&ino) {
            n.truncated = true;
        }
    }

    fn write_inode_keep_trunc(&mut self, ino: Ino, data: Vec<u8>, by: &str) {
        let t = self.inodes.get(&ino).is_some_and(|n| n.truncated);
        self.write_inode(ino, data, by);
        if let Some(n) = self.inodes.get_mut(&ino) {
            n.truncated = t;
        }
    }

    /// fsync(file): the inode's data becomes durable. Journaled: commits the
    /// namespace journal too.
    pub fn sync_inode(&mut self, ino: Ino) {
        self.stats.syncs += 1;
        if let Some(n) = self.inodes.get_mut(&ino) {
            n.durable = n.data.clone();
            n.dirty = false;
            n.truncated = false;
        }
        if self.ns_model == NsDurability::Journaled {
            self.commit_journal();
        }
    }

    // ---------------------------------------------------------------- namespace

    fn ns_edit(&mut self, edits: Vec<(String, Option<Ino>)>, by: &str) {
        for (p, i) in &edits {
            match i {
                Some(i) => {
                    self.names.insert(p.clone(), *i);
                }
                None => {
                    self.names.remove(p);
                }
            }
            self.unsynced_dirs.insert(parent(p).to_string());
            self.note(p, by);
        }
        if self.ns_model == NsDurability::Journaled {
            self.journal.push(NsOp { edits });
        }
    }

    /// Link `ino` at `path` (replacing whatever was there).
    pub fn link(&mut self, path: &str, ino: Ino, by: &str) {
        self.ns_edit(vec![(path.to_string(), Some(ino))], by);
    }

    /// Remove the name `path`.
    pub fn unlink(&mut self, path: &str, by: &str) -> Option<Ino> {
        let i = self.ino(path)?;
        self.ns_edit(vec![(path.to_string(), None)], by);
        Some(i)
    }

    /// Atomically move `from` to `to`, replacing `to`.
    pub fn rename(&mut self, from: &str, to: &str, by: &str) -> Option<Ino> {
        let i = self.ino(from)?;
        if from == to {
            return Some(i);
        }
        self.ns_edit(
            vec![(from.to_string(), None), (to.to_string(), Some(i))],
            by,
        );
        Some(i)
    }

    /// Atomically exchange two names (both must exist).
    pub fn exchange(&mut self, a: &str, b: &str, by: &str) -> bool {
        let (Some(ia), Some(ib)) = (self.ino(a), self.ino(b)) else {
            return false;
        };
        self.ns_edit(
            vec![(a.to_string(), Some(ib)), (b.to_string(), Some(ia))],
            by,
        );
        true
    }

    /// Create a directory.
    pub fn mkdir(&mut self, path: &str) {
        let mut p = path;
        while !p.is_empty() {
            self.dirs.insert(p.to_string());
            p = parent(p);
        }
    }

    /// fsync(dir): Strict makes the directory's entries durable; Journaled commits
    /// the journal.
    pub fn sync_dir(&mut self, dir: &str) {
        self.stats.syncs += 1;
        match self.ns_model {
            NsDurability::Strict => {
                let in_dir = |p: &str| parent(p) == dir;
                self.durable_names.retain(|p, _| !in_dir(p));
                for (p, i) in self.names.iter().filter(|(p, _)| in_dir(p)) {
                    self.durable_names.insert(p.clone(), *i);
                }
                self.unsynced_dirs.remove(dir);
            }
            NsDurability::Journaled => self.commit_journal(),
        }
    }

    fn commit_journal(&mut self) {
        for op in std::mem::take(&mut self.journal) {
            for (p, i) in op.edits {
                match i {
                    Some(i) => {
                        self.durable_names.insert(p, i);
                    }
                    None => {
                        self.durable_names.remove(&p);
                    }
                }
            }
        }
        self.unsynced_dirs.clear();
    }

    /// syncfs: everything becomes durable.
    pub fn sync_all(&mut self) {
        self.stats.syncs += 1;
        for n in self.inodes.values_mut() {
            n.durable = n.data.clone();
            n.dirty = false;
            n.truncated = false;
        }
        self.durable_names = self.names.clone();
        self.unsynced_dirs.clear();
        self.journal.clear();
    }

    /// Mark the current state durable without counting a sync (world setup).
    pub fn settle(&mut self) {
        self.sync_all();
        self.stats.syncs -= 1;
    }

    /// Lose power. Returns the paths whose bytes or existence changed.
    ///
    /// `p_torn`: chance an unsynced inode comes back torn rather than whole-old or
    /// whole-new. `p_new`: chance an unsynced inode's new bytes survive whole.
    pub fn power_loss(&mut self, rng: &mut SimRng, p_torn: Ppm, p_new: Ppm) -> BTreeSet<String> {
        self.stats.power_losses += 1;
        let before: BTreeMap<String, Vec<u8>> = self
            .names
            .iter()
            .map(|(p, i)| (p.clone(), self.inodes[i].data.clone()))
            .collect();
        // Namespace.
        match self.ns_model {
            NsDurability::Strict => {
                // Directories synced since their last change keep their live
                // entries; all others revert as a whole.
                let mut names = self.durable_names.clone();
                let synced: Vec<(String, Ino)> = self
                    .names
                    .iter()
                    .filter(|(p, _)| !self.unsynced_dirs.contains(parent(p)))
                    .map(|(p, i)| (p.clone(), *i))
                    .collect();
                let synced_dirs: BTreeSet<String> =
                    synced.iter().map(|(p, _)| parent(p).to_string()).collect();
                names.retain(|p, _| !synced_dirs.contains(parent(p)));
                names.extend(synced);
                self.names = names;
            }
            NsDurability::Journaled => {
                let keep = rng.below(self.journal.len() as u64 + 1) as usize;
                let ops: Vec<NsOp> = self.journal.drain(..).collect();
                let mut names = self.durable_names.clone();
                for op in ops.into_iter().take(keep) {
                    for (p, i) in op.edits {
                        match i {
                            Some(i) => {
                                names.insert(p, i);
                            }
                            None => {
                                names.remove(&p);
                            }
                        }
                    }
                }
                self.names = names;
            }
        }
        self.durable_names = self.names.clone();
        self.unsynced_dirs.clear();
        // Data.
        for n in self.inodes.values_mut() {
            if !n.dirty {
                continue;
            }
            let roll = rng.below(u64::from(crate::rng::PPM)) as u32;
            n.data = if roll < p_torn {
                self.stats.torn += 1;
                if n.truncated && rng.chance(300_000) {
                    Vec::new() // delayed allocation: the truncate landed, the data did not
                } else {
                    let cut = rng.below(n.data.len() as u64 + 1) as usize;
                    let mut t = n.data[..cut].to_vec();
                    if n.durable.len() > cut {
                        t.extend_from_slice(&n.durable[cut..]);
                    }
                    t
                }
            } else if roll < p_torn.saturating_add(p_new) {
                n.data.clone()
            } else {
                n.durable.clone()
            };
            n.durable = n.data.clone();
            n.dirty = false;
            n.truncated = false;
        }
        let mut changed = BTreeSet::new();
        for (p, b) in &before {
            if self.read(p) != Some(b.as_slice()) {
                changed.insert(p.clone());
            }
        }
        for p in self.names.keys() {
            if !before.contains_key(p) {
                changed.insert(p.clone());
            }
        }
        for p in &changed {
            self.note(p, "power");
        }
        changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rng() -> SimRng {
        SimRng::new(9)
    }

    #[test]
    fn strict_reverts_unsynced_dirs() {
        let mut d = Disk::new(NsDurability::Strict);
        let a = d.new_inode(b"a".to_vec(), true);
        d.link("x/a.md", a, "t");
        // Not synced: lost.
        d.power_loss(&mut rng(), 0, 0);
        assert!(d.read("x/a.md").is_none());
        let a = d.new_inode(b"a".to_vec(), true);
        d.link("x/a.md", a, "t");
        d.sync_dir("x");
        let b = d.new_inode(b"b".to_vec(), true);
        d.link("y/b.md", b, "t");
        d.power_loss(&mut rng(), 0, 0);
        assert_eq!(d.read("x/a.md"), Some(&b"a"[..]));
        assert!(d.read("y/b.md").is_none());
    }

    #[test]
    fn unsynced_data_reverts_or_tears() {
        let mut d = Disk::new(NsDurability::Strict);
        let a = d.new_inode(b"old old old".to_vec(), true);
        d.link("a.md", a, "t");
        d.sync_dir("");
        d.write_inode(a, b"new new new new".to_vec(), "t");
        d.power_loss(&mut rng(), 0, 0);
        assert_eq!(d.read("a.md"), Some(&b"old old old"[..]));
        d.write_inode(a, b"NEW".to_vec(), "t");
        d.sync_inode(a);
        d.power_loss(&mut rng(), crate::rng::PPM, 0);
        assert_eq!(d.read("a.md"), Some(&b"NEW"[..]));
    }

    #[test]
    fn journaled_keeps_a_prefix() {
        let mut seen = BTreeSet::new();
        for s in 0..64 {
            let mut d = Disk::new(NsDurability::Journaled);
            let a = d.new_inode(b"a".to_vec(), true);
            d.link("a", a, "t");
            d.rename("a", "b", "t");
            d.rename("b", "c", "t");
            d.power_loss(&mut SimRng::new(s), 0, 0);
            let state: Vec<String> = d.names.keys().cloned().collect();
            // Never two names for one inode, never a half rename.
            assert!(state.len() <= 1, "{state:?}");
            seen.insert(state);
        }
        assert_eq!(seen.len(), 4, "{seen:?}"); // none, a, b, c
    }

    #[test]
    fn exchange_swaps_inodes() {
        let mut d = Disk::new(NsDurability::Strict);
        let a = d.new_inode(b"a".to_vec(), true);
        let b = d.new_inode(b"b".to_vec(), true);
        d.link("p", a, "t");
        d.link("q", b, "t");
        assert!(d.exchange("p", "q", "t"));
        assert_eq!(d.read("p"), Some(&b"b"[..]));
        assert_eq!(d.list(""), vec![("p".into(), false), ("q".into(), false)]);
    }
}
