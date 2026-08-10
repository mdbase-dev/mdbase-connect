use super::*;
use mdbase::runtime::FilesystemProvider;
use tempfile::tempdir;

fn registered() -> (
    tempfile::TempDir,
    tempfile::TempDir,
    CollectionRegistry,
    Uuid,
) {
    let state = tempdir().unwrap();
    let root = tempdir().unwrap();
    fs::write(root.path().join("mdbase.yaml"), "spec_version: 0.3.0\n").unwrap();
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let id = registry.add(root.path()).unwrap().id;
    (state, root, registry, id)
}

#[test]
fn file_ids_survive_restart_and_exact_reconciliation() {
    let (state, root, registry, id) = registered();
    fs::write(root.path().join("photo.png"), b"pixels").unwrap();
    let first = registry.reconcile_files(id).unwrap();
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].file_id.get_version_num(), 7);
    let reopened = CollectionRegistry::open(state.path()).unwrap();
    let second = reopened.reconcile_files(id).unwrap();
    assert_eq!(second, first);
}

#[test]
fn replacement_keeps_identity_and_changes_digest_and_revision() {
    let (_state, root, registry, id) = registered();
    fs::write(root.path().join("photo.png"), b"first").unwrap();
    let first = registry.reconcile_files(id).unwrap().remove(0);
    fs::write(root.path().join("photo.png"), b"second version").unwrap();
    let second = registry.reconcile_files(id).unwrap().remove(0);
    assert_eq!(second.file_id, first.file_id);
    assert_ne!(second.content_digest, first.content_digest);
    assert_ne!(second.revision, first.revision);
}

#[test]
fn rename_keeps_identity_but_changes_revision() {
    let (_state, root, registry, id) = registered();
    fs::write(root.path().join("before.pdf"), b"document").unwrap();
    let first = registry.reconcile_files(id).unwrap().remove(0);
    fs::rename(
        root.path().join("before.pdf"),
        root.path().join("after.pdf"),
    )
    .unwrap();
    let second = registry.reconcile_files(id).unwrap().remove(0);
    assert_eq!(second.file_id, first.file_id);
    assert_eq!(second.content_digest, first.content_digest);
    assert_ne!(second.revision, first.revision);
    assert_eq!(second.path, "after.pdf");
}

#[test]
fn unique_copy_delete_move_preserves_identity_after_inode_changes() {
    let (_state, root, registry, id) = registered();
    fs::write(root.path().join("before.bin"), b"unique bytes").unwrap();
    let first = registry.reconcile_files(id).unwrap().remove(0);
    fs::copy(
        root.path().join("before.bin"),
        root.path().join("after.bin"),
    )
    .unwrap();
    fs::remove_file(root.path().join("before.bin")).unwrap();
    let second = registry.reconcile_files(id).unwrap().remove(0);
    assert_eq!(second.file_id, first.file_id);
}

#[test]
fn ambiguous_duplicates_never_guess_a_move() {
    let (_state, root, registry, id) = registered();
    fs::write(root.path().join("original.bin"), b"same").unwrap();
    let original = registry.reconcile_files(id).unwrap().remove(0);
    fs::write(root.path().join("copy-a.bin"), b"same").unwrap();
    fs::write(root.path().join("copy-b.bin"), b"same").unwrap();
    fs::remove_file(root.path().join("original.bin")).unwrap();
    let files = registry.reconcile_files(id).unwrap();
    assert_eq!(files.len(), 2);
    assert!(files.iter().all(|file| file.file_id != original.file_id));
    assert_ne!(files[0].file_id, files[1].file_id);
}

#[test]
fn inventory_refresh_reuses_the_index_until_dirty_and_survives_restart() {
    let (state, root, registry, id) = registered();
    fs::write(root.path().join("asset.bin"), b"first").unwrap();

    let first_revision = registry.refresh_file_index_if_needed(id).unwrap();
    let first = registry.indexed_files(id).unwrap().remove(0);
    fs::write(root.path().join("asset.bin"), b"second").unwrap();

    assert_eq!(
        registry.refresh_file_index_if_needed(id).unwrap(),
        first_revision
    );
    assert_eq!(registry.indexed_files(id).unwrap(), vec![first.clone()]);

    registry.mark_file_inventory_dirty(id).unwrap();
    let reopened = CollectionRegistry::open(state.path()).unwrap();
    let second_revision = reopened.refresh_file_index_if_needed(id).unwrap();
    let second = reopened.indexed_files(id).unwrap().remove(0);
    assert!(second_revision > first_revision);
    assert_ne!(second.content_digest, first.content_digest);
    assert_ne!(second.revision, first.revision);
}

#[test]
fn cold_file_index_warms_outside_the_listing_request() {
    let (_state, root, registry, id) = registered();
    fs::write(root.path().join("asset.bin"), b"verified bytes").unwrap();

    assert_eq!(registry.prepare_file_index_for_listing(id).unwrap(), None);
    let revision = (0..200)
        .find_map(|_| {
            let ready = registry.prepare_file_index_for_listing(id).unwrap();
            if ready.is_none() {
                std::thread::sleep(StdDuration::from_millis(10));
            }
            ready
        })
        .expect("background file index warmup completed");

    assert!(revision > 0);
    assert_eq!(registry.indexed_files(id).unwrap().len(), 1);
}

