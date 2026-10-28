// DRAFT ONLY: place as a child module of server::tests (server_tests.rs), so
// paired_daemon/daemon and private Daemon methods remain accessible.
// Read against ml-diag's retain_failed_capture implementation, 2026-10-13.
// No builds run. Miglocal owns integration/producer changes and chooses naming.
// Coverage below is a REAL terminal resource capture / stopped original actor,
// original bytes, durable paused entry, reconstructed restart host and save
// failure. It does NOT claim an original pending/unknown mutation fixture or a
// bootstrap-dispatch counter. Those need the owning native test seam; see end.

use super::*;

#[path = "server_capture_holds_tests.rs"]
mod holds_tests;
#[path = "server_native_pending_tests.rs"]
mod native_pending_tests;

const CAPTURE_CONFIG: &[u8] = b"spec_version: 0.3.0\nsettings:\n  timezone: UTC\n";

struct CaptureFixture {
    _profile: crate::testutil::TestDir,
    folder: crate::testutil::TestDir,
    daemon: Arc<Daemon>,
    id: String,
    runtime: Arc<crate::runtime::Runtime>,
    note: Vec<u8>,
    bootstrap: std::net::TcpListener,
}

async fn capture_fixture(tag: &str) -> CaptureFixture {
    let profile = crate::testutil::TestDir::new(tag);
    let folder = crate::testutil::TestDir::new(&format!("{tag}-folder"));
    let note = b"---\ntitle: '[test] original capture source'\n---\nOriginal toy bytes\n".to_vec();
    std::fs::write(folder.path().join("original.md"), &note).unwrap();
    // Initial fixture state, before the watcher starts. A post-start config
    // write races its quiet-window marker even when inventory requests a rescan.
    std::fs::write(folder.path().join("mdbase.yaml"), CAPTURE_CONFIG).unwrap();
    // Private hermetic CP pin: never let a failed guard reach real LAB.
    // Holding the listener proves no bootstrap/enrolment request was dispatched.
    let bootstrap = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    bootstrap.set_nonblocking(true).unwrap();
    let origin = format!("http://{}", bootstrap.local_addr().unwrap());
    let mut daemon = daemon(&profile);
    let mut trust = crate::trust::fixture_trust();
    trust.cp_origin = origin.clone();
    {
        let owned = Arc::get_mut(&mut daemon).unwrap();
        owned.trust = Some(Arc::new(trust));
        // The generic helper generates an unrelated identity. Start this fixture
        // through normal durable identity initialization BEFORE pairing/adding.
        owned.identity = Default::default();
    }
    initialize(daemon.clone()).await;
    assert!(daemon.is_ready());
    let epoch = daemon.begin_pairing().await.unwrap();
    daemon
        .publish_pairing(
            epoch,
            crate::cloud::CloudConfig {
                schema_version: 1,
                account_epoch: epoch,
                connector_id: Some("connector".into()),
                server_url: origin,
                ..Default::default()
            },
            "11111111-1111-4111-8111-111111111111",
            b"con_hermetic_fixture",
        )
        .await
        .unwrap();
    let added = daemon
        .add(crate::control::AddCollection {
            path: folder.path().to_path_buf(),
            name: Some("[test] original source".into()),
        })
        .await
        .unwrap();
    let id = added["id"].as_str().unwrap().to_owned();
    let barrier = daemon
        .inner
        .lock()
        .await
        .hosts
        .iter()
        .find(|host| host.entry().id == id)
        .unwrap()
        .barrier()
        .expect("opener has a retained runtime slot");
    tokio::time::timeout(Duration::from_secs(20), barrier.wait())
        .await
        .expect("background opener barrier completes");
    daemon.serving(&id).await.unwrap();
    let runtime = daemon
        .inner
        .lock()
        .await
        .hosts
        .iter()
        .find(|host| host.entry().id == id)
        .unwrap()
        .runtime()
        .unwrap();
    assert!(
        runtime.readiness().await.is_some(),
        "fixture has no live original actor"
    );
    CaptureFixture {
        _profile: profile,
        folder,
        daemon,
        id,
        runtime,
        note,
        bootstrap,
    }
}

