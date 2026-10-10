use super::*;
use crate::{Store, Tx};
use std::sync::Arc;
mod execution;
mod indexed;
mod run;
fn fixture() -> serde_json::Value {
    include_str!("../../../../../conformance/determinism/bases-discovery.log")
        .lines()
        .filter(|l| !l.starts_with('#'))
        .map(|l| serde_json::from_str::<serde_json::Value>(l).unwrap())
        .find(|v| {
            v["path"]
                .as_str()
                .is_some_and(|p| p.ends_with("tasks-default.base"))
        })
        .unwrap()
}
fn configured() -> (FakeLogService, Node, String) {
    let (svc, mut a) = collection_setup::keyed_node();
    a.r.planner = Box::new(crate::plan::CorePlanner);
    let fixture = fixture();
    let mut ops = vec![Op::ResourcePut(mdbn_wire::intent::ResourcePut {
        path: "mdbase.yaml".into(),
        doc: "spec_version: '0.3.0'\nsettings:\n  record_extensions: [md, base]\n".into(),
        base_revision: None,
        must_not_exist: None,
    })];
    for resource in fixture["resources"].as_array().unwrap() {
        ops.push(Op::ResourcePut(mdbn_wire::intent::ResourcePut {
            path: resource["path"].as_str().unwrap().into(),
            doc: resource["source"].as_str().unwrap().into(),
            base_revision: None,
            must_not_exist: None,
        }));
    }
    a.r.submit(
        a.s,
        SubmitParams {
            ops,
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
    settle(&mut [&mut a]);
    assert_eq!(a.r.catalog.implementations().len(), 1);
    (svc, a, fixture["source"].as_str().unwrap().into())
}
#[test]
fn signed_device_discovers_original_tasknotes_base_from_complete_confirmed_replica() {
    let (_, mut a, source) = configured();
    a.create(11, "TaskNotes/Views/tasks-default.base", &source);
    a.create(12, "task.md", "---\nstatus: open\n---\nTask");
    settle(&mut [&mut a]);
    let capture = a.r.capture_bases_discovery(Some("UTC")).unwrap();
    assert_eq!(capture.record_count(), 2);
    let expected: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../conformance/determinism/bases-discovery.expected.json"
    ))
    .unwrap();
    let fixture = fixture();
    let line = include_str!("../../../../../conformance/determinism/bases-discovery.log")
        .lines()
        .filter(|l| !l.starts_with('#'))
        .position(|l| {
            serde_json::from_str::<serde_json::Value>(l).unwrap()["path"] == fixture["path"]
        })
        .unwrap();
    let views = expected["results"][line]["value"]["views"]
        .as_array()
        .unwrap();
    assert_eq!(capture.views().len(), views.len());
    for (descriptor, view) in capture.views().iter().zip(views) {
        assert_eq!(descriptor.record, B16([11; 16]));
        assert_eq!(
            descriptor.revision,
            mdbn_wire::hash::sha256(source.as_bytes())
        );
        assert_eq!(
            descriptor.index,
            u32::try_from(view["index"].as_u64().unwrap()).unwrap()
        );
        assert_eq!(descriptor.name.as_deref(), view["name"].as_str());
        assert_eq!(descriptor.view_type, view["type"].as_str().unwrap());
        assert_eq!(descriptor.implementations[0].type_name, "obsidian_base");
    }
    a.r.recheck_bases_discovery(&capture).unwrap();
    assert_eq!(a.doc(11).as_deref(), Some(source.as_str()));
}
#[test]
fn md_records_are_discovered_only_through_actual_resolved_membership() {
    let (_, mut a, _) = configured();
    a.create(
        1,
        "User/view.md",
        "---\ntype: obsidian_base\nviews: [{type: table, name: Explicit}]\n---\n",
    );
    a.create(
        2,
        "User/untyped.md",
        "---\nviews: [{type: table, name: NotBase}]\n---\n",
    );
    settle(&mut [&mut a]);
    let capture = a.r.capture_bases_discovery(Some("UTC")).unwrap();
    assert_eq!(capture.record_count(), 2);
    assert_eq!(capture.views().len(), 1);
    assert_eq!(capture.views()[0].path, "User/view.md");
    assert_eq!(capture.views()[0].name.as_deref(), Some("Explicit"));
}
#[test]
fn actual_empty_inventory_requires_installed_contract_and_empty_source_page() {
    let (_, mut a, _) = configured();
    let capture = a.r.capture_bases_discovery(Some("UTC")).unwrap();
    assert!(capture.views().is_empty());
    assert_eq!(capture.record_count(), 0);
    let (_, mut a) = collection_setup::keyed_node();
    assert_eq!(
        a.r.capture_bases_discovery(Some("UTC"))
            .err()
            .unwrap()
            .code(),
        Some(ErrorCode::Unavailable)
    );
}
#[test]
fn discovery_refuses_optimistic_or_unhealthy_and_invalid_registry_state() {
    let (_, mut a, source) = configured();
    a.create(1, "view.base", &source);
    assert_eq!(
        a.r.capture_bases_discovery(Some("UTC"))
            .err()
            .unwrap()
            .code(),
        Some(ErrorCode::Unavailable)
    );
    settle(&mut [&mut a]);
    a.r.caught_up = false;
    assert_eq!(
        a.r.capture_bases_discovery(Some("UTC"))
            .err()
            .unwrap()
            .code(),
        Some(ErrorCode::Unavailable)
    );
}
#[test]
fn discovery_recheck_rejects_lifetime_and_unchanged_head_source_drift() {
    let (_, mut a, source) = configured();
    a.create(1, "view.base", &source);
    settle(&mut [&mut a]);
    let capture = a.r.capture_bases_discovery(Some("UTC")).unwrap();
    let mut row = a.r.store.record(&B16([1; 16])).unwrap().unwrap();
    row.doc = "views: [{type: table, name: Changed}]\n".into();
    row.revision = mdbn_wire::hash::sha256(row.doc.as_bytes());
    a.r.store_mut()
        .commit(Tx {
            records_put: vec![row],
            ..Tx::default()
        })
        .unwrap();
    assert_eq!(
        a.r.recheck_bases_discovery(&capture).err().unwrap().code(),
        Some(ErrorCode::Conflict)
    );
    let (_, mut a, source) = configured();
    a.create(1, "view.base", &source);
    settle(&mut [&mut a]);
    let capture = a.r.capture_bases_discovery(Some("UTC")).unwrap();
    a.r.catalog = Arc::new((*a.r.catalog).clone());
    assert_eq!(
        a.r.recheck_bases_discovery(&capture).err().unwrap().code(),
        Some(ErrorCode::Conflict)
    );
}
#[test]
fn inconsistent_source_hash_and_source_cap_fail_the_complete_discovery() {
    let (_, mut a, source) = configured();
    a.create(1, "view.base", &source);
    settle(&mut [&mut a]);
    let mut row = a.r.store.record(&B16([1; 16])).unwrap().unwrap();
    row.doc.push_str("\nchanged: true");
    a.r.store_mut()
        .commit(Tx {
            records_put: vec![row.clone()],
            ..Tx::default()
        })
        .unwrap();
    assert_eq!(
        a.r.capture_bases_discovery(Some("UTC"))
            .err()
            .unwrap()
            .code(),
        Some(ErrorCode::Conflict)
    );
    row.doc = "x".repeat((1 << 20) + 1);
    row.revision = mdbn_wire::hash::sha256(row.doc.as_bytes());
    a.r.store_mut()
        .commit(Tx {
            records_put: vec![row],
            ..Tx::default()
        })
        .unwrap();
    assert_eq!(
        a.r.capture_bases_discovery(Some("UTC"))
            .err()
            .unwrap()
            .code(),
        Some(ErrorCode::InvalidRequest)
    );
}
