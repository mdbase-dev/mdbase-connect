use super::*;

impl HostedProvider {
    /// Hold the database-wide shared admission lock for a complete request
    /// that can change canonical or projection-relevant state. A cutover lease
    /// never admits this class while semantic reads exercise the candidate.
    pub async fn acquire_runtime_admission(&self) -> ApiResult<Transaction<'static, Postgres>> {
        self.acquire_runtime_admission_class(false).await
    }

    /// Hold the database-wide shared admission lock for a semantic query. A
    /// live cutover lease admits queries after the exclusive drain; rollback
    /// fences, expired leases, and fully suspended admission do not. Query
    /// cursor lifecycle and protocol accounting may still update bounded
    /// runtime metadata, but cannot change canonical records or projections.
    pub async fn acquire_runtime_read_admission(
        &self,
    ) -> ApiResult<Transaction<'static, Postgres>> {
        self.acquire_runtime_admission_class(true).await
    }

    async fn acquire_runtime_admission_class(
        &self,
        read_only: bool,
    ) -> ApiResult<Transaction<'static, Postgres>> {
        let mut transaction = self.pool.begin().await?;
        // The session default is intentionally short, but this transaction is
        // the operation-lifetime admission permit. It must never disappear
        // while its HTTP handler can still mutate external or database state.
        sqlx::query("SET LOCAL idle_in_transaction_session_timeout = 0")
            .execute(&mut *transaction)
            .await?;
        sqlx::query(
            "SELECT pg_advisory_xact_lock_shared(hashtextextended('mdbase-hosted-query-admission-v1', 0))",
        )
        .execute(&mut *transaction)
        .await?;
        let admitted: bool = sqlx::query_scalar(
            r#"SELECT NOT query_admission_suspended
                    AND (
                      admission_fence_token IS NULL
                      OR (
                        $1
                        AND admission_fence_kind = 'cutover'
                        AND admission_lease_expires_at > clock_timestamp()
                      )
                    )
               FROM hosted_provider_runtime_control
               WHERE singleton = true"#,
        )
        .bind(read_only)
        .fetch_optional(&mut *transaction)
        .await?
        .unwrap_or(false);
        if !admitted {
            transaction.rollback().await?;
            return Err(ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "hosted_query_admission_suspended",
                "Hosted operation admission is temporarily suspended for a controlled rollout operation.",
            ));
        }
        Ok(transaction)
    }
}
