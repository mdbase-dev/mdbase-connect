use mdbase::watch::CollectionWatcher;
use mdbase_connect_core::{CollectionInvalidation, CollectionRegistry};
use mdbase_connect_protocol::CollectionSummary;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct CollectionRuntimeEvent {
    pub collection_id: Uuid,
    pub cursor: u64,
    pub event: mdbase::watch::WatchEvent,
}

#[derive(Clone)]
pub struct CollectionWatchService {
    commands: mpsc::Sender<WatchCommand>,
}

enum WatchCommand {
    Refresh(Vec<CollectionSummary>, mpsc::SyncSender<()>),
    Synchronize(Uuid, CollectionInvalidation, mpsc::SyncSender<()>),
}

struct WatchWorker {
    stop: mpsc::Sender<()>,
    synchronize: mpsc::Sender<SynchronizeRequest>,
    worker: thread::JoinHandle<()>,
}

enum SynchronizeRequest {
    All(mpsc::SyncSender<()>),
    Paths(Vec<PathBuf>, mpsc::SyncSender<()>),
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
            .name("mdbase-connect-watch-supervisor".to_string())
            .spawn(move || watch_supervisor(registry, receiver, runtime_events))
            .expect("failed to start collection watcher supervisor");
        Self { commands }
    }

    pub fn refresh(&self, collections: &[CollectionSummary]) {
        let (ready, receiver) = mpsc::sync_channel(0);
        let command = WatchCommand::Refresh(
            collections
                .iter()
                .filter(|collection| collection.enabled)
                .cloned()
                .collect(),
            ready,
        );
        if let Err(error) = self.commands.send(command) {
            tracing::warn!(%error, "collection watcher is unavailable");
            return;
        }
        if let Err(error) = receiver.recv() {
            tracing::warn!(%error, "collection watcher did not acknowledge readiness");
        }
    }

    pub fn rescan(&self, collection_id: Uuid) {
        self.synchronize(collection_id, &CollectionInvalidation::All);
    }

    pub fn synchronize(&self, collection_id: Uuid, invalidation: &CollectionInvalidation) {
        if matches!(invalidation, CollectionInvalidation::None) {
            return;
        }
        let (ready, receiver) = mpsc::sync_channel(0);
        if let Err(error) = self.commands.send(WatchCommand::Synchronize(
            collection_id,
            invalidation.clone(),
            ready,
        )) {
            tracing::warn!(%error, "collection watcher is unavailable");
            return;
        }
        if let Err(error) = receiver.recv() {
            tracing::warn!(%error, "collection watcher did not complete the requested rescan");
        }
    }
}

fn watch_supervisor(
    registry: CollectionRegistry,
    commands: mpsc::Receiver<WatchCommand>,
    runtime_events: Option<tokio::sync::mpsc::UnboundedSender<CollectionRuntimeEvent>>,
) {
    let mut workers: HashMap<Uuid, WatchWorker> = HashMap::new();
    while let Ok(command) = commands.recv() {
        match command {
            WatchCommand::Refresh(collections, ready) => {
                refresh_workers(&registry, &mut workers, collections, runtime_events.clone());
                let _ = ready.send(());
            }
            WatchCommand::Synchronize(collection_id, invalidation, ready) => {
                if let Some(worker) = workers.get(&collection_id) {
                    let request = match invalidation {
                        CollectionInvalidation::None => {
                            let _ = ready.send(());
                            continue;
                        }
                        CollectionInvalidation::All => SynchronizeRequest::All(ready),
                        CollectionInvalidation::Records(paths) => SynchronizeRequest::Paths(
                            paths.into_iter().map(PathBuf::from).collect(),
                            ready,
                        ),
                    };
                    if let Err(error) = worker.synchronize.send(request) {
                        match error.0 {
                            SynchronizeRequest::All(ready)
                            | SynchronizeRequest::Paths(_, ready) => {
                                let _ = ready.send(());
                            }
                        }
                    } else {
                        worker.worker.thread().unpark();
                    }
                } else {
                    let _ = ready.send(());
                }
            }
        }
    }
    for (_, worker) in workers {
        stop_worker(worker);
    }
}

