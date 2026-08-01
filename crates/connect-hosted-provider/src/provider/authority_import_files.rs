use super::files::{classify_media, validate_content_digest, validate_media_type};
use super::*;
use crate::blob_store::UploadedPart as BlobUploadedPart;
use mdbase_connect_protocol::{
    CollectionFileDescriptor, CommitFileUploadReceipt, CommitFileUploadReceiptKind,
    CommitFileUploadRequest, FileTransferDirection, FileTransferProtection, FileTransferSession,
    FileTransferSessionKind, FileTransferStrategy, OpenAuthorityImportFileUploadRequest,
    PrepareFileUploadPartRequest, PreparedFilePart, PreparedFilePartKind, UploadedFilePart,
};

const SINGLE_PUT_THRESHOLD_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Debug, Clone)]
struct ImportFileTransfer {
    id: Uuid,
    import_id: Uuid,
    state: String,
    strategy: String,
    expected_size: u64,
    file: CollectionFileDescriptor,
    staging_object_key: String,
    committed_object_key: String,
    multipart_upload_id: Option<String>,
    completion_parts: Option<Vec<UploadedFilePart>>,
    expires_at: DateTime<Utc>,
}

impl HostedProvider {
    pub async fn open_authority_import_file_upload(
        &self,
        import_id: Uuid,
        token: &str,
        request: OpenAuthorityImportFileUploadRequest,
    ) -> ApiResult<FileTransferSession> {
        if request.protocol_version != FILE_PROTOCOL_VERSION
            || request.transfer_id.is_nil()
            || request.file_id.is_nil()
        {
            return Err(ApiError::bad_request(
                "invalid_authority_import_file",
                "Authority import file upload request is invalid.",
            ));
        }
        let mut transaction = self.pool.begin().await?;
        let row = authority_import_row(&mut transaction, import_id).await?;
        authorize_authority_import(&row, token)?;
        if authority_import_state(&row, "import_state")? != ProviderAuthorityImportState::Receiving
        {
            return Err(ApiError::conflict(
                "authority_import_finalized",
                "A finalized authority import cannot accept file uploads.",
            ));
        }
        let data_key = self.authority_import_data_key(&row)?;
        let manifest = self.authority_import_manifest(&row, &data_key, import_id)?;
        let file = manifest
            .files
            .into_iter()
            .find(|file| file.file_id == request.file_id)
            .ok_or_else(|| {
                ApiError::bad_request(
                    "authority_import_file_not_declared",
                    "The file is not declared by this authority import manifest.",
                )
            })?;
        validate_import_file(&file, &self.limits)?;
        let intent_token = import_file_intent_token(&data_key, &file)?;
        if let Some(existing) = self
            .load_import_file_transfer(&mut transaction, request.transfer_id, &data_key)
            .await?
        {
            if existing.import_id != import_id || existing.file != file {
                return Err(ApiError::conflict(
                    "file_transfer_conflict",
                    "The transfer ID is already bound to another import file.",
                ));
            }
            sqlx::query("DELETE FROM hosted_provider_blob_deletions WHERE object_key = $1")
                .bind(&existing.committed_object_key)
                .execute(&mut *transaction)
                .await?;
            transaction.commit().await?;
            return self.import_file_session(&existing).await;
        }
        let committed_object_key = format!(
            "v1/blobs/{}/{}",
            row.get::<Uuid, _>("collection_id"),
            request.transfer_id
        );
        // Synchronize with the deletion worker before this key is claimed by
        // a replacement import transfer.
        sqlx::query("DELETE FROM hosted_provider_blob_deletions WHERE object_key = $1")
            .bind(&committed_object_key)
            .execute(&mut *transaction)
            .await?;
        let use_single_put = file.size <= SINGLE_PUT_THRESHOLD_BYTES;
        let staging_object_key = format!("v1/import-staging/{import_id}/{}", request.transfer_id);
        let multipart_upload_id = if use_single_put {
            None
        } else {
            Some(
                self.blob_store
                    .create_multipart(&staging_object_key)
                    .await?,
            )
        };
        let expires_at = row
            .get::<DateTime<Utc>, _>("expires_at")
            .min(Utc::now() + chrono::Duration::hours(24));
        let inserted = sqlx::query(
            r#"INSERT INTO hosted_provider_authority_import_file_transfers
                 (id, import_id, file_id, state, strategy, expected_size, intent_token,
                  intent_ciphertext, staging_object_key, committed_object_key,
                  multipart_upload_id, expires_at)
               VALUES ($1, $2, $3, 'open', $4, $5, $6, $7, $8, $9, $10, $11)
               ON CONFLICT (id) DO NOTHING"#,
        )
        .bind(request.transfer_id)
        .bind(import_id)
        .bind(file.file_id)
        .bind(if use_single_put {
            "object_put"
        } else {
            "object_multipart"
        })
        .bind(to_i64(file.size, "file size")?)
        .bind(intent_token)
        .bind(self.crypto.encrypt_json(
            &data_key,
            &file,
            &authority_import_file_intent_aad(request.transfer_id),
        )?)
        .bind(&staging_object_key)
        .bind(&committed_object_key)
        .bind(multipart_upload_id.as_deref())
        .bind(expires_at)
        .execute(&mut *transaction)
        .await?;
        if inserted.rows_affected() == 0 {
            if let Some(upload_id) = multipart_upload_id.as_deref() {
                let _ = self
                    .blob_store
                    .abort_multipart(&staging_object_key, upload_id)
                    .await;
            }
            let existing = self
                .load_import_file_transfer(&mut transaction, request.transfer_id, &data_key)
                .await?
                .ok_or_else(|| {
                    ApiError::conflict("file_transfer_conflict", "Transfer ID is already in use.")
                })?;
            if existing.import_id != import_id || existing.file != file {
                return Err(ApiError::conflict(
                    "file_transfer_conflict",
                    "Transfer ID is already in use.",
                ));
            }
            sqlx::query("DELETE FROM hosted_provider_blob_deletions WHERE object_key = $1")
                .bind(&existing.committed_object_key)
                .execute(&mut *transaction)
                .await?;
            transaction.commit().await?;
            return self.import_file_session(&existing).await;
        }
        let transfer = self
            .load_import_file_transfer(&mut transaction, request.transfer_id, &data_key)
            .await?
            .expect("inserted import file transfer exists");
        sqlx::query("DELETE FROM hosted_provider_blob_deletions WHERE object_key = $1")
            .bind(&transfer.committed_object_key)
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
        self.import_file_session(&transfer).await
    }

