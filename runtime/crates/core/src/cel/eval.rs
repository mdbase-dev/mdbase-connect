//! The CEL evaluator.

use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::sync::Arc;

use super::parse::{BinOp, Expr, MacroKind};
use super::time::{self, Duration, TimeZoneRules, Timestamp};
use super::value::{CelMap, CelValue, Key, numeric_cmp};
use super::{EvalError, MAX_EVAL_STEPS};
use crate::regex::Pattern;

/// The captured time of an evaluation (spec 10, 11; `op-clock` in
/// `intent.md` §4.1). Expressions never read a real clock.
#[derive(Debug, Clone, Default)]
pub struct Clock {
    /// The captured instant: `now()`.
    pub instant: Option<Timestamp>,
    /// The captured local date in the effective time zone: `today()`.
    pub local_date: Option<String>,
    /// The effective time zone's rules, for `date(timestamp)`,
    /// `startOfDay()` and the timestamp getters. `None` when the context has
    /// no zone data; those functions are then evaluation errors.
    pub tz: Option<Arc<dyn TimeZoneRules>>,
}

/// Link resolution for the link helpers (spec 08, 10), implemented by the
/// host (core-B's link resolver). `from` is the path of the record the link
/// value was read from; links resolve relative to it.
pub trait LinkHost: std::fmt::Debug {
    /// `link(value)`: a link value for a string or link, read at `from`.
    fn link(&self, value: &CelValue, from: &str) -> Result<CelValue, String>;
    /// `value.asFile()`: the resolved record in query-candidate shape (a map
    /// with its effective fields, `record`, `raw` and `file`, built with
    /// [`CelMap::with_origin`]), or null for an unresolved link.
    fn as_file(&self, value: &CelValue, from: &str) -> Result<CelValue, String>;
    /// `file.asLink()` for the record at `path`.
    fn as_link(&self, path: &str) -> Result<CelValue, String>;
    /// `file.hasLink(value)`: whether the record at `path` links to `value`
    /// (resolved from `path`).
    fn has_link(&self, path: &str, value: &CelValue) -> Result<bool, String>;
    /// `file.links`, `file.embeds` or `file.backlinks` (`member`) of the record
    /// at `path`, when the `file` map does not carry it. `Ok(None)` when the
    /// host does not provide that member.
    fn file_member(&self, path: &str, member: &str) -> Result<Option<CelValue>, String> {
        let _ = (path, member);
        Ok(None)
    }
}

/// Variable bindings for an evaluation. The link host is borrowed (`'a`), so
/// a host can resolve links against a state view without cloning it.
#[derive(Debug, Clone, Default)]
pub struct Activation<'a> {
    vars: BTreeMap<String, CelValue>,
    unbound_is_null: bool,
    clock: Clock,
    /// The path of the context record (the candidate), for link resolution.
    record_path: Option<Arc<str>>,
    links: Option<&'a dyn LinkHost>,
}

impl<'a> Activation<'a> {
    /// An empty activation: unbound identifiers are evaluation errors.
    pub fn new() -> Activation<'a> {
        Activation::default()
    }

    /// Bind `name`.
    pub fn bind(&mut self, name: impl Into<String>, value: CelValue) -> &mut Activation<'a> {
        self.vars.insert(name.into(), value);
        self
    }

    /// Set the captured time.
    pub fn with_clock(&mut self, clock: Clock) -> &mut Activation<'a> {
        self.clock = clock;
        self
    }

    /// Set the context record's path (where its links resolve from).
    pub fn with_record_path(&mut self, path: &str) -> &mut Activation<'a> {
        self.record_path = Some(Arc::from(path));
        self
    }

    /// Set the link host. Without one, the link helpers are evaluation errors.
    pub fn with_links(&mut self, host: &'a dyn LinkHost) -> &mut Activation<'a> {
        self.links = Some(host);
        self
    }

    /// Bind every unbound identifier to null (spec 10: an identifier naming a
    /// missing record field is null).
    pub fn unbound_as_null(&mut self) -> &mut Activation<'a> {
        self.unbound_is_null = true;
        self
    }

    fn get(&self, name: &str) -> Option<CelValue> {
        match self.vars.get(name) {
            Some(v) => Some(v.clone()),
            None if self.unbound_is_null => Some(CelValue::Null),
            None => None,
        }
    }
}

type R = Result<CelValue, EvalError>;

fn err(msg: impl Into<String>) -> R {
    Err(EvalError {
        message: msg.into(),
    })
}

fn no_overload(op: &str, args: &[&CelValue]) -> R {
    let types: Vec<&str> = args.iter().map(|a| a.type_name()).collect();
    err(format!("no such overload: {op}({})", types.join(", ")))
}

pub(crate) struct Evaluator<'a> {
    act: &'a Activation<'a>,
    /// Local variables of comprehensions, innermost last.
    locals: Vec<(String, CelValue)>,
    steps: u64,
}

