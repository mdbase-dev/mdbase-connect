use super::*;

impl HostedProvider {
    pub(in crate::provider) async fn authenticate_for_file(
        &self,
        collection_id: Uuid,
        token: &str,
    ) -> ApiResult<Replica> {
        let row = sqlx::query(
            r#"SELECT id, purpose, mode, allowed_types, contract_scope, full_collection,
                      allowed_operations, file_capability, allowed_origin, proof_public_key,
                      grant_id, scope_epoch
               FROM hosted_provider_replicas
               WHERE collection_id = $1 AND token_hash = $2
                 AND revoked_at IS NULL AND token_expires_at > now()"#,
        )
        .bind(collection_id)
        .bind(token_hash(token))
        .fetch_optional(&self.pool)
        .await?;
        replica_from_row(row)
    }

    pub(super) async fn load_collection_key(
        &self,
        collection_id: Uuid,
    ) -> ApiResult<zeroize::Zeroizing<[u8; 32]>> {
        let wrapped: Vec<u8> = sqlx::query_scalar(
            "SELECT wrapped_data_key FROM hosted_provider_collections WHERE id = $1 AND state = 'active'",
        )
        .bind(collection_id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(hosted_collection_not_found)?;
        self.collection_key(collection_id, &wrapped).await
    }

    pub(super) async fn load_current_file(
        &self,
        collection_id: Uuid,
        data_key: &[u8; 32],
        path_token: &[u8],
    ) -> ApiResult<Option<(CollectionFileDescriptor, String, u64, Vec<u8>)>> {
        let row = sqlx::query(
            r#"SELECT file_id, revision, size, object_key, payload_ciphertext, sequence
               FROM hosted_provider_files
               WHERE collection_id = $1 AND path_token = $2"#,
        )
        .bind(collection_id)
        .bind(path_token)
        .fetch_optional(&self.pool)
        .await?;
        row.map(|row| decode_current_file(&self.crypto, data_key, collection_id, &row))
            .transpose()
    }

    pub(super) async fn load_upload_transfer(
        &self,
        collection_id: Uuid,
        transfer_id: Uuid,
        data_key: &[u8; 32],
    ) -> ApiResult<Option<HostedFileTransfer>> {
        let row = sqlx::query(
            r#"SELECT id, collection_id, replica_id, state, strategy, file_id,
                      expected_size, intent_ciphertext, staging_object_key,
                      committed_object_key, multipart_upload_id, completion_parts,
                      receipt_ciphertext, expires_at
               FROM hosted_provider_file_transfers
               WHERE id = $1 AND collection_id = $2 AND direction = 'upload'"#,
        )
        .bind(transfer_id)
        .bind(collection_id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(|row| decode_upload_transfer(self, data_key, row))
            .transpose()
    }

    pub(super) async fn load_download_transfer(
        &self,
        collection_id: Uuid,
        transfer_id: Uuid,
        data_key: &[u8; 32],
    ) -> ApiResult<Option<HostedDownloadTransfer>> {
        let row = sqlx::query(
            r#"SELECT id, collection_id, replica_id, state, file_id, expected_size,
                      intent_ciphertext, committed_object_key, expires_at
               FROM hosted_provider_file_transfers
               WHERE id = $1 AND collection_id = $2 AND direction = 'download'"#,
        )
        .bind(transfer_id)
        .bind(collection_id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(|row| {
            let id: Uuid = row.get("id");
            Ok(HostedDownloadTransfer {
                id,
                replica_id: row.get("replica_id"),
                state: row.get("state"),
                file_id: row.get("file_id"),
                size: number(row.get("expected_size"), "file size")?,
                intent: self.crypto.decrypt_json(
                    data_key,
                    row.get("intent_ciphertext"),
                    &file_transfer_intent_aad(id),
                )?,
                object_key: row.get("committed_object_key"),
                expires_at: row.get("expires_at"),
            })
        })
        .transpose()
    }

    pub(super) async fn upload_progress(
        &self,
        transfer: &HostedFileTransfer,
    ) -> ApiResult<(Vec<u64>, u64, Vec<UploadedFilePart>)> {
        if transfer.state == "committed" {
            let uploaded_parts = if transfer.strategy == "object_multipart" {
                transfer.completion_parts.clone().unwrap_or_default()
            } else {
                Vec::new()
            };
            return Ok((
                (0..upload_part_count(transfer, self.blob_store.upload_part_size())).collect(),
                transfer.expected_size,
                uploaded_parts,
            ));
        }
        // A terminal upload's multipart upload is aborted in R2, which then
        // refuses to list it; nothing it received can be committed anyway.
        if transfer.state == "aborted" || transfer.state == "expired" {
            return Ok((Vec::new(), 0, Vec::new()));
        }
        let mut uploaded_parts = Vec::new();
        let received = match transfer.strategy.as_str() {
            "object_put" => {
                if self
                    .blob_store
                    .object_exists(&transfer.staging_object_key)
                    .await?
                {
                    vec![0]
                } else {
                    Vec::new()
                }
            }
            "object_multipart" if transfer.state == "completing" => {
                uploaded_parts = transfer.completion_parts.clone().unwrap_or_default();
                uploaded_parts
                    .iter()
                    .map(|part| u64::from(part.part_number - 1))
                    .collect()
            }
            "object_multipart" => {
                uploaded_parts =
                    self.blob_store
                        .list_multipart_parts(
                            &transfer.staging_object_key,
                            transfer.multipart_upload_id.as_deref().ok_or_else(|| {
                                ApiError::internal("Multipart upload ID is missing.")
                            })?,
                        )
                        .await?
                        .into_iter()
                        .map(|part| {
                            if part.etag.is_empty() || part.etag.len() > 255 {
                                return Err(ApiError::internal(
                                    "Stored multipart part ETag is invalid.",
                                ));
                            }
                            Ok(UploadedFilePart {
                                part_number: u16::try_from(part.part_number).map_err(|_| {
                                    ApiError::internal("Stored multipart part number is invalid.")
                                })?,
                                etag: part.etag,
                            })
                        })
                        .collect::<ApiResult<Vec<_>>>()?;
                uploaded_parts
                    .iter()
                    .map(|part| u64::from(part.part_number - 1))
                    .collect()
            }
            _ => return Err(ApiError::internal("Stored upload strategy is invalid.")),
        };
        let mut received_bytes = 0_u64;
        for index in &received {
            received_bytes = received_bytes
                .checked_add(part_length(
                    transfer.expected_size,
                    strategy_part_size(transfer, self.blob_store.upload_part_size())?,
                    *index,
                )?)
                .ok_or_else(|| ApiError::internal("Uploaded byte count overflowed."))?;
        }
        Ok((received, received_bytes, uploaded_parts))
    }

    pub(super) async fn upload_session(
        &self,
        transfer: &HostedFileTransfer,
    ) -> ApiResult<FileTransferSession> {
        let (received, _, uploaded_parts) = self.upload_progress(transfer).await?;
        Ok(FileTransferSession {
            prepared_upload_part: None,
            protocol_version: FILE_TRANSFER_PROTOCOL_VERSION,
            message_type: FileTransferSessionKind::FileTransfer,
            transfer_id: transfer.id,
            direction: FileTransferDirection::Upload,
            protection: FileTransferProtection::TransportTls,
            strategy: match transfer.strategy.as_str() {
                "object_put" => FileTransferStrategy::ObjectPut,
                "object_multipart" => FileTransferStrategy::ObjectMultipart {
                    part_size: self.blob_store.upload_part_size(),
                },
                _ => return Err(ApiError::internal("Stored upload strategy is invalid.")),
            },
            total_size: transfer.expected_size,
            expires_at: transfer.expires_at.to_rfc3339(),
            received,
            uploaded_parts,
        })
    }

    /// Publication checks quota only after copying and re-hashing the object,
    /// so a client retrying against a full account would pay for both every
    /// time. This refuses, from one unlocked read, exactly when publication
    /// would refuse for quota as things stand. Any refusal publication would
    /// give first is left to it; it repeats every check under locks.
    pub(super) async fn refuse_commit_over_quota(
        &self,
        transfer: &HostedFileTransfer,
        replica: &Replica,
        data_key: &[u8; 32],
        request_origin: Option<&str>,
    ) -> ApiResult<()> {
        let Some(row) = sqlx::query(
            r#"SELECT collection.file_count, collection.file_bytes,
                      collection.stored_file_bytes, collection.max_files,
                      collection.max_file_bytes, collection.max_stored_file_bytes,
                      account.live_content_bytes, account.live_file_bytes,
                      account.max_live_storage_bytes, account.retained_file_bytes,
                      account.max_retained_file_bytes,
                      file.file_id, file.revision, file.size
               FROM hosted_provider_collections collection
               JOIN hosted_provider_file_transfers transfer
                 ON transfer.id = $2 AND transfer.collection_id = collection.id
                AND transfer.state = 'completing'
               LEFT JOIN hosted_provider_accounts account
                 ON account.id = collection.account_id
               LEFT JOIN hosted_provider_files file
                 ON file.collection_id = collection.id AND file.path_token = $3
               WHERE collection.id = $1 AND collection.state = 'active'"#,
        )
        .bind(transfer.collection_id)
        .bind(transfer.id)
        .bind(path_token(
            data_key,
            &portable_file_path_key(&transfer.intent.path),
        ))
        .fetch_optional(&self.pool)
        .await?
        else {
            return Ok(());
        };
        let current = row
            .get::<Option<Uuid>, _>("file_id")
            .map(|file_id| {
                Ok::<_, ApiError>((
                    file_id,
                    row.get::<String, _>("revision"),
                    number(row.get("size"), "file size")?,
                ))
            })
            .transpose()?;
        let action = if current.is_some() {
            FileAction::Replace
        } else {
            FileAction::Add
        };
        if authorize_file_access(replica, action, Some(&transfer.intent.path), request_origin)
            .is_err()
        {
            return Ok(());
        }
        match (&current, transfer.intent.base_revision.as_deref()) {
            (Some((file_id, revision, _)), Some(base))
                if revision == base && *file_id == transfer.file_id => {}
            (None, None) => {}
            _ => return Ok(()),
        }
        let (_, next_bytes, next_stored_bytes) = file_usage_after_commit(
            &row,
            current.map(|(_, _, size)| size),
            transfer.expected_size,
        )?;
        let Some(max_live) = row.get::<Option<i64>, _>("max_live_storage_bytes") else {
            return Ok(());
        };
        // The same deltas and comparisons as the account usage trigger.
        let file_delta =
            to_i64(next_bytes, "current file bytes")? - row.get::<i64, _>("file_bytes");
        let retained_delta = to_i64(next_stored_bytes, "stored file bytes")?
            - row.get::<i64, _>("stored_file_bytes");
        let live = row
            .get::<i64, _>("live_content_bytes")
            .saturating_add(row.get("live_file_bytes"));
        let refusal = if file_delta > 0 && live.saturating_add(file_delta) > max_live {
            Some("account_storage_quota_exceeded")
        } else if retained_delta > 0
            && row
                .get::<i64, _>("retained_file_bytes")
                .saturating_add(retained_delta)
                > row.get::<i64, _>("max_retained_file_bytes")
        {
            Some("account_retained_storage_quota_exceeded")
        } else {
            None
        };
        match refusal.and_then(ApiError::account_quota) {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}
