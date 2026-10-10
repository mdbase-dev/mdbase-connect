//! The daemon process model end to end: readiness, single instance, the control
//! protocol, registration, status pushes, graceful shutdown.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::path::PathBuf;
use std::time::Duration;

use mdbn_daemon::client::{self, ClientError, ControlClient};
use mdbn_daemon::control::{CollectionState, CollectionStatus, DaemonStatus, Method};
use mdbn_daemon::paths::Profile;
use mdbn_daemon::secrets::MemoryStore;
use mdbn_daemon::server::{self, RunError};
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

async fn wait_ready(profile: &Profile) {
    for _ in 0..200 {
        if let Ok(r) = client::ping(&profile.control).await
            && r.ready
        {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("daemon did not become ready");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn daemon_lifecycle() {
    let root = scratch("d");
    let profile = Profile::isolated(&root.join("state")).unwrap();

    assert!(matches!(
        client::ping(&profile.control).await,
        Err(ClientError::NotRunning)
    ));

    let keys = std::sync::Arc::new(MemoryStore::default());
    let p = profile.clone();
    let k2 = keys.clone();
    let daemon = tokio::spawn(async move { server::run(p, Some(Box::new(k2))).await });
    wait_ready(&profile).await;

    // Single instance.
    let second = server::run(profile.clone(), Some(Box::new(MemoryStore::default()))).await;
    assert!(matches!(second, Err(RunError::AlreadyRunning)));
    wait_ready(&profile).await;

    let mut c = ControlClient::connect(&profile.control).await.unwrap();
    // Missing account identity denies registration; only normal authenticated
    // pairing supplies it (never connector/device metadata backfill).
    let notes = root.join("notes");
    std::fs::create_dir_all(&notes).unwrap();
    match c.call(Method::COLLECTION_ADD, json!({"path":notes})).await {
        Err(ClientError::Remote(error)) => {
            assert_eq!(error.reason.as_deref(), Some("account_identity_missing"))
        }
        other => panic!("{other:?}"),
    }
    pairing::pair(&profile, &keys).await;
    let mut sub = ControlClient::connect(&profile.control).await.unwrap();
    let first: DaemonStatus =
        serde_json::from_value(sub.call(Method::STATUS_SUBSCRIBE, json!({})).await.unwrap())
            .unwrap();
    assert!(first.readiness.ready);
    assert_eq!(first.secret_backend, "memory");
    let device = first.device.expect("device identity");
    assert_eq!(device.noise_pk.len(), 64);

    // daemon.json is in the state dir and is verified.
    let ident =
        mdbn_daemon::secrets::read_daemon_identity(&profile.state_dir, &profile.identity_file())
            .unwrap();
    assert_eq!(ident.device, device.device_id);
    assert_eq!(ident.noise_pk, device.noise_pk);

    // Register a folder.
    let notes = root.join("notes");
    std::fs::create_dir_all(&notes).unwrap();
    let added: CollectionStatus = serde_json::from_value(
        c.call(Method::COLLECTION_ADD, json!({ "path": notes }))
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(added.name, "notes");
    // The runtime opens in the background: `opening` (or already `ready`).
    assert!(
        matches!(
            added.state,
            CollectionState::Opening | CollectionState::Ready
        ),
        "{:?}",
        added.state
    );
    assert_eq!(added.reason, None);
    let registry = mdbn_daemon::registry::Registry::load(&profile.registry_file()).unwrap();
    let registered = registry.get(&added.id).unwrap();
    assert_eq!(registered.owner_account.as_deref(), Some(pairing::ACCOUNT));
    assert_eq!(
        registered.device.as_deref(),
        Some(device.device_id.as_str())
    );

    // The subscriber hears about it, and again once it is ready.
    let pushed = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let (kind, payload) = sub.next_push().await.unwrap().unwrap();
            assert_eq!(kind, "status");
            let pushed: DaemonStatus = serde_json::from_value(payload).unwrap();
            // Pushes may include account/relay snapshots queued before the add:
            // wait for this registration, ready.
            if pushed
                .collections
                .iter()
                .any(|entry| entry.id == added.id && entry.state == CollectionState::Ready)
            {
                break pushed;
            }
        }
    })
    .await
    .expect("collection became ready");
    assert_eq!(pushed.collections.len(), 1);
    assert_eq!(pushed.collections[0].id, added.id);
    assert_eq!(pushed.collections[0].reason, None);

    // The replica endpoint: Noise IK with the key pinned from daemon.json.
    {
        use mdbn_daemon::session::{ClientSession, Prologue, request};
        use mdbn_wire::cbor::Cbor;
        let pk: [u8; 32] = mdbn_daemon::secrets::hex_decode(&ident.noise_pk)
            .unwrap()
            .try_into()
            .unwrap();
        let bytes16 = |u: &str| -> [u8; 16] {
            mdbn_daemon::secrets::hex_decode(&u.replace('-', ""))
                .unwrap()
                .try_into()
                .unwrap()
        };
        let p = Prologue {
            collection: bytes16(&added.id),
            grant: [0; 16],
            target: bytes16(&ident.device),
        };
        // A nil grant with any other static key is not the hosting app.
        let s = mdbn_daemon::ipc::connect(&profile.replica).await.unwrap();
        let (_, hello) =
            ClientSession::connect(s, &[21u8; 32], &pk, p, request(0, "hello", Cbor::Null))
                .await
                .unwrap();
        // A nil grant without the host key is refused.
        assert_eq!(
            hello.problem.unwrap().reason.as_deref(),
            Some("host_key_required")
        );
        // With the host key (derived from the keychain's control key), the hosting
        // app gets a real replica session and can write a record to the folder.
        {
            use mdbn_wire::Wire;
            use mdbn_wire::client::{
                ClientFrame, ClientRequest, HelloParams, Receipt, ReceiptState, SubmitParams,
                WaitFor,
            };
            use mdbn_wire::common::{B16, Text, Version};
            use mdbn_wire::intent::{Create, Op};
            let ck = mdbn_daemon::secrets::read_control_key(keys.as_ref())
                .unwrap()
                .unwrap();
            let host_sk = mdbn_daemon::secrets::host_noise_secret(&ck);
            let hp = HelloParams {
                versions: vec![Version { major: 1, minor: 0 }],
                client_name: "test".into(),
                client_version: "0".into(),
                features: None,
                timezone: None,
            };
            let s = mdbn_daemon::ipc::connect(&profile.replica).await.unwrap();
            let (mut sess, hello) =
                ClientSession::connect(s, &host_sk, &pk, p, request(0, "hello", hp.to_cbor()))
                    .await
                    .unwrap();
            assert!(hello.problem.is_none(), "{:?}", hello.problem);
            let submit = SubmitParams {
                ops: vec![Op::Create(Create {
                    id: B16([9; 16]),
                    path: Some("from-ipc.md".into()),
                    type_name: None,
                    frontmatter: None,
                    body: None,
                    document: Some(Text::Inline("---\ntitle: IPC\n---\n".into())),
                })],
                mutation_id: None,
                conflict_mode: None,
                timezone: None,
                allow_partial: None,
                mutation_ids: None,
                dry_run: None,
                include: None,
                wait: Some(WaitFor::Confirmed),
            };
            sess.send(&ClientFrame::Request(ClientRequest {
                id: 1,
                method: "submit".into(),
                params: submit.to_cbor(),
            }))
            .await
            .unwrap();
            let receipt = tokio::time::timeout(Duration::from_secs(20), async {
                loop {
                    if let Some(ClientFrame::Response(r)) = sess.recv().await.unwrap()
                        && r.id == 1
                    {
                        assert!(r.problem.is_none(), "{:?}", r.problem);
                        let rs: Vec<Receipt> = Wire::from_cbor(&r.result.unwrap()).unwrap();
                        break rs.into_iter().next().unwrap();
                    }
                }
            })
            .await
            .unwrap();
            assert_eq!(receipt.state, ReceiptState::Confirmed);
            assert!(
                std::fs::read_to_string(notes.join("from-ipc.md"))
                    .unwrap()
                    .contains("IPC")
            );
        }
        // Holds over the control endpoint: none after a clean write, and resolving
        // an unknown hold is the replica's not_found (the daemon acted as host).
        let holds = c
            .call(Method::COLLECTION_HOLDS, json!({ "collection": added.id }))
            .await
            .unwrap();
        assert_eq!(holds, json!([]));
        match c
            .call(
                Method::COLLECTION_RESOLVE_HOLD,
                json!({
                    "collection": added.id,
                    "id": "00000000-0000-4000-8000-000000000001",
                    "how": "keep_mine",
                }),
            )
            .await
        {
            Err(ClientError::Remote(e)) => assert_eq!(e.code, "not_found"),
            other => panic!("{other:?}"),
        }
        match c
            .call(
                Method::COLLECTION_RESOLVE_HOLD,
                json!({ "collection": added.id, "id": "not-a-uuid", "how": "keep_mine" }),
            )
            .await
        {
            Err(ClientError::Remote(e)) => assert_eq!(e.reason.as_deref(), Some("invalid_id")),
            other => panic!("{other:?}"),
        }
        // A granted session on a local collection with no grant feed yet: refused
        // because its grant lease is not live.
        let pg = Prologue {
            grant: [3; 16],
            ..p
        };
        let st = mdbn_daemon::ipc::connect(&profile.replica).await.unwrap();
        let (_, hello) =
            ClientSession::connect(st, &[22u8; 32], &pk, pg, request(0, "hello", Cbor::Null))
                .await
                .unwrap();
        let prob = hello.problem.unwrap();
        assert_eq!(
            (prob.code.as_str(), prob.reason.as_deref()),
            ("forbidden", Some("grant_lease_expired"))
        );
        // Without the host key, an unknown collection is indistinguishable from a
        // hosted one; with it, the lookup answers.
        let p = Prologue {
            collection: [7; 16],
            ..p
        };
        let s = mdbn_daemon::ipc::connect(&profile.replica).await.unwrap();
        let (_, hello) =
            ClientSession::connect(s, &[21u8; 32], &pk, p, request(0, "hello", Cbor::Null))
                .await
                .unwrap();
        assert_eq!(
            hello.problem.unwrap().reason.as_deref(),
            Some("host_key_required")
        );
        let ck = mdbn_daemon::secrets::read_control_key(keys.as_ref())
            .unwrap()
            .unwrap();
        let host_sk = mdbn_daemon::secrets::host_noise_secret(&ck);
        let s = mdbn_daemon::ipc::connect(&profile.replica).await.unwrap();
        let (_, hello) =
            ClientSession::connect(s, &host_sk, &pk, p, request(0, "hello", Cbor::Null))
                .await
                .unwrap();
        assert_eq!(
            hello.problem.unwrap().reason.as_deref(),
            Some("unknown_collection")
        );
    }

    // Overlaps and duplicates are refused.
    std::fs::create_dir_all(notes.join("sub")).unwrap();
    let err = c
        .call(Method::COLLECTION_ADD, json!({ "path": notes.join("sub") }))
        .await
        .unwrap_err();
    match err {
        ClientError::Remote(e) => assert_eq!(e.reason.as_deref(), Some("overlapping_root")),
        other => panic!("{other:?}"),
    }

    // A connector-managed folder needs the migration adopt.
    let old = root.join("old");
    std::fs::create_dir_all(old.join(".mdbase")).unwrap();
    std::fs::write(
        old.join(".mdbase/connect-role.json"),
        br#"{"version":1,"role":"mirror","collection_id":"4c18af2e-b04a-4b77-b83e-493c3695962e"}"#,
    )
    .unwrap();
    match c.call(Method::COLLECTION_ADD, json!({ "path": old })).await {
        Err(ClientError::Remote(e)) => assert_eq!(e.reason.as_deref(), Some("migration_pending")),
        other => panic!("{other:?}"),
    }
    // A garbage marker fails closed.
    let bad = root.join("bad");
    std::fs::create_dir_all(bad.join(".mdbase")).unwrap();
    std::fs::write(bad.join(".mdbase/connect-role.json"), b"{}").unwrap();
    match c.call(Method::COLLECTION_ADD, json!({ "path": bad })).await {
        Err(ClientError::Remote(e)) => assert_eq!(e.reason.as_deref(), Some("invalid_marker")),
        other => panic!("{other:?}"),
    }
    // A v2 claim by this daemon (after the takeover) is accepted with Connect's
    // collection ID; one by anyone else is refused.
    let taken = root.join("taken");
    std::fs::create_dir_all(taken.join(".mdbase")).unwrap();
    std::fs::write(
        taken.join("mdbase.yaml"),
        b"x-mdbase-connect:\n  collection_id: x\n",
    )
    .unwrap();
    let cid = "4c18af2e-b04a-4b77-b83e-493c3695962f";
    let marker = |rid: &str| {
        format!(
            r#"{{"version":2,"role":"replica","collection":"{cid}","replica_id":"{rid}","runtime":"mdbase-next"}}"#
        )
    };
    std::fs::write(
        taken.join(".mdbase/connect-role.json"),
        marker("0b9f3e7a-3c51-4a8e-9d2f-6e1b2c3d4e5f"),
    )
    .unwrap();
    match c
        .call(Method::COLLECTION_ADD, json!({ "path": taken }))
        .await
    {
        Err(ClientError::Remote(e)) => {
            assert_eq!(e.reason.as_deref(), Some("claimed_by_other_replica"))
        }
        other => panic!("{other:?}"),
    }
    let ours =
        mdbn_daemon::registry::StoreIds::get_or_issue(&profile.store_ids_file(), cid).unwrap();
    std::fs::write(taken.join(".mdbase/connect-role.json"), marker(&ours)).unwrap();
    let st: CollectionStatus = serde_json::from_value(
        c.call(Method::COLLECTION_ADD, json!({ "path": taken }))
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(st.id, cid);
    assert_eq!(st.origin, mdbn_daemon::registry::Origin::MigratedLocal);

    // The local access list and its opt-in approval setting.
    assert_eq!(
        c.call(Method::ACCESS_LIST, json!({})).await.unwrap(),
        json!([])
    );
    match c
        .call(Method::ACCESS_REVOKE, json!({ "grant": "nope" }))
        .await
    {
        Err(ClientError::Remote(e)) => assert_eq!(e.code, "not_found"),
        other => panic!("{other:?}"),
    }
    // Privileged methods need an authenticated caller.
    match c
        .call(
            Method::SETTINGS_SET,
            json!({ "require_grant_approval": false }),
        )
        .await
    {
        Err(ClientError::Remote(e)) => {
            assert_eq!(e.reason.as_deref(), Some("caller_not_authenticated"))
        }
        other => panic!("{other:?}"),
    }
    c.call(Method::AUTH_CHALLENGE, json!({})).await.unwrap();
    match c.call(Method::AUTH_PROVE, json!({ "proof": "00" })).await {
        Err(ClientError::Remote(e)) => assert_eq!(e.code, "unauthenticated"),
        other => panic!("{other:?}"),
    }
    c.authenticate(keys.as_ref()).await.unwrap();
    let set = c
        .call(
            Method::SETTINGS_SET,
            json!({ "require_grant_approval": true }),
        )
        .await
        .unwrap();
    assert_eq!(set["require_grant_approval"], true);
    let access: serde_json::Value =
        serde_json::from_slice(&std::fs::read(profile.access_file()).unwrap()).unwrap();
    assert_eq!(access["require_grant_approval"], true);

    // Pause persists.
    let paused: CollectionStatus = serde_json::from_value(
        c.call(Method::COLLECTION_PAUSE, json!({ "collection": added.id }))
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(paused.state, CollectionState::Paused);

    // Device approval needs a private collection; codes are six digits.
    match c
        .call(
            Method::DEVICE_APPROVE,
            json!({ "collection": added.id, "device": "x", "code": "12" }),
        )
        .await
    {
        Err(ClientError::Remote(e)) => assert_eq!(e.reason.as_deref(), Some("invalid_code")),
        other => panic!("{other:?}"),
    }

    // The registry is durable.
    let reg: serde_json::Value =
        serde_json::from_slice(&std::fs::read(profile.registry_file()).unwrap()).unwrap();
    assert_eq!(reg["collections"][0]["paused"], true);

    // Graceful shutdown removes the socket and releases the lock.
    c.call(Method::SHUTDOWN, json!({})).await.unwrap();
    tokio::time::timeout(Duration::from_secs(15), daemon)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(matches!(
        client::ping(&profile.control).await,
        Err(ClientError::NotRunning)
    ));
    assert!(!mdbn_daemon::instance::InstanceLock::is_held(&profile.lock_file()).unwrap());

    // Restart: the registry and identity survive.
    let p = profile.clone();
    let store = MemoryStore::default();
    let daemon = tokio::spawn(async move { server::run(p, Some(Box::new(store))).await });
    for _ in 0..200 {
        if client::ping(&profile.control).await.is_ok() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    // A fresh (empty) keychain with an existing daemon.json fails closed.
    let mut c = ControlClient::connect(&profile.control).await.unwrap();
    let s: DaemonStatus =
        serde_json::from_value(c.call(Method::STATUS, json!({})).await.unwrap()).unwrap();
    for _ in 0..100 {
        let s: DaemonStatus =
            serde_json::from_value(c.call(Method::STATUS, json!({})).await.unwrap()).unwrap();
        if s.readiness.safe_reason != Some(mdbn_daemon::control::NotReady::Starting) {
            assert!(!s.readiness.ready);
            assert_eq!(
                s.readiness.safe_reason,
                Some(mdbn_daemon::control::NotReady::CredentialStoreUnavailable)
            );
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let _ = s;
    match c.call(Method::COLLECTION_LIST, json!({})).await {
        Err(ClientError::Remote(e)) => assert_eq!(e.reason.as_deref(), Some("not_ready")),
        other => panic!("{other:?}"),
    }
    c.call(Method::SHUTDOWN, json!({})).await.unwrap();
    tokio::time::timeout(Duration::from_secs(15), daemon)
        .await
        .unwrap()
        .unwrap()
        .unwrap();

    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn widening_access_needs_an_on_screen_confirmation() {
    use mdbn_daemon::confirm::{Answer, Fixed};
    for (answer, want) in [
        (Answer::No, Some("not_confirmed")),
        (Answer::Unavailable, Some("confirmation_unavailable")),
        (Answer::Yes, None),
    ] {
        let root = scratch("c");
        let profile = Profile::isolated(&root.join("state")).unwrap();
        let keys = std::sync::Arc::new(MemoryStore::default());
        let (p, k2) = (profile.clone(), keys.clone());
        let daemon = tokio::spawn(async move {
            server::run_with(p, Some(Box::new(k2)), Box::new(Fixed(answer))).await
        });
        wait_ready(&profile).await;
        let mut c = ControlClient::connect(&profile.control).await.unwrap();
        c.authenticate(keys.as_ref()).await.unwrap();
        let r = c
            .call(
                Method::SETTINGS_SET,
                json!({ "require_grant_approval": false }),
            )
            .await;
        match (r, want) {
            (Ok(_), None) => {}
            (Err(ClientError::Remote(e)), Some(w)) => assert_eq!(e.reason.as_deref(), Some(w)),
            (other, w) => panic!("{other:?} vs {w:?}"),
        }
        c.call(Method::SHUTDOWN, json!({})).await.unwrap();
        let _ = tokio::time::timeout(Duration::from_secs(15), daemon).await;
        let _ = std::fs::remove_dir_all(&root);
    }
}
