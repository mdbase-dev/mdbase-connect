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
            released_sync_mutations: section!(self.released_sync_mutations_diagnostic()),
            stored_sync_failures: section!(self.stored_sync_failures_diagnostic()),
            unfinished_mutations: section!(self.unfinished_mutations_diagnostic()),
        }
    }

    async fn read_only_diagnostic_transaction(&self) -> ApiResult<Transaction<'_, Postgres>> {
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
        Ok(transaction)
    }

    async fn lifecycle_work_diagnostic(&self) -> ApiResult<HostedLifecycleWorkDiagnostic> {
        let mut transaction = self.read_only_diagnostic_transaction().await?;
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
                 -- Released sync mutations are not outstanding work: nothing
                 -- applied and nothing will run them until the client retries.
                 -- They are counted in `released_sync_mutations` instead.
                 WHERE NOT (operation_kind = 'sync:mutate' AND state = 'prepared'
                   AND evidence_kind IS NULL AND lease_expires_at <= now())
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
                      IS DISTINCT FROM collection.active_projection_format_version
                     OR (collection.active_projection_format_version IS NOT NULL
                         AND collection.active_projection_format_version <> $1))
                     AS format_version_mismatch,
                   (generation.semantic_engine_version
                      IS DISTINCT FROM collection.active_semantic_engine_version
                     OR (collection.active_semantic_engine_version IS NOT NULL
                         AND collection.active_semantic_engine_version <> $2))
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
                     OR (collection.active_projection_format_version IS NOT NULL
                         AND collection.active_projection_format_version <> $1)
                     OR generation.semantic_engine_version
                          IS DISTINCT FROM collection.active_semantic_engine_version
                     OR (collection.active_semantic_engine_version IS NOT NULL
                         AND collection.active_semantic_engine_version <> $2)
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
        .bind(i64::from(
            mdbase::runtime::SEMANTIC_PROJECTION_FORMAT_VERSION,
        ))
        .bind(mdbase::VERSION)
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

    /// Unfinished journal entries counted by what they are and how old they
    /// are. Counts of closed values only: no identifier, digest, ciphertext or
    /// payload leaves this query. `applied` sorts first so the row limit cannot
    /// hide an effect that landed without a final receipt.
    async fn unfinished_mutations_diagnostic(
        &self,
    ) -> ApiResult<Vec<UnfinishedMutationDiagnostic>> {
        let mut transaction = self.read_only_diagnostic_transaction().await?;
        let rows = sqlx::query(
            r#"WITH unfinished AS (
                 SELECT
                   CASE WHEN operation_kind ~ '^[a-z_:]{1,40}$'
                     THEN operation_kind ELSE 'other' END AS operation_kind,
                   state,
                   coalesce(evidence_kind, 'none') AS evidence_kind,
                   CASE
                     WHEN accepted_at > now() - interval '1 hour' THEN 'under_1h'
                     WHEN accepted_at > now() - interval '1 day' THEN '1h_to_1d'
                     WHEN accepted_at > now() - interval '7 days' THEN '1d_to_7d'
                     WHEN accepted_at > now() - interval '30 days' THEN '7d_to_30d'
                     ELSE 'over_30d'
                   END AS age_band
                 FROM hosted_provider_mutation_journal
                 WHERE state IN ('claimed', 'prepared', 'applied')
                   AND NOT (operation_kind = 'sync:mutate' AND state = 'prepared'
                     AND evidence_kind IS NULL AND lease_expires_at <= now())
               )
               SELECT operation_kind, state, evidence_kind, age_band, count(*) AS count
               FROM unfinished
               GROUP BY operation_kind, state, evidence_kind, age_band
               ORDER BY state = 'applied' DESC, count DESC,
                 operation_kind, state, evidence_kind, age_band
               LIMIT 12"#,
        )
        .fetch_all(&mut *transaction)
        .await?;
        transaction.commit().await?;
        rows.into_iter()
            .map(|row| {
                Ok(UnfinishedMutationDiagnostic {
                    operation_kind: row.get("operation_kind"),
                    state: row.get("state"),
                    evidence_kind: row.get("evidence_kind"),
                    age_band: row.get("age_band"),
                    count: number(row.get::<i64, _>("count"), "unfinished mutation count")?,
                })
            })
            .collect()
    }

    /// Current-format sync mutations closed by an error that an earlier
    /// release stored as the final receipt: `completed` with no evidence, so
    /// their transaction never committed. Current code stores none. A count
    /// only: the receipt's status is encrypted, so it cannot split by status.
    ///
    /// It includes stored 400 and 403 failures, which stay final, so it need
    /// not reach zero; the 5xx, 401, 404 and 429 ones reopen when their client
    /// retries, so it falls as stuck clients come back. It misses an error
    /// stored over an `applied` row: that row keeps its evidence and cannot be
    /// told from a success without decrypting the receipt (the receipt digest
    /// hashes the whole plaintext). Those rows reopen on retry all the same.
    /// Version 0 rows are migrated legacy receipts, which also carry no
    /// evidence, so they are excluded.
    async fn stored_sync_failures_diagnostic(&self) -> ApiResult<u64> {
        let mut transaction = self.read_only_diagnostic_transaction().await?;
        let total: i64 = sqlx::query_scalar(
            r#"SELECT count(*) FROM hosted_provider_mutation_journal
               WHERE operation_kind = 'sync:mutate' AND fingerprint_schema_version = 1
                 AND state = 'completed' AND evidence_kind IS NULL"#,
        )
        .fetch_one(&mut *transaction)
        .await?;
        transaction.commit().await?;
        number(total, "stored sync failure count")
    }

    /// Sync mutations whose last attempt failed and released its lease:
    /// `prepared`, no evidence, lease expired. Nothing applied (the effect and
    /// its evidence commit together), and nothing runs them again until the
    /// client retries the same mutation ID, which re-runs it. A client that
    /// stays over quota, or abandons the ID, leaves them here; compaction
    /// deletes them after 30 days. A process that died mid-transaction leaves
    /// the same shape and is equally safe. Kept out of the unfinished counts
    /// so that they do not hold the lifecycle monitor in warning.
    async fn released_sync_mutations_diagnostic(&self) -> ApiResult<u64> {
        let mut transaction = self.read_only_diagnostic_transaction().await?;
        let total: i64 = sqlx::query_scalar(
            r#"SELECT count(*) FROM hosted_provider_mutation_journal
               WHERE operation_kind = 'sync:mutate' AND state = 'prepared'
                 AND evidence_kind IS NULL AND lease_expires_at <= now()"#,
        )
        .fetch_one(&mut *transaction)
        .await?;
        transaction.commit().await?;
        number(total, "released sync mutation count")
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

/// A section that resolved, or the reason it did not. Keeping the failure in
/// the payload rather than in the status code is what lets one slow section
/// coexist with six useful ones.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum DiagnosticSection<T> {
    Ok { value: T },
    Unavailable { reason: String },
}

impl<T> DiagnosticSection<T> {
    pub fn from_result<E: std::fmt::Display>(result: Result<T, E>) -> Self {
        match result {
            Ok(value) => Self::Ok { value },
            // The reason is a short classification, never a raw database error:
            // those can echo query text and identifiers.
            Err(error) => Self::Unavailable {
                reason: error.to_string(),
            },
        }
    }
}

/// One group of unfinished journal entries. Every field but `count` is a closed
/// value, and no row identifies a request, replica or collection.
#[derive(Debug, Clone, Serialize)]
pub struct UnfinishedMutationDiagnostic {
    pub operation_kind: String,
    pub state: String,
    pub evidence_kind: String,
    pub age_band: String,
    pub count: u64,
}
