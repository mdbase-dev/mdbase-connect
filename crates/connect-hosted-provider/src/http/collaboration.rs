use axum::extract::ws::{Message, WebSocket};
use axum::{
    body::Bytes,
    extract::{OriginalUri, Path, State, WebSocketUpgrade},
    http::{header::CACHE_CONTROL, HeaderMap, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
};
use futures_util::StreamExt;
use mdbase_connect_protocol::{CollaborationFrame, CollaborationMessageKind};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::time::{timeout, Duration, Instant};
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

pub(crate) const MAX_TICKET_BODY: usize = 4 * 1024;
const FIRST_FRAME_TIMEOUT: Duration = Duration::from_secs(5);
const AUTHENTICATED_IDLE_TIMEOUT: Duration = Duration::from_secs(45);
const MIN_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5);
const MAX_FRAMES_PER_SECOND: u32 = 64;
const MAX_SYNCS_PER_SECOND: u32 = 4;
const MAX_UPDATES_PER_SECOND: u32 = 32;
const MAX_ACTIVE_ROOMS: usize = 1024;

impl AppState {
    fn provider(&self) -> &crate::HostedProvider {
        &self.provider
    }

    fn collaboration_enabled(&self) -> bool {
        self.provider.collaboration_enabled()
    }

    fn socket_permit(&self) -> ApiResult<tokio::sync::OwnedSemaphorePermit> {
        self.collaboration_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| {
                ApiError::new(
                    StatusCode::TOO_MANY_REQUESTS,
                    "collaboration_busy",
                    "The collaboration service is busy.",
                )
            })
    }

    async fn room_channel(
        &self,
        room: crate::RoomIdentity,
    ) -> ApiResult<(
        tokio::sync::broadcast::Sender<(Uuid, Vec<u8>)>,
        tokio::sync::broadcast::Receiver<(Uuid, Vec<u8>)>,
    )> {
        let mut rooms = self.collaboration_rooms.lock().await;
        rooms.retain(|_, sender| sender.receiver_count() > 0);
        if !rooms.contains_key(&room) && rooms.len() >= MAX_ACTIVE_ROOMS {
            return Err(ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "collaboration_busy",
                "The collaboration service is busy.",
            ));
        }
        let sender = rooms
            .entry(room)
            .or_insert_with(|| tokio::sync::broadcast::channel(64).0)
            .clone();
        let receiver = sender.subscribe();
        Ok((sender, receiver))
    }
}

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
) -> ApiResult<Response> {
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
    if dto.path.is_empty() || dto.path.len() > 1024 {
        return Err(ApiError::bad_request(
            "invalid_collaboration_path",
            "The collaboration record path is invalid.",
        ));
    }
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
    let mut response = axum::Json(json!({
        "ticket": issued.plaintext,
        "expires_at": issued.metadata.expires_at,
        "profile": COLLABORATION_PROFILE,
        "mode": match issued.metadata.mode { CollaborationMode::ReadOnly => "read_only", CollaborationMode::ReadWrite => "read_write" },
        "epoch": issued.metadata.room.epoch,
        "websocket_endpoint": "/v1/collaboration"
    })).into_response();
    *response.status_mut() = StatusCode::CREATED;
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
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
    let Ok((sender, mut receiver)) = state.room_channel(consumed.metadata.room).await else {
        return;
    };
    if send_frame(
        &mut socket,
        hello(&consumed, state.provider().collaboration_max_update_bytes())
            .encode()
            .unwrap(),
    )
    .await
    .is_err()
    {
        return;
    }
    let idle = tokio::time::sleep(AUTHENTICATED_IDLE_TIMEOUT);
    tokio::pin!(idle);
    let mut rate_window = Instant::now();
    let mut frame_count = 0_u32;
    let mut sync_count = 0_u32;
    let mut update_count = 0_u32;
    let mut last_heartbeat = Instant::now() - MIN_HEARTBEAT_INTERVAL;
    loop {
        tokio::select! {
            _ = &mut idle => return,
            incoming = socket.next() => {
                let Some(Ok(message)) = incoming else { return; };
                idle.as_mut().reset(Instant::now() + AUTHENTICATED_IDLE_TIMEOUT);
                let Message::Binary(bytes) = message else { return; };
                let Ok(frame) = CollaborationFrame::decode(&bytes) else { return; };
                if rate_window.elapsed() >= Duration::from_secs(1) {
                    rate_window = Instant::now();
                    frame_count = 0;
                    sync_count = 0;
                    update_count = 0;
                }
                if frame_count >= MAX_FRAMES_PER_SECOND { return; }
                frame_count += 1;
                match frame.kind {
                    CollaborationMessageKind::SyncStep1 if exact_keys(&frame.metadata, &[]) => {
                        if sync_count >= MAX_SYNCS_PER_SECOND { return; }
                        sync_count += 1;
                        let Ok(update) = state.provider().collaboration_sync_step2(consumed.metadata.room, consumed.metadata.replica_id, consumed.metadata.scope_epoch, &frame.payload).await else { return; };
                        if update.len() > mdbase_connect_protocol::MAX_COLLABORATION_PAYLOAD_BYTES { return; }
                        let Ok(response) = (CollaborationFrame { kind: CollaborationMessageKind::SyncStep2, metadata: Default::default(), payload: update }).encode() else { return; };
                        if send_frame(&mut socket, response).await.is_err() { return; }
                    }
                    CollaborationMessageKind::Update => {
                        if update_count >= MAX_UPDATES_PER_SECOND { return; }
                        update_count += 1;
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
                        if !exact_keys(&frame.metadata, &[]) || !frame.payload.is_empty() || last_heartbeat.elapsed() < MIN_HEARTBEAT_INTERVAL { return; }
                        last_heartbeat = Instant::now();
                        if state.provider().reauthorize_collaboration_session(consumed.metadata.room, consumed.metadata.replica_id, consumed.metadata.scope_epoch).await.is_err() { return; }
                        if send_frame(&mut socket, CollaborationFrame { kind: CollaborationMessageKind::Heartbeat, metadata: Default::default(), payload: Vec::new() }.encode().unwrap()).await.is_err() { return; }
                    }
                    CollaborationMessageKind::Awareness => { return; }
                    _ => { return; }
                }
            }
            broadcast = receiver.recv() => {
                match broadcast {
                    Ok((origin_session, bytes)) => {
                        if origin_session != session_id {
                            if state.provider().reauthorize_collaboration_session(consumed.metadata.room, consumed.metadata.replica_id, consumed.metadata.scope_epoch).await.is_err() { return; }
                            if send_frame(&mut socket, bytes).await.is_err() { return; }
                        }
                    }
                    Err(_) => return,
                }
            }
        }
    }
}

fn hello(ticket: &ConsumedCollaborationTicket, max_update_bytes: u64) -> CollaborationFrame {
    CollaborationFrame { kind: CollaborationMessageKind::Hello, metadata: json!({"profile": COLLABORATION_PROFILE, "mode": match ticket.metadata.mode { CollaborationMode::ReadOnly => "read_only", CollaborationMode::ReadWrite => "read_write" }, "epoch": ticket.metadata.room.epoch, "limits": {"max_update_bytes": max_update_bytes}}).as_object().unwrap().clone(), payload: Vec::new() }
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
