//! Publishing the local view, ingesting external edits, and holds, against a toy
//! file-backed store (a `MemStore` plus an in-memory "disk").

use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::ops::Range;
use std::rc::Rc;

use crate::api::{ClientApi, HoldResolution, SessionAuth, SessionId};
use crate::fake::{FakeLog, FakeLogService};
use crate::log::{EndpointId, pump};
use crate::mem::MemStore;
use crate::plan::Planner;
use crate::seal::PlainSealer;
use crate::store::*;
use crate::{DeviceSecrets, Host, Replica, ReplicaConfig, UtcOnly};
use mdbn_core::host::Clock;
use mdbn_core::intent::{Mutation as CMutation, Op as COp};
use mdbn_core::plan::{
    ConflictKind, ConflictValue, Effect, PlanOptions, Planned, RecordedConflict, RejectCode,
    Rejection, Status,
};
use mdbn_core::state::StateView;
use mdbn_wire::client::{HelloParams, Hold, SubmitParams};
use mdbn_wire::common::{B16, Hash, Text, Uuid, Version};
use mdbn_wire::intent::{Create, FileInclusion, Op};

// ---------------------------------------------------------------- a toy disk store

#[derive(Default)]
struct Disk {
    files: BTreeMap<String, String>,
    /// What the store last knew was at each path.
    known: BTreeMap<String, Hash>,
    queued: Vec<Observation>,
    outstanding: BTreeMap<ObservationId, Observation>,
    next: u64,
    /// Simulate a crash after the inner commit: drop this many publish batches.
    drop_publishes: u32,
    /// Publish later, like the WASM host queue: batches wait for `complete`.
    defer: bool,
    deferred: Vec<(PublishBatch, Vec<Publish>)>,
    results: Vec<PublishResult>,
    batches: u64,
    observe_calls: u64,
    acknowledged: u64,
    publish_attempts: u64,
    max_pending: u64,
    pending_rows_read: u64,
    holds_reads: u64,
    source_paused: bool,
    current_paused: bool,
    complete_paused: bool,
    source_started: Vec<ObservationId>,
    current_started: Vec<ObservationId>,
    complete_started: u64,
}

fn h(s: &str) -> Hash {
    mdbn_wire::hash::sha256(s.as_bytes())
}

impl Disk {
    /// Perform the deferred publishes (the host completed its file operations).
    fn complete(&mut self) {
        for (batch, ps) in std::mem::take(&mut self.deferred) {
            let drifts = ps.into_iter().filter_map(|p| self.perform(p)).collect();
            self.results.push(PublishResult { batch, drifts });
        }
    }

    fn perform(&mut self, p: Publish) -> Option<Drift> {
        let d = self;
        let ok = |d: &Disk, path: &str, e: &Expect| match e {
            Expect::Absent => !d.files.contains_key(path),
            Expect::Revision(r) => d.files.get(path).map(|s| h(s)) == Some(*r),
        };
        let drift = |p: &Publish| {
            Some(Drift {
                publish: p.clone(),
                reason: "changed".into(),
            })
        };
        match &p {
            Publish::Write {
                path,
                expect,
                content,
                ..
            } => {
                if !ok(d, path, expect) {
                    return drift(&p);
                }
                let Content::Text(t) = content else {
                    return None;
                };
                d.known.insert(path.clone(), h(t));
                d.files.insert(path.clone(), t.clone());
            }
            Publish::Delete { path, expect, .. } => {
                if !ok(d, path, expect) {
                    return drift(&p);
                }
                d.files.remove(path);
                d.known.remove(path);
            }
            Publish::Move {
                from,
                to,
                expect,
                content,
                ..
            } => {
                if !ok(d, from, expect) || d.files.contains_key(to) {
                    return drift(&p);
                }
                let old = d.files.remove(from).unwrap_or_default();
                d.known.remove(from);
                let new = match content {
                    Some(Content::Text(t)) => t.clone(),
                    _ => old,
                };
                d.known.insert(to.clone(), h(&new));
                d.files.insert(to.clone(), new);
            }
        }
        None
    }

    /// A user edit: write and queue an observation.
    fn user_write(&mut self, path: &str, text: Option<&str>) {
        match text {
            Some(t) => self.files.insert(path.into(), t.into()),
            None => self.files.remove(path),
        };
        self.next += 1;
        self.queued.push(Observation {
            token: ObservationId(self.next),
            path: path.into(),
            base: self.known.get(path).copied(),
            now: text.map(|t| Observed::Text(t.into())),
            moved_from: None,
            provenance: Provenance::Normal,
        });
    }
}

struct DiskStore {
    inner: MemStore,
    disk: Rc<RefCell<Disk>>,
    /// Closing a deferred-durability window fails (an uncertain barrier).
    barrier_fails: bool,
}

impl Store for DiskStore {
    fn head(&self) -> StoreResult<Head> {
        self.inner.head()
    }
    fn record(&self, id: &Uuid) -> StoreResult<Option<RecordRow>> {
        self.inner.record(id)
    }
    fn record_at(&self, k: &str) -> StoreResult<Option<Uuid>> {
        self.inner.record_at(k)
    }
    fn records(&self, p: Page) -> StoreResult<Vec<RecordRow>> {
        self.inner.records(p)
    }
    fn records_in_buckets(&self, r: Range<u32>, p: Page) -> StoreResult<Vec<RecordRow>> {
        self.inner.records_in_buckets(r, p)
    }
    fn record_count(&self) -> StoreResult<u64> {
        self.inner.record_count()
    }
    fn file(&self, id: &Uuid) -> StoreResult<Option<FileRow>> {
        self.inner.file(id)
    }
    fn file_at(&self, k: &str) -> StoreResult<Option<Uuid>> {
        self.inner.file_at(k)
    }
    fn files(&self, p: Page) -> StoreResult<Vec<FileRow>> {
        self.inner.files(p)
    }
    fn files_in_buckets(&self, r: Range<u32>, p: Page) -> StoreResult<Vec<FileRow>> {
        self.inner.files_in_buckets(r, p)
    }
    fn resource(&self, p: &str) -> StoreResult<Option<String>> {
        self.inner.resource(p)
    }
    fn resources(&self) -> StoreResult<Vec<(String, String)>> {
        self.inner.resources()
    }
    fn resource_paths_page(&self, p: ResourcePathPage<'_>) -> StoreResult<Vec<String>> {
        self.inner.resource_paths_page(p)
    }
    fn resource_bounded(&self, p: &str, limit: usize) -> StoreResult<Option<BoundedResource>> {
        self.inner.resource_bounded(p, limit)
    }
    fn resource_observation_batch_complete(
        &self,
        _observations: &[Observation],
    ) -> StoreResult<bool> {
        // This toy backend returns the complete queued observation set, never a prefix.
        Ok(true)
    }
    fn resource_observation_batch_complete_async<'a>(
        &'a self,
        observations: &'a [Observation],
    ) -> StoreFuture<'a, bool> {
        Box::pin(async move {
            self.disk.borrow_mut().complete_started += 1;
            std::future::poll_fn(|_| {
                if self.disk.borrow().complete_paused {
                    std::task::Poll::Pending
                } else {
                    std::task::Poll::Ready(())
                }
            })
            .await;
            self.resource_observation_batch_complete(observations)
        })
    }
    fn resource_observation_current_async<'a>(
        &'a mut self,
        o: &'a Observation,
    ) -> StoreFuture<'a, bool> {
        Box::pin(async move {
            self.disk.borrow_mut().current_started.push(o.token);
            std::future::poll_fn(|_| {
                if self.disk.borrow().current_paused {
                    std::task::Poll::Pending
                } else {
                    std::task::Poll::Ready(())
                }
            })
            .await;
            self.resource_observation_current(o)
        })
    }
    fn resource_observation_text_async<'a>(
        &'a mut self,
        o: &'a Observation,
        limit: usize,
    ) -> StoreFuture<'a, Option<String>> {
        Box::pin(async move {
            self.disk.borrow_mut().source_started.push(o.token);
            std::future::poll_fn(|_| {
                if self.disk.borrow().source_paused {
                    std::task::Poll::Pending
                } else {
                    std::task::Poll::Ready(())
                }
            })
            .await;
            self.resource_observation_text(o, limit)
        })
    }
    fn resource_observation_current(&mut self, o: &Observation) -> StoreResult<bool> {
        let d = self.disk.borrow();
        Ok(match &o.now {
            Some(Observed::Text(text)) => d.files.get(&o.path) == Some(text),
            None => !d.files.contains_key(&o.path),
            _ => false,
        })
    }
    fn resource_observation_text(
        &mut self,
        o: &Observation,
        limit: usize,
    ) -> StoreResult<Option<String>> {
        let d = self.disk.borrow();
        let Some(current) = d.files.get(&o.path) else {
            return Ok(None);
        };
        let Some(Observed::Text(observed)) = &o.now else {
            return Ok(None);
        };
        if current.len() > limit || current != observed {
            return Ok(None);
        }
        Ok(Some(current.clone()))
    }
    fn settings(&self) -> StoreResult<Option<FileInclusion>> {
        self.inner.settings()
    }
    fn tombstone(&self, id: &Uuid) -> StoreResult<Option<TombstoneRow>> {
        self.inner.tombstone(id)
    }
    fn tombstones_at(&self, k: &str) -> StoreResult<Vec<TombstoneRow>> {
        self.inner.tombstones_at(k)
    }
    fn tombstones(&self, p: Page) -> StoreResult<Vec<TombstoneRow>> {
        self.inner.tombstones(p)
    }
    fn alias(&self, k: &str) -> StoreResult<Option<Uuid>> {
        self.inner.alias(k)
    }
    fn aliases(&self) -> StoreResult<Vec<AliasRow>> {
        self.inner.aliases()
    }
    fn conflicts(&self, of: Option<&Uuid>) -> StoreResult<Vec<ConflictRow>> {
        self.inner.conflicts(of)
    }
    fn conflict_count(&self) -> StoreResult<u64> {
        self.inner.conflict_count()
    }
    fn receipt(&self, m: &Uuid) -> StoreResult<Option<ReceiptRow>> {
        self.inner.receipt(m)
    }
    fn receipts(&self, a: Option<Uuid>, l: u32) -> StoreResult<Vec<ReceiptRow>> {
        self.inner.receipts(a, l)
    }
    fn referrers(&self, k: &[String]) -> StoreResult<Vec<Uuid>> {
        self.inner.referrers(k)
    }
    fn unique_holders(&self, f: &str, v: &str) -> StoreResult<Vec<Uuid>> {
        self.inner.unique_holders(f, v)
    }
    fn candidates(&self, q: &Candidate, p: Page) -> StoreResult<Vec<RecordRow>> {
        self.inner.candidates(q, p)
    }
    fn pending(&self, a: Option<u64>, l: u32) -> StoreResult<Vec<PendingRow>> {
        let rows = self.inner.pending(a, l)?;
        self.disk.borrow_mut().pending_rows_read += rows.len() as u64;
        Ok(rows)
    }
    fn pending_get(&self, m: &Uuid) -> StoreResult<Option<PendingRow>> {
        self.inner.pending_get(m)
    }
    fn pending_count(&self) -> StoreResult<u64> {
        self.inner.pending_count()
    }
    fn local_receipt(&self, m: &Uuid) -> StoreResult<Option<LocalReceipt>> {
        self.inner.local_receipt(m)
    }
    fn holds(&self) -> StoreResult<Vec<Hold>> {
        self.disk.borrow_mut().holds_reads += 1;
        self.inner.holds()
    }
    fn hold(&self, id: &Uuid) -> StoreResult<Option<Hold>> {
        self.inner.hold(id)
    }
    fn meta(&self, k: &str) -> StoreResult<Option<Vec<u8>>> {
        self.inner.meta(k)
    }
    fn transfer(&self, id: &Uuid) -> StoreResult<Option<TransferRow>> {
        self.inner.transfer(id)
    }
    fn transfer_chunk(&self, id: &Uuid, i: u64) -> StoreResult<Option<Vec<u8>>> {
        self.inner.transfer_chunk(id, i)
    }
    fn blob_size(&self, d: &Hash) -> StoreResult<Option<u64>> {
        self.inner.blob_size(d)
    }
    fn blob_read(&self, d: &Hash, o: u64, l: u64) -> StoreResult<Vec<u8>> {
        self.inner.blob_read(d, o, l)
    }
    fn has_files(&self) -> bool {
        true
    }

    fn durability_deferred(&self) -> bool {
        self.inner.durability_deferred()
    }
    fn defer_durability(&mut self, on: bool) -> StoreResult<()> {
        if !on && self.barrier_fails {
            return Err(StoreError::Io("barrier: outcome unknown".into()));
        }
        self.inner.defer_durability(on)
    }
    fn commit(&mut self, mut tx: Tx) -> StoreResult<CommitReport> {
        let publish = std::mem::take(&mut tx.publish);
        let acks = tx.ack_observations.clone();
        self.inner.commit(tx)?;
        let mut d = self.disk.borrow_mut();
        d.max_pending = d.max_pending.max(self.inner.pending_count()?);
        d.acknowledged += acks.len() as u64;
        d.publish_attempts += publish.len() as u64;
        // Acknowledged observations must not be reoffered by an earlier deferral.
        d.queued.retain(|o| !acks.contains(&o.token));
        // Acknowledged observations: their bytes are now known.
        for a in acks {
            d.outstanding.remove(&a);
        }
        let paths: Vec<String> = d.files.keys().cloned().collect();
        d.known.retain(|path, _| paths.contains(path));
        for p in paths {
            let r = h(&d.files[&p]);
            d.known.insert(p, r);
        }
        let mut report = CommitReport::default();
        if !publish.is_empty() && d.drop_publishes > 0 {
            d.drop_publishes -= 1;
            return Ok(report);
        }
        if d.defer && !publish.is_empty() {
            d.batches += 1;
            let b = PublishBatch(d.batches);
            d.deferred.push((b, publish));
            report.deferred = Some(b);
            return Ok(report);
        }
        for p in publish {
            if let Some(dr) = d.perform(p) {
                report.drifts.push(dr);
            }
        }
        Ok(report)
    }

    fn disk_revision(&self, path: &str) -> StoreResult<Option<Hash>> {
        Ok(self.disk.borrow().known.get(path).copied())
    }

    fn disk_paths(&self) -> StoreResult<Vec<(String, Hash)>> {
        Ok(self
            .disk
            .borrow()
            .known
            .iter()
            .map(|(p, h)| (p.clone(), *h))
            .collect())
    }

    fn take_publish_results(&mut self) -> Vec<PublishResult> {
        std::mem::take(&mut self.disk.borrow_mut().results)
    }

    fn observe(&mut self, _paths: Option<&[String]>) -> StoreResult<Vec<Observation>> {
        let mut d = self.disk.borrow_mut();
        d.observe_calls += 1;
        let observations = std::mem::take(&mut d.queued);
        for o in &observations {
            d.outstanding.insert(o.token, o.clone());
        }
        Ok(observations)
    }

    fn defer_disk_observations(&mut self, tokens: &[ObservationId]) -> StoreResult<()> {
        let mut d = self.disk.borrow_mut();
        for token in tokens {
            if let Some(o) = d.outstanding.get(token).cloned()
                && !d.queued.iter().any(|queued| queued.token == *token)
            {
                d.queued.push(o);
            }
        }
        Ok(())
    }
}

