//! Trusted projection and actual executor parity with portable index atoms.
use mdbn_core::ids::Uuid;
use mdbn_core::query::indexed::{self, AtomKind, IndexKeyError, TemporalHint};
use mdbn_core::query::topk::{self, KeyedRecord};
use mdbn_core::query::{self, Direction, FieldRef, Query, QueryEnv, QueryRecord};
use mdbn_core::state::{MemState, StateView};
use mdbn_core::types::Catalog;
use mdbn_core::value::{Map, Value};
use std::cmp::Ordering;

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
collection:
  read_defaults:
    at: '2026-01-01T01:00:00+01:00'
    priority: 4
---
"#;
const OTHER: &str = "---\nkind: mdbase.type\nname: other\nschema:\n  dialect: json-schema-2020-12\n  value: {type: object}\n---\n";
fn catalog() -> Catalog {
    let c = Catalog::load([
        ("mdbase.yaml", "spec_version: \"0.3.0\"\n"),
        ("_types/task.md", TASK),
        ("_types/other.md", OTHER),
    ]);
    assert!(c.is_valid());
    assert_eq!(c.types().len(), 2, "{:?}", c.issues());
    c
}
fn env() -> QueryEnv {
    QueryEnv {
        now_ms: 1_767_225_600_000,
        today: "2026-01-01".into(),
        tz: "UTC".into(),
    }
}
fn parse(yaml: &str) -> Query {
    Query::from_value(&mdbn_core::yaml::parse_value(yaml).unwrap().unwrap()).unwrap()
}
fn fm(value: Value) -> Map {
    [("at".into(), value)].into_iter().collect()
}

#[test]
fn trusted_projection_uses_defaults_nulls_and_all_matched_schema_types() {
    let c = catalog();
    let types = vec!["task".into()];
    let empty = Map::new();
    let mut record = QueryRecord {
        path: "tasks/a.md",
        types: &types,
        frontmatter: &empty,
        body: None,
        mtime: None,
    };
    let fields = vec![
        FieldRef::Effective(vec!["at".into()]),
        FieldRef::Effective(vec!["priority".into()]),
    ];
    let projected = indexed::project_index_fields(&c, &record, &fields, 128).unwrap();
    assert_eq!(projected[0].0.temporal, TemporalHint::DateTime);
    assert_eq!(projected[0].1.kind(), AtomKind::Temporal);
    assert_eq!(
        projected[1].1,
        indexed::SortAtom::from_value(Some(&Value::Int(4)), TemporalHint::None, 128).unwrap()
    );
    let explicit_null = fm(Value::Null);
    record.frontmatter = &explicit_null;
    assert_eq!(
        indexed::project_index_fields(&c, &record, &fields, 128).unwrap()[0]
            .1
            .kind(),
        AtomKind::Null
    );
    let text = fm(Value::string("2026-01-01T01:00:00+01:00"));
    record.frontmatter = &text;
    for names in [
        vec![],
        vec!["task".into(), "other".into()],
        vec!["task".into(), "unknown".into()],
    ] {
        let per_types = QueryRecord {
            types: &names,
            ..record.clone()
        };
        let p = indexed::project_index_fields(&c, &per_types, &fields, 128).unwrap();
        assert_eq!(p[0].0.temporal, TemporalHint::None);
        assert_eq!(p[0].1.kind(), AtomKind::Text);
    }
    record.types = &types;
    for field in [
        FieldRef::Persisted(vec!["at".into()]),
        FieldRef::Effective(vec!["nested".into(), "at".into()]),
    ] {
        assert_eq!(
            indexed::project_index_fields(&c, &record, &[field], 128),
            Err(IndexKeyError::Invalid)
        );
    }
    assert_eq!(
        indexed::project_index_fields(&c, &record, &fields, 1),
        Err(IndexKeyError::TooWide)
    );
}

