use super::*;
use crate::collection_files::{classify_media, portable_path_key};
use chrono::{Duration, SecondsFormat, Utc};
use mdbase::runtime::CollectionSnapshot;
use mdbase_connect_protocol::{
    CommitFileUploadReceipt, CommitFileUploadReceiptKind, FileTransferDirection,
    FileTransferProtection, FileTransferSession, FileTransferSessionKind, FileTransferState,
    FileTransferStatus, FileTransferStatusKind, FileTransferStrategy, OpenFileDownloadRequest,
    OpenFileUploadRequest, DEFAULT_FILE_CHUNK_BYTES, FILE_PROTOCOL_VERSION,
    FILE_TRANSFER_PROTOCOL_VERSION,
};
use rusqlite::Transaction;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};

mod download;
mod lifecycle;
use download::{download_staging_path, download_transfer_status, required_download};
mod routing;
use routing::{transfer_direction, transfer_exists, upload_session};
mod security;
use security::{set_owner_only_directory, set_owner_only_file};

const STAGING_DIRECTORY: &str = ".mdbase/file-staging";
const TRANSFER_LIFETIME_HOURS: i64 = 24;
const MAX_WIRE_FILE_BYTES: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone)]
pub(super) struct UploadTransfer {
    pub(super) transfer_id: Uuid,
    collection_id: Uuid,
    state: String,
    file_id: Uuid,
    path: String,
    path_key: String,
    pub(super) expected_size: u64,
    expected_digest: String,
    media_type: Option<String>,
    base_revision: Option<String>,
    pub(super) chunk_size: u32,
    staging_name: String,
    receipt: Option<CommitFileUploadReceipt>,
    pub(super) expires_at: chrono::DateTime<Utc>,
}

