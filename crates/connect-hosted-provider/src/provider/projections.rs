use super::operation_reads::compile_point_catalog;
use super::*;

const PROJECTION_LEASE_SECONDS: i64 = 30;
const MAX_PROJECTION_BATCH: u64 = 200;

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

impl HostedProvider {
    /// Open an inactive-by-default Candidate B generation for one collection.
    /// Exact ciphertext remains authoritative and ordinary reads keep their
    /// compatibility path until this generation is complete.
    pub async fn start_projection_generation(
        &self,
        collection_id: Uuid,
    ) -> ApiResult<HostedProjectionGeneration> {
        let generation_id = Uuid::new_v4();
        let mut transaction = self.pool.begin().await?;
        let row = sqlx::query(
            r#"SELECT head, resource_revision
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
        let catalog_revision: String = row.get("resource_revision");
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
        sqlx::query(
            r#"INSERT INTO hosted_provider_projection_generations
                 (collection_id, generation_id, target_catalog_revision,
                  projection_format_version, semantic_engine_version, source_head,
                  lease_owner, lease_expires_at, lease_fencing_generation)
               VALUES ($1, $2, $3, $4, $5, $6, $7,
                       now() + make_interval(secs => $8), 1)"#,
        )
        .bind(collection_id)
        .bind(generation_id)
        .bind(&catalog_revision)
        .bind(i64::from(format_version))
        .bind(engine_version)
        .bind(to_i64(source_head, "collection head")?)
        .bind(self.process_epoch)
        .bind(PROJECTION_LEASE_SECONDS)
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            r#"UPDATE hosted_provider_collections
               SET active_catalog_revision = $2,
                   active_projection_format_version = $3,
                   active_semantic_engine_version = $4,
                   active_projection_generation_id = $5,
                   updated_at = now()
               WHERE id = $1"#,
        )
        .bind(collection_id)
        .bind(&catalog_revision)
        .bind(i64::from(format_version))
        .bind(engine_version)
        .bind(generation_id)
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
            generation.get::<i64, _>("projection_format_version"),
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
               WHERE id = $1 AND active_projection_generation_id = $2
                 AND active_catalog_revision = $3"#,
        )
        .bind(collection_id)
        .bind(generation_id)
        .bind(&catalog_revision)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or_else(projection_binding_changed)?;
        if collection.get::<String, _>("resource_revision") != catalog_revision {
            return Err(projection_binding_changed());
        }
        let data_key = self
            .collection_key(collection_id, collection.get("wrapped_data_key"))
            .await?;
        let resources: SyncCollectionResources = self.crypto.decrypt_json(
            &data_key,
            collection.get("resources_ciphertext"),
            &resources_aad(collection_id),
        )?;
        let resource_documents =
            load_resource_documents(&mut transaction, &self.crypto, &data_key, collection_id)
                .await?;
        let catalog = compile_point_catalog(resources, resource_documents)?;
        if catalog.resource_revision() != catalog_revision {
            return Err(projection_binding_changed());
        }

