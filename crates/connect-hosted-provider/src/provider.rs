use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::http::StatusCode;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{DateTime, Utc};
use hmac::{Hmac, Mac};
use mdbase::v03::{Diagnostic, OperationResult};
use mdbase_connect_protocol::{
    authority_manifest_digest as snapshot_manifest_digest, AuthorityImportManifest,
    AuthorityImportRecordPage, AuthoritySnapshotRecord, CollectionChange, CollectionChangesPage,
    CollectionContractDescriptor, CollectionDescription, GrantSummary, SyncChange, SyncChangesPage,
    SyncCollectionResources, SyncConflict, SyncMutation, SyncMutationError, SyncMutationOperation,
    SyncMutationReceipt, SyncRecord, SyncReplicaMode, SyncResourceDocument, SyncSession,
    SyncSnapshotPage, TypeProvision, AUTHORITY_PROOF_DOMAIN, AUTHORITY_PROOF_VERSION,
    CONTROL_PROTOCOL_VERSION, SYNC_PROTOCOL_VERSION,
};
use p256::ecdsa::{signature::Verifier, Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{
    postgres::{PgPoolOptions, PgRow},
    PgPool, Postgres, Row, Transaction,
};
use subtle::ConstantTimeEq;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::{
    crypto::ProviderCrypto,
    error::{ApiError, ApiResult},
    notifications::{HostedNotificationConfig, HostedNotificationRuntime},
    template,
    workspace::{StoredDocument, WorkingSet},
};

const SNAPSHOT_PAGE_SIZE: i64 = 200;
const DATABASE_STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
type WorkingSetSlot = Arc<Mutex<Option<CachedCollection>>>;
type WorkingSetRegistry = Arc<Mutex<HashMap<Uuid, WorkingSetSlot>>>;

#[derive(Debug, Clone)]
pub struct ProviderLimits {
    pub max_records_per_collection: u64,
    pub max_bytes_per_collection: u64,
    pub max_bytes_per_document: u64,
    pub max_replicas_per_collection: u64,
}

impl Default for ProviderLimits {
    fn default() -> Self {
        Self {
            max_records_per_collection: 100_000,
            max_bytes_per_collection: 1024 * 1024 * 1024,
            max_bytes_per_document: 2 * 1024 * 1024,
            max_replicas_per_collection: 100,
        }
    }
}

#[derive(Clone)]
pub struct HostedProvider {
    pool: PgPool,
    crypto: ProviderCrypto,
    limits: ProviderLimits,
    working_sets: WorkingSetRegistry,
    notifications: Option<HostedNotificationRuntime>,
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
    pub full_collection: bool,
    #[serde(default)]
    pub allowed_operations: Vec<String>,
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
    pub full_collection: bool,
    pub allowed_operations: Vec<String>,
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
    pub state: String,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PrepareAuthorityImport {
    pub transfer_id: Uuid,
    pub collection_id: Uuid,
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
    pub state: String,
    pub manifest_digest: Option<String>,
    pub source_revision: Option<String>,
    pub source_head: Option<u64>,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
struct Replica {
    id: Uuid,
    purpose: ReplicaPurpose,
    mode: SyncReplicaMode,
    allowed_types: Vec<String>,
    full_collection: bool,
    allowed_operations: Vec<String>,
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

struct CachedCollection {
    head: Option<u64>,
    workspace: WorkingSet,
    records: BTreeMap<Uuid, PersistedRecord>,
    query_cache: HashMap<[u8; 32], OperationResult>,
    query_order: VecDeque<[u8; 32]>,
}

impl HostedProvider {
    pub async fn connect(
        database_url: &str,
        crypto: ProviderCrypto,
        limits: ProviderLimits,
        notification_config: Option<HostedNotificationConfig>,
    ) -> ApiResult<Self> {
        let started = Instant::now();
        let mut retry_delay = Duration::from_millis(100);
        loop {
            match PgPoolOptions::new()
                .max_connections(20)
                .min_connections(1)
                .acquire_timeout(Duration::from_secs(5))
                .idle_timeout(Duration::from_secs(10 * 60))
                .max_lifetime(Duration::from_secs(30 * 60))
                .connect(database_url)
                .await
            {
                Ok(pool) => match sqlx::migrate!("./migrations").run(&pool).await {
                    Ok(()) => match verify_database_key(&pool, &crypto).await {
                        Ok(()) => {
                            let notifications = notification_config
                                .clone()
                                .map(|config| HostedNotificationRuntime::new(pool.clone(), config))
                                .transpose()?;
                            return Ok(Self {
                                pool,
                                crypto,
                                limits,
                                working_sets: Arc::new(Mutex::new(HashMap::new())),
                                notifications,
                            });
                        }
                        Err(DatabaseKeyError::Invalid(error)) => {
                            pool.close().await;
                            return Err(error);
                        }
                        Err(DatabaseKeyError::Database(error))
                            if started.elapsed() < DATABASE_STARTUP_TIMEOUT =>
                        {
                            tracing::warn!(error = %error, "hosted provider key check unavailable; retrying");
                            pool.close().await;
                        }
                        Err(DatabaseKeyError::Database(error)) => {
                            tracing::error!(error = %error, "hosted provider key check failed");
                            return Err(ApiError::internal(
                                "The hosted provider could not verify its authoritative store.",
                            ));
                        }
                    },
                    Err(error) if started.elapsed() < DATABASE_STARTUP_TIMEOUT => {
                        tracing::warn!(error = %error, "hosted provider migration unavailable; retrying");
                        pool.close().await;
                    }
                    Err(error) => {
                        tracing::error!(error = %error, "hosted provider migration failed");
                        return Err(ApiError::internal(
                            "The hosted provider database migration failed.",
                        ));
                    }
                },
                Err(error) if started.elapsed() < DATABASE_STARTUP_TIMEOUT => {
                    tracing::warn!(error = %error, "hosted provider database unavailable; retrying");
                }
                Err(error) => {
                    tracing::error!(error = %error, "hosted provider database connection failed");
                    return Err(ApiError::internal(
                        "The hosted provider could not connect to its authoritative store.",
                    ));
                }
            }
            tokio::time::sleep(retry_delay).await;
            retry_delay = (retry_delay * 2).min(Duration::from_secs(2));
        }
    }

    pub async fn ready(&self) -> ApiResult<()> {
        sqlx::query("SELECT 1").execute(&self.pool).await?;
        Ok(())
    }

    pub async fn upsert_notification_grant(
        &self,
        collection_id: Uuid,
        grant: GrantSummary,
    ) -> ApiResult<()> {
        let Some(notifications) = &self.notifications else {
            return Err(ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "notifications_unavailable",
                "Hosted notification execution is not configured.",
            ));
        };
        notifications.upsert_grant(collection_id, grant).await
    }

    pub async fn revoke_notification_grant(&self, grant_id: Uuid) -> ApiResult<()> {
        let Some(notifications) = &self.notifications else {
            return Ok(());
        };
        notifications.revoke_grant(grant_id).await
    }

    pub async fn recover_notifications(&self, limit: usize) -> ApiResult<usize> {
        let Some(notifications) = &self.notifications else {
            return Ok(0);
        };
        notifications.recover(limit).await
    }

    pub async fn create_collection(
        &self,
        collection_id: Uuid,
        template_name: &str,
        display_name: &str,
    ) -> ApiResult<ProviderCollection> {
        let display_name = display_name.trim();
        if display_name.is_empty() || display_name.chars().count() > 200 {
            return Err(ApiError::bad_request(
                "invalid_collection_name",
                "Hosted collection names must contain between 1 and 200 characters.",
            ));
        }
        let (resources, documents) = template::resources(template_name)?;
        let data_key = self.crypto.generate_data_key();
        let wrapped_data_key = self
            .crypto
            .wrap_data_key(&data_key, &collection_key_aad(collection_id))?;
        let resources_ciphertext =
            self.crypto
                .encrypt_json(&data_key, &resources, &resources_aad(collection_id))?;
        let mut transaction = self.pool.begin().await?;
        let inserted = sqlx::query(
            r#"INSERT INTO hosted_provider_collections
                 (id, template, display_name, spec_version, resource_revision, wrapped_data_key,
                  resources_ciphertext, max_records, max_content_bytes,
                  max_document_bytes, max_replicas)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
               ON CONFLICT (id) DO NOTHING"#,
        )
        .bind(collection_id)
        .bind(template_name)
        .bind(display_name)
        .bind(&resources.spec_version)
        .bind(&resources.revision)
        .bind(wrapped_data_key)
        .bind(resources_ciphertext)
        .bind(to_i64(
            self.limits.max_records_per_collection,
            "record quota",
        )?)
        .bind(to_i64(
            self.limits.max_bytes_per_collection,
            "collection byte quota",
        )?)
        .bind(to_i64(
            self.limits.max_bytes_per_document,
            "document byte quota",
        )?)
        .bind(to_i64(
            self.limits.max_replicas_per_collection,
            "replica quota",
        )?)
        .execute(&mut *transaction)
        .await?;
        if inserted.rows_affected() == 0 {
            let existing = sqlx::query(
                "SELECT template, display_name, spec_version, resource_revision FROM hosted_provider_collections WHERE id = $1",
            )
            .bind(collection_id)
            .fetch_one(&mut *transaction)
            .await?;
            let existing_template: String = existing.get("template");
            if existing_template != template_name
                || existing.get::<String, _>("display_name") != display_name
            {
                return Err(ApiError::conflict(
                    "hosted_collection_conflict",
                    "Hosted collection already exists with different metadata.",
                ));
            }
            let result = ProviderCollection {
                id: collection_id,
                display_name: existing.get("display_name"),
                spec_version: existing.get("spec_version"),
                resource_revision: existing.get("resource_revision"),
            };
            transaction.commit().await?;
            return Ok(result);
        }
        for document in documents {
            sqlx::query(
                r#"INSERT INTO hosted_provider_resources
                     (collection_id, path, kind, revision, document_ciphertext)
                   VALUES ($1, $2, $3, $4, $5)
                   ON CONFLICT (collection_id, path) DO NOTHING"#,
            )
            .bind(collection_id)
            .bind(document.path)
            .bind(document.kind)
            .bind(document.revision)
            .bind(self.crypto.encrypt_bytes(
                &data_key,
                document.document.as_bytes(),
                &resource_document_aad(collection_id, document.path),
            )?)
            .execute(&mut *transaction)
            .await?;
        }
        transaction.commit().await?;
        Ok(ProviderCollection {
            id: collection_id,
            display_name: display_name.to_string(),
            spec_version: resources.spec_version,
            resource_revision: resources.revision,
        })
    }

    pub async fn prepare_authority_import(
        &self,
        input: PrepareAuthorityImport,
    ) -> ApiResult<ProviderAuthorityImport> {
        if input.token.len() < 32 {
            return Err(ApiError::bad_request(
                "invalid_authority_import",
                "Authority import credential is invalid.",
            ));
        }
        if input.authority_epoch <= 1 || !(60..=60 * 60).contains(&input.ttl_seconds) {
            return Err(ApiError::bad_request(
                "invalid_authority_import",
                "Authority import epoch or lifetime is invalid.",
            ));
        }
        // Expiry cascades delete abandoned import targets. Recover first so a
        // replacement target cannot be mistaken for the expired one.
        self.recover_expired_authority_imports().await?;
        let existing_state = sqlx::query_scalar::<_, String>(
            "SELECT state FROM hosted_provider_collections WHERE id = $1",
        )
        .bind(input.collection_id)
        .fetch_optional(&self.pool)
        .await?;
        if existing_state.is_none() {
            self.create_collection(input.collection_id, "mdbase", &input.display_name)
                .await?;
        } else if !matches!(existing_state.as_deref(), Some("importing" | "transferred")) {
            return Err(ApiError::conflict(
                "authority_import_target_unavailable",
                "The target collection already has an active authority.",
            ));
        }
        let expires_at = Utc::now()
            + chrono::Duration::seconds(to_i64(input.ttl_seconds, "authority import lifetime")?);
        let requested_token_hash = token_hash(&input.token);
        let mut transaction = self.pool.begin().await?;
        if let Some(existing) = sqlx::query(
            r#"SELECT id, collection_id, token_hash, next_authority_epoch, state,
                      manifest_digest, source_revision, source_head, expires_at
               FROM hosted_provider_authority_imports WHERE id = $1 FOR UPDATE"#,
        )
        .bind(input.transfer_id)
        .fetch_optional(&mut *transaction)
        .await?
        {
            let exact = existing.get::<Uuid, _>("collection_id") == input.collection_id
                && existing.get::<i64, _>("next_authority_epoch")
                    == to_i64(input.authority_epoch, "authority epoch")?
                && matches!(
                    existing.get::<String, _>("state").as_str(),
                    "receiving" | "uploaded"
                );
            if !exact {
                return Err(ApiError::conflict(
                    "authority_import_conflict",
                    "Authority import already exists with different parameters.",
                ));
            }
            let rotated = sqlx::query(
                r#"UPDATE hosted_provider_authority_imports
                   SET token_hash = $2, expires_at = $3
                   WHERE id = $1
                   RETURNING id, collection_id, next_authority_epoch, state,
                             manifest_digest, source_revision, source_head, expires_at"#,
            )
            .bind(input.transfer_id)
            .bind(requested_token_hash)
            .bind(expires_at)
            .fetch_one(&mut *transaction)
            .await?;
            let result = provider_authority_import(&rotated)?;
            transaction.commit().await?;
            return Ok(result);
        }
        // A later epoch supersedes the completed import receipt for this
        // collection. Keeping only the current import preserves the useful
        // collection-level uniqueness without preventing round trips.
        sqlx::query(
            r#"DELETE FROM hosted_provider_authority_imports
               WHERE collection_id = $1 AND state = 'completed'
                 AND next_authority_epoch < $2"#,
        )
        .bind(input.collection_id)
        .bind(to_i64(input.authority_epoch, "authority epoch")?)
        .execute(&mut *transaction)
        .await?;
        let collection = sqlx::query(
            r#"UPDATE hosted_provider_collections
               SET state = 'importing', authority_epoch = $2,
                   display_name = $3, updated_at = now()
               WHERE id = $1 AND state = 'transferred'
               RETURNING id"#,
        )
        .bind(input.collection_id)
        .bind(to_i64(input.authority_epoch, "authority epoch")?)
        .bind(input.display_name.trim())
        .fetch_optional(&mut *transaction)
        .await?;
        let collection = if collection.is_some() {
            collection
        } else {
            sqlx::query(
                r#"UPDATE hosted_provider_collections
                   SET state = 'importing', authority_epoch = $2,
                       display_name = $3, updated_at = now()
                   WHERE id = $1 AND state = 'active' AND head = 0 AND record_count = 0
                   RETURNING id"#,
            )
            .bind(input.collection_id)
            .bind(to_i64(input.authority_epoch, "authority epoch")?)
            .bind(input.display_name.trim())
            .fetch_optional(&mut *transaction)
            .await?
        };
        if collection.is_none() {
            return Err(ApiError::conflict(
                "authority_import_target_unavailable",
                "The target collection cannot receive an authority import.",
            ));
        }
        let row = sqlx::query(
            r#"INSERT INTO hosted_provider_authority_imports
                 (id, collection_id, token_hash, next_authority_epoch,
                  restore_state, expires_at)
               VALUES ($1, $2, $3, $4, $5, $6)
               RETURNING id, collection_id, next_authority_epoch, state,
                         manifest_digest, source_revision, source_head, expires_at"#,
        )
        .bind(input.transfer_id)
        .bind(input.collection_id)
        .bind(requested_token_hash)
        .bind(to_i64(input.authority_epoch, "authority epoch")?)
        .bind(if existing_state.as_deref() == Some("transferred") {
            Some("transferred")
        } else {
            None
        })
        .bind(expires_at)
        .fetch_one(&mut *transaction)
        .await?;
        let result = provider_authority_import(&row)?;
        transaction.commit().await?;
        Ok(result)
    }

    pub async fn put_authority_import_manifest(
        &self,
        import_id: Uuid,
        token: &str,
        manifest: AuthorityImportManifest,
    ) -> ApiResult<ProviderAuthorityImport> {
        if manifest.protocol_version != CONTROL_PROTOCOL_VERSION
            || manifest.manifest_digest.len() != 64
            || !manifest
                .manifest_digest
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            || manifest.source_revision.is_empty()
            || manifest.resources.documents.is_empty()
        {
            return Err(ApiError::bad_request(
                "invalid_authority_import_manifest",
                "Authority import manifest is invalid.",
            ));
        }
        let mut paths = BTreeSet::new();
        for resource in &manifest.resources.documents {
            if !paths.insert(resource.path.as_str())
                || resource.document.len() as u64 > self.limits.max_bytes_per_document
                || !matches!(resource.kind.as_str(), "configuration" | "type")
            {
                return Err(ApiError::bad_request(
                    "invalid_authority_import_manifest",
                    "Authority import resources are invalid.",
                ));
            }
        }
        if !manifest
            .resources
            .documents
            .iter()
            .any(|resource| resource.path == "mdbase.yaml" && resource.kind == "configuration")
        {
            return Err(ApiError::bad_request(
                "invalid_authority_import_manifest",
                "Authority import must include mdbase.yaml.",
            ));
        }
        let mut transaction = self.pool.begin().await?;
        let row = authority_import_row(&mut transaction, import_id).await?;
        authorize_authority_import(&row, token)?;
        if row.get::<String, _>("import_state") != "receiving" {
            return Err(ApiError::conflict(
                "authority_import_finalized",
                "A finalized authority import cannot accept another manifest.",
            ));
        }
        if row.get::<Uuid, _>("collection_id") != manifest.collection_id {
            return Err(ApiError::bad_request(
                "authority_import_collection_mismatch",
                "Authority import manifest belongs to another collection.",
            ));
        }
        let max_records = number(row.get::<i64, _>("max_records"), "record quota")?;
        if manifest.record_count > max_records {
            return Err(ApiError::quota(
                "record_quota_exceeded",
                "Authority import exceeds the collection record quota.",
            ));
        }
        let collection_id = row.get::<Uuid, _>("collection_id");
        let wrapped: Vec<u8> = row.get("wrapped_data_key");
        let data_key = self
            .crypto
            .unwrap_data_key(&wrapped, &collection_key_aad(collection_id))?;
        let previous_digest: Option<String> = row.get("manifest_digest");
        let previous_revision: Option<String> = row.get("source_revision");
        if previous_digest.as_deref() != Some(&manifest.manifest_digest)
            || previous_revision.as_deref() != Some(&manifest.source_revision)
        {
            sqlx::query(
                "DELETE FROM hosted_provider_authority_import_records WHERE import_id = $1",
            )
            .bind(import_id)
            .execute(&mut *transaction)
            .await?;
        }
        let ciphertext = self.crypto.encrypt_json(
            &data_key,
            &manifest,
            &authority_import_manifest_aad(import_id),
        )?;
        let saved = sqlx::query(
            r#"UPDATE hosted_provider_authority_imports
               SET manifest_ciphertext = $2, manifest_digest = $3,
                   source_revision = $4, source_head = $5,
                   expected_record_count = $6, state = 'receiving'
               WHERE id = $1
               RETURNING id, collection_id, next_authority_epoch, state,
                         manifest_digest, source_revision, source_head, expires_at"#,
        )
        .bind(import_id)
        .bind(ciphertext)
        .bind(&manifest.manifest_digest)
        .bind(&manifest.source_revision)
        .bind(to_i64(manifest.source_head, "source head")?)
        .bind(to_i64(manifest.record_count, "record count")?)
        .fetch_one(&mut *transaction)
        .await?;
        let result = provider_authority_import(&saved)?;
        transaction.commit().await?;
        Ok(result)
    }

    pub async fn put_authority_import_records(
        &self,
        import_id: Uuid,
        token: &str,
        page: AuthorityImportRecordPage,
    ) -> ApiResult<ProviderAuthorityImport> {
        if page.protocol_version != CONTROL_PROTOCOL_VERSION
            || page.records.is_empty()
            || page.records.len() > 200
        {
            return Err(ApiError::bad_request(
                "invalid_authority_import_page",
                "Authority import pages must contain between 1 and 200 records.",
            ));
        }
        let mut ids = BTreeSet::new();
        let mut paths = BTreeSet::new();
        for item in &page.records {
            if item.record.record_id.is_nil()
                || !ids.insert(item.record.record_id)
                || !paths.insert(item.record.path.as_str())
                || item.document.len() as u64 > self.limits.max_bytes_per_document
            {
                return Err(ApiError::bad_request(
                    "invalid_authority_import_page",
                    "Authority import page contains invalid or duplicate records.",
                ));
            }
        }
        let mut transaction = self.pool.begin().await?;
        let row = authority_import_row(&mut transaction, import_id).await?;
        authorize_authority_import(&row, token)?;
        if row.get::<String, _>("import_state") != "receiving" {
            return Err(ApiError::conflict(
                "authority_import_finalized",
                "A finalized authority import cannot accept more record pages.",
            ));
        }
        if row
            .get::<Option<Vec<u8>>, _>("manifest_ciphertext")
            .is_none()
        {
            return Err(ApiError::conflict(
                "authority_import_manifest_required",
                "Upload the authority import manifest before record pages.",
            ));
        }
        let collection_id = row.get::<Uuid, _>("collection_id");
        let wrapped: Vec<u8> = row.get("wrapped_data_key");
        let data_key = self
            .crypto
            .unwrap_data_key(&wrapped, &collection_key_aad(collection_id))?;
        sqlx::query(
            "DELETE FROM hosted_provider_authority_import_records
             WHERE import_id = $1 AND page = $2",
        )
        .bind(import_id)
        .bind(to_i64(page.page, "import page")?)
        .execute(&mut *transaction)
        .await?;
        for item in &page.records {
            let ciphertext = self.crypto.encrypt_json(
                &data_key,
                item,
                &authority_import_record_aad(import_id, item.record.record_id),
            )?;
            let inserted = sqlx::query(
                r#"INSERT INTO hosted_provider_authority_import_records
                     (import_id, page, record_id, path_token, payload_ciphertext, content_bytes)
                   VALUES ($1, $2, $3, $4, $5, $6)"#,
            )
            .bind(import_id)
            .bind(to_i64(page.page, "import page")?)
            .bind(item.record.record_id)
            .bind(path_token(&data_key, &item.record.path))
            .bind(ciphertext)
            .bind(to_i64(item.document.len() as u64, "document size")?)
            .execute(&mut *transaction)
            .await;
            if let Err(sqlx::Error::Database(error)) = &inserted {
                if error.is_unique_violation() {
                    return Err(ApiError::conflict(
                        "authority_import_record_conflict",
                        "A record ID or path appears in more than one import page.",
                    ));
                }
            }
            inserted?;
        }
        let result = provider_authority_import(&row)?;
        transaction.commit().await?;
        Ok(result)
    }

    pub async fn finalize_authority_import(
        &self,
        import_id: Uuid,
        token: &str,
    ) -> ApiResult<ProviderAuthorityImport> {
        let mut transaction = self.pool.begin().await?;
        let row = authority_import_row(&mut transaction, import_id).await?;
        authorize_authority_import(&row, token)?;
        if row.get::<String, _>("import_state") == "uploaded" {
            let result = provider_authority_import(&row)?;
            transaction.commit().await?;
            return Ok(result);
        }
        let collection_id = row.get::<Uuid, _>("collection_id");
        let wrapped: Vec<u8> = row.get("wrapped_data_key");
        let data_key = self
            .crypto
            .unwrap_data_key(&wrapped, &collection_key_aad(collection_id))?;
        let manifest_ciphertext: Vec<u8> = row
            .get::<Option<Vec<u8>>, _>("manifest_ciphertext")
            .ok_or_else(|| {
                ApiError::conflict(
                    "authority_import_manifest_required",
                    "Authority import manifest has not been uploaded.",
                )
            })?;
        let mut manifest: AuthorityImportManifest = self.crypto.decrypt_json(
            &data_key,
            &manifest_ciphertext,
            &authority_import_manifest_aad(import_id),
        )?;
        let staged = sqlx::query(
            r#"SELECT record_id, payload_ciphertext
               FROM hosted_provider_authority_import_records
               WHERE import_id = $1 ORDER BY page, record_id"#,
        )
        .bind(import_id)
        .fetch_all(&mut *transaction)
        .await?;
        if staged.len() as u64 != manifest.record_count {
            return Err(ApiError::conflict(
                "authority_import_incomplete",
                "Not every authority snapshot record has been uploaded.",
            ));
        }
        let records = staged
            .into_iter()
            .map(|record| {
                let record_id: Uuid = record.get("record_id");
                let item: AuthoritySnapshotRecord = self.crypto.decrypt_json(
                    &data_key,
                    record.get("payload_ciphertext"),
                    &authority_import_record_aad(import_id, record_id),
                )?;
                if item.record.record_id != record_id {
                    return Err(ApiError::internal(
                        "Authority import record identity failed authentication.",
                    ));
                }
                Ok(item)
            })
            .collect::<ApiResult<Vec<_>>>()?;
        if snapshot_manifest_digest(&manifest.resources.documents, &records)
            != manifest.manifest_digest
        {
            return Err(ApiError::conflict(
                "authority_manifest_mismatch",
                "Uploaded authority snapshot does not match its manifest.",
            ));
        }
        let workspace = WorkingSet::materialize(
            manifest
                .resources
                .documents
                .iter()
                .map(|resource| (resource.path.clone(), resource.document.clone())),
            records.iter().map(|item| StoredDocument {
                record_id: item.record.record_id,
                path: item.record.path.clone(),
                document: item.document.clone(),
            }),
        )?;
        validate_imported_snapshot(&workspace, &manifest, &records)?;
        let (types, contracts) = workspace.type_resources()?;
        manifest.resources.types = types;
        manifest.resources.contracts = contracts;
        let content_bytes = records.iter().try_fold(0_u64, |total, item| {
            total
                .checked_add(item.document.len() as u64)
                .ok_or_else(|| {
                    ApiError::quota(
                        "content_quota_exceeded",
                        "Authority import content size is too large.",
                    )
                })
        })?;
        let max_content_bytes = number(row.get::<i64, _>("max_content_bytes"), "content quota")?;
        if content_bytes > max_content_bytes {
            return Err(ApiError::quota(
                "content_quota_exceeded",
                "Authority import exceeds the collection content quota.",
            ));
        }
        sqlx::query("DELETE FROM hosted_provider_changes WHERE collection_id = $1")
            .bind(collection_id)
            .execute(&mut *transaction)
            .await?;
        sqlx::query("DELETE FROM hosted_provider_record_versions WHERE collection_id = $1")
            .bind(collection_id)
            .execute(&mut *transaction)
            .await?;
        sqlx::query("DELETE FROM hosted_provider_records WHERE collection_id = $1")
            .bind(collection_id)
            .execute(&mut *transaction)
            .await?;
        sqlx::query("DELETE FROM hosted_provider_resources WHERE collection_id = $1")
            .bind(collection_id)
            .execute(&mut *transaction)
            .await?;
        for resource in &manifest.resources.documents {
            sqlx::query(
                r#"INSERT INTO hosted_provider_resources
                     (collection_id, path, kind, revision, document_ciphertext)
                   VALUES ($1, $2, $3, $4, $5)"#,
            )
            .bind(collection_id)
            .bind(&resource.path)
            .bind(&resource.kind)
            .bind(&resource.revision)
            .bind(self.crypto.encrypt_bytes(
                &data_key,
                resource.document.as_bytes(),
                &resource_document_aad(collection_id, &resource.path),
            )?)
            .execute(&mut *transaction)
            .await?;
        }
        let initial_sequence = (!records.is_empty()) as u64;
        for item in &records {
            persist_live_record(
                &mut transaction,
                &self.crypto,
                &data_key,
                collection_id,
                initial_sequence,
                &item.record,
                &item.document,
            )
            .await?;
        }
        let resources_ciphertext = self.crypto.encrypt_json(
            &data_key,
            &manifest.resources,
            &resources_aad(collection_id),
        )?;
        sqlx::query(
            r#"UPDATE hosted_provider_collections
               SET spec_version = $2, resource_revision = $3,
                   resources_ciphertext = $4, head = $5, retained_after = 0,
                   record_count = $6, content_bytes = $7, updated_at = now()
               WHERE id = $1 AND state = 'importing'"#,
        )
        .bind(collection_id)
        .bind(&manifest.resources.spec_version)
        .bind(&manifest.resources.revision)
        .bind(resources_ciphertext)
        .bind(to_i64(initial_sequence, "collection head")?)
        .bind(to_i64(records.len() as u64, "record count")?)
        .bind(to_i64(content_bytes, "content size")?)
        .execute(&mut *transaction)
        .await?;
        let saved = sqlx::query(
            r#"UPDATE hosted_provider_authority_imports
               SET state = 'uploaded', uploaded_at = now()
               WHERE id = $1
               RETURNING id, collection_id, next_authority_epoch, state,
                         manifest_digest, source_revision, source_head, expires_at"#,
        )
        .bind(import_id)
        .fetch_one(&mut *transaction)
        .await?;
        let result = provider_authority_import(&saved)?;
        transaction.commit().await?;
        self.working_sets.lock().await.remove(&collection_id);
        Ok(result)
    }

    pub async fn complete_authority_import(
        &self,
        import_id: Uuid,
        manifest_digest: &str,
        source_revision: &str,
    ) -> ApiResult<ProviderAuthorityImport> {
        let mut transaction = self.pool.begin().await?;
        let row = authority_import_row(&mut transaction, import_id).await?;
        let state: String = row.get("import_state");
        if state == "completed" {
            if row.get::<Option<String>, _>("manifest_digest").as_deref() != Some(manifest_digest)
                || row.get::<Option<String>, _>("source_revision").as_deref()
                    != Some(source_revision)
            {
                return Err(ApiError::conflict(
                    "authority_import_not_ready",
                    "Completed authority import does not match this snapshot.",
                ));
            }
            let result = provider_authority_import(&row)?;
            transaction.commit().await?;
            return Ok(result);
        }
        if state != "uploaded"
            || row.get::<Option<String>, _>("manifest_digest").as_deref() != Some(manifest_digest)
            || row.get::<Option<String>, _>("source_revision").as_deref() != Some(source_revision)
        {
            return Err(ApiError::conflict(
                "authority_import_not_ready",
                "Authority import does not match the fenced source snapshot.",
            ));
        }
        let collection_id: Uuid = row.get("collection_id");
        let authority_epoch = number(row.get::<i64, _>("next_authority_epoch"), "authority epoch")?;
        let activated = sqlx::query(
            r#"UPDATE hosted_provider_collections
               SET state = 'active', authority_epoch = $2, updated_at = now()
               WHERE id = $1 AND state = 'importing'"#,
        )
        .bind(collection_id)
        .bind(to_i64(authority_epoch, "authority epoch")?)
        .execute(&mut *transaction)
        .await?;
        if activated.rows_affected() != 1 {
            return Err(ApiError::conflict(
                "authority_import_target_unavailable",
                "Authority import target is no longer pending.",
            ));
        }
        let saved = sqlx::query(
            r#"UPDATE hosted_provider_authority_imports
               SET state = 'completed', completed_at = now()
               WHERE id = $1
               RETURNING id, collection_id, next_authority_epoch, state,
                         manifest_digest, source_revision, source_head, expires_at"#,
        )
        .bind(import_id)
        .fetch_one(&mut *transaction)
        .await?;
        let result = provider_authority_import(&saved)?;
        transaction.commit().await?;
        Ok(result)
    }

    pub async fn abort_authority_import(
        &self,
        import_id: Uuid,
    ) -> ApiResult<ProviderAuthorityImport> {
        let mut transaction = self.pool.begin().await?;
        let row = authority_import_row(&mut transaction, import_id).await?;
        if row.get::<String, _>("import_state") == "completed" {
            return Err(ApiError::conflict(
                "authority_import_completed",
                "Completed authority import cannot be cancelled.",
            ));
        }
        let result = ProviderAuthorityImport {
            state: "aborted".to_string(),
            ..provider_authority_import(&row)?
        };
        let collection_id = row.get::<Uuid, _>("collection_id");
        if row.get::<Option<String>, _>("restore_state").as_deref() == Some("transferred") {
            sqlx::query(
                r#"UPDATE hosted_provider_collections
                   SET state = 'transferred', authority_epoch = $2, updated_at = now()
                   WHERE id = $1 AND state = 'importing'"#,
            )
            .bind(collection_id)
            .bind(row.get::<i64, _>("next_authority_epoch") - 1)
            .execute(&mut *transaction)
            .await?;
            sqlx::query("DELETE FROM hosted_provider_authority_imports WHERE id = $1")
                .bind(import_id)
                .execute(&mut *transaction)
                .await?;
        } else {
            sqlx::query(
                "DELETE FROM hosted_provider_collections WHERE id = $1 AND state = 'importing'",
            )
            .bind(collection_id)
            .execute(&mut *transaction)
            .await?;
        }
        transaction.commit().await?;
        self.working_sets.lock().await.remove(&result.collection_id);
        Ok(result)
    }

    pub async fn rename_collection(
        &self,
        collection_id: Uuid,
        display_name: &str,
    ) -> ApiResult<()> {
        let display_name = display_name.trim();
        if display_name.is_empty() || display_name.chars().count() > 200 {
            return Err(ApiError::bad_request(
                "invalid_collection_name",
                "Hosted collection names must contain between 1 and 200 characters.",
            ));
        }
        let result = sqlx::query(
            "UPDATE hosted_provider_collections SET display_name = $2, updated_at = now() WHERE id = $1 AND state = 'active'",
        )
        .bind(collection_id)
        .bind(display_name)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(ApiError::not_found(
                "hosted_collection_not_found",
                "Hosted collection not found.",
            ));
        }
        Ok(())
    }

    pub async fn delete_collection(&self, collection_id: Uuid) -> ApiResult<()> {
        sqlx::query("DELETE FROM hosted_provider_collections WHERE id = $1")
            .bind(collection_id)
            .execute(&self.pool)
            .await?;
        self.working_sets.lock().await.remove(&collection_id);
        Ok(())
    }

    pub async fn register_replica(
        &self,
        collection_id: Uuid,
        mut input: RegisterReplica,
    ) -> ApiResult<()> {
        if input.name.trim().is_empty() || input.token.len() < 32 {
            return Err(ApiError::bad_request(
                "invalid_replica",
                "Replica name and credential are required.",
            ));
        }
        input.allowed_types.sort();
        input.allowed_types.dedup();
        input.allowed_operations.sort();
        input.allowed_operations.dedup();
        validate_replica_capability(&input)?;
        let token_ttl_seconds = input.token_ttl_seconds.unwrap_or(30 * 24 * 60 * 60);
        if !(60..=30 * 24 * 60 * 60).contains(&token_ttl_seconds) {
            return Err(ApiError::bad_request(
                "invalid_replica_ttl",
                "Replica credential lifetime must be between one minute and 30 days.",
            ));
        }
        let mode = replica_mode(input.mode);
        let purpose = replica_purpose(input.purpose);
        let name = input.name.trim().to_string();
        let requested_token_hash = token_hash(&input.token);
        let mut transaction = self.pool.begin().await?;
        let collection = sqlx::query(
            "SELECT max_replicas FROM hosted_provider_collections WHERE id = $1 FOR UPDATE",
        )
        .bind(collection_id)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or_else(|| {
            ApiError::not_found(
                "hosted_collection_not_found",
                "Hosted collection not found.",
            )
        })?;
        let max_replicas = number(collection.get::<i64, _>("max_replicas"), "replica quota")?;
        if let Some(existing) = sqlx::query(
            r#"SELECT collection_id, name, purpose, mode, allowed_types, full_collection,
                      allowed_operations, allowed_origin, proof_public_key, grant_id,
                      token_hash, revoked_at
               FROM hosted_provider_replicas WHERE id = $1 FOR UPDATE"#,
        )
        .bind(input.replica_id)
        .fetch_optional(&mut *transaction)
        .await?
        {
            let existing_hash: Vec<u8> = existing.get("token_hash");
            let exact_match = existing.get::<Uuid, _>("collection_id") == collection_id
                && existing.get::<String, _>("name") == name
                && existing.get::<String, _>("purpose") == purpose
                && existing.get::<String, _>("mode") == mode
                && existing.get::<Vec<String>, _>("allowed_types") == input.allowed_types
                && existing.get::<bool, _>("full_collection") == input.full_collection
                && existing.get::<Vec<String>, _>("allowed_operations") == input.allowed_operations
                && existing
                    .get::<Option<String>, _>("allowed_origin")
                    .as_deref()
                    == input.allowed_origin.as_deref()
                && existing
                    .get::<Option<String>, _>("proof_public_key")
                    .as_deref()
                    == input.proof_public_key.as_deref()
                && existing.get::<Option<Uuid>, _>("grant_id") == input.grant_id
                && existing
                    .get::<Option<chrono::DateTime<Utc>>, _>("revoked_at")
                    .is_none()
                && existing_hash.len() == requested_token_hash.len()
                && bool::from(existing_hash.as_slice().ct_eq(&requested_token_hash));
            if exact_match {
                transaction.commit().await?;
                return Ok(());
            }
            return Err(ApiError::conflict(
                "replica_conflict",
                "Replica already exists with a different capability.",
            ));
        }
        let replica_count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM hosted_provider_replicas WHERE collection_id = $1 AND revoked_at IS NULL",
        )
        .bind(collection_id)
        .fetch_one(&mut *transaction)
        .await?;
        if number(replica_count, "replica count")? >= max_replicas {
            return Err(ApiError::quota(
                "replica_quota_exceeded",
                "The hosted collection has reached its active replica limit.",
            ));
        }
        let result = sqlx::query(
            r#"INSERT INTO hosted_provider_replicas
                 (id, collection_id, name, purpose, mode, allowed_types, full_collection,
                  allowed_operations, allowed_origin, proof_public_key, grant_id, token_hash,
                  token_expires_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                       now() + ($13 * interval '1 second'))"#,
        )
        .bind(input.replica_id)
        .bind(collection_id)
        .bind(name)
        .bind(purpose)
        .bind(mode)
        .bind(input.allowed_types)
        .bind(input.full_collection)
        .bind(input.allowed_operations)
        .bind(input.allowed_origin)
        .bind(input.proof_public_key)
        .bind(input.grant_id)
        .bind(requested_token_hash)
        .bind(to_i64(token_ttl_seconds, "replica credential lifetime")?)
        .execute(&mut *transaction)
        .await;
        match result {
            Ok(_) => {
                transaction.commit().await?;
                Ok(())
            }
            Err(sqlx::Error::Database(error)) if error.is_foreign_key_violation() => {
                Err(ApiError::not_found(
                    "hosted_collection_not_found",
                    "Hosted collection not found.",
                ))
            }
            Err(sqlx::Error::Database(error)) if error.is_unique_violation() => Err(
                ApiError::conflict("replica_conflict", "Replica already exists."),
            ),
            Err(error) => Err(error.into()),
        }
    }

    pub async fn replica_statuses(
        &self,
        collection_id: Uuid,
    ) -> ApiResult<Vec<ProviderReplicaStatus>> {
        let rows = sqlx::query(
            r#"SELECT replica.id, collection.head, replica.acknowledged_sequence,
                      replica.last_seen_at, replica.token_expires_at
               FROM hosted_provider_replicas replica
               JOIN hosted_provider_collections collection
                 ON collection.id = replica.collection_id
               WHERE replica.collection_id = $1
                 AND replica.purpose = 'mirror'
                 AND replica.revoked_at IS NULL
               ORDER BY replica.created_at"#,
        )
        .bind(collection_id)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| {
                Ok(ProviderReplicaStatus {
                    id: row.get("id"),
                    head: number(row.get::<i64, _>("head"), "collection head")?,
                    acknowledged_sequence: number(
                        row.get::<i64, _>("acknowledged_sequence"),
                        "acknowledged sequence",
                    )?,
                    last_seen_at: row.get("last_seen_at"),
                    token_expires_at: row.get("token_expires_at"),
                })
            })
            .collect()
    }

    pub async fn prepare_authority_transfer(
        &self,
        collection_id: Uuid,
        input: PrepareAuthorityTransfer,
    ) -> ApiResult<ProviderAuthorityTransfer> {
        if !(60..=60 * 60).contains(&input.ttl_seconds) {
            return Err(ApiError::bad_request(
                "invalid_authority_transfer_ttl",
                "Authority transfer preparation must expire between one minute and one hour.",
            ));
        }
        let mut transaction = self.pool.begin().await?;
        recover_expired_authority_transfers_in(&mut transaction).await?;
        let collection = sqlx::query(
            r#"SELECT state, authority_epoch, head, wrapped_data_key
               FROM hosted_provider_collections
               WHERE id = $1
               FOR UPDATE"#,
        )
        .bind(collection_id)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or_else(|| {
            ApiError::not_found(
                "hosted_collection_not_found",
                "Hosted collection not found.",
            )
        })?;
        if let Some(existing) = sqlx::query(
            r#"SELECT id, collection_id, replica_id, final_head, next_authority_epoch,
                      manifest_digest, state, expires_at
               FROM hosted_provider_authority_transfers
               WHERE id = $1"#,
        )
        .bind(input.transfer_id)
        .fetch_optional(&mut *transaction)
        .await?
        {
            if existing.get::<Uuid, _>("collection_id") != collection_id
                || existing.get::<Uuid, _>("replica_id") != input.replica_id
            {
                return Err(ApiError::conflict(
                    "authority_transfer_conflict",
                    "Authority transfer already exists for another collection or mirror.",
                ));
            }
            let result = provider_authority_transfer(&existing)?;
            transaction.commit().await?;
            return Ok(result);
        }
        if collection.get::<String, _>("state") != "active" {
            return Err(ApiError::conflict(
                "authority_transfer_unavailable",
                "The hosted collection is not available for authority transfer.",
            ));
        }
        let replica = sqlx::query(
            r#"SELECT purpose, mode, allowed_types, revoked_at
               FROM hosted_provider_replicas
               WHERE id = $1 AND collection_id = $2
               FOR UPDATE"#,
        )
        .bind(input.replica_id)
        .bind(collection_id)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or_else(|| {
            ApiError::not_found("replica_not_found", "The promotion mirror was not found.")
        })?;
        let eligible = replica.get::<String, _>("purpose") == "mirror"
            && replica.get::<String, _>("mode") == "read_write"
            && replica.get::<Vec<String>, _>("allowed_types").is_empty()
            && replica
                .get::<Option<DateTime<Utc>>, _>("revoked_at")
                .is_none();
        if !eligible {
            return Err(ApiError::conflict(
                "promotion_mirror_ineligible",
                "Authority can move only to an active, two-way, full collection mirror.",
            ));
        }
        let head = number(collection.get::<i64, _>("head"), "collection head")?;
        let current_epoch = number(
            collection.get::<i64, _>("authority_epoch"),
            "authority epoch",
        )?;
        let next_epoch = current_epoch
            .checked_add(1)
            .ok_or_else(|| ApiError::internal("The collection authority epoch is exhausted."))?;
        let data_key = self.collection_key(collection_id, collection.get("wrapped_data_key"))?;
        let resources =
            load_resource_documents(&mut transaction, &self.crypto, &data_key, collection_id)
                .await?;
        let records =
            load_records(&mut transaction, &self.crypto, &data_key, collection_id).await?;
        let manifest_digest = authority_manifest_digest(resources, records);
        let expires_at = Utc::now()
            + chrono::Duration::seconds(to_i64(input.ttl_seconds, "authority transfer lifetime")?);
        sqlx::query(
            r#"INSERT INTO hosted_provider_authority_transfers
                 (id, collection_id, replica_id, final_head, next_authority_epoch,
                  manifest_digest, expires_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7)"#,
        )
        .bind(input.transfer_id)
        .bind(collection_id)
        .bind(input.replica_id)
        .bind(to_i64(head, "collection head")?)
        .bind(to_i64(next_epoch, "authority epoch")?)
        .bind(&manifest_digest)
        .bind(expires_at)
        .execute(&mut *transaction)
        .await
        .map_err(|error| match error {
            sqlx::Error::Database(ref database) if database.is_unique_violation() => {
                ApiError::conflict(
                    "authority_transfer_in_progress",
                    "Another authority transfer is already in progress.",
                )
            }
            other => other.into(),
        })?;
        sqlx::query(
            "UPDATE hosted_provider_collections SET state = 'transferring', updated_at = now() WHERE id = $1",
        )
        .bind(collection_id)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(ProviderAuthorityTransfer {
            id: input.transfer_id,
            collection_id,
            replica_id: input.replica_id,
            final_head: head,
            authority_epoch: next_epoch,
            manifest_digest,
            state: "prepared".to_string(),
            expires_at,
        })
    }

    pub async fn complete_authority_transfer(
        &self,
        transfer_id: Uuid,
        manifest_digest: &str,
    ) -> ApiResult<ProviderAuthorityTransfer> {
        let mut transaction = self.pool.begin().await?;
        let row = sqlx::query(
            r#"SELECT transfer.id, transfer.collection_id, transfer.replica_id,
                      transfer.final_head, transfer.next_authority_epoch,
                      transfer.manifest_digest, transfer.state, transfer.expires_at,
                      collection.state AS collection_state,
                      replica.acknowledged_sequence
               FROM hosted_provider_authority_transfers transfer
               JOIN hosted_provider_collections collection
                 ON collection.id = transfer.collection_id
               JOIN hosted_provider_replicas replica
                 ON replica.id = transfer.replica_id
               WHERE transfer.id = $1
               FOR UPDATE OF transfer, collection, replica"#,
        )
        .bind(transfer_id)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or_else(|| {
            ApiError::not_found(
                "authority_transfer_not_found",
                "Authority transfer was not found.",
            )
        })?;
        let transfer = provider_authority_transfer(&row)?;
        if transfer.state == "completed" {
            transaction.commit().await?;
            return Ok(transfer);
        }
        if transfer.state != "prepared" {
            return Err(ApiError::conflict(
                "authority_transfer_inactive",
                "Authority transfer is no longer active.",
            ));
        }
        if transfer.expires_at <= Utc::now() {
            sqlx::query(
                "UPDATE hosted_provider_authority_transfers SET state = 'aborted', aborted_at = now() WHERE id = $1",
            )
            .bind(transfer_id)
            .execute(&mut *transaction)
            .await?;
            sqlx::query(
                "UPDATE hosted_provider_collections SET state = 'active', updated_at = now() WHERE id = $1 AND state = 'transferring'",
            )
            .bind(transfer.collection_id)
            .execute(&mut *transaction)
            .await?;
            transaction.commit().await?;
            return Err(ApiError::conflict(
                "authority_transfer_expired",
                "Authority transfer expired and hosted writes were restored.",
            ));
        }
        if row.get::<String, _>("collection_state") != "transferring" {
            return Err(ApiError::conflict(
                "authority_transfer_inactive",
                "The hosted collection is no longer fenced for this transfer.",
            ));
        }
        if !constant_time_text_equal(&transfer.manifest_digest, manifest_digest) {
            return Err(ApiError::conflict(
                "authority_manifest_mismatch",
                "The local folder does not exactly match the fenced hosted collection.",
            ));
        }
        let acknowledged = number(
            row.get::<i64, _>("acknowledged_sequence"),
            "replica acknowledged sequence",
        )?;
        if acknowledged < transfer.final_head {
            return Err(ApiError::conflict(
                "promotion_mirror_behind",
                "The local mirror has not acknowledged the final hosted sequence.",
            ));
        }
        sqlx::query(
            r#"UPDATE hosted_provider_collections
               SET state = 'transferred', authority_epoch = $2, updated_at = now()
               WHERE id = $1 AND state = 'transferring'"#,
        )
        .bind(transfer.collection_id)
        .bind(to_i64(transfer.authority_epoch, "authority epoch")?)
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            r#"UPDATE hosted_provider_authority_transfers
               SET state = 'completed', completed_at = now()
               WHERE id = $1"#,
        )
        .bind(transfer_id)
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            "UPDATE hosted_provider_replicas SET revoked_at = COALESCE(revoked_at, now()) WHERE collection_id = $1",
        )
        .bind(transfer.collection_id)
        .execute(&mut *transaction)
        .await?;
        sqlx::query("DELETE FROM hosted_provider_snapshot_leases WHERE collection_id = $1")
            .bind(transfer.collection_id)
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
        self.working_sets
            .lock()
            .await
            .remove(&transfer.collection_id);
        Ok(ProviderAuthorityTransfer {
            state: "completed".to_string(),
            ..transfer
        })
    }

    pub async fn abort_authority_transfer(
        &self,
        transfer_id: Uuid,
    ) -> ApiResult<ProviderAuthorityTransfer> {
        let mut transaction = self.pool.begin().await?;
        let row = sqlx::query(
            r#"SELECT id, collection_id, replica_id, final_head, next_authority_epoch,
                      manifest_digest, state, expires_at
               FROM hosted_provider_authority_transfers
               WHERE id = $1
               FOR UPDATE"#,
        )
        .bind(transfer_id)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or_else(|| {
            ApiError::not_found(
                "authority_transfer_not_found",
                "Authority transfer was not found.",
            )
        })?;
        let transfer = provider_authority_transfer(&row)?;
        if transfer.state == "completed" {
            return Err(ApiError::conflict(
                "authority_transfer_completed",
                "Completed authority transfer cannot be cancelled.",
            ));
        }
        if transfer.state == "prepared" {
            sqlx::query(
                "UPDATE hosted_provider_authority_transfers SET state = 'aborted', aborted_at = now() WHERE id = $1",
            )
            .bind(transfer_id)
            .execute(&mut *transaction)
            .await?;
            sqlx::query(
                "UPDATE hosted_provider_collections SET state = 'active', updated_at = now() WHERE id = $1 AND state = 'transferring'",
            )
            .bind(transfer.collection_id)
            .execute(&mut *transaction)
            .await?;
        }
        transaction.commit().await?;
        Ok(ProviderAuthorityTransfer {
            state: "aborted".to_string(),
            ..transfer
        })
    }

    pub async fn recover_expired_authority_transfers(&self) -> ApiResult<usize> {
        let mut transaction = self.pool.begin().await?;
        let recovered = recover_expired_authority_transfers_in(&mut transaction).await?;
        transaction.commit().await?;
        Ok(recovered)
    }

    pub async fn recover_expired_authority_imports(&self) -> ApiResult<usize> {
        let mut transaction = self.pool.begin().await?;
        let expired = sqlx::query(
            r#"SELECT collection_id FROM hosted_provider_authority_imports
               WHERE state IN ('receiving', 'uploaded') AND expires_at <= now()
               FOR UPDATE"#,
        )
        .fetch_all(&mut *transaction)
        .await?;
        let collection_ids = expired
            .iter()
            .map(|row| row.get::<Uuid, _>("collection_id"))
            .collect::<Vec<_>>();
        let recovered = recover_expired_authority_imports_in(&mut transaction).await?;
        transaction.commit().await?;
        if recovered > 0 {
            let mut working_sets = self.working_sets.lock().await;
            for collection_id in collection_ids {
                working_sets.remove(&collection_id);
            }
        }
        Ok(recovered)
    }

    pub async fn rotate_replica_token(
        &self,
        replica_id: Uuid,
        token: &str,
        token_ttl_seconds: Option<u64>,
    ) -> ApiResult<()> {
        if token.len() < 32 {
            return Err(ApiError::bad_request(
                "invalid_replica_token",
                "Replica credential is too short.",
            ));
        }
        let token_ttl_seconds = token_ttl_seconds.unwrap_or(30 * 24 * 60 * 60);
        if !(60..=30 * 24 * 60 * 60).contains(&token_ttl_seconds) {
            return Err(ApiError::bad_request(
                "invalid_replica_ttl",
                "Replica credential lifetime must be between one minute and 30 days.",
            ));
        }
        let result = sqlx::query(
            r#"UPDATE hosted_provider_replicas
               SET token_hash = $2, token_expires_at = now() + ($3 * interval '1 second')
               WHERE id = $1 AND revoked_at IS NULL"#,
        )
        .bind(replica_id)
        .bind(token_hash(token))
        .bind(to_i64(token_ttl_seconds, "replica credential lifetime")?)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(ApiError::not_found(
                "replica_not_found",
                "Active replica not found.",
            ));
        }
        Ok(())
    }

    pub async fn authorize_request(
        &self,
        collection_id: Uuid,
        token: &str,
        request_origin: Option<&str>,
        proof: Option<&AuthorityRequestProof>,
    ) -> ApiResult<()> {
        // Originless mirror traffic is authenticated again inside the requested
        // operation. Avoid a duplicate database round trip for that hot path.
        // Application capabilities with an allowed origin still fail closed in
        // the operation-level origin check when the header is omitted.
        if request_origin.is_none() && proof.is_none() {
            return Ok(());
        }
        let mut transaction = self.pool.begin().await?;
        let row = sqlx::query(
            r#"SELECT id, purpose, mode, allowed_types, full_collection, allowed_operations,
                      allowed_origin, proof_public_key, grant_id, scope_epoch
               FROM hosted_provider_replicas
               WHERE collection_id = $1 AND token_hash = $2
                 AND revoked_at IS NULL AND token_expires_at > now()
               FOR SHARE"#,
        )
        .bind(collection_id)
        .bind(token_hash(token))
        .fetch_optional(&mut *transaction)
        .await?;
        let replica = replica_from_row(row)?;
        match replica.purpose {
            ReplicaPurpose::Mirror => {
                if request_origin.is_some() || proof.is_some() {
                    return Err(ApiError::forbidden(
                        "origin_denied",
                        "Mirror credentials cannot be used by browser applications.",
                    ));
                }
            }
            ReplicaPurpose::Application => {
                authorize_application_origin(&replica, request_origin)?;
                if let Some(public_key) = replica.proof_public_key.as_deref() {
                    let proof = proof.ok_or_else(|| {
                        ApiError::unauthorized(
                            "authority_proof_required",
                            "The hosted capability requires proof from its approved application key.",
                        )
                    })?;
                    verify_hosted_request_proof(public_key, token, proof)?;
                    let inserted = sqlx::query(
                        r#"INSERT INTO hosted_provider_request_proofs (replica_id, nonce)
                           VALUES ($1, $2)
                           ON CONFLICT (replica_id, nonce) DO NOTHING
                           RETURNING nonce"#,
                    )
                    .bind(replica.id)
                    .bind(proof.nonce)
                    .fetch_optional(&mut *transaction)
                    .await?;
                    if inserted.is_none() {
                        return Err(ApiError::unauthorized(
                            "authority_proof_replayed",
                            "The authority request proof has already been used.",
                        ));
                    }
                    sqlx::query(
                        "DELETE FROM hosted_provider_request_proofs WHERE created_at < now() - interval '10 minutes'",
                    )
                    .execute(&mut *transaction)
                    .await?;
                }
            }
        }
        transaction.commit().await?;
        Ok(())
    }

    pub async fn update_application_replica(
        &self,
        replica_id: Uuid,
        mut input: UpdateApplicationReplica,
    ) -> ApiResult<()> {
        input.allowed_types.sort();
        input.allowed_types.dedup();
        input.allowed_operations.sort();
        input.allowed_operations.dedup();
        validate_operations(&input.allowed_operations, input.mode)?;
        if input.allowed_operations.is_empty() {
            return Err(ApiError::bad_request(
                "invalid_application_capability",
                "Application capabilities require at least one operation.",
            ));
        }
        validate_collection_scope(
            input.full_collection,
            &input.allowed_types,
            &input.allowed_operations,
        )?;
        let result = sqlx::query(
            r#"UPDATE hosted_provider_replicas
               SET scope_epoch = scope_epoch + CASE
                     WHEN mode IS DISTINCT FROM $2
                       OR allowed_types IS DISTINCT FROM $3
                       OR full_collection IS DISTINCT FROM $4
                       OR allowed_operations IS DISTINCT FROM $5
                       OR grant_id IS DISTINCT FROM $6
                     THEN 1 ELSE 0 END,
                   mode = $2,
                   allowed_types = $3,
                   full_collection = $4,
                   allowed_operations = $5,
                   grant_id = $6
               WHERE id = $1 AND purpose = 'application' AND revoked_at IS NULL"#,
        )
        .bind(replica_id)
        .bind(replica_mode(input.mode))
        .bind(input.allowed_types)
        .bind(input.full_collection)
        .bind(input.allowed_operations)
        .bind(input.grant_id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(ApiError::not_found(
                "replica_not_found",
                "Active application capability not found.",
            ));
        }
        Ok(())
    }

    pub async fn revoke_replica(&self, replica_id: Uuid) -> ApiResult<()> {
        sqlx::query(
            "UPDATE hosted_provider_replicas SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL",
        )
        .bind(replica_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn compact_through(&self, collection_id: Uuid, through: u64) -> ApiResult<()> {
        let mut transaction = self.pool.begin().await?;
        sqlx::query("DELETE FROM hosted_provider_snapshot_leases WHERE expires_at <= now()")
            .execute(&mut *transaction)
            .await?;
        let row = sqlx::query(
            "SELECT head, retained_after FROM hosted_provider_collections WHERE id = $1 FOR UPDATE",
        )
        .bind(collection_id)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or_else(|| {
            ApiError::not_found(
                "hosted_collection_not_found",
                "Hosted collection not found.",
            )
        })?;
        let head = number(row.get::<i64, _>("head"), "collection head")?;
        let retained = number(row.get::<i64, _>("retained_after"), "retained cursor")?;
        if through < retained || through > head {
            return Err(ApiError::bad_request(
                "invalid_cursor",
                "Compaction cursor is outside retained history.",
            ));
        }
        sqlx::query(
            "UPDATE hosted_provider_collections SET retained_after = $2, updated_at = now() WHERE id = $1",
        )
        .bind(collection_id)
        .bind(to_i64(through, "compaction cursor")?)
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            "DELETE FROM hosted_provider_changes WHERE collection_id = $1 AND sequence <= $2",
        )
        .bind(collection_id)
        .bind(to_i64(through, "compaction cursor")?)
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            "DELETE FROM hosted_provider_resource_changes WHERE collection_id = $1 AND sequence <= $2",
        )
        .bind(collection_id)
        .bind(to_i64(through, "compaction cursor")?)
        .execute(&mut *transaction)
        .await?;
        let through_i64 = to_i64(through, "compaction cursor")?;
        let oldest_live_snapshot: Option<i64> = sqlx::query_scalar(
            r#"SELECT min(cursor) FROM hosted_provider_snapshot_leases
               WHERE collection_id = $1 AND expires_at > now()"#,
        )
        .bind(collection_id)
        .fetch_one(&mut *transaction)
        .await?;
        let prune_boundary = oldest_live_snapshot
            .map(|cursor| cursor.min(through_i64))
            .unwrap_or(through_i64);
        sqlx::query(
            r#"DELETE FROM hosted_provider_record_versions version
               WHERE version.collection_id = $1
                 AND version.sequence <= $2
                 AND version.sequence < (
                   SELECT max(anchor.sequence)
                   FROM hosted_provider_record_versions anchor
                   WHERE anchor.collection_id = version.collection_id
                     AND anchor.record_id = version.record_id
                     AND anchor.sequence <= $2
                 )"#,
        )
        .bind(collection_id)
        .bind(prune_boundary)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(())
    }

    /// Bounds the durable change log without relying on a control-plane cron.
    /// Replicas behind the retained cursor deliberately use the ordinary
    /// snapshot-reset path on their next pull.
    pub async fn compact_stale_history(&self, retain_changes: u64) -> ApiResult<usize> {
        let rows = sqlx::query(
            r#"SELECT id, head
               FROM hosted_provider_collections
               WHERE state = 'active' AND head - retained_after > $1
               ORDER BY updated_at"#,
        )
        .bind(to_i64(retain_changes, "history retention")?)
        .fetch_all(&self.pool)
        .await?;
        let mut compacted = 0;
        for row in rows {
            let collection_id: Uuid = row.get("id");
            let head = number(row.get::<i64, _>("head"), "collection head")?;
            self.compact_through(collection_id, head.saturating_sub(retain_changes))
                .await?;
            compacted += 1;
        }
        Ok(compacted)
    }

    pub async fn open_session(
        &self,
        collection_id: Uuid,
        token: &str,
        request_origin: Option<&str>,
    ) -> ApiResult<SyncSession> {
        let replica = self
            .authenticate_for_sync(collection_id, token, "read", request_origin)
            .await?;
        let row = sqlx::query(
            r#"SELECT head, retained_after, resource_revision, wrapped_data_key, resources_ciphertext
               FROM hosted_provider_collections collection
               WHERE id = $1 AND (
                 state = 'active'
                 OR (
                   state = 'transferring'
                   AND EXISTS (
                     SELECT 1 FROM hosted_provider_authority_transfers transfer
                     WHERE transfer.collection_id = collection.id
                       AND transfer.replica_id = $2
                       AND transfer.state = 'prepared'
                       AND transfer.expires_at > now()
                   )
                 )
               )"#,
        )
        .bind(collection_id)
        .bind(replica.id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| {
            ApiError::not_found(
                "hosted_collection_not_found",
                "Hosted collection not found.",
            )
        })?;
        let head = number(row.get::<i64, _>("head"), "collection head")?;
        let retained_after = number(row.get::<i64, _>("retained_after"), "retained cursor")?;
        let resource_revision: String = row.get("resource_revision");
        let data_key = self.collection_key(collection_id, row.get("wrapped_data_key"))?;
        let mut resources: SyncCollectionResources = self.crypto.decrypt_json(
            &data_key,
            row.get("resources_ciphertext"),
            &resources_aad(collection_id),
        )?;
        resources.documents =
            load_sync_resource_documents(&self.pool, &self.crypto, &data_key, collection_id)
                .await?;
        let snapshot_id = Uuid::new_v4();
        let mut transaction = self.pool.begin().await?;
        sqlx::query("DELETE FROM hosted_provider_snapshot_leases WHERE expires_at <= now()")
            .execute(&mut *transaction)
            .await?;
        sqlx::query(
            r#"INSERT INTO hosted_provider_snapshot_leases
                 (id, collection_id, replica_id, scope_epoch, cursor, resource_revision, expires_at)
               VALUES ($1, $2, $3, $4, $5, $6, now() + interval '15 minutes')"#,
        )
        .bind(snapshot_id)
        .bind(collection_id)
        .bind(replica.id)
        .bind(to_i64(replica.scope_epoch, "scope epoch")?)
        .bind(to_i64(head, "collection head")?)
        .bind(resource_revision)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(SyncSession {
            protocol_version: SYNC_PROTOCOL_VERSION,
            session_id: Uuid::new_v4(),
            replica_id: replica.id,
            collection_id,
            mode: replica.mode,
            scope_epoch: replica.scope_epoch,
            retained_after,
            head,
            snapshot_id,
            resources: scoped_resources(resources, &replica.allowed_types),
        })
    }

    pub async fn snapshot(
        &self,
        collection_id: Uuid,
        token: &str,
        snapshot_id: Uuid,
        page: Option<&str>,
        request_origin: Option<&str>,
    ) -> ApiResult<SyncSnapshotPage> {
        let replica = self
            .authenticate_for_sync(collection_id, token, "read", request_origin)
            .await?;
        let after_record_id = page
            .map(|value| {
                Uuid::parse_str(value).map_err(|_| {
                    ApiError::bad_request("invalid_page", "Snapshot page token is invalid.")
                })
            })
            .transpose()?;
        let lease = sqlx::query(
            r#"SELECT lease.cursor, lease.scope_epoch, collection.wrapped_data_key
               FROM hosted_provider_snapshot_leases lease
               JOIN hosted_provider_collections collection ON collection.id = lease.collection_id
               WHERE lease.id = $1 AND lease.collection_id = $2 AND lease.replica_id = $3
                 AND lease.expires_at > now()
                 AND (
                   collection.state = 'active'
                   OR (
                     collection.state = 'transferring'
                     AND EXISTS (
                       SELECT 1 FROM hosted_provider_authority_transfers transfer
                       WHERE transfer.collection_id = collection.id
                         AND transfer.replica_id = $3
                         AND transfer.state = 'prepared'
                         AND transfer.expires_at > now()
                     )
                   )
                 )"#,
        )
        .bind(snapshot_id)
        .bind(collection_id)
        .bind(replica.id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| {
            ApiError::conflict(
                "snapshot_expired",
                "The snapshot is unavailable; open a new sync session.",
            )
        })?;
        let cursor = number(lease.get::<i64, _>("cursor"), "snapshot cursor")?;
        let scope_epoch = number(lease.get::<i64, _>("scope_epoch"), "scope epoch")?;
        if scope_epoch != replica.scope_epoch {
            return Err(ApiError::conflict(
                "snapshot_expired",
                "The replica scope changed; open a new sync session.",
            ));
        }
        let data_key = self.collection_key(collection_id, lease.get("wrapped_data_key"))?;
        let rows = sqlx::query(
            r#"SELECT record_id, revision, types, sequence, payload_ciphertext
               FROM (
                 SELECT DISTINCT ON (record_id)
                   record_id, revision, types, sequence, payload_ciphertext, deleted
                 FROM hosted_provider_record_versions
                 WHERE collection_id = $1 AND sequence <= $2
                 ORDER BY record_id, sequence DESC
               ) versions
               WHERE deleted = false
                 AND (cardinality($3::text[]) = 0 OR types && $3::text[])
                 AND ($4::uuid IS NULL OR record_id > $4)
               ORDER BY record_id
               LIMIT $5"#,
        )
        .bind(collection_id)
        .bind(to_i64(cursor, "snapshot cursor")?)
        .bind(&replica.allowed_types)
        .bind(after_record_id)
        .bind(SNAPSHOT_PAGE_SIZE + 1)
        .fetch_all(&self.pool)
        .await?;
        let has_more = rows.len() > SNAPSHOT_PAGE_SIZE as usize;
        let page_rows = rows
            .into_iter()
            .take(SNAPSHOT_PAGE_SIZE as usize)
            .collect::<Vec<_>>();
        let next_page = has_more.then(|| {
            page_rows
                .last()
                .expect("a full snapshot page has a final record")
                .get::<Uuid, _>("record_id")
                .to_string()
        });
        let records = page_rows
            .into_iter()
            .map(|row| {
                let sequence = number(row.get::<i64, _>("sequence"), "record sequence")?;
                let payload: PersistedRecord = self.crypto.decrypt_json(
                    &data_key,
                    row.get("payload_ciphertext"),
                    &record_version_aad(collection_id, row.get("record_id"), sequence),
                )?;
                Ok(payload.record)
            })
            .collect::<ApiResult<Vec<_>>>()?;
        if next_page.is_none() {
            sqlx::query(
                r#"UPDATE hosted_provider_replicas
                   SET acknowledged_sequence = GREATEST(acknowledged_sequence, $2),
                       last_seen_at = now()
                   WHERE id = $1"#,
            )
            .bind(replica.id)
            .bind(to_i64(cursor, "snapshot cursor")?)
            .execute(&self.pool)
            .await?;
        }
        Ok(SyncSnapshotPage {
            protocol_version: SYNC_PROTOCOL_VERSION,
            snapshot_id,
            scope_epoch,
            cursor,
            records,
            next_page,
        })
    }

    pub async fn changes(
        &self,
        collection_id: Uuid,
        token: &str,
        after: u64,
        limit: u32,
        request_origin: Option<&str>,
    ) -> ApiResult<SyncChangesPage> {
        let replica = self
            .authenticate_for_sync(collection_id, token, "changes", request_origin)
            .await?;
        let collection = sqlx::query(
            r#"SELECT head, retained_after, wrapped_data_key
               FROM hosted_provider_collections collection
               WHERE id = $1 AND (
                 state = 'active'
                 OR (
                   state = 'transferring'
                   AND EXISTS (
                     SELECT 1 FROM hosted_provider_authority_transfers transfer
                     WHERE transfer.collection_id = collection.id
                       AND transfer.replica_id = $2
                       AND transfer.state = 'prepared'
                       AND transfer.expires_at > now()
                   )
                 )
               )"#,
        )
        .bind(collection_id)
        .bind(replica.id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| {
            ApiError::not_found(
                "hosted_collection_not_found",
                "Hosted collection not found.",
            )
        })?;
        let head = number(collection.get::<i64, _>("head"), "collection head")?;
        let retained_after = number(
            collection.get::<i64, _>("retained_after"),
            "retained cursor",
        )?;
        let data_key = self.collection_key(collection_id, collection.get("wrapped_data_key"))?;
        if after < retained_after {
            return Ok(SyncChangesPage {
                protocol_version: SYNC_PROTOCOL_VERSION,
                scope_epoch: replica.scope_epoch,
                events: Vec::new(),
                cursor: after,
                head,
                has_more: false,
                reset_required: true,
            });
        }
        if after > head {
            return Err(ApiError::bad_request(
                "invalid_cursor",
                "Change cursor is ahead of the collection authority.",
            ));
        }
        let resource_changed = sqlx::query_scalar::<_, bool>(
            r#"SELECT EXISTS(
                 SELECT 1 FROM hosted_provider_resource_changes
                 WHERE collection_id = $1 AND sequence > $2
               )"#,
        )
        .bind(collection_id)
        .bind(to_i64(after, "change cursor")?)
        .fetch_one(&self.pool)
        .await?;
        if resource_changed {
            return Ok(SyncChangesPage {
                protocol_version: SYNC_PROTOCOL_VERSION,
                scope_epoch: replica.scope_epoch,
                events: Vec::new(),
                cursor: after,
                head,
                has_more: false,
                reset_required: true,
            });
        }
        let raw_limit = i64::from(limit.clamp(1, 500));
        let rows = sqlx::query(
            r#"SELECT sequence, record_id, before_ciphertext, after_ciphertext, revision
               FROM hosted_provider_changes
               WHERE collection_id = $1 AND sequence > $2
               ORDER BY sequence
               LIMIT $3"#,
        )
        .bind(collection_id)
        .bind(to_i64(after, "change cursor")?)
        .bind(raw_limit)
        .fetch_all(&self.pool)
        .await?;
        let cursor = rows
            .last()
            .map(|row| number(row.get::<i64, _>("sequence"), "change sequence"))
            .transpose()?
            .unwrap_or(after);
        let mut events = Vec::new();
        for row in rows {
            let sequence = number(row.get::<i64, _>("sequence"), "change sequence")?;
            let record_id: Uuid = row.get("record_id");
            let before = optional_encrypted_record(
                &self.crypto,
                &data_key,
                row.get("before_ciphertext"),
                &change_record_aad(collection_id, sequence, "before"),
            )?;
            let after_record = optional_encrypted_record(
                &self.crypto,
                &data_key,
                row.get("after_ciphertext"),
                &change_record_aad(collection_id, sequence, "after"),
            )?;
            let before_visible = before
                .as_ref()
                .is_some_and(|record| visible(record, &replica.allowed_types));
            let after_visible = after_record
                .as_ref()
                .is_some_and(|record| visible(record, &replica.allowed_types));
            if after_visible {
                events.push(SyncChange::Put {
                    sequence,
                    record: after_record.expect("visibility checked above"),
                });
            } else if before_visible {
                let before = before.expect("visibility checked above");
                events.push(SyncChange::Remove {
                    sequence,
                    record_id,
                    previous_path: before.path,
                    revision: row.get("revision"),
                });
            }
        }
        sqlx::query(
            r#"UPDATE hosted_provider_replicas
               SET acknowledged_sequence = GREATEST(acknowledged_sequence, $2), last_seen_at = now()
               WHERE id = $1"#,
        )
        .bind(replica.id)
        .bind(to_i64(cursor, "change cursor")?)
        .execute(&self.pool)
        .await?;
        Ok(SyncChangesPage {
            protocol_version: SYNC_PROTOCOL_VERSION,
            scope_epoch: replica.scope_epoch,
            events,
            cursor,
            head,
            has_more: cursor < head,
            reset_required: false,
        })
    }

    pub async fn mutate(
        &self,
        collection_id: Uuid,
        token: &str,
        mutation: SyncMutation,
        request_origin: Option<&str>,
    ) -> ApiResult<SyncMutationReceipt> {
        self.mutate_for_sync(collection_id, token, mutation, request_origin)
            .await
    }

    async fn mutate_for_sync(
        &self,
        collection_id: Uuid,
        token: &str,
        mutation: SyncMutation,
        request_origin: Option<&str>,
    ) -> ApiResult<SyncMutationReceipt> {
        let mut transaction = self.pool.begin().await?;
        let required_operation = mutation_operation_name(mutation.operation);
        let replica = authenticate_in_for_sync(
            &mut transaction,
            collection_id,
            token,
            required_operation,
            request_origin,
        )
        .await?;
        self.mutate_in_transaction(transaction, collection_id, mutation, replica)
            .await
    }

    async fn mutate_for(
        &self,
        collection_id: Uuid,
        token: &str,
        mutation: SyncMutation,
        purpose: ReplicaPurpose,
    ) -> ApiResult<SyncMutationReceipt> {
        let mut transaction = self.pool.begin().await?;
        let replica = authenticate_in(&mut transaction, collection_id, token, purpose).await?;
        self.mutate_in_transaction(transaction, collection_id, mutation, replica)
            .await
    }

    async fn mutate_in_transaction(
        &self,
        mut transaction: Transaction<'_, Postgres>,
        collection_id: Uuid,
        mutation: SyncMutation,
        replica: Replica,
    ) -> ApiResult<SyncMutationReceipt> {
        if mutation.replica_id != replica.id {
            return Err(ApiError::forbidden(
                "replica_scope_denied",
                "Mutation belongs to another replica.",
            ));
        }
        let wrapped_data_key: Vec<u8> = sqlx::query_scalar(
            "SELECT wrapped_data_key FROM hosted_provider_collections WHERE id = $1 AND state = 'active'",
        )
        .bind(collection_id)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or_else(|| {
            ApiError::not_found(
                "hosted_collection_not_found",
                "Hosted collection not found.",
            )
        })?;
        let data_key = self.collection_key(collection_id, &wrapped_data_key)?;
        if let Some(row) = sqlx::query(
            "SELECT mutation_hash, receipt_ciphertext FROM hosted_provider_mutation_receipts WHERE replica_id = $1 AND mutation_id = $2",
        )
        .bind(replica.id)
        .bind(mutation.mutation_id)
        .fetch_optional(&mut *transaction)
        .await?
        {
            let stored_hash: Vec<u8> = row.get("mutation_hash");
            let submitted_hash = mutation_hash(&mutation)?;
            if !bool::from(stored_hash.ct_eq(&submitted_hash)) {
                return Err(ApiError::conflict(
                    "mutation_id_reused",
                    "Mutation ID was already used for a different mutation.",
                ));
            }
            let receipt: SyncMutationReceipt = self.crypto.decrypt_json(
                &data_key,
                row.get("receipt_ciphertext"),
                &receipt_aad(replica.id, mutation.mutation_id),
            )?;
            transaction.commit().await?;
            return Ok(previously_applied(receipt));
        }
        if replica.mode != SyncReplicaMode::ReadWrite {
            return store_rejection(
                transaction,
                &self.crypto,
                &data_key,
                &mutation,
                "replica_read_only",
                "This replica is read-only.",
            )
            .await;
        }
        if mutation.scope_epoch != replica.scope_epoch {
            return store_rejection(
                transaction,
                &self.crypto,
                &data_key,
                &mutation,
                "scope_epoch_stale",
                "Replica scope changed; open a new sync session.",
            )
            .await;
        }
        if let Some(predecessor) = mutation.causal_predecessor {
            let predecessor_receipt: Option<Vec<u8>> = sqlx::query_scalar(
                r#"SELECT receipt_ciphertext FROM hosted_provider_mutation_receipts
                   WHERE replica_id = $1 AND mutation_id = $2"#,
            )
            .bind(replica.id)
            .bind(predecessor)
            .fetch_optional(&mut *transaction)
            .await?;
            let Some(predecessor_receipt) = predecessor_receipt else {
                return store_rejection(
                    transaction,
                    &self.crypto,
                    &data_key,
                    &mutation,
                    "causal_predecessor_missing",
                    "The mutation's causal predecessor has not been applied.",
                )
                .await;
            };
            let predecessor_receipt: SyncMutationReceipt = self.crypto.decrypt_json(
                &data_key,
                &predecessor_receipt,
                &receipt_aad(replica.id, predecessor),
            )?;
            if !matches!(
                predecessor_receipt,
                SyncMutationReceipt::Applied { .. } | SyncMutationReceipt::PreviouslyApplied { .. }
            ) {
                return store_rejection(
                    transaction,
                    &self.crypto,
                    &data_key,
                    &mutation,
                    "causal_predecessor_not_applied",
                    "The mutation's causal predecessor did not apply.",
                )
                .await;
            }
        }

        let collection = sqlx::query(
            r#"SELECT head, record_count, content_bytes, max_records,
                      max_content_bytes, max_document_bytes
               FROM hosted_provider_collections
               WHERE id = $1 AND state = 'active' FOR UPDATE"#,
        )
        .bind(collection_id)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or_else(|| {
            ApiError::not_found(
                "hosted_collection_not_found",
                "Hosted collection not found.",
            )
        })?;
        let mut head = number(collection.get::<i64, _>("head"), "collection head")?;
        let record_count = number(collection.get::<i64, _>("record_count"), "record count")?;
        let content_bytes = number(
            collection.get::<i64, _>("content_bytes"),
            "collection content bytes",
        )?;
        let max_records = number(collection.get::<i64, _>("max_records"), "record quota")?;
        let max_content_bytes = number(
            collection.get::<i64, _>("max_content_bytes"),
            "collection byte quota",
        )?;
        let max_document_bytes = number(
            collection.get::<i64, _>("max_document_bytes"),
            "document byte quota",
        )?;
        let working_set = self.working_set(collection_id).await;
        let mut cached = working_set.lock().await;
        if cached
            .as_ref()
            .is_none_or(|working_set| working_set.head != Some(head))
        {
            let resources =
                load_resource_documents(&mut transaction, &self.crypto, &data_key, collection_id)
                    .await?;
            let records =
                load_records(&mut transaction, &self.crypto, &data_key, collection_id).await?;
            let workspace = WorkingSet::materialize(
                resources,
                records.values().map(|record| StoredDocument {
                    record_id: record.record.record_id,
                    path: record.record.path.clone(),
                    document: record.document.clone(),
                }),
            )?;
            *cached = Some(CachedCollection {
                head: Some(head),
                workspace,
                records,
                query_cache: HashMap::new(),
                query_order: VecDeque::new(),
            });
        }
        let cached = cached
            .as_mut()
            .expect("hosted working set was initialized above");
        let current = cached.records.get(&mutation.record_id).cloned();

        if mutation.operation == SyncMutationOperation::Create && current.is_some() {
            return store_rejection(
                transaction,
                &self.crypto,
                &data_key,
                &mutation,
                "record_conflict",
                "The hosted record ID already exists.",
            )
            .await;
        }
        if mutation.operation != SyncMutationOperation::Create {
            let Some(current) = &current else {
                return store_rejection(
                    transaction,
                    &self.crypto,
                    &data_key,
                    &mutation,
                    "record_not_found",
                    "The hosted record does not exist.",
                )
                .await;
            };
            if !visible(&current.record, &replica.allowed_types) {
                return store_rejection(
                    transaction,
                    &self.crypto,
                    &data_key,
                    &mutation,
                    "scope_denied",
                    "The replica cannot mutate that record.",
                )
                .await;
            }
            let Some(base_revision) = mutation.base_revision.as_deref() else {
                return store_rejection(
                    transaction,
                    &self.crypto,
                    &data_key,
                    &mutation,
                    "base_revision_required",
                    "Conditional mutations require a base revision.",
                )
                .await;
            };
            if base_revision != current.record.revision {
                let receipt = SyncMutationReceipt::Conflicted {
                    mutation_id: mutation.mutation_id,
                    conflict: SyncConflict {
                        record_id: mutation.record_id,
                        mutation: mutation.clone(),
                        current: Some(current.record.clone()),
                        current_revision: Some(current.record.revision.clone()),
                    },
                };
                store_receipt(
                    &mut transaction,
                    &self.crypto,
                    &data_key,
                    replica.id,
                    &mutation,
                    &receipt,
                )
                .await?;
                transaction.commit().await?;
                return Ok(receipt);
            }
        }

        cached.head = None;
        cached.query_cache.clear();
        cached.query_order.clear();
        let execution = cached.workspace.execute(&mutation)?;
        if !execution.envelope.valid {
            let (code, message) = operation_error(&execution.envelope);
            return store_rejection(
                transaction,
                &self.crypto,
                &data_key,
                &mutation,
                &code,
                &message,
            )
            .await;
        }
        if execution.changed.is_empty() {
            return Err(ApiError::internal(
                "mdbase-rs accepted a mutation without producing a write set.",
            ));
        }
        for (record_id, after, _) in &execution.changed {
            let before = cached.records.get(record_id).map(|value| &value.record);
            if before.is_some_and(|record| !visible(record, &replica.allowed_types))
                || after
                    .as_ref()
                    .is_some_and(|record| !visible(record, &replica.allowed_types))
            {
                return store_rejection(
                    transaction,
                    &self.crypto,
                    &data_key,
                    &mutation,
                    "scope_denied",
                    "The mutation would change a record outside the replica scope.",
                )
                .await;
            }
        }
        let mut next_record_count = i128::from(record_count);
        let mut next_content_bytes = i128::from(content_bytes);
        for (record_id, after, document) in &execution.changed {
            let before = cached.records.get(record_id);
            let before_bytes = before
                .map(|record| record.document.len() as i128)
                .unwrap_or_default();
            let after_bytes = document
                .as_ref()
                .map(|value| value.len() as i128)
                .unwrap_or_default();
            if after.is_some()
                && u64::try_from(after_bytes).unwrap_or(u64::MAX) > max_document_bytes
            {
                return store_rejection(
                    transaction,
                    &self.crypto,
                    &data_key,
                    &mutation,
                    "document_quota_exceeded",
                    "The canonical Markdown document exceeds the hosted document size limit.",
                )
                .await;
            }
            next_content_bytes += after_bytes - before_bytes;
            next_record_count += match (before.is_some(), after.is_some()) {
                (false, true) => 1,
                (true, false) => -1,
                _ => 0,
            };
        }
        if next_record_count < 0
            || next_record_count > i128::from(max_records)
            || next_content_bytes < 0
            || next_content_bytes > i128::from(max_content_bytes)
        {
            return store_rejection(
                transaction,
                &self.crypto,
                &data_key,
                &mutation,
                "collection_quota_exceeded",
                "The mutation would exceed the hosted collection quota.",
            )
            .await;
        }

        let notification_runtime_active = if self.notifications.is_some() {
            sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(
                    SELECT 1 FROM hosted_provider_notification_grants
                    WHERE collection_id = $1
                 )",
            )
            .bind(collection_id)
            .fetch_one(&mut *transaction)
            .await?
        } else {
            false
        };
        let mut primary = None;
        for (record_id, after, document) in execution.changed {
            head = head.checked_add(1).ok_or_else(|| {
                ApiError::internal("The hosted collection sequence is exhausted.")
            })?;
            let before = cached
                .records
                .get(&record_id)
                .map(|value| value.record.clone());
            let notification_event = notification_runtime_active
                .then(|| application_change(before.as_ref(), after.as_ref()));
            let revision = if let Some(record) = &after {
                persist_live_record(
                    &mut transaction,
                    &self.crypto,
                    &data_key,
                    collection_id,
                    head,
                    record,
                    document.as_deref().ok_or_else(|| {
                        ApiError::internal("The hosted write set omitted its canonical document.")
                    })?,
                )
                .await?;
                if record_id == execution.primary_record_id {
                    primary = Some(record.clone());
                }
                record.revision.clone()
            } else {
                let before = before.as_ref().ok_or_else(|| {
                    ApiError::internal("The hosted write set deleted an unknown record.")
                })?;
                let revision = format!("hosted:1:{head}:tombstone");
                persist_deleted_record(&mut transaction, collection_id, head, before, &revision)
                    .await?;
                revision
            };
            let before_ciphertext = before
                .as_ref()
                .map(|record| {
                    self.crypto.encrypt_json(
                        &data_key,
                        record,
                        &change_record_aad(collection_id, head, "before"),
                    )
                })
                .transpose()?;
            let after_ciphertext = after
                .as_ref()
                .map(|record| {
                    self.crypto.encrypt_json(
                        &data_key,
                        record,
                        &change_record_aad(collection_id, head, "after"),
                    )
                })
                .transpose()?;
            sqlx::query(
                r#"INSERT INTO hosted_provider_changes
                     (collection_id, sequence, record_id, before_types, after_types,
                      before_ciphertext, after_ciphertext, revision)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8)"#,
            )
            .bind(collection_id)
            .bind(to_i64(head, "change sequence")?)
            .bind(record_id)
            .bind(
                before
                    .as_ref()
                    .map(|record| record.types.clone())
                    .unwrap_or_default(),
            )
            .bind(
                after
                    .as_ref()
                    .map(|record| record.types.clone())
                    .unwrap_or_default(),
            )
            .bind(before_ciphertext)
            .bind(after_ciphertext)
            .bind(revision)
            .execute(&mut *transaction)
            .await?;
            if let Some((event_type, payload)) = notification_event {
                sqlx::query(
                    "INSERT INTO hosted_provider_runtime_outbox
                        (collection_id, sequence, event_type, payload)
                     VALUES ($1, $2, $3, $4)
                     ON CONFLICT(collection_id, sequence) DO NOTHING",
                )
                .bind(collection_id)
                .bind(to_i64(head, "runtime event sequence")?)
                .bind(event_type)
                .bind(payload)
                .execute(&mut *transaction)
                .await?;
            }
            if let Some(record) = after {
                cached.records.insert(
                    record_id,
                    PersistedRecord {
                        record,
                        document: document.ok_or_else(|| {
                            ApiError::internal(
                                "The hosted write set omitted its canonical document.",
                            )
                        })?,
                    },
                );
            } else {
                cached.records.remove(&record_id);
            }
        }
        sqlx::query(
            r#"UPDATE hosted_provider_collections
               SET head = $2, record_count = $3, content_bytes = $4, updated_at = now()
               WHERE id = $1"#,
        )
        .bind(collection_id)
        .bind(to_i64(head, "collection head")?)
        .bind(i64::try_from(next_record_count).map_err(|_| {
            ApiError::internal("The hosted record count is outside the supported range.")
        })?)
        .bind(i64::try_from(next_content_bytes).map_err(|_| {
            ApiError::internal("The hosted content size is outside the supported range.")
        })?)
        .execute(&mut *transaction)
        .await?;
        let receipt = SyncMutationReceipt::Applied {
            mutation_id: mutation.mutation_id,
            sequence: head,
            record: primary,
        };
        store_receipt(
            &mut transaction,
            &self.crypto,
            &data_key,
            replica.id,
            &mutation,
            &receipt,
        )
        .await?;
        transaction.commit().await?;
        cached.head = Some(head);
        if notification_runtime_active {
            let provider = self.clone();
            tokio::spawn(async move {
                if let Err(error) = provider.recover_notifications(100).await {
                    tracing::warn!(%error, "hosted notification recovery deferred");
                }
            });
        }
        Ok(receipt)
    }

    pub async fn operation(
        &self,
        collection_id: Uuid,
        token: &str,
        operation: &str,
        input: Value,
        request_origin: Option<&str>,
    ) -> ApiResult<Value> {
        let replica = self
            .authenticate_for(collection_id, token, ReplicaPurpose::Application)
            .await?;
        authorize_application_operation(&replica, operation, request_origin)?;
        if matches!(
            operation,
            "list_timers" | "put_timer" | "cancel_timer" | "reconcile_timers"
        ) {
            let grant_id = replica.grant_id.ok_or_else(|| {
                ApiError::forbidden(
                    "timer_grant_unavailable",
                    "This application capability is not bound to a timer grant.",
                )
            })?;
            let notifications = self.notifications.as_ref().ok_or_else(|| {
                ApiError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "notifications_unavailable",
                    "Hosted timer execution is not configured.",
                )
            })?;
            return notifications
                .timer_operation(collection_id, grant_id, operation, input)
                .await;
        }
        if is_full_collection_operation(operation) && !replica.full_collection {
            return Err(ApiError::forbidden(
                "scope_denied",
                "This operation requires full collection access.",
            ));
        }
        match operation {
            "describe" => self.describe_operation(collection_id, &replica).await,
            "changes" => {
                self.changes_operation(collection_id, &replica, &input)
                    .await
            }
            "read" | "query" | "validate" | "read_type" | "list_views" | "execute_view"
            | "read_view_source" => {
                let scoped_input = scope_read_input(operation, input, &replica.allowed_types)?;
                let result = self
                    .execute_read_operation(collection_id, operation, &scoped_input)
                    .await?;
                if matches!(operation, "read" | "validate") {
                    ensure_operation_result_visible(&result, &replica.allowed_types)?;
                }
                serde_json::to_value(result).map_err(|error| {
                    ApiError::internal(format!("Hosted operation could not serialize: {error}"))
                })
            }
            "create" | "update" | "delete" | "rename" => {
                self.write_operation(collection_id, token, &replica, operation, input)
                    .await
            }
            "create_type" | "update_type" => {
                self.write_type_operation(collection_id, operation, input)
                    .await
            }
            "create_view_source" | "update_view_source" | "delete_view_source" => {
                self.write_view_source_operation(collection_id, operation, input)
                    .await
            }
            _ => Err(ApiError::bad_request(
                "unsupported_operation",
                "The hosted provider does not support that collection operation.",
            )),
        }
    }

    pub async fn provision_types(
        &self,
        collection_id: Uuid,
        provisions: Vec<TypeProvision>,
    ) -> ApiResult<Vec<CollectionContractDescriptor>> {
        let mut resources = self.collection_resources(collection_id).await?;
        for provision in provisions {
            let type_exists = resources
                .types
                .iter()
                .any(|existing| existing.name.eq_ignore_ascii_case(&provision.name));
            if !type_exists {
                let mut input = json!({ "document": provision.document });
                if let Some(path) = provision.path {
                    input["path"] = json!(path);
                }
                let result = self
                    .write_type_operation(collection_id, "create_type", input)
                    .await?;
                if result.get("valid").and_then(Value::as_bool) != Some(true) {
                    let detail = result
                        .pointer("/diagnostics/0/message")
                        .and_then(Value::as_str)
                        .unwrap_or("the type definition was rejected");
                    return Err(ApiError::bad_request(
                        "type_provision_failed",
                        format!(
                            "The {} type could not be installed: {detail}",
                            provision.name
                        ),
                    ));
                }
                if result
                    .pointer("/result/name")
                    .and_then(Value::as_str)
                    .is_none_or(|name| !name.eq_ignore_ascii_case(&provision.name))
                {
                    return Err(ApiError::bad_request(
                        "type_provision_failed",
                        format!(
                            "The installed type did not match the declared {} type.",
                            provision.name
                        ),
                    ));
                }
                resources = self.collection_resources(collection_id).await?;
            }
            if provision.provides.iter().any(|provided| {
                !resources.contracts.iter().any(|available| {
                    available.id == provided.id && available.version == provided.version
                })
            }) {
                return Err(ApiError::bad_request(
                    "type_provision_failed",
                    format!(
                        "The {} type did not provide every contract declared by the application.",
                        provision.name
                    ),
                ));
            }
        }
        Ok(resources.contracts)
    }

    async fn collection_resources(
        &self,
        collection_id: Uuid,
    ) -> ApiResult<SyncCollectionResources> {
        let row = sqlx::query(
            r#"SELECT wrapped_data_key, resources_ciphertext
               FROM hosted_provider_collections WHERE id = $1 AND state = 'active'"#,
        )
        .bind(collection_id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| {
            ApiError::not_found(
                "hosted_collection_not_found",
                "Hosted collection not found.",
            )
        })?;
        let data_key = self.collection_key(collection_id, row.get("wrapped_data_key"))?;
        self.crypto.decrypt_json(
            &data_key,
            row.get("resources_ciphertext"),
            &resources_aad(collection_id),
        )
    }

    async fn describe_operation(&self, collection_id: Uuid, replica: &Replica) -> ApiResult<Value> {
        let row = sqlx::query(
            r#"SELECT head, display_name, wrapped_data_key, resources_ciphertext
               FROM hosted_provider_collections WHERE id = $1 AND state = 'active'"#,
        )
        .bind(collection_id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| {
            ApiError::not_found(
                "hosted_collection_not_found",
                "Hosted collection not found.",
            )
        })?;
        let data_key = self.collection_key(collection_id, row.get("wrapped_data_key"))?;
        let resources: SyncCollectionResources = self.crypto.decrypt_json(
            &data_key,
            row.get("resources_ciphertext"),
            &resources_aad(collection_id),
        )?;
        let resources = scoped_resources(resources, &replica.allowed_types);
        let description = CollectionDescription {
            protocol_version: CONTROL_PROTOCOL_VERSION,
            collection_id,
            display_name: row.get("display_name"),
            spec_version: resources.spec_version,
            operations: replica.allowed_operations.clone(),
            change_cursor: number(row.get::<i64, _>("head"), "collection head")?,
            types: resources.types,
            contracts: resources.contracts,
            configuration: None,
        };
        serde_json::to_value(description).map_err(|error| {
            ApiError::internal(format!("Hosted description could not serialize: {error}"))
        })
    }

    async fn changes_operation(
        &self,
        collection_id: Uuid,
        replica: &Replica,
        input: &Value,
    ) -> ApiResult<Value> {
        let collection = sqlx::query(
            r#"SELECT head, retained_after, wrapped_data_key
               FROM hosted_provider_collections WHERE id = $1 AND state = 'active'"#,
        )
        .bind(collection_id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| {
            ApiError::not_found(
                "hosted_collection_not_found",
                "Hosted collection not found.",
            )
        })?;
        let head = number(collection.get::<i64, _>("head"), "collection head")?;
        let retained_after = number(
            collection.get::<i64, _>("retained_after"),
            "retained cursor",
        )?;
        let Some(after) = input.get("after").and_then(Value::as_u64) else {
            return serde_json::to_value(CollectionChangesPage {
                events: Vec::new(),
                cursor: head,
                has_more: false,
                reset: false,
            })
            .map_err(|error| {
                ApiError::internal(format!("Hosted changes could not serialize: {error}"))
            });
        };
        if after > head {
            return Err(ApiError::bad_request(
                "invalid_cursor",
                "Change cursor is ahead of the hosted collection.",
            ));
        }
        if after < retained_after {
            return serde_json::to_value(CollectionChangesPage {
                events: Vec::new(),
                cursor: head,
                has_more: false,
                reset: true,
            })
            .map_err(|error| {
                ApiError::internal(format!("Hosted changes could not serialize: {error}"))
            });
        }
        let limit = input
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(100)
            .clamp(1, 500);
        let record_rows = sqlx::query(
            r#"SELECT sequence, before_ciphertext, after_ciphertext, created_at::text AS occurred_at
               FROM hosted_provider_changes
               WHERE collection_id = $1 AND sequence > $2
                 AND (cardinality($3::text[]) = 0
                      OR before_types && $3::text[] OR after_types && $3::text[])
               ORDER BY sequence LIMIT $4"#,
        )
        .bind(collection_id)
        .bind(to_i64(after, "change cursor")?)
        .bind(&replica.allowed_types)
        .bind(to_i64(limit + 1, "change page limit")?)
        .fetch_all(&self.pool)
        .await?;
        let resource_rows = sqlx::query(
            r#"SELECT sequence, resource_kind, type_name, path, revision, created_at::text AS occurred_at
               FROM hosted_provider_resource_changes
               WHERE collection_id = $1 AND sequence > $2
                 AND (cardinality($3::text[]) = 0 OR type_name = ANY($3::text[]))
               ORDER BY sequence LIMIT $4"#,
        )
        .bind(collection_id)
        .bind(to_i64(after, "change cursor")?)
        .bind(&replica.allowed_types)
        .bind(to_i64(limit + 1, "change page limit")?)
        .fetch_all(&self.pool)
        .await?;
        let mut has_more =
            record_rows.len() > limit as usize || resource_rows.len() > limit as usize;
        let data_key = self.collection_key(collection_id, collection.get("wrapped_data_key"))?;
        let mut events = Vec::new();
        for row in record_rows {
            let sequence = number(row.get::<i64, _>("sequence"), "change sequence")?;
            let before = optional_encrypted_record(
                &self.crypto,
                &data_key,
                row.get("before_ciphertext"),
                &change_record_aad(collection_id, sequence, "before"),
            )?;
            let after_record = optional_encrypted_record(
                &self.crypto,
                &data_key,
                row.get("after_ciphertext"),
                &change_record_aad(collection_id, sequence, "after"),
            )?;
            if !before
                .as_ref()
                .is_some_and(|record| visible(record, &replica.allowed_types))
                && !after_record
                    .as_ref()
                    .is_some_and(|record| visible(record, &replica.allowed_types))
            {
                continue;
            }
            let (event_type, payload) = application_change(before.as_ref(), after_record.as_ref());
            events.push(CollectionChange {
                cursor: sequence,
                event_type: event_type.to_string(),
                occurred_at: row.get("occurred_at"),
                payload,
            });
        }
        for row in resource_rows {
            let kind: String = row.get("resource_kind");
            events.push(CollectionChange {
                cursor: number(row.get::<i64, _>("sequence"), "resource change sequence")?,
                event_type: if kind == "view" {
                    "mdbase.view_source.changed".to_string()
                } else {
                    "mdbase.type.changed".to_string()
                },
                occurred_at: row.get("occurred_at"),
                payload: json!({
                    "name": row.get::<Option<String>, _>("type_name"),
                    "path": row.get::<String, _>("path"),
                    "revision": row.get::<String, _>("revision"),
                }),
            });
        }
        events.sort_by_key(|event| event.cursor);
        if events.len() > limit as usize {
            events.truncate(limit as usize);
            has_more = true;
        }
        let cursor = events.last().map(|event| event.cursor).unwrap_or_else(|| {
            if has_more {
                after
            } else {
                head
            }
        });
        serde_json::to_value(CollectionChangesPage {
            events,
            cursor,
            has_more,
            reset: false,
        })
        .map_err(|error| ApiError::internal(format!("Hosted changes could not serialize: {error}")))
    }

    async fn execute_read_operation(
        &self,
        collection_id: Uuid,
        operation: &str,
        input: &Value,
    ) -> ApiResult<OperationResult> {
        let mut transaction = self.pool.begin().await?;
        let collection = sqlx::query(
            r#"SELECT head, wrapped_data_key FROM hosted_provider_collections
               WHERE id = $1 AND state = 'active'"#,
        )
        .bind(collection_id)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or_else(|| {
            ApiError::not_found(
                "hosted_collection_not_found",
                "Hosted collection not found.",
            )
        })?;
        let head = number(collection.get::<i64, _>("head"), "collection head")?;
        let data_key = self.collection_key(collection_id, collection.get("wrapped_data_key"))?;
        let working_set = self.working_set(collection_id).await;
        let mut cached = working_set.lock().await;
        if cached
            .as_ref()
            .is_none_or(|working_set| working_set.head != Some(head))
        {
            let resources =
                load_resource_documents(&mut transaction, &self.crypto, &data_key, collection_id)
                    .await?;
            let records =
                load_records(&mut transaction, &self.crypto, &data_key, collection_id).await?;
            let workspace = WorkingSet::materialize(
                resources,
                records.values().map(|record| StoredDocument {
                    record_id: record.record.record_id,
                    path: record.record.path.clone(),
                    document: record.document.clone(),
                }),
            )?;
            *cached = Some(CachedCollection {
                head: Some(head),
                workspace,
                records,
                query_cache: HashMap::new(),
                query_order: VecDeque::new(),
            });
        }
        let cached = cached
            .as_mut()
            .expect("hosted working set was initialized above");
        let result = if operation == "query" {
            let cache_key: [u8; 32] =
                Sha256::digest(serde_json::to_vec(input).map_err(|error| {
                    ApiError::internal(format!("Hosted query input could not serialize: {error}"))
                })?)
                .into();
            if let Some(result) = cached.query_cache.get(&cache_key) {
                result.clone()
            } else {
                let result = cached.workspace.read_operation(operation, input)?;
                if cached.query_order.len() >= 128 {
                    if let Some(expired) = cached.query_order.pop_front() {
                        cached.query_cache.remove(&expired);
                    }
                }
                cached.query_order.push_back(cache_key);
                cached.query_cache.insert(cache_key, result.clone());
                result
            }
        } else {
            cached.workspace.read_operation(operation, input)?
        };
        transaction.commit().await?;
        Ok(result)
    }

    async fn write_operation(
        &self,
        collection_id: Uuid,
        token: &str,
        replica: &Replica,
        operation: &str,
        input: Value,
    ) -> ApiResult<Value> {
        let mut operation_input = input.as_object().cloned().ok_or_else(|| {
            ApiError::bad_request(
                "invalid_operation_input",
                "Hosted operation input must be an object.",
            )
        })?;
        let (mutation_operation, record_id, base_revision, previous_path) = match operation {
            "create" => (SyncMutationOperation::Create, Uuid::new_v4(), None, None),
            "update" | "delete" | "rename" => {
                let path_key = if operation == "rename" {
                    "from"
                } else {
                    "path"
                };
                let path = operation_input
                    .get(path_key)
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        ApiError::bad_request(
                            "invalid_operation_input",
                            format!("Hosted {operation} requires {path_key}."),
                        )
                    })?
                    .to_string();
                let wrapped_data_key: Vec<u8> = sqlx::query_scalar(
                    "SELECT wrapped_data_key FROM hosted_provider_collections WHERE id = $1 AND state = 'active'",
                )
                .bind(collection_id)
                .fetch_optional(&self.pool)
                .await?
                .ok_or_else(|| {
                    ApiError::not_found(
                        "hosted_collection_not_found",
                        "Hosted collection not found.",
                    )
                })?;
                let data_key = self.collection_key(collection_id, &wrapped_data_key)?;
                let current = sqlx::query(
                    r#"SELECT record_id, revision, types FROM hosted_provider_records
                       WHERE collection_id = $1 AND path_token = $2"#,
                )
                .bind(collection_id)
                .bind(path_token(&data_key, &path))
                .fetch_optional(&self.pool)
                .await?
                .ok_or_else(|| {
                    ApiError::not_found("record_not_found", "The hosted record does not exist.")
                })?;
                let types: Vec<String> = current.get("types");
                if !replica.allowed_types.is_empty()
                    && !types
                        .iter()
                        .any(|record_type| replica.allowed_types.contains(record_type))
                {
                    return Err(ApiError::forbidden(
                        "scope_denied",
                        "The requested record is outside this application's record scope.",
                    ));
                }
                if !replica.allowed_types.is_empty() {
                    if operation == "delete" {
                        operation_input.insert("check_backlinks".to_string(), Value::Bool(false));
                    } else if operation == "rename"
                        && operation_input.get("update_refs").and_then(Value::as_bool) == Some(true)
                    {
                        return Err(ApiError::forbidden(
                            "scope_denied",
                            "Reference updates can affect records outside this application's scope.",
                        ));
                    }
                }
                let current_revision: String = current.get("revision");
                let requested_revision = operation_input
                    .get("if_revision")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or(current_revision);
                if operation == "rename" {
                    let target = operation_input
                        .get("to")
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            ApiError::bad_request(
                                "invalid_operation_input",
                                "Hosted rename requires to.",
                            )
                        })?
                        .to_string();
                    operation_input.insert("path".to_string(), Value::String(target));
                }
                (
                    match operation {
                        "update" => SyncMutationOperation::Update,
                        "delete" => SyncMutationOperation::Delete,
                        "rename" => SyncMutationOperation::Rename,
                        _ => unreachable!(),
                    },
                    current.get("record_id"),
                    Some(requested_revision),
                    Some(path),
                )
            }
            _ => unreachable!(),
        };
        if operation_input.get("dry_run").and_then(Value::as_bool) == Some(true) {
            let result = self
                .execute_read_operation(collection_id, operation, &Value::Object(operation_input))
                .await?;
            return serde_json::to_value(result).map_err(|error| {
                ApiError::internal(format!(
                    "Hosted operation preflight could not serialize: {error}"
                ))
            });
        }
        let include_document = operation_input
            .get("include_document")
            .and_then(Value::as_bool)
            == Some(true)
            || operation_input.contains_key("document");
        let mutation = SyncMutation {
            mutation_id: Uuid::new_v4(),
            replica_id: replica.id,
            scope_epoch: replica.scope_epoch,
            operation: mutation_operation,
            record_id,
            base_revision,
            input: operation_input,
            created_at: Utc::now().to_rfc3339(),
            causal_predecessor: None,
        };
        let receipt = self
            .mutate_for(collection_id, token, mutation, ReplicaPurpose::Application)
            .await?;
        let result = match receipt {
            SyncMutationReceipt::Applied { record, .. }
            | SyncMutationReceipt::PreviouslyApplied { record, .. } => {
                if operation == "delete" {
                    OperationResult {
                        valid: true,
                        result: json!({
                            "path": previous_path,
                            "deleted": true,
                        }),
                        diagnostics: Vec::new(),
                    }
                } else {
                    let record = record.ok_or_else(|| {
                        ApiError::internal(
                            "The hosted operation did not return its resulting record.",
                        )
                    })?;
                    let mut document = self
                        .execute_read_operation(
                            collection_id,
                            "read",
                            &json!({
                                "path": record.path.clone(),
                                "include_document": include_document,
                            }),
                        )
                        .await?;
                    if !document.valid {
                        return Err(ApiError::internal(
                            "The hosted mutation succeeded but its record document could not be read.",
                        ));
                    }
                    if operation == "rename" {
                        let value = document.result.as_object_mut().ok_or_else(|| {
                            ApiError::internal("mdbase-rs returned a non-object record document.")
                        })?;
                        value.insert(
                            "from".to_string(),
                            Value::String(previous_path.unwrap_or_default()),
                        );
                        value.insert("to".to_string(), Value::String(record.path));
                        value.insert("references_updated".to_string(), Value::Array(Vec::new()));
                    }
                    document
                }
            }
            SyncMutationReceipt::Rejected { error, .. } => {
                invalid_operation_result(&error.code, &error.message, previous_path, None)
            }
            SyncMutationReceipt::Conflicted { conflict, .. } => invalid_operation_result(
                "concurrent_modification",
                "The hosted record changed after it was read.",
                previous_path,
                Some(json!({ "current_revision": conflict.current_revision })),
            ),
        };
        serde_json::to_value(result).map_err(|error| {
            ApiError::internal(format!("Hosted operation could not serialize: {error}"))
        })
    }

    async fn write_type_operation(
        &self,
        collection_id: Uuid,
        operation: &str,
        input: Value,
    ) -> ApiResult<Value> {
        let mut transaction = self.pool.begin().await?;
        let collection = sqlx::query(
            r#"SELECT head, wrapped_data_key, resources_ciphertext, max_document_bytes
               FROM hosted_provider_collections
               WHERE id = $1 AND state = 'active' FOR UPDATE"#,
        )
        .bind(collection_id)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or_else(|| {
            ApiError::not_found(
                "hosted_collection_not_found",
                "Hosted collection not found.",
            )
        })?;
        let mut head = number(collection.get::<i64, _>("head"), "collection head")?;
        let max_document_bytes = number(
            collection.get::<i64, _>("max_document_bytes"),
            "maximum document size",
        )?;
        if input
            .get("document")
            .and_then(Value::as_str)
            .is_some_and(|document| document.len() as u64 > max_document_bytes)
        {
            return Err(ApiError::bad_request(
                "document_quota_exceeded",
                "The type definition exceeds the hosted document size limit.",
            ));
        }
        let data_key = self.collection_key(collection_id, collection.get("wrapped_data_key"))?;
        let working_set = self.working_set(collection_id).await;
        let mut cached = working_set.lock().await;
        if cached
            .as_ref()
            .is_none_or(|working_set| working_set.head != Some(head))
        {
            let resources =
                load_resource_documents(&mut transaction, &self.crypto, &data_key, collection_id)
                    .await?;
            let records =
                load_records(&mut transaction, &self.crypto, &data_key, collection_id).await?;
            let workspace = WorkingSet::materialize(
                resources,
                records.values().map(|record| StoredDocument {
                    record_id: record.record.record_id,
                    path: record.record.path.clone(),
                    document: record.document.clone(),
                }),
            )?;
            *cached = Some(CachedCollection {
                head: Some(head),
                workspace,
                records,
                query_cache: HashMap::new(),
                query_order: VecDeque::new(),
            });
        }
        let cached = cached
            .as_mut()
            .expect("hosted working set was initialized above");
        let envelope = cached.workspace.type_operation(operation, &input)?;
        if !envelope.valid {
            transaction.commit().await?;
            return serde_json::to_value(envelope).map_err(|error| {
                ApiError::internal(format!("Hosted operation could not serialize: {error}"))
            });
        }
        // The workspace has already changed. Keep the cache invalid until the
        // matching database transaction commits so a failed persistence step
        // cannot leave a stale in-memory collection serving future requests.
        cached.head = None;
        let path = result_string(&envelope.result, "path")?.to_string();
        let type_name = result_string(&envelope.result, "name")?.to_string();
        let revision = result_string(&envelope.result, "revision")?.to_string();
        let document = cached.workspace.resource_document(&path)?;
        let (types, contracts) = cached.workspace.type_resources()?;
        let record_inputs = cached
            .records
            .iter()
            .map(|(id, persisted)| {
                (
                    *id,
                    persisted.record.path.clone(),
                    persisted.record.frontmatter.clone(),
                )
            })
            .collect::<Vec<_>>();
        let classifications = cached.workspace.classify_records(&record_inputs)?;

        head = head
            .checked_add(1)
            .ok_or_else(|| ApiError::internal("The hosted collection sequence is exhausted."))?;
        let resource_revision = format!("hosted:1:{head}:resources");
        let mut resources: SyncCollectionResources = self.crypto.decrypt_json(
            &data_key,
            collection.get("resources_ciphertext"),
            &resources_aad(collection_id),
        )?;
        resources.revision = resource_revision.clone();
        resources.types = types;
        resources.contracts = contracts;
        let resources_ciphertext =
            self.crypto
                .encrypt_json(&data_key, &resources, &resources_aad(collection_id))?;
        let document_ciphertext = self.crypto.encrypt_bytes(
            &data_key,
            document.as_bytes(),
            &resource_document_aad(collection_id, &path),
        )?;
        sqlx::query(
            r#"INSERT INTO hosted_provider_resources
                 (collection_id, path, kind, revision, document_ciphertext)
               VALUES ($1, $2, 'type', $3, $4)
               ON CONFLICT (collection_id, path) DO UPDATE SET
                 revision = EXCLUDED.revision,
                 document_ciphertext = EXCLUDED.document_ciphertext,
                 updated_at = now()"#,
        )
        .bind(collection_id)
        .bind(&path)
        .bind(&revision)
        .bind(document_ciphertext)
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            r#"INSERT INTO hosted_provider_resource_changes
                 (collection_id, sequence, type_name, path, revision)
               VALUES ($1, $2, $3, $4, $5)"#,
        )
        .bind(collection_id)
        .bind(to_i64(head, "resource change sequence")?)
        .bind(&type_name)
        .bind(&path)
        .bind(&revision)
        .execute(&mut *transaction)
        .await?;

        for (record_id, next_types) in classifications {
            let Some(persisted) = cached.records.get_mut(&record_id) else {
                continue;
            };
            if persisted.record.types == next_types {
                continue;
            }
            persisted.record.types = next_types;
            let sequence: i64 = sqlx::query_scalar(
                "SELECT sequence FROM hosted_provider_records WHERE collection_id = $1 AND record_id = $2",
            )
            .bind(collection_id)
            .bind(record_id)
            .fetch_one(&mut *transaction)
            .await?;
            let sequence_u64 = number(sequence, "record sequence")?;
            let current_ciphertext = self.crypto.encrypt_json(
                &data_key,
                persisted,
                &current_record_aad(collection_id, record_id, sequence_u64),
            )?;
            let version_ciphertext = self.crypto.encrypt_json(
                &data_key,
                persisted,
                &record_version_aad(collection_id, record_id, sequence_u64),
            )?;
            sqlx::query(
                r#"UPDATE hosted_provider_records
                   SET types = $3, payload_ciphertext = $4, updated_at = now()
                   WHERE collection_id = $1 AND record_id = $2"#,
            )
            .bind(collection_id)
            .bind(record_id)
            .bind(&persisted.record.types)
            .bind(current_ciphertext)
            .execute(&mut *transaction)
            .await?;
            sqlx::query(
                r#"UPDATE hosted_provider_record_versions
                   SET types = $4, payload_ciphertext = $5
                   WHERE collection_id = $1 AND record_id = $2 AND sequence = $3"#,
            )
            .bind(collection_id)
            .bind(record_id)
            .bind(sequence)
            .bind(&persisted.record.types)
            .bind(version_ciphertext)
            .execute(&mut *transaction)
            .await?;
        }

        sqlx::query(
            r#"UPDATE hosted_provider_collections
               SET head = $2, resource_revision = $3, resources_ciphertext = $4, updated_at = now()
               WHERE id = $1"#,
        )
        .bind(collection_id)
        .bind(to_i64(head, "collection head")?)
        .bind(resource_revision)
        .bind(resources_ciphertext)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        cached.head = Some(head);
        cached.query_cache.clear();
        cached.query_order.clear();
        serde_json::to_value(envelope).map_err(|error| {
            ApiError::internal(format!("Hosted operation could not serialize: {error}"))
        })
    }

    async fn write_view_source_operation(
        &self,
        collection_id: Uuid,
        operation: &str,
        input: Value,
    ) -> ApiResult<Value> {
        let mut transaction = self.pool.begin().await?;
        let collection = sqlx::query(
            r#"SELECT head, wrapped_data_key, resources_ciphertext, max_document_bytes
               FROM hosted_provider_collections
               WHERE id = $1 AND state = 'active' FOR UPDATE"#,
        )
        .bind(collection_id)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or_else(|| {
            ApiError::not_found(
                "hosted_collection_not_found",
                "Hosted collection not found.",
            )
        })?;
        let mut head = number(collection.get::<i64, _>("head"), "collection head")?;
        let max_document_bytes = number(
            collection.get::<i64, _>("max_document_bytes"),
            "maximum document size",
        )?;
        if input
            .get("document")
            .and_then(Value::as_str)
            .is_some_and(|document| document.len() as u64 > max_document_bytes)
        {
            return Err(ApiError::bad_request(
                "document_quota_exceeded",
                "The saved-view source exceeds the hosted document size limit.",
            ));
        }
        let data_key = self.collection_key(collection_id, collection.get("wrapped_data_key"))?;
        let working_set = self.working_set(collection_id).await;
        let mut cached = working_set.lock().await;
        if cached
            .as_ref()
            .is_none_or(|working_set| working_set.head != Some(head))
        {
            let resources =
                load_resource_documents(&mut transaction, &self.crypto, &data_key, collection_id)
                    .await?;
            let records =
                load_records(&mut transaction, &self.crypto, &data_key, collection_id).await?;
            let workspace = WorkingSet::materialize(
                resources,
                records.values().map(|record| StoredDocument {
                    record_id: record.record.record_id,
                    path: record.record.path.clone(),
                    document: record.document.clone(),
                }),
            )?;
            *cached = Some(CachedCollection {
                head: Some(head),
                workspace,
                records,
                query_cache: HashMap::new(),
                query_order: VecDeque::new(),
            });
        }
        let cached = cached
            .as_mut()
            .expect("hosted working set was initialized above");
        let envelope = cached.workspace.view_source_operation(operation, &input)?;
        if !envelope.valid {
            transaction.commit().await?;
            return serde_json::to_value(envelope).map_err(|error| {
                ApiError::internal(format!("Hosted operation could not serialize: {error}"))
            });
        }
        cached.head = None;
        let path = result_string(&envelope.result, "path")?.to_string();
        head = head
            .checked_add(1)
            .ok_or_else(|| ApiError::internal("The hosted collection sequence is exhausted."))?;
        let event_revision = if operation == "delete_view_source" {
            sqlx::query(
                "DELETE FROM hosted_provider_resources WHERE collection_id = $1 AND path = $2 AND kind = 'view'",
            )
            .bind(collection_id)
            .bind(&path)
            .execute(&mut *transaction)
            .await?;
            format!("hosted:1:{head}:view-deleted")
        } else {
            let revision = result_string(&envelope.result, "revision")?.to_string();
            let document = cached.workspace.resource_document(&path)?;
            let document_ciphertext = self.crypto.encrypt_bytes(
                &data_key,
                document.as_bytes(),
                &resource_document_aad(collection_id, &path),
            )?;
            sqlx::query(
                r#"INSERT INTO hosted_provider_resources
                     (collection_id, path, kind, revision, document_ciphertext)
                   VALUES ($1, $2, 'view', $3, $4)
                   ON CONFLICT (collection_id, path) DO UPDATE SET
                     kind = 'view', revision = EXCLUDED.revision,
                     document_ciphertext = EXCLUDED.document_ciphertext,
                     updated_at = now()"#,
            )
            .bind(collection_id)
            .bind(&path)
            .bind(&revision)
            .bind(document_ciphertext)
            .execute(&mut *transaction)
            .await?;
            revision
        };

        let resource_revision = format!("hosted:1:{head}:resources");
        let mut resources: SyncCollectionResources = self.crypto.decrypt_json(
            &data_key,
            collection.get("resources_ciphertext"),
            &resources_aad(collection_id),
        )?;
        resources.revision = resource_revision.clone();
        let resources_ciphertext =
            self.crypto
                .encrypt_json(&data_key, &resources, &resources_aad(collection_id))?;
        sqlx::query(
            r#"INSERT INTO hosted_provider_resource_changes
                 (collection_id, sequence, resource_kind, type_name, path, revision)
               VALUES ($1, $2, 'view', NULL, $3, $4)"#,
        )
        .bind(collection_id)
        .bind(to_i64(head, "resource change sequence")?)
        .bind(&path)
        .bind(event_revision)
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            r#"UPDATE hosted_provider_collections
               SET head = $2, resource_revision = $3, resources_ciphertext = $4, updated_at = now()
               WHERE id = $1"#,
        )
        .bind(collection_id)
        .bind(to_i64(head, "collection head")?)
        .bind(resource_revision)
        .bind(resources_ciphertext)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        cached.head = Some(head);
        cached.query_cache.clear();
        cached.query_order.clear();
        serde_json::to_value(envelope).map_err(|error| {
            ApiError::internal(format!("Hosted operation could not serialize: {error}"))
        })
    }

    async fn authenticate_for(
        &self,
        collection_id: Uuid,
        token: &str,
        purpose: ReplicaPurpose,
    ) -> ApiResult<Replica> {
        let row = sqlx::query(
            r#"SELECT id, purpose, mode, allowed_types, full_collection, allowed_operations,
                      allowed_origin, proof_public_key, grant_id, scope_epoch
               FROM hosted_provider_replicas
               WHERE collection_id = $1 AND token_hash = $2 AND purpose = $3
                 AND revoked_at IS NULL AND token_expires_at > now()"#,
        )
        .bind(collection_id)
        .bind(token_hash(token))
        .bind(replica_purpose(purpose))
        .fetch_optional(&self.pool)
        .await?;
        replica_from_row(row)
    }

    async fn authenticate_for_sync(
        &self,
        collection_id: Uuid,
        token: &str,
        required_operation: &str,
        request_origin: Option<&str>,
    ) -> ApiResult<Replica> {
        let row = sqlx::query(
            r#"SELECT id, purpose, mode, allowed_types, full_collection, allowed_operations,
                      allowed_origin, proof_public_key, grant_id, scope_epoch
               FROM hosted_provider_replicas
               WHERE collection_id = $1 AND token_hash = $2
                 AND revoked_at IS NULL AND token_expires_at > now()"#,
        )
        .bind(collection_id)
        .bind(token_hash(token))
        .fetch_optional(&self.pool)
        .await?;
        let replica = replica_from_row(row)?;
        authorize_sync_access(&replica, required_operation, request_origin)?;
        Ok(replica)
    }

    fn collection_key(&self, collection_id: Uuid, wrapped: &[u8]) -> ApiResult<[u8; 32]> {
        self.crypto
            .unwrap_data_key(wrapped, &collection_key_aad(collection_id))
    }

    async fn working_set(&self, collection_id: Uuid) -> WorkingSetSlot {
        let mut working_sets = self.working_sets.lock().await;
        working_sets
            .entry(collection_id)
            .or_insert_with(|| Arc::new(Mutex::new(None)))
            .clone()
    }
}

