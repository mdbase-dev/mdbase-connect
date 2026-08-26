#![allow(clippy::too_many_lines)]

//! Shared harness for the Phase 7 drain/revocation acceptance scenarios:
//! disposable provider instances, replica provisioning, signed ticket
//! issuance, and WebSocket framing plus close-code assertions.

use super::phase3_batch_tests::NoopBlobStore;
use super::*;
use crate::COLLABORATION_PROFILE;
use crate::{app, AppState};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use futures_util::{FutureExt, SinkExt, StreamExt};
use mdbase_connect_collaboration::MarkdownBodyDocument;
use mdbase_connect_protocol::{
    AwarenessColor, CollaborationAccess, CollaborationFrame, CollaborationMessageKind,
    ReplicaAwarenessIdentity, ReplicaCollaborationCapability, SyncMutation, SyncMutationOperation,
    SyncReplicaMode, AUTHORITY_PROOF_VERSION,
};
use p256::ecdsa::{signature::Signer, Signature};
use reqwest::header::{HeaderName, HeaderValue, AUTHORIZATION, CONTENT_TYPE, ORIGIN};
use sqlx::AssertSqlSafe;
use std::{net::SocketAddr, sync::Arc, time::Duration};
use tokio::net::TcpListener;
use tokio::time::timeout;
use tokio_tungstenite::{
    connect_async, tungstenite::client::IntoClientRequest, tungstenite::Message,
};
use uuid::Uuid;

/// The safe generic presentation identity used by development fixtures and
/// backfilled rows; carries no user, replica, grant, or session identifier.
pub(super) fn generic_awareness_identity() -> ReplicaAwarenessIdentity {
    ReplicaAwarenessIdentity {
        name: "Participant".into(),
        color: AwarenessColor::Slate,
    }
}

/// Local target-close fires immediately after the handler commits.
pub(super) const LOCAL_CLOSE_DEADLINE: Duration = Duration::from_millis(1500);
/// Server-driven reauthorization runs every two seconds, so a mutation
/// committed by any instance must close remote sessions well under four.
pub(super) const CROSS_INSTANCE_CLOSE_DEADLINE: Duration = Duration::from_secs(4);

pub(super) struct Instance {
    pub(super) provider: HostedProvider,
    pub(super) state: AppState,
    pub(super) address: SocketAddr,
    stop_server: tokio::sync::oneshot::Sender<()>,
    server: tokio::task::JoinHandle<()>,
}

pub(super) async fn start_instance(
    base: &str,
    schema: &str,
    internal_token: &'static str,
) -> Instance {
    let separator = if base.contains('?') { '&' } else { '?' };
    let url = format!("{base}{separator}options=-c%20search_path%3D{schema}%2Cpublic");
    let crypto = ProviderCrypto::from_base64(&URL_SAFE_NO_PAD.encode([7_u8; 32])).unwrap();
    let limits = ProviderLimits {
        hosted_collaboration_enabled: true,
        ..ProviderLimits::default()
    };
    let provider = HostedProvider::connect(&url, crypto, limits, Arc::new(NoopBlobStore), None)
        .await
        .unwrap();
    let state = AppState::new(provider.clone(), internal_token).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (stop_server, stop_rx) = tokio::sync::oneshot::channel();
    let server = tokio::spawn({
        let state = state.clone();
        async move {
            axum::serve(listener, app(state))
                .with_graceful_shutdown(async {
                    let _ = stop_rx.await;
                })
                .await
                .unwrap();
        }
    });
    Instance {
        provider,
        state,
        address,
        stop_server,
        server,
    }
}

pub(super) async fn stop_instance(instance: Instance) {
    // A final drain proves the runtime quiesces even when clients are gone.
    instance.state.begin_collaboration_session_drain();
    assert!(
        instance
            .state
            .finish_collaboration_session_drain(Duration::from_secs(5))
            .await
    );
    assert_eq!(
        instance.state.collaboration_tracked_sockets(),
        0,
        "session registry retained sockets after drain"
    );
    let _ = instance.stop_server.send(());
    timeout(Duration::from_secs(5), instance.server)
        .await
        .expect("server shutdown")
        .expect("server task");
    instance.provider.pool.close().await;
}

