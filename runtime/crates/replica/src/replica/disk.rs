//! The disk, for file-backed stores: publishing the local view, ingesting what users
//! and tools write, and holds (`log-entry.md` §4.4, `replica-client-api.md` §8.1).
//!
//! **Publishing.** Every change to the local view records what the view showed
//! before (`before`), then [`Replica::materialize`] turns before/after pairs into
//! conditional [`Publish`]es: each expects exactly the bytes the previous local view
//! put there. If the disk holds something else, the store reports a drift and observes
//! the path, and ingest takes it from there. Held records are never published.
//!
//! **Ingest.** An [`Observation`] becomes an `external` `document` mutation whose
//! `base` is what this replica last showed at that path and whose `new` is what is on
//! disk now. Unknown provenance (the store's bytes don't match anything this replica
//! showed) and suspect writes are held instead of ingested. Observations are
//! acknowledged in the same commit as the pending row they produce.
//!
//! **Holds.** An applied entry of our own external mutation that recorded a conflict
//! holds that record: the file keeps the user's bytes, later saves are collected into
//! the hold, and nothing propagates until a client resolves it.

use std::collections::BTreeMap;

use mdbn_core::plan::{PlanOptions, Stage};
use mdbn_core::state::{PathHolder, StateView};
use mdbn_wire::client::{Hold, HoldReason, PublishState, Receipt, ReceiptState};
use mdbn_wire::common::{B16, B32, Hash, Text};
use mdbn_wire::intent::{DocVersion, Document, Level, Mutation, Op, OpClock, ResourcePut, Source};
use mdbn_wire::snapshot::TextOrBlob;

use super::{Replica, i64_meta};
use crate::api::{ApiResult, ErrorCode, HoldResolution, SessionId};
use crate::convert;
use crate::layer::LayerView;
use crate::plan::{StoreView, effect_keys, mutation_keys};
use crate::store::{
    Content, Drift, Expect, Observation, ObservationId, Observed, PendingRow, Provenance, Publish,
    Store, StoreError, Tx, meta_keys,
};

/// What the local view showed for one key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Shown {
    pub(crate) path: String,
    pub(crate) rev: Hash,
}

/// A publishable key.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum DiskKey {
    Record(B16),
    Resource(String),
}

fn rev(s: &str) -> Hash {
    mdbn_wire::hash::sha256(s.as_bytes())
}

impl<S: Store> Replica<S> {
    fn local_view_doc(&self, key: &DiskKey) -> Option<(String, String)> {
        let view = StoreView::new(&self.store, self.catalog.clone());
        let lv = LayerView {
            base: &view,
            layer: &self.layer,
        };
        match key {
            DiskKey::Record(id) => lv
                .record(&convert::uuid(id))
                .map(|r| (r.path, r.source.to_string())),
            DiskKey::Resource(p) => lv.resource(p).map(|d| (p.clone(), d.to_string())),
        }
    }

    /// Remember what the local view shows for `key` now, before it changes.
    pub(crate) fn capture_before(&mut self, key: DiskKey) {
        if !self.store.has_files() || self.before.contains_key(&key) {
            return;
        }
        let shown = self.local_view_doc(&key).map(|(path, doc)| Shown {
            rev: rev(&doc),
            path,
        });
        self.before.insert(key, shown);
    }

    /// Capture the before-state of everything a set of wire effects touches.
    pub(crate) fn capture_effects(&mut self, effects: &[mdbn_wire::entry::Effect]) {
        use mdbn_wire::entry::Effect as E;
        for e in effects {
            match e {
                E::PutRecord(p) => self.capture_before(DiskKey::Record(p.id)),
                E::RemoveRecord(p) => self.capture_before(DiskKey::Record(p.id)),
                E::PutResource(p) => self.capture_before(DiskKey::Resource(p.path.clone())),
                E::RemoveResource(p) => self.capture_before(DiskKey::Resource(p.path.clone())),
                _ => {}
            }
        }
    }

    /// Publish the local view for every key captured since the last call.
    pub(crate) fn materialize(&mut self) -> Result<(), StoreError> {
        self.check_apply_store_health()?;
        if !self.store.has_files() {
            self.before.clear();
            return Ok(());
        }
        let before = std::mem::take(&mut self.before);
        let mut deletes = Vec::new();
        let mut moves = Vec::new();
        let mut writes = Vec::new();
        // Keys whose file already shows the view (or that are held): resolved now.
        let mut settled: Vec<(DiskKey, PublishState)> = Vec::new();
        for (key, was) in before {
            let id = match &key {
                DiskKey::Record(id) => Some(*id),
                DiskKey::Resource(_) => None,
            };
            let now = self.local_view_doc(&key);
            if let Some(i) = id
                && self.file_materialization_fenced(
                    i,
                    now.as_ref()
                        .map(|(p, _)| p.as_str())
                        .or_else(|| was.as_ref().map(|w| w.path.as_str())),
                )?
            {
                settled.push((key, PublishState::NotPublished));
                continue;
            }
            let publish = match (was, now) {
                (None, None) => None,
                (None, Some((path, doc))) => Some(Publish::Write {
                    id,
                    path,
                    expect: Expect::Absent,
                    content: Content::Text(doc),
                }),
                (Some(w), None) => {
                    // A native Record→file conversion leaves the old bytes until
                    // the authenticated private stage can replace them atomically.
                    if let Some(id)=id && self.store.file(&id)?.is_some_and(|f|f.kind==mdbn_wire::unindexed_markdown::FileKindV1::UnindexedOversizedMarkdown) {
                        None
                    } else {Some(Publish::Delete {id,path:w.path,expect:Expect::Revision(w.rev)})}
                }
                (Some(w), Some((path, doc))) => {
                    let r = rev(&doc);
                    if w.path == path {
                        (w.rev != r).then_some(Publish::Write {
                            id,
                            path,
                            expect: Expect::Revision(w.rev),
                            content: Content::Text(doc),
                        })
                    } else if let Some(i) = id {
                        Some(Publish::Move {
                            id: i,
                            from: w.path,
                            to: path,
                            expect: Expect::Revision(w.rev),
                            content: (w.rev != r).then_some(Content::Text(doc)),
                        })
                    } else {
                        None
                    }
                }
            };
            match publish {
                None => settled.push((key, PublishState::Published)),
                Some(p @ Publish::Delete { .. }) => deletes.push(p),
                Some(p @ Publish::Move { .. }) => moves.push(p),
                Some(p) => writes.push(p),
            }
        }
        for (k, st) in settled {
            self.published_key(&k, st);
        }
        let mut publish = deletes;
        publish.extend(moves);
        publish.extend(writes);
        // Defence in depth: nothing outside the portable namespace is ever
        // published, whatever reached the local view. Containment under the folder
        // root is also enforced by the platform (`RelPath`).
        let before_len = publish.len();
        publish.retain(|p| {
            let paths: Vec<&str> = match p {
                Publish::Write { path, .. } | Publish::Delete { path, .. } => vec![path],
                Publish::Move { from, to, .. } => vec![from, to],
            };
            paths
                .iter()
                .all(|p| mdbn_core::paths::check_path(p).is_ok())
        });
        if publish.len() != before_len {
            self.incident(
                mdbn_wire::client::IncidentKind::Integrity,
                Some(mdbn_wire::common::Value::Text(
                    "refused to publish a non-portable path".into(),
                )),
            );
        }
        if publish.is_empty() {
            return Ok(());
        }
        // The mutations waiting on these keys are satisfied by this batch (a later
        // mutation on the same key waits for a later one).
        let issued: Vec<(DiskKey, Vec<B16>)> = publish
            .iter()
            .map(|p| {
                let k = publish_key(p);
                let w = self.publish_waits.issue(&k);
                (k, w)
            })
            .collect();
        let report = self.store.commit(Tx {
            publish,
            ..Tx::default()
        })?;
        match report.deferred {
            Some(b) => {
                self.publish_waits.batches.insert(b, issued);
            }
            None => self.on_batch_done(issued, report.drifts),
        }
        Ok(())
    }

