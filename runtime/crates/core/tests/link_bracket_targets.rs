//! Stored assignee links must use the same bracket-name semantics in resolution and filtering.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use mdbn_core::ids::Uuid;
use mdbn_core::links::{self, Resolution};
use mdbn_core::query::{self, Query, QueryEnv};
use mdbn_core::state::{MemState, StateView};
use mdbn_core::value::Value;

fn id(n: u8) -> Uuid {
    let mut bytes = [0; 16];
    bytes[15] = n;
    Uuid(bytes)
}

fn query(yaml: &str, state: &MemState) -> query::QueryPage {
    let q = Query::from_value(&mdbn_core::yaml::parse_value(yaml).unwrap().unwrap()).unwrap();
    let plan = query::compile(&q, &state.catalog()).unwrap();
    query::execute(
        &plan,
        state,
        &QueryEnv {
            now_ms: 0,
            today: "1970-01-01".into(),
            tz: "UTC".into(),
        },
    )
    .unwrap()
}

#[test]
fn assignee_wikilinks_with_bracket_names_resolve_from_task_folders_and_filter_assignments() {
    for (path, reference) in [
        ("Alice.md", "[[Alice]]"),
        (
            "[test] Next query Person.md",
            "[[[test] Next query Person]]",
        ),
        ("people/[test] Alice.md", "[[people/[test] Alice]]"),
        ("Person [test].md", "[[Person [test]]]"),
        ("[test].md", "[[[test]]]"),
        (
            "people/[test] Alice.md",
            "[[people/[test] Alice#bio|[team] Alice]]",
        ),
    ] {
        let mut state = MemState::new();
        state.insert_resource("_types/task.md", "---\nkind: mdbase.type\nname: task\nmatch:\n  path_glob: 'tasks/*.md'\nschema:\n  dialect: json-schema-2020-12\n  value: {type: object}\ncollection:\n  links:\n    assignees[]:\n      validate_exists: false\n---\n");
        assert!(state.catalog().is_valid());
        state.insert_record(id(1), path, "---\nname: Person\n---\n");
        state.insert_record(
            id(2),
            "tasks/assigned.md",
            &format!("---\nassignees: ['{reference}', '[[Missing person]]']\n---\n"),
        );
        let link = links::parse_value(reference, false).unwrap();
        assert_eq!(
            links::resolve(&link, "tasks/assigned.md", &state),
            Resolution::Record(id(1)),
            "{reference}"
        );
        let resolved = query(
            "types: [task]\nprojections:\n  targets:\n    expr: 'record.assignees.map(a, a.asFile() == null ? null : a.asFile().file.path)'\nselect: [projection.targets]\n",
            &state,
        );
        assert_eq!(resolved.ids, [id(2)]);
        assert_eq!(
            resolved.values[0].get("targets"),
            Some(&Value::List(vec![Value::string(path), Value::Null])),
            "{reference}"
        );
        let assigned = query(
            &format!(
                "types: [task]\nwhere: 'record.assignees.exists(a, a.asFile() != null && a.asFile().file.path == \"{path}\")'\n"
            ),
            &state,
        );
        assert_eq!(assigned.ids, [id(2)], "{reference}");
        // Match TaskNotes' actual linksTo() predicate, including dynamic field
        // access and the missing/null guards, not just a dotted projection.
        let guarded = query(
            &format!(
                "types: [task]\nwhere: '\"assignees\" in record && record[\"assignees\"] != null && record[\"assignees\"].exists(link, link != null && link.asFile() != null && link.asFile().file.path == \"{path}\")'\n"
            ),
            &state,
        );
        assert_eq!(guarded.ids, [id(2)], "guarded predicate: {reference}");
        assert_eq!(links::links_to(&state, id(1)).len(), 1, "{reference}");
    }
}

#[test]
fn bracket_targets_preserve_body_spans_aliases_and_delimiter_refusals() {
    let body = "See [[[test] Person#bio|[team] Alice]] and [[Person [draft]]].";
    let links = links::parse_body(body);
    assert_eq!(
        links
            .iter()
            .map(|link| link.target.as_str())
            .collect::<Vec<_>>(),
        ["[test] Person", "Person [draft]"]
    );
    assert_eq!(links[0].alias.as_deref(), Some("[team] Alice"));
    assert_eq!(links[0].anchor.as_deref(), Some("bio"));
    for link in links {
        let (start, end) = link.span.unwrap();
        assert_eq!(&body[start as usize..end as usize], link.raw);
    }
    for invalid in [
        "[[nested[[link]]]]",
        "[[unfinished]",
        "[[line\nbreak]]",
        "[[line\rbreak]]",
        "[[]]",
        "[[valid]] trailing",
    ] {
        assert!(links::parse_value(invalid, false).is_none(), "{invalid}");
    }
}
