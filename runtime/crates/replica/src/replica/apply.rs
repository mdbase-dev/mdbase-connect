//! Applying log items (`log-entry.md` §4, §5).
//!
//! Order of checks for the item at position `p`: integrity (§4.1, stop), stall
//! (§4.2, stop and wait), void (§4.3, a deterministic no-op that still advances the
//! head), then apply (§4.4). Then receipts, rebase and pushes.
//!
//! Each item is committed on its own, atomically with the head. That keeps the
//! state at `p − 1` readable from the store for verification and void checks.

use std::collections::BTreeSet;

use mdbn_core::plan::{PlanOptions, Stage};
use mdbn_wire::client::{IncidentKind, ReceiptState};
use mdbn_wire::common::{B16, Bytes, Text, Uuid, Value};
use mdbn_wire::entry::{DeltaOp, Effect, Status, TextDef, TextDefForm, TextSource};
use mdbn_wire::envelope::{Item, ItemKind};
use mdbn_wire::intent::Op;
use mdbn_wire::log_service::SeqItem;
use mdbn_wire::schema::{SchemaError, Wire};
use mdbn_wire::snapshot::EntityKind;

use super::{Replica, i64_meta};
use crate::api::{ClientApi, ErrorCode, Push};
use crate::convert::{self, CResult, ConvertError};
use crate::plan::{StoreView, effect_keys, record_meta, resource_key};
use crate::seal::OpenError;
use crate::store::{
    AliasRow, ConflictRow, FileLocal, FileRow, Head, LocalReceipt, Prune, ReceiptRow, RecordRow,
    Store, StoreError, TombstoneLast, TombstoneRow, Tx, bucket16, meta_keys,
};
use mdbn_wire::attachment_runtime_v1 as rt;

/// Receipts and tombstones are pruned once both bounds pass (`snapshot.md` §6).
pub const HORIZON_ENTRIES: u64 = 10_000;
/// 180 days in ms.
pub const HORIZON_MS: i64 = 180 * 86_400_000;
/// Maximum path length (`log-entry.md` §10).
/// Decompressed payload cap (`log-entry.md` §10).
const MAX_PAYLOAD: usize = 16 << 20;

/// The outcome of checking one item.
#[derive(Debug)]
pub(crate) enum Outcome {
    /// Stop at `p − 1`: the service gave us a broken log.
    Integrity(String),
    /// Stop at `p − 1`: item `p` is well placed but does not follow our head, so
    /// the service lost (and someone overwrote) part of what we applied.
    Diverged,
    /// Stop at `p − 1` until we can interpret it.
    Stall(IncidentKind, String),
    /// An authenticated entry needs bounded source reads before confirmation.
    SourcePending,
    /// A deterministic no-op.
    Void(&'static str),
    /// Applied.
    Applied,
}

fn text_resolver<'a>(
    texts: &'a [TextDef],
    resolved: &'a [Option<String>],
) -> impl Fn(&Text) -> CResult<String> + 'a {
    move |t| match t {
        Text::Inline(s) => Ok(s.clone()),
        Text::Index(i) => {
            let i = usize::try_from(*i).map_err(|_| ConvertError::Text("index".into()))?;
            if i >= texts.len() {
                return Err(ConvertError::Text(format!("text index {i} out of range")));
            }
            resolved
                .get(i)
                .cloned()
                .flatten()
                .ok_or_else(|| ConvertError::Text(format!("text {i} unresolved")))
        }
    }
}

fn valid_path(p: &str) -> bool {
    mdbn_core::paths::check_path(p).is_ok()
}

impl<S: Store> Replica<S> {
    /// Apply items in log order, starting at the first one after the head.
    pub(crate) fn apply_items(&mut self, items: Vec<SeqItem>) {
        if self.apply_fault {
            return;
        }
        let mut changed: BTreeSet<String> = BTreeSet::new();
        let mut any = false;
        for it in items {
            if it.seq <= self.head.seq {
                continue;
            }
            if it.seq != self.head.seq + 1 {
                // A gap: read what's missing.
                self.head_known = self.head_known.max(it.seq);
                self.caught_up = false;
                break;
            }
            let checkpoint = super::apply_checkpoint::Checkpoint::capture(self);
            let before_head = self.head;
            let before_changed = changed.clone();
            self.retaining = Some(crate::store::TailRow {
                seq: it.seq,
                item: it.item.0.clone(),
                applied_at: self.now(),
            });
            let result = self.apply_one(it.seq, &it.item, &mut changed);
            self.retaining = None;
            let outcome = match result {
                Ok(o) => o,
                Err(e) => {
                    if self.head == before_head {
                        changed = before_changed;
                        self.failed_apply(
                            checkpoint,
                            it.seq,
                            matches!(&e, StoreError::CommitAborted(_)),
                        );
                    }
                    self.incident(
                        IncidentKind::Integrity,
                        Some(Value::Text(format!("store: {e}"))),
                    );
                    break;
                }
            };
            if self
                .apply_blocked
                .is_some_and(|blocked| self.head.seq >= blocked)
            {
                self.apply_blocked = None;
            }
            match outcome {
                Outcome::Applied => {
                    any = true;
                    self.stats.applied += 1;
                }
                Outcome::Void(reason) => {
                    any = true;
                    self.stats.voided += 1;
                    self.incident(
                        IncidentKind::VoidedItems,
                        Some(Value::Map(vec![
                            (
                                "count".into(),
                                Value::Int(i64::try_from(self.stats.voided).unwrap_or(i64::MAX)),
                            ),
                            (
                                "last_seq".into(),
                                Value::Int(i64::try_from(it.seq).unwrap_or(i64::MAX)),
                            ),
                            ("reason".into(), Value::Text(reason.into())),
                        ])),
                    );
                }
                Outcome::Stall(kind, why) => {
                    self.stalled = Some((kind, it.seq));
                    self.incident(kind, Some(Value::Text(why)));
                    if kind == IncidentKind::WaitingForKey {
                        self.join_ahead_on_stall(it.seq);
                    }
                    break;
                }
                Outcome::SourcePending => {
                    self.apply_blocked = Some(it.seq);
                    self.caught_up = false;
                    break;
                }
                Outcome::Integrity(why) => {
                    self.incident(IncidentKind::Integrity, Some(Value::Text(why)));
                    self.caught_up = false;
                    break;
                }
                Outcome::Diverged => {
                    let service = self.head_known.max(it.seq);
                    self.on_lost_tail(super::lost_tail::Signal::Diverged(service));
                    break;
                }
            }
            if self.apply_fault {
                break;
            }
        }
        if !any {
            return;
        }
        if self.head.seq >= self.head_known {
            self.head_known = self.head.seq;
        }
        // A restored revocation clears its latch (and may let planning resume);
        // a restored orphan clears too.
        if let Err(e) = self.clear_latch().and_then(|()| self.review_orphans()) {
            self.incident(
                IncidentKind::Integrity,
                Some(Value::Text(format!("store: {e}"))),
            );
        }
        if self.apply_fault || self.is_apply_recovering() {
            self.apply_deferred_changed.extend(changed);
            self.status_dirty = true;
            return;
        }
        changed.extend(std::mem::take(&mut self.apply_deferred_changed));
        let mut ids = super::live::ids_from_keys(&changed);
        match self.rebuild_local_view(&changed) {
            Ok(more) => ids.extend(more),
            Err(e) => self.incident(
                IncidentKind::Integrity,
                Some(Value::Text(format!("store: {e}"))),
            ),
        }
        self.status_dirty = true;
        self.notify(&ids);
        if let Err(e) = self.materialize() {
            self.incident(
                IncidentKind::Integrity,
                Some(Value::Text(format!("store: {e}"))),
            );
        }
    }

    /// A `base` item (`snapshot.md` §7): check it, then install its generation 0.
    /// Apply waits before the base (no incident) while the staged install runs; the
    /// install swaps in the manifest's state with the head at `p`. A void base only
    /// advances the head.
    fn apply_base(
        &mut self,
        p: u64,
        head: Head,
        item: &Item,
        raw: &[u8],
    ) -> Result<Outcome, StoreError> {
        if self.base_install_failed == Some(p) {
            return Ok(Outcome::Stall(
                IncidentKind::Integrity,
                format!("item {p}: base install failed"),
            ));
        }
        if self.install_base.as_ref().is_some_and(|b| b.seq == p) {
            return Ok(Outcome::SourcePending);
        }
        {
            let env = crate::policy::Env {
                verifier: self.sealer.verifier(),
                trusted_roots: &self.cfg.trusted_roots,
                policy_pins: self.cfg.policy_pins.as_ref(),
            };
            if let Err(r) = self.policy.check_base_header(item, &env) {
                return self.reject(head, r);
            }
        }
        let plain = match self.sealer.open(item, raw) {
            Ok(b) => b,
            Err(OpenError::NoKey) => {
                return Ok(Outcome::Stall(
                    IncidentKind::WaitingForKey,
                    format!("item {p}: no key for its epoch"),
                ));
            }
            Err(OpenError::Aead) => return self.commit_void(head, "V3: AEAD failure"),
        };
        let payload = match mdbn_wire::snapshot::BasePayload::from_bytes(&plain) {
            Ok(b) => b,
            Err(e) if e.is_unknown() => {
                return Ok(Outcome::Stall(
                    IncidentKind::UpgradeRequired,
                    format!("item {p}: {e}"),
                ));
            }
            Err(_) => return self.commit_void(head, "base: payload does not decode"),
        };
        if let Err(r) = self.policy.check_base_source(item, payload.source) {
            return self.reject(head, r);
        }
        if let Err(r) = self.policy.check_base_payload(item, &payload.manifest) {
            return self.reject(head, r);
        }
        let refs = item.refs.clone().unwrap_or_default();
        let parts = |b: &mdbn_wire::intent::BlobRef| self.sealer.blob_part_addresses(b);
        if super::base::check_base(&payload, &refs, &parts).is_err() {
            return self.commit_void(head, "base: payload refs");
        }
        if !self.snapshot_install_available() {
            return Ok(Outcome::Stall(
                IncidentKind::UpgradeRequired,
                format!("item {p}: base install needs a store that stages"),
            ));
        }
        let Some(signer) = item.signer else {
            return self.commit_void(head, "base: no signer");
        };
        self.begin_base_install(
            super::snapshot::BaseInstall {
                seq: p,
                chain: head.chain,
                state_digest: payload.state_digest,
                epoch: item.epoch.unwrap_or(0),
                item: raw.to_vec(),
            },
            payload.manifest,
            signer,
        );
        Ok(Outcome::SourcePending)
    }