enum DatabaseKeyError {
    Database(sqlx::Error),
    Invalid(ApiError),
}

async fn verify_database_key(
    pool: &PgPool,
    crypto: &ProviderCrypto,
) -> Result<(), DatabaseKeyError> {
    let candidate = crypto
        .create_key_check()
        .map_err(DatabaseKeyError::Invalid)?;
    sqlx::query(
        r#"INSERT INTO hosted_provider_metadata (singleton, key_check)
           VALUES (true, $1) ON CONFLICT (singleton) DO NOTHING"#,
    )
    .bind(candidate)
    .execute(pool)
    .await
    .map_err(DatabaseKeyError::Database)?;
    let key_check: Vec<u8> =
        sqlx::query_scalar("SELECT key_check FROM hosted_provider_metadata WHERE singleton = true")
            .fetch_one(pool)
            .await
            .map_err(DatabaseKeyError::Database)?;
    crypto
        .verify_key_check(&key_check)
        .map_err(DatabaseKeyError::Invalid)
}

async fn authenticate_in(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
    token: &str,
    purpose: ReplicaPurpose,
) -> ApiResult<Replica> {
    let row = sqlx::query(
        r#"SELECT id, purpose, mode, allowed_types, full_collection, allowed_operations,
                  allowed_origin, proof_public_key, grant_id, scope_epoch
           FROM hosted_provider_replicas
           WHERE collection_id = $1 AND token_hash = $2 AND purpose = $3
             AND revoked_at IS NULL AND token_expires_at > now()
           FOR SHARE"#,
    )
    .bind(collection_id)
    .bind(token_hash(token))
    .bind(replica_purpose(purpose))
    .fetch_optional(&mut **transaction)
    .await?;
    replica_from_row(row)
}

