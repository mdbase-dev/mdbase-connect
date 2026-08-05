use super::*;
use mdbase_connect_protocol::{
    AbortFileTransferRequest, CommitFileUploadRequest, DeleteFileRequest, FileAction, FileFrame,
    FileFrameHeader, FileFrameKind, FileScope, FileTransferBinding, FileTransferCipher,
    FileTransferDirection, FileTransferProtection, FileTransferStrategy,
    GetFileTransferStatusRequest, ListFilesPage, ListFilesPageKind, ListFilesRequest,
    MoveFileRequest, OpenFileDownloadRequest, OpenFileUploadRequest, RelayFileFrame,
    RelayFileHeader, RelayFileKind, FILE_PROTOCOL_VERSION, FILE_TRANSFER_PROTOCOL_VERSION,
    RELAY_FILE_PROTOCOL_VERSION,
};

impl AgentState {
    pub(super) fn file_control(
        &self,
        grant: &mdbase_connect_protocol::GrantSummary,
        input: serde_json::Value,
    ) -> Result<serde_json::Value, ConnectError> {
        let message_type = input
            .get("type")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| {
                local_file_error(
                    "invalid_file_request",
                    "File control requires a message type.",
                )
            })?;
        match message_type {
            "list_files" => {
                let request: ListFilesRequest = parse_file_control(input)?;
                let limit = validate_list_request(&request)?;
                let capability = require_file_action(grant, FileAction::List)?;
                let (inventory_revision, mut scan_after) = if let Some(cursor) =
                    request.after.as_deref()
                {
                    let (revision, path) = parse_local_file_cursor(cursor)?;
                    if self.registry.file_index_revision(grant.collection_id)? != revision {
                        return Err(local_file_error(
                                "file_list_changed",
                                "The local file inventory changed while it was being listed; restart the listing.",
                            ));
                    }
                    (revision, Some(path.to_string()))
                } else {
                    (
                        self.registry
                            .refresh_file_index_if_needed(grant.collection_id)?,
                        None,
                    )
                };
                let batch_size = limit.saturating_add(1).clamp(128, 1_001);
                let mut files = Vec::with_capacity(limit.saturating_add(1));
                while files.len() <= limit {
                    let batch = self.registry.indexed_files_page(
                        grant.collection_id,
                        scan_after.as_deref(),
                        batch_size,
                    )?;
                    let exhausted = batch.len() < batch_size;
                    if let Some(last) = batch.last() {
                        scan_after = Some(last.path.clone());
                    }
                    files.extend(batch.into_iter().filter(|file| {
                        file_visible(capability, &file.path)
                            && request
                                .folder
                                .as_ref()
                                .is_none_or(|folder| path_in_folder(&file.path, folder))
                    }));
                    if files.len() > limit || exhausted {
                        break;
                    }
                }
                let has_more = files.len() > limit;
                files.truncate(limit);
                let next = has_more.then(|| {
                    encode_local_file_cursor(
                        inventory_revision,
                        &files.last().expect("non-empty limited page").path,
                    )
                });
                serde_json::to_value(ListFilesPage {
                    protocol_version: FILE_PROTOCOL_VERSION,
                    message_type: ListFilesPageKind::FilesPage,
                    files,
                    next,
                })
                .map_err(ConnectError::from)
            }
            "open_file_upload" => {
                let request: OpenFileUploadRequest = parse_file_control(input)?;
                let action = if request.if_revision.is_some() {
                    FileAction::Replace
                } else {
                    FileAction::Add
                };
                let capability = require_file_action(grant, action)?;
                require_visible_path(capability, &request.path)?;
                serde_json::to_value(self.registry.open_file_upload(
                    grant.collection_id,
                    grant.id,
                    &request,
                )?)
                .map_err(ConnectError::from)
            }
            "open_file_download" => {
                let request: OpenFileDownloadRequest = parse_file_control(input)?;
                let capability = require_file_action(grant, FileAction::Read)?;
                serde_json::to_value(self.registry.open_file_download(
                    grant.collection_id,
                    grant.id,
                    &request,
                    |path| require_visible_path(capability, path),
                )?)
                .map_err(ConnectError::from)
            }
            "move_file" => {
                let request: MoveFileRequest = parse_file_control(input)?;
                let capability = require_file_action(grant, FileAction::Move)?;
                require_visible_path(capability, &request.from_path)?;
                require_visible_path(capability, &request.path)?;
                let receipt = self
                    .registry
                    .move_file(grant.collection_id, grant.id, &request)?;
                self.watcher.rescan(grant.collection_id);
                serde_json::to_value(receipt).map_err(ConnectError::from)
            }
            "delete_file" => {
                let request: DeleteFileRequest = parse_file_control(input)?;
                let capability = require_file_action(grant, FileAction::Delete)?;
                require_visible_path(capability, &request.path)?;
                let receipt = self
                    .registry
                    .delete_file(grant.collection_id, grant.id, &request)?;
                self.watcher.rescan(grant.collection_id);
                serde_json::to_value(receipt).map_err(ConnectError::from)
            }
            "get_file_transfer_status" => {
                let request: GetFileTransferStatusRequest = parse_file_control(input)?;
                require_control_protocol(request.protocol_version)?;
                self.require_file_transfer_access(grant, request.transfer_id)?;
                serde_json::to_value(self.registry.file_transfer_status(
                    grant.collection_id,
                    grant.id,
                    request.transfer_id,
                )?)
                .map_err(ConnectError::from)
            }
            "commit_file_upload" => {
                let request: CommitFileUploadRequest = parse_file_control(input)?;
                require_control_protocol(request.protocol_version)?;
                if !request.parts.is_empty() {
                    return Err(local_file_error(
                        "invalid_file_request",
                        "Framed uploads do not use object-store completion parts.",
                    ));
                }
                let (path, replacing) = self.registry.file_upload_intent(
                    grant.collection_id,
                    grant.id,
                    request.transfer_id,
                )?;
                let capability = require_file_action(
                    grant,
                    if replacing {
                        FileAction::Replace
                    } else {
                        FileAction::Add
                    },
                )?;
                require_visible_path(capability, &path)?;
                let receipt = self.registry.commit_file_upload(
                    grant.collection_id,
                    grant.id,
                    request.transfer_id,
                )?;
                self.watcher.rescan(grant.collection_id);
                serde_json::to_value(receipt).map_err(ConnectError::from)
            }
            "abort_file_transfer" => {
                let request: AbortFileTransferRequest = parse_file_control(input)?;
                require_control_protocol(request.protocol_version)?;
                self.require_file_transfer_access(grant, request.transfer_id)?;
                serde_json::to_value(self.registry.abort_file_transfer(
                    grant.collection_id,
                    grant.id,
                    request.transfer_id,
                )?)
                .map_err(ConnectError::from)
            }
            _ => Err(local_file_error(
                "invalid_file_request",
                "The file control message type is unsupported.",
            )),
        }
    }

    pub fn handle_direct_file_upload(
        &self,
        origin: &str,
        encoded: &[u8],
    ) -> Result<(), ConnectError> {
        let frame = FileFrame::decode(encoded).map_err(|error| {
            local_file_error(
                "invalid_file_frame",
                format!("The file frame is invalid: {error}"),
            )
        })?;
        self.handle_file_upload(Some(origin), frame)
    }

    pub fn handle_relay_file_frame(&self, request: RelayFileFrame) -> RelayFileFrame {
        let response = match request.kind {
            RelayFileKind::UploadChunk => FileFrame::decode(&request.payload)
                .map_err(|error| {
                    local_file_error(
                        "invalid_file_frame",
                        format!("The relayed file frame is invalid: {error}"),
                    )
                })
                .and_then(|frame| {
                    validate_relay_binding(&request.header, &frame.header)?;
                    self.handle_file_upload(None, frame)
                })
                .map(|()| (RelayFileKind::UploadAcknowledged, Vec::new())),
            RelayFileKind::DownloadRequest => self
                .file_download_chunk(
                    None,
                    request.header.grant_id,
                    request.header.transfer_id,
                    request.header.chunk_index,
                )
                .map(|bytes| (RelayFileKind::DownloadChunk, bytes)),
            _ => Err(local_file_error(
                "invalid_relay_file_message",
                "The relay sent an unexpected file message.",
            )),
        };
        let (kind, payload) = response.unwrap_or_else(|error| {
            tracing::warn!(
                code = error.code(),
                "rejected relayed file transfer message"
            );
            (RelayFileKind::Rejected, Vec::new())
        });
        RelayFileFrame {
            kind,
            header: RelayFileHeader {
                protocol_version: RELAY_FILE_PROTOCOL_VERSION,
                message_type: kind,
                request_id: request.header.request_id,
                grant_id: request.header.grant_id,
                transfer_id: request.header.transfer_id,
                chunk_index: request.header.chunk_index,
            },
            payload,
        }
    }

    fn handle_file_upload(
        &self,
        origin: Option<&str>,
        frame: FileFrame,
    ) -> Result<(), ConnectError> {
        if frame.kind != FileFrameKind::UploadChunk {
            return Err(local_file_error(
                "invalid_file_frame",
                "The upload endpoint requires an upload chunk frame.",
            ));
        }
        let grant = self.file_grant(origin, frame.header.grant_id, FileAction::Add, true)?;
        let session = self.registry.file_transfer_session(
            grant.collection_id,
            grant.id,
            frame.header.transfer_id,
        )?;
        let (path, replacing) = self.registry.file_upload_intent(
            grant.collection_id,
            grant.id,
            frame.header.transfer_id,
        )?;
        let capability = require_file_action(
            &grant,
            if replacing {
                FileAction::Replace
            } else {
                FileAction::Add
            },
        )?;
        require_visible_path(capability, &path)?;
        validate_frame_session(&frame.header, &session)?;
        let cipher = self.file_cipher(
            &grant,
            frame.header.transfer_id,
            FileTransferDirection::Upload,
        )?;
        let plaintext = cipher.decrypt_chunk(&frame).map_err(|_| {
            local_file_error(
                "invalid_file_frame",
                "The upload chunk could not be authenticated.",
            )
        })?;
        self.registry.put_file_upload_chunk(
            grant.collection_id,
            grant.id,
            frame.header.transfer_id,
            frame.header.chunk_index,
            &plaintext,
        )?;
        Ok(())
    }

    pub fn direct_file_download_chunk(
        &self,
        origin: &str,
        grant_id: uuid::Uuid,
        transfer_id: uuid::Uuid,
        chunk_index: u64,
    ) -> Result<Vec<u8>, ConnectError> {
        self.file_download_chunk(Some(origin), grant_id, transfer_id, chunk_index)
    }

    fn file_download_chunk(
        &self,
        origin: Option<&str>,
        grant_id: uuid::Uuid,
        transfer_id: uuid::Uuid,
        chunk_index: u64,
    ) -> Result<Vec<u8>, ConnectError> {
        let grant = self.file_grant(origin, grant_id, FileAction::Read, false)?;
        let path = self
            .registry
            .file_download_path(grant.collection_id, grant.id, transfer_id)?;
        require_visible_path(require_file_action(&grant, FileAction::Read)?, &path)?;
        let session =
            self.registry
                .file_transfer_session(grant.collection_id, grant.id, transfer_id)?;
        let FileTransferStrategy::FramedChunks { chunk_size } = session.strategy else {
            return Err(local_file_error(
                "invalid_file_transfer",
                "The local download did not negotiate framed chunks.",
            ));
        };
        if session.direction != FileTransferDirection::Download
            || session.protection != FileTransferProtection::GrantAeadV1
        {
            return Err(local_file_error(
                "invalid_file_transfer",
                "The local download session is inconsistent.",
            ));
        }
        let bytes = self.registry.read_file_download_chunk(
            grant.collection_id,
            grant.id,
            transfer_id,
            chunk_index,
        )?;
        let offset = chunk_index
            .checked_mul(u64::from(chunk_size))
            .ok_or_else(|| {
                local_file_error("invalid_chunk_index", "The chunk offset overflowed.")
            })?;
        let encryption = grant
            .encryption
            .as_ref()
            .expect("direct file grant is encrypted");
        let header = FileFrameHeader {
            protocol_version: FILE_TRANSFER_PROTOCOL_VERSION,
            protection: FileTransferProtection::GrantAeadV1,
            grant_id: grant.id,
            authority_id: encryption.connector_id,
            collection_id: grant.collection_id,
            transfer_id,
            direction: FileTransferDirection::Download,
            chunk_size,
            chunk_index,
            offset,
            plaintext_length: bytes.len() as u32,
            total_size: session.total_size,
            scope_epoch: encryption.scope_epoch,
            key_id: Some(encryption.key_id.clone()),
        };
        let frame = self
            .file_cipher(&grant, transfer_id, FileTransferDirection::Download)?
            .encrypt_chunk(FileFrameKind::DownloadChunk, header, &bytes)
            .map_err(|_| {
                local_file_error(
                    "file_transfer_failed",
                    "The download chunk could not be protected.",
                )
            })?;
        frame.encode().map_err(|_| {
            local_file_error(
                "file_transfer_failed",
                "The download chunk could not be encoded.",
            )
        })
    }

    fn file_grant(
        &self,
        origin: Option<&str>,
        grant_id: uuid::Uuid,
        action: FileAction,
        allow_either_write: bool,
    ) -> Result<mdbase_connect_protocol::GrantSummary, ConnectError> {
        if self.registry.paused()? {
            return Err(ConnectError::AccessDenied(
                "Remote access is paused on this computer.".to_string(),
            ));
        }
        let grant = self
            .registry
            .grant_context(grant_id)?
            .filter(|grant| {
                origin.is_none_or(|expected| grant.application_origin == expected)
                    && grant.encryption.is_some()
            })
            .ok_or_else(|| ConnectError::AccessDenied("File access was denied.".to_string()))?;
        if allow_either_write {
            require_file_write(&grant)?;
        } else {
            require_file_action(&grant, action)?;
        }
        Ok(grant)
    }

    fn file_cipher(
        &self,
        grant: &mdbase_connect_protocol::GrantSummary,
        transfer_id: uuid::Uuid,
        direction: FileTransferDirection,
    ) -> Result<FileTransferCipher, ConnectError> {
        let encryption = grant.encryption.as_ref().ok_or_else(|| {
            ConnectError::AccessDenied("Encrypted file access is required.".to_string())
        })?;
        FileTransferCipher::derive(
            &self.relay_identity,
            &encryption.application_agreement_public_key,
            FileTransferBinding {
                grant_id: grant.id,
                application_id: grant.application_id,
                connector_id: encryption.connector_id,
                authority_id: encryption.connector_id,
                collection_id: grant.collection_id,
                scope_epoch: encryption.scope_epoch,
                key_id: encryption.key_id.clone(),
                transfer_id,
                direction,
            },
        )
        .map_err(|_| ConnectError::AccessDenied("File transfer encryption failed.".to_string()))
    }

    fn require_file_transfer_access(
        &self,
        grant: &mdbase_connect_protocol::GrantSummary,
        transfer_id: uuid::Uuid,
    ) -> Result<(), ConnectError> {
        let session =
            self.registry
                .file_transfer_session(grant.collection_id, grant.id, transfer_id)?;
        let (path, action) = match session.direction {
            FileTransferDirection::Upload => {
                let (path, replacing) =
                    self.registry
                        .file_upload_intent(grant.collection_id, grant.id, transfer_id)?;
                (
                    path,
                    if replacing {
                        FileAction::Replace
                    } else {
                        FileAction::Add
                    },
                )
            }
            FileTransferDirection::Download => (
                self.registry
                    .file_download_path(grant.collection_id, grant.id, transfer_id)?,
                FileAction::Read,
            ),
        };
        require_visible_path(require_file_action(grant, action)?, &path)
    }
}

