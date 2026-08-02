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

pub(super) async fn authenticate_in_for_sync(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
    token: &str,
    required_operation: &str,
    request_origin: Option<&str>,
) -> ApiResult<Replica> {
    let row = sqlx::query(
        r#"SELECT id, purpose, mode, allowed_types, contract_scope, full_collection, allowed_operations, file_capability,
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

pub(super) async fn persist_live_record(
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

pub(super) async fn store_rejection(
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

pub(super) async fn store_receipt(
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
