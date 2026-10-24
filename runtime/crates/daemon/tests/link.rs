//! The localhost link (§12.4): Origin/Host checks before the upgrade, the token
//! inside Noise message 1, the per-collection key the user approved on screen
//! (linked-client authorization), a real hosting session on a local collection, and only the
//! allowlisted methods served.
#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    clippy::result_large_err
)]

use std::path::PathBuf;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use mdbn_daemon::client::{self, ControlClient};
use mdbn_daemon::confirm::{Answer, Confirmer};
use mdbn_daemon::control::{CollectionStatus, Method};
use mdbn_daemon::paths::Profile;
use mdbn_daemon::secrets::{self, MemoryStore};
use mdbn_daemon::server;
use mdbn_wire::Wire;
use mdbn_wire::cbor::Cbor;
use mdbn_wire::client::{ClientFrame, ClientRequest, HelloParams};
use mdbn_wire::common::Version;
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

#[path = "fixtures/pairing.rs"]
mod pairing;

fn scratch(tag: &str) -> PathBuf {
    let p = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("{tag}{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&p);
    std::fs::create_dir_all(&p).unwrap();
    p
}

async fn ws(
    port: u16,
    origin: Option<&str>,
) -> Result<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    u16,
> {
    let mut req = format!("ws://127.0.0.1:{port}/v1/plugin")
        .into_client_request()
        .unwrap();
    if let Some(o) = origin {
        req.headers_mut().insert("origin", o.parse().unwrap());
    }
    match tokio_tungstenite::connect_async(req).await {
        Ok((s, _)) => Ok(s),
        Err(tokio_tungstenite::tungstenite::Error::Http(r)) => Err(r.status().as_u16()),
        Err(e) => panic!("{e}"),
    }
}

/// Answers in order; records how often it was asked.
struct Scripted {
    answers: std::sync::Mutex<std::collections::VecDeque<Answer>>,
    asked: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}

impl Confirmer for Scripted {
    fn ask<'a>(&'a self, _t: &'a str, _m: &'a str) -> mdbn_daemon::session::BoxFuture<'a, Answer> {
        self.asked.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let a = self
            .answers
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(Answer::No);
        Box::pin(async move { a })
    }
}

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// One link session: the hello response and, when accepted, the transport.
async fn open_link(
    port: u16,
    prologue: &[u8],
    noise_pk: &[u8; 32],
    token: &[u8],
    static_sk: &[u8; 32],
    hello: &HelloParams,
) -> (
    mdbn_wire::client::ClientResponse,
    Ws,
    mdbn_daemon::noise::Transport,
) {
    let mut s = ws(port, Some("app://obsidian.md")).await.unwrap();
    s.send(Message::binary(prologue.to_vec())).await.unwrap();
    let mut ini = mdbn_daemon::noise::Initiator::new(static_sk, noise_pk, prologue);
    let m1 = ini
        .write_message_1(&[9; 32], &link_payload(token, hello.to_cbor()))
        .unwrap();
    s.send(Message::binary(m1)).await.unwrap();
    let m2 = match s.next().await.unwrap().unwrap() {
        Message::Binary(b) => b,
        other => panic!("{other:?}"),
    };
    let (resp, t) = ini.read_message_2(&m2).unwrap();
    match ClientFrame::from_bytes(&resp).unwrap() {
        ClientFrame::Response(r) => (r, s, t),
        other => panic!("{other:?}"),
    }
}

/// Send one request on an open link session and read its response.
async fn call(
    s: &mut Ws,
    t: &mut mdbn_daemon::noise::Transport,
    id: u64,
    method: &str,
) -> mdbn_wire::client::ClientResponse {
    let f = ClientFrame::Request(ClientRequest {
        id,
        method: method.into(),
        params: Cbor::Map(vec![]),
    })
    .to_bytes()
    .unwrap();
    for m in mdbn_daemon::session::seal_frame(t, &f).unwrap() {
        s.send(Message::binary(m)).await.unwrap();
    }
    let mut reader = mdbn_daemon::session::FrameReader::default();
    loop {
        let Message::Binary(b) = s.next().await.unwrap().unwrap() else {
            continue;
        };
        let plain = t.open(&b).unwrap();
        for f in reader.push(&plain).unwrap() {
            if let ClientFrame::Response(r) = ClientFrame::from_bytes(&f).unwrap()
                && r.id == id
            {
                return r;
            }
        }
    }
}

