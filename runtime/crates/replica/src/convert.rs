//! Conversions between the wire shapes (`mdbn_wire`) and the core's semantic shapes
//! (`mdbn_core`).
//!
//! The wire carries `text` as either a string or an index into an entry's text table;
//! the core only sees resolved strings. Conversion into the core therefore takes a
//! text resolver. Outside log entries (submits, pending rows) every text is inline and
//! [`inline_only`] is the resolver.

use mdbn_core::ids::{Hash as CHash, Uuid as CUuid};
use mdbn_core::intent as ci;
use mdbn_core::plan as cp;
use mdbn_core::state as cs;
use mdbn_core::value::{Map as CMap, Value as CValue};
use mdbn_wire::attachment as wa;
use mdbn_wire::attachment_runtime_v1 as wr;
use mdbn_wire::common::{B16, B32, DataMap, Text, Value as WValue};
use mdbn_wire::entry as we;
use mdbn_wire::intent as wi;
use mdbn_wire::unindexed_markdown as wu;

/// Why a wire value could not be converted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConvertError {
    /// A text index could not be resolved.
    Text(String),
    /// A float outside the data model (NaN or infinite).
    Float,
    /// A critical attachment (`intent.md` §3.9) has no legacy wire form: the
    /// legacy `Effect`/`ConflictValue` codecs cannot carry it and a `BlobRef`
    /// must never stand in for it. The explicit attachment codecs
    /// ([`wattachment_effect`], [`wattachment_conflict_value`]) do.
    AttachmentUnsupported,
    /// An unindexed oversized Markdown effect or conflict side (`intent.md`
    /// §3.10) has no legacy wire form: the legacy `Effect`/`ConflictValue`
    /// codecs cannot carry it and a `BlobRef` must never stand in for it. The
    /// explicit codecs ([`wunindexed_markdown_effect`],
    /// [`wunindexed_markdown_conflict_value`]) do.
    UnindexedMarkdownUnsupported,
    /// Ordinary promotion has no legacy effect encoding. Runtime activation is
    /// separate and must use the closed critical Effect11 codec.
    OrdinaryFilePromotionUnsupported,
    /// Op18 requires qualified descriptor-CAS continuation mediation.
    OrdinaryFileContinuationUnsupported,
    /// A wire file content form this replica does not know (the wire union is
    /// open); never guessed at as a blob.
    UnknownFileContent,
}

impl std::fmt::Display for ConvertError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConvertError::Text(m) => write!(f, "unresolvable text: {m}"),
            ConvertError::Float => write!(f, "non-finite float"),
            ConvertError::AttachmentUnsupported => {
                write!(f, "attachment content has no legacy wire form")
            }
            ConvertError::UnindexedMarkdownUnsupported => {
                write!(f, "unindexed oversized markdown has no legacy wire form")
            }
            ConvertError::OrdinaryFilePromotionUnsupported => {
                write!(f, "ordinary promotion has no legacy wire form")
            }
            ConvertError::OrdinaryFileContinuationUnsupported => {
                write!(f, "ordinary continuation mediation not yet qualified")
            }
            ConvertError::UnknownFileContent => write!(f, "unknown file content form"),
        }
    }
}

impl std::error::Error for ConvertError {}

/// Conversion result.
pub type CResult<T> = Result<T, ConvertError>;

/// A resolver for `text` values.
pub type TextResolver<'a> = &'a dyn Fn(&Text) -> CResult<String>;

/// Resolver for contexts where every text is inline.
pub fn inline_only(t: &Text) -> CResult<String> {
    match t {
        Text::Inline(s) => Ok(s.clone()),
        Text::Index(i) => Err(ConvertError::Text(format!(
            "text index {i} outside an entry"
        ))),
    }
}

// ---------------------------------------------------------------- ids

/// Wire UUID to core.
pub fn uuid(u: &B16) -> CUuid {
    CUuid(u.0)
}

/// Core UUID to wire.
pub fn wuuid(u: &CUuid) -> B16 {
    B16(u.0)
}

/// Wire hash to core.
pub fn hash(h: &B32) -> CHash {
    CHash(h.0)
}

/// Core hash to wire.
pub fn whash(h: &CHash) -> B32 {
    B32(h.0)
}

// ---------------------------------------------------------------- values

