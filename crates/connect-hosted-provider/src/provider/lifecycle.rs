use super::*;
impl HostedProvider {
    pub async fn connect(
        database_url: &str,
        crypto: ProviderCrypto,
        limits: ProviderLimits,
        blob_store: Arc<dyn BlobStore>,
        notification_config: Option<HostedNotificationConfig>,
    ) -> ApiResult<Self> {
        let started = Instant::now();
        let mut retry_delay = Duration::from_millis(100);
        loop {
            match hosted_pool_options().connect(database_url).await {
                Ok(pool) => match run_hosted_migrations(&pool).await {
                    Ok(()) => match verify_database_key(&pool, &crypto).await {
                        Ok(()) => {
                            let query_pool = hosted_query_pool_options()
                                .connect_lazy(database_url)
                                .map_err(ApiError::from)?;
                            let query_cancellation_pool = hosted_cancellation_pool_options()
                                .connect_lazy(database_url)
                                .map_err(ApiError::from)?;
                            let notifications = notification_config
                                .clone()
                                .map(|config| HostedNotificationRuntime::new(pool.clone(), config))
                                .transpose()?;
                            let provider = Self {
                                pool,
                                query_pool,
                                query_cancellation_pool,
                                process_epoch: Uuid::new_v4(),
                                crypto,
                                key_readiness: Arc::new(Mutex::new(KeyReadinessState {
                                    last_checked: Instant::now(),
                                    healthy: true,
                                })),
                                limits,
                                working_sets: Arc::new(Mutex::new(
                                    WorkingSetRegistryState::default(),
                                )),
                                notifications,
                                notification_recovery_guard: Arc::new(Mutex::new(())),
                                notification_recovery: Arc::new(RwLock::new(
                                    NotificationRecoveryStatus {
                                        configured: notification_config.is_some(),
                                        recovery: if notification_config.is_some() {
                                            NotificationRecoveryState::Pending
                                        } else {
                                            NotificationRecoveryState::Disabled
                                        },
                                        consecutive_failures: 0,
                                        last_success_at: None,
                                    },
                                )),
                                blob_store,
                                query_activity: Arc::new(HostedQueryActivityCounters::default()),
                                query_scan_permits: Arc::new(Semaphore::new(
                                    usize::try_from(
                                        crate::execution_budget::hosted_execution_budgets()
                                            .active_scan_permits_per_process,
                                    )
                                    .expect("published scan-permit budget fits usize"),
                                )),
                                query_memory_permits: Arc::new(Semaphore::new(
                                    usize::try_from(
                                        crate::execution_budget::hosted_execution_budgets()
                                            .accounted_execution_bytes_per_process,
                                    )
                                    .expect("published process memory budget fits usize"),
                                )),
                            };
                            provider.migrate_legacy_sync_receipts().await?;
                            if let Some(notifications) = &provider.notifications {
                                notifications.prepare().await?;
                                // Notification delivery calls back into the Connect control
                                // plane. It is durable and retryable, but it is not a core
                                // dependency of the provider's storage and sync surfaces.
                                // Failing startup here creates a readiness cycle when Connect
                                // also probes this provider before becoming ready.
                                if let Err(error) = provider.recover_notifications(1_000).await {
                                    tracing::warn!(
                                        error_code = %error.code,
                                        "initial hosted notification recovery deferred"
                                    );
                                }
                            }
                            return Ok(provider);
                        }
                        Err(DatabaseKeyError::Invalid(error)) => {
                            pool.close().await;
                            return Err(error);
                        }
                        Err(DatabaseKeyError::Database(error))
                            if started.elapsed() < DATABASE_STARTUP_TIMEOUT =>
                        {
                            tracing::warn!(error = %error, "hosted provider key check unavailable; retrying");
                            pool.close().await;
                        }
                        Err(DatabaseKeyError::Database(error)) => {
                            tracing::error!(error = %error, "hosted provider key check failed");
                            return Err(ApiError::internal(
                                "The hosted provider could not verify its authoritative store.",
                            ));
                        }
                    },
                    Err(error) if started.elapsed() < DATABASE_STARTUP_TIMEOUT => {
                        tracing::warn!(error = %error, "hosted provider migration unavailable; retrying");
                        pool.close().await;
                    }
                    Err(error) => {
                        tracing::error!(
                            target: "mdbase_connect::metrics",
                            metric = "migration_failure",
                            "privacy-safe hosted provider metric"
                        );
                        tracing::error!(error = %error, "hosted provider migration failed");
                        return Err(ApiError::internal(
                            "The hosted provider database migration failed.",
                        ));
                    }
                },
                Err(error) if started.elapsed() < DATABASE_STARTUP_TIMEOUT => {
                    tracing::warn!(error = %error, "hosted provider database unavailable; retrying");
                }
                Err(error) => {
                    tracing::error!(error = %error, "hosted provider database connection failed");
                    return Err(ApiError::internal(
                        "The hosted provider could not connect to its authoritative store.",
                    ));
                }
            }
            tokio::time::sleep(retry_delay).await;
            retry_delay = (retry_delay * 2).min(Duration::from_secs(2));
        }
    }

