//! CEL runtime values.

use std::cmp::Ordering;
use std::sync::Arc;

use super::time::{Duration, Timestamp};
use crate::value::{Map, Value, format_float_es};

/// A CEL map key (CEL allows int, uint, bool and string keys).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum Key {
    /// `bool`.
    Bool(bool),
    /// `int`.
    Int(i64),
    /// `uint`.
    Uint(u64),
    /// `string`.
    String(Arc<str>),
}

impl Key {
    fn to_value(&self) -> CelValue {
        match self {
            Key::Bool(b) => CelValue::Bool(*b),
            Key::Int(i) => CelValue::Int(*i),
            Key::Uint(u) => CelValue::Uint(*u),
            Key::String(s) => CelValue::String(s.clone()),
        }
    }

    /// Whether `v` is this key under CEL equality (numeric keys compare by
    /// value across int and uint).
    fn matches(&self, v: &CelValue) -> bool {
        self.to_value().equals(v)
    }
}

/// An insertion-ordered CEL map.
#[derive(Debug, Clone, Default)]
pub struct CelMap {
    entries: Vec<(Key, CelValue)>,
    /// For a record map (a candidate, `this`, or an `asFile()` result): the
    /// record's path, so links read from it resolve relative to it (spec 10).
    origin: Option<Arc<str>>,
}

impl CelMap {
    /// An empty map.
    pub fn new() -> CelMap {
        CelMap::default()
    }

    /// A record map read from the record at `path`.
    pub fn with_origin(mut self, path: &str) -> CelMap {
        self.origin = Some(Arc::from(path));
        self
    }

    /// The record path this map was read from, if it is a record map.
    pub fn origin(&self) -> Option<&str> {
        self.origin.as_deref()
    }

    /// Insert; returns false when the key was already present (a duplicate).
    pub fn insert(&mut self, k: Key, v: CelValue) -> bool {
        if self
            .entries
            .iter()
            .any(|(e, _)| e.to_value().equals(&k.to_value()))
        {
            return false;
        }
        self.entries.push((k, v));
        true
    }

    /// Look up by a key value.
    pub fn get(&self, key: &CelValue) -> Option<&CelValue> {
        self.entries
            .iter()
            .find(|(k, _)| k.matches(key))
            .map(|(_, v)| v)
    }

    /// Look up a string key.
    pub fn get_str(&self, key: &str) -> Option<&CelValue> {
        self.entries
            .iter()
            .find(|(k, _)| matches!(k, Key::String(s) if &**s == key))
            .map(|(_, v)| v)
    }

    /// Number of entries.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether the map is empty.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Keys as values, in insertion order.
    pub fn keys(&self) -> impl Iterator<Item = CelValue> + '_ {
        self.entries.iter().map(|(k, _)| k.to_value())
    }

    /// Entries in insertion order.
    pub fn iter(&self) -> impl Iterator<Item = (&Key, &CelValue)> {
        self.entries.iter().map(|(k, v)| (k, v))
    }
}

/// A CEL value.
#[derive(Debug, Clone)]
pub enum CelValue {
    /// `null`.
    Null,
    /// `bool`.
    Bool(bool),
    /// `int` (64-bit signed).
    Int(i64),
    /// `uint` (64-bit unsigned).
    Uint(u64),
    /// `double` (IEEE 754 binary64).
    Double(f64),
    /// `string`.
    String(Arc<str>),
    /// `bytes`.
    Bytes(Arc<[u8]>),
    /// `list`.
    List(Arc<Vec<CelValue>>),
    /// `map`.
    Map(Arc<CelMap>),
    /// `optional_type`.
    Optional(Option<Arc<CelValue>>),
    /// `google.protobuf.Timestamp`.
    Timestamp(Timestamp),
    /// `google.protobuf.Duration`.
    Duration(Duration),
}

impl CelValue {
    /// A string value.
    pub fn string(s: &str) -> CelValue {
        CelValue::String(Arc::from(s))
    }