        let rows = sqlx::query(
            r#"SELECT record_id, sequence, revision, payload_ciphertext
               FROM hosted_provider_records
               WHERE collection_id = $1 AND ($2::uuid IS NULL OR record_id > $2)
               ORDER BY record_id
               LIMIT $3"#,
        )
        .bind(collection_id)
        .bind(checkpoint)
        .bind(to_i64(limit, "projection batch limit")?)
        .fetch_all(&mut *transaction)
        .await?;
        let mut projected = 0_u64;
        let mut ciphertext_bytes = 0_u64;
        let mut projection_bytes = 0_u64;
        let mut last_record_id = checkpoint;
        for row in &rows {
            let record_id: Uuid = row.get("record_id");
            let sequence = number(row.get::<i64, _>("sequence"), "record sequence")?;
            let revision: String = row.get("revision");
            let ciphertext: Vec<u8> = row.get("payload_ciphertext");
            ciphertext_bytes = ciphertext_bytes.saturating_add(ciphertext.len() as u64);
            let record: PersistedRecord = self.crypto.decrypt_json(
                &data_key,
                &ciphertext,
                &current_record_aad(collection_id, record_id, sequence),
            )?;
            if record.record_id != record_id || record.revision != revision {
                return Err(ApiError::internal(
                    "The exact record does not match its projection CAS metadata.",
                ));
            }
            let prepared = catalog
                .project_record(&mdbase::runtime::CanonicalRecordInput {
                    stable_id: Some(record_id.to_string()),
                    path: record.path,
                    document: record.document,
                    file_size: 0,
                    file_mtime: None,
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
                return Err(projection_budget("projection_bytes"));
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
            last_record_id = Some(record_id);
        }

        let mut phase_advanced = false;
        if rows.is_empty() {
            let stale_exists: bool = sqlx::query_scalar(
                r#"SELECT EXISTS (
                     SELECT 1 FROM hosted_provider_records r
                     LEFT JOIN hosted_provider_record_projections p
                       ON p.collection_id = r.collection_id
                      AND p.record_id = r.record_id
                      AND p.valid_to_sequence IS NULL
                      AND p.generation_id = $2
                     WHERE r.collection_id = $1
                       AND (p.record_id IS NULL OR p.record_revision <> r.revision)
                   )"#,
            )
            .bind(collection_id)
            .bind(generation_id)
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
            generation.get::<i64, _>("projection_format_version"),
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
               WHERE id = $1 AND active_projection_generation_id = $2
                 AND active_catalog_revision = $3"#,
        )
        .bind(collection_id)
        .bind(generation_id)
        .bind(&catalog_revision)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or_else(projection_binding_changed)?;
        if collection.get::<String, _>("resource_revision") != catalog_revision {
            return Err(projection_binding_changed());
        }
        let data_key = self
            .collection_key(collection_id, collection.get("wrapped_data_key"))
            .await?;
        let resources: SyncCollectionResources = self.crypto.decrypt_json(
            &data_key,
            collection.get("resources_ciphertext"),
            &resources_aad(collection_id),
        )?;
        let resource_documents =
            load_resource_documents(&mut transaction, &self.crypto, &data_key, collection_id)
                .await?;
        let catalog = compile_point_catalog(resources, resource_documents)?;
        if catalog.resource_revision() != catalog_revision {
            return Err(projection_binding_changed());
        }
        let rows = sqlx::query(
            r#"SELECT record_id, valid_from_sequence, record_revision, semantic_projection
               FROM hosted_provider_record_projections
               WHERE collection_id = $1 AND generation_id = $2
                 AND valid_to_sequence IS NULL AND resolution_complete = false
                 AND ($3::uuid IS NULL OR record_id > $3)
               ORDER BY record_id
               LIMIT $4"#,
        )
        .bind(collection_id)
        .bind(generation_id)
        .bind(checkpoint)
        .bind(to_i64(limit, "resolution batch limit")?)
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
                return Err(projection_budget("projection_bytes"));
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
                r#"SELECT EXISTS (
                     SELECT 1 FROM hosted_provider_records r
                     LEFT JOIN hosted_provider_record_projections p
                       ON p.collection_id = r.collection_id
                      AND p.record_id = r.record_id
                      AND p.valid_to_sequence IS NULL
                      AND p.generation_id = $2
                     WHERE r.collection_id = $1
                       AND (p.record_id IS NULL OR p.record_revision <> r.revision
                            OR p.resolution_complete = false)
                   )"#,
            )
            .bind(collection_id)
            .bind(generation_id)
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
                         AND lease_owner = $3 AND lease_fencing_generation = $4"#,
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

