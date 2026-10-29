//! `mdbase daemon run`: the daemon process.
//!
//! **Startup** is ordered so that every failure is visible and nothing is
//! half-initialised:
//! 1. create the owner-only state directory;
//! 2. take the instance lock (a second daemon exits with `already_running`);
//! 3. bind the control endpoint and serve readiness `starting`, so the CLI and
//!    desktop can watch progress instead of guessing from a PID;
//! 4. load the device identity from the OS keychain (`credential_store_unavailable`
//!    on failure);
//! 5. load the registry (`initialization_failed` on failure; the file is kept);
//! 6. open each collection;
//! 7. report `ready`.
//!
//! **Shutdown** (SIGINT, SIGTERM, Ctrl-C or the `shutdown` control method):
//! readiness turns `stopping`, the endpoints stop accepting, every collection is
//! closed (bounded wait), the socket files are removed and the lock is released.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;
use tokio::sync::{Mutex, mpsc, watch};

use crate::access::{AccessEntry, AccessEvent, AccessList, AccessState, CachedGrant};
use crate::collections::CollectionHost;
use crate::control::{
    AccountInfo, AddCollection, ApproveDevice, Check, CollectionRef, CollectionStatus,
    ControlError, DaemonStatus, DeleteCollection, DeviceInfo, EnableSync, GrantRef, HoldAction,
    HoldResolved, HoldSummary, JoinCollection, Method, NotReady, Notice, PROTOCOL,
    READINESS_SCHEMA, Readiness, Request, ResolveHold, Response, Settings, UpdateCollection,
};
use crate::fsutil;
use crate::instance::{InstanceLock, LockError};
use crate::ipc::{self, BoxStream, Listener};
use crate::paths::Profile;
use crate::registry::{self, Entry, Origin, Registry, RegistryError, SyncMode};
use crate::secrets::{self, DeviceIdentity, DevicePublic, SecretStore};

/// How long shutdown waits for collections to close.
pub const SHUTDOWN_GRACE: Duration = Duration::from_secs(10);

/// Why the daemon could not run.
#[derive(Debug)]
pub enum RunError {
    /// Another daemon holds this profile.
    AlreadyRunning,
    /// Startup I/O failed before the control endpoint was up.
    Startup(String),
}

impl std::fmt::Display for RunError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RunError::AlreadyRunning => f.write_str("a daemon is already running for this profile"),
            RunError::Startup(m) => write!(f, "startup failed: {m}"),
        }
    }
}

impl std::error::Error for RunError {}

struct Inner {
    registry: Registry,
    access: AccessList,
    hosts: Vec<CollectionHost>,
    device: Option<DevicePublic>,
    init_error: Option<String>,
}

/// State shared by every connection.
pub struct Daemon {
    profile: Profile,
    started_at_ms: u64,
    secrets: Arc<dyn SecretStore>,
    readiness: watch::Sender<Readiness>,
    /// The control key, once loaded.
    control_key: std::sync::OnceLock<zeroize::Zeroizing<[u8; 32]>>,
    /// Access events for notifications (pushed as `access`).
    access_events: tokio::sync::broadcast::Sender<AccessEvent>,
    activity: crate::activity::ActivityLog,
    /// The device identity, once loaded (Noise responder key for the replica
    /// endpoint). Each account has its own; see [`ActiveIdentity`].
    identity: ActiveIdentity,
    /// Bumped on every status change; subscribers re-read status.
    changes: watch::Sender<u64>,
    shutdown: watch::Sender<bool>,
    inner: Mutex<Inner>,
    /// The account link (relay task, pairing in progress).
    account: std::sync::Mutex<Account>,
    /// Serializes epoch checks with credential/config/fence publication and logout.
    account_gate: Mutex<()>,
    /// One link-approval prompt at a time.
    link_prompt: Mutex<()>,
    /// Dynamic projection for per-collection authority, published after durable state.
    authority: crate::authority::Authority,
    /// Native confirmation dialogs.
    confirmer: std::sync::RwLock<Arc<dyn crate::confirm::Confirmer>>,
    /// Grants with an automatic sealed-scope publication task in flight.
    grant_publications: std::sync::Mutex<std::collections::BTreeSet<String>>,
    /// Weak self for automatic publication retries from `&self` feed handling.
    self_weak: std::sync::OnceLock<std::sync::Weak<Daemon>>,
    /// The localhost link for the Obsidian runtime.
    link: std::sync::Mutex<Option<crate::link::Link>>,
    /// The relay socket is up.
    online: std::sync::atomic::AtomicBool,
    /// AK1: per-collection account-key keying (background pass, status).
    account_keys: private_key::AccountKeys,
    /// Local takeover runs one at a time; whether the old connector came back.
    takeover: crate::takeover::Gate,
    /// Private sync turned on automatically for taken-over collections.
    auto_private: crate::auto_private::State,
    /// This build's verified environment trust (`None`: synced collections report
    /// `trust_missing`). Embedded only; no file, flag or environment override.
    trust: Option<Arc<crate::trust::Trust>>,
}

/// Account-link state.
#[derive(Default)]
struct Account {
    epoch: u64,
    pairing_allowed: bool,
    pairing_task: Option<tokio::task::JoinHandle<()>>,
    signed_in: bool,
    relay: Option<tokio::task::JoinHandle<()>>,
    pairing: Option<String>,
    /// Reason code of the last account-link problem; cleared when the relay connects.
    last_error: Option<String>,
    /// Background device registration retries, while registration keeps failing.
    registration: Option<tokio::task::JoinHandle<()>>,
    /// Reason code while this device is not registered with the account; shown as
    /// `last_error` and cleared only by a registration.
    registration_error: Option<String>,
    /// This sign-in already replaced a refused device identity (at most once).
    identity_replaced: bool,
}

/// The active device identity. It changes only under `account_gate`: when another
/// account signs in (before that account is published), and when the account says
/// this computer's device was removed (under a new account epoch).
#[derive(Default)]
struct ActiveIdentity(std::sync::RwLock<Option<Arc<DeviceIdentity>>>);

impl ActiveIdentity {
    fn get(&self) -> Option<Arc<DeviceIdentity>> {
        self.0.read().unwrap_or_else(|p| p.into_inner()).clone()
    }

    fn set(&self, identity: Arc<DeviceIdentity>) {
        *self.0.write().unwrap_or_else(|p| p.into_inner()) = Some(identity);
    }
}

