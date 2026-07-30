
use super::*;
use std::sync::{Arc, Barrier};
use std::thread;
use tempfile::tempdir;

fn mark_mirror(root: &Path, collection_id: Uuid) {
    let directory = root.join(MIRROR_MARKER_DIRECTORY);
    fs::create_dir_all(&directory).unwrap();
    fs::write(
        directory.join(MIRROR_MARKER_FILE),
        serde_json::to_vec_pretty(&json!({
            "version": 1,
            "role": "mirror",
            "collection_id": collection_id,
        }))
        .unwrap(),
    )
    .unwrap();
}

fn write_work_item_contract(root: &Path) {
    fs::write(
        root.join("_contracts/example.work-item.md"),
        r#"---
kind: mdbase.contract
contract_type: record
id: example.work-item
version: 1.0.0
record_schema:
  dialect: json-schema-2020-12
  value:
    type: object
    required: [title]
    additionalProperties: false
    properties:
      title: { type: string }
      status: { type: string }
---
"#,
    )
    .unwrap();
}

fn work_item_scope(registry: &CollectionRegistry, collection_id: Uuid) -> GrantScope {
    let description = registry.describe(collection_id).unwrap();
    let contract = description
        .contracts
        .into_iter()
        .find(|contract| contract.id == "example.work-item")
        .expect("example.work-item is advertised");
    GrantScope {
        contracts: vec![contract],
        access: mdbase_connect_protocol::ApplicationAccess::Contract,
    }
}

fn unavailable_contract_scope() -> GrantScope {
    GrantScope {
        contracts: vec![CollectionContractDescriptor {
            contract_type: "record".to_string(),
            id: "some.app".to_string(),
            version: "1.0.0".to_string(),
            digest: format!("sha256:{}", "0".repeat(64)),
            schema: json!({"type": "object"}),
            binding_schema: None,
            implementations: Vec::new(),
        }],
        access: mdbase_connect_protocol::ApplicationAccess::Contract,
    }
}

#[test]
fn portable_mutation_results_produce_targeted_invalidations() {
    let output = serde_json::to_value(mdbase::v03::OperationResult {
        valid: true,
        result: json!({
            "from": "old.md",
            "to": "new.md",
            "references_updated": [{"path": "linked.md"}],
        }),
        diagnostics: vec![],
    })
    .unwrap();
    assert_eq!(
        operation_invalidation(
            "rename",
            &json!({"from": "old.md", "to": "new.md"}),
            &output,
        ),
        CollectionInvalidation::Records(
            ["linked.md", "new.md", "old.md"]
                .into_iter()
                .map(str::to_string)
                .collect()
        )
    );
    assert_eq!(
        operation_invalidation(
            "update",
            &json!({"path": "private.md"}),
            &json!({"valid": false}),
        ),
        CollectionInvalidation::None,
    );
    assert_eq!(
        operation_invalidation(
            "rename",
            &json!({"from": "old.md", "to": "new.md", "dry_run": true}),
            &json!({"valid": true, "result": {"would_rename": true}}),
        ),
        CollectionInvalidation::None,
    );
    assert_eq!(
        operation_invalidation("update_type", &json!({}), &json!({"valid": true})),
        CollectionInvalidation::All,
    );
}

#[test]
fn create_register_list_and_remove_collection() {
    let state = tempdir().unwrap();
    let collection_parent = tempdir().unwrap();
    let root = collection_parent.path().join("workouts");
    let registry = CollectionRegistry::open(state.path()).unwrap();

    let created = registry.create(&root, Some("Workouts")).unwrap();
    assert_eq!(created.display_name, "Workouts");
    assert_eq!(created.spec_version, "0.3.0");
    assert!(root.join("mdbase.yaml").exists());
    assert!(root.join("_types").is_dir());

    let listed = registry.list().unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, created.id);

    let removed = registry.remove(created.id).unwrap();
    assert_eq!(removed.id, created.id);
    assert!(
        root.exists(),
        "unregistering must not delete collection files"
    );
    assert!(registry.list().unwrap().is_empty());
}

#[test]
fn mirror_cannot_be_registered_as_an_authority() {
    let state = tempdir().unwrap();
    let collection_parent = tempdir().unwrap();
    let root = collection_parent.path().join("mirror");
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let collection_id = Uuid::new_v4();

    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("mdbase.yaml"), "spec_version: 0.3.0\n").unwrap();
    mark_mirror(&root, collection_id);

    assert!(matches!(
        registry.add(&root),
        Err(ConnectError::MirrorCannotRegister { collection_id: actual })
            if actual == collection_id
    ));
    assert_eq!(read_collection_id(&root).unwrap(), None);
    assert!(registry.list().unwrap().is_empty());
}

#[test]
fn verified_mirror_authority_activation_is_idempotent_and_reversible() {
    let state = tempdir().unwrap();
    let collection_parent = tempdir().unwrap();
    let root = collection_parent.path().join("mirror");
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let collection_id = Uuid::new_v4();
    fs::create_dir_all(&root).unwrap();
    fs::write(
        root.join("mdbase.yaml"),
        "spec_version: 0.3.0\nname: Promoted\n",
    )
    .unwrap();
    mark_mirror(&root, collection_id);

    let promoted = registry
        .activate_mirror_authority(&root, collection_id)
        .unwrap();
    assert_eq!(promoted.id, collection_id);
    assert!(promoted.enabled);
    assert_eq!(collection_identity(&root).unwrap(), Some(collection_id));
    assert_eq!(mirror_collection_id(&root).unwrap(), None);
    assert_eq!(
        registry
            .activate_mirror_authority(&root, collection_id)
            .unwrap()
            .id,
        collection_id
    );

    registry
        .rollback_mirror_authority(&root, collection_id, false, false)
        .unwrap();
    assert!(registry.list().unwrap().is_empty());
    assert_eq!(collection_identity(&root).unwrap(), None);
    assert_eq!(mirror_collection_id(&root).unwrap(), Some(collection_id));
}

