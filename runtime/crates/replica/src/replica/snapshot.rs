//! Snapshots (`snapshot.md`): the state digest, building and uploading a snapshot,
//! and installing one when this replica is behind retention or bootstrapping.
//!
//! **Build.** At the head `H`, every section is turned into chunk payloads (bucketed
//! by `bucket16` for index/records/files), each sealed as an unsigned `chunk` object
//! addressed by `SHA-256` of its bytes. A chunk whose plaintext is unchanged from the
//! previous manifest reuses its address and is not uploaded again. The manifest is
//! sealed and signed; `refs` lists every chunk, every blob part and every
//! attachment object (manifest and all chunks, `attachment_inventory.rs`) the state
//! references, or the build is refused typed ([`SnapshotBlocked`]); never
//! truncated. Attachment rows go to the critical sections 10/11 of the
//! `attachment_runtime_v1` family. When every object is stored, `put_snapshot`
//! registers the pointer.
//!
//! **Install** (§8). `get_snapshot` → fetch and open the manifest → check its chain
//! against the item after it (or the head) → clear confirmed state → fetch, verify
//! (`address`, `plain_hash`) and commit chunks one at a time, resources first → check
//! the state digest → set the head and read the tail. Queries answer over what is
//! installed with `complete: false` meanwhile. Pending mutations stay; those already
//! in the installed receipts resolve as confirmed in the append loop.
//!
//! Open items: manifest signature verification and the control-chain commitment
//! need policy wiring; the build holds one snapshot's chunks in memory.

use std::collections::BTreeMap;

use mdbn_wire::attachment::{
    AttachmentContentV1, AttachmentFileRowV1, AttachmentTombstoneRowV1, FileContent,
};
use mdbn_wire::attachment_runtime_v1::{
    self as rt, ChunkPayload, ConflictRow as WConflictRow, ManifestPayload, Section, SectionKind,
};
use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::client::IncidentKind;
use mdbn_wire::common::{B32, Bytes, Hash, Text, Value, Version};
use mdbn_wire::entry::Alias;
use mdbn_wire::envelope::{Item, ItemKind};
use mdbn_wire::intent::FileInclusion;
use mdbn_wire::log_service::{
    EndorseSnapshotParams, PutSnapshotParams, ReadParams, SnapshotPointer,
};
use mdbn_wire::schema::Wire;
use mdbn_wire::snapshot::{
    ChunkRef, EntityKind, FileRow as WFileRow, Horizon, IndexRow, ReceiptRow as WReceiptRow,
    RecordRow as WRecordRow, ResourceRow, SectionKind as L, TextOrBlob,
    TombstoneRow as WTombstoneRow,
};

use super::Replica;
// The moved submodules name these siblings as `super::…`.
use super::append::Inflight;
use super::apply::{HORIZON_ENTRIES, HORIZON_MS, log_state};
use super::{
    attachment_runtime, live, mirror_install, ref_index, snapshot_text, unindexed_inventory,
    unindexed_snapshot,
};
use crate::log::{LogRequest, LogResponse};
use crate::plan::record_meta;
use crate::store::{
    AliasRow, ConflictRow, FileLocal, FileRow, Head, Page, ReceiptRow, RecordRow, Store,
    StoreError, TombstoneLast, TombstoneRow, Tx, bucket16, meta_keys,
};

mod blocked;
mod build;
mod digest;
mod endorse;
mod install;
mod install_chunk;
mod rows;

#[cfg(test)]
use install_chunk::alias_path_ok;
use rows::*;

pub use blocked::{MAX_REQUEST_NODES, SnapshotBlocked, snapshot_refs_fit};
pub use digest::state_digest;
use digest::{DigestIndex, state_digest_within};
use install::{ChunkError, chunk_queue};
pub(crate) use install_chunk::ChunkRows;

/// Target plaintext per records chunk.
pub(super) const TARGET_CHUNK: u64 = 512 << 10;
/// Unbucketed sections split at this plaintext size.
const MAX_CHUNK: usize = 4 << 20;
/// Record text a hosted build may hold: it keeps the rows, their encoded copies
/// and the sealed chunks in memory at once, and a Worker cannot grow past 256 MiB.
pub(super) const HOSTED_SNAPSHOT_RECORD_BYTES: u64 = 64 << 20;
/// Entries between snapshots.
pub const SNAPSHOT_EVERY: u64 = 10_000;

