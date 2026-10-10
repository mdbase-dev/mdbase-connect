//! Spec 10 temporal bindings in query residuals, without changing record values.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use mdbn_core::cel::{CelValue, compile as compile_cel};
use mdbn_core::doc::Document;
use mdbn_core::query::{
    Candidate, CompareOp, FieldRef, Pruning, Query, QueryEnv, QueryRecord, Verdict, compile,
    file_value,
};
use mdbn_core::types::Catalog;
use mdbn_core::validate::Severity;
use mdbn_core::value::Value;

const TASK: &str = r#"---
kind: mdbase.type
name: task
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    properties:
      at: {type: string, format: date-time}
      day: {type: string, format: date}
      nested:
        type: object
        properties:
          at: {$ref: '#/$defs/instant'}
      times:
        type: array
        items: {$ref: '#/$defs/instant'}
      plain: {type: string}
    $defs:
      instant: {type: string, format: date-time}
    allOf:
      - properties:
          plain: {format: date-time}
collection:
  read_defaults:
    at: "2026-01-01T01:00:00+01:00"
---
"#;
const OTHER: &str = r#"---
kind: mdbase.type
name: other
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    properties:
      at: {type: string}
---
"#;

fn catalog() -> Catalog {
    let catalog = Catalog::load([
        ("mdbase.yaml", "spec_version: \"0.3.0\"\n"),
        ("_types/task.md", TASK),
        ("_types/other.md", OTHER),
    ]);
    assert!(catalog.is_valid());
    assert_eq!(catalog.types().len(), 2, "{:?}", catalog.issues());
    assert!(
        catalog
            .issues()
            .iter()
            .all(|i| i.severity != Severity::Error),
        "{:?}",
        catalog.issues()
    );
    catalog
}

fn env() -> QueryEnv {
    QueryEnv {
        now_ms: 1_767_225_600_000,
        tz: "UTC".into(),
        today: "2026-01-01".into(),
    }
}

fn verdict(cel: &str, source: &str, names: &[&str]) -> Verdict {
    let plan = compile(
        &Query {
            where_: Some(cel.into()),
            ..Query::default()
        },
        &catalog(),
    )
    .unwrap();
    let doc = Document::parse_at("tasks/a.md", source);
    let types: Vec<_> = names.iter().map(|s| (*s).to_owned()).collect();
    plan.matches(
        &QueryRecord {
            path: "tasks/a.md",
            types: &types,
            frontmatter: doc.frontmatter(),
            body: Some(doc.body()),
        },
        &env(),
    )
}

#[test]
fn offsets_are_compared_as_instants_in_all_frontmatter_bindings() {
    assert_eq!(
        verdict(
            "at == now() && record.at == now() && raw.at == now() && day == today()",
            "---\nat: '2026-01-01T01:00:00+01:00'\nday: '2026-01-01'\n---\n",
            &["TASK"],
        ),
        Verdict::Match
    );
    assert_eq!(
        verdict(
            "at < now()",
            "---\nat: '2026-01-01T00:30:00+01:00'\n---\n",
            &["task"],
        ),
        Verdict::Match
    );
}

#[test]
fn nested_properties_array_items_and_local_refs_are_typed() {
    assert_eq!(
        verdict(
            "nested.at == now() && record.times[0] == now() && raw.times[0] == now()",
            "---\nnested: {at: '2026-01-01T01:00:00+01:00'}\ntimes: ['2026-01-01T00:00:00Z']\n---\n",
            &["task"],
        ),
        Verdict::Match
    );
}

#[test]
fn every_matched_schema_must_declare_the_format() {
    let source = "---\nat: '2026-01-01T00:00:00Z'\n---\n";
    for types in [&[][..], &["task", "other"][..], &["task", "unknown"][..]] {
        assert!(matches!(
            verdict("at < now()", source, types),
            Verdict::Error(_)
        ));
        assert_eq!(
            verdict("at == '2026-01-01T00:00:00Z'", source, types),
            Verdict::Match
        );
    }
}

#[test]
fn invalid_dates_and_conditional_schema_locations_stay_strings() {
    assert_eq!(
        verdict(
            "at == 'not-a-date' && plain == '2026-01-01T00:00:00Z'",
            "---\nat: not-a-date\nplain: '2026-01-01T00:00:00Z'\n---\n",
            &["task"],
        ),
        Verdict::Match
    );
    assert!(matches!(
        verdict("at < now()", "---\nat: not-a-date\n---\n", &["task"]),
        Verdict::Error(_)
    ));
}

#[test]
fn read_defaults_are_typed_only_for_effective_bindings() {
    assert_eq!(
        verdict(
            "at == now() && record.at == now() && !has(raw.at)",
            "---\n---\n",
            &["task"]
        ),
        Verdict::Match
    );
    assert_eq!(
        verdict(
            "at == null && raw.at == null",
            "---\nat: null\n---\n",
            &["task"]
        ),
        Verdict::Match
    );
}

