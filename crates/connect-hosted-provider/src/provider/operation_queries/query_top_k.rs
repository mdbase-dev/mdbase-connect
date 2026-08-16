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

struct BoundedQueryTopK<'a> {
    plan: &'a mdbase::runtime::HostedQueryPlan,
    capacity: usize,
    // A max heap under canonical query ordering; the worst retained row is at
    // the root and can be replaced without retaining every match.
    heap: Vec<BoundedQueryMatch>,
}

impl<'a> BoundedQueryTopK<'a> {
    fn new(plan: &'a mdbase::runtime::HostedQueryPlan, capacity: usize) -> Self {
        Self {
            plan,
            capacity,
            heap: Vec::with_capacity(capacity),
        }
    }

    fn compare(&self, left: &BoundedQueryMatch, right: &BoundedQueryMatch) -> Ordering {
        self.plan
            .compare_order_values(
                &left.order_values,
                &left.path,
                &right.order_values,
                &right.path,
            )
            .then_with(|| left.record_id.cmp(&right.record_id))
    }

    fn push(&mut self, item: BoundedQueryMatch) {
        if self.capacity == 0 {
            return;
        }
        if self.heap.len() < self.capacity {
            self.heap.push(item);
            self.sift_up(self.heap.len() - 1);
            return;
        }
        if self.compare(&item, &self.heap[0]).is_lt() {
            self.heap[0] = item;
            self.sift_down(0);
        }
    }

    fn sift_up(&mut self, mut index: usize) {
        while index > 0 {
            let parent = (index - 1) / 2;
            if !self.compare(&self.heap[index], &self.heap[parent]).is_gt() {
                break;
            }
            self.heap.swap(index, parent);
            index = parent;
        }
    }

    fn sift_down(&mut self, mut index: usize) {
        loop {
            let left = index.saturating_mul(2).saturating_add(1);
            if left >= self.heap.len() {
                break;
            }
            let right = left + 1;
            let child = if right < self.heap.len()
                && self.compare(&self.heap[right], &self.heap[left]).is_gt()
            {
                right
            } else {
                left
            };
            if !self.compare(&self.heap[child], &self.heap[index]).is_gt() {
                break;
            }
            self.heap.swap(index, child);
            index = child;
        }
    }

    fn into_sorted(mut self) -> Vec<BoundedQueryMatch> {
        let plan = self.plan;
        self.heap.sort_by(|left, right| {
            plan.compare_order_values(
                &left.order_values,
                &left.path,
                &right.order_values,
                &right.path,
            )
            .then_with(|| left.record_id.cmp(&right.record_id))
        });
        self.heap
    }
}

struct BoundedBaseMatch {
    record_id: Uuid,
    row: mdbase::runtime::HostedBaseRow,
}

struct BoundedBaseTopK<'a> {
    plan: &'a mdbase::runtime::HostedBasePlan,
    capacity: usize,
    heap: Vec<BoundedBaseMatch>,
}

impl<'a> BoundedBaseTopK<'a> {
    fn new(plan: &'a mdbase::runtime::HostedBasePlan, capacity: usize) -> Self {
        Self {
            plan,
            capacity,
            heap: Vec::with_capacity(capacity),
        }
    }

    fn compare(&self, left: &BoundedBaseMatch, right: &BoundedBaseMatch) -> Ordering {
        self.plan
            .compare_rows(&left.row, &right.row)
            .then_with(|| left.record_id.cmp(&right.record_id))
    }

    fn push(&mut self, item: BoundedBaseMatch) {
        if self.capacity == 0 {
            return;
        }
        if self.heap.len() < self.capacity {
            self.heap.push(item);
            self.sift_up(self.heap.len() - 1);
            return;
        }
        if self.compare(&item, &self.heap[0]).is_lt() {
            self.heap[0] = item;
            self.sift_down(0);
        }
    }

    fn sift_up(&mut self, mut index: usize) {
        while index > 0 {
            let parent = (index - 1) / 2;
            if !self.compare(&self.heap[index], &self.heap[parent]).is_gt() {
                break;
            }
            self.heap.swap(index, parent);
            index = parent;
        }
    }

