//! Human-readable renderings of wire values (`docs/contracts/00-overview.md` §8):
//!
//! - [`diag`]: RFC 8949 §8 diagnostic notation of a raw item;
//! - [`annotated`]: diagnostic notation with field and variant names as `/ comments /`
//!   (EDN, RFC 8610 Appendix G), the `.diag` fixture format;
//! - [`json`]: a JSON debug view with field names, hex byte strings and data maps
//!   as arrays of pairs, the `.json` fixture format.

use std::fmt::Write as _;

use crate::cbor::Cbor;
use crate::schema::Ann;

/// Lowercase hexadecimal.
pub fn hex(b: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(b.len() * 2);
    for x in b {
        s.push(DIGITS[usize::from(x >> 4)] as char);
        s.push(DIGITS[usize::from(x & 0xf)] as char);
    }
    s
}

fn quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
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
    out
}

fn float(f: f64) -> String {
    // Rust's shortest round-trip formatting; always shows a decimal point or exponent.
    let s = format!("{f:?}");
    if s.contains('.') || s.contains('e') || s.contains("inf") || s.contains("NaN") {
        s
    } else {
        format!("{s}.0")
    }
}

fn nint(n: u64) -> String {
    format!("-{}", u128::from(n) + 1)
}

/// RFC 8949 diagnostic notation of a raw item, on one line.
pub fn diag(c: &Cbor) -> String {
    match c {
        Cbor::Uint(n) => n.to_string(),
        Cbor::Nint(n) => nint(*n),
        Cbor::Bytes(b) => format!("h'{}'", hex(b)),
        Cbor::Text(s) => quote(s),
        Cbor::Array(a) => format!("[{}]", a.iter().map(diag).collect::<Vec<_>>().join(", ")),
        Cbor::Map(m) => format!(
            "{{{}}}",
            m.iter()
                .map(|(k, v)| format!("{}: {}", diag(k), diag(v)))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        Cbor::Bool(b) => b.to_string(),
        Cbor::Null => "null".into(),
        Cbor::Float(f) => float(*f),
    }
}

fn pad(n: usize) -> String {
    "  ".repeat(n)
}

/// Annotated diagnostic notation, indented, with `/ name /` comments.
pub fn annotated(a: &Ann) -> String {
    let mut s = String::new();
    ann_into(a, 0, &mut s);
    s.push('\n');
    s
}

fn ann_into(a: &Ann, ind: usize, s: &mut String) {
    match a {
        Ann::Leaf(c) => s.push_str(&diag(c)),
        Ann::Enum(name, v) => {
            let _ = write!(s, "{v} / {name} /");
        }
        Ann::Struct(name, fields) => {
            let _ = writeln!(s, "/ {name} / {{");
            for (i, (k, fname, v)) in fields.iter().enumerate() {
                let _ = write!(s, "{}/ {fname} / {k}: ", pad(ind + 1));
                ann_into(v, ind + 1, s);
                s.push_str(if i + 1 < fields.len() { ",\n" } else { "\n" });
            }
            let _ = write!(s, "{}}}", pad(ind));
        }
        Ann::Tuple(name, elems) => {
            let _ = write!(s, "/ {name} / [");
            for (i, (ename, v)) in elems.iter().enumerate() {
                let _ = write!(s, "/ {ename} / ");
                ann_into(v, ind, s);
                if i + 1 < elems.len() {
                    s.push_str(", ");
                }
            }
            s.push(']');
        }
        Ann::Array(items) => {
            if items.is_empty() {
                s.push_str("[]");
                return;
            }
            s.push_str("[\n");
            for (i, v) in items.iter().enumerate() {
                s.push_str(&pad(ind + 1));
                ann_into(v, ind + 1, s);
                s.push_str(if i + 1 < items.len() { ",\n" } else { "\n" });
            }
            let _ = write!(s, "{}]", pad(ind));
        }
        Ann::DataMap(entries) => {
            if entries.is_empty() {
                s.push_str("{}");
                return;
            }
            s.push_str("{\n");
            for (i, (k, v)) in entries.iter().enumerate() {
                let _ = write!(s, "{}{}: ", pad(ind + 1), quote(k));
                ann_into(v, ind + 1, s);
                s.push_str(if i + 1 < entries.len() { ",\n" } else { "\n" });
            }
            let _ = write!(s, "{}}}", pad(ind));
        }
    }
}

/// JSON debug view. Not a wire format: it exists so fixtures can be read and
/// diffed. Integers beyond ±2^53 are strings; byte strings are `"h'…'"`; data maps
/// are `[[key, value], …]`; struct maps use field names.
pub fn json(a: &Ann) -> String {
    let mut s = String::new();
    json_into(a, 0, &mut s);
    s.push('\n');
    s
}

fn json_leaf(c: &Cbor) -> String {
    const SAFE: u64 = 1 << 53;
    match c {
        Cbor::Uint(n) if *n <= SAFE => n.to_string(),
        Cbor::Uint(n) => quote(&n.to_string()),
        Cbor::Nint(n) if *n < SAFE => nint(*n),
        Cbor::Nint(n) => quote(&nint(*n)),
        Cbor::Bytes(b) => quote(&format!("h'{}'", hex(b))),
        Cbor::Text(t) => quote(t),
        Cbor::Bool(b) => b.to_string(),
        Cbor::Null => "null".into(),
        Cbor::Float(f) => float(*f),
        Cbor::Array(items) => format!(
            "[{}]",
            items.iter().map(json_leaf).collect::<Vec<_>>().join(", ")
        ),
        Cbor::Map(m) => format!(
            "[{}]",
            m.iter()
                .map(|(k, v)| format!("[{}, {}]", json_leaf(k), json_leaf(v)))
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}

fn json_into(a: &Ann, ind: usize, s: &mut String) {
    match a {
        Ann::Leaf(c) => s.push_str(&json_leaf(c)),
        Ann::Enum(name, _) => s.push_str(&quote(name)),
        Ann::Struct(name, fields) => {
            let _ = writeln!(s, "{{");
            let _ = write!(s, "{}\"_type\": {}", pad(ind + 1), quote(name));
            for (_, fname, v) in fields {
                let _ = write!(s, ",\n{}{}: ", pad(ind + 1), quote(fname));
                json_into(v, ind + 1, s);
            }
            let _ = write!(s, "\n{}}}", pad(ind));
        }
        Ann::Tuple(name, elems) => {
            let _ = write!(s, "{{\"_type\": {}", quote(name));
            for (ename, v) in elems {
                let _ = write!(s, ", {}: ", quote(ename));
                json_into(v, ind, s);
            }
            s.push('}');
        }
        Ann::Array(items) => {
            if items.is_empty() {
                s.push_str("[]");
                return;
            }
            s.push_str("[\n");
            for (i, v) in items.iter().enumerate() {
                s.push_str(&pad(ind + 1));
                json_into(v, ind + 1, s);
                s.push_str(if i + 1 < items.len() { ",\n" } else { "\n" });
            }
            let _ = write!(s, "{}]", pad(ind));
        }
        Ann::DataMap(entries) => {
            if entries.is_empty() {
                s.push_str("[]");
                return;
            }
            s.push_str("[\n");
            for (i, (k, v)) in entries.iter().enumerate() {
                let _ = write!(s, "{}[{}, ", pad(ind + 1), quote(k));
                json_into(v, ind + 1, s);
                s.push(']');
                s.push_str(if i + 1 < entries.len() { ",\n" } else { "\n" });
            }
            let _ = write!(s, "{}]", pad(ind));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diag_forms() {
        assert_eq!(diag(&Cbor::Nint(0)), "-1");
        assert_eq!(diag(&Cbor::Nint(u64::MAX)), "-18446744073709551616");
        assert_eq!(diag(&Cbor::Float(1.0)), "1.0");
        assert_eq!(diag(&Cbor::Bytes(vec![0, 255])), "h'00ff'");
        assert_eq!(diag(&Cbor::Text("a\"\n".into())), "\"a\\\"\\n\"");
    }
}