    pub async fn prepare_authority_import_file_part(
        &self,
        import_id: Uuid,
        token: &str,
        request: PrepareFileUploadPartRequest,
    ) -> ApiResult<PreparedFilePart> {
        if request.protocol_version != FILE_PROTOCOL_VERSION {
            return Err(ApiError::bad_request(
                "unsupported_file_protocol",
                "Unsupported file protocol.",
            ));
        }
        let mut transaction = self.pool.begin().await?;
        let row = authority_import_row(&mut transaction, import_id).await?;
        authorize_authority_import(&row, token)?;
        let data_key = self.authority_import_data_key(&row)?;
        let transfer = self
            .load_import_file_transfer(&mut transaction, request.transfer_id, &data_key)
            .await?
            .ok_or_else(import_file_transfer_not_found)?;
        assert_import_transfer_open(&transfer, import_id)?;
        let (part_index, offset, expected_length) = import_expected_part(
            &transfer,
            self.blob_store.upload_part_size(),
            request.part_number,
        )?;
        if request.content_length != expected_length {
            return Err(import_invalid_part());
        }
        sqlx::query(
            r#"INSERT INTO hosted_provider_authority_import_file_parts
                 (transfer_id, part_number, content_length)
               VALUES ($1, $2, $3)
               ON CONFLICT (transfer_id, part_number) DO NOTHING"#,
        )
        .bind(transfer.id)
        .bind(i32::from(request.part_number))
        .bind(to_i64(expected_length, "file part size")?)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        let prepared = if transfer.strategy == "object_put" {
            self.blob_store
                .presign_put(&transfer.staging_object_key, expected_length)
                .await?
        } else {
            self.blob_store
                .presign_part(
                    &transfer.staging_object_key,
                    transfer
                        .multipart_upload_id
                        .as_deref()
                        .ok_or_else(|| ApiError::internal("Multipart upload ID is missing."))?,
                    i32::from(request.part_number),
                    expected_length,
                )
                .await?
        };
        Ok(PreparedFilePart {
            protocol_version: FILE_PROTOCOL_VERSION,
            message_type: PreparedFilePartKind::FilePart,
            transfer_id: transfer.id,
            part_index,
            offset,
            content_length: expected_length,
            method: prepared.method,
            url: prepared.url,
            headers: prepared.headers,
            expires_at: prepared.expires_at.to_rfc3339(),
        })
    }