    /// Commit the head advance of a void item.
    fn commit_void(&mut self, head: Head, reason: &'static str) -> Result<Outcome, StoreError> {
        self.policy.note_void(head.seq, None);
        self.commit_retained(
            head,
            Tx {
                head: Some(head),
                meta: [Some(self.policy_meta()), self.genesis_meta(head)]
                    .into_iter()
                    .flatten()
                    .collect(),
                ..Tx::default()
            },
        )?;
        self.note_genesis(head);
        Ok(Outcome::Void(reason))
    }

    fn commit_unindexed_invalid_utf8(
        &mut self,
        head: Head,
        payload: &rt::EntryPayload,
        writer: Option<Uuid>,
        changed: &mut BTreeSet<String>,
    ) -> Result<Outcome, StoreError> {
        let reason = "unindexed_markdown_invalid_utf8";
        let mut problem = ErrorCode::InvalidRequest.problem_with_reason(
            reason,
            "authenticated oversized Markdown source is not UTF-8",
        );
        problem.details = Some(Value::Map(vec![
            (
                "writer_device".into(),
                writer.map_or(Value::Null, |id| Value::Text(id.to_hex())),
            ),
            (
                "origin_replica".into(),
                Value::Text(payload.mutation.origin.to_hex()),
            ),
        ]));
        let pending = self.store.pending_get(&payload.mutation.id)?;
        let own = pending
            .as_ref()
            .is_some_and(|p| p.grant == payload.mutation.on_behalf)
            && payload.mutation.origin == self.cfg.replica_id
            && writer == Some(self.cfg.device_id);
        self.policy.note_void(head.seq, None);
        let mut tx = Tx {
            head: Some(head),
            meta: [Some(self.policy_meta()), self.genesis_meta(head)]
                .into_iter()
                .flatten()
                .collect(),
            ..Tx::default()
        };
        tx.receipts_put.push(ReceiptRow {
            mutation: payload.mutation.id,
            seq: head.seq,
            time: payload.mutation.clock.instant,
        });
        // A rival claiming our pending ID cannot replace its ownership/receipt.
        if pending.is_none() || own {
            tx.local_receipts_put.push(LocalReceipt {
                mutation: payload.mutation.id,
                state: ReceiptState::Rejected,
                seq: Some(head.seq),
                status: None,
                conflicts: Vec::new(),
                problem: Some(problem.clone()),
                resolved_at: self.now(),
                grant: payload.mutation.on_behalf,
            });
        }
        if own {
            tx.pending_del.push(payload.mutation.id);
        }
        if self.local_only() {
            self.store.commit(tx)?;
            self.head = head;
        } else {
            self.commit_retained(head, tx)?;
        }
        self.note_genesis(head);
        if own && !self.apply_fault {
            if let Some(row) = pending {
                changed.extend(row.touches);
            }
            let receipt = mdbn_wire::client::Receipt {
                mutation: payload.mutation.id,
                state: ReceiptState::Rejected,
                seq: Some(head.seq),
                status: None,
                conflicts: None,
                records: None,
                problem: Some(problem),
                published: None,
                relocated_from: None,
            };
            self.push_durable_receipt(receipt.clone());
            self.hosted_resolve(&receipt);
        }
        Ok(Outcome::Void(reason))
    }

    /// A policy verdict: a stall stops before `p`; a void advances the head.
    fn reject(&mut self, head: Head, r: crate::policy::Rejected) -> Result<Outcome, StoreError> {
        match r {
            crate::policy::Rejected::Stall(s) => Ok(Outcome::Stall(
                IncidentKind::UpgradeRequired,
                format!("item {}: {s}", head.seq),
            )),
            crate::policy::Rejected::Void(v) => self.commit_void(head, v.rule),
        }
    }

    /// The host's genesis pin (`ReplicaConfig::expected_genesis`): seq 1 must have
    /// exactly the pinned chain hash, and no later item is evaluated by a store that
    /// has not applied (and recorded) the pinned seq 1.
    pub(super) fn check_genesis(&self, p: u64, raw: &[u8]) -> Result<(), String> {
        let Some(want) = self.cfg.expected_genesis else {
            return Ok(());
        };
        if p == 1 {
            if mdbn_wire::hash::chain_hash(raw) != want {
                return Err("item 1: genesis differs from the pinned genesis".into());
            }
        } else if self.genesis != Some(want) {
            return Err(format!("item {p}: the pinned genesis has not been applied"));
        }
        Ok(())
    }

    /// A genesis mismatch is terminal: nothing is served, sealed or appended.
    pub(super) fn genesis_fault(&mut self) {
        self.apply_fault = true;
        self.calls.clear();
        self.inflight.clear();
        self.append = super::append::AppendState::Stopped;
        self.install = None;
        self.build = None;
        self.endorse = None;
        self.pushes.retain(|(_, p)| matches!(p, Push::Closed(_)));
        for id in self.sessions.keys().copied().collect::<Vec<_>>() {
            self.close(id);
            self.pushes.push((
                id,
                Push::Closed(ErrorCode::Unavailable.problem_with_reason(
                    "genesis_mismatch",
                    "the log's genesis differs from the pinned genesis",
                )),
            ));
        }
        self.status_dirty = true;
    }

    /// Seq 1's chain hash, committed with it.
    fn genesis_meta(&self, at: Head) -> Option<(String, Option<Vec<u8>>)> {
        (at.seq == 1).then(|| (meta_keys::GENESIS.to_string(), Some(at.chain.0.to_vec())))
    }

    fn note_genesis(&mut self, at: Head) {
        if at.seq == 1 {
            self.genesis = Some(at.chain);
        }
    }

    /// The persisted policy state.
    pub(crate) fn policy_meta(&self) -> (String, Option<Vec<u8>>) {
        (meta_keys::POLICY.into(), self.policy.to_bytes().ok())
    }

    /// The persisted keyring (secret; the store keeps it with platform protection).
    pub(crate) fn keyring_meta(&self) -> Option<(String, Option<Vec<u8>>)> {
        if self.store.keyring_persistence() == crate::store::KeyringPersistence::RebuildOnOpen {
            // Never handed to the store: the keyring stays in memory only.
            return None;
        }
        self.sealer
            .export()
            .map(|b| (meta_keys::KEYRING.to_string(), Some(b.to_vec())))
    }

    /// `policy`, `rekey`, `key_grant` (policy.md §6, sealed-envelope.md §5).
    fn apply_control_item(
        &mut self,
        p: u64,
        head: Head,
        item: &Item,
    ) -> Result<Outcome, StoreError> {
        self.discard_staged_key_grants();
        let outcome = match self.evaluate_control(p, &head.chain, item, &[]) {
            Err(stall) => {
                self.discard_staged_key_grants();
                return Ok(Outcome::Stall(IncidentKind::UpgradeRequired, stall));
            }
            Ok(None) => Outcome::Applied,
            Ok(Some(rule)) => Outcome::Void(rule),
        };
        let mut meta = vec![self.policy_meta(), self.account_key_meta()];
        meta.extend(self.keyring_meta());
        meta.extend(self.genesis_meta(head));
        let committed = self.commit_retained(
            head,
            Tx {
                head: Some(head),
                meta,
                ..Tx::default()
            },
        );
        if let Err(e) = committed {
            self.discard_staged_key_grants();
            return Err(e);
        }
        // Durable: only now does an own approval grant count as applied.
        self.publish_staged_key_grants();
        self.note_genesis(head);
        self.status_dirty = true;
        self.close_revoked_sessions();
        Ok(outcome)
    }

