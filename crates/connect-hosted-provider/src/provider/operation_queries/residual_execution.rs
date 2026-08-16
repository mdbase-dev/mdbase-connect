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

