//! Temporal values for CEL (spec 10 "Temporal Values"): timestamps,
//! durations, calendar dates as strings, and time-zone rules.
//!
//! All arithmetic is integer-only (seconds and nanoseconds; days from the
//! proleptic Gregorian calendar), so results are the same on every platform.
//!
//! **Time zones.** Converting an instant to a local date or time needs zone
//! rules, which come from a tzdb release pinned by the semantics version
//! (`docs/contracts/intent.md` §4.1, Q6). [`NamedZone`] reads the embedded
//! IANA release from [`tzdb`]; [`Utc`] and [`FixedOffset`] are also built in.
//! [`Tzif`] reads standard TZif files for hosts and test oracles, but production
//! named-zone evaluation never reads the OS database.

pub mod tzdb;
pub use tzdb::NamedZone;

use std::fmt::Write as _;

/// The smallest supported timestamp: 0001-01-01T00:00:00Z (CEL's range).
pub const MIN_SECONDS: i64 = -62_135_596_800;
/// The largest supported timestamp second: 9999-12-31T23:59:59Z.
pub const MAX_SECONDS: i64 = 253_402_300_799;
/// CEL's duration range: about ±10,000 years, in seconds.
pub const MAX_DURATION_SECONDS: i64 = 315_576_000_000;

/// An instant (`google.protobuf.Timestamp`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Timestamp {
    /// Seconds since 1970-01-01T00:00:00Z.
    pub seconds: i64,
    /// Nanoseconds, 0..1e9.
    pub nanos: u32,
}

/// A signed span (`google.protobuf.Duration`), stored as total nanoseconds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Duration {
    /// Total nanoseconds.
    pub nanos: i128,
}

/// A temporal error (an evaluation error in CEL).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TimeError(pub String);

fn terr<T>(m: impl Into<String>) -> Result<T, TimeError> {
    Err(TimeError(m.into()))
}

const NANOS: i128 = 1_000_000_000;

impl Timestamp {
    /// A timestamp from Unix milliseconds (the intent's `time-ms`).
    pub fn from_millis(ms: i64) -> Result<Timestamp, TimeError> {
        Timestamp::checked(
            ms.div_euclid(1000),
            u32::try_from(ms.rem_euclid(1000) * 1_000_000).unwrap_or(0),
        )
    }

    /// A whole-second timestamp, range-checked.
    pub fn checked_seconds(seconds: i64) -> Result<Timestamp, TimeError> {
        Timestamp::checked(seconds, 0)
    }

    fn checked(seconds: i64, nanos: u32) -> Result<Timestamp, TimeError> {
        if !(MIN_SECONDS..=MAX_SECONDS).contains(&seconds) || nanos >= 1_000_000_000 {
            return terr("timestamp out of range");
        }
        Ok(Timestamp { seconds, nanos })
    }

    fn total_nanos(self) -> i128 {
        i128::from(self.seconds) * NANOS + i128::from(self.nanos)
    }

    fn from_total(n: i128) -> Result<Timestamp, TimeError> {
        let s = n.div_euclid(NANOS);
        let ns = n.rem_euclid(NANOS);
        let s = i64::try_from(s).map_err(|_| TimeError("timestamp out of range".into()))?;
        Timestamp::checked(s, u32::try_from(ns).unwrap_or(0))
    }

    /// `self + d`.
    pub fn checked_add(self, d: Duration) -> Result<Timestamp, TimeError> {
        Timestamp::from_total(self.total_nanos() + d.nanos)
    }

    /// `self - other`.
    pub fn since(self, other: Timestamp) -> Result<Duration, TimeError> {
        Duration::checked(self.total_nanos() - other.total_nanos())
    }

