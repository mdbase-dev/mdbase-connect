use super::operation_reads::{compile_point_catalog, load_direct_record, DirectRecordIdentity};
use super::*;

const QUERY_CURSOR_IDLE_SECONDS: i64 = 60;
const QUERY_CURSOR_HARD_SECONDS: i64 = 300;
const MAX_LIVE_QUERY_CURSORS_PER_REPLICA: i64 = 64;
const MAX_HOSTED_BASE_RELATIONSHIP_PAIRS: u64 = 65_536;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HostedQueryRequestKind {
    Query,
    CanonicalView,
    ObsidianBase,
}

impl HostedQueryRequestKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Query => "query",
            Self::CanonicalView => "canonical_view",
            Self::ObsidianBase => "obsidian_base",
        }
    }
}

struct HostedQueryState {
    snapshot_head: u64,
    generation_id: Option<Uuid>,
    catalog_revision: String,
    projection_format_version: u32,
    semantic_engine_version: String,
    plan: mdbase::runtime::HostedQueryPlan,
    last_order_values: Vec<Value>,
    last_path: Option<String>,
    last_record_id: Option<Uuid>,
    emitted_rows: u64,
    hard_expires_at: DateTime<Utc>,
    consumed_cursor_id: Option<Uuid>,
    request_kind: HostedQueryRequestKind,
    request_digest: String,
    result_meta: serde_json::Map<String, Value>,
    exact_context: Option<mdbase::runtime::CanonicalRecordInput>,
    base_plan: Option<mdbase::runtime::HostedBasePlan>,
    base_invocation_id: Option<Uuid>,
    base_context: Option<mdbase::runtime::SemanticProjection>,
    base_operation_clock: Option<String>,
}

struct ProjectedQueryRow {
    record_id: Uuid,
    canonical_path: String,
    projection: mdbase::runtime::SemanticProjection,
}

struct ProjectedQueryMetadata {
    record_id: Uuid,
    canonical_path: String,
    projection_bytes: u64,
}

struct ExecutedQueryPage {
    results: Vec<Value>,
    diagnostics: Vec<Diagnostic>,
    groups: Option<Vec<Value>>,
    total_count: u64,
    last_boundary: Option<QueryPageBoundary>,
    candidate_rows: u64,
    exact_documents: u64,
}

struct QueryPageBoundary {
    order_values: Vec<Value>,
    path: String,
    record_id: Uuid,
}

struct BaseEvaluationCancellationGuard {
    cancellation: mdbase::OperationCancellation,
    armed: bool,
}

impl BaseEvaluationCancellationGuard {
    fn new(cancellation: mdbase::OperationCancellation) -> Self {
        Self {
            cancellation,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for BaseEvaluationCancellationGuard {
    fn drop(&mut self) {
        if self.armed {
            self.cancellation.cancel();
        }
    }
}

impl HostedProvider {
    pub(super) async fn execute_hosted_query(
        &self,
        collection_id: Uuid,
        replica: &Replica,
        input: &Value,
    ) -> ApiResult<OperationResult> {
        self.execute_hosted_query_request(
            collection_id,
            replica,
            input,
            HostedQueryRequestKind::Query,
        )
        .await
    }

    pub(super) async fn execute_hosted_canonical_view(
        &self,
        collection_id: Uuid,
        replica: &Replica,
        input: &Value,
    ) -> ApiResult<OperationResult> {
        let request_kind = if input
            .get("path")
            .and_then(Value::as_str)
            .is_some_and(|path| path.ends_with(".base"))
        {
            HostedQueryRequestKind::ObsidianBase
        } else {
            HostedQueryRequestKind::CanonicalView
        };
        self.execute_hosted_query_request(collection_id, replica, input, request_kind)
            .await
    }

    async fn execute_hosted_query_request(
        &self,
        collection_id: Uuid,
        replica: &Replica,
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
        sqlx::query("SET LOCAL statement_timeout = 15000")
            .execute(&mut *transaction)
            .await?;
        sqlx::query("SET LOCAL lock_timeout = 5000")
            .execute(&mut *transaction)
            .await?;
        sqlx::query("SET LOCAL idle_in_transaction_session_timeout = 10000")
            .execute(&mut *transaction)
            .await?;
        let backend_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(&mut *transaction)
            .await?;
        let mut database_cancellation =
            PostgresQueryCancellationGuard::new(self.query_cancellation_pool.clone(), backend_pid);

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
            let path_order_descending = path_order_direction(&state.plan);
            if state.plan.residual.filter_fully_projected
                && !state.plan.requirements.diagnostic_type_matchers
                && !state.plan.requirements.bounded_grouping
                && candidate_predicate_is_total(&state.plan.candidate)
                && !projection_fallback
                && path_order_descending.is_some()
            {
                execute_projected_page(
                    &mut transaction,
                    &self.crypto,
                    &data_key,
                    collection_id,
                    &state,
                    &catalog,
                    &candidate_types,
                    path_order_descending.unwrap_or(false),
                    requested_page_size,
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
        transaction.commit().await?;
        database_cancellation.disarm();

        let memory = crate::HostedProcessMemory::capture();
        tracing::info!(
            target: "mdbase_connect::metrics",
            metric = "hosted_projection_query_page",
            snapshot_head = state.snapshot_head,
            candidate_rows = page.candidate_rows,
            results = page.results.len() as u64,
            exact_documents = page.exact_documents,
            elapsed_ms = started.elapsed().as_millis() as u64,
            database_pool_size = self.pool.size(),
            database_pool_idle = self.pool.num_idle(),
            rss_bytes = memory.rss_bytes.unwrap_or(0),
            pss_bytes = memory.pss_bytes.unwrap_or(0),
            cgroup_current_bytes = memory.cgroup_current_bytes.unwrap_or(0),
            "privacy-safe hosted provider metric"
        );
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
        Ok(OperationResult {
            valid: true,
            result: json!({
                "results": page.results,
                "meta": meta,
                "diagnostics": serialized_diagnostics,
            }),
            diagnostics: page.diagnostics,
        })
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
        let Some(generation_id) =
            collection.get::<Option<Uuid>, _>("active_projection_generation_id")
        else {
            return Err(ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "hosted_projection_unavailable",
                "This collection has no active semantic projection generation.",
            ));
        };
        let catalog_revision = collection
            .get::<Option<String>, _>("active_catalog_revision")
            .ok_or_else(|| {
                ApiError::internal("The active projection catalog binding is absent.")
            })?;
        let projection_format_version = number(
            collection
                .get::<Option<i32>, _>("active_projection_format_version")
                .map(i64::from)
                .ok_or_else(|| {
                    ApiError::internal("The active projection format binding is absent.")
                })?,
            "projection format version",
        )? as u32;
        let semantic_engine_version = collection
            .get::<Option<String>, _>("active_semantic_engine_version")
            .ok_or_else(|| ApiError::internal("The active semantic engine binding is absent."))?;
        if catalog_revision != catalog.resource_revision()
            || projection_format_version != mdbase::runtime::SEMANTIC_PROJECTION_FORMAT_VERSION
            || semantic_engine_version != mdbase::VERSION
        {
            return Err(ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "hosted_projection_stale",
                "The active semantic projection is not bound to the current engine and catalog.",
            ));
        }
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
            generation_id: Some(generation_id),
            catalog_revision,
            projection_format_version,
            semantic_engine_version,
            plan,
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

async fn cleanup_base_query_invocations<'e, E>(executor: E, collection_id: Uuid) -> ApiResult<()>
where
    E: sqlx::Executor<'e, Database = Postgres>,
{
    sqlx::query(
        r#"DELETE FROM hosted_provider_base_query_invocations i
           WHERE i.collection_id = $1
             AND (i.hard_expires_at <= now() OR NOT EXISTS (
               SELECT 1 FROM hosted_provider_query_cursors c
               WHERE c.base_invocation_id = i.invocation_id
             ))"#,
    )
    .bind(collection_id)
    .execute(executor)
    .await?;
    Ok(())
}

fn active_query_binding(
    collection: &PgRow,
    catalog: &mdbase::runtime::CompiledCatalog,
) -> ApiResult<(Uuid, String, u32, String)> {
    let generation_id = collection
        .get::<Option<Uuid>, _>("active_projection_generation_id")
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "hosted_projection_unavailable",
                "This collection has no active semantic projection generation.",
            )
        })?;
    let catalog_revision = collection
        .get::<Option<String>, _>("active_catalog_revision")
        .ok_or_else(|| ApiError::internal("The active projection catalog binding is absent."))?;
    let projection_format_version = number(
        collection
            .get::<Option<i32>, _>("active_projection_format_version")
            .map(i64::from)
            .ok_or_else(|| ApiError::internal("The active projection format binding is absent."))?,
        "projection format version",
    )? as u32;
    let semantic_engine_version = collection
        .get::<Option<String>, _>("active_semantic_engine_version")
        .ok_or_else(|| ApiError::internal("The active semantic engine binding is absent."))?;
    if catalog_revision != catalog.resource_revision()
        || projection_format_version != mdbase::runtime::SEMANTIC_PROJECTION_FORMAT_VERSION
        || semantic_engine_version != mdbase::VERSION
    {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "hosted_projection_stale",
            "The active semantic projection is not bound to the current engine and catalog.",
        ));
    }
    Ok((
        generation_id,
        catalog_revision,
        projection_format_version,
        semantic_engine_version,
    ))
}

fn base_query_binding(
    collection: &PgRow,
    catalog: &mdbase::runtime::CompiledCatalog,
) -> (Option<Uuid>, String, u32, String) {
    let generation_id = collection.get::<Option<Uuid>, _>("active_projection_generation_id");
    let catalog_revision = collection.get::<Option<String>, _>("active_catalog_revision");
    let projection_format_version = collection
        .get::<Option<i32>, _>("active_projection_format_version")
        .and_then(|value| u32::try_from(value).ok());
    let semantic_engine_version =
        collection.get::<Option<String>, _>("active_semantic_engine_version");
    let current = generation_id.is_some()
        && catalog_revision.as_deref() == Some(catalog.resource_revision())
        && projection_format_version == Some(mdbase::runtime::SEMANTIC_PROJECTION_FORMAT_VERSION)
        && semantic_engine_version.as_deref() == Some(mdbase::VERSION);
    (
        current.then_some(generation_id).flatten(),
        catalog.resource_revision().to_string(),
        mdbase::runtime::SEMANTIC_PROJECTION_FORMAT_VERSION,
        mdbase::VERSION.to_string(),
    )
}

#[allow(clippy::too_many_arguments)]
async fn load_base_context_projection(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
    generation_id: Uuid,
    snapshot_head: u64,
    catalog_revision: &str,
    projection_format_version: u32,
    semantic_engine_version: &str,
    path: &str,
) -> ApiResult<Option<mdbase::runtime::SemanticProjection>> {
    let row = sqlx::query(
        r#"WITH live AS (
             SELECT DISTINCT ON (record_id) record_id, sequence, revision, deleted
             FROM hosted_provider_record_versions
             WHERE collection_id = $1 AND sequence <= $4
             ORDER BY record_id, sequence DESC
           )
           SELECT p.semantic_projection
           FROM hosted_provider_record_projections p
           JOIN live l ON l.record_id = p.record_id AND NOT l.deleted
             AND l.sequence = p.record_sequence AND l.revision = p.record_revision
           WHERE p.collection_id = $1 AND p.generation_id = $2
             AND p.canonical_path = $3
             AND p.valid_from_sequence <= $4
             AND (p.valid_to_sequence IS NULL OR p.valid_to_sequence > $4)
             AND p.catalog_revision = $5 AND p.projection_format_version = $6
             AND p.semantic_engine_version = $7
             AND p.semantic_complete AND p.resolution_complete
           ORDER BY p.valid_from_sequence DESC
           LIMIT 1"#,
    )
    .bind(collection_id)
    .bind(generation_id)
    .bind(path)
    .bind(to_i64(snapshot_head, "query snapshot head")?)
    .bind(catalog_revision)
    .bind(i64::from(projection_format_version))
    .bind(semantic_engine_version)
    .fetch_optional(&mut **transaction)
    .await?;
    row.map(|row| {
        serde_json::from_value(row.get("semantic_projection")).map_err(|error| {
            ApiError::conflict(
                "hosted_projection_inconsistent",
                format!("The Obsidian Base context projection could not decode: {error}"),
            )
        })
    })
    .transpose()
}

async fn load_query_context_record(
    transaction: &mut Transaction<'_, Postgres>,
    crypto: &ProviderCrypto,
    data_key: &[u8; 32],
    collection_id: Uuid,
    input: &Value,
) -> ApiResult<Option<mdbase::runtime::CanonicalRecordInput>> {
    let Some(path) = input.pointer("/context/this/path").and_then(Value::as_str) else {
        return Ok(None);
    };
    load_exact_context_by_path(transaction, crypto, data_key, collection_id, path)
        .await?
        .map(Some)
        .ok_or_else(|| {
            ApiError::bad_request(
                "context_not_found",
                format!("Query context record '{path}' was not found."),
            )
        })
}

async fn load_exact_context_by_path(
    transaction: &mut Transaction<'_, Postgres>,
    crypto: &ProviderCrypto,
    data_key: &[u8; 32],
    collection_id: Uuid,
    path: &str,
) -> ApiResult<Option<mdbase::runtime::CanonicalRecordInput>> {
    let record = load_direct_record(
        transaction,
        crypto,
        data_key,
        collection_id,
        DirectRecordIdentity::PathToken(path_token(data_key, path)),
    )
    .await?;
    let Some((record, _, modified_at)) = record else {
        return Ok(None);
    };
    if record.path != path {
        return Err(ApiError::internal(
            "The encrypted query context path does not match its lookup identity.",
        ));
    }
    Ok(Some(mdbase::runtime::CanonicalRecordInput {
        stable_id: Some(record.record_id.to_string()),
        path: record.path,
        file_size: record.document.len() as u64,
        document: record.document,
        file_mtime: Some(modified_at.to_rfc3339_opts(SecondsFormat::Micros, true)),
    }))
}

