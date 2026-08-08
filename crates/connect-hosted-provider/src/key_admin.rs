use std::collections::BTreeMap;

use futures_util::TryStreamExt;
use serde::Serialize;
use sqlx::{postgres::PgPoolOptions, PgPool, Row};
use uuid::Uuid;

use crate::{
    error::{ApiError, ApiResult},
    key_wrapping::{KeyWrapErrorKind, KeyWrapInspection, KeyWrappingRuntime},
    provider::hosted_migrator,
    ProviderCrypto,
};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct KeyWrapInventory {
    pub active_key_ref: String,
    pub collections_total: u64,
    pub collections_active: u64,
    pub collections_legacy: u64,
    pub collections_managed_other: u64,
    pub collections_invalid: u64,
    pub managed_key_refs: BTreeMap<String, u64>,
    pub provider_key_check: String,
}

impl KeyWrapInventory {
    pub fn migration_complete(&self) -> bool {
        self.collections_invalid == 0
            && self.collections_total == self.collections_active
            && self.provider_key_check == active_key_label(&self.active_key_ref)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct KeyRewrapOptions {
    pub dry_run: bool,
    pub finalize_key_check: bool,
    pub max_rows: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct KeyRewrapReport {
    pub dry_run: bool,
    pub scanned: u64,
    pub would_rewrap: u64,
    pub rewrapped: u64,
    pub already_active: u64,
    pub concurrent_changes: u64,
    pub key_check_finalized: bool,
    pub migration_complete: bool,
    pub before: KeyWrapInventory,
    pub after: KeyWrapInventory,
}

pub struct HostedKeyAdmin {
    pool: PgPool,
    crypto: ProviderCrypto,
}

impl HostedKeyAdmin {
    pub async fn connect(database_url: &str, crypto: ProviderCrypto) -> ApiResult<Self> {
        let pool = PgPoolOptions::new()
            .max_connections(2)
            .acquire_timeout(std::time::Duration::from_secs(5))
            .idle_timeout(std::time::Duration::from_secs(10 * 60))
            .max_lifetime(std::time::Duration::from_secs(30 * 60))
            .after_connect(|connection, _metadata| {
                Box::pin(async move {
                    sqlx::query("SET statement_timeout = 300000")
                        .execute(&mut *connection)
                        .await?;
                    sqlx::query("SET lock_timeout = 30000")
                        .execute(&mut *connection)
                        .await?;
                    sqlx::query("SET idle_in_transaction_session_timeout = 30000")
                        .execute(&mut *connection)
                        .await?;
                    Ok(())
                })
            })
            .connect(database_url)
            .await?;
        hosted_migrator().run(&pool).await.map_err(|error| {
            tracing::error!(%error, "hosted key administration migration check failed");
            ApiError::internal("The hosted provider database migration check failed.")
        })?;
        let key_check: Vec<u8> = sqlx::query_scalar(
            "SELECT key_check FROM hosted_provider_metadata WHERE singleton = true",
        )
        .fetch_one(&pool)
        .await?;
        crypto.verify_key_check(&key_check).await?;
        Ok(Self { pool, crypto })
    }

    pub async fn inspect(&self) -> ApiResult<KeyWrapInventory> {
        let key_check: Vec<u8> = sqlx::query_scalar(
            "SELECT key_check FROM hosted_provider_metadata WHERE singleton = true",
        )
        .fetch_one(&self.pool)
        .await?;
        let mut inventory = empty_inventory(self.crypto.active_key_ref(), &key_check);
        let mut rows = sqlx::query_scalar::<_, Vec<u8>>(
            "SELECT wrapped_data_key FROM hosted_provider_collections",
        )
        .fetch(&self.pool);
        while let Some(value) = rows.try_next().await? {
            add_to_inventory(&mut inventory, &value);
        }
        Ok(inventory)
    }

    pub async fn rewrap(&self, options: KeyRewrapOptions) -> ApiResult<KeyRewrapReport> {
        if options.max_rows == 0 || options.max_rows > 1_000_000 {
            return Err(ApiError::bad_request(
                "invalid_rewrap_limit",
                "The hosted key rewrap row limit must be between 1 and 1000000.",
            ));
        }
        if options.dry_run && options.finalize_key_check {
            return Err(ApiError::bad_request(
                "invalid_rewrap_options",
                "A dry run cannot finalize the provider key check.",
            ));
        }
        let before = self.inspect().await?;
        if before.collections_invalid > 0 {
            return Err(ApiError::internal(
                "Stored key envelopes are invalid; rewrap refused before mutation.",
            ));
        }
        let mut cursor: Option<Uuid> = None;
        let mut scanned = 0;
        let mut would_rewrap = 0;
        let mut rewrapped = 0;
        let mut already_active = 0;
        let mut concurrent_changes = 0;
        while scanned < options.max_rows {
            let mut transaction = self.pool.begin().await?;
            let row = sqlx::query(
                r#"SELECT id, wrapped_data_key
                   FROM hosted_provider_collections
                   WHERE ($1::uuid IS NULL OR id > $1)
                   ORDER BY id
                   LIMIT 1
                   FOR UPDATE SKIP LOCKED"#,
            )
            .bind(cursor)
            .fetch_optional(&mut *transaction)
            .await?;
            let Some(row) = row else {
                transaction.commit().await?;
                break;
            };
            let collection_id: Uuid = row.get("id");
            let original: Vec<u8> = row.get("wrapped_data_key");
            cursor = Some(collection_id);
            scanned += 1;
            match KeyWrappingRuntime::inspect(&original) {
                Ok(KeyWrapInspection::AwsKmsV1 { key_ref })
                    if key_ref == self.crypto.active_key_ref() =>
                {
                    already_active += 1;
                    if options.dry_run {
                        self.crypto
                            .unwrap_data_key(&original, collection_id)
                            .await?;
                        transaction.rollback().await?;
                    } else {
                        transaction.commit().await?;
                    }
                    continue;
                }
                Ok(_) => {}
                Err(_) => {
                    transaction.rollback().await?;
                    return Err(ApiError::internal(
                        "A stored key envelope became invalid during rewrap.",
                    ));
                }
            }
            let data_key = self
                .crypto
                .unwrap_data_key(&original, collection_id)
                .await?;
            let replacement = self.crypto.wrap_data_key(&data_key, collection_id).await?;
            if options.dry_run {
                would_rewrap += 1;
                transaction.rollback().await?;
                continue;
            }
            let updated = sqlx::query(
                "UPDATE hosted_provider_collections SET wrapped_data_key = $2, updated_at = now() WHERE id = $1 AND wrapped_data_key = $3",
            )
            .bind(collection_id)
            .bind(replacement)
            .bind(original)
            .execute(&mut *transaction)
            .await?;
            if updated.rows_affected() == 1 {
                rewrapped += 1;
            } else {
                concurrent_changes += 1;
            }
            transaction.commit().await?;
        }

        let mut after = self.inspect().await?;
        let all_collections_active =
            after.collections_invalid == 0 && after.collections_total == after.collections_active;
        let mut key_check_finalized = false;
        if options.finalize_key_check {
            if !all_collections_active {
                return Err(ApiError::conflict(
                    "key_rewrap_incomplete",
                    "The provider key check cannot change while any collection uses another wrapper.",
                ));
            }
            let replacement = self.crypto.create_key_check().await?;
            sqlx::query(
                "UPDATE hosted_provider_metadata SET key_check = $1 WHERE singleton = true",
            )
            .bind(&replacement)
            .execute(&self.pool)
            .await?;
            self.crypto.verify_key_check(&replacement).await?;
            key_check_finalized = true;
            after = self.inspect().await?;
        }
        Ok(KeyRewrapReport {
            dry_run: options.dry_run,
            scanned,
            would_rewrap,
            rewrapped,
            already_active,
            concurrent_changes,
            key_check_finalized,
            migration_complete: after.migration_complete(),
            before,
            after,
        })
    }
}

#[cfg(test)]
fn summarize_inventory<'a>(
    active_key_ref: &str,
    collections: impl Iterator<Item = &'a [u8]>,
    key_check: &[u8],
) -> KeyWrapInventory {
    let mut inventory = empty_inventory(active_key_ref, key_check);
    for value in collections {
        add_to_inventory(&mut inventory, value);
    }
    inventory
}

fn empty_inventory(active_key_ref: &str, key_check: &[u8]) -> KeyWrapInventory {
    KeyWrapInventory {
        active_key_ref: active_key_ref.to_string(),
        collections_total: 0,
        collections_active: 0,
        collections_legacy: 0,
        collections_managed_other: 0,
        collections_invalid: 0,
        managed_key_refs: BTreeMap::new(),
        provider_key_check: inspection_label(key_check),
    }
}

fn add_to_inventory(inventory: &mut KeyWrapInventory, value: &[u8]) {
    inventory.collections_total += 1;
    match KeyWrappingRuntime::inspect(value) {
        Ok(KeyWrapInspection::LocalAes256GcmV1) => inventory.collections_legacy += 1,
        Ok(KeyWrapInspection::AwsKmsV1 { key_ref }) => {
            *inventory
                .managed_key_refs
                .entry(key_ref.clone())
                .or_insert(0) += 1;
            if key_ref == inventory.active_key_ref {
                inventory.collections_active += 1;
            } else {
                inventory.collections_managed_other += 1;
            }
        }
        Err(_) => inventory.collections_invalid += 1,
    }
}

fn inspection_label(value: &[u8]) -> String {
    match KeyWrappingRuntime::inspect(value) {
        Ok(KeyWrapInspection::LocalAes256GcmV1) => "local-aes-256-gcm-v1".to_string(),
        Ok(KeyWrapInspection::AwsKmsV1 { key_ref }) => format!("aws-kms-v1:{key_ref}"),
        Err(error) => format!("invalid:{}", error_kind_label(error.kind)),
    }
}

fn active_key_label(active_key_ref: &str) -> String {
    if active_key_ref == "local-aes-256-gcm-v1" {
        active_key_ref.to_string()
    } else {
        format!("aws-kms-v1:{active_key_ref}")
    }
}

fn error_kind_label(kind: KeyWrapErrorKind) -> &'static str {
    match kind {
        KeyWrapErrorKind::AccessDenied => "access_denied",
        KeyWrapErrorKind::Configuration => "configuration",
        KeyWrapErrorKind::Disabled => "disabled",
        KeyWrapErrorKind::InvalidCiphertext => "invalid_ciphertext",
        KeyWrapErrorKind::InvalidEnvelope => "invalid_envelope",
        KeyWrapErrorKind::InvalidResponse => "invalid_response",
        KeyWrapErrorKind::Throttled => "throttled",
        KeyWrapErrorKind::Timeout => "timeout",
        KeyWrapErrorKind::Unavailable => "unavailable",
        KeyWrapErrorKind::UnsupportedEnvelope => "unsupported_envelope",
        KeyWrapErrorKind::WrongKey => "wrong_key",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{KeyWrappingBackend, KeyWrappingConfig, LegacyKeyWrapper};
    use std::time::Duration;

    #[test]
    fn inventory_counts_invalid_and_legacy_values_without_identifiers() {
        let inventory = summarize_inventory(
            "arn:aws:kms:test:key/mrk-active",
            [vec![1, 2, 3], vec![9, 9, 9]].iter().map(Vec::as_slice),
            &[1, 2, 3],
        );
        assert_eq!(inventory.collections_total, 2);
        assert_eq!(inventory.collections_legacy, 1);
        assert_eq!(inventory.collections_invalid, 1);
        assert_eq!(inventory.provider_key_check, "local-aes-256-gcm-v1");
        let serialized = serde_json::to_string(&inventory).unwrap();
        assert!(!serialized.contains("collection_id"));
    }

    #[tokio::test]
    #[ignore = "requires MDBASE_TEST_KEY_ADMIN_DATABASE_URL, MDBASE_TEST_KMS_KEY_ID, and AWS credentials"]
    async fn live_key_admin_rewraps_a_legacy_database_to_aws_kms() {
        let database_url = std::env::var("MDBASE_TEST_KEY_ADMIN_DATABASE_URL").unwrap();
        let kms_key_id = std::env::var("MDBASE_TEST_KMS_KEY_ID").unwrap();
        let legacy_value = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        let collection_id = Uuid::parse_str("01933333-3333-7333-8333-333333333333").unwrap();
        let data_key = [0x43_u8; 32];

        let pool = PgPoolOptions::new()
            .max_connections(2)
            .connect(&database_url)
            .await
            .unwrap();
        hosted_migrator().run(&pool).await.unwrap();
        let legacy = ProviderCrypto::with_key_wrapping(
            KeyWrappingRuntime::legacy(LegacyKeyWrapper::from_base64(legacy_value).unwrap()),
            "staging",
        )
        .unwrap();
        let key_check = legacy.create_key_check().await.unwrap();
        let wrapped_data_key = legacy
            .wrap_data_key(&data_key, collection_id)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO hosted_provider_metadata (singleton, key_check) VALUES (true, $1)",
        )
        .bind(key_check)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r#"INSERT INTO hosted_provider_collections
               (id, template, spec_version, max_records, max_content_bytes,
                max_document_bytes, max_mirror_replicas,
                max_application_replicas, resource_revision,
                wrapped_data_key, resources_ciphertext)
               VALUES ($1, 'mdbase', '0.3', 100, 1000000, 100000, 10, 50,
                       'test-resource-revision', $2, $3)"#,
        )
        .bind(collection_id)
        .bind(wrapped_data_key)
        .bind(vec![0_u8; 32])
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;

        let migrating_crypto = managed_crypto(&kms_key_id, Some(legacy_value.to_string())).await;
        let admin = HostedKeyAdmin::connect(&database_url, migrating_crypto)
            .await
            .unwrap();
        let before = admin.inspect().await.unwrap();
        assert_eq!(before.collections_legacy, 1);
        assert!(!before.migration_complete());
        let dry_run = admin
            .rewrap(KeyRewrapOptions {
                dry_run: true,
                finalize_key_check: false,
                max_rows: 10,
            })
            .await
            .unwrap();
        assert_eq!(dry_run.scanned, 1);
        assert_eq!(dry_run.would_rewrap, 1);
        assert_eq!(dry_run.rewrapped, 0);
        let report = admin
            .rewrap(KeyRewrapOptions {
                dry_run: false,
                finalize_key_check: true,
                max_rows: 10,
            })
            .await
            .unwrap();
        assert_eq!(report.rewrapped, 1);
        assert_eq!(report.would_rewrap, 0);
        assert!(report.key_check_finalized);
        assert!(report.migration_complete);
        drop(admin);

        let kms_only_crypto = managed_crypto(&kms_key_id, None).await;
        let kms_only_admin = HostedKeyAdmin::connect(&database_url, kms_only_crypto.clone())
            .await
            .unwrap();
        assert!(kms_only_admin.inspect().await.unwrap().migration_complete());
        let repeated = kms_only_admin
            .rewrap(KeyRewrapOptions {
                dry_run: false,
                finalize_key_check: true,
                max_rows: 10,
            })
            .await
            .unwrap();
        assert_eq!(repeated.rewrapped, 0);
        assert_eq!(repeated.already_active, 1);
        assert!(repeated.migration_complete);
        let stored: Vec<u8> = sqlx::query_scalar(
            "SELECT wrapped_data_key FROM hosted_provider_collections WHERE id = $1",
        )
        .bind(collection_id)
        .fetch_one(&kms_only_admin.pool)
        .await
        .unwrap();
        assert_eq!(
            kms_only_crypto
                .unwrap_data_key(&stored, collection_id)
                .await
                .unwrap()
                .as_ref(),
            &data_key
        );
    }

    async fn managed_crypto(key_id: &str, legacy_master_key: Option<String>) -> ProviderCrypto {
        let runtime = KeyWrappingConfig {
            backend: KeyWrappingBackend::AwsKms,
            environment: "staging".to_string(),
            legacy_master_key,
            kms_key_id: Some(key_id.to_string()),
            kms_region: Some("ap-southeast-1".to_string()),
            kms_max_attempts: 3,
            kms_timeout: Duration::from_secs(10),
            cache_entries: 0,
            cache_ttl: Duration::ZERO,
        }
        .build()
        .await
        .unwrap();
        ProviderCrypto::with_key_wrapping(runtime, "staging").unwrap()
    }
}
