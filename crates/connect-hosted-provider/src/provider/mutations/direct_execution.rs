const MAX_HOSTED_MUTATION_CONTEXT_RECORDS: usize = 2_000;
const MAX_HOSTED_MUTATION_CONTEXT_BYTES: u64 = 32 * 1024 * 1024;
// A second plan normally settles: once the conflicting records are staged the
// write is rejected. A third allows for generated values changing between plans.
const MAX_UNIQUENESS_PLAN_ATTEMPTS: usize = 3;

#[allow(clippy::too_many_arguments)]
async fn execute_direct_semantic(
    transaction: &mut Transaction<'_, Postgres>,
    provider: &HostedProvider,
    data_key: &[u8; 32],
    collection_id: Uuid,
    collection: &PgRow,
    primary_record_id: Uuid,
    operation: &str,
    input: serde_json::Map<String, Value>,
    current: Option<SyncRecord>,
) -> ApiResult<(crate::workspace::Execution, BTreeMap<Uuid, SyncRecord>)> {
    let resources: SyncCollectionResources = provider.crypto.decrypt_json(
        data_key,
        collection.get("resources_ciphertext"),
        &resources_aad(collection_id),
    )?;
    let resource_revision: String = collection.get("resource_revision");
    if resources.revision != resource_revision {
        return Err(ApiError::internal(
            "The encrypted resource catalog revision does not match collection metadata.",
        ));
    }
    let resource_documents =
        load_resource_documents(transaction, &provider.crypto, data_key, collection_id).await?;
    let catalog = compile_point_catalog(resources, resource_documents)?;

    let mut before_records = current
        .map(|record| BTreeMap::from([(record.record_id, record)]))
        .unwrap_or_default();
    let mut exact_context_bytes = before_records.values().try_fold(0_u64, |total, record| {
        total.checked_add(record.document.len() as u64)
    });
    if exact_context_bytes.is_none_or(|bytes| bytes > MAX_HOSTED_MUTATION_CONTEXT_BYTES) {
        return Err(hosted_mutation_context_byte_budget());
    }
    let needs_incoming_context =
        catalog.hosted_mutation_requires_incoming_context(operation, &Value::Object(input.clone()));
    if needs_incoming_context {
        let incoming_ids = if let Some(generation_id) =
            collection.get::<Option<Uuid>, _>("active_projection_generation_id")
        {
            let rows = sqlx::query(
                r#"SELECT DISTINCT source_record_id
                   FROM hosted_provider_record_relationships
                   WHERE collection_id = $1 AND generation_id = $2
                     AND target_record_id = $3
                     AND valid_to_sequence IS NULL
                     AND resolution_state = 'resolved'
                   ORDER BY source_record_id
                   LIMIT $4"#,
            )
            .bind(collection_id)
            .bind(generation_id)
            .bind(primary_record_id)
            .bind((MAX_HOSTED_MUTATION_CONTEXT_RECORDS + 1) as i64)
            .fetch_all(&mut **transaction)
            .await?;
            if rows.len() > MAX_HOSTED_MUTATION_CONTEXT_RECORDS {
                return Err(hosted_mutation_context_record_budget());
            }
            rows.into_iter()
                .map(|row| row.get::<Uuid, _>("source_record_id"))
                .collect::<Vec<_>>()
        } else {
            let target = primary_record_id.to_string();
            load_exact_mutation_projections(transaction, provider, data_key, collection_id, &catalog)
                .await?
                .into_iter()
                .filter(|(_, projection)| {
                    projection.structure.occurrences.iter().any(|occurrence| {
                        occurrence.target_record_id.as_deref() == Some(target.as_str())
                    })
                })
                .map(|(record_id, _)| record_id)
                .collect()
        };
        for source_record_id in incoming_ids {
            if source_record_id == primary_record_id
                || before_records.contains_key(&source_record_id)
            {
                continue;
            }
            let (record, _, _) = load_direct_record(
                transaction,
                &provider.crypto,
                data_key,
                collection_id,
                DirectRecordIdentity::StableId(source_record_id),
            )
            .await?
            .ok_or_else(|| {
                ApiError::conflict(
                    "hosted_projection_inconsistent",
                    "A projected incoming relationship has no current exact source record.",
                )
            })?;
            exact_context_bytes = exact_context_bytes
                .and_then(|total| total.checked_add(record.document.len() as u64));
            if exact_context_bytes.is_none_or(|bytes| bytes > MAX_HOSTED_MUTATION_CONTEXT_BYTES) {
                return Err(hosted_mutation_context_byte_budget());
            }
            before_records.insert(source_record_id, record);
        }
    }

    for record in before_records.values_mut() {
        let classified = classify_exact_sync_record(
            Some(&catalog),
            record.record_id,
            &record.path,
            &record.document,
        )?;
        record.frontmatter = classified.frontmatter;
        record.body = classified.body;
        record.types = classified.types;
        record.revision = classified.revision;
    }

    if matches!(operation, "create" | "rename") {
        let destination = input
            .get("path")
            .or_else(|| input.get("to"))
            .and_then(Value::as_str)
            .ok_or_else(|| {
                ApiError::bad_request(
                    "invalid_mutation",
                    "Hosted create or rename requires a destination path.",
                )
            })?;
        let destination_owner = sqlx::query_scalar::<_, Uuid>(
            "SELECT record_id FROM hosted_provider_records
             WHERE collection_id = $1 AND path_token = $2",
        )
        .bind(collection_id)
        .bind(path_token(data_key, destination))
        .fetch_optional(&mut **transaction)
        .await?;
        ensure_destination_available(destination_owner, primary_record_id)?;
    }

    let mut records = before_records
        .values()
        .map(canonical_mutation_record)
        .collect::<Vec<_>>();
    // A plan validated uniqueness and link existence only against the records
    // it was given. Stage every other record sharing one of its uniqueness keys
    // or answering one of its link lookups, and plan again until none is
    // missing; the final plan's verdict is then the collection's.
    let mut context_ids = before_records.keys().copied().collect::<BTreeSet<_>>();
    let mut exact_projections = None;
    let mut plan_attempts = 0;
    let plan = loop {
        plan_attempts += 1;
        let plan = catalog
            .plan_hosted_mutation_typed(&mdbase::runtime::HostedMutationRequest {
                operation: operation.to_string(),
                primary_stable_id: primary_record_id.to_string(),
                input: Value::Object(input.clone()),
                records: records.clone(),
            })
            .map_err(hosted_mutation_semantic_error)?;
        let missing = write_context_candidate_ids(
            transaction,
            provider,
            data_key,
            collection_id,
            collection,
            &catalog,
            &plan.context_requirements,
            &mut exact_projections,
        )
        .await?
        .into_iter()
        .filter(|record_id| !context_ids.contains(record_id))
        .collect::<Vec<_>>();
        if missing.is_empty() {
            break plan;
        }
        if plan_attempts == MAX_UNIQUENESS_PLAN_ATTEMPTS {
            return Err(ApiError::conflict(
                "hosted_write_context_unstable",
                "The records a write is validated against kept changing while it was planned.",
            ));
        }
        for record_id in missing {
            let (record, _, _) = load_direct_record(
                transaction,
                &provider.crypto,
                data_key,
                collection_id,
                DirectRecordIdentity::StableId(record_id),
            )
            .await?
            .ok_or_else(|| {
                ApiError::conflict(
                    "hosted_projection_inconsistent",
                    "A record a write is validated against has no current exact record.",
                )
            })?;
            exact_context_bytes = exact_context_bytes
                .and_then(|total| total.checked_add(record.document.len() as u64));
            if exact_context_bytes.is_none_or(|bytes| bytes > MAX_HOSTED_MUTATION_CONTEXT_BYTES) {
                return Err(hosted_mutation_context_byte_budget());
            }
            if records.len() >= MAX_HOSTED_MUTATION_CONTEXT_RECORDS {
                return Err(hosted_mutation_context_record_budget());
            }
            records.push(canonical_mutation_record(&record));
            context_ids.insert(record_id);
        }
    };
    verify_hosted_record_change_set(&plan.change_set, &plan.changes)?;
    let mut changed = Vec::with_capacity(plan.changes.len());
    for change in plan.changes {
        let record_id = Uuid::parse_str(&change.stable_id).map_err(|_| {
            ApiError::internal("Canonical hosted mutation returned a non-UUID stable identity.")
        })?;
        if let Some(record) = change.after {
            let document = record.document.ok_or_else(|| {
                ApiError::internal("Canonical hosted change omitted its exact resulting document.")
            })?;
            let revision = change
                .change
                .after_revision
                .as_ref()
                .map(ToString::to_string)
                .ok_or_else(|| ApiError::internal("Canonical hosted change omitted its resulting revision."))?;
            if record.path != change.change.path
                || record.revision.to_string() != revision
                || record.types.iter().map(String::as_str).collect::<Vec<_>>()
                    != change.change.after_types.iter().collect::<Vec<_>>()
                || record.file.size != document.len() as u64
            {
                return Err(ApiError::internal(
                    "Canonical hosted typed document disagrees with its exact change evidence.",
                ));
            }
            let frontmatter = record.frontmatter.as_object().cloned().ok_or_else(|| {
                ApiError::internal("Canonical hosted typed document has non-object frontmatter.")
            })?;
            let exact = SyncRecord {
                record_id,
                path: record.path.to_string(),
                revision,
                frontmatter,
                body: record.body,
                types: record.types,
                document: document.clone(),
            };
            changed.push((record_id, Some(exact), Some(document)));
        } else {
            changed.push((record_id, None, change.before_path));
        }
    }
    let envelope = plan.operation.to_v03();
    Ok((
        crate::workspace::Execution {
            operation: Some(plan.operation),
            envelope,
            primary_record_id,
            changed,
        },
        before_records,
    ))
}