fn readiness(ready: bool, reason: Option<NotReady>) -> Readiness {
    Readiness {
        schema_version: READINESS_SCHEMA,
        ready,
        binary_version: crate::BINARY_VERSION.to_string(),
        control_protocol: PROTOCOL,
        safe_reason: reason,
    }
}

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
        access_events: tokio::sync::broadcast::channel(64).0,
        activity: crate::activity::ActivityLog::open(profile.activity_file()),
        control_key: std::sync::OnceLock::new(),
        account: std::sync::Mutex::new(Account::default()),
        account_gate: Mutex::new(()),
        link_prompt: Mutex::new(()),
        authority: crate::authority::Authority::default(),
        confirmer: std::sync::RwLock::new(Arc::from(confirmer)),
        grant_publications: Default::default(),
        self_weak: std::sync::OnceLock::new(),
        online: std::sync::atomic::AtomicBool::new(false),
        link: std::sync::Mutex::new(None),
        trust: crate::trust::authenticated().ok().map(Arc::new),
        shutdown: watch::channel(false).0,
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

    let init = tokio::spawn(initialize(daemon.clone()));
    let signals = tokio::spawn(wait_for_signal(daemon.clone()));
    let strict_reports = tokio::spawn(daemon.clone().strict_witness_reports());
    let account_keys = tokio::spawn(daemon.clone().account_key_reconcile());
    let old_connector = tokio::spawn(daemon.clone().watch_old_connector());

    let mut stop = daemon.shutdown.subscribe();
    loop {
        tokio::select! {
            accepted = control.accept() => match accepted {
                Ok(stream) => {
                    let d = daemon.clone();
                    tokio::spawn(async move {
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
                    tokio::spawn(async move {
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
    init.abort();
    signals.abort();
    strict_reports.abort();
    account_keys.abort();
    old_connector.abort();
    let close = async {
        let mut inner = daemon.inner.lock().await;
        for h in &mut inner.hosts {
            h.close().await;
        }
    };
    if tokio::time::timeout(SHUTDOWN_GRACE, close).await.is_err() {
        tracing::warn!("collections did not close within the grace period");
    }
    if let Some(l) = daemon.link.lock().unwrap_or_else(|p| p.into_inner()).take() {
        l.stop();
    }
    control.cleanup();
    replica.cleanup();
    tracing::info!("daemon stopped");
    Ok(())
}

async fn initialize(d: Arc<Daemon>) {
    let device = {
        let device_file = d.profile.identity_file();
        let store: &dyn SecretStore = d.secrets.as_ref();
        DeviceIdentity::load_or_create(store, &device_file)
    };
    let device = match device {
        Ok(id) => {
            let public = id.public();
            d.identity.set(Arc::new(id));
            public
        }
        Err(e) => {
            tracing::error!(error = %e, "device identity unavailable");
            d.inner.lock().await.init_error = Some(e.to_string());
            d.readiness
                .send_replace(readiness(false, Some(NotReady::CredentialStoreUnavailable)));
            d.bump();
            return;
        }
    };
    match secrets::load_or_create_control_key(d.secrets.as_ref()) {
        Ok(k) => {
            let _ = d.control_key.set(k);
        }
        Err(e) => {
            tracing::error!(error = %e, "control key unavailable");
            d.inner.lock().await.init_error = Some(e.to_string());
            d.readiness
                .send_replace(readiness(false, Some(NotReady::CredentialStoreUnavailable)));
            d.bump();
            return;
        }
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
    tokio::spawn(d.clone().takeover_task(false));
}

/// Resume only an atomically published account epoch; missing/error fence denies.
async fn resume_relay(d: &Arc<Daemon>) {
    let _gate = d.account_gate.lock().await;
    let record = match crate::cloud::AccountRecord::load(&d.profile.account_file()) {
        Ok(record) => record,
        Err(e) => {
            tracing::warn!(error = %e, "account state unreadable");
            d.set_account_error("account_state");
            return;
        }
    };
    {
        let mut a = d.account.lock().unwrap_or_else(|p| p.into_inner());
        if a.epoch > record.epoch {
            return;
        }
        a.epoch = record.epoch;
    }
    if let Some(account) = record.account_id.as_deref().filter(|_| record.signed_in)
        && let Err(e) = d.use_identity_of(account).await
    {
        tracing::warn!(error = %e.message, "device identity unavailable for the account");
        d.set_account_error(e.reason.as_deref().unwrap_or("device_identity_missing"));
        return;
    }
    if let Ok(Some(cfg)) = crate::cloud::CloudConfig::load(&d.profile.cloud_file())
        && record.permits(&cfg)
    {
        d.drop_foreign_policy_cursor(cfg.connector_id.as_deref())
            .await;
    }
    start_relay_locked(d, &record);
}

/// Caller holds account_gate. No await between epoch check and task publication.
fn start_relay_locked(d: &Arc<Daemon>, record: &crate::cloud::AccountRecord) {
    let Ok(Some(cfg)) = crate::cloud::CloudConfig::load(&d.profile.cloud_file()) else {
        return;
    };
    if !record.permits(&cfg)
        || d.account.lock().unwrap_or_else(|p| p.into_inner()).epoch != record.epoch
    {
        return;
    }
    let epoch = record.epoch;
    let Some(identity) = d.identity.get() else {
        return;
    };
    let tls = match crate::cloud::tls_config() {
        Ok(t) => t,
        Err(e) => {
            tracing::error!(error = %e, "TLS unavailable; relay not started");
            return;
        }
    };
    let cloud = match crate::cloud::Cloud::new(&tls, &cfg.server_url, d.secrets.as_ref()) {
        Ok(c) => Arc::new(c),
        Err(e) => {
            tracing::warn!(error = %e, "no account credential; relay not started");
            return;
        }
    };
    if d.authority
        .publish_account_identity(record, &cfg, &identity)
        .is_err()
    {
        return;
    }
    let d2 = d.clone();
    let stop = d.shutdown.subscribe();
    let task = tokio::spawn(async move {
        let mut cfg = cfg;
        if !cfg.device_registered {
            match d2.register_device(epoch, &cloud, &mut cfg, &identity).await {
                Registered::Yes => {}
                // Not fatal: the relay still serves grants; pipes wait for it.
                Registered::No => {
                    d2.retry_registration(epoch, cloud.clone(), cfg.clone(), identity.clone())
                }
                Registered::Stop => return,
            }
        }
        if let crate::relay::Ended::Terminal(why) =
            crate::relay::run(d2.clone(), cloud, cfg, identity, stop).await
        {
            d2.set_epoch_error(epoch, relay_stop_reason(&why));
        }
    });
    let mut a = d.account.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(old) = a.relay.replace(task) {
        old.abort();
    }
    a.signed_in = true;
}

/// The outcome of a device registration attempt.
enum Registered {
    Yes,
    /// Failed for now; retried in the background.
    No,
    /// Stale, signed out, or a new identity is being registered instead.
    Stop,
}

/// Device registration retries: 5 s doubling to a 5 minute cap, equal jitter.
fn registration_backoff(attempt: u32) -> Duration {
    let cap = (5_000u64 << attempt.saturating_sub(1).min(6)).min(300_000);
    let mut r = [0u8; 8];
    let _ = getrandom::fill(&mut r);
    Duration::from_millis(cap / 2 + u64::from_le_bytes(r) % (cap / 2 + 1))
}

/// A plain reason code for why the relay stopped for good.
fn relay_stop_reason(why: &str) -> &'static str {
    for reason in [
        "authentication_required",
        "incompatible_version",
        "policy_authority_mismatch",
    ] {
        if why.starts_with(reason) {
            return reason;
        }
    }
    "relay_stopped"
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

impl Daemon {
    fn bump(&self) {
        self.changes.send_modify(|n| *n += 1);
    }

    fn is_ready(&self) -> bool {
        self.readiness.borrow().ready
    }

    async fn status(&self) -> DaemonStatus {
        self.reconcile_private_choices().await;
        let inner = self.inner.lock().await;
        let taken = self.takeover_record();
        let mut collections = Vec::with_capacity(inner.hosts.len());
        for host in &inner.hosts {
            collections.push(with_private_sync_pending(
                with_takeover_holds(
                    with_access_notices(host.observed_status().await, &inner.access),
                    taken.as_ref(),
                ),
                &self.auto_private,
                &self.profile.state_dir.join("collections"),
            ));
        }
        DaemonStatus {
            readiness: self.readiness.borrow().clone(),
            pid: std::process::id(),
            target: self.profile.target,
            state_dir: self.profile.state_dir.clone(),
            started_at_ms: self.started_at_ms,
            secret_backend: self.secrets.backend().to_string(),
            device: inner.device.as_ref().map(|p| DeviceInfo {
                device_id: p.device.clone(),
                noise_pk: p.noise_pk.clone(),
                sign_pk: p.sign_pk.clone(),
            }),
            account: {
                let a = self.account.lock().unwrap_or_else(|p| p.into_inner());
                let cloud = crate::cloud::CloudConfig::load(&self.profile.cloud_file())
                    .ok()
                    .flatten()
                    .filter(|_| a.signed_in);
                AccountInfo {
                    signed_in: a.signed_in,
                    online: self.online.load(std::sync::atomic::Ordering::Relaxed),
                    pairing: a.pairing.clone(),
                    last_error: a
                        .last_error
                        .clone()
                        .or_else(|| a.registration_error.clone()),
                    account_id: self
                        .authority
                        .active_account()
                        .map(|id| secrets::uuid_string(&id.0)),
                    server: cloud.as_ref().map(|c| c.server_url.clone()),
                    computer_name: cloud.and_then(|c| c.computer_name),
                    environment: crate::trust::Environment::embedded().name().into(),
                }
            },
            collections,
        }
    }

    /// Reconcile a collection's cached grants with the control plane's list,
    /// persist, then announce. Called by the control-plane client.
    pub async fn apply_control_plane_grants(
        &self,
        collection: &str,
        grants: &[CachedGrant],
        lease_expires_ms: u64,
    ) -> Result<Vec<AccessEvent>, ControlError> {
        let _gate = self.account_gate.lock().await;
        let mut inner = self.inner.lock().await;
        let mut next = inner.access.clone();
        let events = next.sync_from_control_plane(
            collection,
            grants,
            fsutil::now_ms() as u64,
            lease_expires_ms,
            false,
        );
        if let Err(e) = next.save(&self.profile.access_file()) {
            inner.access.leases.clear();
            inner.access.monotonic_leases.clear();
            for h in &inner.hosts {
                h.publish_grants(&inner.access);
            }
            self.authority.publish_access(&inner.access);
            return Err(access_error(e));
        }
        inner.access = next;
        self.authority.publish_access(&inner.access);
        let barrier = publish_grants(&inner);
        drop(inner);
        barrier.wait().await;
        for e in &events {
            self.note_access_event(e).await;
            let _ = self.access_events.send(e.clone());
        }
        if !events.is_empty() {
            self.bump();
        }
        Ok(events)
    }

    fn save_access(&self, inner: &mut Inner, next: &AccessList) -> Result<(), ControlError> {
        if let Err(error) = next.save(&self.profile.access_file()) {
            inner.access.leases.clear();
            inner.access.monotonic_leases.clear();
            self.authority.publish_access(&inner.access);
            return Err(access_error(error));
        }
        Ok(())
    }

    fn save_registry(&self, next: &Registry) -> Result<(), ControlError> {
        if let Err(error) = next.save(&self.profile.registry_file()) {
            let epoch = self
                .account
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .epoch;
            self.authority.invalidate(epoch);
            return Err(registry_error(error));
        }
        Ok(())
    }

    async fn access_change(
        &self,
        f: impl FnOnce(&mut AccessList) -> Result<AccessEntry, crate::access::AccessError>,
    ) -> Result<Value, ControlError> {
        let _gate = self.account_gate.lock().await;
        let mut inner = self.inner.lock().await;
        let mut next = inner.access.clone();
        let entry = f(&mut next).map_err(access_error)?;
        self.save_access(&mut inner, &next)?;
        inner.access = next;
        self.authority.publish_access(&inner.access);
        let barrier = publish_grants(&inner);
        drop(inner);
        barrier.wait().await;
        self.bump();
        to_value(&entry)
    }

    // Compare the complete displayed entry (including its durable generation)
    // under the same lock as approval publication, after the asynchronous dialog.
    async fn approve_confirmed(&self, expected: &AccessEntry) -> Result<Value, ControlError> {
        let _gate = self.account_gate.lock().await;
        let mut inner = self.inner.lock().await;
        let current = inner
            .access
            .entries
            .iter()
            .find(|e| e.grant.grant == expected.grant.grant);
        if current != Some(expected)
            || !inner
                .access
                .lease_live(&expected.grant.collection, fsutil::now_ms() as u64)
        {
            return Err(ControlError::new(
                "forbidden",
                "consent_changed",
                "grant terms or lease changed; approve again",
            ));
        }
        let mut next = inner.access.clone();
        let entry = next
            .approve(&expected.grant.grant)
            .cloned()
            .map_err(access_error)?;
        self.save_access(&mut inner, &next)?;
        inner.access = next;
        self.authority.publish_access(&inner.access);
        drop(inner);
        self.bump();
        tracing::info!(grant = %expected.grant.grant, "grant approved on this device");
        to_value(&entry)
    }

    /// This daemon as an `Arc`, when constructed through one.
    fn arc(&self) -> Option<Arc<Self>> {
        self.self_weak.get().and_then(|w| w.upgrade())
    }

    /// The runtime serving `collection`, if it is running.
    async fn collection_runtime(&self, collection: &str) -> Option<Arc<crate::runtime::Runtime>> {
        let inner = self.inner.lock().await;
        inner
            .hosts
            .iter()
            .find(|h| h.entry().id == collection)
            .and_then(|h| h.runtime())
    }

    /// Positive eligibility for a bounded wait, NOT permission to serve. Capture
    /// the original consent generation and account incarnation; disk cache alone
    /// never restores a lease. The account gate preserves existing lock order.
    async fn native_grant_wait_consent(
        &self,
        collection: &str,
        grant: &str,
    ) -> Option<NativeGrantWaitContext> {
        let _gate = self.account_gate.lock().await;
        let incarnation = self.authority.incarnation()?;
        let inner = self.inner.lock().await;
        let collection_entry = inner.registry.get(collection)?;
        if collection_entry.mode != SyncMode::SyncedE2e || collection_entry.paused {
            return None;
        }
        let entry = inner
            .access
            .entries
            .iter()
            .find(|e| e.grant.collection == collection && e.grant.grant == grant)?;
        if entry.state != AccessState::Active
            || entry.delisted
            || entry.grant.legacy_only
            || entry
                .grant
                .account_id
                .as_deref()
                .and_then(crate::authority::account_id)
                != Some(incarnation.account)
            || entry.grant.capabilities.is_empty()
            || crate::secrets::hex_decode(&entry.grant.client_pk)
                .ok()
                .is_none_or(|bytes| bytes.len() != 32)
            || crate::attest::uuid_bytes(grant).is_none()
            || !inner.access.lease_live(collection, fsutil::now_ms() as u64)
        {
            return None;
        }
        let deadline = *inner.access.monotonic_leases.get(collection)?;
        let runtime = inner
            .hosts
            .iter()
            .find(|h| h.entry().id == collection)?
            .runtime()?;
        Some(NativeGrantWaitContext {
            entry: entry.clone(),
            incarnation,
            deadline,
            runtime,
        })
    }

    /// One grant's approval state from its collection's replica.
    async fn native_grant_state(
        &self,
        collection: &str,
        grant: &[u8; 16],
    ) -> Option<mdbn_replica::api::GrantApprovalState> {
        let rt = self.collection_runtime(collection).await?;
        match rt
            .grant_approval(crate::runtime::GrantApprovalOp::State(
                mdbn_wire::common::B16(*grant),
            ))
            .await
        {
            Some(crate::runtime::GrantApprovalReply::State(s)) => s,
            _ => None,
        }
    }

    /// Mark a native grant active here (the log approval is the authority;
    /// this is the device's display and refusal state).
    async fn activate_native_entry(&self, expected: &AccessEntry) -> Result<Value, ControlError> {
        let _gate = self.account_gate.lock().await;
        let mut inner = self.inner.lock().await;
        let current = inner
            .access
            .entries
            .iter()
            .find(|e| e.grant.grant == expected.grant.grant);
        if current != Some(expected) {
            return Err(ControlError::new(
                "forbidden",
                "consent_changed",
                "grant terms or decision changed during approval",
            ));
        }
        if expected.state == AccessState::Active {
            return to_value(expected);
        }
        let mut next = inner.access.clone();
        let entry = next
            .approve(&expected.grant.grant)
            .cloned()
            .map_err(access_error)?;
        self.save_access(&mut inner, &next)?;
        inner.access = next;
        self.authority.publish_access(&inner.access);
        drop(inner);
        self.bump();
        to_value(&entry)
    }

    /// Materialize an account-approved Private grant automatically. The sealed
    /// kind-6 item carries Private folder scope; it is not another user decision
    /// and never invokes a native confirmation or key comparison.
    async fn publish_native_grant(
        self: &Arc<Self>,
        expected: &AccessEntry,
    ) -> Result<Value, ControlError> {
        // Publish only a fresh feed for the currently signed-in account. A
        // missing account is never consent, including when signed out.
        let account = expected
            .grant
            .account_id
            .as_deref()
            .and_then(crate::authority::account_id)
            .ok_or_else(|| {
                ControlError::new("forbidden", "consent_changed", "grant account is missing")
            })?;
        {
            let _gate = self.account_gate.lock().await;
            let inner = self.inner.lock().await;
            let current = inner
                .access
                .entries
                .iter()
                .find(|e| e.grant.grant == expected.grant.grant);
            if current != Some(expected)
                || expected.is_refused()
                || !inner
                    .access
                    .lease_live(&expected.grant.collection, fsutil::now_ms() as u64)
                || Some(account) != self.authority.active_account()
                || expected.grant.legacy_only
            {
                return Err(ControlError::new(
                    "forbidden",
                    "consent_changed",
                    "account grant or feed authority changed",
                ));
            }
        }
        let Some(grant16) = crate::attest::uuid_bytes(&expected.grant.grant) else {
            return Err(ControlError::internal("grant or collection ID malformed"));
        };
        let state = self
            .native_grant_state(&expected.grant.collection, &grant16)
            .await
            .ok_or_else(|| {
                ControlError::unavailable(
                    "grant_not_in_log",
                    "this computer has not received the app's request yet; try again shortly",
                )
            })?;
        // The feed's terms were shown to the user; the log's must match,
        // including when an approval from another device already exists.
        let entry_pk = crate::secrets::hex_decode(&expected.grant.client_pk)
            .ok()
            .and_then(|b| <[u8; 32]>::try_from(b).ok());
        if !state.active
            || entry_pk != Some(state.client_pk)
            || expected.grant.capabilities.is_empty()
            || !expected
                .grant
                .capabilities
                .iter()
                .all(|c| state.capabilities.contains(c))
        {
            return Err(ControlError::new(
                "forbidden",
                "consent_changed",
                "the app's request in the collection differs from what was shown; approve again",
            ));
        }
        if state.approved_capabilities.is_none() {
            let rt = self
                .collection_runtime(&expected.grant.collection)
                .await
                .ok_or_else(|| {
                    ControlError::unavailable("not_serving", "the collection is not being served")
                })?;
            match rt
                .grant_approval(crate::runtime::GrantApprovalOp::Approve {
                    grant: mdbn_wire::common::B16(grant16),
                    capabilities: expected.grant.capabilities.clone(),
                    folders: expected.grant.folders.clone(),
                })
                .await
            {
                Some(crate::runtime::GrantApprovalReply::Approve(Ok(()))) => {}
                Some(crate::runtime::GrantApprovalReply::Approve(Err(reason))) => {
                    return Err(ControlError::new(
                        "forbidden",
                        &reason,
                        "this computer cannot approve that grant",
                    ));
                }
                _ => {
                    return Err(ControlError::unavailable(
                        "not_serving",
                        "the collection is not being served",
                    ));
                }
            }
        }
        // The append is queued; wait briefly for it to apply, then report.
        for _ in 0..40 {
            if let Some(s) = self
                .native_grant_state(&expected.grant.collection, &grant16)
                .await
            {
                if let Some(failure) = &s.failure {
                    return Err(ControlError::new(
                        "forbidden",
                        failure,
                        "the approval could not be saved to the collection",
                    ));
                }
                if s.approved_capabilities.is_some() {
                    return self.activate_native_entry(expected).await;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
        self.spawn_native_grant_publisher(expected.grant.grant.clone());
        Err(ControlError::unavailable(
            "grant_approval_pending",
            "the approval is still being saved; the app can connect once it lands",
        ))
    }

    /// Retry automatic Private grant materialization while account consent is
    /// current. One task per grant; a no-op if already running.
    fn spawn_native_grant_publisher(&self, grant: String) {
        let Some(d) = self.arc() else {
            return;
        };
        {
            let mut set = self
                .grant_publications
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            if !set.insert(grant.clone()) {
                return;
            }
        }
        tokio::spawn(async move {
            for attempt in 0..300 {
                if attempt != 0 {
                    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                }
                let entry = {
                    let inner = d.inner.lock().await;
                    inner
                        .access
                        .entries
                        .iter()
                        .find(|e| e.grant.grant == grant)
                        .cloned()
                };
                let Some(entry) = entry else { break };
                if entry.is_refused() {
                    break;
                }
                let Some(grant16) = crate::attest::uuid_bytes(&entry.grant.grant) else {
                    break;
                };
                let Some(state) = d
                    .native_grant_state(&entry.grant.collection, &grant16)
                    .await
                else {
                    continue;
                };
                if state.failure.is_some() || !state.active {
                    break;
                }
                if d.publish_native_grant(&entry).await.is_ok() {
                    break;
                }
            }
            d.grant_publications
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&grant);
        });
    }

    /// After a fresh account feed, automatically publish missing sealed scope,
    /// including after restart. Already materialized grants need no report.
    async fn publish_account_grants(&self) {
        let pending: Vec<String> = {
            let inner = self.inner.lock().await;
            inner
                .access
                .entries
                .iter()
                .filter(|e| {
                    !e.is_refused()
                        && inner
                            .registry
                            .get(&e.grant.collection)
                            .is_some_and(|c| c.mode == SyncMode::SyncedE2e)
                })
                .map(|e| e.grant.grant.clone())
                .collect()
        };
        for grant in pending {
            let entry = {
                let inner = self.inner.lock().await;
                inner
                    .access
                    .entries
                    .iter()
                    .find(|e| e.grant.grant == grant)
                    .cloned()
            };
            if let Some(entry) = entry
                && let Some(id) = crate::attest::uuid_bytes(&grant)
                && self
                    .native_grant_state(&entry.grant.collection, &id)
                    .await
                    .is_some_and(|s| s.approved_capabilities.is_some())
            {
                continue;
            }
            self.spawn_native_grant_publisher(grant);
        }
    }

    async fn commit_control_plane_feed(
        &self,
        snapshot: &crate::relay::Snapshot,
        grants: &std::collections::BTreeMap<String, Vec<CachedGrant>>,
    ) -> Result<(), ControlError> {
        let _gate = self.account_gate.lock().await;
        let record = crate::cloud::AccountRecord::load(&self.profile.account_file())
            .map_err(|error| ControlError::unavailable("account_state", error.to_string()))?;
        if record.active_account().is_none()
            || record.epoch != snapshot.account_epoch
            || record.connector_id.as_deref() != Some(snapshot.connector_id.as_str())
            || self.authority.active_account() != record.active_account()
        {
            return Err(ControlError::new(
                "forbidden",
                "policy_authority_mismatch",
                "relay account epoch or connector is no longer active",
            ));
        }
        self.commit_control_plane_feed_with(snapshot, grants, |next| {
            next.save(&self.profile.access_file())
        })
        .await
    }

    async fn commit_control_plane_feed_with(
        &self,
        snapshot: &crate::relay::Snapshot,
        grants: &std::collections::BTreeMap<String, Vec<CachedGrant>>,
        save: impl FnOnce(&AccessList) -> Result<(), crate::access::AccessError>,
    ) -> Result<(), ControlError> {
        let mut inner = self.inner.lock().await;
        if let Some(cursor) = &inner.access.feed_cursor
            && (cursor.connector != snapshot.connector_id
                || snapshot.sequence < cursor.sequence
                || (snapshot.sequence == cursor.sequence && snapshot.revision != cursor.revision))
        {
            return Err(ControlError::new(
                "forbidden",
                "stale_policy",
                "feed cursor mismatch",
            ));
        }
        if inner
            .access
            .feed_cursor
            .as_ref()
            .is_some_and(|c| c.sequence == snapshot.sequence && c.revision == snapshot.revision)
        {
            // An ACK retry is idempotent, not a new freshness lease. After a
            // restart/failure, reconciliation must deliver a newer sequence.
            return Ok(());
        }
        let mut next = inner.access.clone();
        let mut events = Vec::new();
        let now = fsutil::now_ms() as u64;
        // Local collections serve from this list; synced end-to-end ones are
        // synced so account-approved native grants can be materialized without
        // a second user decision (the replica's log policy decides sessions).
        for collection in inner
            .registry
            .collections
            .iter()
            .filter(|e| matches!(e.mode, SyncMode::Local | SyncMode::SyncedE2e))
        {
            events.extend(
                next.sync_from_control_plane(
                    &collection.id,
                    grants
                        .get(&collection.id)
                        .map(Vec::as_slice)
                        .unwrap_or_default(),
                    now,
                    snapshot.lease_expires_ms,
                    collection.mode == SyncMode::SyncedE2e,
                ),
            );
            next.monotonic_leases
                .insert(collection.id.clone(), snapshot.lease_deadline);
        }
        next.feed_cursor = Some(crate::access::FeedCursor {
            connector: snapshot.connector_id.clone(),
            sequence: snapshot.sequence,
            revision: snapshot.revision.clone(),
        });
        if let Err(e) = save(&next) {
            // A failure may be before rename or after rename/directory sync.
            // Nothing is served in either case; restart also needs a fresh lease.
            inner.access.leases.clear();
            inner.access.monotonic_leases.clear();
            inner.access.feed_cursor = next.feed_cursor;
            self.authority.publish_access(&inner.access);
            let barrier = publish_grants(&inner);
            drop(inner);
            barrier.wait().await;
            return Err(access_error(e));
        }
        inner.access = next;
        self.authority.publish_access(&inner.access);
        // The feed is acknowledged (policy_applied) only after every runtime has
        // re-checked its sessions under the new grants (revoke barrier).
        let barrier = publish_grants(&inner);
        drop(inner);
        barrier.wait().await;
        for event in events {
            self.note_access_event(&event).await;
            let _ = self.access_events.send(event);
        }
        self.bump();
        self.publish_account_grants().await;
        Ok(())
    }

    /// [`Self::handle`], then log what a successful call changed.
    async fn handle_and_note(
        self: &Arc<Self>,
        req: &Request,
        conn: &mut ConnAuth,
    ) -> Result<Value, ControlError> {
        let prior = self
            .collection_name(req.params.get("collection").and_then(Value::as_str))
            .await;
        let v = self.handle(req, conn).await?;
        self.note_control_call(req, &v, prior).await;
        Ok(v)
    }

    async fn handle(
        self: &Arc<Self>,
        req: &Request,
        conn: &mut ConnAuth,
    ) -> Result<Value, ControlError> {
        match req.method.as_str() {
            Method::AUTH_CHALLENGE => {
                let mut n = [0u8; 32];
                getrandom::fill(&mut n).map_err(|e| ControlError::internal(e.to_string()))?;
                conn.nonce = Some(n);
                return Ok(json!({ "nonce": secrets::hex(&n) }));
            }
            Method::AUTH_PROVE => {
                let nonce = conn.nonce.take().ok_or_else(|| {
                    ControlError::invalid("no_challenge", "call auth.challenge first")
                })?;
                let proof = req
                    .params
                    .get("proof")
                    .and_then(Value::as_str)
                    .and_then(|h| secrets::hex_decode(h).ok())
                    .unwrap_or_default();
                let key = self.control_key.get().ok_or_else(|| {
                    ControlError::unavailable("not_ready", "the control key is not loaded")
                })?;
                let want = secrets::control_proof(key, &nonce);
                if !ct_eq(&proof, &want) {
                    tracing::warn!("control caller failed authentication");
                    return Err(ControlError::new(
                        "unauthenticated",
                        "bad_proof",
                        "control authentication failed",
                    ));
                }
                conn.privileged = true;
                return Ok(json!({}));
            }
            m if crate::control::PRIVILEGED.contains(&m) && !conn.privileged => {
                return Err(ControlError::new(
                    "forbidden",
                    "caller_not_authenticated",
                    format!("{m} needs an authenticated caller (auth.challenge, auth.prove)"),
                ));
            }
            _ => {}
        }
        let always = matches!(
            req.method.as_str(),
            Method::PING
                | Method::STATUS
                | Method::STATUS_SUBSCRIBE
                | Method::SHUTDOWN
                | Method::DOCTOR
        );
        if !always && !self.is_ready() {
            let r = self.readiness.borrow().clone();
            return Err(ControlError::unavailable(
                "not_ready",
                format!(
                    "the daemon is not ready ({})",
                    r.safe_reason
                        .map(|s| serde_json::to_value(s).unwrap_or_default())
                        .and_then(|v| v.as_str().map(str::to_string))
                        .unwrap_or_else(|| "unknown".into())
                ),
            ));
        }
        match req.method.as_str() {
            Method::PING => Ok(json!({ "readiness": *self.readiness.borrow() })),
            Method::STATUS | Method::STATUS_SUBSCRIBE => to_value(&self.status().await),
            Method::SHUTDOWN => {
                self.shutdown.send_replace(true);
                Ok(json!({}))
            }
            Method::COLLECTION_LIST => {
                let inner = self.inner.lock().await;
                let taken = self.takeover_record();
                let mut collections = Vec::with_capacity(inner.hosts.len());
                for host in &inner.hosts {
                    collections.push(with_private_sync_pending(
                        with_takeover_holds(
                            with_access_notices(host.observed_status().await, &inner.access),
                            taken.as_ref(),
                        ),
                        &self.auto_private,
                        &self.profile.state_dir.join("collections"),
                    ));
                }
                to_value(&collections)
            }
            Method::COLLECTION_ADD => self.add(params(req)?).await,
            Method::COLLECTION_REMOVE => {
                let p: CollectionRef = params(req)?;
                self.remove(&p.collection).await
            }
            Method::COLLECTION_DELETE => self.delete_collection(params(req)?).await,
            Method::COLLECTION_UPDATE => {
                let p: UpdateCollection = params(req)?;
                self.update_collection(p).await
            }
            Method::COLLECTION_PAUSE | Method::COLLECTION_RESUME => {
                let p: CollectionRef = params(req)?;
                let out = self
                    .set_paused(&p.collection, req.method == Method::COLLECTION_PAUSE)
                    .await;
                if out.is_ok() && req.method == Method::COLLECTION_RESUME {
                    self.spawn_auto_private();
                }
                out
            }
            Method::COLLECTION_HOLDS => {
                let p: CollectionRef = params(req)?;
                self.holds(&p.collection).await
            }
            Method::COLLECTION_RESOLVE_HOLD => self.resolve_hold(params(req)?).await,
            Method::COLLECTION_CONFLICTS => {
                let p: CollectionRef = params(req)?;
                self.serving(&p.collection).await?;
                Err(ControlError::not_implemented(&req.method))
            }
            Method::SYNC_ENABLE => {
                let p: EnableSync = params(req)?;
                if p.mode == Some(SyncMode::Local) {
                    return Err(ControlError::invalid(
                        "invalid_mode",
                        "sync.enable takes mode synced or synced_e2e",
                    ));
                }
                let out = self.enable_sync(p).await;
                // A private collection enabled here is keyed for the account key.
                self.account_keys.wake();
                out
            }
            Method::COLLECTION_JOIN => {
                let out = self.join(params(req)?).await;
                self.account_keys.wake();
                out
            }
            Method::SYNC_DISABLE => {
                let p: CollectionRef = params(req)?;
                self.serving(&p.collection).await?;
                Err(ControlError::not_implemented("disabling sync"))
            }
            Method::DEVICE_PENDING
            | Method::RECOVERY_STATUS
            | Method::RECOVERY_CREATE
            | Method::RECOVERY_IMPORT => {
                let p: CollectionRef = params(req)?;
                self.e2e_collection(&p.collection).await?;
                Err(ControlError::not_implemented(&req.method))
            }
            Method::DEVICE_APPROVE => {
                let p: ApproveDevice = params(req)?;
                if p.code.len() != 6 || !p.code.bytes().all(|b| b.is_ascii_digit()) {
                    return Err(ControlError::invalid(
                        "invalid_code",
                        "the code is six digits",
                    ));
                }
                self.e2e_collection(&p.collection).await?;
                Err(ControlError::not_implemented("device approval"))
            }
            Method::DEVICE_REJECT => {
                let p: CollectionRef = params(req)?;
                self.e2e_collection(&p.collection).await?;
                Err(ControlError::not_implemented("device rejection"))
            }
            Method::PRIVATE_STATUS => self.private_status().await,
            Method::PRIVATE_SETUP => self.private_setup(params(req)?).await,
            Method::PRIVATE_UNLOCK => self.private_unlock(params(req)?).await,
            Method::PRIVATE_PASSWORD => self.private_password(params(req)?).await,
            Method::PRIVATE_STRICT => self.private_strict().await,
            Method::DOCTOR => to_value(&self.doctor().await),
            Method::MIGRATE_STATUS => {
                let refresh =
                    req.params.get("refresh_rollout").and_then(Value::as_bool) == Some(true);
                tokio::spawn(self.clone().retry_takeover(refresh));
                self.takeover_status().await
            }
            Method::MIGRATE_START => {
                let p: crate::control::MigrateStart = params(req)?;
                let out = self.clone().takeover_run(p.stop_mirrors, false).await;
                if out.is_ok() {
                    tokio::spawn(self.clone().auto_private());
                }
                out
            }
            Method::ACCESS_LIST => {
                let c: Option<String> = req
                    .params
                    .get("collection")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let inner = self.inner.lock().await;
                to_value(&inner.access.list(c.as_deref()))
            }
            Method::ACCESS_REVOKE | Method::ACCESS_DENY => {
                let p: GrantRef = params(req)?;
                let revoke = req.method == Method::ACCESS_REVOKE;
                tracing::info!(grant = %p.grant, revoke, "grant refused on this device");
                let v = self
                    .access_change(|l| {
                        if revoke {
                            l.revoke(&p.grant).cloned()
                        } else {
                            l.deny(&p.grant).cloned()
                        }
                    })
                    .await?;
                self.revoke_upstream(p.grant.clone());
                Ok(v)
            }
            Method::ACCESS_APPROVE => {
                let p: GrantRef = params(req)?;
                // Private grants already have account consent. No native
                // dialog is part of their access path, even on an explicit CLI
                // review of an entry cached by an older build.
                let native = {
                    let inner = self.inner.lock().await;
                    inner
                        .access
                        .entries
                        .iter()
                        .find(|e| e.grant.grant == p.grant)
                        .filter(|e| {
                            inner
                                .registry
                                .get(&e.grant.collection)
                                .is_some_and(|c| c.mode == SyncMode::SyncedE2e)
                        })
                        .cloned()
                };
                if let Some(entry) = native {
                    self.spawn_native_grant_publisher(entry.grant.grant.clone());
                    return to_value(&entry);
                }
                let (expected, what) = {
                    let inner = self.inner.lock().await;
                    let e = inner
                        .access
                        .entries
                        .iter()
                        .find(|e| e.grant.grant == p.grant)
                        .ok_or_else(|| ControlError::not_found("no such grant on this device"))?;
                    let name = inner
                        .registry
                        .get(&e.grant.collection)
                        .map(|c| c.name.clone())
                        .unwrap_or_else(|| e.grant.collection.clone());
                    let what = format!(
                        "Allow {} to use the collection \"{}\" through this computer?\n\nAccess: {}\nFolders: {}\nApp key: {}\n\nCompare this key with the app's access request in your browser.",
                        e.grant.app_name,
                        name,
                        crate::access::plain_capabilities(&e.grant.capabilities),
                        e.grant
                            .folders
                            .as_ref()
                            .map(|f| f.join(", "))
                            .unwrap_or_else(|| "whole collection".into()),
                        e.grant.fingerprint()
                    );
                    (e.clone(), what)
                };
                self.confirm("Approve app access", &what).await?;
                self.approve_confirmed(&expected).await
            }
            Method::ACCESS_ACK => {
                let p: GrantRef = params(req)?;
                self.access_change(|l| l.acknowledge(&p.grant).cloned())
                    .await
            }
            Method::ACCOUNT_SIGN_IN => self.sign_in(req).await,
            Method::ACCOUNT_SIGN_OUT => self.sign_out().await,
            Method::ACTIVITY_LIST => {
                let limit = req
                    .params
                    .get("limit")
                    .and_then(Value::as_u64)
                    .unwrap_or(50);
                to_value(
                    &self
                        .activity
                        .list(limit.min(crate::activity::KEEP as u64) as usize),
                )
            }
            Method::ACCOUNT_RENAME => {
                let name = req.params.get("name").and_then(Value::as_str).unwrap_or("");
                self.rename_computer(name).await
            }
            Method::SETTINGS_GET => {
                let inner = self.inner.lock().await;
                to_value(&Settings {
                    require_grant_approval: inner.access.require_grant_approval,
                })
            }
            Method::SETTINGS_SET => {
                let want = req
                    .params
                    .get("require_grant_approval")
                    .and_then(Value::as_bool);
                if want == Some(false) {
                    self.confirm(
                        "Turn off approval",
                        "Let new apps use your local collections without asking you first?\n\nYou will still be notified.",
                    )
                    .await?;
                }
                let mut inner = self.inner.lock().await;
                if let Some(v) = want {
                    let mut next = inner.access.clone();
                    next.require_grant_approval = v;
                    next.save(&self.profile.access_file())
                        .map_err(access_error)?;
                    inner.access = next;
                    for h in &inner.hosts {
                        h.publish_grants(&inner.access);
                    }
                    tracing::info!(require_grant_approval = v, "settings changed");
                }
                let s = Settings {
                    require_grant_approval: inner.access.require_grant_approval,
                };
                drop(inner);
                self.bump();
                to_value(&s)
            }
            other => Err(ControlError::invalid(
                "unknown_method",
                format!("unknown method {other}"),
            )),
        }
    }

    async fn serving(&self, id: &str) -> Result<CollectionStatus, ControlError> {
        let inner = self.inner.lock().await;
        let host = inner
            .hosts
            .iter()
            .find(|h| h.entry().id == id)
            .ok_or_else(|| ControlError::not_found(format!("no registered collection {id}")))?;
        if !host.is_serving() {
            let s = host.status();
            return Err(ControlError::unavailable(
                s.reason.as_deref().unwrap_or("not_serving"),
                format!("collection {id} is not being served"),
            ));
        }
        Ok(host.status())
    }

    /// The serving runtime of a registered collection.
    async fn runtime_of(&self, id: &str) -> Result<Arc<crate::runtime::Runtime>, ControlError> {
        self.serving(id).await?;
        let inner = self.inner.lock().await;
        inner
            .hosts
            .iter()
            .find(|h| h.entry().id == id)
            .and_then(CollectionHost::runtime)
            .ok_or_else(|| {
                ControlError::unavailable("runtime_stopped", format!("collection {id} stopped"))
            })
    }

    /// `collection.holds`: the replica's holds, content-free.
    async fn holds(&self, id: &str) -> Result<Value, ControlError> {
        use mdbn_wire::Wire;
        use mdbn_wire::client::Hold;
        // Files held at the takeover list beside the replica's own holds, and
        // even while the collection does not serve.
        let id = &self.registered_collection(id).await?;
        if let Ok(rt) = self.runtime_of(id).await {
            self.reconcile_takeover_resolutions(&rt, id).await?;
        }
        let taken = crate::takeover::held::open(&self.takeover_paths().legacy, id)
            .map_err(|e| ControlError::internal(format!("takeover holds: {e}")))?;
        let mut out = match self.runtime_of(id).await {
            Ok(rt) => {
                let result = host_call(&rt, "list_holds", mdbn_wire::cbor::Cbor::Null).await?;
                let holds: Vec<Hold> = Wire::from_cbor(&result)
                    .map_err(|_| ControlError::internal("the replica's holds do not decode"))?;
                holds.iter().map(hold_summary).collect::<Vec<_>>()
            }
            Err(e) if taken.is_empty() => return Err(e),
            Err(_) => Vec::new(),
        };
        out.extend(taken.iter().map(takeover_hold_summary));
        Ok(json!(out))
    }

    /// The registered collection `raw` names, as the registry spells it. Only
    /// the exact canonical ID of a registered collection is accepted, before
    /// anything (a takeover directory above all) is derived from it.
    async fn registered_collection(&self, raw: &str) -> Result<String, ControlError> {
        if !crate::takeover::held::is_collection_id(raw) {
            return Err(ControlError::invalid(
                "invalid_collection",
                "collection is not a collection ID",
            ));
        }
        self.inner
            .lock()
            .await
            .registry
            .get(raw)
            .map(|e| e.id.clone())
            .filter(|id| id == raw)
            .ok_or_else(|| ControlError::not_found(format!("no registered collection {raw}")))
    }

    /// Read back the takeover hold resolutions still in flight for `collection`:
    /// a confirmed one resolves its hold, a rejected one is dropped (the hold
    /// stays open), and a pending or unknown one is left to read back again.
    async fn reconcile_takeover_resolutions(
        &self,
        rt: &Arc<crate::runtime::Runtime>,
        collection: &str,
    ) -> Result<(), ControlError> {
        let paths = self.takeover_paths();
        let io = |e: std::io::Error| ControlError::internal(format!("takeover holds: {e}"));
        if crate::takeover::held::in_flight(&paths.legacy, collection)
            .map_err(io)?
            .is_empty()
        {
            return Ok(());
        }
        let _run = self.takeover.run.lock().await;
        let mut settled = false;
        for (path, r) in crate::takeover::held::in_flight(&paths.legacy, collection).map_err(io)? {
            let Some(outcome) = read_back(rt, r.mutation).await? else {
                continue;
            };
            settled |= crate::takeover::held::settle(
                &paths.record,
                &paths.legacy,
                collection,
                &path,
                outcome,
            )
            .map_err(io)?;
        }
        drop(_run);
        if settled {
            self.bump();
        }
        Ok(())
    }

    /// Resolve a file held at the takeover. Keep this computer's: the folder
    /// already has it. Take the other: the old engine's version (or its
    /// delete) is written as this device's edit. Keep both: the old version is
    /// added beside it as `<name> (old version).md`. The hold is cleared only
    /// once that edit is confirmed: a pending or unknown one leaves it open, and
    /// asking again (or listing the holds) reads the same mutation back.
    async fn resolve_takeover_hold(&self, p: &ResolveHold) -> Result<Value, ControlError> {
        use crate::takeover::held::{self, Outcome};
        use mdbn_wire::intent::{Create, Delete, DocVersion, Document, Op};
        let collection = self.registered_collection(&p.collection).await?;
        let io = |e: std::io::Error| ControlError::internal(format!("takeover holds: {e}"));
        let _run = self.takeover.run.lock().await;
        let paths = self.takeover_paths();
        let held = held::open(&paths.legacy, &collection)
            .map_err(io)?
            .into_iter()
            .find(|h| h.id == p.id)
            .ok_or_else(|| ControlError::not_found(format!("no hold {}", p.id)))?;
        let how = match p.how {
            HoldAction::KeepMine => "keep_mine",
            HoldAction::TakeTheirs => "take_theirs",
            HoldAction::KeepBoth => "keep_both",
            HoldAction::Delete => "delete",
        };
        let in_flight = held::resolving(&paths.legacy, &collection, &held.path).map_err(io)?;
        if let Some(r) = &in_flight {
            if r.how != how {
                return Err(ControlError::new(
                    "conflict",
                    "resolution_pending",
                    "this file is already being resolved another way; ask again once that settles",
                ));
            }
            // Read the earlier submission back; resubmit only if the replica
            // has no receipt for it.
            let rt = self.runtime_of(&collection).await?;
            if let Some(outcome) = read_back(&rt, r.mutation).await? {
                return self.settle_takeover_hold(
                    &paths,
                    &collection,
                    &held.path,
                    r.mutation,
                    outcome,
                    _run,
                );
            }
        }
        let identity = in_flight.unwrap_or_else(|| held::Resolution {
            how: how.into(),
            mutation: new_uuid_v7(),
            record: new_uuid_v7(),
        });
        let ops = match p.how {
            HoldAction::KeepMine => Vec::new(),
            HoldAction::Delete => {
                return Err(ControlError::invalid(
                    "unsupported",
                    "files held at the takeover are resolved with keep_mine, take_theirs or keep_both",
                ));
            }
            HoldAction::TakeTheirs | HoldAction::KeepBoth => {
                let text = match &held.intended {
                    None => None,
                    Some(b) => Some(
                        std::str::from_utf8(b)
                            .ok()
                            .filter(|_| is_markdown_path(&held.path))
                            .ok_or_else(|| {
                                ControlError::invalid(
                                    "binary",
                                    "this file is not a note; keep this computer's version \
                                     (`keep_mine`) and restore the other one by hand",
                                )
                            })?
                            .to_string(),
                    ),
                };
                let rt = self.runtime_of(&p.collection).await?;
                let current = record_at(&rt, &held.path).await?;
                match (p.how, text) {
                    // The other version is a delete: there is nothing to keep beside.
                    (HoldAction::KeepBoth, None) => Vec::new(),
                    (HoldAction::KeepBoth, Some(t)) => {
                        let root = self.entry_root(&p.collection).await?;
                        let mut target = None;
                        for c in crate::takeover::held::keep_both_paths(&held.path) {
                            if !root.join(&c).exists() && record_at(&rt, &c).await?.is_none() {
                                target = Some(c);
                                break;
                            }
                        }
                        let target = target.ok_or_else(|| {
                            ControlError::new(
                                "conflict",
                                "no_free_name",
                                "no free name for the old version",
                            )
                        })?;
                        vec![Op::Create(Create {
                            id: mdbn_wire::common::B16(identity.record),
                            path: Some(target),
                            type_name: None,
                            frontmatter: None,
                            body: None,
                            document: Some(mdbn_wire::common::Text::Inline(t)),
                        })]
                    }
                    (_, Some(t)) => match current {
                        Some(r) => vec![Op::Document(Document {
                            id: r.id,
                            base: r.document.map(|d| DocVersion {
                                path: r.path.clone(),
                                doc: mdbn_wire::common::Text::Inline(d),
                            }),
                            new: Some(DocVersion {
                                path: held.path.clone(),
                                doc: mdbn_wire::common::Text::Inline(t),
                            }),
                            if_revision: Some(r.revision),
                        })],
                        None => vec![Op::Create(Create {
                            id: mdbn_wire::common::B16(identity.record),
                            path: Some(held.path.clone()),
                            type_name: None,
                            frontmatter: None,
                            body: None,
                            document: Some(mdbn_wire::common::Text::Inline(t)),
                        })],
                    },
                    (_, None) => match current {
                        Some(r) => vec![Op::Delete(Delete {
                            id: r.id,
                            base_revision: Some(r.revision),
                            if_revision: None,
                        })],
                        None => Vec::new(),
                    },
                }
            }
        };
        if ops.is_empty() {
            return self.settle_takeover_hold(
                &paths,
                &collection,
                &held.path,
                [0u8; 16],
                Outcome::Confirmed,
                _run,
            );
        }
        // The identity is durable before anything is submitted, so a retry
        // after any outcome reuses it.
        let identity = match held::begin(&paths.legacy, &collection, &held.path, how, || {
            (identity.mutation, identity.record)
        })
        .map_err(io)?
        {
            Ok(r) => r,
            Err(_) => {
                return Err(ControlError::new(
                    "conflict",
                    "resolution_pending",
                    "this file is already being resolved another way; ask again once that settles",
                ));
            }
        };
        let rt = self.runtime_of(&collection).await?;
        let outcome = submit_as(&rt, ops, identity.mutation).await?;
        self.settle_takeover_hold(
            &paths,
            &collection,
            &held.path,
            identity.mutation,
            outcome,
            _run,
        )
    }

    /// Settle a takeover hold resolution by its outcome (see
    /// `takeover::held::settle`) and answer for it.
    fn settle_takeover_hold(
        &self,
        paths: &crate::takeover::Paths,
        collection: &str,
        path: &str,
        mutation: [u8; 16],
        outcome: crate::takeover::held::Outcome,
        run: tokio::sync::MutexGuard<'_, ()>,
    ) -> Result<Value, ControlError> {
        use crate::takeover::held::Outcome;
        let resolved =
            crate::takeover::held::settle(&paths.record, &paths.legacy, collection, path, outcome)
                .map_err(|e| ControlError::internal(format!("takeover holds: {e}")))?;
        drop(run);
        if resolved {
            self.bump();
        }
        let state = match outcome {
            Outcome::Confirmed => "confirmed",
            Outcome::Pending => "pending",
            Outcome::Unknown => "unknown",
            Outcome::Rejected => {
                return Err(ControlError::new(
                    "conflict",
                    "rejected",
                    "the change was rejected; the hold stays open",
                ));
            }
        };
        Ok(json!(HoldResolved {
            mutation: secrets::uuid_string(&mutation),
            state: state.into(),
        }))
    }

    /// The registered folder of `id`.
    async fn entry_root(&self, id: &str) -> Result<std::path::PathBuf, ControlError> {
        self.inner
            .lock()
            .await
            .registry
            .get(id)
            .map(|e| e.root.clone())
            .ok_or_else(|| ControlError::not_found(format!("no registered collection {id}")))
    }

    /// `collection.resolve_hold`: resolve one hold as the hosting app (the user's
    /// own device; the SDK resolves with content on behalf of an app grant).
    async fn resolve_hold(&self, p: ResolveHold) -> Result<Value, ControlError> {
        use mdbn_wire::Wire;
        use mdbn_wire::cbor::Cbor;
        use mdbn_wire::client::{Receipt, ReceiptState};
        if p.id.starts_with(crate::takeover::held::ID_PREFIX) {
            let out = self.resolve_takeover_hold(&p).await;
            if out.is_ok() {
                // The last held file resolved lets Private sync turn on.
                self.spawn_auto_private();
            }
            return out;
        }
        let id: [u8; 16] = secrets::hex_decode(&p.id.replace('-', ""))
            .ok()
            .and_then(|v| v.try_into().ok())
            .ok_or_else(|| ControlError::invalid("invalid_id", "id is not a UUID"))?;
        let how: u64 = match p.how {
            HoldAction::KeepMine => 0,
            HoldAction::TakeTheirs => 1,
            HoldAction::Delete => 3,
            HoldAction::KeepBoth => 4,
        };
        let rt = self.runtime_of(&p.collection).await?;
        let params = Cbor::Map(vec![
            (Cbor::Uint(0), Cbor::Bytes(id.to_vec())),
            (Cbor::Uint(1), Cbor::Uint(how)),
        ]);
        let result = host_call(&rt, "resolve_hold", params).await?;
        let receipt: Receipt = Wire::from_cbor(&result)
            .map_err(|_| ControlError::internal("the replica's receipt does not decode"))?;
        let state = match receipt.state {
            ReceiptState::Pending => "pending",
            ReceiptState::Confirmed => "confirmed",
            ReceiptState::Rejected => "rejected",
            ReceiptState::Unknown => "unknown",
        };
        Ok(json!(HoldResolved {
            mutation: secrets::uuid_string(&receipt.mutation.0),
            state: state.into(),
        }))
    }

    async fn e2e_collection(&self, id: &str) -> Result<(), ControlError> {
        let s = self.serving(id).await?;
        if s.mode != SyncMode::SyncedE2e {
            return Err(ControlError::invalid(
                "not_end_to_end",
                "device approval and recovery keys apply to end-to-end synced collections",
            ));
        }
        Ok(())
    }

    async fn add(&self, p: AddCollection) -> Result<Value, ControlError> {
        self.add_with_pause(p, false).await
    }

    async fn add_with_pause(&self, p: AddCollection, paused: bool) -> Result<Value, ControlError> {
        if !p.path.is_absolute() {
            return Err(ControlError::invalid(
                "relative_path",
                "the path must be absolute",
            ));
        }
        let root = canonical_dir(&p.path)?;
        if registry::overlaps(&root, &self.profile.state_dir) {
            return Err(ControlError::invalid(
                "overlapping_state_dir",
                "a collection cannot contain or sit inside the daemon's state directory",
            ));
        }
        let claim = match classify_folder(&root, &self.profile) {
            Ok(c) => c,
            Err(e) => return Err(e),
        };
        if let FolderClaim::Connect(reason) = claim {
            // Local migration: the takeover (drain, import, v2 marker) runs first.
            return Err(ControlError::unavailable(
                "migration_pending",
                format!(
                    "this folder is managed by today's mdbase Connect ({reason}); \
                     it is taken over by the migration first"
                ),
            ));
        }
        let name = p
            .name
            .as_deref()
            .map(display_name)
            .transpose()?
            .unwrap_or_else(|| {
                root.file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| root.display().to_string())
            });
        let (id, replica_id, origin) = match claim {
            FolderClaim::Ours {
                collection,
                replica_id,
            } => (collection, replica_id, Origin::MigratedLocal),
            _ => (
                secrets::new_uuid().map_err(|e| ControlError::internal(e.to_string()))?,
                secrets::new_uuid().map_err(|e| ControlError::internal(e.to_string()))?,
                Origin::Adopted,
            ),
        };
        let _gate = self.account_gate.lock().await;
        let owner = self.authority.active_account().ok_or_else(|| {
            ControlError::new(
                "unauthenticated",
                "account_identity_missing",
                "pair with an authenticated account before registering a local collection",
            )
        })?;
        let device = self
            .identity
            .get()
            .ok_or_else(|| {
                ControlError::unavailable("device_identity_missing", "keychain device unavailable")
            })?
            .device_id;
        let entry = Entry {
            id,
            name,
            root,
            replica_id,
            mode: SyncMode::Local,
            origin,
            description: None,
            added_at_ms: fsutil::now_ms() as u64,
            paused,
            ever_e2e: false,
            owner_account: Some(secrets::uuid_string(&owner.0)),
            device: Some(secrets::uuid_string(&device)),
        };
        let mut inner = self.inner.lock().await;
        let mut next = inner.registry.clone();
        next.add(entry.clone()).map_err(registry_error)?;
        self.save_registry(&next)?;
        inner.registry = next;
        self.authority.publish_registry(&inner.registry);
        let host = CollectionHost::open(entry, self.host_ctx());
        host.publish_grants(&inner.access);
        let status = host.status();
        inner.hosts.push(host);
        drop(inner);
        self.bump();
        tracing::info!(collection = %status.id, root = %status.root.display(), "collection registered");
        to_value(&status)
    }

    /// The signed-in Connect, connector and authenticated trust, or why not.
    fn sync_parts(
        &self,
    ) -> Result<(crate::collections::SyncCtx, Arc<crate::trust::Trust>), ControlError> {
        let ctx = self.sync_ctx().ok_or_else(|| {
            ControlError::new(
                "unauthenticated",
                "not_signed_in",
                "sign this computer in first (`mdbase account sign-in`)",
            )
        })?;
        let trust = ctx.trust.clone().ok_or_else(|| {
            ControlError::unavailable(
                "trust_missing",
                "this build has no authenticated trust for synced collections",
            )
        })?;
        if crate::trust::origin(ctx.cloud.server()).ok().as_deref()
            != Some(trust.cp_origin.as_str())
        {
            return Err(ControlError::unavailable(
                "sync_config_invalid",
                "the signed-in server is not this build's control plane",
            ));
        }
        Ok((ctx, trust))
    }

    /// Verify the control plane's candidate genesis under the pins and write the
    /// collection's `sync.json`. Nothing is persisted unless the genesis verifies.
    fn write_link(
        &self,
        id: &str,
        collection: &[u8; 16],
        trust: &crate::trust::Trust,
        state: mdbn_wire::policy::CState,
        log_url: &str,
        genesis: &[u8],
    ) -> Result<(), ControlError> {
        let refused = |m: String| ControlError::unavailable("sync_integrity", m);
        if crate::trust::origin(log_url).map_err(|e| refused(e.0))? != trust.log_origin {
            return Err(refused("the control plane named another log".into()));
        }
        let pinned = crate::sync::verify_genesis(genesis, collection, trust, state)
            .map_err(|e| refused(e.0))?;
        let device = self
            .identity
            .get()
            .ok_or_else(|| {
                ControlError::unavailable("device_identity_missing", "keychain device unavailable")
            })?
            .device_id;
        let cloud_copy = state == mdbn_wire::policy::CState::CloudCopy;
        let cfg = crate::sync::SyncConfig {
            schema_version: 2,
            environment: trust.environment.clone(),
            collection_id: id.to_string(),
            log_url: trust.log_origin.clone(),
            genesis_hash: secrets::hex(&pinned),
            chosen_state: if cloud_copy { "cloud_copy" } else { "private" }.into(),
            trusted_signers: vec![secrets::uuid_string(&device)],
            user_enabled_cloud_copy: cloud_copy,
        };
        let dir = self.profile.state_dir.join("collections").join(id);
        fsutil::ensure_private_dir(&dir).map_err(|e| ControlError::internal(e.to_string()))?;
        cfg.save(
            &crate::sync::SyncConfig::path(&self.profile.state_dir.join("collections"), id),
            collection,
            trust,
        )
        .map_err(|e| refused(e.0))
    }

    /// Join an account's cloud copy into an empty folder. Connect enrols this
    /// device (control-signed); hosted (or escrow) then wraps the epoch key to it.
    async fn join(&self, p: JoinCollection) -> Result<Value, ControlError> {
        // Serialize registration with account/collection lifecycle. The captured
        // source below additionally rechecks the actual durable incarnation.
        let _gate = self.account_gate.lock().await;
        let (ctx, trust) = self.sync_parts()?;
        let collection =
            crate::attest::uuid_bytes(&p.collection.to_ascii_lowercase()).ok_or_else(|| {
                ControlError::invalid("invalid_collection", "the collection is a UUID")
            })?;
        let id = secrets::uuid_string(&collection);
        let source = self
            .authority
            .source(mdbn_wire::common::B16(collection))
            .map_err(|_| {
                ControlError::new(
                    "unauthenticated",
                    "account_changed",
                    "current paired account required",
                )
            })?;
        let owner = source.active_account().ok_or_else(|| {
            ControlError::new(
                "unauthenticated",
                "account_changed",
                "current paired account required",
            )
        })?;
        let current = || {
            source
                .active_account()
                .filter(|a| a == &owner)
                .map(|_| ())
                .ok_or_else(|| "account_changed".to_string())
        };
        if !p.path.is_absolute() {
            return Err(ControlError::invalid(
                "relative_path",
                "the path must be absolute",
            ));
        }
        let root = canonical_dir(&p.path)?;
        if registry::overlaps(&root, &self.profile.state_dir) {
            return Err(ControlError::invalid(
                "overlapping_state_dir",
                "a collection cannot contain or sit inside the daemon's state directory",
            ));
        }
        if !folder_is_empty(&root)? {
            return Err(ControlError::invalid(
                "folder_not_empty",
                "join into an empty folder; the collection's files arrive from the log",
            ));
        }
        if self.inner.lock().await.registry.get(&id).is_some() {
            return Err(ControlError::invalid(
                "already_registered",
                "this collection is already here",
            ));
        }
        let identity = self
            .identity
            .get()
            .ok_or_else(|| {
                ControlError::unavailable("device_identity_missing", "keychain device unavailable")
            })?
            .clone();
        let joined = if p.private {
            // Private: enrol with a real SAS commitment whose requester state is in
            // the keychain journal BEFORE any I/O, so an approver can key this device
            // later (strict mode) and a restart keeps the reveal-once state. The
            // account key (`private.unlock`) keys it without the commitment.
            let commit = self.private_join_commitment(&collection, owner, &identity)?;
            current().map_err(|_| {
                ControlError::new(
                    "unauthenticated",
                    "account_changed",
                    "current paired account required",
                )
            })?;
            ctx.cloud
                .enrol_private(&ctx.connector_id, &collection, &commit, &identity, &current)
                .await
        } else {
            ctx.cloud
                .join_cloud_copy(&ctx.connector_id, &collection, &identity, &current)
                .await
        }
        .map_err(cloud_refusal)?;
        let state = if p.private {
            mdbn_wire::policy::CState::E2e
        } else {
            mdbn_wire::policy::CState::CloudCopy
        };
        let (Some(log_url), Some(genesis)) =
            (joined.log_url.as_deref(), joined.genesis_item.as_deref())
        else {
            return Err(ControlError::unavailable(
                "control_plane_outdated",
                "the control plane did not return the collection's genesis",
            ));
        };
        current().map_err(|_| {
            ControlError::new(
                "unauthenticated",
                "account_changed",
                "account changed during join",
            )
        })?;
        if !folder_is_empty(&root)? {
            return Err(ControlError::invalid(
                "folder_not_empty",
                "the folder changed during enrolment; no local files were adopted",
            ));
        }
        self.write_link(&id, &collection, &trust, state, log_url, genesis)?;
        let name = p
            .name
            .as_deref()
            .map(display_name)
            .transpose()?
            .unwrap_or_else(|| {
                root.file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| root.display().to_string())
            });
        let entry = Entry {
            id: id.clone(),
            name,
            root,
            replica_id: secrets::new_uuid().map_err(|e| ControlError::internal(e.to_string()))?,
            mode: if p.private {
                SyncMode::SyncedE2e
            } else {
                SyncMode::Synced
            },
            origin: Origin::Joined,
            description: None,
            added_at_ms: fsutil::now_ms() as u64,
            paused: false,
            ever_e2e: p.private,
            owner_account: Some(secrets::uuid_string(&owner.0)),
            device: Some(secrets::uuid_string(&identity.device_id)),
        };
        let mut inner = self.inner.lock().await;
        current().map_err(|_| {
            ControlError::new(
                "unauthenticated",
                "account_changed",
                "account changed before registration",
            )
        })?;
        let mut next = inner.registry.clone();
        next.add(entry.clone()).map_err(registry_error)?;
        self.save_registry(&next)?;
        inner.registry = next;
        self.authority.publish_registry(&inner.registry);
        let host = CollectionHost::open(entry, self.host_ctx());
        host.publish_grants(&inner.access);
        let status = host.status();
        inner.hosts.push(host);
        drop(inner);
        self.bump();
        tracing::info!(collection = %status.id, "collection joined");
        to_value(&status)
    }

    /// A persisted SAS enrolment commitment, bound to this account incarnation.
    /// Retry the SAME enrolment after an unknown outcome; never overwrite its
    /// requester state with a different commitment. Renewal after a reveal is a
    /// separate logged approval-request, not a new enrolment.
    fn private_join_commitment(
        &self,
        collection: &[u8; 16],
        owner: mdbn_wire::common::B16,
        identity: &crate::secrets::DeviceIdentity,
    ) -> Result<[u8; 32], ControlError> {
        use crate::approval_journal::{JournalError, RequesterJournal};
        let changed = || {
            ControlError::new(
                "unauthenticated",
                "account_changed",
                "current paired account required",
            )
        };
        let inc = self.authority.incarnation().ok_or_else(changed)?;
        if inc.account != owner || inc.device.0 != identity.device_id {
            return Err(changed());
        }
        let public = identity.public();
        let key = |h: &str| -> Result<[u8; 32], ControlError> {
            secrets::hex_decode(h)
                .ok()
                .and_then(|b| <[u8; 32]>::try_from(b.as_slice()).ok())
                .ok_or_else(|| ControlError::internal("device public key"))
        };
        let me = mdbn_replica::crypto::keys::EnrolledKeys {
            device: mdbn_wire::common::B16(identity.device_id),
            sign_pk: key(&public.sign_pk)?,
            kem_pk: key(&public.kem_pk)?,
            noise_pk: key(&public.noise_pk)?,
        };
        let mut journal = RequesterJournal::new(
            self.secrets.clone(),
            *collection,
            inc.account.0,
            identity.device_id,
            inc.epoch,
        )
        .map_err(|e| match e {
            JournalError::BackendDenied => ControlError::unavailable(
                "credential_store_unsupported",
                "private collections need the OS keychain",
            ),
            _ => ControlError::internal("requester journal"),
        })?;
        let commit = journal
            .join_commitment(
                mdbn_wire::common::B16(*collection),
                me,
                &mut mdbn_local_host::OsEntropy,
            )
            .map_err(|_| {
                ControlError::unavailable(
                    "requester_state_uncertain",
                    "the enrolment state could not be restored or saved; restart the daemon and retry",
                )
            })?;
        if self.authority.incarnation() != Some(inc) {
            return Err(changed());
        }
        Ok(commit)
    }

    /// Turn sync on for a registered local collection. Connect creates the cloud
    /// copy (or private collection) from this device, the verified genesis is
    /// pinned, the local-only store is moved aside (never deleted), and the
    /// collection reopens synced.
    ///
    /// A folder with files is adopted: the inventory (record IDs,
    /// paths) is journaled before anything remote happens, and the synced runtime
    /// seals the folder as generation 0 with those IDs. Every step is resumable: a
    /// re-run after a crash continues from the journal, and a re-run once linked
    /// returns the status.
    /// A failed/unknown frozen capture is NOT a proven holds-only refusal.
    /// Close and retain the original entry paused before returning, without any
    /// journal/enrolment/Base. Even a registry write failure stays stopped in
    /// memory; save_registry also invalidates authority on uncertain durability.
    async fn retain_failed_capture(&self, id: &str) -> Result<(), ControlError> {
        let mut inner = self.inner.lock().await;
        inner
            .hosts
            .iter_mut()
            .find(|h| h.entry().id == id)
            .ok_or_else(|| ControlError::internal("registry and hosts disagree"))?
            .close()
            .await;
        let mut stopped = inner.registry.clone();
        let paused = stopped
            .get_mut(id)
            .ok_or_else(|| ControlError::internal("registry changed"))?;
        paused.paused = true;
        let paused = paused.clone();
        inner.registry = stopped;
        self.authority.publish_registry(&inner.registry);
        inner
            .hosts
            .iter_mut()
            .find(|h| h.entry().id == id)
            .ok_or_else(|| ControlError::internal("registry and hosts disagree"))?
            .set_entry(paused);
        self.save_registry(&inner.registry)
    }

    async fn enable_sync(&self, p: EnableSync) -> Result<Value, ControlError> {
        // Accepting takeover holds clears them: the takeover gate comes first, as
        // in a takeover run.
        let _takeover = if p.accept_takeover_holds {
            Some(self.takeover.run.lock().await)
        } else {
            None
        };
        let _gate = self.account_gate.lock().await;
        // Before anything else: a running old daemon could write the folder meanwhile.
        let taken_over = self
            .inner
            .lock()
            .await
            .registry
            .get(&p.collection)
            .is_some_and(|e| e.origin == crate::registry::Origin::MigratedLocal);
        if taken_over
            && self
                .takeover
                .old_running
                .load(std::sync::atomic::Ordering::SeqCst)
        {
            return Err(ControlError::unavailable(
                crate::collections::OLD_CONNECTOR_RUNNING,
                "the old mdbase Connect is running on this computer and could still change \
                 this folder; quit it (including its menu-bar or tray icon) or update it, \
                 then turn on sync",
            ));
        }
        let (ctx, trust) = self.sync_parts()?;
        let entry = self
            .inner
            .lock()
            .await
            .registry
            .get(&p.collection)
            .cloned()
            .ok_or_else(|| {
                ControlError::not_found(format!("no registered collection {}", p.collection))
            })?;
        let collections = self.profile.state_dir.join("collections");
        let journal_path = crate::adopt::Journal::path(&collections, &entry.id);
        let mut journal = crate::adopt::Journal::load(&journal_path)
            .map_err(|e| ControlError::internal(format!("adopt journal: {e}")))?;
        if entry.mode != SyncMode::Local {
            if journal.is_some() {
                // Linked; the synced runtime is adopting the folder.
                let inner = self.inner.lock().await;
                let host = inner
                    .hosts
                    .iter()
                    .find(|h| h.entry().id == entry.id)
                    .ok_or_else(|| ControlError::internal("registry and hosts disagree"))?;
                return to_value(&host.status());
            }
            return Err(ControlError::invalid(
                "already_synced",
                "this collection already syncs",
            ));
        }
        let collection = crate::attest::uuid_bytes(&entry.id)
            .ok_or_else(|| ControlError::internal("collection ID"))?;
        let source = self
            .authority
            .source(mdbn_wire::common::B16(collection))
            .map_err(|_| {
                ControlError::new(
                    "unauthenticated",
                    "account_changed",
                    "current paired account required",
                )
            })?;
        let owner = source.active_account().ok_or_else(|| {
            ControlError::new(
                "unauthenticated",
                "account_changed",
                "current paired account required",
            )
        })?;
        let current = || {
            source
                .active_account()
                .filter(|a| a == &owner)
                .map(|_| ())
                .ok_or_else(|| "account_changed".to_string())
        };
        if source.owner_identity().is_none() {
            return Err(ControlError::new(
                "unauthenticated",
                "registration_mismatch",
                "this account does not own the local registration",
            ));
        }
        let adopting = journal.is_some() || !local_bootstrap_folder_is_empty(&entry.root)?;
        let migrated = entry.origin == crate::registry::Origin::MigratedLocal;
        let e2e = match (&journal, p.mode) {
            (Some(j), asked) => {
                let started = j.mode == crate::adopt::Mode::Private;
                if asked.is_some_and(|m| (m == SyncMode::SyncedE2e) != started) {
                    return Err(ControlError::invalid(
                        "adopt_in_progress",
                        format!(
                            "turning sync on was started as {}; run it again with that mode",
                            if started { "private" } else { "cloud-copy" }
                        ),
                    ));
                }
                started
            }
            (None, Some(m)) => m == SyncMode::SyncedE2e,
            // Migrated local-authority collections, and folders with files, become
            // private unless the user asks for a cloud copy.
            (None, None) => adopting || migrated,
        };
        let mode = if e2e {
            SyncMode::SyncedE2e
        } else {
            SyncMode::Synced
        };
        let state = if e2e {
            mdbn_wire::policy::CState::E2e
        } else {
            mdbn_wire::policy::CState::CloudCopy
        };
        // Adopt: takeover holds first; then the serving local runtime is frozen
        // (writers fenced, inventory and hold counts taken at that one point,
        // stopped), so no acknowledged write or new hold can fall outside the plan.
        let inventory = if adopting && journal.is_none() {
            adopt_holds_refusal(
                &self.profile.state_dir,
                &entry.id,
                p.accept_takeover_holds,
                None,
            )?;
            let rt = {
                let inner = self.inner.lock().await;
                inner
                    .hosts
                    .iter()
                    .find(|h| h.entry().id == entry.id && h.is_serving())
                    .and_then(|h| h.runtime())
            }
            .ok_or_else(|| {
                ControlError::invalid(
                    "not_serving",
                    "the collection must be serving to turn sync on; resume it and run again",
                )
            })?;
            let Some(frozen) = rt.freeze().await else {
                self.retain_failed_capture(&entry.id).await?;
                return Err(ControlError::invalid(
                    "source_capture_incomplete",
                    "Source capture did not complete; the original collection remains paused. Resolve the incident or original pending outcome before resuming.",
                ));
            };
            let refused = adopt_holds_refusal(
                &self.profile.state_dir,
                &entry.id,
                true,
                Some((frozen.holds, frozen.unresolved)),
            )
            .err();
            if let Some(e) = refused {
                // A complete, known frozen capture was refused only for holds:
                // unlike failed/unknown capture, serving may safely resume.
                let mut inner = self.inner.lock().await;
                if let Some(host) = inner.hosts.iter_mut().find(|h| h.entry().id == entry.id) {
                    host.close().await;
                    host.set_entry(entry.clone());
                }
                return Err(e);
            }
            if p.accept_takeover_holds {
                // Explicitly accepted: this computer's versions stay, as with
                // keep_mine, and the holds are cleared.
                let paths = self.takeover_paths();
                let accepted: Vec<String> = crate::takeover::held::open(&paths.legacy, &entry.id)
                    .map_err(|e| ControlError::internal(format!("takeover holds: {e}")))?
                    .into_iter()
                    .map(|h| h.path)
                    .collect();
                if !accepted.is_empty() {
                    tracing::info!(collection = %entry.id, files = accepted.len(), "takeover holds accepted as this computer's versions");
                    crate::takeover::held::resolve(
                        &paths.record,
                        &paths.legacy,
                        &entry.id,
                        &accepted,
                    )
                    .map_err(|e| ControlError::internal(format!("takeover holds: {e}")))?;
                }
            }
            let (records, resources) = frozen.inventory;
            let records = if migrated {
                crate::adopt::prefer_legacy_ids(
                    records,
                    &crate::adopt::legacy_hints(&self.profile.state_dir, &entry.id),
                )
            } else {
                records
            };
            Some((records, resources))
        } else {
            None
        };
        // Join/retain-stop the old actor before enrolment; no local writer may
        // keep serving while bootstrap outcome is uncertain. Do not auto-resume.
        {
            let mut inner = self.inner.lock().await;
            let host = inner
                .hosts
                .iter_mut()
                .find(|h| h.entry().id == entry.id)
                .ok_or_else(|| ControlError::internal("registry and hosts disagree"))?;
            host.close().await;
            current().map_err(|_| {
                ControlError::new(
                    "unauthenticated",
                    "account_changed",
                    "account changed while stopping",
                )
            })?;
            // Durable retained stop BEFORE any uncertain remote/local change.
            // Restart must not auto-open a possibly moved local-only store.
            let mut stopped = inner.registry.clone();
            let paused = stopped
                .get_mut(&entry.id)
                .ok_or_else(|| ControlError::internal("registry changed"))?;
            paused.paused = true;
            let paused = paused.clone();
            self.save_registry(&stopped)?;
            inner.registry = stopped;
            self.authority.publish_registry(&inner.registry);
            inner
                .hosts
                .iter_mut()
                .find(|h| h.entry().id == entry.id)
                .ok_or_else(|| ControlError::internal("registry and hosts disagree"))?
                .set_entry(paused);
        }
        if let Some((records, resources)) = inventory {
            let j = crate::adopt::Journal {
                schema_version: crate::adopt::SCHEMA_VERSION,
                mode: if e2e {
                    crate::adopt::Mode::Private
                } else {
                    crate::adopt::Mode::CloudCopy
                },
                records: records
                    .iter()
                    .map(|(id, path)| (secrets::uuid_string(id), path.clone()))
                    .collect(),
                resources,
                created: None,
            };
            j.save(&journal_path)
                .map_err(|e| ControlError::internal(format!("adopt journal: {e}")))?;
            journal = Some(j);
        }
        if !adopting && !local_bootstrap_folder_is_empty(&entry.root)? {
            return Err(ControlError::invalid(
                "folder_not_empty",
                "the folder changed while stopping; run sync enable again to adopt it",
            ));
        }
        let created = match journal
            .as_ref()
            .and_then(|j| Some((j.created.clone()?, j.genesis()?)))
        {
            Some((c, genesis)) => (c.log_url, genesis),
            None => {
                let identity = self
                    .identity
                    .get()
                    .ok_or_else(|| {
                        ControlError::unavailable(
                            "device_identity_missing",
                            "keychain device unavailable",
                        )
                    })?
                    .clone();
                let created = if e2e {
                    ctx.cloud
                        .create_private(
                            &ctx.connector_id,
                            &collection,
                            &entry.name,
                            &identity,
                            &current,
                        )
                        .await
                } else {
                    ctx.cloud
                        .create_cloud_copy(&ctx.connector_id, &collection, &identity, &current)
                        .await
                }
                .map_err(cloud_refusal)?;
                current().map_err(|_| {
                    ControlError::new(
                        "unauthenticated",
                        "account_changed",
                        "account changed during bootstrap",
                    )
                })?;
                if created.collection_id != entry.id
                    || crate::trust::origin(&created.log_url).ok().as_deref()
                        != Some(trust.log_origin.as_str())
                {
                    return Err(ControlError::unavailable(
                        "sync_integrity",
                        "bootstrap response binding mismatch",
                    ));
                }
                // Authenticate the candidate BEFORE moving aside any local state.
                crate::sync::verify_genesis(&created.genesis_item, &collection, &trust, state)
                    .map_err(|e| ControlError::unavailable("sync_integrity", e.0))?;
                if let Some(j) = journal.as_mut() {
                    j.created = Some(crate::adopt::Created {
                        log_url: created.log_url.clone(),
                        genesis: crate::adopt::hex(&created.genesis_item),
                    });
                    j.save(&journal_path)
                        .map_err(|e| ControlError::internal(format!("adopt journal: {e}")))?;
                }
                (created.log_url, created.genesis_item)
            }
        };
        let (log_url, genesis) = created;
        if !adopting && !local_bootstrap_folder_is_empty(&entry.root)? {
            return Err(ControlError::invalid(
                "folder_not_empty",
                "the folder changed during bootstrap; run sync enable again to adopt it",
            ));
        }
        let mut inner = self.inner.lock().await;
        current().map_err(|_| {
            ControlError::new(
                "unauthenticated",
                "account_changed",
                "account changed before publication",
            )
        })?;
        // The local-only store is set aside, never deleted: a mistake must stay
        // recoverable (an adopted folder's inventory is already journaled).
        let dir = collections.join(&entry.id);
        if dir.exists() {
            let aside = collections.join(format!("{}.local-{}", entry.id, fsutil::now_ms()));
            std::fs::rename(&dir, &aside).map_err(|e| ControlError::internal(e.to_string()))?;
        }
        self.write_link(&entry.id, &collection, &trust, state, &log_url, &genesis)?;
        let mut next = inner.registry.clone();
        let updated = next
            .get_mut(&entry.id)
            .ok_or_else(|| ControlError::internal("registry changed"))?;
        updated.mode = mode;
        updated.ever_e2e |= e2e;
        updated.owner_account = Some(secrets::uuid_string(&owner.0));
        updated.paused = false;
        let updated = updated.clone();
        self.save_registry(&next)?;
        inner.registry = next;
        self.authority.publish_registry(&inner.registry);
        let host = inner
            .hosts
            .iter_mut()
            .find(|h| h.entry().id == entry.id)
            .ok_or_else(|| ControlError::internal("registry and hosts disagree"))?;
        host.set_entry(updated);
        let status = host.status();
        drop(inner);
        self.bump();
        tracing::info!(collection = %status.id, e2e, adopting, "sync enabled");
        to_value(&status)
    }

    async fn remove(&self, id: &str) -> Result<Value, ControlError> {
        let _gate = self.account_gate.lock().await;
        let mut inner = self.inner.lock().await;
        let mut next = inner.registry.clone();
        next.remove(id).map_err(registry_error)?;
        self.save_registry(&next)?;
        if let Err(e) = crate::adopt::Journal::remove(&crate::adopt::Journal::path(
            &self.profile.state_dir.join("collections"),
            id,
        )) {
            tracing::warn!(collection = %id, error = %e, "adopt journal not removed");
        }
        inner.registry = next;
        self.authority.publish_registry(&inner.registry);
        if !inner.access.list(Some(id)).is_empty() {
            let mut access = inner.access.clone();
            access.forget_collection(id);
            self.save_access(&mut inner, &access)?;
            inner.access = access;
            self.authority.publish_access(&inner.access);
            for h in &inner.hosts {
                h.publish_grants(&inner.access);
            }
        }
        if let Some(i) = inner.hosts.iter().position(|h| h.entry().id == id) {
            let mut host = inner.hosts.remove(i);
            host.close().await;
        }
        drop(inner);
        self.bump();
        tracing::info!(collection = %id, "collection unregistered (files untouched)");
        Ok(json!({}))
    }

    /// Account deletion is separate from local unregister: no local state changes.
    async fn delete_collection(&self, p: DeleteCollection) -> Result<Value, ControlError> {
        let collection =
            crate::attest::uuid_bytes(&p.collection.to_ascii_lowercase()).ok_or_else(|| {
                ControlError::invalid("invalid_collection", "the collection is a UUID")
            })?;
        let id = secrets::uuid_string(&collection);
        let _gate = self.account_gate.lock().await;
        let source = self
            .authority
            .source(mdbn_wire::common::B16(collection))
            .map_err(|_| {
                ControlError::new(
                    "unauthenticated",
                    "not_signed_in",
                    "sign this computer in first",
                )
            })?;
        let (ctx, _) = self.sync_parts()?;
        let current = || {
            source
                .active_account()
                .map(|_| ())
                .ok_or_else(|| "account_changed".to_string())
        };
        ctx.cloud
            .delete_collection(&id, &p.confirm_name, &current)
            .await
            .map_err(|e| {
                if matches!(&e, crate::cloud::CloudError::Network(_))
                    || matches!(&e, crate::cloud::CloudError::Server(_, code) if matches!(code.as_str(), "malformed" | "response_too_large"))
                {
                    return ControlError::unavailable(
                        "outcome_unknown",
                        "The deletion outcome is unknown. Check this collection in your account before taking further action; do not automatically retry.",
                    );
                }
                match e {
                    crate::cloud::CloudError::Server(409, code) if code == "device_not_enrolled" => {
                        ControlError::new(
                            "not_authorized",
                            &code,
                            "Join this collection on this computer first, then try again.",
                        )
                    }
                    crate::cloud::CloudError::Server(409, code)
                        if code == "collection_name_mismatch" =>
                    {
                        ControlError::invalid(
                            &code,
                            "The name you typed does not match this collection's name.",
                        )
                    }
                    crate::cloud::CloudError::Server(404, _) => {
                        ControlError::not_found("Collection not found.")
                    }
                    e => cloud_refusal(e),
                }
            })?;
        Ok(json!({ "collection_id": id, "deleted": true }))
    }

    async fn collection_name(&self, id: Option<&str>) -> Option<String> {
        let id = id?;
        let inner = self.inner.lock().await;
        inner.registry.get(id).map(|e| e.name.clone())
    }

    /// Log a successful control call that changed something.
    async fn note_control_call(&self, req: &Request, result: &Value, prior: Option<String>) {
        let prior = match prior {
            Some(n) => Some(n),
            None => {
                self.collection_name(result.get("collection").and_then(Value::as_str))
                    .await
            }
        };
        if let Some(e) = crate::activity::for_control_call(&req.method, &req.params, result, prior)
        {
            self.activity.record(e);
        }
    }

    /// Log an access change that came from the account (or a new request).
    async fn note_access_event(&self, event: &AccessEvent) {
        let (kind, collection, app) = match event {
            AccessEvent::NewAccess { entry } => (
                "app_connected",
                &entry.grant.collection,
                &entry.grant.app_name,
            ),
            AccessEvent::ApprovalRequested { entry } => (
                "app_requested",
                &entry.grant.collection,
                &entry.grant.app_name,
            ),
            AccessEvent::Revoked {
                collection,
                app_name,
                ..
            } => ("app_revoked_in_account", collection, app_name),
        };
        let mut e = crate::activity::ActivityEntry::now(kind);
        e.collection_name = self.collection_name(Some(collection)).await;
        e.collection = Some(collection.clone());
        e.app_name = Some(app.clone());
        self.activity.record(e);
    }

    /// Rename this computer in the account, then remember the stored name.
    async fn rename_computer(&self, name: &str) -> Result<Value, ControlError> {
        let name = checked_name(name, "a computer name")?;
        let _gate = self.account_gate.lock().await;
        let path = self.profile.cloud_file();
        let mut cfg = crate::cloud::CloudConfig::load(&path)
            .map_err(|e| ControlError::unavailable("account_state", e.to_string()))?
            .ok_or_else(|| {
                ControlError::new(
                    "unauthenticated",
                    "not_signed_in",
                    "sign this computer in first",
                )
            })?;
        let ctx = self.sync_ctx().ok_or_else(|| {
            ControlError::new(
                "unauthenticated",
                "not_signed_in",
                "sign this computer in first",
            )
        })?;
        let stored = ctx.cloud.rename_self(&name).await.map_err(|e| match e {
            crate::cloud::CloudError::Unauthenticated => {
                ControlError::new("unauthenticated", "authentication_required", e.to_string())
            }
            e => ControlError::unavailable("account_unreachable", e.to_string()),
        })?;
        cfg.computer_name = Some(stored.clone());
        cfg.save(&path)
            .map_err(|e| ControlError::unavailable("account_state", e.to_string()))?;
        drop(_gate);
        self.bump();
        Ok(json!({ "name": stored }))
    }

    async fn update_collection(&self, p: UpdateCollection) -> Result<Value, ControlError> {
        let name = p.name.as_deref().map(display_name).transpose()?;
        let description = p.description.as_deref().map(description_text).transpose()?;
        let _gate = self.account_gate.lock().await;
        let mut inner = self.inner.lock().await;
        let mut next = inner.registry.clone();
        let entry = next.get_mut(&p.collection).ok_or_else(|| {
            ControlError::not_found(format!("no registered collection {}", p.collection))
        })?;
        if let Some(name) = name {
            entry.name = name;
        }
        if let Some(description) = description {
            entry.description = description;
        }
        let entry = entry.clone();
        self.save_registry(&next)?;
        inner.registry = next;
        self.authority.publish_registry(&inner.registry);
        let host = inner
            .hosts
            .iter_mut()
            .find(|h| h.entry().id == p.collection)
            .ok_or_else(|| ControlError::internal("registry and hosts disagree"))?;
        host.set_entry(entry);
        let status = host.status();
        drop(inner);
        drop(_gate);
        self.bump();
        to_value(&status)
    }

    async fn set_paused(&self, id: &str, paused: bool) -> Result<Value, ControlError> {
        let _gate = self.account_gate.lock().await;
        let mut inner = self.inner.lock().await;
        let mut next = inner.registry.clone();
        let entry = next
            .get_mut(id)
            .ok_or_else(|| ControlError::not_found(format!("no registered collection {id}")))?;
        // An adopt stopped before Connect created anything is abandoned by resuming
        // locally; one whose log exists must be finished, not reopened local-only.
        if !paused && entry.mode == SyncMode::Local {
            let journal =
                crate::adopt::Journal::path(&self.profile.state_dir.join("collections"), &entry.id);
            match crate::adopt::Journal::load(&journal) {
                Ok(None) => {}
                Ok(Some(j)) if j.created.is_none() => crate::adopt::Journal::remove(&journal)
                    .map_err(|e| ControlError::internal(format!("adopt journal: {e}")))?,
                Ok(Some(_)) => {
                    return Err(ControlError::invalid(
                        "adopt_in_progress",
                        format!("sync is being turned on; run `mdbase sync enable {id}` to finish"),
                    ));
                }
                Err(e) => return Err(ControlError::internal(format!("adopt journal: {e}"))),
            }
        }
        entry.paused = paused;
        let entry = entry.clone();
        self.save_registry(&next)?;
        inner.registry = next;
        self.authority.publish_registry(&inner.registry);
        let host = inner
            .hosts
            .iter_mut()
            .find(|h| h.entry().id == id)
            .ok_or_else(|| ControlError::internal("registry and hosts disagree"))?;
        if paused {
            host.close().await;
        }
        host.set_entry(entry);
        let status = host.status();
        let barrier = (!paused).then(|| host.barrier()).flatten();
        drop(inner);
        drop(_gate);
        self.bump();
        if paused {
            return to_value(&status);
        }
        // Resume returns once the collection serves again (or settles in another
        // state), so an immediate `holds` or session never sees not_serving.
        if let Some(b) = barrier {
            let _ = tokio::time::timeout(RESUME_WAIT, b.wait()).await;
        }
        let deadline = tokio::time::Instant::now() + RESUME_WAIT;
        loop {
            let status = {
                let inner = self.inner.lock().await;
                let host = inner
                    .hosts
                    .iter()
                    .find(|h| h.entry().id == id)
                    .ok_or_else(|| {
                        ControlError::not_found(format!("no registered collection {id}"))
                    })?;
                host.status()
            };
            if status.state != crate::control::CollectionState::Opening
                || tokio::time::Instant::now() >= deadline
            {
                return to_value(&status);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// The takeover record, if readable (status decoration only).
    fn takeover_record(&self) -> Option<crate::takeover::record::Record> {
        crate::takeover::record::Record::load(&self.takeover_paths().record)
            .ok()
            .flatten()
    }

    fn takeover_paths(&self) -> crate::takeover::Paths {
        crate::takeover::Paths::new(&self.profile.state_dir, self.profile.store_ids_file())
    }

    /// Background takeover (startup, after sign-in): errors are logged and kept for
    /// `doctor`.
    async fn takeover_task(self: Arc<Self>, stop_mirrors: bool) {
        if let Err(e) = self.clone().takeover_run(stop_mirrors, true).await {
            tracing::warn!(error = %e.message, "local takeover did not run");
        }
        self.import_mirrors().await;
        self.auto_private().await;
    }

    /// Polling and the existing watch share one backoff. The run mutex also
    /// prevents concurrent polls (or focus events) from queuing rollout queries.
    async fn retry_takeover(self: Arc<Self>, refresh: bool) {
        let Ok(run) = self.takeover.run.try_lock() else {
            return;
        };
        let waiting = self
            .takeover
            .waiting_for_batch
            .load(std::sync::atomic::Ordering::Relaxed)
            || self
                .takeover_record()
                .is_some_and(|r| r.waiting_for_old_daemon());
        if !waiting
            || !self
                .takeover
                .retry
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .due(std::time::Instant::now(), refresh)
        {
            return;
        }
        let result = self.clone().takeover_run_locked(false, true).await;
        drop(run);
        if let Err(e) = result {
            tracing::warn!(error = %e.message, "local takeover retry did not run");
        }
        if !self
            .takeover
            .waiting_for_batch
            .load(std::sync::atomic::Ordering::Relaxed)
        {
            self.import_mirrors().await;
            self.auto_private().await;
        }
    }

    /// Turn Private sync on for taken-over collections that are still local
    /// (`auto_private`), so apps that reached them through mdbase Connect keep
    /// working. Runs after every takeover attempt (daemon start, sign-in, an
    /// explicit move) and after a held file is resolved. A pass that leaves
    /// collections waiting arms one retry timer with backoff.
    async fn auto_private(self: Arc<Self>) {
        if self.auto_private_pass().await.pending() {
            self.arm_auto_private_retry();
        }
    }

    fn spawn_auto_private(&self) {
        if let Some(d) = self.self_weak.get().and_then(std::sync::Weak::upgrade) {
            tokio::spawn(d.auto_private());
        }
    }

    fn arm_auto_private_retry(self: Arc<Self>) {
        use std::sync::atomic::Ordering;
        if self.auto_private.retrying.swap(true, Ordering::SeqCst) {
            return;
        }
        tokio::spawn(async move {
            let mut shutdown = self.shutdown.subscribe();
            let mut attempt = 0u32;
            loop {
                tokio::select! {
                    _ = tokio::time::sleep(crate::auto_private::backoff(attempt)) => {}
                    _ = shutdown.wait_for(|stop| *stop) => break,
                }
                if *self.shutdown.borrow() || !self.auto_private_pass().await.pending() {
                    break;
                }
                attempt = attempt.saturating_add(1);
            }
            self.auto_private.retrying.store(false, Ordering::SeqCst);
        });
    }

    /// One pass of [`Daemon::auto_private`]: each candidate goes through the
    /// ordinary `sync.enable` (Private for a taken-over collection; an
    /// interrupted adopt resumes from its journal). Held files are never accepted
    /// here. The pass never touches the takeover or the folder's bytes itself.
    async fn auto_private_pass(&self) -> crate::auto_private::Pass {
        use crate::auto_private as auto;
        let _pass = self.auto_private.pass.lock().await;
        let candidates = {
            let inner = self.inner.lock().await;
            auto::candidates(
                &inner.registry.collections,
                &self.profile.state_dir.join("collections"),
            )
        };
        if candidates.is_empty() || *self.shutdown.borrow() {
            return auto::run(
                &self.auto_private,
                candidates,
                |_| async { Ok(()) },
                || true,
            )
            .await;
        }
        if self.sync_ctx().is_none() {
            // Signing in runs another pass.
            auto::defer(&self.auto_private, &candidates, "not_signed_in");
            return auto::Pass::default();
        }
        // Only for an account already moved to the new sync engine (the same
        // answer that permitted the takeover). It also checks the server is
        // reachable before a step that stops serving the folder while it adopts.
        match self.takeover_rollout().await {
            crate::takeover::RolloutGate::Allowed => {}
            crate::takeover::RolloutGate::Unknown => {
                auto::defer(&self.auto_private, &candidates, "sync_unreachable");
                return auto::Pass {
                    enabled: Vec::new(),
                    failed: candidates
                        .into_iter()
                        .map(|id| (id, "sync_unreachable".to_owned()))
                        .collect(),
                };
            }
            crate::takeover::RolloutGate::Legacy => {
                auto::defer(&self.auto_private, &candidates, "account_not_ready");
                return auto::Pass::default();
            }
        }
        let pass = auto::run(
            &self.auto_private,
            candidates,
            |id| async move {
                let enabled = self
                    .enable_sync(EnableSync {
                        collection: id.clone(),
                        // Private for a taken-over collection, or the mode an
                        // interrupted adopt journal was started with.
                        mode: None,
                        accept_takeover_holds: false,
                    })
                    .await;
                match enabled {
                    Ok(status) => {
                        self.account_keys.wake();
                        let mut e = crate::activity::ActivityEntry::now("sync_enabled");
                        e.collection = Some(id.clone());
                        e.collection_name = status
                            .get("name")
                            .and_then(Value::as_str)
                            .map(str::to_owned);
                        e.detail = status
                            .get("mode")
                            .and_then(Value::as_str)
                            .map(str::to_owned);
                        self.activity.record(e);
                        tracing::info!(collection = %id, "sync turned on for a taken-over collection");
                        Ok(())
                    }
                    Err(e) => {
                        let why = e.reason.unwrap_or(e.code);
                        tracing::info!(collection = %id, reason = %why, "taken-over collection not synced yet; retried later");
                        Err(why)
                    }
                }
            },
            || *self.shutdown.borrow(),
        )
        .await;
        self.bump();
        pass
    }

    /// Import old hosted mirrors' captured unsent edits into their collections
    /// once those are registered here and serving (`takeover::mirror_import`).
    /// Each pass is idempotent; one that cannot finish (offline, not yet joined)
    /// is simply repeated later.
    async fn import_mirrors(&self) {
        use crate::takeover::mirror_import::{self, Capture, Progress};
        use crate::takeover::mirror_join;
        let paths = self.takeover_paths();
        let legacy = paths.legacy.clone();
        let Ok(ids) = mirror_import::captured(&legacy) else {
            return;
        };
        if ids.is_empty() {
            return;
        }
        // Only once the old engine is retired on this device: before that, an old
        // mirror could still upload the same edits itself.
        if !matches!(
            crate::takeover::record::Record::load(&paths.record),
            Ok(Some(r)) if r.state == crate::takeover::record::State::Complete
        ) {
            return;
        }
        for id in ids {
            // Bring the collection back here (the ordinary join), when due.
            let now = fsutil::now_ms() as u64;
            match mirror_join::step(&legacy, &id, &mut DaemonJoiner { d: self }, now).await {
                Ok(mirror_join::Step::Registered(_)) => {}
                Ok(mirror_join::Step::Removed) => continue,
                Ok(mirror_join::Step::Waiting { reason, .. }) => {
                    tracing::info!(collection = %id, %reason, "hosted collection not joined yet; its unsent edits stay captured");
                    continue;
                }
                Err(e) => {
                    tracing::warn!(collection = %id, error = %e, "joining the hosted collection paused; retried later");
                    continue;
                }
            }
            let complete = match (Capture::load(&legacy, &id), Progress::load(&legacy, &id)) {
                (Ok(Some(c)), Ok(p)) => p.complete(&c),
                _ => true, // unreadable: reported by status, never written over
            };
            if complete {
                continue;
            }
            let Ok(rt) = self.runtime_of(&id).await else {
                continue; // not caught up yet
            };
            if !self.mirror_cut_over(&legacy, &id).await {
                continue;
            }
            // Serialized with takeover runs and hold resolutions.
            let Ok(_run) = self.takeover.run.try_lock() else {
                continue;
            };
            let mut target = HostTarget { rt };
            match mirror_import::import(&legacy, &id, &mut target, &mut new_uuid_v7).await {
                Ok(pass) => {
                    if pass.settled > 0 {
                        tracing::info!(
                            collection = %id,
                            settled = pass.settled,
                            waiting = pass.waiting,
                            complete = pass.complete,
                            "unsent hosted mirror edits imported"
                        );
                        drop(_run);
                        self.bump();
                    }
                }
                Err(e) => {
                    tracing::warn!(collection = %id, error = %e, "unsent edit import paused; retried later")
                }
            }
        }
    }

    /// Whether a hosted collection's migration cutover is confirmed, so captured
    /// edits may be written to it. Checked once (then remembered), only for a
    /// collection that syncs with the hosted log, with backoff while pending.
    async fn mirror_cut_over(&self, legacy: &std::path::Path, id: &str) -> bool {
        use crate::takeover::mirror_join::{self, JoinState};
        let synced = {
            let inner = self.inner.lock().await;
            inner
                .registry
                .get(id)
                .is_some_and(|e| matches!(e.mode, SyncMode::Synced | SyncMode::SyncedE2e))
        };
        if !synced {
            return true;
        }
        let Ok(state) = JoinState::load(legacy, id) else {
            return false;
        };
        if state.cut_over {
            return true;
        }
        let now = fsutil::now_ms() as u64;
        if now < state.next_attempt_ms() {
            return false;
        }
        let reason = match self.read_migration_record(id).await {
            Ok(()) => return mirror_join::confirm_cut_over(legacy, id).is_ok(),
            Err(reason) => reason,
        };
        tracing::info!(collection = %id, %reason, "migration cutover not confirmed; unsent edits wait");
        let _ = mirror_join::cut_over_pending(legacy, id, &reason, now);
        false
    }

    /// Read the collection's migration record as this paired device. `Err` is a
    /// snake_case reason.
    async fn read_migration_record(&self, id: &str) -> Result<(), String> {
        let (ctx, _) = self.sync_parts().map_err(|e| e.reason.unwrap_or(e.code))?;
        let collection = crate::attest::uuid_bytes(id).ok_or("invalid_collection")?;
        let source = self
            .authority
            .source(mdbn_wire::common::B16(collection))
            .map_err(|_| "account_changed".to_string())?;
        let owner = source.active_account().ok_or("account_changed")?;
        let current = || {
            source
                .active_account()
                .filter(|a| a == &owner)
                .map(|_| ())
                .ok_or_else(|| "account_changed".to_string())
        };
        let tls = crate::cloud::tls_config().map_err(|_| "tls_unavailable".to_string())?;
        ctx.cloud
            .migration_record(&tls, id, id, &current)
            .await
            .map(|_| ())
            .map_err(|e| match e {
                crate::cloud::CloudError::Server(_, code) => code,
                crate::cloud::CloudError::Network(_) => "sync_unreachable".into(),
                crate::cloud::CloudError::Unauthenticated => "not_signed_in".into(),
                crate::cloud::CloudError::Local(m) => m,
            })
    }

    /// Ask the existing authenticated rollout endpoint, never infer permission
    /// from finding old state. Caller holds account_gate through the takeover.
    /// Also records whether the account is (still, or again) on legacy Connect,
    /// so status can say why nothing moved.
    async fn takeover_rollout(&self) -> crate::takeover::RolloutGate {
        use crate::takeover::RolloutGate;
        let Some(inc) = self.authority.incarnation() else {
            return RolloutGate::Unknown;
        };
        let Ok(Some(cfg)) = crate::cloud::CloudConfig::load(&self.profile.cloud_file()) else {
            return RolloutGate::Unknown;
        };
        let Ok(record) = crate::cloud::AccountRecord::load(&self.profile.account_file()) else {
            return RolloutGate::Unknown;
        };
        if !record.permits(&cfg)
            || record.active_account() != Some(inc.account)
            || record.epoch != inc.epoch
        {
            return RolloutGate::Unknown;
        }
        let Ok(tls) = crate::cloud::tls_config() else {
            return RolloutGate::Unknown;
        };
        let Ok(cloud) = crate::cloud::Cloud::new(&tls, &cfg.server_url, self.secrets.as_ref())
        else {
            return RolloutGate::Unknown;
        };
        let current = || {
            (self.authority.incarnation() == Some(inc))
                .then_some(())
                .ok_or_else(|| "account_changed".to_owned())
        };
        let gate = match cloud.rollout(&tls, &current).await {
            Ok(r) => RolloutGate::from_rollout(&r),
            Err(_) => RolloutGate::Unknown,
        };
        if gate != RolloutGate::Unknown {
            self.takeover.account_legacy.store(
                gate == RolloutGate::Legacy,
                std::sync::atomic::Ordering::Relaxed,
            );
        }
        gate
    }

    /// Run (or resume) the local takeover, then register what it took over.
    /// Every run requires fresh server permission before the old connector is
    /// touched: the server only retires it for an upgraded account.
    async fn takeover_run(
        self: Arc<Self>,
        stop_mirrors: bool,
        automatic: bool,
    ) -> Result<Value, ControlError> {
        let _run = self.takeover.run.lock().await;
        self.clone()
            .takeover_run_locked(stop_mirrors, automatic)
            .await
    }

    /// Caller holds `takeover.run`, including when retrying a waiting account.
    async fn takeover_run_locked(
        self: Arc<Self>,
        stop_mirrors: bool,
        automatic: bool,
    ) -> Result<Value, ControlError> {
        let Some(old) = crate::takeover::old_state_dir(&self.profile) else {
            return self.takeover_status().await;
        };
        if !old.join("connector.sqlite").is_file() && !self.takeover_paths().record.is_file() {
            return self.takeover_status().await;
        }
        let account_gate = self.account_gate.lock().await;
        let gate = self.takeover_rollout().await;
        if gate != crate::takeover::RolloutGate::Allowed {
            self.refence_old_service(old).await;
            let signed_in = self.authority.incarnation().is_some()
                && matches!(
                    crate::cloud::CloudConfig::load(&self.profile.cloud_file()),
                    Ok(Some(_))
                );
            let reason = if gate == crate::takeover::RolloutGate::Legacy {
                crate::takeover::WAIT_ACCOUNT_LEGACY
            } else if !signed_in {
                crate::takeover::WAIT_SIGN_IN
            } else {
                crate::takeover::WAIT_UNREACHABLE
            };
            *self
                .takeover
                .waiting_reason
                .lock()
                .unwrap_or_else(|p| p.into_inner()) = Some(reason);
            self.takeover
                .waiting_for_batch
                .store(true, std::sync::atomic::Ordering::Relaxed);
            self.takeover
                .retry
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .denied(std::time::Instant::now());
            if automatic {
                return self.takeover_status().await;
            }
            if reason == crate::takeover::WAIT_SIGN_IN {
                return Err(ControlError::new(
                    "unauthenticated",
                    "not_signed_in",
                    "Sign in to finish moving your collections (`mdbase account sign-in`). Nothing was changed.",
                ));
            }
            return Err(crate::takeover::not_allowed_error(
                gate == crate::takeover::RolloutGate::Legacy,
            ));
        }
        *self
            .takeover
            .waiting_reason
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = None;
        if self
            .takeover
            .waiting_for_batch
            .swap(false, std::sync::atomic::Ordering::Relaxed)
        {
            self.takeover
                .retry
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .reset();
        }
        let paths = self.takeover_paths();
        let isolated = self.profile.target == crate::paths::Target::IsolatedProfile;
        let opts = crate::takeover::Options {
            stop_mirrors,
            // Every run above passed fresh moved-account permission, including
            // an explicit retry. `automatic` changes refusal presentation only.
            account_moved: true,
            drain: crate::takeover::DRAIN,
            now: crate::takeover::now_rfc3339(),
        };
        let p2 = paths.clone();
        let _own = self.takeover.holding_old_lock();
        let ran = tokio::task::spawn_blocking(move || {
            let mut old_service: Box<dyn mdbn_takeover::OldService> = if isolated {
                Box::new(crate::service::legacy::ForegroundOldService(old.clone()))
            } else {
                Box::new(crate::service::legacy::OldConnectorService::new())
            };
            crate::takeover::run(&p2, &old, old_service.as_mut(), &opts)
        })
        .await
        .map_err(|e| ControlError::internal(e.to_string()))?;
        let ran = match ran {
            Ok(r) => {
                *self
                    .takeover
                    .error
                    .lock()
                    .unwrap_or_else(|p| p.into_inner()) = None;
                r
            }
            Err(e) => {
                *self
                    .takeover
                    .error
                    .lock()
                    .unwrap_or_else(|p| p.into_inner()) = Some(e.to_string());
                return Err(ControlError::unavailable("takeover_failed", e.to_string()));
            }
        };
        {
            let mut retry = self
                .takeover
                .retry
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            if ran
                .record
                .as_ref()
                .is_some_and(|r| r.waiting_for_old_daemon())
            {
                retry.denied(std::time::Instant::now());
            } else {
                retry.reset();
            }
        }
        self.takeover
            .revived
            .store(ran.revived, std::sync::atomic::Ordering::Relaxed);
        if ran.revived {
            tracing::error!(
                "old_connector_revived: the old mdbase Connect daemon is running again"
            );
        }
        // add() serializes registration with account changes itself.
        drop(account_gate);
        for t in &ran.register {
            let now = crate::takeover::now_rfc3339();
            let known = self
                .inner
                .lock()
                .await
                .registry
                .get(&t.collection)
                .is_some();
            let outcome = if known {
                Ok(())
            } else {
                self.add_with_pause(
                    AddCollection {
                        path: t.root.clone(),
                        name: Some(t.name.clone()),
                    },
                    t.paused,
                )
                .await
                .map(|_| ())
            };
            if outcome.is_ok() && !known {
                let mut e = crate::activity::ActivityEntry::now("collection_taken_over");
                e.collection = Some(t.collection.clone());
                e.collection_name = Some(t.name.clone());
                self.activity.record(e);
            }
            let saved = match outcome {
                Ok(()) => crate::takeover::mark_registered(&paths, &t.collection, &now),
                Err(e) => {
                    let why = e.reason.unwrap_or(e.code);
                    tracing::info!(collection = %t.collection, reason = %why, "taken-over collection not registered yet");
                    crate::takeover::note_registration(
                        &paths,
                        &t.collection,
                        &format!("registration_pending:{why}"),
                        &now,
                    )
                }
            };
            if let Err(e) = saved {
                tracing::warn!(error = %e, "takeover record not updated");
            }
        }
        self.retire_legacy().await;
        self.bump();
        self.takeover_status().await
    }

    /// Without a run, still keep a started takeover's old service stopped and
    /// report a revived old connector (the rollout gate only guards starting).
    async fn refence_old_service(&self, old: std::path::PathBuf) {
        let paths = self.takeover_paths();
        let isolated = self.profile.target == crate::paths::Target::IsolatedProfile;
        let fenced = tokio::task::spawn_blocking(move || {
            let mut old_service: Box<dyn mdbn_takeover::OldService> = if isolated {
                Box::new(crate::service::legacy::ForegroundOldService(old.clone()))
            } else {
                Box::new(crate::service::legacy::OldConnectorService::new())
            };
            crate::takeover::refence(&paths, &old, old_service.as_mut())
        })
        .await;
        match fenced {
            Ok(Ok(Some(revived))) => {
                self.takeover
                    .revived
                    .store(revived, std::sync::atomic::Ordering::Relaxed);
                if revived {
                    tracing::error!(
                        "old_connector_revived: the old mdbase Connect daemon is running again"
                    );
                }
            }
            Ok(Ok(None)) => {}
            Ok(Err(e)) => tracing::warn!(error = %e, "could not re-fence the old connector"),
            Err(e) => tracing::warn!(error = %e, "could not re-fence the old connector"),
        }
    }

    /// Full-device retirement is independent of takeover success: until Connect
    /// confirms the exact old connector, status stays pending, never synthetic.
    async fn retire_legacy(&self) {
        let result = self.retire_legacy_inner().await;
        let value = match result {
            Ok(id) => json!({"retired":true,"legacy_connector_id":id}),
            Err(reason) => json!({"retired":false,"reason":reason}),
        };
        *self
            .takeover
            .retirement
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some(value);
    }

    async fn retire_legacy_inner(&self) -> Result<String, &'static str> {
        let _account_gate = self.account_gate.lock().await;
        let inc = self
            .authority
            .incarnation()
            .ok_or("retirement_account_missing")?;
        let cfg = crate::cloud::CloudConfig::load(&self.profile.cloud_file())
            .map_err(|_| "retirement_account_missing")?
            .ok_or("retirement_account_missing")?;
        let record = crate::cloud::AccountRecord::load(&self.profile.account_file())
            .map_err(|_| "retirement_account_missing")?;
        if !record.permits(&cfg)
            || record.active_account() != Some(inc.account)
            || record.epoch != inc.epoch
        {
            return Err("retirement_account_changed");
        }
        let connector = cfg
            .connector_id
            .as_deref()
            .ok_or("current_connector_missing")?;
        let paths = self.takeover_paths();
        let plan = crate::takeover::retirement::Plan::capture(&paths, connector)?;
        let isolated = self.profile.target == crate::paths::Target::IsolatedProfile;
        let p2 = plan.clone();
        let paths2 = paths.clone();
        let connector2 = connector.to_owned();
        let _own = self.takeover.holding_old_lock();
        let locks = tokio::task::spawn_blocking(move || {
            if !isolated {
                crate::service::legacy::OldConnectorService::new()
                    .stop_and_disable()
                    .map_err(|_| "legacy_service_not_disabled")?;
            }
            let mut locks = vec![
                mdbn_legacy::lock::try_exclusive(&mdbn_legacy::lock::daemon_lock_path(
                    &p2.old_state_dir,
                ))
                .map_err(|_| "legacy_lock_unavailable")?
                .ok_or("old_connector_revived")?,
            ];
            for root in &p2.roots {
                locks.push(
                    mdbn_legacy::lock::try_exclusive(&mdbn_legacy::lock::write_lock_path(root))
                        .map_err(|_| "legacy_lock_unavailable")?
                        .ok_or("legacy_folder_busy")?,
                );
            }
            if !p2.still_current(&paths2, &connector2) {
                return Err("retirement_source_changed");
            }
            Ok::<_, &'static str>(locks)
        })
        .await
        .map_err(|_| "retirement_local_gate_failed")??;
        let current = || {
            if self.authority.incarnation() == Some(inc) && plan.still_current(&paths, connector) {
                Ok(())
            } else {
                Err("retirement_source_changed".into())
            }
        };
        let tls = crate::cloud::tls_config().map_err(|_| "retirement_endpoint_unavailable")?;
        let cloud = crate::cloud::Cloud::new(&tls, &cfg.server_url, self.secrets.as_ref())
            .map_err(|_| "retirement_account_missing")?;
        let result = cloud.retire_legacy_connector(&tls, &plan, &current).await;
        drop(locks);
        result.map_err(|e| match e {
            crate::cloud::CloudError::Server(404, _) | crate::cloud::CloudError::Network(_) => {
                "retirement_endpoint_unavailable"
            }
            _ => "retirement_not_confirmed",
        })?;
        Ok(plan.legacy_connector_id)
    }

    async fn takeover_status(&self) -> Result<Value, ControlError> {
        let paths = self.takeover_paths();
        let record = crate::takeover::record::Record::load(&paths.record)
            .map_err(|e| ControlError::internal(format!("takeover record: {e}")))?;
        let mut holds = serde_json::Map::new();
        if let Some(r) = &record {
            for id in r.collections.keys() {
                // Open ones only: resolved holds are gone from the list.
                if let Ok(open) = crate::takeover::held::open(&paths.legacy, id)
                    && !open.is_empty()
                {
                    let open: Vec<Value> = open
                        .iter()
                        .map(|h| json!({"id": h.id, "path": h.path, "reason": h.cause}))
                        .collect();
                    holds.insert(id.clone(), json!(open));
                }
            }
        }
        let mut mirror_imports = serde_json::Map::new();
        for id in crate::takeover::mirror_import::captured(&paths.legacy).unwrap_or_default() {
            let entry = match crate::takeover::mirror_import::status(&paths.legacy, &id) {
                Ok(Some(mut v)) => {
                    let inner = self.inner.lock().await;
                    let registered = inner.registry.get(&id);
                    v["registered"] = json!(registered.is_some());
                    v["join"] = crate::takeover::mirror_join::status(&paths.legacy, &id)
                        .unwrap_or_else(|e| json!({"state": "error", "reason": e.to_string()}));
                    if let Some(e) = registered {
                        v["name"] = json!(e.name);
                        v["root"] = json!(e.root);
                    }
                    v
                }
                Ok(None) => continue,
                Err(e) => json!({"error": e.to_string()}),
            };
            mirror_imports.insert(id, entry);
        }
        Ok(json!({
            "record": record,
            "mirror_imports": mirror_imports,
            "revived": self.takeover.revived.load(std::sync::atomic::Ordering::Relaxed),
            "error": self.takeover.error.lock().unwrap_or_else(|p| p.into_inner()).clone(),
            "holds": holds,
            "held_interrupted_writes": record.as_ref().map(|r| r.held_interrupted_writes()).unwrap_or(0),
            "waiting_for_migration_batch": self.takeover.waiting_for_batch.load(std::sync::atomic::Ordering::Relaxed),
            "waiting_reason": *self.takeover.waiting_reason.lock().unwrap_or_else(|p| p.into_inner()),
            "account_legacy": self.takeover.account_legacy.load(std::sync::atomic::Ordering::Relaxed),
            "retirement": self.takeover.retirement.lock().unwrap_or_else(|p| p.into_inner()).clone(),
            "private_sync_pending": self.private_sync_pending().await,
        }))
    }

    /// Taken-over collections still waiting for Private sync, each with its last
    /// attempt's refusal reason (`null` before the first attempt finishes).
    async fn private_sync_pending(&self) -> Value {
        let inner = self.inner.lock().await;
        let ids = crate::auto_private::candidates(
            &inner.registry.collections,
            &self.profile.state_dir.join("collections"),
        );
        drop(inner);
        Value::Object(
            ids.into_iter()
                .map(|id| {
                    let reason = self.auto_private.failure(&id);
                    (id, json!({ "reason": reason }))
                })
                .collect(),
        )
    }

    fn takeover_check(&self) -> Option<Check> {
        use crate::takeover::record::{CollectionState, Record, State};
        let record = match Record::load(&self.takeover_paths().record) {
            Ok(Some(r)) => r,
            Ok(None) => {
                let (detail, action) = crate::takeover::waiting_check_text(
                    *self
                        .takeover
                        .waiting_reason
                        .lock()
                        .unwrap_or_else(|p| p.into_inner()),
                );
                return self
                    .takeover
                    .waiting_for_batch
                    .load(std::sync::atomic::Ordering::Relaxed)
                    .then(|| Check {
                        id: "takeover".into(),
                        status: "warn".into(),
                        detail: detail.into(),
                        action: Some(action.into()),
                    });
            }
            Err(e) => {
                return Some(Check {
                    id: "takeover".into(),
                    status: "fail".into(),
                    detail: format!("the takeover record is unreadable: {e}"),
                    action: Some(
                        "Inspect takeover.json in the state directory; it was left unchanged."
                            .into(),
                    ),
                });
            }
        };
        let revived = self
            .takeover
            .revived
            .load(std::sync::atomic::Ordering::Relaxed);
        let waiting: Vec<String> = record
            .collections
            .iter()
            .filter(|(_, c)| !c.state.settled() && c.state != CollectionState::RolledBack)
            .map(|(id, c)| format!("{id} ({})", c.reason.as_deref().unwrap_or("pending")))
            .collect();
        let held = record.held_interrupted_writes();
        // Latched incidents, plus a live read (the record is only updated by runs).
        let paths = self.takeover_paths();
        let incidents: Vec<&String> = record
            .collections
            .iter()
            .filter(|(id, c)| {
                c.marker_incident
                    || (matches!(c.state, CollectionState::Complete | CollectionState::Held)
                        && c.reason.as_deref() != Some("folder_missing")
                        && crate::takeover::adapter::Evidence::load(&paths.legacy, id)
                            .ok()
                            .flatten()
                            .is_some_and(|e| {
                                !crate::takeover::marker_is_ours(&e.root, id, &paths.store_ids)
                                    .unwrap_or(false)
                            }))
            })
            .map(|(id, _)| id)
            .collect();
        let unregistered = record
            .collections
            .values()
            .filter(|c| {
                c.state.settled() && !c.registered && c.reason.as_deref() != Some("folder_missing")
            })
            .count();
        let ok = !revived
            && waiting.is_empty()
            && held == 0
            && unregistered == 0
            && incidents.is_empty();
        let mut detail = format!("takeover {:?}", record.state).to_lowercase();
        if self
            .takeover
            .waiting_for_batch
            .load(std::sync::atomic::Ordering::Relaxed)
        {
            let (waiting, _) = crate::takeover::waiting_check_text(
                *self
                    .takeover
                    .waiting_reason
                    .lock()
                    .unwrap_or_else(|p| p.into_inner()),
            );
            detail.push_str("; ");
            detail.push_str(waiting);
        }
        if revived {
            detail.push_str("; old_connector_revived");
        }
        if !incidents.is_empty() {
            detail.push_str(&format!(
                "; marker_incident: {}",
                incidents
                    .iter()
                    .map(|s| s.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        if !waiting.is_empty() {
            detail.push_str(&format!("; waiting: {}", waiting.join(", ")));
        }
        if held > 0 {
            detail.push_str(&format!(
                "; {held} interrupted legacy write/delete intent(s) held"
            ));
        }
        if unregistered > 0 {
            detail.push_str(&format!(
                "; {unregistered} collection(s) not registered yet"
            ));
        }
        Some(Check {
            id: "takeover".into(),
            status: if !incidents.is_empty() {
                "fail"
            } else if ok || record.state == State::RolledBack {
                "ok"
            } else {
                "warn"
            }
            .into(),
            detail,
            action: (!ok).then(|| {
                if !incidents.is_empty() {
                    "A taken-over folder lost its .mdbase/connect-role.json claim (or it was changed). \
                     Do not recreate it by hand: check whether the old mdbase Connect is running, then \
                     contact support with `mdbase migrate status --json`."
                        .into()
                } else if revived {
                    "The old mdbase Connect daemon is running again: quit or uninstall it, then run `mdbase migrate start`.".into()
                } else {
                    "Run `mdbase migrate status` for details; sign in if collections are waiting to register.".into()
                }
            }),
        })
    }

    async fn doctor(&self) -> Vec<Check> {
        let mut checks = Vec::new();
        let r = self.readiness.borrow().clone();
        let inner = self.inner.lock().await;
        checks.push(Check {
            id: "readiness".into(),
            status: if r.ready { "ok" } else { "fail" }.into(),
            detail: if r.ready {
                format!("ready, version {}", r.binary_version)
            } else {
                format!(
                    "not ready: {}",
                    inner
                        .init_error
                        .clone()
                        .unwrap_or_else(|| format!("{:?}", r.safe_reason))
                )
            },
            action: (!r.ready).then(|| match r.safe_reason {
                Some(NotReady::CredentialStoreUnavailable) => {
                    "Unlock the OS keychain (or Secret Service on Linux) and restart the daemon. \
                     Do not delete daemon.json."
                        .into()
                }
                Some(NotReady::InitializationFailed) => format!(
                    "Inspect {} (it was left unchanged), restore a backup, then restart.",
                    self.profile.registry_file().display()
                ),
                _ => "Wait, then run `mdbase daemon status` again.".into(),
            }),
        });
        checks.push(Check {
            id: "secret_backend".into(),
            status: if self.secrets.backend() == "keychain" {
                "ok"
            } else {
                "warn"
            }
            .into(),
            detail: format!("secrets are stored in: {}", self.secrets.backend()),
            action: (self.secrets.backend() != "keychain")
                .then(|| "Test-only backend; never use it for real collections.".into()),
        });
        checks.push(match &self.trust {
            Some(t) => Check {
                id: "trust".into(),
                status: "ok".into(),
                detail: format!("synced collections trust the {} service", t.environment),
                action: None,
            },
            None => Check {
                id: "trust".into(),
                status: "fail".into(),
                detail: "this build has no authenticated trust for synced collections".into(),
                action: Some(
                    "Update mdbase. Until then collections stay on this computer only and \
                     turning on sync refuses; your files are not affected."
                        .into(),
                ),
            },
        });
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&self.profile.state_dir)
                .map(|m| m.permissions().mode() & 0o777)
                .unwrap_or(0);
            checks.push(Check {
                id: "state_dir_private".into(),
                status: if mode == 0o700 { "ok" } else { "fail" }.into(),
                detail: format!("{} has mode {mode:o}", self.profile.state_dir.display()),
                action: (mode != 0o700).then(|| "chmod 700 the state directory.".into()),
            });
        }
        for h in &inner.hosts {
            let s = h.status();
            let (status, action) = match s.reason.as_deref() {
                Some("folder_missing") => (
                    "fail",
                    Some(
                        "Reconnect the folder's drive, or `mdbase collection remove`.".to_string(),
                    ),
                ),
                Some("joining_sync" | "detached_sync") => (
                    "warn",
                    Some("Keep the folder editable; join proof is pending. Abandon/rejoin must be explicit.".into()),
                ),
                Some("runtime_pending") => ("warn", None),
                _ => ("ok", None),
            };
            checks.push(Check {
                id: format!("collection:{}", s.id),
                status: status.into(),
                detail: format!(
                    "{} at {}: {:?}{}",
                    s.name,
                    s.root.display(),
                    s.state,
                    s.reason.map(|r| format!(" ({r})")).unwrap_or_default()
                ),
                action,
            });
            if let Some(c) = adopt_check(
                &self.profile.state_dir.join("collections"),
                h.entry(),
                self.auto_private.failure(&s.id),
                self.trust.is_some(),
            ) {
                checks.push(c);
            }
            if let Some(diagnostic) = h.mirror_diagnostic() {
                checks.push(Check {
                    id: format!("mirror_join:{}", s.id),
                    status: "warn".into(),
                    detail: diagnostic.message(),
                    action: None,
                });
            }
        }
        checks.extend(self.takeover_check());
        let profile = self.profile.clone();
        checks.push(
            tokio::task::spawn_blocking(move || crate::service::doctor_check(&profile))
                .await
                .unwrap_or_else(|e| Check {
                    id: "service".into(),
                    status: "warn".into(),
                    detail: format!("service check failed: {e}"),
                    action: None,
                }),
        );
        checks.push(crate::update::doctor_check(&r.binary_version));
        if self.profile.target == crate::paths::Target::InstalledService {
            use crate::takeover::record::Record;
            let fenced = Record::load(&self.takeover_paths().record)
                .ok()
                .flatten()
                .is_some_and(|rec| rec.state.fences_old_service());
            checks.push(loopback_check(fenced, CONNECTOR_LOOPBACK).await);
        }
        if let Some(retirement) = self
            .takeover
            .retirement
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
        {
            let retired = retirement["retired"] == true;
            checks.push(Check {
                id: "legacy_retirement".into(),
                status: if retired { "ok" } else { "warn" }.into(),
                detail: if retired { "legacy connector retirement confirmed".into() }
                    else { format!("legacy connector retirement pending ({})", retirement["reason"].as_str().unwrap_or("not_confirmed")) },
                action: (!retired).then(|| "Retirement is retried after a successful takeover run; it requires the exact full inventory and Connect endpoint availability.".into()),
            });
        }
        checks
    }
}

/// The old connector's browser port. The daemon serves it only after the takeover
/// fenced the old service, and never binds another port in its place.
const CONNECTOR_LOOPBACK: std::net::SocketAddr = std::net::SocketAddr::V4(
    std::net::SocketAddrV4::new(std::net::Ipv4Addr::LOCALHOST, 28485),
);

/// The `doctor` `loopback_port` check: a connect-only probe (never a bind, which could
/// race the port's owner). Held after the takeover fenced the old service means
/// something else, usually a revived old app, has it: `loopback_port_busy`.
async fn loopback_check(fenced: bool, addr: std::net::SocketAddr) -> Check {
    let held = matches!(
        tokio::time::timeout(
            Duration::from_millis(500),
            tokio::net::TcpStream::connect(addr)
        )
        .await,
        Ok(Ok(_))
    );
    let (status, detail, action) = match (held, fenced) {
        (true, true) => (
            "warn",
            format!("loopback_port_busy: {addr} is held by another process"),
            Some(format!(
                "Quit whatever holds port {} (usually the old mdbase Connect app); the daemon never serves browser apps on another port.",
                addr.port()
            )),
        ),
        (true, false) => (
            "ok",
            format!("{addr} is in use, as expected while today's mdbase Connect runs"),
            None,
        ),
        (false, _) => ("ok", format!("{addr} is free"), None),
    };
    Check {
        id: "loopback_port".into(),
        status: status.into(),
        detail,
        action,
    }
}

fn to_value<T: serde::Serialize>(v: &T) -> Result<Value, ControlError> {
    serde_json::to_value(v).map_err(|e| ControlError::internal(e.to_string()))
}

fn params<T: serde::de::DeserializeOwned>(req: &Request) -> Result<T, ControlError> {
    serde_json::from_value(req.params.clone())
        .map_err(|e| ControlError::invalid("invalid_params", format!("{}: {e}", req.method)))
}

/// A content-free projection of one hold.
fn hold_summary(h: &mdbn_wire::client::Hold) -> HoldSummary {
    use mdbn_wire::client::HoldReason;
    use mdbn_wire::snapshot::TextOrBlob;
    let reason = match h.reason {
        HoldReason::Conflict => "conflict",
        HoldReason::UnknownProvenance => "unknown_provenance",
        HoldReason::DeletedElsewhere => "deleted_elsewhere",
        HoldReason::ReadOnly => "read_only",
        HoldReason::EditorBusy => "editor_busy",
        HoldReason::SuspectWrite => "suspect_write",
    };
    HoldSummary {
        id: secrets::uuid_string(&h.id.0),
        path: h.path.clone(),
        reason: reason.into(),
        since: h.since,
        saves: h.saves,
        has_theirs: h.theirs.is_some(),
        binary: matches!(h.mine, TextOrBlob::Blob(_) | TextOrBlob::Attachment(_)),
    }
}

fn takeover_hold_summary(h: &crate::takeover::held::Held) -> HoldSummary {
    HoldSummary {
        id: h.id.clone(),
        path: h.path.clone(),
        reason: if h.unsent {
            crate::takeover::mirror_import::HOLD_REASON
        } else {
            crate::takeover::held::REASON
        }
        .into(),
        since: h.since,
        saves: 0,
        has_theirs: true,
        // An unsent edit is always text (other files were recovered instead).
        binary: (!h.unsent && !is_markdown_path(&h.path))
            || h.intended
                .as_ref()
                .is_some_and(|b| std::str::from_utf8(b).is_err()),
    }
}

fn is_markdown_path(path: &str) -> bool {
    path.rsplit_once('.')
        .is_some_and(|(_, ext)| ext.eq_ignore_ascii_case("md"))
}

/// A random UUIDv7 (ms timestamp, then random bits).
fn new_uuid_v7() -> [u8; 16] {
    let mut b = [0u8; 16];
    let _ = getrandom::fill(&mut b);
    let ms = (crate::fsutil::now_ms() as u64).to_be_bytes();
    b[..6].copy_from_slice(&ms[2..]);
    b[6] = (b[6] & 0x0f) | 0x70;
    b[8] = (b[8] & 0x3f) | 0x80;
    b
}

/// The record at `path` with its exact source, or `None`.
async fn record_at(
    rt: &Arc<crate::runtime::Runtime>,
    path: &str,
) -> Result<Option<mdbn_wire::client::RecordView>, ControlError> {
    use mdbn_wire::Wire;
    use mdbn_wire::cbor::Cbor;
    let include = mdbn_wire::client::Include {
        effective: None,
        body: None,
        document: Some(true),
        diagnostics: None,
    };
    let params = Cbor::Map(vec![
        (Cbor::Uint(0), Cbor::Text(path.into())),
        (Cbor::Uint(1), include.to_cbor()),
    ]);
    match host_call(rt, "get", params).await {
        Ok(v) => mdbn_wire::client::RecordView::from_cbor(&v)
            .map(Some)
            .map_err(|_| ControlError::internal("the replica's record does not decode")),
        Err(e) if e.code == "not_found" => Ok(None),
        Err(e) => Err(e),
    }
}

fn outcome_of(state: mdbn_wire::client::ReceiptState) -> crate::takeover::held::Outcome {
    use crate::takeover::held::Outcome;
    use mdbn_wire::client::ReceiptState;
    match state {
        ReceiptState::Pending => Outcome::Pending,
        ReceiptState::Confirmed => Outcome::Confirmed,
        ReceiptState::Unknown => Outcome::Unknown,
        ReceiptState::Rejected => Outcome::Rejected,
    }
}

/// Submit `ops` as the hosting app under `mutation` and wait for confirmation:
/// the receipt's outcome. A mutation the replica already has answers with its
/// original receipt; nothing is applied twice.
async fn submit_as(
    rt: &Arc<crate::runtime::Runtime>,
    ops: Vec<mdbn_wire::intent::Op>,
    mutation: [u8; 16],
) -> Result<crate::takeover::held::Outcome, ControlError> {
    use mdbn_wire::Wire;
    use mdbn_wire::client::{Receipt, SubmitParams, WaitFor};
    let submit = SubmitParams {
        ops,
        mutation_id: Some(mdbn_wire::common::B16(mutation)),
        conflict_mode: None,
        timezone: None,
        allow_partial: None,
        mutation_ids: None,
        dry_run: None,
        include: None,
        wait: Some(WaitFor::Confirmed),
    };
    let result = host_call(rt, "submit", submit.to_cbor()).await?;
    let receipts: Vec<Receipt> = Wire::from_cbor(&result)
        .map_err(|_| ControlError::internal("the replica's receipt does not decode"))?;
    let r = receipts
        .into_iter()
        .next()
        .ok_or_else(|| ControlError::internal("no receipt"))?;
    if r.mutation.0 != mutation {
        return Err(ControlError::internal(
            "the receipt is for another mutation",
        ));
    }
    Ok(outcome_of(r.state))
}

/// The outcome of `mutation` as the replica's receipt says, or `None` when the
/// replica has no receipt for it.
async fn read_back(
    rt: &Arc<crate::runtime::Runtime>,
    mutation: [u8; 16],
) -> Result<Option<crate::takeover::held::Outcome>, ControlError> {
    use mdbn_wire::Wire;
    use mdbn_wire::cbor::Cbor;
    use mdbn_wire::client::Receipt;
    let params = Cbor::Map(vec![(
        Cbor::Uint(0),
        mdbn_wire::common::B16(mutation).to_cbor(),
    )]);
    match host_call(rt, "receipt", params).await {
        Ok(v) => Receipt::from_cbor(&v)
            .map(|r| Some(outcome_of(r.state)))
            .map_err(|_| ControlError::internal("the replica's receipt does not decode")),
        Err(e) if e.code == "not_found" => Ok(None),
        Err(e) => Err(e),
    }
}

/// The device's own `collection.join`, as the mirror join drives it.
struct DaemonJoiner<'a> {
    d: &'a Daemon,
}

impl crate::takeover::mirror_join::Joiner for DaemonJoiner<'_> {
    async fn registered(&mut self, collection: &str) -> Option<std::path::PathBuf> {
        let inner = self.d.inner.lock().await;
        inner.registry.get(collection).map(|e| e.root.clone())
    }

    async fn join(
        &mut self,
        collection: &str,
        folder: &std::path::Path,
        name: &str,
    ) -> Result<(), crate::takeover::mirror_join::Refused> {
        self.d
            .join(JoinCollection {
                collection: collection.to_owned(),
                path: folder.to_path_buf(),
                name: Some(name.to_owned()),
                private: false,
            })
            .await
            .map(|_| ())
            .map_err(|e| crate::takeover::mirror_join::Refused(e.reason.unwrap_or(e.code)))
    }
}

/// The replica a mirror import writes to: a serving collection runtime, as the
/// hosting app (this device's own writes).
struct HostTarget {
    rt: Arc<crate::runtime::Runtime>,
}

fn import_io(e: ControlError) -> std::io::Error {
    std::io::Error::other(format!(
        "{}: {}",
        e.reason.as_deref().unwrap_or(&e.code),
        e.message
    ))
}

impl crate::takeover::mirror_import::Target for HostTarget {
    async fn get(
        &mut self,
        key: &str,
    ) -> std::io::Result<Option<crate::takeover::mirror_import::Current>> {
        use mdbn_wire::Wire;
        use mdbn_wire::cbor::Cbor;
        let include = mdbn_wire::client::Include {
            effective: None,
            body: None,
            document: Some(true),
            diagnostics: None,
        };
        let id = mdbn_legacy::is_uuid(key)
            .then(|| secrets::hex_decode(&key.replace('-', "")).ok())
            .flatten()
            .and_then(|v| <[u8; 16]>::try_from(v.as_slice()).ok());
        let reference = match id {
            Some(b) => mdbn_wire::common::B16(b).to_cbor(),
            None => Cbor::Text(key.into()),
        };
        let params = Cbor::Map(vec![
            (Cbor::Uint(0), reference),
            (Cbor::Uint(1), include.to_cbor()),
        ]);
        let view = match host_call(&self.rt, "get", params).await {
            Ok(v) => mdbn_wire::client::RecordView::from_cbor(&v)
                .map_err(|_| std::io::Error::other("the replica's record does not decode"))?,
            Err(e) if e.code == "not_found" => return Ok(None),
            Err(e) => return Err(import_io(e)),
        };
        let Some(document) = view.document else {
            return Err(std::io::Error::other("the replica returned no document"));
        };
        Ok(Some(crate::takeover::mirror_import::Current {
            id: view.id.0,
            path: view.path,
            revision: view.revision.0,
            document,
        }))
    }

    async fn submit(
        &mut self,
        ops: Vec<mdbn_wire::intent::Op>,
        mutation: [u8; 16],
    ) -> std::io::Result<crate::takeover::held::Outcome> {
        submit_as(&self.rt, ops, mutation).await.map_err(import_io)
    }

    async fn receipt(
        &mut self,
        mutation: [u8; 16],
    ) -> std::io::Result<Option<crate::takeover::held::Outcome>> {
        read_back(&self.rt, mutation).await.map_err(import_io)
    }
}

/// How long a one-shot host call may take.
const HOST_CALL_TIMEOUT: Duration = Duration::from_secs(20);
/// How long `collection.resume` waits for the collection to serve again.
const RESUME_WAIT: Duration = Duration::from_secs(30);
/// How often the daemon checks whether an old connector daemon has started.
const OLD_CONNECTOR_POLL: Duration = Duration::from_secs(5);

/// One client-API request on a collection's runtime as the hosting app: a
/// `SessionAuth::Host` session (the daemon is the host; no grant, so the mutation
/// is the user's own device's), one request, then the session closes. The
/// replica's problem becomes the control error (same codes, §9).
async fn host_call(
    rt: &Arc<crate::runtime::Runtime>,
    method: &str,
    params: mdbn_wire::cbor::Cbor,
) -> Result<mdbn_wire::cbor::Cbor, ControlError> {
    use mdbn_wire::Wire;
    use mdbn_wire::client::{ClientFrame, ClientRequest, HelloParams, Problem};
    use mdbn_wire::common::Version;
    let stopped = || ControlError::unavailable("runtime_stopped", "the collection stopped");
    let problem =
        |p: Problem| ControlError::new(&p.code, p.reason.as_deref().unwrap_or(&p.code), p.message);
    let hello = ClientRequest {
        id: 0,
        method: "hello".into(),
        params: HelloParams {
            versions: vec![Version { major: 1, minor: 0 }],
            client_name: "mdbase-daemon".into(),
            client_version: env!("CARGO_PKG_VERSION").into(),
            features: None,
            timezone: None,
        }
        .to_cbor(),
    };
    let bytes = ClientFrame::Request(hello)
        .to_bytes()
        .map_err(|_| ControlError::internal("hello does not encode"))?;
    let (session, resp, mut out) = rt
        .hello(mdbn_replica::api::SessionAuth::Host, bytes)
        .await
        .ok_or_else(stopped)?;
    let session = match (session, ClientFrame::from_bytes(&resp)) {
        (Some(s), Ok(ClientFrame::Response(r))) if r.problem.is_none() => s,
        (_, Ok(ClientFrame::Response(r))) => {
            return Err(r
                .problem
                .map(problem)
                .unwrap_or_else(|| ControlError::internal("host hello refused")));
        }
        _ => return Err(ControlError::internal("the replica answered hello badly")),
    };
    let req = ClientFrame::Request(ClientRequest {
        id: 1,
        method: method.into(),
        params,
    })
    .to_bytes()
    .map_err(|_| ControlError::internal("request does not encode"))?;
    let result = async {
        if !rt.frame(session, req) {
            return Err(stopped());
        }
        loop {
            let Some(b) = out.recv().await else {
                return Err(stopped());
            };
            if let Ok(ClientFrame::Response(r)) = ClientFrame::from_bytes(&b)
                && r.id == 1
            {
                return match (r.result, r.problem) {
                    (_, Some(p)) => Err(problem(p)),
                    (Some(v), None) => Ok(v),
                    (None, None) => Ok(mdbn_wire::cbor::Cbor::Null),
                };
            }
        }
    };
    let outcome = tokio::time::timeout(HOST_CALL_TIMEOUT, result)
        .await
        .unwrap_or_else(|_| {
            Err(ControlError::unavailable(
                "timeout",
                format!("{method} did not answer in time"),
            ))
        });
    rt.close(session);
    outcome
}

/// A Connect refusal as a control error (no secrets in messages).
fn cloud_refusal(e: crate::cloud::CloudError) -> ControlError {
    match e {
        crate::cloud::CloudError::Unauthenticated => ControlError::new(
            "unauthenticated",
            "not_signed_in",
            "sign this computer in again",
        ),
        crate::cloud::CloudError::Network(m) => ControlError::unavailable("sync_unreachable", m),
        other => ControlError::unavailable("sync_refused", other.to_string()),
    }
}

/// Strictly empty: hidden files/directories may contain user data too.
fn folder_is_empty(root: &std::path::Path) -> Result<bool, ControlError> {
    let mut it = std::fs::read_dir(root).map_err(|e| ControlError::internal(e.to_string()))?;
    match it.next() {
        None => Ok(true),
        Some(Ok(_)) => Ok(false),
        Some(Err(e)) => Err(ControlError::internal(e.to_string())),
    }
}

/// Only for an authenticated owner's EXISTING local registration: FileStore
/// creates the reserved private directory even for an empty folder. Permit its
/// empty directories and, directly inside it, the folder host lock's own regular
/// files (`host.lock`, `host.json`: a PID and a diagnostic descriptor, never user
/// data). Never other files, symlinks or arbitrary hidden user entries.
/// No file contents are read; inspection is bounded and failures deny.
/// Adopt is blocked while files the takeover held are unreviewed (the daemon
/// cannot resolve those; `accept` is the user's explicit review) and while the
/// local replica has holds or unresolved conflicts (`replica`: holds, conflicts).
fn adopt_holds_refusal(
    state_dir: &std::path::Path,
    id: &str,
    accept: bool,
    replica: Option<(u64, u64)>,
) -> Result<(), ControlError> {
    let held = crate::adopt::takeover_holds(state_dir, id)
        .map_err(|e| ControlError::internal(format!("takeover record: {e}")))?;
    if held > 0 && !accept {
        return Err(ControlError::invalid(
            "takeover_holds",
            format!(
                "{held} file(s) were held when this collection was taken over: the folder has \
                 this computer's version and mdbase kept the other. Review them with `mdbase \
                 holds {id}` and `mdbase resolve`, or accept this computer's versions with \
                 `mdbase sync enable {id} --accept-takeover-holds`"
            ),
        ));
    }
    if let Some((holds, conflicts)) = replica
        && (holds > 0 || conflicts > 0)
    {
        return Err(ControlError::invalid(
            "holds_pending",
            format!(
                "{holds} hold(s) and {conflicts} conflict(s) must be resolved first \
                 (`mdbase holds {id}`)"
            ),
        ));
    }
    Ok(())
}

/// A taken-over collection still waiting for Private sync (turned on by itself,
/// see `auto_private`; `failure` is its last attempt's refusal), or one whose
/// adopt is unfinished: what is happening and what to run.
fn adopt_check(
    collections: &std::path::Path,
    e: &crate::registry::Entry,
    failure: Option<String>,
    trusted: bool,
) -> Option<Check> {
    let journal = crate::adopt::Journal::path(collections, &e.id);
    let pending = journal.exists();
    let migrated = e.origin == crate::registry::Origin::MigratedLocal;
    if e.mode != SyncMode::Local {
        return pending.then(|| Check {
            id: format!("adopt:{}", e.id),
            status: "warn".into(),
            detail: format!("{}: turning sync on, the folder is being adopted", e.name),
            action: Some("Keep the daemon running; it continues after a restart.".into()),
        });
    }
    let why = failure
        .as_deref()
        .map(|r| format!(" ({}: {r})", crate::auto_private::explain(r)))
        .unwrap_or_default();
    // Without trust, `mdbase sync enable` refuses too: do not recommend it.
    if !trusted && (pending || (migrated && !e.paused)) {
        return Some(Check {
            id: format!("adopt:{}", e.id),
            status: "warn".into(),
            detail: if pending {
                format!(
                    "{}: turning sync on was interrupted; this build cannot sync{why}",
                    e.name
                )
            } else {
                format!(
                    "{}: taken over from mdbase Connect; Private sync is not on yet because this build cannot sync{why}",
                    e.name
                )
            },
            action: Some(
                "Update mdbase; it then turns on Private sync by itself. The folder stays on this \
                 computer and your files are not affected."
                    .into(),
            ),
        });
    }
    if pending {
        return Some(Check {
            id: format!("adopt:{}", e.id),
            status: "warn".into(),
            detail: format!("{}: turning sync on was interrupted{why}", e.name),
            action: Some(if migrated {
                format!(
                    "mdbase finishes it on its own when it starts and after sign-in; \
                     to finish now, run `mdbase sync enable {}`.",
                    e.id
                )
            } else {
                format!("Run `mdbase sync enable {}` to finish.", e.id)
            }),
        });
    }
    if !migrated {
        return None;
    }
    if e.paused {
        return Some(Check {
            id: format!("adopt:{}", e.id),
            status: "warn".into(),
            detail: format!("{}: taken over from mdbase Connect and paused", e.name),
            action: Some(
                "Resume it; mdbase then turns on Private sync so apps can reach it.".into(),
            ),
        });
    }
    Some(Check {
        id: format!("adopt:{}", e.id),
        status: "warn".into(),
        detail: format!(
            "{}: taken over from mdbase Connect; Private sync is not on yet{why}",
            e.name
        ),
        action: Some(format!(
            "mdbase turns it on by itself so apps that used it keep working, and retries \
             when it starts and after sign-in. To try now, run `mdbase sync enable {}`.",
            e.id
        )),
    })
}

/// A taken-over collection that is still local: say that Private sync turns on
/// by itself (and why it has not yet), and present a folder paused by an
/// interrupted attempt as that, not as a user pause.
fn with_private_sync_pending(
    mut s: CollectionStatus,
    auto: &crate::auto_private::State,
    collections: &std::path::Path,
) -> CollectionStatus {
    if s.origin != crate::registry::Origin::MigratedLocal || s.mode != SyncMode::Local {
        return s;
    }
    let journal = crate::adopt::Journal::path(collections, &s.id).exists();
    let paused = s.state == crate::control::CollectionState::Paused;
    if paused && !journal {
        return s; // paused by the user: resuming it turns sync on
    }
    if paused {
        s.reason = Some("private_sync_pending".into());
    }
    let message = match auto.failure(&s.id) {
        Some(why) => format!(
            "mdbase turns on Private sync for this collection so apps that used it with \
             mdbase Connect keep working. It has not finished yet: {}. mdbase tries again \
             on its own.",
            crate::auto_private::explain(&why)
        ),
        None => "mdbase is turning on Private sync for this collection so apps that used it \
                 with mdbase Connect keep working."
            .into(),
    };
    s.notices.push(Notice {
        code: "private_sync_pending".into(),
        message,
    });
    s
}

pub(crate) fn local_bootstrap_folder_is_empty(
    root: &std::path::Path,
) -> Result<bool, ControlError> {
    mdbn_local_host::host_lock::inspect_descriptor_directory(|| {
        let private = mdbn_platform_native::OpenOptions::default().private_dir;
        let mut stack = Vec::new();
        for entry in std::fs::read_dir(root).map_err(|e| ControlError::internal(e.to_string()))? {
            let entry = entry.map_err(|e| ControlError::internal(e.to_string()))?;
            if entry.file_name() != std::ffi::OsStr::new(&private)
                || !entry
                    .file_type()
                    .map_err(|e| ControlError::internal(e.to_string()))?
                    .is_dir()
            {
                return Ok(false);
            }
            stack.push((entry.path(), 0));
        }
        let mut count = 0;
        while let Some((dir, depth)) = stack.pop() {
            count += 1;
            if count > 64 || depth > 8 {
                return Ok(false);
            }
            for entry in
                std::fs::read_dir(dir).map_err(|e| ControlError::internal(e.to_string()))?
            {
                let entry = entry.map_err(|e| ControlError::internal(e.to_string()))?;
                // `DirEntry::file_type` does not follow symlinks.
                let kind = entry
                    .file_type()
                    .map_err(|e| ControlError::internal(e.to_string()))?;
                if depth == 0 && kind.is_file() && is_host_lock_file(&entry.file_name()) {
                    continue;
                }
                if !kind.is_dir() || stack.len() >= 64 {
                    return Ok(false);
                }
                stack.push((entry.path(), depth + 1));
            }
        }
        Ok(true)
    })
    .map_err(|_| ControlError::internal("host descriptor I/O unavailable"))?
}

/// The folder host lock's files in the private dir (mdbn-local-host): the lock
/// itself and its diagnostic descriptor. Every native host creates them on open.
fn is_host_lock_file(name: &std::ffi::OsStr) -> bool {
    use mdbn_local_host::host_lock::{DESCRIPTOR_NAME, LOCK_NAME};
    name == std::ffi::OsStr::new(LOCK_NAME) || name == std::ffi::OsStr::new(DESCRIPTOR_NAME)
}

fn registry_error(e: RegistryError) -> ControlError {
    match e {
        RegistryError::Rejected { reason, message } => match reason {
            "not_found" => ControlError::not_found(message),
            "duplicate_id" | "overlapping_root" => ControlError::new("conflict", reason, message),
            _ => ControlError::invalid(reason, message),
        },
        other => ControlError::internal(other.to_string()),
    }
}

fn canonical_dir(p: &std::path::Path) -> Result<std::path::PathBuf, ControlError> {
    let c = std::fs::canonicalize(p).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            ControlError::not_found(format!("{} does not exist", p.display()))
        } else {
            ControlError::invalid("unreadable_path", format!("{}: {e}", p.display()))
        }
    })?;
    if !c.is_dir() {
        return Err(ControlError::invalid(
            "not_a_directory",
            format!("{} is not a folder", p.display()),
        ));
    }
    Ok(strip_verbatim(c))
}

/// `\\?\C:\x` → `C:\x` (Windows `canonicalize` returns verbatim paths).
fn strip_verbatim(p: std::path::PathBuf) -> std::path::PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => std::path::PathBuf::from(rest),
        _ => p,
    }
}

/// Who manages a folder, from its role marker and `mdbase.yaml`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FolderClaim {
    /// Nobody: adopt it.
    Free,
    /// Claimed by this daemon (v2 marker naming a store ID it issued in
    /// `store-ids.json`, the takeover's `Daemon::store_id`).
    Ours {
        /// Collection ID (kept from Connect).
        collection: String,
        /// This daemon's store ID for it.
        replica_id: String,
    },
    /// Today's connector (a v1 marker, or a Connect identity in `mdbase.yaml` with no
    /// v2 claim): the takeover runs first.
    Connect(&'static str),
}

/// Classify a folder. A v2 claim by another runtime or device, or an invalid
/// marker, is refused (fail closed).
pub fn classify_folder(
    root: &std::path::Path,
    profile: &Profile,
) -> Result<FolderClaim, ControlError> {
    use mdbn_legacy::marker::{self, Marker};
    let m = marker::read(root)
        .map_err(|e| ControlError::invalid("unreadable_marker", e.to_string()))?;
    match m {
        Marker::Claimed {
            collection,
            replica_id,
        } => {
            let ids = crate::registry::StoreIds::load(&profile.store_ids_file())
                .map_err(|e| ControlError::internal(e.to_string()))?;
            if ids.get(&collection) == Some(replica_id.as_str()) {
                Ok(FolderClaim::Ours {
                    collection,
                    replica_id,
                })
            } else {
                Err(ControlError::new(
                    "conflict",
                    "claimed_by_other_replica",
                    "this folder is claimed by mdbase on another device or profile",
                ))
            }
        }
        Marker::Mirror { .. } => Ok(FolderClaim::Connect("hosted mirror marker")),
        Marker::Invalid(why) => Err(ControlError::invalid(
            "invalid_marker",
            format!("the folder's .mdbase/connect-role.json is invalid ({why})"),
        )),
        Marker::Absent => {
            let yaml = std::fs::read_to_string(root.join("mdbase.yaml")).unwrap_or_default();
            if yaml.contains("x-mdbase-connect") {
                Ok(FolderClaim::Connect("collection identity in mdbase.yaml"))
            } else {
                Ok(FolderClaim::Free)
            }
        }
    }
}

async fn serve_control(d: Arc<Daemon>, stream: BoxStream) -> std::io::Result<()> {
    let (mut rd, mut wr) = tokio::io::split(stream);
    let (tx, mut rx) = mpsc::channel::<Response>(64);
    let writer = tokio::spawn(async move {
        while let Some(resp) = rx.recv().await {
            let bytes = serde_json::to_vec(&resp).unwrap_or_default();
            if ipc::write_frame(&mut wr, &bytes).await.is_err() {
                break;
            }
        }
        let _ = wr.shutdown().await;
    });
    let mut subscription: Option<tokio::task::JoinHandle<()>> = None;
    let mut conn = ConnAuth::default();
    let mut stop = d.shutdown.subscribe();
    loop {
        let frame = tokio::select! {
            f = ipc::read_frame(&mut rd, ipc::MAX_CONTROL_FRAME) => f?,
            _ = async { let _ = stop.wait_for(|s| *s).await; } => None,
        };
        let Some(frame) = frame else { break };
        let req: Request = match serde_json::from_slice(&frame) {
            Ok(r) => r,
            Err(e) => {
                let _ = tx
                    .send(Response::err(
                        0,
                        ControlError::invalid("malformed_frame", e.to_string()),
                    ))
                    .await;
                break;
            }
        };
        if req.v != PROTOCOL {
            let _ = tx
                .send(Response::err(
                    req.id,
                    ControlError::new(
                        "upgrade_required",
                        "protocol_version",
                        format!(
                            "this daemon speaks control protocol {PROTOCOL}, not {}",
                            req.v
                        ),
                    ),
                ))
                .await;
            break;
        }
        let resp = match d.handle_and_note(&req, &mut conn).await {
            Ok(v) => Response::ok(req.id, v),
            Err(e) => Response::err(req.id, e),
        };
        if tx.send(resp).await.is_err() {
            break;
        }
        if req.method == Method::STATUS_SUBSCRIBE && subscription.is_none() {
            let d2 = d.clone();
            let tx2 = tx.clone();
            subscription = Some(tokio::spawn(async move {
                let mut changes = d2.changes.subscribe();
                let mut access = d2.access_events.subscribe();
                changes.mark_unchanged();
                loop {
                    let push = tokio::select! {
                        c = changes.changed() => {
                            if c.is_err() { break; }
                            let status = d2.status().await;
                            Response::push("status", serde_json::to_value(&status).unwrap_or_default())
                        }
                        e = access.recv() => match e {
                            Ok(ev) => Response::push("access", serde_json::to_value(&ev).unwrap_or_default()),
                            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                            Err(_) => break,
                        },
                    };
                    if tx2.send(push).await.is_err() {
                        break;
                    }
                }
            }));
        }
    }
    if let Some(s) = subscription {
        s.abort();
    }
    drop(tx);
    let _ = writer.await;
    Ok(())
}

fn access_error(e: crate::access::AccessError) -> ControlError {
    use crate::access::AccessError as E;
    match e {
        E::NotFound => ControlError::not_found("no such grant on this device"),
        E::WrongState(s) => ControlError::invalid("wrong_state", format!("the grant is {s:?}")),
        other => ControlError::internal(other.to_string()),
    }
}

/// Add the access-list notices for one collection.
/// Files held at the takeover count as holds: they are listed and resolved with
/// the replica's (`collection.holds`), and sync turns on once none are left.
fn with_takeover_holds(
    mut s: CollectionStatus,
    record: Option<&crate::takeover::record::Record>,
) -> CollectionStatus {
    let held = record
        .and_then(|r| r.collections.get(&s.id))
        .map_or(0, |c| c.holds);
    if held > 0 {
        if let Some(sync) = s.sync.as_mut() {
            sync.holds += held;
        }
        s.notices.push(Notice {
            code: "takeover_holds".into(),
            message: format!(
                "{held} file(s) were held when mdbase took over from the old connector: \
                 the folder has this computer's version and mdbase kept the other. \
                 Review them; Private sync turns on once they are resolved."
            ),
        });
    }
    s
}

fn with_access_notices(mut s: CollectionStatus, access: &AccessList) -> CollectionStatus {
    for e in access.list(Some(&s.id)) {
        let (code, verb) = match e.state {
            AccessState::Active if !e.acknowledged => ("app_access_added", "can now use"),
            AccessState::PendingApproval => ("app_access_pending", "asks to use"),
            _ => continue,
        };
        s.notices.push(Notice {
            code: code.into(),
            message: format!(
                "{} {verb} this collection ({}; key {}). Review with `mdbase access list`.",
                e.grant.app_name,
                e.grant.capabilities.join(", "),
                e.grant.fingerprint()
            ),
        });
    }
    s
}

/// The hosts to wait for after an access change.
struct GrantsBarrier(Vec<crate::collections::HostBarrier>);

impl GrantsBarrier {
    /// Wait until every host has re-checked its sessions, including runtimes
    /// still opening (see [`crate::collections::HostBarrier::wait`]).
    async fn wait(self) {
        for h in self.0 {
            h.wait().await;
        }
    }
}

/// Publish the access list's leases to every collection host. Call after the
/// authority has the new access list; await the result before acknowledging.
fn publish_grants(inner: &Inner) -> GrantsBarrier {
    GrantsBarrier(
        inner
            .hosts
            .iter()
            .inspect(|h| h.publish_grants(&inner.access))
            .filter_map(|h| h.barrier())
            .collect(),
    )
}

/// The only replica methods a localhost-link session may call (§12.4, allowlist):
/// data, holds, conflicts, files, presence and the editor fence. Anything
/// else, including device and grant approval, recovery, settings and any method
/// added later, is confirmed in the daemon's own UI and refused on the link.
pub const LINK_ALLOWED: &[&str] = &[
    "cancel",
    "submit",
    "await",
    "describe",
    "get",
    "query",
    "subscribe",
    "unsubscribe",
    "changes",
    "validate",
    "receipt",
    "get_status",
    "applied_prefix",
    "subscribe_status",
    "list_holds",
    "subscribe_holds",
    "resolve_hold",
    "list_conflicts",
    "subscribe_conflicts",
    "list_files",
    "get_file",
    "open_upload",
    "upload_chunk",
    "commit_upload",
    "abort_upload",
    "read_file",
    "ack_chunks",
    "fetch_file",
    "evict_file",
    "get_materialization",
    "set_materialization",
    "presence_join",
    "presence_update",
    "presence_leave",
    "subscribe_presence",
    "fence_report",
];

/// The keychain entry holding the link client key the user approved for a
/// collection (linked-client authorization).
fn link_client_secret(collection: &str) -> String {
    format!("link-client.{collection}")
}

/// Open a replica session on a runtime and bridge its frames to the transport.
async fn open_on_runtime(
    rt: Arc<crate::runtime::Runtime>,
    auth: mdbn_replica::api::SessionAuth,
    hello: mdbn_wire::client::ClientRequest,
    restricted: bool,
) -> crate::session::Opened {
    use crate::session::{Opened, SessionChannels, problem_response};
    use mdbn_wire::Wire;
    use mdbn_wire::client::ClientFrame;
    let id = hello.id;
    let Ok(bytes) = ClientFrame::Request(hello).to_bytes() else {
        return Opened {
            response: problem_response(id, "invalid_request", "bad_hello", "hello does not encode"),
            session: None,
        };
    };
    let Some((session, resp, mut out)) = rt.hello(auth, bytes).await else {
        return Opened {
            response: problem_response(
                id,
                "unavailable",
                "runtime_stopped",
                "the collection stopped",
            ),
            session: None,
        };
    };
    let response = match ClientFrame::from_bytes(&resp) {
        Ok(ClientFrame::Response(r)) => r,
        _ => problem_response(id, "internal", "bad_response", "the replica answered badly"),
    };
    let Some(session) = session else {
        return Opened {
            response,
            session: None,
        };
    };
    let (in_tx, mut in_rx) = mpsc::channel::<ClientFrame>(64);
    let (out_tx, out_rx) = mpsc::channel::<ClientFrame>(64);
    let rt2 = rt.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                f = in_rx.recv() => match f {
                    Some(ClientFrame::Request(r)) if restricted && !LINK_ALLOWED.contains(&r.method.as_str()) => {
                        let resp = crate::session::problem_response(
                            r.id,
                            "forbidden",
                            "confirm_in_daemon_ui",
                            "approvals and recovery are confirmed in mdbase's own window",
                        );
                        if out_tx.send(ClientFrame::Response(resp)).await.is_err() { break; }
                    }
                    Some(f) => match f.to_bytes() {
                        Ok(b) => { if !rt2.frame(session, b) { break; } }
                        Err(_) => break,
                    },
                    None => break,
                },
                b = out.recv() => match b {
                    Some(b) => match ClientFrame::from_bytes(&b) {
                        Ok(f) => { if out_tx.send(f).await.is_err() { break; } }
                        Err(_) => break,
                    },
                    None => break,
                },
            }
        }
        rt2.close(session);
    });
    Opened {
        response,
        session: Some(SessionChannels {
            inbound: in_tx,
            outbound: out_rx,
        }),
    }
}

/// Per-connection caller authentication.
#[derive(Default)]
struct ConnAuth {
    nonce: Option<[u8; 32]>,
    privileged: bool,
}

fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}
impl crate::session::Handler for Daemon {
    fn open<'a>(
        &'a self,
        prologue: crate::session::Prologue,
        auth: crate::session::Auth,
        hello: mdbn_wire::client::ClientRequest,
    ) -> crate::session::BoxFuture<'a, crate::session::Opened> {
        use crate::session::{Opened, problem_response};
        Box::pin(async move {
            let id = secrets::uuid_string(&prologue.collection);
            let refuse = |code: &str, reason: &str, message: &str| Opened {
                response: problem_response(hello.id, code, reason, message),
                session: None,
            };
            if !self.is_ready() {
                return refuse("unavailable", "not_ready", "the daemon is not ready");
            }
            // the hosting app proves the keychain-derived host key. Any
            // other process of the user must hold a grant, so its writes are
            // attributed to that grant. Checked before the collection lookup so a
            // keyless process learns nothing about which collections are hosted.
            if let crate::session::Auth::Host { client_pk } = auth {
                let ok = self.control_key.get().is_some_and(|k| {
                    crate::noise::public_key(&secrets::host_noise_secret(k)) == client_pk
                });
                if !ok {
                    return refuse(
                        "forbidden",
                        "host_key_required",
                        "a session without a grant needs this computer's host key",
                    );
                }
            }
            let inner = self.inner.lock().await;
            let Some(host) = inner.hosts.iter().find(|h| h.entry().id == id) else {
                return refuse(
                    "not_found",
                    "unknown_collection",
                    "this daemon does not host that collection",
                );
            };
            let source = match self
                .authority
                .source(mdbn_wire::common::B16(prologue.collection))
            {
                Ok(source) => source,
                Err(reason) => {
                    return refuse(
                        "forbidden",
                        reason.reason(),
                        "no authenticated collection authority",
                    );
                }
            };
            // Synced authority belongs to the verified replica policy, never owner metadata.
            if host.entry().mode == SyncMode::Local
                && let Err(reason) = source.authorize(None)
            {
                return refuse(
                    "forbidden",
                    reason.reason(),
                    "collection is not authorized for this account",
                );
            }
            if let crate::session::Auth::Grant { grant, .. } = auth
                && host.entry().mode == SyncMode::Local
                && inner.access.lease_live(&id, fsutil::now_ms() as u64)
                && source.grant(&mdbn_wire::common::B16(grant)).is_none()
            {
                return refuse(
                    "forbidden",
                    "grant_account_mismatch",
                    "grant account is not authorized here",
                );
            }
            let replica_auth = match auth {
                // the host key was checked above, before the lookup.
                crate::session::Auth::Host { .. } => mdbn_replica::api::SessionAuth::Host,
                // The Obsidian runtime on a collection the user linked (§12.4):
                // its key was checked against the keychain below.
                crate::session::Auth::Link { .. } => mdbn_replica::api::SessionAuth::Host,
                // Local collections: the session's grant must match an active entry
                // of the access list under a live lease. Synced
                // collections check grants against the log's policy in the replica.
                crate::session::Auth::Grant { grant, client_pk } => {
                    if host.entry().mode == SyncMode::Local
                        && let Err(r) = inner.access.authorize(
                            &id,
                            &secrets::uuid_string(&grant),
                            &client_pk,
                            fsutil::now_ms() as u64,
                        )
                    {
                        return refuse(
                            "forbidden",
                            r.reason(),
                            "this app has no active access here",
                        );
                    }
                    mdbn_replica::api::SessionAuth::Grant {
                        grant: mdbn_wire::common::B16(grant),
                        client_pk,
                    }
                }
            };
            let (true, Some(rt)) = (host.is_serving(), host.runtime()) else {
                let s = host.status();
                return refuse(
                    "unavailable",
                    s.reason.as_deref().unwrap_or("not_serving"),
                    "the collection is not being served",
                );
            };
            let name = host.entry().name.clone();
            drop(inner);
            if let crate::session::Auth::Link { client_pk } = auth
                && let Err(e) = self.link_authorized(&id, &name, &client_pk).await
            {
                return refuse(
                    &e.code,
                    e.reason.as_deref().unwrap_or("link_not_approved"),
                    &e.message,
                );
            }
            let restricted = matches!(auth, crate::session::Auth::Link { .. });
            open_on_runtime(rt, replica_auth, hello, restricted).await
        })
    }
}

