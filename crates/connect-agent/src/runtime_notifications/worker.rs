use std::future::Future;
use std::thread::JoinHandle;
use tokio::sync::oneshot;

/// Synchronous finalizer/control barriers may run on the caller's Tokio thread.
/// Local durable admission must progress independently of that executor. The
/// owning task remains abortable/monitored and joins this worker on shutdown.
pub(super) fn spawn(
    future: impl Future<Output = ()> + Send + 'static,
) -> tokio::task::JoinHandle<()> {
    let (stop, stopped) = oneshot::channel();
    let (finished, completion) = oneshot::channel();
    let thread = std::thread::Builder::new()
        .name("notification-admission".into())
        .spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("notification worker runtime");
            runtime.block_on(async move {
                tokio::select! {
                    biased;
                    _ = stopped => {},
                    _ = future => {},
                }
            });
            let _ = finished.send(());
        })
        .expect("notification worker thread");
    // Construct before spawning so abort-before-first-poll also stops and joins.
    let guard = Worker {
        stop: Some(stop),
        thread: Some(thread),
    };
    tokio::spawn(async move {
        let _guard = guard;
        completion.await.expect("notification worker failed");
    })
}

struct Worker {
    stop: Option<oneshot::Sender<()>>,
    thread: Option<JoinHandle<()>>,
}

impl Drop for Worker {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(thread) = self.thread.take() {
            if thread.join().is_err() {
                tracing::error!("notification admission worker panicked");
            }
        }
    }
}
