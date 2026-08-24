//! Shared harness for the Phase 8 awareness acceptance scenarios. Reuses the
//! Phase 7 instance/ticket/socket helpers and adds identity-aware replica
//! registration plus complete-snapshot assertions.

use super::phase3_batch_tests::NoopBlobStore;
pub(super) use super::phase7_drain_revoke_support::provision_collection;
use super::phase7_drain_revoke_support::ticket_json;
use super::*;
use crate::COLLABORATION_PROFILE;
use crate::{app, AppState};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use futures_util::SinkExt;
use mdbase_connect_protocol::{
    AwarenessColor, CollaborationFrame, CollaborationMessageKind, ReplicaAwarenessIdentity,
    ReplicaCollaborationCapability, ServerAwarenessSnapshot,
};
use reqwest::header::{HeaderValue, ORIGIN};
use serde_json::{json, Value};
use std::{net::SocketAddr, sync::Arc, time::Duration};
use tokio::net::TcpListener;
use tokio::time::timeout;
use tokio_tungstenite::{
    connect_async, tungstenite::client::IntoClientRequest, tungstenite::Message,
};

pub(super) fn awareness_hello_advertisement() -> Value {
    json!({
        "version": 1,
        "scope": "provider_instance",
        "max_participants": 16,
        "max_selections": 4,
        "max_updates_per_second": 8,
        "ttl_seconds": 30
    })
}

/// Disposable single-purpose provider instance.
pub(super) struct Instance {
    pub(super) provider: HostedProvider,
    pub(super) state: AppState,
    pub(super) address: SocketAddr,
    stop_server: tokio::sync::oneshot::Sender<()>,
    server: tokio::task::JoinHandle<()>,
}

pub(super) async fn start_instance(base: &str, schema: &str) -> Instance {
    start_instance_with_limits(
        base,
        schema,
        ProviderLimits {
            hosted_collaboration_enabled: true,
            ..ProviderLimits::default()
        },
    )
    .await
}

pub(super) async fn start_instance_with_limits(
    base: &str,
    schema: &str,
    limits: ProviderLimits,
) -> Instance {
    let separator = if base.contains('?') { '&' } else { '?' };
    let url = format!("{base}{separator}options=-c%20search_path%3D{schema}%2Cpublic");
    let crypto = ProviderCrypto::from_base64(&URL_SAFE_NO_PAD.encode([7_u8; 32])).unwrap();
    let provider = HostedProvider::connect(&url, crypto, limits, Arc::new(NoopBlobStore), None)
        .await
        .unwrap();
    let state = AppState::new(provider.clone(), "phase8-awareness-internal-0123456789").unwrap();
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
    assert_eq!(
        instance.state.awareness_participant_count(),
        0,
        "awareness state survived drain"
    );
    let _ = instance.stop_server.send(());
    timeout(Duration::from_secs(5), instance.server)
        .await
        .expect("server shutdown")
        .expect("server task");
    instance.provider.pool.close().await;
}

/// Teardown for an instance that was already drained externally.
pub(super) async fn shutdown_without_drain(instance: Instance) {
    assert_eq!(instance.state.awareness_participant_count(), 0);
    let _ = instance.stop_server.send(());
    timeout(Duration::from_secs(5), instance.server)
        .await
        .expect("server shutdown")
        .expect("server task");
    instance.provider.pool.close().await;
}

