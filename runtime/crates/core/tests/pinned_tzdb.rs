//! Named IANA zones use the pinned embedded rules on every target.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use mdbn_core::cel::time::{NamedZone, TimeZoneRules, Timestamp, tzdb};
use mdbn_core::cel::{Activation, CelValue, compile};
use mdbn_core::lifecycle::cel_clock;
use mdbn_core::semantics::{SEM, SEMANTICS, Sem};

#[test]
fn every_name_agrees_with_pinned_python_zoneinfo() {
    let mut count = 0;
    let mut cached = None;
    for line in include_str!("data/tzdb-2026e-offsets.txt")
        .lines()
        .filter(|s| !s.starts_with('#'))
    {
        let mut fields = line.split(' ');
        let name = fields.next().unwrap();
        let seconds: i64 = fields.next().unwrap().parse().unwrap();
        let offset: i32 = fields.next().unwrap().parse().unwrap();
        if cached.is_none_or(|(n, _)| n != name) {
            cached = Some((name, NamedZone::get(name).unwrap()));
        }
        assert_eq!(
            cached.unwrap().1.offset_at(seconds),
            offset,
            "{name} at {seconds}"
        );
        count += 1;
    }
    assert_eq!(count, 5397);
}

fn eval(expression: &str, zone: &str) -> Result<CelValue, String> {
    let mut activation = Activation::new();
    activation.with_clock(cel_clock(1_767_225_600_000, "2026-01-01", zone));
    compile(expression)
        .unwrap()
        .evaluate(&activation)
        .map_err(|e| e.message)
}

fn check(expression: &str, zone: &str) {
    assert!(
        matches!(eval(expression, zone), Ok(CelValue::Bool(true))),
        "{expression}: {:?}",
        eval(expression, zone)
    );
}

#[test]
fn named_accessors_use_the_requested_zone_and_preserve_fixed_offsets() {
    check(
        "timestamp('2026-10-03T15:59:59Z').getHours('Australia/Melbourne') == 1 && timestamp('2026-10-03T16:00:00Z').getHours('Australia/Melbourne') == 3",
        "UTC",
    );
    check(
        "timestamp('2026-07-01T00:00:00Z').getHours('US/Eastern') == 20 && timestamp('2026-07-01T00:00:00Z').getDate('US/Eastern') == 30",
        "UTC",
    );
    check(
        "timestamp('2026-01-01T00:00:00Z').getHours() == 0 && timestamp('2026-01-01T00:00:00Z').getHours('+10:00') == 10",
        "Australia/Melbourne",
    );
    check(
        "timestamp('2026-01-01T00:00:00Z').getMinutes('Asia/Kathmandu') == 45",
        "UTC",
    );
    check(
        "timestamp('2026-01-01T00:00:00Z').getHours('Etc/GMT+5') == 19",
        "UTC",
    );
}

#[test]
fn captured_clock_uses_pinned_rules_for_date_and_start_of_day() {
    check(
        "date(timestamp('2026-06-20T15:30:00Z')) == '2026-06-21' && startOfDay('2026-06-20') == timestamp('2026-06-19T14:00:00Z')",
        "Australia/Melbourne",
    );
    check(
        "startOfDay('2026-09-06') == timestamp('2026-09-06T04:00:00Z')",
        "America/Santiago",
    );
    check(
        "date(startOfDay('2011-12-30')) == '2011-12-31'",
        "Pacific/Apia",
    );
    // Captured local_date is authoritative for today(), not recomputed from now().
    check(
        "today() == '2026-01-01' && now() == timestamp('2026-01-01T00:00:00Z')",
        "America/New_York",
    );
}

#[test]
fn unknown_names_never_fall_back_to_utc() {
    for expression in [
        "date(now())",
        "startOfDay('2026-01-01')",
        "now().getHours('Mars/Olympus')",
        "now().getHours('+1é:2')",
    ] {
        assert!(
            eval(expression, "Mars/Olympus")
                .unwrap_err()
                .contains("unsupported_timezone")
        );
    }
    check("today() == '2026-01-01'", "Mars/Olympus");
    assert!(NamedZone::get("australia/Melbourne").is_err());
}

#[test]
fn aliases_and_full_history_are_retained() {
    for second in [
        Timestamp::parse("1880-01-01T00:00:00Z").unwrap().seconds,
        0,
        1_767_225_600,
        Timestamp::parse("2400-07-01T00:00:00Z").unwrap().seconds,
    ] {
        assert_eq!(
            NamedZone::get("US/Eastern").unwrap().offset_at(second),
            NamedZone::get("America/New_York")
                .unwrap()
                .offset_at(second)
        );
    }
    assert_eq!(
        NamedZone::get("Asia/Kolkata")
            .unwrap()
            .offset_at(Timestamp::parse("1880-01-01T00:00:00Z").unwrap().seconds),
        19_270
    );
}

#[test]
fn semantics_registry_names_the_embedded_release() {
    assert_eq!(SEM, Sem { major: 1, minor: 1 });
    assert_eq!(SEMANTICS[0].sem, Sem { major: 1, minor: 0 });
    assert_eq!(SEMANTICS[0].tzdb, None);
    assert_eq!(SEMANTICS.last().unwrap().tzdb, Some(tzdb::RELEASE));
}
