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
use crate::backend::{
    Archive, Backend, BudgetBackend, Mode, ObjectStore, Txn, Verified, VerifiedCopy, Write,
};
use crate::decode::Budget;

#[cfg(not(target_arch = "wasm32"))]
mod offline;
use crate::error::{Code, Result, ServiceError};
use crate::limits::*;
use crate::model::{
    AclEntry, CollectionMeta, CollectionState, CommitNotice, ObjectMeta, Quotas, RetentionTier,
    SnapshotRow, Status, StoredItem, device_kind, object_key, parse_uuid, unhex,
};
use crate::placement::{Placement, Region, Regions};
use crate::policy::{apply_policy_with_budget, apply_rekey_with_budget};
use crate::restore::RestoreSettings;
use crate::restore_plan::RestorePlan;
#[cfg(not(target_arch = "wasm32"))]
pub use offline::OfflineReplayVerifier;

mod access;
mod admin;
mod append;
mod compaction;
mod dispatch;
mod import_export;
mod objects;
mod presign;
mod read;
mod snapshots;
mod validate;

use validate::*;

pub use compaction::encode_segment;
pub use presign::{DirectOp, base64, ct_eq, parse_range, staging_key, verify_direct};
pub use validate::{rebuild_state, verify_upload, verify_upload_with_budget};

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
    /// Default and served regions for new collections ([`crate::placement`]).
    /// No default keeps the original bucket and placement.
    regions: Regions,
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

impl<B: Backend, O: ObjectStore> Service<B, O> {
    /// A service.
    pub fn new(backend: B, objects: O, config: Config) -> Self {
        Service {
            backend: Arc::new(backend),
            objects: Arc::new(objects),
            config,
            buckets: Arc::new(Mutex::new(BTreeMap::new())),
            creds: Arc::new(Mutex::new(BTreeMap::new())),
            regions: Regions::default(),
        }
    }

    /// Record `region` for new collections whose creator states no region and
    /// no location (see [`crate::placement`]).
    pub fn with_default_region(self, region: Option<Region>) -> Self {
        self.with_regions(Regions::new(region, &Region::ALL))
    }

    /// The default region and the regions this host can store.
    pub fn with_regions(mut self, regions: Regions) -> Self {
        self.regions = regions;
        self
    }
}
