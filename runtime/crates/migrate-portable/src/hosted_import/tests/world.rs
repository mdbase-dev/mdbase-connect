//! A fake world for the driver: legacy Postgres (with users writing and accepted
//! pending work), the new log (base, cutover, replay mutations), the DO cache
//! rebuilt from the log, and Connect's control routes. Deterministic per seed, with
//! transient failures, lost append replies and crashes injected.

use std::collections::{BTreeMap, BTreeSet};

use mdbn_core::paths::{check_path, path_key};
use mdbn_wire::common::{B16, B32, Hash};

use super::super::{
    Action, Batch, Class, Effect, Generation, Key, Meta, Outcome, SourceRow, Spill, Table, class_of,
};
use crate::preflight::EntityKind;

pub(crate) struct Rng(pub u64);

impl Rng {
    pub(crate) fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }
    pub(crate) fn below(&mut self, n: u64) -> u64 {
        self.next() % n.max(1)
    }
    pub(crate) fn chance(&mut self, percent: u64) -> bool {
        self.below(100) < percent
    }
    fn pick<'a>(&mut self, xs: &[&'a str]) -> &'a str {
        xs[self.below(xs.len() as u64) as usize]
    }
}

const RECORD_PATHS: &[&str] = &[
    "a.md",
    "A.md",
    "b.md",
    "why?.md",
    "why_.md",
    "notes/c.md",
    "Notes/C.md",
    "x (2).md",
    "x.md",
    "X.md",
    "con.md",
    "tab\t.md",
    ".obsidian/n.md",
    "caf\u{e9}.md",
    "cafe\u{301}.md",
];
const FILE_PATHS: &[&str] = &[
    "img.png",
    "IMG.png",
    "pic?.png",
    "a.md",
    "x (2).png",
    "x.png",
];
const RESOURCE_PATHS: &[&str] = &["mdbase.yaml", "types/task.md", "Types/Task.md", "v?.base"];

