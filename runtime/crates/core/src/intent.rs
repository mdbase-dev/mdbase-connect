//! The mutation model the planner consumes (`docs/contracts/intent.md`).
//!
//! These are the *semantic* shapes: every `text` is a resolved `String`, values
//! are [`crate::value::Value`], and identifiers are [`Uuid`]/[`Hash`]. The wire
//! encoding (`mdbn_wire::intent`) carries the same fields; the replica converts
//! between the two after resolving a log entry's text table. Field names and
//! meanings follow `intent.md` exactly; the doc comments only point there.

use crate::ids::{FileId, Hash, MutationId, RecordId, Uuid};
use crate::value::{Map, Value};

/// One logical write: operations applied atomically, in order (`intent.md` §1).
#[derive(Debug, Clone, PartialEq)]
pub struct Mutation {
    /// Mutation ID (UUIDv7), the idempotency key.
    pub id: MutationId,
    /// The replica that captured it.
    pub origin: Uuid,
    /// The origin's confirmed position at capture. Informational for planning.
    pub base_seq: u64,
    /// The captured time (§4.1). Planning never reads a clock.
    pub clock: OpClock,
    /// Entropy for generated values (§4.3). Planning never reads entropy.
    pub seed: [u8; 32],
    /// `api` or `external`.
    pub source: Source,
    /// 1 to 1,000 operations.
    pub ops: Vec<Op>,
    /// Grant of the submitting client, if any. Not read by the planner (policy
    /// is the replica's job).
    pub on_behalf: Option<Uuid>,
    /// Conflict handling (default `record`).
    pub conflict_mode: ConflictMode,
    /// Validation level applied at submit (informational).
    pub validated_at: Option<Level>,
    /// Set when this write checkpoints a live room. Never changes planning.
    pub room: Option<RoomCheckpoint>,
}

/// The captured clock (`intent.md` §4.1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpClock {
    /// Milliseconds since the Unix epoch, UTC. Lifecycle `now` and CEL `now()`.
    pub instant_ms: i64,
    /// The IANA time zone used for calendar dates.
    pub tz: String,
    /// `YYYY-MM-DD`: the date of `instant_ms` in `tz`, computed by the origin.
    /// Lifecycle `today` and CEL `today()`. Replay never converts zones for it.
    pub local_date: String,
}

/// Where a mutation came from (`intent.md` §1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Source {
    /// A write through the API: lifecycle runs; request checks apply.
    Api,
    /// Derived by ingest from an observed file change: no lifecycle, never
    /// rejected. Only `document` and file operations.
    External,
}

/// How field conflicts are handled (`intent.md` §1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub enum ConflictMode {
    /// Apply what merges; record field conflicts; status `conflicted`.
    #[default]
    Record,
    /// Any conflict rejects the whole mutation.
    Reject,
}

/// A validation level (spec 04).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub enum Level {
    /// No single-record validation at write time.
    Off,
    /// Report issues, never reject.
    #[default]
    Warn,
    /// Reject writes with single-record errors (at submit only).
    Error,
}

impl Level {
    /// The spec name.
    pub fn as_str(self) -> &'static str {
        match self {
            Level::Off => "off",
            Level::Warn => "warn",
            Level::Error => "error",
        }
    }

    /// Parse a spec name.
    pub fn parse(s: &str) -> Option<Level> {
        match s {
            "off" => Some(Level::Off),
            "warn" => Some(Level::Warn),
            "error" => Some(Level::Error),
            _ => None,
        }
    }
}

/// A live-room checkpoint marker (`intent.md` §7). Informational.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RoomCheckpoint {
    /// The room's ephemeral stream ID.
    pub stream: [u8; 16],
    /// Digest of the room state captured.
    pub state: Hash,
}

