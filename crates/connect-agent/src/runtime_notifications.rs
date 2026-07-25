use crate::cloud::CloudControlClient;
use crate::watcher::CollectionRuntimeEvent;
use async_trait::async_trait;
use mdbase::runtime_contracts::RuntimeRegistry;
use mdbase_connect_core::CollectionRegistry;
use mdbase_connect_protocol::GrantSummary;
use mdbase_connect_runtime::{
    compose_notification_registry, drain_notification_runtime, notification_event_envelope,
    perform_timer_operation, AuthorityEvent, TimerOperationError, NOTIFICATION_ACTION_ID,
    NOTIFICATION_EXECUTOR_ID,
};
use mdbase_runtime::{
    ActionDispatch, ActionProvider, ActionResponse, AuthorizationDecision, DispatchAuthorizer,
    DispatchFailure, DispatchOutcome, ProviderRegistry, Runtime, RuntimeConfig, RuntimeStore,
    SqliteRuntimeStore,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use uuid::Uuid;

pub fn start(
    state_dir: &Path,
    local_registry: CollectionRegistry,
    cloud: Option<CloudControlClient>,
    mut events: tokio::sync::mpsc::UnboundedReceiver<CollectionRuntimeEvent>,
) -> (RuntimeTimerHandle, tokio::task::JoinHandle<()>) {
    let runtime_dir = state_dir.join("runtime");
    let (commands, mut command_rx) = tokio::sync::mpsc::unbounded_channel::<TimerCommand>();
    let task = tokio::spawn(async move {
        if let Err(error) = std::fs::create_dir_all(&runtime_dir) {
            tracing::error!(%error, path = %runtime_dir.display(), "failed to create runtime state directory");
            return;
        }
        let mut service = RuntimeNotificationService {
            runtime_dir,
            local_registry,
            cloud,
            runtimes: HashMap::new(),
        };
        let mut recovery = tokio::time::interval(Duration::from_secs(15));
        recovery.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                event = events.recv() => {
                    let Some(event) = event else { return; };
                    if let Err(error) = service.handle_event(event).await {
                        tracing::warn!(code = error.code(), %error, "notification runtime rejected a collection event");
                    }
                }
                command = command_rx.recv() => {
                    let Some(command) = command else { return; };
                    let runtime = service.runtime(command.collection_id);
                    let result = match runtime {
                        Ok(runtime) => perform_timer_operation(
                            runtime,
                            &command.grant,
                            &command.operation,
                            command.input,
                        ).await,
                        Err(error) => Err(TimerOperationError {
                            code: error.code().to_string(),
                            message: error.to_string(),
                            internal: true,
                        }),
                    };
                    let _ = command.response.send(result);
                }
                _ = recovery.tick() => {
                    service.recover().await;
                }
            }
        }
    });
    (RuntimeTimerHandle { commands }, task)
}

struct TimerCommand {
    collection_id: Uuid,
    grant: GrantSummary,
    operation: String,
    input: Value,
    response: std::sync::mpsc::Sender<Result<Value, TimerOperationError>>,
}

#[derive(Clone)]
pub struct RuntimeTimerHandle {
    commands: tokio::sync::mpsc::UnboundedSender<TimerCommand>,
}

impl RuntimeTimerHandle {
    pub fn operation(
        &self,
        collection_id: Uuid,
        grant: GrantSummary,
        operation: &str,
        input: Value,
    ) -> Result<Value, TimerOperationError> {
        let (response, receiver) = std::sync::mpsc::channel();
        self.commands
            .send(TimerCommand {
                collection_id,
                grant,
                operation: operation.to_string(),
                input,
                response,
            })
            .map_err(|_| TimerOperationError {
                code: "timer_authority_unavailable".to_string(),
                message: "The local timer authority is unavailable.".to_string(),
                internal: true,
            })?;
        receiver
            .recv_timeout(Duration::from_secs(30))
            .map_err(|_| TimerOperationError {
                code: "timer_authority_timeout".to_string(),
                message: "The local timer authority did not respond in time.".to_string(),
                internal: true,
            })?
    }
}