async fn load_resolution_candidates(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
    generation_id: Uuid,
    plan: &mdbase::runtime::RecordResolutionPlan,
) -> ApiResult<Vec<mdbase::runtime::ResolutionCandidate>> {
    let requested = plan
        .lookups
        .iter()
        .flat_map(|lookup| {
            lookup.alternatives.iter().map(move |alternative| {
                json!({
                    "occurrence_ordinal": lookup.occurrence_ordinal,
                    "priority": alternative.priority,
                    "key_kind": resolution_key_kind(alternative.kind),
                    "lookup_key": alternative.value,
                })
            })
        })
        .collect::<Vec<_>>();
    if requested.is_empty() {
        return Ok(Vec::new());
    }
    let rows = sqlx::query(
        r#"WITH requested AS (
             SELECT * FROM jsonb_to_recordset($3::jsonb) AS q(
               occurrence_ordinal bigint,
               priority integer,
               key_kind text,
               lookup_key text
             )
           )
           SELECT q.occurrence_ordinal, q.priority, q.key_kind, q.lookup_key,
                  k.record_id, p.canonical_path
           FROM requested q
           JOIN hosted_provider_record_resolution_keys k
             ON k.collection_id = $1 AND k.generation_id = $2
            AND k.valid_to_sequence IS NULL
            AND k.key_kind = q.key_kind AND k.lookup_key = q.lookup_key
           JOIN hosted_provider_record_projections p
             ON p.collection_id = k.collection_id AND p.record_id = k.record_id
            AND p.generation_id = k.generation_id AND p.valid_to_sequence IS NULL
           ORDER BY q.occurrence_ordinal, q.priority, k.record_id
           LIMIT $4"#,
    )
    .bind(collection_id)
    .bind(generation_id)
    .bind(Value::Array(requested))
    .bind((mdbase::runtime::MAX_RESOLUTION_CANDIDATES + 1) as i64)
    .fetch_all(&mut **transaction)
    .await?;
    if rows.len() > mdbase::runtime::MAX_RESOLUTION_CANDIDATES {
        return Err(projection_budget("relationship_candidates"));
    }
    rows.into_iter()
        .map(|row| {
            let kind: String = row.get("key_kind");
            Ok(mdbase::runtime::ResolutionCandidate {
                occurrence_ordinal: number(
                    row.get::<i64, _>("occurrence_ordinal"),
                    "relationship occurrence ordinal",
                )? as usize,
                lookup: mdbase::runtime::ResolutionLookupKey {
                    priority: number(
                        i64::from(row.get::<i32, _>("priority")),
                        "relationship lookup priority",
                    )? as u16,
                    kind: parse_resolution_key_kind(&kind)?,
                    value: row.get("lookup_key"),
                },
                record_id: row.get::<Uuid, _>("record_id").to_string(),
                path: row.get("canonical_path"),
            })
        })
        .collect()
}

