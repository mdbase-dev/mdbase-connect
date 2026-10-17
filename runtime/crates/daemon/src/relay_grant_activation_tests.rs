//! Relay lifecycle controls only; real-runtime kind-6 coverage is separate.
use super::*;
use crate::session::{Auth, BoxFuture, Handler, Opened, Prologue};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tokio::sync::watch;

struct WaitingHost {
    live: AtomicBool,
    eligible: AtomicBool,
    epoch: AtomicU64,
    changes: watch::Sender<()>,
}
impl WaitingHost {
    fn new(eligible: bool) -> Arc<Self> {
        Arc::new(Self {
            live: AtomicBool::new(false),
            eligible: AtomicBool::new(eligible),
            epoch: AtomicU64::new(1),
            changes: watch::channel(()).0,
        })
    }
}
impl Handler for WaitingHost {
    fn open<'a>(
        &'a self,
        _: Prologue,
        _: Auth,
        hello: mdbn_wire::client::ClientRequest,
    ) -> BoxFuture<'a, Opened> {
        Box::pin(async move {
            panic!(
                "these lifecycle controls never send a Noise M1: unexpected admission {}",
                hello.id
            )
        })
    }
}
impl RelayHost for WaitingHost {
    fn inventory(&self) -> BoxFuture<'_, Vec<(String, Value)>> {
        Box::pin(async { vec![] })
    }
    fn policy_cursor(&self) -> BoxFuture<'_, Option<crate::access::FeedCursor>> {
        Box::pin(async { None })
    }
    fn commit_feed<'a>(
        &'a self,
        _: &'a Snapshot,
        _: &'a BTreeMap<String, Vec<CachedGrant>>,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
    fn grant_live<'a>(&'a self, _: &'a str, _: &'a str) -> BoxFuture<'a, bool> {
        Box::pin(async move { self.live.load(Ordering::SeqCst) })
    }
    fn grant_activation<'a>(
        self: &'a Arc<Self>,
        _: &'a str,
        _: &'a str,
    ) -> BoxFuture<'a, Option<GrantActivation>> {
        Box::pin(async move {
            if !self.eligible.load(Ordering::SeqCst) {
                return None;
            }
            let original_epoch = self.epoch.load(Ordering::SeqCst);
            let h = self.clone();
            let current: GrantActivationGuard = Arc::new(move || {
                let h = h.clone();
                Box::pin(async move {
                    h.eligible.load(Ordering::SeqCst)
                        && h.epoch.load(Ordering::SeqCst) == original_epoch
                })
            });
            let mut changes = self.changes.subscribe();
            let guard = current.clone();
            let h = self.clone();
            let wait = Box::pin(async move {
                loop {
                    if !guard().await {
                        return false;
                    }
                    if h.live.load(Ordering::SeqCst) {
                        return true;
                    }
                    if changes.changed().await.is_err() {
                        return false;
                    }
                }
            });
            Some(GrantActivation { current, wait })
        })
    }
    fn set_online(&self, _: bool) {}
}
fn ids() -> Value {
    json!({"pipe_id":"11111111-1111-4111-8111-111111111111","collection_id":"22222222-2222-4222-8222-222222222222","grant_id":"33333333-3333-4333-8333-333333333333"})
}
async fn register(
    host: &Arc<WaitingHost>,
) -> (
    BTreeMap<[u8; 16], Pipe>,
    mpsc::Receiver<PipeOut>,
    mpsc::Sender<PipeOut>,
) {
    let (out, rx) = mpsc::channel(256);
    let mut pipes = BTreeMap::new();
    let id = Arc::new(DeviceIdentity::generate().unwrap());
    open_pipe(host, &id, &ids(), &mut pipes, &out).await;
    (pipes, rx, out)
}
#[tokio::test(start_paused = true)]
async fn pending_pipe_registered_and_swept_without_blocking_or_admitting() {
    let h = WaitingHost::new(true);
    let (mut pipes, mut rx, out) = register(&h).await;
    assert_eq!(pipes.len(), 1);
    assert!(rx.try_recv().is_err());
    for _ in 0..5 {
        tokio::time::advance(Duration::from_secs(1)).await;
        close_dead(&h, &mut pipes, &out).await;
        assert_eq!(pipes.len(), 1);
    }
    // The relay can queue M1 bytes while the original task is waiting; bounded FIFO.
    let p = pipes.values().next().unwrap();
    assert!(p.tx.try_send(vec![0, 0, 0, 1, 0]).is_ok());
    assert!(p.waiting_for_grant.load(Ordering::SeqCst));
    assert!(rx.try_recv().is_err());
    for (_, p) in pipes {
        p.task.abort();
        assert!(p.task.await.unwrap_err().is_cancelled());
    }
}
#[tokio::test(start_paused = true)]
async fn activation_timeout_is_twenty_seconds_and_refuses_same_pipe() {
    let h = WaitingHost::new(true);
    let (pipes, mut rx, _) = register(&h).await;
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_secs(19)).await;
    assert!(rx.try_recv().is_err());
    tokio::time::advance(Duration::from_secs(1)).await;
    tokio::task::yield_now().await;
    let pipe = crate::attest::uuid_bytes(ids()["pipe_id"].as_str().unwrap()).unwrap();
    assert_eq!(
        rx.recv().await,
        Some(PipeOut::Close(pipe, "grant_inactive".into()))
    );
    for (_, p) in pipes {
        p.task.await.unwrap();
    }
    assert!(rx.try_recv().is_err());
}
#[tokio::test(start_paused = true)]
async fn original_context_change_before_first_task_poll_never_recaptures() {
    let h = WaitingHost::new(true);
    let (mut pipes, mut rx, out) = register(&h).await;
    h.epoch.store(2, Ordering::SeqCst);
    h.live.store(true, Ordering::SeqCst);
    close_dead(&h, &mut pipes, &out).await;
    assert!(pipes.is_empty());
    assert!(matches!(rx.recv().await,Some(PipeOut::Close(_,why)) if why=="grant_inactive"));
}
#[tokio::test(start_paused = true)]
async fn absent_positive_consent_is_refused_without_pending_task() {
    let h = WaitingHost::new(false);
    let (pipes, mut rx, _) = register(&h).await;
    assert!(pipes.is_empty());
    assert!(matches!(rx.recv().await,Some(PipeOut::Close(_,why)) if why=="grant_inactive"));
}
