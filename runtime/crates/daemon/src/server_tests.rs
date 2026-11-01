//! Security regression tests for consent and feed persistence boundaries.
#[path = "server_capture_stop_tests.rs"]
mod capture_stop_tests;
#[path = "server_conflict_tests.rs"]
mod conflict_tests;
#[cfg(unix)]
#[path = "server_mirror_join_tests.rs"]
mod mirror_join_tests;
use super::*;
use crate::access::{AccessState, FeedCursor};
use crate::confirm::{Answer, Confirmer};
use std::collections::BTreeMap;
use std::sync::Arc;

#[test]
fn cloud_collection_quota_is_not_retryable() {
    let error = cloud_refusal(crate::cloud::CloudError::Server(
        429,
        "account_collection_quota_exceeded".into(),
    ));
    assert_eq!(error.code, "quota_exceeded");
    assert_eq!(
        error.reason.as_deref(),
        Some("account_collection_quota_exceeded")
    );
    assert_eq!(
        mdbn_wire::client::recovery_for(&error.code),
        Some(mdbn_wire::client::Recovery::FreeSpace)
    );
    assert_eq!(
        error.message,
        "Your account has reached its synced collection limit. Delete a synced collection before creating another."
    );
}

#[test]
fn cloud_rate_limits_are_retryable_control_errors() {
    for (delay, message) in [
        (Some(17), "rate limited; retry after 17 seconds"),
        (None, "rate limited; try again later"),
    ] {
        let error = cloud_refusal(crate::cloud::CloudError::RateLimited(delay));
        assert_eq!(
            serde_json::to_value(&error).unwrap(),
            serde_json::json!({
                "code": "rate_limited",
                "reason": "rate_limited",
                "message": message
            })
        );
        assert_eq!(
            mdbn_wire::client::recovery_for(&error.code),
            Some(mdbn_wire::client::Recovery::Retry)
        );
    }
    assert_eq!(
        cloud_refusal(crate::cloud::CloudError::Server(409, "conflict".into()))
            .reason
            .as_deref(),
        Some("sync_refused")
    );
}

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
        status_feed: watch::channel(None).0,
        access_events: tokio::sync::broadcast::channel(64).0,
        activity: crate::activity::ActivityLog::open(dir.path().join("activity.jsonl")),
        control_key: std::sync::OnceLock::new(),
        credential_retry: tokio::sync::Notify::new(),
        account: std::sync::Mutex::new(Account::default()),
        account_gate: Mutex::new(()),
        link_prompt: Mutex::new(()),
        device_approvals: Default::default(),
        authority: crate::authority::Authority::default(),
        confirmer: std::sync::RwLock::new(Arc::new(crate::confirm::Fixed(Answer::Yes))),
        grant_publications: Default::default(),
        self_weak: std::sync::OnceLock::new(),
        online: std::sync::atomic::AtomicBool::new(false),
        link: std::sync::Mutex::new(None),
        // Synthetic, public environment pins; real asset verification is tested
        // separately by trust_tests with the LAB feature enabled.
        trust: Some(Arc::new(crate::trust::fixture_trust())),
        shutdown: watch::channel(false).0,
        identity: Default::default(),
        account_keys: Default::default(),
        takeover: Default::default(),
        auto_private: Default::default(),
        inner: Mutex::new(Inner {
            registry: Registry {
                collections: vec![crate::registry::Entry {
                    id: "c".into(),
                    name: "Notes".into(),
                    root: dir.path().join("notes"),
                    replica_id: "r".into(),
                    mode: SyncMode::Local,
                    origin: crate::registry::Origin::Created,
                    description: None,
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
        .set(Arc::new(DeviceIdentity::generate().unwrap()));
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
        declared_setup: None,
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
async fn private_account_consent_skips_native_confirmation_and_local_opt_in() {
    let dir = crate::testutil::TestDir::new("native-feed");
    let d = paired_daemon(&dir).await;
    d.inner.lock().await.access.require_grant_approval = true;
    const P: &str = "22222222-2222-4222-8222-222222222222";
    const GN: &str = "33333333-3333-4333-8333-333333333333";
    d.inner
        .lock()
        .await
        .registry
        .collections
        .push(crate::registry::Entry {
            id: P.into(),
            name: "Private notes".into(),
            root: dir.path().join("private"),
            replica_id: "r".into(),
            mode: SyncMode::SyncedE2e,
            origin: crate::registry::Origin::Created,
            description: None,
            added_at_ms: 0,
            paused: false,
            ever_e2e: true,
            owner_account: None,
            device: None,
        });
    let mut native = grant(7);
    native.grant = GN.into();
    native.collection = P.into();
    native.folders = None;
    let feed = BTreeMap::from([("c".into(), vec![grant(1)]), (P.into(), vec![native])]);
    d.commit_control_plane_feed(&snapshot(1), &feed)
        .await
        .unwrap();
    {
        let inner = d.inner.lock().await;
        assert_eq!(
            inner
                .access
                .entries
                .iter()
                .find(|e| e.grant.grant == "g")
                .unwrap()
                .state,
            AccessState::PendingApproval
        );
        assert_eq!(
            inner
                .access
                .entries
                .iter()
                .find(|e| e.grant.grant == GN)
                .unwrap()
                .state,
            AccessState::Active
        );
        assert!(
            inner.access.require_grant_approval,
            "the local setting is unchanged"
        );
    }
    // A Linux host without dialog helpers must not block Private access.
    d.set_confirmer(Arc::new(crate::confirm::Fixed(Answer::Unavailable)));
    let result = d
        .handle(
            &Request {
                v: PROTOCOL,
                id: 1,
                method: Method::ACCESS_APPROVE.into(),
                params: json!({"grant":GN}),
            },
            &mut ConnAuth {
                privileged: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(result["state"], "active");
    // Local opt-in still requires the native confirmation.
    let error = d
        .handle(
            &Request {
                v: PROTOCOL,
                id: 2,
                method: Method::ACCESS_APPROVE.into(),
                params: json!({"grant":"g"}),
            },
            &mut ConnAuth {
                privileged: true,
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
    assert_eq!(error.reason.as_deref(), Some("confirmation_unavailable"));
    d.access_change(|list| list.revoke(GN).cloned())
        .await
        .unwrap();
    d.commit_control_plane_feed(&snapshot(2), &feed)
        .await
        .unwrap();
    assert_eq!(
        d.inner
            .lock()
            .await
            .access
            .entries
            .iter()
            .find(|e| e.grant.grant == GN)
            .unwrap()
            .state,
        AccessState::RevokedLocally
    );
}

#[tokio::test]
async fn automatic_private_publication_requires_a_live_bound_account() {
    let dir = crate::testutil::TestDir::new("native-account-publication");
    let d = paired_daemon(&dir).await;
    let mut entry = AccessEntry {
        grant: grant(1),
        state: AccessState::Active,
        first_seen_ms: 1,
        generation: 1,
        acknowledged: false,
        delisted: false,
    };
    entry.grant.grant = "33333333-3333-4333-8333-333333333333".into();
    // Missing account must never match a signed-out daemon's missing account.
    entry.grant.account_id = None;
    let error = d.publish_native_grant(&entry).await.unwrap_err();
    assert_eq!(error.reason.as_deref(), Some("consent_changed"));
    entry.grant.account_id = Some("99999999-9999-4999-8999-999999999999".into());
    d.inner.lock().await.access.entries.push(entry.clone());
    let error = d.publish_native_grant(&entry).await.unwrap_err();
    assert_eq!(error.reason.as_deref(), Some("consent_changed"));
}

#[tokio::test]
async fn native_activation_cannot_override_changed_terms_or_a_refusal() {
    for deny in [false, true] {
        let dir = crate::testutil::TestDir::new("native-activation");
        let d = daemon(&dir);
        d.inner.lock().await.access.require_grant_approval = true;
        d.apply_control_plane_grants("c", &[grant(1)], fsutil::now_ms() as u64 + 55_000)
            .await
            .unwrap();
        let expected = d.inner.lock().await.access.entries[0].clone();
        if deny {
            d.access_change(|list| list.deny("g").cloned())
                .await
                .unwrap();
        } else {
            d.apply_control_plane_grants("c", &[grant(2)], fsutil::now_ms() as u64 + 55_000)
                .await
                .unwrap();
        }
        let error = d.activate_native_entry(&expected).await.unwrap_err();
        assert_eq!(error.reason.as_deref(), Some("consent_changed"));
        let fresh = d.inner.lock().await.access.entries[0].clone();
        assert_ne!(fresh.state, AccessState::Active);
        if !deny {
            d.activate_native_entry(&fresh).await.unwrap();
            assert_eq!(
                d.inner.lock().await.access.entries[0].state,
                AccessState::Active
            );
        }
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
fn join_folder_may_hold_hidden_entries_but_not_files_or_replica_state() {
    let dir = crate::testutil::TestDir::new("join-empty");
    assert!(super::folder_is_empty(dir.path()).unwrap());
    std::fs::create_dir_all(dir.path().join(".obsidian/plugins")).unwrap();
    std::fs::write(dir.path().join(".obsidian/app.json"), b"{}").unwrap();
    std::fs::write(dir.path().join(".DS_Store"), b"synthetic").unwrap();
    assert!(super::folder_is_empty(dir.path()).unwrap());
    for private in [".mdbase", ".MDBASE", ".mdbase."] {
        std::fs::create_dir(dir.path().join(private)).unwrap();
        assert!(!super::folder_is_empty(dir.path()).unwrap(), "{private}");
        std::fs::remove_dir(dir.path().join(private)).unwrap();
    }
    std::fs::write(dir.path().join("note.md"), b"synthetic").unwrap();
    assert!(!super::folder_is_empty(dir.path()).unwrap());
    std::fs::remove_file(dir.path().join("note.md")).unwrap();
    std::fs::create_dir(dir.path().join("notes")).unwrap();
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

/// `sync enable` right after `collection add` waits for the collection to open
/// instead of refusing with `not_serving`.
#[tokio::test]
async fn enable_right_after_add_waits_for_the_open() {
    let dir = crate::testutil::TestDir::new("enable-after-add");
    let folder = crate::testutil::TestDir::new("enable-after-add-folder");
    std::fs::write(folder.path().join("note.md"), b"synthetic").unwrap();
    let d = paired_daemon(&dir).await;
    let status = d
        .add(crate::control::AddCollection {
            path: folder.path().to_path_buf(),
            name: None,
        })
        .await
        .unwrap();
    let id = status["id"].as_str().unwrap().to_string();
    let out = d
        .enable_sync(crate::control::EnableSync {
            collection: id.clone(),
            mode: None,
            accept_takeover_holds: false,
        })
        .await;
    if let Err(e) = &out {
        assert_ne!(e.reason.as_deref(), Some("not_serving"), "{e:?}");
    }
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
            mode: Some(SyncMode::Synced),
            accept_takeover_holds: false,
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

#[tokio::test]
async fn loopback_port_busy_only_after_the_old_service_was_fenced() {
    let held = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = held.local_addr().unwrap();
    let busy = loopback_check(true, addr).await;
    assert_eq!(busy.status, "warn");
    assert!(busy.detail.starts_with("loopback_port_busy"));
    assert_eq!(loopback_check(false, addr).await.status, "ok");
    drop(held);
    assert_eq!(loopback_check(true, addr).await.status, "ok");
}

/// `collection.update` renames and describes a collection, persists it, and
/// refuses names that could mislead an approval screen.
#[tokio::test]
async fn update_renames_and_describes_and_persists() {
    let dir = crate::testutil::TestDir::new("update-collection");
    let folder = crate::testutil::TestDir::new("update-collection-folder");
    let d = paired_daemon(&dir).await;
    let added = d
        .add(crate::control::AddCollection {
            path: folder.path().to_path_buf(),
            name: None,
        })
        .await
        .unwrap();
    let id = added["id"].as_str().unwrap().to_string();
    let update = |name: Option<&str>, description: Option<&str>| crate::control::UpdateCollection {
        collection: id.clone(),
        name: name.map(Into::into),
        description: description.map(Into::into),
    };
    let s = d
        .update_collection(update(Some("  Workouts "), Some("Lifting log")))
        .await
        .unwrap();
    assert_eq!(
        (s["name"].as_str(), s["description"].as_str()),
        (Some("Workouts"), Some("Lifting log"))
    );
    // Omitted fields are unchanged; an empty description clears it.
    let s = d.update_collection(update(None, Some(""))).await.unwrap();
    assert_eq!(s["name"], "Workouts");
    assert!(s.get("description").is_none());
    for bad in [
        "",
        "   ",
        "Notes\u{202e}gpj",
        "a\nb",
        "a\u{2028}b",
        "a\u{2029}b",
        &"x".repeat(101),
    ] {
        let e = d
            .update_collection(update(Some(bad), None))
            .await
            .unwrap_err();
        assert_eq!(e.code, "invalid_request", "{bad:?}");
    }
    let saved = Registry::load(&d.profile.registry_file()).unwrap();
    assert_eq!(saved.get(&id).unwrap().name, "Workouts");
    let mut inner = d.inner.lock().await;
    for host in inner.hosts.iter_mut() {
        host.close().await;
    }
}

/// Changes made through the control API land in `activity.list`, newest first,
/// with the collection's name even after it is removed.
#[tokio::test]
async fn control_changes_are_logged_as_activity() {
    let dir = crate::testutil::TestDir::new("activity-log");
    let folder = crate::testutil::TestDir::new("activity-log-folder");
    let d = paired_daemon(&dir).await;
    let call = |method: &str, params: Value| {
        let d = d.clone();
        let req = Request {
            v: PROTOCOL,
            id: 1,
            method: method.into(),
            params,
        };
        async move { d.handle_and_note(&req, &mut ConnAuth::default()).await }
    };
    let added = call(
        Method::COLLECTION_ADD,
        json!({"path": folder.path(), "name": "Notes"}),
    )
    .await
    .unwrap();
    let id = added["id"].as_str().unwrap().to_string();
    call(
        Method::COLLECTION_UPDATE,
        json!({"collection": id, "name": "Journal"}),
    )
    .await
    .unwrap();
    call(Method::COLLECTION_REMOVE, json!({"collection": id}))
        .await
        .unwrap();
    assert!(
        call(Method::COLLECTION_REMOVE, json!({"collection": id}))
            .await
            .is_err()
    );
    let log = call(Method::ACTIVITY_LIST, json!({})).await.unwrap();
    let seen: Vec<(String, String)> = log
        .as_array()
        .unwrap()
        .iter()
        .map(|e| {
            (
                e["kind"].as_str().unwrap().into(),
                e["collection_name"].as_str().unwrap().into(),
            )
        })
        .collect();
    assert_eq!(
        seen,
        [
            ("collection_removed".into(), "Journal".into()),
            ("collection_updated".into(), "Journal".into()),
            ("collection_added".into(), "Notes".into()),
        ],
        "a failed call adds nothing"
    );
}

/// Adopt is refused while files the takeover held are unreviewed (only an
/// explicit acceptance passes) and while the local replica has holds or
/// conflicts, with the command to run.
#[test]
fn adopt_is_refused_while_takeover_or_replica_holds_are_open() {
    use crate::takeover::record::{Collection, CollectionState, Record, SCHEMA_VERSION, State};
    let dir = crate::testutil::TestDir::new("adopt-holds");
    let state = dir.path();
    assert!(adopt_holds_refusal(state, "c", false, Some((0, 0))).is_ok());
    let mut held = Collection::new(CollectionState::Held);
    held.holds = 2;
    Record {
        schema_version: SCHEMA_VERSION,
        state: State::Complete,
        updated_at: "2026-10-11T00:00:00Z".into(),
        old_state_dir: state.join("old"),
        collections: [("c".to_string(), held)].into(),
    }
    .save(&state.join("takeover.json"))
    .unwrap();
    let e = adopt_holds_refusal(state, "c", false, None).unwrap_err();
    assert_eq!(e.reason.as_deref(), Some("takeover_holds"));
    assert!(
        e.message.contains("--accept-takeover-holds"),
        "{}",
        e.message
    );
    assert!(adopt_holds_refusal(state, "c", true, Some((0, 0))).is_ok());
    assert!(adopt_holds_refusal(state, "other", false, None).is_ok());
    for replica in [(1, 0), (0, 1)] {
        let e = adopt_holds_refusal(state, "c", true, Some(replica)).unwrap_err();
        assert_eq!(e.reason.as_deref(), Some("holds_pending"));
    }
}

// A captured old hosted mirror is imported once its collection serves here.
use crate::takeover::mirror_import::tests::hosted_mirror::{self, HOSTED};

fn uuid(s: &str) -> [u8; 16] {
    secrets::hex_decode(&s.replace('-', ""))
        .unwrap()
        .try_into()
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn captured_mirror_edits_are_imported_listed_and_resolvable() {
    let dir = crate::testutil::TestDir::new("mi-daemon");
    let d = paired_daemon(&dir).await;
    // The hosted collection, registered here under its own ID (as a joined
    // collection would be), served locally for the test.
    let joined = crate::testutil::TestDir::new("mi-daemon-joined");
    let folder = joined.path().join("Hosted");
    std::fs::create_dir_all(folder.join(".mdbase")).unwrap();
    let replica =
        crate::registry::StoreIds::get_or_issue(&d.profile.store_ids_file(), HOSTED).unwrap();
    std::fs::write(
        folder.join(".mdbase/connect-role.json"),
        serde_json::to_vec(
            &json!({"version": 2, "role": "replica", "collection": HOSTED,
            "replica_id": replica, "runtime": "mdbase-next",
            "claimed_at": "2026-10-18T00:00:00Z", "notice": "test"}),
        )
        .unwrap(),
    )
    .unwrap();
    d.add(crate::control::AddCollection {
        path: folder.clone(),
        name: Some("Hosted".into()),
    })
    .await
    .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    while d.runtime_of(HOSTED).await.is_err() {
        assert!(std::time::Instant::now() < deadline, "never served");
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    let rt = d.runtime_of(HOSTED).await.unwrap();
    for (rid, path, doc) in hosted_mirror::server_records() {
        let ops = vec![mdbn_wire::intent::Op::Create(mdbn_wire::intent::Create {
            id: mdbn_wire::common::B16(uuid(rid)),
            path: Some(path.into()),
            type_name: None,
            frontmatter: None,
            body: None,
            document: Some(mdbn_wire::common::Text::Inline(doc.into())),
        })];
        assert_eq!(
            submit_as(&rt, ops, new_uuid_v7()).await.unwrap(),
            crate::takeover::held::Outcome::Confirmed
        );
    }

    // Captured at the takeover (before any join).
    let elsewhere = crate::testutil::TestDir::new("mi-daemon-old");
    let old = elsewhere.path().join("connect");
    let entry = hosted_mirror::build(&old, &elsewhere.path().join("Hosted notes"));
    let legacy = d.takeover_paths().legacy;
    crate::takeover::mirror_import::capture(&legacy, &old, &entry, "2026-10-18T00:00:00Z").unwrap();

    // Nothing happens before the takeover is complete (an old mirror could
    // still be uploading).
    d.import_mirrors().await;
    assert_eq!(
        d.takeover_status().await.unwrap()["mirror_imports"][HOSTED]["applied"],
        0
    );
    complete_takeover_record(&d, &old);

    d.import_mirrors().await;

    let st = d.takeover_status().await.unwrap();
    let mi = &st["mirror_imports"][HOSTED];
    assert_eq!(mi["join"]["state"], "joined", "{st}");
    assert_eq!(mi["join"]["folder"], json!(folder.canonicalize().unwrap()));
    assert_eq!(mi["complete"], true, "{st}");
    assert_eq!(mi["registered"], true);
    assert_eq!(mi["name"], "Hosted");
    assert_eq!(mi["applied"], 4);
    assert_eq!(mi["held"], 1);
    assert_eq!(mi["recovered"][0]["path"], "d.md");
    assert_eq!(doc_at(&rt, "a.md").await.as_deref(), Some("A edited"));

    // The conflict is listed with the replica's own holds and resolves there.
    let holds = d.holds(HOSTED).await.unwrap();
    let hold = holds
        .as_array()
        .unwrap()
        .iter()
        .find(|h| h["reason"] == crate::takeover::mirror_import::HOLD_REASON)
        .unwrap_or_else(|| panic!("{holds}"))
        .clone();
    assert_eq!(hold["path"], "e.md");
    d.resolve_hold(ResolveHold {
        collection: HOSTED.into(),
        id: hold["id"].as_str().unwrap().into(),
        how: HoldAction::KeepBoth,
    })
    .await
    .unwrap();
    assert_eq!(doc_at(&rt, "e.md").await.as_deref(), Some("E theirs"));
    assert_eq!(
        doc_at(&rt, "e (old version).md").await.as_deref(),
        Some("E mine")
    );
    let st = d.takeover_status().await.unwrap();
    assert_eq!(st["mirror_imports"][HOSTED]["held"], 0, "{st}");

    // Another pass changes nothing.
    d.import_mirrors().await;
    assert_eq!(doc_at(&rt, "n.md").await.as_deref(), Some("New"));
    let mut inner = d.inner.lock().await;
    for host in inner.hosts.iter_mut() {
        host.close().await;
    }
}

fn complete_takeover_record(d: &Daemon, old: &std::path::Path) {
    use crate::takeover::record::{Record, SCHEMA_VERSION, State};
    Record {
        schema_version: SCHEMA_VERSION,
        state: State::Complete,
        updated_at: "2026-10-18T00:00:00Z".into(),
        old_state_dir: old.to_path_buf(),
        collections: Default::default(),
    }
    .save(&d.takeover_paths().record)
    .unwrap();
}

async fn doc_at(rt: &Arc<crate::runtime::Runtime>, path: &str) -> Option<String> {
    use crate::takeover::mirror_import::Target;
    let mut t = HostTarget { rt: rt.clone() };
    t.get(path).await.unwrap().map(|c| c.document)
}

#[tokio::test]
async fn status_is_built_once_per_change_for_every_subscriber() {
    let dir = crate::testutil::TestDir::new("status-feed");
    let d = daemon(&dir);
    let publisher = tokio::spawn(d.clone().publish_status());
    let (mut a, mut b) = (d.status_feed.subscribe(), d.status_feed.subscribe());
    while d.changes.receiver_count() == 0 {
        tokio::task::yield_now().await;
    }
    d.bump();
    for feed in [&mut a, &mut b] {
        tokio::time::timeout(Duration::from_secs(5), feed.changed())
            .await
            .unwrap()
            .unwrap();
    }
    let (a, b) = (a.borrow().clone().unwrap(), b.borrow().clone().unwrap());
    assert!(Arc::ptr_eq(&a, &b), "one build shared by both subscribers");
    assert_eq!(a["pid"], std::process::id());
    publisher.abort();
}

#[test]
fn a_joined_collection_takes_the_account_name() {
    let root = std::path::Path::new("/home/u/Notes folder");
    let name = |given, account| join_name(given, account, root).unwrap();
    assert_eq!(name(Some(" Mine "), Some("Work notes")), "Mine");
    assert_eq!(name(None, Some("Work notes")), "Work notes");
    // The control plane's placeholder, a missing name or an unusable one: the folder.
    assert_eq!(name(None, Some(SERVER_PLACEHOLDER_NAME)), "Notes folder");
    assert_eq!(name(None, None), "Notes folder");
    assert_eq!(name(None, Some("bad\u{202E}name")), "Notes folder");
    assert!(join_name(Some(""), None, root).is_err());
}

#[test]
fn an_unknown_collection_is_not_found_not_refused() {
    use crate::cloud::CloudError;
    let e = join_refusal(CloudError::Server(404, "not_found".into()));
    assert_eq!(
        (e.code.as_str(), e.reason.as_deref()),
        ("not_found", Some("not_found"))
    );
    assert_eq!(
        cloud_refusal(CloudError::Server(404, "not_found".into()))
            .reason
            .as_deref(),
        Some("sync_refused")
    );
    for other in [
        CloudError::Server(404, "error".into()),
        CloudError::Server(409, "not_current_cloud_copy".into()),
    ] {
        assert_eq!(join_refusal(other).reason.as_deref(), Some("sync_refused"));
    }
}
