//! End to end: a local-only replica over a real folder, SQLite index and
//! native platform. Create a record through the client API, see the file,
//! edit it outside, see the change, reopen with the same identity.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::path::PathBuf;

use mdbn_local_host::{
    Descriptor, HostKind, HostLock, Identity, LocalReplica, OsEntropy, ReplicaOptions,
    StoreOptions, SystemClock, open_store,
};
use mdbn_replica::api::{ClientApi, Target};
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
