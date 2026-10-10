//! Format-preserving frontmatter writes (spec 12A "Writer Format Fidelity").
//!
//! A frontmatter source is a sequence of **top-level entries** and the lines
//! between them. An entry is the line holding a top-level key, every following
//! line that belongs to the key's value, and any indented comment lines directly
//! after the value. Blank lines and comment lines in the mapping's own column
//! between entries belong to no entry.
//!
//! [`write`] applies field changes to a [`Document`]:
//!
//! 1. an entry whose key is not changed stays byte-identical;
//! 2. lines outside entries are kept; removing a key removes its entry's lines;
//! 3. a changed entry is re-emitted in place in the style of its previous value
//!    (flow stays flow, block stays block, quoting and the trailing comment on
//!    the first line are kept where the new value allows);
//! 4. a new key is appended after the last entry;
//! 5. [`Change::Copy`] copies another version's entry text verbatim;
//! 6. the byte-order mark, delimiters, line ending style and (unless replaced)
//!    the body are kept.
//!
//! The result is always verified: the new frontmatter is parsed back and must
//! equal the intended mapping exactly (including the integer/float distinction).
//! When it does not, which can only happen when entries are tied together by
//! YAML anchors and aliases, the affected entries are re-emitted from their
//! values; as a last resort the whole mapping is re-emitted. A write therefore
//! never changes a value it did not mean to change.

use std::collections::BTreeSet;
use std::fmt;
use std::ops::Range;

use crate::doc::{Document, LineEnding, RecordFormat};
use crate::value::{Map, Value};
use crate::yaml::emit::{EntryStyle, emit_entry};
use crate::yaml::parse::{Kind, Node, ScalarStyle};
use crate::yaml::{Parsed, YamlError};

/// A change to one top-level frontmatter key.
#[derive(Debug, Clone, PartialEq)]
pub enum Change {
    /// Set the key to a value, re-emitting its entry in the existing style.
    Set(Value),
    /// Remove the key and its entry's lines.
    Remove,
    /// Replace the entry with another version's entry text, verbatim.
    Copy(EntryCopy),
    /// Set the key to a value; when the document has no entry for the key, the
    /// new entry follows the style of `like` (another version's entry) instead
    /// of the default styles. Used by merges for computed values.
    SetLike {
        /// The value.
        value: Value,
        /// The entry whose style a new entry follows.
        like: EntryCopy,
    },
}

/// The exact source of one entry, taken from a document (see
/// [`entry_copy`]), with the value it parses to.
#[derive(Debug, Clone, PartialEq)]
pub struct EntryCopy {
    text: String,
    indent: usize,
    value: Value,
    style: EntryStyle,
}

impl EntryCopy {
    /// The entry's source lines.
    pub fn text(&self) -> &str {
        &self.text
    }

    /// The value the entry holds.
    pub fn value(&self) -> &Value {
        &self.value
    }
}

/// Why a write could not be planned.
#[derive(Debug, Clone, PartialEq)]
pub enum WriteError {
    /// The frontmatter is invalid or not a mapping; a structured update must
    /// not discard it (spec 03). The string is the `details.reason`.
    InvalidFrontmatter(&'static str),
    /// A non-empty body for a YAML document record (spec 03: `invalid_request`).
    BodyOnYamlDocument,
    /// A value could not be emitted (an internal error; never expected).
    Emit(YamlError),
}

impl fmt::Display for WriteError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            WriteError::InvalidFrontmatter(r) => write!(f, "invalid frontmatter ({r})"),
            WriteError::BodyOnYamlDocument => f.write_str("a YAML document record has no body"),
            WriteError::Emit(e) => write!(f, "cannot emit value: {e}"),
        }
    }
}

impl std::error::Error for WriteError {}

/// The exact text of `key`'s entry in `doc`, for [`Change::Copy`].
pub fn entry_copy(doc: &Document, key: &str) -> Option<EntryCopy> {
    let layout = Layout::of(doc)?;
    let e = layout.entries.iter().find(|e| e.key == key)?;
    Some(EntryCopy {
        text: layout.text_of(e.lines.clone()).to_owned(),
        indent: layout.indent,
        value: doc.frontmatter().get(key)?.clone(),
        style: e.style.clone(),
    })
}

