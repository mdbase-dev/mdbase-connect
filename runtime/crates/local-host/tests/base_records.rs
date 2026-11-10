//! `.base` records on a native host: a collection that lists `base` in
//! `settings.record_extensions` must sync those files both ways, like `.md`.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::path::{Path, PathBuf};

use mdbn_local_host::{
    Descriptor, HostKind, HostLock, Identity, LocalReplica, OsEntropy, ReplicaOptions,
    StoreOptions, SystemClock, open_store,
};
use mdbn_replica::api::{ClientApi, Target};
use mdbn_wire::client::{Include, ReceiptState, SubmitParams};
use mdbn_wire::common::{B16, DataMap, Text, Value};
use mdbn_wire::intent::{Create, Op, Update};
use mdbn_wire::snapshot::TextOrBlob;

const PATH: &str = "TaskNotes/Views/today.base";
const ORIGINAL: &str = "views:\n  - type: tasknotesTaskList\n    name: Today\n    order:\n      - note.title\n      - note.scheduled\n";
const EDITED: &str = "views:\n  - type: tasknotesTaskList\n    name: Today\n    order:\n      - note.title\n      - note.date_scheduled\n";

fn test_dir(tag: &str) -> PathBuf {
    let p =
        PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&p);
    std::fs::create_dir_all(&p).unwrap();
    p
}

fn open(root: &Path) -> (HostLock, LocalReplica) {
    // The daemon's own store configuration.
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

fn include() -> Include {
    Include {
        effective: None,
        body: None,
        document: Some(true),
        diagnostics: None,
    }
}

fn submit(rep: &mut LocalReplica, op: Op) {
    let session = rep.session();
    let receipts = rep
        .replica()
        .submit(
            session,
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
                validation: None,
            },
        )
        .unwrap();
    let mutation = receipts[0].mutation;
    rep.tick();
    let receipt = rep.replica().receipt(session, mutation).unwrap();
    assert_eq!(receipt.state, ReceiptState::Confirmed, "{receipt:?}");
}

fn record_document(rep: &mut LocalReplica) -> (B16, String) {
    let session = rep.session();
    let rec = rep
        .replica()
        .get(session, Target::Path(PATH.into()), include())
        .unwrap_or_else(|e| panic!("{PATH} is not a record: {e:?}"));
    (rec.id, rec.document.unwrap_or_default().to_string())
}

fn scenario(tag: &str, created_by_app: bool) {
    let root = test_dir(tag);
    std::fs::write(
        root.join("mdbase.yaml"),
        "spec_version: \"0.3.0\"\nsettings:\n  record_extensions: [md, base]\n",
    )
    .unwrap();
    std::fs::create_dir_all(root.join("TaskNotes/Views")).unwrap();
    if !created_by_app {
        std::fs::write(root.join(PATH), ORIGINAL).unwrap();
    }
    let (_lock, mut rep) = open(&root);
    rep.rescan().unwrap();
    if created_by_app {
        let id = B16(mdbn_local_host::host::uuid_v7(
            1_700_000_000_000,
            &mut OsEntropy,
        ));
        submit(
            &mut rep,
            Op::Create(Create {
                id,
                path: Some(PATH.into()),
                type_name: None,
                frontmatter: None,
                body: None,
                document: Some(Text::Inline(ORIGINAL.into())),
            }),
        );
        let disk = std::fs::read_to_string(root.join(PATH)).unwrap();
        assert!(disk.contains("note.scheduled"), "{disk}");
    }

    let (id, doc) = record_document(&mut rep);
    assert!(doc.contains("note.scheduled"), "{doc}");

    // Disk to record: an outside edit is ingested on rescan.
    std::fs::write(root.join(PATH), EDITED).unwrap();
    rep.rescan().unwrap();
    let (_, doc) = record_document(&mut rep);
    assert!(
        doc.contains("note.date_scheduled"),
        "outside edit to a .base file was not ingested; record still holds:\n{doc}"
    );

    // Record to disk: an API write reaches the file.
    submit(&mut rep, summary_update(id));
    let disk = std::fs::read_to_string(root.join(PATH)).unwrap();
    assert!(
        disk.contains("written by the app") && disk.contains("note.date_scheduled"),
        "record write did not reach the .base file; disk holds:\n{disk}"
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// A `.base` file already on disk is a record, follows outside edits, and
/// takes the app's writes.
#[test]
fn base_file_on_disk_syncs_both_ways() {
    scenario("base-on-disk", false)
}

/// Lorite's sequence on #1198: the app creates the view, the user edits the
/// file outside, then the app writes the view again.
#[test]
fn app_created_base_record_syncs_both_ways() {
    scenario("base-app-created", true)
}

fn summary_update(id: B16) -> Op {
    Op::Update(Update {
        id,
        patch: Some(DataMap(vec![(
            "summary".into(),
            Value::Text("written by the app".into()),
        )])),
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
    })
}

/// An app write that lands before the host has read an outside edit (the
/// state #1198 was left in) keeps both: neither side is silently lost.
#[test]
fn app_write_racing_an_outside_edit_is_held_not_lost() {
    let root = test_dir("base-race");
    std::fs::write(
        root.join("mdbase.yaml"),
        "spec_version: \"0.3.0\"\nsettings:\n  record_extensions: [md, base]\n",
    )
    .unwrap();
    std::fs::create_dir_all(root.join("TaskNotes/Views")).unwrap();
    std::fs::write(root.join(PATH), ORIGINAL).unwrap();
    let (_lock, mut rep) = open(&root);
    rep.rescan().unwrap();
    let (id, _) = record_document(&mut rep);
    std::fs::write(root.join(PATH), EDITED).unwrap();
    submit(&mut rep, summary_update(id));
    rep.rescan().unwrap();
    rep.tick();

    // The outside edit stays on disk, and the conflict is a visible hold
    // carrying both versions.
    assert_eq!(std::fs::read_to_string(root.join(PATH)).unwrap(), EDITED);
    use mdbn_replica::store::Store as _;
    let holds = rep.replica_ref().store().holds().unwrap();
    assert_eq!(holds.len(), 1, "{holds:#?}");
    assert_eq!(holds[0].path, PATH);
    assert!(
        matches!(&holds[0].mine, TextOrBlob::Text(t) if t == EDITED),
        "{holds:#?}"
    );
    assert!(
        matches!(&holds[0].theirs, Some(TextOrBlob::Text(t)) if t.contains("written by the app")),
        "{holds:#?}"
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// Without `base` in `record_extensions`, a `.base` file is not a record.
#[test]
fn base_file_is_not_a_record_unless_listed() {
    let root = test_dir("base-unlisted");
    std::fs::write(root.join("mdbase.yaml"), "spec_version: \"0.3.0\"\n").unwrap();
    std::fs::create_dir_all(root.join("TaskNotes/Views")).unwrap();
    std::fs::write(root.join(PATH), ORIGINAL).unwrap();
    let (_lock, mut rep) = open(&root);
    rep.rescan().unwrap();
    let session = rep.session();
    assert!(
        rep.replica()
            .get(session, Target::Path(PATH.into()), include())
            .is_err()
    );
    assert_eq!(std::fs::read_to_string(root.join(PATH)).unwrap(), ORIGINAL);
    let _ = std::fs::remove_dir_all(&root);
}
