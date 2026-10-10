//! The `Store` trait: what the replica service persists, and how.
//!
//! One replica implementation runs on every participant. What differs is where its
//! state lives:
//!
//! | Store | Crate | Records live in |
//! |---|---|---|
//! | file-backed | `mdbn-store-file` over `FilePlatform` + `IndexStorage` | the user's files, plus an index |
//! | Postgres | `mdbn-store-pg` (hosted replica) | Postgres rows |
//! | in-memory | [`crate::mem::MemStore`] | memory (tests, and the reference semantics) |
//!
//! # Division of labour
//!
//! - **The replica owns semantics.** It plans, applies effects, derives index entries
//!   ([`RecordMeta`]), computes path keys and decides holds. Stores never parse YAML,
//!   evaluate CEL or fold paths, so they cannot disagree with each other about meaning.
//! - **The store owns durability and the disk.** It commits a [`Tx`] atomically,
//!   answers point lookups and candidate queries from its indexes, and (file-backed
//!   stores only) publishes the local view to files without ever clobbering user
//!   bytes, and reports what it observes on disk ([`Observation`]).
//!
//! # Rules every implementation follows
//!
//! 1. **Atomic, durable commits.** [`Store::commit`] applies all of a [`Tx`] or none
//!    of it, and it is durable when it returns `Ok`. The replica acknowledges nothing
//!    (receipts, confirmations, endorsements) before that.
//! 2. **Read-your-writes.** Every read after a successful commit sees it.
//! 3. **Exact bytes.** Documents, paths and mutation bytes come back exactly as put.
//!    No normalization, no re-encoding.
//! 4. **No semantics.** Lookups by path key compare the replica-supplied `path_key`
//!    bytewise. Candidate queries ([`Candidate`]) may return a superset; the replica
//!    applies the residual. They must never return a subset.
//! 5. **Never clobber.** A [`Publish`] whose [`Expect`] does not hold on disk is not
//!    performed. It is reported as a [`Drift`], and the store observes the path.
//! 6. **Deterministic iteration.** Every list is returned in the order documented on
//!    its method, never in hash order.
//! 7. **Bounded reads.** Anything that can be large is paged.
//!
//! The conformance suite for these rules runs against every store (`crate::mem` is
//! the reference). File and Postgres stores run it in their own crates.

use std::collections::BTreeSet;
use std::fmt;
use std::ops::Range;

use mdbn_wire::attachment_runtime_v1::{Conflict as RtConflict, Mutation as RtMutation};
use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::client::{Hold, Problem, ReceiptState};
use mdbn_wire::common::{DataMap, Hash, Uuid, Value};
use mdbn_wire::entry::{Conflict, Effect, Status};
use mdbn_wire::intent::{BlobRef, FileInclusion, MediaClass};
use mdbn_wire::schema::{SchemaError, Wire};
use mdbn_wire::snapshot::EntityKind;

/// A log position. 1-based; 0 means "before the first item".
pub type Seq = u64;

/// Milliseconds since the Unix epoch.
pub type TimeMs = i64;

/// The applied head `(H, h)`: the position and chain hash of the last item applied.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Head {
    /// Position of the last applied item (0 before any).
    pub seq: Seq,
    /// `chain(seq)`; 32 zero bytes when `seq = 0` (sealed-envelope.md §2.3).
    pub chain: Hash,
}

impl Head {
    /// The head of an empty log.
    pub const GENESIS: Head = Head {
        seq: 0,
        chain: mdbn_wire::common::B32([0; 32]),
    };
}

/// The 16-bit snapshot bucket of an ID: the first two bytes of `SHA-256(id)`.
///
/// A snapshot with `bucket_bits = k` puts the ID in bucket `bucket16 >> (16 - k)`
/// (snapshot.md §2). Stores index this value so snapshot builds and point-read
/// prefetches can scan one bucket without hashing every ID.
pub fn bucket16(id: &Uuid) -> u16 {
    let d = mdbn_wire::hash::sha256(&id.0);
    u16::from_be_bytes([d.0[0], d.0[1]])
}

// ------------------------------------------------------------------ rows

/// Index entries the replica derives for a record (through the core) and the store
/// keeps so it can answer lookups and candidate queries without semantics.
#[derive(Debug, Clone, PartialEq)]
pub struct RecordMeta {
    /// Type names the record matches, in catalog order.
    pub types: Vec<String>,
    /// Persisted frontmatter, top-level keys in document order (for candidate
    /// comparisons; effective defaults are applied by the replica's residual).
    pub effective: DataMap<Value>,
    /// Link index keys, opaque to stores: `"l:<key>"` for the record's outgoing
    /// links (spec 08, found by [`Store::referrers`] on rename), `"t:<key>"` for the
    /// keys the record itself is a target of (link resolution by filename).
    pub links: Vec<String>,
    /// Tags (spec 08), as the core extracts them.
    pub tags: Vec<String>,
    /// `(field, value key)` pairs of fields under `unique.enforce` (intent.md §6).
    /// The value key is the core's canonical equality key for the value.
    pub unique: Vec<(String, String)>,
}

impl Default for RecordMeta {
    fn default() -> RecordMeta {
        RecordMeta {
            types: Vec::new(),
            effective: DataMap(Vec::new()),
            links: Vec::new(),
            tags: Vec::new(),
            unique: Vec::new(),
        }
    }
}

/// A confirmed record.
#[derive(Debug, Clone, PartialEq)]
pub struct RecordRow {
    /// Record ID.
    pub id: Uuid,
    /// Path, exact bytes.
    pub path: String,
    /// Path key (spec 02: NFC then case-fold), computed by the replica.
    pub path_key: String,
    /// The document, exact bytes.
    pub doc: String,
    /// `SHA-256(doc)`.
    pub revision: Hash,
    /// Position of the last change (0 = adopted, unchanged).
    pub modified_seq: Seq,
    /// [`bucket16`] of the ID.
    pub bucket: u16,
    /// Derived index entries.
    pub meta: RecordMeta,
}

/// Where a confirmed file's bytes are on this device (replica-client-api.md §10.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum FileLocal {
    /// The bytes are on this device.
    Materialized,
    /// Included, not kept here; fetched on demand.
    Remote,
    /// Being fetched.
    Fetching,
}

/// A confirmed non-record file.
#[derive(Debug, Clone, PartialEq)]
pub struct FileRow {
    /// Stored semantic kind, separate from the unchanged content descriptor.
    pub kind: mdbn_wire::unindexed_markdown::FileKindV1,
    /// File ID.
    pub id: Uuid,
    /// Path, exact bytes.
    pub path: String,
    /// Path key.
    pub path_key: String,
    /// Complete typed content: the legacy blob reference, or an attachment's
    /// signed descriptor. The row keeps the whole arm; nothing is downcast.
    pub content: mdbn_wire::attachment::FileContent,
    /// Media class (from the extension).
    pub media: MediaClass,
    /// Position of the last change.
    pub modified_seq: Seq,
    /// [`bucket16`] of the ID.
    pub bucket: u16,
    /// Local materialization (device-local; not replicated).
    pub local: FileLocal,
}

