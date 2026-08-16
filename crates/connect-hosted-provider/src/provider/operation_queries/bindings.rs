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

const QUERY_RECEIPT_JSON_V1: &str = "json-v1";
const QUERY_RECEIPT_ZSTD_JSON_V1: &str = "zstd-json-v1";
const QUERY_RECEIPT_ZSTD_LEVEL: i32 = 3;

fn encode_query_page_receipt_payload(
    result: &OperationResult,
    maximum_bytes: u64,
) -> ApiResult<(&'static str, Vec<u8>)> {
    let plaintext = serde_json::to_vec(result).map_err(|error| {
        ApiError::internal(format!(
            "Hosted query receipt could not serialize: {error}"
        ))
    })?;
    if plaintext.len() as u64 > maximum_bytes {
        return Err(query_budget_error(
            "hosted_query_receipt_byte_budget_exceeded",
            "The hosted query response exceeds the durable retry-receipt budget.",
            "query_receipt_plaintext_bytes",
            maximum_bytes,
            plaintext.len() as u64,
        ));
    }
    let compressed = zstd::bulk::compress(&plaintext, QUERY_RECEIPT_ZSTD_LEVEL).map_err(|error| {
        ApiError::internal(format!(
            "Hosted query receipt could not be compressed: {error}"
        ))
    })?;
    if compressed.len() < plaintext.len() {
        Ok((QUERY_RECEIPT_ZSTD_JSON_V1, compressed))
    } else {
        Ok((QUERY_RECEIPT_JSON_V1, plaintext))
    }
}

