//! Keyring rebuild on open for stores that never hold the keyring
//! ([`KeyringPersistence::RebuildOnOpen`]): the app's OPFS/sqlite-wasm store.
//!
//! The keyring is kept in memory only, so a reopen over confirmed state
//! (head > 0) starts without epoch keys. Before the replica reads or appends
//! anything, every control item up to the stored head is read again
//! (`kinds = control`) and evaluated, with full signature and certificate
//! checks, into a **shadow** policy state; its rekeys and key grants are
//! unwrapped with the device KEM key the host supplied from its custody. The
//! shadow must equal the stored policy at the head, else the store is not
//! trusted (an integrity incident; the replica stays blocked until the host
//! rebuilds it from the log). This is the hosted warm-wake rebuild,
//! except that the stored policy stays the live one meanwhile: local reads and
//! offline captures (pending, "not yet synced") keep working during the rebuild.

use mdbn_wire::client::IncidentKind;
use mdbn_wire::common::Value;
use mdbn_wire::envelope::Item;
use mdbn_wire::log_service::{ReadKinds, ReadParams};
use mdbn_wire::schema::Wire;

use super::Replica;
use super::append::Inflight;
use crate::log::{LogReply, LogRequest, LogResponse};
use crate::policy::PolicyState;
use crate::store::{KeyringPersistence, Store};

/// Control items per rebuild read.
const PAGE: u64 = 64;

/// A device keyring rebuild in progress.
pub(crate) struct DeviceKeyRebuild {
    /// Optional history repair is speculative; mandatory reopen stays strict.
    rollback: Option<Box<super::apply_checkpoint::Checkpoint>>,
    /// Next read starts after this position.
    after: u64,
    /// The store's head at open.
    target: u64,
    /// The policy state re-derived from the log so far.
    shadow: Box<PolicyState>,
    /// A read is outstanding.
    reading: bool,
    /// A head fetch answered `subscribed` while this rebuild ran. Its head is
    /// still current for the stored chain (the rebuild applies nothing), so
    /// the rebuild need not fetch another one before syncing.
    pub(crate) head_seen: bool,
}

impl<S: Store> Replica<S> {
    /// At open: whether the keyring must be rebuilt before anything syncs.
    /// Returns true when a rebuild was started (it queues its own reads and the
    /// head fetch once done).
    pub(crate) fn start_device_key_rebuild(&mut self) -> bool {
        self.start_device_key_rebuild_inner(false)
    }

    pub(super) fn start_mode_history_rebuild(&mut self) -> bool {
        self.start_device_key_rebuild_inner(true)
    }

    fn start_device_key_rebuild_inner(&mut self, force: bool) -> bool {
        if self.hosted.is_some()
            || self.local_only()
            || (!force && self.store.keyring_persistence() != KeyringPersistence::RebuildOnOpen)
            || self.head.seq == 0
            || (force && self.sealer.export().is_none())
        {
            return false;
        }
        let rollback = force.then(|| Box::new(super::apply_checkpoint::Checkpoint::capture(self)));
        self.device_keys = Some(DeviceKeyRebuild {
            rollback,
            after: 0,
            target: self.head.seq,
            shadow: Box::new(PolicyState::new()),
            reading: false,
            head_seen: false,
        });
        self.device_key_rebuild_step();
        true
    }

    /// The keyring is being rebuilt, or its rebuild failed: no reads or appends.
    pub(crate) fn device_keys_blocked(&self) -> bool {
        self.device_keys.is_some() || self.device_keys_failed
    }

    /// The keyring rebuild failed: the stored policy differs from the log's
    /// control prefix. The host drops the store and rebuilds it from the log.
    pub fn keyring_rebuild_failed(&self) -> bool {
        self.device_keys_failed
    }

    /// Whether the keyring rebuild is still running.
    pub fn keyring_rebuilding(&self) -> bool {
        self.device_keys.is_some()
    }

    /// Queue the next control read of the rebuild, if one is due.
    pub(crate) fn device_key_rebuild_step(&mut self) {
        let Some(k) = self.device_keys.as_mut() else {
            return;
        };
        if k.reading {
            return;
        }
        k.reading = true;
        let after = k.after;
        let call = self.queue(LogRequest::Read(ReadParams {
            collection: self.cfg.collection,
            after,
            limit: PAGE,
            kinds: Some(ReadKinds::Control),
            max_bytes: None,
        }));
        self.inflight.insert(call, Inflight::KeyRebuild);
    }