#[allow(clippy::too_many_arguments)]
async fn persist_prepared_projection(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
    generation_id: Uuid,
    catalog_revision: &str,
    engine_version: &str,
    fence: u64,
    record_id: Uuid,
    sequence: u64,
    revision: &str,
    prepared: &mdbase::runtime::PreparedSemanticProjection,
    canonical_bytes: &[u8],
) -> ApiResult<()> {
    let cas_matches: bool = sqlx::query_scalar(
        r#"SELECT EXISTS (
             SELECT 1 FROM hosted_provider_records r
             JOIN hosted_provider_projection_generations g
               ON g.collection_id = r.collection_id AND g.generation_id = $3
             JOIN hosted_provider_collections c
               ON c.id = r.collection_id
             WHERE r.collection_id = $1 AND r.record_id = $2
               AND r.sequence = $4 AND r.revision = $5
               AND g.status = 'building' AND g.phase = 'projection'
               AND g.lease_fencing_generation = $6
               AND g.lease_expires_at > now()
               AND g.target_catalog_revision = $7
               AND c.active_projection_generation_id = g.generation_id
               AND c.active_catalog_revision = g.target_catalog_revision
           )"#,
    )
    .bind(collection_id)
    .bind(record_id)
    .bind(generation_id)
    .bind(to_i64(sequence, "record sequence")?)
    .bind(revision)
    .bind(to_i64(fence, "projection lease fence")?)
    .bind(catalog_revision)
    .fetch_one(&mut **transaction)
    .await?;
    if !cas_matches {
        return Err(ApiError::conflict(
            "projection_cas_lost",
            "The exact record or projection generation changed during projection.",
        ));
    }
    close_or_replace_projection_versions(transaction, collection_id, record_id, sequence).await?;
    let projection_value: Value = serde_json::from_slice(canonical_bytes).map_err(|error| {
        ApiError::internal(format!(
            "Semantic projection JSON could not decode: {error}"
        ))
    })?;
    let projection_digest = Sha256::digest(canonical_bytes).to_vec();
    let structural_digest = decode_sha256(&prepared.structure.structural_digest)?;
    sqlx::query(
        r#"INSERT INTO hosted_provider_record_projections
             (collection_id, record_id, valid_from_sequence, record_revision,
              catalog_revision, projection_format_version, semantic_engine_version,
              generation_id, canonical_path, matched_types, file_size_bytes,
              file_modified_at, semantic_complete, resolution_complete,
              semantic_projection, projection_digest, structural_digest, projection_bytes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NULL,
                   false, false, $12, $13, $14, $15)"#,
    )
    .bind(collection_id)
    .bind(record_id)
    .bind(to_i64(sequence, "record sequence")?)
    .bind(revision)
    .bind(catalog_revision)
    .bind(i64::from(prepared.facts.format_version))
    .bind(engine_version)
    .bind(generation_id)
    .bind(&prepared.facts.path)
    .bind(&prepared.facts.types)
    .bind(to_i64(prepared.facts.file.size, "projected file size")?)
    .bind(projection_value)
    .bind(projection_digest)
    .bind(structural_digest)
    .bind(to_i64(canonical_bytes.len() as u64, "projection size")?)
    .execute(&mut **transaction)
    .await?;
    for key in &prepared.facts.resolution_keys {
        sqlx::query(
            r#"INSERT INTO hosted_provider_record_resolution_keys
                 (collection_id, record_id, key_kind, lookup_key, record_revision,
                  catalog_revision, projection_format_version, semantic_engine_version,
                  generation_id, valid_from_sequence)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)"#,
        )
        .bind(collection_id)
        .bind(record_id)
        .bind(resolution_key_kind(key.kind))
        .bind(&key.value)
        .bind(revision)
        .bind(catalog_revision)
        .bind(i64::from(prepared.facts.format_version))
        .bind(engine_version)
        .bind(generation_id)
        .bind(to_i64(sequence, "record sequence")?)
        .execute(&mut **transaction)
        .await?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn persist_resolved_projection(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
    generation_id: Uuid,
    catalog_revision: &str,
    lease_owner: Uuid,
    fence: u64,
    record_id: Uuid,
    valid_from: u64,
    record_revision: &str,
    projection: &mdbase::runtime::SemanticProjection,
    canonical_bytes: &[u8],
) -> ApiResult<()> {
    let projection_value: Value = serde_json::from_slice(canonical_bytes).map_err(|error| {
        ApiError::internal(format!(
            "Final semantic projection JSON could not decode: {error}"
        ))
    })?;
    let projection_digest = Sha256::digest(canonical_bytes).to_vec();
    let updated = sqlx::query(
        r#"UPDATE hosted_provider_record_projections p
           SET semantic_complete = $8, resolution_complete = true,
               semantic_projection = $9, projection_digest = $10,
               projection_bytes = $11, updated_at = now()
           FROM hosted_provider_projection_generations g,
                hosted_provider_collections c,
                hosted_provider_records r
           WHERE p.collection_id = $1 AND p.record_id = $2
             AND p.generation_id = $3 AND p.valid_from_sequence = $4
             AND p.valid_to_sequence IS NULL AND p.record_revision = $5
             AND g.collection_id = p.collection_id AND g.generation_id = p.generation_id
             AND g.status = 'building' AND g.phase = 'resolution'
             AND g.lease_owner = $6 AND g.lease_fencing_generation = $7
             AND g.lease_expires_at > now()
             AND g.target_catalog_revision = $12
             AND c.id = p.collection_id
             AND c.active_projection_generation_id = p.generation_id
             AND c.active_catalog_revision = g.target_catalog_revision
             AND r.collection_id = p.collection_id AND r.record_id = p.record_id
             AND r.sequence = p.valid_from_sequence AND r.revision = p.record_revision"#,
    )
    .bind(collection_id)
    .bind(record_id)
    .bind(generation_id)
    .bind(to_i64(valid_from, "projection sequence")?)
    .bind(record_revision)
    .bind(lease_owner)
    .bind(to_i64(fence, "projection lease fence")?)
    .bind(projection.facts.semantic_complete)
    .bind(projection_value)
    .bind(projection_digest)
    .bind(to_i64(canonical_bytes.len() as u64, "projection size")?)
    .bind(catalog_revision)
    .execute(&mut **transaction)
    .await?;
    if updated.rows_affected() != 1 {
        return Err(ApiError::conflict(
            "projection_cas_lost",
            "The record or generation changed during relationship resolution.",
        ));
    }

    for occurrence in &projection.structure.occurrences {
        let Some(resolution_state) = relationship_resolution_state(occurrence.resolution) else {
            continue;
        };
        let target_record_id = occurrence
            .target_record_id
            .as_deref()
            .map(Uuid::parse_str)
            .transpose()
            .map_err(|_| {
                ApiError::internal("Resolved relationship target identity is not a UUID.")
            })?;
        let occurrence_bytes = serde_jcs::to_vec(&occurrence.occurrence).map_err(|error| {
            ApiError::internal(format!(
                "Relationship occurrence could not serialize: {error}"
            ))
        })?;
        sqlx::query(
            r#"INSERT INTO hosted_provider_record_relationships
                 (collection_id, source_record_id, occurrence_key, valid_from_sequence,
                  source_record_revision, catalog_revision, projection_format_version,
                  semantic_engine_version, generation_id, relationship_kind, source_field,
                  raw_target, normalized_target, alias, anchor, is_relative,
                  resolution_state, target_record_id, target_path)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                       $13, $14, $15, $16, $17, $18, $19)"#,
        )
        .bind(collection_id)
        .bind(record_id)
        .bind(Sha256::digest(occurrence_bytes).to_vec())
        .bind(to_i64(valid_from, "projection sequence")?)
        .bind(record_revision)
        .bind(catalog_revision)
        .bind(i64::from(projection.facts.format_version))
        .bind(&projection.facts.semantic_engine_version)
        .bind(generation_id)
        .bind(relationship_kind(occurrence.occurrence.kind))
        .bind(&occurrence.occurrence.field)
        .bind(&occurrence.occurrence.raw_target)
        .bind(
            occurrence
                .occurrence
                .normalized_target
                .as_deref()
                .unwrap_or(&occurrence.occurrence.raw_target),
        )
        .bind(&occurrence.occurrence.alias)
        .bind(&occurrence.occurrence.anchor)
        .bind(occurrence.occurrence.relative)
        .bind(resolution_state)
        .bind(target_record_id)
        .bind(&occurrence.target_path)
        .execute(&mut **transaction)
        .await?;
    }
    Ok(())
}

