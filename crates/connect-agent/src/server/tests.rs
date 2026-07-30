use super::*;
use mdbase_connect_core::CollectionRegistry;
use mdbase_connect_protocol::crypto::{RelayDirection, RelayMetadata};
use mdbase_connect_protocol::{
    ApplicationAccess, ApplicationProvisions, ApplicationRequirements, GrantEncryption,
    GrantPolicy, GrantScope, RELAY_ENCRYPTION_SUITE,
};
use std::fs;
use tokio::net::UnixStream;
use tokio::sync::oneshot;
use uuid::Uuid;

#[tokio::test]
async fn listening_callback_runs_after_the_control_socket_is_reachable() {
    let test_root = std::env::temp_dir().join(format!(
        "mdbase-connect-listening-test-{}",
        uuid::Uuid::new_v4()
    ));
    let endpoint = test_root.join("agent.sock");
    let registry = CollectionRegistry::open(&test_root).unwrap();
    let watcher = CollectionWatchService::start(registry.clone());
    let state = Arc::new(AgentState::new(registry, watcher, None));
    let starting_ping = state
        .execute(ControlRequest::new(ControlCommand::Ping))
        .await;
    assert_eq!(starting_ping.result.unwrap()["ready"], false);
    let (ready, listening) = oneshot::channel();
    let endpoint_for_server = endpoint.to_string_lossy().into_owned();
    let server_state = state.clone();
    let server = tokio::spawn(async move {
        serve(&endpoint_for_server, server_state, move || {
            let _ = ready.send(());
        })
        .await
    });

    listening.await.expect("listening callback");
    UnixStream::connect(&endpoint)
        .await
        .expect("control socket must accept connections after the callback");
    state.mark_initialized();
    let ready_ping = state
        .execute(ControlRequest::new(ControlCommand::Ping))
        .await;
    assert_eq!(ready_ping.result.unwrap()["ready"], true);

    server.abort();
    let _ = server.await;
    fs::remove_dir_all(test_root).unwrap();
}

