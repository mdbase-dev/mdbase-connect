use super::*;
use crate::views::bases::BasesTimezone;

fn run(source: &str) -> Result<RuntimeValue, EvaluationFailure> {
    let p = Program::compile_with_profile(source, &BTreeMap::new(), Profile::Duration).unwrap();
    let mut budget = WorkBudget::new();
    let zone = BasesTimezone::capture("UTC", &mut budget).unwrap();
    let clock = CapturedClock::new(1_781_075_828_070, zone, &mut budget).unwrap();
    p.evaluate(Bindings::raw(&Map::new()).with_clock(clock), &mut budget)
}
#[test]
fn typed_duration_globals_scaling_addition_and_numeric_coercion() {
    let RuntimeValue::Duration(v) = run("duration('1h')").unwrap() else {
        panic!("duration collapsed")
    };
    assert_eq!(
        v.value().components(),
        [0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0]
    );
    assert_eq!(v.display(), "an hour");
    assert_eq!(
        run("(duration('1h') * 2).toString()").unwrap().to_plain(),
        Value::string("2 hours")
    );
    assert_eq!(
        run("number(duration('1d') + duration('2h'))").unwrap(),
        RuntimeValue::Number(93_600_000.0)
    );
    assert_eq!(
        run("duration('1h').isType('Duration')").unwrap(),
        RuntimeValue::Bool(true)
    );
    assert_eq!(
        run("duration('0ms').isEmpty()").unwrap(),
        RuntimeValue::Bool(false)
    );
    assert_eq!(
        run("duration('0ms').isTruthy()").unwrap(),
        RuntimeValue::Bool(true)
    );
    assert_eq!(
        run("(2 * duration('1h')).toString()").unwrap().to_plain(),
        Value::Map(Map::from_iter([(
            "error".into(),
            Value::string("Invalid operator between Number and Duration")
        )]))
    );
}
#[test]
fn qualified_date_overloads_preserve_units_order_and_intent() {
    assert_eq!(
        run("date('2026-01-31') + '1M'").unwrap().to_plain(),
        Value::string("2026-02-28")
    );
    assert_eq!(
        run("date('2024-01-31') + '1M 1d'").unwrap().to_plain(),
        Value::string("2024-03-01")
    );
    assert_eq!(
        run("date('2026-06-10') - duration('1d')")
            .unwrap()
            .to_plain(),
        Value::string("2026-06-09")
    );
    let RuntimeValue::Date(v) = run("date('2026-06-10') + duration('1h')").unwrap() else {
        panic!("date collapsed")
    };
    assert!(v.is_date_only());
    assert_eq!(v.display(), "2026-06-10");
    assert_eq!(
        run("number(date('2026-06-11') - date('2026-06-10'))").unwrap(),
        RuntimeValue::Number(86_400_000.0)
    );
    assert_eq!(
        run("(date('2026-06-11') - date('2026-06-10')).isType('Duration')").unwrap(),
        RuntimeValue::Bool(true)
    );
}
#[test]
fn typed_durations_survive_formula_memoization_and_nested_values() {
    let formulas = BTreeMap::from([("span".into(), "duration('1h')".into())]);
    let p = Program::compile_with_profile(
        "[formula.span, formula.span * 2]",
        &formulas,
        Profile::Duration,
    )
    .unwrap();
    let value = p
        .evaluate(Bindings::raw(&Map::new()), &mut WorkBudget::new())
        .unwrap();
    let RuntimeValue::List(values) = value else {
        panic!("list")
    };
    assert!(
        values
            .iter()
            .all(|v| matches!(v, RuntimeValue::Duration(_)))
    );
    let RuntimeValue::Duration(v) = &values[1] else {
        panic!("duration")
    };
    assert_eq!(v.value().components()[4], 2.0);
    assert_eq!(
        run("[duration('1h')].contains('an hour')").unwrap(),
        RuntimeValue::Bool(true),
        "legacy JSON equality fallback"
    );
}
#[test]
fn unqualified_arithmetic_and_rendering_refuse_stickily() {
    for (source, detail) in [
        (
            "date('2026-06-10') + '0.5M'",
            "fractional_calendar_duration",
        ),
        ("date('2026-06-10') + '0.5ms'", "submillisecond_date"),
        ("date('2026-06-10') + 1", "date_arithmetic"),
        ("number(duration('1M'))", "calendar_duration_number"),
        ("duration('2M')", "calendar_duration_humanization"),
        ("duration('60d')", "long_duration_humanization"),
        ("date('2026-07-10') - date('2026-06-10')", "duration_range"),
        (
            "if(duration('junk 1d').isTruthy(), 1, 2)",
            "duration_syntax",
        ),
    ] {
        let e = run(source).unwrap_err();
        assert_eq!(e.detail(), detail, "{source}");
    }
}
#[test]
fn frozen_profiles_do_not_silently_gain_duration_capabilities() {
    for profile in [Profile::Primitive, Profile::Calendar] {
        assert_eq!(
            Program::compile_with_profile("duration('1d')", &BTreeMap::new(), profile)
                .unwrap_err()
                .kind
                .detail(),
            "global_function"
        );
    }
    let p = Program::compile_with_profile("duration('1h')", &BTreeMap::new(), Profile::Duration)
        .unwrap();
    assert!(
        p.evaluate(Bindings::raw(&Map::new()), &mut WorkBudget::new())
            .is_ok(),
        "duration alone needs no clock"
    );
    let p = Program::compile_with_profile(
        "if(true, 1, date('2026-06-10') + '1d')",
        &BTreeMap::new(),
        Profile::Duration,
    )
    .unwrap();
    assert_eq!(
        p.evaluate(Bindings::raw(&Map::new()), &mut WorkBudget::new())
            .unwrap_err()
            .detail(),
        "clock_not_captured"
    );
}
#[test]
fn all_original_oracle_cases_have_explicit_duration_expectations() {
    super::calendar_tests::assert_original_oracle_profile(
        Profile::Duration,
        include_str!("../../../../tests/data/bases-duration-values-admission.yaml"),
        (117, 180),
    );
}

#[test]
fn cancellation_and_shared_budget_failures_never_become_duration_values() {
    let p = Program::compile_with_profile("duration('1h')", &BTreeMap::new(), Profile::Duration)
        .unwrap();
    assert_eq!(
        p.evaluate_with_cancel(Bindings::raw(&Map::new()), &mut WorkBudget::new(), &|| true)
            .unwrap_err()
            .code(),
        "query_cancelled"
    );
    assert_eq!(
        p.evaluate(
            Bindings::raw(&Map::new()),
            &mut WorkBudget::constrained(2_000_000, 1)
        )
        .unwrap_err()
        .code(),
        "query_budget_exceeded"
    );
}
