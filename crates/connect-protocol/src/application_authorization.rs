use crate::{
    authorization_requires_durable_mutation, ApplicationFileRequirement,
    ConnectContractRequirements, FileAction, FileCapabilityKind, FileScope, GrantPolicy,
    APPLICATION_AUTHORIZATION_PROTOCOL_VERSION, FILE_PROTOCOL_VERSION,
    GRANT_ENCRYPTION_PROTOCOL_VERSION,
};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use p256::ecdsa::{signature::Verifier, Signature, VerifyingKey};
use p256::PublicKey;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

const INSTALLATION_ID_DOMAIN: &[u8] = b"mdbase-connect application installation id v2\0";
const AUTHORIZATION_PROOF_DOMAIN: &[u8] = b"mdbase-connect application authorization proof v4\0";

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ApplicationAuthorizationError {
    #[error("unsupported application authorization protocol version")]
    UnsupportedVersion,
    #[error("invalid application authorization public key")]
    InvalidPublicKey,
    #[error("invalid application installation identifier")]
    InvalidInstallationId,
    #[error("invalid application authorization proof")]
    InvalidProof,
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
    pub authorization_id: Uuid,
    pub application_id: Uuid,
    pub application_declaration_id: String,
    pub application_manifest_digest: String,
    pub application_installation_id: Uuid,
    pub installation_signing_public_key: String,
    pub grant_agreement_public_key: String,
    pub grant_signing_public_key: String,
    pub flow: ApplicationAuthorizationFlow,
    pub authorization_nonce: String,
    pub issued_at: String,
    pub expires_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub redirect_uri: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    pub code_challenge: String,
    pub contracts: ConnectContractRequirements,
    pub requested_operations: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_files: Option<ApplicationFileRequirement>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collection_id: Option<Uuid>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApplicationAuthorizationProof {
    pub binding: ApplicationAuthorizationBinding,
    pub signature: String,
}

impl ApplicationAuthorizationBinding {
    pub fn signing_message(&self) -> Result<Vec<u8>, ApplicationAuthorizationError> {
        let keys = self.validated_keys()?;
        let nonce = canonical_base64(&self.authorization_nonce, 32)?;
        if canonical_base64(&self.code_challenge, 32).is_err()
            || self.issued_at.is_empty()
            || self.issued_at.len() > 40
            || self.issued_at.as_bytes().contains(&0)
            || self.expires_at.is_empty()
            || self.expires_at.len() > 40
            || self.expires_at.as_bytes().contains(&0)
            || !is_hex_sha256(&self.application_manifest_digest)
            || !is_application_declaration_id(&self.application_declaration_id)
            || self.contracts.operation_transport == 0
            || self.contracts.authorization_binding == 0
            || self.contracts.semantic_capabilities == 0
            || self.contracts.durable_mutation == Some(0)
            || (self.requested_operations.is_empty() && self.requested_files.is_none())
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
            return Err(ApplicationAuthorizationError::InvalidProof);
        }
        validate_requested_files(self.requested_files.as_ref())?;
        match self.flow {
            ApplicationAuthorizationFlow::AuthorizationCode
                if self.redirect_uri.is_none() || self.state.is_none() =>
            {
                return Err(ApplicationAuthorizationError::InvalidProof);
            }
            ApplicationAuthorizationFlow::DeviceCode
                if self.redirect_uri.is_some() || self.state.is_some() =>
            {
                return Err(ApplicationAuthorizationError::InvalidProof);
            }
            _ => {}
        }
        if installation_id(&keys.installation_signing) != self.application_installation_id {
            return Err(ApplicationAuthorizationError::InvalidInstallationId);
        }

        let mut transcript = Vec::with_capacity(620);
        transcript.extend_from_slice(AUTHORIZATION_PROOF_DOMAIN);
        transcript.extend_from_slice(&self.protocol_version.to_be_bytes());
        append_field(&mut transcript, self.application_id.as_bytes());
        append_field(&mut transcript, self.authorization_id.as_bytes());
        append_field(&mut transcript, self.application_declaration_id.as_bytes());
        append_field(
            &mut transcript,
            &hex_sha256(&self.application_manifest_digest)?,
        );
        append_field(&mut transcript, self.application_installation_id.as_bytes());
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
        append_field(&mut transcript, self.issued_at.as_bytes());
        append_field(&mut transcript, self.expires_at.as_bytes());
        append_optional_string(&mut transcript, self.redirect_uri.as_deref());
        append_optional_string(&mut transcript, self.state.as_deref());
        append_field(&mut transcript, self.code_challenge.as_bytes());
        transcript.extend_from_slice(&self.contracts.operation_transport.to_be_bytes());
        transcript.extend_from_slice(&self.contracts.authorization_binding.to_be_bytes());
        transcript.extend_from_slice(&self.contracts.semantic_capabilities.to_be_bytes());
        append_optional_u32(&mut transcript, self.contracts.durable_mutation);
        transcript.extend_from_slice(&(self.requested_operations.len() as u32).to_be_bytes());
        for operation in &self.requested_operations {
            append_field(&mut transcript, operation.as_bytes());
        }
        append_requested_files(&mut transcript, self.requested_files.as_ref());
        append_optional_uuid(&mut transcript, self.collection_id);
        Ok(transcript)
    }

    fn validated_keys(&self) -> Result<AuthorizationKeys, ApplicationAuthorizationError> {
        if self.protocol_version != APPLICATION_AUTHORIZATION_PROTOCOL_VERSION {
            return Err(ApplicationAuthorizationError::UnsupportedVersion);
        }
        let keys = AuthorizationKeys {
            installation_signing: canonical_public_key(&self.installation_signing_public_key)?,
            grant_agreement: canonical_public_key(&self.grant_agreement_public_key)?,
            grant_signing: canonical_public_key(&self.grant_signing_public_key)?,
        };
        let unique = [
            &keys.installation_signing,
            &keys.grant_agreement,
            &keys.grant_signing,
        ];
        if unique
            .iter()
            .enumerate()
            .any(|(index, key)| unique.iter().skip(index + 1).any(|other| key == other))
        {
            return Err(ApplicationAuthorizationError::InvalidPublicKey);
        }
        Ok(keys)
    }
}

