use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

pub const COLLABORATION_PROTOCOL_VERSION: u16 = 1;
pub const COLLABORATION_PROFILE: &str = "markdown-body-yjs-v13";
pub const COLLABORATION_FRAME_MAGIC: [u8; 4] = *b"MDBC";
pub const COLLABORATION_FRAME_PREFIX_BYTES: usize = 16;
pub const MAX_COLLABORATION_METADATA_BYTES: usize = 16 * 1024;
pub const MAX_COLLABORATION_PAYLOAD_BYTES: usize = 256 * 1024;
pub const MAX_COLLABORATION_FRAME_BYTES: usize = COLLABORATION_FRAME_PREFIX_BYTES
    + MAX_COLLABORATION_METADATA_BYTES
    + MAX_COLLABORATION_PAYLOAD_BYTES;
const FLAGS: u8 = 0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[repr(u8)]
pub enum CollaborationMessageKind {
    Authenticate = 1,
    Hello = 2,
    SyncStep1 = 3,
    SyncStep2 = 4,
    Update = 5,
    Acknowledged = 6,
    Awareness = 7,
    Heartbeat = 8,
    RoomMetadata = 9,
    EpochChanged = 10,
    #[serde(rename = "error")]
    TypedError = 11,
}

impl TryFrom<u8> for CollaborationMessageKind {
    type Error = CollaborationFrameError;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        Ok(match value {
            1 => Self::Authenticate,
            2 => Self::Hello,
            3 => Self::SyncStep1,
            4 => Self::SyncStep2,
            5 => Self::Update,
            6 => Self::Acknowledged,
            7 => Self::Awareness,
            8 => Self::Heartbeat,
            9 => Self::RoomMetadata,
            10 => Self::EpochChanged,
            11 => Self::TypedError,
            _ => return Err(CollaborationFrameError::Invalid),
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct CollaborationFrame {
    pub kind: CollaborationMessageKind,
    pub metadata: serde_json::Map<String, Value>,
    pub payload: Vec<u8>,
}

#[derive(Debug, Clone, Copy, Error, PartialEq, Eq)]
pub enum CollaborationFrameError {
    #[error("collaboration frame is invalid")]
    Invalid,
    #[error("collaboration frame exceeds its byte limit")]
    TooLarge,
    #[error("collaboration protocol version is unsupported")]
    UnsupportedProtocol,
}

impl CollaborationFrame {
    pub fn encode(&self) -> Result<Vec<u8>, CollaborationFrameError> {
        let metadata =
            serde_json::to_vec(&self.metadata).map_err(|_| CollaborationFrameError::Invalid)?;
        if metadata.len() > MAX_COLLABORATION_METADATA_BYTES
            || self.payload.len() > MAX_COLLABORATION_PAYLOAD_BYTES
        {
            return Err(CollaborationFrameError::TooLarge);
        }
        let mut output = Vec::with_capacity(
            COLLABORATION_FRAME_PREFIX_BYTES + metadata.len() + self.payload.len(),
        );
        output.extend_from_slice(&COLLABORATION_FRAME_MAGIC);
        output.extend_from_slice(&COLLABORATION_PROTOCOL_VERSION.to_be_bytes());
        output.push(self.kind as u8);
        output.push(FLAGS);
        output.extend_from_slice(&(metadata.len() as u32).to_be_bytes());
        output.extend_from_slice(&(self.payload.len() as u32).to_be_bytes());
        output.extend_from_slice(&metadata);
        output.extend_from_slice(&self.payload);
        Ok(output)
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, CollaborationFrameError> {
        if bytes.len() < COLLABORATION_FRAME_PREFIX_BYTES || bytes[..4] != COLLABORATION_FRAME_MAGIC
        {
            return Err(CollaborationFrameError::Invalid);
        }
        let version = u16::from_be_bytes([bytes[4], bytes[5]]);
        if version != COLLABORATION_PROTOCOL_VERSION {
            return Err(CollaborationFrameError::UnsupportedProtocol);
        }
        if bytes[7] != FLAGS {
            return Err(CollaborationFrameError::Invalid);
        }
        let kind = CollaborationMessageKind::try_from(bytes[6])?;
        let metadata_len = u32::from_be_bytes(bytes[8..12].try_into().unwrap()) as usize;
        let payload_len = u32::from_be_bytes(bytes[12..16].try_into().unwrap()) as usize;
        if metadata_len > MAX_COLLABORATION_METADATA_BYTES
            || payload_len > MAX_COLLABORATION_PAYLOAD_BYTES
        {
            return Err(CollaborationFrameError::TooLarge);
        }
        let expected = COLLABORATION_FRAME_PREFIX_BYTES
            .checked_add(metadata_len)
            .and_then(|size| size.checked_add(payload_len))
            .ok_or(CollaborationFrameError::TooLarge)?;
        if bytes.len() != expected {
            return Err(CollaborationFrameError::Invalid);
        }
        let metadata_value: Value = serde_json::from_slice(
            &bytes
                [COLLABORATION_FRAME_PREFIX_BYTES..COLLABORATION_FRAME_PREFIX_BYTES + metadata_len],
        )
        .map_err(|_| CollaborationFrameError::Invalid)?;
        let Value::Object(metadata) = metadata_value else {
            return Err(CollaborationFrameError::Invalid);
        };
        Ok(Self {
            kind,
            metadata,
            payload: bytes[COLLABORATION_FRAME_PREFIX_BYTES + metadata_len..].to_vec(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use sha2::{Digest, Sha256};

    #[test]
    fn shared_frame_fixture_round_trips_exactly() {
        let bytes =
            include_bytes!("../../../packages/protocol/test/fixtures/collaboration-frame-v1.bin");
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../packages/protocol/test/fixtures/collaboration-frame-v1.json"
        ))
        .unwrap();
        assert_eq!(
            format!("{:x}", Sha256::digest(bytes)),
            fixture["encoded_sha256"].as_str().unwrap()
        );
        let frame = CollaborationFrame::decode(bytes).unwrap();
        assert_eq!(frame.kind, CollaborationMessageKind::Update);
        assert_eq!(frame.metadata.get("collaboration_epoch"), Some(&json!(7)));
        assert_eq!(frame.payload, [0, 1, 2, 127, 128, 255]);
        assert_eq!(frame.encode().unwrap(), bytes);
    }

    #[test]
    fn rejects_malformed_ambiguous_and_oversized_frames() {
        let frame = CollaborationFrame {
            kind: CollaborationMessageKind::Update,
            metadata: json!({"client_mutation_id":"018f0000-0000-7000-8000-000000000001"})
                .as_object()
                .unwrap()
                .clone(),
            payload: vec![1, 2, 3],
        };
        let encoded = frame.encode().unwrap();
        assert_eq!(CollaborationFrame::decode(&encoded).unwrap(), frame);
        assert_eq!(
            CollaborationFrame::decode(&encoded[..encoded.len() - 1]),
            Err(CollaborationFrameError::Invalid)
        );
        let mut flags = encoded.clone();
        flags[7] = 1;
        assert_eq!(
            CollaborationFrame::decode(&flags),
            Err(CollaborationFrameError::Invalid)
        );
        let oversized = CollaborationFrame {
            payload: vec![0; MAX_COLLABORATION_PAYLOAD_BYTES + 1],
            ..frame
        };
        assert_eq!(oversized.encode(), Err(CollaborationFrameError::TooLarge));
    }
}
