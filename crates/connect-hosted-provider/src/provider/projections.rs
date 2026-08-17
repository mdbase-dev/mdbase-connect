use super::operation_reads::compile_point_catalog;
use super::*;

const PROJECTION_LEASE_SECONDS: i64 = 30;
const MAX_PROJECTION_BATCH: u64 = 200;
const MAX_PROJECTION_BATCH_CIPHERTEXT_BYTES: u64 = 16 * 1024 * 1024;
const MAX_RESOLUTION_BATCH_PROJECTION_BYTES: u64 = 16 * 1024 * 1024;
const MAX_RELATIONSHIP_REVALIDATION_RECORDS: usize = 200;
const MAX_RELATIONSHIP_REVALIDATION_BYTES: u64 = 32 * 1024 * 1024;
const MAX_RETAINED_PROJECTION_GENERATIONS: i64 = 4;

async fn enable_projection_digest_write(
    transaction: &mut Transaction<'_, Postgres>,
) -> ApiResult<()> {
    sqlx::query("SET LOCAL mdbase.projection_digest_write = 'on'")
        .execute(&mut **transaction)
        .await?;
    Ok(())
}

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

#[derive(Debug, Clone, Serialize)]
pub struct HostedProjectionStatus {
    pub collection_id: Uuid,
    pub execution_model: String,
    pub pending_execution_model: Option<String>,
    pub head: u64,
    pub resource_revision: String,
    pub active_generation_id: Option<Uuid>,
    pub building_generation: Option<HostedProjectionGeneration>,
    pub latest_terminal_generation_id: Option<Uuid>,
    pub latest_terminal_error_code: Option<String>,
}

