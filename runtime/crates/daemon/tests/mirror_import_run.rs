//! An explicit retry uses the same fresh moved-account proof as startup;
//! it does not need an additional stop-mirrors acknowledgement.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU8, AtomicUsize, Ordering};
use std::time::Duration;

use mdbn_daemon::client::{self, ControlClient};
use mdbn_daemon::control::Method;
use mdbn_daemon::paths::Profile;
use mdbn_daemon::secrets::MemoryStore;
use mdbn_daemon::{server, takeover};
use serde_json::json;

#[path = "fixtures/hosted_mirror.rs"]
mod hosted_mirror;
#[path = "fixtures/old_agent.rs"]
mod old_agent;
#[path = "fixtures/takeover_rollout.rs"]
mod pairing;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn explicit_retry_captures_mirrors_after_fresh_moved_permission() {
    let root = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("mr{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let old = root.join("connect");
    old_agent::build(&old, &root.join("notes"));
    let entry = hosted_mirror::build(&old, &root.join("Hosted notes"));
    let registry_before = std::fs::read(old.join("mirrors.json")).unwrap();
    let state_file = old
        .join("mirrors")
        .join(hosted_mirror::MIRROR)
        .join("state.json");
    let state_before = std::fs::read(&state_file).unwrap();
    takeover::set_isolated_old_state_dir_for_tests(old.clone());
    let profile = Profile::isolated(&root.join("s")).unwrap();
    let keys = Arc::new(MemoryStore::default());
    let (p, k) = (profile.clone(), keys.clone());
    let daemon = tokio::spawn(async move { server::run(p, Some(Box::new(k))).await });
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    loop {
        if client::ping(&profile.control).await.is_ok_and(|r| r.ready) {
            break;
        }
        assert!(std::time::Instant::now() < deadline, "daemon did not start");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let mode = Arc::new(AtomicU8::new(0));
    let calls = Arc::new(AtomicUsize::new(0));
    let fixture = pairing::pair(&profile, &keys, mode.clone(), calls.clone()).await;
    let mut control = ControlClient::connect(&profile.control).await.unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    loop {
        let status = control
            .call(Method::MIGRATE_STATUS, json!({}))
            .await
            .unwrap();
        if calls.load(Ordering::SeqCst) > 0
            && status["account_legacy"] == true
            && status["waiting_for_migration_batch"] == true
        {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "startup did not wait: {status}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let legacy = profile.state_dir.join("legacy");
    assert!(
        takeover::mirror_import::Capture::load(&legacy, hosted_mirror::HOSTED)
            .unwrap()
            .is_none()
    );

    // No restart or automatic retry: only this authenticated explicit command
    // observes the newly permitted account. No stop-mirrors flag is supplied.
    control.authenticate(keys.as_ref()).await.unwrap();
    let before_calls = calls.load(Ordering::SeqCst);
    mode.store(1, Ordering::SeqCst);
    let status = control
        .call(Method::MIGRATE_START, json!({}))
        .await
        .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), before_calls + 1);
    assert_eq!(status["record"]["state"], "complete", "{status}");
    assert_eq!(
        status["mirror_imports"][hosted_mirror::HOSTED]["edits"],
        6,
        "{status}"
    );
    let capture = takeover::mirror_import::Capture::load(&legacy, hosted_mirror::HOSTED)
        .unwrap()
        .expect("an explicit permitted retry must capture the unsent edits");
    assert_eq!(capture.edits.len(), 6);
    let digest = mdbn_legacy::revision_of(&hosted_mirror::BINARY);
    assert_eq!(
        capture
            .bytes(&legacy, digest.strip_prefix("sha256:").unwrap())
            .unwrap(),
        hosted_mirror::BINARY
    );
    assert_eq!(
        std::fs::read(old.join("mirrors.json")).unwrap(),
        registry_before
    );
    assert_eq!(std::fs::read(state_file).unwrap(), state_before);
    assert_eq!(
        std::fs::read(entry.path.join("d.md")).unwrap(),
        hosted_mirror::BINARY
    );
    control.call(Method::SHUTDOWN, json!({})).await.unwrap();
    daemon.await.unwrap().unwrap();
    fixture.abort();
    std::fs::remove_dir_all(root).unwrap();
}
