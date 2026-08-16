use super::operation_reads::compile_point_catalog;
use super::*;

const PROJECTION_LEASE_SECONDS: i64 = 30;
const MAX_PROJECTION_BATCH: u64 = 200;
const MAX_PROJECTION_BATCH_CIPHERTEXT_BYTES: u64 = 16 * 1024 * 1024;
const MAX_RESOLUTION_BATCH_PROJECTION_BYTES: u64 = 16 * 1024 * 1024;
const MAX_RELATIONSHIP_REVALIDATION_RECORDS: usize = 200;
const MAX_RELATIONSHIP_REVALIDATION_BYTES: u64 = 32 * 1024 * 1024;
const MAX_RETAINED_PROJECTION_GENERATIONS: i64 = 4;

#[derive(Debug, Clone, Serialize)]
pub struct HostedProjectionGeneration {
    pub collection_id: Uuid,
    pub generation_id: Uuid,
    pub catalog_revision: String,
    pub projection_format_version: u32,
    pub semantic_engine_version: String,
    pub source_head: u64,
    pub phase: String,
    pub status: String,
    pub lease_fencing_generation: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct HostedProjectionBatch {
    pub generation: HostedProjectionGeneration,
    pub records_projected: u64,
    pub records_resolved: u64,
    pub ciphertext_bytes: u64,
    pub projection_bytes: u64,
    pub phase_advanced: bool,
}

#[derive(Debug, Clone)]
pub(super) struct ActiveProjectionChange {
    pub record_id: Uuid,
    pub record_sequence: u64,
    pub sequence: u64,
    pub was_present: bool,
    pub force_relationship_resolution: bool,
    pub file_mtime: Option<String>,
    pub record: Option<PersistedRecord>,
}

impl HostedProvider {
    /// Open an inactive-by-default Candidate B generation for one collection.
    /// The prior complete generation remains active while this immutable
    /// source-head snapshot is rebuilt and resolved.
    pub async fn start_projection_generation(
        &self,
        collection_id: Uuid,
    ) -> ApiResult<HostedProjectionGeneration> {
        let generation_id = Uuid::new_v4();
        let mut transaction = self.pool.begin().await?;
        let row = sqlx::query(
            r#"SELECT head, resource_revision, wrapped_data_key, resources_ciphertext
               FROM hosted_provider_collections
               WHERE id = $1 AND state = 'active'
               FOR UPDATE"#,
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
        let source_head = number(row.get::<i64, _>("head"), "collection head")?;
        let source_resource_revision: String = row.get("resource_revision");
        let data_key = self
            .collection_key(collection_id, row.get("wrapped_data_key"))
            .await?;
        let resources: SyncCollectionResources = self.crypto.decrypt_json(
            &data_key,
            row.get("resources_ciphertext"),
            &resources_aad(collection_id),
        )?;
        if resources.revision != row.get::<String, _>("resource_revision") {
            return Err(projection_binding_changed());
        }
        let resource_documents =
            load_resource_documents(&mut transaction, &self.crypto, &data_key, collection_id)
                .await?;
        let catalog = compile_point_catalog(resources, resource_documents)?;
        let catalog_revision = catalog.resource_revision().to_string();
        let format_version = mdbase::runtime::SEMANTIC_PROJECTION_FORMAT_VERSION;
        let engine_version = mdbase::VERSION;

        // A newer explicit start fences prior unfinished work without deleting
        // evidence. Complete generations remain retained for cursor/history use.
        sqlx::query(
            r#"UPDATE hosted_provider_projection_generations
               SET status = 'abandoned', abandoned_at = now(), updated_at = now(),
                   lease_owner = NULL, lease_expires_at = NULL,
                   last_error_code = 'superseded'
               WHERE collection_id = $1 AND status = 'building'"#,
        )
        .bind(collection_id)
        .execute(&mut *transaction)
        .await?;
        prune_unpinned_projection_generations_in(&mut transaction, collection_id).await?;
        let retained_generations: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM hosted_provider_projection_generations WHERE collection_id = $1",
        )
        .bind(collection_id)
        .fetch_one(&mut *transaction)
        .await?;
        if retained_generations >= MAX_RETAINED_PROJECTION_GENERATIONS {
            return Err(ApiError::quota(
                "projection_generation_retention_exceeded",
                "Too many projection generations remain pinned for safe rebuild.",
            )
            .with_details(json!({
                "limit": MAX_RETAINED_PROJECTION_GENERATIONS,
                "retained": retained_generations,
            })));
        }
        sqlx::query(
            r#"INSERT INTO hosted_provider_projection_generations
                 (collection_id, generation_id, target_catalog_revision,
                  projection_format_version, semantic_engine_version, source_head,
                  source_resource_revision,
                  lease_owner, lease_expires_at, lease_fencing_generation)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                       now() + make_interval(secs => $9), 1)"#,
        )
        .bind(collection_id)
        .bind(generation_id)
        .bind(&catalog_revision)
        .bind(i64::from(format_version))
        .bind(engine_version)
        .bind(to_i64(source_head, "collection head")?)
        .bind(&source_resource_revision)
        .bind(self.process_epoch)
        .bind(PROJECTION_LEASE_SECONDS)
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            "UPDATE hosted_provider_collections SET hosted_execution_model = 'candidate_b' WHERE id = $1",
        )
        .bind(collection_id)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(HostedProjectionGeneration {
            collection_id,
            generation_id,
            catalog_revision,
            projection_format_version: format_version,
            semantic_engine_version: engine_version.to_string(),
            source_head,
            phase: "projection".to_string(),
            status: "building".to_string(),
            lease_fencing_generation: 1,
        })
    }

    /// Advance a bounded number of opted-in projection rebuilds. A missing
    /// generation is recreated from exact authority, while live leases remain
    /// fenced to their current owner. One call performs at most one bounded
    /// projection or resolution batch per selected collection.
    pub async fn recover_projection_generations(&self, limit: u32) -> ApiResult<usize> {
        let limit = i64::from(limit.clamp(1, 100));
        let missing = sqlx::query(
            r#"SELECT collection.id
               FROM hosted_provider_collections collection
               WHERE collection.state = 'active'
                 AND collection.hosted_execution_model = 'candidate_b'
                 AND (
                   collection.active_projection_generation_id IS NULL
                   OR EXISTS (
                     SELECT 1
                     FROM hosted_provider_record_projections projection
                     WHERE projection.collection_id = collection.id
                       AND projection.generation_id =
                           collection.active_projection_generation_id
                       AND projection.valid_to_sequence IS NULL
                       AND NOT hosted_provider_projection_digest_valid(
                         projection.projection_digest,
                         projection.projection_observed_digest
                       )
                   )
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM hosted_provider_projection_generations generation
                   WHERE generation.collection_id = collection.id
                     AND generation.status = 'building'
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM hosted_provider_projection_generations terminal
                   WHERE terminal.collection_id = collection.id
                     AND terminal.status = 'abandoned'
                     AND terminal.last_error_code IN (
                       'projection_record_too_large',
                       'projection_authority_invalid'
                     )
                     AND terminal.source_head = collection.head
                     AND terminal.source_resource_revision = collection.resource_revision
                     AND terminal.projection_format_version = $2
                     AND terminal.semantic_engine_version = $3
                 )
               ORDER BY collection.updated_at, collection.id
               LIMIT $1"#,
        )
        .bind(limit)
        .bind(to_i64(
            u64::from(mdbase::runtime::SEMANTIC_PROJECTION_FORMAT_VERSION),
            "projection format version",
        )?)
        .bind(mdbase::VERSION)
        .fetch_all(&self.pool)
        .await?;
        for row in missing {
            let collection_id: Uuid = row.get("id");
            match self.start_projection_generation(collection_id).await {
                Ok(_) => {}
                Err(error) if error.code == "projection_generation_retention_exceeded" => {
                    tracing::warn!(
                        %collection_id,
                        error_code = %error.code,
                        "projection rebuild could not start"
                    );
                }
                Err(error) => return Err(error),
            }
        }

        let generations = sqlx::query(
            r#"SELECT generation.collection_id, generation.generation_id, generation.phase
               FROM hosted_provider_projection_generations generation
               JOIN hosted_provider_collections collection
                 ON collection.id = generation.collection_id
               WHERE collection.state = 'active'
                 AND collection.hosted_execution_model = 'candidate_b'
                 AND generation.status = 'building'
                 AND (
                   generation.lease_owner IS NULL
                   OR generation.lease_owner = $1
                   OR generation.lease_expires_at <= now()
                 )
               ORDER BY generation.updated_at, generation.collection_id,
                        generation.generation_id
               LIMIT $2"#,
        )
        .bind(self.process_epoch)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        let mut advanced = 0_usize;
        for generation in generations {
            let collection_id: Uuid = generation.get("collection_id");
            let generation_id: Uuid = generation.get("generation_id");
            let phase: String = generation.get("phase");
            let outcome = if phase == "projection" {
                self.project_generation_batch(collection_id, generation_id, MAX_PROJECTION_BATCH)
                    .await
            } else {
                self.resolve_generation_batch(collection_id, generation_id, MAX_PROJECTION_BATCH)
                    .await
            };
            match outcome {
                Ok(_) => advanced += 1,
                Err(error)
                    if matches!(
                        error.code.as_str(),
                        "projection_lease_unavailable" | "projection_source_head_changed"
                    ) =>
                {
                    tracing::debug!(
                        %collection_id,
                        %generation_id,
                        error_code = %error.code,
                        "projection rebuild yielded to a fence or newer source"
                    );
                }
                Err(error)
                    if matches!(
                        error.code.as_str(),
                        "projection_record_too_large" | "projection_authority_invalid"
                    ) =>
                {
                    tracing::warn!(
                        %collection_id,
                        %generation_id,
                        error_code = %error.code,
                        "projection rebuild was quarantined until exact authority or catalog changes"
                    );
                }
                Err(error) => return Err(error),
            }
        }
        Ok(advanced)
    }

    /// Project at most one bounded UUID-keyset batch. The lease CAS is renewed
    /// before ciphertext is read and rechecked in every projection write.
    pub async fn project_generation_batch(
        &self,
        collection_id: Uuid,
        generation_id: Uuid,
        requested_limit: u64,
    ) -> ApiResult<HostedProjectionBatch> {
        let limit = requested_limit.clamp(1, MAX_PROJECTION_BATCH);
        let started = Instant::now();
        let mut transaction = self.pool.begin().await?;
        sqlx::query("SET LOCAL statement_timeout = 15000")
            .execute(&mut *transaction)
            .await?;
        let generation = sqlx::query(
            r#"UPDATE hosted_provider_projection_generations
               SET lease_owner = $3,
                   lease_expires_at = now() + make_interval(secs => $4),
                   lease_fencing_generation = lease_fencing_generation + 1,
                   updated_at = now()
               WHERE collection_id = $1 AND generation_id = $2
                 AND status = 'building' AND phase = 'projection'
                 AND (lease_owner IS NULL OR lease_owner = $3 OR lease_expires_at <= now())
               RETURNING target_catalog_revision, projection_format_version,
                         semantic_engine_version, source_head, checkpoint_record_id,
                         lease_fencing_generation"#,
        )
        .bind(collection_id)
        .bind(generation_id)
        .bind(self.process_epoch)
        .bind(PROJECTION_LEASE_SECONDS)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or_else(projection_lease_unavailable)?;
        let catalog_revision: String = generation.get("target_catalog_revision");
        let format_version = number(
            i64::from(generation.get::<i32, _>("projection_format_version")),
            "projection format version",
        )?;
        let engine_version: String = generation.get("semantic_engine_version");
        let source_head = number(generation.get::<i64, _>("source_head"), "source head")?;
        let checkpoint: Option<Uuid> = generation.get("checkpoint_record_id");
        let fence = number(
            generation.get::<i64, _>("lease_fencing_generation"),
            "projection lease fence",
        )?;

        if format_version != u64::from(mdbase::runtime::SEMANTIC_PROJECTION_FORMAT_VERSION)
            || engine_version != mdbase::VERSION
        {
            return Err(ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "projection_engine_mismatch",
                "The projection generation requires a different semantic engine.",
            ));
        }
        let collection = sqlx::query(
            r#"SELECT resource_revision, wrapped_data_key, resources_ciphertext
               FROM hosted_provider_collections
               WHERE id = $1 AND state = 'active'"#,
        )
        .bind(collection_id)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or_else(projection_binding_changed)?;
        let data_key = self
            .collection_key(collection_id, collection.get("wrapped_data_key"))
            .await?;
        let resources: SyncCollectionResources = self.crypto.decrypt_json(
            &data_key,
            collection.get("resources_ciphertext"),
            &resources_aad(collection_id),
        )?;
        if resources.revision != collection.get::<String, _>("resource_revision") {
            return Err(projection_binding_changed());
        }
        let resource_documents =
            load_resource_documents(&mut transaction, &self.crypto, &data_key, collection_id)
                .await?;
        let catalog = compile_point_catalog(resources, resource_documents)?;
        if catalog.resource_revision() != catalog_revision {
            return Err(projection_binding_changed());
        }

        let rows = sqlx::query(
            r#"WITH candidate_ids AS MATERIALIZED (
                 SELECT record_id
                 FROM hosted_provider_record_versions
                 WHERE collection_id = $1 AND sequence <= $4
                   AND ($2::uuid IS NULL OR record_id > $2)
                 GROUP BY record_id
                 ORDER BY record_id
                 LIMIT $3
               ), snapshot AS MATERIALIZED (
                 SELECT candidate_ids.record_id, version.sequence, version.revision,
                        CASE WHEN version.deleted THEN NULL ELSE version.payload_ciphertext END
                          AS payload_ciphertext,
                        version.deleted, version.created_at
                 FROM candidate_ids
                 CROSS JOIN LATERAL (
                   SELECT sequence, revision, payload_ciphertext, deleted, created_at
                   FROM hosted_provider_record_versions
                   WHERE collection_id = $1
                     AND record_id = candidate_ids.record_id
                     AND sequence <= $4
                   ORDER BY sequence DESC
                   LIMIT 1
                 ) version
               ), eligible AS (
                 SELECT record_id, sequence, revision, payload_ciphertext, deleted, created_at,
                        sum(CASE WHEN deleted THEN 0 ELSE octet_length(payload_ciphertext) END)
                          OVER (ORDER BY record_id) AS batch_bytes
                 FROM snapshot
               )
               SELECT record_id, sequence, revision, payload_ciphertext, deleted, created_at
               FROM eligible
               WHERE batch_bytes <= $5
               ORDER BY record_id"#,
        )
        .bind(collection_id)
        .bind(checkpoint)
        .bind(to_i64(limit, "projection batch limit")?)
        .bind(to_i64(source_head, "source head")?)
        .bind(to_i64(
            MAX_PROJECTION_BATCH_CIPHERTEXT_BYTES,
            "projection batch byte limit",
        )?)
        .fetch_all(&mut *transaction)
        .await?;
        let mut projected = 0_u64;
        let mut ciphertext_bytes = 0_u64;
        let mut projection_bytes = 0_u64;
        let mut last_record_id = checkpoint;
        for row in &rows {
            let record_id: Uuid = row.get("record_id");
            last_record_id = Some(record_id);
            if row.get::<bool, _>("deleted") {
                continue;
            }
            let sequence = number(row.get::<i64, _>("sequence"), "record sequence")?;
            let revision: String = row.get("revision");
            let file_modified_at: DateTime<Utc> = row.get("created_at");
            let Some(ciphertext) = row.get::<Option<Vec<u8>>, _>("payload_ciphertext") else {
                abandon_projection_generation_for_terminal_error(
                    &mut transaction,
                    collection_id,
                    generation_id,
                    self.process_epoch,
                    fence,
                    &catalog_revision,
                    "projection_authority_invalid",
                )
                .await?;
                transaction.commit().await?;
                return Err(projection_authority_invalid());
            };
            ciphertext_bytes = ciphertext_bytes.saturating_add(ciphertext.len() as u64);
            let record: PersistedRecord = match self.crypto.decrypt_json(
                &data_key,
                &ciphertext,
                &record_version_aad(collection_id, record_id, sequence),
            ) {
                Ok(record) => record,
                Err(_) => {
                    abandon_projection_generation_for_terminal_error(
                        &mut transaction,
                        collection_id,
                        generation_id,
                        self.process_epoch,
                        fence,
                        &catalog_revision,
                        "projection_authority_invalid",
                    )
                    .await?;
                    transaction.commit().await?;
                    return Err(projection_authority_invalid());
                }
            };
            if record.record_id != record_id || record.revision != revision {
                abandon_projection_generation_for_terminal_error(
                    &mut transaction,
                    collection_id,
                    generation_id,
                    self.process_epoch,
                    fence,
                    &catalog_revision,
                    "projection_authority_invalid",
                )
                .await?;
                transaction.commit().await?;
                return Err(projection_authority_invalid());
            }
            let document_size = record.document.len() as u64;
            let prepared = catalog
                .project_record(&mdbase::runtime::CanonicalRecordInput {
                    stable_id: Some(record_id.to_string()),
                    path: record.path,
                    document: record.document,
                    file_size: document_size,
                    file_mtime: Some(file_modified_at.to_rfc3339_opts(SecondsFormat::Micros, true)),
                })
                .map_err(|error| {
                    ApiError::new(
                        StatusCode::UNPROCESSABLE_ENTITY,
                        "projection_semantic_failure",
                        "The exact record could not produce a semantic projection.",
                    )
                    .with_details(json!({"semantic_code": error.code}))
                })?;
            let bytes = serde_jcs::to_vec(&prepared).map_err(|error| {
                ApiError::internal(format!("Semantic projection could not serialize: {error}"))
            })?;
            let bytes_len = bytes.len() as u64;
            if bytes_len > 262_144 {
                abandon_projection_generation_for_terminal_error(
                    &mut transaction,
                    collection_id,
                    generation_id,
                    self.process_epoch,
                    fence,
                    &catalog_revision,
                    "projection_record_too_large",
                )
                .await?;
                transaction.commit().await?;
                return Err(projection_record_too_large(
                    "semantic_projection_bytes",
                    262_144,
                    bytes_len,
                ));
            }
            persist_prepared_projection(
                &mut transaction,
                collection_id,
                generation_id,
                &catalog_revision,
                &engine_version,
                fence,
                record_id,
                sequence,
                &revision,
                &prepared,
                &bytes,
            )
            .await?;
            projected = projected.saturating_add(1);
            projection_bytes = projection_bytes.saturating_add(bytes_len);
        }

        let mut phase_advanced = false;
        if rows.is_empty() {
            if let Some(issue) = abandon_invalid_projection_candidate(
                &mut transaction,
                collection_id,
                generation_id,
                checkpoint,
                source_head,
                self.process_epoch,
                fence,
                &catalog_revision,
            )
            .await?
            {
                transaction.commit().await?;
                return Err(match issue {
                    ProjectionCandidateTerminalIssue::Oversized(observed) => {
                        projection_record_too_large(
                            "projection_batch_ciphertext_bytes",
                            MAX_PROJECTION_BATCH_CIPHERTEXT_BYTES,
                            observed,
                        )
                    }
                    ProjectionCandidateTerminalIssue::InvalidAuthority => {
                        projection_authority_invalid()
                    }
                });
            }
            let stale_exists: bool = sqlx::query_scalar(
                r#"WITH snapshot AS (
                     SELECT DISTINCT ON (record_id)
                       record_id, revision, sequence, deleted
                     FROM hosted_provider_record_versions
                     WHERE collection_id = $1 AND sequence <= $3
                     ORDER BY record_id, sequence DESC
                   ), live AS (
                     SELECT record_id, revision, sequence FROM snapshot WHERE deleted = false
                   )
                   SELECT EXISTS (
                     SELECT 1 FROM live r
                     LEFT JOIN hosted_provider_record_projections p
                       ON p.collection_id = $1 AND p.record_id = r.record_id
                      AND p.valid_to_sequence IS NULL
                      AND p.generation_id = $2
                     WHERE p.record_id IS NULL OR p.record_revision <> r.revision
                        OR p.record_sequence <> r.sequence
                        OR p.catalog_revision <> $4
                        OR p.projection_format_version <> $5
                        OR p.semantic_engine_version <> $6
                        OR NOT hosted_provider_projection_digest_valid(
                          p.projection_digest, p.projection_observed_digest)
                     UNION ALL
                     SELECT 1 FROM hosted_provider_record_projections p
                     LEFT JOIN live r ON r.record_id = p.record_id
                     WHERE p.collection_id = $1 AND p.generation_id = $2
                       AND p.valid_to_sequence IS NULL AND r.record_id IS NULL
                   )"#,
            )
            .bind(collection_id)
            .bind(generation_id)
            .bind(to_i64(source_head, "source head")?)
            .bind(&catalog_revision)
            .bind(to_i64(format_version, "projection format version")?)
            .bind(&engine_version)
            .fetch_one(&mut *transaction)
            .await?;
            if stale_exists {
                last_record_id = None;
            } else {
                phase_advanced = true;
            }
        }
        let updated = sqlx::query(
            r#"UPDATE hosted_provider_projection_generations
               SET checkpoint_record_id = $6,
                   projected_records = projected_records + $7,
                   phase = CASE WHEN $8 THEN 'resolution' ELSE phase END,
                   resolved_records = CASE WHEN $8 THEN 0 ELSE resolved_records END,
                   updated_at = now()
               WHERE collection_id = $1 AND generation_id = $2
                 AND status = 'building' AND phase = 'projection'
                 AND lease_owner = $3 AND lease_fencing_generation = $4
                 AND lease_expires_at > now()
                 AND target_catalog_revision = $5"#,
        )
        .bind(collection_id)
        .bind(generation_id)
        .bind(self.process_epoch)
        .bind(to_i64(fence, "projection lease fence")?)
        .bind(&catalog_revision)
        .bind(if phase_advanced { None } else { last_record_id })
        .bind(to_i64(projected, "projected record count")?)
        .bind(phase_advanced)
        .execute(&mut *transaction)
        .await?;
        if updated.rows_affected() != 1 {
            return Err(projection_lease_unavailable());
        }
        transaction.commit().await?;
        tracing::info!(
            target: "mdbase_connect::metrics",
            metric = "hosted_projection_batch",
            records_projected = projected,
            ciphertext_bytes,
            projection_bytes,
            phase_advanced,
            elapsed_ms = started.elapsed().as_millis() as u64,
            "privacy-safe hosted provider metric"
        );
        Ok(HostedProjectionBatch {
            generation: HostedProjectionGeneration {
                collection_id,
                generation_id,
                catalog_revision,
                projection_format_version: format_version as u32,
                semantic_engine_version: engine_version,
                source_head,
                phase: if phase_advanced {
                    "resolution".to_string()
                } else {
                    "projection".to_string()
                },
                status: "building".to_string(),
                lease_fencing_generation: fence,
            },
            records_projected: projected,
            records_resolved: 0,
            ciphertext_bytes,
            projection_bytes,
            phase_advanced,
        })
    }

    /// Resolve at most one bounded batch of prepared structural projections.
    /// Lookup rows are produced only by exact joins against mdbase-rs-planned
    /// keys; mdbase-rs remains responsible for priority and ambiguity rules.
    pub async fn resolve_generation_batch(
        &self,
        collection_id: Uuid,
        generation_id: Uuid,
        requested_limit: u64,
    ) -> ApiResult<HostedProjectionBatch> {
        let limit = requested_limit.clamp(1, MAX_PROJECTION_BATCH);
        let started = Instant::now();
        let mut transaction = self.pool.begin().await?;
        sqlx::query("SET LOCAL statement_timeout = 15000")
            .execute(&mut *transaction)
            .await?;
        let may_complete: bool = sqlx::query_scalar(
            r#"SELECT NOT EXISTS (
                 SELECT 1 FROM hosted_provider_record_projections
                 WHERE collection_id = $1 AND generation_id = $2
                   AND valid_to_sequence IS NULL AND resolution_complete = false
               )"#,
        )
        .bind(collection_id)
        .bind(generation_id)
        .fetch_one(&mut *transaction)
        .await?;
        if may_complete {
            // Every path that can lock both rows uses collection -> generation.
            // Ordinary resolution batches never need the collection row lock.
            sqlx::query(
                "SELECT id FROM hosted_provider_collections WHERE id = $1 AND state = 'active' FOR UPDATE",
            )
            .bind(collection_id)
            .fetch_optional(&mut *transaction)
            .await?
            .ok_or_else(projection_binding_changed)?;
        }
        let generation = sqlx::query(
            r#"UPDATE hosted_provider_projection_generations
               SET lease_owner = $3,
                   lease_expires_at = now() + make_interval(secs => $4),
                   lease_fencing_generation = lease_fencing_generation + 1,
                   updated_at = now()
               WHERE collection_id = $1 AND generation_id = $2
                 AND status = 'building' AND phase = 'resolution'
                 AND (lease_owner IS NULL OR lease_owner = $3 OR lease_expires_at <= now())
               RETURNING target_catalog_revision, projection_format_version,
                         semantic_engine_version, source_head, checkpoint_record_id,
                         lease_fencing_generation"#,
        )
        .bind(collection_id)
        .bind(generation_id)
        .bind(self.process_epoch)
        .bind(PROJECTION_LEASE_SECONDS)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or_else(projection_lease_unavailable)?;
        let catalog_revision: String = generation.get("target_catalog_revision");
        let format_version = number(
            i64::from(generation.get::<i32, _>("projection_format_version")),
            "projection format version",
        )?;
        let engine_version: String = generation.get("semantic_engine_version");
        let source_head = number(generation.get::<i64, _>("source_head"), "source head")?;
        let checkpoint: Option<Uuid> = generation.get("checkpoint_record_id");
        let fence = number(
            generation.get::<i64, _>("lease_fencing_generation"),
            "projection lease fence",
        )?;
        if format_version != u64::from(mdbase::runtime::SEMANTIC_PROJECTION_FORMAT_VERSION)
            || engine_version != mdbase::VERSION
        {
            return Err(ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "projection_engine_mismatch",
                "The projection generation requires a different semantic engine.",
            ));
        }

        let collection = sqlx::query(
            r#"SELECT resource_revision, wrapped_data_key, resources_ciphertext
               FROM hosted_provider_collections
               WHERE id = $1 AND state = 'active'"#,
        )
        .bind(collection_id)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or_else(projection_binding_changed)?;
        let data_key = self
            .collection_key(collection_id, collection.get("wrapped_data_key"))
            .await?;
        let resources: SyncCollectionResources = self.crypto.decrypt_json(
            &data_key,
            collection.get("resources_ciphertext"),
            &resources_aad(collection_id),
        )?;
        if resources.revision != collection.get::<String, _>("resource_revision") {
            return Err(projection_binding_changed());
        }
        let resource_documents =
            load_resource_documents(&mut transaction, &self.crypto, &data_key, collection_id)
                .await?;
        let catalog = compile_point_catalog(resources, resource_documents)?;
        if catalog.resource_revision() != catalog_revision {
            return Err(projection_binding_changed());
        }
        let rows = sqlx::query(
            r#"WITH candidates AS MATERIALIZED (
                 SELECT record_id, valid_from_sequence, record_revision, semantic_projection,
                        projection_bytes
                 FROM hosted_provider_record_projections
                 WHERE collection_id = $1 AND generation_id = $2
                   AND valid_to_sequence IS NULL AND resolution_complete = false
                   AND ($3::uuid IS NULL OR record_id > $3)
                 ORDER BY record_id
                 LIMIT $4
               ), eligible AS (
                 SELECT record_id, valid_from_sequence, record_revision, semantic_projection,
                        sum(projection_bytes) OVER (ORDER BY record_id) AS batch_bytes
                 FROM candidates
               )
               SELECT record_id, valid_from_sequence, record_revision, semantic_projection
               FROM eligible
               WHERE batch_bytes <= $5
               ORDER BY record_id"#,
        )
        .bind(collection_id)
        .bind(generation_id)
        .bind(checkpoint)
        .bind(to_i64(limit, "resolution batch limit")?)
        .bind(to_i64(
            MAX_RESOLUTION_BATCH_PROJECTION_BYTES,
            "resolution batch byte limit",
        )?)
        .fetch_all(&mut *transaction)
        .await?;

        let mut resolved_count = 0_u64;
        let mut projection_bytes = 0_u64;
        let mut last_record_id = checkpoint;
        for row in &rows {
            let record_id: Uuid = row.get("record_id");
            let valid_from = number(
                row.get::<i64, _>("valid_from_sequence"),
                "projection sequence",
            )?;
            let record_revision: String = row.get("record_revision");
            let prepared: mdbase::runtime::PreparedSemanticProjection =
                serde_json::from_value(row.get("semantic_projection")).map_err(|error| {
                    ApiError::internal(format!(
                        "Prepared semantic projection could not decode: {error}"
                    ))
                })?;
            let plan = catalog
                .plan_record_resolution(&prepared.structure)
                .map_err(projection_semantic_error)?;
            let candidates =
                load_resolution_candidates(&mut transaction, collection_id, generation_id, &plan)
                    .await?;
            let resolved = catalog
                .resolve_record_structure(&prepared.structure, &plan, &candidates)
                .map_err(projection_semantic_error)?;
            let final_projection = catalog
                .finalize_projection(prepared, resolved)
                .map_err(projection_semantic_error)?;
            let bytes = final_projection.canonical_json().map_err(|error| {
                ApiError::internal(format!(
                    "Final semantic projection could not serialize: {error}"
                ))
            })?;
            if bytes.len() > 262_144 {
                let observed = bytes.len() as u64;
                abandon_projection_generation_for_terminal_error(
                    &mut transaction,
                    collection_id,
                    generation_id,
                    self.process_epoch,
                    fence,
                    &catalog_revision,
                    "projection_record_too_large",
                )
                .await?;
                transaction.commit().await?;
                return Err(projection_record_too_large(
                    "semantic_projection_bytes",
                    262_144,
                    observed,
                ));
            }
            persist_resolved_projection(
                &mut transaction,
                collection_id,
                generation_id,
                &catalog_revision,
                self.process_epoch,
                fence,
                record_id,
                valid_from,
                &record_revision,
                &final_projection,
                &bytes,
            )
            .await?;
            resolved_count = resolved_count.saturating_add(1);
            projection_bytes = projection_bytes.saturating_add(bytes.len() as u64);
            last_record_id = Some(record_id);
        }

        let mut completed = false;
        if rows.is_empty() {
            let unsettled: bool = sqlx::query_scalar(
                r#"WITH snapshot AS (
                     SELECT DISTINCT ON (record_id)
                       record_id, revision, sequence, deleted
                     FROM hosted_provider_record_versions
                     WHERE collection_id = $1 AND sequence <= $3
                     ORDER BY record_id, sequence DESC
                   ), live AS (
                     SELECT record_id, revision, sequence FROM snapshot WHERE deleted = false
                   )
                   SELECT EXISTS (
                     SELECT 1 FROM live r
                     LEFT JOIN hosted_provider_record_projections p
                       ON p.collection_id = $1 AND p.record_id = r.record_id
                      AND p.valid_to_sequence IS NULL
                      AND p.generation_id = $2
                     WHERE p.record_id IS NULL OR p.record_revision <> r.revision
                        OR p.record_sequence <> r.sequence
                        OR p.catalog_revision <> $4
                        OR p.projection_format_version <> $5
                        OR p.semantic_engine_version <> $6
                        OR NOT hosted_provider_projection_digest_valid(
                          p.projection_digest, p.projection_observed_digest)
                        OR NOT p.semantic_complete
                        OR NOT p.resolution_complete
                     UNION ALL
                     SELECT 1 FROM hosted_provider_record_projections p
                     LEFT JOIN live r ON r.record_id = p.record_id
                     WHERE p.collection_id = $1 AND p.generation_id = $2
                       AND p.valid_to_sequence IS NULL AND r.record_id IS NULL
                   )"#,
            )
            .bind(collection_id)
            .bind(generation_id)
            .bind(to_i64(source_head, "source head")?)
            .bind(&catalog_revision)
            .bind(to_i64(format_version, "projection format version")?)
            .bind(&engine_version)
            .fetch_one(&mut *transaction)
            .await?;
            if unsettled {
                // A concurrent record/catalog update invalidated prior work.
                // Return to preparation; the lease/fence and record CAS make
                // this restart idempotent.
                let restarted = sqlx::query(
                    r#"UPDATE hosted_provider_projection_generations
                       SET phase = 'projection', checkpoint_record_id = NULL,
                           updated_at = now(), last_error_code = 'concurrent_change'
                       WHERE collection_id = $1 AND generation_id = $2
                         AND status = 'building' AND phase = 'resolution'
                         AND lease_owner = $3 AND lease_fencing_generation = $4
                         AND lease_expires_at > now()"#,
                )
                .bind(collection_id)
                .bind(generation_id)
                .bind(self.process_epoch)
                .bind(to_i64(fence, "projection lease fence")?)
                .execute(&mut *transaction)
                .await?;
                if restarted.rows_affected() != 1 {
                    return Err(projection_lease_unavailable());
                }
                transaction.commit().await?;
                return Ok(HostedProjectionBatch {
                    generation: HostedProjectionGeneration {
                        collection_id,
                        generation_id,
                        catalog_revision,
                        projection_format_version: format_version as u32,
                        semantic_engine_version: engine_version,
                        source_head,
                        phase: "projection".to_string(),
                        status: "building".to_string(),
                        lease_fencing_generation: fence,
                    },
                    records_projected: 0,
                    records_resolved: 0,
                    ciphertext_bytes: 0,
                    projection_bytes: 0,
                    phase_advanced: true,
                });
            }
            completed = true;
        }
        if completed {
            let activated = sqlx::query(
                r#"UPDATE hosted_provider_collections
                   SET active_catalog_revision = $3,
                       active_projection_format_version = $4,
                       active_semantic_engine_version = $5,
                       active_projection_generation_id = $2,
                       updated_at = now()
                   WHERE id = $1 AND state = 'active' AND head = $6
                   "#,
            )
            .bind(collection_id)
            .bind(generation_id)
            .bind(&catalog_revision)
            .bind(to_i64(format_version, "projection format version")?)
            .bind(&engine_version)
            .bind(to_i64(source_head, "source head")?)
            .execute(&mut *transaction)
            .await?;
            if activated.rows_affected() != 1 {
                let abandoned = sqlx::query(
                    r#"UPDATE hosted_provider_projection_generations
                       SET status = 'abandoned', abandoned_at = now(), updated_at = now(),
                           lease_owner = NULL, lease_expires_at = NULL,
                           last_error_code = 'source_head_changed'
                       WHERE collection_id = $1 AND generation_id = $2
                         AND status = 'building' AND phase = 'resolution'
                         AND lease_owner = $3 AND lease_fencing_generation = $4
                         AND lease_expires_at > now()"#,
                )
                .bind(collection_id)
                .bind(generation_id)
                .bind(self.process_epoch)
                .bind(to_i64(fence, "projection lease fence")?)
                .execute(&mut *transaction)
                .await?;
                if abandoned.rows_affected() != 1 {
                    return Err(projection_lease_unavailable());
                }
                transaction.commit().await?;
                return Err(projection_source_changed());
            }
        }
        let updated = sqlx::query(
            r#"UPDATE hosted_provider_projection_generations
               SET checkpoint_record_id = $6,
                   resolved_records = resolved_records + $7,
                   status = CASE WHEN $8 THEN 'complete' ELSE status END,
                   completed_at = CASE WHEN $8 THEN now() ELSE completed_at END,
                   lease_owner = CASE WHEN $8 THEN NULL ELSE lease_owner END,
                   lease_expires_at = CASE WHEN $8 THEN NULL ELSE lease_expires_at END,
                   last_error_code = NULL,
                   updated_at = now()
               WHERE collection_id = $1 AND generation_id = $2
                 AND status = 'building' AND phase = 'resolution'
                 AND lease_owner = $3 AND lease_fencing_generation = $4
                 AND lease_expires_at > now()
                 AND target_catalog_revision = $5"#,
        )
        .bind(collection_id)
        .bind(generation_id)
        .bind(self.process_epoch)
        .bind(to_i64(fence, "projection lease fence")?)
        .bind(&catalog_revision)
        .bind(if completed { None } else { last_record_id })
        .bind(to_i64(resolved_count, "resolved record count")?)
        .bind(completed)
        .execute(&mut *transaction)
        .await?;
        if updated.rows_affected() != 1 {
            return Err(projection_lease_unavailable());
        }
        transaction.commit().await?;
        tracing::info!(
            target: "mdbase_connect::metrics",
            metric = "hosted_projection_resolution_batch",
            records_resolved = resolved_count,
            projection_bytes,
            completed,
            elapsed_ms = started.elapsed().as_millis() as u64,
            "privacy-safe hosted provider metric"
        );
        Ok(HostedProjectionBatch {
            generation: HostedProjectionGeneration {
                collection_id,
                generation_id,
                catalog_revision,
                projection_format_version: format_version as u32,
                semantic_engine_version: engine_version,
                source_head,
                phase: "resolution".to_string(),
                status: if completed {
                    "complete".to_string()
                } else {
                    "building".to_string()
                },
                lease_fencing_generation: fence,
            },
            records_projected: 0,
            records_resolved: resolved_count,
            ciphertext_bytes: 0,
            projection_bytes,
            phase_advanced: completed,
        })
    }
}

include!("projections/pruning.rs");
include!("projections/rebuild_limits.rs");
include!("projections/activation.rs");
include!("projections/persistence.rs");
include!("projections/catalog_binding.rs");