/// Apply `changes` (in order; a later change to the same key wins) and an
/// optional body replacement to `doc`, returning the new source.
pub fn write(
    doc: &Document,
    changes: &[(String, Change)],
    body: Option<&str>,
) -> Result<String, WriteError> {
    if doc.format() == RecordFormat::YamlDocument && body.is_some_and(|b| !b.is_empty()) {
        return Err(WriteError::BodyOnYamlDocument);
    }
    // The last change per key, in first-mention order.
    let mut effective: Vec<(String, Change)> = Vec::new();
    for (k, c) in changes {
        match effective.iter_mut().find(|(ek, _)| ek == k) {
            Some(slot) => slot.1 = c.clone(),
            None => effective.push((k.clone(), c.clone())),
        }
    }
    let old = doc.frontmatter();
    let layout = Layout::of(doc);
    effective.retain(|(k, c)| match c {
        Change::Set(v) | Change::SetLike { value: v, .. } => {
            old.get(k).is_none_or(|cur| !strict_eq(cur, v))
        }
        Change::Remove => old.contains_key(k),
        Change::Copy(copy) => {
            let current = layout.as_ref().and_then(|l| {
                l.entries
                    .iter()
                    .find(|e| &e.key == k)
                    .map(|e| l.text_of(e.lines.clone()))
            });
            current != Some(copy.text.as_str())
                || !old.get(k).is_some_and(|v| strict_eq(v, &copy.value))
        }
    });
    if effective.is_empty() && body.is_none() {
        return Ok(doc.source().to_owned());
    }
    if !effective.is_empty()
        && let Some(p) = doc.problem()
    {
        return Err(WriteError::InvalidFrontmatter(p.reason()));
    }
    let eol = doc.line_ending();
    let body_text = body.unwrap_or_else(|| doc.body());
    if effective.is_empty() {
        let mut out = String::with_capacity(doc.source().len());
        out.push_str(doc.prefix());
        if let Some(y) = doc.frontmatter_source() {
            out.push_str(y);
        }
        out.push_str(doc.delimiter_after_yaml());
        out.push_str(body_text);
        return Ok(out);
    }

    // The mapping the frontmatter must parse to afterwards.
    let mut expected = old.clone();
    for (k, c) in &effective {
        match c {
            Change::Set(v) | Change::SetLike { value: v, .. } => {
                expected.insert(k.clone(), v.clone());
            }
            Change::Copy(copy) => {
                expected.insert(k.clone(), copy.value.clone());
            }
            Change::Remove => {
                expected.remove(k);
            }
        }
    }

    let yaml = match &layout {
        Some(l) => patch_with_fallbacks(l, &effective, &expected, eol)?,
        None => reemit_all(&expected, eol)?,
    };

    let mut out = String::with_capacity(doc.source().len() + 64);
    if doc.has_frontmatter() {
        out.push_str(doc.prefix());
        out.push_str(&yaml);
        out.push_str(doc.delimiter_after_yaml());
    } else {
        // A Markdown record without frontmatter gains a block.
        out.push_str(doc.prefix());
        out.push_str("---");
        out.push_str(eol.as_str());
        out.push_str(&yaml);
        out.push_str("---");
        out.push_str(eol.as_str());
    }
    out.push_str(body_text);
    Ok(out)
}

/// Render a new document from a mapping and a body (create). Keys are written
/// in the map's order with the default styles.
pub fn render_new(
    frontmatter: &Map,
    body: &str,
    format: RecordFormat,
    eol: LineEnding,
) -> Result<String, WriteError> {
    if format == RecordFormat::YamlDocument && !body.is_empty() {
        return Err(WriteError::BodyOnYamlDocument);
    }
    let yaml = reemit_all(frontmatter, eol)?;
    Ok(match format {
        RecordFormat::YamlDocument => yaml,
        RecordFormat::Markdown if frontmatter.is_empty() => body.to_owned(),
        RecordFormat::Markdown => format!("---{e}{yaml}---{e}{body}", e = eol.as_str()),
    })
}

/// Spec equality plus the integer/float distinction: a write that changes `1`
/// to `1.0` changes the file.
pub(crate) fn strict_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Int(x), Value::Int(y)) => x == y,
        (Value::Float(x), Value::Float(y)) => x == y,
        (Value::List(x), Value::List(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| strict_eq(p, q))
        }
        (Value::Map(x), Value::Map(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(k, v)| y.get(k).is_some_and(|w| strict_eq(v, w)))
        }
        (Value::Int(_) | Value::Float(_), _) | (_, Value::Int(_) | Value::Float(_)) => false,
        (x, y) => x == y,
    }
}