pub(super) async fn provision_collection(
    provider: &HostedProvider,
    account: Uuid,
    collection: Uuid,
) {
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
        .create_collection(account, collection, "mdbase", "Phase 7 drain/revoke", "UTC")
        .await
        .unwrap();
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn register_collab_replica(
    provider: &HostedProvider,
    collection: Uuid,
    replica_id: Uuid,
    name: &str,
    token: &str,
    signing: &p256::ecdsa::SigningKey,
    origin: &str,
) {
    provider
        .register_replica(
            collection,
            RegisterReplica {
                replica_id,
                name: name.into(),
                purpose: ReplicaPurpose::Application,
                mode: SyncReplicaMode::ReadWrite,
                allowed_types: Vec::new(),
                contract_scope: Vec::new(),
                full_collection: true,
                allowed_operations: vec!["create".into(), "read".into(), "update".into()],
                operation_transport_protocol: Some(3),
                operation_transport_recovery_protocols: vec![2],
                file_capability: None,

                awareness_identity: Some(ReplicaAwarenessIdentity {
                    name: "Participant".into(),
                    color: AwarenessColor::Slate,
                }),
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
                application_declaration_id: Some(name.into()),
                application_declaration_digest: Some(format!("sha256:{}", "a".repeat(64))),
                token: token.to_owned(),
                token_ttl_seconds: Some(3600),
            },
        )
        .await
        .unwrap();
}

pub(super) async fn put_record(
    provider: &HostedProvider,
    collection: Uuid,
    token: &str,
    replica: Uuid,
    record: Uuid,
    path: &str,
    origin: &str,
) {
    provider
        .mutate(
            collection,
            token,
            SyncMutation {
                mutation_id: Uuid::new_v4(),
                replica_id: replica,
                scope_epoch: 1,
                operation: SyncMutationOperation::Put,
                record_id: record,
                base_revision: None,
                path: Some(path.into()),
                document: Some("---\ntitle: phase7\n---\n\nBase body\n".into()),
                created_at: chrono::Utc::now().to_rfc3339(),
                causal_predecessor: None,
            },
            Some(origin),
        )
        .await
        .unwrap();
}

pub(super) async fn open_synced_session(
    instance: &Instance,
    http: &reqwest::Client,
    token: &str,
    signing: &p256::ecdsa::SigningKey,
    origin: &str,
    ticket_path: &str,
    record_path: &str,
) -> (
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    MarkdownBodyDocument,
) {
    let mut socket = ws(
        &format!("ws://{}/v1/collaboration", instance.address),
        origin,
    )
    .await;
    let ticket = ticket_http(
        http,
        instance.address,
        ticket_path,
        record_path,
        origin,
        token,
        signing,
    )
    .await;
    authenticate(&mut socket, &ticket).await;
    assert_eq!(
        recv_frame(&mut socket).await.kind,
        CollaborationMessageKind::Hello
    );
    let mut client = MarkdownBodyDocument::new("", 2 * 1024 * 1024).unwrap();
    socket
        .send(Message::Binary(sync_frame(client.state_vector_v1()).into()))
        .await
        .unwrap();
    // Membership begins only after SyncStep2 is delivered, but socket/network
    // scheduling may expose either frame first. Absorb both so callers start
    // from a clean stream.
    let mut synced = None;
    let mut joined = false;
    while synced.is_none() || !joined {
        let message = timeout(Duration::from_secs(4), recv_frame_inner(&mut socket))
            .await
            .expect("timed out waiting for sync/awareness frame");
        let frame = CollaborationFrame::decode(message.into_data().as_ref()).unwrap();
        match frame.kind {
            CollaborationMessageKind::Awareness => joined = true,
            CollaborationMessageKind::SyncStep2 => synced = Some(frame),
            other => panic!("unexpected frame kind {other:?} while syncing"),
        }
    }
    client
        .apply_update_v1(
            &synced.expect("sync response").payload,
            2 * 1024 * 1024,
            2 * 1024 * 1024,
        )
        .unwrap();
    (socket, client)
}

pub(super) async fn run_with_schema<F, Fut>(prefix: &str, run: F)
where
    F: FnOnce(String, String) -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let base = std::env::var("MDBASE_COLLABORATION_PHASE3_DATABASE_URL").expect("database URL");
    let admin = sqlx::PgPool::connect(&base).await.unwrap();
    let schema = format!("{prefix}_{}", Uuid::new_v4().simple());
    sqlx::query(AssertSqlSafe(format!("CREATE SCHEMA {schema}")))
        .execute(&admin)
        .await
        .unwrap();
    let result = std::panic::AssertUnwindSafe(run(base.clone(), schema.clone()))
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
// ---------------------------------------------------------------------------

pub(super) fn ticket_body(record_path: &str) -> Vec<u8> {
    serde_json::json!({"path": record_path, "profile": COLLABORATION_PROFILE, "mode": "read_write"})
        .to_string()
        .into_bytes()
}

pub(super) fn sync_frame(state_vector: Vec<u8>) -> Vec<u8> {
    CollaborationFrame {
        kind: CollaborationMessageKind::SyncStep1,
        metadata: Default::default(),
        payload: state_vector,
    }
    .encode()
    .unwrap()
}

pub(super) fn update_frame(mutation: Uuid, update: Vec<u8>) -> Vec<u8> {
    CollaborationFrame {
        kind: CollaborationMessageKind::Update,
        metadata: serde_json::json!({"client_mutation_id": mutation, "profile": COLLABORATION_PROFILE, "epoch": 1})
            .as_object()
            .unwrap()
            .clone(),
        payload: update,
    }
    .encode()
    .unwrap()
}

pub(super) async fn ws(
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

pub(super) async fn authenticate(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    ticket: &str,
) {
    socket
        .send(Message::Binary(
            CollaborationFrame {
                kind: CollaborationMessageKind::Authenticate,
                metadata: serde_json::json!({"ticket": ticket})
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

pub(super) async fn recv_frame_inner(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> Message {
    socket
        .next()
        .await
        .expect("socket ended")
        .expect("socket error")
}

// Sanitized awareness snapshots are legitimate background traffic on any
// authenticated socket; these scenarios never assert on them, so skip.
pub(super) async fn recv_frame(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> CollaborationFrame {
    loop {
        let message = timeout(Duration::from_secs(4), recv_frame_inner(socket))
            .await
            .expect("timed out waiting for a frame");
        let frame = CollaborationFrame::decode(message.into_data().as_ref()).unwrap();
        if frame.kind != CollaborationMessageKind::Awareness {
            return frame;
        }
    }
}

/// Require a server-initiated close carrying exactly `code` within `within`.
pub(super) async fn assert_close_code(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    code: u16,
) {
    match timeout(Duration::from_secs(3), socket.next()).await {
        Ok(Some(Ok(Message::Close(Some(frame))))) => {
            assert_eq!(u16::from(frame.code), code, "unexpected close code");
        }
        Ok(other) => panic!("expected close {code}, got {other:?}"),
        Err(_) => panic!("socket never received close {code}"),
    }
}

/// Deadline-bounded closure assertion: any binary frame fails immediately;
/// only the exact code passes.
pub(super) async fn assert_close_code_within(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    code: u16,
    within: Duration,
) {
    match timeout(within, socket.next()).await {
        Err(_) => panic!("socket never received close {code} within {within:?}"),
        Ok(None) => panic!("socket ended without close {code}"),
        Ok(Some(Err(error))) => panic!("socket errored before close {code}: {error}"),
        Ok(Some(Ok(Message::Close(Some(frame))))) => {
            assert_eq!(u16::from(frame.code), code, "unexpected close code");
        }
        Ok(Some(Ok(Message::Close(None)))) => {
            panic!("socket closed without a close code, expected {code}")
        }
        // Awareness snapshots may legally interleave with the close.
        Ok(Some(Ok(Message::Binary(_)))) => {
            Box::pin(assert_close_code_within(socket, code, within)).await
        }
        Ok(Some(Ok(message))) => {
            panic!("unexpected frame while awaiting close {code}: {message:?}")
        }
    }
}

pub(super) async fn timeout_short<T>(future: impl std::future::Future<Output = T>) -> Option<T> {
    timeout(Duration::from_millis(300), future).await.ok()
}

pub(super) async fn ticket_json(
    client: &reqwest::Client,
    address: SocketAddr,
    path: &str,
    body: &[u8],
    origin: &str,
    token: &str,
    signing: &p256::ecdsa::SigningKey,
) -> Value {
    let nonce = Uuid::new_v4();
    let mut proof = AuthorityRequestProof {
        version: AUTHORITY_PROOF_VERSION,
        timestamp: chrono::Utc::now().timestamp(),
        nonce,
        signature: String::new(),
        method: "POST".into(),
        target: path.to_owned(),
        body: body.to_vec(),
    };
    let signature: Signature = signing.sign(authority_proof_message(token, &proof).as_bytes());
    proof.signature = URL_SAFE_NO_PAD.encode(signature.to_bytes());
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
            proof.nonce.to_string(),
        )
        .header(
            HeaderName::from_static(mdbase_connect_protocol::AUTHORITY_PROOF_SIGNATURE_HEADER),
            proof.signature,
        )
        .body(body.to_vec())
        .send()
        .await
        .unwrap();
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    assert_eq!(
        status,
        reqwest::StatusCode::CREATED,
        "ticket endpoint returned {status}: {body}"
    );
    serde_json::from_str(&body).unwrap()
}

pub(super) async fn ticket_http(
    client: &reqwest::Client,
    address: SocketAddr,
    path: &str,
    record_path: &str,
    origin: &str,
    token: &str,
    signing: &p256::ecdsa::SigningKey,
) -> String {
    let body = ticket_body(record_path);
    ticket_json(client, address, path, &body, origin, token, signing).await["ticket"]
        .as_str()
        .unwrap()
        .to_owned()
}
