use mdbase_connect_core::{CollectionRegistry, ConnectError};
use mdbase_connect_protocol::CollectionSummary;
use std::collections::BTreeSet;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;
use uuid::Uuid;

const EXTERNAL_POLL: Duration = Duration::from_millis(50);

#[derive(Debug, Clone)]
pub struct CollectionRuntimeEvent {
    pub collection_id: Uuid,
    pub cursor: u64,
    pub event: mdbase::watch::WatchEvent,
}

/// Finalizes the durable mdbase change feed into Connect notifications.
///
/// This is deliberately not a collection watcher. Each `FilesystemRuntime`
/// owns its watcher; this service has one process-wide worker that polls those
/// runtimes and persists their already-normalized, ordered feed events.
#[derive(Clone)]
pub struct CollectionWatchService {
    commands: mpsc::Sender<Command>,
}

enum Command {
    Refresh(Vec<CollectionSummary>, mpsc::SyncSender<()>),
    Finalize(Uuid, mpsc::SyncSender<Result<(), ConnectError>>),
    Reconcile(Uuid, mpsc::SyncSender<()>),
}

impl CollectionWatchService {
    #[cfg(test)]
    pub fn start(registry: CollectionRegistry) -> Self {
        Self::start_with_runtime_events(registry, None)
    }

    pub fn start_with_runtime_events(
        registry: CollectionRegistry,
        runtime_events: Option<tokio::sync::mpsc::UnboundedSender<CollectionRuntimeEvent>>,
    ) -> Self {
        let (commands, receiver) = mpsc::channel();
        thread::Builder::new()
            .name("mdbase-connect-runtime-finalizer".to_string())
            .spawn(move || run_finalizer(registry, receiver, runtime_events))
            .expect("failed to start collection runtime finalizer");
        Self { commands }
    }

    pub fn refresh(&self, collections: &[CollectionSummary]) {
        let (ready, receiver) = mpsc::sync_channel(0);
        let active = collections
            .iter()
            .filter(|collection| collection.enabled)
            .cloned()
            .collect();
        if self.commands.send(Command::Refresh(active, ready)).is_err() {
            tracing::warn!("collection runtime finalizer is unavailable");
            return;
        }
        if receiver.recv().is_err() {
            tracing::warn!("collection runtime finalizer did not acknowledge readiness");
        }
    }

    /// Persist known mutation events already committed by the runtime.
    pub fn finalize(&self, collection_id: Uuid) -> Result<(), ConnectError> {
        self.request(collection_id, false)
    }

    /// Explicit lifecycle reconciliation for control/file paths outside normal
    /// canonical operation execution.
    pub fn rescan(&self, collection_id: Uuid) {
        if let Err(error) = self.request(collection_id, true) {
            tracing::warn!(collection_id = %collection_id, code = error.code(), %error, "runtime reconciliation request failed");
        }
    }

    fn request(&self, collection_id: Uuid, reconcile: bool) -> Result<(), ConnectError> {
        if reconcile {
            let (ready, receiver) = mpsc::sync_channel(0);
            self.commands
                .send(Command::Reconcile(collection_id, ready))
                .map_err(|_| {
                    ConnectError::CollectionOpen(
                        "collection runtime finalizer is unavailable".to_string(),
                    )
                })?;
            receiver.recv().map_err(|_| {
                ConnectError::CollectionOpen(
                    "collection runtime finalizer did not complete reconciliation".to_string(),
                )
            })?;
            return Ok(());
        }
        let (ready, receiver) = mpsc::sync_channel(0);
        self.commands
            .send(Command::Finalize(collection_id, ready))
            .map_err(|_| {
                ConnectError::CollectionOpen(
                    "collection runtime finalizer is unavailable".to_string(),
                )
            })?;
        receiver.recv().map_err(|_| {
            ConnectError::CollectionOpen(
                "collection runtime finalizer did not complete the request".to_string(),
            )
        })?
    }
}

