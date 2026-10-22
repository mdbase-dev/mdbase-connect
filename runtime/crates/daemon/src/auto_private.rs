//! Turning Private sync on for collections taken over from mdbase Connect.
//!
//! Apps reached a legacy local collection through the relay. After the takeover
//! the folder is served here as a local collection, which the relay cannot reach,
//! so the daemon turns Private (end-to-end) sync on for every taken-over
//! collection that is still local. Hosted collections are never affected: they
//! move through the hosted path and are joined, never taken over.
//!
//! Each attempt is the ordinary `sync.enable` (an adopt of the folder in place;
//! no byte is rewritten and an interrupted adopt resumes from its journal), so
//! the rules and refusals are the same as when the user turns sync on. A failed
//! attempt never undoes the takeover: it is recorded for status and `doctor` and
//! retried, after a backoff, on the next daemon start and after sign-in.
//! Files held at the takeover are never accepted here; the user reviews them, and
//! the attempt after the last one is resolved turns sync on.

use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

use crate::registry::{Entry, Origin, SyncMode};

/// First retry after a failed pass; doubles up to [`MAX_BACKOFF`].
pub const FIRST_BACKOFF: Duration = Duration::from_secs(60);
/// Longest wait between retries while the daemon runs.
pub const MAX_BACKOFF: Duration = Duration::from_secs(30 * 60);

/// Automatic Private sync state: one pass at a time, at most one retry timer,
/// and each pending collection's last failure (no content, no secrets).
#[derive(Debug, Default)]
pub struct State {
    /// Held for a pass.
    pub pass: tokio::sync::Mutex<()>,
    /// A retry timer is armed.
    pub retrying: std::sync::atomic::AtomicBool,
    /// Collection ID -> the last attempt's refusal reason.
    failures: std::sync::Mutex<BTreeMap<String, String>>,
}

impl State {
    /// The last attempt's refusal reason for `collection`, if it failed.
    pub fn failure(&self, collection: &str) -> Option<String> {
        self.failures
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(collection)
            .cloned()
    }

    fn record(&self, collection: &str, outcome: Option<String>) {
        let mut failures = self.failures.lock().unwrap_or_else(|p| p.into_inner());
        match outcome {
            Some(reason) => failures.insert(collection.to_owned(), reason),
            None => failures.remove(collection),
        };
    }

    /// Forget failures of collections that no longer wait.
    fn retain(&self, pending: &[String]) {
        self.failures
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .retain(|id, _| pending.contains(id));
    }
}

/// Whether `entry` is a taken-over collection still waiting for Private sync.
///
/// A taken-over collection that is still local qualifies, except one the user
/// paused: turning sync on would resume it. A paused one with an adopt journal
/// was stopped by an interrupted sync enable (which pauses durably before any
/// network step), as is a paused empty folder; both are resumed by finishing.
pub fn wants(entry: &Entry, journal: bool, folder_empty: impl FnOnce() -> bool) -> bool {
    entry.origin == Origin::MigratedLocal
        && entry.mode == SyncMode::Local
        && (!entry.paused || journal || folder_empty())
}

/// The candidates among `entries`, with `collections` the daemon's collection
/// state directory (where adopt journals live).
pub fn candidates<'a>(
    entries: impl IntoIterator<Item = &'a Entry>,
    collections: &Path,
) -> Vec<String> {
    entries
        .into_iter()
        .filter(|e| {
            wants(
                e,
                crate::adopt::Journal::path(collections, &e.id).exists(),
                || crate::server::local_bootstrap_folder_is_empty(&e.root).unwrap_or(false),
            )
        })
        .map(|e| e.id.clone())
        .collect()
}

/// What one pass did.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Pass {
    /// Collections now Private.
    pub enabled: Vec<String>,
    /// Collections still waiting, with the reason.
    pub failed: Vec<(String, String)>,
}

impl Pass {
    /// Whether a later pass has anything to do.
    pub fn pending(&self) -> bool {
        !self.failed.is_empty()
    }
}

/// Run one pass over `candidates`: `enable` turns sync on for one collection
/// (the daemon's ordinary `sync.enable`), returning the refusal reason on
/// failure. `stop` is checked between collections (shutdown, account change).
pub async fn run<F, Fut>(
    state: &State,
    candidates: Vec<String>,
    mut enable: F,
    stop: impl Fn() -> bool,
) -> Pass
where
    F: FnMut(String) -> Fut,
    Fut: std::future::Future<Output = Result<(), String>>,
{
    state.retain(&candidates);
    let mut pass = Pass::default();
    for id in candidates {
        if stop() {
            break;
        }
        match enable(id.clone()).await {
            Ok(()) => {
                state.record(&id, None);
                pass.enabled.push(id);
            }
            Err(reason) => {
                state.record(&id, Some(reason.clone()));
                pass.failed.push((id, reason));
            }
        }
    }
    pass
}

/// Record the same reason for every candidate without trying (signed out,
/// account not ready to sync yet).
pub fn defer(state: &State, candidates: &[String], reason: &str) {
    state.retain(candidates);
    for id in candidates {
        state.record(id, Some(reason.to_owned()));
    }
}

/// The wait before retry `attempt` (0-based).
pub fn backoff(attempt: u32) -> Duration {
    FIRST_BACKOFF
        .saturating_mul(1u32 << attempt.min(16))
        .min(MAX_BACKOFF)
}

/// Plain-language explanation of a refusal reason, for status and `doctor`.
pub fn explain(reason: &str) -> &'static str {
    match reason {
        "takeover_holds" | "holds_pending" => {
            "some files were held when this collection was taken over; review them to finish"
        }
        "old_connector_running" => "the old mdbase Connect is still running on this computer",
        "not_signed_in" | "account_changed" | "unauthenticated" => "sign in to mdbase to finish",
        "account_not_ready" => "your mdbase account has not finished upgrading yet",
        "sync_unreachable" | "network" => "mdbase could not reach the server",
        "not_serving" => "the collection is not open on this computer",
        "sync_refused" => "the server did not accept it yet",
        "sync_config_invalid" | "trust_missing" => {
            "this build of mdbase cannot sync; update mdbase"
        }
        _ => "the last attempt did not finish",
    }
}

#[cfg(test)]
#[path = "auto_private_tests.rs"]
mod tests;
