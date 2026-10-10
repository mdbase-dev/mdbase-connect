//! Resource and file operations (`intent.md` §3.6, §3.7).

use std::sync::Arc;

use super::planner::Ctx;
use super::request::invalid;
use super::{ConflictKind, ConflictValue, Effect, RecordedConflict, RejectCode, Rejection};
use crate::ids::{Hash, revision};
use crate::intent::{
    FileAttach, FileContent, FileDelete, FileKind, FileMove, FilePut, MediaClass, Mutation, Op,
    OrdinaryAttachmentContinuation, OrdinaryFileToRecord, RECORD_SOURCE_CAP_BYTES,
    RecordToUnindexedMarkdown, ResourceDelete, ResourcePut, UnindexedMarkdownPut,
    UnindexedMarkdownToRecord,
};
use crate::paths::{path_key, suffixed};
use crate::state::{Overlay, PathHolder, StateView, Tombstone};
use crate::types::{CONFIG_PATH, Catalog};
use crate::value::Value;

fn conflict(reason: &str, message: impl Into<String>) -> Rejection {
    Rejection::new(RejectCode::Conflict, Some(reason), message)
}

fn check_base(base: Option<Hash>, current: Option<&str>) -> Result<(), Rejection> {
    match (base, current) {
        (Some(b), Some(cur)) if revision(cur) != b => {
            let mut r = conflict("revision", "the resource changed since it was read");
            r.details = Some(Value::string(revision(cur).to_string()));
            Err(r)
        }
        (Some(_), None) => Err(conflict("revision", "the resource does not exist")),
        _ => Ok(()),
    }
}

/// Resource operations resolve against their complete staged registry.
/// Ordinary operations retain their position and current-step catalog checks.
/// Both registries classify paths, including schemas retired by the final lock.
pub(super) struct ResourceBatch {
    before: Arc<Catalog>,
    after: Arc<Catalog>,
}

impl ResourceBatch {
    fn is_resource_path(&self, path: &str) -> bool {
        self.before.is_resource_path(path) || self.after.is_resource_path(path)
    }
}

pub(super) fn stage_resource_batch(m: &Mutation, state: &dyn StateView) -> Option<ResourceBatch> {
    if m.ops
        .iter()
        .filter(|op| matches!(op, Op::ResourcePut(_) | Op::ResourceDelete(_)))
        .take(2)
        .count()
        < 2
    {
        return None;
    }
    let mut staged = Overlay::new(state);
    for op in &m.ops {
        match op {
            Op::ResourcePut(r) => staged.apply_effect(&Effect::PutResource {
                path: r.path.clone(),
                doc: r.doc.clone(),
            }),
            Op::ResourceDelete(r) => staged.apply_effect(&Effect::RemoveResource {
                path: r.path.clone(),
            }),
            _ => continue,
        }
    }
    Some(ResourceBatch {
        before: state.catalog(),
        after: staged.catalog(),
    })
}

/// Whether the resource write left the catalog loadable, and the issues it
/// introduced for this path or through a changed schema's references.
fn check_catalog(ov: &Overlay<'_>, path: &str, before: Option<&Catalog>) -> Result<(), Rejection> {
    let catalog = ov.catalog();
    let bad: Vec<crate::validate::Issue> = catalog
        .issues()
        .iter()
        .filter(|i| {
            i.severity == crate::validate::Severity::Error
                && (i.location.as_deref() == Some(path)
                    || i.location.as_deref() == Some(CONFIG_PATH)
                    || before.is_some_and(|c| !c.issues().contains(i)))
        })
        .cloned()
        .collect();
    if !catalog.is_valid() || !bad.is_empty() {
        let mut r = Rejection::new(
            RejectCode::InvalidRecord,
            None,
            format!("`{path}` would leave the configuration or a type invalid"),
        );
        r.issues = bad;
        return Err(r);
    }
    Ok(())
}

/// `base_revision`, resolved in resurrection mode: the acknowledged write is
/// applied and the stale base reported.
fn resolve_base(
    ctx: &mut Ctx<'_>,
    base: Option<Hash>,
    current: Option<&str>,
) -> Result<(), Rejection> {
    match check_base(base, current) {
        Err(r) if ctx.resurrect() => {
            ctx.merged = true;
            ctx.note(
                crate::ids::Uuid::NIL,
                "concurrent_modification",
                r.message,
                r.details,
            );
            Ok(())
        }
        other => other,
    }
}

