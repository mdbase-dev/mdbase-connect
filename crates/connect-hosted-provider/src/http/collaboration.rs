use axum::extract::ws::{Message, WebSocket};
use axum::{
    body::Bytes,
    extract::{OriginalUri, Path, State, WebSocketUpgrade},
    http::{header::CACHE_CONTROL, HeaderMap, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
};
use mdbase_connect_protocol::{CollaborationFrame, CollaborationMessageKind};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use tokio::time::{timeout, Duration, Instant};
use uuid::Uuid;

use futures_util::StreamExt;

use crate::{
    error::{ApiError, ApiResult},
    http::{bearer, request_origin, request_proof, AppState},
    provider::collaboration::{
        spawn_wake_runtime, CollaborationBatchContribution, CollaborationBatchInput,
        CollaborationCatchUpItem, CollaborationTicketRequest, CollaborationWake,
        ConsumedCollaborationTicket, DEFAULT_WAKE_SWEEP_INTERVAL, WAKE_RECONCILE,
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

/// Safety cap on full-page drain rounds per wake. Backlogs beyond this wait
/// for the next wake or sweep; correctness comes from the durable cursor.
const MAX_DRAIN_ROUNDS_PER_WAKE: usize = 64;

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
}

impl AppState {
    /// Start the metadata-only PostgreSQL wake listener and its bounded sweep.
    /// Fail-closed when collaboration is enabled: the initial LISTEN
    /// subscription must succeed or this returns an error and provider startup
    /// must abort. Disabled mode creates no listener, task, or database lane,
    /// and routes stay unavailable. Safe to call repeatedly; a previously
    /// stopped runtime is replaced.
    pub async fn start_collaboration_wake_runtime(&self) -> ApiResult<()> {
        self.start_collaboration_wake_runtime_with_sweep(DEFAULT_WAKE_SWEEP_INTERVAL)
            .await
    }

    pub(crate) async fn start_collaboration_wake_runtime_with_sweep(
        &self,
        sweep_interval: std::time::Duration,
    ) -> ApiResult<()> {
        if !self.collaboration_enabled() {
            return Ok(());
        }
        let mut slot = self.collaboration_wake_runtime.lock().await;
        if let Some(runtime) = slot.as_ref() {
            if runtime.running() {
                return Ok(());
            }
            return Err(ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "collaboration_draining",
                "The collaboration wake runtime is still stopping.",
            ));
        }
        *slot = Some(
            spawn_wake_runtime(
                self.provider().database_url(),
                self.collaboration_wakes().clone(),
                sweep_interval,
            )
            .await?,
        );
        Ok(())
    }

    /// Stop and await the listener and sweep workers cleanly. Returns whether
    /// both finished within the budget. The next start call spawns fresh.
    pub async fn stop_collaboration_wake_runtime(&self, within: std::time::Duration) -> bool {
        let mut slot = self.collaboration_wake_runtime.lock().await;
        let Some(runtime) = slot.as_mut() else {
            return true;
        };
        if runtime.stop(within).await {
            slot.take();
            true
        } else {
            false
        }
    }
}

/// Per-session durable delivery state. The cursor advances only after frames
/// are handed to this socket, and origin echo is suppressed exclusively by
/// matching stored replica and mutation identities of this session's own
/// acknowledged contributions — never client-supplied metadata alone.
struct SessionDelivery {
    delivered_through: u64,
    reconcile_generation: u64,
    own_acks: BTreeMap<u64, (Uuid, Uuid)>,
}

impl SessionDelivery {
    fn new() -> Self {
        Self {
            delivered_through: 0,
            reconcile_generation: 0,
            own_acks: BTreeMap::new(),
        }
    }

    fn target_for(&mut self, wake: CollaborationWake) -> Option<u64> {
        if wake.reconcile_generation != self.reconcile_generation {
            self.reconcile_generation = wake.reconcile_generation;
            return Some(WAKE_RECONCILE);
        }
        (wake.high_water > self.delivered_through).then_some(wake.high_water)
    }

    fn suppresses(&self, item: &CollaborationCatchUpItem) -> bool {
        match (item.replica_id, item.client_mutation_id) {
            (Some(replica_id), Some(mutation_id)) => self
                .own_acks
                .get(&item.sequence)
                .is_some_and(|stored| *stored == (replica_id, mutation_id)),
            _ => false,
        }
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
    let Ok(mut wakes) = state
        .collaboration_wakes()
        .subscribe(consumed.metadata.room)
        .await
    else {
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
    let mut delivery = SessionDelivery::new();
    let mut synced = false;
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
                        let Ok((update, current_sequence)) = state.provider().collaboration_sync_step2(consumed.metadata.room, consumed.metadata.replica_id, consumed.metadata.scope_epoch, &frame.payload).await else { return; };
                        // Everything through the observed durable sequence was
                        // just covered by this diff; wakes resume from here.
                        delivery.delivered_through = current_sequence;
                        delivery.own_acks.clear();
                        if update.len() > mdbase_connect_protocol::MAX_COLLABORATION_PAYLOAD_BYTES { return; }
                        let Ok(response) = (CollaborationFrame { kind: CollaborationMessageKind::SyncStep2, metadata: Default::default(), payload: update }).encode() else { return; };
                        if send_frame(&mut socket, response).await.is_err() { return; }
                        synced = true;
                        // Close the query/register race: a commit can land
                        // after SyncStep2 observed its durable cursor but
                        // before this socket starts selecting on wake changes.
                        let initial_wake = *wakes.borrow_and_update();
                        if let Some(target) = delivery.target_for(initial_wake) {
                            if drain_durable_updates(&mut socket, &state, &consumed, &mut delivery, target).await.is_err() { return; }
                        }
                    }
                    CollaborationMessageKind::Update => {
                        if !synced || update_count >= MAX_UPDATES_PER_SECOND { return; }
                        update_count += 1;
                        if consumed.metadata.mode != CollaborationMode::ReadWrite || !exact_keys(&frame.metadata, &["client_mutation_id", "profile", "epoch"]) { return; }
                        let Some(client_id) = frame.metadata.get("client_mutation_id").and_then(Value::as_str).and_then(|v| Uuid::parse_str(v).ok()) else { return; };
                        if frame.metadata.get("profile").and_then(Value::as_str) != Some(COLLABORATION_PROFILE) || frame.metadata.get("epoch").and_then(Value::as_u64) != Some(consumed.metadata.room.epoch) { return; }
                        let input = CollaborationBatchInput { collection_id: consumed.metadata.room.collection_id, record_id: consumed.metadata.room.record_id, epoch: consumed.metadata.room.epoch, contributions: vec![CollaborationBatchContribution { replica_id: consumed.metadata.replica_id, expected_scope_epoch: consumed.metadata.scope_epoch, client_mutation_id: client_id, update: frame.payload.clone() }] };
                        let Ok((receipts, accepted)) = state.provider().commit_collaboration_batch(input).await else { return; };
                        let Some(receipt) = receipts.first() else { return; };
                        // Origin echo suppression is recorded from the stored
                        // receipt identities before any wake can be processed.
                        delivery.own_acks.insert(receipt.sequence, (consumed.metadata.replica_id, client_id));
                        delivery.prune_through(delivery.delivered_through);
                        let ack = CollaborationFrame { kind: CollaborationMessageKind::Acknowledged, metadata: json!({"client_mutation_id": client_id, "sequence": receipt.sequence, "record_sequence": receipt.record_sequence}).as_object().unwrap().clone(), payload: Vec::new() };
                        if send_frame(&mut socket, ack.encode().unwrap()).await.is_err() { return; }
                        if accepted {
                            // Local coalesced wake only; remote instances are
                            // woken by the transactional PostgreSQL notice.
                            state.collaboration_wakes().wake(&consumed.metadata.room, receipt.sequence).await;
                        }
                    }
                    CollaborationMessageKind::Heartbeat => {
                        if !synced || !exact_keys(&frame.metadata, &[]) || !frame.payload.is_empty() || last_heartbeat.elapsed() < MIN_HEARTBEAT_INTERVAL { return; }
                        last_heartbeat = Instant::now();
                        if state.provider().reauthorize_collaboration_session(consumed.metadata.room, consumed.metadata.replica_id, consumed.metadata.scope_epoch).await.is_err() { return; }
                        if send_frame(&mut socket, CollaborationFrame { kind: CollaborationMessageKind::Heartbeat, metadata: Default::default(), payload: Vec::new() }.encode().unwrap()).await.is_err() { return; }
                    }
                    CollaborationMessageKind::Awareness => { return; }
                    _ => { return; }
                }
            }
            woken = wakes.changed(), if synced => {
                if woken.is_err() { return; }
                let wake = *wakes.borrow_and_update();
                if let Some(target) = delivery.target_for(wake) {
                    if drain_durable_updates(&mut socket, &state, &consumed, &mut delivery, target).await.is_err() { return; }
                }
            }
        }
    }
}

