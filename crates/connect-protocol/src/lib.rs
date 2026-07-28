use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use uuid::Uuid;

pub mod crypto;

pub const CONTROL_PROTOCOL_VERSION: u32 = 1;
pub const LOCAL_CONTROL_PROTOCOL_VERSION: u32 = 1;
pub const ENCRYPTED_RELAY_PROTOCOL_VERSION: u32 = 1;
pub const LOOPBACK_PROTOCOL_VERSION: u32 = 1;
pub const DEFAULT_LOOPBACK_PORT: u16 = 28_485;
pub const SYNC_PROTOCOL_VERSION: u32 = 1;
pub const RELAY_ENCRYPTION_SUITE: &str = "P256-HKDF-SHA256-AES256GCM";
pub const AUTHORITY_PROOF_VERSION: u32 = 1;
pub const AUTHORITY_PROOF_ALGORITHM: &str = "P256-SHA256";
pub const AUTHORITY_PROOF_DOMAIN: &str = "mdbase-authority-request-proof-v1";
pub const AUTHORITY_PROOF_VERSION_HEADER: &str = "x-mdbase-proof-version";
pub const AUTHORITY_PROOF_TIMESTAMP_HEADER: &str = "x-mdbase-proof-timestamp";
pub const AUTHORITY_PROOF_NONCE_HEADER: &str = "x-mdbase-proof-nonce";
pub const AUTHORITY_PROOF_SIGNATURE_HEADER: &str = "x-mdbase-proof-signature";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ControlRequest {
    pub id: Uuid,
    pub protocol_version: u32,
    #[serde(flatten)]
    pub command: ControlCommand,
}

