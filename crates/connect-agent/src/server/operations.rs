use super::{metrics, operation_responses::*, *};
impl AgentState {
    pub(super) fn local_operation(
        &self,
        collection_id: uuid::Uuid,
        operation: &str,
        input: &serde_json::Value,
    ) -> Result<serde_json::Value, ConnectError> {
        let started = Instant::now();
        let synchronize_us = std::cell::Cell::new(0_u64);
        let result =
            self.registry
                .operation_synchronized(collection_id, operation, input, |invalidation| {
                    let synchronize_started = Instant::now();
                    self.watcher.synchronize(collection_id, invalidation);
                    synchronize_us.set(elapsed_us(synchronize_started));
                });
        profile_operation("control", operation, started, synchronize_us.get(), &result);
        result
    }

    pub fn handle_direct_encrypted_operation(
        &self,
        origin: &str,
        envelope: mdbase_connect_protocol::EncryptedRelayEnvelope,
    ) -> RelayMessage {
        let origin_matches = self
            .registry
            .grant_replay_context(envelope.grant_id, &envelope.key_id)
            .ok()
            .flatten()
            .is_some_and(|context| context.grant.application_origin == origin);
        if !origin_matches {
            return encrypted_rejection(envelope.protocol_version, envelope.request_id);
        }
        metrics::direct_operation_transport(envelope.protocol_version);
        self.handle_encrypted_operation(envelope)
    }

