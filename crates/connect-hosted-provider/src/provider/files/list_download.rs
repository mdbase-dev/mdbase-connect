use super::*;

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
            return Ok(download_session(
                &existing,
                self.blob_store.download_part_size(),
            ));
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
            return Ok(download_session(
                &existing,
                self.blob_store.download_part_size(),
            ));
        }
        Ok(FileTransferSession {
            protocol_version: FILE_TRANSFER_PROTOCOL_VERSION,
            message_type: FileTransferSessionKind::FileTransfer,
            transfer_id: request.transfer_id,
            direction: FileTransferDirection::Download,
            protection: FileTransferProtection::TransportTls,
            strategy: FileTransferStrategy::ObjectRanges {
                part_size: self.blob_store.download_part_size(),
            },
            total_size: descriptor.size,
            expires_at: expires_at.to_rfc3339(),
            received: Vec::new(),
            uploaded_parts: Vec::new(),
        })
    }

    pub(crate) async fn download_file_part(
        &self,
        collection_id: Uuid,
        token: &str,
        transfer_id: Uuid,
        part_index: u64,
        request_origin: Option<&str>,
    ) -> ApiResult<HostedFileDownload> {
        let replica = self.authenticate_for_file(collection_id, token).await?;
        let data_key = self.load_collection_key(collection_id).await?;
        let transfer = self
            .load_download_transfer(collection_id, transfer_id, &data_key)
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
        let part_size = self.blob_store.download_part_size();
        let offset = part_index
            .checked_mul(part_size)
            .ok_or_else(invalid_file_part)?;
        let content_length = part_length(transfer.size, part_size, part_index)?;
        let body = self
            .blob_store
            .read_range(&transfer.object_key, offset, content_length)
            .await?;
        Ok(HostedFileDownload {
            body,
            content_length,
        })
    }
}
