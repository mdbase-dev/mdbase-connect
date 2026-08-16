impl HostedProvider {
    #[allow(clippy::too_many_arguments)]
    async fn start_query_state(
        &self,
        transaction: &mut Transaction<'_, Postgres>,
        collection_id: Uuid,
        collection: &PgRow,
        replica: &Replica,
        input: &Value,
        catalog: &mdbase::runtime::CompiledCatalog,
        data_key: &[u8; 32],
    ) -> ApiResult<HostedQueryState> {
        let (generation_id, catalog_revision, projection_format_version, semantic_engine_version) =
            base_query_binding(collection, catalog);
        let plan = match catalog.compile_hosted_query(input) {
            Ok(plan) => plan,
            Err(error) => {
                return Err(ApiError::bad_request(error.code, error.message));
            }
        };
        let exact_context = if plan.requirements.query_context {
            load_query_context_record(transaction, &self.crypto, data_key, collection_id, input)
                .await?
        } else {
            None
        };
        if let Some(context) = exact_context.as_ref() {
            enforce_context_scope(catalog, context, &replica.allowed_types)?;
        }
        enforce_exact_context_budget(&plan, exact_context.as_ref())?;
        let request_digest = plan.canonical_query_digest.clone();
        let (scan_budget_records, scan_budget_ciphertext_bytes) = hosted_query_scan_budgets();
        Ok(HostedQueryState {
            snapshot_head: number(collection.get::<i64, _>("head"), "collection head")?,
            snapshot_record_count: number(
                collection.get::<i64, _>("record_count"),
                "collection record count",
            )?,
            scan_budget_records,
            scan_budget_ciphertext_bytes,
            generation_id,
            projection_integrity_epoch: collection_projection_integrity_epoch(collection)?,
            projection_integrity_verified: collection_projection_integrity_verified(collection)?,
            catalog_revision,
            projection_format_version,
            semantic_engine_version,
            plan,
            allowed_types: replica.allowed_types.clone(),
            last_order_values: Vec::new(),
            last_path: None,
            last_record_id: None,
            emitted_rows: 0,
            hard_expires_at: query_cursor_hard_expires_at()?,
            consumed_cursor_id: None,
            request_kind: HostedQueryRequestKind::Query,
            request_digest,
            result_meta: serde_json::Map::new(),
            exact_context,
            base_plan: None,
            base_invocation_id: None,
            base_context: None,
            base_operation_clock: None,
            execution_proof: None,
        })
    }

    #[allow(clippy::too_many_arguments)]
    async fn start_canonical_view_state(
        &self,
        transaction: &mut Transaction<'_, Postgres>,
        collection_id: Uuid,
        collection: &PgRow,
        replica: &Replica,
        input: &Value,
        catalog: &mdbase::runtime::CompiledCatalog,
        resource_documents: &[(String, String)],
        data_key: &[u8; 32],
    ) -> ApiResult<Result<HostedQueryState, OperationResult>> {
        let requested_path = input.get("path").and_then(Value::as_str).ok_or_else(|| {
            ApiError::bad_request("invalid_request", "Saved-view path is required.")
        })?;
        let Some((_, view_document)) = resource_documents
            .iter()
            .find(|(path, _)| path == requested_path)
        else {
            return Ok(Err(mdbase::runtime::invalid_operation_result(
                "view_not_found",
                format!("View record '{requested_path}' was not found."),
            )));
        };
        let view_record = mdbase::runtime::CanonicalRecordInput {
            stable_id: None,
            path: requested_path.to_string(),
            document: view_document.clone(),
            file_size: view_document.len() as u64,
            file_mtime: None,
        };
        let explicit_context_path = input
            .get("context")
            .and_then(Value::as_object)
            .and_then(|context| context.get("path"))
            .and_then(Value::as_str);
        let explicit_context = match explicit_context_path {
            Some(path) if path != requested_path => {
                load_exact_context_by_path(transaction, &self.crypto, data_key, collection_id, path)
                    .await?
            }
            _ => None,
        };
        let planning = catalog
            .plan_hosted_canonical_view(
                input,
                &view_record,
                explicit_context.as_ref(),
                &replica.allowed_types,
            )
            .map_err(|error| {
                ApiError::bad_request(
                    error.code,
                    format!("Canonical saved-view planning failed: {}", error.message),
                )
            })?;
        let plan = match planning {
            mdbase::runtime::HostedCanonicalViewPlanning::Planned { plan } => *plan,
            mdbase::runtime::HostedCanonicalViewPlanning::Invalid { result } => {
                return Ok(Err(result));
            }
        };
        let exact_context = if plan.query.requirements.query_context {
            match plan.context_path.as_deref() {
                None => None,
                Some(path) if path == view_record.path => Some(view_record),
                Some(_) => explicit_context,
            }
        } else {
            None
        };
        enforce_exact_context_budget(&plan.query, exact_context.as_ref())?;
        let (generation_id, catalog_revision, projection_format_version, semantic_engine_version) =
            active_query_binding(collection, catalog)?;
        let mut result_meta = serde_json::Map::new();
        result_meta.insert(
            "view".to_string(),
            json!({"path": plan.view_path, "id": plan.view_id}),
        );
        result_meta.insert(
            "context".to_string(),
            plan.context_path
                .as_ref()
                .map(|path| json!({"path": path}))
                .unwrap_or(Value::Null),
        );
        let (scan_budget_records, scan_budget_ciphertext_bytes) = hosted_query_scan_budgets();
        Ok(Ok(HostedQueryState {
            snapshot_head: number(collection.get::<i64, _>("head"), "collection head")?,
            snapshot_record_count: number(
                collection.get::<i64, _>("record_count"),
                "collection record count",
            )?,
            scan_budget_records,
            scan_budget_ciphertext_bytes,
            generation_id: Some(generation_id),
            projection_integrity_epoch: collection_projection_integrity_epoch(collection)?,
            projection_integrity_verified: collection_projection_integrity_verified(collection)?,
            catalog_revision,
            projection_format_version,
            semantic_engine_version,
            plan: plan.query,
            allowed_types: replica.allowed_types.clone(),
            last_order_values: Vec::new(),
            last_path: None,
            last_record_id: None,
            emitted_rows: 0,
            hard_expires_at: query_cursor_hard_expires_at()?,
            consumed_cursor_id: None,
            request_kind: HostedQueryRequestKind::CanonicalView,
            request_digest: canonical_view_request_digest(input)?,
            result_meta,
            exact_context,
            base_plan: None,
            base_invocation_id: None,
            base_context: None,
            base_operation_clock: None,
            execution_proof: None,
        }))
    }

    #[allow(clippy::too_many_arguments)]
    async fn start_obsidian_base_state(
        &self,
        transaction: &mut Transaction<'_, Postgres>,
        collection_id: Uuid,
        collection: &PgRow,
        replica: &Replica,
        input: &Value,
        catalog: &mdbase::runtime::CompiledCatalog,
        resource_documents: &[(String, String)],
    ) -> ApiResult<Result<HostedQueryState, OperationResult>> {
        let requested_path = input.get("path").and_then(Value::as_str).ok_or_else(|| {
            ApiError::bad_request("invalid_request", "Saved-view path is required.")
        })?;
        let Some((_, view_document)) = resource_documents
            .iter()
            .find(|(path, _)| path == requested_path)
        else {
            return Ok(Err(mdbase::runtime::invalid_operation_result(
                "view_not_found",
                format!("View resource '{requested_path}' was not found."),
            )));
        };
        let view_record = mdbase::runtime::CanonicalRecordInput {
            stable_id: None,
            path: requested_path.to_string(),
            document: view_document.clone(),
            file_size: view_document.len() as u64,
            file_mtime: None,
        };
        let planning = catalog
            .plan_hosted_obsidian_base(input, &view_record, &replica.allowed_types)
            .map_err(|error| {
                ApiError::bad_request(
                    error.code,
                    format!("Obsidian Base planning failed: {}", error.message),
                )
            })?;
        let base_plan = match planning {
            mdbase::runtime::HostedBasePlanning::Planned { plan } => *plan,
            mdbase::runtime::HostedBasePlanning::Invalid { result } => return Ok(Err(result)),
        };
        let (generation_id, catalog_revision, projection_format_version, semantic_engine_version) =
            base_query_binding(collection, catalog);
        let snapshot_head = number(collection.get::<i64, _>("head"), "collection head")?;
        let base_context = match (base_plan.context_path.as_deref(), generation_id) {
            (Some(path), Some(generation_id)) => {
                load_base_context_projection(
                    transaction,
                    collection_id,
                    generation_id,
                    snapshot_head,
                    &catalog_revision,
                    projection_format_version,
                    &semantic_engine_version,
                    path,
                )
                .await?
            }
            _ => None,
        };
        if let Some(context) = &base_context {
            if !replica.allowed_types.is_empty()
                && !context.facts.types.iter().any(|actual| {
                    replica
                        .allowed_types
                        .iter()
                        .any(|allowed| allowed.eq_ignore_ascii_case(actual))
                })
            {
                return Err(ApiError::forbidden(
                    "scope_denied",
                    "The Obsidian Base context is outside this application's record scope.",
                ));
            }
        }
        let mut candidate_input = json!({
            "select": ["path"],
            "pagination": "cursor",
        });
        if !base_plan.allowed_types.is_empty() {
            candidate_input["types"] = json!(base_plan.allowed_types);
        }
        let plan = catalog
            .compile_hosted_query(&candidate_input)
            .map_err(|error| ApiError::bad_request(error.code, error.message))?;
        let mut result_meta = serde_json::Map::new();
        result_meta.insert(
            "view".to_string(),
            json!({"path": base_plan.view_path, "id": base_plan.view_id}),
        );
        result_meta.insert(
            "context".to_string(),
            base_plan
                .context_path
                .as_ref()
                .map(|path| json!({"path": path}))
                .unwrap_or(Value::Null),
        );
        let (scan_budget_records, scan_budget_ciphertext_bytes) = hosted_query_scan_budgets();
        Ok(Ok(HostedQueryState {
            snapshot_head,
            snapshot_record_count: number(
                collection.get::<i64, _>("record_count"),
                "collection record count",
            )?,
            scan_budget_records,
            scan_budget_ciphertext_bytes,
            generation_id,
            projection_integrity_epoch: collection_projection_integrity_epoch(collection)?,
            projection_integrity_verified: collection_projection_integrity_verified(collection)?,
            catalog_revision,
            projection_format_version,
            semantic_engine_version,
            plan,
            allowed_types: replica.allowed_types.clone(),
            last_order_values: Vec::new(),
            last_path: None,
            last_record_id: None,
            emitted_rows: 0,
            hard_expires_at: query_cursor_hard_expires_at()?,
            consumed_cursor_id: None,
            request_kind: HostedQueryRequestKind::ObsidianBase,
            request_digest: canonical_view_request_digest(input)?,
            result_meta,
            exact_context: None,
            base_plan: Some(base_plan),
            base_invocation_id: None,
            base_context,
            base_operation_clock: Some(Utc::now().to_rfc3339()),
            execution_proof: None,
        }))
    }

    #[allow(clippy::too_many_arguments)]
    async fn load_query_cursor(
        &self,
        transaction: &mut Transaction<'_, Postgres>,
        collection_id: Uuid,
        replica: &Replica,
        cursor_id: Uuid,
        request_kind: HostedQueryRequestKind,
        request_digest: &str,
        data_key: &[u8; 32],
    ) -> ApiResult<HostedQueryState> {
        let row = sqlx::query(
            r#"SELECT c.snapshot_head, c.generation_id, c.catalog_revision,
                      c.projection_format_version, c.semantic_engine_version,
                      c.query_plan, c.query_digest, c.request_kind, c.request_digest,
                      c.result_meta, c.exact_context_ciphertext,
                      COALESCE(i.base_plan, c.base_plan) AS base_plan,
                      COALESCE(i.base_context, c.base_context) AS base_context,
                      COALESCE(i.base_operation_clock, c.base_operation_clock)
                        AS base_operation_clock,
                      c.base_invocation_id, c.last_order_values,
                      c.last_record_id, c.emitted_rows, c.hard_expires_at,
                      c.execution_proof_version, c.execution_proof_ciphertext,
                      c.execution_proof_bytes, c.snapshot_record_count,
                      c.scan_budget_records, c.scan_budget_ciphertext_bytes,
                      c.projection_integrity_epoch
               FROM hosted_provider_query_cursors c
               LEFT JOIN hosted_provider_base_query_invocations i
                 ON i.invocation_id = c.base_invocation_id
                AND i.collection_id = c.collection_id
                AND i.replica_id = c.replica_id
                AND i.scope_epoch = c.scope_epoch
                AND i.hard_expires_at > now()
               WHERE c.cursor_id = $1 AND c.collection_id = $2 AND c.replica_id = $3
                 AND c.scope_epoch = $4 AND c.expires_at > now()
                 AND c.hard_expires_at > now()
               FOR UPDATE OF c"#,
        )
        .bind(cursor_id)
        .bind(collection_id)
        .bind(replica.id)
        .bind(to_i64(replica.scope_epoch, "scope epoch")?)
        .fetch_optional(&mut **transaction)
        .await?
        .ok_or_else(|| {
            query_cursor_conflict(
                "query_cursor_expired",
                "The hosted query cursor is expired, consumed, or outside this capability scope.",
            )
        })?;
        let plan: mdbase::runtime::HostedQueryPlan = serde_json::from_value(row.get("query_plan"))
            .map_err(|error| {
                ApiError::internal(format!("Stored hosted query plan is invalid: {error}"))
            })?;
        plan.validate_integrity().map_err(|error| {
            ApiError::internal(format!(
                "Stored hosted query plan failed integrity validation: {}",
                error.code
            ))
        })?;
        let stored_kind = match row.get::<String, _>("request_kind").as_str() {
            "query" => HostedQueryRequestKind::Query,
            "canonical_view" => HostedQueryRequestKind::CanonicalView,
            "obsidian_base" => HostedQueryRequestKind::ObsidianBase,
            _ => {
                return Err(ApiError::internal(
                    "Stored hosted query request kind is invalid.",
                ))
            }
        };
        if stored_kind != request_kind
            || decode_sha256_digest(request_digest)? != row.get::<Vec<u8>, _>("request_digest")
            || decode_sha256_digest(&plan.canonical_query_digest)?
                != row.get::<Vec<u8>, _>("query_digest")
        {
            return Err(query_cursor_conflict(
                "query_cursor_mismatch",
                "The hosted query cursor does not match the requested query.",
            ));
        }
        let proof_version = number(
            i64::from(row.get::<i32, _>("execution_proof_version")),
            "query execution proof version",
        )? as u32;
        if proof_version != HOSTED_QUERY_EXECUTION_PROOF_VERSION {
            return Err(query_cursor_conflict(
                "query_cursor_upgrade_required",
                "The hosted query cursor predates the current bounded execution proof.",
            ));
        }
        let proof_ciphertext = row
            .get::<Option<Vec<u8>>, _>("execution_proof_ciphertext")
            .ok_or_else(|| ApiError::internal("Stored query execution proof is absent."))?;
        let proof_bytes = number(
            row.get::<i64, _>("execution_proof_bytes"),
            "query execution proof bytes",
        )?;
        if proof_bytes != proof_ciphertext.len() as u64 {
            return Err(ApiError::internal(
                "Stored query execution proof byte accounting is invalid.",
            ));
        }
        let execution_proof: HostedQueryExecutionProofV1 = self
            .crypto
            .decrypt_json(
                data_key,
                &proof_ciphertext,
                &query_cursor_execution_proof_aad(
                    collection_id,
                    replica.id,
                    replica.scope_epoch,
                    cursor_id,
                    proof_version,
                    &plan.canonical_query_digest,
                ),
            )
            .map_err(|_| {
                query_cursor_conflict(
                    "query_cursor_invalidated",
                    "The hosted query cursor execution proof is invalid.",
                )
            })?;
        let mut order_values = row
            .get::<Value, _>("last_order_values")
            .as_array()
            .cloned()
            .ok_or_else(|| ApiError::internal("Stored hosted query keyset is invalid."))?;
        let base_plan = row
            .get::<Option<Value>, _>("base_plan")
            .map(|value| {
                serde_json::from_value::<mdbase::runtime::HostedBasePlan>(value).map_err(|error| {
                    ApiError::internal(format!("Stored Obsidian Base plan is invalid: {error}"))
                })
            })
            .transpose()?;
        if let Some(base_plan) = &base_plan {
            base_plan.validate_integrity().map_err(|error| {
                ApiError::internal(format!(
                    "Stored Obsidian Base plan failed integrity validation: {}",
                    error.code
                ))
            })?;
        }
        let expected_order_values = base_plan
            .as_ref()
            .map_or(
                plan.order.len(),
                mdbase::runtime::HostedBasePlan::order_arity,
            )
            .saturating_add(1);
        if order_values.len() != expected_order_values {
            return Err(ApiError::internal(
                "Stored hosted query keyset does not match its query plan.",
            ));
        }
        let last_path = order_values
            .pop()
            .and_then(|value| value.as_str().map(String::from))
            .ok_or_else(|| ApiError::internal("Stored hosted query path key is invalid."))?;
        let exact_context = row
            .get::<Option<Vec<u8>>, _>("exact_context_ciphertext")
            .map(|ciphertext| {
                self.crypto.decrypt_json(
                    data_key,
                    &ciphertext,
                    &query_cursor_context_aad(collection_id, cursor_id),
                )
            })
            .transpose()?;
        enforce_exact_context_budget(&plan, exact_context.as_ref())?;
        let result_meta = row
            .get::<Value, _>("result_meta")
            .as_object()
            .cloned()
            .ok_or_else(|| ApiError::internal("Stored hosted query result metadata is invalid."))?;
        let base_context = row
            .get::<Option<Value>, _>("base_context")
            .map(|value| {
                serde_json::from_value(value).map_err(|error| {
                    ApiError::internal(format!(
                        "Stored Obsidian Base context projection is invalid: {error}"
                    ))
                })
            })
            .transpose()?;
        let base_operation_clock = row.get::<Option<String>, _>("base_operation_clock");
        if (stored_kind == HostedQueryRequestKind::ObsidianBase)
            != (base_plan.is_some() && base_operation_clock.is_some())
        {
            return Err(ApiError::internal(
                "Stored hosted query request kind and Base state disagree.",
            ));
        }
        let mut state = HostedQueryState {
            snapshot_head: number(row.get("snapshot_head"), "query snapshot head")?,
            snapshot_record_count: number(
                row.get("snapshot_record_count"),
                "query snapshot record count",
            )?,
            scan_budget_records: number(row.get("scan_budget_records"), "query scan budget")?,
            scan_budget_ciphertext_bytes: number(
                row.get("scan_budget_ciphertext_bytes"),
                "query ciphertext scan budget",
            )?,
            generation_id: row.get("generation_id"),
            projection_integrity_epoch: row
                .get::<Option<i64>, _>("projection_integrity_epoch")
                .map(|epoch| number(epoch, "projection integrity epoch"))
                .transpose()?,
            projection_integrity_verified: true,
            catalog_revision: row.get("catalog_revision"),
            projection_format_version: number(
                i64::from(row.get::<i32, _>("projection_format_version")),
                "projection format version",
            )? as u32,
            semantic_engine_version: row.get("semantic_engine_version"),
            plan,
            allowed_types: replica.allowed_types.clone(),
            last_order_values: order_values,
            last_path: Some(last_path),
            last_record_id: row.get("last_record_id"),
            emitted_rows: number(row.get("emitted_rows"), "emitted query rows")?,
            hard_expires_at: row.get("hard_expires_at"),
            consumed_cursor_id: Some(cursor_id),
            request_kind: stored_kind,
            request_digest: request_digest.to_string(),
            result_meta,
            exact_context,
            base_plan,
            base_invocation_id: row.get("base_invocation_id"),
            base_context,
            base_operation_clock,
            execution_proof: None,
        };
        validate_execution_proof(&execution_proof, &state, replica)?;
        state.execution_proof = Some(execution_proof);
        Ok(state)
    }
}
