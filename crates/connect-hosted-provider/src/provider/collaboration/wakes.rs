//! Metadata-only PostgreSQL wakeups for hosted collaboration rooms.
//!
//! An accepted collaboration batch queues one notice on the private,
//! versioned `mdbase_hosted_collaboration_commit_v1` channel as the final
//! action of its transaction. The payload is a strict allowlist of room
//! identity plus the new high-water sequence: no paths, revisions, digests,
//! mutation or replica identifiers, and never record content. Notifications
//! are hints only — delivery always reloads and decrypts the authoritative
//! rows from PostgreSQL through the durable catch-up path.
//!
//! Runtime bounds: one dedicated one-connection listener pool outside the
//! primary-pool budget, exactly one listener task and one bounded periodic
//! sweep task per process, and at most one coalesced queued wake per active
//! room. Unknown rooms allocate nothing, and no lock is held across SQL, key
//! unwrapping, or socket I/O.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use sqlx::postgres::PgListener;
use sqlx::{Postgres, Transaction};
use tokio::sync::{mpsc, watch, Mutex};

use super::*;
use crate::error::{ApiError, ApiResult};

/// Private versioned notification channel. The name is part of the internal
/// contract: payloads from this channel are parsed with a strict field
/// allowlist and anything else is discarded without logging its content.
pub(crate) const COLLABORATION_COMMIT_CHANNEL: &str = "mdbase_hosted_collaboration_commit_v1";

/// Reconcile sentinel for coalesced wakes: deliver everything the durable row
/// still stores beyond each session's cursor. Used by reconnect recovery and
/// the periodic sweep because a missed terminal notification cannot be
/// reconstructed from the channel itself.
pub(super) const WAKE_RECONCILE: u64 = u64::MAX;

/// Upper bound on a serialized notice. Real notices are far smaller; larger
/// payloads can only come from something other than the batch engine.
const MAX_NOTICE_PAYLOAD_BYTES: usize = 512;

const LISTENER_BACKOFF_INITIAL: Duration = Duration::from_millis(250);
const LISTENER_BACKOFF_MAX: Duration = Duration::from_secs(15);

pub(crate) const DEFAULT_WAKE_SWEEP_INTERVAL: Duration = Duration::from_secs(5);

/// Strict metadata allowlist for commit notices. Every field is required and
/// unknown fields are rejected, so a future or hostile publisher cannot smuggle
/// paths, revisions, digests, mutation/replica identities, or content through
/// this channel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CollaborationCommitNotice {
    pub collection_id: Uuid,
    pub record_id: Uuid,
    pub collaboration_epoch: u64,
    pub profile: String,
    pub sequence: u64,
}

impl CollaborationCommitNotice {
    pub(super) fn room(&self) -> Option<RoomIdentity> {
        RoomIdentity::new(
            self.collection_id,
            self.record_id,
            self.collaboration_epoch,
            &self.profile,
        )
    }
}

fn parse_commit_notice(payload: &str) -> Result<CollaborationCommitNotice, ()> {
    if payload.len() > MAX_NOTICE_PAYLOAD_BYTES {
        return Err(());
    }
    let notice: CollaborationCommitNotice = serde_json::from_str(payload).map_err(|_| ())?;
    if notice.room().is_none() || notice.sequence == 0 {
        return Err(());
    }
    Ok(notice)
}

/// Queue the transactional wakeup. PostgreSQL delivers it if and only if the
/// surrounding transaction commits; any error propagates so the caller aborts
/// the transaction. The payload itself is never logged.
pub(super) async fn queue_commit_notice(
    transaction: &mut Transaction<'_, Postgres>,
    notice: &CollaborationCommitNotice,
) -> ApiResult<()> {
    debug_assert!(notice.room().is_some(), "batch engine validates the room");
    let payload = serde_json::to_string(notice)
        .map_err(|_| ApiError::internal("The collaboration commit notice could not be encoded."))?;
    sqlx::query("SELECT pg_notify($1, $2)")
        .bind(COLLABORATION_COMMIT_CHANNEL)
        .bind(payload)
        .execute(&mut **transaction)
        .await?;
    Ok(())
}

type WakeSender = watch::Sender<u64>;

/// Bounded coalescing hub of per-room high-water marks. Each active room owns
/// one `watch` channel whose single value is the newest target sequence, so at
/// most one wake can be queued per room regardless of notification rate. The
/// mutex guards only map bookkeeping.
pub(crate) struct CollaborationWakeHub {
    rooms: Mutex<HashMap<RoomIdentity, WakeSender>>,
}