/// What a tombstone keeps.
#[derive(Debug, Clone, PartialEq)]
pub enum TombstoneLast {
    /// A record's last document.
    Doc(String),
    /// A legacy file's last blob reference.
    Blob(BlobRef),
    /// An attachment file's complete last descriptor.
    Attachment(mdbn_wire::attachment::AttachmentContentV1),
    /// Complete retained FileKind1 payload (native Last tag3).
    UnindexedMarkdown(mdbn_wire::unindexed_markdown::UnindexedMarkdownPayloadV1),
}

impl TombstoneLast {
    /// Retain both stored kind and full descriptor on deletion.
    pub fn from_file(row: &FileRow) -> Option<Self> {
        match row.kind {
            mdbn_wire::unindexed_markdown::FileKindV1::Ordinary => {
                Self::from_file_content(row.content.clone())
            }
            mdbn_wire::unindexed_markdown::FileKindV1::UnindexedOversizedMarkdown => {
                Some(Self::UnindexedMarkdown(
                    mdbn_wire::unindexed_markdown::UnindexedMarkdownPayloadV1 {
                        content: row.content.clone(),
                    },
                ))
            }
        }
    }

    /// The arm that keeps a removed file's complete content, each content arm
    /// to its own. `None` for a content form this replica does not know (the
    /// wire union is open): the caller refuses, it never guesses a blob.
    pub fn from_file_content(c: mdbn_wire::attachment::FileContent) -> Option<TombstoneLast> {
        match c {
            mdbn_wire::attachment::FileContent::Blob(b) => Some(TombstoneLast::Blob(b)),
            mdbn_wire::attachment::FileContent::AttachmentV1(a) => {
                Some(TombstoneLast::Attachment(a))
            }
            _ => None,
        }
    }
}

/// A tombstone (snapshot.md §3), pruned at the receipts horizon.
#[derive(Debug, Clone, PartialEq)]
pub struct TombstoneRow {
    /// ID.
    pub id: Uuid,
    /// Record or file.
    pub kind: EntityKind,
    /// Last path.
    pub path: String,
    /// Last path key.
    pub path_key: String,
    /// Last document or file content.
    pub last: TombstoneLast,
    /// Deleted at.
    pub seq: Seq,
    /// Deleted when (the deleting entry's clock instant).
    pub time: TimeMs,
}

/// An alias: an old path that now refers to a record (log-entry.md §2.3).
#[derive(Debug, Clone, PartialEq)]
pub struct AliasRow {
    /// Old path as written.
    pub path: String,
    /// Its path key.
    pub path_key: String,
    /// Record ID.
    pub record: Uuid,
}

/// An unresolved conflict, keyed by `(mutation, conflict.id)`.
#[derive(Debug, Clone, PartialEq)]
pub struct ConflictRow {
    /// The mutation whose entry recorded it.
    pub mutation: Uuid,
    /// Its position.
    pub seq: Seq,
    /// The conflict, in the runtime family: a held attachment side is a
    /// complete ConflictValue5, never a fabricated blob. Legacy sides encode
    /// byte-identically.
    pub conflict: RtConflict,
}

/// A confirmed receipt: replicated state, carried by snapshots, pruned at the horizon.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ReceiptRow {
    /// Mutation ID.
    pub mutation: Uuid,
    /// Position of the entry that carried it.
    pub seq: Seq,
    /// The mutation's clock instant.
    pub time: TimeMs,
}

/// A replica-local receipt: what this replica told its clients about its own
/// mutations once they left `pending` (rejected, unknown, or confirmed with status).
/// Kept at least 24 hours after `resolved_at` (log-entry.md §7).
#[derive(Debug, Clone, PartialEq)]
pub struct LocalReceipt {
    /// Mutation ID.
    pub mutation: Uuid,
    /// State (never `pending`).
    pub state: ReceiptState,
    /// Position, when confirmed.
    pub seq: Option<Seq>,
    /// Status, when confirmed.
    pub status: Option<Status>,
    /// Conflicts, when conflicted.
    pub conflicts: Vec<Conflict>,
    /// Problem, when rejected or unknown.
    pub problem: Option<Problem>,
    /// When it left `pending` (host clock).
    pub resolved_at: TimeMs,
    /// The grant that submitted it (`None`: the hosting app). Receipts are served only
    /// to sessions of the same grant.
    pub grant: Option<Uuid>,
}

/// A pending mutation: captured here, not yet confirmed.
///
/// The pending queue is the replica's most important non-derived state: losing a row
/// loses an acknowledged write. Stores keep it ordered by `order` and indexed by
/// mutation ID. Submit and confirm must stay O(log n) at 10k+ pending rows:
/// indexed pending work avoids repeatedly scanning the backlog.
#[derive(Debug, Clone, PartialEq)]
pub struct PendingRow {
    /// Capture order, strictly increasing, assigned by the replica.
    pub order: u64,
    /// The mutation, exactly as captured (texts inline), in the runtime family
    /// (`intent.md` §3.11). Rows of legacy operations encode byte-identically to
    /// the legacy mutation; only the dedicated attachment upload captures
    /// `file_attach`.
    pub mutation: RtMutation,
    /// Optimistic effects, as last planned against the local view.
    pub effects: Vec<Effect>,
    /// Record, file and resource keys the last plan read or wrote: the rebase index.
    /// A confirmed change to any of them re-plans this row. Resource paths are
    /// encoded as `"r:" + path`, IDs as `"i:" + uuid`.
    pub touches: Vec<String>,
    /// The session's grant, if a granted client submitted it (`mutation.on_behalf`).
    pub grant: Option<Uuid>,
    /// Blob parts this mutation needs uploaded before it can be appended.
    pub uploads: Vec<BlobRef>,
    /// Object addresses the entry's envelope `refs` must list: the sorted,
    /// distinct ciphertext chunk and manifest Item hashes of an uploaded
    /// attachment (`log-entry.md` §2.1). Empty for every other row.
    pub refs: Vec<Hash>,
}

