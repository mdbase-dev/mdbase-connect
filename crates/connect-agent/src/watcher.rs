use mdbase_connect_core::{CollectionRegistry, ConnectError};
use mdbase_connect_protocol::CollectionSummary;
use std::collections::{BTreeSet, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use uuid::Uuid;

// Readiness drives normal work. This is only a recovery safety net, not the
// interactive-change latency budget.
const RECOVERY_POLL: Duration = Duration::from_secs(1);
const COMMAND_CAPACITY: usize = 64;
const MAX_PENDING_FINALIZATIONS: usize = 128;

#[derive(Debug, Clone)]
pub struct CollectionRuntimeEvent {
    pub collection_id: Uuid,
    pub cursor: u64,
    pub event: mdbase::watch::WatchEvent,
}

pub struct RuntimeEventDelivery {
    pub change: CollectionRuntimeEvent,
    pub admitted: mpsc::SyncSender<Result<(), ConnectError>>,
}

/// Persists the engine-owned change feed. It never installs a filesystem watcher.
#[derive(Clone)]
pub struct CollectionWatchService {
    inner: Arc<FinalizerWorker>,
}

struct FinalizerWorker {
    commands: mpsc::SyncSender<Command>,
    worker: Mutex<Option<JoinHandle<()>>>,
    shutdown: Arc<AtomicBool>,
}

impl Drop for FinalizerWorker {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Release);
        let _ = self.commands.try_send(Command::Shutdown);
        let worker = self
            .worker
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        if let Some(worker) = worker {
            if worker.join().is_err() {
                tracing::warn!("collection runtime finalizer panicked during shutdown");
            }
        }
    }
}

enum Command {
    Wake,
    Refresh(Vec<CollectionSummary>, mpsc::SyncSender<()>),
    Deactivate(Uuid, mpsc::SyncSender<()>),
    Finalize(Uuid, mpsc::SyncSender<Result<(), ConnectError>>),
    Reconcile(Uuid, mpsc::SyncSender<()>),
    Shutdown,
    #[cfg(test)]
    IsActive(Uuid, mpsc::SyncSender<bool>),
}

struct PendingFinalize {
    collection_id: Uuid,
    target: Option<u64>,
    response: Option<Completion>,
}

enum Completion {
    Finalize(mpsc::SyncSender<Result<(), ConnectError>>),
    Reconcile(mpsc::SyncSender<()>),
}
impl Completion {
    fn finish(self, result: Result<(), ConnectError>) {
        match self {
            Self::Finalize(response) => {
                let _ = response.send(result);
            }
            Self::Reconcile(response) => {
                if let Err(error) = result {
                    tracing::warn!(code = error.code(), %error, "runtime reconciliation finalization failed");
                }
                let _ = response.send(());
            }
        }
    }
}

impl CollectionWatchService {
    #[cfg(test)]
    pub fn start(registry: CollectionRegistry) -> Self {
        Self::start_with_runtime_events(registry, None)
    }

    pub fn start_with_runtime_events(
        registry: CollectionRegistry,
        runtime_events: Option<tokio::sync::mpsc::Sender<RuntimeEventDelivery>>,
    ) -> Self {
        let (commands, receiver) = mpsc::sync_channel(COMMAND_CAPACITY);
        let wake_queued = Arc::new(AtomicBool::new(false));
        let wake_sender = commands.clone();
        let queued = wake_queued.clone();
        registry.set_runtime_waker(Arc::new(move || {
            if !queued.swap(true, Ordering::AcqRel) && wake_sender.try_send(Command::Wake).is_err()
            {
                // A full command queue also wakes the worker, which scans on
                // command receipt. Never block the engine's watcher thread.
                queued.store(false, Ordering::Release);
            }
        }));
        let shutdown = Arc::new(AtomicBool::new(false));
        let worker_shutdown = shutdown.clone();
        let worker = thread::Builder::new()
            .name("mdbase-connect-runtime-finalizer".to_string())
            .spawn(move || {
                run_finalizer(
                    registry,
                    receiver,
                    runtime_events,
                    wake_queued,
                    worker_shutdown,
                )
            })
            .expect("failed to start collection runtime finalizer");
        Self {
            inner: Arc::new(FinalizerWorker {
                commands,
                worker: Mutex::new(Some(worker)),
                shutdown,
            }),
        }
    }

    pub fn is_alive(&self) -> bool {
        self.inner
            .worker
            .lock()
            .expect("finalizer worker lock poisoned")
            .as_ref()
            .is_some_and(|worker| !worker.is_finished())
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
            .is_ok()
        {
            let _ = receiver.recv();
        }
    }

    /// A lifecycle barrier: cancel queued turns before acknowledging removal.
    pub fn deactivate(&self, collection_id: Uuid) {
        let (ready, receiver) = mpsc::sync_channel(0);
        if self
            .inner
            .commands
            .send(Command::Deactivate(collection_id, ready))
            .is_ok()
        {
            let _ = receiver.recv();
        }
    }