#[test]
fn public_disk_watch_is_quarantined_until_known_retry_or_terminal_reopen() {
    use crate::replica::DiskKey;
    for terminal in [false, true] {
        let svc = FakeLogService::new();
        let mut a = node(&svc, 1);
        settle(&mut [&mut a]);
        let target = crate::testkit::TestControlPlane::new(COL).revoke(&svc, B16([109; 16]));
        if terminal {
            a.r.store().inner.fail_unknown_commits(1);
        } else {
            a.r.store().inner.fail_commits(1);
        }
        let item = mdbn_wire::log_service::SeqItem {
            seq: target,
            item: mdbn_wire::common::Bytes(svc.items(&COL)[target as usize - 1].clone()),
        };
        a.r.apply_items(vec![item.clone()]);
        assert_eq!(a.r.requires_reopen(), terminal);
        a.disk.borrow_mut().results.push(PublishResult {
            batch: PublishBatch(u64::MAX),
            drifts: Vec::new(),
        });
        a.r.on_store_progress();
        assert_eq!(
            a.disk.borrow().results.len(),
            1,
            "fault/recovery must not consume late publication callbacks"
        );
        a.disk.borrow_mut().results.clear();
        a.disk
            .borrow_mut()
            .user_write("while-paused.md", Some("unacknowledged user edit"));
        let observations = a.disk.borrow().queued.clone();
        let counts = {
            let d = a.disk.borrow();
            (d.observe_calls, d.acknowledged, d.publish_attempts)
        };
        let commits = a.r.store().inner.data().borrow().commits;
        assert!(a.r.observe(None).is_err());
        a.r.ingest(observations);
        // Even invalid namespace observations must not be auto-acknowledged.
        a.r.ingest(vec![Observation {
            token: ObservationId(999),
            path: "../invalid.md".into(),
            base: None,
            now: None,
            moved_from: None,
            provenance: Provenance::Normal,
        }]);
        let key = DiskKey::Record(B16([0xaa; 16]));
        a.r.before.insert(key.clone(), None);
        a.r.retry_publish.insert(key, None);
        let before = a.r.before.clone();
        let retry = a.r.retry_publish.clone();
        assert!(a.r.materialize().is_err());
        a.r.retry_publishes();
        assert_eq!(
            a.r.before, before,
            "paused materialization retains its evidence"
        );
        assert_eq!(a.r.retry_publish, retry);
        assert_eq!(a.r.store().inner.data().borrow().commits, commits);
        assert_eq!(
            a.r.store().pending_count().unwrap(),
            0,
            "no capture/planning"
        );
        {
            let d = a.disk.borrow();
            assert_eq!(
                (d.observe_calls, d.acknowledged, d.publish_attempts),
                counts
            );
            assert_eq!(d.queued.len(), 1, "watcher evidence was not consumed");
            assert_eq!(d.files["while-paused.md"], "unacknowledged user edit");
        }
        if terminal {
            let cfg = a.r.cfg.clone();
            let store = a.r.into_store();
            a.r = Replica::open(
                cfg,
                store,
                Box::new(TestPlanner),
                Box::new(PlainSealer::for_device(B16([101; 16]))),
                Host {
                    clock: Box::new(TestClock(Rc::new(Cell::new(1_700_000_000_000)))),
                    entropy: Box::new(crate::crypto::TestEntropy::new(1)),
                    zones: Box::new(UtcOnly),
                },
                DeviceSecrets {
                    sign_sk: [1; 32],
                    kem_sk: [1; 32],
                },
            )
            .unwrap();
        } else {
            a.r.apply_items(vec![item]);
            assert!(!a.r.is_apply_recovering());
        }
        assert!(!a.r.requires_reopen());
        // Fresh observation after recovery captures and acknowledges the retained
        // user bytes, rather than discarding them or using a stale queued plan.
        let ack_before = a.disk.borrow().acknowledged;
        a.r.observe(None).unwrap();
        assert!(a.disk.borrow().queued.is_empty());
        assert!(a.disk.borrow().acknowledged > ack_before);
        assert!(a.r.store().pending_count().unwrap() > 0);
        assert_eq!(
            a.disk.borrow().files["while-paused.md"],
            "unacknowledged user edit"
        );
    }
}

// ---------------------------------------------------------------- planner and host

/// Creates; documents merge by "base equals current → apply, else conflict, keep current".
struct TestPlanner;

impl Planner for TestPlanner {
    fn plan(
        &self,
        m: &CMutation,
        state: &dyn StateView,
        _o: &PlanOptions,
    ) -> Result<Planned, Rejection> {
        let mut out = Planned::noop();
        for op in &m.ops {
            match op {
                COp::Create(c) => {
                    let path = c.path.clone().unwrap_or_default();
                    if state
                        .at_path_key(&mdbn_core::paths::path_key(&path))
                        .is_some()
                    {
                        return Err(Rejection::new(
                            RejectCode::Conflict,
                            Some("path_taken"),
                            "taken",
                        ));
                    }
                    out.effects.push(Effect::PutRecord {
                        id: c.id,
                        path,
                        doc: c.document.clone().unwrap_or_default(),
                    });
                }
                COp::Document(d) => {
                    let cur = state.record(&d.id);
                    let base_ok = match (&d.base, &cur) {
                        (Some(b), Some(c)) => b.doc == *c.source && b.path == c.path,
                        (None, None) => true,
                        (None, Some(_)) => false,
                        (Some(_), None) => true,
                    };
                    if base_ok {
                        match &d.new {
                            Some(n) => out.effects.push(Effect::PutRecord {
                                id: d.id,
                                path: n.path.clone(),
                                doc: n.doc.clone(),
                            }),
                            None => {
                                if let Some(c) = cur {
                                    out.effects.push(Effect::RemoveRecord {
                                        id: d.id,
                                        path: c.path,
                                    });
                                }
                            }
                        }
                    } else {
                        out.status = Status::Conflicted;
                        out.conflicts.push(RecordedConflict {
                            kind: ConflictKind::Body,
                            id: d.id,
                            field: None,
                            base: None,
                            kept: ConflictValue::Text(
                                cur.map(|c| c.source.to_string()).unwrap_or_default(),
                            ),
                            lost: ConflictValue::Text(
                                d.new.as_ref().map(|n| n.doc.clone()).unwrap_or_default(),
                            ),
                        });
                    }
                }
                // Applying removes the dismissed row; nothing to plan.
                COp::ConflictDismiss(_) => {}
                _ => {
                    return Err(Rejection::new(
                        RejectCode::InvalidRequest,
                        None,
                        "unsupported",
                    ));
                }
            }
        }
        Ok(out)
    }
}

struct TestClock(Rc<Cell<u64>>);
impl Clock for TestClock {
    fn now_ms(&self) -> u64 {
        self.0.get()
    }
}

const COL: B16 = B16([7; 16]);

struct Node {
    r: Replica<DiskStore>,
    log: FakeLog,
    s: SessionId,
    disk: Rc<RefCell<Disk>>,
    clock: Rc<Cell<u64>>,
}

fn node(svc: &FakeLogService, n: u8) -> Node {
    node_mode(svc, n, mdbn_wire::client::SyncMode::Synced)
}

fn node_mode(svc: &FakeLogService, n: u8, mode: mdbn_wire::client::SyncMode) -> Node {
    let clock = Rc::new(Cell::new(1_700_000_000_000));
    let disk = Rc::new(RefCell::new(Disk::default()));
    let store = DiskStore {
        inner: MemStore::new(),
        disk: disk.clone(),
        barrier_fails: false,
    };
    let cfg = ReplicaConfig {
        collection: COL,
        replica_id: B16([n; 16]),
        device_id: B16([n + 100; 16]),
        mode,
        log_endpoint: EndpointId(1),
        verify: false,
        runtime_version: "test".into(),
        trusted_roots: vec![crate::testkit::TEST_ROOT],
        e2e: false,
        trusted_signers: (101..=109u8).map(|d| B16([d; 16])).collect(),
        user_enabled_cloud_copy: false,
        chosen_state: None,
        key_grants_only: false,
        expected_genesis: None,
        policy_pins: None,
    };
    if mode == mdbn_wire::client::SyncMode::Synced && svc.head(&COL).0 == 0 {
        let devs: Vec<B16> = (101..=109u8).map(|d| B16([d; 16])).collect();
        crate::testkit::TestControlPlane::new(COL).bootstrap(
            svc,
            mdbn_wire::policy::CState::E2e,
            &devs,
        );
    }
    let host = Host {
        clock: Box::new(TestClock(clock.clone())),
        entropy: Box::new(crate::crypto::TestEntropy::new(n)),
        zones: Box::new(UtcOnly),
    };
    let mut r = Replica::open(
        cfg,
        store,
        Box::new(TestPlanner),
        Box::new(PlainSealer::for_device(B16([n + 100; 16]))),
        host,
        DeviceSecrets {
            sign_sk: [n; 32],
            kem_sk: [n; 32],
        },
    )
    .unwrap();
    let (s, _) = r
        .hello(
            SessionAuth::Host,
            HelloParams {
                versions: vec![Version { major: 1, minor: 0 }],
                client_name: "t".into(),
                client_version: "0".into(),
                features: None,
                timezone: None,
            },
        )
        .unwrap();
    Node {
        r,
        log: svc.client(B16([n + 100; 16])),
        s,
        disk,
        clock,
    }
}

impl Node {
    fn step(&mut self) {
        self.r.observe(None).unwrap();
        pump(&mut self.r, &mut self.log, 100);
        self.r.tick();
    }
    fn file(&self, p: &str) -> Option<String> {
        self.disk.borrow().files.get(p).cloned()
    }
}

fn settle(ns: &mut [&mut Node]) {
    for _ in 0..10 {
        for n in ns.iter_mut() {
            n.step();
        }
    }
}

fn create(n: &mut Node, id: u8, path: &str, doc: &str) -> mdbn_wire::client::Receipt {
    n.r.submit(
        n.s,
        SubmitParams {
            ops: vec![Op::Create(Create {
                id: B16([id; 16]),
                path: Some(path.into()),
                type_name: None,
                frontmatter: None,
                body: None,
                document: Some(Text::Inline(doc.into())),
            })],
            mutation_id: None,
            conflict_mode: None,
            timezone: None,
            allow_partial: None,
            mutation_ids: None,
            dry_run: None,
            include: None,
            wait: None,
        },
    )
    .unwrap()
    .remove(0)
}

#[test]
fn local_and_remote_writes_are_published() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1);
    let mut b = node(&svc, 2);
    create(&mut a, 1, "a.md", "one");
    assert_eq!(a.file("a.md").as_deref(), Some("one"), "optimistic publish");
    settle(&mut [&mut a, &mut b]);
    assert_eq!(b.file("a.md").as_deref(), Some("one"), "remote publish");
}

