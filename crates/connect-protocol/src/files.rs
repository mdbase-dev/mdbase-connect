use super::*;

pub const FILE_PROTOCOL_VERSION: u32 = 1;
pub const FILE_TRANSFER_PROTOCOL_VERSION: u32 = 1;
pub const DEFAULT_FILE_CHUNK_BYTES: u32 = 1024 * 1024;
pub const MIN_FILE_CHUNK_BYTES: u32 = 64 * 1024;
pub const MAX_FILE_CHUNK_BYTES: u32 = 4 * 1024 * 1024;
pub const MAX_FILE_FRAME_HEADER_BYTES: usize = 16 * 1024;
pub const FILE_FRAME_PREFIX_BYTES: usize = 16;
pub const FILE_FRAME_MAGIC: [u8; 4] = *b"MDBF";
pub const MAX_FILE_FRAME_BYTES: usize =
    FILE_FRAME_PREFIX_BYTES + MAX_FILE_FRAME_HEADER_BYTES + MAX_FILE_CHUNK_BYTES as usize + 16;
pub const RELAY_FILE_PROTOCOL_VERSION: u32 = 1;
pub const RELAY_FILE_PREFIX_BYTES: usize = 16;
pub const MAX_RELAY_FILE_HEADER_BYTES: usize = 1024;
pub const MAX_RELAY_FILE_PAYLOAD_BYTES: usize = MAX_FILE_FRAME_BYTES;
pub const RELAY_FILE_MAGIC: [u8; 4] = *b"MDBR";

const FILE_FRAME_VERSION: u8 = 1;
const FILE_FRAME_FLAGS: u16 = 0;
const RELAY_FILE_FRAME_VERSION: u8 = 1;
const RELAY_FILE_FRAME_FLAGS: u16 = 0;
const AEAD_TAG_BYTES: usize = 16;
const MAX_SAFE_WIRE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileMediaClass {
    Image,
    Audio,
    Video,
    Pdf,
    Other,
}

/// Device-local projection of a hosted collection. Folder exclusions apply to
/// Markdown and files; hidden and reserved paths are independently mandatory.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SelectiveSyncPolicy {
    #[serde(default)]
    pub file_classes: Vec<FileMediaClass>,
    #[serde(default)]
    pub excluded_folders: Vec<String>,
}

