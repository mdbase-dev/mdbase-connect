//! The CEL parser: tokens → AST, with macros expanded and literal regex
//! patterns compiled (spec 10: an invalid literal pattern is a compile error).

use std::sync::Arc;

use super::lex::{Tok, Token, lex};
use super::value::CelValue;
use super::{CompileError, MAX_AST_DEPTH};
use crate::regex::Pattern;

/// Binary operators.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum BinOp {
    /// `+`
    Add,
    /// `-`
    Sub,
    /// `*`
    Mul,
    /// `/`
    Div,
    /// `%`
    Rem,
    /// `<`
    Lt,
    /// `<=`
    Le,
    /// `>`
    Gt,
    /// `>=`
    Ge,
    /// `==`
    Eq,
    /// `!=`
    Ne,
    /// `in`
    In,
}

/// Comprehension macros.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum MacroKind {
    /// `r.all(v, p)`
    All,
    /// `r.exists(v, p)`
    Exists,
    /// `r.exists_one(v, p)`
    ExistsOne,
    /// `r.map(v, t)` or `r.map(v, p, t)`
    Map,
    /// `r.filter(v, p)`
    Filter,
}

/// An expression: the compiled syntax tree, with macros expanded (`has(a.b)`
/// is a [`Expr::Select`] with `test`, comprehensions are [`Expr::Macro`]).
/// Read-only for hosts that derive query candidates from it.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub enum Expr {
    /// A literal.
    Lit(CelValue),
    /// An identifier (a binding, a record field, or a comprehension variable).
    Ident(String),
    /// `operand.field`, `operand.?field` or `has(operand.field)`.
    Select {
        /// The operand.
        operand: Box<Expr>,
        /// The field name.
        field: String,
        /// `has(operand.field)`.
        test: bool,
        /// `operand.?field`.
        optional: bool,
    },
    /// `operand[index]` or `operand[?index]`.
    Index {
        /// The operand.
        operand: Box<Expr>,
        /// The index or key.
        index: Box<Expr>,
        /// `operand[?index]`.
        optional: bool,
    },
    /// A function or method call.
    Call {
        /// The receiver, for a method call.
        target: Option<Box<Expr>>,
        /// The function name (`optional.of` for namespaced functions).
        func: String,
        /// The arguments.
        args: Vec<Expr>,
    },
    /// `matches` with a literal pattern, compiled once.
    MatchesLit {
        /// The text matched.
        text: Box<Expr>,
        /// The pattern source.
        source: String,
        /// The compiled pattern.
        pattern: Arc<Pattern>,
    },
    /// A list literal.
    List(Vec<Expr>),
    /// A map literal.
    Map(Vec<(Expr, Expr)>),
    /// `!x`
    Not(Box<Expr>),
    /// `-x`
    Neg(Box<Expr>),
    /// A binary operator.
    Bin(BinOp, Box<Expr>, Box<Expr>),
    /// `a && b`
    And(Box<Expr>, Box<Expr>),
    /// `a || b`
    Or(Box<Expr>, Box<Expr>),
    /// `c ? a : b`
    Cond(Box<Expr>, Box<Expr>, Box<Expr>),
    /// A comprehension macro.
    Macro {
        /// Which macro.
        kind: MacroKind,
        /// The list or map iterated.
        range: Box<Expr>,
        /// The iteration variable.
        var: String,
        /// The predicate (`all`, `exists`, `exists_one`, `filter`), or the
        /// transform (`map`).
        body: Box<Expr>,
        /// `map(x, pred, transform)`: the predicate.
        filter: Option<Box<Expr>>,
    },
}

/// Global functions and methods the engine knows. Anything else is a compile
/// error, so an expression never fails late on an unknown name.
const FUNCTIONS: &[&str] = &[
    "size",
    "contains",
    "startsWith",
    "endsWith",
    "matches",
    "lower",
    "upper",
    "string",
    "int",
    "uint",
    "double",
    "bool",
    "bytes",
    "dyn",
    "type",
    "hasValue",
    "value",
    "orValue",
    "or",
    "optional.of",
    "optional.none",
    "optional.ofNonZeroValue",
    // Temporal (spec 10).
    "timestamp",
    "duration",
    "now",
    "today",
    "date",
    "startOfDay",
    "addDays",
    "addMonths",
    "addYears",
    "daysUntil",
    "year",
    "month",
    "day",
    "dayOfWeek",
    "getFullYear",
    "getMonth",
    "getDayOfMonth",
    "getDate",
    "getDayOfWeek",
    "getDayOfYear",
    "getHours",
    "getMinutes",
    "getSeconds",
    "getMilliseconds",
    // File and link helpers (spec 10); links resolve through the host.
    "inFolder",
    "hasTag",
    "hasLink",
    "link",
    "asFile",
    "asLink",
];

