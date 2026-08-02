use rand_core::{OsRng, RngCore};
use serde::{de::DeserializeOwned, Serialize};
use subtle::ConstantTimeEq;

use crate::{
    error::{ApiError, ApiResult},
    key_wrapping::{
        KeyWrapContext, KeyWrapError, KeyWrapErrorKind, KeyWrappingRuntime, LegacyKeyWrapper,
    },
    symmetric_crypto::{decrypt, encrypt},
};

const KEY_BYTES: usize = 32;
const KEY_CHECK_PLAINTEXT: &[u8] = b"mdbase-connect-hosted-provider-key-check-v1";

#[derive(Clone)]
pub struct ProviderCrypto {
    key_wrapping: KeyWrappingRuntime,
    environment: String,
}

impl ProviderCrypto {
    pub fn from_base64(value: &str) -> ApiResult<Self> {
        let legacy = LegacyKeyWrapper::from_base64(value).map_err(|_| invalid_master_key())?;
        Ok(Self {
            key_wrapping: KeyWrappingRuntime::legacy(legacy),
            environment: "local".to_string(),
        })
    }

    pub fn with_key_wrapping(
        key_wrapping: KeyWrappingRuntime,
        environment: impl Into<String>,
    ) -> ApiResult<Self> {
        let environment = environment.into();
        KeyWrapContext::provider_key_check(environment.clone()).map_err(key_wrap_error)?;
        Ok(Self {
            key_wrapping,
            environment,
        })
    }

    pub fn generate_data_key(&self) -> [u8; KEY_BYTES] {
        let mut key = [0_u8; KEY_BYTES];
        OsRng.fill_bytes(&mut key);
        key
    }

    pub async fn create_key_check(&self) -> ApiResult<Vec<u8>> {
        self.key_wrapping
            .wrap_bytes(KEY_CHECK_PLAINTEXT, &self.key_check_context()?)
            .await
            .map_err(key_wrap_error)
    }

    pub async fn verify_key_check(&self, value: &[u8]) -> ApiResult<()> {
        let plaintext = self
            .key_wrapping
            .unwrap_bytes(value, &self.key_check_context()?)
            .await
            .map_err(key_wrap_error)?;
        if bool::from(plaintext.ct_eq(KEY_CHECK_PLAINTEXT)) {
            Ok(())
        } else {
            Err(ApiError::internal(
                "The hosted provider master key does not match this database.",
            ))
        }
    }

    pub async fn wrap_data_key(
        &self,
        data_key: &[u8; KEY_BYTES],
        collection_id: uuid::Uuid,
    ) -> ApiResult<Vec<u8>> {
        self.key_wrapping
            .wrap_data_key(data_key, &self.collection_context(collection_id)?)
            .await
            .map_err(key_wrap_error)
    }

    pub async fn unwrap_data_key(
        &self,
        wrapped: &[u8],
        collection_id: uuid::Uuid,
    ) -> ApiResult<zeroize::Zeroizing<[u8; KEY_BYTES]>> {
        self.key_wrapping
            .unwrap_data_key(wrapped, &self.collection_context(collection_id)?)
            .await
            .map_err(key_wrap_error)
    }

    pub fn encrypt_json<T: Serialize>(
        &self,
        data_key: &[u8; KEY_BYTES],
        value: &T,
        aad: &[u8],
    ) -> ApiResult<Vec<u8>> {
        let plaintext = serde_json::to_vec(value).map_err(|error| {
            ApiError::internal(format!(
                "Hosted encrypted value could not serialize: {error}"
            ))
        })?;
        encrypt(data_key, &plaintext, aad)
    }

    pub fn decrypt_json<T: DeserializeOwned>(
        &self,
        data_key: &[u8; KEY_BYTES],
        value: &[u8],
        aad: &[u8],
    ) -> ApiResult<T> {
        let plaintext = decrypt(data_key, value, aad)?;
        serde_json::from_slice(&plaintext).map_err(|error| {
            ApiError::internal(format!("Hosted encrypted value is invalid: {error}"))
        })
    }