fn enforce_context_scope(
    catalog: &mdbase::runtime::CompiledCatalog,
    context: &mdbase::runtime::CanonicalRecordInput,
    allowed_types: &[String],
) -> ApiResult<()> {
    if allowed_types.is_empty() {
        return Ok(());
    }
    let classified = catalog.classify_record(context).map_err(|error| {
        ApiError::forbidden(
            "scope_classification_unavailable",
            format!("Query context classification failed: {}.", error.code),
        )
    })?;
    if classified.types.iter().any(|actual| {
        allowed_types
            .iter()
            .any(|allowed| allowed.eq_ignore_ascii_case(actual))
    }) {
        Ok(())
    } else {
        Err(ApiError::forbidden(
            "scope_denied",
            "The query context record is outside this application's record scope.",
        ))
    }
}

fn enforce_exact_context_budget(
    plan: &mdbase::runtime::HostedQueryPlan,
    context: Option<&mdbase::runtime::CanonicalRecordInput>,
) -> ApiResult<()> {
    let Some(context) = context else {
        return Ok(());
    };
    if plan.budgets.max_exact_documents == 0 {
        return Err(query_budget_error(
            "hosted_exact_document_budget_exceeded",
            "The hosted query has no exact-context document budget.",
            "exact_documents",
            0,
            1,
        ));
    }
    let bytes = context.document.len() as u64;
    if bytes > plan.budgets.max_exact_bytes {
        return Err(query_budget_error(
            "hosted_exact_byte_budget_exceeded",
            "The hosted query context exceeds its exact-plaintext byte budget.",
            "exact_bytes",
            plan.budgets.max_exact_bytes,
            bytes,
        ));
    }
    Ok(())
}

fn canonical_view_request_digest(input: &Value) -> ApiResult<String> {
    let mut request = input.as_object().cloned().ok_or_else(|| {
        ApiError::bad_request("invalid_request", "Saved-view input must be an object.")
    })?;
    for control in ["cursor", "release_cursor", "limit", "offset"] {
        request.remove(control);
    }
    let canonical = serde_jcs::to_vec(&json!({
        "schema": "mdbase.connect.hosted-canonical-view-request.v1",
        "request": request,
    }))
    .map_err(|error| {
        ApiError::internal(format!(
            "Saved-view request could not canonicalize: {error}"
        ))
    })?;
    Ok(format!("sha256:{:x}", Sha256::digest(canonical)))
}

async fn validate_generation_binding(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
    state: &HostedQueryState,
) -> ApiResult<()> {
    if state.generation_id.is_none() {
        return if state.request_kind == HostedQueryRequestKind::ObsidianBase {
            Ok(())
        } else {
            Err(query_cursor_conflict(
                "query_generation_unavailable",
                "A non-Base hosted query has no pinned semantic generation.",
            ))
        };
    }
    let valid: bool = sqlx::query_scalar(
        r#"SELECT EXISTS (
             SELECT 1 FROM hosted_provider_projection_generations
             WHERE collection_id = $1 AND generation_id = $2 AND status = 'complete'
               AND target_catalog_revision = $3 AND projection_format_version = $4
               AND semantic_engine_version = $5 AND source_head <= $6
           )"#,
    )
    .bind(collection_id)
    .bind(state.generation_id)
    .bind(&state.catalog_revision)
    .bind(i64::from(state.projection_format_version))
    .bind(&state.semantic_engine_version)
    .bind(to_i64(state.snapshot_head, "query snapshot head")?)
    .fetch_one(&mut **transaction)
    .await?;
    if valid {
        Ok(())
    } else {
        Err(query_cursor_conflict(
            "query_generation_unavailable",
            "The semantic generation pinned by this hosted query is unavailable.",
        ))
    }
}

async fn projection_fallback_exists(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
    state: &HostedQueryState,
) -> ApiResult<bool> {
    sqlx::query_scalar(
        r#"WITH live AS (
             SELECT DISTINCT ON (record_id) record_id, sequence, revision, deleted
             FROM hosted_provider_record_versions
             WHERE collection_id = $1 AND sequence <= $2
             ORDER BY record_id, sequence DESC
           )
           SELECT EXISTS (
             SELECT 1 FROM live l
             LEFT JOIN hosted_provider_record_projections p
               ON p.collection_id = $1 AND p.generation_id = $3
              AND p.record_id = l.record_id
              AND p.valid_from_sequence <= $2
              AND (p.valid_to_sequence IS NULL OR p.valid_to_sequence > $2)
             WHERE NOT l.deleted AND (
               p.record_id IS NULL OR p.record_sequence <> l.sequence
               OR p.record_revision <> l.revision OR p.catalog_revision <> $4
               OR p.projection_format_version <> $5 OR p.semantic_engine_version <> $6
               OR NOT p.semantic_complete OR NOT p.resolution_complete
             )
           )"#,
    )
    .bind(collection_id)
    .bind(to_i64(state.snapshot_head, "query snapshot head")?)
    .bind(state.generation_id)
    .bind(&state.catalog_revision)
    .bind(i64::from(state.projection_format_version))
    .bind(&state.semantic_engine_version)
    .fetch_one(&mut **transaction)
    .await
    .map_err(ApiError::from)
}

async fn base_projection_fallback_exists(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
    state: &HostedQueryState,
) -> ApiResult<bool> {
    if state.generation_id.is_none() {
        return Ok(true);
    }
    if state
        .base_plan
        .as_ref()
        .is_some_and(|plan| plan.context_path.is_some())
        && state.base_context.is_none()
    {
        return Ok(true);
    }
    let relationships_required = state.base_plan.as_ref().is_some_and(|plan| {
        plan.requirements.backlinks
            || plan.requirements.outgoing_relationships
            || plan.requirements.link_resolution
    });
    sqlx::query_scalar(
        r#"WITH live AS (
             SELECT DISTINCT ON (record_id) record_id, sequence, revision, deleted
             FROM hosted_provider_record_versions
             WHERE collection_id = $1 AND sequence <= $2
             ORDER BY record_id, sequence DESC
           )
           SELECT EXISTS (
             SELECT 1 FROM live l
             LEFT JOIN hosted_provider_record_projections p
               ON p.collection_id = $1 AND p.generation_id = $3
              AND p.record_id = l.record_id
              AND p.valid_from_sequence <= $2
              AND (p.valid_to_sequence IS NULL OR p.valid_to_sequence > $2)
             WHERE NOT l.deleted AND (
               p.record_id IS NULL OR p.record_sequence <> l.sequence
               OR p.record_revision <> l.revision OR p.catalog_revision <> $4
               OR p.projection_format_version <> $5 OR p.semantic_engine_version <> $6
               OR NOT p.semantic_complete OR ($7 AND NOT p.resolution_complete)
             )
           )"#,
    )
    .bind(collection_id)
    .bind(to_i64(state.snapshot_head, "query snapshot head")?)
    .bind(state.generation_id)
    .bind(&state.catalog_revision)
    .bind(i64::from(state.projection_format_version))
    .bind(&state.semantic_engine_version)
    .bind(relationships_required)
    .fetch_one(&mut **transaction)
    .await
    .map_err(ApiError::from)
}

#[allow(clippy::too_many_arguments)]
async fn execute_projected_page(
    transaction: &mut Transaction<'_, Postgres>,
    crypto: &ProviderCrypto,
    data_key: &[u8; 32],
    collection_id: Uuid,
    state: &HostedQueryState,
    catalog: &mdbase::runtime::CompiledCatalog,
    candidate_types: &[String],
    order_descending: bool,
    page_size: u64,
) -> ApiResult<ExecutedQueryPage> {
    let total_count =
        count_projected_candidates(transaction, collection_id, state, candidate_types).await?;
    let rows = load_projected_page(
        transaction,
        collection_id,
        state,
        candidate_types,
        order_descending,
        page_size,
    )
    .await?;
    let projection_bytes = rows.iter().try_fold(0_u64, |total, row| {
        let bytes = serde_json::to_vec(&row.projection).map_err(|error| {
            ApiError::internal(format!(
                "Hosted semantic projection could not serialize: {error}"
            ))
        })?;
        Ok::<_, ApiError>(total.saturating_add(bytes.len() as u64))
    })?;
    if projection_bytes > state.plan.budgets.max_candidate_bytes {
        return Err(query_budget_error(
            "hosted_byte_budget_exceeded",
            "The hosted query page exceeded its transferred projection-byte budget.",
            "candidate_bytes",
            state.plan.budgets.max_candidate_bytes,
            projection_bytes,
        ));
    }
    let exact_records = if state.plan.requirements.exact_document {
        load_exact_query_records(
            transaction,
            crypto,
            data_key,
            collection_id,
            state.snapshot_head,
            &rows.iter().map(|row| row.record_id).collect::<Vec<_>>(),
        )
        .await?
    } else {
        HashMap::new()
    };
    let context_documents = u64::from(state.exact_context.is_some());
    if (exact_records.len() as u64).saturating_add(context_documents)
        > state.plan.budgets.max_exact_documents
    {
        return Err(query_budget_error(
            "hosted_exact_document_budget_exceeded",
            "The hosted query page exceeded its exact-document budget.",
            "exact_documents",
            state.plan.budgets.max_exact_documents,
            (exact_records.len() as u64).saturating_add(context_documents),
        ));
    }
    let exact_bytes = exact_records
        .values()
        .fold(0_u64, |total, record| {
            total.saturating_add(record.document.len() as u64)
        })
        .saturating_add(
            state
                .exact_context
                .as_ref()
                .map_or(0, |context| context.document.len() as u64),
        );
    if exact_bytes > state.plan.budgets.max_exact_bytes {
        return Err(query_budget_error(
            "hosted_exact_byte_budget_exceeded",
            "The hosted query page exceeded its exact-plaintext byte budget.",
            "exact_bytes",
            state.plan.budgets.max_exact_bytes,
            exact_bytes,
        ));
    }
    let mut results = Vec::with_capacity(rows.len());
    let mut diagnostics = Vec::new();
    for row in &rows {
        let evaluation = if state.plan.requirements.exact_document {
            let record = exact_records.get(&row.record_id).ok_or_else(|| {
                ApiError::internal("A selected hosted query row has no exact snapshot record.")
            })?;
            catalog.evaluate_hosted_residual_with_context(
                &state.plan,
                record,
                state.exact_context.as_ref(),
            )
        } else {
            catalog.evaluate_hosted_projection_residual(&state.plan, &row.projection)
        }
        .map_err(projection_inconsistent)?;
        if !evaluation.matched {
            return Err(ApiError::conflict(
                "hosted_projection_inconsistent",
                "A SQL-selected projection disagreed with canonical residual evaluation.",
            ));
        }
        diagnostics.extend(evaluation.diagnostics);
        results.push(evaluation.record.ok_or_else(|| {
            ApiError::internal("A matching hosted residual omitted its result record.")
        })?);
    }
    let result_bytes = results
        .iter()
        .map(|result| serde_json::to_vec(result).map_or(0, |bytes| bytes.len() as u64))
        .sum::<u64>();
    let resident_bytes = projection_bytes
        .saturating_add(exact_bytes)
        .saturating_add(result_bytes);
    if resident_bytes > state.plan.budgets.max_memory_bytes {
        return Err(query_budget_error(
            "hosted_memory_budget_exceeded",
            "The hosted query page exceeded its bounded resident-memory budget.",
            "memory_bytes",
            state.plan.budgets.max_memory_bytes,
            resident_bytes,
        ));
    }
    Ok(ExecutedQueryPage {
        results,
        diagnostics,
        groups: None,
        total_count,
        last_boundary: rows.last().map(|row| QueryPageBoundary {
            order_values: state
                .plan
                .order
                .iter()
                .map(|_| Value::String(row.canonical_path.clone()))
                .collect(),
            path: row.canonical_path.clone(),
            record_id: row.record_id,
        }),
        candidate_rows: rows.len() as u64,
        exact_documents: (exact_records.len() as u64).saturating_add(context_documents),
    })
}

struct BoundedProjectionCandidate {
    record_id: Uuid,
}

struct BoundedQueryMatch {
    path: String,
    record_id: Uuid,
    result: Value,
    order_values: Vec<Value>,
    reduction: mdbase::runtime::HostedReductionInput,
}

struct BoundedBaseMatch {
    record_id: Uuid,
    row: mdbase::runtime::HostedBaseRow,
}

struct BaseExecutionSnapshot {
    rows: Vec<ProjectedQueryRow>,
    projections: HashMap<Uuid, mdbase::runtime::SemanticProjection>,
    adjacency: HashMap<Uuid, BTreeSet<Uuid>>,
    relationship_rows: u64,
    projection_bytes: u64,
    exact_documents: u64,
    exact_bytes: u64,
    query_context: Option<mdbase::runtime::SemanticProjection>,
}

