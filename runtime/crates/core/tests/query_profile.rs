//! Membership/order index profile parity, not authorization or executor acceptance.
use mdbn_core::query::indexed::{self, SortAtom, TemporalHint};
use mdbn_core::query::profile::{self, Column, Compare, Predicate, Unsupported};
use mdbn_core::query::{self, Query, QueryEnv, QueryRecord, Verdict};
use mdbn_core::types::Catalog;
use mdbn_core::value::{Map, Value};
use std::cmp::Ordering;
const TASK: &str = "---\nkind: mdbase.type\nname: task\nschema:\n  dialect: json-schema-2020-12\n  value:\n    type: object\n    properties:\n      at: {type: string, format: date-time}\ncollection:\n  read_defaults: {priority: 4}\n---\n";
fn catalog() -> Catalog {
    let c = Catalog::load([("_types/task.md", TASK)]);
    assert!(c.is_valid());
    c
}
fn query(y: &str) -> Query {
    Query::from_value(&mdbn_core::yaml::parse_value(y).unwrap().unwrap()).unwrap()
}
fn plan(expr: &str, c: &Catalog) -> query::QueryPlan {
    query::compile(
        &Query {
            where_: Some(expr.into()),
            ..Query::default()
        },
        c,
    )
    .unwrap()
}
fn env() -> QueryEnv {
    QueryEnv {
        now_ms: 0,
        today: "1970-01-01".into(),
        tz: "UTC".into(),
    }
}
fn atom(c: &Catalog, r: &QueryRecord<'_>, col: &Column) -> SortAtom {
    match col {
        Column::Path => {
            SortAtom::from_value(Some(&Value::string(r.path)), TemporalHint::None, 1024).unwrap()
        }
        Column::Field(f) => {
            indexed::project_index_fields(c, r, &[query::FieldRef::Effective(f.path.clone())], 1024)
                .unwrap()
                .remove(0)
                .1
        }
    }
}
fn holds(p: &Predicate, c: &Catalog, r: &QueryRecord<'_>) -> bool {
    match p {
        Predicate::All => true,
        Predicate::None => false,
        Predicate::And(a) => a.iter().all(|p| holds(p, c, r)),
        Predicate::Or(a) => a.iter().any(|p| holds(p, c, r)),
        Predicate::Not(p) => !holds(p, c, r),
        Predicate::Compare { column, op, value } => {
            let a = atom(c, r, column);
            if a.kind() != value.kind() {
                return false;
            }
            let ord = a.key().cmp(value.key());
            match op {
                Compare::Eq => ord == Ordering::Equal,
                Compare::Lt => ord == Ordering::Less,
                Compare::Le => ord != Ordering::Greater,
                Compare::Gt => ord == Ordering::Greater,
                Compare::Ge => ord != Ordering::Less,
            }
        }
    }
}
#[test]
fn priority_numeric_kind_gate_matches_real_cel_for_all_value_kinds_and_defaults() {
    let c = catalog();
    let names = vec!["task".into()];
    for expr in [
        "priority >= 4",
        "4 <= record.priority",
        "record['priority'] > -4",
        "priority == 4",
        "priority == null",
    ] {
        let plan = plan(expr, &c);
        let profile = profile::lower(&plan, &c).unwrap();
        for value in [
            None,
            Some(Value::Null),
            Some(Value::Bool(true)),
            Some(Value::Int(3)),
            Some(Value::Int(4)),
            Some(Value::Int(9_007_199_254_740_993)),
            Value::float(4.0),
            Some(Value::string("4")),
            Some(Value::List(vec![])),
            Some(Value::Map(Map::new())),
        ] {
            let mut fm = Map::new();
            if let Some(v) = value {
                fm.insert("priority", v);
            }
            let r = QueryRecord {
                path: "a.md",
                types: &names,
                frontmatter: &fm,
                body: None,
            };
            assert_eq!(
                holds(&profile.predicate, &c, &r),
                plan.matches(&r, &env()) == Verdict::Match,
                "{expr} {fm:?}"
            );
        }
        assert_eq!(profile.diagnostics_exact, expr.contains("=="));
    }
}
#[test]
fn exact_large_numbers_do_not_round_to_adjacent_integer() {
    let c = catalog();
    let p = plan("priority == 9007199254740993", &c);
    let q = profile::lower(&p, &c).unwrap();
    for (n, want) in [
        (9_007_199_254_740_992, false),
        (9_007_199_254_740_993, true),
        (9_007_199_254_740_994, false),
    ] {
        let fm = [("priority".into(), Value::Int(n))].into_iter().collect();
        let r = QueryRecord {
            path: "a.md",
            types: &[],
            frontmatter: &fm,
            body: None,
        };
        assert_eq!(holds(&q.predicate, &c, &r), want);
    }
    assert_eq!(
        profile::lower(&plan("priority == 18446744073709551615u", &c), &c),
        Err(Unsupported::Expression)
    );
}
#[test]
fn temporal_fields_and_plain_text_ranges_use_kind_gates_not_shape_inference() {
    let c = catalog();
    let names = ["task".into()];
    for expr in [
        "at == '2026-01-01T00:00:00Z'",
        "at >= '2026-01-01T00:00:00Z'",
    ] {
        let p = plan(expr, &c);
        let q = profile::lower(&p, &c).unwrap();
        for types in [&names[..], &[][..]] {
            for s in ["2026-01-01T00:00:00Z", "zzz", "invalid-date"] {
                let fm = [("at".into(), Value::string(s))].into_iter().collect();
                let r = QueryRecord {
                    path: "a.md",
                    types,
                    frontmatter: &fm,
                    body: None,
                };
                assert_eq!(
                    holds(&q.predicate, &c, &r),
                    p.matches(&r, &env()) == Verdict::Match,
                    "{expr} {types:?} {s}"
                );
            }
        }
    }
}
#[test]
fn date_sort_atoms_are_not_cel_timestamp_values() {
    let date_type = TASK.replace("format: date-time", "format: date");
    let c = Catalog::load([("_types/task.md", date_type.as_str())]);
    let p = plan("at == '2026-01-01'", &c);
    let fm = [("at".into(), Value::string("2026-01-01"))]
        .into_iter()
        .collect();
    let names = vec!["task".into()];
    let r = QueryRecord {
        path: "a.md",
        types: &names,
        frontmatter: &fm,
        body: None,
    };
    assert_eq!(p.matches(&r, &env()), Verdict::Match);
    assert_eq!(profile::lower(&p, &c), Err(Unsupported::Field));
}
#[test]
fn decisive_boolean_branches_suppress_errors_like_core_cel() {
    let c = catalog();
    let p = plan("priority >= 4 || status == 'open'", &c);
    let fm = [
        ("priority".into(), Value::string("bad")),
        ("status".into(), Value::string("open")),
    ]
    .into_iter()
    .collect();
    let r = QueryRecord {
        path: "a.md",
        types: &[],
        frontmatter: &fm,
        body: None,
    };
    // Canonical CEL eval::logic allows decisive RHS true to suppress LHS error.
    assert_eq!(p.matches(&r, &env()), Verdict::Match);
    let q = profile::lower(&p, &c).unwrap();
    assert!(!q.diagnostics_exact);
    assert!(holds(&q.predicate, &c, &r));
    let error = plan("priority >= 4 || status == 'closed'", &c);
    assert!(matches!(error.matches(&r, &env()), Verdict::Error(_)));
    assert!(!holds(
        &profile::lower(&error, &c).unwrap().predicate,
        &c,
        &r
    ));
    let p = plan("priority == 4 || status == 'open'", &c);
    let q = profile::lower(&p, &c).unwrap();
    assert!(q.diagnostics_exact);
    assert!(holds(&q.predicate, &c, &r));
    let p = plan("priority >= 4 && status == 'open'", &c);
    let q = profile::lower(&p, &c).unwrap();
    assert!(!q.diagnostics_exact);
    assert!(!holds(&q.predicate, &c, &r));
}
#[test]
fn nested_monotone_boolean_membership_and_path_scalars_match_cel() {
    let c = catalog();
    for expr in [
        "(priority >= 4 || status == 'open') && (priority < 10 || status == null)",
        "priority >= 4 || (priority < 3 && status == 'open')",
        "file.path >= 'a.md'",
        "file.path == null",
        "file.path == 4",
        "file.path >= 4",
        "true || priority >= 4",
        "false && priority >= 4",
    ] {
        let p = plan(expr, &c);
        let q = profile::lower(&p, &c).unwrap();
        for priority in [
            Value::Null,
            Value::Bool(false),
            Value::Int(2),
            Value::Int(4),
            Value::Int(11),
            Value::string("bad"),
        ] {
            for status in [Value::Null, Value::string("open"), Value::string("closed")] {
                let fm = [
                    ("priority".into(), priority.clone()),
                    ("status".into(), status),
                ]
                .into_iter()
                .collect();
                let r = QueryRecord {
                    path: "a.md",
                    types: &[],
                    frontmatter: &fm,
                    body: None,
                };
                assert_eq!(
                    holds(&q.predicate, &c, &r),
                    p.matches(&r, &env()) == Verdict::Match,
                    "{expr} {fm:?}"
                );
            }
        }
    }
}
#[test]
fn unsupported_expressions_are_never_partial_exact_profiles() {
    let c = catalog();
    // `!=` and `in [literals]` are now lowered (proved against CEL in
    // negation_and_in_lists_match_real_cel_for_every_value_kind).
    for expr in [
        "priority >= 4 && file.body.contains('x')",
        "raw.priority == 4",
        "meta.owner == 'x'",
        "projection.x == 1",
        "types == null",
        "priority in [4, file.body]",
        "has(record.priority)",
        "at < timestamp('2026-01-01T00:00:00Z')",
        "priority < true",
    ] {
        let p = plan(expr, &c);
        assert!(profile::lower(&p, &c).is_err(), "{expr}");
    }
}
#[test]
fn order_is_physical_and_preserves_desc_with_explicit_path() {
    let c = catalog();
    let q = query(
        "where: 'priority >= 4'\norder_by: [{field: priority, direction: desc}, {field: file.path}]\n",
    );
    let p = query::compile(&q, &c).unwrap();
    let q = profile::lower(&p, &c).unwrap();
    assert_eq!(q.order.len(), 2);
    assert_eq!(q.order[0].direction, query::Direction::Desc);
    assert_eq!(q.order[1].column, Column::Path);
    for yaml in [
        "order_by: [{field: raw.priority}]",
        "order_by: [{field: meta.owner}]",
        "select: [{name: priority, expr: 'priority + 1'}]\norder_by: [{field: priority}]",
    ] {
        assert_eq!(
            profile::lower(&query::compile(&query(yaml), &c).unwrap(), &c),
            Err(Unsupported::Order)
        );
    }
}
#[test]
fn structural_bracket_keys_are_not_split_or_confused_with_nested_paths() {
    let c = catalog();
    let p = plan("record['a.b'] == 4", &c);
    let q = profile::lower(&p, &c).unwrap();
    let Predicate::Compare {
        column: Column::Field(f),
        ..
    } = q.predicate
    else {
        panic!()
    };
    assert_eq!(f.path, ["a.b"]);
    assert!(profile::lower(&plan("record.a.b == 4", &c), &c).is_err());
}
#[test]
fn explicit_missing_record_keys_require_presence_proof_for_null_and_residual_diagnostics() {
    let c = catalog();
    let missing = Map::new();
    let present = [("absent".into(), Value::Null)].into_iter().collect();
    for expr in [
        "record.absent == null",
        "record['absent'] == null",
        "null == record.absent",
    ] {
        let p = plan(expr, &c);
        let absent = QueryRecord {
            path: "a.md",
            types: &[],
            frontmatter: &missing,
            body: None,
        };
        let null = QueryRecord {
            frontmatter: &present,
            ..absent.clone()
        };
        assert!(matches!(p.matches(&absent, &env()), Verdict::Error(_)));
        assert_eq!(p.matches(&null, &env()), Verdict::Match);
        // Projected Null alone cannot distinguish these; conservatively refuse.
        assert_eq!(profile::lower(&p, &c), Err(Unsupported::Field));
    }
    let p = plan("absent == null", &c);
    let q = profile::lower(&p, &c).unwrap();
    assert!(q.diagnostics_exact);
    for fm in [&missing, &present] {
        let r = QueryRecord {
            path: "a.md",
            types: &[],
            frontmatter: fm,
            body: None,
        };
        assert_eq!(p.matches(&r, &env()), Verdict::Match);
        assert!(holds(&q.predicate, &c, &r));
    }
    for expr in [
        "record.absent == 4",
        "4 == record['absent']",
        "record.absent == false",
        "record.absent == 'x'",
        "record.absent == 4 || true",
    ] {
        let p = plan(expr, &c);
        let q = profile::lower(&p, &c).unwrap();
        assert!(!q.diagnostics_exact);
        for fm in [&missing, &present] {
            let r = QueryRecord {
                path: "a.md",
                types: &[],
                frontmatter: fm,
                body: None,
            };
            assert_eq!(
                holds(&q.predicate, &c, &r),
                p.matches(&r, &env()) == Verdict::Match,
                "{expr}"
            );
        }
    }
}
#[test]
fn type_filter_maps_mixed_case_requests_to_exact_canonical_stored_names() {
    let source = TASK.replace("name: task", "name: TASK");
    let c = Catalog::load([("_types/task.md", source.as_str())]);
    assert!(c.is_valid());
    let fm = Map::new();
    let names = ["TASK".into()];
    let r = QueryRecord {
        path: "a.md",
        types: &names,
        frontmatter: &fm,
        body: None,
    };
    for requested in ["TASK", "task", "TaSk"] {
        let q = Query {
            types: vec![requested.into()],
            ..Query::default()
        };
        let p = query::compile(&q, &c).unwrap();
        let lowered = profile::lower(&p, &c).unwrap();
        assert_eq!(p.matches(&r, &env()), Verdict::Match);
        assert_eq!(lowered.types, ["TASK"]);
        assert!(r.types.iter().any(|t| lowered.types.contains(t)));
    }
    let q = Query {
        types: vec!["unknown".into()],
        ..Query::default()
    };
    let p = query::compile(&q, &c).unwrap();
    let lowered = profile::lower(&p, &c).unwrap();
    assert_eq!(p.matches(&r, &env()), Verdict::NoMatch);
    assert!(lowered.types.is_empty());
    assert_eq!(lowered.predicate, Predicate::None);
    let q = Query {
        types: vec![],
        ..Query::default()
    };
    let p = query::compile(&q, &c).unwrap();
    assert_eq!(profile::lower(&p, &c).unwrap().predicate, Predicate::All);
}
#[test]
fn type_filter_unicode_fold_and_complexity_are_explicitly_unavailable() {
    let c = catalog();
    let mut q = query("types: [task]");
    let p = query::compile(&q, &c).unwrap();
    assert_eq!(profile::lower(&p, &c).unwrap().types, ["task"]);
    q.types = vec!["K".into()];
    assert_eq!(
        profile::lower(&query::compile(&q, &c).unwrap(), &c),
        Err(Unsupported::Types)
    );
    let c = Catalog::load([
        ("_types/task.md", TASK),
        (
            "_types/k.md",
            "---\nkind: mdbase.type\nname: K\nschema:\n  dialect: json-schema-2020-12\n  value: {type: object}\n---\n",
        ),
    ]);
    assert_eq!(c.types().len(), 2);
    q.types = vec!["k".into()];
    assert_eq!(
        profile::lower(&query::compile(&q, &c).unwrap(), &c),
        Err(Unsupported::Types)
    );
    let c = catalog();
    let expression = std::iter::repeat_n("priority == 4", 40)
        .collect::<Vec<_>>()
        .join(" && ");
    assert_eq!(
        profile::lower(&plan(&expression, &c), &c),
        Err(Unsupported::Budget)
    );
}

