//! Pure temporal helpers adapted from mdbase-rs `views/expression.rs`.
//! Uses captured clock/zone and Core's pinned calendar/rules, not CEL expression
//! semantics. Invalid/unqualified inputs refuse; none become epoch defaults.

use super::{EvaluationFailure, WorkBudget};
use crate::cel::time::{self, NamedZone, TimeZoneRules, Timestamp};
use std::fmt::{self, Write};

/// Bounded temporal text before scanning or parsing.
pub const MAX_DATE_SOURCE_BYTES: usize = 128;
/// Bounded legacy-format pattern before allocating output.
pub const MAX_DATE_PATTERN_BYTES: usize = 512;
const DAY_MS: i64 = 86_400_000;

#[derive(Clone, Copy)]
enum Zone {
    Fixed(i32),
    Named(NamedZone),
}

/// Explicit captured zone; there is deliberately no Default or Local variant.
#[derive(Clone, Copy)]
pub struct BasesTimezone(Zone);

impl fmt::Debug for BasesTimezone {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.0 {
            Zone::Fixed(seconds) => f.debug_tuple("Fixed").field(&seconds).finish(),
            Zone::Named(_) => write!(f, "Named(pinned tzdb {})", time::tzdb::RELEASE),
        }
    }
}

impl BasesTimezone {
    pub(super) fn candidate_fixed_zone(self) -> bool {
        matches!(self.0, Zone::Fixed(_))
    }
    /// Capture an explicit UTC, ±HH:MM or pinned IANA zone once per request.
    /// The fixed reservation covers bounded initialization of Core's shared
    /// immutable tzdb; it is not an evaluator/formula cache.
    pub fn capture(name: &str, budget: &mut WorkBudget) -> Result<Self, EvaluationFailure> {
        if name.len() > 64 {
            return refuse(budget, "timezone_name");
        }
        charge(budget, 1, 256)?;
        if matches!(name, "UTC" | "utc" | "Z") {
            return Ok(Self(Zone::Fixed(0)));
        }
        if name.starts_with('+') || name.starts_with('-') {
            let b = name.as_bytes();
            if !name.is_ascii() || b.len() != 6 || b[3] != b':' {
                return refuse(budget, "timezone_offset");
            }
            let (Some(h), Some(m)) = (digits(&name[1..3]), digits(&name[4..6])) else {
                return refuse(budget, "timezone_offset");
            };
            if h > 23 || m > 59 {
                return refuse(budget, "timezone_offset");
            }
            let seconds = i32::try_from(h * 3600 + m * 60).expect("bounded offset");
            return Ok(Self(Zone::Fixed(if b[0] == b'-' {
                -seconds
            } else {
                seconds
            })));
        }
        if name.is_empty() || name == "local" {
            return refuse(budget, "timezone_not_captured");
        }
        charge(budget, 1, 512 * 1024)?;
        match NamedZone::get(name) {
            Ok(zone) => Ok(Self(Zone::Named(zone))),
            Err(_) => refuse(budget, "timezone_name"),
        }
    }

    fn offset(self, utc_seconds: i64) -> i64 {
        i64::from(match self.0 {
            Zone::Fixed(seconds) => seconds,
            Zone::Named(zone) => zone.offset_at(utc_seconds),
        })
    }

    fn utc_from_local(
        self,
        millis: i64,
        budget: &mut WorkBudget,
    ) -> Result<i64, EvaluationFailure> {
        let seconds = millis.div_euclid(1000);
        let mut candidate = None;
        for shift in [-2, -1, 0, 1, 2] {
            charge(budget, 1, 0)?;
            let off = self.offset(seconds + shift * 86_400);
            let utc = millis - off * 1000;
            if self.offset(utc.div_euclid(1000)) == off {
                if candidate.is_some_and(|old| old != utc) {
                    return refuse(budget, "local_time_ambiguous");
                }
                candidate = Some(utc);
            }
        }
        match candidate {
            Some(utc) => checked_millis(utc, budget),
            None => refuse(budget, "local_time_gap"),
        }
    }
}

