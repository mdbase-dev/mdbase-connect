use super::*;
use mdbase::runtime::FilesystemProvider;
use std::fs;
use tempfile::tempdir;

#[test]
fn reconciler_preserves_ids_across_renames_and_emits_tombstones() {
    let state = tempdir().unwrap();
    let collection_root = tempdir().unwrap();
    fs::write(
        collection_root.path().join("mdbase.yaml"),
        "spec_version: 0.3.0\n",
    )
    .unwrap();
    fs::write(
        collection_root.path().join("one.md"),
        "---\ntitle: One\n---\n",
    )
    .unwrap();
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let collection = registry.add(collection_root.path()).unwrap();
    let store = LocalSyncStore::for_registry(&registry);
    let provider = FilesystemProvider::open(collection_root.path()).unwrap();
    store
        .reconcile(
            collection.id,
            &provider.snapshot().unwrap(),
            &HashMap::new(),
        )
        .unwrap();
    let before = records(&store.connection().unwrap(), collection.id)
        .unwrap()
        .into_values()
        .next()
        .unwrap();

    fs::rename(
        collection_root.path().join("one.md"),
        collection_root.path().join("renamed.md"),
    )
    .unwrap();
    let renamed_state = store
        .reconcile(
            collection.id,
            &provider.snapshot().unwrap(),
            &HashMap::new(),
        )
        .unwrap();
    let renamed = records(&store.connection().unwrap(), collection.id)
        .unwrap()
        .into_values()
        .next()
        .unwrap();
    assert_eq!(renamed.record_id, before.record_id);
    assert_eq!(renamed.path, "renamed.md");
    assert_eq!(renamed_state.head, 1);

    fs::remove_file(collection_root.path().join("renamed.md")).unwrap();
    let deleted = store
        .reconcile(
            collection.id,
            &provider.snapshot().unwrap(),
            &HashMap::new(),
        )
        .unwrap();
    assert_eq!(deleted.head, 2);
    assert!(records(&store.connection().unwrap(), collection.id)
        .unwrap()
        .is_empty());
}
