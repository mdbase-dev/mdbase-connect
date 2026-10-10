//! The replica service: one per collection per device (or one hosted).
//!
//! **Driving it.** A replica is a synchronous state machine, single-threaded per
//! collection. Its host:
//! 1. opens it with a [`Store`], a [`Planner`] (the core's), a [`Sealer`] (keyring
//!    and crypto), a [`Host`] (clock, entropy, time zones) and the device secrets;
//! 2. calls the client API ([`crate::ClientApi`]) for its apps, and drains pushes;
//! 3. moves log calls and replies ([`LogPort`]), synchronously with
//!    [`crate::log::pump`] or through an async transport;
//! 4. feeds file observations ([`Replica::observe`], file-backed stores);
//! 5. calls [`Replica::tick`] when [`Replica::next_wakeup`] says so.
//!
//! Nothing here reads a clock or entropy except through [`Host`], so the simulator
//! reproduces any run from its seed.
//!
//! | File | What |
//! |---|---|
//! | `mod.rs` | state, open, local view, helpers |
//! | `submit.rs` | capture and optimistic planning (`replica-client-api.md` §5) |
//! | `append.rs` | the append loop (`log-entry.md` §3) and log replies |
//! | `apply.rs` | applying items: integrity, stall, void, effects, receipts, rebase (§4) |
//! | `base.rs` | the generation-0 `base` item: build and import/install validity (`snapshot.md` §7) |
//! | `client.rs` | the [`crate::ClientApi`] implementation |
//! | `hosted.rs` | hosted mode: log-ACK barrier, RAM-only pending, log-derived receipts |

mod account_key;
pub use account_key::{AccountKeyRefusal, StrictWitness};
mod admission;
pub(crate) mod append;
pub(crate) mod attachment_fetch;
mod attachment_ingest;
pub(crate) mod attachment_inventory;
mod attachment_runtime;
pub(crate) mod attachment_upload;
mod bases;
mod collection_setup;
pub use bases::{
    BasesDiscoveryHandle, BasesDiscoveryPage, BasesExecutionGroup, BasesExecutionPolicies,
    BasesExecutionResult, BasesExecutionRow, BasesExecutionWindow, BasesGroupPlacement,
    BasesImplementationDescriptor, BasesReadRequest, BasesViewDescriptor, BasesViewSelection,
    BasesViewSource, BasesWindowInfo, CapturedBasesDiscovery, CapturedBasesExecutionInputs,
};
pub(crate) mod unindexed_apply;
mod unindexed_blob_fetch;
mod unindexed_cache;
mod unindexed_capture;
mod unindexed_capture_runtime;
pub(crate) mod unindexed_inventory;
mod unindexed_move;
mod unindexed_reindex;
mod unindexed_reverse_capture;
mod unindexed_reverse_entry;
mod unindexed_reverse_text;
mod unindexed_reverse_upload;
mod unindexed_snapshot;
pub use unindexed_reverse_upload::PreparedUnindexedReindexUpload;
mod unindexed_source;
pub use unindexed_reindex::PreparedUnindexedReindex;
mod unindexed_upload;
pub use unindexed_upload::{PreparedUnindexedUpload, UnindexedUploadStatus};
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod unindexed_source_tests;
pub use append::ESCROW_GRANT_AFTER_MS;
pub use attachment_fetch::AttachmentFetchStatus;
pub use attachment_upload::{
    AttachmentSource, AttachmentUploadCheckpoint, AttachmentUploadParams, AttachmentUploadStatus,
    HostedAttachmentTransferParams, HostedAttachmentTransferProgress,
};
pub use collection_setup::{
    CollectionSetupSession, PreparedCollectionSetupPlan, PreparedCollectionSetupReview,
    SetupCaptureFence, SetupCapturedInventory, SetupSourceRead,
};
pub use unindexed_capture::{PreparedUnindexedCapture, UnindexedCaptureTarget};
pub use unindexed_source::{
    AuthenticatedUnindexedSource, UnindexedSourceError, UnindexedSourceNeed, UnindexedSourceReader,
};
#[cfg(not(test))]
mod apply;
#[cfg(test)]
pub(crate) mod apply;
pub(crate) mod apply_checkpoint;
mod approval_peer;
mod approval_requester;
mod approval_runtime;
pub mod base;
mod client;
mod disk;
pub mod gen0;
mod handover;
mod hosted;
mod hosted_attachment_read;
pub use hosted_attachment_read::HostedAttachmentRead;
mod hosted_attachment_upload;
mod join_ahead;
mod key_rebuild;
pub use join_ahead::KeyWaitReason;
mod key_wait;
#[cfg(test)]
pub(crate) use disk::DiskKey;
mod latch;
mod live;
pub use latch::Latch;
mod local;
mod mirror_install;
mod query_cursor;
mod query_driver;
pub use query_driver::{Decline as QueryDecline, QueryStats};
mod log_session;
mod lost_tail;
mod orphans;
pub use lost_tail::{RepairPhase, RepairStats, RepairStatus};
/// `REPAIR_REFS_WAIT` (§4.1), for tests and sim.
pub fn lost_tail_refs_wait_ms() -> i64 {
    lost_tail::REPAIR_REFS_WAIT_MS
}
pub use orphans::{ORPHAN_GRACE_MS, Orphan};
mod query_index;
mod query_profile;
mod record_admission;
pub(crate) mod ref_index;
mod repair;
pub(crate) mod snapshot;
mod snapshot_text;
#[cfg(test)]
pub(crate) use snapshot::Install as TestInstall;
mod submit;

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use mdbn_core::host::Clock;
use mdbn_core::types::Catalog;
use mdbn_wire::client::{Connection, Incident, IncidentKind, SyncMode};
use mdbn_wire::common::{B16, Uuid};

use crate::api::{Push, SessionAuth, SessionId};
use crate::convert;
use crate::layer::Layer;
use crate::log::{CallId, EndpointId, LogCall, LogRequest};
use crate::plan::{Planner, StoreView, TouchIndex};
use crate::seal::Sealer;
use crate::store::{Head, Page, PendingRow, Store, StoreError, meta_keys};

