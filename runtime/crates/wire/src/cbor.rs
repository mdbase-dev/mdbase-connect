//! The `mdb-cbor/1` profile: a strict, deterministic subset of CBOR (RFC 8949).
//!
//! Normative text: `docs/contracts/00-overview.md` §3.2. Summary of the rules this
//! module enforces, on both encode and decode:
//!
//! 1. definite lengths only;
//! 2. shortest-form heads (integers, lengths);
//! 3. integers within −2^63 … 2^64−1, no bignums;
//! 4. floats always binary64, finite (negative zero allowed);
//! 5. simple values `false`, `true`, `null` only;
//! 6. maps are either *struct maps* (all keys unsigned integers, strictly ascending)
//!    or *data maps* (all keys text, distinct, order kept as data);
//! 7. text is valid UTF-8, never normalized;
//! 8. no tags;
//! 9. exactly one top-level item.

use std::fmt;

/// Maximum nesting depth accepted by the decoder. Frontmatter is limited to 64
/// (log-entry.md §10); the envelope and payload structure add a few levels.
pub const MAX_DEPTH: usize = 128;

/// A decoded `mdb-cbor/1` data item.
#[derive(Debug, Clone, PartialEq)]
pub enum Cbor {
    /// Major type 0.
    Uint(u64),
    /// Major type 1: the value is `-1 - n`.
    Nint(u64),
    /// Major type 2.
    Bytes(Vec<u8>),
    /// Major type 3.
    Text(String),
    /// Major type 4.
    Array(Vec<Cbor>),
    /// Major type 5, entries in encoded order.
    Map(Vec<(Cbor, Cbor)>),
    /// `false` / `true`.
    Bool(bool),
    /// `null`.
    Null,
    /// IEEE 754 binary64, finite.
    Float(f64),
}

impl Cbor {
    /// A signed integer as `Uint` or `Nint`.
    pub fn int(v: i64) -> Cbor {
        if v >= 0 {
            Cbor::Uint(v as u64)
        } else {
            // -1 - n = v  =>  n = -1 - v, which is non-negative and fits in u64.
            Cbor::Nint((-1 - v) as u64)
        }
    }

    /// The value as an `i64`, if it is an integer in range.
    pub fn as_i64(&self) -> Option<i64> {
        match *self {
            Cbor::Uint(n) => i64::try_from(n).ok(),
            Cbor::Nint(n) => i64::try_from(n).ok().map(|n| -1 - n),
            _ => None,
        }
    }

    /// Short description of the item's type, for error messages.
    pub fn kind(&self) -> &'static str {
        match self {
            Cbor::Uint(_) => "uint",
            Cbor::Nint(_) => "nint",
            Cbor::Bytes(_) => "bytes",
            Cbor::Text(_) => "text",
            Cbor::Array(_) => "array",
            Cbor::Map(_) => "map",
            Cbor::Bool(_) => "bool",
            Cbor::Null => "null",
            Cbor::Float(_) => "float",
        }
    }
}

/// Why bytes are not valid `mdb-cbor/1`, or why a value cannot be encoded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CborError {
    /// Input ended inside an item.
    UnexpectedEnd,
    /// Bytes after the single top-level item (rule 9).
    TrailingBytes,
    /// Indefinite length (rule 1).
    Indefinite,
    /// A head not in shortest form (rule 2).
    NonCanonicalHead,
    /// A tag (rule 8).
    Tag,
    /// A float that is not binary64, or not finite (rule 4).
    Float,
    /// A simple value other than false/true/null (rule 5).
    Simple,
    /// Invalid UTF-8 in a text string (rule 7).
    Utf8,
    /// A map whose keys are neither all unsigned integers nor all text (rule 6).
    MixedMapKeys,
    /// Struct map keys not strictly ascending (rule 6).
    UnsortedKeys,
    /// Duplicate data map key (rule 6).
    DuplicateKey,
    /// Nesting deeper than [`MAX_DEPTH`].
    TooDeep,
    /// A length that cannot be allocated on this platform.
    TooLong,
}