#[allow(clippy::too_many_arguments)]
async fn execute_bounded_base_page(
    transaction: &mut Transaction<'_, Postgres>,
    crypto: &ProviderCrypto,
    data_key: &[u8; 32],
    collection_id: Uuid,
    state: &HostedQueryState,
    catalog: &mdbase::runtime::CompiledCatalog,
    page_size: u64,
    started: Instant,
    projection_fallback: bool,
) -> ApiResult<ExecutedQueryPage> {
    let plan = state
        .base_plan
        .as_ref()
        .ok_or_else(|| ApiError::internal("Obsidian Base execution has no semantic plan."))?;
    let snapshot = if state.generation_id.is_some() && !base_requires_relationships(plan) {
        load_base_hybrid_snapshot(
            transaction,
            crypto,
            data_key,
            collection_id,
            state,
            catalog,
            plan,
        )
        .await?
    } else if projection_fallback {
        load_base_exact_fallback_snapshot(
            transaction,
            crypto,
            data_key,
            collection_id,
            state,
            catalog,
            plan,
        )
        .await?
    } else {
        load_base_projected_snapshot(transaction, collection_id, state, plan).await?
    };
    let BaseExecutionSnapshot {
        rows,
        projections,
        adjacency,
        relationship_rows,
        projection_bytes,
        exact_documents,
        exact_bytes,
        query_context,
    } = snapshot;
    if let Some(context) = &query_context {
        if !plan.allowed_types.is_empty()
            && !context.facts.types.iter().any(|actual| {
                plan.allowed_types
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
    if rows.len() as u64 > state.plan.budgets.max_candidate_rows {
        return Err(query_budget_error(
            "hosted_scan_budget_exceeded",
            "The Obsidian Base exceeded its candidate-row budget.",
            "candidate_rows",
            state.plan.budgets.max_candidate_rows,
            rows.len() as u64,
        ));
    }
    let operator_steps = (rows.len() as u64).saturating_add(relationship_rows);
    if operator_steps > state.plan.budgets.max_operator_steps {
        return Err(query_budget_error(
            "hosted_operator_budget_exceeded",
            "The Obsidian Base exceeded its total operator-step budget.",
            "operator_steps",
            state.plan.budgets.max_operator_steps,
            operator_steps,
        ));
    }
    if projection_bytes > state.plan.budgets.max_candidate_bytes {
        return Err(query_budget_error(
            "hosted_byte_budget_exceeded",
            "The Obsidian Base exceeded its transferred projection-byte budget.",
            "candidate_bytes",
            state.plan.budgets.max_candidate_bytes,
            projection_bytes,
        ));
    }
    let operation_clock = state.base_operation_clock.as_ref().ok_or_else(|| {
        ApiError::internal("Obsidian Base execution has no snapshot operation clock.")
    })?;
    let expression_steps_per_record = if rows.is_empty() {
        0
    } else {
        state
            .plan
            .budgets
            .max_operator_steps
            .saturating_sub(operator_steps)
            / rows.len() as u64
    };
    if !rows.is_empty() && expression_steps_per_record == 0 {
        return Err(query_budget_error(
            "hosted_operator_budget_exceeded",
            "The Obsidian Base has no remaining expression-step budget.",
            "operator_steps",
            state.plan.budgets.max_operator_steps,
            operator_steps.saturating_add(1),
        ));
    }
    let mut evaluation_inputs = Vec::with_capacity(rows.len());
    for row in &rows {
        let related = adjacency
            .get(&row.record_id)
            .into_iter()
            .flatten()
            .filter_map(|record_id| projections.get(record_id).cloned())
            .collect::<Vec<_>>();
        evaluation_inputs.push((
            row.record_id,
            mdbase::runtime::HostedBaseRecordContext {
                projection: row.projection.clone(),
                related,
                relationship_neighborhood_complete: true,
                query_context: query_context.clone(),
                operation_clock: operation_clock.clone(),
                max_expression_steps: expression_steps_per_record,
            },
        ));
    }
    let evaluation_plan = plan.clone();
    let cancellation = mdbase::OperationCancellation::new();
    let worker_cancellation = cancellation
        .with_deadline(started + Duration::from_millis(state.plan.budgets.max_wall_time_ms));
    let mut cancellation_guard = BaseEvaluationCancellationGuard::new(cancellation);
    let evaluated = tokio::task::spawn_blocking(move || {
        evaluation_inputs
            .into_iter()
            .map(|(record_id, input)| {
                evaluation_plan
                    .evaluate_record_with_cancellation(&input, &worker_cancellation)
                    .map(|evaluation| (record_id, evaluation))
            })
            .collect::<Result<Vec<_>, _>>()
    })
    .await
    .map_err(|error| {
        ApiError::internal(format!(
            "Obsidian Base evaluation worker did not complete: {error}"
        ))
    })?
    .map_err(|error| match error.code.as_str() {
        "hosted_base_operator_budget_exceeded" => query_budget_error(
            "hosted_operator_budget_exceeded",
            "The Obsidian Base exceeded its expression-step budget.",
            "expression_steps_per_record",
            expression_steps_per_record,
            expression_steps_per_record.saturating_add(1),
        ),
        "operation_cancelled" => query_budget_error(
            "hosted_time_budget_exceeded",
            "The Obsidian Base exceeded its cooperative evaluation deadline.",
            "wall_time_ms",
            state.plan.budgets.max_wall_time_ms,
            started.elapsed().as_millis() as u64,
        ),
        _ => projection_inconsistent(error),
    })?;
    cancellation_guard.disarm();
    let mut diagnostics = Vec::new();
    let mut matching = Vec::<BoundedBaseMatch>::new();
    for (record_id, evaluated) in evaluated {
        match evaluated {
            mdbase::runtime::HostedBaseEvaluation::Included { row: result } => {
                matching.push(BoundedBaseMatch {
                    record_id,
                    row: *result,
                });
            }
            mdbase::runtime::HostedBaseEvaluation::Excluded {
                diagnostics: excluded,
            } => diagnostics.extend(excluded),
        }
    }
    matching.sort_by(|left, right| {
        plan.compare_rows(&left.row, &right.row)
            .then_with(|| left.record_id.cmp(&right.record_id))
    });
    let total_count = matching.len() as u64;
    let matching_bytes = matching.iter().fold(0_u64, |total, item| {
        total.saturating_add(serde_json::to_vec(&item.row).map_or(0, |bytes| bytes.len() as u64))
    });
    // Candidate projections are owned once by the SQL row set and once by the
    // identity map; one candidate's relationship context is cloned during
    // evaluation. Group construction similarly owns a temporary row copy.
    let pre_reduction_resident_bytes = projection_bytes
        .saturating_mul(3)
        .saturating_add(exact_bytes)
        .saturating_add(matching_bytes.saturating_mul(2));
    if pre_reduction_resident_bytes > state.plan.budgets.max_memory_bytes {
        return Err(query_budget_error(
            "hosted_memory_budget_exceeded",
            "The Obsidian Base exceeded its bounded resident-memory budget.",
            "memory_bytes",
            state.plan.budgets.max_memory_bytes,
            pre_reduction_resident_bytes,
        ));
    }
    let group_rows = matching
        .iter()
        .map(|item| item.row.clone())
        .collect::<Vec<_>>();
    let groups = plan.groups(&group_rows);
    if groups
        .as_ref()
        .is_some_and(|groups| groups.len() as u64 > state.plan.budgets.max_groups)
    {
        return Err(query_budget_error(
            "hosted_group_budget_exceeded",
            "The Obsidian Base exceeded its group budget.",
            "groups",
            state.plan.budgets.max_groups,
            groups.as_ref().map_or(0, |groups| groups.len() as u64),
        ));
    }
    let after_keyset = matching.into_iter().filter(|item| {
        let Some(last_path) = state.last_path.as_deref() else {
            return true;
        };
        match plan.compare_row_to_boundary(&item.row, &state.last_order_values, last_path) {
            Ok(ordering) => {
                ordering.is_gt()
                    || (ordering.is_eq()
                        && state
                            .last_record_id
                            .is_some_and(|last| item.record_id > last))
            }
            Err(_) => false,
        }
    });
    let offset = if state.last_path.is_none() {
        plan.offset
    } else {
        0
    };
    let page = after_keyset
        .skip(usize::try_from(offset).unwrap_or(usize::MAX))
        .take(usize::try_from(page_size).unwrap_or(usize::MAX))
        .collect::<Vec<_>>();
    let last_boundary = page.last().map(|item| QueryPageBoundary {
        order_values: plan.row_order_values(&item.row),
        path: item.row.path.clone(),
        record_id: item.record_id,
    });
    let results = page
        .iter()
        .map(|item| {
            json!({
                "path": item.row.path,
                "file": item.row.file,
                "effective_frontmatter": item.row.effective_frontmatter,
                "types": item.row.types,
                "values": item.row.values,
            })
        })
        .collect::<Vec<_>>();
    let result_bytes = serialized_value_bytes(&Value::Array(results.clone()));
    let group_bytes = groups.as_ref().map_or(0, |groups| {
        serialized_value_bytes(&Value::Array(groups.clone()))
    });
    let resident_bytes = pre_reduction_resident_bytes
        .saturating_add(result_bytes)
        .saturating_add(group_bytes);
    if resident_bytes > state.plan.budgets.max_memory_bytes {
        return Err(query_budget_error(
            "hosted_memory_budget_exceeded",
            "The Obsidian Base exceeded its bounded resident-memory budget.",
            "memory_bytes",
            state.plan.budgets.max_memory_bytes,
            resident_bytes,
        ));
    }
    if started.elapsed().as_millis() as u64 > state.plan.budgets.max_wall_time_ms {
        return Err(query_budget_error(
            "hosted_time_budget_exceeded",
            "The Obsidian Base exceeded its wall-time budget.",
            "wall_time_ms",
            state.plan.budgets.max_wall_time_ms,
            started.elapsed().as_millis() as u64,
        ));
    }
    Ok(ExecutedQueryPage {
        results,
        diagnostics,
        groups,
        total_count,
        last_boundary,
        candidate_rows: rows.len() as u64,
        exact_documents,
    })
}

fn base_requires_relationships(plan: &mdbase::runtime::HostedBasePlan) -> bool {
    plan.requirements.backlinks
        || plan.requirements.outgoing_relationships
        || plan.requirements.link_resolution
}

async fn load_base_projected_snapshot(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
    state: &HostedQueryState,
    plan: &mdbase::runtime::HostedBasePlan,
) -> ApiResult<BaseExecutionSnapshot> {
    let (rows, candidate_projection_bytes) =
        load_base_candidate_projections(transaction, collection_id, state, plan).await?;
    let candidate_ids = rows.iter().map(|row| row.record_id).collect::<Vec<_>>();
    let mut adjacency = HashMap::<Uuid, BTreeSet<Uuid>>::new();
    let relationship_rows = if plan.requirements.backlinks
        || plan.requirements.outgoing_relationships
        || plan.requirements.link_resolution
    {
        let relationship_rows = sqlx::query(
            r#"WITH live AS (
                 SELECT DISTINCT ON (record_id) record_id, sequence, revision, deleted
                 FROM hosted_provider_record_versions
                 WHERE collection_id = $1 AND sequence <= $3
                 ORDER BY record_id, sequence DESC
               )
               SELECT DISTINCT relationship.source_record_id, relationship.target_record_id
               FROM hosted_provider_record_relationships relationship
               JOIN live source ON source.record_id = relationship.source_record_id
                 AND NOT source.deleted
                 AND source.sequence = relationship.source_record_sequence
                 AND source.revision = relationship.source_record_revision
               WHERE relationship.collection_id = $1
                 AND relationship.generation_id = $2
                 AND relationship.valid_from_sequence <= $3
                 AND (relationship.valid_to_sequence IS NULL
                      OR relationship.valid_to_sequence > $3)
                 AND relationship.catalog_revision = $5
                 AND relationship.projection_format_version = $6
                 AND relationship.semantic_engine_version = $7
                 AND relationship.resolution_state = 'resolved'
                 AND (relationship.source_record_id = ANY($4::uuid[])
                      OR relationship.target_record_id = ANY($4::uuid[]))
               ORDER BY relationship.source_record_id,
                        relationship.target_record_id
               LIMIT $8"#,
        )
        .bind(collection_id)
        .bind(state.generation_id)
        .bind(to_i64(state.snapshot_head, "query snapshot head")?)
        .bind(&candidate_ids)
        .bind(&state.catalog_revision)
        .bind(i64::from(state.projection_format_version))
        .bind(&state.semantic_engine_version)
        .bind(to_i64(
            state
                .plan
                .budgets
                .max_operator_steps
                .min(MAX_HOSTED_BASE_RELATIONSHIP_PAIRS)
                .saturating_add(1),
            "relationship operator budget",
        )?)
        .fetch_all(&mut **transaction)
        .await?;
        let relationship_pair_budget = state
            .plan
            .budgets
            .max_operator_steps
            .min(MAX_HOSTED_BASE_RELATIONSHIP_PAIRS);
        if relationship_rows.len() as u64 > relationship_pair_budget {
            return Err(query_budget_error(
                "hosted_operator_budget_exceeded",
                "The Obsidian Base exceeded its relationship-pair budget.",
                "relationship_pairs",
                relationship_pair_budget,
                relationship_rows.len() as u64,
            ));
        }
        for row in &relationship_rows {
            let source: Uuid = row.get("source_record_id");
            let Some(target) = row.get::<Option<Uuid>, _>("target_record_id") else {
                continue;
            };
            adjacency.entry(source).or_default().insert(target);
            adjacency.entry(target).or_default().insert(source);
        }
        relationship_rows.len() as u64
    } else {
        0
    };
    let candidate_set = candidate_ids.iter().copied().collect::<BTreeSet<_>>();
    let related_ids = adjacency
        .values()
        .flatten()
        .filter(|record_id| !candidate_set.contains(record_id))
        .copied()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let (related, related_projection_bytes) = load_base_related_projections(
        transaction,
        collection_id,
        state,
        &related_ids,
        state
            .plan
            .budgets
            .max_candidate_bytes
            .saturating_sub(candidate_projection_bytes),
    )
    .await?;
    let projections = rows
        .iter()
        .map(|row| (row.record_id, row.projection.clone()))
        .chain(related)
        .collect::<HashMap<_, _>>();
    let stored_projection_bytes =
        candidate_projection_bytes.saturating_add(related_projection_bytes);
    let serialized_bytes = serialized_projection_bytes(&projections)?;
    if serialized_bytes > state.plan.budgets.max_candidate_bytes {
        return Err(query_budget_error(
            "hosted_byte_budget_exceeded",
            "The Obsidian Base exceeded its serialized projection-byte budget.",
            "candidate_bytes",
            state.plan.budgets.max_candidate_bytes,
            serialized_bytes,
        ));
    }
    let projection_bytes = stored_projection_bytes.max(serialized_bytes);
    Ok(BaseExecutionSnapshot {
        rows,
        projections,
        adjacency,
        relationship_rows,
        projection_bytes,
        exact_documents: 0,
        exact_bytes: 0,
        query_context: state.base_context.clone(),
    })
}

#[allow(clippy::too_many_arguments)]
async fn load_base_hybrid_snapshot(
    transaction: &mut Transaction<'_, Postgres>,
    crypto: &ProviderCrypto,
    data_key: &[u8; 32],
    collection_id: Uuid,
    state: &HostedQueryState,
    catalog: &mdbase::runtime::CompiledCatalog,
    plan: &mdbase::runtime::HostedBasePlan,
) -> ApiResult<BaseExecutionSnapshot> {
    let mut query = QueryBuilder::<Postgres>::new(
        "WITH live AS (SELECT DISTINCT ON (record_id) record_id, sequence, revision, deleted \
         FROM hosted_provider_record_versions WHERE collection_id = ",
    );
    query
        .push_bind(collection_id)
        .push(" AND sequence <= ")
        .push_bind(to_i64(state.snapshot_head, "query snapshot head")?)
        .push(
            " ORDER BY record_id, sequence DESC), joined AS (SELECT l.record_id, l.deleted, \
             p.matched_types, p.canonical_path, p.projection_bytes,
             p.semantic_projection, p.record_id IS NOT NULL \
             AND p.record_sequence = l.sequence AND p.record_revision = l.revision \
             AND p.catalog_revision = ",
        )
        .push_bind(&state.catalog_revision)
        .push(" AND p.projection_format_version = ")
        .push_bind(i64::from(state.projection_format_version))
        .push(" AND p.semantic_engine_version = ")
        .push_bind(&state.semantic_engine_version)
        .push(
            " AND p.semantic_complete AND p.resolution_complete AS projection_current \
             FROM live l LEFT JOIN hosted_provider_record_projections p ON p.collection_id = ",
        )
        .push_bind(collection_id)
        .push(" AND p.generation_id = ")
        .push_bind(state.generation_id)
        .push(" AND p.record_id = l.record_id AND p.valid_from_sequence <= ")
        .push_bind(to_i64(state.snapshot_head, "query snapshot head")?)
        .push(" AND (p.valid_to_sequence IS NULL OR p.valid_to_sequence > ")
        .push_bind(to_i64(state.snapshot_head, "query snapshot head")?)
        .push(
            ")) SELECT record_id, projection_current,
             CASE WHEN projection_current THEN canonical_path END AS canonical_path,
             CASE WHEN projection_current THEN projection_bytes ELSE 0 END AS projection_bytes
             FROM joined WHERE NOT deleted AND (NOT projection_current OR \
             ((cardinality(",
        )
        .push_bind(&plan.allowed_types)
        .push("::text[]) = 0 OR matched_types && ")
        .push_bind(&plan.allowed_types)
        .push("::text[]) AND (");
    push_candidate_predicate(&mut query, &plan.candidate);
    query
        .push("))) ORDER BY record_id LIMIT ")
        .push_bind(to_i64(
            state.plan.budgets.max_candidate_rows.saturating_add(1),
            "candidate row budget",
        )?);
    let rows = query.build().fetch_all(&mut **transaction).await?;
    if rows.len() as u64 > state.plan.budgets.max_candidate_rows {
        let observed = scoped_budget_observed(
            &plan.allowed_types,
            state.plan.budgets.max_candidate_rows,
            rows.len() as u64,
        );
        return Err(query_budget_error(
            "hosted_scan_budget_exceeded",
            "The stale Obsidian Base union exceeded its candidate-row budget.",
            "candidate_rows",
            state.plan.budgets.max_candidate_rows,
            observed,
        ));
    }

    let current_projection_bytes = rows.iter().try_fold(0_u64, |total, row| {
        Ok::<_, ApiError>(total.saturating_add(number(
            i64::from(row.get::<i32, _>("projection_bytes")),
            "candidate projection bytes",
        )?))
    })?;
    if current_projection_bytes > state.plan.budgets.max_candidate_bytes {
        let observed = scoped_budget_observed(
            &plan.allowed_types,
            state.plan.budgets.max_candidate_bytes,
            current_projection_bytes,
        );
        return Err(query_budget_error(
            "hosted_byte_budget_exceeded",
            "The stale Obsidian Base union exceeded its candidate-byte budget.",
            "candidate_bytes",
            state.plan.budgets.max_candidate_bytes,
            observed,
        ));
    }
    let current_ids = rows
        .iter()
        .filter(|row| row.get::<bool, _>("projection_current"))
        .map(|row| row.get::<Uuid, _>("record_id"))
        .collect::<Vec<_>>();
    let mut current_projections =
        load_current_projection_rows_by_ids(transaction, collection_id, state, &current_ids)
            .await?;

    let mut candidates = Vec::with_capacity(rows.len());
    let mut projections = HashMap::with_capacity(rows.len());
    let mut exact_ids = Vec::new();
    for row in rows {
        let record_id: Uuid = row.get("record_id");
        match current_projections.remove(&record_id) {
            Some(projected) => {
                let projection = projected.projection;
                let canonical_path =
                    row.get::<Option<String>, _>("canonical_path")
                        .ok_or_else(|| {
                            ApiError::internal("A current Base projection has no canonical path.")
                        })?;
                candidates.push(ProjectedQueryRow {
                    record_id,
                    canonical_path,
                    projection: projection.clone(),
                });
                projections.insert(record_id, projection);
            }
            None => exact_ids.push(record_id),
        }
    }
    if exact_ids.len() as u64 > state.plan.budgets.max_exact_documents {
        let observed = scoped_budget_observed(
            &plan.allowed_types,
            state.plan.budgets.max_exact_documents,
            exact_ids.len() as u64,
        );
        return Err(query_budget_error(
            "hosted_exact_document_budget_exceeded",
            "The stale Obsidian Base union exceeded its exact-document budget.",
            "exact_documents",
            state.plan.budgets.max_exact_documents,
            observed,
        ));
    }
    let exact_records = load_exact_query_records(
        transaction,
        crypto,
        data_key,
        collection_id,
        state.snapshot_head,
        &exact_ids,
    )
    .await?;
    if exact_records.len() != exact_ids.len() {
        return Err(ApiError::conflict(
            "hosted_exact_snapshot_inconsistent",
            "The stale Obsidian Base union could not load every exact authority record.",
        ));
    }
    let exact_bytes = exact_records.values().fold(0_u64, |total, record| {
        total.saturating_add(record.document.len() as u64)
    });
    if exact_bytes > state.plan.budgets.max_exact_bytes {
        let observed = scoped_budget_observed(
            &plan.allowed_types,
            state.plan.budgets.max_exact_bytes,
            exact_bytes,
        );
        return Err(query_budget_error(
            "hosted_exact_byte_budget_exceeded",
            "The stale Obsidian Base union exceeded its exact-plaintext byte budget.",
            "exact_bytes",
            state.plan.budgets.max_exact_bytes,
            observed,
        ));
    }
    let prepared = exact_ids
        .iter()
        .map(|record_id| {
            let record = exact_records.get(record_id).ok_or_else(|| {
                ApiError::internal("A stale Base authority record disappeared before projection.")
            })?;
            let prepared = catalog
                .project_record(record)
                .map_err(projection_inconsistent)?;
            Ok((record_id.to_string(), prepared))
        })
        .collect::<ApiResult<Vec<_>>>()?;
    let finalized = catalog
        .finalize_projection_batch(prepared)
        .map_err(projection_inconsistent)?;
    for (record_id, projection) in finalized {
        let record_id = Uuid::parse_str(&record_id).map_err(|_| {
            ApiError::internal("A stale Base projection lost its exact record identity.")
        })?;
        candidates.push(ProjectedQueryRow {
            record_id,
            canonical_path: projection.facts.path.clone(),
            projection: projection.clone(),
        });
        projections.insert(record_id, projection);
    }
    let query_context = match plan.context_path.as_deref() {
        Some(path) => state.base_context.clone().or_else(|| {
            projections
                .values()
                .find(|projection| projection.facts.path == path)
                .cloned()
        }),
        None => None,
    };
    if plan.context_path.is_some() && query_context.is_none() {
        return Err(ApiError::conflict(
            "hosted_base_context_unavailable",
            "The stale Base union has no requested context record.",
        ));
    }
    let projection_bytes = serialized_projection_bytes(&projections)?;
    Ok(BaseExecutionSnapshot {
        rows: candidates,
        projections,
        adjacency: HashMap::new(),
        relationship_rows: 0,
        projection_bytes,
        exact_documents: exact_ids.len() as u64,
        exact_bytes,
        query_context,
    })
}

#[allow(clippy::too_many_arguments)]
async fn load_base_exact_fallback_snapshot(
    transaction: &mut Transaction<'_, Postgres>,
    crypto: &ProviderCrypto,
    data_key: &[u8; 32],
    collection_id: Uuid,
    state: &HostedQueryState,
    catalog: &mdbase::runtime::CompiledCatalog,
    plan: &mdbase::runtime::HostedBasePlan,
) -> ApiResult<BaseExecutionSnapshot> {
    let live_ids = sqlx::query_scalar::<_, Uuid>(
        r#"WITH live AS (
             SELECT DISTINCT ON (record_id) record_id, deleted
             FROM hosted_provider_record_versions
             WHERE collection_id = $1 AND sequence <= $2
             ORDER BY record_id, sequence DESC
           )
           SELECT record_id FROM live WHERE NOT deleted
           ORDER BY record_id LIMIT $3"#,
    )
    .bind(collection_id)
    .bind(to_i64(state.snapshot_head, "query snapshot head")?)
    .bind(to_i64(
        state.plan.budgets.max_exact_documents.saturating_add(1),
        "exact fallback document budget",
    )?)
    .fetch_all(&mut **transaction)
    .await?;
    if live_ids.len() as u64 > state.plan.budgets.max_exact_documents {
        return Err(query_budget_error(
            "hosted_exact_document_budget_exceeded",
            "The stale Obsidian Base fallback exceeded its exact-document budget.",
            "exact_documents",
            state.plan.budgets.max_exact_documents,
            live_ids.len() as u64,
        ));
    }
    let exact_records = load_exact_query_records(
        transaction,
        crypto,
        data_key,
        collection_id,
        state.snapshot_head,
        &live_ids,
    )
    .await?;
    if exact_records.len() != live_ids.len() {
        return Err(ApiError::conflict(
            "hosted_exact_snapshot_inconsistent",
            "The stale Obsidian Base fallback could not load its complete exact snapshot.",
        ));
    }
    let exact_bytes = exact_records.values().fold(0_u64, |total, record| {
        total.saturating_add(record.document.len() as u64)
    });
    if exact_bytes > state.plan.budgets.max_exact_bytes {
        return Err(query_budget_error(
            "hosted_exact_byte_budget_exceeded",
            "The stale Obsidian Base fallback exceeded its exact-plaintext byte budget.",
            "exact_bytes",
            state.plan.budgets.max_exact_bytes,
            exact_bytes,
        ));
    }

    let mut prepared = Vec::with_capacity(live_ids.len());
    for record_id in &live_ids {
        let record = exact_records.get(record_id).ok_or_else(|| {
            ApiError::internal("An exact fallback record disappeared from its bounded snapshot.")
        })?;
        let projection = catalog.project_record(record).map_err(|error| {
            ApiError::conflict(
                "hosted_projection_inconsistent",
                format!(
                    "Exact Obsidian Base fallback projection failed canonical semantics: {}",
                    error.code
                ),
            )
        })?;
        prepared.push((record_id.to_string(), projection));
    }
    let finalized = catalog
        .finalize_projection_batch(prepared)
        .map_err(|error| {
            if error.code == "relationship_resolution_budget_exceeded" {
                query_budget_error(
                    "hosted_operator_budget_exceeded",
                    "The stale Obsidian Base fallback exceeded its relationship-resolution budget.",
                    "relationship_candidates",
                    mdbase::runtime::MAX_RESOLUTION_CANDIDATES as u64,
                    (mdbase::runtime::MAX_RESOLUTION_CANDIDATES as u64).saturating_add(1),
                )
            } else {
                projection_inconsistent(error)
            }
        })?;
    let projections = finalized
        .into_iter()
        .map(|(record_id, projection)| {
            let record_id = Uuid::parse_str(&record_id).map_err(|_| {
                ApiError::internal(
                    "A canonical exact fallback projection lost its record identity.",
                )
            })?;
            Ok((record_id, projection))
        })
        .collect::<ApiResult<HashMap<_, _>>>()?;
    let rows = live_ids
        .iter()
        .filter_map(|record_id| {
            let projection = projections.get(record_id)?;
            (plan.allowed_types.is_empty()
                || projection
                    .facts
                    .types
                    .iter()
                    .any(|name| plan.allowed_types.contains(name)))
            .then(|| ProjectedQueryRow {
                record_id: *record_id,
                canonical_path: projection.facts.path.clone(),
                projection: projection.clone(),
            })
        })
        .collect::<Vec<_>>();
    let mut adjacency = HashMap::<Uuid, BTreeSet<Uuid>>::new();
    let mut relationship_rows = 0_u64;
    if plan.requirements.backlinks
        || plan.requirements.outgoing_relationships
        || plan.requirements.link_resolution
    {
        for (source, projection) in &projections {
            for occurrence in &projection.structure.occurrences {
                let Some(target) = occurrence
                    .target_record_id
                    .as_deref()
                    .and_then(|value| Uuid::parse_str(value).ok())
                else {
                    continue;
                };
                relationship_rows = relationship_rows.saturating_add(1);
                if relationship_rows > state.plan.budgets.max_operator_steps {
                    return Err(query_budget_error(
                        "hosted_operator_budget_exceeded",
                        "The stale Obsidian Base fallback exceeded its relationship-edge budget.",
                        "relationship_edges",
                        state.plan.budgets.max_operator_steps,
                        relationship_rows,
                    ));
                }
                adjacency.entry(*source).or_default().insert(target);
                adjacency.entry(target).or_default().insert(*source);
            }
        }
    }
    let projection_bytes = serialized_projection_bytes(&projections)?;
    let query_context = match plan.context_path.as_deref() {
        Some(path) => Some(
            projections
                .values()
                .find(|projection| projection.facts.path == path)
                .cloned()
                .ok_or_else(|| {
                    ApiError::conflict(
                        "hosted_base_context_unavailable",
                        "The exact Base fallback snapshot has no requested context record.",
                    )
                })?,
        ),
        None => None,
    };
    Ok(BaseExecutionSnapshot {
        rows,
        projections,
        adjacency,
        relationship_rows,
        projection_bytes,
        exact_documents: live_ids.len() as u64,
        exact_bytes,
        query_context,
    })
}

fn serialized_projection_bytes(
    projections: &HashMap<Uuid, mdbase::runtime::SemanticProjection>,
) -> ApiResult<u64> {
    projections.values().try_fold(0_u64, |total, projection| {
        let bytes = serde_json::to_vec(projection).map_err(|error| {
            ApiError::internal(format!(
                "Obsidian Base projection could not serialize: {error}"
            ))
        })?;
        Ok(total.saturating_add(bytes.len() as u64))
    })
}

async fn load_current_projection_rows_by_ids(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
    state: &HostedQueryState,
    record_ids: &[Uuid],
) -> ApiResult<HashMap<Uuid, ProjectedQueryRow>> {
    if record_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = sqlx::query(
        r#"SELECT record_id, canonical_path, semantic_projection
           FROM hosted_provider_record_projections
           WHERE collection_id = $1 AND generation_id = $2
             AND record_id = ANY($3::uuid[])
             AND valid_from_sequence <= $4
             AND (valid_to_sequence IS NULL OR valid_to_sequence > $4)
             AND catalog_revision = $5 AND projection_format_version = $6
             AND semantic_engine_version = $7
             AND semantic_complete AND resolution_complete
           ORDER BY record_id"#,
    )
    .bind(collection_id)
    .bind(state.generation_id)
    .bind(record_ids)
    .bind(to_i64(state.snapshot_head, "query snapshot head")?)
    .bind(&state.catalog_revision)
    .bind(i64::from(state.projection_format_version))
    .bind(&state.semantic_engine_version)
    .fetch_all(&mut **transaction)
    .await?;
    if rows.len() != record_ids.len() {
        return Err(ApiError::conflict(
            "hosted_projection_inconsistent",
            "A preflighted current projection changed within its query snapshot.",
        ));
    }
    rows.into_iter()
        .map(|row| {
            let record_id: Uuid = row.get("record_id");
            let projection =
                serde_json::from_value(row.get("semantic_projection")).map_err(|error| {
                    ApiError::conflict(
                        "hosted_projection_inconsistent",
                        format!("A current semantic projection could not decode: {error}"),
                    )
                })?;
            Ok((
                record_id,
                ProjectedQueryRow {
                    record_id,
                    canonical_path: row.get("canonical_path"),
                    projection,
                },
            ))
        })
        .collect()
}

fn projected_metadata_bytes(rows: &[ProjectedQueryMetadata]) -> u64 {
    rows.iter().fold(0_u64, |total, row| {
        total.saturating_add(row.projection_bytes)
    })
}

async fn load_base_candidate_projections(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
    state: &HostedQueryState,
    plan: &mdbase::runtime::HostedBasePlan,
) -> ApiResult<(Vec<ProjectedQueryRow>, u64)> {
    let mut query = QueryBuilder::<Postgres>::new(
        "WITH live AS (\
           SELECT DISTINCT ON (record_id) record_id, sequence, revision, deleted \
           FROM hosted_provider_record_versions WHERE collection_id = ",
    );
    query
        .push_bind(collection_id)
        .push(" AND sequence <= ")
        .push_bind(to_i64(state.snapshot_head, "query snapshot head")?)
        .push(
            " ORDER BY record_id, sequence DESC\
         ) SELECT p.record_id, p.canonical_path, p.projection_bytes \
         FROM hosted_provider_record_projections p JOIN live l \
           ON l.record_id = p.record_id AND NOT l.deleted \
          AND l.sequence = p.record_sequence AND l.revision = p.record_revision \
         WHERE p.collection_id = ",
        )
        .push_bind(collection_id)
        .push(" AND p.generation_id = ")
        .push_bind(state.generation_id)
        .push(" AND p.valid_from_sequence <= ")
        .push_bind(to_i64(state.snapshot_head, "query snapshot head")?)
        .push(" AND (p.valid_to_sequence IS NULL OR p.valid_to_sequence > ")
        .push_bind(to_i64(state.snapshot_head, "query snapshot head")?)
        .push(") AND p.catalog_revision = ")
        .push_bind(&state.catalog_revision)
        .push(" AND p.projection_format_version = ")
        .push_bind(i64::from(state.projection_format_version))
        .push(" AND p.semantic_engine_version = ")
        .push_bind(&state.semantic_engine_version)
        .push(
            " AND p.semantic_complete AND p.resolution_complete \
                AND (cardinality(",
        )
        .push_bind(&plan.allowed_types)
        .push("::text[]) = 0 OR p.matched_types && ")
        .push_bind(&plan.allowed_types)
        .push("::text[]) AND (");
    push_candidate_predicate(&mut query, &plan.candidate);
    query
        .push(") ORDER BY p.record_id LIMIT ")
        .push_bind(to_i64(
            state.plan.budgets.max_candidate_rows.saturating_add(1),
            "candidate row budget",
        )?);
    let rows = query.build().fetch_all(&mut **transaction).await?;
    if rows.len() as u64 > state.plan.budgets.max_candidate_rows {
        return Err(query_budget_error(
            "hosted_scan_budget_exceeded",
            "The Obsidian Base exceeded its candidate-row budget.",
            "candidate_rows",
            state.plan.budgets.max_candidate_rows,
            rows.len() as u64,
        ));
    }
    let metadata = rows
        .into_iter()
        .map(|row| {
            Ok(ProjectedQueryMetadata {
                record_id: row.get("record_id"),
                canonical_path: row.get("canonical_path"),
                projection_bytes: number(
                    i64::from(row.get::<i32, _>("projection_bytes")),
                    "candidate projection bytes",
                )?,
            })
        })
        .collect::<ApiResult<Vec<_>>>()?;
    let projection_bytes = projected_metadata_bytes(&metadata);
    if projection_bytes > state.plan.budgets.max_candidate_bytes {
        return Err(query_budget_error(
            "hosted_byte_budget_exceeded",
            "The Obsidian Base exceeded its transferred projection-byte budget.",
            "candidate_bytes",
            state.plan.budgets.max_candidate_bytes,
            projection_bytes,
        ));
    }
    let record_ids = metadata.iter().map(|row| row.record_id).collect::<Vec<_>>();
    let mut loaded =
        load_current_projection_rows_by_ids(transaction, collection_id, state, &record_ids).await?;
    let rows = metadata
        .into_iter()
        .map(|metadata| {
            let row = loaded.remove(&metadata.record_id).ok_or_else(|| {
                ApiError::conflict(
                    "hosted_projection_inconsistent",
                    "A preflighted Base projection disappeared from its query snapshot.",
                )
            })?;
            if row.canonical_path != metadata.canonical_path {
                return Err(ApiError::conflict(
                    "hosted_projection_inconsistent",
                    "A preflighted Base projection changed path within its query snapshot.",
                ));
            }
            Ok(row)
        })
        .collect::<ApiResult<Vec<_>>>()?;
    Ok((rows, projection_bytes))
}

async fn load_base_related_projections(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
    state: &HostedQueryState,
    record_ids: &[Uuid],
    remaining_projection_bytes: u64,
) -> ApiResult<(Vec<(Uuid, mdbase::runtime::SemanticProjection)>, u64)> {
    if record_ids.is_empty() {
        return Ok((Vec::new(), 0));
    }
    if record_ids.len() > mdbase::runtime::MAX_HOSTED_BASE_RELATED_RECORDS {
        return Err(query_budget_error(
            "hosted_base_relationship_budget_exceeded",
            "The Obsidian Base exceeded its related-record budget.",
            "related_records",
            mdbase::runtime::MAX_HOSTED_BASE_RELATED_RECORDS as u64,
            record_ids.len() as u64,
        ));
    }
    let rows = sqlx::query(
        r#"WITH live AS (
             SELECT DISTINCT ON (record_id) record_id, sequence, revision, deleted
             FROM hosted_provider_record_versions
             WHERE collection_id = $1 AND sequence <= $4
             ORDER BY record_id, sequence DESC
           )
           SELECT p.record_id, p.canonical_path, p.projection_bytes
           FROM hosted_provider_record_projections p
           JOIN live l ON l.record_id = p.record_id AND NOT l.deleted
             AND l.sequence = p.record_sequence AND l.revision = p.record_revision
           WHERE p.collection_id = $1 AND p.generation_id = $2
             AND p.record_id = ANY($3::uuid[])
             AND p.valid_from_sequence <= $4
             AND (p.valid_to_sequence IS NULL OR p.valid_to_sequence > $4)
             AND p.catalog_revision = $5 AND p.projection_format_version = $6
             AND p.semantic_engine_version = $7
             AND p.semantic_complete AND p.resolution_complete
           ORDER BY p.record_id"#,
    )
    .bind(collection_id)
    .bind(state.generation_id)
    .bind(record_ids)
    .bind(to_i64(state.snapshot_head, "query snapshot head")?)
    .bind(&state.catalog_revision)
    .bind(i64::from(state.projection_format_version))
    .bind(&state.semantic_engine_version)
    .fetch_all(&mut **transaction)
    .await?;
    if rows.len() != record_ids.len() {
        return Err(ApiError::conflict(
            "hosted_projection_inconsistent",
            "A related Base projection is absent or stale at the query snapshot.",
        ));
    }
    let metadata = rows
        .into_iter()
        .map(|row| {
            Ok(ProjectedQueryMetadata {
                record_id: row.get("record_id"),
                canonical_path: row.get("canonical_path"),
                projection_bytes: number(
                    i64::from(row.get::<i32, _>("projection_bytes")),
                    "related projection bytes",
                )?,
            })
        })
        .collect::<ApiResult<Vec<_>>>()?;
    let projection_bytes = projected_metadata_bytes(&metadata);
    if projection_bytes > remaining_projection_bytes {
        return Err(query_budget_error(
            "hosted_byte_budget_exceeded",
            "The Obsidian Base exceeded its transferred projection-byte budget.",
            "candidate_bytes",
            state.plan.budgets.max_candidate_bytes,
            state
                .plan
                .budgets
                .max_candidate_bytes
                .saturating_sub(remaining_projection_bytes)
                .saturating_add(projection_bytes),
        ));
    }
    let mut loaded =
        load_current_projection_rows_by_ids(transaction, collection_id, state, record_ids).await?;
    let projections = metadata
        .into_iter()
        .map(|metadata| {
            let row = loaded.remove(&metadata.record_id).ok_or_else(|| {
                ApiError::conflict(
                    "hosted_projection_inconsistent",
                    "A preflighted related projection disappeared from its query snapshot.",
                )
            })?;
            Ok((metadata.record_id, row.projection))
        })
        .collect::<ApiResult<Vec<_>>>()?;
    Ok((projections, projection_bytes))
}

#[allow(clippy::too_many_arguments)]
async fn execute_bounded_residual_page(
    transaction: &mut Transaction<'_, Postgres>,
    crypto: &ProviderCrypto,
    data_key: &[u8; 32],
    collection_id: Uuid,
    state: &HostedQueryState,
    catalog: &mdbase::runtime::CompiledCatalog,
    page_size: u64,
    started: Instant,
) -> ApiResult<ExecutedQueryPage> {
    let mut query = QueryBuilder::<Postgres>::new(
        "WITH live AS (SELECT DISTINCT ON (record_id) record_id, sequence, revision, deleted \
         FROM hosted_provider_record_versions WHERE collection_id = ",
    );
    query
        .push_bind(collection_id)
        .push(" AND sequence <= ")
        .push_bind(to_i64(state.snapshot_head, "query snapshot head")?)
        .push(
            " ORDER BY record_id, sequence DESC), joined AS (SELECT l.record_id, l.deleted, \
               p.matched_types, p.projection_bytes, p.semantic_projection,
               p.record_id IS NOT NULL \
               AND p.record_sequence = l.sequence AND p.record_revision = l.revision \
               AND p.catalog_revision = ",
        )
        .push_bind(&state.catalog_revision)
        .push(" AND p.projection_format_version = ")
        .push_bind(i64::from(state.projection_format_version))
        .push(" AND p.semantic_engine_version = ")
        .push_bind(&state.semantic_engine_version)
        .push(
            " AND p.semantic_complete AND p.resolution_complete AS projection_current \
               FROM live l LEFT JOIN hosted_provider_record_projections p ON p.collection_id = ",
        )
        .push_bind(collection_id)
        .push(" AND p.generation_id = ")
        .push_bind(state.generation_id)
        .push(" AND p.record_id = l.record_id AND p.valid_from_sequence <= ")
        .push_bind(to_i64(state.snapshot_head, "query snapshot head")?)
        .push(" AND (p.valid_to_sequence IS NULL OR p.valid_to_sequence > ")
        .push_bind(to_i64(state.snapshot_head, "query snapshot head")?)
        .push(
            ")) SELECT record_id, projection_current, CASE WHEN projection_current THEN \
                projection_bytes ELSE 0 END AS projection_bytes FROM joined \
                WHERE NOT deleted AND (NOT projection_current OR (",
        );
    if state.plan.requirements.diagnostic_type_matchers {
        query.push("TRUE");
    } else {
        push_candidate_predicate(&mut query, &state.plan.candidate);
    }
    query.push(")) ORDER BY record_id LIMIT ").push_bind(to_i64(
        state.plan.budgets.max_candidate_rows.saturating_add(1),
        "candidate row budget",
    )?);
    let rows = query.build().fetch_all(&mut **transaction).await?;
    if rows.len() as u64 > state.plan.budgets.max_candidate_rows {
        return Err(query_budget_error(
            "hosted_scan_budget_exceeded",
            "The hosted query exceeded its candidate-row budget.",
            "candidate_rows",
            state.plan.budgets.max_candidate_rows,
            rows.len() as u64,
        ));
    }
    let projection_bytes = rows.iter().try_fold(0_u64, |total, row| {
        let bytes = number(
            i64::from(row.get::<i32, _>("projection_bytes")),
            "candidate projection bytes",
        )?;
        Ok::<_, ApiError>(total.saturating_add(bytes))
    })?;
    if projection_bytes > state.plan.budgets.max_candidate_bytes {
        return Err(query_budget_error(
            "hosted_byte_budget_exceeded",
            "The hosted query exceeded its candidate-byte budget.",
            "candidate_bytes",
            state.plan.budgets.max_candidate_bytes,
            projection_bytes,
        ));
    }
    if rows.len() as u64 > state.plan.budgets.max_operator_steps {
        return Err(query_budget_error(
            "hosted_operator_budget_exceeded",
            "The hosted query exceeded its operator-step budget.",
            "operator_steps",
            state.plan.budgets.max_operator_steps,
            rows.len() as u64,
        ));
    }

    let candidate_count = rows.len() as u64;
    let current_ids = rows
        .iter()
        .filter(|row| row.get::<bool, _>("projection_current"))
        .map(|row| row.get::<Uuid, _>("record_id"))
        .collect::<Vec<_>>();
    let current_projections =
        load_current_projection_rows_by_ids(transaction, collection_id, state, &current_ids)
            .await?;
    let mut candidates = Vec::with_capacity(rows.len());
    let mut exact_ids = Vec::new();
    let mut projected_evaluations = HashMap::new();
    for row in rows {
        let record_id: Uuid = row.get("record_id");
        let projection = current_projections
            .get(&record_id)
            .map(|row| &row.projection);
        if state.plan.requirements.exact_document || projection.is_none() {
            exact_ids.push(record_id);
        } else if let Some(projection) = projection {
            match catalog.evaluate_hosted_projection_residual(&state.plan, projection) {
                Ok(evaluation) => {
                    projected_evaluations.insert(record_id, evaluation);
                }
                Err(error) if error.code == "hosted_exact_residual_required" => {
                    exact_ids.push(record_id);
                }
                Err(error) => return Err(projection_inconsistent(error)),
            }
        }
        candidates.push(BoundedProjectionCandidate { record_id });
    }
    exact_ids.sort();
    exact_ids.dedup();
    let context_documents = u64::from(state.exact_context.is_some());
    if (exact_ids.len() as u64).saturating_add(context_documents)
        > state.plan.budgets.max_exact_documents
    {
        return Err(query_budget_error(
            "hosted_exact_document_budget_exceeded",
            "The hosted query exceeded its exact-document budget.",
            "exact_documents",
            state.plan.budgets.max_exact_documents,
            (exact_ids.len() as u64).saturating_add(context_documents),
        ));
    }
    let exact_records = load_exact_query_records(
        transaction,
        crypto,
        data_key,
        collection_id,
        state.snapshot_head,
        &exact_ids,
    )
    .await?;
    let exact_bytes = exact_records
        .values()
        .fold(0_u64, |total, record| {
            total.saturating_add(record.document.len() as u64)
        })
        .saturating_add(
            state
                .exact_context
                .as_ref()
                .map_or(0, |context| context.document.len() as u64),
        );
    if exact_bytes > state.plan.budgets.max_exact_bytes {
        return Err(query_budget_error(
            "hosted_exact_byte_budget_exceeded",
            "The hosted query exceeded its exact-plaintext byte budget.",
            "exact_bytes",
            state.plan.budgets.max_exact_bytes,
            exact_bytes,
        ));
    }

    let mut diagnostics = Vec::new();
    let mut matching = Vec::<BoundedQueryMatch>::new();
    for candidate in candidates {
        let evaluation =
            if let Some(evaluation) = projected_evaluations.remove(&candidate.record_id) {
                evaluation
            } else {
                let record = exact_records.get(&candidate.record_id).ok_or_else(|| {
                    ApiError::internal("A bounded hosted candidate has no exact snapshot record.")
                })?;
                catalog
                    .evaluate_hosted_residual_with_context(
                        &state.plan,
                        record,
                        state.exact_context.as_ref(),
                    )
                    .map_err(projection_inconsistent)?
            };
        diagnostics.extend(evaluation.diagnostics);
        if let Some(result) = evaluation.record.filter(|_| evaluation.matched) {
            let path = result
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| ApiError::internal("A hosted query result has no path."))?
                .to_string();
            matching.push(BoundedQueryMatch {
                path,
                record_id: candidate.record_id,
                result,
                order_values: evaluation.order_values,
                reduction: mdbase::runtime::HostedReductionInput {
                    group_values: evaluation.group_values,
                    aggregate_values: evaluation.aggregate_values,
                },
            });
        }
    }
    matching.sort_by(|left, right| {
        state
            .plan
            .compare_order_values(
                &left.order_values,
                &left.path,
                &right.order_values,
                &right.path,
            )
            .then_with(|| left.record_id.cmp(&right.record_id))
    });
    let total_count = matching.len() as u64;
    let operator_steps = candidate_count.saturating_add(
        total_count.saturating_mul(
            u64::from(total_count.max(1).ilog2().saturating_add(1))
                .saturating_add(state.plan.order.len() as u64)
                .saturating_add(state.plan.groups.len() as u64)
                .saturating_add(state.plan.aggregates.len() as u64),
        ),
    );
    if operator_steps > state.plan.budgets.max_operator_steps {
        return Err(query_budget_error(
            "hosted_operator_budget_exceeded",
            "The hosted query exceeded its bounded operator-step budget.",
            "operator_steps",
            state.plan.budgets.max_operator_steps,
            operator_steps,
        ));
    }
    let matching_bytes = matching.iter().fold(0_u64, |total, item| {
        total
            .saturating_add(serialized_value_bytes(&item.result))
            .saturating_add(serialized_value_bytes(&Value::Array(
                item.order_values.clone(),
            )))
            .saturating_add(serialized_value_bytes(&Value::Array(
                item.reduction.group_values.clone(),
            )))
            .saturating_add(serialized_value_bytes(&Value::Array(
                item.reduction.aggregate_values.clone(),
            )))
    });
    let reduction_inputs = matching
        .iter()
        .map(|item| item.reduction.clone())
        .collect::<Vec<_>>();
    let reduction_input_bytes = reduction_inputs.iter().fold(0_u64, |total, item| {
        total
            .saturating_add(serialized_value_bytes(&Value::Array(
                item.group_values.clone(),
            )))
            .saturating_add(serialized_value_bytes(&Value::Array(
                item.aggregate_values.clone(),
            )))
    });
    let pre_reduction_resident_bytes = projection_bytes
        .saturating_add(exact_bytes)
        .saturating_add(matching_bytes)
        // The reducer partitions its bounded input by value. Account for that
        // temporary copy before allocating it, rather than observing RSS late.
        .saturating_add(reduction_input_bytes.saturating_mul(2));
    if pre_reduction_resident_bytes > state.plan.budgets.max_memory_bytes {
        return Err(query_budget_error(
            "hosted_memory_budget_exceeded",
            "The hosted query exceeded its bounded resident-memory budget.",
            "memory_bytes",
            state.plan.budgets.max_memory_bytes,
            pre_reduction_resident_bytes,
        ));
    }
    let reduction = state
        .plan
        .reduce_matches(&reduction_inputs)
        .map_err(projection_inconsistent)?;
    diagnostics.extend(reduction.diagnostics);
    let groups_bytes = reduction.groups.as_ref().map_or(0, |groups| {
        serialized_value_bytes(&Value::Array(groups.clone()))
    });
    let resident_bytes = pre_reduction_resident_bytes.saturating_add(groups_bytes);
    if resident_bytes > state.plan.budgets.max_memory_bytes {
        return Err(query_budget_error(
            "hosted_memory_budget_exceeded",
            "The hosted query exceeded its bounded resident-memory budget.",
            "memory_bytes",
            state.plan.budgets.max_memory_bytes,
            resident_bytes,
        ));
    }
    let after_keyset = matching.into_iter().filter(|item| {
        let Some(last_path) = state.last_path.as_deref() else {
            return true;
        };
        let ordering = state.plan.compare_order_values(
            &item.order_values,
            &item.path,
            &state.last_order_values,
            last_path,
        );
        ordering.is_gt()
            || (ordering.is_eq()
                && state
                    .last_record_id
                    .is_some_and(|last| item.record_id > last))
    });
    let offset = if state.last_path.is_none() {
        state.plan.offset
    } else {
        0
    };
    let page = after_keyset
        .skip(usize::try_from(offset).unwrap_or(usize::MAX))
        .take(usize::try_from(page_size).unwrap_or(usize::MAX))
        .collect::<Vec<_>>();
    let last_boundary = page.last().map(|item| QueryPageBoundary {
        order_values: item.order_values.clone(),
        path: item.path.clone(),
        record_id: item.record_id,
    });
    let results = page.into_iter().map(|item| item.result).collect::<Vec<_>>();
    if started.elapsed().as_millis() as u64 > state.plan.budgets.max_wall_time_ms {
        return Err(query_budget_error(
            "hosted_time_budget_exceeded",
            "The hosted query exceeded its wall-time budget.",
            "wall_time_ms",
            state.plan.budgets.max_wall_time_ms,
            started.elapsed().as_millis() as u64,
        ));
    }
    Ok(ExecutedQueryPage {
        results,
        diagnostics,
        groups: reduction.groups,
        total_count,
        last_boundary,
        candidate_rows: candidate_count,
        exact_documents: (exact_records.len() as u64).saturating_add(context_documents),
    })
}

fn projection_inconsistent(error: mdbase::runtime::CatalogError) -> ApiError {
    ApiError::conflict("hosted_projection_inconsistent", error.message)
        .with_details(json!({ "semantic_code": error.code }))
}

fn query_budget_error(
    code: &str,
    message: &str,
    budget: &str,
    limit: u64,
    observed: u64,
) -> ApiError {
    ApiError::quota(code, message).with_details(json!({
        "budget": budget,
        "limit": limit,
        "observed": observed,
    }))
}

fn scoped_budget_observed(allowed_types: &[String], limit: u64, observed: u64) -> u64 {
    if allowed_types.is_empty() {
        observed
    } else {
        // The stale/absent safety union must include identities whose canonical
        // type is not yet known. A scoped caller may learn that the public
        // threshold was crossed, but not the aggregate count or plaintext size
        // of records that canonical evaluation would later exclude.
        limit.saturating_add(1)
    }
}

fn serialized_value_bytes(value: &Value) -> u64 {
    serde_json::to_vec(value).map_or(0, |bytes| bytes.len() as u64)
}

async fn count_projected_candidates(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
    state: &HostedQueryState,
    candidate_types: &[String],
) -> ApiResult<u64> {
    let count: i64 = sqlx::query_scalar(
        r#"WITH live AS (
             SELECT DISTINCT ON (record_id) record_id, sequence, revision, deleted
             FROM hosted_provider_record_versions
             WHERE collection_id = $1 AND sequence <= $3
             ORDER BY record_id, sequence DESC
           )
           SELECT count(*)
           FROM hosted_provider_record_projections p
           JOIN live l ON l.record_id = p.record_id AND NOT l.deleted
             AND l.sequence = p.record_sequence AND l.revision = p.record_revision
           WHERE p.collection_id = $1 AND p.generation_id = $2
             AND p.valid_from_sequence <= $3
             AND (p.valid_to_sequence IS NULL OR p.valid_to_sequence > $3)
             AND p.catalog_revision = $4 AND p.projection_format_version = $5
             AND p.semantic_engine_version = $6
             AND p.semantic_complete AND p.resolution_complete
             AND (cardinality($7::text[]) = 0 OR p.matched_types && $7::text[])"#,
    )
    .bind(collection_id)
    .bind(state.generation_id)
    .bind(to_i64(state.snapshot_head, "query snapshot head")?)
    .bind(&state.catalog_revision)
    .bind(i64::from(state.projection_format_version))
    .bind(&state.semantic_engine_version)
    .bind(candidate_types)
    .fetch_one(&mut **transaction)
    .await?;
    number(count, "query total count")
}

#[allow(clippy::too_many_arguments)]
async fn load_projected_page(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
    state: &HostedQueryState,
    candidate_types: &[String],
    descending: bool,
    page_size: u64,
) -> ApiResult<Vec<ProjectedQueryRow>> {
    let sql = if descending {
        r#"WITH live AS (
             SELECT DISTINCT ON (record_id) record_id, sequence, revision, deleted
             FROM hosted_provider_record_versions
             WHERE collection_id = $1 AND sequence <= $3
             ORDER BY record_id, sequence DESC
           )
           SELECT p.record_id, p.canonical_path, p.projection_bytes
           FROM hosted_provider_record_projections p
           JOIN live l ON l.record_id = p.record_id AND NOT l.deleted
             AND l.sequence = p.record_sequence AND l.revision = p.record_revision
           WHERE p.collection_id = $1 AND p.generation_id = $2
             AND p.valid_from_sequence <= $3
             AND (p.valid_to_sequence IS NULL OR p.valid_to_sequence > $3)
             AND p.catalog_revision = $4 AND p.projection_format_version = $5
             AND p.semantic_engine_version = $6
             AND p.semantic_complete AND p.resolution_complete
             AND (cardinality($7::text[]) = 0 OR p.matched_types && $7::text[])
             AND ($8::text IS NULL OR p.canonical_path < $8
                  OR (p.canonical_path = $8 AND p.record_id > $9))
           ORDER BY p.canonical_path COLLATE "C" DESC, p.record_id ASC
           OFFSET $10 LIMIT $11"#
    } else {
        r#"WITH live AS (
             SELECT DISTINCT ON (record_id) record_id, sequence, revision, deleted
             FROM hosted_provider_record_versions
             WHERE collection_id = $1 AND sequence <= $3
             ORDER BY record_id, sequence DESC
           )
           SELECT p.record_id, p.canonical_path, p.projection_bytes
           FROM hosted_provider_record_projections p
           JOIN live l ON l.record_id = p.record_id AND NOT l.deleted
             AND l.sequence = p.record_sequence AND l.revision = p.record_revision
           WHERE p.collection_id = $1 AND p.generation_id = $2
             AND p.valid_from_sequence <= $3
             AND (p.valid_to_sequence IS NULL OR p.valid_to_sequence > $3)
             AND p.catalog_revision = $4 AND p.projection_format_version = $5
             AND p.semantic_engine_version = $6
             AND p.semantic_complete AND p.resolution_complete
             AND (cardinality($7::text[]) = 0 OR p.matched_types && $7::text[])
             AND ($8::text IS NULL OR p.canonical_path > $8
                  OR (p.canonical_path = $8 AND p.record_id > $9))
           ORDER BY p.canonical_path COLLATE "C" ASC, p.record_id ASC
           OFFSET $10 LIMIT $11"#
    };
    let rows = sqlx::query(sql)
        .bind(collection_id)
        .bind(state.generation_id)
        .bind(to_i64(state.snapshot_head, "query snapshot head")?)
        .bind(&state.catalog_revision)
        .bind(i64::from(state.projection_format_version))
        .bind(&state.semantic_engine_version)
        .bind(candidate_types)
        .bind(state.last_path.as_deref())
        .bind(state.last_record_id)
        .bind(if state.last_path.is_none() {
            to_i64(state.plan.offset, "query offset")?
        } else {
            0
        })
        .bind(to_i64(page_size, "query page size")?)
        .fetch_all(&mut **transaction)
        .await?;
    let metadata = rows
        .into_iter()
        .map(|row| {
            Ok(ProjectedQueryMetadata {
                record_id: row.get("record_id"),
                canonical_path: row.get("canonical_path"),
                projection_bytes: number(
                    i64::from(row.get::<i32, _>("projection_bytes")),
                    "page projection bytes",
                )?,
            })
        })
        .collect::<ApiResult<Vec<_>>>()?;
    let projection_bytes = projected_metadata_bytes(&metadata);
    if projection_bytes > state.plan.budgets.max_candidate_bytes {
        return Err(query_budget_error(
            "hosted_byte_budget_exceeded",
            "The hosted query page exceeded its transferred projection-byte budget.",
            "candidate_bytes",
            state.plan.budgets.max_candidate_bytes,
            projection_bytes,
        ));
    }
    let record_ids = metadata.iter().map(|row| row.record_id).collect::<Vec<_>>();
    let mut loaded =
        load_current_projection_rows_by_ids(transaction, collection_id, state, &record_ids).await?;
    metadata
        .into_iter()
        .map(|metadata| {
            let row = loaded.remove(&metadata.record_id).ok_or_else(|| {
                ApiError::conflict(
                    "hosted_projection_inconsistent",
                    "A preflighted query-page projection disappeared from its snapshot.",
                )
            })?;
            if row.canonical_path != metadata.canonical_path {
                return Err(ApiError::conflict(
                    "hosted_projection_inconsistent",
                    "A preflighted query-page projection changed path within its snapshot.",
                ));
            }
            Ok(row)
        })
        .collect()
}