impl Daemon {
    fn set_account_error(&self, e: &str) {
        self.account
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .last_error = Some(e.to_string());
        self.bump();
    }

    /// Inventory entries for the account (local collections only).
    async fn inventory_entries(&self) -> Vec<(String, Value)> {
        let inner = self.inner.lock().await;
        inner
            .registry
            .collections
            .iter()
            .filter(|e| e.mode == SyncMode::Local)
            .map(|e| {
                (
                    e.id.clone(),
                    json!({
                        "id": e.id,
                        "display_name": e.name,
                        "spec_version": spec_version(&e.root),
                        "enabled": !e.paused,
                        "contracts": [],
                    }),
                )
            })
            .collect()
    }
}

/// A collection display name: trimmed, 1 to 100 characters, no control characters
/// (it is shown on approval screens and in the account).
fn display_name(value: &str) -> Result<String, ControlError> {
    checked_name(value, "a collection name")
}

/// A name shown to people (collection or computer): trimmed, 1 to 100 characters,
/// no control or direction-changing characters.
fn checked_name(value: &str, what: &str) -> Result<String, ControlError> {
    let v = value.trim();
    if v.is_empty()
        || v.chars().count() > 100
        || v.chars().any(|c| c.is_control() || is_bidi_control(c))
    {
        return Err(ControlError::invalid(
            "name",
            format!(
                "{what} is 1 to 100 characters, without control or direction-changing characters"
            ),
        ));
    }
    Ok(v.to_string())
}

