//! Lowering a compiled `where` into the closed [`Candidate`] IR.
//!
//! The result is a **necessary** condition: every record for which `where`
//! is `true` satisfies it. A term that cannot be lowered becomes
//! [`Candidate::All`] inside a conjunction and stops a disjunction or
//! negation from being lowered at all. The result is also **sufficient**
//! (`complete`) only when every leaf is one a store evaluates exactly:
//! [`Candidate::HasType`], [`Candidate::InFolder`], or `==`/`!=` with
//! [`Pruning::Exact`].
//!
//! **Effective vs persisted.** A bare field (`status`) reads the effective
//! value. When no type declares a read default for it, effective equals
//! persisted, and the term is lowered on [`FieldRef::Persisted`], which
//! stores index. Otherwise it stays [`FieldRef::Effective`] and stores treat
//! it conservatively. Schema-declared date-times are CEL timestamps even in
//! `raw`: comparisons at potentially typed locations stay residual-only rather
//! than pruning or claiming exactness using persisted string comparisons.

use std::collections::BTreeSet;

use super::{Candidate, CompareOp, FieldRef, Pruning};
use crate::cel::CelValue;
use crate::cel::ast::{BinOp, Expr};
use crate::value::Value;

/// A lowered predicate.
pub(super) struct Lowered {
    pub candidate: Candidate,
    /// The candidate is also sufficient.
    pub complete: bool,
}

impl Lowered {
    fn all() -> Lowered {
        Lowered {
            candidate: Candidate::All,
            complete: false,
        }
    }
}

/// Bindings that are not record fields.
const RESERVED: &[&str] = &[
    "file",
    "this",
    "projection",
    "record",
    "raw",
    "types",
    "now",
    "today",
];

pub(super) struct Lowerer<'a> {
    /// Top-level fields some type gives a read default.
    pub defaulted: &'a BTreeSet<String>,
    /// Catalog for link key derivation and canonical schema activation. Any type
    /// can match a record, so a date-time declaration prevents raw pruning.
    pub catalog: &'a crate::types::Catalog,
}

