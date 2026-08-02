use super::*;

impl HostedProvider {
    pub(super) async fn authenticate_for_file(
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

    pub(super) async fn upload_session(
        &self,
        transfer: &HostedFileTransfer,
    ) -> ApiResult<FileTransferSession> {
        let uploaded_parts = if transfer.strategy == "object_multipart" {
            if matches!(transfer.state.as_str(), "completing" | "committed") {
                transfer.completion_parts.clone().unwrap_or_default()
            } else {
                self.blob_store
                    .list_multipart_parts(
                        &transfer.staging_object_key,
                        transfer
                            .multipart_upload_id
                            .as_deref()
                            .ok_or_else(|| ApiError::internal("Multipart upload ID is missing."))?,
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
                    .collect::<ApiResult<Vec<_>>>()?
            }
        } else {
            Vec::new()
        };
        let received = if transfer.state == "committed" {
            (0..upload_part_count(transfer, self.blob_store.upload_part_size())).collect()
        } else if transfer.strategy == "object_multipart" {
            uploaded_parts
                .iter()
                .map(|part| u64::from(part.part_number - 1))
                .collect()
        } else {
            match transfer.strategy.as_str() {
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
                "object_multipart" => unreachable!("multipart progress handled above"),
                _ => return Err(ApiError::internal("Stored upload strategy is invalid.")),
            }
        };
        Ok(FileTransferSession {
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
}
