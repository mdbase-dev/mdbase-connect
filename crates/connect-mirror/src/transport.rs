use super::*;
use std::time::Duration;

const HTTP_CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const HTTP_READ_TIMEOUT: Duration = Duration::from_secs(2 * 60);
const OBJECT_UPLOAD_MAX_ATTEMPTS: usize = 3;

#[async_trait]
pub trait SyncTransport: Send + Sync {
    async fn open_session(&self) -> Result<SyncSession, MirrorError>;
    async fn snapshot(
        &self,
        snapshot_id: Uuid,
        page: Option<&str>,
    ) -> Result<SyncSnapshotPage, MirrorError>;
    async fn file_snapshot(
        &self,
        snapshot_id: Uuid,
        page: Option<&str>,
    ) -> Result<SyncFileSnapshotPage, MirrorError>;
    async fn download_file(
        &self,
        file: &CollectionFileDescriptor,
        destination: &Path,
    ) -> Result<(), MirrorError>;
    async fn upload_file(
        &self,
        request: &OpenFileUploadRequest,
        source: &Path,
    ) -> Result<CommitFileUploadReceipt, MirrorError>;
    async fn move_file(&self, request: &MoveFileRequest) -> Result<MoveFileReceipt, MirrorError>;
    async fn delete_file(
        &self,
        request: &DeleteFileRequest,
    ) -> Result<DeleteFileReceipt, MirrorError>;
    async fn changes(&self, after: u64, limit: usize) -> Result<SyncChangesPage, MirrorError>;
    async fn mutate(&self, mutation: &SyncMutation) -> Result<SyncMutationReceipt, MirrorError>;
}

#[derive(Clone)]
pub struct HttpSyncTransport {
    client: Client,
    sync_url: String,
    files_url: String,
    replica_token: String,
}

fn ensure_tls_crypto_provider() {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    }
}

impl HttpSyncTransport {
    pub fn new(sync_url: &str, replica_token: impl Into<String>) -> Result<Self, MirrorError> {
        Self::new_with_timeouts(
            sync_url,
            replica_token,
            HTTP_CONNECT_TIMEOUT,
            HTTP_READ_TIMEOUT,
        )
    }