/// Register an application replica carrying a collaboration capability and a
/// server-derived presentation identity.
#[allow(clippy::too_many_arguments)]
pub(super) async fn register_collab_replica(
    provider: &HostedProvider,
    collection: Uuid,
    replica_id: Uuid,
    display_name: &str,
    color: AwarenessColor,
    mode: SyncReplicaMode,
    token: &str,
    signing: &p256::ecdsa::SigningKey,
    origin: &str,
) {
    provider
        .register_replica(
            collection,
            RegisterReplica {
                replica_id,
                name: format!("{display_name} application access"),
                purpose: ReplicaPurpose::Application,
                mode,
                allowed_types: Vec::new(),
                contract_scope: Vec::new(),
                full_collection: true,
                allowed_operations: if mode == SyncReplicaMode::ReadWrite {
                    vec!["create".into(), "read".into(), "update".into()]
                } else {
                    vec!["read".into()]
                },
                operation_transport_protocol: Some(3),
                operation_transport_recovery_protocols: vec![2],
                file_capability: None,
                awareness_identity: Some(ReplicaAwarenessIdentity {
                    name: display_name.into(),
                    color,
                }),
                collaboration_capability: Some(ReplicaCollaborationCapability {
                    contract_version: 1,
                    profiles: vec![COLLABORATION_PROFILE.into()],
                    access: if mode == SyncReplicaMode::ReadWrite {
                        CollaborationAccess::ReadWrite
                    } else {
                        CollaborationAccess::ReadOnly
                    },
                }),
                allowed_origin: Some(origin.into()),
                proof_public_key: Some(
                    URL_SAFE_NO_PAD
                        .encode(signing.verifying_key().to_encoded_point(false).as_bytes()),
                ),
                grant_id: Some(Uuid::new_v4()),
                application_declaration_id: Some("phase8.app".into()),
                application_declaration_digest: Some(format!("sha256:{}", "a".repeat(64))),
                token: token.to_owned(),
                token_ttl_seconds: Some(3600),
            },
        )
        .await
        .expect("collaboration replica registration must succeed");
}

/// Build an awareness frame with exactly the allowed client metadata.
pub(super) fn awareness_update_frame(status: &str, selections: Value) -> CollaborationFrame {
    CollaborationFrame {
        kind: CollaborationMessageKind::Awareness,
        metadata: json!({"status": status, "selections": selections})
            .as_object()
            .unwrap()
            .clone(),
        payload: Vec::new(),
    }
}

/// Build an awareness frame carrying arbitrary metadata/payload for negative
/// scenarios.
pub(super) fn raw_awareness_frame(metadata: Value, payload: Vec<u8>) -> CollaborationFrame {
    CollaborationFrame {
        kind: CollaborationMessageKind::Awareness,
        metadata: metadata.as_object().expect("metadata object").clone(),
        payload,
    }
}

/// Any websocket half that frames can be read from.
pub(super) trait FrameSource:
    futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin
{
}

impl<T> FrameSource for T where
    T: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin
{
}

async fn recv_message(socket: &mut impl FrameSource) -> Message {
    use futures_util::StreamExt;
    timeout(Duration::from_secs(8), socket.next())
        .await
        .expect("timed out waiting for a frame")
        .expect("socket ended")
        .expect("socket error")
}

/// Receive the next frame as a validated complete replacement snapshot.
pub(super) async fn recv_snapshot(socket: &mut impl FrameSource) -> ServerAwarenessSnapshot {
    let message = recv_message(socket).await;
    let Message::Binary(bytes) = message else {
        panic!("expected a binary snapshot frame, got {message:?}");
    };
    let frame = CollaborationFrame::decode(bytes.as_ref()).unwrap();
    assert_eq!(frame.kind, CollaborationMessageKind::Awareness);
    assert!(frame.payload.is_empty());
    let snapshot: ServerAwarenessSnapshot =
        serde_json::from_value(Value::Object(frame.metadata)).unwrap();
    snapshot
}

/// Receive the next frame as any decoded frame (binary), failing on close.
pub(super) async fn recv_any_frame(socket: &mut impl FrameSource) -> CollaborationFrame {
    let message = recv_message(socket).await;
    let Message::Binary(bytes) = message else {
        panic!("expected a binary frame, got {message:?}");
    };
    CollaborationFrame::decode(bytes.as_ref()).unwrap()
}