impl<'a> Evaluator<'a> {
    pub(crate) fn new(act: &'a Activation<'a>) -> Evaluator<'a> {
        Evaluator {
            act,
            locals: Vec::new(),
            steps: 0,
        }
    }

    fn step(&mut self) -> Result<(), EvalError> {
        self.steps += 1;
        if self.steps > MAX_EVAL_STEPS {
            return Err(EvalError {
                message: format!("evaluation exceeded the limit of {MAX_EVAL_STEPS} steps"),
            });
        }
        Ok(())
    }

    pub(crate) fn eval(&mut self, e: &Expr) -> R {
        self.step()?;
        match e {
            Expr::Lit(v) => Ok(v.clone()),
            Expr::Ident(name) => {
                if let Some((_, v)) = self.locals.iter().rev().find(|(n, _)| n == name) {
                    return Ok(v.clone());
                }
                match self.act.get(name) {
                    Some(v) => Ok(v),
                    None => err(format!("undeclared reference to `{name}`")),
                }
            }
            Expr::Select {
                operand,
                field,
                test,
                optional,
            } => {
                let v = self.eval(operand)?;
                // `file.links`, `file.embeds`, `file.backlinks`: from the link
                // host when the `file` map does not carry them.
                if let (CelValue::Map(m), Some(host)) = (&v, self.act.links)
                    && matches!(field.as_str(), "links" | "embeds" | "backlinks")
                    && m.get_str(field).is_none()
                    && matches!(operand.as_ref(), Expr::Ident(n) if n == "file" && !self.locals.iter().any(|(l, _)| l == "file"))
                    && let Some(CelValue::String(path)) = m.get_str("path")
                {
                    match host
                        .file_member(path, field)
                        .map_err(|message| EvalError { message })?
                    {
                        Some(_) if *test => return Ok(CelValue::Bool(true)),
                        Some(member) if *optional => {
                            return Ok(CelValue::Optional(Some(Arc::new(member))));
                        }
                        Some(member) => return Ok(member),
                        None => {}
                    }
                }
                select(&v, field, *test, *optional)
            }
            Expr::Index {
                operand,
                index,
                optional,
            } => {
                let v = self.eval(operand)?;
                let i = self.eval(index)?;
                index_value(&v, &i, *optional)
            }
            Expr::List(items) => {
                let mut out = Vec::with_capacity(items.len());
                for it in items {
                    out.push(self.eval(it)?);
                }
                Ok(CelValue::List(Arc::new(out)))
            }
            Expr::Map(entries) => {
                let mut m = CelMap::new();
                for (k, v) in entries {
                    let key = to_key(&self.eval(k)?)?;
                    let val = self.eval(v)?;
                    if !m.insert(key, val) {
                        return err("duplicate key in map literal");
                    }
                }
                Ok(CelValue::Map(Arc::new(m)))
            }
            Expr::Not(x) => match self.eval(x)? {
                CelValue::Bool(b) => Ok(CelValue::Bool(!b)),
                v => no_overload("!_", &[&v]),
            },
            Expr::Neg(x) => match self.eval(x)? {
                CelValue::Int(i) => i.checked_neg().map(CelValue::Int).ok_or(EvalError {
                    message: "int overflow".into(),
                }),
                CelValue::Double(d) => Ok(CelValue::Double(-d)),
                v => no_overload("-_", &[&v]),
            },
            Expr::And(a, b) => self.logic(a, b, false),
            Expr::Or(a, b) => self.logic(a, b, true),
            Expr::Cond(c, a, b) => match self.eval(c)? {
                CelValue::Bool(true) => self.eval(a),
                CelValue::Bool(false) => self.eval(b),
                v => no_overload("_?_:_", &[&v]),
            },
            Expr::Bin(op, a, b) => {
                let x = self.eval(a)?;
                let y = self.eval(b)?;
                binary(*op, &x, &y)
            }
            Expr::MatchesLit { text, pattern, .. } => match self.eval(text)? {
                CelValue::String(s) => Ok(CelValue::Bool(pattern.is_match(&s))),
                v => no_overload("matches", &[&v]),
            },
            Expr::Call { target, func, args }
                if matches!(func.as_str(), "asFile" | "link" | "asLink" | "hasLink") =>
            {
                self.link_call(target.as_deref(), func, args)
            }
            Expr::Call { target, func, args } => {
                let t = match target {
                    Some(t) => Some(self.eval(t)?),
                    None => None,
                };
                let mut vals = Vec::with_capacity(args.len());
                for a in args {
                    vals.push(self.eval(a)?);
                }
                call(func, t.as_ref(), &vals, &self.act.clock)
            }
            Expr::Macro {
                kind,
                range,
                var,
                body,
                filter,
            } => self.comprehension(*kind, range, var, body, filter.as_deref()),
        }
    }

    /// The record path an expression's value was read from: the origin of the
    /// record map it was selected from, else the context record.
    fn origin_of(&mut self, e: &Expr) -> Result<Option<Arc<str>>, EvalError> {
        if let Expr::Select { operand, .. } | Expr::Index { operand, .. } = e
            && let CelValue::Map(m) = self.eval(operand)?
            && let Some(o) = m.origin()
        {
            return Ok(Some(Arc::from(o)));
        }
        Ok(self.act.record_path.clone())
    }

    fn link_call(&mut self, target: Option<&Expr>, func: &str, args: &[Expr]) -> R {
        let host = self.act.links.ok_or(EvalError {
            message: format!("{func}() needs link resolution, which this context does not provide"),
        })?;
        let from_of = |o: Option<Arc<str>>| o.map_or_else(String::new, |p| p.to_string());
        let host_err = |m: String| EvalError { message: m };
        match (func, target, args) {
            ("link", None, [v]) => {
                let from = from_of(self.origin_of(v)?);
                let val = self.eval(v)?;
                host.link(&val, &from).map_err(host_err)
            }
            ("asFile", Some(t), []) => {
                let from = from_of(self.origin_of(t)?);
                let val = self.eval(t)?;
                host.as_file(&val, &from).map_err(host_err)
            }
            ("asLink" | "hasLink", Some(t), rest) => {
                let CelValue::Map(file) = self.eval(t)? else {
                    return err(format!("{func}() is a method of `file`"));
                };
                let Some(CelValue::String(path)) = file.get_str("path").cloned() else {
                    return err(format!("{func}() needs `file.path`"));
                };
                match (func, rest) {
                    ("asLink", []) => host.as_link(&path).map_err(host_err),
                    ("hasLink", [v]) => {
                        let val = self.eval(v)?;
                        host.has_link(&path, &val)
                            .map(CelValue::Bool)
                            .map_err(host_err)
                    }
                    _ => err(format!("wrong arguments to {func}()")),
                }
            }
            _ => err(format!("wrong arguments to {func}()")),
        }
    }

    /// `&&` (`or == false`) and `||` with CEL's commutative error absorption:
    /// a decisive value on either side wins over an error on the other.
    fn logic(&mut self, a: &Expr, b: &Expr, or: bool) -> R {
        let decisive = |v: &R| matches!(v, Ok(CelValue::Bool(x)) if *x == or);
        let x = self.eval(a);
        if decisive(&x) {
            return x;
        }
        let y = self.eval(b);
        if decisive(&y) {
            return y;
        }
        let op = if or { "_||_" } else { "_&&_" };
        match (x, y) {
            (Ok(CelValue::Bool(_)), Ok(CelValue::Bool(_))) => Ok(CelValue::Bool(!or)),
            (Err(e), _) | (_, Err(e)) => Err(e),
            (Ok(p), Ok(q)) => no_overload(op, &[&p, &q]),
        }
    }

    fn comprehension(
        &mut self,
        kind: MacroKind,
        range: &Expr,
        var: &str,
        body: &Expr,
        filter: Option<&Expr>,
    ) -> R {
        let items: Vec<CelValue> = match self.eval(range)? {
            CelValue::List(l) => l.as_ref().clone(),
            CelValue::Map(m) => m.keys().collect(),
            v => return no_overload(macro_name(kind), &[&v]),
        };
        let mut out = Vec::new();
        let mut count = 0u64;
        let mut first_err: Option<EvalError> = None;
        for item in items {
            self.step()?;
            self.locals.push((var.to_owned(), item.clone()));
            let r = match (kind, filter) {
                (MacroKind::Map, Some(pred)) => match self.eval(pred) {
                    Ok(CelValue::Bool(true)) => self.eval(body).map(Some),
                    Ok(CelValue::Bool(false)) => Ok(None),
                    Ok(v) => no_overload("map", &[&v]).map(|_| None),
                    Err(e) => Err(e),
                },
                (MacroKind::Map, None) => self.eval(body).map(Some),
                _ => self.eval(body).map(Some),
            };
            self.locals.pop();
            match kind {
                MacroKind::Map => match r {
                    Ok(Some(v)) => out.push(v),
                    Ok(None) => {}
                    Err(e) => return Err(e),
                },
                MacroKind::Filter => match r? {
                    Some(CelValue::Bool(true)) => out.push(item),
                    Some(CelValue::Bool(false)) | None => {}
                    Some(v) => return no_overload("filter", &[&v]),
                },
                MacroKind::All | MacroKind::Exists => {
                    let decisive = kind == MacroKind::Exists;
                    match r {
                        Ok(Some(CelValue::Bool(b))) if b == decisive => {
                            return Ok(CelValue::Bool(decisive));
                        }
                        Ok(Some(CelValue::Bool(_))) => {}
                        Ok(Some(v)) => {
                            first_err.get_or_insert(EvalError {
                                message: format!(
                                    "no such overload: {}(.., {})",
                                    macro_name(kind),
                                    v.type_name()
                                ),
                            });
                        }
                        Ok(None) => {}
                        Err(e) => {
                            first_err.get_or_insert(e);
                        }
                    }
                }
                MacroKind::ExistsOne => match r? {
                    Some(CelValue::Bool(true)) => count += 1,
                    Some(CelValue::Bool(false)) | None => {}
                    Some(v) => return no_overload("exists_one", &[&v]),
                },
            }
        }
        match kind {
            MacroKind::Map | MacroKind::Filter => Ok(CelValue::List(Arc::new(out))),
            MacroKind::All | MacroKind::Exists => match first_err {
                Some(e) => Err(e),
                None => Ok(CelValue::Bool(kind == MacroKind::All)),
            },
            MacroKind::ExistsOne => Ok(CelValue::Bool(count == 1)),
        }
    }
}