fn hosted_mutation_context_record_budget() -> ApiError {
    ApiError::quota(
        "hosted_mutation_context_budget_exceeded",
        "Reference-aware mutation context exceeds its exact-record budget.",
    )
    .with_details(json!({
        "budget": "exact_context_records",
        "limit": MAX_HOSTED_MUTATION_CONTEXT_RECORDS,
    }))
}

fn canonical_mutation_record(record: &SyncRecord) -> mdbase::runtime::CanonicalRecordInput {
    mdbase::runtime::CanonicalRecordInput {
        stable_id: Some(record.record_id.to_string()),
        path: record.path.clone(),
        document: record.document.clone(),
        file_size: record.document.len() as u64,
        file_mtime: None,
    }
}

/// Records whose current projection shares one of the write's uniqueness keys
/// or answers one of its link lookups.
#[allow(clippy::too_many_arguments)]
async fn write_context_candidate_ids(
    transaction: &mut Transaction<'_, Postgres>,
    provider: &HostedProvider,
    data_key: &[u8; 32],
    collection_id: Uuid,
    collection: &PgRow,
    catalog: &mdbase::runtime::CompiledCatalog,
    requirements: &mdbase::runtime::HostedWriteContext,
    exact_projections: &mut Option<Vec<(Uuid, mdbase::runtime::SemanticProjection)>>,
) -> ApiResult<BTreeSet<Uuid>> {
    let mut candidates = BTreeSet::new();
    if requirements.uniqueness_keys.is_empty() && requirements.resolution_lookups.is_empty() {
        return Ok(candidates);
    }
    let limit = (MAX_HOSTED_MUTATION_CONTEXT_RECORDS + 1) as i64;
    if let Some(generation_id) = current_projection_generation(collection, catalog) {
        for key in &requirements.uniqueness_keys {
            candidates.extend(
                sqlx::query_scalar::<_, Uuid>(
                    r#"SELECT record_id FROM hosted_provider_record_projections
                       WHERE collection_id = $1 AND generation_id = $2
                         AND valid_to_sequence IS NULL
                         AND semantic_projection -> 'uniqueness_keys' @> $3
                       LIMIT $4"#,
                )
                .bind(collection_id)
                .bind(generation_id)
                .bind(json!([key]))
                .bind(limit)
                .fetch_all(&mut **transaction)
                .await?,
            );
        }
        if !requirements.resolution_lookups.is_empty() {
            candidates.extend(
                sqlx::query_scalar::<_, Uuid>(
                    r#"SELECT DISTINCT k.record_id
                       FROM jsonb_to_recordset($3::jsonb) AS q(kind text, value text)
                       JOIN hosted_provider_record_resolution_keys k
                         ON k.collection_id = $1 AND k.generation_id = $2
                        AND k.valid_to_sequence IS NULL
                        AND k.key_kind = q.kind AND k.lookup_key = q.value
                       LIMIT $4"#,
                )
                .bind(collection_id)
                .bind(generation_id)
                .bind(json!(requirements.resolution_lookups))
                .bind(limit)
                .fetch_all(&mut **transaction)
                .await?,
            );
        }
        return Ok(candidates);
    }
    if exact_projections.is_none() {
        // Beyond the exact budget only a rebuilt projection can answer; the
        // background rebuild that made it stale is already running.
        *exact_projections = Some(
            load_exact_mutation_projections(transaction, provider, data_key, collection_id, catalog)
                .await
                .map_err(|error| match error.code.as_str() {
                    "hosted_mutation_context_budget_exceeded"
                    | "hosted_mutation_context_byte_budget_exceeded" => ApiError::new(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "projection_index_incomplete",
                        "This write cannot be validated until the collection's projection finishes rebuilding. Retry shortly.",
                    ),
                    _ => error,
                })?,
        );
    }
    let projections = exact_projections
        .as_ref()
        .expect("exact projections were loaded above");
    candidates.extend(
        projections
            .iter()
            .filter(|(_, projection)| {
                let facts = &projection.facts;
                facts
                    .uniqueness_keys
                    .iter()
                    .any(|key| requirements.uniqueness_keys.contains(key))
                    || facts.resolution_keys.iter().any(|key| {
                        requirements
                            .resolution_lookups
                            .iter()
                            .any(|lookup| lookup.kind == key.kind && lookup.value == key.value)
                    })
            })
            .map(|(record_id, _)| *record_id),
    );
    Ok(candidates)
}