impl PendingRow {
    /// Canonical bytes, for stores that persist rows as blobs.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut fields = vec![
            Cbor::Uint(self.order),
            self.mutation.to_cbor(),
            self.effects.to_cbor(),
            self.touches.to_cbor(),
            match &self.grant {
                Some(g) => g.to_cbor(),
                None => Cbor::Null,
            },
            self.uploads.to_cbor(),
        ];
        // Rows without refs keep their earlier six-element bytes.
        if !self.refs.is_empty() {
            fields.push(self.refs.to_cbor());
        }
        let c = Cbor::Array(fields);
        // Encoding a well-formed value cannot fail; the codec only rejects
        // non-canonical input (e.g. NaN floats, which the planner never emits).
        cbor::encode(&c).unwrap_or_default()
    }

    /// Decode [`PendingRow::to_bytes`].
    pub fn from_bytes(bytes: &[u8]) -> Result<PendingRow, SchemaError> {
        let c = cbor::decode(bytes)?;
        let a = mdbn_wire::schema::array(&c, "PendingRow")?;
        let (order, m, e, t, g, u, refs) = match a {
            [order, m, e, t, g, u] => (order, m, e, t, g, u, None),
            [order, m, e, t, g, u, refs] => (order, m, e, t, g, u, Some(refs)),
            _ => {
                return Err(SchemaError::Invalid {
                    ty: "PendingRow",
                    reason: "wrong number of elements",
                });
            }
        };
        let refs = match refs {
            None => Vec::new(),
            Some(r) => {
                let refs = Vec::<Hash>::from_cbor(r)?;
                // Only the non-empty form is ever written.
                if refs.is_empty() {
                    return Err(SchemaError::Invalid {
                        ty: "PendingRow",
                        reason: "empty refs",
                    });
                }
                refs
            }
        };
        Ok(PendingRow {
            order: u64::from_cbor(order)?,
            mutation: RtMutation::from_cbor(m)?,
            effects: Vec::<Effect>::from_cbor(e)?,
            touches: Vec::<String>::from_cbor(t)?,
            grant: match g {
                Cbor::Null => None,
                g => Some(Uuid::from_cbor(g)?),
            },
            uploads: Vec::<BlobRef>::from_cbor(u)?,
            refs,
        })
    }
}

/// A raw log item this replica applied, kept for lost-tail self-repair
/// (lost-tail repair and retention contract).
///
/// Device-local: never in snapshots, untouched by [`Tx::clear_confirmed`]. Stores may
/// keep it best-effort (a webview index can be evicted): a missing or short tail only
/// means this replica cannot repair from its own copy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TailRow {
    /// Log position.
    pub seq: Seq,
    /// The item envelope, exactly as applied.
    pub item: Vec<u8>,
    /// When it was applied (host clock; device-local).
    pub applied_at: TimeMs,
}

/// Size of the retained tail, kept by stores without scanning.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TailStats {
    /// Lowest retained position (0 when empty).
    pub first: Seq,
    /// Highest retained position (0 when empty).
    pub last: Seq,
    /// Rows retained.
    pub count: u64,
    /// Sum of `item` lengths.
    pub bytes: u64,
}

/// How much of the applied tail a replica keeps. A host parameter: the window covers
/// whichever of `min_positions` and `min_age_ms` reaches further back, and `max_bytes`
/// caps it regardless.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TailRetention {
    /// Keep at least this many of the latest positions.
    pub min_positions: u64,
    /// Keep everything applied within this long.
    pub min_age_ms: i64,
    /// Never keep more than this many item bytes.
    pub max_bytes: u64,
}

impl TailRetention {
    /// Desktop daemons and native runtimes.
    pub const DESKTOP: TailRetention = TailRetention {
        min_positions: 10_000,
        min_age_ms: 15 * 60_000,
        max_bytes: 256 << 20,
    };
    /// Mobile runtimes (an evictable index under a platform quota).
    pub const MOBILE: TailRetention = TailRetention {
        max_bytes: 64 << 20,
        ..TailRetention::DESKTOP
    };
    /// The hosted replica: always online, point-in-time recovery behind it.
    pub const HOSTED: TailRetention = TailRetention {
        min_positions: 2_000,
        min_age_ms: 15 * 60_000,
        max_bytes: 32 << 20,
    };
}

impl Default for TailRetention {
    fn default() -> TailRetention {
        TailRetention::DESKTOP
    }
}

/// A resumable upload into the replica (replica-client-api.md §10.2).
#[derive(Debug, Clone, PartialEq)]
pub struct TransferRow {
    /// Transfer ID (client-chosen).
    pub id: Uuid,
    /// Target path.
    pub path: String,
    /// Exact size.
    pub size: u64,
    /// The client's SHA-256 commitment.
    pub digest: Option<Hash>,
    /// File to replace (absent = new file).
    pub file: Option<Uuid>,
    /// CAS on replace.
    pub if_revision: Option<Hash>,
    /// Mutation ID for the resulting `file_put`.
    pub mutation: Option<Uuid>,
    /// Chunk size (1 MiB).
    pub chunk_size: u64,
    /// Chunk indexes received.
    pub received: BTreeSet<u64>,
    /// Expiry (24 h after last activity).
    pub expires_at: TimeMs,
    /// The session's grant.
    pub grant: Option<Uuid>,
}

// ------------------------------------------------------------------ queries

/// The candidate part of a query (core-B's query IR), evaluated by the store over
/// its index. Stores may return a superset (for example by treating a `Compare` they
/// can't index as `All`), never a subset. `Compare` with `Pruning::Exact` compares
/// the record's persisted top-level field ([`RecordMeta::effective`] holds the
/// frontmatter the replica derived).
pub use mdbn_core::query::Candidate;

/// A page of a scan ordered by record ID.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Page {
    /// Return IDs strictly greater than this.
    pub after: Option<Uuid>,
    /// At most this many rows.
    pub limit: u32,
}

/// Maximum owned resource path bytes in a bounded inventory page.
pub const RESOURCE_PATH_BYTES: usize = 4096;
/// Maximum exact resource source bytes in the bounded read seam.
pub const RESOURCE_SOURCE_BYTES: usize = 1024 * 1024;
/// Maximum path candidates, including one pagination lookahead.
pub const RESOURCE_PATH_CANDIDATES: u32 = 129;

/// A bounded scan of the existing tracked resource table, in UTF-8 byte order.
#[derive(Debug, Clone, Copy)]
pub struct ResourcePathPage<'a> {
    /// Exclusive last inspected path, or the beginning.
    pub after: Option<&'a str>,
    /// Exact folder prefix including its final slash, or all resources.
    pub prefix: Option<&'a str>,
    /// Maximum returned candidates (including caller-owned lookahead).
    pub limit: u32,
}

impl ResourcePathPage<'_> {
    /// Validate fixed limits before building statements or copying input.
    pub fn validate(&self) -> StoreResult<()> {
        if self.limit == 0
            || self.limit > RESOURCE_PATH_CANDIDATES
            || self.after.is_some_and(|s| s.len() > RESOURCE_PATH_BYTES)
            || self
                .prefix
                .is_some_and(|s| s.len() > RESOURCE_PATH_BYTES + 1)
        {
            return Err(StoreError::Full);
        }
        Ok(())
    }
}

/// An exact source with size observed before copying its text. `text=None`
/// means the source exists but exceeds the supplied copy limit, not absence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoundedResource {
    /// Complete UTF-8 source byte count.
    pub size: u64,
    /// Complete source only when it fits the supplied copy limit.
    pub text: Option<String>,
}

// ------------------------------------------------------------------ the disk

/// What a file-backed store must find at a path before it publishes there.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Expect {
    /// Nothing at the path.
    Absent,
    /// Exactly these bytes (`SHA-256`).
    Revision(Hash),
}

/// Content to publish.
#[derive(Debug, Clone, PartialEq)]
pub enum Content {
    /// Text (a record or resource document).
    Text(String),
    /// A blob from the local blob cache ([`Tx::blob_parts`]), by plaintext digest.
    Blob(Hash),
}