struct RuntimeNotificationService {
    runtime_dir: PathBuf,
    local_registry: CollectionRegistry,
    cloud: Option<CloudControlClient>,
    runtimes: HashMap<Uuid, Runtime>,
}

impl RuntimeNotificationService {
    async fn handle_event(
        &mut self,
        change: CollectionRuntimeEvent,
    ) -> mdbase_runtime::RuntimeResult<()> {
        let grants = notification_grants(&self.local_registry, change.collection_id)?;
        if grants.is_empty() {
            return Ok(());
        }
        let registry = compose_registry(&grants)?;
        let envelope = event_envelope(&change, &registry)?;
        let runtime = self.runtime(change.collection_id)?;
        let outcome = runtime.deliver_event(&registry, envelope).await?;
        tracing::debug!(
            collection_id = %change.collection_id,
            cursor = outcome.cursor,
            duplicate = outcome.duplicate,
            admitted = outcome.admitted_run_ids.len(),
            "notification event admitted"
        );
        drain_runtime(runtime, &registry).await
    }

    async fn recover(&mut self) {
        let collections = match self.local_registry.list() {
            Ok(collections) => collections,
            Err(error) => {
                tracing::warn!(%error, "notification runtime could not list collections for recovery");
                return;
            }
        };
        for collection in collections
            .into_iter()
            .filter(|collection| collection.enabled)
        {
            let grants = match notification_grants(&self.local_registry, collection.id) {
                Ok(grants) => grants,
                Err(error) => {
                    tracing::warn!(collection_id = %collection.id, %error, "notification grant lookup failed");
                    continue;
                }
            };
            let registry = match compose_registry(&grants) {
                Ok(registry) => registry,
                Err(error) => {
                    tracing::warn!(collection_id = %collection.id, code = error.code(), %error, "notification runtime registry is invalid");
                    continue;
                }
            };
            let runtime = match self.runtime(collection.id) {
                Ok(runtime) => runtime,
                Err(error) => {
                    tracing::warn!(collection_id = %collection.id, code = error.code(), %error, "notification runtime store is unavailable");
                    continue;
                }
            };
            if let Err(error) = fire_due_timers(runtime, &registry).await {
                tracing::warn!(collection_id = %collection.id, code = error.code(), %error, "notification timer recovery deferred");
                continue;
            }
            if let Err(error) = drain_runtime(runtime, &registry).await {
                tracing::warn!(collection_id = %collection.id, code = error.code(), %error, "notification runtime recovery deferred");
            }
        }
    }

    fn runtime(&mut self, collection_id: Uuid) -> mdbase_runtime::RuntimeResult<&Runtime> {
        if !self.runtimes.contains_key(&collection_id) {
            let store: Arc<dyn RuntimeStore> = Arc::new(SqliteRuntimeStore::open(
                self.runtime_dir.join(format!("{collection_id}.sqlite")),
            )?);
            let providers = ProviderRegistry::default();
            providers.register(
                NOTIFICATION_ACTION_ID,
                Arc::new(NotificationProvider {
                    cloud: self.cloud.clone(),
                }),
            );
            let runtime = Runtime::new(
                store,
                providers,
                Arc::new(LocalNotificationAuthorizer {
                    registry: self.local_registry.clone(),
                }),
                Arc::new(mdbase_runtime::SystemClock),
                RuntimeConfig {
                    runtime_id: format!("mdbase-connect:{collection_id}"),
                    executor_id: NOTIFICATION_EXECUTOR_ID.to_string(),
                    worker_id: format!("connect-agent:{collection_id}"),
                    actor_id: "mdbase-connect-agent".to_string(),
                    actor_kind: "service".to_string(),
                    timezone: None,
                    lease_duration: Duration::from_secs(30),
                    max_items: 50,
                },
            )?;
            self.runtimes.insert(collection_id, runtime);
        }
        self.runtimes.get(&collection_id).ok_or_else(|| {
            mdbase_runtime::RuntimeError::Store("notification runtime was not initialized".into())
        })
    }
}