impl SelectiveSyncPolicy {
    pub fn includes(&self, media_class: FileMediaClass) -> bool {
        self.file_classes.contains(&media_class)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileAction {
    List,
    Read,
    Add,
    Replace,
    Move,
    Delete,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FileScope {
    SelectedFolders { folders: Vec<String> },
    Collection,
}

/// File access requested by an application manifest. Protocol negotiation is
/// authority-owned, so manifests describe intent without pinning a transport
/// version or repeating the granted capability discriminator.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApplicationFileRequirement {
    pub actions: Vec<FileAction>,
    pub scope: FileScope,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileCapability {
    pub kind: FileCapabilityKind,
    pub protocol_version: u32,
    pub actions: Vec<FileAction>,
    pub scope: FileScope,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileCapabilityKind {
    Files,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CollectionFileDescriptor {
    pub file_id: Uuid,
    pub path: String,
    pub revision: String,
    pub content_digest: String,
    pub size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
    pub media_class: FileMediaClass,
    pub modified_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListFilesRequest {
    pub protocol_version: u32,
    #[serde(rename = "type")]
    pub message_type: ListFilesRequestKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u16>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ListFilesRequestKind {
    ListFiles,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListFilesPage {
    pub protocol_version: u32,
    #[serde(rename = "type")]
    pub message_type: ListFilesPageKind,
    pub files: Vec<CollectionFileDescriptor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ListFilesPageKind {
    FilesPage,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OpenFileUploadRequest {
    pub protocol_version: u32,
    #[serde(rename = "type")]
    pub message_type: OpenFileUploadRequestKind,
    pub transfer_id: Uuid,
    pub path: String,
    pub size: u64,
    pub content_digest: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub if_revision: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpenAuthorityImportFileUploadRequest {
    pub protocol_version: u32,
    #[serde(rename = "type")]
    pub message_type: OpenAuthorityImportFileUploadRequestKind,
    pub transfer_id: Uuid,
    pub file_id: Uuid,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OpenAuthorityImportFileUploadRequestKind {
    OpenAuthorityImportFileUpload,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OpenFileUploadRequestKind {
    OpenFileUpload,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OpenFileDownloadRequest {
    pub protocol_version: u32,
    #[serde(rename = "type")]
    pub message_type: OpenFileDownloadRequestKind,
    pub transfer_id: Uuid,
    pub file_id: Uuid,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OpenFileDownloadRequestKind {
    OpenFileDownload,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MoveFileRequest {
    pub protocol_version: u32,
    #[serde(rename = "type")]
    pub message_type: MoveFileRequestKind,
    pub mutation_id: Uuid,
    pub file_id: Uuid,
    pub if_revision: String,
    pub from_path: String,
    pub path: String,
    pub update_references: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MoveFileRequestKind {
    MoveFile,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MoveFileReceipt {
    pub protocol_version: u32,
    #[serde(rename = "type")]
    pub message_type: MoveFileReceiptKind,
    pub mutation_id: Uuid,
    pub file: CollectionFileDescriptor,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MoveFileReceiptKind {
    FileMoved,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeleteFileRequest {
    pub protocol_version: u32,
    #[serde(rename = "type")]
    pub message_type: DeleteFileRequestKind,
    pub mutation_id: Uuid,
    pub file_id: Uuid,
    pub if_revision: String,
    pub path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeleteFileRequestKind {
    DeleteFile,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeleteFileReceipt {
    pub protocol_version: u32,
    #[serde(rename = "type")]
    pub message_type: DeleteFileReceiptKind,
    pub mutation_id: Uuid,
    pub file_id: Uuid,
    pub previous_path: String,
    pub revision: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeleteFileReceiptKind {
    FileDeleted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileTransferDirection {
    Upload,
    Download,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileTransferProtection {
    GrantAeadV1,
    TransportTls,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileTransferState {
    Open,
    Committed,
    Aborted,
    Expired,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FileTransferStrategy {
    FramedChunks { chunk_size: u32 },
    ObjectPut,
    ObjectMultipart { part_size: u64 },
    ObjectRanges { part_size: u64 },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileTransferSession {
    pub protocol_version: u32,
    #[serde(rename = "type")]
    pub message_type: FileTransferSessionKind,
    pub transfer_id: Uuid,
    pub direction: FileTransferDirection,
    pub protection: FileTransferProtection,
    pub strategy: FileTransferStrategy,
    pub total_size: u64,
    pub expires_at: String,
    pub received: Vec<u64>,
    /// Object-store part receipts that let a restarted uploader resume without
    /// retransmitting parts. Empty for framed transfers and single PUTs.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub uploaded_parts: Vec<UploadedFilePart>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileTransferSessionKind {
    FileTransfer,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileTransferStatus {
    pub protocol_version: u32,
    #[serde(rename = "type")]
    pub message_type: FileTransferStatusKind,
    pub transfer_id: Uuid,
    pub state: FileTransferState,
    pub received: Vec<u64>,
    pub received_bytes: u64,
    /// Object-store receipts for the currently durable multipart parts.
    /// Empty for framed transfers, single PUTs, and downloads.
    pub uploaded_parts: Vec<UploadedFilePart>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileTransferStatusKind {
    FileTransferStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PrepareFileUploadPartRequest {
    pub protocol_version: u32,
    #[serde(rename = "type")]
    pub message_type: PrepareFileUploadPartRequestKind,
    pub transfer_id: Uuid,
    pub part_number: u16,
    pub content_length: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrepareFileUploadPartRequestKind {
    PrepareFileUploadPart,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreparedFilePart {
    pub protocol_version: u32,
    #[serde(rename = "type")]
    pub message_type: PreparedFilePartKind,
    pub transfer_id: Uuid,
    pub part_index: u64,
    pub offset: u64,
    pub content_length: u64,
    pub method: String,
    pub url: String,
    pub headers: BTreeMap<String, String>,
    pub expires_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PreparedFilePartKind {
    FilePart,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UploadedFilePart {
    pub part_number: u16,
    pub etag: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommitFileUploadRequest {
    pub protocol_version: u32,
    #[serde(rename = "type")]
    pub message_type: CommitFileUploadRequestKind,
    pub transfer_id: Uuid,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub parts: Vec<UploadedFilePart>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CommitFileUploadRequestKind {
    CommitFileUpload,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommitFileUploadReceipt {
    pub protocol_version: u32,
    #[serde(rename = "type")]
    pub message_type: CommitFileUploadReceiptKind,
    pub transfer_id: Uuid,
    pub file: CollectionFileDescriptor,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CommitFileUploadReceiptKind {
    FileUploadCommitted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AbortFileTransferRequest {
    pub protocol_version: u32,
    #[serde(rename = "type")]
    pub message_type: AbortFileTransferRequestKind,
    pub transfer_id: Uuid,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AbortFileTransferRequestKind {
    AbortFileTransfer,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GetFileTransferStatusRequest {
    pub protocol_version: u32,
    #[serde(rename = "type")]
    pub message_type: GetFileTransferStatusRequestKind,
    pub transfer_id: Uuid,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GetFileTransferStatusRequestKind {
    GetFileTransferStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FileFrameHeader {
    pub protocol_version: u32,
    pub protection: FileTransferProtection,
    pub grant_id: Uuid,
    pub authority_id: Uuid,
    pub collection_id: Uuid,
    pub transfer_id: Uuid,
    pub direction: FileTransferDirection,
    pub chunk_size: u32,
    pub chunk_index: u64,
    pub offset: u64,
    pub plaintext_length: u32,
    pub total_size: u64,
    pub scope_epoch: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RelayFileKind {
    UploadChunk,
    UploadAcknowledged,
    DownloadRequest,
    DownloadChunk,
    Rejected,
}

impl RelayFileKind {
    fn code(self) -> u8 {
        match self {
            Self::UploadChunk => 1,
            Self::UploadAcknowledged => 2,
            Self::DownloadRequest => 3,
            Self::DownloadChunk => 4,
            Self::Rejected => 5,
        }
    }

    fn from_code(code: u8) -> Result<Self, RelayFileFrameError> {
        match code {
            1 => Ok(Self::UploadChunk),
            2 => Ok(Self::UploadAcknowledged),
            3 => Ok(Self::DownloadRequest),
            4 => Ok(Self::DownloadChunk),
            5 => Ok(Self::Rejected),
            other => Err(RelayFileFrameError::InvalidKind(other)),
        }
    }

    fn carries_payload(self) -> bool {
        matches!(self, Self::UploadChunk | Self::DownloadChunk)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RelayFileHeader {
    pub protocol_version: u32,
    #[serde(rename = "type")]
    pub message_type: RelayFileKind,
    pub request_id: Uuid,
    pub grant_id: Uuid,
    pub transfer_id: Uuid,
    pub chunk_index: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayFileFrame {
    pub kind: RelayFileKind,
    pub header: RelayFileHeader,
    pub payload: Vec<u8>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum RelayFileFrameError {
    #[error("relay file frame is shorter than its fixed prefix")]
    TooShort,
    #[error("relay file frame magic is not MDBR")]
    InvalidMagic,
    #[error("unsupported relay file frame version {0}")]
    UnsupportedVersion(u8),
    #[error("unknown relay file frame kind {0}")]
    InvalidKind(u8),
    #[error("unsupported relay file frame flags {0}")]
    UnsupportedFlags(u16),
    #[error("relay file frame header must not be empty")]
    EmptyHeader,
    #[error("relay file frame exceeds protocol limits")]
    LimitExceeded,
    #[error("relay file frame lengths do not match the supplied bytes")]
    LengthMismatch,
    #[error("invalid relay file frame header: {0}")]
    InvalidHeader(String),
    #[error("relay file frame header is not canonical JSON")]
    NonCanonicalHeader,
    #[error("relay file frame kind does not match its header")]
    KindMismatch,
    #[error("relay file frame payload does not match its kind")]
    PayloadMismatch,
}

impl RelayFileFrame {
    pub fn encode(&self) -> Result<Vec<u8>, RelayFileFrameError> {
        self.validate()?;
        let header = serde_json::to_vec(&self.header)
            .map_err(|error| RelayFileFrameError::InvalidHeader(error.to_string()))?;
        if header.is_empty()
            || header.len() > MAX_RELAY_FILE_HEADER_BYTES
            || self.payload.len() > MAX_RELAY_FILE_PAYLOAD_BYTES
        {
            return Err(RelayFileFrameError::LimitExceeded);
        }
        let header_length =
            u32::try_from(header.len()).map_err(|_| RelayFileFrameError::LimitExceeded)?;
        let payload_length =
            u32::try_from(self.payload.len()).map_err(|_| RelayFileFrameError::LimitExceeded)?;
        let capacity = RELAY_FILE_PREFIX_BYTES
            .checked_add(header.len())
            .and_then(|size| size.checked_add(self.payload.len()))
            .ok_or(RelayFileFrameError::LimitExceeded)?;
        let mut output = Vec::with_capacity(capacity);
        output.extend_from_slice(&RELAY_FILE_MAGIC);
        output.push(RELAY_FILE_FRAME_VERSION);
        output.push(self.kind.code());
        output.extend_from_slice(&RELAY_FILE_FRAME_FLAGS.to_be_bytes());
        output.extend_from_slice(&header_length.to_be_bytes());
        output.extend_from_slice(&payload_length.to_be_bytes());
        output.extend_from_slice(&header);
        output.extend_from_slice(&self.payload);
        Ok(output)
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, RelayFileFrameError> {
        if bytes.len() < RELAY_FILE_PREFIX_BYTES {
            return Err(RelayFileFrameError::TooShort);
        }
        if bytes[..4] != RELAY_FILE_MAGIC {
            return Err(RelayFileFrameError::InvalidMagic);
        }
        if bytes[4] != RELAY_FILE_FRAME_VERSION {
            return Err(RelayFileFrameError::UnsupportedVersion(bytes[4]));
        }
        let kind = RelayFileKind::from_code(bytes[5])?;
        let flags = u16::from_be_bytes([bytes[6], bytes[7]]);
        if flags != RELAY_FILE_FRAME_FLAGS {
            return Err(RelayFileFrameError::UnsupportedFlags(flags));
        }
        let header_length =
            u32::from_be_bytes(bytes[8..12].try_into().expect("fixed prefix slice")) as usize;
        let payload_length =
            u32::from_be_bytes(bytes[12..16].try_into().expect("fixed prefix slice")) as usize;
        if header_length == 0 {
            return Err(RelayFileFrameError::EmptyHeader);
        }
        if header_length > MAX_RELAY_FILE_HEADER_BYTES
            || payload_length > MAX_RELAY_FILE_PAYLOAD_BYTES
        {
            return Err(RelayFileFrameError::LimitExceeded);
        }
        let header_end = RELAY_FILE_PREFIX_BYTES
            .checked_add(header_length)
            .ok_or(RelayFileFrameError::LengthMismatch)?;
        let expected_length = header_end
            .checked_add(payload_length)
            .ok_or(RelayFileFrameError::LengthMismatch)?;
        if expected_length != bytes.len() {
            return Err(RelayFileFrameError::LengthMismatch);
        }
        let header_bytes = &bytes[RELAY_FILE_PREFIX_BYTES..header_end];
        let header: RelayFileHeader = serde_json::from_slice(header_bytes)
            .map_err(|error| RelayFileFrameError::InvalidHeader(error.to_string()))?;
        let canonical = serde_json::to_vec(&header)
            .map_err(|error| RelayFileFrameError::InvalidHeader(error.to_string()))?;
        if canonical != header_bytes {
            return Err(RelayFileFrameError::NonCanonicalHeader);
        }
        let frame = Self {
            kind,
            header,
            payload: bytes[header_end..].to_vec(),
        };
        frame.validate()?;
        Ok(frame)
    }

    fn validate(&self) -> Result<(), RelayFileFrameError> {
        if self.header.protocol_version != RELAY_FILE_PROTOCOL_VERSION
            || self.header.chunk_index > MAX_SAFE_WIRE_INTEGER
        {
            return Err(RelayFileFrameError::InvalidHeader(
                "header value is outside its allowed range".to_string(),
            ));
        }
        if self.kind != self.header.message_type {
            return Err(RelayFileFrameError::KindMismatch);
        }
        if self.kind.carries_payload() == self.payload.is_empty() {
            return Err(RelayFileFrameError::PayloadMismatch);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileFrameKind {
    UploadChunk,
    DownloadChunk,
}

impl FileFrameKind {
    fn code(self) -> u8 {
        match self {
            Self::UploadChunk => 1,
            Self::DownloadChunk => 2,
        }
    }

    fn from_code(code: u8) -> Result<Self, FileFrameError> {
        match code {
            1 => Ok(Self::UploadChunk),
            2 => Ok(Self::DownloadChunk),
            other => Err(FileFrameError::InvalidKind(other)),
        }
    }

    fn direction(self) -> FileTransferDirection {
        match self {
            Self::UploadChunk => FileTransferDirection::Upload,
            Self::DownloadChunk => FileTransferDirection::Download,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileFrame {
    pub kind: FileFrameKind,
    pub header: FileFrameHeader,
    pub payload: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileFrameDecodeLimits {
    pub max_header_bytes: usize,
    pub max_payload_bytes: usize,
}

impl Default for FileFrameDecodeLimits {
    fn default() -> Self {
        Self {
            max_header_bytes: MAX_FILE_FRAME_HEADER_BYTES,
            max_payload_bytes: MAX_FILE_CHUNK_BYTES as usize + AEAD_TAG_BYTES,
        }
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum FileFrameError {
    #[error("file frame is shorter than its fixed prefix")]
    TooShort,
    #[error("file frame magic is not MDBF")]
    InvalidMagic,
    #[error("unsupported file frame version {0}")]
    UnsupportedVersion(u8),
    #[error("unknown file frame kind {0}")]
    InvalidKind(u8),
    #[error("unsupported file frame flags {0}")]
    UnsupportedFlags(u16),
    #[error("file frame header must not be empty")]
    EmptyHeader,
    #[error("file frame exceeds configured decode limits")]
    LimitExceeded,
    #[error("file frame lengths do not match the supplied bytes")]
    LengthMismatch,
    #[error("invalid file frame header: {0}")]
    InvalidHeader(String),
    #[error("file frame header is not canonical JSON")]
    NonCanonicalHeader,
    #[error("file frame direction does not match its kind")]
    DirectionMismatch,
    #[error("file frame chunk offset does not match its index and size")]
    OffsetMismatch,
    #[error("file frame chunk extends past the declared transfer size")]
    TransferBounds,
    #[error("file frame payload length does not match the protected plaintext length")]
    PayloadLengthMismatch,
}

impl FileFrame {
    pub fn encode(&self) -> Result<Vec<u8>, FileFrameError> {
        self.validate()?;
        if self.payload.len() > MAX_FILE_CHUNK_BYTES as usize + AEAD_TAG_BYTES {
            return Err(FileFrameError::LimitExceeded);
        }
        let authenticated_data = file_frame_authenticated_data(self.kind, &self.header)?;
        let capacity = authenticated_data
            .len()
            .checked_add(self.payload.len())
            .ok_or(FileFrameError::LimitExceeded)?;
        let mut output = Vec::with_capacity(capacity);
        output.extend_from_slice(&authenticated_data);
        output.extend_from_slice(&self.payload);
        Ok(output)
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, FileFrameError> {
        Self::decode_with_limits(bytes, FileFrameDecodeLimits::default())
    }

    pub fn decode_with_limits(
        bytes: &[u8],
        limits: FileFrameDecodeLimits,
    ) -> Result<Self, FileFrameError> {
        if bytes.len() < FILE_FRAME_PREFIX_BYTES {
            return Err(FileFrameError::TooShort);
        }
        if bytes[..4] != FILE_FRAME_MAGIC {
            return Err(FileFrameError::InvalidMagic);
        }
        if bytes[4] != FILE_FRAME_VERSION {
            return Err(FileFrameError::UnsupportedVersion(bytes[4]));
        }
        let kind = FileFrameKind::from_code(bytes[5])?;
        let flags = u16::from_be_bytes([bytes[6], bytes[7]]);
        if flags != FILE_FRAME_FLAGS {
            return Err(FileFrameError::UnsupportedFlags(flags));
        }
        let header_length =
            u32::from_be_bytes(bytes[8..12].try_into().expect("fixed prefix slice")) as usize;
        let payload_length =
            u32::from_be_bytes(bytes[12..16].try_into().expect("fixed prefix slice")) as usize;
        if header_length == 0 {
            return Err(FileFrameError::EmptyHeader);
        }
        if header_length > limits.max_header_bytes || payload_length > limits.max_payload_bytes {
            return Err(FileFrameError::LimitExceeded);
        }
        let header_end = FILE_FRAME_PREFIX_BYTES
            .checked_add(header_length)
            .ok_or(FileFrameError::LengthMismatch)?;
        let expected_length = header_end
            .checked_add(payload_length)
            .ok_or(FileFrameError::LengthMismatch)?;
        if expected_length != bytes.len() {
            return Err(FileFrameError::LengthMismatch);
        }
        let header_bytes = &bytes[FILE_FRAME_PREFIX_BYTES..header_end];
        let header: FileFrameHeader = serde_json::from_slice(header_bytes)
            .map_err(|error| FileFrameError::InvalidHeader(error.to_string()))?;
        let canonical_header = serde_json::to_vec(&header)
            .map_err(|error| FileFrameError::InvalidHeader(error.to_string()))?;
        if canonical_header != header_bytes {
            return Err(FileFrameError::NonCanonicalHeader);
        }
        let frame = Self {
            kind,
            header,
            payload: bytes[header_end..].to_vec(),
        };
        frame.validate()?;
        Ok(frame)
    }

    fn validate(&self) -> Result<(), FileFrameError> {
        validate_file_frame_parts(self.kind, &self.header, self.payload.len())
    }
}

/** Fixed prefix and canonical header authenticated by the file chunk AEAD profile. */
pub fn file_frame_authenticated_data(
    kind: FileFrameKind,
    header: &FileFrameHeader,
) -> Result<Vec<u8>, FileFrameError> {
    let payload_length = header.plaintext_length as usize
        + if matches!(header.protection, FileTransferProtection::GrantAeadV1) {
            AEAD_TAG_BYTES
        } else {
            0
        };
    validate_file_frame_parts(kind, header, payload_length)?;
    let header_bytes = serde_json::to_vec(header)
        .map_err(|error| FileFrameError::InvalidHeader(error.to_string()))?;
    if header_bytes.is_empty() || header_bytes.len() > MAX_FILE_FRAME_HEADER_BYTES {
        return Err(FileFrameError::LimitExceeded);
    }
    let header_length =
        u32::try_from(header_bytes.len()).map_err(|_| FileFrameError::LimitExceeded)?;
    let payload_length =
        u32::try_from(payload_length).map_err(|_| FileFrameError::LimitExceeded)?;
    let capacity = FILE_FRAME_PREFIX_BYTES
        .checked_add(header_bytes.len())
        .ok_or(FileFrameError::LimitExceeded)?;
    let mut output = Vec::with_capacity(capacity);
    output.extend_from_slice(&FILE_FRAME_MAGIC);
    output.push(FILE_FRAME_VERSION);
    output.push(kind.code());
    output.extend_from_slice(&FILE_FRAME_FLAGS.to_be_bytes());
    output.extend_from_slice(&header_length.to_be_bytes());
    output.extend_from_slice(&payload_length.to_be_bytes());
    output.extend_from_slice(&header_bytes);
    Ok(output)
}

fn validate_file_frame_parts(
    kind: FileFrameKind,
    header: &FileFrameHeader,
    payload_length: usize,
) -> Result<(), FileFrameError> {
    if header.protocol_version != FILE_TRANSFER_PROTOCOL_VERSION {
        return Err(FileFrameError::InvalidHeader(format!(
            "unsupported transfer protocol {}",
            header.protocol_version
        )));
    }
    if header.direction != kind.direction() {
        return Err(FileFrameError::DirectionMismatch);
    }
    if !(MIN_FILE_CHUNK_BYTES..=MAX_FILE_CHUNK_BYTES).contains(&header.chunk_size)
        || header.plaintext_length > header.chunk_size
        || header.scope_epoch == 0
        || header.scope_epoch > MAX_SAFE_WIRE_INTEGER
        || header.chunk_index > MAX_SAFE_WIRE_INTEGER
        || header.offset > MAX_SAFE_WIRE_INTEGER
        || header.total_size > MAX_SAFE_WIRE_INTEGER
        || matches!(header.protection, FileTransferProtection::GrantAeadV1)
            && header.key_id.as_deref().is_none_or(str::is_empty)
    {
        return Err(FileFrameError::InvalidHeader(
            "header value is outside its allowed range".to_string(),
        ));
    }
    let expected_offset = header
        .chunk_index
        .checked_mul(u64::from(header.chunk_size))
        .ok_or(FileFrameError::OffsetMismatch)?;
    if header.offset != expected_offset {
        return Err(FileFrameError::OffsetMismatch);
    }
    let end = header
        .offset
        .checked_add(u64::from(header.plaintext_length))
        .ok_or(FileFrameError::TransferBounds)?;
    if end > header.total_size {
        return Err(FileFrameError::TransferBounds);
    }
    let expected_payload = header.plaintext_length as usize
        + if matches!(header.protection, FileTransferProtection::GrantAeadV1) {
            AEAD_TAG_BYTES
        } else {
            0
        };
    if payload_length != expected_payload {
        return Err(FileFrameError::PayloadLengthMismatch);
    }
    Ok(())
}

#[cfg(test)]
mod relay_tests;

#[cfg(test)]
mod tests;
