use super::*;

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