/// Bidirectional formatting characters, which can make a name read differently
/// from what it is.
fn is_bidi_control(c: char) -> bool {
    matches!(c, '\u{061C}' | '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
}

/// A description: trimmed, at most 500 characters; empty clears it. Line breaks
/// and tabs are allowed, other control characters are not.
fn description_text(value: &str) -> Result<Option<String>, ControlError> {
    let v = value.trim();
    if v.chars().count() > 500
        || v.chars()
            .any(|c| (c.is_control() && !matches!(c, '\n' | '\t')) || is_bidi_control(c))
    {
        return Err(ControlError::invalid(
            "description",
            "a description is at most 500 characters",
        ));
    }
    Ok((!v.is_empty()).then(|| v.to_string()))
}

/// The collection's `spec_version` from `mdbase.yaml`, for the inventory.
fn spec_version(root: &std::path::Path) -> String {
    std::fs::read_to_string(root.join("mdbase.yaml"))
        .ok()
        .and_then(|y| {
            y.lines().find_map(|l| {
                l.strip_prefix("spec_version:")
                    .map(|v| v.trim().trim_matches(['"', '\'']).to_string())
            })
        })
        .filter(|v| !v.is_empty() && v.len() <= 30)
        .unwrap_or_else(|| "0.3.0".into())
}

struct NativeGrantWaitContext {
    entry: AccessEntry,
    incarnation: crate::authority::Incarnation,
    deadline: std::time::Instant,
    runtime: Arc<crate::runtime::Runtime>,
}

impl crate::relay::RelayHost for Daemon {
    fn inventory(&self) -> crate::session::BoxFuture<'_, Vec<(String, Value)>> {
        Box::pin(self.inventory_entries())
    }

    fn policy_cursor(&self) -> crate::session::BoxFuture<'_, Option<crate::access::FeedCursor>> {
        Box::pin(async move { self.inner.lock().await.access.feed_cursor.clone() })
    }

    fn commit_feed<'a>(
        &'a self,
        snapshot: &'a crate::relay::Snapshot,
        grants: &'a std::collections::BTreeMap<String, Vec<CachedGrant>>,
    ) -> crate::session::BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            self.commit_control_plane_feed(snapshot, grants)
                .await
                .map_err(|e| e.message)
        })
    }

    fn grant_live<'a>(
        &'a self,
        collection: &'a str,
        grant: &'a str,
    ) -> crate::session::BoxFuture<'a, bool> {
        Box::pin(async move {
            // Synced end-to-end collections: the replica's log policy decides,
            // and a local refusal on this device cuts the pipe at once.
            let (mode, refused) = {
                let inner = self.inner.lock().await;
                let mode = inner.registry.get(collection).map(|c| c.mode);
                let refused = inner.access.entries.iter().any(|e| {
                    e.grant.grant == grant && e.grant.collection == collection && e.is_refused()
                });
                (mode, refused)
            };
            if mode == Some(SyncMode::SyncedE2e) {
                if refused {
                    return false;
                }
                let Some(grant16) = crate::attest::uuid_bytes(grant) else {
                    return false;
                };
                let Some(rt) = self.collection_runtime(collection).await else {
                    return false;
                };
                return matches!(
                    rt.grant_approval(crate::runtime::GrantApprovalOp::Effective(
                        mdbn_wire::common::B16(grant16),
                    ))
                    .await,
                    Some(crate::runtime::GrantApprovalReply::Effective(true))
                );
            }
            self.inner
                .lock()
                .await
                .access
                .grant_live(collection, grant, fsutil::now_ms() as u64)
        })
    }

    fn grant_activation<'a>(
        self: &'a Arc<Self>,
        collection: &'a str,
        grant: &'a str,
    ) -> crate::session::BoxFuture<'a, Option<crate::relay::GrantActivation>> {
        Box::pin(async move {
            let NativeGrantWaitContext {
                entry: expected,
                incarnation,
                deadline: lease_deadline,
                runtime,
            } = self.native_grant_wait_consent(collection, grant).await?;
            let grant16 = crate::attest::uuid_bytes(grant)?;
            // Capture subscriptions and immutable context BEFORE task spawning.
            let mut policy_changes = runtime.grant_policy_changes();
            let mut authority_changes = self.changes.subscribe();
            let (daemon, col, gid, entry, original_runtime) = (
                self.clone(),
                collection.to_owned(),
                grant.to_owned(),
                expected.clone(),
                runtime.clone(),
            );
            let current: crate::relay::GrantActivationGuard = Arc::new(move || {
                let (d, c, g, e, r) = (
                    daemon.clone(),
                    col.clone(),
                    gid.clone(),
                    entry.clone(),
                    original_runtime.clone(),
                );
                Box::pin(async move {
                    if std::time::Instant::now() >= lease_deadline
                        || d.authority.incarnation() != Some(incarnation)
                    {
                        return false;
                    }
                    let consent = d.native_grant_wait_consent(&c, &g).await;
                    consent.is_some_and(|actual| {
                        actual.entry == e
                            && actual.incarnation == incarnation
                            && Arc::ptr_eq(&actual.runtime, &r)
                            && std::time::Instant::now() < lease_deadline
                            && d.authority.incarnation() == Some(incarnation)
                    })
                })
            });
            if !current().await {
                return None;
            }
            let wait_current = current.clone();
            let wait = Box::pin(async move {
                loop {
                    if !wait_current().await {
                        return false;
                    }
                    let state = runtime
                        .grant_approval(crate::runtime::GrantApprovalOp::State(
                            mdbn_wire::common::B16(grant16),
                        ))
                        .await;
                    // Fence this await BEFORE asking the next authoritative query.
                    if !wait_current().await {
                        return false;
                    }
                    match state {
                        Some(crate::runtime::GrantApprovalReply::State(Some(state))) => {
                            let pk = crate::secrets::hex_decode(&expected.grant.client_pk)
                                .ok()
                                .and_then(|b| <[u8; 32]>::try_from(b).ok());
                            if !state.active
                                || state.failure.is_some()
                                || pk != Some(state.client_pk)
                                || !expected
                                    .grant
                                    .capabilities
                                    .iter()
                                    .all(|c| state.capabilities.contains(c))
                            {
                                return false;
                            }
                        }
                        Some(crate::runtime::GrantApprovalReply::State(None)) => {}
                        _ => return false,
                    }
                    let effective = runtime
                        .grant_approval(crate::runtime::GrantApprovalOp::Effective(
                            mdbn_wire::common::B16(grant16),
                        ))
                        .await;
                    // A positive reply cannot outlive the captured lease, epoch,
                    // consent generation or runtime, even across lease renewal.
                    if !wait_current().await {
                        return false;
                    }
                    match effective {
                        Some(crate::runtime::GrantApprovalReply::Effective(true)) => return true,
                        Some(crate::runtime::GrantApprovalReply::Effective(false)) => {}
                        _ => return false,
                    }
                    tokio::select! {
                        result = policy_changes.changed() => if result.is_err() { return false },
                        result = authority_changes.changed() => if result.is_err() { return false },
                        _ = tokio::time::sleep_until(tokio::time::Instant::from_std(lease_deadline)) => return false,
                    }
                }
            });
            Some(crate::relay::GrantActivation { current, wait })
        })
    }

    fn set_online(&self, online: bool) {
        self.online
            .store(online, std::sync::atomic::Ordering::Relaxed);
        if online {
            self.account
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .last_error = None;
        }
        self.bump();
    }

    fn old_connector_running(&self) -> bool {
        self.takeover
            .old_running
            .load(std::sync::atomic::Ordering::SeqCst)
    }
}