impl fmt::Display for CborError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            CborError::UnexpectedEnd => "unexpected end of input",
            CborError::TrailingBytes => "trailing bytes after the top-level item",
            CborError::Indefinite => "indefinite-length item",
            CborError::NonCanonicalHead => "integer or length not in shortest form",
            CborError::Tag => "tags are not allowed",
            CborError::Float => "float must be a finite binary64",
            CborError::Simple => "simple value other than false, true or null",
            CborError::Utf8 => "invalid UTF-8 in text string",
            CborError::MixedMapKeys => "map keys must be all unsigned integers or all text",
            CborError::UnsortedKeys => "struct map keys must be strictly ascending",
            CborError::DuplicateKey => "duplicate data map key",
            CborError::TooDeep => "nesting too deep",
            CborError::TooLong => "length too large",
        };
        f.write_str(s)
    }
}

impl std::error::Error for CborError {}

/// Check the map rule (rule 6) on a list of entries.
fn check_map(entries: &[(Cbor, Cbor)]) -> Result<(), CborError> {
    let Some((first, _)) = entries.first() else {
        return Ok(());
    };
    match first {
        Cbor::Uint(_) => {
            let mut prev: Option<u64> = None;
            for (k, _) in entries {
                let Cbor::Uint(k) = k else {
                    return Err(CborError::MixedMapKeys);
                };
                if prev.is_some_and(|p| p >= *k) {
                    return Err(CborError::UnsortedKeys);
                }
                prev = Some(*k);
            }
            Ok(())
        }
        Cbor::Text(_) => {
            let mut seen = std::collections::BTreeSet::new();
            for (k, _) in entries {
                let Cbor::Text(k) = k else {
                    return Err(CborError::MixedMapKeys);
                };
                if !seen.insert(k.as_str()) {
                    return Err(CborError::DuplicateKey);
                }
            }
            Ok(())
        }
        _ => Err(CborError::MixedMapKeys),
    }
}

// ---------------------------------------------------------------- encoding

fn head(out: &mut Vec<u8>, major: u8, arg: u64) {
    let m = major << 5;
    if arg < 24 {
        out.push(m | arg as u8);
    } else if arg <= u64::from(u8::MAX) {
        out.push(m | 24);
        out.push(arg as u8);
    } else if arg <= u64::from(u16::MAX) {
        out.push(m | 25);
        out.extend_from_slice(&(arg as u16).to_be_bytes());
    } else if arg <= u64::from(u32::MAX) {
        out.push(m | 26);
        out.extend_from_slice(&(arg as u32).to_be_bytes());
    } else {
        out.push(m | 27);
        out.extend_from_slice(&arg.to_be_bytes());
    }
}

/// Encode a value in canonical form. Fails if the value breaks the profile
/// (unsorted or mixed map keys, duplicate data keys, non-finite floats).
pub fn encode(v: &Cbor) -> Result<Vec<u8>, CborError> {
    let mut out = Vec::new();
    encode_into(v, &mut out, 0)?;
    Ok(out)
}

fn encode_into(v: &Cbor, out: &mut Vec<u8>, depth: usize) -> Result<(), CborError> {
    if depth > MAX_DEPTH {
        return Err(CborError::TooDeep);
    }
    match v {
        Cbor::Uint(n) => head(out, 0, *n),
        Cbor::Nint(n) => head(out, 1, *n),
        Cbor::Bytes(b) => {
            head(out, 2, b.len() as u64);
            out.extend_from_slice(b);
        }
        Cbor::Text(s) => {
            head(out, 3, s.len() as u64);
            out.extend_from_slice(s.as_bytes());
        }
        Cbor::Array(items) => {
            head(out, 4, items.len() as u64);
            for i in items {
                encode_into(i, out, depth + 1)?;
            }
        }
        Cbor::Map(entries) => {
            check_map(entries)?;
            head(out, 5, entries.len() as u64);
            for (k, v) in entries {
                encode_into(k, out, depth + 1)?;
                encode_into(v, out, depth + 1)?;
            }
        }
        Cbor::Bool(false) => out.push(0xf4),
        Cbor::Bool(true) => out.push(0xf5),
        Cbor::Null => out.push(0xf6),
        Cbor::Float(f) => {
            if !f.is_finite() {
                return Err(CborError::Float);
            }
            out.push(0xfb);
            out.extend_from_slice(&f.to_bits().to_be_bytes());
        }
    }
    Ok(())
}

// ---------------------------------------------------------------- decoding

