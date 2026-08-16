use super::*;

#[derive(Debug, Clone)]
pub(super) struct StoredAccountLimits {
    pub entitlement_revision: u64,
    pub limits: ProviderAccountLimits,
}

impl HostedProvider {
    pub async fn upsert_account(
        &self,
        account_id: Uuid,
        entitlement_revision: u64,
        limits: ProviderAccountLimits,
    ) -> ApiResult<ProviderAccountUsage> {
        if account_id.is_nil() || entitlement_revision == 0 {
            return Err(ApiError::bad_request(
                "invalid_provider_account",
                "Hosted account identity and entitlement revision must be valid.",
            ));
        }
        self.validate_account_limits(&limits)?;
        let mut transaction = self.pool.begin().await?;
        let existing = sqlx::query(
            r#"SELECT entitlement_revision, max_live_storage_bytes,
                      max_retained_file_bytes, max_document_bytes,
                      max_single_file_bytes, max_mirror_replicas_per_collection,
                      max_application_replicas_per_collection,
                      max_collections, max_files_per_collection
               FROM hosted_provider_accounts WHERE id = $1 FOR UPDATE"#,
        )
        .bind(account_id)
        .fetch_optional(&mut *transaction)
        .await?;
        if let Some(row) = existing {
            let stored = stored_account_limits(&row)?;
            if entitlement_revision < stored.entitlement_revision {
                return Err(ApiError::conflict(
                    "stale_entitlement_revision",
                    "The hosted provider already has a newer account entitlement revision.",
                ));
            }
            if entitlement_revision == stored.entitlement_revision && stored.limits != limits {
                return Err(ApiError::conflict(
                    "entitlement_revision_conflict",
                    "The entitlement revision already exists with different limits.",
                ));
            }
            if entitlement_revision > stored.entitlement_revision {
                sqlx::query(
                    r#"UPDATE hosted_provider_accounts SET
                         entitlement_revision = $2,
                         max_live_storage_bytes = $3,
                         max_retained_file_bytes = $4,
                         max_document_bytes = $5,
                         max_single_file_bytes = $6,
                         max_mirror_replicas_per_collection = $7,
                         max_application_replicas_per_collection = $8,
                         max_collections = $9,
                         max_files_per_collection = $10,
                         updated_at = now()
                       WHERE id = $1"#,
                )
                .bind(account_id)
                .bind(to_i64(entitlement_revision, "entitlement revision")?)
                .bind(to_i64(
                    limits.hosted_storage_bytes,
                    "account live storage limit",
                )?)
                .bind(to_i64(
                    limits.retained_file_bytes,
                    "account retained storage limit",
                )?)
                .bind(to_i64(limits.max_document_bytes, "document limit")?)
                .bind(to_i64(limits.max_single_file_bytes, "file limit")?)
                .bind(to_i64(
                    limits.max_mirror_replicas_per_collection,
                    "mirror replica limit",
                )?)
                .bind(to_i64(
                    limits.max_application_replicas_per_collection,
                    "application replica limit",
                )?)
                .bind(to_i64(limits.max_hosted_collections, "collection limit")?)
                .bind(to_i64(limits.max_files_per_collection, "file count limit")?)
                .execute(&mut *transaction)
                .await?;
            }
        } else {
            sqlx::query(
                r#"INSERT INTO hosted_provider_accounts
                     (id, entitlement_revision, max_live_storage_bytes,
                      max_retained_file_bytes, max_document_bytes,
                      max_single_file_bytes, max_mirror_replicas_per_collection,
                      max_application_replicas_per_collection,
                      max_collections, max_files_per_collection)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)"#,
            )
            .bind(account_id)
            .bind(to_i64(entitlement_revision, "entitlement revision")?)
            .bind(to_i64(
                limits.hosted_storage_bytes,
                "account live storage limit",
            )?)
            .bind(to_i64(
                limits.retained_file_bytes,
                "account retained storage limit",
            )?)
            .bind(to_i64(limits.max_document_bytes, "document limit")?)
            .bind(to_i64(limits.max_single_file_bytes, "file limit")?)
            .bind(to_i64(
                limits.max_mirror_replicas_per_collection,
                "mirror replica limit",
            )?)
            .bind(to_i64(
                limits.max_application_replicas_per_collection,
                "application replica limit",
            )?)
            .bind(to_i64(limits.max_hosted_collections, "collection limit")?)
            .bind(to_i64(limits.max_files_per_collection, "file count limit")?)
            .execute(&mut *transaction)
            .await?;
        }
        let usage = account_usage(&mut transaction, account_id).await?;
        transaction.commit().await?;
        Ok(usage)
    }

    pub async fn account_usage(&self, account_id: Uuid) -> ApiResult<ProviderAccountUsage> {
        let mut transaction = self.pool.begin().await?;
        let usage = account_usage(&mut transaction, account_id).await?;
        transaction.commit().await?;
        Ok(usage)
    }

    pub async fn reconcile_collection_account(
        &self,
        account_id: Uuid,
        collection_id: Uuid,
    ) -> ApiResult<()> {
        let mut transaction = self.pool.begin().await?;
        // Serialize against receipt admission/eviction so every live receipt
        // moves into the reconciled account's quota counter atomically.
        sqlx::query(
            "SELECT pg_advisory_xact_lock(hashtextextended('mdbase-hosted-query-receipt-quota-v1', 0))",
        )
        .execute(&mut *transaction)
        .await?;
        sqlx::query("SET LOCAL mdbase.quota_reconciliation = 'on'")
            .execute(&mut *transaction)
            .await?;
        let account = load_account_limits(&mut transaction, account_id, false).await?;
        let result = sqlx::query(
            r#"UPDATE hosted_provider_collections SET
                 account_id = $2,
                 max_content_bytes = $3,
                 max_document_bytes = $4,
                 max_mirror_replicas = $5,
                 max_application_replicas = $6,
                 max_files = $7,
                 max_file_bytes = $3,
                 max_stored_file_bytes = $8,
                 max_single_file_bytes = $9,
                 updated_at = now()
               WHERE id = $1 AND state <> 'deleting'
                 AND (account_id IS NULL OR account_id = $2)"#,
        )
        .bind(collection_id)
        .bind(account_id)
        .bind(to_i64(
            account.limits.hosted_storage_bytes,
            "live storage limit",
        )?)
        .bind(to_i64(account.limits.max_document_bytes, "document limit")?)
        .bind(to_i64(
            account.limits.max_mirror_replicas_per_collection,
            "mirror replica limit",
        )?)
        .bind(to_i64(
            account.limits.max_application_replicas_per_collection,
            "application replica limit",
        )?)
        .bind(to_i64(
            account.limits.max_files_per_collection,
            "file count limit",
        )?)
        .bind(to_i64(
            account.limits.retained_file_bytes,
            "retained file limit",
        )?)
        .bind(to_i64(
            account.limits.max_single_file_bytes,
            "single file limit",
        )?)
        .execute(&mut *transaction)
        .await?;
        if result.rows_affected() == 0 {
            return Err(ApiError::conflict(
                "hosted_collection_account_conflict",
                "The hosted collection is missing or belongs to another account.",
            ));
        }
        sqlx::query(
            r#"UPDATE hosted_provider_query_page_receipts
               SET account_id = $2
               WHERE collection_id = $1 AND account_id IS DISTINCT FROM $2"#,
        )
        .bind(collection_id)
        .bind(account_id)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(())
    }

    pub(super) fn validate_account_limits(&self, limits: &ProviderAccountLimits) -> ApiResult<()> {
        let valid = limits.hosted_storage_bytes > 0
            && limits.retained_file_bytes >= limits.hosted_storage_bytes
            && limits.max_document_bytes > 0
            && limits.max_single_file_bytes > 0
            && limits.max_mirror_replicas_per_collection > 0
            && limits.max_application_replicas_per_collection > 0
            && limits.max_hosted_collections > 0
            && limits.max_files_per_collection > 0
            && limits.hosted_storage_bytes <= self.limits.max_bytes_per_collection
            && limits.hosted_storage_bytes <= self.limits.max_file_bytes_per_collection
            && limits.retained_file_bytes <= self.limits.max_stored_file_bytes_per_collection
            && limits.max_document_bytes <= self.limits.max_bytes_per_document
            && limits.max_single_file_bytes <= self.limits.max_bytes_per_file
            && limits.max_mirror_replicas_per_collection
                <= self.limits.max_mirror_replicas_per_collection
            && limits.max_application_replicas_per_collection
                <= self.limits.max_application_replicas_per_collection
            && limits.max_files_per_collection <= self.limits.max_files_per_collection;
        if !valid {
            return Err(ApiError::bad_request(
                "invalid_account_limits",
                "Hosted account limits are invalid or exceed provider safety ceilings.",
            ));
        }
        Ok(())
    }
}