    pub async fn ready(&self) -> ApiResult<NotificationRecoveryStatus> {
        sqlx::query("SELECT 1").execute(&self.pool).await?;
        self.blob_store.ready().await?;
        self.verify_key_readiness().await?;
        // Keep readiness acyclic: notification delivery is an outbound,
        // durably-retried dependency on the Connect control plane, while
        // Connect itself checks this endpoint before advertising readiness.
        // Report degradation for operators without inviting the platform to
        // restart a provider that can still serve authoritative data.
        Ok(self.notification_recovery.read().await.clone())
    }

    async fn verify_key_readiness(&self) -> ApiResult<()> {
        // Serialize probes so a burst of health requests performs at most one KMS
        // decrypt. A short failure cache prevents an unavailable key service from
        // being amplified by the platform's readiness polling.
        let mut readiness = self.key_readiness.lock().await;
        if !readiness.should_probe(Instant::now()) {
            return if readiness.healthy {
                Ok(())
            } else {
                Err(key_readiness_unavailable())
            };
        }

        match verify_stored_database_key(&self.pool, &self.crypto).await {
            Ok(()) => {
                readiness.last_checked = Instant::now();
                readiness.healthy = true;
                Ok(())
            }
            Err(error) => {
                readiness.last_checked = Instant::now();
                readiness.healthy = false;
                Err(error)
            }
        }
    }

    pub async fn upsert_notification_grant(
        &self,
        collection_id: Uuid,
        grant: GrantSummary,
    ) -> ApiResult<()> {
        let Some(notifications) = &self.notifications else {
            return Err(ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "notifications_unavailable",
                "Hosted notification execution is not configured.",
            ));
        };
        notifications.upsert_grant(collection_id, grant).await
    }

    pub async fn revoke_notification_grant(&self, grant_id: Uuid) -> ApiResult<()> {
        let Some(notifications) = &self.notifications else {
            return Ok(());
        };
        notifications.revoke_grant(grant_id).await
    }

    pub async fn recover_notifications(&self, limit: usize) -> ApiResult<usize> {
        let Some(notifications) = &self.notifications else {
            return Ok(0);
        };
        // Mutation-triggered recovery and the periodic recovery loop can fire
        // together. Only one sweep may own runtime leases and update the
        // operator-visible state; callers that lose the race can rely on the
        // in-flight durable sweep.
        let Ok(_guard) = self.notification_recovery_guard.try_lock() else {
            return Ok(0);
        };
        match notifications.recover(limit).await {
            Ok(processed) => {
                let pending = match notifications.has_pending_delivery().await {
                    Ok(pending) => pending,
                    Err(error) => {
                        self.mark_notification_recovery_degraded(&error).await;
                        return Err(error);
                    }
                };
                let mut status = self.notification_recovery.write().await;
                if pending {
                    if status.recovery != NotificationRecoveryState::Degraded {
                        status.recovery = NotificationRecoveryState::Pending;
                    }
                    return Ok(processed);
                }
                let recovered_from_degraded =
                    status.recovery == NotificationRecoveryState::Degraded;
                *status = NotificationRecoveryStatus {
                    configured: true,
                    recovery: NotificationRecoveryState::Ok,
                    consecutive_failures: 0,
                    last_success_at: Some(Utc::now()),
                };
                drop(status);
                if recovered_from_degraded {
                    tracing::info!(
                        target: "mdbase_connect::metrics",
                        metric = "notification_recovery_restored",
                        "privacy-safe hosted provider metric"
                    );
                }
                Ok(processed)
            }
            Err(error) => {
                self.mark_notification_recovery_degraded(&error).await;
                Err(error)
            }
        }
    }

    async fn mark_notification_recovery_degraded(&self, error: &ApiError) {
        let mut status = self.notification_recovery.write().await;
        status.recovery = NotificationRecoveryState::Degraded;
        status.consecutive_failures = status.consecutive_failures.saturating_add(1);
        tracing::warn!(
            target: "mdbase_connect::metrics",
            metric = "notification_recovery_degraded",
            error_code = %error.code,
            consecutive_failures = status.consecutive_failures,
            "privacy-safe hosted provider metric"
        );
    }
}

