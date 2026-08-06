use super::*;
use crate::output::render_human;

#[test]
fn parser_keeps_data_and_connect_namespaces_unambiguous() {
    let direct =
        Args::try_parse_from(["mdbase", "--root", "/data/notes", "read", "note.md"]).unwrap();
    assert!(matches!(
        direct.command,
        RootCommand::Data(DataCommand::Read { .. })
    ));

    let control =
        Args::try_parse_from(["mdbase", "--json", "connect", "daemon", "status"]).unwrap();
    assert!(matches!(
        control.command,
        RootCommand::Connect {
            command: ConnectCommand::Daemon(DaemonCommand::Status)
        }
    ));
}

#[test]
fn parser_rejects_ambiguous_data_targets() {
    let error = Args::try_parse_from([
        "mdbase",
        "--root",
        "/data/notes",
        "--collection",
        "01900000-0000-7000-8000-000000000000",
        "read",
        "note.md",
    ])
    .unwrap_err();
    assert_eq!(error.kind(), clap::error::ErrorKind::ArgumentConflict);
}

#[test]
fn daemon_targeting_separates_installed_and_isolated_processes() {
    assert_eq!(
        DaemonTarget::from_overrides(false, false),
        DaemonTarget::InstalledService
    );
    assert_eq!(
        DaemonTarget::from_overrides(true, false),
        DaemonTarget::IsolatedProfile
    );
    assert_eq!(
        DaemonTarget::from_overrides(false, true),
        DaemonTarget::IsolatedProfile
    );
    let error = DaemonTarget::IsolatedProfile
        .require_installed_service("install")
        .unwrap_err();
    assert_eq!(error.code, "invalid_input");
    assert!(error.message.contains("default installed service"));
}

#[test]
fn human_status_is_quiet_and_explicit() {
    let value = serde_json::json!({
        "state": "connected",
        "registered_collections": 2,
        "paused": false
    });
    assert_eq!(
        render_human(OutputKind::Status, &value),
        "Connected\nCollections: 2\nAccess: available"
    );
}

#[test]
fn collection_table_has_stable_columns() {
    let value = serde_json::json!([{
        "display_name": "Notes",
        "enabled": true,
        "id": "01900000-0000-7000-8000-000000000000",
        "path": "/data/notes"
    }]);
    let rendered = render_human(OutputKind::Collections, &value);
    assert!(rendered.starts_with("NAME"));
    assert!(rendered.contains("Notes"));
    assert!(rendered.contains("available"));
    assert!(!rendered.contains('{'));
}

#[test]
fn invalid_operation_json_is_a_usage_error() {
    let result = control_command(ConnectCommand::Operation {
        collection_id: Uuid::nil(),
        operation: "query".to_string(),
        input: "{".to_string(),
    });
    let error = result.unwrap_err();
    assert_eq!(error.code, "invalid_input");
    assert_eq!(error.exit_code, 2);
}

#[test]
fn collection_creation_rejects_non_iana_timezone_overrides() {
    let result = control_command(ConnectCommand::Collection(CollectionCommand::Create {
        path: PathBuf::from("/data/notes"),
        name: Some("Notes".to_string()),
        timezone: Some("+10:00".to_string()),
    }));
    let error = result.unwrap_err();
    assert_eq!(error.code, "invalid_input");
    assert!(error.message.contains("IANA"));
}

#[test]
fn mirror_file_flags_build_an_explicit_device_local_policy() {
    let collection_id = "01900000-0000-7000-8000-000000000000";
    let args = Args::try_parse_from([
        "mdbase",
        "connect",
        "mirror",
        "add",
        collection_id,
        "/data/notes",
        "--files",
        "images,pdfs,images",
        "--exclude-folder",
        "archive",
    ])
    .unwrap();
    let RootCommand::Connect { command } = args.command else {
        panic!("expected a Connect command")
    };
    let (command, _) = control_command(command).unwrap();
    let ControlCommand::MirrorAdd(params) = command else {
        panic!("expected mirrors.add")
    };
    assert_eq!(
        params.selective_sync.file_classes,
        vec![FileMediaClass::Image, FileMediaClass::Pdf]
    );
    assert_eq!(params.selective_sync.excluded_folders, vec!["archive"]);
}

#[test]
fn mirror_sync_requires_the_reviewed_plan_fingerprint() {
    let replica_id = "01911111-1111-7111-8111-111111111111";
    assert!(Args::try_parse_from(["mdbase", "connect", "mirror", "sync", replica_id]).is_err());

    let args = Args::try_parse_from([
        "mdbase",
        "connect",
        "mirror",
        "sync",
        replica_id,
        "--plan",
        "sha256:reviewed",
    ])
    .unwrap();
    let RootCommand::Connect { command } = args.command else {
        panic!("expected a Connect command")
    };
    let (command, _) = control_command(command).unwrap();
    let ControlCommand::MirrorApply(params) = command else {
        panic!("expected mirrors.apply")
    };
    assert_eq!(params.plan_fingerprint, "sha256:reviewed");
}