#[test]
fn oversized_new_synced_observation_retains_user_bytes_without_ack_or_publish() {
    use mdbn_wire::client::IncidentKind;
    use mdbn_wire::common::Value;
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1);
    settle(&mut [&mut a]);
    let source = "é".repeat(mdbn_core::plan::admission::SYNCED_RECORD_MAX_BYTES / 2 + 1);
    let (acks, publishes) = {
        let disk = a.disk.borrow();
        (disk.acknowledged, disk.publish_attempts)
    };
    let head = a.r.head();
    a.disk.borrow_mut().user_write("large.md", Some(&source));
    a.r.observe(None).unwrap();
    assert_eq!(a.file("large.md").as_deref(), Some(source.as_str()));
    assert_eq!(a.disk.borrow().acknowledged, acks);
    assert_eq!(a.disk.borrow().publish_attempts, publishes);
    assert_eq!(a.r.store().pending_count().unwrap(), 0);
    assert_eq!(a.r.store().record_count().unwrap(), 0);
    assert_eq!(a.r.head(), head);
    assert!(
        !a.r.requires_reopen(),
        "a known source refusal is not an uncertain store outcome"
    );
    assert!(a.r.status(a.s).unwrap().incidents.iter().any(|incident| {
        incident.kind == IncidentKind::QuotaExceeded
            && matches!(&incident.details, Some(Value::Map(details)) if details.iter().any(|(key, value)| key == "reason" && value == &Value::Text("record_too_large".into())))
    }));
}

#[test]
fn oversized_synced_edit_does_not_overwrite_user_bytes_and_a_reduced_edit_can_sync() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1);
    create(&mut a, 1, "edit.md", "original");
    settle(&mut [&mut a]);
    let source = "x".repeat(mdbn_core::plan::admission::SYNCED_RECORD_MAX_BYTES + 1);
    let (acks, publishes) = {
        let disk = a.disk.borrow();
        (disk.acknowledged, disk.publish_attempts)
    };
    let head = a.r.head();
    a.disk.borrow_mut().user_write("edit.md", Some(&source));
    a.r.observe(None).unwrap();
    assert_eq!(a.file("edit.md").as_deref(), Some(source.as_str()));
    assert_eq!(a.disk.borrow().acknowledged, acks);
    assert_eq!(a.disk.borrow().publish_attempts, publishes);
    assert_eq!(a.r.store().pending_count().unwrap(), 0);
    assert_eq!(
        a.r.store().record(&B16([1; 16])).unwrap().unwrap().doc,
        "original"
    );
    assert_eq!(a.r.head(), head);
    a.disk.borrow_mut().user_write("edit.md", Some("reduced"));
    settle(&mut [&mut a]);
    assert!(a.disk.borrow().acknowledged > acks);
    assert_eq!(a.file("edit.md").as_deref(), Some("reduced"));
    assert_eq!(
        a.r.store().record(&B16([1; 16])).unwrap().unwrap().doc,
        "reduced"
    );
}

#[test]
fn external_edits_sync() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1);
    let mut b = node(&svc, 2);
    create(&mut a, 1, "a.md", "one");
    settle(&mut [&mut a, &mut b]);
    b.disk.borrow_mut().user_write("a.md", Some("two"));
    settle(&mut [&mut a, &mut b]);
    assert_eq!(a.file("a.md").as_deref(), Some("two"));
    assert_eq!(a.r.head(), b.r.head());
    // A new file on disk becomes a record everywhere.
    a.disk.borrow_mut().user_write("new.md", Some("fresh"));
    settle(&mut [&mut a, &mut b]);
    assert_eq!(b.file("new.md").as_deref(), Some("fresh"));
    // A delete on disk deletes everywhere.
    b.disk.borrow_mut().user_write("new.md", None);
    settle(&mut [&mut a, &mut b]);
    assert!(a.file("new.md").is_none());
    // Synced ingest never defers durability: its entries leave the device.
    for n in [&a, &b] {
        assert_eq!(n.r.store().inner.data().borrow().windows, (0, 0));
    }
}

fn move_file(n: &mut Node, from: &str, to: &str, text: &str) {
    let mut disk = n.disk.borrow_mut();
    let base = disk.known.get(from).copied();
    disk.files.remove(from);
    disk.user_write(to, Some(text));
    let observation = disk.queued.last_mut().unwrap();
    observation.moved_from = Some(from.into());
    observation.base = base;
}

fn set_member_role(svc: &FakeLogService, nodes: &mut [&mut Node], role: mdbn_wire::policy::Role) {
    use mdbn_wire::policy::{MemberSet, PolicyOp, Role};
    let mut cp = crate::testkit::TestControlPlane::new(COL);
    cp.append(
        svc,
        vec![
            PolicyOp::MemberSet(MemberSet {
                account: B16([0xab; 16]),
                role: Role::Owner,
            }),
            PolicyOp::MemberSet(MemberSet {
                account: crate::testkit::TEST_OWNER,
                role,
            }),
        ],
    );
    settle(nodes);
}

#[test]
fn viewer_bulk_scan_holds_in_batches_before_an_upgrade_can_release_edits() {
    use mdbn_wire::policy::Role;
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1);
    set_member_role(&svc, &mut [&mut a], Role::Viewer);
    a.r.subscribe_holds(a.s).unwrap();
    for i in 0..193 {
        a.disk
            .borrow_mut()
            .user_write(&format!("viewer-{i}.md"), Some("held"));
    }
    let commits = a.r.store().inner.data().borrow().commits;
    let reads = a.disk.borrow().holds_reads;
    assert!(a.r.observe_changes().unwrap().is_empty());
    assert_eq!(a.r.store().inner.data().borrow().commits - commits, 4);
    assert!(
        a.disk.borrow().holds_reads - reads <= 4,
        "hold reads and notifications are per scan, never per file"
    );
    assert_eq!(
        a.r.take_pushes()
            .iter()
            .filter(|(_, p)| matches!(p, crate::api::Push::Holds(_)))
            .count(),
        1
    );
    assert_eq!(a.r.list_holds(a.s).unwrap().len(), 193);
    set_member_role(&svc, &mut [&mut a], Role::Editor);
    assert_eq!(a.r.sync_status().pending, 0);
    assert_eq!(a.r.list_holds(a.s).unwrap().len(), 193);
}

#[test]
fn viewer_disk_changes_wait_for_explicit_choice_after_upgrade_and_restart() {
    use mdbn_wire::{client::HoldReason, policy::Role};
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1);
    let mut b = node(&svc, 2);
    create(&mut a, 1, "edit.md", "owner");
    create(&mut a, 2, "delete.md", "keep");
    create(&mut a, 3, "rename.md", "rename me");
    settle(&mut [&mut a, &mut b]);
    set_member_role(&svc, &mut [&mut a, &mut b], Role::Viewer);
    b.disk.borrow_mut().user_write("edit.md", Some("viewer"));
    b.disk.borrow_mut().user_write("delete.md", None);
    b.disk
        .borrow_mut()
        .user_write("new.md", Some("new viewer file"));
    b.disk
        .borrow_mut()
        .user_write("_types/viewer.md", Some("invalid type source"));
    {
        let mut disk = b.disk.borrow_mut();
        let base = disk.known.get("rename.md").copied();
        disk.files.remove("rename.md");
        disk.user_write("renamed.md", Some("rename me"));
        let observation = disk.queued.last_mut().unwrap();
        observation.moved_from = Some("rename.md".into());
        observation.base = base;
    }
    assert!(
        b.r.observe_changes().unwrap().is_empty(),
        "Viewer refusals are durable before an upgrade can release the daemon queue"
    );
    settle(&mut [&mut a, &mut b]);
    let holds = b.r.store().holds().unwrap();
    assert_eq!(holds.len(), 6);
    assert!(holds.iter().all(|h| h.reason == HoldReason::ReadOnly));
    assert_eq!(b.r.sync_status().pending, 0);
    assert_eq!(a.file("edit.md").as_deref(), Some("owner"));
    assert_eq!(a.file("delete.md").as_deref(), Some("keep"));
    assert!(a.file("new.md").is_none());
    assert!(b.r.store().resource("_types/viewer.md").unwrap().is_none());
    assert!(
        !b.r.sync_status()
            .incidents
            .iter()
            .any(|i| i.kind == mdbn_wire::client::IncidentKind::Integrity),
        "a refused type must not invalidate readiness"
    );
    let edit = holds.iter().find(|h| h.path == "edit.md").unwrap().id;
    assert!(
        b.r.resolve_hold(b.s, edit, HoldResolution::KeepMine)
            .is_err()
    );
    set_member_role(&svc, &mut [&mut a, &mut b], Role::Editor);
    let store = b.r.into_store();
    let mut b = reopen(&svc, 2, store, b.log, b.disk);
    settle(&mut [&mut a, &mut b]);
    assert_eq!(b.r.store().holds().unwrap().len(), 6);
    assert_eq!(b.r.sync_status().pending, 0);
    assert_eq!(a.file("edit.md").as_deref(), Some("owner"));
    assert_eq!(a.file("delete.md").as_deref(), Some("keep"));
    assert!(a.file("new.md").is_none());
    assert_eq!(a.file("rename.md").as_deref(), Some("rename me"));
    assert!(a.file("renamed.md").is_none());
    for hold in holds {
        let choice = if hold.path.starts_with("_types/") {
            HoldResolution::TakeTheirs
        } else {
            HoldResolution::KeepMine
        };
        b.r.resolve_hold(b.s, hold.id, choice).unwrap();
        settle(&mut [&mut a, &mut b]);
    }
    assert_eq!(a.file("edit.md").as_deref(), Some("viewer"));
    assert!(a.file("delete.md").is_none());
    assert_eq!(a.file("new.md").as_deref(), Some("new viewer file"));
    assert!(a.file("rename.md").is_none());
    assert_eq!(a.file("renamed.md").as_deref(), Some("rename me"));
    assert!(b.file("_types/viewer.md").is_none());
    assert!(b.r.store().holds().unwrap().is_empty());
}

#[test]
fn viewer_can_discard_a_held_edit_and_new_file_without_write_access() {
    use mdbn_wire::policy::Role;
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1);
    let mut b = node(&svc, 2);
    create(&mut a, 1, "a.md", "original");
    settle(&mut [&mut a, &mut b]);
    set_member_role(&svc, &mut [&mut a, &mut b], Role::Viewer);
    b.disk.borrow_mut().user_write("a.md", None);
    b.disk.borrow_mut().user_write("new.md", Some("local"));
    settle(&mut [&mut a, &mut b]);
    for hold in b.r.store().holds().unwrap() {
        b.r.resolve_hold(b.s, hold.id, HoldResolution::TakeTheirs)
            .unwrap();
    }
    settle(&mut [&mut a, &mut b]);
    assert_eq!(b.file("a.md").as_deref(), Some("original"));
    assert!(b.file("new.md").is_none());
    assert_eq!(b.r.sync_status().pending, 0);
    assert!(b.r.store().holds().unwrap().is_empty());
}

#[test]
fn host_writes_recheck_current_role_and_leave_no_viewer_pending() {
    use mdbn_wire::policy::Role;
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1);
    a.r.subscribe_status(a.s).unwrap();
    set_member_role(&svc, &mut [&mut a], Role::Viewer);
    assert_eq!(a.r.status(a.s).unwrap().grant.unwrap().role, Role::Viewer);
    assert!(a.r.take_pushes().iter().any(|(session, push)| *session == a.s
        && matches!(push, crate::api::Push::Status(status) if status.grant.as_ref().is_some_and(|g| g.role == Role::Viewer))));
    let (viewer_session, hello) =
        a.r.hello(
            SessionAuth::Host,
            HelloParams {
                versions: vec![Version { major: 1, minor: 0 }],
                client_name: "viewer".into(),
                client_version: "0".into(),
                features: None,
                timezone: None,
            },
        )
        .unwrap();
    assert_eq!(hello.grant.role, Role::Viewer);
    assert_eq!(hello.grant.capabilities, vec!["collection.read"]);
    a.r.close(viewer_session);
    assert!(
        !a.r.status(a.s)
            .unwrap()
            .incidents
            .iter()
            .any(|i| i.kind == mdbn_wire::client::IncidentKind::ReadOnly),
        "Viewer is a role, not a sync error"
    );
    let mut request = SubmitParams {
        ops: vec![Op::Create(Create {
            id: B16([44; 16]),
            path: Some("refused.md".into()),
            type_name: None,
            frontmatter: None,
            body: None,
            document: Some(Text::Inline("viewer".into())),
        })],
        mutation_id: None,
        conflict_mode: None,
        timezone: None,
        allow_partial: None,
        mutation_ids: None,
        dry_run: None,
        include: None,
        wait: None,
    };
    let error = a.r.submit(a.s, request.clone()).unwrap_err();
    assert_eq!(error.problem().reason.as_deref(), Some("read_only"));
    assert_eq!(a.r.sync_status().pending, 0);
    set_member_role(&svc, &mut [&mut a], Role::Editor);
    assert_eq!(a.r.status(a.s).unwrap().grant.unwrap().role, Role::Editor);
    assert!(a.r.take_pushes().iter().any(|(session, push)| *session == a.s
        && matches!(push, crate::api::Push::Status(status) if status.grant.as_ref().is_some_and(|g| g.role == Role::Editor))));
    request.ops[0] = Op::Create(Create {
        id: B16([45; 16]),
        path: Some("allowed.md".into()),
        type_name: None,
        frontmatter: None,
        body: None,
        document: Some(Text::Inline("editor".into())),
    });
    a.r.submit(a.s, request).unwrap();
    settle(&mut [&mut a]);
    assert_eq!(a.file("allowed.md").as_deref(), Some("editor"));
}

