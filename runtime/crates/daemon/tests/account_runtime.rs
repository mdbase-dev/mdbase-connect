//! Collection runtimes follow the paired account: none opens before the
//! account is published; sign-out closes them (host sessions included) and they
//! reopen with a fresh, epoch-pinned source after the next sign-in.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::path::PathBuf;
use std::time::Duration;

use mdbn_daemon::client::{self, ControlClient};
use mdbn_daemon::control::{CollectionState, CollectionStatus, Method};
use mdbn_daemon::paths::Profile;
use mdbn_daemon::secrets::{self, MemoryStore};
use mdbn_daemon::server;
use mdbn_daemon::session::{ClientSession, Prologue, request};
use mdbn_wire::Wire;
use mdbn_wire::client::{ClientResponse, HelloParams};
use mdbn_wire::common::Version;
use serde_json::json;

#[path = "fixtures/pairing.rs"]
mod pairing;

fn scratch(tag: &str) -> PathBuf {
    // Under target/, never /tmp. Short: Unix socket paths are limited.
    let p = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("{tag}{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&p);
    std::fs::create_dir_all(&p).unwrap();
    p
}

async fn state_of(c: &mut ControlClient, id: &str) -> (CollectionState, Option<String>) {
    let list: Vec<CollectionStatus> =
        serde_json::from_value(c.call(Method::COLLECTION_LIST, json!({})).await.unwrap()).unwrap();
    let s = list.into_iter().find(|x| x.id == id).unwrap();
    (s.state, s.reason)
}

async fn wait_state(c: &mut ControlClient, id: &str, want: CollectionState) -> Option<String> {
    for _ in 0..500 {
        let (s, r) = state_of(c, id).await;
        if s == want {
            return r;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!(
        "collection never reached {want:?}: {:?}",
        state_of(c, id).await
    );
}

type Session = ClientSession<mdbn_daemon::ipc::BoxStream>;

async fn host_hello(profile: &Profile, keys: &MemoryStore, collection: &str) -> ClientResponse {
    host_session(profile, keys, collection).await.1
}

async fn host_session(
    profile: &Profile,
    keys: &MemoryStore,
    collection: &str,
) -> (Session, ClientResponse) {
    let ident =
        secrets::read_daemon_identity(&profile.state_dir, &profile.identity_file()).unwrap();
    let pk: [u8; 32] = secrets::hex_decode(&ident.noise_pk)
        .unwrap()
        .try_into()
        .unwrap();
    let b16 = |u: &str| -> [u8; 16] {
        secrets::hex_decode(&u.replace('-', ""))
            .unwrap()
            .try_into()
            .unwrap()
    };
    let ck = secrets::read_control_key(keys).unwrap().unwrap();
    let host_sk = secrets::host_noise_secret(&ck);
    let p = Prologue {
        collection: b16(collection),
        grant: [0; 16],
        target: b16(&ident.device),
    };
    let hp = HelloParams {
        versions: vec![Version { major: 1, minor: 0 }],
        client_name: "test".into(),
        client_version: "0".into(),
        features: None,
        timezone: None,
    };
    let s = mdbn_daemon::ipc::connect(&profile.replica).await.unwrap();
    ClientSession::connect(s, &host_sk, &pk, p, request(0, "hello", hp.to_cbor()))
        .await
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn runtimes_follow_the_paired_account() {
    let root = scratch("ar");
    let profile = Profile::isolated(&root.join("state")).unwrap();
    let keys = std::sync::Arc::new(MemoryStore::default());
    let (p, k2) = (profile.clone(), keys.clone());
    let daemon = tokio::spawn(async move { server::run(p, Some(Box::new(k2))).await });
    for _ in 0..200 {
        if matches!(client::ping(&profile.control).await, Ok(r) if r.ready) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    pairing::pair(&profile, &keys).await;
    let mut c = ControlClient::connect(&profile.control).await.unwrap();
    let notes = root.join("notes");
    std::fs::create_dir_all(&notes).unwrap();
    let added: CollectionStatus = serde_json::from_value(
        c.call(Method::COLLECTION_ADD, json!({ "path": notes }))
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        wait_state(&mut c, &added.id, CollectionState::Ready).await,
        None
    );
    let (mut held, hello) = host_session(&profile, &keys, &added.id).await;
    assert!(hello.problem.is_none(), "{:?}", hello.problem);

    // Signed out: the runtime is closed and nothing is served, not even the host.
    c.call(Method::ACCOUNT_SIGN_OUT, json!({})).await.unwrap();
    assert_eq!(
        wait_state(&mut c, &added.id, CollectionState::Unavailable)
            .await
            .as_deref(),
        Some("account_identity_missing")
    );
    let hello = host_hello(&profile, &keys, &added.id).await;
    assert_eq!(
        hello.problem.expect("refused").reason.as_deref(),
        Some("account_identity_missing")
    );
    // The host session opened before sign-out did not survive it.
    let ended = tokio::time::timeout(Duration::from_secs(10), async {
        // Pushes may still arrive; the session must then end (closed or error).
        while let Ok(Some(_)) = held.recv().await {}
    })
    .await;
    assert!(ended.is_ok(), "a host session outlived sign-out");

    // Signed in again with the same account: a new runtime serves it.
    pairing::pair(&profile, &keys).await;
    assert_eq!(
        wait_state(&mut c, &added.id, CollectionState::Ready).await,
        None
    );
    let hello = host_hello(&profile, &keys, &added.id).await;
    assert!(hello.problem.is_none(), "{:?}", hello.problem);

    c.call(Method::SHUTDOWN, json!({})).await.unwrap();
    tokio::time::timeout(Duration::from_secs(15), daemon)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_foreign_registration_is_never_opened() {
    let root = scratch("af");
    let profile = Profile::isolated(&root.join("state")).unwrap();
    let keys = std::sync::Arc::new(MemoryStore::default());
    let start = |keys: std::sync::Arc<MemoryStore>| {
        let p = profile.clone();
        tokio::spawn(async move { server::run(p, Some(Box::new(keys))).await })
    };
    let daemon = start(keys.clone());
    for _ in 0..200 {
        if matches!(client::ping(&profile.control).await, Ok(r) if r.ready) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    pairing::pair(&profile, &keys).await;
    let mut c = ControlClient::connect(&profile.control).await.unwrap();
    let notes = root.join("notes");
    std::fs::create_dir_all(&notes).unwrap();
    let added: CollectionStatus = serde_json::from_value(
        c.call(Method::COLLECTION_ADD, json!({ "path": notes }))
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        wait_state(&mut c, &added.id, CollectionState::Ready).await,
        None
    );
    c.call(Method::SHUTDOWN, json!({})).await.unwrap();
    tokio::time::timeout(Duration::from_secs(15), daemon)
        .await
        .unwrap()
        .unwrap()
        .unwrap();

    // The registration now names another account than the paired one.
    let file = profile.registry_file();
    let mut reg: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    reg["collections"][0]["owner_account"] = json!("33333333-3333-4333-8333-333333333333");
    std::fs::write(&file, serde_json::to_vec_pretty(&reg).unwrap()).unwrap();

    let daemon = start(keys.clone());
    let mut c = None;
    for _ in 0..200 {
        if matches!(client::ping(&profile.control).await, Ok(r) if r.ready) {
            c = Some(ControlClient::connect(&profile.control).await.unwrap());
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let mut c = c.expect("daemon restarted");
    assert_eq!(
        wait_state(&mut c, &added.id, CollectionState::Unavailable)
            .await
            .as_deref(),
        Some("collection_account_mismatch")
    );
    let hello = host_hello(&profile, &keys, &added.id).await;
    assert!(hello.problem.is_some(), "a foreign registration was served");

    c.call(Method::SHUTDOWN, json!({})).await.unwrap();
    tokio::time::timeout(Duration::from_secs(15), daemon)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let _ = std::fs::remove_dir_all(&root);
}