#[test]
fn prepared_and_direct_comparators_match_row_atoms_then_path_ties() {
    let c = catalog();
    let types = vec!["task".into()];
    let left = fm(Value::string("2026-01-01T01:00:00+01:00"));
    let right = fm(Value::string("2026-01-01T00:30:00Z"));
    let a = QueryRecord {
        path: "tasks/z.md",
        types: &types,
        frontmatter: &left,
        body: None,
        mtime: None,
    };
    let b = QueryRecord {
        path: "tasks/a.md",
        types: &types,
        frontmatter: &right,
        body: None,
        mtime: None,
    };
    for (direction, name) in [(Direction::Asc, "asc"), (Direction::Desc, "desc")] {
        let plan = query::compile(
            &parse(&format!("order_by: [{{field: at, direction: {name}}}]")),
            &c,
        )
        .unwrap();
        let (ae, be) = (
            plan.evaluate(&a, &env(), None),
            plan.evaluate(&b, &env(), None),
        );
        let field = [FieldRef::Effective(vec!["at".into()])];
        let ka = KeyedRecord {
            id: Uuid([1; 16]),
            path: a.path.into(),
            keys: indexed::project_index_fields(&c, &a, &field, 128)
                .unwrap()
                .into_iter()
                .map(|(_, k)| k)
                .collect(),
        };
        let kb = KeyedRecord {
            id: Uuid([2; 16]),
            path: b.path.into(),
            keys: indexed::project_index_fields(&c, &b, &field, 128)
                .unwrap()
                .into_iter()
                .map(|(_, k)| k)
                .collect(),
        };
        let expected = topk::compare(&ka, &kb, &[direction]);
        assert_eq!(plan.compare(&a, &b), expected);
        assert_eq!(
            plan.compare_evaluated((a.path, &ae), (b.path, &be)),
            expected
        );
        assert_eq!(
            expected,
            if direction == Direction::Asc {
                Ordering::Less
            } else {
                Ordering::Greater
            }
        );
        // Same instant: path ASC stays final even in DESC, against ID order
        // (`tasks/a.md` has the larger ID).
        let equal = QueryRecord {
            frontmatter: &left,
            ..b.clone()
        };
        let ee = plan.evaluate(&equal, &env(), None);
        let ke = KeyedRecord {
            keys: ka.keys.clone(),
            ..kb.clone()
        };
        assert_eq!(topk::compare(&ka, &ke, &[direction]), Ordering::Greater);
        assert_eq!(plan.compare(&a, &equal), Ordering::Greater);
        assert_eq!(
            plan.compare_evaluated((a.path, &ae), (equal.path, &ee)),
            Ordering::Greater
        );
    }
}

#[test]
fn actual_core_executor_uses_typed_instants_and_path_ties_in_both_directions() {
    let mut s = MemState::new();
    s.insert_resource("_types/task.md", TASK);
    s.insert_record(
        Uuid([1; 16]),
        "tasks/z.md",
        "---\nat: '2026-01-01T01:00:00+01:00'\n---\n",
    );
    s.insert_record(
        Uuid([2; 16]),
        "tasks/a.md",
        "---\nat: '2026-01-01T00:00:00Z'\n---\n",
    );
    s.insert_record(
        Uuid([3; 16]),
        "tasks/b.md",
        "---\nat: '2026-01-01T00:30:00Z'\n---\n",
    );
    for (name, expected) in [
        // `tasks/z.md` (ID 1) and `tasks/a.md` (ID 2) name the same instant.
        ("asc", [Uuid([2; 16]), Uuid([1; 16]), Uuid([3; 16])]),
        ("desc", [Uuid([3; 16]), Uuid([2; 16]), Uuid([1; 16])]),
    ] {
        let plan = query::compile(
            &parse(&format!("order_by: [{{field: at, direction: {name}}}]")),
            &s.catalog(),
        )
        .unwrap();
        assert_eq!(query::execute(&plan, &s, &env()).unwrap().ids, expected);
    }
    let plan = query::compile(
        &parse("order_by: [{field: at}, {field: file.path, direction: desc}]"),
        &s.catalog(),
    )
    .unwrap();
    assert_eq!(
        query::execute(&plan, &s, &env()).unwrap().ids,
        [Uuid([1; 16]), Uuid([2; 16]), Uuid([3; 16])]
    );

    // A window boundary inside the run of ties splits it by path, and a rename
    // moves a record within the run in both directions.
    let page = |s: &MemState, direction: &str, offset: u8| {
        let plan = query::compile(
            &parse(&format!(
                "order_by: [{{field: at, direction: {direction}}}]\noffset: {offset}\nlimit: 1"
            )),
            &s.catalog(),
        )
        .unwrap();
        query::execute(&plan, s, &env()).unwrap().ids
    };
    assert_eq!(page(&s, "asc", 0), [Uuid([2; 16])]);
    assert_eq!(page(&s, "asc", 1), [Uuid([1; 16])]);
    assert_eq!(page(&s, "desc", 1), [Uuid([2; 16])]);
    assert_eq!(page(&s, "desc", 2), [Uuid([1; 16])]);
    s.insert_record(
        Uuid([1; 16]),
        "tasks/0.md",
        "---\nat: '2026-01-01T01:00:00+01:00'\n---\n",
    );
    assert_eq!(page(&s, "asc", 0), [Uuid([1; 16])]);
    assert_eq!(page(&s, "asc", 1), [Uuid([2; 16])]);
    assert_eq!(page(&s, "desc", 1), [Uuid([1; 16])]);
    assert_eq!(page(&s, "desc", 2), [Uuid([2; 16])]);
}

