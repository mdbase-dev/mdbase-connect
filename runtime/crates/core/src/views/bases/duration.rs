//! Typed duration helpers adapted from mdbase-rs `views/expression.rs`.
//! Calendar components never collapse into a guessed fixed-millisecond span.

use super::{EvaluationFailure, WorkBudget};

/// Bound input before scanning, parsing or allocating diagnostics.
pub const MAX_DURATION_SOURCE_BYTES: usize = 1_024;
/// Conservative primitive-component range, independent of date arithmetic range.
pub const MAX_DURATION_COMPONENT: f64 = 1_000_000_000.0;

/// Preserve the legacy binary64 year/month/week/day/hour/minute/second/ms parts.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DurationValue {
    parts: [f64; 8],
}

impl DurationValue {
    /// Exact captured components in year/month/week/day/hour/minute/second/ms
    /// order. Public construction is checked; no nonfinite/saturating defaults.
    pub fn from_components(
        parts: [f64; 8],
        budget: &mut WorkBudget,
    ) -> Result<Self, EvaluationFailure> {
        charge(budget, 8, 128)?;
        if parts
            .iter()
            .any(|part| !part.is_finite() || part.abs() > MAX_DURATION_COMPONENT)
        {
            return refuse(budget, "duration_range");
        }
        Ok(Self { parts })
    }

    /// Closed grammar over the legacy numeric/unit forms. Unlike the old regex
    /// extractor, junk/compact/unqualified inputs refuse, never partially match.
    pub fn parse(source: &str, budget: &mut WorkBudget) -> Result<Self, EvaluationFailure> {
        if source.len() > MAX_DURATION_SOURCE_BYTES {
            return limit(budget, "duration_source_bytes");
        }
        charge(
            budget,
            u64::try_from(source.len()).expect("bounded source") + 1,
            128,
        )?;
        if !source.is_ascii() {
            return refuse(budget, "duration_syntax");
        }
        let mut rest = source.trim_matches(|c: char| c.is_ascii_whitespace());
        let mut parts = [0.0; 8];
        if rest.is_empty() {
            return refuse(budget, "duration_syntax");
        }
        while !rest.is_empty() {
            charge(budget, 1, 0)?;
            let bytes = rest.as_bytes();
            let mut end = usize::from(matches!(bytes[0], b'+' | b'-'));
            let start_digits = end;
            while bytes.get(end).is_some_and(u8::is_ascii_digit) {
                end += 1;
            }
            let integer_digits = end - start_digits;
            if bytes.get(end) == Some(&b'.') {
                end += 1;
                let fraction_start = end;
                while bytes.get(end).is_some_and(u8::is_ascii_digit) {
                    end += 1;
                }
                if end == fraction_start {
                    return refuse(budget, "duration_syntax");
                }
            } else if integer_digits == 0 {
                return refuse(budget, "duration_syntax");
            }
            let Ok(amount) = rest[..end].parse::<f64>() else {
                return refuse(budget, "duration_syntax");
            };
            rest = rest[end..].trim_start_matches(|c: char| c.is_ascii_whitespace());
            let end = rest.bytes().take_while(u8::is_ascii_alphabetic).count();
            let unit = &rest[..end];
            let Some(index) = unit_index(unit) else {
                return refuse(budget, "duration_unit");
            };
            parts[index] += amount;
            if !parts[index].is_finite() || parts[index].abs() > MAX_DURATION_COMPONENT {
                return refuse(budget, "duration_range");
            }
            rest = &rest[end..];
            if !rest.is_empty() && !rest.as_bytes()[0].is_ascii_whitespace() {
                return refuse(budget, "duration_separator");
            }
            rest = rest.trim_start_matches(|c: char| c.is_ascii_whitespace());
        }
        Self::from_components(parts, budget)
    }

    /// Typed parts for the later duration/date overload adapter.
    pub fn components(self) -> [f64; 8] {
        self.parts
    }