impl Daemon {
    /// Ask the control plane to revoke a grant the user refused here, so it leaves
    /// the feed. Best effort: the local refusal already holds (sticky tombstone).
    fn revoke_upstream(&self, grant: String) {
        let Ok(Some(cfg)) = crate::cloud::CloudConfig::load(&self.profile.cloud_file()) else {
            return;
        };
        let Ok(tls) = crate::cloud::tls_config() else {
            return;
        };
        let Ok(cloud) = crate::cloud::Cloud::new(&tls, &cfg.server_url, self.secrets.as_ref())
        else {
            return;
        };
        tokio::spawn(async move {
            if let Err(e) = cloud.revoke_grant(&grant).await {
                tracing::warn!(error = %e, "upstream revocation failed; the local refusal holds");
            }
        });
    }

    fn set_epoch_error(&self, epoch: u64, error: &str) {
        let mut a = self.account.lock().unwrap_or_else(|p| p.into_inner());
        if a.epoch == epoch {
            a.pairing_allowed = false;
            a.pairing = None;
            a.last_error = Some(error.into());
            drop(a);
            self.bump();
        }
    }

    // Caller holds account_gate. Invalidate before cleanup; never silently report
    // success on a failed fence/keychain/config/access persistence operation.
    async fn invalidate_account(
        &self,
        remove_cloud: impl FnOnce(&std::path::Path) -> std::io::Result<()>,
    ) -> Result<u64, ControlError> {
        use crate::cloud::AccountRecord;
        let previous = AccountRecord::load(&self.profile.account_file());
        let (epoch, exhausted) = {
            let mut a = self.account.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(t) = a.pairing_task.take() {
                t.abort();
            }
            for t in [a.relay.take(), a.registration.take()]
                .into_iter()
                .flatten()
            {
                t.abort();
            }
            let high = a.epoch.max(previous.as_ref().map(|r| r.epoch).unwrap_or(0));
            let next = high.checked_add(1);
            let epoch = next.unwrap_or(high);
            *a = Account {
                epoch,
                ..Account::default()
            };
            (epoch, next.is_none())
        };
        self.authority.invalidate(epoch);
        self.online
            .store(false, std::sync::atomic::Ordering::Relaxed);
        let fence = previous.and_then(|_| {
            if exhausted {
                return Err(crate::cloud::CloudError::Local(
                    "account epoch exhausted".into(),
                ));
            }
            AccountRecord {
                schema_version: 1,
                epoch,
                signed_in: false,
                connector_id: None,
                account_id: None,
            }
            .save(&self.profile.account_file())
        });
        let access = {
            let mut inner = self.inner.lock().await;
            inner.access.leases.clear();
            inner.access.monotonic_leases.clear();
            inner.access.feed_cursor = None;
            // Nothing is served under cached grants once signed out, and no
            // session (host ones included) outlives the account epoch: runtimes
            // close and reopen with a new source after the next sign-in.
            for h in inner.hosts.iter_mut() {
                h.close().await;
                h.refresh();
            }
            inner.access.save(&self.profile.access_file())
        };
        let token = self.secrets.delete(crate::cloud::CONNECTOR_TOKEN);
        let cloud = remove_cloud(&self.profile.cloud_file());
        self.bump();
        let error = fence
            .err()
            .map(|e| e.to_string())
            .or_else(|| access.err().map(|e| e.to_string()))
            .or_else(|| token.err().map(|e| e.to_string()))
            .or_else(|| {
                cloud
                    .err()
                    .filter(|e| e.kind() != std::io::ErrorKind::NotFound)
                    .map(|e| e.to_string())
            });
        if let Some(error) = error {
            self.set_epoch_error(epoch, "account_cleanup_failed");
            return Err(ControlError::unavailable("account_cleanup_failed", error));
        }
        Ok(epoch)
    }