/// Projections of every current record, derived from exact records. Used only
/// while no current projection generation can answer a mutation's lookups.
async fn load_exact_mutation_projections(
    transaction: &mut Transaction<'_, Postgres>,
    provider: &HostedProvider,
    data_key: &[u8; 32],
    collection_id: Uuid,
    catalog: &mdbase::runtime::CompiledCatalog,
) -> ApiResult<Vec<(Uuid, mdbase::runtime::SemanticProjection)>> {
    let metadata = sqlx::query(
        r#"SELECT record_id, content_bytes
           FROM hosted_provider_records
           WHERE collection_id = $1
           ORDER BY record_id
           LIMIT $2"#,
    )
    .bind(collection_id)
    .bind((MAX_HOSTED_MUTATION_CONTEXT_RECORDS + 1) as i64)
    .fetch_all(&mut **transaction)
    .await?;
    if metadata.len() > MAX_HOSTED_MUTATION_CONTEXT_RECORDS {
        return Err(hosted_mutation_context_record_budget());
    }
    let plaintext_bytes = metadata.iter().try_fold(0_u64, |total, row| {
        let bytes = number(row.get::<i64, _>("content_bytes"), "record content bytes")?;
        total
            .checked_add(bytes)
            .ok_or_else(hosted_mutation_context_byte_budget)
    })?;
    if plaintext_bytes > MAX_HOSTED_MUTATION_CONTEXT_BYTES {
        return Err(hosted_mutation_context_byte_budget());
    }
    let record_ids = metadata
        .into_iter()
        .map(|row| row.get::<Uuid, _>("record_id"))
        .collect::<Vec<_>>();
    let rows = sqlx::query(
        r#"SELECT record_id, sequence, revision, payload_ciphertext, updated_at
           FROM hosted_provider_records
           WHERE collection_id = $1 AND record_id = ANY($2::uuid[])
           ORDER BY record_id"#,
    )
    .bind(collection_id)
    .bind(&record_ids)
    .fetch_all(&mut **transaction)
    .await?;
    if rows.len() != record_ids.len() {
        return Err(ApiError::conflict(
            "hosted_exact_snapshot_inconsistent",
            "The bounded mutation fallback could not load its complete exact snapshot.",
        ));
    }
    let mut prepared = Vec::with_capacity(rows.len());
    for row in rows {
        let record_id: Uuid = row.get("record_id");
        let sequence = number(row.get::<i64, _>("sequence"), "record sequence")?;
        let record: PersistedRecord = provider.crypto.decrypt_json(
            data_key,
            row.get("payload_ciphertext"),
            &current_record_aad(collection_id, record_id, sequence),
        )?;
        if record.record_id != record_id || record.revision != row.get::<String, _>("revision") {
            return Err(ApiError::internal(
                "The bounded mutation fallback exact record is inconsistent.",
            ));
        }
        let input = mdbase::runtime::CanonicalRecordInput {
            stable_id: Some(record_id.to_string()),
            path: record.path.clone(),
            file_size: record.document.len() as u64,
            file_mtime: Some(
                row.get::<DateTime<Utc>, _>("updated_at")
                    .to_rfc3339_opts(SecondsFormat::Micros, true),
            ),
            document: record.document.clone(),
        };
        prepared.push((
            record_id.to_string(),
            catalog
                .project_record(&input)
                .map_err(mutation_projection_semantic_error)?,
        ));
    }
    catalog
        .finalize_projection_batch(prepared)
        .map_err(mutation_projection_semantic_error)?
        .into_iter()
        .map(|(source, projection)| {
            Uuid::parse_str(&source)
                .map(|record_id| (record_id, projection))
                .map_err(|_| ApiError::internal("A canonical projection lost its record UUID."))
        })
        .collect()
}

