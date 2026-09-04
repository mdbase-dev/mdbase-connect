use crate::cloud::CloudControlClient;
use crate::watcher::CollectionRuntimeEvent;
use async_trait::async_trait;
use mdbase_connect_core::{CollectionRegistry, ConnectError};
use mdbase_connect_protocol::GrantSummary;
use mdbase_connect_runtime::{
    cancel_grant_timers, compose_notification_catalog, drain_notification_runtime,
    notification_event_envelope, perform_timer_operation, successful_notification_outcome,
    AuthorityEvent, NotificationCatalog, TimerOperationError, NOTIFICATION_EXECUTOR_ID,
    TIMER_EVENT_ID,
};
use mdbase_runtime::{
    inspect_sqlite_recovery, ActionDispatch, ActionInvocation, ActionOutcome, ActionProvider,
    AuthorizationDecision, DispatchAuthorizer, DispatchFailure, DispatchOutcome,
    ImplementationIdentity, ProviderRegistry, Runtime, RuntimeConfig, RuntimeStore,
    SqliteRuntimeStore,
};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
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
    let (cleanup_commands, mut cleanup_rx) =
        tokio::sync::mpsc::unbounded_channel::<CleanupCommand>();
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
                    let catalog = compose_catalog(
                        std::slice::from_ref(&command.grant),
                        command.collection_id,
                    );
                    let result = match catalog {
                        Ok(catalog) => match service.runtime(command.collection_id) {
                            Ok(runtime) => perform_timer_operation(
                                runtime,
                                &catalog,
                                &command.grant,
                                &command.operation,
                                command.input,
                            ).await,
                            Err(error) => Err(TimerOperationError {
                                code: error.code().to_string(),
                                message: error.to_string(),
                                internal: true,
                            }),
                        },
                        Err(error) => Err(TimerOperationError {
                            code: error.code().to_string(),
                            message: error.to_string(),
                            internal: true,
                        }),
                    };
                    let _ = command.response.send(result);
                }
                cleanup = cleanup_rx.recv() => {
                    let Some(cleanup) = cleanup else { return; };
                    let result = service.cleanup_orphaned_timers().await.map_err(|error| {
                        TimerOperationError {
                            code: error.code().to_string(),
                            message: error.to_string(),
                            internal: true,
                        }
                    });
                    let _ = cleanup.response.send(result);
                }
                _ = recovery.tick() => {
                    service.recover().await;
                }
            }
        }
    });
    (
        RuntimeTimerHandle {
            commands,
            cleanup_commands,
        },
        task,
    )
}

struct TimerCommand {
    collection_id: Uuid,
    grant: GrantSummary,
    operation: String,
    input: Value,
    response: std::sync::mpsc::Sender<Result<Value, TimerOperationError>>,
}

struct CleanupCommand {
    response: std::sync::mpsc::Sender<Result<usize, TimerOperationError>>,
}

#[derive(Clone)]
pub struct RuntimeTimerHandle {
    commands: tokio::sync::mpsc::UnboundedSender<TimerCommand>,
    cleanup_commands: tokio::sync::mpsc::UnboundedSender<CleanupCommand>,
}

impl RuntimeTimerHandle {
    pub fn cleanup_orphaned_timers(&self) -> Result<usize, TimerOperationError> {
        let (response, receiver) = std::sync::mpsc::channel();
        self.cleanup_commands
            .send(CleanupCommand { response })
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
        let catalog = compose_catalog(&grants, change.collection_id)?;
        let envelope = event_envelope(&change, &catalog)?;
        let runtime = self.runtime(change.collection_id)?;
        let outcome = runtime.deliver_event(catalog.admission(), envelope).await?;
        tracing::debug!(
            collection_id = %change.collection_id,
            cursor = outcome.cursor,
            duplicate = outcome.duplicate,
            admitted = outcome.admitted_run_ids.len(),
            "notification event admitted"
        );
        drain_runtime(runtime).await
    }

    async fn cleanup_orphaned_timers(&mut self) -> mdbase_runtime::RuntimeResult<usize> {
        let active = active_grant_ids_by_collection(&self.local_registry)?;
        let mut cancelled = 0;
        for collection_id in self.timer_runtime_ids() {
            cancelled += self
                .cleanup_collection_timers(collection_id, active.get(&collection_id))
                .await?;
        }
        Ok(cancelled)
    }

    fn timer_runtime_ids(&self) -> HashSet<Uuid> {
        let mut candidates = runtime_file_ids(&self.runtime_dir);
        candidates.extend(self.runtimes.keys().copied());
        candidates
    }