fn macro_name(kind: MacroKind) -> &'static str {
    match kind {
        MacroKind::All => "all",
        MacroKind::Exists => "exists",
        MacroKind::ExistsOne => "exists_one",
        MacroKind::Map => "map",
        MacroKind::Filter => "filter",
    }
}

fn to_key(v: &CelValue) -> Result<Key, EvalError> {
    Ok(match v {
        CelValue::Bool(b) => Key::Bool(*b),
        CelValue::Int(i) => Key::Int(*i),
        CelValue::Uint(u) => Key::Uint(*u),
        CelValue::String(s) => Key::String(s.clone()),
        other => {
            return Err(EvalError {
                message: format!("unsupported map key type {}", other.type_name()),
            });
        }
    })
}

fn select(v: &CelValue, field: &str, test: bool, optional: bool) -> R {
    match v {
        CelValue::Optional(None) if optional => Ok(CelValue::Optional(None)),
        CelValue::Optional(Some(inner)) if optional => select(inner, field, test, true),
        CelValue::Map(m) => {
            let found = m.get_str(field);
            if test {
                return Ok(CelValue::Bool(found.is_some()));
            }
            if optional {
                return Ok(CelValue::Optional(found.map(|v| Arc::new(v.clone()))));
            }
            match found {
                Some(v) => Ok(v.clone()),
                None => err(format!("no such key: {field}")),
            }
        }
        other => err(format!(
            "cannot select field `{field}` from {}",
            other.type_name()
        )),
    }
}

