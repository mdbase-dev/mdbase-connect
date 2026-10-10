//! The transport against an in-test log peer: hello with nonce and proof, call and
//! reply correlation, pushes, loss of a call in flight, reconnect, refused tokens.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use mdbn_wire::cbor::Cbor;
use mdbn_wire::common::B16;
use mdbn_wire::log_service::{LsError, LsFrame, LsHelloParams, LsPush, LsResponse};
use mdbn_wire::schema::Wire;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};

use super::*;

const NONCE: [u8; 32] = [7; 32];
const COL: B16 = B16([0x0c; 16]);
const DEV: B16 = B16([0x0d; 16]);

struct Tokens {
    issued: AtomicUsize,
    refused: AtomicUsize,
}

impl TokenSource for Tokens {
    fn token(&self) -> Pin<Box<dyn Future<Output = Result<Token, String>> + Send + '_>> {
        let n = self.issued.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            Ok(Token {
                token: format!("token-{n}").into(),
                expires_at_ms: now_ms() + 15 * 60_000,
            })
        })
    }
    fn refused(&self) {
        self.refused.fetch_add(1, Ordering::SeqCst);
    }
    fn current(&self) -> Result<(), String> {
        Ok(())
    } // synthetic loopback source
}

/// What the peer does with each connection, in order.
#[derive(Clone, Copy)]
enum Script {
    /// Accept the hello; answer every call; push once; then hold.
    Serve,
    /// Accept the hello; take one call and drop the connection without answering.
    DropAfterCall,
    /// Refuse the hello as unauthenticated.
    Refuse,
    /// Accept the hello, then never answer anything.
    Silent,
}

async fn peer(scripts: Vec<Script>, hellos: Arc<Mutex<Vec<LsHelloParams>>>) -> String {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move {
        for script in scripts {
            let (tcp, _) = l.accept().await.unwrap();
            #[allow(clippy::result_large_err)] // tungstenite's callback signature
            let add_nonce = |_: &Request, mut r: Response| {
                r.headers_mut().insert(
                    "x-mdbase-nonce",
                    crate::secrets::hex(&NONCE).parse().unwrap(),
                );
                Ok(r)
            };
            let ws = tokio_tungstenite::accept_hdr_async(tcp, add_nonce)
                .await
                .unwrap();
            let (mut tx, mut rx) = ws.split();
            let Some(Ok(Message::Binary(b))) = rx.next().await else {
                continue;
            };
            let Ok(LsFrame::Request(hello)) = LsFrame::from_bytes(&b) else {
                continue;
            };
            hellos
                .lock()
                .unwrap()
                .push(LsHelloParams::from_cbor(&hello.params).unwrap());
            let ok = |id, result: Option<Cbor>, error: Option<LsError>| {
                Message::Binary(
                    LsFrame::Response(LsResponse { id, result, error })
                        .to_bytes()
                        .unwrap()
                        .into(),
                )
            };
            if let Script::Refuse = script {
                let e = LsError {
                    code: "unauthenticated".into(),
                    reason: None,
                    message: None,
                    retry_after_ms: None,
                    details: None,
                };
                let _ = tx.send(ok(hello.id, None, Some(e))).await;
                continue;
            }
            tx.send(ok(hello.id, Some(Cbor::Map(vec![])), None))
                .await
                .unwrap();
            match script {
                Script::Silent => while rx.next().await.is_some() {},
                Script::DropAfterCall => {
                    let _ = rx.next().await;
                    drop(tx);
                    drop(rx);
                }
                _ => {
                    let push = LsFrame::Push(LsPush {
                        kind: "head".into(),
                        payload: Cbor::Map(vec![]),
                    });
                    tx.send(Message::Binary(push.to_bytes().unwrap().into()))
                        .await
                        .unwrap();
                    while let Some(Ok(Message::Binary(b))) = rx.next().await {
                        if let Ok(LsFrame::Request(r)) = LsFrame::from_bytes(&b) {
                            tx.send(ok(r.id, Some(Cbor::Uint(r.id)), None))
                                .await
                                .unwrap();
                        }
                    }
                }
            }
        }
    });
    format!("http://{addr}")
}

