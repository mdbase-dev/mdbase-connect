use super::super::{
    ErrorKind, MAX_ALLOCATION_BYTES, MAX_FORMULAS, MAX_PROGRAM_NODES, MAX_PROGRAM_SOURCE_BYTES,
    MAX_WORK_STEPS,
};
use super::*;
use crate::yaml;

fn run(source: &str) -> RuntimeValue {
    Program::compile(source, &BTreeMap::new())
        .unwrap()
        .evaluate(Bindings::raw(&Map::new()), &mut WorkBudget::new())
        .unwrap()
}

#[test]
fn primitive_values_keep_bases_truthiness_not_cel_semantics() {
    assert!(!RuntimeValue::Null.is_truthy());
    assert!(!RuntimeValue::Number(f64::NAN).is_truthy());
    assert!(RuntimeValue::List(vec![]).is_truthy());
    assert!(RuntimeValue::Object(BTreeMap::new()).is_truthy());
    assert!(!RuntimeValue::Bool(false).is_empty());
    assert!(!RuntimeValue::Number(0.0).is_empty());
    assert!(RuntimeValue::Number(f64::NAN).is_empty());
    assert!(RuntimeValue::List(vec![]).is_empty());
    assert_eq!(run("list(missing)"), RuntimeValue::Null);
    assert_eq!(run("list(missing).map(value).length"), RuntimeValue::Null);
}

#[test]
fn lazy_branches_do_not_evaluate_ordinary_errors_or_allocate_unselected_outputs() {
    for source in [
        "if(true, 7, number('nope'))",
        "if(false, 'x'.repeat(999999999), 7)",
    ] {
        assert_eq!(run(source).to_plain(), Value::Int(7));
    }
    assert_eq!(run("true || number('nope')"), RuntimeValue::Bool(true));
    assert_eq!(run("false && number('nope')"), RuntimeValue::Bool(false));
    assert_eq!(run("!number('nope')"), RuntimeValue::Bool(true));
    assert!(matches!(run("number('nope')"), RuntimeValue::Error(_)));
    assert_eq!(run("1 + 2 * 3"), RuntimeValue::Number(7.0));
    assert_eq!(run("7 / 2"), RuntimeValue::Number(3.5));
}

#[test]
fn formula_programs_are_owned_and_validate_reachable_dependencies() {
    let mut formulas = BTreeMap::from([
        ("total".into(), "price * quantity".into()),
        ("twice".into(), "formula.total + formula.total".into()),
        ("unused-date".into(), "date(file.ctime)".into()),
    ]);
    let program = Program::compile("formula.twice", &formulas).unwrap();
    formulas.insert("total".into(), "0".into());
    let note = Map::from_iter([
        ("price".into(), Value::Float(12.5)),
        ("quantity".into(), Value::Int(4)),
    ]);
    assert_eq!(
        program
            .evaluate(Bindings::raw(&note), &mut WorkBudget::new())
            .unwrap(),
        RuntimeValue::Number(100.0)
    );
    assert!(matches!(
        Program::compile("formula['unused-date']", &formulas)
            .unwrap_err()
            .kind,
        ErrorKind::UnsupportedConstruct(_)
    ));
    assert_eq!(
        Program::compile("formula.nope", &formulas)
            .unwrap_err()
            .kind,
        ErrorKind::InvalidSource("unresolved_formula")
    );
    formulas.insert("a".into(), "formula.b".into());
    formulas.insert("b".into(), "formula.a".into());
    assert_eq!(
        Program::compile("formula.a", &formulas).unwrap_err().kind,
        ErrorKind::FormulaCycle
    );
    assert!(Program::compile("1", &formulas).is_ok()); // unreachable cycle isn't evaluated
    formulas.insert("unused-bad-syntax".into(), "(".into());
    assert!(matches!(
        Program::compile("1", &formulas).unwrap_err().kind,
        ErrorKind::InvalidSource(_)
    ));
}

#[test]
fn declaration_limits_are_cumulative_not_reset_per_formula() {
    let many: BTreeMap<_, _> = (0..MAX_FORMULAS + 1)
        .map(|i| (format!("f{i}"), "1".into()))
        .collect();
    assert_eq!(
        Program::compile("1", &many).unwrap_err().kind,
        ErrorKind::BudgetExceeded("formula_count")
    );
    let bytes: BTreeMap<_, _> = (0..20)
        .map(|i| (format!("f{i}"), format!("'{}'", "a".repeat(4000))))
        .collect();
    assert!(bytes.values().map(String::len).sum::<usize>() > MAX_PROGRAM_SOURCE_BYTES);
    assert_eq!(
        Program::compile("1", &bytes).unwrap_err().kind,
        ErrorKind::BudgetExceeded("program_source_bytes")
    );
    let wide = format!("[{}]", vec!["0"; 300].join(","));
    let nodes: BTreeMap<_, _> = (0..20).map(|i| (format!("f{i}"), wide.clone())).collect();
    assert!(nodes.len() * 301 > MAX_PROGRAM_NODES);
    assert_eq!(
        Program::compile("1", &nodes).unwrap_err().kind,
        ErrorKind::BudgetExceeded("program_nodes")
    );
}