async fn authenticate_in_for_sync(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
    token: &str,
    required_operation: &str,
    request_origin: Option<&str>,
) -> ApiResult<Replica> {
    let row = sqlx::query(
        r#"SELECT id, purpose, mode, allowed_types, full_collection, allowed_operations,
                  allowed_origin, proof_public_key, grant_id, scope_epoch
           FROM hosted_provider_replicas
           WHERE collection_id = $1 AND token_hash = $2
             AND revoked_at IS NULL AND token_expires_at > now()
           FOR SHARE"#,
    )
    .bind(collection_id)
    .bind(token_hash(token))
    .fetch_optional(&mut **transaction)
    .await?;
    let replica = replica_from_row(row)?;
    authorize_sync_access(&replica, required_operation, request_origin)?;
    Ok(replica)
}

fn replica_from_row(row: Option<sqlx::postgres::PgRow>) -> ApiResult<Replica> {
    let row = row.ok_or_else(|| {
        ApiError::unauthorized(
            "invalid_replica_token",
            "Replica credential is invalid, expired, or revoked.",
        )
    })?;
    let mode: String = row.get("mode");
    let purpose: String = row.get("purpose");
    if !matches!(purpose.as_str(), "mirror" | "application") {
        return Err(ApiError::internal("Stored replica purpose is invalid."));
    }
    Ok(Replica {
        id: row.get("id"),
        purpose: match purpose.as_str() {
            "mirror" => ReplicaPurpose::Mirror,
            "application" => ReplicaPurpose::Application,
            _ => return Err(ApiError::internal("Stored replica purpose is invalid.")),
        },
        mode: match mode.as_str() {
            "read_only" => SyncReplicaMode::ReadOnly,
            "read_write" => SyncReplicaMode::ReadWrite,
            _ => return Err(ApiError::internal("Stored replica mode is invalid.")),
        },
        allowed_types: row.get("allowed_types"),
        full_collection: row.get("full_collection"),
        allowed_operations: row.get("allowed_operations"),
        allowed_origin: row.get("allowed_origin"),
        proof_public_key: row.get("proof_public_key"),
        grant_id: row.get("grant_id"),
        scope_epoch: number(row.get::<i64, _>("scope_epoch"), "scope epoch")?,
    })
}

