use super::*;
use crate::blob_store::{BlobByteStream, UploadedPart as BlobUploadedPart};
use mdbase_connect_protocol::{
    AbortFileTransferRequest, CollectionFileDescriptor, CommitFileUploadReceipt,
    CommitFileUploadReceiptKind, CommitFileUploadRequest, DeleteFileReceipt, DeleteFileRequest,
    FileMediaClass, FileTransferDirection, FileTransferProtection, FileTransferSession,
    FileTransferSessionKind, FileTransferState, FileTransferStatus, FileTransferStatusKind,
    FileTransferStrategy, ListFilesPage, ListFilesPageKind, ListFilesRequest, MoveFileReceipt,
    MoveFileRequest, OpenFileDownloadRequest, OpenFileUploadRequest, PrepareFileUploadPartRequest,
    PreparedFilePart, PreparedFilePartKind, UploadedFilePart, FILE_TRANSFER_PROTOCOL_VERSION,
};

const TRANSFER_LIFETIME_HOURS: i64 = 24;
const SINGLE_PUT_THRESHOLD_BYTES: u64 = 5 * 1024 * 1024;

pub(crate) struct HostedFileDownload {
    pub body: BlobByteStream,
    pub content_length: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct HostedFilePayload {
    pub(super) path: String,
    pub(super) content_digest: String,
    pub(super) media_type: Option<String>,
    pub(super) media_class: FileMediaClass,
    pub(super) modified_at: String,
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

#[derive(Debug, Clone)]
struct HostedUploadCleanup {
    id: Uuid,
    staging_object_key: String,
    committed_object_key: String,
    multipart_upload_id: Option<String>,
}

impl From<&HostedFileTransfer> for HostedUploadCleanup {
    fn from(transfer: &HostedFileTransfer) -> Self {
        Self {
            id: transfer.id,
            staging_object_key: transfer.staging_object_key.clone(),
            committed_object_key: transfer.committed_object_key.clone(),
            multipart_upload_id: transfer.multipart_upload_id.clone(),
        }
    }
}

mod lifecycle;
mod list_download;
mod maintenance;
mod persistence;
mod upload;

pub(super) fn decode_current_file(
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
        uploaded_parts: Vec::new(),
    }
}

pub(super) fn payload_from_descriptor(file: &CollectionFileDescriptor) -> HostedFilePayload {
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

pub(super) fn validate_content_digest(value: &str) -> ApiResult<()> {
    crate::blob_store::parse_sha256_digest(value).map(|_| ())
}

pub(super) fn validate_media_type(value: Option<&str>) -> ApiResult<()> {
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

pub(super) fn classify_media(path: &str) -> (FileMediaClass, Option<String>) {
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