#[test]
fn authority_activation_refuses_a_different_mirror_identity_without_changes() {
    let state = tempdir().unwrap();
    let collection_parent = tempdir().unwrap();
    let root = collection_parent.path().join("mirror");
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let marker_id = Uuid::new_v4();
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("mdbase.yaml"), "spec_version: 0.3.0\n").unwrap();
    mark_mirror(&root, marker_id);

    let error = registry
        .activate_mirror_authority(&root, Uuid::new_v4())
        .unwrap_err();
    assert_eq!(error.code(), "invalid_mirror_marker");
    assert_eq!(mirror_collection_id(&root).unwrap(), Some(marker_id));
    assert_eq!(collection_identity(&root).unwrap(), None);
    assert!(registry.list().unwrap().is_empty());
}

#[test]
fn authority_rollback_restores_a_retired_local_registration() {
    let state = tempdir().unwrap();
    let collection_parent = tempdir().unwrap();
    let root = collection_parent.path().join("notes");
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let created = registry.create(&root, Some("Notes")).unwrap();
    registry.set_enabled(created.id, false).unwrap();
    mark_mirror(&root, created.id);

    assert!(
        registry
            .activate_mirror_authority(&root, created.id)
            .unwrap()
            .enabled
    );
    registry
        .rollback_mirror_authority(&root, created.id, true, true)
        .unwrap();

    let restored = registry.get(created.id).unwrap();
    assert!(!restored.enabled);
    assert_eq!(restored.path, root.to_string_lossy());
    assert_eq!(collection_identity(&root).unwrap(), Some(created.id));
    assert_eq!(mirror_collection_id(&root).unwrap(), Some(created.id));
}

#[test]
fn a_registered_folder_stops_being_available_when_it_becomes_a_mirror() {
    let state = tempdir().unwrap();
    let collection_parent = tempdir().unwrap();
    let root = collection_parent.path().join("notes");
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let created = registry.create(&root, Some("Notes")).unwrap();
    let mirror_collection_id = Uuid::new_v4();

    mark_mirror(&root, mirror_collection_id);

    assert!(!registry.get(created.id).unwrap().enabled);
    assert!(!registry.list().unwrap()[0].enabled);
    assert!(matches!(
        registry.operation(created.id, "describe", &json!({})),
        Err(ConnectError::MirrorCannotRegister { collection_id })
            if collection_id == mirror_collection_id
    ));
    assert!(matches!(
        registry.set_enabled(created.id, true),
        Err(ConnectError::MirrorCannotRegister { collection_id })
            if collection_id == mirror_collection_id
    ));
}

#[test]
fn a_malformed_mirror_marker_fails_closed() {
    let state = tempdir().unwrap();
    let collection_parent = tempdir().unwrap();
    let root = collection_parent.path().join("mirror");
    let registry = CollectionRegistry::open(state.path()).unwrap();

    fs::create_dir_all(root.join(MIRROR_MARKER_DIRECTORY)).unwrap();
    fs::write(root.join("mdbase.yaml"), "spec_version: 0.3.0\n").unwrap();
    fs::write(
        root.join(MIRROR_MARKER_DIRECTORY).join(MIRROR_MARKER_FILE),
        "{broken",
    )
    .unwrap();

    assert!(matches!(
        registry.add(&root),
        Err(ConnectError::InvalidMirrorMarker(_))
    ));
    assert!(registry.list().unwrap().is_empty());
}