const MAX_ACTIVE_ROOMS: usize = 1024;

impl Default for CollaborationWakeHub {
    fn default() -> Self {
        Self::new()
    }
}

impl CollaborationWakeHub {
    pub(crate) fn new() -> Self {
        Self {
            rooms: Mutex::new(HashMap::new()),
        }
    }

    /// Subscribe one session to its room's wakes. Dead rooms are pruned here;
    /// allocation happens only for real sessions and is capped.
    pub(crate) async fn subscribe(&self, room: RoomIdentity) -> ApiResult<watch::Receiver<u64>> {
        let mut rooms = self.rooms.lock().await;
        rooms.retain(|_, sender| sender.receiver_count() > 0);
        let sender = match rooms.get(&room) {
            Some(sender) => sender.clone(),
            None => {
                if rooms.len() >= MAX_ACTIVE_ROOMS {
                    return Err(ApiError::new(
                        axum::http::StatusCode::TOO_MANY_REQUESTS,
                        "collaboration_busy",
                        "The collaboration service is busy.",
                    ));
                }
                let (sender, _) = watch::channel(0);
                rooms.insert(room, sender.clone());
                sender
            }
        };
        drop(rooms);
        Ok(sender.subscribe())
    }

    /// Coalesce a monotonic high-water wake. Rooms without local subscribers
    /// allocate nothing. Returns whether any receiver was woken.
    pub(crate) async fn wake(&self, room: &RoomIdentity, sequence: u64) -> bool {
        let rooms = self.rooms.lock().await;
        rooms
            .get(room)
            .is_some_and(|sender| wake_sender(sender, sequence))
    }

    /// Wake every active room with the reconcile sentinel. Called after a
    /// listener (re)connection gap and by the bounded sweep, because missed
    /// terminal notifications are indistinguishable from silence.
    pub(crate) async fn wake_reconcile_all(&self) {
        let rooms = self.rooms.lock().await;
        for sender in rooms.values() {
            wake_sender(sender, WAKE_RECONCILE);
        }
    }

    #[cfg(test)]
    pub(crate) async fn active_rooms(&self) -> usize {
        self.rooms.lock().await.len()
    }
}

/// Monotonic coalescing write. The reconcile sentinel always re-fires unless
/// it is already pending, because receivers consume values they have seen.
fn wake_sender(sender: &WakeSender, sequence: u64) -> bool {
    sender.send_if_modified(|high_water| {
        if *high_water == sequence {
            return false;
        }
        if sequence != WAKE_RECONCILE && *high_water != WAKE_RECONCILE && *high_water > sequence {
            return false;
        }
        *high_water = sequence;
        true
    })
}

/// Handle for stopping and awaiting the listener and sweep workers cleanly.
/// `stop` may be called more than once; workers exit on the first signal.
pub(crate) struct CollaborationWakeRuntime {
    shutdown: watch::Sender<bool>,
    completed: mpsc::UnboundedReceiver<()>,
}

impl CollaborationWakeRuntime {
    /// True until [`Self::stop`] has been requested.
    pub(crate) fn running(&self) -> bool {
        !*self.shutdown.borrow()
    }

    /// Signal shutdown and await both workers. Returns false when the workers
    /// did not finish within the budget.
    pub(crate) async fn stop(&mut self, within: Duration) -> bool {
        let _ = self.shutdown.send(true);
        for _ in 0..2 {
            match tokio::time::timeout(within, self.completed.recv()).await {
                Ok(Some(())) => {}
                _ => return false,
            }
        }
        true
    }
}