/// Make the disk show the local view. File-backed stores only; other stores
/// ignore publishes (and report no drifts).
///
/// The replica emits publishes only for unheld paths, in an order that never needs
/// two files at one path. Each publish is conditional ([`Expect`]): a mismatch is a
/// [`Drift`], never an overwrite.
#[derive(Debug, Clone, PartialEq)]
pub enum Publish {
    /// Create or replace `path` with `content`.
    Write {
        /// Record, file or resource ID (`None` for resources).
        id: Option<Uuid>,
        /// Path.
        path: String,
        /// What must be there now.
        expect: Expect,
        /// What to write.
        content: Content,
    },
    /// Remove `path`.
    Delete {
        /// Record or file ID (`None` for resources).
        id: Option<Uuid>,
        /// Path.
        path: String,
        /// What must be there now.
        expect: Expect,
    },
    /// Move `from` to `to` (which must be absent), optionally with new content.
    Move {
        /// Record or file ID.
        id: Uuid,
        /// Current path.
        from: String,
        /// New path.
        to: String,
        /// What must be at `from` now.
        expect: Expect,
        /// New content, when it changes in the same step.
        content: Option<Content>,
    },
}

/// One attachment-v1 version being staged for a file (`intent.md` §3.9): the
/// File ID and the address of the exact content's sealed manifest. Staging of
/// any other version of the file is a different key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct StageKey {
    /// File ID.
    pub file: Uuid,
    /// The version's manifest object address.
    pub manifest: Hash,
}

/// The outcome of an attachment file operation on disk: done, or skipped
/// because the path did not hold what was expected (the reason, as for a
/// [`Drift`]). A skipped operation changed nothing the user wrote.
pub type DiskResult = StoreResult<Option<String>>;

/// A publish that was not performed because the disk did not hold what was expected.
#[derive(Debug, Clone, PartialEq)]
pub struct Drift {
    /// The publish that was skipped.
    pub publish: Publish,
    /// Why, in the store's words: `changed`, `editor_busy`, `missing`, `locked`, ...
    pub reason: String,
}

/// A store-assigned handle for an observation, acknowledged in [`Tx::ack_observations`]
/// once ingested. Until then the store keeps the evidence (stash, displaced bytes)
/// and re-delivers it after a crash.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ObservationId(pub u64);

/// How sure the store is about where observed bytes came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provenance {
    /// An ordinary user or tool edit.
    Normal,
    /// Could not be verified (torn write, first scan after a crash, a single
    /// "missing" observation): the replica holds it as `suspect_write`.
    Suspect,
}

/// Something observed on disk at a path, relative to what the store last knew.
#[derive(Debug, Clone, PartialEq)]
pub struct Observation {
    /// Handle to acknowledge.
    pub token: ObservationId,
    /// Path observed.
    pub path: String,
    /// Bytes the store last knew were there (its own publish, or the last ingest).
    /// `None`: nothing was known at this path.
    pub base: Option<Hash>,
    /// What is there now. `None`: the path is gone.
    pub now: Option<Observed>,
    /// A rename the store paired (by inode or content): where these bytes were.
    pub moved_from: Option<String>,
    /// Provenance.
    pub provenance: Provenance,
}

/// Observed content.
#[derive(Debug, Clone, PartialEq)]
pub enum Observed {
    /// UTF-8 text with a record or resource extension, at most the record cap
    /// for Markdown.
    Text(String),
    /// A file synced as attachment-v1 content: any non-text file, Markdown over
    /// the record cap (1,048,576 bytes), or text that is not UTF-8. The store
    /// never read it whole: it hashed it in bounded pieces, and the replica
    /// streams it again from [`Store::attachment_source`].
    Attachment {
        /// SHA-256 of the whole file (its revision).
        digest: Hash,
        /// Size in bytes.
        size: u64,
        /// What the store classified it as.
        class: AttachmentClass,
    },
}

/// How a store classified an [`Observed::Attachment`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttachmentClass {
    /// An ordinary file (`file_attach`).
    Ordinary,
    /// Markdown strictly over the record cap: `UnindexedOversizedMarkdown`
    /// at the same path (`intent.md` §3.10), never a record.
    OversizedMarkdown,
}

/// What a commit reports back.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CommitReport {
    /// Publishes not performed.
    pub drifts: Vec<Drift>,
    /// `Some`: the commit's publishes were still in progress when `commit` returned
    /// (a store whose file operations complete later, such as the WASM host queue).
    /// Their outcome arrives from [`Store::take_publish_results`] under this ID, and
    /// `drifts` is empty. `None`: every publish was performed or reported in `drifts`.
    pub deferred: Option<PublishBatch>,
}

/// Identifies the publishes of one commit that completed after it returned.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct PublishBatch(pub u64);

/// The outcome of a deferred batch of publishes: every publish of the batch was
/// performed except those in `drifts`.
#[derive(Debug, Clone, PartialEq)]
pub struct PublishResult {
    /// The batch, from [`CommitReport::deferred`].
    pub batch: PublishBatch,
    /// Publishes not performed.
    pub drifts: Vec<Drift>,
}

// ------------------------------------------------------------------ the transaction

/// Pruning at the receipts horizon (snapshot.md §6): delete receipts and tombstones
/// with `seq < seq_floor` **and** `time < time_floor`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Prune {
    /// Position floor.
    pub seq_floor: Seq,
    /// Time floor.
    pub time_floor: TimeMs,
}