async fn fire_due_timers(
    runtime: &Runtime,
    registry: &RuntimeRegistry,
) -> mdbase_runtime::RuntimeResult<()> {
    for _ in 0..100 {
        if matches!(
            runtime.fire_due_timer(registry).await?,
            mdbase_runtime::TimerFireOutcome::Idle
        ) {
            break;
        }
    }
    Ok(())
}

async fn drain_runtime(
    runtime: &Runtime,
    registry: &RuntimeRegistry,
) -> mdbase_runtime::RuntimeResult<()> {
    drain_notification_runtime(runtime, registry, 100).await?;
    Ok(())
}

#[derive(Clone)]
struct NotificationProvider {
    cloud: Option<CloudControlClient>,
}

#[async_trait]
impl ActionProvider for NotificationProvider {
    async fn dispatch(&self, request: ActionDispatch) -> Result<ActionResponse, DispatchFailure> {
        let grant_id = input_uuid(&request.input, "grant_id")?;
        let criterion_id = input_string(&request.input, "criterion_id")?;
        let cursor = input_string(&request.input, "cursor")?;
        let Some(cloud) = &self.cloud else {
            return Err(DispatchFailure {
                code: "notification_cloud_unavailable".to_string(),
                message: "This connector is not connected to a notification service.".to_string(),
                outcome: DispatchOutcome::NotApplied,
            });
        };
        let receipt = cloud
            .emit_notification_signal(&request.invocation_id, grant_id, criterion_id, cursor)
            .await
            .map_err(|error| DispatchFailure {
                code: "notification_signal_failed".to_string(),
                message: error.to_string(),
                // The server endpoint is idempotent by invocation ID. A lost
                // response is always safe to replay with the same ID.
                outcome: DispatchOutcome::Unknown,
            })?;
        Ok(ActionResponse {
            output: json!({"accepted": true}),
            receipt: Some(receipt),
            emitted_events: Vec::new(),
        })
    }
}

#[derive(Clone)]
struct LocalNotificationAuthorizer {
    registry: CollectionRegistry,
}

#[async_trait]
impl DispatchAuthorizer for LocalNotificationAuthorizer {
    async fn authorize(&self, request: &ActionDispatch) -> AuthorizationDecision {
        if self.registry.paused().unwrap_or(true) {
            return denied("access_paused", "Remote access is paused on this computer.");
        }
        let grant_id = match input_uuid(&request.input, "grant_id") {
            Ok(value) => value,
            Err(error) => return denied(&error.code, &error.message),
        };
        let criterion_id = match input_string(&request.input, "criterion_id") {
            Ok(value) => value,
            Err(error) => return denied(&error.code, &error.message),
        };
        let grant = match self.registry.grant_context(grant_id) {
            Ok(Some(grant)) => grant,
            _ => {
                return denied(
                    "notification_grant_revoked",
                    "The local grant is no longer active.",
                )
            }
        };
        let source = request
            .event
            .pointer("/source/runtime")
            .and_then(Value::as_str);
        let expected_source = format!("mdbase-connect:{}", grant.collection_id);
        if source != Some(expected_source.as_str()) {
            return denied(
                "notification_collection_mismatch",
                "The event does not belong to the grant's collection.",
            );
        }
        let event_type = request.event.get("type").and_then(Value::as_str);
        if event_type == Some("timer.fired")
            && (request
                .event
                .pointer("/payload/data/grant_id")
                .and_then(Value::as_str)
                != Some(grant_id.to_string().as_str())
                || request
                    .event
                    .pointer("/payload/data/criterion_id")
                    .and_then(Value::as_str)
                    != Some(criterion_id))
        {
            return denied(
                "notification_timer_owner_mismatch",
                "The timer does not belong to this grant and criterion.",
            );
        }
        let criterion = grant
            .notification_criteria
            .iter()
            .find(|criterion| criterion.id == criterion_id);
        if criterion.is_none_or(|criterion| Some(criterion.event.id.as_str()) != event_type) {
            return denied(
                "notification_criterion_revoked",
                "The local grant no longer authorizes this notification criterion.",
            );
        }
        AuthorizationDecision::Allow
    }
}

