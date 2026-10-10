//! Profile-bound IPC subscription. It neither starts a daemon nor falls back to
//! the installed profile. The only mutation exposed is a request for the existing
//! daemon-native access approval flow; there is no generic RPC/answer entry point.

use std::time::Duration;

use tokio::sync::watch;

use super::{CompanionModel, HoldPreview, ReviewRequest};
use crate::access::{AccessEntry, AccessEvent};
use crate::client::{ClientError, ControlClient};
use crate::control::{DaemonStatus, HoldSummary, Method};
use crate::paths::Profile;
use crate::secrets::SecretStore;

/// One bounded, replace-in-place UI update, never an unbounded event queue.
#[derive(Debug, Clone, Default)]
pub struct Snapshot {
    /// Current presentation, cleared whenever the authenticated stream closes.
    pub model: CompanionModel,
    /// Changes since startup. The UI coalesces bursts into a generic static
    /// access-changed notification and never silently calls them only revocations.
    pub notice_sequence: u64,
    unreviewed_digest: [u8; 32],
    /// Newly protected files since startup; the UI shows the fixed
    /// "mdbase protected your edit" notice once per change.
    pub hold_sequence: u64,
    held_digest: [u8; 32],
}

/// Collections the tray reads holds for at once (the rest wait for the CLI).
const MAX_HELD_COLLECTIONS: usize = 8;

/// Fixed lock-screen-safe copy for any coalesced access event or unreviewed grant.
pub const ACCESS_CHANGED: &str = "App access changed on this computer. Review access in mdbase.";

async fn connect(profile: &Profile, store: &dyn SecretStore) -> Result<ControlClient, ClientError> {
    let mut client = ControlClient::connect(&profile.control).await?;
    client.authenticate(store).await?;
    Ok(client)
}

async fn entries(
    profile: &Profile,
    store: &dyn SecretStore,
) -> Result<Vec<AccessEntry>, ClientError> {
    let mut client = connect(profile, store).await?;
    let value = client
        .call(Method::ACCESS_LIST, serde_json::json!({}))
        .await?;
    serde_json::from_value(value).map_err(|error| ClientError::Protocol(error.to_string()))
}

/// The protected files of the collections that report holds, content-free. A
/// collection whose runtime refuses the read is skipped, never guessed.
async fn held(profile: &Profile, store: &dyn SecretStore) -> Result<Vec<HoldPreview>, ClientError> {
    let mut client = connect(profile, store).await?;
    let status: DaemonStatus =
        serde_json::from_value(client.call(Method::STATUS, serde_json::json!({})).await?)
            .map_err(|error| ClientError::Protocol(error.to_string()))?;
    let mut holds = Vec::new();
    for collection in status
        .collections
        .iter()
        .filter(|c| c.sync.as_ref().is_some_and(|s| s.holds > 0))
        .take(MAX_HELD_COLLECTIONS)
    {
        let Ok(value) = client
            .call(
                Method::COLLECTION_HOLDS,
                serde_json::json!({ "collection": collection.id }),
            )
            .await
        else {
            continue;
        };
        let summaries: Vec<HoldSummary> = serde_json::from_value(value)
            .map_err(|error| ClientError::Protocol(error.to_string()))?;
        holds.extend(
            summaries
                .iter()
                .take(super::MAX_HOLDS)
                .map(|h| HoldPreview::from_summary(&collection.id, h)),
        );
    }
    Ok(holds)
}

/// Holds reported by a status push, without reading them.
fn held_count(payload: &serde_json::Value) -> u64 {
    payload
        .get("collections")
        .and_then(serde_json::Value::as_array)
        .map(|cs| {
            cs.iter()
                .filter_map(|c| c.get("sync")?.get("holds")?.as_u64())
                .sum()
        })
        .unwrap_or(0)
}

/// Ask the selected profile's daemon to show its native final approval dialog, or
/// to resolve a protected file as the hosting app. No UI response is sent, and no
/// automatic retry can duplicate a dialog or a resolution. A compare hand-off is
/// not a daemon request (the companion opens the app link itself).
pub async fn request_review(profile: &Profile, request: &ReviewRequest) -> Result<(), ClientError> {
    let store = crate::secrets::store_for(&profile.secret_namespace(), &profile.state_dir);
    request_review_with(profile, request, store.as_ref()).await
}

