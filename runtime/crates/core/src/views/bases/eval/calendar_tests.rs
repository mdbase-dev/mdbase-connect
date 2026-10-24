use super::*;
use crate::views::bases::BasesTimezone;
use crate::yaml;

const NOW_MS: i64 = 1_781_075_828_070;

fn clock(budget: &mut WorkBudget) -> CapturedClock {
    let zone = BasesTimezone::capture("Australia/Melbourne", budget).unwrap();
    CapturedClock::new(NOW_MS, zone, budget).unwrap()
}
fn program(source: &str) -> Program {
    Program::compile_with_profile(source, &BTreeMap::new(), Profile::Calendar).unwrap()
}
fn run(source: &str) -> RuntimeValue {
    let mut budget = WorkBudget::new();
    let clock = clock(&mut budget);
    program(source)
        .evaluate(Bindings::raw(&Map::new()).with_clock(clock), &mut budget)
        .unwrap()
}

#[test]
fn captured_date_operations_retain_typed_values_through_formulas_and_lists() {
    let definitions = BTreeMap::from([("due".into(), "date('2026-06-10 12:34:56')".into())]);
    let program = Program::compile_with_profile(
        "[formula.due, formula.due.date()]",
        &definitions,
        Profile::Calendar,
    )
    .unwrap();
    let mut budget = WorkBudget::new();
    let clock = clock(&mut budget);
    let value = program
        .evaluate(Bindings::raw(&Map::new()).with_clock(clock), &mut budget)
        .unwrap();
    let RuntimeValue::List(values) = value else {
        panic!("list cache collapsed")
    };
    assert!(matches!(&values[0], RuntimeValue::Date(d) if !d.is_date_only()));
    assert!(matches!(&values[1], RuntimeValue::Date(d) if d.is_date_only()));
    assert_eq!(
        run("date('2026-06-10 12:34:56').time()").to_plain(),
        Value::string("12:34:56")
    );
}

#[test]
fn date_comparisons_follow_instants_not_rendered_text() {
    assert_eq!(
        run("date('2026-06-10') == date('2026-06-09T14:00:00Z')"),
        RuntimeValue::Bool(true)
    );
    assert_eq!(
        run("date('2026-06-10') < date('2026-06-10T00:00:00Z')"),
        RuntimeValue::Bool(true)
    );
    // Preserve the port's ordinary JSON equality fallback for mixed types.
    assert_eq!(
        run("date('2026-06-10') == '2026-06-10'"),
        RuntimeValue::Bool(true)
    );
    assert_eq!(
        run("number(date('1970-01-02'))"),
        RuntimeValue::Number(50_400_000.0)
    );
}

#[test]
fn date_hints_use_raw_values_and_never_make_missing_or_invalid_values_epochs() {
    let hints = BTreeMap::from([("due".into(), "date".into())]);
    let mut budget = WorkBudget::new();
    let clock = clock(&mut budget);
    let note = Map::from_iter([("due".into(), Value::string("2026-06-10"))]);
    let binding = Bindings::raw(&note)
        .with_property_types(&hints)
        .with_clock(clock);
    assert_eq!(
        program("due <= today()")
            .evaluate(binding, &mut budget)
            .unwrap(),
        RuntimeValue::Bool(true)
    );
    let empty = Map::new();
    let binding = Bindings::raw(&empty).with_property_types(&hints);
    assert_eq!(
        program("due").evaluate(binding, &mut budget).unwrap(),
        RuntimeValue::Null
    );
    for value in [Value::string("invalid"), Value::Int(0), Value::Bool(false)] {
        let note = Map::from_iter([("due".into(), value)]);
        let mut meter = WorkBudget::new();
        assert!(
            program("due.isEmpty()")
                .evaluate(
                    Bindings::raw(&note)
                        .with_property_types(&hints)
                        .with_clock(clock),
                    &mut meter
                )
                .is_err()
        );
        assert!(meter.failure().is_some());
    }
}

#[test]
fn missing_clock_admission_is_reachable_not_ambient_or_branch_dependent() {
    let note = Map::new();
    for source in [
        "now()",
        "date('2026-06-10')",
        "false && now().year > 0",
        "if(true, 1, today())",
    ] {
        assert_eq!(
            program(source).evaluate(Bindings::raw(&note), &mut WorkBudget::new()),
            Err(EvaluationFailure::UnsupportedConstruct(
                "clock_not_captured"
            ))
        );
    }
    let definitions = BTreeMap::from([("unused".into(), "now()".into())]);
    let p = Program::compile_with_profile("1", &definitions, Profile::Calendar).unwrap();
    assert_eq!(
        p.evaluate(Bindings::raw(&note), &mut WorkBudget::new())
            .unwrap(),
        RuntimeValue::Number(1.0)
    );
}

