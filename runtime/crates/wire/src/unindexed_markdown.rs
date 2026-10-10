//! Critical unindexed oversized Markdown v1 standalone codecs (`intent.md` §3.10).
//! NOT runtime union activation, planning, verification, emitter or feature authority.
//! Legacy Op/Effect/ConflictValue/SectionKind keep whole-item unknown-critical rejection.
//!
//! The payload envelope `[2, 1, 1, file-content]` is FILE metadata: a separate kind next
//! to unchanged `FileContent` (legacy Blob map or attachment v1 tuple). Its leading 2
//! shares index 0 of the native slot-3 array with attachment-content versions (1), so a
//! legacy attachment decoder whole-rejects it instead of misreading it.
use crate::attachment::FileContent;
use crate::cbor::Cbor;
use crate::common::{Hash, Text, Uuid};
use crate::intent::MediaClass;
use crate::schema::{Ann, SchemaError, Wire, array, type_err};
use crate::snapshot::{ChunkRef, EntityKind};
use crate::{wire_enum, wire_struct, wire_tuple, wire_union};

/// Indexed record full-source cap. A payload of this kind declares strictly more;
/// exactly this many bytes remains a record candidate.
pub const RECORD_SOURCE_CAP_BYTES: u64 = 1_048_576;
/// Slot-3 discriminator of the file payload envelope (attachment-content versions use 1).
pub const PAYLOAD_DISCRIMINATOR: u64 = 2;
/// Envelope profile version.
pub const PAYLOAD_PROFILE_V1: u64 = 1;

wire_enum! {
    /// Stored File kind. Ordinary files never carry the payload envelope.
    pub enum FileKindV1 {
        /// Legacy/attachment file at a non-record path.
        Ordinary = 0,
        /// Verified plaintext strictly above the record cap at a record-extension path;
        /// bytes preserved and materialized, excluded from the record index and queries.
        UnindexedOversizedMarkdown = 1,
    }
}

fn element(a: &[Cbor], i: usize, ty: &'static str) -> Result<u64, SchemaError> {
    match a.get(i) {
        Some(Cbor::Uint(n)) => Ok(*n),
        Some(c) => Err(type_err(ty, "uint discriminator/version/kind", c)),
        None => Err(SchemaError::Invalid {
            ty,
            reason: "must have exactly four elements",
        }),
    }
}

/// `unindexed-markdown-payload-v1 = [2, 1, 1, file-content]`.
/// Declared content size is a structural invariant here, not authentication proof:
/// producers still verify the complete plaintext, descriptor and current authority.
#[derive(Debug, Clone, PartialEq)]
pub struct UnindexedMarkdownPayloadV1 {
    /// Unchanged content representation (legacy Blob or critical attachment v1).
    pub content: FileContent,
}
impl UnindexedMarkdownPayloadV1 {
    /// The kind this envelope always carries.
    pub const KIND: FileKindV1 = FileKindV1::UnindexedOversizedMarkdown;
}
impl Wire for UnindexedMarkdownPayloadV1 {
    fn to_cbor(&self) -> Cbor {
        Cbor::Array(vec![
            Cbor::Uint(PAYLOAD_DISCRIMINATOR),
            Cbor::Uint(PAYLOAD_PROFILE_V1),
            Cbor::Uint(Self::KIND.value()),
            self.content.to_cbor(),
        ])
    }
    fn from_cbor(c: &Cbor) -> Result<Self, SchemaError> {
        let ty = "unindexed-markdown-payload-v1";
        let a = array(c, ty)?;
        match element(a, 0, ty)? {
            PAYLOAD_DISCRIMINATOR => {}
            fmt => return Err(SchemaError::UnknownFormat { ty, fmt }),
        }
        match element(a, 1, ty)? {
            PAYLOAD_PROFILE_V1 => {}
            fmt => return Err(SchemaError::UnknownFormat { ty, fmt }),
        }
        match element(a, 2, ty)? {
            k if k == Self::KIND.value() => {}
            // Ordinary0 never uses the envelope; any other kind needs an upgrade.
            value => return Err(SchemaError::UnknownVariant { ty, value }),
        }
        let [_, _, _, content] = a else {
            return Err(SchemaError::Invalid {
                ty,
                reason: "must have exactly four elements",
            });
        };
        let content = FileContent::from_cbor(content)?;
        if content.size() <= RECORD_SOURCE_CAP_BYTES {
            return Err(SchemaError::Invalid {
                ty,
                reason: "declared plaintext must exceed the 1 MiB record cap",
            });
        }
        Ok(Self { content })
    }
    fn annotate(&self) -> Ann {
        Ann::Tuple(
            "UnindexedMarkdownPayloadV1",
            vec![
                (
                    "discriminator",
                    Ann::Leaf(Cbor::Uint(PAYLOAD_DISCRIMINATOR)),
                ),
                ("profile", Ann::Leaf(Cbor::Uint(PAYLOAD_PROFILE_V1))),
                ("kind", Self::KIND.annotate()),
                ("content", self.content.annotate()),
            ],
        )
    }
}