fn decode_query_page_receipt_payload(
    encoding: &str,
    payload: &[u8],
    maximum_bytes: u64,
) -> ApiResult<OperationResult> {
    let maximum_bytes = usize::try_from(maximum_bytes)
        .map_err(|_| ApiError::internal("Hosted query receipt byte budget is unsupported."))?;
    let plaintext = match encoding {
        QUERY_RECEIPT_JSON_V1 => {
            if payload.len() > maximum_bytes {
                return Err(ApiError::internal(
                    "Hosted query receipt plaintext exceeds its decode budget.",
                ));
            }
            payload.to_vec()
        }
        QUERY_RECEIPT_ZSTD_JSON_V1 => zstd::bulk::decompress(payload, maximum_bytes).map_err(
            |error| {
                ApiError::internal(format!(
                    "Hosted query receipt compressed payload is invalid or oversized: {error}"
                ))
            },
        )?,
        _ => {
            return Err(ApiError::internal(
                "Hosted query receipt has an unsupported response encoding.",
            ))
        }
    };
    serde_json::from_slice(&plaintext)
        .map_err(|error| ApiError::internal(format!("Hosted query receipt is invalid: {error}")))
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
                  response_ciphertext, response_encoding
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
    let payload = crypto.decrypt_bytes(
        data_key,
        row.get("response_ciphertext"),
        &query_page_receipt_aad(collection_id, replica.id, request_id),
    )?;
    let result = decode_query_page_receipt_payload(
        row.get::<String, _>("response_encoding").as_str(),
        &payload,
        HostedExecutionBudgetManifest::published()
            .defaults
            .query_receipt_ciphertext_bytes,
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
    let budgets = &HostedExecutionBudgetManifest::published().defaults;
    let (response_encoding, payload) = encode_query_page_receipt_payload(
        result,
        budgets.query_receipt_ciphertext_bytes,
    )?;
    let ciphertext = crypto.encrypt_bytes(
        data_key,
        &payload,
        &query_page_receipt_aad(collection_id, replica.id, request_id),
    )?;
    let ciphertext_bytes = ciphertext.len() as u64;
    if ciphertext_bytes > budgets.query_receipt_ciphertext_bytes {
        return Err(query_budget_error(
            "hosted_query_receipt_byte_budget_exceeded",
            "The encrypted hosted query response exceeds the durable retry-receipt budget.",
            "query_receipt_ciphertext_bytes",
            budgets.query_receipt_ciphertext_bytes,
            ciphertext_bytes,
        ));
    }
    // Serialize every admission because collection/account/global byte quotas
    // span replicas. Each replica retains only its newest bounded replay
    // window; advancing beyond 64 pages evicts the oldest receipt instead of
    // stalling a legitimate query chain. A retry outside the window receives
    // the ordinary expired/missing-cursor outcome and must restart the query.
    sqlx::query(
        "SELECT pg_advisory_xact_lock(hashtextextended('mdbase-hosted-query-receipt-quota-v1', 0))",
    )
    .execute(&mut **transaction)
    .await?;
    // Expiry cleanup is global but bounded by both rows and retained bytes.
    // Counter triggers decrement each affected scope in the same transaction;
    // any remaining expired footprint therefore fails quota admission closed
    // until a later page or maintenance tick advances the bounded sweep.
    sqlx::query(
        r#"WITH candidates AS MATERIALIZED (
             SELECT replica_id, request_id, collection_id, expires_at,
                    response_ciphertext_bytes AS receipt_bytes
             FROM hosted_provider_query_page_receipts
             WHERE expires_at <= now()
             ORDER BY expires_at, collection_id, replica_id, request_id
             LIMIT $1
           ), expired AS MATERIALIZED (
             SELECT replica_id, request_id
             FROM (
               SELECT *, sum(receipt_bytes) OVER (
                 ORDER BY expires_at, collection_id, replica_id, request_id
                 ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
               ) AS cumulative_bytes
               FROM candidates
             ) bounded
             WHERE cumulative_bytes <= $2
           )
           DELETE FROM hosted_provider_query_page_receipts receipt
           USING expired
           WHERE receipt.replica_id = expired.replica_id
             AND receipt.request_id = expired.request_id"#,
    )
    .bind(to_i64(
        budgets.query_receipt_cleanup_rows,
        "query receipt cleanup row budget",
    )?)
    .bind(to_i64(
        budgets.query_receipt_cleanup_bytes,
        "query receipt cleanup byte budget",
    )?)
    .execute(&mut **transaction)
    .await?;
    sqlx::query("SELECT id FROM hosted_provider_replicas WHERE id = $1 FOR UPDATE")
        .bind(replica.id)
        .execute(&mut **transaction)
        .await?;
    sqlx::query(
        r#"DELETE FROM hosted_provider_query_page_receipts
           WHERE replica_id = $1 AND expires_at <= now()"#,
    )
    .bind(replica.id)
    .execute(&mut **transaction)
    .await?;
    if ciphertext_bytes > budgets.query_receipt_bytes_per_replica {
        return Err(query_budget_error(
            "hosted_query_receipt_byte_budget_exceeded",
            "The encrypted hosted query response exceeds the replica replay-window budget.",
            "replica_query_receipt_bytes",
            budgets.query_receipt_bytes_per_replica,
            ciphertext_bytes,
        ));
    }
    sqlx::query(
        r#"WITH ranked AS MATERIALIZED (
             SELECT request_id,
                    row_number() OVER (
                      ORDER BY created_at DESC, request_id DESC
                    ) AS newest_position,
                    sum(response_ciphertext_bytes) OVER (
                      ORDER BY created_at DESC, request_id DESC
                      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                    ) AS newest_bytes
             FROM hosted_provider_query_page_receipts
             WHERE replica_id = $1 AND expires_at > now()
           )
           DELETE FROM hosted_provider_query_page_receipts receipt
           USING ranked
           WHERE receipt.replica_id = $1
             AND receipt.request_id = ranked.request_id
             AND (
               ranked.newest_position >= $2
               OR ranked.newest_bytes + $3 > $4
             )"#,
    )
    .bind(replica.id)
    .bind(to_i64(
        budgets.query_receipts_per_replica,
        "query receipts per replica",
    )?)
    .bind(to_i64(ciphertext_bytes, "query receipt ciphertext bytes")?)
    .bind(to_i64(
        budgets.query_receipt_bytes_per_replica,
        "replica query receipt byte quota",
    )?)
    .execute(&mut **transaction)
    .await?;

    let collection_bytes = query_receipt_usage_bytes(
        transaction,
        "collection",
        collection_id,
    )
    .await?;
    ensure_query_receipt_byte_quota(
        "collection_query_receipt_bytes",
        budgets.query_receipt_bytes_per_collection,
        collection_bytes,
        ciphertext_bytes,
    )?;
    let account_id: Option<Uuid> = sqlx::query_scalar(
        "SELECT account_id FROM hosted_provider_collections WHERE id = $1 FOR SHARE",
    )
    .bind(collection_id)
    .fetch_one(&mut **transaction)
    .await?;
    if let Some(account_id) = account_id {
        let account_bytes =
            query_receipt_usage_bytes(transaction, "account", account_id).await?;
        ensure_query_receipt_byte_quota(
            "account_query_receipt_bytes",
            budgets.query_receipt_bytes_per_account,
            account_bytes,
            ciphertext_bytes,
        )?;
    }
    let global_bytes = query_receipt_usage_bytes(
        transaction,
        "global",
        Uuid::nil(),
    )
    .await?;
    ensure_query_receipt_byte_quota(
        "global_query_receipt_bytes",
        budgets.query_receipt_bytes_global,
        global_bytes,
        ciphertext_bytes,
    )?;
    sqlx::query(
        r#"INSERT INTO hosted_provider_query_page_receipts
             (replica_id, request_id, collection_id, scope_epoch, request_kind,
              input_digest, response_ciphertext, response_encoding, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)"#,
    )
    .bind(replica.id)
    .bind(request_id)
    .bind(collection_id)
    .bind(to_i64(replica.scope_epoch, "scope epoch")?)
    .bind(request_kind.as_str())
    .bind(input_digest)
    .bind(ciphertext)
    .bind(response_encoding)
    .bind(expires_at)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