#[test]
fn repeated_formula_dag_references_do_not_expand_exponentially_in_admission() {
    let mut formulas = BTreeMap::from([("f0".into(), "1".into())]);
    for i in 1..12 {
        formulas.insert(
            format!("f{i}"),
            format!("formula.f{} + formula.f{}", i - 1, i - 1),
        );
    }
    assert!(Program::compile("formula.f11", &formulas).is_ok());
    assert_eq!(
        Program::compile("formula['f0']", &formulas)
            .unwrap()
            .evaluate(Bindings::raw(&Map::new()), &mut WorkBudget::new())
            .unwrap(),
        RuntimeValue::Number(1.0)
    );
    assert!(matches!(
        Program::compile("formula[key]", &formulas)
            .unwrap_err()
            .kind,
        ErrorKind::UnsupportedConstruct(_)
    ));
}

#[test]
fn data_and_lazy_expression_failures_stay_out_of_band() {
    for source in [
        "!x",
        "x || true",
        "x && false",
        "if(x, 1, 2)",
        "[1].map(!value)",
        "[1].filter(!value)",
        "[1].reduce(!value, 0)",
    ] {
        let program = Program::compile(source, &BTreeMap::new()).unwrap();
        let mut budget = WorkBudget::constrained(2, MAX_ALLOCATION_BYTES);
        assert!(matches!(
            program.evaluate(Bindings::raw(&Map::new()), &mut budget),
            Err(EvaluationFailure::BudgetExceeded(_))
        ));
        let failure = budget.failure();
        assert_eq!(
            program
                .evaluate(Bindings::raw(&Map::new()), &mut budget)
                .unwrap_err(),
            failure.unwrap()
        );
    }
    let note = Map::from_iter([("typed".into(), Value::string("[[Project]]"))]);
    assert_eq!(
        Program::compile("!typed", &BTreeMap::new())
            .unwrap()
            .evaluate(Bindings::raw(&note), &mut WorkBudget::new()),
        Err(EvaluationFailure::UnsupportedConstruct("link_property"))
    );
}

#[test]
fn cancellation_is_sticky_even_in_boolean_and_fold_branches() {
    let calls = std::cell::Cell::new(0);
    let cancelled = || {
        calls.set(calls.get() + 1);
        calls.get() >= 3
    };
    let program = Program::compile("[1,2,3].map(!value)", &BTreeMap::new()).unwrap();
    let mut budget = WorkBudget::new();
    assert_eq!(
        program.evaluate_with_cancel(Bindings::raw(&Map::new()), &mut budget, &cancelled),
        Err(EvaluationFailure::Cancelled)
    );
    assert_eq!(run("1"), RuntimeValue::Number(1.0));
    assert_eq!(
        Program::compile("1", &BTreeMap::new())
            .unwrap()
            .evaluate(Bindings::raw(&Map::new()), &mut budget),
        Err(EvaluationFailure::Cancelled)
    );
}

#[test]
fn shared_meter_accumulates_work_across_rows_and_cannot_be_widened() {
    let budget = WorkBudget::constrained(u64::MAX, u64::MAX);
    assert_eq!(budget.remaining_steps(), MAX_WORK_STEPS);
    let program = Program::compile("1", &BTreeMap::new()).unwrap();
    let mut budget = WorkBudget::constrained(5, MAX_ALLOCATION_BYTES);
    assert!(
        program
            .evaluate(Bindings::raw(&Map::new()), &mut budget)
            .is_ok()
    );
    assert!(matches!(
        program.evaluate(Bindings::raw(&Map::new()), &mut budget),
        Err(EvaluationFailure::BudgetExceeded("work"))
    ));
}

#[test]
fn allocating_methods_refuse_before_large_output_and_cannot_return_falsey_success() {
    for source in [
        "'x'.repeat(999999999)",
        "!'x'.repeat(999999999)",
        "if('x'.repeat(999999999), 1, 2)",
        "(1).abs('x'.repeat(999999999))",
    ] {
        assert!(matches!(
            Program::compile(source, &BTreeMap::new())
                .unwrap()
                .evaluate(Bindings::raw(&Map::new()), &mut WorkBudget::new()),
            Err(EvaluationFailure::BudgetExceeded(_))
        ));
    }
    let program = Program::compile("x", &BTreeMap::new()).unwrap();
    let mut deep = Value::Null;
    for _ in 0..MAX_VALUE_DEPTH {
        deep = Value::List(vec![deep]);
    }
    let note = Map::from_iter([("x".into(), deep)]);
    assert_eq!(
        program.evaluate(Bindings::raw(&note), &mut WorkBudget::new()),
        Err(EvaluationFailure::BudgetExceeded("value_depth"))
    );
    assert!(matches!(
        Program::compile("[1,2,3].reduce([acc], [])", &BTreeMap::new())
            .unwrap()
            .evaluate(
                Bindings::raw(&Map::new()),
                &mut WorkBudget::constrained(MAX_WORK_STEPS, 100)
            ),
        Err(EvaluationFailure::BudgetExceeded(_))
    ));
}

