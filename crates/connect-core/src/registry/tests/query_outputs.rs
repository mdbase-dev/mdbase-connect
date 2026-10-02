use super::*;

#[test]
fn revisioned_documents_and_metadata_rows_use_the_shared_engine() {
    let state = tempdir().unwrap();
    let parent = tempdir().unwrap();
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let collection = registry
        .create(parent.path().join("notes"), Some("Notes"), "UTC")
        .unwrap();
    let scope = GrantScope::full_collection();
    let created = registry.operation(collection.id,"create",&json!({"path":"a.md","frontmatter":{"title":"One","unused":"wide"},"body":"Body 🦀\n"})).unwrap();
    let query = registry
        .scoped_operation(
            collection.id,
            "query",
            &json!({"output":"metadata","select":["title"]}),
            &scope,
        )
        .unwrap();
    assert_eq!(query["result"]["output"], "metadata");
    let row = &query["result"]["results"][0];
    assert_eq!(
        row.as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        ["path", "revision", "types", "values"]
    );
    assert_eq!(row["revision"], created["result"]["revision"]);
    assert_eq!(row["values"], json!({"title":"One"}));
    let batch = registry
        .scoped_operation(
            collection.id,
            "read",
            &json!({"paths":["a.md","missing.md","a.md"],"include_document":true}),
            &scope,
        )
        .unwrap();
    assert_eq!(batch["valid"], true);
    assert_eq!(batch["result"]["items"][0], batch["result"]["items"][2]);
    assert_eq!(
        batch["result"]["items"][0]["record"]["revision"],
        row["revision"]
    );
    assert_eq!(batch["result"]["items"][0]["record"]["body"], "Body 🦀\n");
    assert!(batch["result"]["items"][0]["record"]["document"]
        .as_str()
        .unwrap()
        .contains("Body 🦀"));
    assert_eq!(batch["result"]["items"][1]["status"], "missing");
    let omitted = registry
        .operation(
            collection.id,
            "read",
            &json!({"paths":["a.md"],"include_body":false}),
        )
        .unwrap();
    assert!(omitted["result"]["items"][0]["record"]
        .get("body")
        .is_none());
    assert!(omitted["result"]["items"][0]["record"]
        .get("document")
        .is_none());
    let invalid = registry
        .operation(
            collection.id,
            "query",
            &json!({"output":"metadata","include_body":true}),
        )
        .unwrap();
    assert_eq!(invalid["valid"], false);
}

#[test]
fn metadata_cursor_mode_is_pinned_and_mismatch_does_not_consume_or_release() {
    let state = tempdir().unwrap();
    let parent = tempdir().unwrap();
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let collection = registry
        .create(parent.path().join("notes"), Some("Notes"), "UTC")
        .unwrap();
    for title in ["a", "b", "c"] {
        registry
            .operation(
                collection.id,
                "create",
                &json!({"path":format!("{title}.md"),"frontmatter":{"title":title}}),
            )
            .unwrap();
    }
    let scope = GrantScope::full_collection();
    let normal = registry
        .scoped_operation(
            collection.id,
            "query",
            &json!({"pagination":"cursor","limit":1}),
            &scope,
        )
        .unwrap();
    let normal_cursor = normal["result"]["meta"]["cursor"].as_str().unwrap();
    for action in ["cursor", "release_cursor"] {
        assert!(registry
            .scoped_operation(
                collection.id,
                "query",
                &json!({action:normal_cursor,"output":"metadata"}),
                &scope
            )
            .is_err());
    }
    let page = registry
        .scoped_operation(
            collection.id,
            "query",
            &json!({"cursor":normal_cursor,"limit":1}),
            &scope,
        )
        .unwrap();
    assert!(page["result"].get("output").is_none());
    registry
        .scoped_operation(
            collection.id,
            "query",
            &json!({"release_cursor":normal_cursor}),
            &scope,
        )
        .unwrap();
    let first = registry
        .scoped_operation(
            collection.id,
            "query",
            &json!({"pagination":"cursor","limit":1,"output":"metadata"}),
            &scope,
        )
        .unwrap();
    let cursor = first["result"]["meta"]["cursor"].as_str().unwrap();
    let second = registry
        .scoped_operation(
            collection.id,
            "query",
            &json!({"cursor":cursor,"output":"metadata","limit":1}),
            &scope,
        )
        .unwrap();
    assert_eq!(second["result"]["output"], "metadata");
    assert!(second["result"]["results"][0].get("file").is_none());
    let again = registry
        .scoped_operation(
            collection.id,
            "query",
            &json!({"cursor":cursor,"limit":1}),
            &scope,
        )
        .unwrap();
    assert_eq!(second, again);
    registry
        .scoped_operation(
            collection.id,
            "query",
            &json!({"release_cursor":cursor,"output":"metadata"}),
            &scope,
        )
        .unwrap();
    assert_eq!(
        registry
            .runtime_residency_diagnostics()
            .unwrap()
            .active_read_snapshots,
        0
    );
}