/// One operation (`intent.md` §3).
#[derive(Debug, Clone, PartialEq)]
pub enum Op {
    /// §3.1
    Create(Create),
    /// §3.2
    Update(Update),
    /// §3.3
    Document(DocumentOp),
    /// §3.4
    Delete(Delete),
    /// §3.5
    Rename(Rename),
    /// §3.6
    ResourcePut(ResourcePut),
    /// §3.6
    ResourceDelete(ResourceDelete),
    /// §3.7
    FilePut(FilePut),
    /// §3.9 Critical attachment v1 create/replace.
    FileAttach(FileAttach),
    /// Critical Ordinary continuation at a record path with full descriptor CAS.
    OrdinaryAttachmentContinuation(OrdinaryAttachmentContinuation),
    /// §3.10 Critical unindexed oversized Markdown create/replace.
    UnindexedMarkdownPut(UnindexedMarkdownPut),
    /// §3.10 Atomic record -> unindexed oversized Markdown file transition.
    RecordToUnindexedMarkdown(RecordToUnindexedMarkdown),
    /// §3.10 Atomic unindexed oversized Markdown file -> record transition.
    UnindexedMarkdownToRecord(UnindexedMarkdownToRecord),
    /// §3.12 Trusted identity-preserving ordinary file promotion.
    OrdinaryFileToRecord(OrdinaryFileToRecord),
    /// §3.7
    FileDelete(FileDelete),
    /// §3.7
    FileMove(FileMove),
    /// §3.8
    ConflictDismiss(ConflictDismiss),
    /// §3.7
    SyncSettings(FileInclusion),
}

impl Op {
    /// The spec name of the operation kind.
    pub fn kind(&self) -> &'static str {
        match self {
            Op::Create(_) => "create",
            Op::Update(_) => "update",
            Op::Document(_) => "document",
            Op::Delete(_) => "delete",
            Op::Rename(_) => "rename",
            Op::ResourcePut(_) => "resource_put",
            Op::ResourceDelete(_) => "resource_delete",
            Op::FilePut(_) => "file_put",
            Op::FileAttach(_) => "file_attach",
            Op::OrdinaryAttachmentContinuation(_) => "ordinary_attachment_continuation",
            Op::UnindexedMarkdownPut(_) => "unindexed_markdown_put",
            Op::RecordToUnindexedMarkdown(_) => "record_to_unindexed_markdown",
            Op::UnindexedMarkdownToRecord(_) => "unindexed_markdown_to_record",
            Op::OrdinaryFileToRecord(_) => "ordinary_file_to_record",
            Op::FileDelete(_) => "file_delete",
            Op::FileMove(_) => "file_move",
            Op::ConflictDismiss(_) => "conflict_dismiss",
            Op::SyncSettings(_) => "sync_settings",
        }
    }

    /// Whether this operation writes a resource (and so ends a planning batch).
    pub fn is_resource_write(&self) -> bool {
        matches!(self, Op::ResourcePut(_) | Op::ResourceDelete(_))
    }
}

/// `create` (§3.1).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Create {
    /// The new record ID (UUIDv7).
    pub id: RecordId,
    /// Explicit target path; `None` derives it from the path policy.
    pub path: Option<String>,
    /// The type selector.
    pub type_name: Option<String>,
    /// Draft frontmatter.
    pub frontmatter: Option<Map>,
    /// Body.
    pub body: Option<String>,
    /// Complete source instead of `frontmatter` + `body`.
    pub document: Option<String>,
}

/// One entry of `update.base` (§3.2): the value the caller saw, `None` = the
/// key was missing.
#[derive(Debug, Clone, PartialEq)]
pub struct BaseField {
    /// Top-level key.
    pub key: String,
    /// Observed value; `None` means the key was missing.
    pub observed: Option<Value>,
}

/// A body edit: offsets in Unicode scalar values of the base body (§3.2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BodyEdit {
    /// Start offset (scalar values).
    pub start: u64,
    /// End offset (scalar values), `>= start`.
    pub end: u64,
    /// Replacement text.
    pub insert: String,
}

