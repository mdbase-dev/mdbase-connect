use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::{
    atomic::{AtomicU64, Ordering as AtomicOrdering},
    Arc,
};
use std::time::{Duration, Instant};

use axum::http::StatusCode;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{DateTime, SecondsFormat, Utc};
use hmac::{Hmac, Mac};
use mdbase::{
    runtime::HostedDefinitionOperation,
    v03::{Diagnostic, OperationResult},
};
use mdbase_connect_protocol::{
    authority_file_hash, authority_manifest_digest as snapshot_manifest_digest,
    ApplicationCollectionSetupProvisions, ApplicationCollectionSetupRequirements,
    ApplicationProvisions, ApplicationRequirements, ApplyCollectionSetupInput, ApplyTypePackInput,
    AssessCollectionSetupInput, AssessTypePackInput, AuthorityImportManifest,
    AuthorityImportRecord, AuthorityImportRecordPage, AuthoritySnapshotRecord, CollaborationAccess,
    CollectionChange, CollectionChangesPage, CollectionContractDescriptor,
    CollectionContractImplementationDescriptor, CollectionDescription, CollectionTypeDescriptor,
    ContractRequirement, ContractSetupChoice, ContractSetupMode, FileAction, FileCapability,
    FileScope, GrantSummary, ReplicaCollaborationCapability, SyncChange, SyncChangesPage,
    SyncCollectionResources, SyncConflict, SyncFileSnapshotPage, SyncFileSnapshotPageKind,
    SyncMutation, SyncMutationError, SyncMutationOperation, SyncMutationReceipt, SyncRecord,
    SyncReplicaMode, SyncResourceDocument, SyncSession, SyncSnapshotPage, SyncSnapshotRecord,
    TypePackProvision, AUTHORITY_PROOF_DOMAIN, AUTHORITY_PROOF_VERSION, CONTROL_PROTOCOL_VERSION,
    FILE_PROTOCOL_VERSION, MAX_COLLABORATION_PAYLOAD_BYTES,
    SUPPORTED_OPERATION_TRANSPORT_PROTOCOL_VERSIONS, SYNC_PROTOCOL_VERSION,
};
use mdbase_connect_runtime::contract_scope::{ContractScope, ContractSelector};
use p256::ecdsa::{signature::Verifier, Signature, VerifyingKey};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{
    postgres::{PgPoolOptions, PgRow},
    Acquire, AssertSqlSafe, PgPool, Postgres, QueryBuilder, Row, Transaction,
};
use subtle::ConstantTimeEq;
use tokio::sync::{oneshot, Mutex, OwnedSemaphorePermit, RwLock, Semaphore};
use uuid::Uuid;

use crate::{
    backup_admin::lock_blob_deletion,
    blob_store::BlobStore,
    crypto::ProviderCrypto,
    error::{ApiError, ApiResult},
    notifications::{HostedNotificationConfig, HostedNotificationRuntime},
    template,
    workspace::{
        engine_collection_setup, engine_contract_setup, engine_type_pack_provision,
        AuthorityWorkspace, StoredDocument,
    },
};

mod account_quotas;
mod admission;
mod authority_import_cleanup;
mod authority_import_files;
mod authority_import_prepare;
mod authority_imports;
mod authority_snapshots;
mod authority_transfers;
mod capabilities;
pub(crate) mod collaboration;
mod collections;
mod compaction;
mod crypto_state;
mod diagnostics;
mod file_policy;
mod files;
mod lifecycle;
pub use lifecycle::run_hosted_cutover_migrations;
mod lifecycle_states;
mod mutation_journal;
pub use mutation_journal::HostedMutationJournalDiagnostics;
mod mutation_journal_files;
mod mutation_journal_migration;
mod mutation_metrics;
mod mutation_receipt;
mod mutations;
mod operation_context;
mod operation_dispatch;
mod operation_input;
mod operation_queries;
mod operation_reads;
mod operation_records;
mod operation_resource_mutations;
mod operation_types;
mod operation_validation;
mod persistence;
mod policy;
mod projections;
mod protocol_usage;
mod provider_state;
mod replicas;
mod snapshot_leases;
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
use operation_input::*;
use persistence::*;
use policy::*;
pub use projections::{
    HostedProjectionBatch, HostedProjectionGeneration, HostedProjectionIndexPlan,
    HostedProjectionIndexPlanEntry, HostedProjectionStatus, HostedProjectionVerification,
};

