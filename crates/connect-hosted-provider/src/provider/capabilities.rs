use super::*;
pub(super) fn replica_mode(mode: SyncReplicaMode) -> &'static str {
    match mode {
        SyncReplicaMode::ReadOnly => "read_only",
        SyncReplicaMode::ReadWrite => "read_write",
    }
}

pub(super) fn replica_purpose(purpose: ReplicaPurpose) -> &'static str {
    match purpose {
        ReplicaPurpose::Mirror => "mirror",
        ReplicaPurpose::Application => "application",
    }
}

pub(super) fn verify_hosted_request_proof(
    public_key: &str,
    credential: &str,
    proof: &AuthorityRequestProof,
) -> ApiResult<()> {
    if proof.version != AUTHORITY_PROOF_VERSION {
        return Err(ApiError::unauthorized(
            "invalid_authority_proof",
            "The authority request proof version is unsupported.",
        ));
    }
    if Utc::now().timestamp().abs_diff(proof.timestamp) > 5 * 60 {
        return Err(ApiError::unauthorized(
            "invalid_authority_proof",
            "The authority request proof timestamp is invalid or expired.",
        ));
    }
    if proof.method.is_empty()
        || proof.target.is_empty()
        || [proof.method.as_str(), proof.target.as_str()]
            .iter()
            .any(|value| value.contains('\n') || value.contains('\r'))
    {
        return Err(ApiError::unauthorized(
            "invalid_authority_proof",
            "The authority request proof metadata is invalid.",
        ));
    }
    let verifying_key = proof_verifying_key(public_key).map_err(|_| {
        ApiError::unauthorized(
            "invalid_authority_proof",
            "The authority request proof key is invalid.",
        )
    })?;
    let signature_bytes = decode_base64url(&proof.signature).map_err(|_| {
        ApiError::unauthorized(
            "invalid_authority_proof",
            "The authority request proof signature is invalid.",
        )
    })?;
    let signature = Signature::from_slice(&signature_bytes).map_err(|_| {
        ApiError::unauthorized(
            "invalid_authority_proof",
            "The authority request proof signature is invalid.",
        )
    })?;
    verifying_key
        .verify(
            authority_proof_message(credential, proof).as_bytes(),
            &signature,
        )
        .map_err(|_| {
            ApiError::unauthorized(
                "invalid_authority_proof",
                "The authority request proof signature is invalid.",
            )
        })
}

pub(super) fn authority_proof_message(credential: &str, proof: &AuthorityRequestProof) -> String {
    [
        AUTHORITY_PROOF_DOMAIN.to_string(),
        AUTHORITY_PROOF_VERSION.to_string(),
        proof.method.to_uppercase(),
        proof.target.clone(),
        digest_base64url(&proof.body),
        digest_base64url(credential.as_bytes()),
        proof.timestamp.to_string(),
        proof.nonce.to_string(),
    ]
    .join("\n")
}

pub(super) fn digest_base64url(value: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(value))
}

pub(super) fn decode_base64url(value: &str) -> Result<Vec<u8>, ()> {
    let decoded = URL_SAFE_NO_PAD.decode(value).map_err(|_| ())?;
    if URL_SAFE_NO_PAD.encode(&decoded) != value {
        return Err(());
    }
    Ok(decoded)
}

pub(super) fn proof_verifying_key(value: &str) -> Result<VerifyingKey, ()> {
    let bytes = decode_base64url(value)?;
    if bytes.len() != 65 || bytes[0] != 4 {
        return Err(());
    }
    VerifyingKey::from_sec1_bytes(&bytes).map_err(|_| ())
}

pub(super) fn validate_proof_public_key(value: &str) -> ApiResult<()> {
    proof_verifying_key(value).map(|_| ()).map_err(|_| {
        ApiError::bad_request(
            "invalid_authority_proof_key",
            "Hosted proof keys must be uncompressed P-256 public keys.",
        )
    })
}

