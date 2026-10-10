//! Shared query-index semantics. SQL stores persist `(kind, key)` verbatim;
//! neither SQLite type precedence nor JavaScript number conversion defines order.
//! Temporal hints are trusted schema metadata, never guessed from string shape.

use std::cmp::Ordering;

use crate::cel::time::{MAX_SECONDS, MIN_SECONDS, Timestamp};
use crate::ids::RecordId;
use crate::types::Catalog;
use crate::value::{Number, Value};

use super::{FieldRef, QueryEnv, QueryRecord};

/// Version of the kind codes, order-key encoding and canonical field paths.
pub const KEY_VERSION: u8 = 1;

/// Ascending kind order. Null/missing is last.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[repr(u8)]
pub enum AtomKind {
    /// False precedes true.
    Bool = 1,
    /// Integers and finite floats share one exact numeric domain.
    Number = 2,
    /// Explicitly typed dates/date-times, ordered by instant.
    Temporal = 3,
    /// UTF-8 byte order equals Unicode code-point order.
    Text = 4,
    /// Lists are ordered by length, not their elements.
    List = 5,
    /// Maps are ordered by length, not their keys or values.
    Map = 6,
    /// Missing and explicit null share an empty key.
    Null = 255,
}

/// Why an index value cannot be encoded or trusted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IndexKeyError {
    /// A key/path exceeds the caller's explicit byte limit.
    TooWide,
    /// Invalid kind, non-finite number or malformed/noncanonical key.
    Invalid,
    /// Continuation belongs to another snapshot, clock, query or codec version.
    StaleCursor,
}

/// Annotation supplied by a trusted schema/metadata producer.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TemporalHint {
    /// Plain strings remain text, even if they look like dates.
    #[default]
    None,
    /// Valid ISO date, interpreted as midnight UTC for query ordering.
    Date,
    /// Valid RFC 3339 date-time with an offset.
    DateTime,
}

/// A compact, lossless SQL BLOB order key. Its Rust ordering is the SQL oracle.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct SortAtom {
    kind: AtomKind,
    key: Vec<u8>,
}

impl SortAtom {
    /// Materialize one field, rejecting excessive key size before copying text.
    /// Invalid schema-declared temporal strings remain ordinary text.
    pub fn from_value(
        value: Option<&Value>,
        hint: TemporalHint,
        max_key_bytes: usize,
    ) -> Result<Self, IndexKeyError> {
        let (kind, key) = match value {
            None | Some(Value::Null) => (AtomKind::Null, Vec::new()),
            Some(Value::Bool(b)) => (AtomKind::Bool, vec![u8::from(*b)]),
            Some(Value::Int(i)) => (AtomKind::Number, number_key(Number::Int(*i))?),
            Some(Value::Float(f)) => (AtomKind::Number, number_key(Number::Float(*f))?),
            Some(Value::Text(s)) => {
                let time = temporal_text(s, hint);
                if let Some(t) = time {
                    let mut key = Vec::with_capacity(12);
                    let seconds = u64::from_ne_bytes(t.seconds.to_ne_bytes()) ^ (1 << 63);
                    key.extend_from_slice(&seconds.to_be_bytes());
                    key.extend_from_slice(&t.nanos.to_be_bytes());
                    (AtomKind::Temporal, key)
                } else {
                    if s.len() > max_key_bytes {
                        return Err(IndexKeyError::TooWide);
                    }
                    (AtomKind::Text, s.as_bytes().to_vec())
                }
            }
            Some(Value::List(values)) => (
                AtomKind::List,
                u64::try_from(values.len())
                    .map_err(|_| IndexKeyError::TooWide)?
                    .to_be_bytes()
                    .to_vec(),
            ),
            Some(Value::Map(values)) => (
                AtomKind::Map,
                u64::try_from(values.len())
                    .map_err(|_| IndexKeyError::TooWide)?
                    .to_be_bytes()
                    .to_vec(),
            ),
        };
        if key.len() > max_key_bytes {
            return Err(IndexKeyError::TooWide);
        }
        Ok(Self { kind, key })
    }

