//! Connect-owned adapters for mdbase Runtime profile 0.1.
//!
//! The provider-neutral engine and collection semantics stay in `mdbase-rs`.
//! This crate only compiles application notification criteria into workflows
//! and converts authority events into canonical runtime envelopes.

use mdbase::runtime_contracts::{
    ComposeOptions, ContractDocument, ContractSource, PolicySelector, RuntimeContracts,
    RuntimeRegistry,
};
use mdbase_connect_protocol::{GrantSummary, NotificationCriterion};
use mdbase_runtime::{Runtime, WorkerOutcome};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use uuid::Uuid;

pub const NOTIFICATION_ACTION_ID: &str = "mdbase.connect.notification.signal";
pub const NOTIFICATION_EXECUTOR_ID: &str = "connect-notifications";
const POLICY_ID: &str = "mdbase.connect.notification.policy";
const TIMER_EVENT_ID: &str = "timer.fired";
const TIMER_PROVIDER_ID: &str = "mdbase.timer";

#[derive(Debug, Clone)]
pub struct AuthorityEvent {
    pub collection_id: Uuid,
    pub cursor: u64,
    pub event_type: String,
    pub occurred_at: String,
    pub payload: Value,
    pub runtime_id: String,
    pub provider_id: String,
}

pub fn compose_notification_registry(
    grants: &[GrantSummary],
    authority_provider_id: &str,
    authority_provider_name: &str,
) -> mdbase_runtime::RuntimeResult<RuntimeRegistry> {
    let mut events = BTreeMap::<String, u64>::new();
    let mut workflows = Vec::new();
    for grant in grants {
        for criterion in &grant.notification_criteria {
            match events.get(&criterion.event.id) {
                Some(version) if *version != criterion.event.version => {
                    return Err(mdbase_runtime::RuntimeError::diagnostic(
                        "notification_event_version_conflict",
                        format!(
                            "Notification criteria select incompatible versions of {}.",
                            criterion.event.id
                        ),
                    ));
                }
                _ => {
                    events.insert(criterion.event.id.clone(), criterion.event.version);
                }
            }
            workflows.push(workflow_contract(grant, criterion));
        }
    }
    let authority_events = events
        .keys()
        .filter(|id| id.as_str() != TIMER_EVENT_ID)
        .cloned()
        .collect::<Vec<_>>();
    let mut documents = vec![
        contract(json!({
            "type": "provider",
            "id": authority_provider_id,
            "version": 1,
            "name": authority_provider_name,
            "provider_version": env!("CARGO_PKG_VERSION"),
            "contracts": {"events": authority_events}
        })),
        contract(json!({
            "type": "provider",
            "id": "mdbase.connect.notification",
            "version": 1,
            "name": "mdbase Connect notifications",
            "provider_version": env!("CARGO_PKG_VERSION"),
            "contracts": {"actions": [NOTIFICATION_ACTION_ID]}
        })),
        contract(json!({
            "type": "action",
            "id": NOTIFICATION_ACTION_ID,
            "version": 1,
            "provider": "mdbase.connect.notification",
            "name": "Emit an opaque notification signal",
            "schemas": {
                "dialect": "json-schema-2020-12",
                "input": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["grant_id", "criterion_id", "cursor"],
                    "properties": {
                        "grant_id": {"type": "string", "format": "uuid"},
                        "criterion_id": {"type": "string"},
                        "cursor": {"type": "string"}
                    }
                },
                "output": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["accepted"],
                    "properties": {"accepted": {"type": "boolean"}}
                }
            },
            "dispatch": {
                "idempotency": "invocation_id",
                "cancellation": "none"
            }
        })),
        contract(json!({
            "type": "runtime_policy",
            "id": POLICY_ID,
            "version": 1,
            "name": "mdbase Connect notification policy",
            "executors": {"default": NOTIFICATION_EXECUTOR_ID}
        })),
    ];
    if events.contains_key(TIMER_EVENT_ID) {
        documents.push(contract(json!({
            "type": "provider",
            "id": TIMER_PROVIDER_ID,
            "version": 1,
            "name": "mdbase timer",
            "provider_version": mdbase_runtime::VERSION,
            "contracts": {"events": [TIMER_EVENT_ID]}
        })));
    }
    for (id, version) in events {
        let provider = if id == TIMER_EVENT_ID {
            TIMER_PROVIDER_ID
        } else {
            authority_provider_id
        };
        documents.push(contract(json!({
            "type": "event",
            "id": id,
            "version": version,
            "provider": provider,
            "name": "mdbase authority event",
            "schemas": {
                "dialect": "json-schema-2020-12",
                "payload": {"type": "object", "additionalProperties": true}
            }
        })));
    }
    documents.extend(workflows.into_iter().map(contract));
    let contracts = RuntimeContracts::new().map_err(|message| {
        mdbase_runtime::RuntimeError::diagnostic("runtime_contracts_unavailable", message)
    })?;
    let registry = contracts.compose(
        vec![ContractSource::built_in(documents)],
        &ComposeOptions {
            selected_policies: vec![PolicySelector::Id(POLICY_ID.to_string())],
        },
    );
    let preflight = contracts.preflight(&registry);
    if !preflight.valid {
        return Err(mdbase_runtime::RuntimeError::diagnostic(
            "notification_runtime_invalid",
            preflight
                .diagnostics
                .iter()
                .map(|diagnostic| format!("{}: {}", diagnostic.code, diagnostic.message))
                .collect::<Vec<_>>()
                .join("; "),
        ));
    }
    Ok(registry)
}

