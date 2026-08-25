//! Process-local collaboration awareness.
//!
//! This module owns the room registry that tracks which authenticated
//! sessions are present in which record room, their server-derived
//! presentation identity, and coalesced recipient-specific snapshot rebroadcasts.
//! A socket's own session is omitted before serialization. Everything here is
//! synchronous and bounded: no lock is held across an
//! await, and nothing in this module ever reaches durable storage, outbox
//! rows, receipts, logs, or other provider instances.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::Duration;

use mdbase_connect_protocol::{
    AwarenessColor, AwarenessParticipant, AwarenessSelectionRange, AwarenessStatus,
    ClientAwarenessUpdate, ReplicaAwarenessIdentity, ServerAwarenessSnapshot,
    AWARENESS_VISIBLE_TTL_SECONDS, GENERIC_AWARENESS_NAME,
};
use tokio::sync::watch;
use uuid::Uuid;

use super::collaboration_sessions::CollaborationSessionRuntime;
use super::AppState;
use crate::RoomIdentity;

/// How long an awareness participant stays visible without refreshing session
/// activity. Advertised in Hello.
pub(crate) const AWARENESS_TTL: Duration = Duration::from_secs(AWARENESS_VISIBLE_TTL_SECONDS);
/// Maximum participants in one room's awareness snapshot.
pub(crate) const MAX_AWARENESS_ROOM_PARTICIPANTS: usize = 16;
/// Maximum concurrently visible awareness sessions per replica per process.
pub(crate) const MAX_AWARENESS_SESSIONS_PER_REPLICA: usize = 4;

/// Process-local awareness state of one room. Participants are keyed by
/// monotonic session id so snapshot ordering is stable regardless of hash
/// iteration order. The generation counter coalesces rebroadcasts: any
/// mutation bumps it once, and each member sends at most one complete
/// replacement snapshot per observed change.
#[derive(Debug)]
pub(super) struct AwarenessRoom {
    pub(super) participants: BTreeMap<u64, AwarenessParticipantState>,
    rebroadcast: watch::Sender<u64>,
}

impl AwarenessRoom {
    pub(super) fn bump_generation(&self) {
        self.rebroadcast.send_modify(|generation| {
            *generation = generation.wrapping_add(1);
        });
    }
}

#[derive(Debug, Clone)]
pub(super) struct AwarenessParticipantState {
    pub(super) replica_id: Uuid,
    name: String,
    color: AwarenessColor,
    status: AwarenessStatus,
    selections: Vec<AwarenessSelectionRange>,
    visible: bool,
    last_refreshed: tokio::time::Instant,
}

/// Why a room join was refused. Never exposes identity or document data.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AwarenessJoinError {
    Draining,
    RoomFull,
    ReplicaSessionLimit,
    SnapshotWouldExceedMetadataLimit,
}

impl CollaborationSessionRuntime {
    // -----------------------------------------------------------------------
    // Process-local awareness.
    //
    // Every method is synchronous and bounded: no lock is held across an
    // await, no query runs here, and nothing in this section ever reaches
    // durable storage, outbox rows, receipts, logs, or other instances.
    // -----------------------------------------------------------------------

    /// Subscribe to a room's coalesced rebroadcast channel before joining so
    /// the join's own generation bump is observed by this member too.
    pub(crate) fn subscribe_awareness(&self, room: &RoomIdentity) -> watch::Receiver<u64> {
        let mut rooms = self
            .awareness_rooms
            .lock()
            .expect("awareness registry poisoned");
        if !self.accepting() {
            return watch::channel(0).1;
        }
        // A room with live participants must survive even while it has no
        // receivers (a member subscribes after its own join).
        rooms.retain(|_, room_state| {
            room_state.rebroadcast.receiver_count() > 0 || !room_state.participants.is_empty()
        });
        let room_state = rooms.entry(*room).or_insert_with(|| {
            let (rebroadcast, _) = watch::channel(0);
            AwarenessRoom {
                participants: BTreeMap::new(),
                rebroadcast,
            }
        });
        room_state.rebroadcast.subscribe()
    }