/// Typed date preserving date-only intent and the captured display zone.
/// Valid range is Core's portable timestamp range, years 1..=9999.
#[derive(Clone, Copy, Debug)]
pub struct DateValue {
    millis: i64,
    date_only: bool,
    timezone: BasesTimezone,
}

impl DateValue {
    /// Captured metadata/clock timestamp, never a substituted stat or epoch.
    pub fn from_millis(
        millis: i64,
        date_only: bool,
        timezone: BasesTimezone,
        budget: &mut WorkBudget,
    ) -> Result<Self, EvaluationFailure> {
        charge(budget, 1, 128)?;
        checked_millis(millis, budget)?;
        let value = Self {
            millis,
            date_only,
            timezone,
        };
        value.parts(budget)?; // local date also must be within the range
        Ok(value)
    }

    /// Ported date-only, RFC3339 and local seconds-precision parsing.
    /// Wider inputs, invalid dates and DST fold/gap behavior are unqualified
    /// in this helper slice and visibly refuse pending real-oracle extension.
    pub fn parse(
        source: &str,
        timezone: BasesTimezone,
        budget: &mut WorkBudget,
    ) -> Result<Self, EvaluationFailure> {
        if source.len() > MAX_DATE_SOURCE_BYTES {
            return limit(budget, "date_source_bytes");
        }
        charge(budget, 1, 1024)?;
        if !source.is_ascii() {
            return refuse(budget, "date_syntax");
        }
        if source.len() == 10 {
            let Some((y, m, d)) = time::parse_date(source) else {
                return refuse(budget, "invalid_date");
            };
            let local = time::days_from_civil(y, m, d) * DAY_MS;
            return Self::from_millis(
                timezone.utc_from_local(local, budget)?,
                true,
                timezone,
                budget,
            );
        }
        if source.len() == 19 && matches!(source.as_bytes()[10], b' ' | b'T') {
            let Some((y, m, d)) = time::parse_date(&source[..10]) else {
                return refuse(budget, "invalid_date");
            };
            let t = &source[11..];
            if t.as_bytes()[2] != b':' || t.as_bytes()[5] != b':' {
                return refuse(budget, "date_syntax");
            }
            let (Some(h), Some(mi), Some(s)) = (digits(&t[..2]), digits(&t[3..5]), digits(&t[6..]))
            else {
                return refuse(budget, "date_syntax");
            };
            if h > 23 || mi > 59 || s > 59 {
                return refuse(budget, "invalid_date");
            }
            let local = time::days_from_civil(y, m, d) * DAY_MS + (h * 3600 + mi * 60 + s) * 1000;
            return Self::from_millis(
                timezone.utc_from_local(local, budget)?,
                false,
                timezone,
                budget,
            );
        }
        let Ok(t) = Timestamp::parse(source) else {
            return refuse(budget, "date_syntax");
        };
        if t.nanos % 1_000_000 != 0 {
            return refuse(budget, "submillisecond_date");
        }
        Self::from_millis(
            t.seconds * 1000 + i64::from(t.nanos / 1_000_000),
            false,
            timezone,
            budget,
        )
    }