async fn query_receipt_usage_bytes(
    transaction: &mut Transaction<'_, Postgres>,
    scope_kind: &str,
    scope_id: Uuid,
) -> ApiResult<i64> {
    Ok(sqlx::query_scalar(
        r#"SELECT COALESCE((
             SELECT ciphertext_bytes
             FROM hosted_provider_query_receipt_usage
             WHERE scope_kind = $1 AND scope_id = $2
           ), 0)::bigint"#,
    )
    .bind(scope_kind)
    .bind(scope_id)
    .fetch_one(&mut **transaction)
    .await?)
}

fn ensure_query_receipt_byte_quota(
    budget: &str,
    limit: u64,
    current: i64,
    candidate: u64,
) -> ApiResult<()> {
    let observed = number(current, "live query receipt bytes")?.saturating_add(candidate);
    if observed <= limit {
        return Ok(());
    }
    Err(query_budget_error(
        "hosted_query_receipt_byte_budget_exceeded",
        "The durable hosted query replay-receipt byte quota is exhausted.",
        budget,
        limit,
        limit.saturating_add(1),
    ))
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

fn hosted_query_scan_budgets() -> (u64, u64) {
    let budgets = crate::execution_budget::hosted_execution_budgets();
    (budgets.scanned_records, budgets.scanned_ciphertext_bytes)
}

fn collection_projection_integrity_epoch(collection: &PgRow) -> ApiResult<Option<u64>> {
    collection
        .get::<Option<i64>, _>("projection_integrity_epoch")
        .map(|epoch| number(epoch, "projection integrity epoch"))
        .transpose()
}

fn collection_projection_integrity_verified(collection: &PgRow) -> ApiResult<bool> {
    let epoch = collection_projection_integrity_epoch(collection)?;
    let verified = collection
        .get::<Option<i64>, _>("projection_integrity_verified_epoch")
        .map(|value| number(value, "verified projection integrity epoch"))
        .transpose()?;
    Ok(epoch.is_some() && epoch == verified)
}

fn enforce_hosted_query_scan_budget(state: &HostedQueryState) -> ApiResult<()> {
    if state.snapshot_record_count <= state.scan_budget_records {
        return Ok(());
    }
    Err(query_budget_error(
        "hosted_scan_budget_exceeded",
        "The hosted query exceeds its pinned collection-scan budget.",
        "scanned_records",
        state.scan_budget_records,
        scoped_budget_observed(
            &state.allowed_types,
            state.scan_budget_records,
            state.snapshot_record_count,
        ),
    ))
}

fn enforce_exact_ciphertext_scan_budget(
    state: &HostedQueryState,
    observed_ciphertext_bytes: u64,
) -> ApiResult<()> {
    if observed_ciphertext_bytes <= state.scan_budget_ciphertext_bytes {
        return Ok(());
    }
    Err(query_budget_error(
        "hosted_scan_byte_budget_exceeded",
        "The hosted query exceeded its exact-ciphertext scan budget.",
        "scanned_ciphertext_bytes",
        state.scan_budget_ciphertext_bytes,
        scoped_budget_observed(
            &state.allowed_types,
            state.scan_budget_ciphertext_bytes,
            observed_ciphertext_bytes,
        ),
    ))
}

fn execution_proof_for_state(
    state: &HostedQueryState,
    replica: &Replica,
    execution: HostedQueryExecutionModeV1,
) -> HostedQueryExecutionProofV1 {
    HostedQueryExecutionProofV1 {
        version: HOSTED_QUERY_EXECUTION_PROOF_VERSION,
        plan_digest: state.plan.canonical_query_digest.clone(),
        request_digest: state.request_digest.clone(),
        request_kind: state.request_kind.as_str().to_string(),
        scope_epoch: replica.scope_epoch,
        snapshot_head: state.snapshot_head,
        snapshot_record_count: state.snapshot_record_count,
        scan_budget_records: state.scan_budget_records,
        scan_budget_ciphertext_bytes: state.scan_budget_ciphertext_bytes,
        generation_id: state.generation_id,
        catalog_revision: state.catalog_revision.clone(),
        projection_format_version: state.projection_format_version,
        semantic_engine_version: state.semantic_engine_version.clone(),
        projection_integrity_epoch: state.projection_integrity_epoch,
        execution,
    }
}

fn validate_execution_proof(
    proof: &HostedQueryExecutionProofV1,
    state: &HostedQueryState,
    replica: &Replica,
) -> ApiResult<()> {
    let valid = proof.version == HOSTED_QUERY_EXECUTION_PROOF_VERSION
        && proof.plan_digest == state.plan.canonical_query_digest
        && proof.request_digest == state.request_digest
        && proof.request_kind == state.request_kind.as_str()
        && proof.scope_epoch == replica.scope_epoch
        && proof.snapshot_head == state.snapshot_head
        && proof.snapshot_record_count == state.snapshot_record_count
        && proof.scan_budget_records == state.scan_budget_records
        && proof.scan_budget_ciphertext_bytes == state.scan_budget_ciphertext_bytes
        && proof.generation_id == state.generation_id
        && proof.catalog_revision == state.catalog_revision
        && proof.projection_format_version == state.projection_format_version
        && proof.semantic_engine_version == state.semantic_engine_version
        && proof.projection_integrity_epoch == state.projection_integrity_epoch;
    if valid {
        Ok(())
    } else {
        Err(query_cursor_conflict(
            "query_cursor_invalidated",
            "The hosted query cursor execution proof no longer matches its authority binding.",
        ))
    }
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
             AND hosted_provider_projection_digest_valid(
                   p.projection_digest, p.projection_observed_digest)
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
    state: &mut HostedQueryState,
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
    let integrity: Option<(i64, i64)> = sqlx::query_as(
        r#"SELECT integrity_epoch, integrity_verified_epoch
           FROM hosted_provider_projection_generations
           WHERE collection_id = $1 AND generation_id = $2 AND status = 'complete'
             AND target_catalog_revision = $3 AND projection_format_version = $4
             AND semantic_engine_version = $5 AND source_head <= $6"#,
    )
    .bind(collection_id)
    .bind(state.generation_id)
    .bind(&state.catalog_revision)
    .bind(i64::from(state.projection_format_version))
    .bind(&state.semantic_engine_version)
    .bind(to_i64(state.snapshot_head, "query snapshot head")?)
    .fetch_optional(&mut **transaction)
    .await?;
    let Some((integrity_epoch, integrity_verified_epoch)) = integrity else {
        return Err(query_cursor_conflict(
            "query_generation_unavailable",
            "The semantic generation pinned by this hosted query is unavailable.",
        ));
    };
    let integrity_epoch = number(integrity_epoch, "projection integrity epoch")?;
    let integrity_verified_epoch = number(
        integrity_verified_epoch,
        "verified projection integrity epoch",
    )?;
    if state.projection_integrity_epoch != Some(integrity_epoch) {
        // Ordinary writes append a new exact version and retain the projection
        // row visible at this cursor's snapshot. Only reuse the frozen mode,
        // count, and groups after proving that every exact row still visible at
        // the snapshot has a matching, digest-valid projection row. This scan
        // happens only when the generation epoch advances, not on every page.
        if integrity_verified_epoch != integrity_epoch {
            if Box::pin(projection_fallback_exists(transaction, collection_id, state)).await? {
                return Err(query_cursor_conflict(
                    "query_projection_changed",
                    "The semantic projection changed while this hosted query was being paged.",
                ));
            }
            state.projection_integrity_epoch = Some(integrity_epoch);
            mark_projection_integrity_verified(transaction, collection_id, state).await?;
        }
        state.projection_integrity_epoch = Some(integrity_epoch);
        state.projection_integrity_verified = true;
        if let Some(proof) = state.execution_proof.as_mut() {
            proof.projection_integrity_epoch = Some(integrity_epoch);
        }
    }
    Ok(())
}

async fn mark_projection_integrity_verified(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
    state: &mut HostedQueryState,
) -> ApiResult<()> {
    let updated = sqlx::query(
        r#"UPDATE hosted_provider_projection_generations
           SET integrity_verified_epoch = integrity_epoch, updated_at = now()
           WHERE collection_id = $1 AND generation_id = $2 AND status = 'complete'
             AND integrity_epoch = $3"#,
    )
    .bind(collection_id)
    .bind(state.generation_id)
    .bind(
        state
            .projection_integrity_epoch
            .map(|epoch| to_i64(epoch, "projection integrity epoch"))
            .transpose()?,
    )
    .execute(&mut **transaction)
    .await?;
    if updated.rows_affected() != 1 {
        return Err(query_cursor_conflict(
            "query_projection_changed",
            "The semantic projection integrity epoch changed during verification.",
        ));
    }
    state.projection_integrity_verified = true;
    Ok(())
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
               OR NOT hosted_provider_projection_digest_valid(
                 p.projection_digest, p.projection_observed_digest)
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
               OR NOT hosted_provider_projection_digest_valid(
                 p.projection_digest, p.projection_observed_digest)
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
