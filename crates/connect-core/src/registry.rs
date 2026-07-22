use directories::ProjectDirs;
use mdbase::runtime::FilesystemProvider;
use mdbase::{Collection, SpecProfile};
use mdbase_connect_protocol::{
    ActivityEntry, ApplicationRequirements, CollectionChange, CollectionChangesPage,
    CollectionContractDescriptor, CollectionDescription, CollectionSummary,
    CollectionTypeDescriptor, ContractRequirement, EncryptedRelayEnvelope, GrantPolicy, GrantScope,
    GrantSummary, TypeProvision, CONTROL_PROTOCOL_VERSION,
};
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

const COLLECTION_NAMESPACE: Uuid = Uuid::from_u128(0x72972de3_d05a_4db7_82f5_c9ce02f0fb1d);
const ENCRYPTED_REPLAY_WINDOW: u64 = 1024;

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
    #[error("Unsupported collection operation: {0}")]
    UnsupportedOperation(String),
    #[error("Application access denied: {0}")]
    AccessDenied(String),
    #[error("Encrypted relay request was rejected")]
    EncryptedRelayRejected,
    #[error("Local registry error: {0}")]
    Registry(#[from] rusqlite::Error),
    #[error("Filesystem error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Configuration error: {0}")]
    Config(#[from] serde_yaml::Error),
    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("Cloud control error: {0}")]
    Cloud(String),
    #[error(transparent)]
    Provider(#[from] mdbase::runtime::ProviderError),
}

impl ConnectError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::StateDirectoryUnavailable => "state_directory_unavailable",
            Self::PathNotFound(_) => "path_not_found",
            Self::NotACollection(_) => "not_a_collection",
            Self::CollectionNotFound(_) => "collection_not_found",
            Self::CollectionInit(_) => "collection_init_failed",
            Self::CollectionOpen(_) => "collection_open_failed",
            Self::UnsupportedOperation(_) => "unsupported_operation",
            Self::AccessDenied(_) => "access_denied",
            Self::EncryptedRelayRejected => "encrypted_relay_rejected",
            Self::Registry(_) => "registry_failed",
            Self::Io(_) => "io_failed",
            Self::Config(_) => "invalid_config",
            Self::Serialization(_) => "serialization_failed",
            Self::Cloud(_) => "cloud_control_failed",
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
    pub fn open(state_dir: impl AsRef<Path>) -> Result<Self, ConnectError> {
        fs::create_dir_all(state_dir.as_ref())?;
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
                scope TEXT NOT NULL DEFAULT '{\"contracts\":[]}',
                application_name TEXT NOT NULL DEFAULT 'Application',
                application_homepage TEXT NOT NULL DEFAULT '',
                application_origin TEXT NOT NULL DEFAULT '',
                application_icon TEXT,
                collection_name TEXT NOT NULL DEFAULT 'Collection',
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
            "ALTER TABLE grants ADD COLUMN application_homepage TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE grants ADD COLUMN application_origin TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE grants ADD COLUMN application_icon TEXT",
            "ALTER TABLE grants ADD COLUMN collection_name TEXT NOT NULL DEFAULT 'Collection'",
            "ALTER TABLE grants ADD COLUMN created_at TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE grants ADD COLUMN scope TEXT NOT NULL DEFAULT '{\"contracts\":[]}'",
            "ALTER TABLE grants ADD COLUMN encryption TEXT",
            "ALTER TABLE collections ADD COLUMN description TEXT",
            "ALTER TABLE grant_crypto_state ADD COLUMN reorder_floor TEXT",
            "ALTER TABLE grant_crypto_requests ADD COLUMN counter TEXT",
            "ALTER TABLE grant_crypto_requests ADD COLUMN request_counter TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE grant_crypto_requests ADD COLUMN request_fingerprint TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE grant_crypto_requests ADD COLUMN response_envelope TEXT",
        ] {
            if let Err(error) = connection.execute(migration, []) {
                if !error.to_string().contains("duplicate column name") {
                    return Err(error.into());
                }
            }
        }
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
            let _ = self.refresh_summary_metadata(collection);
            if let Ok(description) = self.describe(collection.id) {
                collection.contracts = description
                    .contracts
                    .into_iter()
                    .map(|contract| ContractRequirement {
                        id: contract.id,
                        version: contract.version,
                    })
                    .collect();
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
        if !path.join("mdbase.yaml").is_file() {
            return Err(ConnectError::NotACollection(path.display().to_string()));
        }

        let provider = Arc::new(FilesystemProvider::open(&path)?);

        let metadata = read_collection_metadata(&path)?;
        let path_string = path.to_string_lossy().to_string();
        let id = Uuid::new_v5(&COLLECTION_NAMESPACE, path_string.as_bytes());
        let display_name = collection_display_name(&metadata, &path);
        let description = normalized_optional(metadata.description);

        self.connection()?.execute(
            "INSERT INTO collections (id, path, display_name, description, spec_version, enabled)
             VALUES (?1, ?2, ?3, ?4, ?5, 1)
             ON CONFLICT(path) DO UPDATE SET
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

        let mut updated = registered;
        self.refresh_summary_metadata(&mut updated)?;
        self.providers
            .lock()
            .map_err(|_| ConnectError::CollectionOpen("provider registry lock poisoned".into()))?
            .remove(&id);
        Ok(updated)
    }

    pub fn set_enabled(&self, id: Uuid, enabled: bool) -> Result<CollectionSummary, ConnectError> {
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
        row.ok_or(ConnectError::CollectionNotFound(id))
    }

    pub fn remove(&self, id: Uuid) -> Result<CollectionSummary, ConnectError> {
        let collection = self.get(id)?;
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
        if operation == "changes" {
            return serde_json::to_value(self.changes(id, input)?).map_err(ConnectError::from);
        }
        let provider = self.provider_for(&registered)?;
        let execute = |collection: &Collection| {
            if operation == "describe" {
                return serde_json::to_value(self.describe_loaded(&registered, collection)?)
                    .map_err(ConnectError::from);
            }
            execute_loaded(collection, operation, input)
        };
        if is_collection_mutation(operation) {
            provider.with_collection(|collection| {
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

    pub fn provision_types(
        &self,
        id: Uuid,
        requirements: &ApplicationRequirements,
        provisions: &[TypeProvision],
    ) -> Result<Vec<ContractRequirement>, ConnectError> {
        let mut available = self.describe(id)?.contracts;
        let missing = requirements
            .contracts
            .iter()
            .filter(|required| !has_contract(&available, required))
            .cloned()
            .collect::<Vec<_>>();
        if missing.is_empty() {
            return Ok(contract_requirements(&available));
        }
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

        for provision in provisions {
            if !provision
                .provides
                .iter()
                .any(|provided| missing.contains(provided) && !has_contract(&available, provided))
            {
                continue;
            }
            let mut input = json!({ "document": provision.document });
            if let Some(path) = &provision.path {
                input["path"] = json!(path);
            }
            let result = self.operation(id, "create_type", &input)?;
            if result.get("valid").and_then(Value::as_bool) != Some(true) {
                return Err(ConnectError::AccessDenied(format!(
                    "The {} type could not be installed: {}",
                    provision.name,
                    error_message(&result, "the type definition was rejected")
                )));
            }
            if result
                .pointer("/result/name")
                .and_then(Value::as_str)
                .is_none_or(|name| !name.eq_ignore_ascii_case(&provision.name))
            {
                return Err(ConnectError::AccessDenied(format!(
                    "The installed type did not match the declared {} type.",
                    provision.name
                )));
            }
            available = self.describe(id)?.contracts;
        }

        if requirements
            .contracts
            .iter()
            .any(|required| !has_contract(&available, required))
        {
            return Err(ConnectError::AccessDenied(
                "The installed type definitions did not provide every required contract."
                    .to_string(),
            ));
        }
        Ok(contract_requirements(&available))
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
        let execute = |collection: &Collection| {
            self.scoped_operation_loaded(&registered, collection, operation, input, scope)
        };
        if is_collection_mutation(operation) {
            provider.with_collection(|collection| {
                let result = execute(collection)?;
                let invalidation = operation_invalidation(operation, input, &result);
                synchronize(&invalidation);
                Ok(result)
            })
        } else {
            provider.with_collection_read(execute)
        }
    }

    fn scoped_operation_loaded(
        &self,
        registered: &CollectionSummary,
        collection: &Collection,
        operation: &str,
        input: &Value,
        scope: &GrantScope,
    ) -> Result<Value, ConnectError> {
        let Some(allowed_types) = self.resolve_scope_types_loaded(registered, collection, scope)?
        else {
            return match operation {
                "describe" => serde_json::to_value(self.describe_loaded(registered, collection)?)
                    .map_err(ConnectError::from),
                "changes" => serde_json::to_value(self.changes(registered.id, input)?)
                    .map_err(ConnectError::from),
                _ => execute_loaded(collection, operation, input),
            };
        };

        match operation {
            "describe" => {
                let mut description = self.describe_loaded(registered, collection)?;
                description
                    .types
                    .retain(|type_definition| allowed_types.contains(&type_definition.name));
                description.contracts.retain(|contract| {
                    allowed_types.contains(&contract.type_name)
                        && scope.contracts.iter().any(|required| {
                            required.id == contract.id && required.version == contract.version
                        })
                });
                serde_json::to_value(description).map_err(ConnectError::from)
            }
            "changes" => {
                let mut page = self.changes(registered.id, input)?;
                page.events
                    .retain(|event| change_is_in_scope(event, &allowed_types, Some(collection)));
                serde_json::to_value(page).map_err(ConnectError::from)
            }
            "query" => {
                let input = scoped_query(input, &allowed_types)?;
                ensure_query_stays_within_record(&input)?;
                execute_loaded(collection, operation, &input)
            }
            "read" => {
                let result = execute_loaded(collection, operation, input)?;
                ensure_result_in_scope(&result, &allowed_types)?;
                Ok(result)
            }
            "create" => {
                let frontmatter = input
                    .get("frontmatter")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                let path = input.get("path").and_then(Value::as_str);
                let mut prospective_types = collection.determine_types_for_path(&frontmatter, path);
                if let Some(requested_type) = input.get("type").and_then(Value::as_str) {
                    prospective_types.push(requested_type.to_lowercase());
                }
                ensure_types_in_scope(&prospective_types, &allowed_types)?;
                ensure_no_new_out_of_scope_types(
                    &prospective_types,
                    &BTreeSet::new(),
                    &allowed_types,
                )?;
                let result = execute_loaded(collection, operation, input)?;
                if result.get("valid").and_then(Value::as_bool) != Some(false) {
                    ensure_result_in_scope(&result, &allowed_types)?;
                }
                Ok(result)
            }
            "update" => {
                let path = required_string(input, "path")?;
                let current = execute_loaded(collection, "read", &json!({ "path": path }))?;
                ensure_result_in_scope(&current, &allowed_types)?;
                let current_types = result_types(&current);
                let mut prospective = current
                    .pointer("/result/raw_frontmatter")
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                if let Some(fields) = input
                    .get("patch")
                    .or_else(|| input.get("fields"))
                    .and_then(Value::as_object)
                {
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
                ensure_types_in_scope(&prospective_types, &allowed_types)?;
                ensure_no_new_out_of_scope_types(
                    &prospective_types,
                    &current_types,
                    &allowed_types,
                )?;
                execute_loaded(collection, operation, input)
            }
            "delete" => {
                let path = required_string(input, "path")?;
                let current = execute_loaded(collection, "read", &json!({ "path": path }))?;
                ensure_result_in_scope(&current, &allowed_types)?;
                let mut scoped_input = input.clone();
                if let Some(object) = scoped_input.as_object_mut() {
                    object.insert("check_backlinks".to_string(), Value::Bool(false));
                }
                execute_loaded(collection, operation, &scoped_input)
            }
            "rename" => {
                let from = required_string(input, "from")?;
                let to = required_string(input, "to")?;
                if input.get("update_refs").and_then(Value::as_bool) == Some(true) {
                    return Err(ConnectError::AccessDenied(
                        "Reference updates can affect records outside this application's scope."
                            .to_string(),
                    ));
                }
                let current = execute_loaded(collection, "read", &json!({ "path": from }))?;
                ensure_result_in_scope(&current, &allowed_types)?;
                let current_types = result_types(&current);
                let frontmatter = current
                    .pointer("/result/raw_frontmatter")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                let prospective_types = collection.determine_types_for_path(&frontmatter, Some(to));
                ensure_types_in_scope(&prospective_types, &allowed_types)?;
                ensure_no_new_out_of_scope_types(
                    &prospective_types,
                    &current_types,
                    &allowed_types,
                )?;
                execute_loaded(collection, operation, input)
            }
            "validate" => Err(ConnectError::AccessDenied(
                "Collection-wide validation is unavailable to a contract-scoped application."
                    .to_string(),
            )),
            "read_type" | "create_type" | "update_type" => Err(ConnectError::AccessDenied(
                "Type definitions can only be managed by an application with full collection access."
                    .to_string(),
            )),
            other => Err(ConnectError::UnsupportedOperation(other.to_string())),
        }
    }

    fn provider_for(
        &self,
        registered: &CollectionSummary,
    ) -> Result<Arc<FilesystemProvider>, ConnectError> {
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
        if scope.contracts.is_empty() {
            return Ok(None);
        }
        let description = self.describe_loaded(registered, collection)?;
        let mut type_names = BTreeSet::new();
        for required in &scope.contracts {
            let matching = description.contracts.iter().filter(|contract| {
                contract.id == required.id && contract.version == required.version
            });
            let mut found = false;
            for contract in matching {
                found = true;
                type_names.insert(contract.type_name.to_lowercase());
            }
            if !found {
                return Err(ConnectError::AccessDenied(format!(
                    "The collection no longer provides {} version {}.",
                    required.id, required.version
                )));
            }
        }
        Ok(Some(type_names))
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
        if collection.spec_profile == SpecProfile::V03 {
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
                for (extension, configuration) in &extensions {
                    let Some(id) = configuration.get("contract").and_then(Value::as_str) else {
                        continue;
                    };
                    contracts.push(CollectionContractDescriptor {
                        id: id.to_string(),
                        version: configuration
                            .get("version")
                            .and_then(Value::as_u64)
                            .unwrap_or(1),
                        type_name: type_file.name.clone(),
                        extension: extension.clone(),
                        configuration: configuration.clone(),
                    });
                }
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
        }
        types.sort_by(|left, right| left.name.cmp(&right.name));
        contracts.sort_by(|left, right| {
            (&left.id, left.version, &left.type_name).cmp(&(
                &right.id,
                right.version,
                &right.type_name,
            ))
        });
        Ok(CollectionDescription {
            protocol_version: CONTROL_PROTOCOL_VERSION,
            collection_id: registered.id,
            display_name: registered.display_name.clone(),
            spec_version: registered.spec_version.clone(),
            operations: supported_operations()
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
                    application_homepage, application_origin, application_icon, collection_name,
                    created_at, encryption)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            )?;
            for grant in grants {
                statement.execute(params![
                    grant.id.to_string(),
                    grant.application_id.to_string(),
                    grant.collection_id.to_string(),
                    serde_json::to_string(&grant.operations)?,
                    serde_json::to_string(&grant.scope)?,
                    grant.application_name,
                    grant.application_homepage,
                    grant.application_origin,
                    grant.application_icon,
                    grant.collection_name,
                    grant.created_at,
                    grant
                        .encryption
                        .as_ref()
                        .map(serde_json::to_string)
                        .transpose()?,
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
                    application_homepage: grant.application_homepage.clone(),
                    application_origin: grant.application_origin.clone(),
                    application_icon: grant.application_icon.clone(),
                    collection_name: grant.collection_name.clone(),
                    created_at: grant.created_at.clone(),
                    encryption: grant.encryption.clone(),
                })
                .collect::<Vec<_>>(),
        )
    }

    pub fn list_grants(&self) -> Result<Vec<GrantSummary>, ConnectError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, application_id, application_name, application_homepage,
                    application_origin, application_icon, collection_id, collection_name,
                    operations, scope, created_at, encryption
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
                row.get::<_, String>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, String>(9)?,
                row.get::<_, String>(10)?,
                row.get::<_, Option<String>>(11)?,
            ))
        })?;
        rows.map(|row| {
            let (
                id,
                application_id,
                application_name,
                application_homepage,
                application_origin,
                application_icon,
                collection_id,
                collection_name,
                operations,
                scope,
                created_at,
                encryption,
            ) = row?;
            Ok(GrantSummary {
                id: parse_registry_uuid(&id)?,
                application_id: parse_registry_uuid(&application_id)?,
                application_name,
                application_homepage,
                application_origin,
                application_icon,
                collection_id: parse_registry_uuid(&collection_id)?,
                collection_name,
                operations: serde_json::from_str(&operations)?,
                scope: serde_json::from_str(&scope)?,
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

fn scoped_query(input: &Value, allowed_types: &BTreeSet<String>) -> Result<Value, ConnectError> {
    let mut scoped = input.as_object().cloned().ok_or_else(|| {
        ConnectError::AccessDenied("Scoped query input must be an object.".to_string())
    })?;
    if let Some(requested) = scoped.get("types") {
        let requested = requested.as_array().ok_or_else(|| {
            ConnectError::AccessDenied("Scoped query types must be a list.".to_string())
        })?;
        if requested.is_empty() {
            scoped.insert(
                "types".to_string(),
                Value::Array(allowed_types.iter().cloned().map(Value::String).collect()),
            );
            return Ok(Value::Object(scoped));
        }
        for type_name in requested {
            let type_name = type_name.as_str().ok_or_else(|| {
                ConnectError::AccessDenied("Scoped query type names must be strings.".to_string())
            })?;
            if !allowed_types.contains(&type_name.to_lowercase()) {
                return Err(ConnectError::AccessDenied(format!(
                    "Type '{type_name}' is outside this application's record scope."
                )));
            }
        }
    } else {
        scoped.insert(
            "types".to_string(),
            Value::Array(allowed_types.iter().cloned().map(Value::String).collect()),
        );
    }
    Ok(Value::Object(scoped))
}

fn ensure_query_stays_within_record(input: &Value) -> Result<(), ConnectError> {
    let crosses_record_boundary = match input {
        Value::String(source) => {
            let compact = source
                .chars()
                .filter(|character| !character.is_whitespace())
                .collect::<String>();
            compact.contains(".asFile") || compact.contains(".backlinks")
        }
        Value::Array(values) => values
            .iter()
            .any(|value| ensure_query_stays_within_record(value).is_err()),
        Value::Object(values) => values
            .values()
            .any(|value| ensure_query_stays_within_record(value).is_err()),
        _ => false,
    };
    if crosses_record_boundary {
        return Err(ConnectError::AccessDenied(
            "Cross-record query traversal is unavailable to a contract-scoped application."
                .to_string(),
        ));
    }
    Ok(())
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

fn contract_requirements(contracts: &[CollectionContractDescriptor]) -> Vec<ContractRequirement> {
    contracts
        .iter()
        .map(|contract| ContractRequirement {
            id: contract.id.clone(),
            version: contract.version,
        })
        .collect()
}

fn execute_loaded(
    collection: &Collection,
    operation: &str,
    input: &Value,
) -> Result<Value, ConnectError> {
    if collection.spec_profile == SpecProfile::V03 {
        let operations = collection
            .v03_operations()
            .map_err(|diagnostic| ConnectError::CollectionOpen(diagnostic.message.clone()))?;
        let result = match operation {
            "read" => operations.read(input),
            "query" => operations.query(input),
            "validate" => operations.validate(input),
            "create" => operations.create(input),
            "update" => operations.update(input),
            "delete" => operations.delete(input),
            "rename" => operations.rename(input),
            "read_type" => operations.read_type(input),
            "create_type" => operations.create_type(input),
            "update_type" => operations.update_type(input),
            other => return Err(ConnectError::UnsupportedOperation(other.to_string())),
        };
        return serde_json::to_value(result).map_err(ConnectError::from);
    }

    Ok(match operation {
        "read" => collection.read(input),
        "validate" => collection.validate_op(input),
        "create" => collection.create(input),
        "update" => collection.update(input),
        "delete" => collection.delete(input),
        "rename" => collection.rename(input),
        other => return Err(ConnectError::UnsupportedOperation(other.to_string())),
    })
}

fn is_collection_mutation(operation: &str) -> bool {
    matches!(
        operation,
        "create" | "update" | "delete" | "rename" | "create_type" | "update_type"
    )
}

fn operation_invalidation(
    operation: &str,
    input: &Value,
    output: &Value,
) -> CollectionInvalidation {
    if !is_collection_mutation(operation)
        || output.get("valid").and_then(Value::as_bool) == Some(false)
        || output.get("error").is_some()
    {
        return CollectionInvalidation::None;
    }
    if matches!(operation, "create_type" | "update_type") {
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

fn supported_operations() -> &'static [&'static str] {
    &[
        "describe",
        "changes",
        "read",
        "query",
        "validate",
        "create",
        "update",
        "delete",
        "rename",
        "read_type",
        "create_type",
        "update_type",
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};
    use std::thread;
    use tempfile::tempdir;

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
                &GrantScope { contracts: vec![] }
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

        let read = registry
            .operation(collection.id, "read", &json!({ "path": "hello.md" }))
            .unwrap();
        assert_eq!(read["valid"], true);
        assert_eq!(read["result"]["frontmatter"]["title"], "Hello");
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

        let contract_scope = GrantScope {
            contracts: vec![ContractRequirement {
                id: "some.app".to_string(),
                version: 1,
            }],
        };
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
    fn provisions_required_type_contracts_idempotently() {
        let state = tempdir().unwrap();
        let collection_parent = tempdir().unwrap();
        let root = collection_parent.path().join("provisioned");
        let registry = CollectionRegistry::open(state.path()).unwrap();
        let collection = registry.create(&root, Some("Provisioned")).unwrap();
        let requirements = ApplicationRequirements {
            contracts: vec![ContractRequirement {
                id: "workout.record".to_string(),
                version: 1,
            }],
        };
        let provision = TypeProvision {
            name: "Workout".to_string(),
            path: None,
            document: r#"---
kind: mdbase.type
name: workout
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    properties:
      type: { const: workout }
x-workout:
  contract: workout.record
  version: 1
---
"#
            .to_string(),
            provides: requirements.contracts.clone(),
        };

        let contracts = registry
            .provision_types(
                collection.id,
                &requirements,
                std::slice::from_ref(&provision),
            )
            .unwrap();
        assert!(contracts.contains(&requirements.contracts[0]));
        assert!(root.join("_types/workout.md").is_file());
        registry
            .provision_types(collection.id, &requirements, &[provision])
            .unwrap();
    }

    #[test]
    fn scoped_conditional_writers_share_one_collection_serialization_gate() {
        let state = tempdir().unwrap();
        let collection_parent = tempdir().unwrap();
        let root = collection_parent.path().join("tasks");
        let registry = CollectionRegistry::open(state.path()).unwrap();
        let collection = registry.create(&root, Some("Tasks")).unwrap();
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
x-tasknotes:
  contract: tasknotes.task
  version: 1
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
        let scope = GrantScope {
            contracts: vec![ContractRequirement {
                id: "tasknotes.task".to_string(),
                version: 1,
            }],
        };
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
                            "fields": {"title": title},
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
x-tasknotes:
  contract: tasknotes.task
  version: 1
  field_roles: { title: title, status: status }
  status: { completed_values: [done], default: open }
---
"#,
        )
        .unwrap();

        let description = registry.describe(collection.id).unwrap();
        assert_eq!(description.protocol_version, 2);
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
        assert_eq!(description.contracts[0].id, "tasknotes.task");
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
x-tasknotes:
  contract: tasknotes.task
  version: 1
  field_roles: { title: title, status: status }
  status: { completed_values: [done], default: open }
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
            let created = registry
                .operation(
                    collection.id,
                    "create",
                    &json!({
                        "path": path,
                        "type": type_name,
                        "frontmatter": { "type": type_name, field: value }
                    }),
                )
                .unwrap();
            assert_eq!(created["valid"], true, "{created}");
        }
        let scope = GrantScope {
            contracts: vec![ContractRequirement {
                id: "tasknotes.task".to_string(),
                version: 1,
            }],
        };

        assert!(registry
            .is_compatible(
                collection.id,
                &ApplicationRequirements {
                    contracts: scope.contracts.clone()
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
                    "fields": { "types": ["task", "private"] }
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
            scope: GrantScope::default(),
            application_name: "Workout Tracker".to_string(),
            application_homepage: "https://workouts.example".to_string(),
            application_origin: "https://workouts.example".to_string(),
            application_icon: None,
            collection_name: "Workouts".to_string(),
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
            scope: GrantScope::default(),
            application_name: "Encrypted app".to_string(),
            application_homepage: "https://app.example".to_string(),
            application_origin: "https://app.example".to_string(),
            application_icon: None,
            collection_name: "Collection".to_string(),
            created_at: "2026-07-21T00:00:00Z".to_string(),
            encryption: Some(mdbase_connect_protocol::GrantEncryption {
                protocol_version: 3,
                suite: "P256-HKDF-SHA256-AES256GCM".to_string(),
                key_id: "key-1".to_string(),
                scope_epoch: 1,
                connector_id: Uuid::new_v4(),
                collection_id: Uuid::new_v4(),
                application_public_key: "application-key".to_string(),
                connector_public_key: "connector-key".to_string(),
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
