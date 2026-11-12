//! End to end: a local-only replica over a real folder, SQLite index and
//! native platform. Create a record through the client API, see the file,
//! edit it outside, see the change, reopen with the same identity.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::path::PathBuf;

use mdbn_local_host::{
    Descriptor, HostKind, HostLock, Identity, LocalReplica, OsEntropy, ReplicaOptions,
    StoreOptions, SystemClock, open_store,
};
use mdbn_replica::api::{ClientApi, ContractQuery, Target};
use mdbn_wire::client::{Include, ReceiptState, SubmitParams};
use mdbn_wire::common::{B16, DataMap, Text, Value};
use mdbn_wire::intent::{Create, Op};

fn test_dir(tag: &str) -> PathBuf {
    let p =
        PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&p);
    std::fs::create_dir_all(&p).unwrap();
    p
}

fn include() -> Include {
    Include {
        effective: None,
        body: Some(true),
        document: Some(true),
        diagnostics: Some(true),
    }
}

fn open(root: &std::path::Path) -> (HostLock, LocalReplica) {
    let opts = StoreOptions::default();
    let lock = HostLock::try_acquire(
        root,
        &opts.private_dir,
        Some(Descriptor::new(HostKind::Library, 1)),
    )
    .unwrap();
    let state = opts.state_dir(root);
    std::fs::create_dir_all(&state).unwrap();
    let identity =
        Identity::load_or_create(&state.join("identity.json"), 1, &mut OsEntropy).unwrap();
    let store = open_store(root, &opts, Box::new(SystemClock)).unwrap();
    let rep = LocalReplica::open(store, &identity, ReplicaOptions::default()).unwrap();
    (lock, rep)
}

#[test]
fn create_publish_outside_edit_reopen() {
    let root = test_dir("local");
    std::fs::write(root.join("mdbase.yaml"), "spec_version: \"0.3.0\"\n").unwrap();
    let (lock, mut rep) = open(&root);
    rep.rescan().unwrap();

    let id = B16(mdbn_local_host::host::uuid_v7(
        1_700_000_000_000,
        &mut OsEntropy,
    ));
    let session = rep.session();
    let receipts = rep
        .replica()
        .submit(
            session,
            SubmitParams {
                ops: vec![Op::Create(Create {
                    id,
                    path: Some("notes/hello.md".into()),
                    type_name: None,
                    frontmatter: Some(DataMap(vec![("title".into(), Value::Text("Hello".into()))])),
                    body: Some(Text::Inline("Body text.\n".into())),
                    document: None,
                })],
                mutation_id: None,
                conflict_mode: None,
                timezone: None,
                allow_partial: None,
                mutation_ids: None,
                dry_run: None,
                include: None,
                wait: None,
                validation: None,
            },
        )
        .unwrap();
    assert_eq!(receipts.len(), 1);
    let mutation = receipts[0].mutation;
    rep.tick();
    let receipt = rep.replica().receipt(session, mutation).unwrap();
    assert_eq!(receipt.state, ReceiptState::Confirmed, "{receipt:?}");
    assert!(receipt.seq.is_none(), "local-only has no log position");

    let text = std::fs::read_to_string(root.join("notes/hello.md")).unwrap();
    assert!(text.contains("title: Hello"), "{text}");
    assert!(text.ends_with("Body text.\n"), "{text}");

    let rec = rep
        .replica()
        .get(session, Target::Path("notes/hello.md".into()), include())
        .unwrap();
    assert_eq!(rec.id, id);
    assert_eq!(rec.body.as_deref(), Some("Body text.\n"));

    // An outside edit is ingested on rescan.
    std::fs::write(
        root.join("notes/hello.md"),
        "---\ntitle: Changed\n---\nNew body.\n",
    )
    .unwrap();
    rep.rescan().unwrap();
    let rec = rep
        .replica()
        .get(session, Target::Path("notes/hello.md".into()), include())
        .unwrap();
    assert_eq!(rec.body.as_deref(), Some("New body.\n"), "{rec:?}");

    // A second host is refused while we hold the lock.
    assert!(matches!(
        HostLock::try_acquire(&root, ".mdbase", None),
        Err(mdbn_local_host::LockError::Held(Some(_)))
    ));

    // Reopen: same identity, same record.
    let replica = rep.close();
    drop(replica);
    drop(lock);
    let (_lock, mut rep) = open(&root);
    rep.rescan().unwrap();
    let session = rep.session();
    let rec = rep
        .replica()
        .get(session, Target::Path("notes/hello.md".into()), include())
        .unwrap();
    assert_eq!(rec.id, id, "the record ID survives a reopen");
    let _ = std::fs::remove_dir_all(&root);
}