/// Wire value to core.
pub fn value(v: &WValue) -> CResult<CValue> {
    Ok(match v {
        WValue::Null => CValue::Null,
        WValue::Bool(b) => CValue::Bool(*b),
        WValue::Int(i) => CValue::Int(*i),
        WValue::Float(f) => CValue::float(*f).ok_or(ConvertError::Float)?,
        WValue::Text(s) => CValue::Text(s.clone()),
        WValue::List(l) => CValue::List(l.iter().map(value).collect::<CResult<_>>()?),
        WValue::Map(m) => CValue::Map(map_pairs(m)?),
    })
}

fn map_pairs(m: &[(String, WValue)]) -> CResult<CMap> {
    let mut out = CMap::new();
    for (k, v) in m {
        out.insert(k.clone(), value(v)?);
    }
    Ok(out)
}

/// Wire data map to a core map.
pub fn map(m: &DataMap<WValue>) -> CResult<CMap> {
    map_pairs(&m.0)
}

/// Core value to wire.
pub fn wvalue(v: &CValue) -> WValue {
    match v {
        CValue::Null => WValue::Null,
        CValue::Bool(b) => WValue::Bool(*b),
        CValue::Int(i) => WValue::Int(*i),
        CValue::Float(f) => WValue::Float(*f),
        CValue::Text(s) => WValue::Text(s.clone()),
        CValue::List(l) => WValue::List(l.iter().map(wvalue).collect()),
        CValue::Map(m) => WValue::Map(m.iter().map(|(k, v)| (k.to_string(), wvalue(v))).collect()),
    }
}

/// Core map to a wire data map.
pub fn wmap(m: &CMap) -> DataMap<WValue> {
    DataMap(m.iter().map(|(k, v)| (k.to_string(), wvalue(v))).collect())
}

// ---------------------------------------------------------------- small types

/// Wire blob ref to core.
pub fn blob(b: &wi::BlobRef) -> ci::BlobRef {
    ci::BlobRef {
        plain_hash: hash(&b.plain_hash),
        size: b.size,
        blob_id: b.blob_id.0,
        id_epoch: b.id_epoch,
        part_size: b.part_size,
    }
}

/// Core blob ref to wire.
pub fn wblob(b: &ci::BlobRef) -> wi::BlobRef {
    wi::BlobRef {
        plain_hash: whash(&b.plain_hash),
        size: b.size,
        blob_id: B32(b.blob_id),
        id_epoch: b.id_epoch,
        part_size: b.part_size,
    }
}

/// Wire stored kind to Core without extension-based inference.
pub fn file_kind(kind: wu::FileKindV1) -> ci::FileKind {
    match kind {
        wu::FileKindV1::Ordinary => ci::FileKind::Ordinary,
        wu::FileKindV1::UnindexedOversizedMarkdown => ci::FileKind::UnindexedOversizedMarkdown,
    }
}

// ---------------------------------------------------------------- attachments
//
// Data-only: none of these verify a manifest, check a collection or admit a size.

/// Wire attachment reference to core.
pub fn attachment_ref(r: &wa::AttachmentRefV1) -> ci::AttachmentRefV1 {
    ci::AttachmentRefV1 {
        collection: uuid(&r.collection),
        key_epoch: r.key_epoch,
        attachment_id: r.attachment_id.0,
        manifest_cipher_hash: hash(&r.manifest_cipher_hash),
    }
}

/// Core attachment reference to wire.
pub fn wattachment_ref(r: &ci::AttachmentRefV1) -> wa::AttachmentRefV1 {
    wa::AttachmentRefV1 {
        collection: wuuid(&r.collection),
        key_epoch: r.key_epoch,
        attachment_id: B32(r.attachment_id),
        manifest_cipher_hash: whash(&r.manifest_cipher_hash),
    }
}

/// Wire signed attachment content to core.
pub fn attachment_content(a: &wa::AttachmentContentV1) -> ci::AttachmentContentV1 {
    ci::AttachmentContentV1 {
        reference: attachment_ref(&a.reference),
        whole_plain_hash: hash(&a.whole_plain_hash),
        total_plain_bytes: a.total_plain_bytes,
    }
}

/// Core signed attachment content to wire.
pub fn wattachment_content(a: &ci::AttachmentContentV1) -> wa::AttachmentContentV1 {
    wa::AttachmentContentV1 {
        reference: wattachment_ref(&a.reference),
        whole_plain_hash: whash(&a.whole_plain_hash),
        total_plain_bytes: a.total_plain_bytes,
    }
}