async fn close_fixture(f: &CaptureFixture) {
    let mut inner = f.daemon.inner.lock().await;
    for host in &mut inner.hosts {
        host.close().await;
    }
    drop(inner);
    f.daemon.shutdown.send_replace(true);
    if let Some(task) = f.daemon.account.lock().unwrap().relay.take() {
        task.abort();
    }
    if let Some(link) = f.daemon.link.lock().unwrap().take() {
        link.stop();
    }
}

async fn assert_retained_capture(f: &CaptureFixture, original: &crate::registry::Entry) {
    let inner = f.daemon.inner.lock().await;
    let entry = inner.registry.get(&f.id).unwrap();
    assert!(
        entry.paused,
        "uncertain source must remain paused in memory"
    );
    assert_eq!(entry.id, original.id);
    assert_eq!(entry.root, original.root);
    assert_eq!(entry.replica_id, original.replica_id);
    assert_eq!(entry.mode, original.mode);
    assert_eq!(entry.owner_account, original.owner_account);
    assert_eq!(entry.device, original.device);
    let host = inner
        .hosts
        .iter()
        .find(|host| host.entry().id == f.id)
        .unwrap();
    assert!(!host.is_serving());
    assert!(
        host.runtime().is_none(),
        "original host implicitly reopened a runtime"
    );
    assert!(host.entry().paused);
    drop(inner);
    assert!(f.daemon.serving(&f.id).await.is_err());
    assert!(
        f.runtime.readiness().await.is_none(),
        "original writers were not stopped"
    );
    assert_eq!(
        std::fs::read(f.folder.path().join("original.md")).unwrap(),
        f.note
    );
    let journal =
        crate::adopt::Journal::path(&f.daemon.profile.state_dir.join("collections"), &f.id);
    assert!(
        crate::adopt::Journal::load(&journal).unwrap().is_none(),
        "failed capture created an adopt/Base journal"
    );
    assert_no_collection_bootstrap(f);
}

fn assert_no_collection_bootstrap(f: &CaptureFixture) {
    // Pairing/add can publish the ordinary connector inventory. Observe ALL
    // completed fixture requests; the forbidden lane is collection bootstrap/
    // enrolment, not unrelated pre-capture account inventory publication.
    loop {
        let (mut socket, _) = match f.bootstrap.accept() {
            Ok(v) => v,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
            Err(_) => panic!("fixture request observer failed"),
        };
        use std::io::Read as _;
        socket
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut bytes = [0; 4096];
        let n = socket
            .read(&mut bytes)
            .expect("fixture request headers observed");
        let header = std::str::from_utf8(&bytes[..n]).unwrap();
        assert!(
            !header.contains("/v1/next/collections"),
            "failed capture dispatched bootstrap/enrolment"
        );
    }
}

#[tokio::test]
async fn terminal_capture_sync_enable_retains_original_paused_source_without_base() {
    let f = capture_fixture("capture-terminal-stop").await;
    let original = f
        .daemon
        .inner
        .lock()
        .await
        .registry
        .get(&f.id)
        .unwrap()
        .clone();
    // The collection was already serving. Freeze's requested full rescan must
    // detect this actual unsupported resource; no fake status/pending count.
    let invalid = b"spec_version: 99.0.0\nsettings:\n  timezone: UTC\n";
    std::fs::write(f.folder.path().join("mdbase.yaml"), invalid).unwrap();
    let outcome = f
        .daemon
        .enable_sync(EnableSync {
            collection: f.id.clone(),
            mode: None,
            accept_takeover_holds: false,
        })
        .await;
    assert_eq!(
        outcome.unwrap_err().reason.as_deref(),
        Some("source_capture_incomplete")
    );
    assert_retained_capture(&f, &original).await;
    assert_eq!(
        std::fs::read(f.folder.path().join("mdbase.yaml")).unwrap(),
        invalid
    );
    let saved = Registry::load(&f.daemon.profile.registry_file()).unwrap();
    let persisted = saved.get(&f.id).unwrap().clone();
    assert!(persisted.paused, "stop must survive a process restart");
    assert_eq!(persisted.id, original.id);
    assert_eq!(persisted.replica_id, original.replica_id);
    assert_eq!(persisted.owner_account, original.owner_account);
    // Explicitly narrower than a full daemon restart: production host
    // reconstruction from the actual disk registry must not initialize an actor.
    let mut restarted = crate::collections::CollectionHost::open(persisted, None);
    assert_eq!(restarted.state(), crate::control::CollectionState::Paused);
    assert!(restarted.runtime().is_none());
    assert!(!restarted.is_serving());
    restarted.refresh();
    assert_eq!(restarted.state(), crate::control::CollectionState::Paused);
    assert!(restarted.runtime().is_none());
    restarted.close().await;
    close_fixture(&f).await;
}

