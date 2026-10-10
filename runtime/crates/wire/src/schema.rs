//! Typed mapping between Rust values and `mdb-cbor/1` items.
//!
//! Every wire type implements [`Wire`]. Struct maps are declared with
//! [`wire_struct!`](crate::wire_struct), tagged unions (discriminator at key 0) with
//! [`wire_union!`](crate::wire_union), integer enums with [`wire_enum!`](crate::wire_enum)
//! and positional arrays with [`wire_tuple!`](crate::wire_tuple). The macros give the
//! compatibility rules of `docs/contracts/00-overview.md` §6.2:
//!
//! - unknown struct keys are ignored on decode;
//! - unknown variants and enum values are errors ([`SchemaError::UnknownVariant`]);
//! - an unknown `fmt` is an error ([`SchemaError::UnknownFormat`]).
//!
//! The annotation tree ([`Ann`]) carries field and variant names, for the annotated
//! diagnostic notation and the JSON debug view of fixtures (`crate::render`).

use std::fmt;

use crate::cbor::{self, Cbor, CborError};

/// Why an item does not match a wire schema.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SchemaError {
    /// The bytes are not valid `mdb-cbor/1`.
    Cbor(CborError),
    /// An item of the wrong CBOR type.
    Type {
        /// The schema type being decoded.
        ty: &'static str,
        /// What was expected.
        expected: &'static str,
        /// What was found.
        found: &'static str,
    },
    /// A required struct key is absent.
    Missing {
        /// The schema type.
        ty: &'static str,
        /// The missing key.
        key: u64,
    },
    /// An unknown discriminator or enum value: critical, never skipped.
    UnknownVariant {
        /// The schema type.
        ty: &'static str,
        /// The value found.
        value: u64,
    },
    /// An unknown `fmt` (format major version).
    UnknownFormat {
        /// The schema type.
        ty: &'static str,
        /// The `fmt` found.
        fmt: u64,
    },
    /// A value outside the schema's constraints (sizes, ranges, arity).
    Invalid {
        /// The schema type.
        ty: &'static str,
        /// What is wrong.
        reason: &'static str,
    },
}

impl fmt::Display for SchemaError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SchemaError::Cbor(e) => write!(f, "invalid mdb-cbor/1: {e}"),
            SchemaError::Type {
                ty,
                expected,
                found,
            } => {
                write!(f, "{ty}: expected {expected}, found {found}")
            }
            SchemaError::Missing { ty, key } => write!(f, "{ty}: missing required key {key}"),
            SchemaError::UnknownVariant { ty, value } => write!(f, "{ty}: unknown variant {value}"),
            SchemaError::UnknownFormat { ty, fmt } => write!(f, "{ty}: unknown fmt {fmt}"),
            SchemaError::Invalid { ty, reason } => write!(f, "{ty}: {reason}"),
        }
    }
}

impl std::error::Error for SchemaError {}

impl From<CborError> for SchemaError {
    fn from(e: CborError) -> Self {
        SchemaError::Cbor(e)
    }
}

impl SchemaError {
    /// True when a newer writer may have produced this item: an unknown variant or
    /// format. Log items failing this way stall rather than void (log-entry.md §4.2).
    pub fn is_unknown(&self) -> bool {
        matches!(
            self,
            SchemaError::UnknownVariant { .. } | SchemaError::UnknownFormat { .. }
        )
    }
}

/// Annotated view of a wire value: the CBOR structure plus schema names.
#[derive(Debug, Clone, PartialEq)]
pub enum Ann {
    /// A scalar or opaque item.
    Leaf(Cbor),
    /// An integer enum value with its name.
    Enum(&'static str, u64),
    /// A struct map. Fields are `(key, name, value)` in key order.
    Struct(&'static str, Vec<(u64, &'static str, Ann)>),
    /// A positional array with element names.
    Tuple(&'static str, Vec<(&'static str, Ann)>),
    /// An array.
    Array(Vec<Ann>),
    /// A data map (order significant).
    DataMap(Vec<(String, Ann)>),
}