    /// Outcomes of deferred publishes (asynchronous stores): the host calls this
    /// after completing file operations. Pushes `receipt` with `published` for the
    /// mutations that are now in the files.
    pub fn on_store_progress(&mut self) {
        if self.check_apply_store_health().is_err() {
            return;
        }
        for r in self.store.take_publish_results() {
            if let Some(issued) = self.publish_waits.batches.remove(&r.batch) {
                self.on_batch_done(issued, r.drifts);
            }
            // Expired or previous-generation batches cannot revive a publish.
        }
        self.pump();
        self.flush_status();
    }

    fn on_batch_done(&mut self, issued: Vec<(DiskKey, Vec<B16>)>, drifts: Vec<Drift>) {
        let mut outcome: BTreeMap<DiskKey, Option<PublishState>> = issued
            .iter()
            .map(|(k, _)| (k.clone(), Some(PublishState::Published)))
            .collect();
        for d in drifts {
            let k = publish_key(&d.publish);
            // A transient drift is retried: its mutations wait for the retry.
            let st = if retried(&d) {
                None
            } else {
                Some(PublishState::NotPublished)
            };
            outcome.insert(k, st);
            self.on_drift(d);
        }
        for (k, ms) in issued {
            match outcome.get(&k).copied().flatten() {
                Some(st) => {
                    for m in ms {
                        self.publish_waits.resolve(m, st);
                    }
                }
                None => self.publish_waits.requeue(&k, ms),
            }
        }
        self.push_published();
    }

    /// A key resolved without a publish of its own.
    fn published_key(&mut self, key: &DiskKey, st: PublishState) {
        for m in self.publish_waits.issue(key) {
            self.publish_waits.resolve(m, st);
        }
        self.push_published();
    }

    /// Track a captured mutation until its effects are in the files.
    pub(crate) fn wait_published(&mut self, mutation: B16, effects: &[mdbn_wire::entry::Effect]) {
        if !self.store.has_files() {
            return;
        }
        let keys = effect_disk_keys(effects);
        let now = self.now();
        self.publish_waits.wait(mutation, keys, now);
    }

    /// Mutations still waiting to be published, and deferred batches outstanding
    /// (for bounds checks).
    pub fn publish_waits_open(&self) -> usize {
        self.publish_waits.open.len() + self.publish_waits.batches.len()
    }

    /// End waits past [`PUBLISH_WAIT_MS`] (from `tick`).
    pub(crate) fn expire_publish_waits(&mut self) {
        let now = self.now();
        self.publish_waits.expire(now);
        self.push_published();
    }

    /// Receipts whose `published` state became final, to current owner sessions.
    fn push_published(&mut self) {
        for m in std::mem::take(&mut self.publish_waits.done) {
            if let Ok(Some(r)) = self.known_receipt(&m) {
                self.push_durable_receipt(r);
            }
        }
    }

    /// Fill in `published` (file-backed replicas, pending or confirmed receipts).
    pub(crate) fn stamp_published(&self, r: &mut Receipt) {
        if !self.store.has_files()
            || !matches!(r.state, ReceiptState::Pending | ReceiptState::Confirmed)
        {
            r.published = None;
            return;
        }
        r.published = Some(self.publish_waits.state(&r.mutation));
    }

    fn on_drift(&mut self, d: Drift) {
        // `changed`/`missing`: the store observes the path and ingest reconciles.
        // `locked`/`read_only`/others: retry on the next tick from the same state.
        if !retried(&d) {
            return;
        }
        let key = publish_key(&d.publish);
        let was = match &d.publish {
            Publish::Write { path, expect, .. } | Publish::Delete { path, expect, .. } => {
                match expect {
                    Expect::Absent => None,
                    Expect::Revision(r) => Some(Shown {
                        path: path.clone(),
                        rev: *r,
                    }),
                }
            }
            Publish::Move { from, expect, .. } => match expect {
                Expect::Absent => None,
                Expect::Revision(r) => Some(Shown {
                    path: from.clone(),
                    rev: *r,
                }),
            },
        };
        self.retry_publish.insert(key, was);
    }

    /// Re-attempt publishes that drifted for transient reasons.
    pub(crate) fn retry_publishes(&mut self) {
        if self.check_apply_store_health().is_err() {
            return;
        }
        if self.retry_publish.is_empty() {
            return;
        }
        let retry = std::mem::take(&mut self.retry_publish);
        for (k, v) in retry {
            self.before.entry(k).or_insert(v);
        }
        if let Err(e) = self.materialize() {
            self.incident(
                mdbn_wire::client::IncidentKind::Integrity,
                Some(mdbn_wire::common::Value::Text(format!("store: {e}"))),
            );
        }
    }

