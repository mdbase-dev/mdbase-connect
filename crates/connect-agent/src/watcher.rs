use mdbase_connect_core::{CollectionRegistry, ConnectError};
use mdbase_connect_protocol::CollectionSummary;
use std::collections::BTreeSet;
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
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
    inner: Arc<FinalizerWorker>,
}

struct FinalizerWorker {
    commands: mpsc::Sender<Command>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl Drop for FinalizerWorker {
    fn drop(&mut self) {
        let _ = self.commands.send(Command::Shutdown);
        // The worker owns only its receiver and registry, never this Arc, so the
        // final Arc cannot be dropped by the worker itself. Release the mutex
        // before joining because worker teardown must not depend on this lock.
        let worker = {
            let mut worker = self
                .worker
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            worker.take()
        };
        if let Some(worker) = worker {
            if worker.join().is_err() {
                tracing::warn!("collection runtime finalizer panicked during shutdown");
            }
        }
    }
}

enum Command {
    Refresh(Vec<CollectionSummary>, mpsc::SyncSender<()>),
    Deactivate(Uuid, mpsc::SyncSender<()>),
    Finalize(Uuid, mpsc::SyncSender<Result<(), ConnectError>>),
    Reconcile(Uuid, mpsc::SyncSender<()>),
    Shutdown,
    #[cfg(test)]
    IsActive(Uuid, mpsc::SyncSender<bool>),
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
        let worker = thread::Builder::new()
            .name("mdbase-connect-runtime-finalizer".to_string())
            .spawn(move || run_finalizer(registry, receiver, runtime_events))
            .expect("failed to start collection runtime finalizer");
        Self {
            inner: Arc::new(FinalizerWorker {
                commands,
                worker: Mutex::new(Some(worker)),
            }),
        }
    }

    pub fn refresh(&self, collections: &[CollectionSummary]) {
        let (ready, receiver) = mpsc::sync_channel(0);
        let active = collections
            .iter()
            .filter(|collection| collection.enabled)
            .cloned()
            .collect();
        if self
            .inner
            .commands
            .send(Command::Refresh(active, ready))
            .is_err()
        {
            tracing::warn!("collection runtime finalizer is unavailable");
            return;
        }
        if receiver.recv().is_err() {
            tracing::warn!("collection runtime finalizer did not acknowledge readiness");
        }
    }

    /// Stop background finalization before a collection leaves the registry.
    ///
    /// The acknowledgement is a lifecycle barrier: once it arrives, the
    /// finalizer will not issue another registry call for this collection
    /// unless a later refresh explicitly activates it again.
    pub fn deactivate(&self, collection_id: Uuid) {
        let (ready, receiver) = mpsc::sync_channel(0);
        if self
            .inner
            .commands
            .send(Command::Deactivate(collection_id, ready))
            .is_err()
        {
            tracing::warn!(%collection_id, "collection runtime finalizer is unavailable");
            return;
        }
        if receiver.recv().is_err() {
            tracing::warn!(%collection_id, "collection runtime finalizer did not acknowledge deactivation");
        }
    }

    #[cfg(test)]
    pub fn is_active(&self, collection_id: Uuid) -> bool {
        let (ready, receiver) = mpsc::sync_channel(0);
        self.inner
            .commands
            .send(Command::IsActive(collection_id, ready))
            .expect("collection runtime finalizer is available");
        receiver
            .recv()
            .expect("collection runtime finalizer reports active state")
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
            self.inner
                .commands
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
        self.inner
            .commands
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
            Ok(Command::Shutdown) => {
                registry.shutdown_runtimes();
                return;
            }
            Ok(command) => handle_command(&registry, &mut active, command, runtime_events.as_ref()),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                registry.shutdown_runtimes();
                return;
            }
        }
        while let Ok(command) = commands.try_recv() {
            if matches!(&command, Command::Shutdown) {
                registry.shutdown_runtimes();
                return;
            }
            handle_command(&registry, &mut active, command, runtime_events.as_ref());
        }
        for collection_id in active_resident_ids(&registry, &active) {
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
            for collection_id in active_resident_ids(registry, active) {
                log_finalize_resident(registry, collection_id, runtime_events);
            }
            let _ = ready.send(());
        }
        Command::Deactivate(collection_id, ready) => {
            active.remove(&collection_id);
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
        Command::Shutdown => unreachable!("shutdown is handled by the worker loop"),
        #[cfg(test)]
        Command::IsActive(collection_id, ready) => {
            let _ = ready.send(active.contains(&collection_id));
        }
    }
}

fn active_resident_ids(registry: &CollectionRegistry, active: &BTreeSet<Uuid>) -> Vec<Uuid> {
    match registry.resident_collection_ids() {
        Ok(resident) => resident
            .into_iter()
            .filter(|collection_id| active.contains(collection_id))
            .collect(),
        Err(error) => {
            tracing::warn!(code = error.code(), %error, "runtime residency snapshot failed");
            Vec::new()
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn final_service_drop_joins_worker_before_fixture_removal() {
        let root =
            std::env::temp_dir().join(format!("mdbase-watch-service-lifecycle-{}", Uuid::new_v4()));
        let registry = CollectionRegistry::open(root.join("state")).unwrap();
        let collection = registry
            .create(root.join("collection"), Some("Lifecycle"), "UTC")
            .unwrap();
        assert!(registry
            .resident_collection_ids()
            .unwrap()
            .contains(&collection.id));

        let service = CollectionWatchService::start(registry.clone());
        service.refresh(&registry.list().unwrap());
        let final_service = service.clone();
        let worker_owner = Arc::downgrade(&service.inner);

        drop(registry);
        drop(service);
        assert!(worker_owner.upgrade().is_some());
        drop(final_service);
        assert!(worker_owner.upgrade().is_none());

        // The final service drop joins the finalizer worker. Windows notify
        // closes its kernel registration asynchronously; collection-folder move
        // behavior is covered separately by the registry lifecycle test.
        #[cfg(windows)]
        let _ = fs::remove_dir_all(&root);
        #[cfg(not(windows))]
        fs::remove_dir_all(&root).unwrap();
    }
}
