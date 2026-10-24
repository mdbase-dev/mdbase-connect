//! A failed apply must not leave authorization or keys ahead of durable state.
//! Checkpoints are private, device-local and never published or serialized.

use std::collections::BTreeMap;

use mdbn_wire::client::{Incident, IncidentKind};
use zeroize::Zeroizing;

use super::{Replica, Stats, disk::Before};
use crate::api::{ClientApi, ErrorCode, Push};
use crate::policy::PolicyState;
use crate::store::{Head, Store, meta_keys};

pub(crate) struct Checkpoint {
    head: Head,
    policy: PolicyState,
    keyring: Option<Zeroizing<Vec<u8>>>,
    /// AK1 device-local wraps/commit/trusted (public data; the pending self-grant
    /// is RAM-only and kept).
    account_key: Vec<u8>,
    genesis: Option<mdbn_wire::common::Hash>,
    key_untrusted: bool,
    hosted_key_delivery: Option<super::admission::HostedKeyDelivery>,
    stalled: Option<(IncidentKind, u64)>,
    incidents: BTreeMap<u64, Incident>,
    status_dirty: bool,
    stats: Stats,
    before: Before,
    pushes_len: usize,
}

impl Checkpoint {
    pub(crate) fn capture<S: Store>(r: &Replica<S>) -> Self {
        Self {
            head: r.head,
            policy: r.policy.clone(),
            keyring: r.sealer.export(),
            account_key: r.account_key.to_bytes(),
            genesis: r.genesis,
            key_untrusted: r.key_untrusted,
            hosted_key_delivery: r.hosted_key_delivery,
            stalled: r.stalled,
            incidents: r.incidents.clone(),
            status_dirty: r.status_dirty,
            stats: r.stats.clone(),
            before: r.before.clone(),
            pushes_len: r.pushes.len(),
        }
    }

    pub(crate) fn restore<S: Store>(
        self,
        r: &mut Replica<S>,
        known_abort: bool,
    ) -> Result<(), &'static str> {
        // Logical reads cannot prove durability (e.g. an outer deferred adapter).
        // Only a typed abort guarantees both no effects and durable prior state;
        // unchanged reads are an additional defensive check, never that proof.
        let durable_unchanged = known_abort
            && r.store.head().is_ok_and(|head| head == self.head)
            && r.store
                .meta(meta_keys::POLICY)
                .is_ok_and(|bytes| match bytes {
                    Some(bytes) => PolicyState::from_bytes(&bytes).is_ok_and(|p| p == self.policy),
                    None => self.policy == PolicyState::new(),
                })
            && r.store
                .meta(meta_keys::GENESIS)
                .is_ok_and(|bytes| bytes.as_deref() == self.genesis.as_ref().map(|g| &g.0[..]));
        r.policy = self.policy;
        let account_key_restored = r.account_key.restore_persisted(&self.account_key);
        r.genesis = self.genesis;
        r.key_untrusted = self.key_untrusted;
        r.hosted_key_delivery = self.hosted_key_delivery;
        r.stalled = self.stalled;
        r.incidents = self.incidents;
        r.status_dirty = self.status_dirty;
        r.stats = self.stats;
        r.before = self.before;
        r.pushes.truncate(self.pushes_len);
        let keyring_restored = match self.keyring {
            Some(bytes) => r.sealer.import(&bytes).is_ok(),
            // An opaque sealer without an export cannot be assumed stateless.
            None => false,
        };
        r.sealer.set_epoch(r.policy.epoch);
        if !durable_unchanged {
            Err("apply_durability_unknown")
        } else if !keyring_restored {
            Err("apply_keyring_restore_failed")
        } else if !account_key_restored {
            Err("apply_account_key_restore_failed")
        } else {
            Ok(())
        }
    }
}

impl<S: Store> Replica<S> {
    pub(crate) fn is_apply_recovering(&self) -> bool {
        self.apply_blocked
            .is_some_and(|position| self.head.seq < position)
    }

    pub(crate) fn check_apply_store_health(&self) -> Result<(), crate::store::StoreError> {
        crate::mirror_admission::ensure_open(&self.store)?;
        if self.apply_fault || self.is_apply_recovering() {
            return Err(crate::store::StoreError::Io(
                if self.apply_fault {
                    "apply_reopen_required"
                } else {
                    "apply_recovering"
                }
                .into(),
            ));
        }
        Ok(())
    }

    pub(crate) fn failed_apply(
        &mut self,
        checkpoint: Checkpoint,
        position: u64,
        known_abort: bool,
    ) {
        let restored = checkpoint.restore(self, known_abort);
        self.apply_blocked = Some(self.apply_blocked.unwrap_or(0).max(position));
        self.head_known = self.head_known.max(position);
        self.caught_up = false;
        // Disposable snapshot jobs cannot sign/seal on late replies while apply
        // recovery is blocked. Install staging is deliberately left untouched.
        self.build = None;
        self.endorse = None;
        if let Err(reason) = restored {
            // Unknown persistence or an opaque keyring that could not be restored:
            // no serving, sealing, append retries or control evaluation until open.
            self.apply_fault = true;
            self.store_generation += 1;
            self.calls.clear();
            self.inflight.clear();
            self.append = super::append::AppendState::Stopped;
            self.incident(
                IncidentKind::Integrity,
                Some(mdbn_wire::common::Value::Text(reason.into())),
            );
        }
        self.quarantine_apply_outputs();
    }

    /// A known successful mutation stays committed. A subsequent failed read
    /// fences this instance without restoring its pre-commit checkpoint.
    pub(crate) fn committed_read_fault(&mut self) {
        self.terminal_store_fault("retention_accounting_read_failed");
    }

    /// Unknown durability cannot certify no effect. Fence the instance without
    /// rewriting, cleaning up, or retrying a potentially landed transaction.
    pub(crate) fn terminal_store_fault(&mut self, reason: &str) {
        self.apply_fault = true;
        self.store_generation += 1;
        self.caught_up = false;
        self.build = None;
        self.endorse = None;
        self.calls.clear();
        self.inflight.clear();
        self.append = super::append::AppendState::Stopped;
        self.incident(
            IncidentKind::Integrity,
            Some(mdbn_wire::common::Value::Text(reason.into())),
        );
        self.quarantine_apply_outputs();
    }

    fn quarantine_apply_outputs(&mut self) {
        // Quarantine the outbound plane, not only request handlers. Previously
        // queued plaintext is discarded, never flushed blindly after recovery.
        // Clients reconnect/resubscribe against freshly verified authorization.
        self.pushes.retain(|(_, p)| matches!(p, Push::Closed(_)));
        let reason = if self.apply_fault {
            "apply_reopen_required"
        } else {
            "apply_recovering"
        };
        for id in self.sessions.keys().copied().collect::<Vec<_>>() {
            self.close(id);
            self.pushes.push((
                id,
                Push::Closed(ErrorCode::Unavailable.problem_with_reason(
                    reason,
                    "control apply recovery; reconnect after recovery",
                )),
            ));
        }
        self.status_dirty = true;
    }
}