pub use admission::{
    HostedAdmission, HostedAdmissionDenial, HostedBootstrapAdmission, HostedKeyOperationDenial,
    VerifiedHostedAdmission, VerifiedHostedBootstrap, VerifiedHostedKeyRecipient,
};
pub use append::AppendTuning;
pub use approval_peer::{ApprovalPeerEnvelope, ApprovalPeerMessage, MAX_APPROVAL_PEER_BYTES};
pub use approval_requester::{
    ApprovalPersistenceError, ApprovalSecretJournal, RequesterApprovalReveal,
};
pub use approval_runtime::{
    ApprovalAuthorityStamp, ApprovalBinding, ApprovalChallenge, ApprovalDevice,
    ApprovalDisposition, ApprovalIntent, ApprovalRefusal, ApprovalReveal, ApproverCode,
};
pub use disk::PUBLISH_WAIT_MS;
#[cfg(test)]
pub(crate) use hosted::HOSTED_READ_BYTES;
#[allow(unused_imports)]
pub(crate) use hosted::{FreshHead, PolicyOrigin};
pub use hosted::{HostedAck, HostedCache, HostedProfile, SubmitTicket};
pub use log_session::{AuthenticatedLogSession, LogReplyScope, LogSessionError};
pub use query_profile::{QueryExecutionProfile, QuerySourceLimits};
pub use snapshot::{MAX_REQUEST_NODES, SnapshotBlocked, snapshot_refs_fit, state_digest};

/// Static configuration of one replica.
#[derive(Debug, Clone, PartialEq)]
pub struct ReplicaConfig {
    /// Collection ID.
    pub collection: Uuid,
    /// This replica's ID (`intent.md` `origin`; minted when its state is created).
    pub replica_id: Uuid,
    /// This device's ID (the signing identity).
    pub device_id: Uuid,
    /// Local only (embedded log) or synced (hosted log). Reported in status; the
    /// replica behaves the same either way, because every collection has a log.
    pub mode: SyncMode,
    /// The log endpoint at open (the host's label for where the log lives).
    pub log_endpoint: EndpointId,
    /// Re-execute others' entries to verify them (`log-entry.md` §5). The hosted
    /// replica always verifies; devices verify when idle.
    pub verify: bool,
    /// Runtime version, reported in `hello`.
    pub runtime_version: String,
    /// Control-plane root keys this runtime trusts (`policy.md` §2).
    pub trusted_roots: Vec<[u8; 32]>,
    /// The end-to-end (private) state: entries are sealed without compression.
    /// Policy can only tighten it: compression is also off whenever the
    /// log is `e2e` or its policy says `compress: false`.
    pub e2e: bool,
    /// Devices this device's user approved (SAS) or that are this user's own: the
    /// device-local trust roots for keys (`sealed-envelope.md` §5.2).
    pub trusted_signers: Vec<Uuid>,
    /// This device's user turned the cloud copy on: only then is a
    /// key delivered by the escrow trusted.
    pub user_enabled_cloud_copy: bool,
    /// The collection state the user chose for this collection, when known. A log
    /// whose genesis says otherwise is not served.
    pub chosen_state: Option<mdbn_wire::policy::CState>,
    /// Emission profile of a minimal escrow deployment: the only control items this
    /// replica appends are fallback key grants (never an initial or later rekey).
    /// A deployment restriction, not a policy rule; `false` everywhere else.
    pub key_grants_only: bool,
    /// The chain hash of the collection's genesis (seq 1), when the host pinned it at
    /// join or create (from locally persisted state, never the log). An applied or
    /// installed seq 1 that differs is an integrity incident: a different log is
    /// never served.
    pub expected_genesis: Option<mdbn_wire::common::Hash>,
    /// The control-plane keys an authenticated release publishes for this
    /// environment. When set, every policy item (applied, replayed or installed)
    /// must be certified by a pinned root for a pinned policy key, and a reopened
    /// store must have been built under them. `None` keeps today's behaviour; a
    /// native synced host requires them (its own validation).
    pub policy_pins: Option<crate::policy::PolicyPins>,
}

impl ReplicaConfig {
    /// Fail-closed host trust-shape validation before opening a synced transport.
    /// The host MUST load roots, SAS/local-creation signers and chosen state from
    /// local persistence, never infer them from remote policy. This checks shape
    /// and consistency, not the provenance of those host-supplied trust anchors.
    pub fn validate_host_trust(&self) -> Result<(), &'static str> {
        if self.mode == SyncMode::LocalOnly {
            if self.chosen_state.is_some() || self.e2e || self.user_enabled_cloud_copy {
                return Err("local-only configuration carries synced trust choices");
            }
            return Ok(());
        }
        let chosen = self
            .chosen_state
            .ok_or("synced collection requires persisted chosen_state")?;
        if self.trusted_roots.is_empty() {
            return Err("synced collection requires pinned trust roots");
        }
        if self.e2e != (chosen == mdbn_wire::policy::CState::E2e) {
            return Err("e2e flag differs from persisted chosen_state");
        }
        if self.user_enabled_cloud_copy && chosen != mdbn_wire::policy::CState::CloudCopy {
            return Err("cloud-copy opt-in differs from persisted chosen_state");
        }
        Ok(())
    }
}

/// The device's private keys (`sealed-envelope.md` §5.1). Key storage per platform
/// is the host's business; the replica only uses them.
#[derive(Clone, PartialEq, Eq)]
pub struct DeviceSecrets {
    /// Ed25519 signing key seed.
    pub sign_sk: [u8; 32],
    /// X25519 KEM private key (HPKE unwrap of epoch keys).
    pub kem_sk: [u8; 32],
}

impl std::fmt::Debug for DeviceSecrets {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("DeviceSecrets(..)")
    }
}

impl Drop for DeviceSecrets {
    fn drop(&mut self) {
        // Best-effort wipe until the crypto module's `zeroize` types replace these
        // fields. A plain write may be elided by the optimizer.
        self.sign_sk = [0; 32];
        self.kem_sk = [0; 32];
    }
}

/// Calendar dates in IANA time zones (`intent.md` §4.1). The origin computes
/// `local_date` once at capture; replay never converts zones. Hosts supply a real
/// implementation (ICU/`Intl` in JS, a tz database natively).
pub trait TimeZones {
    /// `YYYY-MM-DD` of `instant_ms` in `tz`, or `None` for an unknown zone.
    fn local_date(&self, instant_ms: i64, tz: &str) -> Option<String>;
    /// The runtime default zone.
    fn default_zone(&self) -> String;
}

/// Knows only UTC. Tests and hosts without a tz database.
#[derive(Debug, Clone, Copy, Default)]
pub struct UtcOnly;

impl TimeZones for UtcOnly {
    fn local_date(&self, instant_ms: i64, tz: &str) -> Option<String> {
        if tz != "UTC" && tz != "Etc/UTC" {
            return None;
        }
        Some(utc_date(instant_ms))
    }
    fn default_zone(&self) -> String {
        "UTC".to_string()
    }
}

/// `YYYY-MM-DD` of an instant in UTC (proleptic Gregorian).
pub fn utc_date(instant_ms: i64) -> String {
    let days = instant_ms.div_euclid(86_400_000);
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

/// Injected host capabilities. The only source of time and randomness.
pub struct Host {
    /// Wall clock.
    pub clock: Box<dyn Clock>,
    /// CSPRNG seed source (seeds, salts, IDs; never a configured seed).
    pub entropy: Box<dyn crate::crypto::CsprngEntropy>,
    /// Time zones for `local_date`.
    pub zones: Box<dyn TimeZones>,
}

impl std::fmt::Debug for Host {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Host(..)")
    }
}

