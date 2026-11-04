//! Reversible path patterns. Matching is anchored and shortest-first by code point.
use std::collections::{BTreeMap, BTreeSet};
use std::ops::Range;

use super::PathPatternError as Error;
use crate::value::{Map, Value};

#[derive(Debug, Clone, PartialEq, Eq)]
enum Part {
    Literal(String),
    Field(String, Option<String>),
}

/// A checked pattern and the fields whose persisted representation is its path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathPolicy {
    parts: Vec<Part>,
    /// Stored top-level keys, in declaration order.
    pub fields: Vec<String>,
}

/// A decoded path, retaining placeholder spans for surgical updates.
#[derive(Debug, Default)]
pub struct Decoded {
    /// Persisted string values (never read defaults).
    pub values: Map,
    /// Fields with contradictory or incomplete date/value occurrences.
    pub inconsistent: BTreeSet<String>,
    spans: Vec<(usize, Range<usize>)>,
}

impl PathPolicy {
    /// Parse a pattern. Schema constraints on placeholders are checked by the catalog.
    pub fn new(pattern: &str, fields: Vec<String>) -> Result<Self, Error> {
        let mut parts = Vec::new();
        let mut rest = pattern;
        while let Some(open) = rest.find('{') {
            if rest[..open].contains('}') {
                return Err(Error::MalformedPattern);
            }
            if open > 0 {
                parts.push(Part::Literal(rest[..open].into()));
            }
            let close = rest[open + 1..]
                .find('}')
                .map(|i| i + open + 1)
                .ok_or(Error::MalformedPattern)?;
            let placeholder = &rest[open + 1..close];
            let (field, format) = placeholder
                .split_once(':')
                .map_or((placeholder, None), |(f, v)| (f, Some(v.to_owned())));
            if field.is_empty()
                || field.contains(['{', '/', '\\'])
                || format
                    .as_ref()
                    .is_some_and(|f| f.is_empty() || f.contains(['{', '}', '/', '\\']))
            {
                return Err(Error::MalformedPattern);
            }
            if let Some(f) = &format {
                format_parts(f)?;
            }
            parts.push(Part::Field(field.into(), format));
            rest = &rest[close + 1..];
        }
        if rest.contains('}') {
            return Err(Error::MalformedPattern);
        }
        if !rest.is_empty() {
            parts.push(Part::Literal(rest.into()));
        }
        let policy = Self { parts, fields };
        for field in &policy.fields {
            if !policy
                .parts
                .iter()
                .any(|p| matches!(p, Part::Field(f, _) if f == field))
            {
                return Err(Error::MalformedPattern);
            }
        }
        // A stored date is written either plain or formatted, and its formatted
        // occurrences together must name every component (spec 07).
        for field in &policy.fields {
            let formats: Vec<Option<&str>> = policy
                .parts
                .iter()
                .filter_map(|p| match p {
                    Part::Field(f, format) if f == field => Some(format.as_deref()),
                    _ => None,
                })
                .collect();
            if formats.iter().any(Option::is_none) {
                if formats.iter().any(Option::is_some) {
                    return Err(Error::MalformedPattern);
                }
                continue;
            }
            let mut seen = [false; 3];
            for format in formats.into_iter().flatten() {
                for p in format_parts(format)? {
                    if let FormatPart::Token(i) = p {
                        seen[i] = true;
                    }
                }
            }
            if seen != [true; 3] {
                return Err(Error::MalformedPattern);
            }
        }
        if policy.parts.windows(2).any(|p| matches!((&p[0], &p[1]), (Part::Field(a, _), Part::Field(b, _)) if policy.fields.contains(a) || policy.fields.contains(b))) {
            return Err(Error::MalformedPattern);
        }
        Ok(policy)
    }

    /// Formatted placeholders and their field names, for schema checking.
    pub fn formatted_fields(&self) -> impl Iterator<Item = &str> {
        self.parts.iter().filter_map(|p| match p {
            Part::Field(f, Some(_)) => Some(f.as_str()),
            _ => None,
        })
    }

    /// Normalize stored values before any write. Formatted dates are validated, not sanitized.
    pub fn normalize(&self, values: &mut Map) -> Result<(), Error> {
        for field in &self.fields {
            let Some(value) = values.get(field).filter(|v| !v.is_null()) else {
                return Err(Error::Missing {
                    field: field.clone(),
                });
            };
            let Some(text) = value.as_str() else {
                return Err(Error::Invalid {
                    field: field.clone(),
                });
            };
            let text = if self.formatted_fields().any(|f| f == field) {
                date(text).ok_or_else(|| Error::Invalid {
                    field: field.clone(),
                })?;
                text.to_owned()
            } else {
                normalize(text).ok_or_else(|| Error::Invalid {
                    field: field.clone(),
                })?
            };
            values.insert(field, Value::string(text));
        }
        Ok(())
    }

