//! The frontmatter data model: JSON values with an insertion-ordered map.
//!
//! Frontmatter parses into [`Value`] (spec 03: the JSON data model). Key order is
//! semantic for writers (spec 12A format fidelity keeps entries in place), so
//! [`Map`] keeps insertion order and indexes keys in a `BTreeMap`; nothing here
//! iterates a hash container.
//!
//! **Equality** is spec 12A equality: deep JSON equality where numbers are equal
//! when their numeric values are equal (`1 == 1.0`), strings compare exactly,
//! there is no coercion between types, and maps compare as key sets (order does
//! not matter). A missing key is not a [`Value`] at all; callers model it with
//! `Option<&Value>`, so missing is never equal to null.
//!
//! **Numbers** are `i64` or a finite `f64`. Integer and float comparison is exact
//! (no lossy casts), and [`Number::to_json`] renders floats the way RFC 8785
//! (ECMAScript `Number.prototype.toString`) does, so the text is the same on every
//! platform.

use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::fmt::Write as _;

/// A JSON number: an `i64`, or a finite `f64`.
#[derive(Debug, Clone, Copy)]
pub enum Number {
    /// An integer that fits in `i64`.
    Int(i64),
    /// A finite float. Construct with [`Number::float`], which rejects NaN and
    /// infinities (they are outside the JSON data model).
    Float(f64),
}

impl Number {
    /// A float number, or `None` when `f` is NaN or infinite.
    pub fn float(f: f64) -> Option<Number> {
        f.is_finite().then_some(Number::Float(f))
    }

    /// The value as `f64` (lossy for integers beyond 2^53).
    pub fn as_f64(self) -> f64 {
        match self {
            // Lossy by design: documented on the method.
            #[allow(clippy::cast_precision_loss)]
            Number::Int(i) => i as f64,
            Number::Float(f) => f,
        }
    }

    /// The value as `i64` when it is an integer or an integral float in range.
    pub fn as_i64(self) -> Option<i64> {
        match self {
            Number::Int(i) => Some(i),
            Number::Float(f) => {
                if f.fract() == 0.0 && (-TWO_POW_63..TWO_POW_63).contains(&f) {
                    // In range and integral: the cast is exact.
                    #[allow(clippy::cast_possible_truncation)]
                    Some(f as i64)
                } else {
                    None
                }
            }
        }
    }

    /// Exact numeric comparison (`Int(1) == Float(1.0)`, `-0.0 == 0.0`).
    pub fn cmp_numeric(self, other: Number) -> Ordering {
        match (self, other) {
            (Number::Int(a), Number::Int(b)) => a.cmp(&b),
            (Number::Float(a), Number::Float(b)) => a.partial_cmp(&b).unwrap_or(Ordering::Equal),
            (Number::Int(a), Number::Float(b)) => cmp_int_float(a, b),
            (Number::Float(a), Number::Int(b)) => cmp_int_float(b, a).reverse(),
        }
    }

    /// The canonical JSON text: integers in decimal, floats as RFC 8785 /
    /// ECMAScript `Number.prototype.toString` (`42.0` → `42`, `1e21` → `1e+21`).
    pub fn to_json(self) -> String {
        match self {
            Number::Int(i) => i.to_string(),
            Number::Float(f) => format_float_es(f),
        }
    }
}

impl PartialEq for Number {
    fn eq(&self, other: &Self) -> bool {
        self.cmp_numeric(*other) == Ordering::Equal
    }
}

const TWO_POW_63: f64 = 9_223_372_036_854_775_808.0;

/// Compare an integer with a finite float exactly.
fn cmp_int_float(i: i64, f: f64) -> Ordering {
    if f >= TWO_POW_63 {
        return Ordering::Less;
    }
    if f < -TWO_POW_63 {
        return Ordering::Greater;
    }
    let t = f.trunc();
    // |t| < 2^63, so the cast is exact.
    #[allow(clippy::cast_possible_truncation)]
    let ti = t as i64;
    match i.cmp(&ti) {
        Ordering::Equal => {
            let frac = f - t;
            if frac > 0.0 {
                Ordering::Less
            } else if frac < 0.0 {
                Ordering::Greater
            } else {
                Ordering::Equal
            }
        }
        o => o,
    }
}

