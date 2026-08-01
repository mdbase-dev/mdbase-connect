use super::*;

pub(super) fn transfer_exists(
    connection: &Connection,
    transfer_id: Uuid,
) -> Result<bool, ConnectError> {
    Ok(connection
        .query_row(
            "SELECT 1 FROM collection_file_transfers WHERE transfer_id = ?1",
            [transfer_id.to_string()],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

pub(super) fn transfer_direction(
    connection: &Connection,
    collection_id: Uuid,
    owner_id: Uuid,
    transfer_id: Uuid,
) -> Result<String, ConnectError> {
    connection
        .query_row(
            "SELECT direction FROM collection_file_transfers
             WHERE transfer_id = ?1 AND collection_id = ?2 AND owner_id = ?3",
            params![
                transfer_id.to_string(),
                collection_id.to_string(),
                owner_id.to_string(),
            ],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| file_error("transfer_not_found", "The file transfer was not found."))
}

pub(super) fn upload_session(transfer: &UploadTransfer, received: Vec<u64>) -> FileTransferSession {
    FileTransferSession {
        protocol_version: FILE_TRANSFER_PROTOCOL_VERSION,
        message_type: FileTransferSessionKind::FileTransfer,
        transfer_id: transfer.transfer_id,
        direction: FileTransferDirection::Upload,
        protection: FileTransferProtection::GrantAeadV1,
        strategy: FileTransferStrategy::FramedChunks {
            chunk_size: transfer.chunk_size,
        },
        total_size: transfer.expected_size,
        expires_at: transfer
            .expires_at
            .to_rfc3339_opts(SecondsFormat::Millis, true),
        received,
    }
}
