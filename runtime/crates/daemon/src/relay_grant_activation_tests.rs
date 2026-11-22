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
    close_reason: &'static str,
    /// Grant checks never answer (a parked collection actor).
    stalled: AtomicBool,
}
impl WaitingHost {
    fn new(eligible: bool) -> Arc<Self> {
        Self::with(false, eligible, "grant_inactive")
    }
    fn with(live: bool, eligible: bool, close_reason: &'static str) -> Arc<Self> {
        Arc::new(Self {
            live: AtomicBool::new(live),
            eligible: AtomicBool::new(eligible),
            epoch: AtomicU64::new(1),
            changes: watch::channel(()).0,
            close_reason,
            stalled: AtomicBool::new(false),
        })
    }
    async fn stall(&self) {
        if self.stalled.load(Ordering::SeqCst) {
            std::future::pending::<()>().await;
        }
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
    fn grant_refusal<'a>(&'a self, _: &'a str, _: &'a str) -> BoxFuture<'a, Option<String>> {
        Box::pin(async {
            self.stall().await;
            (!self.live.load(Ordering::SeqCst)).then(|| self.close_reason.into())
        })
    }
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
        Box::pin(async move {
            self.stall().await;
            self.live.load(Ordering::SeqCst)
        })
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
fn pipe_id() -> [u8; 16] {
    crate::attest::uuid_bytes(ids()["pipe_id"].as_str().unwrap()).unwrap()
}
struct Registered {
    pipes: BTreeMap<[u8; 16], Pipe>,
    rx: mpsc::Receiver<PipeOut>,
    applied: watch::Sender<()>,
    _out: mpsc::Sender<PipeOut>,
}
/// Register one pipe and let its task run its admission.
async fn register(host: &Arc<WaitingHost>) -> Registered {
    let (out, rx) = mpsc::channel(256);
    let (applied, applied_rx) = watch::channel(());
    let mut pipes = BTreeMap::new();
    let id = Arc::new(DeviceIdentity::generate().unwrap());
    open_pipe(host, &id, &ids(), &mut pipes, &out, &applied_rx);
    assert_eq!(pipes.len(), 1, "registered before any grant check");
    settle().await;
    Registered {
        pipes,
        rx,
        applied,
        _out: out,
    }
}
async fn settle() {
    for _ in 0..8 {
        tokio::task::yield_now().await;
    }
}
async fn closed(r: &mut Registered) -> String {
    match r.rx.recv().await {
        Some(PipeOut::Close(pipe, why)) => {
            assert_eq!(pipe, pipe_id());
            why
        }
        other => panic!("expected a close, got {other:?}"),
    }
}

#[tokio::test(start_paused = true)]
async fn dead_pipe_uses_the_hosts_precise_refusal() {
    for reason in [
        "grant_lease_expired",
        "grant_revoked_on_device",
        "unknown_grant",
    ] {
        let h = WaitingHost::with(true, false, reason);
        let mut r = register(&h).await;
        assert!(r.rx.try_recv().is_err());
        h.live.store(false, Ordering::SeqCst);
        // A feed commit wakes the check at once, before the next sweep.
        r.applied.send_replace(());
        assert_eq!(closed(&mut r).await, reason);
    }
}

#[tokio::test(start_paused = true)]
async fn pending_pipe_uses_the_precise_refusal_on_lease_loss_or_activation_timeout() {
    for reason in ["grant_lease_expired", "authorization_unavailable"] {
        let h = WaitingHost::with(false, true, reason);
        let mut r = register(&h).await;
        if reason == "grant_lease_expired" {
            h.eligible.store(false, Ordering::SeqCst);
            tokio::time::advance(GRANT_SWEEP).await;
        } else {
            tokio::time::advance(Duration::from_secs(21)).await;
        }
        assert_eq!(closed(&mut r).await, reason);
    }
}

#[tokio::test(start_paused = true)]
async fn pending_pipe_registered_and_swept_without_blocking_or_admitting() {
    let h = WaitingHost::new(true);
    let mut r = register(&h).await;
    for _ in 0..5 {
        tokio::time::advance(Duration::from_secs(1)).await;
        settle().await;
        assert!(r.rx.try_recv().is_err());
    }
    // The relay can queue M1 bytes while the original task is waiting; bounded FIFO.
    let p = r.pipes.values().next().unwrap();
    assert!(p.tx.try_send(vec![0, 0, 0, 1, 0]).is_ok());
    assert!(!p.task.is_finished());
    assert!(r.rx.try_recv().is_err());
    for (_, mut p) in r.pipes {
        p.task.abort();
        assert!((&mut p.task).await.unwrap_err().is_cancelled());
    }
}

#[tokio::test(start_paused = true)]
async fn activation_timeout_is_twenty_seconds_and_refuses_same_pipe() {
    let h = WaitingHost::new(true);
    let mut r = register(&h).await;
    tokio::time::advance(Duration::from_secs(19)).await;
    settle().await;
    assert!(r.rx.try_recv().is_err());
    tokio::time::advance(Duration::from_secs(1)).await;
    assert_eq!(closed(&mut r).await, "grant_inactive");
    for (_, mut p) in std::mem::take(&mut r.pipes) {
        (&mut p.task).await.unwrap();
    }
    assert!(r.rx.try_recv().is_err());
}

#[tokio::test(start_paused = true)]
async fn original_context_change_while_pending_never_recaptures() {
    let h = WaitingHost::new(true);
    let mut r = register(&h).await;
    h.epoch.store(2, Ordering::SeqCst);
    h.live.store(true, Ordering::SeqCst);
    tokio::time::advance(GRANT_SWEEP).await;
    assert_eq!(closed(&mut r).await, "authorization_unavailable");
}

#[tokio::test(start_paused = true)]
async fn absent_positive_consent_is_refused_by_the_pipe_task() {
    let h = WaitingHost::new(false);
    let mut r = register(&h).await;
    assert_eq!(closed(&mut r).await, "grant_inactive");
    for (_, mut p) in std::mem::take(&mut r.pipes) {
        (&mut p.task).await.unwrap();
    }
}

#[tokio::test(start_paused = true)]
async fn an_unanswered_admission_is_refused_as_not_served() {
    let h = WaitingHost::with(true, false, "grant_inactive");
    h.stalled.store(true, Ordering::SeqCst);
    let mut r = register(&h).await;
    assert!(r.rx.try_recv().is_err(), "nothing decided before the wait");
    assert_eq!(closed(&mut r).await, "not_served");
}

#[tokio::test(start_paused = true)]
async fn an_unanswered_sweep_keeps_the_pipe() {
    let h = WaitingHost::with(true, false, "grant_inactive");
    let mut r = register(&h).await;
    h.stalled.store(true, Ordering::SeqCst);
    // Within the session's 10 s handshake wait, so only the sweep could close it.
    for _ in 0..4 {
        tokio::time::advance(GRANT_SWEEP).await;
        settle().await;
    }
    assert!(r.rx.try_recv().is_err(), "a stalled check closes nothing");
    assert!(!r.pipes.values().next().unwrap().task.is_finished());
    // Once checks answer again, a lost grant still closes the pipe.
    h.stalled.store(false, Ordering::SeqCst);
    h.live.store(false, Ordering::SeqCst);
    tokio::time::advance(GRANT_CHECK_WAIT + GRANT_SWEEP).await;
    assert_eq!(closed(&mut r).await, "grant_inactive");
}