#[test]
fn read_only_hold_preserves_newer_synced_edits_until_discard() {
    use mdbn_wire::policy::Role;
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1);
    let mut b = node(&svc, 2);
    create(&mut a, 1, "a.md", "original");
    settle(&mut [&mut a, &mut b]);
    set_member_role(&svc, &mut [&mut a, &mut b], Role::Viewer);
    b.disk.borrow_mut().user_write("a.md", Some("viewer edit"));
    settle(&mut [&mut a, &mut b]);
    set_member_role(&svc, &mut [&mut a, &mut b], Role::Editor);
    b.r.subscribe_holds(b.s).unwrap();
    b.r.take_pushes();
    a.disk
        .borrow_mut()
        .user_write("a.md", Some("newer synced edit"));
    settle(&mut [&mut a, &mut b]);
    let hold = b.r.list_holds(b.s).unwrap().remove(0);
    assert!(b.r.take_pushes().iter().any(
        |(_, push)| matches!(push, crate::api::Push::Holds(holds) if holds == &vec![hold.clone()])
    ));
    assert_eq!(
        hold.base,
        Some(mdbn_wire::snapshot::TextOrBlob::Text("original".into()))
    );
    assert_eq!(
        hold.theirs,
        Some(mdbn_wire::snapshot::TextOrBlob::Text(
            "newer synced edit".into()
        ))
    );
    let error =
        b.r.resolve_hold(b.s, hold.id, HoldResolution::KeepMine)
            .unwrap_err();
    assert_eq!(
        error.problem().reason.as_deref(),
        Some("concurrent_modification")
    );
    assert_eq!(b.file("a.md").as_deref(), Some("viewer edit"));
    assert_eq!(b.r.store().holds().unwrap().len(), 1);
    assert_eq!(b.r.sync_status().pending, 0);
    b.r.resolve_hold(b.s, hold.id, HoldResolution::TakeTheirs)
        .unwrap();
    settle(&mut [&mut a, &mut b]);
    assert_eq!(a.file("a.md").as_deref(), Some("newer synced edit"));
    assert_eq!(b.file("a.md").as_deref(), Some("newer synced edit"));
}

#[test]
fn read_only_conflict_can_keep_both_without_overwriting_the_synced_note() {
    use mdbn_wire::policy::Role;
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1);
    let mut b = node(&svc, 2);
    b.r.set_conflict_label("Work PC");
    create(&mut a, 1, "a.md", "original");
    settle(&mut [&mut a, &mut b]);
    set_member_role(&svc, &mut [&mut a, &mut b], Role::Viewer);
    b.disk.borrow_mut().user_write("a.md", Some("viewer edit"));
    settle(&mut [&mut a, &mut b]);
    set_member_role(&svc, &mut [&mut a, &mut b], Role::Editor);
    a.disk
        .borrow_mut()
        .user_write("a.md", Some("newer synced edit"));
    settle(&mut [&mut a, &mut b]);
    let id = b.r.list_holds(b.s).unwrap()[0].id;
    assert!(b.r.resolve_hold(b.s, id, HoldResolution::KeepMine).is_err());
    b.r.resolve_hold(b.s, id, HoldResolution::KeepBoth).unwrap();
    settle(&mut [&mut a, &mut b]);
    assert_eq!(a.file("a.md").as_deref(), Some("newer synced edit"));
    assert_eq!(b.file("a.md").as_deref(), Some("newer synced edit"));
    let copies: Vec<_> = a
        .disk
        .borrow()
        .files
        .iter()
        .filter(|(path, _)| path.contains(" (conflict "))
        .map(|(path, doc)| (path.clone(), doc.clone()))
        .collect();
    assert_eq!(copies.len(), 1);
    assert!(copies[0].0.starts_with("a (conflict Work PC "));
    assert_eq!(copies[0].1, "viewer edit");
    assert_eq!(b.file(&copies[0].0).as_deref(), Some("viewer edit"));
    assert!(b.r.list_holds(b.s).unwrap().is_empty());
}

#[test]
fn viewer_rename_and_recreate_preserve_two_independent_holds() {
    use mdbn_wire::policy::Role;
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1);
    let mut b = node(&svc, 2);
    create(&mut a, 1, "a.md", "original");
    settle(&mut [&mut a, &mut b]);
    set_member_role(&svc, &mut [&mut a, &mut b], Role::Viewer);
    {
        let mut disk = b.disk.borrow_mut();
        let base = disk.known.get("a.md").copied();
        disk.files.remove("a.md");
        disk.user_write("b.md", Some("viewer renamed"));
        let observation = disk.queued.last_mut().unwrap();
        observation.moved_from = Some("a.md".into());
        observation.base = base;
    }
    settle(&mut [&mut a, &mut b]);
    b.disk
        .borrow_mut()
        .user_write("a.md", Some("viewer recreated"));
    settle(&mut [&mut a, &mut b]);
    let holds = b.r.list_holds(b.s).unwrap();
    assert_eq!(holds.len(), 2);
    let renamed = holds.iter().find(|hold| hold.path == "b.md").unwrap();
    let recreated = holds.iter().find(|hold| hold.path == "a.md").unwrap();
    assert_ne!(renamed.id, recreated.id);
    assert_eq!(
        recreated.base,
        Some(mdbn_wire::snapshot::TextOrBlob::Text("original".into()))
    );
    set_member_role(&svc, &mut [&mut a, &mut b], Role::Editor);
    b.disk
        .borrow_mut()
        .user_write("b.md", Some("viewer saved again"));
    settle(&mut [&mut a, &mut b]);
    assert_eq!(b.r.sync_status().pending, 0);
    assert_eq!(b.r.list_holds(b.s).unwrap().len(), 2);
    assert_eq!(a.file("a.md").as_deref(), Some("original"));
    assert!(a.file("b.md").is_none());
    b.r.resolve_hold(b.s, renamed.id, HoldResolution::KeepMine)
        .unwrap();
    settle(&mut [&mut a, &mut b]);
    b.r.resolve_hold(b.s, recreated.id, HoldResolution::KeepMine)
        .unwrap();
    settle(&mut [&mut a, &mut b]);
    assert_eq!(a.file("a.md").as_deref(), Some("viewer recreated"));
    assert_eq!(a.file("b.md").as_deref(), Some("viewer saved again"));
}

#[test]
fn read_only_hold_does_not_undo_a_synced_rename() {
    use mdbn_wire::policy::Role;
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1);
    let mut b = node(&svc, 2);
    create(&mut a, 1, "a.md", "original");
    settle(&mut [&mut a, &mut b]);
    set_member_role(&svc, &mut [&mut a, &mut b], Role::Viewer);
    b.disk.borrow_mut().user_write("a.md", Some("viewer edit"));
    settle(&mut [&mut a, &mut b]);
    set_member_role(&svc, &mut [&mut a, &mut b], Role::Editor);
    {
        let mut disk = a.disk.borrow_mut();
        let base = disk.known.get("a.md").copied();
        disk.files.remove("a.md");
        disk.user_write("b.md", Some("original"));
        let observation = disk.queued.last_mut().unwrap();
        observation.moved_from = Some("a.md".into());
        observation.base = base;
    }
    settle(&mut [&mut a, &mut b]);
    let id = b.r.list_holds(b.s).unwrap()[0].id;
    let error =
        b.r.resolve_hold(b.s, id, HoldResolution::KeepMine)
            .unwrap_err();
    assert_eq!(
        error.problem().reason.as_deref(),
        Some("concurrent_modification")
    );
    b.r.resolve_hold(b.s, id, HoldResolution::KeepBoth).unwrap();
    settle(&mut [&mut a, &mut b]);
    assert_eq!(a.file("b.md").as_deref(), Some("original"));
    assert_eq!(b.file("b.md").as_deref(), Some("original"));
    assert!(a.file("a.md").is_none());
    assert!(b.file("a.md").is_none());
}

#[test]
fn discarding_view_only_definition_moves_restores_the_original_after_restart() {
    use mdbn_wire::policy::Role;
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1);
    a.r.planner = Box::new(crate::plan::CorePlanner);
    settle(&mut [&mut a]);
    let source = "---\nkind: mdbase.type\nname: task\nschema:\n  dialect: json-schema-2020-12\n  value: {type: object}\n---\n";
    a.disk
        .borrow_mut()
        .user_write("_types/task.md", Some(source));
    settle(&mut [&mut a]);
    set_member_role(&svc, &mut [&mut a], Role::Viewer);
    for (from, to) in [
        ("_types/task.md", "_types/moved.md"),
        ("_types/moved.md", "_types/moved-again.md"),
    ] {
        let mut disk = a.disk.borrow_mut();
        let base = disk.known.get(from).copied();
        disk.files.remove(from);
        disk.user_write(to, Some(source));
        let observation = disk.queued.last_mut().unwrap();
        observation.moved_from = Some(from.into());
        observation.base = base;
        drop(disk);
        settle(&mut [&mut a]);
    }
    assert_eq!(a.r.list_holds(a.s).unwrap().len(), 3);
    assert_eq!(a.r.sync_status().pending, 0);
    let store = a.r.into_store();
    let mut a = reopen(&svc, 1, store, a.log, a.disk);
    for hold in a.r.list_holds(a.s).unwrap() {
        a.r.resolve_hold(a.s, hold.id, HoldResolution::TakeTheirs)
            .unwrap();
    }
    settle(&mut [&mut a]);
    assert_eq!(a.file("_types/task.md").as_deref(), Some(source));
    assert!(a.file("_types/moved.md").is_none());
    assert!(a.file("_types/moved-again.md").is_none());
    assert!(a.r.list_holds(a.s).unwrap().is_empty());
}

#[test]
fn moving_onto_a_read_only_hold_also_holds_the_source_after_upgrade() {
    use mdbn_wire::policy::Role;
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1);
    let mut b = node(&svc, 2);
    create(&mut a, 1, "source.md", "source");
    create(&mut a, 2, "target.md", "target");
    settle(&mut [&mut a, &mut b]);
    set_member_role(&svc, &mut [&mut a, &mut b], Role::Viewer);
    b.disk.borrow_mut().user_write("target.md", Some("viewer"));
    settle(&mut [&mut a, &mut b]);
    set_member_role(&svc, &mut [&mut a, &mut b], Role::Editor);
    move_file(&mut b, "source.md", "target.md", "source");
    settle(&mut [&mut a, &mut b]);
    assert_eq!(b.r.list_holds(b.s).unwrap().len(), 2);
    assert_eq!(b.r.sync_status().pending, 0);
    for hold in b.r.list_holds(b.s).unwrap() {
        b.r.resolve_hold(b.s, hold.id, HoldResolution::TakeTheirs)
            .unwrap();
    }
    settle(&mut [&mut a, &mut b]);
    assert_eq!(b.file("source.md").as_deref(), Some("source"));
    assert_eq!(b.file("target.md").as_deref(), Some("target"));
}

#[test]
fn discarding_a_viewer_move_does_not_delete_its_unmanaged_destination() {
    use mdbn_wire::policy::Role;
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1);
    create(&mut a, 1, "a.md", "original");
    settle(&mut [&mut a]);
    set_member_role(&svc, &mut [&mut a], Role::Viewer);
    move_file(&mut a, "a.md", ".private/a.md", "original");
    settle(&mut [&mut a]);
    let holds = a.r.list_holds(a.s).unwrap();
    assert_eq!(holds.len(), 1);
    assert_eq!(holds[0].path, "a.md");
    a.r.resolve_hold(a.s, holds[0].id, HoldResolution::TakeTheirs)
        .unwrap();
    settle(&mut [&mut a]);
    assert_eq!(a.file("a.md").as_deref(), Some("original"));
    assert_eq!(a.file(".private/a.md").as_deref(), Some("original"));
}

#[test]
fn viewer_case_only_rename_can_be_submitted_after_upgrade() {
    use mdbn_wire::policy::Role;
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1);
    let mut b = node(&svc, 2);
    create(&mut a, 1, "A.md", "original");
    settle(&mut [&mut a, &mut b]);
    set_member_role(&svc, &mut [&mut a, &mut b], Role::Viewer);
    move_file(&mut b, "A.md", "a.md", "original");
    settle(&mut [&mut a, &mut b]);
    let hold = b.r.list_holds(b.s).unwrap().remove(0);
    set_member_role(&svc, &mut [&mut a, &mut b], Role::Editor);
    b.r.resolve_hold(b.s, hold.id, HoldResolution::KeepMine)
        .unwrap();
    settle(&mut [&mut a, &mut b]);
    assert_eq!(a.file("a.md").as_deref(), Some("original"));
    assert!(a.file("A.md").is_none());
    assert!(b.r.list_holds(b.s).unwrap().is_empty());
}

