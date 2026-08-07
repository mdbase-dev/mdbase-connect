use mdbase_connect_core::ConnectError;
use mdbase_connect_protocol::{
    AccessSnapshot, ApplicationSummary, AuthorityImportManifest, AuthorityImportRecordPage,
    AuthoritySnapshot, AuthorizationApproveParams, AuthorizationIdParams, CommitFileUploadReceipt,
    CommitFileUploadRequest, CommitFileUploadRequestKind, ComputerNameParams, FileTransferSession,
    FileTransferStrategy, GrantCreateParams, GrantIdParams, GrantUpdateParams,
    OpenAuthorityImportFileUploadRequest, OpenAuthorityImportFileUploadRequestKind,
    PrepareFileUploadPartRequest, PrepareFileUploadPartRequestKind, PreparedFilePart,
    UploadedFilePart, CONTROL_PROTOCOL_VERSION, FILE_PROTOCOL_VERSION,
};
use reqwest::{redirect::Policy, Client, Method, Response};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

#[derive(Clone)]
pub struct CloudControlClient {
    client: Client,
    object_client: Client,
    server_url: String,
    connector_token: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RemoteAuthorityTransfer {
    pub id: uuid::Uuid,
    pub collection_id: uuid::Uuid,
    pub state: String,
    pub authority_epoch: u64,
    pub final_head: Option<u64>,
    pub manifest_digest: Option<String>,
    pub source_revision: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AuthorityImportCapability {
    pub import_id: uuid::Uuid,
    pub manifest_url: String,
    pub records_url: String,
    pub files_url: String,
    pub finalize_url: String,
    pub access_token: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BeginRemoteAuthorityTransfer {
    pub transfer: RemoteAuthorityTransfer,
    pub import: Option<AuthorityImportCapability>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CompleteRemoteAuthorityTransfer {
    pub status: String,
    pub collection_id: uuid::Uuid,
    pub authority_epoch: u64,
}

impl CloudControlClient {
    pub fn new(server_url: String, connector_token: String) -> Self {
        crate::ensure_tls_crypto_provider();
        Self {
            client: Client::builder()
                .redirect(Policy::none())
                .build()
                .expect("no-redirect HTTP client configuration is valid"),
            object_client: Client::builder()
                .redirect(Policy::none())
                .build()
                .expect("no-redirect HTTP client configuration is valid"),
            server_url: server_url.trim_end_matches('/').to_string(),
            connector_token,
        }
    }

    pub async fn snapshot(&self) -> Result<AccessSnapshot, ConnectError> {
        self.json(Method::GET, "/v1/connectors/control", None).await
    }

    pub fn server_url(&self) -> &str {
        &self.server_url
    }

    pub(crate) async fn connector_request<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<T, ConnectError> {
        self.json(method, path, body).await
    }

    pub(crate) async fn revoke_hosted_replica(
        &self,
        replica_id: uuid::Uuid,
    ) -> Result<(), ConnectError> {
        let response = self
            .client
            .delete(format!(
                "{}/v1/connectors/hosted/replicas/{replica_id}",
                self.server_url
            ))
            .timeout(Duration::from_secs(15))
            .bearer_auth(&self.connector_token)
            .send()
            .await
            .map_err(cloud_error)?;
        let status = response.status();
        let bytes = response.bytes().await.map_err(cloud_error)?;
        if status.is_success() {
            return Ok(());
        }
        let body = serde_json::from_slice::<Value>(&bytes).ok();
        let code = body
            .as_ref()
            .and_then(|body| body.pointer("/error/code"))
            .and_then(Value::as_str);
        if status == reqwest::StatusCode::NOT_FOUND && code == Some("replica_not_found") {
            return Ok(());
        }
        let message = body
            .as_ref()
            .and_then(|body| body.pointer("/error/message"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("Cloud request failed with HTTP {status}"));
        Err(ConnectError::Cloud(message))
    }

    pub async fn rename_computer(
        &self,
        params: &ComputerNameParams,
    ) -> Result<Value, ConnectError> {
        self.json(
            Method::PATCH,
            "/v1/connectors/self",
            Some(serde_json::to_value(params)?),
        )
        .await
    }

    pub async fn take_collection_authority(
        &self,
        collection_id: uuid::Uuid,
    ) -> Result<Value, ConnectError> {
        self.json(
            Method::POST,
            &format!("/v1/connectors/authority-conflicts/{collection_id}/move"),
            None,
        )
        .await
    }

    pub async fn begin_remote_authority_transfer(
        &self,
        collection_id: uuid::Uuid,
    ) -> Result<BeginRemoteAuthorityTransfer, ConnectError> {
        self.json(
            Method::POST,
            &format!("/v1/connectors/collections/{collection_id}/authority-transfers"),
            Some(serde_json::json!({})),
        )
        .await
    }

    pub async fn upload_authority_snapshot(
        &self,
        capability: &AuthorityImportCapability,
        snapshot: &AuthoritySnapshot,
        collection_root: &Path,
    ) -> Result<(), ConnectError> {
        let manifest = AuthorityImportManifest {
            protocol_version: CONTROL_PROTOCOL_VERSION,
            collection_id: snapshot.collection_id,
            source_head: snapshot.source_head,
            source_revision: snapshot.source_revision.clone(),
            manifest_digest: snapshot.manifest_digest.clone(),
            resources: snapshot.resources.clone(),
            record_count: snapshot.records.len() as u64,
            file_count: snapshot.files.len() as u64,
            files: snapshot.files.clone(),
        };
        let _: Value = self
            .external_json(
                Method::PUT,
                &capability.manifest_url,
                &capability.access_token,
                Some(serde_json::to_value(manifest)?),
            )
            .await?;
        for file in &snapshot.files {
            self.upload_authority_file(capability, collection_root, file)
                .await?;
        }
        const PAGE_BYTES: usize = 8 * 1024 * 1024;
        let mut page_number = 0_u64;
        let mut page = Vec::new();
        let mut page_bytes = 0_usize;
        for record in &snapshot.records {
            let record_bytes = serde_json::to_vec(record)?.len();
            if !page.is_empty() && (page.len() == 200 || page_bytes + record_bytes > PAGE_BYTES) {
                self.upload_authority_page(capability, page_number, std::mem::take(&mut page))
                    .await?;
                page_number += 1;
                page_bytes = 0;
            }
            page.push(mdbase_connect_protocol::AuthorityImportRecord {
                record_id: record.record_id,
                path: record.path.clone(),
                document: record.document.clone(),
            });
            page_bytes += record_bytes;
        }
        if !page.is_empty() {
            self.upload_authority_page(capability, page_number, page)
                .await?;
        }
        let _: Value = self
            .external_json(
                Method::POST,
                &capability.finalize_url,
                &capability.access_token,
                None,
            )
            .await?;
        Ok(())
    }

    async fn upload_authority_file(
        &self,
        capability: &AuthorityImportCapability,
        collection_root: &Path,
        file: &mdbase_connect_protocol::CollectionFileDescriptor,
    ) -> Result<(), ConnectError> {
        let transfer_id = uuid::Uuid::new_v5(
            &capability.import_id,
            format!(
                "{}\0{}\0{}",
                file.file_id, file.revision, file.content_digest
            )
            .as_bytes(),
        );
        let session: FileTransferSession = self
            .external_json(
                Method::POST,
                &format!("{}/uploads", capability.files_url.trim_end_matches('/')),
                &capability.access_token,
                Some(serde_json::to_value(
                    OpenAuthorityImportFileUploadRequest {
                        protocol_version: FILE_PROTOCOL_VERSION,
                        message_type:
                            OpenAuthorityImportFileUploadRequestKind::OpenAuthorityImportFileUpload,
                        transfer_id,
                        file_id: file.file_id,
                    },
                )?),
            )
            .await?;
        if session.transfer_id != transfer_id
            || session.direction != mdbase_connect_protocol::FileTransferDirection::Upload
            || session.protection != mdbase_connect_protocol::FileTransferProtection::TransportTls
            || session.total_size != file.size
            || !matches!(
                session.strategy,
                FileTransferStrategy::ObjectPut | FileTransferStrategy::ObjectMultipart { .. }
            )
        {
            return Err(ConnectError::Cloud(
                "Hosted import returned an invalid file upload session.".to_string(),
            ));
        }
        let part_size = match session.strategy {
            FileTransferStrategy::ObjectPut => file.size.max(1),
            FileTransferStrategy::ObjectMultipart { part_size } => part_size,
            _ => unreachable!(),
        };
        let part_count = file.size.div_ceil(part_size).max(1);
        let received = session
            .received
            .iter()
            .copied()
            .collect::<std::collections::BTreeSet<_>>();
        let uploaded_parts = session
            .uploaded_parts
            .iter()
            .map(|part| {
                if part.part_number == 0 || part.etag.is_empty() || part.etag.len() > 255 {
                    return Err(ConnectError::Cloud(
                        "Hosted import returned invalid file upload progress.".to_string(),
                    ));
                }
                Ok((u64::from(part.part_number - 1), part.clone()))
            })
            .collect::<Result<std::collections::BTreeMap<_, _>, _>>()?;
        if received.len() != session.received.len()
            || received.iter().any(|index| *index >= part_count)
            || part_count > u64::from(u16::MAX)
            || session
                .uploaded_parts
                .windows(2)
                .any(|parts| parts[0].part_number >= parts[1].part_number)
            || (matches!(
                session.strategy,
                FileTransferStrategy::ObjectMultipart { .. }
            ) && (uploaded_parts.len() != received.len()
                || uploaded_parts
                    .keys()
                    .copied()
                    .collect::<std::collections::BTreeSet<_>>()
                    != received))
            || (!matches!(
                session.strategy,
                FileTransferStrategy::ObjectMultipart { .. }
            ) && !uploaded_parts.is_empty())
        {
            return Err(ConnectError::Cloud(
                "Hosted import returned invalid file upload progress.".to_string(),
            ));
        }
        if session.received.len() as u64 == part_count {
            let replay = self
                .commit_authority_file(
                    capability,
                    transfer_id,
                    uploaded_parts.values().cloned().collect(),
                )
                .await;
            match replay {
                Ok(receipt) => {
                    if receipt.transfer_id != transfer_id || receipt.file != *file {
                        return Err(ConnectError::Cloud(
                            "Hosted import returned an invalid file upload receipt.".to_string(),
                        ));
                    }
                    return Ok(());
                }
                Err(ConnectError::CloudProblem { code, .. })
                    if code == "file_upload_incomplete"
                        && matches!(
                            session.strategy,
                            FileTransferStrategy::ObjectMultipart { .. }
                        ) => {}
                Err(error) => return Err(error),
            }
        }
        let source_path = safe_import_source(collection_root, &file.path)?;
        let mut source = open_import_source(&source_path).map_err(|error| {
            ConnectError::Cloud(format!(
                "Could not open authority file {}: {error}",
                file.path
            ))
        })?;
        let mut parts = uploaded_parts;
        for index in 0..part_count {
            let offset = index
                .checked_mul(part_size)
                .ok_or_else(|| ConnectError::Cloud("File upload offset overflowed.".to_string()))?;
            let length = file.size.saturating_sub(offset).min(part_size);
            if received.contains(&index) {
                continue;
            }
            source.seek(std::io::SeekFrom::Start(offset)).await?;
            let mut bytes = vec![
                0_u8;
                usize::try_from(length).map_err(|_| ConnectError::Cloud(
                    "File upload part is too large.".to_string()
                ))?
            ];
            source.read_exact(&mut bytes).await?;
            let prepared: PreparedFilePart = self
                .external_json(
                    Method::POST,
                    &format!(
                        "{}/uploads/{transfer_id}/parts",
                        capability.files_url.trim_end_matches('/')
                    ),
                    &capability.access_token,
                    Some(serde_json::to_value(PrepareFileUploadPartRequest {
                        protocol_version: FILE_PROTOCOL_VERSION,
                        message_type: PrepareFileUploadPartRequestKind::PrepareFileUploadPart,
                        transfer_id,
                        part_number: u16::try_from(index + 1).map_err(|_| {
                            ConnectError::Cloud("Too many file upload parts.".to_string())
                        })?,
                        content_length: length,
                    })?),
                )
                .await?;
            validate_import_prepared_part(&prepared, transfer_id, index, offset, length)?;
            let mut request = self.object_client.put(&prepared.url).body(bytes);
            for (name, value) in &prepared.headers {
                if !matches!(
                    name.to_ascii_lowercase().as_str(),
                    "authorization" | "cookie" | "host" | "proxy-authorization" | "content-length"
                ) {
                    request = request.header(name, value);
                }
            }
            let response = request
                .send()
                .await
                .map_err(|error| ConnectError::Cloud(format!("R2 file upload failed: {error}")))?;
            if !response.status().is_success() {
                return Err(ConnectError::Cloud(format!(
                    "R2 file upload returned HTTP {}.",
                    response.status()
                )));
            }
            if matches!(
                session.strategy,
                FileTransferStrategy::ObjectMultipart { .. }
            ) {
                let etag = response
                    .headers()
                    .get(reqwest::header::ETAG)
                    .and_then(|value| value.to_str().ok())
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| {
                        ConnectError::Cloud("R2 multipart upload omitted an ETag.".to_string())
                    })?;
                parts.insert(
                    index,
                    UploadedFilePart {
                        part_number: u16::try_from(index + 1).unwrap(),
                        etag: etag.to_string(),
                    },
                );
            }
        }
        let receipt = self
            .commit_authority_file(capability, transfer_id, parts.into_values().collect())
            .await?;
        if receipt.transfer_id != transfer_id || receipt.file != *file {
            return Err(ConnectError::Cloud(
                "Hosted import returned an invalid file upload receipt.".to_string(),
            ));
        }
        Ok(())
    }

    async fn commit_authority_file(
        &self,
        capability: &AuthorityImportCapability,
        transfer_id: uuid::Uuid,
        parts: Vec<UploadedFilePart>,
    ) -> Result<CommitFileUploadReceipt, ConnectError> {
        self.external_json(
            Method::POST,
            &format!(
                "{}/uploads/{transfer_id}/commit",
                capability.files_url.trim_end_matches('/')
            ),
            &capability.access_token,
            Some(serde_json::to_value(CommitFileUploadRequest {
                protocol_version: FILE_PROTOCOL_VERSION,
                message_type: CommitFileUploadRequestKind::CommitFileUpload,
                transfer_id,
                parts,
            })?),
        )
        .await
    }

    async fn upload_authority_page(
        &self,
        capability: &AuthorityImportCapability,
        page: u64,
        records: Vec<mdbase_connect_protocol::AuthorityImportRecord>,
    ) -> Result<(), ConnectError> {
        self.external_json::<Value>(
            Method::PUT,
            &capability.records_url,
            &capability.access_token,
            Some(serde_json::to_value(AuthorityImportRecordPage {
                protocol_version: CONTROL_PROTOCOL_VERSION,
                page,
                records,
            })?),
        )
        .await
        .map(|_| ())
    }

    pub async fn complete_remote_authority_transfer(
        &self,
        transfer_id: uuid::Uuid,
        manifest_digest: &str,
        source_revision: &str,
        source_head: u64,
    ) -> Result<CompleteRemoteAuthorityTransfer, ConnectError> {
        self.json(
            Method::POST,
            &format!("/v1/connectors/authority-transfers/{transfer_id}/complete"),
            Some(serde_json::json!({
                "manifest_digest": manifest_digest,
                "source_revision": source_revision,
                "source_head": source_head,
            })),
        )
        .await
    }

    pub async fn cancel_remote_authority_transfer(
        &self,
        transfer_id: uuid::Uuid,
    ) -> Result<(), ConnectError> {
        let _: Value = self
            .json(
                Method::DELETE,
                &format!("/v1/connectors/authority-transfers/{transfer_id}"),
                None,
            )
            .await?;
        Ok(())
    }

    pub async fn application(
        &self,
        application_id: uuid::Uuid,
    ) -> Result<ApplicationSummary, ConnectError> {
        let value: Value = self
            .json(
                Method::GET,
                &format!("/v1/connectors/apps/{application_id}"),
                None,
            )
            .await?;
        serde_json::from_value(value["application"].clone()).map_err(ConnectError::from)
    }

    pub async fn create_grant(
        &self,
        params: &GrantCreateParams,
        contracts: &[mdbase_connect_protocol::CollectionContractDescriptor],
    ) -> Result<Value, ConnectError> {
        self.json(
            Method::POST,
            "/v1/connectors/grants",
            Some(serde_json::json!({
                "application_id": params.application_id,
                "collection_id": params.collection_id,
                "operations": params.operations,
                "contracts": contracts,
            })),
        )
        .await
    }

    pub async fn update_grant(&self, params: &GrantUpdateParams) -> Result<Value, ConnectError> {
        self.json(
            Method::PATCH,
            &format!("/v1/connectors/grants/{}", params.grant_id),
            Some(serde_json::json!({ "operations": params.operations })),
        )
        .await
    }

    pub async fn revoke_grant(&self, params: &GrantIdParams) -> Result<Value, ConnectError> {
        self.json(
            Method::DELETE,
            &format!("/v1/connectors/grants/{}", params.grant_id),
            None,
        )
        .await
    }

    pub async fn approve_authorization(
        &self,
        params: &AuthorizationApproveParams,
        contracts: &[mdbase_connect_protocol::CollectionContractDescriptor],
    ) -> Result<Value, ConnectError> {
        self.json(
            Method::POST,
            &format!(
                "/v1/connectors/authorization-requests/{}/approve",
                params.request_id
            ),
            Some(serde_json::json!({
                "collection_id": params.collection_id,
                "operations": params.operations,
                "contracts": contracts,
                "contract_setups": params.contract_setups,
            })),
        )
        .await
    }

    pub async fn deny_authorization(
        &self,
        params: &AuthorizationIdParams,
    ) -> Result<Value, ConnectError> {
        self.json(
            Method::POST,
            &format!(
                "/v1/connectors/authorization-requests/{}/deny",
                params.request_id
            ),
            None,
        )
        .await
    }

    pub async fn emit_notification_signal(
        &self,
        signal_id: &str,
        grant_id: uuid::Uuid,
        criterion_id: &str,
        cursor: &str,
    ) -> Result<Value, ConnectError> {
        self.json(
            Method::POST,
            "/v1/connectors/notification-signals",
            Some(serde_json::json!({
                "signal_id": signal_id,
                "grant_id": grant_id,
                "criterion_id": criterion_id,
                "cursor": cursor,
            })),
        )
        .await
    }

    async fn json<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<T, ConnectError> {
        let mut request = self
            .client
            .request(method, format!("{}{}", self.server_url, path))
            .timeout(Duration::from_secs(15))
            .bearer_auth(&self.connector_token);
        if let Some(body) = body {
            request = request.json(&body);
        }
        decode(request.send().await.map_err(cloud_error)?).await
    }

    async fn external_json<T: DeserializeOwned>(
        &self,
        method: Method,
        url: &str,
        token: &str,
        body: Option<Value>,
    ) -> Result<T, ConnectError> {
        let mut request = self
            .client
            .request(method, url)
            .timeout(Duration::from_secs(60))
            .bearer_auth(token);
        if let Some(body) = body {
            request = request.json(&body);
        }
        decode(request.send().await.map_err(cloud_error)?).await
    }
}

fn safe_import_source(root: &Path, relative: &str) -> Result<PathBuf, ConnectError> {
    if relative.starts_with('/')
        || relative.contains('\\')
        || relative
            .split('/')
            .any(|part| part.is_empty() || matches!(part, "." | ".."))
    {
        return Err(ConnectError::Cloud(
            "Authority file path is unsafe.".to_string(),
        ));
    }
    let root = std::fs::canonicalize(root)?;
    let mut candidate = root.clone();
    for component in relative.split('/') {
        candidate.push(component);
        let metadata = std::fs::symlink_metadata(&candidate)?;
        if metadata.file_type().is_symlink() {
            return Err(ConnectError::Cloud(
                "Authority files cannot traverse symbolic links.".to_string(),
            ));
        }
    }
    let canonical = std::fs::canonicalize(&candidate)?;
    if !canonical.starts_with(&root) {
        return Err(ConnectError::Cloud(
            "Authority file escaped its collection root.".to_string(),
        ));
    }
    let metadata = std::fs::metadata(&canonical)?;
    if !metadata.is_file() || has_multiple_links(&metadata) {
        return Err(ConnectError::Cloud(
            "Authority file must be one regular, non-hard-linked file.".to_string(),
        ));
    }
    Ok(canonical)
}

fn open_import_source(path: &Path) -> std::io::Result<tokio::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || has_multiple_links(&metadata) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "authority source is not a regular, single-link file",
        ));
    }
    Ok(tokio::fs::File::from_std(file))
}

