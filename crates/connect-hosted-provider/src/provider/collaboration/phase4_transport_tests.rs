#![allow(clippy::too_many_lines)]

use super::phase3_batch_tests::NoopBlobStore;
use super::*;
use crate::{app, AppState, COLLABORATION_PROFILE};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use futures_util::{FutureExt, SinkExt, StreamExt};
use mdbase_connect_collaboration::MarkdownBodyDocument;
use mdbase_connect_protocol::{
    CollaborationAccess, CollaborationFrame, CollaborationMessageKind,
    ReplicaCollaborationCapability, SyncMutation, SyncMutationOperation, SyncReplicaMode,
    AUTHORITY_PROOF_VERSION,
};
use p256::ecdsa::{signature::Signer, Signature};
use reqwest::header::{HeaderName, HeaderValue, AUTHORIZATION, CONTENT_TYPE, ORIGIN};
use sqlx::AssertSqlSafe;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::time::{timeout, Duration};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use uuid::Uuid;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a disposable MDBASE_COLLABORATION_PHASE3_DATABASE_URL PostgreSQL database"]
async fn phase3_real_two_headless_clients_postgres() {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let base = std::env::var("MDBASE_COLLABORATION_PHASE3_DATABASE_URL").expect("database URL");
    let admin = sqlx::PgPool::connect(&base).await.unwrap();
    let schema = format!("phase3_ws_{}", Uuid::new_v4().simple());
    sqlx::query(AssertSqlSafe(format!("CREATE SCHEMA {schema}")))
        .execute(&admin)
        .await
        .unwrap();
    let result = std::panic::AssertUnwindSafe(run_two_clients(&base, &schema))
        .catch_unwind()
        .await;
    sqlx::query(AssertSqlSafe(format!("DROP SCHEMA {schema} CASCADE")))
        .execute(&admin)
        .await
        .unwrap();
    admin.close().await;
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
}