#[test]
fn read_only_definition_submission_validates_before_releasing_the_hold() {
    use mdbn_wire::{
        client::{IncidentKind, ReceiptState},
        policy::Role,
    };
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1);
    a.r.planner = Box::new(crate::plan::CorePlanner);
    set_member_role(&svc, &mut [&mut a], Role::Viewer);
    a.disk
        .borrow_mut()
        .user_write("_types/task.md", Some("invalid type source"));
    settle(&mut [&mut a]);
    set_member_role(&svc, &mut [&mut a], Role::Editor);
    let id = a.r.list_holds(a.s).unwrap()[0].id;
    let receipt = a.r.resolve_hold(a.s, id, HoldResolution::KeepMine).unwrap();
    assert_eq!(receipt.state, ReceiptState::Rejected);
    assert_eq!(a.r.list_holds(a.s).unwrap().len(), 1);
    assert_eq!(a.r.sync_status().pending, 0);
    assert!(
        !a.r.sync_status()
            .incidents
            .iter()
            .any(|i| i.kind == IncidentKind::Integrity)
    );
    a.disk
        .borrow_mut()
        .user_write("_types/task.md", Some("---\nkind: mdbase.type\nname: task\nschema:\n  dialect: json-schema-2020-12\n  value: {type: object}\n---\n"));
    settle(&mut [&mut a]);
    let receipt = a.r.resolve_hold(a.s, id, HoldResolution::KeepMine).unwrap();
    assert_ne!(receipt.state, ReceiptState::Rejected);
    settle(&mut [&mut a]);
    assert!(a.r.list_holds(a.s).unwrap().is_empty());
    assert!(a.r.store().resource("_types/task.md").unwrap().is_some());
}

#[test]
fn viewer_saves_preserve_an_existing_conflict_hold() {
    use mdbn_wire::{client::HoldReason, policy::Role};
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1);
    let mut b = node(&svc, 2);
    create(&mut a, 1, "a.md", "base");
    settle(&mut [&mut a, &mut b]);
    a.disk.borrow_mut().user_write("a.md", Some("mine A"));
    b.disk.borrow_mut().user_write("a.md", Some("mine B"));
    a.step();
    b.step();
    settle(&mut [&mut a, &mut b]);
    set_member_role(&svc, &mut [&mut a, &mut b], Role::Viewer);
    let loser = if a.r.store().holds().unwrap().is_empty() {
        &mut b
    } else {
        &mut a
    };
    let before = loser.r.list_holds(loser.s).unwrap().remove(0);
    assert_eq!(before.reason, HoldReason::Conflict);
    loser
        .disk
        .borrow_mut()
        .user_write("a.md", Some("viewer save"));
    loser.step();
    let after = loser.r.list_holds(loser.s).unwrap().remove(0);
    assert_eq!(after.id, before.id);
    assert_eq!(after.reason, before.reason);
    assert_eq!(after.base, before.base);
    assert_eq!(after.theirs, before.theirs);
    assert_eq!(after.saves, before.saves + 1);
    assert_eq!(loser.r.sync_status().pending, 0);
}

#[test]
fn concurrent_disk_edits_hold_the_loser() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1);
    let mut b = node(&svc, 2);
    create(&mut a, 1, "a.md", "base");
    settle(&mut [&mut a, &mut b]);
    a.disk.borrow_mut().user_write("a.md", Some("mine A"));
    b.disk.borrow_mut().user_write("a.md", Some("mine B"));
    a.step();
    b.step();
    settle(&mut [&mut a, &mut b]);
    assert_eq!(a.r.head(), b.r.head());
    let held_a = a.r.list_holds(a.s).unwrap();
    let held_b = b.r.list_holds(b.s).unwrap();
    assert_eq!(held_a.len() + held_b.len(), 1, "exactly the loser is held");
    let (loser, mine) = if held_a.is_empty() {
        (&mut b, "mine B")
    } else {
        (&mut a, "mine A")
    };
    assert_eq!(
        loser.file("a.md").as_deref(),
        Some(mine),
        "the user's bytes are kept"
    );
    // Later saves are collected into the hold.
    loser
        .disk
        .borrow_mut()
        .user_write("a.md", Some("mine again"));
    loser.step();
    let h = loser.r.list_holds(loser.s).unwrap();
    assert_eq!(h[0].saves, 2);
    // Keep mine: it propagates.
    let id = h[0].id;
    loser
        .r
        .resolve_hold(loser.s, id, HoldResolution::KeepMine)
        .unwrap();
    settle(&mut [&mut a, &mut b]);
    assert_eq!(a.file("a.md").as_deref(), Some("mine again"));
    assert_eq!(b.file("a.md").as_deref(), Some("mine again"));
    assert!(a.r.list_holds(a.s).unwrap().is_empty() && b.r.list_holds(b.s).unwrap().is_empty());
}

/// A hold decision settles the conflict it came from on every replica (the
/// dismissal is logged with the decision), and a kept copy is named after the
/// host's computer label.
#[test]
fn resolving_a_hold_dismisses_its_conflicts_everywhere() {
    for how in [
        HoldResolution::KeepMine,
        HoldResolution::TakeTheirs,
        HoldResolution::KeepBoth,
    ] {
        let svc = FakeLogService::new();
        let mut a = node(&svc, 1);
        let mut b = node(&svc, 2);
        a.r.set_conflict_label("Callum's laptop/2");
        b.r.set_conflict_label("Callum's laptop/2");
        create(&mut a, 1, "a.md", "base");
        settle(&mut [&mut a, &mut b]);
        a.disk.borrow_mut().user_write("a.md", Some("mine A"));
        b.disk.borrow_mut().user_write("a.md", Some("mine B"));
        a.step();
        b.step();
        settle(&mut [&mut a, &mut b]);
        let loser = if a.r.list_holds(a.s).unwrap().is_empty() {
            &mut b
        } else {
            &mut a
        };
        let id = loser.r.list_holds(loser.s).unwrap()[0].id;
        assert!(
            !loser.r.list_conflicts(loser.s, None).unwrap().is_empty(),
            "the held edit recorded a conflict"
        );
        loser.r.resolve_hold(loser.s, id, how.clone()).unwrap();
        settle(&mut [&mut a, &mut b]);
        for n in [&mut a, &mut b] {
            assert!(n.r.list_holds(n.s).unwrap().is_empty(), "{how:?}");
            assert!(
                n.r.list_conflicts(n.s, None).unwrap().is_empty(),
                "{how:?}: no replica lists the decided conflict"
            );
        }
        if matches!(how, HoldResolution::KeepBoth) {
            let copies: Vec<String> = a
                .disk
                .borrow()
                .files
                .keys()
                .filter(|p| p.starts_with("a (conflict "))
                .cloned()
                .collect();
            assert_eq!(copies.len(), 1, "{copies:?}");
            assert!(
                copies[0].starts_with("a (conflict Callum's laptop-2 "),
                "{copies:?}"
            );
        }
    }
}

#[test]
fn restart_reconciles_unpublished_changes() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1);
    let mut b = node(&svc, 2);
    create(&mut a, 1, "a.md", "one");
    settle(&mut [&mut a, &mut b]);
    assert_eq!(b.file("a.md").as_deref(), Some("one"));
    // B "crashes" after committing A's next change but before publishing it.
    a.disk.borrow_mut().user_write("a.md", Some("two"));
    b.disk.borrow_mut().drop_publishes = 1;
    settle(&mut [&mut a, &mut b]);
    assert_eq!(b.file("a.md").as_deref(), Some("one"), "publish was lost");
    // Restart B over the same store and disk.
    let Node {
        r, log, s: _, disk, ..
    } = b;
    let store = r.into_store();
    let mut b2 = reopen(&svc, 2, store, log, disk);
    settle(&mut [&mut a, &mut b2]);
    assert_eq!(
        b2.file("a.md").as_deref(),
        Some("two"),
        "reconciled at open"
    );
}

#[test]
fn restart_completes_an_interrupted_move() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1);
    create(&mut a, 1, "old.md", "x");
    settle(&mut [&mut a]);
    // The move's create half never happened; the source is still there.
    a.disk.borrow_mut().drop_publishes = 1;
    a.disk.borrow_mut().user_write("old.md", None);
    {
        let mut d = a.disk.borrow_mut();
        d.files.insert("old.md".into(), "x".into());
        d.queued.clear();
    }
    let Node {
        r, log, s: _, disk, ..
    } = a;
    // Simulate the confirmed move directly in the store: record 1 now lives at new.md.
    let mut store = r.into_store();
    let mut row = store.record(&B16([1; 16])).unwrap().unwrap();
    row.path = "new.md".into();
    row.path_key = "new.md".into();
    store
        .commit(Tx {
            records_put: vec![row],
            ..Tx::default()
        })
        .unwrap();
    disk.borrow_mut().drop_publishes = 0;
    let a2 = reopen(&svc, 1, store, log, disk);
    assert_eq!(a2.file("new.md").as_deref(), Some("x"), "target created");
    assert!(a2.file("old.md").is_none(), "stray source removed");
}

fn reopen(
    svc: &FakeLogService,
    n: u8,
    store: DiskStore,
    log: FakeLog,
    disk: Rc<RefCell<Disk>>,
) -> Node {
    let _ = svc;
    let clock = Rc::new(Cell::new(1_700_000_100_000));
    let cfg = ReplicaConfig {
        collection: COL,
        replica_id: B16([n; 16]),
        device_id: B16([n + 100; 16]),
        mode: mdbn_wire::client::SyncMode::Synced,
        log_endpoint: EndpointId(1),
        verify: false,
        runtime_version: "test".into(),
        trusted_roots: vec![crate::testkit::TEST_ROOT],
        e2e: false,
        trusted_signers: (101..=109u8).map(|d| B16([d; 16])).collect(),
        user_enabled_cloud_copy: false,
        chosen_state: None,
        key_grants_only: false,
        expected_genesis: None,
        policy_pins: None,
    };
    if svc.head(&COL).0 == 0 {
        let devs: Vec<B16> = (101..=109u8).map(|d| B16([d; 16])).collect();
        crate::testkit::TestControlPlane::new(COL).bootstrap(
            svc,
            mdbn_wire::policy::CState::E2e,
            &devs,
        );
    }
    let host = Host {
        clock: Box::new(TestClock(clock.clone())),
        entropy: Box::new(crate::crypto::TestEntropy::new(n + 77)),
        zones: Box::new(UtcOnly),
    };
    let mut r = Replica::open(
        cfg,
        store,
        Box::new(TestPlanner),
        Box::new(PlainSealer::for_device(B16([n + 100; 16]))),
        host,
        DeviceSecrets {
            sign_sk: [n; 32],
            kem_sk: [n; 32],
        },
    )
    .unwrap();
    let (s, _) = r
        .hello(
            SessionAuth::Host,
            HelloParams {
                versions: vec![Version { major: 1, minor: 0 }],
                client_name: "t".into(),
                client_version: "0".into(),
                features: None,
                timezone: None,
            },
        )
        .unwrap();
    Node {
        r,
        log,
        s,
        disk,
        clock,
    }
}

/// `receipt.published`: a store that publishes inside `commit` reports the write
/// published at once; a deferred store reports `publishing` until the host has
/// completed the file operations, then pushes the receipt with `published`.
#[test]
fn receipts_report_when_bytes_are_in_the_file() {
    use mdbn_wire::client::{PublishState, ReceiptState};
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1);
    let r = create(&mut a, 1, "a.md", "one");
    assert_eq!(r.published, Some(PublishState::Published));

    a.disk.borrow_mut().defer = true;
    let r = create(&mut a, 2, "b.md", "two");
    assert_eq!(r.state, ReceiptState::Pending);
    assert_eq!(r.published, Some(PublishState::Publishing));
    assert_eq!(a.file("b.md"), None);
    let mid = r.mutation;
    assert_eq!(
        a.r.receipt(a.s, mid).unwrap().published,
        Some(PublishState::Publishing)
    );
    a.r.take_pushes();
    a.disk.borrow_mut().complete();
    a.r.on_store_progress();
    assert_eq!(a.file("b.md").as_deref(), Some("two"));
    let pushes = a.r.take_pushes();
    assert!(
        pushes.iter().any(|(s, p)| *s == a.s
            && matches!(p, crate::api::Push::Receipt(r)
                if r.mutation == mid && r.published == Some(PublishState::Published))),
        "{pushes:?}"
    );
    assert_eq!(
        a.r.receipt(a.s, mid).unwrap().published,
        Some(PublishState::Published)
    );

    // The user edits the file before the deferred publish lands: not published.
    let r = create(&mut a, 3, "c.md", "three");
    a.disk
        .borrow_mut()
        .files
        .insert("c.md".into(), "mine".into());
    a.disk.borrow_mut().complete();
    a.r.on_store_progress();
    assert_eq!(
        a.r.receipt(a.s, r.mutation).unwrap().published,
        Some(PublishState::NotPublished)
    );
    assert_eq!(a.file("c.md").as_deref(), Some("mine"));
}

