use async_trait::async_trait;
use chrono::Utc;
use mdbase_connect_protocol::GrantSummary;
use mdbase_connect_runtime::{
    compose_notification_catalog, drain_notification_runtime, notification_event_envelope,
    perform_timer_operation, successful_notification_outcome, AuthorityEvent, NotificationCatalog,
    NOTIFICATION_EXECUTOR_ID, TIMER_EVENT_ID,
};
use mdbase_runtime::{
    ActionDispatch, ActionInvocation, ActionOutcome, ActionProvider, AuthorizationDecision,
    DispatchAuthorizer, DispatchFailure, DispatchOutcome, ImplementationIdentity,
    PostgresRuntimeStore, ProviderRegistry, Runtime, RuntimeConfig, RuntimeStore, TimerFireOutcome,
};
use serde_json::{json, Value};
use sqlx::{PgPool, Row};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};

#[derive(Debug, Clone)]
pub struct HostedNotificationConfig {
    pub control_plane_url: String,
    pub internal_token: String,
}

#[derive(Clone)]
pub struct HostedNotificationRuntime {
    pool: PgPool,
    config: HostedNotificationConfig,
    client: reqwest::Client,
    runtimes: Arc<Mutex<HashMap<Uuid, Arc<Runtime>>>>,
}

impl HostedNotificationRuntime {
    pub fn new(pool: PgPool, mut config: HostedNotificationConfig) -> ApiResult<Self> {
        config.control_plane_url = url::Url::parse(&config.control_plane_url)
            .map_err(|_| {
                ApiError::bad_request(
                    "invalid_control_plane_url",
                    "The notification control-plane URL is invalid.",
                )
            })?
            .origin()
            .ascii_serialization();
        if config.internal_token.len() < 32 {
            return Err(ApiError::bad_request(
                "invalid_internal_token",
                "The notification callback credential must contain at least 32 characters.",
            ));
        }
        Ok(Self {
            pool,
            config,
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(5))
                .build()
                .map_err(|error| ApiError::internal(error.to_string()))?,
            runtimes: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    pub async fn prepare(&self) -> ApiResult<()> {
        PostgresRuntimeStore::prepare(&self.pool)
            .await
            .map_err(runtime_error)?;
        let rows = sqlx::query(
            "SELECT grant_id, collection_id, grant_json
             FROM hosted_provider_notification_grants
             ORDER BY collection_id, grant_id",
        )
        .fetch_all(&self.pool)
        .await?;
        let mut grants_by_collection = HashMap::<Uuid, Vec<GrantSummary>>::new();
        for row in rows {
            let grant_id: Uuid = row.get("grant_id");
            let collection_id: Uuid = row.get("collection_id");
            let value: Value = row.get("grant_json");
            let grant = serde_json::from_value::<GrantSummary>(value).map_err(|error| {
                ApiError::internal(format!(
                    "Hosted notification grant {grant_id} is incompatible with this build: {error}"
                ))
            })?;
            if grant.id != grant_id || grant.collection_id != collection_id {
                return Err(ApiError::internal(format!(
                    "Hosted notification grant {grant_id} does not match its stored identity."
                )));
            }
            grants_by_collection
                .entry(collection_id)
                .or_default()
                .push(grant);
        }
        for (collection_id, grants) in grants_by_collection {
            compose_catalog(&grants, collection_id).map_err(|error| {
                ApiError::internal(format!(
                    "Hosted notification grants for collection {collection_id} are incompatible with this build: {error}"
                ))
            })?;
        }
        Ok(())
    }

    pub async fn upsert_grant(&self, collection_id: Uuid, grant: GrantSummary) -> ApiResult<()> {
        if grant.collection_id != collection_id {
            return Err(ApiError::bad_request(
                "notification_collection_mismatch",
                "The notification grant belongs to another collection.",
            ));
        }
        compose_catalog(std::slice::from_ref(&grant), collection_id).map_err(|error| {
            ApiError::bad_request("notification_runtime_invalid", error.to_string())
        })?;
        sqlx::query(
            "INSERT INTO hosted_provider_notification_grants
                (grant_id, collection_id, grant_json)
             VALUES ($1, $2, $3)
             ON CONFLICT(grant_id) DO UPDATE SET
                collection_id = excluded.collection_id,
                grant_json = excluded.grant_json,
                updated_at = now()",
        )
        .bind(grant.id)
        .bind(collection_id)
        .bind(serde_json::to_value(grant).map_err(|error| ApiError::internal(error.to_string()))?)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn revoke_grant(&self, grant_id: Uuid) -> ApiResult<()> {
        sqlx::query("DELETE FROM hosted_provider_notification_grants WHERE grant_id = $1")
            .bind(grant_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn timer_operation(
        &self,
        collection_id: Uuid,
        grant_id: Uuid,
        operation: &str,
        input: Value,
    ) -> ApiResult<Value> {
        let grant = sqlx::query_scalar::<_, Value>(
            "SELECT grant_json FROM hosted_provider_notification_grants
             WHERE grant_id = $1 AND collection_id = $2",
        )
        .bind(grant_id)
        .bind(collection_id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| {
            ApiError::forbidden(
                "timer_grant_unavailable",
                "The application grant is not active in this timer authority.",
            )
        })
        .and_then(|value| {
            serde_json::from_value::<GrantSummary>(value)
                .map_err(|error| ApiError::internal(error.to_string()))
        })?;
        let catalog =
            compose_catalog(std::slice::from_ref(&grant), collection_id).map_err(runtime_error)?;
        let runtime = self.runtime(collection_id).await?;
        perform_timer_operation(&runtime, &catalog, &grant, operation, input)
            .await
            .map_err(|error| {
                if error.internal {
                    ApiError::internal(error.message)
                } else {
                    ApiError::bad_request("invalid_timer_request", error.message)
                }
            })
    }

    pub async fn recover(&self, limit: usize) -> ApiResult<usize> {
        let processed = self.process_outbox(limit).await?;
        let collections = sqlx::query_scalar::<_, Uuid>(
            "SELECT DISTINCT collection_id FROM hosted_provider_notification_grants",
        )
        .fetch_all(&self.pool)
        .await?;
        for collection_id in collections {
            let grants = self.grants(collection_id).await?;
            if grants.is_empty() {
                continue;
            }
            let catalog = compose_catalog(&grants, collection_id).map_err(runtime_error)?;
            let runtime = self.runtime(collection_id).await?;
            for _ in 0..100 {
                if matches!(
                    runtime
                        .fire_due_timer(catalog.admission())
                        .await
                        .map_err(runtime_error)?,
                    TimerFireOutcome::Idle
                ) {
                    break;
                }
            }
            drain_notification_runtime(&runtime, 100)
                .await
                .map_err(runtime_error)?;
        }
        Ok(processed)
    }

    async fn process_outbox(&self, limit: usize) -> ApiResult<usize> {
        let rows = sqlx::query(
            "SELECT candidate.collection_id, candidate.sequence, candidate.event_type,
                    candidate.payload, candidate.occurred_at, candidate.attempts
             FROM hosted_provider_runtime_outbox candidate
             WHERE candidate.processed_at IS NULL
               AND candidate.available_at <= now()
               AND (candidate.lease_token IS NULL OR candidate.leased_until < now())
             ORDER BY candidate.collection_id, candidate.sequence
             LIMIT $1",
        )
        .bind(i64::try_from(limit.clamp(1, 1_000)).unwrap_or(1_000))
        .fetch_all(&self.pool)
        .await?;
        let mut processed = 0;
        for row in rows {
            let collection_id: Uuid = row.get("collection_id");
            let sequence = u64::try_from(row.get::<i64, _>("sequence"))
                .map_err(|_| ApiError::internal("Hosted runtime cursor is negative."))?;
            let attempts: i32 = row.get("attempts");
            let lease = Uuid::new_v4();
            let claimed = sqlx::query(
                "UPDATE hosted_provider_runtime_outbox
                 SET lease_token = $3, leased_until = now() + interval '30 seconds',
                     attempts = attempts + 1
                 WHERE collection_id = $1 AND sequence = $2 AND processed_at IS NULL
                   AND available_at <= now()
                   AND (lease_token IS NULL OR leased_until < now())
                   AND NOT EXISTS (
                     SELECT 1
                     FROM hosted_provider_runtime_outbox earlier
                     WHERE earlier.collection_id = $1
                       AND earlier.sequence < $2
                       AND earlier.processed_at IS NULL
                   )",
            )
            .bind(collection_id)
            .bind(i64::try_from(sequence).unwrap_or(i64::MAX))
            .bind(lease)
            .execute(&self.pool)
            .await?
            .rows_affected();
            if claimed != 1 {
                continue;
            }
            let result = self
                .process_event(
                    collection_id,
                    sequence,
                    row.get("event_type"),
                    row.get("payload"),
                    row.get::<chrono::DateTime<Utc>, _>("occurred_at")
                        .to_rfc3339(),
                )
                .await;
            match result {
                Ok(()) => {
                    sqlx::query(
                        "UPDATE hosted_provider_runtime_outbox
                         SET processed_at = now(), lease_token = NULL, leased_until = NULL,
                             last_error = NULL
                         WHERE collection_id = $1 AND sequence = $2 AND lease_token = $3",
                    )
                    .bind(collection_id)
                    .bind(i64::try_from(sequence).unwrap_or(i64::MAX))
                    .bind(lease)
                    .execute(&self.pool)
                    .await?;
                    processed += 1;
                }
                Err(error) => {
                    let retry_at =
                        Utc::now() + chrono::TimeDelta::seconds(retry_delay_seconds(attempts + 1));
                    sqlx::query(
                        "UPDATE hosted_provider_runtime_outbox
                         SET lease_token = NULL, leased_until = NULL, available_at = $4,
                             last_error = $5
                         WHERE collection_id = $1 AND sequence = $2 AND lease_token = $3",
                    )
                    .bind(collection_id)
                    .bind(i64::try_from(sequence).unwrap_or(i64::MAX))
                    .bind(lease)
                    .bind(retry_at)
                    .bind(error.to_string().chars().take(1_000).collect::<String>())
                    .execute(&self.pool)
                    .await?;
                    tracing::warn!(%collection_id, sequence, %error, "hosted runtime event deferred");
                }
            }
        }
        Ok(processed)
    }

    async fn process_event(
        &self,
        collection_id: Uuid,
        cursor: u64,
        event_type: String,
        payload: Value,
        occurred_at: String,
    ) -> ApiResult<()> {
        let grants = self.grants(collection_id).await?;
        if !grants.iter().any(|grant| {
            grant
                .notification_criteria
                .iter()
                .any(|criterion| criterion.event.id == event_type)
        }) {
            return Ok(());
        }
        let catalog = compose_catalog(&grants, collection_id).map_err(runtime_error)?;
        let runtime = self.runtime(collection_id).await?;
        let envelope = notification_event_envelope(
            &AuthorityEvent {
                collection_id,
                cursor,
                event_type,
                occurred_at,
                payload,
            },
            &catalog,
        )
        .map_err(runtime_error)?;
        runtime
            .deliver_event(catalog.admission(), envelope)
            .await
            .map_err(runtime_error)?;
        drain_notification_runtime(&runtime, 100)
            .await
            .map_err(runtime_error)?;
        Ok(())
    }

    async fn grants(&self, collection_id: Uuid) -> ApiResult<Vec<GrantSummary>> {
        sqlx::query_scalar::<_, Value>(
            "SELECT grant_json FROM hosted_provider_notification_grants
             WHERE collection_id = $1 ORDER BY grant_id",
        )
        .bind(collection_id)
        .fetch_all(&self.pool)
        .await?
        .into_iter()
        .map(|value| {
            serde_json::from_value(value).map_err(|error| ApiError::internal(error.to_string()))
        })
        .collect()
    }

    async fn runtime(&self, collection_id: Uuid) -> ApiResult<Arc<Runtime>> {
        if let Some(runtime) = self.runtimes.lock().await.get(&collection_id).cloned() {
            return Ok(runtime);
        }
        let store: Arc<dyn RuntimeStore> = Arc::new(
            PostgresRuntimeStore::new(
                self.pool.clone(),
                format!("connect-hosted:{collection_id}:notifications"),
            )
            .await
            .map_err(runtime_error)?,
        );
        let providers = ProviderRegistry::default();
        let timezone = sqlx::query_scalar::<_, String>(
            "SELECT timezone FROM hosted_provider_collections WHERE id = $1",
        )
        .bind(collection_id)
        .fetch_one(&self.pool)
        .await?;
        let catalog = compose_catalog(&[], collection_id).map_err(runtime_error)?;
        providers.register(
            catalog.notification_provider_binding().clone(),
            Arc::new(HostedSignalProvider {
                client: self.client.clone(),
                control_plane_url: self.config.control_plane_url.clone(),
                internal_token: self.config.internal_token.clone(),
            }),
        );
        let runtime = Arc::new(
            Runtime::new(
                store,
                providers,
                Arc::new(HostedNotificationAuthorizer {
                    pool: self.pool.clone(),
                    collection_id,
                }),
                Arc::new(mdbase_runtime::SystemClock),
                RuntimeConfig {
                    runtime_id: format!("mdbase-connect-hosted:{collection_id}"),
                    executor_id: NOTIFICATION_EXECUTOR_ID.to_string(),
                    worker_id: format!("hosted-provider:{}", Uuid::new_v4()),
                    actor_id: "mdbase-connect-hosted-provider".to_string(),
                    actor_kind: "service".to_string(),
                    identity: runtime_identity(collection_id),
                    timezone: Some(timezone),
                    lease_duration: Duration::from_secs(10),
                    max_items: 50,
                },
            )
            .map_err(runtime_error)?,
        );
        let mut runtimes = self.runtimes.lock().await;
        Ok(runtimes
            .entry(collection_id)
            .or_insert_with(|| runtime.clone())
            .clone())
    }
}

#[derive(Clone)]
struct HostedSignalProvider {
    client: reqwest::Client,
    control_plane_url: String,
    internal_token: String,
}

#[async_trait]
impl ActionProvider for HostedSignalProvider {
    async fn dispatch(
        &self,
        invocation: ActionInvocation,
    ) -> Result<ActionOutcome, DispatchFailure> {
        let grant_id = input_uuid(&invocation.input, "grant_id")?;
        let criterion_id = input_string(&invocation.input, "criterion_id")?;
        let cursor = input_string(&invocation.input, "cursor")?;
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

#[derive(Clone)]
struct HostedNotificationAuthorizer {
    pool: PgPool,
    collection_id: Uuid,
}

#[async_trait]
impl DispatchAuthorizer for HostedNotificationAuthorizer {
    async fn authorize(&self, request: &ActionDispatch) -> AuthorizationDecision {
        let grant_id = match input_uuid(&request.input, "grant_id") {
            Ok(value) => value,
            Err(error) => return denied(&error.code, &error.message),
        };
        let criterion_id = match input_string(&request.input, "criterion_id") {
            Ok(value) => value,
            Err(error) => return denied(&error.code, &error.message),
        };
        let value = match sqlx::query_scalar::<_, Value>(
            "SELECT grant_json FROM hosted_provider_notification_grants
             WHERE grant_id = $1 AND collection_id = $2",
        )
        .bind(grant_id)
        .bind(self.collection_id)
        .fetch_optional(&self.pool)
        .await
        {
            Ok(Some(value)) => value,
            _ => {
                return denied(
                    "notification_grant_revoked",
                    "The hosted notification grant is no longer active.",
                )
            }
        };
        let Ok(grant) = serde_json::from_value::<GrantSummary>(value) else {
            return denied(
                "notification_grant_invalid",
                "The hosted notification grant is invalid.",
            );
        };
        let expected_source = source_uri(self.collection_id);
        if request.event.get("source").and_then(Value::as_str) != Some(expected_source.as_str()) {
            return denied(
                "notification_collection_mismatch",
                "The event belongs to another hosted collection.",
            );
        }
        let event_type = request.event.get("type").and_then(Value::as_str);
        if event_type == Some(TIMER_EVENT_ID)
            && (request
                .event
                .pointer("/data/data/grant_id")
                .and_then(Value::as_str)
                != Some(grant_id.to_string().as_str())
                || request
                    .event
                    .pointer("/data/data/criterion_id")
                    .and_then(Value::as_str)
                    != Some(criterion_id))
        {
            return denied(
                "notification_timer_owner_mismatch",
                "The timer does not belong to this grant and criterion.",
            );
        }
        let event_version = request
            .event
            .get("mdbasecontractversion")
            .and_then(Value::as_str);
        if grant.notification_criteria.iter().all(|criterion| {
            criterion.id != criterion_id
                || Some(criterion.event.id.as_str()) != event_type
                || Some(criterion.event.version.as_str()) != event_version
        }) {
            return denied(
                "notification_criterion_revoked",
                "The hosted grant no longer authorizes this notification criterion.",
            );
        }
        AuthorizationDecision::Allow
    }
}

fn compose_catalog(
    grants: &[GrantSummary],
    collection_id: Uuid,
) -> mdbase_runtime::RuntimeResult<NotificationCatalog> {
    compose_notification_catalog(
        grants,
        ImplementationIdentity {
            application: "mdbase.connect".to_string(),
            implementation: "hosted-authority".to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            instance_id: Some(collection_id.to_string()),
        },
        source_uri(collection_id),
    )
}

fn runtime_identity(collection_id: Uuid) -> ImplementationIdentity {
    ImplementationIdentity {
        application: "mdbase.connect".to_string(),
        implementation: "hosted-notification-runtime".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        instance_id: Some(collection_id.to_string()),
    }
}

fn source_uri(collection_id: Uuid) -> String {
    format!("urn:mdbase:connect:hosted:{collection_id}")
}

fn input_string<'a>(input: &'a Value, name: &str) -> Result<&'a str, DispatchFailure> {
    input.get(name).and_then(Value::as_str).ok_or_else(|| {
        dispatch_error(
            format!("Notification input field {name} must be a string."),
            DispatchOutcome::NotApplied,
        )
    })
}

fn input_uuid(input: &Value, name: &str) -> Result<Uuid, DispatchFailure> {
    input_string(input, name)?.parse().map_err(|_| {
        dispatch_error(
            format!("Notification input field {name} must be a UUID."),
            DispatchOutcome::NotApplied,
        )
    })
}

fn dispatch_error(message: String, outcome: DispatchOutcome) -> DispatchFailure {
    DispatchFailure {
        code: "notification_signal_failed".to_string(),
        message,
        outcome,
    }
}

fn denied(code: &str, message: &str) -> AuthorizationDecision {
    AuthorizationDecision::Deny {
        code: code.to_string(),
        message: message.to_string(),
    }
}

fn runtime_error(error: mdbase_runtime::RuntimeError) -> ApiError {
    ApiError::internal(error.to_string())
}

fn retry_delay_seconds(attempt: i32) -> i64 {
    2_i64
        .saturating_pow(u32::try_from(attempt.saturating_sub(1).min(10)).unwrap_or(10))
        .min(15 * 60)
}

#[cfg(test)]
mod tests {
    use super::retry_delay_seconds;

    #[test]
    fn notification_source_retries_back_off_and_cap() {
        assert_eq!(retry_delay_seconds(1), 1);
        assert_eq!(retry_delay_seconds(2), 2);
        assert_eq!(retry_delay_seconds(10), 512);
        assert_eq!(retry_delay_seconds(11), 900);
        assert_eq!(retry_delay_seconds(100), 900);
    }
}