#[test]
fn calendar_refusals_cannot_be_suppressed_and_the_request_meter_is_shared() {
    for source in [
        "date('invalid').isEmpty()",
        "if(date('2026-06-10').format('dd'), 1, 0)",
        "date('2026-06-10') + '1d'",
        "date('2026-06-10') - date('2026-06-09')",
    ] {
        let mut budget = WorkBudget::new();
        let clock = clock(&mut budget);
        assert!(
            program(source)
                .evaluate(Bindings::raw(&Map::new()).with_clock(clock), &mut budget)
                .is_err()
        );
        assert!(budget.failure().is_some());
    }
    let mut budget = WorkBudget::constrained(20_000, 20_000);
    let zone = BasesTimezone::capture("UTC", &mut budget).unwrap();
    let clock = CapturedClock::new(NOW_MS, zone, &mut budget).unwrap();
    let note = Map::new();
    let bindings = Bindings::raw(&note).with_clock(clock);
    let p = program("[today(), now(), date('2026-06-10')]");
    let mut passed = 0;
    while p.evaluate(bindings, &mut budget).is_ok() {
        passed += 1;
        assert!(passed < 100);
    }
    assert!(passed > 0);
    assert!(matches!(
        budget.failure(),
        Some(EvaluationFailure::BudgetExceeded(_))
    ));
    assert!(p.evaluate(bindings, &mut budget).is_err());
    let mut budget = WorkBudget::new();
    assert_eq!(
        p.evaluate_with_cancel(bindings, &mut budget, &|| true),
        Err(EvaluationFailure::Cancelled)
    );
}

#[test]
fn all_original_oracle_cases_have_explicit_calendar_expectations() {
    assert_original_oracle_profile(
        Profile::Calendar,
        include_str!("../../../../tests/data/bases-calendar-admission.yaml"),
        (104, 193),
    );
}

pub(super) fn assert_original_oracle_profile(
    profile: Profile,
    admission: &str,
    counts: (usize, usize),
) {
    let fixture = yaml::parse_value(include_str!(
        "../../../../tests/data/obsidian-bases-oracle.json"
    ))
    .unwrap()
    .unwrap();
    let manifest = yaml::parse_value(admission).unwrap().unwrap();
    let cases = fixture.get("cases").unwrap().as_list().unwrap();
    assert_eq!(cases.len(), 297);
    assert_eq!(manifest.as_map().unwrap().len(), 297);
    let context = fixture.get("context").unwrap();
    let note = context.get("note").unwrap().as_map().unwrap();
    let definitions: BTreeMap<_, _> = context
        .get("formulas")
        .unwrap()
        .as_map()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.to_owned(), v.as_str().unwrap().to_owned()))
        .collect();
    let mut passed = 0;
    let mut refused = 0;
    for case in cases {
        let name = case.get("name").unwrap().as_str().unwrap();
        let source = case.get("expression").unwrap().as_str().unwrap();
        let expected = manifest
            .get(name)
            .expect("every original case has a named expectation");
        let stage = expected.get("stage").unwrap().as_str().unwrap();
        let p = Program::compile_with_profile(source, &definitions, profile);
        if stage == "compile" {
            let e = p.unwrap_err();
            assert_eq!(
                e.kind.code(),
                expected.get("code").unwrap().as_str().unwrap(),
                "{name}"
            );
            assert_eq!(
                e.kind.detail(),
                expected.get("detail").unwrap().as_str().unwrap(),
                "{name}"
            );
            refused += 1;
        } else {
            let mut budget = WorkBudget::new();
            let clock = clock(&mut budget);
            let value = p
                .unwrap()
                .evaluate(Bindings::raw(note).with_clock(clock), &mut budget);
            if stage == "evaluate" {
                let e = value.unwrap_err();
                assert_eq!(
                    e.code(),
                    expected.get("code").unwrap().as_str().unwrap(),
                    "{name}"
                );
                assert_eq!(
                    e.detail(),
                    expected.get("detail").unwrap().as_str().unwrap(),
                    "{name}"
                );
                refused += 1;
            } else {
                assert_eq!(stage, "value");
                assert_eq!(
                    &value.unwrap().to_plain(),
                    case.get("expected").unwrap(),
                    "original oracle mismatch: {name}"
                );
                passed += 1;
            }
        }
    }
    assert_eq!((passed, refused), counts);
}