    pub(super) fn timezone_name(self) -> std::borrow::Cow<'static, str> {
        match self.timezone.0 {
            Zone::Fixed(0) => std::borrow::Cow::Borrowed("UTC"),
            Zone::Fixed(seconds) => {
                let sign = if seconds < 0 { '-' } else { '+' };
                let seconds = seconds.abs();
                std::borrow::Cow::Owned(format!(
                    "{sign}{:02}:{:02}",
                    seconds / 3600,
                    (seconds % 3600) / 60
                ))
            }
            Zone::Named(zone) => std::borrow::Cow::Borrowed(zone.name()),
        }
    }
    /// Binary64 conversion belongs to the Bases value adapter; this is exact ms.
    pub fn millis(self) -> i64 {
        self.millis
    }
    /// Preserve date-only input intent across month/fixed-span arithmetic.
    pub fn is_date_only(self) -> bool {
        self.date_only
    }

    fn parts(self, budget: &mut WorkBudget) -> Result<Parts, EvaluationFailure> {
        charge(budget, 1, 0)?;
        let local = self.millis + self.timezone.offset(self.millis.div_euclid(1000)) * 1000;
        let days = local.div_euclid(DAY_MS);
        let (year, month, day) = time::civil_from_days(days);
        if !(1..=9999).contains(&year) {
            return refuse(budget, "date_range");
        }
        Ok(Parts {
            year,
            month,
            day,
            days,
            time: local.rem_euclid(DAY_MS),
        })
    }

    /// The local calendar fields of a typed date.
    pub fn property(self, name: &str, budget: &mut WorkBudget) -> Result<i64, EvaluationFailure> {
        let p = self.parts(budget)?;
        match name {
            "year" => Ok(p.year),
            "month" => Ok(p.month),
            "day" => Ok(p.day),
            "hour" => Ok(p.time / 3_600_000),
            "minute" => Ok(p.time / 60_000 % 60),
            "second" => Ok(p.time / 1000 % 60),
            "millisecond" => Ok(p.time % 1000),
            _ => refuse(budget, "date_property"),
        }
    }

    /// Ported local midnight/date() operation, with no UTC gap fallback.
    pub fn date(self, budget: &mut WorkBudget) -> Result<Self, EvaluationFailure> {
        let p = self.parts(budget)?;
        Self::from_millis(
            self.timezone.utc_from_local(p.days * DAY_MS, budget)?,
            true,
            self.timezone,
            budget,
        )
    }

    /// Integer calendar-month shift, clamping to the target month's last day.
    /// Fractional duration rounding stays with the later duration adapter.
    pub fn add_months(
        self,
        months: i64,
        budget: &mut WorkBudget,
    ) -> Result<Self, EvaluationFailure> {
        let p = self.parts(budget)?;
        let Some(total) = p
            .year
            .checked_mul(12)
            .and_then(|n| n.checked_add(p.month - 1))
            .and_then(|n| n.checked_add(months))
        else {
            return refuse(budget, "date_range");
        };
        let (year, month) = (total.div_euclid(12), total.rem_euclid(12) + 1);
        if !(1..=9999).contains(&year) {
            return refuse(budget, "date_range");
        }
        let day = p.day.min(time::days_in_month(year, month));
        let local = time::days_from_civil(year, month, day) * DAY_MS + p.time;
        Self::from_millis(
            self.timezone.utc_from_local(local, budget)?,
            self.date_only,
            self.timezone,
            budget,
        )
    }

    /// Legacy fixed-span arithmetic in milliseconds, not calendar-day shifting.
    pub fn add_millis(
        self,
        millis: i64,
        budget: &mut WorkBudget,
    ) -> Result<Self, EvaluationFailure> {
        let Some(result) = self.millis.checked_add(millis) else {
            return refuse(budget, "date_range");
        };
        Self::from_millis(result, self.date_only, self.timezone, budget)
    }

    /// Original plain representation (seconds precision, captured local zone).
    pub fn plain(self, budget: &mut WorkBudget) -> Result<String, EvaluationFailure> {
        self.format(
            if self.date_only {
                "YYYY-MM-DD"
            } else {
                "YYYY-MM-DDTHH:mm:ss"
            },
            budget,
        )
    }

    /// Frozen bounded legacy token formatter. Additional slice-1 tokens use
    /// [`Self::format_slice1`] so original component witnesses stay unchanged.
    pub fn format(
        self,
        pattern: &str,
        budget: &mut WorkBudget,
    ) -> Result<String, EvaluationFailure> {
        self.format_inner(pattern, budget, false)
    }

    /// Bounded English `ddd`, `MMM` and unpadded `D` in the slice-1 profile.
    /// Captured date/zone only; no host locale or ambient calendar defaults.
    pub fn format_slice1(
        self,
        pattern: &str,
        budget: &mut WorkBudget,
    ) -> Result<String, EvaluationFailure> {
        self.format_inner(pattern, budget, true)
    }

    fn format_inner(
        self,
        pattern: &str,
        budget: &mut WorkBudget,
        slice1: bool,
    ) -> Result<String, EvaluationFailure> {
        self.format_inner_with_fast_path(pattern, budget, slice1, true)
    }

    fn format_inner_with_fast_path(
        self,
        pattern: &str,
        budget: &mut WorkBudget,
        slice1: bool,
        fast_path: bool,
    ) -> Result<String, EvaluationFailure> {
        if pattern.len() > MAX_DATE_PATTERN_BYTES {
            return limit(budget, "date_pattern_bytes");
        }
        charge(
            budget,
            1,
            u64::try_from(pattern.len()).expect("bounded pattern") * 4 + 128,
        )?;
        let p = self.parts(budget)?;
        let mut output = String::with_capacity(pattern.len() * 4 + 32);
        let canonical = match pattern {
            "YYYY-MM-DD" | "yyyy-MM-DD" => Some(false),
            "YYYY-MM-DDTHH:mm:ss" | "yyyy-MM-DDTHH:mm:ss" => Some(true),
            _ => None,
        };
        if fast_path && let Some(with_time) = canonical {
            // Preserve every original token/literal charge, including partial
            // exhaustion/sticky failure; do not batch, refund or reset work.
            for _ in 0..if with_time { 11 } else { 5 } {
                charge(budget, 1, 0)?;
            }
            append_decimal_pair(&mut output, p.year / 100);
            append_decimal_pair(&mut output, p.year % 100);
            output.push('-');
            append_decimal_pair(&mut output, p.month);
            output.push('-');
            append_decimal_pair(&mut output, p.day);
            if with_time {
                output.push('T');
                append_decimal_pair(&mut output, p.time / 3_600_000);
                output.push(':');
                append_decimal_pair(&mut output, p.time / 60_000 % 60);
                output.push(':');
                append_decimal_pair(&mut output, p.time / 1000 % 60);
            }
            return Ok(output);
        }
        let mut rest = pattern;
        while !rest.is_empty() {
            charge(budget, 1, 0)?;
            if let Some(literal) = rest.strip_prefix('[') {
                let Some(end) = literal.find(']') else {
                    return refuse(budget, "date_format_literal");
                };
                output.push_str(&literal[..end]);
                rest = &literal[end + 1..];
                continue;
            }
            if slice1 {
                // These longer Moment tokens must not accidentally decompose
                // into repeated supported day/month/weekday tokens.
                if ["dddd", "MMMM", "DDD"]
                    .iter()
                    .any(|token| rest.starts_with(token))
                {
                    return refuse(budget, "date_format_token");
                }
                if let Some(next) = rest.strip_prefix("ddd") {
                    let weekday =
                        usize::try_from((p.days + 4).rem_euclid(7)).expect("bounded weekday");
                    output.push_str(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][weekday]);
                    rest = next;
                    continue;
                }
                if let Some(next) = rest.strip_prefix("MMM") {
                    let month = usize::try_from(p.month - 1).expect("bounded month");
                    output.push_str(
                        [
                            "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct",
                            "Nov", "Dec",
                        ][month],
                    );
                    rest = next;
                    continue;
                }
                if rest.starts_with('D') && !rest.starts_with("DD") {
                    write!(output, "{}", p.day).expect("string write");
                    rest = &rest[1..];
                    continue;
                }
            }
            let token = ["YYYY", "yyyy", "WW", "MM", "DD", "HH", "mm", "ss"]
                .into_iter()
                .find(|token| rest.starts_with(token));
            if let Some(token) = token {
                let number = match token {
                    "YYYY" | "yyyy" => p.year,
                    "WW" => iso_week(p.days),
                    "MM" => p.month,
                    "DD" => p.day,
                    "HH" => p.time / 3_600_000,
                    "mm" => p.time / 60_000 % 60,
                    "ss" => p.time / 1000 % 60,
                    _ => unreachable!(),
                };
                write!(
                    output,
                    "{number:0width$}",
                    width = if token.len() == 4 { 4 } else { 2 }
                )
                .expect("string write");
                rest = &rest[token.len()..];
            } else {
                let c = rest.chars().next().expect("nonempty pattern");
                if c.is_alphabetic() && c != 'T' || matches!(c, ']' | '%') {
                    return refuse(budget, "date_format_token");
                }
                output.push(c);
                rest = &rest[c.len_utf8()..];
            }
        }
        Ok(output)
    }
}

