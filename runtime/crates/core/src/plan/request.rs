//! The stateless request checks (`intent.md` §6 first rows, §8; spec 12).
//!
//! Everything here depends only on the mutation, so a request that fails fails
//! identically at submit, at head and at verification.

use std::collections::BTreeSet;

use super::{MAX_OPS, MAX_PATH_BYTES, RejectCode, Rejection};
use crate::intent::{Mutation, Op, Source};
use crate::paths::path_key;
use crate::value::Value;

pub(super) fn invalid(reason: &str, message: impl Into<String>) -> Rejection {
    Rejection::new(RejectCode::InvalidRequest, Some(reason), message)
}

/// Check that `path` is a safe collection-relative path (spec 02): relative,
/// `/`-separated, no empty, `.` or `..` segments, no backslash or control
/// characters, not under `.mdbase/`, at most 1,024 bytes.
pub fn check_path(path: &str) -> Result<(), Rejection> {
    if path.is_empty() {
        return Err(invalid("invalid_path", "the path is empty"));
    }
    if path.len() > MAX_PATH_BYTES as usize {
        return Err(Rejection::new(
            RejectCode::TooLarge,
            Some("path_too_long"),
            format!("paths are limited to {MAX_PATH_BYTES} bytes"),
        ));
    }
    if path.split('/').any(|s| s == "..") {
        return Err(invalid(
            "path_traversal",
            format!("`{path}` escapes the collection"),
        ));
    }
    if path.starts_with('/')
        || path.contains('\\')
        || path.chars().any(char::is_control)
        || path.split('/').any(|s| s.is_empty() || s == ".")
    {
        return Err(invalid(
            "unsafe_path",
            format!("`{path}` is not a safe collection path"),
        ));
    }
    if path.split('/').next() == Some(".mdbase") {
        return Err(invalid("unsafe_path", "`.mdbase/` is reserved"));
    }
    Ok(())
}

/// Every path and ID an op names (for `duplicate_batch_path`).
fn named(op: &Op) -> (Vec<&str>, Vec<crate::ids::Uuid>) {
    match op {
        Op::Create(c) => (c.path.as_deref().into_iter().collect(), vec![c.id]),
        Op::Update(u) => (vec![], vec![u.id]),
        Op::Document(d) => {
            let mut p: Vec<&str> = Vec::new();
            if let Some(n) = &d.new {
                p.push(&n.path);
            }
            (p, vec![d.id])
        }
        Op::Delete(d) => (vec![], vec![d.id]),
        Op::Rename(r) => (vec![&r.from, &r.to], vec![r.id]),
        Op::ResourcePut(r) => (vec![&r.path], vec![]),
        Op::ResourceDelete(r) => (vec![&r.path], vec![]),
        Op::FilePut(f) => (vec![&f.path], vec![f.id]),
        Op::FileAttach(f) => (vec![&f.path], vec![f.id]),
        Op::OrdinaryAttachmentContinuation(f) => (vec![&f.path], vec![f.id]),
        Op::UnindexedMarkdownPut(f) => (vec![&f.path], vec![f.id]),
        Op::RecordToUnindexedMarkdown(f) => (vec![&f.path], vec![f.id]),
        Op::UnindexedMarkdownToRecord(f) => (vec![&f.path], vec![f.id]),
        Op::OrdinaryFileToRecord(f) => (vec![&f.path], vec![f.id]),
        Op::FileDelete(f) => (vec![], vec![f.id]),
        Op::FileMove(f) => (vec![&f.from, &f.to], vec![f.id]),
        Op::ConflictDismiss(_) | Op::SyncSettings(_) => (vec![], vec![]),
    }
}

/// The stateless request checks: op count, sources allowed for `external`,
/// mutually exclusive fields, repeated paths/IDs in a batch, path safety and
/// size limits.
pub fn check_request(m: &Mutation) -> Result<(), Rejection> {
    let n = u32::try_from(m.ops.len()).unwrap_or(u32::MAX);
    if n == 0 {
        return Err(invalid(
            "empty_mutation",
            "a mutation needs at least one operation",
        ));
    }
    if n > MAX_OPS {
        return Err(Rejection::new(
            RejectCode::TooLarge,
            None,
            format!("{n} operations; the limit is {MAX_OPS}"),
        ));
    }
    let mut paths: BTreeSet<String> = BTreeSet::new();
    let mut ids: BTreeSet<crate::ids::Uuid> = BTreeSet::new();
    for (i, op) in m.ops.iter().enumerate() {
        let at = u32::try_from(i).unwrap_or(u32::MAX);
        if m.source == Source::External
            && !matches!(
                op,
                Op::Document(_)
                    | Op::FilePut(_)
                    | Op::FileAttach(_)
                    | Op::OrdinaryAttachmentContinuation(_)
                    | Op::UnindexedMarkdownPut(_)
                    | Op::RecordToUnindexedMarkdown(_)
                    | Op::UnindexedMarkdownToRecord(_)
                    | Op::OrdinaryFileToRecord(_)
                    | Op::FileDelete(_)
                    | Op::FileMove(_)
            )
        {
            return Err(invalid(
                "external_op",
                format!("`{}` cannot have source external", op.kind()),
            )
            .at_op(at));
        }
        let (op_paths, op_ids) = named(op);
        for p in &op_paths {
            check_path(p).map_err(|r| r.at_op(at))?;
        }
        if n > 1 {
            // A rename names `from` and `to` of one record; within one op that
            // is not a repeat.
            let own: BTreeSet<String> = op_paths.iter().map(|p| path_key(p)).collect();
            for k in own {
                if !paths.insert(k) {
                    return Err(invalid(
                        "duplicate_batch_path",
                        "a batch names one path more than once",
                    )
                    .at_op(at));
                }
            }
            for id in op_ids {
                if !ids.insert(id) {
                    return Err(invalid(
                        "duplicate_batch_path",
                        "a batch names one record more than once",
                    )
                    .at_op(at));
                }
            }
        }
        check_op(op).map_err(|r| r.at_op(at))?;
    }
    Ok(())
}