async fn load_exact_query_records(
    transaction: &mut Transaction<'_, Postgres>,
    crypto: &ProviderCrypto,
    data_key: &[u8; 32],
    collection_id: Uuid,
    snapshot_head: u64,
    record_ids: &[Uuid],
) -> ApiResult<HashMap<Uuid, mdbase::runtime::CanonicalRecordInput>> {
    if record_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = sqlx::query(
        r#"SELECT DISTINCT ON (record_id) record_id, sequence, payload_ciphertext,
                  deleted, created_at
           FROM hosted_provider_record_versions
           WHERE collection_id = $1 AND record_id = ANY($2::uuid[]) AND sequence <= $3
           ORDER BY record_id, sequence DESC"#,
    )
    .bind(collection_id)
    .bind(record_ids)
    .bind(to_i64(snapshot_head, "query snapshot head")?)
    .fetch_all(&mut **transaction)
    .await?;
    let mut records = HashMap::with_capacity(rows.len());
    for row in rows {
        if row.get::<bool, _>("deleted") {
            continue;
        }
        let record_id: Uuid = row.get("record_id");
        let sequence = number(row.get("sequence"), "record version sequence")?;
        let ciphertext = row
            .get::<Option<Vec<u8>>, _>("payload_ciphertext")
            .ok_or_else(|| ApiError::internal("A live exact record version has no ciphertext."))?;
        let record: PersistedRecord = crypto.decrypt_json(
            data_key,
            &ciphertext,
            &record_version_aad(collection_id, record_id, sequence),
        )?;
        if record.record_id != record_id {
            return Err(ApiError::internal(
                "An exact query record does not match its stored identity.",
            ));
        }
        let modified_at: DateTime<Utc> = row.get("created_at");
        let document_size = record.document.len() as u64;
        records.insert(
            record_id,
            mdbase::runtime::CanonicalRecordInput {
                stable_id: Some(record_id.to_string()),
                path: record.path,
                file_size: document_size,
                document: record.document,
                file_mtime: Some(modified_at.to_rfc3339_opts(SecondsFormat::Micros, true)),
            },
        );
    }
    Ok(records)
}

