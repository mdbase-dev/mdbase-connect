//! The mdbase YAML profile: parsing with source spans, composition into
//! [`Value`]s, and style-aware emission.
//!
//! # Why a purpose-built parser
//!
//! The writer format-fidelity rule (spec 12A) needs, for every top-level entry,
//! its exact line range, its collection style (block or flow), its scalar style
//! and any trailing comment, and it needs every emitted value to re-parse to
//! exactly the intended value under the *same* parser that reads it back. A
//! generic YAML library gives values but not reliable spans and styles, resolves
//! scalars with its own schema, and leaves aliases, nesting depth and duplicate
//! keys to library defaults that differ between versions and platforms. Owning
//! the parser makes all of that part of the deterministic core, keeps the WASM
//! build small, and lets the writer verify its own output.
//!
//! # The profile
//!
//! - **Syntax.** YAML 1.2 block and flow collections, plain, single-quoted,
//!   double-quoted and block (`|`, `>`) scalars with chomping and indentation
//!   indicators, comments, anchors and aliases, tags, and an optional `---`
//!   start / `...` end marker. Unsupported, and reported as errors: directives,
//!   multiple documents, explicit keys (`? `), keys that are collections or
//!   aliases, properties on block mapping keys, tabs as indentation, and bare
//!   carriage returns.
//! - **Scalars** resolve with the YAML 1.2 core schema ([`schema`]): `null`,
//!   `true`/`false`, decimal/octal/hex integers and decimal floats. Everything
//!   else, including timestamps, is a string. `.inf` and `.nan`, and numbers too
//!   large for a finite `f64`, stay strings with their source spelling (spec 03:
//!   non-JSON values are handled by the profile).
//! - **Tags.** `!`, `!!str`, `!!int`, `!!float`, `!!bool`, `!!null`, `!!seq` and
//!   `!!map` (or their `tag:yaml.org,2002:` forms). Any other tag is an error; no
//!   tag is ever executed (spec 03).
//! - **Mapping keys** are strings: a plain key is taken as written (`1:` is the
//!   key `"1"`), a quoted key by its value. Duplicate keys are an error.
//! - **Limits.** Nesting depth is at most [`parse::MAX_DEPTH`], and alias
//!   expansion may produce at most [`MAX_ALIAS_NODES`] value nodes, so hostile
//!   input cannot exhaust the stack or memory.

pub mod budget;
pub(crate) mod emit;
pub(crate) mod parse;
pub mod schema;

use std::collections::BTreeMap;
use std::fmt;

use crate::value::{Map, Value};
pub use parse::ScalarStyle;
use parse::{Kind, Node};

/// Maximum number of value nodes that alias expansion may add to one document.
pub const MAX_ALIAS_NODES: u64 = 100_000;

/// Why YAML could not be read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ErrorKind {
    /// A construct outside the profile.
    Unsupported(&'static str),
    /// Tab characters used as indentation.
    TabIndentation,
    /// A `\r` that is not part of `\r\n`.
    BareCarriageReturn,
    /// Nesting deeper than the profile allows.
    TooDeep,
    /// Content after the document.
    UnexpectedContent,
    /// A character that cannot start a node here.
    UnexpectedCharacter,
    /// More than one document.
    MultipleDocuments,
    /// Inconsistent indentation.
    BadIndentation,
    /// A line in a block mapping that is not `key: value`.
    ExpectedKey,
    /// `key: a: b`: a mapping cannot start after `key:` on the same line.
    MapInInlineValue,
    /// `key: - a`: a sequence cannot start after `key:` on the same line.
    SeqInInlineValue,
    /// A quoted scalar without its closing quote.
    UnterminatedQuoted,
    /// A flow collection without its closing bracket.
    UnterminatedFlow,
    /// Missing `,` between flow collection entries.
    ExpectedFlowSeparator,
    /// An invalid escape in a double-quoted scalar.
    InvalidEscape,
    /// An invalid block scalar header.
    InvalidBlockScalarHeader,
    /// An empty or malformed anchor or alias name.
    InvalidAnchor,
    /// A malformed tag.
    InvalidTag,
    /// Two anchors or two tags on one node.
    DuplicateProperty,
    /// A tag outside the profile.
    UnsupportedTag(String),
    /// A scalar that does not match its tag (`!!int abc`).
    TagMismatch(String),
    /// An alias to an anchor that was not defined before it.
    UndefinedAlias(String),
    /// Alias expansion would exceed [`MAX_ALIAS_NODES`].
    AliasLimit,
    /// A key that occurs twice in one mapping.
    DuplicateKey(String),
    /// Explicit bounded frontmatter parsing refused a resource dimension.
    ResourceLimit(budget::LimitExceeded),
}