    /// Sign-out and sign-in clear the saved policy cursor. One naming another
    /// connector (left by an interrupted cleanup) would stop the relay for good,
    /// so it is dropped with its leases, as sign-out does: nothing is served
    /// until this connector's first policy snapshot. Caller holds account_gate.
    async fn drop_foreign_policy_cursor(&self, connector: Option<&str>) {
        let mut inner = self.inner.lock().await;
        if inner
            .access
            .feed_cursor
            .as_ref()
            .is_none_or(|c| Some(c.connector.as_str()) == connector)
        {
            return;
        }
        inner.access.leases.clear();
        inner.access.monotonic_leases.clear();
        inner.access.feed_cursor = None;
        self.authority.publish_access(&inner.access);
        if let Err(e) = inner.access.save(&self.profile.access_file()) {
            tracing::warn!(error = %e, "access list not saved after dropping an old policy cursor");
        }
        tracing::info!("dropped a policy cursor from a previous sign-in");
    }

    async fn begin_pairing(&self) -> Result<u64, ControlError> {
        let _gate = self.account_gate.lock().await;
        let epoch = self
            .invalidate_account(|path| std::fs::remove_file(path))
            .await?;
        self.account
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .pairing_allowed = true;
        Ok(epoch)
    }

    async fn publish_pairing(
        self: &Arc<Self>,
        epoch: u64,
        cfg: crate::cloud::CloudConfig,
        account_id: &str,
        token: &[u8],
    ) -> Result<(), ControlError> {
        let _gate = self.account_gate.lock().await;
        let record = crate::cloud::AccountRecord::load(&self.profile.account_file())
            .map_err(|e| ControlError::unavailable("account_state", e.to_string()))?;
        let allowed = {
            let a = self.account.lock().unwrap_or_else(|p| p.into_inner());
            a.epoch == epoch && a.pairing_allowed
        };
        if !allowed
            || cfg.connector_id.is_none()
            || record.epoch != epoch
            || record.signed_in
            || cfg.account_epoch != epoch
        {
            return Err(ControlError::unavailable(
                "sign_in_cancelled",
                "account generation changed",
            ));
        }
        crate::authority::account_id(account_id).ok_or_else(|| {
            ControlError::unavailable(
                "account_identity_missing",
                "pairing did not provide a canonical account UUID",
            )
        })?;
        // This account's own device identity, before anything is published for it.
        self.use_identity_of(account_id).await?;
        // The durable fence is still signed out throughout partial publication.
        self.secrets
            .set(crate::cloud::CONNECTOR_TOKEN, token)
            .map_err(|e| ControlError::unavailable("account_state", e.to_string()))?;
        cfg.save(&self.profile.cloud_file())
            .map_err(|e| ControlError::unavailable("account_state", e.to_string()))?;
        let active = crate::cloud::AccountRecord {
            schema_version: 1,
            epoch,
            signed_in: true,
            connector_id: cfg.connector_id.clone(),
            account_id: Some(account_id.into()),
        };
        active
            .save(&self.profile.account_file())
            .map_err(|e| ControlError::unavailable("account_state", e.to_string()))?;
        if let Some(identity) = self.identity.get() {
            self.authority
                .publish_account_identity(&active, &cfg, &identity)
                .map_err(|reason| {
                    ControlError::unavailable(
                        reason.reason(),
                        "account authority publication failed",
                    )
                })?;
        }
        {
            let mut a = self.account.lock().unwrap_or_else(|p| p.into_inner());
            a.signed_in = true;
            a.pairing_allowed = false;
            a.pairing = None;
            a.pairing_task = None;
            a.last_error = None;
        }
        start_relay_locked(self, &active);
        self.reopen_hosts().await;
        self.bump();
        tracing::info!("signed in");
        Ok(())
    }

