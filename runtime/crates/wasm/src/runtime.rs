//! The runtime behind the JS-facing ABI: one replica plus the frame layer
//! ([`mdbn_replica::frames`]).
//!
//! JS sees sessions and encoded frames only (`replica-client-api.md` §12.1): the TS
//! SDK's in-process port encodes frames into the runtime and decodes what
//! [`Runtime::poll`] returns. Everything here is portable and deterministic; the
//! `abi` module in `lib.rs` is a thin `extern "C"` shell over it, so native tests run
//! the same code as `runtime.wasm`.
//!
//! **Store.** The legacy encoded open/ABI still uses `MemStore`. Trusted composition
//! points can supply a `Store` and the complete `ReplicaConfig` with [`Runtime::compose`].
//! This does not activate a browser SQL store or lift snapshot/durability gates.

use mdbn_replica::api::SessionAuth;
use mdbn_replica::frames::Frames;
use mdbn_replica::log::{CallId, LogCall, LogPort, LogPush, LogReply};
use mdbn_replica::mem::MemStore;
use mdbn_replica::plan::CorePlanner;
use mdbn_replica::store::Store;
use mdbn_replica::{DeviceSecrets, Host, QueryExecutionProfile, Replica, ReplicaConfig};
use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::client::SyncMode;
use mdbn_wire::common::{B16, B32, Uuid};
use mdbn_wire::schema::Wire;

/// ABI major version. Bumped when an export's meaning changes; the shared-runtime
/// registry keys instances by it (`globalThis.__mdbase_runtime__`).
pub const ABI_MAJOR: u64 = 1;

/// Client API versions this runtime serves: `[major, minor]`, highest first.
pub const API_SERVES: &[(u64, u64)] = &[(1, 0)];

/// The runtime's version, reported in `hello` and `info`.
pub const RUNTIME_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Why `open` failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenFailure(pub String);

fn uuid_at(m: &[(Cbor, Cbor)], k: u64, what: &str) -> Result<Uuid, OpenFailure> {
    let v = m
        .iter()
        .find(|(key, _)| *key == Cbor::Uint(k))
        .map(|(_, v)| v)
        .ok_or_else(|| OpenFailure(format!("missing {what}")))?;
    B16::from_cbor(v).map_err(|e| OpenFailure(format!("{what}: {e}")))
}

fn key_at(m: &[(Cbor, Cbor)], k: u64, what: &str) -> Result<[u8; 32], OpenFailure> {
    let v = m
        .iter()
        .find(|(key, _)| *key == Cbor::Uint(k))
        .map(|(_, v)| v)
        .ok_or_else(|| OpenFailure(format!("missing {what}")))?;
    B32::from_cbor(v)
        .map(|b| b.0)
        .map_err(|e| OpenFailure(format!("{what}: {e}")))
}

/// Overwrite a buffer that held key material, so it doesn't linger in linear memory
/// after it is freed. `black_box` keeps the writes from being
/// optimised away as dead stores.
pub fn wipe(buf: &mut [u8]) {
    for b in buf.iter_mut() {
        *b = 0;
    }
    std::hint::black_box(buf);
}

/// [`wipe`] every byte string in a decoded item.
fn wipe_cbor(c: &mut Cbor) {
    match c {
        Cbor::Bytes(b) => wipe(b),
        Cbor::Array(a) => a.iter_mut().for_each(wipe_cbor),
        Cbor::Map(m) => m.iter_mut().for_each(|(_, v)| wipe_cbor(v)),
        _ => {}
    }
}

/// `info()`: what the shared-runtime registry needs, with no out-of-band metadata.
/// `{0: abi major, 1: runtime version, 2: sem [major, minor], 3: [[major, minor]] API versions served}`.
pub fn info() -> Vec<u8> {
    let sem = mdbn_core::semantics::SEM;
    let v = Cbor::Map(vec![
        (Cbor::Uint(0), Cbor::Uint(ABI_MAJOR)),
        (Cbor::Uint(1), Cbor::Text(RUNTIME_VERSION.into())),
        (
            Cbor::Uint(2),
            Cbor::Array(vec![Cbor::Uint(sem.major), Cbor::Uint(sem.minor)]),
        ),
        (
            Cbor::Uint(3),
            Cbor::Array(
                API_SERVES
                    .iter()
                    .map(|(a, b)| Cbor::Array(vec![Cbor::Uint(*a), Cbor::Uint(*b)]))
                    .collect(),
            ),
        ),
    ]);
    cbor::encode(&v).unwrap_or_default()
}

/// One hosted collection in this runtime instance.
pub struct Runtime<S: Store = MemStore> {
    replica: Replica<S>,
    frames: Frames,
}

impl<S: Store> std::fmt::Debug for Runtime<S> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Runtime").finish_non_exhaustive()
    }
}

