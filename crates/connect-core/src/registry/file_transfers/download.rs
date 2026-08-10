use super::*;

#[derive(Debug, Clone)]
pub(super) struct DownloadTransfer {
    transfer_id: Uuid,
    pub(super) state: String,
    file_id: Uuid,
    pub(super) path: String,
    expected_size: u64,
    revision: String,
    chunk_size: u32,
    staging_name: String,
    expires_at: chrono::DateTime<Utc>,
}

impl CollectionRegistry {
    pub fn open_file_download(
        &self,
        id: Uuid,
        owner_id: Uuid,
        request: &OpenFileDownloadRequest,
        authorize_path: impl Fn(&str) -> Result<(), ConnectError>,
    ) -> Result<FileTransferSession, ConnectError> {
        require_file_protocol(request.protocol_version)?;
        if transfer_exists(&self.connection()?, request.transfer_id)? {
            let transfer =
                required_download(&self.connection()?, id, Some(owner_id), request.transfer_id)?;
            if transfer.file_id != request.file_id
                || request
                    .revision
                    .as_ref()
                    .is_some_and(|revision| revision != &transfer.revision)
            {
                return Err(file_error(
                    "transfer_conflict",
                    "This transfer ID was already opened for a different file revision.",
                ));
            }
            authorize_path(&transfer.path)?;
            return Ok(download_session(&transfer));
        }
        let registered = self.get(id)?;
        if !registered.enabled {
            return Err(ConnectError::AccessDenied(
                "This collection is disabled on its computer.".to_string(),
            ));
        }
        crate::LocalSyncStore::for_registry(self).assert_authority_available(id)?;
        // The descriptor came from the durable file inventory. Do not refresh the
        // entire collection while opening one download: a watcher-driven warmup may
        // be hashing unrelated multi-gigabyte files and holds the reconcile lock.
        // The snapshot copy below re-verifies the selected file's exact size and
        // digest before any bytes are released, so a stale inventory still fails
        // closed with file_changed_during_read.
        let descriptor = self
            .indexed_files(id)?
            .into_iter()
            .find(|file| file.file_id == request.file_id)
            .ok_or_else(|| {
                file_error(
                    "file_revision_not_found",
                    "The requested file revision is no longer available locally.",
                )
            })?;
        match self.indexed_file_location(&registered, descriptor.file_id)? {
            super::super::files::IndexedFileLocation::Current => {}
            super::super::files::IndexedFileLocation::Moved(path) => {
                authorize_path(&path)?;
                return Err(file_error(
                    "file_revision_not_found",
                    "The file moved after it was listed; list files again before downloading.",
                ));
            }
            super::super::files::IndexedFileLocation::Missing => {
                return Err(file_error(
                    "file_revision_not_found",
                    "The requested file revision is no longer available locally.",
                ));
            }
        }
        if request
            .revision
            .as_ref()
            .is_some_and(|revision| revision != &descriptor.revision)
        {
            return Err(file_error(
                "file_revision_not_found",
                "The requested file revision is no longer available locally.",
            ));
        }
        authorize_path(&descriptor.path)?;
        let staging_name = format!("{}.download", request.transfer_id);
        let staging = ensure_staging_root(Path::new(&registered.path))?.join(&staging_name);
        remove_file_if_present(&staging)?;
        create_private_staging_file(&staging)?;
        let source = Path::new(&registered.path).join(&descriptor.path);
        if let Err(error) = copy_verified_download(
            &source,
            &staging,
            descriptor.size,
            &descriptor.content_digest,
        ) {
            let _ = remove_file_if_present(&staging);
            return Err(error);
        }
        let created_at = Utc::now();
        let expires_at = created_at + Duration::hours(TRANSFER_LIFETIME_HOURS);
        let path_key = portable_path_key(&descriptor.path);
        let inserted = self.connection()?.execute(
            "INSERT INTO collection_file_transfers
               (transfer_id, collection_id, owner_id, direction, state, file_id, path,
                path_key, expected_size, expected_digest, media_type, base_revision,
                chunk_size, staging_path, created_at, expires_at)
             VALUES (?1, ?2, ?3, 'download', 'open', ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                     ?11, ?12, ?13, ?14)",
            params![
                request.transfer_id.to_string(),
                id.to_string(),
                owner_id.to_string(),
                descriptor.file_id.to_string(),
                descriptor.path,
                path_key,
                descriptor.size,
                descriptor.content_digest,
                descriptor.media_type,
                descriptor.revision,
                DEFAULT_FILE_CHUNK_BYTES,
                staging_name,
                created_at.to_rfc3339_opts(SecondsFormat::Millis, true),
                expires_at.to_rfc3339_opts(SecondsFormat::Millis, true),
            ],
        );
        if let Err(error) = inserted {
            let _ = remove_file_if_present(&staging);
            return Err(error.into());
        }
        Ok(download_session(&required_download(
            &self.connection()?,
            id,
            Some(owner_id),
            request.transfer_id,
        )?))
    }

