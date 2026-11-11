//! Record operations: `create`, `update`, `document`, `delete`, `rename`
//! (`intent.md` §3.1–§3.5, spec 12, 12A).

use super::planner::Ctx;
use super::request::{check_path, invalid};
use super::{
    ConflictKind, ConflictValue, Effect, RecordIssue, RecordedConflict, RejectCode, Rejection,
};
use crate::doc::{Document, LineEnding, RecordFormat};
use crate::ids::{Hash, RecordId, revision};
use crate::intent::{Create, Delete, DocumentOp, Level, Rename, Update};
use crate::lifecycle::{self, LifecycleContext};
use crate::merge::{self, BodyBase, Version};
use crate::paths::{derive_path, path_key, suffixed};
use crate::state::{Overlay, PathHolder, StateView, StoredRecord, Tombstone};
use crate::types::{Catalog, Enforce, LifecycleEvent};
use crate::validate::{self, Severity, Tier};
use crate::value::{Map, Value};
use crate::writer::{self, Change};

fn conflict(reason: &str, message: impl Into<String>) -> Rejection {
    Rejection::new(RejectCode::Conflict, Some(reason), message)
}

fn details(pairs: &[(&str, Value)]) -> Option<Value> {
    Some(Value::Map(
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), v.clone()))
            .collect(),
    ))
}

fn frontmatter_problem(doc: &Document) -> Rejection {
    let reason = doc.problem().map_or("invalid_frontmatter", |p| p.reason());
    let mut r = invalid(
        "invalid_frontmatter",
        "the record's frontmatter is not a mapping; a structured update cannot change it",
    );
    r.details = details(&[("reason", Value::string(reason))]);
    r
}

fn write_err(e: &writer::WriteError) -> Rejection {
    match e {
        writer::WriteError::InvalidFrontmatter(reason) => {
            let mut r = invalid("invalid_frontmatter", e.to_string());
            r.details = details(&[("reason", Value::string(*reason))]);
            r
        }
        writer::WriteError::BodyOnYamlDocument => invalid("invalid_request", e.to_string()),
        writer::WriteError::Emit(_) => invalid("invalid_request", e.to_string()),
    }
}

fn rewrite(
    path: &str,
    src: &str,
    changes: &[(String, Change)],
    body: Option<&str>,
) -> Result<String, Rejection> {
    if changes.is_empty() && body.is_none() {
        return Ok(src.to_owned());
    }
    let doc = Document::parse_at(path, src);
    writer::write(&doc, changes, body).map_err(|e| write_err(&e))
}

/// The first free path for `requested` under the collision rule (spec 02),
/// ignoring the record `own` itself.
fn allocate(ov: &Overlay<'_>, requested: &str, own: Option<RecordId>) -> String {
    let free = |p: &str| match ov.at_path_key(&path_key(p)) {
        None => true,
        Some(PathHolder::Record(id)) => Some(id) == own,
        Some(PathHolder::File(_)) => false,
    };
    if free(requested) {
        return requested.to_owned();
    }
    let mut n = 2u64;
    loop {
        let candidate = suffixed(requested, n);
        if free(&candidate) {
            return candidate;
        }
        n += 1;
    }
}

fn path_error(e: crate::paths::PathPatternError) -> Rejection {
    let mut r = invalid(e.code(), "cannot encode a path value");
    if let Some(field) = e.field() {
        r.details = details(&[("field", Value::string(field))]);
    }
    r
}

/// Include lifecycle changes, but never mark untouched decoded values as writes.
fn mark_changed(written: &mut Map, from: &Map, to: &Map) {
    for field in from.keys().chain(to.keys()) {
        if from.get(field) != to.get(field) {
            written.insert(field, to.get(field).cloned().unwrap_or(Value::Null));
        }
    }
}

fn has_stored_fields(catalog: &Catalog, types: &[String]) -> bool {
    types
        .iter()
        .filter_map(|n| catalog.type_named(n))
        .filter_map(|t| t.path_policy.as_ref())
        .any(|p| !p.fields.is_empty())
}
/// A path-stored value that normalization changed: the field, the value as
/// it was written, and the value that is stored (spec 07).
type NormalizedValue = (String, Value, Value);

/// Normalize the path-stored values in `written`, returning the ones that
/// changed.
fn normalize_path_values(
    catalog: &Catalog,
    types: &[String],
    values: &mut Map,
    written: &Map,
) -> Result<Vec<NormalizedValue>, Rejection> {
    let mut changed = Vec::new();
    for p in types
        .iter()
        .filter_map(|n| catalog.type_named(n))
        .filter_map(|t| t.path_policy.as_ref())
    {
        let mut assigned = p.clone();
        assigned.fields.retain(|f| written.contains_key(f));
        let before: Vec<Option<Value>> = assigned
            .fields
            .iter()
            .map(|f| values.get(f).cloned())
            .collect();
        assigned.normalize(values).map_err(path_error)?;
        for (field, before) in assigned.fields.iter().zip(before) {
            if let (Some(before), Some(stored)) = (before, values.get(field))
                && before != *stored
            {
                changed.push((field.clone(), before, stored.clone()));
            }
        }
    }
    Ok(changed)
}

/// Report each value an `api` write set and normalization changed, as a
/// `path_value_normalized` warning of the operation (spec 07). It is not a
/// validation issue, so it does not follow the validation level.
fn warn_normalized(ctx: &mut Ctx<'_>, id: RecordId, changed: Vec<NormalizedValue>) {
    if !ctx.api() || ctx.submit_level().is_none() {
        return;
    }
    for (field, written, stored) in changed {
        let mut issue = validate::Issue::new(
            "path_value_normalized",
            Severity::Warning,
            Tier::Request,
            format!("`{field}` is stored in its path-safe form"),
        )
        .at(format!("/{field}"));
        issue.details = details(&[("written", written), ("stored", stored)]);
        ctx.issues.push(RecordIssue { id, issue });
    }
}
pub(super) fn strip_path_fields(catalog: &Catalog, types: &[String], values: &mut Map) {
    for p in types
        .iter()
        .filter_map(|n| catalog.type_named(n))
        .filter_map(|t| t.path_policy.as_ref())
    {
        for f in &p.fields {
            values.remove(f);
        }
    }
}
fn stored_update_path(
    catalog: &Catalog,
    types: &[String],
    path: &str,
    values: &Map,
) -> Result<String, Rejection> {
    let mut target: Option<String> = None;
    for p in types
        .iter()
        .filter_map(|n| catalog.type_named(n))
        .filter_map(|t| t.path_policy.as_ref())
        .filter(|p| !p.fields.is_empty())
    {
        let candidate = p.update_path(path, values).map_err(path_error)?;
        if target.as_ref().is_some_and(|old| old != &candidate) {
            return Err(invalid(
                "type_conflict",
                "types disagree on the stored-field target path",
            ));
        }
        target = Some(candidate);
    }
    Ok(target.unwrap_or_else(|| path.to_owned()))
}
fn check_stored_path(catalog: &Catalog, types: &[String], path: &str) -> Result<(), Rejection> {
    for p in types
        .iter()
        .filter_map(|n| catalog.type_named(n))
        .filter_map(|t| t.path_policy.as_ref())
    {
        let decoded = p.decode(path);
        for f in &p.fields {
            if decoded.as_ref().is_none_or(|d| !d.values.contains_key(f)) {
                return Err(path_error(crate::paths::PathPatternError::Missing {
                    field: f.clone(),
                }));
            }
        }
    }
    let (_, issues) = catalog.record_values_with_issues(path, types, &Map::new());
    if let Some(issue) = issues.into_iter().find(|i| i.code == "type_conflict") {
        let mut r = invalid("type_conflict", issue.message.clone());
        r.issues.push(issue);
        return Err(r);
    }
    Ok(())
}
fn check_written_path(
    catalog: &Catalog,
    types: &[String],
    path: &str,
    values: &Map,
) -> Result<(), Rejection> {
    for policy in types
        .iter()
        .filter_map(|n| catalog.type_named(n))
        .filter_map(|t| t.path_policy.as_ref())
    {
        policy
            .check_written_values(path, values)
            .map_err(path_error)?;
    }
    Ok(())
}

