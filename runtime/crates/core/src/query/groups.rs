//! Canonical pre-window grouping and reductions (spec 11).
//! The caller supplies the complete authorized match set in canonical query order.
//! This kernel bounds metadata separately from the caller's hydration/source budget.
use super::{Direction, FieldRef, OrderTerm, QueryEnv, QueryError, indexed};
use crate::cel::{CelValue, Program};
use crate::validate::{Issue, Severity, Tier};
use crate::value::{Map, Value};
use std::cmp::Ordering;
use std::sync::Arc;

/// Maximum grouping and summary fields combined.
pub const MAX_FIELDS: usize = 64;
/// Maximum rows admitted by the materialized reduction kernel.
pub const MAX_ROWS: usize = 1000;
/// Maximum logical retained metadata payload, independently of source bytes.
pub const MAX_BYTES: usize = 1 << 20;
/// Maximum metadata value nodes; scalar sizes alone do not bound containers.
pub const MAX_NODES: usize = 4096;

fn invalid(message: impl Into<String>, location: &str) -> QueryError {
    QueryError {
        code: "invalid_query".into(),
        message: message.into(),
        location: Some(location.into()),
    }
}
fn budget_error() -> QueryError {
    QueryError {
        code: "query_budget_exceeded".into(),
        message: "complete grouping/summary metadata exceeds its bounded profile".into(),
        location: None,
    }
}
/// Request-wide metadata accounting. Charge before retaining another row/value.
#[derive(Debug, Default)]
pub struct Budget {
    rows: usize,
    bytes: usize,
    nodes: usize,
}
impl Budget {
    fn node(&mut self, bytes: usize) -> Result<(), QueryError> {
        self.bytes = self.bytes.checked_add(bytes).ok_or_else(budget_error)?;
        self.nodes = self.nodes.checked_add(1).ok_or_else(budget_error)?;
        if self.bytes > MAX_BYTES || self.nodes > MAX_NODES {
            return Err(budget_error());
        }
        Ok(())
    }
    pub(crate) fn value(&mut self, v: &Value) -> Result<(), QueryError> {
        self.node(32)?;
        match v {
            Value::Text(s) => {
                self.bytes = self.bytes.checked_add(s.len()).ok_or_else(budget_error)?;
            }
            Value::List(a) => {
                for v in a {
                    self.value(v)?;
                }
            }
            Value::Map(m) => {
                for (k, v) in m.iter() {
                    self.node(k.len().checked_add(64).ok_or_else(budget_error)?)?;
                    self.value(v)?;
                }
            }
            _ => {}
        }
        if self.bytes > MAX_BYTES {
            return Err(budget_error());
        }
        Ok(())
    }
    fn native(&mut self, v: &CelValue) -> Result<(), QueryError> {
        self.node(32)?;
        match v {
            CelValue::String(s) => {
                self.bytes = self.bytes.checked_add(s.len()).ok_or_else(budget_error)?
            }
            CelValue::Bytes(b) => {
                self.bytes = self.bytes.checked_add(b.len()).ok_or_else(budget_error)?
            }
            CelValue::List(a) => {
                for v in a.iter() {
                    self.native(v)?;
                }
            }
            CelValue::Map(m) => {
                for (k, v) in m.iter() {
                    let n = match k {
                        crate::cel::Key::String(s) => s.len(),
                        _ => 16,
                    };
                    self.node(n.checked_add(64).ok_or_else(budget_error)?)?;
                    self.native(v)?;
                }
            }
            CelValue::Optional(Some(v)) => self.native(v)?,
            _ => {}
        }
        if self.bytes > MAX_BYTES {
            return Err(budget_error());
        }
        Ok(())
    }
    /// Charge a matching row before retaining it across evaluation steps.
    pub fn row(&mut self, row: &Row) -> Result<(), QueryError> {
        self.rows = self.rows.checked_add(1).ok_or_else(budget_error)?;
        if self.rows > MAX_ROWS {
            return Err(budget_error());
        }
        for v in row.keys.iter().chain(&row.inputs) {
            self.value(&v.value)?;
            self.native(&v.native)?;
        }
        Ok(())
    }
}
/// A trusted field/projection/selection value, preserving native CEL temporal types.
#[derive(Debug, Clone)]
pub struct Input {
    value: Value,
    native: CelValue,
    hint: indexed::TemporalHint,
}
impl PartialEq for Input {
    fn eq(&self, other: &Self) -> bool {
        let temporal = |i: &Input| {
            i.hint != indexed::TemporalHint::None
                && indexed::SortAtom::from_value(Some(&i.value), i.hint, 12)
                    .is_ok_and(|a| a.kind() == indexed::AtomKind::Temporal)
        };
        let (a, b) = (temporal(self), temporal(other));
        if a || b {
            return a
                && b
                && indexed::compare_typed(
                    Some(&self.value),
                    self.hint,
                    Some(&other.value),
                    other.hint,
                ) == Ok(Ordering::Equal);
        }
        self.native.equals(&other.native)
    }
}
impl Input {
    pub(crate) fn new(
        value: &Value,
        native: CelValue,
        hint: indexed::TemporalHint,
        budget: &mut Budget,
    ) -> Result<Self, QueryError> {
        budget.value(value)?;
        budget.native(&native)?;
        indexed::SortAtom::from_value(Some(value), hint, MAX_BYTES).map_err(|_| budget_error())?;
        Ok(Self {
            value: value.clone(),
            native,
            hint,
        })
    }
}
/// One matching row's grouping keys and reduction inputs, in compiled field order.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Row {
    /// Group tuple, in group_by order.
    pub keys: Vec<Input>,
    /// Summary inputs, in summaries order.
    pub inputs: Vec<Input>,
}
/// A summary implementation.
#[derive(Debug, Clone)]
pub enum SummaryFn {
    /// Portable built-in identifier.
    Builtin(&'static str),
    /// Compiled CEL over the ordered native `values` list.
    Custom(Arc<Program>),
}
/// One compiled summary.
#[derive(Debug, Clone)]
pub struct CompiledSummary {
    /// Input field.
    pub field: FieldRef,
    /// Reduction function.
    pub function: SummaryFn,
    /// Unique output name.
    pub name: String,
}
impl PartialEq for CompiledSummary {
    fn eq(&self, other: &Self) -> bool {
        self.field == other.field && self.name == other.name
    }
}
const BUILTINS: &[&str] = &[
    "count", "sum", "average", "minimum", "maximum", "earliest", "latest", "empty", "filled",
];

/// Parse custom summary functions, accepting a CEL string or `{expr: string}`.
pub fn parse_functions(v: Option<&Value>) -> Result<Vec<(String, String)>, QueryError> {
    let Some(v) = v else {
        return Ok(vec![]);
    };
    let m = v
        .as_map()
        .ok_or_else(|| invalid("summary_functions is a mapping", "summary_functions"))?;
    if m.len() > MAX_FIELDS {
        return Err(budget_error());
    }
    m.iter()
        .map(|(name, def)| {
            let expr = def
                .as_str()
                .or_else(|| def.get("expr").and_then(Value::as_str))
                .ok_or_else(|| {
                    invalid(
                        "a summary function needs expr",
                        &format!("summary_functions.{name}"),
                    )
                })?;
            Ok((name.to_owned(), expr.to_owned()))
        })
        .collect()
}
/// Parse group_by using the same field/direction syntax as order_by.
pub fn parse_group_by(v: Option<&Value>) -> Result<Vec<OrderTerm>, QueryError> {
    let Some(v) = v else {
        return Ok(vec![]);
    };
    let terms = v
        .as_list()
        .ok_or_else(|| invalid("group_by is a list", "group_by"))?;
    if terms.len() > MAX_FIELDS {
        return Err(budget_error());
    }
    terms
        .iter()
        .enumerate()
        .map(|(i, t)| {
            let loc = format!("group_by[{i}]");
            let field = t
                .get("field")
                .and_then(Value::as_str)
                .and_then(super::parse_field_ref)
                .ok_or_else(|| invalid("field names a field", &loc))?;
            let direction = match t.get("direction") {
                None => Direction::Asc,
                Some(Value::Text(s)) if s == "asc" => Direction::Asc,
                Some(Value::Text(s)) if s == "desc" => Direction::Desc,
                _ => return Err(invalid("direction is asc or desc", &loc)),
            };
            Ok(OrderTerm { field, direction })
        })
        .collect()
}
/// Compile every custom expression and validate unique summary output names up front.
pub fn compile(
    summaries: &[Value],
    functions: &[(String, String)],
) -> Result<Vec<CompiledSummary>, QueryError> {
    if summaries.len() > MAX_FIELDS || functions.len() > MAX_FIELDS {
        return Err(budget_error());
    }
    let mut custom = Vec::new();
    for (name, expr) in functions {
        if custom.iter().any(|(n, _)| n == name) {
            return Err(invalid("duplicate summary function", "summary_functions"));
        }
        let p = crate::cel::compile(expr)
            .map_err(|e| invalid(e.to_string(), &format!("summary_functions.{name}")))?;
        custom.push((name.clone(), Arc::new(p)));
    }
    let mut out: Vec<CompiledSummary> = Vec::new();
    for (i, s) in summaries.iter().enumerate() {
        let loc = format!("summaries[{i}]");
        let field = s
            .get("field")
            .and_then(Value::as_str)
            .and_then(super::parse_field_ref)
            .ok_or_else(|| invalid("a summary needs field", &loc))?;
        let fname = s
            .get("function")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("a summary needs function", &loc))?;
        let function = if let Some((_, p)) = custom.iter().find(|(n, _)| n == fname) {
            SummaryFn::Custom(p.clone())
        } else if let Some(b) = BUILTINS.iter().find(|b| **b == fname) {
            SummaryFn::Builtin(b)
        } else {
            return Err(invalid(format!("unknown summary function {fname}"), &loc));
        };
        let name = match s.get("name") {
            None => fname,
            Some(v) => v
                .as_str()
                .ok_or_else(|| invalid("name is a string", &loc))?,
        }
        .to_owned();
        if out.iter().any(|s| s.name == name) {
            return Err(invalid(format!("duplicate summary output {name}"), &loc));
        }
        out.push(CompiledSummary {
            field,
            function,
            name,
        });
    }
    Ok(out)
}
/// One complete filtered group; no duplicate record bodies or IDs.
#[derive(Debug, Clone, PartialEq)]
pub struct Group {
    /// Named grouping tuple, empty for summaries without grouping.
    pub values: Map,
    /// Complete group count before pagination.
    pub count: u64,
    /// Canonical named reduction outputs.
    pub summaries: Map,
}
fn empty(v: &Value) -> bool {
    match v {
        Value::Null => true,
        Value::Text(s) => s.is_empty(),
        Value::List(a) => a.is_empty(),
        Value::Map(m) => m.is_empty(),
        _ => false,
    }
}
fn summarize(
    s: &CompiledSummary,
    inputs: &[&Input],
    env: &QueryEnv,
    diagnostics: &mut Vec<Issue>,
) -> Result<Value, QueryError> {
    let fail = |diagnostics: &mut Vec<Issue>, message: &str| {
        diagnostics.push(Issue::new(
            "expression_evaluation_error",
            Severity::Warning,
            Tier::CrossRecord,
            format!("summary {}: {message}", s.name),
        ));
        Value::Null
    };
    let present: Vec<_> = inputs
        .iter()
        .copied()
        .filter(|i| !i.value.is_null())
        .collect();
    let result = match &s.function {
        SummaryFn::Builtin("count") => {
            Value::Int(i64::try_from(inputs.len()).map_err(|_| budget_error())?)
        }
        SummaryFn::Builtin(b @ ("empty" | "filled")) => Value::Int(
            i64::try_from(
                inputs
                    .iter()
                    .filter(|i| empty(&i.value) == (*b == "empty"))
                    .count(),
            )
            .map_err(|_| budget_error())?,
        ),
        SummaryFn::Builtin(b @ ("sum" | "average")) => {
            if present.is_empty() {
                Value::Null
            } else if !present.iter().all(|i| i.value.as_number().is_some()) {
                fail(diagnostics, "incompatible values")
            } else if *b == "sum" && present.iter().all(|i| matches!(i.value, Value::Int(_))) {
                match present.iter().try_fold(0i64, |sum, i| match i.value {
                    Value::Int(v) => sum.checked_add(v),
                    _ => None,
                }) {
                    Some(v) => Value::Int(v),
                    None => fail(diagnostics, "integer sum overflow"),
                }
            } else {
                #[allow(clippy::cast_precision_loss)]
                let n = present.len() as f64;
                let sum: f64 = present
                    .iter()
                    .map(|i| match i.value {
                        #[allow(clippy::cast_precision_loss)]
                        Value::Int(v) => v as f64,
                        Value::Float(v) => v,
                        _ => unreachable!(),
                    })
                    .sum();
                Value::float(if *b == "average" { sum / n } else { sum })
                    .unwrap_or_else(|| fail(diagnostics, "non-finite sum"))
            }
        }
        SummaryFn::Builtin(b @ ("minimum" | "maximum" | "earliest" | "latest")) => {
            if present.is_empty() {
                Value::Null
            } else {
                let kind = |i: &Input| {
                    indexed::SortAtom::from_value(Some(&i.value), i.hint, MAX_BYTES)
                        .map(|a| a.kind())
                };
                let first = kind(present[0]).map_err(|_| budget_error())?;
                let allowed =
                    matches!(first, indexed::AtomKind::Text | indexed::AtomKind::Temporal)
                        || (matches!(*b, "minimum" | "maximum")
                            && first == indexed::AtomKind::Number);
                if !allowed || !present.iter().all(|i| kind(i) == Ok(first)) {
                    fail(diagnostics, "incompatible values")
                } else {
                    let want = if matches!(*b, "minimum" | "earliest") {
                        Ordering::Less
                    } else {
                        Ordering::Greater
                    };
                    let mut best = present[0];
                    for i in &present[1..] {
                        if indexed::compare_typed(
                            Some(&i.value),
                            i.hint,
                            Some(&best.value),
                            best.hint,
                        )
                        .map_err(|_| budget_error())?
                            == want
                        {
                            best = i;
                        }
                    }
                    best.value.clone()
                }
            }
        }
        SummaryFn::Builtin(_) => unreachable!("only compiled built-ins"),
        SummaryFn::Custom(p) => {
            let mut act = crate::cel::Activation::new();
            act.bind(
                "values",
                CelValue::List(Arc::new(inputs.iter().map(|i| i.native.clone()).collect())),
            );
            act.with_clock(crate::lifecycle::cel_clock(env.now_ms, &env.today, &env.tz));
            match p.evaluate(&act) {
                Ok(v) => {
                    Budget::default().native(&v)?;
                    v.to_value()
                        .unwrap_or_else(|| fail(diagnostics, "non-representable result"))
                }
                Err(e) => fail(diagnostics, &e.to_string()),
            }
        }
    };
    Ok(result)
}
/// Reduce the complete authorized, canonically ordered match set. Any bound/arity
/// failure rejects the whole reduction, never returns a truncated prefix.
pub fn reduce(
    group_by: &[OrderTerm],
    summaries: &[CompiledSummary],
    rows: &[&Row],
    env: &QueryEnv,
    diagnostics: &mut Vec<Issue>,
) -> Result<Option<Vec<Group>>, QueryError> {
    if group_by.is_empty() && summaries.is_empty() {
        return Ok(None);
    }
    if group_by.len().saturating_add(summaries.len()) > MAX_FIELDS {
        return Err(budget_error());
    }
    let mut admitted = Budget::default();
    for r in rows {
        if r.keys.len() != group_by.len() || r.inputs.len() != summaries.len() {
            return Err(invalid("reduction input arity mismatch", "summaries"));
        }
        admitted.row(r)?;
    }
    let mut buckets: Vec<(Vec<Input>, Vec<&Row>)> = Vec::new();
    for r in rows {
        if let Some((_, members)) = buckets.iter_mut().find(|(keys, _)| keys == &r.keys) {
            members.push(r);
        } else {
            buckets.push((r.keys.clone(), vec![r]));
        }
    }
    if buckets.is_empty() && group_by.is_empty() {
        buckets.push((vec![], vec![]));
    }
    buckets.sort_by(|(a, _), (b, _)| {
        for ((a, b), t) in a.iter().zip(b).zip(group_by) {
            let o = indexed::compare_typed(Some(&a.value), a.hint, Some(&b.value), b.hint)
                .expect("admitted values");
            let o = if t.direction == Direction::Desc {
                o.reverse()
            } else {
                o
            };
            if o != Ordering::Equal {
                return o;
            }
        }
        Ordering::Equal
    });
    let mut out = Vec::new();
    let mut output_budget = Budget::default();
    for (keys, members) in buckets {
        let mut values = Map::new();
        for (term, key) in group_by.iter().zip(keys) {
            output_budget.value(&key.value)?;
            let name = super::projection::output_name(&term.field);
            output_budget.node(name.len().saturating_add(64))?;
            values.insert(name, key.value);
        }
        let mut reductions = Map::new();
        for (i, s) in summaries.iter().enumerate() {
            let inputs: Vec<_> = members.iter().map(|r| &r.inputs[i]).collect();
            let result = summarize(s, &inputs, env, diagnostics)?;
            output_budget.value(&result)?;
            output_budget.node(s.name.len().saturating_add(64))?;
            reductions.insert(s.name.clone(), result);
        }
        output_budget.node(64)?;
        out.push(Group {
            values,
            count: u64::try_from(members.len()).map_err(|_| budget_error())?,
            summaries: reductions,
        });
    }
    Ok(Some(out))
}