/// Wire file content union to core, each arm to its own arm. The wire union is
/// open; an arm this replica does not know is refused, not read as a blob.
pub fn file_content(c: &wa::FileContent) -> CResult<ci::FileContent> {
    Ok(match c {
        wa::FileContent::Blob(b) => ci::FileContent::Blob(blob(b)),
        wa::FileContent::AttachmentV1(a) => ci::FileContent::AttachmentV1(attachment_content(a)),
        _ => return Err(ConvertError::UnknownFileContent),
    })
}

/// Core file content union to wire, each arm to its own arm.
pub fn wfile_content(c: &ci::FileContent) -> wa::FileContent {
    match c {
        ci::FileContent::Blob(b) => wa::FileContent::Blob(wblob(b)),
        ci::FileContent::AttachmentV1(a) => wa::FileContent::AttachmentV1(wattachment_content(a)),
    }
}

/// Wire attachment effect (standalone codec) to core.
pub fn attachment_effect(p: &wa::PutAttachmentFile) -> cp::Effect {
    cp::Effect::PutAttachmentFile {
        id: uuid(&p.id),
        path: p.path.clone(),
        content: attachment_content(&p.content),
    }
}

/// Core attachment effect to its standalone wire codec; `None` for any other
/// effect (those go through [`weffect`]).
pub fn wattachment_effect(e: &cp::Effect) -> Option<wa::PutAttachmentFile> {
    match e {
        cp::Effect::PutAttachmentFile { id, path, content } => Some(wa::PutAttachmentFile {
            id: wuuid(id),
            path: path.clone(),
            content: wattachment_content(content),
        }),
        _ => None,
    }
}

/// Wire attachment conflict value (standalone codec) to core.
pub fn attachment_conflict_value(v: &wa::AttachmentConflictValueV1) -> cp::ConflictValue {
    cp::ConflictValue::Attachment(attachment_content(&v.content))
}

/// Core attachment conflict value to its standalone wire codec; `None` for any
/// other value (those go through [`wconflict`]).
pub fn wattachment_conflict_value(v: &cp::ConflictValue) -> Option<wa::AttachmentConflictValueV1> {
    match v {
        cp::ConflictValue::Attachment(a) => Some(wa::AttachmentConflictValueV1 {
            content: wattachment_content(a),
        }),
        _ => None,
    }
}

/// Wire unindexed oversized Markdown effect (standalone codec, `intent.md` §3.10)
/// to core. The payload envelope's content is the open file content union; an
/// arm this replica does not know is refused, never read as a blob.
pub fn unindexed_markdown_effect(e: &wu::UnindexedMarkdownEffectV1) -> CResult<cp::Effect> {
    Ok(match e {
        wu::UnindexedMarkdownEffectV1::PutUnindexedMarkdown(p) => {
            cp::Effect::PutUnindexedMarkdown {
                id: uuid(&p.id),
                path: p.path.clone(),
                content: file_content(&p.payload.content)?,
            }
        }
        wu::UnindexedMarkdownEffectV1::ReindexUnindexedMarkdown(r) => {
            cp::Effect::ReindexUnindexedMarkdown {
                id: uuid(&r.id),
                path: r.path.clone(),
                // Standalone data-only codec: a text-table index needs the
                // entry's texts to resolve, which only the entry decoder has.
                doc: inline_only(&r.doc)?,
            }
        }
    })
}

/// Core unindexed oversized Markdown effect to its standalone wire codec; `None`
/// for any other effect (those go through [`weffect`] or [`wattachment_effect`]).
pub fn wunindexed_markdown_effect(e: &cp::Effect) -> Option<wu::UnindexedMarkdownEffectV1> {
    match e {
        cp::Effect::PutUnindexedMarkdown { id, path, content } => Some(
            wu::UnindexedMarkdownEffectV1::PutUnindexedMarkdown(wu::PutUnindexedMarkdown {
                id: wuuid(id),
                path: path.clone(),
                payload: wu::UnindexedMarkdownPayloadV1 {
                    content: wfile_content(content),
                },
            }),
        ),
        cp::Effect::ReindexUnindexedMarkdown { id, path, doc } => Some(
            wu::UnindexedMarkdownEffectV1::ReindexUnindexedMarkdown(wu::ReindexUnindexedMarkdown {
                id: wuuid(id),
                path: path.clone(),
                doc: Text::Inline(doc.clone()),
            }),
        ),
        _ => None,
    }
}