/// Catalog validity after a resource write; reported, not rejected, in
/// resurrection mode.
fn resolve_catalog(
    ctx: &mut Ctx<'_>,
    ov: &Overlay<'_>,
    path: &str,
    before: Option<&Catalog>,
) -> Result<(), Rejection> {
    match check_catalog(ov, path, before) {
        Err(r) if ctx.resurrect() => {
            for issue in r.issues {
                ctx.issues.push(super::RecordIssue {
                    id: crate::ids::Uuid::NIL,
                    issue,
                });
            }
            Ok(())
        }
        other => other,
    }
}

pub(super) fn validate_resource_batch(
    ctx: &mut Ctx<'_>,
    ov: &Overlay<'_>,
    batch: &ResourceBatch,
) -> Result<(), Rejection> {
    if ctx.api() {
        let mutation = ctx.m;
        for (index, op) in mutation.ops.iter().enumerate() {
            let path = match op {
                Op::ResourcePut(r) => &r.path,
                Op::ResourceDelete(r) => &r.path,
                _ => continue,
            };
            ctx.op = u32::try_from(index).unwrap_or(u32::MAX);
            resolve_catalog(ctx, ov, path, Some(&batch.before))?;
        }
    }
    Ok(())
}

pub(super) fn resource_put(
    ctx: &mut Ctx<'_>,
    ov: &mut Overlay<'_>,
    r: &ResourcePut,
    batch: Option<&ResourceBatch>,
) -> Result<(), Rejection> {
    let catalog = ov.catalog();
    if !batch.map_or_else(
        || catalog.is_resource_path(&r.path),
        |b| b.is_resource_path(&r.path),
    ) {
        return Err(invalid(
            "not_a_resource_path",
            format!("`{}` is not a resource path", r.path),
        ));
    }
    let current = ov.resource(&r.path);
    resolve_base(ctx, r.base_revision, current.as_deref())?;
    if r.must_not_exist
        && let Some(cur) = &current
    {
        let mut rej = conflict(
            "path_taken",
            format!("a resource already exists at `{}`", r.path),
        );
        rej.details = Some(Value::string(revision(cur).to_string()));
        if !ctx.resurrect() {
            return Err(rej);
        }
        // This create was acknowledged before the lost tail. Restore its
        // resource bytes and report the now-stale create-only precondition;
        // it must not fall through the generic resurrect_skipped safety net.
        ctx.merged = true;
        ctx.note(
            crate::ids::Uuid::NIL,
            "concurrent_modification",
            rej.message,
            rej.details,
        );
    }
    ctx.ends_batch = true;
    if current.as_deref() == Some(r.doc.as_str()) {
        return Ok(());
    }
    ctx.emit(
        ov,
        Effect::PutResource {
            path: r.path.clone(),
            doc: r.doc.clone(),
        },
    );
    if ctx.api() && batch.is_none() {
        resolve_catalog(ctx, ov, &r.path, Some(&catalog))?;
    }
    Ok(())
}

pub(super) fn resource_delete(
    ctx: &mut Ctx<'_>,
    ov: &mut Overlay<'_>,
    r: &ResourceDelete,
    batch: Option<&ResourceBatch>,
) -> Result<(), Rejection> {
    let catalog = ov.catalog();
    if !batch.map_or_else(
        || catalog.is_resource_path(&r.path),
        |b| b.is_resource_path(&r.path),
    ) {
        return Err(invalid(
            "not_a_resource_path",
            format!("`{}` is not a resource path", r.path),
        ));
    }
    let current = ov.resource(&r.path);
    resolve_base(ctx, r.base_revision, current.as_deref())?;
    ctx.ends_batch = true;
    if current.is_none() {
        return Ok(());
    }
    ctx.emit(
        ov,
        Effect::RemoveResource {
            path: r.path.clone(),
        },
    );
    if ctx.api() && batch.is_none() {
        resolve_catalog(ctx, ov, &r.path, Some(&catalog))?;
    }
    Ok(())
}

