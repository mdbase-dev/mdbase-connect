//! Connect-owned adapters for mdbase Runtime profile 0.2.
//!
//! The provider-neutral engine and collection semantics stay in `mdbase-rs`.
//! This crate supplies Connect's ordinary workflow/policy records, consumes
//! shared contract artifacts and interoperability declarations, and converts
//! authority events into structured CloudEvents. Executable providers remain
//! explicit host bindings; catalog content never activates code.

pub mod contract_scope;
mod timers;

use mdbase_connect_protocol::{ContractRequirement, GrantSummary, NotificationCriterion};
use mdbase_interop::{
    contract_digest, ActionInvocation, ActionOutcome, ExactContractReference,
    ImplementationIdentity,
};
use mdbase_runtime::{
    canonical_digest, AdmissionCatalog, ProviderBinding, Runtime, RuntimeError, WorkerOutcome,
};
use semver::{Version, VersionReq};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use uuid::Uuid;

pub use timers::{perform_timer_operation, TimerOperationError};

pub const NOTIFICATION_ACTION_ID: &str = "mdbase.connect.notification.signal";
pub const NOTIFICATION_EXECUTOR_ID: &str = "connect-notifications";
pub const TIMER_EVENT_ID: &str = "mdbase.runtime.timer.fired";

const CONTRACT_VERSION: &str = "1.0.0";
const INTEROP_PROFILE_VERSION: &str = "0.1";
const NOTIFICATION_HANDLER_ID: &str = "signal";
const POLICY_ID: &str = "mdbase.connect.notification.policy";
const RECORD_EVENT_IDS: [&str; 4] = [
    "mdbase.record.created",
    "mdbase.record.modified",
    "mdbase.record.deleted",
    "mdbase.record.renamed",
];

/// Passive, verified evidence used to admit notification work for one
/// collection. It contains no executable provider objects and grants no
/// authority by itself.
#[derive(Debug, Clone)]
pub struct NotificationCatalog {
    admission: AdmissionCatalog,
    contracts: BTreeMap<String, ExactContractReference>,
    authority_source: ImplementationIdentity,
    timer_source: ImplementationIdentity,
    source_uri: String,
    notification_provider_binding: ProviderBinding,
}

impl NotificationCatalog {
    pub fn admission(&self) -> &AdmissionCatalog {
        &self.admission
    }

    pub fn contract(&self, id: &str) -> Option<&ExactContractReference> {
        self.contracts.get(id)
    }

    pub fn timer_contract(&self) -> &ExactContractReference {
        self.contracts
            .get(TIMER_EVENT_ID)
            .expect("the built-in timer contract is always catalogued")
    }

    pub fn timer_source(&self) -> &ImplementationIdentity {
        &self.timer_source
    }

    pub fn source_uri(&self) -> &str {
        &self.source_uri
    }

    pub fn notification_provider_binding(&self) -> &ProviderBinding {
        &self.notification_provider_binding
    }
}

#[derive(Debug, Clone)]
pub struct AuthorityEvent {
    pub collection_id: Uuid,
    pub cursor: u64,
    pub event_type: String,
    pub occurred_at: String,
    pub payload: Value,
}