fn append_optional_u32(transcript: &mut Vec<u8>, value: Option<u32>) {
    match value {
        Some(value) => {
            transcript.push(1);
            transcript.extend_from_slice(&value.to_be_bytes());
        }
        None => transcript.push(0),
    }
}

impl ApplicationAuthorizationProof {
    pub fn verify(&self) -> Result<(), ApplicationAuthorizationError> {
        let message = self.binding.signing_message()?;
        let public_key = canonical_public_key(&self.binding.installation_signing_public_key)?;
        let signature = canonical_base64(&self.signature, 64)?;
        let verifier = VerifyingKey::from_sec1_bytes(&public_key)
            .map_err(|_| ApplicationAuthorizationError::InvalidPublicKey)?;
        let signature = Signature::from_slice(&signature)
            .map_err(|_| ApplicationAuthorizationError::InvalidProof)?;
        if signature.normalize_s().is_some() {
            return Err(ApplicationAuthorizationError::InvalidProof);
        }
        verifier
            .verify(&message, &signature)
            .map_err(|_| ApplicationAuthorizationError::InvalidProof)
    }
}

impl GrantPolicy {
    /// Validate the application-signed authorization ceiling without consulting
    /// connector-local state or the authorization expiry clock.
    pub fn validate_application_security(&self) -> Result<(), ApplicationAuthorizationError> {
        self.application_authorization.verify()?;
        let authorization = &self.application_authorization.binding;
        let encryption = self
            .encryption
            .as_ref()
            .ok_or(ApplicationAuthorizationError::InvalidProof)?;
        let flow_matches = match authorization.flow {
            ApplicationAuthorizationFlow::AuthorizationCode => {
                self.application_distribution == "web"
            }
            ApplicationAuthorizationFlow::DeviceCode => self.application_distribution == "portable",
        };
        let files_match = match (
            authorization.requested_files.as_ref(),
            self.file_capability.as_ref(),
        ) {
            (None, None) => true,
            (Some(requested), Some(granted)) => {
                granted.kind == FileCapabilityKind::Files
                    && granted.protocol_version == FILE_PROTOCOL_VERSION
                    && granted.actions == requested.actions
                    && granted.scope == requested.scope
            }
            _ => false,
        };
        let expected_contracts =
            ConnectContractRequirements::current(authorization_requires_durable_mutation(
                &authorization.requested_operations,
                authorization.requested_files.as_ref(),
            ));
        if authorization.application_id != self.application_id
            || authorization.grant_agreement_public_key
                != encryption.application_agreement_public_key
            || encryption.collection_id != self.collection_id
            || encryption.protocol_version != GRANT_ENCRYPTION_PROTOCOL_VERSION
            || authorization
                .collection_id
                .is_some_and(|collection_id| collection_id != self.collection_id)
            || self.operations.iter().any(|operation| {
                !authorization
                    .requested_operations
                    .iter()
                    .any(|requested| requested == operation)
            })
            || !flow_matches
            || !files_match
            || authorization.contracts != expected_contracts
        {
            return Err(ApplicationAuthorizationError::InvalidProof);
        }
        Ok(())
    }
}

pub fn application_installation_id(
    signing_public_key: &str,
) -> Result<Uuid, ApplicationAuthorizationError> {
    let signing = canonical_public_key(signing_public_key)?;
    Ok(installation_id(&signing))
}