async fn load_resource_documents(
    transaction: &mut Transaction<'_, Postgres>,
    crypto: &ProviderCrypto,
    data_key: &[u8; 32],
    collection_id: Uuid,
) -> ApiResult<Vec<(String, String)>> {
    let rows = sqlx::query(
        "SELECT path, document_ciphertext FROM hosted_provider_resources WHERE collection_id = $1 ORDER BY path",
    )
    .bind(collection_id)
    .fetch_all(&mut **transaction)
    .await?;
    rows.into_iter()
        .map(|row| {
            let path: String = row.get("path");
            let plaintext = crypto.decrypt_bytes(
                data_key,
                row.get("document_ciphertext"),
                &resource_document_aad(collection_id, &path),
            )?;
            let document = String::from_utf8(plaintext).map_err(|_| {
                ApiError::internal("The hosted resource document is not valid UTF-8.")
            })?;
            Ok((path, document))
        })
        .collect()
}

async fn load_sync_resource_documents(
    pool: &PgPool,
    crypto: &ProviderCrypto,
    data_key: &[u8; 32],
    collection_id: Uuid,
) -> ApiResult<Vec<SyncResourceDocument>> {
    let rows = sqlx::query(
        r#"SELECT path, kind, revision, document_ciphertext
           FROM hosted_provider_resources WHERE collection_id = $1 ORDER BY path"#,
    )
    .bind(collection_id)
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|row| {
            let path: String = row.get("path");
            let plaintext = crypto.decrypt_bytes(
                data_key,
                row.get("document_ciphertext"),
                &resource_document_aad(collection_id, &path),
            )?;
            let document = String::from_utf8(plaintext).map_err(|_| {
                ApiError::internal("The hosted resource document is not valid UTF-8.")
            })?;
            Ok(SyncResourceDocument {
                path,
                kind: row.get("kind"),
                revision: row.get("revision"),
                document,
            })
        })
        .collect()
}