/// Why a replica could not open.
#[derive(Debug, Clone, PartialEq)]
pub enum OpenError {
    /// The store failed.
    Store(StoreError),
    /// The store belongs to another collection or replica.
    Mismatch(String),
    /// A stored row could not be decoded.
    Corrupt(String),
    /// The host's trust configuration is inconsistent
    /// ([`ReplicaConfig::validate_host_trust`]); nothing was read.
    HostTrust(&'static str),
}

impl From<StoreError> for OpenError {
    fn from(e: StoreError) -> OpenError {
        OpenError::Store(e)
    }
}

/// Where a log move stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LogMove {
    None,
    Draining,
    Verifying,
}

/// Counters, reported in status and to the host.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Stats {
    /// Items applied.
    pub applied: u64,
    /// Void items.
    pub voided: u64,
    /// Entries re-executed and matching.
    pub verified: u64,
    /// Entries re-executed and differing.
    pub verify_mismatch: u64,
    /// Entries of another `sem`, not re-executed.
    pub unverified: u64,
    /// Appends sent (batches).
    pub appends: u64,
    /// `head_moved` results.
    pub head_moved: u64,
    /// Pending rows re-planned by rebase.
    pub replanned: u64,
    /// Snapshots built and registered.
    pub snapshots_built: u64,
    /// Snapshots installed.
    pub snapshots_installed: u64,
    /// Snapshot builds refused because their refs inventory cannot fit one
    /// log-service request ([`SnapshotBlocked::FrameCap`]).
    pub snapshot_builds_refused: u64,
    /// Records re-typed because the catalog changed after they were indexed.
    pub reindexed: u64,
}

/// A client session.
#[derive(Debug, Clone)]
pub(crate) struct Session {
    pub(crate) auth: SessionAuth,
    pub(crate) tz: Option<String>,
    pub(crate) status_sub: bool,
    pub(crate) holds_sub: bool,
    pub(crate) conflicts_sub: bool,
}

impl Session {
    pub(crate) fn grant(&self) -> Option<Uuid> {
        match &self.auth {
            SessionAuth::Host => None,
            SessionAuth::Grant { grant, .. } => Some(*grant),
        }
    }
}

/// The replica service for one collection.
pub struct Replica<S: Store> {
    pub(crate) cfg: ReplicaConfig,
    pub(crate) store: S,
    pub(crate) planner: Box<dyn Planner>,
    pub(crate) sealer: Box<dyn Sealer>,
    pub(crate) host: Host,
    #[allow(dead_code)]
    pub(crate) secrets: DeviceSecrets,
    pub(crate) tuning: AppendTuning,

