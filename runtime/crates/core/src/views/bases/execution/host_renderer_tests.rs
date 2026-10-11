use super::*;
use crate::value::Map;

fn compile(
    kind: &str,
    options: Option<Value>,
    extra: Option<(&str, Value)>,
) -> Result<AdmittedBasesView, FilterAdmissionFailure> {
    let mut raw = Map::from_iter([
        ("type".into(), Value::string(kind)),
        ("filters".into(), Value::string("note.status == 'open'")),
        (
            "order".into(),
            Value::List(vec![Value::string("note.title")]),
        ),
        (
            "sort".into(),
            Value::List(vec![Value::Map(Map::from_iter([
                ("property".into(), Value::string("note.priority")),
                ("direction".into(), Value::string("DESC")),
            ]))]),
        ),
        (
            "groupBy".into(),
            Value::Map(Map::from_iter([
                ("property".into(), Value::string("note.status")),
                ("direction".into(), Value::string("ASC")),
            ])),
        ),
    ]);
    if let Some(options) = options {
        raw.insert("options", options);
    }
    if let Some((key, value)) = extra {
        raw.insert(key, value);
    }
    AdmittedBasesView::compile(
        &BaseFields {
            filters: None,
            formulas: None,
            properties: None,
            views: &Value::Null,
        },
        &BaseView {
            index: 0,
            view_type: kind,
            name: None,
            raw: &raw,
        },
        FileTimeAvailability {
            created: false,
            modified: false,
            tags: true,
        },
        &mut WorkBudget::new(),
    )
}
fn options(entries: &[(&str, Value)]) -> Value {
    Value::Map(Map::from_iter(
        entries
            .iter()
            .map(|(key, value)| (key.to_string(), value.clone())),
    ))
}
fn same_query(plan: AdmittedBasesView) {
    let plain = compile("table", None, None).unwrap();
    assert_eq!(
        plan.projection_requirements(&mut WorkBudget::new())
            .unwrap(),
        plain
            .projection_requirements(&mut WorkBudget::new())
            .unwrap()
    );
    assert_eq!(plan.columns()[0].key(), plain.columns()[0].key());
    assert_eq!(plan.sort_directions().len(), 1);
    assert!(plan.group_direction().is_some());
}
#[test]
fn host_presentation_options_do_not_change_query_roots() {
    for (kind, metadata) in [
        ("table", options(&[("create", Value::Bool(false))])),
        (
            "tasknotesTaskList",
            options(&[
                ("sections", Value::string("day")),
                ("create", Value::Bool(false)),
            ]),
        ),
        (
            "tasknotesKanban",
            options(&[("create", Value::Bool(false))]),
        ),
        (
            "tasknotesCalendar",
            options(&[
                ("calendarView", Value::string("dayGridMonth")),
                ("listDayCount", Value::Int(7)),
                ("customDayCount", Value::Int(3)),
                ("showScheduled", Value::Bool(true)),
                ("showDue", Value::Bool(true)),
                ("showRecurring", Value::Bool(true)),
                ("showCompletedRecurringInstances", Value::Bool(false)),
                ("showSkippedRecurringInstances", Value::Bool(false)),
            ]),
        ),
    ] {
        same_query(compile(kind, Some(metadata), None).unwrap());
    }
}
#[test]
fn arbitrary_renderer_and_bounded_opaque_metadata_preserve_the_query() {
    same_query(
        compile(
            "thirdPartyTimeline",
            Some(options(&[
                (
                    "customPresentation",
                    options(&[(
                        "nested",
                        Value::List(vec![Value::Int(2), Value::Bool(true)]),
                    )]),
                ),
                ("calendarView", Value::string("customDisplay")),
            ])),
            Some(("displayConfiguration", Value::string("uninterpreted"))),
        )
        .unwrap(),
    );
    same_query(
        compile(
            "unregisteredPlugin",
            None,
            Some(("queryOverride", Value::Int(1))),
        )
        .unwrap(),
    );
}
#[test]
fn opaque_options_have_no_per_renderer_or_value_type_whitelist() {
    for kind in [
        "table",
        "external",
        "tasknotesTaskList",
        "tasknotesCalendar",
    ] {
        for value in [
            Value::Null,
            Value::Bool(false),
            Value::List(vec![]),
            Value::string("day"),
            Value::Int(-1),
            Value::Float(1.5),
        ] {
            same_query(compile(kind, Some(value), None).unwrap());
        }
        same_query(
            compile(
                kind,
                Some(options(&[
                    ("filters", Value::string("false")),
                    ("limit", Value::Int(0)),
                    ("unknown", Value::Bool(true)),
                ])),
                None,
            )
            .unwrap(),
        );
    }
}
#[test]
fn opaque_presentation_bytes_nodes_depth_and_renderer_names_are_bounded() {
    for kind in ["", &"é".repeat(513)] {
        assert!(compile(kind, None, None).is_err());
    }
    assert!(compile(&"é".repeat(512), None, None).is_ok());
    let mut deep = Value::Null;
    for _ in 0..17 {
        deep = Value::List(vec![deep]);
    }
    for value in [
        Value::string("x".repeat(65_537)),
        Value::List(vec![Value::Null; 4096]),
        deep,
    ] {
        let error = compile("external", Some(value), None).err().unwrap();
        assert_eq!(error.code(), "query_budget_exceeded");
    }
    assert!(compile("external", Some(Value::List(vec![Value::Null; 100])), None).is_ok());
}
#[test]
fn interpreted_computation_never_falls_back_to_opaque_metadata() {
    for (key, value) in [
        ("summaries", Value::Int(1)),
        ("summary_functions", Value::Int(1)),
        ("filters", Value::string("note.unsupportedFunction()")),
        ("sort", Value::Null),
    ] {
        assert!(
            compile("external", None, Some((key, value))).is_err(),
            "{key}"
        );
    }
}
#[test]
fn view_limit_reuses_the_canonical_query_number_policy() {
    for value in [
        Value::Int(0),
        Value::Int(1),
        Value::Int(100_000),
        Value::Float(3.0),
        Value::Int(-1),
        Value::Float(1.5),
        Value::string("3"),
        Value::Bool(true),
    ] {
        let expected = crate::query::Query::from_value(&Value::Map(Map::from_iter([(
            "limit".into(),
            value.clone(),
        )])));
        let actual = compile("arbitraryGrid", None, Some(("limit", value)));
        match (expected, actual) {
            (Ok(query), Ok(plan)) => assert_eq!(plan.limit(), query.limit),
            (Err(_), Err(_)) => {}
            _ => panic!("Bases limit must use the existing query validator"),
        }
    }
}