impl fmt::Display for ErrorKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ErrorKind::Unsupported(what) => write!(f, "unsupported YAML: {what}"),
            ErrorKind::TabIndentation => f.write_str("tabs are not allowed as indentation"),
            ErrorKind::BareCarriageReturn => f.write_str("carriage return without line feed"),
            ErrorKind::TooDeep => f.write_str("nesting is too deep"),
            ErrorKind::UnexpectedContent => f.write_str("unexpected content"),
            ErrorKind::UnexpectedCharacter => f.write_str("unexpected character"),
            ErrorKind::MultipleDocuments => f.write_str("more than one YAML document"),
            ErrorKind::BadIndentation => f.write_str("bad indentation"),
            ErrorKind::ExpectedKey => f.write_str("expected a mapping key"),
            ErrorKind::MapInInlineValue => f.write_str("mapping values are not allowed here"),
            ErrorKind::SeqInInlineValue => {
                f.write_str("block sequence entries are not allowed here")
            }
            ErrorKind::UnterminatedQuoted => f.write_str("unterminated quoted scalar"),
            ErrorKind::UnterminatedFlow => f.write_str("unterminated flow collection"),
            ErrorKind::ExpectedFlowSeparator => f.write_str("expected `,` or a closing bracket"),
            ErrorKind::InvalidEscape => f.write_str("invalid escape sequence"),
            ErrorKind::InvalidBlockScalarHeader => f.write_str("invalid block scalar header"),
            ErrorKind::InvalidAnchor => f.write_str("invalid anchor or alias name"),
            ErrorKind::InvalidTag => f.write_str("invalid tag"),
            ErrorKind::DuplicateProperty => f.write_str("a node has two anchors or two tags"),
            ErrorKind::UnsupportedTag(t) => write!(f, "unsupported tag {t}"),
            ErrorKind::TagMismatch(t) => write!(f, "value does not match tag {t}"),
            ErrorKind::UndefinedAlias(a) => write!(f, "undefined alias *{a}"),
            ErrorKind::AliasLimit => f.write_str("alias expansion is too large"),
            ErrorKind::DuplicateKey(k) => write!(f, "duplicate key {k:?}"),
            ErrorKind::ResourceLimit(e) => e.fmt(f),
        }
    }
}

/// A YAML error with its position (1-based line and column, column counted in
/// Unicode scalar values).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct YamlError {
    /// What went wrong.
    pub kind: ErrorKind,
    /// 1-based line.
    pub line: u32,
    /// 1-based column, in Unicode scalar values.
    pub column: u32,
}

impl YamlError {
    pub(crate) fn at(src: &str, pos: usize, kind: ErrorKind) -> YamlError {
        let pos = floor_char_boundary(src, pos.min(src.len()));
        let before = &src[..pos];
        let line = before.bytes().filter(|&c| c == b'\n').count() + 1;
        let line_start = before.rfind('\n').map_or(0, |i| i + 1);
        let column = before[line_start..].chars().count() + 1;
        YamlError {
            kind,
            line: u32::try_from(line).unwrap_or(u32::MAX),
            column: u32::try_from(column).unwrap_or(u32::MAX),
        }
    }
}

fn floor_char_boundary(s: &str, mut i: usize) -> usize {
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

impl fmt::Display for YamlError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{} at line {}, column {}",
            self.kind, self.line, self.column
        )
    }
}

impl std::error::Error for YamlError {}

/// Parse one YAML document into a value. `Ok(None)` for an empty document (no
/// content besides comments and blank lines).
pub fn parse_value(src: &str) -> Result<Option<Value>, YamlError> {
    Ok(Parsed::new(src)?.value)
}

