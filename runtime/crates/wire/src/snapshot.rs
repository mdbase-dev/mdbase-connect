//! Snapshot manifest, chunks and rows, and the `base` item
//! (`docs/contracts/snapshot.md`).

use crate::cbor::Cbor;
use crate::common::{B32, Hash, Sem, Uuid};
use crate::entry::{Alias, Conflict};
use crate::intent::{BlobRef, FileInclusion, MediaClass};
use crate::schema::{Ann, SchemaError, Wire, type_err};
use crate::{wire_enum, wire_struct, wire_tuple};

wire_enum! {
    /// Snapshot sections.
    pub enum SectionKind {
        /// Config, types, contracts.
        Resources = 1,
        /// ID, kind, path, revision, size, modified_seq.
        Index = 2,
        /// Record documents.
        Records = 3,
        /// The file manifest.
        Files = 4,
        /// Tombstones.
        Tombstones = 5,
        /// Aliases.
        Aliases = 6,
        /// Unresolved conflicts.
        Conflicts = 7,
        /// Receipts.
        Receipts = 8,
        /// The file inclusion policy.
        Settings = 9,
    }
}

wire_struct! {
    /// Reference to one chunk object.
    pub struct ChunkRef {
        /// Address: SHA-256 of the sealed chunk object.
        0 req address: B32,
        /// SHA-256 of the chunk payload's canonical bytes.
        1 req plain_hash: Hash,
        /// Number of rows.
        2 req rows: u64,
        /// Bucket or ordinal.
        3 req bucket: u64,
        /// Canonical payload bytes before compression.
        4 req plain_size: u64,
    }
}

wire_struct! {
    /// One section of a manifest.
    pub struct Section {
        /// Which section.
        0 req kind: SectionKind,
        /// Chunks, in bucket order for bucketed sections.
        1 req chunks: Vec<ChunkRef>,
    }
}

wire_struct! {
    /// The receipts and tombstone horizon a snapshot applied (snapshot.md §6).
    pub struct Horizon {
        /// Position floor.
        0 req seq_floor: u64,
        /// Log-time floor.
        1 req time_floor: i64,
    }
}

wire_struct! {
    /// Payload of a `manifest` object (snapshot.md §2).
    pub struct ManifestPayload [fmt = 1] {
        /// State after applying every item ≤ seq (0 for a base).
        1 req seq: u64,
        /// chain(seq) (zero for a base).
        2 req chain: Hash,
        /// State digest (snapshot.md §4).
        3 req state_digest: Hash,
        /// Bucketed sections have 2^bucket_bits buckets.
        4 req bucket_bits: u64,
        /// Sections, in section-kind order.
        5 req1 sections: Vec<Section>,
        /// Horizon applied.
        6 req horizon: Horizon,
        /// Builder's semantics version (informational).
        7 req sem: Sem,
        /// Number of records.
        8 req record_count: u64,
        /// Number of files.
        9 req file_count: u64,
        /// Manifest this one was built from.
        10 opt previous: Hash,
        /// `ctl(seq)`, the control-item accumulator (snapshot.md §8.1).
        11 req control_chain: Hash,
    }
}

wire_struct! {
    /// Payload of a `chunk` object. Rows are kept raw; decode them with
    /// [`ChunkPayload::rows_as`] according to `section`.
    pub struct ChunkPayload [fmt = 1] {
        /// Section.
        1 req section: SectionKind,
        /// Bucket or ordinal.
        2 req bucket: u64,
        /// Rows, sorted by the section's key.
        3 req rows: Vec<Cbor>,
    }
}

impl ChunkPayload {
    /// Decode every row as `T`.
    pub fn rows_as<T: Wire>(&self) -> Result<Vec<T>, SchemaError> {
        self.rows.iter().map(T::from_cbor).collect()
    }
}

/// `snapshot-text`: a document inline, or stored as a blob. Also used for hold
/// contents in the client API.
#[derive(Debug, Clone, PartialEq)]
pub enum TextOrBlob {
    /// Inline text.
    Text(String),
    /// Stored in the blob store.
    Blob(BlobRef),
    /// Full attachment descriptor in a hold. Critical closed arm; not a
    /// snapshot record/resource/tombstone text source.
    Attachment(crate::attachment::AttachmentContentV1),
}

