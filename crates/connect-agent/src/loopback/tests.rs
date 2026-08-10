use super::*;
use axum::body::to_bytes;
use axum::http::header::{ACCESS_CONTROL_ALLOW_ORIGIN, CONTENT_TYPE, HOST, ORIGIN};
use mdbase_connect_core::{CollectionRegistry, ConnectError, MutationClaim, MutationClaimRequest};
use mdbase_connect_protocol::crypto::{RelayBinding, RelayDirection, RelayIdentity, RelayMetadata};
use mdbase_connect_protocol::{
    mutation_fingerprint, EncryptedRelayEnvelope, FileAction, FileCapability, FileCapabilityKind,
    FileScope, GrantEncryption, GrantPolicy, GrantScope, RelayMessage,
    MUTATING_OPERATION_IDENTIFIERS, OPERATION_TRANSPORT_PROTOCOL_VERSION, RELAY_ENCRYPTION_SUITE,
};
use std::fs;
use tower::ServiceExt;
use uuid::Uuid;

#[test]
fn busy_responses_are_explicitly_retryable() {
    let response = cors_busy("Busy.", "https://app.example");
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(response.headers().get(header::RETRY_AFTER).unwrap(), "1");
    assert_eq!(
        response.headers().get(ACCESS_CONTROL_ALLOW_ORIGIN).unwrap(),
        "https://app.example"
    );
}

