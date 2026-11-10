//! Pre-open checks on private state, the readiness rule and opening the replica.

use super::*;

/// Read the closed mirror fence from daemon-private authoritative metadata only.
/// Never opens a folder, host lock, FileStore, replica, or network connection.
pub fn preopen_mirror_status(
    private_dir: &std::path::Path,
) -> Result<Option<crate::takeover::mirror_driver::Diagnostic>, String> {
    let path = private_dir.join("index.sqlite");
    if !path.exists() {
        return Ok(None);
    }
    crate::fsutil::verify_owner_only(private_dir).map_err(|e| format!("private state: {e}"))?;
    let index = Rc::new(RefCell::new(
        SqliteIndex::open(path, IndexDurability::Durable).map_err(|e| format!("index: {e:?}"))?,
    ));
    let store = SqlStore::open_with_limits(index, SqlStoreLimits::DESKTOP)
        .map_err(|e| format!("store: {e:?}"))?;
    match crate::takeover::mirror_driver::Closed::resume(store) {
        Ok(closed) => Ok(Some(closed.diagnostic())),
        Err(crate::takeover::mirror_driver::Error::MissingFence) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// The verified policy a synced collection's index already holds, checked before
/// user-file IO. Missing/new cache is not trusted; genesis/pins must match.
/// Reads committed private metadata, never the folder.
pub fn preopen_cache_check(
    private_dir: &std::path::Path,
    expected_genesis: [u8; 32],
    pins: &mdbn_replica::policy::PolicyPins,
) -> Result<Option<mdbn_replica::policy::PolicyState>, String> {
    use mdbn_replica::store::{Store as _, meta_keys};
    let path = private_dir.join("index.sqlite");
    if !path.exists() {
        return Ok(None);
    }
    let index = Rc::new(RefCell::new(
        SqliteIndex::open(path, IndexDurability::Durable).map_err(|e| format!("index: {e:?}"))?,
    ));
    let store = SqlStore::open_with_limits(index, SqlStoreLimits::DESKTOP)
        .map_err(|e| format!("store: {e:?}"))?;
    // A present committed marker is authoritative even in a cold/empty cache.
    // Check it BEFORE allowing missing/seq0 policy to skip the warm-history gate.
    let genesis = store
        .meta(meta_keys::GENESIS)
        .map_err(|e| format!("{e:?}"))?;
    if genesis
        .as_deref()
        .is_some_and(|g| g != &expected_genesis[..])
    {
        return Err("the cached store does not hold the pinned genesis".into());
    }
    let Some(policy) = store
        .meta(meta_keys::POLICY)
        .map_err(|e| format!("{e:?}"))?
    else {
        return Ok(None);
    };
    let policy = mdbn_replica::policy::PolicyState::from_bytes(&policy)
        .map_err(|e| format!("policy: {e}"))?;
    if policy.seq == 0 {
        return Ok(None);
    }
    if genesis.as_deref() != Some(&expected_genesis[..]) {
        return Err("the cached store does not hold the pinned genesis".into());
    }
    if !policy.consistent_with(pins) {
        return Err("the cached store was built under unpublished control-plane keys".into());
    }
    Ok(Some(policy))
}

/// Verified cached eligibility for opening a synced collection while Connect cannot be
/// asked: the cached store passes [`preopen_cache_check`] under the current pins,
/// and its verified policy has this device active for `account`, a current member.
pub fn cached_eligibility(
    private_dir: &std::path::Path,
    device: [u8; 16],
    account: [u8; 16],
    expected_genesis: [u8; 32],
    pins: &mdbn_replica::policy::PolicyPins,
) -> Result<(), String> {
    let policy = preopen_cache_check(private_dir, expected_genesis, pins)?.ok_or("never opened")?;
    let active = policy
        .devices
        .get(&B16(device))
        .is_some_and(|d| d.active && d.account == B16(account));
    if !active || !policy.members.contains_key(&B16(account)) {
        return Err("not an active member device in the verified policy".into());
    }
    Ok(())
}

/// Whether a synced runtime may be reported ready: `Ok(true)` when ready,
/// `Ok(false)` while it should keep opening, `Err(reason)` when it never can
/// (terminal). Ready needs the pinned genesis applied (`confirmed_through > 0`)
/// and no missing epoch key, and then either: online, having read up to the head
/// heard in this connection (`caught_up`); or, only while not online, the verified
/// cached membership checked before open (`cached`).
pub fn synced_ready(
    s: &mdbn_wire::client::SyncStatus,
    caught_up: bool,
    cached: bool,
) -> Result<bool, &'static str> {
    use mdbn_wire::client::{Connection, IncidentKind as K};
    for i in &s.incidents {
        match i.kind {
            K::Integrity | K::VerificationMismatch | K::KeyInconsistent => {
                return Err("sync_integrity");
            }
            K::AccessRevoked => return Err("sync_revoked"),
            K::Gone => return Err("collection_deleted"),
            K::UpgradeRequired => return Err("sync_upgrade_required"),
            _ => {}
        }
    }
    if s.confirmed_through == 0 || s.incidents.iter().any(|i| i.kind == K::WaitingForKey) {
        return Ok(false);
    }
    Ok(match s.connection {
        Connection::Online => caught_up && s.head_known <= s.confirmed_through,
        Connection::Connecting | Connection::Offline => cached,
    })
}

/// A host that cannot take the OS lock (the Obsidian in-app host)
/// announces itself only in `host.json`. A fresh one, or one that cannot be
/// read, means the folder is hosted: refuse before taking the lock. A stale
/// one is a dead host's and is taken over (the daemon then re-publishes its
/// own descriptor, which a paused lockless host yields to). Descriptors of
/// lock-taking hosts (daemon, library) are decided by the lock itself.
fn refuse_lockless_host(root: &std::path::Path) -> Result<(), OpenFailed> {
    use mdbn_local_host::{DescriptorState, HostKind};
    match mdbn_local_host::host_lock::descriptor_state(root, PRIVATE_DIR) {
        DescriptorState::Present(d)
            if !matches!(d.host, HostKind::Daemon | HostKind::Library)
                && !d.is_stale(crate::fsutil::now_ms() as u64, HOST_DESCRIPTOR_STALE_MS) =>
        {
            Err(OpenFailed(format!(
                "folder host lock: hosted by {}",
                d.host
            )))
        }
        DescriptorState::Unreadable(why) => Err(OpenFailed(format!(
            "folder host lock: unreadable host descriptor ({why})"
        ))),
        _ => Ok(()),
    }
}

/// The grant source is installed at open, before pending app rows are validated
/// or materialized: a replica opened without one is Host-only.
pub(super) fn open_replica(
    cfg: &RuntimeConfig,
    secrets: DeviceSecrets,
    source: Box<dyn mdbn_replica::policy::GrantSource>,
) -> Result<(Replica<Store>, mdbn_local_host::HostLock), OpenFailed> {
    let err = |what: &str, e: &dyn std::fmt::Debug| OpenFailed(format!("{what}: {e:?}"));
    let t0 = std::time::Instant::now();
    crate::fsutil::ensure_private_dir(&cfg.private_dir).map_err(|e| err("state dir", &e))?;
    // Synced: a cached store must match the pinned genesis and the published keys
    // before the folder is opened (no user-file IO for a refused cache).
    if let Some(sync) = &cfg.sync {
        preopen_cache_check(&cfg.private_dir, sync.expected_genesis, &sync.policy_pins)
            .map_err(|e| OpenFailed(format!("cache: {e}")))?;
    }
    // One host per folder: the library or another daemon holding it refuses here,
    // before any file or index is touched.
    refuse_lockless_host(&cfg.root)?;
    let lock = mdbn_local_host::HostLock::try_acquire(
        &cfg.root,
        PRIVATE_DIR,
        Some(mdbn_local_host::Descriptor::new(
            mdbn_local_host::HostKind::Daemon,
            crate::fsutil::now_ms() as u64,
        )),
    )
    .map_err(|e| OpenFailed(format!("folder host lock: {e}")))?;
    // The shared native composition (mdbn-local-host): file store over the native
    // platform, the durable SQLite index in this collection's state directory.
    let store = mdbn_local_host::open_store(
        &cfg.root,
        &mdbn_local_host::StoreOptions {
            private_dir: PRIVATE_DIR.into(),
            state_dir: Some(cfg.private_dir.clone()),
            limits: SqlStoreLimits::DESKTOP,
            fs: FsConfig::default(),
            force_read_only: false,
        },
        Box::new(mdbn_local_host::SystemClock),
    )
    .map_err(|e| OpenFailed(format!("store: {e}")))?;
    let diagnostics = store.platform().diagnostics();
    let platform = store.platform().clone();
    if diagnostics.backup_exclusion_failures != 0 {
        tracing::warn!(
            backup_exclusion_failures = diagnostics.backup_exclusion_failures,
            "retained-file backup exclusion unavailable; retained bytes may reach backups"
        );
    }
    let store = crate::keyring_store::KeychainKeyring::new(
        store,
        cfg.sync.as_ref().map(|s| s.secrets.clone()),
        &B16(cfg.collection),
    )
    .map_err(|e| err("keyring", &e))?;
    let store_ms = t0.elapsed().as_millis() as u64;
    let rcfg = match &cfg.sync {
        None => ReplicaConfig {
            collection: B16(cfg.collection),
            replica_id: B16(cfg.replica_id),
            device_id: B16(cfg.device_id),
            mode: SyncMode::LocalOnly,
            log_endpoint: EndpointId(0),
            verify: false,
            runtime_version: crate::BINARY_VERSION.into(),
            trusted_roots: vec![],
            e2e: false,
            trusted_signers: vec![],
            user_enabled_cloud_copy: false,
            chosen_state: None,
            expected_genesis: None,
            key_grants_only: false,
            policy_pins: None,
        },
        Some(sync) => ReplicaConfig {
            collection: B16(cfg.collection),
            replica_id: B16(cfg.replica_id),
            device_id: B16(cfg.device_id),
            mode: SyncMode::Synced,
            log_endpoint: EndpointId(1),
            verify: true,
            runtime_version: crate::BINARY_VERSION.into(),
            trusted_roots: sync.trusted_roots.clone(),
            e2e: sync.chosen_state == mdbn_wire::policy::CState::E2e,
            trusted_signers: sync.trusted_signers.iter().map(|s| B16(*s)).collect(),
            user_enabled_cloud_copy: sync.user_enabled_cloud_copy,
            chosen_state: Some(sync.chosen_state),
            expected_genesis: Some(mdbn_wire::common::B32(sync.expected_genesis)),
            key_grants_only: false,
            policy_pins: Some(sync.policy_pins.clone()),
        },
    };
    // Fail closed before any transport use: trust anchors are local.
    rcfg.validate_host_trust()
        .map_err(|e| OpenFailed(format!("trust: {e}")))?;
    let sealer = KeyringSealer::new(
        B16(cfg.collection),
        B16(cfg.device_id),
        &secrets.sign_sk,
        &secrets.kem_sk,
    );
    let host = Host {
        clock: Box::new(mdbn_local_host::SystemClock),
        entropy: Box::new(mdbn_local_host::OsEntropy),
        zones: Box::new(mdbn_local_host::SystemZones::new(
            mdbn_local_host::SystemZones::machine_zone(),
        )),
    };
    let mut rep = Replica::open_with_grant_source(
        rcfg,
        store,
        Box::new(CorePlanner),
        Box::new(sealer),
        host,
        secrets,
        source,
    )
    .map_err(|e| err("replica", &e))?;
    // The desktop composition point explicitly selects its query fallback policy;
    // portable/hosted/mobile defaults remain constrained.
    rep.set_query_execution_profile(mdbn_replica::QueryExecutionProfile::Desktop);
    if let Some(name) = &cfg.computer_name {
        rep.set_conflict_label(name.strip_prefix("mdbase on ").unwrap_or(name));
    }
    // Before the first scan: a path's first ingest takes its hinted ID, and an
    // adopting replica ingests nothing until its base is applied.
    if !cfg.id_hints.is_empty() {
        rep.set_id_hints(
            cfg.id_hints
                .iter()
                .map(|(id, p)| (B16(*id), p.clone()))
                .collect(),
        );
    }
    if let Some(plan) = &cfg.adopt {
        rep.begin_adopt(Box::new(crate::adopt::FolderSource::new(
            platform,
            plan.clone(),
        )));
    }
    let replica_ms = t0.elapsed().as_millis() as u64 - store_ms;
    // First scan: ingest whatever changed while we were down.
    let t1 = std::time::Instant::now();
    let observed = rep.observe(None);
    log_retention_reclaims(&mut rep);
    observed.map_err(|e| err("first scan", &e))?;
    tracing::info!(
        store_ms,
        replica_ms,
        first_scan_ms = t1.elapsed().as_millis() as u64,
        "runtime opened"
    );
    Ok((rep, lock))
}

#[cfg(test)]
mod tests {
    struct NoGrants;
    impl mdbn_replica::policy::GrantSource for NoGrants {
        fn grant(
            &self,
            _: &mdbn_wire::common::Uuid,
        ) -> mdbn_replica::api::ApiResult<mdbn_replica::policy::EffectiveGrant> {
            Err(mdbn_replica::api::ErrorCode::Unauthenticated.err("the grant was revoked"))
        }
    }

    #[test]
    fn skipped_file_notices_remain_visible_when_holds_fill_the_budget() {
        use mdbn_replica::store::{Store as _, Tx};
        use mdbn_wire::{
            client::{Hold, HoldReason},
            common::B16,
            snapshot::TextOrBlob,
        };
        let dir = crate::testutil::TestDir::new("skip-with-holds");
        let state = crate::testutil::TestDir::new("skip-with-holds-state");
        std::fs::write(dir.path().join("latin.md"), b"caf\xe9").unwrap();
        let cfg = super::RuntimeConfig {
            collection: [1; 16],
            replica_id: [2; 16],
            device_id: [3; 16],
            root: dir.path().to_path_buf(),
            private_dir: state.path().to_path_buf(),
            adopt: None,
            id_hints: vec![],
            computer_name: None,
            sync: None,
        };
        let (mut rep, _lock) = super::open_replica(
            &cfg,
            mdbn_replica::DeviceSecrets {
                sign_sk: [10; 32],
                kem_sk: [11; 32],
            },
            Box::new(NoGrants),
        )
        .unwrap();
        rep.store_mut()
            .commit(Tx {
                holds_put: (0..50)
                    .map(|id| Hold {
                        id: B16([id; 16]),
                        path: format!("held/{id}.md"),
                        reason: HoldReason::ReadOnly,
                        since: 0,
                        base: None,
                        mine: TextOrBlob::Text("held".into()),
                        theirs: None,
                        saves: 0,
                    })
                    .collect(),
                ..Tx::default()
            })
            .unwrap();
        let notices = super::file_notices(&rep);
        assert!(
            notices
                .iter()
                .any(|notice| notice.path.as_deref() == Some("latin.md")
                    && notice.code == "unsupported_entry")
        );
        assert!(
            notices
                .iter()
                .any(|notice| notice.code == "file_notices_omitted")
        );
    }

    #[test]
    fn preopen_foreign_genesis_denies_missing_and_zero_policy_but_allows_cold() {
        use mdbn_replica::store::{Store as _, Tx, meta_keys};
        let dir = crate::testutil::TestDir::new("cold-genesis-marker");
        let pins = crate::trust::fixture_trust().policy_pins;
        assert!(
            super::preopen_cache_check(dir.path(), [9; 32], &pins)
                .unwrap()
                .is_none()
        );
        // Model restart: close each writer before the pre-open checker opens its
        // own SQLite connection. A busy-schema error must NOT pass a gate test.
        fn put(dir: &std::path::Path, key: &str, value: Option<Vec<u8>>) {
            let index = std::rc::Rc::new(std::cell::RefCell::new(
                mdbn_platform_native::SqliteIndex::open(
                    dir.join("index.sqlite"),
                    super::IndexDurability::Durable,
                )
                .unwrap(),
            ));
            let mut store = mdbn_store_file::SqlStore::open_with_limits(
                index,
                mdbn_store_file::SqlStoreLimits::DESKTOP,
            )
            .unwrap();
            store
                .commit(Tx {
                    meta: vec![(key.into(), value)],
                    ..Tx::default()
                })
                .unwrap();
        }
        put(dir.path(), meta_keys::GENESIS, Some(vec![8; 32]));
        assert_eq!(
            super::preopen_cache_check(dir.path(), [9; 32], &pins).unwrap_err(),
            "the cached store does not hold the pinned genesis"
        );
        put(
            dir.path(),
            meta_keys::POLICY,
            Some(mdbn_replica::policy::PolicyState::new().to_bytes().unwrap()),
        );
        assert_eq!(
            super::preopen_cache_check(dir.path(), [9; 32], &pins).unwrap_err(),
            "the cached store does not hold the pinned genesis"
        );
        put(dir.path(), meta_keys::GENESIS, Some(vec![9; 32]));
        assert!(
            super::preopen_cache_check(dir.path(), [9; 32], &pins)
                .unwrap()
                .is_none()
        );
        put(dir.path(), meta_keys::GENESIS, None);
        assert!(
            super::preopen_cache_check(dir.path(), [9; 32], &pins)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn native_open_explicitly_selects_desktop_query_profile() {
        let dir = crate::testutil::TestDir::new("desktop-query-profile");
        let state = crate::testutil::TestDir::new("desktop-query-state");
        let cfg = super::RuntimeConfig {
            collection: [1; 16],
            replica_id: [2; 16],
            device_id: [3; 16],
            root: dir.path().to_path_buf(),
            private_dir: state.path().to_path_buf(),
            adopt: None,
            id_hints: vec![],
            computer_name: None,
            sync: None,
        };
        let (rep, _lock) = super::open_replica(
            &cfg,
            mdbn_replica::DeviceSecrets {
                sign_sk: [10; 32],
                kem_sk: [11; 32],
            },
            Box::new(NoGrants),
        )
        .unwrap();
        assert_eq!(
            rep.query_execution_profile(),
            mdbn_replica::QueryExecutionProfile::Desktop
        );
        // Native opening creates reserved metadata directories even when there
        // are no user files. Sync-enable must recognize THAT exact empty case.
        assert!(dir.path().join(".mdbase").is_dir());
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from(".mdbase")]);
        // One host per folder: a second open is refused while this one runs.
        let second = super::open_replica(
            &cfg,
            mdbn_replica::DeviceSecrets {
                sign_sk: [10; 32],
                kem_sk: [11; 32],
            },
            Box::new(NoGrants),
        );
        assert!(
            matches!(&second, Err(e) if e.0.starts_with("folder host lock")),
            "{:?}",
            second.err()
        );
        drop(rep);
        drop(_lock);
        // The Obsidian in-app host cannot take the OS lock; it announces
        // itself only with a heartbeated `host.json` (as the real plugin does,
        // `obsidian-runtime/src/index/lease.ts`). A fresh one refuses the
        // daemon's open; so does an unreadable one.
        let open = || {
            super::open_replica(
                &cfg,
                mdbn_replica::DeviceSecrets {
                    sign_sk: [10; 32],
                    kem_sk: [11; 32],
                },
                Box::new(NoGrants),
            )
        };
        let descriptor = dir.path().join(super::PRIVATE_DIR).join("host.json");
        let obsidian = |heartbeat_ms: u64| {
            let mut d =
                mdbn_local_host::Descriptor::new(mdbn_local_host::HostKind::Obsidian, heartbeat_ms);
            d.pid = None;
            std::fs::write(&descriptor, serde_json::to_vec(&d).unwrap()).unwrap();
        };
        let now = crate::fsutil::now_ms() as u64;
        obsidian(now);
        let refused = open();
        assert!(
            matches!(&refused, Err(e) if e.0.starts_with("folder host lock: hosted by Obsidian")),
            "{:?}",
            refused.err()
        );
        std::fs::write(&descriptor, b"{not json").unwrap();
        assert!(matches!(&open(), Err(e) if e.0.starts_with("folder host lock: unreadable")),);
        // A dead (stale) Obsidian host is taken over, and the daemon's own
        // descriptor replaces it, which a paused plugin yields to.
        obsidian(now - super::HOST_DESCRIPTOR_STALE_MS - 1_000);
        let (rep, lock) = open().unwrap();
        assert_eq!(
            mdbn_local_host::host_lock::read_descriptor(dir.path(), super::PRIVATE_DIR)
                .unwrap()
                .host,
            mdbn_local_host::HostKind::Daemon
        );
        drop(rep);
        drop(lock);
        // The daemon's own leftover descriptor (crash) never blocks it: the OS
        // lock decides for lock-taking hosts.
        std::fs::write(
            &descriptor,
            serde_json::to_vec(&mdbn_local_host::Descriptor::new(
                mdbn_local_host::HostKind::Daemon,
                now,
            ))
            .unwrap(),
        )
        .unwrap();
        assert!(open().is_ok());
    }
}