async fn close_or_replace_projection_versions(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
    record_id: Uuid,
    sequence: u64,
) -> ApiResult<()> {
    let sequence = to_i64(sequence, "record sequence")?;
    sqlx::query(
        r#"DELETE FROM hosted_provider_record_relationships
           WHERE collection_id = $1 AND source_record_id = $2
             AND valid_to_sequence IS NULL AND valid_from_sequence >= $3"#,
    )
    .bind(collection_id)
    .bind(record_id)
    .bind(sequence)
    .execute(&mut **transaction)
    .await?;
    sqlx::query(
        r#"UPDATE hosted_provider_record_relationships SET valid_to_sequence = $3
           WHERE collection_id = $1 AND source_record_id = $2
             AND valid_to_sequence IS NULL AND valid_from_sequence < $3"#,
    )
    .bind(collection_id)
    .bind(record_id)
    .bind(sequence)
    .execute(&mut **transaction)
    .await?;
    sqlx::query(
        r#"DELETE FROM hosted_provider_record_resolution_keys
           WHERE collection_id = $1 AND record_id = $2
             AND valid_to_sequence IS NULL AND valid_from_sequence >= $3"#,
    )
    .bind(collection_id)
    .bind(record_id)
    .bind(sequence)
    .execute(&mut **transaction)
    .await?;
    sqlx::query(
        r#"UPDATE hosted_provider_record_resolution_keys SET valid_to_sequence = $3
           WHERE collection_id = $1 AND record_id = $2
             AND valid_to_sequence IS NULL AND valid_from_sequence < $3"#,
    )
    .bind(collection_id)
    .bind(record_id)
    .bind(sequence)
    .execute(&mut **transaction)
    .await?;
    sqlx::query(
        r#"DELETE FROM hosted_provider_record_projections
           WHERE collection_id = $1 AND record_id = $2
             AND valid_to_sequence IS NULL AND valid_from_sequence >= $3"#,
    )
    .bind(collection_id)
    .bind(record_id)
    .bind(sequence)
    .execute(&mut **transaction)
    .await?;
    sqlx::query(
        r#"UPDATE hosted_provider_record_projections SET valid_to_sequence = $3
           WHERE collection_id = $1 AND record_id = $2
             AND valid_to_sequence IS NULL AND valid_from_sequence < $3"#,
    )
    .bind(collection_id)
    .bind(record_id)
    .bind(sequence)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

fn resolution_key_kind(kind: mdbase::runtime::RecordResolutionKeyKind) -> &'static str {
    match kind {
        mdbase::runtime::RecordResolutionKeyKind::Path => "path",
        mdbase::runtime::RecordResolutionKeyKind::Basename => "basename",
        mdbase::runtime::RecordResolutionKeyKind::Id => "id",
        mdbase::runtime::RecordResolutionKeyKind::Title => "title",
    }
}