#[tokio::test]
async fn exact_origin_host_and_protocol_one_are_enforced() {
    let fixture = fixture();
    let app = router(fixture.agent.clone(), 28_485);

    let hostile = app
        .clone()
        .oneshot(request(
            Method::GET,
            "/v1/ready",
            "https://evil.example",
            None,
        ))
        .await
        .unwrap();
    assert_eq!(hostile.status(), StatusCode::FORBIDDEN);
    assert!(hostile.headers().get(ACCESS_CONTROL_ALLOW_ORIGIN).is_none());

    let opaque_without_grant = app
        .clone()
        .oneshot(request(Method::GET, "/v1/ready", "null", None))
        .await
        .unwrap();
    assert_eq!(opaque_without_grant.status(), StatusCode::FORBIDDEN);

    let rebound = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri("/v1/ready")
                .header(HOST, "connector.evil.example:28485")
                .header(ORIGIN, &fixture.origin)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(rebound.status(), StatusCode::FORBIDDEN);

    let ready = app
        .clone()
        .oneshot(request(Method::GET, "/v1/ready", &fixture.origin, None))
        .await
        .unwrap();
    assert_eq!(ready.status(), StatusCode::OK);
    assert_eq!(
        ready.headers().get(ACCESS_CONTROL_ALLOW_ORIGIN).unwrap(),
        fixture.origin.as_str()
    );

    let plaintext = app
        .oneshot(request(
            Method::POST,
            "/v1/operations",
            &fixture.origin,
            Some(r#"{"type":"operation_request"}"#),
        ))
        .await
        .unwrap();
    assert_eq!(plaintext.status(), StatusCode::UPGRADE_REQUIRED);

    let root = fixture.root.clone();
    drop(fixture);
    remove_fixture_after_watchers_close(&root);
}

#[tokio::test]
async fn opaque_file_origin_requires_an_exact_encrypted_portable_grant() {
    let fixture = fixture_for_origin("null", "portable");
    let app = router(fixture.agent.clone(), 28_485);

    let ready = app
        .clone()
        .oneshot(request(Method::GET, "/v1/ready", "null", None))
        .await
        .unwrap();
    assert_eq!(ready.status(), StatusCode::OK);
    assert_eq!(
        ready.headers().get(ACCESS_CONTROL_ALLOW_ORIGIN).unwrap(),
        "null"
    );

    let described = fixture.direct(&app, "describe", json!({}), 1).await;
    assert_eq!(described["ok"], true);
    assert_eq!(described["result"]["display_name"], "Direct notes");

    let root = fixture.root.clone();
    drop(app);
    drop(fixture);
    remove_fixture_after_watchers_close(&root);
}

#[tokio::test]
async fn every_grantable_operation_runs_directly_and_duplicate_writes_cross_transports_once() {
    let fixture = fixture();
    let app = router(fixture.agent.clone(), 28_485);

    let described = fixture.direct(&app, "describe", json!({}), 1).await;
    assert_eq!(described["ok"], true);
    assert_eq!(described["result"]["display_name"], "Direct notes");
    let cursor = described["result"]["change_cursor"].as_u64().unwrap();

    let created = fixture
        .direct(
            &app,
            "create",
            json!({
                "path": "notes/one.md",
                "frontmatter": { "title": "One" },
                "body": "Direct body"
            }),
            2,
        )
        .await;
    assert_eq!(created["result"]["valid"], true);
    let revision = created["result"]["result"]["revision"]
        .as_str()
        .unwrap()
        .to_string();

    let read = fixture
        .direct(&app, "read", json!({ "path": "notes/one.md" }), 3)
        .await;
    assert_eq!(read["result"]["result"]["body"], "Direct body\n");

    let updated = fixture
        .direct(
            &app,
            "update",
            json!({
                "path": "notes/one.md",
                "patch": { "title": "Updated" },
                "if_revision": revision
            }),
            4,
        )
        .await;
    assert_eq!(updated["result"]["valid"], true);

    let renamed = fixture
        .direct(
            &app,
            "rename",
            json!({ "from": "notes/one.md", "to": "notes/renamed.md" }),
            5,
        )
        .await;
    assert_eq!(renamed["result"]["valid"], true);

    let queried = fixture
        .direct(&app, "query", json!({ "include_body": true }), 6)
        .await;
    assert_eq!(
        queried["result"]["result"]["results"][0]["path"],
        "notes/renamed.md"
    );

    let validated = fixture.direct(&app, "validate", json!({}), 7).await;
    assert_eq!(validated["result"]["valid"], true);

    let type_document = "---\nkind: mdbase.type\nname: browsernote\nversion: 1\ndescription: Browser note\nschema:\n  dialect: json-schema-2020-12\n  value:\n    type: object\n    properties:\n      title: { type: string }\n---\n";
    let created_type = fixture
        .direct(&app, "create_type", json!({ "document": type_document }), 8)
        .await;
    assert_eq!(created_type["result"]["valid"], true);
    assert_eq!(
        created_type["result"]["result"]["path"],
        "_types/browsernote.md"
    );

    let read_type = fixture
        .direct(&app, "read_type", json!({ "name": "browsernote" }), 9)
        .await;
    assert_eq!(read_type["result"]["valid"], true);
    let type_revision = read_type["result"]["result"]["revision"]
        .as_str()
        .unwrap()
        .to_string();

    let updated_type = fixture
        .direct(
            &app,
            "update_type",
            json!({
                "name": "browsernote",
                "document": type_document.replace("Browser note", "Updated browser note"),
                "if_revision": type_revision
            }),
            10,
        )
        .await;
    assert_eq!(updated_type["result"]["valid"], true);

    let changes = fixture
        .direct(&app, "changes", json!({ "after": cursor }), 11)
        .await;
    assert!(!changes["result"]["events"].as_array().unwrap().is_empty());

    let deleted = fixture
        .direct(&app, "delete", json!({ "path": "notes/renamed.md" }), 12)
        .await;
    assert_eq!(deleted["result"]["valid"], true);

    let duplicate = fixture.encrypted_request(
        "create",
        json!({ "path": "only-once.md", "frontmatter": { "title": "Once" } }),
        13,
    );
    let direct_response = fixture.send(&app, duplicate.clone()).await;
    let relay_response = fixture
        .agent
        .handle_relay_message(duplicate.clone())
        .expect("relay response");
    let RelayMessage::EncryptedOperationResponse {
        envelope: relay_envelope,
    } = relay_response
    else {
        panic!("expected encrypted relay receipt")
    };
    assert_eq!(direct_response, relay_envelope);

    let final_query = fixture.direct(&app, "query", json!({}), 14).await;
    let only_once = final_query["result"]["result"]["results"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|record| record["path"] == "only-once.md")
        .count();
    assert_eq!(only_once, 1);
    let journal = fixture.registry.mutation_journal_diagnostics().unwrap();
    assert_eq!(journal.state_counts.get("completed"), Some(&7));
    assert_eq!(journal.live_leases, 0);

    fixture.registry.replace_grants(&[]).unwrap();
    let revoked_replay = fixture.send(&app, duplicate).await;
    assert_eq!(revoked_replay, direct_response);
    let revoked_new = fixture
        .direct(
            &app,
            "create",
            json!({ "path": "must-not-exist.md", "frontmatter": {} }),
            15,
        )
        .await;
    assert_eq!(revoked_new["problem"]["code"], "access_denied");
    assert_eq!(revoked_new["problem"]["operation_outcome"], "not_sent");
    assert!(!fixture.root.join("collection/must-not-exist.md").exists());

    let root = fixture.root.clone();
    drop(app);
    drop(fixture);
    remove_fixture_after_watchers_close(&root);
}

#[tokio::test]
async fn every_grantable_mutator_enters_the_durable_journal_and_replays_exactly() {
    let fixture = fixture();
    let app = router(fixture.agent.clone(), 28_485);
    let mut exercised = 0_u64;

    for (index, mutation) in MUTATING_OPERATION_IDENTIFIERS.iter().enumerate() {
        // Sync mutation is authenticated by a mirror replica rather than an
        // application grant and has its own local-sync conformance suite.
        if *mutation == "sync:mutate" {
            continue;
        }
        let (operation, input) = if let Some(message_type) = mutation.strip_prefix("file_control:")
        {
            (
                "file_control",
                json!({ "protocol_version": 1, "type": message_type }),
            )
        } else {
            (*mutation, json!({}))
        };
        let request = fixture.encrypted_request(operation, input, index as u64 + 1);
        let first = fixture.send(&app, request.clone()).await;
        let replay = fixture.send(&app, request).await;
        assert_eq!(first, replay, "{mutation}");
        exercised += 1;
    }

    let diagnostics = fixture.registry.mutation_journal_diagnostics().unwrap();
    assert_eq!(diagnostics.state_counts.get("completed"), Some(&exercised));
    assert_eq!(diagnostics.live_leases, 0);
    let root = fixture.root.clone();
    drop(app);
    drop(fixture);
    remove_fixture_after_watchers_close(&root);
}

#[tokio::test]
async fn prepared_mutation_resumes_after_process_epoch_change_and_stale_owner_is_fenced() {
    let fixture = fixture();
    let input = json!({ "path": "restart.md", "frontmatter": { "title": "Restart" } });
    let (request, stale_lease) = prepare_create_journal(&fixture, &input, 1);

    let restarted_registry = CollectionRegistry::open(fixture.root.join("state")).unwrap();
    let watcher = crate::watcher::CollectionWatchService::start(restarted_registry.clone());
    watcher.refresh(&restarted_registry.list().unwrap());
    let restarted = Arc::new(AgentState::with_identity(
        restarted_registry.clone(),
        watcher,
        None,
        fixture.connector.clone(),
    ));
    let app = router(restarted, 28_485);
    let RelayMessage::EncryptedOperationRequest {
        envelope: request_envelope,
    } = request.clone()
    else {
        unreachable!()
    };
    let response = fixture.send(&app, request).await;
    let body = fixture.decrypt_response(&request_envelope, &response);
    assert_eq!(body["ok"], true);
    assert!(fixture.root.join("collection/restart.md").exists());
    assert!(matches!(
        fixture
            .registry
            .complete_mutation(&stale_lease, "stale", None),
        Err(ConnectError::MutationFenceLost { .. })
    ));
    assert_eq!(
        restarted_registry
            .mutation_journal_diagnostics()
            .unwrap()
            .state_counts
            .get("completed"),
        Some(&1)
    );
    let root = fixture.root.clone();
    drop(app);
    drop(restarted_registry);
    drop(fixture);
    remove_fixture_after_watchers_close(&root);
}

#[tokio::test]
async fn applied_but_unrecorded_filesystem_change_becomes_durable_unknown_not_rejected() {
    let fixture = fixture();
    let input = json!({ "path": "ambiguous.md", "frontmatter": { "title": "Ambiguous" } });
    let (request, stale_lease) = prepare_create_journal(&fixture, &input, 1);
    let applied = fixture
        .registry
        .operation(fixture.encryption.collection_id, "create", &input)
        .unwrap();
    assert_eq!(applied["valid"], true);

    let restarted_registry = CollectionRegistry::open(fixture.root.join("state")).unwrap();
    let watcher = crate::watcher::CollectionWatchService::start(restarted_registry.clone());
    watcher.refresh(&restarted_registry.list().unwrap());
    let restarted = Arc::new(AgentState::with_identity(
        restarted_registry,
        watcher,
        None,
        fixture.connector.clone(),
    ));
    let app = router(restarted, 28_485);
    let RelayMessage::EncryptedOperationRequest {
        envelope: request_envelope,
    } = request.clone()
    else {
        unreachable!()
    };
    let first = fixture.send(&app, request.clone()).await;
    let body = fixture.decrypt_response(&request_envelope, &first);
    assert_eq!(body["ok"], false);
    assert_eq!(body["problem"]["code"], "operation_outcome_unknown");
    assert_eq!(body["problem"]["operation_outcome"], "unknown");
    assert!(fixture.root.join("collection/ambiguous.md").exists());
    let replay = fixture.send(&app, request).await;
    assert_eq!(replay, first);
    assert!(matches!(
        fixture
            .registry
            .complete_mutation(&stale_lease, "stale", None),
        Err(ConnectError::MutationFenceLost { .. })
    ));
    let root = fixture.root.clone();
    drop(app);
    drop(fixture);
    remove_fixture_after_watchers_close(&root);
}

#[tokio::test]
async fn preflight_pause_tampering_and_revocation_fail_closed() {
    let fixture = fixture();
    let app = router(fixture.agent.clone(), 28_485);
    let preflight = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::OPTIONS)
                .uri("/v1/operations")
                .header(HOST, "127.0.0.1:28485")
                .header(ORIGIN, &fixture.origin)
                .header(header::ACCESS_CONTROL_REQUEST_METHOD, "POST")
                .header(header::ACCESS_CONTROL_REQUEST_HEADERS, "content-type")
                .header("access-control-request-private-network", "true")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(preflight.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        preflight
            .headers()
            .get("access-control-allow-private-network")
            .unwrap(),
        "true"
    );

    fixture.registry.set_paused(true).unwrap();
    let paused = fixture.direct(&app, "query", json!({}), 1).await;
    assert_eq!(paused["ok"], false);
    assert_eq!(paused["problem"]["code"], "access_paused");
    assert_eq!(paused["problem"]["category"], "availability");
    assert_eq!(paused["problem"]["recovery"], "resume_connector_access");
    let activity = fixture.registry.list_activity(20).unwrap();
    assert!(activity
        .iter()
        .any(|entry| entry.operation == "query" && entry.outcome == "denied"));
    fixture.registry.set_paused(false).unwrap();

    let mut tampered = fixture.encrypted_request("query", json!({}), 2);
    let RelayMessage::EncryptedOperationRequest { envelope } = &mut tampered else {
        unreachable!()
    };
    envelope.ciphertext.replace_range(
        ..1,
        if envelope.ciphertext.starts_with('A') {
            "B"
        } else {
            "A"
        },
    );
    let tampered_response = app
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/operations",
            &fixture.origin,
            Some(&serde_json::to_string(&tampered).unwrap()),
        ))
        .await
        .unwrap();
    assert_eq!(tampered_response.status(), StatusCode::FORBIDDEN);

    fixture.registry.replace_grants(&[]).unwrap();
    let revoked = fixture.direct(&app, "query", json!({}), 3).await;
    assert_eq!(revoked["ok"], false);
    assert_eq!(revoked["problem"]["code"], "access_denied");
    assert_eq!(revoked["problem"]["operation_outcome"], "not_sent");

    let root = fixture.root.clone();
    drop(app);
    drop(fixture);
    remove_fixture_after_watchers_close(&root);
}

