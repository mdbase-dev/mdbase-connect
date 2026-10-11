//! Exact bundled TaskNotes publisher pack over actual app SQL + signed sync.
//! Disposable SQLite reopen is a logical-restoration test, not physical durability,
//! current LAB collection policy, Scratchpad, WASM, or protected custody proof.
use super::*;
use r::api::Target;
use w::client::{Confirmation, Include, ReceiptState, WaitFor};

const PACK: [(&str, &str, &str, &str); 4] = [
    (
        "contracts/tasknotes.task/0.3.0-rc.5.md",
        "_contracts/tasknotes.task.md",
        include_str!("task_policy/task-contract.md"),
        "ecadd00700e249940f4244aaa5b5985a96557d13340463ec491dfa5e89b032a4",
    ),
    (
        "types/tasknotes-task/5.md",
        "_types/task.md",
        include_str!("task_policy/task.md"),
        "b3cf8dbe8885b331c494d2eeb36abfb052890e06b757877d655c269e666487dc",
    ),
    (
        "schemas/tasknotes.task/0.3.0-rc.5.schema.json",
        "_schemas/tasknotes/tasknotes-task.schema.json",
        include_str!("task_policy/task.schema.json"),
        "aec95578a093be95cbce0fb500964e7aeaeeacc611624fc2893074637dbd4125",
    ),
    (
        "schemas/tasknotes.task.binding/0.3.0-rc.5.schema.json",
        "_schemas/tasknotes/tasknotes-task-binding.schema.json",
        include_str!("task_policy/task-binding.schema.json"),
        "5b38e8a1c426b7f7fa92d8353fe35dd98e632305cbb15ffccde387473166b267",
    ),
];

fn include() -> Include {
    Include {
        effective: Some(true),
        body: Some(true),
        document: Some(true),
        diagnostics: None,
    }
}
fn configure_task_pack(app: &mut App, session: SessionId, service: &FakeLogService) {
    let mut ops = vec![Op::ResourcePut(ResourcePut {
        path: "mdbase.yaml".into(),
        doc: "spec_version: '0.3.0'\nsettings:\n  record_extensions: [md]\n".into(),
        base_revision: None,
        must_not_exist: Some(true),
    })];
    for (_, _, document, digest) in PACK {
        assert_eq!(w::hash::sha256(document.as_bytes()).to_hex(), digest);
    }
    let manifest = include_str!("task_policy/pack-manifest.json");
    assert_eq!(
        w::hash::sha256(manifest.as_bytes()).to_hex(),
        "6442d93108f28800a3354e49268b3793fd9fa825e5f596e0b7316e9283bf4eeb"
    );
    let pack = mdbn_core::packs::load_pack(manifest, &|source| {
        PACK.iter()
            .find(|entry| entry.0 == source)
            .map(|entry| entry.2.to_owned())
    })
    .unwrap();
    // Use Core's ordinary guarded pack assessment/application, including the
    // genuine pack lock that classifies its declared schema resources. Hand-made
    // resource_puts without that lock are not a faithful native pack install.
    let state = mdbn_core::state::MemState::new();
    let options = mdbn_core::packs::AssessOptions {
        installed_by: "dev.tasknotes.app".into(),
        ..Default::default()
    };
    let assessment = mdbn_core::packs::assess_type_pack(&state, &pack, &options).unwrap();
    let (_, plan) =
        mdbn_core::packs::apply_type_pack(&state, &pack, &options, &assessment.assessment_digest)
            .unwrap();
    for op in plan {
        let mdbn_core::intent::Op::ResourcePut(op) = op else {
            panic!("fresh canonical pack unexpectedly required a non-put operation");
        };
        ops.push(Op::ResourcePut(ResourcePut {
            path: op.path,
            doc: w::common::Text::Inline(op.doc),
            base_revision: op.base_revision.map(|digest| B32(digest.0)),
            must_not_exist: Some(op.must_not_exist),
        }));
    }
    submit(app, session, ops, 81);
    settle(app, service);
    let receipt = app.receipt(session, B16([81; 16])).unwrap();
    assert_eq!(
        receipt.state,
        ReceiptState::Confirmed,
        "resource pack did not apply: {receipt:?}"
    );
    assert_eq!(
        receipt.status,
        Some(w::entry::Status::Applied),
        "resource pack did not apply: {receipt:?}"
    );
}
fn logical_id(record: &w::client::RecordView) -> &str {
    match record.frontmatter.get("id").unwrap() {
        w::common::Value::Text(value) => value,
        other => panic!("native Task lifecycle ID is not text: {other:?}"),
    }
}