/// Shortest round-trip digits of a finite, non-zero `|f|`: `(digits, n)` with
/// `|f| = 0.d1d2... × 10^n`.
fn shortest_digits(f: f64) -> (String, i32) {
    // `{:e}` prints the shortest digits that round-trip, e.g. "1.2345e-7".
    let s = format!("{:e}", f.abs());
    let (mantissa, exp) = s.split_once('e').unwrap_or((s.as_str(), "0"));
    let exp: i32 = exp.parse().unwrap_or(0);
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let digits = digits.trim_end_matches('0');
    let digits = if digits.is_empty() { "0" } else { digits };
    (digits.to_owned(), exp + 1)
}

/// ECMAScript `Number.prototype.toString` for a finite float (RFC 8785 §3.2.2.3).
pub(crate) fn format_float_es(f: f64) -> String {
    if f == 0.0 {
        return "0".to_owned();
    }
    let (digits, n) = shortest_digits(f);
    let k = i32::try_from(digits.len()).unwrap_or(i32::MAX);
    let mut out = String::new();
    if f < 0.0 {
        out.push('-');
    }
    if k <= n && n <= 21 {
        out.push_str(&digits);
        for _ in 0..(n - k) {
            out.push('0');
        }
    } else if 0 < n && n <= 21 {
        let (a, b) = digits.split_at(usize::try_from(n).unwrap_or(0));
        out.push_str(a);
        out.push('.');
        out.push_str(b);
    } else if -6 < n && n <= 0 {
        out.push_str("0.");
        for _ in 0..(-n) {
            out.push('0');
        }
        out.push_str(&digits);
    } else {
        let (a, b) = digits.split_at(1);
        out.push_str(a);
        if !b.is_empty() {
            out.push('.');
            out.push_str(b);
        }
        let e = n - 1;
        let _ = write!(out, "e{}{}", if e < 0 { '-' } else { '+' }, e.abs());
    }
    out
}

/// A frontmatter value (the JSON data model).
#[derive(Debug, Clone)]
pub enum Value {
    /// YAML/JSON null.
    Null,
    /// A boolean.
    Bool(bool),
    /// A 64-bit signed integer.
    Int(i64),
    /// A finite float. Construct through [`Value::float`] or [`Number::float`];
    /// NaN and infinities are outside the data model.
    Float(f64),
    /// Text.
    Text(String),
    /// A list.
    List(Vec<Value>),
    /// A mapping with string keys, in insertion order.
    Map(Map),
}

impl Value {
    /// An integer value.
    pub fn int(i: i64) -> Value {
        Value::Int(i)
    }

    /// A float value, or `None` for NaN and infinities.
    pub fn float(f: f64) -> Option<Value> {
        f.is_finite().then_some(Value::Float(f))
    }

    /// A text value.
    pub fn string(s: impl Into<String>) -> Value {
        Value::Text(s.into())
    }

    /// The number, if this is an integer or a float.
    pub fn as_number(&self) -> Option<Number> {
        match self {
            Value::Int(i) => Some(Number::Int(*i)),
            Value::Float(f) => Some(Number::Float(*f)),
            _ => None,
        }
    }

    /// A value from a [`Number`].
    pub fn from_number(n: Number) -> Value {
        match n {
            Number::Int(i) => Value::Int(i),
            Number::Float(f) => Value::Float(f),
        }
    }

    /// The JSON type name: `null`, `boolean`, `number`, `string`, `array`, `object`.
    pub fn type_name(&self) -> &'static str {
        match self {
            Value::Null => "null",
            Value::Bool(_) => "boolean",
            Value::Int(_) | Value::Float(_) => "number",
            Value::Text(_) => "string",
            Value::List(_) => "array",
            Value::Map(_) => "object",
        }
    }

    /// The string, if this is a string.
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::Text(s) => Some(s),
            _ => None,
        }
    }

    /// The map, if this is a map.
    pub fn as_map(&self) -> Option<&Map> {
        match self {
            Value::Map(m) => Some(m),
            _ => None,
        }
    }

    /// The list, if this is a list.
    pub fn as_list(&self) -> Option<&[Value]> {
        match self {
            Value::List(l) => Some(l),
            _ => None,
        }
    }

    /// The boolean, if this is a boolean.
    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Value::Bool(b) => Some(*b),
            _ => None,
        }
    }

    /// Whether this is null.
    pub fn is_null(&self) -> bool {
        matches!(self, Value::Null)
    }

    /// Look up `key` when this is a map.
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.as_map().and_then(|m| m.get(key))
    }

    /// Canonical JSON text: map keys in insertion order, no insignificant
    /// whitespace, numbers per [`Number::to_json`], strings with the minimal
    /// JSON escapes (RFC 8785 string rules).
    pub fn to_json(&self) -> String {
        let mut out = String::new();
        self.write_json(&mut out);
        out
    }

    fn write_json(&self, out: &mut String) {
        match self {
            Value::Null => out.push_str("null"),
            Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            Value::Int(i) => out.push_str(&i.to_string()),
            Value::Float(f) => out.push_str(&format_float_es(*f)),
            Value::Text(s) => write_json_string(out, s),
            Value::List(items) => {
                out.push('[');
                for (i, v) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    v.write_json(out);
                }
                out.push(']');
            }
            Value::Map(m) => {
                out.push('{');
                for (i, (k, v)) in m.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    write_json_string(out, k);
                    out.push(':');
                    v.write_json(out);
                }
                out.push('}');
            }
        }
    }

    /// The number of value nodes in this tree (1 for a scalar).
    pub fn node_count(&self) -> u64 {
        match self {
            Value::List(items) => 1 + items.iter().map(Value::node_count).sum::<u64>(),
            Value::Map(m) => 1 + m.iter().map(|(_, v)| v.node_count()).sum::<u64>(),
            _ => 1,
        }
    }
}

