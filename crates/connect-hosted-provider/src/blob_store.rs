use crate::{ApiError, ApiResult};
use async_trait::async_trait;
use aws_credential_types::Credentials;
use aws_sdk_s3::config::{BehaviorVersion, Region};
use aws_sdk_s3::presigning::PresigningConfig;
use aws_sdk_s3::types::{CompletedMultipartUpload, CompletedPart};
use aws_sdk_s3::Client;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::time::Duration;
use url::Url;

const MIN_MULTIPART_PART_BYTES: u64 = 5 * 1024 * 1024;
const MAX_MULTIPART_PART_BYTES: u64 = 5 * 1024 * 1024 * 1024;
const MAX_PRESIGN_SECONDS: u64 = 7 * 24 * 60 * 60;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct R2Config {
    pub endpoint: String,
    pub bucket: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    pub multipart_part_bytes: u64,
    pub presign_ttl: Duration,
}

impl R2Config {
    pub fn new(
        endpoint: impl Into<String>,
        bucket: impl Into<String>,
        access_key_id: impl Into<String>,
        secret_access_key: impl Into<String>,
        multipart_part_bytes: u64,
        presign_ttl: Duration,
    ) -> ApiResult<Self> {
        let config = Self {
            endpoint: endpoint.into(),
            bucket: bucket.into(),
            access_key_id: access_key_id.into(),
            secret_access_key: secret_access_key.into(),
            multipart_part_bytes,
            presign_ttl,
        };
        config.validate()?;
        Ok(config)
    }

    fn validate(&self) -> ApiResult<()> {
        let endpoint = Url::parse(&self.endpoint).map_err(|_| invalid_r2_config())?;
        if endpoint.scheme() != "https"
            || endpoint.host_str().is_none()
            || endpoint.path() != "/"
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
            || self.bucket.trim().is_empty()
            || self.bucket.len() > 255
            || self.access_key_id.trim().is_empty()
            || self.secret_access_key.trim().is_empty()
            || !(MIN_MULTIPART_PART_BYTES..=MAX_MULTIPART_PART_BYTES)
                .contains(&self.multipart_part_bytes)
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
            None,
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
    fn part_size(&self) -> u64;
    async fn ready(&self) -> ApiResult<()>;
    async fn create_multipart(&self, key: &str) -> ApiResult<String>;
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
    async fn abort_multipart(&self, key: &str, upload_id: &str) -> ApiResult<()>;
    async fn verify_object(&self, key: &str, size: u64, content_digest: &str) -> ApiResult<()>;
    async fn read_range(&self, key: &str, offset: u64, length: u64) -> ApiResult<Vec<u8>>;
    async fn delete(&self, key: &str) -> ApiResult<()>;
}

#[async_trait]
impl BlobStore for R2BlobStore {
    fn part_size(&self) -> u64 {
        self.config.multipart_part_bytes
    }

    async fn ready(&self) -> ApiResult<()> {
        self.client
            .head_bucket()
            .bucket(&self.config.bucket)
            .send()
            .await
            .map_err(|error| r2_unavailable("head bucket", &error))?;
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
        let presign = PresigningConfig::expires_in(self.config.presign_ttl)
            .map_err(|_| invalid_r2_config())?;
        let request = self
            .client
            .upload_part()
            .bucket(&self.config.bucket)
            .key(key)
            .upload_id(upload_id)
            .part_number(part_number)
            .content_length(content_length)
            .presigned(presign)
            .await
            .map_err(|error| r2_unavailable("presign multipart part", &error))?;
        Ok(PresignedPart {
            method: request.method().to_string(),
            url: request.uri().to_string(),
            headers: request
                .headers()
                .map(|(name, value)| (name.to_string(), value.to_string()))
                .collect(),
        })
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

    async fn read_range(&self, key: &str, offset: u64, length: u64) -> ApiResult<Vec<u8>> {
        validate_object_key(key)?;
        if length == 0 {
            return Ok(Vec::new());
        }
        if length > self.config.multipart_part_bytes {
            return Err(ApiError::bad_request(
                "invalid_file_range",
                "File range exceeds the provider delivery part size.",
            ));
        }
        let end = offset
            .checked_add(length - 1)
            .ok_or_else(|| ApiError::bad_request("invalid_file_range", "File range overflowed."))?;
        let response = self
            .client
            .get_object()
            .bucket(&self.config.bucket)
            .key(key)
            .range(format!("bytes={offset}-{end}"))
            .send()
            .await
            .map_err(|error| r2_unavailable("read object range", &error))?;
        let bytes = response
            .body
            .collect()
            .await
            .map_err(|error| r2_unavailable("read object body", &error))?
            .into_bytes();
        if bytes.len() as u64 != length {
            return Err(ApiError::internal(
                "R2 returned an incomplete object range.",
            ));
        }
        Ok(bytes.to_vec())
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

fn parse_sha256_digest(value: &str) -> ApiResult<[u8; 32]> {
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

    #[test]
    fn r2_configuration_is_strict_and_does_not_accept_undersized_parts() {
        let valid = R2Config::new(
            "https://account.r2.cloudflarestorage.com",
            "private-bucket",
            "access",
            "secret",
            8 * 1024 * 1024,
            Duration::from_secs(900),
        )
        .unwrap();
        assert_eq!(R2BlobStore::new(valid).part_size(), 8 * 1024 * 1024);

        for invalid in [
            R2Config::new(
                "http://account.r2.cloudflarestorage.com",
                "bucket",
                "access",
                "secret",
                8 * 1024 * 1024,
                Duration::from_secs(900),
            ),
            R2Config::new(
                "https://account.r2.cloudflarestorage.com/path",
                "bucket",
                "access",
                "secret",
                8 * 1024 * 1024,
                Duration::from_secs(900),
            ),
            R2Config::new(
                "https://account.r2.cloudflarestorage.com",
                "bucket",
                "access",
                "secret",
                4 * 1024 * 1024,
                Duration::from_secs(900),
            ),
        ] {
            assert!(invalid.is_err());
        }
    }

    #[test]
    fn opaque_object_keys_cannot_escape_the_provider_prefix() {
        for invalid in ["", "/absolute", "v1/../secret", "v1/white space"] {
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
