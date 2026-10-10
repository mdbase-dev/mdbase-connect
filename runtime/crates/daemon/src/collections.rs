//! The collections a daemon hosts, one replica each.
//!
//! A [`CollectionHost`] owns one registered collection's runtime: its replica over
//! the file store. A local collection has no log: its replica confirms a write once
//! it is durably published to the file. A synced collection's replica appends to
//! the hosted log (`docs/collection-states-and-pricing.md` §3–4).
//!
//! A local collection runs [`crate::runtime::Runtime`] on its own thread. It opens
//! in the background (the first scan of a large folder takes a while): the host
//! reports `opening` until the runtime is ready, then `ready`, and the daemon's
//! status subscribers are told.
//!
//! A synced collection opens the same way once it is linked: the environment's
//! trust pins are installed, `sync.json` (v2) validates against them and this
//! collection, its chosen state matches the registration, and the paired identity
//! and registration are current. Before the runtime touches user files, Connect
//! must confirm this device is eligible (acknowledged enrolment, current
//! membership, no revoke: the log-token check). A refusal opens nothing. When
//! Connect cannot be reached, only a collection that has opened before (its index
//! exists) opens, and its verified log policy then governs serving.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

use crate::control::{CollectionState, CollectionStatus, LogLocation, Notice};
use crate::registry::{Entry, SyncMode};

/// One hosted collection.
pub struct CollectionHost {
    entry: Entry,
    state: CollectionState,
    reason: Option<String>,
    other_devices_online: Option<u32>,
    ctx: Option<HostCtx>,
    runtime: Option<RuntimeSlot>,
    /// Becomes `true` once the background opener has finished (filled the slot,
    /// or stopped and joined a cancelled runtime).
    opened: Option<tokio::sync::watch::Receiver<bool>>,
    cancel: Arc<AtomicBool>,
    grants: crate::runtime::LocalGrants,
    /// A synced runtime's readiness (local runtimes are ready once open).
    ready: Arc<std::sync::Mutex<Readiness>>,
    /// Exact paired incarnation captured when this runtime was opened.
    telemetry_authority: Option<crate::authority::CollectionAuthority>,
    /// Pre-open diagnostic only; never serving/permission/proof authority.
    mirror_closed: Arc<std::sync::Mutex<Option<crate::takeover::mirror_driver::Diagnostic>>>,
}

/// One readiness observation as a state (terminal reasons are kept).
fn readiness_of(verdict: Result<bool, &'static str>) -> Readiness {
    match verdict {
        Ok(true) => Readiness::Ready,
        Ok(false) => Readiness::Pending,
        Err(reason) => Readiness::Failed(reason),
    }
}

/// Whether an opened synced runtime may serve.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Readiness {
    /// Not yet (or a local runtime, which needs no gate).
    Pending,
    /// Genesis applied, keyed, caught up (or verified cache while offline).
    Ready,
    /// Never: the runtime was stopped (the reason is a status reason).
    Failed(&'static str),
}

/// Filled once by the background opener: the runtime, or why it did not open.
type RuntimeSlot = Arc<OnceLock<Result<Arc<crate::runtime::Runtime>, String>>>;

/// One host's part of a revoke barrier (see [`CollectionHost::barrier`]).
pub struct HostBarrier {
    slot: RuntimeSlot,
    opened: Option<tokio::sync::watch::Receiver<bool>>,
}

impl HostBarrier {
    /// Wait for a background open in progress (it validates pending rows against
    /// the grant source), then for the runtime to re-check its sessions.
    pub async fn wait(mut self) {
        if let Some(rx) = self.opened.as_mut() {
            let _ = rx.wait_for(|done| *done).await;
        }
        let rt = self.slot.get().and_then(|r| r.as_ref().ok()).cloned();
        if let Some(rt) = rt {
            rt.grants_barrier().await;
        }
    }
}

impl std::fmt::Debug for CollectionHost {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CollectionHost")
            .field("id", &self.entry.id)
            .field("state", &self.state)
            .finish_non_exhaustive()
    }
}

/// What a host needs to run a replica.
#[derive(Clone)]
pub struct HostCtx {
    /// The device identity.
    pub identity: Arc<crate::secrets::DeviceIdentity>,
    /// `<state>/collections`.
    pub collections_dir: PathBuf,
    /// The daemon's published account/registration/access authority.
    pub authority: crate::authority::Authority,
    /// Called when a background open finishes (status push).
    pub notify: Arc<dyn Fn() + Send + Sync>,
    /// What synced collections need; `None` until the daemon is signed in.
    pub sync: Option<SyncCtx>,
}