    /// Reconstruct a bounded key read from an index or binary cursor.
    pub fn from_parts(code: u8, key: &[u8], max_key_bytes: usize) -> Result<Self, IndexKeyError> {
        if key.len() > max_key_bytes {
            return Err(IndexKeyError::TooWide);
        }
        let kind = match code {
            1 if key.len() == 1 && key[0] <= 1 => AtomKind::Bool,
            2 if valid_number_key(key) => AtomKind::Number,
            3 if valid_time_key(key) => AtomKind::Temporal,
            4 if std::str::from_utf8(key).is_ok() => AtomKind::Text,
            5 if key.len() == 8 => AtomKind::List,
            6 if key.len() == 8 => AtomKind::Map,
            255 if key.is_empty() => AtomKind::Null,
            _ => return Err(IndexKeyError::Invalid),
        };
        Ok(Self {
            kind,
            key: key.to_vec(),
        })
    }

    /// Stable SQL kind code.
    pub fn kind(&self) -> AtomKind {
        self.kind
    }

    /// SQL BLOB bytes, never a floating-point host number.
    pub fn key(&self) -> &[u8] {
        &self.key
    }

    pub(crate) fn allocated_key_bytes(&self) -> usize {
        self.key.capacity()
    }
}

// Exact normalized binary magnitude: sign, biased exponent, 64-bit significand.
// i64 has <=64 significant bits, f64 <=53: neither needs rounding. Complement
// negative magnitudes; both signed zero representations use one all-zero key.
fn number_key(value: Number) -> Result<Vec<u8>, IndexKeyError> {
    let (negative, exponent, significand) = match value {
        Number::Int(i) => {
            let magnitude = i.unsigned_abs();
            if magnitude == 0 {
                return Ok(zero_key());
            }
            let bit = 63 - magnitude.leading_zeros();
            (
                i < 0,
                i32::try_from(bit).unwrap_or(0),
                magnitude << (63 - bit),
            )
        }
        Number::Float(f) => {
            if !f.is_finite() {
                return Err(IndexKeyError::Invalid);
            }
            if f == 0.0 {
                return Ok(zero_key());
            }
            let bits = f.to_bits();
            let exp = u16::try_from((bits >> 52) & 0x7ff).unwrap_or(0);
            let fraction = bits & ((1 << 52) - 1);
            let (exponent, significand) = if exp == 0 {
                let bit = 63 - fraction.leading_zeros();
                (
                    i32::try_from(bit).unwrap_or(0) - 1074,
                    fraction << (63 - bit),
                )
            } else {
                (i32::from(exp) - 1023, (fraction | (1 << 52)) << 11)
            };
            (bits >> 63 != 0, exponent, significand)
        }
    };
    let biased = u16::try_from(exponent + 1074).map_err(|_| IndexKeyError::Invalid)?;
    let mut key = Vec::with_capacity(11);
    key.push(if negative { 0 } else { 2 });
    key.extend_from_slice(&biased.to_be_bytes());
    key.extend_from_slice(&significand.to_be_bytes());
    if negative {
        for byte in &mut key[1..] {
            *byte = !*byte;
        }
    }
    Ok(key)
}

fn zero_key() -> Vec<u8> {
    let mut key = vec![0; 11];
    key[0] = 1;
    key
}

fn valid_number_key(key: &[u8]) -> bool {
    if key.len() != 11 {
        return false;
    }
    if key[0] == 1 {
        return key[1..].iter().all(|b| *b == 0);
    }
    if !matches!(key[0], 0 | 2) {
        return false;
    }
    let mut magnitude: [u8; 10] = key[1..].try_into().unwrap_or([0; 10]);
    if key[0] == 0 {
        for byte in &mut magnitude {
            *byte = !*byte;
        }
    }
    let biased = u16::from_be_bytes([magnitude[0], magnitude[1]]);
    if biased > 2097 || magnitude[2] & 0x80 == 0 {
        return false;
    }
    let exponent = i32::from(biased) - 1074;
    let significand = u64::from_be_bytes(magnitude[2..].try_into().unwrap_or([0; 8]));
    let float_shift = if exponent < -1022 {
        63 - (exponent + 1074)
    } else {
        11
    };
    let float_mask = (1u64 << u32::try_from(float_shift).unwrap_or(63)) - 1;
    let float_exact = significand & float_mask == 0;
    let int_exact = if (0..=62).contains(&exponent) {
        let mask = (1u64 << u32::try_from(63 - exponent).unwrap_or(63)) - 1;
        significand & mask == 0
    } else {
        key[0] == 0 && exponent == 63 && significand == 1 << 63
    };
    float_exact || int_exact
}