/// Write `s` as a JSON string literal (RFC 8785 escaping).
pub(crate) fn write_json_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

impl PartialEq for Value {
    /// Spec 12A deep equality (see the module docs).
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Value::Null, Value::Null) => true,
            (Value::Bool(a), Value::Bool(b)) => a == b,
            (Value::Text(a), Value::Text(b)) => a == b,
            (Value::List(a), Value::List(b)) => a == b,
            (Value::Map(a), Value::Map(b)) => a == b,
            (a, b) => match (a.as_number(), b.as_number()) {
                (Some(x), Some(y)) => x == y,
                _ => false,
            },
        }
    }
}

impl From<&str> for Value {
    fn from(s: &str) -> Self {
        Value::Text(s.to_owned())
    }
}

impl From<String> for Value {
    fn from(s: String) -> Self {
        Value::Text(s)
    }
}

impl From<bool> for Value {
    fn from(b: bool) -> Self {
        Value::Bool(b)
    }
}

impl From<i64> for Value {
    fn from(i: i64) -> Self {
        Value::int(i)
    }
}

impl From<Map> for Value {
    fn from(m: Map) -> Self {
        Value::Map(m)
    }
}

impl From<Vec<Value>> for Value {
    fn from(l: Vec<Value>) -> Self {
        Value::List(l)
    }
}

/// A string-keyed map that keeps insertion order.
///
/// Lookups go through a `BTreeMap` index, so they are `O(log n)` and iteration
/// order is always the insertion order.
#[derive(Debug, Clone, Default)]
pub struct Map {
    entries: Vec<(String, Value)>,
    index: BTreeMap<String, usize>,
}

impl Map {
    /// An empty map.
    pub fn new() -> Map {
        Map::default()
    }

    /// Number of entries.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether the map is empty.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// The value for `key`.
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.index.get(key).map(|&i| &self.entries[i].1)
    }

    /// A mutable reference to the value for `key`.
    pub fn get_mut(&mut self, key: &str) -> Option<&mut Value> {
        self.index.get(key).map(|&i| &mut self.entries[i].1)
    }

    /// Whether `key` is present.
    pub fn contains_key(&self, key: &str) -> bool {
        self.index.contains_key(key)
    }

    /// Insert or replace. A new key goes last; a replaced key keeps its position.
    /// Returns the previous value.
    pub fn insert(&mut self, key: impl Into<String>, value: Value) -> Option<Value> {
        let key = key.into();
        if let Some(&i) = self.index.get(&key) {
            return Some(std::mem::replace(&mut self.entries[i].1, value));
        }
        self.index.insert(key.clone(), self.entries.len());
        self.entries.push((key, value));
        None
    }

    /// Remove `key`, keeping the order of the others. Returns the removed value.
    pub fn remove(&mut self, key: &str) -> Option<Value> {
        let i = self.index.remove(key)?;
        let (_, v) = self.entries.remove(i);
        for slot in self.index.values_mut() {
            if *slot > i {
                *slot -= 1;
            }
        }
        Some(v)
    }

    /// Iterate entries in insertion order.
    pub fn iter(&self) -> impl Iterator<Item = (&str, &Value)> {
        self.entries.iter().map(|(k, v)| (k.as_str(), v))
    }

    /// Keys in insertion order.
    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.entries.iter().map(|(k, _)| k.as_str())
    }
}

