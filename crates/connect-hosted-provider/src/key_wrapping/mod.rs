mod aws;
mod cache;
mod envelope;

use std::{collections::BTreeMap, sync::Arc, time::Duration};

use async_trait::async_trait;
use base64::{engine::general_purpose, Engine as _};
use serde::Serialize;
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

use crate::symmetric_crypto::{decrypt, encrypt};
use cache::{DataKeyCache, DataKeyCacheKey};

pub use aws::AwsKmsKeyWrapper;

const KEY_BYTES: usize = 32;
const KEY_CHECK_AAD: &[u8] = b"provider-key-check-v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyWrapErrorKind {
    AccessDenied,
    Configuration,
    Disabled,
    InvalidCiphertext,
    InvalidEnvelope,
    InvalidResponse,
    Throttled,
    Timeout,
    Unavailable,
    UnsupportedEnvelope,
    WrongKey,
}

#[derive(Debug, Error)]
#[error("{message}")]
pub struct KeyWrapError {
    pub kind: KeyWrapErrorKind,
    message: &'static str,
}

impl KeyWrapError {
    pub(crate) fn new(kind: KeyWrapErrorKind, message: &'static str) -> Self {
        Self { kind, message }
    }

    fn configuration(message: &'static str) -> Self {
        Self::new(KeyWrapErrorKind::Configuration, message)
    }

    fn invalid_envelope() -> Self {
        Self::new(
            KeyWrapErrorKind::InvalidEnvelope,
            "The hosted key-wrapping envelope is invalid.",
        )
    }

    fn unsupported_envelope() -> Self {
        Self::new(
            KeyWrapErrorKind::UnsupportedEnvelope,
            "The hosted key-wrapping envelope version or scheme is unsupported.",
        )
    }

    fn invalid_response() -> Self {
        Self::new(
            KeyWrapErrorKind::InvalidResponse,
            "The managed key service returned an invalid response.",
        )
    }

