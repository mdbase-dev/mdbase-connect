//! Conversions between the public JSON types and the engine's wire types.

use mdbn_wire::common::{B16, B32, DataMap, Value as Wire};
use serde_json::{Map, Value};

/// Wire → JSON.
pub(crate) fn to_json(v: &Wire) -> Value {
    match v {
        Wire::Null => Value::Null,
        Wire::Bool(b) => Value::Bool(*b),
        Wire::Int(i) => Value::from(*i),
        Wire::Float(f) => serde_json::Number::from_f64(*f).map_or(Value::Null, Value::Number),
        Wire::Text(s) => Value::String(s.clone()),
        Wire::List(l) => Value::Array(l.iter().map(to_json).collect()),
        Wire::Map(m) => Value::Object(m.iter().map(|(k, v)| (k.clone(), to_json(v))).collect()),
    }
}

/// JSON → wire. Integers stay exact; other numbers become floats.
pub(crate) fn to_wire(v: &Value) -> Wire {
    match v {
        Value::Null => Wire::Null,
        Value::Bool(b) => Wire::Bool(*b),
        Value::Number(n) => match n.as_i64() {
            Some(i) => Wire::Int(i),
            None => Wire::Float(n.as_f64().unwrap_or(0.0)),
        },
        Value::String(s) => Wire::Text(s.clone()),
        Value::Array(a) => Wire::List(a.iter().map(to_wire).collect()),
        Value::Object(o) => Wire::Map(o.iter().map(|(k, v)| (k.clone(), to_wire(v))).collect()),
    }
}

pub(crate) fn map_to_json(m: &DataMap<Wire>) -> Map<String, Value> {
    m.0.iter().map(|(k, v)| (k.clone(), to_json(v))).collect()
}

pub(crate) fn pairs_to_wire(pairs: &[(String, Value)]) -> DataMap<Wire> {
    DataMap(pairs.iter().map(|(k, v)| (k.clone(), to_wire(v))).collect())
}

/// A record ID: a UUID (v7 when minted here).
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct RecordId(pub [u8; 16]);

impl RecordId {
    pub(crate) fn from_wire(b: B16) -> RecordId {
        RecordId(b.0)
    }

    pub(crate) fn to_wire(self) -> B16 {
        B16(self.0)
    }

    /// Parse `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` or 32 hex digits.
    pub fn parse(s: &str) -> Option<RecordId> {
        let hex: String = s.chars().filter(|c| *c != '-').collect();
        if hex.len() != 32 {
            return None;
        }
        let mut out = [0u8; 16];
        for (i, o) in out.iter_mut().enumerate() {
            *o = u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).ok()?;
        }
        Some(RecordId(out))
    }
}

impl std::fmt::Display for RecordId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let h: String = self.0.iter().map(|b| format!("{b:02x}")).collect();
        write!(
            f,
            "{}-{}-{}-{}-{}",
            &h[..8],
            &h[8..12],
            &h[12..16],
            &h[16..20],
            &h[20..]
        )
    }
}

impl std::fmt::Debug for RecordId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "RecordId({self})")
    }
}

impl std::str::FromStr for RecordId {
    type Err = crate::Error;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        RecordId::parse(s).ok_or_else(|| crate::Error::InvalidPath {
            path: s.to_owned(),
            reason: "not a UUID".into(),
        })
    }
}

/// A record revision: SHA-256 of the file, `sha256:<hex>`. Use it as an
/// `if_revision` guard.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Revision(pub [u8; 32]);

impl Revision {
    pub(crate) fn from_wire(b: B32) -> Revision {
        Revision(b.0)
    }

    pub(crate) fn to_wire(self) -> B32 {
        B32(self.0)
    }

    /// Parse `sha256:<64 hex>` or bare hex.
    pub fn parse(s: &str) -> Option<Revision> {
        let hex = s.strip_prefix("sha256:").unwrap_or(s);
        if hex.len() != 64 {
            return None;
        }
        let mut out = [0u8; 32];
        for (i, o) in out.iter_mut().enumerate() {
            *o = u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).ok()?;
        }
        Some(Revision(out))
    }
}

impl std::fmt::Display for Revision {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("sha256:")?;
        for b in self.0 {
            write!(f, "{b:02x}")?;
        }
        Ok(())
    }
}

impl std::fmt::Debug for Revision {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Revision({self})")
    }
}