impl PartialEq for Map {
    /// Same key set and equal values; order does not matter (JSON object equality).
    fn eq(&self, other: &Self) -> bool {
        self.len() == other.len() && self.iter().all(|(k, v)| other.get(k) == Some(v))
    }
}

impl FromIterator<(String, Value)> for Map {
    fn from_iter<I: IntoIterator<Item = (String, Value)>>(iter: I) -> Self {
        let mut m = Map::new();
        for (k, v) in iter {
            m.insert(k, v);
        }
        m
    }
}

impl IntoIterator for Map {
    type Item = (String, Value);
    type IntoIter = std::vec::IntoIter<(String, Value)>;
    fn into_iter(self) -> Self::IntoIter {
        self.entries.into_iter()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_compare_exactly() {
        let i = |x| Number::Int(x);
        let f = |x| Number::Float(x);
        assert_eq!(i(1), f(1.0));
        assert_eq!(f(-0.0), f(0.0));
        assert_eq!(i(0), f(-0.0));
        assert_eq!(i(1).cmp_numeric(f(1.5)), Ordering::Less);
        assert_eq!(i(-1).cmp_numeric(f(-1.5)), Ordering::Greater);
        // 2^53 + 1 is not representable as f64; the comparison must not round.
        let big = 9_007_199_254_740_993_i64;
        assert_eq!(
            i(big).cmp_numeric(f(9_007_199_254_740_992.0)),
            Ordering::Greater
        );
        assert_eq!(i(i64::MAX).cmp_numeric(f(TWO_POW_63)), Ordering::Less);
        assert_eq!(i(i64::MIN).cmp_numeric(f(-TWO_POW_63)), Ordering::Equal);
        assert_eq!(i(i64::MIN).cmp_numeric(f(-1e300)), Ordering::Greater);
    }

    #[test]
    fn es_float_formatting() {
        let cases = [
            (42.0, "42"),
            (1.5, "1.5"),
            (-0.0, "0"),
            (0.1, "0.1"),
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (1e-6, "0.000001"),
            (1e-7, "1e-7"),
            (123.456, "123.456"),
            (-2.5e-10, "-2.5e-10"),
            (5e-324, "5e-324"),
            (1.7976931348623157e308, "1.7976931348623157e+308"),
            (0.000_123, "0.000123"),
            (3.333_333_333_333_333_5, "3.3333333333333335"),
        ];
        for (f, want) in cases {
            assert_eq!(format_float_es(f), want, "{f}");
        }
    }

    #[test]
    fn value_equality_is_spec_equality() {
        assert_eq!(Value::int(1), Value::Float(1.0));
        assert_ne!(Value::string("1"), Value::int(1));
        assert_ne!(Value::Null, Value::Bool(false));
        let a: Map = [
            ("x".to_owned(), Value::int(1)),
            ("y".to_owned(), Value::Null),
        ]
        .into_iter()
        .collect();
        let b: Map = [
            ("y".to_owned(), Value::Null),
            ("x".to_owned(), Value::int(1)),
        ]
        .into_iter()
        .collect();
        assert_eq!(a, b);
        assert_ne!(
            Value::List(vec![Value::int(1), Value::int(2)]),
            Value::List(vec![Value::int(2), Value::int(1)])
        );
    }

    #[test]
    fn map_keeps_order_and_index() {
        let mut m = Map::new();
        m.insert("b", Value::int(1));
        m.insert("a", Value::int(2));
        m.insert("c", Value::int(3));
        m.insert("a", Value::int(4));
        assert_eq!(m.keys().collect::<Vec<_>>(), ["b", "a", "c"]);
        assert_eq!(m.remove("b"), Some(Value::int(1)));
        assert_eq!(m.keys().collect::<Vec<_>>(), ["a", "c"]);
        assert_eq!(m.get("c"), Some(&Value::int(3)));
        assert_eq!(m.get("a"), Some(&Value::int(4)));
        assert_eq!(Value::Map(m).to_json(), r#"{"a":4,"c":3}"#);
    }

    #[test]
    fn json_strings_escape_minimally() {
        let v = Value::string("a\"b\\c\n\u{1}é😀");
        assert_eq!(v.to_json(), "\"a\\\"b\\\\c\\n\\u0001é😀\"");
    }
}