pub(super) async fn load_account_limits(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
    lock: bool,
) -> ApiResult<StoredAccountLimits> {
    let sql = if lock {
        r#"SELECT entitlement_revision, max_live_storage_bytes,
                  max_retained_file_bytes, max_document_bytes,
                  max_single_file_bytes, max_mirror_replicas_per_collection,
                  max_application_replicas_per_collection,
                  max_collections, max_files_per_collection
           FROM hosted_provider_accounts WHERE id = $1 FOR UPDATE"#
    } else {
        r#"SELECT entitlement_revision, max_live_storage_bytes,
                  max_retained_file_bytes, max_document_bytes,
                  max_single_file_bytes, max_mirror_replicas_per_collection,
                  max_application_replicas_per_collection,
                  max_collections, max_files_per_collection
           FROM hosted_provider_accounts WHERE id = $1"#
    };
    let row = sqlx::query(sql)
        .bind(account_id)
        .fetch_optional(&mut **transaction)
        .await?
        .ok_or_else(|| {
            ApiError::not_found(
                "hosted_account_not_found",
                "Hosted storage account not found.",
            )
        })?;
    stored_account_limits(&row)
}

fn stored_account_limits(row: &PgRow) -> ApiResult<StoredAccountLimits> {
    Ok(StoredAccountLimits {
        entitlement_revision: number(row.get("entitlement_revision"), "entitlement revision")?,
        limits: ProviderAccountLimits {
            hosted_storage_bytes: number(row.get("max_live_storage_bytes"), "live storage limit")?,
            retained_file_bytes: number(
                row.get("max_retained_file_bytes"),
                "retained storage limit",
            )?,
            max_document_bytes: number(row.get("max_document_bytes"), "document limit")?,
            max_single_file_bytes: number(row.get("max_single_file_bytes"), "file limit")?,
            max_mirror_replicas_per_collection: number(
                row.get("max_mirror_replicas_per_collection"),
                "mirror replica limit",
            )?,
            max_application_replicas_per_collection: number(
                row.get("max_application_replicas_per_collection"),
                "application replica limit",
            )?,
            max_hosted_collections: number(row.get("max_collections"), "collection limit")?,
            max_files_per_collection: number(
                row.get("max_files_per_collection"),
                "file count limit",
            )?,
        },
    })
}