#[test]
fn activation_keeps_reserved_bindings_origin_and_original_values() {
    let plan = compile(&Query::default(), &catalog()).unwrap();
    let doc = Document::parse_at(
        "tasks/a.md",
        "---\nat: '2026-01-01T01:00:00+01:00'\nrecord: shadow\nraw: shadow\nfile: shadow\n---\n",
    );
    let types = vec!["task".into()];
    let record = QueryRecord {
        path: "tasks/a.md",
        types: &types,
        frontmatter: doc.frontmatter(),
        body: None,
    };
    let effective = plan.effective(&record);
    let act = plan.activation(
        &record,
        &effective,
        CelValue::from_value(&file_value(record.path, None)),
    );
    assert!(matches!(
        compile_cel(
            "record.record == 'shadow' && raw.raw == 'shadow' && file.path == 'tasks/a.md'"
        )
        .unwrap()
        .evaluate(&act)
        .unwrap(),
        CelValue::Bool(true)
    ));
    for name in ["record", "raw"] {
        let CelValue::Map(m) = compile_cel(name).unwrap().evaluate(&act).unwrap() else {
            panic!("not a map")
        };
        assert_eq!(m.origin(), Some(record.path));
    }
    assert_eq!(
        effective.get("at").unwrap().as_str(),
        Some("2026-01-01T01:00:00+01:00")
    );
    assert_eq!(
        record.frontmatter.get("at").unwrap().as_str(),
        Some("2026-01-01T01:00:00+01:00")
    );
}

#[test]
fn typed_comparisons_never_prune_or_claim_raw_string_exactness() {
    let source = "---\nat: '2026-01-01T00:00:00Z'\nnested: {at: '2026-01-01T00:00:00Z'}\n---\n";
    for field in [
        "at",
        "record.at",
        "raw.at",
        "nested.at",
        "record.nested.at",
        "raw.nested.at",
    ] {
        for (expr, matches) in [
            (format!("{field} != '2026-01-01T00:00:00Z'"), true),
            (format!("!({field} == '2026-01-01T00:00:00Z')"), true),
            (format!("{field} == '2026-01-01T00:00:00Z'"), false),
        ] {
            let plan = compile(
                &Query {
                    where_: Some(expr.clone()),
                    ..Query::default()
                },
                &catalog(),
            )
            .unwrap();
            assert_eq!(plan.candidate, Candidate::All, "{expr}");
            assert!(!plan.exact, "{expr}");
            assert_eq!(
                verdict(&expr, source, &["task"]),
                if matches {
                    Verdict::Match
                } else {
                    Verdict::NoMatch
                }
            );
        }
    }
    // An unsafe branch also prevents lowering a disjunction or its negation.
    for expr in [
        "raw.at != '2026-01-01T00:00:00Z' || day == '2026-01-01'",
        "!(raw.at == '2026-01-01T00:00:00Z' || day == '2026-01-01')",
    ] {
        let plan = compile(
            &Query {
                where_: Some(expr.into()),
                ..Query::default()
            },
            &catalog(),
        )
        .unwrap();
        assert_eq!(plan.candidate, Candidate::All);
        assert!(!plan.exact);
    }
}

#[test]
fn temporal_guard_keeps_safe_type_folder_and_string_candidates() {
    let compile_where = |expr: &str, types: Vec<String>| {
        compile(
            &Query {
                where_: Some(expr.into()),
                types,
                ..Query::default()
            },
            &catalog(),
        )
        .unwrap()
    };
    let plan = compile_where("raw.at != '2026-01-01T00:00:00Z'", vec!["task".into()]);
    assert_eq!(plan.candidate, Candidate::HasType("task".into()));
    assert!(!plan.exact);
    let plan = compile_where(
        "file.inFolder('tasks') && raw.at != '2026-01-01T00:00:00Z'",
        vec![],
    );
    assert_eq!(plan.candidate, Candidate::InFolder("tasks".into()));
    assert!(!plan.exact);
    for field in ["day", "plain"] {
        let comparison = format!("{field} == '2026-01-01'");
        let exact = compile_where(&comparison, vec![]);
        assert_eq!(
            exact.candidate,
            Candidate::Compare {
                field: FieldRef::Persisted(vec![field.into()]),
                op: CompareOp::Eq,
                value: Value::string("2026-01-01"),
                pruning: Pruning::Exact
            }
        );
        assert!(exact.exact);
        let combined = compile_where(
            &format!("{comparison} && raw.at != '2026-01-01T00:00:00Z'"),
            vec![],
        );
        assert_eq!(combined.candidate, exact.candidate);
        assert!(!combined.exact);
    }
}