wire_struct! {
    /// Critical Op14 body: create when the ID/path is absent, or replace an existing
    /// file of the SAME kind/path under exact full-payload CAS.
    pub struct UnindexedMarkdownPut {
        /// File ID.
        1 req id: Uuid,
        /// Exact record-extension path.
        2 req path: String,
        /// Complete typed payload.
        3 req payload: UnindexedMarkdownPayloadV1,
        /// Full expected prior payload; absent means create-only.
        4 opt expected: UnindexedMarkdownPayloadV1,
    }
}
wire_struct! {
    /// Critical Op15 body: a live record becomes this File kind with the SAME UUID/path.
    pub struct RecordToUnindexedMarkdown {
        /// Record/File ID (unchanged across the transition).
        1 req id: Uuid,
        /// Exact path (unchanged).
        2 req path: String,
        /// Complete typed payload.
        3 req payload: UnindexedMarkdownPayloadV1,
        /// Exact prior record-source revision; mandatory CAS.
        4 req prior_revision: Hash,
    }
}
wire_struct! {
    /// Critical Op16 body: the File becomes a record again from complete UTF-8 source
    /// (<= cap, bounded admission checked by planning, not by this codec).
    pub struct UnindexedMarkdownToRecord {
        /// File/Record ID (unchanged).
        1 req id: Uuid,
        /// Exact path (unchanged).
        2 req path: String,
        /// Complete new record source, exact bytes (inline or text-table index).
        3 req doc: Text,
        /// Full prior kind/content; mandatory CAS.
        4 req prior: UnindexedMarkdownPayloadV1,
    }
}
wire_union! {
    /// Standalone critical op codec; also carried by the explicit runtime family.
    pub enum UnindexedMarkdownOpV1 {
        /// Create-only or full-payload CAS replace.
        14 => Put(UnindexedMarkdownPut),
        /// Atomic record -> unindexed file transition.
        15 => RecordToFile(RecordToUnindexedMarkdown),
        /// Atomic unindexed file -> record transition.
        16 => FileToRecord(UnindexedMarkdownToRecord),
    }
}

wire_struct! {
    /// Critical Effect9 body: installs the complete typed File, atomically removing a
    /// prior live record/index projection with the same UUID on an Op15 transition.
    pub struct PutUnindexedMarkdown {
        /// File ID.
        1 req id: Uuid,
        /// Exact path.
        2 req path: String,
        /// Complete typed payload.
        3 req payload: UnindexedMarkdownPayloadV1,
    }
}
wire_struct! {
    /// Critical Effect10 body: installs the resolved record source, atomically removing
    /// the prior unindexed File with the same UUID.
    pub struct ReindexUnindexedMarkdown {
        /// Record ID.
        1 req id: Uuid,
        /// Exact path.
        2 req path: String,
        /// Complete record source, exact bytes (inline or text-table index).
        3 req doc: Text,
    }
}
wire_union! {
    /// Standalone critical effect codec; also carried by the explicit runtime family.
    pub enum UnindexedMarkdownEffectV1 {
        /// Typed File installed (Op14/Op15 result).
        9 => PutUnindexedMarkdown(PutUnindexedMarkdown),
        /// Record reindexed (Op16 result).
        10 => ReindexUnindexedMarkdown(ReindexUnindexedMarkdown),
    }
}