    #[cfg(test)]
    pub fn is_active(&self, collection_id: Uuid) -> bool {
        let (ready, receiver) = mpsc::sync_channel(0);
        self.inner
            .commands
            .send(Command::IsActive(collection_id, ready))
            .unwrap();
        receiver.recv().unwrap()
    }

    pub fn finalize(&self, collection_id: Uuid) -> Result<(), ConnectError> {
        let (ready, receiver) = mpsc::sync_channel(0);
        self.inner
            .commands
            .send(Command::Finalize(collection_id, ready))
            .map_err(|_| unavailable())?;
        receiver.recv().map_err(|_| unavailable())?
    }

    pub fn rescan(&self, collection_id: Uuid) {
        let (ready, receiver) = mpsc::sync_channel(0);
        if self
            .inner
            .commands
            .send(Command::Reconcile(collection_id, ready))
            .is_ok()
        {
            let _ = receiver.recv();
        }
    }
}

fn unavailable() -> ConnectError {
    ConnectError::CollectionOpen("collection runtime finalizer is unavailable".into())
}

fn enqueue_background(jobs: &mut VecDeque<PendingFinalize>, collection_id: Uuid) {
    if jobs.len() < MAX_PENDING_FINALIZATIONS
        && !jobs.iter().any(|job| job.collection_id == collection_id)
    {
        jobs.push_back(PendingFinalize {
            collection_id,
            target: None,
            response: None,
        });
    }
}

fn cancel_inactive(jobs: &mut VecDeque<PendingFinalize>, active: &BTreeSet<Uuid>) {
    jobs.retain_mut(|job| {
        if active.contains(&job.collection_id) {
            return true;
        }
        if let Some(response) = job.response.take() {
            response.finish(Err(ConnectError::AccessDenied(
                "The collection was deactivated.".into(),
            )));
        }
        false
    });
}