const SNAPSHOT_PAGE_SIZE: i64 = 200;
const DATABASE_STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
const DATABASE_CONNECTION_BUDGET: u32 = 20;
const QUERY_POOL_CONNECTIONS: u32 = 2;
const PRIMARY_POOL_CONNECTIONS: u32 = DATABASE_CONNECTION_BUDGET - QUERY_POOL_CONNECTIONS;
const DATABASE_ACQUIRE_TIMEOUT: Duration = Duration::from_secs(5);
const KEY_READINESS_SUCCESS_TTL: Duration = Duration::from_secs(60);
const KEY_READINESS_FAILURE_TTL: Duration = Duration::from_secs(5);
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CollaborationLimits {
    pub max_update_bytes: u64,
    pub max_snapshot_bytes: u64,
    pub max_document_bytes: u64,
    pub max_retained_updates: u64,
    pub max_retained_update_bytes: u64,
    pub ticket_ttl_seconds: u64,
    pub compaction_threshold: u64,
}

impl Default for CollaborationLimits {
    fn default() -> Self {
        Self {
            max_update_bytes: MAX_COLLABORATION_PAYLOAD_BYTES as u64,
            max_snapshot_bytes: 4_194_304,
            max_document_bytes: 2_097_152,
            max_retained_updates: 10_000,
            max_retained_update_bytes: 67_108_864,
            ticket_ttl_seconds: 30,
            compaction_threshold: 100,
        }
    }
}

impl CollaborationLimits {
    pub fn validate(self) -> Result<Self, &'static str> {
        if self.max_update_bytes == 0
            || self.max_snapshot_bytes == 0
            || self.max_document_bytes == 0
            || self.max_retained_updates == 0
            || self.max_retained_update_bytes == 0
            || self.ticket_ttl_seconds == 0
            || self.compaction_threshold == 0
        {
            return Err("hosted collaboration limits must be greater than zero");
        }
        if self.max_update_bytes > MAX_COLLABORATION_PAYLOAD_BYTES as u64
            || self.max_snapshot_bytes < self.max_document_bytes
            || self.compaction_threshold > self.max_retained_updates
        {
            return Err("hosted collaboration limits are inconsistent");
        }
        Ok(self)
    }
}