/// Compose notification admission evidence from ordinary application
/// requirements. Every requirement resolves to one shared exact contract;
/// source/provider declarations identify implementations without redefining
/// those contracts.
pub fn compose_notification_catalog(
    grants: &[GrantSummary],
    authority_source: ImplementationIdentity,
    source_uri: impl Into<String>,
) -> mdbase_runtime::RuntimeResult<NotificationCatalog> {
    let source_uri = source_uri.into();
    if !source_uri.contains(':') {
        return Err(RuntimeError::diagnostic(
            "invalid_notification_source",
            format!("Notification CloudEvent source {source_uri:?} must be an absolute URI."),
        ));
    }

    let artifacts = contract_artifacts()?;
    let contracts = artifacts
        .iter()
        .map(exact_contract)
        .collect::<mdbase_runtime::RuntimeResult<Vec<_>>>()?
        .into_iter()
        .map(|contract| (contract.id.clone(), contract))
        .collect::<BTreeMap<_, _>>();
    let mut workflows = Vec::new();
    for grant in grants {
        for criterion in &grant.notification_criteria {
            validate_requirement(&criterion.event, &contracts)?;
            workflows.push(workflow_record(grant, criterion));
        }
    }

    let timer_source = ImplementationIdentity {
        application: "mdbase.connect".to_string(),
        implementation: "notification-timer".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        instance_id: authority_source.instance_id.clone(),
    };
    let notification_provider = notification_provider_identity();
    let authority_contracts = RECORD_EVENT_IDS
        .iter()
        .map(|id| {
            contracts
                .get(*id)
                .expect("canonical record event contract is embedded")
                .clone()
        })
        .collect::<Vec<_>>();
    let timer_contract = contracts
        .get(TIMER_EVENT_ID)
        .expect("canonical timer event contract is embedded")
        .clone();
    let notification_contract = contracts
        .get(NOTIFICATION_ACTION_ID)
        .expect("notification action contract is embedded")
        .clone();

    let event_sources = vec![
        declaration(json!({
            "kind": "mdbase.event-source",
            "profile_version": INTEROP_PROFILE_VERSION,
            "declaration_id": "mdbase.connect.authority.events",
            "source": authority_source,
            "contracts": authority_contracts.into_iter().map(source_contract).collect::<Vec<_>>()
        }))?,
        declaration(json!({
            "kind": "mdbase.event-source",
            "profile_version": INTEROP_PROFILE_VERSION,
            "declaration_id": "mdbase.connect.timer.events",
            "source": timer_source,
            "contracts": [source_contract(timer_contract)]
        }))?,
    ];
    let provider_declaration = declaration(json!({
        "kind": "mdbase.action-provider",
        "profile_version": INTEROP_PROFILE_VERSION,
        "declaration_id": "mdbase.connect.notification.actions",
        "provider": notification_provider,
        "handlers": [{
            "handler_id": NOTIFICATION_HANDLER_ID,
            "requirement": {
                "id": notification_contract.id,
                "version": notification_contract.version
            },
            "resolved": notification_contract,
            "idempotency": {"mode": "request"},
            "cancellation": "none"
        }]
    }))?;
    let provider_digest = provider_declaration
        .get("declaration_digest")
        .and_then(Value::as_str)
        .expect("declaration helper supplies a digest")
        .to_string();
    let policy = json!({
        "type": "runtime_policy",
        "id": POLICY_ID,
        "version": CONTRACT_VERSION,
        "name": "mdbase connect notification policy",
        "enabled": true,
        "executors": {"default": NOTIFICATION_EXECUTOR_ID},
        "provider_selections": [{
            "contract": {"id": NOTIFICATION_ACTION_ID, "version": CONTRACT_VERSION},
            "selector": {
                "application": "mdbase.connect",
                "implementation": "notification-signal"
            }
        }],
        "grants": []
    });
    let admission = AdmissionCatalog::new(
        artifacts,
        event_sources,
        vec![provider_declaration],
        workflows,
        policy,
    )?;
    Ok(NotificationCatalog {
        admission,
        contracts,
        authority_source,
        timer_source,
        source_uri,
        notification_provider_binding: ProviderBinding {
            provider_declaration_digest: provider_digest,
            handler_id: NOTIFICATION_HANDLER_ID.to_string(),
        },
    })
}

pub fn notification_event_envelope(
    event: &AuthorityEvent,
    catalog: &NotificationCatalog,
) -> mdbase_runtime::RuntimeResult<Value> {
    if !RECORD_EVENT_IDS.contains(&event.event_type.as_str()) {
        return Err(RuntimeError::diagnostic(
            "notification_event_not_declared",
            format!(
                "{} is not a canonical record-change notification event.",
                event.event_type
            ),
        ));
    }
    let contract = catalog.contract(&event.event_type).ok_or_else(|| {
        RuntimeError::diagnostic(
            "notification_event_not_declared",
            format!("No exact contract is available for {}.", event.event_type),
        )
    })?;
    if !event.payload.is_object() {
        return Err(RuntimeError::diagnostic(
            "invalid_notification_event",
            format!("{} event data must be an object.", event.event_type),
        ));
    }
    let source = &catalog.authority_source;
    let mut envelope = json!({
        "specversion": "1.0",
        "id": format!("change:{}:{}", event.collection_id, event.cursor),
        "source": catalog.source_uri,
        "type": event.event_type,
        "time": event.occurred_at,
        "subject": event.collection_id.to_string(),
        "datacontenttype": "application/json",
        "dataschema": format!(
            "urn:mdbase:contract:{}:{}:{}",
            contract.id, contract.version, contract.digest
        ),
        "data": event.payload,
        "mdbaseprofile": INTEROP_PROFILE_VERSION,
        "mdbasecontractversion": contract.version,
        "mdbasecontractdigest": contract.digest,
        "mdbaseapplication": source.application,
        "mdbaseimplementation": source.implementation,
        "mdbaseimplementationversion": source.version,
        "mdbasecursor": event.cursor.to_string()
    });
    if let Some(instance_id) = &source.instance_id {
        envelope["mdbaseinstanceid"] = Value::String(instance_id.clone());
    }
    Ok(envelope)
}

