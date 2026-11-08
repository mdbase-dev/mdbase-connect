//! A path-field update is a move; another device's concurrent content edit follows its ID.
use super::*;
use crate::Store;
use mdbn_wire::{
    common::{DataMap, Value},
    intent::{ResourcePut, Update},
};

fn empty_update() -> Update {
    Update {
        id: B16([1; 16]),
        patch: None,
        unset: None,
        add: None,
        remove: None,
        body: None,
        body_edits: None,
        body_base: None,
        body_base_text: None,
        base: None,
        if_revision: None,
        update_refs: None,
    }
}

fn submit(n: &mut Node, op: Op) {
    let result =
        n.r.submit(
            n.s,
            SubmitParams {
                ops: vec![op],
                mutation_id: None,
                conflict_mode: None,
                timezone: None,
                allow_partial: None,
                mutation_ids: None,
                dry_run: None,
                include: None,
                wait: None,
            },
        )
        .unwrap();
    assert!(result.iter().all(|r| r.problem.is_none()), "{result:?}");
}

#[test]
fn moving_update_and_concurrent_other_device_edit_land_at_new_path() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    let mut b = node(&svc, 2, MemStore::new());
    a.r.planner = Box::new(crate::plan::CorePlanner);
    b.r.planner = Box::new(crate::plan::CorePlanner);
    settle(&mut [&mut a, &mut b]);
    submit(
        &mut a,
        Op::ResourcePut(ResourcePut {
            path: "mdbase.yaml".into(),
            doc: Text::Inline("spec_version: '0.3.0'\n".into()),
            base_revision: None,
            must_not_exist: None,
        }),
    );
    submit(&mut a, Op::ResourcePut(ResourcePut {
        path: "_types/task.md".into(),
        doc: Text::Inline("---\nkind: mdbase.type\nname: task\nmatch: {path_glob: 'tasks/*.md'}\nschema:\n  dialect: json-schema-2020-12\n  value:\n    type: object\n    required: [title]\n    properties:\n      title: {type: string}\ncollection:\n  path:\n    pattern: 'tasks/{title}.md'\n    fields: [title]\n---\n".into()),
        base_revision: None,
        must_not_exist: None,
    }));
    settle(&mut [&mut a, &mut b]);
    let r = a.create(1, "tasks/Old.md", "initial body\n");
    assert!(r.problem.is_none(), "{r:?}");
    settle(&mut [&mut a, &mut b]);

    // Both submit before either observes the other's change.
    submit(
        &mut a,
        Op::Update(Update {
            id: B16([1; 16]),
            patch: Some(DataMap(vec![("title".into(), Value::Text("New".into()))])),
            ..empty_update()
        }),
    );
    submit(
        &mut b,
        Op::Update(Update {
            id: B16([1; 16]),
            body: Some(Text::Inline("concurrent body\n".into())),
            ..empty_update()
        }),
    );
    settle(&mut [&mut a, &mut b]);
    for n in [&a, &b] {
        let row = n.r.store().record(&B16([1; 16])).unwrap().unwrap();
        assert_eq!(row.path, "tasks/New.md");
        assert!(row.doc.contains("concurrent body"), "{row:?}");
        assert!(!row.doc.contains("title:"));
        assert_eq!(n.r.stats.verify_mismatch, 0);
    }
    assert_eq!(a.r.head(), b.r.head());
}