#[test]
fn authority_transfer_fence_is_durable_exclusive_and_idempotent() {
    let state = tempdir().unwrap();
    let collection_parent = tempdir().unwrap();
    let root = collection_parent.path().join("transfer");
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let collection = registry.create(&root, Some("Transfer")).unwrap();
    fs::write(
        root.join("one.md"),
        "---\ntitle: One\n---\nOriginal body.\n",
    )
    .unwrap();

    let first = registry.authority_snapshot(collection.id).unwrap();
    assert_eq!(first.collection_id, collection.id);
    assert_eq!(first.records.len(), 1);
    assert_eq!(first.resources.documents[0].path, "mdbase.yaml");
    assert_eq!(first.manifest_digest.len(), 64);
    let record_id = first.records[0].record.record_id;

    fs::rename(root.join("one.md"), root.join("renamed.md")).unwrap();
    let renamed = registry.authority_snapshot(collection.id).unwrap();
    assert_eq!(renamed.records[0].record.record_id, record_id);
    assert_eq!(renamed.records[0].record.path, "renamed.md");
    assert_eq!(
        renamed.records[0].document,
        fs::read_to_string(root.join("renamed.md")).unwrap()
    );

    let transfer_id = Uuid::new_v4();
    let fenced = registry
        .fence_authority(collection.id, transfer_id)
        .unwrap();
    assert_eq!(fenced.manifest_digest, renamed.manifest_digest);
    assert!(registry
        .operation(collection.id, "describe", &json!({}))
        .is_ok());
    for result in [
        registry.operation(
            collection.id,
            "create",
            &json!({
                "path": "blocked.md",
                "frontmatter": {"title": "Blocked"},
            }),
        ),
        registry
            .update_metadata(collection.id, "Blocked", None)
            .map(|value| serde_json::to_value(value).unwrap()),
        registry
            .set_enabled(collection.id, false)
            .map(|value| serde_json::to_value(value).unwrap()),
        registry
            .make_independent(collection.id)
            .map(|value| serde_json::to_value(value).unwrap()),
        registry
            .remove(collection.id)
            .map(|value| serde_json::to_value(value).unwrap()),
    ] {
        assert!(matches!(
            result,
            Err(ConnectError::AuthorityTransferInProgress {
                transfer_id: actual
            }) if actual == transfer_id
        ));
    }
    let full_scope = GrantScope::full_collection();
    assert!(matches!(
        registry.scoped_operation(
            collection.id,
            "create",
            &json!({
                "path": "scoped-blocked.md",
                "frontmatter": {"title": "Scoped blocked"},
            }),
            &full_scope,
        ),
        Err(ConnectError::AuthorityTransferInProgress {
            transfer_id: actual
        }) if actual == transfer_id
    ));
    assert!(matches!(
        registry.sync_operation_synchronized(
            collection.id,
            &json!({"action": "mutate"}),
            crate::LocalReplica {
                id: Uuid::new_v4(),
                name: "Test replica".to_string(),
                mode: mdbase_connect_protocol::SyncReplicaMode::ReadWrite,
                allowed_types: BTreeSet::new(),
            },
            &full_scope,
            |_| {},
        ),
        Err(ConnectError::AuthorityTransferInProgress {
            transfer_id: actual
        }) if actual == transfer_id
    ));
    assert!(!root.join("blocked.md").exists());
    assert!(matches!(
        registry.resume_authority(collection.id, Uuid::new_v4()),
        Err(ConnectError::AuthorityTransferMismatch)
    ));

    drop(registry);
    let reopened = CollectionRegistry::open(state.path()).unwrap();
    assert!(matches!(
        reopened.operation(
            collection.id,
            "create",
            &json!({
                "path": "still-blocked.md",
                "frontmatter": {"title": "Still blocked"},
            }),
        ),
        Err(ConnectError::AuthorityTransferInProgress {
            transfer_id: actual
        }) if actual == transfer_id
    ));
    reopened
        .resume_authority(collection.id, transfer_id)
        .unwrap();
    let resumed = reopened
        .operation(
            collection.id,
            "create",
            &json!({
                "path": "resumed.md",
                "frontmatter": {"title": "Resumed"},
            }),
        )
        .unwrap();
    assert_eq!(resumed["valid"], true, "{resumed}");

    let final_transfer_id = Uuid::new_v4();
    reopened
        .fence_authority(collection.id, final_transfer_id)
        .unwrap();
    reopened
        .retire_authority(collection.id, final_transfer_id, 2)
        .unwrap();
    reopened
        .retire_authority(collection.id, final_transfer_id, 2)
        .unwrap();
    assert!(!reopened.get(collection.id).unwrap().enabled);
    let marker: Value =
        serde_json::from_str(&fs::read_to_string(root.join(".mdbase/connect-role.json")).unwrap())
            .unwrap();
    assert_eq!(marker["role"], "mirror");
    assert_eq!(marker["collection_id"], collection.id.to_string());
    assert!(matches!(
        reopened.set_enabled(collection.id, true),
        Err(ConnectError::MirrorCannotRegister {
            collection_id: actual
        }) if actual == collection.id
    ));
}

#[cfg(unix)]
#[test]
fn a_symlinked_mirror_marker_fails_closed() {
    use std::os::unix::fs::symlink;

    let state = tempdir().unwrap();
    let collection_parent = tempdir().unwrap();
    let outside = tempdir().unwrap();
    let root = collection_parent.path().join("mirror");
    let registry = CollectionRegistry::open(state.path()).unwrap();

    fs::create_dir_all(root.join(MIRROR_MARKER_DIRECTORY)).unwrap();
    fs::write(root.join("mdbase.yaml"), "spec_version: 0.3.0\n").unwrap();
    let target = outside.path().join(MIRROR_MARKER_FILE);
    fs::write(
        &target,
        serde_json::to_vec(&json!({
            "version": 1,
            "role": "mirror",
            "collection_id": Uuid::new_v4(),
        }))
        .unwrap(),
    )
    .unwrap();
    symlink(
        &target,
        root.join(MIRROR_MARKER_DIRECTORY).join(MIRROR_MARKER_FILE),
    )
    .unwrap();

    assert!(matches!(
        registry.add(&root),
        Err(ConnectError::InvalidMirrorMarker(_))
    ));
    assert!(registry.list().unwrap().is_empty());
}

#[test]
fn collection_identity_survives_a_folder_move() {
    let state = tempdir().unwrap();
    let collection_parent = tempdir().unwrap();
    let original = collection_parent.path().join("notes");
    let moved = collection_parent.path().join("archive");
    let registry = CollectionRegistry::open(state.path()).unwrap();

    let created = registry.create(&original, Some("Notes")).unwrap();
    let config: serde_yaml::Value =
        serde_yaml::from_str(&fs::read_to_string(original.join("mdbase.yaml")).unwrap()).unwrap();
    assert_eq!(
        config[CONNECT_EXTENSION][CONNECT_COLLECTION_ID],
        created.id.to_string()
    );

    fs::rename(&original, &moved).unwrap();
    let registered_after_move = registry.add(&moved).unwrap();

    assert_eq!(registered_after_move.id, created.id);
    assert_eq!(
        Path::new(&registered_after_move.path),
        moved.canonicalize().unwrap()
    );
    assert_eq!(registry.list().unwrap().len(), 1);
}

#[test]
fn copied_collection_identity_is_rejected_while_the_original_is_registered() {
    let state = tempdir().unwrap();
    let collection_parent = tempdir().unwrap();
    let original = collection_parent.path().join("notes");
    let copy = collection_parent.path().join("notes-copy");
    let registry = CollectionRegistry::open(state.path()).unwrap();

    let created = registry.create(&original, Some("Notes")).unwrap();
    fs::create_dir_all(&copy).unwrap();
    fs::copy(original.join("mdbase.yaml"), copy.join("mdbase.yaml")).unwrap();
    fs::create_dir_all(copy.join("_types")).unwrap();

    assert!(matches!(
        registry.add(&copy),
        Err(ConnectError::DuplicateCollectionIdentity {
            collection_id,
            existing_path,
        }) if collection_id == created.id
            && Path::new(&existing_path) == original.canonicalize().unwrap()
    ));
}