impl CollectionRegistry {
    pub(super) fn recover_file_transfers(&self) -> Result<(), ConnectError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT collection_id, transfer_id, direction, state
             FROM collection_file_transfers
             WHERE state = 'committing'
                OR (state = 'open' AND expires_at <= ?1)
             ORDER BY created_at",
        )?;
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let rows = statement.query_map([now], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?;
        let pending = rows.collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        drop(connection);
        for (collection_id, transfer_id, direction, state) in pending {
            let collection_id = parse_uuid(&collection_id, "collection")?;
            let transfer_id = parse_uuid(&transfer_id, "transfer")?;
            let registered = self.get(collection_id)?;
            if !Path::new(&registered.path).is_dir() {
                continue;
            }
            if direction == "upload" && state == "committing" {
                self.commit_file_upload_internal(collection_id, None, transfer_id)?;
            } else if direction == "upload" {
                let transfer =
                    required_upload(&self.connection()?, collection_id, None, transfer_id)?;
                self.expire_upload(&registered, &transfer)?;
            } else {
                let transfer =
                    required_download(&self.connection()?, collection_id, None, transfer_id)?;
                self.expire_download(&registered, &transfer)?;
            }
        }
        Ok(())
    }

    pub fn open_file_upload(
        &self,
        id: Uuid,
        owner_id: Uuid,
        request: &OpenFileUploadRequest,
    ) -> Result<FileTransferSession, ConnectError> {
        require_file_protocol(request.protocol_version)?;
        validate_digest(&request.content_digest)?;
        if request.size > MAX_WIRE_FILE_BYTES {
            return Err(file_error(
                "invalid_file_size",
                "The file size is outside the protocol's safe integer range.",
            ));
        }
        if request.media_type.as_deref().is_some_and(|value| {
            value.trim().is_empty() || value.len() > 255 || value.contains(['\r', '\n'])
        }) {
            return Err(file_error(
                "invalid_media_type",
                "A file media type must be a single non-empty value of at most 255 bytes.",
            ));
        }
        let registered = self.get(id)?;
        if !registered.enabled {
            return Err(ConnectError::AccessDenied(
                "This collection is disabled on its computer.".to_string(),
            ));
        }
        let provider = self.provider_for(&registered)?;
        provider.with_collection_read(|collection| {
            crate::LocalSyncStore::for_registry(self).assert_mutation_allowed(id)?;
            let snapshot = collection.snapshot()?;
            self.reconcile_files_loaded(&registered, collection, &snapshot)?;
            validate_target_path(
                collection,
                Path::new(&registered.path),
                &snapshot,
                &request.path,
            )?;
            self.create_upload_transfer(&registered, owner_id, request)
        })
    }

    pub fn put_file_upload_chunk(
        &self,
        id: Uuid,
        owner_id: Uuid,
        transfer_id: Uuid,
        chunk_index: u64,
        bytes: &[u8],
    ) -> Result<FileTransferStatus, ConnectError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let transfer = required_upload(&transaction, id, Some(owner_id), transfer_id)?;
        if !ensure_transfer_open(&transaction, &transfer)? {
            transaction.commit()?;
            let registered = self.get(id)?;
            remove_file_if_present(&transfer_staging_path(
                Path::new(&registered.path),
                &transfer,
            )?)?;
            return Err(file_error("transfer_expired", "This file upload expired."));
        }
        let expected =
            expected_chunk_length(transfer.expected_size, transfer.chunk_size, chunk_index)?;
        if bytes.len() != expected as usize {
            return Err(file_error(
                "invalid_chunk_length",
                format!("Chunk {chunk_index} must contain exactly {expected} plaintext bytes."),
            ));
        }
        let digest = sha256_digest(bytes);
        let prior = transaction
            .query_row(
                "SELECT chunk_digest FROM collection_file_transfer_chunks
                 WHERE transfer_id = ?1 AND chunk_index = ?2",
                params![transfer_id.to_string(), chunk_index],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if let Some(prior) = prior {
            if prior != digest {
                return Err(file_error(
                    "chunk_conflict",
                    "A retry used different bytes for an already accepted chunk.",
                ));
            }
            let status = transfer_status(&transaction, &transfer)?;
            transaction.commit()?;
            return Ok(status);
        }

        let registered = self.get(id)?;
        let staging = transfer_staging_path(Path::new(&registered.path), &transfer)?;
        let mut file = open_verified_file(&staging, true)?;
        file.seek(SeekFrom::Start(
            chunk_index
                .checked_mul(u64::from(transfer.chunk_size))
                .ok_or_else(|| file_error("invalid_chunk_index", "Chunk offset overflowed."))?,
        ))?;
        file.write_all(bytes)?;
        file.sync_data()?;
        verify_open_path(&file, &staging)?;
        transaction.execute(
            "INSERT INTO collection_file_transfer_chunks
               (transfer_id, chunk_index, chunk_digest, byte_length)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                transfer_id.to_string(),
                chunk_index,
                digest,
                bytes.len() as u64,
            ],
        )?;
        let status = transfer_status(&transaction, &transfer)?;
        transaction.commit()?;
        Ok(status)
    }

    pub fn file_transfer_status(
        &self,
        id: Uuid,
        owner_id: Uuid,
        transfer_id: Uuid,
    ) -> Result<FileTransferStatus, ConnectError> {
        let connection = self.connection()?;
        let direction = transfer_direction(&connection, id, owner_id, transfer_id)?;
        if direction == "upload" {
            transfer_status(
                &connection,
                &required_upload(&connection, id, Some(owner_id), transfer_id)?,
            )
        } else {
            download_transfer_status(&required_download(
                &connection,
                id,
                Some(owner_id),
                transfer_id,
            )?)
        }
    }

    pub fn commit_file_upload(
        &self,
        id: Uuid,
        owner_id: Uuid,
        transfer_id: Uuid,
    ) -> Result<CommitFileUploadReceipt, ConnectError> {
        self.commit_file_upload_internal(id, Some(owner_id), transfer_id)
    }

    fn commit_file_upload_internal(
        &self,
        id: Uuid,
        owner_id: Option<Uuid>,
        transfer_id: Uuid,
    ) -> Result<CommitFileUploadReceipt, ConnectError> {
        let registered = self.get(id)?;
        let provider = self.provider_for(&registered)?;
        provider.with_collection(|collection| {
            crate::LocalSyncStore::for_registry(self).assert_mutation_allowed(id)?;
            let transfer = required_upload(&self.connection()?, id, owner_id, transfer_id)?;
            if let Some(receipt) = transfer.receipt.clone() {
                return Ok(receipt);
            }
            if transfer.state != "open" && transfer.state != "committing" {
                return Err(file_error(
                    "transfer_not_open",
                    "This file upload no longer accepts commit.",
                ));
            }
            if transfer.expires_at <= Utc::now() {
                self.expire_upload(&registered, &transfer)?;
                return Err(file_error("transfer_expired", "This file upload expired."));
            }

            let snapshot = collection.snapshot()?;
            validate_target_path(
                collection,
                Path::new(&registered.path),
                &snapshot,
                &transfer.path,
            )?;
            if transfer.state == "open" {
                self.reconcile_files_loaded(&registered, collection, &snapshot)?;
                recheck_upload_intent(self, &transfer)?;
            }
            assert_upload_complete(self, &transfer)?;
            let staging = transfer_staging_path(Path::new(&registered.path), &transfer)?;
            let destination = prepare_destination(Path::new(&registered.path), &transfer.path)?;
            let content_path = if staging.exists() {
                &staging
            } else {
                &destination
            };
            if hash_exact_file(content_path, transfer.expected_size)? != transfer.expected_digest {
                return Err(file_error(
                    "content_digest_mismatch",
                    "The staged file does not match its declared SHA-256 digest.",
                ));
            }

            if transfer.state == "open" {
                self.connection()?.execute(
                    "UPDATE collection_file_transfers SET state = 'committing'
                     WHERE transfer_id = ?1 AND state = 'open'",
                    [transfer_id.to_string()],
                )?;
            }
            if staging.exists() {
                fs::rename(&staging, &destination)?;
                sync_parent(&destination)?;
            } else if hash_exact_file(&destination, transfer.expected_size)?
                != transfer.expected_digest
            {
                return Err(file_error(
                    "staging_file_missing",
                    "The staged upload is missing and the destination is not the committed content.",
                ));
            }

            let after_snapshot = collection.snapshot()?;
            let preferences = crate::registry::files::FileReconcilePreferences {
                ids_by_path: HashMap::from([(transfer.path_key.clone(), transfer.file_id)]),
                ..Default::default()
            };
            let files = self.reconcile_files_loaded_with_preferences(
                &registered,
                collection,
                &after_snapshot,
                &preferences,
            )?;
            let file = files
                .into_iter()
                .find(|file| file.file_id == transfer.file_id)
                .ok_or_else(|| {
                    file_error(
                        "file_commit_failed",
                        "The committed file did not appear in the authority index.",
                    )
                })?;
            let receipt = CommitFileUploadReceipt {
                protocol_version: FILE_PROTOCOL_VERSION,
                message_type: CommitFileUploadReceiptKind::FileUploadCommitted,
                transfer_id,
                file,
            };
            self.connection()?.execute(
                "UPDATE collection_file_transfers
                 SET state = 'committed', receipt = ?2
                 WHERE transfer_id = ?1",
                params![transfer_id.to_string(), serde_json::to_string(&receipt)?],
            )?;
            Ok(receipt)
        })
    }

    pub fn abort_file_transfer(
        &self,
        id: Uuid,
        owner_id: Uuid,
        transfer_id: Uuid,
    ) -> Result<FileTransferStatus, ConnectError> {
        let connection = self.connection()?;
        let direction = transfer_direction(&connection, id, owner_id, transfer_id)?;
        let (state, staging) = if direction == "upload" {
            let transfer = required_upload(&connection, id, Some(owner_id), transfer_id)?;
            let registered = self.get(id)?;
            let staging = transfer_staging_path(Path::new(&registered.path), &transfer)?;
            (transfer.state, staging)
        } else {
            let transfer = required_download(&connection, id, Some(owner_id), transfer_id)?;
            let registered = self.get(id)?;
            let staging = download_staging_path(Path::new(&registered.path), &transfer)?;
            (transfer.state, staging)
        };
        if state == "committed" {
            return Err(file_error(
                "transfer_already_committed",
                "A committed file upload cannot be aborted.",
            ));
        }
        remove_file_if_present(&staging)?;
        connection.execute(
            "UPDATE collection_file_transfers SET state = 'aborted'
             WHERE transfer_id = ?1 AND owner_id = ?2 AND state <> 'committed'",
            params![transfer_id.to_string(), owner_id.to_string()],
        )?;
        self.file_transfer_status(id, owner_id, transfer_id)
    }

    fn create_upload_transfer(
        &self,
        registered: &CollectionSummary,
        owner_id: Uuid,
        request: &OpenFileUploadRequest,
    ) -> Result<FileTransferSession, ConnectError> {
        if transfer_exists(&self.connection()?, request.transfer_id)? {
            let connection = self.connection()?;
            let transfer = required_upload(
                &connection,
                registered.id,
                Some(owner_id),
                request.transfer_id,
            )?;
            if transfer.path != request.path
                || transfer.expected_size != request.size
                || transfer.expected_digest != request.content_digest
                || transfer.base_revision != request.if_revision
                || request
                    .media_type
                    .as_ref()
                    .is_some_and(|value| transfer.media_type.as_ref() != Some(value))
            {
                return Err(file_error(
                    "transfer_conflict",
                    "This transfer ID was already opened with different upload intent.",
                ));
            }
            let status = transfer_status(&connection, &transfer)?;
            return Ok(upload_session(&transfer, status.received));
        }
        let path_key = portable_path_key(&request.path);
        let current = self
            .indexed_files(registered.id)?
            .into_iter()
            .find(|file| portable_path_key(&file.path) == path_key);
        let file_id = match current {
            Some(current) => {
                if current.path != request.path {
                    return Err(file_error(
                        "path_alias",
                        "The requested path aliases an existing file on a supported filesystem.",
                    ));
                }
                if request.if_revision.as_deref() != Some(current.revision.as_str()) {
                    return Err(file_error(
                        "stale_file_revision",
                        "Replacing a file requires its current revision.",
                    ));
                }
                current.file_id
            }
            None => {
                if request.if_revision.is_some() {
                    return Err(file_error(
                        "stale_file_revision",
                        "The requested replacement target does not exist.",
                    ));
                }
                Uuid::now_v7()
            }
        };
        let transfer_id = request.transfer_id;
        let staging_name = format!("{transfer_id}.part");
        let staging_root = ensure_staging_root(Path::new(&registered.path))?;
        let staging = staging_root.join(&staging_name);
        create_private_staging_file(&staging)?;
        let created_at = Utc::now();
        let expires_at = created_at + Duration::hours(TRANSFER_LIFETIME_HOURS);
        let (_, inferred_media_type) = classify_media(&request.path);
        let inserted = self.connection()?.execute(
            "INSERT INTO collection_file_transfers
               (transfer_id, collection_id, owner_id, direction, state, file_id, path, path_key,
                expected_size, expected_digest, media_type, base_revision, chunk_size,
                staging_path, created_at, expires_at)
             VALUES (?1, ?2, ?3, 'upload', 'open', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
                     ?12, ?13, ?14)",
            params![
                transfer_id.to_string(),
                registered.id.to_string(),
                owner_id.to_string(),
                file_id.to_string(),
                request.path,
                path_key,
                request.size,
                request.content_digest,
                request.media_type.as_ref().or(inferred_media_type.as_ref()),
                request.if_revision,
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
        Ok(upload_session(
            &required_upload(
                &self.connection()?,
                registered.id,
                Some(owner_id),
                transfer_id,
            )?,
            Vec::new(),
        ))
    }

    fn expire_upload(
        &self,
        registered: &CollectionSummary,
        transfer: &UploadTransfer,
    ) -> Result<(), ConnectError> {
        remove_file_if_present(&transfer_staging_path(
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

fn required_upload(
    connection: &Connection,
    collection_id: Uuid,
    owner_id: Option<Uuid>,
    transfer_id: Uuid,
) -> Result<UploadTransfer, ConnectError> {
    connection
        .query_row(
            "SELECT owner_id, state, file_id, path, path_key, expected_size, expected_digest,
                    media_type, base_revision, chunk_size, staging_path, receipt, expires_at
             FROM collection_file_transfers
             WHERE transfer_id = ?1 AND collection_id = ?2 AND direction = 'upload'",
            params![transfer_id.to_string(), collection_id.to_string()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, u64>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, u32>(9)?,
                    row.get::<_, Option<String>>(10)?,
                    row.get::<_, Option<String>>(11)?,
                    row.get::<_, String>(12)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| file_error("transfer_not_found", "The file upload was not found."))
        .and_then(
            |(
                stored_owner_id,
                state,
                file_id,
                path,
                path_key,
                expected_size,
                expected_digest,
                media_type,
                base_revision,
                chunk_size,
                staging_name,
                receipt,
                expires_at,
            )| {
                let stored_owner_id = parse_uuid(&stored_owner_id, "transfer owner")?;
                if owner_id.is_some_and(|expected| expected != stored_owner_id) {
                    return Err(file_error(
                        "transfer_not_found",
                        "The file upload was not found.",
                    ));
                }
                Ok(UploadTransfer {
                    transfer_id,
                    collection_id,
                    state,
                    file_id: parse_uuid(&file_id, "file")?,
                    path,
                    path_key,
                    expected_size,
                    expected_digest,
                    media_type,
                    base_revision,
                    chunk_size,
                    staging_name: staging_name.ok_or_else(|| {
                        file_error("transfer_corrupt", "The upload staging path is missing.")
                    })?,
                    receipt: receipt.as_deref().map(serde_json::from_str).transpose()?,
                    expires_at: chrono::DateTime::parse_from_rfc3339(&expires_at)
                        .map_err(|_| {
                            file_error("transfer_corrupt", "The upload expiry is invalid.")
                        })?
                        .with_timezone(&Utc),
                })
            },
        )
}

fn ensure_transfer_open(
    transaction: &Transaction<'_>,
    transfer: &UploadTransfer,
) -> Result<bool, ConnectError> {
    if transfer.state != "open" {
        return Err(file_error(
            "transfer_not_open",
            "This file upload no longer accepts chunks.",
        ));
    }
    if transfer.expires_at <= Utc::now() {
        transaction.execute(
            "UPDATE collection_file_transfers SET state = 'expired'
             WHERE transfer_id = ?1 AND state = 'open'",
            [transfer.transfer_id.to_string()],
        )?;
        return Ok(false);
    }
    Ok(true)
}

fn transfer_status(
    connection: &Connection,
    transfer: &UploadTransfer,
) -> Result<FileTransferStatus, ConnectError> {
    let mut statement = connection.prepare(
        "SELECT chunk_index, byte_length FROM collection_file_transfer_chunks
         WHERE transfer_id = ?1 ORDER BY chunk_index",
    )?;
    let rows = statement.query_map([transfer.transfer_id.to_string()], |row| {
        Ok((row.get::<_, u64>(0)?, row.get::<_, u64>(1)?))
    })?;
    let chunks = rows.collect::<Result<Vec<_>, _>>()?;
    Ok(FileTransferStatus {
        protocol_version: FILE_TRANSFER_PROTOCOL_VERSION,
        message_type: FileTransferStatusKind::FileTransferStatus,
        transfer_id: transfer.transfer_id,
        state: match transfer.state.as_str() {
            "open" | "committing" => FileTransferState::Open,
            "committed" => FileTransferState::Committed,
            "aborted" => FileTransferState::Aborted,
            "expired" => FileTransferState::Expired,
            _ => {
                return Err(file_error(
                    "transfer_corrupt",
                    "The file upload has an invalid state.",
                ))
            }
        },
        received: chunks.iter().map(|(index, _)| *index).collect(),
        received_bytes: chunks.iter().map(|(_, length)| *length).sum(),
    })
}

fn assert_upload_complete(
    registry: &CollectionRegistry,
    transfer: &UploadTransfer,
) -> Result<(), ConnectError> {
    let status = transfer_status(&registry.connection()?, transfer)?;
    let expected_chunks = chunk_count(transfer.expected_size, transfer.chunk_size);
    if status.received_bytes != transfer.expected_size
        || status.received.len() as u64 != expected_chunks
        || status
            .received
            .iter()
            .enumerate()
            .any(|(position, index)| *index != position as u64)
    {
        return Err(file_error(
            "transfer_incomplete",
            "Every file chunk must be accepted before commit.",
        ));
    }
    Ok(())
}

fn recheck_upload_intent(
    registry: &CollectionRegistry,
    transfer: &UploadTransfer,
) -> Result<(), ConnectError> {
    let current = registry
        .indexed_files(transfer.collection_id)?
        .into_iter()
        .find(|file| portable_path_key(&file.path) == transfer.path_key);
    match (current, transfer.base_revision.as_deref()) {
        (Some(current), Some(base))
            if current.file_id == transfer.file_id && current.revision == base =>
        {
            Ok(())
        }
        (None, None) => Ok(()),
        _ => Err(file_error(
            "stale_file_revision",
            "The destination changed after this upload was opened.",
        )),
    }
}

fn expected_chunk_length(
    total_size: u64,
    chunk_size: u32,
    chunk_index: u64,
) -> Result<u32, ConnectError> {
    let offset = chunk_index
        .checked_mul(u64::from(chunk_size))
        .ok_or_else(|| file_error("invalid_chunk_index", "Chunk offset overflowed."))?;
    if offset >= total_size {
        return Err(file_error(
            "invalid_chunk_index",
            "The chunk index is outside this file upload.",
        ));
    }
    Ok((total_size - offset).min(u64::from(chunk_size)) as u32)
}

fn chunk_count(total_size: u64, chunk_size: u32) -> u64 {
    total_size.div_ceil(u64::from(chunk_size))
}

fn validate_target_path(
    collection: &mdbase::Collection,
    root: &Path,
    snapshot: &CollectionSnapshot,
    relative: &str,
) -> Result<(), ConnectError> {
    collection.validate_file_path(relative).map_err(|error| {
        file_error(
            "unsafe_file_path",
            format!("The destination is outside the collection file namespace: {error}."),
        )
    })?;
    let components = relative.split('/').collect::<Vec<_>>();
    let managed = snapshot
        .resources
        .iter()
        .map(|resource| portable_path_key(&resource.path))
        .chain(
            snapshot
                .records
                .iter()
                .map(|record| portable_path_key(&record.path)),
        )
        .collect::<BTreeSet<_>>();
    if managed.contains(&portable_path_key(relative)) {
        return Err(file_error(
            "path_occupied",
            "The destination belongs to a record or structural resource.",
        ));
    }
    let mut directory = root.to_path_buf();
    for component in &components[..components.len().saturating_sub(1)] {
        directory.push(component);
        if let Ok(metadata) = fs::symlink_metadata(&directory) {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(file_error(
                    "unsafe_file_path",
                    "A destination parent is not a regular collection directory.",
                ));
            }
            if directory.join("mdbase.yaml").is_file() {
                return Err(file_error(
                    "nested_collection_excluded",
                    "Files cannot be written into a nested collection.",
                ));
            }
        }
    }
    let destination = root.join(relative);
    if let Ok(metadata) = fs::symlink_metadata(destination) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(file_error(
                "unsafe_file_path",
                "The destination is not a regular file.",
            ));
        }
    }
    Ok(())
}

fn prepare_destination(root: &Path, relative: &str) -> Result<PathBuf, ConnectError> {
    let destination = root.join(relative);
    let parent = destination
        .parent()
        .ok_or_else(|| file_error("unsafe_file_path", "The destination has no parent."))?;
    let mut current = root.to_path_buf();
    if let Ok(relative_parent) = parent.strip_prefix(root) {
        for component in relative_parent.components() {
            current.push(component);
            match fs::symlink_metadata(&current) {
                Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
                Ok(_) => {
                    return Err(file_error(
                        "unsafe_file_path",
                        "A destination parent is not a regular collection directory.",
                    ))
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    fs::create_dir(&current)?;
                }
                Err(error) => return Err(error.into()),
            }
        }
    }
    if fs::symlink_metadata(&destination)
        .is_ok_and(|metadata| metadata.file_type().is_symlink() || !metadata.is_file())
    {
        return Err(file_error(
            "unsafe_file_path",
            "The destination is not a regular file.",
        ));
    }
    Ok(destination)
}

fn ensure_staging_root(root: &Path) -> Result<PathBuf, ConnectError> {
    let metadata_root = root.join(".mdbase");
    match fs::symlink_metadata(&metadata_root) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
        Ok(_) => {
            return Err(file_error(
                "unsafe_staging_path",
                "The collection metadata directory is not a regular directory.",
            ))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&metadata_root)?;
            set_owner_only_directory(&metadata_root)?;
        }
        Err(error) => return Err(error.into()),
    }
    let staging = root.join(STAGING_DIRECTORY);
    match fs::symlink_metadata(&staging) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
        Ok(_) => {
            return Err(file_error(
                "unsafe_staging_path",
                "The file staging path is not a regular directory.",
            ))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&staging)?;
            set_owner_only_directory(&staging)?;
        }
        Err(error) => return Err(error.into()),
    }
    Ok(staging)
}

