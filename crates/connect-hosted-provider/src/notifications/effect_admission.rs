//! Original persisted-attempt admission and the existing CP effect callback.
use super::*;

#[async_trait]
impl ActionProvider for HostedSignalProvider {
    async fn dispatch(
        &self,
        invocation: ActionInvocation,
    ) -> Result<ActionOutcome, DispatchFailure> {
        let grant_id = input_uuid(&invocation.input, "grant_id")?;
        let criterion_id = input_string(&invocation.input, "criterion_id")?;
        let cursor = input_string(&invocation.input, "cursor")?;
        // Admit the ORIGINAL persisted run/action attempt on this effect's own
        // connection. A recovery-loop guard on another connection is not proof.
        let mut admission = self.pool.begin().await.map_err(|_| {
            dispatch_error(
                "Notification admission unavailable.",
                DispatchOutcome::NotApplied,
            )
        })?;
        sqlx::query("SET LOCAL lock_timeout = '5s'")
            .execute(&mut *admission)
            .await
            .map_err(|_| {
                dispatch_error(
                    "Notification admission unavailable.",
                    DispatchOutcome::NotApplied,
                )
            })?;
        let state = sqlx::query_scalar::<_, String>(
            "SELECT state FROM hosted_provider_collections WHERE id = $1 FOR SHARE",
        )
        .bind(self.collection_id)
        .fetch_optional(&mut *admission)
        .await
        .map_err(|_| {
            dispatch_error(
                "Notification admission unavailable.",
                DispatchOutcome::NotApplied,
            )
        })?;
        if state.as_deref() != Some("active") {
            admission.rollback().await.map_err(|_| {
                dispatch_error(
                    "Notification admission unavailable.",
                    DispatchOutcome::NotApplied,
                )
            })?;
            return Err(dispatch_error(
                "skipped_non_active",
                DispatchOutcome::NotApplied,
            ));
        }
        let admitted = sqlx::query(
            "UPDATE mdbase_runtime_runs SET revision = revision
             WHERE namespace = $1 AND status = 'running'
               AND lease_token IS NOT NULL AND lease_worker IS NOT NULL
               AND lease_expires_at > clock_timestamp()
               AND record_json->'attempts'->((record_json->>'active_attempt')::integer)->>'invocation_id' = $2
               AND record_json->'attempts'->((record_json->>'active_attempt')::integer)->>'status' = 'dispatching'",
        ).bind(format!("connect-hosted:{}:notifications", self.collection_id))
            .bind(&invocation.invocation_id).execute(&mut *admission).await
            .map_err(|_| dispatch_error("Notification lease admission unavailable.", DispatchOutcome::NotApplied))?
            .rows_affected();
        if admitted != 1 {
            admission.rollback().await.map_err(|_| {
                dispatch_error(
                    "Notification admission unavailable.",
                    DispatchOutcome::NotApplied,
                )
            })?;
            return Err(dispatch_error(
                "Notification original lease is not current.",
                DispatchOutcome::NotApplied,
            ));
        }
        admission.commit().await.map_err(|_| {
            dispatch_error(
                "Notification admission commit unavailable.",
                DispatchOutcome::NotApplied,
            )
        })?;
        // The admitted durable run remains a drain blocker until genuine finish.
        let response = self
            .client
            .post(format!(
                "{}/internal/v1/hosted/notification-signals",
                self.control_plane_url
            ))
            .bearer_auth(&self.internal_token)
            .json(&json!({
                "signal_id": invocation.invocation_id,
                "grant_id": grant_id,
                "criterion_id": criterion_id,
                "cursor": cursor
            }))
            .send()
            .await
            .map_err(|error| dispatch_error(error.to_string(), DispatchOutcome::Unknown))?;
        if !response.status().is_success() {
            let outcome = if response.status().is_client_error() {
                DispatchOutcome::NotApplied
            } else {
                DispatchOutcome::Unknown
            };
            return Err(dispatch_error(
                format!("Notification control plane returned {}.", response.status()),
                outcome,
            ));
        }
        Ok(successful_notification_outcome(&invocation))
    }
}
