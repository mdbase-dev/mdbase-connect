//! Local signed-original thin-app binding, not admission or current authority.
//! Reuses the replica's strict signature/pin APIs; no store, keys or effects.

use mdbn_replica::crypto::sign::{Ed25519Verifier, verify_item};
use mdbn_replica::policy::{PolicyKeyPin, PolicyPins, RootPin, key_id};
use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::common::{B16, B32, Uuid};
use mdbn_wire::envelope::{Item, ItemKind};
use mdbn_wire::hash::{CHAIN_ZERO, chain_hash, sha256};
use mdbn_wire::policy::{CState, Grant, PolicyOp, PolicyPayload};
use mdbn_wire::schema::Wire;

use crate::noise_sessions::VerifiedAppCaller;

/// Per-record raw-byte cap before hashing or decoding; at most two records.
pub const MAX_ORIGINAL_POLICY_BYTES: usize = 64 * 1024;

/// Trusted admission declarations, NOT authenticated admission/history/authority.
/// Hashes/positions must select original records, never restored projections.
#[derive(Clone)]
pub struct OriginalAppPins {
    /// Exact nonnil collection.
    pub collection: Uuid,
    /// Original run owner, not a restored current-owner projection.
    pub owner: Uuid,
    /// Declared expected service device; equality is not deployment identity.
    pub target_device: Uuid,
    /// LS grant UUID, not a CP grants.id or enrolled device UUID.
    pub grant: Uuid,
    /// Original app installation UUID.
    pub installation: Uuid,
    /// Expected Noise client key declaration; current CP must separately match.
    pub client_pk: B32,
    /// Trusted original root public key.
    pub root_pk: B32,
    /// Pinned original policy signer public key for both selected records.
    pub policy_pk: B32,
    /// SHA256 of exact signed original genesis bytes.
    pub genesis_sha256: B32,
    /// SHA256 of exact signed original grant policy bytes.
    pub grant_sha256: B32,
    /// Original grant policy position (may equal one only in the genesis record).
    pub grant_seq: u64,
}

/// Public declaration encoding cap, checked before CBOR decode. The host's ABI
/// allocation/copy precedes this check; not a peak-memory or admission guarantee.
pub const MAX_APP_QUERY_DECLARATION_BYTES: usize = 512;

impl OriginalAppPins {
    /// Decode the host-only fixed eleven-field declaration array. Data only:
    /// configured trust, signatures, caller/context and anchors are checked by
    /// Engine separately. Not request admission, a decoded caller or a permit.
    pub fn decode_query_declarations(
        bytes: &[u8],
    ) -> std::result::Result<Self, OriginalAppRefused> {
        let refuse = || OriginalAppRefused;
        if bytes.is_empty() || bytes.len() > MAX_APP_QUERY_DECLARATION_BYTES {
            return Err(refuse());
        }
        let Cbor::Array(v) = cbor::decode(bytes).map_err(|_| refuse())? else {
            return Err(refuse());
        };
        if v.len() != 11 {
            return Err(refuse());
        }
        let uuid = |i: usize| B16::from_cbor(&v[i]).map_err(|_| refuse());
        let key = |i: usize| B32::from_cbor(&v[i]).map_err(|_| refuse());
        let seq = match &v[10] {
            Cbor::Uint(seq) => *seq,
            _ => return Err(refuse()),
        };
        if seq == 0 {
            return Err(refuse());
        }
        Ok(Self {
            collection: uuid(0)?,
            owner: uuid(1)?,
            target_device: uuid(2)?,
            grant: uuid(3)?,
            installation: uuid(4)?,
            client_pk: key(5)?,
            root_pk: key(6)?,
            policy_pk: key(7)?,
            genesis_sha256: key(8)?,
            grant_sha256: key(9)?,
            grant_seq: seq,
        })
    }
}

/// Opaque caller + historical signed grant, relative to trusted input pins.
/// No external constructor, decoded-grant replacement or current-permission flag.
/// A clone is historical evidence, not session liveness, admission or a lease.
#[derive(Clone)]
pub struct OriginalAppCaller {
    caller: VerifiedAppCaller,
    owner: Uuid,
    root: B16,
    policy_key: B16,
    genesis_sha256: B32,
    grant_sha256: B32,
    grant_seq: u64,
    grant: Grant,
}
impl std::fmt::Debug for OriginalAppCaller {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("OriginalAppCaller { .. }")
    }
}
impl OriginalAppCaller {
    /// Initial Noise proof, not completed transport/current authority.
    pub fn caller(&self) -> &VerifiedAppCaller {
        &self.caller
    }
    /// Original signed owner, not current membership permission.
    pub fn owner(&self) -> Uuid {
        self.owner
    }
    /// Trusted root's original signed key ID.
    pub fn root(&self) -> B16 {
        self.root
    }
    /// Original certified policy signer key ID, not current CP authority.
    pub fn policy_key_id(&self) -> B16 {
        self.policy_key
    }
    /// Exact original signed genesis anchor.
    pub fn genesis_sha256(&self) -> B32 {
        self.genesis_sha256
    }
    /// Exact original signed grant policy anchor.
    pub fn grant_sha256(&self) -> B32 {
        self.grant_sha256
    }
    /// Original grant policy position.
    pub fn grant_seq(&self) -> u64 {
        self.grant_seq
    }
    /// All signed grant fields, preserved as historical data only. Capabilities,
    /// folders and key equality never replace fresh CP/phase/effect admission.
    pub fn signed_grant(&self) -> &Grant {
        &self.grant
    }
}

