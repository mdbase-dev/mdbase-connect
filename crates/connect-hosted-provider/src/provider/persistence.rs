use super::*;
pub(super) enum DatabaseKeyError {
    Database(sqlx::Error),
    Invalid(ApiError),
}

pub(super) async fn verify_database_key(
    pool: &PgPool,
    crypto: &ProviderCrypto,
) -> Result<(), DatabaseKeyError> {
    let candidate = crypto
        .create_key_check()
        .await
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
        .await
        .map_err(DatabaseKeyError::Invalid)
}

pub(super) async fn verify_stored_database_key(
    pool: &PgPool,
    crypto: &ProviderCrypto,
) -> ApiResult<()> {
    let key_check: Vec<u8> =
        sqlx::query_scalar("SELECT key_check FROM hosted_provider_metadata WHERE singleton = true")
            .fetch_one(pool)
            .await?;
    crypto.verify_key_check(&key_check).await
}

pub(super) async fn authenticate_in(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
    token: &str,
    purpose: ReplicaPurpose,
) -> ApiResult<Replica> {
    let row = sqlx::query(
        r#"SELECT id, purpose, mode, allowed_types, contract_scope, full_collection, allowed_operations, file_capability,
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

/// Recheck a previously authenticated full-collection writer while holding a
/// database lock for the duration of its commit transaction. This closes the
/// authorize/commit race for resource and catalogue mutations: revocation,
/// expiry, mode changes, operation narrowing, or a scope-epoch change all fail
/// closed before collection state is locked or modified.
pub(super) async fn reauthorize_full_collection_mutation_in(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
    expected: &Replica,
    operation: &str,
) -> ApiResult<()> {
    let authorized: bool = sqlx::query_scalar(
        r#"SELECT EXISTS (
             SELECT 1 FROM hosted_provider_replicas
             WHERE collection_id = $1 AND id = $2 AND purpose = 'application'
               AND revoked_at IS NULL AND token_expires_at > now()
               AND mode = 'read_write' AND full_collection = true
               AND scope_epoch = $3 AND $4 = ANY(allowed_operations)
             FOR SHARE
           )"#,
    )
    .bind(collection_id)
    .bind(expected.id)
    .bind(to_i64(expected.scope_epoch, "scope epoch")?)
    .bind(operation)
    .fetch_one(&mut **transaction)
    .await?;
    if !authorized {
        return Err(ApiError::forbidden(
            "scope_changed",
            "The application authorization changed before the mutation could commit.",
        ));
    }
    Ok(())
}

/// Recheck sync authorization while locking the replica through the mutation
/// commit. Journal admission deliberately occurs before this check, so a
/// revoked or expired request is durably rejected without applying its effect.
pub(super) async fn reauthorize_sync_mutation_in(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
    expected_replica_id: Uuid,
    presented_token_hash: &[u8],
    required_operation: &str,
    request_origin: Option<&str>,
) -> ApiResult<Replica> {
    let row = sqlx::query(
        r#"SELECT id, purpose, mode, allowed_types, contract_scope, full_collection,
                  allowed_operations, operation_transport_protocol,
                  operation_transport_recovery_protocols, file_capability,
                  allowed_origin, proof_public_key, grant_id, scope_epoch
           FROM hosted_provider_replicas
           WHERE collection_id = $1 AND id = $2
             AND token_hash = $3
             AND revoked_at IS NULL AND token_expires_at > now()
           FOR UPDATE"#,
    )
    .bind(collection_id)
    .bind(expected_replica_id)
    .bind(presented_token_hash)
    .fetch_optional(&mut **transaction)
    .await?;
    let replica = replica_from_row(row)?;
    authorize_sync_access(&replica, required_operation, request_origin)?;
    Ok(replica)
}

pub(super) fn replica_from_row(row: Option<sqlx::postgres::PgRow>) -> ApiResult<Replica> {
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
        contract_scope: serde_json::from_value(row.get("contract_scope")).map_err(|error| {
            ApiError::internal(format!("Stored contract scope is invalid: {error}"))
        })?,
        full_collection: row.get("full_collection"),
        allowed_operations: row.get("allowed_operations"),
        operation_transport_protocol: row
            .try_get::<Option<i32>, _>("operation_transport_protocol")
            .unwrap_or(None)
            .map(|version| version as u32),
        operation_transport_recovery_protocols: row
            .try_get::<Vec<i32>, _>("operation_transport_recovery_protocols")
            .unwrap_or_default()
            .into_iter()
            .map(|version| version as u32)
            .collect(),
        file_capability: row
            .get::<Option<Value>, _>("file_capability")
            .map(serde_json::from_value)
            .transpose()
            .map_err(|error| {
                ApiError::internal(format!("Stored file capability is invalid: {error}"))
            })?,
        allowed_origin: row.get("allowed_origin"),
        proof_public_key: row.get("proof_public_key"),
        grant_id: row.get("grant_id"),
        scope_epoch: number(row.get::<i64, _>("scope_epoch"), "scope epoch")?,
    })
}