/// What a synced collection's runtime needs beyond the device identity.
#[derive(Clone)]
pub struct SyncCtx {
    /// The signed-in Connect client.
    pub cloud: Arc<crate::cloud::Cloud>,
    /// The signed-in connector.
    pub connector_id: String,
    /// The OS credential store (epoch keyrings).
    pub secrets: Arc<dyn crate::secrets::SecretStore>,
    /// The installed environment trust pins, if any.
    pub trust: Option<Arc<crate::trust::Trust>>,
}

/// A failed background open that never touched user files: Connect refused.
const INELIGIBLE: &str = "ineligible: ";
/// A failed background open of a never-opened collection while Connect was unreachable.
const UNREACHABLE: &str = "unreachable: ";

impl CollectionHost {
    /// Start hosting `entry`. Never touches the collection's files beyond a `stat`
    /// of its root.
    pub fn open(entry: Entry, ctx: Option<HostCtx>) -> CollectionHost {
        let mut host = CollectionHost {
            entry,
            state: CollectionState::Opening,
            reason: None,
            other_devices_online: None,
            ctx,
            runtime: None,
            opened: None,
            cancel: Arc::new(AtomicBool::new(false)),
            grants: Default::default(),
            ready: Arc::new(std::sync::Mutex::new(Readiness::Pending)),
            telemetry_authority: None,
            mirror_closed: Arc::new(std::sync::Mutex::new(None)),
        };
        host.refresh();
        host
    }

    /// Publish this collection's lease from the access list, and have the runtime
    /// re-check its sessions against the authority (account, registration, grants).
    pub fn publish_grants(&self, access: &crate::access::AccessList) {
        let id = &self.entry.id;
        let set = crate::runtime::LocalGrantSet {
            lease_expires_ms: access.leases.get(id).copied().unwrap_or(0),
            lease_deadline: access.monotonic_leases.get(id).copied(),
        };
        if let Ok(mut g) = self.grants.write() {
            *g = set;
        }
        if let Some(rt) = self.runtime() {
            rt.grants_changed();
        }
    }

    /// The running runtime, if serving.
    pub fn runtime(&self) -> Option<Arc<crate::runtime::Runtime>> {
        self.runtime.as_ref()?.get()?.as_ref().ok().cloned()
    }

