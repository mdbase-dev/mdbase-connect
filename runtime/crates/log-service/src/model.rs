//! The service's own state: what a backend stores per collection.
//!
//! Everything here is routing and transport metadata the service is allowed to see
//! (`sealed-envelope.md` §8). Item and object bytes are opaque.

use std::collections::BTreeMap;

use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::common::{B16, B32, Uuid};

use crate::error::{Result, ServiceError};
use crate::limits;

/// Collection lifecycle at the service.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    /// Accepting appends.
    Live,
    /// Deleted or moved (`gone`).
    Gone,
    /// Being restored by `import`; requests get `unavailable` (§12).
    Importing,
}

/// Per-collection quotas (§11), set by the control plane.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Quotas {
    /// Retained items plus live objects.
    pub storage_bytes: u64,
    /// Sustained append rate, items per second.
    pub items_per_s: u64,
    /// Sustained append rate, bytes per second.
    pub bytes_per_s: u64,
    /// Burst, items.
    pub burst_items: u64,
}

impl Default for Quotas {
    fn default() -> Self {
        Quotas {
            storage_bytes: limits::DEFAULT_STORAGE_BYTES,
            items_per_s: limits::DEFAULT_ITEMS_PER_S,
            bytes_per_s: limits::DEFAULT_BYTES_PER_S,
            burst_items: limits::DEFAULT_BURST_ITEMS,
        }
    }
}

/// How long compacted entries and dead objects stay in the archive. Chosen per
/// collection; stored only backend-side (no wire field yet).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RetentionTier {
    /// 30 days (default).
    #[default]
    Days30,
    /// 365 days (paid).
    Days365,
}

impl RetentionTier {
    /// The archive key prefix component: `30d` or `365d`.
    pub fn as_str(self) -> &'static str {
        match self {
            RetentionTier::Days30 => "30d",
            RetentionTier::Days365 => "365d",
        }
    }
    /// Retention in days.
    pub fn days(self) -> u64 {
        match self {
            RetentionTier::Days30 => 30,
            RetentionTier::Days365 => 365,
        }
    }
    /// From the stored day count.
    pub fn from_days(d: u64) -> Option<Self> {
        match d {
            30 => Some(RetentionTier::Days30),
            365 => Some(RetentionTier::Days365),
            _ => None,
        }
    }
}

/// The collection row: head, transport policy state, quotas.
#[derive(Debug, Clone, PartialEq)]
pub struct CollectionMeta {
    /// Collection ID.
    pub id: Uuid,
    /// Head position.
    pub head: u64,
    /// chain(head).
    pub head_chain: B32,
    /// Current key epoch (0 before the initial rekey).
    pub epoch: u64,
    /// A revocation with no rekey after it.
    pub rekey_required: bool,
    /// Frozen flag.
    pub frozen: bool,
    /// Root key ID (genesis).
    pub root: B16,
    /// Owner account (genesis).
    pub owner: Uuid,
    /// 0 = e2e, 1 = cloud-copy.
    pub cstate: u64,
    /// Live or gone.
    pub status: Status,
    /// Latest valid policy `issued_at` (policy.md §3 rule 4).
    pub last_issued_at: i64,
    /// Revoked control-plane keys: key ID → revoked_from.
    pub revoked_cp_keys: BTreeMap<B16, i64>,
    /// Members: account → role (0 viewer, 1 editor, 2 owner).
    pub members: BTreeMap<Uuid, u64>,
    /// A `migration-cutover` has been applied.
    pub cutover: bool,
    /// Lowest retained `entry` position.
    pub retained_from: u64,
    /// Quotas.
    pub quotas: Quotas,
    /// Retained item bytes plus committed object bytes.
    pub used_bytes: u64,
    /// Service time of creation.
    pub created_at: i64,
    /// Archive retention for compacted entries and dead objects.
    pub retention_tier: RetentionTier,
    /// Authenticated source bounds while quarantined for logical restore only.
    /// Cleared atomically before Live; never changes the stored collection quota.
    pub restore_plan: Option<crate::restore_plan::RestorePlan>,
    /// Durable terminal identity, only present with Gone; old Gone has none.
    pub deletion: Option<crate::deletion::CollectionDeletionRecord>,
}

