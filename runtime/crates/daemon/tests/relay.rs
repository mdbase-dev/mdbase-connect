//! The relay client against a fake Connect server on loopback: inventory, hello,
//! device bind, a verified grant feed, a Noise pipe, and fail-closed on lease loss.
#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    clippy::result_large_err
)]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use mdbn_daemon::access::CachedGrant;
use mdbn_daemon::attest::test_signer::Signer;
use mdbn_daemon::cloud::{Cloud, CloudConfig};
use mdbn_daemon::relay::{self, RelayHost};
use mdbn_daemon::secrets::{self, DeviceIdentity, MemoryStore, SecretStore};
use mdbn_daemon::session::{Auth, BoxFuture, Handler, Opened, Prologue, problem_response};
use mdbn_wire::Wire;
use mdbn_wire::cbor::Cbor;
use mdbn_wire::client::{ClientFrame, ClientRequest};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_tungstenite::tungstenite::Message;

const CONNECTOR: &str = "01900000-0000-7000-8000-0000000000c1";
const COLLECTION: &str = "01900000-0000-7000-8000-0000000000aa";
const GRANT: &str = "01900000-0000-7000-8000-0000000000bb";

struct Host {
    applied: Mutex<Vec<(String, Vec<CachedGrant>, u64)>>,
    live: AtomicBool,
    serving: Mutex<Option<Vec<String>>>,
    opened: Mutex<Vec<(Prologue, Auth)>>,
    online: AtomicBool,
    /// While true, `commit_feed` does not return (a collection busy opening).
    hold_commit: tokio::sync::watch::Sender<bool>,
    /// While true, grant checks do not return (a parked collection actor).
    hold_grants: tokio::sync::watch::Sender<bool>,
}

impl Default for Host {
    fn default() -> Self {
        Host {
            applied: Default::default(),
            live: Default::default(),
            serving: Default::default(),
            opened: Default::default(),
            online: Default::default(),
            hold_commit: tokio::sync::watch::channel(false).0,
            hold_grants: tokio::sync::watch::channel(false).0,
        }
    }
}

async fn released(hold: &tokio::sync::watch::Sender<bool>) {
    let _ = hold.subscribe().wait_for(|held| !held).await;
}

impl Handler for Host {
    fn open<'a>(&'a self, p: Prologue, auth: Auth, hello: ClientRequest) -> BoxFuture<'a, Opened> {
        Box::pin(async move {
            self.opened.lock().unwrap().push((p, auth));
            Opened {
                response: problem_response(hello.id, "unavailable", "runtime_pending", "test"),
                session: None,
            }
        })
    }
}

impl RelayHost for Host {
    fn inventory(&self) -> BoxFuture<'_, Vec<(String, Value)>> {
        Box::pin(async { vec![(COLLECTION.to_string(), json!({ "id": COLLECTION }))] })
    }
    fn policy_cursor(&self) -> BoxFuture<'_, Option<mdbn_daemon::access::FeedCursor>> {
        Box::pin(async { None })
    }
    fn commit_feed<'a>(
        &'a self,
        snapshot: &'a relay::Snapshot,
        grants: &'a std::collections::BTreeMap<String, Vec<CachedGrant>>,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            released(&self.hold_commit).await;
            let g = grants.get(COLLECTION).cloned().unwrap_or_default();
            self.live.store(!g.is_empty(), Ordering::SeqCst);
            self.applied.lock().unwrap().push((
                COLLECTION.to_string(),
                g,
                snapshot.lease_expires_ms,
            ));
            Ok(())
        })
    }
    fn grant_live<'a>(&'a self, _c: &'a str, _g: &'a str) -> BoxFuture<'a, bool> {
        Box::pin(async move {
            released(&self.hold_grants).await;
            self.live.load(Ordering::SeqCst)
        })
    }
    fn grant_refusal<'a>(&'a self, _c: &'a str, _g: &'a str) -> BoxFuture<'a, Option<String>> {
        Box::pin(async move {
            released(&self.hold_grants).await;
            (!self.live.load(Ordering::SeqCst)).then(|| "grant_inactive".into())
        })
    }
    fn set_online(&self, online: bool) {
        self.online.store(online, Ordering::SeqCst);
    }
    fn serving_collections(&self) -> BoxFuture<'_, Option<Vec<String>>> {
        let serving = self.serving.lock().unwrap().clone();
        Box::pin(async move { serving })
    }
}