#[tokio::test]
async fn concurrent_direct_requests_allow_authenticated_counter_reordering() {
    let fixture = fixture();
    let app = router(fixture.agent.clone(), 28_485);
    let created = fixture
        .direct(
            &app,
            "create",
            json!({ "path": "load.md", "frontmatter": { "title": "Load" } }),
            1,
        )
        .await;
    assert_eq!(created["result"]["valid"], true);

    // Exercise the full operation concurrency budget without turning this replay-window
    // assertion into a SQLite connection-saturation test on slower CI runners.
    let request_count = MAX_CONCURRENT_OPERATIONS as u64;
    let mut requests = (2..(2 + request_count))
        .map(|counter| fixture.encrypted_request("query", json!({}), counter))
        .collect::<Vec<_>>();
    requests.reverse();
    let responses = futures_util::future::join_all(
        requests
            .into_iter()
            .map(|request| fixture.send(&app, request)),
    )
    .await;
    assert_eq!(responses.len(), MAX_CONCURRENT_OPERATIONS);
    assert!(responses
        .iter()
        .all(|response| response.operation == "query" && !response.ciphertext.is_empty()));

    let root = fixture.root.clone();
    drop(app);
    drop(fixture);
    remove_fixture_after_watchers_close(&root);
}

#[tokio::test]
async fn encrypted_file_control_and_binary_frames_round_trip_directly() {
    use mdbase_connect_protocol::{
        FileFrameHeader, FileFrameKind, FileTransferBinding, FileTransferCipher,
        FileTransferDirection, FileTransferProtection, FileTransferSession, FileTransferStrategy,
        FILE_PROTOCOL_VERSION, FILE_TRANSFER_PROTOCOL_VERSION,
    };

    let fixture = fixture();
    let app = router(fixture.agent.clone(), 28_485);
    let content = b"direct binary file";
    let upload_id = Uuid::new_v4();
    let opened = fixture
            .file_control(
                &app,
                json!({
                    "protocol_version": FILE_PROTOCOL_VERSION,
                    "type": "open_file_upload",
                    "transfer_id": upload_id,
                    "path": "Assets/direct.bin",
                    "size": content.len(),
                    "content_digest": "sha256:2e438f39c46deb1a9ef51e7c521302fdf1b1a5c824f01038db5c9983da7d6442",
                    "media_type": "application/octet-stream"
                }),
                1,
            )
            .await;
    assert_eq!(opened["ok"], true);
    let upload: FileTransferSession = serde_json::from_value(opened["result"].clone()).unwrap();
    let FileTransferStrategy::FramedChunks { chunk_size } = upload.strategy else {
        panic!("direct upload must use framed chunks")
    };
    let upload_cipher = FileTransferCipher::derive(
        &fixture.application,
        &fixture.encryption.connector_agreement_public_key,
        FileTransferBinding {
            grant_id: fixture.grant_id,
            application_id: fixture.application_id,
            connector_id: fixture.encryption.connector_id,
            authority_id: fixture.encryption.connector_id,
            collection_id: fixture.encryption.collection_id,
            scope_epoch: fixture.encryption.scope_epoch,
            key_id: fixture.encryption.key_id.clone(),
            transfer_id: upload_id,
            direction: FileTransferDirection::Upload,
        },
    )
    .unwrap();
    let encoded = upload_cipher
        .encrypt_chunk(
            FileFrameKind::UploadChunk,
            FileFrameHeader {
                protocol_version: FILE_TRANSFER_PROTOCOL_VERSION,
                protection: FileTransferProtection::GrantAeadV1,
                grant_id: fixture.grant_id,
                authority_id: fixture.encryption.connector_id,
                collection_id: fixture.encryption.collection_id,
                transfer_id: upload_id,
                direction: FileTransferDirection::Upload,
                chunk_size,
                chunk_index: 0,
                offset: 0,
                plaintext_length: content.len() as u32,
                total_size: content.len() as u64,
                scope_epoch: fixture.encryption.scope_epoch,
                key_id: Some(fixture.encryption.key_id.clone()),
            },
            content,
        )
        .unwrap()
        .encode()
        .unwrap();
    let uploaded = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/v1/files/upload")
                .header(HOST, "127.0.0.1:28485")
                .header(ORIGIN, &fixture.origin)
                .header(CONTENT_TYPE, "application/mdbase-connect-file")
                .body(Body::from(encoded))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(uploaded.status(), StatusCode::NO_CONTENT);

    let committed = fixture
        .file_control(
            &app,
            json!({
                "protocol_version": FILE_PROTOCOL_VERSION,
                "type": "commit_file_upload",
                "transfer_id": upload_id
            }),
            2,
        )
        .await;
    assert_eq!(committed["ok"], true);
    assert_eq!(
        fs::read(fixture.root.join("collection/Assets/direct.bin")).unwrap(),
        content
    );
    let file = committed["result"]["file"].clone();

    let download_id = Uuid::new_v4();
    let opened = fixture
        .file_control(
            &app,
            json!({
                "protocol_version": FILE_PROTOCOL_VERSION,
                "type": "open_file_download",
                "transfer_id": download_id,
                "file_id": file["file_id"],
                "revision": file["revision"]
            }),
            3,
        )
        .await;
    assert_eq!(opened["ok"], true);
    let download: FileTransferSession = serde_json::from_value(opened["result"].clone()).unwrap();
    let downloaded = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri(format!(
                    "/v1/files/download/{}/{}/0",
                    fixture.grant_id, download_id
                ))
                .header(HOST, "127.0.0.1:28485")
                .header(ORIGIN, &fixture.origin)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(downloaded.status(), StatusCode::OK);
    assert_eq!(
        downloaded.headers().get(CONTENT_TYPE).unwrap(),
        "application/mdbase-connect-file"
    );
    let encoded = to_bytes(downloaded.into_body(), files::MAX_FILE_REQUEST_BYTES)
        .await
        .unwrap();
    let download_cipher = FileTransferCipher::derive(
        &fixture.application,
        &fixture.encryption.connector_agreement_public_key,
        FileTransferBinding {
            grant_id: fixture.grant_id,
            application_id: fixture.application_id,
            connector_id: fixture.encryption.connector_id,
            authority_id: fixture.encryption.connector_id,
            collection_id: fixture.encryption.collection_id,
            scope_epoch: fixture.encryption.scope_epoch,
            key_id: fixture.encryption.key_id.clone(),
            transfer_id: download_id,
            direction: FileTransferDirection::Download,
        },
    )
    .unwrap();
    assert_eq!(
        download_cipher
            .decrypt_chunk(&mdbase_connect_protocol::FileFrame::decode(&encoded).unwrap())
            .unwrap(),
        content
    );
    assert_eq!(download.total_size, content.len() as u64);

    let listed = fixture
        .file_control(
            &app,
            json!({ "protocol_version": 1, "type": "list_files" }),
            4,
        )
        .await;
    assert_eq!(listed["result"]["files"][0]["path"], "Assets/direct.bin");

    let root = fixture.root.clone();
    drop(app);
    drop(fixture);
    remove_fixture_after_watchers_close(&root);
}