    // ---- derived state, rebuilt at open
    pub(crate) head: Head,
    pub(crate) tail_retention: crate::store::TailRetention,
    pub(crate) tail_stats: crate::store::TailStats,
    pub(crate) tail_stats_dirty: bool,
    /// Exact bytes scoped to the current synchronous synced apply attempt.
    pub(crate) retaining: Option<crate::store::TailRow>,
    /// The active lost-tail repair (step 2), if any.
    pub(crate) repair: Option<lost_tail::Repair>,
    pub(crate) repair_generation: u64,
    /// Bumped whenever confirmed state is replaced wholesale (rollback, install,
    /// log move) or the instance is fenced: a lifetime guard for observations.
    pub(crate) store_generation: u64,
    pub(crate) repair_stats: lost_tail::RepairStats,
    /// Own acknowledged mutations being resurrected: mutation ID → earlier seq.
    pub(crate) resurrected: std::collections::BTreeMap<Uuid, u64>,
    /// The revocation latch.
    pub(crate) latch: latch::Latch,
    /// When `log_regressed` was last raised (cleared after 24 hours).
    pub(crate) regressed_at: Option<i64>,
    /// Lost-tail orphans and own writes lost after revocation.
    pub(crate) orphans: Vec<orphans::Orphan>,
    pub(crate) orphan_grace_ms: i64,
    pub(crate) catalog: Arc<Catalog>,
    /// Neutral confirmed catalog identity, memoized only for this store/catalog lifetime.
    pub(crate) handover_catalog: std::cell::RefCell<Option<handover::CatalogIdentity>>,
    query_execution_profile: QueryExecutionProfile,
    /// Committed trusted derived-profile capture, never a serving permission.
    pub(crate) query_context: Option<Arc<crate::plan::QueryProjectionContext>>,
    pub(crate) query_stats: std::cell::Cell<query_driver::QueryStats>,
    query_cursors: query_cursor::Cursors,
    #[cfg(feature = "testing")]
    query_trace: Option<Box<dyn Fn(&'static str)>>,
    pub(crate) layer: Layer,
    pub(crate) touch: TouchIndex,
    pub(crate) pending_keys: BTreeMap<u64, Vec<String>>,
    pub(crate) next_order: u64,
    pub(crate) clock_floor: i64,
    pub(crate) log_time: i64,
    pub(crate) sem_ratchet: u64,
    pub(crate) policy: crate::policy::PolicyState,
    pub(crate) key_untrusted: bool,
    /// AK1: recovery-device wraps, epoch commitment, unlocked account-key devices.
    pub(crate) account_key: account_key::AccountKeyState,
    /// RAM-only actual authenticated cloud key delivery; never loaded from Store.
    pub(crate) hosted_key_delivery: Option<admission::HostedKeyDelivery>,
    pub(crate) apply_blocked: Option<u64>,
    pub(crate) apply_fault: bool,
    /// The chain hash of seq 1 as applied by this store (`None` before seq 1).
    pub(crate) genesis: Option<mdbn_wire::common::Hash>,
    /// Committed prefix changes held until the failed apply barrier is verified.
    pub(crate) apply_deferred_changed: BTreeSet<String>,

    // ---- log
    pub(crate) endpoint: EndpointId,
    pub(crate) log_move: LogMove,
    pub(crate) next_call: u64,
    log_sessions: log_session::State,
    pub(crate) calls: Vec<LogCall>,
    pub(crate) inflight: BTreeMap<CallId, append::Inflight>,
    pub(crate) append: append::AppendState,
    pub(crate) head_known: u64,
    pub(crate) connection: Connection,
    pub(crate) subscribed: bool,
    pub(crate) reading: bool,
    pub(crate) caught_up: bool,
    pub(crate) moved_streak: u32,
    pub(crate) stalled: Option<(IncidentKind, u64)>,
    key_wait_read: key_wait::ReadBackoff,
    /// Control read-ahead while waiting for a key (`join_ahead.rs`).
    pub(crate) join_ahead: Option<join_ahead::JoinAhead>,
    pub(crate) incidents: BTreeMap<u64, Incident>,

    // ---- clients
    approval: approval_runtime::ApprovalRuntime,
    pub(crate) sessions: BTreeMap<SessionId, Session>,
    pub(crate) next_session: u64,
    pub(crate) submitted_by: BTreeMap<Uuid, SessionId>,
    pub(crate) pushes: Vec<(SessionId, Push)>,
    pub(crate) view_version: u64,
    pub(crate) live: live::Live,
    bases_discovery: bases::discovery::DiscoverySlots,
    pub(crate) before: disk::Before,
    pub(crate) retry_publish: disk::Before,
    pub(crate) publish_waits: disk::PublishWaits,
    pub(crate) build: Option<snapshot::Build>,
    pub(crate) install: Option<snapshot::Install>,
    /// The `base` item whose generation 0 is being installed (`snapshot.md` §7).
    pub(crate) install_base: Option<snapshot::BaseInstall>,
    /// One opaque hosted generation-0 writer, never shared across wakes.
    hosted_gen0: Option<gen0::HostedGen0State>,
    /// A base whose generation 0 failed to install: apply stalls before it until
    /// reopen instead of refetching it on every read.
    pub(crate) base_install_failed: Option<u64>,
    pub(crate) install_progress: (u64, u64),
    pub(crate) install_mseq: BTreeMap<B16, u64>,
    pub(crate) install_staged: crate::store::Tx,
    pub(crate) install_index: snapshot::DigestIndex,
    /// The refs set of the snapshot being installed: the manifest's direct refs,
    /// then the complete set (direct refs plus every ref-index member) once its
    /// ref-index objects verified (T7b).
    pub(crate) install_refs: Option<std::collections::BTreeSet<mdbn_wire::common::Hash>>,
    /// Test observation: the refs set the last completed install verified
    /// (`install_refs` is released when an install completes).
    #[cfg(test)]
    pub(crate) installed_refs: Option<std::collections::BTreeSet<mdbn_wire::common::Hash>>,
    pub(crate) install_native_roots: unindexed_inventory::Roots,
    pub(crate) install_native_auth: unindexed_snapshot::Auth,
    pub(crate) install_text_sources: snapshot_text::Sources,
    pub(crate) install_resources: Vec<(String, String)>,
    pub(crate) install_retry: bool,
    /// [`Replica::enforce_shipped_install_gate`].
    pub(crate) shipped_install_gate: bool,
    /// The key epoch at the installing snapshot's position.
    pub(crate) install_epoch: u64,
    pub(crate) endorse: Option<snapshot::Endorse>,
    pub(crate) verified_chunks: std::collections::BTreeSet<mdbn_wire::common::B32>,
    pub(crate) install_points: Vec<snapshot::ControlPoint>,
    /// Entries between snapshots this replica builds (`snapshot.md` §5.3).
    pub snapshot_every: u64,
    pub(crate) status_dirty: bool,
    /// Local-only grants and independently authenticated local serving identity.
    pub(crate) grant_source: Option<Box<dyn crate::policy::GrantSource>>,
    /// Hosted mode (`hosted.rs`), set only by [`Replica::open_hosted`]. `None` on
    /// devices, whose behaviour it never changes.
    pub(crate) hosted: Option<Box<hosted::HostedState>>,
    /// Attachment uploads (`attachment_upload.rs`).
    pub(crate) attachment_uploads: attachment_upload::Uploads,
    pub(crate) unindexed_uploads: unindexed_upload::Uploads,
    pub(crate) reverse_text_sources: unindexed_reverse_text::Sources,
    pub(crate) unindexed_reverse_uploads: unindexed_reverse_upload::Uploads,
    pub(crate) attachment_fetches: attachment_fetch::Fetches,
    pub(crate) unindexed_sources: unindexed_apply::Sources,
    pub(crate) unindexed_blob_fetches: unindexed_blob_fetch::Fetches,
    pub(crate) attachment_ingest: attachment_ingest::Ingests,
    /// Keyring rebuild on open ([`crate::store::KeyringPersistence::RebuildOnOpen`]).
    pub(crate) device_keys: Option<key_rebuild::DeviceKeyRebuild>,
    pub(crate) device_keys_failed: bool,
    /// Attachment object inventories being read for snapshot refs.
    pub(crate) attachment_inventories: attachment_inventory::Inventories,
    /// Why the last due snapshot build did not run, if it did not.
    pub(crate) snapshot_blocked: Option<snapshot::SnapshotBlocked>,

    /// Counters.
    pub stats: Stats,
}

impl<S: Store> std::fmt::Debug for Replica<S> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Replica")
            .field("collection", &self.cfg.collection)
            .field("replica_id", &self.cfg.replica_id)
            .field("head", &self.head.seq)
            .finish_non_exhaustive()
    }
}

fn read_i64(store: &dyn Store, key: &str) -> Result<i64, StoreError> {
    Ok(store
        .meta(key)?
        .and_then(|b| <[u8; 8]>::try_from(b.as_slice()).ok())
        .map(i64::from_be_bytes)
        .unwrap_or(0))
}

impl<S: Store> Replica<S> {
    /// Open a replica over its store: load the head and catalog, and rebuild the
    /// local view from the pending queue.
    pub fn open(
        cfg: ReplicaConfig,
        store: S,
        planner: Box<dyn Planner>,
        sealer: Box<dyn Sealer>,
        host: Host,
        secrets: DeviceSecrets,
    ) -> Result<Replica<S>, OpenError> {
        Self::open_inner(cfg, store, planner, sealer, host, secrets, None)
    }

    /// Open with the trusted local host authority already installed, BEFORE any
    /// persisted app row is replanned or materialized. The source must implement
    /// the authenticated pairing/collection/grant provenance contract.
    pub fn open_with_grant_source(
        cfg: ReplicaConfig,
        store: S,
        planner: Box<dyn Planner>,
        sealer: Box<dyn Sealer>,
        host: Host,
        secrets: DeviceSecrets,
        source: Box<dyn crate::policy::GrantSource>,
    ) -> Result<Replica<S>, OpenError> {
        Self::open_inner(cfg, store, planner, sealer, host, secrets, Some(source))
    }

