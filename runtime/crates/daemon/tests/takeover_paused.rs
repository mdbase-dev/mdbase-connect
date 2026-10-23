//! Legacy disabled/access-paused intent is durable before takeover hosts open.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU8, AtomicUsize};
use std::time::Duration;

use mdbn_daemon::client::{self, ControlClient};
use mdbn_daemon::control::{CollectionState, CollectionStatus, Method};
use mdbn_daemon::paths::Profile;
use mdbn_daemon::registry::{Origin, Registry, SyncMode};
use mdbn_daemon::secrets::MemoryStore;
use mdbn_daemon::{auto_private, server};
use serde_json::json;

#[path = "fixtures/old_agent.rs"]
mod old_agent;
#[path = "fixtures/takeover_rollout.rs"]
mod pairing;

async fn wait_ready(profile: &Profile) {
    for _ in 0..300 {
        if client::ping(&profile.control).await.is_ok_and(|r| r.ready) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("daemon did not become ready");
}

async fn registered(profile: &Profile, paused: bool) -> CollectionStatus {
    let mut c = ControlClient::connect(&profile.control).await.unwrap();
    for _ in 0..300 {
        let status = c.call(Method::MIGRATE_STATUS, json!({})).await.unwrap();
        if status["record"]["collections"][old_agent::CID]["registered"] == true {
            let list: Vec<CollectionStatus> =
                serde_json::from_value(c.call(Method::COLLECTION_LIST, json!({})).await.unwrap())
                    .unwrap();
            if let Some(s) = list.into_iter().find(|s| s.id == old_agent::CID) {
                if paused {
                    assert_eq!(s.state, CollectionState::Paused);
                    assert!(status["private_sync_pending"][old_agent::CID].is_null());
                    return s;
                }
                if s.state == CollectionState::Ready
                    && status["private_sync_pending"][old_agent::CID]["reason"].is_string()
                {
                    return s;
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("takeover registration did not settle (paused={paused})");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn legacy_pauses_survive_registration_and_restart_without_private_sync() {
    // One old path for this test binary's isolated-profile OnceLock.
    let root = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("tp{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let old = root.join("connect");
    let notes = root.join("notes");
    mdbn_daemon::takeover::set_isolated_old_state_dir_for_tests(old.clone());

    for (index, (tag, enabled, overlay, profile_paused, paused)) in [
        ("active", true, true, false, false),
        ("disabled", false, true, false, true),
        ("overlay", true, false, false, true),
        ("profile", true, true, true, true),
    ]
    .into_iter()
    .enumerate()
    {
        old_agent::build(&old, &notes);
        let db = rusqlite::Connection::open(old.join("connector.sqlite")).unwrap();
        db.execute("UPDATE collections SET enabled = ?1", [enabled])
            .unwrap();
        drop(db);
        let db = rusqlite::Connection::open(old.join("authority.sqlite")).unwrap();
        db.execute(
            "INSERT INTO collection_access_overlays VALUES (?1, ?2, 0)",
            rusqlite::params![old_agent::CID, overlay],
        )
        .unwrap();
        db.execute(
            "INSERT INTO authority_settings VALUES ('access_paused', ?1, 0)",
            [if profile_paused { "true" } else { "false" }],
        )
        .unwrap();
        drop(db);
        let old_before =
            ["connector.sqlite", "authority.sqlite"].map(|p| std::fs::read(old.join(p)).unwrap());
        let profile = Profile::isolated(&root.join(format!("s{index}"))).unwrap();
        let keys = Arc::new(MemoryStore::default());
        let (p, k) = (profile.clone(), keys.clone());
        let daemon = tokio::spawn(async move { server::run(p, Some(Box::new(k))).await });
        wait_ready(&profile).await;
        let fixture = pairing::pair(
            &profile,
            &keys,
            Arc::new(AtomicU8::new(1)),
            Arc::new(AtomicUsize::new(0)),
        )
        .await;
        let status = registered(&profile, paused).await;
        assert_eq!(status.origin, Origin::MigratedLocal, "{tag}");
        assert_eq!(status.mode, SyncMode::Local, "{tag}");
        assert_eq!(status.name, "Notes", "{tag}");
        let registry = Registry::load(&profile.registry_file()).unwrap();
        assert_eq!(
            registry.get(old_agent::CID).unwrap().paused,
            paused,
            "{tag}"
        );
        assert_eq!(
            auto_private::candidates(
                &registry.collections,
                &profile.state_dir.join("collections")
            ),
            if paused {
                vec![]
            } else {
                vec![old_agent::CID.to_owned()]
            },
            "{tag}"
        );

        let mut c = ControlClient::connect(&profile.control).await.unwrap();
        c.call(Method::SHUTDOWN, json!({})).await.unwrap();
        daemon.await.unwrap().unwrap();
        let (p, k) = (profile.clone(), keys.clone());
        let daemon = tokio::spawn(async move { server::run(p, Some(Box::new(k))).await });
        wait_ready(&profile).await;
        registered(&profile, paused).await;
        let mut c = ControlClient::connect(&profile.control).await.unwrap();
        c.call(Method::SHUTDOWN, json!({})).await.unwrap();
        daemon.await.unwrap().unwrap();
        fixture.abort();
        let _ = fixture.await;

        assert_eq!(
            ["connector.sqlite", "authority.sqlite"].map(|p| std::fs::read(old.join(p)).unwrap()),
            old_before,
            "{tag}: legacy databases stay untouched"
        );
        assert_eq!(std::fs::read(notes.join("a.md")).unwrap(), b"A1");
        assert_eq!(std::fs::read(notes.join("c.md")).unwrap(), b"C user edit");
        std::fs::remove_dir_all(&old).unwrap();
        std::fs::remove_dir_all(&notes).unwrap();
    }
    std::fs::remove_dir_all(root).unwrap();
}