fn sign(sk: &Signer, msg: &[u8]) -> String {
    sk.sign(msg)
}

/// A grant entry with a valid binding and an attested Noise key.
fn grant_entry(client_pk: &[u8; 32]) -> Value {
    let fx: Value =
        serde_json::from_str(include_str!("fixtures/application-authorization-v4.json")).unwrap();
    let inst = Signer::from_scalar(
        fx["installation_signing_private_key"].as_str().unwrap(),
        fx["binding"]["installation_signing_public_key"]
            .as_str()
            .unwrap(),
    );
    let grant_sk = Signer::random();
    let mut binding: mdbn_daemon::attest::Binding =
        serde_json::from_value(fx["binding"].clone()).unwrap();
    binding.grant_signing_public_key = grant_sk.public_b64();
    let sig = sign(&inst, &binding.signing_message().unwrap());
    let auth_id = mdbn_daemon::attest::uuid_bytes(&binding.authorization_id).unwrap();
    let att = sign(
        &grant_sk,
        &mdbn_daemon::attest::attestation_message(&auth_id, client_pk),
    );
    json!({
        "id": GRANT,
        "account_id": "11111111-1111-4111-8111-111111111111",
        "application_id": binding.application_id,
        "application_name": "Reader",
        "collection_id": COLLECTION,
        "operations": ["read"],
        "capabilities": ["read"],
        "client_pk": secrets::hex(client_pk),
        "client_key_signature": att,
        "application_authorization": { "binding": binding, "signature": sig },
    })
}

fn snapshot(seq: u64, grants: Vec<Value>) -> Value {
    snapshot_for(seq, grants, 55_000)
}

fn snapshot_for(seq: u64, grants: Vec<Value>, lease_ms: u64) -> Value {
    let now = mdbn_daemon::fsutil::now_ms() as u64;
    let (issued, expires) = (now, now + lease_ms);
    json!({
        "type": "policy_snapshot", "protocol_version": 1, "request_id": format!("r{seq}"),
        "revision": relay::revision(CONNECTOR, seq, issued, expires, &grants),
        "connector_id": CONNECTOR, "sequence": seq,
        "lease_issued_at_ms": issued, "lease_expires_at_ms": expires, "grants": grants
    })
}

async fn read_http(s: &mut tokio::net::TcpStream) -> String {
    let mut buf = Vec::new();
    let mut b = [0u8; 4096];
    loop {
        let n = s.read(&mut b).await.unwrap();
        buf.extend_from_slice(&b[..n]);
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&buf[..i]).to_string();
            let len: usize = head
                .lines()
                .find_map(|l| {
                    l.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .map(|v| v.trim().parse().unwrap())
                })
                .unwrap_or(0);
            while buf.len() < i + 4 + len {
                let n = s.read(&mut b).await.unwrap();
                buf.extend_from_slice(&b[..n]);
            }
            return head;
        }
        if n == 0 {
            return String::new();
        }
    }
}

type Socket = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>;

/// A relay session against the fake server, bound and with pipes enabled.
struct Session {
    ws: Socket,
    identity: Arc<DeviceIdentity>,
    stop: tokio::sync::watch::Sender<bool>,
    daemon: tokio::task::JoinHandle<relay::Ended>,
}

fn text(m: Message) -> Value {
    serde_json::from_str(m.to_text().unwrap()).unwrap()
}

