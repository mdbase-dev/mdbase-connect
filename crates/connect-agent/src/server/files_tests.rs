use super::*;
use mdbase_connect_protocol::{
    ApplicationAccess, DeleteFileRequestKind, FileCapability, FileCapabilityKind, GrantScope,
    GrantSummary, ListFilesRequestKind, MoveFileRequestKind, OpenFileDownloadRequestKind,
};
use std::fs;
use tempfile::tempdir;
use uuid::Uuid;

fn list_request() -> ListFilesRequest {
    ListFilesRequest {
        protocol_version: FILE_PROTOCOL_VERSION,
        message_type: ListFilesRequestKind::ListFiles,
        folder: Some("Assets/images".to_string()),
        after: Some("Assets/images/one.png".to_string()),
        limit: Some(25),
    }
}

#[test]
fn list_controls_are_bounded_before_paging() {
    assert_eq!(validate_list_request(&list_request()).unwrap(), 25);
    let mut invalid = list_request();
    invalid.limit = Some(0);
    assert!(validate_list_request(&invalid).is_err());
    invalid = list_request();
    invalid.folder = Some("../private".to_string());
    assert!(validate_list_request(&invalid).is_err());
    invalid = list_request();
    invalid.protocol_version += 1;
    assert!(validate_list_request(&invalid).is_err());
    assert_eq!(
        parse_local_file_cursor(&encode_local_file_cursor(42, "Assets/images/one.png")).unwrap(),
        (42, "Assets/images/one.png")
    );
    assert!(parse_local_file_cursor("Assets/images/one.png").is_err());
    assert!(parse_local_file_cursor("local-v1:0:Assets/images/one.png").is_err());
}

#[test]
fn cancelled_file_listing_stops_before_index_work() {
    let state_dir = tempdir().unwrap();
    let registry = CollectionRegistry::open(state_dir.path()).unwrap();
    let watcher = CollectionWatchService::start(registry.clone());
    let state = AgentState::new(registry, watcher, None);
    let grant = file_grant(Uuid::new_v4(), vec![FileAction::List]);
    let cancellation = mdbase::OperationCancellation::new();
    cancellation.cancel();

    assert!(matches!(
        state.file_control_cancellable(
            &grant,
            serde_json::to_value(list_request()).unwrap(),
            &cancellation,
        ),
        Err(ConnectError::OperationCancelled)
    ));
}

