//! A transactional key-value store with a durability model: the simulator's
//! `IndexStorage` (SQLite natively, sqlite-wasm in webviews, IndexedDB journals).
//!
//! Commits are atomic. What survives depends on [`KvSync`]:
//! - `Full` (SQLite `synchronous=FULL`, IndexedDB `strict`): a commit is durable
//!   when it returns;
//! - `Normal` (SQLite WAL `synchronous=NORMAL`, IndexedDB `relaxed`): a commit
//!   survives a process crash, but a power loss may drop any suffix of the commits
//!   since the last checkpoint;
//! - `Off` (`localStorage`, an unsynced vault append file): even a process crash
//!   may drop a suffix of recent commits (including `localStorage`-style lag).
//!
//! Stores live on a machine ([`crate::platform::Machine::kv`]) and are reached
//! through a [`Proc`], so the syscall hook can interleave or crash around commits.

use std::collections::BTreeMap;

use crate::platform::{FsError, FsResult, Proc};
use crate::rng::SimRng;

/// Durability of commits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KvSync {
    /// Durable on return.
    Full,
    /// Survives process crashes; power loss may drop a recent suffix.
    Normal,
    /// A process crash may drop a recent suffix.
    Off,
}

/// One write in a transaction: `None` deletes.
pub type KvWrite = (Vec<u8>, Option<Vec<u8>>);

/// A transactional store.
#[derive(Debug, Clone)]
pub struct Kv {
    /// Durability mode.
    pub sync: KvSync,
    /// What reads see.
    pub live: BTreeMap<Vec<u8>, Vec<u8>>,
    /// Durable base.
    durable: BTreeMap<Vec<u8>, Vec<u8>>,
    /// Commits after the durable base, in order.
    tail: Vec<Vec<KvWrite>>,
    /// Commits so far.
    pub commits: u64,
}

impl Kv {
    /// An empty store.
    pub fn new(sync: KvSync) -> Self {
        Kv {
            sync,
            live: BTreeMap::new(),
            durable: BTreeMap::new(),
            tail: Vec::new(),
            commits: 0,
        }
    }

    fn apply(map: &mut BTreeMap<Vec<u8>, Vec<u8>>, w: &[KvWrite]) {
        for (k, v) in w {
            match v {
                Some(v) => {
                    map.insert(k.clone(), v.clone());
                }
                None => {
                    map.remove(k);
                }
            }
        }
    }

    /// Apply a transaction.
    pub fn commit(&mut self, writes: Vec<KvWrite>) {
        self.commits += 1;
        Self::apply(&mut self.live, &writes);
        if self.sync == KvSync::Full {
            Self::apply(&mut self.durable, &writes);
        } else {
            self.tail.push(writes);
        }
    }

    /// Make everything durable (a checkpoint).
    pub fn checkpoint(&mut self) {
        self.durable = self.live.clone();
        self.tail.clear();
    }

    fn lose_suffix(&mut self, rng: &mut SimRng) {
        let keep = rng.below(self.tail.len() as u64 + 1) as usize;
        let mut m = self.durable.clone();
        for w in self.tail.iter().take(keep) {
            Self::apply(&mut m, w);
        }
        self.live = m.clone();
        self.durable = m;
        self.tail.clear();
    }

    /// The owning process crashed.
    pub fn process_crash(&mut self, rng: &mut SimRng) {
        if self.sync == KvSync::Off {
            self.lose_suffix(rng);
        }
    }

    /// The machine lost power.
    pub fn power_loss(&mut self, rng: &mut SimRng) {
        if self.sync != KvSync::Full {
            self.lose_suffix(rng);
        }
    }
}

impl Proc {
    /// Open (create) a store.
    pub fn kv_open(&self, store: &str, sync: KvSync) -> FsResult<()> {
        if self.crashed.get() {
            return Err(FsError::Crashed);
        }
        self.m
            .borrow_mut()
            .kv
            .entry(store.to_string())
            .or_insert_with(|| Kv::new(sync));
        Ok(())
    }

    /// Read a key.
    pub fn kv_get(&self, store: &str, key: &[u8]) -> FsResult<Option<Vec<u8>>> {
        if self.crashed.get() {
            return Err(FsError::Crashed);
        }
        let m = self.m.borrow();
        Ok(m.kv.get(store).and_then(|s| s.live.get(key).cloned()))
    }

    /// Every key-value pair with `prefix`, in key order.
    pub fn kv_scan(&self, store: &str, prefix: &[u8]) -> FsResult<Vec<(Vec<u8>, Vec<u8>)>> {
        if self.crashed.get() {
            return Err(FsError::Crashed);
        }
        let m = self.m.borrow();
        Ok(m.kv
            .get(store)
            .map(|s| {
                s.live
                    .range(prefix.to_vec()..)
                    .take_while(|(k, _)| k.starts_with(prefix))
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect()
            })
            .unwrap_or_default())
    }

    /// Commit a transaction atomically. The hook runs first (a crash before the
    /// commit means it never happened).
    pub fn kv_commit(&self, store: &str, writes: Vec<KvWrite>) -> FsResult<()> {
        self.hook_point("kv_commit", store)?;
        let mut m = self.m.borrow_mut();
        let s = m.kv.get_mut(store).ok_or(FsError::NotFound)?;
        s.commit(writes);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durability_modes() {
        let mut r = SimRng::new(5);
        let mut full = Kv::new(KvSync::Full);
        full.commit(vec![(b"a".to_vec(), Some(b"1".to_vec()))]);
        full.power_loss(&mut r);
        assert_eq!(full.live.get(&b"a"[..]), Some(&b"1".to_vec()));

        let mut lost_any = false;
        for s in 0..20 {
            let mut r = SimRng::new(s);
            let mut normal = Kv::new(KvSync::Normal);
            for i in 0..5u8 {
                normal.commit(vec![(vec![i], Some(vec![i]))]);
            }
            normal.process_crash(&mut r);
            assert_eq!(normal.live.len(), 5);
            normal.power_loss(&mut r);
            // Always a prefix.
            let keys: Vec<u8> = normal.live.keys().map(|k| k[0]).collect();
            assert_eq!(keys, (0..keys.len() as u8).collect::<Vec<_>>());
            lost_any |= keys.len() < 5;
        }
        assert!(lost_any);
    }
}