// Parts are range-checked before formatting. Decimal pairs include leading
// zeroes without a general token scan or dynamic integer formatting machinery.
fn append_decimal_pair(output: &mut String, number: i64) {
    for digit in [number / 10, number % 10] {
        output.push(char::from(
            b'0' + u8::try_from(digit).expect("bounded decimal digit"),
        ));
    }
}

/// Immutable now/zone capture. No omitted clock, host clock or epoch default.
#[derive(Clone, Copy, Debug)]
pub struct CapturedClock {
    now: DateValue,
}
impl CapturedClock {
    /// Immutable captured zone for other captured temporal metadata.
    pub fn timezone(self) -> BasesTimezone {
        self.now.timezone
    }

    /// Capture once before a query and carry through rows/formulas.
    pub fn new(
        now_millis: i64,
        timezone: BasesTimezone,
        budget: &mut WorkBudget,
    ) -> Result<Self, EvaluationFailure> {
        Ok(Self {
            now: DateValue::from_millis(now_millis, false, timezone, budget)?,
        })
    }
    /// Parse using this immutable capture's zone, never a host-local zone.
    pub fn parse(
        self,
        source: &str,
        budget: &mut WorkBudget,
    ) -> Result<DateValue, EvaluationFailure> {
        DateValue::parse(source, self.now.timezone, budget)
    }
    /// Captured now(), not a fresh wall-clock read.
    pub fn now(self, budget: &mut WorkBudget) -> Result<DateValue, EvaluationFailure> {
        charge(budget, 1, 128)?;
        Ok(self.now)
    }
    /// Captured today() in the captured zone.
    pub fn today(self, budget: &mut WorkBudget) -> Result<DateValue, EvaluationFailure> {
        self.now.date(budget)
    }
}