fn notification_grants(
    registry: &CollectionRegistry,
    collection_id: Uuid,
) -> Result<Vec<GrantSummary>, mdbase_runtime::RuntimeError> {
    registry
        .list_grants()
        .map(|grants| {
            grants
                .into_iter()
                .filter(|grant| {
                    grant.collection_id == collection_id && !grant.notification_criteria.is_empty()
                })
                .collect()
        })
        .map_err(|error| mdbase_runtime::RuntimeError::Store(error.to_string()))
}

fn compose_registry(grants: &[GrantSummary]) -> mdbase_runtime::RuntimeResult<RuntimeRegistry> {
    compose_notification_registry(grants, "mdbase.watch", "mdbase Watch")
}

fn event_envelope(
    change: &CollectionRuntimeEvent,
    registry: &RuntimeRegistry,
) -> mdbase_runtime::RuntimeResult<Value> {
    notification_event_envelope(
        &AuthorityEvent {
            collection_id: change.collection_id,
            cursor: change.cursor,
            event_type: change.event.event_type.clone(),
            occurred_at: change.event.occurred_at.clone(),
            payload: change.event.payload.clone(),
            runtime_id: format!("mdbase-connect:{}", change.collection_id),
            provider_id: "mdbase.watch".to_string(),
        },
        registry,
    )
}

fn input_string<'a>(input: &'a Value, name: &str) -> Result<&'a str, DispatchFailure> {
    input
        .get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| DispatchFailure {
            code: "notification_input_invalid".to_string(),
            message: format!("Notification input field {name} must be a string."),
            outcome: DispatchOutcome::NotApplied,
        })
}

fn input_uuid(input: &Value, name: &str) -> Result<Uuid, DispatchFailure> {
    input_string(input, name)?
        .parse()
        .map_err(|_| DispatchFailure {
            code: "notification_input_invalid".to_string(),
            message: format!("Notification input field {name} must be a UUID."),
            outcome: DispatchOutcome::NotApplied,
        })
}