/// The media class of a file path, by extension.
pub fn media_class(path: &str) -> MediaClass {
    let ext = path
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "avif" | "heic" | "tif"
        | "tiff" => MediaClass::Image,
        "mp3" | "wav" | "m4a" | "ogg" | "flac" | "aac" | "opus" | "webm_audio" => MediaClass::Audio,
        "mp4" | "mov" | "mkv" | "webm" | "avi" | "m4v" | "ogv" => MediaClass::Video,
        "pdf" => MediaClass::Pdf,
        _ => MediaClass::Other,
    }
}

/// Whether the inclusion policy excludes a file.
fn excluded(ov: &Overlay<'_>, path: &str, size: u64) -> bool {
    let s = ov.settings();
    let key = path_key(path);
    !s.include.contains(&media_class(path))
        || s.max_size.is_some_and(|m| size > m)
        || s.exclude.iter().any(|folder| {
            let f = path_key(folder.trim_end_matches('/'));
            key.starts_with(&format!("{f}/"))
        })
}

/// A file path must be eligible: safe, not a record or resource path.
fn check_file_path(ov: &Overlay<'_>, path: &str) -> Result<(), Rejection> {
    let catalog = ov.catalog();
    if catalog.is_record_path(path) || catalog.is_resource_path(path) || catalog.is_excluded(path) {
        return Err(invalid(
            "not_a_file_path",
            format!("`{path}` is a record or resource path, or excluded"),
        ));
    }
    Ok(())
}

fn free_path(ov: &Overlay<'_>, path: &str, own: crate::ids::Uuid) -> bool {
    match ov.at_path_key(&path_key(path)) {
        None => true,
        Some(PathHolder::File(id)) => id == own,
        Some(PathHolder::Record(_)) => false,
    }
}

fn allocate(ov: &Overlay<'_>, path: &str, own: crate::ids::Uuid) -> String {
    if free_path(ov, path, own) {
        return path.to_owned();
    }
    let mut n = 2u64;
    loop {
        let p = suffixed(path, n);
        if free_path(ov, &p, own) {
            return p;
        }
        n += 1;
    }
}

pub(super) fn file_put(
    ctx: &mut Ctx<'_>,
    ov: &mut Overlay<'_>,
    f: &FilePut,
) -> Result<(), Rejection> {
    put_file(
        ctx,
        ov,
        FileWrite {
            id: f.id,
            path: &f.path,
            content: FileContent::Blob(f.blob),
            if_revision: f.if_revision,
            base: f.base,
        },
    )
}

pub(super) fn file_attach(
    ctx: &mut Ctx<'_>,
    ov: &mut Overlay<'_>,
    f: &FileAttach,
) -> Result<(), Rejection> {
    put_file(
        ctx,
        ov,
        FileWrite {
            id: f.id,
            path: &f.path,
            content: FileContent::AttachmentV1(f.content),
            if_revision: f.if_revision,
            base: f.base,
        },
    )
}

/// Critical Ordinary continuation: exact live identity/path/kind and complete
/// descriptor CAS even at Resurrect. Drift preserves acknowledged new content
/// as a conflict, never silently skips it or recreates/converts/moves a holder.
pub(super) fn ordinary_attachment_continuation(
    ctx: &mut Ctx<'_>,
    ov: &mut Overlay<'_>,
    f: &OrdinaryAttachmentContinuation,
) -> Result<(), Rejection> {
    ctx.touch_id(f.id);
    let api_excluded = ctx.api()
        && (ov.catalog().is_excluded(&f.path)
            || excluded(ov, &f.path, f.content.total_plain_bytes));
    let path_allowed = check_unindexed_markdown_path(ov, &f.path).is_ok() && !api_excluded;
    let record = ov.record(&f.id);
    let current = ov.file(&f.id);
    let exact = record.is_none()
        && path_allowed
        && current.as_ref().is_some_and(|cur| {
            cur.kind == FileKind::Ordinary
                && cur.path == f.path
                && cur.content == f.prior
                && free_path(ov, &f.path, f.id)
        });
    if !exact {
        if !ctx.resurrect() {
            if api_excluded {
                return Err(invalid(
                    "excluded",
                    format!("`{}` is excluded from sync", f.path),
                ));
            }
            if !path_allowed {
                check_unindexed_markdown_path(ov, &f.path)?;
            }
            return Err(conflict(
                "ordinary_attachment_holder_changed",
                "continuation requires the same Ordinary holder, exact path and full prior content",
            ));
        }
        let kept = if let Some(record) = record {
            ConflictValue::Text(record.source.to_string())
        } else if let Some(current) = current {
            file_conflict_kind(current.content, current.kind)
        } else {
            ConflictValue::Deleted
        };
        ctx.conflicts.push(RecordedConflict {
            kind: ConflictKind::File,
            id: f.id,
            field: None,
            base: Some(file_conflict(f.prior)),
            kept,
            lost: ConflictValue::Attachment(f.content),
        });
        return Ok(());
    }
    ctx.touch_path(&f.path);
    ctx.emit(
        ov,
        Effect::PutAttachmentFile {
            id: f.id,
            path: f.path.clone(),
            content: f.content,
        },
    );
    Ok(())
}