struct AuthorizationKeys {
    installation_signing: Vec<u8>,
    grant_agreement: Vec<u8>,
    grant_signing: Vec<u8>,
}

fn installation_id(signing: &[u8]) -> Uuid {
    let mut digest = Sha256::new();
    digest.update(INSTALLATION_ID_DOMAIN);
    digest.update((signing.len() as u32).to_be_bytes());
    digest.update(signing);
    let digest = digest.finalize();
    let mut bytes = [0_u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes)
}

fn canonical_public_key(encoded: &str) -> Result<Vec<u8>, ApplicationAuthorizationError> {
    let decoded = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| ApplicationAuthorizationError::InvalidPublicKey)?;
    if URL_SAFE_NO_PAD.encode(&decoded) != encoded
        || decoded.len() != 65
        || decoded.first() != Some(&4)
        || PublicKey::from_sec1_bytes(&decoded).is_err()
    {
        return Err(ApplicationAuthorizationError::InvalidPublicKey);
    }
    Ok(decoded)
}

fn canonical_base64(
    encoded: &str,
    expected_len: usize,
) -> Result<Vec<u8>, ApplicationAuthorizationError> {
    let decoded = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| ApplicationAuthorizationError::InvalidProof)?;
    if encoded.is_empty()
        || URL_SAFE_NO_PAD.encode(&decoded) != encoded
        || decoded.len() != expected_len
    {
        return Err(ApplicationAuthorizationError::InvalidProof);
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

fn validate_requested_files(
    files: Option<&ApplicationFileRequirement>,
) -> Result<(), ApplicationAuthorizationError> {
    let Some(files) = files else {
        return Ok(());
    };
    if files.actions.is_empty()
        || files
            .actions
            .iter()
            .map(file_action_name)
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            != files.actions.len()
    {
        return Err(ApplicationAuthorizationError::InvalidProof);
    }
    if let FileScope::SelectedFolders { folders } = &files.scope {
        if folders.is_empty()
            || folders
                .iter()
                .any(|folder| folder.is_empty() || folder.as_bytes().contains(&0))
            || folders
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                != folders.len()
        {
            return Err(ApplicationAuthorizationError::InvalidProof);
        }
    }
    Ok(())
}

fn append_requested_files(output: &mut Vec<u8>, files: Option<&ApplicationFileRequirement>) {
    let Some(files) = files else {
        output.push(0);
        return;
    };
    output.push(1);
    output.extend_from_slice(&(files.actions.len() as u32).to_be_bytes());
    for action in &files.actions {
        append_field(output, file_action_name(action).as_bytes());
    }
    match &files.scope {
        FileScope::Collection => append_field(output, b"collection"),
        FileScope::SelectedFolders { folders } => {
            append_field(output, b"selected_folders");
            output.extend_from_slice(&(folders.len() as u32).to_be_bytes());
            for folder in folders {
                append_field(output, folder.as_bytes());
            }
        }
    }
}

fn file_action_name(action: &FileAction) -> &'static str {
    match action {
        FileAction::List => "list",
        FileAction::Read => "read",
        FileAction::Add => "add",
        FileAction::Replace => "replace",
        FileAction::Move => "move",
        FileAction::Delete => "delete",
    }
}

fn is_hex_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}

fn is_application_declaration_id(value: &str) -> bool {
    let mut saw_separator = false;
    for (index, segment) in value
        .split(|character| {
            let separator = matches!(character, '.' | '_' | '-');
            saw_separator |= separator;
            separator
        })
        .enumerate()
    {
        if segment.is_empty()
            || (index == 0 && !segment.as_bytes()[0].is_ascii_lowercase())
            || !segment
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        {
            return false;
        }
    }
    saw_separator
}

