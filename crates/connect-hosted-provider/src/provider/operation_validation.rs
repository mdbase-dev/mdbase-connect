use super::operation_reads::{compile_point_catalog, load_direct_record, DirectRecordIdentity};
use super::*;

const VALIDATION_SCAN_RECORDS: u64 = 100_000;
const VALIDATION_SCAN_PROJECTION_BYTES: u64 = 256 * 1024 * 1024;
const VALIDATION_EXACT_RECORDS: usize = 2_001;
const VALIDATION_EXACT_BYTES: u64 = 32 * 1024 * 1024;
const VALIDATION_FALLBACK_BYTES: u64 = 64 * 1024 * 1024;
const VALIDATION_PAGE_SIZE: i64 = 200;
const VALIDATION_TIME: Duration = Duration::from_secs(30);

impl HostedProvider {
    pub(super) async fn execute_direct_validation(
        &self,
        collection_id: Uuid,
        input: &Value,
    ) -> ApiResult<OperationResult> {
        let collection_only = input.get("collection_only").and_then(Value::as_bool) == Some(true);
        let path = input.get("path").and_then(Value::as_str);
        if path.is_none() && !collection_only {
            return Err(ApiError::bad_request(
                "invalid_request",
                "Bounded hosted validation requires an exact path.",
            ));
        }
        let started = Instant::now();
        let mut activity = HostedQueryActivityGuard::begin(self.query_activity.clone());
        let connection_wait_ms =
            mdbase::runtime::HostedQueryBudgets::default().max_connection_wait_ms;
        let mut connection = match tokio::time::timeout(
            Duration::from_millis(connection_wait_ms),
            self.pool.acquire(),
        )
        .await
        {
            Ok(connection) => connection?,
            Err(_) => {
                return Err(validation_budget(
                    "hosted_validation_connection_budget_exceeded",
                    "connection_wait_ms",
                    connection_wait_ms,
                    started.elapsed().as_millis() as u64,
                ));
            }
        };
        let mut transaction = connection.begin().await?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
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
        let session_fence = format!("mdbase-hosted-validation/{}", Uuid::new_v4());
        sqlx::query("SELECT set_config('application_name', $1, true)")
            .bind(&session_fence)
            .execute(&mut *transaction)
            .await?;
        let backend_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(&mut *transaction)
            .await?;
        let mut database_cancellation = PostgresQueryCancellationGuard::new(
            self.query_cancellation_pool.clone(),
            backend_pid,
            session_fence,
            None,
        );
        let collection = sqlx::query(
            r#"SELECT record_count, resource_revision, wrapped_data_key, resources_ciphertext,
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
        let record_count = number(collection.get::<i64, _>("record_count"), "record count")?;
        if record_count > VALIDATION_SCAN_RECORDS {
            return Err(validation_budget(
                "hosted_validation_scan_budget_exceeded",
                "record_scan",
                VALIDATION_SCAN_RECORDS,
                record_count,
            ));
        }
        let data_key = self
            .collection_key(collection_id, collection.get("wrapped_data_key"))
            .await?;
        activity.acquire_plaintext();
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
        if collection_only {
            transaction.commit().await?;
            database_cancellation.disarm();
            return Ok(OperationResult {
                valid: true,
                result: json!({"issues": []}),
                diagnostics: Vec::new(),
            });
        }
        let path = path.expect("non-collection validation path was checked above");
        let Some((target, _, target_modified_at)) = load_direct_record(
            &mut transaction,
            &self.crypto,
            &data_key,
            collection_id,
            DirectRecordIdentity::PathToken(path_token(&data_key, path)),
        )
        .await?
        else {
            transaction.commit().await?;
            database_cancellation.disarm();
            return Ok(mdbase::runtime::invalid_operation_result(
                "file_not_found",
                format!("File not found: {path}"),
            ));
        };
        if target.path != path {
            return Err(ApiError::internal(
                "The hosted encrypted record path does not match its lookup token.",
            ));
        }
        let target = canonical_validation_record(target, target_modified_at);
        let plan = catalog
            .plan_hosted_validation(input, &target)
            .map_err(|error| ApiError::bad_request(error.code, error.message))?;
        let generation_id = collection.get::<Option<Uuid>, _>("active_projection_generation_id");
        let active_catalog = collection.get::<Option<String>, _>("active_catalog_revision");
        let active_format = collection
            .get::<Option<i32>, _>("active_projection_format_version")
            .map(i64::from);
        let active_engine = collection.get::<Option<String>, _>("active_semantic_engine_version");
        let projection_binding_current = active_catalog.as_deref()
            == Some(catalog.resource_revision())
            && active_format
                == Some(i64::from(
                    mdbase::runtime::SEMANTIC_PROJECTION_FORMAT_VERSION,
                ))
            && active_engine.as_deref() == Some(mdbase::VERSION)
            && generation_id.is_some();

        let mut context = vec![target];
        let mut context_ids = BTreeSet::from([plan.target_stable_id.clone()]);
        let mut context_bytes = context[0].document.len() as u64;
        let mut fallback_bytes = 0_u64;
        let mut projection_bytes = 0_u64;
        let mut scanned = 0_u64;
        let mut exact_documents = 1_u64;
        let mut last_record_id = None;

        loop {
            if started.elapsed() > VALIDATION_TIME {
                return Err(validation_budget(
                    "hosted_validation_time_budget_exceeded",
                    "elapsed_ms",
                    VALIDATION_TIME.as_millis() as u64,
                    started.elapsed().as_millis() as u64,
                ));
            }
            let rows = sqlx::query(
                r#"SELECT r.record_id, r.sequence, r.revision,
                          p.record_sequence AS projection_record_sequence,
                          p.record_revision AS projection_record_revision,
                          p.catalog_revision AS projection_catalog_revision,
                          p.projection_format_version,
                          p.semantic_engine_version,
                          hosted_provider_projection_digest_valid(
                            p.projection_digest, p.projection_observed_digest)
                            AS projection_digest_valid,
                          p.semantic_complete, p.resolution_complete,
                          p.semantic_projection, p.projection_bytes
                   FROM hosted_provider_records r
                   LEFT JOIN hosted_provider_record_projections p
                     ON p.collection_id = r.collection_id
                    AND p.generation_id = $2 AND p.record_id = r.record_id
                    AND p.valid_to_sequence IS NULL
                   WHERE r.collection_id = $1
                     AND ($3::uuid IS NULL OR r.record_id > $3)
                   ORDER BY r.record_id
                   LIMIT $4"#,
            )
            .bind(collection_id)
            .bind(generation_id)
            .bind(last_record_id)
            .bind(VALIDATION_PAGE_SIZE)
            .fetch_all(&mut *transaction)
            .await?;
            if rows.is_empty() {
                break;
            }
            scanned = scanned.saturating_add(rows.len() as u64);
            if scanned > VALIDATION_SCAN_RECORDS {
                return Err(validation_budget(
                    "hosted_validation_scan_budget_exceeded",
                    "record_scan",
                    VALIDATION_SCAN_RECORDS,
                    scanned,
                ));
            }
            for row in &rows {
                let record_id: Uuid = row.get("record_id");
                last_record_id = Some(record_id);
                if record_id.to_string() == plan.target_stable_id {
                    continue;
                }
                let stored_projection_bytes = row
                    .get::<Option<i32>, _>("projection_bytes")
                    .and_then(|value| u64::try_from(value).ok())
                    .unwrap_or(0);
                projection_bytes = projection_bytes.saturating_add(stored_projection_bytes);
                if projection_bytes > VALIDATION_SCAN_PROJECTION_BYTES {
                    return Err(validation_budget(
                        "hosted_validation_projection_byte_budget_exceeded",
                        "projection_bytes",
                        VALIDATION_SCAN_PROJECTION_BYTES,
                        projection_bytes,
                    ));
                }
                let projection_current = projection_binding_current
                    && row.get::<Option<i64>, _>("projection_record_sequence")
                        == Some(row.get::<i64, _>("sequence"))
                    && row.get::<Option<String>, _>("projection_record_revision")
                        == Some(row.get::<String, _>("revision"))
                    && row.get::<Option<String>, _>("projection_catalog_revision")
                        == active_catalog
                    && row.get::<Option<i32>, _>("projection_format_version")
                        == active_format.and_then(|value| i32::try_from(value).ok())
                    && row.get::<Option<String>, _>("semantic_engine_version") == active_engine
                    && row.get::<Option<bool>, _>("projection_digest_valid") == Some(true)
                    && row.get::<Option<bool>, _>("semantic_complete") == Some(true)
                    && row.get::<Option<bool>, _>("resolution_complete") == Some(true);

                let mut exact = None;
                let facts = if projection_current {
                    let projection: mdbase::runtime::SemanticProjection = serde_json::from_value(
                        row.get::<Option<Value>, _>("semantic_projection")
                            .ok_or_else(|| ApiError::internal("A current projection is absent."))?,
                    )
                    .map_err(|error| {
                        ApiError::internal(format!(
                            "A current semantic projection could not decode: {error}"
                        ))
                    })?;
                    projection.facts
                } else {
                    let loaded = load_direct_record(
                        &mut transaction,
                        &self.crypto,
                        &data_key,
                        collection_id,
                        DirectRecordIdentity::StableId(record_id),
                    )
                    .await?
                    .ok_or_else(|| {
                        ApiError::conflict(
                            "hosted_validation_snapshot_changed",
                            "A validation record disappeared from its repeatable-read snapshot.",
                        )
                    })?;
                    exact_documents = exact_documents.saturating_add(1);
                    fallback_bytes = fallback_bytes.saturating_add(loaded.0.document.len() as u64);
                    if fallback_bytes > VALIDATION_FALLBACK_BYTES {
                        return Err(validation_budget(
                            "hosted_validation_fallback_byte_budget_exceeded",
                            "fallback_exact_bytes",
                            VALIDATION_FALLBACK_BYTES,
                            fallback_bytes,
                        ));
                    }
                    let canonical = canonical_validation_record(loaded.0, loaded.2);
                    let prepared = catalog.project_record(&canonical).map_err(|error| {
                        ApiError::internal(format!(
                            "Canonical validation fallback failed ({}): {}",
                            error.code, error.message
                        ))
                    })?;
                    exact = Some(canonical);
                    prepared.facts
                };
                let candidate = plan.facts_may_conflict(&facts)
                    || plan.resolution_lookups.iter().any(|lookup| {
                        facts
                            .resolution_keys
                            .iter()
                            .any(|key| key.kind == lookup.kind && key.value == lookup.value)
                    });
                if !candidate || !context_ids.insert(record_id.to_string()) {
                    continue;
                }
                let canonical = match exact {
                    Some(record) => record,
                    None => {
                        exact_documents = exact_documents.saturating_add(1);
                        let loaded = load_direct_record(
                                &mut transaction,
                                &self.crypto,
                                &data_key,
                                collection_id,
                                DirectRecordIdentity::StableId(record_id),
                            )
                            .await?
                            .ok_or_else(|| {
                                ApiError::conflict(
                                    "hosted_validation_snapshot_changed",
                                    "A validation candidate disappeared from its repeatable-read snapshot.",
                                )
                            })?;
                        canonical_validation_record(loaded.0, loaded.2)
                    }
                };
                context_bytes = context_bytes.saturating_add(canonical.document.len() as u64);
                if context.len() >= VALIDATION_EXACT_RECORDS
                    || context_bytes > VALIDATION_EXACT_BYTES
                {
                    return Err(validation_budget(
                        "hosted_validation_context_budget_exceeded",
                        "exact_context_bytes",
                        VALIDATION_EXACT_BYTES,
                        context_bytes,
                    ));
                }
                context.push(canonical);
            }
        }
        let result = catalog
            .execute_hosted_validation(&plan, &context)
            .map_err(|error| {
                if error.code.contains("budget_exceeded") {
                    validation_budget(&error.code, "canonical_context", 0, context.len() as u64)
                } else {
                    ApiError::internal(format!(
                        "Canonical hosted validation failed ({}): {}",
                        error.code, error.message
                    ))
                }
            })?;
        transaction.commit().await?;
        database_cancellation.disarm();
        tracing::info!(
            target: "mdbase_connect::metrics",
            metric = "hosted_direct_validation",
            scanned_records = scanned,
            projection_bytes,
            exact_documents,
            exact_context_records = context.len() as u64,
            exact_context_bytes = context_bytes,
            elapsed_ms = started.elapsed().as_millis() as u64,
            "privacy-safe hosted provider metric"
        );
        Ok(result)
    }
}

fn canonical_validation_record(
    record: PersistedRecord,
    modified_at: DateTime<Utc>,
) -> mdbase::runtime::CanonicalRecordInput {
    let document_size = record.document.len() as u64;
    mdbase::runtime::CanonicalRecordInput {
        stable_id: Some(record.record_id.to_string()),
        path: record.path,
        file_size: document_size,
        document: record.document,
        file_mtime: Some(modified_at.to_rfc3339_opts(SecondsFormat::Micros, true)),
    }
}

fn validation_budget(code: &str, budget: &str, limit: u64, observed: u64) -> ApiError {
    ApiError::quota(
        code,
        "The hosted validation exceeded a bounded execution budget.",
    )
    .with_details(json!({
        "budget": budget,
        "limit": limit,
        "observed": observed,
    }))
}