/// Negation, `!=` and `in` match real CEL for every value kind, missing and
/// present-null included (the TaskNotes `status != "done"` shape).
#[test]
fn negation_and_in_lists_match_real_cel_for_every_value_kind() {
    let c = catalog();
    let names = vec!["task".into()];
    for expr in [
        "status != \"done\"",
        "\"done\" != status",
        "!(status == \"done\")",
        "status in [\"open\", \"waiting\"]",
        "!(status in [\"done\", \"cancelled\"])",
        "status != \"done\" && priority == 4",
        "!(status == \"done\" || priority == 4)",
        "status != null",
        "archived != true",
        "!(status != \"done\")",
        "priority != 4",
    ] {
        let plan = plan(expr, &c);
        let profile = profile::lower(&plan, &c).unwrap_or_else(|e| panic!("{expr}: {e:?}"));
        assert!(profile.diagnostics_exact, "{expr}");
        for value in [
            None,
            Some(Value::Null),
            Some(Value::Bool(true)),
            Some(Value::Bool(false)),
            Some(Value::Int(4)),
            Value::float(4.0),
            Some(Value::string("done")),
            Some(Value::string("open")),
            Some(Value::string("waiting")),
            Some(Value::string("4")),
            Some(Value::List(vec![Value::string("done")])),
            Some(Value::Map(Map::new())),
        ] {
            for field in ["status", "archived"] {
                let mut fm = Map::new();
                if let Some(v) = value.clone() {
                    fm.insert(field, v);
                }
                let r = QueryRecord {
                    path: "a.md",
                    types: &names,
                    frontmatter: &fm,
                    body: None,
                };
                assert_eq!(
                    holds(&profile.predicate, &c, &r),
                    plan.matches(&r, &env()) == Verdict::Match,
                    "{expr} {fm:?}"
                );
            }
        }
    }
}

/// A complement over anything that can raise a CEL error is refused: errors are
/// neither true nor false.
#[test]
fn negation_over_erroring_subtrees_is_refused() {
    let c = catalog();
    for expr in [
        "record.status != \"done\"",
        "!(priority > 3)",
        "!(record['status'] == \"done\")",
        "status != at",
        "status in other",
    ] {
        assert!(
            profile::lower(&plan(expr, &c), &c).is_err(),
            "{expr} must not lower"
        );
    }
}