fn check_op(op: &Op) -> Result<(), Rejection> {
    match op {
        Op::ResourcePut(r) if r.must_not_exist && r.base_revision.is_some() => {
            return Err(invalid(
                "invalid_request",
                "`must_not_exist` cannot be combined with `base_revision`",
            ));
        }
        Op::Create(c) => {
            if c.document.is_some() && (c.frontmatter.is_some() || c.body.is_some()) {
                return Err(invalid(
                    "invalid_request",
                    "`document` cannot be combined with `frontmatter` or `body`",
                ));
            }
        }
        Op::Update(u) => check_update(u)?,
        Op::Rename(r) => {
            if r.from == r.to {
                return Err(invalid(
                    "invalid_request",
                    "`from` and `to` are the same path",
                ));
            }
        }
        Op::FileMove(f) => {
            if f.from == f.to {
                return Err(invalid(
                    "invalid_request",
                    "`from` and `to` are the same path",
                ));
            }
        }
        Op::Document(d) => {
            if d.base.is_none() && d.new.is_none() {
                return Err(invalid(
                    "invalid_request",
                    "`document` needs `base` or `new`",
                ));
            }
        }
        _ => {}
    }
    Ok(())
}

fn check_update(u: &crate::intent::Update) -> Result<(), Rejection> {
    use crate::types::{FieldStep, parse_field_ref, top_level_field};
    let patch_keys: BTreeSet<&str> = u.patch.iter().flat_map(|p| p.keys()).collect();
    for r in &u.unset {
        let steps = parse_field_ref(r)
            .ok_or_else(|| invalid("invalid_request", format!("invalid field reference `{r}`")))?;
        if steps
            .iter()
            .any(|s| matches!(s, FieldStep::Each | FieldStep::Index(_)))
        {
            return Err(invalid(
                "invalid_request",
                format!("`unset` cannot address array items (`{r}`)"),
            ));
        }
        let top = match &steps[0] {
            FieldStep::Key(k) => k.clone(),
            _ => String::new(),
        };
        if patch_keys.contains(top.as_str()) {
            return Err(invalid(
                "invalid_request",
                format!("`{r}` is both patched and unset"),
            ));
        }
    }
    for (field, items) in u.add.iter().chain(&u.remove) {
        if top_level_field(field).is_none() {
            return Err(invalid(
                "invalid_request",
                format!("`add`/`remove` address top-level fields (`{field}`)"),
            ));
        }
        let unset_top = u
            .unset
            .iter()
            .any(|r| r == field || r.starts_with(&format!("{field}.")));
        if patch_keys.contains(field.as_str()) || unset_top {
            return Err(invalid(
                "invalid_request",
                format!("`{field}` is named in `add`/`remove` and in `patch`/`unset`"),
            ));
        }
        let _ = items;
    }
    for (field, adds) in &u.add {
        if let Some((_, removes)) = u.remove.iter().find(|(f, _)| f == field)
            && adds.iter().any(|a| removes.contains(a))
        {
            return Err(invalid(
                "invalid_request",
                format!("the same item is added to and removed from `{field}`"),
            ));
        }
    }
    let edits = !u.body_edits.is_empty();
    if edits && u.body.is_some() {
        return Err(invalid(
            "invalid_request",
            "`body_edits` cannot be combined with `body`",
        ));
    }
    if edits && u.body_base.is_none() {
        return Err(invalid("invalid_request", "`body_edits` needs `body_base`"));
    }
    if let (Some(text), Some(base)) = (&u.body_base_text, u.body_base)
        && crate::ids::Hash::of(text.as_bytes()) != base
    {
        return Err(invalid(
            "invalid_request",
            "`body_base_text` does not match `body_base`",
        ));
    }
    let mut prev_end = 0u64;
    let mut prev_insert: Option<u64> = None;
    for e in &u.body_edits {
        if e.start > e.end
            || e.start < prev_end
            || (e.start == e.end && prev_insert == Some(e.start))
        {
            return Err(invalid(
                "invalid_request",
                "body edits are out of order or overlap",
            ));
        }
        prev_end = e.end;
        prev_insert = (e.start == e.end).then_some(e.start);
    }
    for b in &u.base {
        let touched = patch_keys.contains(b.key.as_str())
            || u.unset
                .iter()
                .any(|r| r == &b.key || r.starts_with(&format!("{}.", b.key)));
        if !touched {
            return Err(invalid(
                "invalid_request",
                format!("`base` names `{}`, which the update does not touch", b.key),
            ));
        }
    }
    if let Some(p) = &u.patch
        && p.iter().any(|(_, v)| depth(v) > 64)
    {
        return Err(Rejection::new(
            RejectCode::TooLarge,
            Some("nesting"),
            "frontmatter nesting is limited to 64 levels",
        ));
    }
    Ok(())
}

fn depth(v: &Value) -> u32 {
    match v {
        Value::List(l) => 1 + l.iter().map(depth).max().unwrap_or(0),
        Value::Map(m) => 1 + m.iter().map(|(_, v)| depth(v)).max().unwrap_or(0),
        _ => 0,
    }
}