    /// Parse an RFC 3339 date-time with an offset (`Z` or `±HH:MM`).
    pub fn parse(s: &str) -> Result<Timestamp, TimeError> {
        let bad = || TimeError(format!("invalid timestamp {s:?}"));
        if !s.is_ascii() || s.len() < 20 {
            return Err(bad());
        }
        let (y, mo, d) = parse_date(&s[..10]).ok_or_else(bad)?;
        if !matches!(s.as_bytes()[10], b'T' | b't') {
            return Err(bad());
        }
        let t = &s[11..];
        let b = t.as_bytes();
        if b.len() < 9 || b[2] != b':' || b[5] != b':' {
            return Err(bad());
        }
        let (hh, mm, ss) = (
            num(&t[0..2]).ok_or_else(bad)?,
            num(&t[3..5]).ok_or_else(bad)?,
            num(&t[6..8]).ok_or_else(bad)?,
        );
        // CEL timestamps have no leap seconds.
        if hh > 23 || mm > 59 || ss > 59 {
            return Err(bad());
        }
        let mut rest = &t[8..];
        let mut nanos = 0u32;
        if let Some(f) = rest.strip_prefix('.') {
            let n = f.bytes().take_while(u8::is_ascii_digit).count();
            if n == 0 || n > 9 {
                return Err(bad());
            }
            let digits = format!("{:0<9}", &f[..n]);
            nanos = digits.parse().map_err(|_| bad())?;
            rest = &f[n..];
        }
        let off = match rest {
            "Z" | "z" => 0,
            o if o.len() == 6
                && matches!(o.as_bytes()[0], b'+' | b'-')
                && o.as_bytes()[3] == b':' =>
            {
                let (oh, om) = (
                    num(&o[1..3]).ok_or_else(bad)?,
                    num(&o[4..6]).ok_or_else(bad)?,
                );
                if oh > 23 || om > 59 {
                    return Err(bad());
                }
                let v = oh * 3600 + om * 60;
                if o.starts_with('-') { -v } else { v }
            }
            _ => return Err(bad()),
        };
        let secs = days_from_civil(y, mo, d) * 86_400 + hh * 3600 + mm * 60 + ss - off;
        Timestamp::checked(secs, nanos)
    }

    /// RFC 3339 in UTC with `Z`, fractional seconds only as needed (CEL's
    /// `string(timestamp)`).
    pub fn to_rfc3339(self) -> String {
        let (date, secs_of_day) = (
            self.seconds.div_euclid(86_400),
            self.seconds.rem_euclid(86_400),
        );
        let (y, m, d) = civil_from_days(date);
        let mut s = format!(
            "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}",
            secs_of_day / 3600,
            secs_of_day / 60 % 60,
            secs_of_day % 60
        );
        if self.nanos != 0 {
            // Fraction digits as needed, as Go's RFC3339Nano (cel-go) writes them.
            let f = format!("{:09}", self.nanos);
            let _ = write!(s, ".{}", f.trim_end_matches('0'));
        }
        s.push('Z');
        s
    }
}

impl Duration {
    fn checked(nanos: i128) -> Result<Duration, TimeError> {
        if nanos.abs() > i128::from(MAX_DURATION_SECONDS) * NANOS {
            return terr("duration out of range");
        }
        Ok(Duration { nanos })
    }

    /// `self + other`.
    pub fn checked_add(self, other: Duration) -> Result<Duration, TimeError> {
        Duration::checked(self.nanos + other.nanos)
    }

    /// `-self`.
    pub fn negated(self) -> Duration {
        Duration { nanos: -self.nanos }
    }

    /// Whole seconds (truncated toward zero).
    pub fn seconds(self) -> i64 {
        i64::try_from(self.nanos / NANOS).unwrap_or(0)
    }