pub(super) const CONCURRENT_MIGRATION_INDEXES: [&str; 2] = [
    "hosted_provider_record_projections_snapshot_path_cursor_idx",
    "hosted_provider_record_projections_snapshot_mtime_cursor_idx",
];

pub(super) fn concurrent_migration_index_matches(
    index: &str,
    definition: &str,
    indexed_path_collation: &str,
) -> bool {
    let normalized = definition
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase();
    let key_suffix = match index {
        "hosted_provider_record_projections_snapshot_path_cursor_idx" => {
            "using btree (collection_id, generation_id, canonical_path collate \"c\", record_id, valid_from_sequence, valid_to_sequence)"
        }
        "hosted_provider_record_projections_snapshot_mtime_cursor_idx" => {
            "using btree (collection_id, generation_id, file_modified_at desc nulls first, canonical_path collate \"c\", record_id, valid_from_sequence, valid_to_sequence)"
        }
        _ => return false,
    };
    let default_c_suffix = key_suffix.replace(" collate \"c\"", "");
    let default_nulls_suffix = key_suffix.replace(" desc nulls first", " desc");
    let default_c_and_nulls_suffix = default_c_suffix.replace(" desc nulls first", " desc");
    let c_path_collation = indexed_path_collation.eq_ignore_ascii_case("C")
        || indexed_path_collation.eq_ignore_ascii_case("POSIX");
    normalized.contains(" on ")
        && normalized.contains("hosted_provider_record_projections ")
        && (normalized.ends_with(key_suffix)
            || normalized.ends_with(&default_nulls_suffix)
            || (c_path_collation
                && (normalized.ends_with(&default_c_suffix)
                    || normalized.ends_with(&default_c_and_nulls_suffix))))
}

async fn run_hosted_migrations(pool: &PgPool) -> Result<(), String> {
    let mut connection = pool.acquire().await.map_err(|error| error.to_string())?;
    sqlx::query("SET lock_timeout = '5s'")
        .execute(&mut *connection)
        .await
        .map_err(|error| error.to_string())?;
    sqlx::query("SET statement_timeout = '30min'")
        .execute(&mut *connection)
        .await
        .map_err(|error| error.to_string())?;

    for index in CONCURRENT_MIGRATION_INDEXES {
        let existing: Option<(bool, String, String)> = sqlx::query_as(
            r#"SELECT i.indisvalid, pg_get_indexdef(i.indexrelid),
                      COALESCE((
                        SELECT coll.collname
                        FROM unnest(i.indcollation::oid[]) WITH ORDINALITY key(oid, position)
                        JOIN pg_collation coll ON coll.oid = key.oid
                        WHERE key.position = CASE WHEN c.relname =
                          'hosted_provider_record_projections_snapshot_path_cursor_idx'
                          THEN 3 ELSE 4 END
                      ), '')
                 FROM pg_index i
                 JOIN pg_class c ON c.oid = i.indexrelid
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = current_schema()
                   AND c.relname = $1"#,
        )
        .bind(index)
        .fetch_optional(&mut *connection)
        .await
        .map_err(|error| error.to_string())?;
        if let Some((true, definition, indexed_path_collation)) = existing.as_ref() {
            if !concurrent_migration_index_matches(index, definition, indexed_path_collation) {
                return Err(format!(
                    "hosted concurrent migration index {index} exists with an unexpected definition; refusing to migrate"
                ));
            }
        }
        if matches!(existing, Some((false, _, _))) {
            let statement = match index {
                "hosted_provider_record_projections_snapshot_path_cursor_idx" => {
                    "DROP INDEX CONCURRENTLY IF EXISTS hosted_provider_record_projections_snapshot_path_cursor_idx"
                }
                "hosted_provider_record_projections_snapshot_mtime_cursor_idx" => {
                    "DROP INDEX CONCURRENTLY IF EXISTS hosted_provider_record_projections_snapshot_mtime_cursor_idx"
                }
                _ => unreachable!("concurrent migration index allowlist is exhaustive"),
            };
            sqlx::query(statement)
                .execute(&mut *connection)
                .await
                .map_err(|error| error.to_string())?;
        }
    }

    let migration = hosted_migrator()
        .run(&mut *connection)
        .await
        .map_err(|error| error.to_string());
    let reset = async {
        sqlx::query("RESET statement_timeout")
            .execute(&mut *connection)
            .await?;
        sqlx::query("RESET lock_timeout")
            .execute(&mut *connection)
            .await?;
        Ok::<(), sqlx::Error>(())
    }
    .await
    .map_err(|error| error.to_string());
    migration.and(reset)
}

