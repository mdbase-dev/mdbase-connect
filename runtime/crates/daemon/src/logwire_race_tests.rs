//! Synthetic epoch races at the real transport future's await boundaries.
use super::*;
use tokio::sync::Notify;

struct SlowToken {
    source: Arc<dyn TokenSource>,
    entered: Notify,
    release: Notify,
}
impl TokenSource for SlowToken {
    fn token(&self) -> Pin<Box<dyn Future<Output = Result<Token, String>> + Send + '_>> {
        Box::pin(async move {
            self.entered.notify_one();
            self.release.notified().await;
            self.source.token().await
        })
    }
    fn current(&self) -> Result<(), String> {
        self.source.current()
    }
}
fn retry(result: (Ended, bool), reason: &str) {
    assert!(!result.1);
    let Ended::Retry(actual) = result.0 else {
        panic!("expected source fence, not server refusal")
    };
    assert_eq!(actual, reason);
}
#[tokio::test]
async fn changed_source_after_token_await_never_connects() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let cfg = LinkConfig::new(
        format!("http://{}", listener.local_addr().unwrap()),
        COL,
        Some(DEV),
    );
    let (source, epoch) = epoch_source();
    let slow = Arc::new(SlowToken {
        source,
        entered: Notify::new(),
        release: Notify::new(),
    });
    let generation = Generation::begin(slow.clone());
    let (_tx, mut calls) = mpsc::channel(2);
    let budget = Arc::new(tokio::sync::Semaphore::new(1));
    let events = |_: Event| panic!("no proof/Up/delivery allowed after stale token");
    let (result, ()) = tokio::join!(
        session(&cfg, &generation, &mut calls, &budget, &events),
        async {
            slow.entered.notified().await;
            epoch.store(2, Ordering::SeqCst);
            slow.release.notify_one();
        }
    );
    retry(result, "stale token completion");
    assert!(
        tokio::time::timeout(Duration::from_millis(50), listener.accept())
            .await
            .is_err()
    );
}
#[tokio::test]
async fn changed_source_after_proof_await_never_sends_hello() {
    let hellos = Arc::new(Mutex::new(Vec::new()));
    let url = peer(vec![Script::Serve], hellos.clone()).await;
    let cfg = LinkConfig::new(url, COL, Some(DEV));
    let (source, epoch) = epoch_source();
    let generation = Generation::begin(source);
    let (_tx, mut calls) = mpsc::channel(2);
    let budget = Arc::new(tokio::sync::Semaphore::new(1));
    let events = |e: Event| match e {
        Event::Proof { reply, .. } => {
            epoch.store(2, Ordering::SeqCst);
            let _ = reply.send(Some([0; 64]));
        }
        _ => panic!("stale proof must not bind/deliver"),
    };
    retry(
        session(&cfg, &generation, &mut calls, &budget, &events).await,
        "stale proof completion",
    );
    assert!(hellos.lock().unwrap().is_empty());
}
#[tokio::test]
async fn changed_source_after_hello_receive_never_emits_up() {
    let (source, epoch) = epoch_source();
    let generation = Generation::begin(source);
    let (tx, mut rx) = mpsc::channel(1);
    let entered = Notify::new();
    let mut stream = futures_util::stream::poll_fn(|cx| {
        entered.notify_one();
        rx.poll_recv(cx)
    });
    let (answer, ()) = tokio::join!(hello_answer(&mut stream, &generation), async {
        entered.notified().await;
        epoch.store(2, Ordering::SeqCst);
        let response = LsFrame::Response(LsResponse {
            id: HELLO_ID,
            result: Some(Cbor::Map(vec![])),
            error: None,
        });
        tx.send(Ok(Message::Binary(response.to_bytes().unwrap().into())))
            .await
            .unwrap();
    });
    let Err(Ended::Retry(reason)) = answer else {
        panic!("must reject stale authenticated-hello completion")
    };
    assert_eq!(reason, "stale hello receive");
}
#[tokio::test]
async fn stale_up_handback_is_retired_before_any_push_delivery() {
    let hellos = Arc::new(Mutex::new(Vec::new()));
    let cfg = LinkConfig::new(
        peer(vec![Script::Serve], hellos.clone()).await,
        COL,
        Some(DEV),
    );
    let (source, epoch) = epoch_source();
    let generation = Generation::begin(source);
    let (_tx, mut calls) = mpsc::channel(2);
    let budget = Arc::new(tokio::sync::Semaphore::new(1));
    let downs = AtomicUsize::new(0);
    let events = |e: Event| match e {
        Event::Proof { reply, .. } => {
            let _ = reply.send(Some([0; 64]));
        }
        Event::Up { generation, reply } => {
            let session = binding(generation).0;
            epoch.store(2, Ordering::SeqCst);
            let _ = reply.send(Some(session));
        }
        Event::Down(s) => {
            assert!(s.check().is_err());
            downs.fetch_add(1, Ordering::SeqCst);
        }
        _ => panic!("stale Up may not deliver reply/push"),
    };
    retry(
        session(&cfg, &generation, &mut calls, &budget, &events).await,
        "stale session handback",
    );
    assert_eq!(downs.load(Ordering::SeqCst), 1);
    assert_eq!(hellos.lock().unwrap().len(), 1);
}
#[tokio::test]
async fn wrong_generation_handback_cannot_retire_an_unrelated_session() {
    let cfg = LinkConfig::new(
        peer(vec![Script::Serve], Arc::new(Mutex::new(Vec::new()))).await,
        COL,
        Some(DEV),
    );
    let (source, _) = epoch_source();
    let generation = Generation::begin(source);
    let unrelated = binding(Generation::begin(tokens())).0;
    let (_tx, mut calls) = mpsc::channel(2);
    let budget = Arc::new(tokio::sync::Semaphore::new(1));
    let events = |e: Event| match e {
        Event::Proof { reply, .. } => {
            let _ = reply.send(Some([0; 64]));
        }
        Event::Up { reply, .. } => {
            let _ = reply.send(Some(unrelated.clone()));
        }
        _ => panic!("must not deliver or retire unrelated binding"),
    };
    retry(
        session(&cfg, &generation, &mut calls, &budget, &events).await,
        "wrong session handback",
    );
    assert!(unrelated.check().is_ok());
}
#[tokio::test]
async fn changed_source_after_inbound_budget_await_cannot_deliver() {
    let (source, epoch) = epoch_source();
    let generation = Generation::begin(source);
    let budget = Arc::new(tokio::sync::Semaphore::new(1));
    let held = budget.clone().acquire_owned().await.unwrap();
    let (result, ()) = tokio::join!(inbound_share(&generation, &budget, 1), async {
        assert_eq!(budget.available_permits(), 0);
        assert!(generation.check().is_ok());
        epoch.store(2, Ordering::SeqCst);
        drop(held);
    });
    let Err(Ended::Retry(reason)) = result else {
        panic!("stale frame must not get a delivery permit")
    };
    assert_eq!(reason, "stale budget completion");
    assert_eq!(budget.available_permits(), 1);
}

#[test]
fn retirement_and_expiry_deny_even_a_still_current_source() {
    let generation = Generation::begin(tokens());
    let guard = RetireOnDrop(generation.clone());
    assert!(generation.check().is_ok());
    drop(guard);
    assert!(generation.check().is_err());
    let expired = Generation::begin(tokens());
    expired.token_expiry(now_ms());
    assert!(expired.check().is_err());
}
