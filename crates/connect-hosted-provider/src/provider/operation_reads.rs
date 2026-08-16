use super::*;

const MAX_HOSTED_RESOURCE_RECORDS: usize = 2_000;
const MAX_HOSTED_RESOURCE_RECORD_BYTES: u64 = 32 * 1024 * 1024;

impl HostedProvider {
    pub(super) async fn describe_operation(
        &self,
        collection_id: Uuid,
        replica: &Replica,
    ) -> ApiResult<Value> {
        let row = sqlx::query(
            r#"SELECT head, display_name, wrapped_data_key, resources_ciphertext
               FROM hosted_provider_collections WHERE id = $1 AND state = 'active'"#,
        )
        .bind(collection_id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| {
            ApiError::not_found(
                "hosted_collection_not_found",
                "Hosted collection not found.",
            )
        })?;
        let data_key = self
            .collection_key(collection_id, row.get("wrapped_data_key"))
            .await?;
        let resources: SyncCollectionResources = self.crypto.decrypt_json(
            &data_key,
            row.get("resources_ciphertext"),
            &resources_aad(collection_id),
        )?;
        let resources = scoped_resources(resources, &replica.allowed_types);
        let description = CollectionDescription {
            protocol_version: CONTROL_PROTOCOL_VERSION,
            collection_id,
            display_name: row.get("display_name"),
            spec_version: resources.spec_version,
            operations: replica.allowed_operations.clone(),
            change_cursor: number(row.get::<i64, _>("head"), "collection head")?,
            types: resources.types,
            contracts: resources.contracts,
            configuration: None,
        };
        serde_json::to_value(description).map_err(|error| {
            ApiError::internal(format!("Hosted description could not serialize: {error}"))
        })
    }