fn index_value(v: &CelValue, i: &CelValue, optional: bool) -> R {
    match v {
        CelValue::Optional(None) if optional => Ok(CelValue::Optional(None)),
        CelValue::Optional(Some(inner)) if optional => index_value(inner, i, true),
        CelValue::List(l) => {
            let idx = match i {
                CelValue::Int(n) => usize::try_from(*n).ok(),
                CelValue::Uint(n) => usize::try_from(*n).ok(),
                CelValue::Double(d) if d.fract() == 0.0 && *d >= 0.0 && *d < 4_294_967_296.0 => {
                    // Integral and in range: exact.
                    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                    Some(*d as usize)
                }
                other => return no_overload("_[_]", &[v, other]),
            };
            match idx.and_then(|n| l.get(n)) {
                Some(x) if optional => Ok(CelValue::Optional(Some(Arc::new(x.clone())))),
                Some(x) => Ok(x.clone()),
                None if optional => Ok(CelValue::Optional(None)),
                None => err(format!("index out of range: {}", i.display())),
            }
        }
        CelValue::Map(m) => match m.get(i) {
            Some(x) if optional => Ok(CelValue::Optional(Some(Arc::new(x.clone())))),
            Some(x) => Ok(x.clone()),
            None if optional => Ok(CelValue::Optional(None)),
            None => err(format!("no such key: {}", i.display())),
        },
        other => no_overload("_[_]", &[other, i]),
    }
}

