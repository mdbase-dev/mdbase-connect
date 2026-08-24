//! Bounded process-local collaboration session runtime and socket database
//! lane.
//!
//! The runtime is owned by [`AppState`] and tracks every upgraded
//! collaboration socket so shutdown can drain deterministically. Its phase
//! machine is `Accepting -> Draining -> Closing -> Drained`: draining rejects
//! new tickets, upgrades, and updates while already-started update batches
//! finish, then sockets receive a WebSocket close (1001 going away) and the
//! runtime awaits their exit. RAII guards keep the socket count and in-flight
//! update count honest without cooperative bookkeeping.
//!
//! Every upgraded-socket database operation runs through [`SocketDbLane`],
//! which holds one slot of the same bounded request semaphore as ordinary
//! requests plus one `HostedProvider::acquire_runtime_admission` transaction.
//! Lanes are never held across socket writes: each wrapper releases both
//! permits as soon as the database round trip finishes, so slow clients cannot
//! pin the provider's admission budget.
//!
//! Sessions are bound to the replica credential fingerprint captured when the
//! one-shot ticket is consumed. Token rotation therefore ends live sessions
//! without a scope bump: local internal handlers target-close their own
//! replicas immediately after commit, and every session additionally
//! reauthorizes against PostgreSQL every two seconds, bounding cross-instance
//! detection without any awareness channel or Editor involvement.
#![allow(dead_code)] // Drain wiring is reached from the provider binary and tests.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicU8, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use sqlx::{Postgres, Transaction};
use tokio::sync::{watch, OwnedSemaphorePermit};
use uuid::Uuid;

use crate::{
    error::{ApiError, ApiResult},
    http::AppState,
    provider::collaboration::{
        CollaborationBatchReceipt, CollaborationCatchUpItem, ConsumedCollaborationTicket,
    },
};

/// WebSocket close code for a deliberate server drain (going away).
pub(crate) const COLLABORATION_CLOSE_GOING_AWAY: u16 = 1001;
/// WebSocket close code for sessions lost to revocation, rotation, downgrade,
/// reauthorization failure, or suspended admission (policy violation).
pub(crate) const COLLABORATION_CLOSE_POLICY: u16 = 1008;

pub(crate) const DRAIN_DIRECTIVE: SessionCloseDirective = SessionCloseDirective {
    code: COLLABORATION_CLOSE_GOING_AWAY,
};
pub(crate) const POLICY_DIRECTIVE: SessionCloseDirective = SessionCloseDirective {
    code: COLLABORATION_CLOSE_POLICY,
};

/// How long a socket operation waits for a shared request slot before giving
/// up. Sessions fail closed under saturation instead of queueing forever.
const SESSION_LANE_ACQUIRE_TIMEOUT: Duration = Duration::from_secs(2);
const SESSION_LANE_ACQUIRE_POLL: Duration = Duration::from_millis(20);

/// Server-driven session reauthorization cadence. Revocation, rotation,
/// downgrade, and admission suspension committed anywhere converge to socket
/// closure within one tick plus query latency, well under four seconds.
pub(crate) const SESSION_REAUTHORIZATION_INTERVAL: Duration = Duration::from_secs(2);

const PHASE_ACCEPTING: u8 = 0;
const PHASE_DRAINING: u8 = 1;
const PHASE_CLOSING: u8 = 2;
const PHASE_DRAINED: u8 = 3;

/// Lifecycle of the process-local collaboration session runtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CollaborationSessionPhase {
    Accepting,
    Draining,
    Closing,
    Drained,
}

impl CollaborationSessionPhase {
    fn from_u8(value: u8) -> Self {
        match value {
            PHASE_CLOSING => Self::Closing,
            PHASE_DRAINING => Self::Draining,
            PHASE_DRAINED => Self::Drained,
            _ => Self::Accepting,
        }
    }
}

/// Why the runtime asked one session to close. Carried to the session task so
/// the socket receives the matching WebSocket close code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SessionCloseDirective {
    pub(crate) code: u16,
}

