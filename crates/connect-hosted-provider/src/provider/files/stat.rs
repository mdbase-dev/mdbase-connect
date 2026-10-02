use super::*;

// Temporary wire adapter until wb-protocol's Wave B types land. Delete these
// declarations and use connect-protocol's StatFileRequest/FileStat at integration.
#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StatFileRequestKind {
    StatFile,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileStat {
    pub protocol_version: u32,
    #[serde(rename = "type")]
    pub message_type: FileStatKind,
    pub file: Option<CollectionFileDescriptor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileStatKind {
    FileStat,
}

impl HostedProvider {
    pub async fn stat_file(
        &self,
        collection_id: Uuid,
        token: &str,
        request: StatFileRequest,
        request_origin: Option<&str>,
    ) -> ApiResult<FileStat> {
        require_file_protocol(request.protocol_version)?;
        if request.path.is_some() == request.file_id.is_some()
            || request.file_id.is_some_and(|id| id.is_nil())
        {
            return Err(ApiError::bad_request(
                "invalid_file_request",
                "File stat requires exactly one path or non-nil file ID.",
            ));
        }
        if let Some(path) = &request.path {
            validate_hosted_file_path(path)?;
        }
        let replica = self.authenticate_for_file(collection_id, token).await?;
        // Check action/origin before looking up even an absent target. For explicit
        // paths, check scope before loading the key or querying descriptor metadata.
        authorize_file_access(
            &replica,
            FileAction::List,
            request.path.as_deref(),
            request_origin,
        )?;
        let data_key = self.load_collection_key(collection_id).await?;
        let row = if let Some(path) = &request.path {
            sqlx::query(
                r#"SELECT collection_id, file_id, path_token, revision, size, object_key, payload_ciphertext, sequence
                   FROM hosted_provider_files WHERE collection_id = $1 AND path_token = $2"#,
            )
            .bind(collection_id)
            .bind(path_token(&data_key, &portable_file_path_key(path)))
            .fetch_optional(&self.pool).await?
        } else {
            sqlx::query(
                r#"SELECT collection_id, file_id, path_token, revision, size, object_key, payload_ciphertext, sequence
                   FROM hosted_provider_files WHERE collection_id = $1 AND file_id = $2"#,
            )
            .bind(collection_id)
            .bind(request.file_id.expect("validated stat target"))
            .fetch_optional(&self.pool).await?
        };
        let file = if let Some(row) = row {
            let (file, _, _, _) =
                decode_current_file(&self.crypto, &data_key, collection_id, &row)?;
            // AAD authenticates collection/ID/sequence; verify the encrypted path
            // also agrees with the existing unique path-token index. Never recover
            // silently from corrupt metadata or publish it as a missing file.
            if row.get::<Uuid, _>("collection_id") != collection_id
                || request.file_id.is_some_and(|id| id != file.file_id)
                || validate_hosted_file_path(&file.path).is_err()
                || row.get::<Vec<u8>, _>("path_token")
                    != path_token(&data_key, &portable_file_path_key(&file.path))
                || request.path.as_ref().is_some_and(|path| {
                    portable_file_path_key(path) != portable_file_path_key(&file.path)
                })
            {
                return Err(ApiError::internal(
                    "The hosted file descriptor disagrees with its index.",
                ));
            }
            match authorize_file_access(
                &replica,
                FileAction::List,
                Some(&file.path),
                request_origin,
            ) {
                Ok(()) => Some(file),
                Err(error) if error.code == "scope_denied" => None,
                Err(error) => return Err(error),
            }
        } else {
            None
        };
        Ok(FileStat {
            protocol_version: FILE_PROTOCOL_VERSION,
            message_type: FileStatKind::FileStat,
            file,
        })
    }
}