#[test]
fn local_list_pages_share_one_index_revision_and_expire_after_refresh() {
    let state_dir = tempdir().unwrap();
    let root = tempdir().unwrap();
    fs::write(root.path().join("mdbase.yaml"), "spec_version: 0.3.0\n").unwrap();
    fs::create_dir(root.path().join("Allowed")).unwrap();
    for name in ["a.bin", "b.bin", "c.bin"] {
        fs::write(root.path().join("Allowed").join(name), name.as_bytes()).unwrap();
    }
    let registry = CollectionRegistry::open(state_dir.path()).unwrap();
    let collection = registry.add(root.path()).unwrap();
    registry
        .refresh_file_index_if_needed(collection.id)
        .unwrap();
    let watcher = CollectionWatchService::start(registry.clone());
    let state = AgentState::new(registry.clone(), watcher, None);
    let grant = file_grant(collection.id, vec![FileAction::List]);
    let request = ListFilesRequest {
        protocol_version: FILE_PROTOCOL_VERSION,
        message_type: ListFilesRequestKind::ListFiles,
        folder: Some("Allowed".to_string()),
        after: None,
        limit: Some(1),
    };
    let first: ListFilesPage = serde_json::from_value(
        state
            .file_control(&grant, serde_json::to_value(&request).unwrap())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(first.files.len(), 1);
    let cursor = first.next.expect("three files produce a continuation");

    registry.mark_file_inventory_dirty(collection.id).unwrap();
    let mut continuation = request.clone();
    continuation.after = Some(cursor.clone());
    let second: ListFilesPage = serde_json::from_value(
        state
            .file_control(&grant, serde_json::to_value(&continuation).unwrap())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(second.files[0].path, "Allowed/b.bin");

    fs::write(root.path().join("Allowed/d.bin"), b"d.bin").unwrap();
    registry.mark_file_inventory_dirty(collection.id).unwrap();
    registry
        .refresh_file_index_if_needed(collection.id)
        .unwrap();
    assert_eq!(
        state
            .file_control(&grant, serde_json::to_value(&continuation).unwrap())
            .unwrap_err()
            .code(),
        "file_list_changed"
    );
}

fn file_grant(collection_id: Uuid, actions: Vec<FileAction>) -> GrantSummary {
    GrantSummary {
        application_declaration: None,
        contracts: mdbase_connect_protocol::ConnectContractRequirements::current(true),
        id: Uuid::now_v7(),
        application_id: Uuid::now_v7(),
        application_declaration_id: "dev.mdbase.test".to_string(),
        application_manifest_digest: "00".repeat(32),
        application_name: "File application".to_string(),
        application_distribution: "portable".to_string(),
        application_homepage: "https://example.test".to_string(),
        application_project_url: None,
        application_origin: None,
        application_icon: None,
        collection_id,
        collection_name: "Files".to_string(),
        operations: Vec::new(),
        scope: GrantScope {
            contracts: Vec::new(),
            access: ApplicationAccess::FullCollection,
        },
        notification_criteria: Vec::new(),
        created_at: "2026-08-01T00:00:00Z".to_string(),
        encryption: None,
        file_capability: Some(FileCapability {
            kind: FileCapabilityKind::Files,
            protocol_version: FILE_PROTOCOL_VERSION,
            actions,
            scope: FileScope::SelectedFolders {
                folders: vec!["Allowed".to_string()],
            },
        }),
    }
}

#[test]
fn lifecycle_control_authorizes_source_destination_and_action_before_mutation() {
    let state_dir = tempdir().unwrap();
    let root = tempdir().unwrap();
    fs::write(root.path().join("mdbase.yaml"), "spec_version: 0.3.0\n").unwrap();
    fs::create_dir(root.path().join("Allowed")).unwrap();
    fs::write(root.path().join("Allowed/source.bin"), b"safe").unwrap();
    let registry = CollectionRegistry::open(state_dir.path()).unwrap();
    let collection = registry.add(root.path()).unwrap();
    let original = registry.reconcile_files(collection.id).unwrap().remove(0);
    let watcher = CollectionWatchService::start(registry.clone());
    let state = AgentState::new(registry, watcher, None);
    let grant = file_grant(collection.id, vec![FileAction::Move, FileAction::Delete]);

    let outside = MoveFileRequest {
        protocol_version: FILE_PROTOCOL_VERSION,
        message_type: MoveFileRequestKind::MoveFile,
        mutation_id: Uuid::now_v7(),
        file_id: original.file_id,
        if_revision: original.revision.clone(),
        from_path: original.path.clone(),
        path: "Outside/moved.bin".to_string(),
        update_references: false,
    };
    assert_eq!(
        state
            .file_control(&grant, serde_json::to_value(&outside).unwrap())
            .unwrap_err()
            .code(),
        "access_denied"
    );
    assert_eq!(fs::read(root.path().join(&original.path)).unwrap(), b"safe");

    let mut allowed = outside;
    allowed.mutation_id = Uuid::now_v7();
    allowed.path = "Allowed/moved.bin".to_string();
    let moved: mdbase_connect_protocol::MoveFileReceipt = serde_json::from_value(
        state
            .file_control(&grant, serde_json::to_value(&allowed).unwrap())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(moved.file.path, "Allowed/moved.bin");

    let delete = DeleteFileRequest {
        protocol_version: FILE_PROTOCOL_VERSION,
        message_type: DeleteFileRequestKind::DeleteFile,
        mutation_id: Uuid::now_v7(),
        file_id: moved.file.file_id,
        if_revision: moved.file.revision.clone(),
        path: moved.file.path.clone(),
    };
    let read_only = file_grant(collection.id, vec![FileAction::Read]);
    assert_eq!(
        state
            .file_control(&read_only, serde_json::to_value(&delete).unwrap())
            .unwrap_err()
            .code(),
        "access_denied"
    );
    assert!(root.path().join(&delete.path).exists());

    let receipt: mdbase_connect_protocol::DeleteFileReceipt = serde_json::from_value(
        state
            .file_control(&grant, serde_json::to_value(&delete).unwrap())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(receipt.previous_path, delete.path);
    assert!(!root.path().join(&receipt.previous_path).exists());
}

#[test]
fn download_scope_is_rechecked_against_the_authoritative_current_path() {
    let state_dir = tempdir().unwrap();
    let root = tempdir().unwrap();
    fs::write(root.path().join("mdbase.yaml"), "spec_version: 0.3.0\n").unwrap();
    fs::create_dir(root.path().join("Allowed")).unwrap();
    fs::create_dir(root.path().join("Outside")).unwrap();
    fs::write(root.path().join("Allowed/source.bin"), b"safe").unwrap();
    let registry = CollectionRegistry::open(state_dir.path()).unwrap();
    let collection = registry.add(root.path()).unwrap();
    let original = registry.reconcile_files(collection.id).unwrap().remove(0);
    fs::rename(
        root.path().join("Allowed/source.bin"),
        root.path().join("Outside/source.bin"),
    )
    .unwrap();

    let watcher = CollectionWatchService::start(registry.clone());
    let state = AgentState::new(registry, watcher, None);
    let grant = file_grant(collection.id, vec![FileAction::Read]);
    let request = OpenFileDownloadRequest {
        protocol_version: FILE_PROTOCOL_VERSION,
        message_type: OpenFileDownloadRequestKind::OpenFileDownload,
        transfer_id: Uuid::now_v7(),
        file_id: original.file_id,
        revision: None,
    };
    assert_eq!(
        state
            .file_control(&grant, serde_json::to_value(&request).unwrap())
            .unwrap_err()
            .code(),
        "access_denied"
    );
    assert!(!root
        .path()
        .join(".mdbase-connect/transfers")
        .join(format!("{}.download", request.transfer_id))
        .exists());
}

#[path = "files_scope_tests.rs"]
mod scope_tests;
