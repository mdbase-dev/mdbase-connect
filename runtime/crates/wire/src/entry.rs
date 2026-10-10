//! The entry payload: a mutation and its results (`docs/contracts/log-entry.md` §2).

use crate::cbor::Cbor;
use crate::common::{Bytes, Sem, Text, Uuid, Value};
use crate::intent::{BlobRef, FileInclusion, Mutation};
use crate::schema::{Ann, SchemaError, Wire, array, type_err};
use crate::{wire_enum, wire_struct, wire_union};

wire_enum! {
    /// Outcome of an appended entry. There is no `rejected`: rejected mutations
    /// never enter the log.
    pub enum Status {
        /// Applied as asked.
        Applied = 0,
        /// Applied with an automatic merge.
        Merged = 1,
        /// Partly applied; a concurrent change kept some values.
        Conflicted = 2,
    }
}

wire_struct! {
    /// Put a record's document (create, change or move).
    pub struct PutRecord {
        /// Record ID.
        1 req id: Uuid,
        /// Path.
        2 req path: String,
        /// Exact bytes.
        3 req doc: Text,
    }
}

wire_struct! {
    /// Remove a record (leaves a tombstone).
    pub struct RemoveRecord {
        /// Record ID.
        1 req id: Uuid,
        /// The path it had.
        2 req path: String,
    }
}

wire_struct! {
    /// Put a file (create, replace or move).
    pub struct PutFile {
        /// File ID.
        1 req id: Uuid,
        /// Path.
        2 req path: String,
        /// Content.
        3 req blob: BlobRef,
    }
}

wire_struct! {
    /// Remove a file (leaves a tombstone).
    pub struct RemoveFile {
        /// File ID.
        1 req id: Uuid,
        /// The path it had.
        2 req path: String,
    }
}

wire_struct! {
    /// Put a resource document.
    pub struct PutResource {
        /// Resource path.
        1 req path: String,
        /// Exact bytes.
        2 req doc: Text,
    }
}

wire_struct! {
    /// Remove a resource.
    pub struct RemoveResource {
        /// Resource path.
        1 req path: String,
    }
}

wire_struct! {
    /// Set the file inclusion policy.
    pub struct PutSettings {
        /// The inclusion policy.
        1 req inclusion: FileInclusion,
    }
}

wire_union! {
    /// One effect of an entry (log-entry.md §2.1).
    pub enum Effect {
        /// Put a record.
        1 => PutRecord(PutRecord),
        /// Remove a record.
        2 => RemoveRecord(RemoveRecord),
        /// Put a file.
        3 => PutFile(PutFile),
        /// Remove a file.
        4 => RemoveFile(RemoveFile),
        /// Put a resource.
        5 => PutResource(PutResource),
        /// Remove a resource.
        6 => RemoveResource(RemoveResource),
        /// Set the inclusion policy.
        7 => PutSettings(PutSettings),
    }
}

/// `alias`: an old path that now refers to a record (log-entry.md §2.3).
#[derive(Debug, Clone, PartialEq)]
pub struct Alias {
    /// The old path, as written.
    pub path: String,
    /// The record it refers to.
    pub record: Uuid,
}

impl Wire for Alias {
    fn to_cbor(&self) -> Cbor {
        Cbor::Array(vec![Cbor::Text(self.path.clone()), self.record.to_cbor()])
    }
    fn from_cbor(c: &Cbor) -> Result<Self, SchemaError> {
        match array(c, "alias")? {
            [p, r] => Ok(Alias {
                path: String::from_cbor(p)?,
                record: Uuid::from_cbor(r)?,
            }),
            _ => Err(SchemaError::Invalid {
                ty: "alias",
                reason: "must be [path, record]",
            }),
        }
    }
    fn annotate(&self) -> Ann {
        Ann::Tuple(
            "Alias",
            vec![
                ("path", Ann::Leaf(Cbor::Text(self.path.clone()))),
                ("record", self.record.annotate()),
            ],
        )
    }
}

wire_enum! {
    /// Kind of a recorded conflict.
    pub enum ConflictKind {
        /// One top-level frontmatter field.
        Field = 1,
        /// A whole frontmatter block.
        Frontmatter = 2,
        /// The body.
        Body = 3,
        /// The path.
        Path = 4,
        /// A delete superseded by a concurrent change.
        Delete = 5,
        /// File content (never merged).
        File = 6,
    }
}