/// What an expression refers to: free identifiers (system bindings and record
/// fields, not macro variables), called functions and methods, and `file.x`
/// selections. Used to check that a context provides the bindings an
/// expression needs and to report `nondeterministic_match` (spec 07, 10).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct References {
    /// Free identifiers.
    pub identifiers: std::collections::BTreeSet<String>,
    /// Functions and methods called.
    pub functions: std::collections::BTreeSet<String>,
    /// Members selected from `file` (`mtime` for `file.mtime`).
    pub file_members: std::collections::BTreeSet<String>,
}

impl References {
    /// The bindings that make a `match.expr` nondeterministic (spec 07): `now`,
    /// `today`, `file.mtime`, `file.ctime`, and helpers that read other
    /// records (`asFile`, `file.backlinks`, `file.hasLink`). In a stable order.
    pub fn nondeterministic(&self) -> Vec<&'static str> {
        let mut out = Vec::new();
        for f in ["now", "today", "asFile"] {
            if self.functions.contains(f) {
                out.push(f);
            }
        }
        for (m, name) in [
            ("mtime", "file.mtime"),
            ("ctime", "file.ctime"),
            ("backlinks", "file.backlinks"),
        ] {
            if self.file_members.contains(m) {
                out.push(name);
            }
        }
        if self.functions.contains("hasLink") {
            out.push("file.hasLink");
        }
        out
    }
}

pub(crate) fn references(e: &Expr) -> References {
    let mut r = References::default();
    let mut bound: Vec<String> = Vec::new();
    walk(e, &mut bound, &mut r);
    r
}

fn walk(e: &Expr, bound: &mut Vec<String>, r: &mut References) {
    match e {
        Expr::Lit(_) => {}
        Expr::Ident(n) => {
            if !bound.iter().any(|b| b == n) {
                r.identifiers.insert(n.clone());
            }
        }
        Expr::Select { operand, field, .. } => {
            if matches!(operand.as_ref(), Expr::Ident(n) if n == "file" && !bound.iter().any(|b| b == "file"))
            {
                r.file_members.insert(field.clone());
            }
            walk(operand, bound, r);
        }
        Expr::Index { operand, index, .. } => {
            walk(operand, bound, r);
            walk(index, bound, r);
        }
        Expr::Call { target, func, args } => {
            r.functions.insert(func.clone());
            if let Some(t) = target {
                walk(t, bound, r);
            }
            for a in args {
                walk(a, bound, r);
            }
        }
        Expr::MatchesLit { text, .. } => {
            r.functions.insert("matches".into());
            walk(text, bound, r);
        }
        Expr::List(items) => items.iter().for_each(|i| walk(i, bound, r)),
        Expr::Map(entries) => {
            for (k, v) in entries {
                walk(k, bound, r);
                walk(v, bound, r);
            }
        }
        Expr::Not(x) | Expr::Neg(x) => walk(x, bound, r),
        Expr::Bin(_, a, b) | Expr::And(a, b) | Expr::Or(a, b) => {
            walk(a, bound, r);
            walk(b, bound, r);
        }
        Expr::Cond(c, a, b) => {
            walk(c, bound, r);
            walk(a, bound, r);
            walk(b, bound, r);
        }
        Expr::Macro {
            range,
            var,
            body,
            filter,
            ..
        } => {
            walk(range, bound, r);
            bound.push(var.clone());
            walk(body, bound, r);
            if let Some(f) = filter {
                walk(f, bound, r);
            }
            bound.pop();
        }
    }
}

pub(crate) fn parse(src: &str) -> Result<Expr, CompileError> {
    let toks = lex(src).map_err(|(pos, msg)| CompileError::at(src, pos, msg))?;
    let mut p = Parser {
        src,
        toks,
        i: 0,
        depth: 0,
    };
    let e = p.expr()?;
    if p.peek() != &Tok::Eof {
        return Err(p.err("unexpected token after the expression"));
    }
    Ok(e)
}