impl ControlRequest {
    pub fn new(command: ControlCommand) -> Self {
        Self {
            id: Uuid::new_v4(),
            protocol_version: LOCAL_CONTROL_PROTOCOL_VERSION,
            command,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "method", content = "params")]
pub enum ControlCommand {
    #[serde(rename = "ping")]
    Ping,
    #[serde(rename = "status")]
    Status,
    #[serde(rename = "daemon.shutdown")]
    DaemonShutdown,
    #[serde(rename = "collections.list")]
    CollectionList,
    #[serde(rename = "collections.add")]
    CollectionAdd(CollectionPathParams),
    #[serde(rename = "collections.add-copy")]
    CollectionAddCopy(CollectionPathParams),
    #[serde(rename = "collections.make-independent")]
    CollectionMakeIndependent(CollectionIdParams),
    #[serde(rename = "collections.take-authority")]
    CollectionTakeAuthority(CollectionIdParams),
    #[serde(rename = "collections.transfer-authority")]
    CollectionTransferAuthority(CollectionAuthorityTransferParams),
    #[serde(rename = "collections.create")]
    CollectionCreate(CollectionCreateParams),
    #[serde(rename = "collections.update-metadata")]
    CollectionUpdateMetadata(CollectionMetadataParams),
    #[serde(rename = "collections.set-enabled")]
    CollectionSetEnabled(CollectionEnabledParams),
    #[serde(rename = "collections.remove")]
    CollectionRemove(CollectionIdParams),
    #[serde(rename = "collections.validate")]
    CollectionValidate(CollectionIdParams),
    #[serde(rename = "collections.operation")]
    CollectionOperation(CollectionOperationParams),
    #[serde(rename = "access.snapshot")]
    AccessSnapshot,
    #[serde(rename = "access.pause")]
    AccessPause(AccessPauseParams),
    #[serde(rename = "account.rename-computer")]
    AccountRenameComputer(ComputerNameParams),
    #[serde(rename = "account.configure")]
    AccountConfigure(AccountConfigureParams),
    #[serde(rename = "account.configuration")]
    AccountConfiguration,
    #[serde(rename = "account.clear")]
    AccountClear,
    #[serde(rename = "grants.create")]
    GrantCreate(GrantCreateParams),
    #[serde(rename = "grants.update")]
    GrantUpdate(GrantUpdateParams),
    #[serde(rename = "grants.revoke")]
    GrantRevoke(GrantIdParams),
    #[serde(rename = "authorizations.approve")]
    AuthorizationApprove(AuthorizationApproveParams),
    #[serde(rename = "authorizations.deny")]
    AuthorizationDeny(AuthorizationIdParams),
    #[serde(rename = "activity.list")]
    ActivityList(ActivityListParams),
    #[serde(rename = "hosted.snapshot")]
    HostedSnapshot,
    #[serde(rename = "hosted.collections.create")]
    HostedCollectionCreate(HostedCollectionCreateParams),
    #[serde(rename = "hosted.collections.rename")]
    HostedCollectionRename(HostedCollectionRenameParams),
    #[serde(rename = "hosted.collections.delete")]
    HostedCollectionDelete(CollectionIdParams),
    #[serde(rename = "hosted.authorizations.approve")]
    HostedAuthorizationApprove(AuthorizationApproveParams),
    #[serde(rename = "hosted.grants.update")]
    HostedGrantUpdate(GrantUpdateParams),
    #[serde(rename = "hosted.grants.revoke")]
    HostedGrantRevoke(GrantIdParams),
    #[serde(rename = "hosted.replicas.revoke")]
    HostedReplicaRevoke(MirrorIdParams),
    #[serde(rename = "mirrors.list")]
    MirrorList,
    #[serde(rename = "mirrors.add")]
    MirrorAdd(MirrorAddParams),
    #[serde(rename = "mirrors.sync")]
    MirrorSync(MirrorIdParams),
    #[serde(rename = "mirrors.remove")]
    MirrorRemove(MirrorIdParams),
    #[serde(rename = "mirrors.resolve")]
    MirrorResolve(MirrorResolveParams),
    #[serde(rename = "mirrors.promote.begin")]
    MirrorPromoteBegin(MirrorIdParams),
    #[serde(rename = "mirrors.promote.complete")]
    MirrorPromoteComplete(MirrorIdParams),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectionPathParams {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectionCreateParams {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectionMetadataParams {
    pub collection_id: Uuid,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectionEnabledParams {
    pub collection_id: Uuid,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectionIdParams {
    pub collection_id: Uuid,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectionAuthorityTransferParams {
    pub collection_id: Uuid,
    pub target: AuthorityTarget,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthorityTarget {
    Remote,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectionOperationParams {
    pub collection_id: Uuid,
    pub operation: String,
    #[serde(default)]
    pub input: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccessPauseParams {
    pub paused: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComputerNameParams {
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountConfigureParams {
    pub server_url: String,
    pub connector_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostedCollectionCreateParams {
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostedCollectionRenameParams {
    pub collection_id: Uuid,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GrantCreateParams {
    pub application_id: Uuid,
    pub collection_id: Uuid,
    pub operations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GrantUpdateParams {
    pub grant_id: Uuid,
    pub operations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GrantIdParams {
    pub grant_id: Uuid,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthorizationApproveParams {
    pub request_id: Uuid,
    pub collection_id: Uuid,
    pub operations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthorizationIdParams {
    pub request_id: Uuid,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActivityListParams {
    #[serde(default = "default_activity_limit")]
    pub limit: usize,
}

fn default_activity_limit() -> usize {
    100
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MirrorAddParams {
    pub collection_id: Uuid,
    pub path: String,
    pub mode: SyncReplicaMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MirrorIdParams {
    pub replica_id: Uuid,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MirrorResolveParams {
    pub replica_id: Uuid,
    pub record_id: Uuid,
    pub resolution: MirrorResolution,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MirrorResolution {
    Local,
    Remote,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ControlResponse {
    pub id: Uuid,
    pub protocol_version: u32,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ControlError>,
}

impl ControlResponse {
    pub fn success(id: Uuid, result: impl Serialize) -> Self {
        match serde_json::to_value(result) {
            Ok(result) => Self {
                id,
                protocol_version: LOCAL_CONTROL_PROTOCOL_VERSION,
                ok: true,
                result: Some(result),
                error: None,
            },
            Err(error) => Self::failure(id, "serialization_failed", error.to_string()),
        }
    }

    pub fn failure(id: Uuid, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            id,
            protocol_version: LOCAL_CONTROL_PROTOCOL_VERSION,
            ok: false,
            result: None,
            error: Some(ControlError {
                code: code.into(),
                message: message.into(),
                details: None,
            }),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ControlError {
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentStatus {
    pub protocol_version: u32,
    #[serde(default)]
    pub binary_version: String,
    pub state: AgentConnectionState,
    pub registered_collections: usize,
    pub paused: bool,
    #[serde(default)]
    pub direct_access_available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loopback_port: Option<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentConnectionState {
    LocalOnly,
    Connecting,
    Connected,
    Offline,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectionSummary {
    pub id: Uuid,
    pub display_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub path: String,
    pub spec_version: String,
    pub enabled: bool,
    #[serde(default)]
    pub contracts: Vec<CollectionContractDescriptor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectionTypeDescriptor {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub definition: Option<Value>,
    pub schema: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collection: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lifecycle: Option<Value>,
    pub extensions: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CollectionContractDescriptor {
    pub contract_type: String,
    pub id: String,
    pub version: String,
    pub digest: String,
    pub schema: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binding_schema: Option<Value>,
    pub implementations: Vec<CollectionContractImplementationDescriptor>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CollectionContractImplementationDescriptor {
    pub type_name: String,
    pub type_version: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub type_path: Option<String>,
    pub digest: String,
    pub fields: std::collections::BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binding: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectionDescription {
    pub protocol_version: u32,
    pub collection_id: Uuid,
    pub display_name: String,
    pub spec_version: String,
    pub operations: Vec<String>,
    pub change_cursor: u64,
    pub types: Vec<CollectionTypeDescriptor>,
    pub contracts: Vec<CollectionContractDescriptor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub configuration: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectionChange {
    pub cursor: u64,
    #[serde(rename = "type")]
    pub event_type: String,
    pub occurred_at: String,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectionChangesPage {
    pub events: Vec<CollectionChange>,
    pub cursor: u64,
    pub has_more: bool,
    pub reset: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SyncRecord {
    pub record_id: Uuid,
    pub path: String,
    pub revision: String,
    pub frontmatter: serde_json::Map<String, Value>,
    pub body: String,
    pub types: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncCollectionResources {
    pub revision: String,
    pub spec_version: String,
    pub types: Vec<CollectionTypeDescriptor>,
    pub contracts: Vec<CollectionContractDescriptor>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub documents: Vec<SyncResourceDocument>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncResourceDocument {
    pub path: String,
    pub kind: String,
    pub revision: String,
    pub document: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthoritySnapshotRecord {
    pub record: SyncRecord,
    pub document: String,
}

/// Complete provider-neutral materialization used to seed a new authority.
///
/// Transfer orchestration pages this value on the wire, but source and target
/// both use this canonical representation and manifest digest.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthoritySnapshot {
    pub protocol_version: u32,
    pub collection_id: Uuid,
    pub source_head: u64,
    pub source_revision: String,
    pub manifest_digest: String,
    pub resources: SyncCollectionResources,
    pub records: Vec<AuthoritySnapshotRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthorityImportManifest {
    pub protocol_version: u32,
    pub collection_id: Uuid,
    pub source_head: u64,
    pub source_revision: String,
    pub manifest_digest: String,
    pub resources: SyncCollectionResources,
    pub record_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthorityImportRecord {
    pub record_id: Uuid,
    pub path: String,
    pub document: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthorityImportRecordPage {
    pub protocol_version: u32,
    pub page: u64,
    pub records: Vec<AuthorityImportRecord>,
}

pub fn authority_manifest_digest(
    resources: &[SyncResourceDocument],
    records: &[AuthoritySnapshotRecord],
) -> String {
    let mut entries = BTreeMap::<(&str, &str), String>::new();
    for resource in resources {
        entries.insert(
            ("resource", resource.path.as_str()),
            hex_digest(&Sha256::digest(resource.document.as_bytes())),
        );
    }
    for record in records {
        entries.insert(
            ("record", record.record.path.as_str()),
            record.record.revision.clone(),
        );
    }
    let mut manifest = Sha256::new();
    manifest.update(b"mdbase-authority-manifest-v1\n");
    for ((kind, path), revision) in entries {
        manifest.update(kind.as_bytes());
        manifest.update(b"\0");
        manifest.update(path.as_bytes());
        manifest.update(b"\0");
        manifest.update(revision.as_bytes());
        manifest.update(b"\n");
    }
    hex_digest(&manifest.finalize())
}

fn hex_digest(value: &[u8]) -> String {
    value.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncReplicaMode {
    ReadOnly,
    ReadWrite,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MirrorState {
    NotInitialized,
    UpToDate,
    ChangesWaiting,
    Attention,
    Offline,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MirrorConflictSummary {
    pub record_id: Uuid,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub kind: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MirrorLocalIssue {
    pub path: String,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MirrorSummary {
    pub collection_id: Uuid,
    pub replica_id: Uuid,
    pub name: String,
    pub mode: SyncReplicaMode,
    pub path: String,
    pub state: MirrorState,
    pub pending: usize,
    #[serde(default)]
    pub conflicts: Vec<MirrorConflictSummary>,
    #[serde(default)]
    pub local_issues: Vec<MirrorLocalIssue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_synced_at: Option<String>,
    #[serde(default)]
    pub syncing: bool,
    #[serde(default)]
    pub promotion_pending: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub promotion: Option<MirrorPromotionSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MirrorPromotionSummary {
    pub phase: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncSession {
    pub protocol_version: u32,
    pub session_id: Uuid,
    pub replica_id: Uuid,
    pub collection_id: Uuid,
    pub mode: SyncReplicaMode,
    pub scope_epoch: u64,
    pub retained_after: u64,
    pub head: u64,
    pub snapshot_id: Uuid,
    pub resources: SyncCollectionResources,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncSnapshotPage {
    pub protocol_version: u32,
    pub snapshot_id: Uuid,
    pub scope_epoch: u64,
    pub cursor: u64,
    pub records: Vec<SyncRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_page: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SyncChange {
    Put {
        sequence: u64,
        record: SyncRecord,
    },
    Remove {
        sequence: u64,
        record_id: Uuid,
        previous_path: String,
        revision: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncChangesPage {
    pub protocol_version: u32,
    pub scope_epoch: u64,
    pub events: Vec<SyncChange>,
    pub cursor: u64,
    pub head: u64,
    pub has_more: bool,
    pub reset_required: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncMutationOperation {
    Create,
    Update,
    Rename,
    Delete,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SyncMutation {
    pub mutation_id: Uuid,
    pub replica_id: Uuid,
    pub scope_epoch: u64,
    pub operation: SyncMutationOperation,
    pub record_id: Uuid,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_revision: Option<String>,
    pub input: serde_json::Map<String, Value>,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub causal_predecessor: Option<Uuid>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SyncConflict {
    pub record_id: Uuid,
    pub mutation: SyncMutation,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current: Option<SyncRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_revision: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncMutationError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum SyncMutationReceipt {
    Applied {
        mutation_id: Uuid,
        sequence: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        record: Option<SyncRecord>,
    },
    PreviouslyApplied {
        mutation_id: Uuid,
        sequence: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        record: Option<SyncRecord>,
    },
    Conflicted {
        mutation_id: Uuid,
        conflict: SyncConflict,
    },
    Rejected {
        mutation_id: Uuid,
        error: SyncMutationError,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApplicationSummary {
    pub id: Uuid,
    pub name: String,
    pub homepage: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default)]
    pub requirements: ApplicationRequirements,
    #[serde(default)]
    pub provisions: ApplicationProvisions,
    #[serde(default)]
    pub notifications: ApplicationNotifications,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContractRequirement {
    pub id: String,
    pub version: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeContractRequirement {
    pub id: String,
    pub version: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApplicationRequirements {
    #[serde(default)]
    pub contracts: Vec<ContractRequirement>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access: Option<ApplicationAccess>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApplicationAccess {
    Contract,
    FullCollection,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApplicationProvisions {
    #[serde(default)]
    pub type_packs: Vec<TypePackProvision>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TypePackProvision {
    pub manifest: TypePackManifest,
    pub resources: Vec<TypePackSourceResource>,
    #[serde(default)]
    pub provides: Vec<ContractRequirement>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TypePackManifest {
    pub kind: String,
    pub id: String,
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub resources: Vec<TypePackManifestResource>,
    #[serde(flatten)]
    pub extensions: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TypePackManifestResource {
    pub kind: String,
    pub source: String,
    pub target: String,
    pub digest: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TypePackSourceResource {
    pub source: String,
    pub document: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApplicationNotifications {
    #[serde(default)]
    pub criteria: Vec<NotificationCriterion>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NotificationCriterion {
    pub id: String,
    pub event: RuntimeContractRequirement,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#if: Option<RuntimeExpression>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub debounce: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub minimum_interval: Option<String>,
    pub presentation: NotificationPresentation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeExpression {
    #[serde(rename = "$expr")]
    pub expression: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NotificationPresentation {
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GrantScope {
    #[serde(default)]
    pub contracts: Vec<CollectionContractDescriptor>,
    pub access: ApplicationAccess,
}

impl GrantScope {
    pub fn full_collection() -> Self {
        Self {
            contracts: Vec::new(),
            access: ApplicationAccess::FullCollection,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GrantSummary {
    pub id: Uuid,
    pub application_id: Uuid,
    pub application_name: String,
    #[serde(default = "default_application_distribution")]
    pub application_distribution: String,
    pub application_homepage: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub application_project_url: Option<String>,
    /// Exact browser origin authorized to use this grant over loopback.
    #[serde(default)]
    pub application_origin: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub application_icon: Option<String>,
    pub collection_id: Uuid,
    pub collection_name: String,
    pub operations: Vec<String>,
    pub scope: GrantScope,
    #[serde(default)]
    pub notification_criteria: Vec<NotificationCriterion>,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encryption: Option<GrantEncryption>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingAuthorization {
    pub id: Uuid,
    pub application_id: Uuid,
    pub application_name: String,
    #[serde(default = "default_application_distribution")]
    pub application_distribution: String,
    pub application_homepage: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub application_project_url: Option<String>,
    #[serde(default = "default_authorization_flow")]
    pub flow: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub application_icon: Option<String>,
    pub requested_operations: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collection_hint: Option<Uuid>,
    #[serde(default)]
    pub requirements: ApplicationRequirements,
    #[serde(default)]
    pub provisions: ApplicationProvisions,
    #[serde(default)]
    pub notifications: ApplicationNotifications,
    #[serde(default)]
    pub compatible_collection_ids: Vec<Uuid>,
    #[serde(default)]
    pub provisionable_collection_ids: Vec<Uuid>,
    pub expires_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectorAccount {
    pub connector_id: Uuid,
    pub connector_name: String,
    pub user_name: String,
    pub user_email: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthorityConflict {
    pub collection_id: Uuid,
    pub display_name: String,
    pub active_connector_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccessSnapshot {
    pub configured: bool,
    pub online: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<ConnectorAccount>,
    pub grants: Vec<GrantSummary>,
    pub pending_authorizations: Vec<PendingAuthorization>,
    #[serde(default)]
    pub authority_conflicts: Vec<AuthorityConflict>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActivityEntry {
    pub id: Uuid,
    pub application_id: Uuid,
    pub application_name: String,
    pub collection_id: Uuid,
    pub collection_name: String,
    pub operation: String,
    pub outcome: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GrantPolicy {
    pub id: Uuid,
    pub application_id: Uuid,
    pub collection_id: Uuid,
    pub operations: Vec<String>,
    pub scope: GrantScope,
    #[serde(default = "default_application_name")]
    pub application_name: String,
    #[serde(default = "default_application_distribution")]
    pub application_distribution: String,
    #[serde(default)]
    pub application_homepage: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub application_project_url: Option<String>,
    /// Exact browser origin authorized to use this grant over loopback.
    #[serde(default)]
    pub application_origin: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub application_icon: Option<String>,
    #[serde(default = "default_collection_name")]
    pub collection_name: String,
    #[serde(default)]
    pub notification_criteria: Vec<NotificationCriterion>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encryption: Option<GrantEncryption>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthorizationCollectionOffer {
    pub collection_id: Uuid,
    pub display_name: String,
    pub spec_version: String,
    #[serde(default)]
    pub contracts: Vec<CollectionContractDescriptor>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GrantEncryption {
    pub protocol_version: u32,
    pub suite: String,
    pub key_id: String,
    pub scope_epoch: u64,
    pub connector_id: Uuid,
    pub collection_id: Uuid,
    pub application_public_key: String,
    pub connector_public_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EncryptedRelayEnvelope {
    pub protocol_version: u32,
    pub suite: String,
    pub request_id: Uuid,
    pub grant_id: Uuid,
    pub application_id: Uuid,
    pub connector_id: Uuid,
    pub collection_id: Uuid,
    pub operation: String,
    pub scope_epoch: u64,
    pub key_id: String,
    pub counter: String,
    pub ciphertext: String,
}

fn default_application_name() -> String {
    "Application".to_string()
}

fn default_application_distribution() -> String {
    "web".to_string()
}

fn default_authorization_flow() -> String {
    "authorization_code".to_string()
}

fn default_collection_name() -> String {
    "Collection".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RelayMessage {
    PolicySnapshot {
        protocol_version: u32,
        grants: Vec<GrantPolicy>,
    },
    AuthorizationOfferRequest {
        protocol_version: u32,
        request_id: Uuid,
        authorization_id: Uuid,
    },
    AuthorizationOfferResponse {
        protocol_version: u32,
        request_id: Uuid,
        paused: bool,
        collections: Vec<AuthorizationCollectionOffer>,
    },
    AuthorizationActivationRequest {
        protocol_version: u32,
        request_id: Uuid,
        authorization_id: Uuid,
        collection_id: Uuid,
        requirements: ApplicationRequirements,
        provisions: ApplicationProvisions,
        grant: Box<GrantPolicy>,
    },
    AuthorizationActivationResponse {
        protocol_version: u32,
        request_id: Uuid,
        ok: bool,
        #[serde(default)]
        contracts: Vec<CollectionContractDescriptor>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<ControlError>,
    },
    OperationRequest {
        protocol_version: u32,
        request_id: Uuid,
        grant_id: Uuid,
        collection_id: Uuid,
        application_id: Uuid,
        operation: String,
        input: Value,
    },
    OperationResponse {
        protocol_version: u32,
        request_id: Uuid,
        ok: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<ControlError>,
    },
    EncryptedOperationRequest {
        #[serde(flatten)]
        envelope: EncryptedRelayEnvelope,
    },
    EncryptedOperationResponse {
        #[serde(flatten)]
        envelope: EncryptedRelayEnvelope,
    },
    EncryptedOperationRejected {
        protocol_version: u32,
        request_id: Uuid,
        error: ControlError,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    fn protocol_schema() -> Value {
        serde_json::from_str(include_str!(
            "../../../packages/protocol/schemas/connect-protocol.v1.schema.json"
        ))
        .unwrap()
    }

    fn assert_schema(reference: &str, value: Value) {
        let mut schema = protocol_schema();
        if !reference.is_empty() {
            let object = schema.as_object_mut().unwrap();
            object.remove("oneOf");
            object.insert("$ref".to_string(), Value::String(format!("#{reference}")));
        }
        let validator = jsonschema::JSONSchema::options()
            .with_draft(jsonschema::Draft::Draft202012)
            .compile(&schema)
            .unwrap();
        let errors = validator
            .validate(&value)
            .err()
            .map(|errors| errors.map(|error| error.to_string()).collect::<Vec<_>>())
            .unwrap_or_default();
        assert!(
            errors.is_empty(),
            "schema errors: {errors:#?}\nvalue: {value:#}"
        );
    }

    fn assert_encrypted_schema(value: Value) {
        let schema: Value = serde_json::from_str(include_str!(
            "../../../packages/protocol/schemas/encrypted-relay.v1.schema.json"
        ))
        .unwrap();
        let validator = jsonschema::JSONSchema::options()
            .with_draft(jsonschema::Draft::Draft202012)
            .compile(&schema)
            .unwrap();
        let errors = validator
            .validate(&value)
            .err()
            .map(|errors| errors.map(|error| error.to_string()).collect::<Vec<_>>())
            .unwrap_or_default();
        assert!(
            errors.is_empty(),
            "schema errors: {errors:#?}\nvalue: {value:#}"
        );
    }

    fn assert_sync_schema(reference: &str, value: Value) {
        let mut schema: Value = serde_json::from_str(include_str!(
            "../../../packages/protocol/schemas/sync.v1.schema.json"
        ))
        .unwrap();
        if !reference.is_empty() {
            let object = schema.as_object_mut().unwrap();
            object.remove("oneOf");
            object.insert("$ref".to_string(), Value::String(format!("#{reference}")));
        }
        let validator = jsonschema::JSONSchema::options()
            .with_draft(jsonschema::Draft::Draft202012)
            .compile(&schema)
            .unwrap();
        let errors = validator
            .validate(&value)
            .err()
            .map(|errors| errors.map(|error| error.to_string()).collect::<Vec<_>>())
            .unwrap_or_default();
        assert!(
            errors.is_empty(),
            "sync schema errors: {errors:#?}\nvalue: {value:#}"
        );
    }

    #[test]
    fn control_request_has_stable_wire_shape() {
        let request = ControlRequest {
            id: Uuid::nil(),
            protocol_version: LOCAL_CONTROL_PROTOCOL_VERSION,
            command: ControlCommand::CollectionList,
        };
        assert_eq!(
            serde_json::to_value(request).unwrap(),
            serde_json::json!({
                "id": "00000000-0000-0000-0000-000000000000",
                "protocol_version": 1,
                "method": "collections.list"
            })
        );
    }

    #[test]
    fn copied_collection_registration_has_an_explicit_wire_command() {
        let request = ControlRequest {
            id: Uuid::nil(),
            protocol_version: LOCAL_CONTROL_PROTOCOL_VERSION,
            command: ControlCommand::CollectionAddCopy(CollectionPathParams {
                path: "/collections/notes-copy".to_string(),
            }),
        };
        assert_eq!(
            serde_json::to_value(request).unwrap(),
            serde_json::json!({
                "id": "00000000-0000-0000-0000-000000000000",
                "protocol_version": 1,
                "method": "collections.add-copy",
                "params": { "path": "/collections/notes-copy" }
            })
        );
    }

    #[test]
    fn rust_relay_messages_match_the_canonical_wire_schema() {
        let ids = [
            Uuid::parse_str("01911111-1111-7111-8111-111111111111").unwrap(),
            Uuid::parse_str("01922222-2222-7222-8222-222222222222").unwrap(),
            Uuid::parse_str("01933333-3333-7333-8333-333333333333").unwrap(),
            Uuid::parse_str("01944444-4444-7444-8444-444444444444").unwrap(),
        ];
        for message in [
            RelayMessage::AuthorizationOfferRequest {
                protocol_version: CONTROL_PROTOCOL_VERSION,
                request_id: ids[0],
                authorization_id: ids[1],
            },
            RelayMessage::AuthorizationOfferResponse {
                protocol_version: CONTROL_PROTOCOL_VERSION,
                request_id: ids[0],
                paused: false,
                collections: vec![AuthorizationCollectionOffer {
                    collection_id: ids[2],
                    display_name: "My tasks".to_string(),
                    spec_version: "0.3.0".to_string(),
                    contracts: Vec::new(),
                }],
            },
            RelayMessage::AuthorizationActivationResponse {
                protocol_version: CONTROL_PROTOCOL_VERSION,
                request_id: ids[0],
                ok: true,
                contracts: Vec::new(),
                error: None,
            },
            RelayMessage::OperationRequest {
                protocol_version: CONTROL_PROTOCOL_VERSION,
                request_id: ids[0],
                grant_id: ids[1],
                collection_id: ids[2],
                application_id: ids[3],
                operation: "query".to_string(),
                input: serde_json::json!({"types": ["task"]}),
            },
            RelayMessage::OperationResponse {
                protocol_version: CONTROL_PROTOCOL_VERSION,
                request_id: ids[0],
                ok: true,
                result: Some(serde_json::json!({"valid": true})),
                error: None,
            },
            RelayMessage::PolicySnapshot {
                protocol_version: CONTROL_PROTOCOL_VERSION,
                grants: vec![GrantPolicy {
                    id: ids[1],
                    application_id: ids[3],
                    collection_id: ids[2],
                    operations: vec!["query".to_string()],
                    scope: GrantScope::full_collection(),
                    application_name: "Tasks".to_string(),
                    application_distribution: "web".to_string(),
                    application_homepage: "https://tasks.example".to_string(),
                    application_project_url: None,
                    application_origin: "https://tasks.example".to_string(),
                    application_icon: None,
                    collection_name: "My tasks".to_string(),
                    notification_criteria: Vec::new(),
                    created_at: "2026-07-21T00:00:00Z".to_string(),
                    encryption: None,
                }],
            },
        ] {
            assert_schema("", serde_json::to_value(message).unwrap());
        }
    }

    #[test]
    fn portable_policy_keeps_v1_and_the_exact_opaque_origin() {
        let ids = [
            Uuid::parse_str("01911111-1111-7111-8111-111111111111").unwrap(),
            Uuid::parse_str("01922222-2222-7222-8222-222222222222").unwrap(),
            Uuid::parse_str("01933333-3333-7333-8333-333333333333").unwrap(),
            Uuid::parse_str("01944444-4444-7444-8444-444444444444").unwrap(),
        ];
        let message = RelayMessage::PolicySnapshot {
            protocol_version: CONTROL_PROTOCOL_VERSION,
            grants: vec![GrantPolicy {
                id: ids[0],
                application_id: ids[1],
                collection_id: ids[2],
                operations: vec!["query".to_string()],
                scope: GrantScope::full_collection(),
                application_name: "Portable notes".to_string(),
                application_distribution: "portable".to_string(),
                application_homepage: String::new(),
                application_project_url: Some("https://apps.example/portable".to_string()),
                application_origin: "null".to_string(),
                application_icon: None,
                collection_name: "Notes".to_string(),
                notification_criteria: Vec::new(),
                created_at: "2026-07-26T00:00:00Z".to_string(),
                encryption: Some(GrantEncryption {
                    protocol_version: 1,
                    suite: RELAY_ENCRYPTION_SUITE.to_string(),
                    key_id: "portable-key".to_string(),
                    scope_epoch: 1,
                    connector_id: ids[3],
                    collection_id: ids[2],
                    application_public_key: "A".repeat(87),
                    connector_public_key: "B".repeat(87),
                }),
            }],
        };
        assert_schema("", serde_json::to_value(message).unwrap());
    }

    #[test]
    fn rust_encrypted_relay_messages_match_the_canonical_wire_schema() {
        let envelope = EncryptedRelayEnvelope {
            protocol_version: ENCRYPTED_RELAY_PROTOCOL_VERSION,
            suite: RELAY_ENCRYPTION_SUITE.to_string(),
            request_id: Uuid::parse_str("01911111-1111-7111-8111-111111111111").unwrap(),
            grant_id: Uuid::parse_str("01922222-2222-7222-8222-222222222222").unwrap(),
            application_id: Uuid::parse_str("01933333-3333-7333-8333-333333333333").unwrap(),
            connector_id: Uuid::parse_str("01944444-4444-7444-8444-444444444444").unwrap(),
            collection_id: Uuid::parse_str("01955555-5555-7555-8555-555555555555").unwrap(),
            operation: "query".to_string(),
            scope_epoch: 1,
            key_id: "enc_test".to_string(),
            counter: "1".to_string(),
            ciphertext: "opaque_ciphertext".to_string(),
        };
        assert_encrypted_schema(
            serde_json::to_value(RelayMessage::EncryptedOperationRequest {
                envelope: envelope.clone(),
            })
            .unwrap(),
        );
        assert_encrypted_schema(
            serde_json::to_value(RelayMessage::EncryptedOperationResponse { envelope }).unwrap(),
        );
    }

    #[test]
    fn rust_collection_description_matches_the_addressable_schema() {
        let description = CollectionDescription {
            protocol_version: CONTROL_PROTOCOL_VERSION,
            collection_id: Uuid::parse_str("01933333-3333-7333-8333-333333333333").unwrap(),
            display_name: "Tasks".to_string(),
            spec_version: "0.3.0".to_string(),
            operations: vec!["describe".to_string(), "query".to_string()],
            change_cursor: 0,
            types: vec![],
            contracts: vec![],
            configuration: None,
        };
        assert_schema(
            "/$defs/collectionDescription",
            serde_json::to_value(description).unwrap(),
        );
    }

    #[test]
    fn rust_sync_messages_match_the_canonical_wire_schema() {
        let collection_id = Uuid::parse_str("01911111-1111-7111-8111-111111111111").unwrap();
        let replica_id = Uuid::parse_str("01922222-2222-7222-8222-222222222222").unwrap();
        let session_id = Uuid::parse_str("01933333-3333-7333-8333-333333333333").unwrap();
        let snapshot_id = Uuid::parse_str("01944444-4444-7444-8444-444444444444").unwrap();
        let record_id = Uuid::parse_str("01955555-5555-7555-8555-555555555555").unwrap();
        let mutation_id = Uuid::parse_str("01966666-6666-7666-8666-666666666666").unwrap();
        let resources = SyncCollectionResources {
            revision: "resources:1".to_string(),
            spec_version: "0.3.0".to_string(),
            types: Vec::new(),
            contracts: Vec::new(),
            documents: Vec::new(),
        };
        let record = SyncRecord {
            record_id,
            path: "tasks/example.md".to_string(),
            revision: "sha256:record".to_string(),
            frontmatter: serde_json::Map::from_iter([
                ("type".to_string(), Value::String("task".to_string())),
                ("title".to_string(), Value::String("Example".to_string())),
            ]),
            body: "Body".to_string(),
            types: vec!["task".to_string()],
        };
        let mutation = SyncMutation {
            mutation_id,
            replica_id,
            scope_epoch: 1,
            operation: SyncMutationOperation::Update,
            record_id,
            base_revision: Some(record.revision.clone()),
            input: serde_json::Map::from_iter([(
                "patch".to_string(),
                serde_json::json!({"status": "done"}),
            )]),
            created_at: "2026-07-21T00:00:00Z".to_string(),
            causal_predecessor: None,
        };

        for (reference, value) in [
            (
                "/$defs/session",
                serde_json::to_value(SyncSession {
                    protocol_version: SYNC_PROTOCOL_VERSION,
                    session_id,
                    replica_id,
                    collection_id,
                    mode: SyncReplicaMode::ReadWrite,
                    scope_epoch: 1,
                    retained_after: 0,
                    head: 1,
                    snapshot_id,
                    resources: resources.clone(),
                })
                .unwrap(),
            ),
            (
                "/$defs/snapshotPage",
                serde_json::to_value(SyncSnapshotPage {
                    protocol_version: SYNC_PROTOCOL_VERSION,
                    snapshot_id,
                    scope_epoch: 1,
                    cursor: 1,
                    records: vec![record.clone()],
                    next_page: None,
                })
                .unwrap(),
            ),
            (
                "/$defs/changesPage",
                serde_json::to_value(SyncChangesPage {
                    protocol_version: SYNC_PROTOCOL_VERSION,
                    scope_epoch: 1,
                    events: vec![SyncChange::Put {
                        sequence: 1,
                        record: record.clone(),
                    }],
                    cursor: 1,
                    head: 1,
                    has_more: false,
                    reset_required: false,
                })
                .unwrap(),
            ),
            ("/$defs/mutation", serde_json::to_value(&mutation).unwrap()),
            (
                "/$defs/receipt",
                serde_json::to_value(SyncMutationReceipt::Conflicted {
                    mutation_id,
                    conflict: SyncConflict {
                        record_id,
                        mutation,
                        current_revision: Some(record.revision.clone()),
                        current: Some(record),
                    },
                })
                .unwrap(),
            ),
        ] {
            assert_sync_schema(reference, value);
        }
    }
}
