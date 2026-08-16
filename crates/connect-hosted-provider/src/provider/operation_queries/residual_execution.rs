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

fn reduction_error(
    error: mdbase::runtime::CatalogError,
    budgets: &mdbase::runtime::HostedQueryBudgets,
) -> ApiError {
    if error.code == "hosted_aggregation_state_budget_exceeded" {
        return query_budget_error(
            "hosted_aggregation_state_budget_exceeded",
            "The hosted query exceeded its retained aggregation-state budget.",
            "aggregation_state_bytes",
            budgets.max_aggregation_bytes,
            budgets.max_aggregation_bytes.saturating_add(1),
        );
    }
    projection_inconsistent(error)
}

fn group_database_error(error: sqlx::Error, budgets: &mdbase::runtime::HostedQueryBudgets) -> ApiError {
    if let sqlx::Error::Database(database) = &error {
        if database.code().as_deref() == Some("53400") {
            return query_budget_error(
                "hosted_aggregation_state_budget_exceeded",
                "PostgreSQL exceeded the hosted grouping work-state budget.",
                "aggregation_state_bytes",
                budgets.max_aggregation_bytes,
                budgets.max_aggregation_bytes.saturating_add(1),
            );
        }
    }
    error.into()
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
) -> ApiResult<(Option<Vec<Value>>, Option<u64>)> {
    if state.plan.groups.is_empty() && state.plan.aggregates.is_empty() {
        return Ok((None, None));
    }
    // GROUP BY necessarily discovers cardinality inside PostgreSQL. Cap every
    // executor lane before either the key-width preflight or aggregate runs:
    // three processes at most, bounded work memory per plan node, hash memory
    // equal to work_mem, and a bounded spill allowance. A spill-limit breach is
    // mapped to the same typed aggregation-state outcome as the Rust reducer.
    for (setting, value) in [
        ("work_mem", "4096kB"),
        ("hash_mem_multiplier", "1"),
        ("temp_file_limit", "32768kB"),
        ("max_parallel_workers_per_gather", "2"),
    ] {
        sqlx::query("SELECT set_config($1, $2, true)")
            .bind(setting)
            .bind(value)
            .execute(&mut **transaction)
            .await?;
    }
    preflight_projected_group_key_bytes(
        transaction,
        collection_id,
        state,
        candidate_types,
    )
    .await?;
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
    let mut reduction = state.plan.start_reduction();
    let mut operator_steps = 0_u64;
    let mut total_count = 0_u64;
    let mut group_count = 0_u64;
    let count_only = state
        .plan
        .aggregates
        .iter()
        .all(|aggregate| aggregate.function == "count");
    let built_query = query.build();
    let mut rows = built_query.fetch(&mut **transaction);
    while let Some(row) = rows
        .try_next()
        .await
        .map_err(|error| group_database_error(error, &state.plan.budgets))?
    {
        group_count = group_count.saturating_add(1);
        if group_count > state.plan.budgets.max_groups {
            return Err(query_budget_error(
                "hosted_group_budget_exceeded",
                "The hosted query exceeded its group budget.",
                "groups",
                state.plan.budgets.max_groups,
                group_count,
            ));
        }
        let count = number(row.get::<i64, _>("row_count"), "group row count")?;
        total_count = total_count.saturating_add(count);
        let row_steps = (state.plan.groups.len() + state.plan.aggregates.len()).max(1) as u64;
        operator_steps = operator_steps.saturating_add(if count_only {
            row_steps
        } else {
            count.saturating_mul(row_steps)
        });
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
        if count_only {
            reduction
                .push_repeated(&input, count)
                .map_err(|error| reduction_error(error, &state.plan.budgets))?;
        } else {
            for _ in 0..count {
                reduction
                    .push(&input)
                    .map_err(|error| reduction_error(error, &state.plan.budgets))?;
            }
        }
    }
    drop(rows);
    reduction
        .finish()
        .map(|reduction| (reduction.groups, Some(total_count)))
        .map_err(|error| reduction_error(error, &state.plan.budgets))
}