/// Publication completion follows current receipt ownership, not a disconnected
/// original submitter. The durable outcome stays independently pollable.
#[test]
fn receipt_fanout_publication_completion_after_reconnect() {
    use mdbn_wire::client::PublishState;
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1);
    a.disk.borrow_mut().defer = true;
    let receipt = create(&mut a, 1, "reconnected.md", "one");
    assert_eq!(receipt.published, Some(PublishState::Publishing));
    let old = a.s;
    a.r.close(old);
    let (fresh, _) =
        a.r.hello(
            SessionAuth::Host,
            HelloParams {
                versions: vec![Version { major: 1, minor: 0 }],
                client_name: "reconnected".into(),
                client_version: "0".into(),
                features: None,
                timezone: None,
            },
        )
        .unwrap();
    a.r.take_pushes();
    a.disk.borrow_mut().complete();
    a.r.on_store_progress();
    let pushes = a.r.take_pushes();
    assert!(pushes.iter().any(|(s, p)| *s == fresh
        && matches!(p, crate::api::Push::Receipt(r)
        if r.mutation == receipt.mutation && r.published == Some(PublishState::Published))));
    assert!(pushes.iter().all(|(s, _)| *s != old));
    assert_eq!(
        a.r.receipt(fresh, receipt.mutation).unwrap().published,
        Some(PublishState::Published)
    );
}

/// A deferred publish the store never reports ends as `not_published` after the
/// wait cap, and nothing is left waiting (the table stays bounded).
#[test]
fn unreported_publishes_expire() {
    use mdbn_wire::client::PublishState;
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1);
    a.disk.borrow_mut().defer = true;
    let r = create(&mut a, 1, "a.md", "one");
    assert_eq!(r.published, Some(PublishState::Publishing));
    a.r.close(a.s);
    let (s2, _) =
        a.r.hello(
            SessionAuth::Host,
            HelloParams {
                versions: vec![Version { major: 1, minor: 0 }],
                client_name: "t".into(),
                client_version: "0".into(),
                features: None,
                timezone: None,
            },
        )
        .unwrap();
    a.r.tick();
    assert_eq!(
        a.r.receipt(s2, r.mutation).unwrap().published,
        Some(PublishState::Publishing)
    );
    a.clock
        .set(a.clock.get() + crate::replica::PUBLISH_WAIT_MS as u64);
    a.r.tick();
    assert_eq!(
        a.r.receipt(s2, r.mutation).unwrap().published,
        Some(PublishState::NotPublished)
    );
    assert_eq!(a.r.publish_waits_open(), 0);
    // The batch reported late changes nothing, including transient drift retries.
    a.disk.borrow_mut().complete();
    a.disk.borrow_mut().results.push(PublishResult {
        batch: PublishBatch(u64::MAX),
        drifts: vec![Drift {
            publish: Publish::Write {
                id: Some(B16([1; 16])),
                path: "a.md".into(),
                expect: Expect::Absent,
                content: Content::Text("stale".into()),
            },
            reason: "locked".into(),
        }],
    });
    a.r.on_store_progress();
    assert_eq!(a.r.publish_waits_open(), 0);
    assert_eq!(
        a.r.receipt(s2, r.mutation).unwrap().published,
        Some(PublishState::NotPublished)
    );
    let attempts = a.disk.borrow().publish_attempts;
    a.r.tick();
    assert_eq!(
        a.disk.borrow().publish_attempts,
        attempts,
        "unknown batches must not schedule a stale publish retry"
    );
}

/// Local-only collections: no log; writes publish and confirm without log seq.
#[test]
fn local_only_commits_to_files() {
    use crate::api::Push;
    use mdbn_wire::client::{ReceiptState, SyncMode};
    let svc = FakeLogService::new();
    let mut a = node_mode(&svc, 1, SyncMode::LocalOnly);
    create(&mut a, 1, "a.md", "one");
    assert_eq!(a.file("a.md").as_deref(), Some("one"));
    let pushes = a.r.take_pushes();
    assert!(pushes.iter().any(|(_, p)| matches!(p, Push::Receipt(r) if r.state == ReceiptState::Confirmed && r.seq.is_none())), "{pushes:?}");
    assert_eq!(svc.head(&COL).0, 0, "nothing reaches a log");
    assert!(crate::log::LogPort::take_log_calls(&mut a.r).is_empty());
    let st = a.r.sync_status();
    assert_eq!(
        (st.mode, st.confirmed_through, st.pending),
        (SyncMode::LocalOnly, 0, 0)
    );
    a.disk.borrow_mut().user_write("a.md", Some("two"));
    a.r.observe(None).unwrap();
    assert_eq!(
        crate::Store::record(a.r.store(), &B16([1; 16]))
            .unwrap()
            .unwrap()
            .doc,
        "two"
    );
    assert_eq!(a.r.sync_status().pending, 0);
    create(&mut a, 2, "b.md", "x");
    a.disk.borrow_mut().user_write("c.md", Some("outside"));
    a.r.observe(None).unwrap();
    assert!(a.file("c.md").is_some());
}

#[test]
fn synced_batched_ingest_reads_only_matching_pending_rows() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1);
    const RECORDS: u64 = 4000;
    for i in 0..RECORDS {
        a.disk
            .borrow_mut()
            .user_write(&format!("bulk-{i}.md"), Some("bulk"));
    }
    let mut queued = std::collections::VecDeque::from(a.r.observe_changes().unwrap());
    let holds_before = a.disk.borrow().holds_reads;
    while !queued.is_empty() {
        let batch = queued.drain(..queued.len().min(32)).collect();
        a.r.ingest(batch);
    }
    assert_eq!(a.r.sync_status().pending, RECORDS);
    assert!(
        a.disk.borrow().pending_rows_read <= RECORDS * 8,
        "batched publication must not repeatedly scan the growing pending queue"
    );
    assert_eq!(a.disk.borrow().acknowledged, RECORDS);
    let holds_reads = a.disk.borrow().holds_reads - holds_before;
    assert!(
        holds_reads <= 2 * RECORDS.div_ceil(32) + 1,
        "Viewer partition and publication each read holds once per batch, plus final status: {holds_reads}"
    );
}

#[test]
fn captured_queue_stays_owned_until_apply_recovery_allows_ingest() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1);
    for i in 0..4000 {
        a.disk
            .borrow_mut()
            .user_write(&format!("retained/{i}.md"), Some("user edit"));
    }
    let mut captured: std::collections::VecDeque<_> = a.r.observe_changes().unwrap().into();
    assert_eq!(captured.len(), 4000);
    a.r.apply_blocked = Some(a.r.head.seq + 1);
    assert!(!a.r.ingest_ready());
    assert_eq!(a.disk.borrow().acknowledged, 0);
    a.r.apply_blocked = None;
    assert!(a.r.ingest_ready());
    while !captured.is_empty() {
        a.r.ingest(captured.drain(..captured.len().min(64)).collect());
    }
    assert_eq!(a.disk.borrow().acknowledged, 4000);
    assert_eq!(a.r.sync_status().pending, 4000);
}

#[test]
fn captured_observations_are_reoffered_after_apply_recovery() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1);
    a.disk
        .borrow_mut()
        .user_write("retained.md", Some("user edit"));
    let captured = a.r.observe_changes().unwrap();
    assert_eq!(captured.len(), 1);
    a.r.apply_blocked = Some(a.r.head.seq + 1);
    a.r.ingest(captured.clone());
    assert_eq!(a.disk.borrow().acknowledged, 0);
    a.r.apply_blocked = None;
    let reoffered = a.r.observe_changes().unwrap();
    assert_eq!(
        reoffered, captured,
        "recovery retains the original observation token"
    );
    a.r.ingest(reoffered);
    assert_eq!(a.disk.borrow().acknowledged, 1);
    assert_eq!(a.r.sync_status().pending, 1);
}

#[test]
fn captured_scan_can_be_ingested_between_status_observations() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1);
    for i in 0..4000 {
        a.disk
            .borrow_mut()
            .user_write(&format!("bulk-{i}.md"), Some("bulk"));
    }
    let mut observations = a.r.observe_changes().unwrap();
    assert_eq!(observations.len(), 4000);
    let batch = observations.drain(..32).collect();
    a.r.ingest(batch);
    assert_eq!(a.r.sync_status().pending, 32);
    assert_eq!(observations.len(), 3968);
    assert_eq!(
        a.disk.borrow().acknowledged,
        32,
        "remaining observations retain original store ownership"
    );
}

/// A cold scan must not leave an invisible timer-driven confirmation backlog.
/// Counters bound work deterministically instead of asserting wall-clock speed.
#[test]
fn local_cold_scan_drains_in_bounded_prefixes_and_next_write_confirms() {
    use crate::api::Push;
    use mdbn_wire::client::{ReceiptState, SyncMode};
    let svc = FakeLogService::new();
    let mut a = node_mode(&svc, 1, SyncMode::LocalOnly);
    const RECORDS: u64 = 193;
    for i in 0..RECORDS {
        a.disk
            .borrow_mut()
            .user_write(&format!("scan-{i}.md"), Some("cold"));
    }
    let initial_commits = a.r.store().inner.data().borrow().commits;
    a.r.observe(None).unwrap();
    assert!(
        a.r.store().inner.data().borrow().commits - initial_commits <= 2 * RECORDS.div_ceil(64),
        "batch capture and apply, not a durable transaction per file"
    );
    assert_eq!(
        a.r.store().pending_count().unwrap(),
        0,
        "cold scan must finish confirmation before returning"
    );
    assert_eq!(a.r.store().record_count().unwrap(), RECORDS);
    assert_eq!(a.disk.borrow().acknowledged, RECORDS);
    {
        let data = a.r.store().inner.data();
        let d = data.borrow();
        assert!(!d.deferred, "the ingest round ends with a barrier");
        assert!(
            d.windows.0 >= 1,
            "new external documents commit in a window"
        );
        assert_eq!(d.windows.0, d.windows.1, "every window is closed");
    }
    assert!(
        a.disk.borrow().max_pending <= 64,
        "ingest must bound the speculative layer"
    );
    assert!(
        a.disk.borrow().pending_rows_read <= RECORDS * 2,
        "do not repeatedly rebuild a shrinking whole backlog"
    );
    a.r.take_pushes();
    create(&mut a, 240, "after-scan.md", "new");
    assert_eq!(a.file("after-scan.md").as_deref(), Some("new"));
    assert_eq!(a.r.store().pending_count().unwrap(), 0);
    assert!(a.r.take_pushes().iter().any(|(_, p)| matches!(p, Push::Receipt(r) if r.state == ReceiptState::Confirmed && r.seq.is_none())));
    assert!(crate::log::LogPort::take_log_calls(&mut a.r).is_empty());
    let reads = a.disk.borrow().pending_rows_read;
    let commits = a.r.store().inner.data().borrow().commits;
    for _ in 0..3 {
        a.r.observe(None).unwrap();
        a.r.tick();
    }
    assert_eq!(
        a.disk.borrow().pending_rows_read,
        reads,
        "idle polling has no pending rows to rebuild"
    );
    assert_eq!(a.r.store().inner.data().borrow().commits, commits);
}

#[test]
fn local_scan_groups_are_bounded_by_text_bytes_as_well_as_count() {
    let svc = FakeLogService::new();
    let mut a = node_mode(&svc, 1, mdbn_wire::client::SyncMode::LocalOnly);
    let text = "x".repeat(128 * 1024);
    for i in 0..3 {
        a.disk
            .borrow_mut()
            .user_write(&format!("large-{i}.md"), Some(&text));
    }
    a.r.observe(None).unwrap();
    assert_eq!(
        a.r.head().seq,
        2,
        "256KiB text budget splits the third document into a new group"
    );
    assert_eq!(a.r.store().record_count().unwrap(), 3);
    assert_eq!(a.r.store().pending_count().unwrap(), 0);
    assert_eq!(a.disk.borrow().acknowledged, 3);
    for i in 0..3 {
        assert_eq!(
            a.file(&format!("large-{i}.md")).as_deref(),
            Some(text.as_str())
        );
    }
}

#[test]
fn local_scan_capture_abort_requires_reopen_and_acks_no_evidence() {
    let svc = FakeLogService::new();
    let mut a = node_mode(&svc, 1, mdbn_wire::client::SyncMode::LocalOnly);
    for i in 0..65 {
        a.disk
            .borrow_mut()
            .user_write(&format!("abort-{i}.md"), Some("cold"));
    }
    a.r.store().inner.fail_commits(1);
    a.r.observe(None).unwrap();
    assert!(
        a.r.requires_reopen(),
        "no durable pending row exists to retry a failed capture"
    );
    assert_eq!(a.disk.borrow().acknowledged, 0);
    assert_eq!(a.r.store().pending_count().unwrap(), 0);
    assert_eq!(a.r.store().record_count().unwrap(), 0);
    let commits = a.r.store().inner.data().borrow().commits;
    a.r.tick();
    assert!(a.r.observe(None).is_err());
    assert_eq!(a.r.store().inner.data().borrow().commits, commits);
}