#[test]
fn copied_collection_can_be_registered_with_a_new_identity() {
    let state = tempdir().unwrap();
    let collection_parent = tempdir().unwrap();
    let original = collection_parent.path().join("notes");
    let copy = collection_parent.path().join("notes-copy");
    let registry = CollectionRegistry::open(state.path()).unwrap();

    let created = registry.create(&original, Some("Notes")).unwrap();
    fs::create_dir_all(&copy).unwrap();
    fs::copy(original.join("mdbase.yaml"), copy.join("mdbase.yaml")).unwrap();
    fs::create_dir_all(copy.join("_types")).unwrap();

    let registered_copy = registry.add_copy(&copy).unwrap();
    assert_ne!(registered_copy.id, created.id);
    assert_eq!(registry.get(created.id).unwrap().id, created.id);
    assert_eq!(
        read_collection_id(&original).unwrap(),
        Some(created.id),
        "registering the copy must never rewrite the original"
    );
    assert_eq!(read_collection_id(&copy).unwrap(), Some(registered_copy.id));
    assert_eq!(registry.list().unwrap().len(), 2);
}

#[test]
fn new_identity_command_refuses_the_registered_original() {
    let state = tempdir().unwrap();
    let collection_parent = tempdir().unwrap();
    let original = collection_parent.path().join("notes");
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let created = registry.create(&original, Some("Notes")).unwrap();

    assert!(matches!(
        registry.add_copy(&original),
        Err(ConnectError::NotARegisteredCollectionCopy(message))
            if message.contains("registered original")
    ));
    assert_eq!(read_collection_id(&original).unwrap(), Some(created.id));
}

#[test]
fn registered_conflict_can_become_independent_without_moving_files() {
    let state = tempdir().unwrap();
    let collection_parent = tempdir().unwrap();
    let root = collection_parent.path().join("notes");
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let created = registry.create(&root, Some("Notes")).unwrap();

    let independent = registry.make_independent(created.id).unwrap();

    assert_ne!(independent.id, created.id);
    assert_eq!(independent.path, created.path);
    assert_eq!(read_collection_id(&root).unwrap(), Some(independent.id));
    assert!(matches!(
        registry.get(created.id),
        Err(ConnectError::CollectionNotFound(id)) if id == created.id
    ));
    assert_eq!(registry.list().unwrap().len(), 1);
}

#[test]
fn inventory_revisions_are_monotonic_across_registry_restarts() {
    let state = tempdir().unwrap();
    let registry = CollectionRegistry::open(state.path()).unwrap();
    assert_eq!(registry.next_inventory_revision().unwrap(), 1);
    assert_eq!(registry.next_inventory_revision().unwrap(), 2);
    drop(registry);

    let reopened = CollectionRegistry::open(state.path()).unwrap();
    assert_eq!(reopened.next_inventory_revision().unwrap(), 3);
}

#[test]
fn collection_metadata_refreshes_edits_and_disabled_collections_fail_closed() {
    let state = tempdir().unwrap();
    let collection_parent = tempdir().unwrap();
    let root = collection_parent.path().join("notes");
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let created = registry.create(&root, Some("Notes")).unwrap();
    assert_eq!(created.description, None);

    let config_path = root.join("mdbase.yaml");
    let mut config: serde_yaml::Value =
        serde_yaml::from_str(&fs::read_to_string(&config_path).unwrap()).unwrap();
    let mapping = config.as_mapping_mut().unwrap();
    mapping.insert(
        serde_yaml::Value::String("name".to_string()),
        serde_yaml::Value::String("External name".to_string()),
    );
    mapping.insert(
        serde_yaml::Value::String("description".to_string()),
        serde_yaml::Value::String("Changed outside the app".to_string()),
    );
    mapping.insert(
        serde_yaml::Value::String("x-preview".to_string()),
        serde_yaml::from_str("{ keep: true }").unwrap(),
    );
    fs::write(&config_path, serde_yaml::to_string(&config).unwrap()).unwrap();

    let refreshed = registry.list().unwrap().remove(0);
    assert_eq!(refreshed.display_name, "External name");
    assert_eq!(
        refreshed.description.as_deref(),
        Some("Changed outside the app")
    );

    let updated = registry
        .update_metadata(created.id, "Edited safely", Some("A useful collection"))
        .unwrap();
    assert_eq!(updated.display_name, "Edited safely");
    assert_eq!(updated.description.as_deref(), Some("A useful collection"));
    let persisted: serde_yaml::Value =
        serde_yaml::from_str(&fs::read_to_string(&config_path).unwrap()).unwrap();
    assert_eq!(persisted["x-preview"]["keep"], true);

    let disabled = registry.set_enabled(created.id, false).unwrap();
    assert!(!disabled.enabled);
    assert!(matches!(
        registry.scoped_operation(
            created.id,
            "describe",
            &json!({}),
            &GrantScope {
                contracts: vec![],
                access: mdbase_connect_protocol::ApplicationAccess::FullCollection,
            }
        ),
        Err(ConnectError::AccessDenied(message)) if message.contains("disabled")
    ));
}

#[test]
fn generic_operation_uses_v03_envelope() {
    let state = tempdir().unwrap();
    let collection_parent = tempdir().unwrap();
    let root = collection_parent.path().join("notes");
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let collection = registry.create(&root, Some("Notes")).unwrap();

    let result = registry
        .operation(
            collection.id,
            "create",
            &json!({
                "path": "hello.md",
                "frontmatter": { "title": "Hello" },
                "body": "World"
            }),
        )
        .unwrap();
    assert_eq!(result["valid"], true);
    assert!(result["result"]["revision"].as_str().is_some());
    for field in [
        "path",
        "revision",
        "types",
        "frontmatter",
        "effective_frontmatter",
        "body",
        "file",
    ] {
        assert!(
            result["result"].get(field).is_some(),
            "create omitted {field}: {result:#}"
        );
    }

    let read = registry
        .operation(collection.id, "read", &json!({ "path": "hello.md" }))
        .unwrap();
    assert_eq!(read["valid"], true);
    assert_eq!(read["result"]["frontmatter"]["title"], "Hello");
    assert_eq!(read["result"]["effective_frontmatter"]["title"], "Hello");

    let update = registry
        .operation(
            collection.id,
            "update",
            &json!({ "path": "hello.md", "patch": { "status": "done" } }),
        )
        .unwrap();
    assert_eq!(update["valid"], true);
    assert_eq!(update["result"]["frontmatter"]["status"], "done");
    assert_eq!(update["result"]["effective_frontmatter"]["status"], "done");
    assert_eq!(update["result"]["file"]["name"], "hello.md");
}

