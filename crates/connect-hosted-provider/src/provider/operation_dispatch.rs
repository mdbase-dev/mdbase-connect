use super::mutation_journal::{HostedMutationClaim, HostedMutationLease};
use super::mutation_metrics::{duplicate_replay, lease_takeover};
use super::*;

impl HostedProvider {
    pub async fn operation(
        &self,
        collection_id: Uuid,
        token: &str,
        operation: &str,
        request_id: Uuid,
        input: Value,
        request_origin: Option<&str>,
    ) -> ApiResult<Value> {
        let replica = match self
            .authenticate_for(collection_id, token, ReplicaPurpose::Application)
            .await
        {
            Ok(replica) => replica,
            Err(authentication_error) => {
                return self
                    .replay_retired_operation_mutation(
                        collection_id,
                        token,
                        operation,
                        request_id,
                        &input,
                        authentication_error,
                    )
                    .await;
            }
        };
        authorize_application_operation(&replica, operation, request_origin)?;
        let portable_selector = matches!(
            operation,
            "query" | "read" | "create" | "update" | "delete" | "rename"
        ) && input.get("contract").is_some();
        let contract_scope = self
            .contract_scope(collection_id, &replica, portable_selector)
            .await?;
        if mdbase_connect_protocol::is_mutating_operation(operation, &input) {
            let claim = self
                .claim_operation_mutation(collection_id, &replica, operation, request_id, &input)
                .await?;
            let (lease, prepared_head, takeover, applied_result) = match claim {
                HostedMutationClaim::Terminal(result) => {
                    duplicate_replay(operation);
                    return result;
                }
                HostedMutationClaim::Live => {
                    return Err(ApiError::conflict(
                        "pending_mutation_unresolved",
                        "The mutation is still owned by an active request handler.",
                    )
                    .with_details(json!({ "request_id": request_id })));
                }
                HostedMutationClaim::Owned {
                    lease,
                    prepared_head,
                    takeover,
                    applied_result,
                } => (lease, prepared_head, takeover, applied_result),
            };
            if let Some(result) = applied_result {
                self.complete_operation_mutation(collection_id, &lease, &result)
                    .await?;
                return result;
            }
            if takeover {
                lease_takeover(operation);
                let current_head = self.current_collection_head(collection_id).await?;
                let operation_has_inner_receipt =
                    matches!(operation, "create" | "update" | "delete" | "rename");
                let timer_operation =
                    matches!(operation, "put_timer" | "cancel_timer" | "reconcile_timers");
                if current_head != prepared_head && !operation_has_inner_receipt && !timer_operation
                {
                    return self
                        .mark_operation_mutation_unknown(collection_id, &lease)
                        .await;
                }
            }
            let result = self
                .execute_authorized_operation(
                    collection_id,
                    token,
                    operation,
                    request_id,
                    input,
                    &replica,
                    contract_scope,
                    Some(&lease),
                )
                .await;
            self.complete_operation_mutation(collection_id, &lease, &result)
                .await?;
            return result;
        }
        self.execute_authorized_operation(
            collection_id,
            token,
            operation,
            request_id,
            input,
            &replica,
            contract_scope,
            None,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn execute_authorized_operation(
        &self,
        collection_id: Uuid,
        token: &str,
        operation: &str,
        request_id: Uuid,
        input: Value,
        replica: &Replica,
        contract_scope: Option<ContractScope>,
        mutation_lease: Option<&HostedMutationLease>,
    ) -> ApiResult<Value> {
        if matches!(
            operation,
            "list_timers" | "put_timer" | "cancel_timer" | "reconcile_timers"
        ) {
            let grant_id = replica.grant_id.ok_or_else(|| {
                ApiError::forbidden(
                    "timer_grant_unavailable",
                    "This application capability is not bound to a timer grant.",
                )
            })?;
            let notifications = self.notifications.as_ref().ok_or_else(|| {
                ApiError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "notifications_unavailable",
                    "Hosted timer execution is not configured.",
                )
            })?;
            return notifications
                .timer_operation(collection_id, grant_id, operation, input)
                .await;
        }
        if is_full_collection_operation(operation) && !replica.full_collection {
            return Err(ApiError::forbidden(
                "scope_denied",
                "This operation requires full collection access.",
            ));
        }
        match operation {
            "describe" => self.describe_operation(collection_id, replica).await,
            "changes" => self.changes_operation(collection_id, replica, &input).await,
            "read"
            | "query"
            | "validate"
            | "read_type"
            | "assess_type_pack"
            | "assess_collection_setup"
            | "list_views"
            | "execute_view"
            | "read_view_source" => {
                let (scoped_input, selector) = match (&contract_scope, operation) {
                    (Some(scope), "query") => scope.query_input(&input).map_err(scope_error)?,
                    (Some(scope), "read") => scope.read_input(&input).map_err(scope_error)?,
                    _ => (
                        scope_read_input(operation, input, &replica.allowed_types)?,
                        None,
                    ),
                };
                let result = self
                    .execute_read_operation(collection_id, operation, &scoped_input)
                    .await?;
                if contract_scope.is_none() && matches!(operation, "read" | "validate") {
                    ensure_operation_result_visible(&result, &replica.allowed_types)?;
                }
                if let Some(scope) = &contract_scope {
                    self.project_contract_operation(scope, result, selector.as_ref())
                        .await
                } else {
                    serde_json::to_value(result).map_err(|error| {
                        ApiError::internal(format!("Hosted operation could not serialize: {error}"))
                    })
                }
            }
            "create" | "update" | "delete" | "rename" => {
                let request_input = input;
                let is_preflight =
                    request_input.get("dry_run").and_then(Value::as_bool) == Some(true);
                let prepared = if let Some(mutation_lease) = mutation_lease {
                    self.load_operation_preparation(collection_id, mutation_lease)
                        .await?
                } else {
                    None
                };
                let (input, selector) = if prepared.is_some() {
                    let selector = contract_scope
                        .as_ref()
                        .map(|scope| scope.selector(&request_input).map_err(scope_error))
                        .transpose()?
                        .flatten();
                    (request_input.clone(), selector)
                } else if let Some(scope) = &contract_scope {
                    let (scoped_input, selected) = if matches!(operation, "create" | "update") {
                        let (mapped, selector) = scope
                            .map_write_input(&request_input, operation == "create")
                            .map_err(scope_error)?;
                        (mapped, Some(selector))
                    } else {
                        let (identity, selector) =
                            scope.identity_input(&request_input).map_err(scope_error)?;
                        (identity, selector)
                    };
                    if operation != "create" {
                        let path_key = if operation == "rename" {
                            "from"
                        } else {
                            "path"
                        };
                        let path = scoped_input
                            .get(path_key)
                            .and_then(Value::as_str)
                            .ok_or_else(|| {
                                ApiError::bad_request(
                                    "invalid_operation_input",
                                    format!("Hosted {operation} requires {path_key}."),
                                )
                            })?;
                        let current = self
                            .execute_read_operation(collection_id, "read", &json!({"path": path}))
                            .await?;
                        self.project_contract_operation(scope, current, selected.as_ref())
                            .await?;
                    }
                    (scoped_input, selected)
                } else {
                    (request_input.clone(), None)
                };
                let result = if is_preflight {
                    self.preflight_record_operation(
                        collection_id,
                        replica,
                        operation,
                        request_id,
                        input,
                    )
                    .await?
                } else {
                    let mutation_lease = mutation_lease.ok_or_else(|| {
                        ApiError::internal("Hosted record mutation has no journal lease.")
                    })?;
                    self.write_operation(
                        RecordOperationContext {
                            collection_id,
                            token,
                            replica,
                            operation,
                            request_id,
                            mutation_lease,
                        },
                        input,
                        prepared,
                    )
                    .await?
                };
                if operation == "delete" {
                    return Ok(result);
                }
                if let Some(scope) = &contract_scope {
                    let envelope: OperationResult =
                        serde_json::from_value(result).map_err(|error| {
                            ApiError::internal(format!(
                                "Hosted operation result could not be projected: {error}"
                            ))
                        })?;
                    self.project_contract_operation(scope, envelope, selector.as_ref())
                        .await
                } else {
                    Ok(result)
                }
            }
            "create_type" | "update_type" => {
                self.write_type_operation(collection_id, operation, input, mutation_lease)
                    .await
            }
            "apply_type_pack" => {
                let request =
                    serde_json::from_value::<ApplyTypePackInput>(input).map_err(|error| {
                        ApiError::bad_request(
                            "invalid_type_pack",
                            format!("The type-pack apply request is invalid: {error}"),
                        )
                    })?;
                self.write_type_pack_apply_operation(collection_id, &request, mutation_lease)
                    .await
            }
            "apply_collection_setup" => {
                let request = serde_json::from_value::<ApplyCollectionSetupInput>(input).map_err(
                    |error| {
                        ApiError::bad_request(
                            "invalid_collection_setup",
                            format!("The collection setup apply request is invalid: {error}"),
                        )
                    },
                )?;
                self.authorize_collection_setup_declaration(replica.id, &request)
                    .await?;
                self.write_collection_setup_apply_operation(collection_id, &request, mutation_lease)
                    .await
            }
            "create_view_source" | "update_view_source" | "delete_view_source" => {
                self.write_view_source_operation(collection_id, operation, input, mutation_lease)
                    .await
            }
            _ => Err(ApiError::bad_request(
                "unsupported_operation",
                "The hosted provider does not support that collection operation.",
            )),
        }
    }

    async fn authorize_collection_setup_declaration(
        &self,
        replica_id: Uuid,
        request: &ApplyCollectionSetupInput,
    ) -> ApiResult<()> {
        let binding = sqlx::query(
            r#"SELECT application_declaration_id, application_declaration_digest
               FROM hosted_provider_replicas
               WHERE id = $1 AND purpose = 'application' AND revoked_at IS NULL"#,
        )
        .bind(replica_id)
        .fetch_optional(&self.pool)
        .await?;
        let Some(binding) = binding else {
            return Err(collection_setup_declaration_mismatch());
        };
        ensure_collection_setup_declaration_binding(
            binding
                .get::<Option<String>, _>("application_declaration_id")
                .as_deref(),
            binding
                .get::<Option<String>, _>("application_declaration_digest")
                .as_deref(),
            &request.setup.application_id,
            &request.setup.declaration_digest,
        )
    }

    pub(super) async fn contract_scope(
        &self,
        collection_id: Uuid,
        replica: &Replica,
        portable_selector: bool,
    ) -> ApiResult<Option<ContractScope>> {
        if replica.full_collection {
            if !portable_selector {
                return Ok(None);
            }
            return ContractScope::new(self.collection_resources(collection_id).await?.contracts)
                .map(Some)
                .map_err(scope_error);
        }
        let current = self.collection_resources(collection_id).await?.contracts;
        for pinned in &replica.contract_scope {
            let matching = current.iter().find(|contract| {
                contract.id == pinned.id
                    && contract.version == pinned.version
                    && contract.digest == pinned.digest
            });
            if matching != Some(pinned) {
                return Err(ApiError::forbidden(
                    "contract_scope_changed",
                    format!(
                        "The approved provider set for {} version {} has changed.",
                        pinned.id, pinned.version
                    ),
                ));
            }
        }
        ContractScope::new(replica.contract_scope.clone())
            .map(Some)
            .map_err(scope_error)
    }

    pub(super) async fn project_contract_operation(
        &self,
        scope: &ContractScope,
        result: OperationResult,
        selector: Option<&ContractSelector>,
    ) -> ApiResult<Value> {
        scope
            .project_result(
                serde_json::to_value(result).map_err(|error| {
                    ApiError::internal(format!(
                        "Hosted operation could not serialize before projection: {error}"
                    ))
                })?,
                selector,
            )
            .map_err(|error| ApiError::forbidden("scope_denied", error.to_string()))
    }

    pub async fn provision_type_packs(
        &self,
        collection_id: Uuid,
        installed_by: &str,
        provisions: Vec<TypePackProvision>,
        contract_setups: Vec<ContractSetupChoice>,
    ) -> ApiResult<(Vec<CollectionContractDescriptor>, Vec<ContractSetupChoice>)> {
        let resources = self.collection_resources(collection_id).await?;
        let provided_contracts = provisions
            .iter()
            .flat_map(|provision| provision.provides.iter())
            .map(|contract| {
                (
                    contract.id.clone(),
                    contract.version.clone(),
                    contract.digest.clone(),
                )
            })
            .collect::<BTreeSet<_>>();
        let setup_contracts = contract_setups
            .iter()
            .map(|setup| {
                (
                    setup.contract.id.clone(),
                    setup.contract.version.clone(),
                    setup.contract.digest.clone(),
                )
            })
            .collect::<BTreeSet<_>>();
        if setup_contracts.len() != contract_setups.len() {
            return Err(ApiError::bad_request(
                "invalid_contract_setup",
                "Each required contract must have exactly one setup choice.",
            ));
        }
        if setup_contracts
            .iter()
            .any(|contract| !provided_contracts.contains(contract))
        {
            return Err(ApiError::bad_request(
                "invalid_contract_setup",
                "Contract setup may only configure a contract provided by this application.",
            ));
        }
        let missing_contracts = provided_contracts
            .iter()
            .filter(|(id, version, digest)| {
                !resources.contracts.iter().any(|contract| {
                    &contract.id == id && &contract.version == version && &contract.digest == digest
                })
            })
            .cloned()
            .collect::<BTreeSet<_>>();
        validate_contract_setup_targets(&setup_contracts, &missing_contracts)?;
        let effective_setups = if contract_setups.is_empty() {
            missing_contracts
                .into_iter()
                .map(|(id, version, digest)| ContractSetupChoice {
                    contract: ContractRequirement {
                        id,
                        version,
                        digest,
                    },
                    mode: ContractSetupMode::Starter,
                })
                .collect::<Vec<_>>()
        } else {
            contract_setups
        };
        if !effective_setups.is_empty() {
            for provision in &provisions {
                let provision_setups = effective_setups
                    .iter()
                    .filter(|setup| provision.provides.contains(&setup.contract))
                    .collect::<Vec<_>>();
                let has_existing = provision_setups
                    .iter()
                    .any(|setup| matches!(setup.mode, ContractSetupMode::Existing { .. }));
                let has_starter = provision_setups
                    .iter()
                    .any(|setup| matches!(setup.mode, ContractSetupMode::Starter));
                let existing_setups = provision_setups
                    .iter()
                    .filter(|setup| matches!(setup.mode, ContractSetupMode::Existing { .. }))
                    .map(|setup| (*setup).clone())
                    .collect::<Vec<_>>();
                let preserve_seed_targets = if has_existing {
                    if has_starter
                        && provision
                            .manifest
                            .resources
                            .iter()
                            .any(|resource| resource.mode == "seed")
                    {
                        return Err(ApiError::bad_request(
                            "ambiguous_seed_setup",
                            "A type pack with shared seed resources cannot mix starter and existing-type setup. Split the pack by contract.",
                        ));
                    }
                    provision
                        .manifest
                        .resources
                        .iter()
                        .filter(|resource| resource.mode == "seed")
                        .map(|resource| resource.target.clone())
                        .collect::<BTreeSet<_>>()
                } else {
                    BTreeSet::new()
                };
                let assessment_input = AssessTypePackInput {
                    provision: provision.clone(),
                    installed_by: installed_by.to_string(),
                    adopt_resources: BTreeMap::new(),
                    preserve_seed_targets: preserve_seed_targets.clone(),
                    target_overrides: BTreeMap::new(),
                    contract_setups: existing_setups.clone(),
                };
                let assessment = self
                    .execute_read_operation(
                        collection_id,
                        "assess_type_pack",
                        &serde_json::to_value(&assessment_input).map_err(|error| {
                            ApiError::internal(format!(
                                "Type-pack assessment input could not serialize: {error}"
                            ))
                        })?,
                    )
                    .await?;
                if !assessment.valid || assessment.result["applicable"].as_bool() != Some(true) {
                    return Err(type_pack_provision_error(&assessment));
                }
                let expected_assessment_digest = assessment.result["assessment_digest"]
                    .as_str()
                    .ok_or_else(|| ApiError::internal("Type-pack assessment returned no digest."))?
                    .to_string();
                let applied = self
                    .write_type_pack_apply_operation(
                        collection_id,
                        &ApplyTypePackInput {
                            provision: provision.clone(),
                            installed_by: installed_by.to_string(),
                            adopt_resources: BTreeMap::new(),
                            preserve_seed_targets,
                            target_overrides: BTreeMap::new(),
                            contract_setups: existing_setups,
                            expected_assessment_digest,
                            allow_downgrade: false,
                        },
                        None,
                    )
                    .await?;
                if applied.get("valid").and_then(Value::as_bool) != Some(true) {
                    return Err(type_pack_envelope_error(&applied));
                }
            }
        }
        let resources = self.collection_resources(collection_id).await?;
        if effective_setups.iter().any(|setup| {
            !resources.contracts.iter().any(|available| {
                available.id == setup.contract.id
                    && available.version == setup.contract.version
                    && available.digest == setup.contract.digest
            })
        }) {
            return Err(ApiError::bad_request(
                "type_pack_provision_failed",
                "Contract setup did not provide every selected contract.",
            ));
        }
        Ok((resources.contracts, effective_setups))
    }

    pub async fn provision_application_setup(
        &self,
        collection_id: Uuid,
        application_id: &str,
        declaration_digest: &str,
        requirements: ApplicationRequirements,
        provisions: ApplicationProvisions,
        contract_setups: Vec<ContractSetupChoice>,
    ) -> ApiResult<(
        Vec<CollectionContractDescriptor>,
        Vec<ContractSetupChoice>,
        Value,
        Value,
    )> {
        let resources = self.collection_resources(collection_id).await?;
        let missing = requirements
            .contracts
            .iter()
            .filter(|required| {
                !resources.contracts.iter().any(|available| {
                    available.id == required.id
                        && available.version == required.version
                        && available.digest == required.digest
                })
            })
            .cloned()
            .collect::<Vec<_>>();
        if missing.iter().any(|required| {
            !provisions
                .type_packs
                .iter()
                .any(|provision| provision.provides.contains(required))
        }) {
            return Err(ApiError::bad_request(
                "collection_setup_unavailable",
                "This collection is missing a required contract that the application cannot install.",
            ));
        }
        let missing_contracts = missing
            .iter()
            .map(|contract| {
                (
                    contract.id.clone(),
                    contract.version.clone(),
                    contract.digest.clone(),
                )
            })
            .collect::<BTreeSet<_>>();
        let setup_contracts = contract_setups
            .iter()
            .map(|setup| {
                (
                    setup.contract.id.clone(),
                    setup.contract.version.clone(),
                    setup.contract.digest.clone(),
                )
            })
            .collect::<BTreeSet<_>>();
        validate_contract_setup_targets(&setup_contracts, &missing_contracts)?;
        let effective_setups = if contract_setups.is_empty() {
            missing
                .iter()
                .cloned()
                .map(|contract| ContractSetupChoice {
                    contract,
                    mode: ContractSetupMode::Starter,
                })
                .collect::<Vec<_>>()
        } else {
            contract_setups
        };
        // Approval is the user's review of the application's complete declared
        // setup, not only the subset that happens to supply a missing contract.
        // Applying every declared pack also keeps managed resources and packs
        // without a contract (for example an application's auxiliary types)
        // consistent with the post-authorization setup assessment.
        let selected_type_packs = provisions.type_packs;
        let mut setup = AssessCollectionSetupInput {
            application_id: application_id.to_string(),
            declaration_digest: declaration_digest.to_string(),
            requirements: ApplicationCollectionSetupRequirements {
                configuration: requirements.configuration,
            },
            provisions: ApplicationCollectionSetupProvisions {
                configuration: provisions.configuration,
                type_packs: selected_type_packs,
            },
            contract_setups: effective_setups.clone(),
            type_pack_adoptions: BTreeMap::new(),
        };
        let mut assessment = self
            .execute_read_operation(
                collection_id,
                "assess_collection_setup",
                &serde_json::to_value(&setup).map_err(|error| {
                    ApiError::internal(format!(
                        "Collection setup assessment input could not serialize: {error}"
                    ))
                })?,
            )
            .await?;
        if assessment.result["applicable"].as_bool() != Some(true) {
            let adoptions =
                mdbase_connect_protocol::reviewable_type_pack_adoptions(&assessment.result);
            if !adoptions.is_empty() {
                setup.type_pack_adoptions = adoptions;
                assessment = self
                    .execute_read_operation(
                        collection_id,
                        "assess_collection_setup",
                        &serde_json::to_value(&setup).map_err(|error| {
                            ApiError::internal(format!(
                                "Collection setup review input could not serialize: {error}"
                            ))
                        })?,
                    )
                    .await?;
            }
        }
        if !assessment.valid || assessment.result["applicable"].as_bool() != Some(true) {
            return Err(type_pack_provision_error(&assessment));
        }
        let required = |key: &str| {
            assessment.result[key]
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| {
                    ApiError::internal(format!("Collection setup assessment returned no {key}."))
                })
        };
        let applied = self
            .write_collection_setup_apply_operation(
                collection_id,
                &ApplyCollectionSetupInput {
                    setup,
                    expected_assessment_digest: required("assessment_digest")?,
                    expected_collection_revision: required("collection_revision")?,
                    expected_provision_digest: required("provision_digest")?,
                    allow_type_pack_downgrades: BTreeSet::new(),
                },
                None,
            )
            .await?;
        if applied.get("valid").and_then(Value::as_bool) != Some(true) {
            return Err(type_pack_envelope_error(&applied));
        }
        let resources = self.collection_resources(collection_id).await?;
        if missing.iter().any(|required| {
            !resources.contracts.iter().any(|available| {
                available.id == required.id
                    && available.version == required.version
                    && available.digest == required.digest
            })
        }) {
            return Err(ApiError::bad_request(
                "collection_setup_failed",
                "Application setup did not provide every required contract.",
            ));
        }
        Ok((
            resources.contracts,
            effective_setups,
            applied["result"]["assessment"].clone(),
            applied["result"]["receipt"].clone(),
        ))
    }

