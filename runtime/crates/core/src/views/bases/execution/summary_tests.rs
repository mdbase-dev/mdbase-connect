use super::*;
use crate::query::QueryEnv;
use crate::value::Map;
fn summary(field: &str, function: &str, name: &str) -> Value {
    Value::Map(Map::from_iter([
        ("field".into(), Value::string(field)),
        ("function".into(), Value::string(function)),
        ("name".into(), Value::string(name)),
    ]))
}
fn plan(
    summaries: Value,
    function: Option<&str>,
) -> Result<AdmittedBasesView, FilterAdmissionFailure> {
    named_plan(summaries, function.map(|expr| ("custom", expr)))
}
fn named_plan(
    summaries: Value,
    function: Option<(&str, &str)>,
) -> Result<AdmittedBasesView, FilterAdmissionFailure> {
    let mut raw = Map::from_iter([
        ("type".into(), Value::string("externalRenderer")),
        ("filters".into(), Value::string("note.status == 'open'")),
        (
            "order".into(),
            Value::List(vec![Value::string("note.title")]),
        ),
        ("limit".into(), Value::Int(1)),
        ("summaries".into(), summaries),
    ]);
    if let Some((name, function)) = function {
        raw.insert(
            "summary_functions",
            Value::Map(Map::from_iter([(name.into(), Value::string(function))])),
        );
    }
    let formulas = Value::Map(Map::from_iter([(
        "double".into(),
        Value::string("note.points * 2"),
    )]));
    AdmittedBasesView::compile(
        &BaseFields {
            filters: None,
            formulas: Some(&formulas),
            properties: None,
            views: &Value::Null,
        },
        &BaseView {
            index: 0,
            view_type: "externalRenderer",
            name: None,
            raw: &raw,
        },
        FileTimeAvailability {
            created: false,
            modified: false,
            tags: false,
        },
        &mut WorkBudget::new(),
    )
}
fn row(plan: &AdmittedBasesView, title: &str, points: Value) -> BasesProjectedRow {
    let raw = Map::from_iter([
        ("status".into(), Value::string("open")),
        ("title".into(), Value::string(title)),
        ("points".into(), points),
    ]);
    plan.project_semantic(Bindings::raw(&raw), &mut WorkBudget::new(), &|| false)
        .unwrap()
        .unwrap()
}
fn env() -> QueryEnv {
    QueryEnv {
        now_ms: 0,
        tz: "UTC".into(),
        today: "1970-01-01".into(),
    }
}
#[test]
fn summary_roots_expand_semantic_projection_and_reduce_all_matches_before_limit() {
    let plan = plan(
        Value::List(vec![
            summary("note.title", "count", "all"),
            summary("formula.double", "sum", "total"),
        ]),
        None,
    )
    .unwrap();
    assert_eq!(
        plan.semantic_projection_requirements(&mut WorkBudget::new())
            .unwrap()
            .fields,
        ["points", "status", "title"]
    );
    let rows = [
        row(&plan, "A", Value::Int(1)),
        row(&plan, "B", Value::Int(2)),
        row(&plan, "Z", Value::Int(3)),
    ];
    assert_eq!(plan.limit(), Some(1));
    assert!(
        rows.iter()
            .all(|row| row.cells.is_empty() && row.summary_inputs.len() == 2)
    );
    assert_eq!(
        plan.summarize(rows.iter(), &env(), &mut WorkBudget::new(), &|| false)
            .unwrap(),
        [
            ("all".into(), RuntimeValue::Number(3.0)),
            ("total".into(), RuntimeValue::Number(12.0))
        ]
    );
}
#[test]
fn property_map_adapts_builtin_names_without_reimplementing_the_kernel() {
    let plan = plan(
        Value::Map(Map::from_iter([(
            "note.points".into(),
            Value::string("Average"),
        )])),
        None,
    )
    .unwrap();
    let rows = [
        row(&plan, "A", Value::Int(2)),
        row(&plan, "B", Value::Int(4)),
    ];
    assert_eq!(
        plan.summarize(rows.iter(), &env(), &mut WorkBudget::new(), &|| false)
            .unwrap(),
        [("note.points".into(), RuntimeValue::Number(3.0))]
    );
    assert_eq!(
        plan.summarize([].iter(), &env(), &mut WorkBudget::new(), &|| false)
            .unwrap(),
        [("note.points".into(), RuntimeValue::Null)]
    );
}
#[test]
fn custom_reductions_reuse_cel_over_ordered_native_values_and_refuse_errors() {
    let defs = Value::List(vec![summary("note.title", "custom", "first")]);
    let good = plan(defs.clone(), Some("values[0]")).unwrap();
    let rows = [
        row(&good, "A", Value::Int(1)),
        row(&good, "Z", Value::Int(2)),
    ];
    assert_eq!(
        good.summarize(rows.iter(), &env(), &mut WorkBudget::new(), &|| false)
            .unwrap(),
        [("first".into(), RuntimeValue::String("A".into()))]
    );
    let bad = plan(defs, Some("values[999]")).unwrap();
    assert_eq!(
        bad.summarize(rows.iter(), &env(), &mut WorkBudget::new(), &|| false)
            .err(),
        Some(EvaluationFailure::UnsupportedConstruct(
            "view_summary_evaluation"
        ))
    );
    let overflow = plan(
        Value::List(vec![summary("note.title", "custom", "large")]),
        Some("9223372036854775807"),
    )
    .unwrap();
    assert!(
        overflow
            .summarize(rows.iter(), &env(), &mut WorkBudget::new(), &|| false)
            .is_err()
    );
}
#[test]
fn explicitly_named_custom_function_wins_over_builtin_alias() {
    let plan = named_plan(
        Value::Map(Map::from_iter([(
            "note.title".into(),
            Value::string("Sum"),
        )])),
        Some(("Sum", "values[0]")),
    )
    .unwrap();
    let rows = [row(&plan, "A", Value::Int(1))];
    assert_eq!(
        plan.summarize(rows.iter(), &env(), &mut WorkBudget::new(), &|| false)
            .unwrap(),
        [("note.title".into(), RuntimeValue::String("A".into()))]
    );
}
#[test]
fn invalid_summary_computation_and_unavailable_semantic_roots_never_become_display_gaps() {
    for defs in [
        Value::List(vec![summary("note.points", "unsupported", "x")]),
        Value::List(vec![summary("file.tasks", "count", "x")]),
        Value::List(vec![
            summary("note.points", "count", "x"),
            summary("note.title", "count", "x"),
        ]),
    ] {
        assert!(plan(defs, None).is_err());
    }
    let bad = plan(
        Value::List(vec![summary("note.points", "sum", "sum")]),
        None,
    )
    .unwrap();
    let rows = [row(&bad, "A", Value::string("not a number"))];
    assert_eq!(
        bad.summarize(rows.iter(), &env(), &mut WorkBudget::new(), &|| false)
            .err(),
        Some(EvaluationFailure::UnsupportedConstruct(
            "view_summary_evaluation"
        ))
    );
}
#[test]
fn summary_materialization_and_work_are_bounded_and_cancellable() {
    let plan = plan(
        Value::List(vec![summary("note.title", "count", "all")]),
        None,
    )
    .unwrap();
    let rows = (0..1001)
        .map(|_| row(&plan, "A", Value::Int(1)))
        .collect::<Vec<_>>();
    assert_eq!(
        plan.summarize(rows.iter(), &env(), &mut WorkBudget::new(), &|| false)
            .err(),
        Some(EvaluationFailure::BudgetExceeded("view_summary_rows"))
    );
    assert_eq!(
        plan.summarize(rows.iter(), &env(), &mut WorkBudget::new(), &|| true)
            .err(),
        Some(EvaluationFailure::Cancelled)
    );
    assert!(
        plan.summarize(
            rows[..1].iter(),
            &env(),
            &mut WorkBudget::constrained(1, 1),
            &|| false
        )
        .is_err()
    );
}
