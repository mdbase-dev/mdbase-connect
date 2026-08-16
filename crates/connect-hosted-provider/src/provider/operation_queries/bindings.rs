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

fn query_page_input_digest(
    request_kind: HostedQueryRequestKind,
    input: &Value,
) -> ApiResult<Vec<u8>> {
    let canonical = serde_jcs::to_vec(&json!({
        "schema": "mdbase.connect.hosted-query-page-request.v1",
        "request_kind": request_kind.as_str(),
        "input": input,
    }))
    .map_err(|error| {
        ApiError::internal(format!(
            "Hosted query-page request could not canonicalize: {error}"
        ))
    })?;
    Ok(Sha256::digest(canonical).to_vec())
}

#[allow(clippy::too_many_arguments)]
async fn replay_query_page_receipt(
    transaction: &mut Transaction<'_, Postgres>,
    crypto: &ProviderCrypto,
    data_key: &[u8; 32],
    collection_id: Uuid,
    replica: &Replica,
    request_id: Uuid,
    request_kind: HostedQueryRequestKind,
    input_digest: &[u8],
) -> ApiResult<Option<OperationResult>> {
    sqlx::query(
        r#"DELETE FROM hosted_provider_query_page_receipts
           WHERE replica_id = $1 AND request_id = $2 AND expires_at <= now()"#,
    )
    .bind(replica.id)
    .bind(request_id)
    .execute(&mut **transaction)
    .await?;
    let row = sqlx::query(
        r#"SELECT collection_id, scope_epoch, request_kind, input_digest,
                  response_ciphertext
           FROM hosted_provider_query_page_receipts
           WHERE replica_id = $1 AND request_id = $2
           FOR UPDATE"#,
    )
    .bind(replica.id)
    .bind(request_id)
    .fetch_optional(&mut **transaction)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let stored_digest: Vec<u8> = row.get("input_digest");
    let matches = row.get::<Uuid, _>("collection_id") == collection_id
        && number(row.get::<i64, _>("scope_epoch"), "scope epoch")? == replica.scope_epoch
        && row.get::<String, _>("request_kind") == request_kind.as_str()
        && stored_digest.len() == input_digest.len()
        && bool::from(stored_digest.ct_eq(input_digest));
    if !matches {
        return Err(ApiError::conflict(
            "query_request_id_conflict",
            "The hosted query request ID was already used for different input or authority.",
        ));
    }
    let result = crypto.decrypt_json(
        data_key,
        row.get("response_ciphertext"),
        &query_page_receipt_aad(collection_id, replica.id, request_id),
    )?;
    Ok(Some(result))
}

#[allow(clippy::too_many_arguments)]
async fn store_query_page_receipt(
    transaction: &mut Transaction<'_, Postgres>,
    crypto: &ProviderCrypto,
    data_key: &[u8; 32],
    collection_id: Uuid,
    replica: &Replica,
    request_id: Uuid,
    request_kind: HostedQueryRequestKind,
    input_digest: &[u8],
    result: &OperationResult,
    expires_at: DateTime<Utc>,
) -> ApiResult<()> {
    let ciphertext = crypto.encrypt_json(
        data_key,
        result,
        &query_page_receipt_aad(collection_id, replica.id, request_id),
    )?;
    sqlx::query(
        r#"INSERT INTO hosted_provider_query_page_receipts
             (replica_id, request_id, collection_id, scope_epoch, request_kind,
              input_digest, response_ciphertext, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)"#,
    )
    .bind(replica.id)
    .bind(request_id)
    .bind(collection_id)
    .bind(to_i64(replica.scope_epoch, "scope epoch")?)
    .bind(request_kind.as_str())
    .bind(input_digest)
    .bind(ciphertext)
    .bind(expires_at)
    .execute(&mut **transaction)
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
        return if matches!(
            state.request_kind,
            HostedQueryRequestKind::Query | HostedQueryRequestKind::ObsidianBase
        ) {
            Ok(())
        } else {
            Err(query_cursor_conflict(
                "query_generation_unavailable",
                "This hosted query kind has no pinned semantic generation.",
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
    page_size: u64,
    started: Instant,
) -> ApiResult<ExecutedQueryPage> {
    let total_count =
        count_projected_candidates(transaction, collection_id, state, candidate_types).await?;
    let rows = load_projected_page(
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
    let groups = load_projected_groups(
        transaction,
        collection_id,
        state,
        candidate_types,
    )
    .await?;
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
            resident_bytes,
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
        last_boundary: rows.last().map(|row| QueryPageBoundary {
            order_values: last_order_values.unwrap_or_default(),
            path: row.canonical_path.clone(),
            record_id: row.record_id,
        }),
        candidate_rows: rows.len() as u64,
        exact_documents: (exact_records.len() as u64).saturating_add(context_documents),
    })
}