    fn open_inner(
        cfg: ReplicaConfig,
        store: S,
        planner: Box<dyn Planner>,
        sealer: Box<dyn Sealer>,
        host: Host,
        secrets: DeviceSecrets,
        source: Option<Box<dyn crate::policy::GrantSource>>,
    ) -> Result<Replica<S>, OpenError> {
        // This gate is checked before key import, pending replay, recovery or any
        // reconcile/append/client route exists. It does not restrict OS access.
        if let Some(fence) = crate::mirror_admission::Fence::load(&store)? {
            return Err(OpenError::Mismatch(fence.status()));
        }
        // A pinned host (every production synced host pins its environment's
        // published policy keys) has its trust shape checked before anything is
        // opened over it; an inconsistent shape never reaches a transport.
        if cfg.policy_pins.is_some() {
            cfg.validate_host_trust().map_err(OpenError::HostTrust)?;
        }
        // A synced replica appends what it opens over: never over commits a
        // deferred-durability window could still take back.
        if cfg.mode != SyncMode::LocalOnly && store.durability_deferred() {
            return Err(OpenError::Store(StoreError::Io(
                "deferred-durability window open: barrier before a synced open".into(),
            )));
        }
        let identity = [cfg.collection.0, cfg.replica_id.0].concat();
        match store.meta(meta_keys::IDENTITY)? {
            Some(id) if id != identity => {
                return Err(OpenError::Mismatch(
                    "store belongs to another collection or replica".into(),
                ));
            }
            _ => {}
        }
        let head = store.head()?;
        let tail_stats = store.tail_stats()?;
        let catalog = Arc::new(crate::plan::load_catalog(&store)?);
        let clock_floor = read_i64(&store, meta_keys::COUNTERS)?;
        // `log_state` is written by apply as `log_time ‖ sem_ratchet`.
        let (log_time, sem_ratchet) = match store.meta(meta_keys::LOG_STATE)? {
            Some(b) if b.len() == 16 => (
                i64::from_be_bytes(b[..8].try_into().unwrap_or([0; 8])),
                u64::from_be_bytes(b[8..].try_into().unwrap_or([0; 8])),
            ),
            _ => (0, 0),
        };
        let policy = match store.meta(meta_keys::POLICY)? {
            Some(b) => crate::policy::PolicyState::from_bytes(&b)
                .map_err(|e| OpenError::Corrupt(format!("policy state: {e}")))?,
            None => crate::policy::PolicyState::new(),
        };
        // Pinned control-plane keys: well-formed, and a warm store must have been
        // built under them (before its keyring is imported).
        if let Some(pins) = &cfg.policy_pins {
            pins.validate()
                .map_err(|e| OpenError::Mismatch(format!("policy pins: {e}")))?;
            if !policy.consistent_with(pins) {
                return Err(OpenError::Mismatch(
                    "store was built under control-plane keys that are not pinned".into(),
                ));
            }
        }
        let account_key = match store.meta(account_key::META)? {
            Some(b) => account_key::AccountKeyState::from_bytes(&b)
                .ok_or_else(|| OpenError::Corrupt("account key state".into()))?,
            None => account_key::AccountKeyState::default(),
        };
        let genesis = match store.meta(meta_keys::GENESIS)? {
            Some(b) => {
                Some(mdbn_wire::common::B32(b.as_slice().try_into().map_err(
                    |_| OpenError::Corrupt("genesis: not 32 bytes".into()),
                )?))
            }
            None => None,
        };
        // A warm store is checked against the host's pin before anything is
        // served, and before its keyring is imported: it must have applied exactly
        // the pinned genesis.
        if let Some(want) = cfg.expected_genesis
            && cfg.mode != mdbn_wire::client::SyncMode::LocalOnly
            && (head.seq > 0 || policy.seq > 0)
        {
            match genesis {
                Some(g) if g == want => {}
                Some(_) => {
                    return Err(OpenError::Mismatch(
                        "store was built from a different genesis than the pinned one".into(),
                    ));
                }
                None => {
                    return Err(OpenError::Mismatch(
                        "store has no recorded genesis; rebuild it against the pinned genesis"
                            .into(),
                    ));
                }
            }
        }
        let mut sealer = sealer;
        if let Some(k) = store.meta(meta_keys::KEYRING)? {
            sealer
                .import(&k)
                .map_err(|e| OpenError::Corrupt(format!("keyring: {e:?}")))?;
        }
        sealer.set_epoch(policy.epoch);
        let resurrected =
            lost_tail::decode_resurrected(store.meta(meta_keys::RESURRECT)?.as_deref())
                .map_err(|e| OpenError::Corrupt(format!("resurrect set: {e}")))?;
        let latch = match store.meta(meta_keys::LATCH)? {
            Some(b) => latch::Latch::from_bytes(&b)
                .map_err(|e| OpenError::Corrupt(format!("revocation latch: {e}")))?,
            None => latch::Latch::default(),
        };
        let orphan_rows = orphans::decode(store.meta(meta_keys::ORPHANS)?.as_deref())
            .map_err(|e| OpenError::Corrupt(format!("orphans: {e}")))?;
        let mut r = Replica {
            approval: approval_runtime::ApprovalRuntime::new(cfg.collection, cfg.device_id),
            endpoint: cfg.log_endpoint,
            cfg,
            store,
            planner,
            sealer,
            host,
            secrets,
            tuning: AppendTuning::default(),
            head,
            tail_retention: crate::store::TailRetention::default(),
            tail_stats,
            tail_stats_dirty: false,
            retaining: None,
            repair: None,
            repair_generation: 0,
            store_generation: 0,
            repair_stats: lost_tail::RepairStats::default(),
            resurrected,
            latch,
            regressed_at: None,
            orphans: orphan_rows,
            orphan_grace_ms: orphans::ORPHAN_GRACE_MS,
            catalog,
            query_execution_profile: QueryExecutionProfile::default(),
            query_context: None,
            query_stats: std::cell::Cell::default(),
            query_cursors: query_cursor::Cursors::default(),
            #[cfg(feature = "testing")]
            query_trace: None,
            handover_catalog: std::cell::RefCell::new(None),
            layer: Layer::default(),
            touch: TouchIndex::default(),
            pending_keys: BTreeMap::new(),
            next_order: 1,
            clock_floor,
            log_time,
            sem_ratchet,
            policy,
            key_untrusted: false,
            account_key,
            hosted_key_delivery: None,
            apply_blocked: None,
            apply_fault: false,
            genesis,
            apply_deferred_changed: BTreeSet::new(),
            log_move: LogMove::None,
            next_call: 1,
            log_sessions: log_session::State::default(),
            calls: Vec::new(),
            inflight: BTreeMap::new(),
            append: append::AppendState::Idle,
            head_known: head.seq,
            connection: Connection::Connecting,
            subscribed: false,
            reading: false,
            caught_up: false,
            moved_streak: 0,
            stalled: None,
            key_wait_read: Default::default(),
            join_ahead: None,
            incidents: BTreeMap::new(),
            sessions: BTreeMap::new(),
            next_session: 1,
            submitted_by: BTreeMap::new(),
            pushes: Vec::new(),
            view_version: 0,
            live: live::Live::default(),
            bases_discovery: bases::discovery::DiscoverySlots::default(),
            before: Default::default(),
            retry_publish: Default::default(),
            publish_waits: Default::default(),
            build: None,
            install: None,
            install_base: None,
            hosted_gen0: None,
            base_install_failed: None,
            install_progress: (0, 0),
            install_mseq: BTreeMap::new(),
            install_staged: crate::store::Tx::default(),
            install_index: Default::default(),
            install_refs: None,
            #[cfg(test)]
            installed_refs: None,
            install_native_roots: Default::default(),
            install_native_auth: Default::default(),
            install_text_sources: Default::default(),
            install_resources: Vec::new(),
            install_retry: false,
            shipped_install_gate: false,
            install_epoch: 0,
            endorse: None,
            verified_chunks: Default::default(),
            install_points: Vec::new(),
            snapshot_every: snapshot::SNAPSHOT_EVERY,
            status_dirty: false,
            grant_source: source,
            hosted: None,
            attachment_uploads: attachment_upload::Uploads::default(),
            unindexed_uploads: unindexed_upload::Uploads::default(),
            reverse_text_sources: unindexed_reverse_text::Sources::default(),
            unindexed_reverse_uploads: unindexed_reverse_upload::Uploads::default(),
            attachment_fetches: attachment_fetch::Fetches::default(),
            unindexed_sources: unindexed_apply::Sources::default(),
            unindexed_blob_fetches: unindexed_blob_fetch::Fetches::default(),
            attachment_ingest: attachment_ingest::Ingests::default(),
            device_keys: None,
            device_keys_failed: false,
            attachment_inventories: attachment_inventory::Inventories::default(),
            snapshot_blocked: None,
            stats: Stats::default(),
        };
        r.check_key_trust();
        let mut inst = [0u8; 8];
        r.host.entropy.fill(&mut inst);
        r.live.instance = u64::from_be_bytes(inst);
        let mut tx = crate::store::Tx::default();
        if r.store.meta(meta_keys::IDENTITY)?.is_none() {
            tx.meta.push((meta_keys::IDENTITY.into(), Some(identity)));
            r.store.commit(tx)?;
        }
        // Never replan/materialize a persisted app row as Host during reopen.
        // Reject missing/revoked/mismatched local authority atomically first.
        if r.local_only() {
            r.validate_local_pending_on_open()?;
        }
        // A crash can follow a committed prefix but precede its local rebase.
        // Replan all cached pending effects against the recovered durable head.
        let changed = r
            .all_pending()?
            .into_iter()
            .flat_map(|row| row.touches)
            .collect();
        r.rebuild_local_view(&changed)
            .map_err(|e| OpenError::Corrupt(format!("{e:?}")))?;
        // A store opened without a complete query index (older store, crash after
        // an invalidating write) is backfilled before serving.
        r.backfill_query_index().map_err(OpenError::Store)?;
        // Whatever the view captured while rebuilding is replaced by what the disk holds.
        r.before.clear();
        r.load_regressed().map_err(OpenError::Store)?;
        r.reconcile_disk()?;
        if r.local_only() {
            r.connection = Connection::Online;
            // Host-only pending rows may resume. Granted rows fail closed until
            // a freshly authenticated local source is installed after open.
            r.local_commit();
        } else if !r.start_device_key_rebuild() {
            r.queue_head_fetch();
        }
        Ok(r)
    }