fn valid_time_key(key: &[u8]) -> bool {
    if key.len() != 12 {
        return false;
    }
    let bits = u64::from_be_bytes(key[..8].try_into().unwrap_or([0; 8])) ^ (1 << 63);
    let seconds = i64::from_ne_bytes(bits.to_ne_bytes());
    let nanos = u32::from_be_bytes(key[8..].try_into().unwrap_or([0; 4]));
    (MIN_SECONDS..=MAX_SECONDS).contains(&seconds) && nanos < 1_000_000_000
}

/// Source is part of a field index's identity: raw is never effective/defaulted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum FieldSource {
    /// Effective read-defaulted metadata.
    Effective = 0,
    /// Original persisted metadata; unsupported until separately projected.
    Raw = 1,
}

/// Caller-supplied materialization spec under a catalog/SEM generation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IndexFieldSpec {
    /// Distinct metadata source.
    pub source: FieldSource,
    /// Structural path segments; not an ambiguously dotted name.
    pub path: Vec<String>,
    /// Trusted producer's temporal annotation.
    pub temporal: TemporalHint,
}

impl IndexFieldSpec {
    /// Eligibility against today's top-level effective-only RecordMeta.
    /// Projections, computed selections, body/file metadata and raw are not
    /// implicitly indexable. A caller must also reject computed selection aliases.
    pub fn effective_top_level(field: &FieldRef) -> Option<Self> {
        let FieldRef::Effective(path) = field else {
            return None;
        };
        if path.len() != 1 {
            return None;
        }
        Some(Self {
            source: FieldSource::Effective,
            path: path.clone(),
            temporal: TemporalHint::None,
        })
    }

    /// Unambiguous field identity: u32 count followed by u32 byte length + UTF-8
    /// for each segment. Reject aggregate width before allocating the result.
    pub fn path_key(&self, max_bytes: usize) -> Result<Vec<u8>, IndexKeyError> {
        let count = u32::try_from(self.path.len()).map_err(|_| IndexKeyError::TooWide)?;
        let mut size = 4usize;
        for segment in &self.path {
            u32::try_from(segment.len()).map_err(|_| IndexKeyError::TooWide)?;
            size = size
                .checked_add(4)
                .and_then(|n| n.checked_add(segment.len()))
                .ok_or(IndexKeyError::TooWide)?;
        }
        if size > max_bytes {
            return Err(IndexKeyError::TooWide);
        }
        let mut key = Vec::with_capacity(size);
        key.extend_from_slice(&count.to_be_bytes());
        for segment in &self.path {
            key.extend_from_slice(
                &u32::try_from(segment.len())
                    .map_err(|_| IndexKeyError::TooWide)?
                    .to_be_bytes(),
            );
            key.extend_from_slice(segment.as_bytes());
        }
        Ok(key)
    }
}

/// A hint is present only when every matched type is known and declares the
/// same unambiguous date/date-time format. Stores do not call this themselves.
pub fn temporal_hint(catalog: &Catalog, types: &[String], path: &[String]) -> TemporalHint {
    schemas_temporal_hint(
        types.iter().map(|name| {
            catalog
                .type_named(name)
                .map(|t| (&t.schema_document, t.schema_entry.as_str()))
        }),
        path,
    )
}

pub(crate) fn schemas_temporal_hint<'a>(
    schemas: impl Iterator<Item = Option<(&'a Value, &'a str)>>,
    path: &[String],
) -> TemporalHint {
    let location: Vec<_> = path.iter().map(String::as_str).collect();
    let mut common = None;
    for schema in schemas {
        let Some((document, entry)) = schema else {
            return TemporalHint::None;
        };
        let format = crate::types::schema_at(document, entry, &location)
            .and_then(|s| s.get("format"))
            .and_then(Value::as_str);
        let hint = match format {
            Some("date") => TemporalHint::Date,
            Some("date-time") => TemporalHint::DateTime,
            _ => return TemporalHint::None,
        };
        if common.is_some_and(|old| old != hint) {
            return TemporalHint::None;
        }
        common = Some(hint);
    }
    common.unwrap_or(TemporalHint::None)
}