/// One atomic change to a store.
///
/// Parts apply in field order. In particular `clear_confirmed` runs first (a
/// snapshot install), and `publish` runs last, only after everything else is durable.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Tx {
    /// Drop all confirmed replicated state (records, files, resources, settings,
    /// tombstones, aliases, conflicts, receipts) before applying the rest. Snapshot
    /// installs and resets. Pending rows, local receipts, holds, meta, transfers, the
    /// blob cache, the retained tail and own-retained rows are kept.
    pub clear_confirmed: bool,
    /// New applied head.
    pub head: Option<Head>,

    /// Records to put (by ID; a path change is a move).
    pub records_put: Vec<RecordRow>,
    /// Records to remove (their tombstones are in `tombstones_put`).
    pub records_del: Vec<Uuid>,
    /// Trusted query projection changes; atomic with these record changes.
    pub query_index: Option<crate::store_query::QueryIndexTx>,
    /// Files to put.
    pub files_put: Vec<FileRow>,
    /// Files to remove.
    pub files_del: Vec<Uuid>,
    /// Resources to put: `(path, doc)`.
    pub resources_put: Vec<(String, String)>,
    /// Resources to remove.
    pub resources_del: Vec<String>,
    /// The file inclusion policy.
    pub settings: Option<FileInclusion>,
    /// Tombstones to put (a resurrection deletes the tombstone).
    pub tombstones_put: Vec<TombstoneRow>,
    /// Tombstones to delete.
    pub tombstones_del: Vec<Uuid>,
    /// Aliases to put (by path key; a later alias for a key replaces it).
    pub aliases_put: Vec<AliasRow>,
    /// Conflicts to record.
    pub conflicts_put: Vec<ConflictRow>,
    /// Conflicts to dismiss: `(mutation, id)`.
    pub conflicts_del: Vec<(Uuid, Uuid)>,
    /// Confirmed receipts to record.
    pub receipts_put: Vec<ReceiptRow>,
    /// Horizon pruning of receipts and tombstones.
    pub prune: Option<Prune>,

    /// Pending rows to put (insert, or replace by `order`).
    pub pending_put: Vec<PendingRow>,
    /// Pending rows to drop, by mutation ID.
    pub pending_del: Vec<Uuid>,
    /// Local receipts to put.
    pub local_receipts_put: Vec<LocalReceipt>,
    /// Drop local receipts resolved before this time.
    pub local_receipts_prune: Option<TimeMs>,
    /// Holds to put (by ID).
    pub holds_put: Vec<Hold>,
    /// Holds to release.
    pub holds_del: Vec<Uuid>,
    /// Replica-owned singletons to set (`Some`) or delete (`None`).
    pub meta: Vec<(String, Option<Vec<u8>>)>,
    /// Upload transfers to put.
    pub transfers_put: Vec<TransferRow>,
    /// Upload chunks: `(transfer, index, bytes)`.
    pub transfer_chunks: Vec<(Uuid, u64, Vec<u8>)>,
    /// Transfers to drop, with their chunks.
    pub transfers_del: Vec<Uuid>,
    /// Plaintext blob bytes for the local blob cache: `(plain digest, offset, bytes)`.
    pub blob_parts: Vec<(Hash, u64, Vec<u8>)>,
    /// Blobs to drop from the local cache.
    pub blobs_del: Vec<Hash>,
    /// Observations ingested: the store may release their evidence and record the
    /// observed bytes as known.
    pub ack_observations: Vec<ObservationId>,
    /// Retained tail rows to put (replace by `seq`). Applied after the tail drops below.
    pub tail_put: Vec<TailRow>,
    /// Drop tail rows with `seq < n` (retention pruning).
    pub tail_drop_below: Option<Seq>,
    /// Drop tail rows with `seq > n` (rollback). `Some(0)` drops all rows,
    /// including any accepted position zero; `Some(u64::MAX)` drops nothing.
    pub tail_drop_above: Option<Seq>,
    /// This replica's own mutations, kept after confirmation at their position so a
    /// rollback can re-queue them. Same durability as pending rows: a confirm commit
    /// carries `pending_del` and this put together, and stores make both durable as
    /// one unit. Applied after the drops below.
    pub own_retained_put: Vec<(Seq, PendingRow)>,
    /// Drop own-retained rows with `seq < n`.
    pub own_retained_drop_below: Option<Seq>,
    /// Drop own-retained rows with `seq > n` (rollback re-queues them as pending).
    /// `Some(0)` drops all rows; `Some(u64::MAX)` drops nothing.
    pub own_retained_drop_above: Option<Seq>,
    /// Publishes, performed after the rest is durable.
    pub publish: Vec<Publish>,
    /// Snapshot install staging (`snapshot.md` §8), only for stores whose
    /// [`Store::stages`] is true. Default: none.
    pub stage: Stage,
}

/// How a transaction uses the store's staging area: a snapshot install stages its
/// rows chunk by chunk, then swaps them in atomically, so the replica never holds
/// the whole state in memory.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Stage {
    /// No staging.
    #[default]
    None,
    /// The confirmed-state rows of this transaction ([`Tx::take_confirmed_rows`])
    /// go to the staging area instead of confirmed state. The rest applies as usual.
    Put,
    /// Replace all confirmed state with the staging area, which becomes empty, then
    /// apply the rest of the transaction, atomically.
    Swap,
    /// Empty the staging area, then apply the rest.
    Discard,
}

impl Tx {
    /// True when committing would change nothing.
    pub fn is_empty(&self) -> bool {
        *self == Tx::default()
    }

    /// Move out the confirmed-state rows (records, files, resources, settings,
    /// tombstones, aliases, conflicts, receipts: what [`Tx::clear_confirmed`] drops).
    pub fn take_confirmed_rows(&mut self) -> Tx {
        Tx {
            records_put: std::mem::take(&mut self.records_put),
            records_del: std::mem::take(&mut self.records_del),
            query_index: self.query_index.take(),
            files_put: std::mem::take(&mut self.files_put),
            files_del: std::mem::take(&mut self.files_del),
            resources_put: std::mem::take(&mut self.resources_put),
            resources_del: std::mem::take(&mut self.resources_del),
            settings: self.settings.take(),
            tombstones_put: std::mem::take(&mut self.tombstones_put),
            tombstones_del: std::mem::take(&mut self.tombstones_del),
            aliases_put: std::mem::take(&mut self.aliases_put),
            conflicts_put: std::mem::take(&mut self.conflicts_put),
            conflicts_del: std::mem::take(&mut self.conflicts_del),
            receipts_put: std::mem::take(&mut self.receipts_put),
            ..Tx::default()
        }
    }
}

// ------------------------------------------------------------------ errors

/// A store failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreError {
    /// ONLY returned by `Store::commit`: this transaction had NO effect, and
    /// the entire preceding store state is
    /// fully durable. This is a strong guarantee, not merely a logical rollback.
    /// An adapter with pending/deferred/uncertain durability MUST downgrade an
    /// inner `CommitAborted` to `Io`; unchanged cached reads are insufficient.
    CommitAborted(String),
    /// I/O failed; a commit's durable outcome is unknown unless explicitly
    /// reported as `CommitAborted`. Recovery may require reopening storage.
    Io(String),
    /// The device is out of space (or the platform quota misreports).
    Full,
    /// Stored state is unreadable. The replica reports an incident and rebuilds
    /// derived state where it can.
    Corrupt(String),
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StoreError::CommitAborted(m) => write!(f, "store commit aborted: {m}"),
            StoreError::Io(m) => write!(f, "store i/o: {m}"),
            StoreError::Full => write!(f, "store full"),
            StoreError::Corrupt(m) => write!(f, "store corrupt: {m}"),
        }
    }
}

impl std::error::Error for StoreError {}

/// Store result.
pub type StoreResult<T> = Result<T, StoreError>;

// ------------------------------------------------------------------ the trait

/// Persistent state of one replica of one collection.
///
/// Single-threaded: the replica calls a store from one thread at a time, and never
/// concurrently with itself. Implementations need no internal locking for that.
pub trait Store {
    // ---- confirmed replicated state ----

