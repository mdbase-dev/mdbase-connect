use super::*;
use crate::value::Map;
fn expression(s: &str) -> Value {
    Value::string(s)
}
fn logical(op: &str, items: Vec<Value>) -> Value {
    Value::Map(Map::from_iter([(op.into(), Value::List(items))]))
}
fn run(shared: Option<&Value>, local: Option<&Value>) -> bool {
    let mut budget = WorkBudget::new();
    let filter = AdmittedBasesFilter::compile(
        shared,
        local,
        &BTreeMap::new(),
        Profile::Duration,
        &mut budget,
    )
    .unwrap();
    filter
        .matches(Bindings::raw(&Map::new()), &mut budget, &|| false)
        .unwrap()
}
#[test]
fn filters_combine_shared_local_and_bounded_logic_without_defaults() {
    assert!(run(None, None));
    assert!(!run(Some(&expression("false")), Some(&expression("true"))));
    let shared = logical(
        "and",
        vec![
            expression("true"),
            logical("or", vec![expression("false"), expression("true")]),
        ],
    );
    let local = logical("not", vec![expression("false"), expression("0")]);
    assert!(run(Some(&shared), Some(&local)));
    assert!(!run(
        Some(&shared),
        Some(&logical(
            "not",
            vec![expression("false"), expression("true")]
        ))
    ));
}
#[test]
fn empty_logical_identities_and_single_operands_are_explicit() {
    assert!(run(Some(&logical("and", vec![])), None));
    assert!(!run(Some(&logical("or", vec![])), None));
    assert!(run(Some(&logical("not", vec![])), None));
    let single = Value::Map(Map::from_iter([("not".into(), expression("false"))]));
    assert!(run(Some(&single), None));
    for (source, want) in [
        ("null", false),
        ("0", false),
        ("1", true),
        ("''", false),
        ("'value'", true),
    ] {
        assert_eq!(run(Some(&expression(source)), None), want, "{source}");
    }
}
#[test]
fn all_lazy_branches_are_admitted_and_malformed_fragments_cannot_escape_wrappers() {
    for value in [
        logical("or", vec![expression("true"), expression("regex('x')")]),
        expression("true) || (true"),
        Value::Null,
        logical("xor", vec![]),
    ] {
        let mut budget = WorkBudget::new();
        assert!(
            AdmittedBasesFilter::compile(
                Some(&value),
                None,
                &BTreeMap::new(),
                Profile::Duration,
                &mut budget
            )
            .is_err()
        );
        assert!(budget.failure().is_some());
    }
}
#[test]
fn reachable_formula_cycles_preserve_typed_admission_code() {
    let formulas = BTreeMap::from_iter([
        ("a".into(), "formula.b".into()),
        ("b".into(), "formula.a".into()),
    ]);
    let mut budget = WorkBudget::new();
    let e = match AdmittedBasesFilter::compile(
        Some(&expression("formula.a")),
        None,
        &formulas,
        Profile::Duration,
        &mut budget,
    ) {
        Err(e) => e,
        Ok(_) => panic!("cycle admitted"),
    };
    assert_eq!(e.code(), "view_formula_cycle");
    assert_eq!(e.detail(), "formula_cycle");
    assert!(budget.failure().is_some());
}
#[test]
fn source_errors_and_cancellation_suppress_success_without_disabling_lazy_semantics() {
    let mut budget = WorkBudget::new();
    let p = AdmittedBasesFilter::compile(
        Some(&expression("number('oops')")),
        None,
        &BTreeMap::new(),
        Profile::Duration,
        &mut budget,
    )
    .unwrap();
    assert_eq!(
        p.matches(Bindings::raw(&Map::new()), &mut budget, &|| false)
            .unwrap_err(),
        EvaluationFailure::UnsupportedConstruct("filter_expression_error")
    );
    assert!(!run(
        Some(&expression("false")),
        Some(&expression("number('oops')"))
    ));
    let mut budget = WorkBudget::new();
    let p =
        AdmittedBasesFilter::compile(None, None, &BTreeMap::new(), Profile::Duration, &mut budget)
            .unwrap();
    assert_eq!(
        p.matches(Bindings::raw(&Map::new()), &mut budget, &|| true)
            .unwrap_err(),
        EvaluationFailure::Cancelled
    );
}
#[test]
fn depth_count_source_limits_and_prior_failures_stay_sticky() {
    let mut value = expression("true");
    for _ in 0..33 {
        value = logical("and", vec![value]);
    }
    for value in [
        value,
        logical("and", vec![expression("true"); 257]),
        expression(&" ".repeat(MAX_SOURCE_BYTES + 1)),
    ] {
        let mut budget = WorkBudget::new();
        assert!(matches!(
            AdmittedBasesFilter::compile(
                Some(&value),
                None,
                &BTreeMap::new(),
                Profile::Duration,
                &mut budget
            ),
            Err(FilterAdmissionFailure::Work(
                EvaluationFailure::BudgetExceeded(_)
            ))
        ));
    }
    let mut budget = WorkBudget::new();
    budget.fail(EvaluationFailure::Cancelled);
    assert!(matches!(
        AdmittedBasesFilter::compile(None, None, &BTreeMap::new(), Profile::Duration, &mut budget),
        Err(FilterAdmissionFailure::Work(EvaluationFailure::Cancelled))
    ));
}
