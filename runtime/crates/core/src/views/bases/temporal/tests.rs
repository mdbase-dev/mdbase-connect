use super::*;
use crate::{value::Value, yaml};

fn utc(budget: &mut WorkBudget) -> BasesTimezone {
    BasesTimezone::capture("UTC", budget).unwrap()
}
fn parse(source: &str, budget: &mut WorkBudget) -> DateValue {
    DateValue::parse(source, utc(budget), budget).unwrap()
}

#[test]
fn canonical_fast_formats_match_general_tokens_and_exact_meter_state() {
    let verify = |date: DateValue| {
        for pattern in [
            "YYYY-MM-DD",
            "yyyy-MM-DD",
            "YYYY-MM-DDTHH:mm:ss",
            "yyyy-MM-DDTHH:mm:ss",
        ] {
            for slice1 in [false, true] {
                let mut fast = WorkBudget::new();
                let mut general = WorkBudget::new();
                assert_eq!(
                    date.format_inner_with_fast_path(pattern, &mut fast, slice1, true),
                    date.format_inner_with_fast_path(pattern, &mut general, slice1, false)
                );
                assert_eq!(
                    format!("{fast:?}"),
                    format!("{general:?}"),
                    "all work and allocation reservations must remain identical"
                );
            }
        }
    };
    for source in [
        "0001-01-01",
        "0009-02-03",
        "0099-11-12",
        "0100-03-04",
        "0999-05-06",
        "1000-07-08",
        "9999-12-31",
    ] {
        verify(parse(source, &mut WorkBudget::new()));
    }
    for name in [
        "UTC",
        "+05:45",
        "-03:30",
        "Pacific/Kiritimati",
        "Australia/Lord_Howe",
        "US/Eastern",
        "America/New_York",
    ] {
        for source in [
            "1969-12-31T23:59:59.999Z",
            "1970-01-01T00:00:00Z",
            "2024-02-29T12:34:56Z",
            "2026-03-08T07:00:00Z",
            "2026-11-01T06:00:00Z",
            "2026-06-10",
        ] {
            let mut work = WorkBudget::new();
            let zone = BasesTimezone::capture(name, &mut work).unwrap();
            verify(DateValue::parse(source, zone, &mut work).unwrap());
        }
    }
}

#[test]
fn canonical_fast_formats_preserve_every_exhaustion_and_sticky_failure_boundary() {
    let date = parse("2026-06-10 12:34:56", &mut WorkBudget::new());
    for pattern in ["YYYY-MM-DD", "YYYY-MM-DDTHH:mm:ss"] {
        for steps in 0..=15 {
            for bytes in [0, 1, 167, 168, 169, 203, 204, 205, 1024] {
                let mut fast = WorkBudget::constrained(steps, bytes);
                let mut general = WorkBudget::constrained(steps, bytes);
                assert_eq!(
                    date.format_inner_with_fast_path(pattern, &mut fast, true, true),
                    date.format_inner_with_fast_path(pattern, &mut general, true, false)
                );
                assert_eq!(format!("{fast:?}"), format!("{general:?}"));
                assert_eq!(
                    date.format_inner_with_fast_path(pattern, &mut fast, true, true),
                    date.format_inner_with_fast_path(pattern, &mut general, true, false),
                    "reuse must preserve the same sticky meter"
                );
                assert_eq!(format!("{fast:?}"), format!("{general:?}"));
            }
        }
    }
    let mut fast = WorkBudget::new();
    let mut general = WorkBudget::new();
    fast.fail(EvaluationFailure::Cancelled);
    general.fail(EvaluationFailure::Cancelled);
    assert_eq!(
        date.format_inner_with_fast_path("YYYY-MM-DD", &mut fast, true, true),
        date.format_inner_with_fast_path("YYYY-MM-DD", &mut general, true, false)
    );
    assert_eq!(format!("{fast:?}"), format!("{general:?}"));
}

#[test]
fn explicit_zones_never_substitute_local_or_unknown_names() {
    for name in [
        "",
        "local",
        "Not/AZone",
        "+24:00",
        "+03:60",
        "+3:00",
        "+03:xx",
        " UTC",
        "UTC ",
    ] {
        let mut budget = WorkBudget::new();
        assert!(matches!(
            BasesTimezone::capture(name, &mut budget),
            Err(EvaluationFailure::UnsupportedConstruct(_))
        ));
        let failure = budget.failure().unwrap();
        assert_eq!(
            BasesTimezone::capture("UTC", &mut budget).unwrap_err(),
            failure
        );
    }
    for (name, ms) in [
        ("UTC", 0),
        ("Z", 0),
        ("+05:30", -19_800_000),
        ("-03:30", 12_600_000),
    ] {
        let mut budget = WorkBudget::new();
        let zone = BasesTimezone::capture(name, &mut budget).unwrap();
        assert_eq!(
            DateValue::parse("1970-01-01", zone, &mut budget)
                .unwrap()
                .millis(),
            ms
        );
    }
}

