//! Explicit closed runtime parent codecs: attachments, unindexed Markdown and
//! ordinary promotion. Default legacy decoders are unchanged.
//!
//! These types represent data, not manifest verification, authority, provider
//! capability or permission to emit/apply an attachment. Replica owns selection
//! of this family at its verified runtime boundary. Unknown children fail whole
//! parents; no parser retries, skipped critical children or global profile state.

use crate::attachment::{self, AttachmentContentV1, FileAttach, PutAttachmentFile};
use crate::cbor::Cbor;
use crate::common::{B32, Hash, Sem, Uuid};
use crate::ordinary_file_promotion::{OrdinaryFileToRecord, ReindexOrdinaryFile};
use crate::schema::{Ann, SchemaError, Wire, array, check_fmt, discriminator, require, struct_map};
use crate::unindexed_markdown::{self as unindexed, UnindexedMarkdownPayloadV1};
use crate::{entry, intent, snapshot, wire_struct, wire_tuple};

/// A closed runtime operation, delegating every legacy operation unchanged.
#[derive(Debug, Clone, PartialEq)]
pub enum Op {
    /// Unchanged legacy operation.
    Legacy(intent::Op),
    /// Critical attachment create/replace13.
    FileAttach(FileAttach),
    /// Critical typed unindexed file create/replace14.
    UnindexedMarkdownPut(unindexed::UnindexedMarkdownPut),
    /// Critical record → unindexed file transition15.
    RecordToUnindexedMarkdown(unindexed::RecordToUnindexedMarkdown),
    /// Critical unindexed file → record transition16.
    UnindexedMarkdownToRecord(unindexed::UnindexedMarkdownToRecord),
    /// Critical Ordinary file → record transition17.
    OrdinaryFileToRecord(OrdinaryFileToRecord),
    /// Critical existing Ordinary attachment continuation18.
    OrdinaryAttachmentContinuation(attachment::OrdinaryAttachmentContinuation),
}
impl Wire for Op {
    fn to_cbor(&self) -> Cbor {
        match self {
            Self::Legacy(v) => v.to_cbor(),
            Self::FileAttach(v) => crate::schema::with_tag(13, v.to_cbor()),
            Self::UnindexedMarkdownPut(v) => crate::schema::with_tag(14, v.to_cbor()),
            Self::RecordToUnindexedMarkdown(v) => crate::schema::with_tag(15, v.to_cbor()),
            Self::UnindexedMarkdownToRecord(v) => crate::schema::with_tag(16, v.to_cbor()),
            Self::OrdinaryFileToRecord(v) => crate::schema::with_tag(17, v.to_cbor()),
            Self::OrdinaryAttachmentContinuation(v) => crate::schema::with_tag(18, v.to_cbor()),
        }
    }
    fn from_cbor(c: &Cbor) -> Result<Self, SchemaError> {
        let m = struct_map(c, "attachment-runtime-v1-op")?;
        match discriminator(m, "attachment-runtime-v1-op")? {
            13 => FileAttach::from_cbor(c).map(Self::FileAttach),
            14 => unindexed::UnindexedMarkdownPut::from_cbor(c).map(Self::UnindexedMarkdownPut),
            15 => unindexed::RecordToUnindexedMarkdown::from_cbor(c)
                .map(Self::RecordToUnindexedMarkdown),
            16 => unindexed::UnindexedMarkdownToRecord::from_cbor(c)
                .map(Self::UnindexedMarkdownToRecord),
            17 => OrdinaryFileToRecord::from_cbor(c).map(Self::OrdinaryFileToRecord),
            18 => attachment::OrdinaryAttachmentContinuation::from_cbor(c)
                .map(Self::OrdinaryAttachmentContinuation),
            _ => intent::Op::from_cbor(c).map(Self::Legacy),
        }
    }
    fn annotate(&self) -> Ann {
        match self {
            Self::Legacy(v) => v.annotate(),
            Self::FileAttach(v) => crate::schema::ann_with_tag(13, "FileAttach", v.annotate()),
            Self::UnindexedMarkdownPut(v) => {
                crate::schema::ann_with_tag(14, "UnindexedMarkdownPut", v.annotate())
            }
            Self::RecordToUnindexedMarkdown(v) => {
                crate::schema::ann_with_tag(15, "RecordToUnindexedMarkdown", v.annotate())
            }
            Self::UnindexedMarkdownToRecord(v) => {
                crate::schema::ann_with_tag(16, "UnindexedMarkdownToRecord", v.annotate())
            }
            Self::OrdinaryFileToRecord(v) => {
                crate::schema::ann_with_tag(17, "OrdinaryFileToRecord", v.annotate())
            }
            Self::OrdinaryAttachmentContinuation(v) => {
                crate::schema::ann_with_tag(18, "OrdinaryAttachmentContinuation", v.annotate())
            }
        }
    }
}
/// A closed runtime effect, never a fabricated legacy BlobRef.
#[derive(Debug, Clone, PartialEq)]
pub enum Effect {
    /// Unchanged legacy effect.
    Legacy(entry::Effect),
    /// Critical attachment content result8.
    PutAttachmentFile(PutAttachmentFile),
    /// Critical complete unindexed File result9.
    PutUnindexedMarkdown(unindexed::PutUnindexedMarkdown),
    /// Critical unindexed holder → Record result10.
    ReindexUnindexedMarkdown(unindexed::ReindexUnindexedMarkdown),
    /// Critical Ordinary holder → Record result11.
    ReindexOrdinaryFile(ReindexOrdinaryFile),
}
impl Wire for Effect {
    fn to_cbor(&self) -> Cbor {
        match self {
            Self::Legacy(v) => v.to_cbor(),
            Self::PutAttachmentFile(v) => crate::schema::with_tag(8, v.to_cbor()),
            Self::PutUnindexedMarkdown(v) => crate::schema::with_tag(9, v.to_cbor()),
            Self::ReindexUnindexedMarkdown(v) => crate::schema::with_tag(10, v.to_cbor()),
            Self::ReindexOrdinaryFile(v) => crate::schema::with_tag(11, v.to_cbor()),
        }
    }
    fn from_cbor(c: &Cbor) -> Result<Self, SchemaError> {
        let m = struct_map(c, "attachment-runtime-v1-effect")?;
        match discriminator(m, "attachment-runtime-v1-effect")? {
            8 => PutAttachmentFile::from_cbor(c).map(Self::PutAttachmentFile),
            9 => unindexed::PutUnindexedMarkdown::from_cbor(c).map(Self::PutUnindexedMarkdown),
            10 => unindexed::ReindexUnindexedMarkdown::from_cbor(c)
                .map(Self::ReindexUnindexedMarkdown),
            11 => ReindexOrdinaryFile::from_cbor(c).map(Self::ReindexOrdinaryFile),
            _ => entry::Effect::from_cbor(c).map(Self::Legacy),
        }
    }
    fn annotate(&self) -> Ann {
        match self {
            Self::Legacy(v) => v.annotate(),
            Self::PutAttachmentFile(v) => {
                crate::schema::ann_with_tag(8, "PutAttachmentFile", v.annotate())
            }
            Self::PutUnindexedMarkdown(v) => {
                crate::schema::ann_with_tag(9, "PutUnindexedMarkdown", v.annotate())
            }
            Self::ReindexUnindexedMarkdown(v) => {
                crate::schema::ann_with_tag(10, "ReindexUnindexedMarkdown", v.annotate())
            }
            Self::ReindexOrdinaryFile(v) => {
                crate::schema::ann_with_tag(11, "ReindexOrdinaryFile", v.annotate())
            }
        }
    }
}
/// One complete held conflict side.
#[derive(Debug, Clone, PartialEq)]
pub enum ConflictValue {
    /// Unchanged legacy conflict side.
    Legacy(entry::ConflictValue),
    /// Critical attachment5 with its complete signed descriptor.
    Attachment(AttachmentContentV1),
    /// Critical unindexed Markdown6 with complete kind/content.
    UnindexedMarkdown(UnindexedMarkdownPayloadV1),
}
impl Wire for ConflictValue {
    fn to_cbor(&self) -> Cbor {
        match self {
            Self::Legacy(v) => v.to_cbor(),
            Self::Attachment(v) => {
                attachment::AttachmentConflictValueV1 { content: v.clone() }.to_cbor()
            }
            Self::UnindexedMarkdown(v) => {
                unindexed::UnindexedMarkdownConflictValueV1 { payload: v.clone() }.to_cbor()
            }
        }
    }
    fn from_cbor(c: &Cbor) -> Result<Self, SchemaError> {
        match array(c, "attachment-runtime-v1-conflict-value")?.first() {
            Some(Cbor::Uint(5)) => attachment::AttachmentConflictValueV1::from_cbor(c)
                .map(|v| Self::Attachment(v.content)),
            Some(Cbor::Uint(6)) => unindexed::UnindexedMarkdownConflictValueV1::from_cbor(c)
                .map(|v| Self::UnindexedMarkdown(v.payload)),
            _ => entry::ConflictValue::from_cbor(c).map(Self::Legacy),
        }
    }
    fn annotate(&self) -> Ann {
        match self {
            Self::Legacy(v) => v.annotate(),
            Self::Attachment(v) => {
                attachment::AttachmentConflictValueV1 { content: v.clone() }.annotate()
            }
            Self::UnindexedMarkdown(v) => {
                unindexed::UnindexedMarkdownConflictValueV1 { payload: v.clone() }.annotate()
            }
        }
    }
}
wire_struct! {
    /// Same fields/keys as the legacy mutation, with explicitly selected runtime ops.
    pub struct Mutation {
        /// Idempotency ID.
        0 req id: Uuid,
        /// Capturing replica.
        1 req origin: Uuid,
        /// Captured head.
        2 req base_seq: u64,
        /// Captured clock.
        3 req clock: intent::OpClock,
        /// Captured entropy.
        4 req seed: B32,
        /// Source.
        5 req source: intent::Source,
        /// Atomic ordered operations.
        6 req1 ops: Vec<Op>,
        /// Submitting grant.
        7 opt on_behalf: Uuid,
        /// Conflict handling.
        8 opt conflict_mode: intent::ConflictMode,
        /// Validation information.
        9 opt validated_at: intent::Level,
        /// Room checkpoint.
        10 opt room: intent::RoomCheckpoint,
    }
}
wire_struct! {
    /// A runtime conflict with complete typed sides.
    pub struct Conflict {
        /// Conflict kind.
        0 req kind: entry::ConflictKind,
        /// Entity ID.
        1 req id: Uuid,
        /// Field when applicable.
        2 opt field: String,
        /// Base side.
        3 opt base: ConflictValue,
        /// Kept side.
        4 req kept: ConflictValue,
        /// Lost side.
        5 req lost: ConflictValue,
    }
}
wire_struct! {
    /// Exact fmt1 entry header; this is not the default entry decoder.
    pub struct EntryPayload [fmt = 1] {
        /// Planning semantics.
        1 req sem: Sem,
        /// Complete runtime mutation.
        2 req mutation: Mutation,
        /// Outcome.
        3 req status: entry::Status,
        /// Ordered effects.
        4 req effects: Vec<Effect>,
        /// Unresolved conflicts.
        5 opt1 conflicts: Vec<Conflict>,
        /// Aliases.
        6 opt1 aliases: Vec<entry::Alias>,
        /// Text table.
        7 opt1 texts: Vec<entry::TextDef>,
        /// Earlier acknowledged position; selects restoration semantics, not authority.
        8 opt resurrect: u64,
    }
}
/// Closed snapshot section selection. Legacy sections retain their numeric values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum SectionKind {
    /// Known legacy1..9 section.
    Legacy(snapshot::SectionKind),
    /// Critical live attachment section10.
    AttachmentFiles,
    /// Critical attachment tombstone section11.
    AttachmentTombstones,
    /// Critical live unindexed Markdown section12.
    UnindexedMarkdownFiles,
    /// Critical unindexed Markdown tombstone section13.
    UnindexedMarkdownTombstones,
}
impl SectionKind {
    /// Exact numeric section value.
    pub fn value(self) -> u64 {
        match self {
            Self::Legacy(v) => v.value(),
            Self::AttachmentFiles => 10,
            Self::AttachmentTombstones => 11,
            Self::UnindexedMarkdownFiles => 12,
            Self::UnindexedMarkdownTombstones => 13,
        }
    }
}
impl Wire for SectionKind {
    fn to_cbor(&self) -> Cbor {
        Cbor::Uint(self.value())
    }
    fn from_cbor(c: &Cbor) -> Result<Self, SchemaError> {
        match c {
            Cbor::Uint(10) => Ok(Self::AttachmentFiles),
            Cbor::Uint(11) => Ok(Self::AttachmentTombstones),
            Cbor::Uint(12) => Ok(Self::UnindexedMarkdownFiles),
            Cbor::Uint(13) => Ok(Self::UnindexedMarkdownTombstones),
            _ => snapshot::SectionKind::from_cbor(c).map(Self::Legacy),
        }
    }
    fn annotate(&self) -> Ann {
        match self {
            Self::Legacy(v) => v.annotate(),
            Self::AttachmentFiles => Ann::Enum("AttachmentFiles", 10),
            Self::AttachmentTombstones => Ann::Enum("AttachmentTombstones", 11),
            Self::UnindexedMarkdownFiles => Ann::Enum("UnindexedMarkdownFiles", 12),
            Self::UnindexedMarkdownTombstones => Ann::Enum("UnindexedMarkdownTombstones", 13),
        }
    }
}
wire_struct! {
    /// Runtime snapshot section header.
    pub struct Section {
        /// Explicit section.
        0 req kind: SectionKind,
        /// Complete ordered chunk references.
        1 req chunks: Vec<snapshot::ChunkRef>,
    }
}
wire_struct! {
    /// Exact fmt1 manifest metadata; install authority remains outside the codec.
    pub struct ManifestPayload [fmt = 1] {
        /// Confirmed position.
        1 req seq: u64,
        /// Log chain.
        2 req chain: Hash,
        /// State digest.
        3 req state_digest: Hash,
        /// Bucket bits.
        4 req bucket_bits: u64,
        /// Complete sections.
        5 req1 sections: Vec<Section>,
        /// Applied horizon.
        6 req horizon: snapshot::Horizon,
        /// Builder semantics.
        7 req sem: Sem,
        /// Record count.
        8 req record_count: u64,
        /// File count across both profiles.
        9 req file_count: u64,
        /// Previous manifest.
        10 opt previous: Hash,
        /// Control chain.
        11 req control_chain: Hash,
    }
}
wire_tuple! {
    /// Runtime conflict snapshot row.
    pub struct ConflictRow {
        /// Originating mutation.
        mutation: Uuid,
        /// Position.
        seq: u64,
        /// Complete conflict.
        conflict: Conflict,
    }
}
/// Exact fmt1 chunk header with section-validated rows on decode.
#[derive(Debug, Clone, PartialEq)]
pub struct ChunkPayload {
    /// Explicit section.
    pub section: SectionKind,
    /// Bucket/ordinal.
    pub bucket: u64,
    /// Every row must match the section; never a partially decoded prefix.
    pub rows: Vec<Cbor>,
}
impl ChunkPayload {
    /// Decode all rows as the caller's selected row type, or fail the whole list.
    pub fn rows_as<T: Wire>(&self) -> Result<Vec<T>, SchemaError> {
        self.rows.iter().map(T::from_cbor).collect()
    }
}
fn validate_row(section: SectionKind, row: &Cbor) -> Result<(), SchemaError> {
    use snapshot::SectionKind as L;
    let snapshot_text = |v: snapshot::TextOrBlob| {
        if matches!(v, snapshot::TextOrBlob::Attachment(_)) {
            Err(crate::schema::type_err(
                "snapshot-text",
                "text or blob-ref",
                &v.to_cbor(),
            ))
        } else {
            Ok(())
        }
    };
    match section {
        SectionKind::Legacy(L::Resources) => {
            snapshot::ResourceRow::from_cbor(row).and_then(|r| snapshot_text(r.doc))
        }
        SectionKind::Legacy(L::Index) => snapshot::IndexRow::from_cbor(row).map(|_| ()),
        SectionKind::Legacy(L::Records) => {
            snapshot::RecordRow::from_cbor(row).and_then(|r| snapshot_text(r.doc))
        }
        SectionKind::Legacy(L::Files) => snapshot::FileRow::from_cbor(row).map(|_| ()),
        SectionKind::Legacy(L::Tombstones) => {
            snapshot::TombstoneRow::from_cbor(row).and_then(|t| snapshot_text(t.last))
        }
        SectionKind::Legacy(L::Aliases) => snapshot::AliasRow::from_cbor(row).map(|_| ()),
        SectionKind::Legacy(L::Conflicts) => ConflictRow::from_cbor(row).map(|_| ()),
        SectionKind::Legacy(L::Receipts) => snapshot::ReceiptRow::from_cbor(row).map(|_| ()),
        SectionKind::Legacy(L::Settings) => snapshot::SettingsRow::from_cbor(row).map(|_| ()),
        SectionKind::AttachmentFiles => attachment::AttachmentFileRowV1::from_cbor(row).map(|_| ()),
        SectionKind::AttachmentTombstones => {
            attachment::AttachmentTombstoneRowV1::from_cbor(row).map(|_| ())
        }
        SectionKind::UnindexedMarkdownFiles => {
            unindexed::UnindexedMarkdownFileRowV1::from_cbor(row).map(|_| ())
        }
        SectionKind::UnindexedMarkdownTombstones => {
            unindexed::UnindexedMarkdownTombstoneRowV1::from_cbor(row).map(|_| ())
        }
    }
}
impl Wire for ChunkPayload {
    fn to_cbor(&self) -> Cbor {
        Cbor::Map(vec![
            (Cbor::Uint(0), Cbor::Uint(1)),
            (Cbor::Uint(1), self.section.to_cbor()),
            (Cbor::Uint(2), Cbor::Uint(self.bucket)),
            (Cbor::Uint(3), self.rows.to_cbor()),
        ])
    }
    fn from_cbor(c: &Cbor) -> Result<Self, SchemaError> {
        let ty = "attachment-runtime-v1-chunk-payload";
        let m = struct_map(c, ty)?;
        check_fmt(m, ty, 1)?;
        let section = SectionKind::from_cbor(require(m, 1, ty)?)?;
        let bucket = u64::from_cbor(require(m, 2, ty)?)?;
        let rows = array(require(m, 3, ty)?, ty)?;
        for row in rows {
            validate_row(section, row)?;
        }
        Ok(Self {
            section,
            bucket,
            rows: rows.to_vec(),
        })
    }
    fn annotate(&self) -> Ann {
        Ann::Struct(
            "ChunkPayload",
            vec![
                (0, "fmt", Ann::Leaf(Cbor::Uint(1))),
                (1, "section", self.section.annotate()),
                (2, "bucket", Ann::Leaf(Cbor::Uint(self.bucket))),
                (3, "rows", self.rows.annotate()),
            ],
        )
    }
}
impl From<intent::Mutation> for Mutation {
    fn from(v: intent::Mutation) -> Self {
        Self {
            id: v.id,
            origin: v.origin,
            base_seq: v.base_seq,
            clock: v.clock,
            seed: v.seed,
            source: v.source,
            ops: v.ops.into_iter().map(Op::Legacy).collect(),
            on_behalf: v.on_behalf,
            conflict_mode: v.conflict_mode,
            validated_at: v.validated_at,
            room: v.room,
        }
    }
}
impl From<entry::Conflict> for Conflict {
    fn from(v: entry::Conflict) -> Self {
        Self {
            kind: v.kind,
            id: v.id,
            field: v.field,
            base: v.base.map(ConflictValue::Legacy),
            kept: ConflictValue::Legacy(v.kept),
            lost: ConflictValue::Legacy(v.lost),
        }
    }
}
impl From<entry::EntryPayload> for EntryPayload {
    fn from(v: entry::EntryPayload) -> Self {
        Self {
            sem: v.sem,
            mutation: v.mutation.into(),
            status: v.status,
            effects: v.effects.into_iter().map(Effect::Legacy).collect(),
            conflicts: v
                .conflicts
                .map(|v| v.into_iter().map(Conflict::from).collect()),
            aliases: v.aliases,
            texts: v.texts,
            resurrect: v.resurrect,
        }
    }
}
impl From<snapshot::ManifestPayload> for ManifestPayload {
    fn from(v: snapshot::ManifestPayload) -> Self {
        Self {
            seq: v.seq,
            chain: v.chain,
            state_digest: v.state_digest,
            bucket_bits: v.bucket_bits,
            sections: v
                .sections
                .into_iter()
                .map(|s| Section {
                    kind: SectionKind::Legacy(s.kind),
                    chunks: s.chunks,
                })
                .collect(),
            horizon: v.horizon,
            sem: v.sem,
            record_count: v.record_count,
            file_count: v.file_count,
            previous: v.previous,
            control_chain: v.control_chain,
        }
    }
}
