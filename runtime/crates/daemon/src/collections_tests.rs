//! Synced collections start only when linked, trusted, current and eligible; a
//! refusal or an unreachable first open never touches user files.

use std::sync::Arc;

use super::*;
use crate::cloud::AccountRecord;
use crate::cloud::CloudConfig;
use crate::registry::{Origin, Registry};
use crate::secrets::{MemoryStore, SecretStore};

const ACCOUNT: &str = "11111111-1111-4111-8111-111111111111";
const COLLECTION: &str = "44444444-4444-4444-8444-444444444444";

fn scratch(tag: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!("mdbn-host-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&p);
    std::fs::create_dir_all(p.join("folder")).unwrap();
    crate::fsutil::ensure_private_dir(&p.join("collections")).unwrap();
    crate::fsutil::ensure_private_dir(&p.join("collections").join(COLLECTION)).unwrap();
    p
}

fn entry(dir: &Path, mode: SyncMode) -> Entry {
    Entry {
        id: COLLECTION.into(),
        name: "synced".into(),
        root: dir.join("folder"),
        replica_id: "55555555-5555-4555-8555-555555555555".into(),
        mode,
        origin: Origin::Created,
        description: None,
        added_at_ms: 0,
        paused: false,
        ever_e2e: false,
        owner_account: None,
        device: None,
    }
}

/// A real Ed25519 public key (pins must be strong points).
fn strong(seed: u8) -> [u8; 32] {
    ed25519_dalek::SigningKey::from_bytes(&[seed; 32])
        .verifying_key()
        .to_bytes()
}

fn trust_for(server: &str) -> crate::trust::Trust {
    crate::trust::Trust {
        cp_origin: server.into(),
        ..trust()
    }
}

fn trust() -> crate::trust::Trust {
    crate::trust::Trust {
        environment: "lab".into(),
        cp_origin: "https://cp.lab.example".into(),
        log_origin: "https://log.lab.example".into(),
        roots: vec![strong(0xab)],
        policy_pins: crate::trust::pins_for(strong(0xab), strong(0xcd)),
    }
}

fn link(state: &str) -> crate::sync::SyncConfig {
    crate::sync::SyncConfig {
        schema_version: 2,
        environment: "lab".into(),
        collection_id: COLLECTION.into(),
        log_url: "https://log.lab.example".into(),
        genesis_hash: "cd".repeat(32),
        chosen_state: state.into(),
        trusted_signers: vec![],
        user_enabled_cloud_copy: state == "cloud_copy",
    }
}

/// A loopback "Connect" answering the device challenge, then `status` with `code`
/// for the log token.
async fn connect(status: u16, code: &'static str) -> String {
    connect_with(
        status,
        format!("{{\"error\":{{\"code\":\"{code}\",\"message\":\"no\"}}}}"),
    )
    .await
}

async fn connect_with(status: u16, answer: String) -> String {
    connect_counted(status, answer).await.0
}

/// A loopback Connect that also counts the log-token requests it receives (per
/// server, so parallel tests never share a count).
async fn connect_counted(
    status: u16,
    answer: String,
) -> (String, Arc<std::sync::atomic::AtomicUsize>) {
    connect_sequence(vec![(status, answer)]).await
}

async fn connect_sequence(
    answers: Vec<(u16, String)>,
) -> (String, Arc<std::sync::atomic::AtomicUsize>) {
    let posts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counted = posts.clone();
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://127.0.0.1:{}", l.local_addr().unwrap().port());
    tokio::spawn(async move {
        while let Ok((mut s, _)) = l.accept().await {
            let mut buf = vec![0u8; 16 * 1024];
            let n = s.read(&mut buf).await.unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            let (st, body) = if req.contains("/v1/next/devices/challenge") {
                (200, format!("{{\"challenge\":\"{}\"}}", "ab".repeat(32)))
            } else {
                let index = if req.contains("/log-token") {
                    counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
                } else {
                    0
                };
                answers[index.min(answers.len() - 1)].clone()
            };
            let resp = format!(
                "HTTP/1.1 {st} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = s.write_all(resp.as_bytes()).await;
        }
    });
    (url, posts)
}

fn ctx(dir: &Path, server: Option<&str>, trust: Option<crate::trust::Trust>) -> HostCtx {
    let authority = crate::authority::Authority::default();
    let identity = Arc::new(crate::secrets::DeviceIdentity::generate().unwrap());
    let record = AccountRecord {
        schema_version: 1,
        epoch: 1,
        signed_in: true,
        connector_id: Some("connector".into()),
        account_id: Some(ACCOUNT.into()),
    };
    let config = CloudConfig {
        schema_version: 1,
        account_epoch: 1,
        connector_id: Some("connector".into()),
        ..Default::default()
    };
    authority
        .publish_account(&record, &config, mdbn_wire::common::B16(identity.device_id))
        .unwrap();
    let secrets: Arc<dyn SecretStore> = Arc::new(MemoryStore::default());
    secrets
        .set(crate::cloud::CONNECTOR_TOKEN, b"connector-token")
        .unwrap();
    let sync = server.map(|server| SyncCtx {
        cloud: Arc::new(
            crate::cloud::Cloud::new(
                &crate::cloud::tls_config().unwrap(),
                server,
                secrets.as_ref(),
            )
            .unwrap(),
        ),
        connector_id: "66666666-6666-4666-8666-666666666666".into(),
        secrets: secrets.clone(),
        trust: trust.map(Arc::new),
    });
    HostCtx {
        identity,
        collections_dir: dir.join("collections"),
        authority,
        notify: Arc::new(|| {}),
        sync,
        computer_name: None,
    }
}

fn host(dir: &Path, mode: SyncMode, ctx: HostCtx) -> CollectionHost {
    let e = entry(dir, mode);
    ctx.authority.publish_registry(&Registry {
        collections: vec![e.clone()],
        ..Default::default()
    });
    CollectionHost::open(e, Some(ctx))
}

#[tokio::test(flavor = "multi_thread")]
async fn live_telemetry_is_real_actor_data_and_denies_stale_or_stopped_host() {
    let dir = scratch("live-telemetry");
    let context = ctx(&dir, None, None);
    let mut e = entry(&dir, SyncMode::Local);
    e.owner_account = Some(ACCOUNT.into());
    e.device = Some(crate::secrets::uuid_string(&context.identity.device_id));
    context.authority.publish_registry(&Registry {
        collections: vec![e.clone()],
        ..Default::default()
    });
    let mut host = CollectionHost::open(e, Some(context.clone()));
    assert_eq!(settled(&host).await.0, CollectionState::Ready);
    let out = host.observation().status().await;
    let counters = out.sync.expect("real opened actor counters, not sync:None");
    let runtime = host.runtime().unwrap();
    let expected = runtime.status().await.unwrap();
    assert_eq!(counters.confirmed_through, expected.confirmed_through);
    assert_eq!(counters.pending, expected.pending);
    let (count, hash) = runtime.confirmed_digest().await.unwrap();
    let digest = counters.confirmed_record_digest.unwrap();
    assert_eq!(digest.records, count);
    assert_eq!(digest.digest, crate::secrets::hex(&hash));
    assert_eq!(digest.confirmed_through, counters.confirmed_through);
    assert_eq!(counters.head_digest.as_ref().unwrap().len(), 64);
    context.authority.invalidate(2);
    assert!(host.observation().status().await.sync.is_none());
    host.close().await;
    assert!(host.observation().status().await.sync.is_none());
    assert!(runtime.telemetry().await.is_none());
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test(flavor = "multi_thread")]
async fn observation_source_is_checked_before_poll_and_after_actor_await() {
    for stale_before in [false, true] {
        let dir = scratch("telemetry-source");
        let context = ctx(&dir, None, None);
        let mut e = entry(&dir, SyncMode::Local);
        e.owner_account = Some(ACCOUNT.into());
        e.device = Some(crate::secrets::uuid_string(&context.identity.device_id));
        context.authority.publish_registry(&Registry {
            collections: vec![e.clone()],
            ..Default::default()
        });
        let mut host = CollectionHost::open(e, Some(context.clone()));
        assert_eq!(settled(&host).await.0, CollectionState::Ready);
        let observation = host.observation();
        if stale_before {
            context.authority.invalidate(2);
        }
        let parked = host.runtime().unwrap().test_park();
        let started = std::time::Instant::now();
        let observed = tokio::spawn(observation.status());
        let parked = if stale_before {
            Some(parked)
        } else {
            // Stale by the time the actor answers: its details are dropped.
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            context.authority.invalidate(2);
            drop(parked);
            None
        };
        let status = observed.await.unwrap();
        drop(parked);
        // A stale source is never polled, so it never waits on the parked actor.
        assert!(started.elapsed() < ACTOR_WAIT);
        assert!(status.sync.is_none());
        assert!(status.approval_code.is_none());
        assert!(!status.notices.iter().any(|n| n.code == NOT_RESPONDING));
        host.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_parked_actor_is_reported_as_not_responding_within_the_wait() {
    let dir = scratch("telemetry-parked");
    let context = ctx(&dir, None, None);
    let mut e = entry(&dir, SyncMode::Local);
    e.owner_account = Some(ACCOUNT.into());
    e.device = Some(crate::secrets::uuid_string(&context.identity.device_id));
    context.authority.publish_registry(&Registry {
        collections: vec![e.clone()],
        ..Default::default()
    });
    let mut host = CollectionHost::open(e, Some(context));
    assert_eq!(settled(&host).await.0, CollectionState::Ready);
    let parked = host.runtime().unwrap().test_park();
    let started = std::time::Instant::now();
    let status = host.observation().status().await;
    assert!(started.elapsed() < ACTOR_WAIT * 2);
    assert!(status.sync.is_none());
    assert!(status.notices.iter().any(|n| n.code == NOT_RESPONDING));
    drop(parked);
    // Once the actor answers again, the details come back without the notice.
    let status = host.observation().status().await;
    assert!(status.sync.is_some());
    assert!(!status.notices.iter().any(|n| n.code == NOT_RESPONDING));
    host.close().await;
    let _ = std::fs::remove_dir_all(dir);
}

async fn settled(h: &CollectionHost) -> (CollectionState, Option<String>) {
    if let Some(opener) = h.runtime.opener() {
        opener.clone().finish().await;
    }
    h.current()
}

fn save(dir: &Path, cfg: &crate::sync::SyncConfig) {
    let p = crate::sync::SyncConfig::path(&dir.join("collections"), COLLECTION);
    let bytes = serde_json::to_vec(cfg).unwrap();
    crate::fsutil::write_atomic(&p, &bytes).unwrap();
}

fn untouched(dir: &Path) -> bool {
    !dir.join("collections")
        .join(COLLECTION)
        .join("index.sqlite")
        .exists()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_synced_collection_needs_sync_context_trust_and_a_valid_link() {
    let dir = scratch("link");
    let h = host(&dir, SyncMode::Synced, ctx(&dir, None, None));
    assert_eq!(
        h.current(),
        (
            CollectionState::Unavailable,
            Some("sync_not_configured".into())
        )
    );
    let server = connect(409, "not_enrolled").await;
    let h = host(&dir, SyncMode::Synced, ctx(&dir, Some(&server), None));
    assert_eq!(h.current().1.as_deref(), Some("trust_missing"));
    let h = host(
        &dir,
        SyncMode::Synced,
        ctx(&dir, Some(&server), Some(trust_for(&server))),
    );
    assert_eq!(h.current().1.as_deref(), Some("not_joined"));
    save(
        &dir,
        &crate::sync::SyncConfig {
            collection_id: ACCOUNT.into(),
            ..link("cloud_copy")
        },
    );
    let h = host(
        &dir,
        SyncMode::Synced,
        ctx(&dir, Some(&server), Some(trust_for(&server))),
    );
    assert_eq!(h.current().1.as_deref(), Some("sync_config_invalid"));
    save(&dir, &link("cloud_copy"));
    let h = host(
        &dir,
        SyncMode::SyncedE2e,
        ctx(&dir, Some(&server), Some(trust_for(&server))),
    );
    assert_eq!(
        h.current().1.as_deref(),
        Some("sync_config_invalid"),
        "chosen state differs"
    );
    let other = crate::trust::Trust {
        environment: "other".into(),
        ..trust_for(&server)
    };
    let h = host(
        &dir,
        SyncMode::Synced,
        ctx(&dir, Some(&server), Some(other)),
    );
    assert_eq!(h.current().1.as_deref(), Some("sync_config_invalid"));
    // Signed in to a Connect that is not the environment's pinned control plane.
    let h = host(
        &dir,
        SyncMode::Synced,
        ctx(&dir, Some(&server), Some(trust())),
    );
    assert_eq!(h.current().1.as_deref(), Some("sync_config_invalid"));
    assert!(untouched(&dir));
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn connect_refusal_opens_nothing() {
    let dir = scratch("refused");
    save(&dir, &link("private"));
    let server = connect(409, "not_enrolled").await;
    let h = host(
        &dir,
        SyncMode::SyncedE2e,
        ctx(&dir, Some(&server), Some(trust_for(&server))),
    );
    assert_eq!(
        settled(&h).await,
        (
            CollectionState::Unavailable,
            Some("sync_not_eligible".into())
        )
    );
    assert!(h.runtime().is_none());
    assert!(untouched(&dir), "no index, no scan");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unreachable_connect_opens_nothing_on_first_open() {
    let dir = scratch("offline");
    save(&dir, &link("cloud_copy"));
    // Bound then closed: nothing listens there.
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let server = format!("http://127.0.0.1:{port}");
    let h = host(
        &dir,
        SyncMode::Synced,
        ctx(&dir, Some(&server), Some(trust_for(&server))),
    );
    assert_eq!(
        settled(&h).await,
        (
            CollectionState::Unavailable,
            Some("sync_unreachable".into())
        )
    );
    assert!(untouched(&dir));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_fence_follows_the_current_registration() {
    let dir = scratch("fence");
    let c = ctx(&dir, None, None);
    let e = entry(&dir, SyncMode::Synced);
    c.authority.publish_registry(&Registry {
        collections: vec![e.clone()],
        ..Default::default()
    });
    let collection = mdbn_wire::common::B16(crate::attest::uuid_bytes(COLLECTION).unwrap());
    let source = c.authority.source(collection).unwrap();
    assert!(source.current_synced().is_ok());
    c.authority.publish_registry(&Registry {
        collections: vec![Entry {
            paused: true,
            ..e.clone()
        }],
        ..Default::default()
    });
    assert!(source.current_synced().is_err(), "paused");
    c.authority.publish_registry(&Registry {
        collections: vec![Entry {
            mode: SyncMode::Local,
            ..e.clone()
        }],
        ..Default::default()
    });
    assert!(source.current_synced().is_err(), "local");
    c.authority.publish_registry(&Registry {
        collections: vec![e],
        ..Default::default()
    });
    assert!(source.current_synced().is_ok());
    c.authority.invalidate(2);
    assert!(source.current_synced().is_err(), "signed out");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_token_is_refused_when_the_authority_changes_during_the_request() {
    use std::sync::atomic::{AtomicUsize, Ordering::SeqCst};
    let dir = scratch("fence-await");
    let expires = crate::fsutil::now_ms() as i64 + 3_600_000;
    let (server, posts_seen) =
        connect_counted(200, format!("{{\"token\":\"t\",\"expires_at\":{expires}}}")).await;
    let c = ctx(&dir, Some(&server), Some(trust_for(&server)));
    let sync = c.sync.clone().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let seen = calls.clone();
    // Current before the request, gone after it.
    let fence: crate::sync::Fence = Arc::new(move || {
        if seen.fetch_add(1, SeqCst) == 0 {
            Ok(())
        } else {
            Err("signed out".into())
        }
    });
    let tokens = crate::sync::ConnectTokens::new(
        sync.cloud.clone(),
        sync.connector_id.clone(),
        [0x44; 16],
        c.identity.clone(),
        fence,
    );
    let posts = posts_seen.load(SeqCst);
    assert!(matches!(
        tokens.eligibility().await,
        Err(crate::sync::Eligibility::Refused(_))
    ));
    assert!(
        calls.load(SeqCst) >= 2,
        "checked before and again after the challenge await"
    );
    assert_eq!(
        posts_seen.load(SeqCst),
        posts,
        "no signed token request for a stale identity"
    );
    // With a fence that holds, the token is issued and then served from the cache.
    let ok = crate::sync::ConnectTokens::new(
        sync.cloud.clone(),
        sync.connector_id.clone(),
        [0x44; 16],
        c.identity.clone(),
        Arc::new(|| Ok(())),
    );
    let t = crate::logwire::TokenSource::token(&ok).await.unwrap();
    assert_eq!(t.token.as_str(), "t");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn reconstructed_host_reports_last_fatal_incident_after_actor_stop() {
    let dir = crate::testutil::TestDir::new("host-fatal-diagnostic");
    std::fs::create_dir_all(dir.path().join("folder")).unwrap();
    let context = ctx(dir.path(), None, None);
    let private_dir = context.collections_dir.join(COLLECTION);
    crate::fsutil::ensure_private_dir(&private_dir).unwrap();
    let shared = crate::sync_failure::Shared::default();
    let observed = status(
        3,
        7,
        mdbn_wire::client::Connection::Online,
        &[mdbn_wire::client::IncidentKind::VerificationMismatch],
    );
    let failure = crate::sync_failure::Failure::project(&observed, &None).unwrap();
    crate::sync_failure::retain_and_stop(
        &shared,
        &private_dir,
        failure,
        || {},
        async { Vec::new() },
        async {},
    )
    .await;
    drop(shared); // like the failed actor/process: no in-memory incidents left
    let mut reopened = host(dir.path(), SyncMode::SyncedE2e, context);
    let reported = reopened.status();
    let diagnostic = reported.last_sync_failure.as_ref().unwrap();
    assert_eq!(
        diagnostic.kind,
        crate::sync_failure::Kind::VerificationMismatch
    );
    assert_eq!(diagnostic.seq, 3);
    assert_eq!(
        diagnostic.persisted, None,
        "recovery cannot prove the original directory fsync"
    );
    let json = serde_json::to_value(&reported).unwrap();
    assert_eq!(json["last_sync_failure"]["kind"], "verification_mismatch");
    assert!(json["last_sync_failure"]["persisted"].is_null());
    reopened.close().await;
}

fn status(
    through: u64,
    head: u64,
    conn: mdbn_wire::client::Connection,
    incidents: &[mdbn_wire::client::IncidentKind],
) -> mdbn_wire::client::SyncStatus {
    mdbn_wire::client::SyncStatus {
        grant: None,
        mode: mdbn_wire::client::SyncMode::Synced,
        confirmed_through: through,
        head_known: head,
        pending: 0,
        oldest_pending: None,
        holds: 0,
        unresolved: 0,
        connection: conn,
        installing: None,
        resyncing: None,
        confirmed_head: None,
        incidents: incidents
            .iter()
            .map(|k| mdbn_wire::client::Incident {
                kind: *k,
                details: None,
            })
            .collect(),
    }
}

#[test]
fn synced_readiness_needs_genesis_keys_and_the_head() {
    use crate::runtime::synced_ready;
    use mdbn_wire::client::{Connection::*, IncidentKind as K};
    let r = |through, head, conn, inc: &[K], caught_up, cached| {
        synced_ready(&status(through, head, conn, inc), None, caught_up, cached)
    };
    assert_eq!(
        r(0, 0, Online, &[], true, false),
        Ok(false),
        "no genesis yet"
    );
    assert_eq!(
        r(5, 9, Online, &[], true, false),
        Ok(false),
        "behind the head"
    );
    assert_eq!(
        r(9, 9, Online, &[], false, false),
        Ok(false),
        "head not read this connection"
    );
    assert_eq!(
        r(9, 9, Online, &[], false, true),
        Ok(false),
        "the cache never stands in online"
    );
    assert_eq!(
        r(9, 12, Online, &[], true, true),
        Ok(false),
        "online and behind, cache or not"
    );
    assert_eq!(r(9, 9, Connecting, &[], true, false), Ok(false));
    assert_eq!(
        r(9, 9, Online, &[K::WaitingForKey], true, false),
        Ok(false),
        "no key"
    );
    assert_eq!(r(9, 9, Online, &[K::VoidedItems], true, false), Ok(true));
    assert_eq!(
        r(9, 9, Offline, &[], false, true),
        Ok(true),
        "verified cache, offline"
    );
    assert_eq!(r(9, 9, Offline, &[], false, false), Ok(false));
    assert_eq!(
        r(9, 9, Online, &[K::Integrity], true, false),
        Err("sync_integrity")
    );
    assert_eq!(
        r(9, 9, Offline, &[K::AccessRevoked], false, true),
        Err("sync_revoked")
    );
    assert_eq!(
        r(9, 9, Online, &[K::Gone], true, false),
        Err("collection_deleted")
    );
    assert_eq!(
        r(9, 9, Online, &[K::UpgradeRequired], true, false),
        Err("sync_upgrade_required")
    );
}

#[test]
fn offline_opens_only_from_a_verified_cached_membership() {
    use mdbn_platform_native::SqliteIndex;
    use mdbn_replica::store::{Store, Tx, meta_keys};
    use mdbn_store_file::index::IndexDurability;
    use mdbn_wire::common::{B16, B32};
    let dir = scratch("cached");
    let state = dir.join("collections").join(COLLECTION);
    let (device, account, genesis) = ([7u8; 16], [8u8; 16], [9u8; 32]);
    let (root, key) = (strong(0x11), strong(0x22));
    let pins = crate::trust::pins_for(root, key);
    let check = || crate::runtime::cached_eligibility(&state, device, account, genesis, &pins);
    assert!(check().is_err(), "never opened");
    let write = |policy: &mdbn_replica::policy::PolicyState, g: Option<[u8; 32]>| {
        let index = std::rc::Rc::new(std::cell::RefCell::new(
            SqliteIndex::open(state.join("index.sqlite"), IndexDurability::Durable).unwrap(),
        ));
        let mut store = mdbn_store_file::SqlStore::open_with_limits(
            index,
            mdbn_store_file::SqlStoreLimits::DESKTOP,
        )
        .unwrap();
        store
            .commit(Tx {
                meta: vec![
                    (meta_keys::POLICY.into(), Some(policy.to_bytes().unwrap())),
                    (meta_keys::GENESIS.into(), g.map(|g| g.to_vec())),
                ],
                ..Tx::default()
            })
            .unwrap();
    };
    let mut policy = mdbn_replica::policy::PolicyState::new();
    policy.seq = 3;
    let kid = |k: &[u8; 32]| mdbn_replica::policy::key_id(k);
    policy.root = Some(kid(&root));
    policy.root_pk = Some(B32(root));
    policy.cp_roots.insert(B32(root));
    policy.signed_by_key.insert(kid(&key), vec![(1, 1)]);
    policy.cert_roots = Some([(kid(&key), kid(&root))].into_iter().collect());
    policy
        .members
        .insert(B16(account), mdbn_wire::policy::Role::Owner);
    let dev = mdbn_replica::policy::DeviceState {
        account: B16(account),
        kind: mdbn_wire::policy::DeviceKind::Desktop,
        sign_pk: B32([1; 32]),
        kem_pk: B32([2; 32]),
        noise_pk: B32([3; 32]),
        active: true,
        keyed: true,
        introduced_by: None,
        delivered_by: None,
        local_root: None,
        sas_commit: None,
    };
    policy.devices.insert(B16(device), dev.clone());
    write(&policy, Some(genesis));
    assert!(check().is_ok());
    let other = crate::trust::pins_for(root, strong(0x33));
    assert!(
        crate::runtime::cached_eligibility(&state, device, account, genesis, &other).is_err(),
        "built under a policy key that is not published now"
    );
    assert!(
        crate::runtime::preopen_cache_check(&state, genesis, &other).is_err(),
        "the same check gates every synced open before user-file IO"
    );
    let mut legacy = policy.clone();
    legacy.cert_roots = None;
    write(&legacy, Some(genesis));
    assert!(check().is_err(), "unproven attribution");
    write(&policy, Some([0; 32]));
    assert!(check().is_err(), "another genesis");
    write(&policy, None);
    assert!(check().is_err(), "no recorded genesis");
    let mut revoked = policy.clone();
    revoked.devices.insert(
        B16(device),
        mdbn_replica::policy::DeviceState {
            active: false,
            ..dev.clone()
        },
    );
    write(&revoked, Some(genesis));
    assert!(check().is_err(), "revoked device");
    let mut removed = policy.clone();
    removed.members.clear();
    write(&removed, Some(genesis));
    assert!(check().is_err(), "removed member");
    let mut other = policy.clone();
    other.devices.insert(
        B16(device),
        mdbn_replica::policy::DeviceState {
            account: B16([5; 16]),
            ..dev
        },
    );
    write(&other, Some(genesis));
    assert!(check().is_err(), "device of another account");
    let _ = std::fs::remove_dir_all(&dir);
}

/// An eligible synced collection opens its runtime at once (so revoke barriers and
/// close reach it) but stays `opening` until it is ready; here its log is
/// unreachable, so it never is, and the barrier and close still complete.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unready_synced_runtime_still_honours_barriers_and_close() {
    let dir = scratch("unready");
    let expires = crate::fsutil::now_ms() as i64 + 3_600_000;
    let server = connect_with(200, format!("{{\"token\":\"t\",\"expires_at\":{expires}}}")).await;
    // Bound then closed: no log listens there.
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let log = format!("http://127.0.0.1:{port}");
    save(
        &dir,
        &crate::sync::SyncConfig {
            log_url: log.clone(),
            ..link("cloud_copy")
        },
    );
    let trust = crate::trust::Trust {
        log_origin: log,
        ..trust_for(&server)
    };
    let mut h = host(
        &dir,
        SyncMode::Synced,
        ctx(&dir, Some(&server), Some(trust)),
    );
    if let Some(opener) = h.runtime.opener() {
        opener.clone().finish().await;
    }
    assert!(
        h.runtime().is_some(),
        "the slot is filled on open: {:?} {:?}",
        h.current(),
        h.runtime
            .opener()
            .and_then(|o| o.slot.get())
            .map(|r| r.as_ref().err().cloned())
    );
    assert_eq!(
        h.current(),
        (CollectionState::Opening, None),
        "not ready: no genesis read"
    );
    tokio::time::timeout(
        std::time::Duration::from_secs(10),
        h.barrier().unwrap().wait(),
    )
    .await
    .expect("a revoke barrier is never held by readiness");
    tokio::time::timeout(std::time::Duration::from_secs(10), h.close())
        .await
        .expect("close completes");
    let _ = std::fs::remove_dir_all(&dir);
}

/// A synced runtime whose cached store fails the pin check never opens its folder:
/// the refusal comes before any user-file IO (the folder here does not even exist).
#[test]
fn a_refused_cache_is_refused_before_the_folder_is_opened() {
    use mdbn_platform_native::SqliteIndex;
    use mdbn_replica::store::{Store, Tx, meta_keys};
    use mdbn_store_file::index::IndexDurability;
    struct NoGrants;
    impl mdbn_replica::policy::GrantSource for NoGrants {
        fn grant(
            &self,
            _: &mdbn_wire::common::B16,
        ) -> mdbn_replica::api::ApiResult<mdbn_replica::policy::EffectiveGrant> {
            Err(mdbn_replica::api::ErrorCode::Unauthenticated.err("the grant was revoked"))
        }
    }
    let dir = scratch("preio");
    let state = dir.join("collections").join(COLLECTION);
    {
        let index = std::rc::Rc::new(std::cell::RefCell::new(
            SqliteIndex::open(state.join("index.sqlite"), IndexDurability::Durable).unwrap(),
        ));
        let mut store = mdbn_store_file::SqlStore::open_with_limits(
            index,
            mdbn_store_file::SqlStoreLimits::DESKTOP,
        )
        .unwrap();
        let mut policy = mdbn_replica::policy::PolicyState::new();
        policy.seq = 2;
        store
            .commit(Tx {
                meta: vec![
                    (meta_keys::POLICY.into(), Some(policy.to_bytes().unwrap())),
                    (meta_keys::GENESIS.into(), Some(vec![1; 32])),
                ],
                ..Tx::default()
            })
            .unwrap();
    }
    let cfg = crate::runtime::RuntimeConfig {
        collection: crate::attest::uuid_bytes(COLLECTION).unwrap(),
        replica_id: [5; 16],
        device_id: [6; 16],
        root: dir.join("no-such-folder"),
        private_dir: state,
        adopt: None,
        id_hints: vec![],
        computer_name: None,
        sync: Some(crate::runtime::Synced {
            log_url: "https://log.lab.example".into(),
            chosen_state: mdbn_wire::policy::CState::CloudCopy,
            trusted_roots: vec![strong(0x11)],
            trusted_signers: vec![],
            user_enabled_cloud_copy: true,
            tokens: std::sync::Arc::new(crate::sync::ConnectTokens::new(
                std::sync::Arc::new(
                    crate::cloud::Cloud::new(
                        &crate::cloud::tls_config().unwrap(),
                        "https://cp.lab.example",
                        &{
                            let m = MemoryStore::default();
                            m.set(crate::cloud::CONNECTOR_TOKEN, b"t").unwrap();
                            m
                        },
                    )
                    .unwrap(),
                ),
                "66666666-6666-4666-8666-666666666666".into(),
                [0; 16],
                std::sync::Arc::new(crate::secrets::DeviceIdentity::generate().unwrap()),
                std::sync::Arc::new(|| Ok(())),
            )),
            secrets: std::sync::Arc::new(MemoryStore::default()),
            expected_genesis: [2; 32],
            policy_pins: crate::trust::pins_for(strong(0x11), strong(0x22)),
        }),
    };
    let e = crate::runtime::Runtime::open(
        cfg,
        mdbn_replica::DeviceSecrets {
            sign_sk: [1; 32],
            kem_sk: [2; 32],
        },
        Box::new(NoGrants),
        Default::default(),
    )
    .err()
    .expect("refused");
    assert!(
        matches!(&e, OpenFailed::Other(why) if why == "the cached store does not hold the pinned genesis"),
        "refused before the folder: {e}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// Readiness is maintained, not latched: a reconnect (not caught up) or a new key
/// wait returns a Ready runtime to opening; a terminal verdict wins over Ready.
#[test]
fn readiness_follows_every_observation() {
    use crate::runtime::synced_ready;
    use mdbn_wire::client::{Connection::*, IncidentKind as K};
    let seq = [
        (status(9, 9, Online, &[]), true, Readiness::Ready),
        (status(9, 9, Connecting, &[]), false, Readiness::Pending), // reconnecting
        (status(9, 12, Online, &[]), false, Readiness::Pending),    // behind the new head
        (status(12, 12, Online, &[]), true, Readiness::Ready),
        (
            status(12, 12, Online, &[K::WaitingForKey]),
            true,
            Readiness::Pending,
        ), // rekeyed
        (status(12, 12, Online, &[]), true, Readiness::Ready),
        (
            status(12, 12, Online, &[K::AccessRevoked]),
            true,
            Readiness::Failed("sync_revoked"),
        ),
    ];
    for (s, caught_up, want) in seq {
        assert_eq!(
            readiness_of(synced_ready(&s, None, caught_up, false), &s),
            want
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn status_lists_skipped_files_and_clears_repaired_notes() {
    let dir = scratch("skipped-notices");
    let root = dir.join("folder");
    std::fs::write(root.join("latin.md"), b"caf\xe9").unwrap();
    std::fs::write(root.join(".hidden.md"), "hidden").unwrap();
    std::fs::write(root.join("with-nul.md"), b"before\0after").unwrap();
    std::fs::write(root.join("nul.md"), b"before\0after").unwrap();
    std::fs::write(root.join("Note.md"), "first").unwrap();
    std::fs::write(root.join("note.md"), "collision").unwrap();
    for (name, size) in [("under-two.md", 2_097_024), ("over-two.md", 2_097_280)] {
        std::fs::write(root.join(name), vec![b'a'; size]).unwrap();
    }
    #[cfg(unix)]
    std::os::unix::fs::symlink("with-nul.md", root.join("linked.md")).unwrap();
    let context = ctx(&dir, None, None);
    let mut e = entry(&dir, SyncMode::Local);
    e.owner_account = Some(ACCOUNT.into());
    e.device = Some(crate::secrets::uuid_string(&context.identity.device_id));
    context.authority.publish_registry(&Registry {
        collections: vec![e.clone()],
        ..Default::default()
    });
    let mut host = CollectionHost::open(e, Some(context));
    assert_eq!(settled(&host).await.0, CollectionState::Ready);
    let out = host.observation().status().await;
    let messages = out
        .notices
        .iter()
        .map(|n| format!("{:?}: {}", n.path, n.message))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        messages.contains("latin.md") && messages.contains("Not valid UTF-8"),
        "{messages}"
    );
    assert!(
        messages.contains("under-two.md")
            && messages.contains("over-two.md")
            && messages.contains("1048576 bytes"),
        "{messages}"
    );
    assert!(
        !messages.contains("with-nul.md"),
        "valid UTF-8 NUL bodies are supported: {messages}"
    );
    assert!(
        messages.contains("\"nul.md\"") && messages.contains("reserved name"),
        "{messages}"
    );
    #[cfg(unix)]
    assert!(
        messages.contains("linked.md") && messages.contains("Symlink not followed"),
        "{messages}"
    );
    assert!(
        messages.contains("note.md") && messages.contains("collision"),
        "{messages}"
    );
    assert!(!messages.contains(".hidden.md"), "{messages}");
    let json = serde_json::to_string(&out).unwrap();
    assert!(json.contains("latin.md") && json.contains("Not valid UTF-8"));
    let mut many = vec![out.clone(); 100];
    for collection in &mut many {
        collection.notices = (0..3)
            .map(|n| crate::control::Notice {
                path: Some(format!("media/{n}-{}.png", "x".repeat(4096))),
                code: "quota_exceeded".into(),
                message: "Server storage is full; this file has not synced.".into(),
            })
            .collect();
    }
    crate::server::bound_file_notices(&mut many);
    assert!(many.iter().any(|collection| {
        collection
            .notices
            .iter()
            .any(|notice| notice.code == "status_file_notices_omitted")
    }));
    assert!(serde_json::to_vec(&many).unwrap().len() < crate::ipc::MAX_CONTROL_FRAME);

    std::fs::write(root.join("latin.md"), "café").unwrap();
    let runtime = host.runtime().unwrap();
    let inventory = runtime.inventory().await.unwrap();
    let repaired = host.observation().status().await;
    assert!(
        !repaired
            .notices
            .iter()
            .any(|n| n.path.as_deref() == Some("latin.md"))
    );
    assert!(inventory.0.iter().any(|(_, path)| path == "with-nul.md"));
    host.close().await;
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn deletion_at_startup_is_explicit_and_preserves_local_files() {
    let dir = scratch("deleted-startup");
    save(&dir, &link("cloud_copy"));
    std::fs::write(dir.join("folder/keep.md"), "keep these bytes").unwrap();
    let server = connect(409, "collection_deleted").await;
    let h = host(
        &dir,
        SyncMode::Synced,
        ctx(&dir, Some(&server), Some(trust_for(&server))),
    );
    assert_eq!(
        settled(&h).await,
        (CollectionState::Failed, Some("collection_deleted".into()))
    );
    let status = h.status();
    assert!(status.notices.iter().any(|n| n.code == "collection_deleted"
        && n.message.contains("deleted by its owner")
        && n.message.contains("collection remove")));
    assert!(h.runtime().is_none());
    assert!(untouched(&dir));
    assert_eq!(
        std::fs::read_to_string(dir.join("folder/keep.md")).unwrap(),
        "keep these bytes"
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn terminal_token_refusals_are_sticky_but_other_refusals_can_retry() {
    for (code, terminal) in [
        ("collection_deleted", true),
        ("device_revoked", true),
        ("not_enrolled", false),
    ] {
        let dir = scratch(code);
        let (server, posts) =
            connect_counted(409, format!(r#"{{"error":{{"code":"{code}"}}}}"#)).await;
        let context = ctx(&dir, Some(&server), Some(trust_for(&server)));
        let sync = context.sync.as_ref().unwrap();
        let tokens = crate::sync::ConnectTokens::new(
            sync.cloud.clone(),
            sync.connector_id.clone(),
            crate::attest::uuid_bytes(COLLECTION).unwrap(),
            context.identity,
            Arc::new(|| Ok(())),
        );
        assert!(tokens.eligibility().await.is_err());
        assert_eq!(
            tokens.terminal_reason(),
            if terminal { Some(code) } else { None }
        );
        assert_eq!(
            crate::logwire::TokenSource::current(&tokens).is_err(),
            terminal
        );
        crate::logwire::TokenSource::refused(&tokens);
        assert!(crate::logwire::TokenSource::token(&tokens).await.is_err());
        assert_eq!(
            posts.load(std::sync::atomic::Ordering::SeqCst),
            if terminal { 1 } else { 2 }
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn revocation_at_startup_is_explicit_and_preserves_local_files() {
    let dir = scratch("revoked-startup");
    save(&dir, &link("cloud_copy"));
    std::fs::write(dir.join("folder/keep.md"), "keep these bytes").unwrap();
    // A real durable hold is seeded here; this test checks retention, not the
    // earlier native generation of the read-only hold.
    use mdbn_replica::store::{Store, Tx};
    let open_store = || {
        let index = std::rc::Rc::new(std::cell::RefCell::new(
            mdbn_platform_native::SqliteIndex::open(
                dir.join("collections")
                    .join(COLLECTION)
                    .join("index.sqlite"),
                mdbn_store_file::index::IndexDurability::Durable,
            )
            .unwrap(),
        ));
        mdbn_store_file::SqlStore::open_with_limits(index, mdbn_store_file::SqlStoreLimits::DESKTOP)
            .unwrap()
    };
    let held = mdbn_wire::client::Hold {
        id: mdbn_wire::common::B16([7; 16]),
        path: "keep.md".into(),
        reason: mdbn_wire::client::HoldReason::ReadOnly,
        since: 0,
        base: None,
        mine: mdbn_wire::snapshot::TextOrBlob::Text("keep these bytes".into()),
        theirs: None,
        saves: 0,
    };
    open_store()
        .commit(Tx {
            holds_put: vec![held.clone()],
            ..Tx::default()
        })
        .unwrap();
    let server = connect(409, "device_revoked").await;
    let h = host(
        &dir,
        SyncMode::Synced,
        ctx(&dir, Some(&server), Some(trust_for(&server))),
    );
    assert_eq!(
        settled(&h).await,
        (CollectionState::Failed, Some("sync_revoked".into()))
    );
    let status = h.status();
    assert!(status.notices.iter().any(|n| n.code == "sync_revoked"
        && n.message.contains("was removed from this collection")
        && n.message.contains("new empty folder")
        && n.message.contains("Local edits held")
        && n.message.contains("--state-dir")));
    assert!(h.runtime().is_none());
    assert_eq!(open_store().holds().unwrap(), vec![held]);
    assert_eq!(
        std::fs::read_to_string(dir.join("folder/keep.md")).unwrap(),
        "keep these bytes"
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn token_revocation_after_open_stops_the_actor_and_retains_files() {
    let dir = scratch("revoked-runtime");
    save(&dir, &link("cloud_copy"));
    std::fs::write(dir.join("folder/held.md"), b"local edits to copy across").unwrap();
    // First pre-open eligibility succeeds. Runtime renewal is then refused.
    // The token is inside the renewal margin so this needs no wall-clock wait.
    let (server, posts) = connect_sequence(vec![
        (
            200,
            format!(
                r#"{{"token":"short-lived","expires_at":{}}}"#,
                crate::fsutil::now_ms() + 30_000
            ),
        ),
        (409, r#"{"error":{"code":"device_revoked"}}"#.into()),
    ])
    .await;
    let mut h = host(
        &dir,
        SyncMode::Synced,
        ctx(&dir, Some(&server), Some(trust_for(&server))),
    );
    // The opener completes before the asynchronous readiness verdict.
    settled(&h).await;
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let failure = h.status().last_sync_failure;
            if failure.is_some_and(|f| {
                f.kind == crate::sync_failure::Kind::AccessRevoked && f.persisted == Some(true)
            }) && h.runtime().unwrap().readiness().await.is_none()
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("terminal failure persists and the runtime stops");
    h.refresh();
    assert_eq!(h.state(), CollectionState::Failed);
    assert!(!h.is_serving());
    assert_eq!(posts.load(std::sync::atomic::Ordering::SeqCst), 2);
    assert_eq!(
        std::fs::read(dir.join("folder/held.md")).unwrap(),
        b"local edits to copy across"
    );
    assert_eq!(
        crate::sync_failure::Failure::load(&dir.join("collections").join(COLLECTION))
            .unwrap()
            .unwrap()
            .kind,
        crate::sync_failure::Kind::AccessRevoked
    );
    h.close().await;
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn log_revocation_drops_cached_tokens_only_for_the_removed_collection() {
    use crate::logwire::TokenSource;
    let dir = scratch("revoked-token-cache");
    let (server, posts) = connect_counted(
        200,
        format!(
            r#"{{"token":"cached","expires_at":{}}}"#,
            crate::fsutil::now_ms() + 900_000
        ),
    )
    .await;
    let context = ctx(&dir, Some(&server), Some(trust_for(&server)));
    let sync = context.sync.as_ref().unwrap();
    let make = |collection| {
        crate::sync::ConnectTokens::new(
            sync.cloud.clone(),
            sync.connector_id.clone(),
            collection,
            context.identity.clone(),
            Arc::new(|| Ok(())),
        )
    };
    let removed = make([1; 16]);
    let other = make([2; 16]);
    removed.eligibility().await.unwrap();
    assert!(removed.token().await.is_ok());
    assert_eq!(posts.load(std::sync::atomic::Ordering::SeqCst), 1);
    removed.revoked();
    removed.refused();
    assert_eq!(removed.terminal_reason(), Some("device_revoked"));
    assert!(removed.token().await.is_err());
    assert_eq!(posts.load(std::sync::atomic::Ordering::SeqCst), 1);
    other.eligibility().await.unwrap();
    assert_eq!(posts.load(std::sync::atomic::Ordering::SeqCst), 2);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn integrity_recovery_backs_off_stops_and_resets_once_serving() {
    let t0 = std::time::Instant::now();
    let s = std::time::Duration::from_secs;
    let mut r = Recovery::default();
    // Opening, paused or another failure: nothing to do.
    assert_eq!(r.step(None, false, t0), None);
    assert_eq!(r, Recovery::default());
    // The first stop is reopened after 10 s, not at once.
    assert_eq!(r.step(Some(Stop::Integrity), false, t0), None);
    assert_eq!(r.step(Some(Stop::Integrity), false, t0 + s(9)), None);
    assert_eq!(r.step(Some(Stop::Integrity), false, t0 + s(10)), Some(1));
    // While that reopen is opening, nothing; a second stop waits a minute.
    assert_eq!(r.step(None, false, t0 + s(11)), None);
    assert_eq!(r.step(Some(Stop::Integrity), false, t0 + s(20)), None);
    assert_eq!(r.step(Some(Stop::Integrity), false, t0 + s(79)), None);
    assert_eq!(r.step(Some(Stop::Integrity), false, t0 + s(80)), Some(2));
    assert_eq!(r.step(Some(Stop::Integrity), false, t0 + s(80)), None);
    assert_eq!(r.step(Some(Stop::Integrity), false, t0 + s(380)), Some(3));
    let at = t0 + s(380 + 86_400);
    assert_eq!(r.step(Some(Stop::Integrity), false, at), None);
    assert!(r.integrity_exhausted());
    assert_eq!(r.due, None);
    // Serving again resets the policy: the next stop waits 10 s again.
    assert_eq!(r.step(None, true, at), None);
    assert_eq!(r, Recovery::default());
    assert_eq!(r.step(Some(Stop::Integrity), false, at), None);
    assert_eq!(r.step(Some(Stop::Integrity), false, at + s(10)), Some(1));
}

#[test]
fn a_transient_open_error_keeps_retrying_at_the_backoff_cap() {
    let t0 = std::time::Instant::now();
    let s = std::time::Duration::from_secs;
    let mut r = Recovery::default();
    assert_eq!(r.step(Some(Stop::Integrity), false, t0), None);
    assert_eq!(r.step(Some(Stop::Integrity), false, t0 + s(10)), Some(1));
    let io = Some(Stop::OpenIo);
    let mut at = t0 + s(11);
    for (attempt, delay) in [(2, 60), (3, 300), (4, 1800), (5, 1800), (6, 1800)] {
        assert_eq!(r.step(io, false, at), None);
        assert_eq!(r.step(io, false, at + s(delay - 1)), None);
        at += s(delay);
        assert_eq!(r.step(io, false, at), Some(attempt));
    }
    assert_eq!(r.step(None, true, at), None);
    assert_eq!(r, Recovery::default());
}

#[test]
fn a_storage_fence_reopens_at_once_and_stops_when_the_same_fault_repeats() {
    let t0 = std::time::Instant::now();
    let s = std::time::Duration::from_secs;
    let disk = Some(Stop::Fenced(
        "apply_durability_unknown: store i/o: disk full",
    ));
    let mut r = Recovery::default();
    // The first fence reopens at once, then the integrity backoff follows.
    assert_eq!(r.step(disk, false, t0), Some(1));
    assert_eq!(r.step(None, false, t0 + s(1)), None, "opening");
    assert_eq!(r.step(disk, false, t0 + s(2)), None);
    assert_eq!(r.step(disk, false, t0 + s(12)), Some(2));
    assert_eq!(r.step(disk, false, t0 + s(13)), None);
    assert_eq!(r.step(disk, false, t0 + s(73)), Some(3));
    assert!(!r.gave_up());
    // The third reopen fences the same way: no more automatic reopens.
    assert_eq!(r.step(disk, false, t0 + s(74)), None);
    assert!(r.gave_up());
    for later in [s(75), s(3600), s(86_400)] {
        assert_eq!(r.step(disk, false, t0 + later), None);
    }
    // Serving (after `mdbase collection resume`) starts over.
    assert_eq!(r.step(None, true, t0 + s(90_000)), None);
    assert_eq!(r, Recovery::default());

    // A different cause is a different fault: its count starts again.
    let other = Some(Stop::Fenced("account_key_commit_unknown"));
    let mut r = Recovery::default();
    assert_eq!(r.step(disk, false, t0), Some(1));
    assert_eq!(r.step(disk, false, t0), None);
    assert_eq!(r.step(disk, false, t0 + s(10)), Some(2));
    assert_eq!(r.step(other, false, t0 + s(11)), None);
    assert_eq!(r.step(other, false, t0 + s(71)), Some(3));
    assert_eq!(r.step(disk, false, t0 + s(72)), None);
    assert!(!r.gave_up(), "{r:?}");
    // So does an integrity stop between two fences.
    let mut r = Recovery::default();
    assert_eq!(r.step(disk, false, t0), Some(1));
    assert_eq!(r.step(disk, false, t0), None);
    assert_eq!(r.step(disk, false, t0 + s(10)), Some(2));
    let integrity = Some(Stop::Integrity);
    assert_eq!(r.step(integrity, false, t0 + s(11)), None);
    assert_eq!(r.step(integrity, false, t0 + s(311)), Some(3));
    assert_eq!(r.step(disk, false, t0 + s(312)), None);
    assert_eq!(r.fenced.as_ref().map(|(_, n)| *n), Some(1));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_collection_stopped_by_an_integrity_incident_reopens_with_a_notice() {
    let dir = scratch("integrity-reopen");
    let mut h = host(&dir, SyncMode::SyncedE2e, ctx(&dir, None, None));
    // A runtime stopped by the readiness gate, as `current()` reports it.
    h.state = CollectionState::Failed;
    h.reason = Some(SYNC_INTEGRITY.into());
    let t0 = std::time::Instant::now();
    assert!(
        h.recover_due(t0).is_none(),
        "the first reopen waits for its backoff"
    );
    let notice = h
        .status()
        .notices
        .into_iter()
        .find(|n| n.code == SYNC_INTEGRITY)
        .expect("a failed collection says what happens next");
    assert!(notice.message.contains("reopens it automatically in about"));
    assert!(notice.message.contains("(attempt 1)"));
    assert!(
        notice
            .message
            .contains(&format!("mdbase collection resume {COLLECTION}"))
    );
    assert!(notice.message.contains("mdbase logs"));
    let stop = h
        .recover_due(t0 + std::time::Duration::from_secs(10))
        .unwrap();
    stop.clone().await;
    h = h.next_after_stop(&stop).unwrap();
    h.refresh();
    assert_ne!(
        h.current(),
        (CollectionState::Failed, Some(SYNC_INTEGRITY.into())),
        "reopened through refresh, which re-evaluates the collection"
    );
    assert_eq!(h.recovery.attempts, 1);
    // An explicit retry starts the backoff over.
    h.state = CollectionState::Failed;
    h.reason = Some(SYNC_INTEGRITY.into());
    h.retry().await;
    assert_eq!(h.recovery, Recovery::default());
    h.close().await;
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_open_failure_retries_only_with_a_typed_transient_error() {
    let dir = scratch("transient-open");
    let context = ctx(&dir, None, None);
    let mut e = entry(&dir, SyncMode::Local);
    e.owner_account = Some(ACCOUNT.into());
    e.device = Some(crate::secrets::uuid_string(&context.identity.device_id));
    context.authority.publish_registry(&Registry {
        collections: vec![e.clone()],
        ..Default::default()
    });
    let mut h = CollectionHost::open(e, Some(context));
    assert_eq!(settled(&h).await, (CollectionState::Ready, None));
    h.close().await;
    h.state = CollectionState::Opening;
    let os_error = std::io::Error::from(std::io::ErrorKind::StorageFull);
    let set_failure = |h: &mut CollectionHost, failure| {
        let slot = Arc::new(OnceLock::new());
        assert!(slot.set(Err(failure)).is_ok());
        let (_done, done) = tokio::sync::watch::channel(true);
        h.runtime = HostedRuntime::Open(Opener { slot, done });
    };
    let now = std::time::Instant::now();
    let seconds = std::time::Duration::from_secs;
    // A diagnostic string that looks like ENOSPC isn't evidence that it's safe to retry.
    set_failure(&mut h, OpenFailed::Other(os_error.to_string()));
    assert!(h.recover_due(now).is_none());
    assert!(h.recover_due(now + seconds(3600)).is_none());
    set_failure(&mut h, OpenFailed::RetryableIo(os_error.to_string()));
    assert!(h.recover_due(now).is_none());
    assert_eq!(
        h.current(),
        (CollectionState::Failed, Some("open_failed".into()))
    );
    assert!(
        h.status()
            .notices
            .iter()
            .any(|n| n.code == "open_failed" && n.message.contains("reopens it automatically"))
    );
    assert!(h.recover_due(now + seconds(9)).is_none());
    let stop = h.recover_due(now + seconds(10)).unwrap();
    stop.clone().await;
    h = h.next_after_stop(&stop).unwrap();
    h.refresh();
    assert_eq!(settled(&h).await.0, CollectionState::Ready);
    assert!(h.recover_due(now + seconds(11)).is_none());
    assert_eq!(h.recovery, Recovery::default());
    h.close().await;
    std::fs::remove_dir_all(dir).unwrap();
}

/// A synced collection whose replica fences itself with the same storage fault
/// after every automatic reopen is left failed after [`FENCE_REOPENS`] of them,
/// with a notice naming the fault; `mdbase collection resume` reopens it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_repeating_storage_fence_stops_reopening_until_resumed() {
    const CAUSE: &str = "apply_durability_unknown: store i/o: disk I/O error";
    let dir = scratch("fence-gives-up");
    let expires = crate::fsutil::now_ms() as i64 + 3_600_000;
    let server = connect_with(200, format!("{{\"token\":\"t\",\"expires_at\":{expires}}}")).await;
    // No log listens there: each opened runtime stays unready until it is fenced.
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let log = format!("http://127.0.0.1:{port}");
    save(
        &dir,
        &crate::sync::SyncConfig {
            log_url: log.clone(),
            ..link("cloud_copy")
        },
    );
    let trust = crate::trust::Trust {
        log_origin: log,
        ..trust_for(&server)
    };
    let mut h = host(
        &dir,
        SyncMode::Synced,
        ctx(&dir, Some(&server), Some(trust)),
    );
    // What the readiness gate records when it stops a fenced runtime.
    let fence = |h: &CollectionHost| {
        assert!(h.runtime().is_some(), "{:?}", h.current());
        *h.ready.lock().unwrap() = Readiness::Fenced(CAUSE.into());
    };
    let t0 = std::time::Instant::now();
    let mut at = t0;
    for attempt in 1..=FENCE_REOPENS {
        settled(&h).await;
        fence(&h);
        assert_eq!(h.current(), (CollectionState::Opening, None));
        let notice = h
            .status()
            .notices
            .into_iter()
            .find(|n| n.code == "sync_reopening")
            .expect("a fenced collection says it is reopening");
        assert!(notice.message.contains(&format!("(attempt {attempt})")));
        // At once the first time, then the integrity backoff.
        let stop = loop {
            if let Some(stop) = h.recover_due(at) {
                break stop;
            }
            at += std::time::Duration::from_secs(1);
        };
        assert_eq!(h.recovery.attempts, attempt);
        stop.clone().await;
        h = h.next_after_stop(&stop).unwrap();
        h.refresh();
    }
    assert_eq!(at - t0, std::time::Duration::from_secs(10 + 60));
    // The last reopen fences the same way: it stays stopped and says why.
    settled(&h).await;
    fence(&h);
    for later in [0, 60, 3600, 86_400] {
        assert!(
            h.recover_due(at + std::time::Duration::from_secs(later))
                .is_none()
        );
    }
    assert_eq!(
        h.current(),
        (CollectionState::Failed, Some(STORAGE_FAULT.into()))
    );
    let status = h.status();
    assert!(status.last_sync_failure.is_none(), "not a sync failure");
    let notice = status
        .notices
        .iter()
        .find(|n| n.code == STORAGE_FAULT)
        .expect("a needs-attention notice");
    assert!(notice.message.contains(CAUSE), "{}", notice.message);
    assert!(
        notice
            .message
            .contains(&format!("mdbase collection resume {COLLECTION}"))
    );
    assert!(!status.notices.iter().any(|n| n.code == "sync_reopening"));
    // `mdbase collection resume` reopens it and starts the policy over.
    h.retry().await;
    assert_eq!(h.recovery, Recovery::default());
    assert_eq!(settled(&h).await, (CollectionState::Opening, None));
    assert!(h.runtime().is_some());
    h.close().await;
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn deleted_and_revoked_collections_are_never_reopened_automatically() {
    for code in ["collection_deleted", "device_revoked"] {
        let dir = scratch(&format!("terminal-{code}"));
        save(&dir, &link("cloud_copy"));
        let (server, posts) =
            connect_counted(409, format!(r#"{{"error":{{"code":"{code}"}}}}"#)).await;
        let mut h = host(
            &dir,
            SyncMode::Synced,
            ctx(&dir, Some(&server), Some(trust_for(&server))),
        );
        let (state, _) = settled(&h).await;
        assert_eq!(state, CollectionState::Failed);
        let opened = posts.load(std::sync::atomic::Ordering::SeqCst);
        let t0 = std::time::Instant::now();
        for minutes in [0, 1, 10, 60, 600] {
            assert!(
                h.recover_due(t0 + std::time::Duration::from_secs(minutes * 60))
                    .is_none(),
                "{code} stays terminal"
            );
        }
        assert_eq!(posts.load(std::sync::atomic::Ordering::SeqCst), opened);
        assert!(
            !h.status().notices.iter().any(|n| n.code == SYNC_INTEGRITY),
            "no promise of an automatic reopen"
        );
        // `mdbase collection resume` still asks again at once.
        h.retry().await;
        settled(&h).await;
        assert!(posts.load(std::sync::atomic::Ordering::SeqCst) > opened);
        h.close().await;
        std::fs::remove_dir_all(dir).unwrap();
    }
}

impl CollectionHost {
    /// Hold the opener-completion part of a real host stop until the test releases it.
    pub(crate) fn hold_integrity_stop(&mut self) -> tokio::sync::watch::Sender<bool> {
        self.state = CollectionState::Failed;
        self.reason = Some(SYNC_INTEGRITY.into());
        self.hold_open()
    }

    /// Make the background open look unfinished (a large first scan) until the
    /// test sends `true`: revoke barriers wait for it.
    pub(crate) fn hold_open(&mut self) -> tokio::sync::watch::Sender<bool> {
        let (release, opened) = tokio::sync::watch::channel(false);
        let HostedRuntime::Open(opener) = &mut self.runtime else {
            panic!("expected an opened runtime")
        };
        opener.done = opened;
        release
    }
}
