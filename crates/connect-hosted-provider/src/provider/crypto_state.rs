use super::*;
pub(super) fn optional_encrypted_record(
    crypto: &ProviderCrypto,
    data_key: &[u8; 32],
    value: Option<&[u8]>,
    aad: &[u8],
) -> ApiResult<Option<SyncRecord>> {
    value
        .map(|value| crypto.decrypt_json(data_key, value, aad))
        .transpose()
}

pub(super) fn collection_key_aad(collection_id: Uuid) -> Vec<u8> {
    aad(("collection_key", collection_id))
}

pub(super) fn resources_aad(collection_id: Uuid) -> Vec<u8> {
    aad(("resources", collection_id))
}

pub(super) fn resource_document_aad(collection_id: Uuid, path: &str) -> Vec<u8> {
    aad(("resource_document", collection_id, path))
}

pub(super) fn current_record_aad(collection_id: Uuid, record_id: Uuid, sequence: u64) -> Vec<u8> {
    aad(("current_record", collection_id, record_id, sequence))
}

pub(super) fn record_version_aad(collection_id: Uuid, record_id: Uuid, sequence: u64) -> Vec<u8> {
    aad(("record_version", collection_id, record_id, sequence))
}

pub(super) fn change_record_aad(collection_id: Uuid, sequence: u64, side: &str) -> Vec<u8> {
    aad(("change_record", collection_id, sequence, side))
}

pub(super) fn receipt_aad(replica_id: Uuid, mutation_id: Uuid) -> Vec<u8> {
    aad(("mutation_receipt", replica_id, mutation_id))
}

pub(super) fn current_file_aad(collection_id: Uuid, file_id: Uuid, sequence: u64) -> Vec<u8> {
    aad(("current_file", collection_id, file_id, sequence))
}

pub(super) fn file_version_aad(collection_id: Uuid, file_id: Uuid, sequence: u64) -> Vec<u8> {
    aad(("file_version", collection_id, file_id, sequence))
}

pub(super) fn change_file_aad(collection_id: Uuid, sequence: u64, side: &str) -> Vec<u8> {
    aad(("change_file", collection_id, sequence, side))
}

pub(super) fn file_transfer_intent_aad(transfer_id: Uuid) -> Vec<u8> {
    aad(("file_transfer_intent", transfer_id))
}

pub(super) fn file_transfer_receipt_aad(transfer_id: Uuid) -> Vec<u8> {
    aad(("file_transfer_receipt", transfer_id))
}

pub(super) fn file_mutation_request_aad(mutation_id: Uuid) -> Vec<u8> {
    aad(("file_mutation_request", mutation_id))
}

pub(super) fn file_mutation_receipt_aad(mutation_id: Uuid) -> Vec<u8> {
    aad(("file_mutation_receipt", mutation_id))
}

pub(super) fn authority_import_manifest_aad(import_id: Uuid) -> Vec<u8> {
    aad(("authority_import_manifest", import_id))
}

pub(super) fn authority_import_record_aad(import_id: Uuid, record_id: Uuid) -> Vec<u8> {
    aad(("authority_import_record", import_id, record_id))
}

pub(super) fn authority_import_file_intent_aad(transfer_id: Uuid) -> Vec<u8> {
    aad(("authority_import_file_intent", transfer_id))
}

pub(super) fn aad(value: impl Serialize) -> Vec<u8> {
    serde_json::to_vec(&value).expect("hosted ciphertext identity serializes")
}

pub(super) fn constant_time_text_equal(expected: &str, candidate: &str) -> bool {
    expected.len() == candidate.len() && bool::from(expected.as_bytes().ct_eq(candidate.as_bytes()))
}

pub(super) fn token_hash(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

pub(super) fn path_token(data_key: &[u8; 32], path: &str) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(data_key)
        .expect("a 256-bit collection key is a valid HMAC key");
    mac.update(b"mdbase-connect/hosted-path/v1\0");
    mac.update(path.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

pub(super) fn mutation_hash(mutation: &SyncMutation) -> ApiResult<Vec<u8>> {
    let bytes = serde_jcs::to_vec(mutation).map_err(|error| {
        ApiError::internal(format!("Hosted mutation could not serialize: {error}"))
    })?;
    Ok(Sha256::digest(bytes).to_vec())
}

pub(super) fn operation_request_hash(operation: &str, input: &Value) -> ApiResult<Vec<u8>> {
    let bytes = serde_jcs::to_vec(&json!({
        "operation": operation,
        "input": input,
    }))
    .map_err(|error| {
        ApiError::internal(format!(
            "Hosted operation request could not serialize: {error}"
        ))
    })?;
    Ok(Sha256::digest(bytes).to_vec())
}

pub(super) fn operation_prepared_aad(replica_id: Uuid, request_id: Uuid) -> Vec<u8> {
    format!("hosted-provider/operation-prepared/v1/{replica_id}/{request_id}").into_bytes()
}

pub(super) fn operation_response_aad(replica_id: Uuid, request_id: Uuid) -> Vec<u8> {
    format!("hosted-provider/operation-response/v1/{replica_id}/{request_id}").into_bytes()
}

pub(super) fn number(value: i64, name: &'static str) -> ApiResult<u64> {
    value
        .try_into()
        .map_err(|_| ApiError::internal(format!("Stored {name} is outside the supported range.")))
}

pub(super) fn to_i64(value: u64, name: &'static str) -> ApiResult<i64> {
    value
        .try_into()
        .map_err(|_| ApiError::bad_request("numeric_range", format!("{name} is too large.")))
}
