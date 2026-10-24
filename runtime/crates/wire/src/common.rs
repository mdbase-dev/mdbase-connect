//! Common types (`docs/contracts/00-overview.md` §3.4).

use std::fmt;

use crate::cbor::Cbor;
use crate::schema::{Ann, SchemaError, Wire, array, type_err};

macro_rules! fixed_bytes {
    ($(#[$meta:meta])* $name:ident, $n:literal, $what:literal) => {
        $(#[$meta])*
        #[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub struct $name(pub [u8; $n]);

        impl $name {
            /// Lowercase hexadecimal.
            pub fn to_hex(&self) -> String {
                crate::render::hex(&self.0)
            }
        }

        impl fmt::Debug for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "{}({})", stringify!($name), self.to_hex())
            }
        }

        impl Wire for $name {
            fn to_cbor(&self) -> Cbor {
                Cbor::Bytes(self.0.to_vec())
            }
            fn from_cbor(c: &Cbor) -> Result<Self, SchemaError> {
                match c {
                    Cbor::Bytes(b) => <[u8; $n]>::try_from(b.as_slice())
                        .map($name)
                        .map_err(|_| SchemaError::Invalid { ty: stringify!($name), reason: $what }),
                    _ => Err(type_err(stringify!($name), "bytes", c)),
                }
            }
        }
    };
}

fixed_bytes!(
    /// 16 bytes: UUIDs, key IDs, salts, idempotency tokens, stream IDs.
    B16,
    16,
    "must be 16 bytes"
);
fixed_bytes!(
    /// 32 bytes: SHA-256 digests, object addresses, X25519 and Ed25519 public keys, seeds.
    B32,
    32,
    "must be 32 bytes"
);
fixed_bytes!(
    /// 64 bytes: Ed25519 signatures.
    B64,
    64,
    "must be 64 bytes"
);

/// RFC 9562 UUID, network byte order.
pub type Uuid = B16;
/// SHA-256 digest.
pub type Hash = B32;
/// Ed25519 signature.
pub type Signature = B64;

impl B16 {
    /// Canonical lowercase hyphenated UUID text (`8-4-4-4-12`).
    pub fn to_uuid_string(&self) -> String {
        let h = self.to_hex();
        format!(
            "{}-{}-{}-{}-{}",
            &h[0..8],
            &h[8..12],
            &h[12..16],
            &h[16..20],
            &h[20..32]
        )
    }
}

/// A variable-length byte string.
#[derive(Clone, PartialEq, Eq, Default)]
pub struct Bytes(pub Vec<u8>);

impl fmt::Debug for Bytes {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Bytes({})", crate::render::hex(&self.0))
    }
}

impl Wire for Bytes {
    fn to_cbor(&self) -> Cbor {
        Cbor::Bytes(self.0.clone())
    }
    fn from_cbor(c: &Cbor) -> Result<Self, SchemaError> {
        match c {
            Cbor::Bytes(b) => Ok(Bytes(b.clone())),
            _ => Err(type_err("bstr", "bytes", c)),
        }
    }
}

/// `[major, minor]`: the semantics version (`sem`) and API versions (`version`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Version {
    /// Major.
    pub major: u64,
    /// Minor.
    pub minor: u64,
}

/// Semantics version (`00-overview.md` §6.3).
pub type Sem = Version;

impl Wire for Version {
    fn to_cbor(&self) -> Cbor {
        Cbor::Array(vec![Cbor::Uint(self.major), Cbor::Uint(self.minor)])
    }
    fn from_cbor(c: &Cbor) -> Result<Self, SchemaError> {
        match array(c, "version")? {
            [a, b] => Ok(Version {
                major: u64::from_cbor(a)?,
                minor: u64::from_cbor(b)?,
            }),
            _ => Err(SchemaError::Invalid {
                ty: "version",
                reason: "must be [major, minor]",
            }),
        }
    }
    fn annotate(&self) -> Ann {
        Ann::Tuple(
            "Version",
            vec![
                ("major", Ann::Leaf(Cbor::Uint(self.major))),
                ("minor", Ann::Leaf(Cbor::Uint(self.minor))),
            ],
        )
    }
}

/// A data map: text keys, order significant (profile rule 6).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct DataMap<T>(pub Vec<(String, T)>);

impl<T> DataMap<T> {
    /// The value for `key`, if present.
    pub fn get(&self, key: &str) -> Option<&T> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }
}

