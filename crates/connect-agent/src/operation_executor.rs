use crate::admission::{WorkClass, MAX_CONCURRENT_READS};
use std::sync::OnceLock;
use tokio::runtime::Runtime;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio::task::JoinHandle;

/// Keep collection snapshots on a small, stable set of workers. Query bodies
/// can establish a large allocator high-water mark, so allowing them onto the
/// generic blocking pool makes retained memory grow with unrelated work.
fn read_runtime() -> &'static Runtime {
    static RUNTIME: OnceLock<Runtime> = OnceLock::new();
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .max_blocking_threads(MAX_CONCURRENT_READS)
            .thread_name("mdbase-read-worker")
            .build()
            .expect("collection read runtime must start")
    })
}

/// Local control builds its protocol envelope after operation execution. Keep
/// at most one response per read worker alive across that handoff and socket
/// delivery, even when many local clients arrive concurrently.
pub(crate) async fn reserve_local_response() -> OwnedSemaphorePermit {
    static SLOTS: OnceLock<std::sync::Arc<Semaphore>> = OnceLock::new();
    SLOTS
        .get_or_init(|| std::sync::Arc::new(Semaphore::new(MAX_CONCURRENT_READS)))
        .clone()
        .acquire_owned()
        .await
        .expect("local response capacity must remain open")
}

pub(crate) fn reserves_local_response(class: WorkClass) -> bool {
    matches!(class, WorkClass::Foreground | WorkClass::Background)
}

pub(crate) fn spawn_blocking<T, F>(class: WorkClass, operation: F) -> JoinHandle<T>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    match class {
        WorkClass::Foreground | WorkClass::Background => read_runtime().spawn_blocking(operation),
        WorkClass::Mutation | WorkClass::File => tokio::task::spawn_blocking(operation),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    #[tokio::test]
    async fn collection_reads_use_at_most_two_stable_workers() {
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let mut jobs = Vec::new();

        for _ in 0..12 {
            let active = active.clone();
            let peak = peak.clone();
            let class = if jobs.len() % 2 == 0 {
                WorkClass::Foreground
            } else {
                WorkClass::Background
            };
            jobs.push(spawn_blocking(class, move || {
                let current = active.fetch_add(1, Ordering::AcqRel) + 1;
                peak.fetch_max(current, Ordering::AcqRel);
                std::thread::sleep(Duration::from_millis(20));
                active.fetch_sub(1, Ordering::AcqRel);
                std::thread::current().id()
            }));
        }

        let mut workers = HashSet::new();
        for job in jobs {
            workers.insert(job.await.expect("read worker must finish"));
        }

        assert!(peak.load(Ordering::Acquire) <= MAX_CONCURRENT_READS);
        assert!(workers.len() <= MAX_CONCURRENT_READS);
        assert!(!workers.is_empty());
    }

    #[tokio::test]
    async fn local_response_reservations_bound_completed_work() {
        let first = reserve_local_response().await;
        let second = reserve_local_response().await;
        let waiting = tokio::spawn(reserve_local_response());

        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!waiting.is_finished());

        drop(first);
        let third = tokio::time::timeout(Duration::from_secs(1), waiting)
            .await
            .expect("released response capacity must admit the waiter")
            .expect("response waiter must not fail");
        drop((second, third));
    }

    #[test]
    fn local_response_reservations_never_block_mutation_capacity() {
        assert!(reserves_local_response(WorkClass::Foreground));
        assert!(reserves_local_response(WorkClass::Background));
        assert!(!reserves_local_response(WorkClass::Mutation));
        assert!(!reserves_local_response(WorkClass::File));
    }
}
