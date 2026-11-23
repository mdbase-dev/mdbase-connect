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

use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared};

use crate::control::{CollectionState, CollectionStatus, LogLocation, Notice};
use crate::registry::{Entry, SyncMode};

/// One hosted collection.
pub struct CollectionHost {
    entry: Entry,
    state: CollectionState,
    reason: Option<String>,
    other_devices_online: Option<u32>,
    ctx: Option<HostCtx>,
    runtime: HostedRuntime,
    cancel: Arc<AtomicBool>,
    grants: crate::runtime::LocalGrants,
    /// A synced runtime's readiness (local runtimes are ready once open).
    ready: Arc<std::sync::Mutex<Readiness>>,
    /// Exact paired incarnation captured when this runtime was opened.
    telemetry_authority: Option<crate::authority::CollectionAuthority>,
    /// Last allowlisted terminal incident; retained after the actor stops.
    last_sync_failure: crate::sync_failure::Shared,
    /// Automatic reopening after a `sync_integrity` stop or a storage fence.
    recovery: Recovery,
}

/// Status reason of a runtime stopped by an integrity, verification or key
/// incident (`runtime::synced_ready`).
pub const SYNC_INTEGRITY: &str = "sync_integrity";

/// The replica fenced itself after a fault of its own storage
/// ([`mdbn_replica::Fence::Store`]). The collection reports `opening` while it
/// is reopened; this is its status reason only once [`FENCE_REOPENS`] reopens
/// fenced again with the same cause and automatic reopening stopped.
pub const STORAGE_FAULT: &str = "storage_fault";

/// Waits before each automatic reopen, by step; later steps repeat the last.
/// A fenced collection reopens at once on its first attempt (step = attempts);
/// a [`SYNC_INTEGRITY`] stop starts one step in (step = attempts + 1). The
/// replica raises those incidents for conditions it retries itself and for
/// faults it documents as lasting until it is reopened, so such a stop is never
/// final: a reopen re-verifies the log and the local state, and a persistent
/// fault only stops it again.
const RECOVERY_BACKOFF: [std::time::Duration; 5] = [
    std::time::Duration::ZERO,
    std::time::Duration::from_secs(10),
    std::time::Duration::from_secs(60),
    std::time::Duration::from_secs(5 * 60),
    std::time::Duration::from_secs(30 * 60),
];

/// Automatic reopens a storage fence gets: when the reopened replica fences
/// again with the same cause this many times without serving in between, the
/// collection stays [`STORAGE_FAULT`] until `mdbase collection resume`.
const FENCE_REOPENS: u32 = 3;

/// Why a host stopped, for [`Recovery::step`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stop<'a> {
    /// Failed for [`SYNC_INTEGRITY`].
    Integrity,
    /// Fenced by its own storage, with the fence's cause.
    Fenced(&'a str),
}

/// When a stopped host reopens next.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct Recovery {
    /// Reopens since the collection last served.
    attempts: u32,
    /// When the next reopen is due; set when the stop is first observed.
    due: Option<std::time::Instant>,
    /// The last fence's cause, and how many stops in a row ended with it.
    fenced: Option<(String, u32)>,
}

impl Recovery {
    /// One observation. Serving resets the policy; a stop schedules a reopen
    /// after the backoff for the attempts so far, and returns the attempt number
    /// once it is due. Anything else (opening, paused, other failures) waits,
    /// and so does a fence that has used up its reopens ([`Self::gave_up`]).
    fn step(
        &mut self,
        stop: Option<Stop<'_>>,
        serving: bool,
        now: std::time::Instant,
    ) -> Option<u32> {
        if serving {
            *self = Recovery::default();
            return None;
        }
        let stop = stop?;
        let due = match self.due {
            Some(due) => due,
            // The first observation of this stop.
            None => {
                let step = match stop {
                    Stop::Integrity => {
                        self.fenced = None;
                        self.attempts as usize + 1
                    }
                    Stop::Fenced(cause) => {
                        let repeats = match &self.fenced {
                            Some((last, n)) if last == cause => n + 1,
                            _ => 1,
                        };
                        self.fenced = Some((cause.to_owned(), repeats));
                        self.attempts as usize
                    }
                };
                *self
                    .due
                    .insert(now + RECOVERY_BACKOFF[step.min(RECOVERY_BACKOFF.len() - 1)])
            }
        };
        if self.gave_up() || now < due {
            return None;
        }
        self.attempts += 1;
        self.due = None;
        Some(self.attempts)
    }