#[tokio::test]
async fn stopped_original_actor_none_cannot_silently_restart_during_sync_enable() {
    let f = capture_fixture("capture-stopped-actor").await;
    let original = f
        .daemon
        .inner
        .lock()
        .await
        .registry
        .get(&f.id)
        .unwrap()
        .clone();
    // REAL None path: the host still owns the original runtime handle but its
    // actor no longer answers Freeze. This is not a pending-mutation simulation.
    f.runtime.stop().await;
    let outcome = f
        .daemon
        .enable_sync(EnableSync {
            collection: f.id.clone(),
            mode: None,
            accept_takeover_holds: false,
        })
        .await;
    assert_eq!(
        outcome.unwrap_err().reason.as_deref(),
        Some("source_capture_incomplete")
    );
    assert_retained_capture(&f, &original).await;
    let saved = Registry::load(&f.daemon.profile.registry_file()).unwrap();
    assert!(saved.get(&f.id).unwrap().paused);
    // Exercise the same maintenance refresh that used to reopen the host.
    let mut inner = f.daemon.inner.lock().await;
    let host = inner
        .hosts
        .iter_mut()
        .find(|host| host.entry().id == f.id)
        .unwrap();
    host.refresh();
    assert!(host.entry().paused);
    assert!(!host.is_serving());
    assert!(host.runtime().is_none());
    drop(inner);
    close_fixture(&f).await;
}

#[tokio::test]
async fn capture_stop_registry_save_failure_fences_memory_and_original_writers() {
    let f = capture_fixture("capture-stop-save-failure").await;
    let original = f
        .daemon
        .inner
        .lock()
        .await
        .registry
        .get(&f.id)
        .unwrap()
        .clone();
    let registry = f.daemon.profile.registry_file();
    // Deterministic fixture-only rename failure: an atomic file replacement
    // cannot replace a directory. Retain the original disk registry as evidence.
    let evidence = registry.with_extension("original-evidence.json");
    std::fs::rename(&registry, &evidence).unwrap();
    std::fs::create_dir(&registry).unwrap();
    assert!(f.daemon.retain_failed_capture(&f.id).await.is_err());
    assert_retained_capture(&f, &original).await;
    assert!(
        f.daemon.authority.incarnation().is_none(),
        "failed durable save must invalidate serving authority"
    );
    let mut inner = f.daemon.inner.lock().await;
    let host = inner
        .hosts
        .iter_mut()
        .find(|host| host.entry().id == f.id)
        .unwrap();
    host.refresh();
    assert!(host.runtime().is_none());
    assert!(!host.is_serving());
    drop(inner);
    let old_disk = Registry::load(&evidence).unwrap();
    assert_eq!(old_disk.get(&f.id).unwrap().id, original.id);
    assert_eq!(old_disk.get(&f.id).unwrap().replica_id, original.replica_id);
    // Deliberately NO claim of restart-paused/durable success after a failed
    // registry write. In-memory fencing and preservation are the proven target.
    close_fixture(&f).await;
}

// OWNER FOLLOW-UP REQUIRED BEFORE pending/unknown qualification:
// - Add a real native pending/unknown fixture at the existing store/transport
//   fault seam (same signed original owner/actor, actual durable PendingRow or
//   original in-flight append). Do NOT substitute a toy marker file or fake
//   SyncStatus.pending. Compare native mutation identity/receipt classification
//   before/after capture refusal and after a full daemon restart with original
//   secrets/registration/account incarnation; assert no implicit rejection,
//   replay, replacement actor/grant, Base or bootstrap dispatch.
// - Above terminal/actor-lost tests use the ordinary enable_sync path and assert
//   no adopt journal. Add an existing bootstrap dispatch spy/loopback fixture
//   count=0 if available; absence of a journal alone is NOT proof of no network.
// - Add a successful captured-Frozen/holds-only refusal positive control with
//   known original outcomes to preserve safe ordinary resume semantics.
// - No assertions may be weakened to accommodate a pre-freeze fixture refusal.