    /// The applied head, [`Head::GENESIS`] for a new store.
    fn head(&self) -> StoreResult<Head>;
    /// A record by ID.
    fn record(&self, id: &Uuid) -> StoreResult<Option<RecordRow>>;
    /// The live record at a path key.
    fn record_at(&self, path_key: &str) -> StoreResult<Option<Uuid>>;
    /// Records in ID order (state digest, snapshot builds, verification).
    fn records(&self, page: Page) -> StoreResult<Vec<RecordRow>>;
    /// Records whose [`bucket16`] is in `range`, in ID order.
    fn records_in_buckets(&self, range: Range<u32>, page: Page) -> StoreResult<Vec<RecordRow>>;
    /// Number of live records.
    fn record_count(&self) -> StoreResult<u64>;
    /// A file by ID.
    fn file(&self, id: &Uuid) -> StoreResult<Option<FileRow>>;
    /// The live file at a path key.
    fn file_at(&self, path_key: &str) -> StoreResult<Option<Uuid>>;
    /// Files in ID order.
    fn files(&self, page: Page) -> StoreResult<Vec<FileRow>>;
    /// Files whose [`bucket16`] is in `range`, in ID order.
    fn files_in_buckets(&self, range: Range<u32>, page: Page) -> StoreResult<Vec<FileRow>>;
    /// A resource document by path.
    fn resource(&self, path: &str) -> StoreResult<Option<String>>;
    /// All resources, by path (bytewise). Resources are few and small.
    fn resources(&self) -> StoreResult<Vec<(String, String)>>;
    /// Bounded tracked paths without loading documents or materializing the
    /// whole inventory. Backends must bound row count and path length before
    /// copying, and refuse rather than silently excluding over-bound rows.
    fn resource_paths_page(&self, _page: ResourcePathPage<'_>) -> StoreResult<Vec<String>> {
        Err(StoreError::Io(
            "bounded resource inventory unavailable".into(),
        ))
    }
    /// Read the same authoritative source as `resource`, projecting its byte
    /// length before any owned source copy. Never fall back to an unbounded read.
    fn resource_bounded(
        &self,
        _path: &str,
        _copy_limit: usize,
    ) -> StoreResult<Option<BoundedResource>> {
        Err(StoreError::Io("bounded resource source unavailable".into()))
    }
    /// The file inclusion policy, `None` before any was set (the default applies).
    fn settings(&self) -> StoreResult<Option<FileInclusion>>;
    /// A tombstone by ID.
    fn tombstone(&self, id: &Uuid) -> StoreResult<Option<TombstoneRow>>;
    /// Tombstones whose last path key is `path_key` (join, snapshot.md §9), by ID.
    fn tombstones_at(&self, path_key: &str) -> StoreResult<Vec<TombstoneRow>>;
    /// Tombstones in ID order.
    fn tombstones(&self, page: Page) -> StoreResult<Vec<TombstoneRow>>;
    /// The record an alias path key refers to.
    fn alias(&self, path_key: &str) -> StoreResult<Option<Uuid>>;
    /// All aliases, by path (bytewise).
    fn aliases(&self) -> StoreResult<Vec<AliasRow>>;
    /// Unresolved conflicts, optionally of one record or file, by `(mutation, id)`.
    fn conflicts(&self, of: Option<&Uuid>) -> StoreResult<Vec<ConflictRow>>;
    /// Number of unresolved conflicts.
    fn conflict_count(&self) -> StoreResult<u64>;
    /// A confirmed receipt.
    fn receipt(&self, mutation: &Uuid) -> StoreResult<Option<ReceiptRow>>;
    /// Confirmed receipts in mutation-ID order (snapshot builds).
    fn receipts(&self, after: Option<Uuid>, limit: u32) -> StoreResult<Vec<ReceiptRow>>;

    // ---- planner lookups over derived index entries ----

    /// Records with a link through any of these target keys, by ID.
    fn referrers(&self, target_keys: &[String]) -> StoreResult<Vec<Uuid>>;
    /// Records holding `value_key` in a `unique.enforce` field, by ID.
    fn unique_holders(&self, field: &str, value_key: &str) -> StoreResult<Vec<Uuid>>;
    /// Candidate records for a query, in ID order. May be a superset.
    fn candidates(&self, q: &Candidate, page: Page) -> StoreResult<Vec<RecordRow>>;

    /// Whether this store maintains the query index at all. Wrappers forward it.
    /// The replica only backfills (index-only commits) when this is true.
    fn query_index_supported(&self) -> bool {
        false
    }
    /// A separately materialized index. None means unavailable, NOT a full-row fallback.
    fn query_index_state(&self) -> StoreResult<Option<crate::store_query::QueryIndexState>> {
        Ok(None)
    }
    /// Bounded ID/key selection only; never copies/decodes record source BLOBs.
    fn query_index_page(
        &self,
        _request: &crate::store_query::QueryIndexRequest,
    ) -> StoreResult<Option<crate::store_query::QueryIndexPage>> {
        Ok(None)
    }
    /// The raw projection's own readiness (its payload is materialized apart
    /// from the field index). `None`: not implemented. Wrappers forward it.
    fn query_projection_state(
        &self,
    ) -> StoreResult<Option<crate::store_query::QueryProjectionState>> {
        Ok(None)
    }
    /// A bounded raw projection page under the request's generation and head
    /// (see [`crate::store_query::QueryProjectionRequest`]). Never reads document
    /// BLOBs. Unsupported backends error; they never return an empty page.
    fn query_projection_page(
        &self,
        _request: &crate::store_query::QueryProjectionRequest,
    ) -> StoreResult<crate::store_query::QueryProjectionPage> {
        Err(StoreError::Io("query projection unsupported".into()))
    }
    /// Preflight cumulative encoded source bytes BEFORE BLOB copy/decode.
    /// Unimplemented backends must not pretend a whole-row lookup is preflight.
    fn hydrate_query_at(
        &self,
        _ids: &[Uuid],
        _head: Head,
        _budget: &mut crate::store_query::QueryBudget,
    ) -> StoreResult<Vec<RecordRow>> {
        Err(StoreError::Io("bounded query hydration unavailable".into()))
    }

    /// ID-order source-size page at a captured head, without copying source
    /// documents. At most 1000 identities; oversized limits must fail explicitly.
    /// Does not require a ready optional field index. A short page is EOF only
    /// for this source scan, not proof of a residual query's complete match set.
    fn query_record_sizes_at(
        &self,
        _page: Page,
        _head: Head,
    ) -> StoreResult<Vec<crate::store_query::QueryRecordSize>> {
        Err(StoreError::Io(
            "bounded query source selection unavailable".into(),
        ))
    }

    // ---- replica-local state ----