    pub async fn collection_type_candidates(
        &self,
        collection_id: Uuid,
    ) -> ApiResult<Vec<CollectionTypeDescriptor>> {
        let mut types = self.collection_resources(collection_id).await?.types;
        for candidate in &mut types {
            candidate.path = None;
            candidate.definition = None;
            candidate.collection = None;
            candidate.lifecycle = None;
            candidate.extensions.clear();
        }
        types.retain(|candidate| candidate.revision.is_some());
        Ok(types)
    }

    pub(super) async fn collection_resources(
        &self,
        collection_id: Uuid,
    ) -> ApiResult<SyncCollectionResources> {
        let row = sqlx::query(
            r#"SELECT wrapped_data_key, resources_ciphertext
               FROM hosted_provider_collections WHERE id = $1 AND state = 'active'"#,
        )
        .bind(collection_id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| {
            ApiError::not_found(
                "hosted_collection_not_found",
                "Hosted collection not found.",
            )
        })?;
        let data_key = self
            .collection_key(collection_id, row.get("wrapped_data_key"))
            .await?;
        self.crypto.decrypt_json(
            &data_key,
            row.get("resources_ciphertext"),
            &resources_aad(collection_id),
        )
    }
}

pub(super) fn ensure_collection_setup_declaration_binding(
    expected_application_id: Option<&str>,
    expected_declaration_digest: Option<&str>,
    requested_application_id: &str,
    requested_declaration_digest: &str,
) -> ApiResult<()> {
    if expected_application_id == Some(requested_application_id)
        && expected_declaration_digest == Some(requested_declaration_digest)
    {
        Ok(())
    } else {
        Err(collection_setup_declaration_mismatch())
    }
}

fn collection_setup_declaration_mismatch() -> ApiError {
    ApiError::forbidden(
        "application_declaration_mismatch",
        "Collection setup must exactly match the application declaration bound to this capability.",
    )
}
