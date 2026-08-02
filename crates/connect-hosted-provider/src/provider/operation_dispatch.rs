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
        let replica = self
            .authenticate_for(collection_id, token, ReplicaPurpose::Application)
            .await?;
        authorize_application_operation(&replica, operation, request_origin)?;
        let contract_scope = self.contract_scope(collection_id, &replica).await?;
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
            "describe" => self.describe_operation(collection_id, &replica).await,
            "changes" => {
                self.changes_operation(collection_id, &replica, &input)
                    .await
            }
            "read" | "query" | "validate" | "read_type" | "assess_type_pack" | "list_views"
            | "execute_view" | "read_view_source" => {
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
                    self.project_contract_operation(collection_id, scope, result, selector.as_ref())
                        .await
                } else {
                    serde_json::to_value(result).map_err(|error| {
                        ApiError::internal(format!("Hosted operation could not serialize: {error}"))
                    })
                }
            }
            "create" | "update" | "delete" | "rename" => {
                let request_input = input;
                let stored = self
                    .load_record_operation(
                        collection_id,
                        &replica,
                        operation,
                        request_id,
                        &request_input,
                    )
                    .await?;
                let prepared = match stored {
                    Some(StoredRecordOperation::Completed(result)) => return Ok(result),
                    Some(StoredRecordOperation::Prepared(prepared)) => Some(prepared),
                    None => None,
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
                        self.project_contract_operation(
                            collection_id,
                            scope,
                            current,
                            selected.as_ref(),
                        )
                        .await?;
                    }
                    (scoped_input, selected)
                } else {
                    (request_input.clone(), None)
                };
                let result = self
                    .write_operation(
                        RecordOperationContext {
                            collection_id,
                            token,
                            replica: &replica,
                            operation,
                            request_id,
                            request_input: &request_input,
                        },
                        input,
                        prepared,
                    )
                    .await?;
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
                    self.project_contract_operation(
                        collection_id,
                        scope,
                        envelope,
                        selector.as_ref(),
                    )
                    .await
                } else {
                    Ok(result)
                }
            }
            "create_type" | "update_type" => {
                self.write_type_operation(collection_id, operation, input)
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
                self.write_type_pack_apply_operation(collection_id, &request)
                    .await
            }
            "create_view_source" | "update_view_source" | "delete_view_source" => {
                self.write_view_source_operation(collection_id, operation, input)
                    .await
            }
            _ => Err(ApiError::bad_request(
                "unsupported_operation",
                "The hosted provider does not support that collection operation.",
            )),
        }
    }

    pub(super) async fn contract_scope(
        &self,
        collection_id: Uuid,
        replica: &Replica,
    ) -> ApiResult<Option<ContractScope>> {
        if replica.full_collection {
            return Ok(None);
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
        collection_id: Uuid,
        scope: &ContractScope,
        result: OperationResult,
        selector: Option<&ContractSelector>,
    ) -> ApiResult<Value> {
        let working_set = self.working_set(collection_id).await;
        let cached = working_set.lock().await;
        let cached = cached.as_ref().ok_or_else(|| {
            ApiError::internal("Hosted working set was unavailable during contract projection.")
        })?;
        cached
            .workspace
            .project_contract_result(scope, result, selector)
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