fn check_move_membership(
    ctx: &mut Ctx<'_>,
    catalog: &Catalog,
    types: &[String],
    path: &str,
    raw: &Map,
) -> Result<(), Rejection> {
    let target = types_of(catalog, path, raw, &ctx.m.clock);
    if types.iter().any(|t| !target.contains(t)) {
        if ctx.resurrect() {
            ctx.note(
                crate::ids::Uuid::NIL,
                "type_membership_changed",
                "the move changed type membership",
                None,
            );
        } else {
            return Err(invalid(
                "type_membership_changed",
                "the move changed type membership",
            ));
        }
    }
    Ok(())
}

fn ensure_free(ov: &Overlay<'_>, path: &str, id: RecordId) -> Result<(), Rejection> {
    if ov
        .at_path_key(&path_key(path))
        .is_some_and(|h| h != PathHolder::Record(id))
    {
        return Err(conflict("path_conflict", format!("`{path}` is taken")));
    }
    Ok(())
}

/// Emit a record's edit and move exactly once, then its inbound rewrites.
#[allow(clippy::too_many_arguments)]
fn finalize_move(
    ctx: &mut Ctx<'_>,
    ov: &mut Overlay<'_>,
    id: RecordId,
    from: &str,
    to: &str,
    mut src: String,
    previous: Option<&Map>,
    update_refs: bool,
) -> Result<(), Rejection> {
    if from == to {
        ctx.touch_path(to);
        return finalize(ctx, ov, id, to, src, previous);
    }
    check_path(to)?;
    let catalog = ov.catalog();
    if !catalog.is_record_path(to) || RecordFormat::for_path(from) != RecordFormat::for_path(to) {
        return Err(invalid(
            "not_a_record_path",
            "stored-field move must preserve record format",
        ));
    }
    let allocated;
    let to = if ctx.resurrect() {
        allocated = allocate(ov, to, Some(id));
        if allocated != to {
            relocated(ctx, id, to, &allocated);
        }
        &allocated
    } else {
        ensure_free(ov, to, id)?;
        to
    };
    let updates = if update_refs {
        let mut post = Overlay::new(ov);
        post.apply_effect(&Effect::PutRecord {
            id,
            path: to.to_owned(),
            doc: src.clone(),
        });
        let mut updates = crate::links::plan_reference_updates(ov, &post, id, to);
        prepare_reference_updates(ctx, &post, &mut updates)?;
        updates
    } else {
        Vec::new()
    };
    let before = ctx.incoming(ov, id);
    ctx.record_rewrites(&updates);
    if let Some(own) = updates.iter().find(|u| u.id == id) {
        if own.path != to {
            return Err(invalid(
                "type_conflict",
                "self-reference rewrite disagrees with the assigned path",
            ));
        }
        src.clone_from(&own.doc);
    }
    ctx.touch_path(from);
    ctx.touch_path(to);
    finalize(ctx, ov, id, to, src, previous)?;
    if path_key(from) != path_key(to) {
        ctx.alias(ov, from, id);
    }
    for upd in updates.into_iter().filter(|u| u.id != id) {
        emit_reference_update(ctx, ov, upd);
    }
    ctx.record_broken(ov, id, before);
    Ok(())
}

/// Link rewrites are engine writes too: path-stored link assignments move their
/// referring record and never leak a synthetic field into persisted YAML.
pub(super) fn prepare_reference_updates(
    ctx: &Ctx<'_>,
    post: &Overlay<'_>,
    updates: &mut [crate::links::ReferenceUpdate],
) -> Result<(), Rejection> {
    let catalog = post.catalog();
    let mut occupied = Overlay::new(post);
    for update in updates {
        let Some(before) = post.record(&update.id) else {
            continue;
        };
        let before_doc = Document::parse_at(&before.path, &*before.source);
        let types = types_of(
            &catalog,
            &before.path,
            before_doc.frontmatter(),
            &ctx.m.clock,
        );
        if !has_stored_fields(&catalog, &types) {
            continue;
        }
        let doc = Document::parse_at(&update.path, &update.doc);
        let raw = doc.frontmatter();
        let mut values = catalog.record_values(&update.path, &types, raw);
        let mut assigned = Map::new();
        for policy in types
            .iter()
            .filter_map(|n| catalog.type_named(n))
            .filter_map(|t| t.path_policy.as_ref())
        {
            for field in &policy.fields {
                if update.links.iter().any(|l| l.field.as_ref() == Some(field)) {
                    if let Some(value) = raw.get(field) {
                        values.insert(field, value.clone());
                    }
                    assigned.insert(field, raw.get(field).cloned().unwrap_or(Value::Null));
                }
            }
        }
        let path = if !assigned.is_empty() {
            normalize_path_values(&catalog, &types, &mut values, &assigned)?;
            let path = stored_update_path(&catalog, &types, &update.path, &values)?;
            check_path(&path)?;
            check_stored_path(&catalog, &types, &path)?;
            if !catalog.is_record_path(&path) {
                return Err(invalid(
                    "not_a_record_path",
                    "a path-stored reference must remain a record",
                ));
            }
            if ctx.resurrect() {
                allocate(&occupied, &path, Some(update.id))
            } else {
                ensure_free(&occupied, &path, update.id)?;
                path
            }
        } else {
            update.path.clone()
        };
        strip_path_fields(&catalog, &types, &mut values);
        update.doc = rewrite(&update.path, &update.doc, &writer::diff(raw, &values), None)?;
        update.path = path;
        occupied.apply_effect(&Effect::PutRecord {
            id: update.id,
            path: update.path.clone(),
            doc: update.doc.clone(),
        });
    }
    Ok(())
}

pub(super) fn emit_reference_update(
    ctx: &mut Ctx<'_>,
    ov: &mut Overlay<'_>,
    update: crate::links::ReferenceUpdate,
) {
    if let Some(before) = ov.record(&update.id)
        && before.path != update.path
    {
        ctx.touch_path(&before.path);
        ctx.touch_path(&update.path);
        if path_key(&before.path) != path_key(&update.path) {
            ctx.alias(ov, &before.path, update.id);
        }
    }
    ctx.touch_id(update.id);
    ctx.emit(
        ov,
        Effect::PutRecord {
            id: update.id,
            path: update.path,
            doc: update.doc,
        },
    );
}