async fn request_review_with(
    profile: &Profile,
    request: &ReviewRequest,
    store: &dyn SecretStore,
) -> Result<(), ClientError> {
    if request.compare_link().is_some() {
        return Err(ClientError::Protocol(
            "compare is opened by the companion, not the daemon".into(),
        ));
    }
    let mut client = connect(profile, store).await?;
    client.call(request.method(), request.params()).await?;
    Ok(())
}

/// Replace the protected files; a change in the set of held IDs is one notice.
fn replace_held(state: &mut Snapshot, holds: &[HoldPreview]) {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    for hold in holds {
        hash.update((hold.collection.len() as u64).to_le_bytes());
        hash.update(hold.collection.as_bytes());
        hash.update((hold.id.len() as u64).to_le_bytes());
        hash.update(hold.id.as_bytes());
    }
    let digest: [u8; 32] = hash.finalize().into();
    state.model.replace_holds(holds);
    if !holds.is_empty() && digest != state.held_digest {
        state.hold_sequence = state.hold_sequence.wrapping_add(1);
    }
    state.held_digest = digest;
}

fn replace(state: &mut Snapshot, rows: &[AccessEntry], first: bool) {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    let mut count = 0;
    for row in rows
        .iter()
        .filter(|row| !row.acknowledged && !row.is_refused() && !row.delisted)
    {
        // Constant memory even when a list has more entries than the UI retains.
        hash.update((row.grant.grant.len() as u64).to_le_bytes());
        hash.update(row.grant.grant.as_bytes());
        hash.update(row.generation.to_le_bytes());
        count += 1;
    }
    let digest: [u8; 32] = hash.finalize().into();
    state.model.replace(rows);
    // Remind on reconnect, and recover notifications lost to broadcast lag even
    // when the new row is beyond the visible cap. Snapshot changes can only
    // produce generic access-changed copy, not grant authority or private text.
    if count > 0 && (first || digest != state.unreviewed_digest) {
        state.notice_sequence = state.notice_sequence.wrapping_add(1);
    }
    state.unreviewed_digest = digest;
}

async fn connected(
    profile: &Profile,
    store: &dyn SecretStore,
    output: &watch::Sender<Snapshot>,
    state: &mut Snapshot,
) -> Result<(), ClientError> {
    let mut client = connect(profile, store).await?;
    client
        .call(Method::STATUS_SUBSCRIBE, serde_json::json!({}))
        .await?;
    // Read the initial list on another connection: call() discards pushes, so
    // never use it on the live subscription after status.subscribe.
    replace(state, &entries(profile, store).await?, true);
    replace_held(state, &held(profile, store).await?);
    output.send_replace(state.clone());
    let mut refresh = tokio::time::interval(Duration::from_secs(5));
    refresh.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    refresh.tick().await;
    let mut last_held = state.model.holds().len() as u64;
    loop {
        tokio::select! {
            _ = output.closed() => return Ok(()),
            _ = refresh.tick() => {
                // Reconcile even when server-side broadcast lag dropped events.
                replace(state, &entries(profile, store).await?, false);
                replace_held(state, &held(profile, store).await?);
                output.send_replace(state.clone());
            }
            push = client.next_push() => {
                let Some((kind, payload)) = push? else { return Err(ClientError::NotRunning); };
                if kind == "access" {
                    let event: AccessEvent = serde_json::from_value(payload)
                        .map_err(|error| ClientError::Protocol(error.to_string()))?;
                    if state.model.notice(&event).is_some() {
                        state.notice_sequence = state.notice_sequence.wrapping_add(1);
                    }
                    replace(state, &entries(profile, store).await?, false);
                    output.send_replace(state.clone());
                } else if kind == "status" {
                    // Only a changed hold count reads the holds; the 5 s tick covers
                    // the rest, so a busy sync cannot make the tray poll.
                    let count = held_count(&payload);
                    if count != last_held {
                        last_held = count;
                        replace_held(state, &held(profile, store).await?);
                        output.send_replace(state.clone());
                    }
                }
            }
        }
    }
}

/// Keep a bounded presentation synchronized with only the explicitly selected
/// profile. Dropping all receivers stops this task, clears the model, and never
/// shuts down the daemon. Offline reconnect is bounded to one attempt per5s.
pub async fn subscribe(profile: Profile, output: watch::Sender<Snapshot>) {
    let store = crate::secrets::store_for(&profile.secret_namespace(), &profile.state_dir);
    subscribe_with(profile, output, store).await;
}

