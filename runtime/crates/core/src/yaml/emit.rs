//! Style-aware emission of one top-level entry (`key: value`).
//!
//! The writer re-emits a changed entry in the style of its previous value (spec
//! 12A rule 3): a flow collection stays flow, a block collection stays block,
//! and a scalar keeps its quoting style and the trailing comment on the entry's
//! first line when the new value can be written that way. Without a previous
//! style (a new key), lists of scalars are written in flow style, other
//! collections in block style, and strings plain unless they need quotes (or
//! would read differently in a YAML 1.1 tool).
//!
//! Every emitted entry is checked by parsing it back with the profile parser.
//! If it does not read back as exactly the intended value, the entry is emitted
//! again in a conservative form (double-quoted strings, no block scalars), so a
//! write can never change a value other than the one it means to change.

use super::parse::ScalarStyle;
use super::schema;
use super::{Parsed, YamlError};
use crate::value::{Map, Value, format_float_es};

/// The style of an entry's previous value, which a re-emission follows.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct EntryStyle {
    /// The previous value was a collection: `Some(true)` flow, `Some(false)` block.
    pub flow: Option<bool>,
    /// The previous value was a scalar in this style.
    pub scalar: Option<ScalarStyle>,
    /// A trailing comment on the entry's first line, with the whitespace before
    /// it (`"   # note"`).
    pub comment: Option<String>,
    /// Whitespace between `:` and an inline value (`" "` by default).
    pub gap: Option<String>,
    /// Indentation of block sequence items relative to the key (0 = `key:\n- a`).
    pub seq_indent: Option<usize>,
    /// Indentation of nested block mappings relative to the key.
    pub map_indent: Option<usize>,
}

/// Emit `key: value` lines ending in `eol`, at `indent` columns, following
/// `style`. `key_src` is the key exactly as it should appear (the previous
/// spelling for a re-emitted entry); `None` derives it from `key`.
pub(crate) fn emit_entry(
    key: &str,
    key_src: Option<&str>,
    value: &Value,
    style: &EntryStyle,
    indent: usize,
    eol: &str,
) -> Result<String, YamlError> {
    let key_text = key_src.map_or_else(|| emit_key(key), str::to_owned);
    for safe in [false, true] {
        let mut e = Emitter {
            out: String::new(),
            eol,
            safe,
        };
        e.entry(&key_text, value, style, indent);
        if verify(&e.out, key, value) {
            return Ok(e.out);
        }
    }
    // Unreachable for well-formed values: double-quoted scalars and plain
    // collections always read back. Report rather than write something wrong.
    Err(YamlError {
        kind: super::ErrorKind::Unsupported("value cannot be emitted"),
        line: 0,
        column: 0,
    })
}

/// Whether `text` parses to a mapping holding exactly `key: value`.
fn verify(text: &str, key: &str, value: &Value) -> bool {
    let Ok(parsed) = Parsed::new(text) else {
        return false;
    };
    match parsed.value {
        Some(Value::Map(m)) => {
            m.len() == 1 && m.get(key) == Some(value) && same_type_tree(m.get(key), value)
        }
        _ => false,
    }
}

/// Spec equality treats `1` and `1.0` as equal; the writer must also keep the
/// integer/float distinction, so compare the shape strictly.
fn same_type_tree(a: Option<&Value>, b: &Value) -> bool {
    match (a, b) {
        (Some(Value::Int(_)), Value::Int(_)) | (Some(Value::Float(_)), Value::Float(_)) => true,
        (Some(Value::List(x)), Value::List(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same_type_tree(Some(p), q))
        }
        (Some(Value::Map(x)), Value::Map(y)) => {
            x.len() == y.len() && y.iter().all(|(k, v)| same_type_tree(x.get(k), v))
        }
        (Some(Value::Int(_) | Value::Float(_)), _) | (_, Value::Int(_) | Value::Float(_)) => false,
        (Some(_), _) => true,
        (None, _) => false,
    }
}

/// A mapping key: plain when it reads back as the same string, else double-quoted.
pub(crate) fn emit_key(key: &str) -> String {
    if plain_ok(key, false) && !schema::is_yaml11_ambiguous(key) && !key.contains(':') {
        key.to_owned()
    } else {
        double_quoted(key)
    }
}