/// Start the wake runtime fail-closed: the initial LISTEN subscription must
/// succeed before this returns, otherwise collaboration startup fails. The
/// listener uses a dedicated one-connection pool built by
/// [`listener_pool_options`], which sits entirely outside the primary-pool
/// connection budget.
pub(crate) async fn spawn_wake_runtime(
    database_url: &str,
    hub: Arc<CollaborationWakeHub>,
    sweep_interval: Duration,
) -> ApiResult<CollaborationWakeRuntime> {
    let pool = listener_pool_options()
        .connect(database_url)
        .await
        .map_err(|error| {
            ApiError::internal(format!(
                "The collaboration wake listener failed to start: {error}"
            ))
        })?;
    let mut listener = PgListener::connect_with(&pool).await.map_err(|error| {
        ApiError::internal(format!(
            "The collaboration wake listener failed to start: {error}"
        ))
    })?;
    listener
        .listen(COLLABORATION_COMMIT_CHANNEL)
        .await
        .map_err(|error| {
            ApiError::internal(format!(
                "The collaboration wake listener could not subscribe: {error}"
            ))
        })?;
    let (shutdown, shutdown_rx) = watch::channel(false);
    let (completed_tx, completed_rx) = mpsc::unbounded_channel();
    // The listener holds its own clone of the dedicated pool; the runtime does
    // not touch any primary lane.
    tokio::spawn(run_listener(
        listener,
        hub.clone(),
        shutdown_rx.clone(),
        completed_tx.clone(),
    ));
    tokio::spawn(run_sweep(hub, sweep_interval, shutdown_rx, completed_tx));
    Ok(CollaborationWakeRuntime {
        shutdown,
        completed: completed_rx,
    })
}

/// Dedicated one-connection pool options for LISTEN. This lane is deliberately
/// not part of `PRIMARY_POOL_CONNECTIONS`: a listener that silently borrowed a
/// primary slot would shrink every handler's admission budget by one.
fn listener_pool_options() -> sqlx::postgres::PgPoolOptions {
    sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .min_connections(0)
        .acquire_timeout(Duration::from_secs(10))
        .max_lifetime(None)
        .idle_timeout(None)
        .after_connect(|connection, _metadata| {
            Box::pin(async move {
                sqlx::query("SET application_name = 'mdbase-connect-collab-wake-listener'")
                    .execute(connection)
                    .await?;
                Ok(())
            })
        })
}

async fn run_listener(
    mut listener: PgListener,
    hub: Arc<CollaborationWakeHub>,
    mut shutdown: watch::Receiver<bool>,
    completed: mpsc::UnboundedSender<()>,
) {
    let mut backoff = LISTENER_BACKOFF_INITIAL;
    loop {
        tokio::select! {
            _ = shutdown.changed() => break,
            notification = listener.recv() => match notification {
                Ok(notification) => {
                    backoff = LISTENER_BACKOFF_INITIAL;
                    // Never log the payload; malformed input is counted, not
                    // echoed.
                    match parse_commit_notice(notification.payload()) {
                        Ok(notice) => {
                            let room = notice.room().expect("parsed notices carry valid rooms");
                            hub.wake(&room, notice.sequence).await;
                        }
                        Err(()) => {
                            tracing::debug!(
                                "ignored malformed collaboration wake notification"
                            );
                        }
                    }
                }
                Err(error) => {
                    // PgListener reconnects and re-subscribes on its own;
                    // notifications emitted during the gap are lost, which
                    // reconcile-on-recovery and the sweep exist to cover.
                    tracing::warn!(
                        %error,
                        backoff_ms = backoff.as_millis() as u64,
                        "collaboration wake listener lost; reconciling active rooms"
                    );
                    hub.wake_reconcile_all().await;
                    sleep_or_shutdown(&mut shutdown, backoff).await;
                    backoff = (backoff * 2).min(LISTENER_BACKOFF_MAX);
                }
            },
        }
    }
    let _ = completed.send(());
}

async fn run_sweep(
    hub: Arc<CollaborationWakeHub>,
    interval: Duration,
    mut shutdown: watch::Receiver<bool>,
    completed: mpsc::UnboundedSender<()>,
) {
    let mut tick = tokio::time::interval(interval.max(Duration::from_millis(50)));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            _ = shutdown.changed() => break,
            _ = tick.tick() => hub.wake_reconcile_all().await,
        }
    }
    let _ = completed.send(());
}