#[test]
fn legacy_description_only_advertises_executable_operations() {
    let state = tempdir().unwrap();
    let collection_parent = tempdir().unwrap();
    let root = collection_parent.path().join("legacy");
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("mdbase.yaml"), "spec_version: 0.2.1\n").unwrap();
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let collection = registry.add(&root).unwrap();

    let description = registry.describe(collection.id).unwrap();

    assert!(description.operations.contains(&"read".to_string()));
    assert!(description.operations.contains(&"query".to_string()));
    assert!(description.operations.contains(&"validate".to_string()));
    for operation in ["create", "update", "delete", "rename"] {
        assert!(!description.operations.contains(&operation.to_string()));
    }
    assert!(!description.operations.contains(&"read_type".to_string()));
}

#[test]
fn legacy_records_are_read_only_until_explicit_migration() {
    let state = tempdir().unwrap();
    let collection_parent = tempdir().unwrap();
    let root = collection_parent.path().join("legacy");
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("mdbase.yaml"), "spec_version: 0.2.1\n").unwrap();
    let document = "---\ntitle: Legacy\n---\nBody\n";
    fs::write(root.join("legacy.md"), document).unwrap();
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let collection = registry.add(&root).unwrap();

    let read = registry
        .operation(collection.id, "read", &json!({"path": "legacy.md"}))
        .unwrap();
    assert_eq!(read["valid"], true, "{read}");
    assert_eq!(read["result"]["frontmatter"]["title"], "Legacy");

    let query = registry
        .operation(
            collection.id,
            "query",
            &json!({"where": "title == 'Legacy'", "include_body": true}),
        )
        .unwrap();
    assert_eq!(query["valid"], true, "{query}");
    assert_eq!(query["result"]["results"].as_array().unwrap().len(), 1);
    assert_eq!(query["result"]["results"][0]["body"], "Body\n");

    let unsupported_query = registry
        .operation(collection.id, "query", &json!({"folder": "private"}))
        .unwrap();
    assert_eq!(unsupported_query["valid"], false, "{unsupported_query}");
    assert_eq!(
        unsupported_query["diagnostics"][0]["code"],
        "invalid_request"
    );

    let operations = [
        (
            "create",
            json!({
                "path": "new.md",
                "frontmatter": {"title": "New"},
                "body": ""
            }),
        ),
        (
            "update",
            json!({"path": "legacy.md", "patch": {"title": "Changed"}}),
        ),
        ("delete", json!({"path": "legacy.md"})),
        ("rename", json!({"from": "legacy.md", "to": "renamed.md"})),
    ];
    for (operation, input) in operations {
        let result = registry
            .operation(collection.id, operation, &input)
            .unwrap();
        assert_eq!(result["valid"], false, "{operation}: {result}");
        assert_eq!(
            result["diagnostics"][0]["code"], "migration_required",
            "{operation}: {result}"
        );
    }
    assert_eq!(
        fs::read_to_string(root.join("legacy.md")).unwrap(),
        document
    );
    assert!(!root.join("new.md").exists());
    assert!(!root.join("renamed.md").exists());
}

#[test]
fn type_operations_are_revision_safe_and_require_full_collection_scope() {
    let state = tempdir().unwrap();
    let collection_parent = tempdir().unwrap();
    let root = collection_parent.path().join("typed");
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let collection = registry.create(&root, Some("Typed")).unwrap();
    let document = r#"---
kind: mdbase.type
name: project
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    properties:
      title: { type: string }
---
"#;

    let created = registry
        .operation(collection.id, "create_type", &json!({"document": document}))
        .unwrap();
    assert_eq!(created["valid"], true, "{created}");
    assert_eq!(created["result"]["path"], "_types/project.md");
    let revision = created["result"]["revision"].as_str().unwrap();

    let read = registry
        .operation(collection.id, "read_type", &json!({"name": "project"}))
        .unwrap();
    assert_eq!(read["result"]["revision"], revision);

    let updated = registry
        .operation(
            collection.id,
            "update_type",
            &json!({
                "name": "project",
                "if_revision": revision,
                "document": document.replace("version: 1", "version: 2")
            }),
        )
        .unwrap();
    assert_eq!(updated["valid"], true, "{updated}");
    assert_ne!(updated["result"]["revision"], revision);

    let contract_scope = unavailable_contract_scope();
    assert!(matches!(
        registry.scoped_operation(
            collection.id,
            "read_type",
            &json!({"name": "project"}),
            &contract_scope
        ),
        Err(ConnectError::AccessDenied(_))
    ));
}

