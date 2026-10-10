//! One collection's replica runtime, on its own thread.
//!
//! `Replica<FileStore<NativePlatform, SqlStore<SqliteIndex>, SqlDiskDb<SqliteIndex>>>`
//! with the shared frame layer ([`mdbn_replica::frames::Frames`]). The replica is
//! synchronous and single-threaded per collection, and the store holds `Rc`s, so
//! everything lives on one dedicated thread. The async daemon talks to it through
//! a command channel.
//!
//! - **Local-only** collections run `SyncMode::LocalOnly`: no log calls; a write is
//!   confirmed once durably published to the file, with no `seq`.
//! - **Synced** collections run `SyncMode::Synced` with verification on, against
//!   the hosted log through [`crate::logwire`]: the replica's log calls are encoded
//!   with `log_codec` and sent by the transport thread; replies, pushes and
//!   connection events come back on this runtime's command channel. Trust anchors
//!   (roots, signers, chosen state) come from local persistence, never the log.
//! - **The index** (records, pending queue, receipts, holds, the file store's own
//!   rows) is one SQLite file per collection under `<state>/collections/<id>/`,
//!   opened `Durable`.
//! - **Disk changes** are picked up by the native watcher ([`crate::watch`]): a
//!   batch is observed once its quiescence window has passed. A periodic full rescan
//!   remains as the safety net ([`OBSERVE_EVERY_WATCHED`], or [`OBSERVE_EVERY`] when
//!   no watcher could start).

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::mpsc as std_mpsc;
use std::time::Duration;

use mdbn_platform_native::SqliteIndex;
use mdbn_replica::api::{SessionAuth, SessionId};
use mdbn_replica::frames::Frames;
use mdbn_replica::log::EndpointId;
use mdbn_replica::seal::KeyringSealer;
use mdbn_replica::{CorePlanner, DeviceSecrets, Host, Replica, ReplicaConfig};
use mdbn_store_file::index::IndexDurability;
use mdbn_store_file::{Config as FsConfig, SqlStore, SqlStoreLimits};
use mdbn_wire::client::SyncMode;
use mdbn_wire::common::B16;
use tokio::sync::{mpsc, oneshot};

type Store = crate::keyring_store::KeychainKeyring<mdbn_local_host::NativeStore>;

/// The collection folder's private directory (the platform's and the host lock's).
const PRIVATE_DIR: &str = mdbn_local_host::store::DEFAULT_PRIVATE_DIR;

/// How often the runtime rescans the folder without a watcher.
pub const OBSERVE_EVERY: Duration = Duration::from_millis(1500);
/// The safety-net rescan interval when the native watcher runs.
pub const OBSERVE_EVERY_WATCHED: Duration = Duration::from_secs(60);
/// How often the daemon re-publishes its folder host descriptor. A host
/// that cannot take the OS lock (Obsidian) yields when it finds a descriptor
/// that is not its own; the daemon, holding the lock, always re-asserts.
pub const HOST_HEARTBEAT: Duration = Duration::from_secs(15);
/// A descriptor from a host without the OS lock (Obsidian) older than this is
/// a dead host's (crash): the daemon takes the folder over. Hosts heartbeat
/// well inside it.
pub const HOST_DESCRIPTOR_STALE_MS: u64 = 60_000;

/// What opening needs.
#[derive(Debug, Clone)]
pub struct RuntimeConfig {
    /// Collection ID.
    pub collection: [u8; 16],
    /// This device's replica ID for it.
    pub replica_id: [u8; 16],
    /// Device ID.
    pub device_id: [u8; 16],
    /// Folder.
    pub root: PathBuf,
    /// `<state>/collections/<id>/`.
    pub private_dir: PathBuf,
    /// The synced link, or `None` for a local-only collection.
    pub sync: Option<Synced>,
}

/// A synced collection's log link and locally persisted trust anchors.
#[derive(Clone)]
pub struct Synced {
    /// The log service origin.
    pub log_url: String,
    /// The state the user chose (`e2e` private, or `cloud-copy`).
    pub chosen_state: mdbn_wire::policy::CState,
    /// Control-plane root keys this device trusts.
    pub trusted_roots: Vec<[u8; 32]>,
    /// Devices this user approved or created (device-local key trust roots).
    pub trusted_signers: Vec<[u8; 16]>,
    /// This device's user turned the cloud copy on.
    pub user_enabled_cloud_copy: bool,
    /// Log access tokens.
    pub tokens: Arc<dyn crate::logwire::TokenSource>,
    /// Where the epoch keyring lives (the OS credential store; never the index).
    pub secrets: Arc<dyn crate::secrets::SecretStore>,
    /// The chain hash of the collection's genesis, pinned at create/join from the
    /// verified Connect answer (never from the log). Required: a synced runtime never
    /// serves a log whose seq 1 differs.
    pub expected_genesis: [u8; 32],
    /// The published control-plane keys (from the authenticated trust payload).
    /// Required: every policy item must be certified by one of them.
    pub policy_pins: mdbn_replica::policy::PolicyPins,
}

