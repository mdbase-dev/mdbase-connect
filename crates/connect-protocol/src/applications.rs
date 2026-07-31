use super::*;
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
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum ContractSetupMode {
    #[default]
    Starter,
    Existing {
        type_name: String,
        type_revision: String,
        #[serde(default)]
        fields: std::collections::BTreeMap<String, String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        binding: Option<Value>,
    },
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContractSetupChoice {
    pub contract: ContractRequirement,
    #[serde(flatten)]
    pub mode: ContractSetupMode,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AuthorizationCollectionTypes {
    pub collection_id: Uuid,
    #[serde(default)]
    pub types: Vec<CollectionTypeDescriptor>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApplicationRequirements {
    #[serde(default)]
    pub contracts: Vec<ContractRequirement>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access: Option<ApplicationAccess>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collection_kind: Option<ApplicationCollectionKind>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApplicationAccess {
    Contract,
    FullCollection,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApplicationCollectionKind {
    Hosted,
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
    pub event: ContractRequirement,
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
    pub collection_id: Option<Uuid>,
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
    /// Minimal type metadata offered locally for guided contract setup.
    #[serde(default)]
    pub collection_types: Vec<AuthorizationCollectionTypes>,
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
    #[serde(default)]
    pub types: Vec<CollectionTypeDescriptor>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GrantEncryption {
    pub protocol_version: u32,
    pub suite: String,
    pub key_id: String,
    pub scope_epoch: u64,
    pub connector_id: Uuid,
    pub collection_id: Uuid,
    pub application_agreement_public_key: String,
    pub connector_agreement_public_key: String,
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