impl CollectionMeta {
    /// A fresh collection before its genesis item.
    pub fn new(id: Uuid, now: i64) -> Self {
        CollectionMeta {
            id,
            head: 0,
            head_chain: mdbn_wire::hash::CHAIN_ZERO,
            epoch: 0,
            rekey_required: false,
            frozen: false,
            root: B16([0; 16]),
            owner: B16([0; 16]),
            cstate: 0,
            status: Status::Live,
            last_issued_at: i64::MIN,
            revoked_cp_keys: BTreeMap::new(),
            members: BTreeMap::new(),
            cutover: false,
            retained_from: 1,
            quotas: Quotas::default(),
            used_bytes: 0,
            created_at: now,
            retention_tier: RetentionTier::default(),
            restore_plan: None,
            deletion: None,
        }
    }

    /// Private encoding for backends that store the row as one value (CBOR map).
    pub fn encode(&self) -> Vec<u8> {
        let u = Cbor::Uint;
        let b = |x: &[u8]| Cbor::Bytes(x.to_vec());
        let mut m = vec![
            (u(0), b(&self.id.0)),
            (u(1), u(self.head)),
            (u(2), b(&self.head_chain.0)),
            (u(3), u(self.epoch)),
            (u(4), Cbor::Bool(self.rekey_required)),
            (u(5), Cbor::Bool(self.frozen)),
            (u(6), b(&self.root.0)),
            (u(7), b(&self.owner.0)),
            (u(8), u(self.cstate)),
            (
                u(9),
                u(match self.status {
                    Status::Live => 0,
                    Status::Gone => 1,
                    Status::Importing => 2,
                }),
            ),
            (u(10), Cbor::int(self.last_issued_at)),
            (
                u(11),
                Cbor::Array(
                    self.revoked_cp_keys
                        .iter()
                        .map(|(k, t)| Cbor::Array(vec![b(&k.0), Cbor::int(*t)]))
                        .collect(),
                ),
            ),
            (
                u(12),
                Cbor::Array(
                    self.members
                        .iter()
                        .map(|(a, r)| Cbor::Array(vec![b(&a.0), u(*r)]))
                        .collect(),
                ),
            ),
            (u(13), Cbor::Bool(self.cutover)),
            (u(14), u(self.retained_from)),
            (
                u(15),
                Cbor::Array(vec![
                    u(self.quotas.storage_bytes),
                    u(self.quotas.items_per_s),
                    u(self.quotas.bytes_per_s),
                    u(self.quotas.burst_items),
                ]),
            ),
            (u(16), u(self.used_bytes)),
            (u(17), Cbor::int(self.created_at)),
            (u(18), u(self.retention_tier.days())),
        ];
        if let Some(plan) = &self.restore_plan {
            m.push((u(19), plan.to_cbor()));
            m.push((u(20), b(&plan.progress.0)));
        }
        if let Some(deletion) = self.deletion {
            m.push((u(21), deletion.to_cbor()));
        }
        cbor::encode(&Cbor::Map(m)).expect("meta encodes")
    }