    /// Make the folder match the local view after a restart: a crash can land
    /// between the commit of a change and its publish, or in the middle of a move.
    /// Every record and resource whose bytes differ from what the store knows is on
    /// disk is published from what is there; known files no longer in the local view
    /// (and not held) are deleted, conditionally on their known bytes.
    pub(crate) fn reconcile_disk(&mut self) -> Result<(), StoreError> {
        self.check_apply_store_health()?;
        // Attachment files: unlink, move or fetch what a crash left behind.
        self.reconcile_attachments()?;
        if !self.store.has_files() {
            return Ok(());
        }
        let mut wanted: BTreeMap<String, DiskKey> = BTreeMap::new();
        {
            let view = StoreView::new(&self.store, self.catalog.clone());
            let lv = LayerView {
                base: &view,
                layer: &self.layer,
            };
            for id in lv.record_ids() {
                if let Some(r) = lv.record(&id) {
                    wanted.insert(r.path, DiskKey::Record(convert::wuuid(&id)));
                }
            }
            for p in lv.resource_paths() {
                wanted.insert(p.clone(), DiskKey::Resource(p));
            }
            if let Some(e) = view.error() {
                return Err(e);
            }
        }
        let known: BTreeMap<String, Hash> = self.store.disk_paths()?.into_iter().collect();
        let held: std::collections::BTreeSet<String> =
            self.store.holds()?.into_iter().map(|h| h.path).collect();
        for (path, key) in &wanted {
            let shown = known.get(path).map(|r| Shown {
                path: path.clone(),
                rev: *r,
            });
            self.before.entry(key.clone()).or_insert(shown);
        }
        // Known files that nothing in the local view occupies: leftovers of an
        // interrupted move or delete.
        let mut stray = Vec::new();
        for (path, rev) in &known {
            if wanted.contains_key(path) || held.contains(path) {
                continue;
            }
            // Stored file identity owns this path, including native Markdown and
            // explicitly ordinary record-extension files. Text classification is
            // not authority to remove a live file during restart reconciliation.
            if self
                .store
                .file_at(&mdbn_core::paths::path_key(path))?
                .is_some()
            {
                continue;
            }
            if self.catalog.is_record_path(path) || self.catalog.is_resource_path(path) {
                stray.push(Publish::Delete {
                    id: None,
                    path: path.clone(),
                    expect: Expect::Revision(*rev),
                });
            }
        }
        // Fix stray copies first (a move's source), then publish the view; the
        // per-key comparison skips everything already right.
        if !stray.is_empty() {
            let report = self.store.commit(Tx {
                publish: stray,
                ..Tx::default()
            })?;
            for d in report.drifts {
                self.on_drift(d);
            }
        }
        // `before` holds what is on disk; materialize compares with the view. A
        // record whose path changed but whose old path is still known needs the
        // delete above; one that was never published gets a create.
        let keys: Vec<DiskKey> = self.before.keys().cloned().collect();
        for k in keys {
            if let Some(Some(s)) = self.before.get(&k).cloned()
                && let Some((path, doc)) = self.local_view_doc(&k)
                && path == s.path
                && rev(&doc) == s.rev
            {
                self.before.remove(&k);
            }
        }
        self.materialize()
    }

    // ------------------------------------------------------------ ingest

    /// Ingest observed file changes as `external` mutations.
    /// While apply is recovering/faulted, nothing is captured or acknowledged:
    /// evidence must remain in the store and be rescanned/reoffered after recovery.
    pub fn ingest(&mut self, observations: Vec<Observation>) {
        if self.check_apply_store_health().is_err() {
            return;
        }
        if self.local_only() {
            self.ingest_local(observations);
            return;
        }
        let (config, mut rest) = split_config(observations);
        let mut config = config.into_iter();
        let mut ordered = Vec::new();
        loop {
            let o = match config.next() {
                Some(o) => o,
                None if !rest.is_empty() => {
                    // The configuration is in: order by the catalog it set up.
                    ordered = self.resources_first(std::mem::take(&mut rest));
                    continue;
                }
                None => match ordered.pop() {
                    Some(o) => o,
                    None => break,
                },
            };
            if let Err(e) = self.ingest_one(o, None) {
                self.incident(
                    mdbn_wire::client::IncidentKind::Integrity,
                    Some(mdbn_wire::common::Value::Text(format!("ingest: {e}"))),
                );
                break;
            }
        }
        if let Err(e) = self.materialize() {
            self.incident(
                mdbn_wire::client::IncidentKind::Integrity,
                Some(mdbn_wire::common::Value::Text(format!("store: {e}"))),
            );
        }
        self.pump();
        self.attachment_upload_step();
        self.flush_status();
    }

    /// Batch distinct new external documents only. Flush before duplicates,
    /// moves, resources, holds or existing-record edits so their provenance and
    /// catalog checks still observe the preceding committed local prefix.
    fn ingest_local(&mut self, observations: Vec<Observation>) {
        const OPERATIONS: usize = 64;
        const TEXT_BYTES: usize = 256 * 1024;
        let mut text_bytes = 0usize;
        let mut ops = Vec::new();
        let mut tokens = Vec::new();
        let mut paths = std::collections::BTreeSet::new();
        let (config, rest) = split_config(observations);
        let mut window = IngestWindow::default();
        let result = (|| {
            // The configuration first, then the resources it places (types,
            // contracts), then records: records are typed once, against the
            // catalog they will keep, instead of being re-typed when a type
            // file sorts after them (`_types/` follows capitalised folders).
            let mut config = config.into_iter();
            let mut rest = Some(rest);
            let mut ordered = Vec::new();
            loop {
                let o = match config.next() {
                    Some(o) => o,
                    None => {
                        if let Some(rest) = rest.take() {
                            // Configuration ingested (its commit is pumped), so
                            // the catalog now knows the types folder.
                            self.flush_local_deferred(&mut ops, &mut tokens, &mut window)?;
                            paths.clear();
                            text_bytes = 0;
                            ordered = self.resources_first(rest);
                        }
                        match ordered.pop() {
                            Some(o) => o,
                            None => break,
                        }
                    }
                };
                self.check_apply_store_health()?;
                let key = mdbn_core::paths::path_key(&o.path);
                let batchable = o.base.is_none()
                    && o.moved_from.is_none()
                    && o.provenance == Provenance::Normal
                    && matches!(&o.now, Some(Observed::Text(_)))
                    && mdbn_core::paths::check_path(&o.path).is_ok()
                    && self.catalog.is_record_path(&o.path)
                    && self.holder_at(&o.path).is_none();
                let bytes = match &o.now {
                    Some(Observed::Text(text)) => text.len(),
                    _ => 0,
                };
                if ops.len() == OPERATIONS
                    || text_bytes.saturating_add(bytes) > TEXT_BYTES
                    || paths.contains(&key)
                    || !batchable
                {
                    self.flush_local_deferred(&mut ops, &mut tokens, &mut window)?;
                    paths.clear();
                    text_bytes = 0;
                }
                if !batchable {
                    // Everything else (resources, holds, moves, attachments,
                    // edits of known records) commits durably as before.
                    self.close_ingest_window(&mut window)?;
                }
                self.ingest_one(o, batchable.then_some((&mut ops, &mut tokens)))?;
                if batchable {
                    text_bytes += bytes;
                    paths.insert(key);
                } else {
                    self.pump();
                    self.check_apply_store_health()?;
                }
            }
            self.flush_local_deferred(&mut ops, &mut tokens, &mut window)?;
            self.close_ingest_window(&mut window)?;
            self.materialize()?;
            self.pump();
            self.check_apply_store_health()
        })();
        if window.open {
            // Failed inside a window: still try the barrier. If it fails the
            // store fences itself and the evidence is re-observed on reopen.
            let _ = self.close_ingest_window(&mut window);
        }
        if let Err(e) = result {
            if !self.apply_fault && !self.is_apply_recovering() {
                let checkpoint = super::apply_checkpoint::Checkpoint::capture(self);
                self.failed_apply(checkpoint, self.head.seq.saturating_add(1), false);
            }
            self.incident(
                mdbn_wire::client::IncidentKind::Integrity,
                Some(mdbn_wire::common::Value::Text(format!("ingest: {e}"))),
            );
        }
        self.flush_status();
    }

