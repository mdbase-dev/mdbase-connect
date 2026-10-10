//! Named projections and `select` (spec 11 "Named Projections",
//! "Selection").

use super::{FieldRef, QueryError, Selection, parse_field_ref};
use crate::cel::ast::Expr;
use crate::value::Value;

fn invalid(message: impl Into<String>, location: &str) -> QueryError {
    QueryError {
        code: "invalid_query".into(),
        message: message.into(),
        location: Some(location.into()),
    }
}

/// A compiled projection.
#[derive(Debug, Clone)]
pub struct CompiledProjection {
    /// The name.
    pub name: String,
    /// The compiled expression.
    pub program: std::sync::Arc<crate::cel::Program>,
}

impl PartialEq for CompiledProjection {
    /// Plans compare by their query; the program follows from its source.
    fn eq(&self, other: &CompiledProjection) -> bool {
        self.name == other.name
    }
}

/// What one selection produces.
#[derive(Debug, Clone)]
pub enum SelectSource {
    /// A field, file value or projection.
    Field(FieldRef),
    /// A CEL expression.
    Expr(std::sync::Arc<crate::cel::Program>),
}

/// A compiled selection.
#[derive(Debug, Clone)]
pub struct CompiledSelection {
    /// Output name (the key in `values`).
    pub name: String,
    /// Display label, when given.
    pub label: Option<String>,
    /// Where the value comes from.
    pub source: SelectSource,
}

impl PartialEq for CompiledSelection {
    /// Plans compare by their query; the program follows from its source.
    fn eq(&self, other: &CompiledSelection) -> bool {
        self.name == other.name && self.label == other.label
    }
}

/// Names under `projection.` or literal `projection["name"]` an expression reads.
fn projection_refs(e: &Expr, out: &mut Vec<String>) {
    match e {
        Expr::Select { operand, field, .. } => {
            if matches!(operand.as_ref(), Expr::Ident(n) if n == "projection") {
                out.push(field.clone());
            } else {
                projection_refs(operand, out);
            }
        }
        Expr::Index { operand, index, .. } => {
            if matches!(operand.as_ref(), Expr::Ident(n) if n == "projection")
                && let Expr::Lit(crate::cel::CelValue::String(name)) = index.as_ref()
            {
                out.push(name.to_string());
            }
            projection_refs(operand, out);
            projection_refs(index, out);
        }
        Expr::Call { target, args, .. } => {
            if let Some(t) = target {
                projection_refs(t, out);
            }
            for a in args {
                projection_refs(a, out);
            }
        }
        Expr::MatchesLit { text, .. } => projection_refs(text, out),
        Expr::List(items) => items.iter().for_each(|i| projection_refs(i, out)),
        Expr::Map(entries) => {
            for (k, v) in entries {
                projection_refs(k, out);
                projection_refs(v, out);
            }
        }
        Expr::Not(x) | Expr::Neg(x) => projection_refs(x, out),
        Expr::Bin(_, a, b) | Expr::And(a, b) | Expr::Or(a, b) => {
            projection_refs(a, out);
            projection_refs(b, out);
        }
        Expr::Cond(c, a, b) => {
            projection_refs(c, out);
            projection_refs(a, out);
            projection_refs(b, out);
        }
        Expr::Macro {
            range,
            body,
            filter,
            ..
        } => {
            projection_refs(range, out);
            projection_refs(body, out);
            if let Some(f) = filter {
                projection_refs(f, out);
            }
        }
        _ => {}
    }
}

/// Compile the projections in dependency order (declaration order among the
/// ready ones). Unknown references and cycles are `invalid_query`.
pub fn compile_projections(
    decls: &[(String, String)],
) -> Result<Vec<CompiledProjection>, QueryError> {
    let mut compiled: Vec<(String, std::sync::Arc<crate::cel::Program>, Vec<String>)> = Vec::new();
    for (name, src) in decls {
        let loc = format!("projections.{name}");
        if compiled.iter().any(|(n, _, _)| n == name) {
            return Err(invalid(format!("duplicate projection `{name}`"), &loc));
        }
        let p = crate::cel::compile(src).map_err(|e| invalid(format!("`{name}`: {e}"), &loc))?;
        let mut deps = Vec::new();
        projection_refs(p.ast(), &mut deps);
        compiled.push((name.clone(), std::sync::Arc::new(p), deps));
    }
    for (name, _, deps) in &compiled {
        if let Some(d) = deps
            .iter()
            .find(|d| !compiled.iter().any(|(n, _, _)| n == *d))
        {
            return Err(invalid(
                format!("`{name}` reads unknown projection `{d}`"),
                &format!("projections.{name}"),
            ));
        }
    }
    let mut out: Vec<CompiledProjection> = Vec::new();
    while out.len() < compiled.len() {
        let next = compiled.iter().find(|(n, _, deps)| {
            !out.iter().any(|o| o.name == *n)
                && deps.iter().all(|d| out.iter().any(|o| o.name == *d))
        });
        match next {
            Some((n, p, _)) => out.push(CompiledProjection {
                name: n.clone(),
                program: p.clone(),
            }),
            None => {
                return Err(invalid(
                    "projections depend on each other in a cycle",
                    "projections",
                ));
            }
        }
    }
    Ok(out)
}