impl Lowerer<'_> {
    pub(super) fn lower(&self, e: &Expr) -> Lowered {
        match e {
            Expr::Lit(CelValue::Bool(true)) => Lowered {
                candidate: Candidate::All,
                complete: true,
            },
            Expr::Lit(CelValue::Bool(false)) => Lowered {
                candidate: Candidate::None,
                complete: true,
            },
            Expr::And(a, b) => {
                let (a, b) = (self.lower(a), self.lower(b));
                let complete = a.complete && b.complete;
                Lowered {
                    candidate: and(a.candidate, b.candidate),
                    complete,
                }
            }
            Expr::Or(a, b) => {
                let (a, b) = (self.lower(a), self.lower(b));
                // A disjunction is necessary only if both sides are.
                if matches!(a.candidate, Candidate::All) || matches!(b.candidate, Candidate::All) {
                    return Lowered {
                        candidate: Candidate::All,
                        complete: a.complete && b.complete,
                    };
                }
                Lowered {
                    complete: a.complete && b.complete,
                    candidate: Candidate::Or(vec![a.candidate, b.candidate]),
                }
            }
            Expr::Not(inner) => {
                let i = self.lower(inner);
                // `!x` is necessary only when `x` is exactly described.
                if i.complete {
                    Lowered {
                        candidate: Candidate::Not(Box::new(i.candidate)),
                        complete: true,
                    }
                } else {
                    Lowered::all()
                }
            }
            Expr::Bin(BinOp::In, a, list) if is_file_member(list, "links") => self.links_to(a),
            Expr::Bin(op, l, r) => self.compare(*op, l, r),
            Expr::Call {
                target: Some(t),
                func,
                args,
            } if func == "inFolder" && is_ident(t, "file") => match args.as_slice() {
                [Expr::Lit(CelValue::String(f))] => Lowered {
                    candidate: Candidate::InFolder(f.trim_end_matches('/').to_owned()),
                    complete: true,
                },
                _ => Lowered::all(),
            },
            Expr::Call {
                target: Some(t),
                func,
                args,
            } if func == "hasLink" && is_ident(t, "file") => match args.as_slice() {
                [a] => self.links_to(a),
                _ => Lowered::all(),
            },
            Expr::Call {
                target: Some(t),
                func,
                args,
            } if func == "contains" && is_file_member(t, "links") => match args.as_slice() {
                [a] => self.links_to(a),
                _ => Lowered::all(),
            },
            Expr::Call {
                target: Some(t),
                func,
                args,
            } if func == "contains" && body_receiver(t).is_some() => match args.as_slice() {
                [Expr::Lit(CelValue::String(text))] => Lowered {
                    candidate: Candidate::BodyContains {
                        text: text.to_string(),
                        case_insensitive: body_receiver(t) == Some(true),
                    },
                    complete: false,
                },
                _ => Lowered::all(),
            },
            Expr::Call {
                target: Some(t),
                func,
                args,
            } if func == "contains" => match (self.field(t), args.as_slice()) {
                (Some(field), [Expr::Lit(v)]) => match literal(v) {
                    Some(value) => {
                        compare_term(field, CompareOp::Contains, value, Pruning::Conservative)
                    }
                    None => Lowered::all(),
                },
                _ => Lowered::all(),
            },
            _ => Lowered::all(),
        }
    }

    fn compare(&self, op: BinOp, l: &Expr, r: &Expr) -> Lowered {
        // Normalize to `field op literal`.
        let (field, lit, flipped) = match (self.field(l), lit_of(r), self.field(r), lit_of(l)) {
            (Some(f), Some(v), _, _) => (f, v, false),
            (_, _, Some(f), Some(v)) => (f, v, true),
            _ => {
                // `"x" in field` / `field in [..]`
                return Lowered::all();
            }
        };
        let op = match (op, flipped) {
            (BinOp::Eq, _) => CompareOp::Eq,
            (BinOp::Ne, _) => CompareOp::Ne,
            (BinOp::Lt, false) | (BinOp::Gt, true) => CompareOp::Lt,
            (BinOp::Le, false) | (BinOp::Ge, true) => CompareOp::Le,
            (BinOp::Gt, false) | (BinOp::Lt, true) => CompareOp::Gt,
            (BinOp::Ge, false) | (BinOp::Le, true) => CompareOp::Ge,
            (BinOp::In, false) => CompareOp::In,
            (BinOp::In, true) => CompareOp::Contains,
            _ => return Lowered::all(),
        };
        let pruning = pruning(op, &lit, &field);
        // A missing field reads as null only for a bare top-level identifier;
        // through `raw.`/`record.` or a nested path it is an evaluation error,
        // which excludes the record under `==`, `!=` and `!` alike. A store
        // compares "missing" as unequal, so such a term is still necessary but
        // no longer sufficient.
        let bare = matches!(l, Expr::Ident(_)) || matches!(r, Expr::Ident(_));
        let mut out = compare_term(field, op, lit, pruning);
        if !bare {
            out.complete = false;
        }
        out
    }

    /// The record field an expression reads, if it is a plain field path.
    fn field(&self, e: &Expr) -> Option<FieldRef> {
        let mut path = Vec::new();
        let mut cur = e;
        loop {
            match cur {
                Expr::Select {
                    operand,
                    field,
                    test: false,
                    optional: false,
                } => {
                    path.push(field.clone());
                    cur = operand;
                }
                Expr::Ident(root) => {
                    path.reverse();
                    let field = match root.as_str() {
                        "raw" if !path.is_empty() => Some(FieldRef::Persisted(path)),
                        "record" if !path.is_empty() => Some(self.effective(path)),
                        "file" if path.len() == 1 && path[0] == "path" => Some(FieldRef::Path),
                        r if RESERVED.contains(&r) => None,
                        r => {
                            let mut full = vec![r.to_owned()];
                            full.extend(path);
                            Some(self.effective(full))
                        }
                    };
                    return field.filter(|f| !self.possibly_timestamp(f));
                }
                _ => return None,
            }
        }
    }

    fn possibly_timestamp(&self, field: &FieldRef) -> bool {
        let path = match field {
            FieldRef::Effective(path) | FieldRef::Persisted(path) => path,
            _ => return false,
        };
        let location: Vec<_> = path.iter().map(String::as_str).collect();
        self.catalog.types().iter().any(|t| {
            crate::types::schema_at(&t.schema_document, &t.schema_entry, &location)
                .and_then(|s| s.get("format"))
                .and_then(Value::as_str)
                == Some("date-time")
        })
    }

    fn effective(&self, path: Vec<String>) -> FieldRef {
        if self.defaulted.contains(&path[0]) {
            FieldRef::Effective(path)
        } else {
            FieldRef::Persisted(path)
        }
    }
}

/// `file.<member>`.
fn is_file_member(e: &Expr, member: &str) -> bool {
    matches!(e, Expr::Select { operand, field, test: false, .. } if field == member && is_ident(operand, "file"))
}