    fn new_with_timeouts(
        sync_url: &str,
        replica_token: impl Into<String>,
        connect_timeout: Duration,
        read_timeout: Duration,
    ) -> Result<Self, MirrorError> {
        ensure_tls_crypto_provider();
        let endpoint = Url::parse(sync_url).map_err(|_| {
            MirrorError::new(
                "invalid_sync_url",
                "Sync URL must be an absolute authority endpoint.",
            )
        })?;
        let loopback = matches!(endpoint.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
        let secure = endpoint.scheme() == "https" || (endpoint.scheme() == "http" && loopback);
        let segments = endpoint
            .path_segments()
            .map(|segments| segments.collect::<Vec<_>>())
            .unwrap_or_default();
        let valid_path = segments.len() == 5
            && segments[0] == "v1"
            && segments[1] == "authorities"
            && Uuid::parse_str(segments[2]).is_ok()
            && segments[3] == "sync"
            && segments[4].is_empty();
        let valid_path_without_slash = segments.len() == 4
            && segments[0] == "v1"
            && segments[1] == "authorities"
            && Uuid::parse_str(segments[2]).is_ok()
            && segments[3] == "sync";
        if endpoint.host_str().is_none()
            || !secure
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
            || !(valid_path || valid_path_without_slash)
        {
            return Err(MirrorError::new(
                "invalid_sync_url",
                "Sync URL must identify one HTTPS authority sync endpoint, except on loopback.",
            ));
        }
        let sync_url = endpoint.as_str().trim_end_matches('/').to_string();
        let files_url = sync_url
            .strip_suffix("/sync")
            .expect("validated sync URL ends with /sync")
            .to_string()
            + "/files";
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(connect_timeout)
            .read_timeout(read_timeout)
            .build()
            .map_err(|error| {
                MirrorError::new(
                    "mirror_transport_failed",
                    format!("Could not initialize the mirror HTTP client: {error}"),
                )
            })?;
        Ok(Self {
            client,
            sync_url,
            files_url,
            replica_token: replica_token.into(),
        })
    }

    async fn request<T: serde::de::DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<T, MirrorError> {
        self.request_at(&self.sync_url, method, path, body).await
    }

    async fn request_at<T: serde::de::DeserializeOwned>(
        &self,
        base_url: &str,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<T, MirrorError> {
        let mut request = self
            .client
            .request(method, format!("{base_url}/{path}"))
            .bearer_auth(&self.replica_token);
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request.send().await.map_err(|error| {
            transport_error(error, "mirror_offline", "Hosted authority is unavailable")
        })?;
        let status = response.status();
        let value = response.json::<Value>().await.map_err(|error| {
            transport_error(
                error,
                "invalid_sync_response",
                "Hosted authority returned invalid JSON",
            )
        })?;
        if !status.is_success() {
            return Err(MirrorError::new(
                value
                    .pointer("/error/code")
                    .and_then(Value::as_str)
                    .unwrap_or("sync_failed"),
                value
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .unwrap_or("Hosted synchronization failed."),
            ));
        }
        serde_json::from_value(value).map_err(|error| {
            MirrorError::new(
                "invalid_sync_response",
                format!("Hosted authority returned an invalid response: {error}"),
            )
        })
    }

    async fn file_request<T: serde::de::DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<T, MirrorError> {
        self.request_at(&self.files_url, method, path, body).await
    }

    async fn abort_file_transfer(&self, transfer_id: Uuid) {
        let _ = self
            .file_request::<FileTransferStatus>(
                Method::DELETE,
                &format!("transfers/{transfer_id}"),
                None,
            )
            .await;
    }
}

fn transport_error(error: reqwest::Error, fallback_code: &str, context: &str) -> MirrorError {
    MirrorError::new(
        if error.is_timeout() {
            "mirror_transport_timeout"
        } else {
            fallback_code
        },
        format!("{context}: {error}"),
    )
}

#[async_trait]
impl SyncTransport for HttpSyncTransport {
    async fn open_session(&self) -> Result<SyncSession, MirrorError> {
        self.request(Method::POST, "sessions", None).await
    }

    async fn snapshot(
        &self,
        snapshot_id: Uuid,
        page: Option<&str>,
    ) -> Result<SyncSnapshotPage, MirrorError> {
        let path = {
            let mut query = url::form_urlencoded::Serializer::new(String::new());
            query.append_pair("snapshot_id", &snapshot_id.to_string());
            if let Some(page) = page {
                query.append_pair("page", page);
            }
            format!("snapshot?{}", query.finish())
        };
        self.request(Method::GET, &path, None).await
    }

    async fn file_snapshot(
        &self,
        snapshot_id: Uuid,
        page: Option<&str>,
    ) -> Result<SyncFileSnapshotPage, MirrorError> {
        let path = {
            let mut query = url::form_urlencoded::Serializer::new(String::new());
            query.append_pair("snapshot_id", &snapshot_id.to_string());
            if let Some(page) = page {
                query.append_pair("page", page);
            }
            format!("files/snapshot?{}", query.finish())
        };
        self.request(Method::GET, &path, None).await
    }

    async fn download_file(
        &self,
        file: &CollectionFileDescriptor,
        destination: &Path,
    ) -> Result<(), MirrorError> {
        let transfer_id = Uuid::new_v4();
        let result = self
            .download_file_transfer(file, destination, transfer_id)
            .await;
        self.abort_file_transfer(transfer_id).await;
        if result.is_err() {
            let _ = fs::remove_file(destination);
        }
        result
    }

    async fn upload_file(
        &self,
        request: &OpenFileUploadRequest,
        source: &Path,
    ) -> Result<CommitFileUploadReceipt, MirrorError> {
        let result = self.upload_file_transfer(request, source).await;
        if result.is_err() {
            self.abort_file_transfer(request.transfer_id).await;
        }
        result
    }

    async fn move_file(&self, request: &MoveFileRequest) -> Result<MoveFileReceipt, MirrorError> {
        let body = serde_json::to_value(request)?;
        let receipt = self
            .file_request::<MoveFileReceipt>(
                Method::POST,
                &format!("{}/move", request.file_id),
                Some(&body),
            )
            .await?;
        if receipt.protocol_version != FILE_PROTOCOL_VERSION
            || receipt.message_type != MoveFileReceiptKind::FileMoved
            || receipt.mutation_id != request.mutation_id
        {
            return Err(MirrorError::new(
                "invalid_sync_response",
                "Authority returned an invalid file move receipt.",
            ));
        }
        Ok(receipt)
    }

    async fn delete_file(
        &self,
        request: &DeleteFileRequest,
    ) -> Result<DeleteFileReceipt, MirrorError> {
        let body = serde_json::to_value(request)?;
        let receipt = self
            .file_request::<DeleteFileReceipt>(
                Method::POST,
                &format!("{}/delete", request.file_id),
                Some(&body),
            )
            .await?;
        if receipt.protocol_version != FILE_PROTOCOL_VERSION
            || receipt.message_type != DeleteFileReceiptKind::FileDeleted
            || receipt.mutation_id != request.mutation_id
            || receipt.file_id != request.file_id
        {
            return Err(MirrorError::new(
                "invalid_sync_response",
                "Authority returned an invalid file delete receipt.",
            ));
        }
        Ok(receipt)
    }

    async fn changes(&self, after: u64, limit: usize) -> Result<SyncChangesPage, MirrorError> {
        self.request(
            Method::GET,
            &format!("changes?after={after}&limit={}", limit.clamp(1, 1_000)),
            None,
        )
        .await
    }

    async fn mutate(&self, mutation: &SyncMutation) -> Result<SyncMutationReceipt, MirrorError> {
        let body = serde_json::to_value(mutation)?;
        self.request(Method::POST, "mutations", Some(&body)).await
    }
}

impl HttpSyncTransport {
    async fn upload_file_transfer(
        &self,
        request: &OpenFileUploadRequest,
        source: &Path,
    ) -> Result<CommitFileUploadReceipt, MirrorError> {
        let body = serde_json::to_value(request)?;
        let session = self
            .file_request::<FileTransferSession>(Method::POST, "uploads", Some(&body))
            .await?;
        let (part_size, multipart) = match session.strategy {
            FileTransferStrategy::ObjectPut => (request.size.max(1), false),
            FileTransferStrategy::ObjectMultipart { part_size } if part_size > 0 => {
                (part_size, true)
            }
            _ => {
                return Err(MirrorError::new(
                    "invalid_sync_response",
                    "Authority returned an incompatible file upload strategy.",
                ))
            }
        };
        if session.protocol_version != FILE_TRANSFER_PROTOCOL_VERSION
            || session.message_type != FileTransferSessionKind::FileTransfer
            || session.transfer_id != request.transfer_id
            || session.direction != FileTransferDirection::Upload
            || session.protection != FileTransferProtection::TransportTls
            || session.total_size != request.size
        {
            return Err(MirrorError::new(
                "invalid_sync_response",
                "Authority returned an incompatible file upload session.",
            ));
        }
        let status = self
            .file_request::<FileTransferStatus>(
                Method::GET,
                &format!("transfers/{}", request.transfer_id),
                None,
            )
            .await?;
        let part_count = request.size.div_ceil(part_size).max(1);
        let (received, mut uploaded) = validate_upload_progress(
            status,
            request.transfer_id,
            request.size,
            part_size,
            multipart,
        )?;
        let mut input = File::open(source)
            .map_err(|error| MirrorError::io("Could not open staged upload", source, error))?;
        if input
            .metadata()
            .map(|metadata| metadata.len())
            .unwrap_or(u64::MAX)
            != request.size
        {
            return Err(MirrorError::new(
                "file_integrity_failed",
                "Staged upload length does not match its prepared request.",
            ));
        }
        for index in 0..part_count {
            if received.contains(&index) {
                continue;
            }
            let offset = index * part_size;
            let length = part_size.min(request.size.saturating_sub(offset));
            let part_number = u16::try_from(index + 1).map_err(|_| {
                MirrorError::new("file_upload_failed", "File upload has too many parts.")
            })?;
            input
                .seek(SeekFrom::Start(offset))
                .map_err(|error| MirrorError::io("Could not seek staged upload", source, error))?;
            let mut bytes = vec![
                0_u8;
                usize::try_from(length).map_err(|_| {
                    MirrorError::new(
                        "file_upload_failed",
                        "Upload part is too large for this system.",
                    )
                })?
            ];
            input
                .read_exact(&mut bytes)
                .map_err(|error| MirrorError::io("Could not read staged upload", source, error))?;
            let mut completed_etag = None;
            for attempt in 1..=OBJECT_UPLOAD_MAX_ATTEMPTS {
                // Preparing the same part is idempotent. A fresh URL on every
                // retry avoids reusing a stale or rejected object-store
                // signature, while uploading the same multipart part number
                // safely replaces any ambiguous prior attempt.
                let prepared = self
                    .file_request::<PreparedFilePart>(
                        Method::POST,
                        &format!("uploads/{}/parts", request.transfer_id),
                        Some(&serde_json::to_value(PrepareFileUploadPartRequest {
                            protocol_version: FILE_PROTOCOL_VERSION,
                            message_type: PrepareFileUploadPartRequestKind::PrepareFileUploadPart,
                            transfer_id: request.transfer_id,
                            part_number,
                            content_length: length,
                        })?),
                    )
                    .await?;
                validate_prepared_part(&prepared, request.transfer_id, index, offset, length)?;
                let mut upload = self.client.put(&prepared.url).body(bytes.clone());
                for (name, value) in prepared.headers {
                    if matches!(
                        name.to_ascii_lowercase().as_str(),
                        "authorization"
                            | "cookie"
                            | "host"
                            | "proxy-authorization"
                            | "content-length"
                    ) {
                        continue;
                    }
                    upload = upload.header(&name, &value);
                }
                let response = upload.send().await.map_err(|error| {
                    transport_error(error, "file_upload_failed", "Object upload failed")
                })?;
                let status = response.status();
                if status.is_success() {
                    if multipart {
                        completed_etag = Some(
                            response
                                .headers()
                                .get(reqwest::header::ETAG)
                                .and_then(|value| value.to_str().ok())
                                .filter(|value| !value.is_empty())
                                .ok_or_else(|| {
                                    MirrorError::new(
                                        "invalid_sync_response",
                                        "Object storage omitted a multipart ETag.",
                                    )
                                })?
                                .to_string(),
                        );
                    }
                    break;
                }
                if attempt == OBJECT_UPLOAD_MAX_ATTEMPTS || !retryable_object_upload_status(status)
                {
                    return Err(MirrorError::new(
                        "file_upload_failed",
                        format!(
                            "Object storage returned HTTP {status} for part {part_number} after {attempt} attempt(s)."
                        ),
                    ));
                }
                tracing::warn!(
                    transfer_id = %request.transfer_id,
                    part_number,
                    attempt,
                    status = %status,
                    "object upload part will retry with a fresh signed URL"
                );
            }
            if let Some(etag) = completed_etag {
                uploaded.insert(index, UploadedFilePart { part_number, etag });
            }
        }
        let receipt = self
            .file_request::<CommitFileUploadReceipt>(
                Method::POST,
                &format!("uploads/{}/commit", request.transfer_id),
                Some(&serde_json::to_value(CommitFileUploadRequest {
                    protocol_version: FILE_PROTOCOL_VERSION,
                    message_type: CommitFileUploadRequestKind::CommitFileUpload,
                    transfer_id: request.transfer_id,
                    parts: uploaded.into_values().collect(),
                })?),
            )
            .await?;
        if receipt.protocol_version != FILE_PROTOCOL_VERSION
            || receipt.message_type != CommitFileUploadReceiptKind::FileUploadCommitted
            || receipt.transfer_id != request.transfer_id
        {
            return Err(MirrorError::new(
                "invalid_sync_response",
                "Authority returned an invalid file upload receipt.",
            ));
        }
        Ok(receipt)
    }

    async fn download_file_transfer(
        &self,
        file: &CollectionFileDescriptor,
        destination: &Path,
        transfer_id: Uuid,
    ) -> Result<(), MirrorError> {
        let session = self
            .file_request::<FileTransferSession>(
                Method::POST,
                "downloads",
                Some(&serde_json::to_value(OpenFileDownloadRequest {
                    protocol_version: FILE_PROTOCOL_VERSION,
                    message_type: OpenFileDownloadRequestKind::OpenFileDownload,
                    transfer_id,
                    file_id: file.file_id,
                    revision: Some(file.revision.clone()),
                })?),
            )
            .await?;
        let part_size = match session.strategy {
            FileTransferStrategy::ObjectRanges { part_size }
                if session.protocol_version == FILE_TRANSFER_PROTOCOL_VERSION
                    && session.transfer_id == transfer_id
                    && session.direction == FileTransferDirection::Download
                    && session.protection == FileTransferProtection::TransportTls
                    && session.total_size == file.size
                    && part_size > 0 =>
            {
                part_size
            }
            _ => {
                return Err(MirrorError::new(
                    "invalid_sync_response",
                    "The authority returned an incompatible file download session.",
                ))
            }
        };
        let mut output = File::create(destination)
            .map_err(|error| MirrorError::io("Could not stage", destination, error))?;
        let mut hasher = Sha256::new();
        let part_count = file.size.div_ceil(part_size);
        for part_index in 0..part_count {
            let offset = part_index.checked_mul(part_size).ok_or_else(|| {
                MirrorError::new("invalid_sync_response", "File part offset overflowed.")
            })?;
            let content_length = part_size.min(file.size - offset);
            let mut response = self
                .client
                .get(format!(
                    "{}/downloads/{transfer_id}/parts/{part_index}",
                    self.files_url
                ))
                .bearer_auth(&self.replica_token)
                .send()
                .await
                .map_err(|error| {
                    transport_error(error, "mirror_offline", "Hosted authority is unavailable")
                })?;
            if !response.status().is_success() {
                let status = response.status();
                let value = response.json::<Value>().await.unwrap_or(Value::Null);
                return Err(MirrorError::new(
                    value
                        .pointer("/error/code")
                        .and_then(Value::as_str)
                        .unwrap_or("file_download_failed"),
                    value
                        .pointer("/error/message")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned)
                        .unwrap_or_else(|| format!("Hosted authority returned HTTP {status}.")),
                ));
            }
            if response
                .content_length()
                .is_some_and(|length| length != content_length)
            {
                return Err(MirrorError::new(
                    "file_integrity_failed",
                    "Hosted authority returned a file part with the wrong length.",
                ));
            }
            let mut received = 0_u64;
            while let Some(bytes) = response.chunk().await.map_err(|error| {
                transport_error(
                    error,
                    "file_download_failed",
                    "Could not read the hosted file response",
                )
            })? {
                received = received.checked_add(bytes.len() as u64).ok_or_else(|| {
                    MirrorError::new("file_integrity_failed", "File part length overflowed.")
                })?;
                if received > content_length {
                    return Err(MirrorError::new(
                        "file_integrity_failed",
                        "Hosted authority returned an oversized file part.",
                    ));
                }
                output
                    .write_all(&bytes)
                    .map_err(|error| MirrorError::io("Could not stage", destination, error))?;
                hasher.update(&bytes);
            }
            if received != content_length {
                return Err(MirrorError::new(
                    "file_integrity_failed",
                    "Hosted authority returned a file part with the wrong length.",
                ));
            }
        }
        output
            .sync_all()
            .map_err(|error| MirrorError::io("Could not sync", destination, error))?;
        let digest = format!("sha256:{:x}", hasher.finalize());
        if output
            .metadata()
            .map(|metadata| metadata.len())
            .unwrap_or(u64::MAX)
            != file.size
            || digest != file.content_digest
        {
            return Err(MirrorError::new(
                "file_integrity_failed",
                "Downloaded file bytes do not match the authority manifest.",
            ));
        }
        Ok(())
    }
}

fn retryable_object_upload_status(status: reqwest::StatusCode) -> bool {
    matches!(status.as_u16(), 403 | 408 | 425 | 429) || status.is_server_error()
}

fn validate_prepared_part(
    part: &PreparedFilePart,
    transfer_id: Uuid,
    index: u64,
    offset: u64,
    length: u64,
) -> Result<(), MirrorError> {
    let endpoint = Url::parse(&part.url).map_err(|_| {
        MirrorError::new(
            "invalid_sync_response",
            "Authority returned an invalid object URL.",
        )
    })?;
    let loopback = matches!(endpoint.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
    if part.protocol_version != FILE_PROTOCOL_VERSION
        || part.message_type != PreparedFilePartKind::FilePart
        || part.transfer_id != transfer_id
        || part.part_index != index
        || part.offset != offset
        || part.content_length != length
        || !part.method.eq_ignore_ascii_case("PUT")
        || !(endpoint.scheme() == "https" || (endpoint.scheme() == "http" && loopback))
        || endpoint.host_str().is_none()
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
    {
        return Err(MirrorError::new(
            "invalid_sync_response",
            "Authority returned an invalid prepared upload part.",
        ));
    }
    Ok(())
}

fn validate_upload_progress(
    status: FileTransferStatus,
    transfer_id: Uuid,
    total_size: u64,
    part_size: u64,
    multipart: bool,
) -> Result<(HashSet<u64>, BTreeMap<u64, UploadedFilePart>), MirrorError> {
    if part_size == 0 {
        return Err(MirrorError::new(
            "invalid_sync_response",
            "Authority returned an invalid upload part size.",
        ));
    }
    let part_count = total_size.div_ceil(part_size).max(1);
    let received_bytes = status.received.iter().try_fold(0_u64, |total, index| {
        let offset = index.checked_mul(part_size).ok_or_else(|| {
            MirrorError::new(
                "invalid_sync_response",
                "Upload progress offset overflowed.",
            )
        })?;
        total
            .checked_add(part_size.min(total_size.saturating_sub(offset)))
            .ok_or_else(|| {
                MirrorError::new(
                    "invalid_sync_response",
                    "Upload progress length overflowed.",
                )
            })
    })?;
    if status.protocol_version != FILE_TRANSFER_PROTOCOL_VERSION
        || status.message_type != FileTransferStatusKind::FileTransferStatus
        || status.transfer_id != transfer_id
        || !matches!(
            status.state,
            FileTransferState::Open | FileTransferState::Committed
        )
        || status.received.iter().any(|index| *index >= part_count)
        || status
            .received
            .iter()
            .copied()
            .collect::<HashSet<_>>()
            .len()
            != status.received.len()
        || received_bytes != status.received_bytes
        || status.received_bytes > total_size
        || (status.state == FileTransferState::Committed
            && status.received.len() != usize::try_from(part_count).unwrap_or(usize::MAX))
    {
        return Err(MirrorError::new(
            "invalid_sync_response",
            format!(
                "Authority returned invalid file upload progress (state={:?}, received_parts={}, received_bytes={}, expected_parts={}, expected_bytes={}).",
                status.state,
                status.received.len(),
                status.received_bytes,
                part_count,
                total_size
            ),
        ));
    }
    let received = status.received.iter().copied().collect::<HashSet<_>>();
    let uploaded_parts = status.uploaded_parts;
    let valid_uploaded_parts = uploaded_parts.iter().enumerate().all(|(position, part)| {
        let index = u64::from(part.part_number).checked_sub(1);
        index.is_some_and(|index| index < part_count)
            && !part.etag.is_empty()
            && part.etag.len() <= 255
            && (position == 0 || uploaded_parts[position - 1].part_number < part.part_number)
    });
    if !valid_uploaded_parts
        || (!multipart && !uploaded_parts.is_empty())
        || (multipart
            && (uploaded_parts.len() != status.received.len()
                || uploaded_parts
                    .iter()
                    .zip(&status.received)
                    .any(|(part, index)| {
                        u64::from(part.part_number).checked_sub(1) != Some(*index)
                    })))
    {
        return Err(MirrorError::new(
            "invalid_sync_response",
            "Authority returned invalid multipart receipts.",
        ));
    }
    let uploaded = uploaded_parts
        .into_iter()
        .map(|part| (u64::from(part.part_number) - 1, part))
        .collect();
    Ok((received, uploaded))
}

#[cfg(test)]
mod tests;