/// `update` (§3.2).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Update {
    /// Record ID.
    pub id: RecordId,
    /// Set these top-level keys.
    pub patch: Option<Map>,
    /// Remove these keys (spec 07 field references).
    pub unset: Vec<String>,
    /// List items to add, per top-level field (insertion order kept).
    pub add: Vec<(String, Vec<Value>)>,
    /// List items to remove, per top-level field.
    pub remove: Vec<(String, Vec<Value>)>,
    /// Replacement body.
    pub body: Option<String>,
    /// Edits against `body_base`.
    pub body_edits: Vec<BodyEdit>,
    /// SHA-256 of the body the edits or replacement were made against.
    pub body_base: Option<Hash>,
    /// That body, when the writer may not retain it.
    pub body_base_text: Option<String>,
    /// Observed values of the touched keys.
    pub base: Vec<BaseField>,
    /// Opt-in CAS on the whole document.
    pub if_revision: Option<Hash>,
}

/// A record version: path plus exact bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocVersion {
    /// Collection-relative path.
    pub path: String,
    /// Exact document source.
    pub doc: String,
}

/// `document` (§3.3).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct DocumentOp {
    /// Record ID.
    pub id: RecordId,
    /// The version the change was made against; `None` = creation observed.
    pub base: Option<DocVersion>,
    /// The version written; `None` = deletion observed.
    pub new: Option<DocVersion>,
    /// Opt-in CAS (`api` only).
    pub if_revision: Option<Hash>,
}

/// `delete` (§3.4).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Delete {
    /// Record ID.
    pub id: RecordId,
    /// Revision the deleter saw (supersede rule, not CAS).
    pub base_revision: Option<Hash>,
    /// Opt-in CAS.
    pub if_revision: Option<Hash>,
}

/// `rename` (§3.5).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Rename {
    /// Record ID.
    pub id: RecordId,
    /// The path the caller saw; must equal the current path at head.
    pub from: String,
    /// Target path.
    pub to: String,
    /// Rewrite links in other records (spec 08), in the same entry.
    pub update_refs: bool,
    /// Opt-in CAS.
    pub if_revision: Option<Hash>,
}

/// `resource_put` (§3.6).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ResourcePut {
    /// `mdbase.yaml`, or a file in the types or contracts folder.
    pub path: String,
    /// Complete new source.
    pub doc: String,
    /// CAS on the current resource.
    pub base_revision: Option<Hash>,
    /// The path must hold no resource (S-class; `conflict`/`path_taken`).
    pub must_not_exist: bool,
}

/// `resource_delete` (§3.6).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ResourceDelete {
    /// Resource path.
    pub path: String,
    /// CAS on the current resource.
    pub base_revision: Option<Hash>,
}

/// A reference to immutable file content (`intent.md` §3, `blob-ref`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct BlobRef {
    /// SHA-256 of the plaintext (= the file's revision).
    pub plain_hash: Hash,
    /// Plaintext length in bytes.
    pub size: u64,
    /// Keyed content ID (`sealed-envelope.md` §4.2).
    pub blob_id: [u8; 32],
    /// Key epoch whose content key produced `blob_id`.
    pub id_epoch: u64,
    /// Plaintext bytes per part.
    pub part_size: u64,
}

/// Fixed-profile attachment v1 context and complete sealed manifest Item hash.
/// This is signed metadata, not proof of manifest authentication or current authority.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AttachmentRefV1 {
    /// Collection identity, checked by the replica against its authenticated context.
    pub collection: Uuid,
    /// Immutable attachment key epoch.
    pub key_epoch: u64,
    /// Opaque attachment context ID (not a legacy keyed blob ID).
    pub attachment_id: [u8; 32],
    /// SHA-256 of the complete canonical sealed manifest Item.
    pub manifest_cipher_hash: Hash,
}

/// Attachment v1 signed expected whole-file metadata.
/// The typed verified manifest must match all of these fields before runtime use.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AttachmentContentV1 {
    /// Fixed v1 context/manifest descriptor (8 MiB plaintext chunks).
    pub reference: AttachmentRefV1,
    /// SHA-256 of the complete plaintext file, not one chunk or the manifest.
    pub whole_plain_hash: Hash,
    /// Complete plaintext length, not permission to allocate or exceed admission limits.
    pub total_plain_bytes: u64,
}