    /// Evaluate a control item (kinds 2–4, and 6 with `raw`) into the policy state and
    /// keyring, without touching the head. `Ok(None)`: valid; `Ok(Some(rule))`: void;
    /// `Err`: stall.
    pub(crate) fn evaluate_control(
        &mut self,
        p: u64,
        chain: &mdbn_wire::common::Hash,
        item: &Item,
        raw: &[u8],
    ) -> Result<Option<&'static str>, String> {
        if item.kind == ItemKind::GrantApproval {
            let plain = match self.sealer.open(item, raw) {
                Ok(b) => b,
                Err(OpenError::NoKey) => return Err(format!("item {p}: no key for its epoch")),
                Err(OpenError::Aead) => Vec::new(),
            };
            let decoded = mdbn_wire::policy::GrantApprovalPayload::from_bytes(&plain);
            let env = crate::policy::Env {
                verifier: self.sealer.verifier(),
                trusted_roots: &self.cfg.trusted_roots,
                policy_pins: self.cfg.policy_pins.as_ref(),
            };
            return match self.policy.apply_grant_approval(
                p,
                chain,
                item,
                decoded.as_ref().map_err(Clone::clone),
                &env,
            ) {
                Ok(()) => Ok(None),
                Err(crate::policy::Rejected::Void(v)) => Ok(Some(v.rule)),
                Err(crate::policy::Rejected::Stall(s)) => Err(format!("item {p}: {s}")),
            };
        }
        let env = crate::policy::Env {
            verifier: self.sealer.verifier(),
            trusted_roots: &self.cfg.trusted_roots,
            policy_pins: self.cfg.policy_pins.as_ref(),
        };
        let verdict = self.policy.apply_control(p, chain, item, &env);
        let r = match verdict {
            Err(crate::policy::Rejected::Stall(s)) => return Err(format!("item {p}: {s}")),
            Err(crate::policy::Rejected::Void(v)) => Some(v.rule),
            Ok(events) => {
                for e in events {
                    self.on_policy_event(e);
                }
                self.note_account_key_item(item);
                match item.kind {
                    ItemKind::Rekey => {
                        if let Ok(rk) = mdbn_wire::envelope::RekeyPayload::from_bytes(&item.body.0)
                        {
                            let ev = self.sealer.accept_rekey(&rk);
                            self.note_hosted_key_delivery(p, item, ev);
                            self.on_key_event(ev);
                        }
                    }
                    ItemKind::KeyGrant => {
                        if let Ok(kg) =
                            mdbn_wire::envelope::KeyGrantPayload::from_bytes(&item.body.0)
                        {
                            let ev = self.sealer.accept_key_grant(&kg);
                            self.note_hosted_key_delivery(p, item, ev);
                            self.on_key_event(ev);
                            self.stage_private_key_grant_applied(item.signer, kg.recipient, p);
                        }
                    }
                    _ => {}
                }
                None
            }
        };
        self.sealer.set_epoch(self.policy.epoch);
        self.check_key_trust();
        Ok(r)
    }

    /// A control item read during a snapshot install (`snapshot.md` §8 step 1):
    /// evaluated into policy and keys and persisted; the head is set by the install.
    pub(crate) fn evaluate_control_bytes(&mut self, p: u64, raw: &[u8]) -> Result<(), String> {
        if self.apply_fault {
            return Err("apply state is faulted; reopen required".into());
        }
        if let Err(why) = self.check_genesis(p, raw) {
            self.genesis_fault();
            return Err(format!("control {why}"));
        }
        let item = Item::from_bytes(raw).map_err(|e| format!("control item {p}: {e}"))?;
        if item.seq != Some(p) || item.collection != self.cfg.collection || !item.kind.is_control()
        {
            return Err(format!("control item {p}: position, collection or kind"));
        }
        let chain = mdbn_wire::hash::chain_hash(raw);
        let checkpoint = super::apply_checkpoint::Checkpoint::capture(self);
        self.discard_staged_key_grants();
        if let Err(e) = self.evaluate_control(p, &chain, &item, raw) {
            self.discard_staged_key_grants();
            return Err(e);
        }
        let at = Head { seq: p, chain };
        let mut meta = vec![self.policy_meta(), self.account_key_meta()];
        meta.extend(self.keyring_meta());
        meta.extend(self.genesis_meta(at));
        // Read-ahead (snapshot install) persists policy but restores no applied
        // prefix: an own approval grant seen here never counts as Applied. The
        // pending grant stays Sent and resolves conservatively later (refused or
        // cancelled once the device is keyed in the applied policy).
        self.discard_staged_key_grants();
        if let Err(e) = self.store.commit(Tx {
            meta,
            ..Tx::default()
        }) {
            self.failed_apply(checkpoint, p, matches!(&e, StoreError::CommitAborted(_)));
            return Err(format!("store: {e}"));
        }
        self.note_genesis(at);
        // Persisted read-ahead policy alone does not restore the applied prefix.
        if self
            .apply_blocked
            .is_some_and(|blocked| self.head.seq >= blocked)
        {
            self.apply_blocked = None;
        }
        Ok(())
    }

    /// A sealed `grant_approval` (`policy.md` §5.1).
    fn apply_grant_approval_item(
        &mut self,
        p: u64,
        head: Head,
        item: &Item,
        raw: &[u8],
    ) -> Result<Outcome, StoreError> {
        let outcome = match self.evaluate_control(p, &head.chain, item, raw) {
            Err(stall) => {
                let kind = if stall.contains("no key") {
                    IncidentKind::WaitingForKey
                } else {
                    IncidentKind::UpgradeRequired
                };
                return Ok(Outcome::Stall(kind, stall));
            }
            Ok(None) => Outcome::Applied,
            Ok(Some(rule)) => Outcome::Void(rule),
        };
        self.commit_retained(
            head,
            Tx {
                head: Some(head),
                meta: [Some(self.policy_meta()), self.genesis_meta(head)]
                    .into_iter()
                    .flatten()
                    .collect(),
                ..Tx::default()
            },
        )?;
        self.note_genesis(head);
        Ok(outcome)
    }

    pub(crate) fn on_key_event(&mut self, ev: crate::seal::KeyEvent) {
        match ev {
            crate::seal::KeyEvent::Inconsistent => {
                self.incident(IncidentKind::KeyInconsistent, None);
            }
            crate::seal::KeyEvent::Keyed { .. } => {
                self.clear_incident(IncidentKind::WaitingForKey);
                // A stall waiting for this key can proceed.
                if matches!(self.stalled, Some((IncidentKind::WaitingForKey, _))) {
                    self.stalled = None;
                    self.key_wait_read.clear();
                }
            }
            crate::seal::KeyEvent::None => {}
        }
    }

    fn on_policy_event(&mut self, e: crate::policy::PolicyEvent) {
        match e {
            crate::policy::PolicyEvent::PolicyKeyCompromised { positions, .. } => {
                self.incident(
                    IncidentKind::Integrity,
                    Some(Value::Text(format!(
                        "policy_key_compromised: {} earlier items signed by a revoked key",
                        positions.len()
                    ))),
                );
            }
            crate::policy::PolicyEvent::CollectionStateChanged { to, .. } => {
                // Every device alerts unless its own user requested the change.
                if self.cfg.chosen_state != Some(to) {
                    self.incident(
                        IncidentKind::Integrity,
                        Some(Value::Text(format!("collection_state_changed: {to:?}"))),
                    );
                }
            }
        }
    }

    /// Device-local key trust: a key that reached this device only through
    /// devices its user never approved is not used for sealing.
    pub(crate) fn check_key_trust(&mut self) {
        let mut trusted: std::collections::BTreeSet<mdbn_wire::common::Uuid> =
            self.cfg.trusted_signers.iter().copied().collect();
        // Account-key devices this device's user unlocked (AK1).
        trusted.extend(self.account_key.trusted().iter().copied());
        let t = self.policy.key_trust(
            &self.cfg.device_id,
            &trusted,
            self.cfg.user_enabled_cloud_copy,
        );
        let untrusted = matches!(t, crate::policy::KeyTrust::Untrusted { .. });
        if untrusted && !self.key_untrusted {
            self.incident(
                IncidentKind::KeyInconsistent,
                Some(Value::Text("key_untrusted".into())),
            );
        }
        if !untrusted && self.key_untrusted {
            self.clear_incident(IncidentKind::KeyInconsistent);
        }
        self.key_untrusted = untrusted;
    }

    fn apply_one(
        &mut self,
        p: u64,
        bytes: &Bytes,
        changed: &mut BTreeSet<String>,
    ) -> Result<Outcome, StoreError> {
        // The host's genesis pin, on the raw bytes before anything is decoded.
        if let Err(why) = self.check_genesis(p, &bytes.0) {
            self.genesis_fault();
            return Ok(Outcome::Integrity(why));
        }
        // A prior successful commit's accounting read may have failed. Refresh
        // before any new policy/keyring evaluation or retention-cap decision.
        self.refresh_retained_stats()?;
        // §4.1 integrity, §4.2 unknown envelope variants.
        let item = match Item::from_bytes(&bytes.0) {
            Ok(i) => i,
            Err(e) if e.is_unknown() => {
                return Ok(Outcome::Stall(
                    IncidentKind::UpgradeRequired,
                    format!("item {p}: {e}"),
                ));
            }
            Err(e) => return Ok(Outcome::Integrity(format!("item {p} does not decode: {e}"))),
        };
        if item.seq == Some(p)
            && item.collection == self.cfg.collection
            && item.prev != Some(self.head.chain)
        {
            return Ok(Outcome::Diverged);
        }
        if item.seq != Some(p)
            || item.prev != Some(self.head.chain)
            || item.collection != self.cfg.collection
        {
            return Ok(Outcome::Integrity(format!(
                "item {p}: position, chain or collection mismatch"
            )));
        }
        if !item.kind.is_log_item() || item.check_shape().is_err() {
            return Ok(Outcome::Integrity(format!(
                "item {p}: not a well-formed log item"
            )));
        }
        let head = Head {
            seq: p,
            chain: mdbn_wire::hash::chain_hash(&bytes.0),
        };
        if item.kind.is_control() && p <= self.policy.seq {
            // Applied while installing a snapshot: only the head advances here.
            self.commit_retained(
                head,
                Tx {
                    head: Some(head),
                    ..Tx::default()
                },
            )?;
            return Ok(Outcome::Applied);
        }
        match item.kind {
            ItemKind::Entry => self.apply_entry(p, head, &item, &bytes.0, changed),
            ItemKind::Policy | ItemKind::Rekey | ItemKind::KeyGrant => {
                self.apply_control_item(p, head, &item)
            }
            ItemKind::GrantApproval => self.apply_grant_approval_item(p, head, &item, &bytes.0),
            ItemKind::Base => self.apply_base(p, head, &item, &bytes.0),
            _ => Ok(Outcome::Integrity(format!(
                "item {p}: object kind in the log"
            ))),
        }
    }

    fn resolve_texts(
        &self,
        texts: &Option<Vec<TextDef>>,
    ) -> Result<Vec<Option<String>>, &'static str> {
        let texts = texts.clone().unwrap_or_default();
        let mut out: Vec<Option<String>> = Vec::with_capacity(texts.len());
        for (i, t) in texts.iter().enumerate() {
            let s = match t {
                TextDef::Literal(s) => s.clone(),
                TextDef::Form(TextDefForm::Delta(d)) => {
                    let src: Vec<u8> = match &d.source {
                        TextSource::PrevRecord(id) => {
                            if let Some(r) = self.store.record(id).ok().flatten() {
                                r.doc.into_bytes()
                            } else if let Some(t) = self.store.tombstone(id).ok().flatten() {
                                match t.last {
                                    TombstoneLast::Doc(d) => d.into_bytes(),
                                    TombstoneLast::Blob(_)
                                    | TombstoneLast::Attachment(_)
                                    | TombstoneLast::UnindexedMarkdown(_) => {
                                        return Err("delta source is a file");
                                    }
                                }
                            } else {
                                return Err("delta source record missing");
                            }
                        }
                        TextSource::Earlier(j) => {
                            let j = usize::try_from(*j).map_err(|_| "earlier index")?;
                            if j >= i {
                                return Err("earlier index not smaller");
                            }
                            out[j]
                                .clone()
                                .ok_or("earlier text unresolved")?
                                .into_bytes()
                        }
                        TextSource::PrevResource(path) => self
                            .store
                            .resource(path)
                            .ok()
                            .flatten()
                            .ok_or("delta source resource missing")?
                            .into_bytes(),
                    };
                    let b = DeltaOp::apply(&src, &d.ops).ok_or("delta out of bounds")?;
                    String::from_utf8(b).map_err(|_| "delta result is not UTF-8")?
                }
                TextDef::Form(TextDefForm::Blob(_)) => return Err("blob-backed text"),
            };
            out.push(Some(s));
        }
        Ok(out)
    }

    fn apply_entry(
        &mut self,
        p: u64,
        head: Head,
        item: &Item,
        raw: &[u8],
        changed: &mut BTreeSet<String>,
    ) -> Result<Outcome, StoreError> {
        // V1, V2 and frozen, from the clear header and the policy at p − 1.
        {
            let env = crate::policy::Env {
                verifier: self.sealer.verifier(),
                trusted_roots: &self.cfg.trusted_roots,
                policy_pins: self.cfg.policy_pins.as_ref(),
            };
            if let Err(r) = self.policy.check_entry_header(item, &env) {
                return self.reject(head, r);
            }
        }
        // V3 / stall on missing keys.
        let plain = match self.sealer.open(item, raw) {
            Ok(b) => b,
            Err(OpenError::NoKey) => {
                return Ok(Outcome::Stall(
                    IncidentKind::WaitingForKey,
                    format!("item {p}: no key for its epoch"),
                ));
            }
            Err(OpenError::Aead) => return self.commit_void(head, "V3: AEAD failure"),
        };
        if plain.len() > MAX_PAYLOAD {
            return self.commit_void(head, "V7: payload too large");
        }
        // V4 / stall on unknown payload variants.
        // Decoded once with the attachment runtime family (`log-entry.md` §2.5,
        // `intent.md` §3.11): legacy and attachment-v1 content apply alike.
        let payload = match rt::EntryPayload::from_bytes(&plain) {
            Ok(pl) => pl,
            Err(e) if is_unknown_deep(&e) => {
                return Ok(Outcome::Stall(
                    IncidentKind::UpgradeRequired,
                    format!("item {p}: {e}"),
                ));
            }
            Err(_) => {
                return self.commit_void(head, "V4: payload does not decode");
            }
        };
        if let Some(why) = super::attachment_runtime::extended_entry_not_yet(&payload) {
            return Ok(Outcome::Stall(
                IncidentKind::UpgradeRequired,
                why.to_string(),
            ));
        }
        // V5: semantics ratchet.
        if payload.sem.major < self.sem_ratchet() {
            return self.commit_void(head, "V5: semantics major below the ratchet");
        }
        // V5/V6 under the policy at p − 1 (grants, capabilities, folders).
        {
            let store = &self.store;
            let path_key = |p: &str| mdbn_core::paths::path_key(p);
            let file_path =
                |id: &mdbn_wire::common::Uuid| store.file(id).ok().flatten().map(|f| f.path);
            let ctx = crate::policy::OpContext {
                path_key: &path_key,
                file_path: &file_path,
            };
            let Some(signer) = item.signer.as_ref() else {
                return self.commit_void(head, "V1: missing entry signer");
            };
            if let Err(r) = self
                .policy
                .check_runtime_entry_payload(&payload, signer, &ctx)
            {
                return self.reject(head, r);
            }
        }

        self.apply_payload_signed(p, head, payload, changed, item.signer, item.refs.as_deref())
    }

    fn commit_payload_void(
        &mut self,
        head: Head,
        payload: &rt::EntryPayload,
        reason: &'static str,
    ) -> Result<Outcome, StoreError> {
        if self.local_only() {
            self.commit_local_void(head, payload, reason)
        } else {
            self.commit_void(head, reason)
        }
    }

    /// Apply authorized payload effects. The synced caller still validates the
    /// authenticated original signer; local callers recheck trusted host authority.
    pub(crate) fn apply_payload(
        &mut self,
        p: u64,
        head: Head,
        payload: rt::EntryPayload,
        changed: &mut BTreeSet<String>,
    ) -> Result<Outcome, StoreError> {
        self.apply_payload_signed(p, head, payload, changed, Some(self.cfg.device_id), None)
    }
    fn apply_payload_signed(
        &mut self,
        p: u64,
        head: Head,
        payload: rt::EntryPayload,
        changed: &mut BTreeSet<String>,
        writer: Option<Uuid>,
        refs: Option<&[mdbn_wire::common::Hash]>,
    ) -> Result<Outcome, StoreError> {
        if let Some(why) = super::attachment_runtime::extended_entry_not_yet(&payload) {
            return Ok(Outcome::Stall(
                IncidentKind::UpgradeRequired,
                why.to_string(),
            ));
        }
        self.apply_payload_ready(p, head, payload, changed, writer, refs)
    }
    // Focused actor fixtures supply the original declared refs explicitly.
    #[cfg(test)]
    pub(crate) fn test_apply_authorized_unindexed_with_refs(
        &mut self,
        p: u64,
        head: Head,
        payload: rt::EntryPayload,
        changed: &mut BTreeSet<String>,
        writer: Uuid,
        refs: &[mdbn_wire::common::Hash],
    ) -> Result<Outcome, StoreError> {
        self.apply_payload_ready(p, head, payload, changed, Some(writer), Some(refs))
    }
    fn apply_payload_ready(
        &mut self,
        p: u64,
        head: Head,
        payload: rt::EntryPayload,
        changed: &mut BTreeSet<String>,
        writer: Option<Uuid>,
        refs: Option<&[mdbn_wire::common::Hash]>,
    ) -> Result<Outcome, StoreError> {
        if payload.mutation.on_behalf.is_some() {
            for op in &payload.mutation.ops {
                let id = match op {
                    rt::Op::Legacy(Op::FileDelete(f)) => Some(f.id),
                    rt::Op::Legacy(Op::FileMove(f)) => Some(f.id),
                    rt::Op::Legacy(Op::FilePut(f)) => Some(f.id),
                    rt::Op::FileAttach(f) => Some(f.id),
                    _ => None,
                };
                if let Some(id) = id && self.store.file(&id)?.is_some_and(|f| {
                    f.kind == mdbn_wire::unindexed_markdown::FileKindV1::UnindexedOversizedMarkdown
                }) {
                    return Ok(Outcome::Stall(
                        IncidentKind::UpgradeRequired,
                        "delegated native file mediation is not supported".into(),
                    ));
                }
            }
        }
        // V7: results are structurally valid.
        let resolved =
            zeroize::Zeroizing::new(match self.reverse_text_check(head, &payload, refs) {
                super::unindexed_reverse_text::Check::Legacy => {
                    let Ok(texts) = self.resolve_texts(&payload.texts) else {
                        return self.commit_payload_void(head, &payload, "V7: text table");
                    };
                    texts
                }
                super::unindexed_reverse_text::Check::Ready(texts) => texts,
                super::unindexed_reverse_text::Check::Pending => return Ok(Outcome::SourcePending),
                super::unindexed_reverse_text::Check::InvalidShape => {
                    return self.commit_payload_void(
                        head,
                        &payload,
                        "V7: reverse text descriptor or refs",
                    );
                }
                super::unindexed_reverse_text::Check::InvalidUtf8 => {
                    return self.commit_unindexed_invalid_utf8(head, &payload, writer, changed);
                }
                super::unindexed_reverse_text::Check::Failed(
                    crate::attachments::StreamError::NoKey,
                ) => {
                    return Ok(Outcome::Stall(
                        IncidentKind::WaitingForKey,
                        "reverse text key unavailable".into(),
                    ));
                }
                super::unindexed_reverse_text::Check::Failed(e) => {
                    self.incident(
                        IncidentKind::Integrity,
                        Some(Value::Text(format!("reverse text source: {e:?}"))),
                    );
                    self.reverse_text_retry(head);
                    return Ok(Outcome::SourcePending);
                }
            });
        let texts = payload.texts.clone().unwrap_or_default();
        let t = text_resolver(&texts, &resolved);
        let effects: Vec<rt::Effect> = match payload
            .effects
            .iter()
            .map(|e| match e {
                rt::Effect::Legacy(e) => convert::resolve_effect(e, &t).map(rt::Effect::Legacy),
                rt::Effect::PutAttachmentFile(a) => Ok(rt::Effect::PutAttachmentFile(a.clone())),
                rt::Effect::PutUnindexedMarkdown(f) => {
                    Ok(rt::Effect::PutUnindexedMarkdown(f.clone()))
                }
                rt::Effect::ReindexUnindexedMarkdown(r) => {
                    Ok(rt::Effect::ReindexUnindexedMarkdown(
                        mdbn_wire::unindexed_markdown::ReindexUnindexedMarkdown {
                            id: r.id,
                            path: r.path.clone(),
                            doc: Text::Inline(t(&r.doc)?),
                        },
                    ))
                }
                rt::Effect::ReindexOrdinaryFile(_) => {
                    Err(convert::ConvertError::OrdinaryFilePromotionUnsupported)
                }
            })
            .collect::<CResult<Vec<_>>>()
        {
            Ok(e) => e,
            Err(_) => return self.commit_payload_void(head, &payload, "V7: effect texts"),
        };
        let conflicts = match payload
            .conflicts
            .iter()
            .flatten()
            .map(|c| resolve_runtime_conflict(c, &t))
            .collect::<CResult<Vec<_>>>()
        {
            Ok(c) => c,
            Err(_) => return self.commit_payload_void(head, &payload, "V7: conflict texts"),
        };
        let conflict_blob_ok = conflicts.iter().all(|c| {
            [Some(&c.kept), Some(&c.lost), c.base.as_ref()]
                .into_iter()
                .flatten()
                .all(|v| match v {
                    rt::ConflictValue::Legacy(mdbn_wire::entry::ConflictValue::Blob(b)) => {
                        blob_ref_in_bounds(b)
                    }
                    rt::ConflictValue::Attachment(a) => self.attachment_in_bounds(a),
                    rt::ConflictValue::UnindexedMarkdown(f) => {
                        self.unindexed_content_in_bounds(&f.content)
                    }
                    rt::ConflictValue::Legacy(_) => true,
                })
        });
        if !conflict_blob_ok {
            return self.commit_payload_void(
                head,
                &payload,
                "V7: blob part size or count out of range",
            );
        }
        if (payload.status == Status::Conflicted) == conflicts.is_empty() {
            return self.commit_payload_void(
                head,
                &payload,
                "V7: status inconsistent with conflicts",
            );
        }
        if payload.mutation.ops.len() > 1000 {
            return self.commit_payload_void(head, &payload, "V7: too many operations");
        }
        if payload.mutation.source == mdbn_wire::intent::Source::External
            && payload.mutation.ops.iter().any(|o| {
                !matches!(
                    o,
                    rt::Op::Legacy(
                        Op::Document(_) | Op::FilePut(_) | Op::FileDelete(_) | Op::FileMove(_)
                    ) | rt::Op::FileAttach(_)
                        | rt::Op::UnindexedMarkdownPut(_)
                        | rt::Op::RecordToUnindexedMarkdown(_)
                        | rt::Op::UnindexedMarkdownToRecord(_)
                )
            })
        {
            return self.commit_payload_void(
                head,
                &payload,
                "V7: external source on an api-only operation",
            );
        }
        let mutation = match convert::runtime_mutation(&payload.mutation, &t) {
            Ok(m) => m,
            Err(_) => return self.commit_payload_void(head, &payload, "V7: mutation texts"),
        };

        let native = super::unindexed_apply::contains_native(&payload);
        // T6b always verifies full kind/path/prior CAS, even for our own entry or
        // when optional legacy result checking is disabled.
        if native
            && payload.mutation.ops.iter().any(|op| match op {
                rt::Op::UnindexedMarkdownPut(f) => {
                    !self.unindexed_content_in_bounds(&f.payload.content)
                }
                rt::Op::RecordToUnindexedMarkdown(f) => {
                    !self.unindexed_content_in_bounds(&f.payload.content)
                }
                _ => false,
            })
        {
            return self.commit_payload_void(head, &payload, "V7: unindexed source descriptor");
        }
        // Verification (log-entry.md §5) against the state at p − 1.
        if native || (self.cfg.verify && payload.mutation.origin != self.cfg.replica_id) {
            let sem = mdbn_core::semantics::SEM;
            if payload.sem.major == sem.major && payload.sem.minor == sem.minor {
                let view = StoreView::new(&self.store, self.catalog.clone());
                // The marker selects resurrection semantics only; it never widens
                // what verification accepts.
                let stage = if payload.resurrect.is_some() {
                    Stage::Resurrect
                } else {
                    Stage::Head
                };
                let r = self.planner.plan(&mutation, &view, &PlanOptions { stage });
                if native && let Some(e) = view.error() {
                    return Err(e);
                }
                let ok = match r {
                    Ok(pl) => {
                        convert::wstatus(pl.status) == payload.status
                            && pl
                                .effects
                                .iter()
                                .map(convert::wruntime_effect)
                                .collect::<CResult<Vec<_>>>()
                                .as_ref()
                                == Ok(&effects)
                            && pl
                                .conflicts
                                .iter()
                                .map(convert::wruntime_conflict)
                                .collect::<CResult<Vec<_>>>()
                                .as_ref()
                                == Ok(&conflicts)
                            && pl.aliases.iter().map(convert::walias).collect::<Vec<_>>()
                                == payload.aliases.clone().unwrap_or_default()
                    }
                    Err(_) => false,
                };
                if ok {
                    if !native {
                        self.stats.verified += 1;
                    }
                } else {
                    if native {
                        return self.commit_payload_void(
                            head,
                            &payload,
                            "V7: unindexed result or prior CAS mismatch",
                        );
                    }
                    self.stats.verify_mismatch += 1;
                    self.incident(
                        IncidentKind::VerificationMismatch,
                        Some(Value::Map(vec![
                            (
                                "seq".into(),
                                Value::Int(i64::try_from(p).unwrap_or(i64::MAX)),
                            ),
                            (
                                "count".into(),
                                Value::Int(
                                    i64::try_from(self.stats.verify_mismatch).unwrap_or(i64::MAX),
                                ),
                            ),
                        ])),
                    );
                }
            } else {
                if native {
                    return Ok(Outcome::Stall(
                        IncidentKind::UpgradeRequired,
                        "T6b semantics cannot be verified".into(),
                    ));
                }
                self.stats.unverified += 1;
            }
        }
        let source_meta = if native {
            match self.unindexed_source_check(head, &payload, refs) {
                super::unindexed_apply::Check::StoreFailed(e) => return Err(e),
                super::unindexed_apply::Check::Pending => return Ok(Outcome::SourcePending),
                super::unindexed_apply::Check::Ready(meta) => {
                    self.stats.verified += 1;
                    meta
                }
                super::unindexed_apply::Check::InvalidUtf8 => {
                    return self.commit_unindexed_invalid_utf8(head, &payload, writer, changed);
                }
                super::unindexed_apply::Check::InvalidRefs => {
                    return self.commit_payload_void(head, &payload, "V7: native source refs");
                }
                super::unindexed_apply::Check::Failed(crate::attachments::StreamError::NoKey) => {
                    return Ok(Outcome::Stall(
                        IncidentKind::WaitingForKey,
                        "T6b source key unavailable".into(),
                    ));
                }
                super::unindexed_apply::Check::Failed(e) => {
                    self.incident(
                        IncidentKind::Integrity,
                        Some(Value::Text(format!("T6b source: {e:?}"))),
                    );
                    self.unindexed_source_retry(head, &payload);
                    return Ok(Outcome::SourcePending);
                }
            }
        } else {
            Vec::new()
        };

        // Build the transaction, checking V7 against current state as we go.
        let instant = payload.mutation.clock.instant;
        let mut tx = Tx {
            head: Some(head),
            meta: source_meta,
            ..Tx::default()
        };
        // Path keys this entry frees and takes, to check collisions after all effects.
        let mut taken: std::collections::BTreeMap<String, Uuid> = std::collections::BTreeMap::new();
        let mut freed: BTreeSet<String> = BTreeSet::new();
        let mut catalog_changed = false;
        for e in &effects {
            let e = match e {
                rt::Effect::Legacy(e) => e,
                rt::Effect::PutUnindexedMarkdown(f) => {
                    if !valid_path(&f.path) || !self.unindexed_content_in_bounds(&f.payload.content)
                    {
                        return self.commit_payload_void(
                            head,
                            &payload,
                            "V7: unindexed effect descriptor or path",
                        );
                    }
                    let old = tx
                        .files_put
                        .iter()
                        .rev()
                        .find(|o| o.id == f.id)
                        .cloned()
                        .or(self.store.file(&f.id)?);
                    if old.as_ref().is_some_and(|o|o.kind!=mdbn_wire::unindexed_markdown::FileKindV1::UnindexedOversizedMarkdown) {
                        return self.commit_payload_void(head,&payload,"V7: unindexed effect changes ordinary kind");
                    }
                    if let Some(o) = &old {
                        freed.insert(o.path_key.clone());
                    }
                    if let Some(r) = self.store.record(&f.id)? {
                        freed.insert(r.path_key);
                        if self.store.materializes_attachments() {
                            tx.meta.push(super::attachment_fetch::shown_meta(
                                &f.id,
                                Some((&r.path, r.revision)),
                            ));
                        }
                        tx.records_del.push(f.id);
                    }
                    tx.records_put.retain(|r| r.id != f.id);
                    tx.files_del.retain(|id| *id != f.id);
                    tx.files_put.retain(|r| r.id != f.id);
                    if self.store.tombstone(&f.id)?.is_some() {
                        tx.tombstones_del.push(f.id);
                    }
                    taken.retain(|_, id| *id != f.id);
                    let pk = mdbn_core::paths::path_key(&f.path);
                    if taken.insert(pk.clone(), f.id).is_some_and(|id| id != f.id) {
                        return self.commit_payload_void(
                            head,
                            &payload,
                            "V7: two entries share a path",
                        );
                    }
                    let local = old
                        .as_ref()
                        .filter(|o| o.content == f.payload.content)
                        .map_or(FileLocal::Remote, |o| o.local);
                    tx.files_put.push(FileRow {
                        id: f.id,
                        path: f.path.clone(),
                        path_key: pk,
                        kind: mdbn_wire::unindexed_markdown::FileKindV1::UnindexedOversizedMarkdown,
                        content: f.payload.content.clone(),
                        media: media_class(&f.path),
                        modified_seq: p,
                        bucket: bucket16(&f.id),
                        local,
                    });
                    continue;
                }
                rt::Effect::ReindexUnindexedMarkdown(r) => {
                    let old = tx
                        .files_put
                        .iter()
                        .rev()
                        .find(|o| o.id == r.id)
                        .cloned()
                        .or(self.store.file(&r.id)?);
                    let Some(old)=old.filter(|o|o.kind==mdbn_wire::unindexed_markdown::FileKindV1::UnindexedOversizedMarkdown) else {
                        return self.commit_payload_void(head,&payload,"V7: reindex requires unindexed holder");
                    };
                    let Text::Inline(doc) = &r.doc else {
                        return self.commit_payload_void(
                            head,
                            &payload,
                            "V7: unresolved reindex source",
                        );
                    };
                    if !valid_path(&r.path)
                        || doc.len() as u64 > mdbn_wire::unindexed_markdown::RECORD_SOURCE_CAP_BYTES
                    {
                        return self.commit_payload_void(
                            head,
                            &payload,
                            "V7: reindex source or path",
                        );
                    }
                    if self.store.has_files() {
                        self.before
                            .entry(super::disk::DiskKey::Record(r.id))
                            .or_insert(Some(super::disk::Shown {
                                path: old.path.clone(),
                                rev: old.content.plain_hash(),
                            }));
                    }
                    freed.insert(old.path_key);
                    taken.retain(|_, id| *id != r.id);
                    let pk = mdbn_core::paths::path_key(&r.path);
                    if taken.insert(pk.clone(), r.id).is_some_and(|id| id != r.id) {
                        return self.commit_payload_void(
                            head,
                            &payload,
                            "V7: two entries share a path",
                        );
                    }
                    tx.files_put.retain(|f| f.id != r.id);
                    tx.files_del.push(r.id);
                    tx.records_put.retain(|f| f.id != r.id);
                    tx.records_del.retain(|id| *id != r.id);
                    tx.records_put.push(RecordRow {
                        id: r.id,
                        path: r.path.clone(),
                        path_key: pk,
                        doc: doc.clone(),
                        revision: mdbn_wire::hash::sha256(doc.as_bytes()),
                        modified_seq: p,
                        bucket: bucket16(&r.id),
                        meta: Default::default(),
                    });
                    continue;
                }
                rt::Effect::ReindexOrdinaryFile(_) => {
                    return Ok(Outcome::Stall(
                        IncidentKind::UpgradeRequired,
                        "extended effect apply not yet supported".into(),
                    ));
                }
                rt::Effect::PutAttachmentFile(f) => {
                    if !valid_path(&f.path) {
                        return self.commit_payload_void(head, &payload, "V7: invalid path");
                    }
                    if !self.attachment_in_bounds(&f.content) {
                        return self.commit_payload_void(
                            head,
                            &payload,
                            "V7: attachment descriptor out of range",
                        );
                    }
                    let old = self.store.file(&f.id)?;
                    if old.as_ref().is_some_and(|o| {
                        o.kind != mdbn_wire::unindexed_markdown::FileKindV1::Ordinary
                    }) {
                        return self.commit_payload_void(
                            head,
                            &payload,
                            "V7: ordinary effect changes file kind",
                        );
                    }
                    if let Some(o) = &old {
                        freed.insert(o.path_key.clone());
                    }
                    if self.store.tombstone(&f.id)?.is_some() {
                        tx.tombstones_del.push(f.id);
                    }
                    let pk = mdbn_core::paths::path_key(&f.path);
                    if taken.insert(pk.clone(), f.id).is_some_and(|o| o != f.id) {
                        return self.commit_payload_void(
                            head,
                            &payload,
                            "V7: two entries share a path",
                        );
                    }
                    // The row keeps the signed descriptor, never bytes. Same
                    // content (a move, a re-put) keeps its local state: a rename
                    // is metadata only and refetches nothing.
                    let content =
                        mdbn_wire::attachment::FileContent::AttachmentV1(f.content.clone());
                    let local = match &old {
                        Some(o) if o.content == content => o.local,
                        _ => FileLocal::Remote,
                    };
                    tx.files_put.retain(|x| x.id != f.id);
                    tx.files_del.retain(|x| *x != f.id);
                    tx.files_put.push(FileRow {
                        id: f.id,
                        path: f.path.clone(),
                        path_key: pk,
                        kind: mdbn_wire::unindexed_markdown::FileKindV1::Ordinary,
                        content,
                        media: media_class(&f.path),
                        modified_seq: p,
                        bucket: bucket16(&f.id),
                        local,
                    });
                    continue;
                }
            };
            match e {
                Effect::PutRecord(r) => {
                    let Text::Inline(doc) = &r.doc else {
                        return self.commit_payload_void(head, &payload, "V7: unresolved text");
                    };
                    if !valid_path(&r.path) {
                        return self.commit_payload_void(head, &payload, "V7: invalid path");
                    }
                    if self.store.file(&r.id)?.is_some_and(|f|f.kind==mdbn_wire::unindexed_markdown::FileKindV1::UnindexedOversizedMarkdown) {
                        return self.commit_payload_void(head,&payload,"V7: ordinary record effect changes unindexed kind");
                    }
                    if let Some(old) = self.store.record(&r.id)? {
                        freed.insert(old.path_key);
                    }
                    if self.store.tombstone(&r.id)?.is_some() {
                        tx.tombstones_del.push(r.id);
                    }
                    let pk = mdbn_core::paths::path_key(&r.path);
                    if taken.insert(pk.clone(), r.id).is_some_and(|o| o != r.id) {
                        return self.commit_payload_void(
                            head,
                            &payload,
                            "V7: two records share a path",
                        );
                    }
                    tx.records_del.retain(|x| *x != r.id);
                    tx.records_put.retain(|x| x.id != r.id);
                    tx.records_put.push(RecordRow {
                        id: r.id,
                        path: r.path.clone(),
                        path_key: pk,
                        doc: doc.clone(),
                        revision: mdbn_wire::hash::sha256(doc.as_bytes()),
                        modified_seq: p,
                        bucket: bucket16(&r.id),
                        meta: Default::default(),
                    });
                }
                Effect::RemoveRecord(r) => {
                    let Some(old) = self.store.record(&r.id)? else {
                        if tx.records_put.iter().any(|x| x.id == r.id) {
                            tx.records_put.retain(|x| x.id != r.id);
                            continue;
                        }
                        return self.commit_payload_void(
                            head,
                            &payload,
                            "V7: remove of an unknown record",
                        );
                    };
                    freed.insert(old.path_key.clone());
                    taken.retain(|_, v| *v != r.id);
                    tx.records_put.retain(|x| x.id != r.id);
                    tx.records_del.push(r.id);
                    tx.tombstones_put.push(TombstoneRow {
                        id: r.id,
                        kind: EntityKind::Record,
                        path: old.path,
                        path_key: old.path_key,
                        last: TombstoneLast::Doc(old.doc),
                        seq: p,
                        time: instant,
                    });
                }
                Effect::PutFile(f) => {
                    if !valid_path(&f.path) {
                        return self.commit_payload_void(head, &payload, "V7: invalid path");
                    }
                    if !blob_ref_in_bounds(&f.blob) {
                        return self.commit_payload_void(
                            head,
                            &payload,
                            "V7: blob part size or count out of range",
                        );
                    }
                    let old = self.store.file(&f.id)?;
                    if old.as_ref().is_some_and(|o| {
                        o.kind != mdbn_wire::unindexed_markdown::FileKindV1::Ordinary
                    }) {
                        return self.commit_payload_void(
                            head,
                            &payload,
                            "V7: ordinary effect changes file kind",
                        );
                    }
                    if let Some(o) = &old {
                        freed.insert(o.path_key.clone());
                    }
                    if self.store.tombstone(&f.id)?.is_some() {
                        tx.tombstones_del.push(f.id);
                    }
                    let pk = mdbn_core::paths::path_key(&f.path);
                    if taken.insert(pk.clone(), f.id).is_some_and(|o| o != f.id) {
                        return self.commit_payload_void(
                            head,
                            &payload,
                            "V7: two entries share a path",
                        );
                    }
                    let local = match &old {
                        Some(o)
                            if matches!(
                                &o.content,
                                mdbn_wire::attachment::FileContent::Blob(b) if *b == f.blob
                            ) =>
                        {
                            o.local
                        }
                        _ => FileLocal::Remote,
                    };
                    tx.files_put.push(FileRow {
                        id: f.id,
                        path: f.path.clone(),
                        path_key: pk,
                        kind: mdbn_wire::unindexed_markdown::FileKindV1::Ordinary,
                        content: mdbn_wire::attachment::FileContent::Blob(f.blob.clone()),
                        media: media_class(&f.path),
                        modified_seq: p,
                        bucket: bucket16(&f.id),
                        local,
                    });
                }
                Effect::RemoveFile(f) => {
                    let Some(old) = self.store.file(&f.id)? else {
                        return self.commit_payload_void(
                            head,
                            &payload,
                            "V7: remove of an unknown file",
                        );
                    };
                    freed.insert(old.path_key.clone());
                    taken.retain(|_, v| *v != f.id);
                    tx.files_del.push(f.id);
                    let last = TombstoneLast::from_file(&old).ok_or_else(|| {
                        StoreError::Corrupt("file row content form unknown to this replica".into())
                    })?;
                    tx.tombstones_put.push(TombstoneRow {
                        id: f.id,
                        kind: EntityKind::File,
                        path: old.path,
                        path_key: old.path_key,
                        // The tombstone keeps the file's complete content; an
                        // arm this replica cannot keep is refused, not dropped.
                        last,
                        seq: p,
                        time: instant,
                    });
                }
                Effect::PutResource(r) => {
                    let Text::Inline(doc) = &r.doc else {
                        return self.commit_payload_void(head, &payload, "V7: unresolved text");
                    };
                    if !valid_path(&r.path) {
                        return self.commit_payload_void(head, &payload, "V7: invalid path");
                    }
                    catalog_changed = true;
                    tx.resources_put.push((r.path.clone(), doc.clone()));
                }
                Effect::RemoveResource(r) => {
                    catalog_changed = true;
                    tx.resources_del.push(r.path.clone());
                }
                Effect::PutSettings(s) => tx.settings = Some(s.inclusion.clone()),
            }
        }
        // After all effects, every taken path key must be free or held by the taker.
        for (pk, id) in &taken {
            let rec = self.store.record_at(pk)?;
            let file = self.store.file_at(pk)?;
            let holder = rec.or(file);
            if let Some(h) = holder
                && h != *id
                && !freed.contains(pk)
            {
                return self.commit_payload_void(head, &payload, "V7: path already taken");
            }
        }
        // Record metadata under the catalog after this entry's resource effects.
        let catalog = if catalog_changed {
            let mut rs: std::collections::BTreeMap<String, String> =
                self.store.resources()?.into_iter().collect();
            for p in &tx.resources_del {
                rs.remove(p);
            }
            for (p, d) in &tx.resources_put {
                rs.insert(p.clone(), d.clone());
            }
            std::sync::Arc::new(mdbn_core::types::Catalog::load(
                rs.iter().map(|(a, b)| (a.as_str(), b.as_str())),
            ))
        } else {
            self.catalog.clone()
        };
        for r in &mut tx.records_put {
            r.meta = record_meta(&catalog, &r.path, &r.doc);
        }
        for a in payload.aliases.iter().flatten() {
            tx.aliases_put.push(AliasRow {
                path: a.path.clone(),
                path_key: mdbn_core::paths::path_key(&a.path),
                record: a.record,
            });
        }
        for c in &conflicts {
            tx.conflicts_put.push(ConflictRow {
                mutation: payload.mutation.id,
                seq: p,
                conflict: c.clone(),
            });
        }
        // Receipts carry the legacy wire form: a conflict with an attachment side
        // is reported by status and `list_conflicts` (ConflictValue5) only.
        let receipt_conflicts: Vec<mdbn_wire::entry::Conflict> = conflicts
            .iter()
            .filter_map(|c| super::attachment_runtime::legacy_conflict(c.clone()).ok())
            .collect();
        for o in &payload.mutation.ops {
            if let rt::Op::Legacy(Op::ConflictDismiss(d)) = o {
                tx.conflicts_del.push((d.mutation, d.record));
            }
        }
        tx.receipts_put.push(ReceiptRow {
            mutation: payload.mutation.id,
            seq: p,
            time: instant,
        });
        // The deterministic horizon (snapshot.md §6).
        let log_time = self.log_time.max(instant);
        if p > HORIZON_ENTRIES {
            tx.prune = Some(Prune {
                seq_floor: p - HORIZON_ENTRIES,
                time_floor: log_time.saturating_sub(HORIZON_MS),
            });
        }
        let ratchet = self.sem_ratchet().max(payload.sem.major);
        tx.meta
            .push((meta_keys::LOG_STATE.into(), log_state(log_time, ratchet)));
        // Our own mutation: confirmed.
        let pending = self.store.pending_get(&payload.mutation.id)?;
        let own = pending.is_some();
        // Hosted mode: the log names the owner. A pending row of another grant with
        // this mutation ID can never land (the log's token is taken): it is refused,
        // never confirmed with someone else's result. Every applied entry records
        // its log-derived receipt so a cold rebuild restores grant-scoped receipts.
        let hosted = self.is_hosted();
        let own_match = own
            && (!hosted || pending.as_ref().map(|r| r.grant) == Some(payload.mutation.on_behalf));
        let relocated_from = if own_match {
            self.resurrected_resolution(&payload.mutation.id)
                .map(|(old, meta)| {
                    tx.meta.push(meta);
                    old
                })
        } else {
            None
        };
        if own {
            // Only an acknowledged matched result hands over this replica's
            // original pending row; a hosted rival is never resurrection input.
            if own_match
                && !self.local_only()
                && let Some(row) = pending
            {
                tx.own_retained_put.push((p, row));
            }
            tx.pending_del.push(payload.mutation.id);
        }
        if own || hosted {
            tx.local_receipts_put.push(LocalReceipt {
                mutation: payload.mutation.id,
                state: ReceiptState::Confirmed,
                seq: (!self.local_only()).then_some(p),
                status: Some(payload.status),
                conflicts: receipt_conflicts.clone(),
                problem: None,
                resolved_at: self.now(),
                grant: payload.mutation.on_behalf,
            });
        }
        // Rebase keys.
        let legacy_effects: Vec<Effect> = effects
            .iter()
            .filter_map(|e| match e {
                rt::Effect::Legacy(e) => Some(e.clone()),
                rt::Effect::PutAttachmentFile(_)
                | rt::Effect::PutUnindexedMarkdown(_)
                | rt::Effect::ReindexUnindexedMarkdown(_)
                | rt::Effect::ReindexOrdinaryFile(_) => None,
            })
            .collect();
        changed.extend(effect_keys(&legacy_effects));
        changed.extend(super::path_keys(&legacy_effects));
        for e in &effects {
            let identity = match e {
                rt::Effect::PutAttachmentFile(f) => Some((f.id, &f.path)),
                rt::Effect::PutUnindexedMarkdown(f) => Some((f.id, &f.path)),
                rt::Effect::ReindexUnindexedMarkdown(r) => Some((r.id, &r.path)),
                _ => None,
            };
            if let Some((id, path)) = identity {
                changed.insert(crate::plan::id_key(&id));
                changed.insert(format!("p:{}", mdbn_core::paths::path_key(path)));
            }
        }
        let mut attachment_files = super::attachment_fetch::touched_files(&effects);
        if catalog_changed {
            for (p, _) in &tx.resources_put {
                changed.insert(resource_key(p));
            }
            for p in &tx.resources_del {
                changed.insert(resource_key(p));
            }
        }
        if own_match && payload.mutation.origin == self.cfg.replica_id {
            self.prepare_conflict_holds(&payload.mutation, &conflicts, &mut tx, &t)?;
        }
        let holds_changed = !tx.holds_put.is_empty();
        attachment_files.extend(tx.holds_put.iter().map(|h| h.id));
        self.capture_effects(&legacy_effects);
        self.policy.note_entry(p, payload.sem.major, instant);
        tx.meta.push(self.policy_meta());
        // Pure trusted projection observes EXACT post-resource effects and is
        // committed atomically with records/head/receipts. Optional failure
        // invalidates derived readiness; a genuine store error still fails apply.
        // Preparation only reads storage and fills this in-memory Tx. A read
        // result cannot certify the no-effects/durable-prior-state guarantee
        // reserved for an authoritative commit result.
        let query_context = self
            .prepare_query_index(&mut tx)
            .map_err(|error| match error {
                StoreError::CommitAborted(reason) => StoreError::Io(reason),
                other => other,
            })?;
        if self.local_only() {
            // Local confirmation has no synced log bytes or retention material.
            self.store.commit(tx)?;
            self.head = head;
        } else {
            self.commit_retained(head, tx)?;
        }
        if self.apply_fault {
            // The head/receipt/own handover committed, but a defensive read
            // failed. No follow-up indexing/hold writes or queued output now.
            return Ok(Outcome::Applied);
        }
        self.query_context = query_context;
        self.log_time = log_time;
        self.sem_ratchet_set(ratchet);
        if catalog_changed {
            self.catalog = catalog;
            self.reindex()?;
            // Every pending row plans under the new catalog.
            changed.extend(self.pending_keys.values().flatten().cloned());
        }
        if relocated_from.is_some() {
            self.resurrected.remove(&payload.mutation.id);
        }
        if holds_changed {
            self.status_dirty = true;
            self.push_holds();
        }
        self.attachment_files_changed(attachment_files);
        if own {
            let receipt = if own_match {
                mdbn_wire::client::Receipt {
                    relocated_from,
                    mutation: payload.mutation.id,
                    state: ReceiptState::Confirmed,
                    seq: (!self.local_only()).then_some(p),
                    status: Some(payload.status),
                    conflicts: if receipt_conflicts.is_empty() {
                        None
                    } else {
                        Some(receipt_conflicts)
                    },
                    records: None,
                    problem: None,
                    published: None,
                }
            } else {
                super::hosted::in_use_receipt(payload.mutation.id)
            };
            if own_match {
                self.push_durable_receipt(receipt.clone());
            } else if let Some(session) = self.submitted_by.remove(&receipt.mutation) {
                // The stored receipt belongs to the rival grant and is Confirmed.
                // This original submitter's InUse rejection is NOT persisted:
                // preserve its single-session/ticket route, never durable fanout.
                self.pushes.push((session, Push::Receipt(receipt.clone())));
            }
            self.hosted_resolve(&receipt);
        }
        Ok(Outcome::Applied)
    }

    /// Recompute every record's index entries after a catalog change.
    fn reindex(&mut self) -> Result<(), StoreError> {
        let mut after = None;
        loop {
            let page = self
                .store
                .records(crate::store::Page { after, limit: 128 })?;
            let Some(l) = page.last() else {
                break;
            };
            after = Some(l.id);
            let rows: Vec<RecordRow> = page
                .into_iter()
                .map(|mut r| {
                    r.meta = record_meta(&self.catalog, &r.path, &r.doc);
                    r
                })
                .collect();
            self.stats.reindexed += rows.len() as u64;
            let mut tx = Tx {
                records_put: rows,
                ..Tx::default()
            };
            let context = self
                .prepare_query_index(&mut tx)
                .map_err(|error| match error {
                    StoreError::CommitAborted(reason) => StoreError::Io(reason),
                    other => other,
                })?;
            self.store.commit(tx)?;
            self.query_context = context;
        }
        Ok(())
    }

    pub(crate) fn sem_ratchet(&self) -> u64 {
        self.sem_ratchet
    }

    fn sem_ratchet_set(&mut self, v: u64) {
        self.sem_ratchet = v;
    }
}

