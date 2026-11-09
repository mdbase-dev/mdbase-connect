//! Daemon startup, initialization and signal handling (see the parent module for the startup order).

use super::*;

/// Run the daemon until shutdown. `secrets` overrides the profile's secret store
/// (tests).
pub async fn run(profile: Profile, secrets: Option<Box<dyn SecretStore>>) -> Result<(), RunError> {
    run_with(profile, secrets, Box::new(crate::confirm::NativeDialog)).await
}

/// [`run`] with a chosen confirmer (tests).
pub async fn run_with(
    profile: Profile,
    secrets: Option<Box<dyn SecretStore>>,
    confirmer: Box<dyn crate::confirm::Confirmer>,
) -> Result<(), RunError> {
    fsutil::ensure_private_dir(&profile.state_dir)
        .map_err(|e| RunError::Startup(format!("state directory: {e}")))?;
    let _lock = match InstanceLock::acquire(&profile.lock_file()) {
        Ok(l) => l,
        Err(LockError::AlreadyRunning) => return Err(RunError::AlreadyRunning),
        Err(LockError::Io(e)) => return Err(RunError::Startup(format!("instance lock: {e}"))),
    };
    let mut control = Listener::bind(&profile.control)
        .map_err(|e| RunError::Startup(format!("control endpoint {}: {e}", profile.control)))?;
    let mut replica = Listener::bind(&profile.replica)
        .map_err(|e| RunError::Startup(format!("replica endpoint {}: {e}", profile.replica)))?;

    let secrets: Arc<dyn SecretStore> =
        Arc::from(secrets.unwrap_or_else(|| {
            secrets::store_for(&profile.secret_namespace(), &profile.state_dir)
        }));
    let daemon = Arc::new(Daemon {
        started_at_ms: fsutil::now_ms() as u64,
        secrets,
        readiness: watch::channel(readiness(false, Some(NotReady::Starting))).0,
        changes: watch::channel(0).0,
        status_feed: watch::channel(None).0,
        access_events: tokio::sync::broadcast::channel(64).0,
        activity: crate::activity::ActivityLog::open(profile.activity_file()),
        control_key: std::sync::OnceLock::new(),
        credential_retry: tokio::sync::Notify::new(),
        account: std::sync::Mutex::new(Account::default()),
        account_gate: Mutex::new(()),
        link_prompt: Mutex::new(()),
        device_approvals: Default::default(),
        authority: crate::authority::Authority::default(),
        confirmer: std::sync::RwLock::new(Arc::from(confirmer)),
        grant_publications: Default::default(),
        self_weak: std::sync::OnceLock::new(),
        online: std::sync::atomic::AtomicBool::new(false),
        link: std::sync::Mutex::new(None),
        trust: crate::trust::authenticated().ok().map(Arc::new),
        shutdown: watch::channel(false).0,
        tasks: Default::default(),
        identity: Default::default(),
        account_keys: Default::default(),
        takeover: Default::default(),
        auto_private: Default::default(),
        inner: Mutex::new(Inner {
            registry: Registry::default(),
            access: AccessList::default(),
            hosts: Vec::new(),
            device: None,
            init_error: None,
        }),
        profile,
    });
    let _ = daemon.self_weak.set(Arc::downgrade(&daemon));
    tracing::info!(
        version = crate::BINARY_VERSION,
        state_dir = %daemon.profile.state_dir.display(),
        control = %daemon.profile.control,
        "daemon starting"
    );

    daemon.spawn(initialize(daemon.clone()));
    daemon.spawn(wait_for_signal(daemon.clone()));
    daemon.spawn(daemon.clone().strict_witness_reports());
    daemon.spawn(daemon.clone().account_key_reconcile());
    daemon.spawn(daemon.clone().device_approval_requests());
    daemon.spawn(daemon.clone().watch_old_connector());
    daemon.spawn(daemon.clone().publish_status());

    let mut stop = daemon.shutdown.subscribe();
    loop {
        tokio::select! {
            accepted = control.accept() => match accepted {
                Ok(stream) => {
                    let d = daemon.clone();
                    daemon.spawn(async move {
                        if let Err(e) = serve_control(d, stream).await {
                            tracing::debug!(error = %e, "control connection closed");
                        }
                    });
                }
                Err(e) => {
                    tracing::warn!(error = %e, "control accept failed");
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            },
            accepted = replica.accept() => match accepted {
                Ok(stream) => {
                    let d = daemon.clone();
                    daemon.spawn(async move {
                        let Some(id) = d.identity.get() else {
                            return; // not initialised: close without a handshake
                        };
                        let device = id.device_id;
                        if let Err(e) =
                            crate::session::serve(stream, id.noise_secret(), device, d.as_ref()).await
                        {
                            tracing::debug!(error = %e, "replica session closed");
                        }
                    });
                }
                Err(e) => {
                    tracing::warn!(error = %e, "replica accept failed");
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            },
            _ = async { let _ = stop.wait_for(|s| *s).await; } => break,
        }
    }

    tracing::info!("daemon stopping");
    daemon
        .readiness
        .send_replace(readiness(false, Some(NotReady::Stopping)));
    daemon.bump();
    daemon.stop_tasks().await;
    if let Some(l) = daemon.link.lock().unwrap_or_else(|p| p.into_inner()).take() {
        l.stop();
    }
    let close = async {
        let mut inner = daemon.inner.lock().await;
        for h in &mut inner.hosts {
            h.close().await;
        }
    };
    if tokio::time::timeout(SHUTDOWN_GRACE, close).await.is_err() {
        tracing::warn!("collections did not close within the grace period");
    }
    control.cleanup();
    replica.cleanup();
    tracing::info!("daemon stopped");
    Ok(())
}

/// How long `auth.challenge` waits for a credential retry it started.
pub(super) const CREDENTIAL_RETRY_WAIT: Duration = Duration::from_secs(5);

/// Each registered collection's ID and root (the takeover's marker guard).
pub(super) fn registered_roots(registry: &Registry) -> Vec<(String, std::path::PathBuf)> {
    registry
        .collections
        .iter()
        .map(|e| (e.id.clone(), e.root.clone()))
        .collect()
}

pub(super) async fn initialize(d: Arc<Daemon>) {
    let device = loop {
        let e = match load_credentials(&d) {
            Ok(device) => break device,
            Err(e) => e,
        };
        d.inner.lock().await.init_error = Some(e.to_string());
        d.readiness
            .send_replace(readiness(false, Some(NotReady::CredentialStoreUnavailable)));
        d.bump();
        // A locked store (at boot, before login unlocks it) recovers without a
        // restart; a malformed stored identity does not. Retry only when a
        // local client authenticates: it has just read the control key from
        // the same store, so the attempt should not raise an unlock prompt.
        if !matches!(e, secrets::SecretError::Unavailable(_)) {
            return;
        }
        d.credential_retry.notified().await;
        tracing::info!("retrying the credential store");
    };
    if d.inner.lock().await.init_error.take().is_some() {
        d.readiness
            .send_replace(readiness(false, Some(NotReady::Starting)));
        d.bump();
    }
    let mut registry = match Registry::load(&d.profile.registry_file()) {
        Ok(r) => r,
        Err(e) => {
            tracing::error!(error = %e, "registry unavailable");
            let mut inner = d.inner.lock().await;
            inner.device = Some(device);
            inner.init_error = Some(e.to_string());
            drop(inner);
            d.readiness
                .send_replace(readiness(false, Some(NotReady::InitializationFailed)));
            d.bump();
            return;
        }
    };
    if let Some(trust) = &d.trust
        && private_mode::replay(&d.profile, &mut registry, trust).is_err()
    {
        d.inner.lock().await.init_error =
            Some("verified private choice projection unavailable".into());
        d.readiness
            .send_replace(readiness(false, Some(NotReady::InitializationFailed)));
        d.bump();
        return;
    }
    let access = match AccessList::load(&d.profile.access_file()) {
        Ok(a) => a,
        Err(e) => {
            tracing::error!(error = %e, "access list unavailable");
            let mut inner = d.inner.lock().await;
            inner.device = Some(device);
            inner.init_error = Some(e.to_string());
            drop(inner);
            d.readiness
                .send_replace(readiness(false, Some(NotReady::InitializationFailed)));
            d.bump();
            return;
        }
    };
    let mut access = access;
    // Preserve the local opt-in boundary after a collection leaves Private
    // sync. Current Private entries have account consent already; migrate the
    // old pending UI state even offline (expired leases still forbid serving).
    for e in registry.collections.iter().filter(|e| e.ever_e2e) {
        access.force_approval(&e.id);
        if e.mode == SyncMode::SyncedE2e {
            for entry in access
                .entries
                .iter_mut()
                .filter(|g| g.grant.collection == e.id)
            {
                if entry.state == AccessState::PendingApproval {
                    entry.state = AccessState::Active;
                }
            }
        }
    }
    // Before any host opens: a taken-over folder stays closed while an old daemon runs.
    d.check_old_connector().await;
    {
        let mut inner = d.inner.lock().await;
        inner.access = access;
        for h in &inner.hosts {
            h.publish_grants(&inner.access);
        }
        inner.hosts = registry
            .collections
            .iter()
            .cloned()
            .map(|e| CollectionHost::open(e, d.host_ctx()))
            .collect();
        inner.registry = registry;
        d.authority.publish_registry(&inner.registry);
        d.authority.publish_access(&inner.access);
        inner.device = Some(device);
        for h in &inner.hosts {
            h.publish_grants(&inner.access);
        }
    }
    // Runtimes open only once the account fence is published.
    // Readiness must also wait for that fence and the resulting host refresh:
    // otherwise startup exposes transient account_identity_missing statuses.
    resume_relay(&d).await;
    d.reopen_hosts().await;
    d.readiness.send_replace(readiness(true, None));
    d.bump();
    tracing::info!("daemon ready");
    if let Some(identity) = d.identity.get() {
        match crate::link::Link::start(d.profile.local_link_file(), identity, d.clone()).await {
            Ok(l) => {
                tracing::info!(port = l.port, "localhost link listening");
                *d.link.lock().unwrap_or_else(|p| p.into_inner()) = Some(l);
            }
            Err(e) => tracing::warn!(error = %e, "localhost link unavailable"),
        }
    }
    // Take over (or resume taking over) an old connector's collections.
    d.spawn(d.clone().takeover_task(false));
}

/// Load the device identity and control key from the credential store.
fn load_credentials(d: &Daemon) -> Result<DevicePublic, secrets::SecretError> {
    let store: &dyn SecretStore = d.secrets.as_ref();
    let id = DeviceIdentity::load_or_create(store, &d.profile.identity_file())
        .inspect_err(|e| tracing::error!(error = %e, "device identity unavailable"))?;
    let key = secrets::load_or_create_control_key(store)
        .inspect_err(|e| tracing::error!(error = %e, "control key unavailable"))?;
    let public = id.public();
    d.identity.set(Arc::new(id));
    let _ = d.control_key.set(key);
    Ok(public)
}

async fn wait_for_signal(d: Arc<Daemon>) {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut term = match signal(SignalKind::terminate()) {
            Ok(s) => s,
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
                d.shutdown.send_replace(true);
                return;
            }
        };
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
    tracing::info!("signal received");
    d.shutdown.send_replace(true);
}