#[test]
fn normalized_link_candidates_keep_the_temporal_residual_guard() {
    use mdbn_core::state::{MemState, StateView};
    for (path, body) in [
        ("s.md", "[[dir]]"),
        ("s.md", "[[dir/a/..]]"),
        ("dir/s.md", "[dir](.)"),
    ] {
        let mut state = MemState::new();
        state.insert_resource("mdbase.yaml", "spec_version: \"0.3.0\"\n");
        state.insert_resource("_types/task.md", TASK);
        state.insert_resource("_types/other.md", OTHER);
        state.insert_record(mdbn_core::ids::Uuid([1; 16]), "dir.md", "---\nt: 1\n---\n");
        let id = mdbn_core::ids::Uuid([2; 16]);
        let source = format!("---\ntype: task\nat: '2026-01-01T00:00:00Z'\n---\n{body}\n");
        state.insert_record(id, path, &source);
        let snapshot = state.catalog();
        let query = Query {
            where_: Some("file.hasLink('[[dir/a/..]]') && raw.at != '2026-01-01T00:00:00Z'".into()),
            ..Query::default()
        };
        let plan = compile(&query, &snapshot).unwrap();
        let Candidate::LinksTo(keys) = &plan.candidate else {
            panic!(
                "temporal slot must stay residual, retaining link candidate: {:?}",
                plan.candidate
            );
        };
        assert!(!plan.exact);
        assert!(keys.contains(&mdbn_core::links::name_index_key(&snapshot, "dir")));
        assert_eq!(
            mdbn_core::query::execute(&plan, &state, &env())
                .unwrap()
                .ids,
            vec![id]
        );
        // The raw text comparison would prune the matching typed timestamp.
        // Canonical link keys and old raw keys both retain it before residual CEL.
        let old: Vec<_> = mdbn_core::links::record_links(&snapshot, path, &source)
            .iter()
            .map(|link| mdbn_core::links::name_index_key(&snapshot, &link.target))
            .collect();
        assert!(keys.iter().any(|key| old.contains(key)), "{path}: {body}");
    }
}

#[test]
fn potentially_typed_slots_still_accept_invalid_and_multitype_strings() {
    for (source, types, literal) in [
        ("---\nat: not-a-date\n---\n", vec!["task"], "not-a-date"),
        (
            "---\nat: '2026-01-01T00:00:00Z'\n---\n",
            vec!["task", "other"],
            "2026-01-01T00:00:00Z",
        ),
    ] {
        let expr = format!("raw.at == '{literal}'");
        let plan = compile(
            &Query {
                where_: Some(expr.clone()),
                ..Query::default()
            },
            &catalog(),
        )
        .unwrap();
        assert_eq!(plan.candidate, Candidate::All);
        assert!(!plan.exact);
        assert_eq!(verdict(&expr, source, &types), Verdict::Match);
    }
}

