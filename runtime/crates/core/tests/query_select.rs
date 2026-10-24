//! Named projections and `select` (spec 11).
#![allow(clippy::unwrap_used, clippy::expect_used)]

use mdbn_core::ids::Uuid;
use mdbn_core::query::{self, Query, QueryEnv};
use mdbn_core::state::{MemState, StateView};
use mdbn_core::value::Value;

fn id(n: u8) -> Uuid {
    let mut b = [0u8; 16];
    b[15] = n;
    Uuid(b)
}

fn state() -> MemState {
    let mut s = MemState::new();
    s.insert_resource(
        "_types/task.md",
        "---\nkind: mdbase.type\nname: task\nmatch:\n  path_glob: \"tasks/*.md\"\nschema:\n  dialect: json-schema-2020-12\n  value: {type: object}\ncollection:\n  read_defaults:\n    status: open\n---\n",
    );
    s.insert_record(
        id(1),
        "tasks/a.md",
        "---\ntitle: A\npriority: 1\ndue: \"2025-12-01\"\n---\n",
    );
    s.insert_record(
        id(2),
        "tasks/b.md",
        "---\ntitle: B\npriority: 5\nstatus: done\n---\n",
    );
    s.insert_record(
        id(3),
        "tasks/c.md",
        "---\ntitle: C\npriority: 3\ndue: \"2026-03-01\"\n---\n",
    );
    s
}

fn env() -> QueryEnv {
    QueryEnv {
        now_ms: 1_767_225_600_000,
        tz: "UTC".into(),
        today: "2026-01-01".into(),
    }
}

fn parse(yaml: &str) -> Query {
    Query::from_value(&mdbn_core::yaml::parse_value(yaml).unwrap().unwrap()).unwrap()
}

#[test]
fn projections_feed_where_select_and_order() {
    let q = parse(
        r#"
projections:
  urgency:
    expr: 'priority + (projection.is_overdue ? 10 : 0)'
  is_overdue:
    expr: 'has(raw.due) && raw.due < "2026-01-01" && status != "done"'
where: 'projection.urgency >= 3'
select:
  - title
  - file.name
  - projection.urgency
  - name: label
    expr: 'title + "!"'
order_by:
  - field: projection.urgency
    direction: desc
"#,
    );
    let s = state();
    let plan = query::compile(&q, &s.catalog()).unwrap();
    // `urgency` depends on `is_overdue`, declared after it.
    let order: Vec<&str> = plan.projections.iter().map(|p| p.name.as_str()).collect();
    assert_eq!(order, ["is_overdue", "urgency"]);
    let page = query::execute(&plan, &s, &env()).unwrap();
    assert_eq!(page.ids, [id(1), id(2), id(3)]);
    let v = &page.values[0];
    assert_eq!(v.get("urgency"), Some(&Value::Int(11)));
    assert_eq!(v.get("title"), Some(&Value::string("A")));
    assert_eq!(v.get("name"), Some(&Value::string("a.md")));
    assert_eq!(v.get("label"), Some(&Value::string("A!")));
}

#[test]
fn invalid_projections_and_selections() {
    let s = state();
    let bad = |yaml: &str| query::compile(&parse(yaml), &s.catalog()).unwrap_err().code;
    assert_eq!(
        bad("projections:\n  a: {expr: 'projection.b'}\n  b: {expr: 'projection.a'}\n"),
        "invalid_query"
    );
    assert_eq!(
        bad("projections:\n  a: {expr: 'projection.zzz'}\n"),
        "invalid_query"
    );
    assert_eq!(
        bad("select: [title, {name: title, expr: '1'}]\n"),
        "invalid_query"
    );
    assert_eq!(bad("select: [projection.nope]\n"), "invalid_query");
}

#[test]
fn literal_bracket_dependencies_have_dot_access_order_and_results() {
    let s = state();
    let dot = parse(
        "projections:\n  a: {expr: 'projection.b + 1'}\n  b: {expr: 'priority'}\nselect: [projection.a, projection.b]\nwhere: 'projection.a > 0'\n",
    );
    let dot_plan = query::compile(&dot, &s.catalog()).unwrap();
    let expected = query::execute(&dot_plan, &s, &env()).unwrap();
    assert!(expected.diagnostics.is_empty());
    for expr in [
        "projection[\"b\"] + 1",
        "projection['b'] + 1",
        "[projection['b']][0] + 1",
        "(true ? projection['b'] : 0) + 1",
        "[projection['b']].map(x, x + 1)[0]",
    ] {
        let mut bracket = dot.clone();
        bracket.projections[0].1 = expr.into();
        let plan = query::compile(&bracket, &s.catalog()).unwrap();
        assert_eq!(
            plan.projections
                .iter()
                .map(|p| p.name.as_str())
                .collect::<Vec<_>>(),
            ["b", "a"],
            "{expr}"
        );
        assert_eq!(
            query::execute(&plan, &s, &env()).unwrap(),
            expected,
            "{expr}"
        );
    }
}

#[test]
fn literal_bracket_unknowns_and_cycles_reject_before_candidates() {
    let s = state();
    for declarations in [
        vec![("a", "projection[\"missing\"]")],
        vec![("a", "projection[\"a\"]")],
        vec![("a", "projection[\"b\"]"), ("b", "projection[\"a\"]")],
        vec![("a", "projection.b"), ("b", "projection[\"a\"]")],
        vec![("a", "projection[\"b\"][0]"), ("b", "projection[\"a\"]")],
        vec![
            ("a", "[projection['b']].all(x, x > 0)"),
            ("b", "projection['a']"),
        ],
    ] {
        let q = Query {
            projections: declarations
                .iter()
                .map(|(n, e)| ((*n).into(), (*e).into()))
                .collect(),
            where_: Some("false".into()),
            ..Query::default()
        };
        let error = query::compile(&q, &s.catalog())
            .expect_err("dependencies must validate even when no candidate can match");
        assert_eq!(error.code, "invalid_query", "{declarations:?}");
    }
}

#[test]
fn a_failing_projection_is_null_with_a_diagnostic() {
    let s = state();
    let plan = query::compile(
        &parse("projections:\n  x: {expr: 'raw.missing + 1'}\nselect: [projection.x]\n"),
        &s.catalog(),
    )
    .unwrap();
    let page = query::execute(&plan, &s, &env()).unwrap();
    assert_eq!(page.ids.len(), 3);
    assert_eq!(page.values[0].get("x"), Some(&Value::Null));
    assert_eq!(page.diagnostics.len(), 3);
}