fn binary(op: BinOp, x: &CelValue, y: &CelValue) -> R {
    use CelValue as V;
    match op {
        BinOp::Eq => Ok(V::Bool(x.equals(y))),
        BinOp::Ne => Ok(V::Bool(!x.equals(y))),
        BinOp::Lt | BinOp::Le | BinOp::Gt | BinOp::Ge => {
            let ord = match (x, y) {
                (V::String(a), V::String(b)) => Some(a.as_ref().cmp(b.as_ref())),
                (V::Bytes(a), V::Bytes(b)) => Some(a.as_ref().cmp(b.as_ref())),
                (V::Bool(a), V::Bool(b)) => Some(a.cmp(b)),
                (V::Timestamp(a), V::Timestamp(b)) => Some(a.cmp(b)),
                (V::Duration(a), V::Duration(b)) => Some(a.cmp(b)),
                _ if is_num(x) && is_num(y) => numeric_cmp(x, y),
                _ => {
                    let name = match op {
                        BinOp::Lt => "_<_",
                        BinOp::Le => "_<=_",
                        BinOp::Gt => "_>_",
                        _ => "_>=_",
                    };
                    return no_overload(name, &[x, y]);
                }
            };
            // NaN compares false with everything.
            let Some(o) = ord else {
                return Ok(V::Bool(false));
            };
            Ok(V::Bool(match op {
                BinOp::Lt => o == Ordering::Less,
                BinOp::Le => o != Ordering::Greater,
                BinOp::Gt => o == Ordering::Greater,
                _ => o != Ordering::Less,
            }))
        }
        BinOp::In => match y {
            V::List(l) => Ok(V::Bool(l.iter().any(|e| e.equals(x)))),
            V::Map(m) => Ok(V::Bool(m.get(x).is_some())),
            _ => no_overload("@in", &[x, y]),
        },
        BinOp::Add => match (x, y) {
            (V::Int(a), V::Int(b)) => a.checked_add(*b).map(V::Int).ok_or(overflow("int")),
            (V::Uint(a), V::Uint(b)) => a.checked_add(*b).map(V::Uint).ok_or(overflow("uint")),
            (V::Double(a), V::Double(b)) => Ok(V::Double(a + b)),
            (V::String(a), V::String(b)) => Ok(V::String(Arc::from(format!("{a}{b}")))),
            (V::Bytes(a), V::Bytes(b)) => {
                Ok(V::Bytes(Arc::from([a.as_ref(), b.as_ref()].concat())))
            }
            (V::List(a), V::List(b)) => {
                let mut v = a.as_ref().clone();
                v.extend(b.iter().cloned());
                Ok(V::List(Arc::new(v)))
            }
            (V::Timestamp(t), V::Duration(d)) | (V::Duration(d), V::Timestamp(t)) => {
                t.checked_add(*d).map(V::Timestamp).map_err(time_err)
            }
            (V::Duration(a), V::Duration(b)) => {
                a.checked_add(*b).map(V::Duration).map_err(time_err)
            }
            _ => no_overload("_+_", &[x, y]),
        },
        BinOp::Sub => match (x, y) {
            (V::Int(a), V::Int(b)) => a.checked_sub(*b).map(V::Int).ok_or(overflow("int")),
            (V::Uint(a), V::Uint(b)) => a.checked_sub(*b).map(V::Uint).ok_or(overflow("uint")),
            (V::Double(a), V::Double(b)) => Ok(V::Double(a - b)),
            (V::Timestamp(t), V::Duration(d)) => t
                .checked_add(d.negated())
                .map(V::Timestamp)
                .map_err(time_err),
            (V::Timestamp(a), V::Timestamp(b)) => a.since(*b).map(V::Duration).map_err(time_err),
            (V::Duration(a), V::Duration(b)) => a
                .checked_add(b.negated())
                .map(V::Duration)
                .map_err(time_err),
            _ => no_overload("_-_", &[x, y]),
        },
        BinOp::Mul => match (x, y) {
            (V::Int(a), V::Int(b)) => a.checked_mul(*b).map(V::Int).ok_or(overflow("int")),
            (V::Uint(a), V::Uint(b)) => a.checked_mul(*b).map(V::Uint).ok_or(overflow("uint")),
            (V::Double(a), V::Double(b)) => Ok(V::Double(a * b)),
            _ => no_overload("_*_", &[x, y]),
        },
        BinOp::Div => match (x, y) {
            (V::Int(_), V::Int(0)) | (V::Uint(_), V::Uint(0)) => err("division by zero"),
            (V::Int(a), V::Int(b)) => a.checked_div(*b).map(V::Int).ok_or(overflow("int")),
            (V::Uint(a), V::Uint(b)) => Ok(V::Uint(a / b)),
            (V::Double(a), V::Double(b)) => Ok(V::Double(a / b)),
            _ => no_overload("_/_", &[x, y]),
        },
        BinOp::Rem => match (x, y) {
            (V::Int(_), V::Int(0)) | (V::Uint(_), V::Uint(0)) => err("modulus by zero"),
            (V::Int(a), V::Int(b)) => a.checked_rem(*b).map(V::Int).ok_or(overflow("int")),
            (V::Uint(a), V::Uint(b)) => Ok(V::Uint(a % b)),
            _ => no_overload("_%_", &[x, y]),
        },
    }
}

fn time_err(e: time::TimeError) -> EvalError {
    EvalError { message: e.0 }
}

fn overflow(t: &str) -> EvalError {
    EvalError {
        message: format!("{t} overflow"),
    }
}