#[test]
fn installs_type_packs_as_full_collection_operations_and_provisions_idempotently() {
    let state = tempdir().unwrap();
    let collection_parent = tempdir().unwrap();
    let root = collection_parent.path().join("provisioned");
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let collection = registry.create(&root, Some("Provisioned")).unwrap();
    let requirements = ApplicationRequirements {
        contracts: vec![ContractRequirement {
            id: "workout.record".to_string(),
            version: "1.0.0".to_string(),
        }],
        ..Default::default()
    };
    let contract_document = r#"---
kind: mdbase.contract
contract_type: record
id: workout.record
version: 1.0.0
record_schema:
  dialect: json-schema-2020-12
  value:
    type: object
    additionalProperties: false
    properties:
      type: { const: workout }
---
"#;
    let type_document = r#"---
kind: mdbase.type
name: workout
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    properties:
      type: { const: workout }
implements:
  - contract: workout.record
    version: 1.0.0
    fields:
      type: type
---
"#;
    let auxiliary_document = r#"---
kind: mdbase.type
name: workout_note
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    properties:
      type: { const: workout_note }
---
"#;
    let resources = [
        (
            "contract.md",
            "_contracts/workout.record.md",
            "contract",
            contract_document,
        ),
        ("workout.md", "_types/workout.md", "type", type_document),
        (
            "workout-note.md",
            "_types/workout_note.md",
            "type",
            auxiliary_document,
        ),
    ];
    let provision = TypePackProvision {
        manifest: mdbase_connect_protocol::TypePackManifest {
            kind: "mdbase.type-pack".to_string(),
            id: "example.workout".to_string(),
            version: "1.0.0".to_string(),
            name: Some("Workout".to_string()),
            description: None,
            resources: resources
                .iter()
                .map(|(source, target, kind, document)| {
                    mdbase_connect_protocol::TypePackManifestResource {
                        kind: (*kind).to_string(),
                        source: (*source).to_string(),
                        target: (*target).to_string(),
                        digest: format!("sha256:{:x}", Sha256::digest(document.as_bytes())),
                    }
                })
                .collect(),
            extensions: Default::default(),
        },
        resources: resources
            .iter()
            .map(
                |(source, _, _, document)| mdbase_connect_protocol::TypePackSourceResource {
                    source: (*source).to_string(),
                    document: (*document).to_string(),
                },
            )
            .collect(),
        provides: requirements.contracts.clone(),
    };
    let installed = registry
        .operation(
            collection.id,
            "install_type_pack",
            &serde_json::to_value(&provision).unwrap(),
        )
        .unwrap();
    assert_eq!(installed["valid"], true, "{installed}");
    assert_eq!(installed["result"]["id"], "example.workout");
    assert_eq!(
        installed["result"]["resources"].as_array().unwrap().len(),
        3
    );
    assert!(matches!(
        registry.scoped_operation(
            collection.id,
            "install_type_pack",
            &serde_json::to_value(&provision).unwrap(),
            &unavailable_contract_scope()
        ),
        Err(ConnectError::AccessDenied(_))
    ));

    let provisions = [provision];

    let contracts = registry
        .provision_type_packs(collection.id, &requirements, &provisions)
        .unwrap();
    assert!(contracts.iter().any(|contract| {
        contract.id == requirements.contracts[0].id
            && contract.version == requirements.contracts[0].version
    }));
    assert!(root.join("_contracts/workout.record.md").is_file());
    assert!(root.join("_types/workout.md").is_file());
    assert!(root.join("_types/workout_note.md").is_file());
    registry
        .provision_type_packs(collection.id, &requirements, &provisions)
        .unwrap();
}

#[test]
fn scoped_conditional_writers_share_one_collection_serialization_gate() {
    let state = tempdir().unwrap();
    let collection_parent = tempdir().unwrap();
    let root = collection_parent.path().join("tasks");
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let collection = registry.create(&root, Some("Tasks")).unwrap();
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
    let created = registry
        .operation(
            collection.id,
            "create",
            &json!({
                "path": "task.md",
                "type": "task",
                "frontmatter": {"type": "task", "title": "Original"},
            }),
        )
        .unwrap();
    assert_eq!(created["valid"], true, "{created}");
    let revision = created["result"]["revision"]
        .as_str()
        .expect("create result has a revision")
        .to_string();
    let scope = work_item_scope(&registry, collection.id);
    let barrier = Arc::new(Barrier::new(3));

    let writers = ["First", "Second"].map(|title| {
        let registry = registry.clone();
        let barrier = barrier.clone();
        let scope = scope.clone();
        let revision = revision.clone();
        thread::spawn(move || {
            barrier.wait();
            registry
                .scoped_operation(
                    collection.id,
                    "update",
                    &json!({
                        "path": "task.md",
                        "patch": {"title": title},
                        "if_revision": revision,
                    }),
                    &scope,
                )
                .unwrap()
        })
    });
    barrier.wait();
    let results = writers.map(|writer| writer.join().unwrap());

    assert_eq!(
        results
            .iter()
            .filter(|result| result["valid"] == true)
            .count(),
        1
    );
    assert_eq!(
        results
            .iter()
            .filter(|result| result["valid"] == false)
            .count(),
        1
    );
    assert!(results.iter().any(|result| {
        result["diagnostics"].as_array().is_some_and(|diagnostics| {
            diagnostics
                .iter()
                .any(|diagnostic| diagnostic["code"] == "concurrent_modification")
        })
    }));
}