struct Emitter<'a> {
    out: String,
    eol: &'a str,
    /// Conservative mode: every string double-quoted, no block scalars.
    safe: bool,
}

fn spaces(n: usize) -> String {
    " ".repeat(n)
}

impl Emitter<'_> {
    fn entry(&mut self, key_text: &str, value: &Value, style: &EntryStyle, indent: usize) {
        self.out.push_str(&spaces(indent));
        self.out.push_str(key_text);
        self.out.push(':');
        let gap = style.gap.as_deref().unwrap_or(" ");
        let comment = style.comment.as_deref().unwrap_or("");
        match value {
            Value::List(items) if !items.is_empty() => {
                let flow = match style.flow {
                    Some(f) => f,
                    None => items.iter().all(is_scalar),
                };
                if flow {
                    self.out.push_str(gap);
                    self.flow(value);
                    self.out.push_str(comment);
                    self.out.push_str(self.eol);
                } else {
                    self.out.push_str(comment);
                    self.out.push_str(self.eol);
                    self.block_seq(items, indent + style.seq_indent.unwrap_or(2));
                }
            }
            Value::Map(m) if !m.is_empty() => {
                if style.flow == Some(true) {
                    self.out.push_str(gap);
                    self.flow(value);
                    self.out.push_str(comment);
                    self.out.push_str(self.eol);
                } else {
                    self.out.push_str(comment);
                    self.out.push_str(self.eol);
                    self.block_map(m, indent + style.map_indent.unwrap_or(2));
                }
            }
            Value::Text(s) if s.contains('\n') && !self.safe && block_scalar_ok(s) => {
                self.out.push(' ');
                let folded = style.scalar == Some(ScalarStyle::Folded);
                self.block_scalar(s, indent + 2, folded, comment);
            }
            other => {
                self.out.push_str(gap);
                if let Value::List(_) | Value::Map(_) = other {
                    // An empty collection.
                    self.flow(other);
                } else {
                    let text = self.scalar(other, style.scalar, false);
                    self.out.push_str(&text);
                }
                self.out.push_str(comment);
                self.out.push_str(self.eol);
            }
        }
    }

    fn scalar(&self, v: &Value, prefer: Option<ScalarStyle>, flow: bool) -> String {
        match v {
            Value::Null => "null".to_owned(),
            Value::Bool(b) => if *b { "true" } else { "false" }.to_owned(),
            Value::Int(i) => i.to_string(),
            Value::Float(f) => yaml_float(*f),
            Value::Text(s) => self.string(s, prefer, flow),
            // Only empty collections reach here.
            Value::List(_) => "[]".to_owned(),
            Value::Map(_) => "{}".to_owned(),
        }
    }

    fn string(&self, s: &str, prefer: Option<ScalarStyle>, flow: bool) -> String {
        if self.safe {
            return double_quoted(s);
        }
        match prefer {
            Some(ScalarStyle::Plain) if plain_ok(s, flow) => s.to_owned(),
            Some(ScalarStyle::SingleQuoted) if single_ok(s) => single_quoted(s),
            Some(ScalarStyle::DoubleQuoted) => double_quoted(s),
            _ => {
                if plain_ok(s, flow) && !schema::is_yaml11_ambiguous(s) {
                    s.to_owned()
                } else {
                    double_quoted(s)
                }
            }
        }
    }

    fn flow(&mut self, v: &Value) {
        match v {
            Value::List(items) => {
                self.out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        self.out.push_str(", ");
                    }
                    self.flow(item);
                }
                self.out.push(']');
            }
            Value::Map(m) => {
                self.out.push('{');
                for (i, (k, item)) in m.iter().enumerate() {
                    if i > 0 {
                        self.out.push_str(", ");
                    }
                    let key =
                        if plain_ok(k, true) && !schema::is_yaml11_ambiguous(k) && !k.contains(':')
                        {
                            k.to_owned()
                        } else {
                            double_quoted(k)
                        };
                    self.out.push_str(&key);
                    self.out.push_str(": ");
                    self.flow(item);
                }
                self.out.push('}');
            }
            scalar => {
                let text = self.scalar(scalar, None, true);
                self.out.push_str(&text);
            }
        }
    }

    /// Block sequence items at `indent`.
    fn block_seq(&mut self, items: &[Value], indent: usize) {
        for item in items {
            self.out.push_str(&spaces(indent));
            self.out.push('-');
            self.block_item(item, indent);
        }
    }

    /// The rest of a line after `-` (or after `key:` for nested values), with
    /// nested content at `indent + 2`.
    fn block_item(&mut self, item: &Value, indent: usize) {
        match item {
            Value::List(l) if !l.is_empty() => {
                self.out.push_str(self.eol);
                self.block_seq(l, indent + 2);
            }
            Value::Map(m) if !m.is_empty() => {
                // `- k: v` with the following keys aligned under `k`.
                self.out.push(' ');
                let start = self.out.len();
                self.block_map(m, indent + 2);
                // Remove the indentation of the first key: it follows `- `.
                let first_indent = indent + 2;
                self.out.replace_range(start..start + first_indent, "");
            }
            Value::Text(s) if s.contains('\n') && !self.safe && block_scalar_ok(s) => {
                self.out.push(' ');
                self.block_scalar(s, indent + 2, false, "");
            }
            scalar => {
                self.out.push(' ');
                if let Value::List(_) | Value::Map(_) = scalar {
                    // Empty collection.
                    self.flow(scalar);
                } else {
                    let text = self.scalar(scalar, None, false);
                    self.out.push_str(&text);
                }
                self.out.push_str(self.eol);
            }
        }
    }

    /// Block mapping entries at `indent`.
    fn block_map(&mut self, m: &Map, indent: usize) {
        for (k, v) in m.iter() {
            self.out.push_str(&spaces(indent));
            self.out.push_str(&emit_key(k));
            self.out.push(':');
            match v {
                Value::List(l) if !l.is_empty() => {
                    self.out.push_str(self.eol);
                    self.block_seq(l, indent + 2);
                }
                Value::Map(inner) if !inner.is_empty() => {
                    self.out.push_str(self.eol);
                    self.block_map(inner, indent + 2);
                }
                Value::Text(s) if s.contains('\n') && !self.safe && block_scalar_ok(s) => {
                    self.out.push(' ');
                    self.block_scalar(s, indent + 2, false, "");
                }
                other => {
                    self.out.push(' ');
                    if let Value::List(_) | Value::Map(_) = other {
                        self.flow(other);
                    } else {
                        let text = self.scalar(other, None, false);
                        self.out.push_str(&text);
                    }
                    self.out.push_str(self.eol);
                }
            }
        }
    }

    /// A `|` (or `>`) block scalar whose content lines sit at `indent`. The
    /// cursor is after `key: ` or `- `.
    fn block_scalar(&mut self, s: &str, indent: usize, folded: bool, comment: &str) {
        let trailing = s.len() - s.trim_end_matches('\n').len();
        let body = &s[..s.len() - trailing];
        let lines: Vec<&str> = body.split('\n').collect();
        // A folded scalar needs an empty line between two normal lines to keep
        // a single line break; when that does not hold, write a literal.
        let folded = folded && fold_ok(&lines);
        self.out.push(if folded { '>' } else { '|' });
        let first_content = lines.iter().find(|l| !l.is_empty());
        if first_content.is_some_and(|l| l.starts_with(' ')) {
            self.out.push('2');
        }
        match trailing {
            0 => self.out.push('-'),
            1 => {}
            _ => self.out.push('+'),
        }
        self.out.push_str(comment);
        self.out.push_str(self.eol);
        for (i, line) in lines.iter().enumerate() {
            if folded && i > 0 && !line.is_empty() && !lines[i - 1].is_empty() {
                self.out.push_str(self.eol);
            }
            if !line.is_empty() {
                self.out.push_str(&spaces(indent));
                self.out.push_str(line);
            }
            self.out.push_str(self.eol);
        }
        for _ in 1..trailing {
            self.out.push_str(self.eol);
        }
    }
}