async fn account_usage(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: Uuid,
) -> ApiResult<ProviderAccountUsage> {
    let row = sqlx::query(
        r#"SELECT entitlement_revision, max_live_storage_bytes,
                  max_retained_file_bytes, max_document_bytes,
                  max_single_file_bytes, max_mirror_replicas_per_collection,
                  max_application_replicas_per_collection,
                  max_collections, max_files_per_collection,
                  collection_count, live_content_bytes, live_file_bytes,
                  retained_file_bytes
           FROM hosted_provider_accounts WHERE id = $1"#,
    )
    .bind(account_id)
    .fetch_optional(&mut **transaction)
    .await?
    .ok_or_else(|| {
        ApiError::not_found(
            "hosted_account_not_found",
            "Hosted storage account not found.",
        )
    })?;
    let stored = stored_account_limits(&row)?;
    Ok(ProviderAccountUsage {
        account_id,
        entitlement_revision: stored.entitlement_revision,
        collection_count: number(row.get("collection_count"), "collection count")?,
        live_content_bytes: number(row.get("live_content_bytes"), "content size")?,
        live_file_bytes: number(row.get("live_file_bytes"), "file size")?,
        retained_file_bytes: number(row.get("retained_file_bytes"), "retained file size")?,
        limits: stored.limits,
    })
}