    fn start(
        &mut self,
        authority: crate::authority::CollectionAuthority,
        sync: Option<(crate::runtime::Synced, Arc<crate::sync::ConnectTokens>)>,
    ) -> Result<(), String> {
        let ctx = self.ctx.as_ref().ok_or("no device identity")?;
        let handle = match &sync {
            Some(_) => Some(
                tokio::runtime::Handle::try_current().map_err(|e| format!("async runtime: {e}"))?,
            ),
            None => None,
        };
        let (sync, tokens) = match sync {
            Some((s, t)) => (Some(s), Some(t)),
            None => (None, None),
        };
        let pinned = sync.as_ref().map(|s| s.expected_genesis);
        let pins = sync.as_ref().map(|s| s.policy_pins.clone());
        let account = authority.active_account().map(|a| a.0);
        let u = |s: &str| crate::attest::uuid_bytes(s).ok_or_else(|| format!("bad uuid {s}"));
        let cfg = crate::runtime::RuntimeConfig {
            collection: u(&self.entry.id)?,
            replica_id: u(&self.entry.replica_id)?,
            device_id: ctx.identity.device_id,
            root: self.entry.root.clone(),
            private_dir: ctx.collections_dir.join(&self.entry.id),
            sync,
        };
        let secrets = mdbn_replica::DeviceSecrets {
            sign_sk: *ctx.identity.sign_seed(),
            kem_sk: *ctx.identity.kem_secret(),
        };
        let grants = self.grants.clone();
        // Pinned to the current account epoch: after sign-out or re-pair it denies
        // everything, and the daemon closes this runtime and opens a new one.
        self.telemetry_authority = Some(authority.clone());
        let source = Box::new(crate::runtime::AuthoritySource(authority));
        let slot: RuntimeSlot = Arc::new(OnceLock::new());
        let (done_tx, done_rx) = tokio::sync::watch::channel(false);
        let cancel = Arc::new(AtomicBool::new(false));
        self.cancel = cancel.clone();
        let ready = Arc::new(std::sync::Mutex::new(Readiness::Pending));
        self.ready = ready.clone();
        let (fill, notify, id) = (slot.clone(), ctx.notify.clone(), self.entry.id.clone());
        let mirror_closed = self.mirror_closed.clone();
        if let Ok(mut closed) = mirror_closed.lock() {
            *closed = None;
        }
        std::thread::Builder::new()
            .name(format!("open-{}", &id[..8.min(id.len())]))
            .spawn(move || {
                let started = std::time::Instant::now();
                let mut offline = false;
                // Synced: Connect confirms eligibility before any user-file IO.
                let preopen = crate::runtime::preopen_mirror_status(&cfg.private_dir);
                if let Ok(Some(diagnostic)) = &preopen
                    && let Ok(mut closed) = mirror_closed.lock() {
                    *closed = Some(diagnostic.clone());
                }
                let eligible = match preopen {
                    Ok(Some(_)) => Err("mirror_join_closed".into()),
                    Err(_) => Err("mirror_fence_unavailable".into()),
                    Ok(None) => match (&tokens, &handle) {
                    (Some(tokens), Some(handle)) => match handle.block_on(tokens.eligibility()) {
                        Ok(()) => Ok(()),
                        Err(crate::sync::Eligibility::Refused(why)) => Err(format!("{INELIGIBLE}{why}")),
                        Err(crate::sync::Eligibility::Unreachable(why)) => {
                            // Only a verified cached membership opens offline.
                            let cached = match (pinned, account) {
                                (Some(g), Some(a)) => match &pins {
                                    Some(p) => crate::runtime::cached_eligibility(&cfg.private_dir, cfg.device_id, a, g, p),
                                    None => Err("no pins".into()),
                                },
                                _ => Err("no pinned genesis or account".into()),
                            };
                            match cached {
                                Ok(()) => {
                                    tracing::warn!(collection = %id, error = %why, "Connect unreachable; opening from verified cached membership");
                                    offline = true;
                                    Ok(())
                                }
                                Err(c) => Err(format!("{UNREACHABLE}{why}; {c}")),
                            }
                        }
                    },
                    _ => Ok(()),
                    },
                };
                let synced = pinned.is_some();
                let r = match eligible {
                    Ok(()) => crate::runtime::Runtime::open(cfg, secrets, source, grants),
                    Err(e) => Err(crate::runtime::OpenFailed(e)),
                };
                match &r {
                    Ok(_) => tracing::info!(collection = %id, ms = started.elapsed().as_millis() as u64, "collection open"),
                    Err(e) => tracing::error!(collection = %id, error = %e.0, "collection failed to open"),
                }
                // Closed (paused/removed/signed out) while opening: stop it and wait
                // for its thread before reporting done, so nothing it does is left
                // in flight behind a close or a revoke acknowledgement.
                if cancel.load(Ordering::SeqCst) {
                    if let Ok(rt) = r {
                        rt.stop_blocking();
                    }
                } else {
                    let r = r.map(Arc::new).map_err(|e| e.0);
                    // Synced: opened is not ready. The slot is filled now (revoke
                    // barriers and close reach the runtime at once); readiness is
                    // watched separately and never holds the opener.
                    if synced && let (Ok(rt), Some(handle)) = (&r, &handle) {
                        let (rt, ready, cancel, notify) = (rt.clone(), ready.clone(), cancel.clone(), notify.clone());
                        handle.spawn(async move {
                            // Maintained for the runtime's life, not latched at the
                            // first Ready: a reconnect or a missing key returns it to
                            // opening, a terminal verdict stops it for good.
                            let mut last = Readiness::Pending;
                            loop {
                                if cancel.load(Ordering::SeqCst) {
                                    return;
                                }
                                let Some((s, caught_up)) = rt.readiness().await else {
                                    return; // stopped
                                };
                                let now = readiness_of(crate::runtime::synced_ready(&s, caught_up, offline));
                                if now != last {
                                    if let Ok(mut g) = ready.lock() {
                                        *g = now;
                                    }
                                    last = now;
                                    notify();
                                }
                                if let Readiness::Failed(_) = now {
                                    rt.stop().await;
                                    return;
                                }
                                let pause = if now == Readiness::Ready { 500 } else { 100 };
                                tokio::time::sleep(std::time::Duration::from_millis(pause)).await;
                            }
                        });
                    }
                    let _ = fill.set(r);
                }
                let _ = done_tx.send(true);
                notify();
            })
            .map_err(|e| format!("open thread: {e}"))?;
        self.runtime = Some(slot);
        self.opened = Some(done_rx);
        Ok(())
    }

