//! Stable 0.3.0 matching, discovery and invocation-context regressions.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use mdbn_core::ids::Uuid;
use mdbn_core::intent::OpClock;
use mdbn_core::query::{self, Query, QueryEnv};
use mdbn_core::state::{MemState, Overlay, StateView};
use mdbn_core::types::Catalog;
use mdbn_core::validate::{self, Severity};
use mdbn_core::value::{Map, Value};

fn type_source(expression: &str) -> String {
    format!(
        "---\nkind: mdbase.type\nname: selected\nmatch:\n  expr: {expression:?}\nschema:\n  dialect: json-schema-2020-12\n  value: {{type: object}}\n---\n"
    )
}

fn catalog(expression: &str, timezone: Option<&str>) -> Catalog {
    let config = match timezone {
        Some(zone) => format!("spec_version: '0.3.0'\nsettings:\n  timezone: {zone}\n"),
        None => "spec_version: '0.3.0'\n".into(),
    };
    Catalog::load([
        ("mdbase.yaml", config.as_str()),
        ("_types/selected.md", type_source(expression).as_str()),
    ])
}

#[test]
fn timezone_dependent_matches_require_a_collection_timezone() {
    for expression in [
        "date(timestamp('2026-01-01T01:00:00Z')) == '2025-12-31'",
        "startOfDay('2026-01-01') == timestamp('2026-01-01T08:00:00Z')",
        "[timestamp('2026-01-01T01:00:00Z')].exists(stamp, date(stamp) == '2025-12-31')",
        "date({'stamp': timestamp('2026-01-01T01:00:00Z')}.stamp) == '2025-12-31'",
    ] {
        let invalid = catalog(expression, None);
        assert!(invalid.type_named("selected").is_none(), "{expression}");
        assert!(invalid.issues().iter().any(
            |issue| issue.code == "nondeterministic_match" && issue.severity == Severity::Error
        ));
        for zone in ["UTC", "Asia/Tokyo", "America/Los_Angeles"] {
            let clock = OpClock {
                instant_ms: 0,
                tz: zone.into(),
                local_date: "1970-01-01".into(),
            };
            assert!(
                invalid
                    .membership_at("record.md", &Map::new(), Some(&clock))
                    .types
                    .is_empty()
            );
            let configured = catalog(expression, Some("America/Los_Angeles"));
            assert!(configured.is_valid(), "{:?}", configured.issues());
            assert_eq!(
                configured
                    .membership_at("record.md", &Map::new(), Some(&clock))
                    .types,
                ["selected"]
            );
            assert_eq!(
                configured.membership("record.md", &Map::new()).types,
                ["selected"]
            );
        }
    }
}

#[test]
fn timezone_independent_overloads_and_explicit_zones_remain_valid() {
    for expression in [
        "date('2026-01-01') == '2026-01-01'",
        "date(raw.due) == '2026-01-01'",
        "['2026-01-01'].exists(day, date(day) == day)",
        "date({'stamp': timestamp('2026-01-01T01:00:00Z'), 'day': '2026-01-01'}.day) == '2026-01-01'",
        "date([timestamp('2026-01-01T01:00:00Z'), '2026-01-01'][1]) == '2026-01-01'",
        "date({'stamp': timestamp('2026-01-01T01:00:00Z'), 'day': '2026-01-01'}['day']) == '2026-01-01'",
        "timestamp('2026-01-01T01:00:00Z').getHours() == 1",
        "timestamp('2026-01-01T01:00:00Z').getHours('America/Los_Angeles') == 17",
    ] {
        let loaded = catalog(expression, None);
        assert!(loaded.is_valid(), "{expression}: {:?}", loaded.issues());
        let mut fields = Map::new();
        fields.insert("due", Value::string("2026-01-01"));
        assert_eq!(
            loaded.membership("record.md", &fields).types,
            ["selected"],
            "{expression}"
        );
    }
}

#[test]
fn indexed_file_dependencies_are_rejected_but_macro_shadowing_is_not() {
    for expression in [
        "file['mtime'] != null",
        "file['backlinks'] != null",
        "file[raw.key] != null",
    ] {
        assert!(
            catalog(expression, None).type_named("selected").is_none(),
            "{expression}"
        );
    }
    assert!(catalog("['a'].exists(file, file == 'a')", None).is_valid());
    assert!(catalog("file['path'] == 'record.md'", None).is_valid());
}

#[test]
fn every_discovered_collision_warns_until_resolved() {
    let mut state = MemState::new();
    state.insert_record(Uuid([1; 16]), "Notes/A.md", "---\ntitle: A\n---\n");
    state.insert_record(Uuid([2; 16]), "notes/a.md", "---\ntitle: B\n---\n");
    let overlay = Overlay::new(&state);
    assert!(
        validate::cross_record_issues(&overlay, Uuid([1; 16]))
            .iter()
            .any(|issue| issue.code == "path_collision")
    );
    for record in [Uuid([1; 16]), Uuid([2; 16])] {
        let issues = validate::cross_record_issues(&state, record);
        let collision = issues
            .iter()
            .find(|issue| issue.code == "path_collision")
            .unwrap();
        assert_eq!(collision.severity, Severity::Warning);
        assert_eq!(
            collision.details.as_ref().unwrap().get("paths"),
            Some(&Value::List(vec![
                Value::string("Notes/A.md"),
                Value::string("notes/a.md")
            ]))
        );
    }
    state.insert_record(Uuid([2; 16]), "notes/b.md", "---\ntitle: B\n---\n");
    for record in [Uuid([1; 16]), Uuid([2; 16])] {
        assert!(
            !validate::cross_record_issues(&state, record)
                .iter()
                .any(|issue| issue.code == "path_collision")
        );
    }
}

fn run_query(state: &MemState, source: &str) -> Result<query::QueryPage, query::QueryError> {
    let query = Query::from_value(&mdbn_core::yaml::parse_value(source).unwrap().unwrap()).unwrap();
    let plan = query::compile(&query, &state.catalog()).unwrap();
    query::execute(
        &plan,
        state,
        &QueryEnv {
            now_ms: 0,
            today: "1970-01-01".into(),
            tz: "UTC".into(),
        },
    )
}

#[test]
fn context_links_and_projections_use_the_context_records_origin() {
    let mut state = MemState::new();
    state.insert_record(
        Uuid([1; 16]),
        "projects/alpha#draft|review.md",
        "---\nlead: '[Bob](people/bob.md)'\n---\n",
    );
    state.insert_record(
        Uuid([2; 16]),
        "projects/people/bob.md",
        "---\nname: Bob\n---\n",
    );
    state.insert_record(
        Uuid([3; 16]),
        "tasks/task.md",
        "---\nthis: not-the-context\n---\n",
    );
    let result = run_query(&state, "context: {this: {path: 'projects/alpha#draft|review.md'}}\nprojections:\n  lead: {expr: 'this.lead.asFile().name'}\nwhere: 'file.inFolder(\"tasks\") && projection.lead == \"Bob\"'\nselect: [projection.lead]\n").unwrap();
    assert_eq!(result.ids, [Uuid([3; 16])]);
    assert!(result.diagnostics.is_empty());
    let result = run_query(&state, "where: 'this == null'\n").unwrap();
    assert_eq!(result.ids.len(), 3);
    let empty = MemState::new();
    let error = run_query(&empty, "context: {this: {path: missing.md}}\n").unwrap_err();
    assert_eq!(error.code, "context_not_found");
}
