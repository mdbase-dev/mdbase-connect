use super::*;

impl HostedProvider {
    pub(super) async fn prepare_record_operation(
        &self,
        collection_id: Uuid,
        replica: &Replica,
        operation: &str,
        request_id: Uuid,
        request_input: &Value,
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
        let data_key = self.collection_key(collection_id, &wrapped_data_key)?;
        let request_hash = operation_request_hash(operation, request_input)?;
        if let Some(row) = sqlx::query(
            r#"SELECT operation, request_hash, prepared_mutation_ciphertext
               FROM hosted_provider_operation_requests
               WHERE replica_id = $1 AND request_id = $2"#,
        )
        .bind(replica.id)
        .bind(request_id)
        .fetch_optional(&mut *transaction)
        .await?
        {
            let stored_hash: Vec<u8> = row.get("request_hash");
            if row.get::<String, _>("operation") != operation
                || !bool::from(stored_hash.ct_eq(&request_hash))
            {
                return Err(ApiError::conflict(
                    "operation_request_id_reused",
                    "Operation request ID was already used for a different operation.",
                ));
            }
            let ciphertext = row
                .get::<Option<Vec<u8>>, _>("prepared_mutation_ciphertext")
                .ok_or_else(|| {
                    ApiError::internal("The hosted operation request has no prepared mutation.")
                })?;
            let prepared = self.crypto.decrypt_json(
                &data_key,
                &ciphertext,
                &operation_prepared_aad(replica.id, request_id),
            )?;
            transaction.commit().await?;
            return Ok(prepared);
        }
        let (mutation_operation, record_id, base_revision, previous_path) = match operation {
            "create" => (SyncMutationOperation::Create, request_id, None, None),
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
                    r#"SELECT record_id, revision, types FROM hosted_provider_records
                       WHERE collection_id = $1 AND path_token = $2"#,
                )
                .bind(collection_id)
                .bind(path_token(&data_key, &path))
                .fetch_optional(&mut *transaction)
                .await?
                .ok_or_else(|| {
                    ApiError::not_found("record_not_found", "The hosted record does not exist.")
                })?;
                let types: Vec<String> = current.get("types");
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
                        "update" => SyncMutationOperation::Update,
                        "delete" => SyncMutationOperation::Delete,
                        "rename" => SyncMutationOperation::Rename,
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
                input: operation_input,
                created_at: Utc::now().to_rfc3339(),
                causal_predecessor: None,
            },
            previous_path,
            include_document,
        };
        if prepared
            .mutation
            .input
            .get("dry_run")
            .and_then(Value::as_bool)
            != Some(true)
        {
            let ciphertext = self.crypto.encrypt_json(
                &data_key,
                &prepared,
                &operation_prepared_aad(replica.id, request_id),
            )?;
            sqlx::query(
                r#"INSERT INTO hosted_provider_operation_requests
                     (replica_id, request_id, operation, request_hash,
                      prepared_mutation_ciphertext)
                   VALUES ($1, $2, $3, $4, $5)"#,
            )
            .bind(replica.id)
            .bind(request_id)
            .bind(operation)
            .bind(request_hash)
            .bind(ciphertext)
            .execute(&mut *transaction)
            .await?;
        }
        transaction.commit().await?;
        Ok(prepared)
    }

    pub(super) async fn complete_record_operation(
        &self,
        collection_id: Uuid,
        replica_id: Uuid,
        operation: &str,
        request_id: Uuid,
        input: &Value,
        response: &Value,
    ) -> ApiResult<()> {
        let wrapped_data_key: Vec<u8> = sqlx::query_scalar(
            "SELECT wrapped_data_key FROM hosted_provider_collections WHERE id = $1",
        )
        .bind(collection_id)
        .fetch_one(&self.pool)
        .await?;
        let data_key = self.collection_key(collection_id, &wrapped_data_key)?;
        let request_hash = operation_request_hash(operation, input)?;
        let response_ciphertext = self.crypto.encrypt_json(
            &data_key,
            response,
            &operation_response_aad(replica_id, request_id),
        )?;
        let updated = sqlx::query(
            r#"UPDATE hosted_provider_operation_requests
               SET response_ciphertext = $5, completed_at = now()
               WHERE replica_id = $1 AND request_id = $2
                 AND operation = $3 AND request_hash = $4"#,
        )
        .bind(replica_id)
        .bind(request_id)
        .bind(operation)
        .bind(request_hash)
        .bind(response_ciphertext)
        .execute(&self.pool)
        .await?
        .rows_affected();
        if updated != 1 {
            return Err(ApiError::conflict(
                "operation_request_id_reused",
                "Operation request ID was already used for a different operation.",
            ));
        }
        Ok(())
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
                        context.request_input,
                        input,
                    )
                    .await?;
                if prepared
                    .mutation
                    .input
                    .get("dry_run")
                    .and_then(Value::as_bool)
                    == Some(true)
                {
                    let result = self
                        .execute_read_operation(
                            context.collection_id,
                            context.operation,
                            &Value::Object(prepared.mutation.input),
                        )
                        .await?;
                    return serde_json::to_value(result).map_err(|error| {
                        ApiError::internal(format!(
                            "Hosted operation preflight could not serialize: {error}"
                        ))
                    });
                }
                prepared
            }
        };
        let PreparedRecordOperation {
            mutation,
            previous_path,
            include_document,
        } = prepared;
        let receipt = self
            .mutate_for(
                context.collection_id,
                context.token,
                mutation,
                ReplicaPurpose::Application,
            )
            .await?;
        let result = match receipt {
            SyncMutationReceipt::Applied { record, .. }
            | SyncMutationReceipt::PreviouslyApplied { record, .. } => {
                if context.operation == "delete" {
                    OperationResult {
                        valid: true,
                        result: json!({
                            "path": previous_path,
                            "deleted": true,
                        }),
                        diagnostics: Vec::new(),
                    }
                } else {
                    let record = record.ok_or_else(|| {
                        ApiError::internal(
                            "The hosted operation did not return its resulting record.",
                        )
                    })?;
                    let mut document = self
                        .execute_read_operation(
                            context.collection_id,
                            "read",
                            &json!({
                                "path": record.path.clone(),
                                "include_document": include_document,
                            }),
                        )
                        .await?;
                    if !document.valid {
                        return Err(ApiError::internal(
                            "The hosted mutation succeeded but its record document could not be read.",
                        ));
                    }
                    if context.operation == "rename" {
                        let value = document.result.as_object_mut().ok_or_else(|| {
                            ApiError::internal("mdbase-rs returned a non-object record document.")
                        })?;
                        value.insert(
                            "from".to_string(),
                            Value::String(previous_path.unwrap_or_default()),
                        );
                        value.insert("to".to_string(), Value::String(record.path));
                        value.insert("references_updated".to_string(), Value::Array(Vec::new()));
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
        self.complete_record_operation(
            context.collection_id,
            context.replica.id,
            context.operation,
            context.request_id,
            context.request_input,
            &result,
        )
        .await?;
        Ok(result)
    }
}