    /// What a revoke barrier waits for on this host: its opener (if any), then
    /// its runtime's [`crate::runtime::Runtime::grants_barrier`].
    pub fn barrier(&self) -> Option<HostBarrier> {
        Some(HostBarrier {
            slot: self.runtime.clone()?,
            opened: self.opened.clone(),
        })
    }

    /// A source for this collection under the current account epoch, if the
    /// registration is authorized for that account (local-only: owner account and
    /// device match the paired identity).
    fn authorized(&self) -> Result<crate::authority::CollectionAuthority, crate::authority::Deny> {
        let ctx = self
            .ctx
            .as_ref()
            .ok_or(crate::authority::Deny::AccountMissing)?;
        let collection = crate::attest::uuid_bytes(&self.entry.id)
            .ok_or(crate::authority::Deny::RegistrationMismatch)?;
        let source = ctx.authority.source(mdbn_wire::common::B16(collection))?;
        source.authorize(None)?;
        Ok(source)
    }

    /// Re-evaluate state (folder presence, pause).
    pub fn refresh(&mut self) {
        let (state, reason) = if self.entry.paused {
            (CollectionState::Paused, None)
        } else if !is_dir(&self.entry.root) {
            (CollectionState::Unavailable, Some("folder_missing"))
        } else if self.runtime.is_some() {
            (CollectionState::Opening, None) // see current()
        } else if self.ctx.is_none() {
            (CollectionState::Unavailable, Some("runtime_pending"))
        } else if self.entry.mode != SyncMode::Local {
            match self.start_synced() {
                Ok(()) => (CollectionState::Opening, None),
                Err(reason) => (CollectionState::Unavailable, Some(reason)),
            }
        } else {
            // No replica opens before the paired account is published and this
            // registration is authorized for it: opening validates pending app rows
            // against the grant source, and a foreign or unpaired
            // registration must not reject them.
            match self.authorized() {
                Err(deny) => (CollectionState::Unavailable, Some(deny.reason())),
                Ok(authority) => match self.start(authority, None) {
                    Ok(()) => (CollectionState::Opening, None),
                    Err(e) => {
                        tracing::error!(collection = %self.entry.id, error = %e, "collection failed to open");
                        (CollectionState::Failed, Some("open_failed"))
                    }
                },
            }
        };
        self.state = state;
        self.reason = reason.map(str::to_string);
    }

