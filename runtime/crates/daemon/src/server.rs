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
    ControlError, DaemonStatus, DeviceInfo, EnableSync, GrantRef, HoldAction, HoldResolved,
    HoldSummary, JoinCollection, Method, NotReady, Notice, PROTOCOL, READINESS_SCHEMA, Readiness,
    Request, ResolveHold, Response, Settings,
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
    /// The device identity, once loaded (Noise responder key for the replica
    /// endpoint).
    identity: std::sync::OnceLock<Arc<DeviceIdentity>>,
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
    /// The localhost link for the Obsidian runtime.
    link: std::sync::Mutex<Option<crate::link::Link>>,
    /// The relay socket is up.
    online: std::sync::atomic::AtomicBool,
    /// AK1: per-collection account-key keying (background pass, status).
    account_keys: private_key::AccountKeys,
    /// Local takeover runs one at a time; whether the old connector came back.
    takeover: crate::takeover::Gate,
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
    last_error: Option<String>,
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
        control_key: std::sync::OnceLock::new(),
        account: std::sync::Mutex::new(Account::default()),
        account_gate: Mutex::new(()),
        link_prompt: Mutex::new(()),
        authority: crate::authority::Authority::default(),
        confirmer: std::sync::RwLock::new(Arc::from(confirmer)),
        online: std::sync::atomic::AtomicBool::new(false),
        link: std::sync::Mutex::new(None),
        trust: crate::trust::authenticated().ok().map(Arc::new),
        shutdown: watch::channel(false).0,
        identity: std::sync::OnceLock::new(),
        account_keys: Default::default(),
        takeover: Default::default(),
        inner: Mutex::new(Inner {
            registry: Registry::default(),
            access: AccessList::default(),
            hosts: Vec::new(),
            device: None,
            init_error: None,
        }),
        profile,
    });
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
                        let Some(id) = d.identity.get().cloned() else {
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
            let _ = d.identity.set(Arc::new(id));
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
    let registry = match Registry::load(&d.profile.registry_file()) {
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
    // "was ever end-to-end" is this device's own record (the registry),
    // never the control plane's; it forces approval for those collections.
    for e in registry.collections.iter().filter(|e| e.ever_e2e) {
        access.force_approval(&e.id);
    }
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
    if let Some(identity) = d.identity.get().cloned() {
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
            d.set_account_error(&e.to_string());
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
    let Some(identity) = d.identity.get().cloned() else {
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
            let Some(cid) = cfg.connector_id.clone() else {
                d2.set_epoch_error(epoch, "connector id unknown; sign in again");
                return;
            };
            match cloud.register_device(&cid, &identity).await {
                Ok(()) => {
                    cfg.device_registered = true;
                    if let Err(e) = d2.save_registered(epoch, &cfg).await {
                        d2.set_epoch_error(epoch, &e.message);
                        return;
                    }
                    tracing::info!("device registered with the account");
                }
                Err(e) => {
                    // Not fatal: the legacy channel still works; pipes need it.
                    tracing::warn!(error = %e, "device registration failed");
                    d2.set_epoch_error(epoch, &e.to_string());
                }
            }
        }
        if let crate::relay::Ended::Terminal(why) =
            crate::relay::run(d2.clone(), cloud, cfg, identity, stop).await
        {
            d2.set_epoch_error(epoch, &why);
        }
    });
    let mut a = d.account.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(old) = a.relay.replace(task) {
        old.abort();
    }
    a.signed_in = true;
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
        let inner = self.inner.lock().await;
        let mut collections = Vec::with_capacity(inner.hosts.len());
        for host in &inner.hosts {
            collections.push(with_access_notices(
                host.observed_status().await,
                &inner.access,
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
                AccountInfo {
                    signed_in: a.signed_in,
                    online: self.online.load(std::sync::atomic::Ordering::Relaxed),
                    pairing: a.pairing.clone(),
                    last_error: a.last_error.clone(),
                    account_id: self
                        .authority
                        .active_account()
                        .map(|id| secrets::uuid_string(&id.0)),
                    server: crate::cloud::CloudConfig::load(&self.profile.cloud_file())
                        .ok()
                        .flatten()
                        .filter(|_| a.signed_in)
                        .map(|c| c.server_url),
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
        for collection in inner
            .registry
            .collections
            .iter()
            .filter(|e| e.mode == SyncMode::Local)
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
            let _ = self.access_events.send(event);
        }
        self.bump();
        Ok(())
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
                let mut collections = Vec::with_capacity(inner.hosts.len());
                for host in &inner.hosts {
                    collections.push(with_access_notices(
                        host.observed_status().await,
                        &inner.access,
                    ));
                }
                to_value(&collections)
            }
            Method::COLLECTION_ADD => self.add(params(req)?).await,
            Method::COLLECTION_REMOVE => {
                let p: CollectionRef = params(req)?;
                self.remove(&p.collection).await
            }
            Method::COLLECTION_PAUSE | Method::COLLECTION_RESUME => {
                let p: CollectionRef = params(req)?;
                self.set_paused(&p.collection, req.method == Method::COLLECTION_PAUSE)
                    .await
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
                if p.mode == SyncMode::Local {
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
            Method::MIGRATE_STATUS => self.takeover_status().await,
            Method::MIGRATE_START => {
                let p: crate::control::MigrateStart = params(req)?;
                self.clone().takeover_run(p.stop_mirrors, false).await
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
                        "Allow {} to use the collection \"{}\" through this computer?\n\nAccess: {}\nFolders: {}\nApp key: {}\n\nCheck that the app shows the same key.",
                        e.grant.app_name,
                        name,
                        e.grant.capabilities.join(", "),
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
        let rt = self.runtime_of(id).await?;
        let result = host_call(&rt, "list_holds", mdbn_wire::cbor::Cbor::Null).await?;
        let holds: Vec<Hold> = Wire::from_cbor(&result)
            .map_err(|_| ControlError::internal("the replica's holds do not decode"))?;
        Ok(json!(holds.iter().map(hold_summary).collect::<Vec<_>>()))
    }

    /// `collection.resolve_hold`: resolve one hold as the hosting app (the user's
    /// own device; the SDK resolves with content on behalf of an app grant).
    async fn resolve_hold(&self, p: ResolveHold) -> Result<Value, ControlError> {
        use mdbn_wire::Wire;
        use mdbn_wire::cbor::Cbor;
        use mdbn_wire::client::{Receipt, ReceiptState};
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
        let name = p.name.unwrap_or_else(|| {
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
            added_at_ms: fsutil::now_ms() as u64,
            paused: false,
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
        let name = p.name.unwrap_or_else(|| {
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

    /// Turn sync on for a registered local collection whose folder is still empty:
    /// Connect creates the cloud copy (or private collection) from this device, the
    /// verified genesis is pinned, the local-only store is moved aside (never
    /// deleted), and the collection reopens synced. A non-empty folder needs the
    /// adopt path (generation-0 import), which is not here.
    async fn enable_sync(&self, p: EnableSync) -> Result<Value, ControlError> {
        let _gate = self.account_gate.lock().await;
        let (ctx, trust) = self.sync_parts()?;
        let e2e = p.mode == SyncMode::SyncedE2e;
        let state = if e2e {
            mdbn_wire::policy::CState::E2e
        } else {
            mdbn_wire::policy::CState::CloudCopy
        };
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
        if entry.mode != SyncMode::Local {
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
        if !local_bootstrap_folder_is_empty(&entry.root)? {
            return Err(ControlError::not_implemented(
                "enabling sync on a folder with files (adopt)",
            ));
        }
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
        if !local_bootstrap_folder_is_empty(&entry.root)? {
            return Err(ControlError::invalid(
                "folder_not_empty",
                "the folder changed while stopping; use adopt",
            ));
        }
        let identity = self
            .identity
            .get()
            .ok_or_else(|| {
                ControlError::unavailable("device_identity_missing", "keychain device unavailable")
            })?
            .clone();
        let created = if e2e {
            ctx.cloud
                .create_private(&ctx.connector_id, &collection, &identity, &current)
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
        if !local_bootstrap_folder_is_empty(&entry.root)? {
            return Err(ControlError::invalid(
                "folder_not_empty",
                "the folder changed during bootstrap; use adopt",
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
        // The local-only store is set aside, never deleted: an empty folder's
        // store holds no user data, but a mistake must stay recoverable.
        let dir = self.profile.state_dir.join("collections").join(&entry.id);
        if dir.exists() {
            let aside = self.profile.state_dir.join("collections").join(format!(
                "{}.local-{}",
                entry.id,
                fsutil::now_ms()
            ));
            std::fs::rename(&dir, &aside).map_err(|e| ControlError::internal(e.to_string()))?;
        }
        self.write_link(
            &entry.id,
            &collection,
            &trust,
            state,
            &created.log_url,
            &created.genesis_item,
        )?;
        let mut next = inner.registry.clone();
        let updated = next
            .get_mut(&entry.id)
            .ok_or_else(|| ControlError::internal("registry changed"))?;
        updated.mode = p.mode;
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
        tracing::info!(collection = %status.id, e2e, "sync enabled");
        to_value(&status)
    }

    async fn remove(&self, id: &str) -> Result<Value, ControlError> {
        let _gate = self.account_gate.lock().await;
        let mut inner = self.inner.lock().await;
        let mut next = inner.registry.clone();
        next.remove(id).map_err(registry_error)?;
        self.save_registry(&next)?;
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

    async fn set_paused(&self, id: &str, paused: bool) -> Result<Value, ControlError> {
        let _gate = self.account_gate.lock().await;
        let mut inner = self.inner.lock().await;
        let mut next = inner.registry.clone();
        let entry = next
            .get_mut(id)
            .ok_or_else(|| ControlError::not_found(format!("no registered collection {id}")))?;
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

    fn takeover_paths(&self) -> crate::takeover::Paths {
        crate::takeover::Paths::new(&self.profile.state_dir, self.profile.store_ids_file())
    }

    /// Background takeover (startup, after sign-in): errors are logged and kept for
    /// `doctor`.
    async fn takeover_task(self: Arc<Self>, stop_mirrors: bool) {
        if let Err(e) = self.takeover_run(stop_mirrors, true).await {
            tracing::warn!(error = %e.message, "local takeover did not run");
        }
    }

    /// Ask the existing authenticated rollout endpoint, never infer permission
    /// from finding old state. Caller holds account_gate through the takeover.
    async fn automatic_takeover_allowed(&self) -> bool {
        let Some(inc) = self.authority.incarnation() else {
            return false;
        };
        let Ok(Some(cfg)) = crate::cloud::CloudConfig::load(&self.profile.cloud_file()) else {
            return false;
        };
        let Ok(record) = crate::cloud::AccountRecord::load(&self.profile.account_file()) else {
            return false;
        };
        if !record.permits(&cfg)
            || record.active_account() != Some(inc.account)
            || record.epoch != inc.epoch
        {
            return false;
        }
        let Ok(tls) = crate::cloud::tls_config() else {
            return false;
        };
        let Ok(cloud) = crate::cloud::Cloud::new(&tls, &cfg.server_url, self.secrets.as_ref())
        else {
            return false;
        };
        let current = || {
            (self.authority.incarnation() == Some(inc))
                .then_some(())
                .ok_or_else(|| "account_changed".to_owned())
        };
        cloud
            .local_takeover_allowed(&tls, &current)
            .await
            .unwrap_or(false)
    }

    /// Run (or resume) the local takeover, then register what it took over.
    /// Automatic runs require fresh server permission; explicit operator runs do not.
    async fn takeover_run(
        self: Arc<Self>,
        stop_mirrors: bool,
        automatic: bool,
    ) -> Result<Value, ControlError> {
        let Some(old) = crate::takeover::old_state_dir(&self.profile) else {
            return self.takeover_status().await;
        };
        let _run = self.takeover.run.lock().await;
        if !old.join("connector.sqlite").is_file() && !self.takeover_paths().record.is_file() {
            return self.takeover_status().await;
        }
        let account_gate = self.account_gate.lock().await;
        if automatic && !self.automatic_takeover_allowed().await {
            self.takeover
                .waiting_for_batch
                .store(true, std::sync::atomic::Ordering::Relaxed);
            return self.takeover_status().await;
        }
        self.takeover
            .waiting_for_batch
            .store(false, std::sync::atomic::Ordering::Relaxed);
        let paths = self.takeover_paths();
        let isolated = self.profile.target == crate::paths::Target::IsolatedProfile;
        let opts = crate::takeover::Options {
            stop_mirrors,
            drain: crate::takeover::DRAIN,
            now: crate::takeover::now_rfc3339(),
        };
        let p2 = paths.clone();
        let ran = tokio::task::spawn_blocking(move || {
            let mut old_service: Box<dyn mdbn_takeover::OldService> = if isolated {
                Box::new(crate::takeover::IsolatedOldService)
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
                self.add(AddCollection {
                    path: t.root.clone(),
                    name: Some(t.name.clone()),
                })
                .await
                .map(|_| ())
            };
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
                if let Ok(Some(ev)) = crate::takeover::adapter::Evidence::load(&paths.legacy, id)
                    && !ev.holds.is_empty()
                {
                    holds.insert(id.clone(), json!(ev.holds));
                }
            }
        }
        Ok(json!({
            "record": record,
            "revived": self.takeover.revived.load(std::sync::atomic::Ordering::Relaxed),
            "error": self.takeover.error.lock().unwrap_or_else(|p| p.into_inner()).clone(),
            "holds": holds,
            "held_interrupted_writes": record.as_ref().map(|r| r.held_interrupted_writes()).unwrap_or(0),
            "waiting_for_migration_batch": self.takeover.waiting_for_batch.load(std::sync::atomic::Ordering::Relaxed),
            "retirement": self.takeover.retirement.lock().unwrap_or_else(|p| p.into_inner()).clone(),
        }))
    }

    fn takeover_check(&self) -> Option<Check> {
        use crate::takeover::record::{CollectionState, Record, State};
        let record = match Record::load(&self.takeover_paths().record) {
            Ok(Some(r)) => r,
            Ok(None) => {
                return self.takeover.waiting_for_batch.load(std::sync::atomic::Ordering::Relaxed).then(|| Check {
                    id: "takeover".into(),
                    status: "warn".into(),
                    detail: "waiting for migration batch".into(),
                    action: Some("Automatic takeover waits for Connect to release this account's migration batch; legacy state is untouched.".into()),
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
            detail.push_str("; waiting for migration batch");
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

/// How long a one-shot host call may take.
const HOST_CALL_TIMEOUT: Duration = Duration::from_secs(20);
/// How long `collection.resume` waits for the collection to serve again.
const RESUME_WAIT: Duration = Duration::from_secs(30);

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
        let resp = match d.handle(&req, &mut conn).await {
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
            self.inner
                .lock()
                .await
                .access
                .grant_live(collection, grant, fsutil::now_ms() as u64)
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
            if let Some(t) = a.relay.take() {
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
            self.set_epoch_error(epoch, &error);
            return Err(ControlError::unavailable("account_cleanup_failed", error));
        }
        Ok(epoch)
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
                .publish_account_identity(&active, &cfg, identity)
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
                self.set_epoch_error(epoch, &e.to_string());
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
        let task = tokio::spawn(async move {
            let deadline =
                tokio::time::Instant::now() + Duration::from_secs(p2.expires_in.min(3600));
            let result = loop {
                if tokio::time::Instant::now() > deadline {
                    break Err("sign-in expired".to_string());
                }
                match crate::cloud::pairing_exchange(&tls, &server, &p2).await {
                    Ok(Some(done)) => break Ok(done),
                    Ok(None) => tokio::time::sleep(Duration::from_millis(1500)).await,
                    Err(e) => break Err(e.to_string()),
                }
            };
            match result {
                Err(e) => d.set_epoch_error(epoch, &e),
                Ok(paired) => {
                    let cfg = crate::cloud::CloudConfig {
                        schema_version: 1,
                        account_epoch: epoch,
                        server_url: server,
                        connector_id: Some(paired.connector_id),
                        ..Default::default()
                    };
                    if let Err(e) = d
                        .publish_pairing(epoch, cfg, &paired.account_id, paired.token.as_bytes())
                        .await
                    {
                        d.set_epoch_error(epoch, &e.message);
                    } else {
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
        let mut inner = self.inner.lock().await;
        let inner = &mut *inner;
        for h in inner.hosts.iter_mut() {
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
        })
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

#[cfg(test)]
#[path = "server_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "account_tests.rs"]
mod account_tests;