impl<T: Wire> Wire for DataMap<T> {
    fn to_cbor(&self) -> Cbor {
        Cbor::Map(
            self.0
                .iter()
                .map(|(k, v)| (Cbor::Text(k.clone()), v.to_cbor()))
                .collect(),
        )
    }
    fn from_cbor(c: &Cbor) -> Result<Self, SchemaError> {
        match c {
            Cbor::Map(m) => m
                .iter()
                .map(|(k, v)| match k {
                    Cbor::Text(k) => Ok((k.clone(), T::from_cbor(v)?)),
                    _ => Err(type_err("data map", "text key", k)),
                })
                .collect::<Result<_, _>>()
                .map(DataMap),
            _ => Err(type_err("data map", "map", c)),
        }
    }
    fn annotate(&self) -> Ann {
        Ann::DataMap(
            self.0
                .iter()
                .map(|(k, v)| (k.clone(), v.annotate()))
                .collect(),
        )
    }
}

/// A frontmatter or app value (`value` in CDDL): the JSON data model plus an
/// int/float distinction. Maps keep their order.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    /// `null`.
    Null,
    /// Boolean.
    Bool(bool),
    /// A 64-bit signed integer.
    Int(i64),
    /// A finite binary64 float.
    Float(f64),
    /// Text.
    Text(String),
    /// A list.
    List(Vec<Value>),
    /// A mapping, in order.
    Map(Vec<(String, Value)>),
}

impl Wire for Value {
    fn to_cbor(&self) -> Cbor {
        match self {
            Value::Null => Cbor::Null,
            Value::Bool(b) => Cbor::Bool(*b),
            Value::Int(i) => Cbor::int(*i),
            Value::Float(f) => Cbor::Float(*f),
            Value::Text(s) => Cbor::Text(s.clone()),
            Value::List(l) => Cbor::Array(l.iter().map(Wire::to_cbor).collect()),
            Value::Map(m) => Cbor::Map(
                m.iter()
                    .map(|(k, v)| (Cbor::Text(k.clone()), v.to_cbor()))
                    .collect(),
            ),
        }
    }
    fn from_cbor(c: &Cbor) -> Result<Self, SchemaError> {
        Ok(match c {
            Cbor::Null => Value::Null,
            Cbor::Bool(b) => Value::Bool(*b),
            Cbor::Uint(_) | Cbor::Nint(_) => Value::Int(i64::from_cbor(c)?),
            Cbor::Float(f) => Value::Float(*f),
            Cbor::Text(s) => Value::Text(s.clone()),
            Cbor::Array(a) => {
                Value::List(a.iter().map(Value::from_cbor).collect::<Result<_, _>>()?)
            }
            Cbor::Map(m) => Value::Map(
                m.iter()
                    .map(|(k, v)| match k {
                        Cbor::Text(k) => Ok((k.clone(), Value::from_cbor(v)?)),
                        _ => Err(SchemaError::Invalid {
                            ty: "value",
                            reason: "map keys must be text",
                        }),
                    })
                    .collect::<Result<_, _>>()?,
            ),
            Cbor::Bytes(_) => {
                return Err(SchemaError::Invalid {
                    ty: "value",
                    reason: "byte strings are not values",
                });
            }
        })
    }
    fn annotate(&self) -> Ann {
        match self {
            Value::List(l) => Ann::Array(l.iter().map(Wire::annotate).collect()),
            Value::Map(m) => {
                Ann::DataMap(m.iter().map(|(k, v)| (k.clone(), v.annotate())).collect())
            }
            other => Ann::Leaf(other.to_cbor()),
        }
    }
}

/// `text` (intent.md §2): a string, or, inside a log entry, an index into the
/// entry's text table.
#[derive(Debug, Clone, PartialEq)]
pub enum Text {
    /// The text itself.
    Inline(String),
    /// Index into the enclosing entry's text table (log-entry.md §2.2).
    Index(u64),
}

impl Wire for Text {
    fn to_cbor(&self) -> Cbor {
        match self {
            Text::Inline(s) => Cbor::Text(s.clone()),
            Text::Index(i) => Cbor::Uint(*i),
        }
    }
    fn from_cbor(c: &Cbor) -> Result<Self, SchemaError> {
        match c {
            Cbor::Text(s) => Ok(Text::Inline(s.clone())),
            Cbor::Uint(i) => Ok(Text::Index(*i)),
            _ => Err(type_err("text", "text or uint", c)),
        }
    }
}

impl From<&str> for Text {
    fn from(s: &str) -> Self {
        Text::Inline(s.to_owned())
    }
}