#[derive(Debug, Clone)]
pub struct ProviderLimits {
    pub hosted_collaboration_enabled: bool,
    pub max_records_per_collection: u64,
    pub max_bytes_per_collection: u64,
    pub max_bytes_per_document: u64,
    pub max_mirror_replicas_per_collection: u64,
    pub max_application_replicas_per_collection: u64,
    pub max_files_per_collection: u64,
    pub max_file_bytes_per_collection: u64,
    pub max_stored_file_bytes_per_collection: u64,
    pub max_bytes_per_file: u64,
    /// Provider-owned collaboration ceilings; these are not control-plane entitlements.
    pub max_collaboration_bytes_per_collection: u64,
    pub max_collaboration_bytes_per_account: u64,
    pub collaboration: CollaborationLimits,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
pub struct ProviderAccountLimits {
    pub hosted_storage_bytes: u64,
    pub retained_file_bytes: u64,
    pub max_document_bytes: u64,
    pub max_single_file_bytes: u64,
    pub max_mirror_replicas_per_collection: u64,
    pub max_application_replicas_per_collection: u64,
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
    pub live_collaboration_bytes: u64,
    pub max_collaboration_bytes: u64,
    #[serde(flatten)]
    pub limits: ProviderAccountLimits,
}

impl Default for ProviderLimits {
    fn default() -> Self {
        Self {
            hosted_collaboration_enabled: false,
            max_records_per_collection: 100_000,
            max_bytes_per_collection: 1024 * 1024 * 1024,
            max_bytes_per_document: 2 * 1024 * 1024,
            max_mirror_replicas_per_collection: 100,
            max_application_replicas_per_collection: 100,
            max_files_per_collection: 10_000,
            max_file_bytes_per_collection: 5 * 1024 * 1024 * 1024,
            max_stored_file_bytes_per_collection: 10 * 1024 * 1024 * 1024,
            max_bytes_per_file: 1024 * 1024 * 1024,
            max_collaboration_bytes_per_collection: 256 * 1024 * 1024,
            max_collaboration_bytes_per_account: 2 * 1024 * 1024 * 1024,
            collaboration: CollaborationLimits::default(),
        }
    }
}

#[derive(Clone)]
pub struct HostedProvider {
    pool: PgPool,
    /// Retained solely to build the dedicated collaboration wake listener
    /// lane; never logged or serialized.
    database_url: String,
    /// Dedicated bounded lane for collection-scale SQL. Point reads and
    /// mutations retain the primary pool even while every scan slot is busy.
    query_pool: PgPool,
    query_cancellation_pool: PgPool,
    process_epoch: Uuid,
    crypto: ProviderCrypto,
    key_readiness: Arc<Mutex<KeyReadinessState>>,
    limits: ProviderLimits,
    notifications: Option<HostedNotificationRuntime>,
    notification_recovery_guard: Arc<Mutex<()>>,
    notification_recovery: Arc<RwLock<NotificationRecoveryStatus>>,
    projection_recovery_guard: Arc<Mutex<()>>,
    blob_store: Arc<dyn BlobStore>,
    query_activity: Arc<HostedQueryActivityCounters>,
    query_scan_permits: Arc<Semaphore>,
    query_memory_permits: Arc<Semaphore>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub struct HostedQueryActivity {
    pub active_queries: u64,
    pub plaintext_scopes: u64,
    pub active_scan_permits: u64,
    pub accounted_execution_bytes: u64,
    pub query_pool_connections: u64,
    pub query_pool_idle_connections: u64,
}

#[derive(Default)]
struct HostedQueryActivityCounters {
    active_queries: AtomicU64,
    plaintext_scopes: AtomicU64,
    active_scan_permits: AtomicU64,
    accounted_execution_bytes: AtomicU64,
}

/// Point-in-time operational state, in one authenticated request.
///
/// This is deliberately reachable while admission is fenced: an operator needs
/// it most when the provider is refusing ordinary traffic. Every section is
/// aggregate-and-identifier only -- no record content, frontmatter, body prose
/// or key material -- because a surface that answers questions about a specific
/// user's data while fenced is a target rather than a tool.
///
/// Each section is independently fallible. A section that times out or errors
/// is reported as such rather than failing the whole response: a diagnostics
/// endpoint that blocks on an unhealthy database is useless exactly when it is
/// needed.
#[derive(Debug, Clone, Serialize)]
pub struct HostedDiagnostics {
    pub schema_version: u32,
    pub provider_version: &'static str,
    pub query_activity: HostedQueryActivity,
    pub projection_readiness: DiagnosticSection<ProjectionReadinessDiagnostic>,
    pub projection_progress: DiagnosticSection<Vec<ProjectionProgressDiagnostic>>,
    pub drain_state: DiagnosticSection<DrainStateDiagnostic>,
    pub migration_ledger: DiagnosticSection<MigrationLedgerDiagnostic>,
    pub storage: DiagnosticSection<StorageDiagnostic>,
    pub recent_resource_changes: DiagnosticSection<Vec<ResourceChangeDiagnostic>>,
}

/// A section that resolved, or the reason it did not. Keeping the failure in
/// the payload rather than in the status code is what lets one slow section
/// coexist with six useful ones.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum DiagnosticSection<T> {
    Ok { value: T },
    Unavailable { reason: String },
}

impl<T> DiagnosticSection<T> {
    pub fn from_result<E: std::fmt::Display>(result: Result<T, E>) -> Self {
        match result {
            Ok(value) => Self::Ok { value },
            // The reason is a short classification, never a raw database error:
            // those can echo query text and identifiers.
            Err(error) => Self::Unavailable {
                reason: error.to_string(),
            },
        }
    }
}

/// Why active collections are unready, counted per cause. A collection can fail
/// several conditions at once, so these overlap and do not sum to `unready`.
#[derive(Debug, Clone, Copy, Serialize, Default)]
pub struct ProjectionReadinessDiagnostic {
    pub active_collections: u64,
    pub unready: u64,
    pub missing_generation: u64,
    pub generation_incomplete: u64,
    pub head_mismatch: u64,
    pub source_head_ahead: u64,
    pub resource_revision_stale: u64,
    pub catalog_stale: u64,
    pub format_version_mismatch: u64,
    pub engine_version_mismatch: u64,
    pub integrity_unverified: u64,
}

/// Durable checkpoint position for one generation. Recorded because the
/// executor can report zero advance while checkpoints are committed, leaving a
/// recovery unable to state remaining work.
#[derive(Debug, Clone, Serialize)]
pub struct ProjectionProgressDiagnostic {
    pub collection_id: Uuid,
    pub generation_id: Uuid,
    pub status: String,
    pub phase: String,
    pub expected_records: i64,
    pub projected_records: i64,
    pub resolved_records: i64,
    pub lease_held: bool,
    pub lease_live: bool,
    pub last_error_code: Option<String>,
    pub seconds_since_progress: Option<i64>,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct DrainStateDiagnostic {
    pub other_sessions: i64,
    pub query_pool_connections: u64,
    pub query_pool_idle_connections: u64,
    pub active_scan_permits: u64,
    pub plaintext_scopes: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct MigrationLedgerDiagnostic {
    pub applied_migrations: i64,
    pub latest_version: Option<i64>,
    pub expected_projection_format_version: i64,
    pub expected_semantic_engine_version: &'static str,
}

/// Storage configuration and, most importantly, when its credential dies.
/// Derived R2 credentials carry a signed `exp` claim that a long-lived parent
/// does not override, so an environment stops serving without warning.
#[derive(Debug, Clone, Serialize)]
pub struct StorageDiagnostic {
    pub bucket: String,
    pub credential_expires_at: Option<DateTime<Utc>>,
    pub credential_expires_in_seconds: Option<i64>,
}

/// Recent resource mutations. A resource revision advancing is what stranded a
/// projection binding twice on 2026-08-18; seeing the change is the difference
/// between diagnosing that in seconds and reading mutation code.
#[derive(Debug, Clone, Serialize)]
pub struct ResourceChangeDiagnostic {
    pub collection_id: Uuid,
    pub sequence: i64,
    pub resource_kind: String,
    pub path: String,
    pub revision: String,
}

struct HostedQueryActivityGuard {
    counters: Arc<HostedQueryActivityCounters>,
    plaintext: bool,
}

struct HostedScanPermitGuard {
    _permit: OwnedSemaphorePermit,
    counters: Arc<HostedQueryActivityCounters>,
}

struct HostedExecutionMemoryGuard {
    _permit: OwnedSemaphorePermit,
    counters: Arc<HostedQueryActivityCounters>,
    bytes: u64,
}

struct PostgresQueryCancellationGuard {
    pool: PgPool,
    backend_pid: i32,
    session_fence: String,
    armed: bool,
    cleanup_complete: Option<oneshot::Sender<bool>>,
}

impl PostgresQueryCancellationGuard {
    fn new(
        pool: PgPool,
        backend_pid: i32,
        session_fence: String,
        cleanup_complete: Option<oneshot::Sender<bool>>,
    ) -> Self {
        Self {
            pool,
            backend_pid,
            session_fence,
            armed: true,
            cleanup_complete,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
        self.cleanup_complete.take();
    }
}

impl Drop for PostgresQueryCancellationGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let pool = self.pool.clone();
        let backend_pid = self.backend_pid;
        let session_fence = self.session_fence.clone();
        let cleanup_complete = self.cleanup_complete.take();
        tokio::spawn(async move {
            let cancelled = tokio::time::timeout(
                Duration::from_secs(2),
                sqlx::query_scalar::<_, bool>(
                    r#"SELECT pg_cancel_backend(pid)
                       FROM pg_stat_activity
                       WHERE pid = $1 AND application_name = $2"#,
                )
                .bind(backend_pid)
                .bind(&session_fence)
                .fetch_optional(&pool),
            )
            .await;
            let cancel_sent = matches!(cancelled, Ok(Ok(Some(true))));
            let session_already_released = matches!(cancelled, Ok(Ok(None)));
            if !cancel_sent && !session_already_released {
                tracing::warn!(
                    target: "mdbase_connect::metrics",
                    metric = "hosted_query_cancel_failed",
                    "privacy-safe hosted provider metric"
                );
            }
            let cleanup_deadline = Instant::now().checked_add(Duration::from_secs(5));
            let cleaned = loop {
                let still_present = sqlx::query_scalar::<_, bool>(
                    "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND application_name = $2)",
                )
                .bind(backend_pid)
                .bind(&session_fence)
                .fetch_one(&pool)
                .await;
                if matches!(still_present, Ok(false)) {
                    break true;
                }
                if cleanup_deadline.is_some_and(|deadline| Instant::now() >= deadline) {
                    break false;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            };
            if let Some(cleanup_complete) = cleanup_complete {
                let _ = cleanup_complete.send(cleaned);
            }
        });
    }
}

impl HostedQueryActivityGuard {
    fn begin(counters: Arc<HostedQueryActivityCounters>) -> Self {
        counters
            .active_queries
            .fetch_add(1, AtomicOrdering::Relaxed);
        Self {
            counters,
            plaintext: false,
        }
    }

    fn acquire_plaintext(&mut self) {
        if !self.plaintext {
            self.counters
                .plaintext_scopes
                .fetch_add(1, AtomicOrdering::Relaxed);
            self.plaintext = true;
        }
    }
}

impl Drop for HostedQueryActivityGuard {
    fn drop(&mut self) {
        if self.plaintext {
            self.counters
                .plaintext_scopes
                .fetch_sub(1, AtomicOrdering::Relaxed);
        }
        self.counters
            .active_queries
            .fetch_sub(1, AtomicOrdering::Relaxed);
    }
}

impl HostedScanPermitGuard {
    fn new(permit: OwnedSemaphorePermit, counters: Arc<HostedQueryActivityCounters>) -> Self {
        counters
            .active_scan_permits
            .fetch_add(1, AtomicOrdering::Relaxed);
        Self {
            _permit: permit,
            counters,
        }
    }
}

impl Drop for HostedScanPermitGuard {
    fn drop(&mut self) {
        self.counters
            .active_scan_permits
            .fetch_sub(1, AtomicOrdering::Relaxed);
    }
}

impl HostedExecutionMemoryGuard {
    fn new(
        permit: OwnedSemaphorePermit,
        counters: Arc<HostedQueryActivityCounters>,
        bytes: u64,
    ) -> Self {
        counters
            .accounted_execution_bytes
            .fetch_add(bytes, AtomicOrdering::Relaxed);
        Self {
            _permit: permit,
            counters,
            bytes,
        }
    }
}

impl Drop for HostedExecutionMemoryGuard {
    fn drop(&mut self) {
        self.counters
            .accounted_execution_bytes
            .fetch_sub(self.bytes, AtomicOrdering::Relaxed);
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct NotificationRecoveryStatus {
    pub configured: bool,
    pub recovery: NotificationRecoveryState,
    pub consecutive_failures: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_success_at: Option<DateTime<Utc>>,
}

/// Process readiness. Collections whose semantic projection is absent or bound
/// to a superseded catalog/resource revision are reported as degraded, never as
/// a process failure: the query path already serves them from bounded canonical
/// exact fallback, and failing the probe would remove a provider that is still
/// serving every collection correctly.
#[derive(Debug, Clone, Serialize)]
pub struct HostedReadinessStatus {
    pub notifications: NotificationRecoveryStatus,
    pub projections: HostedProjectionReadiness,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct HostedProjectionReadiness {
    /// Active collections currently served from canonical exact fallback while
    /// their projection generation is absent, superseded, or rebuilding.
    pub degraded_collections: u64,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NotificationRecoveryState {
    Disabled,
    Pending,
    Ok,
    Degraded,
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
    pub operation_transport_protocol: Option<u32>,
    #[serde(default)]
    pub operation_transport_recovery_protocols: Vec<u32>,
    #[serde(default)]
    pub file_capability: Option<FileCapability>,
    #[serde(default)]
    pub collaboration_capability: Option<ReplicaCollaborationCapability>,
    #[serde(default)]
    pub allowed_origin: Option<String>,
    #[serde(default)]
    pub proof_public_key: Option<String>,
    #[serde(default)]
    pub grant_id: Option<Uuid>,
    #[serde(default)]
    pub application_declaration_id: Option<String>,
    #[serde(default)]
    pub application_declaration_digest: Option<String>,
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
    pub operation_transport_protocol: u32,
    #[serde(default)]
    pub operation_transport_recovery_protocols: Vec<u32>,
    #[serde(default)]
    pub file_capability: Option<FileCapability>,
    #[serde(default)]
    pub collaboration_capability: Option<ReplicaCollaborationCapability>,
    #[serde(default)]
    pub allowed_origin: Option<String>,
    #[serde(default)]
    pub proof_public_key: Option<String>,
    pub application_declaration_id: String,
    pub application_declaration_digest: String,
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
    operation_transport_protocol: Option<u32>,
    operation_transport_recovery_protocols: Vec<u32>,
    file_capability: Option<FileCapability>,
    // Read by the Phase 3 room authorizer; persisted and validated in Phase 2.
    #[allow(dead_code)]
    collaboration_capability: Option<ReplicaCollaborationCapability>,
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

#[derive(Debug, Clone)]
pub struct AuthorizedRequest {
    operation_transport_protocol: Option<u32>,
    operation_transport_recovery_protocols: Vec<u32>,
}

impl AuthorizedRequest {
    pub fn permits_operation_transport(&self, version: u32, recovery_only: bool) -> bool {
        self.operation_transport_protocol.is_none()
            && SUPPORTED_OPERATION_TRANSPORT_PROTOCOL_VERSIONS.contains(&version)
            || self.operation_transport_protocol == Some(version)
            || (recovery_only
                && self
                    .operation_transport_recovery_protocols
                    .contains(&version))
    }
}

type PersistedRecord = SyncRecord;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PreparedRecordOperation {
    mutation: SyncMutation,
    semantic_operation: String,
    semantic_input: serde_json::Map<String, Value>,
    previous_path: Option<String>,
    include_document: bool,
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
    setup_contracts: &BTreeSet<(String, String, String)>,
    missing_contracts: &BTreeSet<(String, String, String)>,
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

fn type_pack_provision_error(result: &OperationResult) -> ApiError {
    let detail = result
        .diagnostics
        .first()
        .map(|diagnostic| diagnostic.message.as_str())
        .or_else(|| {
            result.result["resources"]
                .as_array()
                .and_then(|resources| {
                    resources
                        .iter()
                        .find(|resource| resource["action"] == "conflict")
                })
                .and_then(|resource| resource["reason"].as_str())
        })
        .unwrap_or("the type pack requires review");
    ApiError::conflict(
        "type_pack_review_required",
        format!("The collection definitions need review before they can be updated: {detail}"),
    )
    .with_details(json!({ "assessment": result.result }))
}

fn type_pack_envelope_error(envelope: &Value) -> ApiError {
    let detail = envelope
        .pointer("/diagnostics/0/message")
        .or_else(|| envelope.pointer("/result/resources/0/reason"))
        .and_then(Value::as_str)
        .unwrap_or("the type pack was rejected");
    ApiError::conflict(
        "type_pack_provision_failed",
        format!("The collection definitions could not be updated: {detail}"),
    )
    .with_details(envelope.clone())
}

pub(crate) fn hosted_migrator() -> sqlx::migrate::Migrator {
    let mut migrator = sqlx::migrate!("./migrations");
    migrator.set_ignore_missing(true);
    migrator
}

#[cfg(test)]
mod tests;