impl Wire for TextOrBlob {
    fn to_cbor(&self) -> Cbor {
        match self {
            TextOrBlob::Text(s) => Cbor::Text(s.clone()),
            TextOrBlob::Blob(b) => b.to_cbor(),
            TextOrBlob::Attachment(c) => Cbor::Array(vec![Cbor::Uint(1), c.to_cbor()]),
        }
    }
    fn from_cbor(c: &Cbor) -> Result<Self, SchemaError> {
        match c {
            Cbor::Text(s) => Ok(TextOrBlob::Text(s.clone())),
            Cbor::Map(_) => Ok(TextOrBlob::Blob(BlobRef::from_cbor(c)?)),
            Cbor::Array(a) if a.len() == 2 && a[0] == Cbor::Uint(1) => Ok(TextOrBlob::Attachment(
                crate::attachment::AttachmentContentV1::from_cbor(&a[1])?,
            )),
            _ => Err(type_err(
                "snapshot-text",
                "text, blob-ref or attachment hold",
                c,
            )),
        }
    }
    fn annotate(&self) -> Ann {
        match self {
            TextOrBlob::Text(s) => Ann::Leaf(Cbor::Text(s.clone())),
            TextOrBlob::Blob(b) => b.annotate(),
            TextOrBlob::Attachment(c) => Ann::Tuple(
                "hold-attachment",
                vec![
                    ("tag", Ann::Enum("Attachment", 1)),
                    ("content", c.annotate()),
                ],
            ),
        }
    }
}

wire_enum! {
    /// Record or file.
    pub enum EntityKind {
        /// A record.
        Record = 0,
        /// A file.
        File = 1,
    }
}

wire_tuple! {
    /// `resource-row`.
    pub struct ResourceRow {
        /// Path.
        path: String,
        /// Document.
        doc: TextOrBlob,
    }
}

wire_struct! {
    /// `index-row`.
    pub struct IndexRow {
        /// ID.
        0 req id: Uuid,
        /// Record or file.
        1 req kind: EntityKind,
        /// Path.
        2 req path: String,
        /// SHA-256 of the exact bytes.
        3 req revision: Hash,
        /// Size in bytes.
        4 req size: u64,
        /// Position of the last change (0 = adopted, unchanged).
        5 req modified_seq: u64,
    }
}

wire_tuple! {
    /// `record-row`.
    pub struct RecordRow {
        /// Record ID.
        id: Uuid,
        /// Path.
        path: String,
        /// Document.
        doc: TextOrBlob,
    }
}

wire_tuple! {
    /// `file-row`: the file manifest.
    pub struct FileRow {
        /// File ID.
        id: Uuid,
        /// Path.
        path: String,
        /// Content.
        blob: BlobRef,
        /// Media class.
        media: MediaClass,
    }
}

wire_tuple! {
    /// `tombstone-row`.
    pub struct TombstoneRow {
        /// ID.
        id: Uuid,
        /// Record or file.
        kind: EntityKind,
        /// Last path.
        path: String,
        /// Last document, or the file's blob-ref.
        last: TextOrBlob,
        /// Deleted at.
        seq: u64,
        /// Deleted when (log time).
        time: i64,
    }
}

/// `alias-row` is an [`Alias`].
pub type AliasRow = Alias;

wire_tuple! {
    /// `conflict-row`.
    pub struct ConflictRow {
        /// Mutation the conflict belongs to.
        mutation: Uuid,
        /// Position.
        seq: u64,
        /// The conflict.
        conflict: Conflict,
    }
}

wire_tuple! {
    /// `receipt-row`.
    pub struct ReceiptRow {
        /// Mutation ID.
        mutation: Uuid,
        /// Position.
        seq: u64,
        /// The mutation's clock instant.
        time: i64,
    }
}

/// `settings-row` is a [`FileInclusion`].
pub type SettingsRow = FileInclusion;

wire_enum! {
    /// Where adopted state came from.
    pub enum BaseSource {
        /// A folder adopted in place.
        Folder = 0,
        /// A hosted Connect collection imported at migration.
        HostedImport = 1,
    }
}

/// Most pre-history archive segments a `base` item may carry (snapshot.md §7,
/// `[1*64 blob-ref]`). A replica refuses a base over this bound.
pub const MAX_PREHISTORY_SEGMENTS: usize = 64;

wire_struct! {
    /// Payload of a `base` item (snapshot.md §7).
    pub struct BasePayload [fmt = 1] {
        /// Address of the generation-0 manifest.
        1 req manifest: B32,
        /// Its state digest.
        2 req state_digest: Hash,
        /// Replica that adopted.
        3 req adopter: Uuid,
        /// Source.
        4 req source: BaseSource,
        /// The Connect collection imported (migration).
        5 opt legacy_collection: Uuid,
        /// Ordered sealed segments of the legacy version-history archive
        /// (migration pre-history): opaque to replay, apply, policy and indexing;
        /// every segment's part addresses are in the item's `refs`. At most
        /// [`MAX_PREHISTORY_SEGMENTS`].
        6 opt1 prehistory: Vec<BlobRef>,
    }
}

/// `ctl(p)` from `ctl(p')` for a control item at `p` (snapshot.md §8.1):
/// `H("mdbase/v1/ctl-chain", ctl(p') ‖ u64be(p) ‖ chain(p))`.
pub fn ctl_chain_next(prev: &Hash, seq: u64, chain: &Hash) -> Hash {
    let mut m = Vec::with_capacity(32 + 8 + 32);
    m.extend_from_slice(&prev.0);
    m.extend_from_slice(&seq.to_be_bytes());
    m.extend_from_slice(&chain.0);
    crate::hash::h("mdbase/v1/ctl-chain", &m)
}