    /// Add the session to its room's awareness with the server-derived
    /// identity from its consumed ticket. Read-only sessions participate like
    /// read-write ones; only durable updates are gated elsewhere.
    pub(crate) fn join_awareness(
        self: &Arc<Self>,
        room: &RoomIdentity,
        session_id: u64,
        replica_id: Uuid,
        identity: &ReplicaAwarenessIdentity,
    ) -> Result<CollaborationAwarenessGuard, AwarenessJoinError> {
        let mut rooms = self
            .awareness_rooms
            .lock()
            .expect("awareness registry poisoned");
        if !self.accepting() {
            return Err(AwarenessJoinError::Draining);
        }
        self.expire_stale_locked(&mut rooms, tokio::time::Instant::now());
        if let Some(existing) = rooms.get(room) {
            if existing.participants.contains_key(&session_id) {
                // Already joined: idempotent, keep one guard lifetime honest.
                return Ok(CollaborationAwarenessGuard {
                    runtime: Arc::clone(self),
                    room: *room,
                    session_id,
                });
            }
        }
        let replica_sessions = rooms
            .values()
            .map(|room_state| {
                room_state
                    .participants
                    .values()
                    .filter(|participant| participant.replica_id == replica_id)
                    .count()
            })
            .sum::<usize>();
        if replica_sessions >= MAX_AWARENESS_SESSIONS_PER_REPLICA {
            return Err(AwarenessJoinError::ReplicaSessionLimit);
        }
        let room_state = rooms.entry(*room).or_insert_with(|| {
            let (rebroadcast, _) = watch::channel(0);
            AwarenessRoom {
                participants: BTreeMap::new(),
                rebroadcast,
            }
        });
        if room_state.participants.len() >= MAX_AWARENESS_ROOM_PARTICIPANTS {
            return Err(AwarenessJoinError::RoomFull);
        }
        let display_name = if identity.name == GENERIC_AWARENESS_NAME {
            (1..=MAX_AWARENESS_ROOM_PARTICIPANTS)
                .map(|slot| format!("Participant {slot}"))
                .find(|candidate| {
                    !room_state
                        .participants
                        .values()
                        .any(|participant| participant.name == *candidate)
                })
                .unwrap_or_else(|| GENERIC_AWARENESS_NAME.to_owned())
        } else {
            identity.name.clone()
        };
        let participant = AwarenessParticipantState {
            replica_id,
            name: display_name,
            color: identity.color,
            status: AwarenessStatus::Active,
            selections: Vec::new(),
            visible: true,
            last_refreshed: tokio::time::Instant::now(),
        };
        room_state.participants.insert(session_id, participant);
        // Fail closed if the complete snapshot would not fit the frame
        // metadata limit even though the bounds make that impossible today.
        let snapshot_bytes = serde_json::to_vec(&Self::snapshot_of(room_state, None).to_metadata())
            .map(|encoded| encoded.len())
            .unwrap_or(usize::MAX);
        if snapshot_bytes > mdbase_connect_protocol::MAX_COLLABORATION_METADATA_BYTES {
            room_state.participants.remove(&session_id);
            return Err(AwarenessJoinError::SnapshotWouldExceedMetadataLimit);
        }
        room_state.bump_generation();
        Ok(CollaborationAwarenessGuard {
            runtime: Arc::clone(self),
            room: *room,
            session_id,
        })
    }

    /// Apply a validated client awareness update and refresh the lease.
    /// Returns false when the session is no longer a room participant.
    pub(crate) fn apply_awareness_update(
        &self,
        room: &RoomIdentity,
        session_id: u64,
        update: &ClientAwarenessUpdate,
    ) -> bool {
        let mut rooms = self
            .awareness_rooms
            .lock()
            .expect("awareness registry poisoned");
        if !self.accepting() {
            return false;
        }
        self.expire_stale_locked(&mut rooms, tokio::time::Instant::now());
        let Some(room_state) = rooms.get_mut(room) else {
            return false;
        };
        let Some(participant) = room_state.participants.get_mut(&session_id) else {
            return false;
        };
        let changed = !participant.visible
            || participant.status != update.status
            || participant.selections != update.selections;
        participant.status = update.status;
        participant.selections = update.selections.clone();
        participant.visible = true;
        participant.last_refreshed = tokio::time::Instant::now();
        if changed {
            room_state.bump_generation();
        }
        true
    }

    /// Refresh the visibility lease after accepted authenticated activity.
    pub(crate) fn refresh_awareness(&self, room: &RoomIdentity, session_id: u64) {
        let mut rooms = self
            .awareness_rooms
            .lock()
            .expect("awareness registry poisoned");
        if !self.accepting() {
            return;
        }
        if let Some(room_state) = rooms.get_mut(room) {
            if let Some(participant) = room_state.participants.get_mut(&session_id) {
                let became_visible = !participant.visible;
                participant.visible = true;
                if became_visible {
                    participant.status = AwarenessStatus::Active;
                    participant.selections.clear();
                }
                participant.last_refreshed = tokio::time::Instant::now();
                if became_visible {
                    room_state.bump_generation();
                }
            }
        }
    }