fn contract_source(id: &str, version: &str) -> String {
    format!(
        "---\nkind: mdbase.contract\ncontract_type: record\nid: {id}\nversion: '{version}'\nrecord_schema:\n  dialect: json-schema-2020-12\n  value:\n    type: object\n    properties:\n      name: {{type: string}}\n      identities: {{type: array}}\n---\n"
    )
}
fn contract_fixture(tag: &str) -> (PathBuf, HostLock, LocalReplica) {
    let root = test_dir(tag);
    std::fs::write(root.join("mdbase.yaml"), "spec_version: '0.3.0'\n").unwrap();
    std::fs::create_dir_all(root.join("_contracts")).unwrap();
    std::fs::create_dir_all(root.join("_types")).unwrap();
    std::fs::create_dir_all(root.join("people")).unwrap();
    for (path, id, version) in [
        ("person", "mdbase.person", "2.0.0"),
        ("person3", "mdbase.person", "3.0.0"),
        ("other", "acme.other", "2.0.0"),
    ] {
        std::fs::write(
            root.join(format!("_contracts/{path}.md")),
            contract_source(id, version),
        )
        .unwrap();
    }
    let mut source = "---\nkind: mdbase.type\nname: arbitraryContact\nschema:\n  dialect: json-schema-2020-12\n  value:\n    type: object\n    properties:\n      full_name: {type: string}\n      identities: {type: array}\nimplements:\n".to_string();
    for (id, version) in [("mdbase.person", "2.0.0"), ("acme.other", "2.0.0")] {
        source.push_str(&format!("  - contract: {id}\n    version: '{version}'\n    fields: {{'/name': '/full_name', '/identities': '/identities'}}\n"));
    }
    source.push_str("---\n");
    std::fs::write(root.join("_types/contact3.md"), source.replace("arbitraryContact", "versionThreeContact").replace("version: '2.0.0'", "version: '3.0.0'").replace("  - contract: acme.other\n    version: '3.0.0'\n    fields: {'/name': '/full_name', '/identities': '/identities'}\n", "")).unwrap();
    std::fs::write(root.join("_types/contact.md"), source).unwrap();
    for i in 0..5 {
        std::fs::write(root.join(format!("people/{i}.md")), format!("---\ntype: arbitraryContact\nfull_name: Person {i}\nname: Not the mapped name\nidentities: []\n---\n")).unwrap();
    }
    let (lock, mut rep) = open(&root);
    rep.rescan().unwrap();
    (root, lock, rep)
}
fn contract_request(cursor: Option<String>) -> ContractQuery {
    ContractQuery {
        where_: None,
        contract: "mdbase.person".into(),
        version: "2.0.0".into(),
        limit: 2,
        cursor,
    }
}

