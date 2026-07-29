use directories::ProjectDirs;
use mdbase::runtime::FilesystemProvider;
use mdbase::{Collection, SpecProfile};
use mdbase_connect_protocol::{
    ActivityEntry, ApplicationRequirements, AuthoritySnapshot, CollectionChange,
    CollectionChangesPage, CollectionContractDescriptor, CollectionDescription, CollectionSummary,
    CollectionTypeDescriptor, ContractRequirement, EncryptedRelayEnvelope, GrantPolicy, GrantScope,
    GrantSummary, SyncCollectionResources, SyncMutation, SyncMutationReceipt, SyncResourceDocument,
    TypePackProvision, CONTROL_PROTOCOL_VERSION,
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

const ENCRYPTED_REPLAY_WINDOW: u64 = 1024;
const CONNECT_EXTENSION: &str = "x-mdbase-connect";
const CONNECT_COLLECTION_ID: &str = "collection_id";
const MIRROR_MARKER_DIRECTORY: &str = ".mdbase";
const MIRROR_MARKER_FILE: &str = "connect-role.json";

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
            Self::Io(_) => "io_failed",
            Self::Config(_) => "invalid_config",
            Self::Settings(_) => "invalid_config",
            Self::CredentialStore(_) => "credential_store_unavailable",
            Self::Mirror { code, .. } => code.as_str(),
            Self::Serialization(_) => "serialization_failed",
            Self::Cloud(_) => "cloud_control_failed",
            Self::InvalidTimer(_) => "invalid_timer_request",
            Self::TimerRuntime(_) => "timer_runtime_failed",
            Self::Provider(_) => "collection_provider_failed",
        }
    }
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
    providers: Arc<Mutex<HashMap<Uuid, Arc<FilesystemProvider>>>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EncryptedRequestClaim {
    Fresh,
    Completed(String),
    InProgress,
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

pub fn encrypted_request_fingerprint(
    envelope: &EncryptedRelayEnvelope,
) -> Result<String, ConnectError> {
    let digest = Sha256::digest(serde_json::to_vec(envelope)?);
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

impl CollectionRegistry {
    pub(crate) fn db_path(&self) -> &Path {
        &self.db_path
    }

    pub fn open(state_dir: impl AsRef<Path>) -> Result<Self, ConnectError> {
        ensure_private_state_dir(state_dir.as_ref())?;
        let registry = Self {
            db_path: state_dir.as_ref().join("connector.sqlite"),
            providers: Arc::new(Mutex::new(HashMap::new())),
        };
        registry.migrate()?;
        Ok(registry)
    }

    fn connection(&self) -> Result<Connection, ConnectError> {
        let connection = Connection::open(&self.db_path)?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        Ok(connection)
    }

    fn migrate(&self) -> Result<(), ConnectError> {
        self.connection()?.execute_batch(
            "
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS collections (
                id TEXT PRIMARY KEY,
                path TEXT NOT NULL UNIQUE,
                display_name TEXT NOT NULL,
                description TEXT,
                spec_version TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS grants (
                id TEXT PRIMARY KEY,
                application_id TEXT NOT NULL,
                collection_id TEXT NOT NULL,
                operations TEXT NOT NULL,
                scope TEXT NOT NULL DEFAULT '{\"contracts\":[],\"access\":\"full_collection\"}',
                application_name TEXT NOT NULL DEFAULT 'Application',
                application_distribution TEXT NOT NULL DEFAULT 'web',
                application_homepage TEXT NOT NULL DEFAULT '',
                application_project_url TEXT,
                application_origin TEXT NOT NULL DEFAULT '',
                application_icon TEXT,
                collection_name TEXT NOT NULL DEFAULT 'Collection',
                notification_criteria TEXT NOT NULL DEFAULT '[]',
                encryption TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS activity (
                id TEXT PRIMARY KEY,
                application_id TEXT NOT NULL,
                application_name TEXT NOT NULL,
                collection_id TEXT NOT NULL,
                collection_name TEXT NOT NULL,
                operation TEXT NOT NULL,
                outcome TEXT NOT NULL,
                detail TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS collection_changes (
                collection_id TEXT NOT NULL,
                cursor INTEGER NOT NULL,
                event_type TEXT NOT NULL,
                occurred_at TEXT NOT NULL,
                payload TEXT NOT NULL,
                PRIMARY KEY (collection_id, cursor),
                FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS local_sync_collections (
                collection_id TEXT PRIMARY KEY,
                head INTEGER NOT NULL DEFAULT 0,
                retained_after INTEGER NOT NULL DEFAULT 0,
                resource_revision TEXT NOT NULL,
                authority_epoch INTEGER NOT NULL DEFAULT 1,
                authority_state TEXT NOT NULL DEFAULT 'active',
                transfer_id TEXT,
                FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS local_sync_records (
                collection_id TEXT NOT NULL,
                record_id TEXT NOT NULL,
                path TEXT NOT NULL,
                revision TEXT NOT NULL,
                record TEXT NOT NULL,
                PRIMARY KEY (collection_id, record_id),
                UNIQUE (collection_id, path),
                FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS local_sync_changes (
                collection_id TEXT NOT NULL,
                sequence INTEGER NOT NULL,
                record_id TEXT NOT NULL,
                before_record TEXT,
                after_record TEXT,
                revision TEXT NOT NULL,
                PRIMARY KEY (collection_id, sequence),
                FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS local_sync_replicas (
                id TEXT PRIMARY KEY,
                collection_id TEXT NOT NULL,
                name TEXT NOT NULL,
                mode TEXT NOT NULL CHECK (mode IN ('read_only', 'read_write')),
                allowed_types TEXT NOT NULL DEFAULT '[]',
                scope_epoch INTEGER NOT NULL DEFAULT 1,
                revoked INTEGER NOT NULL DEFAULT 0,
                acknowledged_sequence INTEGER NOT NULL DEFAULT 0,
                last_seen_at TEXT,
                FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS local_sync_snapshots (
                id TEXT PRIMARY KEY,
                collection_id TEXT NOT NULL,
                replica_id TEXT NOT NULL,
                scope_epoch INTEGER NOT NULL,
                cursor INTEGER NOT NULL,
                records TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE,
                FOREIGN KEY (replica_id) REFERENCES local_sync_replicas(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS local_sync_receipts (
                replica_id TEXT NOT NULL,
                mutation_id TEXT NOT NULL,
                receipt TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (replica_id, mutation_id),
                FOREIGN KEY (replica_id) REFERENCES local_sync_replicas(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS local_sync_changes_collection_idx
                ON local_sync_changes(collection_id, sequence);
            CREATE INDEX IF NOT EXISTS local_sync_snapshots_expiry_idx
                ON local_sync_snapshots(expires_at);
            CREATE TABLE IF NOT EXISTS grant_crypto_state (
                grant_id TEXT NOT NULL,
                key_id TEXT NOT NULL,
                last_request_counter TEXT NOT NULL,
                reorder_floor TEXT NOT NULL DEFAULT '0',
                PRIMARY KEY (grant_id, key_id)
            );
            CREATE TABLE IF NOT EXISTS grant_crypto_requests (
                grant_id TEXT NOT NULL,
                key_id TEXT NOT NULL,
                request_id TEXT NOT NULL,
                request_counter TEXT NOT NULL DEFAULT '',
                request_fingerprint TEXT NOT NULL DEFAULT '',
                response_envelope TEXT,
                received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (grant_id, key_id, request_id)
            );
            ",
        )?;
        // These upgrades preserve registries created by the first development MVP.
        let connection = self.connection()?;
        for migration in [
            "ALTER TABLE grants ADD COLUMN application_name TEXT NOT NULL DEFAULT 'Application'",
            "ALTER TABLE grants ADD COLUMN application_distribution TEXT NOT NULL DEFAULT 'web'",
            "ALTER TABLE grants ADD COLUMN application_homepage TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE grants ADD COLUMN application_project_url TEXT",
            "ALTER TABLE grants ADD COLUMN application_origin TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE grants ADD COLUMN application_icon TEXT",
            "ALTER TABLE grants ADD COLUMN collection_name TEXT NOT NULL DEFAULT 'Collection'",
            "ALTER TABLE grants ADD COLUMN created_at TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE grants ADD COLUMN scope TEXT NOT NULL DEFAULT '{\"contracts\":[],\"access\":\"full_collection\"}'",
            "ALTER TABLE grants ADD COLUMN encryption TEXT",
            "ALTER TABLE grants ADD COLUMN notification_criteria TEXT NOT NULL DEFAULT '[]'",
            "ALTER TABLE collections ADD COLUMN description TEXT",
            "ALTER TABLE grant_crypto_state ADD COLUMN reorder_floor TEXT",
            "ALTER TABLE grant_crypto_requests ADD COLUMN counter TEXT",
            "ALTER TABLE grant_crypto_requests ADD COLUMN request_counter TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE grant_crypto_requests ADD COLUMN request_fingerprint TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE grant_crypto_requests ADD COLUMN response_envelope TEXT",
            "ALTER TABLE local_sync_collections ADD COLUMN authority_state TEXT NOT NULL DEFAULT 'active'",
            "ALTER TABLE local_sync_collections ADD COLUMN transfer_id TEXT",
        ] {
            if let Err(error) = connection.execute(migration, []) {
                if !error.to_string().contains("duplicate column name") {
                    return Err(error.into());
                }
            }
        }
        connection.execute(
            "DELETE FROM grants WHERE json_extract(scope, '$.access') IS NULL",
            [],
        )?;
        // Registries created before the bounded replay window cannot safely distinguish a fresh
        // out-of-order counter from one accepted before counters were recorded. Start their
        // reorder window above the previous high-water mark; new keys start at zero.
        connection.execute(
            "UPDATE grant_crypto_state
             SET reorder_floor = last_request_counter
             WHERE reorder_floor IS NULL",
            [],
        )?;
        connection.execute(
            "UPDATE grant_crypto_requests SET request_counter = counter
             WHERE request_counter = '' AND counter IS NOT NULL",
            [],
        )?;
        connection.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS grant_crypto_requests_request_counter
             ON grant_crypto_requests (grant_id, key_id, request_counter)
             WHERE request_counter <> ''",
            [],
        )?;
        Ok(())
    }

    pub fn list(&self) -> Result<Vec<CollectionSummary>, ConnectError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, display_name, description, path, spec_version, enabled
             FROM collections ORDER BY display_name COLLATE NOCASE, path",
        )?;
        let rows = statement.query_map([], |row| {
            let id: String = row.get(0)?;
            Ok((
                id,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, bool>(5)?,
            ))
        })?;

        let mut collections = rows
            .map(|row| {
                let (id, display_name, description, path, spec_version, enabled) = row?;
                let id = Uuid::parse_str(&id).map_err(|error| {
                    ConnectError::CollectionOpen(format!(
                        "invalid collection id in registry: {error}"
                    ))
                })?;
                Ok(CollectionSummary {
                    id,
                    display_name,
                    description,
                    path,
                    spec_version,
                    enabled,
                    contracts: Vec::new(),
                })
            })
            .collect::<Result<Vec<_>, ConnectError>>()?;
        drop(statement);
        drop(connection);
        for collection in &mut collections {
            if mirror_collection_id(Path::new(&collection.path))?.is_some() {
                collection.enabled = false;
                continue;
            }
            let _ = self.refresh_summary_metadata(collection);
            if let Ok(description) = self.describe(collection.id) {
                collection.contracts = description.contracts;
            }
        }
        collections.sort_by(|left, right| {
            left.display_name
                .to_lowercase()
                .cmp(&right.display_name.to_lowercase())
                .then_with(|| left.path.cmp(&right.path))
        });
        Ok(collections)
    }

    pub fn count(&self) -> Result<usize, ConnectError> {
        let count: i64 =
            self.connection()?
                .query_row("SELECT COUNT(*) FROM collections", [], |row| row.get(0))?;
        Ok(count as usize)
    }

    pub fn add(&self, path: impl AsRef<Path>) -> Result<CollectionSummary, ConnectError> {
        let requested_path = path.as_ref();
        if !requested_path.exists() {
            return Err(ConnectError::PathNotFound(
                requested_path.display().to_string(),
            ));
        }
        let path = requested_path.canonicalize()?;
        assert_local_authority_folder(&path)?;
        if !path.join("mdbase.yaml").is_file() {
            return Err(ConnectError::NotACollection(path.display().to_string()));
        }

        let provider = Arc::new(FilesystemProvider::open(&path)?);

        let id = ensure_collection_id(&path)?;
        let metadata = read_collection_metadata(&path)?;
        let path_string = path.to_string_lossy().to_string();
        let display_name = collection_display_name(&metadata, &path);
        let description = normalized_optional(metadata.description);

        let existing_path = self
            .connection()?
            .query_row(
                "SELECT path FROM collections WHERE id = ?1",
                [id.to_string()],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if let Some(existing_path) = existing_path.as_deref() {
            if existing_path != path_string && Path::new(existing_path).exists() {
                return Err(ConnectError::DuplicateCollectionIdentity {
                    collection_id: id,
                    existing_path: existing_path.to_string(),
                });
            }
        }

        self.connection()?.execute(
            "INSERT INTO collections (id, path, display_name, description, spec_version, enabled)
             VALUES (?1, ?2, ?3, ?4, ?5, 1)
             ON CONFLICT(id) DO UPDATE SET
               path = excluded.path,
               display_name = excluded.display_name,
               description = excluded.description,
               spec_version = excluded.spec_version,
               updated_at = CURRENT_TIMESTAMP",
            params![
                id.to_string(),
                path_string,
                display_name,
                description,
                metadata.spec_version
            ],
        )?;

        self.providers
            .lock()
            .map_err(|_| ConnectError::CollectionOpen("provider registry lock poisoned".into()))?
            .insert(id, provider);

        self.get(id)
    }

    /// Turn a fully verified hosted mirror into the local authority.
    ///
    /// The caller must fence and verify the hosted authority first. This
    /// transition is idempotent so a daemon can resume it after a crash.
    pub fn activate_mirror_authority(
        &self,
        path: impl AsRef<Path>,
        collection_id: Uuid,
    ) -> Result<CollectionSummary, ConnectError> {
        let path = path.as_ref().canonicalize()?;
        let path_string = path.to_string_lossy().to_string();
        let existing = self
            .list()?
            .into_iter()
            .find(|collection| collection.id == collection_id);
        let already_materialized = existing
            .as_ref()
            .is_some_and(|collection| collection.path == path_string)
            && collection_identity(&path)? == Some(collection_id)
            && mirror_collection_id(&path)?.is_none();
        if !already_materialized {
            if mirror_collection_id(&path)? != Some(collection_id) {
                return Err(ConnectError::InvalidMirrorMarker(
                    "Only the matching hosted mirror can become this collection authority."
                        .to_string(),
                ));
            }
            if let Some(existing) = &existing {
                let existing_path = Path::new(&existing.path);
                if existing.path != path_string && existing_path.exists() {
                    return Err(ConnectError::DuplicateCollectionIdentity {
                        collection_id,
                        existing_path: existing.path.clone(),
                    });
                }
            }
            let identity_was_present = collection_identity(&path)?.is_some();
            set_collection_identity(&path, collection_id)?;
            remove_mirror_marker(&path, collection_id)?;
            match self.add(&path) {
                Ok(_) => {}
                Err(error) => {
                    if !identity_was_present {
                        let _ = clear_collection_identity(&path);
                    }
                    let _ = write_mirror_marker(&path, collection_id);
                    return Err(error);
                }
            }
        } else {
            self.add(&path)?;
        }
        let mut connection = self.connection()?;
        let transaction =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        transaction.execute(
            "DELETE FROM local_sync_collections WHERE collection_id = ?1",
            [collection_id.to_string()],
        )?;
        transaction.execute(
            "UPDATE collections SET enabled = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
            [collection_id.to_string()],
        )?;
        transaction.commit()?;
        self.get(collection_id)
    }

    /// Restore a materialized-but-uncommitted authority to its mirror role.
    pub fn rollback_mirror_authority(
        &self,
        path: impl AsRef<Path>,
        collection_id: Uuid,
        identity_was_present: bool,
        registration_was_present: bool,
    ) -> Result<(), ConnectError> {
        let path = path.as_ref().canonicalize()?;
        if let Ok(existing) = self.get(collection_id) {
            if existing.path == path.to_string_lossy() {
                if registration_was_present {
                    self.set_enabled(collection_id, false)?;
                } else {
                    self.remove(collection_id)?;
                }
            }
        }
        if !identity_was_present && collection_identity(&path)? == Some(collection_id) {
            clear_collection_identity(&path)?;
        }
        write_mirror_marker(&path, collection_id)
    }

    pub fn add_copy(&self, path: impl AsRef<Path>) -> Result<CollectionSummary, ConnectError> {
        let requested_path = path.as_ref();
        if !requested_path.exists() {
            return Err(ConnectError::PathNotFound(
                requested_path.display().to_string(),
            ));
        }
        let path = requested_path.canonicalize()?;
        assert_local_authority_folder(&path)?;
        if !path.join("mdbase.yaml").is_file() {
            return Err(ConnectError::NotACollection(path.display().to_string()));
        }
        FilesystemProvider::open(&path)?;

        let copied_id = read_collection_id(&path)?.ok_or_else(|| {
            ConnectError::NotARegisteredCollectionCopy(
                "The collection has no existing Connect identity; register it normally."
                    .to_string(),
            )
        })?;
        let existing_path = self
            .connection()?
            .query_row(
                "SELECT path FROM collections WHERE id = ?1",
                [copied_id.to_string()],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let Some(existing_path) = existing_path else {
            return Err(ConnectError::NotARegisteredCollectionCopy(
                "Its identity is not registered on this computer; register it normally."
                    .to_string(),
            ));
        };
        if existing_path == path.to_string_lossy() {
            return Err(ConnectError::NotARegisteredCollectionCopy(
                "The selected folder is the registered original.".to_string(),
            ));
        }
        if !Path::new(&existing_path).exists() {
            return Err(ConnectError::NotARegisteredCollectionCopy(
                "The registered path no longer exists; register this folder normally to record its move."
                    .to_string(),
            ));
        }

        write_collection_id(&path, Uuid::new_v4())?;
        self.add(path)
    }

    pub fn make_independent(&self, id: Uuid) -> Result<CollectionSummary, ConnectError> {
        let collection = self.get(id)?;
        crate::LocalSyncStore::for_registry(self).assert_mutation_allowed(id)?;
        let path = PathBuf::from(&collection.path);
        let new_id = Uuid::new_v4();
        write_collection_id(&path, new_id)?;
        let result = (|| {
            let mut connection = self.connection()?;
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            transaction.execute(
                "DELETE FROM grant_crypto_state
                 WHERE grant_id IN (SELECT id FROM grants WHERE collection_id = ?1)",
                [id.to_string()],
            )?;
            transaction.execute(
                "DELETE FROM grant_crypto_requests
                 WHERE grant_id IN (SELECT id FROM grants WHERE collection_id = ?1)",
                [id.to_string()],
            )?;
            transaction.execute(
                "DELETE FROM grants WHERE collection_id = ?1",
                [id.to_string()],
            )?;
            transaction.execute(
                "DELETE FROM collection_changes WHERE collection_id = ?1",
                [id.to_string()],
            )?;
            transaction.execute(
                "UPDATE collections SET id = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2",
                params![new_id.to_string(), id.to_string()],
            )?;
            transaction.commit()?;
            Ok::<(), ConnectError>(())
        })();
        if let Err(error) = result {
            let _ = write_collection_id(&path, id);
            return Err(error);
        }
        let mut providers = self
            .providers
            .lock()
            .map_err(|_| ConnectError::CollectionOpen("provider registry lock poisoned".into()))?;
        if let Some(provider) = providers.remove(&id) {
            providers.insert(new_id, provider);
        }
        drop(providers);
        self.get(new_id)
    }

    pub fn create(
        &self,
        path: impl AsRef<Path>,
        name: Option<&str>,
    ) -> Result<CollectionSummary, ConnectError> {
        let mut config = serde_json::Map::new();
        config.insert("spec_version".to_string(), json!("0.3.0"));
        if let Some(name) = name.filter(|name| !name.trim().is_empty()) {
            config.insert("name".to_string(), json!(name.trim()));
        }
        let result = mdbase::init::init_collection(
            path.as_ref(),
            &json!({ "config": Value::Object(config) }),
        );
        if result.get("error").is_some() {
            return Err(ConnectError::CollectionInit(error_message(
                &result,
                "Failed to initialize collection",
            )));
        }
        self.add(path)
    }

    pub fn update_metadata(
        &self,
        id: Uuid,
        name: &str,
        description: Option<&str>,
    ) -> Result<CollectionSummary, ConnectError> {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 100 {
            return Err(ConnectError::CollectionOpen(
                "Collection name must be between 1 and 100 characters.".to_string(),
            ));
        }
        let description = description.map(str::trim).filter(|value| !value.is_empty());
        if description.is_some_and(|value| value.chars().count() > 500) {
            return Err(ConnectError::CollectionOpen(
                "Collection description must be 500 characters or fewer.".to_string(),
            ));
        }

        let registered = self.get(id)?;
        assert_local_authority_folder(Path::new(&registered.path))?;
        let provider = self.provider_for(&registered)?;
        let sync_store = crate::LocalSyncStore::for_registry(self);
        provider.with_collection::<_, ConnectError>(|_| {
            sync_store.assert_mutation_allowed(id)?;
            let config_path = Path::new(&registered.path).join("mdbase.yaml");
            let source = fs::read_to_string(&config_path)?;
            let mut config: serde_yaml::Value = serde_yaml::from_str(&source)?;
            let mapping = config.as_mapping_mut().ok_or_else(|| {
                ConnectError::CollectionOpen("mdbase.yaml must contain a YAML mapping.".to_string())
            })?;
            mapping.insert(
                serde_yaml::Value::String("name".to_string()),
                serde_yaml::Value::String(name.to_string()),
            );
            let description_key = serde_yaml::Value::String("description".to_string());
            if let Some(description) = description {
                mapping.insert(
                    description_key,
                    serde_yaml::Value::String(description.to_string()),
                );
            } else {
                mapping.remove(&description_key);
            }

            let serialized = serde_yaml::to_string(&config)?;
            let root = config_path.parent().ok_or_else(|| {
                ConnectError::CollectionOpen("Collection config has no parent folder.".to_string())
            })?;
            let permissions = fs::metadata(&config_path)?.permissions();
            let mut temporary = NamedTempFile::new_in(root)?;
            temporary.as_file().set_permissions(permissions)?;
            temporary.write_all(serialized.as_bytes())?;
            temporary.as_file().sync_all()?;
            temporary
                .persist(&config_path)
                .map_err(|error| ConnectError::Io(error.error))?;
            Ok(())
        })?;

        let mut updated = registered;
        self.refresh_summary_metadata(&mut updated)?;
        self.providers
            .lock()
            .map_err(|_| ConnectError::CollectionOpen("provider registry lock poisoned".into()))?
            .remove(&id);
        Ok(updated)
    }

    pub fn set_enabled(&self, id: Uuid, enabled: bool) -> Result<CollectionSummary, ConnectError> {
        let store = crate::LocalSyncStore::for_registry(self);
        if enabled {
            let registered = self.get(id)?;
            assert_local_authority_folder(Path::new(&registered.path))?;
            store.assert_mutation_allowed(id)?;
        } else {
            store.assert_not_transferring(id)?;
        }
        let changed = self.connection()?.execute(
            "UPDATE collections SET enabled = ?2, updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
            params![id.to_string(), enabled],
        )?;
        if changed == 0 {
            return Err(ConnectError::CollectionNotFound(id));
        }
        self.get(id)
    }

    pub fn get(&self, id: Uuid) -> Result<CollectionSummary, ConnectError> {
        let connection = self.connection()?;
        let row = connection
            .query_row(
                "SELECT display_name, description, path, spec_version, enabled
                 FROM collections WHERE id = ?1",
                [id.to_string()],
                |row| {
                    Ok(CollectionSummary {
                        id,
                        display_name: row.get(0)?,
                        description: row.get(1)?,
                        path: row.get(2)?,
                        spec_version: row.get(3)?,
                        enabled: row.get(4)?,
                        contracts: Vec::new(),
                    })
                },
            )
            .optional()?;
        let mut collection = row.ok_or(ConnectError::CollectionNotFound(id))?;
        if mirror_collection_id(Path::new(&collection.path))?.is_some() {
            collection.enabled = false;
        }
        Ok(collection)
    }

    pub fn remove(&self, id: Uuid) -> Result<CollectionSummary, ConnectError> {
        let collection = self.get(id)?;
        crate::LocalSyncStore::for_registry(self).assert_not_transferring(id)?;
        self.connection()?
            .execute("DELETE FROM collections WHERE id = ?1", [id.to_string()])?;
        self.providers
            .lock()
            .map_err(|_| ConnectError::CollectionOpen("provider registry lock poisoned".into()))?
            .remove(&id);
        Ok(collection)
    }

    pub fn validate(&self, id: Uuid) -> Result<Value, ConnectError> {
        self.operation(id, "validate", &json!({}))
    }

    pub fn operation(
        &self,
        id: Uuid,
        operation: &str,
        input: &Value,
    ) -> Result<Value, ConnectError> {
        self.operation_synchronized(id, operation, input, |_| {})
    }

    pub fn operation_synchronized(
        &self,
        id: Uuid,
        operation: &str,
        input: &Value,
        synchronize: impl FnOnce(&CollectionInvalidation),
    ) -> Result<Value, ConnectError> {
        let registered = self.get(id)?;
        assert_local_authority_folder(Path::new(&registered.path))?;
        if operation == "changes" {
            return serde_json::to_value(self.changes(id, input)?).map_err(ConnectError::from);
        }
        let provider = self.provider_for(&registered)?;
        let sync_store = crate::LocalSyncStore::for_registry(self);
        let execute = |collection: &Collection| {
            sync_store.assert_authority_available(id)?;
            if operation == "describe" {
                return serde_json::to_value(self.describe_loaded(&registered, collection)?)
                    .map_err(ConnectError::from);
            }
            execute_loaded(collection, operation, input)
        };
        if is_collection_mutation(operation) {
            provider.with_collection(|collection| {
                sync_store.assert_mutation_allowed(id)?;
                let result = execute(collection)?;
                let invalidation = operation_invalidation(operation, input, &result);
                synchronize(&invalidation);
                Ok(result)
            })
        } else {
            provider.with_collection_read(execute)
        }
    }

    pub fn is_compatible(
        &self,
        id: Uuid,
        requirements: &ApplicationRequirements,
    ) -> Result<bool, ConnectError> {
        if requirements.contracts.is_empty() {
            return Ok(true);
        }
        let description = self.describe(id)?;
        Ok(requirements.contracts.iter().all(|required| {
            description.contracts.iter().any(|available| {
                available.id == required.id && available.version == required.version
            })
        }))
    }

    pub fn provision_type_packs(
        &self,
        id: Uuid,
        requirements: &ApplicationRequirements,
        provisions: &[TypePackProvision],
    ) -> Result<Vec<CollectionContractDescriptor>, ConnectError> {
        let mut description = self.describe(id)?;
        let missing = requirements
            .contracts
            .iter()
            .filter(|required| !has_contract(&description.contracts, required))
            .cloned()
            .collect::<Vec<_>>();
        if missing.iter().any(|required| {
            !provisions
                .iter()
                .any(|provision| provision.provides.contains(required))
        }) {
            return Err(ConnectError::AccessDenied(
                "This collection is missing a required contract that the application cannot install."
                    .to_string(),
            ));
        }

        for provision in provisions.iter().filter(|provision| {
            provision
                .provides
                .iter()
                .any(|provided| missing.contains(provided))
        }) {
            let registered = self.get(id)?;
            let provider = self.provider_for(&registered)?;
            let manifest = serde_json::to_value(&provision.manifest)?;
            let resources = provision
                .resources
                .iter()
                .map(|resource| mdbase::v03::TypePackResource {
                    source: resource.source.clone(),
                    document: resource.document.clone(),
                })
                .collect::<Vec<_>>();
            let result = provider.with_collection(|collection| {
                Ok::<_, ConnectError>(collection.install_type_pack(&manifest, &resources, false))
            })?;
            if !result.valid {
                return Err(ConnectError::AccessDenied(format!(
                    "The {} type pack could not be installed: {}",
                    provision
                        .manifest
                        .name
                        .as_deref()
                        .unwrap_or(&provision.manifest.id),
                    result
                        .diagnostics
                        .first()
                        .map(|diagnostic| diagnostic.message.as_str())
                        .unwrap_or("the type pack was rejected")
                )));
            }
            description = self.describe(id)?;
            if provision
                .provides
                .iter()
                .any(|provided| !has_contract(&description.contracts, provided))
            {
                return Err(ConnectError::AccessDenied(format!(
                    "The {} type pack did not provide every contract declared by the application.",
                    provision
                        .manifest
                        .name
                        .as_deref()
                        .unwrap_or(&provision.manifest.id)
                )));
            }
        }

        if requirements
            .contracts
            .iter()
            .any(|required| !has_contract(&description.contracts, required))
        {
            return Err(ConnectError::AccessDenied(
                "The installed type definitions did not provide every required contract."
                    .to_string(),
            ));
        }
        Ok(description.contracts)
    }

    pub fn scoped_operation(
        &self,
        id: Uuid,
        operation: &str,
        input: &Value,
        scope: &GrantScope,
    ) -> Result<Value, ConnectError> {
        self.scoped_operation_synchronized(id, operation, input, scope, |_| {})
    }

    pub fn scoped_operation_synchronized(
        &self,
        id: Uuid,
        operation: &str,
        input: &Value,
        scope: &GrantScope,
        synchronize: impl FnOnce(&CollectionInvalidation),
    ) -> Result<Value, ConnectError> {
        let registered = self.get(id)?;
        if !registered.enabled {
            return Err(ConnectError::AccessDenied(
                "This collection is disabled on its computer.".to_string(),
            ));
        }
        let provider = self.provider_for(&registered)?;
        let sync_store = crate::LocalSyncStore::for_registry(self);
        let execute = |collection: &Collection| {
            sync_store.assert_authority_available(id)?;
            self.scoped_operation_loaded(&registered, collection, operation, input, scope)
        };
        if is_collection_mutation(operation) {
            provider.with_collection(|collection| {
                sync_store.assert_mutation_allowed(id)?;
                let result = execute(collection)?;
                let invalidation = operation_invalidation(operation, input, &result);
                synchronize(&invalidation);
                Ok(result)
            })
        } else {
            provider.with_collection_read(execute)
        }
    }

    pub fn sync_operation_synchronized(
        &self,
        id: Uuid,
        input: &Value,
        mut replica: crate::LocalReplica,
        scope: &GrantScope,
        synchronize: impl FnOnce(&CollectionInvalidation),
    ) -> Result<Value, ConnectError> {
        if scope.access == mdbase_connect_protocol::ApplicationAccess::Contract {
            return Err(ConnectError::AccessDenied(
                "Contract-scoped replicas are not available because the sync document format contains whole records. Use projected read/query/create/update operations, or request explicit full-collection access."
                    .to_string(),
            ));
        }
        let registered = self.get(id)?;
        if !registered.enabled {
            return Err(ConnectError::AccessDenied(
                "This collection is disabled on its computer.".to_string(),
            ));
        }
        let action = input.get("action").and_then(Value::as_str).ok_or_else(|| {
            ConnectError::AccessDenied("Sync request action is required.".to_string())
        })?;
        let provider = self.provider_for(&registered)?;
        let store = crate::LocalSyncStore::for_registry(self);
        let execute = |collection: &Collection| -> Result<Value, ConnectError> {
            store.assert_authority_available(id)?;
            replica.allowed_types = self
                .resolve_scope_types_loaded(&registered, collection, scope)?
                .unwrap_or_default();
            let snapshot = collection.snapshot()?;
            store.reconcile(id, &snapshot, &HashMap::new())?;
            match action {
                "open_session" => {
                    let description = self.describe_loaded(&registered, collection)?;
                    let resources = sync_resources(&snapshot, description, &replica.allowed_types);
                    serde_json::to_value(store.open_session(id, &replica, resources, &snapshot)?)
                        .map_err(Into::into)
                }
                "snapshot" => {
                    store.ensure_replica(id, &replica)?;
                    let snapshot_id = required_uuid(input, "snapshot_id")?;
                    let page = input.get("page").and_then(Value::as_str);
                    serde_json::to_value(store.snapshot(id, replica.id, snapshot_id, page)?)
                        .map_err(Into::into)
                }
                "changes" => {
                    store.ensure_replica(id, &replica)?;
                    let after = input.get("after").and_then(Value::as_u64).ok_or_else(|| {
                        ConnectError::AccessDenied("Sync changes cursor is required.".to_string())
                    })?;
                    let limit = input
                        .get("limit")
                        .and_then(Value::as_u64)
                        .unwrap_or(200)
                        .clamp(1, 500) as usize;
                    serde_json::to_value(store.changes(id, replica.id, after, limit)?)
                        .map_err(Into::into)
                }
                "mutate" => {
                    store.assert_mutation_allowed(id)?;
                    store.ensure_replica(id, &replica)?;
                    let mutation: SyncMutation = serde_json::from_value(
                        input.get("mutation").cloned().ok_or_else(|| {
                            ConnectError::AccessDenied(
                                "Sync mutation body is required.".to_string(),
                            )
                        })?,
                    )?;
                    let plan = store.plan_mutation(id, replica.id, &mutation)?;
                    let crate::local_sync::MutationPlan::Apply {
                        operation,
                        input: operation_input,
                        preferred_path,
                    } = plan
                    else {
                        let crate::local_sync::MutationPlan::Return(receipt) = plan else {
                            unreachable!()
                        };
                        store.store_receipt(replica.id, &receipt)?;
                        return serde_json::to_value(receipt).map_err(Into::into);
                    };
                    let result = self.scoped_operation_loaded(
                        &registered,
                        collection,
                        operation,
                        &operation_input,
                        scope,
                    )?;
                    if result.get("valid").and_then(Value::as_bool) != Some(true) {
                        let receipt = SyncMutationReceipt::Rejected {
                            mutation_id: mutation.mutation_id,
                            error: mdbase_connect_protocol::SyncMutationError {
                                code: result
                                    .pointer("/diagnostics/0/code")
                                    .and_then(Value::as_str)
                                    .unwrap_or("mutation_rejected")
                                    .to_string(),
                                message: error_message(&result, "The mutation was rejected."),
                            },
                        };
                        store.store_receipt(replica.id, &receipt)?;
                        return serde_json::to_value(receipt).map_err(Into::into);
                    }
                    let invalidation = operation_invalidation(operation, &operation_input, &result);
                    synchronize(&invalidation);
                    let after = collection.snapshot()?;
                    let preferred = preferred_path
                        .map(|path| HashMap::from([(path, mutation.record_id)]))
                        .unwrap_or_default();
                    store.reconcile(id, &after, &preferred)?;
                    let receipt = store.applied_receipt(id, &mutation)?;
                    store.store_receipt(replica.id, &receipt)?;
                    serde_json::to_value(receipt).map_err(Into::into)
                }
                other => Err(ConnectError::AccessDenied(format!(
                    "Unsupported sync action: {other}"
                ))),
            }
        };
        if action == "mutate" {
            provider.with_collection(execute)
        } else {
            provider.with_collection_read(execute)
        }
    }

    /// Capture a complete provider-neutral authority snapshot without fencing
    /// ordinary mutations. Transfer orchestrators use this for the resumable
    /// bulk stage before the short cutover window.
    pub fn authority_snapshot(&self, id: Uuid) -> Result<AuthoritySnapshot, ConnectError> {
        let registered = self.get(id)?;
        if !registered.enabled {
            return Err(ConnectError::AccessDenied(
                "This collection is disabled on its computer.".to_string(),
            ));
        }
        let provider = self.provider_for(&registered)?;
        let store = crate::LocalSyncStore::for_registry(self);
        provider.with_collection_read(|collection| {
            store.assert_authority_available(id)?;
            self.authority_snapshot_loaded(&registered, collection, &store)
        })
    }

    /// Fence mutations and capture the final source snapshot under the same
    /// provider write gate. The fence is durable across agent restarts.
    pub fn fence_authority(
        &self,
        id: Uuid,
        transfer_id: Uuid,
    ) -> Result<AuthoritySnapshot, ConnectError> {
        let registered = self.get(id)?;
        let provider = self.provider_for(&registered)?;
        let store = crate::LocalSyncStore::for_registry(self);
        provider.with_collection(|collection| {
            let snapshot = collection.snapshot()?;
            store.reconcile(id, &snapshot, &HashMap::new())?;
            store.fence(id, transfer_id)?;
            let description = self.describe_loaded(&registered, collection)?;
            let resources = sync_resources(&snapshot, description, &BTreeSet::new());
            store.export_snapshot(id, &snapshot, resources)
        })
    }

    pub fn resume_authority(&self, id: Uuid, transfer_id: Uuid) -> Result<(), ConnectError> {
        let registered = self.get(id)?;
        let provider = self.provider_for(&registered)?;
        let store = crate::LocalSyncStore::for_registry(self);
        provider.with_collection::<_, ConnectError>(|_| store.resume(id, transfer_id))
    }

    pub fn retire_authority(
        &self,
        id: Uuid,
        transfer_id: Uuid,
        authority_epoch: u64,
    ) -> Result<(), ConnectError> {
        let registered = self.get(id)?;
        let store = crate::LocalSyncStore::for_registry(self);
        if store.is_retired(id)? {
            write_mirror_marker(Path::new(&registered.path), id)?;
            self.connection()?.execute(
                "UPDATE collections SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
                [id.to_string()],
            )?;
            return Ok(());
        }
        let provider = self.provider_for(&registered)?;
        provider.with_collection::<_, ConnectError>(|_| {
            store.retire(id, transfer_id, authority_epoch)?;
            write_mirror_marker(Path::new(&registered.path), id)?;
            self.connection()?.execute(
                "UPDATE collections SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
                [id.to_string()],
            )?;
            Ok(())
        })
    }

    fn authority_snapshot_loaded(
        &self,
        registered: &CollectionSummary,
        collection: &Collection,
        store: &crate::LocalSyncStore,
    ) -> Result<AuthoritySnapshot, ConnectError> {
        let snapshot = collection.snapshot()?;
        store.reconcile(registered.id, &snapshot, &HashMap::new())?;
        let description = self.describe_loaded(registered, collection)?;
        let resources = sync_resources(&snapshot, description, &BTreeSet::new());
        store.export_snapshot(registered.id, &snapshot, resources)
    }

    fn scoped_operation_loaded(
        &self,
        registered: &CollectionSummary,
        collection: &Collection,
        operation: &str,
        input: &Value,
        scope: &GrantScope,
    ) -> Result<Value, ConnectError> {
        let Some(resolved_scope) =
            self.resolve_contract_scope_loaded(registered, collection, scope)?
        else {
            return match operation {
                "describe" => serde_json::to_value(self.describe_loaded(registered, collection)?)
                    .map_err(ConnectError::from),
                "changes" => serde_json::to_value(self.changes(registered.id, input)?)
                    .map_err(ConnectError::from),
                _ => execute_loaded(collection, operation, input),
            };
        };
        let allowed_types = &resolved_scope.allowed_types;

        match operation {
            "describe" => {
                let mut description = self.describe_loaded(registered, collection)?;
                description
                    .types
                    .retain(|type_definition| allowed_types.contains(&type_definition.name));
                description.contracts.retain(|contract| {
                    scope.contracts.iter().any(|pinned| {
                        pinned.id == contract.id && pinned.version == contract.version
                    })
                });
                serde_json::to_value(description).map_err(ConnectError::from)
            }
            "changes" => {
                let mut page = self.changes(registered.id, input)?;
                page.events
                    .retain(|event| change_is_in_scope(event, allowed_types, Some(collection)));
                serde_json::to_value(page).map_err(ConnectError::from)
            }
            "query" => {
                let (input, selector) = resolved_scope
                    .query_input(input)
                    .map_err(contract_scope_error)?;
                let result = execute_loaded(collection, operation, &input)?;
                resolved_scope
                    .project_result(collection, result, selector.as_ref())
                    .map_err(contract_scope_error)
            }
            "list_views"
            | "execute_view"
            | "read_view_source"
            | "create_view_source"
            | "update_view_source"
            | "delete_view_source" => Err(ConnectError::AccessDenied(
                "Saved views require full collection access because their source may select any record type."
                    .to_string(),
            )),
            "read" => {
                let (input, selector) = resolved_scope
                    .read_input(input)
                    .map_err(contract_scope_error)?;
                let result = execute_loaded(collection, operation, &input)?;
                ensure_result_in_scope(&result, allowed_types)?;
                resolved_scope
                    .project_result(collection, result, selector.as_ref())
                    .map_err(contract_scope_error)
            }
            "create" => {
                let (input, selector) = resolved_scope
                    .map_write_input(input, true)
                    .map_err(contract_scope_error)?;
                let frontmatter = input
                    .get("frontmatter")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                let path = input.get("path").and_then(Value::as_str);
                let mut prospective_types = collection.determine_types_for_path(&frontmatter, path);
                if let Some(requested_type) = input.get("type").and_then(Value::as_str) {
                    prospective_types.push(requested_type.to_lowercase());
                }
                ensure_types_in_scope(&prospective_types, allowed_types)?;
                ensure_no_new_out_of_scope_types(
                    &prospective_types,
                    &BTreeSet::new(),
                    allowed_types,
                )?;
                let result = execute_loaded(collection, operation, &input)?;
                if result.get("valid").and_then(Value::as_bool) != Some(false) {
                    ensure_result_in_scope(&result, allowed_types)?;
                }
                resolved_scope
                    .project_result(collection, result, Some(&selector))
                    .map_err(contract_scope_error)
            }
            "update" => {
                let (input, selector) = resolved_scope
                    .map_write_input(input, false)
                    .map_err(contract_scope_error)?;
                let path = required_string(&input, "path")?;
                let current = execute_loaded(collection, "read", &json!({ "path": path }))?;
                ensure_result_in_scope(&current, allowed_types)?;
                let current_types = result_types(&current);
                let mut prospective = current
                    .pointer("/result/frontmatter")
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                if let Some(fields) = input.get("patch").and_then(Value::as_object) {
                    for (field, value) in fields {
                        if value.is_null() {
                            prospective.remove(field);
                        } else {
                            prospective.insert(field.clone(), value.clone());
                        }
                    }
                }
                let prospective_types =
                    collection.determine_types_for_path(&Value::Object(prospective), Some(path));
                ensure_types_in_scope(&prospective_types, allowed_types)?;
                ensure_no_new_out_of_scope_types(
                    &prospective_types,
                    &current_types,
                    allowed_types,
                )?;
                let result = execute_loaded(collection, operation, &input)?;
                resolved_scope
                    .project_result(collection, result, Some(&selector))
                    .map_err(contract_scope_error)
            }
            "delete" => {
                let (scoped_input, selector) = resolved_scope
                    .identity_input(input)
                    .map_err(contract_scope_error)?;
                let path = required_string(&scoped_input, "path")?;
                let current = execute_loaded(collection, "read", &json!({ "path": path }))?;
                ensure_result_in_scope(&current, allowed_types)?;
                resolved_scope
                    .authorize_record_result(collection, &current, selector.as_ref())
                    .map_err(contract_scope_error)?;
                let mut scoped_input = scoped_input;
                if let Some(object) = scoped_input.as_object_mut() {
                    object.insert("check_backlinks".to_string(), Value::Bool(false));
                }
                execute_loaded(collection, operation, &scoped_input)
            }
            "rename" => {
                let (scoped_input, selector) = resolved_scope
                    .identity_input(input)
                    .map_err(contract_scope_error)?;
                let from = required_string(&scoped_input, "from")?;
                let to = required_string(&scoped_input, "to")?;
                if scoped_input.get("update_refs").and_then(Value::as_bool) == Some(true) {
                    return Err(ConnectError::AccessDenied(
                        "Reference updates can affect records outside this application's scope."
                            .to_string(),
                    ));
                }
                let current = execute_loaded(collection, "read", &json!({ "path": from }))?;
                ensure_result_in_scope(&current, allowed_types)?;
                resolved_scope
                    .authorize_record_result(collection, &current, selector.as_ref())
                    .map_err(contract_scope_error)?;
                let current_types = result_types(&current);
                let frontmatter = current
                    .pointer("/result/frontmatter")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                let prospective_types = collection.determine_types_for_path(&frontmatter, Some(to));
                ensure_types_in_scope(&prospective_types, allowed_types)?;
                ensure_no_new_out_of_scope_types(
                    &prospective_types,
                    &current_types,
                    allowed_types,
                )?;
                let result = execute_loaded(collection, operation, &scoped_input)?;
                resolved_scope
                    .project_result(collection, result, selector.as_ref())
                    .map_err(contract_scope_error)
            }
            "validate" => Err(ConnectError::AccessDenied(
                "Collection-wide validation is unavailable to a contract-scoped application."
                    .to_string(),
            )),
            "batch" => Err(ConnectError::AccessDenied(
                "Batch operations require full collection access.".to_string(),
            )),
            "list_types"
            | "read_type"
            | "create_type"
            | "update_type"
            | "install_type_pack" => Err(
                ConnectError::AccessDenied(
                    "Collection schemas can only be managed by an application with full collection access."
                        .to_string(),
                ),
            ),
            other => Err(ConnectError::UnsupportedOperation(other.to_string())),
        }
    }

    fn provider_for(
        &self,
        registered: &CollectionSummary,
    ) -> Result<Arc<FilesystemProvider>, ConnectError> {
        assert_local_authority_folder(Path::new(&registered.path))?;
        let mut providers = self
            .providers
            .lock()
            .map_err(|_| ConnectError::CollectionOpen("provider registry lock poisoned".into()))?;
        if let Some(provider) = providers.get(&registered.id) {
            return Ok(provider.clone());
        }
        let provider = Arc::new(FilesystemProvider::open(Path::new(&registered.path))?);
        providers.insert(registered.id, provider.clone());
        Ok(provider)
    }

    fn resolve_scope_types_loaded(
        &self,
        registered: &CollectionSummary,
        collection: &Collection,
        scope: &GrantScope,
    ) -> Result<Option<BTreeSet<String>>, ConnectError> {
        Ok(self
            .resolve_contract_scope_loaded(registered, collection, scope)?
            .map(|scope| scope.allowed_types))
    }

    fn resolve_contract_scope_loaded(
        &self,
        registered: &CollectionSummary,
        collection: &Collection,
        scope: &GrantScope,
    ) -> Result<Option<ContractScope>, ConnectError> {
        if scope.access == mdbase_connect_protocol::ApplicationAccess::FullCollection {
            return Ok(None);
        }
        if scope.contracts.is_empty() {
            return Err(ConnectError::AccessDenied(
                "Contract-scoped grants must declare at least one required contract.".to_string(),
            ));
        }
        let description = self.describe_loaded(registered, collection)?;
        let mut allowed_types = BTreeSet::new();
        for pinned in &scope.contracts {
            let Some(current) = description
                .contracts
                .iter()
                .find(|contract| contract.id == pinned.id && contract.version == pinned.version)
            else {
                return Err(ConnectError::AccessDenied(format!(
                    "The collection no longer provides {} version {}.",
                    pinned.id, pinned.version
                )));
            };
            if current != pinned {
                return Err(ConnectError::AccessDenied(format!(
                    "The approved provider set for {} version {} has changed.",
                    pinned.id, pinned.version
                )));
            }
            for implementation in &current.implementations {
                allowed_types.insert(implementation.type_name.to_lowercase());
            }
        }
        let resolved = ContractScope::new(scope.contracts.clone()).map_err(contract_scope_error)?;
        debug_assert_eq!(resolved.allowed_types, allowed_types);
        Ok(Some(resolved))
    }

    pub fn describe(&self, id: Uuid) -> Result<CollectionDescription, ConnectError> {
        let registered = self.get(id)?;
        let provider = self.provider_for(&registered)?;
        provider.with_collection_read(|collection| self.describe_loaded(&registered, collection))
    }

    fn describe_loaded(
        &self,
        registered: &CollectionSummary,
        collection: &Collection,
    ) -> Result<CollectionDescription, ConnectError> {
        let mut types = Vec::new();
        let mut contracts = Vec::new();
        let mut configuration = None;
        if collection.spec_profile() == SpecProfile::V03 {
            let report = mdbase::v03::inspect_collection(Path::new(&registered.path));
            if !report.valid {
                let message = report
                    .diagnostics
                    .first()
                    .map(|diagnostic| diagnostic.message.clone())
                    .unwrap_or_else(|| "Collection type metadata is invalid".to_string());
                return Err(ConnectError::CollectionOpen(message));
            }
            configuration = report.config.as_ref().and_then(portable_configuration);
            for type_file in report.types {
                let description = type_file
                    .frontmatter
                    .get("description")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let collection_metadata = type_file.frontmatter.get("collection").cloned();
                let lifecycle = type_file.frontmatter.get("lifecycle").cloned();
                let extensions = type_file
                    .frontmatter
                    .as_object()
                    .into_iter()
                    .flatten()
                    .filter(|(key, _)| key.starts_with("x-"))
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect::<serde_json::Map<_, _>>();
                types.push(CollectionTypeDescriptor {
                    name: type_file.name,
                    version: type_file.version,
                    description,
                    path: Some(type_file.path),
                    definition: type_file
                        .frontmatter
                        .as_object()
                        .cloned()
                        .map(Value::Object),
                    schema: type_file.schema,
                    collection: collection_metadata,
                    lifecycle,
                    extensions,
                });
            }
            contracts = collection
                .list_data_contracts()
                .into_iter()
                .filter_map(|definition| {
                    let implementations = collection
                        .get_data_contract_implementations(&definition.id, &definition.version)
                        .into_iter()
                        .map(|implementation| {
                            mdbase_connect_protocol::CollectionContractImplementationDescriptor {
                                type_name: implementation.type_name,
                                type_version: implementation.type_version,
                                type_path: implementation.source_path,
                                digest: implementation.implementation_digest,
                                fields: implementation.fields,
                                binding: implementation.binding,
                            }
                        })
                        .collect::<Vec<_>>();
                    (!implementations.is_empty()).then_some(CollectionContractDescriptor {
                        implementations,
                        contract_type: definition.contract_type,
                        id: definition.id,
                        version: definition.version,
                        digest: definition.digest,
                        schema: definition
                            .record_schema
                            .expect("record implementations require record_schema"),
                        binding_schema: definition.binding_schema,
                    })
                })
                .collect();
        }
        types.sort_by(|left, right| left.name.cmp(&right.name));
        contracts
            .sort_by(|left, right| (&left.id, &left.version).cmp(&(&right.id, &right.version)));
        Ok(CollectionDescription {
            protocol_version: CONTROL_PROTOCOL_VERSION,
            collection_id: registered.id,
            display_name: registered.display_name.clone(),
            spec_version: registered.spec_version.clone(),
            operations: supported_operations(collection.spec_profile())
                .iter()
                .map(|value| (*value).to_string())
                .collect(),
            change_cursor: self.current_change_cursor(registered.id)?,
            types,
            contracts,
            configuration,
        })
    }

    pub fn append_change(
        &self,
        collection_id: Uuid,
        event: &mdbase::watch::WatchEvent,
    ) -> Result<u64, ConnectError> {
        self.get(collection_id)?;
        let mut payload = event.payload.clone();
        if let Some(object) = payload.as_object_mut() {
            object.remove("before");
            object.remove("after");
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let cursor: i64 = transaction.query_row(
            "SELECT COALESCE(MAX(cursor), 0) + 1 FROM collection_changes WHERE collection_id = ?1",
            [collection_id.to_string()],
            |row| row.get(0),
        )?;
        transaction.execute(
            "INSERT INTO collection_changes
               (collection_id, cursor, event_type, occurred_at, payload)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                collection_id.to_string(),
                cursor,
                event.event_type,
                event.occurred_at,
                serde_json::to_string(&payload)?,
            ],
        )?;
        transaction.execute(
            "DELETE FROM collection_changes WHERE collection_id = ?1 AND cursor <= ?2",
            params![collection_id.to_string(), cursor.saturating_sub(2_000)],
        )?;
        transaction.commit()?;
        Ok(cursor as u64)
    }

    fn refresh_summary_metadata(
        &self,
        collection: &mut CollectionSummary,
    ) -> Result<(), ConnectError> {
        let path = Path::new(&collection.path);
        let metadata = read_collection_metadata(path)?;
        let display_name = collection_display_name(&metadata, path);
        let description = normalized_optional(metadata.description);
        if collection.display_name != display_name
            || collection.description != description
            || collection.spec_version != metadata.spec_version
        {
            self.connection()?.execute(
                "UPDATE collections
                 SET display_name = ?2, description = ?3, spec_version = ?4,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?1",
                params![
                    collection.id.to_string(),
                    display_name,
                    description,
                    metadata.spec_version
                ],
            )?;
            collection.display_name = display_name;
            collection.description = description;
            collection.spec_version = metadata.spec_version;
        }
        Ok(())
    }

    pub fn changes(
        &self,
        collection_id: Uuid,
        input: &Value,
    ) -> Result<CollectionChangesPage, ConnectError> {
        self.get(collection_id)?;
        let current = self.current_change_cursor(collection_id)?;
        let Some(after) = input.get("after").and_then(Value::as_u64) else {
            return Ok(CollectionChangesPage {
                events: Vec::new(),
                cursor: current,
                has_more: false,
                reset: false,
            });
        };
        let limit = input
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(100)
            .clamp(1, 500) as usize;
        let connection = self.connection()?;
        let earliest = connection
            .query_row(
                "SELECT MIN(cursor) FROM collection_changes WHERE collection_id = ?1",
                [collection_id.to_string()],
                |row| row.get::<_, Option<u64>>(0),
            )?
            .unwrap_or(current.saturating_add(1));
        if after.saturating_add(1) < earliest {
            return Ok(CollectionChangesPage {
                events: Vec::new(),
                cursor: current,
                has_more: false,
                reset: true,
            });
        }
        let mut statement = connection.prepare(
            "SELECT cursor, event_type, occurred_at, payload
             FROM collection_changes
             WHERE collection_id = ?1 AND cursor > ?2
             ORDER BY cursor ASC LIMIT ?3",
        )?;
        let rows = statement.query_map(
            params![collection_id.to_string(), after, (limit + 1) as u64],
            |row| {
                Ok((
                    row.get::<_, u64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )?;
        let mut events = rows
            .map(|row| {
                let (cursor, event_type, occurred_at, payload) = row?;
                Ok(CollectionChange {
                    cursor,
                    event_type,
                    occurred_at,
                    payload: serde_json::from_str(&payload)?,
                })
            })
            .collect::<Result<Vec<_>, ConnectError>>()?;
        let has_more = events.len() > limit;
        events.truncate(limit);
        let cursor = events.last().map(|event| event.cursor).unwrap_or(after);
        Ok(CollectionChangesPage {
            events,
            cursor,
            has_more,
            reset: false,
        })
    }

    fn current_change_cursor(&self, collection_id: Uuid) -> Result<u64, ConnectError> {
        let cursor = self.connection()?.query_row(
            "SELECT COALESCE(MAX(cursor), 0) FROM collection_changes WHERE collection_id = ?1",
            [collection_id.to_string()],
            |row| row.get::<_, u64>(0),
        )?;
        Ok(cursor)
    }

    pub fn replace_grants(&self, grants: &[GrantPolicy]) -> Result<(), ConnectError> {
        let active_crypto_keys = grants
            .iter()
            .filter_map(|grant| {
                grant
                    .encryption
                    .as_ref()
                    .map(|encryption| (grant.id.to_string(), encryption.key_id.clone()))
            })
            .collect::<BTreeSet<_>>();
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        transaction.execute("DELETE FROM grants", [])?;
        {
            let mut statement = transaction.prepare(
                "INSERT INTO grants
                   (id, application_id, collection_id, operations, scope, application_name,
                    application_distribution, application_homepage, application_project_url,
                    application_origin, application_icon, collection_name, created_at, encryption,
                    notification_criteria)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
            )?;
            for grant in grants {
                statement.execute(params![
                    grant.id.to_string(),
                    grant.application_id.to_string(),
                    grant.collection_id.to_string(),
                    serde_json::to_string(&grant.operations)?,
                    serde_json::to_string(&grant.scope)?,
                    grant.application_name,
                    grant.application_distribution,
                    grant.application_homepage,
                    grant.application_project_url,
                    grant.application_origin,
                    grant.application_icon,
                    grant.collection_name,
                    grant.created_at,
                    grant
                        .encryption
                        .as_ref()
                        .map(serde_json::to_string)
                        .transpose()?,
                    serde_json::to_string(&grant.notification_criteria)?,
                ])?;
            }
        }
        transaction.execute(
            "DELETE FROM grant_crypto_state WHERE grant_id NOT IN (SELECT id FROM grants)",
            [],
        )?;
        transaction.execute(
            "DELETE FROM grant_crypto_requests WHERE grant_id NOT IN (SELECT id FROM grants)",
            [],
        )?;
        let stored_crypto_keys = {
            let mut statement = transaction.prepare(
                "SELECT grant_id, key_id FROM grant_crypto_state
                 UNION SELECT grant_id, key_id FROM grant_crypto_requests",
            )?;
            let rows = statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        for (grant_id, key_id) in stored_crypto_keys {
            if active_crypto_keys.contains(&(grant_id.clone(), key_id.clone())) {
                continue;
            }
            transaction.execute(
                "DELETE FROM grant_crypto_state WHERE grant_id = ?1 AND key_id = ?2",
                params![grant_id, key_id],
            )?;
            transaction.execute(
                "DELETE FROM grant_crypto_requests WHERE grant_id = ?1 AND key_id = ?2",
                params![grant_id, key_id],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn upsert_grant(&self, grant: &GrantPolicy) -> Result<(), ConnectError> {
        let connection = self.connection()?;
        connection.execute(
            "INSERT INTO grants
               (id, application_id, collection_id, operations, scope, application_name,
                application_distribution, application_homepage, application_project_url,
                application_origin, application_icon, collection_name, created_at, encryption,
                notification_criteria)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
             ON CONFLICT(id) DO UPDATE SET
               application_id = excluded.application_id,
               collection_id = excluded.collection_id,
               operations = excluded.operations,
               scope = excluded.scope,
               application_name = excluded.application_name,
               application_distribution = excluded.application_distribution,
               application_homepage = excluded.application_homepage,
               application_project_url = excluded.application_project_url,
               application_origin = excluded.application_origin,
               application_icon = excluded.application_icon,
               collection_name = excluded.collection_name,
               created_at = excluded.created_at,
               encryption = excluded.encryption,
               notification_criteria = excluded.notification_criteria,
               updated_at = CURRENT_TIMESTAMP",
            params![
                grant.id.to_string(),
                grant.application_id.to_string(),
                grant.collection_id.to_string(),
                serde_json::to_string(&grant.operations)?,
                serde_json::to_string(&grant.scope)?,
                grant.application_name,
                grant.application_distribution,
                grant.application_homepage,
                grant.application_project_url,
                grant.application_origin,
                grant.application_icon,
                grant.collection_name,
                grant.created_at,
                grant
                    .encryption
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()?,
                serde_json::to_string(&grant.notification_criteria)?,
            ],
        )?;
        if let Some(encryption) = &grant.encryption {
            connection.execute(
                "DELETE FROM grant_crypto_state
                 WHERE grant_id = ?1 AND key_id <> ?2",
                params![grant.id.to_string(), encryption.key_id],
            )?;
            connection.execute(
                "DELETE FROM grant_crypto_requests
                 WHERE grant_id = ?1 AND key_id <> ?2",
                params![grant.id.to_string(), encryption.key_id],
            )?;
        } else {
            connection.execute(
                "DELETE FROM grant_crypto_state WHERE grant_id = ?1",
                [grant.id.to_string()],
            )?;
            connection.execute(
                "DELETE FROM grant_crypto_requests WHERE grant_id = ?1",
                [grant.id.to_string()],
            )?;
        }
        Ok(())
    }

    pub fn replace_grant_summaries(&self, grants: &[GrantSummary]) -> Result<(), ConnectError> {
        self.replace_grants(
            &grants
                .iter()
                .map(|grant| GrantPolicy {
                    id: grant.id,
                    application_id: grant.application_id,
                    collection_id: grant.collection_id,
                    operations: grant.operations.clone(),
                    scope: grant.scope.clone(),
                    application_name: grant.application_name.clone(),
                    application_distribution: grant.application_distribution.clone(),
                    application_homepage: grant.application_homepage.clone(),
                    application_project_url: grant.application_project_url.clone(),
                    application_origin: grant.application_origin.clone(),
                    application_icon: grant.application_icon.clone(),
                    collection_name: grant.collection_name.clone(),
                    notification_criteria: grant.notification_criteria.clone(),
                    created_at: grant.created_at.clone(),
                    encryption: grant.encryption.clone(),
                })
                .collect::<Vec<_>>(),
        )
    }

    pub fn list_grants(&self) -> Result<Vec<GrantSummary>, ConnectError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, application_id, application_name, application_distribution,
                    application_homepage, application_project_url, application_origin,
                    application_icon, collection_id, collection_name, operations, scope,
                    created_at, encryption, notification_criteria
             FROM grants ORDER BY application_name COLLATE NOCASE, collection_name COLLATE NOCASE",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, String>(9)?,
                row.get::<_, String>(10)?,
                row.get::<_, String>(11)?,
                row.get::<_, String>(12)?,
                row.get::<_, Option<String>>(13)?,
                row.get::<_, String>(14)?,
            ))
        })?;
        rows.map(|row| {
            let (
                id,
                application_id,
                application_name,
                application_distribution,
                application_homepage,
                application_project_url,
                application_origin,
                application_icon,
                collection_id,
                collection_name,
                operations,
                scope,
                created_at,
                encryption,
                notification_criteria,
            ) = row?;
            Ok(GrantSummary {
                id: parse_registry_uuid(&id)?,
                application_id: parse_registry_uuid(&application_id)?,
                application_name,
                application_distribution,
                application_homepage,
                application_project_url,
                application_origin,
                application_icon,
                collection_id: parse_registry_uuid(&collection_id)?,
                collection_name,
                operations: serde_json::from_str(&operations)?,
                scope: serde_json::from_str(&scope)?,
                notification_criteria: serde_json::from_str(&notification_criteria)?,
                created_at,
                encryption: encryption
                    .as_deref()
                    .map(serde_json::from_str)
                    .transpose()?,
            })
        })
        .collect()
    }

    pub fn set_paused(&self, paused: bool) -> Result<(), ConnectError> {
        self.connection()?.execute(
            "INSERT INTO settings (key, value) VALUES ('access_paused', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP",
            [if paused { "true" } else { "false" }],
        )?;
        Ok(())
    }

    pub fn paused(&self) -> Result<bool, ConnectError> {
        let value = self
            .connection()?
            .query_row(
                "SELECT value FROM settings WHERE key = 'access_paused'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        Ok(value.as_deref() == Some("true"))
    }

    pub fn next_inventory_revision(&self) -> Result<u64, ConnectError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = transaction
            .query_row(
                "SELECT value FROM settings WHERE key = 'inventory_revision'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0);
        let next = current.saturating_add(1);
        transaction.execute(
            "INSERT INTO settings (key, value) VALUES ('inventory_revision', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP",
            [next.to_string()],
        )?;
        transaction.commit()?;
        Ok(next)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn record_activity(
        &self,
        application_id: Uuid,
        application_name: &str,
        collection_id: Uuid,
        collection_name: &str,
        operation: &str,
        outcome: &str,
        detail: Option<&str>,
    ) -> Result<(), ConnectError> {
        self.connection()?.execute(
            "INSERT INTO activity
               (id, application_id, application_name, collection_id, collection_name,
                operation, outcome, detail)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                Uuid::new_v4().to_string(),
                application_id.to_string(),
                application_name,
                collection_id.to_string(),
                collection_name,
                operation,
                outcome,
                detail,
            ],
        )?;
        Ok(())
    }

    pub fn list_activity(&self, limit: usize) -> Result<Vec<ActivityEntry>, ConnectError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, application_id, application_name, collection_id, collection_name,
                    operation, outcome, detail, created_at
             FROM activity ORDER BY created_at DESC, rowid DESC LIMIT ?1",
        )?;
        let rows = statement.query_map([limit.clamp(1, 500) as i64], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, String>(8)?,
            ))
        })?;
        rows.map(|row| {
            let (
                id,
                application_id,
                application_name,
                collection_id,
                collection_name,
                operation,
                outcome,
                detail,
                created_at,
            ) = row?;
            Ok(ActivityEntry {
                id: parse_registry_uuid(&id)?,
                application_id: parse_registry_uuid(&application_id)?,
                application_name,
                collection_id: parse_registry_uuid(&collection_id)?,
                collection_name,
                operation,
                outcome,
                detail,
                created_at,
            })
        })
        .collect()
    }

    pub fn grant_context(&self, grant_id: Uuid) -> Result<Option<GrantSummary>, ConnectError> {
        Ok(self
            .list_grants()?
            .into_iter()
            .find(|grant| grant.id == grant_id))
    }

    /// Atomically claims a fresh encrypted request or returns its durable response receipt.
    ///
    /// Authentication must happen before this call so unauthenticated traffic cannot advance the
    /// durable replay window. The immediate transaction makes concurrent duplicate deliveries
    /// deterministic across relay sessions and process threads.
    pub fn claim_encrypted_request(
        &self,
        grant_id: Uuid,
        key_id: &str,
        counter: u64,
        request_id: Uuid,
        request_fingerprint: &str,
    ) -> Result<EncryptedRequestClaim, ConnectError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let state = transaction
            .query_row(
                "SELECT last_request_counter, reorder_floor FROM grant_crypto_state
                 WHERE grant_id = ?1 AND key_id = ?2",
                params![grant_id.to_string(), key_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?
            .map(
                |(last, floor)| -> Result<(u64, u64), std::num::ParseIntError> {
                    Ok((last.parse::<u64>()?, floor.parse::<u64>()?))
                },
            )
            .transpose()
            .map_err(|_| ConnectError::EncryptedRelayRejected)?;
        let existing = transaction
            .query_row(
                "SELECT request_fingerprint, response_envelope FROM grant_crypto_requests
                 WHERE grant_id = ?1 AND key_id = ?2 AND request_id = ?3",
                params![grant_id.to_string(), key_id, request_id.to_string()],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .optional()?;
        if let Some((fingerprint, response)) = existing {
            if fingerprint != request_fingerprint {
                return Err(ConnectError::EncryptedRelayRejected);
            }
            transaction.commit()?;
            return Ok(match response {
                Some(response) => EncryptedRequestClaim::Completed(response),
                None => EncryptedRequestClaim::InProgress,
            });
        }
        let duplicate_counter = transaction
            .query_row(
                "SELECT 1 FROM grant_crypto_requests
                 WHERE grant_id = ?1 AND key_id = ?2 AND request_counter = ?3",
                params![grant_id.to_string(), key_id, counter.to_string()],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        let reorder_floor = state.map_or(0, |(_, floor)| floor);
        if duplicate_counter || counter <= reorder_floor {
            return Err(ConnectError::EncryptedRelayRejected);
        }
        let last = state.map_or(counter, |(last, _)| last.max(counter));
        let reorder_floor = reorder_floor.max(last.saturating_sub(ENCRYPTED_REPLAY_WINDOW));
        transaction.execute(
            "INSERT INTO grant_crypto_state
               (grant_id, key_id, last_request_counter, reorder_floor)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(grant_id, key_id) DO UPDATE SET
               last_request_counter = excluded.last_request_counter,
               reorder_floor = excluded.reorder_floor",
            params![
                grant_id.to_string(),
                key_id,
                last.to_string(),
                reorder_floor.to_string()
            ],
        )?;
        transaction.execute(
            "INSERT INTO grant_crypto_requests
               (grant_id, key_id, request_id, request_counter, request_fingerprint)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                grant_id.to_string(),
                key_id,
                request_id.to_string(),
                counter.to_string(),
                request_fingerprint
            ],
        )?;
        transaction.execute(
            "DELETE FROM grant_crypto_requests
             WHERE grant_id = ?1 AND key_id = ?2 AND response_envelope IS NOT NULL
               AND rowid NOT IN (
               SELECT rowid FROM grant_crypto_requests
               WHERE grant_id = ?1 AND key_id = ?2
                 AND response_envelope IS NOT NULL
               ORDER BY rowid DESC LIMIT 1024
             )",
            params![grant_id.to_string(), key_id],
        )?;
        transaction.commit()?;
        Ok(EncryptedRequestClaim::Fresh)
    }

    pub fn complete_encrypted_request(
        &self,
        grant_id: Uuid,
        key_id: &str,
        request_id: Uuid,
        request_fingerprint: &str,
        response_envelope: &str,
    ) -> Result<(), ConnectError> {
        let updated = self.connection()?.execute(
            "UPDATE grant_crypto_requests SET response_envelope = ?5
             WHERE grant_id = ?1 AND key_id = ?2 AND request_id = ?3
               AND request_fingerprint = ?4 AND response_envelope IS NULL",
            params![
                grant_id.to_string(),
                key_id,
                request_id.to_string(),
                request_fingerprint,
                response_envelope
            ],
        )?;
        if updated != 1 {
            return Err(ConnectError::EncryptedRelayRejected);
        }
        Ok(())
    }

    pub fn encrypted_request_response(
        &self,
        grant_id: Uuid,
        key_id: &str,
        request_id: Uuid,
        request_fingerprint: &str,
    ) -> Result<Option<String>, ConnectError> {
        self.connection()?
            .query_row(
                "SELECT response_envelope FROM grant_crypto_requests
                 WHERE grant_id = ?1 AND key_id = ?2 AND request_id = ?3
                   AND request_fingerprint = ?4",
                params![
                    grant_id.to_string(),
                    key_id,
                    request_id.to_string(),
                    request_fingerprint
                ],
                |row| row.get(0),
            )
            .optional()
            .map_err(ConnectError::from)
    }

    pub fn authorizes(
        &self,
        grant_id: Uuid,
        application_id: Uuid,
        collection_id: Uuid,
        operation: &str,
    ) -> Result<bool, ConnectError> {
        let operations = self
            .connection()?
            .query_row(
                "SELECT operations FROM grants
                 WHERE id = ?1 AND application_id = ?2 AND collection_id = ?3",
                params![
                    grant_id.to_string(),
                    application_id.to_string(),
                    collection_id.to_string()
                ],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let Some(operations) = operations else {
            return Ok(false);
        };
        let operations: Vec<String> = serde_json::from_str(&operations)?;
        Ok(operations.iter().any(|allowed| allowed == operation))
    }
}

fn parse_registry_uuid(value: &str) -> Result<Uuid, ConnectError> {
    Uuid::parse_str(value).map_err(|error| {
        ConnectError::CollectionOpen(format!("invalid UUID in connector registry: {error}"))
    })
}

fn portable_configuration(configuration: &Value) -> Option<Value> {
    let source = configuration.as_object()?;
    let mut result = serde_json::Map::new();
    if let Some(spec_version) = source.get("spec_version") {
        result.insert("spec_version".to_string(), spec_version.clone());
    }
    if let Some(settings) = select_configuration_fields(
        source.get("settings"),
        &[
            "types_folder",
            "record_extensions",
            "validation",
            "explicit_type_keys",
            "id_field",
            "include_subfolders",
            "exclude",
        ],
    ) {
        result.insert("settings".to_string(), settings);
    }
    if let Some(runtime) = select_configuration_fields(
        source.get("runtime"),
        &["profile_version", "enabled", "contract_mode", "policy"],
    ) {
        result.insert("runtime".to_string(), runtime);
    }
    Some(Value::Object(result))
}

fn select_configuration_fields(value: Option<&Value>, fields: &[&str]) -> Option<Value> {
    let source = value?.as_object()?;
    let selected = fields
        .iter()
        .filter_map(|field| {
            source
                .get(*field)
                .map(|value| ((*field).to_string(), value.clone()))
        })
        .collect::<serde_json::Map<_, _>>();
    Some(Value::Object(selected))
}

fn required_string<'a>(input: &'a Value, key: &str) -> Result<&'a str, ConnectError> {
    input.get(key).and_then(Value::as_str).ok_or_else(|| {
        ConnectError::AccessDenied(format!("Scoped operation requires a valid '{key}' value."))
    })
}

fn required_uuid(input: &Value, key: &str) -> Result<Uuid, ConnectError> {
    let value = required_string(input, key)?;
    Uuid::parse_str(value)
        .map_err(|_| ConnectError::AccessDenied(format!("Sync request '{key}' must be a UUID.")))
}

fn sync_resources(
    snapshot: &mdbase::runtime::CollectionSnapshot,
    mut description: CollectionDescription,
    allowed_types: &BTreeSet<String>,
) -> SyncCollectionResources {
    if !allowed_types.is_empty() {
        description
            .types
            .retain(|type_definition| allowed_types.contains(&type_definition.name));
        for contract in &mut description.contracts {
            contract
                .implementations
                .retain(|implementation| allowed_types.contains(&implementation.type_name));
        }
        description
            .contracts
            .retain(|contract| !contract.implementations.is_empty());
    }
    let type_paths = description
        .types
        .iter()
        .filter_map(|type_definition| type_definition.path.as_deref())
        .collect::<BTreeSet<_>>();
    let documents = snapshot
        .resources
        .iter()
        .filter(|resource| {
            matches!(
                resource.kind,
                mdbase::runtime::CollectionSnapshotResourceKind::Configuration
                    | mdbase::runtime::CollectionSnapshotResourceKind::Contract
                    | mdbase::runtime::CollectionSnapshotResourceKind::Schema
                    | mdbase::runtime::CollectionSnapshotResourceKind::View
            ) || type_paths.contains(resource.path.as_str())
        })
        .map(|resource| SyncResourceDocument {
            path: resource.path.clone(),
            kind: match resource.kind {
                mdbase::runtime::CollectionSnapshotResourceKind::Configuration => {
                    "configuration".to_string()
                }
                mdbase::runtime::CollectionSnapshotResourceKind::Contract => "contract".to_string(),
                mdbase::runtime::CollectionSnapshotResourceKind::Schema => "schema".to_string(),
                mdbase::runtime::CollectionSnapshotResourceKind::Type => "type".to_string(),
                mdbase::runtime::CollectionSnapshotResourceKind::View => "view".to_string(),
            },
            revision: resource.revision.clone(),
            document: resource.document.clone(),
        })
        .collect::<Vec<_>>();
    SyncCollectionResources {
        revision: snapshot.resource_revision.clone(),
        spec_version: snapshot.spec_version.clone(),
        types: description.types,
        contracts: description.contracts,
        documents,
    }
}

fn contract_scope_error(error: ContractScopeError) -> ConnectError {
    ConnectError::AccessDenied(error.0)
}

fn ensure_result_in_scope(
    result: &Value,
    allowed_types: &BTreeSet<String>,
) -> Result<(), ConnectError> {
    let types = result.pointer("/result/types").and_then(Value::as_array);
    let Some(types) = types else {
        if result.get("valid").and_then(Value::as_bool) == Some(false)
            && result.pointer("/result/frontmatter").is_none()
        {
            return Ok(());
        }
        return Err(ConnectError::AccessDenied(
            "The connector could not verify the record's type scope.".to_string(),
        ));
    };
    let types = types
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect::<Vec<_>>();
    ensure_types_in_scope(&types, allowed_types)
}

fn ensure_types_in_scope(
    types: &[String],
    allowed_types: &BTreeSet<String>,
) -> Result<(), ConnectError> {
    if types
        .iter()
        .any(|type_name| allowed_types.contains(&type_name.to_lowercase()))
    {
        return Ok(());
    }
    Err(ConnectError::AccessDenied(
        "The requested record is outside this application's record scope.".to_string(),
    ))
}

fn result_types(result: &Value) -> BTreeSet<String> {
    result
        .pointer("/result/types")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_lowercase)
        .collect()
}

fn ensure_no_new_out_of_scope_types(
    prospective_types: &[String],
    current_types: &BTreeSet<String>,
    allowed_types: &BTreeSet<String>,
) -> Result<(), ConnectError> {
    let introduces_out_of_scope_type = prospective_types.iter().any(|type_name| {
        let type_name = type_name.to_lowercase();
        !allowed_types.contains(&type_name) && !current_types.contains(&type_name)
    });
    if introduces_out_of_scope_type {
        return Err(ConnectError::AccessDenied(
            "The write would add the record to a type outside this application's scope."
                .to_string(),
        ));
    }
    Ok(())
}

fn change_is_in_scope(
    event: &CollectionChange,
    allowed_types: &BTreeSet<String>,
    collection: Option<&Collection>,
) -> bool {
    if event.event_type == "mdbase.config.changed" {
        return true;
    }
    if event.event_type == "mdbase.type.changed" {
        return event
            .payload
            .get("path")
            .and_then(Value::as_str)
            .and_then(|path| Path::new(path).file_stem())
            .and_then(|name| name.to_str())
            .is_some_and(|name| allowed_types.contains(&name.to_lowercase()));
    }
    let types = ["types", "previous_types"]
        .into_iter()
        .filter_map(|key| event.payload.get(key).and_then(Value::as_array))
        .flatten()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>();
    if !types.is_empty() {
        return types
            .iter()
            .any(|type_name| allowed_types.contains(&type_name.to_lowercase()));
    }
    let current_path = match event.event_type.as_str() {
        "mdbase.record.created" | "mdbase.record.modified" => {
            event.payload.get("path").and_then(Value::as_str)
        }
        "mdbase.record.renamed" => event.payload.get("to").and_then(Value::as_str),
        _ => None,
    };
    let (Some(collection), Some(path)) = (collection, current_path) else {
        return false;
    };
    collection
        .read(&json!({ "path": path }))
        .get("types")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .any(|type_name| allowed_types.contains(&type_name.to_lowercase()))
}

#[derive(Debug, serde::Deserialize)]
struct CollectionMetadata {
    spec_version: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
struct MirrorMarker {
    version: u8,
    role: String,
    collection_id: Uuid,
}

fn assert_local_authority_folder(root: &Path) -> Result<(), ConnectError> {
    if let Some(collection_id) = mirror_collection_id(root)? {
        return Err(ConnectError::MirrorCannotRegister { collection_id });
    }
    Ok(())
}

pub fn mirror_collection_id(root: &Path) -> Result<Option<Uuid>, ConnectError> {
    let marker_directory = root.join(MIRROR_MARKER_DIRECTORY);
    let directory_metadata = match fs::symlink_metadata(&marker_directory) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if directory_metadata.file_type().is_symlink() || !directory_metadata.is_dir() {
        return Err(ConnectError::InvalidMirrorMarker(format!(
            "{} must be an ordinary directory.",
            marker_directory.display()
        )));
    }
    let marker_path = marker_directory.join(MIRROR_MARKER_FILE);
    let marker_metadata = match fs::symlink_metadata(&marker_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if marker_metadata.file_type().is_symlink() || !marker_metadata.is_file() {
        return Err(ConnectError::InvalidMirrorMarker(format!(
            "{} must be an ordinary file.",
            marker_path.display()
        )));
    }
    let marker: MirrorMarker =
        serde_json::from_str(&fs::read_to_string(&marker_path)?).map_err(|error| {
            ConnectError::InvalidMirrorMarker(format!(
                "{} could not be read: {error}",
                marker_path.display()
            ))
        })?;
    if marker.version != 1 || marker.role != "mirror" {
        return Err(ConnectError::InvalidMirrorMarker(format!(
            "{} has an unsupported role or version.",
            marker_path.display()
        )));
    }
    Ok(Some(marker.collection_id))
}

fn write_mirror_marker(root: &Path, collection_id: Uuid) -> Result<(), ConnectError> {
    let marker_directory = root.join(MIRROR_MARKER_DIRECTORY);
    match fs::symlink_metadata(&marker_directory) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(ConnectError::InvalidMirrorMarker(format!(
                "{} must be an ordinary directory.",
                marker_directory.display()
            )));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&marker_directory)?;
        }
        Err(error) => return Err(error.into()),
    }
    let marker_path = marker_directory.join(MIRROR_MARKER_FILE);
    if let Some(existing) = mirror_collection_id(root)? {
        return if existing == collection_id {
            Ok(())
        } else {
            Err(ConnectError::InvalidMirrorMarker(format!(
                "{} belongs to another collection.",
                marker_path.display()
            )))
        };
    }
    let mut temporary = NamedTempFile::new_in(&marker_directory)?;
    temporary.write_all(
        serde_json::to_string_pretty(&json!({
            "version": 1,
            "role": "mirror",
            "collection_id": collection_id,
        }))?
        .as_bytes(),
    )?;
    temporary.write_all(b"\n")?;
    temporary.as_file().sync_all()?;
    temporary
        .persist(&marker_path)
        .map_err(|error| ConnectError::Io(error.error))?;
    Ok(())
}

fn remove_mirror_marker(root: &Path, collection_id: Uuid) -> Result<(), ConnectError> {
    if mirror_collection_id(root)? != Some(collection_id) {
        return Err(ConnectError::InvalidMirrorMarker(
            "Mirror role marker belongs to another collection.".to_string(),
        ));
    }
    fs::remove_file(root.join(MIRROR_MARKER_DIRECTORY).join(MIRROR_MARKER_FILE))?;
    Ok(())
}

fn ensure_collection_id(root: &Path) -> Result<Uuid, ConnectError> {
    if let Some(id) = collection_identity(root)? {
        return Ok(id);
    }
    let id = Uuid::new_v4();
    write_collection_id(root, id)?;
    Ok(id)
}

fn read_collection_id(root: &Path) -> Result<Option<Uuid>, ConnectError> {
    collection_identity(root)
}

pub fn collection_identity(root: &Path) -> Result<Option<Uuid>, ConnectError> {
    let config_path = root.join("mdbase.yaml");
    let source = fs::read_to_string(&config_path)?;
    let config: serde_yaml::Value = serde_yaml::from_str(&source)?;
    let mapping = config.as_mapping().ok_or_else(|| {
        ConnectError::CollectionOpen("mdbase.yaml must contain a YAML mapping.".to_string())
    })?;
    let extension_key = serde_yaml::Value::String(CONNECT_EXTENSION.to_string());
    let collection_id_key = serde_yaml::Value::String(CONNECT_COLLECTION_ID.to_string());

    if let Some(value) = mapping
        .get(&extension_key)
        .and_then(serde_yaml::Value::as_mapping)
        .and_then(|extension| extension.get(&collection_id_key))
    {
        let value = value.as_str().ok_or_else(|| {
            ConnectError::CollectionOpen(format!(
                "{CONNECT_EXTENSION}.{CONNECT_COLLECTION_ID} must be a UUID string."
            ))
        })?;
        return Uuid::parse_str(value).map(Some).map_err(|_| {
            ConnectError::CollectionOpen(format!(
                "{CONNECT_EXTENSION}.{CONNECT_COLLECTION_ID} must be a valid UUID."
            ))
        });
    }
    Ok(None)
}

fn write_collection_id(root: &Path, id: Uuid) -> Result<(), ConnectError> {
    update_collection_identity(root, id, false)
}

fn set_collection_identity(root: &Path, id: Uuid) -> Result<(), ConnectError> {
    update_collection_identity(root, id, true)
}

fn update_collection_identity(
    root: &Path,
    id: Uuid,
    require_matching_existing: bool,
) -> Result<(), ConnectError> {
    let config_path = root.join("mdbase.yaml");
    let source = fs::read_to_string(&config_path)?;
    let mut config: serde_yaml::Value = serde_yaml::from_str(&source)?;
    let mapping = config.as_mapping_mut().ok_or_else(|| {
        ConnectError::CollectionOpen("mdbase.yaml must contain a YAML mapping.".to_string())
    })?;
    let extension_key = serde_yaml::Value::String(CONNECT_EXTENSION.to_string());
    let collection_id_key = serde_yaml::Value::String(CONNECT_COLLECTION_ID.to_string());
    let extension = mapping
        .entry(extension_key)
        .or_insert_with(|| serde_yaml::Value::Mapping(serde_yaml::Mapping::new()));
    let extension = extension.as_mapping_mut().ok_or_else(|| {
        ConnectError::CollectionOpen(format!("{CONNECT_EXTENSION} must be a YAML mapping."))
    })?;
    if require_matching_existing {
        if let Some(existing) = extension
            .get(&collection_id_key)
            .and_then(serde_yaml::Value::as_str)
        {
            if existing != id.to_string() {
                return Err(ConnectError::CollectionOpen(
                    "This folder already has a different mdbase connect collection identity."
                        .to_string(),
                ));
            }
        }
    }
    extension.insert(collection_id_key, serde_yaml::Value::String(id.to_string()));

    persist_collection_configuration(root, &config_path, &config)
}

fn clear_collection_identity(root: &Path) -> Result<(), ConnectError> {
    let config_path = root.join("mdbase.yaml");
    let source = fs::read_to_string(&config_path)?;
    let mut config: serde_yaml::Value = serde_yaml::from_str(&source)?;
    let mapping = config.as_mapping_mut().ok_or_else(|| {
        ConnectError::CollectionOpen("mdbase.yaml must contain a YAML mapping.".to_string())
    })?;
    let extension_key = serde_yaml::Value::String(CONNECT_EXTENSION.to_string());
    let collection_id_key = serde_yaml::Value::String(CONNECT_COLLECTION_ID.to_string());
    let remove_extension = if let Some(extension) = mapping
        .get_mut(&extension_key)
        .and_then(serde_yaml::Value::as_mapping_mut)
    {
        extension.remove(&collection_id_key);
        extension.is_empty()
    } else {
        false
    };
    if remove_extension {
        mapping.remove(&extension_key);
    }
    persist_collection_configuration(root, &config_path, &config)
}

fn persist_collection_configuration(
    root: &Path,
    config_path: &Path,
    config: &serde_yaml::Value,
) -> Result<(), ConnectError> {
    let serialized = serde_yaml::to_string(&config)?;
    let permissions = fs::metadata(config_path)?.permissions();
    let mut temporary = NamedTempFile::new_in(root)?;
    temporary.as_file().set_permissions(permissions)?;
    temporary.write_all(serialized.as_bytes())?;
    temporary.as_file().sync_all()?;
    temporary
        .persist(config_path)
        .map_err(|error| ConnectError::Io(error.error))?;
    Ok(())
}

fn read_collection_metadata(root: &Path) -> Result<CollectionMetadata, ConnectError> {
    let source = fs::read_to_string(root.join("mdbase.yaml"))?;
    Ok(serde_yaml::from_str(&source)?)
}

fn collection_display_name(metadata: &CollectionMetadata, path: &Path) -> String {
    metadata
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .or_else(|| {
            path.file_name()
                .map(|name| name.to_string_lossy().to_string())
        })
        .unwrap_or_else(|| "Collection".to_string())
}

fn normalized_optional(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn error_message(value: &Value, fallback: &str) -> String {
    value
        .pointer("/error/message")
        .or_else(|| value.pointer("/diagnostics/0/message"))
        .or_else(|| value.get("message"))
        .and_then(Value::as_str)
        .unwrap_or(fallback)
        .to_string()
}

fn has_contract(
    available: &[CollectionContractDescriptor],
    required: &ContractRequirement,
) -> bool {
    available
        .iter()
        .any(|contract| contract.id == required.id && contract.version == required.version)
}

fn execute_loaded(
    collection: &Collection,
    operation: &str,
    input: &Value,
) -> Result<Value, ConnectError> {
    if collection.spec_profile() == SpecProfile::V03 {
        if operation == "install_type_pack" {
            let provision =
                serde_json::from_value::<TypePackProvision>(input.clone()).map_err(|error| {
                    ConnectError::InvalidInput(format!(
                        "The type-pack provision is invalid: {error}"
                    ))
                })?;
            let manifest = serde_json::to_value(&provision.manifest)?;
            let resources = provision
                .resources
                .iter()
                .map(|resource| mdbase::v03::TypePackResource {
                    source: resource.source.clone(),
                    document: resource.document.clone(),
                })
                .collect::<Vec<_>>();
            return serde_json::to_value(
                collection.install_type_pack(&manifest, &resources, false),
            )
            .map_err(ConnectError::from);
        }
        let operations = collection
            .v03_operations()
            .map_err(|diagnostic| ConnectError::CollectionOpen(diagnostic.message.clone()))?;
        let result = match operation {
            "read" => operations.read(input),
            "query" => operations.query(input),
            "list_views" => operations.list_views(input),
            "execute_view" => operations.execute_view(input),
            "read_view_source" => operations.read_view_source(input),
            "create_view_source" => operations.create_view_source(input),
            "update_view_source" => operations.update_view_source(input),
            "delete_view_source" => operations.delete_view_source(input),
            "validate" => operations.validate(input),
            "batch" => operations.batch(input),
            "create" => operations.create(input),
            "update" => operations.update(input),
            "delete" => operations.delete(input),
            "rename" => operations.rename(input),
            "list_types" => operations.list_types(input),
            "read_type" => operations.read_type(input),
            "create_type" => operations.create_type(input),
            "update_type" => operations.update_type(input),
            other => return Err(ConnectError::UnsupportedOperation(other.to_string())),
        };
        return serde_json::to_value(result).map_err(ConnectError::from);
    }

    let result = match operation {
        "read" => {
            let request = serde_json::from_value::<mdbase::api::ReadRequest>(input.clone())
                .map_err(|error| mdbase::api::MdbaseError::InvalidRequest {
                    message: error.to_string(),
                });
            typed_result(collection, request, |typed, request| typed.read(request))
        }
        "query" => {
            let request = parse_v02_query(input);
            typed_result(collection, request, |typed, request| typed.query(request))
        }
        "validate" => collection.validate_op(input),
        "create" | "update" | "delete" | "rename" => migration_required_result(operation),
        other => return Err(ConnectError::UnsupportedOperation(other.to_string())),
    };
    Ok(result)
}

fn typed_result<Request, Output>(
    collection: &Collection,
    request: Result<Request, mdbase::api::MdbaseError>,
    execute: impl FnOnce(
        mdbase::api::TypedCollection<'_>,
        Request,
    ) -> mdbase::api::MdbaseResult<mdbase::api::OperationOutcome<Output>>,
) -> Value
where
    Output: serde::Serialize,
{
    let result =
        request.and_then(|request| collection.typed().and_then(|typed| execute(typed, request)));
    match result {
        Ok(outcome) => json!({
            "valid": true,
            "result": outcome.value,
            "diagnostics": outcome.diagnostics,
        }),
        Err(error) => typed_error_result(error),
    }
}

fn typed_error_result(error: mdbase::api::MdbaseError) -> Value {
    use mdbase::api::MdbaseError;

    let (code, message, diagnostics) = match error {
        MdbaseError::InvalidPath(error) => ("invalid_path", error.to_string(), Vec::<Value>::new()),
        MdbaseError::UnsupportedProfile => (
            "migration_required",
            "This operation requires migrating the collection to v0.3.".to_string(),
            Vec::new(),
        ),
        MdbaseError::MigrationRequired { operation } => (
            "migration_required",
            format!("Operation '{operation}' requires migrating this v0.2 collection to v0.3."),
            Vec::new(),
        ),
        MdbaseError::LossyMigration { diagnostics } => (
            "migration_lossy",
            "The v0.2 migration requires explicit approval for lossy translations.".to_string(),
            diagnostics
                .into_iter()
                .map(|diagnostic| json!(diagnostic))
                .collect(),
        ),
        MdbaseError::InvalidRequest { message } => ("invalid_request", message, Vec::new()),
        MdbaseError::Operation { diagnostics } => (
            "operation_failed",
            "The mdbase operation failed.".to_string(),
            diagnostics
                .into_iter()
                .map(|diagnostic| json!(diagnostic))
                .collect(),
        ),
        MdbaseError::InvalidResult { message } => ("invalid_result", message, Vec::new()),
    };
    let diagnostics = if diagnostics.is_empty() {
        vec![json!({
            "severity": "error",
            "code": code,
            "message": message,
        })]
    } else {
        diagnostics
    };
    json!({
        "valid": false,
        "result": {},
        "diagnostics": diagnostics,
    })
}

fn migration_required_result(operation: &str) -> Value {
    json!({
        "valid": false,
        "result": {},
        "diagnostics": [{
            "severity": "error",
            "code": "migration_required",
            "message": format!(
                "Operation '{operation}' requires migrating this v0.2 collection to v0.3."
            ),
        }],
    })
}

fn parse_v02_query(input: &Value) -> mdbase::api::MdbaseResult<mdbase::api::QueryRequest> {
    use mdbase::api::MdbaseError;

    let input = input.get("query").unwrap_or(input);
    let source = input
        .as_object()
        .ok_or_else(|| MdbaseError::InvalidRequest {
            message: "query input must be an object".to_string(),
        })?;
    const SUPPORTED: &[&str] = &[
        "types",
        "context",
        "projections",
        "where",
        "select",
        "order_by",
        "group_by",
        "groupBy",
        "limit",
        "offset",
        "snapshot",
        "include_body",
        "frontmatter",
    ];
    if let Some(field) = source
        .keys()
        .find(|field| !SUPPORTED.contains(&field.as_str()))
    {
        return Err(MdbaseError::InvalidRequest {
            message: format!("v0.2 compatibility queries do not support the '{field}' constraint"),
        });
    }

    let mut typed = source.clone();
    if let Some(context) = typed.get("context").cloned() {
        let path = context
            .as_str()
            .or_else(|| context.pointer("/this/path").and_then(Value::as_str))
            .ok_or_else(|| MdbaseError::InvalidRequest {
                message: "query context must identify this.path".to_string(),
            })?;
        typed.insert("context".to_string(), Value::String(path.to_string()));
    }
    if let Some(projections) = typed.get("projections").and_then(Value::as_object) {
        let projections = projections
            .iter()
            .map(|(name, value)| {
                value
                    .as_str()
                    .or_else(|| value.get("expr").and_then(Value::as_str))
                    .map(|expression| (name.clone(), Value::String(expression.to_string())))
                    .ok_or_else(|| MdbaseError::InvalidRequest {
                        message: format!("query projection '{name}' must contain an expression"),
                    })
            })
            .collect::<Result<serde_json::Map<_, _>, _>>()?;
        typed.insert("projections".to_string(), Value::Object(projections));
    }
    if !typed.contains_key("group_by") {
        if let Some(group_by) = typed.remove("groupBy") {
            typed.insert("group_by".to_string(), group_by);
        }
    } else {
        typed.remove("groupBy");
    }

    serde_json::from_value(Value::Object(typed)).map_err(|error| MdbaseError::InvalidRequest {
        message: error.to_string(),
    })
}

fn is_collection_mutation(operation: &str) -> bool {
    matches!(
        operation,
        "batch"
            | "create"
            | "update"
            | "delete"
            | "rename"
            | "create_type"
            | "update_type"
            | "install_type_pack"
            | "create_view_source"
            | "update_view_source"
            | "delete_view_source"
    )
}

fn operation_invalidation(
    operation: &str,
    input: &Value,
    output: &Value,
) -> CollectionInvalidation {
    if input.get("dry_run").and_then(Value::as_bool) == Some(true)
        || !is_collection_mutation(operation)
        || output.get("valid").and_then(Value::as_bool) == Some(false)
        || output.get("error").is_some()
    {
        return CollectionInvalidation::None;
    }
    if matches!(
        operation,
        "create_type"
            | "update_type"
            | "install_type_pack"
            | "create_view_source"
            | "update_view_source"
            | "delete_view_source"
    ) {
        return CollectionInvalidation::All;
    }

    let Ok(kind) = operation.parse::<mdbase::runtime::OperationKind>() else {
        return CollectionInvalidation::All;
    };
    let Ok(result) = serde_json::from_value::<mdbase::v03::OperationResult>(output.clone()) else {
        // Legacy profiles do not expose the portable operation envelope. The
        // operation is still valid, but a full reload is the only safe hint.
        return CollectionInvalidation::All;
    };
    let paths = mdbase::runtime::OperationRequest::new(kind, input.clone()).affected_paths(&result);
    if paths.is_empty() {
        CollectionInvalidation::All
    } else {
        CollectionInvalidation::Records(paths)
    }
}

fn supported_operations(profile: SpecProfile) -> &'static [&'static str] {
    if profile != SpecProfile::V03 {
        return &[
            "describe",
            "changes",
            "read",
            "query",
            "validate",
            "list_timers",
            "put_timer",
            "cancel_timer",
            "reconcile_timers",
            "sync",
        ];
    }
    &[
        "describe",
        "changes",
        "read",
        "query",
        "list_views",
        "execute_view",
        "read_view_source",
        "create_view_source",
        "update_view_source",
        "delete_view_source",
        "validate",
        "create",
        "update",
        "delete",
        "rename",
        "read_type",
        "create_type",
        "update_type",
        "install_type_pack",
        "list_timers",
        "put_timer",
        "cancel_timer",
        "reconcile_timers",
        "sync",
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};
    use std::thread;
    use tempfile::tempdir;

    fn mark_mirror(root: &Path, collection_id: Uuid) {
        let directory = root.join(MIRROR_MARKER_DIRECTORY);
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join(MIRROR_MARKER_FILE),
            serde_json::to_vec_pretty(&json!({
                "version": 1,
                "role": "mirror",
                "collection_id": collection_id,
            }))
            .unwrap(),
        )
        .unwrap();
    }

    fn write_work_item_contract(root: &Path) {
        fs::write(
            root.join("_contracts/example.work-item.md"),
            r#"---
kind: mdbase.contract
contract_type: record
id: example.work-item
version: 1.0.0
record_schema:
  dialect: json-schema-2020-12
  value:
    type: object
    required: [title]
    additionalProperties: false
    properties:
      title: { type: string }
      status: { type: string }
---
"#,
        )
        .unwrap();
    }

    fn work_item_scope(registry: &CollectionRegistry, collection_id: Uuid) -> GrantScope {
        let description = registry.describe(collection_id).unwrap();
        let contract = description
            .contracts
            .into_iter()
            .find(|contract| contract.id == "example.work-item")
            .expect("example.work-item is advertised");
        GrantScope {
            contracts: vec![contract],
            access: mdbase_connect_protocol::ApplicationAccess::Contract,
        }
    }

    fn unavailable_contract_scope() -> GrantScope {
        GrantScope {
            contracts: vec![CollectionContractDescriptor {
                contract_type: "record".to_string(),
                id: "some.app".to_string(),
                version: "1.0.0".to_string(),
                digest: format!("sha256:{}", "0".repeat(64)),
                schema: json!({"type": "object"}),
                binding_schema: None,
                implementations: Vec::new(),
            }],
            access: mdbase_connect_protocol::ApplicationAccess::Contract,
        }
    }

    #[test]
    fn portable_mutation_results_produce_targeted_invalidations() {
        let output = serde_json::to_value(mdbase::v03::OperationResult {
            valid: true,
            result: json!({
                "from": "old.md",
                "to": "new.md",
                "references_updated": [{"path": "linked.md"}],
            }),
            diagnostics: vec![],
        })
        .unwrap();
        assert_eq!(
            operation_invalidation(
                "rename",
                &json!({"from": "old.md", "to": "new.md"}),
                &output,
            ),
            CollectionInvalidation::Records(
                ["linked.md", "new.md", "old.md"]
                    .into_iter()
                    .map(str::to_string)
                    .collect()
            )
        );
        assert_eq!(
            operation_invalidation(
                "update",
                &json!({"path": "private.md"}),
                &json!({"valid": false}),
            ),
            CollectionInvalidation::None,
        );
        assert_eq!(
            operation_invalidation(
                "rename",
                &json!({"from": "old.md", "to": "new.md", "dry_run": true}),
                &json!({"valid": true, "result": {"would_rename": true}}),
            ),
            CollectionInvalidation::None,
        );
        assert_eq!(
            operation_invalidation("update_type", &json!({}), &json!({"valid": true})),
            CollectionInvalidation::All,
        );
    }

    #[test]
    fn create_register_list_and_remove_collection() {
        let state = tempdir().unwrap();
        let collection_parent = tempdir().unwrap();
        let root = collection_parent.path().join("workouts");
        let registry = CollectionRegistry::open(state.path()).unwrap();

        let created = registry.create(&root, Some("Workouts")).unwrap();
        assert_eq!(created.display_name, "Workouts");
        assert_eq!(created.spec_version, "0.3.0");
        assert!(root.join("mdbase.yaml").exists());
        assert!(root.join("_types").is_dir());

        let listed = registry.list().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, created.id);

        let removed = registry.remove(created.id).unwrap();
        assert_eq!(removed.id, created.id);
        assert!(
            root.exists(),
            "unregistering must not delete collection files"
        );
        assert!(registry.list().unwrap().is_empty());
    }

    #[test]
    fn mirror_cannot_be_registered_as_an_authority() {
        let state = tempdir().unwrap();
        let collection_parent = tempdir().unwrap();
        let root = collection_parent.path().join("mirror");
        let registry = CollectionRegistry::open(state.path()).unwrap();
        let collection_id = Uuid::new_v4();

        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("mdbase.yaml"), "spec_version: 0.3.0\n").unwrap();
        mark_mirror(&root, collection_id);

        assert!(matches!(
            registry.add(&root),
            Err(ConnectError::MirrorCannotRegister { collection_id: actual })
                if actual == collection_id
        ));
        assert_eq!(read_collection_id(&root).unwrap(), None);
        assert!(registry.list().unwrap().is_empty());
    }

    #[test]
    fn verified_mirror_authority_activation_is_idempotent_and_reversible() {
        let state = tempdir().unwrap();
        let collection_parent = tempdir().unwrap();
        let root = collection_parent.path().join("mirror");
        let registry = CollectionRegistry::open(state.path()).unwrap();
        let collection_id = Uuid::new_v4();
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("mdbase.yaml"),
            "spec_version: 0.3.0\nname: Promoted\n",
        )
        .unwrap();
        mark_mirror(&root, collection_id);

        let promoted = registry
            .activate_mirror_authority(&root, collection_id)
            .unwrap();
        assert_eq!(promoted.id, collection_id);
        assert!(promoted.enabled);
        assert_eq!(collection_identity(&root).unwrap(), Some(collection_id));
        assert_eq!(mirror_collection_id(&root).unwrap(), None);
        assert_eq!(
            registry
                .activate_mirror_authority(&root, collection_id)
                .unwrap()
                .id,
            collection_id
        );

        registry
            .rollback_mirror_authority(&root, collection_id, false, false)
            .unwrap();
        assert!(registry.list().unwrap().is_empty());
        assert_eq!(collection_identity(&root).unwrap(), None);
        assert_eq!(mirror_collection_id(&root).unwrap(), Some(collection_id));
    }

    #[test]
    fn authority_activation_refuses_a_different_mirror_identity_without_changes() {
        let state = tempdir().unwrap();
        let collection_parent = tempdir().unwrap();
        let root = collection_parent.path().join("mirror");
        let registry = CollectionRegistry::open(state.path()).unwrap();
        let marker_id = Uuid::new_v4();
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("mdbase.yaml"), "spec_version: 0.3.0\n").unwrap();
        mark_mirror(&root, marker_id);

        let error = registry
            .activate_mirror_authority(&root, Uuid::new_v4())
            .unwrap_err();
        assert_eq!(error.code(), "invalid_mirror_marker");
        assert_eq!(mirror_collection_id(&root).unwrap(), Some(marker_id));
        assert_eq!(collection_identity(&root).unwrap(), None);
        assert!(registry.list().unwrap().is_empty());
    }

    #[test]
    fn authority_rollback_restores_a_retired_local_registration() {
        let state = tempdir().unwrap();
        let collection_parent = tempdir().unwrap();
        let root = collection_parent.path().join("notes");
        let registry = CollectionRegistry::open(state.path()).unwrap();
        let created = registry.create(&root, Some("Notes")).unwrap();
        registry.set_enabled(created.id, false).unwrap();
        mark_mirror(&root, created.id);

        assert!(
            registry
                .activate_mirror_authority(&root, created.id)
                .unwrap()
                .enabled
        );
        registry
            .rollback_mirror_authority(&root, created.id, true, true)
            .unwrap();

        let restored = registry.get(created.id).unwrap();
        assert!(!restored.enabled);
        assert_eq!(restored.path, root.to_string_lossy());
        assert_eq!(collection_identity(&root).unwrap(), Some(created.id));
        assert_eq!(mirror_collection_id(&root).unwrap(), Some(created.id));
    }

    #[test]
    fn a_registered_folder_stops_being_available_when_it_becomes_a_mirror() {
        let state = tempdir().unwrap();
        let collection_parent = tempdir().unwrap();
        let root = collection_parent.path().join("notes");
        let registry = CollectionRegistry::open(state.path()).unwrap();
        let created = registry.create(&root, Some("Notes")).unwrap();
        let mirror_collection_id = Uuid::new_v4();

        mark_mirror(&root, mirror_collection_id);

        assert!(!registry.get(created.id).unwrap().enabled);
        assert!(!registry.list().unwrap()[0].enabled);
        assert!(matches!(
            registry.operation(created.id, "describe", &json!({})),
            Err(ConnectError::MirrorCannotRegister { collection_id })
                if collection_id == mirror_collection_id
        ));
        assert!(matches!(
            registry.set_enabled(created.id, true),
            Err(ConnectError::MirrorCannotRegister { collection_id })
                if collection_id == mirror_collection_id
        ));
    }

    #[test]
    fn a_malformed_mirror_marker_fails_closed() {
        let state = tempdir().unwrap();
        let collection_parent = tempdir().unwrap();
        let root = collection_parent.path().join("mirror");
        let registry = CollectionRegistry::open(state.path()).unwrap();

        fs::create_dir_all(root.join(MIRROR_MARKER_DIRECTORY)).unwrap();
        fs::write(root.join("mdbase.yaml"), "spec_version: 0.3.0\n").unwrap();
        fs::write(
            root.join(MIRROR_MARKER_DIRECTORY).join(MIRROR_MARKER_FILE),
            "{broken",
        )
        .unwrap();

        assert!(matches!(
            registry.add(&root),
            Err(ConnectError::InvalidMirrorMarker(_))
        ));
        assert!(registry.list().unwrap().is_empty());
    }

    #[test]
    fn authority_transfer_fence_is_durable_exclusive_and_idempotent() {
        let state = tempdir().unwrap();
        let collection_parent = tempdir().unwrap();
        let root = collection_parent.path().join("transfer");
        let registry = CollectionRegistry::open(state.path()).unwrap();
        let collection = registry.create(&root, Some("Transfer")).unwrap();
        fs::write(
            root.join("one.md"),
            "---\ntitle: One\n---\nOriginal body.\n",
        )
        .unwrap();

        let first = registry.authority_snapshot(collection.id).unwrap();
        assert_eq!(first.collection_id, collection.id);
        assert_eq!(first.records.len(), 1);
        assert_eq!(first.resources.documents[0].path, "mdbase.yaml");
        assert_eq!(first.manifest_digest.len(), 64);
        let record_id = first.records[0].record.record_id;

        fs::rename(root.join("one.md"), root.join("renamed.md")).unwrap();
        let renamed = registry.authority_snapshot(collection.id).unwrap();
        assert_eq!(renamed.records[0].record.record_id, record_id);
        assert_eq!(renamed.records[0].record.path, "renamed.md");
        assert_eq!(
            renamed.records[0].document,
            fs::read_to_string(root.join("renamed.md")).unwrap()
        );

        let transfer_id = Uuid::new_v4();
        let fenced = registry
            .fence_authority(collection.id, transfer_id)
            .unwrap();
        assert_eq!(fenced.manifest_digest, renamed.manifest_digest);
        assert!(registry
            .operation(collection.id, "describe", &json!({}))
            .is_ok());
        for result in [
            registry.operation(
                collection.id,
                "create",
                &json!({
                    "path": "blocked.md",
                    "frontmatter": {"title": "Blocked"},
                }),
            ),
            registry
                .update_metadata(collection.id, "Blocked", None)
                .map(|value| serde_json::to_value(value).unwrap()),
            registry
                .set_enabled(collection.id, false)
                .map(|value| serde_json::to_value(value).unwrap()),
            registry
                .make_independent(collection.id)
                .map(|value| serde_json::to_value(value).unwrap()),
            registry
                .remove(collection.id)
                .map(|value| serde_json::to_value(value).unwrap()),
        ] {
            assert!(matches!(
                result,
                Err(ConnectError::AuthorityTransferInProgress {
                    transfer_id: actual
                }) if actual == transfer_id
            ));
        }
        let full_scope = GrantScope::full_collection();
        assert!(matches!(
            registry.scoped_operation(
                collection.id,
                "create",
                &json!({
                    "path": "scoped-blocked.md",
                    "frontmatter": {"title": "Scoped blocked"},
                }),
                &full_scope,
            ),
            Err(ConnectError::AuthorityTransferInProgress {
                transfer_id: actual
            }) if actual == transfer_id
        ));
        assert!(matches!(
            registry.sync_operation_synchronized(
                collection.id,
                &json!({"action": "mutate"}),
                crate::LocalReplica {
                    id: Uuid::new_v4(),
                    name: "Test replica".to_string(),
                    mode: mdbase_connect_protocol::SyncReplicaMode::ReadWrite,
                    allowed_types: BTreeSet::new(),
                },
                &full_scope,
                |_| {},
            ),
            Err(ConnectError::AuthorityTransferInProgress {
                transfer_id: actual
            }) if actual == transfer_id
        ));
        assert!(!root.join("blocked.md").exists());
        assert!(matches!(
            registry.resume_authority(collection.id, Uuid::new_v4()),
            Err(ConnectError::AuthorityTransferMismatch)
        ));

        drop(registry);
        let reopened = CollectionRegistry::open(state.path()).unwrap();
        assert!(matches!(
            reopened.operation(
                collection.id,
                "create",
                &json!({
                    "path": "still-blocked.md",
                    "frontmatter": {"title": "Still blocked"},
                }),
            ),
            Err(ConnectError::AuthorityTransferInProgress {
                transfer_id: actual
            }) if actual == transfer_id
        ));
        reopened
            .resume_authority(collection.id, transfer_id)
            .unwrap();
        let resumed = reopened
            .operation(
                collection.id,
                "create",
                &json!({
                    "path": "resumed.md",
                    "frontmatter": {"title": "Resumed"},
                }),
            )
            .unwrap();
        assert_eq!(resumed["valid"], true, "{resumed}");

        let final_transfer_id = Uuid::new_v4();
        reopened
            .fence_authority(collection.id, final_transfer_id)
            .unwrap();
        reopened
            .retire_authority(collection.id, final_transfer_id, 2)
            .unwrap();
        reopened
            .retire_authority(collection.id, final_transfer_id, 2)
            .unwrap();
        assert!(!reopened.get(collection.id).unwrap().enabled);
        let marker: Value = serde_json::from_str(
            &fs::read_to_string(root.join(".mdbase/connect-role.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(marker["role"], "mirror");
        assert_eq!(marker["collection_id"], collection.id.to_string());
        assert!(matches!(
            reopened.set_enabled(collection.id, true),
            Err(ConnectError::MirrorCannotRegister {
                collection_id: actual
            }) if actual == collection.id
        ));
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_mirror_marker_fails_closed() {
        use std::os::unix::fs::symlink;

        let state = tempdir().unwrap();
        let collection_parent = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let root = collection_parent.path().join("mirror");
        let registry = CollectionRegistry::open(state.path()).unwrap();

        fs::create_dir_all(root.join(MIRROR_MARKER_DIRECTORY)).unwrap();
        fs::write(root.join("mdbase.yaml"), "spec_version: 0.3.0\n").unwrap();
        let target = outside.path().join(MIRROR_MARKER_FILE);
        fs::write(
            &target,
            serde_json::to_vec(&json!({
                "version": 1,
                "role": "mirror",
                "collection_id": Uuid::new_v4(),
            }))
            .unwrap(),
        )
        .unwrap();
        symlink(
            &target,
            root.join(MIRROR_MARKER_DIRECTORY).join(MIRROR_MARKER_FILE),
        )
        .unwrap();

        assert!(matches!(
            registry.add(&root),
            Err(ConnectError::InvalidMirrorMarker(_))
        ));
        assert!(registry.list().unwrap().is_empty());
    }

    #[test]
    fn collection_identity_survives_a_folder_move() {
        let state = tempdir().unwrap();
        let collection_parent = tempdir().unwrap();
        let original = collection_parent.path().join("notes");
        let moved = collection_parent.path().join("archive");
        let registry = CollectionRegistry::open(state.path()).unwrap();

        let created = registry.create(&original, Some("Notes")).unwrap();
        let config: serde_yaml::Value =
            serde_yaml::from_str(&fs::read_to_string(original.join("mdbase.yaml")).unwrap())
                .unwrap();
        assert_eq!(
            config[CONNECT_EXTENSION][CONNECT_COLLECTION_ID],
            created.id.to_string()
        );

        fs::rename(&original, &moved).unwrap();
        let registered_after_move = registry.add(&moved).unwrap();

        assert_eq!(registered_after_move.id, created.id);
        assert_eq!(
            Path::new(&registered_after_move.path),
            moved.canonicalize().unwrap()
        );
        assert_eq!(registry.list().unwrap().len(), 1);
    }

    #[test]
    fn copied_collection_identity_is_rejected_while_the_original_is_registered() {
        let state = tempdir().unwrap();
        let collection_parent = tempdir().unwrap();
        let original = collection_parent.path().join("notes");
        let copy = collection_parent.path().join("notes-copy");
        let registry = CollectionRegistry::open(state.path()).unwrap();

        let created = registry.create(&original, Some("Notes")).unwrap();
        fs::create_dir_all(&copy).unwrap();
        fs::copy(original.join("mdbase.yaml"), copy.join("mdbase.yaml")).unwrap();
        fs::create_dir_all(copy.join("_types")).unwrap();

        assert!(matches!(
            registry.add(&copy),
            Err(ConnectError::DuplicateCollectionIdentity {
                collection_id,
                existing_path,
            }) if collection_id == created.id
                && Path::new(&existing_path) == original.canonicalize().unwrap()
        ));
    }

    #[test]
    fn copied_collection_can_be_registered_with_a_new_identity() {
        let state = tempdir().unwrap();
        let collection_parent = tempdir().unwrap();
        let original = collection_parent.path().join("notes");
        let copy = collection_parent.path().join("notes-copy");
        let registry = CollectionRegistry::open(state.path()).unwrap();

        let created = registry.create(&original, Some("Notes")).unwrap();
        fs::create_dir_all(&copy).unwrap();
        fs::copy(original.join("mdbase.yaml"), copy.join("mdbase.yaml")).unwrap();
        fs::create_dir_all(copy.join("_types")).unwrap();

        let registered_copy = registry.add_copy(&copy).unwrap();
        assert_ne!(registered_copy.id, created.id);
        assert_eq!(registry.get(created.id).unwrap().id, created.id);
        assert_eq!(
            read_collection_id(&original).unwrap(),
            Some(created.id),
            "registering the copy must never rewrite the original"
        );
        assert_eq!(read_collection_id(&copy).unwrap(), Some(registered_copy.id));
        assert_eq!(registry.list().unwrap().len(), 2);
    }

    #[test]
    fn new_identity_command_refuses_the_registered_original() {
        let state = tempdir().unwrap();
        let collection_parent = tempdir().unwrap();
        let original = collection_parent.path().join("notes");
        let registry = CollectionRegistry::open(state.path()).unwrap();
        let created = registry.create(&original, Some("Notes")).unwrap();

        assert!(matches!(
            registry.add_copy(&original),
            Err(ConnectError::NotARegisteredCollectionCopy(message))
                if message.contains("registered original")
        ));
        assert_eq!(read_collection_id(&original).unwrap(), Some(created.id));
    }

    #[test]
    fn registered_conflict_can_become_independent_without_moving_files() {
        let state = tempdir().unwrap();
        let collection_parent = tempdir().unwrap();
        let root = collection_parent.path().join("notes");
        let registry = CollectionRegistry::open(state.path()).unwrap();
        let created = registry.create(&root, Some("Notes")).unwrap();

        let independent = registry.make_independent(created.id).unwrap();

        assert_ne!(independent.id, created.id);
        assert_eq!(independent.path, created.path);
        assert_eq!(read_collection_id(&root).unwrap(), Some(independent.id));
        assert!(matches!(
            registry.get(created.id),
            Err(ConnectError::CollectionNotFound(id)) if id == created.id
        ));
        assert_eq!(registry.list().unwrap().len(), 1);
    }

    #[test]
    fn inventory_revisions_are_monotonic_across_registry_restarts() {
        let state = tempdir().unwrap();
        let registry = CollectionRegistry::open(state.path()).unwrap();
        assert_eq!(registry.next_inventory_revision().unwrap(), 1);
        assert_eq!(registry.next_inventory_revision().unwrap(), 2);
        drop(registry);

        let reopened = CollectionRegistry::open(state.path()).unwrap();
        assert_eq!(reopened.next_inventory_revision().unwrap(), 3);
    }

    #[test]
    fn collection_metadata_refreshes_edits_and_disabled_collections_fail_closed() {
        let state = tempdir().unwrap();
        let collection_parent = tempdir().unwrap();
        let root = collection_parent.path().join("notes");
        let registry = CollectionRegistry::open(state.path()).unwrap();
        let created = registry.create(&root, Some("Notes")).unwrap();
        assert_eq!(created.description, None);

        let config_path = root.join("mdbase.yaml");
        let mut config: serde_yaml::Value =
            serde_yaml::from_str(&fs::read_to_string(&config_path).unwrap()).unwrap();
        let mapping = config.as_mapping_mut().unwrap();
        mapping.insert(
            serde_yaml::Value::String("name".to_string()),
            serde_yaml::Value::String("External name".to_string()),
        );
        mapping.insert(
            serde_yaml::Value::String("description".to_string()),
            serde_yaml::Value::String("Changed outside the app".to_string()),
        );
        mapping.insert(
            serde_yaml::Value::String("x-preview".to_string()),
            serde_yaml::from_str("{ keep: true }").unwrap(),
        );
        fs::write(&config_path, serde_yaml::to_string(&config).unwrap()).unwrap();

        let refreshed = registry.list().unwrap().remove(0);
        assert_eq!(refreshed.display_name, "External name");
        assert_eq!(
            refreshed.description.as_deref(),
            Some("Changed outside the app")
        );

        let updated = registry
            .update_metadata(created.id, "Edited safely", Some("A useful collection"))
            .unwrap();
        assert_eq!(updated.display_name, "Edited safely");
        assert_eq!(updated.description.as_deref(), Some("A useful collection"));
        let persisted: serde_yaml::Value =
            serde_yaml::from_str(&fs::read_to_string(&config_path).unwrap()).unwrap();
        assert_eq!(persisted["x-preview"]["keep"], true);

        let disabled = registry.set_enabled(created.id, false).unwrap();
        assert!(!disabled.enabled);
        assert!(matches!(
            registry.scoped_operation(
                created.id,
                "describe",
                &json!({}),
                &GrantScope {
                    contracts: vec![],
                    access: mdbase_connect_protocol::ApplicationAccess::FullCollection,
                }
            ),
            Err(ConnectError::AccessDenied(message)) if message.contains("disabled")
        ));
    }

    #[test]
    fn generic_operation_uses_v03_envelope() {
        let state = tempdir().unwrap();
        let collection_parent = tempdir().unwrap();
        let root = collection_parent.path().join("notes");
        let registry = CollectionRegistry::open(state.path()).unwrap();
        let collection = registry.create(&root, Some("Notes")).unwrap();

        let result = registry
            .operation(
                collection.id,
                "create",
                &json!({
                    "path": "hello.md",
                    "frontmatter": { "title": "Hello" },
                    "body": "World"
                }),
            )
            .unwrap();
        assert_eq!(result["valid"], true);
        assert!(result["result"]["revision"].as_str().is_some());
        for field in [
            "path",
            "revision",
            "types",
            "frontmatter",
            "effective_frontmatter",
            "body",
            "file",
        ] {
            assert!(
                result["result"].get(field).is_some(),
                "create omitted {field}: {result:#}"
            );
        }

        let read = registry
            .operation(collection.id, "read", &json!({ "path": "hello.md" }))
            .unwrap();
        assert_eq!(read["valid"], true);
        assert_eq!(read["result"]["frontmatter"]["title"], "Hello");
        assert_eq!(read["result"]["effective_frontmatter"]["title"], "Hello");

        let update = registry
            .operation(
                collection.id,
                "update",
                &json!({ "path": "hello.md", "patch": { "status": "done" } }),
            )
            .unwrap();
        assert_eq!(update["valid"], true);
        assert_eq!(update["result"]["frontmatter"]["status"], "done");
        assert_eq!(update["result"]["effective_frontmatter"]["status"], "done");
        assert_eq!(update["result"]["file"]["name"], "hello.md");
    }

    #[test]
    fn legacy_description_only_advertises_executable_operations() {
        let state = tempdir().unwrap();
        let collection_parent = tempdir().unwrap();
        let root = collection_parent.path().join("legacy");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("mdbase.yaml"), "spec_version: 0.2.1\n").unwrap();
        let registry = CollectionRegistry::open(state.path()).unwrap();
        let collection = registry.add(&root).unwrap();

        let description = registry.describe(collection.id).unwrap();

        assert!(description.operations.contains(&"read".to_string()));
        assert!(description.operations.contains(&"query".to_string()));
        assert!(description.operations.contains(&"validate".to_string()));
        for operation in ["create", "update", "delete", "rename"] {
            assert!(!description.operations.contains(&operation.to_string()));
        }
        assert!(!description.operations.contains(&"read_type".to_string()));
    }

    #[test]
    fn legacy_records_are_read_only_until_explicit_migration() {
        let state = tempdir().unwrap();
        let collection_parent = tempdir().unwrap();
        let root = collection_parent.path().join("legacy");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("mdbase.yaml"), "spec_version: 0.2.1\n").unwrap();
        let document = "---\ntitle: Legacy\n---\nBody\n";
        fs::write(root.join("legacy.md"), document).unwrap();
        let registry = CollectionRegistry::open(state.path()).unwrap();
        let collection = registry.add(&root).unwrap();

        let read = registry
            .operation(collection.id, "read", &json!({"path": "legacy.md"}))
            .unwrap();
        assert_eq!(read["valid"], true, "{read}");
        assert_eq!(read["result"]["frontmatter"]["title"], "Legacy");

        let query = registry
            .operation(
                collection.id,
                "query",
                &json!({"where": "title == 'Legacy'", "include_body": true}),
            )
            .unwrap();
        assert_eq!(query["valid"], true, "{query}");
        assert_eq!(query["result"]["results"].as_array().unwrap().len(), 1);
        assert_eq!(query["result"]["results"][0]["body"], "Body\n");

        let unsupported_query = registry
            .operation(collection.id, "query", &json!({"folder": "private"}))
            .unwrap();
        assert_eq!(unsupported_query["valid"], false, "{unsupported_query}");
        assert_eq!(
            unsupported_query["diagnostics"][0]["code"],
            "invalid_request"
        );

        let operations = [
            (
                "create",
                json!({
                    "path": "new.md",
                    "frontmatter": {"title": "New"},
                    "body": ""
                }),
            ),
            (
                "update",
                json!({"path": "legacy.md", "patch": {"title": "Changed"}}),
            ),
            ("delete", json!({"path": "legacy.md"})),
            ("rename", json!({"from": "legacy.md", "to": "renamed.md"})),
        ];
        for (operation, input) in operations {
            let result = registry
                .operation(collection.id, operation, &input)
                .unwrap();
            assert_eq!(result["valid"], false, "{operation}: {result}");
            assert_eq!(
                result["diagnostics"][0]["code"], "migration_required",
                "{operation}: {result}"
            );
        }
        assert_eq!(
            fs::read_to_string(root.join("legacy.md")).unwrap(),
            document
        );
        assert!(!root.join("new.md").exists());
        assert!(!root.join("renamed.md").exists());
    }

    #[test]
    fn type_operations_are_revision_safe_and_require_full_collection_scope() {
        let state = tempdir().unwrap();
        let collection_parent = tempdir().unwrap();
        let root = collection_parent.path().join("typed");
        let registry = CollectionRegistry::open(state.path()).unwrap();
        let collection = registry.create(&root, Some("Typed")).unwrap();
        let document = r#"---
kind: mdbase.type
name: project
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    properties:
      title: { type: string }
---
"#;

        let created = registry
            .operation(collection.id, "create_type", &json!({"document": document}))
            .unwrap();
        assert_eq!(created["valid"], true, "{created}");
        assert_eq!(created["result"]["path"], "_types/project.md");
        let revision = created["result"]["revision"].as_str().unwrap();

        let read = registry
            .operation(collection.id, "read_type", &json!({"name": "project"}))
            .unwrap();
        assert_eq!(read["result"]["revision"], revision);

        let updated = registry
            .operation(
                collection.id,
                "update_type",
                &json!({
                    "name": "project",
                    "if_revision": revision,
                    "document": document.replace("version: 1", "version: 2")
                }),
            )
            .unwrap();
        assert_eq!(updated["valid"], true, "{updated}");
        assert_ne!(updated["result"]["revision"], revision);

        let contract_scope = unavailable_contract_scope();
        assert!(matches!(
            registry.scoped_operation(
                collection.id,
                "read_type",
                &json!({"name": "project"}),
                &contract_scope
            ),
            Err(ConnectError::AccessDenied(_))
        ));
    }

    #[test]
    fn installs_type_packs_as_full_collection_operations_and_provisions_idempotently() {
        let state = tempdir().unwrap();
        let collection_parent = tempdir().unwrap();
        let root = collection_parent.path().join("provisioned");
        let registry = CollectionRegistry::open(state.path()).unwrap();
        let collection = registry.create(&root, Some("Provisioned")).unwrap();
        let requirements = ApplicationRequirements {
            contracts: vec![ContractRequirement {
                id: "workout.record".to_string(),
                version: "1.0.0".to_string(),
            }],
            ..Default::default()
        };
        let contract_document = r#"---
kind: mdbase.contract
contract_type: record
id: workout.record
version: 1.0.0
record_schema:
  dialect: json-schema-2020-12
  value:
    type: object
    additionalProperties: false
    properties:
      type: { const: workout }
---
"#;
        let type_document = r#"---
kind: mdbase.type
name: workout
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    properties:
      type: { const: workout }
implements:
  - contract: workout.record
    version: 1.0.0
    fields:
      type: type
---
"#;
        let auxiliary_document = r#"---
kind: mdbase.type
name: workout_note
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    properties:
      type: { const: workout_note }
---
"#;
        let resources = [
            (
                "contract.md",
                "_contracts/workout.record.md",
                "contract",
                contract_document,
            ),
            ("workout.md", "_types/workout.md", "type", type_document),
            (
                "workout-note.md",
                "_types/workout_note.md",
                "type",
                auxiliary_document,
            ),
        ];
        let provision = TypePackProvision {
            manifest: mdbase_connect_protocol::TypePackManifest {
                kind: "mdbase.type-pack".to_string(),
                id: "example.workout".to_string(),
                version: "1.0.0".to_string(),
                name: Some("Workout".to_string()),
                description: None,
                resources: resources
                    .iter()
                    .map(|(source, target, kind, document)| {
                        mdbase_connect_protocol::TypePackManifestResource {
                            kind: (*kind).to_string(),
                            source: (*source).to_string(),
                            target: (*target).to_string(),
                            digest: format!("sha256:{:x}", Sha256::digest(document.as_bytes())),
                        }
                    })
                    .collect(),
                extensions: Default::default(),
            },
            resources: resources
                .iter()
                .map(
                    |(source, _, _, document)| mdbase_connect_protocol::TypePackSourceResource {
                        source: (*source).to_string(),
                        document: (*document).to_string(),
                    },
                )
                .collect(),
            provides: requirements.contracts.clone(),
        };
        let installed = registry
            .operation(
                collection.id,
                "install_type_pack",
                &serde_json::to_value(&provision).unwrap(),
            )
            .unwrap();
        assert_eq!(installed["valid"], true, "{installed}");
        assert_eq!(installed["result"]["id"], "example.workout");
        assert_eq!(
            installed["result"]["resources"].as_array().unwrap().len(),
            3
        );
        assert!(matches!(
            registry.scoped_operation(
                collection.id,
                "install_type_pack",
                &serde_json::to_value(&provision).unwrap(),
                &unavailable_contract_scope()
            ),
            Err(ConnectError::AccessDenied(_))
        ));

        let provisions = [provision];

        let contracts = registry
            .provision_type_packs(collection.id, &requirements, &provisions)
            .unwrap();
        assert!(contracts.iter().any(|contract| {
            contract.id == requirements.contracts[0].id
                && contract.version == requirements.contracts[0].version
        }));
        assert!(root.join("_contracts/workout.record.md").is_file());
        assert!(root.join("_types/workout.md").is_file());
        assert!(root.join("_types/workout_note.md").is_file());
        registry
            .provision_type_packs(collection.id, &requirements, &provisions)
            .unwrap();
    }

    #[test]
    fn scoped_conditional_writers_share_one_collection_serialization_gate() {
        let state = tempdir().unwrap();
        let collection_parent = tempdir().unwrap();
        let root = collection_parent.path().join("tasks");
        let registry = CollectionRegistry::open(state.path()).unwrap();
        let collection = registry.create(&root, Some("Tasks")).unwrap();
        write_work_item_contract(&root);
        fs::write(
            root.join("_types/task.md"),
            r#"---
kind: mdbase.type
name: task
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    additionalProperties: true
    properties:
      type: { const: task }
      title: { type: string }
implements:
  - contract: example.work-item
    version: 1.0.0
    fields:
      title: title
---
"#,
        )
        .unwrap();
        let created = registry
            .operation(
                collection.id,
                "create",
                &json!({
                    "path": "task.md",
                    "type": "task",
                    "frontmatter": {"type": "task", "title": "Original"},
                }),
            )
            .unwrap();
        assert_eq!(created["valid"], true, "{created}");
        let revision = created["result"]["revision"]
            .as_str()
            .expect("create result has a revision")
            .to_string();
        let scope = work_item_scope(&registry, collection.id);
        let barrier = Arc::new(Barrier::new(3));

        let writers = ["First", "Second"].map(|title| {
            let registry = registry.clone();
            let barrier = barrier.clone();
            let scope = scope.clone();
            let revision = revision.clone();
            thread::spawn(move || {
                barrier.wait();
                registry
                    .scoped_operation(
                        collection.id,
                        "update",
                        &json!({
                            "path": "task.md",
                            "patch": {"title": title},
                            "if_revision": revision,
                        }),
                        &scope,
                    )
                    .unwrap()
            })
        });
        barrier.wait();
        let results = writers.map(|writer| writer.join().unwrap());

        assert_eq!(
            results
                .iter()
                .filter(|result| result["valid"] == true)
                .count(),
            1
        );
        assert_eq!(
            results
                .iter()
                .filter(|result| result["valid"] == false)
                .count(),
            1
        );
        assert!(results.iter().any(|result| {
            result["diagnostics"].as_array().is_some_and(|diagnostics| {
                diagnostics
                    .iter()
                    .any(|diagnostic| diagnostic["code"] == "concurrent_modification")
            })
        }));
    }

    #[test]
    fn describe_exposes_complete_portable_type_metadata_without_absolute_paths() {
        let state = tempdir().unwrap();
        let collection_parent = tempdir().unwrap();
        let root = collection_parent.path().join("tasks");
        let registry = CollectionRegistry::open(state.path()).unwrap();
        let collection = registry.create(&root, Some("Tasks")).unwrap();
        fs::write(
            root.join("mdbase.yaml"),
            r#"spec_version: 0.3.0
settings:
  validation: warn
  x-private: not-for-apps
runtime:
  profile_version: 0.1.0
  enabled: false
x-private:
  token: not-for-apps
"#,
        )
        .unwrap();
        write_work_item_contract(&root);
        fs::write(
            root.join("_contracts/example.unimplemented.md"),
            r#"---
kind: mdbase.contract
contract_type: record
id: example.unimplemented
version: 1.0.0
record_schema:
  dialect: json-schema-2020-12
  value: { type: object }
---
"#,
        )
        .unwrap();
        fs::write(
            root.join("_types/task.md"),
            r#"---
kind: mdbase.type
name: task
version: 2
description: A portable task.
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    properties:
      title: { type: string }
implements:
  - contract: example.work-item
    version: 1.0.0
    fields:
      title: title
---
"#,
        )
        .unwrap();

        let description = registry.describe(collection.id).unwrap();
        assert_eq!(description.protocol_version, 1);
        assert_eq!(
            description.types[0].schema["properties"]["title"]["type"],
            "string"
        );
        assert_eq!(description.types[0].path.as_deref(), Some("_types/task.md"));
        assert_eq!(
            description.types[0]
                .definition
                .as_ref()
                .and_then(|value| value.pointer("/schema/dialect"))
                .and_then(Value::as_str),
            Some("json-schema-2020-12")
        );
        assert_eq!(
            description
                .configuration
                .as_ref()
                .and_then(|value| value.get("spec_version"))
                .and_then(Value::as_str),
            Some("0.3.0")
        );
        assert_eq!(description.contracts[0].id, "example.work-item");
        assert_eq!(
            description.contracts.len(),
            1,
            "contracts without an implementation are not application capabilities"
        );
        let serialized = serde_json::to_string(&description).unwrap();
        assert!(!serialized.contains(root.to_string_lossy().as_ref()));
        assert!(!serialized.contains("not-for-apps"));
    }

    #[test]
    fn contract_scope_confines_description_queries_records_and_changes() {
        let state = tempdir().unwrap();
        let collection_parent = tempdir().unwrap();
        let root = collection_parent.path().join("mixed");
        let registry = CollectionRegistry::open(state.path()).unwrap();
        let collection = registry.create(&root, Some("Mixed")).unwrap();
        write_work_item_contract(&root);
        fs::write(
            root.join("_types/task.md"),
            r#"---
kind: mdbase.type
name: task
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    additionalProperties: true
    properties:
      type: { const: task }
      title: { type: string }
implements:
  - contract: example.work-item
    version: 1.0.0
    fields:
      title: title
---
"#,
        )
        .unwrap();
        fs::write(
            root.join("_types/private.md"),
            r#"---
kind: mdbase.type
name: private
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    additionalProperties: true
    properties:
      type: { const: private }
      secret: { type: string }
---
"#,
        )
        .unwrap();
        for (path, type_name, field, value) in [
            ("tasks/one.md", "task", "title", "Visible"),
            ("private/one.md", "private", "secret", "Hidden"),
        ] {
            let mut frontmatter = json!({ "type": type_name, field: value });
            if type_name == "task" {
                frontmatter["unmapped_secret"] = json!("must never cross the grant");
            }
            let created = registry
                .operation(
                    collection.id,
                    "create",
                    &json!({
                        "path": path,
                        "type": type_name,
                        "frontmatter": frontmatter,
                        "body": "private body"
                    }),
                )
                .unwrap();
            assert_eq!(created["valid"], true, "{created}");
        }
        let scope = work_item_scope(&registry, collection.id);

        let empty_contract_scope = GrantScope {
            contracts: vec![],
            access: mdbase_connect_protocol::ApplicationAccess::Contract,
        };
        assert!(matches!(
            registry.scoped_operation(
                collection.id,
                "query",
                &json!({}),
                &empty_contract_scope
            ),
            Err(ConnectError::AccessDenied(message)) if message.contains("at least one")
        ));
        let full_scope = GrantScope::full_collection();
        let full_query = registry
            .scoped_operation(collection.id, "query", &json!({}), &full_scope)
            .unwrap();
        assert_eq!(full_query["result"]["results"].as_array().unwrap().len(), 2);

        assert!(registry
            .is_compatible(
                collection.id,
                &ApplicationRequirements {
                    contracts: scope
                        .contracts
                        .iter()
                        .map(|contract| ContractRequirement {
                            id: contract.id.clone(),
                            version: contract.version.clone(),
                        })
                        .collect(),
                    ..Default::default()
                }
            )
            .unwrap());
        let description = registry
            .scoped_operation(collection.id, "describe", &json!({}), &scope)
            .unwrap();
        assert_eq!(description["types"].as_array().unwrap().len(), 1);
        assert_eq!(description["types"][0]["name"], "task");

        let query = registry
            .scoped_operation(collection.id, "query", &json!({}), &scope)
            .unwrap();
        assert_eq!(query["result"]["results"].as_array().unwrap().len(), 1);
        assert_eq!(query["result"]["results"][0]["path"], "tasks/one.md");
        assert_eq!(
            query["result"]["results"][0]["frontmatter"],
            json!({ "title": "Visible" })
        );
        assert_eq!(
            query["result"]["results"][0]["contract"]["id"],
            "example.work-item"
        );
        assert!(query["result"]["results"][0].get("body").is_none());
        assert!(query["result"]["results"][0]["frontmatter"]
            .get("unmapped_secret")
            .is_none());
        let read = registry
            .scoped_operation(
                collection.id,
                "read",
                &json!({ "path": "tasks/one.md" }),
                &scope,
            )
            .unwrap();
        assert_eq!(read["result"]["frontmatter"], json!({ "title": "Visible" }));
        assert!(read["result"].get("body").is_none());
        assert!(matches!(
            registry.scoped_operation(
                collection.id,
                "read",
                &json!({ "path": "private/one.md" }),
                &scope
            ),
            Err(ConnectError::AccessDenied(_))
        ));
        assert!(matches!(
            registry.scoped_operation(collection.id, "list_views", &json!({}), &scope),
            Err(ConnectError::AccessDenied(_))
        ));
        assert!(matches!(
            registry.scoped_operation(
                collection.id,
                "execute_view",
                &json!({ "path": "views/tasks.md", "view": "all" }),
                &scope
            ),
            Err(ConnectError::AccessDenied(_))
        ));
        assert!(matches!(
            registry.scoped_operation(
                collection.id,
                "query",
                &json!({ "types": ["private"] }),
                &scope
            ),
            Err(ConnectError::AccessDenied(_))
        ));
        assert!(matches!(
            registry.scoped_operation(
                collection.id,
                "query",
                &json!({ "where": "related.asFile().secret == 'Hidden'" }),
                &scope
            ),
            Err(ConnectError::AccessDenied(_))
        ));

        assert!(matches!(
            registry.scoped_operation(
                collection.id,
                "create",
                &json!({
                    "path": "private/forged.md",
                    "type": "task",
                    "frontmatter": { "type": "private", "secret": "Forged" }
                }),
                &scope
            ),
            Err(ConnectError::AccessDenied(_))
        ));
        assert!(!root.join("private/forged.md").exists());

        assert!(matches!(
            registry.scoped_operation(
                collection.id,
                "update",
                &json!({ "path": "tasks/one.md", "patch": { "type": "private" } }),
                &scope
            ),
            Err(ConnectError::AccessDenied(_))
        ));
        let unchanged = registry
            .operation(collection.id, "read", &json!({ "path": "tasks/one.md" }))
            .unwrap();
        assert_eq!(unchanged["result"]["frontmatter"]["type"], "task");
        assert!(matches!(
            registry.scoped_operation(
                collection.id,
                "update",
                &json!({
                    "path": "tasks/one.md",
                    "document": "---\ntype: private\nsecret: Forged from source\n---\n"
                }),
                &scope
            ),
            Err(ConnectError::AccessDenied(_))
        ));
        let unchanged = registry
            .operation(collection.id, "read", &json!({ "path": "tasks/one.md" }))
            .unwrap();
        assert_eq!(unchanged["result"]["frontmatter"]["type"], "task");
        assert!(matches!(
            registry.scoped_operation(
                collection.id,
                "update",
                &json!({
                    "path": "tasks/one.md",
                    "patch": { "types": ["task", "private"] }
                }),
                &scope
            ),
            Err(ConnectError::AccessDenied(_))
        ));

        for (path, type_name) in [
            ("tasks/changed.md", "task"),
            ("private/changed.md", "private"),
        ] {
            registry
                .append_change(
                    collection.id,
                    &mdbase::watch::WatchEvent {
                        event_type: "mdbase.record.created".to_string(),
                        sequence: 1,
                        occurred_at: "2026-07-20T12:00:00.000Z".to_string(),
                        payload: json!({ "path": path, "types": [type_name] }),
                    },
                )
                .unwrap();
        }
        registry
            .append_change(
                collection.id,
                &mdbase::watch::WatchEvent {
                    event_type: "mdbase.record.modified".to_string(),
                    sequence: 2,
                    occurred_at: "2026-07-20T12:00:01.000Z".to_string(),
                    payload: json!({
                        "path": "tasks/no-longer-a-task.md",
                        "previous_types": ["task"],
                        "types": ["private"]
                    }),
                },
            )
            .unwrap();
        let changes = registry
            .scoped_operation(collection.id, "changes", &json!({ "after": 0 }), &scope)
            .unwrap();
        assert_eq!(changes["events"].as_array().unwrap().len(), 2);
        assert_eq!(changes["events"][0]["payload"]["path"], "tasks/changed.md");
    }

    #[test]
    fn contract_scope_unions_pinned_providers_and_rejects_provider_drift() {
        let state = tempdir().unwrap();
        let collection_parent = tempdir().unwrap();
        let root = collection_parent.path().join("multiple-providers");
        let registry = CollectionRegistry::open(state.path()).unwrap();
        let collection = registry.create(&root, Some("Multiple providers")).unwrap();
        write_work_item_contract(&root);

        for (name, title_field) in [("task", "title"), ("action", "summary")] {
            fs::write(
                root.join(format!("_types/{name}.md")),
                format!(
                    r#"---
kind: mdbase.type
name: {name}
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    additionalProperties: true
    properties:
      {title_field}: {{ type: string }}
implements:
  - contract: example.work-item
    version: 1.0.0
    fields:
      title: {title_field}
---
"#
                ),
            )
            .unwrap();
        }
        for (path, type_name, field) in [
            ("tasks/one.md", "task", "title"),
            ("actions/one.md", "action", "summary"),
        ] {
            let created = registry
                .operation(
                    collection.id,
                    "create",
                    &json!({
                        "path": path,
                        "type": type_name,
                        "frontmatter": { field: "Visible" }
                    }),
                )
                .unwrap();
            assert_eq!(created["valid"], true, "{created}");
        }

        let scope = work_item_scope(&registry, collection.id);
        assert_eq!(
            scope.contracts[0]
                .implementations
                .iter()
                .map(|implementation| implementation.type_name.as_str())
                .collect::<Vec<_>>(),
            ["action", "task"]
        );
        let query = registry
            .scoped_operation(collection.id, "query", &json!({}), &scope)
            .unwrap();
        assert_eq!(query["result"]["results"].as_array().unwrap().len(), 2);
        assert_eq!(
            query["result"]["results"]
                .as_array()
                .unwrap()
                .iter()
                .map(|row| row["frontmatter"]["title"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["Visible", "Visible"]
        );

        let created = registry
            .scoped_operation(
                collection.id,
                "create",
                &json!({
                    "path": "actions/two.md",
                    "type": "action",
                    "contract": {
                        "id": "example.work-item",
                        "version": "1.0.0",
                        "type": "action"
                    },
                    "frontmatter": { "title": "Created through the contract" }
                }),
                &scope,
            )
            .unwrap();
        assert_eq!(
            created["result"]["frontmatter"],
            json!({ "title": "Created through the contract" })
        );
        let raw = registry
            .operation(collection.id, "read", &json!({ "path": "actions/two.md" }))
            .unwrap();
        assert_eq!(
            raw["result"]["frontmatter"]["summary"],
            "Created through the contract"
        );
        assert!(raw["result"]["frontmatter"].get("title").is_none());

        let updated = registry
            .scoped_operation(
                collection.id,
                "update",
                &json!({
                    "path": "actions/two.md",
                    "contract": {
                        "id": "example.work-item",
                        "version": "1.0.0",
                        "type": "action"
                    },
                    "patch": { "title": "Updated through the contract" }
                }),
                &scope,
            )
            .unwrap();
        assert_eq!(
            updated["result"]["frontmatter"]["title"],
            "Updated through the contract"
        );
        let raw = registry
            .operation(collection.id, "read", &json!({ "path": "actions/two.md" }))
            .unwrap();
        assert_eq!(
            raw["result"]["frontmatter"]["summary"],
            "Updated through the contract"
        );

        fs::write(
            root.join("_types/todo.md"),
            r#"---
kind: mdbase.type
name: todo
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    additionalProperties: true
    properties:
      label: { type: string }
implements:
  - contract: example.work-item
    version: 1.0.0
    fields:
      title: label
---
"#,
        )
        .unwrap();

        assert!(matches!(
            registry.scoped_operation(collection.id, "query", &json!({}), &scope),
            Err(ConnectError::AccessDenied(message)) if message.contains("changed")
        ));
    }

    #[test]
    fn full_collection_scope_lists_and_executes_saved_views() {
        let state = tempdir().unwrap();
        let collection_parent = tempdir().unwrap();
        let root = collection_parent.path().join("views");
        let registry = CollectionRegistry::open(state.path()).unwrap();
        let collection = registry.create(&root, Some("Views")).unwrap();
        fs::write(
            root.join("_types/view.md"),
            r#"---
kind: mdbase.type
name: view
version: 1
schema:
  dialect: json-schema-2020-12
  value: { type: object }
---
"#,
        )
        .unwrap();
        fs::write(
            root.join("_types/task.md"),
            r#"---
kind: mdbase.type
name: task
version: 1
schema:
  dialect: json-schema-2020-12
  value: { type: object }
---
"#,
        )
        .unwrap();
        fs::create_dir_all(root.join("tasks")).unwrap();
        fs::create_dir_all(root.join("views")).unwrap();
        fs::write(
            root.join("tasks/one.md"),
            "---\ntype: task\ntitle: One\n---\n",
        )
        .unwrap();
        fs::write(
            root.join("views/tasks.md"),
            r#"---
type: view
id: task.views
version: 1
name: Task views
query:
  types: [task]
views:
  - id: all
    name: All tasks
    select: [title]
    presentation:
      type: example.list
---
"#,
        )
        .unwrap();

        let listed = registry
            .operation(collection.id, "list_views", &json!({}))
            .unwrap();
        assert_eq!(listed["valid"], true, "{listed}");
        assert_eq!(listed["result"]["meta"]["total_count"], 1);
        assert_eq!(listed["result"]["views"][0]["id"], "task.views");

        let executed = registry
            .operation(
                collection.id,
                "execute_view",
                &json!({ "path": "views/tasks.md", "view": "all" }),
            )
            .unwrap();
        assert_eq!(executed["valid"], true, "{executed}");
        assert_eq!(executed["result"]["meta"]["total_count"], 1);
        assert_eq!(executed["result"]["results"][0]["path"], "tasks/one.md");

        let source = registry
            .operation(
                collection.id,
                "read_view_source",
                &json!({ "path": "views/tasks.md" }),
            )
            .unwrap();
        let changed = source["result"]["document"]
            .as_str()
            .unwrap()
            .replace("All tasks", "Every task");
        let updated = registry
            .operation(
                collection.id,
                "update_view_source",
                &json!({
                    "path": "views/tasks.md",
                    "if_revision": source["result"]["revision"],
                    "document": changed,
                }),
            )
            .unwrap();
        assert_eq!(updated["valid"], true, "{updated}");
        let listed = registry
            .operation(collection.id, "list_views", &json!({}))
            .unwrap();
        assert_eq!(
            listed["result"]["views"][0]["views"][0]["name"],
            "Every task"
        );
    }

    #[test]
    fn change_pages_resume_by_cursor_and_omit_record_snapshots() {
        let state = tempdir().unwrap();
        let collection_parent = tempdir().unwrap();
        let root = collection_parent.path().join("notes");
        let registry = CollectionRegistry::open(state.path()).unwrap();
        let collection = registry.create(&root, Some("Notes")).unwrap();
        let event = mdbase::watch::WatchEvent {
            event_type: "mdbase.record.modified".to_string(),
            sequence: 7,
            occurred_at: "2026-07-20T12:00:00.000Z".to_string(),
            payload: json!({
                "path": "note.md",
                "before": {"title": "Before"},
                "after": {"title": "After"},
                "changed_fields": ["title"],
                "revision": "sha256:after"
            }),
        };
        assert_eq!(registry.append_change(collection.id, &event).unwrap(), 1);

        let initial = registry.changes(collection.id, &json!({})).unwrap();
        assert!(initial.events.is_empty());
        assert_eq!(initial.cursor, 1);
        let page = registry
            .changes(collection.id, &json!({"after": 0}))
            .unwrap();
        assert_eq!(page.events.len(), 1);
        assert_eq!(page.events[0].payload["path"], "note.md");
        assert!(page.events[0].payload.get("before").is_none());
        assert!(page.events[0].payload.get("after").is_none());
        assert_eq!(page.cursor, 1);
    }

    #[test]
    fn policy_snapshot_replaces_previous_local_authority() {
        let state = tempdir().unwrap();
        let registry = CollectionRegistry::open(state.path()).unwrap();
        let grant = GrantPolicy {
            id: Uuid::new_v4(),
            application_id: Uuid::new_v4(),
            collection_id: Uuid::new_v4(),
            operations: vec!["read".to_string(), "query".to_string()],
            scope: GrantScope::full_collection(),
            application_name: "Workout Tracker".to_string(),
            application_distribution: "web".to_string(),
            application_homepage: "https://workouts.example".to_string(),
            application_project_url: None,
            application_origin: "https://workouts.example".to_string(),
            application_icon: None,
            collection_name: "Workouts".to_string(),
            notification_criteria: Vec::new(),
            created_at: "2026-07-19T00:00:00Z".to_string(),
            encryption: None,
        };
        registry
            .replace_grants(std::slice::from_ref(&grant))
            .unwrap();
        assert!(registry
            .authorizes(grant.id, grant.application_id, grant.collection_id, "query")
            .unwrap());
        assert!(!registry
            .authorizes(
                grant.id,
                grant.application_id,
                grant.collection_id,
                "update"
            )
            .unwrap());

        registry.replace_grants(&[]).unwrap();
        assert!(!registry
            .authorizes(grant.id, grant.application_id, grant.collection_id, "read")
            .unwrap());
    }

    #[test]
    fn encrypted_replay_window_survives_restart_allows_reordering_and_serializes_duplicates() {
        let state = tempdir().unwrap();
        let grant_id = Uuid::new_v4();
        let first_request = Uuid::new_v4();
        let registry = CollectionRegistry::open(state.path()).unwrap();
        assert_eq!(
            registry
                .claim_encrypted_request(grant_id, "key-1", 40, first_request, "fingerprint-1")
                .unwrap(),
            EncryptedRequestClaim::Fresh
        );
        registry
            .complete_encrypted_request(
                grant_id,
                "key-1",
                first_request,
                "fingerprint-1",
                r#"{"ciphertext":"response"}"#,
            )
            .unwrap();
        drop(registry);

        let registry = CollectionRegistry::open(state.path()).unwrap();
        assert!(matches!(
            registry.claim_encrypted_request(
                grant_id,
                "key-1",
                40,
                Uuid::new_v4(),
                "fingerprint-2"
            ),
            Err(ConnectError::EncryptedRelayRejected)
        ));
        assert_eq!(
            registry
                .claim_encrypted_request(grant_id, "key-1", 40, first_request, "fingerprint-1")
                .unwrap(),
            EncryptedRequestClaim::Completed(r#"{"ciphertext":"response"}"#.to_string())
        );
        assert!(registry
            .claim_encrypted_request(grant_id, "key-1", 41, first_request, "tampered")
            .is_err());
        assert_eq!(
            registry
                .claim_encrypted_request(grant_id, "key-1", 42, Uuid::new_v4(), "fingerprint-42")
                .unwrap(),
            EncryptedRequestClaim::Fresh
        );
        assert_eq!(
            registry
                .claim_encrypted_request(grant_id, "key-1", 41, Uuid::new_v4(), "fingerprint-41")
                .unwrap(),
            EncryptedRequestClaim::Fresh
        );

        let shared = Arc::new(registry);
        let request_id = Uuid::new_v4();
        let threads = (0..8)
            .map(|_| {
                let registry = shared.clone();
                std::thread::spawn(move || {
                    registry.claim_encrypted_request(
                        grant_id,
                        "key-1",
                        43,
                        request_id,
                        "fingerprint-43",
                    )
                })
            })
            .collect::<Vec<_>>();
        let accepted = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .filter(|result| matches!(result, Ok(EncryptedRequestClaim::Fresh)))
            .count();
        assert_eq!(accepted, 1);
        assert_eq!(
            shared
                .claim_encrypted_request(
                    grant_id,
                    "key-1",
                    2_000,
                    Uuid::new_v4(),
                    "fingerprint-2000"
                )
                .unwrap(),
            EncryptedRequestClaim::Fresh
        );
        assert!(shared
            .claim_encrypted_request(grant_id, "key-1", 975, Uuid::new_v4(), "fingerprint-stale")
            .is_err());
    }

    #[test]
    fn development_registry_upgrade_adds_origin_receipts_and_a_safe_reorder_floor() {
        let state = tempdir().unwrap();
        let path = state.path().join("connector.sqlite");
        let legacy = Connection::open(&path).unwrap();
        legacy
            .execute_batch(
                "CREATE TABLE grants (
                    id TEXT PRIMARY KEY,
                    application_id TEXT NOT NULL,
                    collection_id TEXT NOT NULL,
                    operations TEXT NOT NULL
                 );
                 CREATE TABLE grant_crypto_state (
                    grant_id TEXT NOT NULL,
                    key_id TEXT NOT NULL,
                    last_request_counter TEXT NOT NULL,
                    PRIMARY KEY (grant_id, key_id)
                 );
                 CREATE TABLE grant_crypto_requests (
                    grant_id TEXT NOT NULL,
                    key_id TEXT NOT NULL,
                    request_id TEXT NOT NULL,
                    received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (grant_id, key_id, request_id)
                 );",
            )
            .unwrap();
        let grant_id = Uuid::new_v4();
        legacy
            .execute(
                "INSERT INTO grant_crypto_state (grant_id, key_id, last_request_counter)
                 VALUES (?1, 'legacy-key', '40')",
                [grant_id.to_string()],
            )
            .unwrap();
        drop(legacy);

        let registry = CollectionRegistry::open(state.path()).unwrap();
        let connection = registry.connection().unwrap();
        let origin: String = connection
            .query_row(
                "SELECT dflt_value FROM pragma_table_info('grants')
                 WHERE name = 'application_origin'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(origin, "''");
        let floor: String = connection
            .query_row(
                "SELECT reorder_floor FROM grant_crypto_state
                 WHERE grant_id = ?1 AND key_id = 'legacy-key'",
                [grant_id.to_string()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(floor, "40");
        drop(connection);
        assert_eq!(
            registry
                .claim_encrypted_request(
                    grant_id,
                    "legacy-key",
                    41,
                    Uuid::new_v4(),
                    "upgraded-fingerprint"
                )
                .unwrap(),
            EncryptedRequestClaim::Fresh
        );
    }

    #[test]
    fn policy_rotation_prunes_only_obsolete_encrypted_replay_windows() {
        let state = tempdir().unwrap();
        let registry = CollectionRegistry::open(state.path()).unwrap();
        let mut grant = GrantPolicy {
            id: Uuid::new_v4(),
            application_id: Uuid::new_v4(),
            collection_id: Uuid::new_v4(),
            operations: vec!["read".to_string()],
            scope: GrantScope::full_collection(),
            application_name: "Encrypted app".to_string(),
            application_distribution: "web".to_string(),
            application_homepage: "https://app.example".to_string(),
            application_project_url: None,
            application_origin: "https://app.example".to_string(),
            application_icon: None,
            collection_name: "Collection".to_string(),
            notification_criteria: Vec::new(),
            created_at: "2026-07-21T00:00:00Z".to_string(),
            encryption: Some(mdbase_connect_protocol::GrantEncryption {
                protocol_version: 1,
                suite: "P256-HKDF-SHA256-AES256GCM".to_string(),
                key_id: "key-1".to_string(),
                scope_epoch: 1,
                connector_id: Uuid::new_v4(),
                collection_id: Uuid::new_v4(),
                application_agreement_public_key: "application-key".to_string(),
                connector_agreement_public_key: "connector-key".to_string(),
            }),
        };
        registry
            .replace_grants(std::slice::from_ref(&grant))
            .unwrap();
        registry
            .claim_encrypted_request(grant.id, "key-1", 7, Uuid::new_v4(), "fingerprint")
            .unwrap();

        registry
            .replace_grants(std::slice::from_ref(&grant))
            .unwrap();
        let preserved = registry
            .connection()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM grant_crypto_state WHERE grant_id = ?1 AND key_id = 'key-1'",
                [grant.id.to_string()],
                |row| row.get::<_, u64>(0),
            )
            .unwrap();
        assert_eq!(preserved, 1);

        grant.encryption.as_mut().unwrap().key_id = "key-2".to_string();
        grant.encryption.as_mut().unwrap().scope_epoch = 2;
        registry
            .replace_grants(std::slice::from_ref(&grant))
            .unwrap();
        let obsolete = registry
            .connection()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM grant_crypto_state WHERE grant_id = ?1 AND key_id = 'key-1'",
                [grant.id.to_string()],
                |row| row.get::<_, u64>(0),
            )
            .unwrap();
        assert_eq!(obsolete, 0);
    }
}