fn strict_map_eq(a: &Map, b: &Map) -> bool {
    a.len() == b.len()
        && a.iter()
            .all(|(k, v)| b.get(k).is_some_and(|w| strict_eq(v, w)))
}

/// Patch entry by entry, verify, and widen the set of re-emitted entries until
/// the result parses back to `expected`.
fn patch_with_fallbacks(
    layout: &Layout,
    changes: &[(String, Change)],
    expected: &Map,
    eol: LineEnding,
) -> Result<String, WriteError> {
    let mut changes: Vec<(String, Change)> = changes.to_vec();
    for _round in 0..3 {
        let text = layout.patch(&changes, eol)?;
        let forced: BTreeSet<String> = match Parsed::new(&text) {
            Ok(p) => {
                let got = match p.value {
                    Some(Value::Map(m)) => m,
                    None => Map::new(),
                    Some(_) => Map::new(),
                };
                if strict_map_eq(&got, expected) {
                    return Ok(text);
                }
                expected
                    .iter()
                    .filter(|(k, v)| !got.get(k).is_some_and(|g| strict_eq(g, v)))
                    .map(|(k, _)| k.to_owned())
                    .collect()
            }
            // Typically an alias whose anchor was in a re-emitted entry.
            Err(_) => layout
                .entries
                .iter()
                .filter(|e| e.has_alias || e.has_anchor)
                .map(|e| e.key.clone())
                .collect(),
        };
        let mut grew = false;
        for key in forced {
            let Some(v) = expected.get(&key) else {
                continue;
            };
            match changes.iter_mut().find(|(k, _)| *k == key) {
                Some(slot) if slot.1 != Change::Set(v.clone()) => {
                    slot.1 = Change::Set(v.clone());
                    grew = true;
                }
                Some(_) => {}
                None => {
                    changes.push((key, Change::Set(v.clone())));
                    grew = true;
                }
            }
        }
        if !grew {
            break;
        }
    }
    reemit_all(expected, eol)
}

/// Emit every entry of `map` with default styles.
fn reemit_all(map: &Map, eol: LineEnding) -> Result<String, WriteError> {
    let mut out = String::new();
    for (k, v) in map.iter() {
        out.push_str(
            &emit_entry(k, None, v, &EntryStyle::default(), 0, eol.as_str())
                .map_err(WriteError::Emit)?,
        );
    }
    Ok(out)
}

/// The entry layout of a block-mapping frontmatter.
pub(crate) struct Layout {
    /// The YAML text.
    text: String,
    /// Byte range of each line, including its line ending.
    lines: Vec<Range<usize>>,
    entries: Vec<EntryLayout>,
    /// The column of the mapping's keys.
    indent: usize,
}

pub(crate) struct EntryLayout {
    pub key: String,
    key_src: String,
    /// Line indices (inclusive start, exclusive end).
    pub lines: Range<usize>,
    style: EntryStyle,
    has_alias: bool,
    has_anchor: bool,
}

impl Layout {
    /// The layout of `doc`'s frontmatter, or `None` when it is not a block
    /// mapping (a top-level flow mapping) or cannot be read.
    pub(crate) fn of(doc: &Document) -> Option<Layout> {
        let text = doc.frontmatter_source().unwrap_or("").to_owned();
        let lines = line_ranges(&text);
        let root = match doc.parsed() {
            Some(p) => p.root.as_ref(),
            None if !doc.has_frontmatter() => None,
            None => return None,
        };
        let pairs = match root {
            None => {
                return Some(Layout {
                    text,
                    lines,
                    entries: Vec::new(),
                    indent: 0,
                });
            }
            Some(Node {
                kind: Kind::Map { flow: false, pairs },
                ..
            }) => pairs,
            Some(_) => return None,
        };
        let line_of = |pos: usize| -> usize {
            lines
                .partition_point(|r| r.end <= pos)
                .min(lines.len().saturating_sub(1))
        };
        let indent = pairs.first().map_or(0, |(k, _)| {
            k.span.start - lines[line_of(k.span.start)].start
        });
        let mut entries = Vec::with_capacity(pairs.len());
        let starts: Vec<usize> = pairs.iter().map(|(k, _)| line_of(k.span.start)).collect();
        for (i, (k, v)) in pairs.iter().enumerate() {
            let start = starts[i];
            let colon = colon_after(&text, k.span.end);
            let value_end = v.span.end.max(colon + 1);
            let mut last = line_of(value_end - 1);
            let limit = starts.get(i + 1).copied().unwrap_or(lines.len());
            // Extend over indented comment lines (and blank lines between them).
            let mut j = last + 1;
            while j < limit {
                let l = &text[lines[j].clone()];
                let t = l.trim_start_matches([' ', '\t']);
                if t.trim_end_matches(['\n', '\r']).is_empty() {
                    j += 1;
                    continue;
                }
                if t.starts_with('#') && l.len() != t.len() {
                    last = j;
                    j += 1;
                    continue;
                }
                break;
            }
            let key = match &k.kind {
                Kind::Scalar { text, .. } => text.clone(),
                _ => return None,
            };
            let style = entry_style(&text, &lines, start, k, v, colon, indent, &line_of);
            entries.push(EntryLayout {
                key,
                key_src: text[k.span.start..k.span.end].to_owned(),
                lines: start..last + 1,
                style,
                has_alias: subtree_any(v, &|n| matches!(n.kind, Kind::Alias(_))),
                has_anchor: subtree_any(v, &|n| n.anchor.is_some()),
            });
        }
        Some(Layout {
            text,
            lines,
            entries,
            indent,
        })
    }