fn parse_resolution_key_kind(kind: &str) -> ApiResult<mdbase::runtime::RecordResolutionKeyKind> {
    match kind {
        "path" => Ok(mdbase::runtime::RecordResolutionKeyKind::Path),
        "basename" => Ok(mdbase::runtime::RecordResolutionKeyKind::Basename),
        "id" => Ok(mdbase::runtime::RecordResolutionKeyKind::Id),
        "title" => Ok(mdbase::runtime::RecordResolutionKeyKind::Title),
        _ => Err(ApiError::internal(
            "Stored relationship lookup key kind is unsupported.",
        )),
    }
}

fn relationship_kind(kind: mdbase::runtime::StructuralLinkKind) -> &'static str {
    match kind {
        mdbase::runtime::StructuralLinkKind::Wikilink => "wikilink",
        mdbase::runtime::StructuralLinkKind::MarkdownLink => "markdown_link",
        mdbase::runtime::StructuralLinkKind::WikilinkEmbed
        | mdbase::runtime::StructuralLinkKind::MarkdownImage => "embed",
        mdbase::runtime::StructuralLinkKind::Path => "frontmatter_link",
    }
}

fn relationship_resolution_state(
    state: mdbase::runtime::StructuralResolution,
) -> Option<&'static str> {
    match state {
        mdbase::runtime::StructuralResolution::Resolved => Some("resolved"),
        mdbase::runtime::StructuralResolution::Missing => Some("missing"),
        mdbase::runtime::StructuralResolution::Ambiguous => Some("ambiguous"),
        mdbase::runtime::StructuralResolution::UnsafeTraversal => Some("unsafe"),
        mdbase::runtime::StructuralResolution::External => Some("external"),
        mdbase::runtime::StructuralResolution::Malformed => None,
        mdbase::runtime::StructuralResolution::Unresolved => None,
    }
}

fn decode_sha256(value: &str) -> ApiResult<Vec<u8>> {
    let encoded = value.strip_prefix("sha256:").ok_or_else(|| {
        ApiError::internal("Semantic structural digest has an unsupported algorithm.")
    })?;
    if encoded.len() != 64 {
        return Err(ApiError::internal(
            "Semantic structural digest has an invalid length.",
        ));
    }
    (0..32)
        .map(|index| {
            u8::from_str_radix(&encoded[index * 2..index * 2 + 2], 16)
                .map_err(|_| ApiError::internal("Semantic structural digest is not hexadecimal."))
        })
        .collect()
}

fn projection_lease_unavailable() -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT,
        "projection_lease_unavailable",
        "The projection generation lease is unavailable or fenced.",
    )
}

fn projection_binding_changed() -> ApiError {
    ApiError::conflict(
        "projection_binding_changed",
        "The collection projection binding changed during rebuild.",
    )
}

fn projection_budget(kind: &str) -> ApiError {
    ApiError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        "hosted_query_budget_exceeded",
        "The semantic projection exceeds a hosted execution budget.",
    )
    .with_details(json!({"budget_kind": kind}))
}