/// Smallest and largest `part_size` (`sealed-envelope.md` §4.2, bounded envelopes).
pub const MIN_PART: u64 = 1 << 20;
/// Largest `part_size`.
pub const MAX_PART: u64 = 16 << 20;
/// Most parts per `blob-ref`.
pub const MAX_PARTS: u64 = 1024;

/// Whether a blob ref's part layout is in range, checked before anything is
/// allocated: a ref claiming a huge file in tiny parts would otherwise exhaust
/// memory on every replica that applies it.
/// Resolve every text in a runtime conflict; attachment sides carry none.
fn resolve_runtime_conflict(
    c: &rt::Conflict,
    t: crate::convert::TextResolver<'_>,
) -> CResult<rt::Conflict> {
    let rv = |v: &rt::ConflictValue| -> CResult<rt::ConflictValue> {
        Ok(match v {
            rt::ConflictValue::Legacy(mdbn_wire::entry::ConflictValue::Text(x)) => {
                rt::ConflictValue::Legacy(mdbn_wire::entry::ConflictValue::Text(Text::Inline(t(
                    x,
                )?)))
            }
            other => other.clone(),
        })
    };
    Ok(rt::Conflict {
        kind: c.kind,
        id: c.id,
        field: c.field.clone(),
        base: c.base.as_ref().map(rv).transpose()?,
        kept: rv(&c.kept)?,
        lost: rv(&c.lost)?,
    })
}