struct Recording {
    tags: Mutex<Vec<String>>,
    binding: Mutex<Option<(Session, LogReplyScope)>>,
}
impl Recording {
    fn lock(&self) -> std::sync::LockResult<std::sync::MutexGuard<'_, Vec<String>>> {
        self.tags.lock()
    }
}
type Seen = Arc<Recording>;

/// Genuine opaque identities from a synthetic Replica. The old transport-wire
/// fixtures deliberately choose their wire IDs; these are NOT actor/prefix tests.
fn binding(generation: Generation) -> (Session, LogReplyScope) {
    let mut r = fixture_replica();
    let auth = r
        .bind_authenticated_log(mdbn_replica::log::EndpointId(1), COL)
        .unwrap();
    r.tick();
    let scope = r.take_authenticated_log_calls(&auth).unwrap().remove(0).1;
    (Session::bind(generation, auth), scope)
}
pub(crate) fn fixture_replica() -> mdbn_replica::Replica<mdbn_replica::mem::MemStore> {
    use mdbn_replica::replica::{Host, ReplicaConfig, UtcOnly};
    struct Now;
    impl mdbn_core::host::Clock for Now {
        fn now_ms(&self) -> u64 {
            crate::fsutil::now_ms() as u64
        }
    }
    struct Random;
    impl mdbn_core::host::Entropy for Random {
        fn fill(&mut self, bytes: &mut [u8]) {
            getrandom::fill(bytes).unwrap();
        }
    }
    impl mdbn_replica::crypto::CsprngEntropy for Random {}
    mdbn_replica::Replica::open(
        ReplicaConfig {
            collection: COL,
            replica_id: B16([2; 16]),
            device_id: DEV,
            mode: mdbn_wire::client::SyncMode::Synced,
            log_endpoint: mdbn_replica::log::EndpointId(1),
            verify: false,
            runtime_version: "transport-test".into(),
            trusted_roots: vec![],
            trusted_signers: vec![],
            e2e: false,
            user_enabled_cloud_copy: false,
            chosen_state: None,
            expected_genesis: None,
            key_grants_only: false,
            policy_pins: None,
        },
        mdbn_replica::mem::MemStore::new(),
        Box::new(mdbn_replica::CorePlanner),
        Box::new(mdbn_replica::seal::KeyringSealer::new(
            COL, DEV, &[1; 32], &[2; 32],
        )),
        Host {
            clock: Box::new(Now),
            entropy: Box::new(Random),
            zones: Box::new(UtcOnly),
        },
        mdbn_replica::DeviceSecrets {
            sign_sk: [1; 32],
            kem_sk: [2; 32],
        },
    )
    .unwrap()
}
fn recording() -> Seen {
    Arc::new(Recording {
        tags: Mutex::new(Vec::new()),
        binding: Mutex::new(None),
    })
}

// A synthetic captured account epoch seam, never supplied by a wire peer.
struct EpochSource {
    epoch: Arc<AtomicUsize>,
}
impl TokenSource for EpochSource {
    fn token(&self) -> Pin<Box<dyn Future<Output = Result<Token, String>> + Send + '_>> {
        Box::pin(async {
            Ok(Token {
                token: Zeroizing::new("synthetic".into()),
                expires_at_ms: now_ms() + 900_000,
            })
        })
    }
    fn current(&self) -> Result<(), String> {
        if self.epoch.load(Ordering::SeqCst) == 1 {
            Ok(())
        } else {
            Err("captured epoch changed".into())
        }
    }
}
pub(crate) fn epoch_source() -> (Arc<dyn TokenSource>, Arc<AtomicUsize>) {
    let epoch = Arc::new(AtomicUsize::new(1));
    (
        Arc::new(EpochSource {
            epoch: epoch.clone(),
        }),
        epoch,
    )
}
#[path = "logwire_direct_tests.rs"]
mod direct;
#[path = "logwire_race_tests.rs"]
mod races;