struct FileWrite<'a> {
    id: crate::ids::FileId,
    path: &'a str,
    content: FileContent,
    if_revision: Option<Hash>,
    base: Option<Hash>,
}

fn file_effect(id: crate::ids::FileId, path: String, content: FileContent) -> Effect {
    match content {
        FileContent::Blob(blob) => Effect::PutFile { id, path, blob },
        FileContent::AttachmentV1(content) => Effect::PutAttachmentFile { id, path, content },
    }
}

/// The effect that stores `content` with `kind` at `path`; the kind never changes
/// implicitly (`intent.md` §3.10).
fn file_effect_kind(
    id: crate::ids::FileId,
    path: String,
    content: FileContent,
    kind: FileKind,
) -> Effect {
    match kind {
        FileKind::Ordinary => file_effect(id, path, content),
        FileKind::UnindexedOversizedMarkdown => Effect::PutUnindexedMarkdown { id, path, content },
    }
}

fn file_conflict(content: FileContent) -> ConflictValue {
    match content {
        FileContent::Blob(blob) => ConflictValue::Blob(blob),
        FileContent::AttachmentV1(content) => ConflictValue::Attachment(content),
    }
}

fn file_conflict_kind(content: FileContent, kind: FileKind) -> ConflictValue {
    match kind {
        FileKind::Ordinary => file_conflict(content),
        FileKind::UnindexedOversizedMarkdown => ConflictValue::UnindexedMarkdown(content),
    }
}

/// A path at which an unindexed oversized Markdown file may live: classified as
/// a record path by the captured catalogue, not a resource or excluded path.
fn check_unindexed_markdown_path(ov: &Overlay<'_>, path: &str) -> Result<(), Rejection> {
    let catalog = ov.catalog();
    if !catalog.is_record_path(path) || catalog.is_resource_path(path) || catalog.is_excluded(path)
    {
        return Err(invalid(
            "not_a_record_path",
            format!("`{path}` is not a record-extension path"),
        ));
    }
    Ok(())
}

/// The kind's size invariant: declared plaintext strictly above the record cap.
/// Exactly the cap remains a record candidate. Declared size is not proof.
fn check_oversized(content: FileContent) -> Result<(), Rejection> {
    if content.size() <= RECORD_SOURCE_CAP_BYTES {
        return Err(invalid(
            "not_oversized",
            format!(
                "{} bytes do not exceed the {RECORD_SOURCE_CAP_BYTES}-byte record cap",
                content.size()
            ),
        ));
    }
    Ok(())
}