fn run_finalizer(
    registry: CollectionRegistry,
    commands: mpsc::Receiver<Command>,
    runtime_events: Option<tokio::sync::mpsc::Sender<RuntimeEventDelivery>>,
    wake_queued: Arc<AtomicBool>,
    shutdown: Arc<AtomicBool>,
) {
    let mut active = match registry.list() {
        Ok(collections) => collections
            .into_iter()
            .filter(|collection| collection.enabled)
            .map(|collection| collection.id)
            .collect(),
        Err(error) => {
            tracing::error!(%error, "could not initialize runtime finalizer");
            return;
        }
    };
    let mut jobs = VecDeque::<PendingFinalize>::new();
    let mut poll = true;
    let mut next_recovery = std::time::Instant::now();
    loop {
        if shutdown.load(Ordering::Acquire) {
            drop(jobs);
            registry.shutdown_runtimes();
            return;
        }
        let mut recovery = false;
        // Bound both the channel and work queue. Process one command and one
        // collection turn at a time: neither continuous commands nor a hot
        // collection can monopolize the worker.
        if jobs.len() < MAX_PENDING_FINALIZATIONS {
            let timeout = if poll || !jobs.is_empty() {
                Duration::ZERO
            } else {
                next_recovery.saturating_duration_since(std::time::Instant::now())
            };
            match commands.recv_timeout(timeout) {
                Ok(Command::Shutdown) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                    drop(jobs);
                    registry.shutdown_runtimes();
                    return;
                }
                Ok(command) => {
                    poll = true;
                    match command {
                        Command::Wake => {
                            wake_queued.store(false, Ordering::Release);
                        }
                        Command::Refresh(collections, ready) => {
                            active = collections
                                .into_iter()
                                .map(|collection| collection.id)
                                .collect();
                            cancel_inactive(&mut jobs, &active);
                            for id in active_resident_ids(&registry, &active) {
                                enqueue_background(&mut jobs, id);
                            }
                            let _ = ready.send(());
                        }
                        Command::Deactivate(id, ready) => {
                            active.remove(&id);
                            cancel_inactive(&mut jobs, &active);
                            let _ = ready.send(());
                        }
                        Command::Finalize(id, ready) => {
                            if active.contains(&id) {
                                jobs.push_back(PendingFinalize {
                                    collection_id: id,
                                    target: None,
                                    response: Some(Completion::Finalize(ready)),
                                });
                            } else {
                                let _ = ready.send(Err(ConnectError::AccessDenied(
                                    "The collection is not active.".into(),
                                )));
                            }
                        }
                        Command::Reconcile(id, ready) => {
                            if active.contains(&id) {
                                let cancellation = mdbase::OperationCancellation::new();
                                match registry.synchronize_runtime(id, &cancellation) {
                                    Ok(()) => jobs.push_back(PendingFinalize {
                                        collection_id: id,
                                        target: None,
                                        response: Some(Completion::Reconcile(ready)),
                                    }),
                                    Err(error) => Completion::Reconcile(ready).finish(Err(error)),
                                }
                            } else {
                                Completion::Reconcile(ready).finish(Err(
                                    ConnectError::AccessDenied(
                                        "The collection is not active.".into(),
                                    ),
                                ));
                            }
                        }
                        #[cfg(test)]
                        Command::IsActive(id, ready) => {
                            let _ = ready.send(active.contains(&id));
                        }
                        Command::Shutdown => unreachable!(),
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
        }
        // Recovery must also run under continuous work, not only when an idle
        // receive times out (failed admissions otherwise starve behind hot feeds).
        if std::time::Instant::now() >= next_recovery {
            poll = true;
            recovery = true;
            next_recovery = std::time::Instant::now() + RECOVERY_POLL;
        }
        if poll {
            poll = false;
            for id in active_resident_ids(&registry, &active) {
                let cancellation = mdbase::OperationCancellation::new();
                match registry.ingest_runtime_external(id, Duration::ZERO, &cancellation) {
                    Ok(changed) => {
                        if changed || recovery {
                            enqueue_background(&mut jobs, id);
                        }
                        // Drain remaining watcher observations without waiting
                        // for another edge, interleaved with finalization turns.
                        poll |= changed;
                    }
                    Err(error) => {
                        tracing::warn!(collection_id = %id, code = error.code(), %error, "runtime external-change ingestion failed")
                    }
                }
            }
        }
        let Some(mut job) = jobs.pop_front() else {
            continue;
        };
        let cancellation = mdbase::OperationCancellation::new();
        let turn = registry.finalize_runtime_turn_delivering(
            job.collection_id,
            job.target,
            &cancellation,
            job.response.is_none(),
            |events| {
                if let Some(sender) = &runtime_events {
                    for (event, cursor) in events {
                        admit_event(
                            sender,
                            CollectionRuntimeEvent {
                                collection_id: job.collection_id,
                                cursor: *cursor,
                                event: event.clone(),
                            },
                            &shutdown,
                        )?;
                    }
                }
                Ok(())
            },
        );
        match turn {
            Ok(turn) => {
                if turn.complete {
                    if let Some(response) = job.response {
                        response.finish(Ok(()));
                    }
                } else {
                    job.target = Some(turn.target);
                    jobs.push_back(job);
                }
            }
            Err(error) => {
                if let Some(response) = job.response {
                    response.finish(Err(error));
                } else {
                    tracing::warn!(collection_id = %job.collection_id, code = error.code(), %error, "runtime change finalization failed");
                }
            }
        }
    }
}

fn admit_event(
    sender: &tokio::sync::mpsc::Sender<RuntimeEventDelivery>,
    change: CollectionRuntimeEvent,
    shutdown: &AtomicBool,
) -> Result<(), ConnectError> {
    let (admitted, response) = mpsc::sync_channel(1);
    let mut message = RuntimeEventDelivery { change, admitted };
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    loop {
        if shutdown.load(Ordering::Acquire) || std::time::Instant::now() >= deadline {
            return Err(unavailable());
        }
        match sender.try_send(message) {
            Ok(()) => break,
            Err(tokio::sync::mpsc::error::TrySendError::Full(returned)) => {
                message = returned;
                thread::sleep(Duration::from_millis(10));
            }
            Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => return Err(unavailable()),
        }
    }
    loop {
        if shutdown.load(Ordering::Acquire) || std::time::Instant::now() >= deadline {
            return Err(unavailable());
        }
        match response.recv_timeout(Duration::from_millis(10)) {
            Ok(result) => return result,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return Err(unavailable()),
        }
    }
}

fn active_resident_ids(registry: &CollectionRegistry, active: &BTreeSet<Uuid>) -> Vec<Uuid> {
    match registry.resident_collection_ids() {
        Ok(ids) => ids.into_iter().filter(|id| active.contains(id)).collect(),
        Err(error) => {
            tracing::warn!(code = error.code(), %error, "runtime residency snapshot failed");
            Vec::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    include!("watcher_tests.rs");
    include!("watcher_performance_tests.rs");
    #[test]
    fn final_service_drop_joins_worker_before_fixture_removal() {
        let root = tempfile::tempdir().unwrap();
        let registry = CollectionRegistry::open(root.path().join("state")).unwrap();
        registry
            .create(root.path().join("collection"), Some("Lifecycle"), "UTC")
            .unwrap();
        let service = CollectionWatchService::start(registry.clone());
        service.refresh(&registry.list().unwrap());
        let final_service = service.clone();
        let worker_owner = Arc::downgrade(&service.inner);
        drop(service);
        assert!(worker_owner.upgrade().is_some());
        drop(final_service);
        assert!(worker_owner.upgrade().is_none());
        assert!(registry.resident_collection_ids().unwrap().is_empty());
    }
}
