use super::*;
use mdbase_connect_protocol::{DeleteFileReceiptKind, MoveFileReceiptKind};
use serde::de::DeserializeOwned;

#[derive(Debug)]
struct StoredFileMutation {
    collection_id: Uuid,
    replica_id: Uuid,
    kind: String,
    request_ciphertext: Vec<u8>,
    receipt_ciphertext: Vec<u8>,
}

struct FileMutationIdentity<'a> {
    data_key: &'a [u8; 32],
    collection_id: Uuid,
    replica_id: Uuid,
    kind: &'static str,
    mutation_id: Uuid,
}

impl HostedProvider {
    pub async fn move_file(
        &self,
        collection_id: Uuid,
        token: &str,
        request: MoveFileRequest,
        request_origin: Option<&str>,
    ) -> ApiResult<MoveFileReceipt> {
        require_lifecycle_request(request.protocol_version, request.mutation_id)?;
        validate_hosted_file_path(&request.from_path)?;
        validate_hosted_file_path(&request.path)?;
        if request.update_references {
            return Err(ApiError::conflict(
                "reference_updates_unsupported",
                "Atomic Markdown reference updates are not available for hosted authorities yet.",
            ));
        }
        let initial_replica = self.authenticate_for_file(collection_id, token).await?;
        authorize_file_access(
            &initial_replica,
            FileAction::Move,
            Some(&request.from_path),
            request_origin,
        )?;
        authorize_file_access(
            &initial_replica,
            FileAction::Move,
            Some(&request.path),
            request_origin,
        )?;

        let mut transaction = self.pool.begin().await?;
        lock_mutation_id(&mut transaction, request.mutation_id).await?;
        let replica = lock_file_replica(&mut transaction, collection_id, token).await?;
        authorize_file_access(
            &replica,
            FileAction::Move,
            Some(&request.from_path),
            request_origin,
        )?;
        authorize_file_access(
            &replica,
            FileAction::Move,
            Some(&request.path),
            request_origin,
        )?;
        let collection = lock_file_collection(&mut transaction, collection_id).await?;
        let data_key = self.collection_key(collection_id, collection.get("wrapped_data_key"))?;
        let mutation = FileMutationIdentity {
            data_key: &data_key,
            collection_id,
            replica_id: replica.id,
            kind: "move",
            mutation_id: request.mutation_id,
        };
        if let Some(receipt) = self
            .replay_file_mutation::<MoveFileRequest, MoveFileReceipt>(
                &mut transaction,
                &mutation,
                &request,
            )
            .await?
        {
            transaction.commit().await?;
            return Ok(receipt);
        }

        let current_row = sqlx::query(
            r#"SELECT file_id, revision, size, object_key, payload_ciphertext, sequence
               FROM hosted_provider_files
               WHERE collection_id = $1 AND file_id = $2 FOR UPDATE"#,
        )
        .bind(collection_id)
        .bind(request.file_id)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or_else(file_not_found)?;
        let (current, object_key, _, _) =
            decode_current_file(&self.crypto, &data_key, collection_id, &current_row)?;
        require_lifecycle_source(&current, &request.from_path, &request.if_revision)?;

        if request.path == request.from_path {
            let receipt = MoveFileReceipt {
                protocol_version: FILE_PROTOCOL_VERSION,
                message_type: MoveFileReceiptKind::FileMoved,
                mutation_id: request.mutation_id,
                file: current,
            };
            self.persist_file_mutation(&mut transaction, &mutation, &request, &receipt)
                .await?;
            transaction.commit().await?;
            return Ok(receipt);
        }

        let destination_token = path_token(&data_key, &portable_file_path_key(&request.path));
        let occupied = sqlx::query_scalar::<_, Uuid>(
            r#"SELECT file_id FROM hosted_provider_files
               WHERE collection_id = $1 AND path_token = $2 FOR UPDATE"#,
        )
        .bind(collection_id)
        .bind(&destination_token)
        .fetch_optional(&mut *transaction)
        .await?;
        if occupied.is_some_and(|file_id| file_id != request.file_id) {
            return Err(ApiError::conflict(
                "path_occupied",
                "Another collection file already uses the destination path.",
            ));
        }

        let sequence = next_file_sequence(&collection)?;
        let revision = format!("file:{}", Uuid::now_v7());
        let mut moved = current.clone();
        moved.path.clone_from(&request.path);
        moved.revision.clone_from(&revision);
        let moved_payload = payload_from_descriptor(&moved);
        let current_ciphertext = self.crypto.encrypt_json(
            &data_key,
            &moved_payload,
            &current_file_aad(collection_id, request.file_id, sequence),
        )?;
        let version_ciphertext = self.crypto.encrypt_json(
            &data_key,
            &moved_payload,
            &file_version_aad(collection_id, request.file_id, sequence),
        )?;
        let before_ciphertext = self.crypto.encrypt_json(
            &data_key,
            &payload_from_descriptor(&current),
            &change_file_aad(collection_id, sequence, "before"),
        )?;
        let after_ciphertext = self.crypto.encrypt_json(
            &data_key,
            &moved_payload,
            &change_file_aad(collection_id, sequence, "after"),
        )?;

        sqlx::query(
            r#"UPDATE hosted_provider_files
               SET path_token = $3, revision = $4, payload_ciphertext = $5,
                   sequence = $6, updated_at = now()
               WHERE collection_id = $1 AND file_id = $2"#,
        )
        .bind(collection_id)
        .bind(request.file_id)
        .bind(destination_token)
        .bind(&revision)
        .bind(current_ciphertext)
        .bind(to_i64(sequence, "collection sequence")?)
        .execute(&mut *transaction)
        .await?;
        insert_file_version(
            &mut transaction,
            FileVersionInsert {
                collection_id,
                file_id: request.file_id,
                sequence,
                revision: &revision,
                size: current.size,
                object_key: Some(&object_key),
                payload_ciphertext: Some(version_ciphertext),
                deleted: false,
            },
        )
        .await?;
        insert_file_change(
            &mut transaction,
            collection_id,
            request.file_id,
            sequence,
            &revision,
            Some((&current, &object_key, before_ciphertext)),
            Some((&moved, &object_key, after_ciphertext)),
        )
        .await?;
        update_collection_head(&mut transaction, collection_id, sequence).await?;

        let receipt = MoveFileReceipt {
            protocol_version: FILE_PROTOCOL_VERSION,
            message_type: MoveFileReceiptKind::FileMoved,
            mutation_id: request.mutation_id,
            file: moved,
        };
        self.persist_file_mutation(&mut transaction, &mutation, &request, &receipt)
            .await?;
        transaction.commit().await?;
        Ok(receipt)
    }