async fn load_records(
    transaction: &mut Transaction<'_, Postgres>,
    crypto: &ProviderCrypto,
    data_key: &[u8; 32],
    collection_id: Uuid,
) -> ApiResult<BTreeMap<Uuid, PersistedRecord>> {
    let rows = sqlx::query(
        r#"SELECT record_id, sequence, payload_ciphertext
           FROM hosted_provider_records WHERE collection_id = $1 ORDER BY record_id"#,
    )
    .bind(collection_id)
    .fetch_all(&mut **transaction)
    .await?;
    rows.into_iter()
        .map(|row| {
            let record_id = row.get("record_id");
            let sequence = number(row.get::<i64, _>("sequence"), "record sequence")?;
            let persisted: PersistedRecord = crypto.decrypt_json(
                data_key,
                row.get("payload_ciphertext"),
                &current_record_aad(collection_id, record_id, sequence),
            )?;
            if persisted.record.record_id != record_id {
                return Err(ApiError::internal(
                    "The hosted encrypted record identity does not match its metadata.",
                ));
            }
            Ok((record_id, persisted))
        })
        .collect()
}

async fn persist_live_record(
    transaction: &mut Transaction<'_, Postgres>,
    crypto: &ProviderCrypto,
    data_key: &[u8; 32],
    collection_id: Uuid,
    sequence: u64,
    record: &SyncRecord,
    document: &str,
) -> ApiResult<()> {
    let payload = PersistedRecord {
        record: record.clone(),
        document: document.to_string(),
    };
    let current_ciphertext = crypto.encrypt_json(
        data_key,
        &payload,
        &current_record_aad(collection_id, record.record_id, sequence),
    )?;
    let version_ciphertext = crypto.encrypt_json(
        data_key,
        &payload,
        &record_version_aad(collection_id, record.record_id, sequence),
    )?;
    let sequence_number = to_i64(sequence, "record sequence")?;
    sqlx::query(
        r#"INSERT INTO hosted_provider_records
             (collection_id, record_id, path_token, revision, types, content_bytes, payload_ciphertext, sequence)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (collection_id, record_id) DO UPDATE SET
             path_token = EXCLUDED.path_token,
             revision = EXCLUDED.revision,
             types = EXCLUDED.types,
             content_bytes = EXCLUDED.content_bytes,
             payload_ciphertext = EXCLUDED.payload_ciphertext,
             sequence = EXCLUDED.sequence,
             updated_at = now()"#,
    )
    .bind(collection_id)
    .bind(record.record_id)
    .bind(path_token(data_key, &record.path))
    .bind(&record.revision)
    .bind(&record.types)
    .bind(to_i64(document.len() as u64, "document size")?)
    .bind(current_ciphertext)
    .bind(sequence_number)
    .execute(&mut **transaction)
    .await?;
    sqlx::query(
        r#"INSERT INTO hosted_provider_record_versions
             (collection_id, record_id, sequence, revision, types, payload_ciphertext, deleted)
           VALUES ($1, $2, $3, $4, $5, $6, false)"#,
    )
    .bind(collection_id)
    .bind(record.record_id)
    .bind(sequence_number)
    .bind(&record.revision)
    .bind(&record.types)
    .bind(version_ciphertext)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

async fn persist_deleted_record(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
    sequence: u64,
    before: &SyncRecord,
    revision: &str,
) -> ApiResult<()> {
    let sequence = to_i64(sequence, "record sequence")?;
    sqlx::query("DELETE FROM hosted_provider_records WHERE collection_id = $1 AND record_id = $2")
        .bind(collection_id)
        .bind(before.record_id)
        .execute(&mut **transaction)
        .await?;
    sqlx::query(
        r#"INSERT INTO hosted_provider_record_versions
             (collection_id, record_id, sequence, revision, types, deleted)
           VALUES ($1, $2, $3, $4, $5, true)"#,
    )
    .bind(collection_id)
    .bind(before.record_id)
    .bind(sequence)
    .bind(revision)
    .bind(&before.types)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

async fn store_rejection(
    mut transaction: Transaction<'_, Postgres>,
    crypto: &ProviderCrypto,
    data_key: &[u8; 32],
    mutation: &SyncMutation,
    code: &str,
    message: &str,
) -> ApiResult<SyncMutationReceipt> {
    let receipt = SyncMutationReceipt::Rejected {
        mutation_id: mutation.mutation_id,
        error: SyncMutationError {
            code: code.to_string(),
            message: message.to_string(),
        },
    };
    store_receipt(
        &mut transaction,
        crypto,
        data_key,
        mutation.replica_id,
        mutation,
        &receipt,
    )
    .await?;
    transaction.commit().await?;
    Ok(receipt)
}

async fn store_receipt(
    transaction: &mut Transaction<'_, Postgres>,
    crypto: &ProviderCrypto,
    data_key: &[u8; 32],
    replica_id: Uuid,
    mutation: &SyncMutation,
    receipt: &SyncMutationReceipt,
) -> ApiResult<()> {
    sqlx::query(
        r#"INSERT INTO hosted_provider_mutation_receipts
             (replica_id, mutation_id, mutation_hash, receipt_ciphertext)
           VALUES ($1, $2, $3, $4)"#,
    )
    .bind(replica_id)
    .bind(mutation.mutation_id)
    .bind(mutation_hash(mutation)?)
    .bind(crypto.encrypt_json(
        data_key,
        receipt,
        &receipt_aad(replica_id, mutation.mutation_id),
    )?)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

fn authorize_application_operation(
    replica: &Replica,
    operation: &str,
    request_origin: Option<&str>,
) -> ApiResult<()> {
    if !replica
        .allowed_operations
        .iter()
        .any(|allowed| allowed == operation)
    {
        return Err(ApiError::forbidden(
            "insufficient_access",
            "The application is not allowed to perform this operation.",
        ));
    }
    authorize_application_origin(replica, request_origin)
}

fn authorize_application_origin(replica: &Replica, request_origin: Option<&str>) -> ApiResult<()> {
    if replica.allowed_origin.as_deref() != request_origin {
        return Err(ApiError::forbidden(
            "origin_denied",
            "The application origin does not match this capability.",
        ));
    }
    Ok(())
}

fn authorize_sync_access(
    replica: &Replica,
    required_operation: &str,
    request_origin: Option<&str>,
) -> ApiResult<()> {
    match replica.purpose {
        ReplicaPurpose::Application => {
            authorize_application_operation(replica, required_operation, request_origin)
        }
        ReplicaPurpose::Mirror if request_origin.is_none() => Ok(()),
        ReplicaPurpose::Mirror => Err(ApiError::forbidden(
            "origin_denied",
            "Mirror credentials cannot be used by browser applications.",
        )),
    }
}

fn mutation_operation_name(operation: SyncMutationOperation) -> &'static str {
    match operation {
        SyncMutationOperation::Create => "create",
        SyncMutationOperation::Update => "update",
        SyncMutationOperation::Rename => "rename",
        SyncMutationOperation::Delete => "delete",
    }
}

fn result_string<'a>(value: &'a Value, field: &str) -> ApiResult<&'a str> {
    value.get(field).and_then(Value::as_str).ok_or_else(|| {
        ApiError::internal(format!(
            "The hosted collection operation omitted its {field} result."
        ))
    })
}