fn types_of(
    catalog: &Catalog,
    path: &str,
    fm: &Map,
    clock: &crate::intent::OpClock,
) -> Vec<String> {
    catalog.membership_at(path, fm, Some(clock)).types
}

/// Validate a written record and emit it. Single-record issues reject at
/// submit with level `error`; enforced uniqueness rejects (S-class).
fn finalize(
    ctx: &mut Ctx<'_>,
    ov: &mut Overlay<'_>,
    id: RecordId,
    path: &str,
    src: String,
    previous: Option<&Map>,
) -> Result<(), Rejection> {
    finalize_with(ctx, ov, id, path, src, previous, |id, path, doc| {
        Effect::PutRecord { id, path, doc }
    })
}

/// Reindex an unindexed oversized Markdown file as a record (`intent.md` §3.10):
/// the same admission as a record write, emitting the atomic Effect10.
pub(super) fn reindex_unindexed(
    ctx: &mut Ctx<'_>,
    ov: &mut Overlay<'_>,
    id: RecordId,
    path: &str,
    src: String,
) -> Result<(), Rejection> {
    let doc = Document::parse_at(path, &src);
    if doc.problem().is_some() {
        return Err(frontmatter_problem(&doc));
    }
    finalize_with(ctx, ov, id, path, src, None, |id, path, doc| {
        Effect::ReindexUnindexedMarkdown { id, path, doc }
    })
}

/// Exact-source Ordinary-file promotion. No create lifecycle or regeneration.
pub(super) fn reindex_ordinary(
    ctx: &mut Ctx<'_>,
    ov: &mut Overlay<'_>,
    id: RecordId,
    path: &str,
    src: &str,
) -> Result<(), Rejection> {
    let (doc, _) = Document::parse_at_bounded(path, src).map_err(|_| {
        Rejection::new(
            RejectCode::TooLarge,
            Some("record_frontmatter_limit_exceeded"),
            "promotion source exceeds frontmatter structural limits",
        )
    })?;
    if doc.problem().is_some() {
        return Err(Rejection::new(
            RejectCode::InvalidRecord,
            Some("invalid_frontmatter"),
            "promotion requires a valid record mapping",
        ));
    }
    if doc.format() == crate::doc::RecordFormat::YamlDocument
        && !matches!(
            crate::yaml::parse_value_bounded(src),
            Ok((Some(Value::Map(_)), _))
        )
    {
        return Err(Rejection::new(
            RejectCode::InvalidRecord,
            Some("invalid_frontmatter"),
            "promotion requires a YAML mapping",
        ));
    }
    finalize_with(ctx, ov, id, path, src.to_owned(), None, |id, path, doc| {
        Effect::ReindexOrdinaryFile { id, path, doc }
    })
}

fn finalize_with(
    ctx: &mut Ctx<'_>,
    ov: &mut Overlay<'_>,
    id: RecordId,
    path: &str,
    src: String,
    previous: Option<&Map>,
    effect: impl FnOnce(RecordId, String, String) -> Effect,
) -> Result<(), Rejection> {
    let catalog = ov.catalog();
    if ctx.api() {
        let collection_level = catalog.settings().validation;
        let level = ctx.submit_level().unwrap_or(collection_level);
        if level != Level::Off || ctx.submit_level().is_none() {
            let issues = validate::validate_record_at(&catalog, path, &src, Some(&ctx.m.clock));
            let blocking = ctx.submit_level() == Some(Level::Error)
                && issues
                    .iter()
                    .any(|i| i.severity == Severity::Error && i.tier == Tier::SingleRecord);
            if blocking {
                let mut r = Rejection::new(
                    RejectCode::InvalidRecord,
                    None,
                    format!("`{path}` would not be valid"),
                );
                r.issues = issues;
                return Err(r);
            }
            if level != Level::Off {
                for issue in validate::apply_level(issues, level, false) {
                    ctx.issues.push(RecordIssue { id, issue });
                }
            }
        }
        // `unique.enforce: write` (spec 07): only writes that change a covered value.
        let doc = Document::parse_at(path, &src);
        let fm = doc.frontmatter();
        let types = types_of(&catalog, path, fm, &ctx.m.clock);
        let values = catalog.record_values(path, &types, fm);
        let fm = &values;
        let rec = StoredRecord {
            id,
            path: path.to_owned(),
            source: std::sync::Arc::from(src.as_str()),
        };
        let dups = validate::duplicate_values(ov, &catalog, &rec, fm, &types, Some(Enforce::Write));
        for d in dups {
            let field = d.location.clone().unwrap_or_default();
            let unchanged = previous.is_some_and(|prev| {
                let r = field.trim_start_matches('/').replace('/', ".");
                crate::types::select(prev, &r) == crate::types::select(fm, &r)
            });
            if !unchanged && ctx.resurrect() {
                // An acknowledged write is applied; the violation is reported.
                ctx.issues.push(RecordIssue { id, issue: d });
            } else if !unchanged {
                let mut r = conflict("duplicate_value", d.message.clone());
                r.details = d.details.clone();
                r.issues = vec![d];
                return Err(r);
            }
        }
    }
    ctx.emit(ov, effect(id, path.to_owned(), src));
    // A successful write reports the written record's cross-record issues as
    // warnings (spec 04), except at level `off`. Only at submit: they never
    // change the entry, and at head they would only cost time.
    if ctx.api()
        && let Some(level) = ctx.submit_level()
        && level != Level::Off
    {
        for mut issue in validate::cross_record_issues(ov, id) {
            if issue.tier == Tier::CrossRecord {
                issue.severity = Severity::Warning;
                ctx.issues.push(RecordIssue { id, issue });
            }
        }
    }
    Ok(())
}

/// Run lifecycle with the membership freeze (spec 05, 09, 12).
fn with_lifecycle(
    ctx: &mut Ctx<'_>,
    catalog: &Catalog,
    event: LifecycleEvent,
    path: &str,
    draft: Map,
    previous: Option<&Map>,
    matched: Option<&[String]>,
) -> Result<(Map, Vec<String>), Rejection> {
    let mut pre = catalog.membership_at(path, &draft, Some(&ctx.m.clock));
    if let Some(types) = matched {
        pre.types = types.to_vec();
    }
    if !ctx.api() {
        return Ok((draft, pre.types));
    }
    let resurrect = ctx.resurrect();
    let fallback = resurrect.then(|| draft.clone());
    let out = lifecycle::run(
        event,
        LifecycleContext {
            catalog,
            types: &pre.types,
            clock: &ctx.m.clock,
            generated: &mut ctx.generated,
            path,
            previous,
        },
        draft,
    )
    .map_err(|e| {
        let mut r = invalid(&e.code, e.message);
        if let Some(f) = e.field {
            r.details = details(&[("field", Value::string(f))]);
        }
        r
    });
    let out = match out {
        Ok(o) => o,
        Err(r) if resurrect => {
            // Lifecycle passed when the write was acknowledged; the catalog has
            // changed since. Apply the draft as it was and report.
            ctx.note(
                crate::ids::Uuid::NIL,
                &r.reason.unwrap_or_default(),
                r.message,
                r.details,
            );
            return Ok((fallback.unwrap_or_default(), pre.types));
        }
        Err(r) => return Err(r),
    };
    if event == LifecycleEvent::Create && path.is_empty() {
        // A selected type may match only the path we have not derived yet.
        return Ok((out, pre.types));
    }
    let mut raw = out.clone();
    strip_path_fields(catalog, &pre.types, &mut raw);
    let post = catalog.membership_at(path, &raw, Some(&ctx.m.clock));
    if post.types != pre.types && resurrect {
        ctx.note(
            crate::ids::Uuid::NIL,
            "type_membership_changed",
            "lifecycle changed the record's type membership",
            None,
        );
    } else if post.types != pre.types {
        return Err(invalid(
            "type_membership_changed",
            "lifecycle changed the record's type membership",
        ));
    }
    Ok((out, post.types))
}

