//! Plain scalar resolution: the YAML 1.2 core schema, restricted to the JSON
//! data model.
//!
//! | Plain text | Value |
//! |---|---|
//! | empty, `~`, `null`, `Null`, `NULL` | null |
//! | `true`, `True`, `TRUE`, `false`, `False`, `FALSE` | boolean |
//! | `[-+]?[0-9]+`, `0o[0-7]+`, `0x[0-9a-fA-F]+` | integer (a float when it does not fit `i64`) |
//! | `[-+]?(\.[0-9]+\|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?` | float |
//! | anything else | string |
//!
//! `.inf`, `.nan` and decimal numbers whose value is not a finite `f64` resolve
//! to the string as written: they are outside the JSON data model (spec 03).
//! YAML 1.1 forms (`yes`, `on`, `0777`, `1_000`, `1:20`, timestamps) are
//! strings, as in YAML 1.2.

use crate::value::Value;

/// Resolve the text of a plain scalar.
pub fn resolve_plain(text: &str) -> Value {
    match text {
        "" | "~" | "null" | "Null" | "NULL" => return Value::Null,
        "true" | "True" | "TRUE" => return Value::Bool(true),
        "false" | "False" | "FALSE" => return Value::Bool(false),
        _ => {}
    }
    if let Some(v) = resolve_int(text) {
        return v;
    }
    if is_core_float(text) {
        // `str::parse::<f64>` is correctly rounded, so this is deterministic.
        if let Some(v) = text.parse::<f64>().ok().and_then(Value::float) {
            return v;
        }
    }
    Value::Text(text.to_owned())
}

/// Whether `text` would resolve to something other than a string.
pub fn is_non_string_plain(text: &str) -> bool {
    !matches!(resolve_plain(text), Value::Text(_)) || is_core_float(text) || is_core_int(text)
}

fn resolve_int(text: &str) -> Option<Value> {
    if let Some(oct) = text.strip_prefix("0o") {
        if !oct.is_empty() && oct.bytes().all(|b| (b'0'..=b'7').contains(&b)) {
            return Some(
                i64::from_str_radix(oct, 8)
                    .map_or_else(|_| Value::Text(text.to_owned()), Value::int),
            );
        }
        return None;
    }
    if let Some(hex) = text.strip_prefix("0x") {
        if !hex.is_empty() && hex.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Some(
                i64::from_str_radix(hex, 16)
                    .map_or_else(|_| Value::Text(text.to_owned()), Value::int),
            );
        }
        return None;
    }
    if !is_decimal_int(text) {
        return None;
    }
    Some(match text.parse::<i64>() {
        Ok(i) => Value::int(i),
        // Too large for i64: the nearest float, if finite.
        Err(_) => text
            .parse::<f64>()
            .ok()
            .and_then(Value::float)
            .unwrap_or_else(|| Value::Text(text.to_owned())),
    })
}

fn is_decimal_int(text: &str) -> bool {
    let digits = text.strip_prefix(['-', '+']).unwrap_or(text);
    !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
}