    async fn cleanup_collection_timers(
        &self,
        collection_id: Uuid,
        active_grants: Option<&HashSet<Uuid>>,
    ) -> mdbase_runtime::RuntimeResult<usize> {
        let ephemeral;
        let runtime = if let Some(runtime) = self.runtimes.get(&collection_id) {
            runtime
        } else {
            ephemeral = self.build_runtime(collection_id, None)?;
            &ephemeral
        };
        let owners = runtime
            .timers("connect:")
            .await?
            .into_iter()
            .filter_map(|timer| timer_grant_id(&timer.id))
            .filter(|grant_id| active_grants.is_none_or(|ids| !ids.contains(grant_id)))
            .collect::<HashSet<_>>();
        let mut cancelled = 0;
        for grant_id in owners {
            cancelled += cancel_grant_timers(runtime, grant_id).await?;
        }
        Ok(cancelled)
    }

    async fn recover(&mut self) {
        let active = match active_grant_ids_by_collection(&self.local_registry) {
            Ok(active) => active,
            Err(error) => {
                tracing::warn!(code = error.code(), %error, "notification grant cleanup lookup failed");
                return;
            }
        };
        let mut cleanup_failed = HashSet::new();
        for collection_id in self.timer_runtime_ids() {
            if let Err(error) = self
                .cleanup_collection_timers(collection_id, active.get(&collection_id))
                .await
            {
                tracing::warn!(%collection_id, code = error.code(), %error, "orphaned notification timer cleanup deferred");
                cleanup_failed.insert(collection_id);
            }
        }
        let grants = match notification_grants_by_collection(&self.local_registry) {
            Ok(grants) => grants,
            Err(error) => {
                tracing::warn!(%error, "notification grant recovery lookup failed");
                return;
            }
        };
        let candidates = recoverable_runtime_ids(&self.runtime_dir);
        let mut keep_resident = HashSet::new();
        for collection_id in candidates {
            if cleanup_failed.contains(&collection_id) {
                keep_resident.insert(collection_id);
                continue;
            }
            let catalog = match compose_catalog(
                grants.get(&collection_id).map(Vec::as_slice).unwrap_or(&[]),
                collection_id,
            ) {
                Ok(catalog) => catalog,
                Err(error) => {
                    tracing::warn!(%collection_id, code = error.code(), %error, "notification runtime registry is invalid");
                    keep_resident.insert(collection_id);
                    continue;
                }
            };
            let runtime = match self.runtime(collection_id) {
                Ok(runtime) => runtime,
                Err(error) => {
                    tracing::warn!(%collection_id, code = error.code(), %error, "notification runtime store is unavailable");
                    continue;
                }
            };
            if let Err(error) = fire_due_timers(runtime, &catalog).await {
                tracing::warn!(%collection_id, code = error.code(), %error, "notification timer recovery deferred");
                keep_resident.insert(collection_id);
                continue;
            }
            if let Err(error) = drain_runtime(runtime).await {
                tracing::warn!(%collection_id, code = error.code(), %error, "notification runtime recovery deferred");
                keep_resident.insert(collection_id);
                continue;
            }
            match inspect_sqlite_recovery(
                runtime_path(&self.runtime_dir, collection_id),
                chrono::Utc::now(),
            ) {
                Ok(state) if state.has_work() => {
                    keep_resident.insert(collection_id);
                }
                Ok(_) => {}
                Err(error) => {
                    tracing::warn!(%collection_id, %error, "notification runtime recovery state is unavailable");
                    keep_resident.insert(collection_id);
                }
            }
        }
        self.runtimes
            .retain(|collection_id, _| keep_resident.contains(collection_id));
    }

    fn runtime(&mut self, collection_id: Uuid) -> mdbase_runtime::RuntimeResult<&Runtime> {
        if !self.runtimes.contains_key(&collection_id) {
            let timezone = collection_timezone(&self.local_registry, collection_id)?;
            let runtime = self.build_runtime(collection_id, timezone)?;
            self.runtimes.insert(collection_id, runtime);
        }
        self.runtimes.get(&collection_id).ok_or_else(|| {
            mdbase_runtime::RuntimeError::Store("notification runtime was not initialized".into())
        })
    }