/// `unindexed_markdown_put` (`intent.md` §3.10).
pub(super) fn unindexed_markdown_put(
    ctx: &mut Ctx<'_>,
    ov: &mut Overlay<'_>,
    f: &UnindexedMarkdownPut,
) -> Result<(), Rejection> {
    ctx.touch_id(f.id);
    check_unindexed_markdown_path(ov, &f.path)?;
    check_oversized(f.content)?;
    if let Some(cur) = ov.record(&f.id) {
        if ctx.resurrect() {
            ctx.conflicts.push(RecordedConflict {
                kind: ConflictKind::File,
                id: f.id,
                field: None,
                base: None,
                kept: ConflictValue::Text(cur.source.to_string()),
                lost: ConflictValue::UnindexedMarkdown(f.content),
            });
            return Ok(());
        }
        return Err(invalid(
            "id_is_record",
            format!(
                "{} is a live record; use record_to_unindexed_markdown",
                f.id
            ),
        ));
    }
    if ctx.api() && excluded(ov, &f.path, f.content.size()) {
        return Err(invalid(
            "excluded",
            format!("`{}` is excluded from sync", f.path),
        ));
    }
    match ov.file(&f.id) {
        None => {
            if ctx.resurrect()
                && ov.tombstone(&f.id).is_some_and(|t| {
                    !matches!(
                        t,
                        crate::state::Tombstone::File {
                            kind: FileKind::UnindexedOversizedMarkdown,
                            ..
                        }
                    )
                })
            {
                ctx.conflicts.push(RecordedConflict {
                    kind: ConflictKind::File,
                    id: f.id,
                    field: None,
                    base: None,
                    kept: ConflictValue::Deleted,
                    lost: ConflictValue::UnindexedMarkdown(f.content),
                });
                return Ok(());
            }
            if f.expected.is_some() {
                if !ctx.resurrect() {
                    return Err(conflict("revision", "the file no longer exists"));
                }
                ctx.conflicts.push(RecordedConflict {
                    kind: ConflictKind::File,
                    id: f.id,
                    field: None,
                    base: None,
                    kept: ConflictValue::Deleted,
                    lost: ConflictValue::UnindexedMarkdown(f.content),
                });
                return Ok(());
            }
            let path = if free_path(ov, &f.path, f.id) {
                f.path.clone()
            } else if !ctx.resurrect() {
                return Err(conflict("path_taken", format!("`{}` is taken", f.path)));
            } else {
                let p = allocate(ov, &f.path, f.id);
                ctx.merged = true;
                ctx.note(
                    f.id,
                    "record_renamed",
                    format!("`{}` is taken; the restored file is at `{p}`", f.path),
                    None,
                );
                p
            };
            if ov.tombstone(&f.id).is_some() {
                ctx.merged = true;
            }
            ctx.touch_path(&path);
            ctx.emit(
                ov,
                Effect::PutUnindexedMarkdown {
                    id: f.id,
                    path,
                    content: f.content,
                },
            );
        }
        Some(cur) => {
            if cur.kind != FileKind::UnindexedOversizedMarkdown {
                if ctx.resurrect() {
                    ctx.conflicts.push(RecordedConflict {
                        kind: ConflictKind::File,
                        id: f.id,
                        field: None,
                        base: None,
                        kept: file_conflict(cur.content),
                        lost: ConflictValue::UnindexedMarkdown(f.content),
                    });
                    return Ok(());
                }
                return Err(invalid(
                    "kind_mismatch",
                    format!("{} is an ordinary file, not unindexed Markdown", f.id),
                ));
            }
            if cur.path != f.path && !ctx.resurrect() {
                return Err(invalid(
                    "invalid_request",
                    "a replace must name the file's current path",
                ));
            }
            if f.expected != Some(cur.content) {
                if !ctx.resurrect() {
                    return Err(conflict("revision", "the file changed since it was read"));
                }
                if cur.content != f.content {
                    ctx.conflicts.push(RecordedConflict {
                        kind: ConflictKind::File,
                        id: f.id,
                        field: None,
                        base: None,
                        kept: ConflictValue::UnindexedMarkdown(cur.content),
                        lost: ConflictValue::UnindexedMarkdown(f.content),
                    });
                }
                return Ok(());
            }
            if cur.content == f.content {
                return Ok(());
            }
            ctx.emit(
                ov,
                Effect::PutUnindexedMarkdown {
                    id: f.id,
                    path: cur.path,
                    content: f.content,
                },
            );
        }
    }
    Ok(())
}