    pub async fn commit_authority_import_file_upload(
        &self,
        import_id: Uuid,
        token: &str,
        request: CommitFileUploadRequest,
    ) -> ApiResult<CommitFileUploadReceipt> {
        if request.protocol_version != FILE_PROTOCOL_VERSION {
            return Err(ApiError::bad_request(
                "unsupported_file_protocol",
                "Unsupported file protocol.",
            ));
        }
        let mut transaction = self.pool.begin().await?;
        let row = authority_import_row(&mut transaction, import_id).await?;
        authorize_authority_import(&row, token)?;
        let data_key = self.authority_import_data_key(&row)?;
        let mut transfer = self
            .load_import_file_transfer(&mut transaction, request.transfer_id, &data_key)
            .await?
            .ok_or_else(import_file_transfer_not_found)?;
        if transfer.import_id != import_id {
            return Err(import_file_transfer_not_found());
        }
        if transfer.state == "committed" {
            transaction.commit().await?;
            return Ok(import_file_receipt(&transfer));
        }
        assert_import_transfer_open_or_completing(&transfer)?;
        let completion = self
            .validate_import_file_completion(&transfer, &request.parts)
            .await?;
        if transfer.state == "open" {
            let value = serde_json::to_value(&request.parts).map_err(|error| {
                ApiError::internal(format!("Upload parts could not serialize: {error}"))
            })?;
            sqlx::query(
                "UPDATE hosted_provider_authority_import_file_transfers SET state = 'completing', completion_parts = $2, updated_at = now() WHERE id = $1 AND state = 'open'",
            )
            .bind(transfer.id)
            .bind(value)
            .execute(&mut *transaction)
            .await?;
            transfer.state = "completing".to_string();
            transfer.completion_parts = Some(request.parts.clone());
        } else if transfer.completion_parts.as_deref() != Some(request.parts.as_slice()) {
            return Err(ApiError::conflict(
                "file_completion_conflict",
                "Upload was already completed with different parts.",
            ));
        }
        transaction.commit().await?;
        self.finalize_import_file_object(&transfer, &completion)
            .await?;
        sqlx::query(
            "UPDATE hosted_provider_authority_import_file_transfers SET state = 'committed', updated_at = now() WHERE id = $1 AND state = 'completing'",
        )
        .bind(transfer.id)
        .execute(&self.pool)
        .await?;
        if let Err(error) = self.blob_store.delete(&transfer.staging_object_key).await {
            tracing::warn!(transfer_id = %transfer.id, %error, "could not remove import file staging object");
        }
        Ok(import_file_receipt(&transfer))
    }

    fn authority_import_data_key(&self, row: &PgRow) -> ApiResult<[u8; 32]> {
        let collection_id: Uuid = row.get("collection_id");
        self.crypto.unwrap_data_key(
            &row.get::<Vec<u8>, _>("wrapped_data_key"),
            &collection_key_aad(collection_id),
        )
    }

    fn authority_import_manifest(
        &self,
        row: &PgRow,
        data_key: &[u8; 32],
        import_id: Uuid,
    ) -> ApiResult<AuthorityImportManifest> {
        let ciphertext = row
            .get::<Option<Vec<u8>>, _>("manifest_ciphertext")
            .ok_or_else(|| {
                ApiError::conflict(
                    "authority_import_manifest_required",
                    "Upload the import manifest first.",
                )
            })?;
        self.crypto.decrypt_json(
            data_key,
            &ciphertext,
            &authority_import_manifest_aad(import_id),
        )
    }

    async fn load_import_file_transfer(
        &self,
        transaction: &mut Transaction<'_, Postgres>,
        transfer_id: Uuid,
        data_key: &[u8; 32],
    ) -> ApiResult<Option<ImportFileTransfer>> {
        let row = sqlx::query(
            r#"SELECT id, import_id, state, strategy, expected_size, intent_ciphertext,
                      staging_object_key, committed_object_key, multipart_upload_id,
                      completion_parts, expires_at
               FROM hosted_provider_authority_import_file_transfers WHERE id = $1"#,
        )
        .bind(transfer_id)
        .fetch_optional(&mut **transaction)
        .await?;
        row.map(|row| {
            Ok(ImportFileTransfer {
                id: row.get("id"),
                import_id: row.get("import_id"),
                state: row.get("state"),
                strategy: row.get("strategy"),
                expected_size: number(row.get("expected_size"), "file size")?,
                file: self.crypto.decrypt_json(
                    data_key,
                    row.get("intent_ciphertext"),
                    &authority_import_file_intent_aad(transfer_id),
                )?,
                staging_object_key: row.get("staging_object_key"),
                committed_object_key: row.get("committed_object_key"),
                multipart_upload_id: row.get("multipart_upload_id"),
                completion_parts: row
                    .get::<Option<Value>, _>("completion_parts")
                    .map(serde_json::from_value)
                    .transpose()
                    .map_err(|error| {
                        ApiError::internal(format!("Stored upload parts are invalid: {error}"))
                    })?,
                expires_at: row.get("expires_at"),
            })
        })
        .transpose()
    }

