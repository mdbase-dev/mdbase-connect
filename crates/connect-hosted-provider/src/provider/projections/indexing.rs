const PRODUCTION_MIGRATION_BASELINE: u64 = 34;
const FINAL_PROJECTION_MIGRATION: u64 = 36;
const MAX_INDEX_INVENTORY_PAGE: u32 = 1_000;

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
                      count(*) FILTER (WHERE version BETWEEN 35 AND 36)::bigint
                        AS final_migration_count
               FROM _sqlx_migrations"#,
        )
        .fetch_one(&self.pool)
        .await?;
        let migration_ledger_valid = ledger.get::<i64, _>("migration_count")
            == FINAL_PROJECTION_MIGRATION as i64
            && ledger.get::<Option<i64>, _>("minimum_version") == Some(1)
            && ledger.get::<Option<i64>, _>("maximum_version")
                == Some(FINAL_PROJECTION_MIGRATION as i64)
            && ledger.get::<Option<bool>, _>("all_successful") == Some(true)
            && ledger.get::<i64, _>("final_migration_count") == 2;
        let schema_valid: bool = sqlx::query_scalar(
            r#"SELECT to_regclass('hosted_provider_projection_generations') IS NOT NULL
                    AND to_regclass('hosted_provider_record_projections') IS NOT NULL
                    AND to_regclass('hosted_provider_record_resolution_keys') IS NOT NULL
                    AND to_regclass('hosted_provider_record_relationships') IS NOT NULL
                    AND to_regclass('hosted_provider_query_cursors') IS NOT NULL
                    AND to_regclass('hosted_provider_query_page_receipts') IS NOT NULL
                    AND NOT EXISTS (
                      SELECT 1 FROM information_schema.columns
                      WHERE table_schema = current_schema()
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
        Ok(HostedProjectionVerification {
            collection_id,
            verified: failures.is_empty(),
            failures,
            exact_records,
            projected_records,
            resolved_records,
            invalid_projection_rows,
        })
    }
}
