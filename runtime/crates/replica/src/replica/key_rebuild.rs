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
#[derive(Debug)]
pub(crate) struct DeviceKeyRebuild {
    /// Next read starts after this position.
    after: u64,
    /// The store's head at open.
    target: u64,
    /// The policy state re-derived from the log so far.
    shadow: Box<PolicyState>,
    /// A read is outstanding.
    reading: bool,
}

impl<S: Store> Replica<S> {
    /// At open: whether the keyring must be rebuilt before anything syncs.
    /// Returns true when a rebuild was started (it queues its own reads and the
    /// head fetch once done).
    pub(crate) fn start_device_key_rebuild(&mut self) -> bool {
        if self.hosted.is_some()
            || self.local_only()
            || self.store.keyring_persistence() != KeyringPersistence::RebuildOnOpen
            || self.head.seq == 0
        {
            return false;
        }
        self.device_keys = Some(DeviceKeyRebuild {
            after: 0,
            target: self.head.seq,
            shadow: Box::new(PolicyState::new()),
            reading: false,
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
            // Transport trouble (offline): the next tick asks again.
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
            let verdict = self.evaluate_control(it.seq, &chain, &item, &it.item.0);
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
        let Some(k) = self.device_keys.take() else {
            return;
        };
        // Entries (not control items) move a few counters in the policy state;
        // take those from the stored state, then require everything else equal.
        let mut shadow = *k.shadow;
        shadow.seq = self.policy.seq;
        shadow.sem_ratchet = self.policy.sem_ratchet;
        shadow.log_time = self.policy.log_time;
        shadow.content_seen = self.policy.content_seen;
        shadow.voids = self.policy.voids;
        if self.policy.seq != target || shadow.to_bytes().ok() != self.policy.to_bytes().ok() {
            return self.device_key_rebuild_fail("stored policy differs from the log's");
        }
        self.sealer.set_epoch(self.policy.epoch);
        self.check_key_trust();
        self.status_dirty = true;
        self.queue_head_fetch();
        self.pump();
    }
}