struct SessionEntry {
    replica_id: Option<Uuid>,
    close: watch::Sender<Option<SessionCloseDirective>>,
}

/// Shared runtime behind [`AppState`]. Registry mutations never await, so the
/// RAII guards can unregister from synchronous `Drop`.
pub(crate) struct CollaborationSessionRuntime {
    phase: AtomicU8,
    next_session_id: AtomicU64,
    live_sockets: AtomicUsize,
    in_flight_updates: AtomicUsize,
    /// Bumped whenever a counter changes so a drainer can wait without
    /// polling. Values carry no meaning beyond change detection.
    progress: watch::Sender<u64>,
    sessions: Mutex<HashMap<u64, SessionEntry>>,
}

impl Default for CollaborationSessionRuntime {
    fn default() -> Self {
        Self::new()
    }
}

impl CollaborationSessionRuntime {
    pub(crate) fn new() -> Self {
        let (progress, _) = watch::channel(0);
        Self {
            phase: AtomicU8::new(PHASE_ACCEPTING),
            next_session_id: AtomicU64::new(1),
            live_sockets: AtomicUsize::new(0),
            in_flight_updates: AtomicUsize::new(0),
            progress,
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub(crate) fn phase(&self) -> CollaborationSessionPhase {
        CollaborationSessionPhase::from_u8(self.phase.load(Ordering::Acquire))
    }

    /// True only while tickets, upgrades, and updates are admitted.
    pub(crate) fn accepting(&self) -> bool {
        self.phase() == CollaborationSessionPhase::Accepting
    }

    pub(crate) fn tracked_sockets(&self) -> usize {
        self.live_sockets.load(Ordering::SeqCst)
    }

    pub(crate) fn in_flight_updates(&self) -> usize {
        self.in_flight_updates.load(Ordering::SeqCst)
    }

    fn signal_progress(&self) {
        self.progress.send_modify(|generation| {
            *generation = generation.wrapping_add(1);
        });
    }

    /// Register one upgraded socket. The collaboration slot permit moves into
    /// the returned RAII guard so permit release and deregistration share one
    /// lifetime. Returns a close receiver plus whether the runtime had already
    /// left `Accepting`; late racers receive a directive immediately and must
    /// close without touching the database.
    pub(crate) fn register_socket(
        self: &Arc<Self>,
        permit: OwnedSemaphorePermit,
    ) -> (
        CollaborationSocketGuard,
        watch::Receiver<Option<SessionCloseDirective>>,
        bool,
    ) {
        let session_id = self.next_session_id.fetch_add(1, Ordering::Relaxed);
        let (close, close_rx) = watch::channel(None);
        self.live_sockets.fetch_add(1, Ordering::SeqCst);
        let immediate;
        {
            let mut sessions = self.sessions.lock().expect("session registry poisoned");
            sessions.insert(
                session_id,
                SessionEntry {
                    replica_id: None,
                    close,
                },
            );
            // Read the phase only after insertion: a concurrent begin_drain
            // either signals this entry under the same lock, or is observed
            // here. There is no ordering in which a session survives a drain
            // unnoticed.
            immediate = !self.accepting();
            if immediate {
                if let Some(entry) = sessions.get_mut(&session_id) {
                    let _ = entry.close.send(Some(DRAIN_DIRECTIVE));
                }
            }
        }
        self.signal_progress();
        (
            CollaborationSocketGuard {
                runtime: Arc::clone(self),
                session_id,
                _permit: permit,
            },
            close_rx,
            immediate,
        )
    }

    /// Enter `Draining` and tell every registered session to finish its
    /// started work, then close with 1001. Idempotent; later registrations are
    /// refused by the admission gates.
    pub(crate) fn begin_drain(&self) {
        let started = self
            .phase
            .compare_exchange(
                PHASE_ACCEPTING,
                PHASE_DRAINING,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok();
        {
            let sessions = self.sessions.lock().expect("session registry poisoned");
            for entry in sessions.values() {
                let _ = entry.close.send_if_modified(|slot| {
                    if slot.is_some() {
                        return false;
                    }
                    *slot = Some(DRAIN_DIRECTIVE);
                    true
                });
            }
        }
        if started {
            tracing::info!(
                sockets = self.tracked_sockets(),
                "collaboration session drain started"
            );
        }
    }

    /// Advance the phase machine toward `Drained` once a drainer observes
    /// quiescence. Returns true only when no sockets and no in-flight updates
    /// remain.
    fn advance_toward_drained(&self) -> bool {
        let updates = self.in_flight_updates();
        let sockets = self.tracked_sockets();
        if updates == 0 && sockets == 0 {
            self.phase.store(PHASE_DRAINED, Ordering::Release);
            return true;
        }
        if updates == 0 {
            // Started batches finished; only socket teardown remains.
            let _ = self.phase.compare_exchange(
                PHASE_DRAINING,
                PHASE_CLOSING,
                Ordering::AcqRel,
                Ordering::Acquire,
            );
        }
        false
    }

    /// Await socket exit and in-flight update completion within `within`,
    /// advancing `Draining -> Closing -> Drained` as conditions allow. False
    /// means the budget expired mid-drain; the phase stays observable and the
    /// caller decides how loudly to fail.
    pub(crate) async fn finish_drain(&self, within: Duration) -> bool {
        self.begin_drain();
        let deadline = Instant::now() + within;
        let mut progress = self.progress.subscribe();
        loop {
            if self.advance_toward_drained() {
                tracing::info!("collaboration session drain completed");
                return true;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return false;
            }
            // Progress fires on every guard transition, so this wakes exactly
            // when the counters could have changed.
            if tokio::time::timeout(remaining, progress.changed())
                .await
                .is_err()
            {
                return self.advance_toward_drained();
            }
        }
    }

    /// Close every session bound to `replica_id` with the policy code. Used by
    /// the local internal rotate/policy/revoke handlers right after their
    /// transaction commits. Returns the number of sessions signaled.
    pub(crate) fn target_close_replica(&self, replica_id: Uuid) -> usize {
        let sessions = self.sessions.lock().expect("session registry poisoned");
        let mut closed = 0;
        for entry in sessions.values() {
            if entry.replica_id != Some(replica_id) {
                continue;
            }
            let signaled = entry.close.send_if_modified(|slot| {
                if slot.is_some() {
                    return false;
                }
                *slot = Some(POLICY_DIRECTIVE);
                true
            });
            if signaled && entry.close.receiver_count() > 0 {
                closed += 1;
            }
        }
        if closed > 0 {
            tracing::debug!(%replica_id, closed, "target-closed collaboration sessions");
        }
        closed
    }

    /// Mark one update batch as started. The returned RAII guard keeps drain
    /// waiting until the batch has fully finished, whether it committed or
    /// failed.
    pub(crate) fn begin_update(self: &Arc<Self>) -> CollaborationUpdateGuard {
        self.in_flight_updates.fetch_add(1, Ordering::SeqCst);
        self.signal_progress();
        CollaborationUpdateGuard {
            runtime: Arc::clone(self),
        }
    }

    fn unregister_socket(&self, session_id: u64) {
        {
            let mut sessions = self.sessions.lock().expect("session registry poisoned");
            sessions.remove(&session_id);
        }
        self.live_sockets.fetch_sub(1, Ordering::SeqCst);
        self.signal_progress();
    }
}

/// RAII registration of one upgraded socket. Dropping it removes the registry
/// entry, releases the collaboration slot permit, and wakes any drainer.
pub(crate) struct CollaborationSocketGuard {
    runtime: Arc<CollaborationSessionRuntime>,
    session_id: u64,
    _permit: OwnedSemaphorePermit,
}

impl CollaborationSocketGuard {
    /// Bind this socket to the replica named by its consumed ticket so local
    /// rotate/policy/revoke commits can target-close exactly these sessions.
    pub(crate) fn bind_replica(&self, replica_id: Uuid) {
        let mut sessions = self
            .runtime
            .sessions
            .lock()
            .expect("session registry poisoned");
        if let Some(entry) = sessions.get_mut(&self.session_id) {
            entry.replica_id = Some(replica_id);
        }
    }
}

impl Drop for CollaborationSocketGuard {
    fn drop(&mut self) {
        self.runtime.unregister_socket(self.session_id);
    }
}

/// RAII marker for one in-flight update batch.
pub(crate) struct CollaborationUpdateGuard {
    runtime: Arc<CollaborationSessionRuntime>,
}

impl Drop for CollaborationUpdateGuard {
    fn drop(&mut self) {
        self.runtime
            .in_flight_updates
            .fetch_sub(1, Ordering::SeqCst);
        self.runtime.signal_progress();
    }
}

/// One upgraded-socket database operation's worth of admission: a shared
/// request slot plus the provider advisory-admission transaction. Hold times
/// are bounded to single database round trips; never across socket writes.
pub(crate) struct SocketDbLane {
    _slot: OwnedSemaphorePermit,
    admission: Transaction<'static, Postgres>,
}

impl SocketDbLane {
    /// Commit (usually just release) the admission transaction and drop the
    /// request slot together.
    pub(crate) async fn release(self) {
        let _ = self.admission.commit().await;
    }
}

impl AppState {
    pub(crate) fn collaboration_sessions_accepting(&self) -> bool {
        self.collaboration_sessions.accepting()
    }

    pub(crate) fn collaboration_session_phase(&self) -> CollaborationSessionPhase {
        self.collaboration_sessions.phase()
    }

    pub(crate) fn collaboration_tracked_sockets(&self) -> usize {
        self.collaboration_sessions.tracked_sockets()
    }

    #[cfg(test)]
    pub(crate) fn collaboration_in_flight_updates(&self) -> usize {
        self.collaboration_sessions.in_flight_updates()
    }

    pub(crate) fn register_collaboration_socket(
        &self,
        permit: OwnedSemaphorePermit,
    ) -> (
        CollaborationSocketGuard,
        watch::Receiver<Option<SessionCloseDirective>>,
        bool,
    ) {
        self.collaboration_sessions.register_socket(permit)
    }

    pub(crate) fn begin_collaboration_update(&self) -> CollaborationUpdateGuard {
        self.collaboration_sessions.begin_update()
    }

    /// Local post-commit hook for internal replica mutations.
    pub fn target_close_replica_sessions(&self, replica_id: Uuid) -> usize {
        self.collaboration_sessions.target_close_replica(replica_id)
    }

    pub fn begin_collaboration_session_drain(&self) {
        self.collaboration_sessions.begin_drain();
    }

    pub async fn finish_collaboration_session_drain(&self, within: Duration) -> bool {
        self.collaboration_sessions.finish_drain(within).await
    }

    /// Acquire one socket database lane: bounded wait on the shared request
    /// semaphore, then the provider admission transaction. Fails closed when
    /// the provider is saturated or admission is suspended/fenced.
    pub(crate) async fn collaboration_session_lane(&self) -> ApiResult<SocketDbLane> {
        let deadline = Instant::now() + SESSION_LANE_ACQUIRE_TIMEOUT;
        let slot = loop {
            match self.request_slots.clone().try_acquire_owned() {
                Ok(slot) => break slot,
                Err(_) => {
                    if Instant::now() >= deadline {
                        return Err(ApiError::new(
                            axum::http::StatusCode::SERVICE_UNAVAILABLE,
                            "collaboration_busy",
                            "The collaboration service is busy.",
                        ));
                    }
                    tokio::time::sleep(SESSION_LANE_ACQUIRE_POLL).await;
                }
            }
        };
        let admission = match self.provider.acquire_runtime_admission().await {
            Ok(admission) => admission,
            Err(error) => {
                drop(slot);
                return Err(error);
            }
        };
        Ok(SocketDbLane {
            _slot: slot,
            admission,
        })
    }

    /// Consume a one-shot ticket inside a lane. The returned binding carries
    /// the replica's current token-hash fingerprint.
    pub(crate) async fn session_consume_ticket(
        &self,
        plaintext: &str,
        origin: Option<&str>,
    ) -> ApiResult<ConsumedCollaborationTicket> {
        let lane = self.collaboration_session_lane().await?;
        let consumed = self
            .provider
            .consume_collaboration_ticket(plaintext, origin)
            .await;
        lane.release().await;
        consumed
    }

    /// Durable state-vector sync inside a lane.
    pub(crate) async fn session_sync_step2(
        &self,
        consumed: &ConsumedCollaborationTicket,
        state_vector: &[u8],
    ) -> ApiResult<(Vec<u8>, u64)> {
        let lane = self.collaboration_session_lane().await?;
        let result = self
            .provider
            .collaboration_sync_step2(
                consumed.metadata.room,
                consumed.metadata.replica_id,
                consumed.metadata.scope_epoch,
                state_vector,
            )
            .await;
        lane.release().await;
        result
    }

    /// Commit one authenticated update batch inside a lane. The contribution
    /// carries the session's token fingerprint so a rotated-away session can
    /// never land an update that races the rotation detection window.
    pub(crate) async fn session_commit_update(
        &self,
        consumed: &ConsumedCollaborationTicket,
        client_mutation_id: Uuid,
        update: Vec<u8>,
    ) -> ApiResult<(Vec<CollaborationBatchReceipt>, bool)> {
        let lane = self.collaboration_session_lane().await?;
        let input = crate::provider::collaboration::CollaborationBatchInput {
            collection_id: consumed.metadata.room.collection_id,
            record_id: consumed.metadata.room.record_id,
            epoch: consumed.metadata.room.epoch,
            contributions: vec![
                crate::provider::collaboration::CollaborationBatchContribution {
                    replica_id: consumed.metadata.replica_id,
                    expected_scope_epoch: consumed.metadata.scope_epoch,
                    expected_token_hash: consumed.metadata.replica_token_hash,
                    client_mutation_id,
                    update,
                },
            ],
        };
        let result = self.provider.commit_collaboration_batch(input).await;
        lane.release().await;
        result
    }

    /// Reauthorize the session against PostgreSQL inside a lane: replica
    /// present and unrevoked, credential fingerprint unchanged, scope epoch
    /// unchanged, room still current and active, record still materialized.
    pub(crate) async fn session_reauthorize(
        &self,
        consumed: &ConsumedCollaborationTicket,
    ) -> ApiResult<()> {
        let lane = self.collaboration_session_lane().await?;
        let result = self
            .provider
            .reauthorize_collaboration_session(
                consumed.metadata.room,
                consumed.metadata.replica_id,
                consumed.metadata.scope_epoch,
                &consumed.metadata.replica_token_hash,
            )
            .await;
        lane.release().await;
        result
    }

    /// One delivery round inside a single lane: reauthorize immediately
    /// before loading authoritative plaintext, then release both permits
    /// before any frame is written to the socket.
    pub(crate) async fn session_reauthorized_catch_up(
        &self,
        consumed: &ConsumedCollaborationTicket,
        after_exclusive: u64,
        through: u64,
    ) -> ApiResult<Vec<CollaborationCatchUpItem>> {
        let lane = self.collaboration_session_lane().await?;
        let authorized = self
            .provider
            .reauthorize_collaboration_session(
                consumed.metadata.room,
                consumed.metadata.replica_id,
                consumed.metadata.scope_epoch,
                &consumed.metadata.replica_token_hash,
            )
            .await;
        let items = async {
            authorized?;
            self.provider
                .collaboration_catch_up(consumed.metadata.room, after_exclusive, through)
                .await
        }
        .await;
        lane.release().await;
        items
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runtime() -> Arc<CollaborationSessionRuntime> {
        Arc::new(CollaborationSessionRuntime::new())
    }

    fn permit() -> OwnedSemaphorePermit {
        Arc::new(tokio::sync::Semaphore::new(4))
            .try_acquire_owned()
            .unwrap()
    }

    #[tokio::test]
    async fn drain_signals_registered_sockets_and_refuses_late_registration() {
        let runtime = runtime();
        let (_guard_a, mut close_a, immediate_a) = runtime.register_socket(permit());
        assert!(!immediate_a);
        assert_eq!(runtime.tracked_sockets(), 1);
        assert!(runtime.accepting());

        runtime.begin_drain();
        assert_eq!(runtime.phase(), CollaborationSessionPhase::Draining);
        close_a.changed().await.unwrap();
        assert_eq!(
            close_a.borrow().unwrap().code,
            COLLABORATION_CLOSE_GOING_AWAY
        );

        // A session registered after drain began closes immediately instead of
        // racing the signal loop.
        let (_guard_b, mut close_b, immediate_b) = runtime.register_socket(permit());
        assert!(immediate_b);
        close_b.changed().await.unwrap();
        assert_eq!(
            close_b.borrow().unwrap().code,
            COLLABORATION_CLOSE_GOING_AWAY
        );
    }

    #[tokio::test]
    async fn finish_drain_awaits_in_flight_updates_then_sockets() {
        let runtime = runtime();
        let (_guard, close_rx, _) = runtime.register_socket(permit());
        let update_guard = runtime.begin_update();

        runtime.begin_drain();
        let drainer_runtime = Arc::clone(&runtime);
        let drainer =
            tokio::spawn(async move { drainer_runtime.finish_drain(Duration::from_secs(5)).await });
        // While the batch is in flight the phase stays Draining even though a
        // short budget would otherwise be exhausted.
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(runtime.phase(), CollaborationSessionPhase::Draining);
        assert!(!drainer.is_finished());

        drop(update_guard);
        // Socket still open: closing phase, never drained.
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(runtime.phase(), CollaborationSessionPhase::Closing);
        assert!(!drainer.is_finished());

        drop(_guard);
        drop(close_rx);
        let drained = timeout(drainer).await.expect("drain task must not panic");
        assert!(drained);
        assert_eq!(runtime.phase(), CollaborationSessionPhase::Drained);
        assert_eq!(runtime.tracked_sockets(), 0);
        assert_eq!(runtime.in_flight_updates(), 0);
    }

    #[tokio::test]
    async fn target_close_only_signals_the_matching_replica() {
        let runtime = runtime();
        let replica = Uuid::new_v4();
        let other = Uuid::new_v4();
        let (guard, mut close_rx, _) = runtime.register_socket(permit());
        guard.bind_replica(replica);
        let (_survivor, mut survivor_rx, _) = runtime.register_socket(permit());
        survivor_rx.borrow_and_update();

        assert_eq!(runtime.target_close_replica(other), 0);
        assert!(!close_rx.has_changed().unwrap());
        assert_eq!(runtime.target_close_replica(replica), 1);
        close_rx.changed().await.unwrap();
        assert_eq!(close_rx.borrow().unwrap().code, COLLABORATION_CLOSE_POLICY);
        // Repeated targeting does not re-fire.
        assert_eq!(runtime.target_close_replica(replica), 0);
        assert!(!survivor_rx.has_changed().unwrap());
    }

    #[tokio::test]
    async fn dropping_guards_unregisters_and_wakes_the_drainer() {
        let runtime = runtime();
        let (guard, _, _) = runtime.register_socket(permit());
        assert_eq!(runtime.tracked_sockets(), 1);
        drop(guard);
        assert_eq!(runtime.tracked_sockets(), 0);
        // Everything already quiescent drains instantly to terminal state.
        assert!(runtime.finish_drain(Duration::from_secs(1)).await);
        assert_eq!(runtime.phase(), CollaborationSessionPhase::Drained);
    }

    async fn timeout<T>(future: impl std::future::Future<Output = T>) -> T {
        tokio::time::timeout(Duration::from_secs(2), future)
            .await
            .expect("drain future must resolve")
    }
}
