use super::*;
use mdbase_connect_protocol::{SyncChange, SyncChangesPage, SyncFileSnapshotPage, SyncSession};

fn sync(
    registry: &CollectionRegistry,
    collection_id: Uuid,
    replica: &crate::LocalReplica,
    input: Value,
) -> Value {
    registry
        .sync_operation_synchronized(
            collection_id,
            &input,
            replica.clone(),
            &GrantScope::full_collection(),
            || Ok(()),
        )
        .unwrap()
}

#[test]
fn cancelled_sync_reads_stop_before_snapshot_work() {
    let state = tempdir().unwrap();
    let root = tempdir().unwrap();
    fs::write(root.path().join("mdbase.yaml"), "spec_version: 0.3.0\n").unwrap();
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let collection = registry.add(root.path()).unwrap();
    let replica = crate::LocalReplica {
        id: Uuid::new_v4(),
        name: "Cancelled mirror".to_string(),
        mode: mdbase_connect_protocol::SyncReplicaMode::ReadOnly,
        allowed_types: BTreeSet::new(),
    };
    let cancellation = mdbase::OperationCancellation::new();
    cancellation.cancel();

    assert!(matches!(
        registry.sync_operation_synchronized_cancellable(
            collection.id,
            &json!({"action": "open_session"}),
            replica,
            &GrantScope::full_collection(),
            &cancellation,
            || Ok(()),
        ),
        Err(ConnectError::OperationCancelled)
    ));
}

#[test]
fn file_snapshots_and_changes_share_the_record_cursor() {
    let state = tempdir().unwrap();
    let root = tempdir().unwrap();
    fs::write(root.path().join("mdbase.yaml"), "spec_version: 0.3.0\n").unwrap();
    fs::write(root.path().join("note.md"), "---\ntitle: Note\n---\n").unwrap();
    fs::create_dir(root.path().join("Photos")).unwrap();
    fs::write(root.path().join("Photos/one.png"), b"image").unwrap();
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let collection = registry.add(root.path()).unwrap();
    let replica = crate::LocalReplica {
        id: Uuid::new_v4(),
        name: "File mirror".to_string(),
        mode: mdbase_connect_protocol::SyncReplicaMode::ReadOnly,
        allowed_types: BTreeSet::new(),
    };

    let session: SyncSession = serde_json::from_value(sync(
        &registry,
        collection.id,
        &replica,
        json!({"action": "open_session"}),
    ))
    .unwrap();
    let initial: SyncFileSnapshotPage = serde_json::from_value(sync(
        &registry,
        collection.id,
        &replica,
        json!({
            "action": "file_snapshot",
            "snapshot_id": session.snapshot_id,
        }),
    ))
    .unwrap();
    assert_eq!(initial.cursor, session.head);
    assert_eq!(initial.files.len(), 1);
    let file_id = initial.files[0].file_id;

    fs::rename(
        root.path().join("Photos/one.png"),
        root.path().join("Photos/two.png"),
    )
    .unwrap();
    let renamed: SyncChangesPage = serde_json::from_value(sync(
        &registry,
        collection.id,
        &replica,
        json!({"action": "changes", "after": session.head}),
    ))
    .unwrap();
    assert_eq!(renamed.events.len(), 1);
    let SyncChange::FilePut { sequence, file } = &renamed.events[0] else {
        panic!("expected file put")
    };
    assert_eq!(file.file_id, file_id);
    assert_eq!(file.path, "Photos/two.png");

    fs::remove_file(root.path().join("Photos/two.png")).unwrap();
    let removed: SyncChangesPage = serde_json::from_value(sync(
        &registry,
        collection.id,
        &replica,
        json!({"action": "changes", "after": sequence}),
    ))
    .unwrap();
    assert!(matches!(
        &removed.events[..],
        [SyncChange::FileRemove {
            file_id: removed_id,
            previous_path,
            ..
        }] if *removed_id == file_id && previous_path == "Photos/two.png"
    ));
}
