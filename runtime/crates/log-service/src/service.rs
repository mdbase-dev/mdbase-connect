//! The platform-neutral service: every durable operation of `log-service-api.md`,
//! written once against [`Backend`] and [`ObjectStore`].

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::common::{B16, B32, Bytes, DataMap, Uuid};
use mdbn_wire::envelope::{Item, ItemKind, KeyGrantPayload};
use mdbn_wire::hash::{CHAIN_ZERO, chain_hash, sha256};
use mdbn_wire::log_service::{
    AppendParams, AppendResult, Appended, CommitObjectParams, DirectTransfer, Duplicate,
    EndorseSnapshotParams, GetObjectParams, GetObjectResult, GetSnapshotResult, HasObjectsParams,
    HasObjectsResult, HeadMoved, HeadParams, HeadResult, PutObjectParams, PutObjectResult,
    PutSnapshotParams, PutStatus, ReadKinds, ReadParams, ReadResult, SeqItem, SnapshotPointer,
};
use mdbn_wire::ref_index::{MAX_REF_INDICES, ref_index_addresses};
use mdbn_wire::schema::Wire;

use crate::auth::{Principal, hmac, verify_sig};
use crate::backend::{Archive, Backend, BudgetBackend, Mode, ObjectStore, Txn, Verified, Write};
use crate::decode::Budget;

#[cfg(not(target_arch = "wasm32"))]
mod offline;
use crate::error::{Code, Result, ServiceError};
use crate::limits::*;
use crate::model::{
    AclEntry, CollectionMeta, CollectionState, CommitNotice, ObjectMeta, Quotas, RetentionTier,
    SnapshotRow, Status, StoredItem, device_kind, object_key, parse_uuid, unhex,
};
use crate::policy::{apply_policy_with_budget, apply_rekey_with_budget};
use crate::restore::RestoreSettings;
use crate::restore_plan::RestorePlan;
#[cfg(not(target_arch = "wasm32"))]
pub use offline::OfflineReplayVerifier;

/// Service configuration.
#[derive(Debug, Clone)]
pub struct Config {
    /// Pinned control-plane root public keys (policy.md §2).
    pub roots: Vec<B32>,
    /// Accepted access-token issuer keys (the control plane's current and next).
    pub token_issuers: Vec<B32>,
    /// Secret for pre-signed transfer URLs and HTTP nonces.
    pub url_secret: Vec<u8>,
    /// Public base URL of the direct-transfer endpoint, e.g. `https://logs.example`.
    pub public_base: String,
}

impl Config {
    /// Production configuration from hex strings (comma-separated key lists):
    /// pinned root keys, token issuer keys, and a URL secret of at least 32 bytes.
    /// Keys are never derived from labels outside tests.
    pub fn from_hex(
        roots: &str,
        issuers: &str,
        url_secret: &str,
        public_base: &str,
    ) -> std::result::Result<Config, String> {
        let keys = |s: &str, what: &str| -> std::result::Result<Vec<B32>, String> {
            let v: Vec<B32> = s
                .split(',')
                .map(str::trim)
                .filter(|k| !k.is_empty())
                .map(|k| {
                    unhex(k)
                        .and_then(|b| b.try_into().ok())
                        .map(B32)
                        .ok_or_else(|| format!("{what}: bad key {k}"))
                })
                .collect::<std::result::Result<_, _>>()?;
            if v.is_empty() {
                return Err(format!("{what}: at least one key is required"));
            }
            Ok(v)
        };
        let secret = unhex(url_secret.trim()).ok_or("url secret: not hex")?;
        if secret.len() < 32 {
            return Err("url secret: at least 32 bytes".into());
        }
        if !public_base.starts_with("https://")
            && !public_base.starts_with("http://127.0.0.1")
            && !public_base.starts_with("http://localhost")
        {
            return Err("public base: https required outside loopback".into());
        }
        Ok(Config {
            roots: keys(roots, "root keys")?,
            token_issuers: keys(issuers, "token issuers")?,
            url_secret: secret,
            public_base: public_base.to_string(),
        })
    }
}

/// The outcome of one call: the result, plus what changed (for push).
#[derive(Debug, Clone, PartialEq)]
pub struct Outcome {
    /// The method's result.
    pub result: Cbor,
    /// A commit that moved the head or changed the ACL.
    pub notice: Option<CommitNotice>,
    /// The appended items, for inline pushes.
    pub items: Vec<(u64, Vec<u8>)>,
    /// A device whose credentials were just revoked (§12): hosts close its sessions.
    pub credentials_revoked: Option<Uuid>,
    /// A repair append (items signed by others) was committed: hosts log it and
    /// count it (`service_lost_tail`; a lost tail is an I1 violation ops must see).
    pub repair: Option<RepairAppend>,
}

/// A committed repair append, for logs and metrics.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepairAppend {
    /// Collection.
    pub collection: Uuid,
    /// The uploading device.
    pub uploader: Uuid,
    /// First restored position.
    pub first: u64,
    /// Last restored position.
    pub last: u64,
    /// Items in the batch signed by someone other than the uploader.
    pub foreign_items: u64,
}

/// Repair appends per uploader: sustained items per second.
pub const REPAIR_ITEMS_PER_S: u64 = 200;
/// Repair appends per uploader: burst.
pub const REPAIR_BURST_ITEMS: u64 = 2_000;

impl Outcome {
    fn plain(result: Cbor) -> Self {
        Outcome {
            result,
            notice: None,
            items: Vec::new(),
            credentials_revoked: None,
            repair: None,
        }
    }
}

/// Token bucket in integer milli-units.
#[derive(Debug, Clone, Copy)]
struct Bucket {
    items_milli: u64,
    bytes: u64,
    at: i64,
}

/// The log service over one backend and one object store.
pub struct Service<B, O> {
    /// Collection storage and per-collection serialization.
    pub backend: Arc<B>,
    /// Object bytes.
    pub objects: Arc<O>,
    /// Configuration.
    pub config: Config,
    buckets: Arc<Mutex<BTreeMap<Uuid, Bucket>>>,
    /// Credential revocation cache: device → (revoked, checked_at). Revocation is
    /// permanent, so `true` never expires; `false` is re-checked after
    /// [`CREDENTIAL_RECHECK_MS`].
    creds: Arc<Mutex<BTreeMap<Uuid, (bool, i64)>>>,
}

/// How long a "not revoked" answer is trusted before the store is asked again.
pub const CREDENTIAL_RECHECK_MS: i64 = 30_000;

fn bad_params(e: impl std::fmt::Display) -> ServiceError {
    ServiceError::invalid("shape").msg(format!("params: {e}"))
}

fn map(entries: Vec<(u64, Cbor)>) -> Cbor {
    Cbor::Map(
        entries
            .into_iter()
            .map(|(k, v)| (Cbor::Uint(k), v))
            .collect(),
    )
}

fn field(params: &Cbor, k: u64) -> Option<&Cbor> {
    match params {
        Cbor::Map(m) => m
            .iter()
            .find(|(kk, _)| *kk == Cbor::Uint(k))
            .map(|(_, v)| v),
        _ => None,
    }
}

fn uuid_field(params: &Cbor, k: u64) -> Result<Uuid> {
    field(params, k)
        .and_then(|c| Uuid::from_cbor(c).ok())
        .ok_or_else(|| bad_params("collection"))
}