pub(super) async fn load_resource_documents(
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

pub(super) async fn load_hosted_resource_documents(
    transaction: &mut Transaction<'_, Postgres>,
    crypto: &ProviderCrypto,
    data_key: &[u8; 32],
    collection_id: Uuid,
) -> ApiResult<Vec<mdbase::runtime::HostedResourceDocument>> {
    let rows = sqlx::query(
        "SELECT path, kind, revision, document_ciphertext FROM hosted_provider_resources WHERE collection_id = $1 ORDER BY path",
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
            let kind = match row.get::<String, _>("kind").as_str() {
                "configuration" => mdbase::runtime::HostedResourceKind::Configuration,
                "lock" => mdbase::runtime::HostedResourceKind::Lock,
                "contract" => mdbase::runtime::HostedResourceKind::Contract,
                "schema" => mdbase::runtime::HostedResourceKind::Schema,
                "type" => mdbase::runtime::HostedResourceKind::Type,
                "view" => mdbase::runtime::HostedResourceKind::View,
                _ => {
                    return Err(ApiError::internal(
                        "The hosted resource has an unsupported stored kind.",
                    ))
                }
            };
            Ok(mdbase::runtime::HostedResourceDocument {
                path,
                kind,
                revision: row.get("revision"),
                document,
            })
        })
        .collect()
}

pub(super) async fn load_sync_resource_documents(
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

pub(super) async fn load_records(
    transaction: &mut Transaction<'_, Postgres>,
    crypto: &ProviderCrypto,
    data_key: &[u8; 32],
    collection_id: Uuid,
) -> ApiResult<BTreeMap<Uuid, PersistedRecord>> {
    admit_legacy_working_set(transaction, collection_id).await?;
    let started = Instant::now();
    let rows = sqlx::query(
        r#"SELECT record_id, sequence, payload_ciphertext
           FROM hosted_provider_records WHERE collection_id = $1 ORDER BY record_id"#,
    )
    .bind(collection_id)
    .fetch_all(&mut **transaction)
    .await?;
    let scanned_records = rows.len() as u64;
    let mut ciphertext_bytes = 0_u64;
    let mut records = BTreeMap::new();
    for row in rows {
        let record_id = row.get("record_id");
        let sequence = number(row.get::<i64, _>("sequence"), "record sequence")?;
        let ciphertext: Vec<u8> = row.get("payload_ciphertext");
        ciphertext_bytes = ciphertext_bytes.saturating_add(ciphertext.len() as u64);
        let persisted: PersistedRecord = crypto.decrypt_json(
            data_key,
            &ciphertext,
            &current_record_aad(collection_id, record_id, sequence),
        )?;
        if persisted.record_id != record_id {
            return Err(ApiError::internal(
                "The hosted encrypted record identity does not match its metadata.",
            ));
        }
        records.insert(record_id, persisted);
    }
    tracing::info!(
        target: "mdbase_connect::metrics",
        metric = "hosted_working_set_load",
        scanned_records,
        ciphertext_bytes,
        elapsed_ms = started.elapsed().as_millis() as u64,
        "privacy-safe hosted provider metric"
    );
    Ok(records)
}

async fn admit_legacy_working_set(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
) -> ApiResult<()> {
    let containment = &crate::HostedExecutionBudgetManifest::published().temporary_containment;
    let collection_bytes: i64 =
        sqlx::query_scalar("SELECT content_bytes FROM hosted_provider_collections WHERE id = $1")
            .bind(collection_id)
            .fetch_one(&mut **transaction)
            .await?;
    let collection_bytes = number(collection_bytes, "collection content size")?;
    // The legacy payload retains the exact document, parsed body/frontmatter, and
    // path maps. Reserve three canonical-content bytes for each retained plaintext
    // byte and divide the process budget across every admitted collection slot.
    let canonical_content_limit = legacy_canonical_content_limit(containment);
    if collection_bytes > canonical_content_limit {
        tracing::warn!(
            target: "mdbase_connect::metrics",
            metric = "hosted_working_set_admission_rejected",
            budget_kind = "scan",
            collection_bytes,
            canonical_content_limit,
            "privacy-safe hosted provider metric"
        );
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "hosted_working_set_capacity",
            "The collection exceeds the temporary compatibility runtime budget.",
        )
        .with_details(json!({ "budget_kind": "scan" })));
    }
    Ok(())
}

