use super::*;
impl HostedProvider {
    /// Point-in-time operational state for an operator or a dashboard.
    ///
    /// Every section is independently bounded and independently fallible: a
    /// slow or unavailable database yields one `unavailable` section rather
    /// than an unanswerable request. This endpoint is reachable while admission
    /// is fenced, which is exactly when it matters, so it must never be the
    /// thing that also stops working.
    pub async fn hosted_diagnostics(&self) -> HostedDiagnostics {
        // Short and uniform. A diagnostic that waits is a diagnostic that is
        // unavailable during the incident it exists for. A macro rather than a
        // closure because each section returns a distinct opaque future type.
        let budget = Duration::from_secs(2);
        macro_rules! section {
            ($future:expr) => {
                match tokio::time::timeout(budget, $future).await {
                    Ok(result) => DiagnosticSection::from_result(result),
                    Err(_) => DiagnosticSection::Unavailable {
                        reason: "timed out".to_string(),
                    },
                }
            };
        }

        let activity = self.hosted_query_activity();
        let lifecycle_work =
            match tokio::time::timeout(budget, self.lifecycle_work_diagnostic()).await {
                Ok(Ok(value)) => LifecycleDiagnosticSection::Ok { value },
                Ok(Err(_)) | Err(_) => LifecycleDiagnosticSection::Unavailable,
            };
        HostedDiagnostics {
            schema_version: HOSTED_DIAGNOSTICS_SCHEMA_VERSION,
            provider_version: env!("CARGO_PKG_VERSION"),
            query_activity: activity,
            projection_readiness: section!(self.projection_readiness_diagnostic()),
            projection_progress: section!(self.projection_progress_diagnostic()),
            drain_state: section!(self.drain_state_diagnostic(activity)),
            migration_ledger: section!(self.migration_ledger_diagnostic()),
            storage: section!(self.storage_diagnostic()),
            recent_resource_changes: section!(self.recent_resource_changes_diagnostic()),
            lifecycle_work,
        }
    }

