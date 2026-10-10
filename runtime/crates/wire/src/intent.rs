//! The mutation and its operations (`docs/contracts/intent.md`).

use crate::cbor::Cbor;
use crate::common::{B16, B32, DataMap, Hash, Text, Uuid, Value};
use crate::schema::{Ann, SchemaError, Wire, array};
use crate::{wire_enum, wire_struct, wire_union};

wire_enum! {
    /// Where a mutation came from (intent.md §1).
    pub enum Source {
        /// A write through the API: lifecycle runs; request checks apply.
        Api = 0,
        /// Derived by ingest from an observed file change.
        External = 1,
    }
}

wire_enum! {
    /// How field conflicts are handled (intent.md §1).
    pub enum ConflictMode {
        /// Apply what merges; record conflicts.
        Record = 0,
        /// Any conflict rejects the whole mutation.
        Reject = 1,
    }
}

wire_enum! {
    /// Validation level (spec 04).
    pub enum Level {
        /// Not performed.
        Off = 0,
        /// Reported as warnings.
        Warn = 1,
        /// Single-record issues reject API writes at submit.
        Error = 2,
    }
}

wire_enum! {
    /// Media class of a file, from its extension; never a trusted content type.
    pub enum MediaClass {
        /// Images.
        Image = 0,
        /// Audio.
        Audio = 1,
        /// Video.
        Video = 2,
        /// PDF.
        Pdf = 3,
        /// Anything else.
        Other = 4,
    }
}

wire_struct! {
    /// The captured time of a mutation (intent.md §4.1).
    pub struct OpClock {
        /// Captured instant, ms since the Unix epoch.
        0 req instant: i64,
        /// IANA time zone used for calendar dates.
        1 req tz: String,
        /// Calendar date of `instant` in `tz`, `YYYY-MM-DD`.
        2 req local_date: String,
    }
}

wire_struct! {
    /// Marks a write that checkpoints a live room (intent.md §7).
    pub struct RoomCheckpoint {
        /// Ephemeral stream ID of the room.
        0 req stream: B16,
        /// Digest of the room state captured.
        1 req state: Hash,
    }
}

wire_struct! {
    /// A path and an exact document.
    pub struct DocVersion {
        /// Path.
        0 req path: String,
        /// Exact bytes of the document.
        1 req doc: Text,
    }
}

wire_struct! {
    /// Reference to an immutable blob (intent.md §3, sealed-envelope.md §4.2).
    pub struct BlobRef {
        /// SHA-256 of the plaintext (the content digest and revision).
        0 req plain_hash: Hash,
        /// Plaintext length in bytes.
        1 req size: u64,
        /// Keyed content ID.
        2 req blob_id: B32,
        /// Epoch whose content key produced `blob_id`.
        3 req id_epoch: u64,
        /// Plaintext bytes per part.
        4 req part_size: u64,
    }
}

impl BlobRef {
    /// Number of parts: `ceil(size / part_size)`, at least one.
    pub fn part_count(&self) -> u64 {
        if self.part_size == 0 {
            return 1;
        }
        self.size.div_ceil(self.part_size).max(1)
    }
}

wire_struct! {
    /// The collection's file inclusion policy (intent.md §3.7).
    pub struct FileInclusion {
        /// Media classes synchronized.
        0 req include: Vec<MediaClass>,
        /// Additional excluded folders.
        1 opt exclude: Vec<String>,
        /// Files larger than this are not synchronized.
        2 opt max_size: u64,
    }
}

/// `base-field`: the observed value of a touched key; `observed = None` means the
/// key was missing (encoded as a one-element array).
#[derive(Debug, Clone, PartialEq)]
pub struct BaseField {
    /// Top-level key.
    pub key: String,
    /// Observed value, or `None` when missing.
    pub observed: Option<Value>,
}