/// Deliver every durable update beyond the session cursor in contiguous order,
/// reloading authoritative ciphertext from PostgreSQL each round. Per-socket
/// authorization runs immediately before plaintext leaves the database lane.
async fn drain_durable_updates(
    socket: &mut WebSocket,
    state: &AppState,
    consumed: &ConsumedCollaborationTicket,
    delivery: &mut SessionDelivery,
    target: u64,
) -> Result<(), ()> {
    let room = consumed.metadata.room;
    for _ in 0..MAX_DRAIN_ROUNDS_PER_WAKE {
        let mut attempt = 0_u32;
        let items = loop {
            let authorization = state
                .provider()
                .reauthorize_collaboration_session(
                    room,
                    consumed.metadata.replica_id,
                    consumed.metadata.scope_epoch,
                )
                .await;
            let result = match authorization {
                Ok(()) => {
                    state
                        .provider()
                        .collaboration_catch_up(room, delivery.delivered_through, target)
                        .await
                }
                Err(error) => Err(error),
            };
            match result {
                Ok(items) => break items,
                Err(error) if retryable_delivery_error(&error) && attempt < 2 => {
                    attempt += 1;
                    tokio::time::sleep(Duration::from_millis(25 * u64::from(attempt))).await;
                }
                Err(_) => return Err(()),
            }
        };
        if items.is_empty() {
            return Ok(());
        }
        for item in items {
            if !delivery.suppresses(&item) {
                let frame = CollaborationFrame {
                    kind: CollaborationMessageKind::Update,
                    metadata: json!({"profile": COLLABORATION_PROFILE, "epoch": room.epoch})
                        .as_object()
                        .unwrap()
                        .clone(),
                    payload: item.plaintext,
                };
                let encoded = frame.encode().map_err(|_| ())?;
                if send_frame(socket, encoded).await.is_err() {
                    return Err(());
                }
            }
            delivery.delivered_through = item.sequence;
        }
        delivery.prune_through(delivery.delivered_through);
        // Always probe once more after a non-empty bounded page. The page may
        // have stopped on its byte ceiling before its row-count ceiling, so
        // item count alone cannot prove that the durable target was drained.
    }
    Ok(())
}

fn retryable_delivery_error(error: &ApiError) -> bool {
    error.status == StatusCode::SERVICE_UNAVAILABLE
        || error.status == StatusCode::INTERNAL_SERVER_ERROR
}

impl SessionDelivery {
    /// Drop acknowledged identities below the durable cursor. Catch-up only
    /// ever fetches rows strictly beyond it, so they can never be referenced
    /// by a future delivery round.
    fn prune_through(&mut self, through: u64) {
        while self
            .own_acks
            .first_key_value()
            .is_some_and(|(sequence, _)| *sequence <= through)
        {
            self.own_acks.pop_first();
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