fn mutation_projection_semantic_error(error: mdbase::runtime::CatalogError) -> ApiError {
    ApiError::conflict(
        "hosted_projection_inconsistent",
        "The bounded mutation fallback could not derive canonical relationship state.",
    )
    .with_details(json!({"semantic_code": error.code}))
}

fn hosted_mutation_semantic_error(error: mdbase::runtime::CatalogError) -> ApiError {
    match error.code.as_str() {
        "hosted_mutation_context_budget_exceeded"
        | "hosted_mutation_context_byte_budget_exceeded" => {
            ApiError::quota(error.code, error.message)
        }
        "hosted_mutation_stage_failed" | "hosted_mutation_plan_incomplete" => {
            ApiError::internal(error.message)
        }
        _ => ApiError::bad_request(error.code, error.message),
    }
}

fn hosted_mutation_context_byte_budget() -> ApiError {
    ApiError::quota(
        "hosted_mutation_context_byte_budget_exceeded",
        "Reference-aware mutation context exceeds its exact-byte budget.",
    )
    .with_details(json!({
        "budget": "exact_context_bytes",
        "limit": MAX_HOSTED_MUTATION_CONTEXT_BYTES,
    }))
}

fn execute_direct_sync(
    catalog: Option<&mdbase::runtime::CompiledCatalog>,
    mutation: &SyncMutation,
    current: Option<&SyncRecord>,
    destination_owner: Option<Uuid>,
) -> ApiResult<crate::workspace::Execution> {
    let changed = match mutation.operation {
        SyncMutationOperation::Put => {
            let path = mutation.path.as_deref().ok_or_else(|| {
                ApiError::bad_request("invalid_mutation", "Put mutation path is required.")
            })?;
            let document = mutation.document.as_deref().ok_or_else(|| {
                ApiError::bad_request("invalid_mutation", "Put mutation document is required.")
            })?;
            if current.is_some_and(|record| record.path != path) {
                return Err(ApiError::bad_request(
                    "put_path_mismatch",
                    "Move a record separately before replacing its document.",
                ));
            }
            ensure_destination_available(destination_owner, mutation.record_id)?;
            let classified =
                classify_exact_sync_record(catalog, mutation.record_id, path, document)?;
            vec![(
                mutation.record_id,
                Some(classified),
                Some(document.to_string()),
            )]
        }
        SyncMutationOperation::Move => {
            let current = current.ok_or_else(|| {
                ApiError::not_found("record_not_found", "The hosted record does not exist.")
            })?;
            let path = mutation.path.as_deref().ok_or_else(|| {
                ApiError::bad_request("invalid_mutation", "Move mutation path is required.")
            })?;
            ensure_destination_available(destination_owner, mutation.record_id)?;
            let classified =
                classify_exact_sync_record(catalog, mutation.record_id, path, &current.document)?;
            vec![(
                mutation.record_id,
                Some(classified),
                Some(current.document.clone()),
            )]
        }
        SyncMutationOperation::Delete => {
            let current = current.ok_or_else(|| {
                ApiError::not_found("record_not_found", "The hosted record does not exist.")
            })?;
            vec![(mutation.record_id, None, Some(current.path.clone()))]
        }
    };
    Ok(crate::workspace::Execution {
        operation: None,
        envelope: OperationResult {
            valid: true,
            result: json!({}),
            diagnostics: Vec::new(),
        },
        primary_record_id: mutation.record_id,
        changed,
    })
}

