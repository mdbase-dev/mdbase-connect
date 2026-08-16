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
    let snapshot_head = to_i64(state.snapshot_head, "query snapshot head")?;
    let mut query = QueryBuilder::<Postgres>::new(
        "SELECT count(*) FROM hosted_provider_record_projections p \
         JOIN hosted_provider_record_versions v ON v.collection_id = p.collection_id \
          AND v.record_id = p.record_id AND v.sequence = p.record_sequence \
          AND v.revision = p.record_revision AND NOT v.deleted AND v.sequence <= ",
    );
    query
        .push_bind(snapshot_head)
        .push(" WHERE p.collection_id = ")
        .push_bind(collection_id)
        .push(" AND p.generation_id = ")
        .push_bind(state.generation_id)
        .push(" AND p.valid_from_sequence <= ")
        .push_bind(snapshot_head)
        .push(" AND (p.valid_to_sequence IS NULL OR p.valid_to_sequence > ")
        .push_bind(snapshot_head)
        .push(") AND p.catalog_revision = ")
        .push_bind(state.catalog_revision.clone())
        .push(" AND p.projection_format_version = ")
        .push_bind(i64::from(state.projection_format_version))
        .push(" AND p.semantic_engine_version = ")
        .push_bind(state.semantic_engine_version.clone())
        .push(
            " AND hosted_provider_projection_digest_valid( \
              p.projection_digest, p.projection_observed_digest) \
              AND p.semantic_complete AND p.resolution_complete \
              AND (cardinality(",
        )
        .push_bind(candidate_types.to_vec())
        .push("::text[]) = 0 OR p.matched_types && ")
        .push_bind(candidate_types.to_vec())
        .push("::text[]) AND (");
    push_exact_candidate_predicate(&mut query, &state.plan.candidate);
    query.push(")");
    let count: i64 = query
        .build_query_scalar()
        .fetch_one(&mut **transaction)
        .await?;
    number(count, "query total count")
}

async fn load_projected_groups(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
    state: &HostedQueryState,
    candidate_types: &[String],
) -> ApiResult<Option<Vec<Value>>> {
    if state.plan.groups.is_empty() && state.plan.aggregates.is_empty() {
        return Ok(None);
    }
    let snapshot_head = to_i64(state.snapshot_head, "query snapshot head")?;
    let mut query = QueryBuilder::<Postgres>::new("SELECT ");
    for (index, group) in state.plan.groups.iter().enumerate() {
        if index > 0 {
            query.push(", ");
        }
        query.push("COALESCE(");
        push_candidate_field(&mut query, &group.field);
        query
            .push(", 'null'::jsonb) AS group_")
            .push(index.to_string());
    }
    if !state.plan.groups.is_empty() {
        query.push(", ");
    }
    query.push(
        "count(*) AS row_count FROM hosted_provider_record_projections p \
         JOIN hosted_provider_record_versions v ON v.collection_id = p.collection_id \
          AND v.record_id = p.record_id AND v.sequence = p.record_sequence \
          AND v.revision = p.record_revision AND NOT v.deleted AND v.sequence <= ",
    );
    query
        .push_bind(snapshot_head)
        .push(" WHERE p.collection_id = ")
        .push_bind(collection_id)
        .push(" AND p.generation_id = ")
        .push_bind(state.generation_id)
        .push(" AND p.valid_from_sequence <= ")
        .push_bind(snapshot_head)
        .push(" AND (p.valid_to_sequence IS NULL OR p.valid_to_sequence > ")
        .push_bind(snapshot_head)
        .push(") AND p.catalog_revision = ")
        .push_bind(state.catalog_revision.clone())
        .push(" AND p.projection_format_version = ")
        .push_bind(i64::from(state.projection_format_version))
        .push(" AND p.semantic_engine_version = ")
        .push_bind(state.semantic_engine_version.clone())
        .push(
            " AND hosted_provider_projection_digest_valid( \
              p.projection_digest, p.projection_observed_digest) \
              AND p.semantic_complete AND p.resolution_complete \
              AND (cardinality(",
        )
        .push_bind(candidate_types.to_vec())
        .push("::text[]) = 0 OR p.matched_types && ")
        .push_bind(candidate_types.to_vec())
        .push("::text[]) AND (");
    push_exact_candidate_predicate(&mut query, &state.plan.candidate);
    query.push(")");
    if !state.plan.groups.is_empty() {
        query.push(" GROUP BY ");
        for index in 0..state.plan.groups.len() {
            if index > 0 {
                query.push(", ");
            }
            query.push((index + 1).to_string());
        }
    }
    query.push(" LIMIT ").push_bind(to_i64(
        state.plan.budgets.max_groups.saturating_add(1),
        "group budget",
    )?);
    let rows = query.build().fetch_all(&mut **transaction).await?;
    if rows.len() as u64 > state.plan.budgets.max_groups {
        return Err(query_budget_error(
            "hosted_group_budget_exceeded",
            "The hosted query exceeded its group budget.",
            "groups",
            state.plan.budgets.max_groups,
            rows.len() as u64,
        ));
    }
    let mut reduction = state.plan.start_reduction();
    let mut operator_steps = 0_u64;
    for row in rows {
        let count = number(row.get::<i64, _>("row_count"), "group row count")?;
        operator_steps = operator_steps.saturating_add(count.saturating_mul(
            (state.plan.groups.len() + state.plan.aggregates.len()).max(1) as u64,
        ));
        if operator_steps > state.plan.budgets.max_operator_steps {
            return Err(query_budget_error(
                "hosted_operator_budget_exceeded",
                "The hosted grouping exceeded its operator-step budget.",
                "operator_steps",
                state.plan.budgets.max_operator_steps,
                operator_steps,
            ));
        }
        let group_values = (0..state.plan.groups.len())
            .map(|index| row.get::<Value, _>(format!("group_{index}").as_str()))
            .collect::<Vec<_>>();
        let input = mdbase::runtime::HostedReductionInput {
            group_values,
            aggregate_values: vec![Value::Null; state.plan.aggregates.len()],
        };
        for _ in 0..count {
            reduction.push(&input).map_err(projection_inconsistent)?;
        }
    }
    reduction
        .finish()
        .map(|reduction| reduction.groups)
        .map_err(projection_inconsistent)
}