    fn encode(field: &str, format: Option<&str>, values: &Map) -> Result<String, Error> {
        let value = values
            .get(field)
            .filter(|v| !v.is_null())
            .ok_or_else(|| Error::Missing {
                field: field.into(),
            })?;
        let text = match value {
            Value::Text(s) => s.clone(),
            Value::Int(i) => i.to_string(),
            Value::Float(f) => crate::value::format_float_es(*f),
            Value::Bool(b) => b.to_string(),
            _ => {
                return Err(Error::Invalid {
                    field: field.into(),
                });
            }
        };
        if let Some(format) = format {
            let d = date(&text).ok_or_else(|| Error::Invalid {
                field: field.into(),
            })?;
            return Ok(format_parts(format)?
                .iter()
                .map(|p| match p {
                    FormatPart::Token(i) => {
                        format!("{:0width$}", d[*i], width = if *i == 0 { 4 } else { 2 })
                    }
                    FormatPart::Literal(c) => c.to_string(),
                })
                .collect());
        }
        if text.is_empty() || text.starts_with('.') || text.contains(['/', '\\', '\0']) {
            return Err(Error::Invalid {
                field: field.into(),
            });
        }
        Ok(text)
    }

    /// Derive the whole path, including non-stored placeholders.
    pub fn derive(&self, values: &Map) -> Result<String, Error> {
        let mut out = String::new();
        for part in &self.parts {
            match part {
                Part::Literal(s) => out.push_str(s),
                Part::Field(f, fmt) => out.push_str(&Self::encode(f, fmt.as_deref(), values)?),
            }
        }
        self.check_written_values(&out, values)?;
        Ok(out)
    }

    /// Decode the whole path, or `None` if its shape does not match.
    pub fn decode(&self, path: &str) -> Option<Decoded> {
        // Dynamic programming avoids exponential backtracking on ambiguous patterns.
        let mut viable: Vec<BTreeMap<usize, usize>> = vec![BTreeMap::new(); self.parts.len() + 1];
        viable[self.parts.len()].insert(path.len(), path.len());
        let boundaries: Vec<usize> = path
            .char_indices()
            .map(|(i, _)| i)
            .chain(std::iter::once(path.len()))
            .collect();
        for i in (0..self.parts.len()).rev() {
            for &start in &boundaries {
                let end = match &self.parts[i] {
                    Part::Literal(s) => path[start..]
                        .starts_with(s)
                        .then_some(start + s.len())
                        .filter(|e| viable[i + 1].contains_key(e)),
                    Part::Field(_, fmt) => boundaries
                        .iter()
                        .copied()
                        .filter(|&e| e > start)
                        .take_while(|&e| !path[start..e].contains('/'))
                        .find(|e| {
                            viable[i + 1].contains_key(e)
                                && fmt
                                    .as_ref()
                                    .is_none_or(|f| parse_formatted(f, &path[start..*e]).is_some())
                        }),
                };
                if let Some(end) = end {
                    viable[i].insert(start, end);
                }
            }
        }
        if !viable[0].contains_key(&0) {
            return None;
        }
        let mut out = Decoded::default();
        let mut dates: BTreeMap<String, [Option<u32>; 3]> = BTreeMap::new();
        let mut start = 0;
        for (i, part) in self.parts.iter().enumerate() {
            let end = viable[i][&start];
            if let Part::Field(field, fmt) = part
                && self.fields.contains(field)
            {
                out.spans.push((i, start..end));
                if let Some(fmt) = fmt {
                    let Some(components) = parse_formatted(fmt, &path[start..end]) else {
                        out.inconsistent.insert(field.clone());
                        start = end;
                        continue;
                    };
                    let d = dates.entry(field.clone()).or_insert([None; 3]);
                    for j in 0..3 {
                        if let Some(v) = components[j] {
                            if d[j].is_some_and(|old| old != v) {
                                out.inconsistent.insert(field.clone());
                            }
                            d[j] = Some(v);
                        }
                    }
                } else {
                    let v = Value::string(&path[start..end]);
                    if out.values.get(field).is_some_and(|old| old != &v) {
                        out.inconsistent.insert(field.clone());
                    }
                    out.values.insert(field, v);
                }
            }
            start = end;
        }
        for (field, d) in dates {
            if let [Some(y), Some(m), Some(day)] = d {
                let text = format!("{y:04}-{m:02}-{day:02}");
                let v = Value::string(&text);
                if date(&text).is_none() {
                    out.inconsistent.insert(field.clone());
                }
                out.values.insert(field, v);
            } else {
                out.inconsistent.insert(field);
            }
        }
        for field in &out.inconsistent {
            out.values.remove(field);
        }
        Some(out)
    }

