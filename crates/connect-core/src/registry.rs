use directories::ProjectDirs;
use mdbase::runtime::FilesystemProvider;
use mdbase::{Collection, SpecProfile};
use mdbase_connect_protocol::is_mutating_operation;
use mdbase_connect_protocol::{
    ActivityEntry, ApplicationAuthorizationProof, ApplicationRequirements, ApplyTypePackInput,
    AssessTypePackInput, AuthoritySnapshot, CollectionChange, CollectionChangesPage,
    CollectionContractDescriptor, CollectionDescription, CollectionSummary,
    CollectionTypeDescriptor, ContractRequirement, ContractSetupChoice, ContractSetupMode,
    EncryptedRelayEnvelope, GrantPolicy, GrantScope, GrantSummary, SyncCollectionResources,
    SyncMutation, SyncMutationReceipt, SyncResourceDocument, TypePackProvision,
    CONTROL_PROTOCOL_VERSION,
};
use mdbase_connect_runtime::contract_scope::{ContractScope, ContractScopeError};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap};
use std::env;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tempfile::NamedTempFile;
use thiserror::Error;
use uuid::Uuid;

const CONNECT_EXTENSION: &str = "x-mdbase-connect";
const CONNECT_COLLECTION_ID: &str = "collection_id";
const MIRROR_MARKER_DIRECTORY: &str = ".mdbase";
const MIRROR_MARKER_FILE: &str = "connect-role.json";

mod agent_state;
mod authority;
mod collections;
mod database;
mod descriptions;
mod encrypted_requests;
mod file_transfers;
mod files;
mod grants;
mod identity;
mod migrations;
mod mutation_journal;
mod operation_execution;
mod operations;
mod scope;

pub use encrypted_requests::{encrypted_request_fingerprint, EncryptedRequestClaim};
use identity::{
    assert_local_authority_folder, clear_collection_identity, collection_display_name,
    ensure_collection_id, normalized_optional, read_collection_id, read_collection_metadata,
    remove_mirror_marker, set_collection_identity, write_collection_id, write_mirror_marker,
};
pub use identity::{collection_identity, mirror_collection_id};
pub use migrations::{RegistryBackupDiagnostic, RegistryBackupMetadata, RegistryDiagnostics};
pub use mutation_journal::{
    MutationClaim, MutationClaimRequest, MutationJournalDiagnostics, MutationJournalState,
    MutationLease, MutationRecoveryData,
};
use operation_execution::{
    error_message, execute_loaded, has_contract, operation_invalidation, supported_operations,
};
use scope::{
    change_is_in_scope, contract_scope_error, ensure_no_new_out_of_scope_types,
    ensure_result_in_scope, ensure_types_in_scope, required_string, required_uuid, result_types,
    sync_resources,
};