fn refresh_workers(
    registry: &CollectionRegistry,
    workers: &mut HashMap<Uuid, WatchWorker>,
    collections: Vec<CollectionSummary>,
    runtime_events: Option<tokio::sync::mpsc::UnboundedSender<CollectionRuntimeEvent>>,
) {
    let requested = collections
        .iter()
        .map(|collection| collection.id)
        .collect::<HashSet<_>>();
    for removed in workers
        .keys()
        .filter(|id| !requested.contains(id))
        .copied()
        .collect::<Vec<_>>()
    {
        if let Some(worker) = workers.remove(&removed) {
            stop_worker(worker);
        }
    }
    for collection in collections {
        if let std::collections::hash_map::Entry::Vacant(entry) = workers.entry(collection.id) {
            if let Some(worker) = start_worker(
                registry.clone(),
                collection.id,
                PathBuf::from(collection.path),
                runtime_events.clone(),
            ) {
                entry.insert(worker);
            }
        }
    }
}

fn start_worker(
    registry: CollectionRegistry,
    collection_id: Uuid,
    root: PathBuf,
    runtime_events: Option<tokio::sync::mpsc::UnboundedSender<CollectionRuntimeEvent>>,
) -> Option<WatchWorker> {
    let watcher = match CollectionWatcher::open(&root, Duration::from_millis(120)) {
        Ok(watcher) => watcher,
        Err(error) => {
            tracing::error!(collection_id = %collection_id, path = %root.display(), %error, "failed to watch collection");
            return None;
        }
    };
    let (stop, stop_rx) = mpsc::channel();
    let (synchronize, synchronize_rx) = mpsc::channel::<SynchronizeRequest>();
    let worker = thread::Builder::new()
        .name(format!("mdbase-connect-watch-{collection_id}"))
        .spawn(move || {
            loop {
                if stop_rx.try_recv().is_ok() {
                    return;
                }
                while let Ok(request) = synchronize_rx.try_recv() {
                    let (result, ready) = match request {
                        SynchronizeRequest::All(ready) => (watcher.rescan(), ready),
                        SynchronizeRequest::Paths(paths, ready) => {
                            (watcher.rescan_paths(paths), ready)
                        }
                    };
                    if let Err(error) = result {
                        tracing::warn!(collection_id = %collection_id, %error, "collection rescan failed");
                    }
                    while let Ok(Some(event)) = watcher.recv_timeout(Duration::ZERO) {
                        persist_event(&registry, collection_id, &event, runtime_events.as_ref());
                    }
                    let _ = ready.send(());
                }
                loop {
                    match watcher.recv_timeout(Duration::ZERO) {
                        Ok(Some(event)) => {
                            persist_event(&registry, collection_id, &event, runtime_events.as_ref())
                        }
                        Ok(None) => break,
                        Err(error) => {
                            tracing::warn!(collection_id = %collection_id, %error, "collection watcher stopped");
                            return;
                        }
                    }
                }
                // External filesystem events may wait up to this interval;
                // explicit mutation synchronization unparks the worker and is
                // processed immediately without a polling tax.
                thread::park_timeout(Duration::from_millis(100));
            }
        })
        .expect("failed to start collection watcher thread");
    Some(WatchWorker {
        stop,
        synchronize,
        worker,
    })
}

fn persist_event(
    registry: &CollectionRegistry,
    collection_id: Uuid,
    event: &mdbase::watch::WatchEvent,
    runtime_events: Option<&tokio::sync::mpsc::UnboundedSender<CollectionRuntimeEvent>>,
) {
    match registry.get(collection_id) {
        Ok(collection) if collection.enabled => {}
        Ok(_) => {
            tracing::debug!(
                collection_id = %collection_id,
                "ignored a filesystem event for an unavailable collection"
            );
            return;
        }
        Err(error) => {
            tracing::warn!(
                collection_id = %collection_id,
                %error,
                "ignored a filesystem event because collection authority could not be confirmed"
            );
            return;
        }
    }
    match registry.append_change(collection_id, event) {
        Err(error) => {
            tracing::warn!(collection_id = %collection_id, %error, "failed to persist collection change");
        }
        Ok(cursor) => {
            if let Some(runtime_events) = runtime_events {
                let _ = runtime_events.send(CollectionRuntimeEvent {
                    collection_id,
                    cursor,
                    event: event.clone(),
                });
            }
            tracing::debug!(collection_id = %collection_id, event_type = %event.event_type, sequence = event.sequence, cursor, "collection change recorded");
        }
    }
}

fn stop_worker(worker: WatchWorker) {
    let _ = worker.stop.send(());
    worker.worker.thread().unpark();
    let _ = worker.worker.join();
}