    /// Flush batched new external documents inside a deferred-durability
    /// window ([`Store::defer_durability`]). The window holds only these
    /// commits: their pending rows, applies and acknowledgements can all be
    /// redone from the files, which stay on disk, so a crash that loses a
    /// suffix of them re-observes those files on the next scan. It is opened
    /// only when no other pending row could be applied inside it, and closed
    /// (a barrier) every [`INGEST_WINDOW_FLUSHES`] flushes, before any other
    /// kind of observation, and at the end of the round.
    fn flush_local_deferred(
        &mut self,
        ops: &mut Vec<Op>,
        tokens: &mut Vec<ObservationId>,
        window: &mut IngestWindow,
    ) -> Result<(), StoreError> {
        if ops.is_empty() {
            return Ok(());
        }
        if !window.open && self.store.pending_count()? == 0 {
            self.store.defer_durability(true)?;
            *window = IngestWindow {
                open: true,
                flushes: 0,
            };
        }
        self.flush_local_external(ops, tokens)?;
        if window.open {
            window.flushes += 1;
            if window.flushes >= INGEST_WINDOW_FLUSHES {
                self.close_ingest_window(window)?;
            }
        }
        Ok(())
    }

    fn close_ingest_window(&mut self, window: &mut IngestWindow) -> Result<(), StoreError> {
        if std::mem::take(&mut window.open) {
            self.store.defer_durability(false)?;
        }
        Ok(())
    }

    /// `observations` with resource paths (under the current catalog) ahead of
    /// everything else, otherwise in their original order, reversed so the
    /// caller can `pop` from the end.
    fn resources_first(&self, observations: Vec<Observation>) -> Vec<Observation> {
        let is_resource = |o: &Observation| {
            self.catalog.is_resource_path(&o.path)
                || o.moved_from
                    .as_deref()
                    .is_some_and(|p| self.catalog.is_resource_path(p))
        };
        let (resources, others): (Vec<_>, Vec<_>) =
            observations.into_iter().partition(|o| is_resource(o));
        let mut ordered: Vec<Observation> = resources.into_iter().chain(others).collect();
        ordered.reverse();
        ordered
    }

    fn flush_local_external(
        &mut self,
        ops: &mut Vec<Op>,
        tokens: &mut Vec<ObservationId>,
    ) -> Result<(), StoreError> {
        if ops.is_empty() {
            return Ok(());
        }
        self.check_apply_store_health()?;
        let checkpoint = super::apply_checkpoint::Checkpoint::capture(self);
        if let Err(e) = self.capture_external(std::mem::take(ops), std::mem::take(tokens)) {
            // Even a typed capture abort has no durable pending row to retry.
            // Reopen/rescan the unacknowledged evidence instead of wedging behind
            // an apply-prefix barrier that no pending row can ever advance.
            self.failed_apply(checkpoint, self.head.seq.saturating_add(1), false);
            return Err(e);
        }
        self.pump();
        self.check_apply_store_health()
    }

    fn ack(&mut self, token: ObservationId) -> Result<(), StoreError> {
        self.check_apply_store_health()?;
        self.store.commit(Tx {
            ack_observations: vec![token],
            ..Tx::default()
        })?;
        Ok(())
    }

    fn holder_at(&self, path: &str) -> Option<B16> {
        let view = StoreView::new(&self.store, self.catalog.clone());
        let lv = LayerView {
            base: &view,
            layer: &self.layer,
        };
        match lv.at_path_key(&mdbn_core::paths::path_key(path)) {
            Some(PathHolder::Record(id)) => Some(convert::wuuid(&id)),
            _ => None,
        }
    }

    fn ingest_one(
        &mut self,
        o: Observation,
        batch: Option<(&mut Vec<Op>, &mut Vec<ObservationId>)>,
    ) -> Result<(), StoreError> {
        self.check_apply_store_health()?;
        // Namespace safety: such paths are never part of the collection.
        if mdbn_core::paths::check_path(&o.path).is_err()
            || o.moved_from
                .as_deref()
                .is_some_and(|p| mdbn_core::paths::check_path(p).is_err())
        {
            return self.ack(o.token);
        }
        // Attachment files (and deletes of files) go to attachment ingest (T6).
        if self.ingest_attachment(&o)? {
            return Ok(());
        }
        // Admit record source before cloning/parsing or touching shown state.
        // Resource documents are a different namespace with their own rules.
        let catalog = self.catalog.clone();
        if !catalog.is_resource_path(&o.path)
            && catalog.is_record_path(&o.path)
            && let Some(Observed::Text(source)) = &o.now
            && let Err(e) = self.record_write_admission().check_source(source)
        {
            self.record_admission_incident(e);
            return Ok(());
        }
        let text = match &o.now {
            Some(Observed::Text(s)) => Some(s.clone()),
            // Handled above; never read whole.
            Some(Observed::Attachment { .. }) => return Ok(()),
            None => None,
        };
        // Resources edited on disk are written blind (spec 04: ingested and reported).
        if catalog.is_resource_path(&o.path) {
            return self.ingest_resource(o, text);
        }
        if text.is_some() && !catalog.is_record_path(&o.path) {
            return Ok(());
        }
        // Which record is this?
        let from = o.moved_from.clone().unwrap_or_else(|| o.path.clone());
        let id = self.holder_at(&from).or_else(|| self.holder_at(&o.path));
        // A held record collects saves.
        if let Some(i) = id
            && let Some(mut h) = self.store.hold(&i)?
        {
            h.mine = TextOrBlob::Text(text.clone().unwrap_or_default());
            h.saves += 1;
            self.store.commit(Tx {
                holds_put: vec![h],
                ack_observations: vec![o.token],
                ..Tx::default()
            })?;
            self.push_holds();
            return Ok(());
        }
        // What did this replica show at the path before the edit?
        let shown = id.and_then(|i| self.local_view_doc(&DiskKey::Record(i)));
        let base = match (&shown, o.base) {
            (Some((p, d)), Some(b)) if rev(d) == b => Some(DocVersion {
                path: p.clone(),
                doc: Text::Inline(d.clone()),
            }),
            (None, None) => None,
            (Some((p, d)), None) if o.moved_from.is_some() => Some(DocVersion {
                path: p.clone(),
                doc: Text::Inline(d.clone()),
            }),
            _ => {
                // The store's last-known bytes are not what this replica showed.
                if let Some(t) = &text {
                    return self.hold_unknown(id, &o, t, HoldReason::UnknownProvenance);
                }
                return self.ack(o.token);
            }
        };
        if o.provenance == Provenance::Suspect
            && let Some(t) = &text
        {
            return self.hold_unknown(id, &o, t, HoldReason::SuspectWrite);
        }
        // Nothing changed relative to the local view: just acknowledge.
        if let (Some((p, d)), Some(t)) = (&shown, &text)
            && *p == o.path
            && d == t
        {
            return self.ack(o.token);
        }
        if id.is_none() && text.is_none() {
            return self.ack(o.token);
        }
        let id = match id {
            Some(i) => i,
            None => self.mint_v7(),
        };
        let new = text.as_ref().map(|t| DocVersion {
            path: o.path.clone(),
            doc: Text::Inline(t.clone()),
        });
        // The disk now shows the user's bytes: publish from there.
        self.before.insert(
            DiskKey::Record(id),
            text.as_ref().map(|t| Shown {
                path: o.path.clone(),
                rev: rev(t),
            }),
        );
        if let Some(from) = &o.moved_from
            && let Some((p, _)) = &shown
            && p == from
        {
            // The old path is gone on disk too.
        }
        let op = Op::Document(Document {
            id,
            base,
            new,
            if_revision: None,
        });
        if let Some((ops, tokens)) = batch {
            ops.push(op);
            tokens.push(o.token);
            Ok(())
        } else {
            self.capture_external(vec![op], vec![o.token])
        }
    }