struct Parts {
    year: i64,
    month: i64,
    day: i64,
    days: i64,
    time: i64,
}
fn digits(s: &str) -> Option<i64> {
    (!s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
        .then(|| s.parse().ok())
        .flatten()
}
fn checked_millis(millis: i64, budget: &mut WorkBudget) -> Result<i64, EvaluationFailure> {
    if Timestamp::from_millis(millis).is_err() {
        refuse(budget, "date_range")
    } else {
        Ok(millis)
    }
}
fn charge(budget: &mut WorkBudget, steps: u64, bytes: u64) -> Result<(), EvaluationFailure> {
    if budget.charge(steps, bytes) {
        Ok(())
    } else {
        Err(budget.failure().expect("failed charge is sticky"))
    }
}
fn refuse<T>(budget: &mut WorkBudget, detail: &'static str) -> Result<T, EvaluationFailure> {
    budget.fail(EvaluationFailure::UnsupportedConstruct(detail));
    Err(budget.failure().expect("sticky refusal"))
}
fn limit<T>(budget: &mut WorkBudget, detail: &'static str) -> Result<T, EvaluationFailure> {
    budget.fail(EvaluationFailure::BudgetExceeded(detail));
    Err(budget.failure().expect("sticky refusal"))
}
fn iso_week(days: i64) -> i64 {
    let weekday = (days + 3).rem_euclid(7) + 1;
    let thursday = days + 4 - weekday;
    let (year, _, _) = time::civil_from_days(thursday);
    (thursday - time::days_from_civil(year, 1, 1)).div_euclid(7) + 1
}

#[cfg(test)]
mod tests;