/// Explicit file content identity; never dispatch by trying decryption or fabricating a blob.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileContent {
    /// Unchanged legacy blob representation.
    Blob(BlobRef),
    /// Critical attachment v1 representation.
    AttachmentV1(AttachmentContentV1),
}

impl FileContent {
    /// Signed whole plaintext revision, not authentication evidence.
    pub const fn plain_hash(self) -> Hash {
        match self {
            Self::Blob(blob) => blob.plain_hash,
            Self::AttachmentV1(content) => content.whole_plain_hash,
        }
    }

    /// Signed whole plaintext size; source and allocation budgets are separate.
    pub const fn size(self) -> u64 {
        match self {
            Self::Blob(blob) => blob.size,
            Self::AttachmentV1(content) => content.total_plain_bytes,
        }
    }
}

/// Critical `file_attach` (§3.9), with the same path/CAS/base rules as FilePut.
/// The replica must reconcile the signed content with a typed verified manifest.
#[derive(Debug, Clone, PartialEq)]
pub struct FileAttach {
    /// Stable File ID; unknown creates, retained tombstones resurrect.
    pub id: FileId,
    /// Exact target path; a replace names the current path.
    pub path: String,
    /// Signed expected whole-file content and immutable attachment descriptor.
    pub content: AttachmentContentV1,
    /// API compare-and-swap on the whole plaintext revision.
    pub if_revision: Option<Hash>,
    /// External captured whole plaintext base revision.
    pub base: Option<Hash>,
}

/// Critical Op18: existing Ordinary File at the same exact record path only.
/// No create, move or kind conversion; the prior descriptor is mandatory CAS.
#[derive(Debug, Clone, PartialEq)]
pub struct OrdinaryAttachmentContinuation {
    /// Existing Ordinary File identity.
    pub id: FileId,
    /// Exact current record-extension path.
    pub path: String,
    /// Authenticated new attachment content (proof is mediated by the replica).
    pub content: AttachmentContentV1,
    /// Complete prior content, including rekey/reseal identity.
    pub prior: FileContent,
}

/// Full UTF-8 record source cap (`intent.md` §3.10): a record source may be exactly
/// this long; an unindexed oversized Markdown file's verified plaintext is strictly
/// longer. Equal to `plan::admission::SYNCED_RECORD_MAX_BYTES`.
pub const RECORD_SOURCE_CAP_BYTES: u64 = 1_048_576;

/// Stored File kind (`intent.md` §3.10), separate from [`FileContent`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub enum FileKind {
    /// A file at a non-record path (legacy blob or attachment content).
    #[default]
    Ordinary,
    /// Verified plaintext strictly above [`RECORD_SOURCE_CAP_BYTES`] at a
    /// record-extension path: bytes preserved and materialized, never a record,
    /// excluded from the record index and queries.
    UnindexedOversizedMarkdown,
}

/// `unindexed_markdown_put` (§3.10): create when the ID/path is absent, or replace
/// an existing file of the SAME kind/path under exact full-content CAS.
/// A trusted import/capture op, never a fallback for an oversized record API write.
#[derive(Debug, Clone, PartialEq)]
pub struct UnindexedMarkdownPut {
    /// Stable File ID (shared namespace with records and files).
    pub id: FileId,
    /// Exact record-extension path.
    pub path: String,
    /// Signed content; the replica verifies the complete plaintext separately.
    pub content: FileContent,
    /// Full expected prior content; `None` means create-only.
    pub expected: Option<FileContent>,
}