    fn build_runtime(
        &self,
        collection_id: Uuid,
        timezone: Option<String>,
    ) -> mdbase_runtime::RuntimeResult<Runtime> {
        let store: Arc<dyn RuntimeStore> = Arc::new(SqliteRuntimeStore::open(runtime_path(
            &self.runtime_dir,
            collection_id,
        ))?);
        let providers = ProviderRegistry::default();
        let catalog = compose_catalog(&[], collection_id)?;
        providers.register(
            catalog.notification_provider_binding().clone(),
            Arc::new(NotificationProvider {
                cloud: self.cloud.clone(),
            }),
        );
        Runtime::new(
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
                actor_id: "mdbase-connect-daemon".to_string(),
                actor_kind: "service".to_string(),
                identity: runtime_identity(collection_id),
                timezone,
                lease_duration: Duration::from_secs(30),
                max_items: 50,
            },
        )
    }
}

fn collection_timezone(
    registry: &CollectionRegistry,
    collection_id: Uuid,
) -> mdbase_runtime::RuntimeResult<Option<String>> {
    let collection = match registry.get(collection_id) {
        Ok(collection) => collection,
        Err(ConnectError::CollectionNotFound(_)) => return Ok(None),
        Err(error) => return Err(mdbase_runtime::RuntimeError::Store(error.to_string())),
    };
    let document = std::fs::read_to_string(Path::new(&collection.path).join("mdbase.yaml"))
        .map_err(|error| mdbase_runtime::RuntimeError::Store(error.to_string()))?;
    let configuration: serde_yaml::Value = serde_yaml::from_str(&document)
        .map_err(|error| mdbase_runtime::RuntimeError::Store(error.to_string()))?;
    Ok(configuration
        .get("settings")
        .and_then(|settings| settings.get("timezone"))
        .and_then(serde_yaml::Value::as_str)
        .map(str::to_string))
}

async fn fire_due_timers(
    runtime: &Runtime,
    catalog: &NotificationCatalog,
) -> mdbase_runtime::RuntimeResult<()> {
    for _ in 0..100 {
        if matches!(
            runtime.fire_due_timer(catalog.admission()).await?,
            mdbase_runtime::TimerFireOutcome::Idle
        ) {
            break;
        }
    }
    Ok(())
}

async fn drain_runtime(runtime: &Runtime) -> mdbase_runtime::RuntimeResult<()> {
    drain_notification_runtime(runtime, 100).await?;
    Ok(())
}

#[derive(Clone)]
struct NotificationProvider {
    cloud: Option<CloudControlClient>,
}