pub(super) fn create(ctx: &mut Ctx<'_>, ov: &mut Overlay<'_>, c: &Create) -> Result<(), Rejection> {
    let catalog = ov.catalog();
    ctx.touch_id(c.id);
    if ov.record(&c.id).is_some() || ov.tombstone(&c.id).is_some() || ov.file(&c.id).is_some() {
        return Err(invalid(
            "id_exists",
            format!("record {} already exists", c.id),
        ));
    }
    let doc_path = c.path.clone().unwrap_or_else(|| "new.md".to_owned());
    let (mut fm, body, document) = match &c.document {
        Some(d) => {
            let doc = Document::parse_at(&doc_path, d.as_str());
            if doc.problem().is_some() {
                return Err(frontmatter_problem(&doc));
            }
            (
                doc.frontmatter().clone(),
                doc.body().to_owned(),
                Some(d.clone()),
            )
        }
        None => (
            c.frontmatter.clone().unwrap_or_default(),
            c.body.clone().unwrap_or_default(),
            None,
        ),
    };
    let original_fm = fm.clone();
    // The selected type (spec 12 "Selected types").
    let selected = match &c.type_name {
        Some(n) => Some(
            catalog
                .type_named(n)
                .ok_or_else(|| invalid("unknown_type", format!("unknown type `{n}`")))?
                .name
                .clone(),
        ),
        None => None,
    };
    if let Some(sel) = &selected {
        declare_type(&catalog, &mut fm, sel);
    }
    if let Some(path) = &c.path {
        let types = types_of(&catalog, path, &fm, &ctx.m.clock);
        let mut values = catalog.record_values(path, &types, &fm);
        for (k, v) in fm.iter() {
            values.insert(k, v.clone());
        }
        fm = values;
    }
    // A non-storing pattern may provide a provisional membership path. Lifecycle
    // still runs before the final path is derived, and can supply missing values.
    let initial_types = types_of(&catalog, c.path.as_deref().unwrap_or(""), &fm, &ctx.m.clock);
    let pattern = selected
        .as_ref()
        .and_then(|s| catalog.type_named(s))
        .and_then(|t| t.path_pattern.clone())
        .or_else(|| {
            initial_types
                .iter()
                .find_map(|n| catalog.type_named(n).and_then(|t| t.path_pattern.clone()))
        });
    let mut policy_types = initial_types.clone();
    if let Some(sel) = &selected {
        policy_types.push(sel.clone());
    }
    let provisional = if c.path.is_none() && !has_stored_fields(&catalog, &policy_types) {
        pattern.as_ref().and_then(|p| derive_path(p, &fm).ok())
    } else {
        None
    };
    let membership_path = c.path.as_deref().or(provisional.as_deref()).unwrap_or("");
    let mut create_types = types_of(&catalog, membership_path, &fm, &ctx.m.clock);
    if let Some(sel) = &selected
        && !create_types.contains(sel)
    {
        create_types.push(sel.clone());
    }
    let before_lifecycle = fm.clone();
    let (mut fm, types) = with_lifecycle(
        ctx,
        &catalog,
        LifecycleEvent::Create,
        membership_path,
        fm,
        None,
        Some(&create_types),
    )?;
    let mut written = if c.path.is_some() {
        original_fm.clone()
    } else {
        fm.clone()
    };
    mark_changed(&mut written, &before_lifecycle, &fm);
    let normalized = normalize_path_values(&catalog, &types, &mut fm, &written)?;
    warn_normalized(ctx, c.id, normalized);
    // The path.
    let path = match &c.path {
        Some(p) => p.clone(),
        None => {
            let pattern =
                pattern.ok_or_else(|| invalid("path_required", "no path and no path policy"))?;
            let derived = derive_path(&pattern, &fm).map_err(|e| {
                let mut r = invalid(e.code(), format!("cannot derive a path from `{pattern}`"));
                if let Some(f) = e.field() {
                    r.details = details(&[("field", Value::string(f))]);
                }
                r
            })?;
            check_path(&derived)?;
            check_written_path(&catalog, &types, &derived, &fm)?;
            derived
        }
    };
    check_path(&path)?;
    if !catalog.is_record_path(&path) {
        return Err(invalid(
            "not_a_record_path",
            format!("`{path}` is not a record path"),
        ));
    }
    let format = RecordFormat::for_path(&path);
    if format == RecordFormat::YamlDocument && !body.is_empty() {
        return Err(invalid(
            "invalid_request",
            "a YAML document record has no body",
        ));
    }
    check_stored_path(&catalog, &types, &path)?;
    if c.path.is_some() {
        let decoded = catalog.record_values(&path, &types, &Map::new());
        for policy in types
            .iter()
            .filter_map(|n| catalog.type_named(n))
            .filter_map(|t| t.path_policy.as_ref())
        {
            for field in &policy.fields {
                if written.contains_key(field) && fm.get(field) != decoded.get(field) {
                    let mut r = invalid(
                        "invalid_request",
                        "explicit path disagrees with the stored field value",
                    );
                    r.details = details(&[
                        ("field", Value::string(field)),
                        ("reason", Value::string("path_value_mismatch")),
                    ]);
                    return Err(r);
                }
            }
        }
    }
    let path = if ctx.resurrect() || (c.path.is_none() && !has_stored_fields(&catalog, &types)) {
        let allocated = allocate(ov, &path, None);
        if ctx.resurrect() && allocated != path {
            relocated(ctx, c.id, &path, &allocated);
        }
        allocated
    } else {
        if ov.at_path_key(&path_key(&path)).is_some() {
            let reason = if has_stored_fields(&catalog, &types) {
                "path_conflict"
            } else {
                "path_taken"
            };
            let mut r = conflict(reason, format!("`{path}` is taken"));
            r.details = details(&[("path", Value::string(&path))]);
            return Err(r);
        }
        path
    };
    strip_path_fields(&catalog, &types, &mut fm);
    check_move_membership(ctx, &catalog, &types, &path, &fm)?;
    let final_types = types_of(&catalog, &path, &fm, &ctx.m.clock);
    let types = final_types;
    if let Some(sel) = &selected
        && !types.iter().any(|t| t.eq_ignore_ascii_case(sel))
        && !ctx.resurrect()
    {
        return Err(invalid(
            "type_membership_changed",
            format!("the record would not match the selected type `{sel}`"),
        ));
    }
    let src = match document {
        Some(d) if fm == original_fm => d,
        Some(d) => rewrite(&path, &d, &writer::diff(&original_fm, &fm), None)?,
        None => {
            writer::render_new(&fm, &body, format, LineEnding::Lf).map_err(|e| write_err(&e))?
        }
    };
    ctx.touch_path(&path);
    finalize(ctx, ov, c.id, &path, src, None)
}

