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
            match PgPoolOptions::new()
                .max_connections(20)
                .min_connections(1)
                .acquire_timeout(Duration::from_secs(5))
                .idle_timeout(Duration::from_secs(10 * 60))
                .max_lifetime(Duration::from_secs(30 * 60))
                .connect(database_url)
                .await
            {
                Ok(pool) => match hosted_migrator().run(&pool).await {
                    Ok(()) => match verify_database_key(&pool, &crypto).await {
                        Ok(()) => {
                            let notifications = notification_config
                                .clone()
                                .map(|config| HostedNotificationRuntime::new(pool.clone(), config))
                                .transpose()?;
                            let provider = Self {
                                pool,
                                crypto,
                                limits,
                                working_sets: Arc::new(Mutex::new(HashMap::new())),
                                notifications,
                                notification_recovery: Arc::new(RwLock::new(
                                    NotificationRecoveryStatus {
                                        configured: notification_config.is_some(),
                                        recovery: if notification_config.is_some() {
                                            "pending"
                                        } else {
                                            "disabled"
                                        },
                                        consecutive_failures: 0,
                                        last_success_at: None,
                                    },
                                )),
                                blob_store,
                            };
                            if let Some(notifications) = &provider.notifications {
                                notifications.prepare().await?;
                                provider.recover_notifications(1_000).await?;
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
        let status = self.notification_recovery.read().await.clone();
        if status.configured && status.recovery != "ok" {
            return Err(ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "notification_recovery_unavailable",
                "Hosted notification recovery has not completed successfully.",
            ));
        }
        Ok(status)
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
        match notifications.recover(limit).await {
            Ok(processed) => {
                *self.notification_recovery.write().await = NotificationRecoveryStatus {
                    configured: true,
                    recovery: "ok",
                    consecutive_failures: 0,
                    last_success_at: Some(Utc::now()),
                };
                Ok(processed)
            }
            Err(error) => {
                let mut status = self.notification_recovery.write().await;
                status.recovery = "degraded";
                status.consecutive_failures = status.consecutive_failures.saturating_add(1);
                Err(error)
            }
        }
    }
}