#[test]
fn negative_milliseconds_and_offset_inputs_keep_calendar_fields() {
    let mut budget = WorkBudget::new();
    let zone = utc(&mut budget);
    let date = DateValue::from_millis(-1, false, zone, &mut budget).unwrap();
    assert_eq!(date.plain(&mut budget).unwrap(), "1969-12-31T23:59:59");
    assert_eq!(date.property("millisecond", &mut budget).unwrap(), 999);
    assert_eq!(date.date(&mut budget).unwrap().millis(), -86_400_000);
    let date = DateValue::parse("2026-06-10T12:34:56.123+10:00", zone, &mut budget).unwrap();
    assert_eq!(date.plain(&mut budget).unwrap(), "2026-06-10T02:34:56");
    assert_eq!(date.property("millisecond", &mut budget).unwrap(), 123);
}

#[test]
fn now_and_today_are_one_immutable_capture_across_calls() {
    let mut budget = WorkBudget::new();
    let zone = BasesTimezone::capture("Australia/Melbourne", &mut budget).unwrap();
    let instant = DateValue::parse("2026-06-10T07:17:08Z", zone, &mut budget)
        .unwrap()
        .millis();
    let clock = CapturedClock::new(instant, zone, &mut budget).unwrap();
    assert_eq!(clock.now(&mut budget).unwrap().millis(), instant);
    assert_eq!(
        clock.now(&mut budget).unwrap().plain(&mut budget).unwrap(),
        "2026-06-10T17:17:08"
    );
    let today = clock.today(&mut budget).unwrap();
    assert!(today.is_date_only());
    assert_eq!(today.plain(&mut budget).unwrap(), "2026-06-10");
    assert_eq!(today.property("hour", &mut budget).unwrap(), 0);
}

#[test]
fn month_end_and_leap_year_clamp_without_unchanged_date_fallbacks() {
    let mut budget = WorkBudget::new();
    for (source, months, expected) in [
        ("2024-01-31", 1, "2024-02-29"),
        ("2025-01-31", 1, "2025-02-28"),
        ("2024-03-31", -1, "2024-02-29"),
        ("2026-12-01", 1, "2027-01-01"),
        ("2024-02-29", 12, "2025-02-28"),
    ] {
        assert_eq!(
            parse(source, &mut budget)
                .add_months(months, &mut budget)
                .unwrap()
                .plain(&mut budget)
                .unwrap(),
            expected
        );
    }
    let date = parse("2026-06-10", &mut budget);
    assert_eq!(
        date.add_months(i64::MAX, &mut budget).unwrap_err(),
        EvaluationFailure::UnsupportedConstruct("date_range")
    );
}

#[test]
fn fixed_span_days_remain_distinct_from_calendar_days_across_dst() {
    let mut budget = WorkBudget::new();
    let zone = BasesTimezone::capture("Australia/Melbourne", &mut budget).unwrap();
    let date = DateValue::parse("2026-10-03 12:00:00", zone, &mut budget).unwrap();
    assert_eq!(
        date.add_millis(DAY_MS, &mut budget)
            .unwrap()
            .plain(&mut budget)
            .unwrap(),
        "2026-10-04T13:00:00"
    );
    // This ports fixed-span arithmetic; calendar-day correction/qualification
    // belongs to the later duration overload adapter, not this utility.
}

#[test]
fn unqualified_local_folds_gaps_invalid_dates_and_precision_refuse() {
    for source in ["2026-04-05 02:30:00", "2026-10-04 02:30:00"] {
        let mut budget = WorkBudget::new();
        let zone = BasesTimezone::capture("Australia/Melbourne", &mut budget).unwrap();
        assert!(matches!(
            DateValue::parse(source, zone, &mut budget),
            Err(EvaluationFailure::UnsupportedConstruct(
                "local_time_ambiguous" | "local_time_gap"
            ))
        ));
    }
    for source in [
        "not a date",
        "2025-02-29",
        "2026-02-30",
        "0000-01-01",
        "2026-01-01 24:00:00",
        "2026-01-01T12:00:60Z",
        "2026-01-01T00:00:00.000001Z",
        "éééé-éé-éé",
    ] {
        let mut budget = WorkBudget::new();
        let zone = utc(&mut budget);
        assert!(matches!(
            DateValue::parse(source, zone, &mut budget),
            Err(EvaluationFailure::UnsupportedConstruct(_))
        ));
    }
    let mut budget = WorkBudget::new();
    let zone = utc(&mut budget);
    assert_eq!(
        DateValue::from_millis(i64::MAX, false, zone, &mut budget).unwrap_err(),
        EvaluationFailure::UnsupportedConstruct("date_range")
    );
}