impl std::fmt::Debug for Synced {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Synced")
            .field("log_url", &self.log_url)
            .field("chosen_state", &self.chosen_state)
            .field("trusted_roots", &self.trusted_roots.len())
            .field("trusted_signers", &self.trusted_signers.len())
            .field("user_enabled_cloud_copy", &self.user_enabled_cloud_copy)
            .finish_non_exhaustive()
    }
}

/// Commands to the runtime thread.
enum Cmd {
    Hello {
        auth: SessionAuth,
        frame: Vec<u8>,
        out: mpsc::UnboundedSender<Vec<u8>>,
        reply: oneshot::Sender<(Option<SessionId>, Vec<u8>)>,
    },
    Frame(SessionId, Vec<u8>),
    /// Re-check sessions; the sender (if any) is answered once that is done.
    GrantsChanged(Option<oneshot::Sender<()>>),
    Close(SessionId),
    Stop(oneshot::Sender<()>),
    /// From the synced collection's log transport.
    Log(crate::logwire::Event),
    /// The replica's sync status.
    Status(oneshot::Sender<mdbn_wire::client::SyncStatus>),
    Readiness(oneshot::Sender<(mdbn_wire::client::SyncStatus, bool)>),
    /// A content-free digest of the confirmed records.
    Digest(oneshot::Sender<Option<(u64, [u8; 32])>>),
    /// Counters and digests from ONE serialized actor observation.
    Telemetry(oneshot::Sender<crate::control::SyncCounters>),
    /// Produce an applied strict witness on the serialized replica actor.
    StrictWitness {
        account: B16,
        recovery: B16,
        version: u64,
        revoked_at: u64,
        reply: oneshot::Sender<Option<mdbn_replica::replica::StrictWitness>>,
    },
    /// The folder watcher has a batch of events.
    FsWake,
    /// AK1: an account-key operation on this private collection.
    AccountKey(
        AccountKeyOp,
        Option<AccountKeyGuard>,
        oneshot::Sender<Result<bool, mdbn_replica::replica::AccountKeyRefusal>>,
    ),
}

/// AK1 account-key operations (account-key bundle design).
/// Each carries the account secret `R`; the runtime derives this collection's
/// recovery device and drops the keys after use.
pub enum AccountKeyOp {
    /// Whether the account-key device is enrolled (exactly as derived) and keyed.
    Status(mdbn_replica::crypto::recovery::RecoveryKey),
    /// Setup: key the enrolled account-key device.
    Key(mdbn_replica::crypto::recovery::RecoveryKey),
    /// Unlock: key this device from the account key (installs locally; the
    /// self-grant is appended once caught up).
    Unlock(mdbn_replica::crypto::recovery::RecoveryKey),
    /// Whether this device is keyed in the applied policy and trusts its key.
    Unlocked,
    /// Whether this device may key the account-key device now (a keyed editor
    /// device with no rekey outstanding). Read-only.
    CanKey,
    /// Strict mode: whether this revoked account-key device is inactive and the
    /// revocation was rekeyed (false while not yet applied).
    RevokedAndRekeyed(B16),
}

/// Native custody authority, re-evaluated on the serialized actor before use.
/// Constructed from the real account incarnation/keychain, never a wire claim.
pub(crate) type AccountKeyGuard = Arc<dyn Fn() -> bool + Send + Sync>;

fn account_key_allowed(op: &AccountKeyOp, guard: Option<&AccountKeyGuard>) -> bool {
    match guard {
        Some(current) => current(),
        // Keying a recovery device always requires current native custody.
        None => !matches!(op, AccountKeyOp::Key(_)),
    }
}

/// Wait after a watcher batch before observing (the store's quiescence window).
const WATCH_SETTLE: Duration = Duration::from_millis(120);

/// The lease a runtime's local grants run under, published by the daemon from
/// its access list. The runtime only uses it to wake and close sessions on time;
/// whether a grant is live is decided by its [`AuthoritySource`].
pub type LocalGrants = Arc<std::sync::RwLock<LocalGrantSet>>;

/// One collection's lease, wall-clock and monotonic.
#[derive(Debug, Clone, Default)]
pub struct LocalGrantSet {
    /// Lease expiry (ms).
    pub lease_expires_ms: u64,
    /// Monotonic lease deadline.
    pub lease_deadline: Option<std::time::Instant>,
}

/// The replica's [`mdbn_replica::policy::GrantSource`] for one collection: the
/// daemon's [`crate::authority::CollectionAuthority`], pinned to the account epoch
/// it was made under (it denies everything once that epoch ends).
pub struct AuthoritySource(pub crate::authority::CollectionAuthority);

impl mdbn_replica::policy::GrantSource for AuthoritySource {
    fn grant(&self, grant: &B16) -> Option<mdbn_replica::policy::EffectiveGrant> {
        self.0.grant(grant)
    }

    fn owner_identity(&self) -> Option<mdbn_replica::policy::LocalOwnerIdentity> {
        let o = self.0.owner_identity()?;
        Some(mdbn_replica::policy::LocalOwnerIdentity {
            account: o.account,
            collection: o.collection,
            device: o.device,
        })
    }

    fn active_account(&self) -> Option<B16> {
        self.0.active_account()
    }

    fn authority_epoch(&self) -> Option<u64> {
        self.0.authority_epoch()
    }