    fn ingest_resource(&mut self, o: Observation, text: Option<String>) -> Result<(), StoreError> {
        let Some(doc) = text else {
            // A deleted resource file: ingested as a resource delete.
            let shown = self.local_view_doc(&DiskKey::Resource(o.path.clone()));
            if shown.is_none() {
                return self.ack(o.token);
            }
            self.before.insert(DiskKey::Resource(o.path.clone()), None);
            return self.capture_resource(
                Op::ResourceDelete(mdbn_wire::intent::ResourceDelete {
                    path: o.path.clone(),
                    base_revision: None,
                }),
                o.token,
            );
        };
        if self
            .local_view_doc(&DiskKey::Resource(o.path.clone()))
            .is_some_and(|(_, d)| d == doc)
        {
            return self.ack(o.token);
        }
        self.before.insert(
            DiskKey::Resource(o.path.clone()),
            Some(Shown {
                path: o.path.clone(),
                rev: rev(&doc),
            }),
        );
        self.capture_resource(
            Op::ResourcePut(ResourcePut {
                path: o.path.clone(),
                doc: Text::Inline(doc),
                base_revision: None,
                must_not_exist: None,
            }),
            o.token,
        )
    }

    fn capture_resource(&mut self, op: Op, token: ObservationId) -> Result<(), StoreError> {
        // Resource writes are `api` operations (intent.md §3.6); an invalid one is
        // rejected and reported, and the file keeps the user's bytes.
        let m = self.capture(vec![op], Source::Api);
        self.capture_and_queue(m, vec![token])
    }

    fn hold_unknown(
        &mut self,
        id: Option<B16>,
        o: &Observation,
        text: &str,
        reason: HoldReason,
    ) -> Result<(), StoreError> {
        let id = match id {
            Some(i) => i,
            None => self.mint_v7(),
        };
        let theirs = self
            .local_view_doc(&DiskKey::Record(id))
            .map(|(_, d)| TextOrBlob::Text(d));
        let h = Hold {
            id,
            path: o.path.clone(),
            reason,
            since: self.now(),
            base: None,
            mine: TextOrBlob::Text(text.to_string()),
            theirs,
            saves: 1,
        };
        self.store.commit(Tx {
            holds_put: vec![h],
            ack_observations: vec![o.token],
            ..Tx::default()
        })?;
        self.status_dirty = true;
        self.push_holds();
        Ok(())
    }

    /// A captured mutation (no session): ingest and hold resolution.
    pub(crate) fn capture(&mut self, ops: Vec<Op>, source: Source) -> Mutation {
        let instant = self.now().max(self.clock_floor + 1).max(self.log_time + 1);
        self.clock_floor = instant;
        let tz = self.host.zones.default_zone();
        let local_date = self
            .host
            .zones
            .local_date(instant, &tz)
            .unwrap_or_else(|| super::utc_date(instant));
        let id = self.mint_v7();
        let mut seed = [0u8; 32];
        self.host.entropy.fill(&mut seed);
        Mutation {
            id,
            origin: self.cfg.replica_id,
            base_seq: self.head.seq,
            clock: OpClock {
                instant,
                tz,
                local_date,
            },
            seed: B32(seed),
            source,
            ops,
            on_behalf: None,
            conflict_mode: None,
            validated_at: Some(Level::Off),
            room: None,
        }
    }

    fn capture_external(
        &mut self,
        ops: Vec<Op>,
        tokens: Vec<ObservationId>,
    ) -> Result<(), StoreError> {
        let m = self.capture(ops, Source::External);
        self.capture_and_queue(m, tokens)
    }

    /// Plan a captured mutation at the local view and queue it, acknowledging
    /// `tokens` in the same commit. Returns the receipt.
    pub(crate) fn capture_and_queue(
        &mut self,
        m: Mutation,
        tokens: Vec<ObservationId>,
    ) -> Result<(), StoreError> {
        self.queue_mutation(m, tokens, None).map(|_| ())
    }