    /// Parse a CEL duration string with Go's `time.ParseDuration` grammar (as
    /// cel-go does): an optional sign and one or more decimal numbers, each with
    /// a unit `h`, `m`, `s`, `ms`, `us`/`µs`/`μs` or `ns` (`"36h"`, `"1.5h"`,
    /// `"-1h30m"`, `"1.h"`); `"0"` alone is zero.
    pub fn parse(s: &str) -> Result<Duration, TimeError> {
        let bad = || TimeError(format!("invalid duration {s:?}"));
        let (neg, mut rest) = match s.as_bytes().first() {
            Some(b'-') => (true, &s[1..]),
            Some(b'+') => (false, &s[1..]),
            _ => (false, s),
        };
        if rest == "0" {
            return Ok(Duration { nanos: 0 });
        }
        if rest.is_empty() {
            return Err(bad());
        }
        let mut total: i128 = 0;
        while !rest.is_empty() {
            let int_len = rest.bytes().take_while(u8::is_ascii_digit).count();
            let int_part = &rest[..int_len];
            rest = &rest[int_len..];
            let mut frac_part = "";
            if let Some(f) = rest.strip_prefix('.') {
                let n = f.bytes().take_while(u8::is_ascii_digit).count();
                frac_part = &f[..n];
                rest = &f[n..];
            }
            if int_part.is_empty() && frac_part.is_empty() {
                return Err(bad());
            }
            let unit_len = rest
                .char_indices()
                .find(|&(_, c)| c == '.' || c.is_ascii_digit())
                .map_or(rest.len(), |(i, _)| i);
            let unit: i128 = match &rest[..unit_len] {
                "h" => 3600 * NANOS,
                "m" => 60 * NANOS,
                "s" => NANOS,
                "ms" => 1_000_000,
                "us" | "\u{b5}s" | "\u{3bc}s" => 1_000,
                "ns" => 1,
                _ => return Err(bad()),
            };
            rest = &rest[unit_len..];
            let int: i128 = if int_part.is_empty() {
                0
            } else {
                int_part.parse().map_err(|_| bad())?
            };
            total = total
                .checked_add(int.checked_mul(unit).ok_or_else(bad)?)
                .ok_or_else(bad)?;
            // The fraction, exactly: digits × unit / 10^len, truncated.
            if !frac_part.is_empty() {
                let digits = &frac_part[..frac_part.len().min(18)];
                let num: i128 = digits.parse().map_err(|_| bad())?;
                let den = 10i128.pow(u32::try_from(digits.len()).unwrap_or(0));
                total = total.checked_add(num * unit / den).ok_or_else(bad)?;
            }
            if total > i128::from(MAX_DURATION_SECONDS) * NANOS {
                return Err(bad());
            }
        }
        Duration::checked(if neg { -total } else { total })
    }

    /// CEL's `string(duration)`: seconds with a fraction as needed (`"5400s"`,
    /// `"1.5s"`).
    pub fn to_cel_string(self) -> String {
        let sign = if self.nanos < 0 { "-" } else { "" };
        let a = self.nanos.abs();
        let (s, ns) = (a / NANOS, a % NANOS);
        if ns == 0 {
            return format!("{sign}{s}s");
        }
        let f = format!("{ns:09}");
        format!("{sign}{s}.{}s", f.trim_end_matches('0'))
    }
}

fn num(s: &str) -> Option<i64> {
    (!s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())).then(|| s.parse().ok())?
}

pub(crate) fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

pub(crate) fn days_in_month(y: i64, m: i64) -> i64 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ if is_leap(y) => 29,
        _ => 28,
    }
}

/// Days since 1970-01-01 (proleptic Gregorian).
pub(crate) fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The civil date of a day number.
pub(crate) fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// `YYYY-MM-DD` with a valid day.
pub(crate) fn parse_date(s: &str) -> Option<(i64, i64, i64)> {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let (y, m, d) = (num(&s[0..4])?, num(&s[5..7])?, num(&s[8..10])?);
    (y >= 1 && (1..=12).contains(&m) && (1..=days_in_month(y, m)).contains(&d)).then_some((y, m, d))
}

pub(crate) fn format_date(y: i64, m: i64, d: i64) -> String {
    format!("{y:04}-{m:02}-{d:02}")
}

/// A calendar date as a day number, from a `full-date` string.
pub(crate) fn date_days(s: &str) -> Result<i64, TimeError> {
    match parse_date(s) {
        Some((y, m, d)) => Ok(days_from_civil(y, m, d)),
        None => terr(format!("{s:?} is not a valid date (YYYY-MM-DD)")),
    }
}

/// The `full-date` of a day number, within years 1..=9999.
pub(crate) fn days_date(days: i64) -> Result<String, TimeError> {
    let (y, m, d) = civil_from_days(days);
    if !(1..=9999).contains(&y) {
        return terr("date out of range");
    }
    Ok(format_date(y, m, d))
}