/// Compile `select`. Duplicate output names are `invalid_query`.
pub fn compile_select(
    select: &[Selection],
    projections: &[CompiledProjection],
) -> Result<Vec<CompiledSelection>, QueryError> {
    let mut out: Vec<CompiledSelection> = Vec::new();
    for (i, s) in select.iter().enumerate() {
        let loc = format!("select[{i}]");
        let c = match s {
            Selection::Field(f) => {
                if let FieldRef::Projection(p) = f
                    && !projections.iter().any(|x| x.name == *p)
                {
                    return Err(invalid(format!("unknown projection `{p}`"), &loc));
                }
                CompiledSelection {
                    name: output_name(f),
                    label: None,
                    source: SelectSource::Field(f.clone()),
                }
            }
            Selection::Expr { name, expr, label } => CompiledSelection {
                name: name.clone(),
                label: label.clone(),
                source: SelectSource::Expr(std::sync::Arc::new(
                    crate::cel::compile(expr).map_err(|e| invalid(e.to_string(), &loc))?,
                )),
            },
        };
        if out.iter().any(|o| o.name == c.name) {
            return Err(invalid(
                format!("two selections are named `{}`", c.name),
                &loc,
            ));
        }
        out.push(c);
    }
    Ok(out)
}

/// The output name of a field selector (spec 11): the effective field name,
/// or the final member of `file.<name>` / `projection.<name>`.
pub fn output_name(f: &FieldRef) -> String {
    match f {
        FieldRef::Path => "path".into(),
        FieldRef::File(n) | FieldRef::Projection(n) => n.clone(),
        FieldRef::Types => "types".into(),
        FieldRef::Effective(p) | FieldRef::Persisted(p) => p.join("."),
    }
}

/// Projection declarations `(name, CEL source)` and selections.
pub type Parsed = (Vec<(String, String)>, Vec<Selection>);

/// Parse `projections` and `select` members of a query object.
pub fn parse(m: &crate::value::Map) -> Result<Parsed, QueryError> {
    let mut projections = Vec::new();
    match m.get("projections") {
        None => {}
        Some(Value::Map(p)) => {
            for (name, def) in p.iter() {
                let src = match def {
                    Value::Text(s) => s.clone(),
                    other => other
                        .get("expr")
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            invalid("a projection needs `expr`", &format!("projections.{name}"))
                        })?
                        .to_owned(),
                };
                projections.push((name.to_owned(), src));
            }
        }
        Some(_) => return Err(invalid("`projections` is a mapping", "projections")),
    }
    let mut select = Vec::new();
    match m.get("select") {
        None => {}
        Some(Value::List(items)) => {
            for (i, item) in items.iter().enumerate() {
                let loc = format!("select[{i}]");
                select.push(match item {
                    Value::Text(s) => Selection::Field(
                        parse_field_ref(s)
                            .ok_or_else(|| invalid(format!("bad selector `{s}`"), &loc))?,
                    ),
                    Value::Map(o) => Selection::Expr {
                        name: o
                            .get("name")
                            .and_then(Value::as_str)
                            .ok_or_else(|| invalid("a selection object needs `name`", &loc))?
                            .to_owned(),
                        expr: o
                            .get("expr")
                            .and_then(Value::as_str)
                            .ok_or_else(|| invalid("a selection object needs `expr`", &loc))?
                            .to_owned(),
                        label: o.get("label").and_then(Value::as_str).map(str::to_owned),
                    },
                    _ => return Err(invalid("a selection is a string or an object", &loc)),
                });
            }
        }
        Some(_) => return Err(invalid("`select` is a list", "select")),
    }
    Ok((projections, select))
}