    /// Verify that an engine assignment survives shortest-first decoding.
    pub fn check_written_values(&self, path: &str, values: &Map) -> Result<(), Error> {
        if self.fields.is_empty() {
            return Ok(());
        }
        let decoded = self.decode(path);
        for field in &self.fields {
            if let Some(value) = values.get(field) {
                let invalid_segment = decoded.as_ref().is_some_and(|d| {
                    d.spans.iter().any(|(i, span)| {
                        if !matches!(&self.parts[*i], Part::Field(f, _) if f == field) {
                            return false;
                        }
                        let start = path[..span.start].rfind('/').map_or(0, |i| i + 1);
                        let end = path[span.end..]
                            .find('/')
                            .map_or(path.len(), |i| span.end + i);
                        super::check_path(&path[start..end]).is_err()
                    })
                });
                if decoded.as_ref().and_then(|d| d.values.get(field)) != Some(value)
                    || invalid_segment
                {
                    return Err(Error::Invalid {
                        field: field.clone(),
                    });
                }
            }
        }
        // Also enforce whole-path limits and safety of non-stored components.
        if super::check_path(path).is_err()
            && let Some(field) = self.fields.iter().find(|f| values.contains_key(f))
        {
            return Err(Error::Invalid {
                field: field.clone(),
            });
        }
        Ok(())
    }

    /// Replace only changed stored spans, preserving all other path text.
    pub fn update_path(&self, path: &str, values: &Map) -> Result<String, Error> {
        let decoded = self.decode(path);
        let changed: Map = self
            .fields
            .iter()
            .filter_map(|f| {
                values
                    .get(f)
                    .filter(|v| decoded.as_ref().and_then(|d| d.values.get(f)) != Some(*v))
                    .map(|v| (f.clone(), v.clone()))
            })
            .collect();
        if changed.is_empty() {
            return Ok(path.to_owned());
        }
        let Some(decoded) = decoded else {
            let out = self.derive(values)?;
            self.check_written_values(&out, &changed)?;
            return Ok(out);
        };
        let mut out = String::new();
        let mut start = 0;
        for (i, span) in decoded.spans {
            out.push_str(&path[start..span.start]);
            if let Part::Field(f, fmt) = &self.parts[i] {
                if changed.contains_key(f) {
                    out.push_str(&Self::encode(f, fmt.as_deref(), values)?);
                } else {
                    out.push_str(&path[span.clone()]);
                }
            }
            start = span.end;
        }
        out.push_str(&path[start..]);
        self.check_written_values(&out, &changed)?;
        Ok(out)
    }
}

#[derive(Debug)]
enum FormatPart {
    Token(usize),
    Literal(char),
}
fn format_parts(format: &str) -> Result<Vec<FormatPart>, Error> {
    let mut rest = format;
    let mut out = Vec::new();
    while !rest.is_empty() {
        if let Some((token, i)) = [("YYYY", 0), ("MM", 1), ("DD", 2)]
            .into_iter()
            .find(|(t, _)| rest.starts_with(t))
        {
            out.push(FormatPart::Token(i));
            rest = &rest[token.len()..];
        } else {
            let c = rest.chars().next().ok_or(Error::MalformedPattern)?;
            if matches!(c, '{' | '}' | '/' | '\\') {
                return Err(Error::MalformedPattern);
            }
            out.push(FormatPart::Literal(c));
            rest = &rest[c.len_utf8()..];
        }
    }
    if !out.iter().any(|p| matches!(p, FormatPart::Token(_))) {
        return Err(Error::MalformedPattern);
    }
    Ok(out)
}
fn parse_formatted(format: &str, text: &str) -> Option<[Option<u32>; 3]> {
    let mut rest = text;
    let mut d = [None; 3];
    for p in format_parts(format).ok()? {
        match p {
            FormatPart::Token(i) => {
                let n = if i == 0 { 4 } else { 2 };
                let digits = rest.get(..n)?;
                if !digits.bytes().all(|b| b.is_ascii_digit()) {
                    return None;
                }
                let v = digits.parse().ok()?;
                // Contradictory components in one occurrence must still shape-match.
                if d[i].is_some_and(|old| old != v) {
                    d[i] = Some(u32::MAX);
                } else {
                    d[i] = Some(v);
                }
                rest = &rest[n..];
            }
            FormatPart::Literal(c) => {
                rest = rest.strip_prefix(c)?;
            }
        }
    }
    rest.is_empty().then_some(d)
}
fn date(text: &str) -> Option<[u32; 3]> {
    let [Some(y), Some(m), Some(d)] = parse_formatted("YYYY-MM-DD", text)? else {
        return None;
    };
    let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    let max = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return None,
    };
    (y <= 9999 && d > 0 && d <= max).then_some([y, m, d])
}
/// Fixed filename-value sanitization; never supplies a fallback value.
pub fn normalize(text: &str) -> Option<String> {
    // Spec 07 "Writing": spaces, removals, collapse, trim — idempotent.
    let removed: String = text
        .chars()
        .map(|c| if c.is_whitespace() { ' ' } else { c })
        .filter(|c| !"<>:\"/\\|?*#[]^".contains(*c) && !c.is_control() && !super::is_ignorable(*c))
        .collect();
    let collapsed = removed
        .split(' ')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let cleaned = collapsed.trim_matches(['.', ' ']);
    (!cleaned.is_empty()).then(|| cleaned.to_owned())
}