#[derive(Debug, Clone)]
struct CandidateBActivationExpectation {
    head: u64,
    resource_revision: String,
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
        self.start_projection_generation_in(collection_id, true)
            .await?
            .ok_or_else(|| {
                ApiError::internal("An explicit projection generation start was suppressed.")
            })
    }

    async fn start_projection_generation_in(
        &self,
        collection_id: Uuid,
        supersede_building: bool,
    ) -> ApiResult<Option<HostedProjectionGeneration>> {
        self.start_projection_generation_with_expectation(collection_id, supersede_building, None)
            .await
    }

    async fn start_projection_generation_with_expectation(
        &self,
        collection_id: Uuid,
        supersede_building: bool,
        activation: Option<CandidateBActivationExpectation>,
    ) -> ApiResult<Option<HostedProjectionGeneration>> {
        let generation_id = Uuid::new_v4();
        let mut transaction = self.pool.begin().await?;
        let row = sqlx::query(
            r#"SELECT head, resource_revision, wrapped_data_key, resources_ciphertext,
                      hosted_execution_model, pending_hosted_execution_model
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
        let execution_model: String = row.get("hosted_execution_model");
        let pending_execution_model: Option<String> = row.get("pending_hosted_execution_model");
        if let Some(expected) = activation.as_ref() {
            let current_head = number(row.get::<i64, _>("head"), "collection head")?;
            let current_resource_revision: String = row.get("resource_revision");
            if current_head != expected.head
                || current_resource_revision != expected.resource_revision
            {
                return Err(ApiError::conflict(
                    "projection_activation_binding_changed",
                    "The collection head or resource revision changed before activation.",
                )
                .with_details(json!({
                    "expected_head": expected.head,
                    "actual_head": current_head,
                    "expected_resource_revision": expected.resource_revision,
                    "actual_resource_revision": current_resource_revision,
                })));
            }
            if execution_model == "candidate_b" {
                transaction.rollback().await?;
                return Ok(None);
            }
        }
        if activation.is_some() && pending_execution_model.as_deref() == Some("candidate_b") {
            let building = sqlx::query(
                r#"SELECT generation_id, target_catalog_revision,
                          projection_format_version, semantic_engine_version,
                          source_head, phase, status, lease_fencing_generation
                   FROM hosted_provider_projection_generations
                   WHERE collection_id = $1 AND status = 'building'
                   ORDER BY created_at DESC, generation_id DESC LIMIT 1"#,
            )
            .bind(collection_id)
            .fetch_optional(&mut *transaction)
            .await?;
            if let Some(building) = building {
                let generation = projection_generation_from_row(collection_id, &building)?;
                transaction.rollback().await?;
                return Ok(Some(generation));
            }
            let terminal_error: Option<String> = sqlx::query_scalar(
                r#"SELECT last_error_code
                   FROM hosted_provider_projection_generations
                   WHERE collection_id = $1 AND status = 'abandoned'
                     AND last_error_code IN (
                       'projection_record_too_large',
                       'projection_authority_invalid',
                       'projection_semantic_failure',
                       'projection_state_invalid'
                     )
                     AND source_head = $2
                     AND source_resource_revision = $3
                     AND projection_format_version = $4
                     AND semantic_engine_version = $5
                   ORDER BY updated_at DESC, generation_id DESC LIMIT 1"#,
            )
            .bind(collection_id)
            .bind(row.get::<i64, _>("head"))
            .bind(row.get::<String, _>("resource_revision"))
            .bind(i64::from(
                mdbase::runtime::SEMANTIC_PROJECTION_FORMAT_VERSION,
            ))
            .bind(mdbase::VERSION)
            .fetch_optional(&mut *transaction)
            .await?
            .flatten();
            if let Some(error_code) = terminal_error {
                return Err(ApiError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "projection_activation_quarantined",
                    "Candidate B activation is quarantined until exact authority or the semantic catalog changes.",
                )
                .with_details(json!({ "generation_error_code": error_code })));
            }
        }
        if !supersede_building {
            // Recovery selects missing work without locking every candidate.
            // Recheck after taking the collection lock so a stale selection
            // cannot supersede an explicit start that won the race.
            let building_exists: bool = sqlx::query_scalar(
                r#"SELECT EXISTS (
                     SELECT 1 FROM hosted_provider_projection_generations
                     WHERE collection_id = $1 AND status = 'building'
                   )"#,
            )
            .bind(collection_id)
            .fetch_one(&mut *transaction)
            .await?;
            if building_exists {
                transaction.rollback().await?;
                return Ok(None);
            }
        }
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
        if activation.is_some() {
            sqlx::query(
                r#"UPDATE hosted_provider_collections
                   SET pending_hosted_execution_model = 'candidate_b', updated_at = now()
                   WHERE id = $1 AND hosted_execution_model = 'legacy'"#,
            )
            .bind(collection_id)
            .execute(&mut *transaction)
            .await?;
        } else if pending_execution_model.as_deref() != Some("candidate_b") {
            sqlx::query(
                "UPDATE hosted_provider_collections SET hosted_execution_model = 'candidate_b' WHERE id = $1",
            )
            .bind(collection_id)
            .execute(&mut *transaction)
            .await?;
        }
        transaction.commit().await?;
        Ok(Some(HostedProjectionGeneration {
            collection_id,
            generation_id,
            catalog_revision,
            projection_format_version: format_version,
            semantic_engine_version: engine_version.to_string(),
            source_head,
            phase: "projection".to_string(),
            status: "building".to_string(),
            lease_fencing_generation: 1,
        }))
    }

    /// Record an initial Candidate B activation intent without changing the
    /// readable execution model. The complete projection generation is bound
    /// and activated atomically by the resolution completion transaction.
    pub async fn request_candidate_b_activation(
        &self,
        collection_id: Uuid,
        expected_head: u64,
        expected_resource_revision: String,
    ) -> ApiResult<HostedProjectionStatus> {
        self.start_projection_generation_with_expectation(
            collection_id,
            false,
            Some(CandidateBActivationExpectation {
                head: expected_head,
                resource_revision: expected_resource_revision,
            }),
        )
        .await?;
        self.projection_status(collection_id).await
    }

    pub async fn projection_status(
        &self,
        collection_id: Uuid,
    ) -> ApiResult<HostedProjectionStatus> {
        let row = sqlx::query(
            r#"SELECT collection.hosted_execution_model,
                      collection.pending_hosted_execution_model,
                      collection.head, collection.resource_revision,
                      collection.active_projection_generation_id,
                      generation.generation_id, generation.target_catalog_revision,
                      generation.projection_format_version,
                      generation.semantic_engine_version, generation.source_head,
                      generation.phase, generation.status,
                      generation.lease_fencing_generation,
                      terminal.generation_id AS terminal_generation_id,
                      terminal.last_error_code AS terminal_error_code
               FROM hosted_provider_collections collection
               LEFT JOIN LATERAL (
                 SELECT generation_id, target_catalog_revision,
                        projection_format_version, semantic_engine_version,
                        source_head, phase, status, lease_fencing_generation
                 FROM hosted_provider_projection_generations
                 WHERE collection_id = collection.id AND status = 'building'
                 ORDER BY created_at DESC, generation_id DESC LIMIT 1
               ) generation ON true
               LEFT JOIN LATERAL (
                 SELECT generation_id, last_error_code
                 FROM hosted_provider_projection_generations
                 WHERE collection_id = collection.id AND status = 'abandoned'
                 ORDER BY updated_at DESC, generation_id DESC LIMIT 1
               ) terminal ON true
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
        Ok(HostedProjectionStatus {
            collection_id,
            execution_model: row.get("hosted_execution_model"),
            pending_execution_model: row.get("pending_hosted_execution_model"),
            head: number(row.get::<i64, _>("head"), "collection head")?,
            resource_revision: row.get("resource_revision"),
            active_generation_id: row.get("active_projection_generation_id"),
            building_generation: projection_generation_from_joined_row(collection_id, &row)?,
            latest_terminal_generation_id: row.get("terminal_generation_id"),
            latest_terminal_error_code: row.get("terminal_error_code"),
        })
    }

    /// Advance exactly one bounded batch for the named generation. Callers
    /// must re-read status after every call; this never loops to completion.
    pub async fn advance_projection_generation(
        &self,
        collection_id: Uuid,
        generation_id: Uuid,
    ) -> ApiResult<HostedProjectionBatch> {
        let row = sqlx::query(
            r#"SELECT generation.phase
               FROM hosted_provider_projection_generations generation
               JOIN hosted_provider_collections collection
                 ON collection.id = generation.collection_id
               WHERE generation.collection_id = $1
                 AND generation.generation_id = $2
                 AND generation.status = 'building'
                 AND collection.state = 'active'
                 AND (
                   collection.hosted_execution_model = 'candidate_b'
                   OR collection.pending_hosted_execution_model = 'candidate_b'
                 )"#,
        )
        .bind(collection_id)
        .bind(generation_id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| {
            ApiError::conflict(
                "projection_generation_not_building",
                "The requested projection generation is not the current building generation.",
            )
        })?;
        let phase: String = row.get("phase");
        if phase == "projection" {
            self.project_generation_batch(collection_id, generation_id, MAX_PROJECTION_BATCH)
                .await
        } else if phase == "resolution" {
            self.resolve_generation_batch(collection_id, generation_id, MAX_PROJECTION_BATCH)
                .await
        } else {
            Err(ApiError::conflict(
                "projection_generation_phase_invalid",
                "The projection generation has an invalid phase.",
            ))
        }
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
                 AND (
                   collection.hosted_execution_model = 'candidate_b'
                   OR collection.pending_hosted_execution_model = 'candidate_b'
                 )
                 AND (
                   collection.pending_hosted_execution_model = 'candidate_b'
                   OR collection.active_projection_generation_id IS NULL
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
                       'projection_authority_invalid',
                       'projection_semantic_failure',
                       'projection_state_invalid'
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
            match self
                .start_projection_generation_in(collection_id, false)
                .await
            {
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
                 AND (
                   collection.hosted_execution_model = 'candidate_b'
                   OR collection.pending_hosted_execution_model = 'candidate_b'
                 )
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
                        "projection_record_too_large"
                            | "projection_authority_invalid"
                            | "projection_semantic_failure"
                            | "projection_state_invalid"
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
}

fn projection_generation_from_row(
    collection_id: Uuid,
    row: &sqlx::postgres::PgRow,
) -> ApiResult<HostedProjectionGeneration> {
    Ok(HostedProjectionGeneration {
        collection_id,
        generation_id: row.get("generation_id"),
        catalog_revision: row.get("target_catalog_revision"),
        projection_format_version: u32::try_from(number(
            row.get::<i32, _>("projection_format_version").into(),
            "projection format version",
        )?)
        .map_err(|_| ApiError::internal("Projection format version is outside u32 range."))?,
        semantic_engine_version: row.get("semantic_engine_version"),
        source_head: number(row.get::<i64, _>("source_head"), "projection source head")?,
        phase: row.get("phase"),
        status: row.get("status"),
        lease_fencing_generation: number(
            row.get::<i64, _>("lease_fencing_generation"),
            "projection lease fence",
        )?,
    })
}

fn projection_generation_from_joined_row(
    collection_id: Uuid,
    row: &sqlx::postgres::PgRow,
) -> ApiResult<Option<HostedProjectionGeneration>> {
    let Some(generation_id) = row.get::<Option<Uuid>, _>("generation_id") else {
        return Ok(None);
    };
    let required = |name: &str| {
        row.try_get::<Option<String>, _>(name)
            .map_err(ApiError::from)?
            .ok_or_else(|| ApiError::internal("A building projection generation was incomplete."))
    };
    let format_version = row
        .get::<Option<i32>, _>("projection_format_version")
        .ok_or_else(|| {
            ApiError::internal("A building projection generation omitted its format.")
        })?;
    Ok(Some(HostedProjectionGeneration {
        collection_id,
        generation_id,
        catalog_revision: required("target_catalog_revision")?,
        projection_format_version: u32::try_from(number(
            i64::from(format_version),
            "projection format version",
        )?)
        .map_err(|_| ApiError::internal("Projection format version is outside u32 range."))?,
        semantic_engine_version: required("semantic_engine_version")?,
        source_head: number(
            row.get::<Option<i64>, _>("source_head").ok_or_else(|| {
                ApiError::internal("A building projection generation omitted its source head.")
            })?,
            "projection source head",
        )?,
        phase: required("phase")?,
        status: required("status")?,
        lease_fencing_generation: number(
            row.get::<Option<i64>, _>("lease_fencing_generation")
                .ok_or_else(|| {
                    ApiError::internal("A building projection generation omitted its lease fence.")
                })?,
            "projection lease fence",
        )?,
    }))
}

include!("projections/batches.rs");
include!("projections/pruning.rs");
include!("projections/rebuild_limits.rs");
include!("projections/activation.rs");
include!("projections/persistence.rs");
include!("projections/catalog_binding.rs");