    fn text_of(&self, lines: Range<usize>) -> &str {
        if lines.is_empty() {
            return "";
        }
        &self.text[self.lines[lines.start].start..self.lines[lines.end - 1].end]
    }

    /// Apply `changes` entry by entry (no verification).
    fn patch(&self, changes: &[(String, Change)], eol: LineEnding) -> Result<String, WriteError> {
        let eol_s = eol.as_str();
        let change_of = |key: &str| changes.iter().find(|(k, _)| k == key).map(|(_, c)| c);
        let mut new_keys: Vec<(&str, &Change)> = changes
            .iter()
            .filter(|(k, c)| {
                !matches!(c, Change::Remove) && !self.entries.iter().any(|e| &e.key == k)
            })
            .map(|(k, c)| (k.as_str(), c))
            .collect();
        let mut out = String::with_capacity(self.text.len() + 64);
        let append_new =
            |out: &mut String, new_keys: &mut Vec<(&str, &Change)>| -> Result<(), WriteError> {
                if new_keys.is_empty() {
                    return Ok(());
                }
                if !out.is_empty() && !out.ends_with('\n') {
                    out.push_str(eol_s);
                }
                for (k, c) in new_keys.drain(..) {
                    match c {
                        Change::Set(v) => out.push_str(
                            &emit_entry(k, None, v, &EntryStyle::default(), self.indent, eol_s)
                                .map_err(WriteError::Emit)?,
                        ),
                        Change::SetLike { value, like } => {
                            let style = if like.indent == self.indent {
                                like.style.clone()
                            } else {
                                EntryStyle::default()
                            };
                            out.push_str(
                                &emit_entry(k, None, value, &style, self.indent, eol_s)
                                    .map_err(WriteError::Emit)?,
                            );
                        }
                        Change::Copy(copy) => out.push_str(&self.copied(k, copy, eol)?),
                        Change::Remove => {}
                    }
                }
                Ok(())
            };
        if self.entries.is_empty() {
            append_new(&mut out, &mut new_keys)?;
        }
        let last_entry = self.entries.len().checked_sub(1);
        let mut line = 0;
        while line < self.lines.len() {
            let Some((ei, e)) = self
                .entries
                .iter()
                .enumerate()
                .find(|(_, e)| e.lines.start == line)
            else {
                out.push_str(&self.text[self.lines[line].clone()]);
                line += 1;
                continue;
            };
            match change_of(&e.key) {
                None => out.push_str(self.text_of(e.lines.clone())),
                Some(Change::Remove) => {}
                Some(Change::Set(v) | Change::SetLike { value: v, .. }) => {
                    let emitted =
                        emit_entry(&e.key, Some(&e.key_src), v, &e.style, self.indent, eol_s)
                            .map_err(WriteError::Emit)?;
                    out.push_str(&emitted);
                }
                Some(Change::Copy(copy)) => out.push_str(&self.copied(&e.key, copy, eol)?),
            }
            line = e.lines.end;
            if Some(ei) == last_entry {
                append_new(&mut out, &mut new_keys)?;
            }
        }
        Ok(out)
    }