/// Wire unindexed oversized Markdown conflict value (standalone codec) to core;
/// an unknown content arm is refused, never read as a blob.
pub fn unindexed_markdown_conflict_value(
    v: &wu::UnindexedMarkdownConflictValueV1,
) -> CResult<cp::ConflictValue> {
    Ok(cp::ConflictValue::UnindexedMarkdown(file_content(
        &v.payload.content,
    )?))
}

/// Core unindexed oversized Markdown conflict value to its standalone wire codec;
/// `None` for any other value (those go through [`wconflict`] or
/// [`wattachment_conflict_value`]).
pub fn wunindexed_markdown_conflict_value(
    v: &cp::ConflictValue,
) -> Option<wu::UnindexedMarkdownConflictValueV1> {
    match v {
        cp::ConflictValue::UnindexedMarkdown(c) => Some(wu::UnindexedMarkdownConflictValueV1 {
            payload: wu::UnindexedMarkdownPayloadV1 {
                content: wfile_content(c),
            },
        }),
        _ => None,
    }
}

/// Wire attachment file row (snapshot section 10) to core state. Attachment rows
/// are ordinary-kind files; the unindexed kind arrives only through snapshot
/// sections 12/13.
pub fn attachment_file_row(r: &wa::AttachmentFileRowV1) -> cs::StoredFile {
    cs::StoredFile {
        id: uuid(&r.id),
        path: r.path.clone(),
        content: ci::FileContent::AttachmentV1(attachment_content(&r.content)),
        kind: ci::FileKind::Ordinary,
    }
}

/// Wire attachment tombstone row (snapshot section 11) to core state, an
/// ordinary-kind file tombstone.
pub fn attachment_tombstone_row(r: &wa::AttachmentTombstoneRowV1) -> cs::Tombstone {
    cs::Tombstone::File {
        path: r.path.clone(),
        content: ci::FileContent::AttachmentV1(attachment_content(&r.content)),
        kind: ci::FileKind::Ordinary,
    }
}

fn media(m: wi::MediaClass) -> ci::MediaClass {
    match m {
        wi::MediaClass::Image => ci::MediaClass::Image,
        wi::MediaClass::Audio => ci::MediaClass::Audio,
        wi::MediaClass::Video => ci::MediaClass::Video,
        wi::MediaClass::Pdf => ci::MediaClass::Pdf,
        wi::MediaClass::Other => ci::MediaClass::Other,
    }
}

fn wmedia(m: ci::MediaClass) -> wi::MediaClass {
    match m {
        ci::MediaClass::Image => wi::MediaClass::Image,
        ci::MediaClass::Audio => wi::MediaClass::Audio,
        ci::MediaClass::Video => wi::MediaClass::Video,
        ci::MediaClass::Pdf => wi::MediaClass::Pdf,
        ci::MediaClass::Other => wi::MediaClass::Other,
    }
}

/// Wire inclusion policy to core.
pub fn inclusion(f: &wi::FileInclusion) -> ci::FileInclusion {
    ci::FileInclusion {
        include: f.include.iter().copied().map(media).collect(),
        exclude: f.exclude.clone().unwrap_or_default(),
        max_size: f.max_size,
    }
}

/// Core inclusion policy to wire.
pub fn winclusion(f: &ci::FileInclusion) -> wi::FileInclusion {
    wi::FileInclusion {
        include: f.include.iter().copied().map(wmedia).collect(),
        exclude: if f.exclude.is_empty() {
            None
        } else {
            Some(f.exclude.clone())
        },
        max_size: f.max_size,
    }
}

fn level(l: wi::Level) -> ci::Level {
    match l {
        wi::Level::Off => ci::Level::Off,
        wi::Level::Warn => ci::Level::Warn,
        wi::Level::Error => ci::Level::Error,
    }
}

fn doc_version(d: &wi::DocVersion, t: TextResolver<'_>) -> CResult<ci::DocVersion> {
    Ok(ci::DocVersion {
        path: d.path.clone(),
        doc: t(&d.doc)?,
    })
}

fn opt_text(x: &Option<Text>, t: TextResolver<'_>) -> CResult<Option<String>> {
    x.as_ref().map(t).transpose()
}