#[tokio::test]
async fn local_control_refuses_to_replace_a_non_socket_endpoint() {
    let test_root = std::env::temp_dir().join(format!(
        "mdbase-connect-endpoint-test-{}",
        uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(&test_root).unwrap();
    let endpoint = test_root.join("important.txt");
    fs::write(&endpoint, "keep me").unwrap();
    let registry = CollectionRegistry::open(test_root.join("state")).unwrap();
    let watcher = CollectionWatchService::start(registry.clone());
    let state = Arc::new(AgentState::new(registry, watcher, None));

    let error = serve(endpoint.to_str().unwrap(), state, || {})
        .await
        .unwrap_err();

    assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
    assert_eq!(fs::read_to_string(&endpoint).unwrap(), "keep me");
    fs::remove_dir_all(test_root).unwrap();
}

#[tokio::test]
async fn rejects_an_unsupported_local_control_protocol() {
    let test_root = std::env::temp_dir().join(format!(
        "mdbase-connect-protocol-test-{}",
        uuid::Uuid::new_v4()
    ));
    let registry = CollectionRegistry::open(&test_root).unwrap();
    let watcher = CollectionWatchService::start(registry.clone());
    let state = AgentState::new(registry, watcher, None);
    let mut request = ControlRequest::new(ControlCommand::Ping);
    request.protocol_version = LOCAL_CONTROL_PROTOCOL_VERSION + 1;

    let response = state.execute(request).await;

    assert!(!response.ok);
    assert_eq!(response.protocol_version, LOCAL_CONTROL_PROTOCOL_VERSION);
    assert_eq!(
        response.error.expect("protocol error").code,
        "unsupported_local_protocol"
    );
    fs::remove_dir_all(test_root).unwrap();
}

#[tokio::test]
async fn status_reports_the_running_binary_version_for_upgrade_health_checks() {
    let test_root = std::env::temp_dir().join(format!(
        "mdbase-connect-version-test-{}",
        uuid::Uuid::new_v4()
    ));
    let registry = CollectionRegistry::open(&test_root).unwrap();
    let watcher = CollectionWatchService::start(registry.clone());
    let state = AgentState::new(registry, watcher, None);

    let response = state
        .execute(ControlRequest::new(ControlCommand::Status))
        .await;

    assert!(response.ok);
    assert_eq!(
        response.result.expect("status result")["binary_version"],
        env!("CARGO_PKG_VERSION")
    );
    fs::remove_dir_all(test_root).unwrap();
}

#[tokio::test]
async fn bounds_local_control_request_memory() {
    let test_root = std::env::temp_dir().join(format!(
        "mdbase-connect-request-limit-test-{}",
        uuid::Uuid::new_v4()
    ));
    let registry = CollectionRegistry::open(&test_root).unwrap();
    let watcher = CollectionWatchService::start(registry.clone());
    let state = Arc::new(AgentState::new(registry, watcher, None));
    let capacity = (MAX_LOCAL_CONTROL_REQUEST_BYTES + 1) as usize;
    let (mut client, server) = tokio::io::duplex(capacity);
    let handler = tokio::spawn(handle_stream(server, state));

    client.write_all(&vec![b'x'; capacity]).await.unwrap();
    let mut response = String::new();
    BufReader::new(client)
        .read_line(&mut response)
        .await
        .unwrap();
    let response: ControlResponse = serde_json::from_str(&response).unwrap();

    assert!(!response.ok);
    assert_eq!(
        response.error.expect("size error").code,
        "control_request_too_large"
    );
    handler.await.unwrap().unwrap();
    fs::remove_dir_all(test_root).unwrap();
}

#[test]
fn live_authorization_is_acknowledged_only_after_the_grant_is_stored() {
    let test_root = std::env::temp_dir().join(format!(
        "mdbase-connect-authorization-test-{}",
        uuid::Uuid::new_v4()
    ));
    let registry = CollectionRegistry::open(test_root.join("state")).unwrap();
    let collection = registry
        .create(test_root.join("collection"), Some("Live notes"))
        .unwrap();
    let watcher = CollectionWatchService::start(registry.clone());
    let state = AgentState::new(registry.clone(), watcher, None);
    let authorization_id = Uuid::new_v4();
    let offer_request_id = Uuid::new_v4();
    let offer = state
        .handle_relay_message(RelayMessage::AuthorizationOfferRequest {
            protocol_version: CONTROL_PROTOCOL_VERSION,
            request_id: offer_request_id,
            authorization_id,
        })
        .unwrap();
    let RelayMessage::AuthorizationOfferResponse {
        request_id,
        paused,
        collections,
        ..
    } = offer
    else {
        panic!("expected authorization offer")
    };
    assert_eq!(request_id, offer_request_id);
    assert!(!paused);
    assert_eq!(collections.len(), 1);
    assert_eq!(collections[0].collection_id, collection.id);

    let grant = GrantPolicy {
        id: Uuid::new_v4(),
        application_id: Uuid::new_v4(),
        collection_id: collection.id,
        operations: vec!["describe".to_string()],
        scope: GrantScope::full_collection(),
        application_name: "Live application".to_string(),
        application_distribution: "web".to_string(),
        application_homepage: "https://example.test".to_string(),
        application_project_url: None,
        application_origin: "https://example.test".to_string(),
        application_icon: None,
        collection_name: collection.display_name,
        notification_criteria: Vec::new(),
        created_at: "2026-07-26T00:00:00Z".to_string(),
        encryption: None,
    };
    let activation = state
        .handle_relay_message(RelayMessage::AuthorizationActivationRequest {
            protocol_version: CONTROL_PROTOCOL_VERSION,
            request_id: Uuid::new_v4(),
            authorization_id,
            collection_id: collection.id,
            requirements: ApplicationRequirements {
                contracts: Vec::new(),
                access: Some(ApplicationAccess::FullCollection),
                collection_kind: None,
            },
            provisions: ApplicationProvisions::default(),
            grant: Box::new(grant.clone()),
        })
        .unwrap();
    assert!(matches!(
        activation,
        RelayMessage::AuthorizationActivationResponse {
            ok: true,
            error: None,
            ..
        }
    ));
    assert_eq!(registry.list_grants().unwrap()[0].id, grant.id);
    fs::remove_dir_all(test_root).unwrap();
}

#[test]
fn encrypted_operations_round_trip_and_replays_return_the_durable_receipt() {
    let test_root = std::env::temp_dir().join(format!(
        "mdbase-connect-encryption-test-{}",
        uuid::Uuid::new_v4()
    ));
    let state_dir = test_root.join("state");
    let collection_dir = test_root.join("collection");
    let registry = CollectionRegistry::open(&state_dir).unwrap();
    let collection = registry
        .create(&collection_dir, Some("Encrypted notes"))
        .unwrap();
    let watcher = CollectionWatchService::start(registry.clone());
    let connector_identity = RelayIdentity::generate();
    let application_identity = RelayIdentity::generate();
    let connector_id = Uuid::new_v4();
    let application_id = Uuid::new_v4();
    let grant_id = Uuid::new_v4();
    let encryption = GrantEncryption {
        protocol_version: ENCRYPTED_RELAY_PROTOCOL_VERSION,
        suite: RELAY_ENCRYPTION_SUITE.to_string(),
        key_id: "enc_round_trip".to_string(),
        scope_epoch: 1,
        connector_id,
        collection_id: collection.id,
        application_agreement_public_key: application_identity.public_key(),
        connector_agreement_public_key: connector_identity.public_key(),
    };
    registry
        .replace_grants(&[GrantPolicy {
            id: grant_id,
            application_id,
            collection_id: collection.id,
            operations: vec!["describe".to_string()],
            scope: GrantScope::full_collection(),
            application_name: "Encrypted application".to_string(),
            application_distribution: "web".to_string(),
            application_homepage: "https://example.test".to_string(),
            application_project_url: None,
            application_origin: "https://example.test".to_string(),
            application_icon: None,
            collection_name: "Encrypted notes".to_string(),
            notification_criteria: Vec::new(),
            created_at: "2026-07-21T00:00:00Z".to_string(),
            encryption: Some(encryption.clone()),
        }])
        .unwrap();
    let state = AgentState::with_identity(registry, watcher, None, connector_identity);
    let binding = RelayBinding::from_grant(grant_id, application_id, &encryption);
    let keys = application_identity
        .derive(&encryption.connector_agreement_public_key, &binding)
        .unwrap();
    let metadata = RelayMetadata {
        binding: &binding,
        request_id: Uuid::new_v4(),
        operation: "describe",
        counter: "1",
    };
    let ciphertext = keys
        .encrypt_json(RelayDirection::Request, metadata, &serde_json::json!({}))
        .unwrap();
    let request = RelayMessage::EncryptedOperationRequest {
        envelope: metadata.envelope(ciphertext),
    };
    let response = state.handle_relay_message(request.clone()).unwrap();
    let RelayMessage::EncryptedOperationResponse { envelope } = response else {
        panic!("expected encrypted response")
    };
    let body: serde_json::Value = keys
        .decrypt_json(RelayDirection::Response, metadata, &envelope.ciphertext)
        .unwrap();
    assert_eq!(body["ok"], true);
    assert_eq!(body["result"]["display_name"], "Encrypted notes");

    let replay = state.handle_relay_message(request).unwrap();
    let RelayMessage::EncryptedOperationResponse {
        envelope: replay_envelope,
    } = replay
    else {
        panic!("expected cached encrypted response")
    };
    assert_eq!(replay_envelope, envelope);
    fs::remove_dir_all(test_root).unwrap();
}