/// `d.addMonths(n)`, clamped to the last day of the target month.
pub(crate) fn add_months(s: &str, n: i64) -> Result<String, TimeError> {
    let Some((y, m, d)) = parse_date(s) else {
        return terr(format!("{s:?} is not a valid date (YYYY-MM-DD)"));
    };
    let total = y
        .checked_mul(12)
        .and_then(|t| t.checked_add(m - 1))
        .and_then(|t| t.checked_add(n));
    let Some(total) = total else {
        return terr("date out of range");
    };
    let (ny, nm) = (total.div_euclid(12), total.rem_euclid(12) + 1);
    if !(1..=9999).contains(&ny) {
        return terr("date out of range");
    }
    Ok(format_date(ny, nm, d.min(days_in_month(ny, nm))))
}

/// Rules mapping instants to UTC offsets for one time zone.
pub trait TimeZoneRules: std::fmt::Debug + Send + Sync {
    /// The UTC offset, in seconds, in effect at `utc_seconds`.
    fn offset_at(&self, utc_seconds: i64) -> i32;
}

/// UTC.
#[derive(Debug, Clone, Copy)]
pub struct Utc;

impl TimeZoneRules for Utc {
    fn offset_at(&self, _: i64) -> i32 {
        0
    }
}

/// A fixed offset from UTC, in seconds.
#[derive(Debug, Clone, Copy)]
pub struct FixedOffset(pub i32);

impl TimeZoneRules for FixedOffset {
    fn offset_at(&self, _: i64) -> i32 {
        self.0
    }
}

/// The local calendar day number of `utc_seconds` under `tz`.
pub(crate) fn local_days(tz: &dyn TimeZoneRules, utc_seconds: i64) -> i64 {
    (utc_seconds + i64::from(tz.offset_at(utc_seconds))).div_euclid(86_400)
}

