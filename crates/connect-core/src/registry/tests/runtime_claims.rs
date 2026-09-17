use super::*;

#[test]
fn local_batches_do_not_exhaust_runtime_capacity() {
    let state = tempdir().unwrap();
    let parent = tempdir().unwrap();
    let root = parent.path().join("claims");
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let collection = registry.create(&root, Some("Claims"), "UTC").unwrap();
    registry.operation(collection.id, "create", &json!({
        "path": "note.md", "frontmatter": {"title": "Keep", "counter": 0}, "body": "unchanged body"
    })).unwrap();
    for counter in 1..=140 {
        let before = registry
            .operation(collection.id, "read", &json!({"path": "note.md"}))
            .unwrap();
        let result = registry
            .operation(
                collection.id,
                "batch",
                &json!({"operations": [{
                    "kind": "update", "input": {"path": "note.md", "patch": {"counter": counter},
                        "if_revision": before["result"]["revision"]}
                }]}),
            )
            .unwrap_or_else(|error| panic!("batch {counter}: {error}"));
        assert_eq!(result["valid"], true, "{result}");
        registry
            .finalize_runtime_changes(collection.id, &mdbase::OperationCancellation::new())
            .unwrap();
    }
    assert_eq!(
        registry
            .recover_runtime_claims(collection.id, &[], false)
            .unwrap()["transactions_before"],
        json!([])
    );
    // Ordinary non-batch mutations share the same ownership/settlement path.
    for counter in 141..=280 {
        let before = registry
            .operation(collection.id, "read", &json!({"path": "note.md"}))
            .unwrap();
        let result = registry.operation(collection.id, "update", &json!({"path": "note.md", "patch": {"counter": counter}, "if_revision": before["result"]["revision"]})).unwrap();
        assert_eq!(result["valid"], true);
        registry
            .finalize_runtime_changes(collection.id, &mdbase::OperationCancellation::new())
            .unwrap();
    }
    assert_eq!(
        registry
            .recover_runtime_claims(collection.id, &[], false)
            .unwrap()["transactions_before"],
        json!([])
    );
    let after = registry
        .operation(collection.id, "read", &json!({"path": "note.md"}))
        .unwrap();
    assert_eq!(after["result"]["frontmatter"]["counter"], 280);
    assert_eq!(after["result"]["frontmatter"]["title"], "Keep");
    assert!(fs::read_to_string(root.join("note.md"))
        .unwrap()
        .ends_with("unchanged body\n"));
}