    /// Pending rows in capture order, starting after `after_order`.
    fn pending(&self, after_order: Option<u64>, limit: u32) -> StoreResult<Vec<PendingRow>>;
    /// A pending row by mutation ID.
    fn pending_get(&self, mutation: &Uuid) -> StoreResult<Option<PendingRow>>;
    /// Number of pending rows.
    fn pending_count(&self) -> StoreResult<u64>;
    /// A local receipt.
    fn local_receipt(&self, mutation: &Uuid) -> StoreResult<Option<LocalReceipt>>;
    /// Holds, by ID.
    fn holds(&self) -> StoreResult<Vec<Hold>>;
    /// A hold by ID.
    fn hold(&self, id: &Uuid) -> StoreResult<Option<Hold>>;
    /// A replica-owned singleton.
    fn meta(&self, key: &str) -> StoreResult<Option<Vec<u8>>>;
    /// An upload transfer.
    fn transfer(&self, id: &Uuid) -> StoreResult<Option<TransferRow>>;
    /// One received chunk of a transfer.
    fn transfer_chunk(&self, id: &Uuid, index: u64) -> StoreResult<Option<Vec<u8>>>;
    /// Size of a blob in the local cache, if it is complete there.
    fn blob_size(&self, digest: &Hash) -> StoreResult<Option<u64>>;
    /// Read from a cached blob.
    fn blob_read(&self, digest: &Hash, offset: u64, len: u64) -> StoreResult<Vec<u8>>;

    // ---- lost-tail retention (device-local; defaults retain nothing) ----

    /// Retained tail rows with `seq > after`, in `seq` order.
    /// `after = u64::MAX` always returns no rows.
    fn tail(&self, _after: Seq, _limit: u32) -> StoreResult<Vec<TailRow>> {
        Ok(Vec::new())
    }
    /// Size of the retained tail.
    fn tail_stats(&self) -> StoreResult<TailStats> {
        Ok(TailStats::default())
    }
    /// Own-retained rows with `seq > after`, in `seq` order.
    fn own_retained(&self, _after: Seq, _limit: u32) -> StoreResult<Vec<(Seq, PendingRow)>> {
        Ok(Vec::new())
    }

    // ---- writes ----

    /// Apply a transaction atomically and durably, then perform its publishes.
    fn commit(&mut self, tx: Tx) -> StoreResult<CommitReport>;

    /// Reserve an immutable, isolated UNVERIFIED private candidate. Does not
    /// permit confirmed-state changes, normal staging, observation ACK or swap.
    /// Every backend checks exact current Joining marker/identity/old-head CAS.
    /// All hooks share the verifier's working account, reserving bounded control
    /// workspace before metadata/SQL allocation; only durable backends qualify.
    fn mirror_candidate_begin(
        &mut self,
        _request: &crate::mirror_admission::candidate::Request,
        _working: &crate::mirror_admission::install_budget::WorkingSet,
    ) -> Result<(), crate::mirror_admission::candidate::Error> {
        Err(crate::mirror_admission::candidate::Error::Unsupported)
    }
    /// Durably reserve a bounded part BEFORE requesting/allocating its body.
    /// Aggregate old/unknown candidates and bytes remain charged; no cleanup.
    fn mirror_candidate_reserve(
        &mut self,
        _request: &crate::mirror_admission::candidate::Request,
        _ordinal: u64,
        _bytes: u64,
        _working: &crate::mirror_admission::install_budget::WorkingSet,
    ) -> Result<(), crate::mirror_admission::candidate::Error> {
        Err(crate::mirror_admission::candidate::Error::Unsupported)
    }
    /// Read one isolated resident part into this attempt's charged Buffer.
    /// Implementations precharge initialization/read/copy/hash before allocation
    /// or IO, and retain backend/output/control allowances simultaneously.
    /// The expected address is only a DATA claim, never verified provenance.
    /// Any refusal returns no usable body; the closed caller requires reopen.
    fn mirror_candidate_read(
        &mut self,
        _request: &crate::mirror_admission::candidate::Request,
        _ordinal: u64,
        _expected_address: &Hash,
        _working: &crate::mirror_admission::install_budget::WorkingSet,
    ) -> Result<
        crate::mirror_admission::install_budget::Buffer,
        crate::mirror_admission::candidate::Error,
    > {
        Err(crate::mirror_admission::candidate::Error::Unsupported)
    }
    /// Fill only a previously reserved part; same exact bytes retry is idempotent.
    /// This evidence/receipt never authenticates content or permits a swap. All
    /// persistence errors invalidate the caller's handle and require reopen.
    /// Body must belong to the same working account; ownership/accounting alone
    /// is never verifier authority. No uncharged Vec is accepted.
    fn mirror_candidate_write(
        &mut self,
        _request: &crate::mirror_admission::candidate::Request,
        _ordinal: u64,
        _body: crate::mirror_admission::install_budget::Buffer,
        _working: &crate::mirror_admission::install_budget::WorkingSet,
    ) -> Result<(), crate::mirror_admission::candidate::Error> {
        Err(crate::mirror_admission::candidate::Error::Unsupported)
    }

    /// Open (`true`) or close (`false`) a deferred-durability window. Inside
    /// one, a commit may become durable only at the next barrier: closing the
    /// window, any commit with an outside effect (a file publish, evidence
    /// removal), or the store's own bound. Durability stays prefix-ordered: a
    /// crash keeps every commit before some point and loses every one after.
    /// The replica opens a window only around commits that can be redone from
    /// what is still on disk (ingest of files no client write depends on).
    /// Closing it is a barrier: everything committed before is durable when it
    /// returns `Ok`. Stores without such a mode keep every commit durable.
    fn defer_durability(&mut self, _on: bool) -> StoreResult<()> {
        Ok(())
    }

    /// Whether a deferred-durability window is open. Nothing that leaves the
    /// device or depends on durable state (opening a synced replica, a log
    /// append, a snapshot) may start while one is.
    fn durability_deferred(&self) -> bool {
        false
    }

    // ---- the disk (file-backed stores; defaults suit stores without files) ----

    /// Whether records are user-visible files that the store publishes and observes.
    fn has_files(&self) -> bool {
        false
    }
    /// Whether the store implements [`Tx::stage`]. Without it a snapshot install
    /// holds the whole staged state in memory.
    fn stages(&self) -> bool {
        false
    }
    /// Whether the epoch keyring may be written to this store at all
    /// ([`KeyringPersistence`]). Default: [`KeyringPersistence::Plaintext`].
    fn keyring_persistence(&self) -> KeyringPersistence {
        KeyringPersistence::Plaintext
    }
    /// What the store last knew was on disk at `path` (`None`: nothing). File-backed
    /// stores answer from their disk state (their own publishes and acknowledged
    /// observations), without reading the file. Used to reconcile the folder with the
    /// local view when the replica opens (a crash can land between a commit and its
    /// publishes).
    fn disk_revision(&self, _path: &str) -> StoreResult<Option<Hash>> {
        Ok(None)
    }
    /// Every path the store last knew to hold bytes, with their revisions, sorted by
    /// path. Same source as [`Store::disk_revision`].
    fn disk_paths(&self) -> StoreResult<Vec<(String, Hash)>> {
        Ok(Vec::new())
    }
    /// Observations not yet acknowledged: re-delivered evidence from before a crash,
    /// then changes since the last call. `paths` narrows a scan (`None` = what the
    /// store's watcher queued, or a full scan when it has lost track).
    fn observe(&mut self, _paths: Option<&[String]>) -> StoreResult<Vec<Observation>> {
        Ok(Vec::new())
    }
    /// A bounded positional reader of the file at `path` for an attachment
    /// upload, which must still be a regular file of `size` bytes. `None` when
    /// it is not (gone, changed size) or the store cannot stream files. The
    /// reader refuses any later change to the file (`source_changed`).
    fn attachment_source(
        &mut self,
        _path: &str,
        _size: u64,
    ) -> StoreResult<Option<Box<dyn crate::replica::AttachmentSource>>> {
        Ok(None)
    }
    // ---- attachment-v1 files (file-backed stores that materialize them) ----
    //
    // Large files never pass through a [`Tx`] or the blob cache: the replica
    // streams authenticated plaintext into a private staging file, one chunk
    // at a time, and places it with the never-clobber rules of [`Publish`]
    // (a conditional, atomic rename). Each operation records the path's new
    // disk state, so the store's own observation never re-ingests it (echo
    // fence). Defaults: no attachment materialization (rows stay `Remote`).