/// Persist a selected type through the configured explicit keys, keeping
/// existing valid declarations (spec 12).
fn declare_type(catalog: &Catalog, fm: &mut Map, selected: &str) {
    let keys = &catalog.settings().explicit_type_keys;
    let Some(first) = keys.first() else {
        return;
    };
    let present: Vec<&String> = keys.iter().filter(|k| fm.contains_key(k)).collect();
    if present.is_empty() {
        fm.insert(first.clone(), Value::string(selected));
        return;
    }
    let declared = catalog.membership("", fm).types;
    if declared.iter().any(|t| t.eq_ignore_ascii_case(selected)) {
        return;
    }
    let key = present[0].clone();
    let new = match fm.get(&key) {
        Some(Value::Text(s)) => {
            Value::List(vec![Value::string(s.clone()), Value::string(selected)])
        }
        Some(Value::List(l)) => {
            let mut l = l.clone();
            l.push(Value::string(selected));
            Value::List(l)
        }
        _ => Value::string(selected),
    };
    fm.insert(key, new);
}

/// The record an op addresses, live or resurrected from its tombstone (D8).
fn current_or_resurrect(
    ov: &Overlay<'_>,
    id: RecordId,
) -> Result<(String, String, bool), Rejection> {
    if let Some(r) = ov.record(&id) {
        return Ok((r.path, r.source.to_string(), false));
    }
    match ov.tombstone(&id) {
        Some(Tombstone::Record { path, doc }) => {
            let path = allocate(ov, &path, Some(id));
            Ok((path, doc.to_string(), true))
        }
        _ => Err(Rejection::new(
            RejectCode::NotFound,
            None,
            format!("no record {id}"),
        )),
    }
}

fn check_cas(if_revision: Option<Hash>, src: &str) -> Result<(), Rejection> {
    match if_revision {
        Some(want) if revision(src) != want => {
            let mut r = conflict("revision", "the record changed since it was read");
            r.details = details(&[("revision", Value::string(revision(src).to_string()))]);
            Err(r)
        }
        _ => Ok(()),
    }
}

/// Report that resurrection put a record at a suffixed path
/// (`record_renamed`).
fn relocated(ctx: &mut Ctx<'_>, id: RecordId, requested: &str, path: &str) {
    ctx.merged = true;
    ctx.note(
        id,
        "record_renamed",
        format!("`{requested}` is taken; the restored record is at `{path}`"),
        details(&[
            ("from", Value::string(requested)),
            ("path", Value::string(path)),
        ]),
    );
}

/// `if_revision`, resolved in resurrection mode: a stale revision is reported
/// and the write proceeds (field changes still merge against their `base`).
/// Returns whether the revision was stale.
fn cas(
    ctx: &mut Ctx<'_>,
    id: RecordId,
    if_revision: Option<Hash>,
    src: &str,
) -> Result<bool, Rejection> {
    match check_cas(if_revision, src) {
        Ok(()) => Ok(false),
        Err(r) if ctx.resurrect() => {
            ctx.merged = true;
            ctx.note(
                id,
                "concurrent_modification",
                "the record changed since the lost write was acknowledged",
                r.details,
            );
            Ok(true)
        }
        Err(r) => Err(r),
    }
}

fn field_conflict(id: RecordId, c: merge::Conflict) -> RecordedConflict {
    let conv = |v: merge::ConflictValue| match v {
        merge::ConflictValue::Missing => ConflictValue::Missing,
        merge::ConflictValue::Value(v) => ConflictValue::Value(v),
        merge::ConflictValue::Text(t) => ConflictValue::Text(t),
    };
    RecordedConflict {
        kind: match c.kind {
            merge::ConflictKind::Field => ConflictKind::Field,
            merge::ConflictKind::Frontmatter => ConflictKind::Frontmatter,
            merge::ConflictKind::Body => ConflictKind::Body,
            merge::ConflictKind::Path => ConflictKind::Path,
        },
        id,
        field: c.field,
        base: Some(conv(c.base)),
        kept: conv(c.first),
        lost: conv(c.second),
    }
}