/// Issue a fresh one-shot ticket over HTTP with a signed proof.
#[allow(clippy::too_many_arguments)]
pub(super) async fn fresh_ticket(
    http: &reqwest::Client,
    address: SocketAddr,
    collection: Uuid,
    record_path: &str,
    origin: &str,
    token: &str,
    signing: &p256::ecdsa::SigningKey,
    mode: SyncReplicaMode,
) -> String {
    let body = json!({
        "path": record_path,
        "profile": COLLABORATION_PROFILE,
        "mode": if mode == SyncReplicaMode::ReadWrite { "read_write" } else { "read_only" }
    })
    .to_string()
    .into_bytes();
    ticket_json(
        http,
        address,
        format!("/v1/authorities/{collection}/collaboration/tickets").as_str(),
        &body,
        origin,
        token,
        signing,
    )
    .await["ticket"]
        .as_str()
        .unwrap()
        .to_owned()
}

/// Open a socket, authenticate with a fresh ticket, verify the Hello
/// advertisement, sync, and absorb the join snapshot. Returns the socket plus
/// the participants observed at join time.
#[allow(clippy::too_many_arguments)]
pub(super) async fn open_awareness_session(
    instance: &Instance,
    http: &reqwest::Client,
    collection: Uuid,
    token: &str,
    signing: &p256::ecdsa::SigningKey,
    origin: &str,
    record_path: &str,
    mode: SyncReplicaMode,
) -> (
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    Option<ServerAwarenessSnapshot>,
) {
    let mut request = format!("ws://{}/v1/collaboration", instance.address)
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert(ORIGIN, HeaderValue::from_str(origin).unwrap());
    let (mut socket, _) = connect_async(request).await.unwrap();
    let ticket = fresh_ticket(
        http,
        instance.address,
        collection,
        record_path,
        origin,
        token,
        signing,
        mode,
    )
    .await;
    phase7_authenticate(&mut socket, &ticket).await;
    let hello = recv_any_frame(&mut socket).await;
    assert_eq!(hello.kind, CollaborationMessageKind::Hello);
    // The advertisement is exact and explicitly provider-instance scoped so
    // no client can mistake local membership for cross-instance completeness.
    assert_eq!(
        hello.metadata.get("awareness"),
        Some(&awareness_hello_advertisement())
    );
    // Sync the durable document; join and update snapshots may interleave.
    let mut client = MarkdownBodyDocument::new("", 2 * 1024 * 1024).unwrap();
    socket
        .send(Message::Binary(
            CollaborationFrame {
                kind: CollaborationMessageKind::SyncStep1,
                metadata: Default::default(),
                payload: client.state_vector_v1(),
            }
            .encode()
            .unwrap()
            .into(),
        ))
        .await
        .unwrap();
    let mut joined_snapshot = None;
    loop {
        let message = recv_message(&mut socket).await;
        let Message::Binary(bytes) = message else {
            panic!("expected a binary frame while syncing, got {message:?}");
        };
        let frame = CollaborationFrame::decode(bytes.as_ref()).unwrap();
        match frame.kind {
            CollaborationMessageKind::Awareness => {
                joined_snapshot = Some(
                    serde_json::from_value::<ServerAwarenessSnapshot>(Value::Object(
                        frame.metadata,
                    ))
                    .unwrap(),
                );
            }
            CollaborationMessageKind::SyncStep2 => {
                client
                    .apply_update_v1(&frame.payload, 2 * 1024 * 1024, 2 * 1024 * 1024)
                    .unwrap();
                break;
            }
            other => panic!("unexpected frame kind {other:?} while syncing"),
        }
    }
    (socket, joined_snapshot)
}

async fn phase7_authenticate(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    ticket: &str,
) {
    socket
        .send(Message::Binary(
            CollaborationFrame {
                kind: CollaborationMessageKind::Authenticate,
                metadata: json!({"ticket": ticket}).as_object().unwrap().clone(),
                payload: Vec::new(),
            }
            .encode()
            .unwrap()
            .into(),
        ))
        .await
        .unwrap();
}