/// `conflict-value`: one side of a conflict.
#[derive(Debug, Clone, PartialEq)]
pub enum ConflictValue {
    /// The key was missing.
    Missing,
    /// A frontmatter value.
    Value(Value),
    /// A text: frontmatter source, body or path.
    Text(Text),
    /// File content.
    Blob(BlobRef),
    /// Deleted.
    Deleted,
}

impl Wire for ConflictValue {
    fn to_cbor(&self) -> Cbor {
        Cbor::Array(match self {
            ConflictValue::Missing => vec![Cbor::Uint(0)],
            ConflictValue::Value(v) => vec![Cbor::Uint(1), v.to_cbor()],
            ConflictValue::Text(t) => vec![Cbor::Uint(2), t.to_cbor()],
            ConflictValue::Blob(b) => vec![Cbor::Uint(3), b.to_cbor()],
            ConflictValue::Deleted => vec![Cbor::Uint(4)],
        })
    }
    fn from_cbor(c: &Cbor) -> Result<Self, SchemaError> {
        let ty = "conflict-value";
        match array(c, ty)? {
            [Cbor::Uint(0)] => Ok(ConflictValue::Missing),
            [Cbor::Uint(1), v] => Ok(ConflictValue::Value(Value::from_cbor(v)?)),
            [Cbor::Uint(2), t] => Ok(ConflictValue::Text(Text::from_cbor(t)?)),
            [Cbor::Uint(3), b] => Ok(ConflictValue::Blob(BlobRef::from_cbor(b)?)),
            [Cbor::Uint(4)] => Ok(ConflictValue::Deleted),
            [Cbor::Uint(t), ..] if *t > 4 => Err(SchemaError::UnknownVariant { ty, value: *t }),
            _ => Err(SchemaError::Invalid {
                ty,
                reason: "malformed conflict value",
            }),
        }
    }
    fn annotate(&self) -> Ann {
        let (name, tag, rest): (&'static str, u64, Option<Ann>) = match self {
            ConflictValue::Missing => ("missing", 0, None),
            ConflictValue::Value(v) => ("value", 1, Some(v.annotate())),
            ConflictValue::Text(t) => ("text", 2, Some(t.annotate())),
            ConflictValue::Blob(b) => ("blob", 3, Some(b.annotate())),
            ConflictValue::Deleted => ("deleted", 4, None),
        };
        let mut f = vec![("form", Ann::Enum(name, tag))];
        if let Some(r) = rest {
            f.push(("value", r));
        }
        Ann::Tuple("ConflictValue", f)
    }
}

wire_struct! {
    /// A recorded conflict (log-entry.md §2.4).
    pub struct Conflict {
        /// Kind.
        0 req kind: ConflictKind,
        /// Record or file ID.
        1 req id: Uuid,
        /// The top-level key (kind = field).
        2 opt field: String,
        /// Base value.
        3 opt base: ConflictValue,
        /// What the record now holds.
        4 req kept: ConflictValue,
        /// What this entry's mutation wanted and did not get.
        5 req lost: ConflictValue,
    }
}

/// `text-source`: what a delta copies from.
#[derive(Debug, Clone, PartialEq)]
pub enum TextSource {
    /// The record's document just before this entry (or its tombstone document).
    PrevRecord(Uuid),
    /// An earlier entry of this entry's text table.
    Earlier(u64),
    /// The resource document just before this entry.
    PrevResource(String),
}

