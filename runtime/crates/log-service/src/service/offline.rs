//! Native historical authenticity only: no backend, storage or restore access.
use super::{Verified, check_item, check_verified, validate_object_bytes};
use crate::OfflineDecodeBudget;
use crate::auth::verify_sig;
use crate::decode::Budget;
use crate::error::{Result, ServiceError};
use crate::limits::MAX_OBJECT_BYTES;
use crate::model::{CollectionMeta, CollectionState};
use mdbn_wire::common::{B16, B32, Uuid};
use mdbn_wire::envelope::{Item, ItemKind};
use mdbn_wire::hash::chain_hash;
use mdbn_wire::policy::{PolicyOp, PolicyPayload};
use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet};

#[cfg(test)]
mod tests;

const STATE_CAP: usize = 4096;
const ITEM_CAP: u64 = 2_097_152;
// Conservative node-capacity allowance for all three bounded replay maps,
// roots and fixed helper bookkeeping, rather than just payload byte lengths.
const STATE_MEMORY: u64 = (STATE_CAP as u64 * 3 + 32) * 256 + 1024 * 1024;

fn scratch(
    budget: &Budget,
    bytes: usize,
) -> Result<crate::offline_decode::OfflineOwnedReservation> {
    // Includes overlapping CBOR/typed copies, canonical signed-digest encoding
    // and bounded temporary policy sets. Request-local node/depth limits still
    // apply; retained replay maps are covered by their separate state allowance.
    let allowance = u64::try_from(bytes)
        .ok()
        .and_then(|bytes| bytes.checked_mul(8))
        .and_then(|bytes| bytes.checked_add(2 * 1024 * 1024))
        .ok_or_else(bounds)?;
    budget.reserve_owned(allowance)
}

/// Bounded native replay of original signed history, never current permission.
///
/// State is private and cannot be cloned, exported, imported or modified by a
/// caller. Every failure poisons this instance and its shared invocation ledger;
/// finish consumes it. Storage/quota/floor/key and serving authority are absent.
pub struct OfflineReplayVerifier {
    state: CollectionState,
    roots: Vec<B32>,
    work: OfflineDecodeBudget,
    retained_from: u64,
    count: u64,
    failed: Cell<bool>,
    // Declaration order drops state/roots before releasing their allowance.
    _allocation: crate::offline_decode::OfflineOwnedReservation,
}

fn bounds() -> ServiceError {
    ServiceError::invalid("cbor_offline_budget")
}

fn insert(set: &mut BTreeSet<Uuid>, key: Uuid) -> Result<()> {
    if !set.contains(&key) && set.len() == STATE_CAP {
        return Err(bounds());
    }
    set.insert(key);
    Ok(())
}

impl OfflineReplayVerifier {
    /// Start historical replay against independently supplied original roots.
    pub fn new(
        collection: Uuid,
        retained_from: u64,
        roots: &[B32],
        work: &OfflineDecodeBudget,
    ) -> Result<Self> {
        let result = (|| {
            if collection == B16([0; 16])
                || retained_from == 0
                || roots.is_empty()
                || roots.len() > 32
            {
                return Err(bounds());
            }
            for (i, root) in roots.iter().enumerate() {
                if roots[..i].contains(root) {
                    return Err(bounds());
                }
            }
            let allocation = work.reserve_owned(STATE_MEMORY)?;
            Ok(Self {
                state: CollectionState {
                    meta: CollectionMeta::new(collection, 0),
                    acl: BTreeMap::new(),
                },
                roots: roots.to_vec(),
                work: work.clone(),
                retained_from,
                count: 0,
                failed: Cell::new(false),
                _allocation: allocation,
            })
        })();
        if result.is_err() {
            let _ = work.reserve_owned(u64::MAX); // permanent refusal, no allocation
        }
        result
    }

    fn active(&self, budget: &Budget) -> Result<()> {
        budget.require_offline()?;
        if self.failed.get() {
            return Err(bounds());
        }
        Ok(())
    }

    fn failed(&self, budget: &Budget) {
        self.failed.set(true);
        budget.poison_offline();
    }

    fn policy_capacity(&self, item: &Item, budget: &Budget) -> Result<()> {
        let payload = budget.wire::<PolicyPayload>(&item.body.0)?;
        // Check every intermediate operation BEFORE existing policy application
        // can grow private replay maps. No externally supplied state/ACL is used.
        let mut devices = self.state.acl.keys().copied().collect::<BTreeSet<_>>();
        let mut members = self
            .state
            .meta
            .members
            .keys()
            .copied()
            .collect::<BTreeSet<_>>();
        let mut revoked = self
            .state
            .meta
            .revoked_cp_keys
            .keys()
            .copied()
            .collect::<BTreeSet<_>>();
        for op in &payload.ops {
            match op {
                PolicyOp::Genesis(g) => insert(&mut members, g.owner)?,
                PolicyOp::DeviceEnrol(d) => insert(&mut devices, d.device)?,
                PolicyOp::MemberSet(m) => insert(&mut members, m.account)?,
                PolicyOp::MemberRemove(m) => {
                    members.remove(&m.account);
                }
                PolicyOp::CpKeyRevoke(r) => insert(&mut revoked, r.key_id)?,
                _ => {}
            }
        }
        Ok(())
    }