/// Base64 (standard, padded), for the checksum header.
pub fn base64(b: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::new();
    for c in b.chunks(3) {
        let n = (c[0] as u32) << 16
            | (*c.get(1).unwrap_or(&0) as u32) << 8
            | *c.get(2).unwrap_or(&0) as u32;
        s.push(T[(n >> 18) as usize & 63] as char);
        s.push(T[(n >> 12) as usize & 63] as char);
        s.push(if c.len() > 1 {
            T[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        s.push(if c.len() > 2 {
            T[n as usize & 63] as char
        } else {
            '='
        });
    }
    s
}

/// A verified direct-transfer request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectOp {
    /// `put` or `get`.
    pub put: bool,
    /// Collection.
    pub collection: Uuid,
    /// Address.
    pub address: B32,
    /// MAC-bound complete encoded-object size for both PUT and GET.
    pub sealed_size: u64,
    /// MAC-bound SHA-256 of the complete encoded object (not a range hash).
    pub sealed_checksum: B32,
    /// MAC-bound expiry, retained for bounded multipart session binding.
    pub expires_ms: i64,
    /// For `put`: the exact size and checksum the body must have.
    pub expect: Option<(u64, B32)>,
    /// For `put`: the uploading device. The bytes go to its staging key
    /// ([`staging_key`]), never to the object's final key.
    pub device: Option<Uuid>,
}

/// Where a device's direct upload lands until `commit_object` verifies it and
/// copies it, write-once, to the final key. Staging is per device, so a stale or
/// revoked device's URL can never touch a committed object or another device's
/// upload. Staging keys expire by object-store lifecycle (24 h).
pub fn staging_key(c: &Uuid, a: &B32, device: &Uuid) -> String {
    format!(
        "staging/c/{}/{}/{}",
        c.to_uuid_string(),
        a.to_hex(),
        device.to_hex()
    )
}

fn direct_mac(
    secret: &[u8],
    op: &str,
    c: &Uuid,
    a: &B32,
    dev: &str,
    size: u64,
    ck: &B32,
    exp: i64,
) -> [u8; 32] {
    let m = format!(
        "ls-direct|{op}|{}|{}|{dev}|{size}|{}|{exp}",
        c.to_hex(),
        a.to_hex(),
        ck.to_hex()
    );
    hmac(secret, m.as_bytes())
}

/// Parse `bytes=a-b` into `(offset, len)`, rejecting reversed, overflowing or
/// over-long ranges (≤ 9 MiB, the largest object).
pub fn parse_range(h: &str) -> Option<(u64, u64)> {
    let (a, b) = h.strip_prefix("bytes=")?.split_once('-')?;
    let (a, b): (u64, u64) = (a.trim().parse().ok()?, b.trim().parse().ok()?);
    let len = b.checked_sub(a)?.checked_add(1)?;
    (len <= MAX_OBJECT_BYTES).then_some((a, len))
}

/// Constant-time equality.
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Verify a direct-transfer URL: `/v1/o/<collection>/<address>?op=&size=&ck=&exp=&sig=`.
pub fn verify_direct(
    secret: &[u8],
    collection: &str,
    address: &str,
    query: &str,
    now: i64,
) -> Result<DirectOp> {
    let forbidden = || ServiceError::reason(Code::Forbidden, "url");
    let q: BTreeMap<&str, &str> = query
        .split('&')
        .filter_map(|kv| kv.split_once('='))
        .collect();
    let c = parse_uuid(collection).ok_or_else(forbidden)?;
    let a = B32(unhex(address)
        .and_then(|v| v.try_into().ok())
        .ok_or_else(forbidden)?);
    let op = *q.get("op").ok_or_else(forbidden)?;
    let size: u64 = q
        .get("size")
        .and_then(|s| s.parse().ok())
        .ok_or_else(forbidden)?;
    let ck = B32(q
        .get("ck")
        .and_then(|s| unhex(s))
        .and_then(|v| v.try_into().ok())
        .ok_or_else(forbidden)?);
    let exp: i64 = q
        .get("exp")
        .and_then(|s| s.parse().ok())
        .ok_or_else(forbidden)?;
    let dev = q.get("dev").copied().unwrap_or("");
    let sig = q.get("sig").and_then(|s| unhex(s)).ok_or_else(forbidden)?;
    let want = direct_mac(secret, op, &c, &a, dev, size, &ck, exp);
    if exp < now || !ct_eq(&want, &sig) {
        return Err(forbidden());
    }
    let device = match op {
        "put" => Some(B16(unhex(dev)
            .and_then(|v| v.try_into().ok())
            .ok_or_else(forbidden)?)),
        "get" => None,
        _ => return Err(forbidden()),
    };
    Ok(DirectOp {
        put: op == "put",
        collection: c,
        address: a,
        sealed_size: size,
        sealed_checksum: ck,
        expires_ms: exp,
        expect: (op == "put").then_some((size, ck)),
        device,
    })
}

/// Verify uploaded object bytes (§6 "Validation"): a `mdb-cbor/1`
/// envelope of this collection, of an object kind, at most 9 MiB, and for
/// manifests and chunks `address = SHA-256(bytes)`. Used by the actor, and by
/// upload hosts that verify as bytes arrive (the Worker in front of R2).
pub fn verify_upload(c: &Uuid, address: &B32, bytes: &[u8]) -> Result<Verified> {
    verify_upload_with_budget(c, address, bytes, &Budget::default())
}

/// Verify an upload with the enclosing request's shared decode budget.
pub fn verify_upload_with_budget(
    c: &Uuid,
    address: &B32,
    bytes: &[u8],
    budget: &Budget,
) -> Result<Verified> {
    if bytes.len() as u64 > MAX_OBJECT_BYTES {
        return Err(ServiceError::reason(Code::TooLarge, "object"));
    }
    let it = budget.wire::<Item>(bytes)?;
    let kind = it.kind.value();
    if !matches!(kind, 16..=19) {
        return Err(ServiceError::invalid("kind"));
    }
    let checksum = sha256(bytes);
    validate_object_bytes(
        c,
        address,
        kind,
        bytes.len() as u64,
        &checksum,
        bytes,
        budget,
    )?;
    Ok(Verified {
        kind,
        size: bytes.len() as u64,
        checksum,
    })
}

fn validate_object_bytes(
    c: &Uuid,
    address: &B32,
    kind: u64,
    size: u64,
    checksum: &B32,
    bytes: &[u8],
    budget: &Budget,
) -> Result<()> {
    if bytes.len() as u64 != size {
        return Err(ServiceError::invalid("size"));
    }
    if sha256(bytes) != *checksum {
        return Err(ServiceError::invalid("checksum"));
    }
    let it = budget.wire::<Item>(bytes)?;
    it.check_shape()
        .map_err(|e| ServiceError::invalid("shape").msg(format!("object: {e}")))?;
    if it.collection != *c || it.kind.value() != kind {
        return Err(ServiceError::invalid("shape").msg("object collection or kind"));
    }
    if kind != ItemKind::BlobPart.value() && checksum != address {
        return Err(ServiceError::invalid("address"));
    }
    if kind == ItemKind::RefIndex.value() {
        ref_index_body(&it, budget)?;
    }
    Ok(())
}

/// The addresses a decoded ref-index item lists, charging its payload to the
/// request's decode budget (`sealed-envelope.md` §4.3).
fn ref_index_body(it: &Item, budget: &Budget) -> Result<Vec<B32>> {
    budget
        .preflight(&it.body.0)
        .map_err(|e| ServiceError::invalid(e.reason))?;
    ref_index_addresses(it).map_err(|e| ServiceError::invalid("ref_index").msg(e.to_string()))
}

/// The members of the stored ref-index object at `a`. Its bytes were verified
/// at upload; a mismatch now is an integrity incident and refuses the caller.
fn stored_ref_index(c: &Uuid, a: &B32, bytes: &[u8], budget: &Budget) -> Result<Vec<B32>> {
    if sha256(bytes) != *a {
        return Err(ServiceError::backend(
            "ref-index bytes differ from their address: integrity incident",
        ));
    }
    let it = budget.wire::<Item>(bytes)?;
    if it.collection != *c {
        return Err(ServiceError::invalid("ref_index").msg("collection"));
    }
    ref_index_body(&it, budget)
}

fn is_ref_index(m: &ObjectMeta) -> bool {
    m.kind == ItemKind::RefIndex.value()
}

fn check_verified(address: &B32, v: &Verified) -> Result<()> {
    if !matches!(v.kind, 16..=19) || v.size > MAX_OBJECT_BYTES {
        return Err(ServiceError::invalid("kind"));
    }
    if v.kind != ItemKind::BlobPart.value() && v.checksum != *address {
        return Err(ServiceError::invalid("address"));
    }
    Ok(())
}

/// The transport state a failover that lost a tail leaves behind: rebuilt from
/// the surviving control items, keeping the collection's quotas and retention.
/// Failure-injection hooks use it so that a simulated lost tail also loses the
/// ACL, epoch and freeze effects of the lost items, as a lagging standby would.
pub fn rebuild_state(
    old: &CollectionMeta,
    control: &[(u64, Vec<u8>)],
    roots: &[B32],
) -> Result<CollectionState> {
    let mut st = CollectionState {
        meta: CollectionMeta::new(old.id, old.created_at),
        acl: BTreeMap::new(),
    };
    st.meta.quotas = old.quotas;
    st.meta.retained_from = old.retained_from;
    st.meta.used_bytes = old.used_bytes;
    st.meta.status = old.status;
    let budget = Budget::default();
    for (seq, b) in control {
        let it = budget.wire::<Item>(b)?;
        check_item(&mut st, &it, *seq, 0, roots, &budget)?;
    }
    Ok(st)
}

/// Refuse requests on a deleted (`gone`) or restoring (`unavailable`) collection.
fn live(m: &CollectionMeta) -> Result<()> {
    match m.status {
        Status::Live => Ok(()),
        Status::Gone => Err(ServiceError::new(Code::Gone)),
        Status::Importing => Err(ServiceError::new(Code::Unavailable)
            .msg("collection is being restored")
            .retry(5_000)),
    }
}

/// Steps 7–8 for one log item at `seq`, judged by policy at `seq − 1` (`ws`), which
/// it then advances. Returns the devices a policy item revoked.
fn check_item(
    ws: &mut CollectionState,
    it: &Item,
    seq: u64,
    i: usize,
    roots: &[B32],
    budget: &Budget,
) -> Result<Vec<Uuid>> {
    if it.kind == ItemKind::Policy {
        return apply_policy_with_budget(ws, it, seq, roots, budget);
    }
    let signer = it.signer.unwrap();
    let e = ws
        .acl
        .get(&signer)
        .filter(|e| e.active)
        .cloned()
        .ok_or_else(|| ServiceError::reason(Code::Forbidden, "revoked"))?;
    let digest = it
        .signed_digest()
        .map_err(|_| ServiceError::invalid("shape"))?;
    if !verify_sig(&e.sign_pk.0, &digest.0, &it.sig.unwrap().0) {
        return Err(ServiceError::invalid("signature").msg(format!("item {i}")));
    }
    // Escrow devices sign only key items, whoever uploads them.
    if e.kind == device_kind::ESCROW && !matches!(it.kind, ItemKind::Rekey | ItemKind::KeyGrant) {
        return Err(ServiceError::reason(Code::Forbidden, "kind"));
    }
    let role = ws.meta.members.get(&e.account).copied();
    let writer = role.is_some_and(|r| r >= 1);
    match it.kind {
        ItemKind::Entry | ItemKind::Base => {
            let hosted_ok = e.kind == device_kind::HOSTED && ws.meta.cstate == 1;
            if !(writer || hosted_ok) {
                return Err(ServiceError::reason(Code::Forbidden, "role"));
            }
            if ws.meta.frozen {
                return Err(ServiceError::reason(Code::Frozen, "frozen"));
            }
            if ws.meta.rekey_required {
                return Err(ServiceError::reason(Code::Frozen, "rekey_required"));
            }
            if it.epoch != Some(ws.meta.epoch) {
                return Err(ServiceError::invalid("epoch").msg(format!("item {i}")));
            }
        }
        ItemKind::Rekey => apply_rekey_with_budget(ws, it, budget)?,
        ItemKind::KeyGrant => {
            // policy.md §6.2: hosted delivers approved account-device keys in
            // cloud-copy; escrow retains its unavailable-hosted fallback.
            let cloud_service =
                matches!(e.kind, device_kind::HOSTED | device_kind::ESCROW) && ws.meta.cstate == 1;
            let ordinary = writer || cloud_service;
            // A viewer's recovery key may unlock its own newly enrolled user
            // device. Eligibility is not sufficient: check the parsed recipient
            // below. All other signer/item role requirements remain unchanged.
            let recovery_member = e.kind == device_kind::RECOVERY && role.is_some();
            if !(ordinary || recovery_member) {
                return Err(ServiceError::reason(Code::Forbidden, "role"));
            }
            // A grant during rekey-required would key a device under an
            // epoch a revoked device holds.
            if ws.meta.rekey_required {
                return Err(ServiceError::reason(Code::Frozen, "rekey_required"));
            }
            let g = budget.wire::<KeyGrantPayload>(&it.body.0)?;
            if g.epoch != ws.meta.epoch {
                return Err(ServiceError::invalid("epoch").msg(format!("item {i}")));
            }
            if !ordinary {
                let self_user = ws.acl.get(&g.recipient).is_some_and(|recipient| {
                    recipient.active
                        && recipient.account == e.account
                        && recipient.kind <= 3
                        && g.wrap.device == recipient.device
                });
                if !self_user {
                    return Err(ServiceError::reason(Code::Forbidden, "role"));
                }
            }
        }
        ItemKind::GrantApproval => {
            // policy.md §5.1: sealed, device-signed. The service sees only the
            // envelope: an active member device, current epoch, not
            // rekey-required (V2). Replicas check the payload.
            if role.is_none() || e.kind == device_kind::ESCROW || e.kind == device_kind::HOSTED {
                return Err(ServiceError::reason(Code::Forbidden, "role"));
            }
            if ws.meta.rekey_required {
                return Err(ServiceError::reason(Code::Frozen, "rekey_required"));
            }
            if it.epoch != Some(ws.meta.epoch) {
                return Err(ServiceError::invalid("epoch").msg(format!("item {i}")));
            }
        }
        _ => unreachable!("log kinds checked above"),
    }
    Ok(Vec::new())
}

/// Archive segment format 1: canonical CBOR `{0: 1, 1: collection, 2: from, 3: to,
/// 4: chain(to), 5: [[seq, item bytes], …]}` over the `entry` items `seg`, in
/// order. `chain(to)` is the chain hash of the item at `to`, so a segment can be
/// checked against the log's chain (and against the next segment's first item).
pub fn encode_segment(c: &Uuid, seg: &[StoredItem]) -> Vec<u8> {
    let u = Cbor::Uint;
    let last = seg.last().expect("non-empty segment");
    let m = vec![
        (u(0), u(1)),
        (u(1), Cbor::Bytes(c.0.to_vec())),
        (u(2), u(seg[0].seq)),
        (u(3), u(last.seq)),
        (u(4), Cbor::Bytes(chain_hash(&last.bytes).0.to_vec())),
        (
            u(5),
            Cbor::Array(
                seg.iter()
                    .map(|i| Cbor::Array(vec![u(i.seq), Cbor::Bytes(i.bytes.clone())]))
                    .collect(),
            ),
        ),
    ];
    cbor::encode(&Cbor::Map(m)).expect("segment encodes")
}

impl<B: Backend, O: ObjectStore> Service<B, O> {
    /// A service.
    pub fn new(backend: B, objects: O, config: Config) -> Self {
        Service {
            backend: Arc::new(backend),
            objects: Arc::new(objects),
            config,
            buckets: Arc::new(Mutex::new(BTreeMap::new())),
            creds: Arc::new(Mutex::new(BTreeMap::new())),
        }
    }

    /// A request view sharing backend/store/cache handles, never their counters.
    /// Projection decoders invoked by nested backend calls use this same budget.
    pub(crate) fn scoped(&self, budget: &Budget) -> Service<BudgetBackend<B>, O> {
        Service {
            backend: Arc::new(BudgetBackend {
                inner: self.backend.clone(),
                budget: budget.clone(),
            }),
            objects: self.objects.clone(),
            config: self.config.clone(),
            buckets: self.buckets.clone(),
            creds: self.creds.clone(),
        }
    }

    fn direct(
        &self,
        uploader: Option<&Uuid>,
        c: &Uuid,
        a: &B32,
        size: u64,
        ck: &B32,
        now: i64,
    ) -> DirectTransfer {
        let exp = now + DIRECT_TTL_MS;
        let put = uploader.is_some();
        let op = if put { "put" } else { "get" };
        let dev = uploader.map(|d| d.to_hex()).unwrap_or_default();
        let sig = direct_mac(&self.config.url_secret, op, c, a, &dev, size, ck, exp);
        let url = format!(
            "{}/v1/o/{}/{}?op={op}&dev={dev}&size={size}&ck={}&exp={exp}&sig={}",
            self.config.public_base.trim_end_matches('/'),
            c.to_uuid_string(),
            a.to_hex(),
            ck.to_hex(),
            mdbn_wire::render::hex(&sig)
        );
        let headers = if put {
            vec![("x-amz-checksum-sha256".to_string(), base64(&ck.0))]
        } else {
            vec![]
        };
        DirectTransfer {
            url,
            headers: DataMap(headers),
            expires_at: exp,
        }
    }

    /// Dispatch a durable method by name. Connection-level methods (`hello`,
    /// `subscribe`, streams) are handled by [`crate::session`].
    pub async fn call(
        &self,
        principal: &Principal,
        method: &str,
        params: &Cbor,
        now: i64,
    ) -> Result<Outcome> {
        self.call_with_budget(principal, method, params, now, &Budget::default())
            .await
    }

    /// Dispatch with the budget used for frame and token decoding.
    pub async fn call_with_budget(
        &self,
        principal: &Principal,
        method: &str,
        params: &Cbor,
        now: i64,
        budget: &Budget,
    ) -> Result<Outcome> {
        self.scoped(budget)
            .dispatch_with_budget(principal, method, params, now, budget)
            .await
    }

    async fn dispatch_with_budget(
        &self,
        principal: &Principal,
        method: &str,
        params: &Cbor,
        now: i64,
        budget: &Budget,
    ) -> Result<Outcome> {
        macro_rules! p {
            ($t:ty) => {
                <$t>::from_cbor(params).map_err(bad_params)?
            };
        }
        self.check_credentials(principal, now, false).await?;
        match method {
            "revoke_device_credentials" => {
                self.revoke_device_credentials(principal, params, now).await
            }
            "append" => {
                self.append_with_budget(principal, p!(AppendParams), now, budget)
                    .await
            }
            "read" => Ok(Outcome::plain(
                self.read(principal, p!(ReadParams), now).await?.to_cbor(),
            )),
            "head" => Ok(Outcome::plain(
                self.head(principal, &p!(HeadParams).collection)
                    .await?
                    .to_cbor(),
            )),
            "put_object" => Ok(Outcome::plain(
                self.put_object_with_budget(principal, p!(PutObjectParams), now, budget)
                    .await?
                    .to_cbor(),
            )),
            "commit_object" => {
                let ok = self
                    .commit_object_with_budget(principal, p!(CommitObjectParams), now, budget)
                    .await?;
                Ok(Outcome::plain(map(vec![(0, Cbor::Bool(ok))])))
            }
            "get_object" => Ok(Outcome::plain(
                self.get_object(principal, p!(GetObjectParams), now)
                    .await?
                    .to_cbor(),
            )),
            "has_objects" => Ok(Outcome::plain(
                self.has_objects(principal, p!(HasObjectsParams))
                    .await?
                    .to_cbor(),
            )),
            "put_snapshot" => {
                let ok = self
                    .put_snapshot_with_budget(principal, p!(PutSnapshotParams), now, budget)
                    .await?;
                Ok(Outcome::plain(map(vec![(0, Cbor::Bool(ok))])))
            }
            "get_snapshot" => {
                let c = uuid_field(params, 0)?;
                Ok(Outcome::plain(
                    self.get_snapshot(principal, &c).await?.to_cbor(),
                ))
            }
            "endorse_snapshot" => {
                let ok = self
                    .endorse_snapshot(principal, p!(EndorseSnapshotParams), now)
                    .await?;
                Ok(Outcome::plain(map(vec![(0, Cbor::Bool(ok))])))
            }
            // §12 administrative API (control plane only).
            "create_log" => self.create_log(principal, params, now, budget).await,
            "set_quota" => self.set_quota(principal, params).await,
            "delete_log" => self.delete_log(principal, params).await,
            "log_terminal_status" => self.log_terminal_status(principal, params).await,
            "export" => self.export(principal, params).await,
            "export_objects" => self.export_objects(principal, params).await,
            "import" => self.import(principal, params, now, budget).await,
            "import_object" => self.import_object(principal, params, now, budget).await,
            "import_snapshot" => self.import_snapshot(principal, params).await,
            // Background maintenance, exposed for hosts' schedulers and tests.
            "compact" => {
                let c = uuid_field(params, 0)?;
                self.require_cp(principal)?;
                let r = self.compact(&c, now).await?;
                Ok(Outcome::plain(map(vec![(0, Cbor::Uint(r))])))
            }
            "gc" => {
                let c = uuid_field(params, 0)?;
                self.require_cp(principal)?;
                let n = self.gc(&c, now).await?;
                Ok(Outcome::plain(map(vec![(0, Cbor::Uint(n))])))
            }
            _ => Err(ServiceError::invalid("method").msg(format!("unknown method {method}"))),
        }
    }

    /// §12 `revoke_device_credentials`: refuse a device on every collection at the
    /// transport, ahead of the policy items. `fresh` skips the cache (at `hello`).
    pub async fn check_credentials(&self, p: &Principal, now: i64, fresh: bool) -> Result<()> {
        let Principal::Device { id, .. } = p else {
            return Ok(());
        };
        let cached = self.creds.lock().unwrap().get(id).copied();
        let revoked = match cached {
            Some((true, _)) => true,
            Some((false, at)) if !fresh && now - at < CREDENTIAL_RECHECK_MS => false,
            _ => {
                let r = self.backend.credentials_revoked(id).await?;
                self.creds.lock().unwrap().insert(*id, (r, now));
                r
            }
        };
        if revoked {
            return Err(ServiceError::reason(Code::Forbidden, "credentials_revoked"));
        }
        Ok(())
    }

    /// `revoke_device_credentials {0: device}` (control plane only).
    async fn revoke_device_credentials(
        &self,
        p: &Principal,
        params: &Cbor,
        now: i64,
    ) -> Result<Outcome> {
        self.require_cp(p)?;
        let d = uuid_field(params, 0)?;
        self.backend.revoke_credentials(&d, now).await?;
        self.creds.lock().unwrap().insert(d, (true, now));
        Ok(Outcome {
            credentials_revoked: Some(d),
            ..Outcome::plain(map(vec![(0, Cbor::Bool(true))]))
        })
    }

    fn require_cp(&self, p: &Principal) -> Result<()> {
        match p {
            Principal::ControlPlane => Ok(()),
            _ => Err(ServiceError::reason(Code::Forbidden, "principal")),
        }
    }

    /// Step 1–2: authorize a principal on a loaded collection. Devices must be active
    /// in the ACL with the key their token is bound to.
    pub fn authorize<'s>(
        state: &'s CollectionState,
        p: &Principal,
    ) -> Result<Option<&'s AclEntry>> {
        match p {
            Principal::ControlPlane => Ok(None),
            Principal::Device {
                collection: Some(c),
                ..
            } if *c != state.meta.id => {
                Err(ServiceError::reason(Code::Forbidden, "token_collection"))
            }
            Principal::Device { id, sign_pk, .. } => match state.acl.get(id) {
                Some(e) if e.active && e.sign_pk == *sign_pk => Ok(Some(e)),
                Some(e) if !e.active => Err(ServiceError::reason(Code::Forbidden, "revoked")),
                _ => Err(ServiceError::reason(Code::Forbidden, "not_enrolled")),
            },
        }
    }

    async fn load<T: Txn>(tx: &mut T) -> Result<CollectionState> {
        tx.load()
            .await?
            .ok_or_else(|| ServiceError::new(Code::NotFound))
    }

    /// Check that a device may use a collection (stream joins, subscriptions).
    pub async fn authorize_device(&self, p: &Principal, c: &Uuid) -> Result<Option<Uuid>> {
        let mut tx = self.backend.begin(c, Mode::Read).await?;
        let state = Self::load(&mut tx).await?;
        live(&state.meta)?;
        Ok(Self::authorize(&state, p)?.map(|e| e.device))
    }

    fn rate_check(&self, c: &Uuid, q: &Quotas, items: u64, bytes: u64, now: i64) -> Result<()> {
        let mut b = self.buckets.lock().unwrap();
        let cap_items = q.burst_items.saturating_mul(1000);
        let cap_bytes = q.bytes_per_s.saturating_mul(4);
        let e = b.entry(*c).or_insert(Bucket {
            items_milli: cap_items,
            bytes: cap_bytes,
            at: now,
        });
        let dt = (now - e.at).clamp(0, 3_600_000) as u64;
        e.items_milli = e
            .items_milli
            .saturating_add(dt.saturating_mul(q.items_per_s))
            .min(cap_items);
        e.bytes = e
            .bytes
            .saturating_add(dt.saturating_mul(q.bytes_per_s) / 1000)
            .min(cap_bytes);
        e.at = now;
        let need_i = items * 1000;
        if e.items_milli < need_i || e.bytes < bytes {
            let wait_i = (need_i.saturating_sub(e.items_milli)) / q.items_per_s.max(1);
            let wait_b = bytes.saturating_sub(e.bytes).saturating_mul(1000) / q.bytes_per_s.max(1);
            return Err(ServiceError::new(Code::RateLimited).retry(wait_i.max(wait_b).max(1)));
        }
        e.items_milli -= need_i;
        e.bytes -= bytes;
        Ok(())
    }

    /// Repair appends are limited per uploader:
    /// [`REPAIR_ITEMS_PER_S`] sustained, [`REPAIR_BURST_ITEMS`] burst.
    fn repair_rate_check(&self, uploader: &Uuid, items: u64, now: i64) -> Result<()> {
        let q = Quotas {
            storage_bytes: 0,
            items_per_s: REPAIR_ITEMS_PER_S,
            bytes_per_s: u64::MAX / 8,
            burst_items: REPAIR_BURST_ITEMS,
        };
        // Keyed apart from collections: a device ID never equals a collection ID's
        // bucket because it is mixed with a constant.
        let mut key = uploader.0;
        key[0] ^= 0xa5;
        self.rate_check(&B16(key), &q, items, 0, now)
            .map_err(|e| ServiceError {
                reason: Some("repair".into()),
                ..e
            })
    }

    // ------------------------------------------------------------------ append (§4)

    /// Conditional append (§4.1).
    pub async fn append(&self, p: &Principal, params: AppendParams, now: i64) -> Result<Outcome> {
        let budget = Budget::default();
        self.scoped(&budget)
            .append_with_budget(p, params, now, &budget)
            .await
    }

    /// Append with one budget shared across every item and nested payload.
    pub async fn append_with_budget(
        &self,
        p: &Principal,
        params: AppendParams,
        now: i64,
        budget: &Budget,
    ) -> Result<Outcome> {
        let c = params.collection;
        let n = params.items.len();
        // Step 3 (cheap part, before taking the actor): counts and sizes.
        if n == 0 {
            return Err(ServiceError::invalid("shape").msg("empty batch"));
        }
        if n > MAX_BATCH_ITEMS {
            return Err(ServiceError::reason(Code::TooLarge, "batch_items"));
        }
        // Positions are ≥ 1 and the batch's last position must not overflow.
        if params.expect_seq == 0 || params.expect_seq.checked_add(n as u64).is_none() {
            return Err(ServiceError::invalid("shape").msg("expect_seq"));
        }
        let total: u64 = params.items.iter().map(|b| b.0.len() as u64).sum();
        if total > MAX_BATCH_BYTES {
            return Err(ServiceError::reason(Code::TooLarge, "batch_bytes"));
        }
        let mut repair_items = 0u64;
        let mut items = Vec::with_capacity(n);
        for (i, b) in params.items.iter().enumerate() {
            if b.0.len() as u64 > MAX_ITEM_BYTES {
                return Err(ServiceError::reason(Code::TooLarge, "item_bytes"));
            }
            let it = budget.wire::<Item>(&b.0)?;
            it.check_shape()
                .map_err(|e| ServiceError::invalid("shape").msg(format!("item {i}: {e}")))?;
            if it.collection != c || !it.kind.is_log_item() {
                return Err(
                    ServiceError::invalid("shape").msg(format!("item {i}: collection or kind"))
                );
            }
            if it.seq != Some(params.expect_seq + i as u64) {
                return Err(ServiceError::invalid("shape").msg(format!("item {i}: seq")));
            }
            if it
                .refs
                .as_ref()
                .is_some_and(|r| r.len() > MAX_REFS_PER_ITEM)
            {
                return Err(ServiceError::reason(Code::TooLarge, "refs"));
            }
            // Kinds per principal (§3). A device may also upload items signed by
            // another principal (a repair append): it can only restore a lost
            // item, because seq and prev are signed and the head must match.
            // Authorization is then the signer's, checked at the item's position
            // (check_item); the uploader only needs to be an active device.
            match p {
                Principal::ControlPlane => {
                    if it.kind != ItemKind::Policy {
                        return Err(ServiceError::reason(Code::Forbidden, "kind"));
                    }
                }
                Principal::Device { id, .. } => {
                    if it.signer != Some(*id) {
                        repair_items += 1;
                    }
                }
            }
            items.push(it);
        }
        let content = items
            .iter()
            .any(|i| matches!(i.kind, ItemKind::Entry | ItemKind::Base));

        let mut tx = self.backend.begin(&c, Mode::Write).await?;
        // Steps 1–2.
        let state = Self::load(&mut tx).await?;
        Self::authorize(&state, p)?;
        live(&state.meta)?;
        if content && state.meta.used_bytes + total > state.meta.quotas.storage_bytes {
            return Err(ServiceError::new(Code::QuotaExceeded));
        }

        // Step 4: idempotent replay (I4).
        let head = state.meta.head;
        if params.expect_seq <= head {
            let stored = tx
                .items(params.expect_seq - 1, n as u64, u64::MAX, false)
                .await?;
            let same = stored.len() == n
                && stored
                    .iter()
                    .zip(&params.items)
                    .all(|(s, b)| s.seq >= params.expect_seq && s.bytes == b.0);
            if same {
                let last = stored.last().unwrap();
                return Ok(Outcome::plain(
                    AppendResult::Appended(Appended {
                        first: params.expect_seq,
                        last: last.seq,
                        head_chain: chain_hash(&last.bytes),
                        appended_at: last.appended_at,
                    })
                    .to_cbor(),
                ));
            }
        }
        // Step 5: head check (I2).
        if params.expect_seq != head + 1 || params.expect_prev != state.meta.head_chain {
            return Ok(Outcome::plain(
                AppendResult::HeadMoved(HeadMoved {
                    head,
                    head_chain: state.meta.head_chain,
                })
                .to_cbor(),
            ));
        }
        // Rate limit (§11), after replay so that a retry is never throttled.
        if let Principal::Device { id, .. } = p {
            self.rate_check(&c, &state.meta.quotas, n as u64, total, now)?;
            if repair_items > 0 {
                self.repair_rate_check(id, repair_items, now)?;
            }
        }
        // Step 6: chain within the batch.
        let mut prev = params.expect_prev;
        for (i, (it, b)) in items.iter().zip(&params.items).enumerate() {
            if it.prev != Some(prev) {
                return Err(ServiceError::invalid("chain").msg(format!("item {i}")));
            }
            prev = chain_hash(&b.0);
        }
        // Steps 7–8: signatures and the policy gate, item by item on a working copy,
        // so that each item is judged by policy at the position before it.
        let mut ws = state.clone();
        let mut revoked = Vec::new();
        for (i, it) in items.iter().enumerate() {
            let seq = params.expect_seq + i as u64;
            revoked.extend(check_item(&mut ws, it, seq, i, &self.config.roots, budget)?);
        }
        // Step 9: idempotency tokens (I5).
        let mut tokens = Vec::new();
        let mut token_idx = Vec::new();
        let mut seen = BTreeSet::new();
        for (i, it) in items.iter().enumerate() {
            if let Some(t) = it.idem {
                if !seen.insert(t) {
                    return Err(
                        ServiceError::invalid("shape").msg("token repeated within the batch")
                    );
                }
                tokens.push(t);
                token_idx.push(i);
            }
        }
        if !tokens.is_empty() {
            let found = tx.tokens(&tokens, now).await?;
            if let Some((k, seq)) = found
                .iter()
                .enumerate()
                .find_map(|(k, s)| s.map(|s| (k, s)))
            {
                return Ok(Outcome::plain(
                    AppendResult::Duplicate(Duplicate {
                        index: token_idx[k] as u64,
                        seq,
                    })
                    .to_cbor(),
                ));
            }
        }
        // Step 10: refs.
        let refs: Vec<B32> = items
            .iter()
            .flat_map(|i| i.refs.iter().flatten().copied())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        if !refs.is_empty() {
            let metas = tx.objects(&refs).await?;
            if metas.iter().flatten().any(is_ref_index) {
                return Err(ServiceError::invalid("kind").msg("ref-index outside a snapshot"));
            }
            let missing: Vec<Cbor> = refs
                .iter()
                .zip(metas)
                .filter(|(_, m)| !m.as_ref().is_some_and(|m| m.committed))
                .map(|(a, _)| Cbor::Bytes(a.0.to_vec()))
                .collect();
            if !missing.is_empty() {
                let mut e = ServiceError::new(Code::RefsMissing);
                e.details = Some(Cbor::Array(missing));
                return Err(e);
            }
        }
        // Step 11: commit atomically.
        let mut pushed = Vec::with_capacity(n);
        for (i, (it, b)) in items.iter().zip(&params.items).enumerate() {
            let seq = params.expect_seq + i as u64;
            tx.write(Write::InsertItem(StoredItem {
                seq,
                kind: it.kind.value(),
                bytes: b.0.clone(),
                appended_at: now,
                token: it.idem,
                refs: it.refs.clone().unwrap_or_default(),
            }));
            pushed.push((seq, b.0.clone()));
        }
        ws.meta.head = params.expect_seq + n as u64 - 1;
        ws.meta.head_chain = prev;
        ws.meta.used_bytes += total;
        for (d, e) in &ws.acl {
            if state.acl.get(d) != Some(e) {
                tx.write(Write::UpsertAcl(e.clone()));
            }
        }
        tx.write(Write::PutMeta(ws.meta.clone()));
        let notice = CommitNotice {
            collection: c,
            first: params.expect_seq,
            head: ws.meta.head,
            head_chain: prev,
            revoked,
            gone: false,
        };
        tx.write(Write::Notify(notice.clone()));
        tx.commit().await?;
        Ok(Outcome {
            result: AppendResult::Appended(Appended {
                first: params.expect_seq,
                last: ws.meta.head,
                head_chain: prev,
                appended_at: now,
            })
            .to_cbor(),
            notice: Some(notice),
            items: pushed,
            credentials_revoked: None,
            repair: match p {
                Principal::Device { id, .. } if repair_items > 0 => Some(RepairAppend {
                    collection: c,
                    uploader: *id,
                    first: params.expect_seq,
                    last: ws.meta.head,
                    foreign_items: repair_items,
                }),
                _ => None,
            },
        })
    }

    // ------------------------------------------------------------------ read (§5)

    fn pointer(s: &SnapshotRow) -> SnapshotPointer {
        SnapshotPointer {
            seq: s.seq,
            manifest: s.manifest,
            author: s.author,
            created_at: s.created_at,
            endorsed: s.endorsed,
        }
    }

    /// Read a range.
    pub async fn read(&self, p: &Principal, params: ReadParams, _now: i64) -> Result<ReadResult> {
        let max_bytes = params
            .max_bytes
            .unwrap_or(MAX_READ_BYTES)
            .min(MAX_READ_BYTES);
        if max_bytes == 0 {
            return Err(ServiceError::invalid("max_bytes"));
        }
        let mut tx = self.backend.begin(&params.collection, Mode::Read).await?;
        let state = Self::load(&mut tx).await?;
        Self::authorize(&state, p)?;
        live(&state.meta)?;
        let m = &state.meta;
        let control = params.kinds == Some(ReadKinds::Control);
        let behind = !control && params.after.saturating_add(1) < m.retained_from;
        let limit = params.limit.min(MAX_READ_ITEMS);
        let items = if behind || limit == 0 || params.after >= m.head {
            Vec::new()
        } else {
            tx.items(params.after, limit, max_bytes, control).await?
        };
        let last = items.last().map_or(params.after, |i| i.seq);
        let more = if control {
            // Pages end at the item limit or near the byte cap; an exact answer
            // would need another query, and a spurious `more` costs one empty read.
            let total: u64 = items.iter().map(|i| i.bytes.len() as u64).sum();
            last < m.head
                && (items.len() as u64 == limit || total > max_bytes.saturating_sub(MAX_ITEM_BYTES))
        } else {
            last < m.head
        };
        let snapshot = if behind || control || params.after == 0 {
            tx.snapshots().await?.first().map(Self::pointer)
        } else {
            None
        };
        Ok(ReadResult {
            items: items
                .into_iter()
                .map(|i| SeqItem {
                    seq: i.seq,
                    item: Bytes(i.bytes),
                })
                .collect(),
            head: m.head,
            head_chain: m.head_chain,
            retained_from: m.retained_from,
            behind,
            snapshot,
            more,
        })
    }

    /// The head.
    pub async fn head(&self, p: &Principal, c: &Uuid) -> Result<HeadResult> {
        let mut tx = self.backend.begin(c, Mode::Read).await?;
        let state = Self::load(&mut tx).await?;
        Self::authorize(&state, p)?;
        live(&state.meta)?;
        let snapshot = tx.snapshots().await?.first().map(Self::pointer);
        Ok(HeadResult {
            head: state.meta.head,
            head_chain: state.meta.head_chain,
            retained_from: state.meta.retained_from,
            snapshot,
        })
    }

    // ------------------------------------------------------------------ objects (§6)

    /// Validate object bytes (§6 "Validation").
    pub fn validate_object(
        c: &Uuid,
        address: &B32,
        kind: u64,
        size: u64,
        checksum: &B32,
        bytes: &[u8],
    ) -> Result<()> {
        validate_object_bytes(c, address, kind, size, checksum, bytes, &Budget::default())
    }

    async fn active_device(&self, p: &Principal, c: &Uuid) -> Result<CollectionState> {
        let mut tx = self.backend.begin(c, Mode::Read).await?;
        let state = Self::load(&mut tx).await?;
        if matches!(p, Principal::ControlPlane) {
            return Err(ServiceError::reason(Code::Forbidden, "principal"));
        }
        Self::authorize(&state, p)?;
        live(&state.meta)?;
        Ok(state)
    }

    // A dedup response is a publication decision too. Keep the current Gone
    // check and committed lookup under the same exclusive collection boundary.
    async fn object_committed_current(&self, c: &Uuid, address: &B32) -> Result<bool> {
        self.refuse_deleted_floor(c).await?;
        let mut tx = self.backend.begin(c, Mode::Write).await?;
        let state = Self::load(&mut tx).await?;
        if state.meta.status == Status::Gone {
            return Err(ServiceError::new(Code::Gone));
        }
        let committed = tx
            .objects(&[*address])
            .await?
            .pop()
            .flatten()
            .is_some_and(|m| m.committed);
        self.refuse_deleted_floor(c).await?;
        Ok(committed)
    }

    async fn record_object(&self, c: &Uuid, meta: ObjectMeta) -> Result<()> {
        self.refuse_deleted_floor(c).await?;
        let mut tx = self.backend.begin(c, Mode::Write).await?;
        let mut state = Self::load(&mut tx).await?;
        // Terminal deletion dominates dedup and quota. Importing remains valid
        // for the existing CP-only verified restore path; live() would reject it.
        if state.meta.status == Status::Gone {
            return Err(ServiceError::new(Code::Gone));
        }
        let existing = tx.objects(&[meta.address]).await?.pop().flatten();
        self.refuse_deleted_floor(c).await?;
        if existing.as_ref().is_some_and(|e| e.committed) {
            return Ok(()); // first committed object wins (I8)
        }
        if meta.committed {
            // The early PUT check is advisory: uploads may race or the quota
            // may change while their bytes are staged. This exclusive WriteTX
            // owns the final quota check, accounting and object insertion.
            let used_bytes = state
                .meta
                .used_bytes
                .checked_add(meta.size)
                .filter(|used| {
                    let limit = state
                        .meta
                        .restore_plan
                        .as_ref()
                        .filter(|_| state.meta.status == Status::Importing)
                        .map_or(state.meta.quotas.storage_bytes, |plan| plan.used_bytes);
                    *used <= limit
                })
                .ok_or_else(|| ServiceError::new(Code::QuotaExceeded))?;
            state.meta.used_bytes = used_bytes;
            tx.write(Write::PutMeta(state.meta));
        }
        tx.write(Write::PutObject(meta));
        self.refuse_deleted_floor(c).await?;
        tx.commit().await
    }

    /// `put_object`.
    pub async fn put_object(
        &self,
        p: &Principal,
        q: PutObjectParams,
        now: i64,
    ) -> Result<PutObjectResult> {
        let budget = Budget::default();
        self.scoped(&budget)
            .put_object_with_budget(p, q, now, &budget)
            .await
    }

    /// Put an object within the enclosing request's budget.
    pub async fn put_object_with_budget(
        &self,
        p: &Principal,
        q: PutObjectParams,
        now: i64,
        budget: &Budget,
    ) -> Result<PutObjectResult> {
        let c = q.collection;
        let kind = q.kind.value();
        if !matches!(
            q.kind,
            ItemKind::Manifest | ItemKind::Chunk | ItemKind::BlobPart | ItemKind::RefIndex
        ) {
            return Err(ServiceError::invalid("kind"));
        }
        if q.size > MAX_OBJECT_BYTES {
            return Err(ServiceError::reason(Code::TooLarge, "object"));
        }
        if q.bytes
            .as_ref()
            .is_some_and(|b| b.0.len() as u64 > MAX_INLINE_OBJECT_BYTES)
        {
            return Err(ServiceError::reason(Code::TooLarge, "inline"));
        }
        // Snapshot objects are content-addressed: refuse a mismatch up front.
        if q.kind != ItemKind::BlobPart && q.checksum != q.address {
            return Err(ServiceError::invalid("address"));
        }
        let state = self.active_device(p, &c).await?;
        let Principal::Device { id: device, .. } = *p else {
            return Err(ServiceError::reason(Code::Forbidden, "principal"));
        };
        if self.object_committed_current(&c, &q.address).await? {
            return Ok(PutObjectResult {
                status: PutStatus::Exists,
                direct: None,
            });
        }
        if state
            .meta
            .used_bytes
            .checked_add(q.size)
            .is_none_or(|used| used > state.meta.quotas.storage_bytes)
        {
            return Err(ServiceError::new(Code::QuotaExceeded));
        }
        match q.bytes {
            Some(b) => {
                validate_object_bytes(&c, &q.address, kind, q.size, &q.checksum, &b.0, budget)?;
                self.finalize(&c, &q.address, kind, b.0, now, budget)
                    .await?;
                Ok(PutObjectResult {
                    status: PutStatus::Stored,
                    direct: None,
                })
            }
            // No metadata until commit: the upload goes to this device's staging key.
            None => Ok(PutObjectResult {
                status: PutStatus::Upload,
                direct: Some(self.direct(Some(&device), &c, &q.address, q.size, &q.checksum, now)),
            }),
        }
    }

    /// Write verified bytes to the final key **write-once** and record them. If the
    /// final key already holds bytes (an earlier commit, or a crash after the copy),
    /// those bytes win (I8) and are re-verified before they are recorded.
    async fn finalize(
        &self,
        c: &Uuid,
        a: &B32,
        kind: u64,
        bytes: Vec<u8>,
        now: i64,
        budget: &Budget,
    ) -> Result<()> {
        self.refuse_deleted_floor(c).await?;
        let key = object_key(c, a);
        let mut size = bytes.len() as u64;
        let mut checksum = sha256(&bytes);
        if !self
            .objects
            .put_new_with_budget(&key, bytes, budget)
            .await?
        {
            let existing = self
                .objects
                .get(&key, None)
                .await?
                .ok_or_else(|| ServiceError::backend("object vanished"))?;
            size = existing.len() as u64;
            checksum = sha256(&existing);
            validate_object_bytes(c, a, kind, size, &checksum, &existing, budget)
                .map_err(|e| e.msg("existing object fails verification: integrity incident"))?;
        }
        self.record_object(
            c,
            ObjectMeta {
                address: *a,
                kind,
                size,
                checksum,
                committed: true,
                created_at: now,
            },
        )
        .await?;
        if !self.object_committed_current(c, a).await? {
            return Err(ServiceError::backend("object publication missing"));
        }
        Ok(())
    }

    /// `commit_object` after a direct upload.
    pub async fn commit_object(
        &self,
        p: &Principal,
        q: CommitObjectParams,
        now: i64,
    ) -> Result<bool> {
        let budget = Budget::default();
        self.scoped(&budget)
            .commit_object_with_budget(p, q, now, &budget)
            .await
    }

    /// Commit an object within the enclosing request's budget.
    pub async fn commit_object_with_budget(
        &self,
        p: &Principal,
        q: CommitObjectParams,
        now: i64,
        budget: &Budget,
    ) -> Result<bool> {
        let c = q.collection;
        self.active_device(p, &c).await?;
        let Principal::Device { id: device, .. } = *p else {
            return Err(ServiceError::reason(Code::Forbidden, "principal"));
        };
        if self.object_committed_current(&c, &q.address).await? {
            return Ok(true);
        }
        let staged = staging_key(&c, &q.address, &device);
        let final_key = object_key(&c, &q.address);
        // Streamed path: the upload host verified the bytes as they arrived and
        // recorded it; the actor checks the record and copies without buffering.
        if let Some(v) = self.objects.verified_meta(&staged).await? {
            if let Err(e) = check_verified(&q.address, &v) {
                self.objects.delete(&staged).await?;
                return Err(e);
            }
            self.refuse_deleted_floor(&c).await?;
            let v = if self.objects.copy_new(&staged, &final_key).await? {
                v
            } else {
                // First committed object wins (I8): describe what is there.
                self.objects
                    .verified_meta(&final_key)
                    .await?
                    .ok_or_else(|| {
                        ServiceError::backend("final object without verification record")
                    })?
            };
            self.record_object(
                &c,
                ObjectMeta {
                    address: q.address,
                    kind: v.kind,
                    size: v.size,
                    checksum: v.checksum,
                    committed: true,
                    created_at: now,
                },
            )
            .await?;
            self.objects.delete(&staged).await?;
            // Cleanup is an external await: do not emit a stale success after
            // deletion, even when metadata committed before that await.
            return self.object_committed_current(&c, &q.address).await;
        }
        let Some(bytes) = self.objects.get(&staged, None).await? else {
            return self.object_committed_current(&c, &q.address).await;
        };
        let kind = match verify_upload_with_budget(&c, &q.address, &bytes, budget) {
            Ok(v) => v.kind,
            Err(e) => {
                // Request resource refusal is NOT evidence that staged bytes
                // are corrupt. Preserve them for a minimal fresh-budget retry.
                // Only actual integrity/protocol failure authorizes cleanup.
                if !crate::decode::is_resource_refusal(&e) {
                    self.objects.delete(&staged).await?;
                }
                return Err(e);
            }
        };
        self.finalize(&c, &q.address, kind, bytes, now, budget)
            .await?;
        self.objects.delete(&staged).await?;
        self.object_committed_current(&c, &q.address).await
    }

    /// `get_object`.
    pub async fn get_object(
        &self,
        p: &Principal,
        q: GetObjectParams,
        now: i64,
    ) -> Result<GetObjectResult> {
        let c = q.collection;
        let mut tx = self.backend.begin(&c, Mode::Read).await?;
        let state = Self::load(&mut tx).await?;
        Self::authorize(&state, p)?;
        let meta = tx
            .objects(&[q.address])
            .await?
            .pop()
            .flatten()
            .filter(|m| m.committed)
            .ok_or_else(|| ServiceError::new(Code::NotFound))?;
        drop(tx);
        let key = object_key(&c, &q.address);
        let fetch = |range| async move {
            self.objects.get(&key, range).await?.ok_or_else(|| {
                ServiceError::new(Code::NotFound).msg("object bytes missing: integrity incident")
            })
        };
        if let Some(r) = q.range {
            if r.offset
                .checked_add(r.len)
                .is_none_or(|end| end > meta.size)
                || r.len > MAX_OBJECT_BYTES
            {
                return Err(ServiceError::invalid("range"));
            }
            let b = fetch(Some((r.offset, r.len))).await?;
            return Ok(GetObjectResult {
                bytes: Some(Bytes(b)),
                direct: None,
                size: meta.size,
                checksum: meta.checksum,
            });
        }
        if meta.size <= MAX_INLINE_OBJECT_BYTES {
            let b = fetch(None).await?;
            return Ok(GetObjectResult {
                bytes: Some(Bytes(b)),
                direct: None,
                size: meta.size,
                checksum: meta.checksum,
            });
        }
        Ok(GetObjectResult {
            bytes: None,
            direct: Some(self.direct(None, &c, &q.address, meta.size, &meta.checksum, now)),
            size: meta.size,
            checksum: meta.checksum,
        })
    }

    /// `has_objects`.
    pub async fn has_objects(
        &self,
        p: &Principal,
        q: HasObjectsParams,
    ) -> Result<HasObjectsResult> {
        if q.addresses.len() > MAX_HAS_OBJECTS {
            return Err(ServiceError::reason(Code::TooLarge, "addresses"));
        }
        let mut tx = self.backend.begin(&q.collection, Mode::Read).await?;
        let state = Self::load(&mut tx).await?;
        Self::authorize(&state, p)?;
        let metas = tx.objects(&q.addresses).await?;
        Ok(HasObjectsResult {
            present: metas
                .iter()
                .map(|m| m.as_ref().is_some_and(|m| m.committed))
                .collect(),
        })
    }

    // ------------------------------------------------------------------ snapshots (§7)

    /// `put_snapshot`.
    pub async fn put_snapshot(
        &self,
        p: &Principal,
        q: PutSnapshotParams,
        now: i64,
    ) -> Result<bool> {
        let budget = Budget::default();
        self.scoped(&budget)
            .put_snapshot_with_budget(p, q, now, &budget)
            .await
    }

    /// Register a snapshot within the enclosing request's budget. Ref-index
    /// objects among `refs` are expanded (`log-service-api.md` §7): the stored
    /// refs are the direct refs plus every address the indices list, so garbage
    /// collection and quota accounting see the complete set.
    pub async fn put_snapshot_with_budget(
        &self,
        p: &Principal,
        q: PutSnapshotParams,
        now: i64,
        budget: &Budget,
    ) -> Result<bool> {
        let c = q.collection;
        let mut tx = self.backend.begin(&c, Mode::Write).await?;
        let state = Self::load(&mut tx).await?;
        let Some(me) = Self::authorize(&state, p)?.cloned() else {
            return Err(ServiceError::reason(Code::Forbidden, "principal"));
        };
        if q.seq > state.meta.head || q.seq == 0 {
            return Err(ServiceError::invalid("seq"));
        }
        let snaps = tx.snapshots().await?;
        if snaps.first().is_some_and(|s| s.seq >= q.seq) {
            return Ok(false);
        }
        let mut refs: Vec<B32> = q.refs.clone();
        refs.push(q.manifest);
        refs.sort();
        refs.dedup();
        let metas = tx.objects(&refs).await?;
        let missing: Vec<Cbor> = refs
            .iter()
            .zip(&metas)
            .filter(|(_, m)| !m.as_ref().is_some_and(|m| m.committed))
            .map(|(a, _)| Cbor::Bytes(a.0.to_vec()))
            .collect();
        if !missing.is_empty() {
            let mut e = ServiceError::new(Code::RefsMissing);
            e.details = Some(Cbor::Array(missing));
            return Err(e);
        }
        // Kinds: the pointer names a manifest; refs are chunks, blob
        // parts and ref-index objects.
        let mut indices = Vec::new();
        for (a, m) in refs.iter().zip(&metas) {
            let k = m.as_ref().map_or(0, |m| m.kind);
            let ok = if *a == q.manifest {
                k == ItemKind::Manifest.value()
            } else if k == ItemKind::RefIndex.value() {
                indices.push(*a);
                true
            } else {
                k == ItemKind::Chunk.value() || k == ItemKind::BlobPart.value()
            };
            if !ok {
                return Err(ServiceError::invalid("kind").msg("snapshot object kind"));
            }
        }
        if !indices.is_empty() {
            refs = self
                .expand_ref_indices(&mut tx, &c, refs, &indices, budget)
                .await?;
        }
        tx.write(Write::InsertSnapshot(SnapshotRow {
            seq: q.seq,
            manifest: q.manifest,
            author: me.device,
            created_at: now,
            endorsed: false,
            refs,
        }));
        for old in snaps.iter().skip(RETAINED_SNAPSHOTS - 1) {
            tx.write(Write::DeleteSnapshot(old.seq));
        }
        tx.commit().await?;
        Ok(true)
    }

    /// Add every address the ref-index objects `indices` list to `refs`. Fails
    /// closed: an index beyond [`MAX_REF_INDICES`], an index whose bytes are gone
    /// or malformed, a member that is missing, or a member that is not a chunk or
    /// blob part (depth exactly one: an index never lists an index) refuses the
    /// snapshot, so nothing is registered without all of its roots.
    async fn expand_ref_indices<T: Txn>(
        &self,
        tx: &mut T,
        c: &Uuid,
        refs: Vec<B32>,
        indices: &[B32],
        budget: &Budget,
    ) -> Result<Vec<B32>> {
        if indices.len() > MAX_REF_INDICES {
            return Err(ServiceError::reason(Code::TooLarge, "ref_indices"));
        }
        let mut members = BTreeSet::new();
        for a in indices {
            let bytes = self
                .objects
                .get(&object_key(c, a), None)
                .await?
                .ok_or_else(|| {
                    ServiceError::backend("ref-index bytes missing: integrity incident")
                })?;
            members.extend(stored_ref_index(c, a, &bytes, budget)?);
        }
        let members: Vec<B32> = members.into_iter().collect();
        let metas = tx.objects(&members).await?;
        let mut missing = Vec::new();
        for (a, m) in members.iter().zip(&metas) {
            match m {
                Some(m) if m.committed => {
                    if m.kind != ItemKind::Chunk.value() && m.kind != ItemKind::BlobPart.value() {
                        return Err(ServiceError::invalid("kind").msg(if is_ref_index(m) {
                            "ref-index depth"
                        } else {
                            "ref-index member kind"
                        }));
                    }
                }
                _ if missing.len() < MAX_HAS_OBJECTS => {
                    missing.push(Cbor::Bytes(a.0.to_vec()));
                }
                _ => {}
            }
        }
        if !missing.is_empty() {
            let mut e = ServiceError::new(Code::RefsMissing);
            e.details = Some(Cbor::Array(missing));
            return Err(e);
        }
        let mut out = refs;
        out.extend(members);
        out.sort();
        out.dedup();
        Ok(out)
    }

    /// `get_snapshot`.
    pub async fn get_snapshot(&self, p: &Principal, c: &Uuid) -> Result<GetSnapshotResult> {
        let mut tx = self.backend.begin(c, Mode::Read).await?;
        let state = Self::load(&mut tx).await?;
        Self::authorize(&state, p)?;
        Ok(GetSnapshotResult {
            snapshots: tx.snapshots().await?.iter().map(Self::pointer).collect(),
        })
    }

    /// `endorse_snapshot`: from an active device other than the author; compaction
    /// may then advance.
    pub async fn endorse_snapshot(
        &self,
        p: &Principal,
        q: EndorseSnapshotParams,
        now: i64,
    ) -> Result<bool> {
        let c = q.collection;
        {
            let mut tx = self.backend.begin(&c, Mode::Write).await?;
            let state = Self::load(&mut tx).await?;
            let Some(me) = Self::authorize(&state, p)?.cloned() else {
                return Err(ServiceError::reason(Code::Forbidden, "principal"));
            };
            let snaps = tx.snapshots().await?;
            let Some(s) = snaps
                .iter()
                .find(|s| s.seq == q.seq && s.manifest == q.manifest)
            else {
                return Ok(false);
            };
            if s.author == me.device {
                return Err(ServiceError::reason(Code::Forbidden, "author"));
            }
            // Endorsers can verify state and write: editors and owners, or the
            // hosted replica. Not viewers, not escrow.
            let writer = state.meta.members.get(&me.account).is_some_and(|r| *r >= 1)
                && me.kind != device_kind::ESCROW;
            if !(writer || me.kind == device_kind::HOSTED) {
                return Err(ServiceError::reason(Code::Forbidden, "role"));
            }
            if !s.endorsed {
                tx.write(Write::EndorseSnapshot(s.seq));
                tx.commit().await?;
            }
        }
        self.compact(&c, now).await?;
        Ok(true)
    }

    /// Compaction (`snapshot.md` §5.1): deletes `entry` items at or below
    /// `C = min(S_e − 10,000, last position appended more than 7 days ago)`.
    /// Returns the new `retained_from`.
    pub async fn compact(&self, c: &Uuid, now: i64) -> Result<u64> {
        let mut tx = self.backend.begin(c, Mode::Write).await?;
        let mut state = Self::load(&mut tx).await?;
        let snaps = tx.snapshots().await?;
        let personal = state
            .acl
            .values()
            .filter(|e| e.active && e.kind != device_kind::HOSTED && e.kind != device_kind::ESCROW)
            .count();
        let s_e = snaps
            .iter()
            .filter(|s| s.endorsed || personal <= 1 && now - s.created_at > SELF_ENDORSE_AGE_MS)
            .map(|s| s.seq)
            .max()
            .unwrap_or(0);
        let c1 = s_e.saturating_sub(COMPACTION_GRACE_ENTRIES);
        let c2 = tx
            .last_seq_at_or_before(now - COMPACTION_MIN_AGE_MS)
            .await?;
        let cp = c1.min(c2);
        if cp < state.meta.retained_from {
            return Ok(state.meta.retained_from);
        }
        let bytes = tx.entry_bytes_through(cp).await?;
        // Archive first; the deletion commits only once every segment is stored.
        // On any error nothing is deleted and the next run retries (the segment
        // keys are deterministic, so a partial archive is simply rewritten).
        self.archive_entries(
            &mut tx,
            c,
            state.meta.retention_tier,
            state.meta.retained_from,
            cp,
        )
        .await?;
        tx.write(Write::DeleteEntriesThrough(cp));
        state.meta.retained_from = cp + 1;
        state.meta.used_bytes = state.meta.used_bytes.saturating_sub(bytes);
        tx.write(Write::PutMeta(state.meta.clone()));
        tx.commit().await?;
        Ok(cp + 1)
    }

    /// Write the `entry` items in `(retained_from − 1, cp]` to the archive, in
    /// order, as segments of at most [`ARCHIVE_SEGMENT_BYTES`] item bytes (a
    /// single larger item is a segment on its own).
    async fn archive_entries<T: Txn>(
        &self,
        tx: &mut T,
        c: &Uuid,
        tier: RetentionTier,
        retained_from: u64,
        cp: u64,
    ) -> Result<()> {
        let mut after = retained_from.saturating_sub(1);
        let mut seg: Vec<StoredItem> = Vec::new();
        let mut seg_bytes = 0u64;
        'pages: loop {
            let page = tx
                .items(after, MAX_READ_ITEMS, ARCHIVE_SEGMENT_BYTES, false)
                .await?;
            if page.is_empty() {
                break;
            }
            for it in page {
                if it.seq > cp {
                    break 'pages;
                }
                after = it.seq;
                if it.kind != 1 {
                    continue;
                }
                let n = it.bytes.len() as u64;
                if !seg.is_empty() && seg_bytes + n > ARCHIVE_SEGMENT_BYTES {
                    self.put_segment(c, tier, &seg).await?;
                    seg.clear();
                    seg_bytes = 0;
                }
                seg_bytes += n;
                seg.push(it);
            }
        }
        if !seg.is_empty() {
            self.put_segment(c, tier, &seg).await?;
        }
        Ok(())
    }

    async fn put_segment(&self, c: &Uuid, tier: RetentionTier, seg: &[StoredItem]) -> Result<()> {
        let (from, to) = (seg[0].seq, seg[seg.len() - 1].seq);
        let bytes = encode_segment(c, seg);
        self.objects.put_segment(c, tier, from, to, bytes).await
    }

    /// Garbage collection (§6.2, I10). Each dead object is archived first; one
    /// whose archive copy fails is kept this round. Uncommitted uploads have no
    /// bytes at their final key and are not archived. Returns the number of
    /// objects deleted.
    pub async fn gc(&self, c: &Uuid, now: i64) -> Result<u64> {
        let mut tx = self.backend.begin(c, Mode::Write).await?;
        let mut state = Self::load(&mut tx).await?;
        let candidates = tx.gc_candidates(now - OBJECT_GRACE_MS, 1000).await?;
        let tier = state.meta.retention_tier;
        let mut dead = Vec::with_capacity(candidates.len());
        for o in candidates {
            if o.committed
                && self
                    .objects
                    .archive_object(c, tier, &o.address)
                    .await
                    .is_err()
            {
                continue;
            }
            dead.push(o);
        }
        if dead.is_empty() {
            return Ok(0);
        }
        for o in &dead {
            tx.write(Write::DeleteObject(o.address));
            if o.committed {
                state.meta.used_bytes = state.meta.used_bytes.saturating_sub(o.size);
            }
        }
        tx.write(Write::PutMeta(state.meta));
        tx.commit().await?;
        for o in &dead {
            self.objects.delete(&object_key(c, &o.address)).await?;
        }
        Ok(dead.len() as u64)
    }

    // ------------------------------------------------------------------ admin (§12)

    /// `create_log {0: collection, 1: genesis item}`.
    async fn create_log(
        &self,
        p: &Principal,
        params: &Cbor,
        now: i64,
        budget: &Budget,
    ) -> Result<Outcome> {
        self.require_cp(p)?;
        let c = uuid_field(params, 0)?;
        self.refuse_deleted_floor(&c).await?;
        let bytes = match field(params, 1) {
            Some(Cbor::Bytes(b)) => b.clone(),
            _ => return Err(bad_params("genesis")),
        };
        let it = budget.wire::<Item>(&bytes)?;
        it.check_shape()
            .map_err(|e| ServiceError::invalid("shape").msg(e.to_string()))?;
        if it.kind != ItemKind::Policy
            || it.collection != c
            || it.seq != Some(1)
            || it.prev != Some(CHAIN_ZERO)
        {
            return Err(ServiceError::invalid("shape").msg("genesis item"));
        }
        let mut tx = self.backend.begin(&c, Mode::Write).await?;
        let chain = chain_hash(&bytes);
        let ok = map(vec![(0, Cbor::Uint(1)), (1, Cbor::Bytes(chain.0.to_vec()))]);
        if let Some(existing) = tx.load().await? {
            if existing.meta.status == Status::Gone {
                return Err(ServiceError::new(Code::Gone));
            }
            let first = tx.items(0, 1, u64::MAX, false).await?;
            self.refuse_deleted_floor(&c).await?;
            if first.first().is_some_and(|i| i.bytes == bytes) {
                return Ok(Outcome::plain(ok));
            }
            return Err(ServiceError::invalid("exists"));
        }
        let mut st = CollectionState {
            meta: CollectionMeta::new(c, now),
            acl: BTreeMap::new(),
        };
        apply_policy_with_budget(&mut st, &it, 1, &self.config.roots, budget)?;
        st.meta.head = 1;
        st.meta.head_chain = chain;
        st.meta.used_bytes = bytes.len() as u64;
        tx.write(Write::CreateCollection(st));
        tx.write(Write::InsertItem(StoredItem {
            seq: 1,
            kind: ItemKind::Policy.value(),
            bytes: bytes.clone(),
            appended_at: now,
            token: None,
            refs: vec![],
        }));
        tx.commit().await?;
        Ok(Outcome::plain(ok))
    }

    /// `set_quota {0: collection, 1: [storage, items/s, bytes/s, burst]}`.
    async fn set_quota(&self, p: &Principal, params: &Cbor) -> Result<Outcome> {
        self.require_cp(p)?;
        let c = uuid_field(params, 0)?;
        let q = match field(params, 1) {
            Some(Cbor::Array(a)) if a.len() == 4 => a
                .iter()
                .map(|x| match x {
                    Cbor::Uint(n) => Ok(*n),
                    _ => Err(bad_params("quota")),
                })
                .collect::<Result<Vec<u64>>>()?,
            _ => return Err(bad_params("quota")),
        };
        let mut tx = self.backend.begin(&c, Mode::Write).await?;
        let mut st = Self::load(&mut tx).await?;
        if st.meta.status == Status::Importing && st.meta.restore_plan.is_some() {
            return Err(ServiceError::invalid("restore_settings")
                .msg("strict restore preserves the source quota"));
        }
        st.meta.quotas = Quotas {
            storage_bytes: q[0],
            items_per_s: q[1].max(1),
            bytes_per_s: q[2].max(1),
            burst_items: q[3].max(1),
        };
        tx.write(Write::PutMeta(st.meta));
        tx.commit().await?;
        self.buckets.lock().unwrap().remove(&c);
        Ok(Outcome::plain(map(vec![(0, Cbor::Bool(true))])))
    }

    /// Independently read the backend-owned immutable floor; a foreign or
    /// malformed record never becomes authoritative absence.
    async fn deletion_floor(
        &self,
        c: &Uuid,
    ) -> Result<Option<crate::deletion::CollectionDeletionRecord>> {
        let floor = self.backend.collection_deletion_floor(c).await?;
        if let Some(record) = floor {
            record.validate()?;
            if record.collection != *c {
                return Err(crate::deletion::CollectionDeletionRecord::unavailable());
            }
        }
        Ok(floor)
    }

    async fn refuse_deleted_floor(&self, c: &Uuid) -> Result<()> {
        if let Some(record) = self.deletion_floor(c).await? {
            let mut error = ServiceError::reason(Code::Gone, "collection_deletion_floor");
            error.details = Some(record.to_cbor());
            return Err(error);
        }
        Ok(())
    }

    fn terminal_params(params: &Cbor, count: usize) -> Result<Uuid> {
        let bad = || ServiceError::invalid("collection_deletion_request");
        let Cbor::Map(fields) = params else {
            return Err(bad());
        };
        if fields.len() != count
            || fields
                .iter()
                .enumerate()
                .any(|(i, (k, _))| *k != Cbor::Uint(i as u64))
        {
            return Err(bad());
        }
        let c = uuid_field(params, 0).map_err(|_| bad())?;
        if c == B16([0; 16]) {
            return Err(bad());
        }
        Ok(c)
    }

    /// Strict floor-bound durable Gone; no legacy/bare-bool request or receipt.
    async fn delete_log(&self, p: &Principal, params: &Cbor) -> Result<Outcome> {
        self.require_cp(p)?;
        let c = Self::terminal_params(params, 3)?;
        let deletion_id = uuid_field(params, 1)
            .map_err(|_| ServiceError::invalid("collection_deletion_request"))?;
        let lifecycle_epoch = match field(params, 2) {
            Some(Cbor::Uint(n)) if *n > 0 => *n,
            _ => return Err(ServiceError::invalid("collection_deletion_request")),
        };
        if deletion_id == B16([0; 16]) {
            return Err(ServiceError::invalid("collection_deletion_request"));
        }
        let requested = crate::deletion::CollectionDeletionRecord {
            collection: c,
            deletion_id,
            lifecycle_epoch,
        };
        let floor = self
            .deletion_floor(&c)
            .await?
            .ok_or_else(crate::deletion::CollectionDeletionRecord::unavailable)?;
        if floor != requested {
            return Err(floor.conflict());
        }
        // The first floor is immutable: no successor can replace it between
        // this independent read and the collection's serialized terminal commit.
        let mut tx = self.backend.begin(&c, Mode::Write).await?;
        let mut st = Self::load(&mut tx).await?;
        if st.meta.id != c {
            return Err(crate::deletion::CollectionDeletionRecord::unavailable());
        }
        let result = map(vec![(0, Cbor::Bool(true)), (1, requested.to_cbor())]);
        if st.meta.status == Status::Gone {
            return match st.meta.deletion {
                Some(actual) if actual == requested => Ok(Outcome::plain(result)),
                Some(actual) => Err(actual.conflict()),
                None => Err(ServiceError::reason(
                    Code::Gone,
                    "collection_deletion_receipt_missing",
                )),
            };
        }
        if st.meta.deletion.is_some() {
            return Err(crate::deletion::CollectionDeletionRecord::unavailable());
        }
        st.meta.status = Status::Gone;
        st.meta.deletion = Some(requested);
        let notice = CommitNotice {
            collection: c,
            first: 0,
            head: st.meta.head,
            head_chain: st.meta.head_chain,
            revoked: vec![],
            gone: true,
        };
        tx.write(Write::PutMeta(st.meta));
        tx.write(Write::Notify(notice.clone()));
        tx.commit().await?;
        Ok(Outcome {
            result,
            notice: Some(notice),
            items: vec![],
            credentials_revoked: None,
            repair: None,
        })
    }

    /// CP-only serialized observation; absent/tupleless states never authorize.
    async fn log_terminal_status(&self, p: &Principal, params: &Cbor) -> Result<Outcome> {
        self.require_cp(p)?;
        let c = Self::terminal_params(params, 1)?;
        let mut tx = self.backend.begin(&c, Mode::Write).await?;
        let (status, receipt) = match tx.load().await? {
            None => (0, Cbor::Null),
            Some(st) => {
                if st.meta.id != c {
                    return Err(crate::deletion::CollectionDeletionRecord::unavailable());
                }
                let status = match st.meta.status {
                    Status::Live => 1,
                    Status::Importing => 2,
                    Status::Gone => 3,
                };
                let receipt = match st.meta.deletion {
                    Some(record) => {
                        record.validate()?;
                        if record.collection != c || status != 3 {
                            return Err(crate::deletion::CollectionDeletionRecord::unavailable());
                        }
                        record.to_cbor()
                    }
                    None => Cbor::Null,
                };
                (status, receipt)
            }
        };
        Ok(Outcome::plain(map(vec![
            (0, Cbor::Uint(1)),
            (1, c.to_cbor()),
            (2, Cbor::Uint(status)),
            (3, receipt),
        ])))
    }

    /// `export {0: collection, 1: after}` (§12): one page of every retained item, plus
    /// the head and retention, and the snapshots with their refs.
    ///
    /// Result: `{0: [[seq, item]], 1: [snapshot-pointer], 2: more, 3: head,
    /// 4: chain(head), 5: retained_from, 6: [[seq, [ref]]], 7: restore-settings}`.
    /// Objects are listed by `export_objects` and fetched with `get_object`
    /// (the control plane may read). Settings are operational metadata only;
    /// they never replace the signed policy projection.
    async fn export(&self, p: &Principal, params: &Cbor) -> Result<Outcome> {
        self.require_cp(p)?;
        let c = uuid_field(params, 0)?;
        let after = match field(params, 1) {
            Some(Cbor::Uint(n)) => *n,
            _ => 0,
        };
        let mut tx = self.backend.begin(&c, Mode::Read).await?;
        let st = Self::load(&mut tx).await?;
        let items = tx
            .items(after, MAX_READ_ITEMS, MAX_READ_BYTES, false)
            .await?;
        let more = items.last().is_some_and(|i| i.seq < st.meta.head);
        let snaps = tx.snapshots().await?;
        let mut snap_refs = Vec::new();
        for sn in &snaps {
            let refs = tx.snapshot_refs(sn.seq).await?;
            snap_refs.push(Cbor::Array(vec![
                Cbor::Uint(sn.seq),
                Cbor::Array(refs.iter().map(|r| r.to_cbor()).collect()),
            ]));
        }
        Ok(Outcome::plain(map(vec![
            (
                0,
                Cbor::Array(
                    items
                        .into_iter()
                        .map(|i| {
                            SeqItem {
                                seq: i.seq,
                                item: Bytes(i.bytes),
                            }
                            .to_cbor()
                        })
                        .collect(),
                ),
            ),
            (
                1,
                Cbor::Array(snaps.iter().map(|s| Self::pointer(s).to_cbor()).collect()),
            ),
            (2, Cbor::Bool(more)),
            (3, Cbor::Uint(st.meta.head)),
            (4, st.meta.head_chain.to_cbor()),
            (5, Cbor::Uint(st.meta.retained_from)),
            (6, Cbor::Array(snap_refs)),
            (7, RestoreSettings::export(&st.meta)),
        ])))
    }

    /// `export_objects {0: collection, ? 1: after address}`: committed objects in
    /// address order, 1,000 per page. Result `{0: [[address, kind, size, checksum]], 1: more}`.
    async fn export_objects(&self, p: &Principal, params: &Cbor) -> Result<Outcome> {
        self.require_cp(p)?;
        let c = uuid_field(params, 0)?;
        let after = field(params, 1).and_then(|v| B32::from_cbor(v).ok());
        let mut tx = self.backend.begin(&c, Mode::Read).await?;
        Self::load(&mut tx).await?;
        let objs = tx.list_objects(after, 1000).await?;
        let more = objs.len() == 1000;
        Ok(Outcome::plain(map(vec![
            (
                0,
                Cbor::Array(
                    objs.iter()
                        .map(|o| {
                            Cbor::Array(vec![
                                o.address.to_cbor(),
                                Cbor::Uint(o.kind),
                                Cbor::Uint(o.size),
                                o.checksum.to_cbor(),
                            ])
                        })
                        .collect(),
                ),
            ),
            (1, Cbor::Bool(more)),
        ])))
    }

    /// `import_object {0: collection, 1: address, 2: kind, 3: bytes}`: restore one
    /// object (verified like an upload; written write-once). Objects are imported
    /// before the items and snapshots that reference them.
    async fn import_object(
        &self,
        p: &Principal,
        params: &Cbor,
        now: i64,
        budget: &Budget,
    ) -> Result<Outcome> {
        self.require_cp(p)?;
        let c = uuid_field(params, 0)?;
        self.refuse_deleted_floor(&c).await?;
        let a = field(params, 1)
            .and_then(|v| B32::from_cbor(v).ok())
            .ok_or_else(|| bad_params("address"))?;
        let kind = match field(params, 2) {
            Some(Cbor::Uint(k)) if matches!(k, 16..=19) => *k,
            _ => return Err(bad_params("kind")),
        };
        let bytes = match field(params, 3) {
            Some(Cbor::Bytes(b)) if b.len() as u64 <= MAX_OBJECT_BYTES => b.clone(),
            _ => return Err(bad_params("bytes")),
        };
        {
            let mut tx = self.backend.begin(&c, Mode::Read).await?;
            if let Some(st) = tx.load().await?
                && st.meta.status != Status::Importing
            {
                return Err(ServiceError::invalid("state").msg("collection is not being imported"));
            }
        }
        let ck = sha256(&bytes);
        validate_object_bytes(&c, &a, kind, bytes.len() as u64, &ck, &bytes, budget)?;
        self.finalize(&c, &a, kind, bytes, now, budget).await?;
        self.refuse_deleted_floor(&c).await?;
        Ok(Outcome::plain(map(vec![(0, Cbor::Bool(true))])))
    }

    /// `import {0: collection, 1: [[seq, item]], ? 2: {0: retained_from,
    /// ? 1: expected_head, ? 2: expected_chain}, ? 3: restore-settings}`: restore
    /// exported items, in order, page by page (§12, gate 4). Settings are accepted
    /// only on the empty target's first genesis page, before object imports.
    ///
    /// The first page must start with the genesis item at position 1; the collection
    /// is then `unavailable` to everyone else until the final page (key 2) sets the
    /// retention and makes it live. Every item is re-verified exactly as an append
    /// would be (envelope, chain across consecutive positions, signatures, policy and
    /// epoch state, refs): a backup cannot smuggle in what the service would have
    /// refused. Compacted entry slots may be absent; strict plans bind every
    /// retained signed item, including every control item.
    async fn import(
        &self,
        p: &Principal,
        params: &Cbor,
        now: i64,
        budget: &Budget,
    ) -> Result<Outcome> {
        self.require_cp(p)?;
        let c = uuid_field(params, 0)?;
        self.refuse_deleted_floor(&c).await?;
        let page: Vec<SeqItem> = match field(params, 1) {
            Some(Cbor::Array(a)) => a
                .iter()
                .map(SeqItem::from_cbor)
                .collect::<std::result::Result<_, _>>()
                .map_err(bad_params)?,
            _ => return Err(bad_params("items")),
        };
        let settings = field(params, 3).map(RestoreSettings::parse).transpose()?;
        let plan = field(params, 4).map(RestorePlan::parse).transpose()?;
        if plan.is_some() && settings.is_none() {
            return Err(ServiceError::invalid("restore_settings")
                .msg("strict restore requires source settings"));
        }
        let done = field(params, 2)
            .map(|d| match field(d, 0) {
                Some(Cbor::Uint(n)) => Ok(*n),
                _ => Err(bad_params("retained_from")),
            })
            .transpose()?;
        let expected = field(params, 2)
            .map(|d| match (field(d, 1), field(d, 2)) {
                (None, None) => Ok(None),
                (Some(Cbor::Uint(head)), Some(chain)) => B32::from_cbor(chain)
                    .map(|chain| Some((*head, chain)))
                    .map_err(|_| bad_params("restore_head")),
                _ => Err(bad_params("restore_head")),
            })
            .transpose()?
            .flatten();
        let mut tx = self.backend.begin(&c, Mode::Write).await?;
        let (mut ws, created) = match tx.load().await? {
            Some(st) if st.meta.status == Status::Importing => (st, false),
            Some(_) => return Err(ServiceError::invalid("state").msg("collection exists")),
            None => {
                let mut m = CollectionMeta::new(c, now);
                m.status = Status::Importing;
                (
                    CollectionState {
                        meta: m,
                        acl: BTreeMap::new(),
                    },
                    true,
                )
            }
        };
        if let Some(plan) = plan {
            if !created {
                return Err(
                    ServiceError::invalid("restore_plan").msg("plan requires an empty target")
                );
            }
            ws.meta.restore_plan = Some(plan);
        }
        if let Some(settings) = settings {
            if !created {
                return Err(ServiceError::invalid("restore_settings")
                    .msg("settings require an empty target"));
            }
            settings.apply(&mut ws.meta);
        }
        let strict = ws.meta.restore_plan.is_some();
        let before = ws.clone();
        let mut total = 0u64;
        for si in &page {
            let bytes = &si.item.0;
            let it = budget.wire::<Item>(bytes)?;
            it.check_shape()
                .map_err(|e| ServiceError::invalid("shape").msg(format!("seq {}: {e}", si.seq)))?;
            if it.collection != c
                || !it.kind.is_log_item()
                || it.seq != Some(si.seq)
                || si.seq <= ws.meta.head
            {
                return Err(ServiceError::invalid("shape").msg(format!("seq {}", si.seq)));
            }
            if si.seq == ws.meta.head + 1 {
                if it.prev != Some(ws.meta.head_chain) {
                    return Err(ServiceError::invalid("chain").msg(format!("seq {}", si.seq)));
                }
            } else if let Some(plan) = &ws.meta.restore_plan {
                // Strict archives bind EVERY retained item. A gap can only be
                // below their declared compaction boundary, including a gap
                // before a retained control item. Final item-root equality
                // ensures no omitted control/retained-entry slot is accepted.
                if ws.meta.head == 0 || si.seq > plan.retained_from {
                    return Err(ServiceError::invalid("chain").msg("gap outside compacted prefix"));
                }
            } else if it.kind.is_control() || ws.meta.head == 0 {
                // Legacy callers retain their existing gap validation.
                return Err(ServiceError::invalid("chain")
                    .msg(format!("gap before control item {}", si.seq)));
            }
            check_item(&mut ws, &it, si.seq, 0, &self.config.roots, budget)?;
            if let Some(refs) = &it.refs {
                let metas = tx.objects(refs).await?;
                if metas.iter().flatten().any(is_ref_index) {
                    return Err(ServiceError::invalid("kind").msg("ref-index outside a snapshot"));
                }
                if metas
                    .iter()
                    .any(|m| !m.as_ref().is_some_and(|m| m.committed))
                {
                    return Err(ServiceError::new(Code::RefsMissing).msg(format!("seq {}", si.seq)));
                }
            }
            if let Some(plan) = &mut ws.meta.restore_plan {
                plan.record(si.seq, bytes)?;
            }
            tx.write(Write::InsertItem(StoredItem {
                seq: si.seq,
                kind: it.kind.value(),
                bytes: bytes.clone(),
                appended_at: now,
                token: it.idem,
                refs: it.refs.clone().unwrap_or_default(),
            }));
            total += bytes.len() as u64;
            ws.meta.head = si.seq;
            ws.meta.head_chain = chain_hash(bytes);
        }
        ws.meta.used_bytes = ws
            .meta
            .used_bytes
            .checked_add(total)
            .ok_or_else(|| ServiceError::invalid("restore_accounting"))?;
        if ws
            .meta
            .restore_plan
            .as_ref()
            .is_some_and(|plan| ws.meta.used_bytes > plan.used_bytes || ws.meta.head > plan.head)
        {
            return Err(ServiceError::invalid("restore_accounting"));
        }
        if let Some(rf) = done {
            if expected
                .is_some_and(|(head, chain)| head != ws.meta.head || chain != ws.meta.head_chain)
            {
                return Err(ServiceError::invalid("restore_head"));
            }
            if rf > ws.meta.head + 1 || rf == 0 {
                return Err(bad_params("retained_from"));
            }
            ws.meta.retained_from = rf;
            if let Some(plan) = &ws.meta.restore_plan {
                plan.verify(&mut tx, &ws.meta).await?;
            }
            ws.meta.restore_plan = None;
            ws.meta.status = Status::Live;
        }
        if created {
            if ws.meta.head == 0 {
                return Err(ServiceError::invalid("shape").msg("first page must start at genesis"));
            }
            tx.write(Write::CreateCollection(CollectionState {
                meta: ws.meta.clone(),
                acl: ws.acl.clone(),
            }));
        } else {
            for (d, e) in &ws.acl {
                if before.acl.get(d) != Some(e) {
                    tx.write(Write::UpsertAcl(e.clone()));
                }
            }
            tx.write(Write::PutMeta(ws.meta.clone()));
        }
        self.refuse_deleted_floor(&c).await?;
        tx.commit().await?;
        Ok(Outcome::plain(map(vec![
            (0, Cbor::Uint(ws.meta.head)),
            (1, ws.meta.head_chain.to_cbor()),
            (2, Cbor::Bool(ws.meta.status == Status::Live)),
            (3, Cbor::Bool(strict)),
        ])))
    }

    /// `import_snapshot {0: collection, 1: snapshot-pointer, 2: [refs]}`: restore a
    /// snapshot pointer (its objects must already be imported).
    async fn import_snapshot(&self, p: &Principal, params: &Cbor) -> Result<Outcome> {
        self.require_cp(p)?;
        let c = uuid_field(params, 0)?;
        self.refuse_deleted_floor(&c).await?;
        let ptr = field(params, 1)
            .and_then(|v| SnapshotPointer::from_cbor(v).ok())
            .ok_or_else(|| bad_params("pointer"))?;
        let mut refs: Vec<B32> = match field(params, 2) {
            Some(Cbor::Array(a)) => a.iter().filter_map(|v| B32::from_cbor(v).ok()).collect(),
            _ => return Err(bad_params("refs")),
        };
        let mut tx = self.backend.begin(&c, Mode::Write).await?;
        let st = Self::load(&mut tx).await?;
        if st.meta.status != Status::Importing || ptr.seq > st.meta.head {
            return Err(ServiceError::invalid("state"));
        }
        if st.meta.restore_plan.is_some() {
            if !matches!(field(params, 2), Some(Cbor::Array(a)) if a.len() == refs.len()) {
                return Err(bad_params("refs"));
            }
            // Expanded refs are a set: persist the same unique canonical edges
            // that the authenticated inventory binds, not duplicate refcounts.
            refs.sort();
            refs.dedup();
            if !refs.contains(&ptr.manifest) {
                return Err(ServiceError::new(Code::RefsMissing));
            }
        }
        let metas = tx.objects(&refs).await?;
        if metas
            .iter()
            .any(|m| !m.as_ref().is_some_and(|m| m.committed))
        {
            return Err(ServiceError::new(Code::RefsMissing));
        }
        tx.write(Write::InsertSnapshot(SnapshotRow {
            seq: ptr.seq,
            manifest: ptr.manifest,
            author: ptr.author,
            created_at: ptr.created_at,
            endorsed: ptr.endorsed,
            refs,
        }));
        self.refuse_deleted_floor(&c).await?;
        tx.commit().await?;
        Ok(Outcome::plain(map(vec![(0, Cbor::Bool(true))])))
    }
}