#[test]
fn native_contract_query_has_real_indexed_complete_pages_and_exact_projection_binding() {
    let (root, _lock, mut rep) = contract_fixture("native-contract-pages");
    let session = rep.session();
    let description = rep.replica().describe(session).unwrap();
    assert!(description.issues.is_empty(), "{description:?}");
    assert!(
        description.types.iter().any(|t| t
            .implements
            .iter()
            .any(|i| i.contract == "mdbase.person" && i.version == "2.0.0")),
        "{description:?}"
    );
    let row = rep
        .replica()
        .get(session, Target::Path("people/0.md".into()), include())
        .unwrap();
    assert_eq!(row.types, ["arbitraryContact"], "{row:?}");
    let first = rep
        .replica()
        .query_contract(session, contract_request(None))
        .unwrap();
    assert!(first.page.complete);
    assert_eq!(first.page.records.len(), 2);
    assert_eq!(first.page.has_more, Some(true));
    assert_eq!(first.page.total_count, None);
    assert_eq!(first.records[0].id, first.page.records[0].id);
    assert_eq!(
        first.records[0].implementations[0].fields,
        DataMap(vec![
            (
                "name".into(),
                first.page.records[0]
                    .frontmatter
                    .get("full_name")
                    .unwrap()
                    .clone()
            ),
            ("identities".into(), Value::List(vec![]))
        ])
    );
    let second = rep
        .replica()
        .query_contract(
            session,
            contract_request(Some(first.page.cursor.clone().unwrap())),
        )
        .unwrap();
    let third = rep
        .replica()
        .query_contract(
            session,
            contract_request(Some(second.page.cursor.clone().unwrap())),
        )
        .unwrap();
    assert_eq!(second.page.records.len(), 2);
    assert_eq!(third.page.records.len(), 1);
    assert!(third.page.cursor.is_none());
    assert_eq!(third.page.has_more, Some(false));
    for page in [&second, &third] {
        assert!(page.page.complete);
        assert_eq!(page.page.as_of, first.page.as_of);
        assert_eq!(page.contract_digest, first.contract_digest);
        assert_eq!(page.page.total_count, None);
    }
    let mut paths: Vec<_> = [&first, &second, &third]
        .into_iter()
        .flat_map(|page| page.page.records.iter().map(|row| row.path.as_str()))
        .collect();
    paths.sort();
    assert_eq!(
        paths,
        [
            "people/0.md",
            "people/1.md",
            "people/2.md",
            "people/3.md",
            "people/4.md"
        ]
    );
    assert_eq!(
        rep.replica_ref().query_stats().indexed,
        3,
        "actual maintained SQLite path, not a fake cursor"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn native_contract_cursor_refuses_other_contract_version_session_and_changed_catalog() {
    let (root, _lock, mut rep) = contract_fixture("native-contract-cursor-fences");
    let session = rep.session();
    let cursor = rep
        .replica()
        .query_contract(session, contract_request(None))
        .unwrap()
        .page
        .cursor
        .unwrap();
    for (contract, version) in [("acme.other", "2.0.0"), ("mdbase.person", "3.0.0")] {
        let mut request = contract_request(Some(cursor.clone()));
        request.contract = contract.into();
        request.version = version.into();
        let error = rep.replica().query_contract(session, request).unwrap_err();
        assert_eq!(
            error.problem().reason.as_deref(),
            Some("invalid_query_cursor")
        );
    }
    std::fs::write(
        root.join("people/0.md"),
        "---\ntype: arbitraryContact\nfull_name: Updated\nidentities: []\n---\n",
    )
    .unwrap();
    rep.rescan().unwrap();
    let error = rep
        .replica()
        .query_contract(session, contract_request(Some(cursor)))
        .unwrap_err();
    assert_eq!(error.problem().reason.as_deref(), Some("cursor_stale"));
    let cursor = rep
        .replica()
        .query_contract(session, contract_request(None))
        .unwrap()
        .page
        .cursor
        .unwrap();
    std::fs::write(
        root.join("_contracts/person.md"),
        contract_source("mdbase.person", "2.0.0")
            .replace("type: string", "type: string, minLength: 1"),
    )
    .unwrap();
    rep.rescan().unwrap();
    let error = rep
        .replica()
        .query_contract(session, contract_request(Some(cursor)))
        .unwrap_err();
    // Digest is part of the invocation, checked before the view stamp.
    assert_eq!(
        error.problem().reason.as_deref(),
        Some("invalid_query_cursor")
    );
    let cursor = rep
        .replica()
        .query_contract(session, contract_request(None))
        .unwrap()
        .page
        .cursor
        .unwrap();
    rep.replica().close(session);
    let error = rep
        .replica()
        .query_contract(session, contract_request(Some(cursor)))
        .unwrap_err();
    assert_eq!(
        error.code(),
        Some(mdbn_replica::api::ErrorCode::Unauthenticated)
    );
    let _ = std::fs::remove_dir_all(root);
}

/// A native host answers a per-record (non-indexed) query over more records than
/// the memory-constrained budget (1000 records) allows: it selects the desktop
/// query profile: TaskNotes-shaped list queries at
/// 10k were refused).
#[test]
fn native_host_answers_per_record_queries_over_the_constrained_budget() {
    let root = test_dir("local-desktop-query");
    std::fs::write(root.join("mdbase.yaml"), "spec_version: \"0.3.0\"\n").unwrap();
    std::fs::create_dir_all(root.join("tasks")).unwrap();
    for i in 0..1100 {
        let status = if i % 3 == 0 { "done" } else { "open" };
        std::fs::write(
            root.join(format!("tasks/t{i:04}.md")),
            format!(
                "---\nstatus: {status}\ndue: 2026-10-{:02}\n---\nTask {i}\n",
                1 + i % 28
            ),
        )
        .unwrap();
    }
    let (_lock, mut rep) = open(&root);
    rep.rescan().unwrap();
    let session = rep.session();
    let q = Value::Map(vec![
        ("where".into(), Value::Text("status != \"done\"".into())),
        (
            "order_by".into(),
            Value::List(vec![Value::Map(vec![
                ("field".into(), Value::Text("due".into())),
                ("direction".into(), Value::Text("asc".into())),
            ])]),
        ),
        ("limit".into(), Value::Int(100)),
    ]);
    let out = rep.replica().query(session, q, include()).unwrap();
    assert_eq!(out.records.len(), 100);
    // Answered by the per-record path (the profile does not cover `!=`).
    assert_eq!(rep.replica_ref().query_stats().declined, 1);
    assert_eq!(
        rep.replica_ref().query_execution_profile(),
        mdbn_replica::QueryExecutionProfile::Desktop
    );
}

#[cfg(unix)]
fn open_folder_at(
    root: &std::path::Path,
    state_dir: Option<PathBuf>,
) -> Result<mdbn_local_host::OpenFolder, mdbn_local_host::FolderError> {
    mdbn_local_host::open_folder(
        root,
        &mdbn_local_host::FolderOptions {
            state_dir,
            desktop: true,
            timezone: None,
            take_over: false,
            client: ("test".into(), "0".into()),
        },
    )
}

/// The default state dir lives inside the folder, so the folder's contents
/// decide where it points: a symlinked `library` is refused and nothing is
/// written where it leads.
#[cfg(unix)]
#[test]
fn a_symlinked_default_state_dir_is_refused() {
    let dir = test_dir("state-symlink");
    let (root, outside) = (dir.join("folder"), dir.join("outside"));
    std::fs::create_dir_all(root.join(".mdbase")).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(root.join("mdbase.yaml"), "spec_version: \"0.3.0\"\n").unwrap();
    std::os::unix::fs::symlink(&outside, root.join(".mdbase/library")).unwrap();
    match open_folder_at(&root, None) {
        Err(mdbn_local_host::FolderError::Unsafe(p)) => {
            assert!(p.ends_with(".mdbase/library"), "{p:?}")
        }
        other => panic!("{:?}", other.map(|f| f.root)),
    }
    assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 0);
}

/// Nothing in the default state dir may be a symlink: the index, its WAL and
/// the identity are only ever opened as files in that directory.
#[cfg(unix)]
#[test]
fn a_symlink_inside_the_default_state_dir_is_refused() {
    for name in ["index.sqlite", "index.sqlite-wal", "identity.json"] {
        let dir = test_dir(&format!("state-entry-{name}"));
        let (root, outside) = (dir.join("folder"), dir.join("outside"));
        std::fs::create_dir_all(root.join(".mdbase/library")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(root.join("mdbase.yaml"), "spec_version: \"0.3.0\"\n").unwrap();
        std::fs::write(outside.join("kept"), b"unchanged").unwrap();
        std::os::unix::fs::symlink(
            outside.join("target"),
            root.join(".mdbase/library").join(name),
        )
        .unwrap();
        match open_folder_at(&root, None) {
            Err(mdbn_local_host::FolderError::Unsafe(p)) => {
                assert!(p.ends_with(format!(".mdbase/library/{name}")), "{p:?}")
            }
            other => panic!("{name}: {:?}", other.map(|f| f.root)),
        }
        assert!(!outside.join("target").exists(), "{name}");
        assert_eq!(std::fs::read(outside.join("kept")).unwrap(), b"unchanged");
    }
}

/// Symlinks the user chose are left alone: a collection opened through a
/// symlinked path, and an explicit state dir that is itself a symlink.
#[cfg(unix)]
#[test]
fn symlinks_above_the_collection_and_explicit_state_dirs_open() {
    let dir = test_dir("state-chosen-links");
    let real = dir.join("real");
    std::fs::create_dir_all(&real).unwrap();
    std::fs::write(real.join("mdbase.yaml"), "spec_version: \"0.3.0\"\n").unwrap();
    std::os::unix::fs::symlink(&real, dir.join("via")).unwrap();
    drop(open_folder_at(&dir.join("via").join(".").join(""), None).unwrap());
    assert!(real.join(".mdbase/library/index.sqlite").is_file());

    let state = dir.join("state");
    std::fs::create_dir_all(&state).unwrap();
    std::os::unix::fs::symlink(&state, dir.join("state-link")).unwrap();
    drop(open_folder_at(&real, Some(dir.join("state-link"))).unwrap());
    assert!(state.join("index.sqlite").is_file());
}