/// A type with a fixed `mdb-cbor/1` representation.
pub trait Wire: Sized {
    /// The item for this value.
    fn to_cbor(&self) -> Cbor;
    /// Decode from an item. Unknown struct keys are ignored.
    fn from_cbor(c: &Cbor) -> Result<Self, SchemaError>;
    /// Annotated view, for diagnostics and fixtures.
    fn annotate(&self) -> Ann {
        Ann::Leaf(self.to_cbor())
    }

    /// Canonical bytes. Fails only if the value breaks the profile (duplicate data
    /// map keys, non-finite floats).
    fn to_bytes(&self) -> Result<Vec<u8>, CborError> {
        cbor::encode(&self.to_cbor())
    }

    /// Decode canonical bytes. Non-canonical input is rejected.
    fn from_bytes(bytes: &[u8]) -> Result<Self, SchemaError> {
        Self::from_cbor(&cbor::decode(bytes)?)
    }
}

// ---------------------------------------------------------------- helpers used by the macros

#[doc(hidden)]
pub fn type_err(ty: &'static str, expected: &'static str, c: &Cbor) -> SchemaError {
    SchemaError::Type {
        ty,
        expected,
        found: c.kind(),
    }
}

/// The entries of a struct map (uint keys). An empty map is a valid struct map.
#[doc(hidden)]
pub fn struct_map<'a>(c: &'a Cbor, ty: &'static str) -> Result<&'a [(Cbor, Cbor)], SchemaError> {
    match c {
        Cbor::Map(m) if m.iter().all(|(k, _)| matches!(k, Cbor::Uint(_))) => Ok(m),
        _ => Err(type_err(ty, "struct map", c)),
    }
}

#[doc(hidden)]
pub fn lookup(m: &[(Cbor, Cbor)], key: u64) -> Option<&Cbor> {
    m.iter()
        .find(|(k, _)| *k == Cbor::Uint(key))
        .map(|(_, v)| v)
}

#[doc(hidden)]
pub fn require<'a>(
    m: &'a [(Cbor, Cbor)],
    key: u64,
    ty: &'static str,
) -> Result<&'a Cbor, SchemaError> {
    lookup(m, key).ok_or(SchemaError::Missing { ty, key })
}

#[doc(hidden)]
pub fn check_fmt(m: &[(Cbor, Cbor)], ty: &'static str, want: u64) -> Result<(), SchemaError> {
    match require(m, 0, ty)? {
        Cbor::Uint(f) if *f == want => Ok(()),
        Cbor::Uint(f) => Err(SchemaError::UnknownFormat { ty, fmt: *f }),
        other => Err(type_err(ty, "uint fmt", other)),
    }
}

#[doc(hidden)]
pub fn discriminator(m: &[(Cbor, Cbor)], ty: &'static str) -> Result<u64, SchemaError> {
    match require(m, 0, ty)? {
        Cbor::Uint(t) => Ok(*t),
        other => Err(type_err(ty, "uint discriminator", other)),
    }
}

/// Prepend `0: tag` to a struct map produced by a variant.
#[doc(hidden)]
pub fn with_tag(tag: u64, inner: Cbor) -> Cbor {
    match inner {
        Cbor::Map(mut m) => {
            m.insert(0, (Cbor::Uint(0), Cbor::Uint(tag)));
            Cbor::Map(m)
        }
        other => other,
    }
}

#[doc(hidden)]
pub fn ann_with_tag(tag: u64, variant: &'static str, inner: Ann) -> Ann {
    match inner {
        Ann::Struct(_, mut fields) => {
            fields.insert(0, (0, "kind", Ann::Enum(variant, tag)));
            Ann::Struct(variant, fields)
        }
        other => other,
    }
}

/// CDDL `[+ T]`: a list that must not be empty.
#[doc(hidden)]
pub fn non_empty<T>(v: Vec<T>, ty: &'static str) -> Result<Vec<T>, SchemaError> {
    if v.is_empty() {
        Err(SchemaError::Invalid {
            ty,
            reason: "list must not be empty",
        })
    } else {
        Ok(v)
    }
}

#[doc(hidden)]
pub fn array<'a>(c: &'a Cbor, ty: &'static str) -> Result<&'a [Cbor], SchemaError> {
    match c {
        Cbor::Array(a) => Ok(a),
        _ => Err(type_err(ty, "array", c)),
    }
}