fn ensure_destination_available(owner: Option<Uuid>, record_id: Uuid) -> ApiResult<()> {
    if owner.is_some_and(|owner| owner != record_id) {
        return Err(ApiError::conflict(
            "record_path_conflict",
            "Another hosted record already uses the destination path.",
        ));
    }
    Ok(())
}

pub(super) fn classify_exact_sync_record(
    catalog: Option<&mdbase::runtime::CompiledCatalog>,
    record_id: Uuid,
    path: &str,
    document: &str,
) -> ApiResult<SyncRecord> {
    let catalog = catalog.ok_or_else(|| {
        ApiError::internal("Exact sync classification requires the pinned resource catalog.")
    })?;
    let classified = catalog
        .classify_record(&mdbase::runtime::CanonicalRecordInput {
            stable_id: Some(record_id.to_string()),
            path: path.to_string(),
            document: document.to_string(),
            file_size: document.len() as u64,
            file_mtime: None,
        })
        .map_err(|error| ApiError::bad_request(error.code, error.message))?;
    if classified.path != path {
        return Err(ApiError::bad_request(
            "invalid_path",
            "Hosted record paths must use their canonical forward-slash representation.",
        ));
    }
    Ok(SyncRecord {
        record_id,
        path: classified.path,
        revision: classified.revision,
        frontmatter: classified.frontmatter,
        body: classified.body,
        types: classified.types,
        document: classified.document,
    })
}

fn sync_receipt_from_value(value: Value) -> ApiResult<SyncMutationReceipt> {
    serde_json::from_value(value).map_err(|error| {
        ApiError::internal(format!("Stored sync mutation receipt is invalid: {error}"))
    })
}