/// The first instant whose local date under `tz` is day number `days`.
///
/// When local midnight is skipped by a transition, that is the transition
/// instant; when it occurs twice, the earlier one.
pub(crate) fn start_of_local_day(tz: &dyn TimeZoneRules, days: i64) -> i64 {
    let l = days * 86_400;
    // Candidate offsets near that day.
    let mut best: Option<i64> = None;
    for probe in [l - 2 * 86_400, l - 86_400, l, l + 86_400, l + 2 * 86_400] {
        let off = i64::from(tz.offset_at(probe));
        let t = l - off;
        if t + i64::from(tz.offset_at(t)) == l {
            best = Some(best.map_or(t, |b| b.min(t)));
        }
    }
    if let Some(t) = best {
        return t;
    }
    // Midnight falls in a gap: the earliest instant with that local date is the
    // transition. Binary search the first instant at or after local midnight.
    let (mut lo, mut hi) = (l - 2 * 86_400, l + 2 * 86_400);
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        if mid + i64::from(tz.offset_at(mid)) >= l {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    lo
}

/// Zone rules read from a TZif file (RFC 8536), version 2 or later.
#[derive(Debug, Clone)]
pub struct Tzif {
    transitions: Vec<i64>,
    /// Offset index per transition.
    indices: Vec<u8>,
    /// UTC offsets of the local time types.
    offsets: Vec<i32>,
    /// Whether each type is daylight time.
    dst: Vec<bool>,
    /// The POSIX TZ footer, for instants after the last transition.
    footer: Option<PosixTz>,
}

impl Tzif {
    /// Parse a TZif file. Only the 64-bit (version 2+) data block is used.
    pub fn parse(data: &[u8]) -> Result<Tzif, TimeError> {
        let bad = || TimeError("invalid TZif data".into());
        let mut r = Reader { b: data, pos: 0 };
        let v1 = r.header().ok_or_else(bad)?;
        if v1.version < b'2' {
            return terr("TZif version 1 files are not supported");
        }
        // Skip the 32-bit block.
        let skip = v1.timecnt * 5
            + v1.typecnt * 6
            + v1.charcnt
            + v1.leapcnt * 8
            + v1.isstdcnt
            + v1.isutcnt;
        r.pos = r.pos.checked_add(skip).ok_or_else(bad)?;
        let h = r.header().ok_or_else(bad)?;
        let mut transitions = Vec::with_capacity(h.timecnt);
        for _ in 0..h.timecnt {
            transitions.push(r.i64().ok_or_else(bad)?);
        }
        let mut indices = Vec::with_capacity(h.timecnt);
        for _ in 0..h.timecnt {
            let i = r.u8().ok_or_else(bad)?;
            if usize::from(i) >= h.typecnt {
                return Err(bad());
            }
            indices.push(i);
        }
        let mut offsets = Vec::with_capacity(h.typecnt);
        let mut dst = Vec::with_capacity(h.typecnt);
        for _ in 0..h.typecnt {
            offsets.push(r.i32().ok_or_else(bad)?);
            dst.push(r.u8().ok_or_else(bad)? != 0);
            r.u8().ok_or_else(bad)?;
        }
        if offsets.is_empty() || transitions.windows(2).any(|w| w[0] >= w[1]) {
            return Err(bad());
        }
        r.pos = r
            .pos
            .checked_add(h.charcnt + h.leapcnt * 12 + h.isstdcnt + h.isutcnt)
            .ok_or_else(bad)?;
        // Footer: "\n<TZ string>\n".
        let rest = data.get(r.pos..).ok_or_else(bad)?;
        let footer = match rest {
            [b'\n', body @ ..] => {
                let end = body.iter().position(|&c| c == b'\n').ok_or_else(bad)?;
                let s = std::str::from_utf8(&body[..end]).map_err(|_| bad())?;
                if s.is_empty() {
                    None
                } else {
                    Some(PosixTz::parse(s)?)
                }
            }
            _ => None,
        };
        Ok(Tzif {
            transitions,
            indices,
            offsets,
            dst,
            footer,
        })
    }
}

impl TimeZoneRules for Tzif {
    fn offset_at(&self, t: i64) -> i32 {
        if self.transitions.is_empty() || t < self.transitions[0] {
            if let (true, Some(f)) = (self.transitions.is_empty(), &self.footer) {
                return f.offset_at(t);
            }
            // Before the first transition: the first standard-time type.
            let i = self.dst.iter().position(|d| !d).unwrap_or(0);
            return self.offsets[i];
        }
        let n = self.transitions.partition_point(|&x| x <= t);
        if n == self.transitions.len()
            && let Some(f) = &self.footer
        {
            return f.offset_at(t);
        }
        self.offsets[usize::from(self.indices[n - 1])]
    }
}

struct Header {
    version: u8,
    isutcnt: usize,
    isstdcnt: usize,
    leapcnt: usize,
    timecnt: usize,
    typecnt: usize,
    charcnt: usize,
}

struct Reader<'a> {
    b: &'a [u8],
    pos: usize,
}

impl Reader<'_> {
    fn take(&mut self, n: usize) -> Option<&[u8]> {
        let s = self.b.get(self.pos..self.pos.checked_add(n)?)?;
        self.pos += n;
        Some(s)
    }
    fn u8(&mut self) -> Option<u8> {
        self.take(1).map(|s| s[0])
    }
    fn u32(&mut self) -> Option<u32> {
        self.take(4)
            .map(|s| u32::from_be_bytes([s[0], s[1], s[2], s[3]]))
    }
    fn i32(&mut self) -> Option<i32> {
        self.take(4)
            .map(|s| i32::from_be_bytes([s[0], s[1], s[2], s[3]]))
    }
    fn i64(&mut self) -> Option<i64> {
        self.take(8)
            .and_then(|s| s.try_into().ok())
            .map(i64::from_be_bytes)
    }
    fn header(&mut self) -> Option<Header> {
        if self.take(4)? != b"TZif" {
            return None;
        }
        let version = self.u8()?;
        self.take(15)?;
        let mut c = [0usize; 6];
        for slot in &mut c {
            *slot = usize::try_from(self.u32()?).ok()?;
            if *slot > 1 << 20 {
                return None;
            }
        }
        Some(Header {
            version,
            isutcnt: c[0],
            isstdcnt: c[1],
            leapcnt: c[2],
            timecnt: c[3],
            typecnt: c[4],
            charcnt: c[5],
        })
    }
}

