use super::*;

pub const FILE_PROTOCOL_VERSION: u32 = 1;
pub const FILE_TRANSFER_PROTOCOL_VERSION: u32 = 1;
pub const DEFAULT_FILE_CHUNK_BYTES: u32 = 1024 * 1024;
pub const MIN_FILE_CHUNK_BYTES: u32 = 64 * 1024;
pub const MAX_FILE_CHUNK_BYTES: u32 = 4 * 1024 * 1024;
pub const MAX_FILE_FRAME_HEADER_BYTES: usize = 16 * 1024;
pub const FILE_FRAME_PREFIX_BYTES: usize = 16;
pub const FILE_FRAME_MAGIC: [u8; 4] = *b"MDBF";

const FILE_FRAME_VERSION: u8 = 1;
const FILE_FRAME_FLAGS: u16 = 0;
const AEAD_TAG_BYTES: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileMediaClass {
    Image,
    Audio,
    Video,
    Pdf,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
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
    Referenced,
    SelectedFolders { folders: Vec<String> },
    Collection,
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
pub struct OpenFileUploadRequest {
    pub protocol_version: u32,
    #[serde(rename = "type")]
    pub message_type: OpenFileUploadRequestKind,
    pub path: String,
    pub size: u64,
    pub content_digest: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub if_revision: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OpenFileUploadRequestKind {
    OpenFileUpload,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpenFileDownloadRequest {
    pub protocol_version: u32,
    #[serde(rename = "type")]
    pub message_type: OpenFileDownloadRequestKind,
    pub file_id: Uuid,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OpenFileDownloadRequestKind {
    OpenFileDownload,
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
pub struct FileTransferSession {
    pub protocol_version: u32,
    #[serde(rename = "type")]
    pub message_type: FileTransferSessionKind,
    pub transfer_id: Uuid,
    pub direction: FileTransferDirection,
    pub protection: FileTransferProtection,
    pub chunk_size: u32,
    pub total_size: u64,
    pub expires_at: String,
    pub received: Vec<u64>,
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
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileTransferStatusKind {
    FileTransferStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommitFileUploadRequest {
    pub protocol_version: u32,
    #[serde(rename = "type")]
    pub message_type: CommitFileUploadRequestKind,
    pub transfer_id: Uuid,
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
    pub scope_revision: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_id: Option<String>,
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
        let header_bytes = serde_json::to_vec(&self.header)
            .map_err(|error| FileFrameError::InvalidHeader(error.to_string()))?;
        if header_bytes.is_empty() || header_bytes.len() > MAX_FILE_FRAME_HEADER_BYTES {
            return Err(FileFrameError::LimitExceeded);
        }
        if self.payload.len() > MAX_FILE_CHUNK_BYTES as usize + AEAD_TAG_BYTES {
            return Err(FileFrameError::LimitExceeded);
        }
        let header_length =
            u32::try_from(header_bytes.len()).map_err(|_| FileFrameError::LimitExceeded)?;
        let payload_length =
            u32::try_from(self.payload.len()).map_err(|_| FileFrameError::LimitExceeded)?;
        let capacity = FILE_FRAME_PREFIX_BYTES
            .checked_add(header_bytes.len())
            .and_then(|length| length.checked_add(self.payload.len()))
            .ok_or(FileFrameError::LimitExceeded)?;
        let mut output = Vec::with_capacity(capacity);
        output.extend_from_slice(&FILE_FRAME_MAGIC);
        output.push(FILE_FRAME_VERSION);
        output.push(self.kind.code());
        output.extend_from_slice(&FILE_FRAME_FLAGS.to_be_bytes());
        output.extend_from_slice(&header_length.to_be_bytes());
        output.extend_from_slice(&payload_length.to_be_bytes());
        output.extend_from_slice(&header_bytes);
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
        let header = &self.header;
        if header.protocol_version != FILE_TRANSFER_PROTOCOL_VERSION {
            return Err(FileFrameError::InvalidHeader(format!(
                "unsupported transfer protocol {}",
                header.protocol_version
            )));
        }
        if header.direction != self.kind.direction() {
            return Err(FileFrameError::DirectionMismatch);
        }
        if !(MIN_FILE_CHUNK_BYTES..=MAX_FILE_CHUNK_BYTES).contains(&header.chunk_size)
            || header.plaintext_length > header.chunk_size
            || header.scope_revision.is_empty()
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
        if self.payload.len() != expected_payload {
            return Err(FileFrameError::PayloadLengthMismatch);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};

    fn fixture() -> Value {
        serde_json::from_str(include_str!(
            "../../../packages/protocol/test/fixtures/file-frame-v1.json"
        ))
        .unwrap()
    }

    fn sample_frame() -> FileFrame {
        let fixture = fixture();
        FileFrame {
            kind: FileFrameKind::UploadChunk,
            header: serde_json::from_value(fixture["header"].clone()).unwrap(),
            payload: BASE64
                .decode(fixture["payload_base64"].as_str().unwrap())
                .unwrap(),
        }
    }

    fn raw_frame(header: &str, payload: &[u8]) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&FILE_FRAME_MAGIC);
        bytes.push(FILE_FRAME_VERSION);
        bytes.push(FileFrameKind::UploadChunk.code());
        bytes.extend_from_slice(&FILE_FRAME_FLAGS.to_be_bytes());
        bytes.extend_from_slice(&(header.len() as u32).to_be_bytes());
        bytes.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        bytes.extend_from_slice(header.as_bytes());
        bytes.extend_from_slice(payload);
        bytes
    }

    #[test]
    fn file_frame_v1_matches_the_shared_typescript_fixture() {
        let fixture = fixture();
        let frame = sample_frame();
        let encoded = frame.encode().unwrap();
        assert_eq!(
            BASE64.encode(&encoded),
            fixture["frame_base64"].as_str().unwrap()
        );
        let decoded = FileFrame::decode(&encoded).unwrap();
        assert_eq!(decoded, frame);
    }

    #[test]
    fn frame_decoder_rejects_malformed_prefixes_and_lengths() {
        assert_eq!(
            FileFrame::decode(&[0; FILE_FRAME_PREFIX_BYTES - 1]),
            Err(FileFrameError::TooShort)
        );
        let encoded = sample_frame().encode().unwrap();

        let mut bad_magic = encoded.clone();
        bad_magic[0] = 0;
        assert_eq!(
            FileFrame::decode(&bad_magic),
            Err(FileFrameError::InvalidMagic)
        );
        let mut bad_version = encoded.clone();
        bad_version[4] = 2;
        assert_eq!(
            FileFrame::decode(&bad_version),
            Err(FileFrameError::UnsupportedVersion(2))
        );
        let mut bad_kind = encoded.clone();
        bad_kind[5] = 99;
        assert_eq!(
            FileFrame::decode(&bad_kind),
            Err(FileFrameError::InvalidKind(99))
        );
        let mut bad_flags = encoded.clone();
        bad_flags[7] = 1;
        assert_eq!(
            FileFrame::decode(&bad_flags),
            Err(FileFrameError::UnsupportedFlags(1))
        );
        assert_eq!(
            FileFrame::decode(&encoded[..encoded.len() - 1]),
            Err(FileFrameError::LengthMismatch)
        );
        let mut trailing = encoded.clone();
        trailing.push(0);
        assert_eq!(
            FileFrame::decode(&trailing),
            Err(FileFrameError::LengthMismatch)
        );

        let mut huge_header = encoded;
        huge_header[8..12].copy_from_slice(&u32::MAX.to_be_bytes());
        assert_eq!(
            FileFrame::decode(&huge_header),
            Err(FileFrameError::LimitExceeded)
        );
    }

    #[test]
    fn frame_decoder_rejects_noncanonical_or_ambiguous_headers() {
        let frame = sample_frame();
        let canonical = serde_json::to_string(&frame.header).unwrap();
        assert_eq!(
            FileFrame::decode(&raw_frame(&format!(" {canonical}"), &frame.payload)),
            Err(FileFrameError::NonCanonicalHeader)
        );
        let duplicate = canonical.replace(
            "\"scope_revision\":\"scope_7\"",
            "\"scope_revision\":\"scope_7\",\"scope_revision\":\"scope_7\"",
        );
        assert!(matches!(
            FileFrame::decode(&raw_frame(&duplicate, &frame.payload)),
            Err(FileFrameError::InvalidHeader(_))
        ));
        let unknown = canonical.replace(
            "\"scope_revision\":\"scope_7\"",
            "\"scope_revision\":\"scope_7\",\"future\":true",
        );
        assert!(matches!(
            FileFrame::decode(&raw_frame(&unknown, &frame.payload)),
            Err(FileFrameError::InvalidHeader(_))
        ));
    }

    #[test]
    fn frame_semantics_bind_kind_offsets_bounds_and_protection() {
        let mut frame = sample_frame();
        frame.kind = FileFrameKind::DownloadChunk;
        assert_eq!(frame.encode(), Err(FileFrameError::DirectionMismatch));

        let mut frame = sample_frame();
        frame.header.offset = 1;
        assert_eq!(frame.encode(), Err(FileFrameError::OffsetMismatch));

        let mut frame = sample_frame();
        frame.header.total_size = 31;
        assert_eq!(frame.encode(), Err(FileFrameError::TransferBounds));

        let mut frame = sample_frame();
        frame.header.protection = FileTransferProtection::GrantAeadV1;
        frame.header.key_id = Some("grant-key-3".to_string());
        assert_eq!(frame.encode(), Err(FileFrameError::PayloadLengthMismatch));
        frame.payload.extend_from_slice(&[0; AEAD_TAG_BYTES]);
        assert!(frame.encode().is_ok());
    }
}
