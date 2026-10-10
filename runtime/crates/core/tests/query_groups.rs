//! Complete-match canonical groups, typed reductions, windows and bounded failure.
use mdbn_core::ids::Uuid;
use mdbn_core::query::{self, Query, QueryEnv, QueryRecord};
use mdbn_core::state::{MemState, StateView};
use mdbn_core::types::Catalog;
use mdbn_core::value::{Map, Value};

const TASK: &str = r#"---
kind: mdbase.type
name: task
match: {path_glob: 'tasks/*.md'}
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    properties:
      at: {type: string, format: date-time}
      day: {type: string, format: date}
      box:
        type: object
        properties:
          at: {type: string, format: date-time}
collection:
  read_defaults: {priority: 4}
---
"#;
fn env() -> QueryEnv {
    QueryEnv {
        now_ms: 1_767_225_600_000,
        today: "2026-01-01".into(),
        tz: "UTC".into(),
    }
}
fn parse(s: &str) -> Query {
    Query::from_value(&mdbn_core::yaml::parse_value(s).unwrap().unwrap()).unwrap()
}
fn base() -> MemState {
    let mut s = MemState::new();
    s.insert_resource("mdbase.yaml", "spec_version: '0.3.0'\n");
    s.insert_resource("_types/task.md", TASK);
    assert!(s.catalog().is_valid());
    assert_eq!(s.catalog().types().len(), 1);
    s
}
fn sample() -> MemState {
    let mut s = base();
    for (i, path, fm) in [
        (1, "tasks/z.md", "status: open\nestimate: 1"),
        (2, "tasks/a.md", "status: open\nestimate: 2"),
        (3, "tasks/d.md", "status: done\nestimate: 4"),
        (4, "tasks/n.md", "status: null\nestimate: null"),
        (5, "tasks/m.md", "estimate: 5"),
        (
            6,
            "tasks/x.md",
            "status: open\nestimate: 99\nexcluded: true",
        ),
    ] {
        s.insert_record(Uuid([i; 16]), path, &format!("---\n{fm}\n---\n"));
    }
    s
}
fn run(s: &MemState, yaml: &str) -> query::QueryPage {
    let p = query::compile(&parse(yaml), &s.catalog()).unwrap();
    query::execute(&p, s, &env()).unwrap()
}
#[test]
fn whole_groups_and_counts_survive_zero_limit_and_offset() {
    let s = sample();
    let page = run(
        &s,
        "where: 'excluded != true'\ngroup_by: [{field: status}]\nsummaries: [{field: estimate, function: count, name: n}, {field: estimate, function: sum, name: total}]\nlimit: 0\n",
    );
    assert!(page.ids.is_empty());
    assert_eq!(page.total_count, 5);
    assert!(page.has_more);
    let g = page.groups.unwrap();
    assert_eq!(g.iter().map(|g| g.count).collect::<Vec<_>>(), [1, 2, 2]);
    assert_eq!(g[0].values.get("status"), Some(&Value::string("done")));
    assert_eq!(g[1].summaries.get("total"), Some(&Value::Int(3)));
    assert_eq!(g[2].values.get("status"), Some(&Value::Null));
    assert_eq!(g[2].summaries.get("n"), Some(&Value::Int(2)));
    assert_eq!(g[2].summaries.get("total"), Some(&Value::Int(5)));
    let offset = run(
        &s,
        "where: 'excluded != true'\ngroup_by: [{field: status}]\noffset: 100\nlimit: 1\n",
    );
    assert!(offset.ids.is_empty());
    assert_eq!(offset.total_count, 5);
    assert!(!offset.has_more);
    assert_eq!(
        offset.groups.unwrap().iter().map(|g| g.count).sum::<u64>(),
        5
    );
}
#[test]
fn custom_values_retain_authority_order_and_missing_nulls() {
    let s = sample();
    let p = run(
        &s,
        "where: 'excluded != true'\ngroup_by: [{field: status, direction: desc}]\nsummary_functions: {ordered: {expr: values}}\nsummaries: [{field: estimate, function: ordered}]\nlimit: 1\n",
    );
    assert_eq!(p.ids, [Uuid([1; 16])]); // z.md precedes a.md by final ID, not path.
    let g = p.groups.unwrap();
    assert_eq!(g[0].values.get("status"), Some(&Value::Null));
    assert_eq!(
        g[0].summaries.get("ordered"),
        Some(&Value::List(vec![Value::Null, Value::Int(5)]))
    );
    assert_eq!(
        g[1].summaries.get("ordered"),
        Some(&Value::List(vec![Value::Int(1), Value::Int(2)]))
    );
    let ordered = run(
        &s,
        "where: 'status == \"open\" && excluded != true'\norder_by: [{field: estimate, direction: desc}]\nsummary_functions: {first: 'values[0]'}\nsummaries: [{field: estimate, function: first}]\n",
    );
    assert_eq!(
        ordered.groups.unwrap()[0].summaries.get("first"),
        Some(&Value::Int(2))
    );
}
#[test]
fn summaries_without_grouping_include_empty_match_set() {
    let s = base();
    let p = run(
        &s,
        "summaries: [{field: absent, function: count}, {field: absent, function: sum}]\n",
    );
    let groups = p.groups.unwrap();
    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0].count, 0);
    assert!(groups[0].values.is_empty());
    assert_eq!(groups[0].summaries.get("count"), Some(&Value::Int(0)));
    assert_eq!(groups[0].summaries.get("sum"), Some(&Value::Null));
    assert!(
        run(&s, "group_by: [{field: status}]\n")
            .groups
            .unwrap()
            .is_empty()
    );
    assert!(run(&s, "{}\n").groups.is_none());
}
#[test]
fn defaults_projection_and_selection_aliases_are_shared_values() {
    let s = sample();
    let p = run(
        &s,
        "projections: {level: {expr: 'priority + 1'}}\nselect: [{name: bucket, expr: 'projection.level + 1'}]\ngroup_by: [{field: bucket}]\nsummaries: [{field: projection.level, function: sum}]\n",
    );
    let g = p.groups.unwrap();
    assert_eq!(g.len(), 1);
    assert_eq!(g[0].count, 6);
    assert_eq!(g[0].values.get("bucket"), Some(&Value::Int(6)));
    assert_eq!(g[0].summaries.get("sum"), Some(&Value::Int(30)));
}
#[test]
fn equal_length_containers_remain_distinct_deep_values() {
    let mut s = base();
    for (i, v) in [(1, "[2]"), (2, "[1]"), (3, "[2]")] {
        s.insert_record(
            Uuid([i; 16]),
            &format!("tasks/{i}.md"),
            &format!("---\nstatus: {v}\n---\n"),
        );
    }
    let g = run(&s, "group_by: [{field: status}]\n").groups.unwrap();
    assert_eq!(g.len(), 2);
    assert_eq!(g[0].count, 2);
    assert_eq!(g[1].count, 1);
    assert_eq!(
        g[0].values.get("status"),
        Some(&Value::List(vec![Value::Int(2)]))
    );
}
#[test]
fn builtins_ignore_null_and_diagnose_incompatible_and_integer_overflow() {
    let mut s = base();
    for (i, v) in [(1, "1"), (2, "2"), (3, "null")] {
        s.insert_record(
            Uuid([i; 16]),
            &format!("tasks/{i}.md"),
            &format!("---\nv: {v}\n---\n"),
        );
    }
    let p = run(
        &s,
        "summaries: [{field: v, function: count}, {field: v, function: sum}, {field: v, function: average}, {field: v, function: minimum}, {field: v, function: maximum}, {field: v, function: empty}, {field: v, function: filled}]\n",
    );
    assert!(p.diagnostics.is_empty());
    let g = &p.groups.unwrap()[0];
    for (name, n) in [
        ("count", 3),
        ("sum", 3),
        ("minimum", 1),
        ("maximum", 2),
        ("empty", 1),
        ("filled", 2),
    ] {
        assert_eq!(g.summaries.get(name), Some(&Value::Int(n)), "{name}");
    }
    assert_eq!(g.summaries.get("average"), Value::float(1.5).as_ref());
    s.insert_record(Uuid([4; 16]), "tasks/4.md", "---\nv: false\n---\n");
    let p = run(&s, "summaries: [{field: v, function: sum}]\n");
    assert_eq!(p.diagnostics.len(), 1);
    assert_eq!(
        p.groups.unwrap()[0].summaries.get("sum"),
        Some(&Value::Null)
    );
    let mut s = base();
    s.insert_record(
        Uuid([1; 16]),
        "tasks/a.md",
        "---\nv: 9223372036854775807\n---\n",
    );
    s.insert_record(Uuid([2; 16]), "tasks/b.md", "---\nv: 1\n---\n");
    let p = run(&s, "summaries: [{field: v, function: sum}]\n");
    assert_eq!(p.diagnostics.len(), 1);
    assert_eq!(
        p.groups.unwrap()[0].summaries.get("sum"),
        Some(&Value::Null)
    );
}
#[test]
fn schema_timestamps_group_by_instant_and_reduce_temporally() {
    let mut s = base();
    for (i, at) in [
        (1, "2026-01-01T01:00:00+01:00"),
        (2, "2026-01-01T00:00:00Z"),
        (3, "2025-12-31T23:30:00Z"),
    ] {
        s.insert_record(
            Uuid([i; 16]),
            &format!("tasks/{i}.md"),
            &format!("---\nat: '{at}'\nbox: {{at: '{at}'}}\n---\n"),
        );
    }
    let p = run(&s, "group_by: [{field: at}]\n");
    let g = p.groups.unwrap();
    assert_eq!(g.len(), 2);
    assert_eq!(g[0].count, 1);
    assert_eq!(g[1].count, 2);
    let p = run(
        &s,
        "summary_functions: {year: {expr: 'values[0].getFullYear()'}, nested_year: {expr: 'values[0].at.getFullYear()'}}\nsummaries: [{field: at, function: earliest}, {field: at, function: latest}, {field: at, function: year}, {field: box, function: nested_year}]\n",
    );
    assert!(p.diagnostics.is_empty());
    let g = &p.groups.unwrap()[0];
    assert_eq!(
        g.summaries.get("earliest"),
        Some(&Value::string("2025-12-31T23:30:00Z"))
    );
    assert_eq!(
        g.summaries.get("latest"),
        Some(&Value::string("2026-01-01T01:00:00+01:00"))
    );
    assert_eq!(g.summaries.get("year"), Some(&Value::Int(2026)));
    assert_eq!(g.summaries.get("nested_year"), Some(&Value::Int(2026)));
}
#[test]
fn native_computed_timestamp_is_not_plain_string_cast() {
    let mut s = base();
    s.insert_record(
        Uuid([1; 16]),
        "tasks/1.md",
        "---\nat: '2026-01-01T00:00:00Z'\n---\n",
    );
    let p = run(
        &s,
        "projections: {ts: {expr: at}, text: {expr: 'string(at)'}}\nsummary_functions: {year: 'values[0].getFullYear()'}\nsummaries: [{field: projection.ts, function: year, name: native}, {field: projection.text, function: year, name: text}]\n",
    );
    assert_eq!(p.diagnostics.len(), 1);
    let g = &p.groups.unwrap()[0];
    assert_eq!(g.summaries.get("native"), Some(&Value::Int(2026)));
    assert_eq!(g.summaries.get("text"), Some(&Value::Null));
}
#[test]
fn custom_summary_clock_is_the_captured_query_clock() {
    let s = sample();
    let q = parse(
        "summary_functions: {clock: 'string(now())', day: 'today()'}\nsummaries: [{field: absent, function: clock}, {field: absent, function: day}]\n",
    );
    let plan = query::compile(&q, &s.catalog()).unwrap();
    assert!(plan.requirements.time_dependent);
    let p = query::execute(&plan, &s, &env()).unwrap();
    let g = &p.groups.unwrap()[0];
    assert_eq!(
        g.summaries.get("clock"),
        Some(&Value::string("2026-01-01T00:00:00Z"))
    );
    assert_eq!(g.summaries.get("day"), Some(&Value::string("2026-01-01")));
}
#[test]
fn all_matched_schemas_must_agree_no_shape_guessing() {
    let cat = Catalog::load([("_types/task.md", TASK)]);
    let q = parse("group_by: [{field: at}]\n");
    let p = query::compile(&q, &cat).unwrap();
    let a: Map = [("at".into(), Value::string("2026-01-01T01:00:00+01:00"))]
        .into_iter()
        .collect();
    let b: Map = [("at".into(), Value::string("2026-01-01T00:00:00Z"))]
        .into_iter()
        .collect();
    for names in [
        vec!["task".into()],
        vec!["task".into(), "unknown".into()],
        vec![],
    ] {
        let eval = |fm| {
            p.evaluate(
                &QueryRecord {
                    path: "tasks/x.md",
                    types: &names,
                    frontmatter: fm,
                    body: None,
                },
                &env(),
                None,
            )
        };
        let x = eval(&a);
        let y = eval(&b);
        let g = query::groups::reduce(
            &q.group_by,
            &p.summaries,
            &[&x.reduction, &y.reduction],
            &env(),
            &mut vec![],
        )
        .unwrap()
        .unwrap();
        assert_eq!(g.len(), if names.len() == 1 { 1 } else { 2 });
    }
}
#[test]
fn exact_numeric_identity_and_container_key_set_equality() {
    let mut s = base();
    for (i, v) in [
        (1, "9007199254740993"),
        (2, "9007199254740992"),
        (3, "9007199254740992.0"),
    ] {
        s.insert_record(
            Uuid([i; 16]),
            &format!("tasks/{i}.md"),
            &format!("---\nv: {v}\n---\n"),
        );
    }
    let p = run(
        &s,
        "group_by: [{field: v}]\nsummaries: [{field: v, function: minimum}, {field: v, function: maximum}]\n",
    );
    let g = p.groups.unwrap();
    assert_eq!(g.len(), 2);
    assert_eq!(g[0].count, 2);
    assert_eq!(g[1].count, 1);
    assert_eq!(
        g[1].summaries.get("maximum"),
        Some(&Value::Int(9_007_199_254_740_993))
    );
    let mut s = base();
    s.insert_record(Uuid([1; 16]), "tasks/a.md", "---\nv: {a: 1, b: 2}\n---\n");
    s.insert_record(Uuid([2; 16]), "tasks/b.md", "---\nv: {b: 2, a: 1.0}\n---\n");
    let g = run(&s, "group_by: [{field: v}]\n").groups.unwrap();
    assert_eq!(g.len(), 1);
    assert_eq!(g[0].count, 2);
}
#[test]
fn typed_dates_do_not_merge_with_plain_lookalike_text() {
    let cat = Catalog::load([("_types/task.md", TASK)]);
    let q = parse("group_by: [{field: day}]\n");
    let p = query::compile(&q, &cat).unwrap();
    let fm: Map = [("day".into(), Value::string("2026-01-01"))]
        .into_iter()
        .collect();
    let names = vec!["task".into()];
    let r = QueryRecord {
        path: "tasks/a.md",
        types: &names,
        frontmatter: &fm,
        body: None,
    };
    let typed = p.evaluate(&r, &env(), None);
    let plain = p.evaluate(&QueryRecord { types: &[], ..r }, &env(), None);
    let g = query::groups::reduce(
        &q.group_by,
        &p.summaries,
        &[&typed.reduction, &plain.reduction],
        &env(),
        &mut vec![],
    )
    .unwrap()
    .unwrap();
    assert_eq!(g.len(), 2);
    let missing_profile =
        query::compile(&parse("group_by: [{field: file.mtime}]"), &cat).unwrap_err();
    assert_eq!(missing_profile.code, "query_profile_unavailable");
}
#[test]
fn invalid_metadata_validates_before_false_candidates() {
    let s = base();
    for yaml in [
        "where: 'false'\ngroup_by: [{field: projection.missing}]",
        "where: 'false'\nsummaries: [{field: v, function: missing}]",
        "where: 'false'\nsummaries: [{field: v, function: count}, {field: x, function: count}]",
        "where: 'false'\nsummary_functions: {bad: {expr: '('}}",
    ] {
        assert_eq!(
            query::compile(&parse(yaml), &s.catalog()).unwrap_err().code,
            "invalid_query"
        );
    }
    for yaml in [
        "group_by: false",
        "group_by: [{field: v, direction: 1}]",
        "summaries: true",
        "summary_functions: []",
    ] {
        assert!(
            Query::from_value(&mdbn_core::yaml::parse_value(yaml).unwrap().unwrap()).is_err(),
            "{yaml}"
        );
    }
}
#[test]
fn incomplete_or_oversized_whole_metadata_fails_explicitly() {
    let mut s = base();
    for n in 0u16..1001 {
        let mut id = [0; 16];
        id[0..2].copy_from_slice(&n.to_be_bytes());
        s.insert_record(
            Uuid(id),
            &format!("tasks/{n}.md"),
            "---\nstatus: open\n---\n",
        );
    }
    let p = query::compile(
        &parse("group_by: [{field: status}]\nlimit: 0"),
        &s.catalog(),
    )
    .unwrap();
    assert_eq!(
        query::execute(&p, &s, &env()).unwrap_err().code,
        "query_budget_exceeded"
    );
    let fm: Map = [(
        "status".into(),
        Value::string("x".repeat(query::groups::MAX_BYTES)),
    )]
    .into_iter()
    .collect();
    let ev = p.evaluate(
        &QueryRecord {
            path: "tasks/x.md",
            types: &[],
            frontmatter: &fm,
            body: None,
        },
        &env(),
        None,
    );
    assert_eq!(ev.reduction_error.unwrap().code, "query_budget_exceeded");
    assert!(
        query::groups::reduce(
            &p.query.group_by,
            &p.summaries,
            &[&query::groups::Row::default()],
            &env(),
            &mut vec![]
        )
        .is_err()
    );
}