async fn run_two_clients(base: &str, schema: &str) {
    let url = format!(
        "{base}{}options=-c%20search_path%3D{schema}%2Cpublic",
        if base.contains('?') { '&' } else { '?' }
    );
    let limits = ProviderLimits {
        hosted_collaboration_enabled: true,
        ..ProviderLimits::default()
    };
    let provider = HostedProvider::connect(
        &url,
        ProviderCrypto::from_base64(&URL_SAFE_NO_PAD.encode([7_u8; 32])).unwrap(),
        limits,
        Arc::new(NoopBlobStore),
        None,
    )
    .await
    .unwrap();
    let account = Uuid::new_v4();
    let collection = Uuid::new_v4();
    let record = Uuid::new_v4();
    let replica_a = Uuid::new_v4();
    let replica_b = Uuid::new_v4();
    let origin = "https://phase3.invalid";
    let token_a = format!("phase3-a-{}", Uuid::new_v4());
    let token_b = format!("phase3-b-{}", Uuid::new_v4());
    provider
        .upsert_account(
            account,
            1,
            ProviderAccountLimits {
                hosted_storage_bytes: 1 << 20,
                retained_file_bytes: 1 << 20,
                max_document_bytes: 1 << 20,
                max_single_file_bytes: 1 << 20,
                max_mirror_replicas_per_collection: 4,
                max_application_replicas_per_collection: 4,
                max_hosted_collections: 2,
                max_files_per_collection: 2,
            },
        )
        .await
        .unwrap();
    provider
        .create_collection(account, collection, "mdbase", "Phase 3 websocket", "UTC")
        .await
        .unwrap();
    let signing_a = p256::ecdsa::SigningKey::random(&mut rand_core::OsRng);
    let signing_b = p256::ecdsa::SigningKey::random(&mut rand_core::OsRng);
    for (replica, token, signing, app_id) in [
        (&replica_a, &token_a, &signing_a, "phase3.ws.a"),
        (&replica_b, &token_b, &signing_b, "phase3.ws.b"),
    ] {
        provider
            .register_replica(
                collection,
                RegisterReplica {
                    replica_id: *replica,
                    name: app_id.into(),
                    purpose: ReplicaPurpose::Application,
                    mode: SyncReplicaMode::ReadWrite,
                    allowed_types: Vec::new(),
                    contract_scope: Vec::new(),
                    full_collection: true,
                    allowed_operations: vec!["create".into(), "read".into(), "update".into()],
                    operation_transport_protocol: Some(3),
                    operation_transport_recovery_protocols: vec![2],
                    file_capability: None,

                    awareness_identity: Some(
                        super::phase7_drain_revoke_support::generic_awareness_identity(),
                    ),
                    collaboration_capability: Some(ReplicaCollaborationCapability {
                        contract_version: 1,
                        profiles: vec![COLLABORATION_PROFILE.into()],
                        access: CollaborationAccess::ReadWrite,
                    }),
                    allowed_origin: Some(origin.into()),
                    proof_public_key: Some(
                        URL_SAFE_NO_PAD
                            .encode(signing.verifying_key().to_encoded_point(false).as_bytes()),
                    ),
                    grant_id: Some(Uuid::new_v4()),
                    application_declaration_id: Some(app_id.into()),
                    application_declaration_digest: Some(format!("sha256:{}", "a".repeat(64))),
                    token: token.clone(),
                    token_ttl_seconds: Some(3600),
                },
            )
            .await
            .unwrap();
    }
    let document = "---\ntitle: websocket\n---\n\nInitial body\n";
    provider
        .mutate(
            collection,
            &token_a,
            SyncMutation {
                mutation_id: Uuid::new_v4(),
                replica_id: replica_a,
                scope_epoch: 1,
                operation: SyncMutationOperation::Put,
                record_id: record,
                base_revision: None,
                path: Some("notes/test.md".into()),
                document: Some(document.into()),
                created_at: chrono::Utc::now().to_rfc3339(),
                causal_predecessor: None,
            },
            Some(origin),
        )
        .await
        .unwrap();

    let state = AppState::new(
        provider.clone(),
        "phase3-internal-token-012345678901234567890",
    )
    .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (stop_tx, stop_rx) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        axum::serve(listener, app(state))
            .with_graceful_shutdown(async {
                let _ = stop_rx.await;
            })
            .await
            .unwrap();
    });
    let http = reqwest::Client::new();
    let path = format!("/v1/authorities/{collection}/collaboration/tickets");
    // Ticket bodies intentionally omit the epoch: issuance always resolves the
    // durable fence's current epoch, so requests stay valid across conventional
    // retirements.
    let body = br#"{"path":"notes/test.md","profile":"markdown-body-yjs-v13","mode":"read_write"}"#;
    let ticket_a = ticket_http(
        &http,
        address,
        &path,
        body,
        origin,
        &token_a,
        &signing_a,
        Uuid::new_v4(),
    )
    .await;
    let ticket_b = ticket_http(
        &http,
        address,
        &path,
        body,
        origin,
        &token_b,
        &signing_b,
        Uuid::new_v4(),
    )
    .await;
    let ws_url = format!("ws://{address}/v1/collaboration");
    let mut preauth = ws(&ws_url, origin).await;
    preauth
        .send(Message::Binary(
            CollaborationFrame {
                kind: CollaborationMessageKind::SyncStep1,
                metadata: Default::default(),
                payload: Vec::new(),
            }
            .encode()
            .unwrap()
            .into(),
        ))
        .await
        .unwrap();
    assert_closed_without_binary(&mut preauth).await;
    let mut a = ws(&ws_url, origin).await;
    let mut b = ws(&ws_url, origin).await;
    assert!(timeout_short(a.next()).await.is_none());
    assert!(timeout_short(b.next()).await.is_none());
    authenticate(&mut a, &ticket_a).await;
    authenticate(&mut b, &ticket_b).await;
    assert_eq!(
        recv_frame(&mut a).await.kind,
        CollaborationMessageKind::Hello
    );
    assert_eq!(
        recv_frame(&mut b).await.kind,
        CollaborationMessageKind::Hello
    );
    let mut client_a = MarkdownBodyDocument::new("", 2 * 1024 * 1024).unwrap();
    let mut client_b = MarkdownBodyDocument::new("", 2 * 1024 * 1024).unwrap();
    let sync1 = CollaborationFrame {
        kind: CollaborationMessageKind::SyncStep1,
        metadata: Default::default(),
        payload: client_a.state_vector_v1(),
    }
    .encode()
    .unwrap();
    a.send(Message::Binary(sync1.clone().into())).await.unwrap();
    b.send(Message::Binary(sync1.into())).await.unwrap();
    // Awareness join snapshots may legally interleave with sync responses.
    let sync_a = loop {
        let frame = recv_frame(&mut a).await;
        if frame.kind != CollaborationMessageKind::Awareness {
            assert_eq!(frame.kind, CollaborationMessageKind::SyncStep2);
            break frame;
        }
    };
    let sync_b = loop {
        let frame = recv_frame(&mut b).await;
        if frame.kind != CollaborationMessageKind::Awareness {
            assert_eq!(frame.kind, CollaborationMessageKind::SyncStep2);
            break frame;
        }
    };
    client_a
        .apply_update_v1(&sync_a.payload, 2 * 1024 * 1024, 2 * 1024 * 1024)
        .unwrap();
    client_b
        .apply_update_v1(&sync_b.payload, 2 * 1024 * 1024, 2 * 1024 * 1024)
        .unwrap();
    assert_eq!(client_a.body(), "\nInitial body\n");
    assert_eq!(client_b.body(), "\nInitial body\n");
    let update = client_a
        .apply_provider_body("\nInitial body\nAdded by A\n", 2 * 1024 * 1024)
        .unwrap();
    let mutation = Uuid::new_v4();
    let update_frame = CollaborationFrame { kind: CollaborationMessageKind::Update, metadata: serde_json::json!({"client_mutation_id":mutation,"profile":COLLABORATION_PROFILE,"epoch":1}).as_object().unwrap().clone(), payload: update.clone() }.encode().unwrap();
    a.send(Message::Binary(update_frame.clone().into()))
        .await
        .unwrap();
    let ack = recv_frame(&mut a).await;
    assert_eq!(ack.kind, CollaborationMessageKind::Acknowledged);
    assert_eq!(
        ack.metadata
            .get("client_mutation_id")
            .and_then(Value::as_str),
        Some(mutation.to_string().as_str())
    );
    let acknowledged_record_sequence = ack
        .metadata
        .get("record_sequence")
        .and_then(Value::as_u64)
        .unwrap();
    let durable: (i64, i64) = sqlx::query_as("SELECT (SELECT count(*) FROM hosted_provider_collaboration_receipts WHERE collection_id=$1 AND record_id=$2), (SELECT sequence FROM hosted_provider_records WHERE collection_id=$1 AND record_id=$2)").bind(collection).bind(record).fetch_one(&provider.pool).await.unwrap();
    assert_eq!(durable.0, 1);
    assert_eq!(acknowledged_record_sequence, 2);
    assert_eq!(
        u64::try_from(durable.1).unwrap(),
        acknowledged_record_sequence
    );
    let broadcast = recv_frame(&mut b).await;
    assert_eq!(broadcast.kind, CollaborationMessageKind::Update);
    client_b
        .apply_update_v1(&broadcast.payload, 2 * 1024 * 1024, 2 * 1024 * 1024)
        .unwrap();
    assert_eq!(client_b.body(), "\nInitial body\nAdded by A\n");
    a.send(Message::Binary(update_frame.into())).await.unwrap();
    assert_eq!(
        recv_frame(&mut a).await.kind,
        CollaborationMessageKind::Acknowledged
    );
    assert!(timeout_short(b.next()).await.is_none());
    let replay = ws(&ws_url, origin).await;
    let mut replay = replay;
    authenticate(&mut replay, &ticket_a).await;
    assert_closed_without_binary(&mut replay).await;

    let mut text = ws(&ws_url, origin).await;
    text.send(Message::Text("bad".into())).await.unwrap();
    assert_closed_without_binary(&mut text).await;
    let mut malformed = ws(&ws_url, origin).await;
    malformed
        .send(Message::Binary(
            CollaborationFrame {
                kind: CollaborationMessageKind::Authenticate,
                metadata: serde_json::json!({"ticket": ticket_b, "extra": true})
                    .as_object()
                    .unwrap()
                    .clone(),
                payload: Vec::new(),
            }
            .encode()
            .unwrap()
            .into(),
        ))
        .await
        .unwrap();
    assert_closed_without_binary(&mut malformed).await;

    let reconnect_ticket = ticket_http(
        &http,
        address,
        &path,
        body,
        origin,
        &token_b,
        &signing_b,
        Uuid::new_v4(),
    )
    .await;
    let mut reconnect = ws(&ws_url, origin).await;
    authenticate(&mut reconnect, &reconnect_ticket).await;
    assert_eq!(
        recv_frame(&mut reconnect).await.kind,
        CollaborationMessageKind::Hello
    );
    let mut reloaded = MarkdownBodyDocument::new("", 2 * 1024 * 1024).unwrap();
    reconnect
        .send(Message::Binary(
            CollaborationFrame {
                kind: CollaborationMessageKind::SyncStep1,
                metadata: Default::default(),
                payload: reloaded.state_vector_v1(),
            }
            .encode()
            .unwrap()
            .into(),
        ))
        .await
        .unwrap();
    let durable_sync = loop {
        let frame = recv_frame(&mut reconnect).await;
        if frame.kind != CollaborationMessageKind::Awareness {
            assert_eq!(frame.kind, CollaborationMessageKind::SyncStep2);
            break frame;
        }
    };
    reloaded
        .apply_update_v1(&durable_sync.payload, 2 * 1024 * 1024, 2 * 1024 * 1024)
        .unwrap();
    assert_eq!(reloaded.body(), "\nInitial body\nAdded by A\n");

    // Conventional-writer epoch reconciliation: an ordinary exact update of
    // the collaborated record atomically advances the fence and retires every
    // old room, ticket, update, and receipt. Admission then reopens the room
    // at the advanced epoch, and a live session from before the retirement is
    // denied on its next heartbeat.
    let ordinary_document =
        "---\ntitle: websocket\n---\n\nInitial body\nAdded by A\nOrdinary writer pass\n";
    let revision: String = sqlx::query_scalar(
        "SELECT r.revision FROM hosted_provider_records r
         WHERE r.collection_id=$1 AND r.record_id=$2",
    )
    .bind(collection)
    .bind(record)
    .fetch_one(&provider.pool)
    .await
    .unwrap();
    provider
        .mutate(
            collection,
            &token_a,
            SyncMutation {
                mutation_id: Uuid::new_v4(),
                replica_id: replica_a,
                scope_epoch: 1,
                operation: SyncMutationOperation::Put,
                record_id: record,
                base_revision: Some(revision),
                path: Some("notes/test.md".into()),
                document: Some(ordinary_document.into()),
                created_at: chrono::Utc::now().to_rfc3339(),
                causal_predecessor: None,
            },
            Some(origin),
        )
        .await
        .unwrap();
    let retired: (i64, i64, i64, i64, i64) = sqlx::query_as(
        "SELECT f.current_epoch,
                (SELECT count(*) FROM hosted_provider_collaboration_documents WHERE collection_id=$1 AND record_id=$2),
                (SELECT count(*) FROM hosted_provider_collaboration_updates WHERE collection_id=$1 AND record_id=$2),
                (SELECT count(*) FROM hosted_provider_collaboration_receipts WHERE collection_id=$1 AND record_id=$2),
                (SELECT count(*) FROM hosted_provider_collaboration_tickets WHERE collection_id=$1 AND record_id=$2)
         FROM hosted_provider_collaboration_epoch_fences f
         WHERE f.collection_id=$1 AND f.record_id=$2",
    )
    .bind(collection)
    .bind(record)
    .fetch_one(&provider.pool)
    .await
    .unwrap();
    assert_eq!(retired, (2, 0, 0, 0, 0));
    let readmission_body = ticket_json(
        &http,
        address,
        &path,
        body,
        origin,
        &token_b,
        &signing_b,
        Uuid::new_v4(),
    )
    .await;
    assert_eq!(readmission_body["epoch"], 2);
    let readmission_ticket = readmission_body["ticket"].as_str().unwrap().to_owned();
    let mut readmitted = ws(&ws_url, origin).await;
    authenticate(&mut readmitted, &readmission_ticket).await;
    assert_eq!(
        recv_frame(&mut readmitted).await.kind,
        CollaborationMessageKind::Hello
    );
    let mut readmit_client = MarkdownBodyDocument::new("", 2 * 1024 * 1024).unwrap();
    readmitted
        .send(Message::Binary(
            CollaborationFrame {
                kind: CollaborationMessageKind::SyncStep1,
                metadata: Default::default(),
                payload: readmit_client.state_vector_v1(),
            }
            .encode()
            .unwrap()
            .into(),
        ))
        .await
        .unwrap();
    let readmit_sync = loop {
        let frame = recv_frame(&mut readmitted).await;
        if frame.kind != CollaborationMessageKind::Awareness {
            assert_eq!(frame.kind, CollaborationMessageKind::SyncStep2);
            break frame;
        }
    };
    readmit_client
        .apply_update_v1(&readmit_sync.payload, 2 * 1024 * 1024, 2 * 1024 * 1024)
        .unwrap();
    assert_eq!(
        readmit_client.body(),
        "\nInitial body\nAdded by A\nOrdinary writer pass\n"
    );
    let second_revision: String = sqlx::query_scalar(
        "SELECT r.revision FROM hosted_provider_records r
         WHERE r.collection_id=$1 AND r.record_id=$2",
    )
    .bind(collection)
    .bind(record)
    .fetch_one(&provider.pool)
    .await
    .unwrap();
    provider
        .mutate(
            collection,
            &token_a,
            SyncMutation {
                mutation_id: Uuid::new_v4(),
                replica_id: replica_a,
                scope_epoch: 1,
                operation: SyncMutationOperation::Put,
                record_id: record,
                base_revision: Some(second_revision),
                path: Some("notes/test.md".into()),
                document: Some(
                    "---\ntitle: websocket\n---\n\nInitial body\nAdded by A\nSecond ordinary pass\n"
                        .into(),
                ),
                created_at: chrono::Utc::now().to_rfc3339(),
                causal_predecessor: None,
            },
            Some(origin),
        )
        .await
        .unwrap();
    let fence_after_second: i64 = sqlx::query_scalar(
        "SELECT current_epoch FROM hosted_provider_collaboration_epoch_fences
         WHERE collection_id=$1 AND record_id=$2",
    )
    .bind(collection)
    .bind(record)
    .fetch_one(&provider.pool)
    .await
    .unwrap();
    assert_eq!(fence_after_second, 3);
    readmitted
        .send(Message::Binary(
            CollaborationFrame {
                kind: CollaborationMessageKind::Heartbeat,
                metadata: Default::default(),
                payload: Vec::new(),
            }
            .encode()
            .unwrap()
            .into(),
        ))
        .await
        .unwrap();
    assert_closed_without_binary(&mut readmitted).await;
    let _ = readmitted.close(None).await;

    let large_record = Uuid::new_v4();
    provider
        .mutate(
            collection,
            &token_a,
            SyncMutation {
                mutation_id: Uuid::new_v4(),
                replica_id: replica_a,
                scope_epoch: 1,
                operation: SyncMutationOperation::Put,
                record_id: large_record,
                base_revision: None,
                path: Some("notes/large.md".into()),
                document: Some(format!("---\ntitle: large\n---\n\n{}", "x".repeat(300_000))),
                created_at: chrono::Utc::now().to_rfc3339(),
                causal_predecessor: None,
            },
            Some(origin),
        )
        .await
        .unwrap();
    let large_ticket_body = serde_json::to_vec(&serde_json::json!({
        "path": "notes/large.md",
        "profile": COLLABORATION_PROFILE,
        "mode": "read_write",
        "epoch": 1
    }))
    .unwrap();
    let large_ticket = ticket_http(
        &http,
        address,
        &path,
        &large_ticket_body,
        origin,
        &token_a,
        &signing_a,
        Uuid::new_v4(),
    )
    .await;
    let mut large_sync = ws(&ws_url, origin).await;
    authenticate(&mut large_sync, &large_ticket).await;
    assert_eq!(
        recv_frame(&mut large_sync).await.kind,
        CollaborationMessageKind::Hello
    );
    let empty = MarkdownBodyDocument::new("", 2 * 1024 * 1024).unwrap();
    large_sync
        .send(Message::Binary(
            CollaborationFrame {
                kind: CollaborationMessageKind::SyncStep1,
                metadata: Default::default(),
                payload: empty.state_vector_v1(),
            }
            .encode()
            .unwrap()
            .into(),
        ))
        .await
        .unwrap();
    assert_closed_without_binary(&mut large_sync).await;

    let wrong_origin_ticket = ticket_http(
        &http,
        address,
        &path,
        body,
        origin,
        &token_a,
        &signing_a,
        Uuid::new_v4(),
    )
    .await;
    let mut wrong_origin = ws(&ws_url, "https://wrong.invalid").await;
    authenticate(&mut wrong_origin, &wrong_origin_ticket).await;
    assert_closed_without_binary(&mut wrong_origin).await;

    let mut oversized = ws(&ws_url, origin).await;
    let _ = oversized
        .send(Message::Binary(
            vec![0_u8; mdbase_connect_protocol::MAX_COLLABORATION_FRAME_BYTES + 1].into(),
        ))
        .await;
    assert_closed_without_binary(&mut oversized).await;

    provider.revoke_replica(replica_a).await.unwrap();
    a.send(Message::Binary(
        CollaborationFrame {
            kind: CollaborationMessageKind::Heartbeat,
            metadata: Default::default(),
            payload: Vec::new(),
        }
        .encode()
        .unwrap()
        .into(),
    ))
    .await
    .unwrap();
    assert_closed_without_binary(&mut a).await;

    let _ = a.close(None).await;
    let _ = b.close(None).await;
    let _ = replay.close(None).await;
    let _ = text.close(None).await;
    let _ = malformed.close(None).await;
    let _ = reconnect.close(None).await;
    let _ = wrong_origin.close(None).await;
    let _ = large_sync.close(None).await;
    let _ = oversized.close(None).await;
    let _ = preauth.close(None).await;
    let _ = stop_tx.send(());
    timeout(Duration::from_secs(2), server)
        .await
        .unwrap()
        .unwrap();

    let disabled = ProviderLimits {
        hosted_collaboration_enabled: false,
        ..ProviderLimits::default()
    };
    let disabled_provider = HostedProvider::connect(
        &url,
        ProviderCrypto::from_base64(&URL_SAFE_NO_PAD.encode([7_u8; 32])).unwrap(),
        disabled,
        Arc::new(NoopBlobStore),
        None,
    )
    .await
    .unwrap();
    let disabled_app = app(AppState::new(
        disabled_provider,
        "phase3-internal-token-012345678901234567890",
    )
    .unwrap());
    let disabled_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let disabled_address = disabled_listener.local_addr().unwrap();
    let (disabled_stop_tx, disabled_stop_rx) = tokio::sync::oneshot::channel();
    let disabled_server = tokio::spawn(async move {
        axum::serve(disabled_listener, disabled_app)
            .with_graceful_shutdown(async {
                let _ = disabled_stop_rx.await;
            })
            .await
            .unwrap();
    });
    let response = http
        .post(format!("http://{disabled_address}{path}"))
        .body(body.to_vec())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        response.json::<Value>().await.unwrap()["error"]["code"],
        "collaboration_unavailable"
    );
    let mut disabled_upgrade = format!("ws://{disabled_address}/v1/collaboration")
        .into_client_request()
        .unwrap();
    disabled_upgrade
        .headers_mut()
        .insert(ORIGIN, HeaderValue::from_static("https://phase3.invalid"));
    match connect_async(disabled_upgrade).await {
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
            assert_eq!(response.status(), reqwest::StatusCode::SERVICE_UNAVAILABLE);
        }
        other => panic!("unexpected disabled collaboration upgrade result: {other:?}"),
    }
    let _ = disabled_stop_tx.send(());
    timeout(Duration::from_secs(2), disabled_server)
        .await
        .unwrap()
        .unwrap();
}