fn parse_file_control<T: serde::de::DeserializeOwned>(
    input: serde_json::Value,
) -> Result<T, ConnectError> {
    serde_json::from_value(input).map_err(|error| {
        local_file_error(
            "invalid_file_request",
            format!("Invalid file control request: {error}"),
        )
    })
}

fn require_file_capability(
    grant: &mdbase_connect_protocol::GrantSummary,
) -> Result<&mdbase_connect_protocol::FileCapability, ConnectError> {
    grant
        .file_capability
        .as_ref()
        .filter(|capability| capability.protocol_version == FILE_PROTOCOL_VERSION)
        .ok_or_else(|| {
            ConnectError::AccessDenied("This grant does not allow file access.".to_string())
        })
}

fn require_control_protocol(version: u32) -> Result<(), ConnectError> {
    if version == FILE_PROTOCOL_VERSION {
        Ok(())
    } else {
        Err(local_file_error(
            "unsupported_protocol_version",
            "The file control protocol version is unsupported.",
        ))
    }
}

fn valid_control_path(path: &str) -> bool {
    const RESERVED: &[&str] = &["_contracts", "_schemas", "_types", "_views", "node_modules"];
    !path.is_empty()
        && path.len() <= 1_024
        && !path.starts_with(['/', '.'])
        && !path.ends_with('/')
        && !path.contains(['\\', '\0'])
        && path.split('/').all(|component| {
            !component.is_empty()
                && !component.starts_with('.')
                && component != "."
                && component != ".."
                && !RESERVED.contains(&component)
        })
}