// ---------------------------------------------------------------- macros

/// Declare a struct map type. Field modes: `req` (always present), `opt`
/// (`Option`, omitted when `None`), and `req1` / `opt1` for lists that must not be
/// empty (CDDL `[+ T]`). Keys must be listed in ascending order. An
/// optional `[fmt = N]` makes key 0 the format version, written on encode and
/// checked on decode.
#[macro_export]
macro_rules! wire_struct {
    (
        $(#[$meta:meta])*
        pub struct $name:ident [fmt = $fmt:literal] {
            $( $(#[doc = $doc:literal])* $key:literal $mode:ident $field:ident : $ty:ty, )*
        }
    ) => {
        $crate::wire_struct!(@define $(#[$meta])* $name, Some($fmt), { $( $(#[doc = $doc])* $key $mode $field : $ty, )* });
    };
    (
        $(#[$meta:meta])*
        pub struct $name:ident {
            $( $(#[doc = $doc:literal])* $key:literal $mode:ident $field:ident : $ty:ty, )*
        }
    ) => {
        $crate::wire_struct!(@define $(#[$meta])* $name, None, { $( $(#[doc = $doc])* $key $mode $field : $ty, )* });
    };
    (@define $(#[$meta:meta])* $name:ident, $fmt:expr, { $( $(#[doc = $doc:literal])* $key:literal $mode:ident $field:ident : $ty:ty, )* }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq)]
        pub struct $name {
            $( $(#[doc = $doc])* pub $field: $crate::wire_struct!(@ty $mode $ty), )*
        }

        impl $crate::schema::Wire for $name {
            fn to_cbor(&self) -> $crate::cbor::Cbor {
                #[allow(unused_mut)]
                let mut m: Vec<($crate::cbor::Cbor, $crate::cbor::Cbor)> = Vec::new();
                let fmt: Option<u64> = $fmt;
                if let Some(f) = fmt {
                    m.push(($crate::cbor::Cbor::Uint(0), $crate::cbor::Cbor::Uint(f)));
                }
                $( $crate::wire_struct!(@enc $mode m, $key, self.$field); )*
                $crate::cbor::Cbor::Map(m)
            }

            fn from_cbor(c: &$crate::cbor::Cbor) -> Result<Self, $crate::schema::SchemaError> {
                let ty = stringify!($name);
                #[allow(unused_variables)]
                let m = $crate::schema::struct_map(c, ty)?;
                let fmt: Option<u64> = $fmt;
                if let Some(f) = fmt {
                    $crate::schema::check_fmt(m, ty, f)?;
                }
                Ok($name { $( $field: $crate::wire_struct!(@dec $mode m, $key, ty), )* })
            }

            fn annotate(&self) -> $crate::schema::Ann {
                #[allow(unused_mut)]
                let mut f: Vec<(u64, &'static str, $crate::schema::Ann)> = Vec::new();
                let fmt: Option<u64> = $fmt;
                if let Some(v) = fmt {
                    f.push((0, "fmt", $crate::schema::Ann::Leaf($crate::cbor::Cbor::Uint(v))));
                }
                $( $crate::wire_struct!(@ann $mode f, $key, stringify!($field), self.$field); )*
                $crate::schema::Ann::Struct(stringify!($name), f)
            }
        }
    };
    (@ty req $ty:ty) => { $ty };
    (@ty req1 $ty:ty) => { $ty };
    (@ty opt $ty:ty) => { Option<$ty> };
    (@ty opt1 $ty:ty) => { Option<$ty> };
    (@enc req $m:ident, $key:literal, $v:expr) => {
        $m.push(($crate::cbor::Cbor::Uint($key), $crate::schema::Wire::to_cbor(&$v)));
    };
    (@enc req1 $m:ident, $key:literal, $v:expr) => {
        $crate::wire_struct!(@enc req $m, $key, $v);
    };
    (@enc opt1 $m:ident, $key:literal, $v:expr) => {
        $crate::wire_struct!(@enc opt $m, $key, $v);
    };
    (@enc opt $m:ident, $key:literal, $v:expr) => {
        if let Some(x) = &$v {
            $m.push(($crate::cbor::Cbor::Uint($key), $crate::schema::Wire::to_cbor(x)));
        }
    };
    (@dec req $m:ident, $key:literal, $ty:ident) => {
        $crate::schema::Wire::from_cbor($crate::schema::require($m, $key, $ty)?)?
    };
    (@dec req1 $m:ident, $key:literal, $ty:ident) => {
        $crate::schema::non_empty($crate::wire_struct!(@dec req $m, $key, $ty), $ty)?
    };
    (@dec opt1 $m:ident, $key:literal, $ty:ident) => {
        match $crate::wire_struct!(@dec opt $m, $key, $ty) {
            Some(v) => Some($crate::schema::non_empty(v, $ty)?),
            None => None,
        }
    };
    (@dec opt $m:ident, $key:literal, $ty:ident) => {
        match $crate::schema::lookup($m, $key) {
            Some(v) => Some($crate::schema::Wire::from_cbor(v)?),
            None => None,
        }
    };
    (@ann req $f:ident, $key:literal, $name:expr, $v:expr) => {
        $f.push(($key, $name, $crate::schema::Wire::annotate(&$v)));
    };
    (@ann req1 $f:ident, $key:literal, $name:expr, $v:expr) => {
        $crate::wire_struct!(@ann req $f, $key, $name, $v);
    };
    (@ann opt1 $f:ident, $key:literal, $name:expr, $v:expr) => {
        $crate::wire_struct!(@ann opt $f, $key, $name, $v);
    };
    (@ann opt $f:ident, $key:literal, $name:expr, $v:expr) => {
        if let Some(x) = &$v {
            $f.push(($key, $name, $crate::schema::Wire::annotate(x)));
        }
    };
}

/// Declare a tagged union whose discriminator is key 0 of a struct map. Each variant
/// wraps a [`wire_struct!`] type that does not use key 0.
#[macro_export]
macro_rules! wire_union {
    (
        $(#[$meta:meta])*
        pub enum $name:ident {
            $( $(#[doc = $doc:literal])* $tag:literal => $var:ident($ty:ty), )*
        }
    ) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq)]
        pub enum $name {
            $( $(#[doc = $doc])* $var($ty), )*
        }

        impl $crate::schema::Wire for $name {
            fn to_cbor(&self) -> $crate::cbor::Cbor {
                match self {
                    $( $name::$var(v) => $crate::schema::with_tag($tag, $crate::schema::Wire::to_cbor(v)), )*
                }
            }

            fn from_cbor(c: &$crate::cbor::Cbor) -> Result<Self, $crate::schema::SchemaError> {
                let ty = stringify!($name);
                let m = $crate::schema::struct_map(c, ty)?;
                match $crate::schema::discriminator(m, ty)? {
                    $( $tag => Ok($name::$var(<$ty as $crate::schema::Wire>::from_cbor(c)?)), )*
                    value => Err($crate::schema::SchemaError::UnknownVariant { ty, value }),
                }
            }

            fn annotate(&self) -> $crate::schema::Ann {
                match self {
                    $( $name::$var(v) => $crate::schema::ann_with_tag($tag, stringify!($var), $crate::schema::Wire::annotate(v)), )*
                }
            }
        }
    };
}

/// Declare an enumeration encoded as an unsigned integer. Unknown values are errors.
#[macro_export]
macro_rules! wire_enum {
    (
        $(#[$meta:meta])*
        pub enum $name:ident {
            $( $(#[doc = $doc:literal])* $var:ident = $v:literal, )*
        }
    ) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub enum $name {
            $( $(#[doc = $doc])* $var, )*
        }

        impl $name {
            /// The wire value.
            pub fn value(self) -> u64 {
                match self { $( $name::$var => $v, )* }
            }
        }

        impl $crate::schema::Wire for $name {
            fn to_cbor(&self) -> $crate::cbor::Cbor {
                $crate::cbor::Cbor::Uint(self.value())
            }

            fn from_cbor(c: &$crate::cbor::Cbor) -> Result<Self, $crate::schema::SchemaError> {
                let ty = stringify!($name);
                match c {
                    $crate::cbor::Cbor::Uint(n) => match *n {
                        $( $v => Ok($name::$var), )*
                        value => Err($crate::schema::SchemaError::UnknownVariant { ty, value }),
                    },
                    other => Err($crate::schema::type_err(ty, "uint enum", other)),
                }
            }

            fn annotate(&self) -> $crate::schema::Ann {
                let name = match self { $( $name::$var => stringify!($var), )* };
                $crate::schema::Ann::Enum(name, self.value())
            }
        }
    };
}

/// Declare a positional array with a fixed number of elements.
#[macro_export]
macro_rules! wire_tuple {
    (
        $(#[$meta:meta])*
        pub struct $name:ident {
            $( $(#[doc = $doc:literal])* $field:ident : $ty:ty, )*
        }
    ) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq)]
        pub struct $name {
            $( $(#[doc = $doc])* pub $field: $ty, )*
        }

        impl $crate::schema::Wire for $name {
            fn to_cbor(&self) -> $crate::cbor::Cbor {
                $crate::cbor::Cbor::Array(vec![ $( $crate::schema::Wire::to_cbor(&self.$field), )* ])
            }

            fn from_cbor(c: &$crate::cbor::Cbor) -> Result<Self, $crate::schema::SchemaError> {
                let ty = stringify!($name);
                let a = $crate::schema::array(c, ty)?;
                let want = [$( stringify!($field), )*].len();
                if a.len() != want {
                    return Err($crate::schema::SchemaError::Invalid { ty, reason: "wrong number of elements" });
                }
                let mut it = a.iter();
                Ok($name { $( $field: match it.next() {
                    Some(v) => $crate::schema::Wire::from_cbor(v)?,
                    None => return Err($crate::schema::SchemaError::Invalid { ty, reason: "wrong number of elements" }),
                }, )* })
            }

            fn annotate(&self) -> $crate::schema::Ann {
                $crate::schema::Ann::Tuple(stringify!($name), vec![ $( (stringify!($field), $crate::schema::Wire::annotate(&self.$field)), )* ])
            }
        }
    };
}

// ---------------------------------------------------------------- primitive impls

impl Wire for u64 {
    fn to_cbor(&self) -> Cbor {
        Cbor::Uint(*self)
    }
    fn from_cbor(c: &Cbor) -> Result<Self, SchemaError> {
        match c {
            Cbor::Uint(n) => Ok(*n),
            _ => Err(type_err("uint", "uint", c)),
        }
    }
}

impl Wire for i64 {
    fn to_cbor(&self) -> Cbor {
        Cbor::int(*self)
    }
    fn from_cbor(c: &Cbor) -> Result<Self, SchemaError> {
        match c {
            Cbor::Uint(_) | Cbor::Nint(_) => c.as_i64().ok_or(SchemaError::Invalid {
                ty: "int",
                reason: "integer outside int64",
            }),
            _ => Err(type_err("int", "int", c)),
        }
    }
}

impl Wire for bool {
    fn to_cbor(&self) -> Cbor {
        Cbor::Bool(*self)
    }
    fn from_cbor(c: &Cbor) -> Result<Self, SchemaError> {
        match c {
            Cbor::Bool(b) => Ok(*b),
            _ => Err(type_err("bool", "bool", c)),
        }
    }
}

impl Wire for String {
    fn to_cbor(&self) -> Cbor {
        Cbor::Text(self.clone())
    }
    fn from_cbor(c: &Cbor) -> Result<Self, SchemaError> {
        match c {
            Cbor::Text(s) => Ok(s.clone()),
            _ => Err(type_err("tstr", "text", c)),
        }
    }
}

impl<T: Wire> Wire for Vec<T> {
    fn to_cbor(&self) -> Cbor {
        Cbor::Array(self.iter().map(Wire::to_cbor).collect())
    }
    fn from_cbor(c: &Cbor) -> Result<Self, SchemaError> {
        array(c, "array")?.iter().map(T::from_cbor).collect()
    }
    fn annotate(&self) -> Ann {
        Ann::Array(self.iter().map(Wire::annotate).collect())
    }
}

/// Any item (`any` in CDDL): kept as a raw [`Cbor`] tree.
impl Wire for Cbor {
    fn to_cbor(&self) -> Cbor {
        self.clone()
    }
    fn from_cbor(c: &Cbor) -> Result<Self, SchemaError> {
        Ok(c.clone())
    }
}
