use super::operation_reads::compile_point_catalog;
use super::*;

const QUERY_CURSOR_IDLE_SECONDS: i64 = 60;
const QUERY_CURSOR_HARD_SECONDS: i64 = 300;

struct HostedQueryState {
    snapshot_head: u64,
    generation_id: Uuid,
    catalog_revision: String,
    projection_format_version: u32,
    semantic_engine_version: String,
    plan: mdbase::runtime::HostedQueryPlan,
    last_path: Option<String>,
    last_record_id: Option<Uuid>,
    emitted_rows: u64,
    hard_expires_at: DateTime<Utc>,
    consumed_cursor_id: Option<Uuid>,
}

struct ProjectedQueryRow {
    record_id: Uuid,
    canonical_path: String,
    projection: mdbase::runtime::SemanticProjection,
}

impl HostedProvider {
    pub(super) async fn execute_hosted_query(
        &self,
        collection_id: Uuid,
        replica: &Replica,
        input: &Value,
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
                     AND scope_epoch = $4"#,
            )
            .bind(cursor_id)
            .bind(collection_id)
            .bind(replica.id)
            .bind(to_i64(replica.scope_epoch, "scope epoch")?)
            .execute(&self.pool)
            .await?;
            return Ok(empty_query_result());
        }

        let started = Instant::now();
        let mut transaction = self.pool.begin().await?;
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
        let catalog = compile_point_catalog(resources, resource_documents)?;
        let requested_page_size = query_page_size(input)?;
        let mut state = if let Some(cursor) = input.get("cursor") {
            let cursor = cursor.as_str().ok_or_else(|| {
                ApiError::bad_request(
                    "invalid_query_cursor",
                    "The hosted query cursor must be an opaque string.",
                )
            })?;
            self.load_query_cursor(
                &mut transaction,
                collection_id,
                replica,
                decode_query_cursor(cursor)?,
                input,
                &catalog,
            )
            .await?
        } else {
            self.start_query_state(&collection, input, &catalog).await?
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

        let candidate_types = candidate_type_union(&state.plan.candidate).ok_or_else(|| {
            ApiError::bad_request(
                "unsupported_hosted_candidate",
                "The hosted query candidate plan is not yet available in the production SQL executor.",
            )
        })?;
        let order_descending = path_order_direction(&state.plan).ok_or_else(|| {
            ApiError::bad_request(
                "unsupported_hosted_order_runtime",
                "This hosted order requires the bounded top-K executor.",
            )
        })?;
        if !state.plan.residual.filter_fully_projected
            || state.plan.requirements.diagnostic_type_matchers
        {
            return Ok(mdbase::runtime::invalid_operation_result(
                "hosted_scan_budget_exceeded",
                "This query requires the bounded residual scan executor and was not allowed to fall back to a collection working set.",
            ));
        }
        if projection_fallback_exists(&mut transaction, collection_id, &state).await? {
            return Ok(mdbase::runtime::invalid_operation_result(
                "hosted_projection_fallback_required",
                "A stale or absent semantic projection requires bounded canonical fallback.",
            ));
        }

        let total_count =
            count_projected_candidates(&mut transaction, collection_id, &state, &candidate_types)
                .await?;
        let rows = load_projected_page(
            &mut transaction,
            collection_id,
            &state,
            &candidate_types,
            order_descending,
            requested_page_size,
        )
        .await?;
        let exact_records = if state.plan.requirements.exact_document {
            load_exact_query_records(
                &mut transaction,
                &self.crypto,
                &data_key,
                collection_id,
                state.snapshot_head,
                &rows.iter().map(|row| row.record_id).collect::<Vec<_>>(),
            )
            .await?
        } else {
            HashMap::new()
        };
        let mut results = Vec::with_capacity(rows.len());
        let mut diagnostics = Vec::new();
        for row in &rows {
            let evaluation = if state.plan.requirements.exact_document {
                let record = exact_records.get(&row.record_id).ok_or_else(|| {
                    ApiError::internal("A selected hosted query row has no exact snapshot record.")
                })?;
                catalog.evaluate_hosted_residual(&state.plan, record)
            } else {
                catalog.evaluate_hosted_projection_residual(&state.plan, &row.projection)
            }
            .map_err(|error| {
                ApiError::conflict("hosted_projection_inconsistent", error.message)
                    .with_details(json!({ "semantic_code": error.code }))
            })?;
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

        let page_count = results.len() as u64;
        let consumed = state
            .plan
            .offset
            .saturating_add(state.emitted_rows)
            .saturating_add(page_count);
        let has_more = consumed < total_count;
        let next_cursor = if has_more {
            let last = rows.last().ok_or_else(|| {
                ApiError::internal("A hosted query reported more rows without a keyset boundary.")
            })?;
            let cursor_id = Uuid::new_v4();
            insert_query_cursor(
                &mut transaction,
                collection_id,
                replica,
                cursor_id,
                &state,
                &last.canonical_path,
                last.record_id,
                state.emitted_rows.saturating_add(page_count),
            )
            .await?;
            Some(encode_query_cursor(cursor_id))
        } else {
            None
        };
        if let Some(consumed_cursor_id) = state.consumed_cursor_id.take() {
            sqlx::query("DELETE FROM hosted_provider_query_cursors WHERE cursor_id = $1")
                .bind(consumed_cursor_id)
                .execute(&mut *transaction)
                .await?;
        }
        transaction.commit().await?;

        let memory = crate::HostedProcessMemory::capture();
        tracing::info!(
            target: "mdbase_connect::metrics",
            metric = "hosted_projection_query_page",
            snapshot_head = state.snapshot_head,
            candidate_rows = rows.len() as u64,
            results = results.len() as u64,
            exact_documents = exact_records.len() as u64,
            elapsed_ms = started.elapsed().as_millis() as u64,
            database_pool_size = self.pool.size(),
            database_pool_idle = self.pool.num_idle(),
            rss_bytes = memory.rss_bytes.unwrap_or(0),
            pss_bytes = memory.pss_bytes.unwrap_or(0),
            cgroup_current_bytes = memory.cgroup_current_bytes.unwrap_or(0),
            "privacy-safe hosted provider metric"
        );
        let serialized_diagnostics =
            serde_json::to_value(&diagnostics).unwrap_or_else(|_| json!([]));
        Ok(OperationResult {
            valid: true,
            result: json!({
                "results": results,
                "meta": {
                    "total_count": total_count,
                    "has_more": has_more,
                    "cursor": next_cursor,
                },
                "diagnostics": serialized_diagnostics,
            }),
            diagnostics,
        })
    }

    async fn start_query_state(
        &self,
        collection: &PgRow,
        input: &Value,
        catalog: &mdbase::runtime::CompiledCatalog,
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
        Ok(HostedQueryState {
            snapshot_head: number(collection.get::<i64, _>("head"), "collection head")?,
            generation_id,
            catalog_revision,
            projection_format_version,
            semantic_engine_version,
            plan,
            last_path: None,
            last_record_id: None,
            emitted_rows: 0,
            hard_expires_at: Utc::now() + chrono::Duration::seconds(QUERY_CURSOR_HARD_SECONDS),
            consumed_cursor_id: None,
        })
    }

    #[allow(clippy::too_many_arguments)]
    async fn load_query_cursor(
        &self,
        transaction: &mut Transaction<'_, Postgres>,
        collection_id: Uuid,
        replica: &Replica,
        cursor_id: Uuid,
        input: &Value,
        catalog: &mdbase::runtime::CompiledCatalog,
    ) -> ApiResult<HostedQueryState> {
        let row = sqlx::query(
            r#"SELECT snapshot_head, generation_id, catalog_revision,
                      projection_format_version, semantic_engine_version,
                      query_plan, query_digest, last_order_values, last_record_id,
                      emitted_rows, hard_expires_at
               FROM hosted_provider_query_cursors
               WHERE cursor_id = $1 AND collection_id = $2 AND replica_id = $3
                 AND scope_epoch = $4 AND expires_at > now() AND hard_expires_at > now()
               FOR UPDATE"#,
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
        let requested = catalog
            .compile_hosted_query(input)
            .map_err(|error| ApiError::bad_request(error.code, error.message))?;
        if requested.canonical_query_digest != plan.canonical_query_digest
            || decode_sha256_digest(&plan.canonical_query_digest)?
                != row.get::<Vec<u8>, _>("query_digest")
        {
            return Err(query_cursor_conflict(
                "query_cursor_mismatch",
                "The hosted query cursor does not match the requested query.",
            ));
        }
        let order_values: Value = row.get("last_order_values");
        let last_path = order_values
            .as_array()
            .and_then(|values| values.first())
            .and_then(Value::as_str)
            .map(String::from)
            .ok_or_else(|| ApiError::internal("Stored hosted query keyset is invalid."))?;
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
            last_path: Some(last_path),
            last_record_id: row.get("last_record_id"),
            emitted_rows: number(row.get("emitted_rows"), "emitted query rows")?,
            hard_expires_at: row.get("hard_expires_at"),
            consumed_cursor_id: Some(cursor_id),
        })
    }
}