pub fn notification_event_envelope(
    event: &AuthorityEvent,
    registry: &RuntimeRegistry,
) -> mdbase_runtime::RuntimeResult<Value> {
    let contract = registry.events.get(&event.event_type).ok_or_else(|| {
        mdbase_runtime::RuntimeError::diagnostic(
            "notification_event_not_declared",
            format!(
                "No active notification criterion selects {}.",
                event.event_type
            ),
        )
    })?;
    let mut payload = event.payload.clone();
    if !payload.is_object() {
        payload = json!({"value": payload});
    }
    payload["cursor"] = Value::String(event.cursor.to_string());
    Ok(json!({
        "type": event.event_type,
        "contract_version": contract.contract.get("version").and_then(Value::as_u64).unwrap_or(1),
        "id": format!("change:{}:{}", event.collection_id, event.cursor),
        "occurred_at": event.occurred_at,
        "source": {
            "runtime": event.runtime_id,
            "provider": event.provider_id
        },
        "payload": payload
    }))
}

pub async fn drain_notification_runtime(
    runtime: &Runtime,
    registry: &RuntimeRegistry,
    max_runs: usize,
) -> mdbase_runtime::RuntimeResult<usize> {
    let mut completed = 0;
    for _ in 0..max_runs {
        match runtime.work_once(registry).await? {
            WorkerOutcome::Idle => break,
            WorkerOutcome::Completed { run_id, status } => {
                completed += 1;
                tracing::debug!(%run_id, ?status, "notification workflow completed");
            }
            WorkerOutcome::Deferred { run_id, reason } => {
                tracing::debug!(%run_id, %reason, "notification workflow deferred");
                break;
            }
        }
    }
    Ok(completed)
}

fn workflow_contract(grant: &GrantSummary, criterion: &NotificationCriterion) -> Value {
    let mut trigger = json!({
        "id": "notify",
        "event": criterion.event.id
    });
    if let Some(condition) = &criterion.r#if {
        trigger["if"] = json!({"$expr": condition.expression});
    }
    if let Some(debounce) = &criterion.debounce {
        trigger["debounce"] = Value::String(debounce.clone());
    }
    if let Some(interval) = &criterion.minimum_interval {
        trigger["minimum_interval"] = Value::String(interval.clone());
    }
    let cursor_expression = if criterion.event.id == TIMER_EVENT_ID {
        "event.id"
    } else {
        "event.payload.cursor"
    };
    json!({
        "type": "workflow",
        "id": format!("connect.notify.{}.{}", grant.id, criterion.id),
        "version": 1,
        "name": format!("Notify {} for {}", grant.application_name, criterion.id),
        "enabled": true,
        "triggers": [trigger],
        "steps": [{
            "id": "signal",
            "action": NOTIFICATION_ACTION_ID,
            "input": {
                "grant_id": grant.id,
                "criterion_id": criterion.id,
                "cursor": {"$expr": cursor_expression}
            }
        }],
        "run": {
            "execution": {"mode": "single_executor"},
            "concurrency": {
                "group": format!("{}:{}", grant.id, criterion.id),
                "policy": "queue"
            },
            "limits": {"max_items": 1},
            "on_error": "stop"
        }
    })
}

fn contract(value: Value) -> ContractDocument {
    ContractDocument::virtual_contract(value)
}
