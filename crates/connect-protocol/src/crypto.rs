use crate::{
    EncryptedRelayEnvelope, GrantEncryption, OPERATION_TRANSPORT_PROTOCOL_VERSION,
    RELAY_ENCRYPTION_SUITE, SUPPORTED_OPERATION_TRANSPORT_PROTOCOL_VERSIONS,
};
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hkdf::Hkdf;
use p256::ecdh::diffie_hellman;
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::{PublicKey, SecretKey};
use rand_core::OsRng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

const REQUEST_INFO: &[u8] = b"mdbase-connect relay request key v1";
const RESPONSE_INFO: &[u8] = b"mdbase-connect relay response key v1";

#[derive(Debug, Error)]
pub enum RelayCryptoError {
    #[error("invalid relay identity key")]
    InvalidIdentity,
    #[error("invalid relay public key")]
    InvalidPublicKey,
    #[error("invalid relay encryption binding")]
    InvalidBinding,
    #[error("invalid encrypted relay counter")]
    InvalidCounter,
    #[error("encrypted relay authentication failed")]
    AuthenticationFailed,
    #[error("encrypted relay payload is invalid JSON")]
    InvalidPayload(#[from] serde_json::Error),
}

#[derive(Clone)]
pub struct RelayIdentity {
    secret: SecretKey,
}

impl RelayIdentity {
    pub fn generate() -> Self {
        Self {
            secret: SecretKey::random(&mut OsRng),
        }
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self, RelayCryptoError> {
        let secret = SecretKey::from_slice(bytes).map_err(|_| RelayCryptoError::InvalidIdentity)?;
        Ok(Self { secret })
    }

    pub fn from_storage_value(encoded: &str) -> Result<Self, RelayCryptoError> {
        let raw = URL_SAFE_NO_PAD
            .decode(encoded.trim())
            .map_err(|_| RelayCryptoError::InvalidIdentity)?;
        Self::from_bytes(&raw)
    }

    pub fn storage_value(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.secret.to_bytes())
    }

    pub fn public_key(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.secret.public_key().to_encoded_point(false).as_bytes())
    }

    pub fn derive(
        &self,
        peer_public_key: &str,
        binding: &RelayBinding,
    ) -> Result<RelayKeys, RelayCryptoError> {
        self.derive_for_protocol(
            peer_public_key,
            binding,
            OPERATION_TRANSPORT_PROTOCOL_VERSION,
        )
    }

    pub fn derive_for_protocol(
        &self,
        peer_public_key: &str,
        binding: &RelayBinding,
        protocol_version: u32,
    ) -> Result<RelayKeys, RelayCryptoError> {
        binding.validate()?;
        if !SUPPORTED_OPERATION_TRANSPORT_PROTOCOL_VERSIONS.contains(&protocol_version) {
            return Err(RelayCryptoError::InvalidBinding);
        }
        let shared = self.shared_secret(peer_public_key)?;
        RelayKeys::derive(&shared, binding, protocol_version)
    }

    pub(crate) fn shared_secret(&self, peer_public_key: &str) -> Result<Vec<u8>, RelayCryptoError> {
        let peer_bytes = URL_SAFE_NO_PAD
            .decode(peer_public_key)
            .map_err(|_| RelayCryptoError::InvalidPublicKey)?;
        let peer = PublicKey::from_sec1_bytes(&peer_bytes)
            .map_err(|_| RelayCryptoError::InvalidPublicKey)?;
        let shared = diffie_hellman(self.secret.to_nonzero_scalar(), peer.as_affine());
        Ok(shared.raw_secret_bytes().to_vec())
    }

