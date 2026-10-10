//! Real replica inventory reads; no valid-catalog filter or whole-source fallback.
use super::engine::{Node, node, settle};
use super::resources::{configured, granted};
use crate::api::{ClientApi, ErrorCode, ListResources, SessionAuth};
use crate::{Store, Tx};
use mdbn_core::plan::Effect;
use mdbn_wire::client::{HelloParams, Include};
use mdbn_wire::common::{B16, B32, Value, Version};
use mdbn_wire::policy::{GrantRevoke, PolicyOp};

fn selection(text: bool, limit: u32) -> ListResources {
    ListResources {
        text: Some(text),
        limit: Some(limit),
        ..Default::default()
    }
}
fn continuation(a: &mut Node) -> ListResources {
    let mut request = selection(true, 1);
    let page = a.r.list_resources(a.s, request.clone()).unwrap();
    assert!(!page.complete);
    assert!(!page.resources.is_empty());
    request.cursor = page.cursor;
    request
}
fn add(a: &mut Node, rows: Vec<(String, String)>) {
    a.r.store
        .commit(Tx {
            resources_put: rows,
            ..Default::default()
        })
        .unwrap();
}
fn many() -> Node {
    let (_, mut a) = configured();
    add(
        &mut a,
        vec![
            ("mdbase.yaml".into(), "invalid configuration".into()),
            ("_types/orphan.md".into(), "not YAML".into()),
            (
                "_types/conflict.md".into(),
                "---\nkind: mdbase.type\nname: task\n---\n".into(),
            ),
            ("schemas/registered.json".into(), "{invalid".into()),
            ("receipts/packs.lock".into(), "private lock source\n".into()),
            (
                "_contracts/broken.md".into(),
                "---\nkind: mdbase.contract\nname: [\n".into(),
            ),
        ],
    );
    // Deliberately invalid catalog: inventory must still include every stored row.
    a.r.catalog = std::sync::Arc::new(crate::plan::load_catalog(&a.r.store).unwrap());
    a.r.store.data().borrow_mut().refuse_unbounded_resources = true;
    a
}
fn reason(error: crate::api::ApiError, code: ErrorCode, reason: &str) {
    assert_eq!(error.code(), Some(code));
    assert_eq!(error.problem().reason.as_deref(), Some(reason));
}

#[test]
fn resource_list_all_pages_preserve_malformed_orphan_exact_inventory_and_absence() {
    let mut a = many();
    let mut request = selection(true, 2);
    let mut got = Vec::new();
    let mut cursors = std::collections::BTreeSet::new();
    loop {
        let page = a.r.list_resources(a.s, request.clone()).unwrap();
        assert!(page.resources.len() <= 2);
        for row in &page.resources {
            assert!(row.confirmed);
            let text = row.text.as_ref().unwrap();
            assert_eq!(row.size, text.len() as u64);
            assert_eq!(
                row.revision,
                crate::convert::whash(&mdbn_core::ids::revision(text))
            );
        }
        got.extend(page.resources);
        if page.complete {
            assert!(page.cursor.is_none());
            break;
        }
        let cursor = page.cursor.unwrap();
        assert!(cursor.starts_with("r1."));
        assert!(cursors.insert(cursor.clone()));
        request.cursor = Some(cursor);
    }
    let paths: Vec<_> = got.iter().map(|r| r.path.as_str()).collect();
    assert_eq!(
        paths,
        vec![
            "_contracts/broken.md",
            "_types/conflict.md",
            "_types/orphan.md",
            "_types/task.md",
            "mdbase.yaml",
            "receipts/packs.lock",
            "schemas/registered.json"
        ]
    );
    assert!(!paths.contains(&"_types/retired.md"));
    assert_eq!(got[2].text.as_deref(), Some("not YAML"));
    assert_eq!(got[4].text.as_deref(), Some("invalid configuration"));
    assert_eq!(got[5].text.as_deref(), Some("private lock source\n"));
    assert!(!a.r.store.data().borrow().resource_copy_limits.is_empty());
}