pub(super) fn update(ctx: &mut Ctx<'_>, ov: &mut Overlay<'_>, u: &Update) -> Result<(), Rejection> {
    let catalog = ov.catalog();
    ctx.touch_id(u.id);
    let (path, current, resurrected) = match current_or_resurrect(ov, u.id) {
        Ok(x) => x,
        Err(_) if ctx.resurrect() => {
            ctx.note(
                u.id,
                "record_missing",
                "the record and its tombstone are gone; the update has nothing to apply to",
                None,
            );
            return Ok(());
        }
        Err(r) => return Err(r),
    };
    if resurrected {
        ctx.merged = true;
        if ctx.resurrect() {
            // The record was deleted after this write was acknowledged: it is
            // recreated, and the delete is recorded as having lost.
            ctx.conflicts.push(RecordedConflict {
                kind: ConflictKind::Delete,
                id: u.id,
                field: None,
                base: None,
                kept: ConflictValue::Text(current.clone()),
                lost: ConflictValue::Deleted,
            });
        }
    }
    cas(ctx, u.id, u.if_revision, &current)?;
    let cur_doc = Document::parse_at(&path, current.as_str());
    let structured = u.patch.as_ref().is_some_and(|p| !p.is_empty())
        || !u.unset.is_empty()
        || !u.add.is_empty()
        || !u.remove.is_empty();
    if structured && cur_doc.problem().is_some() {
        return Err(frontmatter_problem(&cur_doc));
    }
    let mut types = types_of(&catalog, &path, cur_doc.frontmatter(), &ctx.m.clock);
    let cur_fm = catalog.record_values(&path, &types, cur_doc.frontmatter());
    for field in &u.unset {
        if catalog
            .types()
            .iter()
            .filter(|t| types.contains(&t.name))
            .filter_map(|t| t.path_policy.as_ref())
            .any(|p| {
                p.fields
                    .iter()
                    .any(|f| field == f || field == &format!("/{f}"))
            })
        {
            return Err(path_error(crate::paths::PathPatternError::Missing {
                field: field.clone(),
            }));
        }
    }
    // A stored-field base is a path observation, not a YAML-field conflict.
    for b in &u.base {
        if u.patch.as_ref().is_some_and(|p| p.contains_key(&b.key))
            && types
                .iter()
                .filter_map(|n| catalog.type_named(n))
                .filter_map(|t| t.path_policy.as_ref())
                .any(|p| p.fields.contains(&b.key))
            && cur_fm.get(&b.key) != b.observed.as_ref()
        {
            let mut r = conflict("renamed", "the path-stored value changed since it was read");
            r.details = details(&[("path", Value::string(&path))]);
            if ctx.resurrect() {
                ctx.merged = true;
                ctx.note(u.id, "concurrent_modification", r.message, r.details);
            } else {
                return Err(r);
            }
        }
    }
    // Synthetic values exist only in the merge/lifecycle draft, never in emitted bytes.
    let current_values = rewrite(
        &path,
        &current,
        &writer::diff(cur_doc.frontmatter(), &cur_fm),
        None,
    )?;

    // 1. patch/unset as a three-way merge of the touched keys: B = current
    //    with the caller's observed values, F = current, S = B with the change.
    let mut src = current_values.clone();
    if u.patch.is_some() || !u.unset.is_empty() {
        let mut b_fm = cur_fm.clone();
        for b in &u.base {
            match &b.observed {
                Some(v) => {
                    b_fm.insert(b.key.clone(), v.clone());
                }
                None => {
                    b_fm.remove(&b.key);
                }
            }
            if cur_fm.get(&b.key) != b.observed.as_ref() {
                ctx.merged = true;
            }
        }
        let mut s_fm = b_fm.clone();
        for (k, v) in u.patch.iter().flat_map(|p| p.iter()) {
            s_fm.insert(k, v.clone());
        }
        for r in &u.unset {
            lifecycle::set_field(&mut s_fm, r, None).map_err(|m| invalid("invalid_request", m))?;
        }
        let b_src = rewrite(&path, &current_values, &writer::diff(&cur_fm, &b_fm), None)?;
        let s_src = rewrite(&path, &b_src, &writer::diff(&b_fm, &s_fm), None)?;
        let merged = merge::merge_records(
            Version {
                path: &path,
                source: &b_src,
            },
            Version {
                path: &path,
                source: &current_values,
            },
            Version {
                path: &path,
                source: &s_src,
            },
            &*catalog,
        );
        for c in merged.conflicts {
            ctx.conflicts.push(field_conflict(u.id, c));
        }
        src = merged.document;
    }

    // 2. add/remove on the current value (commutative, no base).
    if !u.add.is_empty() || !u.remove.is_empty() {
        let doc = Document::parse_at(&path, src.as_str());
        let fm = doc.frontmatter();
        let mut changes = Vec::new();
        let mut fields: Vec<&String> = Vec::new();
        for (f, _) in u.add.iter().chain(&u.remove) {
            if !fields.contains(&f) {
                fields.push(f);
            }
        }
        for f in fields {
            let mut list = match fm.get(f) {
                None | Some(Value::Null) => Vec::new(),
                Some(Value::List(l)) => l.clone(),
                Some(Value::Text(s)) if f == "tags" => vec![Value::string(s.clone())],
                Some(_) => {
                    return Err(invalid("invalid_request", format!("`{f}` is not a list")));
                }
            };
            let before = list.clone();
            for (_, items) in u.add.iter().filter(|(k, _)| k == f) {
                for item in items {
                    if !list.contains(item) {
                        list.push(item.clone());
                    }
                }
            }
            for (_, items) in u.remove.iter().filter(|(k, _)| k == f) {
                list.retain(|v| !items.contains(v));
            }
            let missing = !fm.contains_key(f) || fm.get(f).is_some_and(Value::is_null);
            if list != before || (missing && !list.is_empty()) {
                changes.push((f.clone(), Change::Set(Value::List(list))));
            }
        }
        src = rewrite(&path, &src, &changes, None)?;
    }

    // 3. the body.
    let new_body = match plan_body(ctx, ov, u, &path, &src) {
        Ok(b) => b,
        Err(r)
            if ctx.resurrect()
                && matches!(r.reason.as_deref(), Some("body" | "body_base_unavailable")) =>
        {
            // Keep the current body and record what the write wanted.
            let cur_body = Document::parse_at(&path, src.as_str()).body().to_owned();
            ctx.conflicts.push(RecordedConflict {
                kind: ConflictKind::Body,
                id: u.id,
                field: None,
                base: u.body_base_text.clone().map(ConflictValue::Text),
                kept: ConflictValue::Text(cur_body),
                lost: u
                    .body
                    .clone()
                    .map_or(ConflictValue::Missing, ConflictValue::Text),
            });
            None
        }
        Err(r) => return Err(r),
    };
    if let Some(b) = &new_body {
        src = rewrite(&path, &src, &[], Some(b))?;
    }

    // 4. lifecycle on_update, with the membership freeze.
    let draft_doc = Document::parse_at(&path, src.as_str());
    if draft_doc.problem().is_none() {
        let draft = draft_doc.frontmatter().clone();
        let mut raw_draft = draft.clone();
        strip_path_fields(&catalog, &types, &mut raw_draft);
        let draft_types = types_of(&catalog, &path, &raw_draft, &ctx.m.clock);
        let mut values = catalog.record_values(&path, &draft_types, &draft);
        for (k, v) in draft.iter() {
            values.insert(k, v.clone());
        }
        let (fm, next_types) = with_lifecycle(
            ctx,
            &catalog,
            LifecycleEvent::Update,
            &path,
            values,
            Some(&cur_fm),
            Some(&draft_types),
        )?;
        types = next_types;
        src = rewrite(&path, &src, &writer::diff(&draft, &fm), None)?;
    }

    let draft = Document::parse_at(&path, &src).frontmatter().clone();
    let mut values = draft.clone();
    let mut written = u.patch.clone().unwrap_or_default();
    mark_changed(&mut written, &cur_fm, &draft);
    let normalized = normalize_path_values(&catalog, &types, &mut values, &written)?;
    warn_normalized(ctx, u.id, normalized);
    let target = stored_update_path(&catalog, &types, &path, &values)?;
    strip_path_fields(&catalog, &types, &mut values);
    if target != path {
        check_move_membership(ctx, &catalog, &types, &target, &values)?;
    }
    src = rewrite(&path, &src, &writer::diff(&draft, &values), None)?;
    if src == current && target == path && !resurrected {
        return Ok(());
    }
    finalize_move(
        ctx,
        ov,
        u.id,
        &path,
        &target,
        src,
        Some(&cur_fm),
        u.update_refs.unwrap_or(true),
    )
}

/// The new body of an update, if it changes the body.
fn plan_body(
    ctx: &mut Ctx<'_>,
    ov: &Overlay<'_>,
    u: &Update,
    path: &str,
    src: &str,
) -> Result<Option<String>, Rejection> {
    if u.body.is_none() && u.body_edits.is_empty() {
        return Ok(None);
    }
    let doc = Document::parse_at(path, src);
    let current = doc.body().to_owned();
    if doc.format() == RecordFormat::YamlDocument {
        return Err(invalid(
            "invalid_request",
            "a YAML document record has no body",
        ));
    }
    let Some(base_digest) = u.body_base else {
        return Ok(u.body.clone());
    };
    let base_text: Option<String> = if Hash::of(current.as_bytes()) == base_digest {
        Some(current.clone())
    } else if let Some(t) = &u.body_base_text {
        Some(t.clone())
    } else if let Some(t) = ov.retained_body(&base_digest) {
        ctx.fills.push(super::BaseTextFill {
            op_index: ctx.op,
            text: t.clone(),
        });
        Some(t)
    } else {
        None
    };
    let body_error = |reason: &str| {
        let mut r = conflict(
            if reason == "body_base_unavailable" {
                "body_base_unavailable"
            } else {
                "body"
            },
            format!("concurrent_modification: {reason}"),
        );
        r.details = details(&[("reason", Value::string(reason))]);
        r
    };
    if !u.body_edits.is_empty() {
        let edits: Vec<merge::BodyEdit> = u
            .body_edits
            .iter()
            .map(|e| merge::BodyEdit {
                start: e.start,
                end: e.end,
                insert: e.insert.clone(),
            })
            .collect();
        let base = match &base_text {
            Some(t) => BodyBase::Text(t),
            None => BodyBase::Unavailable,
        };
        return match merge::apply_body_edits(&current, base, &edits) {
            Ok(b) => {
                if base_text.as_deref() != Some(current.as_str()) {
                    ctx.merged = true;
                }
                Ok(Some(b))
            }
            Err(e) if e.code == "invalid_request" => Err(invalid(e.reason, "invalid body edits")),
            Err(e) => Err(body_error(e.reason)),
        };
    }
    let replacement = u.body.clone().unwrap_or_default();
    match base_text {
        Some(b) if b == current => Ok(Some(replacement)),
        Some(b) => match merge::merge_body(&b, &current, &replacement) {
            Some(m) => {
                ctx.merged = true;
                Ok(Some(m))
            }
            None => Err(body_error("body_conflict")),
        },
        None => Err(body_error("body_base_unavailable")),
    }
}