#[cfg(unix)]
fn has_multiple_links(metadata: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    metadata.nlink() != 1
}

#[cfg(not(unix))]
fn has_multiple_links(_metadata: &std::fs::Metadata) -> bool {
    false
}

fn validate_import_prepared_part(
    part: &PreparedFilePart,
    transfer_id: uuid::Uuid,
    part_index: u64,
    offset: u64,
    content_length: u64,
) -> Result<(), ConnectError> {
    let url = reqwest::Url::parse(&part.url).map_err(|_| {
        ConnectError::Cloud("Hosted import returned an invalid R2 URL.".to_string())
    })?;
    let secure = url.scheme() == "https"
        || (url.scheme() == "http"
            && url
                .host_str()
                .is_some_and(|host| matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]")));
    if part.protocol_version != FILE_PROTOCOL_VERSION
        || part.transfer_id != transfer_id
        || part.part_index != part_index
        || part.offset != offset
        || part.content_length != content_length
        || !part.method.eq_ignore_ascii_case("PUT")
        || !secure
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(ConnectError::Cloud(
            "Hosted import returned an invalid R2 upload part.".to_string(),
        ));
    }
    Ok(())
}

async fn decode<T: DeserializeOwned>(response: Response) -> Result<T, ConnectError> {
    let status = response.status();
    let bytes = response.bytes().await.map_err(cloud_error)?;
    if !status.is_success() {
        if let Ok(body) = serde_json::from_slice::<Value>(&bytes) {
            if let (Some(code), Some(message)) = (
                body.pointer("/error/code").and_then(Value::as_str),
                body.pointer("/error/message").and_then(Value::as_str),
            ) {
                return Err(ConnectError::CloudProblem {
                    code: code.to_string(),
                    message: message.to_string(),
                });
            }
        }
        return Err(ConnectError::Cloud(format!(
            "Cloud request failed with HTTP {status}"
        )));
    }
    serde_json::from_slice(&bytes).map_err(ConnectError::from)
}

