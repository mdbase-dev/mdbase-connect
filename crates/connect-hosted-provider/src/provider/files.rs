use super::*;
use crate::blob_store::UploadedPart as BlobUploadedPart;
use mdbase_connect_protocol::{
    AbortFileTransferRequest, CollectionFileDescriptor, CommitFileUploadReceipt,
    CommitFileUploadReceiptKind, CommitFileUploadRequest, FileMediaClass, FileTransferDirection,
    FileTransferProtection, FileTransferSession, FileTransferSessionKind, FileTransferState,
    FileTransferStatus, FileTransferStatusKind, FileTransferStrategy, ListFilesPage,
    ListFilesPageKind, ListFilesRequest, OpenFileDownloadRequest, OpenFileUploadRequest,
    PrepareFileDownloadPartRequest, PrepareFileUploadPartRequest, PreparedFilePart,
    PreparedFilePartKind, UploadedFilePart, FILE_TRANSFER_PROTOCOL_VERSION,
};

const TRANSFER_LIFETIME_HOURS: i64 = 24;
const SINGLE_PUT_THRESHOLD_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct HostedFilePayload {
    pub(super) path: String,
    content_digest: String,
    media_type: Option<String>,
    media_class: FileMediaClass,
    modified_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct UploadIntent {
    path: String,
    content_digest: String,
    media_type: Option<String>,
    media_class: FileMediaClass,
    base_revision: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct DownloadIntent {
    revision: String,
    path: String,
    content_digest: String,
}

#[derive(Debug, Clone)]
struct HostedFileTransfer {
    id: Uuid,
    collection_id: Uuid,
    replica_id: Uuid,
    state: String,
    strategy: String,
    file_id: Uuid,
    expected_size: u64,
    intent: UploadIntent,
    staging_object_key: String,
    committed_object_key: String,
    multipart_upload_id: Option<String>,
    completion_parts: Option<Vec<UploadedFilePart>>,
    receipt: Option<CommitFileUploadReceipt>,
    expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
struct HostedDownloadTransfer {
    id: Uuid,
    replica_id: Uuid,
    state: String,
    file_id: Uuid,
    size: u64,
    intent: DownloadIntent,
    object_key: String,
    expires_at: DateTime<Utc>,
}

impl HostedProvider {
    pub async fn list_files(
        &self,
        collection_id: Uuid,
        token: &str,
        request: ListFilesRequest,
        request_origin: Option<&str>,
    ) -> ApiResult<ListFilesPage> {
        require_file_protocol(request.protocol_version)?;
        if let Some(folder) = request.folder.as_deref() {
            validate_hosted_folder_path(folder)?;
        }
        let limit = request.limit.unwrap_or(200);
        if limit == 0 || limit > 1_000 {
            return Err(ApiError::bad_request(
                "invalid_file_limit",
                "File page limits must be between 1 and 1000.",
            ));
        }
        let after = request
            .after
            .as_deref()
            .map(|value| {
                Uuid::parse_str(value).map_err(|_| {
                    ApiError::bad_request("invalid_file_page", "File page token is invalid.")
                })
            })
            .transpose()?
            .unwrap_or(Uuid::nil());
        let replica = self.authenticate_for_file(collection_id, token).await?;
        authorize_file_access(&replica, FileAction::List, None, request_origin)?;
        let data_key = self.load_collection_key(collection_id).await?;
        let rows = sqlx::query(
            r#"SELECT file_id, revision, size, object_key, payload_ciphertext, sequence
               FROM hosted_provider_files
               WHERE collection_id = $1 AND file_id > $2
               ORDER BY file_id LIMIT $3"#,
        )
        .bind(collection_id)
        .bind(after)
        .bind(i64::from(limit) + 1)
        .fetch_all(&self.pool)
        .await?;
        let has_next = rows.len() > usize::from(limit);
        let page_rows = rows
            .into_iter()
            .take(usize::from(limit))
            .collect::<Vec<_>>();
        let next = has_next
            .then(|| {
                page_rows
                    .last()
                    .map(|row| row.get::<Uuid, _>("file_id").to_string())
            })
            .flatten();
        let mut files = Vec::new();
        for row in page_rows {
            let (file, _, _, _) =
                decode_current_file(&self.crypto, &data_key, collection_id, &row)?;
            if request
                .folder
                .as_deref()
                .is_some_and(|folder| !file_path_in_folder(&file.path, folder))
            {
                continue;
            }
            if authorize_file_access(&replica, FileAction::List, Some(&file.path), request_origin)
                .is_ok()
            {
                files.push(file);
            }
        }
        Ok(ListFilesPage {
            protocol_version: FILE_PROTOCOL_VERSION,
            message_type: ListFilesPageKind::FilesPage,
            files,
            next,
        })
    }

    pub async fn open_file_upload(
        &self,
        collection_id: Uuid,
        token: &str,
        request: OpenFileUploadRequest,
        request_origin: Option<&str>,
    ) -> ApiResult<FileTransferSession> {
        require_file_protocol(request.protocol_version)?;
        validate_hosted_file_path(&request.path)?;
        validate_content_digest(&request.content_digest)?;
        validate_media_type(request.media_type.as_deref())?;
        if request.transfer_id.is_nil() {
            return Err(ApiError::bad_request(
                "invalid_transfer_id",
                "File transfers require a non-nil client-generated UUID.",
            ));
        }
        let replica = self.authenticate_for_file(collection_id, token).await?;
        let row = sqlx::query(
            r#"SELECT wrapped_data_key, max_single_file_bytes
               FROM hosted_provider_collections
               WHERE id = $1 AND state = 'active'"#,
        )
        .bind(collection_id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(hosted_collection_not_found)?;
        let max_file_size = number(row.get("max_single_file_bytes"), "single file byte quota")?;
        if request.size > max_file_size {
            return Err(ApiError::quota(
                "file_too_large",
                "The file exceeds this hosted collection's per-file limit.",
            ));
        }
        let data_key = self.collection_key(collection_id, row.get("wrapped_data_key"))?;
        if let Some(existing) = self
            .load_upload_transfer(collection_id, request.transfer_id, &data_key)
            .await?
        {
            assert_same_upload_request(&existing, &request, replica.id)?;
            return self.upload_session(&existing).await;
        }
        let path_token = path_token(&data_key, &portable_file_path_key(&request.path));
        let current = self
            .load_current_file(collection_id, &data_key, &path_token)
            .await?;
        let action = if current.is_some() {
            FileAction::Replace
        } else {
            FileAction::Add
        };
        authorize_file_access(&replica, action, Some(&request.path), request_origin)?;
        let file_id = match current {
            Some((descriptor, _, _, _)) => {
                if request.if_revision.as_deref() != Some(descriptor.revision.as_str()) {
                    return Err(stale_file_revision());
                }
                descriptor.file_id
            }
            None => {
                if request.if_revision.is_some() {
                    return Err(stale_file_revision());
                }
                Uuid::now_v7()
            }
        };
        let (media_class, inferred_media_type) = classify_media(&request.path);
        let intent = UploadIntent {
            path: request.path.clone(),
            content_digest: request.content_digest.clone(),
            media_type: request.media_type.clone().or(inferred_media_type),
            media_class,
            base_revision: request.if_revision.clone(),
        };
        let staging_object_key = format!("v1/staging/{collection_id}/{}", request.transfer_id);
        let committed_object_key = format!("v1/blobs/{collection_id}/{}", request.transfer_id);
        let use_single_put = request.size <= SINGLE_PUT_THRESHOLD_BYTES;
        let multipart_upload_id = if use_single_put {
            None
        } else {
            Some(
                self.blob_store
                    .create_multipart(&staging_object_key)
                    .await?,
            )
        };
        let created_at = Utc::now();
        let expires_at = created_at + chrono::Duration::hours(TRANSFER_LIFETIME_HOURS);
        let inserted = sqlx::query(
            r#"INSERT INTO hosted_provider_file_transfers
                 (id, collection_id, replica_id, direction, state, strategy, file_id,
                  expected_size, intent_ciphertext, staging_object_key,
                  committed_object_key, multipart_upload_id, expires_at)
               VALUES ($1, $2, $3, 'upload', 'open', $4, $5, $6, $7, $8, $9,
                       $10, $11)
               ON CONFLICT (id) DO NOTHING"#,
        )
        .bind(request.transfer_id)
        .bind(collection_id)
        .bind(replica.id)
        .bind(if use_single_put {
            "object_put"
        } else {
            "object_multipart"
        })
        .bind(file_id)
        .bind(to_i64(request.size, "file size")?)
        .bind(self.crypto.encrypt_json(
            &data_key,
            &intent,
            &file_transfer_intent_aad(request.transfer_id),
        )?)
        .bind(&staging_object_key)
        .bind(&committed_object_key)
        .bind(multipart_upload_id.as_deref())
        .bind(expires_at)
        .execute(&self.pool)
        .await?;
        if inserted.rows_affected() == 0 {
            if let Some(upload_id) = multipart_upload_id.as_deref() {
                let _ = self
                    .blob_store
                    .abort_multipart(&staging_object_key, upload_id)
                    .await;
            }
            let existing = self
                .load_upload_transfer(collection_id, request.transfer_id, &data_key)
                .await?
                .ok_or_else(|| {
                    ApiError::conflict(
                        "file_transfer_conflict",
                        "The transfer ID is already used outside this collection.",
                    )
                })?;
            assert_same_upload_request(&existing, &request, replica.id)?;
            return self.upload_session(&existing).await;
        }
        self.upload_session(
            &self
                .load_upload_transfer(collection_id, request.transfer_id, &data_key)
                .await?
                .expect("inserted file transfer can be loaded"),
        )
        .await
    }

    pub async fn prepare_file_upload_part(
        &self,
        collection_id: Uuid,
        token: &str,
        request: PrepareFileUploadPartRequest,
        request_origin: Option<&str>,
    ) -> ApiResult<PreparedFilePart> {
        require_file_protocol(request.protocol_version)?;
        let replica = self.authenticate_for_file(collection_id, token).await?;
        let data_key = self.load_collection_key(collection_id).await?;
        let transfer = self
            .load_upload_transfer(collection_id, request.transfer_id, &data_key)
            .await?
            .ok_or_else(transfer_not_found)?;
        assert_open_transfer(&transfer, replica.id)?;
        let action = if transfer.intent.base_revision.is_some() {
            FileAction::Replace
        } else {
            FileAction::Add
        };
        authorize_file_access(
            &replica,
            action,
            Some(&transfer.intent.path),
            request_origin,
        )?;
        let (part_index, offset, expected_length) =
            expected_upload_part(&transfer, self.blob_store.part_size(), request.part_number)?;
        if request.content_length != expected_length {
            return Err(ApiError::bad_request(
                "invalid_file_part",
                "The upload part length does not match this transfer.",
            ));
        }
        sqlx::query(
            r#"INSERT INTO hosted_provider_file_transfer_parts
                 (transfer_id, part_number, content_length)
               VALUES ($1, $2, $3)
               ON CONFLICT (transfer_id, part_number) DO UPDATE
                 SET content_length = hosted_provider_file_transfer_parts.content_length
               RETURNING content_length"#,
        )
        .bind(transfer.id)
        .bind(i32::from(request.part_number))
        .bind(to_i64(expected_length, "file part size")?)
        .fetch_one(&self.pool)
        .await
        .and_then(|row| {
            let stored: i64 = row.get("content_length");
            if stored == to_i64(expected_length, "file part size").unwrap_or(-1) {
                Ok(row)
            } else {
                Err(sqlx::Error::Protocol(
                    "file part was prepared with a different length".to_string(),
                ))
            }
        })
        .map_err(|error| {
            if matches!(error, sqlx::Error::Protocol(_)) {
                ApiError::conflict(
                    "file_part_conflict",
                    "This upload part was already prepared with a different length.",
                )
            } else {
                error.into()
            }
        })?;
        let prepared = match transfer.strategy.as_str() {
            "object_put" => {
                self.blob_store
                    .presign_put(&transfer.staging_object_key, expected_length)
                    .await?
            }
            "object_multipart" => {
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
            }
            _ => return Err(ApiError::internal("Stored upload strategy is invalid.")),
        };
        Ok(PreparedFilePart {
            protocol_version: FILE_TRANSFER_PROTOCOL_VERSION,
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

    pub async fn open_file_download(
        &self,
        collection_id: Uuid,
        token: &str,
        request: OpenFileDownloadRequest,
        request_origin: Option<&str>,
    ) -> ApiResult<FileTransferSession> {
        require_file_protocol(request.protocol_version)?;
        if request.transfer_id.is_nil() {
            return Err(ApiError::bad_request(
                "invalid_transfer_id",
                "File transfers require a non-nil client-generated UUID.",
            ));
        }
        let replica = self.authenticate_for_file(collection_id, token).await?;
        let data_key = self.load_collection_key(collection_id).await?;
        if let Some(existing) = self
            .load_download_transfer(collection_id, request.transfer_id, &data_key)
            .await?
        {
            if existing.replica_id != replica.id
                || existing.file_id != request.file_id
                || request
                    .revision
                    .as_deref()
                    .is_some_and(|revision| revision != existing.intent.revision)
            {
                return Err(ApiError::conflict(
                    "file_transfer_conflict",
                    "The transfer ID was already used for a different download.",
                ));
            }
            authorize_file_access(
                &replica,
                FileAction::Read,
                Some(&existing.intent.path),
                request_origin,
            )?;
            return Ok(download_session(&existing, self.blob_store.part_size()));
        }
        let row = if let Some(revision) = request.revision.as_deref() {
            sqlx::query(
                r#"SELECT file_id, revision, size, object_key, payload_ciphertext, sequence
                   FROM hosted_provider_file_versions
                   WHERE collection_id = $1 AND file_id = $2 AND revision = $3
                     AND deleted = false"#,
            )
            .bind(collection_id)
            .bind(request.file_id)
            .bind(revision)
            .fetch_optional(&self.pool)
            .await?
        } else {
            sqlx::query(
                r#"SELECT file_id, revision, size, object_key, payload_ciphertext, sequence
                   FROM hosted_provider_files
                   WHERE collection_id = $1 AND file_id = $2"#,
            )
            .bind(collection_id)
            .bind(request.file_id)
            .fetch_optional(&self.pool)
            .await?
        }
        .ok_or_else(|| ApiError::not_found("file_not_found", "Collection file not found."))?;
        let is_version = request.revision.is_some();
        let (descriptor, object_key) =
            decode_download_file(&self.crypto, &data_key, collection_id, &row, is_version)?;
        authorize_file_access(
            &replica,
            FileAction::Read,
            Some(&descriptor.path),
            request_origin,
        )?;
        let intent = DownloadIntent {
            revision: descriptor.revision.clone(),
            path: descriptor.path,
            content_digest: descriptor.content_digest,
        };
        let expires_at = Utc::now() + chrono::Duration::hours(TRANSFER_LIFETIME_HOURS);
        let inserted = sqlx::query(
            r#"INSERT INTO hosted_provider_file_transfers
                 (id, collection_id, replica_id, direction, state, strategy, file_id,
                  expected_size, intent_ciphertext, committed_object_key, expires_at)
               VALUES ($1, $2, $3, 'download', 'open', 'object_ranges', $4, $5,
                       $6, $7, $8)
               ON CONFLICT (id) DO NOTHING"#,
        )
        .bind(request.transfer_id)
        .bind(collection_id)
        .bind(replica.id)
        .bind(request.file_id)
        .bind(to_i64(descriptor.size, "file size")?)
        .bind(self.crypto.encrypt_json(
            &data_key,
            &intent,
            &file_transfer_intent_aad(request.transfer_id),
        )?)
        .bind(&object_key)
        .bind(expires_at)
        .execute(&self.pool)
        .await?;
        if inserted.rows_affected() == 0 {
            let existing = self
                .load_download_transfer(collection_id, request.transfer_id, &data_key)
                .await?
                .ok_or_else(|| {
                    ApiError::conflict(
                        "file_transfer_conflict",
                        "The transfer ID is already used outside this collection.",
                    )
                })?;
            if existing.replica_id != replica.id
                || existing.file_id != request.file_id
                || existing.intent != intent
            {
                return Err(ApiError::conflict(
                    "file_transfer_conflict",
                    "The transfer ID was already used for a different download.",
                ));
            }
            return Ok(download_session(&existing, self.blob_store.part_size()));
        }
        Ok(FileTransferSession {
            protocol_version: FILE_TRANSFER_PROTOCOL_VERSION,
            message_type: FileTransferSessionKind::FileTransfer,
            transfer_id: request.transfer_id,
            direction: FileTransferDirection::Download,
            protection: FileTransferProtection::TransportTls,
            strategy: FileTransferStrategy::ObjectRanges {
                part_size: self.blob_store.part_size(),
            },
            total_size: descriptor.size,
            expires_at: expires_at.to_rfc3339(),
            received: Vec::new(),
        })
    }

    pub async fn prepare_file_download_part(
        &self,
        collection_id: Uuid,
        token: &str,
        request: PrepareFileDownloadPartRequest,
        request_origin: Option<&str>,
    ) -> ApiResult<PreparedFilePart> {
        require_file_protocol(request.protocol_version)?;
        let replica = self.authenticate_for_file(collection_id, token).await?;
        let data_key = self.load_collection_key(collection_id).await?;
        let transfer = self
            .load_download_transfer(collection_id, request.transfer_id, &data_key)
            .await?
            .ok_or_else(transfer_not_found)?;
        if transfer.replica_id != replica.id {
            return Err(transfer_not_found());
        }
        if transfer.state != "open" || transfer.expires_at <= Utc::now() {
            return Err(ApiError::conflict(
                "file_transfer_expired",
                "This file download is no longer open.",
            ));
        }
        authorize_file_access(
            &replica,
            FileAction::Read,
            Some(&transfer.intent.path),
            request_origin,
        )?;
        if transfer.size == 0 {
            return Err(ApiError::bad_request(
                "empty_file_has_no_ranges",
                "An empty file has no download ranges.",
            ));
        }
        let part_size = self.blob_store.part_size();
        let offset = request
            .part_index
            .checked_mul(part_size)
            .ok_or_else(invalid_file_part)?;
        let content_length = part_length(transfer.size, part_size, request.part_index)?;
        let prepared = self
            .blob_store
            .presign_range(&transfer.object_key, offset, content_length)
            .await?;
        Ok(PreparedFilePart {
            protocol_version: FILE_TRANSFER_PROTOCOL_VERSION,
            message_type: PreparedFilePartKind::FilePart,
            transfer_id: transfer.id,
            part_index: request.part_index,
            offset,
            content_length,
            method: prepared.method,
            url: prepared.url,
            headers: prepared.headers,
            expires_at: prepared.expires_at.to_rfc3339(),
        })
    }

    pub async fn file_transfer_status(
        &self,
        collection_id: Uuid,
        token: &str,
        transfer_id: Uuid,
        request_origin: Option<&str>,
    ) -> ApiResult<FileTransferStatus> {
        let replica = self.authenticate_for_file(collection_id, token).await?;
        let data_key = self.load_collection_key(collection_id).await?;
        if let Some(transfer) = self
            .load_upload_transfer(collection_id, transfer_id, &data_key)
            .await?
        {
            if transfer.replica_id != replica.id {
                return Err(transfer_not_found());
            }
            authorize_file_access(
                &replica,
                if transfer.intent.base_revision.is_some() {
                    FileAction::Replace
                } else {
                    FileAction::Add
                },
                Some(&transfer.intent.path),
                request_origin,
            )?;
            let (received, received_bytes) = self.upload_progress(&transfer).await?;
            return Ok(FileTransferStatus {
                protocol_version: FILE_TRANSFER_PROTOCOL_VERSION,
                message_type: FileTransferStatusKind::FileTransferStatus,
                transfer_id,
                state: transfer_state(&transfer)?,
                received,
                received_bytes,
            });
        }
        let transfer = self
            .load_download_transfer(collection_id, transfer_id, &data_key)
            .await?
            .ok_or_else(transfer_not_found)?;
        if transfer.replica_id != replica.id {
            return Err(transfer_not_found());
        }
        authorize_file_access(
            &replica,
            FileAction::Read,
            Some(&transfer.intent.path),
            request_origin,
        )?;
        Ok(FileTransferStatus {
            protocol_version: FILE_TRANSFER_PROTOCOL_VERSION,
            message_type: FileTransferStatusKind::FileTransferStatus,
            transfer_id,
            state: download_transfer_state(&transfer)?,
            received: Vec::new(),
            received_bytes: 0,
        })
    }

    pub async fn commit_file_upload(
        &self,
        collection_id: Uuid,
        token: &str,
        request: CommitFileUploadRequest,
        request_origin: Option<&str>,
    ) -> ApiResult<CommitFileUploadReceipt> {
        require_file_protocol(request.protocol_version)?;
        let replica = self.authenticate_for_file(collection_id, token).await?;
        let data_key = self.load_collection_key(collection_id).await?;
        let mut transfer = self
            .load_upload_transfer(collection_id, request.transfer_id, &data_key)
            .await?
            .ok_or_else(transfer_not_found)?;
        if transfer.replica_id != replica.id {
            return Err(transfer_not_found());
        }
        let action = if transfer.intent.base_revision.is_some() {
            FileAction::Replace
        } else {
            FileAction::Add
        };
        authorize_file_access(
            &replica,
            action,
            Some(&transfer.intent.path),
            request_origin,
        )?;
        if let Some(receipt) = transfer.receipt {
            return Ok(receipt);
        }
        if transfer.expires_at <= Utc::now() {
            self.expire_upload(&transfer).await?;
            return Err(ApiError::conflict(
                "file_transfer_expired",
                "This file upload has expired.",
            ));
        }
        let completion = self
            .validate_upload_completion(&transfer, &request.parts)
            .await?;
        if transfer.state == "open" {
            let parts_value = serde_json::to_value(&request.parts).map_err(|error| {
                ApiError::internal(format!("Upload completion could not serialize: {error}"))
            })?;
            let updated = sqlx::query(
                r#"UPDATE hosted_provider_file_transfers
                   SET state = 'completing', completion_parts = $2, updated_at = now()
                   WHERE id = $1 AND state = 'open'"#,
            )
            .bind(transfer.id)
            .bind(parts_value)
            .execute(&self.pool)
            .await?;
            if updated.rows_affected() == 0 {
                transfer = self
                    .load_upload_transfer(collection_id, request.transfer_id, &data_key)
                    .await?
                    .ok_or_else(transfer_not_found)?;
                if transfer.completion_parts.as_deref() != Some(request.parts.as_slice()) {
                    return Err(completion_conflict());
                }
            } else {
                transfer.state = "completing".to_string();
                transfer.completion_parts = Some(request.parts.clone());
            }
        } else if transfer.state != "completing"
            || transfer.completion_parts.as_deref() != Some(request.parts.as_slice())
        {
            return Err(completion_conflict());
        }
        self.finalize_upload_object(&transfer, &completion).await?;
        let receipt = self
            .commit_verified_file(&transfer, token, request_origin)
            .await?;
        if let Err(error) = self.blob_store.delete(&transfer.staging_object_key).await {
            tracing::warn!(transfer_id = %transfer.id, %error, "could not remove committed file staging object");
        }
        Ok(receipt)
    }

    pub async fn abort_file_transfer(
        &self,
        collection_id: Uuid,
        token: &str,
        request: AbortFileTransferRequest,
        request_origin: Option<&str>,
    ) -> ApiResult<FileTransferStatus> {
        require_file_protocol(request.protocol_version)?;
        let replica = self.authenticate_for_file(collection_id, token).await?;
        let data_key = self.load_collection_key(collection_id).await?;
        let upload = self
            .load_upload_transfer(collection_id, request.transfer_id, &data_key)
            .await?;
        if upload.is_none() {
            let download = self
                .load_download_transfer(collection_id, request.transfer_id, &data_key)
                .await?
                .ok_or_else(transfer_not_found)?;
            if download.replica_id != replica.id {
                return Err(transfer_not_found());
            }
            authorize_file_access(
                &replica,
                FileAction::Read,
                Some(&download.intent.path),
                request_origin,
            )?;
            sqlx::query(
                r#"UPDATE hosted_provider_file_transfers
                   SET state = 'aborted', updated_at = now()
                   WHERE id = $1 AND state = 'open'"#,
            )
            .bind(download.id)
            .execute(&self.pool)
            .await?;
            return self
                .file_transfer_status(collection_id, token, download.id, request_origin)
                .await;
        }
        let transfer = upload.expect("upload presence was checked");
        if transfer.replica_id != replica.id {
            return Err(transfer_not_found());
        }
        authorize_file_access(
            &replica,
            if transfer.intent.base_revision.is_some() {
                FileAction::Replace
            } else {
                FileAction::Add
            },
            Some(&transfer.intent.path),
            request_origin,
        )?;
        if transfer.state == "committed" {
            return Err(ApiError::conflict(
                "file_transfer_committed",
                "A committed file upload cannot be aborted.",
            ));
        }
        sqlx::query(
            r#"UPDATE hosted_provider_file_transfers
               SET state = 'aborted', updated_at = now()
               WHERE id = $1 AND state IN ('open', 'completing')"#,
        )
        .bind(transfer.id)
        .execute(&self.pool)
        .await?;
        self.cleanup_uncommitted_upload(&transfer).await;
        self.file_transfer_status(collection_id, token, transfer.id, request_origin)
            .await
    }

    async fn upload_progress(&self, transfer: &HostedFileTransfer) -> ApiResult<(Vec<u64>, u64)> {
        if transfer.state == "committed" {
            return Ok((
                (0..upload_part_count(transfer, self.blob_store.part_size())).collect(),
                transfer.expected_size,
            ));
        }
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
            "object_multipart" if transfer.state == "completing" => transfer
                .completion_parts
                .as_deref()
                .unwrap_or_default()
                .iter()
                .map(|part| u64::from(part.part_number - 1))
                .collect(),
            "object_multipart" => self
                .blob_store
                .list_multipart_parts(
                    &transfer.staging_object_key,
                    transfer
                        .multipart_upload_id
                        .as_deref()
                        .ok_or_else(|| ApiError::internal("Multipart upload ID is missing."))?,
                )
                .await?
                .into_iter()
                .map(|part| (part.part_number - 1) as u64)
                .collect(),
            _ => return Err(ApiError::internal("Stored upload strategy is invalid.")),
        };
        let mut received_bytes = 0_u64;
        for index in &received {
            received_bytes = received_bytes
                .checked_add(part_length(
                    transfer.expected_size,
                    strategy_part_size(transfer, self.blob_store.part_size())?,
                    *index,
                )?)
                .ok_or_else(|| ApiError::internal("Uploaded byte count overflowed."))?;
        }
        Ok((received, received_bytes))
    }

    async fn validate_upload_completion(
        &self,
        transfer: &HostedFileTransfer,
        parts: &[UploadedFilePart],
    ) -> ApiResult<Vec<BlobUploadedPart>> {
        match transfer.strategy.as_str() {
            "object_put" => {
                if !parts.is_empty()
                    || !self
                        .blob_store
                        .object_exists(&transfer.staging_object_key)
                        .await?
                {
                    return Err(upload_incomplete());
                }
                Ok(Vec::new())
            }
            "object_multipart" => {
                let expected_count = upload_part_count(transfer, self.blob_store.part_size());
                if parts.len() as u64 != expected_count
                    || parts.iter().enumerate().any(|(index, part)| {
                        usize::from(part.part_number) != index + 1 || part.etag.is_empty()
                    })
                {
                    return Err(upload_incomplete());
                }
                if transfer.state == "completing" {
                    if transfer.completion_parts.as_deref() != Some(parts) {
                        return Err(completion_conflict());
                    }
                    return Ok(parts
                        .iter()
                        .map(|part| BlobUploadedPart {
                            part_number: i32::from(part.part_number),
                            etag: part.etag.clone(),
                        })
                        .collect());
                }
                let actual =
                    self.blob_store
                        .list_multipart_parts(
                            &transfer.staging_object_key,
                            transfer.multipart_upload_id.as_deref().ok_or_else(|| {
                                ApiError::internal("Multipart upload ID is missing.")
                            })?,
                        )
                        .await?;
                if actual.len() != parts.len()
                    || actual.iter().zip(parts).any(|(actual, declared)| {
                        actual.part_number != i32::from(declared.part_number)
                            || actual.etag != declared.etag
                    })
                {
                    return Err(upload_incomplete());
                }
                let prepared = sqlx::query(
                    r#"SELECT part_number, content_length
                       FROM hosted_provider_file_transfer_parts
                       WHERE transfer_id = $1 ORDER BY part_number"#,
                )
                .bind(transfer.id)
                .fetch_all(&self.pool)
                .await?;
                if prepared.len() != parts.len()
                    || prepared.iter().enumerate().any(|(index, row)| {
                        let number: i32 = row.get("part_number");
                        let length: i64 = row.get("content_length");
                        number != index as i32 + 1
                            || u64::try_from(length).ok()
                                != part_length(
                                    transfer.expected_size,
                                    self.blob_store.part_size(),
                                    index as u64,
                                )
                                .ok()
                    })
                {
                    return Err(upload_incomplete());
                }
                Ok(actual)
            }
            _ => Err(ApiError::internal("Stored upload strategy is invalid.")),
        }
    }

    async fn finalize_upload_object(
        &self,
        transfer: &HostedFileTransfer,
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
                    &transfer.intent.content_digest,
                )
                .await;
        }
        if !self
            .blob_store
            .object_exists(&transfer.staging_object_key)
            .await?
        {
            if transfer.strategy != "object_multipart" {
                return Err(upload_incomplete());
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
                &transfer.intent.content_digest,
            )
            .await?;
        self.blob_store
            .copy(&transfer.staging_object_key, &transfer.committed_object_key)
            .await?;
        self.blob_store
            .verify_object(
                &transfer.committed_object_key,
                transfer.expected_size,
                &transfer.intent.content_digest,
            )
            .await
    }

    async fn commit_verified_file(
        &self,
        transfer: &HostedFileTransfer,
        token: &str,
        request_origin: Option<&str>,
    ) -> ApiResult<CommitFileUploadReceipt> {
        let mut transaction = self.pool.begin().await?;
        let replica_row = sqlx::query(
            r#"SELECT id, purpose, mode, allowed_types, contract_scope, full_collection,
                      allowed_operations, file_capability, allowed_origin, proof_public_key,
                      grant_id, scope_epoch
               FROM hosted_provider_replicas
               WHERE collection_id = $1 AND token_hash = $2
                 AND revoked_at IS NULL AND token_expires_at > now()
               FOR SHARE"#,
        )
        .bind(transfer.collection_id)
        .bind(token_hash(token))
        .fetch_optional(&mut *transaction)
        .await?;
        let replica = replica_from_row(replica_row)?;
        if replica.id != transfer.replica_id {
            return Err(transfer_not_found());
        }
        let collection = sqlx::query(
            r#"SELECT head, file_count, file_bytes, stored_file_bytes, max_files,
                      max_file_bytes, max_stored_file_bytes, wrapped_data_key
               FROM hosted_provider_collections
               WHERE id = $1 AND state = 'active' FOR UPDATE"#,
        )
        .bind(transfer.collection_id)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or_else(hosted_collection_not_found)?;
        let data_key =
            self.collection_key(transfer.collection_id, collection.get("wrapped_data_key"))?;
        let locked_transfer = sqlx::query(
            "SELECT state, receipt_ciphertext FROM hosted_provider_file_transfers WHERE id = $1 FOR UPDATE",
        )
        .bind(transfer.id)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or_else(transfer_not_found)?;
        if let Some(ciphertext) = locked_transfer.get::<Option<Vec<u8>>, _>("receipt_ciphertext") {
            let receipt = self.crypto.decrypt_json(
                &data_key,
                &ciphertext,
                &file_transfer_receipt_aad(transfer.id),
            )?;
            transaction.commit().await?;
            return Ok(receipt);
        }
        if locked_transfer.get::<String, _>("state") != "completing" {
            return Err(ApiError::conflict(
                "file_transfer_not_completing",
                "This file upload is not ready to commit.",
            ));
        }
        let path_key = portable_file_path_key(&transfer.intent.path);
        let path_token = path_token(&data_key, &path_key);
        let current_row = sqlx::query(
            r#"SELECT file_id, revision, size, object_key, payload_ciphertext, sequence
               FROM hosted_provider_files
               WHERE collection_id = $1 AND path_token = $2 FOR UPDATE"#,
        )
        .bind(transfer.collection_id)
        .bind(&path_token)
        .fetch_optional(&mut *transaction)
        .await?;
        let current = current_row
            .as_ref()
            .map(|row| decode_current_file(&self.crypto, &data_key, transfer.collection_id, row))
            .transpose()?;
        let action = if current.is_some() {
            FileAction::Replace
        } else {
            FileAction::Add
        };
        authorize_file_access(
            &replica,
            action,
            Some(&transfer.intent.path),
            request_origin,
        )?;
        match (&current, transfer.intent.base_revision.as_deref()) {
            (Some((descriptor, _, _, _)), Some(base))
                if descriptor.revision == base && descriptor.file_id == transfer.file_id => {}
            (None, None) => {}
            _ => return Err(stale_file_revision()),
        }
        let old_size = current
            .as_ref()
            .map_or(0, |(descriptor, _, _, _)| descriptor.size);
        let file_count = number(collection.get("file_count"), "file count")?;
        let file_bytes = number(collection.get("file_bytes"), "current file bytes")?;
        let stored_file_bytes = number(collection.get("stored_file_bytes"), "stored file bytes")?;
        let next_count = file_count
            .checked_add(u64::from(current.is_none()))
            .ok_or_else(|| ApiError::internal("File count overflowed."))?;
        let next_bytes = file_bytes
            .checked_sub(old_size)
            .and_then(|bytes| bytes.checked_add(transfer.expected_size))
            .ok_or_else(|| ApiError::internal("Current file byte count overflowed."))?;
        let next_stored_bytes = stored_file_bytes
            .checked_add(transfer.expected_size)
            .ok_or_else(|| ApiError::internal("Stored file byte count overflowed."))?;
        if next_count > number(collection.get("max_files"), "file quota")?
            || next_bytes > number(collection.get("max_file_bytes"), "current file byte quota")?
            || next_stored_bytes
                > number(
                    collection.get("max_stored_file_bytes"),
                    "stored file byte quota",
                )?
        {
            return Err(ApiError::quota(
                "file_storage_quota_exceeded",
                "The hosted collection does not have enough file storage for this upload.",
            ));
        }
        let head = number(collection.get("head"), "collection head")?;
        let sequence = head
            .checked_add(1)
            .ok_or_else(|| ApiError::internal("Collection sequence overflowed."))?;
        let revision = format!("file:{}", Uuid::now_v7());
        let payload = HostedFilePayload {
            path: transfer.intent.path.clone(),
            content_digest: transfer.intent.content_digest.clone(),
            media_type: transfer.intent.media_type.clone(),
            media_class: transfer.intent.media_class,
            modified_at: Utc::now().to_rfc3339(),
        };
        let current_ciphertext = self.crypto.encrypt_json(
            &data_key,
            &payload,
            &current_file_aad(transfer.collection_id, transfer.file_id, sequence),
        )?;
        let version_ciphertext = self.crypto.encrypt_json(
            &data_key,
            &payload,
            &file_version_aad(transfer.collection_id, transfer.file_id, sequence),
        )?;
        let before_ciphertext = current
            .as_ref()
            .map(|(descriptor, _, _, _)| {
                self.crypto.encrypt_json(
                    &data_key,
                    &payload_from_descriptor(descriptor),
                    &change_file_aad(transfer.collection_id, sequence, "before"),
                )
            })
            .transpose()?;
        let after_ciphertext = self.crypto.encrypt_json(
            &data_key,
            &payload,
            &change_file_aad(transfer.collection_id, sequence, "after"),
        )?;
        sqlx::query(
            r#"INSERT INTO hosted_provider_files
                 (collection_id, file_id, path_token, revision, size, object_key,
                  payload_ciphertext, sequence)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
               ON CONFLICT (collection_id, file_id) DO UPDATE SET
                 path_token = EXCLUDED.path_token,
                 revision = EXCLUDED.revision,
                 size = EXCLUDED.size,
                 object_key = EXCLUDED.object_key,
                 payload_ciphertext = EXCLUDED.payload_ciphertext,
                 sequence = EXCLUDED.sequence,
                 updated_at = now()"#,
        )
        .bind(transfer.collection_id)
        .bind(transfer.file_id)
        .bind(path_token)
        .bind(&revision)
        .bind(to_i64(transfer.expected_size, "file size")?)
        .bind(&transfer.committed_object_key)
        .bind(current_ciphertext)
        .bind(to_i64(sequence, "collection sequence")?)
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            r#"INSERT INTO hosted_provider_file_versions
                 (collection_id, file_id, sequence, revision, size, object_key,
                  payload_ciphertext, deleted)
               VALUES ($1, $2, $3, $4, $5, $6, $7, false)"#,
        )
        .bind(transfer.collection_id)
        .bind(transfer.file_id)
        .bind(to_i64(sequence, "collection sequence")?)
        .bind(&revision)
        .bind(to_i64(transfer.expected_size, "file size")?)
        .bind(&transfer.committed_object_key)
        .bind(version_ciphertext)
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            r#"INSERT INTO hosted_provider_file_changes
                 (collection_id, sequence, file_id, revision, before_size,
                  before_object_key, before_ciphertext, after_size,
                  after_object_key, after_ciphertext)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)"#,
        )
        .bind(transfer.collection_id)
        .bind(to_i64(sequence, "collection sequence")?)
        .bind(transfer.file_id)
        .bind(&revision)
        .bind(current.as_ref().map(|(file, _, _, _)| file.size as i64))
        .bind(current.as_ref().map(|(_, key, _, _)| key))
        .bind(before_ciphertext)
        .bind(to_i64(transfer.expected_size, "file size")?)
        .bind(&transfer.committed_object_key)
        .bind(after_ciphertext)
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            r#"UPDATE hosted_provider_collections
               SET head = $2, file_count = $3, file_bytes = $4,
                   stored_file_bytes = $5, updated_at = now()
               WHERE id = $1"#,
        )
        .bind(transfer.collection_id)
        .bind(to_i64(sequence, "collection sequence")?)
        .bind(to_i64(next_count, "file count")?)
        .bind(to_i64(next_bytes, "current file bytes")?)
        .bind(to_i64(next_stored_bytes, "stored file bytes")?)
        .execute(&mut *transaction)
        .await?;
        let receipt = CommitFileUploadReceipt {
            protocol_version: FILE_PROTOCOL_VERSION,
            message_type: CommitFileUploadReceiptKind::FileUploadCommitted,
            transfer_id: transfer.id,
            file: descriptor(transfer.file_id, revision, transfer.expected_size, payload),
        };
        let receipt_ciphertext = self.crypto.encrypt_json(
            &data_key,
            &receipt,
            &file_transfer_receipt_aad(transfer.id),
        )?;
        let updated = sqlx::query(
            r#"UPDATE hosted_provider_file_transfers
               SET state = 'committed', receipt_ciphertext = $2, updated_at = now()
               WHERE id = $1 AND state = 'completing'"#,
        )
        .bind(transfer.id)
        .bind(receipt_ciphertext)
        .execute(&mut *transaction)
        .await?;
        if updated.rows_affected() != 1 {
            return Err(ApiError::conflict(
                "file_transfer_not_completing",
                "This file upload was concurrently cancelled.",
            ));
        }
        transaction.commit().await?;
        Ok(receipt)
    }

    async fn expire_upload(&self, transfer: &HostedFileTransfer) -> ApiResult<()> {
        sqlx::query(
            r#"UPDATE hosted_provider_file_transfers
               SET state = 'expired', updated_at = now()
               WHERE id = $1 AND state IN ('open', 'completing')"#,
        )
        .bind(transfer.id)
        .execute(&self.pool)
        .await?;
        self.cleanup_uncommitted_upload(transfer).await;
        Ok(())
    }

    async fn cleanup_uncommitted_upload(&self, transfer: &HostedFileTransfer) {
        if let Some(upload_id) = transfer.multipart_upload_id.as_deref() {
            if let Err(error) = self
                .blob_store
                .abort_multipart(&transfer.staging_object_key, upload_id)
                .await
            {
                tracing::warn!(transfer_id = %transfer.id, %error, "could not abort R2 multipart upload");
            }
        }
        for key in [&transfer.staging_object_key, &transfer.committed_object_key] {
            if let Err(error) = self.blob_store.delete(key).await {
                tracing::warn!(transfer_id = %transfer.id, %error, "could not delete uncommitted R2 object");
            }
        }
    }

    async fn authenticate_for_file(&self, collection_id: Uuid, token: &str) -> ApiResult<Replica> {
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

    async fn load_collection_key(&self, collection_id: Uuid) -> ApiResult<[u8; 32]> {
        let wrapped: Vec<u8> = sqlx::query_scalar(
            "SELECT wrapped_data_key FROM hosted_provider_collections WHERE id = $1 AND state = 'active'",
        )
        .bind(collection_id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(hosted_collection_not_found)?;
        self.collection_key(collection_id, &wrapped)
    }

    async fn load_current_file(
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

    async fn load_upload_transfer(
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

    async fn load_download_transfer(
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

    async fn upload_session(
        &self,
        transfer: &HostedFileTransfer,
    ) -> ApiResult<FileTransferSession> {
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
            "object_multipart" => self
                .blob_store
                .list_multipart_parts(
                    &transfer.staging_object_key,
                    transfer
                        .multipart_upload_id
                        .as_deref()
                        .ok_or_else(|| ApiError::internal("Multipart upload ID is missing."))?,
                )
                .await?
                .into_iter()
                .map(|part| (part.part_number - 1) as u64)
                .collect(),
            _ => return Err(ApiError::internal("Stored upload strategy is invalid.")),
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
                    part_size: self.blob_store.part_size(),
                },
                _ => return Err(ApiError::internal("Stored upload strategy is invalid.")),
            },
            total_size: transfer.expected_size,
            expires_at: transfer.expires_at.to_rfc3339(),
            received,
        })
    }
}

fn decode_current_file(
    crypto: &ProviderCrypto,
    data_key: &[u8; 32],
    collection_id: Uuid,
    row: &PgRow,
) -> ApiResult<(CollectionFileDescriptor, String, u64, Vec<u8>)> {
    let file_id: Uuid = row.get("file_id");
    let sequence = number(row.get("sequence"), "file sequence")?;
    let payload: HostedFilePayload = crypto.decrypt_json(
        data_key,
        row.get("payload_ciphertext"),
        &current_file_aad(collection_id, file_id, sequence),
    )?;
    let size = number(row.get("size"), "file size")?;
    let revision: String = row.get("revision");
    Ok((
        descriptor(file_id, revision, size, payload),
        row.get("object_key"),
        sequence,
        row.get("payload_ciphertext"),
    ))
}

fn decode_download_file(
    crypto: &ProviderCrypto,
    data_key: &[u8; 32],
    collection_id: Uuid,
    row: &PgRow,
    is_version: bool,
) -> ApiResult<(CollectionFileDescriptor, String)> {
    let file_id: Uuid = row.get("file_id");
    let sequence = number(row.get("sequence"), "file sequence")?;
    let payload_aad = if is_version {
        file_version_aad(collection_id, file_id, sequence)
    } else {
        current_file_aad(collection_id, file_id, sequence)
    };
    let payload: HostedFilePayload =
        crypto.decrypt_json(data_key, row.get("payload_ciphertext"), &payload_aad)?;
    Ok((
        descriptor(
            file_id,
            row.get("revision"),
            number(row.get("size"), "file size")?,
            payload,
        ),
        row.get("object_key"),
    ))
}

fn decode_upload_transfer(
    provider: &HostedProvider,
    data_key: &[u8; 32],
    row: PgRow,
) -> ApiResult<HostedFileTransfer> {
    let id: Uuid = row.get("id");
    Ok(HostedFileTransfer {
        id,
        collection_id: row.get("collection_id"),
        replica_id: row.get("replica_id"),
        state: row.get("state"),
        strategy: row.get("strategy"),
        file_id: row.get("file_id"),
        expected_size: number(row.get("expected_size"), "file size")?,
        intent: provider.crypto.decrypt_json(
            data_key,
            row.get("intent_ciphertext"),
            &file_transfer_intent_aad(id),
        )?,
        staging_object_key: row
            .get::<Option<String>, _>("staging_object_key")
            .ok_or_else(|| ApiError::internal("Upload staging object key is missing."))?,
        committed_object_key: row.get("committed_object_key"),
        multipart_upload_id: row.get("multipart_upload_id"),
        completion_parts: row
            .get::<Option<Value>, _>("completion_parts")
            .map(serde_json::from_value)
            .transpose()
            .map_err(|error| {
                ApiError::internal(format!("Stored upload parts are invalid: {error}"))
            })?,
        receipt: row
            .get::<Option<Vec<u8>>, _>("receipt_ciphertext")
            .map(|receipt| {
                provider
                    .crypto
                    .decrypt_json(data_key, &receipt, &file_transfer_receipt_aad(id))
            })
            .transpose()?,
        expires_at: row.get("expires_at"),
    })
}

pub(super) fn descriptor(
    file_id: Uuid,
    revision: String,
    size: u64,
    payload: HostedFilePayload,
) -> CollectionFileDescriptor {
    CollectionFileDescriptor {
        file_id,
        path: payload.path,
        revision,
        content_digest: payload.content_digest,
        size,
        media_type: payload.media_type,
        media_class: payload.media_class,
        modified_at: payload.modified_at,
    }
}

fn download_session(transfer: &HostedDownloadTransfer, part_size: u64) -> FileTransferSession {
    FileTransferSession {
        protocol_version: FILE_TRANSFER_PROTOCOL_VERSION,
        message_type: FileTransferSessionKind::FileTransfer,
        transfer_id: transfer.id,
        direction: FileTransferDirection::Download,
        protection: FileTransferProtection::TransportTls,
        strategy: FileTransferStrategy::ObjectRanges { part_size },
        total_size: transfer.size,
        expires_at: transfer.expires_at.to_rfc3339(),
        received: Vec::new(),
    }
}

fn payload_from_descriptor(file: &CollectionFileDescriptor) -> HostedFilePayload {
    HostedFilePayload {
        path: file.path.clone(),
        content_digest: file.content_digest.clone(),
        media_type: file.media_type.clone(),
        media_class: file.media_class,
        modified_at: file.modified_at.clone(),
    }
}

fn strategy_part_size(transfer: &HostedFileTransfer, multipart_part_size: u64) -> ApiResult<u64> {
    match transfer.strategy.as_str() {
        "object_put" => Ok(transfer.expected_size.max(1)),
        "object_multipart" => Ok(multipart_part_size),
        _ => Err(ApiError::internal("Stored upload strategy is invalid.")),
    }
}

fn upload_part_count(transfer: &HostedFileTransfer, multipart_part_size: u64) -> u64 {
    match transfer.strategy.as_str() {
        "object_put" => 1,
        "object_multipart" => transfer.expected_size.div_ceil(multipart_part_size),
        _ => 0,
    }
}

fn part_length(total_size: u64, part_size: u64, part_index: u64) -> ApiResult<u64> {
    let offset = part_index
        .checked_mul(part_size)
        .ok_or_else(invalid_file_part)?;
    if offset >= total_size && total_size != 0 {
        return Err(invalid_file_part());
    }
    Ok(total_size.saturating_sub(offset).min(part_size))
}

fn transfer_state(transfer: &HostedFileTransfer) -> ApiResult<FileTransferState> {
    Ok(match transfer.state.as_str() {
        "open" | "completing" => {
            if transfer.expires_at <= Utc::now() {
                FileTransferState::Expired
            } else {
                FileTransferState::Open
            }
        }
        "committed" => FileTransferState::Committed,
        "aborted" => FileTransferState::Aborted,
        "expired" => FileTransferState::Expired,
        _ => return Err(ApiError::internal("Stored file transfer state is invalid.")),
    })
}

fn download_transfer_state(transfer: &HostedDownloadTransfer) -> ApiResult<FileTransferState> {
    Ok(match transfer.state.as_str() {
        "open" if transfer.expires_at > Utc::now() => FileTransferState::Open,
        "open" | "expired" => FileTransferState::Expired,
        "aborted" => FileTransferState::Aborted,
        _ => {
            return Err(ApiError::internal(
                "Stored download transfer state is invalid.",
            ))
        }
    })
}

fn expected_upload_part(
    transfer: &HostedFileTransfer,
    multipart_part_size: u64,
    part_number: u16,
) -> ApiResult<(u64, u64, u64)> {
    if part_number == 0 {
        return Err(invalid_file_part());
    }
    let part_index = u64::from(part_number - 1);
    let part_size = match transfer.strategy.as_str() {
        "object_put" if part_number == 1 => transfer.expected_size,
        "object_put" => return Err(invalid_file_part()),
        "object_multipart" => multipart_part_size,
        _ => return Err(ApiError::internal("Stored upload strategy is invalid.")),
    };
    let offset = part_index
        .checked_mul(part_size)
        .ok_or_else(invalid_file_part)?;
    if offset >= transfer.expected_size && transfer.expected_size != 0 {
        return Err(invalid_file_part());
    }
    if transfer.expected_size == 0 && part_number != 1 {
        return Err(invalid_file_part());
    }
    Ok((
        part_index,
        offset,
        transfer.expected_size.saturating_sub(offset).min(part_size),
    ))
}

fn assert_open_transfer(transfer: &HostedFileTransfer, replica_id: Uuid) -> ApiResult<()> {
    if transfer.replica_id != replica_id {
        return Err(transfer_not_found());
    }
    if transfer.state != "open" {
        return Err(ApiError::conflict(
            "file_transfer_not_open",
            "This file upload no longer accepts parts.",
        ));
    }
    if transfer.expires_at <= Utc::now() {
        return Err(ApiError::conflict(
            "file_transfer_expired",
            "This file upload has expired.",
        ));
    }
    Ok(())
}

fn assert_same_upload_request(
    transfer: &HostedFileTransfer,
    request: &OpenFileUploadRequest,
    replica_id: Uuid,
) -> ApiResult<()> {
    let media_type = request
        .media_type
        .clone()
        .or_else(|| classify_media(&request.path).1);
    if transfer.replica_id != replica_id
        || transfer.expected_size != request.size
        || transfer.intent.path != request.path
        || transfer.intent.content_digest != request.content_digest
        || transfer.intent.media_type != media_type
        || transfer.intent.base_revision != request.if_revision
    {
        return Err(ApiError::conflict(
            "file_transfer_conflict",
            "The transfer ID was already used for a different upload.",
        ));
    }
    Ok(())
}

fn require_file_protocol(version: u32) -> ApiResult<()> {
    if version == FILE_PROTOCOL_VERSION {
        Ok(())
    } else {
        Err(ApiError::bad_request(
            "unsupported_file_protocol",
            "This hosted provider supports file protocol 1.",
        ))
    }
}

fn validate_hosted_folder_path(path: &str) -> ApiResult<()> {
    validate_hosted_file_path(&format!("{path}/placeholder.bin"))
}

fn validate_content_digest(value: &str) -> ApiResult<()> {
    crate::blob_store::parse_sha256_digest(value).map(|_| ())
}

fn validate_media_type(value: Option<&str>) -> ApiResult<()> {
    if value.is_some_and(|value| {
        value.trim().is_empty() || value.len() > 255 || value.contains(['\r', '\n'])
    }) {
        Err(ApiError::bad_request(
            "invalid_media_type",
            "File media types must be one non-empty value of at most 255 bytes.",
        ))
    } else {
        Ok(())
    }
}

fn classify_media(path: &str) -> (FileMediaClass, Option<String>) {
    let extension = path.rsplit_once('.').map_or("", |(_, extension)| extension);
    let (class, media_type) = match extension.to_ascii_lowercase().as_str() {
        "avif" => (FileMediaClass::Image, "image/avif"),
        "bmp" => (FileMediaClass::Image, "image/bmp"),
        "gif" => (FileMediaClass::Image, "image/gif"),
        "jpeg" | "jpg" => (FileMediaClass::Image, "image/jpeg"),
        "png" => (FileMediaClass::Image, "image/png"),
        "svg" => (FileMediaClass::Image, "image/svg+xml"),
        "webp" => (FileMediaClass::Image, "image/webp"),
        "flac" => (FileMediaClass::Audio, "audio/flac"),
        "m4a" => (FileMediaClass::Audio, "audio/mp4"),
        "mp3" => (FileMediaClass::Audio, "audio/mpeg"),
        "oga" | "ogg" => (FileMediaClass::Audio, "audio/ogg"),
        "opus" => (FileMediaClass::Audio, "audio/opus"),
        "wav" => (FileMediaClass::Audio, "audio/wav"),
        "3gp" => (FileMediaClass::Video, "video/3gpp"),
        "mkv" => (FileMediaClass::Video, "video/x-matroska"),
        "mov" => (FileMediaClass::Video, "video/quicktime"),
        "mp4" => (FileMediaClass::Video, "video/mp4"),
        "webm" => (FileMediaClass::Video, "video/webm"),
        "pdf" => (FileMediaClass::Pdf, "application/pdf"),
        _ => return (FileMediaClass::Other, None),
    };
    (class, Some(media_type.to_string()))
}

fn hosted_collection_not_found() -> ApiError {
    ApiError::not_found(
        "hosted_collection_not_found",
        "Hosted collection not found.",
    )
}

fn stale_file_revision() -> ApiError {
    ApiError::conflict(
        "stale_file_revision",
        "The file changed since the caller's base revision.",
    )
}

fn transfer_not_found() -> ApiError {
    ApiError::not_found("file_transfer_not_found", "File upload not found.")
}

fn invalid_file_part() -> ApiError {
    ApiError::bad_request(
        "invalid_file_part",
        "The requested upload part is outside this transfer.",
    )
}

fn upload_incomplete() -> ApiError {
    ApiError::conflict(
        "file_upload_incomplete",
        "Every expected file part must be uploaded before commit.",
    )
}

fn completion_conflict() -> ApiError {
    ApiError::conflict(
        "file_completion_conflict",
        "This upload was already completed with a different part manifest.",
    )
}
