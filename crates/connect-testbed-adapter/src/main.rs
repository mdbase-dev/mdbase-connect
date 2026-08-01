use std::io::{self, Read};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use mdbase_connect_protocol::{
    ApplicationAccess, ContractRequirement, GrantScope, GrantSummary, NotificationCriterion,
    NotificationPresentation,
};
use mdbase_connect_runtime::{
    compose_notification_catalog, notification_event_envelope, successful_notification_outcome,
    AuthorityEvent, NOTIFICATION_ACTION_ID, NOTIFICATION_EXECUTOR_ID,
};
use mdbase_runtime::{
    ActionDispatch, ActionInvocation, ActionOutcome, ActionProvider, AuthorizationDecision,
    DispatchAuthorizer, DispatchFailure, ImplementationIdentity, InMemoryRuntimeStore,
    ProviderRegistry, RunStatus, Runtime, RuntimeConfig, RuntimeStore, SystemClock, WorkerOutcome,
};
use serde_json::{json, Value};
use uuid::Uuid;

const SCENARIO: &str = "runtime.application-execution";

fn implementation() -> Value {
    json!({
        "id": "mdbase-connect",
        "name": "mdbase Connect notification runtime",
        "version": env!("CARGO_PKG_VERSION"),
        "language": "Rust",
        "target": "native",
        "x-runtime-version": mdbase_runtime::VERSION
    })
}

