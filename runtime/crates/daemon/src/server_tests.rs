//! Security regression tests for consent and feed persistence boundaries.
use super::*;
use crate::access::{AccessState, FeedCursor};
use crate::confirm::{Answer, Confirmer};
use std::collections::BTreeMap;
use std::sync::Arc;

#[test]
fn hold_summary_marks_both_binary_profiles_without_exposing_content() {
    use mdbn_wire::{schema::Wire, snapshot::TextOrBlob};
    let hex = include_str!("../../wire/tests/fixtures/attachment-hold.hex").trim();
    let bytes: Vec<_> = (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
        .collect();
    let attachment = mdbn_wire::client::Hold::from_bytes(&bytes).unwrap();
    let summary = hold_summary(&attachment);
    assert!(summary.binary);
    assert_eq!(summary.path, attachment.path);
    assert!(summary.has_theirs);
    let projection = serde_json::to_value(summary).unwrap();
    for key in ["mine", "base", "theirs", "content", "reference"] {
        assert!(projection.get(key).is_none(), "content-free UI projection");
    }
    let fixture = mdbn_wire::fixtures::all()
        .into_iter()
        .find(|f| f.format == "client" && f.name == "hold-file")
        .unwrap();
    let mut legacy = mdbn_wire::client::Hold::from_bytes(&fixture.bytes).unwrap();
    assert!(hold_summary(&legacy).binary);
    legacy.mine = TextOrBlob::Text("private held text".into());
    assert!(!hold_summary(&legacy).binary);
}

pub(super) fn daemon(dir: &crate::testutil::TestDir) -> Arc<Daemon> {
    let d = Arc::new(Daemon {
        profile: Profile::isolated(dir.path()).unwrap(),
        started_at_ms: 0,
        secrets: Arc::new(crate::secrets::MemoryStore::default()),
        readiness: watch::channel(readiness(true, None)).0,
        changes: watch::channel(0).0,
        access_events: tokio::sync::broadcast::channel(64).0,
        control_key: std::sync::OnceLock::new(),
        account: std::sync::Mutex::new(Account::default()),
        account_gate: Mutex::new(()),
        link_prompt: Mutex::new(()),
        authority: crate::authority::Authority::default(),
        confirmer: std::sync::RwLock::new(Arc::new(crate::confirm::Fixed(Answer::Yes))),
        online: std::sync::atomic::AtomicBool::new(false),
        link: std::sync::Mutex::new(None),
        // Synthetic, public environment pins; real asset verification is tested
        // separately by trust_tests with the LAB feature enabled.
        trust: Some(Arc::new(crate::trust::fixture_trust())),
        shutdown: watch::channel(false).0,
        identity: std::sync::OnceLock::new(),
        account_keys: Default::default(),
        takeover: Default::default(),
        inner: Mutex::new(Inner {
            registry: Registry {
                collections: vec![crate::registry::Entry {
                    id: "c".into(),
                    name: "Notes".into(),
                    root: dir.path().join("notes"),
                    replica_id: "r".into(),
                    mode: SyncMode::Local,
                    origin: crate::registry::Origin::Created,
                    added_at_ms: 0,
                    paused: false,
                    ever_e2e: false,
                    owner_account: None,
                    device: None,
                }],
                ..Default::default()
            },
            access: AccessList::default(),
            hosts: Vec::new(),
            device: None,
            init_error: None,
        }),
    });
    d.identity
        .set(Arc::new(DeviceIdentity::generate().unwrap()))
        .unwrap();
    d
}
/// Hold each startup barrier directly: no sleep or scheduler-dependent race.
#[tokio::test]
async fn readiness_waits_for_account_resume_and_host_refresh() {
    use std::future::{Future, poll_fn};
    use std::task::Poll;

    let dir = crate::testutil::TestDir::new("startup-order");
    let d = daemon(&dir);
    d.readiness
        .send_replace(readiness(false, Some(NotReady::Starting)));
    let account_gate = d.account_gate.lock().await;
    let init = initialize(d.clone());
    tokio::pin!(init);

    // Identity and registry initialization finish, but account resume cannot.
    poll_fn(|cx| {
        assert!(init.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    assert!(d.inner.lock().await.device.is_some());
    assert!(
        !d.is_ready(),
        "readiness was published before account resume"
    );

    // Allow account resume but prevent the subsequent collection refresh.
    let inner = d.inner.lock().await;
    drop(account_gate);
    poll_fn(|cx| {
        assert!(init.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    assert!(!d.is_ready(), "readiness was published before host refresh");
    drop(inner);

    init.await;
    assert!(d.is_ready());
    // Signed-out startup is still ready; it does not manufacture an account.
    assert!(d.authority.incarnation().is_none());
    d.shutdown.send_replace(true);
    if let Some(link) = d.link.lock().unwrap_or_else(|p| p.into_inner()).take() {
        link.stop();
    }
}

async fn paired_daemon(dir: &crate::testutil::TestDir) -> Arc<Daemon> {
    let d = daemon(dir);
    let epoch = d.begin_pairing().await.unwrap();
    let cfg = crate::cloud::CloudConfig {
        schema_version: 1,
        account_epoch: epoch,
        connector_id: Some("connector".into()),
        server_url: "http://127.0.0.1:9".into(),
        ..Default::default()
    };
    d.publish_pairing(
        epoch,
        cfg,
        "11111111-1111-4111-8111-111111111111",
        b"con_hermetic_fixture",
    )
    .await
    .unwrap();
    d
}

fn grant(pk: u8) -> CachedGrant {
    CachedGrant {
        grant: "g".into(),
        account_id: Some("11111111-1111-4111-8111-111111111111".into()),
        collection: "c".into(),
        app_id: "app".into(),
        app_name: "Reader".into(),
        client_pk: secrets::hex(&[pk; 32]),
        capabilities: vec!["collection.read".into()],
        folders: Some(vec!["Photos".into()]),
        legacy_only: false,
    }
}
fn snapshot(seq: u64) -> crate::relay::Snapshot {
    crate::relay::Snapshot {
        request_id: seq.to_string(),
        revision: format!("rev{seq}"),
        connector_id: "connector".into(),
        sequence: seq,
        account_epoch: 1,
        lease_expires_ms: fsutil::now_ms() as u64 + 55_000,
        lease_deadline: std::time::Instant::now() + Duration::from_secs(55),
        grants: vec![],
    }
}
fn grants(g: Option<CachedGrant>) -> BTreeMap<String, Vec<CachedGrant>> {
    BTreeMap::from([("c".into(), g.into_iter().collect())])
}

struct Suspended {
    shown: tokio::sync::Notify,
    answer: tokio::sync::Notify,
    message: std::sync::Mutex<String>,
}
impl Confirmer for Suspended {
    fn ask<'a>(&'a self, _: &'a str, message: &'a str) -> crate::session::BoxFuture<'a, Answer> {
        Box::pin(async move {
            *self.message.lock().unwrap() = message.into();
            self.shown.notify_one();
            self.answer.notified().await;
            Answer::Yes
        })
    }
}

#[tokio::test]
async fn displayed_consent_cannot_approve_replacement_or_aba() {
    for aba in [false, true] {
        let dir = crate::testutil::TestDir::new("consent");
        let d = daemon(&dir);
        d.inner.lock().await.access.require_grant_approval = true;
        d.apply_control_plane_grants("c", &[grant(1)], fsutil::now_ms() as u64 + 55_000)
            .await
            .unwrap();
        let before = d.inner.lock().await.access.entries[0].clone();
        let c = Arc::new(Suspended {
            shown: Default::default(),
            answer: Default::default(),
            message: Default::default(),
        });
        d.set_confirmer(c.clone());
        let d2 = d.clone();
        let task = tokio::spawn(async move {
            let req = Request {
                v: PROTOCOL,
                id: 1,
                method: Method::ACCESS_APPROVE.into(),
                params: json!({"grant":"g"}),
            };
            d2.handle(
                &req,
                &mut ConnAuth {
                    privileged: true,
                    ..Default::default()
                },
            )
            .await
        });
        c.shown.notified().await;
        assert!(
            c.message.lock().unwrap().contains("Photos"),
            "folder scope disclosed"
        );
        let mut replacement = grant(2);
        replacement.capabilities.push("collection.write".into());
        replacement.folders = Some(vec!["Private".into()]);
        d.apply_control_plane_grants("c", &[replacement], fsutil::now_ms() as u64 + 55_000)
            .await
            .unwrap();
        if aba {
            d.apply_control_plane_grants("c", &[grant(1)], fsutil::now_ms() as u64 + 55_000)
                .await
                .unwrap();
        }
        c.answer.notify_one();
        let error = task.await.unwrap().unwrap_err();
        assert_eq!(error.reason.as_deref(), Some("consent_changed"));
        let inner = d.inner.lock().await;
        assert_eq!(inner.access.entries[0].state, AccessState::PendingApproval);
        assert!(inner.access.entries[0].generation > before.generation);
        let current = inner.access.entries[0].clone();
        drop(inner);
        d.approve_confirmed(&current).await.unwrap();
        assert_eq!(
            d.inner.lock().await.access.entries[0].state,
            AccessState::Active,
            "fresh consent works"
        );
    }
}

#[tokio::test]
async fn silent_pending_removal_and_lease_renewal_are_durable() {
    let dir = crate::testutil::TestDir::new("silent-feed");
    let d = paired_daemon(&dir).await;
    d.inner.lock().await.access.require_grant_approval = true;
    d.apply_control_plane_grants("c", &[grant(1)], fsutil::now_ms() as u64 + 30_000)
        .await
        .unwrap();
    assert!(
        d.apply_control_plane_grants("c", &[], fsutil::now_ms() as u64 + 31_000)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(d.inner.lock().await.access.entries.is_empty());
    assert!(
        AccessList::load(&d.profile.access_file())
            .unwrap()
            .entries
            .is_empty()
    );
    d.inner.lock().await.access.require_grant_approval = false;
    let initial = snapshot(1);
    d.commit_control_plane_feed(&initial, &grants(Some(grant(1))))
        .await
        .unwrap();
    let mut renew = snapshot(2);
    renew.lease_expires_ms = initial.lease_expires_ms + 10_000;
    let mut events = d.access_events.subscribe();
    d.commit_control_plane_feed(&renew, &grants(Some(grant(1))))
        .await
        .unwrap();
    assert!(
        events.try_recv().is_err(),
        "lease-only renewal emits no notification"
    );
    let loaded = AccessList::load(&d.profile.access_file()).unwrap();
    assert_eq!(loaded.leases["c"], renew.lease_expires_ms);
    assert_eq!(loaded.feed_cursor.as_ref().unwrap().sequence, 2);
    assert!(
        d.inner
            .lock()
            .await
            .access
            .authorize("c", "g", &[1; 32], fsutil::now_ms() as u64)
            .is_ok()
    );
    assert_eq!(
        loaded
            .authorize("c", "g", &[1; 32], fsutil::now_ms() as u64)
            .unwrap_err(),
        crate::access::Refusal::LeaseExpired
    );
    // Replaying the exact same snapshot cannot renew its lease, even if the
    // caller supplies a later local receive deadline.
    let mut duplicate = renew.clone();
    duplicate.lease_expires_ms += 20_000;
    duplicate.lease_deadline += Duration::from_secs(20);
    d.commit_control_plane_feed(&duplicate, &grants(Some(grant(1))))
        .await
        .unwrap();
    assert_eq!(
        d.inner.lock().await.access.leases["c"],
        renew.lease_expires_ms
    );
    // Restart needs a newer sequence: an ACK retry cannot resurrect an old lease.
    d.inner.lock().await.access = loaded;
    d.commit_control_plane_feed(&duplicate, &grants(Some(grant(1))))
        .await
        .unwrap();
    assert!(
        !d.inner
            .lock()
            .await
            .access
            .grant_live("c", "g", fsutil::now_ms() as u64)
    );
    // Empty snapshots remove active entries and commit their cursor together.
    d.commit_control_plane_feed(&snapshot(3), &grants(None))
        .await
        .unwrap();
    let loaded = AccessList::load(&d.profile.access_file()).unwrap();
    assert!(loaded.entries.is_empty());
    assert_eq!(loaded.feed_cursor.unwrap().sequence, 3);
}

#[tokio::test]
async fn cursor_and_cache_share_one_commit_and_fail_closed_at_each_boundary() {
    for after_rename in [false, true] {
        let dir = crate::testutil::TestDir::new("feed-failure");
        let d = paired_daemon(&dir).await;
        d.commit_control_plane_feed(&snapshot(1), &grants(Some(grant(1))))
            .await
            .unwrap();
        let next = snapshot(2);
        let path = d.profile.access_file();
        let result = d
            .commit_control_plane_feed_with(&next, &grants(None), |a| {
                if after_rename {
                    a.save(&path)?;
                }
                Err(crate::access::AccessError::Io(std::io::Error::other(
                    "injected persistence failure",
                )))
            })
            .await;
        assert!(result.is_err());
        let inner = d.inner.lock().await;
        assert!(!inner.access.grant_live("c", "g", fsutil::now_ms() as u64));
        assert_eq!(inner.access.feed_cursor.as_ref().unwrap().sequence, 2);
        drop(inner);
        assert!(
            d.commit_control_plane_feed(&snapshot(1), &grants(Some(grant(1))))
                .await
                .is_err(),
            "failed attempt cannot roll back in-process cursor"
        );
        let reopened = AccessList::load(&path).unwrap();
        assert!(
            !reopened.grant_live("c", "g", fsutil::now_ms() as u64),
            "restart never trusts a cached lease"
        );
        assert_eq!(
            reopened.feed_cursor.as_ref().unwrap().sequence,
            if after_rename { 2 } else { 1 }
        );
        assert_eq!(
            reopened.entries.is_empty(),
            after_rename,
            "cursor and cache are never torn"
        );
        d.inner.lock().await.access = reopened;
        if after_rename {
            assert!(
                d.commit_control_plane_feed(&snapshot(1), &grants(Some(grant(1))))
                    .await
                    .is_err()
            );
        }
        // Successful reconciliation renews access with a cursor newer than either state.
        d.commit_control_plane_feed(&snapshot(3), &grants(Some(grant(1))))
            .await
            .unwrap();
        assert!(
            d.inner
                .lock()
                .await
                .access
                .grant_live("c", "g", fsutil::now_ms() as u64)
        );
        assert_eq!(
            AccessList::load(&path).unwrap().feed_cursor,
            Some(FeedCursor {
                connector: "connector".into(),
                sequence: 3,
                revision: "rev3".into()
            })
        );
    }
}

/// Synced collections get the signed-in Connect client, the credential store and
/// the daemon's own trust (no file/flag path). This fixture uses public synthetic
/// pins; authenticated release verification is the separate LAB-feature test.
#[test]
fn sync_context_needs_sign_in_and_only_uses_the_daemons_trust() {
    let dir = crate::testutil::TestDir::new("sync-ctx");
    let d = daemon(&dir);
    assert!(d.sync_ctx().is_none(), "not signed in");
    crate::cloud::CloudConfig {
        schema_version: 1,
        server_url: "https://connect-lab.mdbase.dev".into(),
        connector_id: Some("66666666-6666-4666-8666-666666666666".into()),
        ..Default::default()
    }
    .save(&d.profile.cloud_file())
    .unwrap();
    assert!(d.sync_ctx().is_none(), "no connector token");
    d.secrets
        .set(crate::cloud::CONNECTOR_TOKEN, b"connector-token")
        .unwrap();
    let ctx = d.sync_ctx().expect("signed in");
    assert_eq!(ctx.connector_id, "66666666-6666-4666-8666-666666666666");
    assert_eq!(ctx.cloud.server(), "https://connect-lab.mdbase.dev");
    let trust = ctx.trust.expect("the daemon's supplied environment trust");
    assert_eq!(trust.environment, "lab");
    assert_eq!(trust.cp_origin, "https://connect-lab.mdbase.dev");
    assert_eq!(trust.log_origin, "https://log.lab.example");
}

#[test]
fn empty_bootstrap_folder_does_not_ignore_hidden_user_data() {
    let dir = crate::testutil::TestDir::new("strict-empty-bootstrap");
    assert!(super::folder_is_empty(dir.path()).unwrap());
    std::fs::create_dir(dir.path().join(".git")).unwrap();
    assert!(!super::folder_is_empty(dir.path()).unwrap());
    std::fs::remove_dir(dir.path().join(".git")).unwrap();
    std::fs::write(dir.path().join(".private-notes.md"), b"synthetic").unwrap();
    assert!(!super::folder_is_empty(dir.path()).unwrap());
}

#[test]
fn local_empty_metadata_gate_never_ignores_private_files_or_other_hidden_entries() {
    let dir = crate::testutil::TestDir::new("empty-owned-metadata");
    std::fs::create_dir_all(dir.path().join(".mdbase/tmp")).unwrap();
    assert!(super::local_bootstrap_folder_is_empty(dir.path()).unwrap());
    let pending = dir.path().join(".mdbase/tmp/pending");
    std::fs::write(&pending, b"synthetic-retained-data").unwrap();
    assert!(!super::local_bootstrap_folder_is_empty(dir.path()).unwrap());
    assert_eq!(std::fs::read(&pending).unwrap(), b"synthetic-retained-data");
    std::fs::remove_file(pending).unwrap();
    std::fs::create_dir(dir.path().join(".user-private")).unwrap();
    assert!(!super::local_bootstrap_folder_is_empty(dir.path()).unwrap());
}

/// The folder host lock's own files (`.mdbase/host.lock`, `.mdbase/host.json`)
/// are not user content: an empty folder hosted by the daemon still bootstraps.
/// Only those names, only as regular files, only directly in the private dir.
#[test]
fn local_empty_metadata_gate_permits_only_the_folder_host_lock_files() {
    let dir = crate::testutil::TestDir::new("empty-host-lock");
    let root = dir.path();
    {
        let _held = mdbn_local_host::HostLock::try_acquire(
            root,
            ".mdbase",
            Some(mdbn_local_host::Descriptor::new(
                mdbn_local_host::HostKind::Daemon,
                1,
            )),
        )
        .unwrap();
        assert!(root.join(".mdbase/host.lock").is_file());
        assert!(root.join(".mdbase/host.json").is_file());
        assert!(super::local_bootstrap_folder_is_empty(root).unwrap());
    }
    // Released: the lock inode stays, the descriptor goes.
    assert!(root.join(".mdbase/host.lock").is_file());
    assert!(super::local_bootstrap_folder_is_empty(root).unwrap());
    std::fs::create_dir_all(root.join(".mdbase/tmp")).unwrap();
    assert!(super::local_bootstrap_folder_is_empty(root).unwrap());
    // One user file anywhere else is still content (adopt).
    std::fs::write(root.join("note.md"), b"synthetic").unwrap();
    assert!(!super::local_bootstrap_folder_is_empty(root).unwrap());
    std::fs::remove_file(root.join("note.md")).unwrap();
    // The names are not permitted deeper in the private dir, nor at the root.
    std::fs::write(root.join(".mdbase/tmp/host.lock"), b"x").unwrap();
    assert!(!super::local_bootstrap_folder_is_empty(root).unwrap());
    std::fs::remove_file(root.join(".mdbase/tmp/host.lock")).unwrap();
    std::fs::write(root.join("host.lock"), b"x").unwrap();
    assert!(!super::local_bootstrap_folder_is_empty(root).unwrap());
    std::fs::remove_file(root.join("host.lock")).unwrap();
    // Any other file in the private dir still denies, including native startup
    // probes. Readiness, not a filename exception, must precede the empty check.
    for name in [
        "other.json".to_string(),
        format!("probe-{}-Aa", std::process::id()),
        format!("probe-{}-b", std::process::id()),
    ] {
        let path = root.join(".mdbase").join(name);
        std::fs::write(&path, b"{}").unwrap();
        assert!(!super::local_bootstrap_folder_is_empty(root).unwrap());
        assert_eq!(std::fs::read(&path).unwrap(), b"{}");
        std::fs::remove_file(path).unwrap();
    }
    assert!(super::local_bootstrap_folder_is_empty(root).unwrap());
    // A symlink under a lock name is not a lock file.
    #[cfg(unix)]
    {
        let outside = crate::testutil::TestDir::new("empty-host-lock-target");
        std::fs::write(outside.path().join("data.md"), b"synthetic").unwrap();
        std::fs::remove_file(root.join(".mdbase/host.lock")).unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("data.md"),
            root.join(".mdbase/host.lock"),
        )
        .unwrap();
        assert!(!super::local_bootstrap_folder_is_empty(root).unwrap());
    }
}

/// LAB smoke regression (main 9b3518aba): `collection add` opens the folder,
/// which takes the folder host lock; the empty-folder gate that `sync enable`
/// (cloud copy and private alike) checks must still pass for that folder, and
/// must still refuse it once it holds one user file.
#[test]
fn empty_folder_check_refuses_unowned_descriptor_temporary_files() {
    let dir = crate::testutil::TestDir::new("foreign-descriptor");
    std::fs::create_dir(dir.path().join(".mdbase")).unwrap();
    for name in [
        "host.json.tmp".to_string(),
        format!("host.json.{}.tmp", std::process::id()),
    ] {
        let path = dir.path().join(".mdbase").join(name);
        std::fs::write(&path, b"unowned diagnostic-looking bytes").unwrap();
        assert!(!super::local_bootstrap_folder_is_empty(dir.path()).unwrap());
        std::fs::remove_file(path).unwrap();
    }
}

#[test]
fn empty_folder_check_during_owned_descriptor_publication() {
    use mdbn_local_host::host_lock::{Descriptor, HostKind, HostLock};
    let dir = crate::testutil::TestDir::new("empty-descriptor");
    let mut lock = HostLock::try_acquire(
        dir.path(),
        ".mdbase",
        Some(Descriptor::new(HostKind::Daemon, 0)),
    )
    .unwrap();
    let start = Arc::new(std::sync::Barrier::new(2));
    let finish = Arc::new(std::sync::Barrier::new(2));
    let writer_start = start.clone();
    let writer_finish = finish.clone();
    let writer = std::thread::spawn(move || {
        writer_start.wait();
        let publication = (|| {
            for n in 1..=128 {
                lock.heartbeat(n)?;
                std::thread::yield_now();
            }
            Ok::<_, mdbn_local_host::host_lock::LockError>(())
        })();
        // Keep the descriptor and OS lock alive until every observation finishes.
        writer_finish.wait();
        publication
    });
    start.wait();
    let mut refused = None;
    for _ in 0..4096 {
        match super::local_bootstrap_folder_is_empty(dir.path()) {
            Ok(true) => {}
            other => {
                refused = Some(other);
                break;
            }
        }
        std::thread::yield_now();
    }
    finish.wait();
    writer.join().unwrap().unwrap();
    assert!(
        refused.is_none(),
        "owned diagnostic publication changed the empty-folder observation: {refused:?}"
    );
}

#[tokio::test]
async fn added_empty_folder_stays_empty_for_sync_enable_with_the_host_lock() {
    let dir = crate::testutil::TestDir::new("add-empty-lock");
    let folder = crate::testutil::TestDir::new("add-empty-lock-folder");
    let d = paired_daemon(&dir).await;
    let status = d
        .add(crate::control::AddCollection {
            path: folder.path().to_path_buf(),
            name: None,
        })
        .await
        .unwrap();
    let root = std::path::PathBuf::from(status["root"].as_str().unwrap());
    let id = status["id"].as_str().unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    while !(root.join(".mdbase/host.lock").is_file() && root.join(".mdbase/host.json").is_file()) {
        assert!(
            std::time::Instant::now() < deadline,
            "the added collection never took the folder host lock"
        );
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    // Lock publication precedes NativePlatform::open and its temporary probe
    // files. Establish that this fixture has finished native startup before
    // inspecting it; never retry or relax the empty-folder assertion itself.
    while d.serving(id).await.is_err() {
        assert!(
            std::time::Instant::now() < deadline,
            "the added collection never finished native startup"
        );
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert!(super::local_bootstrap_folder_is_empty(&root).unwrap());
    std::fs::write(root.join("note.md"), b"synthetic").unwrap();
    assert!(!super::local_bootstrap_folder_is_empty(&root).unwrap());
    let mut inner = d.inner.lock().await;
    for host in inner.hosts.iter_mut() {
        host.close().await;
    }
}

/// LAB smoke (main 1a5a20830): `collection resume` returned before the
/// collection served again, so an immediate `holds` got unavailable/not_serving.
/// Resume now returns once it serves.
#[tokio::test]
async fn resume_returns_once_the_collection_serves_again() {
    let dir = crate::testutil::TestDir::new("resume-serves");
    let folder = crate::testutil::TestDir::new("resume-serves-folder");
    let d = paired_daemon(&dir).await;
    let status = d
        .add(crate::control::AddCollection {
            path: folder.path().to_path_buf(),
            name: None,
        })
        .await
        .unwrap();
    let id = status["id"].as_str().unwrap().to_string();
    for _ in 0..1000 {
        if d.holds(&id).await.is_ok() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    for _ in 0..3 {
        let paused = d.set_paused(&id, true).await.unwrap();
        assert_eq!(paused["state"], "paused");
        assert!(d.holds(&id).await.is_err(), "paused: not serving");
        let resumed = d.set_paused(&id, false).await.unwrap();
        assert_eq!(resumed["state"], "ready", "{resumed}");
        let holds = d.holds(&id).await;
        assert!(holds.is_ok(), "{:?}", holds.err());
    }
    let mut inner = d.inner.lock().await;
    for host in inner.hosts.iter_mut() {
        host.close().await;
    }
}

#[tokio::test]
async fn join_missing_current_account_denies_before_folder_io() {
    let dir = crate::testutil::TestDir::new("join-current-source");
    let d = daemon(&dir);
    crate::cloud::CloudConfig {
        schema_version: 1,
        server_url: "https://connect-lab.mdbase.dev".into(),
        connector_id: Some("66666666-6666-4666-8666-666666666666".into()),
        ..Default::default()
    }
    .save(&d.profile.cloud_file())
    .unwrap();
    d.secrets
        .set(crate::cloud::CONNECTOR_TOKEN, b"synthetic-connector-token")
        .unwrap();
    let error = d
        .join(crate::control::JoinCollection {
            private: false,
            collection: "44444444-4444-4444-8444-444444444444".into(),
            path: dir.path().join("absent-folder"),
            name: None,
        })
        .await
        .unwrap_err();
    assert_eq!(error.reason.as_deref(), Some("account_changed"));
    assert!(!dir.path().join("absent-folder").exists());
    assert!(
        d.inner
            .lock()
            .await
            .registry
            .get("44444444-4444-4444-8444-444444444444")
            .is_none()
    );
}

/// Joining and enabling sync need a signed-in device whose server is this
/// build's pinned control plane; anything else refuses before Connect or the
/// registry is touched.
#[tokio::test]
async fn join_and_enable_refuse_without_sign_in_or_the_pinned_control_plane() {
    let dir = crate::testutil::TestDir::new("join-refusals");
    let d = daemon(&dir);
    let folder = dir.path().join("joined");
    std::fs::create_dir_all(&folder).unwrap();
    let join = || crate::control::JoinCollection {
        private: false,
        collection: "44444444-4444-4444-8444-444444444444".into(),
        path: folder.clone(),
        name: None,
    };
    let e = d.join(join()).await.unwrap_err();
    assert_eq!(e.reason.as_deref(), Some("not_signed_in"));
    // Signed in to a server that is not the trusted control plane.
    crate::cloud::CloudConfig {
        schema_version: 1,
        server_url: "https://connect.example".into(),
        connector_id: Some("66666666-6666-4666-8666-666666666666".into()),
        ..Default::default()
    }
    .save(&d.profile.cloud_file())
    .unwrap();
    d.secrets
        .set(crate::cloud::CONNECTOR_TOKEN, b"connector-token")
        .unwrap();
    let e = d.join(join()).await.unwrap_err();
    assert_eq!(e.reason.as_deref(), Some("sync_config_invalid"));
    let e = d
        .enable_sync(crate::control::EnableSync {
            collection: "44444444-4444-4444-8444-444444444444".into(),
            mode: SyncMode::Synced,
        })
        .await
        .unwrap_err();
    assert_eq!(e.reason.as_deref(), Some("sync_config_invalid"));
    assert!(
        d.inner
            .lock()
            .await
            .registry
            .get("44444444-4444-4444-8444-444444444444")
            .is_none()
    );
}

/// `status` names the paired account (not a secret), the signed-in server and the
/// build's environment.
#[tokio::test]
async fn status_names_the_account_server_and_environment() {
    let dir = crate::testutil::TestDir::new("status-account");
    let d = daemon(&dir);
    let s = d.status().await;
    assert_eq!(s.account.account_id, None);
    assert_eq!(s.account.server, None);
    assert_eq!(
        s.account.environment,
        crate::trust::Environment::embedded().name()
    );
    let json = serde_json::to_value(&s.account).unwrap();
    assert!(json.get("account_id").is_none());
    assert!(
        !serde_json::to_string(&s)
            .unwrap()
            .contains("connector-token"),
        "no secret in status"
    );
}

/// `collection.join --private` persists the SAS requester state in the OS
/// keychain BEFORE any Connect I/O: without a keychain backend it refuses, nothing
/// is sent (the control plane here is unreachable) and nothing is registered.
#[tokio::test]
async fn private_join_needs_the_keychain_journal_before_any_io() {
    let dir = crate::testutil::TestDir::new("private-join-journal");
    let d = daemon(&dir);
    let device = mdbn_wire::common::B16(d.identity.get().unwrap().device_id);
    let account = "11111111-1111-4111-8111-111111111111";
    let record = crate::cloud::AccountRecord {
        schema_version: 1,
        epoch: 1,
        signed_in: true,
        connector_id: Some("66666666-6666-4666-8666-666666666666".into()),
        account_id: Some(account.into()),
    };
    let cfg = crate::cloud::CloudConfig {
        schema_version: 1,
        account_epoch: 1,
        // This build's (LAB, in tests) pinned control plane, but nothing listens:
        // reaching Connect would fail with sync_unreachable, not the refusal below.
        server_url: "https://connect-lab.mdbase.dev".into(),
        connector_id: Some("66666666-6666-4666-8666-666666666666".into()),
        ..Default::default()
    };
    cfg.save(&d.profile.cloud_file()).unwrap();
    d.secrets
        .set(crate::cloud::CONNECTOR_TOKEN, b"synthetic-connector-token")
        .unwrap();
    d.authority.publish_account(&record, &cfg, device).unwrap();
    let folder = dir.path().join("private-join");
    std::fs::create_dir_all(&folder).unwrap();
    let e = d
        .join(crate::control::JoinCollection {
            private: true,
            collection: "44444444-4444-4444-8444-444444444444".into(),
            path: folder.clone(),
            name: None,
        })
        .await
        .unwrap_err();
    assert_eq!(
        e.reason.as_deref(),
        Some("credential_store_unsupported"),
        "{e:?}"
    );
    assert!(
        d.inner
            .lock()
            .await
            .registry
            .get("44444444-4444-4444-8444-444444444444")
            .is_none()
    );
    assert_eq!(std::fs::read_dir(&folder).unwrap().count(), 0);
}