async fn sleep_or_shutdown(shutdown: &mut watch::Receiver<bool>, duration: Duration) {
    tokio::select! {
        _ = shutdown.changed() => {}
        _ = tokio::time::sleep(duration) => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn notice(sequence: u64) -> CollaborationCommitNotice {
        CollaborationCommitNotice {
            collection_id: Uuid::new_v4(),
            record_id: Uuid::new_v4(),
            collaboration_epoch: 1,
            profile: crate::COLLABORATION_PROFILE.to_owned(),
            sequence,
        }
    }

    #[test]
    fn serialized_notice_contains_exactly_the_metadata_allowlist() {
        let notice = notice(7);
        let payload = serde_json::to_string(&notice).unwrap();
        let value: serde_json::Value = serde_json::from_str(&payload).unwrap();
        let object = value.as_object().unwrap();
        let mut keys: Vec<_> = object.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec![
                "collaboration_epoch",
                "collection_id",
                "profile",
                "record_id",
                "sequence"
            ]
        );
        assert_eq!(object["sequence"], 7);
        assert_eq!(object["profile"], crate::COLLABORATION_PROFILE);
        assert!(parse_commit_notice(&payload).is_ok());
    }

    #[test]
    fn notices_reject_content_bearing_and_unknown_fields() {
        let notice = notice(3);
        let payload = serde_json::to_string(&notice).unwrap();
        let mut value: serde_json::Value = serde_json::from_str(&payload).unwrap();
        for smuggled in [
            "digest",
            "payload",
            "path",
            "revision",
            "replica_id",
            "client_mutation_id",
            "document",
        ] {
            value[smuggled] = "smuggled".into();
            let text = serde_json::to_string(&value).unwrap();
            assert!(parse_commit_notice(&text).is_err(), "{smuggled} accepted");
            value.as_object_mut().unwrap().remove(smuggled);
        }
        // Wrong types and missing fields are equally invalid.
        assert!(parse_commit_notice("{}").is_err());
        assert!(parse_commit_notice("{\"sequence\":\"seven\"}").is_err());
        assert!(parse_commit_notice("").is_err());
        // Oversized payloads cannot be notices regardless of shape.
        let padded = format!("{payload}{}", " ".repeat(MAX_NOTICE_PAYLOAD_BYTES + 1));
        assert!(parse_commit_notice(&padded).is_err());
    }

    #[test]
    fn notices_reject_unknown_profiles_zero_epochs_and_sequences() {
        let mut unknown_profile = notice(1);
        unknown_profile.profile = "other-profile".into();
        let payload = serde_json::to_string(&unknown_profile).unwrap();
        assert!(parse_commit_notice(&payload).is_err());

        let mut zero_epoch = notice(1);
        zero_epoch.collaboration_epoch = 0;
        let payload = serde_json::to_string(&zero_epoch).unwrap();
        assert!(parse_commit_notice(&payload).is_err());

        let payload = serde_json::to_string(&notice(0)).unwrap();
        assert!(parse_commit_notice(&payload).is_err());
    }

    #[tokio::test]
    async fn hub_coalesces_duplicates_and_reversed_high_water_marks() {
        let hub = CollaborationWakeHub::new();
        let room = RoomIdentity::new(
            Uuid::new_v4(),
            Uuid::new_v4(),
            1,
            crate::COLLABORATION_PROFILE,
        )
        .unwrap();
        let mut receiver = hub.subscribe(room).await.unwrap();
        assert_eq!(*receiver.borrow_and_update(), 0);
        assert!(hub.wake(&room, 5).await);
        receiver.changed().await.unwrap();
        assert_eq!(*receiver.borrow_and_update(), 5);
        // Duplicates and stale/reversed marks never fire again.
        assert!(!hub.wake(&room, 5).await);
        assert!(!hub.wake(&room, 2).await);
        // The reconcile sentinel always fires.
        assert!(hub.wake(&room, WAKE_RECONCILE).await);
        receiver.changed().await.unwrap();
        assert_eq!(*receiver.borrow_and_update(), WAKE_RECONCILE);
        assert!(!hub.wake(&room, WAKE_RECONCILE).await);
    }

    #[tokio::test]
    async fn unknown_rooms_allocate_nothing_and_subscriptions_are_pruned() {
        let hub = CollaborationWakeHub::new();
        let known = RoomIdentity::new(
            Uuid::new_v4(),
            Uuid::new_v4(),
            1,
            crate::COLLABORATION_PROFILE,
        )
        .unwrap();
        let unknown = RoomIdentity::new(
            Uuid::new_v4(),
            Uuid::new_v4(),
            1,
            crate::COLLABORATION_PROFILE,
        )
        .unwrap();
        let receiver = hub.subscribe(known).await.unwrap();
        assert!(!hub.wake(&unknown, 9).await);
        assert_eq!(hub.active_rooms().await, 1, "unknown room allocated state");
        // Dropping the receiver retires the room on the next subscribe, and a
        // fresh subscription starts from a clean high-water mark.
        drop(receiver);
        let replacement = hub.subscribe(known).await.unwrap();
        assert_eq!(*replacement.borrow(), 0);
        assert_eq!(hub.active_rooms().await, 1);
    }
}