#[test]
fn projections_where_and_selections_share_typed_temporal_bindings() {
    let query = Query::from_value(&mdbn_core::yaml::parse_value(r#"
projections:
  same: {expr: 'projection["stamp"] == now()'}
  stamp: {expr: 'raw.at'}
  copy: {expr: 'projection.stamp'}
  delta: {expr: 'projection.copy - now()'}
where: 'at == now() && record.at == now() && raw.at == now() && projection.same && projection.copy == now() && projection.delta == duration("0s") && record.record == "shadow" && raw.raw == "shadow" && file.path == "tasks/a.md"'
select:
  - at
  - projection.stamp
  - projection.delta
  - {name: typed, expr: 'record.at'}
  - {name: matched, expr: 'projection["copy"] == now()'}
  - {name: duration_matched, expr: 'projection.delta == duration("0s")'}
"#).unwrap().unwrap()).unwrap();
    let plan = compile(&query, &catalog()).unwrap();
    let doc = Document::parse_at(
        "tasks/a.md",
        "---\nat: '2026-01-01T01:00:00+01:00'\nrecord: shadow\nraw: shadow\nfile: shadow\nprojection: shadow\n---\n",
    );
    let types = vec!["task".into()];
    let record = QueryRecord {
        path: "tasks/a.md",
        types: &types,
        frontmatter: doc.frontmatter(),
        body: None,
    };
    let evaluated = plan.evaluate(&record, &env(), None);
    assert_eq!(evaluated.verdict, Verdict::Match);
    assert!(
        evaluated.diagnostics.is_empty(),
        "{:?}",
        evaluated.diagnostics
    );
    assert_eq!(evaluated.projections.get("same"), Some(&Value::Bool(true)));
    assert_eq!(
        evaluated.values.get("stamp"),
        Some(&Value::string("2026-01-01T00:00:00Z"))
    );
    assert_eq!(
        evaluated.values.get("typed"),
        Some(&Value::string("2026-01-01T00:00:00Z"))
    );
    assert_eq!(evaluated.values.get("delta"), Some(&Value::string("0s")));
    assert_eq!(evaluated.values.get("matched"), Some(&Value::Bool(true)));
    assert_eq!(
        evaluated.values.get("duration_matched"),
        Some(&Value::Bool(true))
    );
    assert_eq!(
        evaluated.values.get("at"),
        Some(&Value::string("2026-01-01T01:00:00+01:00")),
        "field outputs retain original persisted/effective representation"
    );
    assert_eq!(
        record.frontmatter.get("at"),
        plan.effective(&record).get("at")
    );
    assert_eq!(
        evaluated,
        plan.evaluate(&record, &env(), None),
        "captured-clock evaluation remains deterministic"
    );
}

#[test]
fn invalid_or_multitype_temporal_values_keep_projection_selection_diagnostics() {
    let query = Query::from_value(
        &mdbn_core::yaml::parse_value(
            r#"
projections:
  comparison: {expr: 'raw.at < now()'}
where: 'projection.comparison == null'
select:
  - {name: comparison, expr: 'record.at < now()'}
"#,
        )
        .unwrap()
        .unwrap(),
    )
    .unwrap();
    let plan = compile(&query, &catalog()).unwrap();
    for (source, names) in [
        ("---\nat: not-a-date\n---\n", vec!["task".into()]),
        (
            "---\nat: '2026-01-01T00:00:00Z'\n---\n",
            vec!["task".into(), "other".into()],
        ),
        (
            "---\nat: '2026-01-01T00:00:00Z'\n---\n",
            vec!["task".into(), "unknown".into()],
        ),
    ] {
        let doc = Document::parse_at("tasks/a.md", source);
        let record = QueryRecord {
            path: "tasks/a.md",
            types: &names,
            frontmatter: doc.frontmatter(),
            body: None,
        };
        let evaluated = plan.evaluate(&record, &env(), None);
        assert_eq!(evaluated.verdict, Verdict::Match);
        assert_eq!(evaluated.projections.get("comparison"), Some(&Value::Null));
        assert_eq!(evaluated.values.get("comparison"), Some(&Value::Null));
        assert_eq!(evaluated.diagnostics.len(), 2);
        for (issue, expression) in evaluated
            .diagnostics
            .iter()
            .zip(["projections.comparison", "select.comparison"])
        {
            assert_eq!(issue.code, "expression_evaluation_error");
            assert_eq!(
                issue
                    .details
                    .as_ref()
                    .unwrap()
                    .get("expression")
                    .unwrap()
                    .as_str(),
                Some(expression)
            );
        }
    }
}

#[test]
fn read_default_temporal_projections_do_not_invent_persisted_fields() {
    let query = Query::from_value(
        &mdbn_core::yaml::parse_value(
            r#"
projections:
  stamp: {expr: 'at'}
where: 'projection.stamp == now() && !has(raw.at)'
select:
  - projection.stamp
  - {name: absent, expr: '!has(raw.at)'}
  - {name: matched, expr: 'record.at == projection.stamp'}
"#,
        )
        .unwrap()
        .unwrap(),
    )
    .unwrap();
    let plan = compile(&query, &catalog()).unwrap();
    let doc = Document::parse_at("tasks/a.md", "---\n---\n");
    let names = vec!["task".into()];
    let record = QueryRecord {
        path: "tasks/a.md",
        types: &names,
        frontmatter: doc.frontmatter(),
        body: None,
    };
    let evaluated = plan.evaluate(&record, &env(), None);
    assert_eq!(evaluated.verdict, Verdict::Match);
    assert!(evaluated.diagnostics.is_empty());
    assert_eq!(
        evaluated.values.get("stamp"),
        Some(&Value::string("2026-01-01T00:00:00Z"))
    );
    assert_eq!(evaluated.values.get("absent"), Some(&Value::Bool(true)));
    assert_eq!(evaluated.values.get("matched"), Some(&Value::Bool(true)));
    assert!(!record.frontmatter.contains_key("at"));
    assert_eq!(
        plan.effective(&record).get("at"),
        Some(&Value::string("2026-01-01T01:00:00+01:00"))
    );
}

#[test]
fn compiled_plan_owns_its_schema_snapshot() {
    let catalog = catalog();
    let plan = compile(
        &Query {
            where_: Some("at == now()".into()),
            ..Query::default()
        },
        &catalog,
    )
    .unwrap();
    drop(catalog);
    let doc = Document::parse_at("tasks/a.md", "---\nat: '2026-01-01T01:00:00+01:00'\n---\n");
    let types = vec!["task".into()];
    assert_eq!(
        plan.matches(
            &QueryRecord {
                path: "tasks/a.md",
                types: &types,
                frontmatter: doc.frontmatter(),
                body: None
            },
            &env()
        ),
        Verdict::Match
    );
}