/// Events seen, with the proof answered as `nonce ‖ zeros` (a stand-in signature).
fn sink() -> (Box<dyn Fn(Event) + Send>, Seen) {
    let seen = recording();
    let s = seen.clone();
    let f = move |e: Event| {
        let tag = match e {
            Event::Proof { nonce, reply, .. } => {
                let mut sig = [0u8; 64];
                sig[..32].copy_from_slice(&nonce);
                let _ = reply.send(Some(sig));
                "proof".to_string()
            }
            Event::Up { generation, reply } => {
                let (session, scope) = binding(generation);
                *s.binding.lock().unwrap() = Some((session.clone(), scope));
                let _ = reply.send(Some(session));
                "up".into()
            }
            Event::Down(_) => "down".into(),
            Event::Reply {
                id, method, bytes, ..
            } => {
                let Ok(LsFrame::Response(r)) = LsFrame::from_bytes(&bytes) else {
                    panic!("reply frame")
                };
                assert_eq!(r.result, Some(Cbor::Uint(id)));
                format!("reply {id} {method}")
            }
            Event::Lost { id, .. } => format!("lost {id}"),
            Event::Offline { id, .. } => format!("offline {id}"),
            Event::Push(..) => "push".into(),
        };
        s.lock().unwrap().push(tag);
    };
    (Box::new(f), seen)
}

fn request(id: u64, seen: &Seen) -> Outbound {
    let (session, scope) = seen
        .binding
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_else(|| binding(Generation::begin(tokens())));
    Outbound {
        scope,
        session,
        id,
        method: "head".into(),
        frame: LsFrame::Request(mdbn_wire::log_service::LsRequest {
            id,
            method: "head".into(),
            params: Cbor::Map(vec![]),
        })
        .to_bytes()
        .unwrap(),
        object: None,
    }
}

