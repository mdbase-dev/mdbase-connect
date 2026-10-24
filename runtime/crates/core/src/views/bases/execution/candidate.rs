//! Conservative ordered three-valued filter approximation. Unknown means
//! possible match OR failure: it is never a false result and must be retained.
//! This is raw Bases semantics, not CEL/effective-field lowering.
use super::*;

/// A bounded necessary candidate condition; exact Rust residuals are mandatory.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BasesCandidate {
    /// Unsupported or error-capable input: always retain.
    Unknown,
    /// Known Boolean constant.
    Constant(bool),
    /// Exact qualified file tag, including nested descendants.
    HasTag(String),
    /// Raw scalar emptiness. Typed dates require valid date-only text; explicit
    /// typed null and all other date spellings remain unknown.
    Empty {
        /// Exact top-level raw name.
        field: String,
        /// Captured date/datetime hint, never schema inference.
        date_typed: bool,
    },
    /// Raw untyped scalar equality with a literal string.
    TextEqual {
        /// Exact top-level raw name.
        field: String,
        /// Literal equality operand, not a property type or SQL pattern.
        text: String,
    },
    /// Valid date-only raw input, compared to a frozen canonical local date.
    DateDay {
        /// Exact top-level raw name.
        field: String,
        /// Proven date-only comparison.
        op: BasesCandidateCompare,
        /// Canonical date derived from the frozen clock.
        day: String,
    },
    /// Ordered Boolean conjunction: unknown on the left cannot be suppressed
    /// by false on the right (the left may raise an error).
    And(Box<Self>, Box<Self>),
    /// Ordered Boolean disjunction, likewise preserving earlier errors.
    Or(Box<Self>, Box<Self>),
    /// Boolean inversion; unknown remains unknown.
    Not(Box<Self>),
}
/// ASCII date-only comparison, not general string or typed-date ordering.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BasesCandidateCompare {
    /// Equal.
    Eq,
    /// Less than.
    Lt,
    /// Less than or equal.
    Le,
    /// Greater than.
    Gt,
    /// Greater than or equal.
    Ge,
}