#[async_trait]
impl ActionProvider for NotificationProvider {
    async fn dispatch(
        &self,
        invocation: ActionInvocation,
    ) -> Result<ActionOutcome, DispatchFailure> {
        let grant_id = input_uuid(&invocation.input, "grant_id")?;
        let criterion_id = input_string(&invocation.input, "criterion_id")?;
        let cursor = input_string(&invocation.input, "cursor")?;
        let Some(cloud) = &self.cloud else {
            return Err(DispatchFailure {
                code: "notification_cloud_unavailable".to_string(),
                message: "This connector is not connected to a notification service.".to_string(),
                outcome: DispatchOutcome::NotApplied,
            });
        };
        let receipt = cloud
            .emit_notification_signal(&invocation.invocation_id, grant_id, criterion_id, cursor)
            .await
            .map_err(|error| DispatchFailure {
                code: "notification_signal_failed".to_string(),
                message: error.to_string(),
                // The server endpoint is idempotent by invocation ID. A lost
                // response is always safe to replay with the same ID.
                outcome: DispatchOutcome::Unknown,
            })?;
        tracing::debug!(receipt = %receipt, "notification signal accepted");
        Ok(successful_notification_outcome(&invocation))
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
        let collection = match self.registry.get(grant.collection_id) {
            Ok(collection) if collection.enabled => collection,
            _ => {
                return denied(
                    "notification_collection_unavailable",
                    "The notification collection is no longer available.",
                )
            }
        };
        if self
            .registry
            .ensure_authority_available(collection.id)
            .is_err()
        {
            return denied(
                "notification_authority_unavailable",
                "This computer no longer owns the collection authority.",
            );
        }
        let source = request.event.get("source").and_then(Value::as_str);
        let expected_source = source_uri(grant.collection_id);
        if source != Some(expected_source.as_str()) {
            return denied(
                "notification_collection_mismatch",
                "The event does not belong to the grant's collection.",
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
        let criterion = grant
            .notification_criteria
            .iter()
            .find(|criterion| criterion.id == criterion_id);
        let event_version = request
            .event
            .get("mdbasecontractversion")
            .and_then(Value::as_str);
        if criterion.is_none_or(|criterion| {
            Some(criterion.event.id.as_str()) != event_type
                || Some(criterion.event.version.as_str()) != event_version
        }) {
            return denied(
                "notification_criterion_revoked",
                "The local grant no longer authorizes this notification criterion.",
            );
        }
        AuthorizationDecision::Allow
    }
}

fn timer_grant_id(timer_id: &str) -> Option<Uuid> {
    let remainder = timer_id.strip_prefix("connect:")?;
    let (grant_id, owned_suffix) = remainder.split_once(':')?;
    if owned_suffix.is_empty() {
        return None;
    }
    Uuid::parse_str(grant_id).ok()
}

fn runtime_path(runtime_dir: &Path, collection_id: Uuid) -> PathBuf {
    runtime_dir.join(format!("{collection_id}.sqlite"))
}

fn runtime_file_ids(runtime_dir: &Path) -> HashSet<Uuid> {
    let Ok(entries) = std::fs::read_dir(runtime_dir) else {
        return HashSet::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            (path.extension().and_then(|value| value.to_str()) == Some("sqlite"))
                .then(|| {
                    path.file_stem()
                        .and_then(|value| value.to_str())
                        .and_then(|value| Uuid::parse_str(value).ok())
                })
                .flatten()
        })
        .collect()
}

fn recoverable_runtime_ids(runtime_dir: &Path) -> HashSet<Uuid> {
    let mut recoverable = HashSet::new();
    let now = chrono::Utc::now();
    for collection_id in runtime_file_ids(runtime_dir) {
        let path = runtime_path(runtime_dir, collection_id);
        match inspect_sqlite_recovery(&path, now) {
            Ok(state) if state.has_work() => {
                recoverable.insert(collection_id);
            }
            Ok(_) => {}
            Err(error) => {
                tracing::warn!(%collection_id, %error, "notification runtime store could not be inspected");
            }
        }
    }
    recoverable
}

fn active_grant_ids_by_collection(
    registry: &CollectionRegistry,
) -> Result<HashMap<Uuid, HashSet<Uuid>>, mdbase_runtime::RuntimeError> {
    registry
        .list_grants()
        .map(|grants| {
            let mut grouped = HashMap::<Uuid, HashSet<Uuid>>::new();
            for grant in grants {
                grouped
                    .entry(grant.collection_id)
                    .or_default()
                    .insert(grant.id);
            }
            grouped
        })
        .map_err(|error| mdbase_runtime::RuntimeError::Store(error.to_string()))
}

fn notification_grants_by_collection(
    registry: &CollectionRegistry,
) -> Result<HashMap<Uuid, Vec<GrantSummary>>, mdbase_runtime::RuntimeError> {
    registry
        .list_grants()
        .map(|grants| {
            let mut grouped = HashMap::<Uuid, Vec<GrantSummary>>::new();
            for grant in grants
                .into_iter()
                .filter(|grant| !grant.notification_criteria.is_empty())
            {
                grouped.entry(grant.collection_id).or_default().push(grant);
            }
            grouped
        })
        .map_err(|error| mdbase_runtime::RuntimeError::Store(error.to_string()))
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

fn compose_catalog(
    grants: &[GrantSummary],
    collection_id: Uuid,
) -> mdbase_runtime::RuntimeResult<NotificationCatalog> {
    compose_notification_catalog(
        grants,
        authority_identity(collection_id),
        source_uri(collection_id),
    )
}

fn event_envelope(
    change: &CollectionRuntimeEvent,
    catalog: &NotificationCatalog,
) -> mdbase_runtime::RuntimeResult<Value> {
    notification_event_envelope(
        &AuthorityEvent {
            collection_id: change.collection_id,
            cursor: change.cursor,
            event_type: change.event.event_type.clone(),
            occurred_at: change.event.occurred_at.clone(),
            payload: change.event.payload.clone(),
        },
        catalog,
    )
}

fn authority_identity(collection_id: Uuid) -> ImplementationIdentity {
    ImplementationIdentity {
        application: "mdbase.connect".to_string(),
        implementation: "local-authority".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        instance_id: Some(collection_id.to_string()),
    }
}

fn runtime_identity(collection_id: Uuid) -> ImplementationIdentity {
    ImplementationIdentity {
        application: "mdbase.connect".to_string(),
        implementation: "local-notification-runtime".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        instance_id: Some(collection_id.to_string()),
    }
}

fn source_uri(collection_id: Uuid) -> String {
    format!("urn:mdbase:connect:local:{collection_id}")
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
mod tests;