    fn sift_down(&mut self, mut index: usize) {
        loop {
            let left = index.saturating_mul(2).saturating_add(1);
            if left >= self.heap.len() {
                break;
            }
            let right = left + 1;
            let child = if right < self.heap.len()
                && self.compare(&self.heap[right], &self.heap[left]).is_gt()
            {
                right
            } else {
                left
            };
            if !self.compare(&self.heap[child], &self.heap[index]).is_gt() {
                break;
            }
            self.heap.swap(index, child);
            index = child;
        }
    }

    fn into_sorted(mut self) -> Vec<BoundedBaseMatch> {
        let plan = self.plan;
        self.heap.sort_by(|left, right| {
            plan.compare_rows(&left.row, &right.row)
                .then_with(|| left.record_id.cmp(&right.record_id))
        });
        self.heap
    }
}

struct BaseExecutionSnapshot {
    rows: Vec<ProjectedQueryRow>,
    projections: HashMap<Uuid, mdbase::runtime::SemanticProjection>,
    adjacency: HashMap<Uuid, BTreeSet<Uuid>>,
    relationship_rows: u64,
    projection_bytes: u64,
    exact_documents: u64,
    exact_bytes: u64,
    exact_ciphertext_bytes: u64,
    query_context: Option<mdbase::runtime::SemanticProjection>,
}