    pub(crate) fn queue_mutation(
        &mut self,
        m: Mutation,
        tokens: Vec<ObservationId>,
        session: Option<SessionId>,
    ) -> Result<Receipt, StoreError> {
        if let Err(e) = self.check_new_record_sources(&m.ops) {
            self.record_admission_incident(e);
            self.before.clear();
            return Ok(rejected_receipt(
                m.id,
                super::record_admission::record_too_large(e)
                    .problem()
                    .clone(),
            ));
        }
        let Ok(cm) = convert::mutation(&m, &convert::inline_only) else {
            self.ack_all(tokens)?;
            return Ok(rejected_receipt(
                m.id,
                ErrorCode::InvalidRequest.problem("unconvertible"),
            ));
        };
        let planned = {
            let view = StoreView::new(&self.store, self.catalog.clone());
            let lv = LayerView {
                base: &view,
                layer: &self.layer,
            };
            let r = self.planner.plan(
                &cm,
                &lv,
                &PlanOptions {
                    stage: Stage::Submit {
                        level: mdbn_core::intent::Level::Off,
                    },
                },
            );
            if let Some(e) = view.error() {
                return Err(e);
            }
            r
        };
        let planned = super::check_paths(planned);
        let planned = match planned {
            Ok(p) => p,
            Err(rej) => {
                // An external edit is never rejected by contract; a planner refusal
                // here is a bug or a resource write that is invalid. Keep the user's
                // bytes (nothing is published) and report.
                self.ack_all(tokens)?;
                let problem = super::submit::rejection_problem(&rej);
                self.incident(
                    mdbn_wire::client::IncidentKind::Integrity,
                    Some(mdbn_wire::common::Value::Text(format!(
                        "ingest refused: {}",
                        problem.message
                    ))),
                );
                self.before.clear();
                return Ok(rejected_receipt(m.id, problem));
            }
        };
        if let Err(e) = self.record_write_admission().check_planned(&planned) {
            self.record_admission_incident(e);
            self.before.clear();
            return Ok(rejected_receipt(
                m.id,
                super::record_admission::record_too_large(e)
                    .problem()
                    .clone(),
            ));
        }
        // A result carrying attachment-v1 content (an ingested move or delete
        // of an attachment file) is appended in the runtime family, as submit
        // does; it layers no legacy effects until it is confirmed.
        let encoded = if super::carries_attachment(&planned) {
            Ok(Vec::new())
        } else {
            planned
                .effects
                .iter()
                .map(convert::weffect)
                .collect::<Result<Vec<_>, _>>()
        };
        let effects: Vec<mdbn_wire::entry::Effect> = match encoded {
            Ok(e) => e,
            Err(e) => {
                // The legacy log cannot carry this result (an attachment effect).
                // Like a planner refusal above: keep the user's bytes and report.
                self.ack_all(tokens)?;
                let problem = super::unencodable_result(&e);
                self.incident(
                    mdbn_wire::client::IncidentKind::Integrity,
                    Some(mdbn_wire::common::Value::Text(format!(
                        "ingest refused: {}",
                        problem.message
                    ))),
                );
                self.before.clear();
                return Ok(rejected_receipt(m.id, problem));
            }
        };
        self.capture_effects(&effects);
        let mut touches = mutation_keys(&m);
        touches.extend(effect_keys(&effects));
        touches.extend(super::path_keys(&effects));
        touches.sort();
        touches.dedup();
        let order = self.next_order;
        self.next_order += 1;
        let id = m.id;
        self.store.commit(Tx {
            pending_put: vec![PendingRow {
                order,
                mutation: m.into(),
                effects: effects.clone(),
                touches: touches.clone(),
                grant: None,
                uploads: Vec::new(),
                refs: Vec::new(),
            }],
            ack_observations: tokens,
            meta: vec![(meta_keys::COUNTERS.into(), i64_meta(self.clock_floor))],
            ..Tx::default()
        })?;
        {
            let view = StoreView::new(&self.store, self.catalog.clone());
            for e in &planned.effects {
                self.layer.apply_effect(&view, e);
            }
            for a in &planned.aliases {
                self.layer.apply_alias(&a.path, a.id);
            }
        }
        self.touch.add(order, &touches);
        self.pending_keys.insert(order, touches);
        if let Some(s) = session {
            self.submitted_by.insert(id, s);
        }
        self.status_dirty = true;
        let ids = super::effect_ids(&effects).into_iter().collect();
        self.notify(&ids);
        Ok(Receipt {
            relocated_from: None,
            mutation: id,
            state: ReceiptState::Pending,
            seq: None,
            status: None,
            conflicts: None,
            records: None,
            problem: None,
            published: None,
        })
    }

    fn ack_all(&mut self, tokens: Vec<ObservationId>) -> Result<(), StoreError> {
        if tokens.is_empty() {
            return Ok(());
        }
        self.store.commit(Tx {
            ack_observations: tokens,
            ..Tx::default()
        })?;
        Ok(())
    }

    // ------------------------------------------------------------ holds

    /// Prepare holds in the SAME transaction as head, effects and receipt.
    /// Only a matched origin mutation reaches this helper. Never downcast an
    /// attachment descriptor, and never hold successful siblings of a conflict.
    pub(crate) fn prepare_conflict_holds(
        &self,
        mutation: &mdbn_wire::attachment_runtime_v1::Mutation,
        conflicts: &[mdbn_wire::attachment_runtime_v1::Conflict],
        tx: &mut Tx,
        text: &impl Fn(&Text) -> crate::convert::CResult<String>,
    ) -> Result<(), StoreError> {
        use mdbn_wire::attachment_runtime_v1 as rt;
        if mutation.source != Source::External
            || mutation.origin != self.cfg.replica_id
            || (!self.store.has_files() && !self.store.materializes_attachments())
        {
            return Ok(());
        }
        let resolve =
            |t: &Text| text(t).map_err(|e| StoreError::Corrupt(format!("hold text: {e:?}")));
        for op in &mutation.ops {
            let (id, path, mine, document_base) = match op {
                rt::Op::Legacy(Op::Document(d)) => {
                    let (path, mine) = match &d.new {
                        Some(n) => (n.path.clone(), resolve(&n.doc)?),
                        None => (
                            d.base.as_ref().map(|b| b.path.clone()).unwrap_or_default(),
                            String::new(),
                        ),
                    };
                    let base = d
                        .base
                        .as_ref()
                        .map(|b| resolve(&b.doc).map(TextOrBlob::Text))
                        .transpose()?;
                    (d.id, path, TextOrBlob::Text(mine), base)
                }
                rt::Op::Legacy(Op::FilePut(f)) => {
                    (f.id, f.path.clone(), TextOrBlob::Blob(f.blob.clone()), None)
                }
                rt::Op::FileAttach(f) => (
                    f.id,
                    f.path.clone(),
                    TextOrBlob::Attachment(f.content.clone()),
                    None,
                ),
                rt::Op::OrdinaryAttachmentContinuation(f) => (
                    f.id,
                    f.path.clone(),
                    TextOrBlob::Attachment(f.content.clone()),
                    Some(hold_file_content(&f.prior)?),
                ),
                _ => continue,
            };
            let Some(conflict) = conflicts.iter().find(|c| c.id == id) else {
                continue;
            };
            if self.store.hold(&id)?.is_some() || tx.holds_put.iter().any(|h| h.id == id) {
                continue;
            }
            // Full document, not a field-level conflict side; full file content,
            // not a hash-only CAS token. Observe the exact prepared post-state.
            let theirs = if let Some(r) = tx.records_put.iter().rev().find(|r| r.id == id) {
                Some(TextOrBlob::Text(r.doc.clone()))
            } else if let Some(f) = tx.files_put.iter().rev().find(|f| f.id == id) {
                Some(hold_file_content(&f.content)?)
            } else if tx.records_del.contains(&id) || tx.files_del.contains(&id) {
                None
            } else if let Some(r) = self.store.record(&id)? {
                Some(TextOrBlob::Text(r.doc))
            } else {
                self.store
                    .file(&id)?
                    .map(|f| hold_file_content(&f.content))
                    .transpose()?
            };
            let conflict_base = match conflict.base.as_ref() {
                Some(rt::ConflictValue::Attachment(c)) => Some(TextOrBlob::Attachment(c.clone())),
                Some(rt::ConflictValue::UnindexedMarkdown(f)) => {
                    Some(hold_file_content(&f.content)?)
                }
                Some(rt::ConflictValue::Legacy(mdbn_wire::entry::ConflictValue::Blob(b))) => {
                    Some(TextOrBlob::Blob(b.clone()))
                }
                _ => None,
            };
            let base = document_base.or(conflict_base);
            tx.holds_put.push(Hold {
                id,
                path,
                reason: HoldReason::Conflict,
                since: self.now(),
                base,
                mine,
                theirs,
                saves: 1,
            });
        }
        Ok(())
    }