/// Parse with the immutable frontmatter structural/allocation-estimate limits.
/// ResourceLimit stays typed and must not be treated as ordinary invalid YAML.
/// Legacy replay/writer callers keep using `parse_value` explicitly.
pub fn parse_value_bounded(src: &str) -> Result<(Option<Value>, budget::Footprint), YamlError> {
    let mut b = budget::Budget::new();
    let parsed = Parsed::with_budget(src, &mut b)?;
    Ok((parsed.value, b.footprint))
}

/// A parsed document: the span tree and its composed value.
#[derive(Debug, Clone)]
pub(crate) struct Parsed {
    pub root: Option<Node>,
    pub value: Option<Value>,
}

impl Parsed {
    pub(crate) fn new(src: &str) -> Result<Parsed, YamlError> {
        Self::new_impl(src, None)
    }
    pub(crate) fn with_budget(src: &str, budget: &mut budget::Budget) -> Result<Parsed, YamlError> {
        Self::new_impl(src, Some(budget))
    }
    fn new_impl(src: &str, mut budget: Option<&mut budget::Budget>) -> Result<Parsed, YamlError> {
        let doc = match budget.as_deref_mut() {
            Some(b) => parse::parse_with_budget(src, Some(b))?,
            None => parse::parse(src)?,
        };
        let mut c = Composer {
            src,
            anchors: BTreeMap::new(),
            alias_nodes: 0,
            budget,
        };
        let value = match &doc.root {
            None => None,
            Some(n) => Some(c.compose(n)?),
        };
        Ok(Parsed {
            root: doc.root,
            value,
        })
    }
}

struct Composer<'a> {
    src: &'a str,
    anchors: BTreeMap<String, Value>,
    alias_nodes: u64,
    budget: Option<&'a mut budget::Budget>,
}

/// The core tags the profile accepts, by their short and long spellings.
fn core_tag(tag: &str) -> Option<&'static str> {
    let short = tag.strip_prefix("!!").or_else(|| {
        tag.strip_prefix("!<tag:yaml.org,2002:")
            .and_then(|t| t.strip_suffix('>'))
    });
    match short {
        Some("str") => Some("str"),
        Some("int") => Some("int"),
        Some("float") => Some("float"),
        Some("bool") => Some("bool"),
        Some("null") => Some("null"),
        Some("seq") => Some("seq"),
        Some("map") => Some("map"),
        _ if tag == "!" => Some("!"),
        _ => None,
    }
}