    /// **Test only** (`testing` feature): the epoch keys this replica's sealer
    /// holds, for key-exposure oracles (sim gate 1).
    #[cfg(any(test, feature = "testing"))]
    pub fn testing_epoch_keys(&self) -> Vec<(u64, zeroize::Zeroizing<[u8; 32]>)> {
        self.sealer.testing_epoch_keys()
    }

    /// Restricted log-service authentication. Local-only replicas refuse signing;
    /// synced hosts must supply a consistent persisted trust configuration. The
    /// sealer keeps the device key private and signs only the fixed hello context.
    pub fn log_hello_proof(
        &self,
        nonce: [u8; 32],
        token: &str,
    ) -> Result<mdbn_wire::common::Signature, crate::seal::SealError> {
        if self.cfg.mode != SyncMode::Synced {
            return Err(crate::seal::SealError::Failed(
                "local-only replica has no log authentication".into(),
            ));
        }
        self.cfg
            .validate_host_trust()
            .map_err(|e| crate::seal::SealError::Failed(e.into()))?;
        self.sealer.log_hello_proof(nonce, token)
    }

    /// Configuration.
    pub fn config(&self) -> &ReplicaConfig {
        &self.cfg
    }

    /// The store (read access for hosts and tests).
    pub fn store(&self) -> &S {
        &self.store
    }

    /// The store, mutably. Hosts use it for store-specific operations (watchers,
    /// maintenance) and must not commit through it.
    pub fn store_mut(&mut self) -> &mut S {
        &mut self.store
    }

    /// Close the replica and return its store.
    pub fn into_store(self) -> S {
        self.store
    }

    /// The trusted host's per-replica query resource policy.
    pub fn query_execution_profile(&self) -> QueryExecutionProfile {
        self.query_execution_profile
    }

    /// Select the query resource policy before serving requests. This is a trusted
    /// host seam, not an app/session/query override. DO/mobile/webview hosts must
    /// retain MemoryConstrained; only desktop hosts may select Desktop.
    pub fn set_query_execution_profile(&mut self, profile: QueryExecutionProfile) {
        self.query_execution_profile = profile;
    }

    /// Whether this replica has read up to the log head it heard in the current
    /// connection (false from open until the first complete read).
    pub fn caught_up(&self) -> bool {
        self.caught_up
    }

    /// The applied head.
    pub fn head(&self) -> Head {
        self.head
    }

    /// Tune the append loop (batch limits, backoff).
    pub fn set_tuning(&mut self, t: AppendTuning) {
        self.tuning = t;
    }

    /// Ask the store what changed on disk and ingest it (file-backed stores).
    pub fn observe(&mut self, paths: Option<&[String]>) -> Result<(), StoreError> {
        // Do not consume watcher evidence while authorization/key recovery is
        // paused. The store keeps it unacknowledged for a fresh rescan/reoffer.
        self.check_apply_store_health()?;
        let obs = self.store.observe(paths)?;
        self.ingest(obs);
        Ok(())
    }

    // ------------------------------------------------------------ log moves

    /// The log endpoint calls currently go to.
    pub fn log_endpoint(&self) -> EndpointId {
        self.endpoint
    }

    /// Start a log move (enabling or disabling sync): finish any in-flight
    /// append, then stop appending. Submits keep succeeding as `pending`; reads keep
    /// serving. Poll [`Replica::log_move_ready`] until it returns the head to copy.
    pub fn begin_log_move(&mut self) {
        if self.log_move == LogMove::None {
            self.log_move = LogMove::Draining;
        }
    }

