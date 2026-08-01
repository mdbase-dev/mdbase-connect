use super::*;

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

impl HttpSyncTransport {
    pub fn new(sync_url: &str, replica_token: impl Into<String>) -> Result<Self, MirrorError> {
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
            MirrorError::new(
                "mirror_offline",
                format!("Hosted authority is unavailable: {error}"),
            )
        })?;
        let status = response.status();
        let value = response.json::<Value>().await.map_err(|error| {
            MirrorError::new(
                "invalid_sync_response",
                format!("Hosted authority returned invalid JSON: {error}"),
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
                    MirrorError::new(
                        "mirror_offline",
                        format!("Hosted authority is unavailable: {error}"),
                    )
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
                MirrorError::new(
                    "file_download_failed",
                    format!("Could not read the hosted file response: {error}"),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sync_transport_derives_the_file_endpoint_from_one_valid_authority() {
        let authority_id = Uuid::new_v4();
        let transport = HttpSyncTransport::new(
            &format!("https://connect.example/v1/authorities/{authority_id}/sync"),
            "token",
        )
        .unwrap();
        assert_eq!(
            transport.files_url,
            format!("https://connect.example/v1/authorities/{authority_id}/files")
        );
        for invalid in [
            format!("http://connect.example/v1/authorities/{authority_id}/sync"),
            format!("https://other.example/v1/authorities/{authority_id}/files"),
            format!("https://connect.example/v1/authorities/{authority_id}/sync?next=evil"),
        ] {
            assert_eq!(
                HttpSyncTransport::new(&invalid, "token")
                    .err()
                    .unwrap()
                    .code,
                "invalid_sync_url"
            );
        }
    }
}