async fn execute_path_keyset_base_page(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
    state: &HostedQueryState,
    plan: &mdbase::runtime::HostedBasePlan,
    page_size: u64,
    started: Instant,
    cached_total_count: Option<u64>,
) -> ApiResult<Option<ExecutedQueryPage>> {
    let Some(page) = load_path_keyset_base_page(
        transaction,
        collection_id,
        state,
        plan,
        page_size,
        cached_total_count,
    )
    .await?
    else {
        return Ok(None);
    };
    if page.projection_bytes > state.plan.budgets.max_candidate_bytes {
        return Err(query_budget_error(
            "hosted_byte_budget_exceeded",
            "The Obsidian Base page exceeded its transferred projection-byte budget.",
            "candidate_bytes",
            state.plan.budgets.max_candidate_bytes,
            scoped_budget_observed(
                &plan.allowed_types,
                state.plan.budgets.max_candidate_bytes,
                page.projection_bytes,
            ),
        ));
    }
    let operation_clock = state.base_operation_clock.as_ref().ok_or_else(|| {
        ApiError::internal("Obsidian Base execution has no snapshot operation clock.")
    })?;
    let max_expression_steps = state
        .plan
        .budgets
        .max_operator_steps
        .checked_div(page.rows.len().max(1) as u64)
        .unwrap_or(0);
    let mut results = Vec::with_capacity(page.rows.len());
    let mut last_boundary = None;
    for row in &page.rows {
        let evaluation = plan
            .evaluate_record(&mdbase::runtime::HostedBaseRecordContext {
                projection: row.projection.clone(),
                related: Vec::new(),
                relationship_neighborhood_complete: true,
                query_context: None,
                operation_clock: operation_clock.clone(),
                max_expression_steps,
            })
            .map_err(projection_inconsistent)?;
        let mdbase::runtime::HostedBaseEvaluation::Included { row: result } = evaluation else {
            return Err(ApiError::conflict(
                "hosted_projection_inconsistent",
                "A path-keyset Base plan excluded a provider-selected current projection.",
            ));
        };
        if result.path != row.canonical_path {
            return Err(ApiError::conflict(
                "hosted_projection_inconsistent",
                "A path-keyset Base projection disagreed with its indexed canonical path.",
            ));
        }
        last_boundary = Some(QueryPageBoundary {
            order_values: plan.row_order_values(&result),
            path: result.path.clone(),
            record_id: row.record_id,
        });
        results.push(json!({
            "path": result.path,
            "file": result.file,
            "effective_frontmatter": result.effective_frontmatter,
            "types": result.types,
            "values": result.values,
        }));
    }
    let result_bytes = serialized_value_bytes(&Value::Array(results.clone()));
    let resident_bytes = page
        .projection_bytes
        .saturating_mul(2)
        .saturating_add(result_bytes);
    if resident_bytes > state.plan.budgets.max_memory_bytes {
        return Err(query_budget_error(
            "hosted_memory_budget_exceeded",
            "The Obsidian Base page exceeded its bounded resident-memory budget.",
            "memory_bytes",
            state.plan.budgets.max_memory_bytes,
            scoped_budget_observed(
                &plan.allowed_types,
                state.plan.budgets.max_memory_bytes,
                resident_bytes,
            ),
        ));
    }
    if started.elapsed().as_millis() as u64 > state.plan.budgets.max_wall_time_ms {
        return Err(query_budget_error(
            "hosted_time_budget_exceeded",
            "The Obsidian Base page exceeded its wall-time budget.",
            "wall_time_ms",
            state.plan.budgets.max_wall_time_ms,
            started.elapsed().as_millis() as u64,
        ));
    }
    Ok(Some(ExecutedQueryPage {
        candidate_rows: page.rows.len() as u64,
        exact_documents: 0,
        exact_ciphertext_bytes: 0,
        base_path_keyset: true,
        has_more: plan.offset
            .saturating_add(state.emitted_rows)
            .saturating_add(results.len() as u64)
            < page.total_count,
        results,
        diagnostics: Vec::new(),
        groups: None,
        total_count: Some(page.total_count),
        last_boundary,
    }))
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
    allow_path_keyset: bool,
    cached_total_count: Option<u64>,
) -> ApiResult<ExecutedQueryPage> {
    let plan = state
        .base_plan
        .as_ref()
        .ok_or_else(|| ApiError::internal("Obsidian Base execution has no semantic plan."))?;
    if allow_path_keyset && plan.supports_path_keyset_paging() && state.generation_id.is_some() {
        if let Some(page) = execute_path_keyset_base_page(
            transaction,
            collection_id,
            state,
            plan,
            page_size,
            started,
            cached_total_count,
        )
        .await?
        {
            return Ok(page);
        }
    }
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
        exact_ciphertext_bytes,
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
            scoped_budget_observed(
                &plan.allowed_types,
                state.plan.budgets.max_candidate_rows,
                rows.len() as u64,
            ),
        ));
    }
    let offset = if state.last_path.is_none() {
        plan.offset
    } else {
        0
    };
    let top_k_capacity = offset.saturating_add(page_size);
    // Reserve one comparison and one grouping-state operation in addition to
    // the heap depth. This is conservative for unsorted/ungrouped views.
    let reduction_steps_per_match =
        u64::from(top_k_capacity.max(1).ilog2().saturating_add(1)).saturating_add(2);
    let operator_steps = (rows.len() as u64)
        .saturating_add(relationship_rows)
        .saturating_add((rows.len() as u64).saturating_mul(reduction_steps_per_match));
    if operator_steps > state.plan.budgets.max_operator_steps {
        return Err(query_budget_error(
            "hosted_operator_budget_exceeded",
            "The Obsidian Base exceeded its total operator-step budget.",
            "operator_steps",
            state.plan.budgets.max_operator_steps,
            scoped_budget_observed(
                &plan.allowed_types,
                state.plan.budgets.max_operator_steps,
                operator_steps,
            ),
        ));
    }
    if projection_bytes > state.plan.budgets.max_candidate_bytes {
        return Err(query_budget_error(
            "hosted_byte_budget_exceeded",
            "The Obsidian Base exceeded its transferred projection-byte budget.",
            "candidate_bytes",
            state.plan.budgets.max_candidate_bytes,
            scoped_budget_observed(
                &plan.allowed_types,
                state.plan.budgets.max_candidate_bytes,
                projection_bytes,
            ),
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
            scoped_budget_observed(
                &plan.allowed_types,
                state.plan.budgets.max_operator_steps,
                operator_steps.saturating_add(1),
            ),
        ));
    }
    let candidate_rows = rows.len() as u64;
    let evaluation_plan = plan.clone();
    let last_order_values = state.last_order_values.clone();
    let last_path = state.last_path.clone();
    let last_record_id = state.last_record_id;
    let operation_clock = operation_clock.clone();
    let top_k_capacity = usize::try_from(top_k_capacity).unwrap_or(usize::MAX);
    let max_groups = state.plan.budgets.max_groups;
    let cancellation = mdbase::OperationCancellation::new();
    let worker_cancellation = cancellation
        .with_deadline(started + Duration::from_millis(state.plan.budgets.max_wall_time_ms));
    let mut cancellation_guard = BaseEvaluationCancellationGuard::new(cancellation);
    let evaluated = tokio::task::spawn_blocking(move || {
        let mut top_k = BoundedBaseTopK::new(&evaluation_plan, top_k_capacity);
        let mut grouping = evaluation_plan.start_grouping(max_groups);
        let mut diagnostics = Vec::new();
        let mut total_count = 0_u64;
        for row in rows {
            let related = adjacency
                .get(&row.record_id)
                .into_iter()
                .flatten()
                .filter_map(|record_id| projections.get(record_id).cloned())
                .collect::<Vec<_>>();
            let input = mdbase::runtime::HostedBaseRecordContext {
                projection: row.projection,
                related,
                relationship_neighborhood_complete: true,
                query_context: query_context.clone(),
                operation_clock: operation_clock.clone(),
                max_expression_steps: expression_steps_per_record,
            };
            match evaluation_plan.evaluate_record_with_cancellation(&input, &worker_cancellation)? {
                mdbase::runtime::HostedBaseEvaluation::Included { row: result } => {
                    let item = BoundedBaseMatch {
                        record_id: row.record_id,
                        row: *result,
                    };
                    total_count = total_count.saturating_add(1);
                    grouping.push(&item.row)?;
                    let after_keyset = if let Some(last_path) = last_path.as_deref() {
                        let ordering = evaluation_plan.compare_row_to_boundary(
                            &item.row,
                            &last_order_values,
                            last_path,
                        )?;
                        ordering.is_gt()
                            || (ordering.is_eq()
                                && last_record_id.is_some_and(|last| item.record_id > last))
                    } else {
                        true
                    };
                    if after_keyset {
                        top_k.push(item);
                    }
                }
                mdbase::runtime::HostedBaseEvaluation::Excluded {
                    diagnostics: excluded,
                } => diagnostics.extend(excluded),
            }
        }
        Ok::<_, mdbase::runtime::CatalogError>((
            top_k.into_sorted(),
            diagnostics,
            grouping.finish(),
            total_count,
        ))
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
        "hosted_base_group_budget_exceeded" => query_budget_error(
            "hosted_group_budget_exceeded",
            "The Obsidian Base exceeded its group budget.",
            "groups",
            state.plan.budgets.max_groups,
            state.plan.budgets.max_groups.saturating_add(1),
        ),
        _ => projection_inconsistent(error),
    })?;
    cancellation_guard.disarm();
    let (matching, diagnostics, groups, total_count) = evaluated;
    let matching_bytes = matching.iter().fold(0_u64, |total, item| {
        total.saturating_add(serde_json::to_vec(&item.row).map_or(0, |bytes| bytes.len() as u64))
    });
    // Candidate projections are owned by the SQL row set and identity map;
    // only one relationship context and one page-sized top-K heap are retained
    // while evaluating.
    let pre_reduction_resident_bytes = projection_bytes
        .saturating_mul(3)
        .saturating_add(exact_bytes)
        .saturating_add(matching_bytes);
    if pre_reduction_resident_bytes > state.plan.budgets.max_memory_bytes {
        return Err(query_budget_error(
            "hosted_memory_budget_exceeded",
            "The Obsidian Base exceeded its bounded resident-memory budget.",
            "memory_bytes",
            state.plan.budgets.max_memory_bytes,
            scoped_budget_observed(
                &plan.allowed_types,
                state.plan.budgets.max_memory_bytes,
                pre_reduction_resident_bytes,
            ),
        ));
    }
    let page = matching
        .into_iter()
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
        has_more: plan
            .offset
            .saturating_add(state.emitted_rows)
            .saturating_add(results.len() as u64)
            < total_count,
        results,
        diagnostics,
        groups,
        total_count: Some(total_count),
        last_boundary,
        candidate_rows,
        exact_documents,
        exact_ciphertext_bytes,
        base_path_keyset: false,
    })
}