#[allow(clippy::too_many_arguments)]
async fn insert_query_cursor(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
    replica: &Replica,
    cursor_id: Uuid,
    state: &HostedQueryState,
    last_order_values: &[Value],
    last_path: &str,
    last_record_id: Uuid,
    emitted_rows: u64,
    crypto: &ProviderCrypto,
    data_key: &[u8; 32],
) -> ApiResult<()> {
    let plan = serde_json::to_value(&state.plan).map_err(|error| {
        ApiError::internal(format!("Hosted query plan could not serialize: {error}"))
    })?;
    let mut keyset = last_order_values.to_vec();
    keyset.push(Value::String(last_path.to_string()));
    sqlx::query("SELECT id FROM hosted_provider_replicas WHERE id = $1 FOR UPDATE")
        .bind(replica.id)
        .execute(&mut **transaction)
        .await?;
    let live_cursors: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM hosted_provider_query_cursors WHERE replica_id = $1 AND hard_expires_at > now()",
    )
    .bind(replica.id)
    .fetch_one(&mut **transaction)
    .await?;
    if live_cursors >= MAX_LIVE_QUERY_CURSORS_PER_REPLICA {
        return Err(query_budget_error(
            "hosted_cursor_budget_exceeded",
            "The application replica has too many live hosted query cursors.",
            "live_cursors",
            MAX_LIVE_QUERY_CURSORS_PER_REPLICA as u64,
            live_cursors as u64,
        ));
    }
    let exact_context_ciphertext = state
        .exact_context
        .as_ref()
        .map(|context| {
            crypto.encrypt_json(
                data_key,
                context,
                &query_cursor_context_aad(collection_id, cursor_id),
            )
        })
        .transpose()?;
    let base_plan = state
        .base_plan
        .as_ref()
        .map(serde_json::to_value)
        .transpose()
        .map_err(|error| {
            ApiError::internal(format!("Obsidian Base plan could not serialize: {error}"))
        })?;
    let base_context = state
        .base_context
        .as_ref()
        .map(serde_json::to_value)
        .transpose()
        .map_err(|error| {
            ApiError::internal(format!(
                "Obsidian Base context projection could not serialize: {error}"
            ))
        })?;
    let base_invocation_id = if let Some(base_plan) = base_plan {
        let invocation_id = state.base_invocation_id.unwrap_or_else(Uuid::new_v4);
        if state.base_invocation_id.is_none() {
            sqlx::query(
                r#"INSERT INTO hosted_provider_base_query_invocations
                     (invocation_id, collection_id, replica_id, scope_epoch,
                      base_plan, base_context, base_operation_clock, hard_expires_at)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8)"#,
            )
            .bind(invocation_id)
            .bind(collection_id)
            .bind(replica.id)
            .bind(to_i64(replica.scope_epoch, "scope epoch")?)
            .bind(base_plan)
            .bind(base_context)
            .bind(state.base_operation_clock.as_deref().ok_or_else(|| {
                ApiError::internal("Obsidian Base cursor has no operation clock.")
            })?)
            .bind(state.hard_expires_at)
            .execute(&mut **transaction)
            .await?;
        }
        Some(invocation_id)
    } else {
        None
    };
    sqlx::query(
        r#"INSERT INTO hosted_provider_query_cursors
             (cursor_id, collection_id, replica_id, scope_epoch, snapshot_head,
              generation_id, catalog_revision, projection_format_version,
              semantic_engine_version, query_plan_version, query_digest, query_plan,
              request_kind, request_digest, result_meta, exact_context_ciphertext,
              base_plan, base_context, base_operation_clock, base_invocation_id,
              last_order_values, last_record_id, emitted_rows, expires_at, hard_expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                   $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23,
                   LEAST(now() + make_interval(secs => $24), $25), $25)"#,
    )
    .bind(cursor_id)
    .bind(collection_id)
    .bind(replica.id)
    .bind(to_i64(replica.scope_epoch, "scope epoch")?)
    .bind(to_i64(state.snapshot_head, "query snapshot head")?)
    .bind(state.generation_id)
    .bind(&state.catalog_revision)
    .bind(i64::from(state.projection_format_version))
    .bind(&state.semantic_engine_version)
    .bind(i64::from(state.plan.version))
    .bind(decode_sha256_digest(&state.plan.canonical_query_digest)?)
    .bind(plan)
    .bind(state.request_kind.as_str())
    .bind(decode_sha256_digest(&state.request_digest)?)
    .bind(sqlx::types::Json(&state.result_meta))
    .bind(exact_context_ciphertext)
    .bind(None::<Value>)
    .bind(None::<Value>)
    .bind(None::<String>)
    .bind(base_invocation_id)
    .bind(sqlx::types::Json(keyset))
    .bind(last_record_id)
    .bind(to_i64(emitted_rows, "emitted query rows")?)
    .bind(QUERY_CURSOR_IDLE_SECONDS)
    .bind(state.hard_expires_at)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