    /// The fixed portion only; deliberately not a full calendar duration-to-
    /// number coercion. Years/months remain separate and never become zero data.
    pub fn fixed_millis(self, budget: &mut WorkBudget) -> Result<f64, EvaluationFailure> {
        charge(budget, 6, 0)?;
        let p = self.parts;
        Ok(p[7]
            + p[6] * 1_000.0
            + p[5] * 60_000.0
            + p[4] * 3_600_000.0
            + p[3] * 86_400_000.0
            + p[2] * 604_800_000.0)
    }

    /// Preserve independent component addition, not approximate month lengths.
    pub fn add(self, rhs: Self, budget: &mut WorkBudget) -> Result<Self, EvaluationFailure> {
        Self::from_components(
            std::array::from_fn(|i| self.parts[i] + rhs.parts[i]),
            budget,
        )
    }

    /// Preserve right-hand binary64 scaling; no Number * Duration overload is
    /// implied by this helper. Nonfinite/out-of-range results refuse.
    pub fn scale(self, factor: f64, budget: &mut WorkBudget) -> Result<Self, EvaluationFailure> {
        if !factor.is_finite() {
            return refuse(budget, "duration_scale");
        }
        Self::from_components(self.parts.map(|part| part * factor), budget)
    }

    /// Ported humanization thresholds in the qualified simple-duration profile.
    /// Calendar mixtures/fractions and >=45 fixed days await real oracle
    /// extensions: the old year/month approximations are not silently admitted.
    pub fn humanize(self, budget: &mut WorkBudget) -> Result<String, EvaluationFailure> {
        charge(budget, 1, 128)?;
        let p = self.parts;
        if p[0] != 0.0 || p[1] != 0.0 {
            if p[2..].iter().any(|v| *v != 0.0) {
                return refuse(budget, "calendar_duration_humanization");
            }
            return match (p[0], p[1]) {
                (1.0, 0.0) => Ok("a year".into()),
                (0.0, 1.0) => Ok("a month".into()),
                _ => refuse(budget, "calendar_duration_humanization"),
            };
        }
        let millis = self.fixed_millis(budget)?.abs();
        if millis >= 45.0 * 86_400_000.0 {
            return refuse(budget, "long_duration_humanization");
        }
        Ok(if millis >= 26.0 * 86_400_000.0 {
            "a month".into()
        } else if millis >= 36.0 * 3_600_000.0 {
            pluralize(millis / 86_400_000.0, "day")
        } else if millis >= 22.0 * 3_600_000.0 {
            "a day".into()
        } else if millis >= 90.0 * 60_000.0 {
            pluralize(millis / 3_600_000.0, "hour")
        } else if millis >= 45.0 * 60_000.0 {
            "an hour".into()
        } else if millis >= 90_000.0 {
            pluralize(millis / 60_000.0, "minute")
        } else if millis >= 45_000.0 {
            "a minute".into()
        } else {
            "a few seconds".into()
        })
    }
}

fn unit_index(unit: &str) -> Option<usize> {
    let aliases: [(&str, &[&str]); 8] = [
        ("y", &["year", "years"]),
        ("M", &["month", "months"]),
        ("w", &["week", "weeks"]),
        ("d", &["day", "days"]),
        ("h", &["hour", "hours"]),
        ("m", &["minute", "minutes"]),
        ("s", &["second", "seconds"]),
        ("ms", &["millisecond", "milliseconds"]),
    ];
    aliases.iter().position(|(short, words)| {
        unit == *short || words.iter().any(|word| unit.eq_ignore_ascii_case(word))
    })
}
fn pluralize(value: f64, unit: &str) -> String {
    let rounded = value.round(); // positive qualified values only
    format!(
        "{rounded:.0} {unit}{}",
        if rounded == 1.0 { "" } else { "s" }
    )
}
fn charge(budget: &mut WorkBudget, steps: u64, bytes: u64) -> Result<(), EvaluationFailure> {
    if budget.charge(steps, bytes) {
        Ok(())
    } else {
        Err(budget.failure().expect("sticky failed charge"))
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

#[cfg(test)]
mod tests;