impl<S: Store> Replica<S> {
    pub(crate) fn unindexed_content_in_bounds(
        &self,
        c: &mdbn_wire::attachment::FileContent,
    ) -> bool {
        let size = c.size();
        size > mdbn_wire::unindexed_markdown::RECORD_SOURCE_CAP_BYTES
            && size <= crate::crypto::chunked_blob::AttachmentLimits::default().max_file_bytes
            && match c {
                mdbn_wire::attachment::FileContent::Blob(b) => {
                    blob_ref_in_bounds(b) && b.id_epoch >= 1 && b.id_epoch <= self.policy.epoch
                }
                mdbn_wire::attachment::FileContent::AttachmentV1(a) => self.attachment_in_bounds(a),
                _ => false,
            }
    }
    /// V7 for a signed attachment descriptor (`intent.md` §3.9): it names this
    /// collection, an epoch the policy has reached, and a size within the cap.
    /// The manifest's own binding is checked by the reader when it is fetched.
    pub(crate) fn attachment_in_bounds(
        &self,
        a: &mdbn_wire::attachment::AttachmentContentV1,
    ) -> bool {
        a.reference.collection == self.cfg.collection
            && a.reference.key_epoch >= 1
            && a.reference.key_epoch <= self.policy.epoch
            && a.total_plain_bytes
                <= crate::crypto::chunked_blob::AttachmentLimits::default().max_file_bytes
    }
}