fn denied(code: &str, message: &str) -> AuthorizationDecision {
    AuthorizationDecision::Deny {
        code: code.to_string(),
        message: message.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{extract::State, routing::post, Json, Router};
    use mdbase_connect_protocol::{
        ApplicationAccess, ContractRequirement, GrantPolicy, GrantScope, NotificationCriterion,
        NotificationPresentation, RuntimeExpression,
    };
    use tempfile::tempdir;

    #[test]
    fn compiled_workflows_keep_record_data_out_of_action_input() {
        let grant = GrantSummary {
            id: Uuid::new_v4(),
            application_id: Uuid::new_v4(),
            application_name: "Tasks".to_string(),
            application_distribution: "web".to_string(),
            application_homepage: "https://tasks.example".to_string(),
            application_project_url: None,
            application_origin: "https://tasks.example".to_string(),
            application_icon: None,
            collection_id: Uuid::new_v4(),
            collection_name: "Private".to_string(),
            operations: vec!["changes".to_string()],
            scope: GrantScope {
                contracts: Vec::new(),
                access: ApplicationAccess::Contract,
            },
            notification_criteria: vec![NotificationCriterion {
                id: "task.ready".to_string(),
                event: ContractRequirement {
                    id: "mdbase.record.modified".to_string(),
                    version: 1,
                },
                r#if: Some(RuntimeExpression {
                    expression: "event.payload.changed_fields.size() > 0".to_string(),
                }),
                debounce: Some("1s".to_string()),
                minimum_interval: None,
                presentation: NotificationPresentation {
                    title: "A task changed".to_string(),
                    body: None,
                    tag: None,
                },
            }],
            created_at: "2026-07-24T00:00:00Z".to_string(),
            encryption: None,
        };
        let registry = compose_registry(&[grant]).unwrap();
        let workflow = &registry.workflows.values().next().unwrap().contract;
        let input = workflow.pointer("/steps/0/input").unwrap();
        let encoded = serde_json::to_string(input).unwrap();
        assert!(!encoded.contains("path"));
        assert!(!encoded.contains("frontmatter"));
        assert_eq!(workflow.pointer("/triggers/0/debounce"), Some(&json!("1s")));
    }

    #[tokio::test]
    async fn private_watcher_event_becomes_only_an_opaque_cloud_signal() {
        let state_dir = tempdir().unwrap();
        let registry = CollectionRegistry::open(state_dir.path()).unwrap();
        let collection = registry
            .create(state_dir.path().join("collection"), Some("Private notes"))
            .unwrap();
        let grant_id = Uuid::new_v4();
        registry
            .replace_grants(&[GrantPolicy {
                id: grant_id,
                application_id: Uuid::new_v4(),
                collection_id: collection.id,
                operations: vec!["changes".to_string()],
                scope: GrantScope::full_collection(),
                application_name: "Tasks".to_string(),
                application_distribution: "web".to_string(),
                application_homepage: "https://tasks.example".to_string(),
                application_project_url: None,
                application_origin: "https://tasks.example".to_string(),
                application_icon: None,
                collection_name: "Private notes".to_string(),
                notification_criteria: vec![
                    NotificationCriterion {
                        id: "task.ready".to_string(),
                        event: ContractRequirement {
                            id: "mdbase.record.modified".to_string(),
                            version: 1,
                        },
                        r#if: None,
                        debounce: None,
                        minimum_interval: None,
                        presentation: NotificationPresentation {
                            title: "A task changed".to_string(),
                            body: None,
                            tag: None,
                        },
                    },
                    NotificationCriterion {
                        id: "reminder.due".to_string(),
                        event: ContractRequirement {
                            id: "timer.fired".to_string(),
                            version: 1,
                        },
                        r#if: None,
                        debounce: None,
                        minimum_interval: None,
                        presentation: NotificationPresentation {
                            title: "A reminder is due".to_string(),
                            body: None,
                            tag: None,
                        },
                    },
                ],
                created_at: "2026-07-24T00:00:00Z".to_string(),
                encryption: None,
            }])
            .unwrap();

        let (signals, mut signal_rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
        async fn receive(
            State(signals): State<tokio::sync::mpsc::UnboundedSender<Value>>,
            Json(body): Json<Value>,
        ) -> Json<Value> {
            signals.send(body).unwrap();
            Json(json!({"accepted": true, "duplicate": false}))
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new()
                    .route("/v1/connectors/notification-signals", post(receive))
                    .with_state(signals),
            )
            .await
            .unwrap();
        });
        let mut service = RuntimeNotificationService {
            runtime_dir: state_dir.path().join("runtime"),
            local_registry: registry,
            cloud: Some(CloudControlClient::new(
                format!("http://{address}"),
                "connector-token".to_string(),
            )),
            runtimes: HashMap::new(),
        };
        std::fs::create_dir_all(&service.runtime_dir).unwrap();
        service
            .handle_event(CollectionRuntimeEvent {
                collection_id: collection.id,
                cursor: 9,
                event: mdbase::watch::WatchEvent {
                    event_type: "mdbase.record.modified".to_string(),
                    sequence: 4,
                    occurred_at: "2026-07-24T00:00:00Z".to_string(),
                    payload: json!({
                        "path": "private/medical-note.md",
                        "changed_fields": ["status"],
                        "after": {"status": "ready", "secret": "never-upload"}
                    }),
                },
            })
            .await
            .unwrap();
        let signal = tokio::time::timeout(Duration::from_secs(1), signal_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(signal["grant_id"], json!(grant_id));
        assert_eq!(signal["criterion_id"], json!("task.ready"));
        assert_eq!(signal["cursor"], json!("9"));
        assert!(signal["signal_id"]
            .as_str()
            .is_some_and(|value| value.starts_with("inv_")));
        let encoded = serde_json::to_string(&signal).unwrap();
        assert!(!encoded.contains("medical-note"));
        assert!(!encoded.contains("never-upload"));

        let timer_grant = service
            .local_registry
            .grant_context(grant_id)
            .unwrap()
            .unwrap();
        {
            let runtime = service.runtime(collection.id).unwrap();
            perform_timer_operation(
                runtime,
                &timer_grant,
                "put_timer",
                json!({
                    "namespace": "reminders",
                    "criterion_id": "reminder.due",
                    "timer": {
                        "id": "private-reminder",
                        "fire_at": (chrono::Utc::now() - chrono::TimeDelta::seconds(1)).to_rfc3339(),
                        "data": {"private": "timer-state-stays-local"}
                    }
                }),
            )
            .await
            .unwrap();
        }
        let grants = notification_grants(&service.local_registry, collection.id).unwrap();
        let timer_registry = compose_registry(&grants).unwrap();
        {
            let runtime = service.runtime(collection.id).unwrap();
            let fired = runtime.fire_due_timer(&timer_registry).await.unwrap();
            let mdbase_runtime::TimerFireOutcome::Fired { delivery, .. } = fired else {
                panic!("due timer did not fire");
            };
            assert_eq!(delivery.admitted_run_ids.len(), 1);
            let completed = runtime.work_once(&timer_registry).await.unwrap();
            assert!(
                matches!(
                    &completed,
                    mdbase_runtime::WorkerOutcome::Completed {
                        status: mdbase_runtime::RunStatus::Succeeded,
                        ..
                    }
                ),
                "{completed:?}"
            );
        }
        let timer_signal = tokio::time::timeout(Duration::from_secs(1), signal_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(timer_signal["grant_id"], json!(grant_id));
        assert_eq!(timer_signal["criterion_id"], json!("reminder.due"));
        let encoded = serde_json::to_string(&timer_signal).unwrap();
        assert!(!encoded.contains("private-reminder"));
        assert!(!encoded.contains("timer-state-stays-local"));
        server.abort();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn timer_handle_reconciles_through_the_running_local_authority() {
        let state_dir = tempdir().unwrap();
        let registry = CollectionRegistry::open(state_dir.path()).unwrap();
        let collection = registry
            .create(state_dir.path().join("collection"), Some("Tasks"))
            .unwrap();
        let grant_id = Uuid::new_v4();
        registry
            .replace_grants(&[GrantPolicy {
                id: grant_id,
                application_id: Uuid::new_v4(),
                collection_id: collection.id,
                operations: vec!["reconcile_timers".to_string()],
                scope: GrantScope::full_collection(),
                application_name: "Tasks".to_string(),
                application_distribution: "web".to_string(),
                application_homepage: "https://tasks.example".to_string(),
                application_project_url: None,
                application_origin: "https://tasks.example".to_string(),
                application_icon: None,
                collection_name: "Tasks".to_string(),
                notification_criteria: vec![NotificationCriterion {
                    id: "task.reminder".to_string(),
                    event: ContractRequirement {
                        id: "timer.fired".to_string(),
                        version: 1,
                    },
                    r#if: None,
                    debounce: None,
                    minimum_interval: None,
                    presentation: NotificationPresentation {
                        title: "Task reminder".to_string(),
                        body: None,
                        tag: None,
                    },
                }],
                created_at: "2026-07-25T00:00:00Z".to_string(),
                encryption: None,
            }])
            .unwrap();
        let grant = registry.grant_context(grant_id).unwrap().unwrap();
        let (events, event_rx) = tokio::sync::mpsc::unbounded_channel();
        let (timers, task) = start(state_dir.path(), registry, None, event_rx);
        let result = tokio::task::spawn_blocking(move || {
            timers.operation(
                collection.id,
                grant,
                "reconcile_timers",
                json!({
                    "namespace": "task-reminders",
                    "criterion_id": "task.reminder",
                    "timers": [{
                        "id": "task-a:reminder-a",
                        "fire_at": "2026-07-26T00:00:00Z"
                    }]
                }),
            )
        })
        .await
        .unwrap()
        .unwrap();
        assert_eq!(result["timers"][0]["id"], "task-a:reminder-a");
        drop(events);
        task.abort();
    }
}