pub async fn drain_notification_runtime(
    runtime: &Runtime,
    max_runs: usize,
) -> mdbase_runtime::RuntimeResult<usize> {
    let mut completed = 0;
    for _ in 0..max_runs {
        match runtime.work_once().await? {
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

/// Build the portable success evidence returned by either Connect notification
/// transport. Provider implementations supply the side effect; this helper
/// keeps exact admission pins intact in the outcome.
pub fn successful_notification_outcome(invocation: &ActionInvocation) -> ActionOutcome {
    ActionOutcome {
        kind: "mdbase.action.outcome".to_string(),
        profile_version: INTEROP_PROFILE_VERSION.to_string(),
        outcome_id: format!("out_{}", invocation.attempt_id),
        request_id: invocation.request_id.clone(),
        invocation_id: invocation.invocation_id.clone(),
        attempt_id: invocation.attempt_id.clone(),
        contract: invocation.contract.clone(),
        provider: invocation.provider.clone(),
        provider_declaration_digest: invocation.provider_declaration_digest.clone(),
        status: "succeeded".to_string(),
        completed_at: chrono::Utc::now().to_rfc3339(),
        output: Some(json!({"accepted": true})),
        error: None,
    }
}

fn workflow_record(grant: &GrantSummary, criterion: &NotificationCriterion) -> Value {
    let mut trigger = json!({
        "id": "notify",
        "event": criterion.event
    });
    let ownership = (criterion.event.id == TIMER_EVENT_ID).then(|| {
        format!(
            "event.data.data.grant_id == {} && event.data.data.criterion_id == {}",
            serde_json::to_string(&grant.id.to_string()).expect("UUID serializes"),
            serde_json::to_string(&criterion.id).expect("criterion ID serializes")
        )
    });
    if let Some(condition) = &criterion.r#if {
        let expression = ownership.map_or_else(
            || condition.expression.clone(),
            |ownership| format!("({ownership}) && ({})", condition.expression),
        );
        trigger["if"] = json!({"$expr": expression});
    } else if let Some(ownership) = ownership {
        trigger["if"] = json!({"$expr": ownership});
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
        "event.mdbasecursor"
    };
    json!({
        "type": "runtime_workflow",
        "id": format!("connect.notify.{}.{}", grant.id, criterion.id),
        "version": CONTRACT_VERSION,
        "name": format!("Notify {} for {}", grant.application_name, criterion.id),
        "enabled": true,
        "triggers": [trigger],
        "steps": [{
            "id": "signal",
            "action": {"id": NOTIFICATION_ACTION_ID, "version": CONTRACT_VERSION},
            "provider": {
                "application": "mdbase.connect",
                "implementation": "notification-signal"
            },
            "input": {
                "grant_id": grant.id,
                "criterion_id": criterion.id,
                "cursor": {"$expr": cursor_expression}
            }
        }],
        "run": {
            "concurrency": {
                "group": format!("{}:{}", grant.id, criterion.id),
                "policy": "queue"
            },
            "limits": {"max_items": 1},
            "on_error": "stop"
        }
    })
}

fn contract_artifacts() -> mdbase_runtime::RuntimeResult<Vec<Value>> {
    let schemas = [
        (
            "mdbase.record.created",
            include_str!("../contracts/mdbase.record.created-1.0.0.schema.json"),
        ),
        (
            "mdbase.record.modified",
            include_str!("../contracts/mdbase.record.modified-1.0.0.schema.json"),
        ),
        (
            "mdbase.record.deleted",
            include_str!("../contracts/mdbase.record.deleted-1.0.0.schema.json"),
        ),
        (
            "mdbase.record.renamed",
            include_str!("../contracts/mdbase.record.renamed-1.0.0.schema.json"),
        ),
        (
            TIMER_EVENT_ID,
            include_str!("../contracts/mdbase.runtime.timer.fired-1.0.0.schema.json"),
        ),
    ];
    let mut artifacts = schemas
        .into_iter()
        .map(|(id, schema)| {
            let schema = serde_json::from_str::<Value>(schema).map_err(|error| {
                RuntimeError::diagnostic(
                    "invalid_embedded_contract",
                    format!("Embedded schema for {id} is invalid: {error}"),
                )
            })?;
            Ok(json!({
                "kind": "mdbase.contract",
                "contract_type": "event",
                "id": id,
                "version": CONTRACT_VERSION,
                "data_schema": {
                    "dialect": "json-schema-2020-12",
                    "value": schema
                }
            }))
        })
        .collect::<mdbase_runtime::RuntimeResult<Vec<_>>>()?;
    artifacts.push(json!({
        "kind": "mdbase.contract",
        "contract_type": "action",
        "id": NOTIFICATION_ACTION_ID,
        "version": CONTRACT_VERSION,
        "name": "Emit an opaque notification signal",
        "input_schema": {
            "dialect": "json-schema-2020-12",
            "value": {
                "type": "object",
                "additionalProperties": false,
                "required": ["grant_id", "criterion_id", "cursor"],
                "properties": {
                    "grant_id": {"type": "string", "format": "uuid"},
                    "criterion_id": {"type": "string", "minLength": 1},
                    "cursor": {"type": "string", "minLength": 1}
                }
            }
        },
        "output_schema": {
            "dialect": "json-schema-2020-12",
            "value": {
                "type": "object",
                "additionalProperties": false,
                "required": ["accepted"],
                "properties": {"accepted": {"type": "boolean"}}
            }
        },
        "behavior": {
            "idempotency": "required",
            "cancellation": "none"
        }
    }));
    Ok(artifacts)
}

fn exact_contract(artifact: &Value) -> mdbase_runtime::RuntimeResult<ExactContractReference> {
    Ok(ExactContractReference {
        id: artifact
            .get("id")
            .and_then(Value::as_str)
            .expect("locally constructed contract has an ID")
            .to_string(),
        version: artifact
            .get("version")
            .and_then(Value::as_str)
            .expect("locally constructed contract has a version")
            .to_string(),
        digest: contract_digest(artifact).map_err(|message| {
            RuntimeError::diagnostic(
                "invalid_embedded_contract",
                format!("Could not digest an embedded contract: {message}"),
            )
        })?,
    })
}

fn validate_requirement(
    requirement: &ContractRequirement,
    contracts: &BTreeMap<String, ExactContractReference>,
) -> mdbase_runtime::RuntimeResult<()> {
    let Some(resolved) = contracts.get(&requirement.id) else {
        return Err(RuntimeError::diagnostic(
            "unsupported_notification_event",
            format!(
                "Notification event contract {} is not supplied by this authority.",
                requirement.id
            ),
        ));
    };
    let requested = VersionReq::parse(&requirement.version).map_err(|error| {
        RuntimeError::diagnostic(
            "invalid_contract_requirement",
            format!(
                "{} has invalid SemVer requirement {}: {error}",
                requirement.id, requirement.version
            ),
        )
    })?;
    let available = Version::parse(&resolved.version).expect("embedded version is valid SemVer");
    if requested.matches(&available) {
        Ok(())
    } else {
        Err(RuntimeError::diagnostic(
            "unsupported_contract_version",
            format!(
                "{} does not provide {} at {}.",
                requirement.id, requirement.version, resolved.version
            ),
        ))
    }
}

fn source_contract(resolved: ExactContractReference) -> Value {
    json!({
        "requirement": {"id": resolved.id, "version": resolved.version},
        "resolved": resolved,
        "ordering": ["source", "subject"]
    })
}

fn declaration(mut value: Value) -> mdbase_runtime::RuntimeResult<Value> {
    value["declaration_digest"] = Value::String(canonical_digest(&value)?);
    Ok(value)
}

fn notification_provider_identity() -> ImplementationIdentity {
    ImplementationIdentity {
        application: "mdbase.connect".to_string(),
        implementation: "notification-signal".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        instance_id: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mdbase_connect_protocol::{
        ApplicationAccess, GrantScope, NotificationPresentation, RuntimeExpression,
    };

    #[test]
    fn multiple_grants_consume_one_exact_event_contract() {
        let first = grant(
            "modified",
            "mdbase.record.modified",
            Some("event.data.after.status == \"done\""),
        );
        let second = grant("modified", "mdbase.record.modified", None);
        let catalog = catalog(&[first, second]);

        assert_eq!(catalog.admission().workflows().len(), 2);
        let exact = catalog.contract("mdbase.record.modified").unwrap();
        assert_eq!(exact.version, CONTRACT_VERSION);
        assert!(exact.digest.starts_with("sha256:"));
    }

    #[test]
    fn authority_changes_are_structured_cloud_events_with_cursor_extensions() {
        let grant = grant("modified", "mdbase.record.modified", None);
        let catalog = catalog(&[grant]);
        let event = AuthorityEvent {
            collection_id: Uuid::new_v4(),
            cursor: 42,
            event_type: "mdbase.record.modified".to_string(),
            occurred_at: "2026-07-25T00:00:00Z".to_string(),
            payload: json!({
                "path": "tasks/one.md",
                "before": {"status": "open"},
                "after": {"status": "done"},
                "changed_fields": ["status"],
                "previous_revision": "rev-1",
                "revision": "rev-2",
                "previous_types": ["task"],
                "types": ["task"]
            }),
        };

        let envelope = notification_event_envelope(&event, &catalog).unwrap();
        assert_eq!(envelope["specversion"], "1.0");
        assert_eq!(envelope["data"]["path"], "tasks/one.md");
        assert_eq!(envelope["mdbasecursor"], "42");
        assert!(envelope["data"].get("cursor").is_none());
    }

    #[test]
    fn timer_workflows_are_bound_to_their_grant_and_criterion() {
        let grant = grant(
            "task.reminder",
            TIMER_EVENT_ID,
            Some("event.data.data.data.kind == \"task\""),
        );
        let catalog = catalog(std::slice::from_ref(&grant));
        let workflow = &catalog.admission().workflows()[0];
        let condition = workflow
            .pointer("/triggers/0/if/$expr")
            .and_then(Value::as_str)
            .unwrap();

        assert!(condition.contains(&grant.id.to_string()));
        assert!(condition.contains("task.reminder"));
        assert!(condition.contains("event.data.data.data.kind"));
    }

    #[test]
    fn unknown_or_unavailable_event_requirements_fail_before_admission() {
        let unsupported = grant("custom", "example.custom", None);
        assert_eq!(
            catalog_result(&[unsupported]).unwrap_err().code(),
            "unsupported_notification_event"
        );
        let unavailable = grant("modified", "mdbase.record.modified", None);
        let mut unavailable = unavailable;
        unavailable.notification_criteria[0].event.version = "^2.0.0".to_string();
        assert_eq!(
            catalog_result(&[unavailable]).unwrap_err().code(),
            "unsupported_contract_version"
        );
    }

    fn catalog(grants: &[GrantSummary]) -> NotificationCatalog {
        catalog_result(grants).unwrap()
    }

    fn catalog_result(
        grants: &[GrantSummary],
    ) -> mdbase_runtime::RuntimeResult<NotificationCatalog> {
        compose_notification_catalog(
            grants,
            ImplementationIdentity {
                application: "mdbase.connect".to_string(),
                implementation: "test-authority".to_string(),
                version: "1.0.0".to_string(),
                instance_id: Some("test".to_string()),
            },
            "urn:mdbase:connect:test",
        )
    }

    fn grant(criterion_id: &str, event_id: &str, condition: Option<&str>) -> GrantSummary {
        GrantSummary {
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
                    id: event_id.to_string(),
                    version: "1.0.0".to_string(),
                },
                r#if: condition.map(|expression| RuntimeExpression {
                    expression: expression.to_string(),
                }),
                debounce: None,
                minimum_interval: None,
                presentation: NotificationPresentation {
                    title: "Task notification".to_string(),
                    body: None,
                    tag: None,
                },
            }],
            created_at: "2026-07-25T00:00:00Z".to_string(),
            encryption: None,
            file_capability: None,
        }
    }
}
