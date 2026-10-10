//! Critical attachment v1 standalone codecs (`intent.md` §3.9).
//! NOT runtime union activation, crypto verification, emitter or feature authority.
//! Legacy Op/Effect/SectionKind continue whole-item unknown-critical rejection.
use crate::cbor::Cbor;
use crate::common::{B32, Hash, Uuid};
use crate::intent::{BlobRef, MediaClass};
use crate::schema::{Ann, SchemaError, Wire, array, type_err};
use crate::snapshot::{ChunkRef, EntityKind};
use crate::{wire_enum, wire_struct, wire_tuple, wire_union};

/// Fixed v1 plaintext chunk size. Object/manifest/file/admission caps are separate.
pub const CHUNK_BYTES_V1: u64 = 8_388_608;

fn tuple_tag(a: &[Cbor], ty: &'static str, want: u64, format: bool) -> Result<(), SchemaError> {
    match a.first() {
        Some(Cbor::Uint(n)) if *n == want => Ok(()),
        Some(Cbor::Uint(n)) if format => Err(SchemaError::UnknownFormat { ty, fmt: *n }),
        Some(Cbor::Uint(n)) => Err(SchemaError::UnknownVariant { ty, value: *n }),
        Some(c) => Err(type_err(ty, "uint discriminator/version", c)),
        None => Err(SchemaError::Invalid {
            ty,
            reason: "empty tuple",
        }),
    }
}
/// Fixed-profile context and COMPLETE sealed manifest Item hash.
/// Shape validation alone does not check collection/epoch or authenticate a manifest.
#[derive(Debug, Clone, PartialEq)]
pub struct AttachmentRefV1 {
    /// Collection bytes, checked against the verified log by the caller.
    pub collection: Uuid,
    /// Key epoch for this immutable attachment context.
    pub key_epoch: u64,
    /// Opaque context ID, not a legacy keyed BlobRef ID.
    pub attachment_id: B32,
    /// SHA-256 of the complete canonical sealed manifest Item.
    pub manifest_cipher_hash: Hash,
}
impl Wire for AttachmentRefV1 {
    fn to_cbor(&self) -> Cbor {
        Cbor::Array(vec![
            Cbor::Uint(1),
            self.collection.to_cbor(),
            Cbor::Uint(self.key_epoch),
            self.attachment_id.to_cbor(),
            Cbor::Uint(CHUNK_BYTES_V1),
            self.manifest_cipher_hash.to_cbor(),
        ])
    }
    fn from_cbor(c: &Cbor) -> Result<Self, SchemaError> {
        let ty = "attachment-ref-v1";
        let a = array(c, ty)?;
        tuple_tag(a, ty, 1, true)?;
        let [_, collection, epoch, id, chunk, hash] = a else {
            return Err(SchemaError::Invalid {
                ty,
                reason: "must have exactly six elements",
            });
        };
        let chunk = u64::from_cbor(chunk)?;
        if chunk != CHUNK_BYTES_V1 {
            return Err(SchemaError::UnknownFormat {
                ty: "attachment-ref-v1 chunk profile",
                fmt: chunk,
            });
        }
        Ok(Self {
            collection: Uuid::from_cbor(collection)?,
            key_epoch: u64::from_cbor(epoch)?,
            attachment_id: B32::from_cbor(id)?,
            manifest_cipher_hash: Hash::from_cbor(hash)?,
        })
    }
    fn annotate(&self) -> Ann {
        Ann::Tuple(
            "AttachmentRefV1",
            vec![
                ("version", Ann::Leaf(Cbor::Uint(1))),
                ("collection", self.collection.annotate()),
                ("key_epoch", self.key_epoch.annotate()),
                ("attachment_id", self.attachment_id.annotate()),
                ("chunk_bytes", Ann::Leaf(Cbor::Uint(CHUNK_BYTES_V1))),
                ("manifest_cipher_hash", self.manifest_cipher_hash.annotate()),
            ],
        )
    }
}
/// Signed expected whole-file metadata. MUST match the authenticated manifest.
#[derive(Debug, Clone, PartialEq)]
pub struct AttachmentContentV1 {
    /// Critical context/manifest descriptor.
    pub reference: AttachmentRefV1,
    /// SHA-256 of WHOLE plaintext, not one chunk or manifest.
    pub whole_plain_hash: Hash,
    /// WHOLE plaintext byte length. Configured/runtime admission is additional.
    pub total_plain_bytes: u64,
}
impl Wire for AttachmentContentV1 {
    fn to_cbor(&self) -> Cbor {
        Cbor::Array(vec![
            Cbor::Uint(1),
            self.reference.to_cbor(),
            self.whole_plain_hash.to_cbor(),
            Cbor::Uint(self.total_plain_bytes),
        ])
    }
    fn from_cbor(c: &Cbor) -> Result<Self, SchemaError> {
        let ty = "attachment-content-v1";
        let a = array(c, ty)?;
        tuple_tag(a, ty, 1, true)?;
        let [_, reference, hash, size] = a else {
            return Err(SchemaError::Invalid {
                ty,
                reason: "must have exactly four elements",
            });
        };
        Ok(Self {
            reference: AttachmentRefV1::from_cbor(reference)?,
            whole_plain_hash: Hash::from_cbor(hash)?,
            total_plain_bytes: u64::from_cbor(size)?,
        })
    }
    fn annotate(&self) -> Ann {
        Ann::Tuple(
            "AttachmentContentV1",
            vec![
                ("version", Ann::Leaf(Cbor::Uint(1))),
                ("reference", self.reference.annotate()),
                ("whole_plain_hash", self.whole_plain_hash.annotate()),
                ("total_plain_bytes", self.total_plain_bytes.annotate()),
            ],
        )
    }
}
/// Explicit content union for staging/storage adapters, NOT a widened FilePut field.
/// Legacy map and critical versioned tuple are distinct schema forms; never retry
/// decryption or fabricate a BlobRef to dispatch profiles.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub enum FileContent {
    /// Unchanged legacy representation/encryption semantics.
    Blob(BlobRef),
    /// Explicit critical attachment v1 content.
    AttachmentV1(AttachmentContentV1),
}
impl FileContent {
    /// Signed content digest/revision. Not proof that bytes were authenticated.
    pub fn plain_hash(&self) -> Hash {
        match self {
            Self::Blob(b) => b.plain_hash,
            Self::AttachmentV1(a) => a.whole_plain_hash,
        }
    }
    /// Signed whole plaintext length. Not permission to allocate it or exceed caps.
    pub fn size(&self) -> u64 {
        match self {
            Self::Blob(b) => b.size,
            Self::AttachmentV1(a) => a.total_plain_bytes,
        }
    }
}
impl Wire for FileContent {
    fn to_cbor(&self) -> Cbor {
        match self {
            Self::Blob(b) => b.to_cbor(),
            Self::AttachmentV1(a) => a.to_cbor(),
        }
    }
    fn from_cbor(c: &Cbor) -> Result<Self, SchemaError> {
        match c {
            Cbor::Map(_) => BlobRef::from_cbor(c).map(Self::Blob),
            Cbor::Array(_) => AttachmentContentV1::from_cbor(c).map(Self::AttachmentV1),
            _ => Err(type_err(
                "file-content",
                "blob-ref map or versioned attachment tuple",
                c,
            )),
        }
    }
    fn annotate(&self) -> Ann {
        match self {
            Self::Blob(b) => b.annotate(),
            Self::AttachmentV1(a) => a.annotate(),
        }
    }
}
wire_struct! {
    /// Critical FileAttach13 body; same logical File/path/CAS rules as FilePut.
    pub struct FileAttach {
        /// File ID.
        1 req id: Uuid,
        /// Exact path.
        2 req path: String,
        /// Signed expected content, reconciled by typed verified mediation.
        3 req content: AttachmentContentV1,
        /// Explicit CAS revision.
        4 opt if_revision: Hash,
        /// External capture base.
        5 opt base: Hash,
    }
}
wire_struct! {
    /// Op18: existing Ordinary attachment continuation, with complete descriptor CAS.
    pub struct OrdinaryAttachmentContinuation {
        /// Existing Ordinary File ID; never create or convert.
        1 req id: Uuid,
        /// Same exact record-extension path.
        2 req path: String,
        /// Authenticated new attachment content.
        3 req content: AttachmentContentV1,
        /// Complete prior FileContent, including rekey/reseal identity.
        4 req prior: FileContent,
    }
}
wire_union! {
    /// Standalone critical op codec; existing runtime Op still rejects tag13.
    pub enum AttachmentOpV1 {
        /// Critical attachment create/replace intent.
        13 => FileAttach(FileAttach),
    }
}
wire_struct! {
    /// Critical PutAttachmentFile8 body, NOT permission to apply it.
    pub struct PutAttachmentFile {
        /// File ID.
        1 req id: Uuid,
        /// Exact path.
        2 req path: String,
        /// Signed expected content.
        3 req content: AttachmentContentV1,
    }
}
wire_union! {
    /// Standalone critical effect codec; existing runtime Effect rejects tag8.
    pub enum AttachmentEffectV1 {
        /// Critical attachment content result.
        8 => PutAttachmentFile(PutAttachmentFile),
    }
}
/// Critical conflict-held attachment value5, preserving the complete descriptor.
#[derive(Debug, Clone, PartialEq)]
pub struct AttachmentConflictValueV1 {
    /// Signed expected content retained in the unresolved conflict.
    pub content: AttachmentContentV1,
}
impl Wire for AttachmentConflictValueV1 {
    fn to_cbor(&self) -> Cbor {
        Cbor::Array(vec![Cbor::Uint(5), self.content.to_cbor()])
    }
    fn from_cbor(c: &Cbor) -> Result<Self, SchemaError> {
        let ty = "attachment-conflict-value-v1";
        let a = array(c, ty)?;
        tuple_tag(a, ty, 5, false)?;
        let [_, content] = a else {
            return Err(SchemaError::Invalid {
                ty,
                reason: "must have exactly two elements",
            });
        };
        Ok(Self {
            content: AttachmentContentV1::from_cbor(content)?,
        })
    }
    fn annotate(&self) -> Ann {
        Ann::Tuple(
            "AttachmentConflictValueV1",
            vec![
                ("kind", Ann::Leaf(Cbor::Uint(5))),
                ("content", self.content.annotate()),
            ],
        )
    }
}
wire_enum! {
    /// Critical standalone snapshot sections; legacy SectionKind rejects10/11.
    pub enum AttachmentSectionKindV1 {
        /// Live attachment content rows, disjoint IDs from legacy Files4.
        AttachmentFiles = 10,
        /// Retained File tombstones, disjoint IDs from legacy Tombstones5.
        AttachmentTombstones = 11,
    }
}
wire_struct! {
    /// Standalone critical section header; legacy manifest decoding stays unknown.
    pub struct AttachmentSectionV1 {
        /// Critical section10 or11.
        0 req kind: AttachmentSectionKindV1,
        /// Complete section chunk references.
        1 req chunks: Vec<ChunkRef>,
    }
}
wire_tuple! {
    /// AttachmentFiles10 row. Index EntityKind/File count remains File1.
    pub struct AttachmentFileRowV1 {
        /// Stable File ID.
        id: Uuid,
        /// Exact path.
        path: String,
        /// Critical signed content.
        content: AttachmentContentV1,
        /// Extension-derived media class, not trusted MIME.
        media: MediaClass,
    }
}
/// AttachmentTombstones11 row; only File1, not a widened legacy tombstone tuple.
#[derive(Debug, Clone, PartialEq)]
pub struct AttachmentTombstoneRowV1 {
    /// Stable File ID.
    pub id: Uuid,
    /// Last exact path.
    pub path: String,
    /// Retained critical signed content, with complete roots maintained separately.
    pub content: AttachmentContentV1,
    /// Deletion position.
    pub seq: u64,
    /// Deletion log-clock instant.
    pub time: i64,
}
impl Wire for AttachmentTombstoneRowV1 {
    fn to_cbor(&self) -> Cbor {
        Cbor::Array(vec![
            self.id.to_cbor(),
            EntityKind::File.to_cbor(),
            self.path.to_cbor(),
            self.content.to_cbor(),
            Cbor::Uint(self.seq),
            self.time.to_cbor(),
        ])
    }
    fn from_cbor(c: &Cbor) -> Result<Self, SchemaError> {
        let ty = "attachment-tombstone-row-v1";
        let [id, kind, path, content, seq, time] = array(c, ty)? else {
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
            content: AttachmentContentV1::from_cbor(content)?,
            seq: u64::from_cbor(seq)?,
            time: i64::from_cbor(time)?,
        })
    }
    fn annotate(&self) -> Ann {
        Ann::Tuple(
            "AttachmentTombstoneRowV1",
            vec![
                ("id", self.id.annotate()),
                ("kind", EntityKind::File.annotate()),
                ("path", self.path.annotate()),
                ("content", self.content.annotate()),
                ("seq", self.seq.annotate()),
                ("time", self.time.annotate()),
            ],
        )
    }
}
