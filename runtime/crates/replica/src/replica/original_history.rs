//! Bounded original-record correlations from native control acceptance.
//!
//! Persisted hints are DATA only. A warm/snapshot/replaced store cannot mint an
//! observation from them: only this instance's complete native apply prefix can.
//! These observations are historical, not CP/phase/run/physical/effect authority.
use super::Replica;
use crate::store::{Head, Store};
use mdbn_wire::{
    cbor::{self, Cbor},
    common::{Hash, Uuid},
    schema::Wire,
};
use std::collections::BTreeMap;

pub(super) const META: &str = "replica.original_history_hints.v1";
//128 ID-correlations total; current target key-delivery is one replaceable
// record, distinct from first accepted enrollment/grant origins.
const MAX_ORIGINS_PER_SUBJECT: usize = 64;
const MAX_HINT_BYTES: usize = 16 * 1024;

/// Exact original record correlated by this native instance's accepted prefix.
/// No public constructor or serialization; not a permission or durable receipt.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ObservedOriginalRecord {
    collection: Uuid,
    position: u64,
    chain: Hash,
}
impl ObservedOriginalRecord {
    /// Collection of this native apply context.
    pub fn collection(&self) -> Uuid {
        self.collection
    }
    /// Position of the complete signed original record, not an operation index.
    pub fn position(&self) -> u64 {
        self.position
    }
    /// Domain-separated chain hash of those exact original record bytes.
    pub fn chain(&self) -> Hash {
        self.chain
    }
}

#[derive(Clone, Debug, Default)]
struct References {
    genesis: Option<ObservedOriginalRecord>,
    grants: BTreeMap<Uuid, ObservedOriginalRecord>,
    devices: BTreeMap<Uuid, ObservedOriginalRecord>,
    delivery: Option<ObservedOriginalRecord>,
}

/// Runtime observations and persisted DATA have separate storage and lineage.
#[derive(Clone, Debug)]
pub(super) struct OriginalHistory {
    collection: Uuid,
    generation: u64,
    verified: Option<References>,
    hints: References,
}