fn validate_list_request(request: &ListFilesRequest) -> Result<usize, ConnectError> {
    require_control_protocol(request.protocol_version)?;
    let limit = request.limit.unwrap_or(100);
    if !(1..=1_000).contains(&limit)
        || request
            .folder
            .as_deref()
            .is_some_and(|folder| !valid_control_path(folder))
        || request
            .after
            .as_deref()
            .is_some_and(|after| after.is_empty() || after.len() > 2_048)
    {
        return Err(local_file_error(
            "invalid_file_request",
            "The file list cursor, folder, or page size is invalid.",
        ));
    }
    Ok(usize::from(limit))
}

const LOCAL_FILE_CURSOR_PREFIX: &str = "local-v1:";

fn encode_local_file_cursor(inventory_revision: u64, path: &str) -> String {
    format!("{LOCAL_FILE_CURSOR_PREFIX}{inventory_revision}:{path}")
}

fn parse_local_file_cursor(cursor: &str) -> Result<(u64, &str), ConnectError> {
    let value = cursor
        .strip_prefix(LOCAL_FILE_CURSOR_PREFIX)
        .ok_or_else(|| {
            local_file_error(
                "invalid_file_request",
                "The local file list cursor is invalid.",
            )
        })?;
    let (revision, path) = value.split_once(':').ok_or_else(|| {
        local_file_error(
            "invalid_file_request",
            "The local file list cursor is invalid.",
        )
    })?;
    let revision = revision.parse::<u64>().map_err(|_| {
        local_file_error(
            "invalid_file_request",
            "The local file list cursor is invalid.",
        )
    })?;
    if revision == 0 || !valid_control_path(path) {
        return Err(local_file_error(
            "invalid_file_request",
            "The local file list cursor is invalid.",
        ));
    }
    Ok((revision, path))
}