    /// `Some(head)` once no append is in flight: the log on the old endpoint will
    /// not change because of this replica until [`Replica::repoint_log`] or
    /// [`Replica::cancel_log_move`].
    pub fn log_move_ready(&self) -> Option<Head> {
        match self.log_move {
            LogMove::Draining if !self.append.in_flight() => Some(self.head),
            _ => None,
        }
    }

    /// Point the replica at the log's new endpoint. The replica re-subscribes, reads
    /// the new log's head and verifies the chain at its own applied head: the item at
    /// `H` on the new endpoint must hash to the replica's `chain(H)` (a shorter or
    /// different log is an `integrity` incident and the move does not complete).
    /// Pending mutations are untouched. Replies to calls sent to the old endpoint
    /// are ignored.
    pub fn repoint_log(&mut self, to: EndpointId) {
        self.forget_log_session_for_repoint();
        self.store_generation += 1;
        self.endpoint = to;
        self.log_move = LogMove::Verifying;
        self.inflight.clear();
        self.calls.clear();
        self.append = append::AppendState::Idle;
        self.subscribed = false;
        self.reading = false;
        self.caught_up = false;
        self.queue_head_fetch();
        if self.head.seq > 0 {
            self.queue_verify_head();
        }
    }

    /// Abandon a log move and resume appending to the current endpoint.
    pub fn cancel_log_move(&mut self) {
        if self.log_move == LogMove::Draining {
            self.log_move = LogMove::None;
            self.pump();
        }
    }

    // ------------------------------------------------------------ helpers

    pub(crate) fn queue(&mut self, request: LogRequest) -> CallId {
        let id = CallId(self.next_call);
        self.next_call += 1;
        self.calls.push(LogCall {
            id,
            endpoint: self.endpoint,
            request,
        });
        id
    }

    pub(crate) fn now(&self) -> i64 {
        i64::try_from(self.host.clock.now_ms()).unwrap_or(i64::MAX)
    }

    /// A fresh UUIDv7 from the injected clock and entropy.
    pub(crate) fn mint_v7(&mut self) -> Uuid {
        let mut r = [0u8; 10];
        self.host.entropy.fill(&mut r);
        let ms = u64::try_from(self.now().max(0)).unwrap_or(0);
        convert::wuuid(&mdbn_core::ids::Uuid::v7_from_parts(ms, r))
    }

    pub(crate) fn incident(
        &mut self,
        kind: IncidentKind,
        details: Option<mdbn_wire::common::Value>,
    ) {
        self.incidents
            .insert(kind.value(), Incident { kind, details });
        self.status_dirty = true;
    }

    pub(crate) fn clear_incident(&mut self, kind: IncidentKind) {
        if self.incidents.remove(&kind.value()).is_some() {
            self.status_dirty = true;
        }
    }

    /// Rebuild the local view from the pending queue. Rows whose touch keys meet
    /// `changed` (or follow a row whose effects changed) are re-planned against the
    /// new local view; the rest re-apply their stored effects. Returns the IDs whose
    /// local view may have changed.
    pub(crate) fn rebuild_local_view(
        &mut self,
        changed: &BTreeSet<String>,
    ) -> Result<BTreeSet<B16>, StoreError> {
        let mut changed = changed.clone();
        let mut layer = Layer::default();
        let mut touch = TouchIndex::default();
        let mut keys_by_order = BTreeMap::new();
        let mut updates: Vec<PendingRow> = Vec::new();
        let mut affected_ids = BTreeSet::new();
        let mut conflicted = Vec::new();
        let mut last = None;
        let mut max_order = 0;
        let mut rows_seen = 0u64;
        let catalog = self.catalog.clone();
        loop {
            let rows = self.store.pending(last, 256)?;
            let Some(l) = rows.last() else {
                break;
            };
            last = Some(l.order);
            for row in rows {
                rows_seen += 1;
                max_order = max_order.max(row.order);
                let replan = !changed.is_empty() && row.touches.iter().any(|k| changed.contains(k));
                let effects = if replan {
                    self.stats.replanned += 1;
                    let view = StoreView::new(&self.store, catalog.clone());
                    let lv = crate::layer::LayerView {
                        base: &view,
                        layer: &layer,
                    };
                    let planned = convert::runtime_mutation(&row.mutation, &convert::inline_only)
                        .ok()
                        .and_then(|m| {
                            self.planner
                                .plan(
                                    &m,
                                    &lv,
                                    &mdbn_core::plan::PlanOptions {
                                        stage: self.plan_stage(&row.mutation.id),
                                    },
                                )
                                .ok()
                        });
                    if let Some(e) = view.error() {
                        return Err(e);
                    }
                    // An external edit that now conflicts: its file must keep the
                    // user's bytes, so hold it before anything is published.
                    if row.mutation.source == mdbn_wire::intent::Source::External
                        && planned
                            .as_ref()
                            .is_some_and(|p| p.status == mdbn_core::plan::Status::Conflicted)
                    {
                        let conflicts = planned
                            .as_ref()
                            .expect("conflicted plan")
                            .conflicts
                            .iter()
                            .map(convert::wruntime_conflict)
                            .collect::<Result<Vec<_>, _>>()
                            .map_err(|e| StoreError::Corrupt(format!("hold conflict: {e:?}")))?;
                        conflicted.push((row.mutation.clone(), conflicts));
                    }
                    // A plan whose effects the legacy codec cannot carry (an
                    // attachment put) layers nothing here: the row stays pending and
                    // head planning encodes it in the runtime family (an uploaded
                    // `file_attach`) or rejects it with a typed problem. Layering
                    // attachment content locally lands with apply (T5).
                    let effects: Vec<mdbn_wire::entry::Effect> = planned
                        .and_then(|p| {
                            p.effects
                                .iter()
                                .map(convert::weffect)
                                .collect::<Result<_, _>>()
                                .ok()
                        })
                        .unwrap_or_default();
                    if effects != row.effects {
                        for k in crate::plan::effect_keys(&effects)
                            .into_iter()
                            .chain(crate::plan::effect_keys(&row.effects))
                        {
                            changed.insert(k);
                        }
                        let mut touches = crate::plan::runtime_mutation_keys(&row.mutation);
                        touches.extend(crate::plan::effect_keys(&effects));
                        touches.extend(path_keys(&effects));
                        touches.sort();
                        touches.dedup();
                        updates.push(PendingRow {
                            effects: effects.clone(),
                            touches,
                            ..row.clone()
                        });
                    }
                    effects
                } else {
                    row.effects.clone()
                };
                for id in effect_ids(&effects)
                    .into_iter()
                    .chain(effect_ids(&row.effects))
                {
                    affected_ids.insert(id);
                }
                let view = StoreView::new(&self.store, catalog.clone());
                for e in &effects {
                    if let Ok(ce) = convert::effect(e, &convert::inline_only) {
                        layer.apply_effect(&view, &ce);
                    }
                }
                if let Some(e) = view.error() {
                    return Err(e);
                }
                let keys = updates
                    .last()
                    .filter(|u| u.order == row.order)
                    .map(|u| u.touches.clone())
                    .unwrap_or(row.touches.clone());
                touch.add(row.order, &keys);
                keys_by_order.insert(row.order, keys);
            }
        }
        let _ = rows_seen;
        let mut tx = crate::store::Tx {
            pending_put: updates,
            ..crate::store::Tx::default()
        };
        for (m, conflicts) in conflicted {
            self.prepare_conflict_holds(&m, &conflicts, &mut tx, &convert::inline_only)?;
        }
        let holds_changed = !tx.holds_put.is_empty();
        if !tx.pending_put.is_empty() || holds_changed {
            self.store.commit(tx)?;
        }
        if holds_changed {
            self.status_dirty = true;
            self.push_holds();
        }
        // Records no longer layered also changed in the local view.
        for id in self.layer.touched_ids() {
            if !layer.touches(&id) {
                affected_ids.insert(convert::wuuid(&id));
            }
        }
        // What the old local view showed, for publishing.
        for id in &affected_ids {
            self.capture_before(disk::DiskKey::Record(*id));
        }
        self.layer = layer;
        self.touch = touch;
        self.pending_keys = keys_by_order;
        self.next_order = self.next_order.max(max_order + 1);
        Ok(affected_ids)
    }

