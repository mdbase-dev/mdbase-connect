use axum::extract::ws::{Message, WebSocket};
use axum::{
    body::Bytes,
    extract::{OriginalUri, Path, State, WebSocketUpgrade},
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
};
use futures_util::StreamExt;
use mdbase_connect_protocol::{CollaborationFrame, CollaborationMessageKind};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::time::{timeout, Duration};
use uuid::Uuid;

use crate::{
    error::{ApiError, ApiResult},
    http::{bearer, request_origin, request_proof, AppState},
    provider::collaboration::{
        CollaborationBatchContribution, CollaborationBatchInput, CollaborationTicketRequest,
        ConsumedCollaborationTicket,
    },
    CollaborationMode, COLLABORATION_PROFILE,
};

pub(crate) const MAX_TICKET_BODY: usize = 64 * 1024;
const FIRST_FRAME_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct TicketRequest {
    path: String,
    profile: String,
    mode: CollaborationModeDto,
    epoch: Option<u64>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum CollaborationModeDto {
    ReadOnly,
    ReadWrite,
}
impl From<CollaborationModeDto> for CollaborationMode {
    fn from(value: CollaborationModeDto) -> Self {
        match value {
            CollaborationModeDto::ReadOnly => Self::ReadOnly,
            CollaborationModeDto::ReadWrite => Self::ReadWrite,
        }
    }
}

pub async fn ticket(
    State(state): State<AppState>,
    headers: HeaderMap,
    OriginalUri(uri): OriginalUri,
    Path(collection_id): Path<Uuid>,
    body: Bytes,
) -> ApiResult<axum::Json<Value>> {
    if !state.collaboration_enabled() {
        return Err(unavailable());
    }
    if body.len() > MAX_TICKET_BODY {
        return Err(ApiError::bad_request(
            "request_too_large",
            "The collaboration ticket request is too large.",
        ));
    }
    let token = bearer(&headers)?;
    let origin = request_origin(&headers);
    let proof = request_proof(&headers, Method::POST, &uri, &body)?;
    let dto: TicketRequest = serde_json::from_slice(&body).map_err(|_| {
        ApiError::bad_request(
            "invalid_json",
            "The collaboration ticket request is invalid.",
        )
    })?;
    let issued = state
        .provider()
        .issue_collaboration_ticket(
            collection_id,
            token,
            CollaborationTicketRequest {
                path: dto.path,
                profile: dto.profile,
                mode: dto.mode.into(),
                epoch: dto.epoch,
            },
            origin,
            proof.as_ref(),
        )
        .await?;
    Ok(axum::Json(json!({
        "ticket": issued.plaintext,
        "expires_at": issued.metadata.expires_at,
        "profile": COLLABORATION_PROFILE,
        "mode": match issued.metadata.mode { CollaborationMode::ReadOnly => "read_only", CollaborationMode::ReadWrite => "read_write" },
        "epoch": issued.metadata.room.epoch,
        "websocket_endpoint": "/v1/collaboration"
    })))
}

pub async fn upgrade(
    State(state): State<AppState>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> ApiResult<Response> {
    if !state.collaboration_enabled() {
        return Err(unavailable());
    }
    let origin = request_origin(&headers)
        .ok_or_else(|| {
            ApiError::forbidden(
                "collaboration_scope_denied",
                "The collaboration Origin is required.",
            )
        })?
        .to_owned();
    let permit = state.socket_permit()?;
    Ok(ws
        .max_message_size(mdbase_connect_protocol::MAX_COLLABORATION_FRAME_BYTES)
        .max_frame_size(mdbase_connect_protocol::MAX_COLLABORATION_FRAME_BYTES)
        .on_upgrade(move |socket| session(socket, state, origin, permit))
        .into_response())
}

async fn session(
    mut socket: WebSocket,
    state: AppState,
    origin: String,
    _permit: tokio::sync::OwnedSemaphorePermit,
) {
    let first = timeout(FIRST_FRAME_TIMEOUT, socket.next()).await;
    let Some(Ok(Message::Binary(bytes))) = first.ok().flatten() else {
        return;
    };
    let Ok(frame) = CollaborationFrame::decode(&bytes) else {
        return;
    };
    if frame.kind != CollaborationMessageKind::Authenticate
        || !exact_keys(&frame.metadata, &["ticket"])
        || !frame.payload.is_empty()
    {
        return;
    }
    let Some(ticket) = frame.metadata.get("ticket").and_then(Value::as_str) else {
        return;
    };
    let consumed = match state
        .provider()
        .consume_collaboration_ticket(ticket, Some(&origin))
        .await
    {
        Ok(value) => value,
        Err(_) => return,
    };
    let session_id = Uuid::new_v4();
    let sender = state.room_sender(consumed.metadata.room).await;
    let mut receiver = sender.subscribe();
    if send_frame(&mut socket, hello(&consumed).encode().unwrap())
        .await
        .is_err()
    {
        return;
    }
    loop {
        tokio::select! {
            incoming = socket.next() => {
                let Some(Ok(message)) = incoming else { return; };
                let Message::Binary(bytes) = message else { return; };
                let Ok(frame) = CollaborationFrame::decode(&bytes) else { return; };
                match frame.kind {
                    CollaborationMessageKind::SyncStep1 if exact_keys(&frame.metadata, &[]) => {
                        let Ok(update) = state.provider().collaboration_sync_step2(consumed.metadata.room, consumed.metadata.replica_id, consumed.metadata.scope_epoch, &frame.payload).await else { return; };
                        if send_frame(&mut socket, CollaborationFrame { kind: CollaborationMessageKind::SyncStep2, metadata: Default::default(), payload: update }.encode().unwrap()).await.is_err() { return; }
                    }
                    CollaborationMessageKind::Update => {
                        if consumed.metadata.mode != CollaborationMode::ReadWrite || !exact_keys(&frame.metadata, &["client_mutation_id", "profile", "epoch"]) { return; }
                        let Some(client_id) = frame.metadata.get("client_mutation_id").and_then(Value::as_str).and_then(|v| Uuid::parse_str(v).ok()) else { return; };
                        if frame.metadata.get("profile").and_then(Value::as_str) != Some(COLLABORATION_PROFILE) || frame.metadata.get("epoch").and_then(Value::as_u64) != Some(consumed.metadata.room.epoch) { return; }
                        let input = CollaborationBatchInput { collection_id: consumed.metadata.room.collection_id, record_id: consumed.metadata.room.record_id, epoch: consumed.metadata.room.epoch, contributions: vec![CollaborationBatchContribution { replica_id: consumed.metadata.replica_id, expected_scope_epoch: consumed.metadata.scope_epoch, client_mutation_id: client_id, update: frame.payload.clone() }] };
                        let Ok((receipts, accepted)) = state.provider().commit_collaboration_batch(input).await else { return; };
                        let Some(receipt) = receipts.first() else { return; };
                        let ack = CollaborationFrame { kind: CollaborationMessageKind::Acknowledged, metadata: json!({"client_mutation_id": client_id, "sequence": receipt.sequence, "record_sequence": receipt.record_sequence}).as_object().unwrap().clone(), payload: Vec::new() };
                        if send_frame(&mut socket, ack.encode().unwrap()).await.is_err() { return; }
                        let update = CollaborationFrame { kind: CollaborationMessageKind::Update, metadata: json!({"profile": COLLABORATION_PROFILE, "epoch": consumed.metadata.room.epoch}).as_object().unwrap().clone(), payload: frame.payload }.encode().unwrap();
                        if accepted { let _ = sender.send((session_id, update)); }
                    }
                    CollaborationMessageKind::Heartbeat => {
                        if !exact_keys(&frame.metadata, &[]) || !frame.payload.is_empty() { return; }
                        if send_frame(&mut socket, CollaborationFrame { kind: CollaborationMessageKind::Heartbeat, metadata: Default::default(), payload: Vec::new() }.encode().unwrap()).await.is_err() { return; }
                    }
                    CollaborationMessageKind::Awareness => { return; }
                    _ => { return; }
                }
            }
            broadcast = receiver.recv() => {
                let Ok((origin_session, bytes)) = broadcast else { continue; };
                if origin_session != session_id && send_frame(&mut socket, bytes).await.is_err() { return; }
            }
        }
    }
}

fn hello(ticket: &ConsumedCollaborationTicket) -> CollaborationFrame {
    CollaborationFrame { kind: CollaborationMessageKind::Hello, metadata: json!({"profile": COLLABORATION_PROFILE, "mode": match ticket.metadata.mode { CollaborationMode::ReadOnly => "read_only", CollaborationMode::ReadWrite => "read_write" }, "epoch": ticket.metadata.room.epoch, "limits": {"max_update_bytes": mdbase_connect_protocol::MAX_COLLABORATION_PAYLOAD_BYTES}}).as_object().unwrap().clone(), payload: Vec::new() }
}
fn exact_keys(metadata: &serde_json::Map<String, Value>, expected: &[&str]) -> bool {
    metadata.len() == expected.len() && expected.iter().all(|key| metadata.contains_key(*key))
}
async fn send_frame(socket: &mut WebSocket, bytes: Vec<u8>) -> Result<(), axum::Error> {
    socket.send(Message::Binary(bytes.into())).await
}
fn unavailable() -> ApiError {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "collaboration_unavailable",
        "Hosted collaboration is unavailable.",
    )
}