/// Critical conflict-held value6, retaining the complete kind AND content.
#[derive(Debug, Clone, PartialEq)]
pub struct UnindexedMarkdownConflictValueV1 {
    /// Payload retained in the unresolved conflict.
    pub payload: UnindexedMarkdownPayloadV1,
}
impl Wire for UnindexedMarkdownConflictValueV1 {
    fn to_cbor(&self) -> Cbor {
        Cbor::Array(vec![Cbor::Uint(6), self.payload.to_cbor()])
    }
    fn from_cbor(c: &Cbor) -> Result<Self, SchemaError> {
        let ty = "unindexed-markdown-conflict-value-v1";
        let a = array(c, ty)?;
        match element(a, 0, ty)? {
            6 => {}
            value => return Err(SchemaError::UnknownVariant { ty, value }),
        }
        let [_, payload] = a else {
            return Err(SchemaError::Invalid {
                ty,
                reason: "must have exactly two elements",
            });
        };
        Ok(Self {
            payload: UnindexedMarkdownPayloadV1::from_cbor(payload)?,
        })
    }
    fn annotate(&self) -> Ann {
        Ann::Tuple(
            "UnindexedMarkdownConflictValueV1",
            vec![
                ("kind", Ann::Leaf(Cbor::Uint(6))),
                ("payload", self.payload.annotate()),
            ],
        )
    }
}

wire_enum! {
    /// Critical standalone snapshot sections; the legacy SectionKind rejects 12/13.
    pub enum UnindexedMarkdownSectionKindV1 {
        /// Live typed unindexed rows, IDs disjoint from every other live section.
        UnindexedMarkdownFiles = 12,
        /// Retained File1 tombstones of this kind, IDs disjoint from every tombstone section.
        UnindexedMarkdownTombstones = 13,
    }
}
wire_struct! {
    /// Standalone critical section header; legacy manifest decoding stays unknown.
    pub struct UnindexedMarkdownSectionV1 {
        /// Critical section12 or13.
        0 req kind: UnindexedMarkdownSectionKindV1,
        /// Complete section chunk references.
        1 req chunks: Vec<ChunkRef>,
    }
}
wire_tuple! {
    /// Section12 row. The index reports File1/file_count, never a record projection,
    /// regardless of the `.md` extension.
    pub struct UnindexedMarkdownFileRowV1 {
        /// Stable File ID.
        id: Uuid,
        /// Exact record-extension path.
        path: String,
        /// Complete typed payload.
        payload: UnindexedMarkdownPayloadV1,
        /// Extension-derived media class, not trusted MIME.
        media: MediaClass,
    }
}
/// Section13 row; only File1, with the complete kind/content retained.
#[derive(Debug, Clone, PartialEq)]
pub struct UnindexedMarkdownTombstoneRowV1 {
    /// Stable File ID.
    pub id: Uuid,
    /// Last exact path.
    pub path: String,
    /// Retained complete payload; roots are maintained separately.
    pub payload: UnindexedMarkdownPayloadV1,
    /// Deletion position.
    pub seq: u64,
    /// Deletion log-clock instant.
    pub time: i64,
}
impl Wire for UnindexedMarkdownTombstoneRowV1 {
    fn to_cbor(&self) -> Cbor {
        Cbor::Array(vec![
            self.id.to_cbor(),
            EntityKind::File.to_cbor(),
            self.path.to_cbor(),
            self.payload.to_cbor(),
            Cbor::Uint(self.seq),
            self.time.to_cbor(),
        ])
    }
    fn from_cbor(c: &Cbor) -> Result<Self, SchemaError> {
        let ty = "unindexed-markdown-tombstone-row-v1";
        let [id, kind, path, payload, seq, time] = array(c, ty)? else {
            return Err(SchemaError::Invalid {
                ty,
                reason: "must have exactly six elements",
            });
        };
        if EntityKind::from_cbor(kind)? != EntityKind::File {
            return Err(SchemaError::Invalid {
                ty,
                reason: "must be File kind1",
            });
        }
        Ok(Self {
            id: Uuid::from_cbor(id)?,
            path: String::from_cbor(path)?,
            payload: UnindexedMarkdownPayloadV1::from_cbor(payload)?,
            seq: u64::from_cbor(seq)?,
            time: i64::from_cbor(time)?,
        })
    }
    fn annotate(&self) -> Ann {
        Ann::Tuple(
            "UnindexedMarkdownTombstoneRowV1",
            vec![
                ("id", self.id.annotate()),
                ("kind", EntityKind::File.annotate()),
                ("path", self.path.annotate()),
                ("payload", self.payload.annotate()),
                ("seq", self.seq.annotate()),
                ("time", self.time.annotate()),
            ],
        )
    }
}

