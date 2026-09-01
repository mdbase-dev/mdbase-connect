use super::*;

#[test]
fn describe_exposes_complete_portable_type_metadata_without_absolute_paths() {
    let state = tempdir().unwrap();
    let collection_parent = tempdir().unwrap();
    let root = collection_parent.path().join("tasks");
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let collection = registry.create(&root, Some("Tasks"), "UTC").unwrap();
    fs::write(
        root.join("mdbase.yaml"),
        r#"spec_version: 0.3.0
settings:
  validation: warn
  x-private: not-for-apps
runtime:
  profile_version: 0.1.0
  enabled: false
x-private:
  token: not-for-apps
"#,
    )
    .unwrap();
    write_work_item_contract(&root);
    fs::write(
        root.join("_contracts/example.unimplemented.md"),
        r#"---
kind: mdbase.contract
contract_type: record
id: example.unimplemented
version: 1.0.0
record_schema:
  dialect: json-schema-2020-12
  value: { type: object }
---
"#,
    )
    .unwrap();
    fs::write(
        root.join("_types/task.md"),
        r#"---
kind: mdbase.type
name: Task
version: 2
description: A portable task.
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    properties:
      title: { type: string }
implements:
  - contract: example.work-item
    version: 1.0.0
    fields:
      title: title
---
"#,
    )
    .unwrap();
    synchronize_external_fixture(&registry, collection.id);

    let listed = registry.list().unwrap();
    assert!(listed[0].contracts.is_empty());
    let inventory = registry.inventory().unwrap();
    assert_eq!(inventory[0].contracts.len(), 1);
    assert_eq!(inventory[0].contracts[0].id, "example.work-item");

    let description = registry.describe(collection.id).unwrap();
    assert_eq!(description.protocol_version, 1);
    assert_eq!(description.types[0].name, "Task");
    assert_eq!(
        description.types[0].schema["properties"]["title"]["type"],
        "string"
    );
    assert_eq!(description.types[0].path.as_deref(), Some("_types/task.md"));
    assert_eq!(
        description.types[0]
            .definition
            .as_ref()
            .and_then(|value| value.pointer("/schema/dialect"))
            .and_then(Value::as_str),
        Some("json-schema-2020-12")
    );
    assert_eq!(
        description
            .configuration
            .as_ref()
            .and_then(|value| value.get("spec_version"))
            .and_then(Value::as_str),
        Some("0.3.0")
    );
    assert_eq!(description.contracts[0].id, "example.work-item");
    assert_eq!(
        description.contracts.len(),
        1,
        "contracts without an implementation are not application capabilities"
    );
    let serialized = serde_json::to_string(&description).unwrap();
    assert!(!serialized.contains(root.to_string_lossy().as_ref()));
    assert!(!serialized.contains("not-for-apps"));
}

fn mixed_collection() -> (
    tempfile::TempDir,
    tempfile::TempDir,
    CollectionRegistry,
    CollectionSummary,
) {
    let state = tempdir().unwrap();
    let collection_parent = tempdir().unwrap();
    let root = collection_parent.path().join("mixed");
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let collection = registry.create(&root, Some("Mixed"), "UTC").unwrap();
    write_work_item_contract(&root);
    fs::write(
        root.join("_types/task.md"),
        r#"---
kind: mdbase.type
name: task
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    additionalProperties: true
    properties:
      type: { const: task }
      title: { type: string }
implements:
  - contract: example.work-item
    version: 1.0.0
    fields:
      title: title
---
"#,
    )
    .unwrap();
    fs::write(
        root.join("_types/private.md"),
        r#"---
kind: mdbase.type
name: private
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    additionalProperties: true
    properties:
      type: { const: private }
      secret: { type: string }
---
"#,
    )
    .unwrap();
    synchronize_external_fixture(&registry, collection.id);
    for (path, type_name, field, value) in [
        ("tasks/one.md", "task", "title", "Visible"),
        ("private/one.md", "private", "secret", "Hidden"),
    ] {
        let mut frontmatter = json!({"type": type_name});
        frontmatter[field] = json!(value);
        let created = registry
            .operation(
                collection.id,
                "create",
                &json!({
                    "path": path,
                    "type": type_name,
                    "frontmatter": frontmatter,
                    "body": "whole collection body"
                }),
            )
            .unwrap();
        assert_eq!(created["valid"], true, "{created}");
    }
    (state, collection_parent, registry, collection)
}