fn list_map(m: &Option<DataMap<Vec<WValue>>>) -> CResult<Vec<(String, Vec<CValue>)>> {
    let Some(m) = m else {
        return Ok(Vec::new());
    };
    m.0.iter()
        .map(|(k, vs)| Ok((k.clone(), vs.iter().map(value).collect::<CResult<_>>()?)))
        .collect()
}

// ---------------------------------------------------------------- operations

/// Wire operation to core.
pub fn op(o: &wi::Op, t: TextResolver<'_>) -> CResult<ci::Op> {
    Ok(match o {
        wi::Op::Create(c) => ci::Op::Create(ci::Create {
            id: uuid(&c.id),
            path: c.path.clone(),
            type_name: c.type_name.clone(),
            frontmatter: c.frontmatter.as_ref().map(map).transpose()?,
            body: opt_text(&c.body, t)?,
            document: opt_text(&c.document, t)?,
        }),
        wi::Op::Update(u) => ci::Op::Update(ci::Update {
            id: uuid(&u.id),
            patch: u.patch.as_ref().map(map).transpose()?,
            unset: u.unset.clone().unwrap_or_default(),
            add: list_map(&u.add)?,
            remove: list_map(&u.remove)?,
            body: opt_text(&u.body, t)?,
            body_edits: u
                .body_edits
                .iter()
                .flatten()
                .map(|e| ci::BodyEdit {
                    start: e.start,
                    end: e.end,
                    insert: e.insert.clone(),
                })
                .collect(),
            body_base: u.body_base.as_ref().map(hash),
            body_base_text: opt_text(&u.body_base_text, t)?,
            base: u
                .base
                .iter()
                .flatten()
                .map(|b| {
                    Ok(ci::BaseField {
                        key: b.key.clone(),
                        observed: b.observed.as_ref().map(value).transpose()?,
                    })
                })
                .collect::<CResult<_>>()?,
            if_revision: u.if_revision.as_ref().map(hash),
        }),
        wi::Op::Document(d) => ci::Op::Document(ci::DocumentOp {
            id: uuid(&d.id),
            base: d.base.as_ref().map(|v| doc_version(v, t)).transpose()?,
            new: d.new.as_ref().map(|v| doc_version(v, t)).transpose()?,
            if_revision: d.if_revision.as_ref().map(hash),
        }),
        wi::Op::Delete(d) => ci::Op::Delete(ci::Delete {
            id: uuid(&d.id),
            base_revision: d.base_revision.as_ref().map(hash),
            if_revision: d.if_revision.as_ref().map(hash),
        }),
        wi::Op::Rename(r) => ci::Op::Rename(ci::Rename {
            id: uuid(&r.id),
            from: r.from.clone(),
            to: r.to.clone(),
            update_refs: r.update_refs,
            if_revision: r.if_revision.as_ref().map(hash),
        }),
        wi::Op::ResourcePut(r) => ci::Op::ResourcePut(ci::ResourcePut {
            path: r.path.clone(),
            doc: t(&r.doc)?,
            base_revision: r.base_revision.as_ref().map(hash),
            must_not_exist: r.must_not_exist == Some(true),
        }),
        wi::Op::ResourceDelete(r) => ci::Op::ResourceDelete(ci::ResourceDelete {
            path: r.path.clone(),
            base_revision: r.base_revision.as_ref().map(hash),
        }),
        wi::Op::FilePut(f) => ci::Op::FilePut(ci::FilePut {
            id: uuid(&f.id),
            path: f.path.clone(),
            blob: blob(&f.blob),
            if_revision: f.if_revision.as_ref().map(hash),
            base: f.base.as_ref().map(hash),
        }),
        wi::Op::FileDelete(f) => ci::Op::FileDelete(ci::FileDelete {
            id: uuid(&f.id),
            if_revision: f.if_revision.as_ref().map(hash),
            base: f.base.as_ref().map(hash),
        }),
        wi::Op::FileMove(f) => ci::Op::FileMove(ci::FileMove {
            id: uuid(&f.id),
            from: f.from.clone(),
            to: f.to.clone(),
            update_refs: f.update_refs,
            if_revision: f.if_revision.as_ref().map(hash),
        }),
        wi::Op::ConflictDismiss(c) => ci::Op::ConflictDismiss(ci::ConflictDismiss {
            mutation: uuid(&c.mutation),
            record: uuid(&c.record),
        }),
        wi::Op::SyncSettings(s) => ci::Op::SyncSettings(inclusion(&s.inclusion)),
    })
}