    async fn import_file_session(
        &self,
        transfer: &ImportFileTransfer,
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
            (0..import_part_count(transfer, self.blob_store.upload_part_size())).collect()
        } else if transfer.strategy == "object_multipart" {
            uploaded_parts
                .iter()
                .map(|part| u64::from(part.part_number - 1))
                .collect()
        } else if transfer.strategy == "object_put" {
            if self
                .blob_store
                .object_exists(&transfer.staging_object_key)
                .await?
            {
                vec![0]
            } else {
                Vec::new()
            }
        } else {
            unreachable!("multipart progress handled above")
        };
        Ok(FileTransferSession {
            protocol_version: FILE_PROTOCOL_VERSION,
            message_type: FileTransferSessionKind::FileTransfer,
            transfer_id: transfer.id,
            direction: FileTransferDirection::Upload,
            protection: FileTransferProtection::TransportTls,
            strategy: if transfer.strategy == "object_put" {
                FileTransferStrategy::ObjectPut
            } else {
                FileTransferStrategy::ObjectMultipart {
                    part_size: self.blob_store.upload_part_size(),
                }
            },
            total_size: transfer.expected_size,
            expires_at: transfer.expires_at.to_rfc3339(),
            received,
            uploaded_parts,
        })
    }

    async fn validate_import_file_completion(
        &self,
        transfer: &ImportFileTransfer,
        parts: &[UploadedFilePart],
    ) -> ApiResult<Vec<BlobUploadedPart>> {
        if transfer.strategy == "object_put" {
            if !parts.is_empty()
                || !self
                    .blob_store
                    .object_exists(&transfer.staging_object_key)
                    .await?
            {
                return Err(import_upload_incomplete());
            }
            return Ok(Vec::new());
        }
        let expected = import_part_count(transfer, self.blob_store.upload_part_size());
        if parts.len() as u64 != expected
            || parts.iter().enumerate().any(|(index, part)| {
                usize::from(part.part_number) != index + 1 || part.etag.is_empty()
            })
        {
            return Err(import_upload_incomplete());
        }
        if transfer.state == "completing" {
            if transfer.completion_parts.as_deref() != Some(parts) {
                return Err(ApiError::conflict(
                    "file_completion_conflict",
                    "Upload completion differs from the first attempt.",
                ));
            }
            return Ok(parts
                .iter()
                .map(|part| BlobUploadedPart {
                    part_number: i32::from(part.part_number),
                    etag: part.etag.clone(),
                })
                .collect());
        }
        let actual = self
            .blob_store
            .list_multipart_parts(
                &transfer.staging_object_key,
                transfer
                    .multipart_upload_id
                    .as_deref()
                    .ok_or_else(|| ApiError::internal("Multipart upload ID is missing."))?,
            )
            .await?;
        if actual.len() != parts.len()
            || actual.iter().zip(parts).any(|(actual, declared)| {
                actual.part_number != i32::from(declared.part_number)
                    || actual.etag != declared.etag
            })
        {
            return Err(import_upload_incomplete());
        }
        Ok(actual)
    }

    async fn finalize_import_file_object(
        &self,
        transfer: &ImportFileTransfer,
        parts: &[BlobUploadedPart],
    ) -> ApiResult<()> {
        if self
            .blob_store
            .object_exists(&transfer.committed_object_key)
            .await?
        {
            return self
                .blob_store
                .verify_object(
                    &transfer.committed_object_key,
                    transfer.expected_size,
                    &transfer.file.content_digest,
                )
                .await;
        }
        if !self
            .blob_store
            .object_exists(&transfer.staging_object_key)
            .await?
        {
            if transfer.strategy != "object_multipart" {
                return Err(import_upload_incomplete());
            }
            self.blob_store
                .complete_multipart(
                    &transfer.staging_object_key,
                    transfer
                        .multipart_upload_id
                        .as_deref()
                        .ok_or_else(|| ApiError::internal("Multipart upload ID is missing."))?,
                    parts,
                )
                .await?;
        }
        self.blob_store
            .verify_object(
                &transfer.staging_object_key,
                transfer.expected_size,
                &transfer.file.content_digest,
            )
            .await?;
        self.blob_store
            .copy(&transfer.staging_object_key, &transfer.committed_object_key)
            .await?;
        self.blob_store
            .verify_object(
                &transfer.committed_object_key,
                transfer.expected_size,
                &transfer.file.content_digest,
            )
            .await
    }
}