/// `record_to_unindexed_markdown` (`intent.md` §3.10): one atomic holder/index
/// transition, never RemoveRecord + a file put.
pub(super) fn record_to_unindexed_markdown(
    ctx: &mut Ctx<'_>,
    ov: &mut Overlay<'_>,
    f: &RecordToUnindexedMarkdown,
) -> Result<(), Rejection> {
    ctx.touch_id(f.id);
    if ctx.resurrect() {
        ctx.note(
            f.id,
            "unindexed_kind_transition_requires_capture",
            "kind transition is not resurrected; capture against the current holder",
            None,
        );
        ctx.merged = true;
        return Ok(());
    }
    check_unindexed_markdown_path(ov, &f.path)?;
    check_oversized(f.content)?;
    let Some(cur) = ov.record(&f.id) else {
        return Err(Rejection::new(
            RejectCode::NotFound,
            None,
            format!("no live record {}", f.id),
        ));
    };
    if cur.path != f.path {
        return Err(invalid(
            "invalid_request",
            format!("the record is at `{}`, not `{}`", cur.path, f.path),
        ));
    }
    if revision(&cur.source) != f.prior_revision {
        if !ctx.resurrect() {
            return Err(conflict("revision", "the record changed since it was read"));
        }
        ctx.conflicts.push(RecordedConflict {
            kind: ConflictKind::File,
            id: f.id,
            field: None,
            base: None,
            kept: ConflictValue::Text(cur.source.to_string()),
            lost: ConflictValue::UnindexedMarkdown(f.content),
        });
        return Ok(());
    }
    let before = ctx.incoming(ov, f.id);
    ctx.emit(
        ov,
        Effect::PutUnindexedMarkdown {
            id: f.id,
            path: cur.path,
            content: f.content,
        },
    );
    ctx.record_broken(ov, f.id, before);
    Ok(())
}

/// `unindexed_markdown_to_record` (`intent.md` §3.10): the reverse atomic
/// transition. Bounded frontmatter admission is the host's preflight; the plan
/// enforces the cap, parseability and ordinary record admission.
pub(super) fn unindexed_markdown_to_record(
    ctx: &mut Ctx<'_>,
    ov: &mut Overlay<'_>,
    f: &UnindexedMarkdownToRecord,
) -> Result<(), Rejection> {
    ctx.touch_id(f.id);
    if ctx.resurrect() {
        ctx.note(
            f.id,
            "unindexed_kind_transition_requires_capture",
            "kind transition is not resurrected; capture against the current holder",
            None,
        );
        ctx.merged = true;
        return Ok(());
    }
    let Some(cur) = ov.file(&f.id) else {
        return Err(Rejection::new(
            RejectCode::NotFound,
            None,
            format!("no live file {}", f.id),
        ));
    };
    if cur.kind != FileKind::UnindexedOversizedMarkdown {
        return Err(invalid(
            "kind_mismatch",
            format!("{} is an ordinary file, not unindexed Markdown", f.id),
        ));
    }
    if cur.path != f.path {
        return Err(invalid(
            "invalid_request",
            format!("the file is at `{}`, not `{}`", cur.path, f.path),
        ));
    }
    if cur.content != f.prior {
        if !ctx.resurrect() {
            return Err(conflict("revision", "the file changed since it was read"));
        }
        ctx.conflicts.push(RecordedConflict {
            kind: ConflictKind::File,
            id: f.id,
            field: None,
            base: None,
            kept: ConflictValue::UnindexedMarkdown(cur.content),
            lost: ConflictValue::Text(f.doc.clone()),
        });
        return Ok(());
    }
    if u64::try_from(f.doc.len()).unwrap_or(u64::MAX) > RECORD_SOURCE_CAP_BYTES {
        return Err(Rejection::new(
            RejectCode::TooLarge,
            Some("record_too_large"),
            format!(
                "{} bytes exceed the {RECORD_SOURCE_CAP_BYTES}-byte record cap",
                f.doc.len()
            ),
        ));
    }
    super::records::reindex_unindexed(ctx, ov, f.id, &cur.path, f.doc.clone())
}