impl OriginalHistory {
    pub(super) fn new(
        collection: Uuid,
        generation: u64,
        head: Head,
        policy_seq: u64,
        bytes: Option<&[u8]>,
    ) -> Self {
        Self {
            collection,
            generation,
            // Imported policy/head/hints never recreate native accepted history.
            verified: (head.seq == 0 && policy_seq == 0).then(References::default),
            hints: bytes
                .and_then(|b| decode_hints(collection, b))
                .unwrap_or_default(),
        }
    }
    pub(super) fn invalidate(&mut self) {
        self.verified = None;
    }
    /// A generation-0 `base` install swapped only content state at the base's
    /// position: every control record before it was applied by this instance
    /// and nothing was read ahead or imported. Observations of generation
    /// `from` stay verified in `to`; any other lineage stays invalid.
    pub(super) fn carry_over_base(&mut self, from: u64, to: u64) {
        if self.generation == from {
            self.generation = to;
        } else {
            self.invalidate();
        }
    }
    pub(super) fn genesis(&self, generation: u64) -> Option<ObservedOriginalRecord> {
        (self.generation == generation).then_some(())?;
        self.verified.as_ref()?.genesis
    }
    pub(super) fn grant(&self, generation: u64, grant: &Uuid) -> Option<ObservedOriginalRecord> {
        (self.generation == generation).then_some(())?;
        self.verified.as_ref()?.grants.get(grant).copied()
    }
    pub(super) fn device(&self, generation: u64, device: &Uuid) -> Option<ObservedOriginalRecord> {
        (self.generation == generation).then_some(())?;
        self.verified.as_ref()?.devices.get(device).copied()
    }
    pub(super) fn delivery(&self, generation: u64) -> Option<ObservedOriginalRecord> {
        (self.generation == generation).then_some(())?;
        self.verified.as_ref()?.delivery
    }
    /// Called only for the actual accepted control verdict. Install the returned
    /// candidate ONLY after successful settled commit and healthy native reads.
    pub(super) fn prepare(
        &self,
        generation: u64,
        head: Head,
        created: &[Uuid],
        enrolled: &[Uuid],
        target_key_delivered: bool,
    ) -> Self {
        let mut next = self.clone();
        if next.generation != generation {
            next.invalidate();
        }
        let record = ObservedOriginalRecord {
            collection: self.collection,
            position: head.seq,
            chain: head.chain,
        };
        remember(
            &mut next.hints,
            head,
            record,
            created,
            enrolled,
            target_key_delivered,
        );
        if let Some(verified) = &mut next.verified {
            remember(
                verified,
                head,
                record,
                created,
                enrolled,
                target_key_delivered,
            );
        }
        next
    }
    pub(super) fn hint_bytes(&self) -> Option<Vec<u8>> {
        let encoded = cbor::encode(&Cbor::Array(vec![
            Cbor::Uint(1),
            self.collection.to_cbor(),
            self.hints.genesis.map_or(Cbor::Null, encode_record),
            encode_map(&self.hints.grants),
            encode_map(&self.hints.devices),
            self.hints.delivery.map_or(Cbor::Null, encode_record),
        ]))
        .ok()?;
        (encoded.len() <= MAX_HINT_BYTES).then_some(encoded)
    }
}
impl<S: Store> Replica<S> {
    /// Own actual accepted genesis correlation, unavailable from warm hints or
    /// snapshot/read-ahead state. Historical DATA, not a current authority lease.
    pub fn observed_original_genesis(&self) -> Option<ObservedOriginalRecord> {
        self.check_apply_store_health().ok()?;
        self.original_history.genesis(self.store_generation)
    }
    /// Own first accepted app-grant record correlation in this native prefix.
    pub fn observed_original_grant(&self, grant: &Uuid) -> Option<ObservedOriginalRecord> {
        self.check_apply_store_health().ok()?;
        self.original_history.grant(self.store_generation, grant)
    }
    /// Own first accepted device-enrollment record correlation (not CP owner).
    pub fn observed_original_device(&self, device: &Uuid) -> Option<ObservedOriginalRecord> {
        self.check_apply_store_health().ok()?;
        self.original_history.device(self.store_generation, device)
    }
    /// Exact accepted record for THIS target's currently held FULL key delivery.
    pub fn observed_original_key_delivery(&self) -> Option<ObservedOriginalRecord> {
        self.check_apply_store_health().ok()?;
        let crate::HostedAdmission::Verified(native) = self.verified_hosted_admission() else {
            return None;
        };
        let record = self.original_history.delivery(self.store_generation)?;
        (record.position == native.key_delivery_seq()).then_some(record)
    }
}

// Identity extraction from an ALREADY accepted native semantic verdict, not a
// second reducer. A bounded unsupported record simply has no origin observation.
pub(super) fn control_subjects(item: &mdbn_wire::envelope::Item) -> (Vec<Uuid>, Vec<Uuid>) {
    use mdbn_wire::{
        envelope::ItemKind,
        policy::{PolicyOp, PolicyPayload},
    };
    if item.kind != ItemKind::Policy || item.body.0.len() > 64 * 1024 {
        return (Vec::new(), Vec::new());
    }
    let Ok(payload) = PolicyPayload::from_bytes(&item.body.0) else {
        return (Vec::new(), Vec::new());
    };
    let mut grants = Vec::new();
    let mut devices = Vec::new();
    for op in &payload.ops {
        match op {
            PolicyOp::Grant(g) if grants.len() < MAX_ORIGINS_PER_SUBJECT => grants.push(g.grant),
            PolicyOp::DeviceEnrol(d) if devices.len() < MAX_ORIGINS_PER_SUBJECT => {
                devices.push(d.device)
            }
            _ => {}
        }
    }
    (grants, devices)
}