#[test]
fn canonical_scope_exposes_all_records_types_changes_and_raw_mutations() {
    let (_state, collection_parent, registry, collection) = mixed_collection();
    let scope = GrantScope::full_collection();

    let description = registry
        .scoped_operation(collection.id, "describe", &json!({}), &scope)
        .unwrap();
    assert_eq!(description["types"].as_array().unwrap().len(), 2);

    let query = registry
        .scoped_operation(collection.id, "query", &json!({}), &scope)
        .unwrap();
    assert_eq!(query["result"]["results"].as_array().unwrap().len(), 2);
    let private = registry
        .scoped_operation(
            collection.id,
            "read",
            &json!({"path": "private/one.md"}),
            &scope,
        )
        .unwrap();
    assert_eq!(private["result"]["frontmatter"]["secret"], "Hidden");
    assert_eq!(private["result"]["body"], "whole collection body\n");

    let cursor = registry.changes(collection.id, &json!({})).unwrap().cursor;
    for (path, type_name) in [("tasks/two.md", "task"), ("private/two.md", "private")] {
        registry
            .append_change(
                collection.id,
                &mdbase::watch::WatchEvent {
                    event_type: "mdbase.record.created".to_string(),
                    sequence: 1,
                    occurred_at: "2026-07-20T12:00:00.000Z".to_string(),
                    payload: json!({"path": path, "types": [type_name]}),
                },
            )
            .unwrap();
    }
    let changes = registry
        .scoped_operation(collection.id, "changes", &json!({"after": cursor}), &scope)
        .unwrap();
    assert_eq!(changes["events"].as_array().unwrap().len(), 2);

    let created = registry
        .scoped_operation(
            collection.id,
            "create",
            &json!({
                "path": "private/raw.md",
                "type": "private",
                "frontmatter": {"type": "private", "secret": "Raw"},
                "body": "raw body"
            }),
            &scope,
        )
        .unwrap();
    assert_eq!(created["valid"], true, "{created}");
    assert!(collection_parent
        .path()
        .join("mixed/private/raw.md")
        .exists());
}

#[test]
fn operation_contract_selector_keeps_semantic_filtering_and_projection() {
    let (_state, _collection_parent, registry, collection) = mixed_collection();
    let result = registry
        .scoped_operation(
            collection.id,
            "query",
            &json!({
                "contract": {"id": "example.work-item", "version": "1.0.0"}
            }),
            &GrantScope::full_collection(),
        )
        .unwrap();
    let rows = result["result"]["results"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["path"], "tasks/one.md");
    assert_eq!(rows[0]["frontmatter"], json!({"title": "Visible"}));
    assert_eq!(rows[0]["contract"]["id"], "example.work-item");
    assert!(rows[0].get("body").is_none());
}

#[test]
fn noncanonical_legacy_scopes_are_rejected_without_execution() {
    let (_state, collection_parent, registry, collection) = mixed_collection();
    let contract_scope = work_item_scope(&registry, collection.id);
    let mut full_with_contracts = contract_scope.clone();
    full_with_contracts.access = mdbase_connect_protocol::ApplicationAccess::FullCollection;

    for scope in [&contract_scope, &full_with_contracts] {
        for (operation, input) in [
            ("describe", json!({})),
            ("query", json!({})),
            ("changes", json!({})),
            (
                "create",
                json!({
                    "path": "private/must-not-exist.md",
                    "type": "private",
                    "frontmatter": {"type": "private", "secret": "No"}
                }),
            ),
        ] {
            assert!(matches!(
                registry.scoped_operation(collection.id, operation, &input, scope),
                Err(ConnectError::AccessDenied(message)) if message.contains("canonical full-collection")
            ));
        }
    }
    assert!(!collection_parent
        .path()
        .join("mixed/private/must-not-exist.md")
        .exists());
}

#[test]
fn policy_ingestion_and_persisted_grants_reject_noncanonical_scope() {
    let state = tempdir().unwrap();
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let canonical = signed_test_grant(&registry, vec!["query".to_string()]);
    registry.replace_grants(&[canonical.clone()]).unwrap();

    let legacy_scope = unavailable_contract_scope();
    let encoded_scope = serde_json::to_string(&legacy_scope).unwrap();
    let grant_id = canonical.id.to_string();
    registry
        .authority
        .write(AuthorityWritePriority::Control, move |connection| {
            connection.execute(
                "UPDATE grants SET scope = ?1 WHERE id = ?2",
                params![encoded_scope, grant_id],
            )?;
            Ok(())
        })
        .unwrap();
    assert!(matches!(
        registry.list_grants(),
        Err(ConnectError::AccessDenied(message)) if message.contains("canonical full-collection")
    ));

    let second_state = tempdir().unwrap();
    let second_registry = CollectionRegistry::open(second_state.path()).unwrap();
    let mut grant = signed_test_grant(&second_registry, vec!["query".to_string()]);
    grant.scope = legacy_scope;
    assert!(matches!(
        second_registry.replace_grants(&[grant.clone()]),
        Err(ConnectError::InvalidInput(message)) if message.contains("full_collection")
    ));

    grant.scope.access = mdbase_connect_protocol::ApplicationAccess::FullCollection;
    assert!(matches!(
        second_registry.replace_grants(&[grant]),
        Err(ConnectError::InvalidInput(message)) if message.contains("empty contract set")
    ));
    assert!(second_registry.list_grants().unwrap().is_empty());
}
