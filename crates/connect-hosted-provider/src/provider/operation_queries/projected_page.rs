#[allow(clippy::too_many_arguments)]
async fn execute_projected_page(
    transaction: &mut Transaction<'_, Postgres>,
    crypto: &ProviderCrypto,
    data_key: &[u8; 32],
    collection_id: Uuid,
    state: &HostedQueryState,
    catalog: &mdbase::runtime::CompiledCatalog,
    candidate_types: &[String],
    page_size: u64,
    started: Instant,
    cached_summary: Option<(Option<u64>, Option<Vec<Value>>)>,
) -> ApiResult<ExecutedQueryPage> {
    let (mut total_count, cached_groups) = match cached_summary {
        Some((total_count, groups)) => (total_count, Some(groups)),
        None => (None, None),
    };
    if total_count.is_none()
        && state.snapshot_record_count
            <= crate::HostedExecutionBudgetManifest::published()
                .defaults
                .eager_summary_rows
    {
        total_count = Some(
            count_projected_candidates(transaction, collection_id, state, candidate_types).await?,
        );
    }
    let (rows, has_more) = load_projected_page(
        transaction,
        collection_id,
        state,
        candidate_types,
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
            scoped_budget_observed(
                &state.allowed_types,
                state.plan.budgets.max_candidate_bytes,
                projection_bytes,
            ),
        ));
    }
    let loaded_exact = if state.plan.requirements.exact_document {
        load_exact_query_records(
            transaction,
            crypto,
            data_key,
            collection_id,
            state,
            &rows.iter().map(|row| row.record_id).collect::<Vec<_>>(),
            state
                .exact_context
                .as_ref()
                .map_or(0, |context| context.document.len() as u64),
        )
        .await?
    } else {
        LoadedExactQueryRecords {
            records: HashMap::new(),
            ciphertext_bytes: 0,
            plaintext_bytes: state
                .exact_context
                .as_ref()
                .map_or(0, |context| context.document.len() as u64),
        }
    };
    let exact_ciphertext_bytes = loaded_exact.ciphertext_bytes;
    let exact_bytes = loaded_exact.plaintext_bytes;
    let exact_records = loaded_exact.records;
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
    let mut results = Vec::with_capacity(rows.len());
    let mut diagnostics = Vec::new();
    let mut last_order_values = None;
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
        last_order_values = Some(evaluation.order_values.clone());
        diagnostics.extend(evaluation.diagnostics);
        results.push(evaluation.record.ok_or_else(|| {
            ApiError::internal("A matching hosted residual omitted its result record.")
        })?);
    }
    let result_bytes = results
        .iter()
        .map(|result| serde_json::to_vec(result).map_or(0, |bytes| bytes.len() as u64))
        .sum::<u64>();
    let groups = match cached_groups {
        Some(groups) => groups,
        None => {
            let (groups, grouped_count) =
                load_projected_groups(transaction, collection_id, state, candidate_types).await?;
            if total_count.is_none() {
                total_count = grouped_count;
            }
            groups
        }
    };
    let group_bytes = groups.as_ref().map_or(0, |groups| {
        serialized_value_bytes(&Value::Array(groups.clone()))
    });
    let resident_bytes = projection_bytes
        .saturating_add(exact_bytes)
        .saturating_add(result_bytes)
        .saturating_add(group_bytes);
    if resident_bytes > state.plan.budgets.max_memory_bytes {
        return Err(query_budget_error(
            "hosted_memory_budget_exceeded",
            "The hosted query page exceeded its bounded resident-memory budget.",
            "memory_bytes",
            state.plan.budgets.max_memory_bytes,
            scoped_budget_observed(
                &state.allowed_types,
                state.plan.budgets.max_memory_bytes,
                resident_bytes,
            ),
        ));
    }
    if started.elapsed().as_millis() as u64 > state.plan.budgets.max_wall_time_ms {
        return Err(query_budget_error(
            "hosted_time_budget_exceeded",
            "The hosted query page exceeded its wall-time budget.",
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
        has_more,
        last_boundary: rows.last().map(|row| QueryPageBoundary {
            order_values: last_order_values.unwrap_or_default(),
            path: row.canonical_path.clone(),
            record_id: row.record_id,
        }),
        candidate_rows: rows.len() as u64,
        exact_documents: (exact_records.len() as u64).saturating_add(context_documents),
        exact_ciphertext_bytes,
        base_path_keyset: false,
    })
}