    pub fn encrypt_bytes(
        &self,
        data_key: &[u8; KEY_BYTES],
        value: &[u8],
        aad: &[u8],
    ) -> ApiResult<Vec<u8>> {
        encrypt(data_key, value, aad)
    }

    pub fn decrypt_bytes(
        &self,
        data_key: &[u8; KEY_BYTES],
        value: &[u8],
        aad: &[u8],
    ) -> ApiResult<Vec<u8>> {
        decrypt(data_key, value, aad)
    }

    pub fn active_key_ref(&self) -> &str {
        self.key_wrapping.active_key_ref()
    }

    fn collection_context(&self, collection_id: uuid::Uuid) -> ApiResult<KeyWrapContext> {
        KeyWrapContext::collection(self.environment.clone(), collection_id).map_err(key_wrap_error)
    }

    fn key_check_context(&self) -> ApiResult<KeyWrapContext> {
        KeyWrapContext::provider_key_check(self.environment.clone()).map_err(key_wrap_error)
    }
}

fn key_wrap_error(error: KeyWrapError) -> ApiError {
    tracing::error!(kind = ?error.kind, "hosted provider key-wrapping operation failed");
    match error.kind {
        KeyWrapErrorKind::Throttled | KeyWrapErrorKind::Timeout | KeyWrapErrorKind::Unavailable => {
            ApiError::new(
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                "managed_key_service_unavailable",
                "The hosted provider key service is temporarily unavailable.",
            )
        }
        KeyWrapErrorKind::AccessDenied
        | KeyWrapErrorKind::Configuration
        | KeyWrapErrorKind::Disabled
        | KeyWrapErrorKind::WrongKey => ApiError::new(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "key_wrapping_unavailable",
            "The hosted provider cannot access its configured key hierarchy.",
        ),
        KeyWrapErrorKind::InvalidCiphertext
        | KeyWrapErrorKind::InvalidEnvelope
        | KeyWrapErrorKind::InvalidResponse
        | KeyWrapErrorKind::UnsupportedEnvelope => {
            ApiError::internal("The hosted provider stored key material is invalid or unsupported.")
        }
    }
}

fn invalid_master_key() -> ApiError {
    ApiError::bad_request(
        "invalid_master_key",
        "The hosted provider master key must be a base64-encoded 32-byte value.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn crypto() -> ProviderCrypto {
        ProviderCrypto::from_base64("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").unwrap()
    }

    #[tokio::test]
    async fn wraps_keys_and_authenticates_payload_identity() {
        let crypto = crypto();
        let data_key = crypto.generate_data_key();
        let collection_id = uuid::Uuid::new_v4();
        let wrapped = crypto
            .wrap_data_key(&data_key, collection_id)
            .await
            .unwrap();
        assert_ne!(&wrapped[13..45], data_key.as_slice());
        let unwrapped = crypto
            .unwrap_data_key(&wrapped, collection_id)
            .await
            .unwrap();
        assert_eq!(unwrapped.as_ref(), &data_key);
        assert!(crypto
            .unwrap_data_key(&wrapped, uuid::Uuid::new_v4())
            .await
            .is_err());
    }

    #[test]
    fn rejects_tampering_and_wrong_associated_data() {
        let crypto = crypto();
        let key = crypto.generate_data_key();
        let mut encrypted = crypto
            .encrypt_json(
                &key,
                &serde_json::json!({"secret": "markdown"}),
                b"record:one",
            )
            .unwrap();
        encrypted[20] ^= 1;
        assert!(crypto
            .decrypt_json::<serde_json::Value>(&key, &encrypted, b"record:one")
            .is_err());
        let encrypted = crypto
            .encrypt_bytes(&key, b"markdown", b"record:one")
            .unwrap();
        assert!(crypto
            .decrypt_bytes(&key, &encrypted, b"record:two")
            .is_err());
    }
}