fn transfer_staging_path(root: &Path, transfer: &UploadTransfer) -> Result<PathBuf, ConnectError> {
    let expected = format!("{}.part", transfer.transfer_id);
    if transfer.staging_name != expected {
        return Err(file_error(
            "transfer_corrupt",
            "The upload staging path is invalid.",
        ));
    }
    Ok(ensure_staging_root(root)?.join(expected))
}

fn create_private_staging_file(path: &Path) -> Result<(), ConnectError> {
    let file = OpenOptions::new().create_new(true).write(true).open(path)?;
    set_owner_only_file(path)?;
    file.sync_all()?;
    sync_parent(path)
}

fn hash_exact_file(path: &Path, expected_size: u64) -> Result<String, ConnectError> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() != expected_size {
        return Err(file_error(
            "staging_file_invalid",
            "The staged file is missing, unsafe, or has the wrong size.",
        ));
    }
    let mut file = open_verified_file(path, false)?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 128 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    verify_open_path(&file, path)?;
    Ok(format!("sha256:{:x}", digest.finalize()))
}

fn open_verified_file(path: &Path, writable: bool) -> Result<File, ConnectError> {
    let before = fs::symlink_metadata(path)?;
    if before.file_type().is_symlink() || !before.is_file() {
        return Err(file_error(
            "unsafe_file_path",
            "A transfer file is not a regular file.",
        ));
    }
    let file = OpenOptions::new().read(true).write(writable).open(path)?;
    if !same_file(&before, &file.metadata()?) {
        return Err(file_error(
            "file_changed_during_read",
            "A transfer file changed while it was being opened.",
        ));
    }
    Ok(file)
}