    /// Remove expired participants across every room and bump generations
    /// when visibility changed. Called opportunistically from awareness
    /// operations, the snapshot builder, and each session's reauthorization
    /// tick.
    pub(crate) fn sweep_expired_awareness(&self) {
        let mut rooms = self
            .awareness_rooms
            .lock()
            .expect("awareness registry poisoned");
        if self.accepting() {
            self.expire_stale_locked(&mut rooms, tokio::time::Instant::now());
        }
    }

    fn expire_stale_locked(
        &self,
        rooms: &mut HashMap<RoomIdentity, AwarenessRoom>,
        now: tokio::time::Instant,
    ) {
        for room_state in rooms.values_mut() {
            let mut changed = false;
            for participant in room_state.participants.values_mut() {
                if participant.visible
                    && now.duration_since(participant.last_refreshed) > self.awareness_ttl
                {
                    participant.visible = false;
                    participant.selections.clear();
                    changed = true;
                }
            }
            if changed {
                room_state.bump_generation();
            }
        }
    }

    /// Build the complete replacement snapshot ordered by stable session id.
    #[cfg(test)]
    pub(crate) fn awareness_snapshot(&self, room: &RoomIdentity) -> ServerAwarenessSnapshot {
        self.awareness_snapshot_excluding(room, None)
    }

    /// Build a recipient-specific replacement snapshot without echoing that
    /// socket's own presentation state. The session id never leaves this
    /// process; peers receive the unchanged sanitized v1 participant shape.
    pub(crate) fn awareness_snapshot_for_session(
        &self,
        room: &RoomIdentity,
        recipient_session_id: u64,
    ) -> ServerAwarenessSnapshot {
        self.awareness_snapshot_excluding(room, Some(recipient_session_id))
    }

    fn awareness_snapshot_excluding(
        &self,
        room: &RoomIdentity,
        excluded_session_id: Option<u64>,
    ) -> ServerAwarenessSnapshot {
        let mut rooms = self
            .awareness_rooms
            .lock()
            .expect("awareness registry poisoned");
        if self.accepting() {
            self.expire_stale_locked(&mut rooms, tokio::time::Instant::now());
        }
        rooms
            .get(room)
            .map(|room_state| Self::snapshot_of(room_state, excluded_session_id))
            .unwrap_or_else(|| ServerAwarenessSnapshot {
                participants: Vec::new(),
            })
    }

    fn snapshot_of(
        room_state: &AwarenessRoom,
        excluded_session_id: Option<u64>,
    ) -> ServerAwarenessSnapshot {
        ServerAwarenessSnapshot {
            participants: room_state
                .participants
                .iter()
                .filter(|(session_id, participant)| {
                    Some(**session_id) != excluded_session_id && participant.visible
                })
                .map(|(_, participant)| AwarenessParticipant {
                    name: participant.name.clone(),
                    color: participant.color,
                    status: participant.status,
                    selections: participant.selections.clone(),
                })
                .collect(),
        }
    }

    #[cfg(test)]
    pub(crate) fn awareness_participant_count(&self) -> usize {
        self.awareness_rooms
            .lock()
            .expect("awareness registry poisoned")
            .values()
            .map(|room_state| {
                room_state
                    .participants
                    .values()
                    .filter(|participant| participant.visible)
                    .count()
            })
            .sum()
    }

    /// Remove every awareness participant process-wide. Drain calls this so
    /// presence ends deterministically with the runtime lifecycle.
    pub(super) fn clear_all_awareness(&self) {
        let mut rooms = self
            .awareness_rooms
            .lock()
            .expect("awareness registry poisoned");
        for room_state in rooms.values_mut() {
            if !room_state.participants.is_empty() {
                room_state.participants.clear();
                room_state.bump_generation();
            }
        }
    }
}

/// RAII room membership for awareness. Dropping it removes the participant
/// and coalesces one rebroadcast so remaining members receive a complete
/// replacement snapshot without this session.
pub(crate) struct CollaborationAwarenessGuard {
    runtime: Arc<CollaborationSessionRuntime>,
    room: RoomIdentity,
    session_id: u64,
}

