//! Candidate pushdown: the query IR's candidate part as SQL over `rs_terms`.
//!
//! The input is core-B's candidate/residual IR ([`mdbn_core::query::Candidate`],
//! re-exported as `mdbn_replica::store::Candidate`). Field comparisons are pushed
//! down on `FieldRef::Persisted` top-level keys: `rs_terms` holds the persisted
//! frontmatter the replica supplies in `RecordMeta::effective`. Effective values
//! (with type defaults) are the residual's business.
//!
//! **Superset, never subset.** Each translation returns SQL plus whether it is
//! *exact* (selects precisely the records the term holds for). Anything the index
//! can't decide exactly becomes `TRUE` (inexact). `Not` is pushed down only over
//! an exact term, because the negation of a superset would be a subset. The
//! replica (or the core's residual) still evaluates every candidate unless the
//! whole plan is exact. No semantics are re-implemented here: tag folding, null
//! and missing handling, and CEL stay in the core so SQL lowering cannot
//! re-implement or diverge from replicated semantics.

use mdbn_core::query::{Candidate as CoreCandidate, CompareOp, FieldRef, Pruning};
use mdbn_core::value::Value as CoreValue;
use mdbn_wire::common::Value;
use postgres::types::ToSql;

use crate::codec::{exact_f64, value_columns};
use crate::schema::kind;

/// Bound parameters. `$1` is always the collection key.
pub struct Params(pub Vec<Box<dyn ToSql + Sync>>);

impl Params {
    /// Parameters starting with the collection key.
    pub fn new(c: i64) -> Params {
        Params(vec![Box::new(c)])
    }

    /// Bind a value; returns its placeholder.
    pub fn bind(&mut self, v: impl ToSql + Sync + 'static) -> String {
        self.0.push(Box::new(v));
        format!("${}", self.0.len())
    }

    /// References for a query call.
    pub fn refs(&self) -> Vec<&(dyn ToSql + Sync)> {
        self.0
            .iter()
            .map(|b| b.as_ref() as &(dyn ToSql + Sync))
            .collect()
    }
}

fn term(p: &mut Params, k: i16, k1: &str, extra: &str) -> String {
    let k1 = p.bind(k1.to_string());
    format!(
        "r.id IN (SELECT t.id FROM rs_terms t WHERE t.c = $1 AND t.kind = {k} AND t.k1 = {k1}{extra})"
    )
}

fn starts_with(p: &mut Params, prefix: &str) -> String {
    if prefix.is_empty() {
        return "TRUE".into();
    }
    let a = p.bind(prefix.to_string());
    // The range lets the (c, path) index narrow; starts_with makes it exact.
    format!("(r.path >= {a} AND starts_with(r.path, {a}))")
}

fn join(parts: Vec<String>, op: &str) -> String {
    if parts.is_empty() {
        return if op == "AND" { "TRUE" } else { "FALSE" }.into();
    }
    format!("({})", parts.join(&format!(" {op} ")))
}

/// SQL for the core's candidate, over `rs_records r`: `(sql, exact)`.
pub fn core_where(c: &CoreCandidate, p: &mut Params) -> (String, bool) {
    match c {
        CoreCandidate::All => ("TRUE".into(), true),
        CoreCandidate::None => ("FALSE".into(), true),
        CoreCandidate::And(cs) => {
            let mut exact = true;
            let parts = cs
                .iter()
                .map(|c| {
                    let (s, e) = core_where(c, p);
                    exact &= e;
                    s
                })
                .collect();
            (join(parts, "AND"), exact)
        }
        CoreCandidate::Or(cs) => {
            let mut exact = true;
            let parts: Vec<String> = cs
                .iter()
                .map(|c| {
                    let (s, e) = core_where(c, p);
                    exact &= e;
                    s
                })
                .collect();
            (join(parts, "OR"), exact)
        }
        CoreCandidate::Not(inner) => {
            let mut scratch = Params(Vec::new());
            scratch.0.push(Box::new(0i64));
            // Only negate exact terms. Translate into a scratch list first so an
            // inexact inner term binds nothing.
            let (_, exact) = core_where(inner, &mut scratch);
            if exact {
                let (s, _) = core_where(inner, p);
                (format!("(NOT {s})"), true)
            } else {
                ("TRUE".into(), false)
            }
        }
        // The core lower-cases type names in candidates; the replica stores the
        // catalog's names. Compare case-insensitively (ASCII; a superset either way).
        CoreCandidate::HasType(t) => {
            let k1 = p.bind(t.to_string());
            (
                format!(
                    "r.id IN (SELECT t.id FROM rs_terms t WHERE t.c = $1 AND t.kind = {} AND lower(t.k1) = {k1})",
                    kind::TYPE
                ),
                false,
            )
        }
        CoreCandidate::InFolder(folder) => {
            let f = folder.trim_end_matches('/');
            if f.is_empty() {
                ("TRUE".into(), true)
            } else {
                (starts_with(p, &format!("{f}/")), true)
            }
        }
        CoreCandidate::Compare {
            field,
            op,
            value,
            pruning,
        } => compare(field, *op, value, *pruning, p),
        // Not pushed down yet (link-index and full-text terms); conservative.
        CoreCandidate::LinksTo(_) | CoreCandidate::BodyContains { .. } => ("TRUE".into(), false),
    }
}

fn top_level(field: &FieldRef) -> Option<&str> {
    match field {
        FieldRef::Persisted(path) if path.len() == 1 => Some(path[0].as_str()),
        _ => None,
    }
}

