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
name: task
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

    let description = registry.describe(collection.id).unwrap();
    assert_eq!(description.protocol_version, 1);
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

#[test]
fn contract_scope_confines_description_queries_records_and_changes() {
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
    for (path, type_name, field, value) in [
        ("tasks/one.md", "task", "title", "Visible"),
        ("private/one.md", "private", "secret", "Hidden"),
    ] {
        let mut frontmatter = json!({ "type": type_name, field: value });
        if type_name == "task" {
            frontmatter["unmapped_secret"] = json!("must never cross the grant");
        }
        let created = registry
            .operation(
                collection.id,
                "create",
                &json!({
                    "path": path,
                    "type": type_name,
                    "frontmatter": frontmatter,
                    "body": "private body"
                }),
            )
            .unwrap();
        assert_eq!(created["valid"], true, "{created}");
    }
    let scope = work_item_scope(&registry, collection.id);

    let empty_contract_scope = GrantScope {
        contracts: vec![],
        access: mdbase_connect_protocol::ApplicationAccess::Contract,
    };
    assert!(matches!(
        registry.scoped_operation(
            collection.id,
            "query",
            &json!({}),
            &empty_contract_scope
        ),
        Err(ConnectError::AccessDenied(message)) if message.contains("at least one")
    ));
    let full_scope = GrantScope::full_collection();
    let full_query = registry
        .scoped_operation(collection.id, "query", &json!({}), &full_scope)
        .unwrap();
    assert_eq!(full_query["result"]["results"].as_array().unwrap().len(), 2);
    let portable_full_query = registry
        .scoped_operation(
            collection.id,
            "query",
            &json!({
                "contract": {
                    "id": "example.work-item",
                    "version": "1.0.0"
                }
            }),
            &full_scope,
        )
        .unwrap();
    assert_eq!(
        portable_full_query["result"]["results"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        portable_full_query["result"]["results"][0]["frontmatter"],
        json!({ "title": "Visible" })
    );
    assert_eq!(
        portable_full_query["result"]["results"][0]["contract"]["id"],
        "example.work-item"
    );

    assert!(registry
        .is_compatible(
            collection.id,
            &ApplicationRequirements {
                contracts: scope
                    .contracts
                    .iter()
                    .map(|contract| ContractRequirement {
                        id: contract.id.clone(),
                        version: contract.version.clone(),
                        digest: contract.digest.clone(),
                    })
                    .collect(),
                ..Default::default()
            }
        )
        .unwrap());
    let description = registry
        .scoped_operation(collection.id, "describe", &json!({}), &scope)
        .unwrap();
    assert_eq!(description["types"].as_array().unwrap().len(), 1);
    assert_eq!(description["types"][0]["name"], "task");

    let query = registry
        .scoped_operation(collection.id, "query", &json!({}), &scope)
        .unwrap();
    assert_eq!(query["result"]["results"].as_array().unwrap().len(), 1);
    assert_eq!(query["result"]["results"][0]["path"], "tasks/one.md");
    assert_eq!(
        query["result"]["results"][0]["frontmatter"],
        json!({ "title": "Visible" })
    );
    assert_eq!(
        query["result"]["results"][0]["contract"]["id"],
        "example.work-item"
    );
    assert!(query["result"]["results"][0].get("body").is_none());
    assert!(query["result"]["results"][0]["frontmatter"]
        .get("unmapped_secret")
        .is_none());
    let read = registry
        .scoped_operation(
            collection.id,
            "read",
            &json!({ "path": "tasks/one.md" }),
            &scope,
        )
        .unwrap();
    assert_eq!(read["result"]["frontmatter"], json!({ "title": "Visible" }));
    assert!(read["result"].get("body").is_none());
    assert!(matches!(
        registry.scoped_operation(
            collection.id,
            "read",
            &json!({ "path": "private/one.md" }),
            &scope
        ),
        Err(ConnectError::AccessDenied(_))
    ));
    assert!(matches!(
        registry.scoped_operation(collection.id, "list_views", &json!({}), &scope),
        Err(ConnectError::AccessDenied(_))
    ));
    assert!(matches!(
        registry.scoped_operation(
            collection.id,
            "execute_view",
            &json!({ "path": "views/tasks.md", "view": "all" }),
            &scope
        ),
        Err(ConnectError::AccessDenied(_))
    ));
    assert!(matches!(
        registry.scoped_operation(
            collection.id,
            "query",
            &json!({ "types": ["private"] }),
            &scope
        ),
        Err(ConnectError::AccessDenied(_))
    ));
    assert!(matches!(
        registry.scoped_operation(
            collection.id,
            "query",
            &json!({ "where": "related.asFile().secret == 'Hidden'" }),
            &scope
        ),
        Err(ConnectError::AccessDenied(_))
    ));

    assert!(matches!(
        registry.scoped_operation(
            collection.id,
            "create",
            &json!({
                "path": "private/forged.md",
                "type": "task",
                "frontmatter": { "type": "private", "secret": "Forged" }
            }),
            &scope
        ),
        Err(ConnectError::AccessDenied(_))
    ));
    assert!(!root.join("private/forged.md").exists());

    assert!(matches!(
        registry.scoped_operation(
            collection.id,
            "update",
            &json!({ "path": "tasks/one.md", "patch": { "type": "private" } }),
            &scope
        ),
        Err(ConnectError::AccessDenied(_))
    ));
    let unchanged = registry
        .operation(collection.id, "read", &json!({ "path": "tasks/one.md" }))
        .unwrap();
    assert_eq!(unchanged["result"]["frontmatter"]["type"], "task");
    assert!(matches!(
        registry.scoped_operation(
            collection.id,
            "update",
            &json!({
                "path": "tasks/one.md",
                "document": "---\ntype: private\nsecret: Forged from source\n---\n"
            }),
            &scope
        ),
        Err(ConnectError::AccessDenied(_))
    ));
    let unchanged = registry
        .operation(collection.id, "read", &json!({ "path": "tasks/one.md" }))
        .unwrap();
    assert_eq!(unchanged["result"]["frontmatter"]["type"], "task");
    assert!(matches!(
        registry.scoped_operation(
            collection.id,
            "update",
            &json!({
                "path": "tasks/one.md",
                "patch": { "types": ["task", "private"] }
            }),
            &scope
        ),
        Err(ConnectError::AccessDenied(_))
    ));

    for (path, type_name) in [
        ("tasks/changed.md", "task"),
        ("private/changed.md", "private"),
    ] {
        registry
            .append_change(
                collection.id,
                &mdbase::watch::WatchEvent {
                    event_type: "mdbase.record.created".to_string(),
                    sequence: 1,
                    occurred_at: "2026-07-20T12:00:00.000Z".to_string(),
                    payload: json!({ "path": path, "types": [type_name] }),
                },
            )
            .unwrap();
    }
    registry
        .append_change(
            collection.id,
            &mdbase::watch::WatchEvent {
                event_type: "mdbase.record.modified".to_string(),
                sequence: 2,
                occurred_at: "2026-07-20T12:00:01.000Z".to_string(),
                payload: json!({
                    "path": "tasks/no-longer-a-task.md",
                    "previous_types": ["task"],
                    "types": ["private"]
                }),
            },
        )
        .unwrap();
    let changes = registry
        .scoped_operation(collection.id, "changes", &json!({ "after": 0 }), &scope)
        .unwrap();
    assert_eq!(changes["events"].as_array().unwrap().len(), 2);
    assert_eq!(changes["events"][0]["payload"]["path"], "tasks/changed.md");
}

#[test]
fn contract_scope_unions_pinned_providers_and_rejects_provider_drift() {
    let state = tempdir().unwrap();
    let collection_parent = tempdir().unwrap();
    let root = collection_parent.path().join("multiple-providers");
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let collection = registry
        .create(&root, Some("Multiple providers"), "UTC")
        .unwrap();
    write_work_item_contract(&root);

    for (name, title_field) in [("task", "title"), ("action", "summary")] {
        fs::write(
            root.join(format!("_types/{name}.md")),
            format!(
                r#"---
kind: mdbase.type
name: {name}
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    additionalProperties: true
    properties:
      {title_field}: {{ type: string }}
implements:
  - contract: example.work-item
    version: 1.0.0
    fields:
      title: {title_field}
---
"#
            ),
        )
        .unwrap();
    }
    for (path, type_name, field) in [
        ("tasks/one.md", "task", "title"),
        ("actions/one.md", "action", "summary"),
    ] {
        let created = registry
            .operation(
                collection.id,
                "create",
                &json!({
                    "path": path,
                    "type": type_name,
                    "frontmatter": { field: "Visible" }
                }),
            )
            .unwrap();
        assert_eq!(created["valid"], true, "{created}");
    }

    let scope = work_item_scope(&registry, collection.id);
    assert_eq!(
        scope.contracts[0]
            .implementations
            .iter()
            .map(|implementation| implementation.type_name.as_str())
            .collect::<Vec<_>>(),
        ["action", "task"]
    );
    let query = registry
        .scoped_operation(collection.id, "query", &json!({}), &scope)
        .unwrap();
    assert_eq!(query["result"]["results"].as_array().unwrap().len(), 2);
    assert_eq!(
        query["result"]["results"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["frontmatter"]["title"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["Visible", "Visible"]
    );

    let created = registry
        .scoped_operation(
            collection.id,
            "create",
            &json!({
                "path": "actions/two.md",
                "type": "action",
                "contract": {
                    "id": "example.work-item",
                    "version": "1.0.0",
                    "type": "action"
                },
                "frontmatter": { "title": "Created through the contract" }
            }),
            &scope,
        )
        .unwrap();
    assert_eq!(
        created["result"]["frontmatter"],
        json!({ "title": "Created through the contract" })
    );
    let raw = registry
        .operation(collection.id, "read", &json!({ "path": "actions/two.md" }))
        .unwrap();
    assert_eq!(
        raw["result"]["frontmatter"]["summary"],
        "Created through the contract"
    );
    assert!(raw["result"]["frontmatter"].get("title").is_none());

    let updated = registry
        .scoped_operation(
            collection.id,
            "update",
            &json!({
                "path": "actions/two.md",
                "contract": {
                    "id": "example.work-item",
                    "version": "1.0.0",
                    "type": "action"
                },
                "patch": { "title": "Updated through the contract" }
            }),
            &scope,
        )
        .unwrap();
    assert_eq!(
        updated["result"]["frontmatter"]["title"],
        "Updated through the contract"
    );
    let raw = registry
        .operation(collection.id, "read", &json!({ "path": "actions/two.md" }))
        .unwrap();
    assert_eq!(
        raw["result"]["frontmatter"]["summary"],
        "Updated through the contract"
    );

    fs::write(
        root.join("_types/todo.md"),
        r#"---
kind: mdbase.type
name: todo
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    additionalProperties: true
    properties:
      label: { type: string }
implements:
  - contract: example.work-item
    version: 1.0.0
    fields:
      title: label
---
"#,
    )
    .unwrap();

    assert!(matches!(
        registry.scoped_operation(collection.id, "query", &json!({}), &scope),
        Err(ConnectError::AccessDenied(message)) if message.contains("changed")
    ));
}