    pub async fn delete_file(
        &self,
        collection_id: Uuid,
        token: &str,
        request: DeleteFileRequest,
        request_origin: Option<&str>,
    ) -> ApiResult<DeleteFileReceipt> {
        require_lifecycle_request(request.protocol_version, request.mutation_id)?;
        validate_hosted_file_path(&request.path)?;
        let initial_replica = self.authenticate_for_file(collection_id, token).await?;
        authorize_file_access(
            &initial_replica,
            FileAction::Delete,
            Some(&request.path),
            request_origin,
        )?;

        let mut transaction = self.pool.begin().await?;
        lock_mutation_id(&mut transaction, request.mutation_id).await?;
        let replica = lock_file_replica(&mut transaction, collection_id, token).await?;
        authorize_file_access(
            &replica,
            FileAction::Delete,
            Some(&request.path),
            request_origin,
        )?;
        let collection = lock_file_collection(&mut transaction, collection_id).await?;
        let data_key = self.collection_key(collection_id, collection.get("wrapped_data_key"))?;
        let mutation = FileMutationIdentity {
            data_key: &data_key,
            collection_id,
            replica_id: replica.id,
            kind: "delete",
            mutation_id: request.mutation_id,
        };
        if let Some(receipt) = self
            .replay_file_mutation::<DeleteFileRequest, DeleteFileReceipt>(
                &mut transaction,
                &mutation,
                &request,
            )
            .await?
        {
            transaction.commit().await?;
            return Ok(receipt);
        }

        let current_row = sqlx::query(
            r#"SELECT file_id, revision, size, object_key, payload_ciphertext, sequence
               FROM hosted_provider_files
               WHERE collection_id = $1 AND file_id = $2 FOR UPDATE"#,
        )
        .bind(collection_id)
        .bind(request.file_id)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or_else(file_not_found)?;
        let (current, object_key, _, _) =
            decode_current_file(&self.crypto, &data_key, collection_id, &current_row)?;
        require_lifecycle_source(&current, &request.path, &request.if_revision)?;

        let sequence = next_file_sequence(&collection)?;
        let revision = format!("file:{}", Uuid::now_v7());
        let before_ciphertext = self.crypto.encrypt_json(
            &data_key,
            &payload_from_descriptor(&current),
            &change_file_aad(collection_id, sequence, "before"),
        )?;
        sqlx::query("DELETE FROM hosted_provider_files WHERE collection_id = $1 AND file_id = $2")
            .bind(collection_id)
            .bind(request.file_id)
            .execute(&mut *transaction)
            .await?;
        insert_file_version(
            &mut transaction,
            FileVersionInsert {
                collection_id,
                file_id: request.file_id,
                sequence,
                revision: &revision,
                size: 0,
                object_key: None,
                payload_ciphertext: None,
                deleted: true,
            },
        )
        .await?;
        insert_file_change(
            &mut transaction,
            collection_id,
            request.file_id,
            sequence,
            &revision,
            Some((&current, &object_key, before_ciphertext)),
            None,
        )
        .await?;
        let file_count = number(collection.get("file_count"), "file count")?
            .checked_sub(1)
            .ok_or_else(|| ApiError::internal("File count underflowed."))?;
        let file_bytes = number(collection.get("file_bytes"), "current file bytes")?
            .checked_sub(current.size)
            .ok_or_else(|| ApiError::internal("Current file byte count underflowed."))?;
        sqlx::query(
            r#"UPDATE hosted_provider_collections
               SET head = $2, file_count = $3, file_bytes = $4, updated_at = now()
               WHERE id = $1"#,
        )
        .bind(collection_id)
        .bind(to_i64(sequence, "collection sequence")?)
        .bind(to_i64(file_count, "file count")?)
        .bind(to_i64(file_bytes, "current file bytes")?)
        .execute(&mut *transaction)
        .await?;

        let receipt = DeleteFileReceipt {
            protocol_version: FILE_PROTOCOL_VERSION,
            message_type: DeleteFileReceiptKind::FileDeleted,
            mutation_id: request.mutation_id,
            file_id: request.file_id,
            previous_path: request.path.clone(),
            revision,
        };
        self.persist_file_mutation(&mut transaction, &mutation, &request, &receipt)
            .await?;
        transaction.commit().await?;
        Ok(receipt)
    }

