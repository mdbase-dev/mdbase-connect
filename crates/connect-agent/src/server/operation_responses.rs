use super::*;

pub(super) fn encrypted_response(
    keys: &RelayKeys,
    metadata: RelayMetadata<'_>,
    body: &serde_json::Value,
) -> Option<(RelayMessage, String)> {
    let ciphertext = keys
        .encrypt_json(RelayDirection::Response, metadata, body)
        .ok()?;
    let response_envelope = metadata.envelope(ciphertext);
    let serialized = serde_json::to_string(&response_envelope).ok()?;
    Some((
        RelayMessage::EncryptedOperationResponse {
            envelope: response_envelope,
        },
        serialized,
    ))
}

pub(super) fn encrypted_problem_response(
    keys: &RelayKeys,
    metadata: RelayMetadata<'_>,
    problem: ConnectProblem,
) -> RelayMessage {
    encrypted_response(
        keys,
        metadata,
        &serde_json::json!({ "ok": false, "problem": problem }),
    )
    .map_or_else(
        || encrypted_rejection(metadata.request_id),
        |(message, _)| message,
    )
}

pub(super) fn pending_mutation_response(
    keys: &RelayKeys,
    metadata: RelayMetadata<'_>,
) -> RelayMessage {
    encrypted_problem_response(
        keys,
        metadata,
        ConnectProblem::new(
            "pending_mutation_unresolved",
            "The authority accepted this mutation and is still recovering its durable receipt.",
        )
        .with_details(serde_json::json!({ "request_id": metadata.request_id })),
    )
}

pub(super) fn serialized_encrypted_response(
    serialized: &str,
    request_id: uuid::Uuid,
) -> RelayMessage {
    serde_json::from_str(serialized).map_or_else(
        |_| encrypted_rejection(request_id),
        |envelope| RelayMessage::EncryptedOperationResponse { envelope },
    )
}

pub(super) fn operation_problem(error: &ConnectError) -> ConnectProblem {
    if let ConnectError::MutationRequestConflict { request_id } = error {
        return ConnectProblem::new(error.code(), error.to_string())
            .with_details(serde_json::json!({ "request_id": request_id }))
            .with_operation_outcome(ConnectOperationOutcome::Rejected);
    }
    if let ConnectError::MutationRecoveryExpired { request_id } = error {
        return ConnectProblem::new(error.code(), error.to_string())
            .with_details(serde_json::json!({ "request_id": request_id }));
    }
    if let ConnectError::CollectionInvalid {
        code, diagnostics, ..
    } = error
    {
        return ConnectProblem::new(code, error.to_string())
            .with_details(serde_json::json!({ "diagnostics": diagnostics }))
            .with_operation_outcome(ConnectOperationOutcome::Rejected);
    }
    if matches!(
        error,
        ConnectError::Provider(mdbase::runtime::ProviderError::CollectionOpen(_))
    ) {
        return collection_setup_problem("collection_invalid", error);
    }
    if matches!(error, ConnectError::Config(_) | ConnectError::Settings(_)) {
        return collection_setup_problem("collection_configuration_invalid", error);
    }
    let code = match error.code() {
        "invalid_input" | "invalid_timer_request" => "invalid_request",
        "collection_provider_failed"
        | "io_failed"
        | "registry_failed"
        | "serialization_failed"
        | "timer_runtime_failed" => "operation_failed",
        code => code,
    };
    ConnectProblem::new(code, error.to_string())
        .with_operation_outcome(ConnectOperationOutcome::Rejected)
}

fn collection_setup_problem(code: &str, error: &ConnectError) -> ConnectProblem {
    ConnectProblem::new(code, error.to_string())
        .with_details(serde_json::json!({
            "diagnostics": [{
                "severity": "error",
                "code": error.code(),
                "message": error.to_string()
            }]
        }))
        .with_operation_outcome(ConnectOperationOutcome::Rejected)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collection_diagnostics_cross_the_connector_boundary() {
        let diagnostics = vec![serde_json::json!({
            "severity": "error",
            "code": "invalid_type_definition",
            "message": "Type frontmatter is invalid.",
            "path": "_types/task.md"
        })];
        let problem = operation_problem(&ConnectError::CollectionInvalid {
            code: "collection_type_registry_invalid".to_string(),
            message: "Type frontmatter is invalid.".to_string(),
            diagnostics: diagnostics.clone(),
        });

        assert_eq!(problem.code, "collection_type_registry_invalid");
        assert_eq!(
            problem.recovery,
            mdbase_connect_protocol::ConnectRecoveryAction::RepairCollection
        );
        assert_eq!(
            problem.details,
            Some(serde_json::json!({ "diagnostics": diagnostics }))
        );
        assert_eq!(
            problem.operation_outcome,
            Some(ConnectOperationOutcome::Rejected)
        );
    }
}