fn require_file_action(
    grant: &mdbase_connect_protocol::GrantSummary,
    action: FileAction,
) -> Result<&mdbase_connect_protocol::FileCapability, ConnectError> {
    let capability = require_file_capability(grant)?;
    if capability.actions.contains(&action) {
        Ok(capability)
    } else {
        Err(ConnectError::AccessDenied(format!(
            "This grant does not allow the {action:?} file action."
        )))
    }
}

fn require_file_write(
    grant: &mdbase_connect_protocol::GrantSummary,
) -> Result<&mdbase_connect_protocol::FileCapability, ConnectError> {
    let capability = require_file_capability(grant)?;
    if capability
        .actions
        .iter()
        .any(|action| matches!(action, FileAction::Add | FileAction::Replace))
    {
        Ok(capability)
    } else {
        Err(ConnectError::AccessDenied(
            "This grant does not allow file uploads.".to_string(),
        ))
    }
}

fn require_visible_path(
    capability: &mdbase_connect_protocol::FileCapability,
    path: &str,
) -> Result<(), ConnectError> {
    if file_visible(capability, path) {
        Ok(())
    } else {
        Err(ConnectError::AccessDenied(
            "The file path is outside this grant's scope.".to_string(),
        ))
    }
}

fn file_visible(capability: &mdbase_connect_protocol::FileCapability, path: &str) -> bool {
    match &capability.scope {
        FileScope::Collection => true,
        FileScope::SelectedFolders { folders } => {
            folders.iter().any(|folder| path_in_folder(path, folder))
        }
    }
}