#[allow(clippy::too_many_arguments)]
async fn ticket_http(
    client: &reqwest::Client,
    address: std::net::SocketAddr,
    path: &str,
    body: &[u8],
    origin: &str,
    token: &str,
    signing: &p256::ecdsa::SigningKey,
    nonce: Uuid,
) -> String {
    ticket_json(client, address, path, body, origin, token, signing, nonce).await["ticket"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[allow(clippy::too_many_arguments)]
async fn ticket_json(
    client: &reqwest::Client,
    address: std::net::SocketAddr,
    path: &str,
    body: &[u8],
    origin: &str,
    token: &str,
    signing: &p256::ecdsa::SigningKey,
    nonce: Uuid,
) -> Value {
    let proof = signed_http_proof(signing, token, path, body, nonce);
    let response = client
        .post(format!("http://{address}{path}"))
        .header(AUTHORIZATION, format!("Bearer {token}"))
        .header(ORIGIN, origin)
        .header(CONTENT_TYPE, "application/json")
        .header(
            HeaderName::from_static(mdbase_connect_protocol::AUTHORITY_PROOF_VERSION_HEADER),
            proof.version.to_string(),
        )
        .header(
            HeaderName::from_static(mdbase_connect_protocol::AUTHORITY_PROOF_TIMESTAMP_HEADER),
            proof.timestamp.to_string(),
        )
        .header(
            HeaderName::from_static(mdbase_connect_protocol::AUTHORITY_PROOF_NONCE_HEADER),
            nonce.to_string(),
        )
        .header(
            HeaderName::from_static(mdbase_connect_protocol::AUTHORITY_PROOF_SIGNATURE_HEADER),
            proof.signature,
        )
        .body(body.to_vec())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::CREATED);
    assert_eq!(
        response.headers().get(reqwest::header::CACHE_CONTROL),
        Some(&HeaderValue::from_static("no-store"))
    );
    response.json::<Value>().await.unwrap()
}

fn signed_http_proof(
    signing: &p256::ecdsa::SigningKey,
    token: &str,
    path: &str,
    body: &[u8],
    nonce: Uuid,
) -> AuthorityRequestProof {
    let mut proof = AuthorityRequestProof {
        version: AUTHORITY_PROOF_VERSION,
        timestamp: chrono::Utc::now().timestamp(),
        nonce,
        signature: String::new(),
        method: "POST".into(),
        target: path.into(),
        body: body.to_vec(),
    };
    let signature: Signature = signing.sign(authority_proof_message(token, &proof).as_bytes());
    proof.signature = URL_SAFE_NO_PAD.encode(signature.to_bytes());
    proof
}

async fn ws(
    url: &str,
    origin: &str,
) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>> {
    let mut request = url.into_client_request().unwrap();
    request
        .headers_mut()
        .insert(ORIGIN, HeaderValue::from_str(origin).unwrap());
    let (socket, _) = connect_async(request).await.unwrap();
    socket
}
async fn authenticate(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    ticket: &str,
) {
    socket
        .send(Message::Binary(
            CollaborationFrame {
                kind: CollaborationMessageKind::Authenticate,
                metadata: serde_json::json!({"ticket":ticket})
                    .as_object()
                    .unwrap()
                    .clone(),
                payload: Vec::new(),
            }
            .encode()
            .unwrap()
            .into(),
        ))
        .await
        .unwrap();
}
// Sanitized awareness snapshots are legitimate background traffic on any
// authenticated socket; these scenarios never assert on them, so skip.
async fn recv_frame(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> CollaborationFrame {
    loop {
        let message = timeout(Duration::from_secs(2), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let frame = CollaborationFrame::decode(message.into_data().as_ref()).unwrap();
        if frame.kind != CollaborationMessageKind::Awareness {
            return frame;
        }
    }
}
async fn assert_closed_without_binary(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) {
    loop {
        match timeout(Duration::from_secs(1), socket.next()).await {
            Ok(None | Some(Ok(Message::Close(_)))) => return,
            // Sanitized awareness snapshots carry no record content and may
            // legally interleave with any post-authentication close.
            Ok(Some(Ok(message @ Message::Binary(_)))) => {
                if let Ok(frame) = CollaborationFrame::decode(match &message {
                    Message::Binary(bytes) => bytes.as_ref(),
                    _ => unreachable!(),
                }) {
                    if frame.kind == CollaborationMessageKind::Awareness {
                        continue;
                    }
                }
                panic!("unexpected pre-auth message: {message:?}");
            }
            Ok(Some(Ok(other))) => panic!("unexpected pre-auth message: {other:?}"),
            Ok(Some(Err(_))) => return,
            Err(_) => panic!("invalid collaboration socket remained open"),
        }
    }
}

async fn timeout_short<T>(future: T) -> Option<T::Output>
where
    T: std::future::Future,
{
    timeout(Duration::from_millis(200), future).await.ok()
}