    pub(super) async fn changes_operation(
        &self,
        collection_id: Uuid,
        replica: &Replica,
        input: &Value,
    ) -> ApiResult<Value> {
        let collection = sqlx::query(
            r#"SELECT head, retained_after, wrapped_data_key
               FROM hosted_provider_collections WHERE id = $1 AND state = 'active'"#,
        )
        .bind(collection_id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| {
            ApiError::not_found(
                "hosted_collection_not_found",
                "Hosted collection not found.",
            )
        })?;
        let head = number(collection.get::<i64, _>("head"), "collection head")?;
        let retained_after = number(
            collection.get::<i64, _>("retained_after"),
            "retained cursor",
        )?;
        let Some(after) = input.get("after").and_then(Value::as_u64) else {
            return serde_json::to_value(CollectionChangesPage {
                events: Vec::new(),
                cursor: head,
                has_more: false,
                reset: false,
            })
            .map_err(|error| {
                ApiError::internal(format!("Hosted changes could not serialize: {error}"))
            });
        };
        if after > head {
            return Err(ApiError::bad_request(
                "invalid_cursor",
                "Change cursor is ahead of the hosted collection.",
            ));
        }
        if after < retained_after {
            return serde_json::to_value(CollectionChangesPage {
                events: Vec::new(),
                cursor: head,
                has_more: false,
                reset: true,
            })
            .map_err(|error| {
                ApiError::internal(format!("Hosted changes could not serialize: {error}"))
            });
        }
        let limit = input
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(100)
            .clamp(1, 500);
        let record_rows = sqlx::query(
            r#"SELECT sequence, before_ciphertext, after_ciphertext, created_at::text AS occurred_at
               FROM hosted_provider_changes
               WHERE collection_id = $1 AND sequence > $2
                 AND (cardinality($3::text[]) = 0
                      OR before_types && $3::text[] OR after_types && $3::text[])
               ORDER BY sequence LIMIT $4"#,
        )
        .bind(collection_id)
        .bind(to_i64(after, "change cursor")?)
        .bind(&replica.allowed_types)
        .bind(to_i64(limit + 1, "change page limit")?)
        .fetch_all(&self.pool)
        .await?;
        let resource_rows = sqlx::query(
            r#"SELECT sequence, resource_kind, type_name, path, revision, created_at::text AS occurred_at
               FROM hosted_provider_resource_changes
               WHERE collection_id = $1 AND sequence > $2
                 AND (cardinality($3::text[]) = 0 OR type_name = ANY($3::text[]))
               ORDER BY sequence LIMIT $4"#,
        )
        .bind(collection_id)
        .bind(to_i64(after, "change cursor")?)
        .bind(&replica.allowed_types)
        .bind(to_i64(limit + 1, "change page limit")?)
        .fetch_all(&self.pool)
        .await?;
        let mut has_more =
            record_rows.len() > limit as usize || resource_rows.len() > limit as usize;
        let data_key = self
            .collection_key(collection_id, collection.get("wrapped_data_key"))
            .await?;
        let mut events = Vec::new();
        for row in record_rows {
            let sequence = number(row.get::<i64, _>("sequence"), "change sequence")?;
            let before = optional_encrypted_record(
                &self.crypto,
                &data_key,
                row.get("before_ciphertext"),
                &change_record_aad(collection_id, sequence, "before"),
            )?;
            let after_record = optional_encrypted_record(
                &self.crypto,
                &data_key,
                row.get("after_ciphertext"),
                &change_record_aad(collection_id, sequence, "after"),
            )?;
            if !before
                .as_ref()
                .is_some_and(|record| visible(record, &replica.allowed_types))
                && !after_record
                    .as_ref()
                    .is_some_and(|record| visible(record, &replica.allowed_types))
            {
                continue;
            }
            let (event_type, payload) = application_change(before.as_ref(), after_record.as_ref());
            events.push(CollectionChange {
                cursor: sequence,
                event_type: event_type.to_string(),
                occurred_at: row.get("occurred_at"),
                payload,
            });
        }
        for row in resource_rows {
            let kind: String = row.get("resource_kind");
            events.push(CollectionChange {
                cursor: number(row.get::<i64, _>("sequence"), "resource change sequence")?,
                event_type: if kind == "view" {
                    "mdbase.view_source.changed".to_string()
                } else {
                    "mdbase.type.changed".to_string()
                },
                occurred_at: row.get("occurred_at"),
                payload: json!({
                    "name": row.get::<Option<String>, _>("type_name"),
                    "path": row.get::<String, _>("path"),
                    "revision": row.get::<String, _>("revision"),
                }),
            });
        }
        events.sort_by_key(|event| event.cursor);
        if events.len() > limit as usize {
            events.truncate(limit as usize);
            has_more = true;
        }
        let cursor = events.last().map(|event| event.cursor).unwrap_or_else(|| {
            if has_more {
                after
            } else {
                head
            }
        });
        serde_json::to_value(CollectionChangesPage {
            events,
            cursor,
            has_more,
            reset: false,
        })
        .map_err(|error| ApiError::internal(format!("Hosted changes could not serialize: {error}")))
    }