async fn until(seen: &Seen, what: &str) {
    for _ in 0..200 {
        if seen.lock().unwrap().iter().any(|s| s == what) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("never saw {what}: {:?}", seen.lock().unwrap());
}

fn tokens() -> Arc<Tokens> {
    Arc::new(Tokens {
        issued: AtomicUsize::new(0),
        refused: AtomicUsize::new(0),
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn hello_then_calls_replies_and_pushes() {
    let hellos = Arc::new(Mutex::new(Vec::new()));
    let url = peer(vec![Script::Serve], hellos.clone()).await;
    let (events, seen) = sink();
    let link = Link::spawn(
        LinkConfig {
            inbound_budget: INBOUND_BUDGET,
            ..LinkConfig::new(url, COL, Some(DEV))
        },
        tokens(),
        events,
    )
    .unwrap();
    until(&seen, "up").await;
    assert!(link.send(request(5, &seen)));
    until(&seen, "reply 5 head").await;
    until(&seen, "push").await;
    let h = hellos.lock().unwrap()[0].clone();
    assert_eq!(h.token, "token-0");
    assert_eq!(h.device, Some(DEV));
    assert_eq!(
        &h.sig.0[..32],
        &NONCE,
        "the replica's proof over the server nonce"
    );
    assert_eq!(seen.lock().unwrap()[0], "proof");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_call_in_flight_is_lost_then_the_link_reconnects() {
    let hellos = Arc::new(Mutex::new(Vec::new()));
    let url = peer(vec![Script::DropAfterCall, Script::Serve], hellos.clone()).await;
    let (events, seen) = sink();
    let link = Link::spawn(
        LinkConfig {
            inbound_budget: INBOUND_BUDGET,
            ..LinkConfig::new(url, COL, Some(DEV))
        },
        tokens(),
        events,
    )
    .unwrap();
    until(&seen, "up").await;
    assert!(link.send(request(9, &seen)));
    until(&seen, "lost 9").await;
    // While down, calls are answered offline at once.
    assert!(link.send(request(10, &seen)));
    until(&seen, "offline 10").await;
    for _ in 0..200 {
        if seen.lock().unwrap().iter().filter(|s| *s == "up").count() == 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert_eq!(
        seen.lock().unwrap().iter().filter(|s| *s == "up").count(),
        2
    );
    assert!(link.send(request(11, &seen)));
    until(&seen, "reply 11 head").await;
    let order: Vec<String> = seen.lock().unwrap().clone();
    let lost = order.iter().position(|s| s == "lost 9").unwrap();
    assert_eq!(order[lost - 1], "down", "down precedes the lost calls");
    assert_eq!(
        hellos.lock().unwrap()[1].token,
        "token-1",
        "a fresh token per session"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refused_token_is_dropped_and_renewed() {
    let hellos = Arc::new(Mutex::new(Vec::new()));
    let url = peer(vec![Script::Refuse, Script::Serve], hellos.clone()).await;
    let (events, seen) = sink();
    let t = tokens();
    let _link = Link::spawn(
        LinkConfig {
            inbound_budget: INBOUND_BUDGET,
            ..LinkConfig::new(url, COL, Some(DEV))
        },
        t.clone(),
        events,
    )
    .unwrap();
    until(&seen, "up").await;
    assert_eq!(t.refused.load(Ordering::SeqCst), 1);
    assert_eq!(hellos.lock().unwrap().len(), 2);
}

#[test]
fn ws_url_requires_tls_off_loopback() {
    let c = B16([0xab; 16]);
    assert_eq!(
        ws_url("https://log.example.dev", &c).unwrap(),
        format!("wss://log.example.dev/v1/ws?c={}", c.to_uuid_string())
    );
    assert!(
        ws_url("http://127.0.0.1:8787/x", &c)
            .unwrap()
            .starts_with("ws://127.0.0.1:8787/v1/ws?c=")
    );
    assert!(ws_url("http://log.example.dev", &c).is_err());
    assert!(ws_url("ftp://log.example.dev", &c).is_err());
    assert!(ws_url("https://user@log.example.dev", &c).is_err());
}

#[test]
fn debug_never_shows_the_token_or_frames() {
    let (reply, _rx) = tokio::sync::oneshot::channel();
    let e = Event::Proof {
        nonce: [1; 32],
        token: Zeroizing::new("secret-token-value".into()),
        generation: Generation::begin(tokens()),
        reply,
    };
    assert!(!format!("{e:?}").contains("secret-token-value"));
    let e = Event::Push(
        b"frame-bytes".to_vec(),
        Budget::none(),
        binding(Generation::begin(tokens())).0,
    );
    assert!(!format!("{e:?}").contains("frame-bytes"));
    let t = Token {
        token: Zeroizing::new("secret-token-value".into()),
        expires_at_ms: 1,
    };
    assert!(!format!("{t:?}").contains("secret-token-value"));
}

/// A peer that pushes `n` frames after the hello.
async fn pusher(n: usize) -> String {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move {
        let (tcp, _) = l.accept().await.unwrap();
        #[allow(clippy::result_large_err)] // tungstenite's callback signature
        let add_nonce = |_: &Request, mut r: Response| {
            r.headers_mut().insert(
                "x-mdbase-nonce",
                crate::secrets::hex(&NONCE).parse().unwrap(),
            );
            Ok(r)
        };
        let ws = tokio_tungstenite::accept_hdr_async(tcp, add_nonce)
            .await
            .unwrap();
        let (mut tx, mut rx) = ws.split();
        let Some(Ok(Message::Binary(b))) = rx.next().await else {
            return;
        };
        let Ok(LsFrame::Request(hello)) = LsFrame::from_bytes(&b) else {
            return;
        };
        let ok = LsFrame::Response(LsResponse {
            id: hello.id,
            result: Some(Cbor::Map(vec![])),
            error: None,
        });
        tx.send(Message::Binary(ok.to_bytes().unwrap().into()))
            .await
            .unwrap();
        for _ in 0..n {
            let push = LsFrame::Push(LsPush {
                kind: "head".into(),
                payload: Cbor::Map(vec![]),
            });
            if tx
                .send(Message::Binary(push.to_bytes().unwrap().into()))
                .await
                .is_err()
            {
                return;
            }
        }
        while rx.next().await.is_some() {}
    });
    format!("http://{addr}")
}

#[tokio::test(flavor = "multi_thread")]
async fn a_slow_runtime_back_pressures_the_socket() {
    let url = pusher(10).await;
    let held: Arc<Mutex<Vec<Event>>> = Arc::new(Mutex::new(Vec::new()));
    let total = Arc::new(AtomicUsize::new(0));
    let (h, t) = (held.clone(), total.clone());
    let _link = Link::spawn(
        LinkConfig {
            inbound_budget: 2 * FRAME_UNIT,
            ..LinkConfig::new(url, COL, Some(DEV))
        },
        tokens(),
        Box::new(move |e| match e {
            Event::Proof { reply, .. } => {
                let _ = reply.send(Some([0; 64]));
            }
            Event::Up { generation, reply } => {
                let _ = reply.send(Some(binding(generation).0));
            }
            Event::Push(..) => {
                t.fetch_add(1, Ordering::SeqCst);
                h.lock().unwrap().push(e);
            }
            _ => {}
        }),
    )
    .unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(
        total.load(Ordering::SeqCst),
        2,
        "only the budget's worth is handed over"
    );
    // The runtime handles them (drops the events, releasing the budget): the rest follow.
    for _ in 0..100 {
        held.lock().unwrap().clear();
        if total.load(Ordering::SeqCst) == 10 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(total.load(Ordering::SeqCst), 10);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_call_queue_is_bounded() {
    // A peer that accepts TCP but never completes the upgrade: nothing is drained.
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move {
        let _held = l.accept().await.unwrap();
        tokio::time::sleep(Duration::from_secs(60)).await;
    });
    let link = Link::spawn(
        LinkConfig {
            inbound_budget: INBOUND_BUDGET,
            ..LinkConfig::new(format!("http://{addr}"), COL, Some(DEV))
        },
        tokens(),
        Box::new(|_| {}),
    )
    .unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    let accepted = (0..MAX_QUEUED_CALLS as u64 + 10)
        .filter(|i| link.send(request(*i + 1, &recording())))
        .count();
    assert_eq!(accepted, MAX_QUEUED_CALLS);
}

#[tokio::test(flavor = "multi_thread")]
async fn queued_and_unanswered_calls_share_a_byte_budget() {
    // A peer that accepts TCP but never completes the upgrade: nothing drains.
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move {
        let _held = l.accept().await.unwrap();
        tokio::time::sleep(Duration::from_secs(60)).await;
    });
    let link = Link::spawn(
        LinkConfig {
            outbound_budget: 2 * FRAME_UNIT,
            ..LinkConfig::new(format!("http://{addr}"), COL, Some(DEV))
        },
        tokens(),
        Box::new(|_| {}),
    )
    .unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(link.send(request(1, &recording())));
    assert!(link.send(request(2, &recording())));
    assert!(
        !link.send(request(3, &recording())),
        "the budget is spent until calls are answered"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unanswered_call_ends_the_session_and_is_lost() {
    let hellos = Arc::new(Mutex::new(Vec::new()));
    let url = peer(vec![Script::Silent, Script::Serve], hellos.clone()).await;
    let (events, seen) = sink();
    let link = Link::spawn(
        LinkConfig {
            call_timeout: Duration::from_millis(300),
            ..LinkConfig::new(url, COL, Some(DEV))
        },
        tokens(),
        events,
    )
    .unwrap();
    until(&seen, "up").await;
    assert!(link.send(request(7, &seen)));
    until(&seen, "lost 7").await;
    for _ in 0..200 {
        if seen.lock().unwrap().iter().filter(|s| *s == "up").count() == 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(link.send(request(8, &seen)));
    until(&seen, "reply 8 head").await;
}
