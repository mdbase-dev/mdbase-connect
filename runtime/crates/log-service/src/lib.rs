//! # mdbn-log-service: the blind log service
//!
//! **Responsibility.** One serialized actor per collection that orders sealed
//! entries by conditional append, stores snapshots and blobs, and pushes
//! notifications; plus the reserved ephemeral per-record streams (synced collection log).
//! Built behind its interface (`docs/contracts/log-service-api.md`) for both
//! Postgres and Durable Objects.
//!
//! **Shape.** The service logic is written once, platform-neutral, against two
//! seams:
//! - [`backend::Backend`]: per-collection transactions with per-collection
//!   serialization (Postgres row lock, Durable Object, async mutex);
//! - [`backend::ObjectStore`]: object bytes (R2/S3, local disk, memory), with the
//!   [`backend::Archive`] compaction and GC move removed data into.
//!
//! Hosts own sockets, clocks and entropy and call [`session::handle_frame`]. The
//! crate has no runtime dependency and builds for `wasm32-unknown-unknown`, so the
//! Durable Object runs this same code.
//!
//! | Module | Contract |
//! |---|---|
//! | [`service`] | §4 append, §5 read, §6 objects and GC, §7 snapshots and compaction, §12 admin |
//! | [`policy`] | §4.3 policy transport effects, `policy.md` §3 signature validity |
//! | [`auth`] | §3 principals, tokens and proof of possession |
//! | [`hub`] | §8 ephemeral streams, §9 subscriptions and push |
//! | [`outbox`] | §9 coalescing and backpressure, §8 receive buffers |
//! | [`session`] | §2 frames and connection-level dispatch |
//! | [`error`] | §10 error codes |
//! | [`mem`] | in-memory backend (reference, tests, simulator) |
//! | [`testkit`] | signed item builders for tests and the conformance suite |
//!
//! **Rules.** It never sees plaintext (blind log contract). It handles opaque sealed bytes
//! and the routing metadata in `mdbn-wire`, nothing else.
//!
//! **Allowed dependencies.** Internal: `mdbn-wire` only. It may not depend on
//! `mdbn-core` or `mdbn-replica`: if it cannot interpret records, it cannot leak
//! them. `cargo xtask arch` enforces this.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]
#![allow(async_fn_in_trait, clippy::too_many_arguments)]

pub mod auth;
pub mod backend;
pub mod decode;
pub mod deletion;
pub mod direct;
pub mod error;
pub mod hub;
pub mod limits;
pub mod mem;
pub mod model;
#[cfg(not(target_arch = "wasm32"))]
mod offline_decode;
pub mod outbox;
pub mod policy;
mod restore;
pub mod restore_plan;
pub mod service;
pub mod session;
pub mod testkit;

pub use backend::{Archive, Backend, Mode, ObjectStore, Txn, Write};
pub use error::{Code, Result, ServiceError};
#[cfg(not(target_arch = "wasm32"))]
pub use offline_decode::{OfflineDecodeBudget, OfflineOwnedReservation};
#[cfg(not(target_arch = "wasm32"))]
pub use service::OfflineReplayVerifier;
pub use service::{Config, Outcome, Service};