fn path_in_folder(path: &str, folder: &str) -> bool {
    path.strip_prefix(folder)
        .is_some_and(|suffix| suffix.starts_with('/'))
}

fn validate_frame_session(
    header: &FileFrameHeader,
    session: &mdbase_connect_protocol::FileTransferSession,
) -> Result<(), ConnectError> {
    let FileTransferStrategy::FramedChunks { chunk_size } = session.strategy else {
        return Err(local_file_error(
            "invalid_file_frame",
            "The transfer does not use framed chunks.",
        ));
    };
    let expected_offset = header
        .chunk_index
        .checked_mul(u64::from(chunk_size))
        .ok_or_else(|| local_file_error("invalid_file_frame", "The chunk offset overflowed."))?;
    let expected_length = session
        .total_size
        .saturating_sub(expected_offset)
        .min(u64::from(chunk_size));
    if session.direction != FileTransferDirection::Upload
        || session.protection != FileTransferProtection::GrantAeadV1
        || header.chunk_size != chunk_size
        || header.total_size != session.total_size
        || header.offset != expected_offset
        || expected_offset >= session.total_size
        || u64::from(header.plaintext_length) != expected_length
    {
        return Err(local_file_error(
            "invalid_file_frame",
            "The upload frame does not match its transfer session.",
        ));
    }
    Ok(())
}