    pub fn handle_relay_message(&self, message: RelayMessage) -> Option<RelayMessage> {
        match message {
            RelayMessage::PolicySnapshot {
                protocol_version,
                request_id,
                revision,
                grants,
            } => {
                if protocol_version != CONTROL_PROTOCOL_VERSION {
                    return Some(RelayMessage::PolicyApplied {
                        protocol_version: CONTROL_PROTOCOL_VERSION,
                        request_id,
                        revision,
                        ok: false,
                        error: Some(ControlError {
                            code: "unsupported_protocol_version".to_string(),
                            message: format!(
                                "Relay protocol {protocol_version} is unsupported; expected {}.",
                                CONTROL_PROTOCOL_VERSION
                            ),
                            details: None,
                        }),
                    });
                }
                match self.registry.replace_grants_at_revision(&revision, &grants) {
                    Ok(()) => {
                        tracing::debug!(grants = grants.len(), %revision, "relay policy snapshot applied");
                        Some(RelayMessage::PolicyApplied {
                            protocol_version: CONTROL_PROTOCOL_VERSION,
                            request_id,
                            revision,
                            ok: true,
                            error: None,
                        })
                    }
                    Err(error) => {
                        tracing::error!(%error, %revision, "failed to apply relay policy snapshot");
                        Some(RelayMessage::PolicyApplied {
                            protocol_version: CONTROL_PROTOCOL_VERSION,
                            request_id,
                            revision,
                            ok: false,
                            error: Some(ControlError {
                                code: error.code().to_string(),
                                message: error.to_string(),
                                details: None,
                            }),
                        })
                    }
                }
            }
            RelayMessage::AuthorizationOfferRequest {
                request_id,
                requirements,
                provisions,
                ..
            } => {
                let paused = self.registry.paused().unwrap_or(true);
                let collections = if paused {
                    Vec::new()
                } else {
                    self.registry
                        .list()
                        .unwrap_or_default()
                        .into_iter()
                        .filter(|collection| collection.enabled)
                        .filter_map(|collection| {
                            let mut description = self.registry.describe(collection.id).ok()?;
                            let types = if requirements_can_be_provisioned(
                                &requirements,
                                &provisions,
                                &description.contracts,
                            ) {
                                description
                                    .types
                                    .drain(..)
                                    .filter_map(approval_type_candidate)
                                    .collect()
                            } else {
                                Vec::new()
                            };
                            Some(AuthorizationCollectionOffer {
                                collection_id: collection.id,
                                display_name: description.display_name,
                                spec_version: description.spec_version,
                                contracts: description.contracts,
                                types,
                            })
                        })
                        .collect()
                };
                Some(RelayMessage::AuthorizationOfferResponse {
                    protocol_version: CONTROL_PROTOCOL_VERSION,
                    request_id,
                    paused,
                    collections,
                })
            }
            RelayMessage::AuthorizationActivationRequest {
                request_id,
                authorization_id,
                application_declaration_id,
                application_manifest_digest,
                collection_id,
                requirements,
                provisions,
                contract_setups,
                mut grant,
                ..
            } => {
                if let Err(error) = self.validate_activation_authorization(
                    authorization_id,
                    &application_declaration_id,
                    &application_manifest_digest,
                    &grant,
                ) {
                    return Some(RelayMessage::AuthorizationActivationResponse {
                        protocol_version: CONTROL_PROTOCOL_VERSION,
                        request_id,
                        ok: false,
                        contracts: Vec::new(),
                        contract_setups: Vec::new(),
                        setup_assessment: None,
                        provision_receipt: None,
                        error: Some(ControlError {
                            code: error.code().to_string(),
                            message: error.to_string(),
                            details: error.details(),
                        }),
                    });
                }
                let result = (|| {
                    if self.registry.paused()? {
                        return Err(ConnectError::AccessDenied(
                            "Remote access is paused on this computer.".to_string(),
                        ));
                    }
                    if grant.collection_id != collection_id {
                        return Err(ConnectError::AccessDenied(
                            "The proposed grant names a different collection.".to_string(),
                        ));
                    }
                    if grant.scope.access
                        != requirements.access.unwrap_or(ApplicationAccess::Contract)
                    {
                        return Err(ConnectError::AccessDenied(
                            "The proposed grant scope does not match the application request."
                                .to_string(),
                        ));
                    }
                    let registered = self.registry.get(collection_id)?;
                    if !registered.enabled {
                        return Err(ConnectError::AccessDenied(
                            "This collection is disabled on its computer.".to_string(),
                        ));
                    }
                    let before = self.registry.describe(collection_id)?;
                    if let Some(operation) = grant
                        .operations
                        .iter()
                        .find(|operation| !before.operations.contains(operation))
                    {
                        return Err(ConnectError::AccessDenied(format!(
                            "{} does not support the requested {operation} operation.",
                            before.display_name
                        )));
                    }
                    // Authorization is not itself a collection mutation. Only enter the
                    // setup transaction when a declared requirement is not yet satisfied.
                    let needs_setup = !requirements.configuration.is_empty()
                        || requirements.contracts.iter().any(|required| {
                            !before.contracts.iter().any(|available| {
                                available.id == required.id
                                    && available.version == required.version
                                    && available.digest == required.digest
                            })
                        });
                    if !needs_setup && !contract_setups.is_empty() {
                        return Err(ConnectError::InvalidInput(
                            "Contract setup choices were provided when no collection setup was required."
                                .to_string(),
                        ));
                    }
                    let (contracts, setup_assessment, provision_receipt) = if needs_setup {
                        let setup = self.registry.provision_application_setup(
                            collection_id,
                            &application_declaration_id,
                            &super::account::engine_declaration_digest(
                                &application_manifest_digest,
                            )?,
                            &requirements,
                            &provisions,
                            &contract_setups,
                        )?;
                        (setup.contracts, Some(setup.assessment), Some(setup.receipt))
                    } else {
                        (before.contracts.clone(), None, None)
                    };
                    grant.scope.contracts =
                        if grant.scope.access == ApplicationAccess::FullCollection {
                            Vec::new()
                        } else {
                            contracts
                                .iter()
                                .filter(|available| {
                                    requirements.contracts.iter().any(|required| {
                                        available.id == required.id
                                            && available.version == required.version
                                            && available.digest == required.digest
                                    })
                                })
                                .cloned()
                                .collect()
                        };
                    self.watcher.rescan(collection_id);
                    self.registry.upsert_grant(&grant)?;
                    Ok((contracts, setup_assessment, provision_receipt))
                })();
                Some(match result {
                    Ok((contracts, setup_assessment, provision_receipt)) => {
                        RelayMessage::AuthorizationActivationResponse {
                            protocol_version: CONTROL_PROTOCOL_VERSION,
                            request_id,
                            ok: true,
                            contracts,
                            contract_setups: if setup_assessment.is_some() {
                                contract_setups.clone()
                            } else {
                                Vec::new()
                            },
                            setup_assessment,
                            provision_receipt,
                            error: None,
                        }
                    }
                    Err(error) => RelayMessage::AuthorizationActivationResponse {
                        protocol_version: CONTROL_PROTOCOL_VERSION,
                        request_id,
                        ok: false,
                        contracts: Vec::new(),
                        contract_setups: Vec::new(),
                        setup_assessment: None,
                        provision_receipt: None,
                        error: Some(ControlError {
                            code: error.code().to_string(),
                            message: error.to_string(),
                            details: error.details(),
                        }),
                    },
                })
            }
            RelayMessage::OperationRequest {
                protocol_version,
                request_id,
                grant_id,
                collection_id,
                application_id,
                operation,
                input,
            } => {
                if !mdbase_connect_protocol::SUPPORTED_OPERATION_TRANSPORT_PROTOCOL_VERSIONS
                    .contains(&protocol_version)
                {
                    return Some(operation_transport_rejection(
                        request_id,
                        protocol_version,
                        &operation,
                    ));
                }
                let context = self.registry.grant_context(grant_id).ok().flatten();
                if context.as_ref().is_some_and(|grant| {
                    !grant
                        .contracts
                        .permits_operation_transport(protocol_version, false)
                }) {
                    return Some(operation_transport_rejection(
                        request_id,
                        protocol_version,
                        &operation,
                    ));
                }
                let application_name = context
                    .as_ref()
                    .map(|grant| grant.application_name.as_str())
                    .unwrap_or("Unknown application");
                let collection_name = context
                    .as_ref()
                    .map(|grant| grant.collection_name.as_str())
                    .unwrap_or("Unknown collection");
                if context
                    .as_ref()
                    .is_some_and(|grant| grant.encryption.is_some())
                {
                    return Some(RelayMessage::OperationResponse {
                        protocol_version,
                        request_id,
                        ok: false,
                        result: None,
                        problem: Some(
                            ConnectProblem::new(
                                "encryption_required",
                                "This grant requires grant encryption profile 1.",
                            )
                            .with_operation_outcome(ConnectOperationOutcome::Rejected),
                        ),
                    });
                }
                if self.registry.paused().unwrap_or(true) {
                    let _ = self.registry.record_activity(
                        application_id,
                        application_name,
                        collection_id,
                        collection_name,
                        &operation,
                        "denied",
                        Some("Remote access is paused"),
                    );
                    return Some(RelayMessage::OperationResponse {
                        protocol_version,
                        request_id,
                        ok: false,
                        result: None,
                        problem: Some(
                            ConnectProblem::new(
                                "access_paused",
                                "Remote access is paused on this computer.",
                            )
                            .with_operation_outcome(ConnectOperationOutcome::Rejected),
                        ),
                    });
                }
                let authorized = context.as_ref().is_some_and(|grant| {
                    grant.application_id == application_id
                        && grant.collection_id == collection_id
                        && grant.operations.iter().any(|allowed| allowed == &operation)
                });
                let result = if authorized {
                    self.scoped_operation(
                        "relay",
                        collection_id,
                        &operation,
                        &input,
                        context.as_ref().expect("authorized grant must exist"),
                    )
                } else {
                    let _ = self.registry.record_activity(
                        application_id,
                        application_name,
                        collection_id,
                        collection_name,
                        &operation,
                        "denied",
                        Some("Local grant did not allow this operation"),
                    );
                    return Some(RelayMessage::OperationResponse {
                        protocol_version,
                        request_id,
                        ok: false,
                        result: None,
                        problem: Some(
                            ConnectProblem::new(
                                "access_denied",
                                "The local connector policy does not allow this request.",
                            )
                            .with_operation_outcome(ConnectOperationOutcome::Rejected),
                        ),
                    });
                };
                let (outcome, detail) = match &result {
                    Ok(_) => ("succeeded", None),
                    Err(error) => ("failed", Some(error.to_string())),
                };
                let _ = self.registry.record_activity(
                    application_id,
                    application_name,
                    collection_id,
                    collection_name,
                    &operation,
                    outcome,
                    detail.as_deref(),
                );
                Some(match result {
                    Ok(result) => RelayMessage::OperationResponse {
                        protocol_version,
                        request_id,
                        ok: true,
                        result: Some(result),
                        problem: None,
                    },
                    Err(error) => RelayMessage::OperationResponse {
                        protocol_version,
                        request_id,
                        ok: false,
                        result: None,
                        problem: Some(operation_problem(&error)),
                    },
                })
            }
            RelayMessage::EncryptedOperationRequest { envelope } => {
                Some(self.handle_encrypted_operation(envelope))
            }
            RelayMessage::RelayHello { .. }
            | RelayMessage::RelayWelcome { .. }
            | RelayMessage::RelayIncompatible { .. }
            | RelayMessage::PolicyApplied { .. }
            | RelayMessage::OperationResponse { .. }
            | RelayMessage::AuthorizationOfferResponse { .. }
            | RelayMessage::AuthorizationActivationResponse { .. }
            | RelayMessage::EncryptedOperationResponse { .. }
            | RelayMessage::EncryptedOperationRejected { .. }
            | RelayMessage::ProtocolUsageReport { .. } => None,
        }
    }