struct Fixture {
    root: std::path::PathBuf,
    registry: CollectionRegistry,
    agent: Arc<AgentState>,
    origin: String,
    application: RelayIdentity,
    application_id: Uuid,
    grant_id: Uuid,
    encryption: GrantEncryption,
    connector: RelayIdentity,
}

impl Fixture {
    fn encrypted_request(
        &self,
        operation: &str,
        input: serde_json::Value,
        counter: u64,
    ) -> RelayMessage {
        let binding =
            RelayBinding::from_grant(self.grant_id, self.application_id, &self.encryption);
        let keys = self
            .application
            .derive(&self.encryption.connector_agreement_public_key, &binding)
            .unwrap();
        let counter = counter.to_string();
        let metadata = RelayMetadata {
            binding: &binding,
            protocol_version: OPERATION_TRANSPORT_PROTOCOL_VERSION,
            request_id: Uuid::new_v4(),
            operation,
            counter: &counter,
        };
        RelayMessage::EncryptedOperationRequest {
            envelope: metadata.envelope(
                keys.encrypt_json(RelayDirection::Request, metadata, &input)
                    .unwrap(),
            ),
        }
    }

    async fn send(&self, app: &Router, message: RelayMessage) -> EncryptedRelayEnvelope {
        self.send_at(app, "/v1/operations", message).await
    }