    async fn replay_file_mutation<Request, Receipt>(
        &self,
        transaction: &mut Transaction<'_, Postgres>,
        mutation: &FileMutationIdentity<'_>,
        request: &Request,
    ) -> ApiResult<Option<Receipt>>
    where
        Request: DeserializeOwned + PartialEq,
        Receipt: DeserializeOwned,
    {
        let row = sqlx::query(
            r#"SELECT collection_id, replica_id, kind, request_ciphertext, receipt_ciphertext
               FROM hosted_provider_file_mutations WHERE mutation_id = $1"#,
        )
        .bind(mutation.mutation_id)
        .fetch_optional(&mut **transaction)
        .await?;
        let Some(row) = row else {
            return Ok(None);
        };
        let stored = StoredFileMutation {
            collection_id: row.get("collection_id"),
            replica_id: row.get("replica_id"),
            kind: row.get("kind"),
            request_ciphertext: row.get("request_ciphertext"),
            receipt_ciphertext: row.get("receipt_ciphertext"),
        };
        if stored.collection_id != mutation.collection_id
            || stored.replica_id != mutation.replica_id
            || stored.kind != mutation.kind
        {
            return Err(file_mutation_conflict());
        }
        let stored_request: Request = self.crypto.decrypt_json(
            mutation.data_key,
            &stored.request_ciphertext,
            &file_mutation_request_aad(mutation.mutation_id),
        )?;
        if &stored_request != request {
            return Err(file_mutation_conflict());
        }
        self.crypto
            .decrypt_json(
                mutation.data_key,
                &stored.receipt_ciphertext,
                &file_mutation_receipt_aad(mutation.mutation_id),
            )
            .map(Some)
    }

    async fn persist_file_mutation<Request, Receipt>(
        &self,
        transaction: &mut Transaction<'_, Postgres>,
        mutation: &FileMutationIdentity<'_>,
        request: &Request,
        receipt: &Receipt,
    ) -> ApiResult<()>
    where
        Request: Serialize,
        Receipt: Serialize,
    {
        let request_ciphertext = self.crypto.encrypt_json(
            mutation.data_key,
            request,
            &file_mutation_request_aad(mutation.mutation_id),
        )?;
        let receipt_ciphertext = self.crypto.encrypt_json(
            mutation.data_key,
            receipt,
            &file_mutation_receipt_aad(mutation.mutation_id),
        )?;
        sqlx::query(
            r#"INSERT INTO hosted_provider_file_mutations
                 (mutation_id, collection_id, replica_id, kind,
                  request_ciphertext, receipt_ciphertext)
               VALUES ($1, $2, $3, $4, $5, $6)"#,
        )
        .bind(mutation.mutation_id)
        .bind(mutation.collection_id)
        .bind(mutation.replica_id)
        .bind(mutation.kind)
        .bind(request_ciphertext)
        .bind(receipt_ciphertext)
        .execute(&mut **transaction)
        .await?;
        Ok(())
    }
}

fn require_lifecycle_request(protocol_version: u32, mutation_id: Uuid) -> ApiResult<()> {
    require_file_protocol(protocol_version)?;
    if mutation_id.is_nil() {
        return Err(ApiError::bad_request(
            "invalid_mutation_id",
            "File mutations require a non-nil client-generated UUID.",
        ));
    }
    Ok(())
}

