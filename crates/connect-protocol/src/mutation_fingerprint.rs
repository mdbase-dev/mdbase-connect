use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::{mutation_operation_identifier, operation_input_schema_version};

pub const MUTATION_FINGERPRINT_SCHEMA_VERSION: u32 = 1;
pub const MUTATION_FINGERPRINT_DOMAIN: &[u8] = b"mdbase-connect mutation fingerprint v1\0";

#[derive(Debug, Error)]
pub enum MutationFingerprintError {
    #[error("the operation is not a canonical mutation")]
    NotMutation,
    #[error("the operation input schema version is not defined")]
    UnknownInputSchema,
    #[error("the operation input is not valid canonical I-JSON: {0}")]
    InvalidInput(#[from] serde_json::Error),
}

pub fn mutation_fingerprint_transcript(
    operation: &str,
    input: &Value,
) -> Result<Vec<u8>, MutationFingerprintError> {
    let identifier = mutation_operation_identifier(operation, input)
        .ok_or(MutationFingerprintError::NotMutation)?;
    let input_schema_version = operation_input_schema_version(operation, input)
        .ok_or(MutationFingerprintError::UnknownInputSchema)?;
    let canonical_input = serde_jcs::to_vec(input)?;

    let mut transcript = Vec::with_capacity(
        MUTATION_FINGERPRINT_DOMAIN.len() + identifier.len() + canonical_input.len() + 24,
    );
    transcript.extend_from_slice(MUTATION_FINGERPRINT_DOMAIN);
    transcript.extend_from_slice(&MUTATION_FINGERPRINT_SCHEMA_VERSION.to_be_bytes());
    append_field(&mut transcript, identifier.as_bytes());
    transcript.extend_from_slice(&input_schema_version.to_be_bytes());
    append_field(&mut transcript, &canonical_input);
    Ok(transcript)
}

pub fn mutation_fingerprint_bytes(
    operation: &str,
    input: &Value,
) -> Result<[u8; 32], MutationFingerprintError> {
    Ok(Sha256::digest(mutation_fingerprint_transcript(operation, input)?).into())
}

pub fn mutation_fingerprint(
    operation: &str,
    input: &Value,
) -> Result<String, MutationFingerprintError> {
    Ok(URL_SAFE_NO_PAD.encode(mutation_fingerprint_bytes(operation, input)?))
}

fn append_field(transcript: &mut Vec<u8>, value: &[u8]) {
    transcript.extend_from_slice(&(value.len() as u64).to_be_bytes());
    transcript.extend_from_slice(value);
}
