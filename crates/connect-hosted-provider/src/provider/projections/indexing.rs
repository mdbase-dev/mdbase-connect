const PRODUCTION_MIGRATION_BASELINE: u64 = 34;
const FINAL_PROJECTION_MIGRATION: u64 = 37;
const MAX_INDEX_INVENTORY_PAGE: u32 = 1_000;
const MAX_DERIVED_VERIFICATION_PAGE: i64 = 16;

impl HostedProvider {
    pub async fn projection_index_plan(
        &self,
        after: Option<Uuid>,
        limit: u32,
    ) -> ApiResult<HostedProjectionIndexPlan> {
        let limit = limit.clamp(1, MAX_INDEX_INVENTORY_PAGE);
        let ledger = sqlx::query(
            r#"SELECT count(*)::bigint AS migration_count,
                      min(version) AS minimum_version,
                      max(version) AS maximum_version,
                      bool_and(success) AS all_successful,
                      count(*) FILTER (WHERE version BETWEEN 35 AND 37)::bigint
                        AS final_migration_count
               FROM _sqlx_migrations"#,
        )
        .fetch_one(&self.pool)
        .await?;
        let applied_migrations = sqlx::query("SELECT version, checksum FROM _sqlx_migrations")
            .fetch_all(&self.pool)
            .await?;
        let applied_checksums = applied_migrations
            .iter()
            .map(|row| (row.get::<i64, _>("version"), row.get::<Vec<u8>, _>("checksum")))
            .collect::<BTreeMap<_, _>>();
        let expected_migrations = hosted_migrator();
        let migration_checksums_valid = expected_migrations.migrations.iter().all(|migration| {
            applied_checksums
                .get(&migration.version)
                .is_some_and(|checksum| checksum.as_slice() == migration.checksum.as_ref())
        });
        let migration_ledger_valid = ledger.get::<i64, _>("migration_count")
            == FINAL_PROJECTION_MIGRATION as i64
            && ledger.get::<Option<i64>, _>("minimum_version") == Some(1)
            && ledger.get::<Option<i64>, _>("maximum_version")
                == Some(FINAL_PROJECTION_MIGRATION as i64)
            && ledger.get::<Option<bool>, _>("all_successful") == Some(true)
            && ledger.get::<i64, _>("final_migration_count") == 3
            && migration_checksums_valid;
        let schema_valid: bool = sqlx::query_scalar(
            r#"SELECT to_regclass('public.hosted_provider_projection_generations') IS NOT NULL
                    AND to_regclass('public.hosted_provider_record_projections') IS NOT NULL
                    AND to_regclass('public.hosted_provider_record_resolution_keys') IS NOT NULL
                    AND to_regclass('public.hosted_provider_record_relationships') IS NOT NULL
                    AND to_regclass('public.hosted_provider_query_cursors') IS NOT NULL
                    AND to_regclass('public.hosted_provider_query_page_receipts') IS NOT NULL
                    AND to_regclass('public.hosted_provider_runtime_control') IS NOT NULL
                    AND EXISTS (
                      SELECT 1
                      FROM information_schema.columns
                      WHERE table_schema = 'public'
                        AND table_name = 'hosted_provider_runtime_control'
                        AND column_name = 'admission_fence_token'
                    )
                    AND EXISTS (
                      SELECT 1
                      FROM information_schema.columns
                      WHERE table_schema = 'public'
                        AND table_name = 'hosted_provider_runtime_control'
                        AND column_name = 'admission_fence_kind'
                    )
                    AND NOT EXISTS (
                      SELECT 1
                      FROM (VALUES
                        ('hosted_provider_runtime_control_fence_kind_check',
                         'CHECK (((admission_fence_kind IS NULL) OR (admission_fence_kind = ANY (ARRAY[''cutover''::text, ''rollback''::text]))))'),
                        ('hosted_provider_runtime_control_fence_pair_check',
                         'CHECK (((admission_fence_token IS NULL) = (admission_fence_kind IS NULL)))'),
                        ('hosted_provider_runtime_control_fence_state_check',
                         'CHECK ((query_admission_suspended OR ((admission_fence_token IS NULL) AND (admission_fence_kind IS NULL))))')
                      ) AS expected(constraint_name, constraint_definition)
                      WHERE NOT EXISTS (
                        SELECT 1
                        FROM pg_constraint constraint_row
                        JOIN pg_class relation
                          ON relation.oid = constraint_row.conrelid
                        JOIN pg_namespace namespace
                          ON namespace.oid = relation.relnamespace
                        WHERE namespace.nspname = 'public'
                          AND relation.relname = 'hosted_provider_runtime_control'
                          AND constraint_row.conname = expected.constraint_name
                          AND constraint_row.convalidated
                          AND pg_get_constraintdef(constraint_row.oid, false)
                                = expected.constraint_definition
                      )
                    )
                    AND (
                      SELECT count(*) FROM pg_indexes
                      WHERE schemaname = 'public'
                        AND indexname IN (
                          'hosted_provider_projection_generation_work_idx',
                          'hosted_provider_record_projections_snapshot_path_cursor_idx',
                          'hosted_provider_record_projections_snapshot_mtime_cursor_idx',
                          'hosted_provider_record_resolution_keys_lookup_idx',
                          'hosted_provider_record_resolution_keys_current_idx',
                          'hosted_provider_record_relationships_target_idx',
                          'hosted_provider_record_relationships_unresolved_idx',
                          'hosted_provider_record_relationships_current_idx'
                        )
                    ) = 8
                    AND (
                      SELECT count(*)
                      FROM pg_trigger trigger
                      JOIN pg_class relation ON relation.oid = trigger.tgrelid
                      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
                      WHERE namespace.nspname = 'public'
                        AND NOT trigger.tgisinternal
                        AND trigger.tgname IN (
                          'hosted_provider_record_projection_digest_observer',
                          'hosted_provider_projection_epoch_after_insert',
                          'hosted_provider_projection_epoch_after_update',
                          'hosted_provider_projection_epoch_after_delete',
                          'hosted_provider_resolution_key_epoch_after_insert',
                          'hosted_provider_resolution_key_epoch_after_update',
                          'hosted_provider_resolution_key_epoch_after_delete',
                          'hosted_provider_relationship_epoch_after_insert',
                          'hosted_provider_relationship_epoch_after_update',
                          'hosted_provider_relationship_epoch_after_delete'
                        )
                    ) = 10
                    AND (
                      SELECT count(*)
                      FROM pg_constraint constraint_row
                      JOIN pg_class relation ON relation.oid = constraint_row.conrelid
                      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
                      WHERE namespace.nspname = 'public'
                        AND constraint_row.conname IN (
                        'hosted_provider_collections_projection_binding_check',
                        'hosted_provider_collections_active_projection_generation_fk'
                      )
                    ) = 2
                    AND NOT EXISTS (
                      SELECT 1 FROM information_schema.columns
                      WHERE table_schema = 'public'
                        AND table_name = 'hosted_provider_collections'
                        AND column_name IN (
                          'hosted_execution_model',
                          'pending_hosted_execution_model'
                        )
                    )"#,
        )
        .fetch_one(&self.pool)
        .await?;
        let rows = sqlx::query(
            r#"SELECT collection.id, collection.head, collection.resource_revision,
                      collection.record_count,
                      (SELECT count(*)::bigint
                       FROM hosted_provider_resources resource
                       WHERE resource.collection_id = collection.id) AS resource_count,
                      (SELECT count(*)::bigint
                       FROM hosted_provider_record_versions version
                       WHERE version.collection_id = collection.id) AS retained_record_versions,
                      (
                        COALESCE((SELECT sum(octet_length(record.payload_ciphertext))
                                  FROM hosted_provider_records record
                                  WHERE record.collection_id = collection.id), 0)
                        + COALESCE((SELECT sum(octet_length(version.payload_ciphertext))
                                    FROM hosted_provider_record_versions version
                                    WHERE version.collection_id = collection.id), 0)
                        + COALESCE((SELECT sum(octet_length(resource.document_ciphertext))
                                    FROM hosted_provider_resources resource
                                    WHERE resource.collection_id = collection.id), 0)
                      )::bigint AS exact_ciphertext_bytes
               FROM hosted_provider_collections collection
               WHERE collection.state IN ('active', 'indexing')
                 AND ($1::uuid IS NULL OR collection.id > $1)
               ORDER BY collection.id
               LIMIT $2"#,
        )
        .bind(after)
        .bind(i64::from(limit) + 1)
        .fetch_all(&self.pool)
        .await?;
        let mut collections = Vec::with_capacity(rows.len().min(limit as usize));
        for row in rows.iter().take(limit as usize) {
            let collection_id: Uuid = row.get("id");
            let status = self.projection_status(collection_id).await?;
            collections.push(HostedProjectionIndexPlanEntry {
                collection_id,
                head: number(row.get::<i64, _>("head"), "collection head")?,
                resource_revision: row.get("resource_revision"),
                record_count: number(row.get::<i64, _>("record_count"), "record count")?,
                resource_count: number(row.get::<i64, _>("resource_count"), "resource count")?,
                retained_record_versions: number(
                    row.get::<i64, _>("retained_record_versions"),
                    "retained record version count",
                )?,
                exact_ciphertext_bytes: number(
                    row.get::<i64, _>("exact_ciphertext_bytes"),
                    "exact ciphertext bytes",
                )?,
                ready: status.ready,
            });
        }
        let next_after = (rows.len() > limit as usize)
            .then(|| collections.last().map(|entry| entry.collection_id))
            .flatten();
        Ok(HostedProjectionIndexPlan {
            migration_baseline: PRODUCTION_MIGRATION_BASELINE,
            migration_target: FINAL_PROJECTION_MIGRATION,
            migration_ledger_valid,
            schema_valid,
            collections,
            next_after,
        })
    }