    /// A copied entry, with its line endings converted to `eol`. An entry from a
    /// mapping at a different indentation is re-emitted from its value instead.
    fn copied(&self, key: &str, copy: &EntryCopy, eol: LineEnding) -> Result<String, WriteError> {
        if copy.indent != self.indent {
            return emit_entry(
                key,
                None,
                &copy.value,
                &EntryStyle::default(),
                self.indent,
                eol.as_str(),
            )
            .map_err(WriteError::Emit);
        }
        let mut t = copy.text.replace("\r\n", "\n");
        if eol == LineEnding::CrLf {
            t = t.replace('\n', "\r\n");
        }
        if !t.ends_with('\n') {
            t.push_str(eol.as_str());
        }
        Ok(t)
    }
}

/// Byte ranges of the lines of `text`, each including its `\n`.
fn line_ranges(text: &str) -> Vec<Range<usize>> {
    let mut out = Vec::new();
    let mut start = 0;
    for (i, b) in text.bytes().enumerate() {
        if b == b'\n' {
            out.push(start..i + 1);
            start = i + 1;
        }
    }
    if start < text.len() {
        out.push(start..text.len());
    }
    out
}

/// The position of the `:` after a block mapping key ending at `key_end`.
fn colon_after(text: &str, key_end: usize) -> usize {
    let b = text.as_bytes();
    let mut i = key_end;
    while i < b.len() && (b[i] == b' ' || b[i] == b'\t') {
        i += 1;
    }
    i
}

fn subtree_any(n: &Node, pred: &dyn Fn(&Node) -> bool) -> bool {
    if pred(n) {
        return true;
    }
    match &n.kind {
        Kind::Seq { items, .. } => items.iter().any(|i| subtree_any(i, pred)),
        Kind::Map { pairs, .. } => pairs
            .iter()
            .any(|(k, v)| subtree_any(k, pred) || subtree_any(v, pred)),
        _ => false,
    }
}

/// The style of an entry's value, for re-emission.
#[allow(clippy::too_many_arguments)]
fn entry_style(
    text: &str,
    lines: &[Range<usize>],
    key_line: usize,
    _key: &Node,
    v: &Node,
    colon: usize,
    indent: usize,
    line_of: &dyn Fn(usize) -> usize,
) -> EntryStyle {
    let mut style = EntryStyle::default();
    let line = lines[key_line].clone();
    let line_end = line.end - text[line.clone()].len()
        + text[line.clone()].trim_end_matches(['\n', '\r']).len();
    let empty = v.span.start == v.span.end && v.anchor.is_none() && v.tag.is_none();
    let starts_on_key_line = !empty && v.span.start < line_end;
    let ends_on_key_line = !empty && v.span.end <= line_end;
    match &v.kind {
        Kind::Seq { flow, .. } => {
            style.flow = Some(*flow);
            if !flow {
                style.seq_indent =
                    Some(column(lines, line_of, v.span.start).saturating_sub(indent));
            }
        }
        Kind::Map { flow, pairs } => {
            style.flow = Some(*flow);
            if !flow && let Some((k, _)) = pairs.first() {
                style.map_indent =
                    Some(column(lines, line_of, k.span.start).saturating_sub(indent));
            }
        }
        Kind::Scalar { style: s, .. } if !empty => style.scalar = Some(*s),
        _ => {}
    }
    if starts_on_key_line {
        style.gap = Some(text[colon + 1..v.span.start].to_owned());
    }
    // Where a trailing comment on the key line may start.
    let search_from = if !starts_on_key_line {
        Some(colon + 1)
    } else if ends_on_key_line {
        Some(v.span.end)
    } else if let Kind::Scalar {
        style: ScalarStyle::Literal | ScalarStyle::Folded,
        ..
    } = &v.kind
    {
        // After the block scalar header indicators.
        let b = text.as_bytes();
        let mut i = v.span.start;
        while i < line_end && b[i] != b'|' && b[i] != b'>' {
            i += 1;
        }
        i += 1;
        while i < line_end && matches!(b[i], b'+' | b'-' | b'1'..=b'9') {
            i += 1;
        }
        Some(i)
    } else {
        None
    };
    if let Some(from) = search_from.filter(|&f| f <= line_end) {
        let rest = &text[from..line_end];
        let trimmed = rest.trim_start_matches([' ', '\t']);
        if trimmed.starts_with('#') && trimmed.len() < rest.len() {
            style.comment = Some(rest.to_owned());
        }
    }
    style
}

fn column(lines: &[Range<usize>], line_of: &dyn Fn(usize) -> usize, pos: usize) -> usize {
    pos - lines[line_of(pos)].start
}
