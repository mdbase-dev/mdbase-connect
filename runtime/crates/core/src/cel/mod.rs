//! The CEL profile (spec 10): one expression engine for every mdbase context
//! (SC8).
//!
//! [`compile`] parses an expression, expands the macros (`has`, `all`,
//! `exists`, `exists_one`, `map`, `filter`), compiles literal `matches()`
//! patterns with the [regex profile](crate::regex), and rejects unknown
//! functions, so an invalid expression is an `expression_compile_error` when its
//! containing object is loaded rather than at evaluation. [`Program::evaluate`]
//! runs it against an [`Activation`].
//!
//! **Implemented.** The full CEL syntax including the optional syntax (`.?f`,
//! `[?k]`), and the semantics of `null`, `bool`, `int`, `uint`, `double`,
//! `string`, `bytes`, `list`, `map` and `optional`:
//! - heterogeneous numeric equality and ordering;
//! - checked integer arithmetic;
//! - commutative error absorption by `&&` and `||` (and by `all` and `exists`);
//! - `size`, `contains`, `startsWith`, `endsWith` and `matches`;
//! - the profile's `lower`/`upper` (full case mappings);
//! - type conversions;
//! - the optional functions.
//!
//! **Temporal** ([`time`]): timestamps and durations with CEL's operators and
//! accessors, and the profile's `now`, `today`, `date`, `startOfDay` and date
//! methods. Time comes only from the activation's [`Clock`] (the intent's
//! captured `op-clock`), never from a clock read.
//!
//! **Files and links:** `file.inFolder` and `file.hasTag` are built in;
//! `link`, `asFile`, `file.asLink` and `file.hasLink` resolve through a
//! [`LinkHost`] supplied by the context.
//!
//! [`Program::references`] lists what an expression uses, for binding checks
//! and `nondeterministic_match`.
//!
//! **Limits** (spec 10 minimums): source at most [`MAX_SOURCE`] bytes, AST
//! depth at most [`MAX_AST_DEPTH`], and at most [`MAX_EVAL_STEPS`] evaluation
//! steps, so evaluation always terminates with the same result on every
//! platform.

mod eval;
mod lex;
mod parse;
pub mod template;
pub mod time;
mod value;

pub use eval::{Activation, Clock, LinkHost};
pub use parse::References;

/// The read-only syntax tree of a compiled expression ([`Program::ast`]).
pub mod ast {
    pub use super::parse::{BinOp, Expr, MacroKind};
}
pub use value::{CelMap, CelValue, Key};

use crate::value::Map;

/// Maximum expression source size (spec 10 minimum: 64 KiB).
pub const MAX_SOURCE: usize = 64 * 1024;
/// Maximum AST depth (spec 10 minimum: 100).
pub const MAX_AST_DEPTH: u32 = 100;
/// Maximum evaluation steps per evaluation.
pub const MAX_EVAL_STEPS: u64 = 1_000_000;

/// An expression that does not compile (`expression_compile_error`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompileError {
    /// What is wrong.
    pub message: String,
    /// 1-based line.
    pub line: u32,
    /// 1-based column, in Unicode scalar values.
    pub column: u32,
}

impl CompileError {
    pub(crate) fn at(src: &str, pos: usize, message: String) -> CompileError {
        let mut pos = pos.min(src.len());
        while !src.is_char_boundary(pos) {
            pos -= 1;
        }
        let before = &src[..pos];
        let line = before.bytes().filter(|&c| c == b'\n').count() + 1;
        let col = before[before.rfind('\n').map_or(0, |i| i + 1)..]
            .chars()
            .count()
            + 1;
        CompileError {
            message,
            line: u32::try_from(line).unwrap_or(u32::MAX),
            column: u32::try_from(col).unwrap_or(u32::MAX),
        }
    }
}

impl std::fmt::Display for CompileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} at line {}, column {}",
            self.message, self.line, self.column
        )
    }
}

impl std::error::Error for CompileError {}

/// An evaluation error (`expression_evaluation_error`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvalError {
    /// What went wrong.
    pub message: String,
}

impl std::fmt::Display for EvalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for EvalError {}

/// A compiled expression.
#[derive(Debug, Clone)]
pub struct Program {
    expr: parse::Expr,
}

/// Compile `source` (spec 10 "Compilation And Evaluation Errors").
pub fn compile(source: &str) -> Result<Program, CompileError> {
    if source.len() > MAX_SOURCE {
        return Err(CompileError {
            message: format!("expression source exceeds the limit of {MAX_SOURCE} bytes"),
            line: 1,
            column: 1,
        });
    }
    Ok(Program {
        expr: parse::parse(source)?,
    })
}

impl Program {
    /// The syntax tree, with macros expanded.
    pub fn ast(&self) -> &ast::Expr {
        &self.expr
    }

    /// What the expression refers to (bindings, functions, `file` members).
    pub fn references(&self) -> References {
        parse::references(&self.expr)
    }

    /// Evaluate against `activation`.
    pub fn evaluate(&self, activation: &Activation<'_>) -> Result<CelValue, EvalError> {
        eval::Evaluator::new(activation).eval(&self.expr)
    }
}

/// The bindings of a record context (spec 10 "Query Context", "Matching
/// Context"): top-level fields from `effective`, `record` = `effective`, `raw`
/// = `raw`, and `file`. Unbound identifiers (missing fields) evaluate to null.
pub fn record_activation<'a>(raw: &Map, effective: &Map, file: CelValue) -> Activation<'a> {
    let path = match &file {
        CelValue::Map(m) => match m.get_str("path") {
            Some(CelValue::String(s)) => Some(s.to_string()),
            _ => None,
        },
        _ => None,
    };
    // `record` and `raw` are record maps: links read from them resolve from
    // the candidate's path.
    let record_map = |m: &Map| {
        let cm = value::map_from(m);
        let cm = match &path {
            Some(p) => cm.with_origin(p),
            None => cm,
        };
        CelValue::Map(std::sync::Arc::new(cm))
    };
    let mut act = Activation::new();
    for (k, v) in effective.iter() {
        act.bind(k, CelValue::from_value(v));
    }
    act.bind("record", record_map(effective))
        .bind("raw", record_map(raw))
        .bind("file", file)
        .unbound_as_null();
    if let Some(p) = &path {
        act.with_record_path(p);
    }
    act
}

// Compiled programs are cached and shared across threads by hosts.
const _: () = {
    const fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<Program>();
    assert_send_sync::<CelValue>();
};

#[cfg(test)]
mod tests;