    pub async fn verify_projection_index(
        &self,
        collection_id: Uuid,
    ) -> ApiResult<HostedProjectionVerification> {
        let status = self.projection_status(collection_id).await?;
        let row = sqlx::query(
            r#"SELECT collection.record_count,
                      collection.active_projection_generation_id,
                      collection.active_catalog_revision,
                      collection.active_projection_format_version,
                      collection.active_semantic_engine_version,
                      (SELECT count(*)::bigint
                       FROM hosted_provider_records record
                       WHERE record.collection_id = collection.id) AS exact_records,
                      (SELECT count(*)::bigint
                       FROM hosted_provider_record_projections projection
                       WHERE projection.collection_id = collection.id
                         AND projection.generation_id =
                             collection.active_projection_generation_id
                         AND projection.valid_to_sequence IS NULL) AS projected_records,
                      (SELECT count(*)::bigint
                       FROM hosted_provider_record_projections projection
                       WHERE projection.collection_id = collection.id
                         AND projection.generation_id =
                             collection.active_projection_generation_id
                         AND projection.valid_to_sequence IS NULL
                         AND projection.semantic_complete
                         AND projection.resolution_complete) AS resolved_records,
                      (SELECT count(*)::bigint
                       FROM hosted_provider_record_projections projection
                       WHERE projection.collection_id = collection.id
                         AND projection.generation_id =
                             collection.active_projection_generation_id
                         AND projection.valid_to_sequence IS NULL
                         AND NOT hosted_provider_projection_digest_valid(
                           projection.projection_digest,
                           projection.projection_observed_digest
                         )) AS invalid_projection_rows
               FROM hosted_provider_collections collection
               WHERE collection.id = $1 AND collection.state = 'active'"#,
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
        let expected = number(row.get::<i64, _>("record_count"), "record count")?;
        let exact_records = number(row.get::<i64, _>("exact_records"), "exact record count")?;
        let projected_records = number(
            row.get::<i64, _>("projected_records"),
            "projected record count",
        )?;
        let resolved_records = number(
            row.get::<i64, _>("resolved_records"),
            "resolved record count",
        )?;
        let invalid_projection_rows = number(
            row.get::<i64, _>("invalid_projection_rows"),
            "invalid projection row count",
        )?;
        let mut failures = Vec::new();
        if !status.ready {
            failures.push("active_binding_not_current".to_string());
        }
        if exact_records != expected {
            failures.push("exact_record_count_mismatch".to_string());
        }
        if projected_records != expected {
            failures.push("projection_record_count_mismatch".to_string());
        }
        if resolved_records != expected {
            failures.push("projection_resolution_incomplete".to_string());
        }
        if invalid_projection_rows != 0 {
            failures.push("projection_digest_invalid".to_string());
        }
        let derived = match (
            row.get::<Option<Uuid>, _>("active_projection_generation_id"),
            row.get::<Option<String>, _>("active_catalog_revision"),
            row.get::<Option<i32>, _>("active_projection_format_version"),
            row.get::<Option<String>, _>("active_semantic_engine_version"),
        ) {
            (Some(generation_id), Some(catalog_revision), Some(format_version), Some(engine)) => {
                verify_projection_derived_rows(
                    self,
                    collection_id,
                    generation_id,
                    &catalog_revision,
                    format_version,
                    &engine,
                )
                .await?
            }
            _ => DerivedProjectionVerification::default(),
        };
        if !derived.semantic_envelopes_valid {
            failures.push("projection_semantic_envelope_invalid".to_string());
        }
        if !derived.resolution_keys_match {
            failures.push("projection_resolution_keys_mismatch".to_string());
        }
        if !derived.relationships_match {
            failures.push("projection_relationships_mismatch".to_string());
        }
        Ok(HostedProjectionVerification {
            collection_id,
            verified: failures.is_empty(),
            failures,
            exact_records,
            projected_records,
            resolved_records,
            invalid_projection_rows,
            expected_resolution_keys: derived.expected_resolution_keys,
            persisted_resolution_keys: derived.persisted_resolution_keys,
            expected_relationships: derived.expected_relationships,
            persisted_relationships: derived.persisted_relationships,
        })
    }
}

#[derive(Debug, Default)]
struct DerivedProjectionVerification {
    expected_resolution_keys: u64,
    persisted_resolution_keys: u64,
    expected_relationships: u64,
    persisted_relationships: u64,
    semantic_envelopes_valid: bool,
    resolution_keys_match: bool,
    relationships_match: bool,
}

async fn verify_projection_derived_rows(
    provider: &HostedProvider,
    collection_id: Uuid,
    generation_id: Uuid,
    catalog_revision: &str,
    format_version: i32,
    engine_version: &str,
) -> ApiResult<DerivedProjectionVerification> {
    let mut transaction = provider.pool.begin().await?;
    let verification = verify_projection_derived_rows_in(
        &mut transaction,
        collection_id,
        generation_id,
        catalog_revision,
        format_version,
        engine_version,
    )
    .await?;
    transaction.commit().await?;
    Ok(verification)
}

async fn verify_projection_derived_rows_in(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
    generation_id: Uuid,
    catalog_revision: &str,
    format_version: i32,
    engine_version: &str,
) -> ApiResult<DerivedProjectionVerification> {
    let mut verification = DerivedProjectionVerification {
        semantic_envelopes_valid: true,
        resolution_keys_match: true,
        relationships_match: true,
        ..DerivedProjectionVerification::default()
    };
    let mut after = None;
    loop {
        let rows = sqlx::query(
            r#"SELECT record_id, record_revision, record_sequence,
                      valid_from_sequence, semantic_projection
               FROM hosted_provider_record_projections
               WHERE collection_id = $1 AND generation_id = $2
                 AND valid_to_sequence IS NULL
                 AND ($3::uuid IS NULL OR record_id > $3)
               ORDER BY record_id
               LIMIT $4"#,
        )
        .bind(collection_id)
        .bind(generation_id)
        .bind(after)
        .bind(MAX_DERIVED_VERIFICATION_PAGE + 1)
        .fetch_all(&mut **transaction)
        .await?;
        if rows.is_empty() {
            break;
        }
        let page = rows
            .iter()
            .take(MAX_DERIVED_VERIFICATION_PAGE as usize)
            .collect::<Vec<_>>();
        let record_ids = page
            .iter()
            .map(|row| row.get::<Uuid, _>("record_id"))
            .collect::<Vec<_>>();
        let mut expected_keys = BTreeSet::new();
        let mut expected_relationships = BTreeSet::new();
        for row in &page {
            let record_id = row.get::<Uuid, _>("record_id");
            let record_revision = row.get::<String, _>("record_revision");
            let record_sequence = row.get::<i64, _>("record_sequence");
            let valid_from = row.get::<i64, _>("valid_from_sequence");
            let projection = match serde_json::from_value::<mdbase::runtime::SemanticProjection>(
                row.get("semantic_projection"),
            ) {
                Ok(projection) => projection,
                Err(_) => {
                    verification.semantic_envelopes_valid = false;
                    continue;
                }
            };
            if !projection.is_current_for(catalog_revision, engine_version)
                || i64::from(projection.facts.format_version) != i64::from(format_version)
            {
                verification.semantic_envelopes_valid = false;
                continue;
            }
            for key in &projection.facts.resolution_keys {
                expected_keys.insert(derived_row_fingerprint(json!([
                    "resolution-key-v1",
                    record_id,
                    resolution_key_kind(key.kind),
                    key.value,
                    record_revision,
                    record_sequence,
                    catalog_revision,
                    format_version,
                    engine_version,
                    valid_from
                ]))?);
            }
            for occurrence in &projection.structure.occurrences {
                let Some(resolution_state) =
                    relationship_resolution_state(occurrence.resolution)
                else {
                    continue;
                };
                let target_record_id = match occurrence.target_record_id.as_deref() {
                    Some(value) => match Uuid::parse_str(value) {
                        Ok(value) => Some(value),
                        Err(_) => {
                            verification.semantic_envelopes_valid = false;
                            continue;
                        }
                    },
                    None => None,
                };
                let occurrence_key = Sha256::digest(
                    serde_jcs::to_vec(&occurrence.occurrence).map_err(|error| {
                        ApiError::internal(format!(
                            "Projected relationship occurrence could not serialize: {error}"
                        ))
                    })?,
                )
                .to_vec();
                expected_relationships.insert(derived_row_fingerprint(json!([
                    "relationship-v1",
                    record_id,
                    occurrence_key,
                    valid_from,
                    record_revision,
                    record_sequence,
                    catalog_revision,
                    format_version,
                    engine_version,
                    relationship_kind(occurrence.occurrence.kind),
                    occurrence.occurrence.field,
                    occurrence.occurrence.raw_target,
                    occurrence
                        .occurrence
                        .normalized_target
                        .as_deref()
                        .unwrap_or(&occurrence.occurrence.raw_target),
                    occurrence.occurrence.alias,
                    occurrence.occurrence.anchor,
                    occurrence.occurrence.relative,
                    resolution_state,
                    target_record_id,
                    occurrence.target_path
                ]))?);
            }
        }
        verification.expected_resolution_keys = verification
            .expected_resolution_keys
            .saturating_add(expected_keys.len() as u64);
        verification.expected_relationships = verification
            .expected_relationships
            .saturating_add(expected_relationships.len() as u64);

        let key_rows = sqlx::query(
            r#"SELECT record_id, key_kind, lookup_key, record_revision,
                      record_sequence, catalog_revision, projection_format_version,
                      semantic_engine_version, valid_from_sequence
               FROM hosted_provider_record_resolution_keys
               WHERE collection_id = $1 AND generation_id = $2
                 AND record_id = ANY($3) AND valid_to_sequence IS NULL"#,
        )
        .bind(collection_id)
        .bind(generation_id)
        .bind(&record_ids)
        .fetch_all(&mut **transaction)
        .await?;
        let actual_keys = key_rows
            .iter()
            .map(|row| {
                derived_row_fingerprint(json!([
                    "resolution-key-v1",
                    row.get::<Uuid, _>("record_id"),
                    row.get::<String, _>("key_kind"),
                    row.get::<String, _>("lookup_key"),
                    row.get::<String, _>("record_revision"),
                    row.get::<i64, _>("record_sequence"),
                    row.get::<String, _>("catalog_revision"),
                    row.get::<i32, _>("projection_format_version"),
                    row.get::<String, _>("semantic_engine_version"),
                    row.get::<i64, _>("valid_from_sequence")
                ]))
            })
            .collect::<ApiResult<BTreeSet<_>>>()?;
        if actual_keys != expected_keys {
            verification.resolution_keys_match = false;
        }

        let relationship_rows = sqlx::query(
            r#"SELECT source_record_id, occurrence_key, valid_from_sequence,
                      source_record_revision, source_record_sequence,
                      catalog_revision, projection_format_version,
                      semantic_engine_version, relationship_kind, source_field,
                      raw_target, normalized_target, alias, anchor, is_relative,
                      resolution_state, target_record_id, target_path
               FROM hosted_provider_record_relationships
               WHERE collection_id = $1 AND generation_id = $2
                 AND source_record_id = ANY($3) AND valid_to_sequence IS NULL"#,
        )
        .bind(collection_id)
        .bind(generation_id)
        .bind(&record_ids)
        .fetch_all(&mut **transaction)
        .await?;
        let actual_relationships = relationship_rows
            .iter()
            .map(|row| {
                derived_row_fingerprint(json!([
                    "relationship-v1",
                    row.get::<Uuid, _>("source_record_id"),
                    row.get::<Vec<u8>, _>("occurrence_key"),
                    row.get::<i64, _>("valid_from_sequence"),
                    row.get::<String, _>("source_record_revision"),
                    row.get::<i64, _>("source_record_sequence"),
                    row.get::<String, _>("catalog_revision"),
                    row.get::<i32, _>("projection_format_version"),
                    row.get::<String, _>("semantic_engine_version"),
                    row.get::<String, _>("relationship_kind"),
                    row.get::<Option<String>, _>("source_field"),
                    row.get::<String, _>("raw_target"),
                    row.get::<String, _>("normalized_target"),
                    row.get::<Option<String>, _>("alias"),
                    row.get::<Option<String>, _>("anchor"),
                    row.get::<bool, _>("is_relative"),
                    row.get::<String, _>("resolution_state"),
                    row.get::<Option<Uuid>, _>("target_record_id"),
                    row.get::<Option<String>, _>("target_path")
                ]))
            })
            .collect::<ApiResult<BTreeSet<_>>>()?;
        if actual_relationships != expected_relationships {
            verification.relationships_match = false;
        }

        if rows.len() <= MAX_DERIVED_VERIFICATION_PAGE as usize {
            break;
        }
        after = record_ids.last().copied();
    }

    verification.persisted_resolution_keys = number(
        sqlx::query_scalar::<_, i64>(
            r#"SELECT count(*) FROM hosted_provider_record_resolution_keys
               WHERE collection_id = $1 AND generation_id = $2
                 AND valid_to_sequence IS NULL"#,
        )
        .bind(collection_id)
        .bind(generation_id)
        .fetch_one(&mut **transaction)
        .await?,
        "persisted resolution key count",
    )?;
    verification.persisted_relationships = number(
        sqlx::query_scalar::<_, i64>(
            r#"SELECT count(*) FROM hosted_provider_record_relationships
               WHERE collection_id = $1 AND generation_id = $2
                 AND valid_to_sequence IS NULL"#,
        )
        .bind(collection_id)
        .bind(generation_id)
        .fetch_one(&mut **transaction)
        .await?,
        "persisted relationship count",
    )?;
    if verification.expected_resolution_keys != verification.persisted_resolution_keys {
        verification.resolution_keys_match = false;
    }
    if verification.expected_relationships != verification.persisted_relationships {
        verification.relationships_match = false;
    }
    Ok(verification)
}

fn derived_row_fingerprint(value: Value) -> ApiResult<Vec<u8>> {
    let bytes = serde_jcs::to_vec(&value).map_err(|error| {
        ApiError::internal(format!(
            "Projection verification row could not serialize: {error}"
        ))
    })?;
    Ok(Sha256::digest(bytes).to_vec())
}
