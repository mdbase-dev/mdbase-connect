const MAX_HOSTED_MUTATION_CONTEXT_RECORDS: usize = 2_000;
const MAX_HOSTED_MUTATION_CONTEXT_BYTES: u64 = 32 * 1024 * 1024;

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
        let generation_id = collection
            .get::<Option<Uuid>, _>("active_projection_generation_id")
            .ok_or_else(|| {
                ApiError::conflict(
                    "hosted_projection_unavailable",
                    "Reference-aware mutations require a current semantic projection.",
                )
            })?;
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
            return Err(ApiError::quota(
                "hosted_mutation_context_budget_exceeded",
                "Reference-aware mutation context exceeds its exact-record budget.",
            )
            .with_details(json!({
                "budget": "exact_context_records",
                "limit": MAX_HOSTED_MUTATION_CONTEXT_RECORDS,
            })));
        }
        for row in rows {
            let source_record_id: Uuid = row.get("source_record_id");
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

    let records = before_records
        .values()
        .map(|record| mdbase::runtime::CanonicalRecordInput {
            stable_id: Some(record.record_id.to_string()),
            path: record.path.clone(),
            document: record.document.clone(),
            file_size: record.document.len() as u64,
            file_mtime: None,
        })
        .collect();
    let plan = catalog
        .plan_hosted_mutation(&mdbase::runtime::HostedMutationRequest {
            operation: operation.to_string(),
            primary_stable_id: primary_record_id.to_string(),
            input: Value::Object(input),
            records,
        })
        .map_err(hosted_mutation_semantic_error)?;
    let mut changed = Vec::with_capacity(plan.changes.len());
    for change in plan.changes {
        let record_id = Uuid::parse_str(&change.stable_id).map_err(|_| {
            ApiError::internal("Canonical hosted mutation returned a non-UUID stable identity.")
        })?;
        if let Some(record) = change.record {
            let classified = classify_exact_sync_record(
                Some(&catalog),
                record_id,
                &record.path,
                &record.document,
            )?;
            changed.push((record_id, Some(classified), Some(record.document)));
        } else {
            changed.push((record_id, None, change.before_path));
        }
    }
    Ok((
        crate::workspace::Execution {
            envelope: plan.result,
            primary_record_id,
            changed,
        },
        before_records,
    ))
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

fn classify_exact_sync_record(
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
