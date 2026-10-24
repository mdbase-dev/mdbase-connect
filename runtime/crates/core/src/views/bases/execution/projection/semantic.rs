use super::*;
use crate::value::Map;
fn plan() -> AdmittedBasesView {
    let raw = Map::from_iter([
        ("type".into(), Value::string("table")),
        ("filters".into(), Value::string("note.active")),
        (
            "sort".into(),
            Value::List(vec![Value::Map(Map::from_iter([
                ("property".into(), Value::string("formula.rank")),
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
            Value::List(vec![
                Value::string("note.display"),
                Value::string("formula.text"),
            ]),
        ),
    ]);
    let formulas = Value::Map(Map::from_iter([
        ("rank".into(), Value::string("note.score + 1")),
        ("text".into(), Value::string("note.extra")),
    ]));
    AdmittedBasesView::compile(
        &BaseFields {
            filters: None,
            formulas: Some(&formulas),
            properties: None,
            views: &Value::Null,
        },
        &BaseView {
            index: 0,
            view_type: "table",
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
    .unwrap()
}
fn hints(hints: &[(&str, &str)]) -> BTreeMap<String, String> {
    BTreeMap::from_iter(hints.iter().map(|(k, v)| (k.to_string(), v.to_string())))
}
#[test]
fn semantic_requirements_visit_reachable_filter_sort_group_formulas_not_display() {
    let plan = plan();
    assert_eq!(
        plan.semantic_projection_requirements(&mut WorkBudget::new())
            .unwrap(),
        BasesProjectionRequirements {
            fields: vec!["active".into(), "score".into(), "state".into()],
            tags: false
        }
    );
    assert_eq!(
        plan.projection_requirements(&mut WorkBudget::new())
            .unwrap()
            .fields,
        vec!["active", "display", "extra", "score", "state"]
    );
}
#[test]
fn keys_only_matches_full_projection_keys_with_no_synthetic_display_cells() {
    let plan = plan();
    let hint_map = hints(&[]);
    let types = CapturedPropertyTypes::capture(&hint_map, &mut WorkBudget::new()).unwrap();
    for active in [true, false] {
        let full = Map::from_iter([
            ("active".into(), Value::Bool(active)),
            ("score".into(), Value::int(3)),
            ("state".into(), Value::string("open")),
            ("display".into(), Value::string("visible")),
            ("extra".into(), Value::string("extra")),
        ]);
        let subset = Map::from_iter(
            full.iter()
                .filter(|(k, _)| matches!(*k, "active" | "score" | "state"))
                .map(|(k, v)| (k.to_string(), v.clone())),
        );
        let mut work = WorkBudget::new();
        let bindings = types.projected_bindings(&full, &mut work).unwrap();
        let all = plan.project(bindings, &mut work, &|| false).unwrap();
        let mut work = WorkBudget::new();
        let bindings = types.projected_bindings(&subset, &mut work).unwrap();
        let keys = plan
            .project_semantic(bindings, &mut work, &|| false)
            .unwrap();
        match (all, keys) {
            (Some(all), Some(keys)) => {
                assert_eq!(all.sort, keys.sort);
                assert_eq!(all.group, keys.group);
                assert_eq!(all.cells.len(), 2);
                assert!(keys.cells.is_empty());
            }
            (None, None) => {}
            _ => panic!("semantic membership changed"),
        }
    }
}
#[test]
fn semantic_failures_stay_sticky_and_display_failures_are_deferred_not_masked() {
    let plan = plan();
    let raw = Map::from_iter([
        ("active".into(), Value::Bool(true)),
        ("score".into(), Value::Null),
        ("state".into(), Value::string("open")),
        ("display".into(), Value::Null),
    ]);
    let hint_map = hints(&[("score", "date")]);
    let semantic_types = CapturedPropertyTypes::capture(&hint_map, &mut WorkBudget::new()).unwrap();
    let mut work = WorkBudget::new();
    let bindings = semantic_types.projected_bindings(&raw, &mut work).unwrap();
    let error = plan
        .project_semantic(bindings, &mut work, &|| false)
        .err()
        .unwrap();
    assert_eq!(
        error,
        EvaluationFailure::UnsupportedConstruct("typed_empty_property_unqualified")
    );
    assert_eq!(work.failure(), Some(error));
    let raw = Map::from_iter([
        ("active".into(), Value::Bool(true)),
        ("score".into(), Value::int(3)),
        ("state".into(), Value::string("open")),
        ("display".into(), Value::Null),
    ]);
    let display_hints = hints(&[("display", "date")]);
    let display_types =
        CapturedPropertyTypes::capture(&display_hints, &mut WorkBudget::new()).unwrap();
    let mut work = WorkBudget::new();
    let bindings = display_types.projected_bindings(&raw, &mut work).unwrap();
    assert!(
        plan.project_semantic(bindings, &mut work, &|| false)
            .unwrap()
            .unwrap()
            .cells
            .is_empty()
    );
    let mut work = WorkBudget::new();
    let bindings = display_types.projected_bindings(&raw, &mut work).unwrap();
    assert_eq!(
        plan.project(bindings, &mut work, &|| false).err().unwrap(),
        EvaluationFailure::UnsupportedConstruct("typed_empty_property_unqualified")
    );
}