pub(super) fn validate_replica_capability(input: &RegisterReplica) -> ApiResult<()> {
    validate_operations(&input.allowed_operations, input.mode)?;
    validate_file_capability(input.file_capability.as_ref(), input.mode)?;
    match input.purpose {
        ReplicaPurpose::Mirror => {
            if !input.allowed_operations.is_empty()
                || input.allowed_origin.is_some()
                || input.proof_public_key.is_some()
                || input.grant_id.is_some()
                || input.full_collection
                || !input.contract_scope.is_empty()
                || input.file_capability.is_some()
            {
                return Err(ApiError::bad_request(
                    "invalid_mirror_capability",
                    "Mirror replicas cannot contain browser application policy.",
                ));
            }
        }
        ReplicaPurpose::Application => {
            if input.allowed_operations.is_empty() && input.file_capability.is_none() {
                return Err(ApiError::bad_request(
                    "invalid_application_capability",
                    "Application capabilities require record operations or file access.",
                ));
            }
            if input.grant_id.is_none() {
                return Err(ApiError::bad_request(
                    "invalid_application_capability",
                    "Application capabilities require a grant.",
                ));
            }
            if input.allowed_operations.is_empty() {
                if input.full_collection
                    || !input.allowed_types.is_empty()
                    || !input.contract_scope.is_empty()
                {
                    return Err(ApiError::bad_request(
                        "invalid_application_scope",
                        "File-only capabilities cannot carry record scope.",
                    ));
                }
            } else {
                validate_collection_scope(
                    input.full_collection,
                    &input.allowed_types,
                    &input.contract_scope,
                    &input.allowed_operations,
                )?;
            }
            if input.proof_public_key.is_some() && input.allowed_origin.is_none() {
                return Err(ApiError::bad_request(
                    "invalid_authority_proof_key",
                    "Hosted proof keys require an exact application origin.",
                ));
            }
            if let Some(origin) = input.allowed_origin.as_deref() {
                if origin == "null" && input.proof_public_key.is_none() {
                    return Err(ApiError::bad_request(
                        "authority_proof_required",
                        "Opaque-origin application capabilities require a proof-of-possession key.",
                    ));
                }
                if origin != "null" {
                    let url = url::Url::parse(origin).map_err(|_| {
                        ApiError::bad_request(
                            "invalid_application_origin",
                            "Application origin must be `null` or an absolute HTTP(S) origin.",
                        )
                    })?;
                    if !matches!(url.scheme(), "http" | "https")
                        || !url.username().is_empty()
                        || url.password().is_some()
                        || url.path() != "/"
                        || url.query().is_some()
                        || url.fragment().is_some()
                        || url.origin().ascii_serialization() != origin
                    {
                        return Err(ApiError::bad_request(
                            "invalid_application_origin",
                            "Application origin must be `null` or a canonical HTTP(S) origin.",
                        ));
                    }
                }
            }
            if let Some(public_key) = input.proof_public_key.as_deref() {
                validate_proof_public_key(public_key)?;
            }
        }
    }
    Ok(())
}

pub(super) fn validate_file_capability(
    capability: Option<&FileCapability>,
    mode: SyncReplicaMode,
) -> ApiResult<()> {
    let Some(capability) = capability else {
        return Ok(());
    };
    if capability.protocol_version != FILE_PROTOCOL_VERSION || capability.actions.is_empty() {
        return Err(ApiError::bad_request(
            "invalid_file_capability",
            "File access requires protocol 1 and at least one action.",
        ));
    }
    let actions = capability.actions.iter().copied().collect::<BTreeSet<_>>();
    if actions.len() != capability.actions.len()
        || (mode == SyncReplicaMode::ReadOnly
            && actions.iter().any(|action| {
                matches!(
                    action,
                    FileAction::Add | FileAction::Replace | FileAction::Move | FileAction::Delete
                )
            }))
    {
        return Err(ApiError::bad_request(
            "invalid_file_capability",
            "File actions must be unique and compatible with the replica mode.",
        ));
    }
    if let FileScope::SelectedFolders { folders } = &capability.scope {
        if folders.is_empty()
            || folders.len() > 100
            || folders
                .iter()
                .any(|folder| !valid_capability_folder(folder))
        {
            return Err(ApiError::bad_request(
                "invalid_file_capability",
                "Selected file folders must be portable collection-relative paths.",
            ));
        }
    }
    Ok(())
}

