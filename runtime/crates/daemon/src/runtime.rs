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
use std::collections::{BTreeMap, VecDeque};
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
use tokio::sync::{mpsc, oneshot, watch};

#[cfg(test)]
#[path = "native_pending_fixture.rs"]
pub(crate) mod native_pending_fixture;

#[path = "runtime_device_approval.rs"]
mod device_approval;
pub use device_approval::{DeviceApprovalOp, DeviceApprovalReply};

mod event_loop;
mod handle;
mod log_delivery;
mod notices;
mod open;
mod readouts;
mod types;

use event_loop::*;
use log_delivery::*;
use notices::*;
use open::*;
use readouts::*;
use types::*;

pub(crate) use readouts::capture_counts;
pub(crate) use types::AccountKeyGuard;

pub use handle::{OpenFailed, Runtime};
pub use open::{cached_eligibility, preopen_cache_check, preopen_mirror_status, synced_ready};
pub use types::{
    AccountKeyOp, AuthoritySource, Frozen, GrantApprovalOp, GrantApprovalReply, Inventory,
    LocalGrantSet, LocalGrants, PrivateSwitchOp, ReadinessView, RuntimeConfig, Synced,
};

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

struct GrantSignals {
    grants: LocalGrants,
    changes: watch::Sender<()>,
}

#[cfg(test)]
#[path = "runtime_telemetry_tests.rs"]
mod telemetry_tests;

#[cfg(test)]
#[path = "runtime_log_tests.rs"]
mod log_tests;