    /// The same storage fence ended the stop before each of the last
    /// [`FENCE_REOPENS`] reopens too: reopening again would only repeat it.
    fn gave_up(&self) -> bool {
        self.fenced
            .as_ref()
            .is_some_and(|(_, n)| *n > FENCE_REOPENS)
    }
}

/// One readiness observation as a state (terminal reasons are kept).
fn readiness_of(
    verdict: Result<bool, &'static str>,
    s: &mdbn_wire::client::SyncStatus,
) -> Readiness {
    match verdict {
        Ok(true) => Readiness::Ready,
        Ok(false) => Readiness::Pending,
        Err(STORAGE_FAULT) => {
            Readiness::Fenced(crate::sync_failure::log_detail(s).unwrap_or_default())
        }
        Err(reason) => Readiness::Failed(reason),
    }
}

/// Whether an opened synced runtime may serve.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Readiness {
    /// Not yet (or a local runtime, which needs no gate).
    Pending,
    /// Adopting the folder: generation 0 is not applied yet.
    Adopting,
    /// Genesis applied, keyed, caught up (or verified cache while offline).
    Ready,
    /// Never: the runtime was stopped (the reason is a status reason).
    Failed(&'static str),
    /// The runtime was stopped because its replica fenced itself after a fault
    /// of its own storage, with the fence's cause (sanitised, bounded): reopened
    /// by [`Recovery`], never retained as a sync failure.
    Fenced(String),
}

/// Filled once by the background opener: the runtime, or why it did not open.
type RuntimeSlot = Arc<OnceLock<Result<Arc<crate::runtime::Runtime>, String>>>;

#[derive(Clone)]
struct Opener {
    slot: RuntimeSlot,
    /// Set after the opener fills its slot or finishes stopping a cancelled open.
    done: tokio::sync::watch::Receiver<bool>,
}

impl Opener {
    async fn finish(mut self) -> Option<Arc<crate::runtime::Runtime>> {
        let _ = self.done.wait_for(|done| *done).await;
        self.slot.get()?.as_ref().ok().cloned()
    }
}

#[derive(Default)]
enum HostedRuntime {
    #[default]
    Closed,
    Open(Opener),
    /// The supervisor, a concurrent close, or daemon shutdown can finish the same stop.
    Stopping(HostStop),
}

impl HostedRuntime {
    fn opener(&self) -> Option<&Opener> {
        match self {
            Self::Open(opener) => Some(opener),
            _ => None,
        }
    }
}

pub(crate) type HostStop = Shared<BoxFuture<'static, ()>>;