/// A POSIX TZ rule (the TZif footer), e.g. `AEST-10AEDT,M10.1.0,M4.1.0/3`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PosixTz {
    /// Standard-time UTC offset in seconds (east positive).
    std_offset: i32,
    /// Daylight time: its offset and the start and end rules.
    dst: Option<(i32, DayRule, i32, DayRule, i32)>,
}

/// When a transition happens in a year.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DayRule {
    /// `Jn`: day 1..=365, February 29 never counted.
    Julian1(u16),
    /// `n`: day 0..=365, counting February 29.
    Julian0(u16),
    /// `Mm.w.d`: day `d` (0 = Sunday) of week `w` (5 = last) of month `m`.
    Month(u8, u8, u8),
}

impl PosixTz {
    /// Parse a POSIX TZ string as TZif footers use it.
    pub fn parse(s: &str) -> Result<PosixTz, TimeError> {
        let bad = || TimeError(format!("invalid TZ rule {s:?}"));
        let mut p = s;
        name(&mut p).ok_or_else(bad)?;
        let std_offset = -posix_time(&mut p, false).ok_or_else(bad)?;
        if p.is_empty() {
            return Ok(PosixTz {
                std_offset,
                dst: None,
            });
        }
        name(&mut p).ok_or_else(bad)?;
        let dst_offset = if p.starts_with(',') || p.is_empty() {
            std_offset + 3600
        } else {
            -posix_time(&mut p, false).ok_or_else(bad)?
        };
        if p.is_empty() {
            // No rule: the POSIX default (US rules) is not used by TZif footers.
            return Err(bad());
        }
        let p2 = p.strip_prefix(',').ok_or_else(bad)?;
        let mut p = p2;
        let (start, start_time) = rule(&mut p).ok_or_else(bad)?;
        p = p.strip_prefix(',').ok_or_else(bad)?;
        let (end, end_time) = rule(&mut p).ok_or_else(bad)?;
        if !p.is_empty() {
            return Err(bad());
        }
        Ok(PosixTz {
            std_offset,
            dst: Some((dst_offset, start, start_time, end, end_time)),
        })
    }
}

impl TimeZoneRules for PosixTz {
    fn offset_at(&self, t: i64) -> i32 {
        let Some((dst_off, start, start_time, end, end_time)) = self.dst else {
            return self.std_offset;
        };
        // DST starts at local standard time and ends at local daylight time.
        // Each start begins an interval that runs to the next end (in the same
        // year in the north, the next year in the south).
        let instant = |r: DayRule, time: i32, off: i32, y: i64| {
            rule_day(r, y) * 86_400 + i64::from(time) - i64::from(off)
        };
        let year = civil_from_days((t + i64::from(self.std_offset)).div_euclid(86_400)).0;
        for y in [year - 1, year, year + 1] {
            let s = instant(start, start_time, self.std_offset, y);
            let mut e = instant(end, end_time, dst_off, y);
            if e <= s {
                e = instant(end, end_time, dst_off, y + 1);
            }
            if s <= t && t < e {
                return dst_off;
            }
        }
        self.std_offset
    }
}

/// Day number (since the epoch) of a rule's day in `year`.
fn rule_day(r: DayRule, year: i64) -> i64 {
    let jan1 = days_from_civil(year, 1, 1);
    match r {
        DayRule::Julian1(n) => {
            let n = i64::from(n);
            jan1 + n - 1 + i64::from(is_leap(year) && n >= 60)
        }
        DayRule::Julian0(n) => jan1 + i64::from(n),
        DayRule::Month(m, w, d) => {
            let (m, w, d) = (i64::from(m), i64::from(w), i64::from(d));
            let first = days_from_civil(year, m, 1);
            // 1970-01-01 was a Thursday (4).
            let wd_first = (first + 4).rem_euclid(7);
            let mut day = first + (d - wd_first).rem_euclid(7) + (w - 1) * 7;
            let last = first + days_in_month(year, m) - 1;
            while day > last {
                day -= 7;
            }
            day
        }
    }
}

