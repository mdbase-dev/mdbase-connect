use super::*;
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
    #[serde(rename = "application-trust.snapshot")]
    ApplicationTrustSnapshot,
    #[serde(rename = "application-trust.show")]
    ApplicationTrustShow(ApplicationTrustIdParams),
    #[serde(rename = "application-trust.accept")]
    ApplicationTrustAccept(ApplicationTrustAcceptParams),
    #[serde(rename = "application-trust.reject")]
    ApplicationTrustReject(ApplicationTrustRequestIdParams),
    #[serde(rename = "application-trust.revoke")]
    ApplicationTrustRevoke(ApplicationTrustIdParams),
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
    #[serde(rename = "mirrors.configure-selective-sync")]
    MirrorConfigureSelectiveSync(MirrorConfigureSelectiveSyncParams),
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
pub struct ApplicationTrustIdParams {
    pub id: Uuid,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApplicationTrustRequestIdParams {
    pub request_id: Uuid,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApplicationTrustAcceptParams {
    pub request_id: Uuid,
    pub authentication_string: String,
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
    #[serde(default)]
    pub contract_setups: Vec<ContractSetupChoice>,
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
    #[serde(default)]
    pub selective_sync: SelectiveSyncPolicy,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MirrorIdParams {
    pub replica_id: Uuid,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MirrorConfigureSelectiveSyncParams {
    pub replica_id: Uuid,
    pub selective_sync: SelectiveSyncPolicy,
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