async fn validate_generation_binding(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
    state: &HostedQueryState,
) -> ApiResult<()> {
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

async fn count_projected_candidates(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
    state: &HostedQueryState,
    candidate_types: &[String],
) -> ApiResult<u64> {
    let count: i64 = sqlx::query_scalar(
        r#"SELECT count(*)
           FROM hosted_provider_record_projections p
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
        r#"SELECT p.record_id, p.canonical_path, p.semantic_projection
           FROM hosted_provider_record_projections p
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
        r#"SELECT p.record_id, p.canonical_path, p.semantic_projection
           FROM hosted_provider_record_projections p
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
    rows.into_iter()
        .map(|row| {
            let projection =
                serde_json::from_value(row.get("semantic_projection")).map_err(|error| {
                    ApiError::conflict(
                        "hosted_projection_inconsistent",
                        format!("A hosted semantic projection could not decode: {error}"),
                    )
                })?;
            Ok(ProjectedQueryRow {
                record_id: row.get("record_id"),
                canonical_path: row.get("canonical_path"),
                projection,
            })
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
        r#"SELECT DISTINCT ON (record_id) record_id, sequence, payload_ciphertext, deleted
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
        records.insert(
            record_id,
            mdbase::runtime::CanonicalRecordInput {
                stable_id: Some(record_id.to_string()),
                path: record.path,
                file_size: record.document.len() as u64,
                document: record.document,
                file_mtime: None,
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
    last_path: &str,
    last_record_id: Uuid,
    emitted_rows: u64,
) -> ApiResult<()> {
    let plan = serde_json::to_value(&state.plan).map_err(|error| {
        ApiError::internal(format!("Hosted query plan could not serialize: {error}"))
    })?;
    sqlx::query(
        r#"INSERT INTO hosted_provider_query_cursors
             (cursor_id, collection_id, replica_id, scope_epoch, snapshot_head,
              generation_id, catalog_revision, projection_format_version,
              semantic_engine_version, query_plan_version, query_digest, query_plan,
              last_order_values, last_record_id, emitted_rows, expires_at, hard_expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                   jsonb_build_array($13::text), $14, $15,
                   LEAST(now() + make_interval(secs => $16), $17), $17)"#,
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
    .bind(last_path)
    .bind(last_record_id)
    .bind(to_i64(emitted_rows, "emitted query rows")?)
    .bind(QUERY_CURSOR_IDLE_SECONDS)
    .bind(state.hard_expires_at)
    .execute(&mut **transaction)
    .await?;
    Ok(())
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
                let CandidatePredicate::HasType { type_name } = term else {
                    return None;
                };
                types.push(type_name.clone());
            }
            types.sort();
            types.dedup();
            Some(types)
        }
        CandidatePredicate::And { terms } if terms.len() == 1 => candidate_type_union(&terms[0]),
        CandidatePredicate::And { .. }
        | CandidatePredicate::Not { .. }
        | CandidatePredicate::Compare { .. } => None,
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
        .is_none());
    }
}