    pub fn read_file_download_chunk(
        &self,
        id: Uuid,
        owner_id: Uuid,
        transfer_id: Uuid,
        chunk_index: u64,
    ) -> Result<Vec<u8>, ConnectError> {
        let connection = self.connection()?;
        let transfer = required_download(&connection, id, Some(owner_id), transfer_id)?;
        if transfer.state != "open" {
            return Err(file_error(
                "transfer_not_open",
                "This file download no longer accepts reads.",
            ));
        }
        let registered = self.get(id)?;
        if transfer.expires_at <= Utc::now() {
            drop(connection);
            self.expire_download(&registered, &transfer)?;
            return Err(file_error(
                "transfer_expired",
                "This file download expired.",
            ));
        }
        let length =
            expected_chunk_length(transfer.expected_size, transfer.chunk_size, chunk_index)?;
        let staging = download_staging_path(Path::new(&registered.path), &transfer)?;
        let mut file = open_verified_file(&staging, false)?;
        file.seek(SeekFrom::Start(
            chunk_index
                .checked_mul(u64::from(transfer.chunk_size))
                .ok_or_else(|| file_error("invalid_chunk_index", "Chunk offset overflowed."))?,
        ))?;
        let mut bytes = vec![0; length as usize];
        file.read_exact(&mut bytes)?;
        verify_open_path(&file, &staging)?;
        Ok(bytes)
    }

    pub(super) fn expire_download(
        &self,
        registered: &CollectionSummary,
        transfer: &DownloadTransfer,
    ) -> Result<(), ConnectError> {
        remove_file_if_present(&download_staging_path(
            Path::new(&registered.path),
            transfer,
        )?)?;
        self.connection()?.execute(
            "UPDATE collection_file_transfers SET state = 'expired'
             WHERE transfer_id = ?1 AND state = 'open'",
            [transfer.transfer_id.to_string()],
        )?;
        Ok(())
    }
}

pub(super) fn required_download(
    connection: &Connection,
    collection_id: Uuid,
    owner_id: Option<Uuid>,
    transfer_id: Uuid,
) -> Result<DownloadTransfer, ConnectError> {
    connection
        .query_row(
            "SELECT owner_id, state, file_id, path, expected_size, base_revision,
                    chunk_size, staging_path, expires_at
             FROM collection_file_transfers
             WHERE transfer_id = ?1 AND collection_id = ?2 AND direction = 'download'",
            params![transfer_id.to_string(), collection_id.to_string()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, u64>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, u32>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, String>(8)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| file_error("transfer_not_found", "The file download was not found."))
        .and_then(
            |(
                stored_owner_id,
                state,
                file_id,
                path,
                expected_size,
                revision,
                chunk_size,
                staging_name,
                expires_at,
            )| {
                let stored_owner_id = parse_uuid(&stored_owner_id, "transfer owner")?;
                if owner_id.is_some_and(|expected| expected != stored_owner_id) {
                    return Err(file_error(
                        "transfer_not_found",
                        "The file download was not found.",
                    ));
                }
                Ok(DownloadTransfer {
                    transfer_id,
                    state,
                    file_id: parse_uuid(&file_id, "file")?,
                    path,
                    expected_size,
                    revision,
                    chunk_size,
                    staging_name: staging_name.ok_or_else(|| {
                        file_error("transfer_corrupt", "The download staging path is missing.")
                    })?,
                    expires_at: chrono::DateTime::parse_from_rfc3339(&expires_at)
                        .map_err(|_| {
                            file_error("transfer_corrupt", "The download expiry is invalid.")
                        })?
                        .with_timezone(&Utc),
                })
            },
        )
}

pub(super) fn download_session(transfer: &DownloadTransfer) -> FileTransferSession {
    FileTransferSession {
        protocol_version: FILE_TRANSFER_PROTOCOL_VERSION,
        message_type: FileTransferSessionKind::FileTransfer,
        transfer_id: transfer.transfer_id,
        direction: FileTransferDirection::Download,
        protection: FileTransferProtection::GrantAeadV1,
        strategy: FileTransferStrategy::FramedChunks {
            chunk_size: transfer.chunk_size,
        },
        total_size: transfer.expected_size,
        expires_at: transfer
            .expires_at
            .to_rfc3339_opts(SecondsFormat::Millis, true),
        received: Vec::new(),
        uploaded_parts: Vec::new(),
    }
}

pub(super) fn download_transfer_status(
    transfer: &DownloadTransfer,
) -> Result<FileTransferStatus, ConnectError> {
    Ok(FileTransferStatus {
        protocol_version: FILE_TRANSFER_PROTOCOL_VERSION,
        message_type: FileTransferStatusKind::FileTransferStatus,
        transfer_id: transfer.transfer_id,
        state: match transfer.state.as_str() {
            "open" => FileTransferState::Open,
            "aborted" => FileTransferState::Aborted,
            "expired" => FileTransferState::Expired,
            _ => {
                return Err(file_error(
                    "transfer_corrupt",
                    "The file download has an invalid state.",
                ))
            }
        },
        received: Vec::new(),
        received_bytes: 0,
        uploaded_parts: Vec::new(),
    })
}

pub(super) fn download_staging_path(
    root: &Path,
    transfer: &DownloadTransfer,
) -> Result<PathBuf, ConnectError> {
    let expected = format!("{}.download", transfer.transfer_id);
    if transfer.staging_name != expected {
        return Err(file_error(
            "transfer_corrupt",
            "The download staging path is invalid.",
        ));
    }
    Ok(ensure_staging_root(root)?.join(expected))
}

fn copy_verified_download(
    source: &Path,
    staging: &Path,
    expected_size: u64,
    expected_digest: &str,
) -> Result<(), ConnectError> {
    let mut source_file = open_verified_file(source, false)?;
    let mut staging_file = open_verified_file(staging, true)?;
    let copied = std::io::copy(&mut source_file, &mut staging_file)?;
    staging_file.sync_all()?;
    verify_open_path(&source_file, source)?;
    verify_open_path(&staging_file, staging)?;
    if copied != expected_size || hash_exact_file(staging, expected_size)? != expected_digest {
        return Err(file_error(
            "file_changed_during_read",
            "The requested file changed while its download was being prepared.",
        ));
    }
    Ok(())
}
