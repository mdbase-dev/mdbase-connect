//! Typed duration bridge: components survive formulas/lists/caches; the public
//! display is qualified once under the caller's existing request meter.
use super::{DurationValue, EvaluationFailure, WorkBudget};

/// Qualified duration plus its captured, bounded humanized representation.
/// Unqualified humanization refuses construction in this component profile;
/// date arithmetic on duration text can use typed parts without this display.
#[derive(Clone, Debug, PartialEq)]
pub struct EvaluatedDuration {
    value: DurationValue,
    plain: String,
}
impl EvaluatedDuration {
    /// Preserve typed components and qualify public rendering without resetting
    /// the request budget. Never replace an unqualified duration with a string.
    pub fn new(value: DurationValue, budget: &mut WorkBudget) -> Result<Self, EvaluationFailure> {
        let plain = value.humanize(budget)?;
        Ok(Self { value, plain })
    }
    /// Typed year/month/week/day/hour/minute/second/ms parts.
    pub fn value(&self) -> DurationValue {
        self.value
    }
    /// Precomputed public representation. Callers meter every copy separately.
    pub fn display(&self) -> &str {
        &self.plain
    }
}
