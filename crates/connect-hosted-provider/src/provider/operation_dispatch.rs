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
            "read" | "query" | "validate" | "read_type" | "list_views" | "execute_view"
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
            "install_type_pack" => {
                let provision =
                    serde_json::from_value::<TypePackProvision>(input).map_err(|error| {
                        ApiError::bad_request(
                            "invalid_type_pack",
                            format!("The type-pack provision is invalid: {error}"),
                        )
                    })?;
                self.write_type_pack_operation(collection_id, &provision)
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
            let matching = current
                .iter()
                .find(|contract| contract.id == pinned.id && contract.version == pinned.version);
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
        provisions: Vec<TypePackProvision>,
    ) -> ApiResult<Vec<CollectionContractDescriptor>> {
        let mut resources = self.collection_resources(collection_id).await?;
        for provision in provisions {
            let result = self
                .write_type_pack_operation(collection_id, &provision)
                .await?;
            if result.get("valid").and_then(Value::as_bool) != Some(true) {
                let detail = result
                    .pointer("/diagnostics/0/message")
                    .and_then(Value::as_str)
                    .unwrap_or("the type pack was rejected");
                return Err(ApiError::bad_request(
                    "type_pack_provision_failed",
                    format!(
                        "The {} type pack could not be installed: {detail}",
                        provision
                            .manifest
                            .name
                            .as_deref()
                            .unwrap_or(&provision.manifest.id)
                    ),
                ));
            }
            resources = self.collection_resources(collection_id).await?;
            if provision.provides.iter().any(|provided| {
                !resources.contracts.iter().any(|available| {
                    available.id == provided.id && available.version == provided.version
                })
            }) {
                return Err(ApiError::bad_request(
                    "type_pack_provision_failed",
                    format!(
                        "The {} type pack did not provide every contract declared by the application.",
                        provision
                            .manifest
                            .name
                            .as_deref()
                            .unwrap_or(&provision.manifest.id)
                    ),
                ));
            }
        }
        Ok(resources.contracts)
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
        let data_key = self.collection_key(collection_id, row.get("wrapped_data_key"))?;
        self.crypto.decrypt_json(
            &data_key,
            row.get("resources_ciphertext"),
            &resources_aad(collection_id),
        )
    }
}