#[test]
fn bundled_task_policy_local_identity_path_children_restore_and_confirm() {
    let path = scratch("bundled-task-policy").join("app.db");
    let service = log();
    let (mut app, session, index) = open(&path, Rc::new(Probe::default()));
    settle(&mut app, &service);
    configure_task_pack(&mut app, session, &service);
    let catalog = app.describe(session).unwrap();
    assert!(
        catalog.types.iter().any(|kind| kind.name == "task"),
        "bundled task catalog not admitted: {catalog:?}"
    );
    let head = app.store().head().unwrap();
    let parent_id = B16([83; 16]);
    let child_ids = [B16([84; 16]), B16([85; 16])];
    let planned_ids = [
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
        "33333333-3333-4333-8333-333333333333",
    ];
    let parent_path = "tasks/parent.md";
    // The rc15 model's ordinary materialization uses a wikilink to the parent
    // PATH, not its pre-lifecycle logical ID. Representative child fields here
    // are not claimed to be an execution of the application's rolling helper.
    let parent_reference = "[[tasks/parent]]";
    let parent = format!(
        "---\nid: {}\ntitle: Parent\ntags: [task]\nstatus: open\ndateCreated: '2026-10-10T00:00:00Z'\ndateModified: '2026-10-10T00:00:00Z'\nrecurrence: FREQ=DAILY\noccurrence_materialization: rolling\n---\nParent body\n",
        planned_ids[0]
    );
    let children = ["2026-10-10", "2026-10-11"].map(|date| {
        format!(
            "---\nid: {}\ntitle: Occurrence {date}\ntags: [task]\nstatus: open\ndateCreated: '2026-10-10T00:00:00Z'\ndateModified: '2026-10-10T00:00:00Z'\nrecurrence_parent: '{parent_reference}'\noccurrence_date: '{date}'\n---\nOccurrence body\n",
            if date == "2026-10-10" { planned_ids[1] } else { planned_ids[2] }
        )
    });
    let receipt = app
        .submit(
            session,
            SubmitParams {
                ops: vec![
                    create(parent_id, parent_path, &parent),
                    create(child_ids[0], "tasks/child-1.md", &children[0]),
                    create(child_ids[1], "tasks/child-2.md", &children[1]),
                ],
                mutation_id: Some(B16([82; 16])),
                conflict_mode: None,
                timezone: None,
                allow_partial: None,
                mutation_ids: None,
                dry_run: None,
                include: Some(include()),
                wait: Some(WaitFor::Pending),
            },
        )
        .unwrap()
        .remove(0);
    assert_eq!(receipt.state, ReceiptState::Pending);
    let local = receipt.records.as_ref().unwrap();
    assert_eq!(local.len(), 3);
    let native_ids = [parent_id, child_ids[0], child_ids[1]];
    let paths = [parent_path, "tasks/child-1.md", "tasks/child-2.md"];
    for ((id, path), planned) in native_ids.into_iter().zip(paths).zip(planned_ids) {
        let record = local.iter().find(|record| record.id == id).unwrap();
        assert_eq!(record.path, path, "native target path is preserved");
        assert!(record.types.iter().any(|name| name == "task"));
        assert_eq!(record.state.state, Confirmation::Pending);
        assert_ne!(
            logical_id(record),
            planned,
            "exact bundled UUID lifecycle owns logical ID"
        );
        assert_eq!(
            record.revision,
            w::hash::sha256(record.document.as_ref().unwrap().as_bytes())
        );
        assert_eq!(
            app.get(session, Target::Id(id), include()).unwrap(),
            *record
        );
    }
    let identities = local
        .iter()
        .map(|record| logical_id(record).to_owned())
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(identities.len(), 3);
    for id in child_ids {
        let child = local.iter().find(|record| record.id == id).unwrap();
        assert_eq!(
            child.frontmatter.get("recurrence_parent"),
            Some(&w::common::Value::Text(parent_reference.into()))
        );
    }
    assert_eq!(app.store().head().unwrap(), head, "no authority ACK yet");
    assert_eq!(app.store().pending_count().unwrap(), 1);
    let expected = local.clone();
    // Reopen the exact same isolated SQLite file without log pumping, replacement
    // records, mutation submissions, device changes or fixture reset.
    drop(app);
    drop(index);
    let (mut app, session, _) = open(&path, Rc::new(Probe::default()));
    assert_eq!(app.store().head().unwrap(), head);
    assert_eq!(app.store().pending_count().unwrap(), 1);
    assert_eq!(
        app.receipt(session, B16([82; 16])).unwrap().state,
        ReceiptState::Pending
    );
    for record in &expected {
        assert_eq!(
            app.get(session, Target::Id(record.id), include()).unwrap(),
            *record
        );
    }
    settle(&mut app, &service);
    assert_eq!(
        app.receipt(session, B16([82; 16])).unwrap().state,
        ReceiptState::Confirmed
    );
    for record in &expected {
        let confirmed = app.get(session, Target::Id(record.id), include()).unwrap();
        assert_eq!(confirmed.id, record.id);
        assert_eq!(confirmed.path, record.path);
        assert_eq!(logical_id(&confirmed), logical_id(record));
        assert_eq!(confirmed.document, record.document);
        assert_eq!(confirmed.revision, record.revision);
        assert_eq!(
            confirmed.frontmatter.get("recurrence_parent"),
            record.frontmatter.get("recurrence_parent")
        );
        assert_eq!(confirmed.state.state, Confirmation::Confirmed);
    }
}