fn projection_semantic_error(error: mdbase::runtime::CatalogError) -> ApiError {
    ApiError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        "projection_semantic_failure",
        "The structural projection could not be resolved canonically.",
    )
    .with_details(json!({"semantic_code": error.code}))
}

/// Canonically classify one exact point record for an authorization decision.
/// This is the fail-closed fallback until a current complete projection can be
/// proven against the same record/catalog binding. Persisted record `types` are
/// never accepted as current authorization evidence.
#[allow(clippy::too_many_arguments)]
pub(super) async fn canonical_record_scope_types(
    transaction: &mut Transaction<'_, Postgres>,
    provider: &HostedProvider,
    data_key: &[u8; 32],
    collection_id: Uuid,
    record_id: Uuid,
    sequence: u64,
    revision: String,
    ciphertext: Vec<u8>,
) -> ApiResult<Vec<String>> {
    let exact: PersistedRecord = provider.crypto.decrypt_json(
        data_key,
        &ciphertext,
        &current_record_aad(collection_id, record_id, sequence),
    )?;
    if exact.record_id != record_id || exact.revision != revision {
        return Err(ApiError::forbidden(
            "scope_classification_unavailable",
            "The current record could not be bound to canonical authorization evidence.",
        ));
    }
    let collection = sqlx::query(
        r#"SELECT resource_revision, resources_ciphertext
           FROM hosted_provider_collections
           WHERE id = $1 AND state = 'active'"#,
    )
    .bind(collection_id)
    .fetch_optional(&mut **transaction)
    .await?
    .ok_or_else(|| {
        ApiError::not_found(
            "hosted_collection_not_found",
            "Hosted collection not found.",
        )
    })?;
    let catalog_revision: String = collection.get("resource_revision");
    let resources: SyncCollectionResources = provider.crypto.decrypt_json(
        data_key,
        collection.get("resources_ciphertext"),
        &resources_aad(collection_id),
    )?;
    let documents =
        load_resource_documents(transaction, &provider.crypto, data_key, collection_id).await?;
    let catalog = compile_point_catalog(resources, documents)?;
    if catalog.resource_revision() != catalog_revision {
        return Err(ApiError::forbidden(
            "scope_classification_unavailable",
            "The semantic catalog changed during authorization.",
        ));
    }
    let projection = catalog
        .project_record(&mdbase::runtime::CanonicalRecordInput {
            stable_id: Some(record_id.to_string()),
            path: exact.path,
            document: exact.document,
            file_size: 0,
            file_mtime: None,
        })
        .map_err(|_| {
            ApiError::forbidden(
                "scope_classification_unavailable",
                "The exact record could not be canonically classified for authorization.",
            )
        })?;
    if !projection.facts.semantic_complete {
        return Err(ApiError::forbidden(
            "scope_classification_unavailable",
            "The exact record has incomplete semantic authorization evidence.",
        ));
    }
    Ok(projection.facts.types)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn structural_digest_decoder_is_strict() {
        assert_eq!(
            decode_sha256(&format!("sha256:{}", "ab".repeat(32))).unwrap(),
            vec![0xab; 32]
        );
        assert!(decode_sha256("sha256:00").is_err());
        assert!(decode_sha256(&format!("sha256:{}", "zz".repeat(32))).is_err());
        assert!(decode_sha256(&format!("sha512:{}", "00".repeat(32))).is_err());
    }

    #[test]
    fn projection_batch_is_hard_bounded() {
        assert_eq!(1_u64.clamp(1, MAX_PROJECTION_BATCH), 1);
        assert_eq!(u64::MAX.clamp(1, MAX_PROJECTION_BATCH), 200);
    }

    #[test]
    fn relationship_wire_mappings_are_closed() {
        assert_eq!(
            relationship_kind(mdbase::runtime::StructuralLinkKind::MarkdownImage),
            "embed"
        );
        assert_eq!(
            relationship_resolution_state(mdbase::runtime::StructuralResolution::UnsafeTraversal),
            Some("unsafe")
        );
        assert_eq!(
            relationship_resolution_state(mdbase::runtime::StructuralResolution::Malformed),
            None
        );
        assert!(parse_resolution_key_kind("invented").is_err());
    }
}