fn link_payload(token: &[u8], params: Cbor) -> Vec<u8> {
    mdbn_wire::cbor::encode(&Cbor::Map(vec![
        (Cbor::Uint(0), Cbor::Bytes(token.to_vec())),
        (Cbor::Uint(1), params),
    ]))
    .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn localhost_link() {
    let root = scratch("lk");
    let profile = Profile::isolated(&root.join("state")).unwrap();
    let keys = std::sync::Arc::new(MemoryStore::default());
    let asked = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    // No (first link request), Yes (approve key A), then No for everything else.
    let confirmer = Scripted {
        answers: std::sync::Mutex::new([Answer::No, Answer::Yes].into_iter().collect()),
        asked: asked.clone(),
    };
    let (p, k2) = (profile.clone(), keys.clone());
    let daemon =
        tokio::spawn(
            async move { server::run_with(p, Some(Box::new(k2)), Box::new(confirmer)).await },
        );
    let asked_now = || asked.load(std::sync::atomic::Ordering::SeqCst);
    for _ in 0..200 {
        if matches!(client::ping(&profile.control).await, Ok(r) if r.ready)
            && profile.local_link_file().exists()
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    pairing::pair(&profile, &keys).await;
    let mut c = ControlClient::connect(&profile.control).await.unwrap();
    let vault = root.join("vault");
    std::fs::create_dir_all(&vault).unwrap();
    let col: CollectionStatus = serde_json::from_value(
        c.call(Method::COLLECTION_ADD, json!({ "path": vault }))
            .await
            .unwrap(),
    )
    .unwrap();
    // The runtime opens in the background; wait until it serves.
    for _ in 0..500 {
        let list: Vec<CollectionStatus> =
            serde_json::from_value(c.call(Method::COLLECTION_LIST, json!({})).await.unwrap())
                .unwrap();
        if list
            .iter()
            .any(|x| x.id == col.id && x.state == mdbn_daemon::control::CollectionState::Ready)
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    let link: Value =
        serde_json::from_slice(&std::fs::read(profile.local_link_file()).unwrap()).unwrap();
    let port = link["port"].as_u64().unwrap() as u16;
    let token = secrets::hex_decode(link["token"].as_str().unwrap()).unwrap();
    let ident =
        secrets::read_daemon_identity(&profile.state_dir, &profile.identity_file()).unwrap();
    let noise_pk: [u8; 32] = secrets::hex_decode(&ident.noise_pk)
        .unwrap()
        .try_into()
        .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(profile.local_link_file())
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o077, 0, "link file is owner-only");
    }

    // Wrong or missing Origin: 403 before the upgrade.
    assert_eq!(ws(port, None).await.err(), Some(403));
    assert_eq!(
        ws(port, Some("https://evil.example")).await.err(),
        Some(403)
    );

    let prologue = mdbn_daemon::pipes::prologue(
        &mdbn_daemon::attest::uuid_bytes(&col.id).unwrap(),
        &[0; 16],
        &[0; 16], // local-only collection: zero device on the link
    );
    let hello = HelloParams {
        versions: vec![Version { major: 1, minor: 0 }],
        client_name: "obsidian".into(),
        client_version: "0".into(),
        features: None,
        timezone: None,
    };

    // Wrong token: no message 2.
    let mut s = ws(port, Some("app://obsidian.md")).await.unwrap();
    s.send(Message::binary(prologue.to_vec())).await.unwrap();
    let mut ini = mdbn_daemon::noise::Initiator::new(&[8; 32], &noise_pk, &prologue);
    let m1 = ini
        .write_message_1(&[9; 32], &link_payload(&[0u8; 32], hello.to_cbor()))
        .unwrap();
    s.send(Message::binary(m1)).await.unwrap();
    let next = tokio::time::timeout(Duration::from_secs(5), s.next())
        .await
        .unwrap();
    assert!(!matches!(next, Some(Ok(Message::Binary(_)))), "{next:?}");

    // Right token, but the user has not linked this key: the token alone (any
    // process of the user can read the link file) gets nothing. Declined on screen.
    let (key_a, key_b) = ([8u8; 32], [7u8; 32]);
    let (r, _, _) = open_link(port, &prologue, &noise_pk, &token, &key_a, &hello).await;
    assert_eq!(
        r.problem.as_ref().and_then(|p| p.reason.as_deref()),
        Some("link_not_approved")
    );
    assert_eq!(asked_now(), 1);
    // Approved on screen: a hosting session; the key is kept in the keychain.
    let (r, mut s, mut t) = open_link(port, &prologue, &noise_pk, &token, &key_a, &hello).await;
    assert!(r.problem.is_none(), "{:?}", r.problem);
    assert_eq!(asked_now(), 2);
    let link_secret = format!("link-client.{}", col.id);
    assert_eq!(
        secrets::SecretStore::get(&*keys, &link_secret)
            .unwrap()
            .unwrap()
            .as_slice(),
        mdbn_daemon::noise::public_key(&key_a)
    );
    // Only allowlisted methods. Approvals, and any method not on the list
    // (the strict-SAS runtime APIs once dispatched), are refused on the link.
    for (id, m) in [
        (5, "approve_device"),
        (6, "pending_devices"),
        (7, "start_device_approval"),
        (8, "submit_device_approval"),
        (9, "approve_grant"),
    ] {
        let r = call(&mut s, &mut t, id, m).await;
        assert_eq!(
            r.problem.and_then(|p| p.reason).as_deref(),
            Some("confirm_in_daemon_ui"),
            "{m}"
        );
    }
    let r = call(&mut s, &mut t, 10, "get_status").await;
    assert!(
        r.problem
            .as_ref()
            .is_none_or(|p| p.reason.as_deref() != Some("confirm_in_daemon_ui")),
        "{:?}",
        r.problem
    );
    // The approved key reconnects without asking again.
    let (r, _, _) = open_link(port, &prologue, &noise_pk, &token, &key_a, &hello).await;
    assert!(r.problem.is_none(), "{:?}", r.problem);
    assert_eq!(asked_now(), 2);
    // Another process with the token but its own key: asked again, declined.
    let (r, _, _) = open_link(port, &prologue, &noise_pk, &token, &key_b, &hello).await;
    assert_eq!(
        r.problem.as_ref().and_then(|p| p.reason.as_deref()),
        Some("link_not_approved")
    );
    assert_eq!(asked_now(), 3);
    // Linking is per collection: key A on a second collection asks again.
    let vault2 = root.join("vault2");
    std::fs::create_dir_all(&vault2).unwrap();
    let col2: CollectionStatus = serde_json::from_value(
        c.call(Method::COLLECTION_ADD, json!({ "path": vault2 }))
            .await
            .unwrap(),
    )
    .unwrap();
    for _ in 0..500 {
        let list: Vec<CollectionStatus> =
            serde_json::from_value(c.call(Method::COLLECTION_LIST, json!({})).await.unwrap())
                .unwrap();
        if list
            .iter()
            .any(|x| x.id == col2.id && x.state == mdbn_daemon::control::CollectionState::Ready)
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let prologue2 = mdbn_daemon::pipes::prologue(
        &mdbn_daemon::attest::uuid_bytes(&col2.id).unwrap(),
        &[0; 16],
        &[0; 16],
    );
    let (r, _, _) = open_link(port, &prologue2, &noise_pk, &token, &key_a, &hello).await;
    assert_eq!(
        r.problem.as_ref().and_then(|p| p.reason.as_deref()),
        Some("link_not_approved")
    );
    assert_eq!(asked_now(), 4);

    c.call(Method::SHUTDOWN, json!({})).await.unwrap();
    let _ = tokio::time::timeout(Duration::from_secs(15), daemon).await;
    assert!(
        !profile.local_link_file().exists(),
        "link file removed at shutdown"
    );
    let _ = std::fs::remove_dir_all(&root);
}