    /// Use `account`'s own device identity from now on. Caller holds account_gate,
    /// with no account published (sign-in) or the same account (reopen). An identity
    /// nothing has claimed yet is claimed for this account, unless collections here
    /// show it is another account's; another account's identity is set aside for
    /// it, never used for this one.
    async fn use_identity_of(&self, account: &str) -> Result<(), ControlError> {
        let store_error = |e: secrets::SecretError| {
            ControlError::unavailable("credential_store_unavailable", e.to_string())
        };
        let file = self.profile.identity_file();
        let current = self.identity.get().ok_or_else(|| {
            ControlError::unavailable("device_identity_missing", "keychain device unavailable")
        })?;
        let owner = match secrets::identity_account(&file).map_err(store_error)? {
            Some(owner) => owner,
            None => match self.unclaimed_owner(current.device_id, account).await {
                Some(other) => other,
                None => {
                    return secrets::bind_identity(self.secrets.as_ref(), &file, &current, account)
                        .map_err(store_error);
                }
            },
        };
        if owner == account {
            return Ok(());
        }
        let next = secrets::switch_identity(
            self.secrets.as_ref(),
            &file,
            &current,
            Some(&owner),
            account,
            false,
        )
        .map_err(store_error)?;
        tracing::info!("using this account's own device identity");
        self.activate_identity(next).await;
        Ok(())
    }