/// One host's part of a revoke barrier (see [`CollectionHost::barrier`]).
pub struct HostBarrier(BoxFuture<'static, ()>);

impl HostBarrier {
    /// Wait for a background open in progress (it validates pending rows against
    /// the grant source), then for the runtime to re-check its sessions.
    pub async fn wait(self) {
        self.0.await;
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
    /// This computer's name in the account (signed in only).
    pub computer_name: Option<String>,
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
/// How long the daemon waits for a collection's actor to answer a read it can
/// do without (status details, whether a grant is already published), so one
/// busy collection cannot stall the others.
pub(crate) const ACTOR_WAIT: std::time::Duration = std::time::Duration::from_secs(2);
/// Status notice: the collection's actor did not answer within [`ACTOR_WAIT`].
pub const NOT_RESPONDING: &str = "collection_not_responding";
/// A failed background open of a never-opened collection while Connect was unreachable.
const UNREACHABLE: &str = "unreachable: ";

impl CollectionHost {
    /// Start hosting `entry`. Never touches the collection's files beyond a `stat`
    /// of its root.
    pub fn open(entry: Entry, ctx: Option<HostCtx>) -> CollectionHost {
        let last_sync_failure = ctx.as_ref().and_then(|c| {
            crate::sync_failure::Failure::load(&c.collections_dir.join(&entry.id))
                .ok()
                .flatten()
        });
        let mut host = Self::closed(
            entry,
            ctx,
            Arc::new(std::sync::Mutex::new(last_sync_failure)),
        );
        host.refresh();
        host
    }

    fn closed(
        entry: Entry,
        ctx: Option<HostCtx>,
        last_sync_failure: crate::sync_failure::Shared,
    ) -> Self {
        Self {
            entry,
            state: CollectionState::Opening,
            reason: None,
            other_devices_online: None,
            ctx,
            runtime: HostedRuntime::Closed,
            cancel: Arc::new(AtomicBool::new(false)),
            grants: Default::default(),
            ready: Arc::new(std::sync::Mutex::new(Readiness::Pending)),
            telemetry_authority: None,
            last_sync_failure,
            recovery: Recovery::default(),
        }
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

    /// The opened runtime, which may not yet be ready to serve.
    pub fn runtime(&self) -> Option<Arc<crate::runtime::Runtime>> {
        self.runtime.opener()?.slot.get()?.as_ref().ok().cloned()
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
        // A synced collection with an adopt journal adopts its folder on open
        // until the base is applied (the readiness watch then removes the journal).
        let journal = crate::adopt::Journal::path(&ctx.collections_dir, &self.entry.id);
        let adopt = match &sync {
            None => None,
            Some(_) => crate::adopt::Journal::load(&journal)
                .map_err(|e| format!("adopt journal: {e}"))?
                .map(|j| j.plan()),
        };
        let journal = adopt.is_some().then_some(journal);
        let cfg = crate::runtime::RuntimeConfig {
            collection: u(&self.entry.id)?,
            replica_id: u(&self.entry.replica_id)?,
            device_id: ctx.identity.device_id,
            root: self.entry.root.clone(),
            private_dir: ctx.collections_dir.join(&self.entry.id),
            sync,
            adopt,
            id_hints: Vec::new(),
            computer_name: ctx.computer_name.clone(),
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
        let (last_sync_failure, failure_dir) =
            (self.last_sync_failure.clone(), cfg.private_dir.clone());
        std::thread::Builder::new()
            .name(format!("open-{}", &id[..8.min(id.len())]))
            .spawn(move || {
                let started = std::time::Instant::now();
                let mut offline = false;
                // Synced: Connect confirms eligibility before any user-file IO.
                let eligible = match (&tokens, &handle) {
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
                        let tokens = tokens.clone().expect("synced token source");
                        let (id, journal) = (id.clone(), journal.clone());
                        let (last_sync_failure, failure_dir) = (last_sync_failure.clone(), failure_dir.clone());
                        handle.spawn(async move {
                            // Maintained for the runtime's life, not latched at the
                            // first Ready: a reconnect or a missing key returns it to
                            // opening, a terminal verdict stops it for good.
                            let mut last = Readiness::Pending;
                            let mut journal = journal;
                            loop {
                                if cancel.load(Ordering::SeqCst) {
                                    return;
                                }
                                let Some((s, caught_up, adopt, fence)) = rt.readiness().await else {
                                    return; // stopped
                                };
                                let deleted = tokens.terminal_reason() == Some("collection_deleted") || s.incidents.iter().any(|i| i.kind == mdbn_wire::client::IncidentKind::Gone);
                                let revoked = tokens.terminal_reason() == Some("device_revoked")
                                    || s.incidents.iter().any(|i| i.kind == mdbn_wire::client::IncidentKind::AccessRevoked);
                                let now = if deleted {
                                    Readiness::Failed("collection_deleted")
                                } else if revoked {
                                    Readiness::Failed("sync_revoked")
                                } else {
                                    match &adopt {
                                        Some(mdbn_replica::AdoptStatus::Pending) => Readiness::Adopting,
                                        Some(mdbn_replica::AdoptStatus::Failed(_)) => {
                                            tracing::error!(collection = %id, "adopt failed");
                                            Readiness::Failed("adopt_failed")
                                        }
                                        _ => {
                                            // Applied: later opens are ordinary.
                                            if let Some(path) = &journal {
                                                match crate::adopt::Journal::remove(path) {
                                                    Ok(()) => journal = None,
                                                    Err(e) => tracing::warn!(collection = %id, error = %e, "adopt journal not removed"),
                                                }
                                            }
                                            readiness_of(crate::runtime::synced_ready(&s, fence, caught_up, offline), &s)
                                        }
                                    }
                                };
                                let failure = if deleted || revoked {
                                    Some(crate::sync_failure::Failure {
                                        kind: if deleted { crate::sync_failure::Kind::Gone } else { crate::sync_failure::Kind::AccessRevoked },
                                        stage: crate::sync_failure::Stage::SyncedReadiness,
                                        seq: s.confirmed_through,
                                        generation: None,
                                        cause: None,
                                        persisted: Some(false),
                                        paths: Vec::new(),
                                        paths_omitted: None,
                                    })
                                } else {
                                    crate::sync_failure::Failure::project(&s, &adopt)
                                };
                                if let Readiness::Failed(reason) = now
                                    && let Some(failure) = failure
                                {
                                    tracing::warn!(
                                        collection = %id,
                                        reason,
                                        kind = ?failure.kind,
                                        confirmed_through = failure.seq,
                                        detail = crate::sync_failure::log_detail(&s).as_deref().unwrap_or("none"),
                                        "collection stopped by a sync incident"
                                    );
                                    let resource_failure = failure.cause == Some(crate::sync_failure::Cause::ResourceIngestDeferred);
                                    crate::sync_failure::retain_and_stop(
                                        &last_sync_failure,
                                        &failure_dir,
                                        failure,
                                        || {
                                            *ready.lock().unwrap_or_else(|e| e.into_inner()) = now;
                                            notify();
                                        },
                                        async {
                                            if resource_failure { rt.pending_ingest_paths().await } else { Vec::new() }
                                        },
                                        async {
                                            if deleted {
                                                rt.stop_deleted().await;
                                            } else {
                                                rt.stop().await;
                                            }
                                        },
                                    ).await;
                                    notify(); // persisted=true/false is now final
                                    return;
                                }
                                if let Readiness::Fenced(cause) = &now {
                                    tracing::warn!(
                                        collection = %id,
                                        cause = cause.as_str(),
                                        confirmed_through = s.confirmed_through,
                                        "collection stopped: its replica fenced itself after a storage fault; reopening it"
                                    );
                                }
                                if now != last {
                                    if let Ok(mut g) = ready.lock() {
                                        *g = now.clone();
                                    }
                                    // Serving again: an earlier stop is resolved.
                                    if now == Readiness::Ready
                                        && last_sync_failure.lock().unwrap_or_else(|e| e.into_inner()).is_some()
                                    {
                                        tracing::info!(collection = %id, "collection serves again; last sync failure cleared");
                                        crate::sync_failure::clear(&last_sync_failure, &failure_dir);
                                    }
                                    last = now.clone();
                                    notify();
                                }
                                if let Readiness::Failed(_) | Readiness::Fenced(_) = now {
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
        self.runtime = HostedRuntime::Open(Opener {
            slot,
            done: done_rx,
        });
        Ok(())
    }

    /// What a revoke barrier waits for on this host: its opener (if any), then
    /// its runtime's [`crate::runtime::Runtime::grants_barrier`].
    pub fn barrier(&self) -> Option<HostBarrier> {
        let wait = match &self.runtime {
            HostedRuntime::Closed => return None,
            HostedRuntime::Stopping(stop) => stop.clone().boxed(),
            HostedRuntime::Open(opener) => {
                let opener = opener.clone();
                async move {
                    if let Some(rt) = opener.finish().await {
                        rt.grants_barrier().await;
                    }
                }
                .boxed()
            }
        };
        Some(HostBarrier(wait))
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

    /// Open with `ctx` from now on (a new sign-in or device identity). A host that
    /// is serving keeps the context it opened with until it is closed.
    pub fn set_ctx(&mut self, ctx: Option<HostCtx>) {
        if matches!(self.runtime, HostedRuntime::Closed) {
            self.ctx = ctx;
        }
    }

    /// Re-evaluate state (folder presence, pause).
    pub fn refresh(&mut self) {
        if matches!(self.runtime, HostedRuntime::Stopping(_)) {
            return;
        }
        let (state, reason) = if self.entry.paused {
            (CollectionState::Paused, None)
        } else if !is_dir(&self.entry.root) {
            (CollectionState::Unavailable, Some("folder_missing"))
        } else if self.runtime.opener().is_some() {
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
        // A synced registration is the device's that joined it, never used with
        // another account's identity or the new identity of a removed computer.
        if self
            .entry
            .owner_account
            .as_deref()
            .is_some_and(|owner| authority.active_account() != crate::authority::account_id(owner))
        {
            return Err("collection_account_mismatch");
        }
        if self
            .entry
            .device
            .as_deref()
            .is_some_and(|device| device != crate::secrets::uuid_string(&ctx.identity.device_id))
        {
            return Err("not_joined");
        }
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
        match (self.state, self.runtime.opener().map(|o| o.slot.get())) {
            (CollectionState::Opening, Some(Some(Ok(_)))) if self.entry.mode == SyncMode::Local => {
                (CollectionState::Ready, None)
            }
            (CollectionState::Opening, Some(Some(Ok(_)))) => match self.ready.lock().as_deref() {
                Ok(Readiness::Ready) => (CollectionState::Ready, None),
                Ok(Readiness::Failed(reason)) => (CollectionState::Failed, Some((*reason).into())),
                Ok(Readiness::Fenced(_)) if self.recovery.gave_up() => {
                    (CollectionState::Failed, Some(STORAGE_FAULT.into()))
                }
                Ok(Readiness::Adopting) => (CollectionState::Opening, Some("adopting".into())),
                // Fenced: reopened by the supervisor, at once the first time.
                _ => (CollectionState::Opening, None),
            },
            (CollectionState::Opening, Some(Some(Err(e))))
                if e == &format!("{INELIGIBLE}collection_deleted") =>
            {
                (CollectionState::Failed, Some("collection_deleted".into()))
            }
            (CollectionState::Opening, Some(Some(Err(e))))
                if e == &format!("{INELIGIBLE}device_revoked") =>
            {
                (CollectionState::Failed, Some("sync_revoked".into()))
            }
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

    /// Approval can make an opened Private replica ready, but cannot serve requests.
    pub(crate) fn private_requester_runtime(&self) -> Option<Arc<crate::runtime::Runtime>> {
        if self.entry.mode != SyncMode::SyncedE2e
            || self.cancel.load(Ordering::SeqCst)
            || !matches!(
                self.state(),
                CollectionState::Opening | CollectionState::Ready | CollectionState::Moving
            )
        {
            return None;
        }
        self.runtime()
    }

    /// Claim a due reopen. Its stop handle also identifies this attempt while
    /// the supervisor waits without holding the collection registry lock.
    pub(crate) fn recover_due(&mut self, now: std::time::Instant) -> Option<HostStop> {
        if matches!(self.runtime, HostedRuntime::Stopping(_)) {
            return None;
        }
        let (state, reason) = self.current();
        let fenced = self.fenced();
        let stop = match &fenced {
            Some(cause) => Some(Stop::Fenced(cause)),
            None if state == CollectionState::Failed
                && reason.as_deref() == Some(SYNC_INTEGRITY) =>
            {
                Some(Stop::Integrity)
            }
            None => None,
        };
        let gave_up = self.recovery.gave_up();
        let attempt = self.recovery.step(stop, self.is_serving(), now);
        if !gave_up && self.recovery.gave_up() {
            tracing::error!(
                collection = %self.entry.id,
                reopens = FENCE_REOPENS,
                cause = fenced.as_deref().unwrap_or_default(),
                "collection fenced itself again with the same storage fault after every automatic reopen; \
                 left stopped until `mdbase collection resume`"
            );
        }
        let attempt = attempt?;
        tracing::warn!(collection = %self.entry.id, attempt, "reopening a stopped collection");
        self.state = state;
        self.reason = reason;
        Some(self.begin_stop())
    }

    pub(crate) fn pending_stop(&self) -> Option<HostStop> {
        match &self.runtime {
            HostedRuntime::Stopping(stop) => Some(stop.clone()),
            _ => None,
        }
    }

    /// The cause of the storage fence that stopped this host's opened runtime,
    /// if one did.
    fn fenced(&self) -> Option<String> {
        if !matches!(
            self.runtime.opener().map(|o| o.slot.get()),
            Some(Some(Ok(_)))
        ) {
            return None;
        }
        match &*self.ready.lock().ok()? {
            Readiness::Fenced(cause) => Some(cause.clone()),
            _ => None,
        }
    }

    /// Only the registration that still owns this completed stop may reopen.
    /// Keep its backoff, diagnostic and live grant source across the new open.
    pub(crate) fn next_after_stop(&self, stop: &HostStop) -> Option<Self> {
        if !matches!(&self.runtime, HostedRuntime::Stopping(s) if s.ptr_eq(stop)) {
            return None;
        }
        Some(Self {
            grants: self.grants.clone(),
            recovery: self.recovery.clone(),
            other_devices_online: self.other_devices_online,
            ..Self::closed(
                self.entry.clone(),
                self.ctx.clone(),
                self.last_sync_failure.clone(),
            )
        })
    }

    /// The explicit retry starts any later automatic reopens from the shortest wait.
    pub async fn retry(&mut self) {
        self.recovery = Recovery::default();
        self.close().await;
        self.refresh();
    }

    pub(crate) async fn close_with_failure(
        &mut self,
        dir: &Path,
        mut failure: crate::sync_failure::Failure,
    ) {
        let paths = std::mem::take(&mut failure.paths);
        let shared = self.last_sync_failure.clone();
        let cancel = self.cancel.clone();
        crate::sync_failure::retain_and_stop(
            &shared,
            dir,
            failure,
            || cancel.store(true, Ordering::SeqCst),
            async { paths },
            self.close(),
        )
        .await;
    }

    /// Stop: flush and close the replica. Idempotent. A background open still
    /// in progress is cancelled; its runtime stops when it finishes.
    pub async fn close(&mut self) {
        self.begin_stop().await;
        self.runtime = HostedRuntime::Closed;
        self.state = CollectionState::Paused;
    }

    fn begin_stop(&mut self) -> HostStop {
        self.cancel.store(true, Ordering::SeqCst);
        self.telemetry_authority = None;
        if let Some(stop) = self.pending_stop() {
            return stop;
        }
        let runtime = std::mem::take(&mut self.runtime);
        let stop = async move {
            if let HostedRuntime::Open(opener) = runtime
                && let Some(rt) = opener.finish().await
            {
                rt.stop().await;
            }
        }
        .boxed()
        .shared();
        self.runtime = HostedRuntime::Stopping(stop.clone());
        stop
    }

    pub(crate) fn clock_skew(&self) -> bool {
        self.entry.mode != SyncMode::Local
            && !self.cancel.load(Ordering::SeqCst)
            && self
                .ctx
                .as_ref()
                .and_then(|c| c.sync.as_ref())
                .is_some_and(|s| s.cloud.clock_skew())
    }

    /// What `status` reports for this host, taken under the registry lock. The
    /// runtime's live details are read from the returned [`Observation`] after
    /// that lock is released, so a busy collection holds up nobody else.
    pub fn observation(&self) -> Observation {
        Observation {
            status: self.status(),
            live: self
                .telemetry_authority
                .clone()
                .zip(self.runtime())
                .map(|(source, runtime)| LiveRuntime {
                    source,
                    cancel: self.cancel.clone(),
                    runtime,
                }),
        }
    }

    /// Registration/readiness status without awaiting the actor.
    /// Control status/list add live telemetry through [`Self::observation`].
    pub fn status(&self) -> CollectionStatus {
        let e = &self.entry;
        let log = match e.mode {
            SyncMode::Local => LogLocation::None,
            SyncMode::Synced | SyncMode::SyncedE2e => LogLocation::Hosted,
        };
        let mut notices = Vec::new();
        if self.current().1.as_deref() == Some("collection_deleted") {
            notices.push(Notice {
                path: None,
                code: "collection_deleted".into(),
                message: "This collection was deleted by its owner. Sync has stopped. Your local files are untouched. Remove the local registration with mdbase collection remove.".into(),
            });
        }
        if self.current().1.as_deref() == Some("sync_revoked") {
            notices.push(Notice {
                path: None,
                code: "sync_revoked".into(),
                message: "This computer was removed from this collection and can no longer sync it. To rejoin, use a new device identity in a separate mdbase profile (--state-dir), sign in, and join the collection into a new empty folder. Local edits held in this folder are kept for you to copy across. Keep this folder and the old profile until you have copied your edits.".into(),
            });
        }
        if self.current().1.as_deref() == Some(SYNC_INTEGRITY) {
            let next = match self.recovery.due {
                Some(due) => format!(
                    "mdbase reopens it automatically in about {} (attempt {})",
                    wait_text(due.saturating_duration_since(std::time::Instant::now())),
                    self.recovery.attempts + 1
                ),
                None => "mdbase reopens it automatically".into(),
            };
            notices.push(Notice {
                path: None,
                code: SYNC_INTEGRITY.into(),
                message: format!(
                    "Sync stopped after a consistency check failed; {next}. To retry now, run \
                     `mdbase collection resume {}`. Your files are untouched; `mdbase logs` has \
                     the details.",
                    e.id
                ),
            });
        } else if self.current().1.as_deref() == Some(STORAGE_FAULT) {
            notices.push(Notice {
                path: None,
                code: STORAGE_FAULT.into(),
                message: format!(
                    "Sync stopped: this collection's storage on this computer failed the same \
                     way after {FENCE_REOPENS} automatic reopens ({}). Check this computer's \
                     disk, free space and keychain, then run `mdbase collection resume {}`.",
                    self.fenced().unwrap_or_default(),
                    e.id
                ),
            });
        } else if self.current().0 == CollectionState::Opening
            && (self.recovery.attempts > 0 || self.fenced().is_some())
        {
            // A fenced runtime is about to reopen; a reopened one is opening.
            let attempt = self.recovery.attempts + u32::from(self.fenced().is_some());
            notices.push(Notice {
                path: None,
                code: "sync_reopening".into(),
                message: format!("Reopening after sync stopped (attempt {attempt})."),
            });
        }
        if e.mode == SyncMode::SyncedE2e && self.other_devices_online == Some(0) {
            notices.push(Notice {
                path: None,
                code: "no_other_device_online".into(),
                message: "No other device with this collection is online. Web apps can \
                          load it only while one of your devices is online."
                    .into(),
            });
        }
        if self.reason.as_deref() == Some("folder_missing") {
            notices.push(Notice {
                path: None,
                code: "folder_missing".into(),
                message: format!(
                    "The folder {} is missing. Reconnect the drive or remove the collection.",
                    e.root.display()
                ),
            });
        }
        let last_sync_failure = self
            .last_sync_failure
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        if let Some(failure) = &last_sync_failure {
            if let Some(count) = failure.paths_omitted {
                notices.push(Notice {
                    path: None,
                    code: "resource_ingest_paths_omitted".into(),
                    message: format!("{count} additional resource paths did not fit the saved failure diagnostic."),
                });
            }
            for path in &failure.paths {
                notices.push(Notice {
                    path: Some(path.clone()),
                    code: "resource_ingest_deferred".into(),
                    message: "At the last sync failure, this path was awaiting resource ingestion. Check the collection's type and configuration files.".into(),
                });
            }
        }
        CollectionStatus {
            id: e.id.clone(),
            name: e.name.clone(),
            description: e.description.clone(),
            root: e.root.clone(),
            mode: e.mode,
            origin: e.origin,
            log,
            state: self.current().0,
            reason: self.current().1,
            sync: None,
            last_sync_failure,
            other_devices_online: self.other_devices_online,
            approval_code: None,
            notices,
        }
    }
}

/// A host's registration status plus, while its runtime serves the paired
/// account it opened under, that runtime (see [`CollectionHost::observation`]).
pub struct Observation {
    status: CollectionStatus,
    live: Option<LiveRuntime>,
}

/// The exact opened runtime with the source and stop flag captured with it. A
/// stop sets `cancel`, so a runtime replaced after the capture reads as stale.
struct LiveRuntime {
    source: crate::authority::CollectionAuthority,
    cancel: Arc<AtomicBool>,
    runtime: Arc<crate::runtime::Runtime>,
}

impl Observation {
    /// The status with the runtime's live counters, notices and approval code.
    /// The reported state follows those counters: `syncing`, not `ready`, while
    /// any sync work (including a file transfer) is unfinished. The actor futures
    /// are lazy: they are denied BEFORE polling and again AFTER their await. Each
    /// waits at most [`ACTOR_WAIT`]; a collection that does not answer in time is
    /// reported without those details and with a [`NOT_RESPONDING`] notice.
    pub async fn status(self) -> CollectionStatus {
        let Observation { mut status, live } = self;
        let Some(LiveRuntime {
            source,
            cancel,
            runtime,
        }) = live
        else {
            return status;
        };
        let current = || !cancel.load(Ordering::SeqCst) && source.authority_epoch().is_some();
        if !current() {
            return status;
        }
        let (bound, guard_cancel) = (source.clone(), cancel.clone());
        let read_guard: crate::runtime::AccountKeyGuard = Arc::new(move || {
            !guard_cancel.load(Ordering::SeqCst) && bound.authority_epoch().is_some()
        });
        let (telemetry, read_owner, approval_code) = tokio::join!(
            tokio::time::timeout(ACTOR_WAIT, runtime.telemetry()),
            tokio::time::timeout(
                ACTOR_WAIT,
                runtime.private_switch(crate::runtime::PrivateSwitchOp::CloudRead, read_guard),
            ),
            tokio::time::timeout(ACTOR_WAIT, crate::server::Daemon::requester_code(&runtime)),
        );
        if !current() {
            return status;
        }
        if telemetry.is_err() || read_owner.is_err() || approval_code.is_err() {
            status.notices.push(Notice {
                path: None,
                code: NOT_RESPONDING.into(),
                message: "This collection did not answer in time, so its sync details \
                          are missing here. It may be busy; check again shortly."
                    .into(),
            });
        }
        if let Ok(Some((counters, notices))) = telemetry {
            status.notices.extend(notices);
            if let Ok(Some(Ok(Some(owner)))) = read_owner {
                status.notices.push(Notice {
                    path: None,
                    code: "cloud_copy_turned_on".into(),
                    message: format!("Cloud copy turned on by {}", owner.to_uuid_string()),
                });
            }
            status.state = status.state.observed(status.mode, Some(&counters));
            status.sync = Some(counters);
            status.approval_code = approval_code.ok().flatten();
        }
        status
    }
}

/// A short human wait: seconds under two minutes, else minutes.
fn wait_text(d: std::time::Duration) -> String {
    let secs = d.as_secs();
    if secs < 120 {
        format!("{} s", secs.max(1))
    } else {
        format!("{} min", secs.div_ceil(60))
    }
}

fn is_dir(p: &Path) -> bool {
    std::fs::metadata(p).map(|m| m.is_dir()).unwrap_or(false)
}

#[cfg(test)]
#[path = "collections_tests.rs"]
mod tests;