    fn device_noise_pk(&self) -> Option<mdbn_wire::common::B32> {
        self.0.device_noise_pk()
    }
}

/// A handle to a running collection runtime.
pub struct Runtime {
    tx: std_mpsc::Sender<Cmd>,
    thread: std::sync::Mutex<Option<std::thread::JoinHandle<()>>>,
}

/// Why a runtime did not open. Messages carry no file contents.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenFailed(pub String);

impl Runtime {
    /// Open the runtime on its own thread; returns once the replica is open.
    pub fn open(
        cfg: RuntimeConfig,
        secrets: DeviceSecrets,
        source: Box<dyn mdbn_replica::policy::GrantSource + Send>,
        grants: LocalGrants,
    ) -> Result<Runtime, OpenFailed> {
        // Inspect private admission before spawning a runtime, transport, watcher
        // or acquiring the folder lock. The native opener keeps its original
        // host-lock ordering (an already-active SQLite index is exclusive).
        if let Some(closed) = preopen_mirror_status(&cfg.private_dir)
            .map_err(|e| OpenFailed(format!("mirror fence: {e}")))?
        {
            return Err(OpenFailed(closed.message()));
        }
        let (tx, rx) = std_mpsc::channel();
        let (ready_tx, ready_rx) = std_mpsc::channel();
        let name = format!("collection-{}", crate::secrets::hex(&cfg.collection[..4]));
        let events = tx.clone();
        let fs_wake = tx.clone();
        let thread = std::thread::Builder::new()
            .name(name)
            .spawn(move || match open_replica(&cfg, secrets, source) {
                // The folder host lock is held until the runtime has stopped.
                Ok((rep, lock)) => {
                    // The transport starts only once the replica is open (trust
                    // validated), so its hello proof can be signed.
                    let link = match &cfg.sync {
                        None => None,
                        Some(sync) => match crate::logwire::Link::spawn(
                            crate::logwire::LinkConfig::new(
                                sync.log_url.clone(),
                                B16(cfg.collection),
                                Some(B16(cfg.device_id)),
                            ),
                            sync.tokens.clone(),
                            Box::new(move |e| {
                                let _ = events.send(Cmd::Log(e));
                            }),
                        ) {
                            Ok(l) => Some(l),
                            Err(e) => {
                                let _ = ready_tx.send(Err(OpenFailed(format!("log link: {e}"))));
                                return;
                            }
                        },
                    };
                    // No watcher (unsupported platform, limits): the periodic rescan
                    // still finds every change.
                    let watcher = crate::watch::Watcher::start(
                        &cfg.root,
                        Box::new(move || {
                            let _ = fs_wake.send(Cmd::FsWake);
                        }),
                    )
                    .map_err(|e| tracing::warn!(error = %e, "folder watcher unavailable"))
                    .ok();
                    let _ = ready_tx.send(Ok(()));
                    run(rep, rx, grants, link, watcher, B16(cfg.collection), lock);
                }
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                }
            })
            .map_err(|e| OpenFailed(format!("thread: {e}")))?;
        match ready_rx.recv() {
            Ok(Ok(())) => Ok(Runtime {
                tx,
                thread: std::sync::Mutex::new(Some(thread)),
            }),
            Ok(Err(e)) => {
                let _ = thread.join();
                Err(e)
            }
            Err(_) => Err(OpenFailed("runtime thread exited".into())),
        }
    }

    /// Open a session with an encoded `hello` frame. Returns the session (if
    /// accepted), the encoded response, and the session's outbound frames.
    pub async fn hello(
        &self,
        auth: SessionAuth,
        frame: Vec<u8>,
    ) -> Option<(Option<SessionId>, Vec<u8>, mpsc::UnboundedReceiver<Vec<u8>>)> {
        let (out, out_rx) = mpsc::unbounded_channel();
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Cmd::Hello {
                auth,
                frame,
                out,
                reply,
            })
            .ok()?;
        let (s, r) = rx.await.ok()?;
        Some((s, r, out_rx))
    }

    /// Feed a frame from a session's client.
    pub fn frame(&self, session: SessionId, bytes: Vec<u8>) -> bool {
        self.tx.send(Cmd::Frame(session, bytes)).is_ok()
    }

    /// The access list changed: re-check open sessions now.
    pub fn grants_changed(&self) {
        let _ = self.tx.send(Cmd::GrantsChanged(None));
    }

    /// The access list changed: re-check open sessions, and return only once the
    /// runtime has done so. The runtime is single-threaded, so any apply or commit
    /// in flight under the old grants has finished first, and every later commit
    /// re-checks the (already published) new authority. A revoke is acknowledged
    /// only after this returns. Returns at once if the runtime has stopped.
    pub async fn grants_barrier(&self) {
        let (tx, rx) = oneshot::channel();
        if self.tx.send(Cmd::GrantsChanged(Some(tx))).is_ok() {
            let _ = rx.await;
        }
    }

    /// [`Runtime::stop`] for a plain (non-async) thread.
    pub fn stop_blocking(&self) {
        let (tx, rx) = oneshot::channel();
        if self.tx.send(Cmd::Stop(tx)).is_ok() {
            let _ = rx.blocking_recv();
        }
        let thread = self.thread.lock().ok().and_then(|mut t| t.take());
        if let Some(t) = thread {
            let _ = t.join();
        }
    }

    /// The status and whether the replica has read up to the head it heard in the
    /// current connection.
    pub async fn readiness(&self) -> Option<(mdbn_wire::client::SyncStatus, bool)> {
        let (tx, rx) = oneshot::channel();
        self.tx.send(Cmd::Readiness(tx)).ok()?;
        rx.await.ok()
    }

    /// The replica's sync status (confirmed through, pending, holds, conflicts,
    /// connection, incidents), or `None` once stopped.
    pub async fn status(&self) -> Option<mdbn_wire::client::SyncStatus> {
        let (tx, rx) = oneshot::channel();
        self.tx.send(Cmd::Status(tx)).ok()?;
        rx.await.ok()
    }

    /// `(count, SHA-256)` over the confirmed records' `(id, path, revision,
    /// modified_seq)`, in ID order: equal on two replicas exactly when their confirmed
    /// state is. Content-free (revisions are already hashes). `None` once stopped or
    /// on a store error.
    pub async fn confirmed_digest(&self) -> Option<(u64, [u8; 32])> {
        let (tx, rx) = oneshot::channel();
        self.tx.send(Cmd::Digest(tx)).ok()?;
        rx.await.ok().flatten()
    }

    /// Read-only counters and digests at one actor observation, or None once stopped.
    /// Diagnostic only: this is not a grant, prefix certificate or key-delivery ACK.
    pub async fn telemetry(&self) -> Option<crate::control::SyncCounters> {
        let (tx, rx) = oneshot::channel();
        self.tx.send(Cmd::Telemetry(tx)).ok()?;
        rx.await.ok()
    }

    /// Run an account-key operation; `None` once stopped. `Ok(true)`: keyed (status),
    /// or the unlock was accepted.
    pub async fn account_key(
        &self,
        op: AccountKeyOp,
    ) -> Option<Result<bool, mdbn_replica::replica::AccountKeyRefusal>> {
        let (tx, rx) = oneshot::channel();
        self.tx.send(Cmd::AccountKey(op, None, tx)).ok()?;
        rx.await.ok()
    }

    /// Account-key use with a live native custody fence at the actor boundary.
    pub(crate) async fn account_key_guarded(
        &self,
        op: AccountKeyOp,
        current: AccountKeyGuard,
    ) -> Option<Result<bool, mdbn_replica::replica::AccountKeyRefusal>> {
        let (tx, rx) = oneshot::channel();
        self.tx.send(Cmd::AccountKey(op, Some(current), tx)).ok()?;
        rx.await.ok()
    }

    /// Native-only applied witness; None when stopped, pending, stale or unhealthy.
    pub async fn strict_witness(
        &self,
        account: B16,
        recovery: B16,
        version: u64,
        revoked_at: u64,
    ) -> Option<mdbn_replica::replica::StrictWitness> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Cmd::StrictWitness {
                account,
                recovery,
                version,
                revoked_at,
                reply,
            })
            .ok()?;
        rx.await.ok().flatten()
    }

    /// The client's transport closed.
    pub fn close(&self, session: SessionId) {
        let _ = self.tx.send(Cmd::Close(session));
    }

    /// Stop: close every session (their transports end), flush and close the
    /// replica, and wait for the thread. Works through any shared handle: sessions
    /// holding the runtime do not keep it serving. Later calls are refused.
    pub async fn stop(&self) {
        let (tx, rx) = oneshot::channel();
        if self.tx.send(Cmd::Stop(tx)).is_ok() {
            let _ = rx.await;
        }
        let thread = self.thread.lock().ok().and_then(|mut t| t.take());
        if let Some(t) = thread {
            let _ = tokio::task::spawn_blocking(move || t.join()).await;
        }
    }
}

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
            K::Gone => return Err("sync_gone"),
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
fn open_replica(
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

/// Retire stale transport authority before any command/output after a wake.
fn retire_stale_log<S: mdbn_replica::store::Store>(
    rep: &mut Replica<S>,
    active: &mut Option<crate::logwire::Session>,
) {
    if active.as_ref().is_some_and(|s| s.check().is_err())
        && let Some(old) = active.take()
    {
        rep.retire_authenticated_log(old.authenticated());
    }
}

/// Fence the native source and the portable original call before decoder entry.
fn deliver_log_reply<S: mdbn_replica::store::Store>(
    rep: &mut Replica<S>,
    session: &crate::logwire::Session,
    scope: mdbn_replica::replica::LogReplyScope,
    decode: impl FnOnce(mdbn_replica::log::CallId, &'static str) -> mdbn_replica::log::LogReply,
) -> Result<(), mdbn_replica::replica::LogSessionError> {
    use mdbn_replica::{log::LogError, replica::LogSessionError};
    if session.check().is_err() {
        rep.retire_authenticated_log(session.authenticated());
        return Err(LogSessionError::Stale);
    }
    let result = rep.on_authenticated_log_reply(scope, |id, method| {
        if session.check().is_err() {
            return Err(LogError::NoResponse);
        }
        let decoded = decode(id, method);
        if session.check().is_err() {
            return Err(LogError::NoResponse);
        }
        decoded
    });
    if session.check().is_err() {
        rep.retire_authenticated_log(session.authenticated());
    }
    result
}
fn deliver_log_push<S: mdbn_replica::store::Store>(
    rep: &mut Replica<S>,
    session: &crate::logwire::Session,
    decode: impl FnOnce(B16) -> Result<mdbn_replica::log::LogPush, mdbn_replica::log::LogError>,
) -> Result<(), mdbn_replica::replica::LogSessionError> {
    use mdbn_replica::{log::LogError, replica::LogSessionError};
    if session.check().is_err() {
        rep.retire_authenticated_log(session.authenticated());
        return Err(LogSessionError::Stale);
    }
    let result = rep.on_authenticated_log_push(session.authenticated(), |collection| {
        if session.check().is_err() {
            return Err(LogError::Offline);
        }
        let decoded = decode(collection);
        if session.check().is_err() {
            return Err(LogError::Offline);
        }
        decoded
    });
    if session.check().is_err() {
        rep.retire_authenticated_log(session.authenticated());
    }
    result
}

/// Deliver only the original opaque scope, checking the native producer BEFORE
/// decoding and again afterwards. No event-provided ID/method can relabel it.
fn on_log_event<S: mdbn_replica::store::Store>(
    rep: &mut Replica<S>,
    collection: B16,
    active: &mut Option<crate::logwire::Session>,
    e: crate::logwire::Event,
) {
    use crate::logwire::{Event, Session};
    use mdbn_replica::log::{EndpointId, LogError};
    retire_stale_log(rep, active);
    match e {
        Event::Up { generation, reply } => {
            if generation.check().is_err() {
                let _ = reply.send(None);
                return;
            }
            let Ok(authenticated) = rep.bind_authenticated_log(EndpointId(1), collection) else {
                let _ = reply.send(None);
                return;
            };
            let session = Session::bind(generation, authenticated);
            if session.check().is_err() {
                rep.retire_authenticated_log(session.authenticated());
                let _ = reply.send(None);
                return;
            }
            *active = Some(session.clone());
            if reply.send(Some(session.clone())).is_err() {
                rep.retire_authenticated_log(session.authenticated());
                *active = None;
            }
        }
        Event::Down(session) | Event::Lost { session, .. } => {
            rep.retire_authenticated_log(session.authenticated());
            if active.as_ref().is_some_and(|s| s.same(&session)) {
                *active = None;
            }
        }
        Event::Offline { scope, session, .. } => {
            if session.check().is_ok() {
                let _ = rep.on_authenticated_log_reply(scope, |_, _| Err(LogError::Offline));
            } else {
                rep.retire_authenticated_log(session.authenticated());
            }
        }
        Event::Reply {
            scope,
            session,
            bytes,
            ..
        } => {
            let _ = deliver_log_reply(rep, &session, scope, |id, method| {
                let decoded = mdbn_replica::log_codec::reply(id, method, &bytes)
                    .unwrap_or(Err(LogError::NoResponse));
                match &decoded {
                    Ok(r) => tracing::debug!(id = id.0, method, reply = %short(r), "log reply"),
                    Err(e) => tracing::debug!(id = id.0, method, error = %e, "log reply"),
                }
                decoded
            });
        }
        Event::Push(bytes, _budget, session) => {
            let _ = deliver_log_push(rep, &session, |collection| {
                mdbn_replica::log_codec::push(collection, &bytes).map_err(|_| LogError::NoResponse)
            });
        }
        Event::Proof {
            nonce,
            token,
            generation,
            reply,
        } => {
            if generation.check().is_err() {
                let _ = reply.send(None);
                return;
            }
            let proof = rep.log_hello_proof(nonce, &token).ok().map(|s| s.0);
            let _ = reply.send(if generation.check().is_ok() {
                proof
            } else {
                None
            });
        }
    }
    retire_stale_log(rep, active);
}

fn confirmed_digest(rep: &Replica<Store>) -> Option<(u64, [u8; 32])> {
    confirmed_store_digest(rep.store())
}
fn confirmed_store_digest(store: &impl mdbn_replica::store::Store) -> Option<(u64, [u8; 32])> {
    use mdbn_replica::store::Page;
    // Store::records promises ID order. Stream the SAME existing tuple byte
    // contract in bounded pages, never collect the whole corpus or hash buffer.
    let mut hash = ring::digest::Context::new(&ring::digest::SHA256);
    let mut after = None;
    let mut count = 0u64;
    loop {
        let rows = store.records(Page { after, limit: 1024 }).ok()?;
        if rows.is_empty() {
            break;
        }
        for r in rows {
            if after.is_some_and(|id| id >= r.id) {
                return None;
            }
            hash.update(&r.id.0);
            hash.update(&(r.path.len() as u64).to_be_bytes());
            hash.update(r.path.as_bytes());
            hash.update(&r.revision.0);
            hash.update(&r.modified_seq.to_be_bytes());
            after = Some(r.id);
            count = count.checked_add(1)?;
        }
    }
    Some((count, hash.finish().as_ref().try_into().ok()?))
}

/// A one-line, content-free summary of a log reply for debug logs.
fn short(r: &mdbn_replica::log::LogResponse) -> String {
    use mdbn_replica::log::LogResponse as R;
    match r {
        R::Append(a) => format!("append {a:?}").chars().take(120).collect(),
        R::Read(r) => format!(
            "read {} items head {} more {}",
            r.items.len(),
            r.head,
            r.more
        ),
        R::Head(h) => format!("head {}", h.head),
        R::Subscribed { head, .. } => format!("subscribed head {head}"),
        other => format!("{:?}", std::mem::discriminant(other)),
    }
}

/// Send the replica's queued log calls through the transport.
fn send_log_calls(
    rep: &mut Replica<Store>,
    link: &crate::logwire::Link,
    active: &mut Option<crate::logwire::Session>,
) {
    use mdbn_replica::log::LogError;
    retire_stale_log(rep, active);
    let Some(session) = active.as_ref().cloned() else {
        return;
    };
    let Ok(calls) = rep.take_authenticated_log_calls(session.authenticated()) else {
        return;
    };
    for (c, scope) in calls {
        if session.check().is_err() {
            rep.retire_authenticated_log(session.authenticated());
            break;
        }
        let sent = match mdbn_replica::log_codec::request(&c) {
            Ok(frame) => {
                let method = c.request.method().into();
                // Over the inline limit, the sealed bytes are not in the frame:
                // they go beside it for a direct upload (log-service-api §6).
                let object = match c.request {
                    mdbn_replica::log::LogRequest::PutObject {
                        collection,
                        address,
                        bytes,
                        ..
                    } if bytes.len() > mdbn_replica::log_codec::INLINE_OBJECT_MAX => {
                        Some(crate::logwire::SealedObject {
                            collection,
                            address,
                            bytes: bytes.into(),
                        })
                    }
                    _ => None,
                };
                link.send(crate::logwire::Outbound {
                    id: c.id.0,
                    method,
                    frame,
                    object,
                    scope: scope.clone(),
                    session: session.clone(),
                })
            }
            Err(_) => false,
        };
        if !sent {
            if session.check().is_ok() {
                let _ = rep.on_authenticated_log_reply(scope, |_, _| Err(LogError::Offline));
            } else {
                rep.retire_authenticated_log(session.authenticated());
                break;
            }
        }
    }
    retire_stale_log(rep, active);
}

/// Local diagnostics only: no collection/record identity, note path or content.
fn log_retention_reclaims(rep: &mut Replica<Store>) {
    for reclaimed in rep.store_mut().inner_mut().take_reclaimed() {
        tracing::warn!(
            size = ?reclaimed.size,
            since = reclaimed.since,
            "checked same-launch retained-file release; changed bytes remain evidence"
        );
    }
}

fn run(
    mut rep: Replica<Store>,
    rx: std_mpsc::Receiver<Cmd>,
    grants: LocalGrants,
    link: Option<crate::logwire::Link>,
    watcher: Option<crate::watch::Watcher>,
    collection: B16,
    mut lock: mdbn_local_host::HostLock,
) {
    let mut active_log = None;
    let mut last_heartbeat = std::time::Instant::now();
    let mut observe_due: Option<std::time::Instant> = None;
    let observe_every = if watcher.is_some() {
        OBSERVE_EVERY_WATCHED
    } else {
        OBSERVE_EVERY
    };
    let lease_of = || grants.read().map(|g| g.lease_expires_ms).unwrap_or(0);
    let mut lease_checked = lease_of();
    let mut frames = Frames::new();
    let mut outs: BTreeMap<SessionId, mpsc::UnboundedSender<Vec<u8>>> = BTreeMap::new();
    let mut last_observe = std::time::Instant::now();
    let mut acks: Vec<oneshot::Sender<()>> = Vec::new();
    let mut last_status = std::time::Instant::now();
    loop {
        if last_heartbeat.elapsed() >= HOST_HEARTBEAT {
            last_heartbeat = std::time::Instant::now();
            if let Err(e) = lock.heartbeat(crate::fsutil::now_ms() as u64) {
                tracing::warn!(error = %e, "folder host descriptor refresh failed");
            }
        }
        let now = crate::fsutil::now_ms() as i64;
        let wake = rep
            .next_wakeup()
            .map(|t| Duration::from_millis(t.saturating_sub(now).max(0) as u64))
            .unwrap_or(observe_every)
            .min(observe_every.saturating_sub(last_observe.elapsed()))
            .min(
                observe_due
                    .map(|d| d.saturating_duration_since(std::time::Instant::now()))
                    .unwrap_or(observe_every),
            )
            .min(HOST_HEARTBEAT.saturating_sub(last_heartbeat.elapsed()));
        // Wake at the lease expiry to close sessions on time.
        let lease = lease_of();
        let wake = if lease > now as u64 {
            wake.min(Duration::from_millis(lease - now as u64))
        } else {
            wake
        };
        let received = rx.recv_timeout(wake);
        retire_stale_log(&mut rep, &mut active_log);
        match received {
            Ok(Cmd::Hello {
                auth,
                frame,
                out,
                reply,
            }) => {
                let o = frames.hello(&mut rep, auth, &frame);
                if let Some(s) = o.session {
                    outs.insert(s, out);
                }
                let _ = reply.send((o.session, o.response));
            }
            Ok(Cmd::Frame(s, bytes)) => frames.on_frame(&mut rep, s, &bytes),
            Ok(Cmd::GrantsChanged(ack)) => {
                rep.grants_changed();
                lease_checked = lease_of();
                acks.extend(ack);
            }
            Ok(Cmd::Close(s)) => {
                frames.close(&mut rep, s);
                outs.remove(&s);
            }
            Ok(Cmd::Log(e)) => on_log_event(&mut rep, collection, &mut active_log, e),
            Ok(Cmd::Status(reply)) => {
                let _ = reply.send(rep.sync_status());
            }
            Ok(Cmd::Readiness(reply)) => {
                let _ = reply.send((rep.sync_status(), rep.caught_up()));
            }
            Ok(Cmd::Digest(reply)) => {
                let _ = reply.send(confirmed_digest(&rep));
            }
            Ok(Cmd::Telemetry(reply)) => {
                use mdbn_replica::store::Store as _;
                let status = rep.sync_status();
                let head_digest = rep
                    .store()
                    .head()
                    .ok()
                    .filter(|h| h.seq == status.confirmed_through)
                    .map(|h| crate::secrets::hex(&h.chain.0));
                let records = confirmed_digest(&rep);
                let mut counters = sync_counters(&status, rep.caught_up(), head_digest, records);
                counters.unsupported_entries = rep.store().inner().stats.unsupported_entries;
                let _ = reply.send(counters);
            }
            Ok(Cmd::StrictWitness {
                account,
                recovery,
                version,
                revoked_at,
                reply,
            }) => {
                let _ = reply
                    .send(rep.account_key_strict_witness(account, recovery, version, revoked_at));
            }
            Ok(Cmd::AccountKey(op, current, reply)) => {
                if !account_key_allowed(&op, current.as_ref()) {
                    let _ =
                        reply.send(Err(mdbn_replica::replica::AccountKeyRefusal::NotAuthorized));
                } else {
                    let _ = reply.send(match op {
                        AccountKeyOp::Status(r) => {
                            rep.account_key_device_keyed(&r.derive(&collection))
                        }
                        AccountKeyOp::Key(r) => rep
                            .key_account_key_device(&r.derive(&collection))
                            .map(|()| false),
                        AccountKeyOp::Unlock(r) => rep
                            .self_grant_with_account_key(r.derive(&collection))
                            .map(|()| true),
                        AccountKeyOp::Unlocked => rep.account_key_unlock_state(),
                        AccountKeyOp::CanKey => rep.account_key_can_key(),
                        // Never enrolled here: no account-key device to revoke.
                        AccountKeyOp::RevokedAndRekeyed(d) => {
                            Ok(rep.account_key_revoked_and_rekeyed(&d).unwrap_or(true))
                        }
                    });
                }
            }
            Ok(Cmd::FsWake) => {
                if let Some(w) = &watcher {
                    let events = w.take();
                    tracing::debug!(events = events.len(), "watcher batch");
                    if !events.is_empty() {
                        rep.store_mut().inner_mut().on_events(&events);
                        // After this batch's own quiescence window.
                        observe_due = Some(std::time::Instant::now() + WATCH_SETTLE);
                    }
                }
            }
            Ok(Cmd::Stop(done)) => {
                // Classify original in-flight outcomes while the Store is still
                // alive, before cancellation/join drops the transport and actor.
                if let Some(session) = active_log.take() {
                    rep.retire_authenticated_log(session.authenticated());
                }
                for s in outs.keys().copied().collect::<Vec<_>>() {
                    frames.close(&mut rep, s);
                }
                drop(watcher);
                drop(link);
                drop(rep);
                let _ = done.send(());
                return;
            }
            Err(std_mpsc::RecvTimeoutError::Timeout) => {}
            Err(std_mpsc::RecvTimeoutError::Disconnected) => return,
        }
        if observe_due.is_some_and(|d| std::time::Instant::now() >= d) {
            // Watcher-queued paths whose quiescence window has passed.
            observe_due = None;
            tracing::debug!("watcher observe");
            if let Err(e) = rep.observe(None) {
                tracing::warn!(error = ?e, "observe failed");
            }
            log_retention_reclaims(&mut rep);
            // Paths still inside their quiescence window: observe again when due.
            if let Some(t) = rep.store_mut().inner_mut().next_wakeup() {
                let now = crate::fsutil::now_ms() as u64;
                observe_due = Some(
                    std::time::Instant::now() + Duration::from_millis(t.saturating_sub(now).max(5)),
                );
            }
        }
        if last_observe.elapsed() >= observe_every {
            // No watcher yet: `observe(None)` only walks the folder when a rescan is
            // requested; without one, external edits were never seen.
            rep.store_mut().inner_mut().request_rescan();
            if let Err(e) = rep.observe(None) {
                tracing::warn!(error = ?e, "observe failed");
            }
            log_retention_reclaims(&mut rep);
            last_observe = std::time::Instant::now();
        }
        let now_ms = crate::fsutil::now_ms() as u64;
        if lease_checked != 0 && now_ms >= lease_checked {
            rep.grants_changed(); // the lease lapsed: sessions under it close now
            lease_checked = 0;
        }
        rep.tick();
        frames.tick(&mut rep, crate::fsutil::now_ms() as i64);
        frames.pump(&mut rep);
        if let Some(link) = &link {
            send_log_calls(&mut rep, link, &mut active_log);
            if last_status.elapsed() >= Duration::from_secs(5) {
                last_status = std::time::Instant::now();
                let st = rep.sync_status();
                tracing::debug!(
                    confirmed_through = st.confirmed_through,
                    head_known = st.head_known,
                    pending = st.pending,
                    holds = st.holds,
                    unresolved = st.unresolved,
                    connection = ?st.connection,
                    incidents = ?st.incidents,
                    "synced status"
                );
            }
        }
        for (s, bytes) in frames.take_outgoing() {
            if let Some(o) = outs.get(&s)
                && o.send(bytes).is_err()
            {
                frames.close(&mut rep, s);
            }
        }
        for s in frames.take_closed() {
            outs.remove(&s);
        }
        // Sessions closed by a grant change have been told before it is answered.
        for a in acks.drain(..) {
            let _ = a.send(());
        }
    }
}

/// No remote incident details are included in control telemetry.
fn sync_counters(
    status: &mdbn_wire::client::SyncStatus,
    caught_up: bool,
    head_digest: Option<String>,
    records: Option<(u64, [u8; 32])>,
) -> crate::control::SyncCounters {
    use mdbn_wire::client::{Connection, IncidentKind as K, SyncMode};
    let incident_code = |kind| match kind {
        K::UpgradeRequired => "upgrade_required",
        K::WaitingForKey => "waiting_for_key",
        K::Integrity => "integrity",
        K::AccessRevoked => "access_revoked",
        K::QuotaExceeded => "quota_exceeded",
        K::ReadOnly => "read_only",
        K::VerificationMismatch => "verification_mismatch",
        K::VoidedItems => "voided_items",
        K::KeyInconsistent => "key_inconsistent",
        K::ForeignSyncTool => "foreign_sync_tool",
        K::Gone => "gone",
        K::LostEntries => "lost_entries",
        K::LogRegressed => "log_regressed",
    };
    crate::control::SyncCounters {
        confirmed_through: status.confirmed_through,
        head_known: status.head_known,
        pending: status.pending,
        holds: status.holds,
        unresolved: status.unresolved,
        connection: match status.connection {
            Connection::Online => "online",
            Connection::Connecting => "connecting",
            Connection::Offline => "offline",
        }
        .into(),
        head_digest,
        confirmed_record_digest: records.map(|(count, hash)| {
            crate::control::ConfirmedRecordDigest {
                algorithm: "sha256-confirmed-record-tuples-v1".into(),
                records: count,
                digest: crate::secrets::hex(&hash),
                confirmed_through: status.confirmed_through,
            }
        }),
        last_error: status
            .incidents
            .last()
            .map(|i| incident_code(i.kind).into()),
        resyncing: status.installing.is_some()
            || status.resyncing.is_some()
            || (status.mode == SyncMode::Synced
                && (status.confirmed_through == 0
                    || !caught_up
                    || status.head_known > status.confirmed_through)),
        unsupported_entries: 0,
    }
}

#[cfg(test)]
#[path = "runtime_telemetry_tests.rs"]
mod telemetry_tests;

#[cfg(test)]
#[path = "runtime_log_tests.rs"]
mod log_tests;

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn account_key_effect_requires_live_guard_not_a_queued_authorization() {
        use std::sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        };
        let live = Arc::new(AtomicBool::new(true));
        let current = live.clone();
        let guard: super::AccountKeyGuard = Arc::new(move || current.load(Ordering::SeqCst));
        let key = super::AccountKeyOp::Key(
            mdbn_replica::crypto::recovery::RecoveryKey::from_bytes([61; 32]),
        );
        assert!(!super::account_key_allowed(&key, None));
        assert!(super::account_key_allowed(&key, Some(&guard)));
        tokio::task::yield_now().await;
        live.store(false, Ordering::SeqCst);
        assert!(!super::account_key_allowed(&key, Some(&guard)));
        assert!(!super::account_key_allowed(
            &super::AccountKeyOp::CanKey,
            Some(&guard)
        ));
        assert!(super::account_key_allowed(
            &super::AccountKeyOp::CanKey,
            None
        ));
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
        struct NoGrants;
        impl mdbn_replica::policy::GrantSource for NoGrants {
            fn grant(
                &self,
                _: &mdbn_wire::common::Uuid,
            ) -> Option<mdbn_replica::policy::EffectiveGrant> {
                None
            }
        }
        let dir = crate::testutil::TestDir::new("desktop-query-profile");
        let state = crate::testutil::TestDir::new("desktop-query-state");
        let cfg = super::RuntimeConfig {
            collection: [1; 16],
            replica_id: [2; 16],
            device_id: [3; 16],
            root: dir.path().to_path_buf(),
            private_dir: state.path().to_path_buf(),
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