/// Portable raw atom classification. Codes are an internal derived-data format,
/// not wire values or typing hints; all other input remains explicit unknown.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BasesCandidateAtom<'a> {
    /// Explicit raw null (absence is represented by no atom).
    Null,
    /// Finite Boolean/number; nonempty and unequal to strings.
    Scalar,
    /// Exact text without property-link interpretation.
    Text(&'a str),
    /// Valid canonical year 1..9999 date-only text; still raw Text.
    DateOnly(&'a str),
    /// Empty raw list/object (no nested interpretation can fail).
    EmptyContainer,
    /// Rich/invalid/nonfinite/error-capable raw value.
    Unknown,
}
impl<'a> BasesCandidateAtom<'a> {
    /// Classify once at derived-index maintenance, never synthesize defaults.
    pub fn capture(value: &'a Value) -> Self {
        match value {
            Value::Null => Self::Null,
            Value::Bool(_) | Value::Int(_) => Self::Scalar,
            Value::Float(f) if f.is_finite() => Self::Scalar,
            Value::Text(s) if s.len() > 4096 || (s.starts_with("[[") && s.ends_with("]]")) => {
                Self::Unknown
            }
            Value::Text(s)
                if s.is_ascii()
                    && s.len() == 10
                    && crate::cel::time::parse_date(s)
                        .is_some_and(|(year, _, _)| (2..=9998).contains(&year)) =>
            {
                Self::DateOnly(s)
            }
            Value::Text(s) => Self::Text(s),
            Value::List(l) if l.is_empty() => Self::EmptyContainer,
            Value::Map(m) if m.is_empty() => Self::EmptyContainer,
            _ => Self::Unknown,
        }
    }
}
fn field(expr: &Expr) -> Option<&str> {
    match expr {
        Expr::Identifier(n)
            if !matches!(
                n.as_str(),
                "note" | "formula" | "file" | "value" | "index" | "acc"
            ) =>
        {
            Some(n)
        }
        Expr::Member(root, member) if matches!(root.as_ref(), Expr::Identifier(n) if n=="note") => {
            match member {
                Member::Named(n) => Some(n),
                Member::Computed(key) => match key.as_ref() {
                    Expr::Literal(Value::Text(n)) => Some(n),
                    _ => None,
                },
            }
        }
        _ => None,
    }
}
fn method<'a>(expr: &'a Expr, name: &str) -> Option<(&'a Expr, &'a [Expr])> {
    let Expr::Call(callee, args) = expr else {
        return None;
    };
    let Expr::Member(root, Member::Named(n)) = callee.as_ref() else {
        return None;
    };
    (n == name).then_some((root.as_ref(), args))
}
fn date_field(expr: &Expr) -> Option<&str> {
    let Expr::Call(callee, args) = expr else {
        return None;
    };
    if !matches!(callee.as_ref(), Expr::Identifier(n) if n=="date") {
        return None;
    }
    let [arg] = args.as_slice() else {
        return None;
    };
    field(arg)
}
fn formatted(expr: &Expr) -> Option<&Expr> {
    let (root, args) = method(expr, "format")?;
    matches!(args, [Expr::Literal(Value::Text(p))] if p=="YYYY-MM-DD").then_some(root)
}
struct Lower<'a> {
    hints: &'a BTreeMap<String, String>,
    clock: CapturedClock,
    fixed_zone: bool,
    budget: &'a mut WorkBudget,
}
impl Lower<'_> {
    fn copy(&mut self, s: &str) -> Result<String, EvaluationFailure> {
        if self.budget.charge(s.len() as u64 + 1, s.len() as u64 + 64) {
            Ok(s.into())
        } else {
            Err(self.budget.failure().expect("candidate copy"))
        }
    }
    fn typing(&self, field: &str) -> Option<bool> {
        if field.is_empty() || field.len() > MAX_BASES_PROJECTION_FIELD_BYTES {
            return None;
        }
        match self.hints.get(field).map(String::as_str) {
            Some("link") => None,
            Some("date" | "datetime") => self.fixed_zone.then_some(true),
            _ => Some(false),
        }
    }
    fn frozen_day(&mut self, expr: &Expr) -> Result<Option<String>, EvaluationFailure> {
        // Only the exact admitted fixed-day arithmetic grammar. Other clocks,
        // month arithmetic, computed inputs or zones remain conservative.
        let offset = match expr {
            Expr::Call(callee, args)
                if args.is_empty()
                    && matches!(callee.as_ref(),Expr::Identifier(n) if n=="today") =>
            {
                0
            }
            Expr::Binary(op, left, right)
                if matches!(op.as_str(), "+" | "-")
                    && matches!(left.as_ref(),Expr::Call(c,args) if args.is_empty() && matches!(c.as_ref(),Expr::Identifier(n) if n=="today")) =>
            {
                let Expr::Literal(Value::Text(s)) = right.as_ref() else {
                    return Ok(None);
                };
                let days = match s.as_str() {
                    "1 day" | "1d" => 1,
                    "7 days" | "7d" => 7,
                    _ => return Ok(None),
                };
                if op == "-" { -days } else { days }
            }
            _ => return Ok(None),
        };
        // Do not hoist a potentially failing boundary-date computation out of
        // its lazy filter branch. Captured now() is already validated; the
        // interior-year guard makes fixed-zone midnight/±7 days total.
        let year = self.clock.now(self.budget)?.property("year", self.budget)?;
        if !(2..=9998).contains(&year) {
            return Ok(None);
        }
        let day = self
            .clock
            .today(self.budget)?
            .add_millis(offset * 86_400_000, self.budget)?;
        Ok(Some(day.format("YYYY-MM-DD", self.budget)?))
    }
    fn walk(&mut self, expr: &Expr, depth: usize) -> Result<BasesCandidate, EvaluationFailure> {
        if depth > MAX_AST_DEPTH {
            return Ok(BasesCandidate::Unknown);
        }
        if !self.budget.charge(1, 128) {
            return Err(self.budget.failure().expect("candidate walk"));
        }
        Ok(match expr {
            Expr::Literal(Value::Bool(b)) => BasesCandidate::Constant(*b),
            Expr::Binary(op, left, right) if op == "&&" || op == "||" => {
                let left = Box::new(self.walk(left, depth + 1)?);
                let right = Box::new(self.walk(right, depth + 1)?);
                if op == "&&" {
                    BasesCandidate::And(left, right)
                } else {
                    BasesCandidate::Or(left, right)
                }
            }
            Expr::Unary(op, arg) if op == "!" => {
                BasesCandidate::Not(Box::new(self.walk(arg, depth + 1)?))
            }
            Expr::Binary(op, left, right)
                if matches!(op.as_str(), "==" | "!=")
                    && matches!(right.as_ref(), Expr::Literal(Value::Bool(_))) =>
            {
                let Expr::Literal(Value::Bool(b)) = right.as_ref() else {
                    unreachable!()
                };
                let inner = self.walk(left, depth + 1)?;
                if *b == (op == "==") {
                    inner
                } else {
                    BasesCandidate::Not(Box::new(inner))
                }
            }
            Expr::Call(_, _) if method(expr, "isTruthy").is_some() => {
                let (root, args) = method(expr, "isTruthy").expect("matched");
                if args.is_empty() {
                    self.walk(root, depth + 1)?
                } else {
                    BasesCandidate::Unknown
                }
            }
            Expr::Call(_, _) if method(expr, "hasTag").is_some() => {
                let (root, args) = method(expr, "hasTag").expect("matched");
                match args {
                    [Expr::Literal(Value::Text(tag))]
                        if matches!(root,Expr::Identifier(n) if n=="file")
                            && !tag.starts_with("##")
                            && tag.len() <= 4096 =>
                    {
                        BasesCandidate::HasTag(self.copy(tag.trim_start_matches('#'))?)
                    }
                    _ => BasesCandidate::Unknown,
                }
            }
            Expr::Call(_, _) if method(expr, "isEmpty").is_some() => {
                let (root, args) = method(expr, "isEmpty").expect("matched");
                match field(root).and_then(|name| self.typing(name).map(|typed| (name, typed))) {
                    Some((name, typed)) if args.is_empty() => BasesCandidate::Empty {
                        field: self.copy(name)?,
                        date_typed: typed,
                    },
                    _ => BasesCandidate::Unknown,
                }
            }
            Expr::Binary(op, left, right)
                if matches!(op.as_str(), "==" | "!=")
                    && field(left).is_some()
                    && matches!(right.as_ref(), Expr::Literal(Value::Text(_))) =>
            {
                let name = field(left).expect("matched");
                let Expr::Literal(Value::Text(text)) = right.as_ref() else {
                    unreachable!()
                };
                if self.typing(name) != Some(false) {
                    BasesCandidate::Unknown
                } else {
                    let p = BasesCandidate::TextEqual {
                        field: self.copy(name)?,
                        text: self.copy(text)?,
                    };
                    if op == "==" {
                        p
                    } else {
                        BasesCandidate::Not(Box::new(p))
                    }
                }
            }
            Expr::Binary(op, left, right)
                if self.fixed_zone && matches!(op.as_str(), "==" | "<" | "<=" | ">" | ">=") =>
            {
                let (source, target) =
                    if let (Some(l), Some(r)) = (formatted(left), formatted(right)) {
                        (l, r)
                    } else {
                        (left.as_ref(), right.as_ref())
                    };
                match date_field(source).filter(|name| self.typing(name).is_some()) {
                    Some(name) => match self.frozen_day(target)? {
                        Some(day) => BasesCandidate::DateDay {
                            field: self.copy(name)?,
                            op: match op.as_str() {
                                "==" => BasesCandidateCompare::Eq,
                                "<" => BasesCandidateCompare::Lt,
                                "<=" => BasesCandidateCompare::Le,
                                ">" => BasesCandidateCompare::Gt,
                                _ => BasesCandidateCompare::Ge,
                            },
                            day,
                        },
                        None => BasesCandidate::Unknown,
                    },
                    None => BasesCandidate::Unknown,
                }
            }
            _ => BasesCandidate::Unknown,
        })
    }
}
impl BasesCandidate {
    /// Conservative owned clone bytes, for the caller's cumulative page ledger.
    pub fn clone_bytes(&self) -> u64 {
        std::mem::size_of::<Self>() as u64
            + match self {
                Self::Unknown | Self::Constant(_) => 0,
                Self::HasTag(t) => t.len() as u64,
                Self::Empty { field, .. } => field.len() as u64,
                Self::TextEqual { field, text } => field.len() as u64 + text.len() as u64,
                Self::DateDay { field, day, .. } => field.len() as u64 + day.len() as u64,
                Self::And(a, b) | Self::Or(a, b) => a.clone_bytes() + b.clone_bytes(),
                Self::Not(a) => a.clone_bytes(),
            }
    }
    /// Fixed derived-candidate contract: at most 128 nodes/depth 16, 256-byte
    /// raw names and 4096-byte literals. Larger admitted filters use Unknown.
    pub fn is_bounded(&self) -> bool {
        fn walk(p: &BasesCandidate, nodes: &mut u32, depth: u32) -> bool {
            *nodes += 1;
            if *nodes > 128 || depth > 16 {
                return false;
            }
            let name = |s: &str| !s.is_empty() && s.len() <= 256;
            match p {
                BasesCandidate::Unknown | BasesCandidate::Constant(_) => true,
                BasesCandidate::HasTag(t) => t.len() <= 4096,
                BasesCandidate::Empty { field, .. } => name(field),
                BasesCandidate::TextEqual { field, text } => name(field) && text.len() <= 4096,
                BasesCandidate::DateDay { field, day, .. } => {
                    name(field)
                        && day.is_ascii()
                        && day.len() == 10
                        && crate::cel::time::parse_date(day).is_some()
                }
                BasesCandidate::And(a, b) | BasesCandidate::Or(a, b) => {
                    walk(a, nodes, depth + 1) && walk(b, nodes, depth + 1)
                }
                BasesCandidate::Not(a) => walk(a, nodes, depth + 1),
            }
        }
        walk(self, &mut 0, 1)
    }
}
impl AdmittedBasesView {
    /// Approximate only the admitted filter root under the SAME hints and clock.
    /// Named-zone date predicates remain unknown (midnight gaps/folds can fail).
    pub fn candidate(
        &self,
        hints: &BTreeMap<String, String>,
        clock: CapturedClock,
        budget: &mut WorkBudget,
    ) -> Result<BasesCandidate, EvaluationFailure> {
        let Expr::Array(roots) = self.program.expression.ast() else {
            return Ok(BasesCandidate::Unknown);
        };
        let Some(root) = roots.first() else {
            return Ok(BasesCandidate::Unknown);
        };
        let p = Lower {
            hints,
            clock,
            fixed_zone: clock.timezone().candidate_fixed_zone(),
            budget,
        }
        .walk(root, 1)?;
        Ok(if p.is_bounded() {
            p
        } else {
            BasesCandidate::Unknown
        })
    }
}
