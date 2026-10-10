use super::*;
use crate::{
    value::Map,
    views::bases::{
        BasesTimezone, Bindings, CapturedClock, DateValue, Profile, Program, RuntimeValue,
    },
};
use std::collections::BTreeMap;
#[test]
fn js_ties_and_half_boundaries_are_not_rust_round_or_add_half_floor() {
    let mut budget = WorkBudget::new();
    for (x, y) in [
        (2.5, 3.0),
        (-1.5, -1.0),
        (-2.5, -2.0),
        (0.49999999999999994, 0.0),
        (-0.5000000000000001, -1.0),
        (1.4999999999999998, 1.0),
    ] {
        assert_eq!(round_number(x, 0.0, &mut budget).unwrap(), y);
    }
    assert!(
        round_number(-0.5, 0.0, &mut budget)
            .unwrap()
            .is_sign_negative()
    );
    assert!(
        round_number(-f64::from_bits(1), 0.0, &mut budget)
            .unwrap()
            .is_sign_negative()
    );
    assert_eq!(
        round_number(f64::from_bits(1), 0.0, &mut budget).unwrap(),
        0.0
    );
}
#[test]
fn scaled_round_preserves_binary64_decimal_artifacts_and_large_values() {
    let mut budget = WorkBudget::new();
    assert_eq!(round_number(1.005, 2.0, &mut budget).unwrap(), 1.0);
    assert_eq!(round_number(1.275, 2.0, &mut budget).unwrap(), 1.27);
    assert_eq!(round_number(-1.25, 1.0, &mut budget).unwrap(), -1.2);
    for value in [4_503_599_627_370_496.0, 9_007_199_254_740_992.0, f64::MAX] {
        assert_eq!(round_number(value, 0.0, &mut budget).unwrap(), value);
    }
}
#[test]
fn unsupported_precision_overflow_and_meter_failure_are_sticky() {
    for digits in [-1.0, 0.5, 16.0, f64::NAN, f64::INFINITY] {
        let mut budget = WorkBudget::new();
        assert_eq!(
            round_number(1.2, digits, &mut budget).unwrap_err(),
            EvaluationFailure::UnsupportedConstruct("round_precision")
        );
        assert_eq!(
            round_number(1.2, 0.0, &mut budget).unwrap_err(),
            EvaluationFailure::UnsupportedConstruct("round_precision")
        );
    }
    let mut budget = WorkBudget::new();
    assert_eq!(
        round_number(f64::MAX, 15.0, &mut budget).unwrap_err(),
        EvaluationFailure::UnsupportedConstruct("round_number_range")
    );
    let mut budget = WorkBudget::constrained(1, 1024);
    assert!(matches!(
        round_number(1.0, 0.0, &mut budget),
        Err(EvaluationFailure::BudgetExceeded(_))
    ));
}
fn evaluate(source: &str, profile: Profile) -> Result<RuntimeValue, EvaluationFailure> {
    let p = Program::compile_with_profile(source, &BTreeMap::new(), profile).unwrap();
    let mut budget = WorkBudget::new();
    let zone = BasesTimezone::capture("UTC", &mut budget)?;
    let clock = CapturedClock::new(1700000000000, zone, &mut budget)?;
    p.evaluate(Bindings::raw(&Map::new()).with_clock(clock), &mut budget)
}
#[test]
fn slice1_admits_round_with_coercion_and_keeps_frozen_profiles_unchanged() {
    for profile in [Profile::Primitive, Profile::Calendar, Profile::Duration] {
        assert!(
            Program::compile_with_profile("(1.25).round(1)", &BTreeMap::new(), profile).is_err()
        );
    }
    assert_eq!(
        evaluate("(1.25).round('1')", Profile::Slice1).unwrap(),
        RuntimeValue::Number(1.3)
    );
    assert_eq!(
        evaluate("(-1.5).round()", Profile::Slice1).unwrap(),
        RuntimeValue::Number(-1.0)
    );
    assert_eq!(
        evaluate("number(duration('1h'))", Profile::Slice1).unwrap(),
        RuntimeValue::Number(3600000.0)
    );
    assert_eq!(
        evaluate("(1.25).round(-1)", Profile::Slice1).unwrap_err(),
        EvaluationFailure::UnsupportedConstruct("round_precision")
    );
}
#[test]
fn english_weekday_and_month_tokens_use_the_captured_gregorian_day() {
    for (day, name) in [
        (7, "Sun"),
        (8, "Mon"),
        (9, "Tue"),
        (10, "Wed"),
        (11, "Thu"),
        (12, "Fri"),
        (13, "Sat"),
    ] {
        let expression = format!("date('2026-06-{day:02}').format('ddd MMM D')");
        assert_eq!(
            evaluate(&expression, Profile::Slice1).unwrap(),
            RuntimeValue::String(format!("{name} Jun {day}"))
        );
    }
    for (month, name) in [
        (1, "Jan"),
        (2, "Feb"),
        (3, "Mar"),
        (4, "Apr"),
        (5, "May"),
        (6, "Jun"),
        (7, "Jul"),
        (8, "Aug"),
        (9, "Sep"),
        (10, "Oct"),
        (11, "Nov"),
        (12, "Dec"),
    ] {
        assert_eq!(
            evaluate(
                &format!("date('2026-{month:02}-01').format('MMM D')"),
                Profile::Slice1
            )
            .unwrap(),
            RuntimeValue::String(format!("{name} 1"))
        );
    }
}
#[test]
fn legacy_formats_and_unsupported_longer_moment_tokens_do_not_silently_change() {
    assert_eq!(
        evaluate("date('2026-06-10').format('ddd')", Profile::Calendar).unwrap_err(),
        EvaluationFailure::UnsupportedConstruct("date_format_token")
    );
    for pattern in ["dddd", "MMMM", "DDD", "DDDD", "SSS"] {
        assert_eq!(
            evaluate(
                &format!("date('2026-06-10').format('{pattern}')"),
                Profile::Slice1
            )
            .unwrap_err(),
            EvaluationFailure::UnsupportedConstruct("date_format_token")
        );
    }
    let mut budget = WorkBudget::new();
    let zone = BasesTimezone::capture("UTC", &mut budget).unwrap();
    let date = DateValue::parse("2026-06-10", zone, &mut budget).unwrap();
    assert_eq!(
        date.format_slice1("[ddd] ddd YYYY-MM-DD", &mut budget)
            .unwrap(),
        "ddd Wed 2026-06-10"
    );
}