/// Output of [`Runtime::poll`].
#[derive(Debug, Clone, PartialEq)]
pub enum Out {
    /// An encoded frame for a session.
    Frame(u64, Vec<u8>),
    /// The runtime closed this session; the host closes its port.
    Closed(u64),
}

impl Runtime {
    /// Open from an encoded config:
    /// `{0: collection, 1: replica_id, 2: device_id, 3: mode (0 local-only, 1 synced),
    /// 4: sign_sk (32 bytes), 5: kem_sk (32 bytes), ? 6: e2e (bool),
    /// ? 7: desktop query profile (bool, default false)}`.
    ///
    /// Key 7: the runtime is `MemoryConstrained` by default (mobile/webview);
    /// desktop hosts pass `true` to select Replica's `Desktop` profile, which
    /// keeps the unbudgeted fallback scan for now.
    ///
    /// The device secrets come from the host's key storage (never the vault) and
    /// live only in this instance's memory.
    pub fn open(config: &[u8], host: Host) -> Result<Runtime, OpenFailure> {
        Self::open_with_query_profile(config, host, QueryExecutionProfile::MemoryConstrained)
    }

    /// Trusted host initialization only; selected before any session is exposed.
    /// This policy selection does not qualify aggregate or transient heap use.
    pub fn open_with_query_profile(
        config: &[u8],
        host: Host,
        profile: QueryExecutionProfile,
    ) -> Result<Runtime, OpenFailure> {
        let mut c = cbor::decode(config).map_err(|e| OpenFailure(format!("config: {e}")))?;
        let r = Self::open_parsed(&c, host, profile);
        // The decoded copy held the device keys too.
        wipe_cbor(&mut c);
        r
    }

    /// The ABI's consuming bootstrap path. Fixed tags, no config/wire slot.
    /// Every ordinary return wipes the encoded keys, including invalid tags.
    pub fn open_consuming(
        config: &mut [u8],
        host: Host,
        profile_tag: u32,
    ) -> Result<Runtime, OpenFailure> {
        let result = match profile_tag {
            0 => Self::open_with_query_profile(
                config,
                host,
                QueryExecutionProfile::MemoryConstrained,
            ),
            1 => Self::open_with_query_profile(config, host, QueryExecutionProfile::Desktop),
            _ => Err(OpenFailure("unknown query execution profile".into())),
        };
        wipe(config);
        result
    }

    fn open_parsed(
        c: &Cbor,
        host: Host,
        profile: QueryExecutionProfile,
    ) -> Result<Runtime, OpenFailure> {
        let Cbor::Map(m) = c else {
            return Err(OpenFailure("config must be a struct map".into()));
        };
        let mode = match m.iter().find(|(k, _)| *k == Cbor::Uint(3)).map(|(_, v)| v) {
            Some(Cbor::Uint(0)) => SyncMode::LocalOnly,
            Some(Cbor::Uint(1)) | None => SyncMode::Synced,
            Some(_) => return Err(OpenFailure("unknown mode".into())),
        };
        let cfg = ReplicaConfig {
            collection: uuid_at(m, 0, "collection")?,
            replica_id: uuid_at(m, 1, "replica_id")?,
            device_id: uuid_at(m, 2, "device_id")?,
            mode,
            log_endpoint: mdbn_replica::log::EndpointId(0),
            verify: false,
            runtime_version: RUNTIME_VERSION.into(),
            trusted_roots: Vec::new(),
            trusted_signers: Vec::new(),
            user_enabled_cloud_copy: false,
            chosen_state: None,
            key_grants_only: false,
            expected_genesis: None,
            policy_pins: None,
            // Config key 6 (default false): an end-to-end (private) collection.
            e2e: matches!(
                m.iter().find(|(k, _)| *k == Cbor::Uint(6)).map(|(_, v)| v),
                Some(Cbor::Bool(true))
            ),
        };
        // The generic runtime carries no trust anchors, so it opens local-only
        // collections only; a synced open is refused here, before any key is
        // decoded (synced app collections open through `app`, which pins).
        cfg.validate_host_trust()
            .map_err(|e| OpenFailure(format!("host trust: {e}")))?;
        let secrets = DeviceSecrets {
            sign_sk: key_at(m, 4, "sign_sk")?,
            kem_sk: key_at(m, 5, "kem_sk")?,
        };
        Self::compose(cfg, MemStore::new(), host, secrets, profile)
    }
}