#[allow(clippy::too_many_arguments)]
async fn load_projected_page(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
    state: &HostedQueryState,
    candidate_types: &[String],
    page_size: u64,
) -> ApiResult<Vec<ProjectedQueryRow>> {
    let snapshot_head = to_i64(state.snapshot_head, "query snapshot head")?;
    let mut query = QueryBuilder::<Postgres>::new(
        "SELECT p.record_id, p.canonical_path, p.projection_bytes \
         FROM hosted_provider_record_projections p \
         JOIN hosted_provider_record_versions v ON v.collection_id = p.collection_id \
          AND v.record_id = p.record_id AND v.sequence = p.record_sequence \
          AND v.revision = p.record_revision AND NOT v.deleted AND v.sequence <= ",
    );
    query
        .push_bind(snapshot_head)
        .push(" WHERE p.collection_id = ")
        .push_bind(collection_id)
        .push(" AND p.generation_id = ")
        .push_bind(state.generation_id)
        .push(" AND p.valid_from_sequence <= ")
        .push_bind(snapshot_head)
        .push(" AND (p.valid_to_sequence IS NULL OR p.valid_to_sequence > ")
        .push_bind(snapshot_head)
        .push(") AND p.catalog_revision = ")
        .push_bind(state.catalog_revision.clone())
        .push(" AND p.projection_format_version = ")
        .push_bind(i64::from(state.projection_format_version))
        .push(" AND p.semantic_engine_version = ")
        .push_bind(state.semantic_engine_version.clone())
        .push(
            " AND hosted_provider_projection_digest_valid( \
              p.projection_digest, p.projection_observed_digest) \
              AND p.semantic_complete AND p.resolution_complete \
              AND (cardinality(",
        )
        .push_bind(candidate_types.to_vec())
        .push("::text[]) = 0 OR p.matched_types && ")
        .push_bind(candidate_types.to_vec())
        .push("::text[]) AND (");
    push_exact_candidate_predicate(&mut query, &state.plan.candidate);
    query.push(")");

    if let Some(last_path) = state.last_path.as_deref() {
        let last_record_id = state.last_record_id.ok_or_else(|| {
            ApiError::conflict(
                "query_cursor_invalidated",
                "The hosted query cursor has no stable record boundary.",
            )
        })?;
        if state.last_order_values.len() != state.plan.order.len()
            || state
                .last_order_values
                .iter()
                .any(|value| !value.is_null() && !value.is_string())
        {
            return Err(ApiError::conflict(
                "query_cursor_invalidated",
                "The hosted query cursor does not match its scalar order proof.",
            ));
        }
        query.push(" AND (");
        for index in 0..state.plan.order.len() {
            if index > 0 {
                query.push(" OR ");
            }
            query.push("(");
            push_scalar_order_prefix_equal(
                &mut query,
                &state.plan.order[..index],
                &state.last_order_values[..index],
            );
            if index > 0 {
                query.push(" AND ");
            }
            push_scalar_order_after(
                &mut query,
                &state.plan.order[index],
                &state.last_order_values[index],
            );
            query.push(")");
        }
        if !state.plan.order.is_empty() {
            query.push(" OR ");
        }
        query.push("(");
        push_scalar_order_prefix_equal(
            &mut query,
            &state.plan.order,
            &state.last_order_values,
        );
        if !state.plan.order.is_empty() {
            query.push(" AND ");
        }
        query
            .push("p.canonical_path COLLATE \"C\" > ")
            .push_bind(last_path.to_string())
            .push(") OR (");
        push_scalar_order_prefix_equal(
            &mut query,
            &state.plan.order,
            &state.last_order_values,
        );
        if !state.plan.order.is_empty() {
            query.push(" AND ");
        }
        query
            .push("p.canonical_path = ")
            .push_bind(last_path.to_string())
            .push(" AND p.record_id > ")
            .push_bind(last_record_id)
            .push("))");
    }

    query.push(" ORDER BY ");
    for order in &state.plan.order {
        push_scalar_order_expression(&mut query, order, false);
        query.push(" IS NULL");
        query.push(if matches!(
            order.direction,
            mdbase::runtime::HostedOrderDirection::Descending
        ) {
            " DESC, "
        } else {
            " ASC, "
        });
        push_scalar_order_expression(&mut query, order, false);
        query.push(if matches!(
            order.direction,
            mdbase::runtime::HostedOrderDirection::Descending
        ) {
            " COLLATE \"C\" DESC, "
        } else {
            " COLLATE \"C\" ASC, "
        });
    }
    query
        .push("p.canonical_path COLLATE \"C\" ASC, p.record_id ASC OFFSET ")
        .push_bind(if state.last_path.is_none() {
            to_i64(state.plan.offset, "query offset")?
        } else {
            0
        })
        .push(" LIMIT ")
        .push_bind(to_i64(page_size, "query page size")?);
    let rows = query.build().fetch_all(&mut **transaction).await?;
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

async fn projected_scalar_order_values_are_valid(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
    state: &HostedQueryState,
    candidate_types: &[String],
) -> ApiResult<bool> {
    let json_orders = state
        .plan
        .order
        .iter()
        .filter(|order| scalar_order_json_path(&order.field).is_some())
        .collect::<Vec<_>>();
    if json_orders.is_empty() {
        return Ok(true);
    }
    let snapshot_head = to_i64(state.snapshot_head, "query snapshot head")?;
    // The caller has already proved, in this repeatable-read transaction, that
    // every live identity has a current projection. Joining the exact bound
    // version therefore excludes orphan projections without reconstructing the
    // full live set for each validation pass.
    let mut query = QueryBuilder::<Postgres>::new(
        "SELECT NOT EXISTS (SELECT 1 FROM hosted_provider_record_projections p \
         JOIN hosted_provider_record_versions v ON v.collection_id = p.collection_id \
          AND v.record_id = p.record_id AND v.sequence = p.record_sequence \
          AND v.revision = p.record_revision AND NOT v.deleted AND v.sequence <= ",
    );
    query
        .push_bind(snapshot_head)
        .push(" WHERE p.collection_id = ")
        .push_bind(collection_id)
        .push(" AND p.generation_id = ")
        .push_bind(state.generation_id)
        .push(" AND p.valid_from_sequence <= ")
        .push_bind(snapshot_head)
        .push(" AND (p.valid_to_sequence IS NULL OR p.valid_to_sequence > ")
        .push_bind(snapshot_head)
        .push(") AND p.catalog_revision = ")
        .push_bind(state.catalog_revision.clone())
        .push(" AND p.projection_format_version = ")
        .push_bind(i64::from(state.projection_format_version))
        .push(" AND p.semantic_engine_version = ")
        .push_bind(state.semantic_engine_version.clone())
        .push(
            " AND hosted_provider_projection_digest_valid( \
              p.projection_digest, p.projection_observed_digest) \
              AND p.semantic_complete AND p.resolution_complete \
              AND (cardinality(",
        )
        .push_bind(candidate_types.to_vec())
        .push("::text[]) = 0 OR p.matched_types && ")
        .push_bind(candidate_types.to_vec())
        .push("::text[]) AND (");
    for (index, order) in json_orders.into_iter().enumerate() {
        if index > 0 {
            query.push(" OR ");
        }
        query.push("(jsonb_typeof(");
        push_scalar_order_expression(&mut query, order, true);
        query.push(") IS NOT NULL AND jsonb_typeof(");
        push_scalar_order_expression(&mut query, order, true);
        query.push(") NOT IN ('string', 'null'))");
    }
    query.push(") LIMIT 1)");
    query
        .build_query_scalar::<bool>()
        .fetch_one(&mut **transaction)
        .await
        .map_err(ApiError::from)
}

async fn projected_exact_candidate_values_are_valid(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
    state: &HostedQueryState,
    candidate_types: &[String],
) -> ApiResult<bool> {
    let mut fields = Vec::new();
    collect_exact_candidate_scalar_fields(&state.plan.candidate, &mut fields);
    fields.sort_by(|left, right| format!("{:?}", left.0).cmp(&format!("{:?}", right.0)));
    fields.dedup();
    if fields.is_empty() {
        return Ok(true);
    }
    let snapshot_head = to_i64(state.snapshot_head, "query snapshot head")?;
    let mut query = QueryBuilder::<Postgres>::new(
        "SELECT NOT EXISTS (SELECT 1 FROM hosted_provider_record_projections p \
         JOIN hosted_provider_record_versions v ON v.collection_id = p.collection_id \
          AND v.record_id = p.record_id AND v.sequence = p.record_sequence \
          AND v.revision = p.record_revision AND NOT v.deleted AND v.sequence <= ",
    );
    query
        .push_bind(snapshot_head)
        .push(" WHERE p.collection_id = ")
        .push_bind(collection_id)
        .push(" AND p.generation_id = ")
        .push_bind(state.generation_id)
        .push(" AND p.valid_from_sequence <= ")
        .push_bind(snapshot_head)
        .push(" AND (p.valid_to_sequence IS NULL OR p.valid_to_sequence > ")
        .push_bind(snapshot_head)
        .push(") AND p.catalog_revision = ")
        .push_bind(state.catalog_revision.clone())
        .push(" AND p.projection_format_version = ")
        .push_bind(i64::from(state.projection_format_version))
        .push(" AND p.semantic_engine_version = ")
        .push_bind(state.semantic_engine_version.clone())
        .push(
            " AND hosted_provider_projection_digest_valid( \
              p.projection_digest, p.projection_observed_digest) \
              AND p.semantic_complete AND p.resolution_complete \
              AND (cardinality(",
        )
        .push_bind(candidate_types.to_vec())
        .push("::text[]) = 0 OR p.matched_types && ")
        .push_bind(candidate_types.to_vec())
        .push("::text[]) AND (");
    for (index, (field, kind)) in fields.iter().enumerate() {
        if index > 0 {
            query.push(" OR ");
        }
        query.push("jsonb_typeof(");
        push_candidate_field(&mut query, field);
        query.push(") IS DISTINCT FROM ");
        query.push_bind(match kind {
            mdbase::runtime::HostedScalarKind::String => "string",
            mdbase::runtime::HostedScalarKind::Boolean => "boolean",
            mdbase::runtime::HostedScalarKind::Number => "number",
        });
    }
    query.push(") LIMIT 1)");
    query
        .build_query_scalar::<bool>()
        .fetch_one(&mut **transaction)
        .await
        .map_err(ApiError::from)
}

async fn projected_scalar_group_values_are_valid(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
    state: &HostedQueryState,
    candidate_types: &[String],
) -> ApiResult<bool> {
    if state.plan.groups.is_empty() {
        return Ok(true);
    }
    let snapshot_head = to_i64(state.snapshot_head, "query snapshot head")?;
    let mut query = QueryBuilder::<Postgres>::new(
        "SELECT NOT EXISTS (SELECT 1 FROM hosted_provider_record_projections p \
         JOIN hosted_provider_record_versions v ON v.collection_id = p.collection_id \
          AND v.record_id = p.record_id AND v.sequence = p.record_sequence \
          AND v.revision = p.record_revision AND NOT v.deleted AND v.sequence <= ",
    );
    query
        .push_bind(snapshot_head)
        .push(" WHERE p.collection_id = ")
        .push_bind(collection_id)
        .push(" AND p.generation_id = ")
        .push_bind(state.generation_id)
        .push(" AND p.valid_from_sequence <= ")
        .push_bind(snapshot_head)
        .push(" AND (p.valid_to_sequence IS NULL OR p.valid_to_sequence > ")
        .push_bind(snapshot_head)
        .push(") AND p.catalog_revision = ")
        .push_bind(state.catalog_revision.clone())
        .push(" AND p.projection_format_version = ")
        .push_bind(i64::from(state.projection_format_version))
        .push(" AND p.semantic_engine_version = ")
        .push_bind(state.semantic_engine_version.clone())
        .push(
            " AND hosted_provider_projection_digest_valid( \
              p.projection_digest, p.projection_observed_digest) \
              AND p.semantic_complete AND p.resolution_complete \
              AND (cardinality(",
        )
        .push_bind(candidate_types.to_vec())
        .push("::text[]) = 0 OR p.matched_types && ")
        .push_bind(candidate_types.to_vec())
        .push("::text[]) AND (");
    for (index, group) in state.plan.groups.iter().enumerate() {
        if index > 0 {
            query.push(" OR ");
        }
        query.push("(jsonb_typeof(");
        push_candidate_field(&mut query, &group.field);
        query.push(") IS NOT NULL AND jsonb_typeof(");
        push_candidate_field(&mut query, &group.field);
        query.push(") NOT IN ('string', 'null'))");
    }
    query.push(") LIMIT 1)");
    query
        .build_query_scalar::<bool>()
        .fetch_one(&mut **transaction)
        .await
        .map_err(ApiError::from)
}

fn collect_exact_candidate_scalar_fields(
    predicate: &mdbase::runtime::CandidatePredicate,
    fields: &mut Vec<(
        mdbase::runtime::CandidateField,
        mdbase::runtime::HostedScalarKind,
    )>,
) {
    match predicate {
        mdbase::runtime::CandidatePredicate::And { terms }
        | mdbase::runtime::CandidatePredicate::Or { terms } => {
            for term in terms {
                collect_exact_candidate_scalar_fields(term, fields);
            }
        }
        mdbase::runtime::CandidatePredicate::Not { term } => {
            collect_exact_candidate_scalar_fields(term, fields);
        }
        mdbase::runtime::CandidatePredicate::Compare { comparison } => {
            if let Some(kind) = comparison.value_kind {
                fields.push((comparison.field.clone(), kind));
            }
        }
        mdbase::runtime::CandidatePredicate::All
        | mdbase::runtime::CandidatePredicate::None
        | mdbase::runtime::CandidatePredicate::HasType { .. } => {}
    }
}

fn scalar_order_json_path(field: &mdbase::runtime::CandidateField) -> Option<Vec<String>> {
    match field {
        mdbase::runtime::CandidateField::File(name) if name == "mtime" => {
            Some(vec!["file".to_string(), "mtime".to_string()])
        }
        mdbase::runtime::CandidateField::PersistedFrontmatter(path) => {
            let mut result = vec!["persisted_frontmatter".to_string()];
            result.extend(path.iter().cloned());
            Some(result)
        }
        mdbase::runtime::CandidateField::EffectiveFrontmatter(path) => {
            let mut result = vec!["effective_frontmatter".to_string()];
            result.extend(path.iter().cloned());
            Some(result)
        }
        _ => None,
    }
}

fn push_scalar_order_expression(
    query: &mut QueryBuilder<Postgres>,
    order: &mdbase::runtime::HostedOrder,
    json_value: bool,
) {
    if let Some(path) = scalar_order_json_path(&order.field) {
        query.push("p.semantic_projection #");
        query.push(if json_value { "> " } else { ">> " });
        query.push_bind(path);
    } else {
        query.push("p.canonical_path");
    }
}

fn push_scalar_order_prefix_equal(
    query: &mut QueryBuilder<Postgres>,
    orders: &[mdbase::runtime::HostedOrder],
    values: &[Value],
) {
    for (index, (order, value)) in orders.iter().zip(values).enumerate() {
        if index > 0 {
            query.push(" AND ");
        }
        if value.is_null() {
            push_scalar_order_expression(query, order, false);
            query.push(" IS NULL");
        } else {
            push_scalar_order_expression(query, order, false);
            query.push(" = ").push_bind(
                value
                    .as_str()
                    .expect("scalar cursor values were validated above")
                    .to_string(),
            );
        }
    }
}

fn push_scalar_order_after(
    query: &mut QueryBuilder<Postgres>,
    order: &mdbase::runtime::HostedOrder,
    value: &Value,
) {
    let descending = matches!(
        order.direction,
        mdbase::runtime::HostedOrderDirection::Descending
    );
    if value.is_null() {
        if descending {
            push_scalar_order_expression(query, order, false);
            query.push(" IS NOT NULL");
        } else {
            query.push("FALSE");
        }
        return;
    }
    if !descending {
        query.push("(");
        push_scalar_order_expression(query, order, false);
        query.push(" IS NULL OR ");
    }
    push_scalar_order_expression(query, order, false);
    query
        .push(if descending { " < " } else { " > " })
        .push_bind(
            value
                .as_str()
                .expect("scalar cursor values were validated above")
                .to_string(),
        );
    if !descending {
        query.push(")");
    }
}

async fn load_exact_query_records(
    transaction: &mut Transaction<'_, Postgres>,
    crypto: &ProviderCrypto,
    data_key: &[u8; 32],
    collection_id: Uuid,
    state: &HostedQueryState,
    record_ids: &[Uuid],
    reserved_plaintext_bytes: u64,
) -> ApiResult<LoadedExactQueryRecords> {
    if reserved_plaintext_bytes > state.plan.budgets.max_exact_bytes {
        return Err(query_budget_error(
            "hosted_exact_byte_budget_exceeded",
            "The hosted query exceeded its exact-plaintext byte budget.",
            "exact_bytes",
            state.plan.budgets.max_exact_bytes,
            scoped_budget_observed(
                &state.allowed_types,
                state.plan.budgets.max_exact_bytes,
                reserved_plaintext_bytes,
            ),
        ));
    }
    if record_ids.is_empty() {
        return Ok(LoadedExactQueryRecords {
            records: HashMap::new(),
            ciphertext_bytes: 0,
            plaintext_bytes: reserved_plaintext_bytes,
        });
    }
    let snapshot_head = to_i64(state.snapshot_head, "query snapshot head")?;
    // Reject an oversized selected ciphertext set before decrypting any record.
    // The second query is streamed so provider memory stays bounded by the
    // already-enforced ciphertext cap plus the exact-plaintext cap.
    let ciphertext_bytes = number(
        sqlx::query_scalar::<_, i64>(
            r#"SELECT COALESCE(sum(octet_length(payload_ciphertext)), 0)::bigint
               FROM (
                   SELECT DISTINCT ON (record_id) payload_ciphertext, deleted
                   FROM hosted_provider_record_versions
                   WHERE collection_id = $1 AND record_id = ANY($2::uuid[])
                     AND sequence <= $3
                   ORDER BY record_id, sequence DESC
               ) selected
               WHERE NOT deleted"#,
        )
        .bind(collection_id)
        .bind(record_ids)
        .bind(snapshot_head)
        .fetch_one(&mut **transaction)
        .await?,
        "selected exact ciphertext bytes",
    )?;
    enforce_exact_ciphertext_scan_budget(state, ciphertext_bytes)?;

    let mut rows = sqlx::query(
        r#"SELECT DISTINCT ON (record_id) record_id, sequence, payload_ciphertext,
                  deleted, created_at
           FROM hosted_provider_record_versions
           WHERE collection_id = $1 AND record_id = ANY($2::uuid[]) AND sequence <= $3
           ORDER BY record_id, sequence DESC"#,
    )
    .bind(collection_id)
    .bind(record_ids)
    .bind(snapshot_head)
    .fetch(&mut **transaction);
    let mut records = HashMap::with_capacity(record_ids.len());
    let mut plaintext_bytes = reserved_plaintext_bytes;
    while let Some(row) = rows.try_next().await? {
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
        plaintext_bytes = plaintext_bytes.saturating_add(document_size);
        if plaintext_bytes > state.plan.budgets.max_exact_bytes {
            return Err(query_budget_error(
                "hosted_exact_byte_budget_exceeded",
                "The hosted query exceeded its exact-plaintext byte budget.",
                "exact_bytes",
                state.plan.budgets.max_exact_bytes,
                scoped_budget_observed(
                    &state.allowed_types,
                    state.plan.budgets.max_exact_bytes,
                    plaintext_bytes,
                ),
            ));
        }
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
    Ok(LoadedExactQueryRecords {
        records,
        ciphertext_bytes,
        plaintext_bytes,
    })
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
    let execution_proof = state.execution_proof.as_ref().ok_or_else(|| {
        ApiError::internal("A paged hosted query has no bounded execution proof.")
    })?;
    validate_execution_proof(execution_proof, state, replica)?;
    let execution_proof_ciphertext = crypto.encrypt_json(
        data_key,
        execution_proof,
        &query_cursor_execution_proof_aad(
            collection_id,
            replica.id,
            replica.scope_epoch,
            cursor_id,
            HOSTED_QUERY_EXECUTION_PROOF_VERSION,
            &state.plan.canonical_query_digest,
        ),
    )?;
    let execution_proof_bytes = execution_proof_ciphertext.len() as u64;
    let cursor_bytes = 2_048_u64
        .saturating_add(serialized_value_bytes(&plan))
        .saturating_add(serialized_value_bytes(&Value::Array(keyset.clone())))
        .saturating_add(serialized_value_bytes(&Value::Object(state.result_meta.clone())))
        .saturating_add(
            exact_context_ciphertext
                .as_ref()
                .map_or(0, |ciphertext| ciphertext.len() as u64),
        )
        .saturating_add(execution_proof_bytes)
        .saturating_add(base_plan.as_ref().map_or(0, serialized_value_bytes))
        .saturating_add(base_context.as_ref().map_or(0, serialized_value_bytes))
        .saturating_add(
            state
                .base_operation_clock
                .as_ref()
                .map_or(0, |clock| clock.len() as u64),
        )
        .saturating_add(state.catalog_revision.len() as u64)
        .saturating_add(state.semantic_engine_version.len() as u64);
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
    admit_query_cursor(
        transaction,
        collection_id,
        replica,
        cursor_bytes,
        base_invocation_id,
    )
    .await?;
    sqlx::query(
        r#"INSERT INTO hosted_provider_query_cursors
             (cursor_id, collection_id, replica_id, scope_epoch, snapshot_head,
              generation_id, catalog_revision, projection_format_version,
              semantic_engine_version, query_plan_version, query_digest, query_plan,
              request_kind, request_digest, result_meta, exact_context_ciphertext,
              base_plan, base_context, base_operation_clock, base_invocation_id,
              last_order_values, last_record_id, emitted_rows, expires_at, hard_expires_at,
              execution_proof_version, execution_proof_ciphertext,
              execution_proof_bytes, snapshot_record_count, scan_budget_records,
              scan_budget_ciphertext_bytes, projection_integrity_epoch, cursor_bytes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                   $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23,
                   LEAST(now() + make_interval(secs => $24), $25), $25,
                   $26, $27, $28, $29, $30, $31, $32, $33)"#,
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
    .bind(i64::from(HOSTED_QUERY_EXECUTION_PROOF_VERSION))
    .bind(execution_proof_ciphertext)
    .bind(to_i64(execution_proof_bytes, "query execution proof bytes")?)
    .bind(to_i64(
        state.snapshot_record_count,
        "query snapshot record count",
    )?)
    .bind(to_i64(state.scan_budget_records, "query scan budget")?)
    .bind(to_i64(
        state.scan_budget_ciphertext_bytes,
        "query ciphertext scan budget",
    )?)
    .bind(
        state
            .projection_integrity_epoch
            .map(|epoch| to_i64(epoch, "projection integrity epoch"))
            .transpose()?,
    )
    .bind(to_i64(cursor_bytes, "query cursor bytes")?)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

async fn admit_query_cursor(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
    replica: &Replica,
    cursor_bytes: u64,
    protected_base_invocation_id: Option<Uuid>,
) -> ApiResult<()> {
    let budgets = &HostedExecutionBudgetManifest::published().defaults;
    if cursor_bytes > budgets.cursor_bytes {
        return Err(query_budget_error(
            "hosted_cursor_byte_budget_exceeded",
            "The hosted query cursor exceeds its per-cursor byte budget.",
            "cursor_bytes",
            budgets.cursor_bytes,
            cursor_bytes,
        ));
    }
    sqlx::query(
        "SELECT pg_advisory_xact_lock(hashtextextended('mdbase-hosted-query-cursor-quota-v1', 0))",
    )
    .execute(&mut **transaction)
    .await?;
    sqlx::query("SELECT id FROM hosted_provider_replicas WHERE id = $1 FOR UPDATE")
        .bind(replica.id)
        .execute(&mut **transaction)
        .await?;
    sqlx::query(
        "DELETE FROM hosted_provider_query_cursors \
         WHERE expires_at <= now() OR hard_expires_at <= now()",
    )
    .execute(&mut **transaction)
    .await?;
    cleanup_base_query_invocations(
        &mut **transaction,
        collection_id,
        protected_base_invocation_id,
    )
    .await?;

    let account_id: Option<Uuid> = sqlx::query_scalar(
        "SELECT account_id FROM hosted_provider_collections WHERE id = $1 FOR SHARE",
    )
    .bind(collection_id)
    .fetch_one(&mut **transaction)
    .await?;
    let replica_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM hosted_provider_query_cursors WHERE replica_id = $1",
    )
    .bind(replica.id)
    .fetch_one(&mut **transaction)
    .await?;
    ensure_cursor_count_budget(
        "replica_cursor_count",
        MAX_LIVE_QUERY_CURSORS_PER_REPLICA as u64,
        replica_count,
    )?;
    let (collection_count, collection_bytes): (i64, i64) = sqlx::query_as(
        r#"SELECT count(*),
                  COALESCE(sum(GREATEST(cursor_bytes, pg_column_size(cursor_row)::bigint))::bigint, 0)
           FROM hosted_provider_query_cursors cursor_row
           WHERE collection_id = $1"#,
    )
    .bind(collection_id)
    .fetch_one(&mut **transaction)
    .await?;
    ensure_cursor_count_budget(
        "collection_cursor_count",
        budgets.cursor_count_per_collection,
        collection_count,
    )?;
    ensure_cursor_byte_quota(
        "collection_cursor_bytes",
        budgets.cursor_bytes_per_collection,
        collection_bytes,
        cursor_bytes,
    )?;
    if let Some(account_id) = account_id {
        let (account_count, account_bytes): (i64, i64) = sqlx::query_as(
            r#"SELECT count(*),
                      COALESCE(sum(GREATEST(cursor.cursor_bytes,
                                           pg_column_size(cursor)::bigint))::bigint, 0)
               FROM hosted_provider_query_cursors cursor
               JOIN hosted_provider_collections collection
                 ON collection.id = cursor.collection_id
               WHERE collection.account_id = $1"#,
        )
        .bind(account_id)
        .fetch_one(&mut **transaction)
        .await?;
        ensure_cursor_count_budget(
            "account_cursor_count",
            budgets.cursor_count_per_account,
            account_count,
        )?;
        ensure_cursor_byte_quota(
            "account_cursor_bytes",
            budgets.cursor_bytes_per_account,
            account_bytes,
            cursor_bytes,
        )?;
    }
    let (global_count, global_bytes): (i64, i64) = sqlx::query_as(
        r#"SELECT count(*),
                  COALESCE(sum(GREATEST(cursor_bytes, pg_column_size(cursor_row)::bigint))::bigint, 0)
           FROM hosted_provider_query_cursors cursor_row"#,
    )
    .fetch_one(&mut **transaction)
    .await?;
    ensure_cursor_count_budget(
        "global_cursor_count",
        budgets.cursor_count_global,
        global_count,
    )?;
    ensure_cursor_byte_quota(
        "global_cursor_bytes",
        budgets.cursor_bytes_global,
        global_bytes,
        cursor_bytes,
    )?;
    Ok(())
}

fn ensure_cursor_count_budget(budget: &str, limit: u64, current: i64) -> ApiResult<()> {
    let current = number(current, "live query cursor count")?;
    if current < limit {
        return Ok(());
    }
    Err(query_budget_error(
        "hosted_cursor_count_budget_exceeded",
        "The hosted query cursor count quota is exhausted.",
        budget,
        limit,
        limit.saturating_add(1),
    ))
}

fn ensure_cursor_byte_quota(
    budget: &str,
    limit: u64,
    current: i64,
    candidate: u64,
) -> ApiResult<()> {
    let observed = number(current, "live query cursor bytes")?.saturating_add(candidate);
    if observed <= limit {
        return Ok(());
    }
    Err(query_budget_error(
        "hosted_cursor_byte_budget_exceeded",
        "The hosted query cursor byte quota is exhausted.",
        budget,
        limit,
        limit.saturating_add(1),
    ))
}
