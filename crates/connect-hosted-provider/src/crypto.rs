use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose, Engine as _};
use rand_core::{OsRng, RngCore};
use serde::{de::DeserializeOwned, Serialize};
use subtle::ConstantTimeEq;

use crate::error::{ApiError, ApiResult};

const ENVELOPE_VERSION: u8 = 1;
const KEY_BYTES: usize = 32;
const NONCE_BYTES: usize = 12;
const KEY_CHECK_PLAINTEXT: &[u8] = b"mdbase-connect-hosted-provider-key-check-v1";
const KEY_CHECK_AAD: &[u8] = b"provider-key-check-v1";

#[derive(Clone)]
pub struct ProviderCrypto {
    master_key: [u8; KEY_BYTES],
}

impl ProviderCrypto {
    pub fn from_base64(value: &str) -> ApiResult<Self> {
        let decoded = general_purpose::URL_SAFE_NO_PAD
            .decode(value)
            .or_else(|_| general_purpose::STANDARD.decode(value))
            .map_err(|_| invalid_master_key())?;
        let master_key: [u8; KEY_BYTES] = decoded.try_into().map_err(|_| invalid_master_key())?;
        Ok(Self { master_key })
    }

    pub fn generate_data_key(&self) -> [u8; KEY_BYTES] {
        let mut key = [0_u8; KEY_BYTES];
        OsRng.fill_bytes(&mut key);
        key
    }

    pub fn create_key_check(&self) -> ApiResult<Vec<u8>> {
        encrypt(&self.master_key, KEY_CHECK_PLAINTEXT, KEY_CHECK_AAD)
    }

    pub fn verify_key_check(&self, value: &[u8]) -> ApiResult<()> {
        let plaintext = decrypt(&self.master_key, value, KEY_CHECK_AAD)?;
        if bool::from(plaintext.ct_eq(KEY_CHECK_PLAINTEXT)) {
            Ok(())
        } else {
            Err(ApiError::internal(
                "The hosted provider master key does not match this database.",
            ))
        }
    }

    pub fn wrap_data_key(&self, data_key: &[u8; KEY_BYTES], aad: &[u8]) -> ApiResult<Vec<u8>> {
        encrypt(&self.master_key, data_key, aad)
    }

    pub fn unwrap_data_key(&self, wrapped: &[u8], aad: &[u8]) -> ApiResult<[u8; KEY_BYTES]> {
        decrypt(&self.master_key, wrapped, aad)?
            .try_into()
            .map_err(|_| ApiError::internal("The hosted collection data key is invalid."))
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
}

fn encrypt(key: &[u8; KEY_BYTES], plaintext: &[u8], aad: &[u8]) -> ApiResult<Vec<u8>> {
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|_| ApiError::internal("The hosted encryption key is invalid."))?;
    let mut nonce = [0_u8; NONCE_BYTES];
    OsRng.fill_bytes(&mut nonce);
    let nonce = Nonce::from(nonce);
    let ciphertext = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| ApiError::internal("The hosted value could not be encrypted."))?;
    let mut envelope = Vec::with_capacity(1 + NONCE_BYTES + ciphertext.len());
    envelope.push(ENVELOPE_VERSION);
    envelope.extend_from_slice(&nonce);
    envelope.extend_from_slice(&ciphertext);
    Ok(envelope)
}

fn decrypt(key: &[u8; KEY_BYTES], envelope: &[u8], aad: &[u8]) -> ApiResult<Vec<u8>> {
    if envelope.len() <= 1 + NONCE_BYTES || envelope[0] != ENVELOPE_VERSION {
        return Err(ApiError::internal(
            "The hosted ciphertext envelope is invalid.",
        ));
    }
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|_| ApiError::internal("The hosted encryption key is invalid."))?;
    let nonce_bytes: [u8; NONCE_BYTES] = envelope[1..1 + NONCE_BYTES]
        .try_into()
        .map_err(|_| ApiError::internal("The hosted ciphertext envelope is invalid."))?;
    let nonce = Nonce::from(nonce_bytes);
    cipher
        .decrypt(
            &nonce,
            Payload {
                msg: &envelope[1 + NONCE_BYTES..],
                aad,
            },
        )
        .map_err(|_| ApiError::internal("The hosted ciphertext failed authentication."))
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

    #[test]
    fn wraps_keys_and_authenticates_payload_identity() {
        let crypto = crypto();
        let data_key = crypto.generate_data_key();
        let wrapped = crypto.wrap_data_key(&data_key, b"collection:one").unwrap();
        assert_ne!(&wrapped[13..45], data_key.as_slice());
        let unwrapped = crypto.unwrap_data_key(&wrapped, b"collection:one").unwrap();
        assert_eq!(unwrapped, data_key);
        assert!(crypto
            .unwrap_data_key(&wrapped, b"collection:other")
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
