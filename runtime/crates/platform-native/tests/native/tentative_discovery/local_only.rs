//! The unsynced collection: the app runtime's local-only replica over the same
//! real Disposable SQLite `TentativeStore`. It has no log, keys or policy device,
//! and its Bases views still discover, read and execute. Not browser/OPFS/WASM
//! qualification.
use super::*;
use mdbn_core::views::bases::{DateGroupMode, NullOrder, OrderingCapture, StringOrder};
use r::replica::{BasesExecutionPolicies, BasesReadRequest};
use std::collections::BTreeMap;

const OPEN_VIEW: &str = "views:\n  - type: table\n    name: Open\n    filters: \"note.status == 'open'\"\n    order: [file.name]\n    sort: [{property: file.name, direction: ASC}]\n";

/// The same composition `AppRuntime::open_local_consuming` makes: LocalOnly,
/// no log endpoint, roots, pins or genesis, and the host session.
fn open_local(path: &std::path::Path) -> (App, SessionId) {
    let index = Rc::new(RefCell::new(AppSql {
        inner: SqliteIndex::open(path, IndexDurability::Disposable).unwrap(),
        probe: Rc::new(Probe::default()),
    }));
    let store = TentativeStore::open(index, SqlStoreLimits::MOBILE).unwrap();
    let cfg = ReplicaConfig {
        collection: COLLECTION,
        device_id: DEVICE,
        replica_id: B16([1; 16]),
        mode: SyncMode::LocalOnly,
        log_endpoint: r::log::EndpointId(0),
        verify: false,
        runtime_version: "tentative-local-only-test".into(),
        trusted_roots: vec![],
        trusted_signers: vec![DEVICE],
        e2e: false,
        user_enabled_cloud_copy: false,
        chosen_state: None,
        expected_genesis: None,
        key_grants_only: false,
        policy_pins: None,
    };
    cfg.validate_host_trust().unwrap();
    let mut app = Replica::open(
        cfg,
        store,
        Box::new(r::plan::CorePlanner),
        Box::new(r::seal::KeyringSealer::new(COLLECTION, DEVICE, &SIGN, &KEM)),
        Host {
            clock: Box::new(mdbn_core::host::FixedClock(1_700_000_000_000)),
            entropy: Box::new(r::crypto::TestEntropy::new(1)),
            zones: Box::new(UtcOnly),
        },
        DeviceSecrets {
            sign_sk: SIGN,
            kem_sk: KEM,
        },
    )
    .unwrap();
    let session = app
        .hello(
            SessionAuth::Host,
            HelloParams {
                versions: vec![Version { major: 1, minor: 0 }],
                client_name: "app".into(),
                client_version: "test".into(),
                features: None,
                timezone: Some("UTC".into()),
            },
        )
        .unwrap()
        .0;
    (app, session)
}
/// Local commits confirm without a log: nothing may stay pending.
fn commit(app: &mut App, session: SessionId, ops: Vec<Op>, mutation: u8) {
    submit(app, session, ops, mutation);
    app.tick();
    assert_eq!(app.store().pending_count().unwrap(), 0);
}
fn task(id: u8, name: &str, status: &str) -> Op {
    create(
        B16([id; 16]),
        &format!("tasks/{name}.md"),
        &format!("---\nstatus: {status}\n---\n"),
    )
}
fn selection() -> BasesViewSelection {
    BasesViewSelection {
        record: SOURCE_ID,
        revision: w::hash::sha256(OPEN_VIEW.as_bytes()),
        index: 0,
    }
}
fn open_rows(app: &mut App, session: SessionId) -> Vec<B16> {
    let hints = BTreeMap::new();
    let mut rows = Vec::new();
    app.encode_indexed_bases_read_request(
        session,
        BasesReadRequest {
            selection: selection(),
            property_types: &hints,
            timezone: "UTC",
            window: None,
        },
        |result| {
            assert_eq!(result.view.record, SOURCE_ID);
            assert_eq!(result.view.name.as_deref(), Some("Open"));
            rows = result.rows.iter().map(|row| row.record).collect();
            Ok(1)
        },
        |_, size| Ok(vec![0; size]),
    )
    .unwrap();
    rows
}

#[test]
fn unsynced_collection_discovers_reads_and_executes_bases_views() {
    let path = scratch("tentative-local-only-bases").join("app.db");
    let (mut app, session) = open_local(&path);
    // Before setup the refusal is the missing contract, never a keyed-device one.
    refused(&mut app, session);
    commit(&mut app, session, resource_ops(), 21);
    commit(
        &mut app,
        session,
        vec![
            create(SOURCE_ID, SOURCE_PATH, OPEN_VIEW),
            task(21, "a", "open"),
            task(22, "b", "done"),
            task(23, "c", "open"),
        ],
        22,
    );
    let revision = selection().revision;
    assert_eq!(
        views(&mut app, session),
        vec![(
            SOURCE_ID,
            SOURCE_PATH.into(),
            revision,
            0,
            Some("Open".into())
        )]
    );
    let source = app
        .encode_bases_view_source(session, selection(), Some("UTC"), |_, source, _| {
            Ok(source.source.clone())
        })
        .unwrap();
    assert_eq!(source, OPEN_VIEW);
    assert_eq!(
        open_rows(&mut app, session),
        vec![B16([21; 16]), B16([23; 16])]
    );
    // The captured (non-indexed) path admits the same local cut.
    let input = app
        .capture_bases_execution_inputs(selection(), Some(&BTreeMap::new()), Some("UTC"))
        .unwrap();
    let result = app
        .execute_captured_bases_view(
            input,
            BasesExecutionPolicies {
                ordering: OrderingCapture {
                    nulls: NullOrder::Last,
                    strings: StringOrder::Utf16,
                },
                date_groups: DateGroupMode::Unavailable,
                inventory_ties: true,
            },
            &|| false,
        )
        .unwrap();
    assert_eq!(
        result.rows.iter().map(|row| row.record).collect::<Vec<_>>(),
        vec![B16([21; 16]), B16([23; 16])]
    );
    // A later local commit moves the cut; the next read sees it.
    commit(&mut app, session, vec![task(24, "d", "open")], 23);
    assert_eq!(
        open_rows(&mut app, session),
        vec![B16([21; 16]), B16([23; 16]), B16([24; 16])]
    );
    assert_eq!(app.store().meta(meta_keys::KEYRING).unwrap(), None);
    // Reopening the same browser store (a reload) still serves its views.
    drop(app);
    let (mut app, session) = open_local(&path);
    assert_eq!(views(&mut app, session).len(), 1);
    assert_eq!(open_rows(&mut app, session).len(), 3);
}

#[test]
fn synced_replica_without_a_keyed_device_is_still_refused() {
    // Same store and session as above, but Synced with no genesis applied:
    // there is no policy device, so it never takes the local-only authority.
    let path = scratch("tentative-synced-unkeyed-bases").join("app.db");
    let (mut app, session, _) = open(&path, Rc::new(Probe::default()));
    let error = app
        .encode_bases_discovery_page(session, Some("UTC"), 1, None, |_, _, _| Ok(()))
        .expect_err("an unkeyed synced replica refuses Bases reads");
    assert_eq!(error.code(), Some(ErrorCode::Forbidden));
    assert_eq!(
        error.problem().reason.as_deref(),
        Some("view_requires_keyed_device")
    );
}
