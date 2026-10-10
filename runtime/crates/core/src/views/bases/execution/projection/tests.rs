use super::*;
use crate::value::Map;
fn plan(filter: &str, columns: &[&str], formulas: &[(&str, &str)]) -> AdmittedBasesView {
    let formulas = Value::Map(Map::from_iter(
        formulas
            .iter()
            .map(|(name, source)| (name.to_string(), Value::string(*source))),
    ));
    let raw = Map::from_iter([
        ("type".into(), Value::string("table")),
        ("filters".into(), Value::string(filter)),
        (
            "order".into(),
            Value::List(
                columns
                    .iter()
                    .map(|column| Value::string(*column))
                    .collect(),
            ),
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
    AdmittedBasesView::compile(
        &fields,
        &view,
        FileTimeAvailability {
            created: false,
            modified: false,
            tags: true,
        },
        &mut WorkBudget::new(),
    )
    .unwrap()
}
fn requirements(plan: &AdmittedBasesView) -> BasesProjectionRequirements {
    plan.projection_requirements(&mut WorkBudget::new())
        .unwrap()
}

#[test]
fn literal_names_nested_maps_presence_and_file_tags_are_complete() {
    let p = plan(
        "note.status == status && note['a.b'].value[other] == null && file.hasProperty('zero')",
        &["note.projects", "file.tags"],
        &[],
    );
    assert_eq!(
        requirements(&p),
        BasesProjectionRequirements {
            fields: vec![
                "a.b".into(),
                "other".into(),
                "projects".into(),
                "status".into(),
                "zero".into()
            ],
            tags: true
        }
    );
    let p = plan(
        "file.hasTag(tag) && file.inFolder(folder)",
        &["file.name"],
        &[],
    );
    assert_eq!(
        requirements(&p),
        BasesProjectionRequirements {
            fields: vec!["folder".into(), "tag".into()],
            tags: true
        }
    );
}
#[test]
fn reachable_formula_dag_is_collected_once_and_unused_library_ignored() {
    let p = plan(
        "formula.a || formula.b",
        &["formula.b"],
        &[
            ("a", "note.active"),
            ("b", "formula.a && note.flag"),
            ("unused", "note.keys()"),
        ],
    );
    assert_eq!(requirements(&p).fields, vec!["active", "flag"]);
}
#[test]
fn file_only_roots_and_unavailable_display_roots_need_no_raw_fields() {
    let p = plan(
        "file.inFolder('tasks') && file.size > 0",
        &["file.name", "file.tasks", "file.ctime", "formula.bad"],
        &[("bad", "unavailable(note)")],
    );
    assert_eq!(
        requirements(&p),
        BasesProjectionRequirements {
            fields: vec![],
            tags: false
        }
    );
}
#[test]
fn dynamic_or_whole_note_reads_refuse_even_in_lazy_branches() {
    for source in [
        "false && note[key]",
        "file.hasProperty(note.key)",
        "note.keys().isEmpty()",
        "note.values().isEmpty()",
        "list(note).isEmpty()",
    ] {
        let p = plan(source, &["file.name"], &[]);
        let mut work = WorkBudget::new();
        let error = p.projection_requirements(&mut work).unwrap_err();
        assert_eq!(
            error,
            EvaluationFailure::MetadataUnavailable("raw_property_projection_unqualified")
        );
        assert_eq!(work.failure(), Some(error));
        assert_eq!(p.projection_requirements(&mut work).unwrap_err(), error);
    }
}
#[test]
fn projection_refusal_does_not_change_ordinary_whole_source_execution() {
    let p = plan("note[key] == 7", &["note.value"], &[]);
    assert!(p.projection_requirements(&mut WorkBudget::new()).is_err());
    let raw = Map::from_iter([
        ("key".into(), Value::string("value")),
        ("value".into(), Value::Int(7)),
    ]);
    let row = p
        .project(Bindings::raw(&raw), &mut WorkBudget::new(), &|| false)
        .unwrap()
        .unwrap();
    assert!(
        matches!(row.cells.as_slice(),[BasesDisplayCell::Value(RuntimeValue::Number(value))] if *value==7.0)
    );
}
#[test]
fn literal_scope_like_raw_names_and_scoped_callbacks_are_conservative() {
    let p = plan(
        "list(note.n).map(value + index).sum() > acc",
        &["note.value"],
        &[],
    );
    assert_eq!(requirements(&p).fields, vec!["acc", "index", "n", "value"]);
}
#[test]
fn exact_count_and_name_bounds_refuse_without_truncation() {
    let source = (0..64)
        .map(|n| format!("note.p{n}"))
        .collect::<Vec<_>>()
        .join(",");
    let p = plan(&format!("list({source}).isEmpty()"), &[], &[]);
    assert_eq!(requirements(&p).fields.len(), 64);
    let p = plan(&format!("list({source},note.extra).isEmpty()"), &[], &[]);
    assert_eq!(
        p.projection_requirements(&mut WorkBudget::new())
            .unwrap_err(),
        EvaluationFailure::BudgetExceeded("raw_property_projection_count")
    );
    let name = "x".repeat(256);
    let p = plan("true", &[&format!("note.{name}")], &[]);
    assert_eq!(requirements(&p).fields, vec![name]);
    let name = "x".repeat(257);
    let p = plan("true", &[&format!("note.{name}")], &[]);
    assert_eq!(
        p.projection_requirements(&mut WorkBudget::new())
            .unwrap_err(),
        EvaluationFailure::MetadataUnavailable("raw_property_projection_unqualified")
    );
}
#[test]
fn sticky_failure_survives_empty_requirements_and_unavailable_columns() {
    let p = plan("true", &["file.tasks"], &[]);
    let mut work = WorkBudget::new();
    work.fail(EvaluationFailure::Cancelled);
    assert_eq!(
        p.projection_requirements(&mut work).unwrap_err(),
        EvaluationFailure::Cancelled
    );
}