    async fn send_at(
        &self,
        app: &Router,
        path: &str,
        message: RelayMessage,
    ) -> EncryptedRelayEnvelope {
        let response = app
            .clone()
            .oneshot(request(
                Method::POST,
                path,
                &self.origin,
                Some(&serde_json::to_string(&message).unwrap()),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), MAX_REQUEST_BYTES)
            .await
            .unwrap();
        serde_json::from_value::<EncryptedRelayEnvelope>(
            serde_json::from_slice::<serde_json::Value>(&bytes).unwrap()["envelope"].clone(),
        )
        .unwrap()
    }

    async fn file_control(
        &self,
        app: &Router,
        input: serde_json::Value,
        counter: u64,
    ) -> serde_json::Value {
        let request = self.encrypted_request("file_control", input, counter);
        let RelayMessage::EncryptedOperationRequest {
            envelope: request_envelope,
        } = request.clone()
        else {
            unreachable!()
        };
        let response = self.send_at(app, "/v1/files/control", request).await;
        let binding =
            RelayBinding::from_grant(self.grant_id, self.application_id, &self.encryption);
        let keys = self
            .application
            .derive(&self.encryption.connector_agreement_public_key, &binding)
            .unwrap();
        let metadata = RelayMetadata {
            binding: &binding,
            protocol_version: OPERATION_TRANSPORT_PROTOCOL_VERSION,
            request_id: request_envelope.request_id,
            operation: "file_control",
            counter: &request_envelope.counter,
        };
        keys.decrypt_json(RelayDirection::Response, metadata, &response.ciphertext)
            .unwrap()
    }