#[derive(Debug, Error)]
pub enum ConnectError {
    #[error("mdbase connect could not determine a per-user state directory")]
    StateDirectoryUnavailable,
    #[error("Collection path does not exist: {0}")]
    PathNotFound(String),
    #[error("The selected folder is not an mdbase collection: {0}")]
    NotACollection(String),
    #[error("Collection is not registered: {0}")]
    CollectionNotFound(Uuid),
    #[error("Collection initialization failed: {0}")]
    CollectionInit(String),
    #[error("Collection failed to open: {0}")]
    CollectionOpen(String),
    #[error("{message}")]
    CloudProblem { code: String, message: String },
    #[error("{message}")]
    CollectionInvalid {
        code: String,
        message: String,
        diagnostics: Vec<Value>,
    },
    #[error("Collection identity {collection_id} is already registered at {existing_path}")]
    DuplicateCollectionIdentity {
        collection_id: Uuid,
        existing_path: String,
    },
    #[error(
        "This folder is a mirror of collection {collection_id}. A mirror cannot also be registered as an authority."
    )]
    MirrorCannotRegister { collection_id: Uuid },
    #[error("Mirror role marker is invalid: {0}")]
    InvalidMirrorMarker(String),
    #[error("The selected folder is not a registered collection copy: {0}")]
    NotARegisteredCollectionCopy(String),
    #[error("Unsupported collection operation: {0}")]
    UnsupportedOperation(String),
    #[error("Invalid request: {0}")]
    InvalidInput(String),
    #[error("Application access denied: {0}")]
    AccessDenied(String),
    #[error("Encrypted relay request was rejected")]
    EncryptedRelayRejected,
    #[error("Collection authority transfer {transfer_id} is fencing mutations")]
    AuthorityTransferInProgress { transfer_id: Uuid },
    #[error("This collection is no longer authoritative on this computer")]
    AuthorityRetired,
    #[error("Collection authority is fenced by another transfer")]
    AuthorityTransferMismatch,
    #[error("Local registry error: {0}")]
    Registry(#[from] rusqlite::Error),
    #[error("The local registry at {path} is corrupt: {detail}. The file was preserved; restore a verified backup or export diagnostics before repair.")]
    RegistryCorrupt { path: PathBuf, detail: String },
    #[error("The local registry at {path} uses unsupported schema version {found} (this build supports through {supported}): {detail}")]
    RegistrySchemaIncompatible {
        path: PathBuf,
        found: u32,
        supported: u32,
        detail: String,
    },
    #[error("The local registry at {path} is busy; stop the other connector process and retry")]
    RegistryBusy { path: PathBuf },
    #[error("Registry migration {version} failed for {path}: {detail}")]
    RegistryMigration {
        path: PathBuf,
        version: u32,
        detail: String,
    },
    #[error("Registry backup {path} is invalid: {detail}")]
    RegistryBackupInvalid { path: PathBuf, detail: String },
    #[error("Mutation request {request_id} was already bound to different input")]
    MutationRequestConflict { request_id: Uuid },
    #[error("Mutation request {request_id} is outside the supported recovery horizon")]
    MutationRecoveryExpired { request_id: Uuid },
    #[error("Mutation request {request_id} lost its fenced journal lease")]
    MutationFenceLost { request_id: Uuid },
    #[error("Filesystem error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Configuration error: {0}")]
    Config(#[from] serde_yaml::Error),
    #[error("Configuration error: {0}")]
    Settings(String),
    #[error("Credential store error: {0}")]
    CredentialStore(String),
    #[error("{message}")]
    Mirror { code: String, message: String },
    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("Cloud control error: {0}")]
    Cloud(String),
    #[error("{message}")]
    File { code: String, message: String },
    #[error("Invalid timer operation: {0}")]
    InvalidTimer(String),
    #[error("Timer authority error: {0}")]
    TimerRuntime(String),
    #[error(transparent)]
    Provider(#[from] mdbase::runtime::ProviderError),
}

impl ConnectError {
    pub fn code(&self) -> &str {
        match self {
            Self::StateDirectoryUnavailable => "state_directory_unavailable",
            Self::PathNotFound(_) => "path_not_found",
            Self::NotACollection(_) => "not_a_collection",
            Self::CollectionNotFound(_) => "collection_not_found",
            Self::CollectionInit(_) => "collection_init_failed",
            Self::CollectionOpen(_) => "collection_open_failed",
            Self::CollectionInvalid { code, .. } => code.as_str(),
            Self::DuplicateCollectionIdentity { .. } => "duplicate_collection_identity",
            Self::MirrorCannotRegister { .. } => "mirror_cannot_register",
            Self::InvalidMirrorMarker(_) => "invalid_mirror_marker",
            Self::NotARegisteredCollectionCopy(_) => "not_a_registered_collection_copy",
            Self::UnsupportedOperation(_) => "unsupported_operation",
            Self::InvalidInput(_) => "invalid_input",
            Self::AccessDenied(_) => "access_denied",
            Self::EncryptedRelayRejected => "encrypted_relay_rejected",
            Self::AuthorityTransferInProgress { .. } => "authority_transfer_in_progress",
            Self::AuthorityRetired => "authority_retired",
            Self::AuthorityTransferMismatch => "authority_transfer_mismatch",
            Self::Registry(_) => "registry_failed",
            Self::RegistryCorrupt { .. } => "registry_corrupt",
            Self::RegistrySchemaIncompatible { .. } => "registry_schema_incompatible",
            Self::RegistryBusy { .. } => "registry_busy",
            Self::RegistryMigration { .. } => "registry_migration_failed",
            Self::RegistryBackupInvalid { .. } => "registry_backup_invalid",
            Self::MutationRequestConflict { .. } => "mutation_request_conflict",
            Self::MutationRecoveryExpired { .. } => "mutation_recovery_expired",
            Self::MutationFenceLost { .. } => "pending_mutation_unresolved",
            Self::Io(_) => "io_failed",
            Self::Config(_) => "invalid_config",
            Self::Settings(_) => "invalid_config",
            Self::CredentialStore(_) => "credential_store_unavailable",
            Self::Mirror { code, .. } => code.as_str(),
            Self::Serialization(_) => "serialization_failed",
            Self::Cloud(_) => "cloud_control_failed",
            Self::CloudProblem { code, .. } => code.as_str(),
            Self::File { code, .. } => code.as_str(),
            Self::InvalidTimer(_) => "invalid_timer_request",
            Self::TimerRuntime(_) => "timer_runtime_failed",
            Self::Provider(_) => "collection_provider_failed",
        }
    }

    pub(crate) fn invalid_collection(diagnostics: Vec<mdbase::v03::Diagnostic>) -> Self {
        let message = diagnostics
            .iter()
            .find(|diagnostic| diagnostic.severity == "error")
            .or_else(|| diagnostics.first())
            .map(|diagnostic| diagnostic.message.clone())
            .unwrap_or_else(|| "The collection is invalid.".to_string());
        let type_registry_invalid = diagnostics.iter().any(|diagnostic| {
            diagnostic
                .path
                .as_deref()
                .is_some_and(|path| path != "mdbase.yaml")
                || matches!(
                    diagnostic.code.as_str(),
                    "duplicate_type"
                        | "invalid_contract_definition"
                        | "invalid_data_contract"
                        | "invalid_type_definition"
                        | "invalid_type_path"
                )
        });
        let configuration_invalid = diagnostics.iter().any(|diagnostic| {
            diagnostic.path.as_deref() == Some("mdbase.yaml")
                || matches!(
                    diagnostic.code.as_str(),
                    "invalid_config"
                        | "invalid_configuration"
                        | "missing_config"
                        | "missing_spec_version"
                        | "unsupported_version"
                )
        });
        let code = if type_registry_invalid {
            "collection_type_registry_invalid"
        } else if configuration_invalid {
            "collection_configuration_invalid"
        } else {
            "collection_invalid"
        };
        Self::CollectionInvalid {
            code: code.to_string(),
            message,
            diagnostics: diagnostics
                .into_iter()
                .filter_map(|diagnostic| serde_json::to_value(diagnostic).ok())
                .collect(),
        }
    }
}

fn classify_collection_error(registered: &CollectionSummary, error: ConnectError) -> ConnectError {
    if matches!(
        error,
        ConnectError::Provider(mdbase::runtime::ProviderError::CollectionOpen(_))
    ) && registered.spec_version.starts_with("0.3")
    {
        let report = mdbase::v03::inspect_collection(Path::new(&registered.path));
        if !report.valid {
            return ConnectError::invalid_collection(report.diagnostics);
        }
    }
    error
}

pub fn default_state_dir() -> Result<PathBuf, ConnectError> {
    if let Some(path) = env::var_os("MDBASE_CONNECT_HOME") {
        return Ok(PathBuf::from(path));
    }
    ProjectDirs::from("dev", "mdbase", "connect")
        .map(|dirs| dirs.data_local_dir().to_path_buf())
        .ok_or(ConnectError::StateDirectoryUnavailable)
}

pub fn default_control_endpoint(state_dir: &Path) -> String {
    if let Some(endpoint) = env::var_os("MDBASE_CONNECT_SOCKET") {
        return endpoint.to_string_lossy().to_string();
    }
    #[cfg(unix)]
    {
        state_dir.join("agent.sock").to_string_lossy().to_string()
    }
    #[cfg(windows)]
    {
        let digest = Sha256::digest(state_dir.to_string_lossy().as_bytes());
        let suffix = digest[..8]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        format!(r"\\.\pipe\mdbase-connect-{suffix}")
    }
}

pub(crate) fn ensure_private_state_dir(state_dir: &Path) -> Result<(), ConnectError> {
    fs::create_dir_all(state_dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(state_dir, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

#[derive(Debug, Clone)]
pub struct CollectionRegistry {
    db_path: PathBuf,
    process_epoch: Uuid,
    providers: Arc<Mutex<HashMap<Uuid, Arc<FilesystemProvider>>>>,
    file_reconciles: Arc<Mutex<HashMap<Uuid, Arc<Mutex<()>>>>>,
    encrypted_request_writes: Arc<Mutex<()>>,
}

#[derive(Debug, Clone)]
pub struct GrantReplayContext {
    pub grant: GrantSummary,
    pub revoked: bool,
    pub application_installation_id: Uuid,
    pub grant_snapshot_digest: String,
}

/// Filesystem state that must be synchronized after a successful operation.
/// Record paths come from mdbase's canonical operation envelope; collection
/// metadata and type mutations intentionally request a full watcher reload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CollectionInvalidation {
    None,
    Records(BTreeSet<String>),
    All,
}

fn parse_registry_uuid(value: &str) -> Result<Uuid, ConnectError> {
    Uuid::parse_str(value).map_err(|error| {
        ConnectError::CollectionOpen(format!("invalid UUID in connector registry: {error}"))
    })
}

#[cfg(test)]
mod tests;