fn is_num(v: &CelValue) -> bool {
    matches!(
        v,
        CelValue::Int(_) | CelValue::Uint(_) | CelValue::Double(_)
    )
}

fn call(func: &str, target: Option<&CelValue>, args: &[CelValue], clock: &Clock) -> R {
    use CelValue as V;
    // Receiver-style calls become (target, args...).
    let all: Vec<&CelValue> = target.into_iter().chain(args.iter()).collect();
    if let Some(r) = temporal(func, target.is_some(), &all, clock) {
        return r;
    }
    match (func, all.as_slice()) {
        ("size", [v]) => match v {
            V::String(s) => Ok(V::Int(len_i64(s.chars().count()))),
            V::Bytes(b) => Ok(V::Int(len_i64(b.len()))),
            V::List(l) => Ok(V::Int(len_i64(l.len()))),
            V::Map(m) => Ok(V::Int(len_i64(m.len()))),
            _ => no_overload("size", &all),
        },
        ("contains", [V::String(s), V::String(t)]) => Ok(V::Bool(s.contains(&**t))),
        ("startsWith", [V::String(s), V::String(t)]) => Ok(V::Bool(s.starts_with(&**t))),
        ("endsWith", [V::String(s), V::String(t)]) => Ok(V::Bool(s.ends_with(&**t))),
        ("matches", [V::String(s), V::String(p)]) => match Pattern::new(p) {
            Ok(p) => Ok(V::Bool(p.is_match(s))),
            Err(e) => err(e.to_string()),
        },
        ("lower", [V::String(s)]) if target.is_some() => Ok(V::String(Arc::from(s.to_lowercase()))),
        ("upper", [V::String(s)]) if target.is_some() => Ok(V::String(Arc::from(s.to_uppercase()))),
        ("dyn", [v]) if target.is_none() => Ok((*v).clone()),
        ("type", [v]) if target.is_none() => Ok(V::string(v.type_name())),
        ("string", [v]) if target.is_none() => match v {
            V::String(_) => Ok((*v).clone()),
            V::Bytes(b) => match std::str::from_utf8(b) {
                Ok(s) => Ok(V::string(s)),
                Err(_) => err("bytes are not valid UTF-8"),
            },
            V::Int(_) | V::Uint(_) | V::Double(_) | V::Bool(_) => {
                Ok(V::String(Arc::from(v.display())))
            }
            V::Timestamp(t) => Ok(V::String(Arc::from(t.to_rfc3339()))),
            V::Duration(d) => Ok(V::String(Arc::from(d.to_cel_string()))),
            _ => no_overload("string", &all),
        },
        ("bytes", [V::String(s)]) if target.is_none() => Ok(V::Bytes(Arc::from(s.as_bytes()))),
        ("bool", [v]) if target.is_none() => match v {
            V::Bool(_) => Ok((*v).clone()),
            V::String(s) => match &**s {
                "true" | "TRUE" | "True" | "t" | "1" => Ok(V::Bool(true)),
                "false" | "FALSE" | "False" | "f" | "0" => Ok(V::Bool(false)),
                _ => err(format!("cannot convert {s:?} to bool")),
            },
            _ => no_overload("bool", &all),
        },
        ("int", [v]) if target.is_none() => match v {
            V::Int(_) => Ok((*v).clone()),
            V::Uint(u) => i64::try_from(*u).map(V::Int).map_err(|_| overflow("int")),
            V::Double(d) => double_to_int(*d),
            V::Timestamp(t) => Ok(V::Int(t.seconds)),
            V::String(s) => s.parse::<i64>().map(V::Int).map_err(|_| EvalError {
                message: format!("cannot convert {s:?} to int"),
            }),
            _ => no_overload("int", &all),
        },
        ("uint", [v]) if target.is_none() => match v {
            V::Uint(_) => Ok((*v).clone()),
            V::Int(i) => u64::try_from(*i).map(V::Uint).map_err(|_| overflow("uint")),
            V::Double(d) => {
                // As cel-go: any negative value is out of range.
                if d.is_finite() && *d >= 0.0 && *d < 18_446_744_073_709_551_616.0 {
                    // Range-checked; truncation toward zero is CEL's rule.
                    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                    Ok(V::Uint(d.trunc() as u64))
                } else {
                    Err(overflow("uint"))
                }
            }
            V::String(s) => s.parse::<u64>().map(V::Uint).map_err(|_| EvalError {
                message: format!("cannot convert {s:?} to uint"),
            }),
            _ => no_overload("uint", &all),
        },
        ("double", [v]) if target.is_none() => match v {
            V::Double(_) => Ok((*v).clone()),
            // Nearest double, as CEL specifies.
            #[allow(clippy::cast_precision_loss)]
            V::Int(i) => Ok(V::Double(*i as f64)),
            #[allow(clippy::cast_precision_loss)]
            V::Uint(u) => Ok(V::Double(*u as f64)),
            V::String(s) => s.parse::<f64>().map(V::Double).map_err(|_| EvalError {
                message: format!("cannot convert {s:?} to double"),
            }),
            _ => no_overload("double", &all),
        },
        ("optional.of", [v]) => Ok(V::Optional(Some(Arc::new((*v).clone())))),
        ("optional.none", []) => Ok(V::Optional(None)),
        ("optional.ofNonZeroValue", [v]) => {
            let zero = match v {
                V::Null => true,
                V::Bool(b) => !b,
                V::Int(i) => *i == 0,
                V::Uint(u) => *u == 0,
                V::Double(d) => *d == 0.0,
                V::String(s) => s.is_empty(),
                V::Bytes(b) => b.is_empty(),
                V::List(l) => l.is_empty(),
                V::Map(m) => m.is_empty(),
                V::Optional(o) => o.is_none(),
                V::Timestamp(t) => t.seconds == 0 && t.nanos == 0,
                V::Duration(d) => d.nanos == 0,
            };
            Ok(V::Optional((!zero).then(|| Arc::new((*v).clone()))))
        }
        ("inFolder", [V::Map(file), V::String(folder)]) if target.is_some() => {
            let Some(V::String(f)) = file.get_str("folder") else {
                return err("inFolder() needs `file.folder`");
            };
            let want = folder.trim_matches('/');
            Ok(V::Bool(
                want.is_empty() || &**f == want || f.starts_with(&format!("{want}/")),
            ))
        }
        ("hasTag", [V::Map(file), V::String(tag)]) if target.is_some() => {
            let want = tag.trim_start_matches('#');
            let tags = match file.get_str("tags") {
                Some(V::List(l)) => l.clone(),
                _ => return err("hasTag() needs `file.tags`"),
            };
            Ok(V::Bool(
                !want.is_empty()
                    && tags.iter().any(|t| match t {
                        V::String(t) => {
                            let t = t.trim_start_matches('#');
                            t == want || t.starts_with(&format!("{want}/"))
                        }
                        _ => false,
                    }),
            ))
        }
        ("hasValue", [V::Optional(o)]) => Ok(V::Bool(o.is_some())),
        ("value", [V::Optional(o)]) => match o {
            Some(v) => Ok(v.as_ref().clone()),
            None => err("optional.none() has no value"),
        },
        ("orValue", [V::Optional(o), d]) => Ok(o
            .as_ref()
            .map_or_else(|| (*d).clone(), |v| v.as_ref().clone())),
        ("or", [V::Optional(o), other @ V::Optional(_)]) => Ok(if o.is_some() {
            V::Optional(o.clone())
        } else {
            (*other).clone()
        }),
        _ => no_overload(func, &all),
    }
}