impl Drop for CollaborationAwarenessGuard {
    fn drop(&mut self) {
        let mut rooms = self
            .runtime
            .awareness_rooms
            .lock()
            .expect("awareness registry poisoned");
        if let Some(room_state) = rooms.get_mut(&self.room) {
            if room_state.participants.remove(&self.session_id).is_some() {
                room_state.bump_generation();
            }
        }
    }
}

impl AppState {
    pub(crate) fn subscribe_room_awareness(
        &self,
        room: &RoomIdentity,
    ) -> tokio::sync::watch::Receiver<u64> {
        self.collaboration_sessions.subscribe_awareness(room)
    }

    pub(crate) fn join_room_awareness(
        &self,
        room: &RoomIdentity,
        session_id: u64,
        replica_id: Uuid,
        identity: &mdbase_connect_protocol::ReplicaAwarenessIdentity,
    ) -> Result<CollaborationAwarenessGuard, AwarenessJoinError> {
        self.collaboration_sessions
            .join_awareness(room, session_id, replica_id, identity)
    }

    pub(crate) fn apply_room_awareness(
        &self,
        room: &RoomIdentity,
        session_id: u64,
        update: &mdbase_connect_protocol::ClientAwarenessUpdate,
    ) -> bool {
        self.collaboration_sessions
            .apply_awareness_update(room, session_id, update)
    }

    pub(crate) fn refresh_room_awareness(&self, room: &RoomIdentity, session_id: u64) {
        self.collaboration_sessions
            .refresh_awareness(room, session_id);
    }

    pub(crate) fn sweep_expired_room_awareness(&self) {
        self.collaboration_sessions.sweep_expired_awareness();
    }

    pub(crate) fn room_awareness_snapshot_for_session(
        &self,
        room: &RoomIdentity,
        recipient_session_id: u64,
    ) -> mdbase_connect_protocol::ServerAwarenessSnapshot {
        self.collaboration_sessions
            .awareness_snapshot_for_session(room, recipient_session_id)
    }