pub(super) fn enc(c: &Cbor) -> Vec<u8> {
    cbor::encode(c).unwrap_or_default()
}

/// `ceil(log2(x))` for x ≥ 1, without floats.
pub(super) fn ceil_log2(x: u64) -> u64 {
    if x <= 1 {
        0
    } else {
        u64::from(64 - (x - 1).leading_zeros())
    }
}

/// An object to upload.
#[derive(Debug, Clone)]
pub(crate) struct Upload {
    pub(crate) address: B32,
    pub(crate) kind: ItemKind,
    pub(crate) bytes: Vec<u8>,
}

/// A snapshot build in flight.
#[derive(Debug, Clone)]
pub(crate) struct Build {
    pub(crate) seq: u64,
    pub(crate) manifest: B32,
    pub(crate) refs: Vec<B32>,
    /// Objects not yet sent, the manifest last.
    pub(crate) uploads: std::collections::VecDeque<Upload>,
    /// Uploads sent and not yet answered.
    pub(crate) outstanding: usize,
    /// The worst answer to an upload so far; the build ends when the uploads
    /// in flight have answered.
    pub(crate) failed: Option<BuildFailure>,
    pub(crate) payload: ManifestPayload,
}

/// Why a build's upload or registration did not produce a snapshot. Ordered:
/// a refusal outranks an unanswered request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum BuildFailure {
    /// No answer, no route, or the service asked for a retry.
    Unanswered {
        /// The service's retry hint, 0 without one.
        retry_after_ms: u64,
    },
    /// The service answered and will answer the same at this head.
    Refused,
}

impl BuildFailure {
    /// Classify a reply that is not the success the request expects.
    pub(crate) fn of(reply: &crate::log::LogReply) -> BuildFailure {
        use crate::log::{LogError, LogErrorCode};
        match reply {
            Err(LogError::NoResponse | LogError::Offline) => {
                BuildFailure::Unanswered { retry_after_ms: 0 }
            }
            Err(LogError::Service {
                code:
                    LogErrorCode::Unavailable
                    | LogErrorCode::RateLimited
                    | LogErrorCode::Unauthenticated,
                retry_after_ms,
                ..
            }) => BuildFailure::Unanswered {
                retry_after_ms: retry_after_ms.unwrap_or(0),
            },
            _ => BuildFailure::Refused,
        }
    }
}

/// The periodic build's wait after an unanswered upload: doubled each time
/// from the append retry interval, ended by any answer from the service.
#[derive(Debug, Clone, Copy)]
pub(crate) struct BuildRetry {
    /// No periodic build before this time, ms.
    pub(crate) at: i64,
    pub(crate) wait_ms: u64,
}

/// The retained pointers `get_snapshot` gave an install (`snapshot.md` §8).
#[derive(Debug, Clone)]
pub(crate) struct Offer {
    /// The newest pointer's manifest.
    pub(crate) newest: B32,
    /// The older retained pointer, until the install falls back to it.
    pub(crate) older: Option<SnapshotPointer>,
    /// Why the newest was refused, once the install has fallen back.
    pub(crate) refused: Option<(IncidentKind, String)>,
}

/// An install in flight.
#[derive(Debug, Clone)]
pub(crate) enum Install {
    /// Reading control items (policy and keys) from the policy's position
    /// (`snapshot.md` §8 step 1).
    Control,
    /// Asked for the pointers.
    Pointer,
    /// Fetching the manifest of this pointer.
    Manifest(SnapshotPointer),
    /// Fetching the manifest's ref-index objects (`ref_index.rs`).
    RefIndices {
        p: SnapshotPointer,
        m: Box<ManifestPayload>,
        item_refs: Vec<Hash>,
        ref_indices: Vec<Hash>,
        fetched: BTreeMap<Hash, super::ref_index::VerifiedRefIndex>,
    },
    /// Checking the manifest's chain against the log.
    Chain(SnapshotPointer, Box<ManifestPayload>),
    /// Verified manifest, waiting for a successful discard of previous staging.
    Reset(Box<ManifestPayload>),
    /// Streaming authentication of every native source before the atomic swap.
    Sources(Box<ManifestPayload>),
    /// Fetching chunks: the queue and the next index.
    Chunks {
        manifest: Box<ManifestPayload>,
        queue: Vec<(SectionKind, ChunkRef)>,
        next: usize,
    },
}

