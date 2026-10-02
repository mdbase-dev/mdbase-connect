//! Temporary B4 control shapes. Move these to connect-protocol when wb-protocol's
//! Wave B wire commit lands; authorities must then import only the canonical types.
use crate::ConnectError;
use mdbase_connect_protocol::{CollectionFileDescriptor, FILE_PROTOCOL_VERSION};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct StatFileRequest {
    pub protocol_version: u32,
    #[serde(rename = "type")]
    pub message_type: StatFileRequestKind,
    #[serde(
        default,
        deserialize_with = "present_target",
        skip_serializing_if = "Option::is_none"
    )]
    pub path: Option<String>,
    #[serde(
        default,
        deserialize_with = "present_target",
        skip_serializing_if = "Option::is_none"
    )]
    pub file_id: Option<Uuid>,
}

fn present_target<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StatFileRequestKind {
    StatFile,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct FileStat {
    pub protocol_version: u32,
    #[serde(rename = "type")]
    pub message_type: FileStatKind,
    pub file: Option<CollectionFileDescriptor>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FileStatKind {
    FileStat,
}

impl StatFileRequest {
    pub fn validate(&self) -> Result<(), ConnectError> {
        if self.protocol_version != FILE_PROTOCOL_VERSION {
            return Err(ConnectError::File {
                code: "unsupported_protocol_version".into(),
                message: "The file control protocol version is unsupported.".into(),
            });
        }
        if self.path.is_some() == self.file_id.is_some()
            || self.file_id.is_some_and(|id| id.is_nil())
        {
            return Err(ConnectError::File {
                code: "invalid_file_request".into(),
                message: "File stat requires exactly one path or non-nil file ID.".into(),
            });
        }
        if let Some(path) = &self.path {
            crate::collection_files::validate_portable_path(path).map_err(|message| {
                ConnectError::File {
                    code: "unsafe_file_path".into(),
                    message,
                }
            })?;
            if path.len() > 1_024 {
                return Err(ConnectError::File {
                    code: "unsafe_file_path".into(),
                    message: "The file path exceeds 1024 bytes.".into(),
                });
            }
        }
        Ok(())
    }
}

impl FileStat {
    pub fn new(file: Option<CollectionFileDescriptor>) -> Self {
        Self {
            protocol_version: FILE_PROTOCOL_VERSION,
            message_type: FileStatKind::FileStat,
            file,
        }
    }
}