    /// A confirmed rival must not overwrite an origin's external edit while
    /// its own result is still pending, nor after that result becomes a hold.
    /// Errors fail closed. The pending→hold handover is one apply transaction.
    pub(crate) fn file_materialization_fenced(
        &self,
        id: B16,
        path: Option<&str>,
    ) -> Result<bool, StoreError> {
        use mdbn_wire::attachment_runtime_v1 as rt;
        let same_path = |p: &str| {
            path.is_some_and(|q| mdbn_core::paths::path_key(p) == mdbn_core::paths::path_key(q))
        };
        if self.store.hold(&id)?.is_some()
            || (path.is_some() && self.store.holds()?.iter().any(|h| same_path(&h.path)))
        {
            return Ok(true);
        }
        let mut after = None;
        loop {
            let page = self.store.pending(after, 256)?;
            for row in &page {
                if row.mutation.origin != self.cfg.replica_id
                    || row.mutation.source != Source::External
                {
                    continue;
                }
                if row.mutation.ops.iter().any(|op| match op {
                    rt::Op::Legacy(Op::FilePut(f)) => f.id == id || same_path(&f.path),
                    rt::Op::FileAttach(f) => f.id == id || same_path(&f.path),
                    rt::Op::OrdinaryAttachmentContinuation(f) => f.id == id || same_path(&f.path),
                    _ => false,
                }) {
                    return Ok(true);
                }
            }
            if page.len() < 256 {
                return Ok(false);
            }
            after = page.last().map(|r| r.order);
        }
    }

    pub(crate) fn push_holds(&mut self) {
        let subs: Vec<SessionId> = self
            .sessions
            .iter()
            .filter(|(_, s)| s.holds_sub)
            .map(|(id, _)| *id)
            .collect();
        if subs.is_empty() {
            return;
        }
        let holds = self.store.holds().unwrap_or_default();
        for s in subs {
            self.pushes
                .push((s, crate::api::Push::Holds(holds.clone())));
        }
    }

    /// Resolve a hold by submitting an ordinary mutation (`replica-client-api.md` §8.1).
    pub(crate) fn resolve_hold_with(
        &mut self,
        session: SessionId,
        id: B16,
        how: HoldResolution,
    ) -> ApiResult<Receipt> {
        use super::submit::store_err;
        let hold = self
            .store
            .hold(&id)
            .map_err(store_err)?
            .ok_or_else(|| ErrorCode::NotFound.err("no such hold"))?;
        let mine = match &hold.mine {
            TextOrBlob::Text(s) => s.clone(),
            TextOrBlob::Blob(_) | TextOrBlob::Attachment(_) => {
                return Err(ErrorCode::InvalidRequest.err("binary holds are resolved by upload"));
            }
        };
        // The disk shows mine; publish the outcome from there.
        let current = self.local_view_doc(&DiskKey::Record(id));
        let release = |r: &mut Self| -> ApiResult<()> {
            r.store
                .commit(Tx {
                    holds_del: vec![id],
                    ..Tx::default()
                })
                .map_err(store_err)?;
            r.status_dirty = true;
            r.push_holds();
            Ok(())
        };
        let disk_shown = Some(Shown {
            path: hold.path.clone(),
            rev: rev(&mine),
        });
        let doc_op = |new: Option<(String, String)>| {
            Op::Document(Document {
                id,
                base: current.as_ref().map(|(p, d)| DocVersion {
                    path: p.clone(),
                    doc: Text::Inline(d.clone()),
                }),
                new: new.map(|(p, d)| DocVersion {
                    path: p,
                    doc: Text::Inline(d),
                }),
                if_revision: None,
            })
        };
        let ops = match how {
            HoldResolution::TakeTheirs => {
                release(self)?;
                self.before.insert(DiskKey::Record(id), disk_shown);
                self.materialize().map_err(store_err)?;
                return Ok(Receipt {
                    relocated_from: None,
                    mutation: id,
                    state: ReceiptState::Confirmed,
                    seq: None,
                    status: None,
                    conflicts: None,
                    records: None,
                    problem: None,
                    published: None,
                });
            }
            HoldResolution::KeepMine => vec![doc_op(Some((hold.path.clone(), mine.clone())))],
            HoldResolution::Use(doc) => vec![doc_op(Some((hold.path.clone(), doc)))],
            HoldResolution::Delete => vec![Op::Delete(mdbn_wire::intent::Delete {
                id,
                base_revision: None,
                if_revision: None,
            })],
            HoldResolution::KeepBoth => {
                let new_id = self.mint_v7();
                let path = conflict_path(
                    &hold.path,
                    &self.cfg.device_id,
                    &super::utc_date(self.now()),
                );
                vec![Op::Create(mdbn_wire::intent::Create {
                    id: new_id,
                    path: Some(path),
                    type_name: None,
                    frontmatter: None,
                    body: None,
                    document: Some(Text::Inline(mine.clone())),
                })]
            }
            HoldResolution::UseUpload(_) => {
                return Err(ErrorCode::InvalidRequest.err("uploads resolve file holds"));
            }
        };
        release(self)?;
        self.before.insert(DiskKey::Record(id), disk_shown);
        let m = self.capture(ops, Source::Api);
        let r = self
            .queue_mutation(m, Vec::new(), Some(session))
            .map_err(store_err)?;
        self.materialize().map_err(store_err)?;
        self.pump();
        Ok(r)
    }

    /// The map of keys awaiting publish (for tests).
    pub fn publishes_pending(&self) -> usize {
        self.before.len() + self.retry_publish.len()
    }
}

fn hold_file_content(
    content: &mdbn_wire::attachment::FileContent,
) -> Result<TextOrBlob, StoreError> {
    match content {
        mdbn_wire::attachment::FileContent::Blob(b) => Ok(TextOrBlob::Blob(b.clone())),
        mdbn_wire::attachment::FileContent::AttachmentV1(c) => {
            Ok(TextOrBlob::Attachment(c.clone()))
        }
        _ => Err(StoreError::Corrupt("unknown file content in hold".into())),
    }
}

