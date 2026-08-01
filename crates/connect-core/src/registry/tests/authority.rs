use super::*;

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
    assert_eq!(restored.path, created.path);
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
    fs::create_dir_all(root.join("images")).unwrap();
    fs::write(root.join("images/photo.png"), b"first image bytes").unwrap();

    let first = registry.authority_snapshot(collection.id).unwrap();
    assert_eq!(first.collection_id, collection.id);
    assert_eq!(first.records.len(), 1);
    assert_eq!(first.files.len(), 1);
    assert_eq!(first.files[0].path, "images/photo.png");
    assert_eq!(first.resources.documents[0].path, "mdbase.yaml");
    assert_eq!(first.manifest_digest.len(), 64);
    let record_id = first.records[0].record.record_id;

    fs::rename(root.join("one.md"), root.join("renamed.md")).unwrap();
    let renamed = registry.authority_snapshot(collection.id).unwrap();
    assert_eq!(renamed.records[0].record.record_id, record_id);
    assert_eq!(renamed.records[0].record.path, "renamed.md");
    assert_eq!(renamed.files[0].file_id, first.files[0].file_id);
    assert_eq!(
        renamed.records[0].document,
        fs::read_to_string(root.join("renamed.md")).unwrap()
    );

    fs::write(root.join("images/photo.png"), b"replacement image bytes").unwrap();
    let replaced = registry.authority_snapshot(collection.id).unwrap();
    assert_eq!(replaced.files[0].file_id, first.files[0].file_id);
    assert_ne!(
        replaced.files[0].content_digest,
        first.files[0].content_digest
    );
    assert_ne!(replaced.manifest_digest, renamed.manifest_digest);

    let transfer_id = Uuid::new_v4();
    let fenced = registry
        .fence_authority(collection.id, transfer_id)
        .unwrap();
    assert_eq!(fenced.manifest_digest, replaced.manifest_digest);
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
