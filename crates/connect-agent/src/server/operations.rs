use super::*;

impl AgentState {
    fn scoped_operation(
        &self,
        transport: &'static str,
        collection_id: uuid::Uuid,
        operation: &str,
        input: &serde_json::Value,
        grant: &mdbase_connect_protocol::GrantSummary,
    ) -> Result<serde_json::Value, ConnectError> {
        let started = Instant::now();
        let synchronize_us = std::cell::Cell::new(0_u64);
        if matches!(
            operation,
            "list_timers" | "put_timer" | "cancel_timer" | "reconcile_timers"
        ) {
            let result = self
                .runtime_timers
                .as_ref()
                .ok_or_else(|| {
                    ConnectError::TimerRuntime("The timer authority is unavailable.".to_string())
                })
                .and_then(|timers| {
                    timers
                        .operation(collection_id, grant.clone(), operation, input.clone())
                        .map_err(|error| {
                            if error.internal {
                                ConnectError::TimerRuntime(error.message)
                            } else {
                                ConnectError::InvalidTimer(error.message)
                            }
                        })
                });
            profile_operation(transport, operation, started, 0, &result);
            return result;
        }
        if operation == "sync" {
            let mode = if grant.operations.iter().any(|operation| {
                matches!(
                    operation.as_str(),
                    "create" | "update" | "delete" | "rename"
                )
            }) {
                SyncReplicaMode::ReadWrite
            } else {
                SyncReplicaMode::ReadOnly
            };
            let result = self.registry.sync_operation_synchronized(
                collection_id,
                input,
                LocalReplica {
                    id: grant.id,
                    name: grant.application_name.clone(),
                    mode,
                    allowed_types: Default::default(),
                },
                &grant.scope,
                |invalidation| {
                    let synchronize_started = Instant::now();
                    self.watcher.synchronize(collection_id, invalidation);
                    synchronize_us.set(elapsed_us(synchronize_started));
                },
            );
            profile_operation(transport, operation, started, synchronize_us.get(), &result);
            return result;
        }
        let result = self.registry.scoped_operation_synchronized(
            collection_id,
            operation,
            input,
            &grant.scope,
            |invalidation| {
                let synchronize_started = Instant::now();
                self.watcher.synchronize(collection_id, invalidation);
                synchronize_us.set(elapsed_us(synchronize_started));
            },
        );
        profile_operation(transport, operation, started, synchronize_us.get(), &result);
        result
    }

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
            .grant_context(envelope.grant_id)
            .ok()
            .flatten()
            .is_some_and(|grant| grant.application_origin == origin);
        if !origin_matches {
            return encrypted_rejection(envelope.request_id);
        }
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
                match self.registry.replace_grants(&grants) {
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
                collection_id,
                requirements,
                provisions,
                contract_setups,
                mut grant,
                ..
            } => {
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
                    let contracts = self.registry.provision_type_packs(
                        collection_id,
                        &requirements,
                        &provisions.type_packs,
                        &contract_setups,
                    )?;
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
                                    })
                                })
                                .cloned()
                                .collect()
                        };
                    self.watcher.rescan(collection_id);
                    self.registry.upsert_grant(&grant)?;
                    Ok(contracts)
                })();
                Some(match result {
                    Ok(contracts) => RelayMessage::AuthorizationActivationResponse {
                        protocol_version: CONTROL_PROTOCOL_VERSION,
                        request_id,
                        ok: true,
                        contracts,
                        contract_setups: contract_setups.clone(),
                        error: None,
                    },
                    Err(error) => RelayMessage::AuthorizationActivationResponse {
                        protocol_version: CONTROL_PROTOCOL_VERSION,
                        request_id,
                        ok: false,
                        contracts: Vec::new(),
                        contract_setups: Vec::new(),
                        error: Some(ControlError {
                            code: error.code().to_string(),
                            message: error.to_string(),
                            details: None,
                        }),
                    },
                })
            }
            RelayMessage::OperationRequest {
                request_id,
                grant_id,
                collection_id,
                application_id,
                operation,
                input,
                ..
            } => {
                let context = self.registry.grant_context(grant_id).ok().flatten();
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
                        protocol_version: CONTROL_PROTOCOL_VERSION,
                        request_id,
                        ok: false,
                        result: None,
                        error: Some(ControlError {
                            code: "encryption_required".to_string(),
                            message: "This grant requires encrypted relay protocol 1.".to_string(),
                            details: None,
                        }),
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
                        protocol_version: CONTROL_PROTOCOL_VERSION,
                        request_id,
                        ok: false,
                        result: None,
                        error: Some(ControlError {
                            code: "access_paused".to_string(),
                            message: "Remote access is paused on this computer.".to_string(),
                            details: None,
                        }),
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
                        protocol_version: CONTROL_PROTOCOL_VERSION,
                        request_id,
                        ok: false,
                        result: None,
                        error: Some(ControlError {
                            code: "access_denied".to_string(),
                            message: "The local connector policy does not allow this request."
                                .to_string(),
                            details: None,
                        }),
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
                        protocol_version: CONTROL_PROTOCOL_VERSION,
                        request_id,
                        ok: true,
                        result: Some(result),
                        error: None,
                    },
                    Err(error) => RelayMessage::OperationResponse {
                        protocol_version: CONTROL_PROTOCOL_VERSION,
                        request_id,
                        ok: false,
                        result: None,
                        error: Some(ControlError {
                            code: error.code().to_string(),
                            message: error.to_string(),
                            details: None,
                        }),
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
            | RelayMessage::EncryptedOperationRejected { .. } => None,
        }
    }

    fn handle_encrypted_operation(
        &self,
        envelope: mdbase_connect_protocol::EncryptedRelayEnvelope,
    ) -> RelayMessage {
        let rejected = || encrypted_rejection(envelope.request_id);
        let Some(context) = self
            .registry
            .grant_context(envelope.grant_id)
            .ok()
            .flatten()
        else {
            return rejected();
        };
        let Some(encryption) = context.encryption.as_ref() else {
            return rejected();
        };
        let binding = RelayBinding::from_grant(context.id, context.application_id, encryption);
        if validate_envelope(&envelope, &binding).is_err()
            || context.collection_id != envelope.collection_id
            || !context
                .operations
                .iter()
                .any(|allowed| allowed == &envelope.operation)
        {
            return rejected();
        }
        let metadata = RelayMetadata {
            binding: &binding,
            request_id: envelope.request_id,
            operation: &envelope.operation,
            counter: &envelope.counter,
        };
        let Ok(keys) = self
            .relay_identity
            .derive(&encryption.application_agreement_public_key, &binding)
        else {
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
        let Ok(fingerprint) = encrypted_request_fingerprint(&envelope) else {
            return rejected();
        };
        match self.registry.claim_encrypted_request(
            context.id,
            &encryption.key_id,
            counter,
            envelope.request_id,
            &fingerprint,
        ) {
            Ok(EncryptedRequestClaim::Fresh) => {}
            Ok(EncryptedRequestClaim::Completed(response)) => {
                return serde_json::from_str(&response).map_or_else(
                    |_| rejected(),
                    |envelope| RelayMessage::EncryptedOperationResponse { envelope },
                );
            }
            Ok(EncryptedRequestClaim::InProgress) => {
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
            Err(_) => return rejected(),
        }

        let paused = self.registry.paused().unwrap_or(true);
        let result = if paused {
            Err(ConnectError::AccessDenied(
                "Remote access is paused on this computer.".to_string(),
            ))
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
                "error": {
                    "code": if paused { "access_paused" } else { error.code() },
                    "message": error.to_string()
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
            )
            .is_err()
        {
            return rejected();
        }
        RelayMessage::EncryptedOperationResponse {
            envelope: response_envelope,
        }
    }
}