#[test]
fn describe_exposes_complete_portable_type_metadata_without_absolute_paths() {
    let state = tempdir().unwrap();
    let collection_parent = tempdir().unwrap();
    let root = collection_parent.path().join("tasks");
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let collection = registry.create(&root, Some("Tasks")).unwrap();
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
    let collection = registry.create(&root, Some("Mixed")).unwrap();
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
    let collection = registry.create(&root, Some("Multiple providers")).unwrap();
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

#[test]
fn full_collection_scope_lists_and_executes_saved_views() {
    let state = tempdir().unwrap();
    let collection_parent = tempdir().unwrap();
    let root = collection_parent.path().join("views");
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let collection = registry.create(&root, Some("Views")).unwrap();
    fs::write(
        root.join("_types/view.md"),
        r#"---
kind: mdbase.type
name: view
version: 1
schema:
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
version: 1
schema:
  dialect: json-schema-2020-12
  value: { type: object }
---
"#,
    )
    .unwrap();
    fs::create_dir_all(root.join("tasks")).unwrap();
    fs::create_dir_all(root.join("views")).unwrap();
    fs::write(
        root.join("tasks/one.md"),
        "---\ntype: task\ntitle: One\n---\n",
    )
    .unwrap();
    fs::write(
        root.join("views/tasks.md"),
        r#"---
type: view
id: task.views
version: 1
name: Task views
query:
  types: [task]
views:
  - id: all
    name: All tasks
    select: [title]
    presentation:
      type: example.list
---
"#,
    )
    .unwrap();

    let listed = registry
        .operation(collection.id, "list_views", &json!({}))
        .unwrap();
    assert_eq!(listed["valid"], true, "{listed}");
    assert_eq!(listed["result"]["meta"]["total_count"], 1);
    assert_eq!(listed["result"]["views"][0]["id"], "task.views");

    let executed = registry
        .operation(
            collection.id,
            "execute_view",
            &json!({ "path": "views/tasks.md", "view": "all" }),
        )
        .unwrap();
    assert_eq!(executed["valid"], true, "{executed}");
    assert_eq!(executed["result"]["meta"]["total_count"], 1);
    assert_eq!(executed["result"]["results"][0]["path"], "tasks/one.md");

    let source = registry
        .operation(
            collection.id,
            "read_view_source",
            &json!({ "path": "views/tasks.md" }),
        )
        .unwrap();
    let changed = source["result"]["document"]
        .as_str()
        .unwrap()
        .replace("All tasks", "Every task");
    let updated = registry
        .operation(
            collection.id,
            "update_view_source",
            &json!({
                "path": "views/tasks.md",
                "if_revision": source["result"]["revision"],
                "document": changed,
            }),
        )
        .unwrap();
    assert_eq!(updated["valid"], true, "{updated}");
    let listed = registry
        .operation(collection.id, "list_views", &json!({}))
        .unwrap();
    assert_eq!(
        listed["result"]["views"][0]["views"][0]["name"],
        "Every task"
    );
}

#[test]
fn change_pages_resume_by_cursor_and_omit_record_snapshots() {
    let state = tempdir().unwrap();
    let collection_parent = tempdir().unwrap();
    let root = collection_parent.path().join("notes");
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let collection = registry.create(&root, Some("Notes")).unwrap();
    let event = mdbase::watch::WatchEvent {
        event_type: "mdbase.record.modified".to_string(),
        sequence: 7,
        occurred_at: "2026-07-20T12:00:00.000Z".to_string(),
        payload: json!({
            "path": "note.md",
            "before": {"title": "Before"},
            "after": {"title": "After"},
            "changed_fields": ["title"],
            "revision": "sha256:after"
        }),
    };
    assert_eq!(registry.append_change(collection.id, &event).unwrap(), 1);

    let initial = registry.changes(collection.id, &json!({})).unwrap();
    assert!(initial.events.is_empty());
    assert_eq!(initial.cursor, 1);
    let page = registry
        .changes(collection.id, &json!({"after": 0}))
        .unwrap();
    assert_eq!(page.events.len(), 1);
    assert_eq!(page.events[0].payload["path"], "note.md");
    assert!(page.events[0].payload.get("before").is_none());
    assert!(page.events[0].payload.get("after").is_none());
    assert_eq!(page.cursor, 1);
}

#[test]
fn policy_snapshot_replaces_previous_local_authority() {
    let state = tempdir().unwrap();
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let grant = GrantPolicy {
        id: Uuid::new_v4(),
        application_id: Uuid::new_v4(),
        collection_id: Uuid::new_v4(),
        operations: vec!["read".to_string(), "query".to_string()],
        scope: GrantScope::full_collection(),
        application_name: "Workout Tracker".to_string(),
        application_distribution: "web".to_string(),
        application_homepage: "https://workouts.example".to_string(),
        application_project_url: None,
        application_origin: "https://workouts.example".to_string(),
        application_icon: None,
        collection_name: "Workouts".to_string(),
        notification_criteria: Vec::new(),
        created_at: "2026-07-19T00:00:00Z".to_string(),
        encryption: None,
    };
    registry
        .replace_grants(std::slice::from_ref(&grant))
        .unwrap();
    assert!(registry
        .authorizes(grant.id, grant.application_id, grant.collection_id, "query")
        .unwrap());
    assert!(!registry
        .authorizes(
            grant.id,
            grant.application_id,
            grant.collection_id,
            "update"
        )
        .unwrap());

    registry.replace_grants(&[]).unwrap();
    assert!(!registry
        .authorizes(grant.id, grant.application_id, grant.collection_id, "read")
        .unwrap());
}

#[test]
fn encrypted_replay_window_survives_restart_allows_reordering_and_serializes_duplicates() {
    let state = tempdir().unwrap();
    let grant_id = Uuid::new_v4();
    let first_request = Uuid::new_v4();
    let registry = CollectionRegistry::open(state.path()).unwrap();
    assert_eq!(
        registry
            .claim_encrypted_request(grant_id, "key-1", 40, first_request, "fingerprint-1")
            .unwrap(),
        EncryptedRequestClaim::Fresh
    );
    registry
        .complete_encrypted_request(
            grant_id,
            "key-1",
            first_request,
            "fingerprint-1",
            r#"{"ciphertext":"response"}"#,
        )
        .unwrap();
    drop(registry);

    let registry = CollectionRegistry::open(state.path()).unwrap();
    assert!(matches!(
        registry.claim_encrypted_request(grant_id, "key-1", 40, Uuid::new_v4(), "fingerprint-2"),
        Err(ConnectError::EncryptedRelayRejected)
    ));
    assert_eq!(
        registry
            .claim_encrypted_request(grant_id, "key-1", 40, first_request, "fingerprint-1")
            .unwrap(),
        EncryptedRequestClaim::Completed(r#"{"ciphertext":"response"}"#.to_string())
    );
    assert!(registry
        .claim_encrypted_request(grant_id, "key-1", 41, first_request, "tampered")
        .is_err());
    assert_eq!(
        registry
            .claim_encrypted_request(grant_id, "key-1", 42, Uuid::new_v4(), "fingerprint-42")
            .unwrap(),
        EncryptedRequestClaim::Fresh
    );
    assert_eq!(
        registry
            .claim_encrypted_request(grant_id, "key-1", 41, Uuid::new_v4(), "fingerprint-41")
            .unwrap(),
        EncryptedRequestClaim::Fresh
    );

    let shared = Arc::new(registry);
    let request_id = Uuid::new_v4();
    let threads = (0..8)
        .map(|_| {
            let registry = shared.clone();
            std::thread::spawn(move || {
                registry.claim_encrypted_request(
                    grant_id,
                    "key-1",
                    43,
                    request_id,
                    "fingerprint-43",
                )
            })
        })
        .collect::<Vec<_>>();
    let accepted = threads
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .filter(|result| matches!(result, Ok(EncryptedRequestClaim::Fresh)))
        .count();
    assert_eq!(accepted, 1);
    assert_eq!(
        shared
            .claim_encrypted_request(grant_id, "key-1", 2_000, Uuid::new_v4(), "fingerprint-2000")
            .unwrap(),
        EncryptedRequestClaim::Fresh
    );
    assert!(shared
        .claim_encrypted_request(grant_id, "key-1", 975, Uuid::new_v4(), "fingerprint-stale")
        .is_err());
}

#[test]
fn development_registry_upgrade_adds_origin_receipts_and_a_safe_reorder_floor() {
    let state = tempdir().unwrap();
    let path = state.path().join("connector.sqlite");
    let legacy = Connection::open(&path).unwrap();
    legacy
        .execute_batch(
            "CREATE TABLE grants (
                    id TEXT PRIMARY KEY,
                    application_id TEXT NOT NULL,
                    collection_id TEXT NOT NULL,
                    operations TEXT NOT NULL
                 );
                 CREATE TABLE grant_crypto_state (
                    grant_id TEXT NOT NULL,
                    key_id TEXT NOT NULL,
                    last_request_counter TEXT NOT NULL,
                    PRIMARY KEY (grant_id, key_id)
                 );
                 CREATE TABLE grant_crypto_requests (
                    grant_id TEXT NOT NULL,
                    key_id TEXT NOT NULL,
                    request_id TEXT NOT NULL,
                    received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (grant_id, key_id, request_id)
                 );",
        )
        .unwrap();
    let grant_id = Uuid::new_v4();
    legacy
        .execute(
            "INSERT INTO grant_crypto_state (grant_id, key_id, last_request_counter)
                 VALUES (?1, 'legacy-key', '40')",
            [grant_id.to_string()],
        )
        .unwrap();
    drop(legacy);

    let registry = CollectionRegistry::open(state.path()).unwrap();
    let connection = registry.connection().unwrap();
    let origin: String = connection
        .query_row(
            "SELECT dflt_value FROM pragma_table_info('grants')
                 WHERE name = 'application_origin'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(origin, "''");
    let floor: String = connection
        .query_row(
            "SELECT reorder_floor FROM grant_crypto_state
                 WHERE grant_id = ?1 AND key_id = 'legacy-key'",
            [grant_id.to_string()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(floor, "40");
    drop(connection);
    assert_eq!(
        registry
            .claim_encrypted_request(
                grant_id,
                "legacy-key",
                41,
                Uuid::new_v4(),
                "upgraded-fingerprint"
            )
            .unwrap(),
        EncryptedRequestClaim::Fresh
    );
}

#[test]
fn policy_rotation_prunes_only_obsolete_encrypted_replay_windows() {
    let state = tempdir().unwrap();
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let mut grant = GrantPolicy {
        id: Uuid::new_v4(),
        application_id: Uuid::new_v4(),
        collection_id: Uuid::new_v4(),
        operations: vec!["read".to_string()],
        scope: GrantScope::full_collection(),
        application_name: "Encrypted app".to_string(),
        application_distribution: "web".to_string(),
        application_homepage: "https://app.example".to_string(),
        application_project_url: None,
        application_origin: "https://app.example".to_string(),
        application_icon: None,
        collection_name: "Collection".to_string(),
        notification_criteria: Vec::new(),
        created_at: "2026-07-21T00:00:00Z".to_string(),
        encryption: Some(mdbase_connect_protocol::GrantEncryption {
            protocol_version: 1,
            suite: "P256-HKDF-SHA256-AES256GCM".to_string(),
            key_id: "key-1".to_string(),
            scope_epoch: 1,
            connector_id: Uuid::new_v4(),
            collection_id: Uuid::new_v4(),
            application_agreement_public_key: "application-key".to_string(),
            connector_agreement_public_key: "connector-key".to_string(),
        }),
    };
    registry
        .replace_grants(std::slice::from_ref(&grant))
        .unwrap();
    registry
        .claim_encrypted_request(grant.id, "key-1", 7, Uuid::new_v4(), "fingerprint")
        .unwrap();

    registry
        .replace_grants(std::slice::from_ref(&grant))
        .unwrap();
    let preserved = registry
        .connection()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM grant_crypto_state WHERE grant_id = ?1 AND key_id = 'key-1'",
            [grant.id.to_string()],
            |row| row.get::<_, u64>(0),
        )
        .unwrap();
    assert_eq!(preserved, 1);

    grant.encryption.as_mut().unwrap().key_id = "key-2".to_string();
    grant.encryption.as_mut().unwrap().scope_epoch = 2;
    registry
        .replace_grants(std::slice::from_ref(&grant))
        .unwrap();
    let obsolete = registry
        .connection()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM grant_crypto_state WHERE grant_id = ?1 AND key_id = 'key-1'",
            [grant.id.to_string()],
            |row| row.get::<_, u64>(0),
        )
        .unwrap();
    assert_eq!(obsolete, 0);
}