struct Parser<'a> {
    src: &'a str,
    toks: Vec<Token>,
    i: usize,
    depth: u32,
}

impl Parser<'_> {
    fn peek(&self) -> &Tok {
        &self.toks[self.i].tok
    }

    fn pos(&self) -> usize {
        self.toks[self.i].pos
    }

    fn err(&self, msg: impl Into<String>) -> CompileError {
        CompileError::at(self.src, self.pos(), msg.into())
    }

    fn bump(&mut self) -> Tok {
        let t = self.toks[self.i].tok.clone();
        if self.i + 1 < self.toks.len() {
            self.i += 1;
        }
        t
    }

    fn eat(&mut self, p: &str) -> bool {
        if matches!(self.peek(), Tok::P(q) if *q == p) {
            self.bump();
            true
        } else {
            false
        }
    }

    fn expect(&mut self, p: &str) -> Result<(), CompileError> {
        if self.eat(p) {
            Ok(())
        } else {
            Err(self.err(format!("expected `{p}`")))
        }
    }

    fn enter(&mut self) -> Result<(), CompileError> {
        self.depth += 1;
        if self.depth > MAX_AST_DEPTH {
            return Err(self.err(format!(
                "expression nesting exceeds the limit of {MAX_AST_DEPTH}"
            )));
        }
        Ok(())
    }

    fn expr(&mut self) -> Result<Expr, CompileError> {
        self.enter()?;
        let cond = self.or()?;
        let r = if self.eat("?") {
            let a = self.or()?;
            self.expect(":")?;
            let b = self.expr()?;
            Expr::Cond(Box::new(cond), Box::new(a), Box::new(b))
        } else {
            cond
        };
        self.depth -= 1;
        Ok(r)
    }

    fn or(&mut self) -> Result<Expr, CompileError> {
        let base = self.depth;
        let mut e = self.and()?;
        while self.eat("||") {
            self.enter()?;
            let r = self.and()?;
            e = Expr::Or(Box::new(e), Box::new(r));
        }
        self.depth = base;
        Ok(e)
    }

    fn and(&mut self) -> Result<Expr, CompileError> {
        let base = self.depth;
        let mut e = self.relation()?;
        while self.eat("&&") {
            self.enter()?;
            let r = self.relation()?;
            e = Expr::And(Box::new(e), Box::new(r));
        }
        self.depth = base;
        Ok(e)
    }

    fn relation(&mut self) -> Result<Expr, CompileError> {
        let base = self.depth;
        let mut e = self.addition()?;
        loop {
            let op = match self.peek() {
                Tok::P("<") => BinOp::Lt,
                Tok::P("<=") => BinOp::Le,
                Tok::P(">") => BinOp::Gt,
                Tok::P(">=") => BinOp::Ge,
                Tok::P("==") => BinOp::Eq,
                Tok::P("!=") => BinOp::Ne,
                Tok::In => BinOp::In,
                _ => {
                    self.depth = base;
                    return Ok(e);
                }
            };
            self.bump();
            self.enter()?;
            let r = self.addition()?;
            e = Expr::Bin(op, Box::new(e), Box::new(r));
        }
    }

    fn addition(&mut self) -> Result<Expr, CompileError> {
        let base = self.depth;
        let mut e = self.multiplication()?;
        loop {
            let op = match self.peek() {
                Tok::P("+") => BinOp::Add,
                Tok::P("-") => BinOp::Sub,
                _ => {
                    self.depth = base;
                    return Ok(e);
                }
            };
            self.bump();
            self.enter()?;
            let r = self.multiplication()?;
            e = Expr::Bin(op, Box::new(e), Box::new(r));
        }
    }

    fn multiplication(&mut self) -> Result<Expr, CompileError> {
        let base = self.depth;
        let mut e = self.unary()?;
        loop {
            let op = match self.peek() {
                Tok::P("*") => BinOp::Mul,
                Tok::P("/") => BinOp::Div,
                Tok::P("%") => BinOp::Rem,
                _ => {
                    self.depth = base;
                    return Ok(e);
                }
            };
            self.bump();
            self.enter()?;
            let r = self.unary()?;
            e = Expr::Bin(op, Box::new(e), Box::new(r));
        }
    }

    /// CEL's grammar: `'!'+ member` or `'-'+ member`. A run of the same
    /// operator applies once when its length is odd and cancels when even, as
    /// in cel-go.
    fn unary(&mut self) -> Result<Expr, CompileError> {
        let op = match self.peek() {
            Tok::P("!") => "!",
            Tok::P("-") => "-",
            _ => return self.member(),
        };
        let mut n = 0u32;
        while self.eat(op) {
            n += 1;
        }
        if op == "-" && n % 2 == 1 && self.peek() == &Tok::IntMinMagnitude {
            // -9223372036854775808 is the one int literal that needs the sign.
            self.bump();
            return self.member_suffix(Expr::Lit(CelValue::Int(i64::MIN)));
        }
        let e = self.member()?;
        Ok(match (op, n % 2) {
            (_, 0) => e,
            ("!", _) => Expr::Not(Box::new(e)),
            _ => Expr::Neg(Box::new(e)),
        })
    }

    fn member(&mut self) -> Result<Expr, CompileError> {
        let e = self.primary()?;
        self.member_suffix(e)
    }

    fn member_suffix(&mut self, mut e: Expr) -> Result<Expr, CompileError> {
        let base = self.depth;
        loop {
            match self.peek() {
                Tok::P(".") | Tok::P(".?") => {
                    let optional = self.peek() == &Tok::P(".?");
                    self.bump();
                    let Tok::Ident(name) = self.bump() else {
                        return Err(self.err("expected a field or method name"));
                    };
                    self.enter()?;
                    if !optional && self.eat("(") {
                        let args = self.args(")")?;
                        e = self.method(e, name, args)?;
                    } else {
                        e = Expr::Select {
                            operand: Box::new(e),
                            field: name,
                            test: false,
                            optional,
                        };
                    }
                }
                Tok::P("[") | Tok::P("[?") => {
                    let optional = self.peek() == &Tok::P("[?");
                    self.bump();
                    self.enter()?;
                    let index = self.expr()?;
                    self.expect("]")?;
                    e = Expr::Index {
                        operand: Box::new(e),
                        index: Box::new(index),
                        optional,
                    };
                }
                _ => break,
            }
        }
        self.depth = base;
        Ok(e)
    }

    fn args(&mut self, close: &str) -> Result<Vec<Expr>, CompileError> {
        let mut out = Vec::new();
        if self.eat(close) {
            return Ok(out);
        }
        loop {
            out.push(self.expr()?);
            if self.eat(",") {
                if self.eat(close) {
                    return Ok(out);
                }
                continue;
            }
            self.expect(close)?;
            return Ok(out);
        }
    }

    fn primary(&mut self) -> Result<Expr, CompileError> {
        let t = self.bump();
        Ok(match t {
            Tok::Int(i) => Expr::Lit(CelValue::Int(i)),
            Tok::IntMinMagnitude => return Err(self.err("int literal out of range")),
            Tok::Uint(u) => Expr::Lit(CelValue::Uint(u)),
            Tok::Double(d) => Expr::Lit(CelValue::Double(d)),
            Tok::String(s) => Expr::Lit(CelValue::String(s)),
            Tok::Bytes(b) => Expr::Lit(CelValue::Bytes(b)),
            Tok::True => Expr::Lit(CelValue::Bool(true)),
            Tok::False => Expr::Lit(CelValue::Bool(false)),
            Tok::Null => Expr::Lit(CelValue::Null),
            Tok::P("(") => {
                let e = self.expr()?;
                self.expect(")")?;
                e
            }
            Tok::P("[") => {
                self.enter()?;
                let items = self.args("]")?;
                self.depth -= 1;
                Expr::List(items)
            }
            Tok::P("{") => {
                self.enter()?;
                let mut entries = Vec::new();
                if !self.eat("}") {
                    loop {
                        let k = self.expr()?;
                        self.expect(":")?;
                        let v = self.expr()?;
                        entries.push((k, v));
                        if self.eat(",") {
                            if self.eat("}") {
                                break;
                            }
                            continue;
                        }
                        self.expect("}")?;
                        break;
                    }
                }
                self.depth -= 1;
                Expr::Map(entries)
            }
            Tok::P(".") => {
                // A leading dot names the root scope: `.name`.
                let Tok::Ident(name) = self.bump() else {
                    return Err(self.err("expected an identifier"));
                };
                self.ident_or_call(name)?
            }
            Tok::Ident(name) => self.ident_or_call(name)?,
            Tok::Eof => return Err(self.err("unexpected end of expression")),
            _ => return Err(self.err("unexpected token")),
        })
    }

    fn ident_or_call(&mut self, name: String) -> Result<Expr, CompileError> {
        // `optional.of(x)` / `optional.none()`: namespaced functions.
        if name == "optional" && matches!(self.peek(), Tok::P(".")) {
            let save = self.i;
            self.bump();
            if let Tok::Ident(f) = self.bump()
                && self.eat("(")
            {
                let args = self.args(")")?;
                return self.global(format!("optional.{f}"), args);
            }
            self.i = save;
        }
        if self.eat("(") {
            let args = self.args(")")?;
            return self.global(name, args);
        }
        Ok(Expr::Ident(name))
    }

    fn check_known(&self, name: &str) -> Result<(), CompileError> {
        if !FUNCTIONS.contains(&name) {
            return Err(self.err(format!("undeclared function `{name}`")));
        }
        Ok(())
    }

    fn global(&mut self, name: String, args: Vec<Expr>) -> Result<Expr, CompileError> {
        if name == "has" {
            return match args.as_slice() {
                [
                    Expr::Select {
                        operand,
                        field,
                        optional: false,
                        ..
                    },
                ] => Ok(Expr::Select {
                    operand: operand.clone(),
                    field: field.clone(),
                    test: true,
                    optional: false,
                }),
                _ => Err(self.err("has() needs a field selection, as in has(a.b)")),
            };
        }
        self.check_known(&name)?;
        if name == "matches" && args.len() == 2 {
            let mut it = args.into_iter();
            let text = it.next().unwrap_or(Expr::Lit(CelValue::Null));
            let pattern = it.next().unwrap_or(Expr::Lit(CelValue::Null));
            return self.matches(text, pattern);
        }
        Ok(Expr::Call {
            target: None,
            func: name,
            args,
        })
    }

    fn method(
        &mut self,
        target: Expr,
        name: String,
        args: Vec<Expr>,
    ) -> Result<Expr, CompileError> {
        let kind = match name.as_str() {
            "all" => Some(MacroKind::All),
            "exists" => Some(MacroKind::Exists),
            "exists_one" => Some(MacroKind::ExistsOne),
            "map" => Some(MacroKind::Map),
            "filter" => Some(MacroKind::Filter),
            _ => None,
        };
        if let Some(kind) = kind {
            let mut it = args.into_iter();
            let var = match it.next() {
                Some(Expr::Ident(v)) => v,
                _ => return Err(self.err(format!("{name}() needs an iteration variable"))),
            };
            let rest: Vec<Expr> = it.collect();
            let (body, filter) = match (kind, rest.len()) {
                (MacroKind::Map, 2) => {
                    let mut r = rest.into_iter();
                    let pred = r.next();
                    (r.next(), pred.map(Box::new))
                }
                (_, 1) => (rest.into_iter().next(), None),
                _ => return Err(self.err(format!("wrong number of arguments to {name}()"))),
            };
            let body = body.ok_or_else(|| self.err("missing macro body"))?;
            return Ok(Expr::Macro {
                kind,
                range: Box::new(target),
                var,
                body: Box::new(body),
                filter,
            });
        }
        self.check_known(&name)?;
        if name == "matches" && args.len() == 1 {
            let pattern = args.into_iter().next().unwrap_or(Expr::Lit(CelValue::Null));
            return self.matches(target, pattern);
        }
        Ok(Expr::Call {
            target: Some(Box::new(target)),
            func: name,
            args,
        })
    }

    /// `matches` with a literal pattern compiles the pattern now.
    fn matches(&self, text: Expr, pattern: Expr) -> Result<Expr, CompileError> {
        if let Expr::Lit(CelValue::String(p)) = &pattern {
            let compiled = Pattern::new(p).map_err(|e| self.err(e.to_string()))?;
            return Ok(Expr::MatchesLit {
                text: Box::new(text),
                source: p.to_string(),
                pattern: Arc::new(compiled),
            });
        }
        Ok(Expr::Call {
            target: Some(Box::new(text)),
            func: "matches".into(),
            args: vec![pattern],
        })
    }
}