/// Whether a folded rendering is simple enough: no line starts with whitespace
/// (no "more-indented" lines) and no empty lines, so every line break is written
/// as one empty line.
fn fold_ok(lines: &[&str]) -> bool {
    lines
        .iter()
        .all(|l| !l.is_empty() && !l.starts_with([' ', '\t']))
}

fn is_scalar(v: &Value) -> bool {
    !matches!(v, Value::List(_) | Value::Map(_))
}

/// Whether a multi-line string can be a block scalar: no characters that block
/// scalars cannot carry, no leading empty line, and not only line breaks.
fn block_scalar_ok(s: &str) -> bool {
    !s.chars().any(|c| {
        (c.is_control() && c != '\n' && c != '\t')
            || matches!(c, '\u{85}' | '\u{2028}' | '\u{2029}' | '\u{feff}')
    }) && !s.starts_with('\n')
        && !s.trim_end_matches('\n').is_empty()
        && !s.split('\n').any(|l| l.starts_with('\t'))
}

/// A float that reads back as a float in YAML 1.2 and 1.1: always with a `.`
/// and, in exponent form, a signed exponent (`1.0e+21`).
fn yaml_float(f: f64) -> String {
    let s = format_float_es(f);
    let (mantissa, exp) = match s.split_once('e') {
        Some((m, e)) => (m.to_owned(), Some(e.to_owned())),
        None => (s.clone(), None),
    };
    let mantissa = if mantissa.contains('.') {
        mantissa
    } else {
        format!("{mantissa}.0")
    };
    match exp {
        Some(e) => format!("{mantissa}e{e}"),
        None => mantissa,
    }
}