fn hex_sha256(value: &str) -> Result<[u8; 32], ApplicationAuthorizationError> {
    if !is_hex_sha256(value) {
        return Err(ApplicationAuthorizationError::InvalidProof);
    }
    let mut output = [0_u8; 32];
    for (index, byte) in output.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16)
            .map_err(|_| ApplicationAuthorizationError::InvalidProof)?;
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::{signature::Signer, SigningKey};

    fn scalar(value: u8) -> [u8; 32] {
        let mut bytes = [0_u8; 32];
        bytes[31] = value;
        bytes
    }

    fn fixture() -> (ApplicationAuthorizationBinding, serde_json::Value) {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../packages/protocol/test/fixtures/application-authorization-v4.json"
        ))
        .unwrap();
        let binding = serde_json::from_value(fixture["binding"].clone()).unwrap();
        (binding, fixture)
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    fn proof() -> (ApplicationAuthorizationProof, SigningKey) {
        let (binding, fixture) = fixture();
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
        let signature: Signature = signing_key.sign(&binding.signing_message().unwrap());
        let signature = signature.normalize_s().unwrap_or(signature);
        (
            ApplicationAuthorizationProof {
                binding,
                signature: URL_SAFE_NO_PAD.encode(signature.to_bytes()),
            },
            signing_key,
        )
    }

    #[test]
    fn shared_fixture_matches_installation_id_transcript_and_signature() {
        let (binding, fixture) = fixture();
        assert_eq!(
            application_installation_id(&binding.installation_signing_public_key).unwrap(),
            binding.application_installation_id
        );
        assert_eq!(
            hex(&Sha256::digest(binding.signing_message().unwrap())),
            fixture["signing_message_sha256"].as_str().unwrap()
        );
        ApplicationAuthorizationProof {
            binding,
            signature: fixture["signature"].as_str().unwrap().to_string(),
        }
        .verify()
        .unwrap();
    }

    #[test]
    fn signature_binds_every_security_field() {
        let (proof, _) = proof();
        let rejected = |binding: ApplicationAuthorizationBinding| {
            assert_eq!(
                ApplicationAuthorizationProof {
                    binding,
                    signature: proof.signature.clone(),
                }
                .verify(),
                Err(ApplicationAuthorizationError::InvalidProof)
            );
        };

        let mut changed = proof.binding.clone();
        changed.authorization_id = Uuid::new_v4();
        rejected(changed);
        let mut changed = proof.binding.clone();
        changed.application_id = Uuid::new_v4();
        rejected(changed);
        let mut changed = proof.binding.clone();
        changed.application_manifest_digest = "ab".repeat(32);
        rejected(changed);
        let mut changed = proof.binding.clone();
        changed.authorization_nonce = URL_SAFE_NO_PAD.encode([7_u8; 32]);
        rejected(changed);
        let mut changed = proof.binding.clone();
        changed.issued_at = "2026-08-02T07:51:00.000Z".to_string();
        rejected(changed);
        let mut changed = proof.binding.clone();
        changed.expires_at = "2026-08-02T07:59:00.000Z".to_string();
        rejected(changed);
        let mut changed = proof.binding.clone();
        changed.redirect_uri = Some("http://127.0.0.1:4181/callback".to_string());
        rejected(changed);
        let mut changed = proof.binding.clone();
        changed.state = Some("other-state".to_string());
        rejected(changed);
        let mut changed = proof.binding.clone();
        changed.code_challenge = URL_SAFE_NO_PAD.encode([8_u8; 32]);
        rejected(changed);
        let mut changed = proof.binding.clone();
        changed.requested_operations.swap(0, 1);
        rejected(changed);
        let mut changed = proof.binding.clone();
        changed.requested_files.as_mut().unwrap().actions.swap(0, 1);
        rejected(changed);
        let mut changed = proof.binding.clone();
        changed.collection_id = Some(Uuid::new_v4());
        rejected(changed);
        let mut changed = proof.binding.clone();
        changed.grant_signing_public_key = URL_SAFE_NO_PAD.encode(
            SigningKey::from_slice(&scalar(5))
                .unwrap()
                .verifying_key()
                .to_encoded_point(false)
                .as_bytes(),
        );
        rejected(changed);
        let mut changed = proof.binding.clone();
        changed.flow = ApplicationAuthorizationFlow::DeviceCode;
        changed.redirect_uri = None;
        changed.state = None;
        rejected(changed);
    }

    #[test]
    fn rejects_invalid_identity_flow_and_encodings() {
        let (proof, _) = proof();
        let mut changed = proof.binding.clone();
        changed.application_installation_id = Uuid::new_v4();
        assert_eq!(
            changed.signing_message(),
            Err(ApplicationAuthorizationError::InvalidInstallationId)
        );

        let mut duplicate_key = proof.binding.clone();
        duplicate_key.grant_signing_public_key = duplicate_key.grant_agreement_public_key.clone();
        assert_eq!(
            duplicate_key.signing_message(),
            Err(ApplicationAuthorizationError::InvalidPublicKey)
        );

        let mut device = proof.binding.clone();
        device.flow = ApplicationAuthorizationFlow::DeviceCode;
        assert_eq!(
            device.signing_message(),
            Err(ApplicationAuthorizationError::InvalidProof)
        );

        let mut duplicate_operation = proof.binding.clone();
        duplicate_operation
            .requested_operations
            .push("read".to_string());
        assert_eq!(
            duplicate_operation.signing_message(),
            Err(ApplicationAuthorizationError::InvalidProof)
        );

        let mut padded_nonce = proof.binding;
        padded_nonce.authorization_nonce.push('=');
        assert_eq!(
            padded_nonce.signing_message(),
            Err(ApplicationAuthorizationError::InvalidProof)
        );
    }
}
