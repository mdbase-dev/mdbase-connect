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

#[derive(Default)]
struct Host {
    applied: Mutex<Vec<(String, Vec<CachedGrant>, u64)>>,
    live: AtomicBool,
    opened: Mutex<Vec<(Prologue, Auth)>>,
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
        Box::pin(async move { self.live.load(Ordering::SeqCst) })
    }
    fn set_online(&self, _online: bool) {}
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
    let now = mdbn_daemon::fsutil::now_ms() as u64;
    let (issued, expires) = (now, now + 55_000);
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn relay_feed_and_pipe() {
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
    let host = Arc::new(Host::default());
    let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
    let client_sk = [42u8; 32];
    let client_pk = mdbn_daemon::noise::public_key(&client_sk);

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
    let text = |m: Message| -> Value { serde_json::from_str(m.to_text().unwrap()).unwrap() };
    let hello = text(ws.next().await.unwrap().unwrap());
    assert_eq!(hello["type"], "relay_hello");
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
                client_pk
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

    stop_tx.send(true).unwrap();
    let _ = tokio::time::timeout(Duration::from_secs(5), daemon).await;
}