fn push_candidate_predicate(
    query: &mut QueryBuilder<Postgres>,
    predicate: &mdbase::runtime::CandidatePredicate,
) {
    use mdbase::runtime::CandidatePredicate;
    match predicate {
        CandidatePredicate::All => {
            query.push("TRUE");
        }
        CandidatePredicate::None => {
            query.push("FALSE");
        }
        CandidatePredicate::HasType { type_name } => {
            query
                .push("matched_types @> ARRAY[")
                .push_bind(type_name.clone())
                .push("]::text[]");
        }
        CandidatePredicate::And { terms } | CandidatePredicate::Or { terms } => {
            let separator = if matches!(predicate, CandidatePredicate::And { .. }) {
                " AND "
            } else {
                " OR "
            };
            query.push("(");
            for (index, term) in terms.iter().enumerate() {
                if index > 0 {
                    query.push(separator);
                }
                push_candidate_predicate(query, term);
            }
            query.push(")");
        }
        CandidatePredicate::Not { term } if candidate_predicate_is_total(term) => {
            query.push("NOT (");
            push_candidate_predicate(query, term);
            query.push(")");
        }
        CandidatePredicate::Not { .. } => {
            query.push("TRUE");
        }
        CandidatePredicate::Compare { comparison }
            if comparison.pruning
                == mdbase::runtime::CandidateComparisonPruning::NormalizedTagHierarchy
                && comparison.field == mdbase::runtime::CandidateField::BodyTags
                && comparison.operator
                    == mdbase::runtime::CandidateComparisonOperator::Contains
                && comparison.value.is_string() =>
        {
            push_tag_hierarchy_candidate_comparison(query, comparison);
        }
        CandidatePredicate::Compare { comparison }
            if comparison.pruning == mdbase::runtime::CandidateComparisonPruning::ExactJson
                && candidate_field_supported(&comparison.field) =>
        {
            push_candidate_comparison(query, comparison);
        }
        CandidatePredicate::Compare { comparison }
            if comparison.pruning
                == mdbase::runtime::CandidateComparisonPruning::IsoDateOnlyString
                && candidate_field_supported(&comparison.field) =>
        {
            push_iso_date_candidate_comparison(query, comparison);
        }
        CandidatePredicate::Compare { .. } => {
            query.push("TRUE");
        }
    }
}