    /// Decode [`CollectionMeta::encode`].
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        Self::decode_with_budget(bytes, &crate::decode::Budget::default())
    }

    /// Decode persisted projection state with the enclosing request's budget.
    pub fn decode_with_budget(bytes: &[u8], budget: &crate::decode::Budget) -> Result<Self> {
        let bad = || ServiceError::backend("corrupt collection meta");
        let c = budget.raw(bytes).map_err(|e| {
            if crate::decode::is_resource_refusal(&e) {
                e
            } else {
                bad()
            }
        })?;
        let Cbor::Map(m) = c else { return Err(bad()) };
        let get = |k: u64| {
            m.iter()
                .find(|(kk, _)| *kk == Cbor::Uint(k))
                .map(|(_, v)| v)
                .ok_or_else(bad)
        };
        let uint = |k: u64| match get(k)? {
            Cbor::Uint(n) => Ok(*n),
            _ => Err(bad()),
        };
        let int = |k: u64| get(k)?.as_i64().ok_or_else(bad);
        let boolean = |k: u64| match get(k)? {
            Cbor::Bool(v) => Ok(*v),
            _ => Err(bad()),
        };
        let b16 = |c: &Cbor| match c {
            Cbor::Bytes(x) if x.len() == 16 => Ok(B16(x.as_slice().try_into().unwrap())),
            _ => Err(bad()),
        };
        let b32 = |c: &Cbor| match c {
            Cbor::Bytes(x) if x.len() == 32 => Ok(B32(x.as_slice().try_into().unwrap())),
            _ => Err(bad()),
        };
        let arr = |k: u64| match get(k)? {
            Cbor::Array(a) => Ok(a.clone()),
            _ => Err(bad()),
        };
        let mut revoked_cp_keys = BTreeMap::new();
        for e in arr(11)? {
            let Cbor::Array(p) = e else { return Err(bad()) };
            revoked_cp_keys.insert(b16(&p[0])?, p[1].as_i64().ok_or_else(bad)?);
        }
        let mut members = BTreeMap::new();
        for e in arr(12)? {
            let Cbor::Array(p) = e else { return Err(bad()) };
            let Cbor::Uint(r) = p[1] else {
                return Err(bad());
            };
            members.insert(b16(&p[0])?, r);
        }
        let q = arr(15)?;
        let qn = |i: usize| match q.get(i) {
            Some(Cbor::Uint(n)) => Ok(*n),
            _ => Err(bad()),
        };
        let restore_plan = match get(19) {
            Ok(value) => {
                let mut plan = crate::restore_plan::RestorePlan::parse(value).map_err(|_| bad())?;
                plan.progress = b32(get(20)?)?;
                Some(plan)
            }
            Err(_) => None,
        };
        let id = b16(get(0)?)?;
        let deletion = match m.iter().find(|(k, _)| *k == Cbor::Uint(21)) {
            Some((_, value)) => {
                let record = crate::deletion::CollectionDeletionRecord::parse(value)?;
                if record.collection != id || uint(9)? != 1 {
                    return Err(bad());
                }
                Some(record)
            }
            None => None,
        };
        Ok(CollectionMeta {
            id,
            head: uint(1)?,
            head_chain: b32(get(2)?)?,
            epoch: uint(3)?,
            rekey_required: boolean(4)?,
            frozen: boolean(5)?,
            root: b16(get(6)?)?,
            owner: b16(get(7)?)?,
            cstate: uint(8)?,
            status: match uint(9)? {
                1 => Status::Gone,
                2 => Status::Importing,
                _ => Status::Live,
            },
            last_issued_at: int(10)?,
            revoked_cp_keys,
            members,
            cutover: boolean(13)?,
            retained_from: uint(14)?,
            quotas: Quotas {
                storage_bytes: qn(0)?,
                items_per_s: qn(1)?,
                bytes_per_s: qn(2)?,
                burst_items: qn(3)?,
            },
            used_bytes: uint(16)?,
            created_at: int(17)?,
            // Rows written before the archive existed have no key 18: 30 days.
            retention_tier: match get(18) {
                Ok(Cbor::Uint(d)) => RetentionTier::from_days(*d).ok_or_else(bad)?,
                Ok(_) => return Err(bad()),
                Err(_) => RetentionTier::default(),
            },
            restore_plan,
            deletion,
        })
    }
}

/// One device in the collection's transport ACL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AclEntry {
    /// Device ID.
    pub device: Uuid,
    /// Account it belongs to (all-zero for service devices).
    pub account: Uuid,
    /// Device kind (`policy.md` device-kind).
    pub kind: u64,
    /// Ed25519 signing key.
    pub sign_pk: B32,
    /// Not revoked.
    pub active: bool,
}

/// Device kinds the service treats specially.
pub mod device_kind {
    /// The hosted replica.
    pub const HOSTED: u64 = 4;
    /// The escrow service.
    pub const ESCROW: u64 = 5;
    /// A member's offline recovery device (no transport authority).
    pub const RECOVERY: u64 = 6;
}

/// The loaded state of one collection.
#[derive(Debug, Clone, PartialEq)]
pub struct CollectionState {
    /// The collection row.
    pub meta: CollectionMeta,
    /// The ACL, by device.
    pub acl: BTreeMap<Uuid, AclEntry>,
}

/// A stored log item.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredItem {
    /// Position.
    pub seq: u64,
    /// Item kind (envelope kind number).
    pub kind: u64,
    /// Canonical envelope bytes, exactly as appended (I7).
    pub bytes: Vec<u8>,
    /// Service time of the append.
    pub appended_at: i64,
    /// Idempotency token (`entry` only).
    pub token: Option<B16>,
    /// Object addresses referenced (for GC).
    pub refs: Vec<B32>,
}

/// Object metadata. Bytes live in the object store under [`object_key`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObjectMeta {
    /// Address.
    pub address: B32,
    /// Kind (16 manifest, 17 chunk, 18 blob-part).
    pub kind: u64,
    /// Exact size.
    pub size: u64,
    /// SHA-256 of the bytes.
    pub checksum: B32,
    /// Committed (visible). Uncommitted rows are pending direct uploads.
    pub committed: bool,
    /// Upload time (service clock).
    pub created_at: i64,
}

/// A retained snapshot pointer and its refs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotRow {
    /// Position.
    pub seq: u64,
    /// Manifest address.
    pub manifest: B32,
    /// Author device.
    pub author: Uuid,
    /// Service time.
    pub created_at: i64,
    /// Endorsed by another device.
    pub endorsed: bool,
    /// Chunk and blob-part addresses referenced (includes the manifest).
    pub refs: Vec<B32>,
}

