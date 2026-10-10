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
                if req.contains("/log-token") {
                    counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                }
                (status, answer.clone())
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
async fn mirror_closed_sqlite_startup_reports_counts_without_opening_folder() {
    use mdbn_platform_native::SqliteIndex;
    use mdbn_replica::mirror_admission::Fence;
    use mdbn_store_file::index::IndexDurability;
    use mdbn_store_file::{SqlStore, SqlStoreLimits};
    for detached in [false, true] {
        let dir = scratch(if detached {
            "mirror-detached"
        } else {
            "mirror-joining"
        });
        std::fs::write(dir.join("folder/local.md"), b"local user bytes").unwrap();
        let private = dir.join("collections").join(COLLECTION);
        let index = std::rc::Rc::new(std::cell::RefCell::new(
            SqliteIndex::open(private.join("index.sqlite"), IndexDurability::Durable).unwrap(),
        ));
        let mut store = SqlStore::open_with_limits(index, SqlStoreLimits::DESKTOP).unwrap();
        let f = Fence::new([1; 16], 3).unwrap();
        f.persist(&mut store).unwrap();
        if detached {
            f.detached().persist(&mut store).unwrap();
        }
        drop(store);
        struct NoGrants;
        impl mdbn_replica::policy::GrantSource for NoGrants {
            fn grant(
                &self,
                _: &mdbn_wire::common::Uuid,
            ) -> Option<mdbn_replica::policy::EffectiveGrant> {
                None
            }
        }
        let direct = crate::runtime::Runtime::open(
            crate::runtime::RuntimeConfig {
                collection: [1; 16],
                replica_id: [2; 16],
                device_id: [3; 16],
                root: dir.join("folder"),
                private_dir: private.clone(),
                sync: None,
            },
            mdbn_replica::DeviceSecrets {
                sign_sk: [4; 32],
                kem_sk: [5; 32],
            },
            Box::new(NoGrants),
            Default::default(),
        );
        assert!(matches!(direct, Err(e) if e.0.contains("3 items pending/held")));
        assert!(
            !dir.join("folder/.mdbase").exists(),
            "direct runtime also pre-open closed"
        );
        let context = ctx(&dir, None, None);
        let mut e = entry(&dir, SyncMode::Local);
        e.owner_account = Some(ACCOUNT.into());
        e.device = Some(crate::secrets::uuid_string(&context.identity.device_id));
        context.authority.publish_registry(&Registry {
            collections: vec![e.clone()],
            ..Default::default()
        });
        let mut host = CollectionHost::open(e, Some(context));
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if host.mirror_diagnostic().is_some() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let status = host.status();
        assert_eq!(status.state, CollectionState::Unavailable);
        assert_eq!(
            status.reason.as_deref(),
            Some(if detached {
                "detached_sync"
            } else {
                "joining_sync"
            })
        );
        assert!(
            status
                .notices
                .iter()
                .any(|n| n.message.contains("3 items pending/held"))
        );
        assert!(host.runtime().is_none());
        assert!(
            !dir.join("folder/.mdbase").exists(),
            "no folder host lock/private dirs"
        );
        assert_eq!(
            std::fs::read(dir.join("folder/local.md")).unwrap(),
            b"local user bytes"
        );
        host.close().await;
        let diagnostic = crate::runtime::preopen_mirror_status(&private)
            .unwrap()
            .unwrap();
        assert_eq!(
            diagnostic.phase,
            if detached { "detached" } else { "joining" }
        );
        assert_eq!(diagnostic.pending, 3);
        std::fs::remove_dir_all(dir).unwrap();
    }
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
    let out = host.observed_status().await;
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
    assert!(host.observed_status().await.sync.is_none());
    host.close().await;
    assert!(host.observed_status().await.sync.is_none());
    assert!(runtime.telemetry().await.is_none());
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn telemetry_source_is_checked_before_poll_and_after_actor_await() {
    let dir = scratch("telemetry-source");
    for stale_before in [false, true] {
        let context = ctx(&dir, None, None);
        let mut e = entry(&dir, SyncMode::Local);
        e.owner_account = Some(ACCOUNT.into());
        e.device = Some(crate::secrets::uuid_string(&context.identity.device_id));
        context.authority.publish_registry(&Registry {
            collections: vec![e],
            ..Default::default()
        });
        let source = context
            .authority
            .source(mdbn_wire::common::B16(
                crate::attest::uuid_bytes(COLLECTION).unwrap(),
            ))
            .unwrap();
        if stale_before {
            context.authority.invalidate(2);
        }
        let polled = std::cell::Cell::new(false);
        let cancel = AtomicBool::new(false);
        let sample = crate::control::SyncCounters {
            confirmed_through: 1,
            head_known: 1,
            pending: 0,
            holds: 0,
            unresolved: 0,
            connection: "online".into(),
            head_digest: None,
            confirmed_record_digest: None,
            last_error: None,
            resyncing: false,
            unsupported_entries: 0,
        };
        let observed = current_telemetry(&source, &cancel, async {
            polled.set(true);
            context.authority.invalidate(2);
            Some(sample)
        })
        .await;
        assert!(observed.is_none());
        assert_eq!(polled.get(), !stale_before);
    }
    let _ = std::fs::remove_dir_all(dir);
}

async fn settled(h: &CollectionHost) -> (CollectionState, Option<String>) {
    if let Some(mut rx) = h.opened.clone() {
        let _ = rx.wait_for(|d| *d).await;
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

fn status(
    through: u64,
    head: u64,
    conn: mdbn_wire::client::Connection,
    incidents: &[mdbn_wire::client::IncidentKind],
) -> mdbn_wire::client::SyncStatus {
    mdbn_wire::client::SyncStatus {
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
        synced_ready(&status(through, head, conn, inc), caught_up, cached)
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
    if let Some(mut rx) = h.opened.clone() {
        let _ = rx.wait_for(|d| *d).await;
    }
    assert!(
        h.runtime().is_some(),
        "the slot is filled on open: {:?} {:?}",
        h.current(),
        h.runtime
            .as_ref()
            .and_then(|s| s.get())
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
        ) -> Option<mdbn_replica::policy::EffectiveGrant> {
            None
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
        e.0.starts_with("cache:"),
        "refused before the folder: {}",
        e.0
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
        assert_eq!(readiness_of(synced_ready(&s, caught_up, false)), want);
    }
}
