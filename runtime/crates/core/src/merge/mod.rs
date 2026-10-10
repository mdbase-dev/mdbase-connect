//! The three-way record merge (spec 12A).
//!
//! [`merge_records`] combines two concurrent versions of one record (`first`,
//! the earlier-ordered one, and `second`) against their common `base`. It is a
//! pure function: it reads no clock and no other record. Where a conflict
//! exists the merged version holds the first version's value, and the conflict
//! carries all three values, so a caller can keep and surface the second
//! version's (spec 12A; `log-entry.md` records them as `kept` and `lost`).
//!
//! - **Frontmatter** merges one top-level key at a time with the rules of 12A
//!   and the key's strategy ([`MergeFacts::strategy`], from the types the
//!   first version matches, supplied through [`MergeTypes`]). The result is
//!   written over the first version's source with the format-fidelity writer: a
//!   value taken from the second version is copied verbatim from its entry, a
//!   computed value (`union`) is re-emitted.
//! - **Non-mapping frontmatter** (in any version) merges as one unit.
//! - **Body**: [`body::merge_body`].
//! - **Path**: like a frontmatter key with the `conflict` strategy.

pub mod body;
pub(crate) mod diff;
pub mod order;
pub mod strategy;

use std::cmp::Ordering;

use crate::doc::{Document, RecordFormat};
use crate::value::Value;
use crate::writer::{self, Change, entry_copy};
pub use body::{BodyBase, BodyEdit, BodyEditError, apply_body_edits, apply_edits, merge_body};
pub use strategy::{MergeFacts, MergeStrategy, MergeTypes, StrategyConflict};

/// Kind of a merge conflict (spec 12A; `ConflictKind` in `log-entry.md`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum ConflictKind {
    /// One top-level frontmatter field.
    Field,
    /// The whole frontmatter block (some version's frontmatter is not a mapping).
    Frontmatter,
    /// The body.
    Body,
    /// The path.
    Path,
}

impl ConflictKind {
    /// The spec name.
    pub fn as_str(self) -> &'static str {
        match self {
            ConflictKind::Field => "field",
            ConflictKind::Frontmatter => "frontmatter",
            ConflictKind::Body => "body",
            ConflictKind::Path => "path",
        }
    }
}

/// One side of a conflict (`conflict-value` in `log-entry.md`).
#[derive(Debug, Clone, PartialEq)]
pub enum ConflictValue {
    /// The key was missing.
    Missing,
    /// A frontmatter value.
    Value(Value),
    /// Source text: a frontmatter block, a body or a path.
    Text(String),
}

impl ConflictValue {
    fn of(v: Option<&Value>) -> ConflictValue {
        v.map_or(ConflictValue::Missing, |v| ConflictValue::Value(v.clone()))
    }
}

/// A merge conflict. The merged version holds `first`.
#[derive(Debug, Clone, PartialEq)]
pub struct Conflict {
    /// The kind.
    pub kind: ConflictKind,
    /// The top-level key, for [`ConflictKind::Field`].
    pub field: Option<String>,
    /// The base value.
    pub base: ConflictValue,
    /// The first version's value (kept).
    pub first: ConflictValue,
    /// The second version's value (not applied).
    pub second: ConflictValue,
}

/// One version of a record.
#[derive(Debug, Clone, Copy)]
pub struct Version<'a> {
    /// The collection-relative path.
    pub path: &'a str,
    /// The exact document source.
    pub source: &'a str,
}

/// The result of [`merge_records`].
#[derive(Debug, Clone, PartialEq)]
pub struct Merged {
    /// The merged document's exact source.
    pub document: String,
    /// The merged path (before the path collision rule, which the caller applies).
    pub path: String,
    /// Conflicts: field conflicts in key order, then frontmatter, body, path.
    pub conflicts: Vec<Conflict>,
}