pub(super) fn document(
    ctx: &mut Ctx<'_>,
    ov: &mut Overlay<'_>,
    d: &DocumentOp,
) -> Result<(), Rejection> {
    let catalog = ov.catalog();
    ctx.touch_id(d.id);
    let live = ov.record(&d.id);
    if let Some(r) = &live {
        cas(ctx, d.id, d.if_revision, &r.source)?;
    }
    let Some(new) = &d.new else {
        // A deletion observed.
        let Some(r) = live else {
            return Ok(());
        };
        let unchanged = d
            .base
            .as_ref()
            .is_none_or(|b| b.doc == *r.source && b.path == r.path);
        if unchanged {
            let before = ctx.incoming(ov, d.id);
            ctx.emit(
                ov,
                Effect::RemoveRecord {
                    id: d.id,
                    path: r.path,
                },
            );
            ctx.record_broken(ov, d.id, before);
        } else {
            ctx.conflicts.push(RecordedConflict {
                kind: ConflictKind::Delete,
                id: d.id,
                field: None,
                base: d.base.as_ref().map(|b| ConflictValue::Text(b.doc.clone())),
                kept: ConflictValue::Text(r.source.to_string()),
                lost: ConflictValue::Deleted,
            });
        }
        return Ok(());
    };
    let (cur_path, current, exists) = match live {
        Some(r) => (r.path, r.source.to_string(), true),
        None => match ov.tombstone(&d.id) {
            Some(Tombstone::Record { path, doc }) if d.base.is_some() => {
                ctx.merged = true;
                (path, doc.to_string(), false)
            }
            _ => (new.path.clone(), String::new(), false),
        },
    };
    // Turn API stored-key assignments into a path version BEFORE the three-way
    // merge. Otherwise two concurrent stored-key document edits look like YAML
    // edits, bypassing the path conflict rule.
    let assigned_types = types_of(
        &catalog,
        &new.path,
        Document::parse_at(&new.path, &new.doc).frontmatter(),
        &ctx.m.clock,
    );
    let encoded_new;
    let mut projected_values = Vec::new();
    let new = if ctx.api() {
        let doc = Document::parse_at(&new.path, &new.doc);
        let raw = doc.frontmatter();
        let types = types_of(&catalog, &new.path, raw, &ctx.m.clock);
        if doc.problem().is_none() && has_stored_fields(&catalog, &types) {
            let mut values = catalog.record_values(&new.path, &types, raw);
            for (k, v) in raw.iter() {
                values.insert(k, v.clone());
            }
            // This is only a projection for path merging, not write admission:
            // lifecycle below may supply or replace an initially unencodable value.
            let projected =
                normalize_path_values(&catalog, &types, &mut values, raw).and_then(|changed| {
                    stored_update_path(&catalog, &types, &new.path, &values)
                        .map(|path| (changed, path))
                });
            if let Ok((changed, path)) = projected {
                projected_values = changed;
                strip_path_fields(&catalog, &types, &mut values);
                let source = rewrite(&new.path, &new.doc, &writer::diff(raw, &values), None)?;
                encoded_new = crate::intent::DocVersion { path, doc: source };
                &encoded_new
            } else {
                new
            }
        } else {
            new
        }
    } else {
        new
    };
    // The target version: `new` as is when current equals base, else merged.
    let (mut target_path, mut target_doc) = if !exists && d.base.is_none() {
        (new.path.clone(), new.doc.clone())
    } else {
        match &d.base {
            Some(b) if b.doc == current && b.path == cur_path => {
                (new.path.clone(), new.doc.clone())
            }
            None if exists && ctx.api() => (new.path.clone(), new.doc.clone()),
            base => {
                let (bp, bd) = match base {
                    Some(b) => (b.path.as_str(), b.doc.as_str()),
                    None => (cur_path.as_str(), current.as_str()),
                };
                let merged = merge::merge_records(
                    Version {
                        path: bp,
                        source: bd,
                    },
                    Version {
                        path: &cur_path,
                        source: &current,
                    },
                    Version {
                        path: &new.path,
                        source: &new.doc,
                    },
                    &*catalog,
                );
                if ctx.api()
                    && merged
                        .conflicts
                        .iter()
                        .any(|c| c.kind == merge::ConflictKind::Body)
                    && !ctx.resurrect()
                {
                    let mut r = conflict("body", "concurrent_modification: body_conflict");
                    r.details = details(&[("reason", Value::string("body_conflict"))]);
                    return Err(r);
                }
                if merged.document != new.doc || merged.path != new.path {
                    ctx.merged = true;
                }
                for c in merged.conflicts {
                    ctx.conflicts.push(field_conflict(d.id, c));
                }
                (merged.path, merged.document)
            }
        }
    };
    if ctx.api() {
        check_path(&target_path)?;
        let doc = Document::parse_at(&target_path, target_doc.as_str());
        if doc.problem().is_none() {
            let raw = doc.frontmatter().clone();
            let types = types_of(&catalog, &target_path, &raw, &ctx.m.clock);
            let mut draft = catalog.record_values(&target_path, &types, &raw);
            for (k, v) in raw.iter() {
                draft.insert(k, v.clone());
            }
            let event = if exists {
                LifecycleEvent::Update
            } else {
                LifecycleEvent::Create
            };
            let prev = Document::parse_at(&cur_path, current.as_str())
                .frontmatter()
                .clone();
            let prev_types = types_of(&catalog, &cur_path, &prev, &ctx.m.clock);
            let prev = catalog.record_values(&cur_path, &prev_types, &prev);
            let (mut fm, _) = with_lifecycle(
                ctx,
                &catalog,
                event,
                &target_path,
                draft.clone(),
                exists.then_some(&prev),
                Some(&types),
            )?;
            let mut written = raw.clone();
            mark_changed(&mut written, &draft, &fm);
            let mut normalized = normalize_path_values(&catalog, &types, &mut fm, &written)?;
            // The projection above normalized the request's own assignments;
            // they count when merge and lifecycle left them as the value.
            for value in projected_values {
                if fm.get(&value.0) == Some(&value.2) && !normalized.iter().any(|n| n.0 == value.0)
                {
                    normalized.push(value);
                }
            }
            warn_normalized(ctx, d.id, normalized);
            let path = stored_update_path(&catalog, &types, &target_path, &fm)?;
            strip_path_fields(&catalog, &types, &mut fm);
            target_doc = rewrite(&target_path, &target_doc, &writer::diff(&raw, &fm), None)?;
            target_path = path;
        }
    }
    // The path collision rule: api rejects, external takes a suffix.
    let taken = match ov.at_path_key(&path_key(&target_path)) {
        Some(PathHolder::Record(id)) => id != d.id,
        Some(PathHolder::File(_)) => true,
        None => false,
    };
    if taken {
        if ctx.api() && !ctx.resurrect() {
            return Err(conflict(
                "path_conflict",
                format!("`{target_path}` is taken"),
            ));
        }
        let requested = target_path.clone();
        target_path = allocate(ov, &target_path, Some(d.id));
        if ctx.resurrect() {
            relocated(ctx, d.id, &requested, &target_path);
        }
    }
    if ctx.api() && target_path != cur_path {
        let raw = Document::parse_at(&target_path, &target_doc)
            .frontmatter()
            .clone();
        check_move_membership(ctx, &catalog, &assigned_types, &target_path, &raw)?;
    }
    if exists && target_path == cur_path && target_doc == current {
        return Ok(());
    }
    if exists && path_key(&target_path) != path_key(&cur_path) {
        ctx.alias(ov, &cur_path, d.id);
    }
    ctx.touch_path(&target_path);
    let prev = Document::parse_at(&cur_path, current.as_str())
        .frontmatter()
        .clone();
    finalize(
        ctx,
        ov,
        d.id,
        &target_path,
        target_doc,
        exists.then_some(&prev),
    )
}