fn scope_read_input(operation: &str, input: Value, allowed_types: &[String]) -> ApiResult<Value> {
    if operation != "query" || allowed_types.is_empty() {
        return Ok(input);
    }
    let mut scoped = input.as_object().cloned().ok_or_else(|| {
        ApiError::forbidden("scope_denied", "Scoped query input must be an object.")
    })?;
    if query_crosses_record_boundary(&Value::Object(scoped.clone())) {
        return Err(ApiError::forbidden(
            "scope_denied",
            "Cross-record traversal is unavailable to a scoped application.",
        ));
    }
    if let Some(requested) = scoped.get("types") {
        let requested = requested.as_array().ok_or_else(|| {
            ApiError::forbidden("scope_denied", "Scoped query types must be a list.")
        })?;
        if requested.is_empty() {
            scoped.insert(
                "types".to_string(),
                Value::Array(allowed_types.iter().cloned().map(Value::String).collect()),
            );
        } else if requested.iter().any(|value| {
            value
                .as_str()
                .is_none_or(|name| !allowed_types.iter().any(|allowed| allowed == name))
        }) {
            return Err(ApiError::forbidden(
                "scope_denied",
                "The query requests a record type outside this application's scope.",
            ));
        }
    } else {
        scoped.insert(
            "types".to_string(),
            Value::Array(allowed_types.iter().cloned().map(Value::String).collect()),
        );
    }
    Ok(Value::Object(scoped))
}

