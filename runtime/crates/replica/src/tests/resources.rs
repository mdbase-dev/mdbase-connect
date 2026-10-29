//! Resource source reads over the real local StoreView/LayerView.
use super::engine::{COL, Node, node, settle};
use crate::api::{ClientApi, ErrorCode, SessionAuth, SessionId};
use crate::fake::FakeLogService;
use crate::mem::MemStore;
use crate::testkit::TestControlPlane;
use crate::{Store, Tx};
use mdbn_core::plan::Effect;
use mdbn_wire::client::HelloParams;
use mdbn_wire::common::{B16, Version};
use mdbn_wire::policy::{GrantRevoke, PolicyOp};

const SOURCE: &str = "---\nkind: mdbase.type\nname: task\n---\n";
pub(super) fn configured() -> (FakeLogService, Node) {
    let svc = FakeLogService::new();
    let mut store = MemStore::new();
    store
        .commit(Tx {
            resources_put: vec![("_types/task.md".into(), SOURCE.into())],
            ..Tx::default()
        })
        .unwrap();
    let mut a = node(&svc, 1, store);
    settle(&mut [&mut a]);
    (svc, a)
}
pub(super) fn granted(
    svc: &FakeLogService,
    a: &mut Node,
    cap: &str,
    folders: Option<Vec<String>>,
) -> SessionId {
    TestControlPlane::new(COL).approved_grant(
        svc,
        B16([0x55; 16]),
        [0x57; 32],
        &[cap],
        folders,
        B16([101; 16]),
    );
    settle(&mut [&mut *a]);
    a.r.hello(
        SessionAuth::Grant {
            grant: B16([0x55; 16]),
            client_pk: [0x57; 32],
        },
        HelloParams {
            versions: vec![Version { major: 1, minor: 0 }],
            client_name: "resource-test".into(),
            client_version: "1".into(),
            features: None,
            timezone: None,
        },
    )
    .unwrap()
    .0
}
#[test]
fn resource_source_revision_size_and_reopen_are_exact() {
    let (svc, mut a) = configured();
    let got = a.r.get_resource(a.s, "_types/task.md".into()).unwrap();
    assert_eq!(got.text, SOURCE);
    assert_eq!(got.size, SOURCE.len() as u64);
    assert!(got.confirmed);
    assert_eq!(
        got.revision,
        crate::convert::whash(&mdbn_core::ids::revision(SOURCE))
    );
    let mut reopened = node(&svc, 1, a.r.into_store());
    settle(&mut [&mut reopened]);
    assert_eq!(
        reopened
            .r
            .get_resource(reopened.s, "_types/task.md".into())
            .unwrap(),
        got
    );
}
#[test]
fn resource_pending_replace_and_delete_use_only_local_overlay() {
    let (_, mut a) = configured();
    let base = crate::plan::StoreView::new(&a.r.store, a.r.catalog.clone());
    a.r.layer.apply_effect(
        &base,
        &Effect::PutResource {
            path: "_types/task.md".into(),
            doc: format!("{SOURCE}\nPending source\n"),
        },
    );
    let got = a.r.get_resource(a.s, "_types/task.md".into()).unwrap();
    assert!(!got.confirmed);
    assert!(got.text.ends_with("Pending source\n"));
    assert_eq!(
        got.revision,
        crate::convert::whash(&mdbn_core::ids::revision(&got.text))
    );
    let base = crate::plan::StoreView::new(&a.r.store, a.r.catalog.clone());
    a.r.layer.apply_effect(
        &base,
        &Effect::RemoveResource {
            path: "_types/task.md".into(),
        },
    );
    assert_eq!(
        a.r.get_resource(a.s, "_types/task.md".into())
            .unwrap_err()
            .code(),
        Some(ErrorCode::NotFound)
    );
}
#[test]
fn resource_reads_refuse_nonportable_nonresource_and_missing_paths() {
    let (_, mut a) = configured();
    for path in [
        "../mdbase.yaml",
        "/mdbase.yaml",
        "_types/../secret",
        "_types\\task.md",
        "_types/CON",
        "tasks/a.md",
    ] {
        assert_eq!(
            a.r.get_resource(a.s, path.into()).unwrap_err().code(),
            Some(ErrorCode::InvalidRequest),
            "{path}"
        );
    }
    assert_eq!(
        a.r.get_resource(a.s, "_types/missing.md".into())
            .unwrap_err()
            .code(),
        Some(ErrorCode::NotFound)
    );
}
#[test]
fn resource_read_only_grant_succeeds_but_revoked_closed_and_no_read_sessions_refuse() {
    let (svc, mut a) = configured();
    let s = granted(&svc, &mut a, "collection.read", None);
    assert_eq!(
        a.r.get_resource(s, "_types/task.md".into()).unwrap().text,
        SOURCE
    );
    TestControlPlane::new(COL).append(
        &svc,
        vec![PolicyOp::GrantRevoke(GrantRevoke {
            grant: B16([0x55; 16]),
        })],
    );
    settle(&mut [&mut a]);
    assert_eq!(
        a.r.get_resource(s, "_types/task.md".into())
            .unwrap_err()
            .code(),
        Some(ErrorCode::Unauthenticated)
    );
    a.r.close(a.s);
    assert_eq!(
        a.r.get_resource(a.s, "_types/task.md".into())
            .unwrap_err()
            .code(),
        Some(ErrorCode::Unauthenticated)
    );
    let (svc, mut a) = configured();
    let s = granted(&svc, &mut a, "records.create", None);
    assert_eq!(
        a.r.get_resource(s, "_types/task.md".into())
            .unwrap_err()
            .code(),
        Some(ErrorCode::Forbidden)
    );
}
#[test]
fn resource_folder_scoped_grant_cannot_read_collection_definitions() {
    let (svc, mut a) = configured();
    let s = granted(&svc, &mut a, "collection.read", Some(vec!["_types".into()]));
    assert_eq!(
        a.r.get_resource(s, "_types/task.md".into())
            .unwrap_err()
            .code(),
        Some(ErrorCode::Forbidden)
    );
}
#[test]
fn resource_store_read_fault_is_unavailable_not_missing_or_empty() {
    let (_, mut a) = configured();
    a.r.store.data().borrow_mut().fail_resource_reads = 1;
    assert_eq!(
        a.r.get_resource(a.s, "_types/task.md".into())
            .unwrap_err()
            .code(),
        Some(ErrorCode::Unavailable)
    );
    assert_eq!(
        a.r.get_resource(a.s, "_types/task.md".into()).unwrap().text,
        SOURCE
    );
}