    #[cfg(test)]
    pub(crate) fn secret_bytes(&self) -> Vec<u8> {
        self.secret.to_bytes().to_vec()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RelayBinding {
    pub grant_id: Uuid,
    pub application_id: Uuid,
    pub connector_id: Uuid,
    pub collection_id: Uuid,
    pub scope_epoch: u64,
    pub key_id: String,
    pub suite: String,
}

impl RelayBinding {
    pub fn from_grant(grant_id: Uuid, application_id: Uuid, encryption: &GrantEncryption) -> Self {
        Self {
            grant_id,
            application_id,
            connector_id: encryption.connector_id,
            collection_id: encryption.collection_id,
            scope_epoch: encryption.scope_epoch,
            key_id: encryption.key_id.clone(),
            suite: encryption.suite.clone(),
        }
    }

    pub fn validate(&self) -> Result<(), RelayCryptoError> {
        if self.suite != RELAY_ENCRYPTION_SUITE
            || self.scope_epoch == 0
            || self.key_id.is_empty()
            || self.key_id.contains('|')
        {
            return Err(RelayCryptoError::InvalidBinding);
        }
        Ok(())
    }

    fn context(&self, protocol_version: u32) -> String {
        format!(
            "mdbase-connect|{}|{}|{}|{}|{}|{}|{}|{}",
            protocol_version,
            self.suite,
            self.grant_id,
            self.application_id,
            self.connector_id,
            self.collection_id,
            self.scope_epoch,
            self.key_id
        )
    }
}

pub struct RelayKeys {
    request: [u8; 32],
    response: [u8; 32],
    protocol_version: u32,
}

impl RelayKeys {
    fn derive(
        shared_secret: &[u8],
        binding: &RelayBinding,
        protocol_version: u32,
    ) -> Result<Self, RelayCryptoError> {
        let context = binding.context(protocol_version);
        let salt = Sha256::digest(context.as_bytes());
        let hkdf = Hkdf::<Sha256>::new(Some(&salt), shared_secret);
        let mut request = [0; 32];
        let mut response = [0; 32];
        hkdf.expand(REQUEST_INFO, &mut request)
            .map_err(|_| RelayCryptoError::InvalidBinding)?;
        hkdf.expand(RESPONSE_INFO, &mut response)
            .map_err(|_| RelayCryptoError::InvalidBinding)?;
        Ok(Self {
            request,
            response,
            protocol_version,
        })
    }

    pub fn encrypt_json<T: Serialize>(
        &self,
        direction: RelayDirection,
        metadata: RelayMetadata<'_>,
        value: &T,
    ) -> Result<String, RelayCryptoError> {
        let plaintext = serde_json::to_vec(value)?;
        self.encrypt(direction, metadata, &plaintext)
    }

    pub fn decrypt_json<T: for<'de> Deserialize<'de>>(
        &self,
        direction: RelayDirection,
        metadata: RelayMetadata<'_>,
        ciphertext: &str,
    ) -> Result<T, RelayCryptoError> {
        let plaintext = self.decrypt(direction, metadata, ciphertext)?;
        Ok(serde_json::from_slice(&plaintext)?)
    }

    pub fn decrypt_bytes(
        &self,
        direction: RelayDirection,
        metadata: RelayMetadata<'_>,
        ciphertext: &str,
    ) -> Result<Vec<u8>, RelayCryptoError> {
        self.decrypt(direction, metadata, ciphertext)
    }

    fn encrypt(
        &self,
        direction: RelayDirection,
        metadata: RelayMetadata<'_>,
        plaintext: &[u8],
    ) -> Result<String, RelayCryptoError> {
        if metadata.protocol_version != self.protocol_version {
            return Err(RelayCryptoError::InvalidBinding);
        }
        let counter = parse_counter(metadata.counter)?;
        let cipher = Aes256Gcm::new_from_slice(self.key(direction))
            .map_err(|_| RelayCryptoError::InvalidBinding)?;
        let nonce_bytes = nonce(counter);
        let nonce = Nonce::from(nonce_bytes);
        let ciphertext = cipher
            .encrypt(
                &nonce,
                Payload {
                    msg: plaintext,
                    aad: metadata.aad(direction).as_bytes(),
                },
            )
            .map_err(|_| RelayCryptoError::AuthenticationFailed)?;
        Ok(URL_SAFE_NO_PAD.encode(ciphertext))
    }

    fn decrypt(
        &self,
        direction: RelayDirection,
        metadata: RelayMetadata<'_>,
        ciphertext: &str,
    ) -> Result<Vec<u8>, RelayCryptoError> {
        if metadata.protocol_version != self.protocol_version {
            return Err(RelayCryptoError::InvalidBinding);
        }
        let counter = parse_counter(metadata.counter)?;
        let ciphertext = URL_SAFE_NO_PAD
            .decode(ciphertext)
            .map_err(|_| RelayCryptoError::AuthenticationFailed)?;
        let cipher = Aes256Gcm::new_from_slice(self.key(direction))
            .map_err(|_| RelayCryptoError::InvalidBinding)?;
        let nonce_bytes = nonce(counter);
        let nonce = Nonce::from(nonce_bytes);
        cipher
            .decrypt(
                &nonce,
                Payload {
                    msg: &ciphertext,
                    aad: metadata.aad(direction).as_bytes(),
                },
            )
            .map_err(|_| RelayCryptoError::AuthenticationFailed)
    }

    fn key(&self, direction: RelayDirection) -> &[u8; 32] {
        match direction {
            RelayDirection::Request => &self.request,
            RelayDirection::Response => &self.response,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelayDirection {
    Request,
    Response,
}

impl RelayDirection {
    fn as_str(self) -> &'static str {
        match self {
            Self::Request => "request",
            Self::Response => "response",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct RelayMetadata<'a> {
    pub binding: &'a RelayBinding,
    pub protocol_version: u32,
    pub request_id: Uuid,
    pub operation: &'a str,
    pub counter: &'a str,
}

impl RelayMetadata<'_> {
    pub fn aad(self, direction: RelayDirection) -> String {
        format!(
            "{}|{}|{}|{}|{}",
            self.binding.context(self.protocol_version),
            self.request_id,
            direction.as_str(),
            self.operation,
            self.counter
        )
    }

    pub fn envelope(self, ciphertext: String) -> EncryptedRelayEnvelope {
        EncryptedRelayEnvelope {
            protocol_version: self.protocol_version,
            suite: self.binding.suite.clone(),
            request_id: self.request_id,
            grant_id: self.binding.grant_id,
            application_id: self.binding.application_id,
            connector_id: self.binding.connector_id,
            collection_id: self.binding.collection_id,
            operation: self.operation.to_string(),
            scope_epoch: self.binding.scope_epoch,
            key_id: self.binding.key_id.clone(),
            counter: self.counter.to_string(),
            deadline_unix_ms: None,
            ciphertext,
        }
    }
}

pub fn validate_envelope(
    envelope: &EncryptedRelayEnvelope,
    binding: &RelayBinding,
) -> Result<(), RelayCryptoError> {
    binding.validate()?;
    parse_counter(&envelope.counter)?;
    if !SUPPORTED_OPERATION_TRANSPORT_PROTOCOL_VERSIONS.contains(&envelope.protocol_version)
        || envelope.suite != binding.suite
        || envelope.grant_id != binding.grant_id
        || envelope.application_id != binding.application_id
        || envelope.connector_id != binding.connector_id
        || envelope.collection_id != binding.collection_id
        || envelope.scope_epoch != binding.scope_epoch
        || envelope.key_id != binding.key_id
        || envelope.operation.is_empty()
    {
        return Err(RelayCryptoError::InvalidBinding);
    }
    Ok(())
}

pub fn parse_counter(value: &str) -> Result<u64, RelayCryptoError> {
    let counter = value
        .parse::<u64>()
        .map_err(|_| RelayCryptoError::InvalidCounter)?;
    if counter == 0 || counter.to_string() != value {
        return Err(RelayCryptoError::InvalidCounter);
    }
    Ok(counter)
}

fn nonce(counter: u64) -> [u8; 12] {
    let mut nonce = [0; 12];
    nonce[4..].copy_from_slice(&counter.to_be_bytes());
    nonce
}

#[cfg(test)]
mod tests {
    use super::*;

    fn binding() -> RelayBinding {
        RelayBinding {
            grant_id: Uuid::from_u128(1),
            application_id: Uuid::from_u128(2),
            connector_id: Uuid::from_u128(3),
            collection_id: Uuid::from_u128(4),
            scope_epoch: 1,
            key_id: "key-1".into(),
            suite: RELAY_ENCRYPTION_SUITE.into(),
        }
    }

    #[test]
    fn both_endpoints_derive_interoperable_directional_keys() {
        let application = RelayIdentity::generate();
        let connector = RelayIdentity::generate();
        let binding = binding();
        let app_keys = application
            .derive(&connector.public_key(), &binding)
            .unwrap();
        let connector_keys = connector
            .derive(&application.public_key(), &binding)
            .unwrap();
        let metadata = RelayMetadata {
            binding: &binding,
            protocol_version: OPERATION_TRANSPORT_PROTOCOL_VERSION,
            request_id: Uuid::from_u128(5),
            operation: "query",
            counter: "1",
        };
        let encrypted = app_keys
            .encrypt_json(
                RelayDirection::Request,
                metadata,
                &serde_json::json!({"secret": "value"}),
            )
            .unwrap();
        let decrypted: serde_json::Value = connector_keys
            .decrypt_json(RelayDirection::Request, metadata, &encrypted)
            .unwrap();
        assert_eq!(decrypted, serde_json::json!({"secret": "value"}));
    }

    #[test]
    fn frozen_beta55_v2_ciphertext_is_interoperable_in_both_directions() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../packages/protocol/test/fixtures/encrypted-relay-beta55-v2.json"
        ))
        .unwrap();
        let decode = |name: &str| {
            URL_SAFE_NO_PAD
                .decode(fixture[name].as_str().unwrap())
                .unwrap()
        };
        let application = RelayIdentity::from_bytes(&decode("application_private_key")).unwrap();
        let connector = RelayIdentity::from_bytes(&decode("connector_private_key")).unwrap();
        assert_eq!(
            application.public_key(),
            fixture["application_public_key"].as_str().unwrap()
        );
        assert_eq!(
            connector.public_key(),
            fixture["connector_public_key"].as_str().unwrap()
        );
        let binding = RelayBinding {
            grant_id: fixture["grant_id"].as_str().unwrap().parse().unwrap(),
            application_id: fixture["application_id"].as_str().unwrap().parse().unwrap(),
            connector_id: fixture["connector_id"].as_str().unwrap().parse().unwrap(),
            collection_id: fixture["collection_id"].as_str().unwrap().parse().unwrap(),
            scope_epoch: fixture["scope_epoch"].as_u64().unwrap(),
            key_id: fixture["key_id"].as_str().unwrap().to_string(),
            suite: fixture["suite"].as_str().unwrap().to_string(),
        };
        let protocol_version = fixture["protocol_version"].as_u64().unwrap() as u32;
        let metadata = RelayMetadata {
            binding: &binding,
            protocol_version,
            request_id: fixture["request_id"].as_str().unwrap().parse().unwrap(),
            operation: fixture["operation"].as_str().unwrap(),
            counter: fixture["counter"].as_str().unwrap(),
        };
        let application_keys = application
            .derive_for_protocol(&connector.public_key(), &binding, protocol_version)
            .unwrap();
        let connector_keys = connector
            .derive_for_protocol(&application.public_key(), &binding, protocol_version)
            .unwrap();
        let request_ciphertext = fixture["request"]["ciphertext"].as_str().unwrap();
        let request: serde_json::Value = connector_keys
            .decrypt_json(RelayDirection::Request, metadata, request_ciphertext)
            .unwrap();
        assert_eq!(request, fixture["request"]["plaintext"]);
        assert_eq!(
            application_keys
                .encrypt(
                    RelayDirection::Request,
                    metadata,
                    br#"{"path":"legacy.md","document":"pending beta55 mutation"}"#,
                )
                .unwrap(),
            request_ciphertext
        );
        let response_ciphertext = fixture["response"]["ciphertext"].as_str().unwrap();
        let response: serde_json::Value = application_keys
            .decrypt_json(RelayDirection::Response, metadata, response_ciphertext)
            .unwrap();
        assert_eq!(response, fixture["response"]["plaintext"]);
        assert_eq!(
            connector_keys
                .encrypt(
                    RelayDirection::Response,
                    metadata,
                    br#"{"ok":true,"result":{"path":"legacy.md","revision":"legacy-revision"}}"#,
                )
                .unwrap(),
            response_ciphertext
        );
    }

    #[test]
    fn metadata_tampering_and_wrong_direction_fail_authentication() {
        let application = RelayIdentity::generate();
        let connector = RelayIdentity::generate();
        let binding = binding();
        let app_keys = application
            .derive(&connector.public_key(), &binding)
            .unwrap();
        let connector_keys = connector
            .derive(&application.public_key(), &binding)
            .unwrap();
        let metadata = RelayMetadata {
            binding: &binding,
            protocol_version: OPERATION_TRANSPORT_PROTOCOL_VERSION,
            request_id: Uuid::from_u128(5),
            operation: "read",
            counter: "9",
        };
        let encrypted = app_keys
            .encrypt_json(
                RelayDirection::Request,
                metadata,
                &serde_json::json!({"path": "private.md"}),
            )
            .unwrap();
        let altered = RelayMetadata {
            operation: "query",
            ..metadata
        };
        assert!(connector_keys
            .decrypt_json::<serde_json::Value>(RelayDirection::Request, altered, &encrypted)
            .is_err());
        assert!(connector_keys
            .decrypt_json::<serde_json::Value>(RelayDirection::Response, metadata, &encrypted)
            .is_err());
    }

    #[test]
    fn identity_storage_round_trip_is_stable() {
        let first = RelayIdentity::generate();
        let second = RelayIdentity::from_storage_value(&first.storage_value()).unwrap();
        assert_eq!(first.secret_bytes(), second.secret_bytes());
        assert!(RelayIdentity::from_storage_value("not an identity").is_err());
    }

    #[test]
    fn counters_are_strict_positive_canonical_u64_values() {
        assert_eq!(parse_counter("1").unwrap(), 1);
        assert_eq!(parse_counter(&u64::MAX.to_string()).unwrap(), u64::MAX);
        for invalid in ["", "0", "01", "-1", "1.0", "18446744073709551616"] {
            assert!(parse_counter(invalid).is_err(), "accepted {invalid}");
        }
    }
}