    /// The CEL type name.
    pub fn type_name(&self) -> &'static str {
        match self {
            CelValue::Null => "null_type",
            CelValue::Bool(_) => "bool",
            CelValue::Int(_) => "int",
            CelValue::Uint(_) => "uint",
            CelValue::Double(_) => "double",
            CelValue::String(_) => "string",
            CelValue::Bytes(_) => "bytes",
            CelValue::List(_) => "list",
            CelValue::Map(_) => "map",
            CelValue::Optional(_) => "optional_type",
            CelValue::Timestamp(_) => "google.protobuf.Timestamp",
            CelValue::Duration(_) => "google.protobuf.Duration",
        }
    }

    /// CEL equality: heterogeneous numeric comparison by value, element-wise
    /// lists, key-set maps; values of different types are not equal.
    pub fn equals(&self, other: &CelValue) -> bool {
        use CelValue as V;
        match (self, other) {
            (V::Null, V::Null) => true,
            (V::Bool(a), V::Bool(b)) => a == b,
            (V::String(a), V::String(b)) => a == b,
            (V::Bytes(a), V::Bytes(b)) => a == b,
            (V::List(a), V::List(b)) => {
                a.len() == b.len() && a.iter().zip(b.iter()).all(|(x, y)| x.equals(y))
            }
            (V::Map(a), V::Map(b)) => {
                a.len() == b.len()
                    && a.iter()
                        .all(|(k, v)| b.get(&k.to_value()).is_some_and(|w| v.equals(w)))
            }
            (V::Timestamp(a), V::Timestamp(b)) => a == b,
            (V::Duration(a), V::Duration(b)) => a == b,
            (V::Optional(a), V::Optional(b)) => match (a, b) {
                (None, None) => true,
                (Some(x), Some(y)) => x.equals(y),
                _ => false,
            },
            _ => matches!(numeric_cmp(self, other), Some(Ordering::Equal)),
        }
    }

    /// Convert a frontmatter value (spec 10 "Record Values").
    pub fn from_value(v: &Value) -> CelValue {
        match v {
            Value::Null => CelValue::Null,
            Value::Bool(b) => CelValue::Bool(*b),
            Value::Int(i) => CelValue::Int(*i),
            Value::Float(f) => CelValue::Double(*f),
            Value::Text(s) => CelValue::string(s),
            Value::List(l) => {
                CelValue::List(Arc::new(l.iter().map(CelValue::from_value).collect()))
            }
            Value::Map(m) => CelValue::Map(Arc::new(map_from(m))),
        }
    }

    /// Convert a frontmatter value, typing date-times (spec 10 "Temporal
    /// Values"): a string at a location for which `date_time` returns true
    /// becomes a timestamp when it is a valid RFC 3339 date-time, and stays a
    /// string otherwise. A location is the list of object keys from the root,
    /// with `"[]"` for an array item. The caller decides the locations from
    /// the matched schemas (`format: date-time` in every matched schema).
    pub fn from_value_typed(v: &Value, date_time: &dyn Fn(&[&str]) -> bool) -> CelValue {
        fn go(v: &Value, at: &mut Vec<String>, date_time: &dyn Fn(&[&str]) -> bool) -> CelValue {
            match v {
                Value::Text(s) => {
                    let loc: Vec<&str> = at.iter().map(String::as_str).collect();
                    if date_time(&loc)
                        && let Ok(t) = super::time::Timestamp::parse(s)
                    {
                        return CelValue::Timestamp(t);
                    }
                    CelValue::string(s)
                }
                Value::List(l) => {
                    at.push("[]".to_owned());
                    let items = l.iter().map(|x| go(x, at, date_time)).collect();
                    at.pop();
                    CelValue::List(Arc::new(items))
                }
                Value::Map(m) => {
                    let mut out = CelMap::new();
                    for (k, x) in m.iter() {
                        at.push(k.to_owned());
                        out.insert(Key::String(Arc::from(k)), go(x, at, date_time));
                        at.pop();
                    }
                    CelValue::Map(Arc::new(out))
                }
                other => CelValue::from_value(other),
            }
        }
        go(v, &mut Vec::new(), date_time)
    }

    /// Convert to a frontmatter value, where the data model can hold it
    /// (`uint` beyond `i64`, non-finite doubles, bytes and non-string map keys
    /// cannot be represented and give `None`).
    pub fn to_value(&self) -> Option<Value> {
        Some(match self {
            CelValue::Null => Value::Null,
            CelValue::Bool(b) => Value::Bool(*b),
            CelValue::Int(i) => Value::Int(*i),
            CelValue::Uint(u) => Value::Int(i64::try_from(*u).ok()?),
            CelValue::Double(f) => Value::float(*f)?,
            CelValue::String(s) => Value::string(&**s),
            CelValue::Bytes(_) => return None,
            CelValue::List(l) => {
                Value::List(l.iter().map(CelValue::to_value).collect::<Option<_>>()?)
            }
            CelValue::Map(m) => {
                let mut out = Map::new();
                for (k, v) in m.iter() {
                    let Key::String(k) = k else { return None };
                    out.insert(&**k, v.to_value()?);
                }
                Value::Map(out)
            }
            CelValue::Optional(o) => match o {
                Some(v) => v.to_value()?,
                None => Value::Null,
            },
            // Spec 10 "Serialization".
            CelValue::Timestamp(t) => Value::Text(t.to_rfc3339()),
            CelValue::Duration(d) => Value::Text(d.to_cel_string()),
        })
    }

    /// A short text rendering for `string()` and diagnostics.
    pub(crate) fn display(&self) -> String {
        match self {
            CelValue::Double(f) => {
                if f.is_nan() {
                    "NaN".into()
                } else if f.is_infinite() {
                    if *f > 0.0 {
                        "+Inf".into()
                    } else {
                        "-Inf".into()
                    }
                } else {
                    format_float_es(*f)
                }
            }
            CelValue::String(s) => s.to_string(),
            CelValue::Uint(u) => u.to_string(),
            CelValue::Int(i) => i.to_string(),
            other => other
                .to_value()
                .map_or_else(|| other.type_name().to_owned(), |v| v.to_json()),
        }
    }
}