/// `file.body` → `Some(false)`, `file.body.lower()` → `Some(true)`.
fn body_receiver(e: &Expr) -> Option<bool> {
    if is_file_member(e, "body") {
        return Some(false);
    }
    match e {
        Expr::Call {
            target: Some(t),
            func,
            args,
        } if func == "lower" && args.is_empty() && is_file_member(t, "body") => Some(true),
        _ => None,
    }
}

impl Lowerer<'_> {
    /// `LinksTo` for a literal link (`"[[x]]"`, `link("[[x]]")`). Only when
    /// no ID field is configured: then every link that resolves to a record
    /// shares its file stem, so the stem's index key is necessary. With an
    /// ID field a link may name the record by ID, so nothing is lowered.
    fn links_to(&self, e: &Expr) -> Lowered {
        if self.catalog.settings().id_field.is_some() {
            return Lowered::all();
        }
        let lit = match e {
            Expr::Lit(CelValue::String(s)) => s.to_string(),
            Expr::Call {
                target: None,
                func,
                args,
            } if func == "link" => match args.as_slice() {
                [Expr::Lit(CelValue::String(s))] => s.to_string(),
                _ => return Lowered::all(),
            },
            _ => return Lowered::all(),
        };
        let Some(link) = crate::links::parse_value(&lit, true) else {
            return Lowered::all();
        };
        let canonical = match crate::links::link_path(&link, "") {
            Some(Ok(path)) => path,
            // A relative literal can depend on the source folder. Without a
            // source record at compile time, retain the full residual instead.
            Some(Err(())) => return Lowered::all(),
            None => link.target,
        };
        let mut keys = vec![crate::links::name_index_key(self.catalog, &canonical)];
        // Old indexes used raw basenames. A source link ending in '.', '..'
        // or '/' may normalize to this target; retain those records too until
        // their metadata is rebuilt. This is intentionally over-approximate.
        for raw in [".", "..", ""] {
            keys.push(crate::links::name_index_key(self.catalog, raw));
        }
        keys.sort();
        keys.dedup();
        Lowered {
            candidate: Candidate::LinksTo(keys),
            complete: false,
        }
    }
}

fn is_ident(e: &Expr, name: &str) -> bool {
    matches!(e, Expr::Ident(n) if n == name)
}

fn lit_of(e: &Expr) -> Option<Value> {
    match e {
        Expr::Lit(v) => literal(v),
        Expr::List(items) => items
            .iter()
            .map(|i| match i {
                Expr::Lit(v) => literal(v),
                _ => None,
            })
            .collect::<Option<Vec<_>>>()
            .map(Value::List),
        _ => None,
    }
}

fn literal(v: &CelValue) -> Option<Value> {
    match v {
        CelValue::Null | CelValue::Bool(_) | CelValue::Int(_) | CelValue::String(_) => v.to_value(),
        _ => None,
    }
}

/// What a store may conclude from a false comparison.
fn pruning(op: CompareOp, lit: &Value, field: &FieldRef) -> Pruning {
    if matches!(field, FieldRef::Effective(_)) {
        return Pruning::Conservative;
    }
    match (op, lit) {
        // String and boolean (in)equality is plain JSON equality in CEL, and a
        // missing field reads null, which is "not equal" on both sides.
        (CompareOp::Eq | CompareOp::Ne, Value::Text(_) | Value::Bool(_)) => Pruning::Exact,
        (CompareOp::Lt | CompareOp::Le | CompareOp::Gt | CompareOp::Ge, Value::Text(s))
            if is_iso_date(s) =>
        {
            Pruning::IsoDate
        }
        _ => Pruning::Conservative,
    }
}

fn is_iso_date(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

fn compare_term(field: FieldRef, op: CompareOp, value: Value, pruning: Pruning) -> Lowered {
    let complete = pruning == Pruning::Exact && matches!(op, CompareOp::Eq | CompareOp::Ne);
    // A conservative term can never prune, so it adds nothing.
    if pruning == Pruning::Conservative {
        return Lowered::all();
    }
    Lowered {
        candidate: Candidate::Compare {
            field,
            op,
            value,
            pruning,
        },
        complete,
    }
}

/// `a ∧ b`, flattening and dropping `All`.
pub(super) fn and(a: Candidate, b: Candidate) -> Candidate {
    let mut terms = Vec::new();
    for c in [a, b] {
        match c {
            Candidate::All => {}
            Candidate::And(ts) => terms.extend(ts),
            other => terms.push(other),
        }
    }
    match terms.len() {
        0 => Candidate::All,
        1 => terms.pop().unwrap_or(Candidate::All),
        _ => Candidate::And(terms),
    }
}
