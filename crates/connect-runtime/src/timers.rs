use chrono::{DateTime, Utc};
use mdbase_connect_protocol::GrantSummary;
use mdbase_runtime::{
    Runtime, RuntimeError, TimerReconcileRequest, TimerRecord, TimerRequest, TimerStatus,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::fmt;

use crate::{NotificationCatalog, TIMER_EVENT_ID};

const MAX_TIMERS_PER_RECONCILIATION: usize = 10_000;
const MAX_TIMER_DATA_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TimerOperationError {
    pub code: String,
    pub message: String,
    pub internal: bool,
}

impl TimerOperationError {
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: "invalid_timer_request".to_string(),
            message: message.into(),
            internal: false,
        }
    }

    fn runtime(error: RuntimeError) -> Self {
        Self {
            code: error.code().to_string(),
            message: error.to_string(),
            internal: true,
        }
    }
}

impl fmt::Display for TimerOperationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for TimerOperationError {}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct NamespaceInput {
    namespace: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PutInput {
    namespace: String,
    criterion_id: String,
    timer: DesiredTimer,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CancelInput {
    namespace: String,
    id: String,
    #[serde(default)]
    generation: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReconcileInput {
    namespace: String,
    criterion_id: String,
    timers: Vec<DesiredTimer>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DesiredTimer {
    id: String,
    fire_at: String,
    #[serde(default)]
    data: Value,
}

pub async fn perform_timer_operation(
    runtime: &Runtime,
    catalog: &NotificationCatalog,
    grant: &GrantSummary,
    operation: &str,
    input: Value,
) -> Result<Value, TimerOperationError> {
    match operation {
        "list_timers" => {
            let input: NamespaceInput = parse_input(input)?;
            validate_namespace(&input.namespace)?;
            let prefix = timer_prefix(grant, &input.namespace);
            let timers = runtime
                .timers(&prefix)
                .await
                .map_err(TimerOperationError::runtime)?;
            Ok(json!({
                "namespace": input.namespace,
                "timers": timers
                    .iter()
                    .map(|timer| timer_summary(timer, &prefix))
                    .collect::<Result<Vec<_>, _>>()?
            }))
        }
        "put_timer" => {
            let input: PutInput = parse_input(input)?;
            validate_namespace(&input.namespace)?;
            validate_criterion(grant, &input.criterion_id)?;
            let prefix = timer_prefix(grant, &input.namespace);
            let timer = desired_timer(
                catalog,
                grant,
                &input.namespace,
                &input.criterion_id,
                &prefix,
                input.timer,
            )?;
            let timer_id = timer.id.clone();
            let timer = runtime
                .reconcile_timers(TimerReconcileRequest {
                    id_prefix: timer_id,
                    timers: vec![timer],
                })
                .await
                .map_err(TimerOperationError::runtime)?
                .timers
                .into_iter()
                .next()
                .ok_or_else(|| {
                    TimerOperationError::runtime(RuntimeError::Store(
                        "Timer reconciliation omitted its desired timer.".to_string(),
                    ))
                })?;
            timer_summary(&timer, &prefix)
        }
        "cancel_timer" => {
            let input: CancelInput = parse_input(input)?;
            validate_namespace(&input.namespace)?;
            validate_id(&input.id)?;
            let prefix = timer_prefix(grant, &input.namespace);
            let cancelled = runtime
                .cancel_timer(&internal_timer_id(&prefix, &input.id), input.generation)
                .await
                .map_err(TimerOperationError::runtime)?;
            Ok(json!({
                "namespace": input.namespace,
                "id": input.id,
                "cancelled": cancelled
            }))
        }
        "reconcile_timers" => {
            let input: ReconcileInput = parse_input(input)?;
            validate_namespace(&input.namespace)?;
            validate_criterion(grant, &input.criterion_id)?;
            if input.timers.len() > MAX_TIMERS_PER_RECONCILIATION {
                return Err(TimerOperationError::invalid(format!(
                    "A timer reconciliation may contain at most {MAX_TIMERS_PER_RECONCILIATION} timers."
                )));
            }
            let prefix = timer_prefix(grant, &input.namespace);
            let mut ids = BTreeSet::new();
            let timers = input
                .timers
                .into_iter()
                .map(|timer| {
                    if !ids.insert(timer.id.clone()) {
                        return Err(TimerOperationError::invalid(format!(
                            "Timer {} appears more than once.",
                            timer.id
                        )));
                    }
                    desired_timer(
                        catalog,
                        grant,
                        &input.namespace,
                        &input.criterion_id,
                        &prefix,
                        timer,
                    )
                })
                .collect::<Result<Vec<_>, _>>()?;
            let outcome = runtime
                .reconcile_timers(TimerReconcileRequest {
                    id_prefix: prefix.clone(),
                    timers,
                })
                .await
                .map_err(TimerOperationError::runtime)?;
            Ok(json!({
                "namespace": input.namespace,
                "timers": outcome
                    .timers
                    .iter()
                    .map(|timer| timer_summary(timer, &prefix))
                    .collect::<Result<Vec<_>, _>>()?,
                "cancelled_ids": outcome
                    .cancelled_ids
                    .iter()
                    .map(|id| external_id(id, &prefix))
                    .collect::<Result<Vec<_>, _>>()?
            }))
        }
        _ => Err(TimerOperationError::invalid(
            "The requested timer operation is unsupported.",
        )),
    }
}

fn parse_input<T: for<'de> Deserialize<'de>>(input: Value) -> Result<T, TimerOperationError> {
    serde_json::from_value(input)
        .map_err(|error| TimerOperationError::invalid(format!("Invalid timer input: {error}")))
}

fn validate_namespace(namespace: &str) -> Result<(), TimerOperationError> {
    validate_key("Timer namespace", namespace, 64, false)
}

fn validate_id(id: &str) -> Result<(), TimerOperationError> {
    validate_key("Timer ID", id, 128, true)
}

fn validate_key(
    label: &str,
    value: &str,
    max_length: usize,
    allow_colon: bool,
) -> Result<(), TimerOperationError> {
    if value.is_empty()
        || value.len() > max_length
        || !value.bytes().all(|character| {
            character.is_ascii_alphanumeric()
                || matches!(character, b'.' | b'_' | b'-')
                || (allow_colon && character == b':')
        })
    {
        return Err(TimerOperationError::invalid(format!(
            "{label} must contain 1 to {max_length} ASCII letters, numbers, dots, underscores, or dashes{}.",
            if allow_colon { ", or colons" } else { "" }
        )));
    }
    Ok(())
}

fn validate_criterion(grant: &GrantSummary, criterion_id: &str) -> Result<(), TimerOperationError> {
    let criterion = grant
        .notification_criteria
        .iter()
        .find(|criterion| criterion.id == criterion_id);
    if criterion.is_none_or(|criterion| {
        criterion.event.id != TIMER_EVENT_ID
            || !semver::VersionReq::parse(&criterion.event.version)
                .is_ok_and(|requirement| requirement.matches(&semver::Version::new(1, 0, 0)))
    }) {
        return Err(TimerOperationError {
            code: "timer_criterion_not_authorized".to_string(),
            message:
                "The grant does not authorize that timer notification criterion at version 1.0.0."
                    .to_string(),
            internal: false,
        });
    }
    Ok(())
}

fn timer_prefix(grant: &GrantSummary, namespace: &str) -> String {
    format!("connect:{}:{namespace}:", grant.id)
}

fn desired_timer(
    catalog: &NotificationCatalog,
    grant: &GrantSummary,
    namespace: &str,
    criterion_id: &str,
    prefix: &str,
    timer: DesiredTimer,
) -> Result<TimerRequest, TimerOperationError> {
    validate_id(&timer.id)?;
    if serde_json::to_vec(&timer.data)
        .map_err(|error| TimerOperationError::invalid(error.to_string()))?
        .len()
        > MAX_TIMER_DATA_BYTES
    {
        return Err(TimerOperationError::invalid(format!(
            "Timer data may contain at most {MAX_TIMER_DATA_BYTES} encoded bytes."
        )));
    }
    let fire_at = DateTime::parse_from_rfc3339(&timer.fire_at)
        .map_err(|_| TimerOperationError::invalid("Timer fire_at must be an RFC 3339 timestamp."))?
        .with_timezone(&Utc);
    Ok(TimerRequest {
        id: internal_timer_id(prefix, &timer.id),
        fire_at,
        contract: catalog.timer_contract().clone(),
        source: catalog.timer_source().clone(),
        source_uri: catalog.source_uri().to_string(),
        subject: Some(grant.collection_id.to_string()),
        data: json!({
            "grant_id": grant.id,
            "criterion_id": criterion_id,
            "namespace": namespace,
            "timer_id": timer.id,
            "data": timer.data
        }),
    })
}

fn timer_summary(timer: &TimerRecord, prefix: &str) -> Result<Value, TimerOperationError> {
    let status = match timer.status {
        TimerStatus::Scheduled => "scheduled",
        TimerStatus::Firing => "firing",
        TimerStatus::Fired => "fired",
        TimerStatus::Cancelled => "cancelled",
    };
    Ok(json!({
        "id": external_id(&timer.id, prefix)?,
        "criterion_id": timer.data.get("criterion_id").and_then(Value::as_str),
        "fire_at": timer.fire_at.to_rfc3339(),
        "generation": timer.generation,
        "status": status,
        "created_at": timer.created_at.to_rfc3339(),
        "updated_at": timer.updated_at.to_rfc3339(),
        "fired_at": timer.fired_at.map(|value| value.to_rfc3339()),
        "data": timer.data.get("data").cloned().unwrap_or(Value::Null)
    }))
}

fn external_id(id: &str, prefix: &str) -> Result<String, TimerOperationError> {
    id.strip_prefix(prefix)
        .and_then(|id| id.strip_prefix("timer."))
        .and_then(decode_timer_id)
        .ok_or_else(|| {
            TimerOperationError::runtime(RuntimeError::Store(
                "The runtime returned a timer outside its grant namespace.".to_string(),
            ))
        })
}

fn internal_timer_id(prefix: &str, id: &str) -> String {
    let encoded = id
        .as_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("{prefix}timer.{encoded}")
}

fn decode_timer_id(encoded: &str) -> Option<String> {
    if !encoded.len().is_multiple_of(2) {
        return None;
    }
    let bytes = (0..encoded.len())
        .step_by(2)
        .map(|offset| u8::from_str_radix(&encoded[offset..offset + 2], 16).ok())
        .collect::<Option<Vec<_>>>()?;
    String::from_utf8(bytes).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use mdbase_connect_protocol::{
        ApplicationAccess, ContractRequirement, GrantScope, NotificationCriterion,
        NotificationPresentation,
    };
    use mdbase_runtime::{
        DenyAllAuthorizer, ImplementationIdentity, InMemoryRuntimeStore, ManualClock,
        ProviderRegistry, RuntimeConfig, RuntimeStore,
    };
    use std::sync::Arc;
    use std::time::Duration;
    use uuid::Uuid;

    #[tokio::test]
    async fn reconciles_only_the_calling_grants_namespace() {
        let (runtime, store) = runtime();
        let grant_a = grant("reminder");
        let grant_b = grant("reminder");
        let catalog = catalog(&[grant_a.clone(), grant_b.clone()]);
        let input = json!({
            "namespace": "task-reminders",
            "criterion_id": "reminder",
            "timers": [{
                "id": "task-a:one",
                "fire_at": "2026-07-25T10:00:00Z",
                "data": {"task_id": "task-a"}
            }]
        });
        let first = perform_timer_operation(
            &runtime,
            &catalog,
            &grant_a,
            "reconcile_timers",
            input.clone(),
        )
        .await
        .unwrap();
        perform_timer_operation(&runtime, &catalog, &grant_b, "reconcile_timers", input)
            .await
            .unwrap();
        perform_timer_operation(
            &runtime,
            &catalog,
            &grant_a,
            "reconcile_timers",
            json!({
                "namespace": "task-reminders",
                "criterion_id": "reminder",
                "timers": []
            }),
        )
        .await
        .unwrap();

        assert_eq!(first["timers"][0]["id"], "task-a:one");
        let snapshot = store.snapshot().await.unwrap();
        let active = snapshot
            .timers
            .iter()
            .filter(|timer| timer.status == TimerStatus::Scheduled)
            .collect::<Vec<_>>();
        assert_eq!(active.len(), 1);
        assert!(active[0].id.contains(&grant_b.id.to_string()));
        assert_eq!(active[0].data["grant_id"], grant_b.id.to_string());
    }

    #[tokio::test]
    async fn rejects_unapproved_timer_criteria_and_prefix_shaped_namespaces() {
        let (runtime, _) = runtime();
        let grant = grant("other");
        let catalog = catalog(std::slice::from_ref(&grant));
        let error = perform_timer_operation(
            &runtime,
            &catalog,
            &grant,
            "put_timer",
            json!({
                "namespace": "task:reminders",
                "criterion_id": "reminder",
                "timer": {"id": "one", "fire_at": "2026-07-25T10:00:00Z"}
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "invalid_timer_request");

        let error = perform_timer_operation(
            &runtime,
            &catalog,
            &grant,
            "put_timer",
            json!({
                "namespace": "task-reminders",
                "criterion_id": "reminder",
                "timer": {"id": "one", "fire_at": "2026-07-25T10:00:00Z"}
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "timer_criterion_not_authorized");
    }

    fn runtime() -> (Runtime, Arc<InMemoryRuntimeStore>) {
        let store = Arc::new(InMemoryRuntimeStore::new());
        let clock = ManualClock::new(Utc.with_ymd_and_hms(2026, 7, 25, 0, 0, 0).single().unwrap());
        let runtime = Runtime::new(
            store.clone(),
            ProviderRegistry::default(),
            Arc::new(DenyAllAuthorizer),
            Arc::new(clock),
            RuntimeConfig {
                runtime_id: "test".to_string(),
                executor_id: "test".to_string(),
                worker_id: "test".to_string(),
                actor_id: "test".to_string(),
                actor_kind: "service".to_string(),
                identity: ImplementationIdentity {
                    application: "mdbase.connect".to_string(),
                    implementation: "test-runtime".to_string(),
                    version: "1.0.0".to_string(),
                    instance_id: Some("test".to_string()),
                },
                timezone: None,
                lease_duration: Duration::from_secs(30),
                max_items: 10,
            },
        )
        .unwrap();
        (runtime, store)
    }

    fn grant(criterion_id: &str) -> GrantSummary {
        GrantSummary {
            contracts: mdbase_connect_protocol::ConnectContractRequirements::current(true),
            id: Uuid::new_v4(),
            application_id: Uuid::new_v4(),
            application_name: "Tasks".to_string(),
            application_distribution: "web".to_string(),
            application_homepage: "https://tasks.example".to_string(),
            application_project_url: None,
            application_origin: "https://tasks.example".to_string(),
            application_icon: None,
            collection_id: Uuid::new_v4(),
            collection_name: "Tasks".to_string(),
            operations: vec!["reconcile_timers".to_string()],
            scope: GrantScope {
                contracts: Vec::new(),
                access: ApplicationAccess::FullCollection,
            },
            notification_criteria: vec![NotificationCriterion {
                id: criterion_id.to_string(),
                event: ContractRequirement {
                    id: TIMER_EVENT_ID.to_string(),
                    version: "1.0.0".to_string(),
                    digest: format!("sha256:{}", "0".repeat(64)),
                },
                r#if: None,
                debounce: None,
                minimum_interval: None,
                presentation: NotificationPresentation {
                    title: "Reminder".to_string(),
                    body: None,
                    tag: None,
                },
            }],
            created_at: "2026-07-25T00:00:00Z".to_string(),
            encryption: None,
            file_capability: None,
        }
    }

    fn catalog(grants: &[GrantSummary]) -> NotificationCatalog {
        crate::compose_notification_catalog(
            grants,
            ImplementationIdentity {
                application: "mdbase.connect".to_string(),
                implementation: "test-authority".to_string(),
                version: "1.0.0".to_string(),
                instance_id: Some("test".to_string()),
            },
            "urn:mdbase:connect:test",
        )
        .unwrap()
    }
}