#[test]
fn cached_digest_reuse_requires_stable_file_metadata() {
    let (_state, root, registry, id) = registered();
    fs::write(root.path().join("asset.bin"), b"first").unwrap();
    registry.reconcile_files(id).unwrap();
    let collection = mdbase::Collection::open(root.path()).unwrap();
    let inventory = discover_collection_files(&collection, &BTreeSet::new()).unwrap();
    let previous = read_indexed_files(&registry.connection().unwrap(), id).unwrap();

    assert!(reusable_content_digest(&inventory.files[0], &previous).is_some());

    fs::write(root.path().join("asset.bin"), b"a different length").unwrap();
    let changed = discover_collection_files(&collection, &BTreeSet::new()).unwrap();
    assert!(reusable_content_digest(&changed.files[0], &previous).is_none());
}

#[test]
fn stale_inventory_is_reconciled_when_watcher_signals_are_missing() {
    let (_state, root, registry, id) = registered();
    fs::write(root.path().join("asset.bin"), b"first").unwrap();
    let first = registry.refresh_file_index_if_needed(id).unwrap();
    fs::write(root.path().join("asset.bin"), b"second").unwrap();
    registry
        .connection()
        .unwrap()
        .execute(
            "UPDATE collection_file_inventory_state SET reconciled_at_ms = 0
             WHERE collection_id = ?1",
            [id.to_string()],
        )
        .unwrap();

    assert!(registry.refresh_file_index_if_needed(id).unwrap() > first);
    assert_eq!(registry.indexed_files(id).unwrap()[0].size, 6);
}

#[test]
fn indexed_pages_are_bounded_and_ordered_by_portable_path() {
    let (_state, root, registry, id) = registered();
    for path in ["z.bin", "a.bin", "m.bin"] {
        fs::write(root.path().join(path), path.as_bytes()).unwrap();
    }
    registry.refresh_file_index_if_needed(id).unwrap();

    let first = registry.indexed_files_page(id, None, 2).unwrap();
    assert_eq!(
        first
            .iter()
            .map(|file| file.path.as_str())
            .collect::<Vec<_>>(),
        vec!["a.bin", "m.bin"]
    );
    let second = registry
        .indexed_files_page(id, Some(&first[1].path), 2)
        .unwrap();
    assert_eq!(
        second
            .iter()
            .map(|file| file.path.as_str())
            .collect::<Vec<_>>(),
        vec!["z.bin"]
    );
}

#[cfg(unix)]
#[test]
fn unsafe_entries_do_not_hide_independent_safe_files() {
    use std::os::unix::fs::symlink;

    let (_state, root, registry, id) = registered();
    fs::write(root.path().join("safe.png"), b"safe").unwrap();
    symlink(
        root.path().join("safe.png"),
        root.path().join("unsafe-link.png"),
    )
    .unwrap();
    let files = registry.reconcile_files(id).unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].path, "safe.png");
}

#[test]
fn file_changes_share_the_collection_sequence_and_are_atomic_with_the_index() {
    let (_state, root, registry, id) = registered();
    let provider = FilesystemProvider::open(root.path()).unwrap();
    crate::LocalSyncStore::for_registry(&registry)
        .reconcile(id, &provider.snapshot().unwrap(), &HashMap::new())
        .unwrap();
    fs::write(root.path().join("one.pdf"), b"one").unwrap();

    let first = registry.reconcile_files(id).unwrap().remove(0);
    let connection = registry.connection().unwrap();
    let (head, after): (u64, String) = connection
        .query_row(
            "SELECT c.head, f.after_file
             FROM local_sync_collections c
             JOIN collection_file_changes f ON f.collection_id = c.collection_id
             WHERE c.collection_id = ?1 AND f.sequence = 1",
            [id.to_string()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(head, 1);
    assert_eq!(
        serde_json::from_str::<CollectionFileDescriptor>(&after).unwrap(),
        first
    );

    fs::rename(root.path().join("one.pdf"), root.path().join("two.pdf")).unwrap();
    let second = registry.reconcile_files(id).unwrap().remove(0);
    let (head, before, after): (u64, String, String) = connection
        .query_row(
            "SELECT c.head, f.before_file, f.after_file
             FROM local_sync_collections c
             JOIN collection_file_changes f ON f.collection_id = c.collection_id
             WHERE c.collection_id = ?1 AND f.sequence = 2",
            [id.to_string()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(head, 2);
    assert_eq!(
        serde_json::from_str::<CollectionFileDescriptor>(&before).unwrap(),
        first
    );
    assert_eq!(
        serde_json::from_str::<CollectionFileDescriptor>(&after).unwrap(),
        second
    );
}