    /// Records and files in the pending queue that a page of the store holds.
    #[allow(dead_code)]
    pub(crate) fn all_pending(&self) -> Result<Vec<PendingRow>, StoreError> {
        let mut out = Vec::new();
        let mut last = None;
        loop {
            let rows = self.store.pending(last, 1024)?;
            let Some(l) = rows.last() else {
                break;
            };
            last = Some(l.order);
            out.extend(rows);
        }
        Ok(out)
    }

    /// Records in ID order (helper for tests and digests).
    pub fn confirmed_records(&self) -> Result<Vec<crate::store::RecordRow>, StoreError> {
        let mut out = Vec::new();
        let mut after = None;
        loop {
            let p = self.store.records(Page { after, limit: 1024 })?;
            let Some(l) = p.last() else {
                break;
            };
            after = Some(l.id);
            out.extend(p);
        }
        Ok(out)
    }
}

/// IDs named by wire effects.
pub(crate) fn effect_ids(effects: &[mdbn_wire::entry::Effect]) -> Vec<B16> {
    use mdbn_wire::entry::Effect as E;
    effects
        .iter()
        .filter_map(|e| match e {
            E::PutRecord(p) => Some(p.id),
            E::RemoveRecord(p) => Some(p.id),
            E::PutFile(p) => Some(p.id),
            E::RemoveFile(p) => Some(p.id),
            _ => None,
        })
        .collect()
}

/// Path-key touch keys of wire effects (`"p:<key>"`): a create planned into a path
/// must be re-planned when someone else takes that path.
pub(crate) fn path_keys(effects: &[mdbn_wire::entry::Effect]) -> Vec<String> {
    use mdbn_wire::entry::Effect as E;
    effects
        .iter()
        .filter_map(|e| match e {
            E::PutRecord(p) => Some(&p.path),
            E::RemoveRecord(p) => Some(&p.path),
            E::PutFile(p) => Some(&p.path),
            E::RemoveFile(p) => Some(&p.path),
            _ => None,
        })
        .map(|p| format!("p:{}", mdbn_core::paths::path_key(p)))
        .collect()
}

/// Whether a planned result carries attachment-v1 content (an Effect8 or a
/// ConflictValue5 side) and so is appended in the runtime family.
pub(crate) fn carries_attachment(planned: &mdbn_core::plan::Planned) -> bool {
    use mdbn_core::plan::{ConflictValue, Effect};
    planned
        .effects
        .iter()
        .any(|e| matches!(e, Effect::PutAttachmentFile { .. }))
        || planned.conflicts.iter().any(|c| {
            [Some(&c.kept), Some(&c.lost), c.base.as_ref()]
                .into_iter()
                .flatten()
                .any(|v| matches!(v, ConflictValue::Attachment(_)))
        })
}

/// The typed problem for a planned result the legacy log cannot encode: today
/// a critical attachment or unindexed oversized Markdown effect or conflict
/// side, which this replica's runtime does not carry yet
/// (`ConvertError::AttachmentUnsupported`,
/// `ConvertError::UnindexedMarkdownUnsupported`). Nothing is dropped or
/// downcast; the mutation is rejected and keeps its bytes.
pub(crate) fn unencodable_result(e: &convert::ConvertError) -> mdbn_wire::client::Problem {
    crate::api::ErrorCode::UpgradeRequired
        .problem(format!("this replica cannot record the result: {e}"))
}

/// The first written path in planned effects that fails namespace safety.
pub(crate) fn unsafe_effect_path(effects: &[mdbn_core::plan::Effect]) -> Option<String> {
    use mdbn_core::plan::Effect as E;
    effects.iter().find_map(|e| match e {
        E::PutRecord { path, .. }
        | E::PutFile { path, .. }
        | E::PutAttachmentFile { path, .. }
        | E::PutUnindexedMarkdown { path, .. }
        | E::ReindexUnindexedMarkdown { path, .. }
        | E::ReindexOrdinaryFile { path, .. }
        | E::PutResource { path, .. }
            if mdbn_core::paths::check_path(path).is_err() =>
        {
            Some(path.clone())
        }
        _ => None,
    })
}

/// Reject a plan that writes an unsafe path, at submit, at head and at ingest.
#[allow(clippy::result_large_err)]
pub(crate) fn check_paths(
    planned: Result<mdbn_core::plan::Planned, mdbn_core::plan::Rejection>,
) -> Result<mdbn_core::plan::Planned, mdbn_core::plan::Rejection> {
    let p = planned?;
    match unsafe_effect_path(&p.effects) {
        Some(path) => Err(unsafe_path_rejection(&path)),
        None => Ok(p),
    }
}

/// The `invalid_request` rejection for an unsafe path.
pub(crate) fn unsafe_path_rejection(path: &str) -> mdbn_core::plan::Rejection {
    mdbn_core::plan::Rejection::new(
        mdbn_core::plan::RejectCode::InvalidRequest,
        Some("unsafe_path"),
        format!(
            "{path:?} is not a portable collection path ({})",
            mdbn_core::paths::check_path(path)
                .err()
                .map(|v| v.reason())
                .unwrap_or("")
        ),
    )
}

pub(crate) fn i64_meta(v: i64) -> Option<Vec<u8>> {
    Some(v.to_be_bytes().to_vec())
}