impl Session {
    async fn next(&mut self) -> Value {
        text(self.ws.next().await.unwrap().unwrap())
    }

    /// The next text message, which must arrive within `wait`.
    async fn within(&mut self, wait: Duration, what: &str) -> Value {
        tokio::time::timeout(wait, self.next())
            .await
            .unwrap_or_else(|_| panic!("the relay did not answer in time: {what}"))
    }

    async fn send(&mut self, v: Value) {
        self.ws.send(Message::text(v.to_string())).await.unwrap();
    }

    async fn stop(self) {
        self.stop.send(true).unwrap();
        let _ = tokio::time::timeout(Duration::from_secs(5), self.daemon).await;
    }
}

async fn connect(host: Arc<Host>) -> Session {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = format!("http://127.0.0.1:{port}");

    let keys = MemoryStore::default();
    keys.set(
        mdbn_daemon::cloud::CONNECTOR_TOKEN,
        b"con_test_token_000000000000",
    )
    .unwrap();
    let identity = Arc::new(DeviceIdentity::generate().unwrap());
    let device_pub = identity.public();
    let tls = mdbn_daemon::cloud::tls_config().unwrap();
    let cloud = Arc::new(Cloud::new(&tls, &server, &keys).unwrap());
    let cfg = CloudConfig {
        schema_version: 1,
        server_url: server.clone(),
        connector_id: Some(CONNECTOR.into()),
        device_registered: true,
        ..Default::default()
    };
    let (stop, stop_rx) = tokio::sync::watch::channel(false);
    let h2 = host.clone();
    let id2 = identity.clone();
    let daemon = tokio::spawn(async move { relay::run(h2, cloud, cfg, id2, stop_rx).await });

    // 1. Inventory POST.
    let (mut s, _) = listener.accept().await.unwrap();
    let head = read_http(&mut s).await;
    assert!(head.starts_with("POST /v1/connectors/sync"), "{head}");
    assert!(
        head.to_ascii_lowercase()
            .contains("authorization: bearer con_test_token")
    );
    s.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}")
        .await
        .unwrap();
    drop(s);

    // 2. The relay upgrade.
    let (s, _) = listener.accept().await.unwrap();
    let mut ws = tokio_tungstenite::accept_hdr_async(
        s,
        |req: &tokio_tungstenite::tungstenite::handshake::server::Request, resp| {
            assert_eq!(req.uri().path(), "/v1/relay");
            assert!(
                req.headers()
                    .get("authorization")
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .starts_with("Bearer con_")
            );
            Ok(resp)
        },
    )
    .await
    .unwrap();
    let hello = text(ws.next().await.unwrap().unwrap());
    assert_eq!(hello["type"], "relay_hello");
    let serving = host.serving.lock().unwrap().clone();
    assert_eq!(
        hello.get("serving_collections").cloned(),
        serving.map(|c| json!(c))
    );
    assert!(
        hello["capabilities"]
            .as_array()
            .unwrap()
            .contains(&json!("noise_pipe_v1"))
    );
    let nonce = [5u8; 32];
    ws.send(Message::text(json!({"type":"relay_welcome","protocol_version":1,"session_id":"17","capabilities":[],"contract_support":{},"device_nonce": secrets::hex(&nonce)}).to_string())).await.unwrap();

    // 3. device_bind verifies under the device key.
    let bind = text(ws.next().await.unwrap().unwrap());
    assert_eq!(bind["type"], "device_bind");
    assert_eq!(bind["device_id"], device_pub.device);
    let digest = secrets::domain_hash(
        "mdbase/v1/relay-device",
        &[
            &mdbn_daemon::attest::uuid_bytes(CONNECTOR).unwrap(),
            b"17",
            &nonce,
        ],
    );
    let vk = ed25519_dalek::VerifyingKey::from_bytes(
        &secrets::hex_decode(&device_pub.sign_pk)
            .unwrap()
            .try_into()
            .unwrap(),
    )
    .unwrap();
    let sig = ed25519_dalek::Signature::from_slice(
        &secrets::hex_decode(bind["sig"].as_str().unwrap()).unwrap(),
    )
    .unwrap();
    vk.verify_strict(&digest, &sig).unwrap();
    ws.send(Message::text(
        json!({"type":"device_bound","device_id":device_pub.device,"noise_pipes":true}).to_string(),
    ))
    .await
    .unwrap();

    Session {
        ws,
        identity,
        stop,
        daemon,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn relay_feed_and_pipe() {
    let host = Arc::new(Host::default());
    *host.serving.lock().unwrap() = Some(vec![COLLECTION.to_string()]);
    let mut session = connect(host.clone()).await;
    let identity = session.identity.clone();
    let device_pub = identity.public();
    let ws = &mut session.ws;
    let client_sk = [42u8; 32];
    let client_pk = mdbn_daemon::noise::public_key(&client_sk);

    // 4. The feed: one attested grant, one with a substituted key (dropped).
    let mut bad = grant_entry(&client_pk);
    bad["id"] = json!("01900000-0000-7000-8000-0000000000cc");
    bad["client_pk"] = json!(secrets::hex(&mdbn_daemon::noise::public_key(&[1u8; 32])));
    ws.send(Message::text(
        snapshot(3, vec![grant_entry(&client_pk), bad]).to_string(),
    ))
    .await
    .unwrap();
    let ack = text(ws.next().await.unwrap().unwrap());
    assert_eq!(
        (ack["type"].as_str(), ack["ok"].as_bool()),
        (Some("policy_applied"), Some(true)),
        "{ack}"
    );
    {
        let applied = host.applied.lock().unwrap();
        let (c, grants, _) = applied.last().unwrap();
        assert_eq!(c, COLLECTION);
        assert_eq!(grants.len(), 1, "the substituted key is dropped");
        assert_eq!(grants[0].client_pk, secrets::hex(&client_pk));
        assert!(!grants[0].legacy_only);
    }
    // A replayed older snapshot is refused.
    ws.send(Message::text(snapshot(2, vec![]).to_string()))
        .await
        .unwrap();
    let ack = text(ws.next().await.unwrap().unwrap());
    assert_eq!(ack["ok"], false);
    assert_eq!(ack["error"]["code"], "stale_policy");

    // 5. A nil-grant pipe is refused without a handshake.
    let pipe0 = "01900000-0000-7000-8000-000000000100";
    ws.send(Message::text(json!({"type":"pipe_open","pipe_id":pipe0,"collection_id":COLLECTION,"grant_id":"00000000-0000-0000-0000-000000000000"}).to_string())).await.unwrap();
    let close = text(ws.next().await.unwrap().unwrap());
    assert_eq!(
        (close["type"].as_str(), close["reason"].as_str()),
        (Some("pipe_close"), Some("unauthenticated"))
    );

    // 6. A real pipe: Noise IK with the prologue from pipe_open.
    let pipe = "01900000-0000-7000-8000-000000000101";
    let pid = mdbn_daemon::attest::uuid_bytes(pipe).unwrap();
    ws.send(Message::text(
        json!({"type":"pipe_open","pipe_id":pipe,"collection_id":COLLECTION,"grant_id":GRANT})
            .to_string(),
    ))
    .await
    .unwrap();
    let prologue = mdbn_daemon::pipes::prologue(
        &mdbn_daemon::attest::uuid_bytes(COLLECTION).unwrap(),
        &mdbn_daemon::attest::uuid_bytes(GRANT).unwrap(),
        &identity.device_id,
    );
    let mut ini = mdbn_daemon::noise::Initiator::new(
        &client_sk,
        &secrets::hex_decode(&device_pub.noise_pk)
            .unwrap()
            .try_into()
            .unwrap(),
        &prologue,
    );
    let hello = ClientFrame::Request(ClientRequest {
        id: 0,
        method: "hello".into(),
        params: Cbor::Null,
    });
    let m1 = ini
        .write_message_1(&[3u8; 32], &hello.to_bytes().unwrap())
        .unwrap();
    ws.send(Message::binary(mdbn_daemon::pipes::data_frame(&pid, &m1)))
        .await
        .unwrap();
    let m2 = match ws.next().await.unwrap().unwrap() {
        Message::Binary(b) => b,
        other => panic!("{other:?}"),
    };
    let (id, payload) = mdbn_daemon::pipes::parse_frame(&m2).unwrap();
    assert_eq!(id, pid);
    let (resp, _) = ini.read_message_2(&payload[4..]).unwrap();
    assert!(matches!(
        ClientFrame::from_bytes(&resp).unwrap(),
        ClientFrame::Response(_)
    ));
    {
        let opened = host.opened.lock().unwrap();
        let (p, auth) = opened.last().unwrap();
        assert_eq!(p.grant, mdbn_daemon::attest::uuid_bytes(GRANT).unwrap());
        assert_eq!(
            *auth,
            Auth::Grant {
                grant: p.grant,
                client_pk,
                origin: mdbn_daemon::session::Origin::RelayPipe,
            }
        );
    }
    // The test host refuses the session, so the daemon closes the pipe.
    let close = text(ws.next().await.unwrap().unwrap());
    assert_eq!(close["type"], "pipe_close");

    // 7. Revocation: an empty feed; a new pipe for the grant is refused.
    ws.send(Message::text(snapshot(4, vec![]).to_string()))
        .await
        .unwrap();
    let ack = text(ws.next().await.unwrap().unwrap());
    assert_eq!(ack["ok"], true);
    let pipe2 = "01900000-0000-7000-8000-000000000102";
    ws.send(Message::text(
        json!({"type":"pipe_open","pipe_id":pipe2,"collection_id":COLLECTION,"grant_id":GRANT})
            .to_string(),
    ))
    .await
    .unwrap();
    let close = loop {
        let v = text(ws.next().await.unwrap().unwrap());
        if v["pipe_id"] == pipe2 {
            break v;
        }
    };
    assert_eq!(close["reason"], "grant_inactive");

    // 8. Removing the serving collection sends a serving_collections update.
    *host.serving.lock().unwrap() = Some(vec![]);
    let update = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let v = text(ws.next().await.unwrap().unwrap());
            if v["type"] == "serving_collections" {
                break v;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(update["collections"], json!([]));

    session.stop().await;
}

/// Answers that must come promptly even while the host is stuck.
const PROMPT: Duration = Duration::from_millis(500);

fn pipe_open(pipe: &str, grant: &str) -> Value {
    json!({"type":"pipe_open","pipe_id":pipe,"collection_id":COLLECTION,"grant_id":grant})
}

const NIL_GRANT: &str = "00000000-0000-0000-0000-000000000000";

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stuck_commit_does_not_stop_the_relay_or_age_later_leases() {
    let host = Arc::new(Host::default());
    let mut session = connect(host.clone()).await;
    host.hold_commit.send_replace(true);
    let client_pk = mdbn_daemon::noise::public_key(&[42u8; 32]);
    session
        .send(snapshot(3, vec![grant_entry(&client_pk)]))
        .await;
    // Let the policy task take it, so the next one waits rather than replaces it.
    tokio::time::sleep(Duration::from_millis(100)).await;
    // A second snapshot whose lease would lapse while the first is stuck.
    session
        .send(snapshot_for(4, vec![grant_entry(&client_pk)], 1_500))
        .await;
    // The socket is still read and answered.
    session
        .send(pipe_open("01900000-0000-7000-8000-000000000200", NIL_GRANT))
        .await;
    let close = session
        .within(PROMPT, "pipe_open during a stuck commit")
        .await;
    assert_eq!(
        (close["type"].as_str(), close["reason"].as_str()),
        (Some("pipe_close"), Some("unauthenticated"))
    );
    tokio::time::sleep(Duration::from_millis(2_000)).await;
    host.hold_commit.send_replace(false);
    let first = session.within(Duration::from_secs(2), "first ack").await;
    assert_eq!(
        (first["request_id"].as_str(), first["ok"].as_bool()),
        (Some("r3"), Some(true)),
        "{first}"
    );
    // Checked when it arrived, so it is applied rather than refused as expired.
    let second = session.within(Duration::from_secs(2), "second ack").await;
    assert_eq!(
        (second["request_id"].as_str(), second["ok"].as_bool()),
        (Some("r4"), Some(true)),
        "{second}"
    );
    assert_eq!(host.applied.lock().unwrap().len(), 2);

    // A server Close ends the session at once, even with a commit stuck.
    host.hold_commit.send_replace(true);
    session.send(snapshot(5, vec![])).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(host.online.load(Ordering::SeqCst));
    session.ws.close(None).await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while host.online.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the relay kept a closed session while a commit was stuck");
    host.hold_commit.send_replace(false);
    session.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stuck_grant_checks_do_not_stop_the_relay() {
    let host = Arc::new(Host::default());
    let mut session = connect(host.clone()).await;
    let client_pk = mdbn_daemon::noise::public_key(&[42u8; 32]);
    session
        .send(snapshot(3, vec![grant_entry(&client_pk)]))
        .await;
    let ack = session.within(Duration::from_secs(2), "feed ack").await;
    assert_eq!(ack["ok"], true, "{ack}");
    // An admitted pipe, waiting for its first Noise frame.
    let kept = "01900000-0000-7000-8000-000000000300";
    session.send(pipe_open(kept, GRANT)).await;
    tokio::time::sleep(Duration::from_millis(200)).await;

    host.hold_grants.send_replace(true);
    // A new pipe's admission gets no answer: refused, retryably, in bounded time.
    let refused = "01900000-0000-7000-8000-000000000301";
    session.send(pipe_open(refused, GRANT)).await;
    // Meanwhile snapshots and other opens are handled at once.
    session
        .send(snapshot(4, vec![grant_entry(&client_pk)]))
        .await;
    let ack = session
        .within(PROMPT, "ack while grant checks are stuck")
        .await;
    assert_eq!(
        (ack["request_id"].as_str(), ack["ok"].as_bool()),
        (Some("r4"), Some(true)),
        "{ack}"
    );
    session
        .send(pipe_open("01900000-0000-7000-8000-000000000302", NIL_GRANT))
        .await;
    let close = session
        .within(PROMPT, "nil open while grant checks are stuck")
        .await;
    assert_eq!(close["reason"], "unauthenticated");
    let close = session
        .within(
            relay::GRANT_CHECK_WAIT + Duration::from_secs(1),
            "unanswered admission",
        )
        .await;
    assert_eq!(
        (close["pipe_id"].as_str(), close["reason"].as_str()),
        (Some(refused), Some("not_served"))
    );
    // The open pipe is kept while its sweep gets no answer (within the 10 s
    // handshake wait that would otherwise close it).
    assert!(
        tokio::time::timeout(Duration::from_secs(2), session.next())
            .await
            .is_err(),
        "an unanswered sweep closed a pipe"
    );
    // Once checks answer, a revoked grant still closes it.
    host.live.store(false, Ordering::SeqCst);
    host.hold_grants.send_replace(false);
    let close = session
        .within(
            relay::GRANT_CHECK_WAIT + Duration::from_secs(2),
            "revoked pipe",
        )
        .await;
    assert_eq!(
        (close["pipe_id"].as_str(), close["reason"].as_str()),
        (Some(kept), Some("grant_inactive"))
    );
    session.stop().await;
}