    /// Link and start a synced collection, or say why not (a status reason).
    fn start_synced(&mut self) -> Result<(), &'static str> {
        let ctx = self.ctx.as_ref().ok_or("runtime_pending")?;
        let sync = ctx.sync.clone().ok_or("sync_not_configured")?;
        let trust = sync.trust.clone().ok_or("trust_missing")?;
        let collection =
            crate::attest::uuid_bytes(&self.entry.id).ok_or("collection_account_mismatch")?;
        // The signed-in Connect must be the environment's pinned control plane.
        if crate::trust::origin(sync.cloud.server()).ok().as_deref()
            != Some(trust.cp_origin.as_str())
        {
            tracing::error!(collection = %self.entry.id, "Connect is not the pinned control plane");
            return Err("sync_config_invalid");
        }
        let authority = ctx
            .authority
            .source(mdbn_wire::common::B16(collection))
            .map_err(|d| d.reason())?;
        authority.current_synced().map_err(|d| d.reason())?;
        let path = crate::sync::SyncConfig::path(&ctx.collections_dir, &self.entry.id);
        let invalid = |e: &dyn std::fmt::Display| {
            tracing::error!(collection = %self.entry.id, error = %e, "sync link refused");
            "sync_config_invalid"
        };
        let link = crate::sync::SyncConfig::load(&path)
            .map_err(|e| invalid(&e.0))?
            .ok_or("not_joined")?
            .validate(&collection, &trust)
            .map_err(|e| invalid(&e.0))?;
        let registered = match self.entry.mode {
            SyncMode::SyncedE2e => mdbn_wire::policy::CState::E2e,
            _ => mdbn_wire::policy::CState::CloudCopy,
        };
        if link.chosen_state != registered {
            return Err(invalid(&"chosen state differs from the registration"));
        }
        let fenced = authority.clone();
        let fence: crate::sync::Fence =
            Arc::new(move || fenced.current_synced().map_err(|d| d.reason().to_string()));
        let tokens = Arc::new(crate::sync::ConnectTokens::new(
            sync.cloud.clone(),
            sync.connector_id.clone(),
            collection,
            ctx.identity.clone(),
            fence,
        ));
        let synced = crate::runtime::Synced {
            log_url: link.log_url,
            chosen_state: link.chosen_state,
            trusted_roots: link.trusted_roots,
            trusted_signers: link.trusted_signers,
            user_enabled_cloud_copy: link.user_enabled_cloud_copy,
            tokens: tokens.clone(),
            secrets: sync.secrets.clone(),
            expected_genesis: link.expected_genesis,
            policy_pins: trust.policy_pins.clone(),
        };
        self.start(authority, Some((synced, tokens))).map_err(|e| {
            tracing::error!(collection = %self.entry.id, error = %e, "collection failed to open");
            "open_failed"
        })
    }

    /// The registry entry.
    pub fn entry(&self) -> &Entry {
        &self.entry
    }

    /// Replace the entry (pause/resume, mode change) and re-evaluate.
    pub fn set_entry(&mut self, entry: Entry) {
        self.entry = entry;
        self.refresh();
    }

    /// State and reason now, following a background open.
    fn current(&self) -> (CollectionState, Option<String>) {
        if self.state == CollectionState::Opening
            && let Ok(closed) = self.mirror_closed.lock()
            && let Some(diagnostic) = closed.as_ref()
        {
            return (
                CollectionState::Unavailable,
                Some(
                    if diagnostic.phase == "detached" {
                        "detached_sync"
                    } else {
                        "joining_sync"
                    }
                    .into(),
                ),
            );
        }
        match (self.state, self.runtime.as_ref().map(|s| s.get())) {
            (CollectionState::Opening, Some(Some(Ok(_)))) if self.entry.mode == SyncMode::Local => {
                (CollectionState::Ready, None)
            }
            (CollectionState::Opening, Some(Some(Ok(_)))) => match self.ready.lock().map(|g| *g) {
                Ok(Readiness::Ready) => (CollectionState::Ready, None),
                Ok(Readiness::Failed(reason)) => (CollectionState::Failed, Some(reason.into())),
                _ => (CollectionState::Opening, None),
            },
            (CollectionState::Opening, Some(Some(Err(e)))) if e.starts_with(INELIGIBLE) => (
                CollectionState::Unavailable,
                Some("sync_not_eligible".into()),
            ),
            (CollectionState::Opening, Some(Some(Err(e)))) if e.starts_with(UNREACHABLE) => (
                CollectionState::Unavailable,
                Some("sync_unreachable".into()),
            ),
            // Another host (Obsidian in-app) has the folder; not a failure.
            (CollectionState::Opening, Some(Some(Err(e)))) if e.contains("folder host lock") => (
                CollectionState::Unavailable,
                Some("hosted_elsewhere".into()),
            ),
            (CollectionState::Opening, Some(Some(Err(_)))) => {
                (CollectionState::Failed, Some("open_failed".into()))
            }
            _ => (self.state, self.reason.clone()),
        }
    }

    /// Current state.
    pub fn state(&self) -> CollectionState {
        self.current().0
    }

    /// Whether the replica serves requests.
    pub fn is_serving(&self) -> bool {
        matches!(
            self.state(),
            CollectionState::Ready | CollectionState::Moving
        )
    }

    /// Stop: flush and close the replica. Idempotent. A background open still
    /// in progress is cancelled; its runtime stops when it finishes.
    pub async fn close(&mut self) {
        self.cancel.store(true, Ordering::SeqCst);
        self.telemetry_authority = None;
        if let Some(mut rx) = self.opened.take() {
            let _ = rx.wait_for(|done| *done).await;
        }
        if let Some(slot) = self.runtime.take() {
            let rt = match Arc::try_unwrap(slot) {
                Ok(lock) => lock.into_inner().and_then(Result::ok),
                Err(shared) => shared.get().and_then(|r| r.as_ref().ok()).cloned(),
            };
            // Stopped even while sessions hold it: they are closed, not kept serving.
            if let Some(rt) = rt {
                rt.stop().await;
            }
        }
        self.state = CollectionState::Paused;
    }

    /// Read-only live status. Hold the exact opened runtime and captured source
    /// across the actor await; stale/stopped/paused hosts return no counters.
    pub async fn observed_status(&self) -> CollectionStatus {
        let mut status = self.status();
        let Some(source) = self.telemetry_authority.as_ref() else {
            return status;
        };
        let current = || !self.cancel.load(Ordering::SeqCst) && source.authority_epoch().is_some();
        if !current() {
            return status;
        }
        let Some(runtime) = self.runtime() else {
            return status;
        };
        let telemetry = current_telemetry(source, &self.cancel, runtime.telemetry()).await;
        if current()
            && self
                .runtime()
                .as_ref()
                .is_some_and(|r| Arc::ptr_eq(r, &runtime))
        {
            if let Some(held) = telemetry.as_ref().map(|t| t.holds).filter(|h| *h > 0) {
                status.notices.push(Notice {
                    code: "holds_pending".into(),
                    message: format!(
                        "mdbase protected {held} of your edits instead of overwriting them. \
                         Resolve them in mdbase."
                    ),
                });
            }
            if let Some(n) = telemetry
                .as_ref()
                .map(|t| t.unsupported_entries)
                .filter(|n| *n > 0)
            {
                status.notices.push(Notice {
                    code: "unsupported_entries".into(),
                    message: format!(
                        "{n} item(s) in this folder are not synced: symbolic links are never \
                         followed, and other special files are skipped."
                    ),
                });
            }
            status.sync = telemetry;
        }
        status
    }

    /// Content-free pre-open diagnostic; not readiness or permission authority.
    pub(crate) fn mirror_diagnostic(&self) -> Option<crate::takeover::mirror_driver::Diagnostic> {
        self.mirror_closed.lock().ok().and_then(|d| d.clone())
    }

    /// Registration/readiness status without awaiting the actor.
    /// Control status/list use observed_status for live telemetry.
    pub fn status(&self) -> CollectionStatus {
        let e = &self.entry;
        let log = match e.mode {
            SyncMode::Local => LogLocation::None,
            SyncMode::Synced | SyncMode::SyncedE2e => LogLocation::Hosted,
        };
        let mut notices = Vec::new();
        if let Ok(closed) = self.mirror_closed.lock()
            && let Some(diagnostic) = closed.as_ref()
        {
            notices.push(Notice {
                code: diagnostic.reason.into(),
                message: diagnostic.message(),
            });
        }
        if e.mode == SyncMode::SyncedE2e && self.other_devices_online == Some(0) {
            notices.push(Notice {
                code: "no_other_device_online".into(),
                message: "No other device with this collection is online. Web apps can \
                          load it only while one of your devices is online."
                    .into(),
            });
        }
        if self.reason.as_deref() == Some("folder_missing") {
            notices.push(Notice {
                code: "folder_missing".into(),
                message: format!(
                    "The folder {} is missing. Reconnect the drive or remove the collection.",
                    e.root.display()
                ),
            });
        }
        CollectionStatus {
            id: e.id.clone(),
            name: e.name.clone(),
            root: e.root.clone(),
            mode: e.mode,
            origin: e.origin,
            log,
            state: self.current().0,
            reason: self.current().1,
            sync: None,
            other_devices_online: self.other_devices_online,
            notices,
        }
    }
}

/// The actor future is lazy: deny BEFORE polling and again AFTER its await.
async fn current_telemetry(
    source: &crate::authority::CollectionAuthority,
    cancel: &AtomicBool,
    observation: impl std::future::Future<Output = Option<crate::control::SyncCounters>>,
) -> Option<crate::control::SyncCounters> {
    let current = || !cancel.load(Ordering::SeqCst) && source.authority_epoch().is_some();
    if !current() {
        return None;
    }
    let observed = observation.await;
    if !current() {
        return None;
    }
    observed
}

fn is_dir(p: &Path) -> bool {
    std::fs::metadata(p).map(|m| m.is_dir()).unwrap_or(false)
}

#[cfg(test)]
#[path = "collections_tests.rs"]
mod tests;