    #[cfg(test)]
    pub(crate) fn awareness_participant_count(&self) -> usize {
        self.collaboration_sessions.awareness_participant_count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runtime() -> Arc<CollaborationSessionRuntime> {
        Arc::new(CollaborationSessionRuntime::new())
    }

    fn permit() -> tokio::sync::OwnedSemaphorePermit {
        Arc::new(tokio::sync::Semaphore::new(4))
            .try_acquire_owned()
            .unwrap()
    }

    fn identity(name: &str) -> ReplicaAwarenessIdentity {
        ReplicaAwarenessIdentity {
            name: name.to_owned(),
            color: mdbase_connect_protocol::AwarenessColor::Teal,
        }
    }

    fn new_room() -> RoomIdentity {
        RoomIdentity::new(
            Uuid::new_v4(),
            Uuid::new_v4(),
            1,
            crate::COLLABORATION_PROFILE,
        )
        .unwrap()
    }

    fn selections(ranges: &[(u32, u32)]) -> Vec<AwarenessSelectionRange> {
        ranges
            .iter()
            .map(|&(anchor, head)| AwarenessSelectionRange { anchor, head })
            .collect()
    }

    #[tokio::test]
    async fn join_snapshot_update_and_leave_follow_the_generation_stream() {
        let runtime = runtime();
        let room = new_room();
        let mut receiver = runtime.subscribe_awareness(&room);
        assert_eq!(*receiver.borrow_and_update(), 0);

        let guard_a = runtime
            .join_awareness(&room, 1, Uuid::new_v4(), &identity("Ada"))
            .unwrap();
        receiver.changed().await.unwrap();
        let snapshot = runtime.awareness_snapshot(&room);
        assert_eq!(snapshot.participants.len(), 1);
        assert_eq!(snapshot.participants[0].name, "Ada");
        assert_eq!(snapshot.participants[0].status, AwarenessStatus::Active);
        assert!(snapshot.participants[0].selections.is_empty());

        // An update that changes nothing but the lease must not broadcast;
        // a real change coalesces into exactly one new generation.
        assert!(runtime.apply_awareness_update(
            &room,
            1,
            &ClientAwarenessUpdate {
                status: AwarenessStatus::Active,
                selections: selections(&[(3, 9)]),
            },
        ));
        receiver.changed().await.unwrap();
        let before = *receiver.borrow_and_update();
        assert!(runtime.apply_awareness_update(
            &room,
            1,
            &ClientAwarenessUpdate {
                status: AwarenessStatus::Active,
                selections: selections(&[(3, 9)]),
            },
        ));
        tokio::time::timeout(Duration::from_millis(20), receiver.changed())
            .await
            .expect_err("identical update must not broadcast");
        assert_eq!(*receiver.borrow_and_update(), before);

        // A real change coalesces into exactly one new generation.
        assert!(runtime.apply_awareness_update(
            &room,
            1,
            &ClientAwarenessUpdate {
                status: AwarenessStatus::Idle,
                selections: Vec::new(),
            },
        ));
        receiver.changed().await.unwrap();
        let snapshot = runtime.awareness_snapshot(&room);
        assert_eq!(snapshot.participants[0].status, AwarenessStatus::Idle);
        assert!(snapshot.participants[0].selections.is_empty());

        // Leaving removes the participant and broadcasts once more.
        drop(guard_a);
        receiver.changed().await.unwrap();
        assert!(runtime.awareness_snapshot(&room).participants.is_empty());
        assert_eq!(runtime.awareness_participant_count(), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn awareness_expires_without_activity_and_refreshes_with_it() {
        let runtime = Arc::new(CollaborationSessionRuntime::with_awareness_ttl(
            Duration::from_secs(30),
        ));
        let room = new_room();
        let mut receiver = runtime.subscribe_awareness(&room);
        let _guard = runtime
            .join_awareness(&room, 7, Uuid::new_v4(), &identity("Grace"))
            .unwrap();
        receiver.changed().await.unwrap();

        // Advance most of the TTL, then refresh via activity.
        tokio::time::advance(Duration::from_secs(29)).await;
        runtime.refresh_awareness(&room, 7);
        tokio::time::advance(Duration::from_secs(29)).await;
        runtime.sweep_expired_awareness();
        assert_eq!(runtime.awareness_participant_count(), 1);
        assert_eq!(
            runtime.awareness_snapshot(&room).participants.len(),
            1,
            "refreshed lease must survive past the original deadline"
        );

        // Without further activity the next tick past the TTL expires them.
        tokio::time::advance(Duration::from_secs(31)).await;
        runtime.sweep_expired_awareness();
        assert_eq!(runtime.awareness_participant_count(), 0);
        receiver.changed().await.unwrap();
        receiver.borrow_and_update();
        assert!(runtime.awareness_snapshot(&room).participants.is_empty());

        // A still-connected session can become visible again through ordinary
        // activity without bypassing the room/per-replica membership caps.
        runtime.refresh_awareness(&room, 7);
        receiver.changed().await.unwrap();
        assert_eq!(runtime.awareness_participant_count(), 1);
        assert_eq!(runtime.awareness_snapshot(&room).participants.len(), 1);
    }

    #[tokio::test]
    async fn rooms_are_isolated_from_each_other() {
        let runtime = runtime();
        let room_a = new_room();
        let room_b = new_room();
        let mut receiver_b = runtime.subscribe_awareness(&room_b);
        let _guard = runtime
            .join_awareness(&room_a, 1, Uuid::new_v4(), &identity("Ada"))
            .unwrap();
        assert!(runtime.awareness_snapshot(&room_a).participants.len() == 1);
        assert!(runtime.awareness_snapshot(&room_b).participants.is_empty());
        tokio::time::timeout(Duration::from_millis(20), receiver_b.changed())
            .await
            .expect_err("another room's join must not wake this member");
    }

    #[tokio::test]
    async fn recipient_snapshots_exclude_only_the_current_socket() {
        let runtime = runtime();
        let room = new_room();
        let _a = runtime
            .join_awareness(&room, 11, Uuid::new_v4(), &identity("A"))
            .unwrap();
        let _b = runtime
            .join_awareness(&room, 22, Uuid::new_v4(), &identity("B"))
            .unwrap();

        let for_a = runtime.awareness_snapshot_for_session(&room, 11);
        assert_eq!(for_a.participants.len(), 1);
        assert_eq!(for_a.participants[0].name, "B");
        let for_b = runtime.awareness_snapshot_for_session(&room, 22);
        assert_eq!(for_b.participants.len(), 1);
        assert_eq!(for_b.participants[0].name, "A");
        assert_eq!(runtime.awareness_snapshot(&room).participants.len(), 2);
    }

    #[tokio::test]
    async fn snapshot_ordering_is_stable_by_join_order() {
        let runtime = runtime();
        let room = new_room();
        let mut guards = Vec::new();
        for session_id in [5_u64, 2, 9, 3] {
            guards.push(
                runtime
                    .join_awareness(
                        &room,
                        session_id,
                        Uuid::new_v4(),
                        &identity(&format!("P{session_id}")),
                    )
                    .unwrap(),
            );
        }
        let snapshot = runtime.awareness_snapshot(&room);
        assert_eq!(
            snapshot
                .participants
                .iter()
                .map(|participant| participant.name.as_str())
                .collect::<Vec<_>>(),
            vec!["P2", "P3", "P5", "P9"]
        );
        // Order is derived from the BTreeMap keyed by session id; verify the
        // serialized replacement snapshot stays deterministic too.
        let first = serde_json::to_string(&snapshot.to_metadata()).unwrap();
        let second =
            serde_json::to_string(&runtime.awareness_snapshot(&room).to_metadata()).unwrap();
        assert_eq!(first, second);
    }

    #[tokio::test]
    async fn room_and_replica_caps_are_enforced() {
        let runtime = runtime();
        let room = new_room();
        let replica = Uuid::new_v4();
        // Fill the room with distinct replicas up to the participant cap.
        let mut guards = Vec::new();
        for session_id in 1..=15_u64 {
            guards.push(
                runtime
                    .join_awareness(&room, session_id, Uuid::new_v4(), &identity("P"))
                    .unwrap(),
            );
        }
        guards.push(
            runtime
                .join_awareness(&room, 16, replica, &identity("P"))
                .unwrap(),
        );
        assert!(matches!(
            runtime.join_awareness(&room, 17, Uuid::new_v4(), &identity("Q")),
            Err(AwarenessJoinError::RoomFull)
        ));
        drop(guards);
        // The same replica cannot exceed four concurrent sessions across the
        // process, even in different rooms.
        let fresh_room = new_room();
        let mut replica_guards = Vec::new();
        for session_id in 1..=4_u64 {
            replica_guards.push(
                runtime
                    .join_awareness(&fresh_room, session_id, replica, &identity("P"))
                    .unwrap(),
            );
        }
        assert!(matches!(
            runtime.join_awareness(&fresh_room, 5, replica, &identity("P")),
            Err(AwarenessJoinError::ReplicaSessionLimit)
        ));
        let another_room = new_room();
        assert!(matches!(
            runtime.join_awareness(&another_room, 6, replica, &identity("P")),
            Err(AwarenessJoinError::ReplicaSessionLimit)
        ));
        // Another replica is unaffected.
        assert!(runtime
            .join_awareness(&another_room, 7, Uuid::new_v4(), &identity("Q"))
            .is_ok());
    }

    #[tokio::test]
    async fn drain_clears_all_awareness_state() {
        let runtime = runtime();
        let room = new_room();
        let (_socket_guard, close_rx, _) = runtime.register_socket(permit());
        let awareness_guard = runtime
            .join_awareness(
                &room,
                _socket_guard.session_id(),
                Uuid::new_v4(),
                &identity("Ada"),
            )
            .unwrap();
        let mut receiver = runtime.subscribe_awareness(&room);
        receiver.borrow_and_update();
        drop(close_rx);

        runtime.begin_drain();
        assert_eq!(runtime.awareness_participant_count(), 0);
        assert!(matches!(
            runtime.join_awareness(&room, 99, Uuid::new_v4(), &identity("Late")),
            Err(AwarenessJoinError::Draining)
        ));
        receiver.changed().await.unwrap();
        assert!(runtime.awareness_snapshot(&room).participants.is_empty());
        drop(awareness_guard);
        assert_eq!(runtime.awareness_participant_count(), 0);
    }

    #[tokio::test]
    async fn target_close_replica_removes_only_that_replica_presence() {
        let runtime = runtime();
        let room = new_room();
        let replica = Uuid::new_v4();
        let other = Uuid::new_v4();
        let _a = runtime
            .join_awareness(&room, 1, replica, &identity("A"))
            .unwrap();
        let _b = runtime
            .join_awareness(&room, 2, other, &identity("B"))
            .unwrap();
        assert_eq!(runtime.target_close_replica(replica), 0); // no bound sockets
        assert_eq!(runtime.awareness_snapshot(&room).participants.len(), 1);
        let survivor = runtime.awareness_snapshot(&room);
        assert_eq!(survivor.participants[0].name, "B");
    }
}