impl HostedProvider {
    /// Privacy-safe live resource gauges used by cancellation and leak
    /// monitoring. They contain no collection, query, or plaintext content.
    pub fn hosted_query_activity(&self) -> HostedQueryActivity {
        HostedQueryActivity {
            active_queries: self
                .query_activity
                .active_queries
                .load(AtomicOrdering::Relaxed),
            plaintext_scopes: self
                .query_activity
                .plaintext_scopes
                .load(AtomicOrdering::Relaxed),
            active_scan_permits: self
                .query_activity
                .active_scan_permits
                .load(AtomicOrdering::Relaxed),
            accounted_execution_bytes: self
                .query_activity
                .accounted_execution_bytes
                .load(AtomicOrdering::Relaxed),
            query_pool_connections: u64::from(self.query_pool.size()),
            query_pool_idle_connections: u64::try_from(self.query_pool.num_idle())
                .unwrap_or(u64::MAX),
        }
    }
}

fn key_readiness_unavailable() -> ApiError {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "key_readiness_unavailable",
        "The hosted provider cannot currently verify its configured key hierarchy.",
    )
}

fn hosted_pool_options() -> PgPoolOptions {
    PgPoolOptions::new()
        .max_connections(PRIMARY_POOL_CONNECTIONS)
        .min_connections(1)
        .acquire_timeout(DATABASE_ACQUIRE_TIMEOUT)
        .idle_timeout(Duration::from_secs(10 * 60))
        .max_lifetime(Duration::from_secs(30 * 60))
        .after_connect(|connection, _metadata| {
            Box::pin(async move {
                sqlx::query("SET statement_timeout = 15000")
                    .execute(&mut *connection)
                    .await?;
                sqlx::query("SET lock_timeout = 5000")
                    .execute(&mut *connection)
                    .await?;
                sqlx::query("SET idle_in_transaction_session_timeout = 10000")
                    .execute(&mut *connection)
                    .await?;
                Ok(())
            })
        })
}

fn hosted_query_pool_options() -> PgPoolOptions {
    PgPoolOptions::new()
        .max_connections(QUERY_POOL_CONNECTIONS)
        .min_connections(0)
        .acquire_timeout(DATABASE_ACQUIRE_TIMEOUT)
        .idle_timeout(Duration::from_secs(10 * 60))
        .max_lifetime(Duration::from_secs(30 * 60))
        .after_connect(|connection, _metadata| {
            Box::pin(async move {
                sqlx::query("SET statement_timeout = 15000")
                    .execute(&mut *connection)
                    .await?;
                sqlx::query("SET lock_timeout = 5000")
                    .execute(&mut *connection)
                    .await?;
                sqlx::query("SET idle_in_transaction_session_timeout = 10000")
                    .execute(&mut *connection)
                    .await?;
                Ok(())
            })
        })
}

fn hosted_cancellation_pool_options() -> PgPoolOptions {
    PgPoolOptions::new()
        .max_connections(2)
        .min_connections(0)
        .acquire_timeout(Duration::from_secs(1))
        .idle_timeout(Duration::from_secs(60))
        .max_lifetime(Duration::from_secs(5 * 60))
}

#[cfg(test)]
mod key_readiness_tests {
    use super::*;

    #[test]
    fn successful_and_failed_checks_have_bounded_probe_intervals() {
        let start = Instant::now();
        let mut state = KeyReadinessState {
            last_checked: start,
            healthy: true,
        };
        assert!(!state.should_probe(start + KEY_READINESS_SUCCESS_TTL - Duration::from_millis(1)));
        assert!(state.should_probe(start + KEY_READINESS_SUCCESS_TTL));

        state.healthy = false;
        assert!(!state.should_probe(start + KEY_READINESS_FAILURE_TTL - Duration::from_millis(1)));
        assert!(state.should_probe(start + KEY_READINESS_FAILURE_TTL));
    }