    fn device_key_rebuild_fail(&mut self, why: &str) {
        if let Some(checkpoint) = self.device_keys.take().and_then(|k| k.rollback) {
            // Replay has committed nothing. Restore the existing keyring and local
            // authority instead of fencing an otherwise healthy persistent store.
            if checkpoint.restore(self, true).is_ok() {
                self.status_dirty = true;
                self.queue_head_fetch();
                self.pump();
                return;
            }
        }
        self.device_keys = None;
        self.device_keys_failed = true;
        self.sealer.set_epoch(self.policy.epoch);
        self.incident(
            IncidentKind::Integrity,
            Some(Value::Text(format!("keyring rebuild: {why}"))),
        );
    }

    /// A page of control items for the rebuild.
    pub(crate) fn on_device_key_rebuild(&mut self, reply: LogReply) {
        let Some((target, after)) = self.device_keys.as_mut().map(|k| {
            k.reading = false;
            (k.target, k.after)
        }) else {
            return;
        };
        let r = match reply {
            Ok(LogResponse::Read(r)) => r,
            // Optional repair must not turn a transport failure into a read/write
            // fence. Mandatory RAM-only reopen still retries as before.
            _ if self
                .device_keys
                .as_ref()
                .is_some_and(|k| k.rollback.is_some()) =>
            {
                return self.device_key_rebuild_fail("control read unavailable");
            }
            _ => return,
        };
        if r.head < target {
            return self.device_key_rebuild_fail("the log's head is below the store's");
        }
        let mut last = None;
        let mut beyond = false;
        for it in &r.items {
            if it.seq > target {
                beyond = true;
                break;
            }
            if it.seq <= last.unwrap_or(after) {
                return self.device_key_rebuild_fail("control items out of order");
            }
            if self.check_genesis(it.seq, &it.item.0).is_err() {
                if self
                    .device_keys
                    .as_ref()
                    .is_some_and(|k| k.rollback.is_some())
                {
                    return self.device_key_rebuild_fail("genesis differs from the pin");
                }
                self.device_keys = None;
                self.device_keys_failed = true;
                self.genesis_fault();
                return;
            }
            let Ok(item) = Item::from_bytes(&it.item.0) else {
                return self.device_key_rebuild_fail("control item does not decode");
            };
            if item.seq != Some(it.seq)
                || item.collection != self.cfg.collection
                || !item.kind.is_control()
            {
                return self.device_key_rebuild_fail("not a control item of this collection");
            }
            let chain = mdbn_wire::hash::chain_hash(&it.item.0);
            // Evaluate into the shadow; the stored policy stays live meanwhile.
            let shadow = match self.device_keys.as_mut() {
                Some(k) => std::mem::take(&mut *k.shadow),
                None => return,
            };
            let live = std::mem::replace(&mut self.policy, shadow);
            let verdict = self.evaluate_control(it.seq, &chain, &item, &it.item.0, false);
            let shadow = std::mem::replace(&mut self.policy, live);
            self.sealer.set_epoch(self.policy.epoch);
            if let Some(k) = self.device_keys.as_mut() {
                *k.shadow = shadow;
            }
            if verdict.is_err() {
                return self.device_key_rebuild_fail("control prefix does not verify");
            }
            last = Some(it.seq);
        }
        let done = beyond || !r.more || last.is_some_and(|l| l >= target);
        if !done && last.is_none() {
            return self.device_key_rebuild_fail("control read made no progress");
        }
        if let (Some(l), Some(k)) = (last, self.device_keys.as_mut()) {
            k.after = l;
        }
        if !done {
            return self.device_key_rebuild_step();
        }
        let Some(mut k) = self.device_keys.take() else {
            return;
        };
        // Entries (not control items) move a few counters in the policy state;
        // take those from the stored state, then require everything else equal.
        let mut shadow = std::mem::take(&mut *k.shadow);
        shadow.seq = self.policy.seq;
        shadow.sem_ratchet = self.policy.sem_ratchet;
        shadow.log_time = self.policy.log_time;
        shadow.content_seen = self.policy.content_seen;
        shadow.voids = self.policy.voids;
        if self.policy.seq != target || shadow.to_bytes().ok() != self.policy.to_bytes().ok() {
            self.device_keys = Some(k);
            return self.device_key_rebuild_fail("stored policy differs from the log's");
        }
        self.sealer.set_epoch(self.policy.epoch);
        self.check_key_trust();
        self.status_dirty = true;
        // The host's open queues a head fetch alongside the first control read
        // (bind: Reconnected). Only fetch again when that head neither answered
        // during the rebuild nor is still out: one round trip less on warm open.
        let head_out = self
            .inflight
            .values()
            .any(|kind| *kind == Inflight::Subscribe);
        if !k.head_seen && !head_out {
            self.queue_head_fetch();
        }
        self.pump();
    }
}