impl Install {
    /// The object of the snapshot this step is fetching, if it is fetching one.
    pub(crate) fn object(&self) -> Option<&'static str> {
        match self {
            Install::Manifest(_) => Some("the manifest"),
            Install::RefIndices { .. } => Some("a ref index"),
            Install::Chunks { .. } => Some("a chunk"),
            Install::Control
            | Install::Pointer
            | Install::Chain(..)
            | Install::Reset(_)
            | Install::Sources(_) => None,
        }
    }
}

/// An endorsement in progress: the manifest, then every chunk it references.
#[derive(Debug, Clone)]
pub(crate) enum Endorse {
    Manifest(SnapshotPointer),
    Chunks {
        p: SnapshotPointer,
        /// The manifest's state digest, which the decoded rows must hash to.
        state_digest: Hash,
        queue: Vec<(SectionKind, ChunkRef)>,
        next: usize,
        /// The decoding of the chunks read so far.
        rows: Box<ChunkRows>,
        /// Mutations whose receipts the chunks read so far hold.
        receipts: std::collections::BTreeSet<mdbn_wire::common::Uuid>,
    },
}

/// Whether an install may stage rows in memory, for a store without a staging
/// area. Tests and the simulator only: in a shipped build, install is reachable
/// only over a store with persistent staging ([`Store::stages`]), so memory holds
/// one chunk plus the row index, never the whole snapshot under the bounded
/// staging condition; signature and authorization, the control chain, chunk
/// checks and row validation are in.
pub(crate) const IN_MEMORY_INSTALL: bool = cfg!(any(test, feature = "testing"));

/// Whether the lost-tail rollback may run through install. It remains
/// test/simulator-only; the install gate lift does not change that.
pub(crate) const ROLLBACK_ENABLED: bool = cfg!(any(test, feature = "testing"));

#[cfg(test)]
mod native_digest_tests;
#[cfg(test)]
mod upgrade_tests;
#[cfg(test)]
mod validation_tests;

/// A `base` item at `seq` whose generation-0 manifest is being installed
/// (`snapshot.md` §7). The state after the base is the manifest's state.
#[derive(Debug, Clone)]
pub(crate) struct BaseInstall {
    pub(crate) seq: u64,
    pub(crate) chain: Hash,
    pub(crate) state_digest: Hash,
    /// The base item's epoch: the manifest must be sealed under the same one.
    pub(crate) epoch: u64,
    /// The base item's exact bytes, retained with the head like any applied item.
    pub(crate) item: Vec<u8>,
    /// What the opened payload names, recorded when the install commits.
    pub(crate) facts: Option<super::migration_log::InstalledBase>,
}

/// Policy state recorded after each control item read during an install: the
/// manifest is checked against the state at its own position.
#[derive(Debug, Clone)]
pub(crate) struct ControlPoint {
    pub(crate) seq: u64,
    pub(crate) policy: crate::policy::PolicyState,
}

/// The last manifest this replica built or installed, for incremental builds.
const LAST_MANIFEST: &str = "replica.snapshot.last";

pub(super) fn object_item(kind: ItemKind, collection: mdbn_wire::common::Uuid, epoch: u64) -> Item {
    Item {
        kind,
        collection,
        seq: None,
        prev: None,
        epoch: Some(epoch),
        signer: None,
        salt: None,
        idem: None,
        refs: None,
        stream: None,
        body: Bytes(Vec::new()),
        sig: None,
    }
}

/// Split rows into chunks of at most [`MAX_CHUNK`] encoded bytes (ordinals from 0).
pub(super) fn split(rows: Vec<Cbor>) -> Vec<(u64, Vec<Cbor>)> {
    let mut out: Vec<(u64, Vec<Cbor>)> = vec![(0, Vec::new())];
    let mut size = 0usize;
    for r in rows {
        let n = enc(&r).len();
        if size + n > MAX_CHUNK && !out.last().is_some_and(|c| c.1.is_empty()) {
            let ord = out.len() as u64;
            out.push((ord, Vec::new()));
            size = 0;
        }
        size += n;
        if let Some(last) = out.last_mut() {
            last.1.push(r);
        }
    }
    out
}

#[allow(dead_code)]
fn _text(_: Text) {}
