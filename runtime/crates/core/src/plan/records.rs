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

/// Changes that turn `from` into `to`, per top-level key, in `to`'s order then
/// removals.
fn diff_changes(from: &Map, to: &Map) -> Vec<(String, Change)> {
    let mut out: Vec<(String, Change)> = Vec::new();
    for (k, v) in to.iter() {
        if from.get(k).is_none_or(|old| !same(old, v)) {
            out.push((k.to_owned(), Change::Set(v.clone())));
        }
    }
    for k in from.keys() {
        if !to.contains_key(k) {
            out.push((k.to_owned(), Change::Remove));
        }
    }
    out
}

/// Equality that also tells `1` from `1.0` (a write that changes the type
/// changes the file).
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Int(_), Value::Float(_)) | (Value::Float(_), Value::Int(_)) => false,
        (Value::List(x), Value::List(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same(p, q))
        }
        (Value::Map(x), Value::Map(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w)))
        }
        _ => a == b,
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
) -> Result<(Map, Vec<String>), Rejection> {
    let pre = catalog.membership_at(path, &draft, Some(&ctx.m.clock));
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
    let post = catalog.membership_at(path, &out, Some(&ctx.m.clock));
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
    // The path.
    let path = match &c.path {
        Some(p) => {
            if ov.at_path_key(&path_key(p)).is_some() {
                if ctx.resurrect() {
                    let moved = allocate(ov, p, None);
                    relocated(ctx, c.id, p, &moved);
                    moved
                } else {
                    let mut r = conflict("path_taken", format!("`{p}` is taken"));
                    r.details = details(&[("path", Value::string(p.clone()))]);
                    return Err(r);
                }
            } else {
                p.clone()
            }
        }
        None => {
            let pattern = selected
                .as_ref()
                .and_then(|s| catalog.type_named(s))
                .and_then(|t| t.path_pattern.clone())
                .or_else(|| {
                    catalog
                        .membership_at("", &fm, Some(&ctx.m.clock))
                        .types
                        .iter()
                        .find_map(|n| catalog.type_named(n).and_then(|t| t.path_pattern.clone()))
                })
                .ok_or_else(|| invalid("path_required", "no path and no path policy"))?;
            let derived = derive_path(&pattern, &fm).map_err(|e| {
                let mut r = invalid(e.code(), format!("cannot derive a path from `{pattern}`"));
                if let Some(f) = e.field() {
                    r.details = details(&[("field", Value::string(f))]);
                }
                r
            })?;
            check_path(&derived)?;
            allocate(ov, &derived, None)
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
    let (fm, types) = with_lifecycle(ctx, &catalog, LifecycleEvent::Create, &path, fm, None)?;
    if let Some(sel) = &selected
        && !types.iter().any(|t| t.eq_ignore_ascii_case(sel))
    {
        return Err(invalid(
            "type_membership_changed",
            format!("the record would not match the selected type `{sel}`"),
        ));
    }
    let src = match document {
        Some(d) if fm == original_fm => d,
        Some(d) => rewrite(&path, &d, &diff_changes(&original_fm, &fm), None)?,
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
    let cur_fm = cur_doc.frontmatter().clone();

    // 1. patch/unset as a three-way merge of the touched keys: B = current
    //    with the caller's observed values, F = current, S = B with the change.
    let mut src = current.clone();
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
        let b_src = rewrite(&path, &current, &diff_changes(&cur_fm, &b_fm), None)?;
        let s_src = rewrite(&path, &b_src, &diff_changes(&b_fm, &s_fm), None)?;
        let merged = merge::merge_records(
            Version {
                path: &path,
                source: &b_src,
            },
            Version {
                path: &path,
                source: &current,
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
        let (fm, _) = with_lifecycle(
            ctx,
            &catalog,
            LifecycleEvent::Update,
            &path,
            draft.clone(),
            Some(&cur_fm),
        )?;
        src = rewrite(&path, &src, &diff_changes(&draft, &fm), None)?;
    }

    if src == current && !resurrected {
        return Ok(());
    }
    ctx.touch_path(&path);
    finalize(ctx, ov, u.id, &path, src, Some(&cur_fm))
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
            let draft = doc.frontmatter().clone();
            let event = if exists {
                LifecycleEvent::Update
            } else {
                LifecycleEvent::Create
            };
            let prev = Document::parse_at(&cur_path, current.as_str())
                .frontmatter()
                .clone();
            let (fm, _) = with_lifecycle(
                ctx,
                &catalog,
                event,
                &target_path,
                draft.clone(),
                exists.then_some(&prev),
            )?;
            target_doc = rewrite(&target_path, &target_doc, &diff_changes(&draft, &fm), None)?;
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
            return Err(conflict("path_taken", format!("`{target_path}` is taken")));
        }
        let requested = target_path.clone();
        target_path = allocate(ov, &target_path, Some(d.id));
        if ctx.resurrect() {
            relocated(ctx, d.id, &requested, &target_path);
        }
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
    match ov.at_path_key(&path_key(&r.to)) {
        Some(PathHolder::Record(id)) if id == r.id => {}
        Some(_) => {
            let mut rej = conflict("path_taken", format!("`{}` is taken", r.to));
            rej.details = details(&[("path", Value::string(r.to.clone()))]);
            return Err(rej);
        }
        None => {}
    }
    // Plan reference updates against the state before and after the move.
    let updates = if r.update_refs {
        let mut post = Overlay::new(ov);
        post.apply_effect(&Effect::PutRecord {
            id: r.id,
            path: r.to.clone(),
            doc: rec.source.to_string(),
        });
        crate::links::plan_reference_updates(ov, &post, r.id, &r.to)
    } else {
        Vec::new()
    };
    ctx.touch_path(&r.from);
    ctx.touch_path(&r.to);
    let before = ctx.incoming(ov, r.id);
    ctx.record_rewrites(&updates);
    let mut moved_doc = rec.source.to_string();
    // A self-link rewrite applies to the moved record itself.
    if let Some(own) = updates.iter().find(|u| u.id == r.id) {
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
        ctx.touch_id(upd.id);
        ctx.emit(
            ov,
            Effect::PutRecord {
                id: upd.id,
                path: upd.path,
                doc: upd.doc,
            },
        );
    }
    ctx.record_broken(ov, r.id, before);
    Ok(())
}
