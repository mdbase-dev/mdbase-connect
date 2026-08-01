use crate::crypto::{RelayCryptoError, RelayIdentity};
use crate::{
    file_frame_authenticated_data, FileFrame, FileFrameError, FileFrameHeader, FileFrameKind,
    FileTransferDirection, FileTransferProtection, FILE_TRANSFER_PROTOCOL_VERSION,
    RELAY_ENCRYPTION_SUITE,
};
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use hkdf::Hkdf;
use sha2::{Digest, Sha256};
use uuid::Uuid;

pub const FILE_TRANSFER_ENCRYPTION_SUITE: &str = RELAY_ENCRYPTION_SUITE;
const FILE_KEY_INFO: &[u8] = b"mdbase-connect file chunk key v1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileTransferBinding {
    pub grant_id: Uuid,
    pub application_id: Uuid,
    pub connector_id: Uuid,
    pub authority_id: Uuid,
    pub collection_id: Uuid,
    pub scope_epoch: u64,
    pub key_id: String,
    pub transfer_id: Uuid,
    pub direction: FileTransferDirection,
}

impl FileTransferBinding {
    fn validate(&self) -> Result<(), FileCryptoError> {
        if self.scope_epoch == 0
            || self.key_id.is_empty()
            || self.key_id.len() > 200
            || self.key_id.contains('|')
        {
            return Err(FileCryptoError::InvalidBinding);
        }
        Ok(())
    }

    fn context(&self) -> String {
        format!(
            "mdbase-connect|file-transfer|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}",
            FILE_TRANSFER_PROTOCOL_VERSION,
            FILE_TRANSFER_ENCRYPTION_SUITE,
            self.grant_id,
            self.application_id,
            self.connector_id,
            self.authority_id,
            self.collection_id,
            self.scope_epoch,
            self.key_id,
            self.transfer_id,
            self.direction.as_str(),
        )
    }

    fn validate_header(&self, header: &FileFrameHeader) -> Result<(), FileCryptoError> {
        if header.protocol_version != FILE_TRANSFER_PROTOCOL_VERSION
            || header.protection != FileTransferProtection::GrantAeadV1
            || header.grant_id != self.grant_id
            || header.authority_id != self.authority_id
            || header.collection_id != self.collection_id
            || header.transfer_id != self.transfer_id
            || header.direction != self.direction
            || header.scope_epoch != self.scope_epoch
            || header.key_id.as_deref() != Some(self.key_id.as_str())
        {
            return Err(FileCryptoError::HeaderBindingMismatch);
        }
        Ok(())
    }
}