fn validate_relay_binding(
    relay: &RelayFileHeader,
    frame: &FileFrameHeader,
) -> Result<(), ConnectError> {
    if relay.grant_id != frame.grant_id
        || relay.transfer_id != frame.transfer_id
        || relay.chunk_index != frame.chunk_index
    {
        return Err(local_file_error(
            "invalid_relay_file_message",
            "The relay wrapper does not match its encrypted file frame.",
        ));
    }
    Ok(())
}

fn local_file_error(code: impl Into<String>, message: impl Into<String>) -> ConnectError {
    ConnectError::File {
        code: code.into(),
        message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mdbase_connect_protocol::{
        ApplicationAccess, DeleteFileRequestKind, FileCapability, FileCapabilityKind, GrantScope,
        GrantSummary, ListFilesRequestKind, MoveFileRequestKind, OpenFileDownloadRequestKind,
    };
    use std::fs;
    use tempfile::tempdir;
    use uuid::Uuid;

    fn list_request() -> ListFilesRequest {
        ListFilesRequest {
            protocol_version: FILE_PROTOCOL_VERSION,
            message_type: ListFilesRequestKind::ListFiles,
            folder: Some("Assets/images".to_string()),
            after: Some("Assets/images/one.png".to_string()),
            limit: Some(25),
        }
    }

    #[test]
    fn list_controls_are_bounded_before_paging() {
        assert_eq!(validate_list_request(&list_request()).unwrap(), 25);
        let mut invalid = list_request();
        invalid.limit = Some(0);
        assert!(validate_list_request(&invalid).is_err());
        invalid = list_request();
        invalid.folder = Some("../private".to_string());
        assert!(validate_list_request(&invalid).is_err());
        invalid = list_request();
        invalid.protocol_version += 1;
        assert!(validate_list_request(&invalid).is_err());
        assert_eq!(
            parse_local_file_cursor(&encode_local_file_cursor(42, "Assets/images/one.png"))
                .unwrap(),
            (42, "Assets/images/one.png")
        );
        assert!(parse_local_file_cursor("Assets/images/one.png").is_err());
        assert!(parse_local_file_cursor("local-v1:0:Assets/images/one.png").is_err());
    }

    #[test]
    fn local_list_pages_share_one_index_revision_and_expire_after_refresh() {
        let state_dir = tempdir().unwrap();
        let root = tempdir().unwrap();
        fs::write(root.path().join("mdbase.yaml"), "spec_version: 0.3.0\n").unwrap();
        fs::create_dir(root.path().join("Allowed")).unwrap();
        for name in ["a.bin", "b.bin", "c.bin"] {
            fs::write(root.path().join("Allowed").join(name), name.as_bytes()).unwrap();
        }
        let registry = CollectionRegistry::open(state_dir.path()).unwrap();
        let collection = registry.add(root.path()).unwrap();
        let watcher = CollectionWatchService::start(registry.clone());
        let state = AgentState::new(registry.clone(), watcher, None);
        let grant = file_grant(collection.id, vec![FileAction::List]);
        let request = ListFilesRequest {
            protocol_version: FILE_PROTOCOL_VERSION,
            message_type: ListFilesRequestKind::ListFiles,
            folder: Some("Allowed".to_string()),
            after: None,
            limit: Some(1),
        };
        let first: ListFilesPage = serde_json::from_value(
            state
                .file_control(&grant, serde_json::to_value(&request).unwrap())
                .unwrap(),
        )
        .unwrap();
        assert_eq!(first.files.len(), 1);
        let cursor = first.next.expect("three files produce a continuation");

        registry.mark_file_inventory_dirty(collection.id).unwrap();
        let mut continuation = request.clone();
        continuation.after = Some(cursor.clone());
        let second: ListFilesPage = serde_json::from_value(
            state
                .file_control(&grant, serde_json::to_value(&continuation).unwrap())
                .unwrap(),
        )
        .unwrap();
        assert_eq!(second.files[0].path, "Allowed/b.bin");

        fs::write(root.path().join("Allowed/d.bin"), b"d.bin").unwrap();
        registry.mark_file_inventory_dirty(collection.id).unwrap();
        state
            .file_control(&grant, serde_json::to_value(&request).unwrap())
            .unwrap();
        assert_eq!(
            state
                .file_control(&grant, serde_json::to_value(&continuation).unwrap())
                .unwrap_err()
                .code(),
            "file_list_changed"
        );
    }

    fn file_grant(collection_id: Uuid, actions: Vec<FileAction>) -> GrantSummary {
        GrantSummary {
            contracts: mdbase_connect_protocol::ConnectContractRequirements::current(true),
            id: Uuid::now_v7(),
            application_id: Uuid::now_v7(),
            application_name: "File application".to_string(),
            application_distribution: "portable".to_string(),
            application_homepage: "https://example.test".to_string(),
            application_project_url: None,
            application_origin: String::new(),
            application_icon: None,
            collection_id,
            collection_name: "Files".to_string(),
            operations: Vec::new(),
            scope: GrantScope {
                contracts: Vec::new(),
                access: ApplicationAccess::FullCollection,
            },
            notification_criteria: Vec::new(),
            created_at: "2026-08-01T00:00:00Z".to_string(),
            encryption: None,
            file_capability: Some(FileCapability {
                kind: FileCapabilityKind::Files,
                protocol_version: FILE_PROTOCOL_VERSION,
                actions,
                scope: FileScope::SelectedFolders {
                    folders: vec!["Allowed".to_string()],
                },
            }),
        }
    }

    #[test]
    fn lifecycle_control_authorizes_source_destination_and_action_before_mutation() {
        let state_dir = tempdir().unwrap();
        let root = tempdir().unwrap();
        fs::write(root.path().join("mdbase.yaml"), "spec_version: 0.3.0\n").unwrap();
        fs::create_dir(root.path().join("Allowed")).unwrap();
        fs::write(root.path().join("Allowed/source.bin"), b"safe").unwrap();
        let registry = CollectionRegistry::open(state_dir.path()).unwrap();
        let collection = registry.add(root.path()).unwrap();
        let original = registry.reconcile_files(collection.id).unwrap().remove(0);
        let watcher = CollectionWatchService::start(registry.clone());
        let state = AgentState::new(registry, watcher, None);
        let grant = file_grant(collection.id, vec![FileAction::Move, FileAction::Delete]);

        let outside = MoveFileRequest {
            protocol_version: FILE_PROTOCOL_VERSION,
            message_type: MoveFileRequestKind::MoveFile,
            mutation_id: Uuid::now_v7(),
            file_id: original.file_id,
            if_revision: original.revision.clone(),
            from_path: original.path.clone(),
            path: "Outside/moved.bin".to_string(),
            update_references: false,
        };
        assert_eq!(
            state
                .file_control(&grant, serde_json::to_value(&outside).unwrap())
                .unwrap_err()
                .code(),
            "access_denied"
        );
        assert_eq!(fs::read(root.path().join(&original.path)).unwrap(), b"safe");

        let mut allowed = outside;
        allowed.mutation_id = Uuid::now_v7();
        allowed.path = "Allowed/moved.bin".to_string();
        let moved: mdbase_connect_protocol::MoveFileReceipt = serde_json::from_value(
            state
                .file_control(&grant, serde_json::to_value(&allowed).unwrap())
                .unwrap(),
        )
        .unwrap();
        assert_eq!(moved.file.path, "Allowed/moved.bin");

        let delete = DeleteFileRequest {
            protocol_version: FILE_PROTOCOL_VERSION,
            message_type: DeleteFileRequestKind::DeleteFile,
            mutation_id: Uuid::now_v7(),
            file_id: moved.file.file_id,
            if_revision: moved.file.revision.clone(),
            path: moved.file.path.clone(),
        };
        let read_only = file_grant(collection.id, vec![FileAction::Read]);
        assert_eq!(
            state
                .file_control(&read_only, serde_json::to_value(&delete).unwrap())
                .unwrap_err()
                .code(),
            "access_denied"
        );
        assert!(root.path().join(&delete.path).exists());

        let receipt: mdbase_connect_protocol::DeleteFileReceipt = serde_json::from_value(
            state
                .file_control(&grant, serde_json::to_value(&delete).unwrap())
                .unwrap(),
        )
        .unwrap();
        assert_eq!(receipt.previous_path, delete.path);
        assert!(!root.path().join(&receipt.previous_path).exists());
    }

    #[test]
    fn download_scope_is_rechecked_against_the_authoritative_current_path() {
        let state_dir = tempdir().unwrap();
        let root = tempdir().unwrap();
        fs::write(root.path().join("mdbase.yaml"), "spec_version: 0.3.0\n").unwrap();
        fs::create_dir(root.path().join("Allowed")).unwrap();
        fs::create_dir(root.path().join("Outside")).unwrap();
        fs::write(root.path().join("Allowed/source.bin"), b"safe").unwrap();
        let registry = CollectionRegistry::open(state_dir.path()).unwrap();
        let collection = registry.add(root.path()).unwrap();
        let original = registry.reconcile_files(collection.id).unwrap().remove(0);
        fs::rename(
            root.path().join("Allowed/source.bin"),
            root.path().join("Outside/source.bin"),
        )
        .unwrap();

        let watcher = CollectionWatchService::start(registry.clone());
        let state = AgentState::new(registry, watcher, None);
        let grant = file_grant(collection.id, vec![FileAction::Read]);
        let request = OpenFileDownloadRequest {
            protocol_version: FILE_PROTOCOL_VERSION,
            message_type: OpenFileDownloadRequestKind::OpenFileDownload,
            transfer_id: Uuid::now_v7(),
            file_id: original.file_id,
            revision: None,
        };
        assert_eq!(
            state
                .file_control(&grant, serde_json::to_value(&request).unwrap())
                .unwrap_err()
                .code(),
            "access_denied"
        );
        assert!(!root
            .path()
            .join(".mdbase-connect/transfers")
            .join(format!("{}.download", request.transfer_id))
            .exists());
    }
}
