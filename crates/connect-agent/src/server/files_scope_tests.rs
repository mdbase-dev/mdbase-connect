use super::*;
use mdbase_connect_protocol::{
    ApplicationAccess, DeleteFileRequestKind, FileCapability, FileCapabilityKind, GrantScope,
    GrantSummary, ListFilesRequestKind, OpenFileDownloadRequestKind,
};
use std::fs;
use tempfile::tempdir;
use uuid::Uuid;

fn file_grant(collection_id: Uuid, actions: Vec<FileAction>, scope: FileScope) -> GrantSummary {
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
            scope,
        }),
    }
}

#[test]
fn selected_folder_scope_excludes_equal_named_root_files() {
    let state_dir = tempdir().unwrap();
    let root = tempdir().unwrap();
    fs::write(root.path().join("mdbase.yaml"), "spec_version: 0.3.0\n").unwrap();
    fs::write(root.path().join("Assets"), b"root file").unwrap();
    fs::write(root.path().join("Assets-old"), b"prefix sibling").unwrap();
    let registry = CollectionRegistry::open(state_dir.path()).unwrap();
    let collection = registry.add(root.path()).unwrap();
    let inventory = registry.reconcile_files(collection.id).unwrap();
    let root_file = inventory
        .iter()
        .find(|file| file.path == "Assets")
        .expect("extensionless root file remains eligible")
        .clone();
    let watcher = CollectionWatchService::start(registry.clone());
    let state = AgentState::new(registry, watcher, None);
    let selected = file_grant(
        collection.id,
        vec![FileAction::List, FileAction::Read, FileAction::Delete],
        FileScope::SelectedFolders {
            folders: vec!["Assets".to_string()],
        },
    );
    let capability = selected.file_capability.as_ref().unwrap();
    assert!(!file_visible(capability, "Assets"));
    assert!(file_visible(capability, "Assets/photo.bin"));
    assert!(!file_visible(capability, "Assets-old/photo.bin"));

    let list = ListFilesRequest {
        protocol_version: FILE_PROTOCOL_VERSION,
        message_type: ListFilesRequestKind::ListFiles,
        folder: None,
        after: None,
        limit: Some(100),
    };
    let selected_page: ListFilesPage = serde_json::from_value(
        state
            .file_control(&selected, serde_json::to_value(&list).unwrap())
            .unwrap(),
    )
    .unwrap();
    assert!(selected_page.files.is_empty());

    let read = OpenFileDownloadRequest {
        protocol_version: FILE_PROTOCOL_VERSION,
        message_type: OpenFileDownloadRequestKind::OpenFileDownload,
        transfer_id: Uuid::now_v7(),
        file_id: root_file.file_id,
        revision: None,
    };
    assert_eq!(
        state
            .file_control(&selected, serde_json::to_value(read).unwrap())
            .unwrap_err()
            .code(),
        "access_denied"
    );
    let delete = DeleteFileRequest {
        protocol_version: FILE_PROTOCOL_VERSION,
        message_type: DeleteFileRequestKind::DeleteFile,
        mutation_id: Uuid::now_v7(),
        file_id: root_file.file_id,
        if_revision: root_file.revision.clone(),
        path: root_file.path.clone(),
    };
    assert_eq!(
        state
            .file_control(&selected, serde_json::to_value(delete).unwrap())
            .unwrap_err()
            .code(),
        "access_denied"
    );
    assert_eq!(fs::read(root.path().join("Assets")).unwrap(), b"root file");

    let collection_grant = file_grant(
        collection.id,
        vec![FileAction::List, FileAction::Read],
        FileScope::Collection,
    );
    assert!(file_visible(
        collection_grant.file_capability.as_ref().unwrap(),
        "Assets"
    ));
    let collection_page: ListFilesPage = serde_json::from_value(
        state
            .file_control(&collection_grant, serde_json::to_value(list).unwrap())
            .unwrap(),
    )
    .unwrap();
    assert!(collection_page
        .files
        .iter()
        .any(|file| file.path == "Assets"));
}