fn remember(
    refs: &mut References,
    head: Head,
    record: ObservedOriginalRecord,
    created: &[Uuid],
    enrolled: &[Uuid],
    target_key_delivered: bool,
) {
    if head.seq == 1 && refs.genesis.is_none() {
        refs.genesis = Some(record);
    }
    for (map, ids) in [(&mut refs.grants, created), (&mut refs.devices, enrolled)] {
        // Never overwrite an original, silently evict one, or grow unbounded.
        // Exhaustion makes untracked origins unavailable, not policy invalid.
        for id in ids {
            if map.len() < MAX_ORIGINS_PER_SUBJECT {
                map.entry(*id).or_insert(record);
            }
        }
    }
    if target_key_delivered {
        refs.delivery = Some(record);
    }
}
fn encode_map(map: &BTreeMap<Uuid, ObservedOriginalRecord>) -> Cbor {
    Cbor::Array(
        map.iter()
            .map(|(id, record)| Cbor::Array(vec![id.to_cbor(), encode_record(*record)]))
            .collect(),
    )
}
fn encode_record(record: ObservedOriginalRecord) -> Cbor {
    Cbor::Array(vec![Cbor::Uint(record.position), record.chain.to_cbor()])
}
fn decode_record(collection: Uuid, value: &Cbor) -> Option<ObservedOriginalRecord> {
    let Cbor::Array(a) = value else {
        return None;
    };
    let [Cbor::Uint(position), chain] = a.as_slice() else {
        return None;
    };
    if *position == 0 {
        return None;
    }
    Some(ObservedOriginalRecord {
        collection,
        position: *position,
        chain: Hash::from_cbor(chain).ok()?,
    })
}
fn decode_hints(collection: Uuid, bytes: &[u8]) -> Option<References> {
    if bytes.len() > MAX_HINT_BYTES {
        return None;
    }
    let Cbor::Array(a) = cbor::decode(bytes).ok()? else {
        return None;
    };
    let [Cbor::Uint(1), declared, genesis, grants, devices, delivery] = a.as_slice() else {
        return None;
    };
    if Uuid::from_cbor(declared).ok()? != collection {
        return None;
    }
    let genesis = if *genesis == Cbor::Null {
        None
    } else {
        let record = decode_record(collection, genesis)?;
        if record.position != 1 {
            return None;
        }
        Some(record)
    };
    Some(References {
        genesis,
        grants: decode_map(collection, grants)?,
        devices: decode_map(collection, devices)?,
        delivery: if *delivery == Cbor::Null {
            None
        } else {
            Some(decode_record(collection, delivery)?)
        },
    })
}
fn decode_map(collection: Uuid, value: &Cbor) -> Option<BTreeMap<Uuid, ObservedOriginalRecord>> {
    let Cbor::Array(entries) = value else {
        return None;
    };
    if entries.len() > MAX_ORIGINS_PER_SUBJECT {
        return None;
    }
    let mut out = BTreeMap::new();
    let mut previous = None;
    for entry in entries {
        let Cbor::Array(a) = entry else {
            return None;
        };
        let [grant, record] = a.as_slice() else {
            return None;
        };
        let grant = Uuid::from_cbor(grant).ok()?;
        if previous.is_some_and(|p| grant <= p) {
            return None;
        }
        previous = Some(grant);
        out.insert(grant, decode_record(collection, record)?);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use mdbn_wire::common::{B16, B32};
    fn context() -> OriginalHistory {
        OriginalHistory::new(B16([1; 16]), 7, Head::GENESIS, 0, None)
    }
    #[test]
    fn persisted_hints_never_reconstitute_native_observations() {
        let h = context().prepare(
            7,
            Head {
                seq: 1,
                chain: B32([3; 32]),
            },
            &[B16([2; 16])],
            &[B16([6; 16])],
            true,
        );
        let bytes = h.hint_bytes().unwrap();
        assert!(h.genesis(7).is_some());
        assert!(h.grant(7, &B16([2; 16])).is_some());
        let warm = OriginalHistory::new(
            B16([1; 16]),
            8,
            Head {
                seq: 1,
                chain: B32([3; 32]),
            },
            1,
            Some(&bytes),
        );
        assert!(warm.genesis(8).is_none());
        assert!(warm.grant(8, &B16([2; 16])).is_none());
        assert_eq!(warm.hint_bytes(), Some(bytes));
    }
    #[test]
    fn generation_or_invalidation_never_revives_an_origin() {
        let mut h = context().prepare(
            7,
            Head {
                seq: 1,
                chain: B32([3; 32]),
            },
            &[B16([2; 16])],
            &[B16([6; 16])],
            true,
        );
        assert!(h.grant(8, &B16([2; 16])).is_none());
        h.invalidate();
        let h = h.prepare(
            7,
            Head {
                seq: 2,
                chain: B32([4; 32]),
            },
            &[B16([5; 16])],
            &[B16([7; 16])],
            true,
        );
        assert!(h.grant(7, &B16([5; 16])).is_none());
        assert!(h.genesis(7).is_none());
    }
}