/// Native durable `TombstoneLast` arm `[3, payload]`; Doc0/Blob1 unchanged, 2 reserved
/// for the attachment arm.
#[derive(Debug, Clone, PartialEq)]
pub struct NativeUnindexedMarkdownTombstoneLastV1 {
    /// Retained complete payload.
    pub payload: UnindexedMarkdownPayloadV1,
}
impl Wire for NativeUnindexedMarkdownTombstoneLastV1 {
    fn to_cbor(&self) -> Cbor {
        Cbor::Array(vec![Cbor::Uint(3), self.payload.to_cbor()])
    }
    fn from_cbor(c: &Cbor) -> Result<Self, SchemaError> {
        let ty = "native-unindexed-markdown-tombstone-last-v1";
        let a = array(c, ty)?;
        match element(a, 0, ty)? {
            3 => {}
            value => return Err(SchemaError::UnknownVariant { ty, value }),
        }
        let [_, payload] = a else {
            return Err(SchemaError::Invalid {
                ty,
                reason: "must have exactly two elements",
            });
        };
        Ok(Self {
            payload: UnindexedMarkdownPayloadV1::from_cbor(payload)?,
        })
    }
    fn annotate(&self) -> Ann {
        Ann::Tuple(
            "NativeUnindexedMarkdownTombstoneLastV1",
            vec![
                ("arm", Ann::Leaf(Cbor::Uint(3))),
                ("payload", self.payload.annotate()),
            ],
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::attachment::AttachmentContentV1;
    use crate::common::B32;
    use crate::intent::BlobRef;

    fn blob(size: u64) -> FileContent {
        FileContent::Blob(BlobRef {
            plain_hash: B32([0x11; 32]),
            size,
            blob_id: B32([0x22; 32]),
            id_epoch: 1,
            part_size: 8_388_608,
        })
    }

    #[test]
    fn declared_size_at_or_below_cap_is_refused_above_is_accepted() {
        let at_cap = UnindexedMarkdownPayloadV1 {
            content: blob(RECORD_SOURCE_CAP_BYTES),
        }
        .to_bytes()
        .unwrap();
        assert!(UnindexedMarkdownPayloadV1::from_bytes(&at_cap).is_err());
        let above = UnindexedMarkdownPayloadV1 {
            content: blob(RECORD_SOURCE_CAP_BYTES + 1),
        };
        let bytes = above.to_bytes().unwrap();
        assert_eq!(
            UnindexedMarkdownPayloadV1::from_bytes(&bytes).unwrap(),
            above
        );
    }

    #[test]
    fn envelope_is_whole_rejected_by_the_attachment_content_decoder() {
        let bytes = UnindexedMarkdownPayloadV1 {
            content: blob(RECORD_SOURCE_CAP_BYTES + 1),
        }
        .to_bytes()
        .unwrap();
        // Legacy `file-content` union dispatch: array -> attachment-content-v1, tag 1 only.
        assert!(AttachmentContentV1::from_bytes(&bytes).is_err());
        assert!(FileContent::from_bytes(&bytes).is_err());
    }

    #[test]
    fn ordinary_kind_never_uses_the_envelope() {
        let mut a = match (UnindexedMarkdownPayloadV1 {
            content: blob(RECORD_SOURCE_CAP_BYTES + 1),
        })
        .to_cbor()
        {
            Cbor::Array(a) => a,
            _ => unreachable!(),
        };
        a[2] = Cbor::Uint(FileKindV1::Ordinary.value());
        assert!(matches!(
            UnindexedMarkdownPayloadV1::from_cbor(&Cbor::Array(a)),
            Err(SchemaError::UnknownVariant { value: 0, .. })
        ));
    }
}
