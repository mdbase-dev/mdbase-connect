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