async fn subscribe_with(
    profile: Profile,
    output: watch::Sender<Snapshot>,
    store: Box<dyn SecretStore>,
) {
    let mut state = Snapshot::default();
    while !output.is_closed() {
        tokio::select! {
            _ = output.closed() => break,
            _ = connected(&profile, store.as_ref(), &output, &mut state) => {}
        }
        state.model.disconnect();
        output.send_replace(state.clone());
        tokio::select! {
            _ = output.closed() => break,
            _ = tokio::time::sleep(Duration::from_secs(5)) => {}
        }
    }
}

#[cfg(test)]
#[path = "session/ipc_tests.rs"]
mod ipc_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_delivery_is_bounded_and_disconnect_wins() {
        let (sender, receiver) = watch::channel(Snapshot::default());
        let mut state = Snapshot::default();
        for number in 0..10_000 {
            state.notice_sequence = number;
            state.model.replace(&[]);
            sender.send_replace(state.clone());
        }
        state.model.disconnect();
        sender.send_replace(state);
        assert_eq!(receiver.borrow().notice_sequence, 9_999);
        assert!(!receiver.borrow().model.connected());
    }

    #[test]
    fn periodic_snapshot_recovers_unreviewed_events_beyond_the_visible_cap() {
        let mut rows: Vec<AccessEntry> = (0..super::super::MAX_PREVIEWS)
            .map(|number| {
                serde_json::from_value(serde_json::json!({
                    "grant": format!("grant-{number}"), "collection": "collection", "app_id": "app",
                    "app_name": "Private name", "client_pk": "00", "capabilities": [],
                    "state": "active", "first_seen_ms": 0, "acknowledged": true
                }))
                .unwrap()
            })
            .collect();
        let mut state = Snapshot::default();
        replace(&mut state, &rows, true);
        assert_eq!(state.notice_sequence, 0);
        let mut new = rows[0].clone();
        new.grant.grant = "new-hidden-row".to_owned();
        new.acknowledged = false;
        rows.push(new);
        replace(&mut state, &rows, false);
        assert_eq!(state.model.rows().len(), super::super::MAX_PREVIEWS);
        assert_eq!(state.model.omitted(), 1);
        assert_eq!(state.notice_sequence, 1);
        replace(&mut state, &rows, false);
        assert_eq!(state.notice_sequence, 1);
        rows.last_mut().unwrap().generation += 1;
        replace(&mut state, &rows, false);
        assert_eq!(state.notice_sequence, 2);
    }

    #[test]
    fn a_new_protected_file_is_one_notice_and_resolution_clears_it() {
        use super::super::HoldCause;
        let hold = |id: &str| HoldPreview {
            collection: "c".to_owned(),
            id: id.to_owned(),
            path: "p.md".to_owned(),
            cause: HoldCause::Conflict,
        };
        let mut state = Snapshot::default();
        state.model.replace(&[]);
        replace_held(&mut state, &[]);
        assert_eq!(state.hold_sequence, 0);
        replace_held(&mut state, &[hold("a")]);
        assert_eq!(state.hold_sequence, 1);
        replace_held(&mut state, &[hold("a")]);
        assert_eq!(state.hold_sequence, 1);
        replace_held(&mut state, &[hold("a"), hold("b")]);
        assert_eq!(state.hold_sequence, 2);
        replace_held(&mut state, &[]);
        assert_eq!(state.hold_sequence, 2);
        assert!(state.model.holds().is_empty());
        assert_eq!(
            held_count(&serde_json::json!({"collections": [
                {"id": "x", "sync": {"holds": 2}}, {"id": "y"}, {"id": "z", "sync": {"holds": 1}}
            ]})),
            3
        );
    }

    #[tokio::test]
    async fn no_receivers_stops_without_connecting_to_an_installed_profile() {
        let (sender, receiver) = watch::channel(Snapshot::default());
        drop(receiver);
        let dir = std::env::current_dir()
            .unwrap()
            .join("nonexistent-companion-profile");
        let profile = Profile::isolated(&dir).unwrap();
        tokio::time::timeout(Duration::from_secs(1), subscribe(profile, sender))
            .await
            .unwrap();
        assert!(!dir.exists());
    }
}