#[test]
fn per_record_hints_preserve_total_kind_order_and_plain_string_classification() {
    let c = catalog();
    let typed = vec!["task".into()];
    let untyped = vec!["other".into()];
    let values = [
        Value::Bool(false),
        Value::Int(1),
        Value::string("2026-01-01T00:00:00Z"),
        Value::string("2025-01-01T00:00:00Z"),
        Value::List(vec![]),
        Value::Map(Map::new()),
        Value::Null,
    ];
    let data: Vec<_> = values.into_iter().map(fm).collect();
    let records: Vec<_> = data
        .iter()
        .enumerate()
        .map(|(i, frontmatter)| QueryRecord {
            path: "tasks/a.md",
            types: if i == 3 { &untyped } else { &typed },
            frontmatter,
            body: None,
            mtime: None,
        })
        .collect();
    for direction in ["asc", "desc"] {
        let plan = query::compile(
            &parse(&format!(
                "order_by: [{{field: at, direction: {direction}}}]"
            )),
            &c,
        )
        .unwrap();
        for (i, a) in records.iter().enumerate() {
            for (j, b) in records.iter().enumerate() {
                let expected = if direction == "asc" {
                    i.cmp(&j)
                } else {
                    j.cmp(&i)
                };
                let (ae, be) = (
                    plan.evaluate(a, &env(), None),
                    plan.evaluate(b, &env(), None),
                );
                assert_eq!(plan.compare(a, b), expected);
                assert_eq!(
                    plan.compare_evaluated((a.path, &ae), (b.path, &be)),
                    expected
                );
            }
        }
    }
}

#[test]
fn native_timestamp_order_terms_remain_typed_but_string_casts_do_not() {
    let c = catalog();
    let types = vec!["task".into()];
    let left = fm(Value::string("2026-01-01T01:00:00+01:00"));
    let right = fm(Value::string("2026-01-01T00:30:00Z"));
    let a = QueryRecord {
        path: "tasks/z.md",
        types: &types,
        frontmatter: &left,
        body: None,
        mtime: None,
    };
    let b = QueryRecord {
        path: "tasks/a.md",
        types: &types,
        frontmatter: &right,
        body: None,
        mtime: None,
    };
    for query in [
        "projections: {when: {expr: at}}\norder_by: [{field: projection.when}]",
        "select: [{name: when, expr: at}]\norder_by: [{field: when}]",
    ] {
        let plan = query::compile(&parse(query), &c).unwrap();
        let (ae, be) = (
            plan.evaluate(&a, &env(), None),
            plan.evaluate(&b, &env(), None),
        );
        assert_eq!(ae.sort_hints, [TemporalHint::DateTime]);
        assert_eq!(
            plan.compare_evaluated((a.path, &ae), (b.path, &be)),
            Ordering::Less
        );
    }
    let plan = query::compile(
        &parse("select: [{name: at, expr: 'string(at)'}]\norder_by: [{field: at}]"),
        &c,
    )
    .unwrap();
    assert_eq!(
        plan.evaluate(&a, &env(), None).sort_hints,
        [TemporalHint::None]
    );
}