pub(super) fn delete(ctx: &mut Ctx<'_>, ov: &mut Overlay<'_>, d: &Delete) -> Result<(), Rejection> {
    ctx.touch_id(d.id);
    let Some(r) = ov.record(&d.id) else {
        return Ok(());
    };
    let stale = cas(ctx, d.id, d.if_revision, &r.source)?;
    if stale
        || d.base_revision
            .is_some_and(|base| base != revision(&r.source))
    {
        ctx.conflicts.push(RecordedConflict {
            kind: ConflictKind::Delete,
            id: d.id,
            field: None,
            base: None,
            kept: ConflictValue::Text(r.source.to_string()),
            lost: ConflictValue::Deleted,
        });
        return Ok(());
    }
    let before = ctx.incoming(ov, d.id);
    ctx.emit(
        ov,
        Effect::RemoveRecord {
            id: d.id,
            path: r.path,
        },
    );
    ctx.record_broken(ov, d.id, before);
    Ok(())
}

pub(super) fn rename(ctx: &mut Ctx<'_>, ov: &mut Overlay<'_>, r: &Rename) -> Result<(), Rejection> {
    let catalog = ov.catalog();
    ctx.touch_id(r.id);
    let Some(rec) = ov.record(&r.id) else {
        return Err(Rejection::new(
            RejectCode::NotFound,
            None,
            format!("no record {}", r.id),
        ));
    };
    cas(ctx, r.id, r.if_revision, &rec.source)?;
    // Resurrection: a stale `from` moves the record from where it is now, and
    // a taken `to` gets the collision rule's suffixed path.
    let resolved;
    let r = if ctx.resurrect() {
        let mut to = r.to.clone();
        if matches!(ov.at_path_key(&path_key(&to)), Some(h) if h != PathHolder::Record(r.id)) {
            to = allocate(ov, &r.to, Some(r.id));
            relocated(ctx, r.id, &r.to, &to);
        }
        if rec.path != r.from {
            ctx.merged = true;
        }
        resolved = Rename {
            from: rec.path.clone(),
            to,
            ..r.clone()
        };
        &resolved
    } else {
        r
    };
    if ctx.resurrect() && rec.path == r.to {
        return Ok(());
    }
    if rec.path != r.from {
        let mut rej = conflict(
            "renamed",
            format!("the record is at `{}`, not `{}`", rec.path, r.from),
        );
        rej.details = details(&[("path", Value::string(rec.path.clone()))]);
        return Err(rej);
    }
    if !catalog.is_record_path(&r.to) {
        return Err(invalid(
            "not_a_record_path",
            format!("`{}` is not a record path", r.to),
        ));
    }
    if RecordFormat::for_path(&r.to) != RecordFormat::for_path(&r.from) {
        return Err(invalid(
            "invalid_request",
            "a rename cannot change the record format",
        ));
    }
    let types = types_of(
        &catalog,
        &r.to,
        Document::parse_at(&rec.path, &*rec.source).frontmatter(),
        &ctx.m.clock,
    );
    if !ctx.resurrect() {
        check_stored_path(&catalog, &types, &r.to)?;
    }
    match ov.at_path_key(&path_key(&r.to)) {
        Some(PathHolder::Record(id)) if id == r.id => {}
        Some(_) => {
            let reason = if has_stored_fields(&catalog, &types) {
                "path_conflict"
            } else {
                "path_taken"
            };
            let mut rej = conflict(reason, format!("`{}` is taken", r.to));
            rej.details = details(&[("path", Value::string(r.to.clone()))]);
            return Err(rej);
        }
        None => {}
    }
    let original = Document::parse_at(&r.from, &*rec.source);
    let mut raw = original.frontmatter().clone();
    strip_path_fields(&catalog, &types, &mut raw);
    let source = rewrite(
        &r.from,
        &rec.source,
        &writer::diff(original.frontmatter(), &raw),
        None,
    )?;
    // Plan reference updates against the state before and after the move.
    let updates = if r.update_refs {
        let mut post = Overlay::new(ov);
        post.apply_effect(&Effect::PutRecord {
            id: r.id,
            path: r.to.clone(),
            doc: source.clone(),
        });
        let mut updates = crate::links::plan_reference_updates(ov, &post, r.id, &r.to);
        prepare_reference_updates(ctx, &post, &mut updates)?;
        updates
    } else {
        Vec::new()
    };
    ctx.touch_path(&r.from);
    ctx.touch_path(&r.to);
    let before = ctx.incoming(ov, r.id);
    ctx.record_rewrites(&updates);
    let mut moved_doc = source;
    // A self-link rewrite applies to the moved record itself.
    if let Some(own) = updates.iter().find(|u| u.id == r.id) {
        if own.path != r.to {
            return Err(invalid(
                "type_conflict",
                "self-reference rewrite disagrees with the assigned path",
            ));
        }
        moved_doc.clone_from(&own.doc);
    }
    ctx.emit(
        ov,
        Effect::PutRecord {
            id: r.id,
            path: r.to.clone(),
            doc: moved_doc,
        },
    );
    if path_key(&r.from) != path_key(&r.to) {
        ctx.alias(ov, &r.from, r.id);
    }
    for upd in updates.into_iter().filter(|u| u.id != r.id) {
        emit_reference_update(ctx, ov, upd);
    }
    ctx.record_broken(ov, r.id, before);
    Ok(())
}