/// Op17 is a closed trusted setup/capture transition. Unlike a normal replace,
/// a same-plaintext reseal is NOT a no-op: full descriptor equality is required.
pub(super) fn ordinary_file_to_record(
    ctx: &mut Ctx<'_>,
    ov: &mut Overlay<'_>,
    f: &OrdinaryFileToRecord,
) -> Result<(), Rejection> {
    ctx.touch_id(f.id);
    if ctx.stage == super::Stage::Resurrect {
        ctx.note(
            f.id,
            "ordinary_file_promotion_requires_setup",
            "ordinary promotion is not resurrected; re-apply setup against the current file",
            None,
        );
        ctx.merged = true;
        return Ok(());
    }
    let Some(cur) = ov.file(&f.id) else {
        return Err(Rejection::new(
            RejectCode::NotFound,
            None,
            "promotion requires a live Ordinary file",
        ));
    };
    if ov.record(&f.id).is_some() || ov.tombstone(&f.id).is_some() {
        return Err(invalid(
            "kind_mismatch",
            "promotion requires a sole live Ordinary holder",
        ));
    }
    if cur.kind != FileKind::Ordinary {
        return Err(invalid(
            "kind_mismatch",
            "promotion requires an Ordinary file",
        ));
    }
    if cur.path != f.path {
        return Err(conflict("revision", "the file moved since assessment"));
    }
    if cur.content != f.prior {
        return Err(conflict(
            "revision",
            "the file descriptor changed since assessment",
        ));
    }
    if ov.at_path_key(&path_key(&cur.path)) != Some(PathHolder::File(f.id)) {
        return Err(invalid(
            "kind_mismatch",
            "promotion requires the current file path holder",
        ));
    }
    let catalog = ov.catalog();
    if !catalog.is_record_path(&f.path) {
        return Err(invalid(
            "not_a_record_path",
            "promotion path must be an admitted record path",
        ));
    }
    let size = u64::try_from(f.doc.len()).unwrap_or(u64::MAX);
    if size > RECORD_SOURCE_CAP_BYTES {
        return Err(Rejection::new(
            RejectCode::TooLarge,
            Some("record_too_large"),
            "promotion source exceeds the synced record cap",
        ));
    }
    if size != f.prior.size() || revision(&f.doc) != f.prior.plain_hash() {
        return Err(invalid(
            "promotion_source_mismatch",
            "promotion source does not match the captured plaintext",
        ));
    }
    super::records::reindex_ordinary(ctx, ov, f.id, &cur.path, &f.doc)
}

fn same_file_version(current: FileContent, incoming: FileContent) -> bool {
    match (current, incoming) {
        // Preserve legacy same-plaintext no-op. Attachments additionally bind the
        // immutable context/manifest: rekey/reseal cannot disappear as a no-op.
        (FileContent::Blob(a), FileContent::Blob(b)) => a.plain_hash == b.plain_hash,
        _ => current == incoming,
    }
}

fn put_file(ctx: &mut Ctx<'_>, ov: &mut Overlay<'_>, f: FileWrite<'_>) -> Result<(), Rejection> {
    ctx.touch_id(f.id);
    check_file_path(ov, f.path)?;
    if ctx.api() && excluded(ov, f.path, f.content.size()) {
        return Err(invalid(
            "excluded",
            format!("`{}` is excluded from sync", f.path),
        ));
    }
    match ov.file(&f.id) {
        None => {
            let path = if free_path(ov, f.path, f.id) {
                f.path.to_owned()
            } else if ctx.api() && !ctx.resurrect() {
                return Err(conflict("path_taken", format!("`{}` is taken", f.path)));
            } else {
                let p = allocate(ov, f.path, f.id);
                if ctx.resurrect() {
                    ctx.merged = true;
                    ctx.note(
                        f.id,
                        "record_renamed",
                        format!("`{}` is taken; the restored file is at `{p}`", f.path),
                        None,
                    );
                }
                p
            };
            if ov.tombstone(&f.id).is_some() {
                ctx.merged = true;
            }
            ctx.touch_path(&path);
            ctx.emit(ov, file_effect(f.id, path, f.content));
        }
        Some(cur) => {
            if cur.kind != FileKind::Ordinary {
                return Err(invalid(
                    "kind_mismatch",
                    format!("{} is unindexed Markdown; use unindexed_markdown_put", f.id),
                ));
            }
            if let Some(want) = f.if_revision
                && cur.content.plain_hash() != want
            {
                if !ctx.resurrect() {
                    return Err(conflict("revision", "the file changed since it was read"));
                }
                if !same_file_version(cur.content, f.content) {
                    ctx.conflicts.push(RecordedConflict {
                        kind: ConflictKind::File,
                        id: f.id,
                        field: None,
                        base: None,
                        kept: file_conflict(cur.content),
                        lost: file_conflict(f.content),
                    });
                }
                return Ok(());
            }
            if cur.path != f.path && !ctx.resurrect() {
                return Err(invalid(
                    "invalid_request",
                    "a replace must name the file's current path",
                ));
            }
            if same_file_version(cur.content, f.content) {
                return Ok(());
            }
            if let Some(base) = f.base
                && cur.content.plain_hash() != base
            {
                ctx.conflicts.push(RecordedConflict {
                    kind: ConflictKind::File,
                    id: f.id,
                    field: None,
                    base: None,
                    kept: file_conflict(cur.content),
                    lost: file_conflict(f.content),
                });
                return Ok(());
            }
            ctx.emit(ov, file_effect(f.id, cur.path, f.content));
        }
    }
    Ok(())
}

