//! Real Replica query producer; trusted fixture host/sealer, not crypto admission.
use super::engine::{node, settle};
use crate::api::{ClientApi, ErrorCode, Push};
use crate::fake::FakeLogService;
use crate::mem::MemStore;
use crate::store::{RecordMeta, RecordRow};
use crate::{Store, Tx};
use mdbn_wire::client::{Include, UpdateKind};
use mdbn_wire::common::{B16, Value};

const TASK: &str = "---\nkind: mdbase.type\nname: task\nmatch: {path_glob: 'tasks/*.md'}\nschema:\n  dialect: json-schema-2020-12\n  value: {type: object}\ncollection:\n  links:\n    assignees[]: {validate_exists: false}\n---\n";
fn include() -> Include {
    Include {
        effective: None,
        body: None,
        document: None,
        diagnostics: None,
    }
}
fn query(path: &str, selected: bool) -> Value {
    let mut fields = vec![
        (
            "types".into(),
            Value::List(vec![Value::Text("task".into())]),
        ),
        (
            "where".into(),
            Value::Text(format!(
                "\"assignees\" in record && record[\"assignees\"] != null && record[\"assignees\"].exists(link, link != null && link.asFile() != null && link.asFile().file.path == \"{path}\")"
            )),
        ),
    ];
    if selected {
        fields.push((
            "select".into(),
            Value::List(vec![Value::Text("file.path".into())]),
        ));
    }
    Value::Map(fields)
}

#[test]
fn where_only_assignee_links_match_selected_queries_and_retained_records() {
    for (path, link) in [
        ("people/Alice.md", "[[Alice]]"),
        ("[test] Person.md", "[[[test] Person]]"),
    ] {
        let svc = FakeLogService::new();
        let mut store = MemStore::new();
        store
            .commit(Tx {
                resources_put: vec![("_types/task.md".into(), TASK.into())],
                ..Tx::default()
            })
            .unwrap();
        let mut a = node(&svc, 1, store);
        settle(&mut [&mut a]);
        a.create(20, path, "---\nname: Person\n---\n");
        a.create(21, "other/Bob.md", "---\nname: Bob\n---\n");
        a.create(
            22,
            "tasks/assigned.md",
            &format!("---\nassignees: ['{link}']\n---\n"),
        );
        a.create(
            23,
            "tasks/other.md",
            "---\nassignees: ['[[other/Bob]]']\n---\n",
        );
        a.create(24, "tasks/unassigned.md", "---\nassignees: []\n---\n");
        a.create(25, "tasks/missing.md", "---\ntitle: No assignment\n---\n");
        a.create(26, "tasks/null.md", "---\nassignees: null\n---\n");
        settle(&mut [&mut a]);
        // Projections already supplied the link host, explaining the working
        // assignee label even while a where-only Assigned-to-me returned zero.
        let selected = a.r.query(a.s, query(path, true), include()).unwrap();
        assert_eq!(
            selected.records.iter().map(|r| r.id).collect::<Vec<_>>(),
            [B16([22; 16])]
        );
        let plain = a.r.query(a.s, query(path, false), include()).unwrap();
        assert_eq!(
            plain.records.iter().map(|r| r.id).collect::<Vec<_>>(),
            [B16([22; 16])],
            "{link}"
        );
        assert_eq!(plain.records[0].path, "tasks/assigned.md");
        assert!(plain.complete);
        assert!(plain.diagnostics.as_ref().is_none_or(Vec::is_empty));
        let sub = a.r.subscribe(a.s, query(path, false), include()).unwrap();
        assert!(a.r.take_pushes().iter().any(|(_, push)| matches!(push,
            Push::QueryUpdate(update) if update.sub == sub && update.kind == UpdateKind::Snapshot
                && update.added.as_ref().is_some_and(|rows| rows.len() == 1 && rows[0].id == B16([22; 16]))
        )));
        let mut reopened = node(&svc, 1, a.r.into_store());
        settle(&mut [&mut reopened]);
        let retained = reopened
            .r
            .query(reopened.s, query(path, false), include())
            .unwrap();
        assert_eq!(
            retained.records.iter().map(|r| r.id).collect::<Vec<_>>(),
            [B16([22; 16])]
        );
    }
}

#[test]
fn where_only_link_reads_keep_the_existing_bounded_source_refusal() {
    let svc = FakeLogService::new();
    let mut store = MemStore::new();
    let doc = "---\ntitle: Unassigned\n---\n";
    let records = (1_u128..=1001)
        .map(|n| {
            let path = format!("tasks/{n}.md");
            RecordRow {
                id: B16(n.to_be_bytes()),
                path_key: mdbn_core::paths::path_key(&path),
                path,
                doc: doc.into(),
                revision: mdbn_wire::hash::sha256(doc.as_bytes()),
                modified_seq: 0,
                bucket: 0,
                meta: RecordMeta::default(),
            }
        })
        .collect();
    store
        .commit(Tx {
            resources_put: vec![("_types/task.md".into(), TASK.into())],
            records_put: records,
            ..Tx::default()
        })
        .unwrap();
    let mut a = node(&svc, 1, store);
    settle(&mut [&mut a]);
    let error =
        a.r.query(a.s, query("people/Alice.md", false), include())
            .unwrap_err();
    assert_eq!(error.code(), Some(ErrorCode::TooLarge));
    assert_eq!(
        error.problem().reason.as_deref(),
        Some("query_budget_exceeded")
    );
}
