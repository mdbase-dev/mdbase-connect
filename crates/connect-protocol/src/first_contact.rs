use crate::crypto::RelayIdentity;
use crate::FIRST_CONTACT_PROTOCOL_VERSION;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hkdf::Hkdf;
use p256::PublicKey;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

const TRANSCRIPT_DOMAIN: &[u8] = b"mdbase-connect first-contact transcript\0";
const SAS_INFO: &[u8] = b"mdbase-connect first-contact sas v1";
const CROCKFORD_BASE32: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FirstContactBinding {
    pub protocol_version: u32,
    pub application_id: Uuid,
    pub application_installation_id: Uuid,
    pub application_agreement_public_key: String,
    pub application_signing_public_key: String,
    pub connector_id: Uuid,
    pub connector_agreement_public_key: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FirstContactRole {
    Application,
    Connector,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum FirstContactError {
    #[error("unsupported first-contact protocol version")]
    UnsupportedVersion,
    #[error("invalid first-contact public key")]
    InvalidPublicKey,
    #[error("first-contact identity does not match the transcript")]
    IdentityMismatch,
    #[error("first-contact key derivation failed")]
    DerivationFailed,
}

impl FirstContactBinding {
    pub fn validate(&self) -> Result<(), FirstContactError> {
        self.validated_keys().map(|_| ())
    }

    pub fn derive_sas(
        &self,
        identity: &RelayIdentity,
        role: FirstContactRole,
    ) -> Result<String, FirstContactError> {
        let keys = self.validated_keys()?;
        let (own, peer) = match role {
            FirstContactRole::Application => (&keys.application_agreement, &keys.connector),
            FirstContactRole::Connector => (&keys.connector, &keys.application_agreement),
        };
        if identity.public_key() != URL_SAFE_NO_PAD.encode(own) {
            return Err(FirstContactError::IdentityMismatch);
        }
        let shared = identity
            .shared_secret(&URL_SAFE_NO_PAD.encode(peer))
            .map_err(|_| FirstContactError::InvalidPublicKey)?;
        let transcript_hash = Sha256::digest(self.transcript(&keys));
        let hkdf = Hkdf::<Sha256>::new(Some(&transcript_hash), &shared);
        let mut sas = [0_u8; 5];
        hkdf.expand(SAS_INFO, &mut sas)
            .map_err(|_| FirstContactError::DerivationFailed)?;
        Ok(format_sas(sas))
    }

    fn validated_keys(&self) -> Result<ValidatedKeys, FirstContactError> {
        if self.protocol_version != FIRST_CONTACT_PROTOCOL_VERSION {
            return Err(FirstContactError::UnsupportedVersion);
        }
        let application_agreement = canonical_public_key(&self.application_agreement_public_key)?;
        let application_signing = canonical_public_key(&self.application_signing_public_key)?;
        let connector = canonical_public_key(&self.connector_agreement_public_key)?;
        if application_agreement == application_signing
            || application_agreement == connector
            || application_signing == connector
        {
            return Err(FirstContactError::InvalidPublicKey);
        }
        Ok(ValidatedKeys {
            application_agreement,
            application_signing,
            connector,
        })
    }

    fn transcript(&self, keys: &ValidatedKeys) -> Vec<u8> {
        let mut transcript = Vec::with_capacity(300);
        transcript.extend_from_slice(TRANSCRIPT_DOMAIN);
        transcript.extend_from_slice(&self.protocol_version.to_be_bytes());
        append_field(&mut transcript, self.application_id.as_bytes());
        append_field(&mut transcript, self.application_installation_id.as_bytes());
        append_field(&mut transcript, &keys.application_agreement);
        append_field(&mut transcript, &keys.application_signing);
        append_field(&mut transcript, self.connector_id.as_bytes());
        append_field(&mut transcript, &keys.connector);
        transcript
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApplicationTrustPresentation {
    pub application_name: String,
    pub application_distribution: String,
    pub application_homepage: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub application_project_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub application_icon: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApplicationTrustRequest {
    pub request_id: Uuid,
    pub binding: FirstContactBinding,
    pub presentation: ApplicationTrustPresentation,
    pub created_at: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApplicationTrust {
    pub id: Uuid,
    pub binding: FirstContactBinding,
    pub presentation: ApplicationTrustPresentation,
    pub trusted_at: String,
    pub last_used_at: String,
}

struct ValidatedKeys {
    application_agreement: Vec<u8>,
    application_signing: Vec<u8>,
    connector: Vec<u8>,
}

fn canonical_public_key(encoded: &str) -> Result<Vec<u8>, FirstContactError> {
    let decoded = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| FirstContactError::InvalidPublicKey)?;
    if URL_SAFE_NO_PAD.encode(&decoded) != encoded
        || decoded.len() != 65
        || decoded.first() != Some(&4)
        || PublicKey::from_sec1_bytes(&decoded).is_err()
    {
        return Err(FirstContactError::InvalidPublicKey);
    }
    Ok(decoded)
}

fn append_field(output: &mut Vec<u8>, field: &[u8]) {
    output.extend_from_slice(&(field.len() as u32).to_be_bytes());
    output.extend_from_slice(field);
}

fn format_sas(bytes: [u8; 5]) -> String {
    let mut encoded = String::with_capacity(9);
    let value = u64::from_be_bytes([0, 0, 0, bytes[0], bytes[1], bytes[2], bytes[3], bytes[4]]);
    for index in (0..8).rev() {
        let digit = ((value >> (index * 5)) & 31) as usize;
        encoded.push(CROCKFORD_BASE32[digit] as char);
        if index == 4 {
            encoded.push('-');
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (FirstContactBinding, RelayIdentity, RelayIdentity, String) {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../packages/protocol/test/fixtures/first-contact-v1.json"
        ))
        .unwrap();
        let binding = serde_json::from_value(fixture["binding"].clone()).unwrap();
        let application = RelayIdentity::from_bytes(
            &URL_SAFE_NO_PAD
                .decode(fixture["application_private_key"].as_str().unwrap())
                .unwrap(),
        )
        .unwrap();
        let connector = RelayIdentity::from_bytes(
            &URL_SAFE_NO_PAD
                .decode(fixture["connector_private_key"].as_str().unwrap())
                .unwrap(),
        )
        .unwrap();
        (
            binding,
            application,
            connector,
            fixture["sas"].as_str().unwrap().to_string(),
        )
    }

    fn scalar(value: u8) -> [u8; 32] {
        let mut bytes = [0_u8; 32];
        bytes[31] = value;
        bytes
    }

    #[test]
    fn endpoints_derive_the_same_sas() {
        let (binding, application, connector, expected) = fixture();
        let application_sas = binding
            .derive_sas(&application, FirstContactRole::Application)
            .unwrap();
        let connector_sas = binding
            .derive_sas(&connector, FirstContactRole::Connector)
            .unwrap();
        assert_eq!(application_sas, connector_sas);
        assert_eq!(application_sas, expected);
    }

    #[test]
    fn substituted_keys_change_the_sas() {
        let (binding, application, connector, _) = fixture();
        let honest = binding
            .derive_sas(&application, FirstContactRole::Application)
            .unwrap();
        let attacker = RelayIdentity::from_bytes(&scalar(4)).unwrap();
        let mut substituted = binding;
        substituted.connector_agreement_public_key = attacker.public_key();
        let attacked = substituted
            .derive_sas(&application, FirstContactRole::Application)
            .unwrap();
        assert_ne!(honest, attacked);
        assert_eq!(
            substituted.derive_sas(&connector, FirstContactRole::Connector),
            Err(FirstContactError::IdentityMismatch)
        );
    }

    #[test]
    fn rejects_noncanonical_and_reused_keys() {
        let (mut binding, application, _, _) = fixture();
        binding.application_signing_public_key = binding.application_agreement_public_key.clone();
        assert_eq!(
            binding.derive_sas(&application, FirstContactRole::Application),
            Err(FirstContactError::InvalidPublicKey)
        );

        binding.application_signing_public_key = "not-a-key".to_string();
        assert_eq!(
            binding.derive_sas(&application, FirstContactRole::Application),
            Err(FirstContactError::InvalidPublicKey)
        );
    }
}
