//! Native ClientApi + real Core planner/validator over MemStore. Not SQL, browser,
//! app-intake, transport cancellation or operational qualification.
use super::engine::{Node, node, settle};
use crate::api::{ClientApi, ErrorCode, SessionId, Target};
use crate::fake::FakeLogService;
use crate::mem::MemStore;
use crate::{Store, Tx};
use mdbn_wire::client::{Include, ReceiptState, SubmitParams};
use mdbn_wire::common::{B16, Text};
use mdbn_wire::intent::{Op, ResourcePut};

fn configured(level: &str, unique: bool) -> (FakeLogService, Node) {
    let service = FakeLogService::new();
    let mut store = MemStore::new();
    let unique = if unique {
        "collection:\n  links:\n    related: {validate_exists: true}\n  unique:\n    - field: slug\n      enforce: report\n"
    } else {
        ""
    };
    store.commit(Tx { resources_put: vec![
        ("mdbase.yaml".into(),format!("spec_version: '0.3.0'\nsettings:\n  validation: {level}\n")),
        ("_types/task.md".into(),format!("---\nkind: mdbase.type\nname: Task\nmatch:\n  path_glob: 'tasks/**/*.md'\nschema:\n  dialect: json-schema-2020-12\n  value:\n    type: object\n    required: [title]\n    properties:\n      title: {{type: string}}\n      done: {{type: [boolean, string]}}\n{unique}---\n")),
    ], ..Tx::default() }).unwrap();
    let mut a = node(&service, 1, store);
    a.r.planner = Box::new(crate::plan::CorePlanner);
    settle(&mut [&mut a]);
    assert!(a.r.catalog.is_valid(), "{:?}", a.r.catalog.issues());
    (service, a)
}
// Preserve the real writer's error-level gate: narrow the definition only after
// the records were genuinely admitted by its prior compatible schema.
fn narrow_schema(a: &mut Node) {
    let source = a.r.store.resource("_types/task.md").unwrap().unwrap();
    let replacement = source.replace("type: [boolean, string]", "type: boolean");
    let receipts =
        a.r.submit(
            a.s,
            SubmitParams {
                ops: vec![Op::ResourcePut(ResourcePut {
                    path: "_types/task.md".into(),
                    doc: Text::Inline(replacement),
                    base_revision: Some(mdbn_wire::hash::sha256(source.as_bytes())),
                    must_not_exist: None,
                })],
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
    assert_eq!(
        receipts[0].state,
        ReceiptState::Pending,
        "{:?}",
        receipts[0].problem
    );
}
fn target(n: u8) -> Target {
    Target::Id(B16([n; 16]))
}
fn actual(a: &mut Node, n: u8) -> mdbn_wire::client::RecordView {
    a.r.get(
        a.s,
        target(n),
        Include {
            document: Some(true),
            body: Some(true),
            effective: None,
            diagnostics: None,
        },
    )
    .unwrap()
}

#[test]
fn validation_schema_diagnostics_bind_actual_pending_and_confirmed_document_without_writes() {
    let (_, mut a) = configured("warn", false);
    let write = a.create(
        10,
        "tasks/one.md",
        "---\ntitle: One\ndone: wrong\n---\nBody\n",
    );
    assert_eq!(write.state, ReceiptState::Pending, "{:?}", write.problem);
    narrow_schema(&mut a);
    let seen = actual(&mut a, 10);
    let commits = a.r.store.data().borrow().commits;
    let rows =
        a.r.validate(
            a.s,
            Some(vec![
                target(10),
                Target::Path(seen.path.clone()),
                target(10),
            ]),
        )
        .unwrap();
    assert_eq!(a.r.store.data().borrow().commits, commits);
    assert_eq!(rows.len(), 3);
    for row in &rows {
        assert_eq!(row.id, seen.id);
        assert_eq!(row.path, seen.path);
        assert_eq!(row.revision, seen.revision);
        assert_eq!(
            row.revision,
            mdbn_wire::hash::sha256(seen.document.as_ref().unwrap().as_bytes())
        );
        let mut expected = mdbn_core::validate::validate_record(
            &a.r.layer.catalog().unwrap_or_else(|| a.r.catalog.clone()),
            &seen.path,
            seen.document.as_ref().unwrap(),
        );
        expected = mdbn_core::validate::apply_level(expected, mdbn_core::intent::Level::Warn, true);
        assert_eq!(row.issues, expected);
        assert!(row.issues.iter().any(|i| i.code == "schema_type"
            && i.location.as_deref() == Some("/done")
            && i.type_name.as_deref() == Some("Task")
            && i.severity == mdbn_core::validate::Severity::Warning));
    }
    settle(&mut [&mut a]);
    let confirmed = actual(&mut a, 10);
    assert_eq!(
        a.r.validate(a.s, Some(vec![target(10)])).unwrap()[0].revision,
        confirmed.revision
    );
    assert_eq!(seen.id, confirmed.id);
}
#[test]
fn validation_off_still_reports_explicit_warnings_and_core_cross_record_links_and_uniqueness() {
    let (_, mut a) = configured("off", true);
    assert_eq!(
        a.create(
            10,
            "tasks/a.md",
            "---\ntitle: A\nslug: same\ndone: wrong\nrelated: '[[missing]]'\n---\n[[missing]]\n"
        )
        .state,
        ReceiptState::Pending
    );
    assert_eq!(
        a.create(11, "tasks/b.md", "---\ntitle: B\nslug: same\n---\nB\n")
            .state,
        ReceiptState::Pending
    );
    narrow_schema(&mut a);
    let rows = a.r.validate(a.s, Some(vec![target(10)])).unwrap();
    let codes: Vec<_> = rows[0].issues.iter().map(|i| i.code.as_str()).collect();
    assert!(codes.contains(&"schema_type"), "{codes:?}");
    assert!(codes.contains(&"link_not_found"), "{codes:?}");
    assert!(codes.contains(&"duplicate_value"), "{codes:?}");
    assert!(
        rows[0]
            .issues
            .iter()
            .all(|i| i.severity == mdbn_core::validate::Severity::Warning)
    );
    assert!(
        rows[0]
            .issues
            .iter()
            .any(|i| i.tier == mdbn_core::validate::Tier::CrossRecord)
    );
    assert_eq!(a.r.validate(a.s, None).unwrap().len(), 2);
}
#[test]
fn validation_error_level_retains_real_core_error_severity() {
    let (_, mut a) = configured("error", false);
    assert_eq!(
        a.create(10, "tasks/a.md", "---\ntitle: A\ndone: wrong\n---\nBody\n")
            .state,
        ReceiptState::Pending
    );
    narrow_schema(&mut a);
    let rows = a.r.validate(a.s, Some(vec![target(10)])).unwrap();
    assert!(
        rows[0]
            .issues
            .iter()
            .any(|i| i.code == "schema_type" && i.severity == mdbn_core::validate::Severity::Error)
    );
}

#[test]
fn validation_missing_or_closed_session_refuses_whole_batch_not_empty_success() {
    let (_, mut a) = configured("error", false);
    a.create(
        10,
        "tasks/good.md",
        "---\ntitle: Good\ndone: true\n---\nGood\n",
    );
    assert!(
        a.r.validate(a.s, Some(vec![target(10)])).unwrap()[0]
            .issues
            .is_empty()
    );
    for missing in [target(99), Target::Path("missing.md".into())] {
        assert_eq!(
            a.r.validate(a.s, Some(vec![target(10), missing]))
                .unwrap_err()
                .code(),
            Some(ErrorCode::NotFound)
        );
    }
    assert_eq!(
        a.r.validate(SessionId(999), Some(vec![]))
            .unwrap_err()
            .code(),
        Some(ErrorCode::Unauthenticated)
    );
    a.r.close(a.s);
    assert_eq!(
        a.r.validate(a.s, Some(vec![])).unwrap_err().code(),
        Some(ErrorCode::Unauthenticated)
    );
}
#[test]
fn validation_bounded_targets_and_paths_refuse_before_any_diagnostics() {
    let (_, mut a) = configured("error", false);
    assert_eq!(
        a.r.validate(a.s, Some(vec![target(10); 1001]))
            .unwrap_err()
            .code(),
        Some(ErrorCode::TooLarge)
    );
    for path in ["".to_owned(), "é".repeat(2049)] {
        assert_eq!(
            a.r.validate(a.s, Some(vec![Target::Path(path)]))
                .unwrap_err()
                .code(),
            Some(ErrorCode::InvalidRequest)
        );
    }
    assert!(a.r.validate(a.s, Some(vec![])).unwrap().is_empty());
    assert!(a.r.validate(a.s, None).unwrap().is_empty());
}
#[test]
fn validation_rechecks_actual_grant_authorization_not_hello_snapshot() {
    let (_, mut a) = configured("error", false);
    a.r.sessions.get_mut(&a.s).unwrap().auth = crate::api::SessionAuth::Grant {
        grant: B16([77; 16]),
        client_pk: [88; 32],
    };
    assert_eq!(
        a.r.validate(a.s, Some(vec![])).unwrap_err().code(),
        Some(ErrorCode::Unauthenticated)
    );
}

#[test]
fn validation_oversized_real_core_diagnostics_refuse_instead_of_truncating() {
    let (_, mut a) = configured("warn", true);
    a.create(
        10,
        "tasks/base.md",
        "---\ntitle: Base\nslug: same\n---\nBody\n",
    );
    settle(&mut [&mut a]);
    let base = a.r.store.record(&B16([10; 16])).unwrap().unwrap();
    // Synthetic candidates exercise actual Core duplicate diagnostics and output
    // refusal; this is not a claimed signed-sync/SQL confirmation history.
    let mut rows = Vec::new();
    for n in 0..999u32 {
        let mut row = base.clone();
        let mut bytes = [0u8; 16];
        bytes[..4].copy_from_slice(&n.to_be_bytes());
        row.id = B16(bytes);
        row.path = format!("tasks/{}-{n}.md", "x".repeat(1200));
        rows.push(row);
    }
    a.r.store
        .commit(Tx {
            records_put: rows,
            ..Tx::default()
        })
        .unwrap();
    let error = a.r.validate(a.s, Some(vec![target(10)])).unwrap_err();
    assert_eq!(error.code(), Some(ErrorCode::TooLarge));
    assert_eq!(error.0.reason.as_deref(), Some("validation_budget"));
}

#[test]
fn validation_invalid_catalog_is_not_a_false_clean_record() {
    let service = FakeLogService::new();
    let mut store = MemStore::new();
    store
        .commit(Tx {
            resources_put: vec![("mdbase.yaml".into(), "spec_version: invalid\n".into())],
            ..Tx::default()
        })
        .unwrap();
    let mut a = node(&service, 1, store);
    settle(&mut [&mut a]);
    assert_eq!(
        a.r.validate(a.s, None).unwrap_err().code(),
        Some(ErrorCode::CollectionInvalid)
    );
}
#[test]
fn validation_document_and_collection_inventory_limits_refuse_whole_result() {
    let (_, mut a) = configured("warn", false);
    a.create(10, "tasks/base.md", "---\ntitle: Base\n---\nBody\n");
    settle(&mut [&mut a]);
    let base = a.r.store.record(&B16([10; 16])).unwrap().unwrap();
    // Synthetic store fixtures exercise bounds; no fabricated confirmation claim.
    let mut large = base.clone();
    large.doc = "X".repeat(1024 * 1024 + 1);
    a.r.store
        .commit(Tx {
            records_put: vec![large],
            ..Tx::default()
        })
        .unwrap();
    assert_eq!(
        a.r.validate(a.s, Some(vec![target(10)]))
            .unwrap_err()
            .code(),
        Some(ErrorCode::TooLarge)
    );
    let mut records = vec![base.clone()];
    for n in 0..1001u32 {
        let mut row = base.clone();
        let mut bytes = [0u8; 16];
        bytes[..4].copy_from_slice(&n.to_be_bytes());
        row.id = B16(bytes);
        row.path = format!("tasks/{n}.md");
        records.push(row);
    }
    a.r.store
        .commit(Tx {
            records_put: records,
            ..Tx::default()
        })
        .unwrap();
    assert_eq!(
        a.r.validate(a.s, None).unwrap_err().code(),
        Some(ErrorCode::TooLarge)
    );
    // An explicit non-unique record does not implicitly sweep a large collection.
    assert!(
        a.r.validate(a.s, Some(vec![target(10)])).unwrap()[0]
            .issues
            .is_empty()
    );
}