impl Wire for TextSource {
    fn to_cbor(&self) -> Cbor {
        Cbor::Array(match self {
            TextSource::PrevRecord(id) => vec![Cbor::Uint(0), id.to_cbor()],
            TextSource::Earlier(i) => vec![Cbor::Uint(1), Cbor::Uint(*i)],
            TextSource::PrevResource(p) => vec![Cbor::Uint(2), Cbor::Text(p.clone())],
        })
    }
    fn from_cbor(c: &Cbor) -> Result<Self, SchemaError> {
        let ty = "text-source";
        match array(c, ty)? {
            [Cbor::Uint(0), id] => Ok(TextSource::PrevRecord(Uuid::from_cbor(id)?)),
            [Cbor::Uint(1), i] => Ok(TextSource::Earlier(u64::from_cbor(i)?)),
            [Cbor::Uint(2), p] => Ok(TextSource::PrevResource(String::from_cbor(p)?)),
            [Cbor::Uint(t), _] if *t > 2 => Err(SchemaError::UnknownVariant { ty, value: *t }),
            _ => Err(SchemaError::Invalid {
                ty,
                reason: "malformed text source",
            }),
        }
    }
    fn annotate(&self) -> Ann {
        let (name, tag, v) = match self {
            TextSource::PrevRecord(id) => ("prev_record", 0, id.annotate()),
            TextSource::Earlier(i) => ("earlier", 1, Ann::Leaf(Cbor::Uint(*i))),
            TextSource::PrevResource(p) => ("prev_resource", 2, Ann::Leaf(Cbor::Text(p.clone()))),
        };
        Ann::Tuple(
            "TextSource",
            vec![("form", Ann::Enum(name, tag)), ("ref", v)],
        )
    }
}

/// `delta-op`.
#[derive(Debug, Clone, PartialEq)]
pub enum DeltaOp {
    /// Copy `len` bytes of the source from `offset`.
    Copy {
        /// Source byte offset.
        offset: u64,
        /// Length.
        len: u64,
    },
    /// Insert these bytes.
    Insert(Bytes),
}

impl Wire for DeltaOp {
    fn to_cbor(&self) -> Cbor {
        Cbor::Array(match self {
            DeltaOp::Copy { offset, len } => {
                vec![Cbor::Uint(0), Cbor::Uint(*offset), Cbor::Uint(*len)]
            }
            DeltaOp::Insert(b) => vec![Cbor::Uint(1), b.to_cbor()],
        })
    }
    fn from_cbor(c: &Cbor) -> Result<Self, SchemaError> {
        let ty = "delta-op";
        match array(c, ty)? {
            [Cbor::Uint(0), o, l] => Ok(DeltaOp::Copy {
                offset: u64::from_cbor(o)?,
                len: u64::from_cbor(l)?,
            }),
            [Cbor::Uint(1), b] => Ok(DeltaOp::Insert(Bytes::from_cbor(b)?)),
            [Cbor::Uint(t), ..] if *t > 1 => Err(SchemaError::UnknownVariant { ty, value: *t }),
            _ => Err(SchemaError::Invalid {
                ty,
                reason: "malformed delta op",
            }),
        }
    }
    fn annotate(&self) -> Ann {
        match self {
            DeltaOp::Copy { offset, len } => Ann::Tuple(
                "Copy",
                vec![
                    ("op", Ann::Enum("copy", 0)),
                    ("offset", Ann::Leaf(Cbor::Uint(*offset))),
                    ("len", Ann::Leaf(Cbor::Uint(*len))),
                ],
            ),
            DeltaOp::Insert(b) => Ann::Tuple(
                "Insert",
                vec![("op", Ann::Enum("insert", 1)), ("bytes", b.annotate())],
            ),
        }
    }
}

impl DeltaOp {
    /// Apply ops to a source; `None` if a copy is out of bounds.
    pub fn apply(source: &[u8], ops: &[DeltaOp]) -> Option<Vec<u8>> {
        let mut out = Vec::new();
        for op in ops {
            match op {
                DeltaOp::Copy { offset, len } => {
                    let start = usize::try_from(*offset).ok()?;
                    let end = start.checked_add(usize::try_from(*len).ok()?)?;
                    out.extend_from_slice(source.get(start..end)?);
                }
                DeltaOp::Insert(b) => out.extend_from_slice(&b.0),
            }
        }
        Some(out)
    }
}

wire_struct! {
    /// A delta-encoded text.
    pub struct TextDelta {
        /// What the delta copies from.
        1 req source: TextSource,
        /// Ops, in order.
        2 req1 ops: Vec<DeltaOp>,
    }
}

wire_struct! {
    /// A text stored in the blob store.
    pub struct TextBlob {
        /// The blob.
        1 req blob: BlobRef,
    }
}

