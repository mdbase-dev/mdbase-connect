impl HostedProvider {
    async fn execute_hosted_query_request(
        &self,
        collection_id: Uuid,
        replica: &Replica,
        request_id: Uuid,
        input: &Value,
        request_kind: HostedQueryRequestKind,
    ) -> ApiResult<OperationResult> {
        let budgets = crate::execution_budget::hosted_execution_budgets();
        let deadline_ms = budgets
            .operation_deadline_ms
            .min(budgets.snapshot_lifetime_ms);
        let (cleanup_complete, cleanup_observed) = tokio::sync::oneshot::channel();
        match tokio::time::timeout(
            Duration::from_millis(deadline_ms),
            Box::pin(self.execute_hosted_query_request_inner(
                collection_id,
                replica,
                request_id,
                input,
                request_kind,
                Some(cleanup_complete),
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
                let cleanup_ms = budgets.cancellation_cleanup_ms;
                let cleaned = matches!(
                    tokio::time::timeout(
                        Duration::from_millis(cleanup_ms),
                        cleanup_observed,
                    )
                    .await,
                    Ok(Ok(true)) | Ok(Err(_))
                );
                if !cleaned {
                    return Err(ApiError::new(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "hosted_cancellation_cleanup_failed",
                        "The hosted query timed out and its database cleanup could not be confirmed.",
                    )
                    .with_details(json!({
                        "budget": "cancellation_cleanup_ms",
                        "limit": cleanup_ms,
                    })));
                }
                Err(query_budget_error(
                    "hosted_time_budget_exceeded",
                    "The hosted query exceeded its database statement-time budget.",
                    "wall_time_ms",
                    deadline_ms,
                    deadline_ms,
                ))
            }
            Ok(result) => result,
            Err(_) => {
                let cleanup_ms = budgets.cancellation_cleanup_ms;
                let cleaned = matches!(
                    tokio::time::timeout(
                        Duration::from_millis(cleanup_ms),
                        cleanup_observed,
                    )
                    .await,
                    Ok(Ok(true)) | Ok(Err(_))
                );
                if !cleaned {
                    return Err(ApiError::new(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "hosted_cancellation_cleanup_failed",
                        "The hosted query timed out and its database cleanup could not be confirmed.",
                    )
                    .with_details(json!({
                        "budget": "cancellation_cleanup_ms",
                        "limit": cleanup_ms,
                    })));
                }
                Err(query_budget_error(
                    "hosted_time_budget_exceeded",
                    "The hosted query exceeded its operation or snapshot-lifetime budget.",
                    "wall_time_ms",
                    deadline_ms,
                    deadline_ms.saturating_add(1),
                ))
            }
        }
    }

    async fn execute_hosted_query_request_inner(
        &self,
        collection_id: Uuid,
        replica: &Replica,
        request_id: Uuid,
        input: &Value,
        request_kind: HostedQueryRequestKind,
        cancellation_cleanup: Option<tokio::sync::oneshot::Sender<bool>>,
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
            cleanup_base_query_invocations(&self.pool, collection_id, None).await?;
            return Ok(empty_query_result());
        }
        let page_input_digest = query_page_input_digest(request_kind, input)?;

        let started = Instant::now();
        let mut activity = HostedQueryActivityGuard::begin(self.query_activity.clone());
        let budgets = crate::execution_budget::hosted_execution_budgets();
        let connection_wait_ms =
            mdbase::runtime::HostedQueryBudgets::default().max_connection_wait_ms;
        let accounted_execution_bytes = budgets.accounted_execution_bytes_per_operation;
        let accounted_execution_permits = u32::try_from(accounted_execution_bytes)
            .map_err(|_| ApiError::internal("The hosted execution memory budget is invalid."))?;
        let _memory_permit = match tokio::time::timeout(
            Duration::from_millis(connection_wait_ms),
            self.query_memory_permits
                .clone()
                .acquire_many_owned(accounted_execution_permits),
        )
        .await
        {
            Ok(Ok(permit)) => HostedExecutionMemoryGuard::new(
                permit,
                self.query_activity.clone(),
                accounted_execution_bytes,
            ),
            Ok(Err(_)) => {
                return Err(ApiError::internal(
                    "The hosted query memory-permit gate is unavailable.",
                ));
            }
            Err(_) => {
                return Err(query_budget_error(
                    "hosted_memory_permit_budget_exceeded",
                    "The hosted query exceeded its process memory-permit wait budget.",
                    "accounted_execution_bytes_per_process",
                    budgets.accounted_execution_bytes_per_process,
                    budgets
                        .accounted_execution_bytes_per_process
                        .saturating_add(1),
                ));
            }
        };
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
            self.query_pool.acquire(),
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
        // Candidate predicates and generation bindings have collection-specific
        // selectivity. PostgreSQL otherwise switches a cached prepared statement
        // to its generic plan after five executions; the sustained 100k group
        // mission proves that generic plan doubles page latency. Keep the choice
        // local to this bounded transaction so every page is costed with its
        // actual candidate/type/generation values.
        sqlx::query("SET LOCAL plan_cache_mode = force_custom_plan")
            .execute(&mut *transaction)
            .await?;
        // Bounded page queries are deliberately small and short lived. JIT's
        // compilation floor is larger than their latency budget, especially
        // when a planner guard discourages a full-snapshot sort.
        sqlx::query("SET LOCAL jit = off")
            .execute(&mut *transaction)
            .await?;
        // Every query transaction holds the shared side until commit. Rollback
        // tooling takes the exclusive side, waits for in-flight pages, persists
        // the suspension flag, and can then inspect/drain without a new-admission
        // race. Cursor release is handled above and intentionally remains live.
        sqlx::query(
            "SELECT pg_advisory_xact_lock_shared(hashtextextended('mdbase-hosted-query-admission-v1', 0))",
        )
        .execute(&mut *transaction)
        .await?;
        let query_admission_suspended: bool = sqlx::query_scalar(
            "SELECT query_admission_suspended FROM hosted_provider_runtime_control WHERE singleton = true",
        )
        .fetch_one(&mut *transaction)
        .await?;
        if query_admission_suspended {
            return Err(ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "hosted_query_admission_suspended",
                "Hosted query admission is temporarily suspended for a controlled rollout operation.",
            ));
        }
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
            cancellation_cleanup,
        );

        let collection = sqlx::query(
            r#"SELECT collection.head, collection.record_count,
                      collection.resource_revision, collection.wrapped_data_key,
                      collection.resources_ciphertext,
                      active_catalog_revision, active_projection_format_version,
                      active_semantic_engine_version, active_projection_generation_id,
                      generation.integrity_epoch AS projection_integrity_epoch,
                      generation.integrity_verified_epoch AS projection_integrity_verified_epoch
               FROM hosted_provider_collections collection
               LEFT JOIN hosted_provider_projection_generations generation
                 ON generation.collection_id = collection.id
                AND generation.generation_id = collection.active_projection_generation_id
               WHERE collection.id = $1 AND collection.state = 'active'"#,
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
        // A replay receipt can contain exact/body output. Count its decrypt and
        // bounded decompression in the same plaintext lifetime used by ordinary
        // execution, even when no catalogue or record decrypt follows.
        activity.acquire_plaintext();
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
        enforce_hosted_query_scan_budget(&state)?;
        validate_generation_binding(&mut transaction, collection_id, &mut state).await?;

        let prior_execution = state
            .execution_proof
            .as_ref()
            .map(|proof| proof.execution.clone());
        let (page, execution) = match (state.base_plan.as_ref(), prior_execution) {
            (
                Some(_),
                Some(HostedQueryExecutionModeV1::Base {
                    projection_fallback,
                    path_keyset,
                    total_count,
                }),
            ) => (
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
                    path_keyset,
                    total_count,
                )
                .await?,
                HostedQueryExecutionModeV1::Base {
                    projection_fallback,
                    path_keyset,
                    total_count,
                },
            ),
            (Some(base_plan), None) => {
                let projection_fallback = if state.generation_id.is_some()
                    && !base_requires_relationships(base_plan)
                {
                    false
                } else {
                    base_projection_fallback_exists(&mut transaction, collection_id, &state).await?
                };
                let page = execute_bounded_base_page(
                        &mut transaction,
                        &self.crypto,
                        &data_key,
                        collection_id,
                        &state,
                        &catalog,
                        requested_page_size,
                        started,
                        projection_fallback,
                        true,
                        None,
                    )
                    .await?;
                let path_keyset = page.base_path_keyset;
                let total_count = if path_keyset { page.total_count } else { None };
                (
                    page,
                    HostedQueryExecutionModeV1::Base {
                        projection_fallback,
                        path_keyset,
                        total_count,
                    },
                )
            }
            (Some(_), Some(_)) => {
                return Err(query_cursor_conflict(
                    "query_cursor_invalidated",
                    "The hosted query cursor execution mode does not match its Base plan.",
                ));
            }
            (
                None,
                Some(HostedQueryExecutionModeV1::ProjectedExact {
                    total_count,
                    groups,
                }),
            ) => {
                let candidate_types = candidate_type_union(&state.plan.candidate).ok_or_else(|| {
                    ApiError::bad_request(
                        "unsupported_hosted_candidate",
                        "The hosted query candidate plan is not available in the production SQL executor.",
                    )
                })?;
                (
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
                        Some((total_count, groups.clone())),
                    )
                    .await?,
                    HostedQueryExecutionModeV1::ProjectedExact {
                        total_count,
                        groups,
                    },
                )
            }
            (
                None,
                Some(HostedQueryExecutionModeV1::BoundedResidual {
                    force_exact_residual,
                    bounded_ordering,
                }),
            ) => (
                execute_bounded_residual_page(
                    &mut transaction,
                    &self.crypto,
                    &data_key,
                    collection_id,
                    &state,
                    &catalog,
                    requested_page_size,
                    started,
                    force_exact_residual,
                    bounded_ordering,
                )
                .await?,
                HostedQueryExecutionModeV1::BoundedResidual {
                    force_exact_residual,
                    bounded_ordering,
                },
            ),
            (None, Some(HostedQueryExecutionModeV1::Base { .. })) => {
                return Err(query_cursor_conflict(
                    "query_cursor_invalidated",
                    "The hosted query cursor Base mode has no Base plan.",
                ));
            }
            (None, None) => {
                let projection_fallback = if state.projection_integrity_verified {
                    false
                } else {
                    let fallback = projection_fallback_exists(
                        &mut transaction,
                        collection_id,
                        &state,
                    )
                    .await?;
                    if !fallback {
                        mark_projection_integrity_verified(
                            &mut transaction,
                            collection_id,
                            &mut state,
                        )
                        .await?;
                    }
                    fallback
                };
                let candidate_types = candidate_type_union(&state.plan.candidate).ok_or_else(|| {
                    ApiError::bad_request(
                        "unsupported_hosted_candidate",
                        "The hosted query candidate plan is not yet available in the production SQL executor.",
                    )
                })?;
                let scalar_order_plan = projected_scalar_order_supported(&state.plan);
                let direct_order_plan = projected_direct_order_supported(&state.plan);
                let scalar_order_values_valid = scalar_order_plan
                    && (state.projection_integrity_verified
                        || projected_scalar_order_values_are_valid(
                            &mut transaction,
                            collection_id,
                            &state,
                            &candidate_types,
                        )
                        .await?);
                let exact_candidate_plan =
                    candidate_predicate_is_projection_exact(&state.plan.candidate);
                let exact_candidate_values_valid = exact_candidate_plan
                    && (state.projection_integrity_verified
                        || projected_exact_candidate_values_are_valid(
                            &mut transaction,
                            collection_id,
                            &state,
                            &candidate_types,
                        )
                        .await?);
                let grouping_plan = projected_grouping_supported(&state.plan);
                let grouping_values_valid = grouping_plan
                    && (state.projection_integrity_verified
                        || projected_scalar_group_values_are_valid(
                            &mut transaction,
                            collection_id,
                            &state,
                            &candidate_types,
                        )
                        .await?);
                if state.plan.residual.projection_filter_safe
                    && !state.plan.requirements.diagnostic_type_matchers
                    && (!state.plan.requirements.bounded_grouping || grouping_values_valid)
                    && exact_candidate_values_valid
                    && !projection_fallback
                    && scalar_order_values_valid
                    && direct_order_plan
                {
                    let page = execute_projected_page(
                        &mut transaction,
                        &self.crypto,
                        &data_key,
                        collection_id,
                        &state,
                        &catalog,
                        &candidate_types,
                        requested_page_size,
                        started,
                        None,
                    )
                    .await?;
                    let execution = HostedQueryExecutionModeV1::ProjectedExact {
                        total_count: page.total_count,
                        groups: page.groups.clone(),
                    };
                    (page, execution)
                } else {
                    let force_exact_residual =
                        (exact_candidate_plan && !exact_candidate_values_valid)
                            || (scalar_order_plan && !scalar_order_values_valid)
                            || (grouping_plan && !grouping_values_valid);
                    let bounded_ordering = !direct_order_plan && !state.plan.order.is_empty();
                    (
                        execute_bounded_residual_page(
                            &mut transaction,
                            &self.crypto,
                            &data_key,
                            collection_id,
                            &state,
                            &catalog,
                            requested_page_size,
                            started,
                            force_exact_residual,
                            bounded_ordering,
                        )
                        .await?,
                        HostedQueryExecutionModeV1::BoundedResidual {
                            force_exact_residual,
                            bounded_ordering,
                        },
                    )
                }
            }
        };
        if state.execution_proof.is_none() {
            state.execution_proof = Some(execution_proof_for_state(&state, replica, execution));
        }

        let page_count = page.results.len() as u64;
        let semantic_offset = state
            .base_plan
            .as_ref()
            .map_or(state.plan.offset, |plan| plan.offset);
        let consumed = semantic_offset
            .saturating_add(state.emitted_rows)
            .saturating_add(page_count);
        let has_more = page.has_more;
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
        cleanup_base_query_invocations(&mut *transaction, collection_id, None).await?;
        let serialized_diagnostics =
            serde_json::to_value(&page.diagnostics).unwrap_or_else(|_| json!([]));
        let mut meta = json!({
            "has_more": has_more,
            "cursor": next_cursor,
        });
        let final_total_count = page.total_count.or((!has_more).then_some(consumed));
        if let Some(total_count) = final_total_count {
            meta["total_count"] = json!(total_count);
        } else {
            meta["total_count_outcome"] = json!({
                "status": "deferred",
                "budget": "eager_summary_rows",
                "limit": crate::HostedExecutionBudgetManifest::published()
                    .defaults
                    .eager_summary_rows,
            });
        }
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
            exact_ciphertext_bytes = page.exact_ciphertext_bytes,
            elapsed_ms = started.elapsed().as_millis() as u64,
            database_pool_size = self.query_pool.size(),
            database_pool_idle = self.query_pool.num_idle(),
            rss_bytes = memory.rss_bytes.unwrap_or(0),
            pss_bytes = memory.pss_bytes.unwrap_or(0),
            cgroup_current_bytes = memory.cgroup_current_bytes.unwrap_or(0),
            "privacy-safe hosted provider metric"
        );
        Ok(result)
    }
}
