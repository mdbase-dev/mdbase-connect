use super::*;

impl HostedProvider {
    /// Fail closed for every data/control route while a controlled rollout is
    /// fenced, or after a provisional cutover lease expires. Health endpoints
    /// deliberately bypass this gate so operators can distinguish a live but
    /// fenced process from a failed process.
    pub async fn enforce_runtime_admission(&self) -> ApiResult<()> {
        let admitted: bool = sqlx::query_scalar(
            r#"SELECT NOT query_admission_suspended
                    AND (
                      admission_fence_token IS NULL
                      OR (
                        admission_fence_kind = 'cutover'
                        AND admission_lease_expires_at > clock_timestamp()
                      )
                    )
               FROM hosted_provider_runtime_control
               WHERE singleton = true"#,
        )
        .fetch_optional(&self.pool)
        .await?
        .unwrap_or(false);
        if !admitted {
            return Err(ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "hosted_query_admission_suspended",
                "Hosted operation admission is temporarily suspended for a controlled rollout operation.",
            ));
        }
        Ok(())
    }
}