#[test]
fn exact_custom_keys_and_scope_shadowing_are_preserved() {
    let note = Map::from_iter([
        ("a.b".into(), Value::Int(7)),
        ("value".into(), Value::Int(99)),
    ]);
    let program = Program::compile("note['a.b']", &BTreeMap::new()).unwrap();
    assert_eq!(
        program
            .evaluate(Bindings::raw(&note), &mut WorkBudget::new())
            .unwrap(),
        RuntimeValue::Number(7.0)
    );
    assert_eq!(
        run("[1,2,3].map(value + index).reduce(acc + value, 0)"),
        RuntimeValue::Number(9.0)
    );
    assert_eq!(
        run("[1,2,1].unique()"),
        RuntimeValue::List(vec![RuntimeValue::Number(1.0), RuntimeValue::Number(2.0)])
    );
}

#[test]
fn unsupported_capabilities_are_admission_refusals_not_runtime_nulls() {
    for source in [
        "date('2026-01-01')",
        "file.tasks",
        "this.projects",
        "[3,1].sort()",
        "(2.5).round()",
        "(2.5).toFixed(2)",
        "+price",
        "1.isTruthy()",
        "false && file.hasTag('task')",
        "'x'.replace(/x/, 'y')",
    ] {
        assert!(matches!(
            Program::compile(source, &BTreeMap::new()).unwrap_err().kind,
            ErrorKind::UnsupportedConstruct(_)
        ));
    }
    assert_eq!(run("(1).isTruthy()"), RuntimeValue::Bool(true));
}

#[test]
fn unqualified_unicode_coercion_and_nonfinite_comparisons_visibly_refuse() {
    for source in [
        "'😀'.length",
        "'😀'.slice(0,1)",
        "'\u{85}'.trim()",
        "number('')",
        "number(' 1 ')",
        "number('inf')",
        "(0/0) == (0/0)",
        "[0/0] == [0/0]",
        "[0/0, 'NaN'].unique()",
    ] {
        assert!(matches!(
            Program::compile(source, &BTreeMap::new())
                .unwrap()
                .evaluate(Bindings::raw(&Map::new()), &mut WorkBudget::new()),
            Err(EvaluationFailure::UnsupportedConstruct(_))
        ));
    }
    assert_eq!(run("(0/0).isEmpty()"), RuntimeValue::Bool(true));
    assert_eq!(
        run("['α','β'].join(',')"),
        RuntimeValue::String("α,β".into())
    );
}

#[test]
fn all_297_oracle_cases_have_explicit_value_or_typed_refusal_expectations() {
    let fixture = yaml::parse_value(include_str!(
        "../../../../tests/data/obsidian-bases-oracle.json"
    ))
    .unwrap()
    .unwrap();
    let cases = fixture.get("cases").unwrap().as_list().unwrap();
    let context = fixture.get("context").unwrap();
    let note = context.get("note").unwrap().as_map().unwrap();
    let formulas: BTreeMap<String, String> = context
        .get("formulas")
        .unwrap()
        .as_map()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.to_owned(), v.as_str().unwrap().to_owned()))
        .collect();
    let manifest = yaml::parse_value(include_str!(
        "../../../../tests/data/bases-primitive-admission.yaml"
    ))
    .unwrap()
    .unwrap();
    assert_eq!(manifest.as_map().unwrap().len(), 297);
    assert_eq!(cases.len(), 297);
    let (mut admitted, mut refused) = (0, 0);
    for case in cases {
        let name = case.get("name").unwrap().as_str().unwrap();
        let source = case.get("expression").unwrap().as_str().unwrap();
        let expectation = manifest
            .get(name)
            .expect("every oracle case has an explicit profile expectation");
        let stage = expectation.get("stage").unwrap().as_str().unwrap();
        let program = Program::compile(source, &formulas);
        if stage == "compile" {
            let error = program.unwrap_err();
            assert_eq!(
                error.kind.code(),
                expectation.get("code").unwrap().as_str().unwrap(),
                "{name}"
            );
            assert_eq!(
                error.kind.detail(),
                expectation.get("detail").unwrap().as_str().unwrap(),
                "{name}"
            );
            refused += 1;
        } else {
            let value = program
                .expect("manifest requires successful admission")
                .evaluate(Bindings::raw(note), &mut WorkBudget::new());
            if stage == "evaluate" {
                let error = value.unwrap_err();
                assert_eq!(
                    error.code(),
                    expectation.get("code").unwrap().as_str().unwrap(),
                    "{name}"
                );
                assert_eq!(
                    error.detail(),
                    expectation.get("detail").unwrap().as_str().unwrap(),
                    "{name}"
                );
                refused += 1;
            } else {
                assert_eq!(stage, "value");
                assert_eq!(
                    &value.expect("manifest requires exact value").to_plain(),
                    case.get("expected").unwrap(),
                    "oracle primitive mismatch: {name}"
                );
                admitted += 1;
            }
        }
    }
    assert_eq!((admitted, refused), (88, 209));
}