    /// The account an identity from before identities were per account belongs to,
    /// when collections registered here with it say it is not `account`'s.
    async fn unclaimed_owner(&self, device: [u8; 16], account: &str) -> Option<String> {
        let device = secrets::uuid_string(&device);
        let inner = self.inner.lock().await;
        let owners: Vec<&str> = inner
            .registry
            .collections
            .iter()
            .filter(|e| e.device.as_deref() == Some(device.as_str()))
            .filter_map(|e| e.owner_account.as_deref())
            .collect();
        if owners.contains(&account) {
            return None;
        }
        owners.first().map(|o| o.to_string())
    }

    /// Another account that registered collections here with `device`.
    async fn other_owner(&self, device: [u8; 16], account: &str) -> Option<String> {
        let device = secrets::uuid_string(&device);
        self.inner
            .lock()
            .await
            .registry
            .collections
            .iter()
            .filter(|e| e.device.as_deref() == Some(device.as_str()))
            .filter_map(|e| e.owner_account.clone())
            .find(|o| o != account)
    }

    /// Serve with `identity`: status, hosts opened from now on, the relay started
    /// next, and the localhost link (restarted, as its Noise key changed).
    async fn activate_identity(&self, identity: DeviceIdentity) {
        let public = identity.public();
        let identity = Arc::new(identity);
        self.identity.set(identity.clone());
        self.inner.lock().await.device = Some(public);
        let old = self.link.lock().unwrap_or_else(|p| p.into_inner()).take();
        let Some(old) = old else {
            return;
        };
        old.stop();
        let Some(d) = self.self_weak.get().and_then(std::sync::Weak::upgrade) else {
            return;
        };
        match crate::link::Link::start(self.profile.local_link_file(), identity, d).await {
            Ok(l) => *self.link.lock().unwrap_or_else(|p| p.into_inner()) = Some(l),
            Err(e) => tracing::warn!(error = %e, "localhost link unavailable"),
        }
    }

    /// One device registration attempt for this sign-in.
    async fn register_device(
        self: &Arc<Self>,
        epoch: u64,
        cloud: &crate::cloud::Cloud,
        cfg: &mut crate::cloud::CloudConfig,
        identity: &Arc<DeviceIdentity>,
    ) -> Registered {
        let Some(cid) = cfg.connector_id.clone() else {
            self.set_registration_error(epoch, Some("sign_in_required"));
            return Registered::Stop;
        };
        match cloud.register_device(&cid, identity).await {
            Ok(()) => {
                cfg.device_registered = true;
                if let Err(e) = self.save_registered(epoch, cfg).await {
                    self.set_epoch_error(epoch, e.reason.as_deref().unwrap_or("account_state"));
                    return Registered::Stop;
                }
                self.set_registration_error(epoch, None);
                tracing::info!("device registered with the account");
                Registered::Yes
            }
            // This identity can never be this account's device here: the account
            // removed this computer, or the device is another account's. Register a
            // new device instead (once per sign-in); Private collections approve it
            // as they approve any new device.
            Err(crate::cloud::CloudError::Server(409, code))
                if code == "device_removed" || code == "device_already_bound" =>
            {
                tracing::warn!(reason = %code, "device registration refused; registering a new device");
                if self.begin_identity_replacement(epoch) {
                    let other = code == "device_already_bound";
                    tokio::spawn(
                        self.clone()
                            .replace_identity(epoch, identity.device_id, other),
                    );
                    return Registered::Stop;
                }
                self.set_registration_error(epoch, Some("device_registration_failed"));
                Registered::No
            }
            Err(crate::cloud::CloudError::Unauthenticated) => {
                self.set_registration_error(epoch, Some("authentication_required"));
                Registered::Stop
            }
            Err(e) => {
                tracing::warn!(error = %e, "device registration failed");
                self.set_registration_error(epoch, Some("device_registration_failed"));
                Registered::No
            }
        }
    }

    /// Keep registering in the background with capped, jittered backoff, then
    /// restart the relay so it binds the device.
    fn retry_registration(
        self: &Arc<Self>,
        epoch: u64,
        cloud: Arc<crate::cloud::Cloud>,
        mut cfg: crate::cloud::CloudConfig,
        identity: Arc<DeviceIdentity>,
    ) {
        let d = self.clone();
        let mut stop = self.shutdown.subscribe();
        let task = tokio::spawn(async move {
            let mut attempt = 0u32;
            loop {
                attempt = attempt.saturating_add(1);
                tokio::select! {
                    _ = tokio::time::sleep(registration_backoff(attempt)) => {}
                    _ = stop.wait_for(|s| *s) => return,
                }
                if d.account.lock().unwrap_or_else(|p| p.into_inner()).epoch != epoch {
                    return;
                }
                match d.register_device(epoch, &cloud, &mut cfg, &identity).await {
                    Registered::No => continue,
                    Registered::Stop => return,
                    Registered::Yes => {
                        let _gate = d.account_gate.lock().await;
                        if let Ok(record) =
                            crate::cloud::AccountRecord::load(&d.profile.account_file())
                            && record.epoch == epoch
                            && d.account.lock().unwrap_or_else(|p| p.into_inner()).epoch == epoch
                        {
                            start_relay_locked(&d, &record);
                        }
                        return;
                    }
                }
            }
        });
        let mut a = self.account.lock().unwrap_or_else(|p| p.into_inner());
        if a.epoch != epoch {
            task.abort();
        } else if let Some(old) = a.registration.replace(task) {
            old.abort();
        }
    }

    fn set_registration_error(&self, epoch: u64, reason: Option<&str>) {
        let mut a = self.account.lock().unwrap_or_else(|p| p.into_inner());
        if a.epoch == epoch && a.registration_error.as_deref() != reason {
            a.registration_error = reason.map(str::to_string);
            drop(a);
            self.bump();
        }
    }

    fn begin_identity_replacement(&self, epoch: u64) -> bool {
        let mut a = self.account.lock().unwrap_or_else(|p| p.into_inner());
        if a.epoch != epoch || a.identity_replaced {
            return false;
        }
        a.identity_replaced = true;
        true
    }

    /// The account refused this computer's device (`refused`). Mint a new identity
    /// for the account, move the account's local-only collections here to it, and
    /// sign in again with it under a new account epoch, so nothing that used the old
    /// identity carries on. Collections synced with the old device are not reused:
    /// this computer joins them again as a new device. When the refused device is
    /// another account's (`other`), it is kept for that account.
    async fn replace_identity(self: Arc<Self>, epoch: u64, refused: [u8; 16], other: bool) {
        let _gate = self.account_gate.lock().await;
        let (Ok(record), Ok(Some(mut cfg))) = (
            crate::cloud::AccountRecord::load(&self.profile.account_file()),
            crate::cloud::CloudConfig::load(&self.profile.cloud_file()),
        ) else {
            return;
        };
        let Some(current) = self.identity.get().filter(|i| i.device_id == refused) else {
            return;
        };
        let (Some(account), Some(next)) = (record.account_id.clone(), epoch.checked_add(1)) else {
            return;
        };
        if record.epoch != epoch
            || !record.permits(&cfg)
            || self.account.lock().unwrap_or_else(|p| p.into_inner()).epoch != epoch
        {
            return;
        }
        let keep = if other {
            self.other_owner(refused, &account).await
        } else {
            None
        };
        let fresh = match secrets::switch_identity(
            self.secrets.as_ref(),
            &self.profile.identity_file(),
            &current,
            keep.as_deref(),
            &account,
            true,
        ) {
            Ok(id) => id,
            Err(e) => {
                tracing::warn!(error = %e, "could not store a new device identity");
                self.set_registration_error(epoch, Some("credential_store_unavailable"));
                return;
            }
        };
        let device = secrets::uuid_string(&fresh.device_id);
        // Fence everything that captured this epoch or the old identity.
        {
            let mut a = self.account.lock().unwrap_or_else(|p| p.into_inner());
            for t in [a.relay.take(), a.registration.take()]
                .into_iter()
                .flatten()
            {
                t.abort();
            }
            a.epoch = next;
            a.registration_error = None;
        }
        self.authority.invalidate(next);
        self.online
            .store(false, std::sync::atomic::Ordering::Relaxed);
        {
            let mut inner = self.inner.lock().await;
            for h in inner.hosts.iter_mut() {
                h.close().await;
                h.refresh();
            }
            let old = secrets::uuid_string(&refused);
            let mut registry = inner.registry.clone();
            for e in registry.collections.iter_mut().filter(|e| {
                e.mode == SyncMode::Local
                    && e.owner_account.as_deref() == Some(account.as_str())
                    && e.device.as_deref() == Some(old.as_str())
            }) {
                e.device = Some(device.clone());
            }
            if registry != inner.registry {
                match self.save_registry(&registry) {
                    Ok(()) => {
                        inner.registry = registry;
                        self.authority.publish_registry(&inner.registry);
                    }
                    Err(e) => {
                        tracing::warn!(error = %e.message, "local collections not moved to the new device")
                    }
                }
            }
        }
        self.activate_identity(fresh).await;
        cfg.account_epoch = next;
        cfg.device_registered = false;
        let active = crate::cloud::AccountRecord {
            epoch: next,
            ..record
        };
        if let Err(e) = cfg
            .save(&self.profile.cloud_file())
            .map_err(|e| e.to_string())
            .and_then(|()| {
                active
                    .save(&self.profile.account_file())
                    .map_err(|e| e.to_string())
            })
        {
            tracing::warn!(error = %e, "account state not saved after a new device identity");
            self.set_epoch_error(next, "account_state");
            return;
        }
        let Some(identity) = self.identity.get() else {
            return;
        };
        if let Err(reason) = self
            .authority
            .publish_account_identity(&active, &cfg, &identity)
        {
            self.set_epoch_error(next, reason.reason());
            return;
        }
        self.authority
            .publish_access(&self.inner.lock().await.access);
        start_relay_locked(&self, &active);
        self.reopen_hosts().await;
        self.bump();
        tracing::info!("registering this computer again as a new device");
    }

    async fn save_registered(
        &self,
        epoch: u64,
        cfg: &crate::cloud::CloudConfig,
    ) -> Result<(), ControlError> {
        let _gate = self.account_gate.lock().await;
        let record = crate::cloud::AccountRecord::load(&self.profile.account_file())
            .map_err(|e| ControlError::unavailable("account_state", e.to_string()))?;
        if self.account.lock().unwrap_or_else(|p| p.into_inner()).epoch != epoch
            || !record.permits(cfg)
        {
            return Err(ControlError::unavailable(
                "sign_in_cancelled",
                "account generation changed",
            ));
        }
        cfg.save(&self.profile.cloud_file())
            .map_err(|e| ControlError::unavailable("account_state", e.to_string()))
    }

    async fn sign_in(self: &Arc<Self>, req: &Request) -> Result<Value, ControlError> {
        // The build's environment decides the control plane: the default, and the
        // only one accepted.
        let server =
            crate::trust::sign_in_server(req.params.get("server_url").and_then(Value::as_str))
                .map_err(|e| ControlError::invalid("server_url", e))?;
        let name = req
            .params
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("mdbase on this computer")
            .to_string();
        let tls = crate::cloud::tls_config()
            .map_err(|e| ControlError::unavailable("tls", e.to_string()))?;
        // Capture the epoch BEFORE any network await, including pairing_start.
        let epoch = self.begin_pairing().await?;
        let pairing = match crate::cloud::pairing_start(&tls, &server, &name).await {
            Ok(p) => p,
            Err(e) => {
                self.set_epoch_error(epoch, "sign_in_failed");
                return Err(ControlError::unavailable("sign_in_failed", e.to_string()));
            }
        };
        let _gate = self.account_gate.lock().await;
        let allowed = {
            let a = self.account.lock().unwrap_or_else(|p| p.into_inner());
            a.epoch == epoch && a.pairing_allowed
        };
        if !allowed {
            return Err(ControlError::unavailable(
                "sign_in_cancelled",
                "account generation changed",
            ));
        }
        self.account
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .pairing = Some(pairing.verification_uri.clone());
        let d = self.clone();
        let p2 = pairing.clone();
        let computer_name = name.clone();
        let task = tokio::spawn(async move {
            let deadline =
                tokio::time::Instant::now() + Duration::from_secs(p2.expires_in.min(3600));
            let result = loop {
                if tokio::time::Instant::now() > deadline {
                    break Err("sign_in_expired");
                }
                match crate::cloud::pairing_exchange(&tls, &server, &p2).await {
                    Ok(Some(done)) => break Ok(done),
                    Ok(None) => tokio::time::sleep(Duration::from_millis(1500)).await,
                    Err(e) => {
                        tracing::warn!(error = %e, "sign-in failed");
                        break Err("sign_in_failed");
                    }
                }
            };
            match result {
                Err(reason) => d.set_epoch_error(epoch, reason),
                Ok(paired) => {
                    let cfg = crate::cloud::CloudConfig {
                        schema_version: 1,
                        account_epoch: epoch,
                        server_url: server,
                        connector_id: Some(paired.connector_id),
                        computer_name: Some(computer_name),
                        ..Default::default()
                    };
                    if let Err(e) = d
                        .publish_pairing(epoch, cfg, &paired.account_id, paired.token.as_bytes())
                        .await
                    {
                        tracing::warn!(error = %e.message, "sign-in not published");
                        d.set_epoch_error(epoch, e.reason.as_deref().unwrap_or("sign_in_failed"));
                    } else {
                        d.activity
                            .record(crate::activity::ActivityEntry::now("signed_in"));
                        // Taken-over collections wait for an account to register.
                        tokio::spawn(d.clone().takeover_task(false));
                    }
                }
            }
        });
        self.account
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .pairing_task = Some(task);
        self.bump();
        Ok(
            json!({ "verification_uri": pairing.verification_uri, "expires_in": pairing.expires_in }),
        )
    }

    async fn sign_out(&self) -> Result<Value, ControlError> {
        self.sign_out_with_remove(|path| std::fs::remove_file(path))
            .await
    }

    async fn sign_out_with_remove(
        &self,
        remove: impl FnOnce(&std::path::Path) -> std::io::Result<()>,
    ) -> Result<Value, ControlError> {
        let _gate = self.account_gate.lock().await;
        self.invalidate_account(remove).await?;
        tracing::info!("signed out");
        Ok(json!({}))
    }
}

impl Daemon {
    /// A localhost-link session serves only a collection the user linked to
    /// that client key, on this computer's screen. The approved key is kept in
    /// the OS keychain (as the host key), never in a file; the link file's
    /// token alone (readable by any process of the user) is not enough. A new or
    /// changed key asks again; one prompt at a time.
    async fn link_authorized(
        &self,
        collection: &str,
        name: &str,
        client_pk: &[u8; 32],
    ) -> Result<(), ControlError> {
        let secret = link_client_secret(collection);
        let unavailable = |e: secrets::SecretError| {
            ControlError::unavailable("keychain_unavailable", e.to_string())
        };
        if let Some(k) = self.secrets.get(&secret).map_err(unavailable)?
            && ct_eq(&k, client_pk)
        {
            return Ok(());
        }
        let Ok(_prompt) = self.link_prompt.try_lock() else {
            return Err(ControlError::new(
                "forbidden",
                "link_not_approved",
                "another link request is waiting for confirmation",
            ));
        };
        let fingerprint = mdbn_replica::crypto::proof::client_fingerprint_display(
            &mdbn_wire::common::B32(*client_pk),
        );
        self.confirm(
            "Link Obsidian",
            &format!(
                "Let Obsidian on this computer use the collection \"{name}\" through mdbase?\n\n\
                 Key fingerprint: {fingerprint}"
            ),
        )
        .await
        .map_err(|e| {
            ControlError::new(
                "forbidden",
                "link_not_approved",
                format!(
                    "linking was not confirmed ({})",
                    e.reason.unwrap_or_default()
                ),
            )
        })?;
        self.secrets.set(&secret, client_pk).map_err(unavailable)?;
        Ok(())
    }

    /// Replace how confirmations are asked (the desktop companion registers itself
    /// here once its authenticated channel exists; native dialogs until then).
    pub fn set_confirmer(&self, c: Arc<dyn crate::confirm::Confirmer>) {
        *self.confirmer.write().unwrap_or_else(|p| p.into_inner()) = c;
    }

    /// Ask the user on screen; refuse unless they confirm.
    async fn confirm(&self, title: &str, message: &str) -> Result<(), ControlError> {
        use crate::confirm::Answer;
        let c = self
            .confirmer
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        match c.ask(title, message).await {
            Answer::Yes => Ok(()),
            Answer::No => Err(ControlError::new(
                "forbidden",
                "not_confirmed",
                "not confirmed on this computer's screen",
            )),
            Answer::Unavailable => Err(ControlError::unavailable(
                "confirmation_unavailable",
                "this needs a confirmation on this computer's screen, and no display is available",
            )),
        }
    }
}

impl Daemon {
    /// Open runtimes that can now open (account published), or report why not.
    async fn reopen_hosts(&self) {
        let ctx = self.host_ctx();
        let mut inner = self.inner.lock().await;
        let inner = &mut *inner;
        for h in inner.hosts.iter_mut() {
            // Closed hosts reopen with this sign-in's connector and device identity.
            h.set_ctx(ctx.clone());
            h.refresh();
            h.publish_grants(&inner.access);
        }
    }

    fn host_ctx(&self) -> Option<crate::collections::HostCtx> {
        self.identity.get().map(|id| crate::collections::HostCtx {
            identity: id.clone(),
            collections_dir: self.profile.state_dir.join("collections"),
            authority: self.authority.clone(),
            notify: {
                let changes = self.changes.clone();
                Arc::new(move || changes.send_modify(|n| *n += 1))
            },
            sync: self.sync_ctx(),
            old_connector_running: self.takeover.old_running.clone(),
        })
    }

    /// Re-check, every [`OLD_CONNECTOR_POLL`], whether an old connector daemon runs.
    async fn watch_old_connector(self: Arc<Self>) {
        loop {
            tokio::time::sleep(OLD_CONNECTOR_POLL).await;
            self.check_old_connector().await;
            self.clone().retry_takeover(false).await;
            self.import_mirrors().await;
        }
    }

    /// Probe the old connector's `daemon.lock`. When an old daemon starts, taken-over
    /// collections are closed (an old daemon from before the takeover marker check
    /// writes to them and takes no folder host lock); when it stops, they reopen.
    async fn check_old_connector(&self) {
        let Some(old) = crate::takeover::old_state_dir(&self.profile) else {
            return;
        };
        // One non-blocking lock attempt on a local file.
        let Some(running) = self.takeover.probe_old_connector(&old) else {
            return;
        };
        let ordering = std::sync::atomic::Ordering::SeqCst;
        if self.takeover.old_running.load(ordering) == running {
            return;
        }
        let _gate = self.account_gate.lock().await;
        let mut inner = self.inner.lock().await;
        let inner = &mut *inner;
        self.takeover.old_running.store(running, ordering);
        if running {
            tracing::error!(
                "old_connector_running: the old mdbase Connect daemon is running; \
                 taken-over collections are closed until it stops"
            );
        } else {
            tracing::info!(
                "the old mdbase Connect daemon stopped; reopening taken-over collections"
            );
        }
        for h in inner.hosts.iter_mut() {
            if h.entry().origin != crate::registry::Origin::MigratedLocal {
                continue;
            }
            if running {
                h.close().await;
            }
            h.refresh();
            h.publish_grants(&inner.access);
        }
        drop(_gate);
        self.bump();
    }

    /// What synced collections need: the signed-in Connect client and connector,
    /// the credential store (epoch keyrings), and the authenticated trust pins.
    /// `None` when not signed in. Trust is `None` (synced collections report
    /// `trust_missing`) until a verified release trust asset is embedded: there is
    /// no file, flag or environment override.
    fn sync_ctx(&self) -> Option<crate::collections::SyncCtx> {
        let cfg = crate::cloud::CloudConfig::load(&self.profile.cloud_file()).ok()??;
        let connector_id = cfg.connector_id.clone()?;
        let tls = crate::cloud::tls_config().ok()?;
        let cloud = crate::cloud::Cloud::new(&tls, &cfg.server_url, self.secrets.as_ref()).ok()?;
        Some(crate::collections::SyncCtx {
            cloud: Arc::new(cloud),
            connector_id,
            secrets: self.secrets.clone(),
            trust: self.trust.clone(),
        })
    }
}

#[path = "private_key.rs"]
mod private_key;
#[path = "private_mode.rs"]
mod private_mode;

#[cfg(test)]
#[path = "server_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "account_tests.rs"]
mod account_tests;