fn push_tag_hierarchy_candidate_comparison(
    query: &mut QueryBuilder<Postgres>,
    comparison: &mdbase::runtime::CandidateComparison,
) {
    let needle = comparison
        .value
        .as_str()
        .expect("tag hierarchy pruning always has a normalized string literal");
    query.push("EXISTS (SELECT 1 FROM jsonb_array_elements_text(");
    push_candidate_field(query, &comparison.field);
    query.push(") AS candidate_tag(value) WHERE ltrim(candidate_tag.value, '#') = ");
    query.push_bind(needle.to_string());
    query.push(" OR left(ltrim(candidate_tag.value, '#'), char_length(");
    query.push_bind(needle.to_string());
    query.push(") + 1) = ");
    query.push_bind(format!("{needle}/")).push(")");
}

fn candidate_predicate_is_total(predicate: &mdbase::runtime::CandidatePredicate) -> bool {
    use mdbase::runtime::CandidatePredicate;
    match predicate {
        CandidatePredicate::All | CandidatePredicate::None | CandidatePredicate::HasType { .. } => {
            true
        }
        CandidatePredicate::And { terms } | CandidatePredicate::Or { terms } => {
            terms.iter().all(candidate_predicate_is_total)
        }
        CandidatePredicate::Not { term } => candidate_predicate_is_total(term),
        CandidatePredicate::Compare { .. } => false,
    }
}

fn candidate_field_supported(field: &mdbase::runtime::CandidateField) -> bool {
    use mdbase::runtime::CandidateField;
    match field {
        CandidateField::Path
        | CandidateField::Types
        | CandidateField::PersistedFrontmatter(_)
        | CandidateField::EffectiveFrontmatter(_)
        | CandidateField::BodyTags => true,
        CandidateField::File(name) => {
            matches!(
                name.as_str(),
                "path" | "name" | "basename" | "ext" | "size" | "mtime"
            )
        }
    }
}