fn wire_value(v: &CoreValue) -> Option<Value> {
    Some(match v {
        CoreValue::Null => Value::Null,
        CoreValue::Bool(b) => Value::Bool(*b),
        CoreValue::Int(i) => Value::Int(*i),
        CoreValue::Text(s) => Value::Text(s.clone()),
        CoreValue::Float(_) | CoreValue::List(_) | CoreValue::Map(_) => return None,
    })
}

fn sql_op(op: CompareOp) -> Option<&'static str> {
    Some(match op {
        CompareOp::Lt => "<",
        CompareOp::Le => "<=",
        CompareOp::Gt => ">",
        CompareOp::Ge => ">=",
        _ => return None,
    })
}

/// One comparison term. Pushed down only where a plain comparison of the stored
/// value gives CEL's verdict (`Pruning::Exact`), or for ISO dates on text.
fn compare(
    field: &FieldRef,
    op: CompareOp,
    value: &CoreValue,
    pruning: Pruning,
    p: &mut Params,
) -> (String, bool) {
    let inexact = ("TRUE".to_string(), false);
    if pruning == Pruning::Conservative {
        return inexact;
    }
    let Some(key) = top_level(field) else {
        return inexact;
    };
    let iso = pruning == Pruning::IsoDate;
    match op {
        CompareOp::Eq if !iso => eq_term(key, kind::FIELD, value, p),
        // A missing field is "not equal" (the reference store agrees), so `!=` is
        // the negation of an exact `==`.
        CompareOp::Ne if !iso => {
            let mut scratch = Params(vec![Box::new(0i64)]);
            if eq_term(key, kind::FIELD, value, &mut scratch).1 {
                let (s, _) = eq_term(key, kind::FIELD, value, p);
                (format!("(NOT {s})"), true)
            } else {
                inexact
            }
        }
        CompareOp::Contains if !iso => eq_term(key, kind::ELEM, value, p),
        CompareOp::In if !iso => {
            let CoreValue::List(items) = value else {
                return inexact;
            };
            let mut exact = true;
            let parts = items
                .iter()
                .map(|v| {
                    let (s, e) = eq_term(key, kind::FIELD, v, p);
                    exact &= e;
                    s
                })
                .collect();
            (join(parts, "OR"), exact)
        }
        CompareOp::Lt | CompareOp::Le | CompareOp::Gt | CompareOp::Ge => {
            let Some(o) = sql_op(op) else { return inexact };
            match value {
                CoreValue::Text(s) => {
                    let lit = p.bind(s.clone());
                    let k1 = p.bind(key.to_string());
                    let cmp = format!(
                        "SELECT t.id FROM rs_terms t WHERE t.c = $1 AND t.kind = {} AND t.k1 = {k1} AND t.k2 {o} {lit}",
                        kind::FIELD
                    );
                    if iso {
                        // Stored values that aren't YYYY-MM-DD text stay candidates.
                        let others = format!(
                            "SELECT t.id FROM rs_terms t WHERE t.c = $1 AND t.kind = {} AND t.k1 = {k1} \
                             AND (t.k2 IS NULL OR t.k2 !~ '^[0-9]{{4}}-[0-9]{{2}}-[0-9]{{2}}$')",
                            kind::FIELD
                        );
                        (
                            format!(
                                "(r.id IN ({cmp}) OR r.id IN ({others}) OR NOT r.id IN (SELECT t.id FROM rs_terms t WHERE t.c = $1 AND t.kind = {} AND t.k1 = {k1}))",
                                kind::FIELD
                            ),
                            false,
                        )
                    } else {
                        (format!("r.id IN ({cmp})"), true)
                    }
                }
                CoreValue::Int(i) if !iso => match exact_f64(*i) {
                    Some(f) => {
                        let lit = p.bind(f);
                        let k1 = p.bind(key.to_string());
                        // Integers beyond 2^53 are stored without `num`: keep them.
                        (
                            format!(
                                "r.id IN (SELECT t.id FROM rs_terms t WHERE t.c = $1 AND t.kind = {k} AND t.k1 = {k1} \
                                 AND (t.num {o} {lit} OR (t.num IS NULL AND t.k2 IS NULL AND t.v IS NOT NULL)))",
                                k = kind::FIELD
                            ),
                            false,
                        )
                    }
                    None => inexact,
                },
                _ => inexact,
            }
        }
        _ => inexact,
    }
}

fn eq_term(key: &str, k: i16, value: &CoreValue, p: &mut Params) -> (String, bool) {
    let Some(v) = wire_value(value) else {
        return ("TRUE".into(), false);
    };
    // CEL `==` across int and float compares numerically; the bytes of Int(1) and
    // Float(1.0) differ. Match numbers on `num` as well, so no float record is
    // missed (a superset).
    match (&v, value_columns(&v)) {
        (Value::Int(_), (Some(bytes), _, Some(num))) => {
            let b = p.bind(bytes);
            let n = p.bind(num);
            let k1 = p.bind(key.to_string());
            (
                format!(
                    "r.id IN (SELECT t.id FROM rs_terms t WHERE t.c = $1 AND t.kind = {k} AND t.k1 = {k1} AND (t.v = {b} OR t.num = {n}))"
                ),
                false,
            )
        }
        (Value::Int(_), _) => ("TRUE".into(), false),
        (_, (Some(bytes), _, _)) => {
            let b = p.bind(bytes);
            (term(p, k, key, &format!(" AND t.v = {b}")), true)
        }
        _ => ("TRUE".into(), false),
    }
}