fn query_crosses_record_boundary(value: &Value) -> bool {
    match value {
        Value::String(source) => {
            let compact = source
                .chars()
                .filter(|character| !character.is_whitespace())
                .collect::<String>();
            compact.contains(".asFile") || compact.contains(".backlinks")
        }
        Value::Array(values) => values.iter().any(query_crosses_record_boundary),
        Value::Object(values) => values.values().any(query_crosses_record_boundary),
        _ => false,
    }
}

fn ensure_operation_result_visible(
    result: &OperationResult,
    allowed_types: &[String],
) -> ApiResult<()> {
    if allowed_types.is_empty() || !result.valid {
        return Ok(());
    }
    let visible = result
        .result
        .get("types")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .any(|record_type| allowed_types.iter().any(|allowed| allowed == record_type));
    if visible {
        Ok(())
    } else {
        Err(ApiError::forbidden(
            "scope_denied",
            "The requested record is outside this application's record scope.",
        ))
    }
}

fn application_change(
    before: Option<&SyncRecord>,
    after: Option<&SyncRecord>,
) -> (&'static str, Value) {
    match (before, after) {
        (None, Some(record)) => (
            "mdbase.record.created",
            json!({ "path": record.path, "types": record.types }),
        ),
        (Some(record), None) => (
            "mdbase.record.deleted",
            json!({ "path": record.path, "types": record.types }),
        ),
        (Some(before), Some(after)) if before.path != after.path => (
            "mdbase.record.renamed",
            json!({
                "from": before.path,
                "to": after.path,
                "types": after.types,
                "previous_types": before.types,
            }),
        ),
        (_, Some(record)) => (
            "mdbase.record.modified",
            json!({ "path": record.path, "types": record.types }),
        ),
        (None, None) => ("mdbase.record.modified", json!({})),
    }
}

fn invalid_operation_result(
    code: &str,
    message: &str,
    path: Option<String>,
    details: Option<Value>,
) -> OperationResult {
    let mut diagnostic = Diagnostic::error(code, message, path);
    diagnostic.details = details;
    OperationResult {
        valid: false,
        result: json!({}),
        diagnostics: vec![diagnostic],
    }
}

fn operation_error(envelope: &OperationResult) -> (String, String) {
    let diagnostic = envelope.diagnostics.first();
    let code = diagnostic
        .map(|value| value.code.as_str())
        .unwrap_or("validation_failed")
        .to_string();
    let message = diagnostic
        .map(|value| value.message.as_str())
        .unwrap_or("The hosted collection rejected the mutation.")
        .to_string();
    (code, message)
}

fn previously_applied(receipt: SyncMutationReceipt) -> SyncMutationReceipt {
    match receipt {
        SyncMutationReceipt::Applied {
            mutation_id,
            sequence,
            record,
        }
        | SyncMutationReceipt::PreviouslyApplied {
            mutation_id,
            sequence,
            record,
        } => SyncMutationReceipt::PreviouslyApplied {
            mutation_id,
            sequence,
            record,
        },
        receipt => receipt,
    }
}

fn scoped_resources(
    mut resources: SyncCollectionResources,
    allowed_types: &[String],
) -> SyncCollectionResources {
    if allowed_types.is_empty() {
        return resources;
    }
    let allowed = allowed_types.iter().collect::<BTreeSet<_>>();
    resources.types.retain(|item| allowed.contains(&item.name));
    resources
        .contracts
        .retain(|item| allowed.contains(&item.type_name));
    resources.documents.retain(|document| {
        document.kind == "configuration"
            || document
                .path
                .strip_prefix("_types/")
                .and_then(|path| path.strip_suffix(".md"))
                .is_some_and(|type_name| {
                    allowed.iter().any(|allowed| allowed.as_str() == type_name)
                })
    });
    resources
}

fn visible(record: &SyncRecord, allowed_types: &[String]) -> bool {
    allowed_types.is_empty()
        || record
            .types
            .iter()
            .any(|record_type| allowed_types.contains(record_type))
}

fn optional_encrypted_record(
    crypto: &ProviderCrypto,
    data_key: &[u8; 32],
    value: Option<&[u8]>,
    aad: &[u8],
) -> ApiResult<Option<SyncRecord>> {
    value
        .map(|value| crypto.decrypt_json(data_key, value, aad))
        .transpose()
}

fn collection_key_aad(collection_id: Uuid) -> Vec<u8> {
    aad(("collection_key", collection_id))
}

fn resources_aad(collection_id: Uuid) -> Vec<u8> {
    aad(("resources", collection_id))
}

fn resource_document_aad(collection_id: Uuid, path: &str) -> Vec<u8> {
    aad(("resource_document", collection_id, path))
}

fn current_record_aad(collection_id: Uuid, record_id: Uuid, sequence: u64) -> Vec<u8> {
    aad(("current_record", collection_id, record_id, sequence))
}

fn record_version_aad(collection_id: Uuid, record_id: Uuid, sequence: u64) -> Vec<u8> {
    aad(("record_version", collection_id, record_id, sequence))
}

fn change_record_aad(collection_id: Uuid, sequence: u64, side: &str) -> Vec<u8> {
    aad(("change_record", collection_id, sequence, side))
}

fn receipt_aad(replica_id: Uuid, mutation_id: Uuid) -> Vec<u8> {
    aad(("mutation_receipt", replica_id, mutation_id))
}

fn authority_import_manifest_aad(import_id: Uuid) -> Vec<u8> {
    aad(("authority_import_manifest", import_id))
}

fn authority_import_record_aad(import_id: Uuid, record_id: Uuid) -> Vec<u8> {
    aad(("authority_import_record", import_id, record_id))
}

fn aad(value: impl Serialize) -> Vec<u8> {
    serde_json::to_vec(&value).expect("hosted ciphertext identity serializes")
}

fn replica_mode(mode: SyncReplicaMode) -> &'static str {
    match mode {
        SyncReplicaMode::ReadOnly => "read_only",
        SyncReplicaMode::ReadWrite => "read_write",
    }
}

fn replica_purpose(purpose: ReplicaPurpose) -> &'static str {
    match purpose {
        ReplicaPurpose::Mirror => "mirror",
        ReplicaPurpose::Application => "application",
    }
}

fn verify_hosted_request_proof(
    public_key: &str,
    credential: &str,
    proof: &AuthorityRequestProof,
) -> ApiResult<()> {
    if proof.version != AUTHORITY_PROOF_VERSION {
        return Err(ApiError::unauthorized(
            "invalid_authority_proof",
            "The authority request proof version is unsupported.",
        ));
    }
    if Utc::now().timestamp().abs_diff(proof.timestamp) > 5 * 60 {
        return Err(ApiError::unauthorized(
            "invalid_authority_proof",
            "The authority request proof timestamp is invalid or expired.",
        ));
    }
    if proof.method.is_empty()
        || proof.target.is_empty()
        || [proof.method.as_str(), proof.target.as_str()]
            .iter()
            .any(|value| value.contains('\n') || value.contains('\r'))
    {
        return Err(ApiError::unauthorized(
            "invalid_authority_proof",
            "The authority request proof metadata is invalid.",
        ));
    }
    let verifying_key = proof_verifying_key(public_key).map_err(|_| {
        ApiError::unauthorized(
            "invalid_authority_proof",
            "The authority request proof key is invalid.",
        )
    })?;
    let signature_bytes = decode_base64url(&proof.signature).map_err(|_| {
        ApiError::unauthorized(
            "invalid_authority_proof",
            "The authority request proof signature is invalid.",
        )
    })?;
    let signature = Signature::from_slice(&signature_bytes).map_err(|_| {
        ApiError::unauthorized(
            "invalid_authority_proof",
            "The authority request proof signature is invalid.",
        )
    })?;
    verifying_key
        .verify(
            authority_proof_message(credential, proof).as_bytes(),
            &signature,
        )
        .map_err(|_| {
            ApiError::unauthorized(
                "invalid_authority_proof",
                "The authority request proof signature is invalid.",
            )
        })
}

fn authority_proof_message(credential: &str, proof: &AuthorityRequestProof) -> String {
    [
        AUTHORITY_PROOF_DOMAIN.to_string(),
        AUTHORITY_PROOF_VERSION.to_string(),
        proof.method.to_uppercase(),
        proof.target.clone(),
        digest_base64url(&proof.body),
        digest_base64url(credential.as_bytes()),
        proof.timestamp.to_string(),
        proof.nonce.to_string(),
    ]
    .join("\n")
}

fn digest_base64url(value: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(value))
}

fn decode_base64url(value: &str) -> Result<Vec<u8>, ()> {
    let decoded = URL_SAFE_NO_PAD.decode(value).map_err(|_| ())?;
    if URL_SAFE_NO_PAD.encode(&decoded) != value {
        return Err(());
    }
    Ok(decoded)
}

fn proof_verifying_key(value: &str) -> Result<VerifyingKey, ()> {
    let bytes = decode_base64url(value)?;
    if bytes.len() != 65 || bytes[0] != 4 {
        return Err(());
    }
    VerifyingKey::from_sec1_bytes(&bytes).map_err(|_| ())
}

fn validate_proof_public_key(value: &str) -> ApiResult<()> {
    proof_verifying_key(value).map(|_| ()).map_err(|_| {
        ApiError::bad_request(
            "invalid_authority_proof_key",
            "Hosted proof keys must be uncompressed P-256 public keys.",
        )
    })
}

fn validate_replica_capability(input: &RegisterReplica) -> ApiResult<()> {
    validate_operations(&input.allowed_operations, input.mode)?;
    match input.purpose {
        ReplicaPurpose::Mirror => {
            if !input.allowed_operations.is_empty()
                || input.allowed_origin.is_some()
                || input.proof_public_key.is_some()
                || input.grant_id.is_some()
                || input.full_collection
            {
                return Err(ApiError::bad_request(
                    "invalid_mirror_capability",
                    "Mirror replicas cannot contain browser application policy.",
                ));
            }
        }
        ReplicaPurpose::Application => {
            if input.allowed_operations.is_empty() {
                return Err(ApiError::bad_request(
                    "invalid_application_capability",
                    "Application capabilities require at least one operation.",
                ));
            }
            if input.grant_id.is_none() {
                return Err(ApiError::bad_request(
                    "invalid_application_capability",
                    "Application capabilities require a grant.",
                ));
            }
            validate_collection_scope(
                input.full_collection,
                &input.allowed_types,
                &input.allowed_operations,
            )?;
            if input.proof_public_key.is_some() && input.allowed_origin.is_none() {
                return Err(ApiError::bad_request(
                    "invalid_authority_proof_key",
                    "Hosted proof keys require an exact application origin.",
                ));
            }
            if let Some(origin) = input.allowed_origin.as_deref() {
                if origin == "null" && input.proof_public_key.is_none() {
                    return Err(ApiError::bad_request(
                        "authority_proof_required",
                        "Opaque-origin application capabilities require a proof-of-possession key.",
                    ));
                }
                if origin != "null" {
                    let url = url::Url::parse(origin).map_err(|_| {
                        ApiError::bad_request(
                            "invalid_application_origin",
                            "Application origin must be `null` or an absolute HTTP(S) origin.",
                        )
                    })?;
                    if !matches!(url.scheme(), "http" | "https")
                        || !url.username().is_empty()
                        || url.password().is_some()
                        || url.path() != "/"
                        || url.query().is_some()
                        || url.fragment().is_some()
                        || url.origin().ascii_serialization() != origin
                    {
                        return Err(ApiError::bad_request(
                            "invalid_application_origin",
                            "Application origin must be `null` or a canonical HTTP(S) origin.",
                        ));
                    }
                }
            }
            if let Some(public_key) = input.proof_public_key.as_deref() {
                validate_proof_public_key(public_key)?;
            }
        }
    }
    Ok(())
}

fn validate_collection_scope(
    full_collection: bool,
    allowed_types: &[String],
    operations: &[String],
) -> ApiResult<()> {
    if full_collection != allowed_types.is_empty() {
        return Err(ApiError::bad_request(
            "invalid_application_scope",
            "Full collection access requires no type restrictions; contract access requires at least one allowed type.",
        ));
    }
    if !full_collection
        && operations
            .iter()
            .any(|operation| is_full_collection_operation(operation))
    {
        return Err(ApiError::bad_request(
            "invalid_application_scope",
            "Saved views, collection-wide validation, and type definitions require full collection access.",
        ));
    }
    Ok(())
}

fn is_full_collection_operation(operation: &str) -> bool {
    matches!(
        operation,
        "validate"
            | "read_type"
            | "create_type"
            | "update_type"
            | "list_views"
            | "execute_view"
            | "read_view_source"
            | "create_view_source"
            | "update_view_source"
            | "delete_view_source"
    )
}

fn validate_operations(operations: &[String], mode: SyncReplicaMode) -> ApiResult<()> {
    const OPERATIONS: &[&str] = &[
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
        "list_views",
        "execute_view",
        "read_view_source",
        "create_view_source",
        "update_view_source",
        "delete_view_source",
        "list_timers",
        "put_timer",
        "cancel_timer",
        "reconcile_timers",
    ];
    const WRITES: &[&str] = &[
        "create",
        "update",
        "delete",
        "rename",
        "create_type",
        "update_type",
        "create_view_source",
        "update_view_source",
        "delete_view_source",
        "put_timer",
        "cancel_timer",
        "reconcile_timers",
    ];
    if operations
        .iter()
        .any(|operation| !OPERATIONS.contains(&operation.as_str()))
    {
        return Err(ApiError::bad_request(
            "invalid_replica_operation",
            "Application capabilities contain an unsupported collection operation.",
        ));
    }
    if mode == SyncReplicaMode::ReadOnly
        && operations
            .iter()
            .any(|operation| WRITES.contains(&operation.as_str()))
    {
        return Err(ApiError::bad_request(
            "invalid_application_capability",
            "A read-only application capability cannot contain write operations.",
        ));
    }
    Ok(())
}

