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
            scoped_budget_observed(
                &plan.allowed_types,
                state.plan.budgets.max_exact_documents,
                live_ids.len() as u64,
            ),
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
            scoped_budget_observed(
                &plan.allowed_types,
                state.plan.budgets.max_exact_bytes,
                exact_bytes,
            ),
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
                    scoped_budget_observed(
                        &plan.allowed_types,
                        state.plan.budgets.max_operator_steps,
                        relationship_rows,
                    ),
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