/// Map a frontmatter map into a CEL map.
pub fn map_from(m: &Map) -> CelMap {
    let mut out = CelMap::new();
    for (k, v) in m.iter() {
        out.insert(Key::String(Arc::from(k)), CelValue::from_value(v));
    }
    out
}

/// Heterogeneous numeric ordering (CEL): int, uint and double compare by value;
/// NaN is unordered.
pub(crate) fn numeric_cmp(a: &CelValue, b: &CelValue) -> Option<Ordering> {
    use CelValue as V;
    match (a, b) {
        (V::Int(x), V::Int(y)) => Some(x.cmp(y)),
        (V::Uint(x), V::Uint(y)) => Some(x.cmp(y)),
        (V::Int(x), V::Uint(y)) => Some(if *x < 0 {
            Ordering::Less
        } else {
            (*x as u64).cmp(y)
        }),
        (V::Uint(x), V::Int(y)) => Some(if *y < 0 {
            Ordering::Greater
        } else {
            x.cmp(&(*y as u64))
        }),
        (V::Double(x), V::Double(y)) => x.partial_cmp(y),
        (V::Int(x), V::Double(y)) => int_double(*x, *y),
        (V::Double(x), V::Int(y)) => int_double(*y, *x).map(Ordering::reverse),
        (V::Uint(x), V::Double(y)) => uint_double(*x, *y),
        (V::Double(x), V::Uint(y)) => uint_double(*y, *x).map(Ordering::reverse),
        _ => None,
    }
}

fn int_double(i: i64, f: f64) -> Option<Ordering> {
    if f.is_nan() {
        return None;
    }
    if f.is_infinite() {
        return Some(if f > 0.0 {
            Ordering::Less
        } else {
            Ordering::Greater
        });
    }
    Some(crate::value::Number::Int(i).cmp_numeric(crate::value::Number::Float(f)))
}

fn uint_double(u: u64, f: f64) -> Option<Ordering> {
    if f.is_nan() {
        return None;
    }
    if f < 0.0 {
        return Some(Ordering::Greater);
    }
    const TWO_POW_64: f64 = 18_446_744_073_709_551_616.0;
    if f >= TWO_POW_64 {
        return Some(Ordering::Less);
    }
    let t = f.trunc();
    // 0 <= t < 2^64: exact.
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let tu = t as u64;
    Some(match u.cmp(&tu) {
        Ordering::Equal if f > t => Ordering::Less,
        o => o,
    })
}