#[test]
fn format_literals_and_iso_week_are_bounded_not_strftime_passthrough() {
    let mut budget = WorkBudget::new();
    let date = parse("2026-06-10 12:34:56", &mut budget);
    assert_eq!(
        date.format("[YYYY] YYYY/MM/DD [at] HH:mm:ss", &mut budget)
            .unwrap(),
        "YYYY 2026/06/10 at 12:34:56"
    );
    for (source, week) in [
        ("2016-01-01", "53"),
        ("2021-01-01", "53"),
        ("2020-12-31", "53"),
        ("2026-06-10", "24"),
        ("2024-12-30", "01"),
    ] {
        assert_eq!(
            parse(source, &mut budget)
                .format("WW", &mut budget)
                .unwrap(),
            week
        );
    }
    for pattern in ["ddd", "MMM D", "%Y", "[unterminated", "]"] {
        let mut budget = WorkBudget::new();
        let date = parse("2026-06-10", &mut budget);
        assert!(matches!(
            date.format(pattern, &mut budget),
            Err(EvaluationFailure::UnsupportedConstruct(_))
        ));
    }
}

#[test]
fn helpers_share_sticky_work_allocations_and_cancellation() {
    let mut budget = WorkBudget::constrained(1, 1_048_576);
    let zone = utc(&mut budget);
    assert!(matches!(
        DateValue::parse("2026-06-10", zone, &mut budget),
        Err(EvaluationFailure::BudgetExceeded("work"))
    ));
    let mut budget = WorkBudget::new();
    let zone = utc(&mut budget);
    let date = DateValue::parse("2026-06-10", zone, &mut budget).unwrap();
    budget.fail(EvaluationFailure::Cancelled);
    assert_eq!(
        date.format("YYYY", &mut budget).unwrap_err(),
        EvaluationFailure::Cancelled
    );
    let mut budget = WorkBudget::new();
    let zone = utc(&mut budget);
    assert_eq!(
        DateValue::parse(&"x".repeat(MAX_DATE_SOURCE_BYTES + 1), zone, &mut budget).unwrap_err(),
        EvaluationFailure::BudgetExceeded("date_source_bytes")
    );
    let mut budget = WorkBudget::new();
    let date = parse("2026-06-10", &mut budget);
    assert_eq!(
        date.format(&"-".repeat(MAX_DATE_PATTERN_BYTES + 1), &mut budget)
            .unwrap_err(),
        EvaluationFailure::BudgetExceeded("date_pattern_bytes")
    );
    let mut budget = WorkBudget::constrained(2_000_000, 100);
    assert_eq!(
        date.format("YYYY", &mut budget).unwrap_err(),
        EvaluationFailure::BudgetExceeded("allocation_estimate")
    );
}

#[test]
fn helpers_compare_exact_values_to_unchanged_legacy_oracle() {
    let fixture = yaml::parse_value(include_str!(
        "../../../../tests/data/obsidian-bases-oracle.json"
    ))
    .unwrap()
    .unwrap();
    let cases = fixture.get("cases").unwrap().as_list().unwrap();
    let mut budget = WorkBudget::new();
    let zone = BasesTimezone::capture("Australia/Melbourne", &mut budget).unwrap();
    let date = DateValue::parse("2026-06-10 12:34:56", zone, &mut budget).unwrap();
    let day = DateValue::parse("2026-06-10", zone, &mut budget).unwrap();
    let mut checks: Vec<(&str, Value)> = vec![
        (
            "number from date",
            Value::Int(
                DateValue::parse("1970-01-02", zone, &mut budget)
                    .unwrap()
                    .millis(),
            ),
        ),
        (
            "date parse date-only",
            Value::string(day.plain(&mut budget).unwrap()),
        ),
        (
            "date parse datetime",
            Value::string(date.plain(&mut budget).unwrap()),
        ),
        (
            "date format",
            Value::string(day.format("YYYY-MM-DD", &mut budget).unwrap()),
        ),
        (
            "date strip time",
            Value::string(date.date(&mut budget).unwrap().plain(&mut budget).unwrap()),
        ),
        (
            "date time",
            Value::string(date.format("HH:mm:ss", &mut budget).unwrap()),
        ),
    ];
    for name in ["year", "month", "day", "hour", "minute", "second"] {
        checks.push((
            match name {
                "year" => "date field year",
                "month" => "date field month",
                "day" => "date field day",
                "hour" => "date field hour",
                "minute" => "date field minute",
                _ => "date field second",
            },
            Value::Int(date.property(name, &mut budget).unwrap()),
        ));
    }
    for (name, value) in checks {
        let expected = cases
            .iter()
            .find(|case| case.get("name").and_then(Value::as_str) == Some(name))
            .unwrap()
            .get("expected")
            .unwrap();
        assert_eq!(&value, expected, "{name}");
    }
}