fn run_finalizer(
    registry: CollectionRegistry,
    commands: mpsc::Receiver<Command>,
    runtime_events: Option<tokio::sync::mpsc::UnboundedSender<CollectionRuntimeEvent>>,
) {
    let mut active = BTreeSet::new();
    loop {
        match commands.recv_timeout(EXTERNAL_POLL) {
            Ok(command) => handle_command(&registry, &mut active, command, runtime_events.as_ref()),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }
        while let Ok(command) = commands.try_recv() {
            handle_command(&registry, &mut active, command, runtime_events.as_ref());
        }
        for collection_id in active.iter().copied().collect::<Vec<_>>() {
            let cancellation = mdbase::OperationCancellation::new();
            match registry.ingest_runtime_external(collection_id, Duration::ZERO, &cancellation) {
                Ok(true) => log_finalize(&registry, collection_id, runtime_events.as_ref()),
                Ok(false) => {}
                Err(error) => tracing::warn!(
                    collection_id = %collection_id,
                    code = error.code(),
                    %error,
                    "runtime external-change ingestion failed"
                ),
            }
        }
    }
}

fn handle_command(
    registry: &CollectionRegistry,
    active: &mut BTreeSet<Uuid>,
    command: Command,
    runtime_events: Option<&tokio::sync::mpsc::UnboundedSender<CollectionRuntimeEvent>>,
) {
    match command {
        Command::Refresh(collections, ready) => {
            *active = collections
                .into_iter()
                .map(|collection| collection.id)
                .collect();
            for collection_id in active.iter().copied() {
                log_finalize_resident(registry, collection_id, runtime_events);
            }
            let _ = ready.send(());
        }
        Command::Finalize(collection_id, ready) => {
            let _ = ready.send(finalize(registry, collection_id, runtime_events));
        }
        Command::Reconcile(collection_id, ready) => {
            let cancellation = mdbase::OperationCancellation::new();
            let reconciled = registry
                .synchronize_runtime(collection_id, &cancellation)
                .and_then(|()| finalize(registry, collection_id, runtime_events));
            if let Err(error) = reconciled {
                tracing::warn!(collection_id = %collection_id, code = error.code(), %error, "runtime reconciliation failed");
            }
            let _ = ready.send(());
        }
    }
}

fn finalize(
    registry: &CollectionRegistry,
    collection_id: Uuid,
    runtime_events: Option<&tokio::sync::mpsc::UnboundedSender<CollectionRuntimeEvent>>,
) -> Result<(), ConnectError> {
    let cancellation = mdbase::OperationCancellation::new();
    let events = registry.finalize_runtime_changes(collection_id, &cancellation)?;
    if let Some(runtime_events) = runtime_events {
        for (event, cursor) in events {
            let _ = runtime_events.send(CollectionRuntimeEvent {
                collection_id,
                cursor,
                event,
            });
        }
    }
    Ok(())
}

fn log_finalize(
    registry: &CollectionRegistry,
    collection_id: Uuid,
    runtime_events: Option<&tokio::sync::mpsc::UnboundedSender<CollectionRuntimeEvent>>,
) {
    if let Err(error) = finalize(registry, collection_id, runtime_events) {
        tracing::warn!(
            collection_id = %collection_id,
            code = error.code(),
            %error,
            "runtime change finalization failed"
        );
    }
}

fn log_finalize_resident(
    registry: &CollectionRegistry,
    collection_id: Uuid,
    runtime_events: Option<&tokio::sync::mpsc::UnboundedSender<CollectionRuntimeEvent>>,
) {
    let cancellation = mdbase::OperationCancellation::new();
    match registry.finalize_resident_runtime_changes(collection_id, &cancellation) {
        Ok(events) => {
            if let Some(runtime_events) = runtime_events {
                for (event, cursor) in events {
                    let _ = runtime_events.send(CollectionRuntimeEvent {
                        collection_id,
                        cursor,
                        event,
                    });
                }
            }
        }
        Err(error) => tracing::warn!(
            collection_id = %collection_id,
            code = error.code(),
            %error,
            "resident runtime change finalization failed"
        ),
    }
}