/// Decode exactly one canonical `mdb-cbor/1` item. Any profile violation is an error.
pub fn decode(bytes: &[u8]) -> Result<Cbor, CborError> {
    Decoder::new(bytes).complete()
}

/// Check that bytes are valid `mdb-cbor/1` without keeping the decoded value.
pub fn validate(bytes: &[u8]) -> Result<(), CborError> {
    decode(bytes).map(|_| ())
}

/// Parser-owned byte strings may contain keys. On ordinary decode errors,
/// erase every completed subtree before dropping it. No extra copies or
/// allocations: the rejected tree's existing buffers are overwritten in place.
fn cleanup_decode_error(
    mut value: Cbor,
    error: CborError,
    #[cfg(test)] trace: &mut Vec<(usize, bool)>,
) -> CborError {
    fn wipe(value: &mut Cbor, #[cfg(test)] trace: &mut Vec<(usize, bool)>) {
        match value {
            Cbor::Bytes(bytes) => {
                bytes.fill(0);
                std::hint::black_box(&mut *bytes);
                #[cfg(test)]
                trace.push((bytes.len(), bytes.iter().all(|b| *b == 0)));
            }
            Cbor::Array(items) => {
                #[cfg(not(test))]
                items.iter_mut().for_each(wipe);
                #[cfg(test)]
                items.iter_mut().for_each(|v| wipe(v, trace));
            }
            Cbor::Map(entries) => entries.iter_mut().for_each(|(k, v)| {
                wipe(
                    k,
                    #[cfg(test)]
                    trace,
                );
                wipe(
                    v,
                    #[cfg(test)]
                    trace,
                );
            }),
            _ => {}
        }
    }
    wipe(
        &mut value,
        #[cfg(test)]
        trace,
    );
    error
}

fn container<T>(n: usize) -> Result<Vec<T>, CborError> {
    let mut values = Vec::new();
    values
        .try_reserve_exact(n)
        .map_err(|_| CborError::TooLong)?;
    Ok(values)
}

struct Decoder<'a> {
    buf: &'a [u8],
    pos: usize,
    // Decoder-local before-drop observations, never shared or per-thread state.
    #[cfg(test)]
    cleanup_trace: Vec<(usize, bool)>,
}

impl<'a> Decoder<'a> {
    fn new(buf: &'a [u8]) -> Self {
        Self {
            buf,
            pos: 0,
            #[cfg(test)]
            cleanup_trace: Vec::new(),
        }
    }

    fn complete(&mut self) -> Result<Cbor, CborError> {
        let value = self.item(0)?;
        if self.pos != self.buf.len() {
            return Err(self.cleanup_error(value, CborError::TrailingBytes));
        }
        Ok(value)
    }

    fn cleanup_error(&mut self, value: Cbor, error: CborError) -> CborError {
        cleanup_decode_error(
            value,
            error,
            #[cfg(test)]
            &mut self.cleanup_trace,
        )
    }

    fn take(&mut self, n: usize) -> Result<&[u8], CborError> {
        let end = self.pos.checked_add(n).ok_or(CborError::TooLong)?;
        if end > self.buf.len() {
            return Err(CborError::UnexpectedEnd);
        }
        let s = &self.buf[self.pos..end];
        self.pos = end;
        Ok(s)
    }

    fn byte(&mut self) -> Result<u8, CborError> {
        Ok(self.take(1)?[0])
    }

    /// Read the argument of a head with additional info `ai`, enforcing shortest form.
    fn arg(&mut self, ai: u8) -> Result<u64, CborError> {
        let v = match ai {
            0..=23 => return Ok(u64::from(ai)),
            24 => {
                let v = u64::from(self.byte()?);
                if v < 24 {
                    return Err(CborError::NonCanonicalHead);
                }
                v
            }
            25 => {
                let b = self.take(2)?;
                let v = u64::from(u16::from_be_bytes([b[0], b[1]]));
                if v <= u64::from(u8::MAX) {
                    return Err(CborError::NonCanonicalHead);
                }
                v
            }
            26 => {
                let b = self.take(4)?;
                let v = u64::from(u32::from_be_bytes([b[0], b[1], b[2], b[3]]));
                if v <= u64::from(u16::MAX) {
                    return Err(CborError::NonCanonicalHead);
                }
                v
            }
            27 => {
                let b = self.take(8)?;
                let mut a = [0u8; 8];
                a.copy_from_slice(b);
                let v = u64::from_be_bytes(a);
                if v <= u64::from(u32::MAX) {
                    return Err(CborError::NonCanonicalHead);
                }
                v
            }
            31 => return Err(CborError::Indefinite),
            _ => return Err(CborError::NonCanonicalHead), // 28..=30 are reserved
        };
        Ok(v)
    }

