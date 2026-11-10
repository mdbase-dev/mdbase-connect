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
    AccountInfo, AddCollection, Check, CollectionRef, CollectionStatus, ConflictSummary,
    ControlError, DaemonStatus, DeleteCollection, DeviceInfo, EnableSync, GrantRef, HoldAction,
    HoldResolved, HoldSummary, JoinCollection, Method, NotReady, Notice, PROTOCOL,
    READINESS_SCHEMA, Readiness, Request, ResolveHold, Response, SetSyncFiles, Settings, SyncFiles,
    UpdateCollection,
};
use crate::fsutil;
use crate::instance::{InstanceLock, LockError};
use crate::ipc::{self, BoxStream, Listener};
use crate::paths::Profile;
use crate::registry::{self, Entry, Origin, Registry, RegistryError, SyncMode};
use crate::secrets::{self, DeviceIdentity, DevicePublic, SecretStore};

mod account;
mod app_sessions;
mod dispatch;
mod doctor;
mod enable_sync;
mod folder;
mod grants;
mod holds;
mod legacy_takeover;
mod lifecycle;
mod relay_host;
mod runtime_calls;
mod startup;
mod status;

use account::*;
use dispatch::*;
use folder::*;
use grants::*;
use lifecycle::*;
use runtime_calls::*;
use startup::*;
use status::*;

pub use app_sessions::LINK_ALLOWED;
pub(crate) use folder::local_bootstrap_folder_is_empty;
pub use folder::{FolderClaim, classify_folder};
pub use startup::{run, run_with};
pub(crate) use status::bound_file_notices;

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
    /// Wakes initialization waiting on an unavailable credential store.
    credential_retry: tokio::sync::Notify,
    /// Access events for notifications (pushed as `access`).
    access_events: tokio::sync::broadcast::Sender<AccessEvent>,
    activity: crate::activity::ActivityLog,
    /// The device identity, once loaded (Noise responder key for the replica
    /// endpoint). Each account has its own; see [`ActiveIdentity`].
    identity: ActiveIdentity,
    /// Bumped on every status change; subscribers re-read status.
    changes: watch::Sender<u64>,
    /// The status after the latest change, built once for every subscriber.
    status_feed: watch::Sender<Option<Arc<serde_json::Value>>>,
    shutdown: watch::Sender<bool>,
    /// Every task the daemon spawns ([`Daemon::spawn`]); shutdown aborts and
    /// awaits them all before [`run`] returns.
    tasks: std::sync::Mutex<tokio::task::JoinSet<()>>,
    inner: Mutex<Inner>,
    /// The account link (relay task, pairing in progress).
    account: std::sync::Mutex<Account>,
    /// Serializes epoch checks with credential/config/fence publication and logout.
    account_gate: Mutex<()>,
    /// One link-approval prompt at a time.
    link_prompt: Mutex<()>,
    /// Host sessions holding in-progress visual device checks.
    device_approvals: Mutex<std::collections::HashMap<String, device_approval::ApprovalSession>>,
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
    pairing_task: Option<tokio::task::AbortHandle>,
    signed_in: bool,
    relay: Option<tokio::task::AbortHandle>,
    pairing: Option<String>,
    /// Reason code of the last account-link problem; cleared when the relay connects.
    last_error: Option<String>,
    /// Background device registration retries, while registration keeps failing.
    registration: Option<tokio::task::AbortHandle>,
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

impl Daemon {
    fn bump(&self) {
        self.changes.send_modify(|n| *n += 1);
    }

    /// Spawn a task that [`Self::stop_tasks`] aborts and awaits on shutdown.
    /// Once shutdown has begun the task is dropped unrun, so nothing spawned
    /// late outlives [`run`].
    fn spawn(
        &self,
        task: impl Future<Output = ()> + Send + 'static,
    ) -> Option<tokio::task::AbortHandle> {
        Some(self.open_tasks()?.spawn(task))
    }

    /// Run blocking work that [`Self::stop_tasks`] waits for: aborting the task
    /// awaiting it does not stop a started closure, which could otherwise still
    /// write after [`run`] returns. `None` once shutdown has begun, or when the
    /// work panicked.
    async fn run_blocking<T: Send + 'static>(
        &self,
        work: impl FnOnce() -> T + Send + 'static,
    ) -> Option<T> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.open_tasks()?.spawn_blocking(move || {
            let _ = tx.send(work());
        });
        rx.await.ok()
    }

    /// The task set with finished tasks reaped, or `None` once shutdown began.
    /// The flag is read under the lock that [`Self::stop_tasks`] takes.
    fn open_tasks(&self) -> Option<std::sync::MutexGuard<'_, tokio::task::JoinSet<()>>> {
        let mut tasks = self.tasks.lock().unwrap_or_else(|p| p.into_inner());
        if *self.shutdown.borrow() {
            return None;
        }
        while tasks.try_join_next().is_some() {}
        Some(tasks)
    }

    /// Abort every spawned task and wait until each has stopped. The shutdown
    /// flag is set first, so [`Self::spawn`] adds nothing afterwards.
    async fn stop_tasks(&self) {
        debug_assert!(*self.shutdown.borrow());
        let mut tasks = std::mem::take(&mut *self.tasks.lock().unwrap_or_else(|p| p.into_inner()));
        tasks.shutdown().await;
    }

    fn is_ready(&self) -> bool {
        self.readiness.borrow().ready
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
}

fn cloud_refusal(e: crate::cloud::CloudError) -> ControlError {
    match e {
        crate::cloud::CloudError::Server(429, code)
            if code == "account_collection_quota_exceeded" =>
        {
            ControlError::new(
                "quota_exceeded",
                &code,
                include_str!("../../../docs/account-collection-quota-message.txt").trim_end(),
            )
        }
        rate_limit @ crate::cloud::CloudError::RateLimited(_) => {
            ControlError::new("rate_limited", "rate_limited", rate_limit.to_string())
        }
        crate::cloud::CloudError::Unauthenticated => ControlError::new(
            "unauthenticated",
            "not_signed_in",
            "sign this computer in again",
        ),
        crate::cloud::CloudError::Network(m) => ControlError::unavailable("sync_unreachable", m),
        other => ControlError::unavailable("sync_refused", other.to_string()),
    }
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
            computer_name: crate::cloud::CloudConfig::load(&self.profile.cloud_file())
                .ok()
                .flatten()
                .and_then(|c| c.computer_name),
            old_connector_running: self.takeover.old_running.clone(),
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

#[path = "collection_mode.rs"]
mod collection_mode;
#[path = "private_key.rs"]
mod private_key;
#[path = "private_mode.rs"]
mod private_mode;

#[path = "device_approval.rs"]
mod device_approval;

#[cfg(test)]
#[path = "server_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "account_tests.rs"]
mod account_tests;
