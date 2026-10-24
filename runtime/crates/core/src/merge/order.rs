//! The value ordering behind the `max` and `min` strategies (spec 12A):
//!
//! - two numbers by numeric value;
//! - two RFC 3339 date-times with an offset, as instants;
//! - two RFC 3339 `full-date`s, in calendar order;
//! - any other two strings, in Unicode code-point order;
//! - anything else is incomparable.
//!
//! Date arithmetic is integer-only (days from the civil calendar), so it is the
//! same on every platform.

use std::cmp::Ordering;

use crate::value::Value;

/// Compare two values for `max`/`min`; `None` when they are incomparable.
pub fn compare(a: &Value, b: &Value) -> Option<Ordering> {
    if let (Some(x), Some(y)) = (a.as_number(), b.as_number()) {
        return Some(x.cmp_numeric(y));
    }
    let (Value::Text(x), Value::Text(y)) = (a, b) else {
        return None;
    };
    if let (Some(p), Some(q)) = (instant(x), instant(y)) {
        return Some(p.cmp(&q));
    }
    if let (Some(p), Some(q)) = (full_date(x), full_date(y)) {
        return Some(p.cmp(&q));
    }
    Some(x.as_str().cmp(y.as_str()))
}

/// An instant: seconds since the epoch, then the fraction's digits padded to
/// nanoseconds and beyond (compared as text of equal length).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct Moment {
    secs: i64,
    frac: String,
}

fn digits(s: &str, n: usize) -> Option<i64> {
    (s.len() == n && s.bytes().all(|b| b.is_ascii_digit())).then(|| s.parse().ok())?
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

fn days_in_month(y: i64, m: i64) -> i64 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ if is_leap(y) => 29,
        _ => 28,
    }
}

/// Days since 1970-01-01 (proleptic Gregorian; H. Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// `YYYY-MM-DD` with a valid calendar day: `(year, month, day)`.
pub(crate) fn full_date(s: &str) -> Option<(i64, i64, i64)> {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let (y, m, d) = (
        digits(&s[0..4], 4)?,
        digits(&s[5..7], 2)?,
        digits(&s[8..10], 2)?,
    );
    ((1..=12).contains(&m) && (1..=days_in_month(y, m)).contains(&d)).then_some((y, m, d))
}

/// An RFC 3339 `date-time` with an offset (`Z` or `±HH:MM`), as an instant.
pub(crate) fn instant(s: &str) -> Option<Moment> {
    if s.len() < 20 || !s.is_ascii() {
        return None;
    }
    let (y, m, d) = full_date(&s[..10])?;
    if !matches!(s.as_bytes()[10], b'T' | b't') {
        return None;
    }
    let t = &s[11..];
    let b = t.as_bytes();
    if b.len() < 9 || b[2] != b':' || b[5] != b':' {
        return None;
    }
    let (hh, mm, ss) = (
        digits(&t[0..2], 2)?,
        digits(&t[3..5], 2)?,
        digits(&t[6..8], 2)?,
    );
    if hh > 23 || mm > 59 || ss > 60 {
        return None;
    }
    let mut rest = &t[8..];
    let mut frac = String::new();
    if let Some(f) = rest.strip_prefix('.') {
        let n = f.bytes().take_while(u8::is_ascii_digit).count();
        if n == 0 {
            return None;
        }
        frac.push_str(&f[..n]);
        rest = &f[n..];
    }
    let offset_secs = match rest {
        "Z" | "z" => 0,
        o if o.len() == 6 && matches!(o.as_bytes()[0], b'+' | b'-') && o.as_bytes()[3] == b':' => {
            let (oh, om) = (digits(&o[1..3], 2)?, digits(&o[4..6], 2)?);
            if oh > 23 || om > 59 {
                return None;
            }
            let v = oh * 3600 + om * 60;
            if o.starts_with('-') { -v } else { v }
        }
        _ => return None,
    };
    let secs = days_from_civil(y, m, d) * 86_400 + hh * 3600 + mm * 60 + ss - offset_secs;
    // Pad fractions so equal-length text compares numerically.
    let frac = format!("{:0<30}", frac.trim_end_matches('0'));
    Some(Moment { secs, frac })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instants() {
        let a = instant("2026-10-02T09:00:00+10:00").unwrap();
        let b = instant("2026-10-01T23:30:00Z").unwrap();
        assert!(a < b);
        assert_eq!(
            instant("2026-10-01T00:00:00Z"),
            instant("2026-10-01T10:00:00+10:00")
        );
        assert_eq!(
            instant("2026-10-01T00:00:00.5Z"),
            instant("2026-10-01T00:00:00.500Z")
        );
        assert!(instant("2026-10-01T00:00:00.5Z") > instant("2026-10-01T00:00:00.49999Z"));
        assert_eq!(instant("1970-01-01T00:00:00Z").unwrap().secs, 0);
        assert_eq!(instant("2000-03-01T00:00:00Z").unwrap().secs, 951_868_800);
        for bad in [
            "2026-10-01T00:00:00",
            "2026-02-30T00:00:00Z",
            "2026-10-01 00:00:00Z",
            "2026-10-01T24:00:00Z",
            "2026-10-01T00:00:00.Z",
            "2026-10-01T00:00:00+1000",
        ] {
            assert!(instant(bad).is_none(), "{bad}");
        }
        assert!(full_date("2024-02-29").is_some() && full_date("2025-02-29").is_none());
    }

    #[test]
    fn ordering() {
        let s = Value::string;
        assert_eq!(
            compare(&Value::int(2), &Value::Float(1.5)),
            Some(Ordering::Greater)
        );
        assert_eq!(
            compare(&s("2026-10-05"), &s("2026-10-04")),
            Some(Ordering::Greater)
        );
        assert_eq!(compare(&s("b"), &s("a")), Some(Ordering::Greater));
        assert_eq!(
            compare(&s("2026-10-01"), &s("2026-10-01T00:00:00Z")),
            Some(Ordering::Less)
        );
        assert_eq!(compare(&Value::int(1), &s("1")), None);
        assert_eq!(compare(&Value::Null, &Value::int(1)), None);
        assert_eq!(compare(&Value::Bool(true), &Value::Bool(false)), None);
    }
}