    /// Verify the next exact retained signed item using existing policy checks.
    pub fn push(&mut self, seq: u64, exact_signed_bytes: &[u8]) -> Result<()> {
        let budget = self.work.request();
        let result = (|| {
            self.active(&budget)?;
            let _scratch = scratch(&budget, exact_signed_bytes.len())?;
            if self.count == ITEM_CAP {
                return Err(bounds());
            }
            let item = budget.wire::<Item>(exact_signed_bytes)?;
            item.check_shape()
                .map_err(|_| ServiceError::invalid("shape"))?;
            if item.collection != self.state.meta.id
                || !item.kind.is_log_item()
                || item.seq != Some(seq)
                || seq <= self.state.meta.head
            {
                return Err(ServiceError::invalid("shape"));
            }
            let next = self.state.meta.head.checked_add(1).ok_or_else(bounds)?;
            if seq == next {
                if item.prev != Some(self.state.meta.head_chain) {
                    return Err(ServiceError::invalid("chain"));
                }
            } else if self.state.meta.head == 0 || seq > self.retained_from {
                return Err(ServiceError::invalid("chain"));
            }
            if item.kind == ItemKind::Policy {
                self.policy_capacity(&item, &budget)?;
            }
            // Charge signature/digest validation work before executing it too.
            budget
                .preflight(exact_signed_bytes)
                .map_err(|e| ServiceError::invalid(e.reason))?;
            check_item(&mut self.state, &item, seq, 0, &self.roots, &budget)?;
            budget
                .preflight(exact_signed_bytes)
                .map_err(|e| ServiceError::invalid(e.reason))?;
            self.state.meta.head = seq;
            self.state.meta.head_chain = chain_hash(exact_signed_bytes);
            self.count += 1;
            Ok(())
        })();
        if result.is_err() {
            self.failed(&budget);
        }
        result
    }

    /// Verify a manifest with its historical enrolled author key, even if that
    /// key was later revoked. This is authenticity, not a current write permit.
    pub fn verify_manifest(&self, exact_object: &[u8], expected_author: &Uuid) -> Result<()> {
        let budget = self.work.request();
        let result = (|| {
            self.active(&budget)?;
            if exact_object.len() as u64 > MAX_OBJECT_BYTES {
                return Err(bounds());
            }
            let _scratch = scratch(&budget, exact_object.len())?;
            let item = budget.wire::<Item>(exact_object)?;
            item.check_shape()
                .map_err(|_| ServiceError::invalid("shape"))?;
            if item.collection != self.state.meta.id
                || item.kind != ItemKind::Manifest
                || item.signer != Some(*expected_author)
            {
                return Err(ServiceError::invalid("shape"));
            }
            let author = self
                .state
                .acl
                .get(expected_author)
                .ok_or_else(|| ServiceError::invalid("signature"))?;
            budget
                .preflight(exact_object)
                .map_err(|e| ServiceError::invalid(e.reason))?;
            let digest = item
                .signed_digest()
                .map_err(|_| ServiceError::invalid("shape"))?;
            if !verify_sig(
                &author.sign_pk.0,
                &digest.0,
                &item
                    .sig
                    .ok_or_else(|| ServiceError::invalid("signature"))?
                    .0,
            ) {
                return Err(ServiceError::invalid("signature"));
            }
            Ok(())
        })();
        if result.is_err() {
            self.failed(&budget);
        }
        result
    }

    /// Consume completed history; no state or authority is returned.
    pub fn finish(self, expected_head: u64, expected_chain: &B32) -> Result<()> {
        let budget = self.work.request();
        let result = (|| {
            self.active(&budget)?;
            let end = expected_head.checked_add(1).ok_or_else(bounds)?;
            if self.count == 0
                || self.state.meta.head != expected_head
                || self.state.meta.head_chain != *expected_chain
                || self.retained_from > end
            {
                return Err(ServiceError::invalid("chain"));
            }
            Ok(())
        })();
        if result.is_err() {
            self.failed(&budget);
        }
        result
    }

    /// Pure object validation with the invocation's shared offline decode budget.
    /// An unscoped/default budget is rejected; no object write or backend exists.
    pub fn validate_object_with_budget(
        c: &Uuid,
        address: &B32,
        kind: u64,
        size: u64,
        checksum: &B32,
        bytes: &[u8],
        budget: &Budget,
    ) -> Result<()> {
        let result = (|| {
            budget.require_offline()?;
            if *c == B16([0; 16]) {
                return Err(ServiceError::invalid("shape"));
            }
            let _scratch = scratch(budget, bytes.len())?;
            check_verified(
                address,
                &Verified {
                    kind,
                    size,
                    checksum: *checksum,
                },
            )?;
            budget
                .preflight(bytes)
                .map_err(|e| ServiceError::invalid(e.reason))?;
            validate_object_bytes(c, address, kind, size, checksum, bytes, budget)
        })();
        if result.is_err() {
            budget.poison_offline();
        }
        result
    }
}