/// Merge two concurrent versions of a record against their base (spec 12A).
///
/// Strategies come from the types the first version matches at its path
/// (`types`). The record format follows the first version's path.
pub fn merge_records(
    base: Version<'_>,
    first: Version<'_>,
    second: Version<'_>,
    types: &dyn MergeTypes,
) -> Merged {
    let mut conflicts = Vec::new();
    let path = if first.path == second.path || second.path == base.path {
        first.path
    } else if first.path == base.path {
        second.path
    } else {
        first.path
    };
    let path_conflict = (first.path != second.path
        && second.path != base.path
        && first.path != base.path)
        .then(|| Conflict {
            kind: ConflictKind::Path,
            field: None,
            base: ConflictValue::Text(base.path.to_owned()),
            first: ConflictValue::Text(first.path.to_owned()),
            second: ConflictValue::Text(second.path.to_owned()),
        });

    // Identity shortcuts: byte for byte (spec 12A "Inputs and result").
    let shortcut = if first.source == second.source || second.source == base.source {
        Some(first.source)
    } else if first.source == base.source {
        Some(second.source)
    } else {
        None
    };
    if let Some(doc) = shortcut {
        conflicts.extend(path_conflict);
        return Merged {
            document: doc.to_owned(),
            path: path.to_owned(),
            conflicts,
        };
    }

    let format = RecordFormat::for_path(first.path);
    let (b, f, s) = (
        Document::parse(base.source, format),
        Document::parse(first.source, format),
        Document::parse(second.source, format),
    );

    let body = match merge_body(b.body(), f.body(), s.body()) {
        Some(body) => body,
        None => {
            conflicts.push(Conflict {
                kind: ConflictKind::Body,
                field: None,
                base: ConflictValue::Text(b.body().to_owned()),
                first: ConflictValue::Text(f.body().to_owned()),
                second: ConflictValue::Text(s.body().to_owned()),
            });
            f.body().to_owned()
        }
    };

    let mappings = [&b, &f, &s].iter().all(|d| d.problem().is_none());
    let document = if mappings {
        let facts = types.merge_facts(first.path, f.frontmatter());
        let changes = merge_frontmatter(&b, &f, &s, &facts, &mut conflicts);
        // The first version's frontmatter is a mapping, so the write cannot be
        // rejected; a YAML document record's body is always empty.
        writer::write(&f, &changes, Some(&body)).unwrap_or_else(|_| f.source().to_owned())
    } else {
        let (bt, ft, st) = (
            b.frontmatter_block_source(),
            f.frontmatter_block_source(),
            s.frontmatter_block_source(),
        );
        let block = if ft == st || st == bt {
            ft
        } else if ft == bt {
            st
        } else {
            conflicts.push(Conflict {
                kind: ConflictKind::Frontmatter,
                field: None,
                base: ConflictValue::Text(bt.to_owned()),
                first: ConflictValue::Text(ft.to_owned()),
                second: ConflictValue::Text(st.to_owned()),
            });
            ft
        };
        let mut out = String::new();
        if f.has_bom() {
            out.push('\u{feff}');
        }
        out.push_str(block);
        out.push_str(&body);
        out
    };
    // Field conflicts come first; order the rest frontmatter, body, path.
    conflicts.sort_by_key(|c| c.kind);
    conflicts.extend(path_conflict);
    Merged {
        document,
        path: path.to_owned(),
        conflicts,
    }
}