/// Fixed diagnostic with no input, public key or grant payload disclosure.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OriginalAppRefused;
type Result<T> = std::result::Result<T, OriginalAppRefused>;

fn policy(
    bytes: &[u8],
    collection: Uuid,
    seq: u64,
    pins: &OriginalAppPins,
) -> Result<(Item, PolicyPayload)> {
    let refuse = || OriginalAppRefused;
    let item = Item::from_bytes(bytes).map_err(|_| refuse())?;
    item.check_shape().map_err(|_| refuse())?;
    if item.kind != ItemKind::Policy || item.collection != collection || item.seq != Some(seq) {
        return Err(refuse());
    }
    let payload = PolicyPayload::from_bytes(&item.body.0).map_err(|_| refuse())?;
    let cert = &payload.cert;
    if payload.ops.is_empty()
        || payload.ops.len() > 64
        || cert.root != key_id(&pins.root_pk.0)
        || cert.policy_pk != pins.policy_pk
        || item.signer != Some(cert.key_id())
        || payload.issued_at < cert.not_before
        || payload.issued_at > cert.not_after
    {
        return Err(refuse());
    }
    let digest = cert.signed_digest().map_err(|_| refuse())?;
    if !Ed25519Verifier.verify(&pins.root_pk.0, &digest.0, &cert.sig.0)
        || !verify_item(&pins.policy_pk.0, &item)
    {
        return Err(refuse());
    }
    Ok((item, payload))
}

/// Bind a real Noise caller to exact original signed genesis and grant policies.
/// Each raw record is capped before any hash/decode; at most four bounded typed
/// decode boundaries and four signature checks. This is not a whole-request
/// ledger, transport cancellation or peak-allocation proof. No history/store
/// resolution occurs: anchors must be independently admitted as ORIGINAL.
/// Same-genesis grants require identical raw bytes; seq2 requires the genesis
/// chain link. Later positions rely on admitted anchors, not reconstructed history.
/// Full historical policy validity/commitment, current client-key rotation,
/// membership/revocation/CP+phase/final effects remain separate prerequisites.
pub fn bind_original_app_caller(
    caller: &VerifiedAppCaller,
    pins: &OriginalAppPins,
    genesis: &[u8],
    grant_record: &[u8],
) -> Result<OriginalAppCaller> {
    let refuse = || OriginalAppRefused;
    if genesis.is_empty()
        || grant_record.is_empty()
        || genesis.len() > MAX_ORIGINAL_POLICY_BYTES
        || grant_record.len() > MAX_ORIGINAL_POLICY_BYTES
        || pins.grant_seq == 0
        || [
            pins.collection,
            pins.owner,
            pins.target_device,
            pins.grant,
            pins.installation,
        ]
        .iter()
        .any(|id| id.0 == [0; 16])
        || [
            pins.client_pk,
            pins.root_pk,
            pins.policy_pk,
            pins.genesis_sha256,
            pins.grant_sha256,
        ]
        .iter()
        .any(|pk| pk.0 == [0; 32])
        || caller.collection() != pins.collection
        || caller.grant() != pins.grant
        || caller.target_device() != pins.target_device
        || caller.client_pk() != pins.client_pk
    {
        return Err(refuse());
    }
    let root = key_id(&pins.root_pk.0);
    let policy_key = key_id(&pins.policy_pk.0);
    PolicyPins {
        roots: vec![RootPin {
            root_id: root,
            root_pk: pins.root_pk,
        }],
        policy_keys: vec![PolicyKeyPin {
            key_id: policy_key,
            policy_pk: pins.policy_pk,
            root_id: root,
        }],
    }
    .validate()
    .map_err(|_| refuse())?;
    if sha256(genesis) != pins.genesis_sha256 || sha256(grant_record) != pins.grant_sha256 {
        return Err(refuse());
    }
    let (g, gp) = policy(genesis, pins.collection, 1, pins)?;
    let Some(PolicyOp::Genesis(original)) = gp.ops.first() else {
        return Err(refuse());
    };
    if g.prev != Some(CHAIN_ZERO)
        || original.owner != pins.owner
        || original.root != root
        || original.state != CState::CloudCopy
        || gp
            .ops
            .iter()
            .filter(|op| matches!(op, PolicyOp::Genesis(_)))
            .count()
            != 1
    {
        return Err(refuse());
    }
    let (item, payload) = policy(grant_record, pins.collection, pins.grant_seq, pins)?;
    if (pins.grant_seq == 1 && grant_record != genesis)
        || (pins.grant_seq == 2 && item.prev != Some(chain_hash(genesis)))
        || payload.issued_at < gp.issued_at
        || (pins.grant_seq > 1
            && payload
                .ops
                .iter()
                .any(|op| matches!(op, PolicyOp::Genesis(_))))
    {
        return Err(refuse());
    }
    let mut matches = payload.ops.iter().filter_map(|op| match op {
        PolicyOp::Grant(g) if g.grant == pins.grant => Some(g),
        _ => None,
    });
    let grant = matches.next().ok_or_else(refuse)?;
    if matches.next().is_some()
        || grant.client_pk != caller.client_pk()
        || grant.account != pins.owner
        || grant.installation != pins.installation
    {
        return Err(refuse());
    }
    Ok(OriginalAppCaller {
        caller: caller.clone(),
        owner: original.owner,
        root,
        policy_key,
        genesis_sha256: pins.genesis_sha256,
        grant_sha256: pins.grant_sha256,
        grant_seq: pins.grant_seq,
        grant: grant.clone(),
    })
}