#[test]
fn local_scan_fault_stops_before_acknowledging_the_next_prefix() {
    let svc = FakeLogService::new();
    let mut a = node_mode(&svc, 1, mdbn_wire::client::SyncMode::LocalOnly);
    for i in 0..193 {
        a.disk
            .borrow_mut()
            .user_write(&format!("fault-{i}.md"), Some("cold"));
    }
    a.r.store().inner.fail_after_head_commit(1);
    a.r.observe(None).unwrap();
    assert!(a.r.requires_reopen());
    assert_eq!(
        a.disk.borrow().acknowledged,
        64,
        "a failed prefix cannot consume later observation evidence"
    );
    let commits = a.r.store().inner.data().borrow().commits;
    a.r.tick();
    assert!(a.r.observe(None).is_err());
    assert_eq!(a.r.store().inner.data().borrow().commits, commits);
    assert!(
        a.r.take_pushes()
            .iter()
            .all(|(_, p)| matches!(p, crate::api::Push::Closed(_)))
    );
}

/// Host grants are rechecked at submit/commit; revocation closes sessions.
/// The identity below is an explicit synthetic trusted-host fixture, not a
/// daemon pairing or persisted ownership acceptance proof.
#[test]
fn local_only_grants_come_from_the_host() {
    use crate::policy::{EffectiveGrant, GrantSource, LocalOwnerIdentity, capability};
    use mdbn_wire::client::ReceiptState;
    use std::collections::BTreeSet;
    #[derive(Clone, Default)]
    struct Access(Rc<RefCell<BTreeMap<Uuid, EffectiveGrant>>>);
    impl GrantSource for Access {
        fn grant(&self, g: &Uuid) -> Option<EffectiveGrant> {
            self.0.borrow().get(g).cloned()
        }
        fn owner_identity(&self) -> Option<LocalOwnerIdentity> {
            Some(LocalOwnerIdentity {
                account: B16([0x62; 16]),
                collection: COL,
                device: B16([101; 16]),
            })
        }
        fn active_account(&self) -> Option<Uuid> {
            Some(B16([0x62; 16]))
        }
    }
    let gid = B16([0x55; 16]);
    let pk = [0x57; 32];
    let auth = SessionAuth::Grant {
        grant: gid,
        client_pk: pk,
    };
    let hello = |a: &mut Node| {
        a.r.hello(
            auth.clone(),
            HelloParams {
                versions: vec![Version { major: 1, minor: 0 }],
                client_name: "app".into(),
                client_version: "0".into(),
                features: None,
                timezone: None,
            },
        )
        .map(|(s, _)| s)
    };
    let svc = FakeLogService::new();
    let mut a = node_mode(&svc, 1, mdbn_wire::client::SyncMode::LocalOnly);
    assert!(
        hello(&mut a).is_err(),
        "no grant source: no granted sessions"
    );
    let access = Access::default();
    access.0.borrow_mut().insert(
        gid,
        EffectiveGrant {
            account: B16([0x62; 16]),
            role: mdbn_wire::policy::Role::Editor,
            capabilities: [capability::READ, capability::CREATE]
                .iter()
                .map(|c| c.to_string())
                .collect::<BTreeSet<_>>(),
            file_folders: None,
            client_pk: mdbn_wire::common::B32(pk),
        },
    );
    a.r.set_grant_source(Box::new(access.clone()));
    let s = hello(&mut a).expect("granted session");
    let submit = |a: &mut Node, id: u8, path: &str| {
        a.r.submit(
            s,
            SubmitParams {
                ops: vec![Op::Create(Create {
                    id: B16([id; 16]),
                    path: Some(path.into()),
                    type_name: None,
                    frontmatter: None,
                    body: None,
                    document: Some(Text::Inline("x".into())),
                })],
                mutation_id: None,
                conflict_mode: None,
                timezone: None,
                allow_partial: None,
                mutation_ids: None,
                dry_run: None,
                include: None,
                wait: None,
            },
        )
    };
    let r = submit(&mut a, 1, "one.md").unwrap().remove(0);
    settle(&mut [&mut a]);
    assert_eq!(
        a.r.receipt(s, r.mutation).unwrap().state,
        ReceiptState::Confirmed
    );
    assert_eq!(a.file("one.md").as_deref(), Some("x"));
    access
        .0
        .borrow_mut()
        .get_mut(&gid)
        .unwrap()
        .capabilities
        .remove(capability::CREATE);
    let mut m = a.r.capture(
        vec![Op::Create(Create {
            id: B16([2; 16]),
            path: Some("two.md".into()),
            type_name: None,
            frontmatter: None,
            body: None,
            document: Some(Text::Inline("x".into())),
        })],
        mdbn_wire::intent::Source::Api,
    );
    m.on_behalf = Some(gid);
    let mid = m.id;
    a.r.store_mut()
        .commit(Tx {
            pending_put: vec![PendingRow {
                order: 1000,
                mutation: m.into(),
                effects: Vec::new(),
                touches: Vec::new(),
                grant: Some(gid),
                uploads: Vec::new(),
                refs: Vec::new(),
            }],
            ..Tx::default()
        })
        .unwrap();
    settle(&mut [&mut a]);
    assert_eq!(a.r.receipt(s, mid).unwrap().state, ReceiptState::Rejected);
    assert_eq!(a.file("two.md"), None);
    assert!(
        submit(&mut a, 3, "three.md").is_err(),
        "refused at submit now"
    );
    a.r.take_pushes();
    access.0.borrow_mut().clear();
    a.r.grants_changed();
    assert!(
        a.r.take_pushes()
            .iter()
            .any(|(x, p)| *x == s && matches!(p, crate::api::Push::Closed(_)))
    );
}

#[test]
fn queued_publication_model_resource_path_uses_the_complete_core_registry() {
    // A model of the shared Replica queued-publication contract, not the actual
    // Obsidian async FileStore driver, executed WASM or browser durability.
    use mdbn_wire::client::SyncMode;
    let svc = FakeLogService::new();
    let mut a = node_mode(&svc, 1, SyncMode::LocalOnly);
    a.r.planner = Box::new(crate::plan::CorePlanner);
    a.disk.borrow_mut().defer = true;
    let bundle: serde_json::Value = serde_json::from_str(include_str!(
        "../../../local-host/tests/fixtures/reader-semantic-digests/bundle.json"
    ))
    .unwrap();
    for r in bundle["resources"].as_array().unwrap() {
        a.disk
            .borrow_mut()
            .user_write(r["path"].as_str().unwrap(), r["document"].as_str());
    }
    a.r.observe(None).unwrap();
    a.disk.borrow_mut().complete();
    a.r.tick();
    let session = a.s;
    assert_eq!(a.r.describe(session).unwrap().contracts.len(), 3);
    for r in bundle["resources"].as_array().unwrap() {
        let path = r["path"].as_str().unwrap();
        let source = r["document"].as_str().unwrap();
        let actual = a.r.get_resource(session, path.into()).unwrap();
        assert!(actual.confirmed);
        assert_eq!(actual.text, source);
        assert_eq!(a.file(path).as_deref(), Some(source));
    }
}

#[test]
fn retained_resource_ingestion_model_waits_at_source_complete_set_and_currentness_without_recapture()
 {
    // Core/Replica + toy disk/publication model ONLY, not physical FileStore,
    // TS HostLoop, executed WASM, Obsidian or durability qualification.
    let svc = FakeLogService::new();
    let mut a = node_mode(&svc, 1, mdbn_wire::client::SyncMode::LocalOnly);
    a.r.planner = Box::new(crate::plan::CorePlanner);
    let bundle: serde_json::Value = serde_json::from_str(include_str!(
        "../../../local-host/tests/fixtures/reader-semantic-digests/bundle.json"
    ))
    .unwrap();
    for r in bundle["resources"].as_array().unwrap() {
        a.disk
            .borrow_mut()
            .user_write(r["path"].as_str().unwrap(), r["document"].as_str());
    }
    assert_eq!(a.disk.borrow().queued.len(), 8);
    let original_tokens = a
        .disk
        .borrow()
        .queued
        .iter()
        .map(|o| o.token)
        .collect::<std::collections::BTreeSet<_>>();
    {
        let mut d = a.disk.borrow_mut();
        d.defer = true;
        d.source_paused = true;
        d.complete_paused = true;
        d.current_paused = true;
    }
    let mut future = Box::pin(a.r.observe_async(None));
    let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
    for _ in 0..4 {
        assert!(std::future::Future::poll(future.as_mut(), &mut cx).is_pending());
        let d = a.disk.borrow();
        assert_eq!(d.observe_calls, 1);
        assert_eq!(d.source_started.len(), 1);
        assert_eq!(d.acknowledged, 0);
        assert_eq!(d.publish_attempts, 0);
    }
    a.disk.borrow_mut().source_paused = false;
    for _ in 0..4 {
        assert!(std::future::Future::poll(future.as_mut(), &mut cx).is_pending());
        let d = a.disk.borrow();
        assert_eq!(d.complete_started, 1);
        // Native bootstrap checks configuration first, then its resource-path
        // inclusion again with the definitions. That is nine deliberate reads,
        // not a restarted pending future. Keep the EXACT native ordered trace.
        assert_eq!(
            d.source_started,
            vec![
                ObservationId(7),
                ObservationId(1),
                ObservationId(2),
                ObservationId(3),
                ObservationId(4),
                ObservationId(5),
                ObservationId(6),
                ObservationId(7),
                ObservationId(8)
            ]
        );
        assert_eq!(d.acknowledged, 0);
        assert_eq!(d.publish_attempts, 0);
    }
    a.disk.borrow_mut().complete_paused = false;
    for _ in 0..4 {
        assert!(std::future::Future::poll(future.as_mut(), &mut cx).is_pending());
        let d = a.disk.borrow();
        assert_eq!(d.current_started.len(), 1);
        assert_eq!(d.acknowledged, 0);
        assert_eq!(d.publish_attempts, 0);
    }
    a.disk.borrow_mut().current_paused = false;
    assert!(matches!(
        std::future::Future::poll(future.as_mut(), &mut cx),
        std::task::Poll::Ready(Ok(()))
    ));
    drop(future);
    let d = a.disk.borrow();
    assert_eq!(d.observe_calls, 1);
    assert_eq!(d.acknowledged, 8);
    assert_eq!(
        d.source_started
            .iter()
            .copied()
            .collect::<std::collections::BTreeSet<_>>(),
        original_tokens
    );
    assert_eq!(
        d.current_started
            .iter()
            .copied()
            .collect::<std::collections::BTreeSet<_>>(),
        original_tokens
    );
    assert_eq!(d.next, 8, "no observation token remint");
    assert!(
        d.deferred.len() <= 1,
        "one original resource capture/publication batch"
    );
    drop(d);
    a.disk.borrow_mut().complete();
    a.r.tick();
    assert_eq!(a.r.describe(a.s).unwrap().contracts.len(), 3);
    for r in bundle["resources"].as_array().unwrap() {
        let actual =
            a.r.get_resource(a.s, r["path"].as_str().unwrap().into())
                .unwrap();
        assert!(actual.confirmed);
        assert_eq!(actual.text, r["document"].as_str().unwrap());
    }
}

#[test]
fn retained_resource_ingestion_model_refuses_source_changed_while_currentness_is_pending() {
    let svc = FakeLogService::new();
    let mut a = node_mode(&svc, 1, mdbn_wire::client::SyncMode::LocalOnly);
    a.r.planner = Box::new(crate::plan::CorePlanner);
    a.disk
        .borrow_mut()
        .user_write("mdbase.yaml", Some("spec_version: \"0.3.0\"\n"));
    a.disk.borrow_mut().current_paused = true;
    {
        let mut future = std::pin::pin!(a.r.observe_async(None));
        let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
        for _ in 0..3 {
            assert!(std::future::Future::poll(future.as_mut(), &mut cx).is_pending());
            assert_eq!(a.disk.borrow().current_started, vec![ObservationId(1)]);
            assert_eq!(a.disk.borrow().acknowledged, 0);
        }
        a.disk.borrow_mut().files.insert(
            "mdbase.yaml".into(),
            "changed outside original evidence".into(),
        );
        a.disk.borrow_mut().current_paused = false;
        assert!(matches!(
            std::future::Future::poll(future.as_mut(), &mut cx),
            std::task::Poll::Ready(Ok(()))
        ));
    }
    assert_eq!(a.disk.borrow().acknowledged, 0);
    assert_eq!(a.disk.borrow().next, 1);
    assert_eq!(a.disk.borrow().publish_attempts, 0);
    assert!(a.r.store().resources().unwrap().is_empty());
    assert!(a.r.store().pending(None, 64).unwrap().is_empty());
}

