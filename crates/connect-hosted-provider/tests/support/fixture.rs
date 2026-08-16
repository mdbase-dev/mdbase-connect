use std::sync::Arc;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use mdbase_connect_hosted_provider::{
    HostedProvider, ProviderAccountLimits, ProviderCrypto, ProviderLimits, RegisterReplica,
    ReplicaPurpose,
};
use mdbase_connect_protocol::{
    AbortFileTransferRequest, AbortFileTransferRequestKind, CommitFileUploadRequest,
    CommitFileUploadRequestKind, OpenFileUploadRequest, OpenFileUploadRequestKind,
    PrepareFileUploadPartRequest, PrepareFileUploadPartRequestKind, SyncCollectionResources,
    SyncReplicaMode, FILE_PROTOCOL_VERSION,
};
use sha2::{Digest, Sha256};
use sqlx::{postgres::PgPoolOptions, PgPool, Row};
use uuid::Uuid;

use super::ControlledBlobStore;

pub struct FileLifecycleFixture {
    pub provider: HostedProvider,
    pub pool: PgPool,
    pub blobs: ControlledBlobStore,
    #[allow(dead_code)]
    pub crypto: ProviderCrypto,
    pub collection_id: Uuid,
    pub token: String,
}

impl FileLifecycleFixture {
    pub async fn new(database_url: &str) -> Self {
        let blobs = ControlledBlobStore::default();
        let crypto = ProviderCrypto::from_base64(&URL_SAFE_NO_PAD.encode([7_u8; 32]))
            .expect("test master key is valid");
        let provider = HostedProvider::connect(
            database_url,
            crypto.clone(),
            ProviderLimits::default(),
            Arc::new(blobs.clone()),
            None,
        )
        .await
        .expect("provider connects");
        let pool = PgPoolOptions::new()
            .max_connections(10)
            .connect(database_url)
            .await
            .expect("test database connects");
        let collection_id = Uuid::now_v7();
        let account_id = Uuid::now_v7();
        provider
            .upsert_account(
                account_id,
                1,
                ProviderAccountLimits {
                    hosted_storage_bytes: 1024 * 1024 * 1024,
                    retained_file_bytes: 2 * 1024 * 1024 * 1024,
                    max_document_bytes: 2 * 1024 * 1024,
                    max_single_file_bytes: 250 * 1024 * 1024,
                    max_mirror_replicas_per_collection: 10,
                    max_application_replicas_per_collection: 50,
                    max_hosted_collections: 10,
                    max_files_per_collection: 10_000,
                },
            )
            .await
            .expect("account is provisioned");
        provider
            .create_collection(
                account_id,
                collection_id,
                "mdbase",
                "Adversarial files",
                "UTC",
            )
            .await
            .expect("collection is created");
        let token = format!("adversarial-{}-{}", Uuid::new_v4(), Uuid::new_v4());
        provider
            .register_replica(
                collection_id,
                RegisterReplica {
                    replica_id: Uuid::now_v7(),
                    name: "Adversarial writer".to_string(),
                    purpose: ReplicaPurpose::Mirror,
                    mode: SyncReplicaMode::ReadWrite,
                    allowed_types: Vec::new(),
                    contract_scope: Vec::new(),
                    full_collection: false,
                    allowed_operations: Vec::new(),
                    operation_transport_protocol: None,
                    operation_transport_recovery_protocols: Vec::new(),
                    file_capability: None,
                    allowed_origin: None,
                    proof_public_key: None,
                    grant_id: None,
                    application_declaration_id: None,
                    application_declaration_digest: None,
                    token: token.clone(),
                    token_ttl_seconds: None,
                },
            )
            .await
            .expect("replica is registered");
        Self {
            provider,
            pool,
            blobs,
            crypto,
            collection_id,
            token,
        }
    }

