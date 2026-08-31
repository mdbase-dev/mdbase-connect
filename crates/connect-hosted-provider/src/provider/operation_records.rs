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
        let current_replica = sqlx::query(
            "SELECT collection_id, scope_epoch FROM hosted_provider_replicas WHERE id = $1 FOR UPDATE",
        )
        .bind(replica.id)
        .fetch_optional(&mut *transaction)
        .await?;
        let Some(current_replica) = current_replica else {
            return Err(ApiError::forbidden(
                "replica_scope_denied",
                "The hosted replica is unavailable.",
            ));
        };
        if current_replica.get::<Uuid, _>("collection_id") != collection_id {
            return Err(ApiError::forbidden(
                "replica_scope_denied",
                "Operation belongs to another hosted collection.",
            ));
        }
        if number(current_replica.get::<i64, _>("scope_epoch"), "scope epoch")?
            != replica.scope_epoch
        {
            return Err(ApiError::forbidden(
                "scope_epoch_stale",
                "Replica scope changed; retry with current authorization.",
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
                if !replica.allowed_types.is_empty() {
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
                    if !types
                        .iter()
                        .any(|record_type| replica.allowed_types.contains(record_type))
                    {
                        return Err(ApiError::forbidden(
                            "scope_denied",
                            "The requested record is outside this application's record scope.",
                        ));
                    }
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
            include_document: _,
        } = prepared;
        let legacy_replay_input = semantic_input.clone();
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
        // The live path keeps the canonical outcome typed until this single
        // v0.3 compatibility edge. Durable journal replay remains wire-shaped
        // for schema compatibility and is never used for semantic decisions.
        let semantic_result = mutation_result
            .semantic_operation
            .as_ref()
            .map(mdbase::runtime::CanonicalOperationOutcome::to_v03)
            .or(mutation_result.replayed_semantic_result);
        let result = match receipt {
            SyncMutationReceipt::Applied { .. } | SyncMutationReceipt::PreviouslyApplied { .. } => {
                if let Some(result) = semantic_result {
                    result
                } else {
                    reconstruct_exact_legacy_record_result(
                        context.operation,
                        previous_path.as_deref(),
                        &legacy_replay_input,
                    )?
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

/// Legacy journals have no mutation-time catalog digest. The only exact
/// response reconstructible from their durable preparation and receipt is a
/// delete for which backlink inspection was explicitly disabled. In that case
/// the canonical response omits backlink diagnostics, as proven by the durable
/// input rather than ambient collection state.
fn reconstruct_exact_legacy_record_result(
    operation: &str,
    previous_path: Option<&str>,
    input: &serde_json::Map<String, Value>,
) -> ApiResult<OperationResult> {
    if operation == "delete" && input.get("check_backlinks").and_then(Value::as_bool) == Some(false)
    {
        let path =
            previous_path.filter(|path| input.get("path").and_then(Value::as_str) == Some(*path));
        if let Some(path) = path {
            return Ok(OperationResult {
                valid: true,
                result: json!({
                    "path": path,
                    "deleted": true,
                }),
                diagnostics: Vec::new(),
            });
        }
    }
    Err(ApiError::conflict(
        "legacy_replay_evidence_missing",
        "The durable mutation evidence cannot reconstruct the exact original operation response.",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_delete_replay_is_exact_only_when_backlinks_were_disabled() {
        let input = serde_json::Map::from_iter([
            ("path".to_string(), json!("notes/exact.md")),
            ("check_backlinks".to_string(), json!(false)),
        ]);
        let exact =
            reconstruct_exact_legacy_record_result("delete", Some("notes/exact.md"), &input)
                .unwrap();
        assert_eq!(
            exact.result,
            json!({"path": "notes/exact.md", "deleted": true})
        );

        for input in [
            serde_json::Map::from_iter([
                ("path".to_string(), json!("notes/exact.md")),
                ("check_backlinks".to_string(), json!(true)),
            ]),
            serde_json::Map::from_iter([("path".to_string(), json!("notes/exact.md"))]),
        ] {
            let error =
                reconstruct_exact_legacy_record_result("delete", Some("notes/exact.md"), &input)
                    .unwrap_err();
            assert_eq!(error.code, "legacy_replay_evidence_missing");
        }
    }

    #[test]
    fn legacy_record_writes_without_semantic_receipts_fail_closed() {
        for operation in ["create", "update", "rename"] {
            let error = reconstruct_exact_legacy_record_result(
                operation,
                Some("notes/old.md"),
                &serde_json::Map::new(),
            )
            .unwrap_err();
            assert_eq!(error.code, "legacy_replay_evidence_missing");
        }
    }
}