pub(crate) fn blob_ref_in_bounds(b: &mdbn_wire::intent::BlobRef) -> bool {
    (MIN_PART..=MAX_PART).contains(&b.part_size) && b.size.div_ceil(b.part_size).max(1) <= MAX_PARTS
}

/// `LOG_STATE` meta: `log_time ‖ sem_ratchet`, both big-endian.
pub(crate) fn log_state(log_time: i64, ratchet: u64) -> Option<Vec<u8>> {
    let mut v = i64_meta(log_time).unwrap_or_default();
    v.extend_from_slice(&ratchet.to_be_bytes());
    Some(v)
}

/// Whether a decode error is an unknown variant anywhere (critical, §6.2).
fn is_unknown_deep(e: &SchemaError) -> bool {
    e.is_unknown()
}

/// Media class from the extension (`intent.md` §3.7).
pub(crate) fn media_class(path: &str) -> mdbn_wire::intent::MediaClass {
    use mdbn_wire::intent::MediaClass as M;
    let ext = path
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "avif" | "heic" | "tif"
        | "tiff" => M::Image,
        "mp3" | "wav" | "m4a" | "ogg" | "flac" | "aac" | "opus" => M::Audio,
        "mp4" | "mov" | "webm" | "mkv" | "avi" | "m4v" => M::Video,
        "pdf" => M::Pdf,
        _ => M::Other,
    }
}

#[allow(dead_code)]
fn _unused(_: B16) {}

#[cfg(test)]
mod bounds_tests {
    use super::*;
    use mdbn_wire::common::B32;
    use mdbn_wire::intent::BlobRef;

    fn b(size: u64, part_size: u64) -> BlobRef {
        BlobRef {
            plain_hash: B32([0; 32]),
            size,
            blob_id: B32([0; 32]),
            id_epoch: 1,
            part_size,
        }
    }

    #[test]
    fn blob_ref_bounds() {
        assert!(blob_ref_in_bounds(&b(0, 8 << 20)));
        assert!(blob_ref_in_bounds(&b(1024 * (16 << 20), 16 << 20)));
        assert!(
            !blob_ref_in_bounds(&b(1024 * (16 << 20) + 1, 16 << 20)),
            "too many parts"
        );
        assert!(!blob_ref_in_bounds(&b(1 << 50, 1)), "tiny parts");
        assert!(
            !blob_ref_in_bounds(&b(10, (16 << 20) + 1)),
            "parts too large"
        );
        assert!(!blob_ref_in_bounds(&b(10, 0)), "zero part size");
    }
}
