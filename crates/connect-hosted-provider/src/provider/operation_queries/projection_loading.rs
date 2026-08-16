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
             AND hosted_provider_projection_digest_valid(
                   projection_digest, projection_observed_digest)
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
            " AND hosted_provider_projection_digest_valid( \
                p.projection_digest, p.projection_observed_digest) \
                AND p.semantic_complete AND p.resolution_complete \
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
            scoped_budget_observed(
                &state.allowed_types,
                state.plan.budgets.max_candidate_rows,
                rows.len() as u64,
            ),
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
            scoped_budget_observed(
                &state.allowed_types,
                state.plan.budgets.max_candidate_bytes,
                projection_bytes,
            ),
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
             AND hosted_provider_projection_digest_valid(
                   p.projection_digest, p.projection_observed_digest)
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
    force_exact_residual: bool,
    bounded_ordering: bool,
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
            " AND hosted_provider_projection_digest_valid( \
               p.projection_digest, p.projection_observed_digest) \
               AND p.semantic_complete AND p.resolution_complete AS projection_current \
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
    if state.plan.requirements.diagnostic_type_matchers || force_exact_residual {
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
        if bounded_ordering {
            return Err(query_budget_error(
                "hosted_ordering_budget_exceeded",
                "The hosted query exceeded its bounded top-K ordering budget.",
                "top_k_entries",
                state.plan.budgets.max_candidate_rows,
                scoped_budget_observed(
                    &state.allowed_types,
                    state.plan.budgets.max_candidate_rows,
                    rows.len() as u64,
                ),
            ));
        }
        return Err(query_budget_error(
            "hosted_scan_budget_exceeded",
            "The hosted query exceeded its candidate-row budget.",
            "candidate_rows",
            state.plan.budgets.max_candidate_rows,
            scoped_budget_observed(
                &state.allowed_types,
                state.plan.budgets.max_candidate_rows,
                rows.len() as u64,
            ),
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
        if force_exact_residual || state.plan.requirements.exact_document || projection.is_none() {
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
            scoped_budget_observed(
                &state.allowed_types,
                state.plan.budgets.max_exact_documents,
                (exact_ids.len() as u64).saturating_add(context_documents),
            ),
        ));
    }
    let loaded_exact = load_exact_query_records(
        transaction,
        crypto,
        data_key,
        collection_id,
        state,
        &exact_ids,
        state
            .exact_context
            .as_ref()
            .map_or(0, |context| context.document.len() as u64),
    )
    .await?;
    let exact_ciphertext_bytes = loaded_exact.ciphertext_bytes;
    let exact_bytes = loaded_exact.plaintext_bytes;
    let exact_records = loaded_exact.records;

    let mut diagnostics = Vec::new();
    let offset = if state.last_path.is_none() {
        state.plan.offset
    } else {
        0
    };
    let top_k_capacity = offset.saturating_add(page_size);
    let mut top_k = BoundedQueryTopK::new(
        &state.plan,
        usize::try_from(top_k_capacity).unwrap_or(usize::MAX),
    );
    let mut reduction = state.plan.start_reduction();
    let mut total_count = 0_u64;
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
            let item = BoundedQueryMatch {
                path,
                record_id: candidate.record_id,
                result,
                order_values: evaluation.order_values,
                reduction: mdbase::runtime::HostedReductionInput {
                    group_values: evaluation.group_values,
                    aggregate_values: evaluation.aggregate_values,
                },
            };
            total_count = total_count.saturating_add(1);
            reduction
                .push(&item.reduction)
                .map_err(|error| reduction_error(error, &state.plan.budgets))?;
            let after_keyset = state.last_path.as_deref().is_none_or(|last_path| {
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
            if after_keyset {
                top_k.push(item);
            }
        }
    }
    let matching = top_k.into_sorted();
    let operator_steps = candidate_count.saturating_add(
        total_count.saturating_mul(
            u64::from(top_k_capacity.max(1).ilog2().saturating_add(1))
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
            scoped_budget_observed(
                &state.allowed_types,
                state.plan.budgets.max_operator_steps,
                operator_steps,
            ),
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
    let pre_reduction_resident_bytes = projection_bytes
        .saturating_add(exact_bytes)
        .saturating_add(matching_bytes);
    if pre_reduction_resident_bytes > state.plan.budgets.max_memory_bytes {
        return Err(query_budget_error(
            "hosted_memory_budget_exceeded",
            "The hosted query exceeded its bounded resident-memory budget.",
            "memory_bytes",
            state.plan.budgets.max_memory_bytes,
            scoped_budget_observed(
                &state.allowed_types,
                state.plan.budgets.max_memory_bytes,
                pre_reduction_resident_bytes,
            ),
        ));
    }
    let reduction = reduction
        .finish()
        .map_err(|error| reduction_error(error, &state.plan.budgets))?;
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
            scoped_budget_observed(
                &state.allowed_types,
                state.plan.budgets.max_memory_bytes,
                resident_bytes,
            ),
        ));
    }
    let page = matching
        .into_iter()
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
        has_more: state
            .plan
            .offset
            .saturating_add(state.emitted_rows)
            .saturating_add(results.len() as u64)
            < total_count,
        results,
        diagnostics,
        groups: reduction.groups,
        total_count: Some(total_count),
        last_boundary,
        candidate_rows: candidate_count,
        exact_documents: (exact_records.len() as u64).saturating_add(context_documents),
        exact_ciphertext_bytes,
        base_path_keyset: false,
    })
}