/// Project trusted top-level effective fields, with read defaults and per-record
/// schema hints. `record.frontmatter` must be persisted metadata; callers supply
/// membership from the same captured clock/catalog/head as the generation.
/// Raw/nested fields are rejected, not inferred from effective values. Query
/// drivers must separately exclude computed selection aliases.
pub fn project_index_fields(
    catalog: &Catalog,
    record: &QueryRecord<'_>,
    fields: &[FieldRef],
    max_key_bytes: usize,
) -> Result<Vec<(IndexFieldSpec, SortAtom)>, IndexKeyError> {
    let effective = catalog.effective_frontmatter(record.types, record.frontmatter);
    fields
        .iter()
        .map(|field| {
            let mut spec =
                IndexFieldSpec::effective_top_level(field).ok_or(IndexKeyError::Invalid)?;
            spec.temporal = temporal_hint(catalog, record.types, &spec.path);
            let atom =
                SortAtom::from_value(effective.get(&spec.path[0]), spec.temporal, max_key_bytes)?;
            Ok((spec, atom))
        })
        .collect()
}

fn temporal_value(value: Option<&Value>, hint: TemporalHint) -> Option<Timestamp> {
    let Some(Value::Text(s)) = value else {
        return None;
    };
    temporal_text(s, hint)
}

fn temporal_text(s: &str, hint: TemporalHint) -> Option<Timestamp> {
    match hint {
        TemporalHint::None => None,
        TemporalHint::Date if s.len() == 10 => Timestamp::parse(&format!("{s}T00:00:00Z")).ok(),
        TemporalHint::Date => None,
        TemporalHint::DateTime => Timestamp::parse(s).ok(),
    }
}

/// Data/cache identity that invalidates old index rows and continuations.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IndexGeneration {
    /// Physical rebuild/materialization generation.
    pub generation: u64,
    /// Confirmed log snapshot.
    pub head_seq: u64,
    /// Catalog/schema/read-default fingerprint.
    pub catalog_hash: [u8; 32],
    /// Semantic version of the materialized keys.
    pub sem: [u32; 2],
}

/// Captured query clock; continuation never reads fresh host time.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapturedClock {
    /// Milliseconds since epoch.
    pub now_ms: i64,
    /// Captured local date.
    pub today: String,
    /// Captured time zone.
    pub tz: String,
}

impl From<&QueryEnv> for CapturedClock {
    fn from(env: &QueryEnv) -> Self {
        Self {
            now_ms: env.now_ms,
            today: env.today.clone(),
            tz: env.tz.clone(),
        }
    }
}

/// Identity to which every keyset continuation is bound. Host authorization
/// independently binds the external cursor to its principal/grant/lease.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CursorStamp {
    /// Codec version, currently [`KEY_VERSION`].
    pub version: u8,
    /// Data/cache snapshot.
    pub index: IndexGeneration,
    /// Full query/order/projection/invocation fingerprint.
    pub query_hash: [u8; 32],
    /// Fixed clock across pages.
    pub clock: CapturedClock,
}

/// Full lexicographic keyset position. Record ID is the final ASC tie-break in
/// both ASC and DESC queries. Path is payload, never a stability tie-break.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IndexCursor {
    /// Query/snapshot identity.
    pub stamp: CursorStamp,
    /// One key per order term.
    pub keys: Vec<SortAtom>,
    /// Last record ID.
    pub id: RecordId,
}

impl IndexCursor {
    /// Reject stale identities or wrong key arity rather than resuming at an
    /// offset in a different data set. Binary decoders also bound key bytes.
    pub fn validate(&self, expected: &CursorStamp, arity: usize) -> Result<(), IndexKeyError> {
        if self.stamp.version != KEY_VERSION || self.stamp != *expected || self.keys.len() != arity
        {
            return Err(IndexKeyError::StaleCursor);
        }
        Ok(())
    }
}

/// Compare explicit typed values using exactly the materialized-key semantics.
pub fn compare_typed(
    a: Option<&Value>,
    ah: TemporalHint,
    b: Option<&Value>,
    bh: TemporalHint,
) -> Result<Ordering, IndexKeyError> {
    if [a, b]
        .into_iter()
        .flatten()
        .any(|v| matches!(v, Value::Float(f) if !f.is_finite()))
    {
        return Err(IndexKeyError::Invalid);
    }
    // Compare directly: sorting must not copy large text keys for every pair.
    let (at, bt) = (temporal_value(a, ah), temporal_value(b, bh));
    let kind = |value: Option<&Value>| value.map_or(AtomKind::Null, super::value_kind);
    Ok(match (at, bt) {
        (Some(a), Some(b)) => a.cmp(&b),
        (Some(_), None) => AtomKind::Temporal.cmp(&kind(b)),
        (None, Some(_)) => kind(a).cmp(&AtomKind::Temporal),
        (None, None) => super::compare_values(a, b),
    })
}