    async fn direct(
        &self,
        app: &Router,
        operation: &str,
        input: serde_json::Value,
        counter: u64,
    ) -> serde_json::Value {
        let request = self.encrypted_request(operation, input, counter);
        let RelayMessage::EncryptedOperationRequest {
            envelope: request_envelope,
        } = request.clone()
        else {
            unreachable!()
        };
        let response = self.send(app, request).await;
        let binding =
            RelayBinding::from_grant(self.grant_id, self.application_id, &self.encryption);
        let keys = self
            .application
            .derive(&self.encryption.connector_agreement_public_key, &binding)
            .unwrap();
        let metadata = RelayMetadata {
            binding: &binding,
            protocol_version: OPERATION_TRANSPORT_PROTOCOL_VERSION,
            request_id: request_envelope.request_id,
            operation,
            counter: &request_envelope.counter,
        };
        keys.decrypt_json(RelayDirection::Response, metadata, &response.ciphertext)
            .unwrap()
    }

    fn decrypt_response(
        &self,
        request: &EncryptedRelayEnvelope,
        response: &EncryptedRelayEnvelope,
    ) -> serde_json::Value {
        let binding =
            RelayBinding::from_grant(self.grant_id, self.application_id, &self.encryption);
        let keys = self
            .application
            .derive(&self.encryption.connector_agreement_public_key, &binding)
            .unwrap();
        let metadata = RelayMetadata {
            binding: &binding,
            protocol_version: OPERATION_TRANSPORT_PROTOCOL_VERSION,
            request_id: request.request_id,
            operation: &request.operation,
            counter: &request.counter,
        };
        keys.decrypt_json(RelayDirection::Response, metadata, &response.ciphertext)
            .unwrap()
    }
}

