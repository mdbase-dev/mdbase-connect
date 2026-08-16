use super::mutation_journal::HostedMutationLease;
use super::projections::canonical_record_scope_types;
use super::*;

enum RecordOperationPreparation<'a> {
    Preflight,
    Mutation(&'a HostedMutationLease),
}

impl HostedProvider {
    async fn prepare_record_operation(
        &self,
        collection_id: Uuid,
        replica: &Replica,
        operation: &str,
        request_id: Uuid,
        preparation: RecordOperationPreparation<'_>,
        input: Value,
    ) -> ApiResult<PreparedRecordOperation> {
        let mut operation_input = input.as_object().cloned().ok_or_else(|| {
            ApiError::bad_request(
                "invalid_operation_input",
                "Hosted operation input must be an object.",
            )
        })?;
        let mut transaction = self.pool.begin().await?;
        let replica_collection: Option<Uuid> = sqlx::query_scalar(
            "SELECT collection_id FROM hosted_provider_replicas WHERE id = $1 FOR UPDATE",
        )
        .bind(replica.id)
        .fetch_optional(&mut *transaction)
        .await?;
        if replica_collection != Some(collection_id) {
            return Err(ApiError::forbidden(
                "replica_scope_denied",
                "Operation belongs to another hosted collection.",
            ));
        }
        let wrapped_data_key: Vec<u8> = sqlx::query_scalar(
            "SELECT wrapped_data_key FROM hosted_provider_collections WHERE id = $1 AND state = 'active'",
        )
        .bind(collection_id)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or_else(|| {
            ApiError::not_found(
                "hosted_collection_not_found",
                "Hosted collection not found.",
            )
        })?;
        let data_key = self
            .collection_key(collection_id, &wrapped_data_key)
            .await?;
        let (mutation_operation, record_id, base_revision, previous_path) = match operation {
            "create" => (SyncMutationOperation::Put, request_id, None, None),
            "update" | "delete" | "rename" => {
                let path_key = if operation == "rename" {
                    "from"
                } else {
                    "path"
                };
                let path = operation_input
                    .get(path_key)
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        ApiError::bad_request(
                            "invalid_operation_input",
                            format!("Hosted {operation} requires {path_key}."),
                        )
                    })?
                    .to_string();
                let current = sqlx::query(
                    r#"SELECT record_id, revision, sequence, payload_ciphertext
                       FROM hosted_provider_records
                       WHERE collection_id = $1 AND path_token = $2"#,
                )
                .bind(collection_id)
                .bind(path_token(&data_key, &path))
                .fetch_optional(&mut *transaction)
                .await?
                .ok_or_else(|| {
                    ApiError::not_found("record_not_found", "The hosted record does not exist.")
                })?;
                let types = canonical_record_scope_types(
                    &mut transaction,
                    self,
                    &data_key,
                    collection_id,
                    current.get("record_id"),
                    number(current.get::<i64, _>("sequence"), "record sequence")?,
                    current.get("revision"),
                    current.get("payload_ciphertext"),
                )
                .await?;
                if !replica.allowed_types.is_empty()
                    && !types
                        .iter()
                        .any(|record_type| replica.allowed_types.contains(record_type))
                {
                    return Err(ApiError::forbidden(
                        "scope_denied",
                        "The requested record is outside this application's record scope.",
                    ));
                }
                if !replica.allowed_types.is_empty() {
                    if operation == "delete" {
                        operation_input.insert("check_backlinks".to_string(), Value::Bool(false));
                    } else if operation == "rename"
                        && operation_input.get("update_refs").and_then(Value::as_bool) == Some(true)
                    {
                        return Err(ApiError::forbidden(
                            "scope_denied",
                            "Reference updates can affect records outside this application's scope.",
                        ));
                    }
                }
                let current_revision: String = current.get("revision");
                let requested_revision = operation_input
                    .get("if_revision")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or(current_revision);
                operation_input.insert(
                    "if_revision".to_string(),
                    Value::String(requested_revision.clone()),
                );
                if operation == "rename" {
                    let target = operation_input
                        .get("to")
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            ApiError::bad_request(
                                "invalid_operation_input",
                                "Hosted rename requires to.",
                            )
                        })?
                        .to_string();
                    operation_input.insert("path".to_string(), Value::String(target));
                }
                (
                    match operation {
                        "update" => SyncMutationOperation::Put,
                        "delete" => SyncMutationOperation::Delete,
                        "rename" => SyncMutationOperation::Move,
                        _ => unreachable!(),
                    },
                    current.get("record_id"),
                    Some(requested_revision),
                    Some(path),
                )
            }
            _ => unreachable!(),
        };
        let include_document = operation_input
            .get("include_document")
            .and_then(Value::as_bool)
            == Some(true)
            || operation_input.contains_key("document");
        let prepared = PreparedRecordOperation {
            mutation: SyncMutation {
                mutation_id: request_id,
                replica_id: replica.id,
                scope_epoch: replica.scope_epoch,
                operation: mutation_operation,
                record_id,
                base_revision,
                path: match operation {
                    "rename" => operation_input.get("to"),
                    _ => operation_input.get("path"),
                }
                .and_then(Value::as_str)
                .map(str::to_string),
                document: operation_input
                    .get("document")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                created_at: Utc::now().to_rfc3339(),
                causal_predecessor: None,
            },
            semantic_operation: operation.to_string(),
            semantic_input: operation_input,
            previous_path,
            include_document,
        };
        let dry_run = prepared
            .semantic_input
            .get("dry_run")
            .and_then(Value::as_bool)
            == Some(true);
        match (preparation, dry_run) {
            (RecordOperationPreparation::Preflight, true) => {}
            (RecordOperationPreparation::Mutation(mutation_lease), false) => {
                self.store_operation_preparation_in(
                    &mut transaction,
                    &data_key,
                    mutation_lease,
                    &prepared,
                )
                .await?;
            }
            (RecordOperationPreparation::Preflight, false) => {
                return Err(ApiError::internal(
                    "Hosted record mutation entered read-only preparation.",
                ));
            }
            (RecordOperationPreparation::Mutation(_), true) => {
                return Err(ApiError::internal(
                    "Hosted record preflight entered mutation preparation.",
                ));
            }
        }
        transaction.commit().await?;
        Ok(prepared)
    }

    pub(super) async fn preflight_record_operation(
        &self,
        collection_id: Uuid,
        replica: &Replica,
        operation: &str,
        request_id: Uuid,
        input: Value,
    ) -> ApiResult<Value> {
        if input.get("dry_run").and_then(Value::as_bool) != Some(true) {
            return Err(ApiError::internal(
                "Hosted record preflight requires a dry-run operation.",
            ));
        }
        let prepared = self
            .prepare_record_operation(
                collection_id,
                replica,
                operation,
                request_id,
                RecordOperationPreparation::Preflight,
                input,
            )
            .await?;
        let result = self
            .preflight_semantic_mutation(
                collection_id,
                &prepared.mutation,
                &prepared.semantic_operation,
                prepared.semantic_input,
                &replica.allowed_types,
            )
            .await?;
        serde_json::to_value(result).map_err(|error| {
            ApiError::internal(format!(
                "Hosted operation preflight could not serialize: {error}"
            ))
        })
    }

    pub(super) async fn write_operation(
        &self,
        context: RecordOperationContext<'_>,
        input: Value,
        prepared: Option<PreparedRecordOperation>,
    ) -> ApiResult<Value> {
        let prepared = match prepared {
            Some(prepared) => prepared,
            None => {
                let prepared = self
                    .prepare_record_operation(
                        context.collection_id,
                        context.replica,
                        context.operation,
                        context.request_id,
                        RecordOperationPreparation::Mutation(context.mutation_lease),
                        input,
                    )
                    .await?;
                prepared
            }
        };
        let PreparedRecordOperation {
            mutation,
            semantic_operation,
            semantic_input,
            previous_path,
            include_document,
        } = prepared;
        let mutation_result = self
            .mutate_for(
                context.collection_id,
                context.token,
                mutation,
                ReplicaPurpose::Application,
                Some(context.mutation_lease),
                Some((semantic_operation, semantic_input)),
            )
            .await?;
        let receipt = mutation_result.receipt;
        let semantic_result = mutation_result.semantic_result;
        let result = match receipt {
            SyncMutationReceipt::Applied { record, .. }
            | SyncMutationReceipt::PreviouslyApplied { record, .. } => {
                if context.operation == "delete" {
                    semantic_result.unwrap_or_else(|| OperationResult {
                        valid: true,
                        result: json!({
                            "path": previous_path,
                            "deleted": true,
                        }),
                        diagnostics: Vec::new(),
                    })
                } else {
                    let record = record.ok_or_else(|| {
                        ApiError::internal(
                            "The hosted operation did not return its resulting record.",
                        )
                    })?;
                    let mut document = self
                        .execute_direct_point_read_by_id(
                            context.collection_id,
                            record.record_id,
                            &json!({
                                "path": record.path.clone(),
                                "include_document": include_document,
                            }),
                        )
                        .await?;
                    if !document.valid {
                        let diagnostic_code = document
                            .diagnostics
                            .first()
                            .map(|diagnostic| diagnostic.code.as_str())
                            .unwrap_or("unknown");
                        tracing::warn!(
                            target: "mdbase_connect::metrics",
                            metric = "hosted_mutation_result_read_failed",
                            diagnostic_code,
                            "privacy-safe hosted provider diagnostic"
                        );
                        return Err(ApiError::internal(
                            format!(
                                "The hosted mutation succeeded but its record document could not be read ({diagnostic_code})."
                            ),
                        ));
                    }
                    let value = document.result.as_object_mut().ok_or_else(|| {
                        ApiError::internal("mdbase-rs returned a non-object record document.")
                    })?;
                    if let Some(semantic) = semantic_result {
                        if let Some(fields) = semantic.result.as_object() {
                            value.extend(fields.clone());
                        }
                        document.diagnostics.extend(semantic.diagnostics);
                    }
                    if context.operation == "rename" {
                        value.insert(
                            "from".to_string(),
                            Value::String(previous_path.unwrap_or_default()),
                        );
                        value.insert("to".to_string(), Value::String(record.path));
                        value
                            .entry("references_updated".to_string())
                            .or_insert_with(|| Value::Array(Vec::new()));
                    }
                    document
                }
            }
            SyncMutationReceipt::Rejected { error, .. } => {
                invalid_operation_result(&error.code, &error.message, previous_path, None)
            }
            SyncMutationReceipt::Conflicted { conflict, .. } => invalid_operation_result(
                "concurrent_modification",
                "The hosted record changed after it was read.",
                previous_path,
                Some(json!({ "current_revision": conflict.current_revision })),
            ),
        };
        let result = serde_json::to_value(result).map_err(|error| {
            ApiError::internal(format!("Hosted operation could not serialize: {error}"))
        })?;
        Ok(result)
    }
}