    fn len(&mut self, ai: u8) -> Result<usize, CborError> {
        let n = self.arg(ai)?;
        let n = usize::try_from(n).map_err(|_| CborError::TooLong)?;
        // Every element needs at least one byte, so a length beyond the remaining
        // input is invalid; reject it before allocating.
        if n > self.buf.len() - self.pos {
            return Err(CborError::UnexpectedEnd);
        }
        Ok(n)
    }

    fn item(&mut self, depth: usize) -> Result<Cbor, CborError> {
        if depth > MAX_DEPTH {
            return Err(CborError::TooDeep);
        }
        let ib = self.byte()?;
        let major = ib >> 5;
        let ai = ib & 0x1f;
        match major {
            0 => Ok(Cbor::Uint(self.arg(ai)?)),
            1 => Ok(Cbor::Nint(self.arg(ai)?)),
            2 => {
                let n = self.len(ai)?;
                let source = self.take(n)?;
                let mut bytes = container::<u8>(source.len())?;
                bytes.extend_from_slice(source);
                Ok(Cbor::Bytes(bytes))
            }
            3 => {
                let n = self.len(ai)?;
                let b = self.take(n)?;
                let s = std::str::from_utf8(b).map_err(|_| CborError::Utf8)?;
                let mut text = String::new();
                text.try_reserve_exact(s.len())
                    .map_err(|_| CborError::TooLong)?;
                text.push_str(s);
                Ok(Cbor::Text(text))
            }
            4 => {
                let n = self.len(ai)?;
                let mut items = container(n)?;
                for _ in 0..n {
                    match self.item(depth + 1) {
                        Ok(value) => items.push(value),
                        Err(error) => return Err(self.cleanup_error(Cbor::Array(items), error)),
                    }
                }
                Ok(Cbor::Array(items))
            }
            5 => {
                let n = self.len(ai)?;
                let mut entries = container(n)?;
                for _ in 0..n {
                    let k = match self.item(depth + 1) {
                        Ok(key) => key,
                        Err(error) => return Err(self.cleanup_error(Cbor::Map(entries), error)),
                    };
                    let v = match self.item(depth + 1) {
                        Ok(value) => value,
                        Err(error) => {
                            // Include the completed key too. Capacity was reserved
                            // for this entry before parsing; this adds no allocation.
                            entries.push((k, Cbor::Null));
                            return Err(self.cleanup_error(Cbor::Map(entries), error));
                        }
                    };
                    entries.push((k, v));
                }
                if let Err(error) = check_map(&entries) {
                    return Err(self.cleanup_error(Cbor::Map(entries), error));
                }
                Ok(Cbor::Map(entries))
            }
            6 => Err(CborError::Tag),
            _ => match ai {
                20 => Ok(Cbor::Bool(false)),
                21 => Ok(Cbor::Bool(true)),
                22 => Ok(Cbor::Null),
                27 => {
                    let b = self.take(8)?;
                    let mut a = [0u8; 8];
                    a.copy_from_slice(b);
                    let f = f64::from_bits(u64::from_be_bytes(a));
                    if !f.is_finite() {
                        return Err(CborError::Float);
                    }
                    Ok(Cbor::Float(f))
                }
                25 | 26 => Err(CborError::Float),
                31 => Err(CborError::Indefinite),
                _ => Err(CborError::Simple),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn container_capacity_overflow_is_recoverable_without_allocation() {
        assert_eq!(container::<u8>(usize::MAX), Err(CborError::TooLong));
        assert_eq!(container::<Cbor>(usize::MAX), Err(CborError::TooLong));
        assert_eq!(
            container::<(Cbor, Cbor)>(usize::MAX),
            Err(CborError::TooLong)
        );
    }

    #[test]
    fn truncated_byte_and_text_lengths_reject_before_reserving() {
        for major in [2u8, 3] {
            let mut bytes = vec![(major << 5) | 27];
            bytes.extend_from_slice(&u64::MAX.to_be_bytes());
            assert!(matches!(
                decode(&bytes),
                Err(CborError::UnexpectedEnd | CborError::TooLong)
            ));
        }
        assert_eq!(decode(&[0x43, 1]), Err(CborError::UnexpectedEnd));
        assert_eq!(decode(&[0x63, b'a']), Err(CborError::UnexpectedEnd));
        assert_eq!(decode(&[0x61, 0xff]), Err(CborError::Utf8));
    }

    fn rt(v: Cbor) {
        let b = encode(&v).unwrap();
        assert_eq!(decode(&b).unwrap(), v);
    }

    #[test]
    fn integers_are_shortest_form() {
        assert_eq!(encode(&Cbor::Uint(23)).unwrap(), [0x17]);
        assert_eq!(encode(&Cbor::Uint(24)).unwrap(), [0x18, 24]);
        assert_eq!(encode(&Cbor::Uint(256)).unwrap(), [0x19, 1, 0]);
        assert_eq!(encode(&Cbor::int(-1)).unwrap(), [0x20]);
        assert_eq!(encode(&Cbor::int(i64::MIN)).unwrap()[0], 0x3b);
        for v in [
            0,
            23,
            24,
            255,
            256,
            65535,
            65536,
            u64::from(u32::MAX),
            u64::MAX,
        ] {
            rt(Cbor::Uint(v));
        }
        rt(Cbor::int(i64::MIN));
        assert_eq!(Cbor::int(i64::MIN).as_i64(), Some(i64::MIN));
    }

    #[test]
    fn rejects_non_shortest_heads() {
        assert_eq!(decode(&[0x18, 0x05]), Err(CborError::NonCanonicalHead));
        assert_eq!(
            decode(&[0x19, 0x00, 0xff]),
            Err(CborError::NonCanonicalHead)
        );
        assert_eq!(
            decode(&[0x1a, 0, 0, 0xff, 0xff]),
            Err(CborError::NonCanonicalHead)
        );
        assert_eq!(
            decode(&[0x1b, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff]),
            Err(CborError::NonCanonicalHead)
        );
        assert_eq!(
            decode(&[0x58, 0x01, 0xaa]),
            Err(CborError::NonCanonicalHead)
        );
    }

    #[test]
    fn floats_are_binary64_and_finite() {
        assert_eq!(
            encode(&Cbor::Float(1.5)).unwrap(),
            [0xfb, 0x3f, 0xf8, 0, 0, 0, 0, 0, 0]
        );
        rt(Cbor::Float(-0.0));
        assert_eq!(decode(&[0xf9, 0x3e, 0x00]), Err(CborError::Float));
        assert_eq!(decode(&[0xfa, 0x3f, 0xc0, 0, 0]), Err(CborError::Float));
        assert_eq!(
            decode(&[0xfb, 0x7f, 0xf8, 0, 0, 0, 0, 0, 0]),
            Err(CborError::Float)
        );
        assert_eq!(encode(&Cbor::Float(f64::INFINITY)), Err(CborError::Float));
    }

    #[test]
    fn rejects_tags_simple_indefinite_trailing() {
        assert_eq!(decode(&[0xc1, 0x00]), Err(CborError::Tag));
        assert_eq!(decode(&[0xf7]), Err(CborError::Simple));
        assert_eq!(decode(&[0x9f, 0xff]), Err(CborError::Indefinite));
        assert_eq!(decode(&[0x00, 0x00]), Err(CborError::TrailingBytes));
        assert_eq!(decode(&[0x62, 0xff, 0xfe]), Err(CborError::Utf8));
        assert_eq!(
            decode(&[0x5a, 0xff, 0xff, 0xff, 0xff]),
            Err(CborError::UnexpectedEnd)
        );
    }

    #[test]
    fn map_rules() {
        // struct map: ascending uint keys
        rt(Cbor::Map(vec![
            (Cbor::Uint(0), Cbor::Null),
            (Cbor::Uint(5), Cbor::Null),
        ]));
        assert_eq!(
            decode(&[0xa2, 0x01, 0xf6, 0x00, 0xf6]),
            Err(CborError::UnsortedKeys)
        );
        assert_eq!(
            decode(&[0xa2, 0x01, 0xf6, 0x01, 0xf6]),
            Err(CborError::UnsortedKeys)
        );
        // data map: text keys in data order, distinct
        rt(Cbor::Map(vec![
            (Cbor::Text("b".into()), Cbor::Null),
            (Cbor::Text("a".into()), Cbor::Null),
        ]));
        assert_eq!(
            decode(&[0xa2, 0x61, 0x61, 0xf6, 0x61, 0x61, 0xf6]),
            Err(CborError::DuplicateKey)
        );
        // mixed
        assert_eq!(
            decode(&[0xa2, 0x00, 0xf6, 0x61, 0x61, 0xf6]),
            Err(CborError::MixedMapKeys)
        );
        assert_eq!(decode(&[0xa1, 0x20, 0xf6]), Err(CborError::MixedMapKeys));
        rt(Cbor::Map(vec![]));
    }

    fn secret(marker: u8) -> Vec<u8> {
        [vec![0x58, 0x20], vec![marker; 32]].concat()
    }

    fn cleanup_case(input: &[u8], error: CborError, copies: usize) {
        let mut decoder = Decoder::new(input);
        assert_eq!(decoder.complete(), Err(error));
        let trace = decoder.cleanup_trace;
        assert_eq!(trace.iter().filter(|(len, _)| *len == 32).count(), copies);
        assert!(
            trace.iter().all(|(_, zero)| *zero),
            "owned copies erased before drop"
        );
    }

    #[test]
    fn trailing_error_erases_completed_secret_tree_before_drop() {
        let input = [vec![0xa2, 0], secret(41), vec![1], secret(42), vec![0]].concat();
        cleanup_case(&input, CborError::TrailingBytes, 2);
        assert!(
            input.windows(32).any(|b| b == [41; 32]),
            "borrowed input remains caller-owned"
        );
    }

    #[test]
    fn partial_containers_and_pending_map_key_are_erased() {
        cleanup_case(
            &[vec![0x82], secret(41), vec![0xf7]].concat(),
            CborError::Simple,
            1,
        );
        cleanup_case(
            &[vec![0xa2, 0], secret(41), vec![0xf7]].concat(),
            CborError::Simple,
            1,
        );
        cleanup_case(
            &[vec![0xa2, 0], secret(41), vec![1]].concat(),
            CborError::UnexpectedEnd,
            1,
        );
        cleanup_case(
            &[vec![0xa1], secret(42), vec![0xf7]].concat(),
            CborError::Simple,
            1,
        );
    }

    #[test]
    fn map_rule_errors_erase_values_and_illegal_byte_keys() {
        cleanup_case(
            &[vec![0xa2, 1], secret(41), vec![0], secret(42)].concat(),
            CborError::UnsortedKeys,
            2,
        );
        cleanup_case(
            &[vec![0xa2, 0], secret(41), vec![0x61, b'a'], secret(42)].concat(),
            CborError::MixedMapKeys,
            2,
        );
        cleanup_case(
            &[
                vec![0xa2, 0x61, b'a'],
                secret(41),
                vec![0x61, b'a'],
                secret(42),
            ]
            .concat(),
            CborError::DuplicateKey,
            2,
        );
        cleanup_case(
            &[vec![0xa1], secret(41), secret(42)].concat(),
            CborError::MixedMapKeys,
            2,
        );
    }

    #[test]
    fn depth_error_erases_already_decoded_secret_siblings() {
        let input = [vec![0x82], secret(41), vec![0x81; MAX_DEPTH + 2], vec![0]].concat();
        cleanup_case(&input, CborError::TooDeep, 1);
    }

    #[test]
    fn successful_decode_preserves_owned_bytes_without_error_cleanup() {
        let input = secret(41);
        let mut decoder = Decoder::new(&input);
        assert_eq!(decoder.complete(), Ok(Cbor::Bytes(vec![41; 32])));
        assert!(decoder.cleanup_trace.is_empty());
    }

    #[test]
    fn depth_is_bounded() {
        let mut b = vec![0x81; MAX_DEPTH + 2];
        b.push(0x00);
        assert_eq!(decode(&b), Err(CborError::TooDeep));
    }
}