fn default_authority_transfer_ttl() -> u64 {
    15 * 60
}

async fn authority_import_row(
    transaction: &mut Transaction<'_, Postgres>,
    import_id: Uuid,
) -> ApiResult<PgRow> {
    sqlx::query(
        r#"SELECT import.id, import.collection_id, import.token_hash,
                  import.next_authority_epoch, import.state AS import_state,
                  import.manifest_ciphertext, import.manifest_digest,
                  import.source_revision, import.source_head,
                  import.expected_record_count, import.restore_state,
                  import.expires_at,
                  collection.wrapped_data_key, collection.max_records,
                  collection.max_content_bytes, collection.max_document_bytes,
                  collection.state AS collection_state
           FROM hosted_provider_authority_imports import
           JOIN hosted_provider_collections collection ON collection.id = import.collection_id
           WHERE import.id = $1 FOR UPDATE"#,
    )
    .bind(import_id)
    .fetch_optional(&mut **transaction)
    .await?
    .ok_or_else(|| {
        ApiError::not_found(
            "authority_import_not_found",
            "Authority import was not found.",
        )
    })
}

fn authorize_authority_import(row: &PgRow, token: &str) -> ApiResult<()> {
    let state: String = row.get("import_state");
    if !matches!(state.as_str(), "receiving" | "uploaded")
        || row.get::<DateTime<Utc>, _>("expires_at") <= Utc::now()
        || row.get::<String, _>("collection_state") != "importing"
    {
        return Err(ApiError::conflict(
            "authority_import_inactive",
            "Authority import is no longer active.",
        ));
    }
    let expected: Vec<u8> = row.get("token_hash");
    let candidate = token_hash(token);
    if expected.len() != candidate.len() || !bool::from(expected.as_slice().ct_eq(&candidate)) {
        return Err(ApiError::unauthorized(
            "invalid_authority_import_token",
            "Authority import credential is invalid.",
        ));
    }
    Ok(())
}

fn provider_authority_import(row: &PgRow) -> ApiResult<ProviderAuthorityImport> {
    let state = row
        .try_get::<String, _>("import_state")
        .or_else(|_| row.try_get::<String, _>("state"))?;
    Ok(ProviderAuthorityImport {
        id: row.get("id"),
        collection_id: row.get("collection_id"),
        authority_epoch: number(row.get::<i64, _>("next_authority_epoch"), "authority epoch")?,
        state,
        manifest_digest: row.try_get("manifest_digest").unwrap_or(None),
        source_revision: row.try_get("source_revision").unwrap_or(None),
        source_head: row
            .try_get::<Option<i64>, _>("source_head")
            .unwrap_or(None)
            .map(|value| number(value, "source head"))
            .transpose()?,
        expires_at: row.get("expires_at"),
    })
}

async fn recover_expired_authority_imports_in(
    transaction: &mut Transaction<'_, Postgres>,
) -> ApiResult<usize> {
    let expired = sqlx::query(
        r#"SELECT id, collection_id, next_authority_epoch, restore_state
           FROM hosted_provider_authority_imports
           WHERE state IN ('receiving', 'uploaded') AND expires_at <= now()
           FOR UPDATE"#,
    )
    .fetch_all(&mut **transaction)
    .await?;
    for row in &expired {
        if row.get::<Option<String>, _>("restore_state").as_deref() == Some("transferred") {
            sqlx::query(
                r#"UPDATE hosted_provider_collections
                   SET state = 'transferred', authority_epoch = $2, updated_at = now()
                   WHERE id = $1 AND state = 'importing'"#,
            )
            .bind(row.get::<Uuid, _>("collection_id"))
            .bind(row.get::<i64, _>("next_authority_epoch") - 1)
            .execute(&mut **transaction)
            .await?;
            sqlx::query("DELETE FROM hosted_provider_authority_imports WHERE id = $1")
                .bind(row.get::<Uuid, _>("id"))
                .execute(&mut **transaction)
                .await?;
        } else {
            sqlx::query(
                "DELETE FROM hosted_provider_collections WHERE id = $1 AND state = 'importing'",
            )
            .bind(row.get::<Uuid, _>("collection_id"))
            .execute(&mut **transaction)
            .await?;
        }
    }
    Ok(expired.len())
}

fn validate_imported_snapshot(
    workspace: &WorkingSet,
    manifest: &AuthorityImportManifest,
    records: &[AuthoritySnapshotRecord],
) -> ApiResult<()> {
    let canonical = workspace.snapshot()?;
    if canonical.spec_version != manifest.resources.spec_version
        || canonical.resource_revision != manifest.resources.revision
    {
        return Err(ApiError::bad_request(
            "invalid_authority_snapshot",
            "Imported collection resources do not match their declared revision.",
        ));
    }
    let resources = manifest
        .resources
        .documents
        .iter()
        .map(|resource| (resource.path.as_str(), resource))
        .collect::<BTreeMap<_, _>>();
    if resources.len() != canonical.resources.len()
        || canonical.resources.iter().any(|resource| {
            resources
                .get(resource.path.as_str())
                .is_none_or(|declared| {
                    declared.revision != resource.revision
                        || declared.document != resource.document
                        || declared.kind
                            != match resource.kind {
                                mdbase::runtime::CollectionSnapshotResourceKind::Configuration => {
                                    "configuration"
                                }
                                mdbase::runtime::CollectionSnapshotResourceKind::Type => "type",
                            }
                })
        })
    {
        return Err(ApiError::bad_request(
            "invalid_authority_snapshot",
            "Imported resource documents are not canonical.",
        ));
    }
    let declared = records
        .iter()
        .map(|item| (item.record.path.as_str(), item))
        .collect::<BTreeMap<_, _>>();
    if declared.len() != canonical.records.len()
        || canonical.records.iter().any(|record| {
            declared.get(record.path.as_str()).is_none_or(|item| {
                item.record.revision != record.revision
                    || item.record.frontmatter != record.frontmatter
                    || item.record.body != record.body
                    || item.record.types != record.types
                    || item.document != record.document
            })
        })
    {
        return Err(ApiError::bad_request(
            "invalid_authority_snapshot",
            "Imported record documents are not canonical.",
        ));
    }
    Ok(())
}

fn provider_authority_transfer(row: &PgRow) -> ApiResult<ProviderAuthorityTransfer> {
    Ok(ProviderAuthorityTransfer {
        id: row.get("id"),
        collection_id: row.get("collection_id"),
        replica_id: row.get("replica_id"),
        final_head: number(row.get::<i64, _>("final_head"), "collection head")?,
        authority_epoch: number(row.get::<i64, _>("next_authority_epoch"), "authority epoch")?,
        manifest_digest: row.get("manifest_digest"),
        state: row.get("state"),
        expires_at: row.get("expires_at"),
    })
}

async fn recover_expired_authority_transfers_in(
    transaction: &mut Transaction<'_, Postgres>,
) -> ApiResult<usize> {
    let expired = sqlx::query(
        r#"UPDATE hosted_provider_authority_transfers
           SET state = 'aborted', aborted_at = now()
           WHERE state = 'prepared' AND expires_at <= now()
           RETURNING collection_id"#,
    )
    .fetch_all(&mut **transaction)
    .await?;
    for row in &expired {
        sqlx::query(
            r#"UPDATE hosted_provider_collections
               SET state = 'active', updated_at = now()
               WHERE id = $1 AND state = 'transferring'
                 AND NOT EXISTS (
                   SELECT 1 FROM hosted_provider_authority_transfers
                   WHERE collection_id = $1 AND state = 'prepared'
                 )"#,
        )
        .bind(row.get::<Uuid, _>("collection_id"))
        .execute(&mut **transaction)
        .await?;
    }
    Ok(expired.len())
}

fn authority_manifest_digest(
    resources: Vec<(String, String)>,
    records: BTreeMap<Uuid, PersistedRecord>,
) -> String {
    let mut entries = BTreeMap::<(String, String), String>::new();
    for (path, document) in resources {
        entries.insert(
            ("resource".to_string(), path),
            sha256_hex(document.as_bytes()),
        );
    }
    for persisted in records.into_values() {
        entries.insert(
            ("record".to_string(), persisted.record.path),
            persisted.record.revision,
        );
    }
    authority_manifest_digest_from_hashes(entries)
}

fn authority_manifest_digest_from_hashes(entries: BTreeMap<(String, String), String>) -> String {
    let mut manifest = Sha256::new();
    manifest.update(b"mdbase-authority-manifest-v1\n");
    for ((kind, path), document_hash) in entries {
        manifest.update(kind.as_bytes());
        manifest.update(b"\0");
        manifest.update(path.as_bytes());
        manifest.update(b"\0");
        manifest.update(document_hash.as_bytes());
        manifest.update(b"\n");
    }
    hex_digest(&manifest.finalize())
}

fn sha256_hex(value: &[u8]) -> String {
    hex_digest(&Sha256::digest(value))
}

fn hex_digest(value: &[u8]) -> String {
    value.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn constant_time_text_equal(expected: &str, candidate: &str) -> bool {
    expected.len() == candidate.len() && bool::from(expected.as_bytes().ct_eq(candidate.as_bytes()))
}

fn token_hash(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

fn path_token(data_key: &[u8; 32], path: &str) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(data_key)
        .expect("a 256-bit collection key is a valid HMAC key");
    mac.update(b"mdbase-connect/hosted-path/v1\0");
    mac.update(path.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

fn mutation_hash(mutation: &SyncMutation) -> ApiResult<Vec<u8>> {
    let bytes = serde_json::to_vec(mutation).map_err(|error| {
        ApiError::internal(format!("Hosted mutation could not serialize: {error}"))
    })?;
    Ok(Sha256::digest(bytes).to_vec())
}

fn number(value: i64, name: &'static str) -> ApiResult<u64> {
    value
        .try_into()
        .map_err(|_| ApiError::internal(format!("Stored {name} is outside the supported range.")))
}

fn to_i64(value: u64, name: &'static str) -> ApiResult<i64> {
    value
        .try_into()
        .map_err(|_| ApiError::bad_request("numeric_range", format!("{name} is too large.")))
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Map;

    #[test]
    fn authority_manifest_matches_the_node_promotion_fixture() {
        let entries = BTreeMap::from([
            (
                ("record".to_string(), "tasks/a.md".to_string()),
                "00".repeat(32),
            ),
            (
                ("resource".to_string(), "mdbase.yaml".to_string()),
                "ff".repeat(32),
            ),
        ]);
        assert_eq!(
            authority_manifest_digest_from_hashes(entries),
            "c3a6c98f15ed143bf4b9642e32c9f4c775ca8ad4978a42a4dbd69f79f6fc5e0f"
        );
    }

    #[test]
    fn deleted_record_events_use_the_portable_types_field() {
        let record = SyncRecord {
            record_id: Uuid::new_v4(),
            path: "tasks/deleted.md".to_string(),
            revision: "sha256:deleted".to_string(),
            frontmatter: Default::default(),
            body: String::new(),
            types: vec!["task".to_string()],
        };
        assert_eq!(
            application_change(Some(&record), None),
            (
                "mdbase.record.deleted",
                json!({ "path": "tasks/deleted.md", "types": ["task"] }),
            )
        );
    }

    #[test]
    fn scopes_resources_and_records_consistently() {
        let resources = SyncCollectionResources {
            revision: "example:1".to_string(),
            spec_version: "0.3.0".to_string(),
            types: vec![mdbase_connect_protocol::CollectionTypeDescriptor {
                name: "task".to_string(),
                version: Some(1),
                description: Some("A generic work item.".to_string()),
                path: Some("_types/task.md".to_string()),
                definition: None,
                schema: json!({ "type": "object" }),
                collection: None,
                lifecycle: None,
                extensions: Map::new(),
            }],
            contracts: vec![CollectionContractDescriptor {
                id: "example.work-item".to_string(),
                version: 1,
                type_name: "task".to_string(),
                extension: "x-example".to_string(),
                configuration: json!({ "contract": "example.work-item", "version": 1 }),
            }],
            documents: Vec::new(),
        };
        let scoped = scoped_resources(resources, &["other".to_string()]);
        assert!(scoped.types.is_empty());
        assert!(scoped.contracts.is_empty());
        let record = SyncRecord {
            record_id: Uuid::new_v4(),
            path: "tasks/one.md".to_string(),
            revision: "sha256:one".to_string(),
            frontmatter: Default::default(),
            body: String::new(),
            types: vec!["task".to_string()],
        };
        assert!(visible(&record, &[]));
        assert!(visible(&record, &["task".to_string()]));
        assert!(!visible(&record, &["other".to_string()]));
    }

    #[test]
    fn applied_receipts_become_replays_without_changing_the_sequence() {
        let mutation_id = Uuid::new_v4();
        let receipt = previously_applied(SyncMutationReceipt::Applied {
            mutation_id,
            sequence: 9,
            record: None,
        });
        assert!(matches!(
            receipt,
            SyncMutationReceipt::PreviouslyApplied {
                mutation_id: id,
                sequence: 9,
                ..
            } if id == mutation_id
        ));
    }

    #[test]
    fn application_capabilities_bind_operations_mode_and_origin() {
        let capability = RegisterReplica {
            replica_id: Uuid::new_v4(),
            name: "Tasks app".to_string(),
            purpose: ReplicaPurpose::Application,
            mode: SyncReplicaMode::ReadOnly,
            allowed_types: Vec::new(),
            full_collection: true,
            allowed_operations: vec![
                "query".to_string(),
                "list_views".to_string(),
                "execute_view".to_string(),
            ],
            allowed_origin: Some("https://tasks.example".to_string()),
            proof_public_key: None,
            grant_id: Some(Uuid::new_v4()),
            token: "x".repeat(40),
            token_ttl_seconds: Some(3600),
        };
        validate_replica_capability(&capability).unwrap();
        let mut portable_capability = capability.clone();
        portable_capability.allowed_origin = Some("null".to_string());
        let signing_key = p256::ecdsa::SigningKey::random(&mut rand_core::OsRng);
        portable_capability.proof_public_key = Some(
            URL_SAFE_NO_PAD.encode(
                signing_key
                    .verifying_key()
                    .to_encoded_point(false)
                    .as_bytes(),
            ),
        );
        validate_replica_capability(&portable_capability).unwrap();
        let mut proof_without_origin = portable_capability.clone();
        proof_without_origin.allowed_origin = None;
        assert_eq!(
            validate_replica_capability(&proof_without_origin)
                .unwrap_err()
                .code,
            "invalid_authority_proof_key"
        );
        let portable_replica = Replica {
            id: portable_capability.replica_id,
            purpose: portable_capability.purpose,
            mode: portable_capability.mode,
            allowed_types: portable_capability.allowed_types,
            full_collection: portable_capability.full_collection,
            allowed_operations: portable_capability.allowed_operations,
            allowed_origin: portable_capability.allowed_origin,
            proof_public_key: portable_capability.proof_public_key,
            grant_id: portable_capability.grant_id,
            scope_epoch: 1,
        };
        authorize_application_operation(&portable_replica, "query", Some("null")).unwrap();
        assert_eq!(
            authorize_application_operation(&portable_replica, "query", None)
                .unwrap_err()
                .code,
            "origin_denied"
        );
        assert_eq!(
            authorize_application_operation(
                &portable_replica,
                "query",
                Some("https://tasks.example")
            )
            .unwrap_err()
            .code,
            "origin_denied"
        );
        let mut missing_grant = capability.clone();
        missing_grant.grant_id = None;
        assert_eq!(
            validate_replica_capability(&missing_grant)
                .unwrap_err()
                .code,
            "invalid_application_capability"
        );
        let mut contract_capability = capability.clone();
        contract_capability.full_collection = false;
        assert_eq!(
            validate_replica_capability(&contract_capability)
                .unwrap_err()
                .code,
            "invalid_application_scope"
        );
        let replica = Replica {
            id: capability.replica_id,
            purpose: capability.purpose,
            mode: capability.mode,
            allowed_types: capability.allowed_types,
            full_collection: capability.full_collection,
            allowed_operations: capability.allowed_operations,
            allowed_origin: capability.allowed_origin,
            proof_public_key: capability.proof_public_key,
            grant_id: capability.grant_id,
            scope_epoch: 1,
        };
        authorize_application_operation(&replica, "query", Some("https://tasks.example")).unwrap();
        authorize_application_operation(&replica, "list_views", Some("https://tasks.example"))
            .unwrap();
        authorize_application_operation(&replica, "execute_view", Some("https://tasks.example"))
            .unwrap();
        assert_eq!(
            authorize_application_operation(&replica, "create", None)
                .unwrap_err()
                .code,
            "insufficient_access"
        );
        assert_eq!(
            authorize_application_operation(&replica, "query", Some("https://evil.example"))
                .unwrap_err()
                .code,
            "origin_denied"
        );
        authorize_sync_access(&replica, "query", Some("https://tasks.example")).unwrap();
        assert_eq!(
            authorize_sync_access(&replica, "changes", Some("https://tasks.example"))
                .unwrap_err()
                .code,
            "insufficient_access"
        );
        assert_eq!(
            authorize_sync_access(&replica, "query", Some("https://evil.example"))
                .unwrap_err()
                .code,
            "origin_denied"
        );
    }

    #[test]
    fn authority_request_proofs_bind_the_body_credential_and_timestamp() {
        use p256::ecdsa::{signature::Signer, SigningKey};

        let signing_key = SigningKey::random(&mut rand_core::OsRng);
        let public_key = URL_SAFE_NO_PAD.encode(
            signing_key
                .verifying_key()
                .to_encoded_point(false)
                .as_bytes(),
        );
        let mut proof = AuthorityRequestProof {
            version: AUTHORITY_PROOF_VERSION,
            timestamp: Utc::now().timestamp(),
            nonce: Uuid::new_v4(),
            signature: String::new(),
            method: "POST".to_string(),
            target: "/v1/authorities/example/operations/create".to_string(),
            body: br#"{"title":"proof"}"#.to_vec(),
        };
        let signature: Signature =
            signing_key.sign(authority_proof_message("hsa_secret", &proof).as_bytes());
        proof.signature = URL_SAFE_NO_PAD.encode(signature.to_bytes());
        verify_hosted_request_proof(&public_key, "hsa_secret", &proof).unwrap();

        proof.body = br#"{"title":"tampered"}"#.to_vec();
        assert_eq!(
            verify_hosted_request_proof(&public_key, "hsa_secret", &proof)
                .unwrap_err()
                .code,
            "invalid_authority_proof"
        );
        proof.body = br#"{"title":"proof"}"#.to_vec();
        assert_eq!(
            verify_hosted_request_proof(&public_key, "hsa_other", &proof)
                .unwrap_err()
                .code,
            "invalid_authority_proof"
        );
        proof.timestamp -= 301;
        assert_eq!(
            verify_hosted_request_proof(&public_key, "hsa_secret", &proof)
                .unwrap_err()
                .code,
            "invalid_authority_proof"
        );
    }

    #[test]
    fn mirror_sync_credentials_are_not_browser_capabilities() {
        let replica = Replica {
            id: Uuid::new_v4(),
            purpose: ReplicaPurpose::Mirror,
            mode: SyncReplicaMode::ReadOnly,
            allowed_types: Vec::new(),
            full_collection: false,
            allowed_operations: Vec::new(),
            allowed_origin: None,
            proof_public_key: None,
            grant_id: None,
            scope_epoch: 1,
        };
        authorize_sync_access(&replica, "read", None).unwrap();
        assert_eq!(
            authorize_sync_access(&replica, "read", Some("https://tasks.example"))
                .unwrap_err()
                .code,
            "origin_denied"
        );
    }

    #[test]
    fn sync_mutations_use_their_matching_application_permission() {
        assert_eq!(
            mutation_operation_name(SyncMutationOperation::Create),
            "create"
        );
        assert_eq!(
            mutation_operation_name(SyncMutationOperation::Update),
            "update"
        );
        assert_eq!(
            mutation_operation_name(SyncMutationOperation::Rename),
            "rename"
        );
        assert_eq!(
            mutation_operation_name(SyncMutationOperation::Delete),
            "delete"
        );
    }

    #[test]
    fn rejects_write_operations_on_read_only_application_capabilities() {
        let capability = RegisterReplica {
            replica_id: Uuid::new_v4(),
            name: "Tasks app".to_string(),
            purpose: ReplicaPurpose::Application,
            mode: SyncReplicaMode::ReadOnly,
            allowed_types: vec!["task".to_string()],
            full_collection: false,
            allowed_operations: vec!["create".to_string()],
            allowed_origin: Some("https://tasks.example".to_string()),
            proof_public_key: None,
            grant_id: Some(Uuid::new_v4()),
            token: "x".repeat(40),
            token_ttl_seconds: Some(3600),
        };
        assert_eq!(
            validate_replica_capability(&capability).unwrap_err().code,
            "invalid_application_capability"
        );
    }
}