impl FileTransferDirection {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Upload => "upload",
            Self::Download => "download",
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum FileCryptoError {
    #[error("invalid file transfer encryption binding")]
    InvalidBinding,
    #[error("file frame does not match its transfer encryption binding")]
    HeaderBindingMismatch,
    #[error("file chunk plaintext length does not match its header")]
    PlaintextLengthMismatch,
    #[error("file chunk authentication failed")]
    AuthenticationFailed,
    #[error(transparent)]
    Frame(#[from] FileFrameError),
    #[error(transparent)]
    Relay(#[from] RelayCryptoError),
}

pub struct FileTransferCipher {
    binding: FileTransferBinding,
    key: [u8; 32],
}

impl FileTransferCipher {
    pub fn derive(
        identity: &RelayIdentity,
        peer_public_key: &str,
        binding: FileTransferBinding,
    ) -> Result<Self, FileCryptoError> {
        let shared_secret = identity.shared_secret(peer_public_key)?;
        Self::from_shared_secret(&shared_secret, binding)
    }

    #[doc(hidden)]
    pub fn from_shared_secret(
        shared_secret: &[u8],
        binding: FileTransferBinding,
    ) -> Result<Self, FileCryptoError> {
        binding.validate()?;
        if shared_secret.is_empty() {
            return Err(FileCryptoError::InvalidBinding);
        }
        let context = binding.context();
        let salt = Sha256::digest(context.as_bytes());
        let hkdf = Hkdf::<Sha256>::new(Some(&salt), shared_secret);
        let mut key = [0; 32];
        hkdf.expand(FILE_KEY_INFO, &mut key)
            .map_err(|_| FileCryptoError::InvalidBinding)?;
        Ok(Self { binding, key })
    }

    pub fn encrypt_chunk(
        &self,
        kind: FileFrameKind,
        header: FileFrameHeader,
        plaintext: &[u8],
    ) -> Result<FileFrame, FileCryptoError> {
        self.binding.validate_header(&header)?;
        if plaintext.len() != header.plaintext_length as usize {
            return Err(FileCryptoError::PlaintextLengthMismatch);
        }
        let authenticated_data = file_frame_authenticated_data(kind, &header)?;
        let cipher =
            Aes256Gcm::new_from_slice(&self.key).map_err(|_| FileCryptoError::InvalidBinding)?;
        let nonce_bytes = chunk_nonce(header.chunk_index);
        let payload = cipher
            .encrypt(
                &Nonce::from(nonce_bytes),
                Payload {
                    msg: plaintext,
                    aad: &authenticated_data,
                },
            )
            .map_err(|_| FileCryptoError::AuthenticationFailed)?;
        Ok(FileFrame {
            kind,
            header,
            payload,
        })
    }

    pub fn decrypt_chunk(&self, frame: &FileFrame) -> Result<Vec<u8>, FileCryptoError> {
        self.binding.validate_header(&frame.header)?;
        let authenticated_data = file_frame_authenticated_data(frame.kind, &frame.header)?;
        let cipher =
            Aes256Gcm::new_from_slice(&self.key).map_err(|_| FileCryptoError::InvalidBinding)?;
        let nonce_bytes = chunk_nonce(frame.header.chunk_index);
        cipher
            .decrypt(
                &Nonce::from(nonce_bytes),
                Payload {
                    msg: &frame.payload,
                    aad: &authenticated_data,
                },
            )
            .map_err(|_| FileCryptoError::AuthenticationFailed)
    }
}

fn chunk_nonce(chunk_index: u64) -> [u8; 12] {
    let mut nonce = [0; 12];
    nonce[4..].copy_from_slice(&chunk_index.to_be_bytes());
    nonce
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{DEFAULT_FILE_CHUNK_BYTES, FILE_TRANSFER_PROTOCOL_VERSION};
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};

    fn binding(direction: FileTransferDirection) -> FileTransferBinding {
        FileTransferBinding {
            grant_id: Uuid::from_u128(1),
            application_id: Uuid::from_u128(2),
            connector_id: Uuid::from_u128(3),
            authority_id: Uuid::from_u128(4),
            collection_id: Uuid::from_u128(5),
            scope_epoch: 7,
            key_id: "key-3".to_string(),
            transfer_id: Uuid::from_u128(6),
            direction,
        }
    }

    fn header(direction: FileTransferDirection) -> FileFrameHeader {
        let binding = binding(direction);
        FileFrameHeader {
            protocol_version: FILE_TRANSFER_PROTOCOL_VERSION,
            protection: FileTransferProtection::GrantAeadV1,
            grant_id: binding.grant_id,
            authority_id: binding.authority_id,
            collection_id: binding.collection_id,
            transfer_id: binding.transfer_id,
            direction,
            chunk_size: DEFAULT_FILE_CHUNK_BYTES,
            chunk_index: 0,
            offset: 0,
            plaintext_length: 12,
            total_size: 12,
            scope_epoch: binding.scope_epoch,
            key_id: Some(binding.key_id),
        }
    }

    #[test]
    fn transfer_keys_interoperate_and_are_direction_separated() {
        let application = RelayIdentity::generate();
        let connector = RelayIdentity::generate();
        let upload = binding(FileTransferDirection::Upload);
        let app_cipher =
            FileTransferCipher::derive(&application, &connector.public_key(), upload.clone())
                .unwrap();
        let connector_cipher =
            FileTransferCipher::derive(&connector, &application.public_key(), upload).unwrap();
        let frame = app_cipher
            .encrypt_chunk(
                FileFrameKind::UploadChunk,
                header(FileTransferDirection::Upload),
                b"hello binary",
            )
            .unwrap();
        assert_eq!(
            connector_cipher.decrypt_chunk(&frame).unwrap(),
            b"hello binary"
        );

        let download = FileTransferCipher::derive(
            &connector,
            &application.public_key(),
            binding(FileTransferDirection::Download),
        )
        .unwrap();
        assert!(download.decrypt_chunk(&frame).is_err());
    }

    #[test]
    fn every_bound_header_field_is_authenticated() {
        let cipher = FileTransferCipher::from_shared_secret(
            b"fixed shared secret for tests",
            binding(FileTransferDirection::Upload),
        )
        .unwrap();
        let frame = cipher
            .encrypt_chunk(
                FileFrameKind::UploadChunk,
                header(FileTransferDirection::Upload),
                b"hello binary",
            )
            .unwrap();

        let mut tampered = frame.clone();
        tampered.header.total_size += 1;
        assert!(matches!(
            cipher.decrypt_chunk(&tampered),
            Err(FileCryptoError::AuthenticationFailed)
        ));
        let mut tampered = frame.clone();
        tampered.payload[0] ^= 1;
        assert!(matches!(
            cipher.decrypt_chunk(&tampered),
            Err(FileCryptoError::AuthenticationFailed)
        ));
    }

    #[test]
    fn file_crypto_v1_matches_the_shared_browser_fixture() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../packages/protocol/test/fixtures/file-crypto-v1.json"
        ))
        .unwrap();
        let binding = FileTransferBinding {
            grant_id: fixture["binding"]["grantId"]
                .as_str()
                .unwrap()
                .parse()
                .unwrap(),
            application_id: fixture["binding"]["applicationId"]
                .as_str()
                .unwrap()
                .parse()
                .unwrap(),
            connector_id: fixture["binding"]["encryption"]["connector_id"]
                .as_str()
                .unwrap()
                .parse()
                .unwrap(),
            authority_id: fixture["binding"]["authorityId"]
                .as_str()
                .unwrap()
                .parse()
                .unwrap(),
            collection_id: fixture["binding"]["encryption"]["collection_id"]
                .as_str()
                .unwrap()
                .parse()
                .unwrap(),
            scope_epoch: fixture["binding"]["encryption"]["scope_epoch"]
                .as_u64()
                .unwrap(),
            key_id: fixture["binding"]["encryption"]["key_id"]
                .as_str()
                .unwrap()
                .to_string(),
            transfer_id: fixture["binding"]["transferId"]
                .as_str()
                .unwrap()
                .parse()
                .unwrap(),
            direction: FileTransferDirection::Upload,
        };
        let shared_secret = BASE64
            .decode(fixture["shared_secret_base64"].as_str().unwrap())
            .unwrap();
        let plaintext = BASE64
            .decode(fixture["plaintext_base64"].as_str().unwrap())
            .unwrap();
        let header = serde_json::from_value(fixture["header"].clone()).unwrap();
        let cipher = FileTransferCipher::from_shared_secret(&shared_secret, binding).unwrap();
        let frame = cipher
            .encrypt_chunk(FileFrameKind::UploadChunk, header, &plaintext)
            .unwrap();
        assert_eq!(
            BASE64.encode(frame.encode().unwrap()),
            fixture["frame_base64"].as_str().unwrap()
        );
        assert_eq!(cipher.decrypt_chunk(&frame).unwrap(), plaintext);
    }
}