/// Whether `s` can be written as a plain scalar that reads back as the string.
pub(crate) fn plain_ok(s: &str, flow: bool) -> bool {
    let Some(first) = s.chars().next() else {
        return false;
    };
    if s.starts_with([' ', '\t']) || s.ends_with([' ', '\t']) {
        return false;
    }
    if s.chars()
        .any(|c| c.is_control() || matches!(c, '\u{85}' | '\u{2028}' | '\u{2029}' | '\u{feff}'))
    {
        return false;
    }
    let second = s.chars().nth(1);
    match first {
        '-' | '?' | ':' => {
            if second.is_none_or(|c| c == ' ' || (flow && ",[]{}".contains(c))) {
                return false;
            }
        }
        ',' | '[' | ']' | '{' | '}' | '#' | '&' | '*' | '!' | '|' | '>' | '\'' | '"' | '%'
        | '@' | '`' => return false,
        _ => {}
    }
    if s.contains(": ") || s.ends_with(':') || s.contains(" #") {
        return false;
    }
    if flow && s.contains([',', '[', ']', '{', '}']) {
        return false;
    }
    if s.starts_with("---") || s.starts_with("...") {
        return false;
    }
    matches!(schema::resolve_plain(s), Value::Text(_))
}

fn single_ok(s: &str) -> bool {
    !s.chars()
        .any(|c| c.is_control() || matches!(c, '\u{85}' | '\u{2028}' | '\u{2029}' | '\u{feff}'))
        && !s.starts_with(' ')
        && !s.ends_with(' ')
}

fn single_quoted(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// A double-quoted scalar with YAML escapes for everything that is not printable.
pub(crate) fn double_quoted(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\0' => out.push_str("\\0"),
            '\u{7}' => out.push_str("\\a"),
            '\u{8}' => out.push_str("\\b"),
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            '\u{b}' => out.push_str("\\v"),
            '\u{c}' => out.push_str("\\f"),
            '\r' => out.push_str("\\r"),
            '\u{1b}' => out.push_str("\\e"),
            '\u{85}' => out.push_str("\\N"),
            '\u{2028}' => out.push_str("\\L"),
            '\u{2029}' => out.push_str("\\P"),
            '\u{feff}' => out.push_str("\\uFEFF"),
            c if c.is_control() => {
                let code = c as u32;
                if code <= 0xff {
                    out.push_str(&format!("\\x{code:02X}"));
                } else {
                    out.push_str(&format!("\\u{code:04X}"));
                }
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}