#[test]
fn local_cold_scan_ingests_configuration_and_types_before_records() {
    use mdbn_wire::client::SyncMode;
    let svc = FakeLogService::new();
    let mut a = node_mode(&svc, 1, SyncMode::LocalOnly);
    a.r.planner = Box::new(crate::plan::CorePlanner);
    // Capitalised folders sort before `_types/`, and `mdbase.yaml` last.
    for i in 0..5 {
        a.disk
            .borrow_mut()
            .user_write(&format!("Tasks/t{i}.md"), Some("---\nstatus: open\n---\n"));
    }
    a.disk.borrow_mut().user_write(
        "_types/task.md",
        Some("---\nkind: mdbase.type\nname: task\nmatch:\n  path_glob: \"Tasks/**/*.md\"\nschema:\n  dialect: json-schema-2020-12\n  value: {type: object}\n---\n"),
    );
    a.disk
        .borrow_mut()
        .user_write("mdbase.yaml", Some("spec_version: \"0.3.0\"\n"));
    a.r.observe(None).unwrap();
    assert_eq!(a.r.store().record_count().unwrap(), 5);
    let id = a.r.store().record_at("tasks/t3.md").unwrap().unwrap();
    let rec = a.r.store().record(&id).unwrap().unwrap();
    assert_eq!(rec.meta.types, vec!["task".to_string()]);
    assert_eq!(
        a.r.stats.reindexed, 0,
        "records are typed once, not re-typed"
    );
}

#[test]
fn local_cold_scan_barrier_failure_fences_without_pushes() {
    use mdbn_wire::client::SyncMode;
    let svc = FakeLogService::new();
    let mut a = node_mode(&svc, 1, SyncMode::LocalOnly);
    for i in 0..10 {
        a.disk
            .borrow_mut()
            .user_write(&format!("scan-{i}.md"), Some("cold"));
    }
    a.r.take_pushes();
    a.r.store_mut().barrier_fails = true;
    a.r.observe(None).unwrap();
    assert!(
        a.r.requires_reopen(),
        "an unknown barrier outcome needs a reopen, not a retry"
    );
    assert!(
        a.r.take_pushes()
            .iter()
            .all(|(_, p)| !matches!(p, crate::api::Push::Changes(_))),
        "nothing derived from the window is pushed"
    );
    // Nothing more is captured or acknowledged until the reopen.
    let acked = a.disk.borrow().acknowledged;
    a.disk.borrow_mut().user_write("later.md", Some("x"));
    assert!(a.r.observe(None).is_err(), "fenced until reopen");
    assert_eq!(a.disk.borrow().acknowledged, acked);
}

#[test]
fn synced_open_and_snapshot_refuse_while_a_deferral_window_is_open() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1);
    let mut b = node(&svc, 2);
    create(&mut a, 1, "a.md", "one");
    settle(&mut [&mut a, &mut b]);
    a.r.store_mut().inner.defer_durability(true).unwrap();
    assert!(
        a.r.build_snapshot_now().is_err(),
        "no snapshot before the barrier"
    );
    a.r.store_mut().inner.defer_durability(false).unwrap();
    assert!(
        a.r.build_snapshot_now().is_ok(),
        "allowed after the barrier"
    );

    // Opening a synced replica over a store with an open window is refused.
    let mut inner = MemStore::new();
    inner.defer_durability(true).unwrap();
    let store = DiskStore {
        inner,
        disk: Rc::new(RefCell::new(Disk::default())),
        barrier_fails: false,
    };
    let cfg = ReplicaConfig {
        collection: COL,
        replica_id: B16([3; 16]),
        device_id: B16([103; 16]),
        mode: mdbn_wire::client::SyncMode::Synced,
        log_endpoint: EndpointId(1),
        verify: false,
        runtime_version: "test".into(),
        trusted_roots: vec![crate::testkit::TEST_ROOT],
        e2e: false,
        trusted_signers: (101..=109u8).map(|d| B16([d; 16])).collect(),
        user_enabled_cloud_copy: false,
        chosen_state: None,
        key_grants_only: false,
        expected_genesis: None,
        policy_pins: None,
    };
    let opened = Replica::open(
        cfg,
        store,
        Box::new(TestPlanner),
        Box::new(PlainSealer::for_device(B16([103; 16]))),
        Host {
            clock: Box::new(TestClock(Rc::new(Cell::new(1_700_000_000_000)))),
            entropy: Box::new(crate::crypto::TestEntropy::new(3)),
            zones: Box::new(UtcOnly),
        },
        DeviceSecrets {
            sign_sk: [3; 32],
            kem_sk: [3; 32],
        },
    );
    assert!(opened.is_err(), "synced open over an open window");
}

/// A generation-0 `base` installs on a materializing replica without clobbering
/// held local bytes: a file held at a path the generation 0 also writes keeps the
/// user's exact bytes on disk and its hold, while the other imported records are
/// published.
#[test]
fn held_local_bytes_survive_a_generation_zero_base_install() {
    use crate::log::LogClient;
    use crate::replica::base::{Gen0Base, build_base};
    use crate::replica::gen0::{DigestCounts, Gen0Record, Gen0Writer, StateDigestStream};
    use mdbn_wire::client::HoldReason;
    use mdbn_wire::common::{B64, Bytes};
    use mdbn_wire::envelope::{Item, ItemKind};
    use mdbn_wire::log_service::AppendParams;
    use mdbn_wire::schema::Wire;
    use mdbn_wire::snapshot::{BaseSource, TextOrBlob};

    let svc = FakeLogService::new();
    let mut a = node(&svc, 1);
    settle(&mut [&mut a]);
    let rec = |i: u8| Gen0Record {
        id: B16([0x30 + i; 16]),
        path: format!("notes/{i}.md"),
        doc: format!("imported {i}\n"),
    };
    let records = vec![rec(1), rec(2)];
    let settings = crate::convert::winclusion(&Default::default());
    let mut sorted = records.clone();
    sorted.sort_by(|x, y| x.id.cmp(&y.id));
    let mut d = StateDigestStream::new(
        DigestCounts {
            records: 2,
            ..DigestCounts::default()
        },
        &settings,
    );
    for r in &sorted {
        d.record(r.id, &r.path, mdbn_wire::hash::sha256(r.doc.as_bytes()))
            .unwrap();
    }
    let digest = d.finish().unwrap();
    let r = &mut a.r;
    let mut w = Gen0Writer::new(COL, 0, false, false);
    let mut objects = w
        .resources(r.sealer.as_mut(), r.host.entropy.as_mut(), vec![])
        .unwrap();
    objects.extend(
        w.bucket(
            r.sealer.as_mut(),
            r.host.entropy.as_mut(),
            0,
            records.clone(),
            vec![],
            &[],
        )
        .unwrap(),
    );
    let device = r.cfg.device_id;
    let (more, m) = w
        .finish(
            r.sealer.as_mut(),
            r.host.entropy.as_mut(),
            digest,
            settings,
            device,
        )
        .unwrap();
    objects.extend(more);
    objects.push(m.manifest.clone());
    let mut c = svc.client(B16([101; 16]));
    for o in &objects {
        c.call(crate::log::LogRequest::PutObject {
            collection: COL,
            address: o.address,
            kind: o.kind,
            bytes: o.bytes.clone(),
        })
        .unwrap();
    }
    let spec = Gen0Base::new(m.manifest.address, m.state_digest, BaseSource::Folder);
    let (payload, _) = build_base(B16([1; 16]), &spec, &|_| Some(vec![])).unwrap();
    let (seq, prev) = svc.head(&COL);
    let item = Item {
        kind: ItemKind::Base,
        collection: COL,
        seq: Some(seq + 1),
        prev: Some(prev),
        epoch: Some(1),
        signer: Some(B16([101; 16])),
        salt: Some(B16([0; 16])),
        idem: None,
        refs: Some(m.base_refs.clone()),
        stream: None,
        body: Bytes(payload.to_bytes().unwrap()),
        sig: Some(B64([0; 64])),
    };
    c.call(crate::log::LogRequest::Append(AppendParams {
        collection: COL,
        expect_seq: seq + 1,
        expect_prev: prev,
        items: vec![Bytes(item.to_bytes().unwrap())],
    }))
    .unwrap();
    let p = seq + 1;

    // A device whose user holds local bytes at a path the generation 0 writes.
    let mut b = node(&svc, 2);
    b.disk
        .borrow_mut()
        .files
        .insert("notes/1.md".into(), "held local bytes\r\n".into());
    let held = Hold {
        id: rec(1).id,
        path: "notes/1.md".into(),
        reason: HoldReason::SuspectWrite,
        since: 1,
        base: None,
        mine: TextOrBlob::Text("held local bytes\r\n".into()),
        theirs: None,
        saves: 1,
    };
    b.r.store
        .commit(Tx {
            holds_put: vec![held.clone()],
            ..Tx::default()
        })
        .unwrap();
    settle(&mut [&mut b]);
    assert_eq!(b.r.head().seq, p, "the base installed");
    assert_eq!(
        b.file("notes/1.md").as_deref(),
        Some("held local bytes\r\n"),
        "the held local bytes are not overwritten"
    );
    assert_eq!(
        b.r.store.hold(&held.id).unwrap(),
        Some(held),
        "the hold survives"
    );
    assert_eq!(
        b.file("notes/2.md").as_deref(),
        Some("imported 2\n"),
        "unheld imported records are published"
    );
}

/// Adopt: a synced replica over a folder that already holds
/// files seals generation 0 from them with the given record IDs and appends a
/// `base {source: folder}` before any entry. The folder is not rewritten and
/// nothing is held; nothing is ingested before the base; a later edit syncs; a
/// second device installs the same records under the same IDs.
#[test]
fn adopt_seals_the_folder_as_generation_zero_with_its_record_ids() {
    use crate::replica::adopt::{AdoptRecords, AdoptSource, AdoptStatus};
    struct Folder(Rc<RefCell<Disk>>, Vec<(Uuid, String)>);
    impl AdoptSource for Folder {
        fn records(&mut self) -> Result<AdoptRecords, String> {
            Ok(AdoptRecords {
                records: self.1.clone(),
                resources: vec![],
                settings: None,
            })
        }
        fn read(&mut self, path: &str) -> Result<Option<String>, String> {
            Ok(self.0.borrow().files.get(path).cloned())
        }
    }
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1);
    let one = B16([0x31; 16]);
    let two = B16([0x32; 16]);
    for (p, t) in [("notes/1.md", "one\n"), ("notes/2.md", "two\r\n")] {
        a.disk.borrow_mut().user_write(p, Some(t));
    }
    let source = Folder(
        a.disk.clone(),
        vec![(one, "notes/1.md".into()), (two, "notes/2.md".into())],
    );
    a.r.begin_adopt(Box::new(source));
    // Before keying/base, a scan captures nothing (no entry may precede the base).
    a.r.observe(None).unwrap();
    assert_eq!(a.r.sync_status().pending, 0);
    settle(&mut [&mut a]);
    assert_eq!(a.r.adopt_status(), Some(AdoptStatus::Done));
    let base_seq = a.r.head().seq;
    assert!(base_seq > 0);
    for (id, path, doc) in [(one, "notes/1.md", "one\n"), (two, "notes/2.md", "two\r\n")] {
        let r = crate::Store::record(a.r.store(), &id).unwrap().unwrap();
        assert_eq!((r.path.as_str(), r.doc.as_str()), (path, doc));
        assert_eq!(
            a.file(path).as_deref(),
            Some(doc),
            "the folder is untouched"
        );
    }
    assert!(
        crate::Store::holds(a.r.store()).unwrap().is_empty(),
        "nothing held"
    );
    assert_eq!(a.r.sync_status().pending, 0, "no entry for adopted files");
    // Ingest resumes after the base: an edit becomes an ordinary entry.
    a.disk
        .borrow_mut()
        .user_write("notes/1.md", Some("one edited\n"));
    settle(&mut [&mut a]);
    assert!(a.r.head().seq > base_seq);
    assert_eq!(a.r.sync_status().pending, 0);
    let mut b = node(&svc, 2);
    settle(&mut [&mut a, &mut b]);
    assert_eq!(b.file("notes/1.md").as_deref(), Some("one edited\n"));
    assert_eq!(b.file("notes/2.md").as_deref(), Some("two\r\n"));
    let r = crate::Store::record(b.r.store(), &two).unwrap().unwrap();
    assert_eq!(r.path, "notes/2.md", "the second device has the adopted ID");
}

/// The takeover's record-ID map names a file's ID at its
/// first local ingest; an ID another record already holds is never reused.
#[test]
fn first_local_ingest_takes_record_ids_from_the_hints() {
    use mdbn_wire::client::SyncMode;
    let svc = FakeLogService::new();
    let mut a = node_mode(&svc, 1, SyncMode::LocalOnly);
    create(&mut a, 9, "taken.md", "x");
    let legacy = B16([0x41; 16]);
    a.r.set_id_hints(vec![(legacy, "a.md".into()), (B16([9; 16]), "b.md".into())]);
    a.disk.borrow_mut().user_write("a.md", Some("alpha"));
    a.disk.borrow_mut().user_write("b.md", Some("beta"));
    a.r.observe(None).unwrap();
    let r = crate::Store::record(a.r.store(), &legacy).unwrap().unwrap();
    assert_eq!(r.path, "a.md");
    let taken = crate::Store::record(a.r.store(), &B16([9; 16]))
        .unwrap()
        .unwrap();
    assert_eq!(taken.path, "taken.md", "a held ID is not reused");
    assert!(
        crate::Store::record_at(a.r.store(), &mdbn_core::paths::path_key("b.md"))
            .unwrap()
            .is_some()
    );
}
