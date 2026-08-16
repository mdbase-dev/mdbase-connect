impl HostedProvider {
    async fn execute_hosted_query_request(
        &self,
        collection_id: Uuid,
        replica: &Replica,
        request_id: Uuid,
        input: &Value,
        request_kind: HostedQueryRequestKind,
    ) -> ApiResult<OperationResult> {
        let budgets = &HostedExecutionBudgetManifest::published().defaults;
        let deadline_ms = budgets
            .operation_deadline_ms
            .min(budgets.snapshot_lifetime_ms);
        match tokio::time::timeout(
            Duration::from_millis(deadline_ms),
            Box::pin(self.execute_hosted_query_request_inner(
                collection_id,
                replica,
                request_id,
                input,
                request_kind,
            )),
        )
        .await
        {
            Ok(Err(error))
                if error.code == "provider_database_timeout"
                    && error
                        .details
                        .as_ref()
                        .and_then(|details| details["timeout_class"].as_str())
                        == Some("statement") =>
            {
                Err(query_budget_error(
                    "hosted_time_budget_exceeded",
                    "The hosted query exceeded its database statement-time budget.",
                    "wall_time_ms",
                    deadline_ms,
                    deadline_ms,
                ))
            }
            Ok(result) => result,
            Err(_) => Err(query_budget_error(
                "hosted_time_budget_exceeded",
                "The hosted query exceeded its operation or snapshot-lifetime budget.",
                "wall_time_ms",
                deadline_ms,
                deadline_ms.saturating_add(1),
            )),
        }
    }

    async fn execute_hosted_query_request_inner(
        &self,
        collection_id: Uuid,
        replica: &Replica,
        request_id: Uuid,
        input: &Value,
        request_kind: HostedQueryRequestKind,
    ) -> ApiResult<OperationResult> {
        if let Some(release) = input.get("release_cursor") {
            let cursor = release.as_str().ok_or_else(|| {
                ApiError::bad_request(
                    "invalid_query_cursor",
                    "The hosted query cursor must be an opaque string.",
                )
            })?;
            let cursor_id = decode_query_cursor(cursor)?;
            sqlx::query(
                r#"DELETE FROM hosted_provider_query_cursors
                   WHERE cursor_id = $1 AND collection_id = $2 AND replica_id = $3
                     AND scope_epoch = $4 AND request_kind = $5"#,
            )
            .bind(cursor_id)
            .bind(collection_id)
            .bind(replica.id)
            .bind(to_i64(replica.scope_epoch, "scope epoch")?)
            .bind(request_kind.as_str())
            .execute(&self.pool)
            .await?;
            cleanup_base_query_invocations(&self.pool, collection_id).await?;
            return Ok(empty_query_result());
        }
        let page_input_digest = query_page_input_digest(request_kind, input)?;

        let started = Instant::now();
        let mut activity = HostedQueryActivityGuard::begin(self.query_activity.clone());
        let connection_wait_ms =
            mdbase::runtime::HostedQueryBudgets::default().max_connection_wait_ms;
        let _scan_permit = match tokio::time::timeout(
            Duration::from_millis(connection_wait_ms),
            self.query_scan_permits.clone().acquire_owned(),
        )
        .await
        {
            Ok(Ok(permit)) => HostedScanPermitGuard::new(permit, self.query_activity.clone()),
            Ok(Err(_)) => {
                return Err(ApiError::internal(
                    "The hosted query scan-permit gate is unavailable.",
                ));
            }
            Err(_) => {
                return Err(query_budget_error(
                    "hosted_scan_permit_budget_exceeded",
                    "The hosted query exceeded its scan-permit wait budget.",
                    "scan_permit_wait_ms",
                    connection_wait_ms,
                    started.elapsed().as_millis() as u64,
                ));
            }
        };
        let mut connection = match tokio::time::timeout(
            Duration::from_millis(connection_wait_ms),
            self.pool.acquire(),
        )
        .await
        {
            Ok(connection) => connection?,
            Err(_) => {
                return Err(query_budget_error(
                    "hosted_connection_budget_exceeded",
                    "The hosted query exceeded its database-connection wait budget.",
                    "connection_wait_ms",
                    connection_wait_ms,
                    started.elapsed().as_millis() as u64,
                ));
            }
        };
        let mut transaction = connection.begin().await?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            .execute(&mut *transaction)
            .await?;
        let budgets = &HostedExecutionBudgetManifest::published().defaults;
        let statement_timeout_ms = budgets
            .operation_deadline_ms
            .min(budgets.snapshot_lifetime_ms)
            .saturating_sub(budgets.cancellation_cleanup_ms)
            .max(1);
        sqlx::query("SELECT set_config('statement_timeout', $1, true)")
            .bind(format!("{statement_timeout_ms}ms"))
            .execute(&mut *transaction)
            .await?;
        sqlx::query("SET LOCAL lock_timeout = 5000")
            .execute(&mut *transaction)
            .await?;
        sqlx::query("SET LOCAL idle_in_transaction_session_timeout = 10000")
            .execute(&mut *transaction)
            .await?;
        let session_fence = format!("mdbase-hosted-query/{}", Uuid::new_v4());
        sqlx::query("SELECT set_config('application_name', $1, true)")
            .bind(&session_fence)
            .execute(&mut *transaction)
            .await?;
        let backend_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(&mut *transaction)
            .await?;
        let mut database_cancellation = PostgresQueryCancellationGuard::new(
            self.query_cancellation_pool.clone(),
            backend_pid,
            session_fence,
        );

        let collection = sqlx::query(
            r#"SELECT head, resource_revision, wrapped_data_key, resources_ciphertext,
                      active_catalog_revision, active_projection_format_version,
                      active_semantic_engine_version, active_projection_generation_id
               FROM hosted_provider_collections
               WHERE id = $1 AND state = 'active'"#,
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
            .collection_key(collection_id, collection.get("wrapped_data_key"))
            .await?;
        sqlx::query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1::text || ':' || $2::text, 0))",
        )
        .bind(replica.id)
        .bind(request_id)
        .execute(&mut *transaction)
        .await?;
        if let Some(result) = replay_query_page_receipt(
            &mut transaction,
            &self.crypto,
            &data_key,
            collection_id,
            replica,
            request_id,
            request_kind,
            &page_input_digest,
        )
        .await?
        {
            transaction.commit().await?;
            database_cancellation.disarm();
            return Ok(result);
        }
        activity.acquire_plaintext();
        let resources: SyncCollectionResources = self.crypto.decrypt_json(
            &data_key,
            collection.get("resources_ciphertext"),
            &resources_aad(collection_id),
        )?;
        let stored_resource_revision: String = collection.get("resource_revision");
        if resources.revision != stored_resource_revision {
            return Err(ApiError::internal(
                "The encrypted resource catalog revision does not match collection metadata.",
            ));
        }
        let resource_documents =
            load_resource_documents(&mut transaction, &self.crypto, &data_key, collection_id)
                .await?;
        let catalog = compile_point_catalog(resources, resource_documents.clone())?;
        let transport_page_size = query_page_size(input)?;
        let mut state = if let Some(cursor) = input.get("cursor") {
            let cursor = cursor.as_str().ok_or_else(|| {
                ApiError::bad_request(
                    "invalid_query_cursor",
                    "The hosted query cursor must be an opaque string.",
                )
            })?;
            let request_digest = match request_kind {
                HostedQueryRequestKind::Query => {
                    catalog
                        .compile_hosted_query(input)
                        .map_err(|error| ApiError::bad_request(error.code, error.message))?
                        .canonical_query_digest
                }
                HostedQueryRequestKind::CanonicalView => canonical_view_request_digest(input)?,
                HostedQueryRequestKind::ObsidianBase => canonical_view_request_digest(input)?,
            };
            self.load_query_cursor(
                &mut transaction,
                collection_id,
                replica,
                decode_query_cursor(cursor)?,
                request_kind,
                &request_digest,
                &data_key,
            )
            .await?
        } else {
            match request_kind {
                HostedQueryRequestKind::Query => {
                    self.start_query_state(
                        &mut transaction,
                        collection_id,
                        &collection,
                        replica,
                        input,
                        &catalog,
                        &data_key,
                    )
                    .await?
                }
                HostedQueryRequestKind::CanonicalView => {
                    match self
                        .start_canonical_view_state(
                            &mut transaction,
                            collection_id,
                            &collection,
                            replica,
                            input,
                            &catalog,
                            &resource_documents,
                            &data_key,
                        )
                        .await?
                    {
                        Ok(state) => state,
                        Err(result) => {
                            transaction.commit().await?;
                            database_cancellation.disarm();
                            return Ok(result);
                        }
                    }
                }
                HostedQueryRequestKind::ObsidianBase => {
                    match self
                        .start_obsidian_base_state(
                            &mut transaction,
                            collection_id,
                            &collection,
                            replica,
                            input,
                            &catalog,
                            &resource_documents,
                        )
                        .await?
                    {
                        Ok(state) => state,
                        Err(result) => {
                            transaction.commit().await?;
                            database_cancellation.disarm();
                            return Ok(result);
                        }
                    }
                }
            }
        };
        let requested_page_size = if input.get("limit").is_none() {
            state
                .base_plan
                .as_ref()
                .and_then(|plan| plan.suggested_page_size)
                .unwrap_or(transport_page_size)
        } else {
            transport_page_size
        };
        if requested_page_size > state.plan.budgets.max_page_size {
            return Ok(mdbase::runtime::invalid_operation_result(
                "hosted_result_budget_exceeded",
                format!(
                    "Requested page size exceeds the hosted maximum of {}.",
                    state.plan.budgets.max_page_size
                ),
            ));
        }
        if state.catalog_revision != catalog.resource_revision() {
            return Err(query_cursor_conflict(
                "query_catalog_changed",
                "The semantic catalog changed while this hosted query was being paged.",
            ));
        }
        validate_generation_binding(&mut transaction, collection_id, &state).await?;

        let projection_fallback = if let Some(base_plan) = state.base_plan.as_ref() {
            if state.generation_id.is_some() && !base_requires_relationships(base_plan) {
                false
            } else {
                base_projection_fallback_exists(&mut transaction, collection_id, &state).await?
            }
        } else {
            projection_fallback_exists(&mut transaction, collection_id, &state).await?
        };
        let page = if state.base_plan.is_some() {
            execute_bounded_base_page(
                &mut transaction,
                &self.crypto,
                &data_key,
                collection_id,
                &state,
                &catalog,
                requested_page_size,
                started,
                projection_fallback,
            )
            .await?
        } else {
            let candidate_types = candidate_type_union(&state.plan.candidate).ok_or_else(|| {
                ApiError::bad_request(
                    "unsupported_hosted_candidate",
                    "The hosted query candidate plan is not yet available in the production SQL executor.",
                )
            })?;
            let scalar_order_plan = projected_scalar_order_supported(&state.plan);
            let scalar_order_values_valid = scalar_order_plan
                && projected_scalar_order_values_are_valid(
                    &mut transaction,
                    collection_id,
                    &state,
                    &candidate_types,
                )
                .await?;
            let exact_candidate_plan =
                candidate_predicate_is_projection_exact(&state.plan.candidate);
            let exact_candidate_values_valid = exact_candidate_plan
                && projected_exact_candidate_values_are_valid(
                    &mut transaction,
                    collection_id,
                    &state,
                    &candidate_types,
                )
                .await?;
            let grouping_plan = projected_grouping_supported(&state.plan);
            let grouping_values_valid = grouping_plan
                && projected_scalar_group_values_are_valid(
                    &mut transaction,
                    collection_id,
                    &state,
                    &candidate_types,
                )
                .await?;
            if state.plan.residual.projection_filter_safe
                && !state.plan.requirements.diagnostic_type_matchers
                && (!state.plan.requirements.bounded_grouping || grouping_values_valid)
                && exact_candidate_values_valid
                && !projection_fallback
                && scalar_order_values_valid
            {
                execute_projected_page(
                    &mut transaction,
                    &self.crypto,
                    &data_key,
                    collection_id,
                    &state,
                    &catalog,
                    &candidate_types,
                    requested_page_size,
                    started,
                )
                .await?
            } else {
                execute_bounded_residual_page(
                    &mut transaction,
                    &self.crypto,
                    &data_key,
                    collection_id,
                    &state,
                    &catalog,
                    requested_page_size,
                    started,
                    (exact_candidate_plan && !exact_candidate_values_valid)
                        || (scalar_order_plan && !scalar_order_values_valid)
                        || (grouping_plan && !grouping_values_valid),
                )
                .await?
            }
        };

        let page_count = page.results.len() as u64;
        let semantic_offset = state
            .base_plan
            .as_ref()
            .map_or(state.plan.offset, |plan| plan.offset);
        let consumed = semantic_offset
            .saturating_add(state.emitted_rows)
            .saturating_add(page_count);
        let has_more = consumed < page.total_count;
        if let Some(consumed_cursor_id) = state.consumed_cursor_id.take() {
            sqlx::query("DELETE FROM hosted_provider_query_cursors WHERE cursor_id = $1")
                .bind(consumed_cursor_id)
                .execute(&mut *transaction)
                .await?;
        }
        let next_cursor = if has_more {
            let boundary = page.last_boundary.as_ref().ok_or_else(|| {
                ApiError::internal("A hosted query reported more rows without a keyset boundary.")
            })?;
            let cursor_id = Uuid::new_v4();
            insert_query_cursor(
                &mut transaction,
                collection_id,
                replica,
                cursor_id,
                &state,
                &boundary.order_values,
                &boundary.path,
                boundary.record_id,
                state.emitted_rows.saturating_add(page_count),
                &self.crypto,
                &data_key,
            )
            .await?;
            Some(encode_query_cursor(cursor_id))
        } else {
            None
        };
        cleanup_base_query_invocations(&mut *transaction, collection_id).await?;
        let serialized_diagnostics =
            serde_json::to_value(&page.diagnostics).unwrap_or_else(|_| json!([]));
        let mut meta = json!({
            "total_count": page.total_count,
            "has_more": has_more,
            "cursor": next_cursor,
        });
        if let Some(groups) = page.groups {
            meta["groups"] = Value::Array(groups);
        }
        if let Some(meta) = meta.as_object_mut() {
            for (key, value) in state.result_meta {
                meta.insert(key, value);
            }
        }
        let result = OperationResult {
            valid: true,
            result: json!({
                "results": page.results,
                "meta": meta,
                "diagnostics": serialized_diagnostics,
            }),
            diagnostics: page.diagnostics,
        };
        store_query_page_receipt(
            &mut transaction,
            &self.crypto,
            &data_key,
            collection_id,
            replica,
            request_id,
            request_kind,
            &page_input_digest,
            &result,
            state.hard_expires_at,
        )
        .await?;
        transaction.commit().await?;
        database_cancellation.disarm();

        let memory = crate::HostedProcessMemory::capture();
        tracing::info!(
            target: "mdbase_connect::metrics",
            metric = "hosted_projection_query_page",
            snapshot_head = state.snapshot_head,
            candidate_rows = page.candidate_rows,
            results = result.result["results"].as_array().map_or(0, |rows| rows.len()) as u64,
            exact_documents = page.exact_documents,
            elapsed_ms = started.elapsed().as_millis() as u64,
            database_pool_size = self.pool.size(),
            database_pool_idle = self.pool.num_idle(),
            rss_bytes = memory.rss_bytes.unwrap_or(0),
            pss_bytes = memory.pss_bytes.unwrap_or(0),
            cgroup_current_bytes = memory.cgroup_current_bytes.unwrap_or(0),
            "privacy-safe hosted provider metric"
        );
        Ok(result)
    }

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
        Ok(HostedQueryState {
            snapshot_head: number(collection.get::<i64, _>("head"), "collection head")?,
            generation_id,
            catalog_revision,
            projection_format_version,
            semantic_engine_version,
            plan,
            allowed_types: replica.allowed_types.clone(),
            last_order_values: Vec::new(),
            last_path: None,
            last_record_id: None,
            emitted_rows: 0,
            hard_expires_at: Utc::now() + chrono::Duration::seconds(QUERY_CURSOR_HARD_SECONDS),
            consumed_cursor_id: None,
            request_kind: HostedQueryRequestKind::Query,
            request_digest,
            result_meta: serde_json::Map::new(),
            exact_context,
            base_plan: None,
            base_invocation_id: None,
            base_context: None,
            base_operation_clock: None,
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
        Ok(Ok(HostedQueryState {
            snapshot_head: number(collection.get::<i64, _>("head"), "collection head")?,
            generation_id: Some(generation_id),
            catalog_revision,
            projection_format_version,
            semantic_engine_version,
            plan: plan.query,
            allowed_types: replica.allowed_types.clone(),
            last_order_values: Vec::new(),
            last_path: None,
            last_record_id: None,
            emitted_rows: 0,
            hard_expires_at: Utc::now() + chrono::Duration::seconds(QUERY_CURSOR_HARD_SECONDS),
            consumed_cursor_id: None,
            request_kind: HostedQueryRequestKind::CanonicalView,
            request_digest: canonical_view_request_digest(input)?,
            result_meta,
            exact_context,
            base_plan: None,
            base_invocation_id: None,
            base_context: None,
            base_operation_clock: None,
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
        Ok(Ok(HostedQueryState {
            snapshot_head,
            generation_id,
            catalog_revision,
            projection_format_version,
            semantic_engine_version,
            plan,
            allowed_types: replica.allowed_types.clone(),
            last_order_values: Vec::new(),
            last_path: None,
            last_record_id: None,
            emitted_rows: 0,
            hard_expires_at: Utc::now() + chrono::Duration::seconds(QUERY_CURSOR_HARD_SECONDS),
            consumed_cursor_id: None,
            request_kind: HostedQueryRequestKind::ObsidianBase,
            request_digest: canonical_view_request_digest(input)?,
            result_meta,
            exact_context: None,
            base_plan: Some(base_plan),
            base_invocation_id: None,
            base_context,
            base_operation_clock: Some(Utc::now().to_rfc3339()),
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
                      c.last_record_id, c.emitted_rows, c.hard_expires_at
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
        Ok(HostedQueryState {
            snapshot_head: number(row.get("snapshot_head"), "query snapshot head")?,
            generation_id: row.get("generation_id"),
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
        })
    }
}