/// Wire mutation to core.
pub fn mutation(m: &wi::Mutation, t: TextResolver<'_>) -> CResult<ci::Mutation> {
    Ok(ci::Mutation {
        id: uuid(&m.id),
        origin: uuid(&m.origin),
        base_seq: m.base_seq,
        clock: ci::OpClock {
            instant_ms: m.clock.instant,
            tz: m.clock.tz.clone(),
            local_date: m.clock.local_date.clone(),
        },
        seed: m.seed.0,
        source: match m.source {
            wi::Source::Api => ci::Source::Api,
            wi::Source::External => ci::Source::External,
        },
        ops: m.ops.iter().map(|o| op(o, t)).collect::<CResult<_>>()?,
        on_behalf: m.on_behalf.as_ref().map(uuid),
        conflict_mode: match m.conflict_mode {
            Some(wi::ConflictMode::Reject) => ci::ConflictMode::Reject,
            _ => ci::ConflictMode::Record,
        },
        validated_at: m.validated_at.map(level),
        room: m.room.as_ref().map(|r| ci::RoomCheckpoint {
            stream: r.stream.0,
            state: hash(&r.state),
        }),
    })
}

/// Runtime-family operation to core: legacy operations unchanged, `file_attach`
/// (Op13) to [`ci::Op::FileAttach`].
pub fn runtime_op(o: &wr::Op, t: TextResolver<'_>) -> CResult<ci::Op> {
    match o {
        wr::Op::Legacy(o) => op(o, t),
        wr::Op::OrdinaryAttachmentContinuation(_) => {
            Err(ConvertError::OrdinaryFileContinuationUnsupported)
        }
        wr::Op::FileAttach(f) => Ok(ci::Op::FileAttach(ci::FileAttach {
            id: uuid(&f.id),
            path: f.path.clone(),
            content: attachment_content(&f.content),
            if_revision: f.if_revision.as_ref().map(hash),
            base: f.base.as_ref().map(hash),
        })),
        wr::Op::UnindexedMarkdownPut(f) => {
            Ok(ci::Op::UnindexedMarkdownPut(ci::UnindexedMarkdownPut {
                id: uuid(&f.id),
                path: f.path.clone(),
                content: file_content(&f.payload.content)?,
                expected: f
                    .expected
                    .as_ref()
                    .map(|p| file_content(&p.content))
                    .transpose()?,
            }))
        }
        wr::Op::RecordToUnindexedMarkdown(f) => Ok(ci::Op::RecordToUnindexedMarkdown(
            ci::RecordToUnindexedMarkdown {
                id: uuid(&f.id),
                path: f.path.clone(),
                content: file_content(&f.payload.content)?,
                prior_revision: hash(&f.prior_revision),
            },
        )),
        wr::Op::UnindexedMarkdownToRecord(f) => Ok(ci::Op::UnindexedMarkdownToRecord(
            ci::UnindexedMarkdownToRecord {
                id: uuid(&f.id),
                path: f.path.clone(),
                doc: t(&f.doc)?,
                prior: file_content(&f.prior.content)?,
            },
        )),
        wr::Op::OrdinaryFileToRecord(_) => Err(ConvertError::OrdinaryFilePromotionUnsupported),
    }
}

/// Runtime-family mutation (a pending row) to core.
pub fn runtime_mutation(m: &wr::Mutation, t: TextResolver<'_>) -> CResult<ci::Mutation> {
    // The header fields are the legacy mutation's, converted by one function.
    let header = wi::Mutation {
        id: m.id,
        origin: m.origin,
        base_seq: m.base_seq,
        clock: m.clock.clone(),
        seed: m.seed,
        source: m.source,
        ops: Vec::new(),
        on_behalf: m.on_behalf,
        conflict_mode: m.conflict_mode,
        validated_at: m.validated_at,
        room: m.room.clone(),
    };
    let mut out = mutation(&header, t)?;
    out.ops = m
        .ops
        .iter()
        .map(|o| runtime_op(o, t))
        .collect::<CResult<_>>()?;
    Ok(out)
}