fn rejected_receipt(id: B16, problem: mdbn_wire::client::Problem) -> Receipt {
    Receipt {
        relocated_from: None,
        mutation: id,
        state: ReceiptState::Rejected,
        seq: None,
        status: None,
        conflicts: None,
        records: None,
        problem: Some(problem),
        published: None,
    }
}

/// `name (conflict <device> <date>).ext` (`replica-client-api.md` §8.1).
pub(crate) fn conflict_path(path: &str, device: &B16, date: &str) -> String {
    let dev = &device.to_hex()[..8];
    match path.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() && !ext.contains('/') => {
            format!("{stem} (conflict {dev} {date}).{ext}")
        }
        _ => format!("{path} (conflict {dev} {date})"),
    }
}

/// Unused-type guard for the map alias.
pub(crate) type Before = BTreeMap<DiskKey, Option<Shown>>;

/// Whether a drift is retried from the same state (the file is busy) rather than
/// left to ingest (the file holds other bytes).
fn retried(d: &Drift) -> bool {
    !matches!(d.reason.as_str(), "changed" | "missing" | "editor_busy")
}

/// The disk key a publish is for.
fn publish_key(p: &Publish) -> DiskKey {
    match p {
        Publish::Write { id, path, .. } | Publish::Delete { id, path, .. } => match id {
            Some(i) => DiskKey::Record(*i),
            None => DiskKey::Resource(path.clone()),
        },
        Publish::Move { id, .. } => DiskKey::Record(*id),
    }
}

/// The disk keys a set of effects changes.
fn effect_disk_keys(effects: &[mdbn_wire::entry::Effect]) -> Vec<DiskKey> {
    use mdbn_wire::entry::Effect as E;
    effects
        .iter()
        .filter_map(|e| match e {
            E::PutRecord(p) => Some(DiskKey::Record(p.id)),
            E::RemoveRecord(p) => Some(DiskKey::Record(p.id)),
            E::PutResource(p) => Some(DiskKey::Resource(p.path.clone())),
            E::RemoveResource(p) => Some(DiskKey::Resource(p.path.clone())),
            _ => None,
        })
        .collect()
}

/// Most `not_published` outcomes kept for `receipt` (the receipt push carries it
/// when it happens).
const KEEP_NOT_PUBLISHED: usize = 4096;

/// How long a mutation may stay `publishing` (the cap every submit wait has). A
/// publish not resolved by then (a deferred batch the store never reports) ends as
/// `not_published`, so the table stays bounded.
pub const PUBLISH_WAIT_MS: i64 = 5 * 60 * 1000;

/// Mutations whose effects are not yet in the files (`receipt.published`).
#[derive(Debug, Default)]
pub(crate) struct PublishWaits {
    /// Per key, the mutations waiting for its next publish.
    waiting: BTreeMap<DiskKey, Vec<B16>>,
    /// Per mutation, keys not yet resolved, whether any was not published, and
    /// when it gives up.
    open: BTreeMap<B16, (usize, bool, i64)>,
    /// Deferred batches and the mutations each satisfies.
    batches: BTreeMap<crate::store::PublishBatch, Vec<(DiskKey, Vec<B16>)>>,
    /// Recent mutations whose effects were not written.
    not_published: std::collections::VecDeque<B16>,
    /// Mutations whose state became final since the last push.
    done: Vec<B16>,
}

impl PublishWaits {
    fn wait(&mut self, m: B16, mut keys: Vec<DiskKey>, now: i64) {
        keys.sort();
        keys.dedup();
        if keys.is_empty() {
            return;
        }
        self.open
            .insert(m, (keys.len(), false, now.saturating_add(PUBLISH_WAIT_MS)));
        for k in keys {
            self.waiting.entry(k).or_default().push(m);
        }
    }

    /// The mutations a publish of `key` issued now satisfies.
    fn issue(&mut self, key: &DiskKey) -> Vec<B16> {
        self.waiting.remove(key).unwrap_or_default()
    }

    fn requeue(&mut self, key: &DiskKey, ms: Vec<B16>) {
        self.waiting.entry(key.clone()).or_default().extend(ms);
    }

    fn resolve(&mut self, m: B16, st: PublishState) {
        let Some(e) = self.open.get_mut(&m) else {
            return;
        };
        e.0 = e.0.saturating_sub(1);
        e.1 |= st == PublishState::NotPublished;
        if e.0 > 0 {
            return;
        }
        let failed = e.1;
        self.open.remove(&m);
        if failed {
            self.not_published.push_back(m);
            if self.not_published.len() > KEEP_NOT_PUBLISHED {
                self.not_published.pop_front();
            }
        }
        self.done.push(m);
    }

    /// Give up on mutations past their deadline: they end as `not_published`, and
    /// nothing waits for them any more.
    fn expire(&mut self, now: i64) {
        let late: Vec<B16> = self
            .open
            .iter()
            .filter(|(_, e)| e.2 <= now)
            .map(|(m, _)| *m)
            .collect();
        if late.is_empty() {
            return;
        }
        let gone: std::collections::BTreeSet<B16> = late.iter().copied().collect();
        self.waiting.retain(|_, ms| {
            ms.retain(|m| !gone.contains(m));
            !ms.is_empty()
        });
        for issued in self.batches.values_mut() {
            for (_, ms) in issued.iter_mut() {
                ms.retain(|m| !gone.contains(m));
            }
        }
        self.batches
            .retain(|_, issued| issued.iter().any(|(_, ms)| !ms.is_empty()));
        for m in late {
            if let Some(e) = self.open.get_mut(&m) {
                e.0 = 1;
            }
            self.resolve(m, PublishState::NotPublished);
        }
    }

    fn state(&self, m: &B16) -> PublishState {
        if self.open.contains_key(m) {
            PublishState::Publishing
        } else if self.not_published.contains(m) {
            PublishState::NotPublished
        } else {
            PublishState::Published
        }
    }
}

/// Flushes (of at most 64 documents each) per deferred-durability window
/// during ingest: bounds what a power loss can take back to about 4k files'
/// ingest, which the next scan redoes.
const INGEST_WINDOW_FLUSHES: u32 = 64;

/// An open deferred-durability window during one ingest round.
#[derive(Default)]
struct IngestWindow {
    open: bool,
    flushes: u32,
}

/// Split off observations of the collection configuration files
/// (`mdbase.yaml` and its lock files): they decide which other paths are
/// resources, so they are ingested first. Order is kept within each part.
fn split_config(observations: Vec<Observation>) -> (Vec<Observation>, Vec<Observation>) {
    let is_config = |p: &str| {
        p == mdbn_core::types::CONFIG_PATH
            || p == mdbn_core::types::LOCK_PATH
            || p == mdbn_core::types::PROVISION_LOCK_PATH
    };
    observations
        .into_iter()
        .partition(|o| is_config(&o.path) || o.moved_from.as_deref().is_some_and(is_config))
}
