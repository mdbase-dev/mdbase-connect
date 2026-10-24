//! Bounded binary64 ECMAScript-style rounding, no powf/locale/FPU-mode input.
use super::{EvaluationFailure, WorkBudget};
const POWERS: [f64; 16] = [
    1.0,
    10.0,
    100.0,
    1_000.0,
    10_000.0,
    100_000.0,
    1_000_000.0,
    10_000_000.0,
    100_000_000.0,
    1_000_000_000.0,
    10_000_000_000.0,
    100_000_000_000.0,
    1_000_000_000_000.0,
    10_000_000_000_000.0,
    100_000_000_000_000.0,
    1_000_000_000_000_000.0,
];
fn refuse(budget: &mut WorkBudget, detail: &'static str) -> Result<f64, EvaluationFailure> {
    budget.fail(EvaluationFailure::UnsupportedConstruct(detail));
    Err(budget.failure().expect("sticky rounding refusal"))
}
/// Slice-1 round: integer decimal digits 0..15, ties toward positive infinity.
/// This intentionally preserves binary64 multiply/divide effects, not decimal
/// financial rounding. Unsupported precision/intermediate overflow refuses.
pub fn round_number(
    value: f64,
    digits: f64,
    budget: &mut WorkBudget,
) -> Result<f64, EvaluationFailure> {
    if !budget.charge(8, 0) {
        return Err(budget.failure().expect("rounding work failure"));
    }
    if !digits.is_finite() || digits.fract() != 0.0 || !(0.0..=15.0).contains(&digits) {
        return refuse(budget, "round_precision");
    }
    if !value.is_finite() {
        return refuse(budget, "round_number_range");
    }
    // Positive integer powers <=10^15 are exactly representable binary64.
    // Negative/fractional JS powers are implementation-approximated; no powf
    // substitution or reciprocal guess is admitted in this profile.
    let factor = POWERS[digits as usize];
    let scaled = value * factor;
    if !scaled.is_finite() {
        return refuse(budget, "round_number_range");
    }
    let rounded = if scaled == 0.0 || scaled.abs() >= 4_503_599_627_370_496.0 {
        scaled
    } else {
        let floor = scaled.floor();
        let result = if scaled - floor < 0.5 {
            floor
        } else {
            floor + 1.0
        };
        if result == 0.0 && scaled.is_sign_negative() {
            -0.0
        } else {
            result
        }
    };
    let result = rounded / factor;
    if !result.is_finite() {
        return refuse(budget, "round_number_range");
    }
    Ok(result)
}
#[cfg(test)]
mod tests;
