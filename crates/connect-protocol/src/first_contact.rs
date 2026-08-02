use crate::crypto::RelayIdentity;
use crate::FIRST_CONTACT_PROTOCOL_VERSION;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hkdf::Hkdf;
use p256::ecdsa::{signature::Verifier, Signature, VerifyingKey};
use p256::PublicKey;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

const TRANSCRIPT_DOMAIN: &[u8] = b"mdbase-connect first-contact transcript\0";
const SAS_INFO: &[u8] = b"mdbase-connect first-contact sas v1";
const INSTALLATION_ID_DOMAIN: &[u8] = b"mdbase-connect application installation id v1\0";
const AUTHORIZATION_PROOF_DOMAIN: &[u8] = b"mdbase-connect application authorization proof\0";
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
    #[error("invalid application installation identifier")]
    InvalidInstallationId,
    #[error("invalid application authorization proof")]
    InvalidAuthorizationProof,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApplicationAuthorizationFlow {
    AuthorizationCode,
    DeviceCode,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApplicationAuthorizationBinding {
    pub protocol_version: u32,
    pub application_id: Uuid,
    pub application_installation_id: Uuid,
    pub installation_agreement_public_key: String,
    pub installation_signing_public_key: String,
    pub grant_agreement_public_key: String,
    pub grant_signing_public_key: String,
    pub flow: ApplicationAuthorizationFlow,
    pub authorization_nonce: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub redirect_uri: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    pub code_challenge: String,
    pub requested_operations: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collection_id: Option<Uuid>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApplicationAuthorizationProof {
    pub binding: ApplicationAuthorizationBinding,
    pub signature: String,
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

impl ApplicationAuthorizationBinding {
    pub fn signing_message(&self) -> Result<Vec<u8>, FirstContactError> {
        let keys = self.validated_keys()?;
        let nonce = canonical_base64(&self.authorization_nonce, 32)?;
        if canonical_base64(&self.code_challenge, 32).is_err()
            || self.requested_operations.is_empty()
            || self
                .requested_operations
                .iter()
                .any(|operation| operation.is_empty() || operation.as_bytes().contains(&0))
            || self
                .requested_operations
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                != self.requested_operations.len()
        {
            return Err(FirstContactError::InvalidAuthorizationProof);
        }
        match self.flow {
            ApplicationAuthorizationFlow::AuthorizationCode
                if self.redirect_uri.is_none() || self.state.is_none() =>
            {
                return Err(FirstContactError::InvalidAuthorizationProof);
            }
            ApplicationAuthorizationFlow::DeviceCode
                if self.redirect_uri.is_some() || self.state.is_some() =>
            {
                return Err(FirstContactError::InvalidAuthorizationProof);
            }
            _ => {}
        }
        if installation_id(&keys.installation_agreement, &keys.installation_signing)
            != self.application_installation_id
        {
            return Err(FirstContactError::InvalidInstallationId);
        }

        let mut transcript = Vec::with_capacity(700);
        transcript.extend_from_slice(AUTHORIZATION_PROOF_DOMAIN);
        transcript.extend_from_slice(&self.protocol_version.to_be_bytes());
        append_field(&mut transcript, self.application_id.as_bytes());
        append_field(&mut transcript, self.application_installation_id.as_bytes());
        append_field(&mut transcript, &keys.installation_agreement);
        append_field(&mut transcript, &keys.installation_signing);
        append_field(&mut transcript, &keys.grant_agreement);
        append_field(&mut transcript, &keys.grant_signing);
        append_field(
            &mut transcript,
            match self.flow {
                ApplicationAuthorizationFlow::AuthorizationCode => b"authorization_code",
                ApplicationAuthorizationFlow::DeviceCode => b"device_code",
            },
        );
        append_field(&mut transcript, &nonce);
        append_optional_string(&mut transcript, self.redirect_uri.as_deref());
        append_optional_string(&mut transcript, self.state.as_deref());
        append_field(&mut transcript, self.code_challenge.as_bytes());
        transcript.extend_from_slice(&(self.requested_operations.len() as u32).to_be_bytes());
        for operation in &self.requested_operations {
            append_field(&mut transcript, operation.as_bytes());
        }
        append_optional_uuid(&mut transcript, self.collection_id);
        Ok(transcript)
    }

    fn validated_keys(&self) -> Result<AuthorizationKeys, FirstContactError> {
        if self.protocol_version != FIRST_CONTACT_PROTOCOL_VERSION {
            return Err(FirstContactError::UnsupportedVersion);
        }
        let keys = AuthorizationKeys {
            installation_agreement: canonical_public_key(&self.installation_agreement_public_key)?,
            installation_signing: canonical_public_key(&self.installation_signing_public_key)?,
            grant_agreement: canonical_public_key(&self.grant_agreement_public_key)?,
            grant_signing: canonical_public_key(&self.grant_signing_public_key)?,
        };
        let unique = [
            &keys.installation_agreement,
            &keys.installation_signing,
            &keys.grant_agreement,
            &keys.grant_signing,
        ];
        if unique
            .iter()
            .enumerate()
            .any(|(index, key)| unique.iter().skip(index + 1).any(|other| key == other))
        {
            return Err(FirstContactError::InvalidPublicKey);
        }
        Ok(keys)
    }
}

impl ApplicationAuthorizationProof {
    pub fn verify(&self) -> Result<(), FirstContactError> {
        let message = self.binding.signing_message()?;
        let public_key = canonical_public_key(&self.binding.installation_signing_public_key)?;
        let signature = canonical_base64(&self.signature, 64)?;
        let verifier = VerifyingKey::from_sec1_bytes(&public_key)
            .map_err(|_| FirstContactError::InvalidPublicKey)?;
        let signature = Signature::from_slice(&signature)
            .map_err(|_| FirstContactError::InvalidAuthorizationProof)?;
        if signature.normalize_s().is_some() {
            return Err(FirstContactError::InvalidAuthorizationProof);
        }
        verifier
            .verify(&message, &signature)
            .map_err(|_| FirstContactError::InvalidAuthorizationProof)
    }
}

pub fn application_installation_id(
    agreement_public_key: &str,
    signing_public_key: &str,
) -> Result<Uuid, FirstContactError> {
    let agreement = canonical_public_key(agreement_public_key)?;
    let signing = canonical_public_key(signing_public_key)?;
    if agreement == signing {
        return Err(FirstContactError::InvalidPublicKey);
    }
    Ok(installation_id(&agreement, &signing))
}

struct AuthorizationKeys {
    installation_agreement: Vec<u8>,
    installation_signing: Vec<u8>,
    grant_agreement: Vec<u8>,
    grant_signing: Vec<u8>,
}

fn installation_id(agreement: &[u8], signing: &[u8]) -> Uuid {
    let mut digest = Sha256::new();
    digest.update(INSTALLATION_ID_DOMAIN);
    digest.update((agreement.len() as u32).to_be_bytes());
    digest.update(agreement);
    digest.update((signing.len() as u32).to_be_bytes());
    digest.update(signing);
    let digest = digest.finalize();
    let mut bytes = [0_u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes)
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingApplicationTrust {
    #[serde(flatten)]
    pub request: ApplicationTrustRequest,
    pub authentication_string: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApplicationTrustSnapshot {
    pub pending: Vec<PendingApplicationTrust>,
    pub trusted: Vec<ApplicationTrust>,
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

fn canonical_base64(encoded: &str, expected_len: usize) -> Result<Vec<u8>, FirstContactError> {
    let decoded = canonical_base64_variable(encoded)?;
    if decoded.len() != expected_len {
        return Err(FirstContactError::InvalidAuthorizationProof);
    }
    Ok(decoded)
}

fn canonical_base64_variable(encoded: &str) -> Result<Vec<u8>, FirstContactError> {
    let decoded = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| FirstContactError::InvalidAuthorizationProof)?;
    if encoded.is_empty() || URL_SAFE_NO_PAD.encode(&decoded) != encoded {
        return Err(FirstContactError::InvalidAuthorizationProof);
    }
    Ok(decoded)
}

fn append_field(output: &mut Vec<u8>, field: &[u8]) {
    output.extend_from_slice(&(field.len() as u32).to_be_bytes());
    output.extend_from_slice(field);
}

fn append_optional_string(output: &mut Vec<u8>, value: Option<&str>) {
    match value {
        Some(value) => {
            output.push(1);
            append_field(output, value.as_bytes());
        }
        None => output.push(0),
    }
}

fn append_optional_uuid(output: &mut Vec<u8>, value: Option<Uuid>) {
    match value {
        Some(value) => {
            output.push(1);
            append_field(output, value.as_bytes());
        }
        None => output.push(0),
    }
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
    use p256::ecdsa::{signature::Signer, SigningKey};

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

    fn authorization_fixture() -> (ApplicationAuthorizationBinding, serde_json::Value) {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../packages/protocol/test/fixtures/application-authorization-v1.json"
        ))
        .unwrap();
        let binding = serde_json::from_value(fixture["binding"].clone()).unwrap();
        (binding, fixture)
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    fn high_s_signature(signature: Signature) -> Signature {
        const ORDER: [u8; 32] = [
            0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
            0xff, 0xff, 0xbc, 0xe6, 0xfa, 0xad, 0xa7, 0x17, 0x9e, 0x84, 0xf3, 0xb9, 0xca, 0xc2,
            0xfc, 0x63, 0x25, 0x51,
        ];
        let low_s = signature.s().to_bytes();
        let mut high_s = [0_u8; 32];
        let mut borrow = 0_i16;
        for index in (0..32).rev() {
            let value = ORDER[index] as i16 - low_s[index] as i16 - borrow;
            if value < 0 {
                high_s[index] = (value + 256) as u8;
                borrow = 1;
            } else {
                high_s[index] = value as u8;
                borrow = 0;
            }
        }
        Signature::from_scalars(signature.r().to_bytes(), high_s).unwrap()
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

    #[test]
    fn application_authorization_matches_shared_fixture() {
        let (binding, fixture) = authorization_fixture();
        let installation_id = application_installation_id(
            &binding.installation_agreement_public_key,
            &binding.installation_signing_public_key,
        )
        .unwrap();
        assert_eq!(installation_id, binding.application_installation_id);
        let message = binding.signing_message().unwrap();
        assert_eq!(
            hex(&Sha256::digest(message)),
            fixture["signing_message_sha256"].as_str().unwrap()
        );
    }

    #[test]
    fn application_authorization_signature_binds_every_security_field() {
        let (binding, fixture) = authorization_fixture();
        let signing_key = SigningKey::from_slice(
            &URL_SAFE_NO_PAD
                .decode(
                    fixture["installation_signing_private_key"]
                        .as_str()
                        .unwrap(),
                )
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            URL_SAFE_NO_PAD.encode(
                signing_key
                    .verifying_key()
                    .to_encoded_point(false)
                    .as_bytes()
            ),
            binding.installation_signing_public_key
        );
        let signature: Signature = signing_key.sign(&binding.signing_message().unwrap());
        let proof = ApplicationAuthorizationProof {
            binding: binding.clone(),
            signature: URL_SAFE_NO_PAD.encode(signature.to_bytes()),
        };
        proof.verify().unwrap();

        let rejected = |binding: ApplicationAuthorizationBinding| {
            assert_eq!(
                ApplicationAuthorizationProof {
                    binding,
                    signature: proof.signature.clone(),
                }
                .verify(),
                Err(FirstContactError::InvalidAuthorizationProof)
            );
        };

        let mut changed = binding.clone();
        changed.application_id = Uuid::new_v4();
        rejected(changed);
        let mut changed = binding.clone();
        changed.authorization_nonce = URL_SAFE_NO_PAD.encode([7_u8; 32]);
        rejected(changed);
        let mut changed = binding.clone();
        changed.redirect_uri = Some("http://127.0.0.1:4181/callback".to_string());
        rejected(changed);
        let mut changed = binding.clone();
        changed.state = Some("other-state".to_string());
        rejected(changed);
        let mut changed = binding.clone();
        changed.code_challenge = URL_SAFE_NO_PAD.encode([8_u8; 32]);
        rejected(changed);
        let mut changed = binding.clone();
        changed.requested_operations.swap(0, 1);
        rejected(changed);
        let mut changed = binding.clone();
        changed.collection_id = Some(Uuid::new_v4());
        rejected(changed);
        let mut changed = binding.clone();
        changed.grant_signing_public_key = URL_SAFE_NO_PAD.encode(
            SigningKey::from_slice(&scalar(5))
                .unwrap()
                .verifying_key()
                .to_encoded_point(false)
                .as_bytes(),
        );
        rejected(changed);
        let mut changed = binding.clone();
        changed.flow = ApplicationAuthorizationFlow::DeviceCode;
        changed.redirect_uri = None;
        changed.state = None;
        rejected(changed);
        let mut changed = binding.clone();
        changed.application_installation_id = Uuid::new_v4();
        assert_eq!(
            ApplicationAuthorizationProof {
                binding: changed,
                signature: proof.signature.clone(),
            }
            .verify(),
            Err(FirstContactError::InvalidInstallationId)
        );
        let mut changed = binding.clone();
        changed.grant_signing_public_key = binding.grant_agreement_public_key.clone();
        assert_eq!(
            ApplicationAuthorizationProof {
                binding: changed,
                signature: proof.signature.clone(),
            }
            .verify(),
            Err(FirstContactError::InvalidPublicKey)
        );

        let signature =
            Signature::from_slice(&URL_SAFE_NO_PAD.decode(&proof.signature).unwrap()).unwrap();
        let high_s = high_s_signature(signature);
        assert!(high_s.normalize_s().is_some());
        let malleable = ApplicationAuthorizationProof {
            binding: binding.clone(),
            signature: URL_SAFE_NO_PAD.encode(high_s.to_bytes()),
        };
        assert_eq!(
            malleable.verify(),
            Err(FirstContactError::InvalidAuthorizationProof)
        );
        let padded = ApplicationAuthorizationProof {
            binding,
            signature: format!("{}=", proof.signature),
        };
        assert_eq!(
            padded.verify(),
            Err(FirstContactError::InvalidAuthorizationProof)
        );
    }

    #[test]
    fn application_authorization_rejects_invalid_flow_shapes_and_encodings() {
        let (binding, _) = authorization_fixture();
        let mut device = binding.clone();
        device.flow = ApplicationAuthorizationFlow::DeviceCode;
        assert_eq!(
            device.signing_message(),
            Err(FirstContactError::InvalidAuthorizationProof)
        );

        let mut duplicate = binding.clone();
        duplicate.requested_operations.push("read".to_string());
        assert_eq!(
            duplicate.signing_message(),
            Err(FirstContactError::InvalidAuthorizationProof)
        );

        let mut padded_nonce = binding;
        padded_nonce.authorization_nonce.push('=');
        assert_eq!(
            padded_nonce.signing_message(),
            Err(FirstContactError::InvalidAuthorizationProof)
        );
    }
}