fn legacy_canonical_content_limit(containment: &crate::TemporaryExecutionContainment) -> u64 {
    let duplication_factor = 3_u64;
    let slots = containment.working_set_collections_per_process.max(1);
    let per_collection = containment
        .working_set_plaintext_bytes_per_collection
        .checked_div(duplication_factor)
        .unwrap_or(0);
    let per_process = containment
        .working_set_plaintext_bytes_per_process
        .checked_div(slots.saturating_mul(duplication_factor))
        .unwrap_or(0);
    per_collection.min(per_process)
}

pub(super) async fn persist_live_record(
    transaction: &mut Transaction<'_, Postgres>,
    crypto: &ProviderCrypto,
    data_key: &[u8; 32],
    collection_id: Uuid,
    sequence: u64,
    record: &SyncRecord,
) -> ApiResult<DateTime<Utc>> {
    let payload = record.clone();
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
    let modified_at = Utc::now();
    sqlx::query(
        r#"INSERT INTO hosted_provider_records
             (collection_id, record_id, path_token, revision, types, content_bytes,
              payload_ciphertext, sequence, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
           ON CONFLICT (collection_id, record_id) DO UPDATE SET
             path_token = EXCLUDED.path_token,
             revision = EXCLUDED.revision,
             types = EXCLUDED.types,
             content_bytes = EXCLUDED.content_bytes,
             payload_ciphertext = EXCLUDED.payload_ciphertext,
             sequence = EXCLUDED.sequence,
             updated_at = EXCLUDED.updated_at"#,
    )
    .bind(collection_id)
    .bind(record.record_id)
    .bind(path_token(data_key, &record.path))
    .bind(&record.revision)
    .bind(&record.types)
    .bind(to_i64(record.document.len() as u64, "document size")?)
    .bind(current_ciphertext)
    .bind(sequence_number)
    .bind(modified_at)
    .execute(&mut **transaction)
    .await?;
    sqlx::query(
        r#"INSERT INTO hosted_provider_record_versions
             (collection_id, record_id, sequence, revision, types, payload_ciphertext,
              deleted, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, false, $7)"#,
    )
    .bind(collection_id)
    .bind(record.record_id)
    .bind(sequence_number)
    .bind(&record.revision)
    .bind(&record.types)
    .bind(version_ciphertext)
    .bind(modified_at)
    .execute(&mut **transaction)
    .await?;
    Ok(modified_at)
}

pub(super) async fn persist_deleted_record(
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

pub(super) struct SyncJournalContext<'a> {
    pub(super) provider: &'a HostedProvider,
    pub(super) lease: &'a mutation_journal::HostedMutationLease,
    pub(super) public_result: bool,
}

pub(super) async fn store_rejection(
    mut transaction: Transaction<'_, Postgres>,
    _crypto: &ProviderCrypto,
    data_key: &[u8; 32],
    mutation: &SyncMutation,
    journal: &SyncJournalContext<'_>,
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
    store_receipt(&mut transaction, data_key, journal, &receipt, None).await?;
    transaction.commit().await?;
    Ok(receipt)
}

pub(super) async fn store_receipt(
    transaction: &mut Transaction<'_, Postgres>,
    data_key: &[u8; 32],
    journal: &SyncJournalContext<'_>,
    receipt: &SyncMutationReceipt,
    semantic_result: Option<&OperationResult>,
) -> ApiResult<()> {
    journal
        .provider
        .store_sync_effect_in(
            transaction,
            data_key,
            journal.lease,
            receipt,
            semantic_result,
            journal.public_result,
        )
        .await
}