#[test]
fn resource_response_budget_and_apply_fault_refuse_without_partial_text() {
    let (_, mut a) = configured();
    a.r.store
        .commit(Tx {
            resources_put: vec![("_types/large.md".into(), "x".repeat(1024 * 1024 + 1))],
            ..Tx::default()
        })
        .unwrap();
    let error = a.r.get_resource(a.s, "_types/large.md".into()).unwrap_err();
    assert_eq!(error.code(), Some(ErrorCode::Unavailable));
    assert_eq!(
        error.into_problem().reason.as_deref(),
        Some("resource_budget_exceeded")
    );
    a.r.apply_fault = true;
    assert_eq!(
        a.r.get_resource(a.s, "_types/task.md".into())
            .unwrap_err()
            .code(),
        Some(ErrorCode::Unavailable)
    );
}

#[test]
fn deferred_resource_ingestion_reports_paths_before_source_reads() {
    let (_, mut a) = configured();
    let mut inventory = (0..40)
        .map(|n| {
            (
                format!("_types/a{n:02}.md"),
                SOURCE.replace("name: task", &format!("name: a{n:02}")),
            )
        })
        .collect::<Vec<_>>();
    inventory.push(("_types/zz-oversized.md".into(), "x".repeat(1_048_577)));
    a.r.store_mut()
        .commit(Tx {
            resources_put: inventory,
            ..Tx::default()
        })
        .unwrap();
    a.r.ingest(vec![crate::store::Observation {
        token: crate::store::ObservationId(901),
        path: "_types/task.md".into(),
        base: None,
        now: Some(crate::store::Observed::Text(SOURCE.into())),
        moved_from: None,
        provenance: crate::store::Provenance::Normal,
    }]);
    let failure_paths = a.r.resource_ingest_paths();
    a.r.ingest(vec![crate::store::Observation {
        token: crate::store::ObservationId(902),
        path: "ordinary.md".into(),
        base: None,
        now: Some(crate::store::Observed::Text("ordinary note".into())),
        moved_from: None,
        provenance: crate::store::Provenance::Normal,
    }]);
    assert_eq!(a.r.resource_ingest_paths(), failure_paths);
    assert_eq!(
        a.r.resource_ingest_paths().first().map(String::as_str),
        Some("_types/zz-oversized.md")
    );
    assert!(
        !a.r.resource_ingest_paths()
            .iter()
            .any(|p| p.starts_with("_types/a"))
    );
    assert!(
        a.r.sync_status()
            .incidents
            .iter()
            .any(|i| i.kind == mdbn_wire::client::IncidentKind::Integrity)
    );
}