async fn preflight_projected_group_key_bytes(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
    state: &HostedQueryState,
    candidate_types: &[String],
) -> ApiResult<()> {
    if state.plan.groups.is_empty() {
        return Ok(());
    }
    // PostgreSQL must form grouping keys before the provider can stream result
    // groups into the canonical reducer. Bound every database-side key first so
    // max_groups distinct keys cannot retain an unbounded hash/sort state. Half
    // the reducer budget is reserved for keys and half for map/summary state.
    let max_group_key_bytes = state
        .plan
        .budgets
        .max_aggregation_bytes
        .checked_div(state.plan.budgets.max_groups.max(1))
        .unwrap_or(0)
        .checked_div(2)
        .unwrap_or(0)
        .max(1);
    let snapshot_head = to_i64(state.snapshot_head, "query snapshot head")?;
    let mut query = QueryBuilder::<Postgres>::new(
        "SELECT COALESCE(max(octet_length(jsonb_build_array(",
    );
    for (index, group) in state.plan.groups.iter().enumerate() {
        if index > 0 {
            query.push(", ");
        }
        query.push("COALESCE(");
        push_candidate_field(&mut query, &group.field);
        query.push(", 'null'::jsonb)");
    }
    query.push(")::text)), 0)::bigint FROM hosted_provider_record_projections p \
         JOIN hosted_provider_record_versions v ON v.collection_id = p.collection_id \
          AND v.record_id = p.record_id AND v.sequence = p.record_sequence \
          AND v.revision = p.record_revision AND NOT v.deleted AND v.sequence <= ");
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
    let observed = number(
        query
            .build_query_scalar::<i64>()
            .fetch_one(&mut **transaction)
            .await
            .map_err(|error| group_database_error(error, &state.plan.budgets))?,
        "maximum projected group key bytes",
    )?;
    if observed > max_group_key_bytes {
        return Err(query_budget_error(
            "hosted_aggregation_state_budget_exceeded",
            "A hosted grouping key exceeded its database-side aggregation-state budget.",
            "aggregation_state_bytes",
            max_group_key_bytes,
            observed,
        ));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn load_projected_page(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
    state: &HostedQueryState,
    candidate_types: &[String],
    page_size: u64,
) -> ApiResult<(Vec<ProjectedQueryRow>, bool)> {
    let snapshot_head = to_i64(state.snapshot_head, "query snapshot head")?;
    let mut query = QueryBuilder::<Postgres>::new(
        "SELECT p.record_id, p.canonical_path, p.projection_bytes \
         FROM hosted_provider_record_projections p WHERE p.collection_id = ",
    );
    query
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
              AND EXISTS ( \
                SELECT 1 FROM hosted_provider_record_versions v \
                WHERE v.collection_id = p.collection_id \
                  AND v.record_id = p.record_id \
                  AND v.sequence = p.record_sequence \
                  AND v.revision = p.record_revision \
                  AND NOT v.deleted AND v.sequence <= ",
        )
        .push_bind(snapshot_head)
        // Keep this as a correlated identity proof. Without OFFSET 0,
        // PostgreSQL flattens EXISTS into a full-snapshot hash semi-join and
        // defeats both direct cursor indexes.
        .push(" OFFSET 0) AND (cardinality(")
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
        if state.plan.order.is_empty() {
            query
                .push(" AND (p.canonical_path COLLATE \"C\", p.record_id) > (")
                .push_bind(last_path.to_string())
                .push(", ")
                .push_bind(last_record_id)
                .push(")");
        } else {
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
    }

    query.push(" ORDER BY ");
    for order in &state.plan.order {
        if scalar_order_is_file_mtime(order) {
            push_scalar_order_expression(&mut query, order, false);
            query.push(if matches!(
                order.direction,
                mdbase::runtime::HostedOrderDirection::Descending
            ) {
                " DESC NULLS FIRST, "
            } else {
                " ASC NULLS LAST, "
            });
            continue;
        }
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
        if !scalar_order_is_file_mtime(order) {
            query.push(" COLLATE \"C\"");
        }
        query.push(if matches!(
            order.direction,
            mdbase::runtime::HostedOrderDirection::Descending
        ) {
            " DESC, "
        } else {
            " ASC, "
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
        .push_bind(to_i64(page_size.saturating_add(1), "query page lookahead size")?);
    // This executor only admits the two direct orders backed by mandatory
    // cursor indexes. JSON predicate selectivity is intentionally not indexed,
    // so PostgreSQL can otherwise underestimate a broad match, scan the entire
    // snapshot, and top-N sort it. Discourage that plan for this one statement;
    // PostgreSQL may still sort if no ordered path exists. Restore the planner
    // setting before any later statement in the transaction.
    sqlx::query("SET LOCAL enable_sort = off")
        .execute(&mut **transaction)
        .await?;
    let rows = match query.build().fetch_all(&mut **transaction).await {
        Ok(rows) => rows,
        Err(error) => return Err(error.into()),
    };
    sqlx::query("SET LOCAL enable_sort = on")
        .execute(&mut **transaction)
        .await?;
    let mut metadata = rows
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
    let has_more = metadata.len() as u64 > page_size;
    if has_more {
        metadata.pop();
    }
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
    let rows = metadata
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
        .collect::<ApiResult<Vec<_>>>()?;
    Ok((rows, has_more))
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
        if scalar_order_is_file_mtime(order) {
            query.push("(jsonb_typeof(");
            push_scalar_order_expression(&mut query, order, true);
            query.push(") IS DISTINCT FROM 'string' OR ");
            push_scalar_order_expression(&mut query, order, false);
            query.push(" IS NULL OR ");
            push_scalar_order_expression(&mut query, order, true);
            query.push(
                " #>> '{}' IS DISTINCT FROM to_char(\
                 p.file_modified_at AT TIME ZONE 'UTC', \
                 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'))",
            );
        } else {
            query.push("(jsonb_typeof(");
            push_scalar_order_expression(&mut query, order, true);
            query.push(") IS NOT NULL AND jsonb_typeof(");
            push_scalar_order_expression(&mut query, order, true);
            query.push(") NOT IN ('string', 'null'))");
        }
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
    if scalar_order_is_file_mtime(order) && !json_value {
        query.push("p.file_modified_at");
        return;
    }
    if let Some(path) = scalar_order_json_path(&order.field) {
        query.push("p.semantic_projection #");
        query.push(if json_value { "> " } else { ">> " });
        query.push_bind(path);
    } else {
        query.push("p.canonical_path");
    }
}

fn scalar_order_is_file_mtime(order: &mdbase::runtime::HostedOrder) -> bool {
    matches!(&order.field, mdbase::runtime::CandidateField::File(name) if name == "mtime")
}

fn push_scalar_order_cursor_bind(
    query: &mut QueryBuilder<Postgres>,
    order: &mdbase::runtime::HostedOrder,
    value: &Value,
) {
    query.push_bind(
        value
            .as_str()
            .expect("scalar cursor values were validated above")
            .to_string(),
    );
    if scalar_order_is_file_mtime(order) {
        query.push("::timestamptz");
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
            if !scalar_order_is_file_mtime(order) {
                query.push(" COLLATE \"C\"");
            }
            query.push(" = ");
            push_scalar_order_cursor_bind(query, order, value);
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
    if !scalar_order_is_file_mtime(order) {
        query.push(" COLLATE \"C\"");
    }
    query.push(if descending { " < " } else { " > " });
    push_scalar_order_cursor_bind(query, order, value);
    if !descending {
        query.push(")");
    }
}
