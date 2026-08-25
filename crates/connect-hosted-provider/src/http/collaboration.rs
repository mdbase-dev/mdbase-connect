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
use std::collections::{BTreeMap, VecDeque};
use tokio::time::{Duration, Instant};
use uuid::Uuid;

use futures_util::StreamExt;

use crate::{
    error::{ApiError, ApiResult},
    http::collaboration_awareness::AwarenessJoinError,
    http::collaboration_sessions::{
        SessionCloseDirective, COLLABORATION_CLOSE_GOING_AWAY, DRAIN_DIRECTIVE, INTERNAL_DIRECTIVE,
        POLICY_DIRECTIVE, SESSION_REAUTHORIZATION_INTERVAL,
    },
    http::{bearer, request_origin, request_proof, AppState},
    provider::collaboration::{
        spawn_wake_runtime, CollaborationCatchUpItem, CollaborationTicketRequest,
        CollaborationWake, ConsumedCollaborationTicket, DEFAULT_WAKE_SWEEP_INTERVAL,
        WAKE_RECONCILE,
    },
    CollaborationMode, COLLABORATION_PROFILE,
};
use mdbase_connect_protocol::{
    AwarenessHelloAdvertisement, ClientAwarenessUpdate, MAX_AWARENESS_UPDATES_PER_SECOND,
    MIN_AWARENESS_UPDATE_SPACING_MS,
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
    // Drain rejects new admissions before any database or proof work.
    if !state.collaboration_sessions_accepting() {
        return Err(draining());
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
    // Drain rejects new sockets before consuming a slot.
    if !state.collaboration_sessions_accepting() {
        return Err(draining());
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
    permit: tokio::sync::OwnedSemaphorePermit,
) {
    // Register before touching the protocol so drain tracks every socket,
    // including ones that never authenticate. The RAII guard owns the slot
    // permit and unregisters on every exit path.
    let (socket_guard, mut close_rx, immediate) = state.register_collaboration_socket(permit);
    if immediate {
        send_server_close(&mut socket, DRAIN_DIRECTIVE).await;
        return;
    }
    let first = select_first_frame(&mut socket, &mut close_rx).await;
    let Some(Ok(Message::Binary(bytes))) = first else {
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
    let Ok(consumed) = state.session_consume_ticket(ticket, Some(&origin)).await else {
        return;
    };
    socket_guard.bind_replica(consumed.metadata.replica_id);
    if state.session_reauthorize(&consumed).await.is_err() {
        send_server_close(&mut socket, POLICY_DIRECTIVE).await;
        return;
    }
    let Ok(mut wakes) = state
        .collaboration_wakes()
        .subscribe(consumed.metadata.room)
        .await
    else {
        return;
    };
    // Awareness: subscribe before joining so this member observes its own
    // join's rebroadcast generation and learns the current participants. The
    // identity comes exclusively from the consumed ticket's stored replica
    // columns; clients can never supply name or color.
    let mut awareness = state.subscribe_room_awareness(&consumed.metadata.room);
    // Membership starts only after durable SyncStep2 has been delivered. A
    // socket that authenticates and then stalls must not appear present or
    // consume awareness membership capacity.
    let session_id = socket_guard.session_id();
    let mut awareness_guard = None;
    if send_frame(
        &mut socket,
        hello(
            &consumed,
            state.provider().collaboration_max_update_bytes(),
            state.provider().collaboration_awareness_ttl().as_secs(),
        )
        .encode()
        .unwrap(),
    )
    .await
    .is_err()
    {
        return;
    }
    // The max document position bound for client-supplied selection offsets.
    let max_position = state.provider().collaboration_max_document_units();
    let idle = tokio::time::sleep(AUTHENTICATED_IDLE_TIMEOUT);
    tokio::pin!(idle);
    // Server-driven reauthorization: unlike client heartbeats this cannot be
    // withheld by a hostile peer, so revocation, rotation, downgrade, and
    // admission suspension converge to closure within one interval.
    let first_reauthorization = tokio::time::Instant::now()
        + SESSION_REAUTHORIZATION_INTERVAL
        + socket_guard.reauthorization_jitter();
    let mut server_reauthorization =
        tokio::time::interval_at(first_reauthorization, SESSION_REAUTHORIZATION_INTERVAL);
    server_reauthorization.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut rate_window = Instant::now();
    let mut frame_count = 0_u32;
    let mut sync_count = 0_u32;
    let mut update_count = 0_u32;
    let mut awareness_updates = VecDeque::<Instant>::new();
    let mut last_awareness: Option<Instant> = None;
    let mut last_heartbeat = Instant::now() - MIN_HEARTBEAT_INTERVAL;
    let mut reauthorization_failures = 0_u8;
    let mut delivery = SessionDelivery::new();
    let mut synced = false;
    loop {
        tokio::select! {
            _ = &mut idle => return,
            directive = close_directive(&mut close_rx) => {
                send_server_close(&mut socket, directive).await;
                return;
            }
            _ = server_reauthorization.tick() => {
                match state.session_reauthorize(&consumed).await {
                    Ok(()) => {
                        reauthorization_failures = 0;
                        // Each tick opportunistically expires stale
                        // participants process-wide. The visibility lease is
                        // deliberately NOT refreshed here: only client
                        // activity proves presence.
                        state.sweep_expired_room_awareness();
                    }
                    Err(error) if retryable_delivery_error(&error) && reauthorization_failures < 1 => {
                        reauthorization_failures += 1;
                    }
                    Err(error) => {
                        send_server_close(&mut socket, directive_for_error(&error)).await;
                        return;
                    }
                }
            }
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
                        let (update, current_sequence) = match state.session_sync_step2(&consumed, &frame.payload).await {
                            Ok(value) => value,
                            Err(error) => {
                                send_server_close(&mut socket, directive_for_error(&error)).await;
                                return;
                            }
                        };
                        // Everything through the observed durable sequence was
                        // just covered by this diff; wakes resume from here.
                        delivery.delivered_through = current_sequence;
                        delivery.own_acks.clear();
                        if update.len() > mdbase_connect_protocol::MAX_COLLABORATION_PAYLOAD_BYTES { return; }
                        let Ok(response) = (CollaborationFrame { kind: CollaborationMessageKind::SyncStep2, metadata: Default::default(), payload: update }).encode() else { return; };
                        if send_frame(&mut socket, response).await.is_err() { return; }
                        if awareness_guard.is_none() {
                            awareness_guard = match state.join_room_awareness(
                                &consumed.metadata.room,
                                session_id,
                                consumed.metadata.replica_id,
                                &consumed.metadata.identity,
                            ) {
                                Ok(guard) => Some(guard),
                                Err(AwarenessJoinError::Draining) => {
                                    send_server_close(&mut socket, DRAIN_DIRECTIVE).await;
                                    return;
                                }
                                Err(_) => {
                                    send_server_close(&mut socket, POLICY_DIRECTIVE).await;
                                    return;
                                }
                            };
                        } else {
                            state.refresh_room_awareness(&consumed.metadata.room, session_id);
                        }
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
                        // Updates started before drain finishes and receive their
                        // acknowledgement; updates arriving after drain began are
                        // rejected with the going-away close.
                        let Some(in_flight) = state.try_begin_collaboration_update() else {
                            send_server_close(&mut socket, DRAIN_DIRECTIVE).await;
                            return;
                        };
                        let committed = state.session_commit_update(&consumed, client_id, frame.payload.clone()).await;
                        drop(in_flight);
                        let (receipts, accepted) = match committed {
                            Ok(value) => value,
                            Err(error) => {
                                send_server_close(&mut socket, directive_for_error(&error)).await;
                                return;
                            }
                        };
                        let Some(receipt) = receipts.first() else { return; };
                        // Origin echo suppression is recorded from the stored
                        // receipt identities before any wake can be processed.
                        delivery.own_acks.insert(receipt.sequence, (consumed.metadata.replica_id, client_id));
                        delivery.prune_through(delivery.delivered_through);
                        let ack = CollaborationFrame { kind: CollaborationMessageKind::Acknowledged, metadata: json!({"client_mutation_id": client_id, "sequence": receipt.sequence, "record_sequence": receipt.record_sequence}).as_object().unwrap().clone(), payload: Vec::new() };
                        if send_frame(&mut socket, ack.encode().unwrap()).await.is_err() { return; }
                        state.refresh_room_awareness(&consumed.metadata.room, session_id);
                        if accepted {
                            // Local coalesced wake only; remote instances are
                            // woken by the transactional PostgreSQL notice.
                            state.collaboration_wakes().wake(&consumed.metadata.room, receipt.sequence).await;
                        }
                        // Finish-then-close: honor a drain that arrived while
                        // this batch was committing instead of accepting another
                        // frame first.
                        if let Some(directive) = pending_close(&mut close_rx) {
                            send_server_close(&mut socket, directive).await;
                            return;
                        }
                    }
                    CollaborationMessageKind::Awareness => {
                        let now = Instant::now();
                        while awareness_updates.front().is_some_and(|accepted| now.duration_since(*accepted) >= Duration::from_secs(1)) {
                            awareness_updates.pop_front();
                        }
                        if !synced {
                            send_awareness_reject(&mut socket).await;
                            return;
                        }
                        // Parse before rate handling so a peer cannot hide an
                        // invalid or identity-bearing frame inside a burst.
                        // Valid excess frames are ignored without refreshing
                        // visibility: network jitter can compress an honest
                        // client's spaced sends, and ephemeral presence must
                        // never terminate its durable editing session.
                        let parsed = if frame.payload.is_empty() {
                            ClientAwarenessUpdate::from_metadata(&frame.metadata)
                                .and_then(|update| match update.validate(max_position) {
                                    Ok(()) => Ok(update),
                                    Err(error) => Err(error),
                                })
                        } else {
                            Err(mdbase_connect_protocol::AwarenessValidationError::PayloadNotEmpty)
                        };
                        let update = match parsed {
                            Ok(update) => update,
                            Err(_) => {
                                send_awareness_reject(&mut socket).await;
                                return;
                            }
                        };
                        let over_rate = awareness_updates.len()
                            >= MAX_AWARENESS_UPDATES_PER_SECOND as usize
                            || last_awareness.is_some_and(|last| {
                                last.elapsed()
                                    < Duration::from_millis(MIN_AWARENESS_UPDATE_SPACING_MS)
                            });
                        if over_rate {
                            continue;
                        }
                        awareness_updates.push_back(now);
                        last_awareness = Some(now);
                        state.apply_room_awareness(&consumed.metadata.room, session_id, &update);
                        if let Some(directive) = pending_close(&mut close_rx) {
                            send_server_close(&mut socket, directive).await;
                            return;
                        }
                    }
                    CollaborationMessageKind::Heartbeat => {
                        if !synced || !exact_keys(&frame.metadata, &[]) || !frame.payload.is_empty() || last_heartbeat.elapsed() < MIN_HEARTBEAT_INTERVAL { return; }
                        last_heartbeat = Instant::now();
                        if let Err(error) = state.session_reauthorize(&consumed).await {
                            send_server_close(&mut socket, directive_for_error(&error)).await;
                            return;
                        }
                        if send_frame(&mut socket, CollaborationFrame { kind: CollaborationMessageKind::Heartbeat, metadata: Default::default(), payload: Vec::new() }.encode().unwrap()).await.is_err() { return; }
                        state.refresh_room_awareness(&consumed.metadata.room, session_id);
                    }
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
            changed = awareness.changed(), if synced => {
                // Coalesced complete-snapshot rebroadcast: at most one send
                // per observed generation change, built from current locked
                // room state so every member converges on identical order.
                if changed.is_err() { return; }
                awareness.borrow_and_update();
                if send_awareness_snapshot(&mut socket, &state, &consumed.metadata.room).await.is_err() { return; }
            }
        }
    }
}

/// Resolve as soon as the runtime directs this session to close. The sender
/// lives exactly as long as this session's registry entry, so a dropped sender
/// is treated fail-closed as a drain directive.
async fn close_directive(
    close_rx: &mut tokio::sync::watch::Receiver<Option<SessionCloseDirective>>,
) -> SessionCloseDirective {
    loop {
        if let Some(directive) = *close_rx.borrow_and_update() {
            return directive;
        }
        if close_rx.changed().await.is_err() {
            return DRAIN_DIRECTIVE;
        }
    }
}

/// Non-suspending check for an already-pending directive, used right after a
/// long operation completes so finish-then-close never waits for the next
/// select round.
fn pending_close(
    close_rx: &mut tokio::sync::watch::Receiver<Option<SessionCloseDirective>>,
) -> Option<SessionCloseDirective> {
    *close_rx.borrow_and_update()
}

/// Read one pre-authentication frame while still honoring drain directives
/// and the first-frame timeout.
async fn select_first_frame(
    socket: &mut WebSocket,
    close_rx: &mut tokio::sync::watch::Receiver<Option<SessionCloseDirective>>,
) -> Option<Result<Message, axum::Error>> {
    let deadline = tokio::time::sleep(FIRST_FRAME_TIMEOUT);
    tokio::pin!(deadline);
    tokio::select! {
        message = socket.next() => message,
        _ = &mut deadline => None,
        directive = close_directive(close_rx) => {
            send_server_close(socket, directive).await;
            None
        }
    }
}

/// Best-effort server-initiated WebSocket close carrying the directive's code.
async fn send_server_close(socket: &mut WebSocket, directive: SessionCloseDirective) {
    let reason = match directive.code {
        COLLABORATION_CLOSE_GOING_AWAY => "draining",
        1011 => "temporarily unavailable",
        _ => "authorization ended",
    };
    let _ = socket
        .send(Message::Close(Some(axum::extract::ws::CloseFrame {
            code: directive.code,
            reason: reason.into(),
        })))
        .await;
}

/// Deliver every durable update beyond the session cursor in contiguous order,
/// reloading authoritative ciphertext from PostgreSQL each round. Each round
/// reauthorizes and loads inside one bounded admission lane, then releases it
/// before any frame reaches the socket.
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
            match state
                .session_reauthorized_catch_up(consumed, delivery.delivered_through, target)
                .await
            {
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

fn directive_for_error(error: &ApiError) -> SessionCloseDirective {
    if retryable_delivery_error(error) {
        INTERNAL_DIRECTIVE
    } else {
        POLICY_DIRECTIVE
    }
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

fn hello(
    ticket: &ConsumedCollaborationTicket,
    max_update_bytes: u64,
    awareness_ttl_seconds: u64,
) -> CollaborationFrame {
    let mut metadata = json!({"profile": COLLABORATION_PROFILE, "mode": match ticket.metadata.mode { CollaborationMode::ReadOnly => "read_only", CollaborationMode::ReadWrite => "read_write" }, "epoch": ticket.metadata.room.epoch, "limits": {"max_update_bytes": max_update_bytes}}).as_object().unwrap().clone();
    // Explicitly advertise awareness as provider-instance scoped so no client
    // can mistake local membership for cross-instance completeness.
    for (key, value) in AwarenessHelloAdvertisement::with_ttl(awareness_ttl_seconds).to_metadata() {
        metadata.insert(key, value);
    }
    CollaborationFrame {
        kind: CollaborationMessageKind::Hello,
        metadata,
        payload: Vec::new(),
    }
}

/// Send this member the complete replacement snapshot of its room.
async fn send_awareness_snapshot(
    socket: &mut WebSocket,
    state: &AppState,
    room: &crate::RoomIdentity,
) -> Result<(), ()> {
    let snapshot = state.room_awareness_snapshot(room);
    let frame = CollaborationFrame {
        kind: CollaborationMessageKind::Awareness,
        metadata: snapshot.to_metadata(),
        payload: Vec::new(),
    };
    let encoded = frame.encode().map_err(|_| ())?;
    send_frame(socket, encoded).await.map_err(|_| ())
}

/// Reject an invalid awareness frame and close the session.
async fn send_awareness_reject(socket: &mut WebSocket) {
    send_server_close(socket, POLICY_DIRECTIVE).await;
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
fn draining() -> ApiError {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "collaboration_draining",
        "Hosted collaboration is draining and is not accepting new sessions.",
    )
}
