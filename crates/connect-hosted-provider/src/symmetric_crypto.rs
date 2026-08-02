use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use rand_core::{OsRng, RngCore};

use crate::error::{ApiError, ApiResult};

const ENVELOPE_VERSION: u8 = 1;
const NONCE_BYTES: usize = 12;

pub(crate) fn encrypt(key: &[u8; 32], plaintext: &[u8], aad: &[u8]) -> ApiResult<Vec<u8>> {
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

pub(crate) fn decrypt(key: &[u8; 32], envelope: &[u8], aad: &[u8]) -> ApiResult<Vec<u8>> {
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