    #[test]
    fn notification_recovery_states_have_stable_operator_values() {
        for (state, expected) in [
            (NotificationRecoveryState::Disabled, "disabled"),
            (NotificationRecoveryState::Pending, "pending"),
            (NotificationRecoveryState::Ok, "ok"),
            (NotificationRecoveryState::Degraded, "degraded"),
        ] {
            assert_eq!(serde_json::to_value(state).unwrap(), json!(expected));
        }
    }
}

#[cfg(test)]
mod database_bounds_tests {
    use super::*;
    use sqlx::Row;

    #[tokio::test]
    #[ignore = "requires MDBASE_TEST_DATABASE_BOUNDS_URL; exercised by the provider system suite"]
    async fn production_pool_waits_and_database_locks_are_bounded() {
        let database_url = std::env::var("MDBASE_TEST_DATABASE_BOUNDS_URL")
            .expect("MDBASE_TEST_DATABASE_BOUNDS_URL is required");
        let pool = hosted_pool_options()
            .min_connections(0)
            .connect(&database_url)
            .await
            .expect("database bounds pool connects");

        let mut held = Vec::with_capacity(PRIMARY_POOL_CONNECTIONS as usize);
        for _ in 0..PRIMARY_POOL_CONNECTIONS {
            held.push(pool.acquire().await.expect("pool slot is acquired"));
        }
        let started = Instant::now();
        let saturated = pool
            .acquire()
            .await
            .expect_err("saturated pool must time out");
        assert!(started.elapsed() >= DATABASE_ACQUIRE_TIMEOUT - Duration::from_millis(250));
        assert_database_timeout(ApiError::from(saturated), "pool");
        drop(held);

        let settings = sqlx::query(
            "SELECT current_setting('statement_timeout') AS statement_timeout, \
                    current_setting('lock_timeout') AS lock_timeout, \
                    current_setting('idle_in_transaction_session_timeout') AS idle_timeout",
        )
        .fetch_one(&pool)
        .await
        .expect("production timeout settings are readable");
        assert_eq!(settings.get::<String, _>("statement_timeout"), "15s");
        assert_eq!(settings.get::<String, _>("lock_timeout"), "5s");
        assert_eq!(settings.get::<String, _>("idle_timeout"), "10s");

        let mut statement = pool.begin().await.expect("statement transaction begins");
        sqlx::query("SET LOCAL statement_timeout = 50")
            .execute(&mut *statement)
            .await
            .expect("test statement timeout is shortened");
        let statement_error = sqlx::query("SELECT pg_sleep(1)")
            .execute(&mut *statement)
            .await
            .expect_err("black-holed statement must time out");
        assert_database_timeout(ApiError::from(statement_error), "statement");
        statement
            .rollback()
            .await
            .expect("aborted statement transaction rolls back");

        sqlx::query("DROP TABLE IF EXISTS hosted_provider_database_bounds")
            .execute(&pool)
            .await
            .expect("stale lock fixture is removed");
        sqlx::query(
            "CREATE TABLE hosted_provider_database_bounds \
             (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)",
        )
        .execute(&pool)
        .await
        .expect("lock fixture is created");
        sqlx::query("INSERT INTO hosted_provider_database_bounds (id, value) VALUES (1, 0)")
            .execute(&pool)
            .await
            .expect("lock fixture row is created");
        let mut owner = pool.begin().await.expect("lock owner begins");
        sqlx::query("UPDATE hosted_provider_database_bounds SET value = value + 1 WHERE id = 1")
            .execute(&mut *owner)
            .await
            .expect("lock owner acquires row lock");
        let mut waiter = pool.begin().await.expect("lock waiter begins");
        sqlx::query("SET LOCAL lock_timeout = 50")
            .execute(&mut *waiter)
            .await
            .expect("test lock timeout is shortened");
        let lock_error = sqlx::query(
            "UPDATE hosted_provider_database_bounds SET value = value + 1 WHERE id = 1",
        )
        .execute(&mut *waiter)
        .await
        .expect_err("blocked row lock must time out");
        assert_database_timeout(ApiError::from(lock_error), "lock");
        waiter.rollback().await.expect("lock waiter rolls back");
        owner.rollback().await.expect("lock owner rolls back");
        sqlx::query("DROP TABLE hosted_provider_database_bounds")
            .execute(&pool)
            .await
            .expect("lock fixture is removed");
        pool.close().await;
    }

    fn assert_database_timeout(error: ApiError, expected_class: &str) {
        assert_eq!(error.status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(error.code, "provider_database_timeout");
        assert_eq!(
            error
                .details
                .as_ref()
                .and_then(|details| details["timeout_class"].as_str()),
            Some(expected_class)
        );
    }
}