#[test]
fn projected_temporal_type_lookup_matches_catalog_unicode_case_rules() {
    let named = TASK.replace("name: task", "name: Événement");
    let c = Catalog::load([
        ("mdbase.yaml", "spec_version: \"0.3.0\"\n"),
        ("_types/event.md", named.as_str()),
    ]);
    assert_eq!(c.types().len(), 1, "{:?}", c.issues());
    let types = vec!["ÉVÉNEMENT".into()];
    let persisted = Map::new();
    let record = QueryRecord {
        path: "tasks/a.md",
        types: &types,
        frontmatter: &persisted,
        body: None,
        mtime: None,
    };
    let fields = [FieldRef::Effective(vec!["at".into()])];
    let projected = indexed::project_index_fields(&c, &record, &fields, 128).unwrap();
    assert_eq!(projected[0].0.temporal, TemporalHint::DateTime);
    assert_eq!(projected[0].1.kind(), AtomKind::Temporal);
    let plan = query::compile(&parse("order_by: [{field: at}]"), &c).unwrap();
    assert_eq!(
        plan.evaluate(&record, &env(), None).sort_hints,
        [projected[0].0.temporal]
    );
}

#[test]
fn floating_times_share_instants_across_cel_sorting_and_index_projection() {
    let schema = TASK.replace("at: {type: string, format: date-time}", r##"at: {anyOf: [{$ref: '#/$defs/instant'}, {$ref: '#/$defs/local'}]}
      start: {oneOf: [{$ref: '#/$defs/local'}, {$ref: '#/$defs/instant'}]}
      clock: {$ref: '#/$defs/local'}
      due: {anyOf: [{type: string, format: date}, {$ref: '#/$defs/instant'}, {$ref: '#/$defs/local'}]}
      nested: {type: array, items: {$ref: '#/$defs/local'}}
      partial: {anyOf: [{type: string, format: date-time}, {format: local-date-time}]}"##)
        .replace("collection:", r#"    $defs:
      instant: {type: string, format: date-time}
      local: {type: string, format: local-date-time}
collection:"#);
    for zone in [None, Some("America/New_York")] {
        let mut config = "spec_version: '0.3.0'\n".to_owned();
        if let Some(zone) = zone {
            config.push_str(&format!("settings: {{timezone: {zone}}}\n"));
        }
        let c = Catalog::load([
            ("mdbase.yaml", config.as_str()),
            ("_types/task.md", schema.as_str()),
            ("_types/other.md", OTHER),
        ]);
        assert!(c.is_valid(), "{:?}", c.issues());
        let types = vec!["task".into()];
        let local = "2026-11-01T01:30";
        // During the New York overlap this is 05:30Z (the earlier 01:30).
        let mut fields = fm(Value::string(local));
        for key in ["clock", "start", "due", "partial"] {
            fields.insert(key, Value::string(local));
        }
        fields.insert(
            "nested",
            Value::List(vec![Value::string("2026-03-08T02:30:12.12345678987")]),
        );
        let offset = fm(Value::string("2026-11-01T06:00:00Z"));
        let a = QueryRecord {
            path: "tasks/a.md",
            types: &types,
            frontmatter: &fields,
            body: None,
            mtime: None,
        };
        let b = QueryRecord {
            path: "tasks/b.md",
            frontmatter: &offset,
            ..a.clone()
        };
        let expr = if zone.is_some() {
            r#"at == timestamp("2026-11-01T05:30:00Z") && raw.at == at && start == at && clock == at && record.nested[0] == timestamp("2026-03-08T07:30:12.123456789Z")"#
        } else {
            r#"at == "2026-11-01T01:30" && raw.at == at && start == at && clock == at && record.nested[0] == "2026-03-08T02:30:12.12345678987""#
        };
        let filter = format!("where: '{expr} && due == \"{local}\" && partial == due'");
        let plan = query::compile(&parse(&filter), &c).unwrap();
        assert_eq!(plan.matches(&a, &env()), query::Verdict::Match);
        let types = vec!["task".into(), "other".into()];
        assert!(!c.is_date_time(&types, &["at"]));
        assert_eq!(
            c.effective_values(a.path, a.types, &fields).get("at"),
            fields.get("at")
        );

        for key in ["at", "start", "clock"] {
            let query = parse(&format!("where: 'raw.{key} != \"{local}\"'"));
            let plan = query::compile(&query, &c).unwrap();
            assert_eq!(plan.candidate, query::Candidate::All);
            assert!(!plan.exact);
        }
        let plan = query::compile(&parse("order_by: [{field: at}]"), &c).unwrap();
        let ae = plan.evaluate(&a, &env(), None);
        let be = plan.evaluate(&b, &env(), None);
        let expected = if zone.is_some() {
            Ordering::Less
        } else {
            Ordering::Greater
        };
        assert_eq!(plan.compare(&a, &b), expected);
        assert_eq!(
            plan.compare_evaluated((a.path, &ae), (b.path, &be)),
            expected
        );
        let atom = |r: &QueryRecord| {
            indexed::project_index_fields(&c, r, &[FieldRef::Effective(vec!["at".into()])], 128)
                .unwrap()
                .remove(0)
                .1
        };
        assert_eq!(atom(&a).cmp(&atom(&b)), expected);
        assert_eq!(
            atom(&a).kind(),
            if zone.is_some() {
                AtomKind::Temporal
            } else {
                AtomKind::Text
            }
        );
    }
}

#[test]
fn a_spelling_rejected_by_any_matched_format_stays_text_without_a_zone_warning() {
    use mdbn_core::validate::validate_record;
    let local_only = TASK
        .replace("name: task", "name: floating")
        .replace("format: date-time", "format: local-date-time");
    for zone in ["", "settings: {timezone: America/New_York}"] {
        let config = format!("spec_version: '0.3.0'\n{zone}\n");
        let c = Catalog::load([
            ("mdbase.yaml", config.as_str()),
            ("_types/task.md", TASK),
            ("_types/floating.md", local_only.as_str()),
        ]);
        for (types, text) in [
            (vec!["task".to_owned()], "2026-11-01T01:30"),
            (vec!["floating".to_owned()], "2026-11-01T06:00:00Z"),
            (
                vec!["task".to_owned(), "floating".to_owned()],
                "2026-11-01T01:30",
            ),
            (
                vec!["task".to_owned(), "floating".to_owned()],
                "2026-11-01T06:00:00Z",
            ),
        ] {
            let source = format!("---\ntype: [{}]\nat: '{text}'\n---\n", types.join(", "));
            let issues = validate_record(&c, "tasks/a.md", &source);
            assert_eq!(
                issues.iter().map(|i| i.code.as_str()).collect::<Vec<_>>(),
                ["format_invalid"]
            );
            let fields = fm(Value::string(text));
            let r = QueryRecord {
                path: "tasks/a.md",
                types: &types,
                frontmatter: &fields,
                body: None,
                mtime: None,
            };
            let plan = query::compile(
                &parse(&format!(
                    "where: 'at == \"{text}\"'\norder_by: [{{field: at}}]"
                )),
                &c,
            )
            .unwrap();
            assert_eq!(plan.matches(&r, &env()), query::Verdict::Match);
            let key = indexed::project_index_fields(
                &c,
                &r,
                &[FieldRef::Effective(vec!["at".into()])],
                128,
            )
            .unwrap();
            assert_eq!(key[0].1.kind(), AtomKind::Text);
        }
    }
}
