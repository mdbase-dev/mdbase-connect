//! A local-only replica over the native store, driven synchronously.
//!
//! There is no log, so there is nothing asynchronous to wait for: a submit
//! commits and publishes before it returns, an `observe` ingests outside
//! edits before it returns. What remains are the store's timers (quiet
//! periods, missing-file rechecks, move pairing), which [`LocalReplica::settle`]
//! runs down when a caller wants the folder's final state.

use mdbn_replica::api::{ClientApi, SessionAuth, SessionId};
use mdbn_replica::log::EndpointId;
use mdbn_replica::plan::CorePlanner;
use mdbn_replica::policy::GrantSource;
use mdbn_replica::seal::KeyringSealer;
use mdbn_replica::{
    Host, Push, QueryExecutionProfile, Replica, ReplicaConfig, StoreError, TimeZones,
};
use mdbn_wire::client::{HelloParams, HelloResult, SyncMode};
use mdbn_wire::common::Version;

use crate::Error;
use crate::host::{OsEntropy, SystemClock, SystemZones, now_ms};
use crate::identity::Identity;
use crate::store::NativeStore;

/// How long `rescan` waits for the store's short timers (quiet period,
/// missing-file recheck).
pub const SHORT_TIMERS_MS: u64 = 400;

/// The native replica type.
pub type NativeReplica = Replica<NativeStore>;

/// How to open the replica. Always local-only: a synced replica needs the
/// daemon's authenticated constructor (trusted roots, verification, a log
/// transport), which this helper deliberately does not offer.
pub struct ReplicaOptions {
    /// Reported in `hello` as the runtime version.
    pub runtime_version: String,
    /// The host session's client name and version (diagnostics).
    pub client: (String, String),
    /// Grants for `SessionAuth::Grant` sessions; the host session needs none.
    pub grant_source: Option<Box<dyn GrantSource>>,
    /// Time zones; `None` uses the machine's zone.
    pub zones: Option<Box<dyn TimeZones>>,
}

impl Default for ReplicaOptions {
    fn default() -> Self {
        ReplicaOptions {
            runtime_version: env!("CARGO_PKG_VERSION").to_owned(),
            client: (
                "mdbn-local-host".into(),
                env!("CARGO_PKG_VERSION").to_owned(),
            ),
            grant_source: None,
            zones: None,
        }
    }
}

impl std::fmt::Debug for ReplicaOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ReplicaOptions")
            .field("runtime_version", &self.runtime_version)
            .field("client", &self.client)
            .field("grant_source", &self.grant_source.is_some())
            .finish_non_exhaustive()
    }
}

/// An open local replica with its host session.
pub struct LocalReplica {
    replica: NativeReplica,
    session: SessionId,
    hello: HelloResult,
}

impl std::fmt::Debug for LocalReplica {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LocalReplica")
            .field("session", &self.session)
            .finish_non_exhaustive()
    }
}

impl LocalReplica {
    /// Open the replica over `store` as `identity`, and open the host session.
    pub fn open(
        store: NativeStore,
        identity: &Identity,
        opts: ReplicaOptions,
    ) -> Result<LocalReplica, Error> {
        let cfg = ReplicaConfig {
            collection: identity.collection,
            replica_id: identity.replica_id,
            device_id: identity.device_id,
            mode: SyncMode::LocalOnly,
            log_endpoint: EndpointId(0),
            verify: false,
            runtime_version: opts.runtime_version.clone(),
            trusted_roots: Vec::new(),
            e2e: false,
            trusted_signers: vec![identity.device_id],
            user_enabled_cloud_copy: false,
            chosen_state: None,
            // Local-only: no log, so no genesis to pin.
            expected_genesis: None,
            policy_pins: None,
            key_grants_only: false,
        };
        cfg.validate_host_trust()
            .map_err(|e| Error::Replica(mdbn_replica::replica::OpenError::HostTrust(e)))?;
        let sealer = KeyringSealer::new(
            identity.collection,
            identity.device_id,
            &identity.secrets.sign_sk,
            &identity.secrets.kem_sk,
        );
        let host = Host {
            clock: Box::new(SystemClock),
            entropy: Box::new(OsEntropy),
            zones: opts
                .zones
                .unwrap_or_else(|| Box::new(SystemZones::default())),
        };
        let mut replica = match opts.grant_source {
            Some(source) => Replica::open_with_grant_source(
                cfg,
                store,
                Box::new(CorePlanner),
                Box::new(sealer),
                host,
                identity.secrets.clone(),
                source,
            )?,
            None => Replica::open(
                cfg,
                store,
                Box::new(CorePlanner),
                Box::new(sealer),
                host,
                identity.secrets.clone(),
            )?,
        };
        // A native desktop host: per-record queries keep the unbudgeted scan the
        // memory-constrained default (hosted, WASM, mobile) would refuse.
        replica.set_query_execution_profile(QueryExecutionProfile::Desktop);
        let (session, hello) = replica
            .hello(
                SessionAuth::Host,
                HelloParams {
                    versions: vec![Version { major: 1, minor: 0 }],
                    client_name: opts.client.0,
                    client_version: opts.client.1,
                    features: None,
                    timezone: None,
                },
            )
            .map_err(|e| Error::Identity(format!("host session: {}", e.problem().message)))?;
        Ok(LocalReplica {
            replica,
            session,
            hello,
        })
    }