    /// Whether this store materializes attachment-v1 files.
    fn materializes_attachments(&self) -> bool {
        false
    }
    /// Bytes durably staged for `key`; 0 when nothing is staged.
    fn attachment_staged(&mut self, _key: &StageKey) -> StoreResult<u64> {
        Err(StoreError::Io("attachment staging unsupported".into()))
    }
    /// Append authenticated plaintext to `key`'s staging. `offset` is the staged
    /// length (writes only extend it); durable before this returns.
    fn attachment_stage(
        &mut self,
        _key: &StageKey,
        _offset: u64,
        _plain: &[u8],
    ) -> StoreResult<()> {
        Err(StoreError::Io("attachment staging unsupported".into()))
    }
    /// Read up to `len` staged bytes at `offset` (re-hashing after a resume).
    fn attachment_stage_read(
        &mut self,
        _key: &StageKey,
        _offset: u64,
        _len: u32,
    ) -> StoreResult<Vec<u8>> {
        Err(StoreError::Io("attachment staging unsupported".into()))
    }
    /// Drop `key`'s staging, if any.
    fn attachment_unstage(&mut self, _key: &StageKey) -> StoreResult<()> {
        Ok(())
    }
    /// Place `key`'s staged file (of revision `rev`) at `path` if the path holds
    /// `expect`, atomically; the staging is consumed. A drift leaves the staging.
    fn attachment_publish(
        &mut self,
        _key: &StageKey,
        _rev: Hash,
        _path: &str,
        _expect: Expect,
    ) -> DiskResult {
        Err(StoreError::Io("attachment publish unsupported".into()))
    }
    /// Remove the file at `path` if it holds revision `expect`.
    fn attachment_remove(&mut self, _id: Uuid, _path: &str, _expect: Hash) -> DiskResult {
        Err(StoreError::Io("attachment publish unsupported".into()))
    }
    /// Move the file at `from` (holding revision `expect`) to `to`, which must be
    /// absent. Metadata only: the bytes are not read again or rewritten.
    fn attachment_move(&mut self, _id: Uuid, _from: &str, _to: &str, _expect: Hash) -> DiskResult {
        Err(StoreError::Io("attachment publish unsupported".into()))
    }

    /// Outcomes of deferred publish batches ([`CommitReport::deferred`]) completed
    /// since the last call, in completion order. Stores that publish inside
    /// `commit` never defer and return nothing. The host calls
    /// `Replica::on_store_progress` when it has completed file operations.
    fn take_publish_results(&mut self) -> Vec<PublishResult> {
        Vec::new()
    }
}

/// Where a replica keeps its epoch keyring between opens: a property of the
/// store composition, declared by the store.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum KeyringPersistence {
    /// The keyring is persisted in meta ([`meta_keys::KEYRING`]) and the store
    /// keeps it with the platform's protection (native daemon and desktop
    /// stores, as today).
    #[default]
    Plaintext,
    /// The keyring is never given to the store: no commit carries
    /// [`meta_keys::KEYRING`] and the replica holds it in memory only. A reopen
    /// with confirmed state rebuilds it from the log: every control item up to
    /// the store's head is read again and verified into a fresh policy state
    /// (which must equal the stored one), and the rekeys and key grants are
    /// unwrapped with the device KEM key the host supplies from its custody.
    /// Until then the replica neither reads nor appends; local reads and
    /// pending captures continue. For stores without platform protection for
    /// secrets (the app's OPFS/sqlite-wasm store).
    RebuildOnOpen,
}

/// One meta row write (`None` deletes it).
pub type MetaPut = (String, Option<Vec<u8>>);

/// Meta keys the replica uses. Stores treat values as opaque bytes.
pub mod meta_keys {
    /// This replica's identity: replica ID, collection.
    pub const IDENTITY: &str = "replica.identity";
    /// Policy state `P` at the head (policy.md §6.1).
    pub const POLICY: &str = "replica.policy";
    /// Epoch keys. Secret: stores keep it with the platform's protection.
    pub const KEYRING: &str = "replica.keyring";
    /// Log time and the semantics ratchet at the head.
    pub const LOG_STATE: &str = "replica.log_state";
    /// The next capture order and the monotonic clock clamp.
    pub const COUNTERS: &str = "replica.counters";
    /// Snapshot install in progress.
    pub const INSTALL: &str = "replica.install";
    /// Lost-tail fallback: own acknowledged mutations put back for resurrection,
    /// with their earlier positions (24-byte records: mutation ID ‖ old seq).
    pub const RESURRECT: &str = "replica.resurrect";
    /// Lost-tail revocation latch: revocations seen at an applied
    /// position that the current log lacks. Device-local; only restricts.
    pub const LATCH: &str = "replica.latch";
    /// The last `log_regressed` signal: from ‖ to ‖ outcome ‖ raised_at (BE u64/i64).
    pub const LOG_REGRESSED: &str = "replica.log_regressed";
    /// Lost-tail orphans: other authors' lost entries, and own writes lost after
    /// revocation (49-byte records).
    pub const ORPHANS: &str = "replica.orphans";
    /// Device materialization policy.
    pub const MATERIALIZATION: &str = "replica.materialization";
    /// Local-only grants (collections without a log, policy.md preamble).
    pub const LOCAL_GRANTS: &str = "replica.local_grants";
    /// Prefix of the per-file record of an attachment-v1 file this replica placed
    /// on disk: `prefix ‖ hex(file ID)` = CBOR `[path, whole plaintext SHA-256]`.
    /// Device-local.
    pub const ATTACHMENT_SHOWN: &str = "replica.attachment_shown.";
    /// Prefix of the checkpoint of an upload of a file ingested from disk:
    /// `prefix ‖ hex(SHA-256(path key))` = `AttachmentUploadCheckpoint` bytes.
    /// Device-local (it holds plaintext chunk hashes); resumed when the file is
    /// observed again after a restart.
    pub const ATTACHMENT_INGEST: &str = "replica.attachment_ingest.";
    /// The chain hash of seq 1 as this store applied it, committed with it. Store
    /// identity consistency for the host's genesis pin; not an attestation of the
    /// log, its head or admission.
    pub const GENESIS: &str = "replica.genesis";
}