fn len_i64(n: usize) -> i64 {
    i64::try_from(n).unwrap_or(i64::MAX)
}

/// CEL `int(double)`: truncation toward zero, an error outside `i64`.
fn double_to_int(d: f64) -> R {
    const TWO_POW_63: f64 = 9_223_372_036_854_775_808.0;
    // Both ends exclusive, as in cel-go: -2^63 itself is out of range.
    if d.is_finite() && d > -TWO_POW_63 && d < TWO_POW_63 {
        // Range-checked: exact after truncation.
        #[allow(clippy::cast_possible_truncation)]
        Ok(CelValue::Int(d.trunc() as i64))
    } else {
        Err(overflow("int"))
    }
}

/// The temporal functions (spec 10 "Temporal Values"), or `None` when `func`
/// is not one of them for these arguments.
fn temporal(func: &str, method: bool, args: &[&CelValue], clock: &Clock) -> Option<R> {
    use CelValue as V;
    let date_str = |s: &str| -> Result<i64, EvalError> { time::date_days(s).map_err(time_err) };
    let zone = || -> Result<&dyn TimeZoneRules, EvalError> {
        clock.tz.as_deref().ok_or(EvalError {
            message: "unsupported_timezone: no time zone rules in this context".into(),
        })
    };
    let s = |x: String| V::String(Arc::from(x));
    Some(match (func, method, args) {
        ("now", false, []) => clock.instant.map(V::Timestamp).ok_or(EvalError {
            message: "now() is not available in this context".into(),
        }),
        ("today", false, []) => clock.local_date.as_deref().map(V::string).ok_or(EvalError {
            message: "today() is not available in this context".into(),
        }),
        ("timestamp", false, [V::String(x)]) => {
            Timestamp::parse(x).map(V::Timestamp).map_err(time_err)
        }
        ("timestamp", false, [V::Timestamp(t)]) => Ok(V::Timestamp(*t)),
        ("duration", false, [V::String(x)]) => {
            Duration::parse(x).map(V::Duration).map_err(time_err)
        }
        ("duration", false, [V::Duration(d)]) => Ok(V::Duration(*d)),
        ("date", false, [V::String(x)]) => date_str(x).map(|_| (*args[0]).clone()),
        ("date", false, [V::Timestamp(t)]) => zone().and_then(|z| {
            time::days_date(time::local_days(z, t.seconds))
                .map(s)
                .map_err(time_err)
        }),
        ("startOfDay", false, [V::String(x)]) => date_str(x).and_then(|d| {
            let z = zone()?;
            Timestamp::checked_seconds(time::start_of_local_day(z, d))
                .map(V::Timestamp)
                .map_err(time_err)
        }),
        ("addDays", true, [V::String(x), V::Int(n)]) => date_str(x).and_then(|d| {
            let days = d.checked_add(*n).ok_or(overflow("date"))?;
            time::days_date(days).map(s).map_err(time_err)
        }),
        ("addMonths", true, [V::String(x), V::Int(n)]) => {
            time::add_months(x, *n).map(s).map_err(time_err)
        }
        ("addYears", true, [V::String(x), V::Int(n)]) => match n.checked_mul(12) {
            Some(m) => time::add_months(x, m).map(s).map_err(time_err),
            None => Err(overflow("date")),
        },
        ("daysUntil", true, [V::String(x), V::String(y)]) => {
            date_str(x).and_then(|a| date_str(y).map(|b| V::Int(b - a)))
        }
        ("year" | "month" | "day" | "dayOfWeek", true, [V::String(x)]) => date_str(x).map(|d| {
            let (y, m, dd) = time::civil_from_days(d);
            V::Int(match func {
                "year" => y,
                "month" => m,
                "day" => dd,
                // ISO weekday: 1970-01-01 was a Thursday (4).
                _ => (d + 3).rem_euclid(7) + 1,
            })
        }),
        // CEL standard timestamp accessors, in UTC or a named zone (`"+10:00"`
        // or, with zone data, the context's zone via `"local"` is not CEL).
        (
            "getFullYear" | "getMonth" | "getDayOfMonth" | "getDate" | "getDayOfWeek"
            | "getDayOfYear" | "getHours" | "getMinutes" | "getSeconds" | "getMilliseconds",
            true,
            [V::Timestamp(t), rest @ ..],
        ) => {
            let off = match rest {
                [] => Ok(0i64),
                [V::String(z)] => zone_offset(z, t.seconds),
                _ => return None,
            };
            off.map(|off| {
                let local = t.seconds + off;
                let (days, sod) = (local.div_euclid(86_400), local.rem_euclid(86_400));
                let (y, m, d) = time::civil_from_days(days);
                V::Int(match func {
                    "getFullYear" => y,
                    "getMonth" => m - 1,
                    "getDayOfMonth" => d - 1,
                    "getDate" => d,
                    // 0 = Sunday.
                    "getDayOfWeek" => (days + 4).rem_euclid(7),
                    "getDayOfYear" => days - time::days_from_civil(y, 1, 1),
                    "getHours" => sod / 3600,
                    "getMinutes" => sod / 60 % 60,
                    "getSeconds" => sod % 60,
                    _ => i64::from(t.nanos / 1_000_000),
                })
            })
        }
        ("getHours" | "getMinutes" | "getSeconds" | "getMilliseconds", true, [V::Duration(d)]) => {
            let n = d.nanos;
            let v = match func {
                "getHours" => n / (3600 * 1_000_000_000),
                "getMinutes" => n / (60 * 1_000_000_000),
                "getSeconds" => n / 1_000_000_000,
                _ => n / 1_000_000,
            };
            Ok(V::Int(i64::try_from(v).unwrap_or(i64::MAX)))
        }
        _ => return None,
    })
}

/// A fixed-offset argument or an exact IANA name in the embedded release.
fn zone_offset(z: &str, seconds: i64) -> Result<i64, EvalError> {
    if z == "UTC" || z == "Z" {
        return Ok(0);
    }
    let b = z.as_bytes();
    if z.is_ascii()
        && b.len() == 6
        && matches!(b[0], b'+' | b'-')
        && b[3] == b':'
        && b[1..3].iter().chain(&b[4..6]).all(u8::is_ascii_digit)
    {
        let h: i64 = z[1..3].parse().map_err(|_| bad_zone(z))?;
        let m: i64 = z[4..6].parse().map_err(|_| bad_zone(z))?;
        if h <= 23 && m <= 59 {
            let v = h * 3600 + m * 60;
            return Ok(if b[0] == b'-' { -v } else { v });
        }
    }
    time::NamedZone::get(z)
        .map(|zone| i64::from(zone.offset_at(seconds)))
        .map_err(time_err)
}

fn bad_zone(z: &str) -> EvalError {
    EvalError {
        message: format!("unsupported_timezone: {z:?}"),
    }
}
