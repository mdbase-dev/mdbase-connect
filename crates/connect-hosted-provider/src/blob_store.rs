use crate::{ApiError, ApiResult};
use async_trait::async_trait;
use aws_credential_types::Credentials;
use aws_sdk_s3::config::{BehaviorVersion, Region};
use aws_sdk_s3::presigning::PresigningConfig;
use aws_sdk_s3::types::{CompletedMultipartUpload, CompletedPart};
use aws_sdk_s3::Client;
use axum::body::Bytes;
use futures_util::{stream, Stream};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fmt;
use std::pin::Pin;
use std::time::Duration;
use url::Url;

const MIN_MULTIPART_PART_BYTES: u64 = 5 * 1024 * 1024;
const MAX_MULTIPART_PART_BYTES: u64 = 5 * 1024 * 1024 * 1024;
const MIN_DOWNLOAD_PART_BYTES: u64 = 64 * 1024;
const MAX_DOWNLOAD_PART_BYTES: u64 = 32 * 1024 * 1024;
const MAX_PRESIGN_SECONDS: u64 = 7 * 24 * 60 * 60;
const PROVIDER_OBJECT_PREFIX: &str = "v1/";

pub type BlobStreamError = Box<dyn std::error::Error + Send + Sync>;
pub type BlobByteStream =
    Pin<Box<dyn Stream<Item = Result<Bytes, BlobStreamError>> + Send + 'static>>;

#[derive(Clone, PartialEq, Eq)]
pub struct R2Config {
    pub endpoint: String,
    pub bucket: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    pub session_token: Option<String>,
    pub multipart_part_bytes: u64,
    pub download_part_bytes: u64,
    pub presign_ttl: Duration,
    allow_insecure_loopback: bool,
}

impl fmt::Debug for R2Config {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("R2Config")
            .field("endpoint", &self.endpoint)
            .field("bucket", &self.bucket)
            .field("access_key_id", &"[redacted]")
            .field("secret_access_key", &"[redacted]")
            .field(
                "session_token",
                &self.session_token.as_ref().map(|_| "[redacted]"),
            )
            .field("multipart_part_bytes", &self.multipart_part_bytes)
            .field("download_part_bytes", &self.download_part_bytes)
            .field("presign_ttl", &self.presign_ttl)
            .field("allow_insecure_loopback", &self.allow_insecure_loopback)
            .finish()
    }
}

impl R2Config {
    pub fn new(
        endpoint: impl Into<String>,
        bucket: impl Into<String>,
        access_key_id: impl Into<String>,
        secret_access_key: impl Into<String>,
        multipart_part_bytes: u64,
        download_part_bytes: u64,
        presign_ttl: Duration,
    ) -> ApiResult<Self> {
        let config = Self {
            endpoint: endpoint.into(),
            bucket: bucket.into(),
            access_key_id: access_key_id.into(),
            secret_access_key: secret_access_key.into(),
            session_token: None,
            multipart_part_bytes,
            download_part_bytes,
            presign_ttl,
            allow_insecure_loopback: false,
        };
        config.validate()?;
        Ok(config)
    }

    pub fn new_insecure_loopback(
        endpoint: impl Into<String>,
        bucket: impl Into<String>,
        access_key_id: impl Into<String>,
        secret_access_key: impl Into<String>,
        multipart_part_bytes: u64,
        download_part_bytes: u64,
        presign_ttl: Duration,
    ) -> ApiResult<Self> {
        let mut config = Self {
            endpoint: endpoint.into(),
            bucket: bucket.into(),
            access_key_id: access_key_id.into(),
            secret_access_key: secret_access_key.into(),
            session_token: None,
            multipart_part_bytes,
            download_part_bytes,
            presign_ttl,
            allow_insecure_loopback: true,
        };
        config.validate()?;
        config.endpoint = config.endpoint.trim_end_matches('/').to_string();
        Ok(config)
    }

    pub fn with_session_token(mut self, session_token: Option<String>) -> ApiResult<Self> {
        self.session_token = session_token;
        self.validate()?;
        Ok(self)
    }