/// Object-store key: `c/<collection>/<hex address>` (§6).
pub fn object_key(collection: &Uuid, address: &B32) -> String {
    format!("c/{}/{}", collection.to_uuid_string(), address.to_hex())
}

/// Archive key of a compacted-entry segment:
/// `archive/<tier>/<collection hex>/segments/<from>-<to>`.
pub fn archive_segment_key(collection: &Uuid, tier: RetentionTier, from: u64, to: u64) -> String {
    format!(
        "archive/{}/{}/segments/{from}-{to}",
        tier.as_str(),
        collection.to_hex()
    )
}

/// Archive key of a dead object's bytes:
/// `archive/<tier>/<collection hex>/objects/<address hex>`.
pub fn archive_object_key(collection: &Uuid, tier: RetentionTier, address: &B32) -> String {
    format!(
        "archive/{}/{}/objects/{}",
        tier.as_str(),
        collection.to_hex(),
        address.to_hex()
    )
}

/// What a commit tells the push layer (PG: `NOTIFY` payload; DO: local hub).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitNotice {
    /// Collection.
    pub collection: Uuid,
    /// First new position (0 if the head did not move).
    pub first: u64,
    /// New head.
    pub head: u64,
    /// chain(head).
    pub head_chain: B32,
    /// Devices revoked by this commit: their subscriptions close.
    pub revoked: Vec<Uuid>,
    /// The collection became `gone`.
    pub gone: bool,
}

impl CommitNotice {
    /// Compact text form, for `pg_notify` payloads (well under 8,000 bytes for ≤ 64 revocations).
    pub fn to_text(&self) -> String {
        let mut s = format!(
            "{}:{}:{}:{}:{}",
            self.first,
            self.head,
            self.head_chain.to_hex(),
            self.gone as u8,
            self.collection.to_hex()
        );
        for d in &self.revoked {
            s.push(':');
            s.push_str(&d.to_hex());
        }
        s
    }
    /// Parse [`CommitNotice::to_text`].
    pub fn from_text(s: &str) -> Option<Self> {
        let mut it = s.split(':');
        let first = it.next()?.parse().ok()?;
        let head = it.next()?.parse().ok()?;
        let head_chain = B32(unhex(it.next()?)?.try_into().ok()?);
        let gone = it.next()? == "1";
        let collection = B16(unhex(it.next()?)?.try_into().ok()?);
        let mut revoked = Vec::new();
        for d in it {
            revoked.push(B16(unhex(d)?.try_into().ok()?));
        }
        Some(CommitNotice {
            collection,
            first,
            head,
            head_chain,
            revoked,
            gone,
        })
    }
}

/// Lowercase hex decode.
pub fn unhex(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok())
        .collect()
}

/// Parse a hyphenated or plain-hex UUID.
pub fn parse_uuid(s: &str) -> Option<Uuid> {
    let h: String = s.chars().filter(|c| *c != '-').collect();
    Some(B16(unhex(&h)?.try_into().ok()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn meta_roundtrip() {
        let mut m = CollectionMeta::new(B16([7; 16]), 42);
        m.members.insert(B16([1; 16]), 2);
        m.revoked_cp_keys.insert(B16([2; 16]), -5);
        m.head = 9;
        assert_eq!(CollectionMeta::decode(&m.encode()).unwrap(), m);
        m.retention_tier = RetentionTier::Days365;
        assert_eq!(CollectionMeta::decode(&m.encode()).unwrap(), m);
    }

    #[test]
    fn meta_without_tier_decodes_as_30d() {
        let m = CollectionMeta::new(B16([7; 16]), 42);
        let Cbor::Map(mut entries) = cbor::decode(&m.encode()).unwrap() else {
            panic!("map");
        };
        entries.retain(|(k, _)| *k != Cbor::Uint(18));
        let old = cbor::encode(&Cbor::Map(entries)).unwrap();
        let d = CollectionMeta::decode(&old).unwrap();
        assert_eq!(d.retention_tier, RetentionTier::Days30);
        assert_eq!(d, m);
    }

    #[test]
    fn notice_roundtrip() {
        let n = CommitNotice {
            collection: B16([3; 16]),
            first: 4,
            head: 6,
            head_chain: B32([9; 32]),
            revoked: vec![B16([1; 16])],
            gone: false,
        };
        assert_eq!(CommitNotice::from_text(&n.to_text()).unwrap(), n);
    }
}