pub(super) fn file_delete(
    ctx: &mut Ctx<'_>,
    ov: &mut Overlay<'_>,
    f: &FileDelete,
) -> Result<(), Rejection> {
    ctx.touch_id(f.id);
    let Some(cur) = ov.file(&f.id) else {
        return Ok(());
    };
    let stale = f
        .if_revision
        .is_some_and(|want| cur.content.plain_hash() != want);
    if stale && !ctx.resurrect() {
        return Err(conflict("revision", "the file changed since it was read"));
    }
    if stale || f.base.is_some_and(|base| cur.content.plain_hash() != base) {
        ctx.conflicts.push(RecordedConflict {
            kind: ConflictKind::Delete,
            id: f.id,
            field: None,
            base: None,
            kept: file_conflict_kind(cur.content, cur.kind),
            lost: ConflictValue::Deleted,
        });
        return Ok(());
    }
    let before = ctx.incoming(ov, f.id);
    ctx.emit(
        ov,
        Effect::RemoveFile {
            id: f.id,
            path: cur.path,
        },
    );
    ctx.record_broken(ov, f.id, before);
    Ok(())
}

pub(super) fn file_move(
    ctx: &mut Ctx<'_>,
    ov: &mut Overlay<'_>,
    f: &FileMove,
) -> Result<(), Rejection> {
    ctx.touch_id(f.id);
    let Some(cur) = ov.file(&f.id) else {
        return match ov.tombstone(&f.id) {
            Some(Tombstone::File { .. }) if !ctx.api() => Ok(()),
            _ => Err(Rejection::new(
                RejectCode::NotFound,
                None,
                format!("no file {}", f.id),
            )),
        };
    };
    if let Some(want) = f.if_revision
        && cur.content.plain_hash() != want
        && !ctx.resurrect()
    {
        return Err(conflict("revision", "the file changed since it was read"));
    }
    // An external move of a stale path: the later move wins (and in
    // resurrection mode too).
    if cur.path != f.from && ctx.api() && !ctx.resurrect() {
        return Err(conflict(
            "renamed",
            format!("the file is at `{}`", cur.path),
        ));
    }
    match cur.kind {
        FileKind::Ordinary => check_file_path(ov, &f.to)?,
        // The kind travels with the file; leaving record paths needs an explicit
        // conversion to Ordinary, never a silent reinterpretation.
        FileKind::UnindexedOversizedMarkdown => check_unindexed_markdown_path(ov, &f.to)?,
    }
    let to = if free_path(ov, &f.to, f.id) {
        f.to.clone()
    } else if ctx.api() && !ctx.resurrect() {
        return Err(conflict("path_taken", format!("`{}` is taken", f.to)));
    } else {
        let p = allocate(ov, &f.to, f.id);
        if ctx.resurrect() {
            ctx.merged = true;
            ctx.note(
                f.id,
                "record_renamed",
                format!("`{}` is taken; the restored file is at `{p}`", f.to),
                None,
            );
        }
        p
    };
    let updates = if f.update_refs {
        let mut post = Overlay::new(ov);
        post.apply_effect(&file_effect_kind(f.id, to.clone(), cur.content, cur.kind));
        crate::links::plan_reference_updates(ov, &post, f.id, &to)
    } else {
        Vec::new()
    };
    ctx.touch_path(&cur.path);
    ctx.touch_path(&to);
    let before = ctx.incoming(ov, f.id);
    ctx.record_rewrites(&updates);
    ctx.emit(ov, file_effect_kind(f.id, to, cur.content, cur.kind));
    for u in updates {
        ctx.touch_id(u.id);
        ctx.emit(
            ov,
            Effect::PutRecord {
                id: u.id,
                path: u.path,
                doc: u.doc,
            },
        );
    }
    ctx.record_broken(ov, f.id, before);
    Ok(())
}