    async fn lifecycle_work_diagnostic(&self) -> ApiResult<HostedLifecycleWorkDiagnostic> {
        let mut transaction = self.pool.begin().await?;
        sqlx::query("SET TRANSACTION READ ONLY")
            .execute(&mut *transaction)
            .await?;
        sqlx::query("SET LOCAL statement_timeout = '2s'")
            .execute(&mut *transaction)
            .await?;
        sqlx::query("SET LOCAL lock_timeout = '250ms'")
            .execute(&mut *transaction)
            .await?;
        let row = sqlx::query(
            r#"WITH outbox AS (
                 SELECT
                   count(*) FILTER (WHERE processed_at IS NULL) AS open,
                   count(*) FILTER (WHERE processed_at IS NULL
                     AND occurred_at <= now() - interval '30 minutes') AS stale,
                   count(*) FILTER (WHERE processed_at IS NULL AND attempts >= 11
                     AND last_error IS NOT NULL) AS poison,
                   count(*) FILTER (WHERE processed_at IS NULL
                     AND leased_until <= now()) AS expired_leases,
                   count(*) FILTER (WHERE
                     ((lease_token IS NULL) <> (leased_until IS NULL))
                     OR (processed_at IS NOT NULL AND
                       (lease_token IS NOT NULL OR leased_until IS NOT NULL
                         OR last_error IS NOT NULL))) AS impossible,
                   greatest(0, extract(epoch FROM now() - min(occurred_at)
                     FILTER (WHERE processed_at IS NULL)))::bigint AS oldest_open_seconds
                 FROM hosted_provider_runtime_outbox
               ), journal AS (
                 SELECT
                   count(*) FILTER (WHERE state IN ('claimed', 'prepared', 'applied')) AS unfinished,
                   count(*) FILTER (WHERE state IN ('claimed', 'prepared', 'applied')
                     AND updated_at <= now() - interval '120 seconds') AS stale,
                   count(*) FILTER (WHERE state = 'outcome_unknown') AS outcome_unknown,
                   count(*) FILTER (WHERE state IN ('claimed', 'prepared', 'applied')
                     AND lease_expires_at <= now()) AS expired_leases,
                   greatest(0, extract(epoch FROM now() - min(accepted_at)
                     FILTER (WHERE state IN ('claimed', 'prepared', 'applied'))))::bigint
                     AS oldest_unfinished_seconds
                 FROM hosted_provider_mutation_journal
               ), deleting AS (
                 SELECT count(*) AS stuck
                 FROM hosted_provider_collections
                 WHERE state = 'deleting'
                   AND updated_at <= now() - interval '10 minutes'
               )
               SELECT outbox.open AS outbox_open, outbox.stale AS outbox_stale,
                 outbox.poison AS outbox_poison,
                 outbox.expired_leases AS outbox_expired_leases,
                 outbox.impossible AS outbox_impossible,
                 outbox.oldest_open_seconds,
                 journal.unfinished AS journal_unfinished,
                 journal.stale AS journal_stale,
                 journal.outcome_unknown AS journal_outcome_unknown,
                 journal.expired_leases AS journal_expired_leases,
                 journal.oldest_unfinished_seconds,
                 deleting.stuck AS stuck_deleting_collections
               FROM outbox CROSS JOIN journal CROSS JOIN deleting"#,
        )
        .fetch_one(&mut *transaction)
        .await?;
        transaction.commit().await?;
        let count = |name: &str| -> ApiResult<u64> {
            number(row.get::<i64, _>(name), "lifecycle diagnostic count")
        };
        Ok(HostedLifecycleWorkDiagnostic {
            runtime_outbox: RuntimeOutboxLifecycleDiagnostic {
                open: count("outbox_open")?,
                stale: count("outbox_stale")?,
                poison: count("outbox_poison")?,
                expired_leases: count("outbox_expired_leases")?,
                impossible: count("outbox_impossible")?,
                oldest_open_seconds: row.get("oldest_open_seconds"),
            },
            mutation_journal: MutationJournalLifecycleDiagnostic {
                unfinished: count("journal_unfinished")?,
                stale: count("journal_stale")?,
                outcome_unknown: count("journal_outcome_unknown")?,
                expired_leases: count("journal_expired_leases")?,
                oldest_unfinished_seconds: row.get("oldest_unfinished_seconds"),
            },
            stuck_deleting_collections: count("stuck_deleting_collections")?,
        })
    }

    async fn projection_readiness_diagnostic(&self) -> ApiResult<ProjectionReadinessDiagnostic> {
        let row = sqlx::query(
            r#"SELECT
                 count(*) AS active_collections,
                 count(*) FILTER (WHERE unready) AS unready,
                 count(*) FILTER (WHERE missing_generation) AS missing_generation,
                 count(*) FILTER (WHERE generation_incomplete) AS generation_incomplete,
                 count(*) FILTER (WHERE head_mismatch) AS head_mismatch,
                 count(*) FILTER (WHERE source_head_ahead) AS source_head_ahead,
                 count(*) FILTER (WHERE resource_revision_stale) AS resource_revision_stale,
                 count(*) FILTER (WHERE catalog_stale) AS catalog_stale,
                 count(*) FILTER (WHERE format_version_mismatch) AS format_version_mismatch,
                 count(*) FILTER (WHERE engine_version_mismatch) AS engine_version_mismatch,
                 count(*) FILTER (WHERE integrity_unverified) AS integrity_unverified
               FROM (
                 SELECT
                   (collection.active_projection_generation_id IS NULL)
                     AS missing_generation,
                   (generation.status IS DISTINCT FROM 'complete')
                     AS generation_incomplete,
                   (collection.active_projection_head IS DISTINCT FROM collection.head)
                     AS head_mismatch,
                   (generation.source_head > collection.active_projection_head)
                     AS source_head_ahead,
                   (generation.source_resource_revision
                      IS DISTINCT FROM collection.resource_revision)
                     AS resource_revision_stale,
                   (generation.target_catalog_revision
                      IS DISTINCT FROM collection.active_catalog_revision)
                     AS catalog_stale,
                   (generation.projection_format_version
                      IS DISTINCT FROM collection.active_projection_format_version)
                     AS format_version_mismatch,
                   (generation.semantic_engine_version
                      IS DISTINCT FROM collection.active_semantic_engine_version)
                     AS engine_version_mismatch,
                   (generation.integrity_epoch
                      IS DISTINCT FROM generation.integrity_verified_epoch)
                     AS integrity_unverified,
                   (collection.active_projection_generation_id IS NULL
                     OR generation.status IS DISTINCT FROM 'complete'
                     OR collection.active_projection_head IS DISTINCT FROM collection.head
                     OR generation.source_head > collection.active_projection_head
                     OR generation.source_resource_revision
                          IS DISTINCT FROM collection.resource_revision
                     OR generation.target_catalog_revision
                          IS DISTINCT FROM collection.active_catalog_revision
                     OR generation.projection_format_version
                          IS DISTINCT FROM collection.active_projection_format_version
                     OR generation.semantic_engine_version
                          IS DISTINCT FROM collection.active_semantic_engine_version
                     OR generation.integrity_epoch
                          IS DISTINCT FROM generation.integrity_verified_epoch)
                     AS unready
                 FROM hosted_provider_collections collection
                 LEFT JOIN hosted_provider_projection_generations generation
                   ON generation.collection_id = collection.id
                  AND generation.generation_id
                        = collection.active_projection_generation_id
                 WHERE collection.state = 'active'
               ) causes"#,
        )
        .fetch_one(&self.pool)
        .await?;
        let count =
            |key: &str| -> ApiResult<u64> { number(row.get::<i64, _>(key), "diagnostic count") };
        Ok(ProjectionReadinessDiagnostic {
            active_collections: count("active_collections")?,
            unready: count("unready")?,
            missing_generation: count("missing_generation")?,
            generation_incomplete: count("generation_incomplete")?,
            head_mismatch: count("head_mismatch")?,
            source_head_ahead: count("source_head_ahead")?,
            resource_revision_stale: count("resource_revision_stale")?,
            catalog_stale: count("catalog_stale")?,
            format_version_mismatch: count("format_version_mismatch")?,
            engine_version_mismatch: count("engine_version_mismatch")?,
            integrity_unverified: count("integrity_unverified")?,
        })
    }

    async fn projection_progress_diagnostic(&self) -> ApiResult<Vec<ProjectionProgressDiagnostic>> {
        // Bounded: building generations first, then most recently touched.
        let rows = sqlx::query(
            r#"SELECT generation.collection_id, generation.generation_id,
                      generation.status, generation.phase,
                      collection.record_count AS expected_records,
                      generation.projected_records, generation.resolved_records,
                      generation.lease_owner IS NOT NULL AS lease_held,
                      (generation.lease_expires_at > now()) AS lease_live,
                      generation.last_error_code,
                      EXTRACT(EPOCH FROM (now() - generation.updated_at))::bigint
                        AS seconds_since_progress
               FROM hosted_provider_projection_generations generation
               JOIN hosted_provider_collections collection
                 ON collection.id = generation.collection_id
               WHERE generation.status <> 'abandoned'
               ORDER BY (generation.status = 'building') DESC,
                        generation.updated_at DESC
               LIMIT 50"#,
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|row| ProjectionProgressDiagnostic {
                collection_id: row.get("collection_id"),
                generation_id: row.get("generation_id"),
                status: row.get("status"),
                phase: row.get("phase"),
                expected_records: row.get("expected_records"),
                projected_records: row.get("projected_records"),
                resolved_records: row.get("resolved_records"),
                lease_held: row.get("lease_held"),
                lease_live: row.get::<Option<bool>, _>("lease_live").unwrap_or(false),
                last_error_code: row.get("last_error_code"),
                seconds_since_progress: row.get("seconds_since_progress"),
            })
            .collect())
    }

    async fn drain_state_diagnostic(
        &self,
        activity: HostedQueryActivity,
    ) -> ApiResult<DrainStateDiagnostic> {
        // Session existence only: activity detail is not required and is not
        // visible to ordinary roles anyway.
        let other_sessions: i64 = sqlx::query_scalar(
            r#"SELECT count(*) FROM pg_stat_activity
               WHERE datname = current_database() AND pid <> pg_backend_pid()"#,
        )
        .fetch_one(&self.pool)
        .await?;
        Ok(DrainStateDiagnostic {
            other_sessions,
            query_pool_connections: activity.query_pool_connections,
            query_pool_idle_connections: activity.query_pool_idle_connections,
            active_scan_permits: activity.active_scan_permits,
            plaintext_scopes: activity.plaintext_scopes,
        })
    }

    async fn migration_ledger_diagnostic(&self) -> ApiResult<MigrationLedgerDiagnostic> {
        let row = sqlx::query(
            r#"SELECT count(*) AS applied, max(version) AS latest
               FROM _sqlx_migrations WHERE success"#,
        )
        .fetch_one(&self.pool)
        .await?;
        Ok(MigrationLedgerDiagnostic {
            applied_migrations: row.get("applied"),
            latest_version: row.get("latest"),
            expected_projection_format_version: i64::from(
                mdbase::runtime::SEMANTIC_PROJECTION_FORMAT_VERSION,
            ),
            expected_semantic_engine_version: mdbase::VERSION,
        })
    }

    async fn storage_diagnostic(&self) -> ApiResult<StorageDiagnostic> {
        let (bucket, expiry) = self
            .blob_store
            .storage_diagnostic()
            .ok_or_else(|| ApiError::internal("The blob store reports no storage diagnostic."))?;
        let expires_at = expiry.and_then(|value| DateTime::<Utc>::from_timestamp(value, 0));
        Ok(StorageDiagnostic {
            bucket,
            credential_expires_at: expires_at,
            credential_expires_in_seconds: expires_at.map(|at| (at - Utc::now()).num_seconds()),
        })
    }

    async fn recent_resource_changes_diagnostic(&self) -> ApiResult<Vec<ResourceChangeDiagnostic>> {
        // Paths and revisions only. A resource revision advancing is what
        // stranded a projection binding twice on 2026-08-18; the path says
        // which resource without exposing its contents.
        let rows = sqlx::query(
            r#"SELECT collection_id, sequence, resource_kind, path, revision
               FROM hosted_provider_resource_changes
               ORDER BY sequence DESC
               LIMIT 20"#,
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|row| ResourceChangeDiagnostic {
                collection_id: row.get("collection_id"),
                sequence: row.get("sequence"),
                resource_kind: row.get("resource_kind"),
                path: row.get("path"),
                revision: row.get("revision"),
            })
            .collect())
    }
}
