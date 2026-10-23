//! The local takeover end to end through the real daemon: an old agent's device
//! (connector state from the old connector's exact DDL plus a folder with old engine
//! transactions in flight) is untouched until Connect permits the flipped account,
//! then taken over at daemon start and served across a restart.
//!
//! An isolated profile only looks at old connector state it is pointed at, and
//! never touches a service manager.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use mdbn_daemon::client::{self, ClientError, ControlClient};
use mdbn_daemon::control::{Check, CollectionStatus, Method};
use mdbn_daemon::paths::Profile;
use mdbn_daemon::secrets::MemoryStore;
use mdbn_daemon::server;
use mdbn_legacy::marker::{self, Marker};
use serde_json::{Value, json};

#[path = "fixtures/takeover_rollout.rs"]
mod pairing;

#[path = "fixtures/old_agent.rs"]
mod old_agent;

fn scratch(tag: &str) -> PathBuf {
    let p = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("{tag}{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&p);
    std::fs::create_dir_all(&p).unwrap();
    p
}

async fn wait_ready(profile: &Profile) {
    for _ in 0..300 {
        if let Ok(r) = client::ping(&profile.control).await
            && r.ready
        {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("daemon did not become ready");
}

async fn until<F, Fut>(what: &str, mut f: F) -> Value
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Option<Value>>,
{
    for _ in 0..300 {
        if let Some(v) = f().await {
            return v;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("timed out waiting for {what}");
}

async fn status(profile: &Profile) -> Value {
    let mut c = ControlClient::connect(&profile.control).await.unwrap();
    c.call(Method::MIGRATE_STATUS, json!({})).await.unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn automatic_takeover_waits_for_a_flipped_batch_and_fails_closed() {
    let root = scratch("tk");
    let old = root.join("connect");
    let notes = root.join("notes");
    old_agent::build(&old, &notes);
    // Authority-v3+ exact old identity, not inferred from a grant or current caller.
    let db = rusqlite::Connection::open(old.join("authority.sqlite")).unwrap();
    db.execute("INSERT INTO policy_state (singleton,revision,epoch,applied_at_ms,connector_id) VALUES (1,'fixture',1,0,?1)",
        ["44444444-4444-4444-8444-444444444444"]).unwrap();
    drop(db);
    mdbn_daemon::takeover::set_isolated_old_state_dir_for_tests(old.clone());
    // Keep control.sock below the Unix socket path limit in long builder worktrees.
    let profile = Profile::isolated(&root.join("s")).unwrap();
    let keys = Arc::new(MemoryStore::default());
    let (p, k) = (profile.clone(), keys.clone());
    let daemon = tokio::spawn(async move { server::run(p, Some(Box::new(k))).await });
    wait_ready(&profile).await;

    // An install without a current account must not touch the old device.
    let connector_before = std::fs::read(old.join("connector.sqlite")).unwrap();
    let authority_before = std::fs::read(old.join("authority.sqlite")).unwrap();
    let assert_untouched = || {
        assert_eq!(
            std::fs::read(old.join("connector.sqlite")).unwrap(),
            connector_before
        );
        assert_eq!(
            std::fs::read(old.join("authority.sqlite")).unwrap(),
            authority_before
        );
        assert_eq!(std::fs::read(notes.join("a.md")).unwrap(), b"A1");
        assert_eq!(std::fs::read(notes.join("c.md")).unwrap(), b"C user edit");
        assert!(!notes.join(".mdbase/connect-role.json").exists());
        assert!(!profile.state_dir.join("takeover.json").exists());
        assert!(!profile.state_dir.join("legacy").exists());
        assert!(!profile.store_ids_file().exists());
        assert!(!old.join("daemon.lock").exists());
    };
    let waiting = until("batch wait", || async {
        let s = status(&profile).await;
        (s["waiting_for_migration_batch"] == true).then_some(s)
    })
    .await;
    // Not signed in yet: that, not the account's upgrade, is what it waits for.
    assert_eq!(waiting["waiting_reason"], "sign_in");
    assert_untouched();
    let mut anon = ControlClient::connect(&profile.control).await.unwrap();
    match anon.call(Method::MIGRATE_START, json!({})).await {
        Err(ClientError::Remote(e)) => {
            assert_eq!(e.reason.as_deref(), Some("caller_not_authenticated"))
        }
        other => panic!("{other:?}"),
    }
    let mut c = ControlClient::connect(&profile.control).await.unwrap();
    let checks: Vec<Check> =
        serde_json::from_value(c.call(Method::DOCTOR, json!({})).await.unwrap()).unwrap();
    assert!(
        checks
            .iter()
            .any(|c| c.id == "takeover"
                && c.detail == "waiting for sign-in"
                && c.action.as_deref().is_some_and(|a| a.contains("Sign in to finish moving")))
    );

    use std::sync::atomic::{AtomicU8, AtomicUsize, Ordering};
    let mode = Arc::new(AtomicU8::new(0));
    let calls = Arc::new(AtomicUsize::new(0));
    let fixture = pairing::pair(&profile, &keys, mode.clone(), calls.clone()).await;
    until("authenticated rollout query", || async {
        (calls.load(Ordering::SeqCst) > 0).then_some(json!({}))
    })
    .await;
    assert_untouched();
    // Both a non-200 success-looking body and a released-but-still-legacy
    // account fail closed. Restart drives a fresh query, not cached permission.
    c.call(Method::SHUTDOWN, json!({})).await.unwrap();
    daemon.await.unwrap().unwrap();
    for denied in [2, 3, 4] {
        mode.store(denied, Ordering::SeqCst);
        let (p, k) = (profile.clone(), keys.clone());
        let d = tokio::spawn(async move { server::run(p, Some(Box::new(k))).await });
        wait_ready(&profile).await;
        until("denied batch", || async {
            let s = status(&profile).await;
            (s["waiting_for_migration_batch"] == true).then_some(s)
        })
        .await;
        assert_untouched();
        // An explicit move asks the same gate and changes nothing when refused:
        // the old connector keeps serving a legacy account.
        let mut c = ControlClient::connect(&profile.control).await.unwrap();
        c.authenticate(keys.as_ref()).await.unwrap();
        match c.call(Method::MIGRATE_START, json!({})).await {
            Err(ClientError::Remote(e)) => {
                assert_eq!(e.reason.as_deref(), Some("takeover_not_allowed"), "{e:?}");
                if denied == 3 {
                    assert!(e.message.contains("hasn't been upgraded"), "{e:?}");
                }
            }
            other => panic!("{other:?}"),
        }
        assert_untouched();
        assert_eq!(status(&profile).await["account_legacy"], denied == 3);
        assert_eq!(
            status(&profile).await["waiting_reason"],
            if denied == 3 { "account_not_upgraded" } else { "unreachable" }
        );
        if denied == 3 {
            // A control client cannot reintroduce the removed CLI bypass.
            match c
                .call(Method::MIGRATE_START, json!({"ignore_rollout": true}))
                .await
            {
                Err(ClientError::Remote(e)) => {
                    assert_eq!(e.reason.as_deref(), Some("takeover_not_allowed"))
                }
                other => panic!("{other:?}"),
            }
            assert_untouched();
            // Keep this daemon alive: status retains its last definite Legacy
            // answer, but the current Unknown answer must use retryable copy.
            mode.store(4, Ordering::SeqCst);
            match c.call(Method::MIGRATE_START, json!({})).await {
                Err(ClientError::Remote(e)) => {
                    assert_eq!(e.reason.as_deref(), Some("takeover_not_allowed"));
                    assert!(e.message.contains("couldn't confirm"), "{e:?}");
                    assert!(e.message.contains("try again"), "{e:?}");
                    assert!(!e.message.contains("hasn't been upgraded"), "{e:?}");
                }
                other => panic!("{other:?}"),
            }
            assert_eq!(status(&profile).await["account_legacy"], true);
            assert_untouched();
        }
        c.call(Method::SHUTDOWN, json!({})).await.unwrap();
        d.await.unwrap().unwrap();
    }
    mode.store(1, Ordering::SeqCst);
    let (p, k) = (profile.clone(), keys.clone());
    let daemon = tokio::spawn(async move { server::run(p, Some(Box::new(k))).await });
    wait_ready(&profile).await;

    // A flipped next account is permitted: settled, fenced and registered.
    let st = until("the takeover", || async {
        let s = status(&profile).await;
        (s["record"]["state"] == "complete"
            && s["record"]["collections"][old_agent::CID]["registered"] == true)
            .then_some(s)
    })
    .await;
    assert_eq!(st["held_interrupted_writes"], 2);
    let c = &st["record"]["collections"][old_agent::CID];
    assert_eq!(c["state"], "held", "{st}");
    assert!(
        c.get("rolled_forward").is_none(),
        "zero count is omitted by the record schema"
    );
    assert_eq!(c["holds"], 2);
    assert_eq!(c["registered"], true);
    assert_eq!(st["waiting_for_migration_batch"], false);
    assert_eq!(st["holds"][old_agent::CID][0]["path"], "a.md");
    assert_eq!(st["holds"][old_agent::CID][1]["path"], "c.md");
    assert_eq!(std::fs::read(notes.join("a.md")).unwrap(), b"A1");
    assert_eq!(std::fs::read(notes.join("c.md")).unwrap(), b"C user edit");
    assert!(matches!(
        marker::read(&notes).unwrap(),
        Marker::Claimed { .. }
    ));

    // Endpoint absence never becomes synthetic retirement success.
    let pending = until("pending retirement", || async {
        let s = status(&profile).await;
        (s["retirement"]["retired"] == false).then_some(s)
    })
    .await;
    assert_eq!(
        pending["retirement"]["reason"],
        "retirement_endpoint_unavailable"
    );

    // Registration keeps the old collection ID and name.
    let listed = until("registration", || async {
        let mut c = ControlClient::connect(&profile.control).await.unwrap();
        let v = c.call(Method::COLLECTION_LIST, json!({})).await.unwrap();
        let list: Vec<CollectionStatus> = serde_json::from_value(v).unwrap();
        list.into_iter()
            .find(|s| s.id == old_agent::CID)
            .map(|s| serde_json::to_value(s).unwrap())
    })
    .await;
    assert_eq!(listed["name"], "Notes");
    let st = until("the record to show registration", || async {
        let s = status(&profile).await;
        (s["record"]["collections"][old_agent::CID]["registered"] == true).then_some(s)
    })
    .await;
    assert_eq!(st["record"]["state"], "complete");

    // With no user action, the daemon turns Private sync on for the taken-over
    // collection (the ordinary sync enable). This hermetic control plane is not a
    // trusted one, so the attempt is refused: it is recorded, the takeover stands,
    // the collection keeps serving locally and no byte changes.
    let st = until("an automatic Private sync attempt", || async {
        let s = status(&profile).await;
        s["private_sync_pending"][old_agent::CID]["reason"]
            .is_string()
            .then_some(s)
    })
    .await;
    assert_eq!(st["record"]["state"], "complete");
    let first_reason = st["private_sync_pending"][old_agent::CID]["reason"].clone();
    let listed = until("the pending notice", || async {
        let mut c = ControlClient::connect(&profile.control).await.unwrap();
        let v = c.call(Method::COLLECTION_LIST, json!({})).await.unwrap();
        let list: Vec<CollectionStatus> = serde_json::from_value(v).unwrap();
        list.into_iter()
            .find(|s| s.id == old_agent::CID)
            .filter(|s| s.notices.iter().any(|n| n.code == "private_sync_pending"))
            .map(|s| serde_json::to_value(s).unwrap())
    })
    .await;
    let listed: CollectionStatus = serde_json::from_value(listed).unwrap();
    assert_eq!(listed.mode, mdbn_daemon::registry::SyncMode::Local);
    assert_eq!(listed.origin, mdbn_daemon::registry::Origin::MigratedLocal);
    assert_ne!(
        listed.state,
        mdbn_daemon::control::CollectionState::Paused,
        "a refused attempt never stops serving the folder"
    );
    assert_eq!(std::fs::read(notes.join("a.md")).unwrap(), b"A1");
    assert_eq!(std::fs::read(notes.join("b.md")).unwrap(), b"B");
    assert_eq!(std::fs::read(notes.join("c.md")).unwrap(), b"C user edit");

    // Doctor reports the held file.
    let mut c = ControlClient::connect(&profile.control).await.unwrap();
    let checks: Vec<Check> =
        serde_json::from_value(c.call(Method::DOCTOR, json!({})).await.unwrap()).unwrap();
    let t = checks.iter().find(|c| c.id == "takeover").unwrap();
    assert_eq!(t.status, "warn");
    assert!(
        t.detail
            .contains("2 interrupted legacy write/delete intent(s) held"),
        "{}",
        t.detail
    );
    // ... and that Private sync turns on by itself, with the last refusal.
    let adopt = checks
        .iter()
        .find(|c| c.id == format!("adopt:{}", old_agent::CID))
        .unwrap();
    assert!(
        adopt.detail.contains("Private sync is not on yet")
            && adopt.detail.contains(first_reason.as_str().unwrap()),
        "{}",
        adopt.detail
    );
    assert!(!adopt.detail.contains("sync is off"), "{}", adopt.detail);

    // The marker guard: removing the claim is an incident in doctor (live), never
    // rewritten; putting it back clears the live check (the run latch is separate).
    let claim = notes.join(".mdbase/connect-role.json");
    let saved = std::fs::read(&claim).unwrap();
    std::fs::remove_file(&claim).unwrap();
    let checks: Vec<Check> =
        serde_json::from_value(c.call(Method::DOCTOR, json!({})).await.unwrap()).unwrap();
    let t = checks.iter().find(|c| c.id == "takeover").unwrap();
    assert_eq!(t.status, "fail", "{}", t.detail);
    assert!(t.detail.contains("marker_incident"), "{}", t.detail);
    assert!(!claim.exists());
    std::fs::write(&claim, saved).unwrap();

    // An explicit run asks for fresh rollout permission too, then retires.
    mode.store(5, Ordering::SeqCst); // fixture retirement endpoint now available
    c.authenticate(keys.as_ref()).await.unwrap();
    let before_calls = calls.load(Ordering::SeqCst);
    let confirmed = c.call(Method::MIGRATE_START, json!({})).await.unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), before_calls + 1);
    assert_eq!(confirmed["account_legacy"], false);
    assert_eq!(
        confirmed["retirement"],
        json!({"retired":true,
        "legacy_connector_id":"44444444-4444-4444-8444-444444444444"})
    );

    // A restart with Connect unreachable leaves evidence unchanged and still serves.
    // The closed gate guards starting only: an old daemon revived meanwhile (it holds
    // daemon.lock) is still reported.
    fixture.abort();
    let evidence = std::fs::read(profile.state_dir.join("takeover.json")).unwrap();
    c.call(Method::SHUTDOWN, json!({})).await.unwrap();
    daemon.await.unwrap().unwrap();
    let revived_old = std::fs::File::create(old.join("daemon.lock")).unwrap();
    revived_old.try_lock().unwrap();
    let (p, k) = (profile.clone(), keys.clone());
    let daemon = tokio::spawn(async move { server::run(p, Some(Box::new(k))).await });
    wait_ready(&profile).await;
    let mut c = ControlClient::connect(&profile.control).await.unwrap();
    // While the old daemon runs, the taken-over folder is not opened (an old daemon
    // from before the marker check would write to it too), and adopt is refused.
    let collection = |v: Value| -> CollectionStatus {
        serde_json::from_value::<Vec<CollectionStatus>>(v)
            .unwrap()
            .into_iter()
            .find(|s| s.id == old_agent::CID)
            .unwrap()
    };
    let blocked = collection(c.call(Method::COLLECTION_LIST, json!({})).await.unwrap());
    assert_eq!(
        blocked.reason.as_deref(),
        Some("old_connector_running"),
        "{blocked:?}"
    );
    assert!(
        blocked
            .notices
            .iter()
            .any(|n| n.code == "old_connector_running")
    );
    c.authenticate(keys.as_ref()).await.unwrap();
    match c
        .call(Method::SYNC_ENABLE, json!({"collection": old_agent::CID}))
        .await
    {
        Err(ClientError::Remote(e)) => {
            assert_eq!(e.reason.as_deref(), Some("old_connector_running"))
        }
        other => panic!("{other:?}"),
    }
    let st = status(&profile).await;
    assert_eq!(st["record"]["state"], "complete");
    let st = until("unreachable batch wait", || async {
        let s = status(&profile).await;
        (s["waiting_for_migration_batch"] == true).then_some(s)
    })
    .await;
    assert_eq!(st["revived"], true, "{st}");
    drop(revived_old);
    // Once it stops, the collection reopens on its own.
    until("reopen after the old daemon stopped", || async {
        let mut c = ControlClient::connect(&profile.control).await.unwrap();
        let v = c.call(Method::COLLECTION_LIST, json!({})).await.unwrap();
        let s = collection(v);
        (s.reason.is_none() && s.state == mdbn_daemon::control::CollectionState::Ready)
            .then_some(json!(null))
    })
    .await;
    assert_eq!(
        std::fs::read(profile.state_dir.join("takeover.json")).unwrap(),
        evidence
    );
    assert_eq!(std::fs::read(notes.join("a.md")).unwrap(), b"A1");
    // The restart retried turning Private sync on (failures are not persisted):
    // Connect is unreachable now, so it waits for the next attempt, still local.
    let st = until("a retry after the restart", || async {
        let s = status(&profile).await;
        (s["private_sync_pending"][old_agent::CID]["reason"] == "sync_unreachable").then_some(s)
    })
    .await;
    assert_eq!(st["record"]["state"], "complete");
    let s = collection(c.call(Method::COLLECTION_LIST, json!({})).await.unwrap());
    assert_eq!(s.mode, mdbn_daemon::registry::SyncMode::Local);
    assert_eq!(std::fs::read(notes.join("c.md")).unwrap(), b"C user edit");
    c.call(Method::SHUTDOWN, json!({})).await.unwrap();
    daemon.await.unwrap().unwrap();
}