    fn handle_encrypted_operation(
        &self,
        envelope: mdbase_connect_protocol::EncryptedRelayEnvelope,
    ) -> RelayMessage {
        if !mdbase_connect_protocol::SUPPORTED_OPERATION_TRANSPORT_PROTOCOL_VERSIONS
            .contains(&envelope.protocol_version)
        {
            return encrypted_operation_transport_rejection(&envelope);
        }
        let rejected = || encrypted_rejection(envelope.protocol_version, envelope.request_id);
        let Some(replay_context) = self
            .registry
            .grant_replay_context(envelope.grant_id, &envelope.key_id)
            .ok()
            .flatten()
        else {
            return rejected();
        };
        let revoked = replay_context.revoked;
        let application_installation_id = replay_context.application_installation_id;
        let grant_snapshot_digest = replay_context.grant_snapshot_digest.clone();
        let context = replay_context.grant;
        if !context
            .contracts
            .permits_operation_transport(envelope.protocol_version, false)
        {
            return rejected();
        }
        let Some(encryption) = context.encryption.as_ref() else {
            return rejected();
        };
        let binding = RelayBinding::from_grant(context.id, context.application_id, encryption);
        let file_control = envelope.operation == "file_control";
        let operation_allowed = if file_control {
            context.file_capability.is_some()
        } else {
            context
                .operations
                .iter()
                .any(|allowed| allowed == &envelope.operation)
        };
        if validate_envelope(&envelope, &binding).is_err()
            || context.collection_id != envelope.collection_id
            || !operation_allowed
        {
            return rejected();
        }
        let metadata = RelayMetadata {
            binding: &binding,
            protocol_version: envelope.protocol_version,
            request_id: envelope.request_id,
            operation: &envelope.operation,
            counter: &envelope.counter,
        };
        let Ok(keys) = self.relay_identity.derive_for_protocol(
            &encryption.application_agreement_public_key,
            &binding,
            envelope.protocol_version,
        ) else {
            return rejected();
        };

        // Authenticate before touching durable replay state. JSON is decoded only after the
        // counter and request ID have been accepted atomically.
        let Ok(plaintext) =
            keys.decrypt_bytes(RelayDirection::Request, metadata, &envelope.ciphertext)
        else {
            return rejected();
        };
        let Ok(counter) = parse_counter(&envelope.counter) else {
            return rejected();
        };
        let Ok(input) = serde_json::from_slice::<serde_json::Value>(&plaintext) else {
            return rejected();
        };
        if let Some(problem) =
            context
                .contracts
                .mismatch_problem(&envelope.operation, &input, "connector")
        {
            return encrypted_problem_response(&keys, metadata, problem);
        }
        let Ok(fingerprint) = encrypted_request_fingerprint(&envelope) else {
            return rejected();
        };
        let mutation =
            mutation_operation_identifier(&envelope.operation, &input).map(str::to_owned);
        match self.registry.claim_encrypted_request(
            context.id,
            &encryption.key_id,
            &envelope.operation,
            if mutation.is_some() {
                EncryptedReplayClass::Mutation
            } else {
                EncryptedReplayClass::Read
            },
            counter,
            envelope.request_id,
            &fingerprint,
            envelope.protocol_version,
        ) {
            Ok(EncryptedRequestClaim::Fresh) => {}
            Ok(EncryptedRequestClaim::Completed(response)) => {
                return serde_json::from_str(&response).map_or_else(
                    |_| rejected(),
                    |envelope| RelayMessage::EncryptedOperationResponse { envelope },
                );
            }
            Ok(EncryptedRequestClaim::InProgress) if mutation.is_none() => {
                for _ in 0..1_000 {
                    std::thread::sleep(std::time::Duration::from_millis(25));
                    match self.registry.encrypted_request_response(
                        context.id,
                        &encryption.key_id,
                        envelope.request_id,
                        &fingerprint,
                    ) {
                        Ok(Some(response)) => {
                            return serde_json::from_str(&response).map_or_else(
                                |_| rejected(),
                                |envelope| RelayMessage::EncryptedOperationResponse { envelope },
                            );
                        }
                        Ok(None) => {}
                        Err(_) => return rejected(),
                    }
                }
                return rejected();
            }
            Ok(EncryptedRequestClaim::InProgress) => {}
            Ok(EncryptedRequestClaim::FreshRequired) if mutation.is_none() => {
                return RelayMessage::EncryptedOperationRejected {
                    protocol_version: envelope.protocol_version,
                    request_id: envelope.request_id,
                    problem: ConnectProblem::new(
                        "fresh_request_required",
                        "The previous read receipt is no longer available; retry with a fresh request ID and counter.",
                    )
                    .with_operation_outcome(ConnectOperationOutcome::NotSent),
                }
            }
            Ok(EncryptedRequestClaim::FreshRequired) => return rejected(),
            Ok(EncryptedRequestClaim::Conflict) if mutation.is_some() => {
                return encrypted_problem_response(
                    &keys,
                    metadata,
                    ConnectProblem::new(
                        "mutation_request_conflict",
                        "This request ID was already bound to different mutation input.",
                    )
                    .with_details(serde_json::json!({ "request_id": envelope.request_id }))
                    .with_operation_outcome(ConnectOperationOutcome::Rejected),
                )
            }
            Ok(EncryptedRequestClaim::Conflict) => return rejected(),
            Err(ConnectError::EncryptedRelayRejected) => return rejected(),
            Err(error) => {
                if matches!(error, ConnectError::AccessPaused | ConnectError::AccessDenied(_)) {
                    let _ = self.registry.record_activity(
                        context.application_id,
                        &context.application_name,
                        context.collection_id,
                        &context.collection_name,
                        &envelope.operation,
                        "denied",
                        Some(&error.to_string()),
                    );
                }
                return encrypted_problem_response(
                    &keys,
                    metadata,
                    operation_problem(&error)
                        .with_operation_outcome(ConnectOperationOutcome::NotSent),
                )
            }
        }

        if let Some(mutation_identifier) = mutation {
            return self.handle_durable_encrypted_mutation(
                &context,
                &envelope.operation,
                &mutation_identifier,
                &input,
                metadata,
                &keys,
                application_installation_id,
                grant_snapshot_digest,
                revoked,
            );
        }

        let paused = self.registry.paused().unwrap_or(true);
        let result = if revoked {
            Err(ConnectError::AccessDenied(
                "This grant has been revoked.".to_string(),
            ))
        } else if paused {
            Err(ConnectError::AccessDenied(
                "Remote access is paused on this computer.".to_string(),
            ))
        } else if file_control {
            self.file_control(&context, input)
        } else {
            self.scoped_operation(
                "encrypted",
                context.collection_id,
                &envelope.operation,
                &input,
                &context,
            )
        };
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
            &envelope.operation,
            outcome,
            detail.as_deref(),
        );
        let body = match result {
            Ok(result) => serde_json::json!({ "ok": true, "result": result }),
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
        let Ok(ciphertext) = keys.encrypt_json(RelayDirection::Response, metadata, &body) else {
            return rejected();
        };
        let response_envelope = metadata.envelope(ciphertext);
        let Ok(serialized_response) = serde_json::to_string(&response_envelope) else {
            return rejected();
        };
        if self
            .registry
            .complete_encrypted_request(
                context.id,
                &encryption.key_id,
                envelope.request_id,
                &fingerprint,
                &serialized_response,
                envelope.protocol_version,
            )
            .is_err()
        {
            return rejected();
        }
        RelayMessage::EncryptedOperationResponse {
            envelope: response_envelope,
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn handle_durable_encrypted_mutation(
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
                        context, operation, input, metadata, keys, lease, *recovery, revoked,
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

    #[allow(clippy::too_many_arguments)]
    fn execute_owned_mutation(
        &self,
        context: &mdbase_connect_protocol::GrantSummary,
        operation: &str,
        input: &serde_json::Value,
        metadata: RelayMetadata<'_>,
        keys: &RelayKeys,
        lease: MutationLease,
        recovery: mdbase_connect_core::MutationRecoveryData,
        revoked: bool,
    ) -> RelayMessage {
        if recovery.state == MutationJournalState::Applied {
            let Some(result_metadata) = recovery.result_metadata.as_ref() else {
                return mark_owned_mutation_unknown(
                    &self.registry,
                    keys,
                    metadata,
                    &lease,
                    "Applied mutation evidence has no recoverable encrypted receipt.",
                );
            };
            let Ok(Some(receipt)) = self
                .registry
                .mutation_response_from_metadata(result_metadata)
            else {
                return mark_owned_mutation_unknown(
                    &self.registry,
                    keys,
                    metadata,
                    &lease,
                    "Applied mutation evidence references an unavailable encrypted receipt.",
                );
            };
            if self
                .registry
                .complete_mutation(&lease, &receipt, recovery.result_metadata.as_ref())
                .is_err()
            {
                return pending_mutation_response(keys, metadata);
            }
            return serialized_encrypted_response(
                &receipt,
                metadata.protocol_version,
                metadata.request_id,
            );
        }

        let before = match local_mutation_evidence(&self.registry, context.collection_id, operation)
        {
            Ok(evidence) => evidence,
            Err(error) => {
                let body = serde_json::json!({
                    "ok": false,
                    "problem": operation_problem(&error),
                });
                let Some((message, serialized)) = encrypted_response(keys, metadata, &body) else {
                    return encrypted_rejection(metadata.protocol_version, metadata.request_id);
                };
                if self
                    .registry
                    .complete_mutation(&lease, &serialized, Some(&body))
                    .is_err()
                {
                    return pending_mutation_response(keys, metadata);
                }
                return message;
            }
        };

        if recovery.state == MutationJournalState::Prepared
            && recovery.before_evidence.as_ref() != Some(&before)
        {
            return mark_owned_mutation_unknown(
                &self.registry,
                keys,
                metadata,
                &lease,
                "The collection changed after preparation and the exact mutation outcome cannot be distinguished.",
            );
        }
        if revoked {
            return abandon_owned_mutation_after_revocation(&self.registry, keys, metadata, &lease);
        }
        if recovery.state != MutationJournalState::Prepared
            && self
                .registry
                .prepare_mutation(
                    &lease,
                    Some(&serde_json::json!({
                        "operation": operation,
                        "collection_id": context.collection_id,
                    })),
                    Some(&before),
                )
                .is_err()
        {
            return pending_mutation_response(keys, metadata);
        }

        let paused = self.registry.paused().unwrap_or(true);
        let result = if paused {
            Err(ConnectError::AccessDenied(
                "Remote access is paused on this computer.".to_string(),
            ))
        } else if operation == "file_control" {
            self.file_control(context, input.clone())
        } else {
            self.scoped_operation(
                "encrypted",
                context.collection_id,
                operation,
                input,
                context,
            )
        };
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
            Ok(result) => serde_json::json!({ "ok": true, "result": result }),
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
            let after =
                match local_mutation_evidence(&self.registry, context.collection_id, operation) {
                    Ok(evidence) => evidence,
                    Err(_) => {
                        return mark_owned_mutation_unknown(
                            &self.registry,
                            keys,
                            metadata,
                            &lease,
                            "The mutation returned but post-apply evidence could not be persisted.",
                        )
                    }
                };
            if self
                .registry
                .mark_mutation_applied(&lease, Some(&after), Some(&result_metadata))
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
        message
    }
}