    pub(super) async fn execute_read_operation(
        &self,
        collection_id: Uuid,
        operation: &str,
        input: &Value,
    ) -> ApiResult<OperationResult> {
        if operation == "read" {
            return self.execute_direct_point_read(collection_id, input).await;
        }
        if operation == "validate" {
            let bounded_shape = input.get("path").and_then(Value::as_str).is_some()
                || input.get("collection_only").and_then(Value::as_bool) == Some(true);
            if bounded_shape || self.candidate_b_execution_enabled(collection_id).await? {
                return self.execute_direct_validation(collection_id, input).await;
            }
        }
        if matches!(operation, "read_type" | "list_views" | "read_view_source") {
            return self
                .execute_direct_resource_read(collection_id, operation, input)
                .await;
        }
        if matches!(operation, "assess_type_pack" | "assess_collection_setup")
            && self.candidate_b_execution_enabled(collection_id).await?
        {
            return self
                .execute_direct_definition_assessment(collection_id, operation, input)
                .await;
        }
        let snapshot_started = Instant::now();
        let mut transaction = self.pool.begin().await?;
        let collection = sqlx::query(
            r#"SELECT head, wrapped_data_key FROM hosted_provider_collections
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
        let head = number(collection.get::<i64, _>("head"), "collection head")?;
        let data_key = self
            .collection_key(collection_id, collection.get("wrapped_data_key"))
            .await?;
        let working_set = self.working_set(collection_id).await?;
        let mut cached = working_set.lock().await;
        if cached
            .as_ref()
            .is_none_or(|working_set| working_set.head != Some(head))
        {
            let resources =
                load_resource_documents(&mut transaction, &self.crypto, &data_key, collection_id)
                    .await?;
            let records =
                load_records(&mut transaction, &self.crypto, &data_key, collection_id).await?;
            let workspace = WorkingSet::materialize(
                resources,
                records.values().map(|record| StoredDocument {
                    record_id: record.record_id,
                    path: record.path.clone(),
                    document: record.document.clone(),
                }),
            )?;
            *cached = Some(CachedCollection::new(Some(head), workspace, records));
        }
        let cached = cached
            .as_mut()
            .expect("hosted working set was initialized above");
        let result = cached.workspace.read_operation(operation, input)?;
        transaction.commit().await?;
        let memory = crate::HostedProcessMemory::capture();
        tracing::info!(
            target: "mdbase_connect::metrics",
            metric = "hosted_legacy_read",
            operation,
            snapshot_ms = snapshot_started.elapsed().as_millis() as u64,
            database_pool_size = self.pool.size(),
            database_pool_idle = self.pool.num_idle(),
            working_set_plaintext_bytes = cached.plaintext_bytes,
            rss_bytes = memory.rss_bytes.unwrap_or(0),
            pss_bytes = memory.pss_bytes.unwrap_or(0),
            cgroup_current_bytes = memory.cgroup_current_bytes.unwrap_or(0),
            cgroup_peak_bytes = memory.cgroup_peak_bytes.unwrap_or(0),
            "privacy-safe hosted provider metric"
        );
        Ok(result)
    }

    async fn execute_direct_point_read(
        &self,
        collection_id: Uuid,
        input: &Value,
    ) -> ApiResult<OperationResult> {
        self.execute_direct_point_read_for_identity(collection_id, input, None)
            .await
    }

    async fn execute_direct_resource_read(
        &self,
        collection_id: Uuid,
        operation: &str,
        input: &Value,
    ) -> ApiResult<OperationResult> {
        let started = Instant::now();
        let mut transaction = self.pool.begin().await?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            .execute(&mut *transaction)
            .await?;
        sqlx::query("SET LOCAL statement_timeout = 15000")
            .execute(&mut *transaction)
            .await?;
        let collection = sqlx::query(
            r#"SELECT resource_revision, wrapped_data_key, resources_ciphertext,
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
        if resources.revision != collection.get::<String, _>("resource_revision") {
            return Err(ApiError::internal(
                "The encrypted resource catalog revision does not match collection metadata.",
            ));
        }
        let mut resource_documents =
            load_resource_documents(&mut transaction, &self.crypto, &data_key, collection_id)
                .await?;
        let catalog = compile_point_catalog(resources, resource_documents.clone())?;
        if matches!(operation, "list_views" | "read_view_source") {
            resource_documents.extend(
                load_exact_view_documents(
                    &mut transaction,
                    &self.crypto,
                    &data_key,
                    collection_id,
                    &collection,
                    &catalog,
                    operation,
                    input,
                )
                .await?,
            );
        }
        let result = catalog
            .execute_hosted_resource_read(operation, input, &resource_documents)
            .map_err(|error| {
                if error.code.contains("budget_exceeded") {
                    ApiError::quota(error.code, error.message)
                } else {
                    ApiError::internal(format!(
                        "Canonical hosted resource read failed ({}): {}",
                        error.code, error.message
                    ))
                }
            })?;
        transaction.commit().await?;
        tracing::info!(
            target: "mdbase_connect::metrics",
            metric = "hosted_direct_resource_read",
            operation,
            resource_documents = resource_documents.len() as u64,
            resource_bytes = resource_documents
                .iter()
                .map(|(_, document)| document.len() as u64)
                .sum::<u64>(),
            elapsed_ms = started.elapsed().as_millis() as u64,
            "privacy-safe hosted provider metric"
        );
        Ok(result)
    }

    async fn execute_direct_definition_assessment(
        &self,
        collection_id: Uuid,
        operation: &str,
        input: &Value,
    ) -> ApiResult<OperationResult> {
        let started = Instant::now();
        let mut transaction = self.pool.begin().await?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            .execute(&mut *transaction)
            .await?;
        sqlx::query("SET LOCAL statement_timeout = 15000")
            .execute(&mut *transaction)
            .await?;
        let collection = sqlx::query(
            r#"SELECT resource_revision, wrapped_data_key, resources_ciphertext
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
        if resources.revision != collection.get::<String, _>("resource_revision") {
            return Err(ApiError::internal(
                "The encrypted resource catalog revision does not match collection metadata.",
            ));
        }
        let resource_documents =
            load_resource_documents(&mut transaction, &self.crypto, &data_key, collection_id)
                .await?;
        let catalog = compile_point_catalog(resources, resource_documents.clone())?;
        let plan = match operation {
            "assess_type_pack" => {
                let request = serde_json::from_value::<AssessTypePackInput>(input.clone())
                    .map_err(|error| {
                        ApiError::bad_request(
                            "invalid_type_pack",
                            format!("The type-pack assessment is invalid: {error}"),
                        )
                    })?;
                let provision = engine_type_pack_provision(&request.provision)?;
                let options = mdbase::v03::TypePackAssessmentOptions {
                    installed_by: request.installed_by,
                    adopt_resources: request.adopt_resources,
                    preserve_seed_targets: request.preserve_seed_targets,
                    target_overrides: request.target_overrides,
                    contract_setups: request
                        .contract_setups
                        .iter()
                        .map(engine_contract_setup)
                        .collect(),
                };
                catalog.plan_hosted_definition_operation(
                    HostedDefinitionOperation::AssessTypePack {
                        provision: &provision,
                        options: &options,
                    },
                    &resource_documents,
                )
            }
            "assess_collection_setup" => {
                let request = serde_json::from_value::<AssessCollectionSetupInput>(input.clone())
                    .map_err(|error| {
                    ApiError::bad_request(
                        "invalid_collection_setup",
                        format!("The collection-setup assessment is invalid: {error}"),
                    )
                })?;
                let setup = engine_collection_setup(&request)?;
                catalog.plan_hosted_definition_operation(
                    HostedDefinitionOperation::AssessCollectionSetup { setup: &setup },
                    &resource_documents,
                )
            }
            _ => unreachable!("definition assessment is closed above"),
        }
        .map_err(|error| {
            if error.code.contains("budget_exceeded") {
                ApiError::quota(error.code, error.message)
            } else {
                ApiError::internal(format!(
                    "Canonical hosted definition assessment failed ({}): {}",
                    error.code, error.message
                ))
            }
        })?;
        transaction.commit().await?;
        tracing::info!(
            target: "mdbase_connect::metrics",
            metric = "hosted_direct_definition_assessment",
            operation,
            resource_documents = resource_documents.len() as u64,
            elapsed_ms = started.elapsed().as_millis() as u64,
            "privacy-safe hosted provider metric"
        );
        Ok(plan.result)
    }

    pub(super) async fn execute_direct_point_read_by_id(
        &self,
        collection_id: Uuid,
        record_id: Uuid,
        input: &Value,
    ) -> ApiResult<OperationResult> {
        self.execute_direct_point_read_for_identity(collection_id, input, Some(record_id))
            .await
    }

    async fn execute_direct_point_read_for_identity(
        &self,
        collection_id: Uuid,
        input: &Value,
        stable_id: Option<Uuid>,
    ) -> ApiResult<OperationResult> {
        let started = Instant::now();
        let mut transaction = self.pool.begin().await?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            .execute(&mut *transaction)
            .await?;
        let collection = sqlx::query(
            r#"SELECT head, resource_revision, wrapped_data_key, resources_ciphertext
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
        let path = input.get("path").and_then(Value::as_str);
        let identity = stable_id.map(DirectRecordIdentity::StableId).or_else(|| {
            path.map(|path| DirectRecordIdentity::PathToken(path_token(&data_key, path)))
        });
        let lookup_kind = if stable_id.is_some() {
            "stable_id"
        } else {
            "path_token"
        };
        let (result, records_fetched, ciphertext_bytes) = if let Some(identity) = identity {
            match load_direct_record(
                &mut transaction,
                &self.crypto,
                &data_key,
                collection_id,
                identity,
            )
            .await?
            {
                Some((record, ciphertext_bytes, modified_at)) => {
                    if path.is_some_and(|path| record.path != path) {
                        return Err(ApiError::internal(
                            "The hosted encrypted record path does not match the requested identity.",
                        ));
                    }
                    let canonical = mdbase::runtime::CanonicalRecordInput {
                        stable_id: Some(record.record_id.to_string()),
                        path: record.path.clone(),
                        document: record.document.clone(),
                        file_size: record.document.len() as u64,
                        file_mtime: Some(modified_at.to_rfc3339_opts(SecondsFormat::Micros, true)),
                    };
                    (
                        catalog.read_record(input, &canonical),
                        1_u64,
                        ciphertext_bytes,
                    )
                }
                None => (catalog.read_record_not_found(input), 0, 0),
            }
        } else {
            (catalog.read_record_not_found(input), 0, 0)
        };
        transaction.commit().await?;
        let memory = crate::HostedProcessMemory::capture();
        tracing::info!(
            target: "mdbase_connect::metrics",
            metric = "hosted_direct_point_read",
            lookup_kind,
            records_fetched,
            records_decrypted = records_fetched,
            ciphertext_bytes,
            snapshot_ms = started.elapsed().as_millis() as u64,
            database_pool_size = self.pool.size(),
            database_pool_idle = self.pool.num_idle(),
            rss_bytes = memory.rss_bytes.unwrap_or(0),
            pss_bytes = memory.pss_bytes.unwrap_or(0),
            cgroup_current_bytes = memory.cgroup_current_bytes.unwrap_or(0),
            cgroup_peak_bytes = memory.cgroup_peak_bytes.unwrap_or(0),
            "privacy-safe hosted provider metric"
        );
        Ok(result)
    }
}

#[allow(clippy::too_many_arguments)]
async fn load_exact_view_documents(
    transaction: &mut Transaction<'_, Postgres>,
    crypto: &ProviderCrypto,
    data_key: &[u8; 32],
    collection_id: Uuid,
    collection: &PgRow,
    catalog: &mdbase::runtime::CompiledCatalog,
    operation: &str,
    input: &Value,
) -> ApiResult<Vec<(String, String)>> {
    let metadata = if operation == "read_view_source" {
        let path = input.get("path").and_then(Value::as_str).ok_or_else(|| {
            ApiError::bad_request(
                "invalid_view_path",
                "Reading a saved-view source requires a path.",
            )
        })?;
        sqlx::query(
            r#"SELECT record_id, content_bytes
               FROM hosted_provider_records
               WHERE collection_id = $1 AND path_token = $2"#,
        )
        .bind(collection_id)
        .bind(path_token(data_key, path))
        .fetch_all(&mut **transaction)
        .await?
    } else {
        sqlx::query(
            r#"WITH candidates AS (
                 SELECT r.record_id, r.content_bytes, p.matched_types,
                        p.record_id IS NOT NULL
                        AND p.record_sequence = r.sequence
                        AND p.record_revision = r.revision
                        AND p.catalog_revision = $3
                        AND p.projection_format_version = $4
                        AND p.semantic_engine_version = $5
                        AND hosted_provider_projection_digest_valid(
                          p.projection_digest, p.projection_observed_digest)
                        AND p.semantic_complete AND p.resolution_complete
                          AS projection_current
                 FROM hosted_provider_records r
                 LEFT JOIN hosted_provider_record_projections p
                   ON p.collection_id = r.collection_id
                  AND p.generation_id = $2
                  AND p.record_id = r.record_id
                  AND p.valid_to_sequence IS NULL
                 WHERE r.collection_id = $1
               )
               SELECT record_id, content_bytes
               FROM candidates
               WHERE NOT projection_current OR 'view' = ANY(matched_types)
               ORDER BY record_id
               LIMIT $6"#,
        )
        .bind(collection_id)
        .bind(collection.get::<Option<Uuid>, _>("active_projection_generation_id"))
        .bind(catalog.resource_revision())
        .bind(i64::from(
            mdbase::runtime::SEMANTIC_PROJECTION_FORMAT_VERSION,
        ))
        .bind(mdbase::VERSION)
        .bind((MAX_HOSTED_RESOURCE_RECORDS + 1) as i64)
        .fetch_all(&mut **transaction)
        .await?
    };
    if metadata.len() > MAX_HOSTED_RESOURCE_RECORDS {
        return Err(ApiError::quota(
            "hosted_resource_count_budget_exceeded",
            "The saved-view read exceeds its exact fallback record budget.",
        ));
    }
    let bytes = metadata.iter().try_fold(0_u64, |total, row| {
        let bytes = number(row.get::<i64, _>("content_bytes"), "record content bytes")?;
        total.checked_add(bytes).ok_or_else(|| {
            ApiError::quota(
                "hosted_resource_byte_budget_exceeded",
                "The saved-view read exceeds its exact fallback byte budget.",
            )
        })
    })?;
    if bytes > MAX_HOSTED_RESOURCE_RECORD_BYTES {
        return Err(ApiError::quota(
            "hosted_resource_byte_budget_exceeded",
            "The saved-view read exceeds its exact fallback byte budget.",
        ));
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
            "The saved-view fallback could not load its complete exact candidate set.",
        ));
    }
    let mut views = Vec::new();
    for row in rows {
        let record_id: Uuid = row.get("record_id");
        let sequence = number(row.get::<i64, _>("sequence"), "record sequence")?;
        let record: PersistedRecord = crypto.decrypt_json(
            data_key,
            row.get("payload_ciphertext"),
            &current_record_aad(collection_id, record_id, sequence),
        )?;
        if record.record_id != record_id || record.revision != row.get::<String, _>("revision") {
            return Err(ApiError::internal(
                "The saved-view fallback exact record is inconsistent.",
            ));
        }
        let projection = catalog
            .project_record(&mdbase::runtime::CanonicalRecordInput {
                stable_id: Some(record_id.to_string()),
                path: record.path.clone(),
                document: record.document.clone(),
                file_size: record.document.len() as u64,
                file_mtime: Some(
                    row.get::<DateTime<Utc>, _>("updated_at")
                        .to_rfc3339_opts(SecondsFormat::Micros, true),
                ),
            })
            .map_err(|error| {
                ApiError::conflict(
                    "hosted_projection_inconsistent",
                    "The saved-view fallback could not classify an exact record.",
                )
                .with_details(json!({"semantic_code": error.code}))
            })?;
        if record.path.ends_with(".base")
            || projection
                .facts
                .types
                .iter()
                .any(|name| name.eq_ignore_ascii_case("view"))
        {
            views.push((record.path, record.document));
        }
    }
    Ok(views)
}

pub(super) enum DirectRecordIdentity {
    StableId(Uuid),
    PathToken(Vec<u8>),
}

pub(super) async fn load_direct_record(
    transaction: &mut Transaction<'_, Postgres>,
    crypto: &ProviderCrypto,
    data_key: &[u8; 32],
    collection_id: Uuid,
    identity: DirectRecordIdentity,
) -> ApiResult<Option<(PersistedRecord, u64, DateTime<Utc>)>> {
    let row = match identity {
        DirectRecordIdentity::StableId(record_id) => {
            sqlx::query(
                r#"SELECT record_id, sequence, payload_ciphertext, updated_at
                   FROM hosted_provider_records
                   WHERE collection_id = $1 AND record_id = $2"#,
            )
            .bind(collection_id)
            .bind(record_id)
            .fetch_optional(&mut **transaction)
            .await?
        }
        DirectRecordIdentity::PathToken(token) => {
            sqlx::query(
                r#"SELECT record_id, sequence, payload_ciphertext, updated_at
                   FROM hosted_provider_records
                   WHERE collection_id = $1 AND path_token = $2"#,
            )
            .bind(collection_id)
            .bind(token)
            .fetch_optional(&mut **transaction)
            .await?
        }
    };
    let Some(row) = row else {
        return Ok(None);
    };
    let record_id: Uuid = row.get("record_id");
    let sequence = number(row.get::<i64, _>("sequence"), "record sequence")?;
    let ciphertext: Vec<u8> = row.get("payload_ciphertext");
    let ciphertext_bytes = ciphertext.len() as u64;
    let record: PersistedRecord = crypto.decrypt_json(
        data_key,
        &ciphertext,
        &current_record_aad(collection_id, record_id, sequence),
    )?;
    if record.record_id != record_id {
        return Err(ApiError::internal(
            "The hosted encrypted record identity does not match its metadata.",
        ));
    }
    Ok(Some((
        record,
        ciphertext_bytes,
        row.get::<DateTime<Utc>, _>("updated_at"),
    )))
}

pub(super) fn compile_point_catalog(
    resources: SyncCollectionResources,
    resource_documents: Vec<(String, String)>,
) -> ApiResult<mdbase::runtime::CompiledCatalog> {
    let configuration_document = resource_documents
        .iter()
        .find(|(path, _)| path == "mdbase.yaml")
        .map(|(_, document)| document.clone())
        .ok_or_else(|| ApiError::internal("The hosted resource catalog has no mdbase.yaml."))?;
    let semantic_catalog_bytes = serde_jcs::to_vec(&json!({
        "configuration_document": &configuration_document,
        "types": &resources.types,
        "record_contracts": resources
            .contracts
            .iter()
            .filter(|contract| contract.contract_type == "record")
            .collect::<Vec<_>>(),
    }))
    .map_err(|error| {
        ApiError::internal(format!(
            "The hosted semantic catalog could not canonicalize: {error}"
        ))
    })?;
    let semantic_catalog_revision = format!("sha256:{:x}", Sha256::digest(semantic_catalog_bytes));
    let types = resources
        .types
        .into_iter()
        .map(|type_resource| {
            let path = type_resource.path.ok_or_else(|| {
                ApiError::internal("A hosted type catalog entry has no source path.")
            })?;
            let definition = type_resource.definition.ok_or_else(|| {
                ApiError::internal(format!(
                    "Hosted type catalog entry '{}' has no exact definition.",
                    type_resource.name
                ))
            })?;
            Ok(mdbase::runtime::ResolvedTypeResource {
                path,
                revision: type_resource.revision.unwrap_or_default(),
                definition,
                schema: type_resource.schema,
            })
        })
        .collect::<ApiResult<Vec<_>>>()?;
    let contracts = resources
        .contracts
        .into_iter()
        .filter(|contract| contract.contract_type == "record")
        .map(|contract| mdbase::runtime::ResolvedRecordContract {
            id: contract.id,
            version: contract.version,
            digest: contract.digest,
            record_schema: contract.schema,
            binding_schema: contract.binding_schema,
            implementations: contract
                .implementations
                .into_iter()
                .map(
                    |implementation| mdbase::runtime::ResolvedRecordContractImplementation {
                        type_name: implementation.type_name,
                        type_version: implementation.type_version,
                        digest: implementation.digest,
                        fields: implementation.fields,
                        binding: implementation.binding,
                        source_path: implementation.type_path,
                    },
                )
                .collect(),
        })
        .collect();
    mdbase::runtime::CompiledCatalog::compile(mdbase::runtime::CatalogInput {
        resource_revision: semantic_catalog_revision,
        configuration_document,
        types,
        contracts,
    })
    .map_err(|error| {
        ApiError::internal(format!(
            "The hosted resource catalog could not compile: {error}"
        ))
    })
}