fn is_core_int(text: &str) -> bool {
    is_decimal_int(text)
        || text
            .strip_prefix("0o")
            .is_some_and(|o| !o.is_empty() && o.bytes().all(|b| (b'0'..=b'7').contains(&b)))
        || text
            .strip_prefix("0x")
            .is_some_and(|h| !h.is_empty() && h.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// `[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?`, or the special floats.
pub(crate) fn is_core_float(text: &str) -> bool {
    let unsigned = text.strip_prefix(['-', '+']).unwrap_or(text);
    if matches!(unsigned, ".inf" | ".Inf" | ".INF") || matches!(text, ".nan" | ".NaN" | ".NAN") {
        return true;
    }
    let b = unsigned.as_bytes();
    let mut i = 0;
    let int_digits = b.iter().take_while(|c| c.is_ascii_digit()).count();
    i += int_digits;
    if b.get(i) == Some(&b'.') {
        i += 1;
        let frac_digits = b[i..].iter().take_while(|c| c.is_ascii_digit()).count();
        i += frac_digits;
        if int_digits == 0 && frac_digits == 0 {
            return false;
        }
    } else if int_digits == 0 {
        return false;
    }
    if matches!(b.get(i), Some(b'e' | b'E')) {
        i += 1;
        if matches!(b.get(i), Some(b'-' | b'+')) {
            i += 1;
        }
        let exp = b[i..].iter().take_while(|c| c.is_ascii_digit()).count();
        if exp == 0 {
            return false;
        }
        i += exp;
    }
    i == b.len()
}

/// Whether a plain scalar `text` would be read differently by a YAML 1.1 tool
/// (PyYAML's safe loader, older libraries): booleans like `yes`/`on`, `<<`,
/// sexagesimal and underscored numbers, binary and old-style octal integers,
/// and timestamps. The writer quotes such strings when it has no style to keep,
/// so other tools read the same string.
pub(crate) fn is_yaml11_ambiguous(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    if matches!(
        lower.as_str(),
        "yes" | "no" | "on" | "off" | "<<" | "=" | ".inf" | "-.inf" | "+.inf" | ".nan"
    ) {
        return true;
    }
    // Number- and date-like text: starts with a digit, sign or dot and uses
    // only characters that appear in YAML 1.1 numbers and timestamps.
    let first = text.as_bytes().first().copied();
    matches!(first, Some(b'0'..=b'9' | b'-' | b'+' | b'.'))
        && text.len() > 1
        && text.bytes().any(|c| c.is_ascii_digit())
        && text.bytes().all(|c| {
            c.is_ascii_hexdigit()
                || matches!(
                    c,
                    b'_' | b':'
                        | b'.'
                        | b'-'
                        | b'+'
                        | b' '
                        | b'x'
                        | b'X'
                        | b'o'
                        | b'O'
                        | b'b'
                        | b'B'
                        | b't'
                        | b'T'
                        | b'z'
                        | b'Z'
                )
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn core_schema() {
        assert_eq!(resolve_plain(""), Value::Null);
        assert_eq!(resolve_plain("~"), Value::Null);
        assert_eq!(resolve_plain("True"), Value::Bool(true));
        assert_eq!(resolve_plain("yes"), Value::string("yes"));
        assert_eq!(resolve_plain("42"), Value::int(42));
        assert_eq!(resolve_plain("-7"), Value::int(-7));
        assert_eq!(resolve_plain("0o17"), Value::int(15));
        assert_eq!(resolve_plain("0x1F"), Value::int(31));
        assert_eq!(resolve_plain("0777"), Value::int(777));
        assert_eq!(resolve_plain("1_000"), Value::string("1_000"));
        assert_eq!(resolve_plain("1.5"), Value::Float(1.5));
        assert_eq!(resolve_plain("1e3"), Value::Float(1000.0));
        assert_eq!(resolve_plain(".5"), Value::Float(0.5));
        assert_eq!(resolve_plain("1."), Value::Float(1.0));
        assert_eq!(resolve_plain("."), Value::string("."));
        assert_eq!(resolve_plain("1e"), Value::string("1e"));
        assert_eq!(resolve_plain(".inf"), Value::string(".inf"));
        assert_eq!(resolve_plain("1e999"), Value::string("1e999"));
        assert_eq!(
            resolve_plain("2026-10-01T00:00:00Z"),
            Value::string("2026-10-01T00:00:00Z")
        );
        assert_eq!(resolve_plain("99999999999999999999"), Value::Float(1e20));
        assert_eq!(resolve_plain("inf"), Value::string("inf"));
        assert_eq!(resolve_plain("NaN"), Value::string("NaN"));
    }

    #[test]
    fn yaml11_ambiguity() {
        for s in [
            "yes",
            "No",
            "ON",
            "2026-10-01",
            "1:20",
            "1_000",
            "0b101",
            "<<",
            "+1",
        ] {
            assert!(is_yaml11_ambiguous(s), "{s}");
        }
        for s in ["hello", "a1", "x-2", "-", "2026 report draft", "y", "n"] {
            assert!(!is_yaml11_ambiguous(s), "{s}");
        }
    }
}
