use super::*;
use crate::value::Map;

#[test]
fn projected_bindings_keep_strict_hints_presence_and_sticky_errors() {
    let hints = std::collections::BTreeMap::from([("due".into(), "date".into())]);
    let types = CapturedPropertyTypes::capture(&hints, &mut WorkBudget::new()).unwrap();
    let p =
        Program::compile_with_profile("due", &std::collections::BTreeMap::new(), Profile::Duration)
            .unwrap();
    let empty = Map::new();
    let mut work = WorkBudget::new();
    let bindings = types.projected_bindings(&empty, &mut work).unwrap();
    assert_eq!(p.evaluate(bindings, &mut work).unwrap(), RuntimeValue::Null);
    let present = Map::from_iter([("due".into(), Value::Null)]);
    let mut work = WorkBudget::new();
    let bindings = types.projected_bindings(&present, &mut work).unwrap();
    assert_eq!(
        p.evaluate(bindings, &mut work).unwrap_err(),
        EvaluationFailure::UnsupportedConstruct("typed_empty_property_unqualified")
    );
    assert_eq!(
        types.projected_bindings(&empty, &mut work).err().unwrap(),
        EvaluationFailure::UnsupportedConstruct("typed_empty_property_unqualified")
    );
}

#[test]
fn projected_bindings_reject_unbounded_or_unqualified_name_maps() {
    let hints = std::collections::BTreeMap::new();
    let types = CapturedPropertyTypes::capture(&hints, &mut WorkBudget::new()).unwrap();
    let large = Map::from_iter((0..65).map(|n| (format!("p{n}"), Value::Null)));
    assert_eq!(
        types
            .projected_bindings(&large, &mut WorkBudget::new())
            .err()
            .unwrap(),
        EvaluationFailure::BudgetExceeded("raw_property_projection_count")
    );
    let long = Map::from_iter([("x".repeat(257), Value::Null)]);
    assert_eq!(
        types
            .projected_bindings(&long, &mut WorkBudget::new())
            .err()
            .unwrap(),
        EvaluationFailure::MetadataUnavailable("raw_property_projection_unqualified")
    );
}

#[test]
fn subset_bindings_preserve_residual_projection_and_ignore_unrelated_links() {
    let formulas = Value::Map(Map::from_iter([(
        "p".into(),
        Value::string("note.score + 1"),
    )]));
    let filter = "note.active && note['a.b'].inner == 'ok' && formula.p > 0";
    let raw = Map::from_iter([
        ("type".into(), Value::string("table")),
        ("filters".into(), Value::string(filter)),
        (
            "sort".into(),
            Value::List(vec![Value::Map(Map::from_iter([
                ("property".into(), Value::string("note.rank")),
                ("direction".into(), Value::string("ASC")),
            ]))]),
        ),
        (
            "groupBy".into(),
            Value::Map(Map::from_iter([
                ("property".into(), Value::string("note.state")),
                ("direction".into(), Value::string("ASC")),
            ])),
        ),
        (
            "order".into(),
            Value::List(vec![Value::string("note.x"), Value::string("formula.p")]),
        ),
    ]);
    let fields = BaseFields {
        filters: None,
        formulas: Some(&formulas),
        properties: None,
        views: &Value::Null,
    };
    let view = BaseView {
        index: 0,
        view_type: "table",
        name: None,
        raw: &raw,
    };
    let plan = AdmittedBasesView::compile(
        &fields,
        &view,
        FileTimeAvailability {
            created: false,
            modified: false,
            tags: true,
        },
        &mut WorkBudget::new(),
    )
    .unwrap();
    let required = plan
        .projection_requirements(&mut WorkBudget::new())
        .unwrap();
    assert_eq!(
        required.fields,
        vec!["a.b", "active", "rank", "score", "state", "x"]
    );
    let hints = std::collections::BTreeMap::new();
    let types = CapturedPropertyTypes::capture(&hints, &mut WorkBudget::new()).unwrap();
    for active in [false, true] {
        let full = Map::from_iter([
            (
                "a.b".into(),
                Value::Map(Map::from_iter([("inner".into(), Value::string("ok"))])),
            ),
            ("active".into(), Value::Bool(active)),
            ("rank".into(), Value::Int(7)),
            ("score".into(), Value::Int(2)),
            ("state".into(), Value::string("open")),
            (
                "x".into(),
                Value::List(vec![Value::string("v"), Value::string("w")]),
            ),
            (
                "unrelatedLink".into(),
                Value::string("[[Unqualified link]]"),
            ),
        ]);
        let subset = Map::from_iter(
            required
                .fields
                .iter()
                .filter_map(|name| full.get(name).map(|value| (name.clone(), value.clone()))),
        );
        let original = plan
            .project(Bindings::raw(&full), &mut WorkBudget::new(), &|| false)
            .unwrap();
        let mut scratch = WorkBudget::new();
        let bindings = types.projected_bindings(&subset, &mut scratch).unwrap();
        let projected = plan.project(bindings, &mut scratch, &|| false).unwrap();
        match (original, projected) {
            (None, None) => {}
            (Some(a), Some(b)) => {
                assert_eq!(a.sort, b.sort);
                assert_eq!(a.group, b.group);
                assert_eq!(a.cells.len(), b.cells.len());
                for (a, b) in a.cells.iter().zip(&b.cells) {
                    match (a, b) {
                        (BasesDisplayCell::Value(a), BasesDisplayCell::Value(b)) => {
                            assert_eq!(a, b)
                        }
                        _ => panic!("qualified cells should match"),
                    }
                }
            }
            _ => panic!("subset capture changed membership"),
        }
    }
}