fn valid_capability_folder(folder: &str) -> bool {
    folder.len() <= 1024 && validate_hosted_file_path(&format!("{folder}/placeholder.bin")).is_ok()
}

pub(super) fn validate_collection_scope(
    full_collection: bool,
    allowed_types: &[String],
    contract_scope: &[CollectionContractDescriptor],
    operations: &[String],
) -> ApiResult<()> {
    if full_collection != allowed_types.is_empty() {
        return Err(ApiError::bad_request(
            "invalid_application_scope",
            "Full collection access requires no type restrictions; contract access requires at least one allowed type.",
        ));
    }
    if full_collection && !contract_scope.is_empty() {
        return Err(ApiError::bad_request(
            "invalid_application_scope",
            "Full collection access must not carry a contract projection.",
        ));
    }
    if !full_collection {
        let expected_types = contract_scope
            .iter()
            .flat_map(|contract| contract.implementations.iter())
            .map(|implementation| implementation.type_name.as_str())
            .collect::<BTreeSet<_>>();
        let actual_types = allowed_types
            .iter()
            .map(String::as_str)
            .collect::<BTreeSet<_>>();
        if contract_scope.is_empty() || expected_types != actual_types {
            return Err(ApiError::bad_request(
                "invalid_application_scope",
                "Contract access requires exact approved contract descriptors whose provider union matches allowed_types.",
            ));
        }
    }
    if !full_collection
        && operations
            .iter()
            .any(|operation| is_full_collection_operation(operation))
    {
        return Err(ApiError::bad_request(
            "invalid_application_scope",
            "Saved views, collection-wide validation, and type definitions require full collection access.",
        ));
    }
    Ok(())
}

pub(super) fn is_full_collection_operation(operation: &str) -> bool {
    matches!(
        operation,
        "validate"
            | "read_type"
            | "create_type"
            | "update_type"
            | "assess_type_pack"
            | "apply_type_pack"
            | "list_views"
            | "execute_view"
            | "read_view_source"
            | "create_view_source"
            | "update_view_source"
            | "delete_view_source"
    )
}

pub(super) fn validate_operations(operations: &[String], mode: SyncReplicaMode) -> ApiResult<()> {
    const OPERATIONS: &[&str] = &[
        "describe",
        "changes",
        "read",
        "query",
        "validate",
        "create",
        "update",
        "delete",
        "rename",
        "read_type",
        "create_type",
        "update_type",
        "assess_type_pack",
        "apply_type_pack",
        "list_views",
        "execute_view",
        "read_view_source",
        "create_view_source",
        "update_view_source",
        "delete_view_source",
        "list_timers",
        "put_timer",
        "cancel_timer",
        "reconcile_timers",
    ];
    const WRITES: &[&str] = &[
        "create",
        "update",
        "delete",
        "rename",
        "create_type",
        "update_type",
        "apply_type_pack",
        "create_view_source",
        "update_view_source",
        "delete_view_source",
        "put_timer",
        "cancel_timer",
        "reconcile_timers",
    ];
    if operations
        .iter()
        .any(|operation| !OPERATIONS.contains(&operation.as_str()))
    {
        return Err(ApiError::bad_request(
            "invalid_replica_operation",
            "Application capabilities contain an unsupported collection operation.",
        ));
    }
    if mode == SyncReplicaMode::ReadOnly
        && operations
            .iter()
            .any(|operation| WRITES.contains(&operation.as_str()))
    {
        return Err(ApiError::bad_request(
            "invalid_application_capability",
            "A read-only application capability cannot contain write operations.",
        ));
    }
    Ok(())
}

pub(super) fn default_authority_transfer_ttl() -> u64 {
    15 * 60
}