impl Wire for BaseField {
    fn to_cbor(&self) -> Cbor {
        let mut a = vec![Cbor::Text(self.key.clone())];
        if let Some(v) = &self.observed {
            a.push(v.to_cbor());
        }
        Cbor::Array(a)
    }
    fn from_cbor(c: &Cbor) -> Result<Self, SchemaError> {
        match array(c, "base-field")? {
            [k] => Ok(BaseField {
                key: String::from_cbor(k)?,
                observed: None,
            }),
            [k, v] => Ok(BaseField {
                key: String::from_cbor(k)?,
                observed: Some(Value::from_cbor(v)?),
            }),
            _ => Err(SchemaError::Invalid {
                ty: "base-field",
                reason: "must have 1 or 2 elements",
            }),
        }
    }
    fn annotate(&self) -> Ann {
        let mut f = vec![("key", Ann::Leaf(Cbor::Text(self.key.clone())))];
        if let Some(v) = &self.observed {
            f.push(("observed", v.annotate()));
        }
        Ann::Tuple("BaseField", f)
    }
}

/// `body-edit`: replace `[start, end)` of the base body (Unicode scalar values) with `insert`.
#[derive(Debug, Clone, PartialEq)]
pub struct BodyEdit {
    /// Start offset.
    pub start: u64,
    /// End offset (exclusive).
    pub end: u64,
    /// Replacement text.
    pub insert: String,
}

impl Wire for BodyEdit {
    fn to_cbor(&self) -> Cbor {
        Cbor::Array(vec![
            Cbor::Uint(self.start),
            Cbor::Uint(self.end),
            Cbor::Text(self.insert.clone()),
        ])
    }
    fn from_cbor(c: &Cbor) -> Result<Self, SchemaError> {
        match array(c, "body-edit")? {
            [s, e, t] => Ok(BodyEdit {
                start: u64::from_cbor(s)?,
                end: u64::from_cbor(e)?,
                insert: String::from_cbor(t)?,
            }),
            _ => Err(SchemaError::Invalid {
                ty: "body-edit",
                reason: "must be [start, end, insert]",
            }),
        }
    }
    fn annotate(&self) -> Ann {
        Ann::Tuple(
            "BodyEdit",
            vec![
                ("start", Ann::Leaf(Cbor::Uint(self.start))),
                ("end", Ann::Leaf(Cbor::Uint(self.end))),
                ("insert", Ann::Leaf(Cbor::Text(self.insert.clone()))),
            ],
        )
    }
}

wire_struct! {
    /// `create` (intent.md §3.1).
    pub struct Create {
        /// New record ID (UUIDv7).
        1 req id: Uuid,
        /// Explicit path; absent = derive.
        2 opt path: String,
        /// Type selector.
        3 opt type_name: String,
        /// Draft frontmatter.
        4 opt frontmatter: DataMap<Value>,
        /// Body.
        5 opt body: Text,
        /// Complete source instead of frontmatter + body.
        6 opt document: Text,
    }
}

wire_struct! {
    /// `update` (intent.md §3.2).
    pub struct Update {
        /// Record ID.
        1 req id: Uuid,
        /// Keys to set.
        2 opt patch: DataMap<Value>,
        /// Field references to remove.
        3 opt1 unset: Vec<String>,
        /// List items to add, per field.
        4 opt add: DataMap<Vec<Value>>,
        /// List items to remove, per field.
        5 opt remove: DataMap<Vec<Value>>,
        /// Replacement body.
        6 opt body: Text,
        /// Edits against `body_base`.
        7 opt1 body_edits: Vec<BodyEdit>,
        /// SHA-256 of the body the edits or replacement were made against.
        8 opt body_base: Hash,
        /// That body, when the writer may not retain it.
        9 opt body_base_text: Text,
        /// Observed values of the touched keys.
        10 opt1 base: Vec<BaseField>,
        /// Opt-in CAS.
        11 opt if_revision: Hash,
    }
}

wire_struct! {
    /// `document` (intent.md §3.3).
    pub struct Document {
        /// Record ID.
        1 req id: Uuid,
        /// Version the change was made against.
        2 opt base: DocVersion,
        /// Version written; absent = deletion observed.
        3 opt new: DocVersion,
        /// Opt-in CAS (api).
        4 opt if_revision: Hash,
    }
}

wire_struct! {
    /// `delete` (intent.md §3.4).
    pub struct Delete {
        /// Record ID.
        1 req id: Uuid,
        /// Revision the deleter saw (supersede rule, not CAS).
        2 opt base_revision: Hash,
        /// Opt-in CAS.
        3 opt if_revision: Hash,
    }
}

wire_struct! {
    /// `rename` (intent.md §3.5).
    pub struct Rename {
        /// Record ID.
        1 req id: Uuid,
        /// Path the caller saw.
        2 req from: String,
        /// Target path.
        3 req to: String,
        /// Rewrite links in other records.
        4 req update_refs: bool,
        /// Opt-in CAS.
        5 opt if_revision: Hash,
    }
}