wire_union! {
    /// The map forms of a text definition.
    pub enum TextDefForm {
        /// Delta against a source.
        1 => Delta(TextDelta),
        /// Stored as a blob.
        2 => Blob(TextBlob),
    }
}

/// `text-def`: one entry of an entry's text table (log-entry.md §2.2).
#[derive(Debug, Clone, PartialEq)]
pub enum TextDef {
    /// The text itself.
    Literal(String),
    /// A delta or blob form.
    Form(TextDefForm),
}

impl Wire for TextDef {
    fn to_cbor(&self) -> Cbor {
        match self {
            TextDef::Literal(s) => Cbor::Text(s.clone()),
            TextDef::Form(f) => f.to_cbor(),
        }
    }
    fn from_cbor(c: &Cbor) -> Result<Self, SchemaError> {
        match c {
            Cbor::Text(s) => Ok(TextDef::Literal(s.clone())),
            Cbor::Map(_) => Ok(TextDef::Form(TextDefForm::from_cbor(c)?)),
            _ => Err(type_err("text-def", "text or map", c)),
        }
    }
    fn annotate(&self) -> Ann {
        match self {
            TextDef::Literal(s) => Ann::Leaf(Cbor::Text(s.clone())),
            TextDef::Form(f) => f.annotate(),
        }
    }
}

wire_struct! {
    /// The plaintext payload of a log item of kind `entry` (log-entry.md §2).
    pub struct EntryPayload [fmt = 1] {
        /// Semantics version the writer planned under.
        1 req sem: Sem,
        /// The intent.
        2 req mutation: Mutation,
        /// Outcome.
        3 req status: Status,
        /// Effects, applied in order.
        4 req effects: Vec<Effect>,
        /// Conflicts (present iff status = conflicted).
        5 opt1 conflicts: Vec<Conflict>,
        /// Aliases created by this entry.
        6 opt1 aliases: Vec<Alias>,
        /// Text table.
        7 opt1 texts: Vec<TextDef>,
        /// Earlier acknowledged position; selects resurrection semantics only,
        /// never signer/grant authority (log-entry.md §3.3).
        8 opt resurrect: u64,
    }
}

wire_struct! {
    /// A signed head witness, exchanged between devices to detect forks
    /// (log-entry.md §11).
    pub struct HeadWitness [fmt = 1] {
        /// Collection.
        1 req collection: Uuid,
        /// The signing device.
        2 req device: Uuid,
        /// Its applied head.
        3 req seq: u64,
        /// `chain(seq)`.
        4 req chain: crate::common::Hash,
        /// Its current epoch.
        5 req epoch: u64,
        /// When it signed (its clock; informational).
        6 req signed_at: i64,
        /// Ed25519 over [`HeadWitness::signed_digest`].
        7 req sig: crate::common::B64,
        /// Optional `ctl(seq)` identity, signed with all other fields.
        8 opt policy_generation: crate::common::Hash,
        /// Optional neutral confirmed resource+SEM identity. Both identities
        /// are required for handover; legacy witnesses do not establish a fence.
        9 opt catalog_generation: crate::common::Hash,
    }
}

impl HeadWitness {
    /// `H("mdbase/v1/head-witness", canonical(witness without key 7))`.
    pub fn signed_digest(&self) -> Result<crate::common::Hash, crate::cbor::CborError> {
        let mut c = self.to_cbor();
        if let Cbor::Map(m) = &mut c {
            m.retain(|(k, _)| *k != Cbor::Uint(7));
        }
        Ok(crate::hash::h(
            "mdbase/v1/head-witness",
            &crate::cbor::encode(&c)?,
        ))
    }

    /// The out-of-band comparison code input: `H("mdbase/v1/head-witness",
    /// collection ‖ u64be(seq) ‖ chain)` (log-entry.md §11, residual).
    pub fn comparison_digest(
        collection: &Uuid,
        seq: u64,
        chain: &crate::common::Hash,
    ) -> crate::common::Hash {
        let mut m = Vec::with_capacity(16 + 8 + 32);
        m.extend_from_slice(&collection.0);
        m.extend_from_slice(&seq.to_be_bytes());
        m.extend_from_slice(&chain.0);
        crate::hash::h("mdbase/v1/head-witness", &m)
    }
}