fn name(p: &mut &str) -> Option<()> {
    if let Some(rest) = p.strip_prefix('<') {
        let end = rest.find('>')?;
        *p = &rest[end + 1..];
        return Some(());
    }
    let n = p.bytes().take_while(u8::is_ascii_alphabetic).count();
    if n < 3 {
        return None;
    }
    *p = &p[n..];
    Some(())
}

/// `[+-]hh[:mm[:ss]]` in seconds; with `allow_large`, hours up to 167.
fn posix_time(p: &mut &str, allow_large: bool) -> Option<i32> {
    let mut sign = 1;
    if let Some(r) = p.strip_prefix('-') {
        sign = -1;
        *p = r;
    } else if let Some(r) = p.strip_prefix('+') {
        *p = r;
    }
    let mut parts = [0i32; 3];
    for (i, slot) in parts.iter_mut().enumerate() {
        if i > 0 {
            match p.strip_prefix(':') {
                Some(r) => *p = r,
                None => break,
            }
        }
        let n = p.bytes().take_while(u8::is_ascii_digit).count();
        if n == 0 || n > 3 {
            return None;
        }
        *slot = p[..n].parse().ok()?;
        *p = &p[n..];
    }
    let max_h = if allow_large { 167 } else { 24 };
    if parts[0] > max_h || parts[1] > 59 || parts[2] > 59 {
        return None;
    }
    Some(sign * (parts[0] * 3600 + parts[1] * 60 + parts[2]))
}