fn cloud_error(error: reqwest::Error) -> ConnectError {
    ConnectError::Cloud(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use mdbase_connect_protocol::PreparedFilePartKind;
    use std::collections::BTreeMap;

    fn prepared_part(url: &str, transfer_id: uuid::Uuid) -> PreparedFilePart {
        PreparedFilePart {
            protocol_version: FILE_PROTOCOL_VERSION,
            message_type: PreparedFilePartKind::FilePart,
            transfer_id,
            part_index: 2,
            offset: 16,
            content_length: 8,
            method: "PUT".to_string(),
            url: url.to_string(),
            headers: BTreeMap::new(),
            expires_at: "2030-01-01T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn import_sources_are_confined_regular_single_link_files() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("collection");
        let nested = root.join("Photos");
        std::fs::create_dir_all(&nested).unwrap();
        let source = nested.join("image.bin");
        std::fs::write(&source, b"exact bytes").unwrap();

        assert_eq!(
            safe_import_source(&root, "Photos/image.bin").unwrap(),
            std::fs::canonicalize(&source).unwrap()
        );
        for unsafe_path in [
            "/absolute.bin",
            "../outside.bin",
            "Photos/../image.bin",
            "Photos\\image.bin",
            "Photos//image.bin",
            "./image.bin",
        ] {
            assert!(safe_import_source(&root, unsafe_path).is_err());
        }
        assert!(safe_import_source(&root, "Photos").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn import_sources_reject_symlinks_and_hard_links() {
        use std::os::unix::fs::symlink;

        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("collection");
        let outside = temporary.path().join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.bin"), b"secret").unwrap();
        symlink(&outside, root.join("linked")).unwrap();
        assert!(safe_import_source(&root, "linked/secret.bin").is_err());

        let original = root.join("original.bin");
        std::fs::write(&original, b"shared inode").unwrap();
        std::fs::hard_link(&original, root.join("alias.bin")).unwrap();
        assert!(safe_import_source(&root, "original.bin").is_err());
        assert!(open_import_source(&original).is_err());
    }

    #[test]
    fn prepared_r2_parts_are_bound_to_the_exact_upload_range() {
        let transfer_id = uuid::Uuid::now_v7();
        let valid = prepared_part(
            "https://objects.example/upload?signature=opaque",
            transfer_id,
        );
        validate_import_prepared_part(&valid, transfer_id, 2, 16, 8).unwrap();

        let local = prepared_part("http://127.0.0.1:9000/upload", transfer_id);
        validate_import_prepared_part(&local, transfer_id, 2, 16, 8).unwrap();

        for invalid_url in [
            "http://objects.example/upload",
            "https://user:secret@objects.example/upload",
            "file:///tmp/upload",
            "not a url",
        ] {
            let invalid = prepared_part(invalid_url, transfer_id);
            assert!(validate_import_prepared_part(&invalid, transfer_id, 2, 16, 8).is_err());
        }

        let mut wrong = valid.clone();
        wrong.method = "POST".to_string();
        assert!(validate_import_prepared_part(&wrong, transfer_id, 2, 16, 8).is_err());
        assert!(validate_import_prepared_part(&valid, uuid::Uuid::now_v7(), 2, 16, 8).is_err());
        assert!(validate_import_prepared_part(&valid, transfer_id, 3, 16, 8).is_err());
        assert!(validate_import_prepared_part(&valid, transfer_id, 2, 24, 8).is_err());
        assert!(validate_import_prepared_part(&valid, transfer_id, 2, 16, 7).is_err());
    }
}
