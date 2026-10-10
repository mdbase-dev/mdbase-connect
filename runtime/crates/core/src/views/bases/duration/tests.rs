use super::*;
use crate::{value::Value, yaml};

#[test]
fn preserves_calendar_and_fixed_parts_without_guessed_month_lengths() {
    let mut budget = WorkBudget::new();
    let duration = DurationValue::parse("1y 2M 3w 4d 5h 6m 7s 8ms", &mut budget).unwrap();
    assert_eq!(
        duration.components(),
        [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0]
    );
    assert_eq!(
        duration.fixed_millis(&mut budget).unwrap(),
        25.0 * 86_400_000.0 + 5.0 * 3_600_000.0 + 6.0 * 60_000.0 + 7_008.0
    );
    let months = DurationValue::parse("1M", &mut budget).unwrap();
    let minutes = DurationValue::parse("1m", &mut budget).unwrap();
    assert_ne!(months.components(), minutes.components());
}

#[test]
fn parses_legacy_decimal_sign_and_word_forms() {
    let mut budget = WorkBudget::new();
    let duration = DurationValue::parse(
        "  +1.5 Hours\t-.5 hours\n.25 MINUTES -2 seconds  ",
        &mut budget,
    )
    .unwrap();
    assert_eq!(
        duration.components(),
        [0.0, 0.0, 0.0, 0.0, 1.0, 0.25, -2.0, 0.0]
    );
    assert_eq!(duration.fixed_millis(&mut budget).unwrap(), 3_613_000.0);
    assert_eq!(
        DurationValue::parse("1000ms -1s", &mut budget)
            .unwrap()
            .fixed_millis(&mut budget)
            .unwrap(),
        0.0
    );
}

#[test]
fn garbage_compact_or_unqualified_inputs_never_partially_match() {
    for source in [
        "",
        "junk 1d",
        "1d junk",
        "1h30m",
        "1d, 2h",
        "1e3s",
        "1.s",
        "+",
        ".",
        "1D",
        "1Y",
        "1MS",
        "1hourglass",
        "1日",
    ] {
        let mut budget = WorkBudget::new();
        assert!(
            matches!(
                DurationValue::parse(source, &mut budget),
                Err(EvaluationFailure::UnsupportedConstruct(_))
            ),
            "{source}"
        );
        let failure = budget.failure().unwrap();
        assert_eq!(
            DurationValue::parse("1d", &mut budget).unwrap_err(),
            failure
        );
    }
}

#[test]
fn addition_scaling_do_not_collapse_calendar_values() {
    let mut budget = WorkBudget::new();
    let left = DurationValue::parse("1y 2d", &mut budget).unwrap();
    let right = DurationValue::parse("3M 4h", &mut budget).unwrap();
    let sum = left
        .add(right, &mut budget)
        .unwrap()
        .scale(2.0, &mut budget)
        .unwrap();
    assert_eq!(sum.components(), [2.0, 6.0, 0.0, 4.0, 8.0, 0.0, 0.0, 0.0]);
    let factor = DurationValue::parse("2h", &mut budget)
        .unwrap()
        .scale(-0.5, &mut budget)
        .unwrap();
    assert_eq!(factor.fixed_millis(&mut budget).unwrap(), -3_600_000.0);
}

#[test]
fn range_checks_refuse_nonfinite_and_overflow_without_saturating() {
    for amount in [
        f64::NAN,
        f64::INFINITY,
        -f64::INFINITY,
        MAX_DURATION_COMPONENT + 1.0,
    ] {
        let mut budget = WorkBudget::new();
        assert_eq!(
            DurationValue::from_components([amount; 8], &mut budget).unwrap_err(),
            EvaluationFailure::UnsupportedConstruct("duration_range")
        );
    }
    let mut budget = WorkBudget::new();
    let duration = DurationValue::parse("1000000000d", &mut budget).unwrap();
    assert_eq!(
        duration.scale(2.0, &mut budget).unwrap_err(),
        EvaluationFailure::UnsupportedConstruct("duration_range")
    );
    let mut budget = WorkBudget::new();
    assert_eq!(
        DurationValue::parse("1000000000d 1d", &mut budget).unwrap_err(),
        EvaluationFailure::UnsupportedConstruct("duration_range")
    );
    let mut budget = WorkBudget::new();
    let duration = DurationValue::parse("1d", &mut budget).unwrap();
    assert_eq!(
        duration.scale(f64::INFINITY, &mut budget).unwrap_err(),
        EvaluationFailure::UnsupportedConstruct("duration_scale")
    );
}

