use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::http::StatusCode;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{DateTime, Utc};
use hmac::{Hmac, Mac};
use mdbase::v03::{Diagnostic, OperationResult};
use mdbase_connect_protocol::{
    authority_file_hash, authority_manifest_digest as snapshot_manifest_digest,
    AuthorityImportManifest, AuthorityImportRecord, AuthorityImportRecordPage,
    AuthoritySnapshotRecord, CollectionChange, CollectionChangesPage, CollectionContractDescriptor,
    CollectionDescription, CollectionTypeDescriptor, ContractRequirement, ContractSetupChoice,
    ContractSetupMode, FileAction, FileCapability, FileScope, GrantSummary, SyncChange,
    SyncChangesPage, SyncCollectionResources, SyncConflict, SyncFileSnapshotPage,
    SyncFileSnapshotPageKind, SyncMutation, SyncMutationError, SyncMutationOperation,
    SyncMutationReceipt, SyncRecord, SyncReplicaMode, SyncResourceDocument, SyncSession,
    SyncSnapshotPage, SyncSnapshotRecord, TypePackProvision, AUTHORITY_PROOF_DOMAIN,
    AUTHORITY_PROOF_VERSION, CONTROL_PROTOCOL_VERSION, FILE_PROTOCOL_VERSION,
    SYNC_PROTOCOL_VERSION,
};
use mdbase_connect_runtime::contract_scope::{ContractScope, ContractSelector};
use p256::ecdsa::{signature::Verifier, Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{
    postgres::{PgPoolOptions, PgRow},
    PgPool, Postgres, Row, Transaction,
};
use subtle::ConstantTimeEq;
use tokio::sync::{Mutex, RwLock};
use uuid::Uuid;

use crate::{
    backup_admin::lock_blob_deletion,
    blob_store::BlobStore,
    crypto::ProviderCrypto,
    error::{ApiError, ApiResult},
    notifications::{HostedNotificationConfig, HostedNotificationRuntime},
    template,
    workspace::{StoredDocument, WorkingSet},
};

mod account_quotas;
mod authority_import_cleanup;
mod authority_import_files;
mod authority_imports;
mod authority_snapshots;
mod authority_transfers;
mod capabilities;
mod collections;
mod compaction;
mod crypto_state;
mod file_policy;
mod files;
mod lifecycle;
mod lifecycle_states;
mod mutations;
mod operation_context;
mod operation_dispatch;
mod operation_reads;
mod operation_records;
mod operation_types;
mod operation_views;
mod persistence;
mod policy;
mod provider_state;
mod replicas;
mod sync_reads;

use account_quotas::*;
use authority_snapshots::*;
use capabilities::*;
use crypto_state::*;
use file_policy::*;
use lifecycle_states::{
    authority_import_state, authority_transfer_state, hosted_collection_state,
    HostedCollectionState,
};
pub use lifecycle_states::{ProviderAuthorityImportState, ProviderAuthorityTransferState};
use operation_context::RecordOperationContext;
use persistence::*;
use policy::*;

const SNAPSHOT_PAGE_SIZE: i64 = 200;
const DATABASE_STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
const KEY_READINESS_SUCCESS_TTL: Duration = Duration::from_secs(60);
const KEY_READINESS_FAILURE_TTL: Duration = Duration::from_secs(5);
type WorkingSetSlot = Arc<Mutex<Option<CachedCollection>>>;
type WorkingSetRegistry = Arc<Mutex<HashMap<Uuid, WorkingSetSlot>>>;

struct KeyReadinessState {
    last_checked: Instant,
    healthy: bool,
}

impl KeyReadinessState {
    fn should_probe(&self, now: Instant) -> bool {
        let ttl = if self.healthy {
            KEY_READINESS_SUCCESS_TTL
        } else {
            KEY_READINESS_FAILURE_TTL
        };
        now.saturating_duration_since(self.last_checked) >= ttl
    }
}

#[derive(Debug, Clone)]
pub struct ProviderLimits {
    pub max_records_per_collection: u64,
    pub max_bytes_per_collection: u64,
    pub max_bytes_per_document: u64,
    pub max_replicas_per_collection: u64,
    pub max_files_per_collection: u64,
    pub max_file_bytes_per_collection: u64,
    pub max_stored_file_bytes_per_collection: u64,
    pub max_bytes_per_file: u64,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
pub struct ProviderAccountLimits {
    pub hosted_storage_bytes: u64,
    pub retained_file_bytes: u64,
    pub max_document_bytes: u64,
    pub max_single_file_bytes: u64,
    pub max_replicas_per_collection: u64,
    pub max_hosted_collections: u64,
    pub max_files_per_collection: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProviderAccountUsage {
    pub account_id: Uuid,
    pub entitlement_revision: u64,
    pub collection_count: u64,
    pub live_content_bytes: u64,
    pub live_file_bytes: u64,
    pub retained_file_bytes: u64,
    #[serde(flatten)]
    pub limits: ProviderAccountLimits,
}

impl Default for ProviderLimits {
    fn default() -> Self {
        Self {
            max_records_per_collection: 100_000,
            max_bytes_per_collection: 1024 * 1024 * 1024,
            max_bytes_per_document: 2 * 1024 * 1024,
            max_replicas_per_collection: 100,
            max_files_per_collection: 10_000,
            max_file_bytes_per_collection: 5 * 1024 * 1024 * 1024,
            max_stored_file_bytes_per_collection: 10 * 1024 * 1024 * 1024,
            max_bytes_per_file: 1024 * 1024 * 1024,
        }
    }
}

#[derive(Clone)]
pub struct HostedProvider {
    pool: PgPool,
    crypto: ProviderCrypto,
    key_readiness: Arc<Mutex<KeyReadinessState>>,
    limits: ProviderLimits,
    working_sets: WorkingSetRegistry,
    notifications: Option<HostedNotificationRuntime>,
    notification_recovery: Arc<RwLock<NotificationRecoveryStatus>>,
    blob_store: Arc<dyn BlobStore>,
}

#[derive(Debug, Clone, Serialize)]
pub struct NotificationRecoveryStatus {
    pub configured: bool,
    pub recovery: &'static str,
    pub consecutive_failures: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_success_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RegisterReplica {
    pub replica_id: Uuid,
    pub name: String,
    #[serde(default)]
    pub purpose: ReplicaPurpose,
    pub mode: SyncReplicaMode,
    #[serde(default)]
    pub allowed_types: Vec<String>,
    #[serde(default)]
    pub contract_scope: Vec<CollectionContractDescriptor>,
    #[serde(default)]
    pub full_collection: bool,
    #[serde(default)]
    pub allowed_operations: Vec<String>,
    #[serde(default)]
    pub file_capability: Option<FileCapability>,
    #[serde(default)]
    pub allowed_origin: Option<String>,
    #[serde(default)]
    pub proof_public_key: Option<String>,
    #[serde(default)]
    pub grant_id: Option<Uuid>,
    pub token: String,
    #[serde(default)]
    pub token_ttl_seconds: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UpdateApplicationReplica {
    pub grant_id: Uuid,
    pub mode: SyncReplicaMode,
    #[serde(default)]
    pub allowed_types: Vec<String>,
    #[serde(default)]
    pub contract_scope: Vec<CollectionContractDescriptor>,
    #[serde(default)]
    pub full_collection: bool,
    pub allowed_operations: Vec<String>,
    #[serde(default)]
    pub file_capability: Option<FileCapability>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReplicaPurpose {
    #[default]
    Mirror,
    Application,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProviderCollection {
    pub id: Uuid,
    pub display_name: String,
    pub spec_version: String,
    pub resource_revision: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProviderCollectionUsage {
    pub collection_id: Uuid,
    pub record_count: u64,
    pub content_bytes: u64,
    pub max_records: u64,
    pub max_content_bytes: u64,
    pub max_document_bytes: u64,
    pub file_count: u64,
    pub file_bytes: u64,
    pub stored_file_bytes: u64,
    pub max_files: u64,
    pub max_file_bytes: u64,
    pub max_stored_file_bytes: u64,
    pub max_single_file_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProviderReplicaStatus {
    pub id: Uuid,
    pub head: u64,
    pub acknowledged_sequence: u64,
    pub last_seen_at: Option<DateTime<Utc>>,
    pub token_expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PrepareAuthorityTransfer {
    pub transfer_id: Uuid,
    pub replica_id: Uuid,
    #[serde(default = "default_authority_transfer_ttl")]
    pub ttl_seconds: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProviderAuthorityTransfer {
    pub id: Uuid,
    pub collection_id: Uuid,
    pub replica_id: Uuid,
    pub final_head: u64,
    pub authority_epoch: u64,
    pub manifest_digest: String,
    pub state: ProviderAuthorityTransferState,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PrepareAuthorityImport {
    pub transfer_id: Uuid,
    pub collection_id: Uuid,
    pub account_id: Uuid,
    pub display_name: String,
    pub token: String,
    pub authority_epoch: u64,
    #[serde(default = "default_authority_transfer_ttl")]
    pub ttl_seconds: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProviderAuthorityImport {
    pub id: Uuid,
    pub collection_id: Uuid,
    pub authority_epoch: u64,
    pub state: ProviderAuthorityImportState,
    pub manifest_digest: Option<String>,
    pub source_revision: Option<String>,
    pub source_head: Option<u64>,
    #[serde(default)]
    pub contracts: Vec<CollectionContractDescriptor>,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
struct Replica {
    id: Uuid,
    purpose: ReplicaPurpose,
    mode: SyncReplicaMode,
    allowed_types: Vec<String>,
    contract_scope: Vec<CollectionContractDescriptor>,
    full_collection: bool,
    allowed_operations: Vec<String>,
    file_capability: Option<FileCapability>,
    allowed_origin: Option<String>,
    proof_public_key: Option<String>,
    grant_id: Option<Uuid>,
    scope_epoch: u64,
}

#[derive(Debug, Clone)]
pub struct AuthorityRequestProof {
    pub version: u32,
    pub timestamp: i64,
    pub nonce: Uuid,
    pub signature: String,
    pub method: String,
    pub target: String,
    pub body: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedRecord {
    record: SyncRecord,
    document: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PreparedRecordOperation {
    mutation: SyncMutation,
    previous_path: Option<String>,
    include_document: bool,
}

enum StoredRecordOperation {
    Prepared(PreparedRecordOperation),
    Completed(Value),
}

struct CachedCollection {
    head: Option<u64>,
    workspace: WorkingSet,
    records: BTreeMap<Uuid, PersistedRecord>,
    query_cache: HashMap<[u8; 32], OperationResult>,
    query_order: VecDeque<[u8; 32]>,
}

pub fn validate_limit(limit: Option<u32>) -> ApiResult<u32> {
    let limit = limit.unwrap_or(200);
    if limit == 0 || limit > 500 {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_limit",
            "Change page limit must be between 1 and 500.",
        ));
    }
    Ok(limit)
}

fn validate_contract_setup_targets(
    setup_contracts: &BTreeSet<(String, String)>,
    missing_contracts: &BTreeSet<(String, String)>,
) -> ApiResult<()> {
    if setup_contracts
        .iter()
        .any(|contract| !missing_contracts.contains(contract))
    {
        return Err(ApiError::bad_request(
            "invalid_contract_setup",
            "Contract setup may only configure missing contracts.",
        ));
    }
    Ok(())
}

pub(crate) fn hosted_migrator() -> sqlx::migrate::Migrator {
    let mut migrator = sqlx::migrate!("./migrations");
    migrator.set_ignore_missing(true);
    migrator
}

#[cfg(test)]
mod tests;