async fn lock_mutation_id(
    transaction: &mut Transaction<'_, Postgres>,
    mutation_id: Uuid,
) -> ApiResult<()> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))")
        .bind(mutation_id)
        .execute(&mut **transaction)
        .await?;
    Ok(())
}

async fn lock_file_replica(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
    token: &str,
) -> ApiResult<Replica> {
    let row = sqlx::query(
        r#"SELECT id, purpose, mode, allowed_types, contract_scope, full_collection,
                  allowed_operations, file_capability, allowed_origin, proof_public_key,
                  grant_id, scope_epoch
           FROM hosted_provider_replicas
           WHERE collection_id = $1 AND token_hash = $2
             AND revoked_at IS NULL AND token_expires_at > now()
           FOR SHARE"#,
    )
    .bind(collection_id)
    .bind(token_hash(token))
    .fetch_optional(&mut **transaction)
    .await?;
    replica_from_row(row)
}

async fn lock_file_collection(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
) -> ApiResult<PgRow> {
    sqlx::query(
        r#"SELECT head, file_count, file_bytes, stored_file_bytes, wrapped_data_key
           FROM hosted_provider_collections
           WHERE id = $1 AND state = 'active' FOR UPDATE"#,
    )
    .bind(collection_id)
    .fetch_optional(&mut **transaction)
    .await?
    .ok_or_else(hosted_collection_not_found)
}

fn next_file_sequence(collection: &PgRow) -> ApiResult<u64> {
    number(collection.get("head"), "collection head")?
        .checked_add(1)
        .ok_or_else(|| ApiError::internal("Collection sequence overflowed."))
}

fn require_lifecycle_source(
    current: &CollectionFileDescriptor,
    expected_path: &str,
    expected_revision: &str,
) -> ApiResult<()> {
    if current.path != expected_path {
        return Err(ApiError::conflict(
            "file_source_mismatch",
            "The file is no longer at the source path bound to this mutation.",
        ));
    }
    if current.revision != expected_revision {
        return Err(stale_file_revision());
    }
    Ok(())
}

struct FileVersionInsert<'a> {
    collection_id: Uuid,
    file_id: Uuid,
    sequence: u64,
    revision: &'a str,
    size: u64,
    object_key: Option<&'a str>,
    payload_ciphertext: Option<Vec<u8>>,
    deleted: bool,
}

async fn insert_file_version(
    transaction: &mut Transaction<'_, Postgres>,
    version: FileVersionInsert<'_>,
) -> ApiResult<()> {
    sqlx::query(
        r#"INSERT INTO hosted_provider_file_versions
             (collection_id, file_id, sequence, revision, size, object_key,
              payload_ciphertext, deleted)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)"#,
    )
    .bind(version.collection_id)
    .bind(version.file_id)
    .bind(to_i64(version.sequence, "collection sequence")?)
    .bind(version.revision)
    .bind(
        (!version.deleted)
            .then(|| to_i64(version.size, "file size"))
            .transpose()?,
    )
    .bind(version.object_key)
    .bind(version.payload_ciphertext)
    .bind(version.deleted)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

type ChangeSide<'a> = (&'a CollectionFileDescriptor, &'a str, Vec<u8>);

async fn insert_file_change(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
    file_id: Uuid,
    sequence: u64,
    revision: &str,
    before: Option<ChangeSide<'_>>,
    after: Option<ChangeSide<'_>>,
) -> ApiResult<()> {
    sqlx::query(
        r#"INSERT INTO hosted_provider_file_changes
             (collection_id, sequence, file_id, revision, before_size,
              before_object_key, before_ciphertext, after_size,
              after_object_key, after_ciphertext)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)"#,
    )
    .bind(collection_id)
    .bind(to_i64(sequence, "collection sequence")?)
    .bind(file_id)
    .bind(revision)
    .bind(before.as_ref().map(|(file, _, _)| file.size as i64))
    .bind(before.as_ref().map(|(_, object_key, _)| *object_key))
    .bind(before.map(|(_, _, ciphertext)| ciphertext))
    .bind(after.as_ref().map(|(file, _, _)| file.size as i64))
    .bind(after.as_ref().map(|(_, object_key, _)| *object_key))
    .bind(after.map(|(_, _, ciphertext)| ciphertext))
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

async fn update_collection_head(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
    sequence: u64,
) -> ApiResult<()> {
    sqlx::query(
        "UPDATE hosted_provider_collections SET head = $2, updated_at = now() WHERE id = $1",
    )
    .bind(collection_id)
    .bind(to_i64(sequence, "collection sequence")?)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

fn file_mutation_conflict() -> ApiError {
    ApiError::conflict(
        "file_mutation_conflict",
        "The mutation ID was already used for a different file change.",
    )
}

fn file_not_found() -> ApiError {
    ApiError::not_found("file_not_found", "Collection file not found.")
}