pub(crate) fn uuid(n: u64) -> String {
    format!("00000000-0000-4000-8000-{n:012x}")
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct LEnt {
    pub table: Table,
    pub path: String,
    pub content: Hash,
    pub size: u64,
}

#[derive(Clone, Debug)]
enum WOp {
    Put(Key, LEnt),
    Delete(Key),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LState {
    Active,
    Migrating,
    Migrated,
}

/// Legacy hosted Postgres + R2, as far as the driver can observe it.
#[derive(Debug)]
pub(crate) struct Legacy {
    pub state: LState,
    pub head: u64,
    pub ents: BTreeMap<Key, LEnt>,
    pending: Vec<(u64, WOp)>,
    pub acked: u64,
    pub acked_after_fence: u64,
    pub replicas: BTreeSet<String>,
    pub revoked: BTreeSet<String>,
    next_write: u64,
}

impl Legacy {
    fn apply(&mut self, op: WOp) {
        // A legacy write that would duplicate an exact path is refused at apply
        // time by the provider; it was acknowledged, so it must still count: we
        // model the provider as having refused it at acceptance instead (below).
        match op {
            WOp::Put(k, e) => {
                self.ents.insert(k, e);
            }
            WOp::Delete(k) => {
                self.ents.remove(&k);
            }
        }
        self.head += 1;
    }

    pub(crate) fn pending(&self) -> usize {
        self.pending.len()
    }

    /// A user write. Acknowledged only while `active`; may be accepted pending.
    pub(crate) fn user_write(&mut self, rng: &mut Rng) {
        let (key, op) = match rng.below(10) {
            0..=5 => {
                let id = uuid(1 + rng.below(14));
                let key = Key {
                    kind: EntityKind::Record,
                    id,
                };
                if rng.chance(15) {
                    (key.clone(), WOp::Delete(key))
                } else {
                    let size = match rng.below(20) {
                        0 => (2 << 20) + rng.below(100),
                        1 => (600 << 10) + rng.below(100),
                        _ => 10 + rng.below(4000),
                    };
                    let path = rng.pick(RECORD_PATHS).to_owned();
                    let e = LEnt {
                        table: Table::Records,
                        path,
                        content: mdbn_wire::hash::sha256(&rng.next().to_be_bytes()),
                        size,
                    };
                    (key.clone(), WOp::Put(key, e))
                }
            }
            6..=8 => {
                let key = Key {
                    kind: EntityKind::File,
                    id: uuid(0x100 + rng.below(6)),
                };
                if rng.chance(15) {
                    (key.clone(), WOp::Delete(key))
                } else {
                    let e = LEnt {
                        table: Table::Files,
                        path: rng.pick(FILE_PATHS).to_owned(),
                        content: mdbn_wire::hash::sha256(&rng.next().to_be_bytes()),
                        size: 1 + rng.below(50 << 20),
                    };
                    (key.clone(), WOp::Put(key, e))
                }
            }
            _ => {
                let path = rng.pick(RESOURCE_PATHS).to_owned();
                let key = Key {
                    kind: EntityKind::Resource,
                    id: path.clone(),
                };
                if rng.chance(15) {
                    (key.clone(), WOp::Delete(key))
                } else {
                    let e = LEnt {
                        table: Table::Resources,
                        path,
                        content: mdbn_wire::hash::sha256(&rng.next().to_be_bytes()),
                        size: 10 + rng.below(100),
                    };
                    (key.clone(), WOp::Put(key, e))
                }
            }
        };
        if self.state != LState::Active {
            // Fenced: refused, never acknowledged.
            return;
        }
        // The provider keeps exact paths unique (case variants are allowed).
        if let WOp::Put(_, e) = &op
            && self
                .ents
                .iter()
                .chain(self.pending.iter().filter_map(|(_, o)| match o {
                    WOp::Put(k, e) => Some((k, e)),
                    WOp::Delete(_) => None,
                }))
                .any(|(k, x)| *k != key && x.path == e.path)
        {
            return;
        }
        self.next_write += 1;
        self.acked += 1;
        if self.state != LState::Active {
            self.acked_after_fence += 1;
        }
        if rng.chance(30) {
            self.pending.push((self.next_write, op));
        } else {
            self.apply(op);
        }
    }

    /// Test setup: an acknowledged write applied at once (while `active`).
    pub(crate) fn put(&mut self, key: Key, e: LEnt) {
        assert_eq!(self.state, LState::Active);
        self.next_write += 1;
        self.acked += 1;
        self.apply(WOp::Put(key, e));
    }

    /// The provider applies one accepted pending write (it keeps doing so after
    /// the fence: that is the drain).
    pub(crate) fn apply_one_pending(&mut self) {
        if !self.pending.is_empty() {
            let (_, op) = self.pending.remove(0);
            self.apply(op);
        }
    }
}

/// One item in the new log.
#[derive(Clone, Debug)]
pub(crate) enum LogItem {
    Base(B32),
    Cutover(#[allow(dead_code)] u64),
    Mutation(B16, Vec<Effect>),
}

/// Injected faults.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct Faults {
    pub transient: u64,
    pub unknown: u64,
    pub crash: u64,
    pub stale: u64,
    pub unverified: u64,
    pub pause: u64,
    pub writes: u64,
    /// Crash exactly at this action index (after its effect if `crash_after`).
    pub crash_at: Option<usize>,
    pub crash_after: bool,
    /// Lose the reply of every append (performing it when `unknown_performed`).
    pub all_unknown: bool,
    pub unknown_performed: bool,
}

/// What `perform` asks the test loop to do.
pub(crate) enum Next {
    Outcome(Outcome),
    Crash,
}

pub(crate) struct World {
    pub rng: Rng,
    pub legacy: Legacy,
    pub log: Vec<LogItem>,
    objects: BTreeMap<B32, BTreeMap<Key, Meta>>,
    pub collection_created: bool,
    pub routed: bool,
    pub paused: bool,
    pub faults: Faults,
    pub actions: usize,
    pub duplicate_appends: u64,
    /// The account was deleted: every later request answers `Gone`.
    pub deleted: bool,
    pub crashes: u64,
    pub lost_replies: u64,
    // Host RAM: lost on a crash.
    session: Option<(Generation, BTreeMap<Key, LEnt>)>,
    staged: BTreeMap<Key, Meta>,
    cache: Option<BTreeMap<Key, Meta>>,
}

impl World {
    pub(crate) fn new(seed: u64, faults: Faults) -> World {
        let mut rng = Rng(seed);
        let mut legacy = Legacy {
            state: LState::Active,
            head: 0,
            ents: BTreeMap::new(),
            pending: Vec::new(),
            acked: 0,
            acked_after_fence: 0,
            replicas: (0..rng.below(3)).map(|i| format!("replica-{i}")).collect(),
            revoked: BTreeSet::new(),
            next_write: 0,
        };
        for _ in 0..(5 + rng.below(30)) {
            legacy.user_write(&mut rng);
        }
        World {
            rng,
            legacy,
            log: Vec::new(),
            objects: BTreeMap::new(),
            collection_created: false,
            routed: false,
            paused: false,
            faults,
            actions: 0,
            duplicate_appends: 0,
            deleted: false,
            crashes: 0,
            lost_replies: 0,
            session: None,
            staged: BTreeMap::new(),
            cache: None,
        }
    }

    /// Users keep writing, and the provider keeps applying accepted work, between
    /// the driver's requests.
    pub(crate) fn tick(&mut self) {
        if self.rng.chance(self.faults.writes) {
            self.legacy.user_write(&mut self.rng);
        }
        if self.rng.chance(20) {
            self.legacy.apply_one_pending();
        }
        if self.faults.pause > 0 {
            self.paused = self.rng.chance(self.faults.pause);
        }
    }

    /// The host lost its RAM (DO eviction): sessions, staging and the cache.
    pub(crate) fn crash(&mut self) {
        self.crashes += 1;
        self.session = None;
        self.staged.clear();
        self.cache = None;
    }

    pub(crate) fn perform(&mut self, action: &Action, spill: &mut dyn Spill) -> Next {
        let index = self.actions;
        self.actions += 1;
        let crash_here = self.faults.crash_at == Some(index);
        if crash_here && !self.faults.crash_after {
            return Next::Crash;
        }
        let retryable = !matches!(action, Action::Wait(_) | Action::Continue | Action::Done(_));
        if self.deleted && retryable {
            return Next::Outcome(Outcome::Gone);
        }
        if retryable && self.rng.chance(self.faults.transient) {
            return Next::Outcome(Outcome::Failed {
                transient: true,
                reason: "injected".into(),
            });
        }
        let outcome = self.effect(action, spill);
        if crash_here || (retryable && self.rng.chance(self.faults.crash)) {
            return Next::Crash;
        }
        Next::Outcome(outcome)
    }

    fn lose_reply(&mut self) -> Option<bool> {
        if self.faults.all_unknown {
            return Some(self.faults.unknown_performed);
        }
        self.rng
            .chance(self.faults.unknown)
            .then(|| self.rng.chance(50))
    }

    fn append(&mut self, item: LogItem) -> Outcome {
        let lost = self.lose_reply();
        self.lost_replies += u64::from(lost.is_some());
        match lost {
            Some(false) => Outcome::Unknown,
            Some(true) => {
                self.log.push(item);
                Outcome::Unknown
            }
            None => {
                self.log.push(item);
                Outcome::Appended {
                    seq: self.log.len() as u64,
                }
            }
        }
    }

    fn effect(&mut self, action: &Action, spill: &mut dyn Spill) -> Outcome {
        match action {
            Action::EnsureBackup => Outcome::Backup {
                hold: "hold-1".into(),
            },
            Action::CreateCollection => {
                self.collection_created = true;
                Outcome::Created {
                    verified: !self.rng.chance(self.faults.unverified),
                }
            }
            Action::OpenSource {
                generation,
                expect_head,
            } => {
                // `expect_head` present: the collection must be fenced at that head.
                let ok = match (generation, expect_head) {
                    (Generation::S0, None) => self.legacy.state == LState::Active,
                    (_, Some(_)) => self.legacy.state == LState::Migrating,
                    (Generation::Final, None) => false,
                };
                if !ok {
                    return Outcome::Failed {
                        transient: false,
                        reason: format!("legacy is {:?}", self.legacy.state),
                    };
                }
                self.session = Some((*generation, self.legacy.ents.clone()));
                Outcome::Opened {
                    head: self.legacy.head,
                }
            }
            Action::ReadPage {
                generation,
                table,
                cursor,
                max_rows,
                ..
            } => {
                let Some((g, snap)) = &self.session else {
                    return Outcome::Failed {
                        transient: false,
                        reason: "no session".into(),
                    };
                };
                assert_eq!(g, generation);
                let mut rows: Vec<(&Key, &LEnt)> =
                    snap.iter().filter(|(_, e)| e.table == *table).collect();
                if *table == Table::Resources {
                    // Not byte order: the source's collation.
                    rows.reverse();
                }
                let start = cursor.as_deref().map_or(0, |c| c.parse::<usize>().unwrap());
                let n = (1 + self.rng.below(4) as usize).min(*max_rows);
                let page: Vec<SourceRow> = rows
                    .iter()
                    .skip(start)
                    .take(n)
                    .map(|(k, e)| SourceRow {
                        id: (k.kind != EntityKind::Resource).then(|| k.id.clone()),
                        path: e.path.clone(),
                        content: e.content,
                        size: e.size,
                    })
                    .collect();
                let next =
                    (start + page.len() < rows.len()).then(|| (start + page.len()).to_string());
                Outcome::Page { rows: page, next }
            }
            Action::ImportGen0 {
                bits,
                bucket,
                after,
            } => {
                let Some((Generation::S0, snap)) = &self.session else {
                    return Outcome::Failed {
                        transient: false,
                        reason: "no S0 session".into(),
                    };
                };
                let limit = 1 + self.rng.below(5) as usize;
                let page = spill
                    .placements_in_bucket(Generation::S0, *bits, *bucket, after.as_ref(), limit)
                    .unwrap();
                for (k, m) in &page {
                    // H3: stream the S0 bytes and verify them before sealing.
                    let e = snap.get(k).expect("placement exists at S0");
                    assert_eq!((e.content, e.size), (m.content, m.size));
                    self.staged.insert(k.clone(), m.clone());
                }
                Outcome::Gen0Progress {
                    last: page.last().map(|(k, _)| k.clone()),
                    done: page.len() < limit,
                }
            }
            Action::FinishGen0 => {
                let mut m = Vec::new();
                for (k, v) in &self.staged {
                    m.extend_from_slice(&k.to_bytes());
                    m.extend_from_slice(v.path.as_bytes());
                    m.extend_from_slice(&v.content.0);
                }
                let manifest = mdbn_wire::hash::sha256(&m);
                self.objects
                    .insert(manifest, std::mem::take(&mut self.staged));
                Outcome::Gen0Built {
                    manifest,
                    state_digest: manifest,
                }
            }
            Action::AppendBase { manifest, .. } => {
                assert!(self.collection_created, "H1 before H4");
                assert!(
                    !self.log.iter().any(|i| matches!(i, LogItem::Base(_))),
                    "a second base"
                );
                if self.rng.chance(self.faults.stale) {
                    self.objects.remove(manifest);
                    return Outcome::Stale;
                }
                if !self.objects.contains_key(manifest) {
                    // The log service refuses a base whose refs are gone.
                    return Outcome::Stale;
                }
                self.append(LogItem::Base(*manifest))
            }
            Action::FindBase => Outcome::Found {
                seq: self.position(|i| matches!(i, LogItem::Base(_))),
            },
            Action::Rebuild { at_least } => {
                assert!(self.log.len() as u64 >= *at_least);
                self.cache = Some(self.fold());
                Outcome::Rebuilt {
                    head: self.log.len() as u64,
                }
            }
            Action::ReadNew { cursor } => {
                let cache = self.cache.as_ref().expect("rebuilt before read");
                let start = cursor.as_deref().map_or(0, |c| c.parse::<usize>().unwrap());
                let n = 1 + self.rng.below(7) as usize;
                let rows: Vec<(Key, Meta)> = cache
                    .iter()
                    .skip(start)
                    .take(n)
                    .map(|(k, m)| {
                        let k = if k.kind == EntityKind::Resource {
                            // The cache knows a resource by its current path only.
                            Key {
                                kind: k.kind,
                                id: m.path.clone(),
                            }
                        } else {
                            k.clone()
                        };
                        (k, m.clone())
                    })
                    .collect();
                let next =
                    (start + rows.len() < cache.len()).then(|| (start + rows.len()).to_string());
                Outcome::NewPage { rows, next }
            }
            Action::MayFence => Outcome::MayFence(!self.paused),
            Action::Fence => {
                if self.legacy.state == LState::Active {
                    self.legacy.state = LState::Migrating;
                }
                Outcome::Ok
            }
            Action::DrainStatus => {
                assert_eq!(self.legacy.state, LState::Migrating, "drain after fence");
                if self.rng.chance(60) {
                    self.legacy.apply_one_pending();
                }
                Outcome::Drain {
                    pending: self.legacy.pending() as u64,
                    head: self.legacy.head,
                }
            }
            Action::ListReplicas => Outcome::Replicas {
                ids: self
                    .legacy
                    .replicas
                    .difference(&self.legacy.revoked)
                    .cloned()
                    .collect(),
            },
            Action::RevokeReplicas { ids } => {
                self.legacy.revoked.extend(ids.iter().cloned());
                Outcome::Ok
            }
            Action::AppendCutover { s_final } => {
                assert_eq!(self.legacy.state, LState::Migrating);
                assert_eq!(self.legacy.pending(), 0, "cutover before the drain");
                assert_eq!(self.legacy.head, *s_final, "cutover at a moving head");
                assert!(
                    self.legacy.revoked.is_superset(&self.legacy.replicas),
                    "cutover before revoke"
                );
                if self.log.iter().any(|i| matches!(i, LogItem::Cutover(_))) {
                    return Outcome::Conflict;
                }
                self.append(LogItem::Cutover(*s_final))
            }
            Action::FindCutover => Outcome::Found {
                seq: self.position(|i| matches!(i, LogItem::Cutover(_))),
            },
            Action::Replay(batch) => self.replay(batch),
            Action::FindMutation { mutation } => Outcome::Found {
                seq: self.position(|i| matches!(i, LogItem::Mutation(m, _) if m == mutation)),
            },
            Action::LogHead => Outcome::Head {
                seq: self.log.len() as u64,
            },
            Action::Route {
                s_final,
                cutover_seq,
                barrier_f,
                ..
            } => {
                assert_eq!(*s_final, self.legacy.head, "routes at the drained head");
                assert_eq!(
                    Some(*cutover_seq),
                    self.position(|i| matches!(i, LogItem::Cutover(_))),
                    "the cutover position is the join sync point"
                );
                assert!(*barrier_f >= *cutover_seq && *barrier_f <= self.log.len() as u64);
                self.legacy.state = LState::Migrated;
                self.routed = true;
                Outcome::Ok
            }
            Action::Unrevoke { ids } => {
                for id in ids {
                    self.legacy.revoked.remove(id);
                }
                Outcome::Ok
            }
            Action::Unfence => {
                assert!(
                    !self.log.iter().any(|i| matches!(i, LogItem::Cutover(_))),
                    "un-fence after cutover"
                );
                if self.legacy.state == LState::Migrating {
                    self.legacy.state = LState::Active;
                }
                Outcome::Ok
            }
            Action::Wait(_) | Action::Continue | Action::Done(_) => Outcome::Ok,
        }
    }

    fn replay(&mut self, b: &Batch) -> Outcome {
        assert!(b.effects.len() <= crate::budget::MAX_BATCH_EFFECTS);
        let bytes: u64 = b.effects.iter().map(Effect::bytes).sum();
        assert!(
            bytes <= crate::budget::MAX_BATCH_BYTES as u64 || b.effects.len() == 1,
            "batch over budget"
        );
        assert!(
            self.log.iter().any(|i| matches!(i, LogItem::Cutover(_))),
            "replay before cutover"
        );
        assert_eq!(self.legacy.state, LState::Migrating);
        assert_eq!(self.legacy.head, b.s_final, "replay reads a frozen S_final");
        for e in &b.effects {
            if let Effect::Put { key, to, .. } = e {
                let l = self.legacy.ents.get(key).expect("put of a live entity");
                assert_eq!(
                    (l.content, l.size),
                    (to.content, to.size),
                    "content at S_final"
                );
                assert_eq!(class_of(l.table, l.size), to.class);
            }
        }
        if let Some(seq) =
            self.position(|i| matches!(i, LogItem::Mutation(m, _) if *m == b.mutation))
        {
            // The log's receipts answer a retried mutation ID with its first outcome.
            self.duplicate_appends += 1;
            return Outcome::Appended { seq };
        }
        // The replica refuses a mutation whose preconditions do not hold (CAS).
        let mut state = self.fold();
        for e in &b.effects {
            let ok = match e {
                Effect::Delete { key, from } => state.remove(key).as_ref() == Some(from),
                Effect::Park { key, from, to } => match state.get_mut(key) {
                    Some(cur) if cur == from => {
                        cur.path = to.clone();
                        true
                    }
                    _ => false,
                },
                Effect::Put { key, from, to } => {
                    let ok = state.get(key) == from.as_ref();
                    state.insert(key.clone(), to.clone());
                    ok
                }
            };
            if !ok {
                return Outcome::Failed {
                    transient: false,
                    reason: "replica refused: precondition".into(),
                };
            }
        }
        let mut keys = BTreeSet::new();
        if !state.values().all(|m| keys.insert(path_key(&m.path))) {
            return Outcome::Failed {
                transient: false,
                reason: "replica refused: path collision".into(),
            };
        }
        self.append(LogItem::Mutation(b.mutation, b.effects.clone()))
    }

    fn position(&self, f: impl Fn(&LogItem) -> bool) -> Option<u64> {
        self.log.iter().position(f).map(|p| p as u64 + 1)
    }

    /// The confirmed state the log determines (what a fresh DO rebuild installs),
    /// checking every effect's precondition and path-key uniqueness after every
    /// mutation, exactly as the replica would refuse a collision.
    pub(crate) fn fold(&self) -> BTreeMap<Key, Meta> {
        let mut state: BTreeMap<Key, Meta> = BTreeMap::new();
        for item in &self.log {
            match item {
                LogItem::Base(m) => state = self.objects[m].clone(),
                LogItem::Cutover(_) => {}
                LogItem::Mutation(_, effects) => {
                    for e in effects {
                        match e {
                            Effect::Delete { key, from } => {
                                assert_eq!(state.remove(key).as_ref(), Some(from));
                            }
                            Effect::Park { key, from, to } => {
                                let cur = state.get_mut(key).expect("park a live entity");
                                assert_eq!(&*cur, from);
                                cur.path = to.clone();
                            }
                            Effect::Put { key, from, to } => {
                                assert_eq!(state.get(key), from.as_ref(), "put precondition");
                                state.insert(key.clone(), to.clone());
                            }
                        }
                        let mut keys = BTreeSet::new();
                        for m in state.values() {
                            assert!(
                                check_path(&m.path).is_ok(),
                                "non-portable path in the new log"
                            );
                            assert!(keys.insert(path_key(&m.path)), "two entities share a path");
                        }
                    }
                }
            }
        }
        state
    }
}

/// Legacy state as the new system must hold it: content, size and class by key.
pub(crate) fn expected(legacy: &Legacy) -> BTreeMap<Key, (Hash, u64, Class)> {
    legacy
        .ents
        .iter()
        .map(|(k, e)| (k.clone(), (e.content, e.size, class_of(e.table, e.size))))
        .collect()
}