/// Core effect to the runtime family: an attachment put as Effect8, everything
/// else through [`weffect`] (which still refuses what neither family carries).
pub fn wruntime_effect(e: &cp::Effect) -> CResult<wr::Effect> {
    if let Some(u) = wunindexed_markdown_effect(e) {
        return Ok(match u {
            wu::UnindexedMarkdownEffectV1::PutUnindexedMarkdown(p) => {
                wr::Effect::PutUnindexedMarkdown(p)
            }
            wu::UnindexedMarkdownEffectV1::ReindexUnindexedMarkdown(r) => {
                wr::Effect::ReindexUnindexedMarkdown(r)
            }
        });
    }
    match wattachment_effect(e) {
        Some(p) => Ok(wr::Effect::PutAttachmentFile(p)),
        None => weffect(e).map(wr::Effect::Legacy),
    }
}

fn wruntime_conflict_value(v: &cp::ConflictValue) -> CResult<wr::ConflictValue> {
    if let Some(u) = wunindexed_markdown_conflict_value(v) {
        return Ok(wr::ConflictValue::UnindexedMarkdown(u.payload));
    }
    match wattachment_conflict_value(v) {
        Some(a) => Ok(wr::ConflictValue::Attachment(a.content)),
        None => wconflict_value(v).map(wr::ConflictValue::Legacy),
    }
}

/// Core conflict to the runtime family (attachment sides as ConflictValue5).
pub fn wruntime_conflict(c: &cp::RecordedConflict) -> CResult<wr::Conflict> {
    let legacy = |v: &cp::ConflictValue| wruntime_conflict_value(v);
    Ok(wr::Conflict {
        kind: wconflict_kind(c.kind),
        id: wuuid(&c.id),
        field: c.field.clone(),
        base: c.base.as_ref().map(legacy).transpose()?,
        kept: legacy(&c.kept)?,
        lost: legacy(&c.lost)?,
    })
}

// ---------------------------------------------------------------- results

/// Core effect to wire (texts inline).
///
/// A [`cp::Effect::PutAttachmentFile`] has no legacy wire form and is refused
/// with [`ConvertError::AttachmentUnsupported`]; see [`wattachment_effect`].
/// Likewise [`cp::Effect::PutUnindexedMarkdown`] and
/// [`cp::Effect::ReindexUnindexedMarkdown`] are refused with
/// [`ConvertError::UnindexedMarkdownUnsupported`]; see
/// [`wunindexed_markdown_effect`]. Nothing is downcast to a blob or dropped.
pub fn weffect(e: &cp::Effect) -> CResult<we::Effect> {
    Ok(match e {
        cp::Effect::PutRecord { id, path, doc } => we::Effect::PutRecord(we::PutRecord {
            id: wuuid(id),
            path: path.clone(),
            doc: Text::Inline(doc.clone()),
        }),
        cp::Effect::RemoveRecord { id, path } => we::Effect::RemoveRecord(we::RemoveRecord {
            id: wuuid(id),
            path: path.clone(),
        }),
        cp::Effect::PutFile { id, path, blob } => we::Effect::PutFile(we::PutFile {
            id: wuuid(id),
            path: path.clone(),
            blob: wblob(blob),
        }),
        cp::Effect::PutAttachmentFile { .. } => return Err(ConvertError::AttachmentUnsupported),
        cp::Effect::PutUnindexedMarkdown { .. } | cp::Effect::ReindexUnindexedMarkdown { .. } => {
            return Err(ConvertError::UnindexedMarkdownUnsupported);
        }
        cp::Effect::ReindexOrdinaryFile { .. } => {
            return Err(ConvertError::OrdinaryFilePromotionUnsupported);
        }
        cp::Effect::RemoveFile { id, path } => we::Effect::RemoveFile(we::RemoveFile {
            id: wuuid(id),
            path: path.clone(),
        }),
        cp::Effect::PutResource { path, doc } => we::Effect::PutResource(we::PutResource {
            path: path.clone(),
            doc: Text::Inline(doc.clone()),
        }),
        cp::Effect::RemoveResource { path } => {
            we::Effect::RemoveResource(we::RemoveResource { path: path.clone() })
        }
        cp::Effect::PutSettings(f) => we::Effect::PutSettings(we::PutSettings {
            inclusion: winclusion(f),
        }),
    })
}