fn fixture() -> Fixture {
    fixture_for_origin("https://tasks.example", "web")
}

fn prepare_create_journal(
    fixture: &Fixture,
    input: &serde_json::Value,
    counter: u64,
) -> (RelayMessage, mdbase_connect_core::MutationLease) {
    let request = fixture.encrypted_request("create", input.clone(), counter);
    let RelayMessage::EncryptedOperationRequest { envelope } = &request else {
        unreachable!()
    };
    let (application_installation_id, grant_snapshot_digest) = fixture
        .registry
        .grant_mutation_identity(fixture.grant_id)
        .unwrap()
        .unwrap();
    let claim = fixture
        .registry
        .claim_mutation(&MutationClaimRequest {
            application_installation_id,
            grant_id: fixture.grant_id,
            request_id: envelope.request_id,
            operation_kind: "create".to_string(),
            input_schema_version: 1,
            input_digest: mutation_fingerprint("create", input).unwrap(),
            grant_snapshot_digest,
            allow_new: true,
        })
        .unwrap();
    let MutationClaim::Owned { lease, .. } = claim else {
        panic!("fresh mutation must own its lease")
    };
    let snapshot = fixture
        .registry
        .authority_snapshot(fixture.encryption.collection_id)
        .unwrap();
    fixture
        .registry
        .prepare_mutation(
            &lease,
            Some(&json!({
                "operation": "create",
                "collection_id": fixture.encryption.collection_id,
            })),
            Some(&json!({
                "kind": "collection_manifest",
                "manifest_digest": snapshot.manifest_digest,
            })),
        )
        .unwrap();
    (request, lease)
}