fn import_file_receipt(transfer: &ImportFileTransfer) -> CommitFileUploadReceipt {
    CommitFileUploadReceipt {
        protocol_version: FILE_PROTOCOL_VERSION,
        message_type: CommitFileUploadReceiptKind::FileUploadCommitted,
        transfer_id: transfer.id,
        file: transfer.file.clone(),
    }
}

fn validate_import_file(file: &CollectionFileDescriptor, limits: &ProviderLimits) -> ApiResult<()> {
    validate_hosted_file_path(&file.path)?;
    validate_content_digest(&file.content_digest)?;
    validate_media_type(file.media_type.as_deref())?;
    if file.file_id.is_nil()
        || file.revision.is_empty()
        || file.media_class != classify_media(&file.path).0
        || chrono::DateTime::parse_from_rfc3339(&file.modified_at).is_err()
        || file.size > limits.max_bytes_per_file
    {
        return Err(ApiError::quota(
            "file_too_large",
            "Authority import file exceeds the per-file quota.",
        ));
    }
    Ok(())
}

fn import_file_intent_token(
    data_key: &[u8; 32],
    file: &CollectionFileDescriptor,
) -> ApiResult<Vec<u8>> {
    let value = serde_jcs::to_string(file)
        .map_err(|error| ApiError::internal(format!("File intent could not serialize: {error}")))?;
    Ok(path_token(data_key, &value))
}

fn assert_import_transfer_open(transfer: &ImportFileTransfer, import_id: Uuid) -> ApiResult<()> {
    if transfer.import_id != import_id {
        return Err(import_file_transfer_not_found());
    }
    if transfer.state != "open" || transfer.expires_at <= Utc::now() {
        return Err(ApiError::conflict(
            "file_transfer_not_open",
            "File upload no longer accepts parts.",
        ));
    }
    Ok(())
}

fn assert_import_transfer_open_or_completing(transfer: &ImportFileTransfer) -> ApiResult<()> {
    if !matches!(transfer.state.as_str(), "open" | "completing")
        || transfer.expires_at <= Utc::now()
    {
        return Err(ApiError::conflict(
            "file_transfer_not_open",
            "File upload can no longer commit.",
        ));
    }
    Ok(())
}

fn import_part_count(transfer: &ImportFileTransfer, part_size: u64) -> u64 {
    if transfer.strategy == "object_put" {
        1
    } else {
        transfer.expected_size.div_ceil(part_size)
    }
}

fn import_expected_part(
    transfer: &ImportFileTransfer,
    part_size: u64,
    part_number: u16,
) -> ApiResult<(u64, u64, u64)> {
    if part_number == 0 {
        return Err(import_invalid_part());
    }
    let index = u64::from(part_number - 1);
    let part_size = if transfer.strategy == "object_put" {
        if part_number != 1 {
            return Err(import_invalid_part());
        }
        transfer.expected_size.max(1)
    } else {
        part_size
    };
    let offset = index
        .checked_mul(part_size)
        .ok_or_else(import_invalid_part)?;
    if (transfer.expected_size == 0 && part_number != 1)
        || (transfer.expected_size > 0 && offset >= transfer.expected_size)
    {
        return Err(import_invalid_part());
    }
    Ok((
        index,
        offset,
        transfer.expected_size.saturating_sub(offset).min(part_size),
    ))
}

fn import_file_transfer_not_found() -> ApiError {
    ApiError::not_found(
        "file_transfer_not_found",
        "Authority import file transfer was not found.",
    )
}

fn import_invalid_part() -> ApiError {
    ApiError::bad_request(
        "invalid_file_part",
        "Requested file upload part is invalid.",
    )
}

fn import_upload_incomplete() -> ApiError {
    ApiError::conflict(
        "file_upload_incomplete",
        "Every authority import file part must be uploaded before commit.",
    )
}