#[test]
fn bounded_humanization_uses_legacy_thresholds_and_typed_refusals() {
    for (source, expected) in [
        ("0s", "a few seconds"),
        ("44.999s", "a few seconds"),
        ("45s", "a minute"),
        ("90s", "2 minutes"),
        ("45m", "an hour"),
        ("90m", "2 hours"),
        ("22h", "a day"),
        ("36h", "2 days"),
        ("26d", "a month"),
        ("-2h", "2 hours"),
    ] {
        let mut budget = WorkBudget::new();
        assert_eq!(
            DurationValue::parse(source, &mut budget)
                .unwrap()
                .humanize(&mut budget)
                .unwrap(),
            expected
        );
    }
    for source in ["2M", ".5y", "-1y", "1y 1d", "1M 1y", "45d"] {
        let mut budget = WorkBudget::new();
        assert!(matches!(
            DurationValue::parse(source, &mut budget)
                .unwrap()
                .humanize(&mut budget),
            Err(EvaluationFailure::UnsupportedConstruct(_))
        ));
    }
}

#[test]
fn helper_limits_and_cancellation_stay_request_wide() {
    let mut budget = WorkBudget::new();
    assert_eq!(
        DurationValue::parse(&"a".repeat(MAX_DURATION_SOURCE_BYTES + 1), &mut budget).unwrap_err(),
        EvaluationFailure::BudgetExceeded("duration_source_bytes")
    );
    let mut budget = WorkBudget::constrained(1, 1_048_576);
    assert_eq!(
        DurationValue::parse("1d", &mut budget).unwrap_err(),
        EvaluationFailure::BudgetExceeded("work")
    );
    let mut budget = WorkBudget::constrained(2_000_000, 100);
    assert_eq!(
        DurationValue::parse("1d", &mut budget).unwrap_err(),
        EvaluationFailure::BudgetExceeded("allocation_estimate")
    );
    let mut budget = WorkBudget::new();
    let duration = DurationValue::parse("1h", &mut budget).unwrap();
    budget.fail(EvaluationFailure::Cancelled);
    assert_eq!(
        duration.humanize(&mut budget).unwrap_err(),
        EvaluationFailure::Cancelled
    );
    assert_eq!(
        duration.fixed_millis(&mut budget).unwrap_err(),
        EvaluationFailure::Cancelled
    );
}

#[test]
fn unchanged_oracle_duration_values_match_helper_results() {
    let fixture = yaml::parse_value(include_str!(
        "../../../../tests/data/obsidian-bases-oracle.json"
    ))
    .unwrap()
    .unwrap();
    let cases = fixture.get("cases").unwrap().as_list().unwrap();
    for (name, source, scale) in [
        ("duration year", "1y", 1.0),
        ("duration month", "1M", 1.0),
        ("duration week", "2w", 1.0),
        ("duration day", "1d", 1.0),
        ("duration hour", "1h", 1.0),
        ("duration minute", "30m", 1.0),
        ("duration second", "45s", 1.0),
        ("duration scale", "1h", 2.0),
    ] {
        let mut budget = WorkBudget::new();
        let actual = DurationValue::parse(source, &mut budget)
            .unwrap()
            .scale(scale, &mut budget)
            .unwrap()
            .humanize(&mut budget)
            .unwrap();
        let expected = cases
            .iter()
            .find(|case| case.get("name").and_then(Value::as_str) == Some(name))
            .unwrap()
            .get("expected")
            .unwrap()
            .as_str()
            .unwrap();
        assert_eq!(actual, expected, "{name}");
    }
}