wire_struct! {
    /// `resource_put` (intent.md §3.6).
    pub struct ResourcePut {
        /// Resource path.
        1 req path: String,
        /// Complete new source.
        2 req doc: Text,
        /// CAS on the current resource.
        3 opt base_revision: Hash,
        /// The path must hold no resource (intent.md §3.6). Present only when
        /// true: encoders write `Some(true)` or nothing.
        4 opt must_not_exist: bool,
    }
}

wire_struct! {
    /// `resource_delete` (intent.md §3.6).
    pub struct ResourceDelete {
        /// Resource path.
        1 req path: String,
        /// CAS on the current resource.
        2 opt base_revision: Hash,
    }
}

wire_struct! {
    /// `file_put` (intent.md §3.7).
    pub struct FilePut {
        /// File ID; unknown = create.
        1 req id: Uuid,
        /// Path.
        2 req path: String,
        /// Content.
        3 req blob: BlobRef,
        /// Opt-in CAS on the current content digest (api).
        4 opt if_revision: Hash,
        /// Digest this replica last saw on disk (external).
        5 opt base: Hash,
    }
}

wire_struct! {
    /// `file_delete` (intent.md §3.7).
    pub struct FileDelete {
        /// File ID.
        1 req id: Uuid,
        /// Opt-in CAS (api).
        2 opt if_revision: Hash,
        /// Digest last seen before the deletion was observed.
        3 opt base: Hash,
    }
}

wire_struct! {
    /// `file_move` (intent.md §3.7).
    pub struct FileMove {
        /// File ID.
        1 req id: Uuid,
        /// Path the caller saw.
        2 req from: String,
        /// Target path.
        3 req to: String,
        /// Rewrite links to the file in records.
        4 req update_refs: bool,
        /// Opt-in CAS.
        5 opt if_revision: Hash,
    }
}

wire_struct! {
    /// `conflict_dismiss` (intent.md §3.8).
    pub struct ConflictDismiss {
        /// Mutation whose conflict is dismissed.
        1 req mutation: Uuid,
        /// Record (or file) ID.
        2 req record: Uuid,
    }
}

wire_struct! {
    /// `sync_settings` (intent.md §3.7).
    pub struct SyncSettings {
        /// The inclusion policy.
        1 req inclusion: FileInclusion,
    }
}

wire_union! {
    /// One operation of a mutation (intent.md §3).
    pub enum Op {
        /// Create a record.
        1 => Create(Create),
        /// Field-level update.
        2 => Update(Update),
        /// Whole-document change.
        3 => Document(Document),
        /// Delete a record.
        4 => Delete(Delete),
        /// Rename a record.
        5 => Rename(Rename),
        /// Write a resource.
        6 => ResourcePut(ResourcePut),
        /// Delete a resource.
        7 => ResourceDelete(ResourceDelete),
        /// Create or replace a file.
        8 => FilePut(FilePut),
        /// Delete a file.
        9 => FileDelete(FileDelete),
        /// Move a file.
        10 => FileMove(FileMove),
        /// Dismiss a recorded conflict.
        11 => ConflictDismiss(ConflictDismiss),
        /// Set the file inclusion policy.
        12 => SyncSettings(SyncSettings),
    }
}

wire_struct! {
    /// One logical write (intent.md §1).
    pub struct Mutation {
        /// Mutation ID (UUIDv7), the idempotency key.
        0 req id: Uuid,
        /// Replica that captured it.
        1 req origin: Uuid,
        /// The origin's confirmed position at capture.
        2 req base_seq: u64,
        /// Captured time.
        3 req clock: OpClock,
        /// Entropy for generated values.
        4 req seed: B32,
        /// Source.
        5 req source: Source,
        /// Operations, applied atomically in order.
        6 req1 ops: Vec<Op>,
        /// Grant of the submitting client.
        7 opt on_behalf: Uuid,
        /// Conflict handling (default: record).
        8 opt conflict_mode: ConflictMode,
        /// Validation level applied at submit (informational).
        9 opt validated_at: Level,
        /// Set when this write checkpoints a live room.
        10 opt room: RoomCheckpoint,
    }
}