/// The frontmatter changes that turn `f` into the merged version.
fn merge_frontmatter(
    b: &Document,
    f: &Document,
    s: &Document,
    facts: &MergeFacts,
    conflicts: &mut Vec<Conflict>,
) -> Vec<(String, Change)> {
    let (bm, fm, sm) = (b.frontmatter(), f.frontmatter(), s.frontmatter());
    let mut keys: Vec<&str> = Vec::new();
    for m in [fm, sm, bm] {
        for k in m.keys() {
            if !keys.contains(&k) {
                keys.push(k);
            }
        }
    }
    let mut changes = Vec::new();
    let take_second = |key: &str| -> Change {
        match entry_copy(s, key) {
            Some(copy) => Change::Copy(copy),
            None => match sm.get(key) {
                Some(v) => Change::Set(v.clone()),
                None => Change::Remove,
            },
        }
    };
    for key in keys {
        let (bv, fv, sv) = (bm.get(key), fm.get(key), sm.get(key));
        if fv == sv || sv == bv {
            continue;
        }
        if fv == bv {
            changes.push((key.to_owned(), take_second(key)));
            continue;
        }
        // A type_conflict between matched types' declarations falls back to the
        // `conflict` strategy: the merge never drops a value it cannot decide.
        let strategy = facts.strategy(key).unwrap_or(MergeStrategy::Conflict);
        let resolved = match strategy {
            MergeStrategy::Max | MergeStrategy::Min => match (fv, sv) {
                // A present value survives a concurrent removal.
                (None, Some(_)) => {
                    changes.push((key.to_owned(), take_second(key)));
                    true
                }
                (Some(_), None) => true,
                (Some(x), Some(y)) => match order::compare(x, y) {
                    Some(o) => {
                        let want_second = (strategy == MergeStrategy::Max && o == Ordering::Less)
                            || (strategy == MergeStrategy::Min && o == Ordering::Greater);
                        if want_second {
                            changes.push((key.to_owned(), take_second(key)));
                        }
                        true
                    }
                    None => false,
                },
                (None, None) => true,
            },
            MergeStrategy::Union => match (
                union_list(bv, key),
                union_list(fv, key),
                union_list(sv, key),
            ) {
                (Some(bl), Some(fl), Some(sl)) => {
                    let merged = union_merge(&bl, &fl, &sl);
                    if merged.is_empty() && (fv.is_none() || sv.is_none()) {
                        if fv.is_some() {
                            changes.push((key.to_owned(), Change::Remove));
                        }
                    } else if !matches!(fv, Some(Value::List(l)) if *l == merged) {
                        let value = Value::List(merged);
                        let change = match (fv, entry_copy(s, key)) {
                            (None, Some(like)) => Change::SetLike { value, like },
                            _ => Change::Set(value),
                        };
                        changes.push((key.to_owned(), change));
                    }
                    true
                }
                _ => false,
            },
            MergeStrategy::Conflict => false,
        };
        if !resolved {
            conflicts.push(Conflict {
                kind: ConflictKind::Field,
                field: Some(key.to_owned()),
                base: ConflictValue::of(bv),
                first: ConflictValue::of(fv),
                second: ConflictValue::of(sv),
            });
        }
    }
    changes
}

/// A value read as a list for `union`: a list as itself, missing or null as
/// empty, a `tags` string as a one-item list; anything else is not a list.
fn union_list(v: Option<&Value>, key: &str) -> Option<Vec<Value>> {
    match v {
        None | Some(Value::Null) => Some(Vec::new()),
        Some(Value::List(l)) => Some(l.clone()),
        Some(Value::Text(s)) if key == "tags" => Some(vec![Value::Text(s.clone())]),
        Some(_) => None,
    }
}

/// The observed-remove union (spec 12A): `first`'s items not removed by
/// `second`, then `second`'s additions not already present.
pub fn union_merge(base: &[Value], first: &[Value], second: &[Value]) -> Vec<Value> {
    let mut out: Vec<Value> = first
        .iter()
        // Keep unless it is a base item that `second` removed.
        .filter(|x| !base.contains(x) || second.contains(x))
        .cloned()
        .collect();
    for item in second {
        if !base.contains(item) && !out.contains(item) {
            out.push(item.clone());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(path: &'static str, source: &'static str) -> Version<'static> {
        Version { path, source }
    }

    #[test]
    fn union_semantics() {
        let l = |xs: &[&str]| xs.iter().map(|x| Value::string(*x)).collect::<Vec<_>>();
        assert_eq!(
            union_merge(&l(&["a", "b"]), &l(&["a", "b", "c"]), &l(&["a"])),
            l(&["a", "c"])
        );
        assert_eq!(
            union_merge(&l(&["a"]), &l(&["a", "b"]), &l(&["c"])),
            l(&["b", "c"])
        );
        // Removed on one side, re-added on the other: stays.
        assert_eq!(union_merge(&l(&["a"]), &l(&[]), &l(&["a", "b"])), l(&["b"]));
    }

    #[test]
    fn path_rules() {
        let c = MergeFacts::default();
        let doc = "---\na: 1\n---\n";
        let m = merge_records(v("a.md", doc), v("a.md", doc), v("b.md", doc), &c);
        assert_eq!((m.path.as_str(), m.conflicts.len()), ("b.md", 0));
        let m = merge_records(v("a.md", doc), v("b.md", doc), v("c.md", doc), &c);
        assert_eq!(m.path, "b.md");
        assert_eq!(m.conflicts[0].kind, ConflictKind::Path);
    }
}
