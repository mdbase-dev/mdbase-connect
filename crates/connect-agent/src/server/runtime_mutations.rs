use super::{operation_responses::*, *};

impl AgentState {
    #[allow(clippy::too_many_arguments)]
    pub(super) fn execute_owned_runtime_mutation(
        &self,
        context: &mdbase_connect_protocol::GrantSummary,
        operation: &str,
        input: &serde_json::Value,
        metadata: RelayMetadata<'_>,
        keys: &RelayKeys,
        lease: MutationLease,
        recovery: mdbase_connect_core::MutationRecoveryData,
        revoked: bool,
        cancellation: &mdbase::OperationCancellation,
    ) -> RelayMessage {
        let claim =
            runtime_host_claim(&recovery).unwrap_or_else(mdbase::runtime::HostClaimId::generate);
        if recovery.state != MutationJournalState::Prepared
            && self
                .registry
                .prepare_mutation(
                    &lease,
                    Some(&serde_json::json!({
                        "schema_version": 1,
                        "provider": "mdbase_filesystem_runtime",
                        "host_claim": claim.as_str(),
                        "operation": operation,
                        "collection_id": context.collection_id,
                    })),
                    None,
                )
                .is_err()
        {
            return pending_mutation_response(keys, metadata);
        }

        if revoked {
            match self
                .registry
                .cancel_runtime_host_claim(context.collection_id, &claim)
            {
                Ok(true) => {
                    return abandon_owned_mutation_after_revocation(
                        &self.registry,
                        keys,
                        metadata,
                        &lease,
                    )
                }
                Ok(false) => {}
                Err(_) => return pending_mutation_response(keys, metadata),
            }
        }

        let paused = self.registry.paused().unwrap_or(true);
        let result = if paused {
            Err(ConnectError::AccessDenied(
                "Remote access is paused on this computer.".to_string(),
            ))
        } else {
            self.registry.scoped_operation_with_host_claim(
                context.collection_id,
                operation,
                input,
                &context.scope,
                &claim,
                cancellation,
            )
        };
        if result.is_err() {
            match self
                .registry
                .cancel_runtime_host_claim(context.collection_id, &claim)
            {
                Ok(true) => {}
                Ok(false) | Err(_) => return pending_mutation_response(keys, metadata),
            }
        }
        let (outcome, detail) = match &result {
            Ok(_) => ("succeeded", None),
            Err(error) if paused => ("denied", Some(error.to_string())),
            Err(error) => ("failed", Some(error.to_string())),
        };
        let _ = self.registry.record_activity(
            context.application_id,
            &context.application_name,
            context.collection_id,
            &context.collection_name,
            operation,
            outcome,
            detail.as_deref(),
        );
        let succeeded = result.is_ok();
        let body = match result {
            Ok(result) => serde_json::json!({"ok": true, "result": result}),
            Err(error) => serde_json::json!({
                "ok": false,
                "problem": if paused {
                    ConnectProblem::new("access_paused", error.to_string())
                        .with_operation_outcome(ConnectOperationOutcome::Rejected)
                } else {
                    operation_problem(&error)
                }
            }),
        };
        let Some((message, serialized)) = encrypted_response(keys, metadata, &body) else {
            return encrypted_rejection(metadata.protocol_version, metadata.request_id);
        };
        let result_metadata = match self.registry.externalize_mutation_response(&serialized) {
            Ok(metadata) => metadata,
            Err(_) => return pending_mutation_response(keys, metadata),
        };
        if succeeded {
            if self.watcher.finalize(context.collection_id).is_err() {
                return pending_mutation_response(keys, metadata);
            }
            let evidence = match self
                .registry
                .runtime_host_claim_evidence(context.collection_id, &claim)
            {
                Ok(evidence) => evidence,
                Err(_) => return pending_mutation_response(keys, metadata),
            };
            if self
                .registry
                .mark_mutation_applied(&lease, evidence.as_ref(), Some(&result_metadata))
                .is_err()
            {
                return pending_mutation_response(keys, metadata);
            }
        }
        if self
            .registry
            .complete_mutation(&lease, &serialized, Some(&result_metadata))
            .is_err()
        {
            return pending_mutation_response(keys, metadata);
        }
        let _ = self
            .registry
            .acknowledge_runtime_host_claim(context.collection_id, &claim);
        message
    }
}

pub(super) fn runtime_host_claim(
    recovery: &mdbase_connect_core::MutationRecoveryData,
) -> Option<mdbase::runtime::HostClaimId> {
    recovery
        .prepared_data
        .as_ref()?
        .get("host_claim")
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok())
}