fn push_iso_date_candidate_comparison(
    query: &mut QueryBuilder<Postgres>,
    comparison: &mdbase::runtime::CandidateComparison,
) {
    use mdbase::runtime::CandidateComparisonOperator as Op;
    let operator = match comparison.operator {
        Op::Equal => " = ",
        Op::NotEqual => " <> ",
        Op::LessThan => " < ",
        Op::LessThanOrEqual => " <= ",
        Op::GreaterThan => " > ",
        Op::GreaterThanOrEqual => " >= ",
        Op::In | Op::Contains => unreachable!("date-only proof is a scalar comparison"),
    };
    let literal = comparison
        .value
        .as_str()
        .expect("date-only pruning proof has a string literal");
    query.push("(");
    push_candidate_field(query, &comparison.field);
    query.push(" IS NULL OR jsonb_typeof(");
    push_candidate_field(query, &comparison.field);
    query.push(") <> 'string' OR (");
    push_candidate_field(query, &comparison.field);
    query.push(" #>> '{}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR (");
    push_candidate_field(query, &comparison.field);
    query
        .push(" #>> '{}') COLLATE \"C\"")
        .push(operator)
        .push_bind(literal.to_string())
        .push(")");
}

fn push_candidate_comparison(
    query: &mut QueryBuilder<Postgres>,
    comparison: &mdbase::runtime::CandidateComparison,
) {
    use mdbase::runtime::CandidateComparisonOperator as Op;
    match comparison.operator {
        Op::Equal | Op::NotEqual => {
            query.push("(");
            push_candidate_field(query, &comparison.field);
            query.push(" IS NULL OR ");
            push_candidate_field(query, &comparison.field);
            query.push(if comparison.operator == Op::Equal {
                " = "
            } else {
                " <> "
            });
            query
                .push_bind(sqlx::types::Json(comparison.value.clone()))
                .push(")");
        }
        Op::LessThan | Op::LessThanOrEqual | Op::GreaterThan | Op::GreaterThanOrEqual => {
            let operator = match comparison.operator {
                Op::LessThan => " < ",
                Op::LessThanOrEqual => " <= ",
                Op::GreaterThan => " > ",
                Op::GreaterThanOrEqual => " >= ",
                _ => unreachable!(),
            };
            query.push("(");
            push_candidate_field(query, &comparison.field);
            query.push(" IS NULL OR (");
            if let Some(value) = comparison.value.as_str() {
                query.push("jsonb_typeof(");
                push_candidate_field(query, &comparison.field);
                query.push(") = 'string' AND (");
                push_candidate_field(query, &comparison.field);
                query
                    .push(" #>> '{}') COLLATE \"C\"")
                    .push(operator)
                    .push_bind(value.to_string());
            } else {
                query.push("jsonb_typeof(");
                push_candidate_field(query, &comparison.field);
                query.push(") = 'number' AND ");
                push_candidate_field(query, &comparison.field);
                query
                    .push(operator)
                    .push_bind(sqlx::types::Json(comparison.value.clone()));
            }
            query.push("))");
        }
        Op::In => {
            query.push("(");
            push_candidate_field(query, &comparison.field);
            query.push(" IS NULL OR ");
            let values = comparison
                .value
                .as_array()
                .expect("exact membership pruning always has an array literal");
            query.push("(");
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    query.push(" OR ");
                }
                push_candidate_field(query, &comparison.field);
                query
                    .push(" = ")
                    .push_bind(sqlx::types::Json(value.clone()));
            }
            if values.is_empty() {
                query.push("FALSE");
            }
            query.push("))");
        }
        Op::Contains => {
            query.push("(");
            push_candidate_field(query, &comparison.field);
            query.push(" IS NULL OR (jsonb_typeof(");
            push_candidate_field(query, &comparison.field);
            query.push(") = 'array' AND ");
            push_candidate_field(query, &comparison.field);
            query
                .push(" @> ")
                .push_bind(sqlx::types::Json(Value::Array(vec![comparison
                    .value
                    .clone()])));
            if let Some(value) = comparison.value.as_str() {
                query.push(" OR (jsonb_typeof(");
                push_candidate_field(query, &comparison.field);
                query.push(") = 'string' AND strpos(");
                push_candidate_field(query, &comparison.field);
                query
                    .push(" #>> '{}', ")
                    .push_bind(value.to_string())
                    .push(") > 0)");
            }
            query.push("))");
        }
    }
}

fn push_candidate_field(
    query: &mut QueryBuilder<Postgres>,
    field: &mdbase::runtime::CandidateField,
) {
    use mdbase::runtime::CandidateField;
    match field {
        CandidateField::Path => {
            query.push("to_jsonb(canonical_path)");
        }
        CandidateField::Types => {
            query.push("to_jsonb(matched_types)");
        }
        CandidateField::PersistedFrontmatter(path) => {
            let mut full = vec!["persisted_frontmatter".to_string()];
            full.extend(path.iter().cloned());
            query.push("semantic_projection #> ").push_bind(full);
        }
        CandidateField::EffectiveFrontmatter(path) => {
            let mut full = vec!["effective_frontmatter".to_string()];
            full.extend(path.iter().cloned());
            query.push("semantic_projection #> ").push_bind(full);
        }
        CandidateField::BodyTags => {
            query.push(
                r#"(CASE jsonb_typeof(semantic_projection #> '{effective_frontmatter,tags}')
                     WHEN 'array' THEN (
                       SELECT COALESCE(jsonb_agg(to_jsonb(ltrim(value, '#'))), '[]'::jsonb)
                       FROM jsonb_array_elements_text(
                         semantic_projection #> '{effective_frontmatter,tags}'
                       ) AS tag(value)
                     )
                     WHEN 'string' THEN jsonb_build_array(to_jsonb(ltrim(
                       semantic_projection #>> '{effective_frontmatter,tags}', '#'
                     )))
                     ELSE '[]'::jsonb
                   END || COALESCE(
                     semantic_projection #> '{structure,body_tags}', '[]'::jsonb
                   ))"#,
            );
        }
        CandidateField::File(name) => {
            let projected_name = if name == "ext" { "extension" } else { name };
            query
                .push("semantic_projection #> ")
                .push_bind(vec!["file".to_string(), projected_name.to_string()]);
        }
    }
}

fn candidate_type_union(predicate: &mdbase::runtime::CandidatePredicate) -> Option<Vec<String>> {
    use mdbase::runtime::CandidatePredicate;
    match predicate {
        CandidatePredicate::All => Some(Vec::new()),
        CandidatePredicate::None => Some(vec!["__mdbase_no_such_type__".to_string()]),
        CandidatePredicate::HasType { type_name } => Some(vec![type_name.clone()]),
        CandidatePredicate::Or { terms } => {
            let mut types = Vec::new();
            for term in terms {
                let term_types = candidate_type_union(term)?;
                if term_types.is_empty() {
                    return Some(Vec::new());
                }
                types.extend(term_types);
            }
            types.sort();
            types.dedup();
            Some(types)
        }
        CandidatePredicate::And { terms } => {
            let mut narrowest = Vec::new();
            for term in terms {
                let term_types = candidate_type_union(term)?;
                if !term_types.is_empty()
                    && (narrowest.is_empty() || term_types.len() < narrowest.len())
                {
                    narrowest = term_types;
                }
            }
            Some(narrowest)
        }
        CandidatePredicate::Not { .. } | CandidatePredicate::Compare { .. } => Some(Vec::new()),
    }
}

fn path_order_direction(plan: &mdbase::runtime::HostedQueryPlan) -> Option<bool> {
    if plan.order.is_empty() {
        return Some(false);
    }
    let mut descending = None;
    for order in &plan.order {
        let path = matches!(order.field, mdbase::runtime::CandidateField::Path)
            || matches!(&order.field, mdbase::runtime::CandidateField::File(name) if name == "path");
        if !path {
            return None;
        }
        let current = matches!(
            order.direction,
            mdbase::runtime::HostedOrderDirection::Descending
        );
        if descending.is_some_and(|value| value != current) {
            return None;
        }
        descending = Some(current);
    }
    descending
}

fn query_page_size(input: &Value) -> ApiResult<u64> {
    match input.get("limit") {
        None => Ok(100),
        Some(value) => value.as_u64().filter(|value| *value > 0).ok_or_else(|| {
            ApiError::bad_request(
                "invalid_query",
                "Hosted query limit must be a positive integer.",
            )
        }),
    }
}

fn decode_sha256_digest(value: &str) -> ApiResult<Vec<u8>> {
    let hex = value
        .strip_prefix("sha256:")
        .ok_or_else(|| ApiError::internal("A hosted query digest has an unsupported format."))?;
    if hex.len() != 64 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(ApiError::internal("A hosted query digest is malformed."));
    }
    (0..32)
        .map(|index| {
            u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16)
                .map_err(|_| ApiError::internal("A hosted query digest is malformed."))
        })
        .collect()
}

fn encode_query_cursor(cursor_id: Uuid) -> String {
    format!("hq1.{}", URL_SAFE_NO_PAD.encode(cursor_id.as_bytes()))
}

fn decode_query_cursor(value: &str) -> ApiResult<Uuid> {
    let encoded = value.strip_prefix("hq1.").ok_or_else(|| {
        ApiError::bad_request(
            "invalid_query_cursor",
            "The hosted query cursor has an unsupported format.",
        )
    })?;
    let bytes = URL_SAFE_NO_PAD.decode(encoded).map_err(|_| {
        ApiError::bad_request(
            "invalid_query_cursor",
            "The hosted query cursor is malformed.",
        )
    })?;
    let cursor_id = Uuid::from_slice(&bytes).map_err(|_| {
        ApiError::bad_request(
            "invalid_query_cursor",
            "The hosted query cursor is malformed.",
        )
    })?;
    if encode_query_cursor(cursor_id) != value {
        return Err(ApiError::bad_request(
            "invalid_query_cursor",
            "The hosted query cursor is not canonical.",
        ));
    }
    Ok(cursor_id)
}

fn query_cursor_conflict(code: &str, message: &str) -> ApiError {
    ApiError::conflict(code, message)
}

fn empty_query_result() -> OperationResult {
    OperationResult {
        valid: true,
        result: json!({
            "results": [],
            "meta": { "total_count": 0, "has_more": false },
            "diagnostics": [],
        }),
        diagnostics: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_cursor_tokens_are_canonical_and_round_trip() {
        let id = Uuid::new_v4();
        let token = encode_query_cursor(id);
        assert_eq!(decode_query_cursor(&token).unwrap(), id);
        assert_eq!(
            decode_query_cursor(&(token + "=")).unwrap_err().code,
            "invalid_query_cursor"
        );
    }

    #[test]
    fn only_closed_type_candidates_are_translated() {
        use mdbase::runtime::CandidatePredicate;
        let candidate = CandidatePredicate::Or {
            terms: vec![
                CandidatePredicate::HasType {
                    type_name: "task".to_string(),
                },
                CandidatePredicate::HasType {
                    type_name: "note".to_string(),
                },
            ],
        };
        assert_eq!(candidate_type_union(&candidate).unwrap(), ["note", "task"]);
        assert!(candidate_type_union(&CandidatePredicate::Not {
            term: Box::new(candidate)
        })
        .unwrap()
        .is_empty());
    }

    #[test]
    fn base_scope_and_candidate_are_separate_sql_predicates() {
        let mut query = QueryBuilder::<Postgres>::new("WHERE (cardinality(");
        query
            .push_bind(Vec::<String>::new())
            .push("::text[]) = 0 OR matched_types && ")
            .push_bind(Vec::<String>::new())
            .push("::text[]) AND (");
        push_candidate_predicate(&mut query, &mdbase::runtime::CandidatePredicate::All);
        query.push(")");
        assert_eq!(
            query.sql(),
            "WHERE (cardinality($1::text[]) = 0 OR matched_types && $2::text[]) AND (TRUE)"
        );
    }

    #[test]
    fn scoped_budget_details_reveal_only_the_threshold_breach() {
        assert_eq!(scoped_budget_observed(&[], 100, 173), 173);
        assert_eq!(scoped_budget_observed(&["task".to_string()], 100, 173), 101);
    }

    #[test]
    fn projected_fast_path_requires_an_exact_sql_candidate() {
        use mdbase::runtime::{
            CandidateComparison, CandidateComparisonOperator, CandidateComparisonPruning,
            CandidateField, CandidatePredicate,
        };
        assert!(candidate_predicate_is_total(&CandidatePredicate::HasType {
            type_name: "task".to_string(),
        }));
        assert!(!candidate_predicate_is_total(
            &CandidatePredicate::Compare {
                comparison: CandidateComparison {
                    field: CandidateField::EffectiveFrontmatter(vec!["status".to_string()]),
                    operator: CandidateComparisonOperator::Equal,
                    value: Value::String("open".to_string()),
                    pruning: CandidateComparisonPruning::ExactJson,
                },
            }
        ));
    }

    #[tokio::test]
    async fn scan_permit_gate_is_bounded_and_releases_independently() {
        let semaphore = Arc::new(Semaphore::new(2));
        let counters = Arc::new(HostedQueryActivityCounters::default());
        let first = HostedScanPermitGuard::new(
            semaphore.clone().acquire_owned().await.unwrap(),
            counters.clone(),
        );
        let second = HostedScanPermitGuard::new(
            semaphore.clone().acquire_owned().await.unwrap(),
            counters.clone(),
        );
        assert_eq!(
            counters.active_scan_permits.load(AtomicOrdering::Relaxed),
            2
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(10), semaphore.clone().acquire_owned())
                .await
                .is_err()
        );
        drop(first);
        let replacement = HostedScanPermitGuard::new(
            semaphore.clone().acquire_owned().await.unwrap(),
            counters.clone(),
        );
        drop(second);
        drop(replacement);
        assert_eq!(
            counters.active_scan_permits.load(AtomicOrdering::Relaxed),
            0
        );
        assert_eq!(semaphore.available_permits(), 2);
    }
}