    /// Test-only collection bootstrap performed before any semantic generation
    /// exists. Production configuration changes must use the reviewed setup
    /// operation and its journal/receipt path.
    #[allow(dead_code)]
    pub async fn enable_obsidian_base_pattern(&self, pattern: &str) {
        let mut transaction = self.pool.begin().await.expect("test transaction opens");
        let collection = sqlx::query(
            "SELECT head, wrapped_data_key, resources_ciphertext FROM hosted_provider_collections WHERE id = $1 FOR UPDATE",
        )
        .bind(self.collection_id)
        .fetch_one(&mut *transaction)
        .await
        .expect("test collection exists");
        let data_key = self
            .crypto
            .unwrap_data_key(collection.get("wrapped_data_key"), self.collection_id)
            .await
            .expect("test data key unwraps");
        let resources_aad = serde_json::to_vec(&("resources", self.collection_id)).unwrap();
        let mut resources: SyncCollectionResources = self
            .crypto
            .decrypt_json(
                &data_key,
                collection.get("resources_ciphertext"),
                &resources_aad,
            )
            .expect("test resources decrypt");
        let config = sqlx::query(
            "SELECT document_ciphertext FROM hosted_provider_resources WHERE collection_id = $1 AND path = 'mdbase.yaml' FOR UPDATE",
        )
        .bind(self.collection_id)
        .fetch_one(&mut *transaction)
        .await
        .expect("configuration resource exists");
        let config_aad =
            serde_json::to_vec(&("resource_document", self.collection_id, "mdbase.yaml")).unwrap();
        let current = self
            .crypto
            .decrypt_bytes(&data_key, config.get("document_ciphertext"), &config_aad)
            .expect("test configuration decrypts");
        let mut document = String::from_utf8(current).expect("test configuration is UTF-8");
        document.push_str(&format!(
            "x-obsidian:\n  bases:\n    include:\n      - {pattern}\n"
        ));
        let revision = format!("sha256:{:x}", Sha256::digest(document.as_bytes()));
        let ciphertext = self
            .crypto
            .encrypt_bytes(&data_key, document.as_bytes(), &config_aad)
            .expect("test configuration encrypts");
        let head = collection.get::<i64, _>("head") + 1;
        resources.revision = format!("test:{head}:resources");
        let resources_ciphertext = self
            .crypto
            .encrypt_json(&data_key, &resources, &resources_aad)
            .expect("test resources encrypt");
        sqlx::query(
            "UPDATE hosted_provider_resources SET revision = $3, document_ciphertext = $4, updated_at = now() WHERE collection_id = $1 AND path = $2",
        )
        .bind(self.collection_id)
        .bind("mdbase.yaml")
        .bind(revision)
        .bind(ciphertext)
        .execute(&mut *transaction)
        .await
        .unwrap();
        sqlx::query(
            "UPDATE hosted_provider_collections SET head = $2, resource_revision = $3, resources_ciphertext = $4 WHERE id = $1",
        )
        .bind(self.collection_id)
        .bind(head)
        .bind(&resources.revision)
        .bind(resources_ciphertext)
        .execute(&mut *transaction)
        .await
        .unwrap();
        transaction.commit().await.unwrap();
    }

    pub async fn stage_upload(&self, path: &str, bytes: &[u8]) -> Uuid {
        let transfer_id = Uuid::now_v7();
        self.provider
            .open_file_upload(
                self.collection_id,
                &self.token,
                OpenFileUploadRequest {
                    protocol_version: FILE_PROTOCOL_VERSION,
                    message_type: OpenFileUploadRequestKind::OpenFileUpload,
                    transfer_id,
                    path: path.to_string(),
                    size: bytes.len() as u64,
                    content_digest: format!("sha256:{:x}", Sha256::digest(bytes)),
                    media_type: None,
                    if_revision: None,
                },
                None,
            )
            .await
            .expect("upload opens");
        self.provider
            .prepare_file_upload_part(
                self.collection_id,
                &self.token,
                PrepareFileUploadPartRequest {
                    protocol_version: FILE_PROTOCOL_VERSION,
                    message_type: PrepareFileUploadPartRequestKind::PrepareFileUploadPart,
                    transfer_id,
                    part_number: 1,
                    content_length: bytes.len() as u64,
                },
                None,
            )
            .await
            .expect("upload part is prepared");
        self.blobs
            .put(self.staging_key(transfer_id), bytes.to_vec())
            .await;
        transfer_id
    }

    pub async fn another_provider(&self, database_url: &str) -> HostedProvider {
        HostedProvider::connect(
            database_url,
            ProviderCrypto::from_base64(&URL_SAFE_NO_PAD.encode([7_u8; 32]))
                .expect("test master key is valid"),
            ProviderLimits::default(),
            Arc::new(self.blobs.clone()),
            None,
        )
        .await
        .expect("independent provider connects")
    }

    pub fn commit_request(transfer_id: Uuid) -> CommitFileUploadRequest {
        CommitFileUploadRequest {
            protocol_version: FILE_PROTOCOL_VERSION,
            message_type: CommitFileUploadRequestKind::CommitFileUpload,
            transfer_id,
            parts: Vec::new(),
        }
    }

    pub fn abort_request(transfer_id: Uuid) -> AbortFileTransferRequest {
        AbortFileTransferRequest {
            protocol_version: FILE_PROTOCOL_VERSION,
            message_type: AbortFileTransferRequestKind::AbortFileTransfer,
            transfer_id,
        }
    }

    pub fn staging_key(&self, transfer_id: Uuid) -> String {
        format!("v1/staging/{}/{transfer_id}", self.collection_id)
    }

    pub fn committed_key(&self, transfer_id: Uuid) -> String {
        format!("v1/blobs/{}/{transfer_id}", self.collection_id)
    }
}