#[test]
fn resource_list_metadata_default_folder_empty_and_reopen() {
    let mut a = many();
    let page = a.r.list_resources(a.s, ListResources::default()).unwrap();
    assert!(page.complete && page.cursor.is_none());
    assert_eq!(page.resources.len(), 7);
    assert!(
        page.resources
            .iter()
            .all(|r| r.text.is_none() && r.confirmed)
    );
    let folder =
        a.r.list_resources(
            a.s,
            ListResources {
                folder: Some("_types".into()),
                text: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(folder.complete);
    assert_eq!(folder.resources.len(), 3);
    assert!(
        folder
            .resources
            .iter()
            .all(|r| r.path.starts_with("_types/"))
    );
    let empty =
        a.r.list_resources(
            a.s,
            ListResources {
                folder: Some("missing".into()),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(empty.complete && empty.cursor.is_none() && empty.resources.is_empty());
    // Startup/catalog compilation may use the legacy API; enumeration may not.
    a.r.store.data().borrow_mut().refuse_unbounded_resources = false;
    let service = crate::fake::FakeLogService::new();
    let mut reopened = node(&service, 1, a.r.into_store());
    assert_eq!(
        reopened
            .r
            .list_resources(reopened.s, ListResources::default())
            .unwrap(),
        page
    );
}

#[test]
fn resource_list_page_limit_and_encoded_cap_admit_before_source_copy() {
    let mut a = many();
    add(
        &mut a,
        (0..130)
            .map(|i| (format!("large/{i:03}.md"), "é".repeat(512 * 1024)))
            .collect(),
    );
    let mut request = ListResources {
        folder: Some("large".into()),
        text: Some(true),
        limit: Some(128),
        ..Default::default()
    };
    let first = a.r.list_resources(a.s, request.clone()).unwrap();
    // Two 1 MiB bodies cannot fit with metadata: pagination, never truncation.
    assert_eq!(first.resources.len(), 1);
    assert!(!first.complete && first.cursor.is_some());
    assert_eq!(first.resources[0].text.as_ref().unwrap().len(), 1 << 20);
    assert!(mdbn_wire::cbor::encode(&first.to_cbor()).unwrap().len() <= 2 << 20);
    let limits = a.r.store.data().borrow().resource_copy_limits.clone();
    assert_eq!(limits[0], 1 << 20);
    assert!(
        limits[1] < 1 << 20,
        "page remainder must constrain SQL/source projection before copy"
    );
    request.cursor = first.cursor;
    let next = a.r.list_resources(a.s, request).unwrap();
    assert_eq!(next.resources[0].path, "large/001.md");
    // Metadata-only pages still hash full exact sources and respect the row cap.
    let metadata =
        a.r.list_resources(
            a.s,
            ListResources {
                folder: Some("large".into()),
                limit: Some(128),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(metadata.resources.len(), 128);
    assert!(!metadata.complete && metadata.cursor.is_some());
    assert!(metadata.resources.iter().all(|r| r.text.is_none()));
}

#[test]
fn resource_list_limit_path_source_and_backend_faults_never_succeed_partially() {
    let mut a = many();
    reason(
        a.r.list_resources(a.s, selection(false, 0)).unwrap_err(),
        ErrorCode::InvalidRequest,
        "invalid_resource_params",
    );
    for limit in [129, u32::MAX] {
        reason(
            a.r.list_resources(a.s, selection(false, limit))
                .unwrap_err(),
            ErrorCode::TooLarge,
            "resource_budget_exceeded",
        );
    }
    for folder in ["", "../private", "/absolute", "_types\\task"] {
        reason(
            a.r.list_resources(
                a.s,
                ListResources {
                    folder: Some(folder.into()),
                    ..Default::default()
                },
            )
            .unwrap_err(),
            ErrorCode::InvalidRequest,
            "invalid_path",
        );
    }
    for field in [0, 1] {
        let mut request = ListResources::default();
        if field == 0 {
            request.folder = Some("x".repeat(4097));
        } else {
            request.cursor = Some("x".repeat(4097));
        }
        reason(
            a.r.list_resources(a.s, request).unwrap_err(),
            ErrorCode::TooLarge,
            "resource_budget_exceeded",
        );
    }
    a.r.store.data().borrow_mut().fail_resource_path_reads = 1;
    reason(
        a.r.list_resources(a.s, ListResources::default())
            .unwrap_err(),
        ErrorCode::Unavailable,
        "resource_inventory_unavailable",
    );
    a.r.store.data().borrow_mut().fail_resource_reads = 1;
    reason(
        a.r.list_resources(a.s, ListResources::default())
            .unwrap_err(),
        ErrorCode::Unavailable,
        "resource_inventory_unavailable",
    );
    add(
        &mut a,
        vec![("oversize/source.md".into(), "x".repeat((1 << 20) + 1))],
    );
    reason(
        a.r.list_resources(a.s, ListResources::default())
            .unwrap_err(),
        ErrorCode::Unavailable,
        "resource_budget_exceeded",
    );
    add(
        &mut a,
        vec![(format!("{}-oversize.md", "x".repeat(4097)), "abc".into())],
    );
    reason(
        a.r.list_resources(a.s, ListResources::default())
            .unwrap_err(),
        ErrorCode::TooLarge,
        "resource_budget_exceeded",
    );
}

#[test]
fn resource_list_pending_put_delete_install_and_apply_fault_refuse_before_reads() {
    for deletion in [false, true] {
        let mut a = many();
        let request = continuation(&mut a);
        let base = crate::plan::StoreView::new(&a.r.store, a.r.catalog.clone());
        let effect = if deletion {
            Effect::RemoveResource {
                path: "_types/task.md".into(),
            }
        } else {
            Effect::PutResource {
                path: "_types/task.md".into(),
                doc: "pending".into(),
            }
        };
        a.r.layer.apply_effect(&base, &effect);
        let before = a.r.store.data().borrow().resource_copy_limits.len();
        for request in [ListResources::default(), request] {
            reason(
                a.r.list_resources(a.s, request).unwrap_err(),
                ErrorCode::Unavailable,
                "resource_inventory_pending",
            );
        }
        assert_eq!(a.r.store.data().borrow().resource_copy_limits.len(), before);
    }
    for install in [false, true] {
        let mut a = many();
        let request = continuation(&mut a);
        if install {
            a.r.install = Some(crate::replica::TestInstall::Control);
        } else {
            a.r.apply_fault = true;
        }
        let before = a.r.store.data().borrow().resource_copy_limits.len();
        reason(
            a.r.list_resources(a.s, request).unwrap_err(),
            ErrorCode::Unavailable,
            "resource_inventory_unavailable",
        );
        assert_eq!(a.r.store.data().borrow().resource_copy_limits.len(), before);
    }
}

#[test]
fn resource_list_cursor_binds_selection_session_method_view_head_and_generation() {
    let mut a = many();
    let request = continuation(&mut a);
    let mut changed = request.clone();
    changed.folder = Some("_types".into());
    reason(
        a.r.list_resources(a.s, changed).unwrap_err(),
        ErrorCode::InvalidRequest,
        "invalid_resource_cursor",
    );
    let mut changed = request.clone();
    changed.text = Some(false);
    reason(
        a.r.list_resources(a.s, changed).unwrap_err(),
        ErrorCode::InvalidRequest,
        "invalid_resource_cursor",
    );
    let mut changed = request.clone();
    changed.limit = Some(2);
    reason(
        a.r.list_resources(a.s, changed).unwrap_err(),
        ErrorCode::InvalidRequest,
        "invalid_resource_cursor",
    );
    let (other, _) =
        a.r.hello(
            SessionAuth::Host,
            HelloParams {
                versions: vec![Version { major: 1, minor: 0 }],
                client_name: "other".into(),
                client_version: "1".into(),
                features: None,
                timezone: None,
            },
        )
        .unwrap();
    reason(
        a.r.list_resources(other, request.clone()).unwrap_err(),
        ErrorCode::InvalidRequest,
        "invalid_resource_cursor",
    );
    for token in ["", "bad", "q1.00000000000000000000000000000000"] {
        let mut changed = request.clone();
        changed.cursor = Some(token.into());
        reason(
            a.r.list_resources(a.s, changed).unwrap_err(),
            ErrorCode::InvalidRequest,
            "invalid_resource_cursor",
        );
    }
    let query = Value::Map(vec![
        ("limit".into(), Value::Int(1)),
        (
            "cursor".into(),
            Value::Text(request.cursor.clone().unwrap()),
        ),
    ]);
    reason(
        a.r.query(
            a.s,
            query,
            Include {
                effective: None,
                body: None,
                document: None,
                diagnostics: None,
            },
        )
        .unwrap_err(),
        ErrorCode::InvalidRequest,
        "invalid_query_cursor",
    );
    // Replaying the same cursor remains bound to the same snapshot.
    assert_eq!(
        a.r.list_resources(a.s, request.clone()).unwrap().resources,
        a.r.list_resources(a.s, request.clone()).unwrap().resources
    );
    a.r.view_version += 1;
    reason(
        a.r.list_resources(a.s, request).unwrap_err(),
        ErrorCode::InvalidRequest,
        "cursor_stale",
    );
    let request = continuation(&mut a);
    a.r.store_generation += 1;
    reason(
        a.r.list_resources(a.s, request).unwrap_err(),
        ErrorCode::InvalidRequest,
        "cursor_stale",
    );
    let request = continuation(&mut a);
    let head = crate::store::Head {
        seq: a.r.head.seq + 1,
        chain: B32([4; 32]),
    };
    a.r.store
        .commit(Tx {
            head: Some(head),
            ..Default::default()
        })
        .unwrap();
    a.r.head = head;
    reason(
        a.r.list_resources(a.s, request).unwrap_err(),
        ErrorCode::InvalidRequest,
        "cursor_stale",
    );
}

#[test]
fn resource_list_cursor_expiry_is_family_fixed_and_closed_sessions_lose_authority() {
    let mut a = many();
    let request = continuation(&mut a);
    let opened = a.clock.get();
    a.clock.set(opened + 299_999);
    let page = a.r.list_resources(a.s, request.clone()).unwrap();
    a.clock.set(opened + 300_000);
    reason(
        a.r.list_resources(a.s, request).unwrap_err(),
        ErrorCode::InvalidRequest,
        "cursor_expired",
    );
    reason(
        a.r.list_resources(
            a.s,
            ListResources {
                cursor: page.cursor,
                ..selection(true, 1)
            },
        )
        .unwrap_err(),
        ErrorCode::InvalidRequest,
        "cursor_expired",
    );
    a.r.close(a.s);
    assert_eq!(
        a.r.list_resources(a.s, ListResources::default())
            .unwrap_err()
            .code(),
        Some(ErrorCode::Unauthenticated)
    );
}

#[test]
fn resource_list_read_grants_full_scope_revocation_and_store_head_qualification() {
    let (service, mut a) = configured();
    let session = granted(&service, &mut a, "collection.read", None);
    assert!(
        a.r.list_resources(session, ListResources::default())
            .unwrap()
            .complete
    );
    crate::testkit::TestControlPlane::new(super::engine::COL).append(
        &service,
        vec![PolicyOp::GrantRevoke(GrantRevoke {
            grant: B16([0x55; 16]),
        })],
    );
    settle(&mut [&mut a]);
    assert_eq!(
        a.r.list_resources(session, ListResources::default())
            .unwrap_err()
            .code(),
        Some(ErrorCode::Unauthenticated)
    );
    for (cap, folders, code) in [
        ("records.create", None, ErrorCode::Forbidden),
        (
            "collection.read",
            Some(vec!["_types".into()]),
            ErrorCode::Forbidden,
        ),
    ] {
        let (service, mut a) = configured();
        let session = granted(&service, &mut a, cap, folders);
        assert_eq!(
            a.r.list_resources(session, ListResources::default())
                .unwrap_err()
                .code(),
            Some(code)
        );
    }
    let (_, mut a) = configured();
    a.r.store
        .commit(Tx {
            head: Some(crate::store::Head {
                seq: a.r.head.seq + 1,
                chain: B32([3; 32]),
            }),
            ..Default::default()
        })
        .unwrap();
    reason(
        a.r.list_resources(a.s, ListResources::default())
            .unwrap_err(),
        ErrorCode::Unavailable,
        "resource_inventory_unavailable",
    );
}