fn rule(p: &mut &str) -> Option<(DayRule, i32)> {
    let num = |p: &mut &str| -> Option<u16> {
        let n = p.bytes().take_while(u8::is_ascii_digit).count();
        let v = p.get(..n)?.parse().ok()?;
        *p = &p[n..];
        Some(v)
    };
    let r = if let Some(rest) = p.strip_prefix('M') {
        *p = rest;
        let m = num(p)?;
        *p = p.strip_prefix('.')?;
        let w = num(p)?;
        *p = p.strip_prefix('.')?;
        let d = num(p)?;
        if !(1..=12).contains(&m) || !(1..=5).contains(&w) || d > 6 {
            return None;
        }
        DayRule::Month(
            u8::try_from(m).ok()?,
            u8::try_from(w).ok()?,
            u8::try_from(d).ok()?,
        )
    } else if let Some(rest) = p.strip_prefix('J') {
        *p = rest;
        let n = num(p)?;
        if !(1..=365).contains(&n) {
            return None;
        }
        DayRule::Julian1(n)
    } else {
        let n = num(p)?;
        if n > 365 {
            return None;
        }
        DayRule::Julian0(n)
    };
    let time = match p.strip_prefix('/') {
        Some(rest) => {
            *p = rest;
            posix_time(p, true)?
        }
        None => 7200,
    };
    Some((r, time))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamps() {
        let t = Timestamp::parse("2026-06-20T00:00:00Z").unwrap();
        assert_eq!(t.to_rfc3339(), "2026-06-20T00:00:00Z");
        let u = t.checked_add(Duration::parse("36h").unwrap()).unwrap();
        assert_eq!(u.to_rfc3339(), "2026-06-21T12:00:00Z");
        assert_eq!(
            Timestamp::parse("2026-10-02T09:00:00.5+10:00")
                .unwrap()
                .to_rfc3339(),
            "2026-10-01T23:00:00.5Z"
        );
        assert_eq!(
            Timestamp::parse("0001-01-01T00:00:00Z").unwrap().seconds,
            MIN_SECONDS
        );
        assert!(Timestamp::parse("2026-06-20T00:00:60Z").is_err());
        assert!(Timestamp::parse("2026-06-20").is_err());
        assert_eq!(
            Timestamp::from_millis(-1).unwrap().to_rfc3339(),
            "1969-12-31T23:59:59.999Z"
        );
        assert!(
            Timestamp::parse("9999-12-31T23:59:59Z")
                .unwrap()
                .checked_add(Duration::parse("1s").unwrap())
                .is_err()
        );
    }

    #[test]
    fn durations() {
        assert_eq!(Duration::parse("1.5h").unwrap().to_cel_string(), "5400s");
        assert_eq!(Duration::parse("-1h30m").unwrap().to_cel_string(), "-5400s");
        assert_eq!(Duration::parse("1ms").unwrap().to_cel_string(), "0.001s");
        assert_eq!(Duration::parse("0s").unwrap().to_cel_string(), "0s");
        assert_eq!(Duration::parse(".5s").unwrap().to_cel_string(), "0.5s");
        assert_eq!(Duration::parse("1.h").unwrap().to_cel_string(), "3600s");
        assert_eq!(Duration::parse("0").unwrap().to_cel_string(), "0s");
        assert_eq!(Duration::parse("2µs").unwrap().to_cel_string(), "0.000002s");
        for bad in [
            "",
            "1",
            "h",
            "1d",
            ".h",
            "-",
            "1h 2m",
            "99999999999999999999h",
            "+",
        ] {
            assert!(Duration::parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn calendar() {
        for days in [-719_162i64, -1, 0, 1, 10_957, 20_627, 2_932_896] {
            let (y, m, d) = civil_from_days(days);
            assert_eq!(days_from_civil(y, m, d), days);
        }
        assert_eq!(add_months("2026-01-31", 1).unwrap(), "2026-02-28");
        assert_eq!(add_months("2024-01-31", 1).unwrap(), "2024-02-29");
        assert_eq!(add_months("2026-03-15", -15).unwrap(), "2024-12-15");
        assert!(add_months("9999-12-01", 1).is_err());
    }

    #[test]
    fn posix_rules() {
        let melb = PosixTz::parse("AEST-10AEDT,M10.1.0,M4.1.0/3").unwrap();
        let at = |s: &str| Timestamp::parse(s).unwrap().seconds;
        assert_eq!(melb.offset_at(at("2026-06-20T00:00:00Z")), 36_000);
        assert_eq!(melb.offset_at(at("2026-01-15T00:00:00Z")), 39_600);
        // 2026-10-04 02:00 AEST = 2026-10-03T16:00:00Z.
        assert_eq!(melb.offset_at(at("2026-10-03T15:59:59Z")), 36_000);
        assert_eq!(melb.offset_at(at("2026-10-03T16:00:00Z")), 39_600);
        // 2026-04-05 03:00 AEDT = 2026-04-04T16:00:00Z.
        assert_eq!(melb.offset_at(at("2026-04-04T15:59:59Z")), 39_600);
        assert_eq!(melb.offset_at(at("2026-04-04T16:00:00Z")), 36_000);
        let ny = PosixTz::parse("EST5EDT,M3.2.0,M11.1.0").unwrap();
        assert_eq!(ny.offset_at(at("2026-03-08T06:59:59Z")), -18_000);
        assert_eq!(ny.offset_at(at("2026-03-08T07:00:00Z")), -14_400);
        assert_eq!(PosixTz::parse("<+0530>-5:30").unwrap().offset_at(0), 19_800);
        assert_eq!(PosixTz::parse("UTC0").unwrap().offset_at(0), 0);
        assert!(PosixTz::parse("EST5EDT").is_err());
    }

    #[test]
    fn start_of_day_handles_gaps() {
        // A zone whose DST starts at local midnight: 2026-09-06 00:00 -> 01:00.
        let santiago = PosixTz::parse("<-04>4<-03>,M9.1.6/24,M4.1.6/24").unwrap();
        let day = days_from_civil(2026, 9, 6);
        let t = start_of_local_day(&santiago, day);
        assert_eq!(local_days(&santiago, t), day);
        assert!(local_days(&santiago, t - 1) < day);
        let melb = PosixTz::parse("AEST-10AEDT,M10.1.0,M4.1.0/3").unwrap();
        let t = start_of_local_day(&melb, days_from_civil(2026, 6, 20));
        assert_eq!(
            Timestamp {
                seconds: t,
                nanos: 0
            }
            .to_rfc3339(),
            "2026-06-19T14:00:00Z"
        );
    }
}
