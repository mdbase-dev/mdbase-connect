//! Pure eligibility/lowering for materialized-index membership and ordering.
//! This is NOT whole-query execution, diagnostics, authorization or metadata proof.
//! Unsupported CEL is rejected; never reparsed by stores or partially called exact.
use super::indexed::{AtomKind, IndexFieldSpec, SortAtom, TemporalHint};
use super::{Direction, FieldRef, QueryPlan, projection};
use crate::cel::CelValue;
use crate::cel::ast::{BinOp, Expr};
use crate::types::Catalog;
use crate::value::Value;

/// Hard profile complexity bound (backend parameter/admission bounds also apply).
pub const MAX_TERMS: usize = 64;
/// Maximum aggregate retained literal keys.
pub const MAX_LITERAL_BYTES: usize = 1 << 20;
/// Why the complete membership/order profile is unavailable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unsupported {
    /// Expression outside the closed profile.
    Expression,
    /// Unmaterializable field.
    Field,
    /// Computed or unsupported ordering.
    Order,
    /// Complexity/key budget exhausted.
    Budget,
    /// Type-name folding is not proven equivalent.
    Types,
}
/// A physical column. Field identity uses structural paths, not dotted aliases.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Column {
    /// Exact UTF-8 file path.
    Path,
    /// Trusted current effective frontmatter atom.
    Field(IndexFieldSpec),
}
/// Scalar comparison; not total cross-kind ordering.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Compare {
    /// Equal.
    Eq,
    /// Less than.
    Lt,
    /// Less or equal.
    Le,
    /// Greater than.
    Gt,
    /// Greater or equal.
    Ge,
}
impl Compare {
    fn reversed(self) -> Self {
        match self {
            Self::Eq => Self::Eq,
            Self::Lt => Self::Gt,
            Self::Le => Self::Ge,
            Self::Gt => Self::Lt,
            Self::Ge => Self::Le,
        }
    }
}
/// Closed exact MATCH-membership predicate over complete trusted materialization.
/// Every comparison requires operand kind equality; Number includes exact i64/f64.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Predicate {
    /// Every live row.
    All,
    /// No row.
    None,
    /// Scalar comparison with a mandatory kind gate.
    Compare {
        /// Physical column.
        column: Column,
        /// Comparison operator.
        op: Compare,
        /// Exact scalar kind/key.
        value: SortAtom,
    },
    /// All match; CEL errors exclude a row and need residual diagnostics separately.
    And(Vec<Predicate>),
    /// Any match; canonical CEL decisive true branches suppress leaf errors.
    /// Exact diagnostics still require residual evaluation when ranges occur.
    Or(Vec<Predicate>),
    /// Complement. Only ever built over a subtree that cannot raise a CEL error
    /// (bare-identifier equality), so "not matched" is exactly "evaluated false".
    Not(Box<Predicate>),
}
/// One explicit order term; callers append record ID ASC in both directions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Order {
    /// Physical atom or exact path.
    pub column: Column,
    /// Reverse this term only, not final ID.
    pub direction: Direction,
}
/// Membership/order proof, never a full executor feature flag.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Profile {
    /// Canonical catalogue membership names, OR semantics, preserving stored case.
    pub types: Vec<String>,
    /// Complete compiled-where match predicate.
    pub predicate: Predicate,
    /// Canonical explicit order terms.
    pub order: Vec<Order>,
    /// False when ranges or explicit record lookups could produce CEL diagnostics.
    /// Membership remains exact, but emitting exact diagnostics needs residual work.
    pub diagnostics_exact: bool,
}
struct Lower<'a> {
    terms: usize,
    literal_bytes: usize,
    catalog: &'a Catalog,
}
struct Leaf {
    predicate: Predicate,
    can_error: bool,
}
impl Lower<'_> {
    fn term(&mut self) -> Result<(), Unsupported> {
        self.terms = self.terms.checked_add(1).ok_or(Unsupported::Budget)?;
        if self.terms > MAX_TERMS {
            return Err(Unsupported::Budget);
        }
        Ok(())
    }
    fn expr(&mut self, e: &Expr) -> Result<Leaf, Unsupported> {
        self.term()?;
        match e {
            Expr::Lit(CelValue::Bool(b)) => Ok(Leaf {
                predicate: if *b { Predicate::All } else { Predicate::None },
                can_error: false,
            }),
            Expr::And(a, b) | Expr::Or(a, b) => {
                let (a, b) = (self.expr(a)?, self.expr(b)?);
                let can_error = a.can_error || b.can_error;
                let predicate = if matches!(e, Expr::And(..)) {
                    Predicate::And(vec![a.predicate, b.predicate])
                } else {
                    Predicate::Or(vec![a.predicate, b.predicate])
                };
                Ok(Leaf {
                    predicate,
                    can_error,
                })
            }
            // CEL `!p`: the complement, only where `p` cannot error (an error is
            // neither true nor false, and the index cannot represent it).
            Expr::Not(inner) => {
                let inner = self.expr(inner)?;
                self.negate(inner)
            }
            // `x != v` is `!(x == v)` in CEL (heterogeneous equality is total).
            Expr::Bin(BinOp::Ne, a, b) => {
                let eq = self.compare(BinOp::Eq, a, b)?;
                self.negate(eq)
            }
            // `x in [v, ...]`: equality with any listed literal.
            Expr::Bin(BinOp::In, a, b) => {
                let Expr::List(items) = b.as_ref() else {
                    return Err(Unsupported::Expression);
                };
                let mut any = Vec::with_capacity(items.len());
                let mut can_error = false;
                for item in items {
                    self.term()?;
                    let leaf = self.compare(BinOp::Eq, a, item)?;
                    can_error |= leaf.can_error;
                    any.push(leaf.predicate);
                }
                Ok(Leaf {
                    predicate: Predicate::Or(any),
                    can_error,
                })
            }
            Expr::Bin(op, a, b) => self.compare(*op, a, b),
            _ => Err(Unsupported::Expression),
        }
    }
    fn negate(&mut self, leaf: Leaf) -> Result<Leaf, Unsupported> {
        if leaf.can_error {
            return Err(Unsupported::Expression);
        }
        Ok(Leaf {
            predicate: match leaf.predicate {
                Predicate::All => Predicate::None,
                Predicate::None => Predicate::All,
                Predicate::Not(p) => *p,
                p => Predicate::Not(Box::new(p)),
            },
            can_error: false,
        })
    }
    fn compare(&mut self, op: BinOp, a: &Expr, b: &Expr) -> Result<Leaf, Unsupported> {
        let op = match op {
            BinOp::Eq => Compare::Eq,
            BinOp::Lt => Compare::Lt,
            BinOp::Le => Compare::Le,
            BinOp::Gt => Compare::Gt,
            BinOp::Ge => Compare::Ge,
            _ => return Err(Unsupported::Expression),
        };
        let (column, op, v, explicit) = if let (Some(c), Some(v)) = (field(a), literal(b)) {
            (c, op, v, explicit_record_access(a))
        } else if let (Some(v), Some(c)) = (literal(a), field(b)) {
            (c, op.reversed(), v, explicit_record_access(b))
        } else {
            return Err(Unsupported::Expression);
        };
        // Explicit record missing keys are CEL errors, unlike bare unbound
        // identifiers (null). Materialized Null conflates missing/present-null:
        // there is no presence proof for explicit NULL equality.
        if explicit && matches!(v, Value::Null) {
            return Err(Unsupported::Field);
        }
        let value = SortAtom::from_value(Some(&v), TemporalHint::None, MAX_LITERAL_BYTES)
            .map_err(|_| Unsupported::Budget)?;
        if value.kind() == AtomKind::Text
            && let Column::Field(f) = &column
        {
            let path: Vec<_> = f.path.iter().map(String::as_str).collect();
            if self.catalog.types().iter().any(|t| {
                crate::types::schema_at(&t.schema_document, &t.schema_entry, &path)
                    .and_then(|s| s.get("format"))
                    .and_then(Value::as_str)
                    == Some("date")
            }) {
                // Date sort atoms are temporal, but CEL date values remain
                // strings. A Text kind gate would incorrectly prune them.
                return Err(Unsupported::Field);
            }
        }
        let can_error = op != Compare::Eq || explicit;
        if op != Compare::Eq && !matches!(value.kind(), AtomKind::Number | AtomKind::Text) {
            return Err(Unsupported::Expression);
        }
        if column == Column::Path && value.kind() != AtomKind::Text {
            return Ok(Leaf {
                predicate: Predicate::None,
                can_error,
            });
        }
        self.literal_bytes = self
            .literal_bytes
            .checked_add(value.key().len())
            .ok_or(Unsupported::Budget)?;
        if self.literal_bytes > MAX_LITERAL_BYTES {
            return Err(Unsupported::Budget);
        }
        Ok(Leaf {
            predicate: Predicate::Compare { column, op, value },
            can_error,
        })
    }
}
const RESERVED: &[&str] = &[
    "record",
    "raw",
    "file",
    "projection",
    "this",
    "types",
    "now",
    "today",
];
fn effective(name: &str) -> Option<Column> {
    if name.is_empty() {
        return None;
    }
    // Identity only. Temporal classification is trusted per ROW, not inferred
    // here or imposed globally on a heterogeneous record set.
    Some(Column::Field(IndexFieldSpec {
        source: super::indexed::FieldSource::Effective,
        path: vec![name.to_owned()],
        temporal: TemporalHint::None,
    }))
}
fn field(e: &Expr) -> Option<Column> {
    match e {
        Expr::Ident(n) if !RESERVED.contains(&n.as_str()) => effective(n),
        Expr::Select {
            operand,
            field,
            test: false,
            optional: false,
        } => match operand.as_ref() {
            Expr::Ident(n) if n == "record" => effective(field),
            Expr::Ident(n) if n == "file" && field == "path" => Some(Column::Path),
            _ => None,
        },
        Expr::Index {
            operand,
            index,
            optional: false,
        } => match (operand.as_ref(), index.as_ref()) {
            (Expr::Ident(n), Expr::Lit(CelValue::String(k))) if n == "record" => effective(k),
            (Expr::Ident(n), Expr::Lit(CelValue::String(k))) if n == "file" && &**k == "path" => {
                Some(Column::Path)
            }
            _ => None,
        },
        _ => None,
    }
}
fn explicit_record_access(e: &Expr) -> bool {
    match e {
        Expr::Select { operand, .. } | Expr::Index { operand, .. } => {
            matches!(operand.as_ref(), Expr::Ident(n) if n == "record")
        }
        _ => false,
    }
}
fn literal(e: &Expr) -> Option<Value> {
    match e {
        Expr::Lit(CelValue::Null) => Some(Value::Null),
        Expr::Lit(CelValue::Bool(b)) => Some(Value::Bool(*b)),
        Expr::Lit(CelValue::Int(i)) => Some(Value::Int(*i)),
        Expr::Lit(CelValue::Uint(u)) => i64::try_from(*u).ok().map(Value::Int),
        Expr::Lit(CelValue::Double(f)) => Value::float(*f),
        Expr::Lit(CelValue::String(s)) => Some(Value::string(s.to_string())),
        Expr::Neg(e) => match literal(e)? {
            Value::Int(i) => i.checked_neg().map(Value::Int),
            Value::Float(f) => Value::float(-f),
            _ => None,
        },
        _ => None,
    }
}
/// Lower the ENTIRE compiled where and order. Uses trusted current effective
/// materialization (including read defaults, explicit null rows and current
/// all-type temporal hints), never legacy RecordMeta.effective/raw indexes.
/// No partial residual is represented as a complete profile.
pub fn lower(plan: &QueryPlan, catalog: &Catalog) -> Result<Profile, Unsupported> {
    if plan.query.types.len() > MAX_TERMS || plan.order.len() > MAX_TERMS {
        return Err(Unsupported::Budget);
    }
    // Current residual membership uses ASCII case equality. Do not let Unicode
    // folding (e.g. Kelvin-sign -> k) admit extra SQL membership matches.
    if !plan.query.types.is_empty()
        && (!plan.query.types.iter().all(|s| s.is_ascii())
            || !catalog.types().iter().all(|t| t.name.is_ascii()))
    {
        return Err(Unsupported::Types);
    }
    let mut lower = Lower {
        terms: 0,
        literal_bytes: 0,
        catalog,
    };
    let leaf = match &plan.where_program {
        None => Leaf {
            predicate: Predicate::All,
            can_error: false,
        },
        Some(p) => lower.expr(p.0.ast())?,
    };
    let mut order = Vec::new();
    for t in &plan.order {
        let column = match &t.field {
            FieldRef::Path => Column::Path,
            FieldRef::Effective(p)
                if p.len() == 1
                    && !plan.select.iter().any(|s| {
                        s.name == p[0] && matches!(s.source, projection::SelectSource::Expr(_))
                    }) =>
            {
                effective(&p[0]).ok_or(Unsupported::Field)?
            }
            _ => return Err(Unsupported::Order),
        };
        order.push(Order {
            column,
            direction: t.direction,
        });
    }
    let types: Vec<_> = catalog
        .types()
        .iter()
        .filter(|t| {
            plan.query
                .types
                .iter()
                .any(|q| q.eq_ignore_ascii_case(&t.name))
        })
        .map(|t| t.name.clone())
        .collect();
    // Index rows carry canonical catalogue names as-written. Unknown requested
    // names are an empty match set, not an empty/unrestricted Types predicate.
    let predicate = if !plan.query.types.is_empty() && types.is_empty() {
        Predicate::None
    } else {
        leaf.predicate
    };
    Ok(Profile {
        types,
        predicate,
        order,
        diagnostics_exact: !leaf.can_error,
    })
}
