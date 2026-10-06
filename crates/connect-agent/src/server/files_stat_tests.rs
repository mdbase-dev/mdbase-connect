use super::*;
use serde_json::{json, Value};

fn stat(state: &AgentState, grant: &GrantSummary, target: Value) -> Result<Value, ConnectError> {
    let mut request = json!({"protocol_version":1,"type":"stat_file"});
    request
        .as_object_mut()
        .unwrap()
        .extend(target.as_object().unwrap().clone());
    state.file_control(grant, request)
}

#[test]
fn stat_requires_list_and_checks_explicit_scope_before_lookup() {
    let state_dir = tempdir().unwrap();
    let root = tempdir().unwrap();
    fs::write(root.path().join("mdbase.yaml"), "spec_version: 0.3.0\n").unwrap();
    fs::create_dir(root.path().join("Allowed")).unwrap();
    fs::create_dir(root.path().join("Outside")).unwrap();
    fs::write(root.path().join("Allowed/file.bin"), b"safe").unwrap();
    fs::write(root.path().join("Outside/file.bin"), b"private").unwrap();
    let registry = CollectionRegistry::open(state_dir.path()).unwrap();
    let collection = registry.add(root.path()).unwrap();
    let files = registry.reconcile_files(collection.id).unwrap();
    let invisible = files
        .iter()
        .find(|file| file.path.starts_with("Outside/"))
        .unwrap();
    let watcher = CollectionWatchService::start(registry.clone());
    let state = AgentState::new(registry, watcher, None);
    let list_only = file_grant(collection.id, vec![FileAction::List]);
    let result = stat(&state, &list_only, json!({"path":"Allowed/file.bin"})).unwrap();
    assert_eq!(result["type"], "file_stat");
    assert_eq!(result["file"]["path"], "Allowed/file.bin");
    assert_eq!(
        stat(&state, &list_only, json!({"path":"Allowed/missing.bin"})).unwrap()["file"],
        Value::Null
    );
    assert_eq!(
        stat(&state, &list_only, json!({"file_id":invisible.file_id})).unwrap()["file"],
        Value::Null
    );
    assert_eq!(
        stat(&state, &list_only, json!({"path":"Outside/missing.bin"}))
            .unwrap_err()
            .code(),
        "access_denied"
    );
    for actions in [vec![], vec![FileAction::Read]] {
        let denied = file_grant(collection.id, actions);
        assert_eq!(
            stat(&state, &denied, json!({"path":"Allowed/missing.bin"}))
                .unwrap_err()
                .code(),
            "access_denied"
        );
    }
    for target in [
        json!({}),
        json!({"path":"Allowed/file.bin","file_id":Uuid::now_v7()}),
        json!({"path":"Allowed/file.bin","extra":true}),
        json!({"path":null,"file_id":Uuid::now_v7()}),
        json!({"file_id":null,"path":"Allowed/file.bin"}),
        json!({"path":"Allowed/../escape.bin"}),
    ] {
        assert!(stat(&state, &list_only, target).is_err());
    }
    let cancellation = mdbase::OperationCancellation::new();
    cancellation.cancel();
    assert!(matches!(
        state.file_control_cancellable(
            &list_only,
            json!({"protocol_version":1,"type":"stat_file","path":"Allowed/file.bin"}),
            &cancellation
        ),
        Err(ConnectError::OperationCancelled)
    ));
}

#[test]
fn stat_round_trips_over_encrypted_relay_and_revocation_denies_metadata() {
    use mdbase_connect_protocol::{
        GrantEncryption, GrantPolicy, RelayMessage, OPERATION_TRANSPORT_PROTOCOL_VERSION,
        RELAY_ENCRYPTION_SUITE,
    };
    let state_dir = tempdir().unwrap();
    let root = tempdir().unwrap();
    fs::write(root.path().join("mdbase.yaml"), "spec_version: 0.3.0\n").unwrap();
    fs::create_dir(root.path().join("Allowed")).unwrap();
    fs::write(root.path().join("Allowed/file.bin"), b"safe").unwrap();
    let registry = CollectionRegistry::open(state_dir.path()).unwrap();
    let collection = registry.add(root.path()).unwrap();
    let connector = RelayIdentity::generate();
    let application = RelayIdentity::generate();
    let mut grant = file_grant(collection.id, vec![FileAction::List]);
    let encryption = GrantEncryption {
        protocol_version: mdbase_connect_protocol::GRANT_ENCRYPTION_PROTOCOL_VERSION,
        suite: RELAY_ENCRYPTION_SUITE.into(),
        key_id: "file_stat_test".into(),
        scope_epoch: 1,
        connector_id: Uuid::now_v7(),
        collection_id: collection.id,
        application_agreement_public_key: application.public_key(),
        connector_agreement_public_key: connector.public_key(),
    };
    grant.application_origin = Some("https://example.test".into());
    let security = crate::test_support::application_security(
        crate::test_support::TestApplicationSecurityParams {
            application_id: grant.application_id,
            authorization_id: Uuid::now_v7(),
            collection_id: collection.id,
            operations: &[],
            distribution: "web",
            grant_agreement_public_key: application.public_key(),
            file_capability: grant.file_capability.as_ref(),
        },
    );
    registry
        .replace_grants(&[GrantPolicy {
            account_id: None,
            application_declaration: None,
            id: grant.id,
            application_id: grant.application_id,
            collection_id: collection.id,
            operations: vec![],
            scope: GrantScope::full_collection(),
            application_name: grant.application_name.clone(),
            application_distribution: "web".into(),
            application_homepage: "https://example.test".into(),
            application_project_url: None,
            application_origin: "https://example.test".into(),
            application_icon: None,
            collection_name: "Files".into(),
            notification_criteria: vec![],
            created_at: grant.created_at.clone(),
            encryption: Some(encryption.clone()),
            file_capability: grant.file_capability.clone(),
            application_authorization: security.proof,
        }])
        .unwrap();
    let watcher = CollectionWatchService::start(registry.clone());
    let state = AgentState::with_identity(registry.clone(), watcher, None, connector);
    let binding = RelayBinding::from_grant(grant.id, grant.application_id, &encryption);
    let keys = application
        .derive(&encryption.connector_agreement_public_key, &binding)
        .unwrap();
    let send = |counter: &'static str| {
        let metadata = RelayMetadata {
            binding: &binding,
            protocol_version: OPERATION_TRANSPORT_PROTOCOL_VERSION,
            request_id: Uuid::now_v7(),
            operation: "file_control",
            counter,
        };
        let ciphertext = keys
            .encrypt_json(
                RelayDirection::Request,
                metadata,
                &json!({"protocol_version":1,"type":"stat_file","path":"Allowed/file.bin"}),
            )
            .unwrap();
        let response = state
            .handle_relay_message(RelayMessage::EncryptedOperationRequest {
                envelope: metadata.envelope(ciphertext),
            })
            .unwrap();
        let RelayMessage::EncryptedOperationResponse { envelope } = response else {
            panic!("expected encrypted response")
        };
        keys.decrypt_json::<Value>(RelayDirection::Response, metadata, &envelope.ciphertext)
            .unwrap()
    };
    let result = send("1");
    assert_eq!(result["ok"], true, "{result}");
    assert_eq!(result["result"]["file"]["path"], "Allowed/file.bin");
    registry.replace_grants(&[]).unwrap();
    let denied = send("2");
    assert_eq!(denied["ok"], false, "{denied}");
    assert!(denied["result"].is_null());
}