fn verify_open_path(file: &File, path: &Path) -> Result<(), ConnectError> {
    let live = fs::symlink_metadata(path)?;
    if live.file_type().is_symlink() || !same_file(&file.metadata()?, &live) {
        return Err(file_error(
            "file_changed_during_read",
            "A transfer file changed while it was being accessed.",
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn same_file(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    left.is_file()
        && right.is_file()
        && left.nlink() == 1
        && right.nlink() == 1
        && left.dev() == right.dev()
        && left.ino() == right.ino()
}

#[cfg(not(unix))]
fn same_file(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    left.is_file() && right.is_file() && left.len() == right.len()
}

fn require_file_protocol(version: u32) -> Result<(), ConnectError> {
    if version != FILE_PROTOCOL_VERSION {
        return Err(file_error(
            "unsupported_file_protocol",
            format!("File protocol version {version} is not supported."),
        ));
    }
    Ok(())
}

fn validate_digest(value: &str) -> Result<(), ConnectError> {
    if value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Ok(());
    }
    Err(file_error(
        "invalid_content_digest",
        "A file content digest must be lowercase sha256 followed by 64 hex characters.",
    ))
}

fn sha256_digest(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn parse_uuid(value: &str, kind: &str) -> Result<Uuid, ConnectError> {
    Uuid::parse_str(value).map_err(|_| {
        file_error(
            "transfer_corrupt",
            format!("The upload {kind} ID is invalid."),
        )
    })
}

fn remove_file_if_present(path: &Path) -> Result<(), ConnectError> {
    match fs::remove_file(path) {
        Ok(()) => sync_parent(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn sync_parent(path: &Path) -> Result<(), ConnectError> {
    #[cfg(unix)]
    if let Some(parent) = path.parent() {
        File::open(parent)?.sync_all()?;
    }
    Ok(())
}

fn file_error(code: impl Into<String>, message: impl Into<String>) -> ConnectError {
    ConnectError::File {
        code: code.into(),
        message: message.into(),
    }
}

#[cfg(test)]
mod tests;