/// `record_to_unindexed_markdown` (§3.10): a live record becomes a file of this
/// kind with the SAME UUID and path, under exact prior-source-revision CAS.
#[derive(Debug, Clone, PartialEq)]
pub struct RecordToUnindexedMarkdown {
    /// The record's ID, unchanged across the transition.
    pub id: RecordId,
    /// The record's exact current path, unchanged.
    pub path: String,
    /// Signed content of the oversized plaintext.
    pub content: FileContent,
    /// Exact prior record-source revision ([`crate::ids::revision`]); mandatory CAS.
    pub prior_revision: Hash,
}

/// `unindexed_markdown_to_record` (§3.10): the file becomes a record again from
/// complete UTF-8 source at most [`RECORD_SOURCE_CAP_BYTES`], under exact prior
/// kind/content (full descriptor) CAS.
#[derive(Debug, Clone, PartialEq)]
pub struct UnindexedMarkdownToRecord {
    /// The file's ID, unchanged across the transition.
    pub id: FileId,
    /// The file's exact current path, unchanged.
    pub path: String,
    /// Complete new record source, exact bytes.
    pub doc: String,
    /// Full prior content; mandatory CAS (a same-hash reseal/rekey is a mismatch).
    pub prior: FileContent,
}

/// `file_put` (§3.7).
#[derive(Debug, Clone, PartialEq)]
pub struct FilePut {
    /// File ID; unknown = create.
    pub id: FileId,
    /// Path (for a replace it must equal the current path).
    pub path: String,
    /// Content.
    pub blob: BlobRef,
    /// Opt-in CAS on the current digest (`api`).
    pub if_revision: Option<Hash>,
    /// Digest last seen on disk (`external`).
    pub base: Option<Hash>,
}

/// `ordinary_file_to_record` (§3.12): trusted setup/capture promotion.
/// Keep the current Ordinary file's UUID/path and exact verified UTF-8 source.
/// Full-content CAS includes same-hash reseals; no lifecycle or tombstone rewrite.
#[derive(Debug, Clone, PartialEq)]
pub struct OrdinaryFileToRecord {
    /// Existing Ordinary file ID, unchanged as the record ID.
    pub id: FileId,
    /// Exact current path, a record path in the prospective catalog.
    pub path: String,
    /// Complete exact source; SHA-256 and byte length must match `prior`.
    pub doc: String,
    /// Full current content, mandatory closed descriptor CAS.
    pub prior: FileContent,
}

/// `file_delete` (§3.7).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct FileDelete {
    /// File ID.
    pub id: FileId,
    /// Opt-in CAS (`api`).
    pub if_revision: Option<Hash>,
    /// Digest last seen before the deletion was observed.
    pub base: Option<Hash>,
}

/// `file_move` (§3.7).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct FileMove {
    /// File ID.
    pub id: FileId,
    /// The path the caller saw.
    pub from: String,
    /// Target path.
    pub to: String,
    /// Rewrite links to the file in records.
    pub update_refs: bool,
    /// Opt-in CAS.
    pub if_revision: Option<Hash>,
}

/// `conflict_dismiss` (§3.8).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ConflictDismiss {
    /// The mutation whose conflict is dismissed.
    pub mutation: MutationId,
    /// The record or file.
    pub record: Uuid,
}

/// A media class for file inclusion (§3.7).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum MediaClass {
    /// Images.
    Image,
    /// Audio.
    Audio,
    /// Video.
    Video,
    /// PDF.
    Pdf,
    /// Everything else.
    Other,
}

/// The collection's file inclusion policy (§3.7, `sync_settings`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileInclusion {
    /// Media classes synchronized.
    pub include: Vec<MediaClass>,
    /// Additional excluded folders (path keys compared).
    pub exclude: Vec<String>,
    /// Files larger than this are not synchronized.
    pub max_size: Option<u64>,
}

impl Default for FileInclusion {
    /// The default for a new collection: every media class, no size limit.
    fn default() -> Self {
        FileInclusion {
            include: vec![
                MediaClass::Image,
                MediaClass::Audio,
                MediaClass::Video,
                MediaClass::Pdf,
                MediaClass::Other,
            ],
            exclude: Vec::new(),
            max_size: None,
        }
    }
}