impl<S: Store> Runtime<S> {
    /// Trusted Rust composition point for one first-party host. The supplied store
    /// and full configuration are used as-is: never replaced with a fresh MemStore
    /// or stripped of pinned identity/policy/genesis choices. Configuration is not
    /// an app/grant RPC; its provenance and the store's qualification belong to the
    /// caller. Uses the production planner/sealer and existing Replica::open gates.
    pub fn compose(
        cfg: ReplicaConfig,
        store: S,
        host: Host,
        secrets: DeviceSecrets,
        profile: QueryExecutionProfile,
    ) -> Result<Self, OpenFailure> {
        // No epoch key is preloaded. Policy and recipient commitments must be
        // verified by the replica before it learns any collection key.
        let sealer = mdbn_replica::seal::KeyringSealer::new(
            cfg.collection,
            cfg.device_id,
            &secrets.sign_sk,
            &secrets.kem_sk,
        );
        let mut replica = Replica::open(
            cfg,
            store,
            Box::new(CorePlanner),
            Box::new(sealer),
            host,
            secrets,
        )
        .map_err(|e| OpenFailure(format!("{e:?}")))?;
        replica.set_query_execution_profile(profile);
        Ok(Runtime {
            replica,
            frames: Frames::new(),
        })
    }

    /// Crate-local trusted app composition, not an RPC or a ready setter.
    #[cfg(feature = "app-runtime")]
    pub(crate) fn replica_mut(&mut self) -> &mut Replica<S> {
        &mut self.replica
    }

    /// Read-only host observations; they cannot promote a pending edit to saved.
    pub fn host_observations(&self) -> (mdbn_wire::client::SyncStatus, bool, bool, bool, bool) {
        (
            self.replica.sync_status(),
            self.replica.keyring_rebuilding(),
            self.replica.keyring_rebuild_failed(),
            self.replica.snapshot_install_available(),
            self.replica.requires_reopen(),
        )
    }

    /// Trusted host observation; there is no post-open profile setter or app RPC.
    pub fn query_execution_profile(&self) -> QueryExecutionProfile {
        self.replica.query_execution_profile()
    }

    /// Consume the stopped host and recover its owned store. The caller must close
    /// external transports first; this is not an export of replica/device keys.
    pub fn into_store(self) -> S {
        self.replica.into_store()
    }

    /// Open a session for the hosting app (no grant) or a granted plugin, from an
    /// encoded `hello` request. Returns the session (0 = refused) and the encoded
    /// response to deliver as the port's first frame.
    pub fn hello(&mut self, grant: Option<(Uuid, [u8; 32])>, frame: &[u8]) -> (u64, Vec<u8>) {
        let auth = match grant {
            None => SessionAuth::Host,
            Some((grant, client_pk)) => SessionAuth::Grant { grant, client_pk },
        };
        let out = self.frames.hello(&mut self.replica, auth, frame);
        (out.session.map_or(0, |s| s.0), out.response)
    }

    /// A frame from a session's client.
    pub fn frame(&mut self, session: u64, frame: &[u8]) {
        self.frames
            .on_frame(&mut self.replica, mdbn_replica::SessionId(session), frame);
    }

    /// The client's port closed.
    pub fn close(&mut self, session: u64) {
        self.frames
            .close(&mut self.replica, mdbn_replica::SessionId(session));
    }

    /// Run timers: the replica's own wakeups and `await` timeouts.
    pub fn tick(&mut self, now_ms: i64) {
        self.replica.tick();
        self.frames.tick(&mut self.replica, now_ms);
        self.frames.pump(&mut self.replica);
    }

    /// When the host should call [`Runtime::tick`] next (host ms), if at all.
    pub fn next_wakeup(&self) -> Option<i64> {
        self.replica.next_wakeup()
    }

    /// Everything to deliver, in order.
    pub fn poll(&mut self) -> Vec<Out> {
        self.frames.pump(&mut self.replica);
        let mut out: Vec<Out> = self
            .frames
            .take_outgoing()
            .into_iter()
            .map(|(s, b)| Out::Frame(s.0, b))
            .collect();
        out.extend(
            self.frames
                .take_closed()
                .into_iter()
                .map(|s| Out::Closed(s.0)),
        );
        out
    }

    /// [`Runtime::poll`], encoded for the ABI:
    /// `[* [session, frame bytes] / [session, null]]` (null = closed).
    pub fn poll_encoded(&mut self) -> Vec<u8> {
        let items = self
            .poll()
            .into_iter()
            .map(|o| match o {
                Out::Frame(s, b) => Cbor::Array(vec![Cbor::Uint(s), Cbor::Bytes(b)]),
                Out::Closed(s) => Cbor::Array(vec![Cbor::Uint(s), Cbor::Null]),
            })
            .collect();
        cbor::encode(&Cbor::Array(items)).unwrap_or_default()
    }
}

/// Existing sans-I/O log boundary, delegated without interpreting network results.
/// Compatibility delivery does not establish authenticated repair provenance;
/// the host must not treat a reconnect/push as renewed authorization.
impl<S: Store> LogPort for Runtime<S> {
    fn take_log_calls(&mut self) -> Vec<LogCall> {
        self.replica.take_log_calls()
    }

    fn on_log_reply(&mut self, id: CallId, reply: LogReply) {
        self.replica.on_log_reply(id, reply);
    }

    fn on_log_push(&mut self, push: LogPush) {
        self.replica.on_log_push(push);
    }
}