fn fixture_for_origin(origin: &str, distribution: &str) -> Fixture {
    let root = std::env::temp_dir().join(format!("mdbase-loopback-{}", Uuid::new_v4()));
    let registry = CollectionRegistry::open(root.join("state")).unwrap();
    let collection = registry
        .create(root.join("collection"), Some("Direct notes"), "UTC")
        .unwrap();
    let connector = RelayIdentity::generate();
    let application = RelayIdentity::generate();
    let application_id = Uuid::new_v4();
    let grant_id = Uuid::new_v4();
    let origin = origin.to_string();
    let connector_id = Uuid::new_v4();
    let encryption = GrantEncryption {
        protocol_version: mdbase_connect_protocol::GRANT_ENCRYPTION_PROTOCOL_VERSION,
        suite: RELAY_ENCRYPTION_SUITE.to_string(),
        key_id: "direct-key".to_string(),
        scope_epoch: 1,
        connector_id,
        collection_id: collection.id,
        application_agreement_public_key: application.public_key(),
        connector_agreement_public_key: connector.public_key(),
    };
    let operations = [
        "describe",
        "changes",
        "read",
        "query",
        "validate",
        "create",
        "update",
        "delete",
        "rename",
        "read_type",
        "create_type",
        "update_type",
        "assess_type_pack",
        "apply_type_pack",
        "assess_collection_setup",
        "apply_collection_setup",
        "list_views",
        "execute_view",
        "read_view_source",
        "create_view_source",
        "update_view_source",
        "delete_view_source",
        "list_timers",
        "put_timer",
        "cancel_timer",
        "reconcile_timers",
    ]
    .map(str::to_string)
    .to_vec();
    let file_capability = FileCapability {
        kind: FileCapabilityKind::Files,
        protocol_version: 1,
        actions: vec![
            FileAction::List,
            FileAction::Read,
            FileAction::Add,
            FileAction::Replace,
            FileAction::Move,
            FileAction::Delete,
        ],
        scope: FileScope::Collection,
    };
    let security = crate::test_support::application_security(
        crate::test_support::TestApplicationSecurityParams {
            application_id,
            authorization_id: Uuid::new_v4(),
            collection_id: collection.id,
            operations: &operations,
            distribution,
            grant_agreement_public_key: application.public_key(),
            file_capability: Some(&file_capability),
        },
    );
    registry
        .replace_grants(&[GrantPolicy {
            id: grant_id,
            application_id,
            collection_id: collection.id,
            operations,
            scope: GrantScope::full_collection(),
            application_name: "Tasks".to_string(),
            application_distribution: distribution.to_string(),
            application_homepage: if distribution == "web" {
                origin.clone()
            } else {
                String::new()
            },
            application_project_url: (distribution == "portable")
                .then(|| "https://example.test/portable".to_string()),
            application_origin: origin.clone(),
            application_icon: None,
            collection_name: "Direct notes".to_string(),
            notification_criteria: Vec::new(),
            created_at: "2026-07-22T00:00:00Z".to_string(),
            encryption: Some(encryption.clone()),
            file_capability: Some(file_capability),
            application_authorization: security.proof,
        }])
        .unwrap();
    let watcher = crate::watcher::CollectionWatchService::start(registry.clone());
    watcher.refresh(&registry.list().unwrap());
    Fixture {
        root,
        registry: registry.clone(),
        agent: Arc::new(AgentState::with_identity(
            registry,
            watcher,
            None,
            connector.clone(),
        )),
        origin,
        application,
        application_id,
        grant_id,
        encryption,
        connector,
    }
}

fn remove_fixture_after_watchers_close(root: &std::path::Path) {
    const ATTEMPTS: usize = 80;
    for attempt in 0..ATTEMPTS {
        match fs::remove_dir_all(root) {
            Ok(()) => return,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
            Err(error) if attempt + 1 == ATTEMPTS => {
                panic!(
                    "failed to remove fixture after watcher shutdown at {}: {error}",
                    root.display()
                );
            }
            Err(_) => std::thread::sleep(std::time::Duration::from_millis(25)),
        }
    }
}

fn request(method: Method, path: &str, origin: &str, body: Option<&str>) -> Request<Body> {
    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .header(HOST, "127.0.0.1:28485")
        .header(ORIGIN, origin);
    if body.is_some() {
        builder = builder.header(CONTENT_TYPE, "application/mdbase-connect+json");
    }
    builder
        .body(Body::from(body.unwrap_or_default().to_string()))
        .unwrap()
}