    /// The host session.
    pub fn session(&self) -> SessionId {
        self.session
    }

    /// What `hello` returned.
    pub fn hello(&self) -> &HelloResult {
        &self.hello
    }

    /// The replica.
    pub fn replica(&mut self) -> &mut NativeReplica {
        &mut self.replica
    }

    /// The replica, shared.
    pub fn replica_ref(&self) -> &NativeReplica {
        &self.replica
    }

    /// Run timers and retries once.
    pub fn tick(&mut self) {
        self.replica.tick();
    }

    /// Pick up outside edits the store already knows about (dirty paths, due
    /// rechecks) and run timers.
    pub fn observe(&mut self) -> Result<(), StoreError> {
        self.replica.observe(None)?;
        self.replica.tick();
        Ok(())
    }

    /// Walk the whole folder for outside edits, then run the short timers
    /// (the quiet period and missing-file recheck, under half a second), so a
    /// file written just before the call is in. Deletions and moves may need
    /// [`LocalReplica::settle`].
    pub fn rescan(&mut self) -> Result<(), StoreError> {
        self.replica.store_mut().request_rescan();
        self.settle_until(now_ms().saturating_add(SHORT_TIMERS_MS))?;
        Ok(())
    }

    /// The next time (Unix ms) the store or replica wants to run, if any.
    pub fn next_wakeup_ms(&self) -> Option<u64> {
        let s = self.replica.store().next_wakeup();
        let r = self
            .replica
            .next_wakeup()
            .and_then(|t| u64::try_from(t).ok());
        match (s, r) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        }
    }

    /// Run observe/tick until no wakeup is due, waiting for timers up to
    /// `max_wait_ms` in total. Returns whether everything settled.
    pub fn settle(&mut self, max_wait_ms: u64) -> Result<bool, StoreError> {
        self.settle_until(now_ms().saturating_add(max_wait_ms))
    }

    /// Like [`LocalReplica::settle`], but only runs wakeups due before
    /// `deadline` (Unix ms); later timers (move pairing, long rechecks) are
    /// left alone. Returns whether nothing is due before the deadline.
    pub fn settle_until(&mut self, deadline: u64) -> Result<bool, StoreError> {
        loop {
            self.observe()?;
            let Some(next) = self.next_wakeup_ms() else {
                return Ok(true);
            };
            let now = now_ms();
            if next > deadline {
                return Ok(false);
            }
            if next > now {
                std::thread::sleep(std::time::Duration::from_millis((next - now).clamp(1, 250)));
            }
        }
    }

    /// Pushes for the host session (other sessions' pushes are dropped here;
    /// a host serving apps drains `take_pushes` itself).
    pub fn pushes(&mut self) -> Vec<Push> {
        self.replica
            .take_pushes()
            .into_iter()
            .filter(|(s, _)| *s == self.session)
            .map(|(_, p)| p)
            .collect()
    }

    /// Close the host session and give back the replica.
    pub fn close(mut self) -> NativeReplica {
        self.replica.close(self.session);
        self.replica
    }
}