    fn validate(&self) -> ApiResult<()> {
        let endpoint = Url::parse(&self.endpoint).map_err(|_| invalid_r2_config())?;
        let secure_endpoint = endpoint.scheme() == "https";
        let allowed_loopback = self.allow_insecure_loopback
            && endpoint.scheme() == "http"
            && endpoint
                .host_str()
                .is_some_and(|host| matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1"));
        if (!secure_endpoint && !allowed_loopback)
            || endpoint.host_str().is_none()
            || endpoint.path() != "/"
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
            || self.bucket.trim().is_empty()
            || self.bucket.len() > 255
            || self.access_key_id.trim().is_empty()
            || self.secret_access_key.trim().is_empty()
            || self
                .session_token
                .as_ref()
                .is_some_and(|token| token.trim().is_empty())
            || !(MIN_MULTIPART_PART_BYTES..=MAX_MULTIPART_PART_BYTES)
                .contains(&self.multipart_part_bytes)
            || !(MIN_DOWNLOAD_PART_BYTES..=MAX_DOWNLOAD_PART_BYTES)
                .contains(&self.download_part_bytes)
            || self.presign_ttl.is_zero()
            || self.presign_ttl.as_secs() > MAX_PRESIGN_SECONDS
        {
            return Err(invalid_r2_config());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PresignedPart {
    pub method: String,
    pub url: String,
    pub headers: BTreeMap<String, String>,
    pub expires_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UploadedPart {
    pub part_number: i32,
    pub etag: String,
}

#[derive(Clone)]
pub struct R2BlobStore {
    client: Client,
    config: R2Config,
}

impl R2BlobStore {
    pub fn new(config: R2Config) -> Self {
        let credentials = Credentials::new(
            config.access_key_id.clone(),
            config.secret_access_key.clone(),
            config.session_token.clone(),
            None,
            "mdbase-connect-r2",
        );
        let sdk_config = aws_sdk_s3::Config::builder()
            .behavior_version(BehaviorVersion::latest())
            .region(Region::new("auto"))
            .credentials_provider(credentials)
            .endpoint_url(&config.endpoint)
            .force_path_style(true)
            .build();
        Self {
            client: Client::from_conf(sdk_config),
            config,
        }
    }
}

#[async_trait]
pub trait BlobStore: Send + Sync {
    fn upload_part_size(&self) -> u64;
    fn download_part_size(&self) -> u64;
    async fn ready(&self) -> ApiResult<()>;
    async fn create_multipart(&self, key: &str) -> ApiResult<String>;
    async fn presign_put(&self, key: &str, content_length: u64) -> ApiResult<PresignedPart>;
    async fn presign_part(
        &self,
        key: &str,
        upload_id: &str,
        part_number: i32,
        content_length: u64,
    ) -> ApiResult<PresignedPart>;
    async fn complete_multipart(
        &self,
        key: &str,
        upload_id: &str,
        parts: &[UploadedPart],
    ) -> ApiResult<()>;
    async fn list_multipart_parts(
        &self,
        key: &str,
        upload_id: &str,
    ) -> ApiResult<Vec<UploadedPart>>;
    async fn abort_multipart(&self, key: &str, upload_id: &str) -> ApiResult<()>;
    async fn object_exists(&self, key: &str) -> ApiResult<bool>;
    async fn copy(&self, source_key: &str, destination_key: &str) -> ApiResult<()>;
    async fn verify_object(&self, key: &str, size: u64, content_digest: &str) -> ApiResult<()>;
    async fn read_range(&self, key: &str, offset: u64, length: u64) -> ApiResult<BlobByteStream>;
    async fn delete(&self, key: &str) -> ApiResult<()>;
}

#[async_trait]
impl BlobStore for R2BlobStore {
    fn upload_part_size(&self) -> u64 {
        self.config.multipart_part_bytes
    }

    fn download_part_size(&self) -> u64 {
        self.config.download_part_bytes
    }

    async fn ready(&self) -> ApiResult<()> {
        self.client
            .list_objects_v2()
            .bucket(&self.config.bucket)
            .prefix(PROVIDER_OBJECT_PREFIX)
            .max_keys(1)
            .send()
            .await
            .map_err(|error| r2_unavailable("list provider object namespace", &error))?;
        Ok(())
    }

    async fn create_multipart(&self, key: &str) -> ApiResult<String> {
        validate_object_key(key)?;
        let output = self
            .client
            .create_multipart_upload()
            .bucket(&self.config.bucket)
            .key(key)
            .send()
            .await
            .map_err(|error| r2_unavailable("create multipart upload", &error))?;
        output
            .upload_id()
            .map(str::to_string)
            .ok_or_else(|| ApiError::internal("R2 did not return a multipart upload ID."))
    }

    async fn presign_put(&self, key: &str, content_length: u64) -> ApiResult<PresignedPart> {
        validate_object_key(key)?;
        let content_length = i64::try_from(content_length)
            .map_err(|_| ApiError::bad_request("invalid_file_size", "File is too large."))?;
        let request = self
            .client
            .put_object()
            .bucket(&self.config.bucket)
            .key(key)
            .content_length(content_length)
            .presigned(self.presigning_config()?)
            .await
            .map_err(|error| r2_unavailable("presign object upload", &error))?;
        Ok(self.prepared_request(request))
    }

    async fn presign_part(
        &self,
        key: &str,
        upload_id: &str,
        part_number: i32,
        content_length: u64,
    ) -> ApiResult<PresignedPart> {
        validate_object_key(key)?;
        if upload_id.is_empty()
            || !(1..=10_000).contains(&part_number)
            || content_length == 0
            || content_length > MAX_MULTIPART_PART_BYTES
        {
            return Err(ApiError::bad_request(
                "invalid_file_part",
                "The requested R2 multipart part is invalid.",
            ));
        }
        let content_length = i64::try_from(content_length)
            .map_err(|_| ApiError::bad_request("invalid_file_part", "File part is too large."))?;
        let request = self
            .client
            .upload_part()
            .bucket(&self.config.bucket)
            .key(key)
            .upload_id(upload_id)
            .part_number(part_number)
            .content_length(content_length)
            .presigned(self.presigning_config()?)
            .await
            .map_err(|error| r2_unavailable("presign multipart part", &error))?;
        Ok(self.prepared_request(request))
    }

    async fn complete_multipart(
        &self,
        key: &str,
        upload_id: &str,
        parts: &[UploadedPart],
    ) -> ApiResult<()> {
        validate_object_key(key)?;
        if parts.is_empty()
            || parts.len() > 10_000
            || parts
                .iter()
                .enumerate()
                .any(|(index, part)| part.part_number != index as i32 + 1 || part.etag.is_empty())
        {
            return Err(ApiError::bad_request(
                "invalid_file_parts",
                "Multipart completion requires every part in canonical order.",
            ));
        }
        let completed = parts
            .iter()
            .map(|part| {
                CompletedPart::builder()
                    .part_number(part.part_number)
                    .e_tag(&part.etag)
                    .build()
            })
            .collect::<Vec<_>>();
        self.client
            .complete_multipart_upload()
            .bucket(&self.config.bucket)
            .key(key)
            .upload_id(upload_id)
            .multipart_upload(
                CompletedMultipartUpload::builder()
                    .set_parts(Some(completed))
                    .build(),
            )
            .send()
            .await
            .map_err(|error| r2_unavailable("complete multipart upload", &error))?;
        Ok(())
    }

    async fn list_multipart_parts(
        &self,
        key: &str,
        upload_id: &str,
    ) -> ApiResult<Vec<UploadedPart>> {
        validate_object_key(key)?;
        let mut marker = None;
        let mut uploaded = Vec::new();
        loop {
            let page = self
                .client
                .list_parts()
                .bucket(&self.config.bucket)
                .key(key)
                .upload_id(upload_id)
                .set_part_number_marker(marker)
                .send()
                .await
                .map_err(|error| r2_unavailable("list multipart parts", &error))?;
            for part in page.parts() {
                let part_number = part
                    .part_number()
                    .ok_or_else(|| ApiError::internal("R2 returned a part without its number."))?;
                let etag = part
                    .e_tag()
                    .filter(|etag| !etag.is_empty())
                    .ok_or_else(|| ApiError::internal("R2 returned a part without its ETag."))?;
                uploaded.push(UploadedPart {
                    part_number,
                    etag: etag.to_string(),
                });
            }
            if !page.is_truncated().unwrap_or(false) {
                break;
            }
            marker = page.next_part_number_marker().map(str::to_string);
            if marker.is_none() {
                return Err(ApiError::internal(
                    "R2 multipart pagination omitted its continuation marker.",
                ));
            }
        }
        Ok(uploaded)
    }

    async fn abort_multipart(&self, key: &str, upload_id: &str) -> ApiResult<()> {
        validate_object_key(key)?;
        self.client
            .abort_multipart_upload()
            .bucket(&self.config.bucket)
            .key(key)
            .upload_id(upload_id)
            .send()
            .await
            .map_err(|error| r2_unavailable("abort multipart upload", &error))?;
        Ok(())
    }

    async fn object_exists(&self, key: &str) -> ApiResult<bool> {
        validate_object_key(key)?;
        match self
            .client
            .head_object()
            .bucket(&self.config.bucket)
            .key(key)
            .send()
            .await
        {
            Ok(_) => Ok(true),
            Err(error)
                if error
                    .as_service_error()
                    .is_some_and(|error| error.is_not_found()) =>
            {
                Ok(false)
            }
            Err(error) => Err(r2_unavailable("inspect object", &error)),
        }
    }

    async fn copy(&self, source_key: &str, destination_key: &str) -> ApiResult<()> {
        validate_object_key(source_key)?;
        validate_object_key(destination_key)?;
        let copy_source = format!("{}/{source_key}", self.config.bucket);
        self.client
            .copy_object()
            .bucket(&self.config.bucket)
            .key(destination_key)
            .copy_source(copy_source)
            .send()
            .await
            .map_err(|error| r2_unavailable("copy verified object", &error))?;
        Ok(())
    }

    async fn verify_object(&self, key: &str, size: u64, content_digest: &str) -> ApiResult<()> {
        validate_object_key(key)?;
        let expected_digest = parse_sha256_digest(content_digest)?;
        let response = self
            .client
            .get_object()
            .bucket(&self.config.bucket)
            .key(key)
            .send()
            .await
            .map_err(|error| r2_unavailable("verify object", &error))?;
        let mut body = response.body;
        let mut actual_size = 0_u64;
        let mut hasher = Sha256::new();
        while let Some(bytes) = body
            .try_next()
            .await
            .map_err(|error| r2_unavailable("verify object body", &error))?
        {
            actual_size = actual_size
                .checked_add(bytes.len() as u64)
                .ok_or_else(|| ApiError::internal("R2 object size overflowed."))?;
            if actual_size > size {
                return Err(object_verification_failed());
            }
            hasher.update(&bytes);
        }
        let actual_digest: [u8; 32] = hasher.finalize().into();
        if actual_size != size || actual_digest != expected_digest {
            return Err(object_verification_failed());
        }
        Ok(())
    }

    async fn read_range(&self, key: &str, offset: u64, length: u64) -> ApiResult<BlobByteStream> {
        validate_object_key(key)?;
        if length == 0 {
            return Ok(Box::pin(futures_util::stream::empty()));
        }
        if length > self.config.download_part_bytes {
            return Err(ApiError::bad_request(
                "invalid_file_range",
                "File range exceeds the provider delivery part size.",
            ));
        }
        let end = range_end(offset, length)?;
        let response = self
            .client
            .get_object()
            .bucket(&self.config.bucket)
            .key(key)
            .range(format!("bytes={offset}-{end}"))
            .send()
            .await
            .map_err(|error| r2_unavailable("read object range", &error))?;
        Ok(Box::pin(stream::unfold(response.body, |mut body| async {
            body.next().await.map(|result| {
                (
                    result.map_err(|error| Box::new(error) as BlobStreamError),
                    body,
                )
            })
        })))
    }

    async fn delete(&self, key: &str) -> ApiResult<()> {
        validate_object_key(key)?;
        self.client
            .delete_object()
            .bucket(&self.config.bucket)
            .key(key)
            .send()
            .await
            .map_err(|error| r2_unavailable("delete object", &error))?;
        Ok(())
    }
}

impl R2BlobStore {
    fn presigning_config(&self) -> ApiResult<PresigningConfig> {
        PresigningConfig::expires_in(self.config.presign_ttl).map_err(|_| invalid_r2_config())
    }

    fn prepared_request(&self, request: aws_sdk_s3::presigning::PresignedRequest) -> PresignedPart {
        PresignedPart {
            method: request.method().to_string(),
            url: request.uri().to_string(),
            headers: request
                .headers()
                .map(|(name, value)| (name.to_string(), value.to_string()))
                .collect(),
            expires_at: chrono::Utc::now()
                + chrono::Duration::from_std(self.config.presign_ttl)
                    .expect("validated presign TTL fits chrono duration"),
        }
    }
}

fn range_end(offset: u64, length: u64) -> ApiResult<u64> {
    if length == 0 {
        return Err(ApiError::bad_request(
            "invalid_file_range",
            "File ranges cannot be empty.",
        ));
    }
    offset
        .checked_add(length - 1)
        .ok_or_else(|| ApiError::bad_request("invalid_file_range", "File range overflowed."))
}

pub(crate) fn parse_sha256_digest(value: &str) -> ApiResult<[u8; 32]> {
    let encoded = value.strip_prefix("sha256:").ok_or_else(|| {
        ApiError::bad_request(
            "invalid_content_digest",
            "Expected a SHA-256 content digest.",
        )
    })?;
    if encoded.len() != 64 || !encoded.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(ApiError::bad_request(
            "invalid_content_digest",
            "Expected a SHA-256 content digest.",
        ));
    }
    let mut digest = [0_u8; 32];
    for (index, pair) in encoded.as_bytes().chunks_exact(2).enumerate() {
        digest[index] = (hex_nibble(pair[0]) << 4) | hex_nibble(pair[1]);
    }
    Ok(digest)
}

fn hex_nibble(byte: u8) -> u8 {
    match byte {
        b'0'..=b'9' => byte - b'0',
        b'a'..=b'f' => byte - b'a' + 10,
        b'A'..=b'F' => byte - b'A' + 10,
        _ => unreachable!("digest characters were validated"),
    }
}

fn object_verification_failed() -> ApiError {
    ApiError::bad_request(
        "file_content_mismatch",
        "The uploaded object does not match its declared size and SHA-256 digest.",
    )
}

fn validate_object_key(key: &str) -> ApiResult<()> {
    if key.is_empty()
        || key.len() > 1024
        || !key.starts_with(PROVIDER_OBJECT_PREFIX)
        || key.starts_with('/')
        || key.contains("..")
        || key.chars().any(char::is_whitespace)
    {
        return Err(ApiError::bad_request(
            "invalid_blob_key",
            "The provider object key is invalid.",
        ));
    }
    Ok(())
}

fn invalid_r2_config() -> ApiError {
    ApiError::internal("Hosted R2 storage configuration is invalid.")
}

fn r2_unavailable(operation: &str, error: &impl std::fmt::Display) -> ApiError {
    tracing::error!(operation, error = %error, "hosted R2 operation failed");
    ApiError::new(
        axum::http::StatusCode::SERVICE_UNAVAILABLE,
        "blob_storage_unavailable",
        "Hosted file storage is temporarily unavailable.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[test]
    fn r2_configuration_is_strict_and_does_not_accept_undersized_parts() {
        let valid = R2Config::new(
            "https://account.r2.cloudflarestorage.com",
            "private-bucket",
            "access",
            "secret",
            8 * 1024 * 1024,
            8 * 1024 * 1024,
            Duration::from_secs(900),
        )
        .unwrap()
        .with_session_token(Some("temporary-session".to_string()))
        .unwrap();
        let store = R2BlobStore::new(valid);
        assert_eq!(store.upload_part_size(), 8 * 1024 * 1024);
        assert_eq!(store.download_part_size(), 8 * 1024 * 1024);
        assert_eq!(
            store.config.session_token.as_deref(),
            Some("temporary-session")
        );

        for invalid in [
            R2Config::new(
                "http://account.r2.cloudflarestorage.com",
                "bucket",
                "access",
                "secret",
                8 * 1024 * 1024,
                8 * 1024 * 1024,
                Duration::from_secs(900),
            ),
            R2Config::new(
                "https://account.r2.cloudflarestorage.com/path",
                "bucket",
                "access",
                "secret",
                8 * 1024 * 1024,
                8 * 1024 * 1024,
                Duration::from_secs(900),
            ),
            R2Config::new(
                "https://account.r2.cloudflarestorage.com",
                "bucket",
                "access",
                "secret",
                4 * 1024 * 1024,
                8 * 1024 * 1024,
                Duration::from_secs(900),
            ),
            R2Config::new(
                "https://account.r2.cloudflarestorage.com",
                "bucket",
                "access",
                "secret",
                8 * 1024 * 1024,
                33 * 1024 * 1024,
                Duration::from_secs(900),
            ),
        ] {
            assert!(invalid.is_err());
        }
        assert!(R2Config::new_insecure_loopback(
            "http://127.0.0.1:9000",
            "bucket",
            "access",
            "secret",
            8 * 1024 * 1024,
            8 * 1024 * 1024,
            Duration::from_secs(900),
        )
        .is_ok());
        assert!(R2Config::new_insecure_loopback(
            "http://storage.example:9000",
            "bucket",
            "access",
            "secret",
            8 * 1024 * 1024,
            8 * 1024 * 1024,
            Duration::from_secs(900),
        )
        .is_err());
        assert!(R2Config::new(
            "https://account.r2.cloudflarestorage.com",
            "bucket",
            "access",
            "secret",
            8 * 1024 * 1024,
            8 * 1024 * 1024,
            Duration::from_secs(900),
        )
        .unwrap()
        .with_session_token(Some("   ".to_string()))
        .is_err());
    }

    #[tokio::test]
    async fn temporary_session_token_is_bound_to_presigned_requests() {
        let config = R2Config::new(
            "https://account.r2.cloudflarestorage.com",
            "private-bucket",
            "temporary-access",
            "temporary-secret",
            8 * 1024 * 1024,
            8 * 1024 * 1024,
            Duration::from_secs(900),
        )
        .unwrap()
        .with_session_token(Some("temporary-session".to_string()))
        .unwrap();
        let store = R2BlobStore::new(config);
        let request = store
            .presign_put(
                "v1/staging/01922222-2222-7222-8222-222222222222/01933333-3333-7333-8333-333333333333",
                5,
            )
            .await
            .unwrap();
        let url = Url::parse(&request.url).unwrap();
        assert!(url.query_pairs().any(|(name, value)| {
            name.eq_ignore_ascii_case("X-Amz-Security-Token") && value == "temporary-session"
        }));
        let debug = format!("{:?}", store.config);
        assert!(debug.contains("[redacted]"));
        assert!(!debug.contains("temporary-access"));
        assert!(!debug.contains("temporary-secret"));
        assert!(!debug.contains("temporary-session"));
    }

    #[tokio::test]
    async fn readiness_lists_only_the_provider_namespace_for_scoped_credentials() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            loop {
                let mut buffer = [0_u8; 1024];
                let read = socket.read(&mut buffer).await.unwrap();
                assert_ne!(read, 0, "readiness request ended before its headers");
                request.extend_from_slice(&buffer[..read]);
                if request.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            let body = concat!(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
                "<ListBucketResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\">",
                "<Name>private-bucket</Name><Prefix>v1/</Prefix><KeyCount>0</KeyCount>",
                "<MaxKeys>1</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>"
            );
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/xml\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            socket.write_all(response.as_bytes()).await.unwrap();
            String::from_utf8(request).unwrap()
        });

        let config = R2Config::new_insecure_loopback(
            format!("http://{address}"),
            "private-bucket",
            "temporary-access",
            "temporary-secret",
            8 * 1024 * 1024,
            8 * 1024 * 1024,
            Duration::from_secs(900),
        )
        .unwrap()
        .with_session_token(Some("temporary-session".to_string()))
        .unwrap();
        R2BlobStore::new(config).ready().await.unwrap();

        let request = server.await.unwrap();
        let request_line = request.lines().next().unwrap();
        assert!(
            request_line.starts_with("GET /private-bucket/?"),
            "unexpected readiness request: {request_line}"
        );
        assert!(request_line.contains("list-type=2"));
        assert!(request_line.contains("max-keys=1"));
        assert!(request_line.contains("prefix=v1%2F"));
        assert!(request.lines().any(|line| {
            let Some((name, value)) = line.split_once(':') else {
                return false;
            };
            name.eq_ignore_ascii_case("x-amz-security-token") && value.trim() == "temporary-session"
        }));
    }

    #[test]
    fn opaque_object_keys_cannot_escape_the_provider_prefix() {
        for invalid in [
            "",
            "/absolute",
            "outside/provider",
            "v1/../secret",
            "v1/white space",
        ] {
            assert!(validate_object_key(invalid).is_err());
        }
        assert!(validate_object_key(
            "v1/staging/01922222-2222-7222-8222-222222222222/01933333-3333-7333-8333-333333333333"
        )
        .is_ok());
    }

    #[test]
    fn sha256_digests_are_strict_but_case_insensitive() {
        assert_eq!(
            parse_sha256_digest(&format!("sha256:{}", "aB".repeat(32))).unwrap(),
            [0xab; 32]
        );
        for invalid in ["", "sha256:00", &format!("blake3:{}", "0".repeat(64))] {
            assert!(parse_sha256_digest(invalid).is_err());
        }
    }
}
