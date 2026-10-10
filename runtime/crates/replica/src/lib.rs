//! # mdbn-replica: the replica service
//!
//! **Responsibility.** The one replica implementation every participant runs (a
//! laptop folder, an Obsidian vault, the hosted replica): the pending queue of
//! local intents, the optimistic local view, ingest of external edits, holds, the
//! append loop against the log service, rebase, snapshots, verification mode, push
//! subscriptions, and the client API that thin clients call (replica service contract).
//!
//! It is synchronous and single-threaded per collection. All I/O is injected: the
//! [`Store`] trait (defined here, implemented by the store crates), the clock and
//! entropy ([`mdbn_core::host`]), and the log service through a sans-I/O port
//! ([`log::LogPort`]) that hosts drive. Hosts and the simulator drive the same code.
//!
//! | Module | What | Contract |
//! |---|---|---|
//! | [`store`] | the `Store` trait, its rows and transaction | this crate (store interface contract) |
//! | [`log`] | log-service requests, replies, pushes; `LogClient`, `LogPort`, `pump` | `log-service-api.md` |
//! | [`api`] | the in-process client API, the 15 error codes, pushes | `replica-client-api.md` |
//! | [`crypto`] | sealing, signatures, HPKE key wraps, keyed IDs, recovery key | `sealed-envelope.md` |
//! | [`plan`] | the seam to the core: `Planner`, `StoreView` (core `StateView` over a store), the rebase index | `intent.md`, `log-entry.md` §5 |
//! | [`convert`] | wire ↔ core conversions | |
//! | [`mem`] | `MemStore`, the reference in-memory store | |
//! | [`conformance`] | the `Store` conformance suite every store runs | |
//! | [`fake`] | `FakeLog`, an in-memory log service for tests | `log-service-api.md` |
//! | [`layer`] | the owned local-view layer over confirmed state | |
//! | [`seal`] | the keyring/crypto seam (`Sealer`), and a test-only `PlainSealer` | `sealed-envelope.md` |
//! | [`policy`] | `P(p)`: deterministic policy evaluation at replay, grant checks | `policy.md`, `log-entry.md` §4.3 |
//! | [`replica`] | the service itself | `log-entry.md`, `snapshot.md`, `policy.md` |
//!
//! **Rules.** Portable and deterministic: it builds for `wasm32-unknown-unknown`
//! and is lint-checked like `mdbn-core` (no clock, files, env, threads, OS entropy
//! or hash-map iteration).
//!
//! **Allowed dependencies.** Internal: `mdbn-core`, `mdbn-wire`. It never depends
//! on a store crate; stores depend on it, and binaries compose the two. External:
//! as for `mdbn-core`.

pub mod api;
pub mod approval;
pub mod attachments;
pub mod conformance;
pub mod convert;
pub mod crypto;
pub mod fake;
pub mod file_source;
pub mod frames;
pub mod layer;
pub mod log;
pub mod log_codec;
pub mod mem;
pub mod mirror_admission;
/// Closed-install logical resource accounting, not admission or install authority.
#[path = "replica/mirror_install_budget.rs"]
pub mod mirror_install_budget;
/// Charged borrowed envelope DATA, not currentness or installation authority.
#[path = "replica/mirror_install_data.rs"]
pub mod mirror_install_data;
pub mod plan;
pub mod policy;
pub mod replica;
pub mod seal;
pub mod store;
pub mod store_query;
#[cfg(any(test, feature = "testing"))]
pub mod testkit;

#[cfg(test)]
mod tests;

pub use api::{ClientApi, ErrorCode, Push, SessionAuth, SessionId};
pub use log::{LogClient, LogPort};
pub use mdbn_core::host::{Clock, Entropy};
pub use plan::{CorePlanner, Planner};
pub use replica::base::{BaseError, Gen0Base, build_base, check_base};
pub use replica::{
    AttachmentFetchStatus, AttachmentSource, AttachmentUploadCheckpoint, AttachmentUploadParams,
    AttachmentUploadStatus, DeviceSecrets, Host, HostedAck, HostedAdmission, HostedAdmissionDenial,
    HostedAttachmentTransferParams, HostedAttachmentTransferProgress, HostedBootstrapAdmission,
    HostedCache, HostedKeyOperationDenial, HostedProfile, KeyWaitReason, MAX_REQUEST_NODES,
    QueryExecutionProfile, QuerySourceLimits, Replica, ReplicaConfig, SnapshotBlocked,
    SubmitTicket, TimeZones, UtcOnly, VerifiedHostedAdmission, VerifiedHostedBootstrap,
    VerifiedHostedKeyRecipient, snapshot_refs_fit,
};
pub use seal::{Sealer, SealerIdentity};
pub use store::{KeyringPersistence, Store, StoreError, Tx};