/// Wire effect to core, resolving texts.
pub fn effect(e: &we::Effect, t: TextResolver<'_>) -> CResult<cp::Effect> {
    Ok(match e {
        we::Effect::PutRecord(p) => cp::Effect::PutRecord {
            id: uuid(&p.id),
            path: p.path.clone(),
            doc: t(&p.doc)?,
        },
        we::Effect::RemoveRecord(p) => cp::Effect::RemoveRecord {
            id: uuid(&p.id),
            path: p.path.clone(),
        },
        we::Effect::PutFile(p) => cp::Effect::PutFile {
            id: uuid(&p.id),
            path: p.path.clone(),
            blob: blob(&p.blob),
        },
        we::Effect::RemoveFile(p) => cp::Effect::RemoveFile {
            id: uuid(&p.id),
            path: p.path.clone(),
        },
        we::Effect::PutResource(p) => cp::Effect::PutResource {
            path: p.path.clone(),
            doc: t(&p.doc)?,
        },
        we::Effect::RemoveResource(p) => cp::Effect::RemoveResource {
            path: p.path.clone(),
        },
        we::Effect::PutSettings(s) => cp::Effect::PutSettings(inclusion(&s.inclusion)),
    })
}

/// Core status to wire.
pub fn wstatus(s: cp::Status) -> we::Status {
    match s {
        cp::Status::Applied => we::Status::Applied,
        cp::Status::Merged => we::Status::Merged,
        cp::Status::Conflicted => we::Status::Conflicted,
    }
}

fn wconflict_value(v: &cp::ConflictValue) -> CResult<we::ConflictValue> {
    Ok(match v {
        cp::ConflictValue::Missing => we::ConflictValue::Missing,
        cp::ConflictValue::Value(v) => we::ConflictValue::Value(wvalue(v)),
        cp::ConflictValue::Text(s) => we::ConflictValue::Text(Text::Inline(s.clone())),
        cp::ConflictValue::Blob(b) => we::ConflictValue::Blob(wblob(b)),
        cp::ConflictValue::Attachment(_) => return Err(ConvertError::AttachmentUnsupported),
        cp::ConflictValue::UnindexedMarkdown(_) => {
            return Err(ConvertError::UnindexedMarkdownUnsupported);
        }
        cp::ConflictValue::Deleted => we::ConflictValue::Deleted,
    })
}

/// Core conflict to wire (texts inline).
///
/// A side holding [`cp::ConflictValue::Attachment`] has no legacy wire form and
/// is refused with [`ConvertError::AttachmentUnsupported`]; see
/// [`wattachment_conflict_value`]. A side holding
/// [`cp::ConflictValue::UnindexedMarkdown`] is refused with
/// [`ConvertError::UnindexedMarkdownUnsupported`]; see
/// [`wunindexed_markdown_conflict_value`].
pub fn wconflict(c: &cp::RecordedConflict) -> CResult<we::Conflict> {
    Ok(we::Conflict {
        kind: wconflict_kind(c.kind),
        id: wuuid(&c.id),
        field: c.field.clone(),
        base: c.base.as_ref().map(wconflict_value).transpose()?,
        kept: wconflict_value(&c.kept)?,
        lost: wconflict_value(&c.lost)?,
    })
}

fn wconflict_kind(k: cp::ConflictKind) -> we::ConflictKind {
    match k {
        cp::ConflictKind::Field => we::ConflictKind::Field,
        cp::ConflictKind::Frontmatter => we::ConflictKind::Frontmatter,
        cp::ConflictKind::Body => we::ConflictKind::Body,
        cp::ConflictKind::Path => we::ConflictKind::Path,
        cp::ConflictKind::Delete => we::ConflictKind::Delete,
        cp::ConflictKind::File => we::ConflictKind::File,
    }
}

/// Core alias to wire.
pub fn walias(a: &cp::Alias) -> we::Alias {
    we::Alias {
        path: a.path.clone(),
        record: wuuid(&a.id),
    }
}

/// Resolve every text in a wire conflict value to inline form.
pub fn resolve_conflict(c: &we::Conflict, t: TextResolver<'_>) -> CResult<we::Conflict> {
    let rv = |v: &we::ConflictValue| -> CResult<we::ConflictValue> {
        Ok(match v {
            we::ConflictValue::Text(x) => we::ConflictValue::Text(Text::Inline(t(x)?)),
            other => other.clone(),
        })
    };
    Ok(we::Conflict {
        kind: c.kind,
        id: c.id,
        field: c.field.clone(),
        base: c.base.as_ref().map(rv).transpose()?,
        kept: rv(&c.kept)?,
        lost: rv(&c.lost)?,
    })
}

/// Resolve every text in a wire effect to inline form.
pub fn resolve_effect(e: &we::Effect, t: TextResolver<'_>) -> CResult<we::Effect> {
    weffect(&effect(e, t)?)
}