impl Composer<'_> {
    fn err<T>(&self, node: &Node, kind: ErrorKind) -> Result<T, YamlError> {
        Err(YamlError::at(self.src, node.span.start, kind))
    }

    fn compose(&mut self, node: &Node) -> Result<Value, YamlError> {
        self.compose_at(node, 1)
    }
    fn compose_at(&mut self, node: &Node, depth: u32) -> Result<Value, YamlError> {
        if let Some(b) = self.budget.as_mut() {
            b.depth(depth)
                .and_then(|()| {
                    if matches!(node.kind, Kind::Alias(_)) {
                        Ok(())
                    } else {
                        b.values(1)
                    }
                })
                .map_err(|e| {
                    YamlError::at(self.src, node.span.start, ErrorKind::ResourceLimit(e))
                })?;
        }
        let tag = match &node.tag {
            None => None,
            Some(t) => match core_tag(t) {
                Some(c) => Some(c),
                None => return self.err(node, ErrorKind::UnsupportedTag(t.clone())),
            },
        };
        let value = match &node.kind {
            Kind::Alias(name) => {
                let Some(v) = self.anchors.get(name) else {
                    return self.err(node, ErrorKind::UndefinedAlias(name.clone()));
                };
                if let Some(b) = self.budget.as_mut() {
                    b.copy_value(v, depth, true).map_err(|e| {
                        YamlError::at(self.src, node.span.start, ErrorKind::ResourceLimit(e))
                    })?;
                }
                self.alias_nodes = self.alias_nodes.saturating_add(v.node_count());
                if self.alias_nodes > MAX_ALIAS_NODES {
                    return self.err(node, ErrorKind::AliasLimit);
                }
                v.clone()
            }
            Kind::Scalar { style, text } => {
                if let Some(b) = self.budget.as_mut() {
                    // Scalar resolution may allocate underscore-stripped spelling,
                    // numeric scratch and the final string; charge before resolution.
                    b.heap(text.len() as u64 * 4).map_err(|e| {
                        YamlError::at(self.src, node.span.start, ErrorKind::ResourceLimit(e))
                    })?;
                }
                self.scalar(node, *style, text, tag)?
            }
            Kind::Seq { items, .. } => {
                if !matches!(tag, None | Some("seq" | "!")) {
                    return self.err(
                        node,
                        ErrorKind::TagMismatch(node.tag.clone().unwrap_or_default()),
                    );
                }
                if let Some(b) = self.budget.as_mut() {
                    b.heap(items.len() as u64 * 64).map_err(|e| {
                        YamlError::at(self.src, node.span.start, ErrorKind::ResourceLimit(e))
                    })?;
                }
                let mut out = Vec::with_capacity(items.len());
                for item in items {
                    out.push(self.compose_at(item, depth + 1)?);
                }
                Value::List(out)
            }
            Kind::Map { pairs, .. } => {
                if !matches!(tag, None | Some("map" | "!")) {
                    return self.err(
                        node,
                        ErrorKind::TagMismatch(node.tag.clone().unwrap_or_default()),
                    );
                }
                let mut m = Map::new();
                for (k, v) in pairs {
                    if let Some(b) = self.budget.as_mut() {
                        let key_bytes = match &k.kind {
                            Kind::Scalar { text, .. } => text.len() as u64,
                            _ => 0,
                        };
                        b.depth(depth + 1)
                            .and_then(|()| b.values(1))
                            .and_then(|()| b.heap(768 + key_bytes * 2))
                            .map_err(|e| {
                                YamlError::at(self.src, k.span.start, ErrorKind::ResourceLimit(e))
                            })?;
                    }
                    let key = self.key(k)?;
                    if m.contains_key(&key) {
                        return self.err(k, ErrorKind::DuplicateKey(key));
                    }
                    let value = self.compose_at(v, depth + 1)?;
                    m.insert(key, value);
                }
                Value::Map(m)
            }
        };
        if let Some(a) = &node.anchor {
            if let Some(b) = self.budget.as_mut() {
                b.copy_value(&value, 1, false)
                    .and_then(|()| b.heap(1024 + a.len() as u64))
                    .map_err(|e| {
                        YamlError::at(self.src, node.span.start, ErrorKind::ResourceLimit(e))
                    })?;
            }
            self.anchors.insert(a.clone(), value.clone());
        }
        Ok(value)
    }

    fn key(&mut self, node: &Node) -> Result<String, YamlError> {
        match &node.kind {
            Kind::Scalar { text, .. } => {
                if let Some(t) = &node.tag
                    && core_tag(t).is_none()
                {
                    return self.err(node, ErrorKind::UnsupportedTag(t.clone()));
                }
                if node.anchor.is_some() {
                    return self.err(node, ErrorKind::Unsupported("anchors on mapping keys"));
                }
                Ok(text.clone())
            }
            _ => self.err(
                node,
                ErrorKind::Unsupported("collection or alias mapping keys"),
            ),
        }
    }

    fn scalar(
        &self,
        node: &Node,
        style: ScalarStyle,
        text: &str,
        tag: Option<&'static str>,
    ) -> Result<Value, YamlError> {
        let mismatch = || {
            Err(YamlError::at(
                self.src,
                node.span.start,
                ErrorKind::TagMismatch(node.tag.clone().unwrap_or_default()),
            ))
        };
        match tag {
            None => Ok(if style == ScalarStyle::Plain {
                schema::resolve_plain(text)
            } else {
                Value::Text(text.to_owned())
            }),
            Some("!" | "str") => Ok(Value::Text(text.to_owned())),
            Some("seq" | "map") => mismatch(),
            Some(t) => {
                let v = schema::resolve_plain(text);
                let ok = match (t, &v) {
                    ("null", Value::Null) | ("bool", Value::Bool(_)) => true,
                    ("int", Value::Int(_)) => true,
                    ("float", Value::Int(i)) => {
                        // `!!float 1` is the float 1.0 (exact for |i| <= 2^53).
                        let f = crate::value::Number::Int(*i).as_f64();
                        return Ok(Value::float(f).unwrap_or(v));
                    }
                    ("float", Value::Float(_)) => true,
                    _ => false,
                };
                if ok { Ok(v) } else { mismatch() }
            }
        }
    }
}

#[cfg(test)]
mod tests;
