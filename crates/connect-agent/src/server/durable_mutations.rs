use super::{metrics, operation_responses::*, *};

impl AgentState {
    #[allow(clippy::too_many_arguments)]
    pub(super) fn handle_durable_encrypted_mutation(
        &self,
        context: &mdbase_connect_protocol::GrantSummary,
        operation: &str,
        mutation_identifier: &str,
        input: &serde_json::Value,
        metadata: RelayMetadata<'_>,
        keys: &RelayKeys,
        application_installation_id: uuid::Uuid,
        grant_snapshot_digest: String,
        revoked: bool,
        cancellation: &mdbase::OperationCancellation,
        execution_state: &OperationExecutionState,
    ) -> RelayMessage {
        let Some(input_schema_version) = operation_input_schema_version(operation, input) else {
            return encrypted_problem_response(
                keys,
                metadata,
                ConnectProblem::new(
                    "invalid_request",
                    "The mutation input schema version is not defined.",
                )
                .with_operation_outcome(ConnectOperationOutcome::Rejected),
            );
        };
        let Ok(input_digest) = mutation_fingerprint(operation, input) else {
            return encrypted_problem_response(
                keys,
                metadata,
                ConnectProblem::new(
                    "invalid_request",
                    "The mutation input is not canonical I-JSON.",
                )
                .with_operation_outcome(ConnectOperationOutcome::Rejected),
            );
        };
        // The timeout and worker race at one atomic boundary. If timeout wins,
        // this request is provably not sent. If the durable transition wins,
        // the caller must recover by replaying the exact request identity.
        if !execution_state.begin_durable_mutation() {
            return encrypted_problem_response(
                keys,
                metadata,
                ConnectProblem::new(
                    "operation_cancelled",
                    "The operation was cancelled before its durable mutation was claimed.",
                )
                .with_operation_outcome(ConnectOperationOutcome::NotSent),
            );
        }
        let claim_request = MutationClaimRequest {
            application_installation_id,
            grant_id: context.id,
            request_id: metadata.request_id,
            operation_kind: mutation_identifier.to_string(),
            input_schema_version,
            input_digest,
            grant_snapshot_digest,
            allow_new: !revoked,
        };

        let mut claim = match self.registry.claim_mutation(&claim_request) {
            Ok(claim) => claim,
            Err(ConnectError::AccessDenied(message)) if revoked => {
                return encrypted_problem_response(
                    keys,
                    metadata,
                    ConnectProblem::new("access_denied", message)
                        .with_details(serde_json::json!({ "request_id": metadata.request_id }))
                        .with_operation_outcome(ConnectOperationOutcome::NotSent),
                )
            }
            Err(error) => {
                metrics::claim_error(mutation_identifier, &error);
                return encrypted_problem_response(keys, metadata, operation_problem(&error));
            }
        };
        for _ in 0..1_000 {
            match claim {
                MutationClaim::Terminal { state, receipt } => {
                    metrics::duplicate_replay(mutation_identifier, state);
                    return serialized_encrypted_response(
                        &receipt,
                        metadata.protocol_version,
                        metadata.request_id,
                    );
                }
                MutationClaim::Owned { lease, recovery } => {
                    if lease.fencing_generation > 1 {
                        metrics::lease_takeover(mutation_identifier, recovery.state);
                    }
                    return self.execute_owned_mutation(
                        context,
                        operation,
                        mutation_identifier,
                        input,
                        metadata,
                        keys,
                        lease,
                        *recovery,
                        revoked,
                        cancellation,
                    );
                }
                MutationClaim::Live { .. } => {
                    std::thread::sleep(std::time::Duration::from_millis(25));
                    claim = match self.registry.claim_mutation(&claim_request) {
                        Ok(claim) => claim,
                        Err(error) => {
                            return encrypted_problem_response(
                                keys,
                                metadata,
                                operation_problem(&error),
                            )
                        }
                    };
                }
            }
        }
        pending_mutation_response(keys, metadata)
    }
}
