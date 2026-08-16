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
    // The encrypted persisted JSON is always larger than its Markdown
    // document: it contains the document plus record metadata and AEAD
    // overhead. Treating selected ciphertext bytes as a conservative
    // plaintext upper bound lets an oversized exact page fail before any
    // record is decrypted. Near-boundary pages may receive the same typed
    // budget outcome conservatively; they never bypass the published limit.
    let conservative_plaintext_bytes =
        reserved_plaintext_bytes.saturating_add(ciphertext_bytes);
    if conservative_plaintext_bytes > state.plan.budgets.max_exact_bytes {
        return Err(query_budget_error(
            "hosted_exact_byte_budget_exceeded",
            "The hosted query exceeded its conservative exact-plaintext byte budget.",
            "exact_bytes",
            state.plan.budgets.max_exact_bytes,
            scoped_budget_observed(
                &state.allowed_types,
                state.plan.budgets.max_exact_bytes,
                conservative_plaintext_bytes,
            ),
        ));
    }

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
                   LEAST(now() + ($24::bigint * interval '1 millisecond'), $25), $25,
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
    .bind(to_i64(
        hosted_execution_budgets().cursor_idle_ttl_ms,
        "query cursor idle TTL",
    )?)
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
    cleanup_expired_query_cursors(&mut **transaction, None).await?;
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
        "SELECT count(*) FROM hosted_provider_query_cursors \
         WHERE replica_id = $1 AND expires_at > now() AND hard_expires_at > now()",
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
           WHERE collection_id = $1
             AND expires_at > now() AND hard_expires_at > now()"#,
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
               WHERE collection.account_id = $1
                 AND cursor.expires_at > now() AND cursor.hard_expires_at > now()"#,
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
           FROM hosted_provider_query_cursors cursor_row
           WHERE expires_at > now() AND hard_expires_at > now()"#,
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