#[tokio::main]
async fn main() {
    if let Err(error) = execute().await {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

async fn execute() -> Result<(), String> {
    match std::env::args().nth(1).as_deref() {
        Some("describe") => write(&json!({
            "kind": "mdbase.testbed.adapter",
            "protocol_version": "0.1",
            "implementation": implementation(),
            "profiles": ["runtime/0.2", "event_action_interop/0.1"],
            "roles": ["event_source", "action_provider", "runtime", "runtime_store"],
            "scenarios": [SCENARIO]
        })),
        Some("run") => {
            let request = read_request()?;
            if request["kind"] != "mdbase.testbed.run"
                || request["protocol_version"] != "0.1"
                || request.pointer("/scenario/id").and_then(Value::as_str) != Some(SCENARIO)
            {
                return Err("Unsupported or invalid mdbase testbed run request.".to_string());
            }
            let entries = application_execution().await?;
            write(&json!({
                "kind": "mdbase.testbed.transcript",
                "protocol_version": "0.1",
                "scenario_id": SCENARIO,
                "implementation": implementation(),
                "entries": entries
            }))
        }
        _ => Err("Usage: mdbase-connect-testbed-adapter describe|run".to_string()),
    }
}

async fn application_execution() -> Result<Vec<Value>, String> {
    let collection_id =
        Uuid::parse_str("ad734b6d-0871-478c-8bd4-5ef41f872f5f").expect("fixed UUID");
    let grant = test_grant(collection_id);
    let source = ImplementationIdentity {
        application: "mdbase.connect".to_string(),
        implementation: "testbed-authority".to_string(),
        version: "1.0.0".to_string(),
        instance_id: Some(collection_id.to_string()),
    };
    let catalog = compose_notification_catalog(
        std::slice::from_ref(&grant),
        source,
        format!("urn:mdbase:connect:testbed:{collection_id}"),
    )
    .map_err(|error| error.to_string())?;

    let provider = Arc::new(CountingProvider::default());
    let providers = ProviderRegistry::default();
    providers.register(
        catalog.notification_provider_binding().clone(),
        provider.clone(),
    );
    let authorizer = Arc::new(CountingAuthorizer::default());
    let store = Arc::new(InMemoryRuntimeStore::new());
    let runtime = Runtime::new(
        store.clone(),
        providers,
        authorizer.clone(),
        Arc::new(SystemClock),
        RuntimeConfig {
            runtime_id: "mdbase-connect:testbed".to_string(),
            executor_id: NOTIFICATION_EXECUTOR_ID.to_string(),
            worker_id: "connect-testbed-worker".to_string(),
            actor_id: "connect-testbed".to_string(),
            actor_kind: "service".to_string(),
            identity: ImplementationIdentity {
                application: "mdbase.connect".to_string(),
                implementation: "testbed-notification-runtime".to_string(),
                version: env!("CARGO_PKG_VERSION").to_string(),
                instance_id: Some(collection_id.to_string()),
            },
            ..RuntimeConfig::default()
        },
    )
    .map_err(|error| error.to_string())?;

    let envelope = notification_event_envelope(
        &AuthorityEvent {
            collection_id,
            cursor: 42,
            event_type: "mdbase.record.modified".to_string(),
            occurred_at: "2026-07-29T00:00:00Z".to_string(),
            payload: json!({
                "path": "notes/shared.md",
                "before": {"status": "open"},
                "after": {"status": "done"},
                "changed_fields": ["status"],
                "previous_revision": "rev-1",
                "revision": "rev-2",
                "previous_types": ["note"],
                "types": ["note"]
            }),
        },
        &catalog,
    )
    .map_err(|error| error.to_string())?;
    let event_contract = catalog
        .contract("mdbase.record.modified")
        .ok_or_else(|| "Connect catalog omitted the modified-record contract.".to_string())?;
    let exact_event = envelope["mdbasecontractversion"] == event_contract.version
        && envelope["mdbasecontractdigest"] == event_contract.digest;
    let delivery = runtime
        .deliver_event(catalog.admission(), envelope)
        .await
        .map_err(|error| error.to_string())?;
    let outcome = runtime
        .work_once()
        .await
        .map_err(|error| error.to_string())?;
    let snapshot = store.snapshot().await.map_err(|error| error.to_string())?;
    let run = snapshot
        .runs
        .first()
        .ok_or_else(|| "Connect runtime did not persist an admitted run.".to_string())?;
    let action_contract = catalog
        .contract(NOTIFICATION_ACTION_ID)
        .ok_or_else(|| "Connect catalog omitted the notification action contract.".to_string())?;
    let step = run
        .plan
        .steps
        .first()
        .ok_or_else(|| "Connect runtime plan omitted its notification step.".to_string())?;
    let exact_bindings = run.plan.event_contract == *event_contract
        && step.action == action_contract.id
        && step.action_version == action_contract.version
        && step.action_digest == action_contract.digest
        && step.provider_declaration_digest
            == catalog
                .notification_provider_binding()
                .provider_declaration_digest
        && step.handler_id == catalog.notification_provider_binding().handler_id;
    let status = match run.status {
        RunStatus::Succeeded => "succeeded",
        _ => "unexpected",
    };
    if !matches!(
        outcome,
        WorkerOutcome::Completed {
            status: RunStatus::Succeeded,
            ..
        }
    ) {
        return Err(format!(
            "Connect runtime returned unexpected worker outcome {outcome:?}."
        ));
    }

    Ok(vec![
        entry(
            1,
            "arrange",
            "application-runtime",
            "catalog.compose",
            "succeeded",
            json!({
                "contracts_verified": event_contract.digest.starts_with("sha256:")
                    && action_contract.digest.starts_with("sha256:"),
                "executor_selected": run.plan.executor == NOTIFICATION_EXECUTOR_ID
            }),
        ),
        entry(
            2,
            "act",
            "event-source",
            "event.publish",
            "succeeded",
            json!({"exact_contract": exact_event}),
        ),
        entry(
            3,
            "act",
            "application-runtime",
            "event.admit",
            "succeeded",
            json!({"runs": delivery.admitted_run_ids.len()}),
        ),
        entry(
            4,
            "act",
            "action-provider",
            "action.dispatch",
            "succeeded",
            json!({
                "authorization_checked": authorizer.calls.load(Ordering::SeqCst) > 0,
                "provider_calls": provider.calls.load(Ordering::SeqCst)
            }),
        ),
        entry(
            5,
            "observe",
            "runtime-store",
            "run.inspect",
            "succeeded",
            json!({"exact_bindings": exact_bindings, "status": status}),
        ),
    ])
}

#[derive(Default)]
struct CountingProvider {
    calls: AtomicUsize,
}

#[async_trait]
impl ActionProvider for CountingProvider {
    async fn dispatch(
        &self,
        invocation: ActionInvocation,
    ) -> Result<ActionOutcome, DispatchFailure> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(successful_notification_outcome(&invocation))
    }
}

#[derive(Default)]
struct CountingAuthorizer {
    calls: AtomicUsize,
}

#[async_trait]
impl DispatchAuthorizer for CountingAuthorizer {
    async fn authorize(&self, _request: &ActionDispatch) -> AuthorizationDecision {
        self.calls.fetch_add(1, Ordering::SeqCst);
        AuthorizationDecision::Allow
    }
}

fn test_grant(collection_id: Uuid) -> GrantSummary {
    GrantSummary {
        id: Uuid::parse_str("0d57894d-9a5a-477a-95ac-a8b4d77839d9").expect("fixed UUID"),
        application_id: Uuid::parse_str("f9af383c-81ec-43bf-9cf5-65e02e595014")
            .expect("fixed UUID"),
        application_name: "Testbed notes".to_string(),
        application_distribution: "web".to_string(),
        application_homepage: "https://testbed.example".to_string(),
        application_project_url: None,
        application_origin: "https://testbed.example".to_string(),
        application_icon: None,
        collection_id,
        collection_name: "Testbed collection".to_string(),
        operations: vec!["changes".to_string()],
        scope: GrantScope {
            contracts: Vec::new(),
            access: ApplicationAccess::FullCollection,
        },
        notification_criteria: vec![NotificationCriterion {
            id: "note.modified".to_string(),
            event: ContractRequirement {
                id: "mdbase.record.modified".to_string(),
                version: "1.0.0".to_string(),
            },
            r#if: None,
            debounce: None,
            minimum_interval: None,
            presentation: NotificationPresentation {
                title: "A note changed".to_string(),
                body: None,
                tag: None,
            },
        }],
        created_at: "2026-07-29T00:00:00Z".to_string(),
        encryption: None,
        file_capability: None,
    }
}

fn entry(
    sequence: u64,
    phase: &str,
    actor: &str,
    operation: &str,
    outcome: &str,
    facts: Value,
) -> Value {
    json!({
        "sequence": sequence,
        "phase": phase,
        "actor": actor,
        "operation": operation,
        "outcome": outcome,
        "facts": facts
    })
}

fn read_request() -> Result<Value, String> {
    let mut source = String::new();
    io::stdin()
        .read_to_string(&mut source)
        .map_err(|error| error.to_string())?;
    serde_json::from_str(&source).map_err(|error| error.to_string())
}

fn write(value: &Value) -> Result<(), String> {
    println!(
        "{}",
        serde_json::to_string(value).map_err(|error| error.to_string())?
    );
    Ok(())
}