    fn timeout() -> Self {
        Self::new(
            KeyWrapErrorKind::Timeout,
            "The managed key service operation timed out.",
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyWrapInspection {
    LocalAes256GcmV1,
    AwsKmsV1 { key_ref: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyWrappingBackend {
    Local,
    AwsKms,
}

pub struct KeyWrappingConfig {
    pub backend: KeyWrappingBackend,
    pub environment: String,
    pub legacy_master_key: Option<String>,
    pub kms_key_id: Option<String>,
    pub kms_region: Option<String>,
    pub kms_max_attempts: u32,
    pub kms_timeout: Duration,
    pub cache_entries: usize,
    pub cache_ttl: Duration,
}

impl KeyWrappingConfig {
    pub async fn build(self) -> Result<KeyWrappingRuntime, KeyWrapError> {
        let legacy_master_key = self.legacy_master_key.map(Zeroizing::new);
        let legacy = legacy_master_key
            .as_deref()
            .map(|value| LegacyKeyWrapper::from_base64(value.as_str()))
            .transpose()?;
        let runtime = match self.backend {
            KeyWrappingBackend::Local => KeyWrappingRuntime::legacy(legacy.ok_or_else(|| {
                KeyWrapError::configuration(
                    "The legacy provider key is required for local key wrapping.",
                )
            })?),
            KeyWrappingBackend::AwsKms => {
                if !matches!(self.environment.as_str(), "staging" | "production") {
                    return Err(KeyWrapError::configuration(
                        "The AWS KMS environment must be staging or production.",
                    ));
                }
                let key_id = required_setting(self.kms_key_id, "AWS KMS key ID")?;
                let region = required_setting(self.kms_region, "AWS KMS region")?;
                let kms = AwsKmsKeyWrapper::from_default_chain(
                    region,
                    key_id,
                    self.environment,
                    self.kms_max_attempts,
                    self.kms_timeout,
                )
                .await?;
                KeyWrappingRuntime::aws_kms(kms, legacy)
            }
        };
        runtime.with_data_key_cache(self.cache_entries, self.cache_ttl)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum KeyWrapPurpose {
    CollectionDataKey,
    ProviderKeyCheck,
}

#[derive(Debug, Clone)]
pub struct KeyWrapContext {
    environment: String,
    purpose: KeyWrapPurpose,
    collection_id: Option<Uuid>,
    legacy_aad: Vec<u8>,
}

impl KeyWrapContext {
    pub fn collection(
        environment: impl Into<String>,
        collection_id: Uuid,
    ) -> Result<Self, KeyWrapError> {
        let environment = validate_environment(environment.into())?;
        Ok(Self {
            environment,
            purpose: KeyWrapPurpose::CollectionDataKey,
            collection_id: Some(collection_id),
            legacy_aad: canonical_aad(("collection_key", collection_id))?,
        })
    }

    pub fn provider_key_check(environment: impl Into<String>) -> Result<Self, KeyWrapError> {
        Ok(Self {
            environment: validate_environment(environment.into())?,
            purpose: KeyWrapPurpose::ProviderKeyCheck,
            collection_id: None,
            legacy_aad: KEY_CHECK_AAD.to_vec(),
        })
    }

    pub fn environment(&self) -> &str {
        &self.environment
    }

    fn encryption_context(&self) -> BTreeMap<String, String> {
        let mut context = BTreeMap::from([
            ("mdbase:service".to_string(), "hosted-provider".to_string()),
            ("mdbase:environment".to_string(), self.environment.clone()),
            (
                "mdbase:purpose".to_string(),
                match self.purpose {
                    KeyWrapPurpose::CollectionDataKey => "collection-data-key",
                    KeyWrapPurpose::ProviderKeyCheck => "provider-key-check",
                }
                .to_string(),
            ),
            ("mdbase:envelope-version".to_string(), "1".to_string()),
        ]);
        if let Some(collection_id) = self.collection_id {
            context.insert(
                "mdbase:collection-id".to_string(),
                collection_id.to_string(),
            );
        }
        context
    }
}

#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct LegacyKeyWrapper {
    key: [u8; KEY_BYTES],
}

impl LegacyKeyWrapper {
    pub fn from_base64(value: &str) -> Result<Self, KeyWrapError> {
        let decoded = general_purpose::URL_SAFE_NO_PAD
            .decode(value)
            .or_else(|_| general_purpose::STANDARD.decode(value))
            .map_err(|_| KeyWrapError::configuration("The legacy provider key is invalid."))?;
        let key = decoded
            .try_into()
            .map_err(|_| KeyWrapError::configuration("The legacy provider key is invalid."))?;
        Ok(Self { key })
    }

    fn wrap(&self, plaintext: &[u8], context: &KeyWrapContext) -> Result<Vec<u8>, KeyWrapError> {
        encrypt(&self.key, plaintext, &context.legacy_aad).map_err(|_| {
            KeyWrapError::new(
                KeyWrapErrorKind::Unavailable,
                "The legacy provider key could not wrap key material.",
            )
        })
    }

    fn unwrap(
        &self,
        ciphertext: &[u8],
        context: &KeyWrapContext,
    ) -> Result<Zeroizing<Vec<u8>>, KeyWrapError> {
        decrypt(&self.key, ciphertext, &context.legacy_aad)
            .map(Zeroizing::new)
            .map_err(|_| {
                KeyWrapError::new(
                    KeyWrapErrorKind::InvalidCiphertext,
                    "The legacy wrapped key failed authentication.",
                )
            })
    }
}

pub(crate) struct ManagedCiphertext {
    key_ref: String,
    ciphertext: Vec<u8>,
}

#[async_trait]
pub(crate) trait ManagedKeyService: Send + Sync {
    fn active_key_ref(&self) -> &str;

    async fn encrypt(
        &self,
        plaintext: &[u8],
        context: &KeyWrapContext,
    ) -> Result<ManagedCiphertext, KeyWrapError>;

    async fn decrypt(
        &self,
        key_ref: &str,
        ciphertext: &[u8],
        context: &KeyWrapContext,
    ) -> Result<Zeroizing<Vec<u8>>, KeyWrapError>;
}

#[derive(Clone)]
enum ActiveKeyWriter {
    Legacy(LegacyKeyWrapper),
    Managed(Arc<dyn ManagedKeyService>),
}

#[derive(Clone)]
pub struct KeyWrappingRuntime {
    active: ActiveKeyWriter,
    legacy_reader: Option<LegacyKeyWrapper>,
    managed_reader: Option<Arc<dyn ManagedKeyService>>,
    data_key_cache: DataKeyCache,
}

impl KeyWrappingRuntime {
    pub fn legacy(wrapper: LegacyKeyWrapper) -> Self {
        Self {
            active: ActiveKeyWriter::Legacy(wrapper.clone()),
            legacy_reader: Some(wrapper),
            managed_reader: None,
            data_key_cache: DataKeyCache::new(0, Duration::ZERO),
        }
    }

    pub fn aws_kms(wrapper: AwsKmsKeyWrapper, legacy_reader: Option<LegacyKeyWrapper>) -> Self {
        let managed: Arc<dyn ManagedKeyService> = Arc::new(wrapper);
        Self {
            active: ActiveKeyWriter::Managed(managed.clone()),
            legacy_reader,
            managed_reader: Some(managed),
            data_key_cache: DataKeyCache::new(1_024, Duration::from_secs(300)),
        }
    }

    #[cfg(test)]
    fn managed_for_test(
        managed: Arc<dyn ManagedKeyService>,
        legacy_reader: Option<LegacyKeyWrapper>,
    ) -> Self {
        Self {
            active: ActiveKeyWriter::Managed(managed.clone()),
            legacy_reader,
            managed_reader: Some(managed),
            data_key_cache: DataKeyCache::new(0, Duration::ZERO),
        }
    }

    pub fn with_data_key_cache(
        mut self,
        max_entries: usize,
        ttl: Duration,
    ) -> Result<Self, KeyWrapError> {
        if max_entries > 100_000 || ttl > Duration::from_secs(24 * 60 * 60) {
            return Err(KeyWrapError::configuration(
                "The hosted data-key cache configuration is invalid.",
            ));
        }
        self.data_key_cache = DataKeyCache::new(max_entries, ttl);
        Ok(self)
    }

    pub fn active_key_ref(&self) -> &str {
        match &self.active {
            ActiveKeyWriter::Legacy(_) => "local-aes-256-gcm-v1",
            ActiveKeyWriter::Managed(wrapper) => wrapper.active_key_ref(),
        }
    }

    pub fn inspect(value: &[u8]) -> Result<KeyWrapInspection, KeyWrapError> {
        envelope::inspect(value)
    }

    pub async fn wrap_data_key(
        &self,
        data_key: &[u8; KEY_BYTES],
        context: &KeyWrapContext,
    ) -> Result<Vec<u8>, KeyWrapError> {
        let wrapped = self.wrap_bytes(data_key, context).await?;
        if let Some(cache_key) = data_key_cache_key(context, &wrapped) {
            self.data_key_cache.insert(cache_key, data_key).await;
        }
        Ok(wrapped)
    }

    pub async fn unwrap_data_key(
        &self,
        wrapped: &[u8],
        context: &KeyWrapContext,
    ) -> Result<Zeroizing<[u8; KEY_BYTES]>, KeyWrapError> {
        let cache_key = self
            .data_key_cache
            .is_enabled()
            .then(|| data_key_cache_key(context, wrapped))
            .flatten();
        if let Some(cache_key) = &cache_key {
            if let Some(key) = self.data_key_cache.get(cache_key).await {
                return Ok(key);
            }
        }
        let _gate = if let Some(cache_key) = &cache_key {
            Some(self.data_key_cache.lock(cache_key).await)
        } else {
            None
        };
        if let Some(cache_key) = &cache_key {
            if let Some(key) = self.data_key_cache.get(cache_key).await {
                return Ok(key);
            }
        }
        let plaintext = self.unwrap_bytes(wrapped, context).await?;
        if plaintext.len() != KEY_BYTES {
            return Err(KeyWrapError::new(
                KeyWrapErrorKind::InvalidCiphertext,
                "The unwrapped collection data key has an invalid length.",
            ));
        }
        let mut key = [0_u8; KEY_BYTES];
        key.copy_from_slice(&plaintext);
        if let Some(cache_key) = cache_key {
            self.data_key_cache.insert(cache_key, &key).await;
        }
        Ok(Zeroizing::new(key))
    }

    pub async fn wrap_bytes(
        &self,
        plaintext: &[u8],
        context: &KeyWrapContext,
    ) -> Result<Vec<u8>, KeyWrapError> {
        match &self.active {
            ActiveKeyWriter::Legacy(wrapper) => wrapper.wrap(plaintext, context),
            ActiveKeyWriter::Managed(wrapper) => {
                let wrapped = wrapper.encrypt(plaintext, context).await?;
                envelope::encode_aws_kms(&wrapped.key_ref, &wrapped.ciphertext)
            }
        }
    }

    pub async fn unwrap_bytes(
        &self,
        wrapped: &[u8],
        context: &KeyWrapContext,
    ) -> Result<Zeroizing<Vec<u8>>, KeyWrapError> {
        match Self::inspect(wrapped)? {
            KeyWrapInspection::LocalAes256GcmV1 => self
                .legacy_reader
                .as_ref()
                .ok_or_else(|| {
                    KeyWrapError::configuration(
                        "Stored keys require the legacy provider key reader.",
                    )
                })?
                .unwrap(wrapped, context),
            KeyWrapInspection::AwsKmsV1 { .. } => {
                let envelope = envelope::parse_managed(wrapped)?;
                self.managed_reader
                    .as_ref()
                    .ok_or_else(|| {
                        KeyWrapError::configuration("Stored keys require the AWS KMS reader.")
                    })?
                    .decrypt(envelope.key_ref, envelope.ciphertext, context)
                    .await
            }
        }
    }
}

fn validate_environment(value: String) -> Result<String, KeyWrapError> {
    if value.is_empty()
        || value.len() > 32
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err(KeyWrapError::configuration(
            "The key-wrapping environment is invalid.",
        ));
    }
    Ok(value)
}

fn data_key_cache_key(context: &KeyWrapContext, wrapped: &[u8]) -> Option<DataKeyCacheKey> {
    if context.purpose != KeyWrapPurpose::CollectionDataKey {
        return None;
    }
    Some(DataKeyCacheKey::new(
        &context.environment,
        context.collection_id?,
        Sha256::digest(wrapped).into(),
    ))
}

fn canonical_aad(value: impl Serialize) -> Result<Vec<u8>, KeyWrapError> {
    serde_json::to_vec(&value).map_err(|_| {
        KeyWrapError::configuration("The legacy key-wrapping identity could not serialize.")
    })
}

fn required_setting(value: Option<String>, name: &'static str) -> Result<String, KeyWrapError> {
    value
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            KeyWrapError::configuration(match name {
                "AWS KMS key ID" => "The AWS KMS key ID is required.",
                "AWS KMS region" => "The AWS KMS region is required.",
                _ => "A managed key setting is required.",
            })
        })
}

#[cfg(test)]
mod tests;
