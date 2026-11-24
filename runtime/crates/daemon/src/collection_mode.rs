//! Daemon-driven native collection mode switches. The identity-bound request
//! journal is durable before reservation/consent; unknown HTTP outcomes retain
//! the same request, and one background loop drives every confirmed request to
//! completion (or to a phase that requires a person).
use super::{Daemon, cloud_refusal};
use crate::cloud::CloudError;
use crate::control::{CollectionState, ControlError, Notice};
use crate::runtime::{AccountKeyGuard, PrivateSwitchOp};
use mdbn_replica::crypto::proof::ModeProof;
use mdbn_wire::common::B16;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::time::Instant;

const FILE: &str = "mode-request.json";
const MAX_DEVICE_NAME_LOOKUPS: usize = 16;

#[cfg(not(test))]
const INITIAL_BACKOFF: Duration = Duration::from_secs(2);
#[cfg(test)]
const INITIAL_BACKOFF: Duration = Duration::from_millis(20);

#[cfg(not(test))]
const MAX_BACKOFF: Duration = Duration::from_secs(30);
#[cfg(test)]
const MAX_BACKOFF: Duration = Duration::from_millis(200);

#[cfg(not(test))]
const RETRY_AT_PAD: Duration = Duration::from_millis(250);
#[cfg(test)]
const RETRY_AT_PAD: Duration = Duration::from_millis(20);

const MAX_RATE_LIMIT_WAIT: Duration = Duration::from_secs(300);

#[cfg(test)]
#[path = "collection_mode_tests.rs"]
mod tests;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Request {
    collection: String,
    account: String,
    device: String,
    genesis: String,
    generation: String,
    request: String,
    target: String,
    cancel_requested: bool,
    native_started: bool,
}

impl Request {
    fn load(dir: &Path) -> Result<Option<Self>, ControlError> {
        let path = dir.join(FILE);
        let Some(bytes) = crate::fsutil::read_optional(&path)
            .map_err(|e| ControlError::internal(e.to_string()))?
        else {
            return Ok(None);
        };
        crate::fsutil::verify_owner_only(&path)
            .map_err(|e| ControlError::internal(e.to_string()))?;
        let invalid = || {
            ControlError::unavailable(
                "mode_journal_invalid",
                "Mode request journal is unreadable; retained",
            )
        };
        let value: Self = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
        if [
            &value.collection,
            &value.account,
            &value.device,
            &value.request,
        ]
        .iter()
        .any(|id| crate::attest::uuid_bytes(id).is_none_or(|id| id == [0; 16]))
            || [&value.genesis, &value.generation].iter().any(|hash| {
                hash.len() != 64
                    || !hash
                        .bytes()
                        .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            })
            || !matches!(value.target.as_str(), "private" | "cloud_copy")
        {
            return Err(invalid());
        }
        Ok(Some(value))
    }

    fn save(&self, dir: &Path) -> Result<(), ControlError> {
        crate::fsutil::write_atomic(
            &dir.join(FILE),
            &serde_json::to_vec(self).map_err(|e| ControlError::internal(e.to_string()))?,
        )
        .map_err(|e| ControlError::internal(e.to_string()))
    }

    fn clear(dir: &Path) -> Result<(), ControlError> {
        match std::fs::remove_file(dir.join(FILE)) {
            Ok(()) => {
                crate::fsutil::sync_dir(dir).map_err(|e| ControlError::internal(e.to_string()))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(ControlError::internal(e.to_string())),
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ChangeMode {
    collection: String,
    #[serde(default)]
    target_mode: Option<String>,
    #[serde(default)]
    cancel: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum DriverState {
    InProgress {
        phase: String,
        retry_at: Option<String>,
    },
    WaitingForDevices {
        devices: Vec<String>,
        device_names: BTreeMap<String, String>,
    },
    NeedsKeyedOwner,
    WaitingForDevice,
    Attention {
        code: String,
        message: String,
        wake_on_sign_in: bool,
        wake_on_resume: bool,
    },
}

struct DriverEntry {
    request: String,
    target: String,
    state: DriverState,
    attempts: u32,
    next_attempt: Option<Instant>,
}

/// RAM-only scheduler and status-notice state for the background mode-switch driver.
#[derive(Default)]
pub(crate) struct ModeDriver {
    wake: tokio::sync::Notify,
    entries: Mutex<BTreeMap<String, DriverEntry>>,
}

impl ModeDriver {
    pub(crate) fn wake(&self) {
        self.wake.notify_one();
    }

    pub(crate) fn clear(&self, id: &str) -> bool {
        self.entries
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(id)
            .is_some()
    }

    pub(crate) fn wake_collection(&self, id: &str) {
        let mut entries = self.entries.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(entry) = entries.get_mut(id)
            && matches!(
                entry.state,
                DriverState::Attention {
                    wake_on_resume: true,
                    ..
                }
            )
        {
            entry.attempts = 0;
            entry.next_attempt = Some(Instant::now());
        }
        drop(entries);
        self.wake();
    }

    pub(crate) fn wake_on_sign_in(&self) {
        let mut entries = self.entries.lock().unwrap_or_else(|p| p.into_inner());
        for entry in entries.values_mut() {
            if matches!(
                entry.state,
                DriverState::Attention {
                    wake_on_sign_in: true,
                    ..
                }
            ) {
                entry.attempts = 0;
                entry.next_attempt = Some(Instant::now());
            }
        }
        drop(entries);
        self.wake();
    }

    fn schedule_in_progress(
        &self,
        id: &str,
        request: &str,
        target: &str,
        phase: &str,
        retry_at: Option<String>,
        explicit_delay: Option<Duration>,
    ) {
        let mut entries = self.entries.lock().unwrap_or_else(|p| p.into_inner());
        let same_phase = entries.get(id).is_some_and(|e| {
            e.request == request
                && matches!(&e.state, DriverState::InProgress { phase: p, .. } if p == phase)
        });
        let attempts = if explicit_delay.is_some() {
            0
        } else if same_phase {
            entries.get(id).map_or(1, |e| e.attempts.saturating_add(1))
        } else {
            1
        };
        let delay = explicit_delay.unwrap_or_else(|| backoff_delay(attempts));
        entries.insert(
            id.to_string(),
            DriverEntry {
                request: request.to_string(),
                target: target.to_string(),
                state: DriverState::InProgress {
                    phase: phase.to_string(),
                    retry_at,
                },
                attempts,
                next_attempt: Some(Instant::now() + delay),
            },
        );
        drop(entries);
        self.wake();
    }

    fn schedule_retry_error(
        &self,
        id: &str,
        request: &str,
        target: &str,
        fallback_phase: &str,
        explicit_delay: Option<Duration>,
    ) {
        let mut entries = self.entries.lock().unwrap_or_else(|p| p.into_inner());
        let prev = entries.get(id).filter(|e| e.request == request);
        let (phase, retry_at, attempts) = match prev {
            Some(DriverEntry {
                state: DriverState::InProgress { phase, retry_at },
                attempts,
                ..
            }) => (phase.clone(), retry_at.clone(), attempts.saturating_add(1)),
            _ => (fallback_phase.to_string(), None, 1),
        };
        let delay = explicit_delay.unwrap_or_else(|| backoff_delay(attempts));
        entries.insert(
            id.to_string(),
            DriverEntry {
                request: request.to_string(),
                target: target.to_string(),
                state: DriverState::InProgress { phase, retry_at },
                attempts,
                next_attempt: Some(Instant::now() + delay),
            },
        );
        drop(entries);
        self.wake();
    }

    fn stop(&self, id: &str, request: &str, target: &str, state: DriverState) {
        let mut entries = self.entries.lock().unwrap_or_else(|p| p.into_inner());
        entries.insert(
            id.to_string(),
            DriverEntry {
                request: request.to_string(),
                target: target.to_string(),
                state,
                attempts: 0,
                next_attempt: None,
            },
        );
    }

    /// Collection-level notices surfaced in `status` and `collection.list`.
    pub(crate) fn notices(&self, id: &str) -> Vec<Notice> {
        let entries = self.entries.lock().unwrap_or_else(|p| p.into_inner());
        let Some(entry) = entries.get(id) else {
            return Vec::new();
        };
        let target = mode_label(&entry.target);
        let notice = match &entry.state {
            DriverState::InProgress { phase, retry_at } => {
                let message = match phase.as_str() {
                    "waiting_for_token_expiry" => {
                        let wait = retry_at.as_deref().and_then(|raw| {
                            format_wait_phrase(raw, crate::fsutil::now_ms() as u64)
                        });
                        match wait {
                            Some(wait) => format!(
                                "Switching to {target}: waiting {wait} for older app connections to expire."
                            ),
                            None => format!(
                                "Switching to {target}: waiting for older app connections to expire."
                            ),
                        }
                    }
                    "publishing_policy" => {
                        format!("Switching to {target}: publishing the mode change.")
                    }
                    _ => format!("Switching to {target} in the background."),
                };
                Notice {
                    path: None,
                    code: "mode_switch_in_progress".into(),
                    message,
                }
            }
            DriverState::WaitingForDevices {
                devices,
                device_names,
            } => {
                let list = devices
                    .iter()
                    .map(|dev| match device_names.get(dev) {
                        Some(name) => format!("{name} ({})", short_device_id(dev)),
                        None => short_device_id(dev).to_string(),
                    })
                    .collect::<Vec<_>>()
                    .join(", ");
                Notice {
                    path: None,
                    code: "mode_switch_devices_need_update".into(),
                    message: format!(
                        "Switch to {target} is paused: update or remove older devices ({list}), then try again."
                    ),
                }
            }
            DriverState::NeedsKeyedOwner => Notice {
                path: None,
                code: "mode_switch_keyed_owner_required".into(),
                message: format!(
                    "Switch to {target} needs an owner device holding this collection's trusted key."
                ),
            },
            DriverState::WaitingForDevice => Notice {
                path: None,
                code: "mode_switch_waiting_for_device".into(),
                message: format!("Switch to {target} is waiting for an owner device to continue."),
            },
            DriverState::Attention { code, message, .. } => Notice {
                path: None,
                code: code.clone(),
                message: message.clone(),
            },
        };
        vec![notice]
    }
}

/// Plain-language name for a wire mode string.
pub(crate) fn mode_label(mode: &str) -> &str {
    match mode {
        "private" => "Private",
        "cloud_copy" => "Cloud copy",
        other => other,
    }
}

/// Short human-readable identifier for a device UUID when no name is known.
pub(crate) fn short_device_id(id: &str) -> &str {
    id.split('-')
        .next()
        .filter(|prefix| !prefix.is_empty())
        .unwrap_or(id)
}

/// Parse an ISO-8601 / RFC 3339 timestamp (such as `retry_at`) into Unix milliseconds.
pub(crate) fn parse_rfc3339_ms(raw: &str) -> Option<u64> {
    let dt =
        time::OffsetDateTime::parse(raw, &time::format_description::well_known::Rfc3339).ok()?;
    let ms = dt.unix_timestamp_nanos() / 1_000_000;
    u64::try_from(ms).ok()
}

/// Plain relative wait phrase for a future RFC 3339 timestamp (`None` if already due).
pub(crate) fn format_wait_phrase(retry_at: &str, now_ms: u64) -> Option<String> {
    let target_ms = parse_rfc3339_ms(retry_at)?;
    if target_ms <= now_ms {
        return None;
    }
    let secs = (target_ms - now_ms).div_ceil(1000);
    if secs >= 90 {
        Some(format!("about {} min", secs.div_ceil(60)))
    } else if secs >= 45 {
        Some("about 1 min".into())
    } else {
        Some(format!("about {secs} s"))
    }
}

fn backoff_delay(attempts: u32) -> Duration {
    let shift = attempts.saturating_sub(1).min(4);
    let ms = INITIAL_BACKOFF.as_millis().saturating_mul(1u128 << shift);
    Duration::from_millis(ms.min(MAX_BACKOFF.as_millis()) as u64)
}

fn rate_limit_delay(retry_after: Option<u64>, attempts: u32) -> Duration {
    match retry_after {
        #[cfg(test)]
        Some(0) => INITIAL_BACKOFF,
        Some(secs) => Duration::from_secs(secs.clamp(1, MAX_RATE_LIMIT_WAIT.as_secs())),
        None => backoff_delay(attempts),
    }
}

/// Delay until `retry_at` if it is still in the future; `None` if already due
/// (e.g. local clock ahead of server clock, where the caller falls back to backoff).
fn retry_at_delay(retry_at: Option<&str>, now_ms: u64) -> Option<Duration> {
    let target_ms = retry_at.and_then(parse_rfc3339_ms)?;
    if target_ms > now_ms {
        Some(Duration::from_millis(target_ms - now_ms) + RETRY_AT_PAD)
    } else {
        None
    }
}

/// Whether a refusal from `POST /v1/next/collections/:id/mode/:requestId/{prepare,finish}`
/// is definitively terminal BEFORE policy publication and may be auto-cancelled.
///
/// Enumerated directly from:
/// - `services/server/src/features/next/collection-mode-execution.ts`
/// - `services/server/src/features/next/collection-mode-capability.ts`
/// - `services/server/src/features/next/collection-mode-routes.ts`
/// - `services/server/src/features/next/bootstrap-common.ts`
/// - `services/server/src/features/next/policy-outbox.ts`
///
/// Explicitly EXCLUDES:
/// - anything during `/finish` (`finish == true`: policy is already published)
/// - `CloudError::RateLimited` (HTTP 429) — retryable
/// - `(409, "mode_source_changed")` (`policy-outbox.ts:595`) — retryable with fresh preflight
/// - `(409, "mode_devices_need_update")` (`collection-mode-capability.ts:32`) — person-needed
/// - `(409, "keyed_owner_required")` (`collection-mode-execution.ts:179`, `collection-mode-capability.ts:28`) — person-needed
/// - `(409, "mode_abandoned")` (`collection-mode-execution.ts:33`) — post-publication terminal
/// - unknown/future 4xx codes
pub(crate) fn is_terminal_pre_publication_refusal(finish: bool, error: &CloudError) -> bool {
    if finish {
        return false;
    }
    match error {
        CloudError::Server(400, code) => code == "invalid_request",
        CloudError::Server(404, code) => code == "not_found",
        CloudError::Server(409, code) => matches!(
            code.as_str(),
            "mode_cancelled" | "mode_changed" | "not_current" | "not_member" | "device_revoked"
        ),
        _ => false,
    }
}

impl Daemon {
    /// Background driver: advances every confirmed, retained `mode-request.json`
    /// on creation, daemon startup, `retry_at`, and bounded backoff, stopping on
    /// terminal or person-needed phases.
    pub(super) async fn collection_mode_drive(self: Arc<Self>) {
        let mut stop = self.shutdown.subscribe();
        let mut ready = self.readiness.subscribe();
        tokio::select! {
            _ = stop.wait_for(|s| *s) => return,
            _ = ready.wait_for(|r| r.ready) => {}
        }
        loop {
            let next_sleep = tokio::select! {
                _ = stop.wait_for(|s| *s) => break,
                delay = self.collection_mode_pass() => delay,
            };
            match next_sleep {
                Some(delay) => {
                    tokio::select! {
                        _ = stop.wait_for(|s| *s) => break,
                        _ = self.mode_driver.wake.notified() => {}
                        _ = tokio::time::sleep(delay) => {}
                    }
                }
                None => {
                    tokio::select! {
                        _ = stop.wait_for(|s| *s) => break,
                        _ = self.mode_driver.wake.notified() => {}
                    }
                }
            }
        }
    }

    async fn collection_mode_pass(&self) -> Option<Duration> {
        let ids: Vec<String> = {
            let inner = self.inner.lock().await;
            inner
                .registry
                .collections
                .iter()
                .map(|e| e.id.clone())
                .collect()
        };
        // Prune stale driver state for collections no longer registered.
        {
            let mut entries = self
                .mode_driver
                .entries
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            let before = entries.len();
            entries.retain(|id, _| ids.iter().any(|registered| registered == id));
            if entries.len() != before {
                drop(entries);
                self.bump();
            }
        }
        let mut earliest: Option<Instant> = None;
        for id in ids {
            let dir = self.profile.collection_dir(&id);
            let op = match Request::load(&dir) {
                Ok(Some(op)) => op,
                Ok(None) => {
                    if self.mode_driver.clear(&id) {
                        self.bump();
                    }
                    continue;
                }
                Err(error) => {
                    self.mode_driver.stop(
                        &id,
                        "",
                        "",
                        DriverState::Attention {
                            code: "mode_switch_journal_invalid".into(),
                            message: error.message,
                            wake_on_sign_in: false,
                            wake_on_resume: false,
                        },
                    );
                    self.bump();
                    continue;
                }
            };
            let now = Instant::now();
            let scheduled = {
                let entries = self
                    .mode_driver
                    .entries
                    .lock()
                    .unwrap_or_else(|p| p.into_inner());
                entries
                    .get(&id)
                    .filter(|e| e.request == op.request)
                    .map(|e| e.next_attempt)
            };
            match scheduled {
                Some(None) if !op.cancel_requested => {
                    // Stopped on a person-needed or terminal attention state.
                    continue;
                }
                Some(Some(at)) if at > now => {
                    earliest = Some(earliest.map_or(at, |cur| cur.min(at)));
                    continue;
                }
                _ => {}
            }
            self.drive_one_collection(&id).await;
            let next = {
                let entries = self
                    .mode_driver
                    .entries
                    .lock()
                    .unwrap_or_else(|p| p.into_inner());
                entries.get(&id).and_then(|e| e.next_attempt)
            };
            if let Some(at) = next {
                earliest = Some(earliest.map_or(at, |cur| cur.min(at)));
            }
        }
        earliest.map(|at| at.saturating_duration_since(Instant::now()))
    }

    async fn drive_one_collection(&self, id: &str) {
        let Some(col) = crate::attest::uuid_bytes(id) else {
            return;
        };
        let _gate = self.account_gate.lock().await;
        let dir = self.profile.collection_dir(id);
        let op = match Request::load(&dir) {
            Ok(Some(op)) => op,
            Ok(None) => {
                if self.mode_driver.clear(id) {
                    self.bump();
                }
                return;
            }
            Err(error) => {
                self.mode_driver.stop(
                    id,
                    "",
                    "",
                    DriverState::Attention {
                        code: "mode_switch_journal_invalid".into(),
                        message: error.message,
                        wake_on_sign_in: false,
                        wake_on_resume: false,
                    },
                );
                self.bump();
                return;
            }
        };
        let (ctx, _) = match self.sync_parts() {
            Ok(parts) => parts,
            Err(_) => {
                self.mode_driver.stop(
                    id,
                    &op.request,
                    &op.target,
                    DriverState::Attention {
                        code: "mode_switch_sign_in_required".into(),
                        message: format!(
                            "Switch to {} is paused until this computer is signed in.",
                            mode_label(&op.target)
                        ),
                        wake_on_sign_in: true,
                        wake_on_resume: false,
                    },
                );
                self.bump();
                return;
            }
        };
        let Ok(source) = self.authority.source(B16(col)) else {
            self.mode_driver.stop(
                id,
                &op.request,
                &op.target,
                DriverState::Attention {
                    code: "mode_switch_sign_in_required".into(),
                    message: format!(
                        "Switch to {} is paused until this computer is signed in.",
                        mode_label(&op.target)
                    ),
                    wake_on_sign_in: true,
                    wake_on_resume: false,
                },
            );
            self.bump();
            return;
        };
        if source.current_synced().is_err() {
            let state = {
                let inner = self.inner.lock().await;
                inner
                    .hosts
                    .iter()
                    .find(|h| h.entry().id == id)
                    .map(|h| h.state())
            };
            if state == Some(CollectionState::Paused) {
                self.mode_driver.stop(
                    id,
                    &op.request,
                    &op.target,
                    DriverState::Attention {
                        code: "mode_switch_paused".into(),
                        message: format!(
                            "Switch to {} is paused while this collection is paused. Resume the collection to continue.",
                            mode_label(&op.target)
                        ),
                        wake_on_sign_in: false,
                        wake_on_resume: true,
                    },
                );
            } else {
                self.mode_driver.stop(
                    id,
                    &op.request,
                    &op.target,
                    DriverState::Attention {
                        code: "mode_switch_sign_in_required".into(),
                        message: format!(
                            "Switch to {} is paused until this computer is signed in.",
                            mode_label(&op.target)
                        ),
                        wake_on_sign_in: true,
                        wake_on_resume: false,
                    },
                );
            }
            self.bump();
            return;
        }
        let host_info = {
            let inner = self.inner.lock().await;
            inner
                .hosts
                .iter()
                .find(|h| h.entry().id == id)
                .map(|h| (h.entry().clone(), h.state(), h.runtime()))
        };
        let Some((entry, state, runtime)) = host_info else {
            self.mode_driver.clear(id);
            return;
        };
        let Some(runtime) = runtime else {
            match state {
                CollectionState::Opening | CollectionState::Unavailable => {
                    self.mode_driver.schedule_retry_error(
                        id,
                        &op.request,
                        &op.target,
                        "finishing",
                        None,
                    );
                }
                CollectionState::Paused => {
                    self.mode_driver.stop(
                        id,
                        &op.request,
                        &op.target,
                        DriverState::Attention {
                            code: "mode_switch_paused".into(),
                            message: format!(
                                "Switch to {} is paused while this collection is paused. Resume the collection to continue.",
                                mode_label(&op.target)
                            ),
                            wake_on_sign_in: false,
                            wake_on_resume: true,
                        },
                    );
                    self.bump();
                }
                _ => {
                    self.mode_driver.stop(
                        id,
                        &op.request,
                        &op.target,
                        DriverState::Attention {
                            code: "mode_switch_paused".into(),
                            message: format!(
                                "Switch to {} is paused because this collection is not serving.",
                                mode_label(&op.target)
                            ),
                            wake_on_sign_in: false,
                            wake_on_resume: true,
                        },
                    );
                    self.bump();
                }
            }
            return;
        };
        let cfg = match crate::sync::SyncConfig::load(&dir.join(crate::sync::FILE)) {
            Ok(Some(cfg)) => cfg,
            _ => {
                self.mode_driver.stop(
                    id,
                    &op.request,
                    &op.target,
                    DriverState::Attention {
                        code: "mode_switch_attention".into(),
                        message: "Sync link missing; mode switch paused.".into(),
                        wake_on_sign_in: false,
                        wake_on_resume: true,
                    },
                );
                self.bump();
                return;
            }
        };
        if !identity_matches(&op, &entry, &cfg) {
            self.mode_driver.stop(
                id,
                &op.request,
                &op.target,
                DriverState::Attention {
                    code: "mode_switch_journal_invalid".into(),
                    message: "Mode request identity differs; retained.".into(),
                    wake_on_sign_in: false,
                    wake_on_resume: false,
                },
            );
            self.bump();
            return;
        }
        let current = || {
            source
                .current_synced()
                .map(|_| ())
                .map_err(|_| "account_changed".to_string())
        };
        let fenced = source.clone();
        let guard: AccountKeyGuard = Arc::new(move || fenced.current_synced().is_ok());
        if let Err(error) = self
            .advance_mode_step(&ctx, col, &entry, &runtime, &dir, &current, guard, op)
            .await
        {
            tracing::debug!(
                collection = %id,
                reason = ?error.reason,
                message = %error.message,
                "mode switch driver step did not complete yet"
            );
        }
    }

    pub(super) async fn collection_mode_status(&self, id: &str) -> Result<Value, ControlError> {
        self.reconcile_private_choices().await;
        let col = crate::attest::uuid_bytes(id)
            .ok_or_else(|| ControlError::invalid("collection", "collection UUID required"))?;
        let (ctx, _) = self.sync_parts()?;
        let source = self.authority.source(B16(col)).map_err(|_| {
            ControlError::unavailable("not_ready", "current synced collection required")
        })?;
        let current = || {
            source
                .current_synced()
                .map(|_| ())
                .map_err(|_| "account_changed".to_string())
        };
        if let Some(op) = Request::load(&self.profile.collection_dir(id))? {
            let terminal = ctx
                .cloud
                .collection_mode_request_status(id, &op.request, &current)
                .await
                .ok();
            let terminal_phase = terminal
                .as_ref()
                .and_then(|v| v.get("phase"))
                .and_then(Value::as_str);
            let abandoned = terminal_phase == Some("abandoned");
            let cancelled =
                !abandoned && (op.cancel_requested || terminal_phase == Some("cancelled"));
            if abandoned || (!cancelled && terminal_phase == Some("complete")) {
                let _gate = self.account_gate.lock().await;
                let inner = self.inner.lock().await;
                if let Some(entry) = inner.registry.get(id) {
                    let cfg = crate::sync::SyncConfig::load(
                        &self.profile.collection_dir(id).join(crate::sync::FILE),
                    )
                    .map_err(|e| ControlError::internal(e.0))?;
                    if Request::load(&self.profile.collection_dir(id))?
                        .is_some_and(|current| current.request == op.request)
                        && current().is_ok()
                        && op.collection == id
                        && entry.owner_account.as_deref() == Some(&op.account)
                        && entry.device.as_deref() == Some(&op.device)
                        && cfg.is_some_and(|c| c.genesis_hash == op.genesis)
                    {
                        Request::clear(&self.profile.collection_dir(id))?;
                        self.mode_driver.clear(id);
                    }
                }
            }
            if cancelled {
                self.change_collection_mode(ChangeMode {
                    collection: id.into(),
                    target_mode: Some(op.target),
                    cancel: true,
                })
                .await?;
            }
        }
        // The server's answer, as-is: this computer's registration may lag it.
        let result = ctx
            .cloud
            .collection_mode_status(id, &current)
            .await
            .map_err(cloud_refusal)?;
        current().map_err(|_| ControlError::unavailable("account_changed", "account changed"))?;
        Ok(result)
    }

    pub(super) async fn change_collection_mode(
        &self,
        p: ChangeMode,
    ) -> Result<Value, ControlError> {
        if let Some(target) = p.target_mode.as_deref() {
            if !matches!(target, "private" | "cloud_copy") {
                return Err(ControlError::invalid(
                    "target_mode",
                    "choose private or cloud_copy",
                ));
            }
        } else if !p.cancel {
            return Err(ControlError::invalid(
                "target_mode",
                "choose private or cloud_copy",
            ));
        }
        let col = crate::attest::uuid_bytes(&p.collection)
            .ok_or_else(|| ControlError::invalid("collection", "collection UUID required"))?;
        self.reconcile_private_choices().await;
        let _gate = self.account_gate.lock().await;
        let (ctx, _) = self.sync_parts()?;
        let source = self.authority.source(B16(col)).map_err(|_| {
            ControlError::unavailable("not_ready", "current synced collection required")
        })?;
        let current = || {
            source
                .current_synced()
                .map(|_| ())
                .map_err(|_| "account_changed".to_string())
        };
        current().map_err(|_| ControlError::unavailable("account_changed", "account changed"))?;
        let fenced = source.clone();
        let guard: AccountKeyGuard = Arc::new(move || fenced.current_synced().is_ok());
        let (entry, runtime) = {
            let inner = self.inner.lock().await;
            let host = inner
                .hosts
                .iter()
                .find(|h| h.entry().id == p.collection)
                .ok_or_else(|| {
                    ControlError::unavailable("not_registered", "collection not registered")
                })?;
            (
                host.entry().clone(),
                host.runtime().ok_or_else(|| {
                    ControlError::unavailable("not_serving", "resume this collection first")
                })?,
            )
        };
        let dir = self.profile.collection_dir(&p.collection);
        let cfg = crate::sync::SyncConfig::load(&dir.join(crate::sync::FILE))
            .map_err(|e| ControlError::internal(e.0))?
            .ok_or_else(|| ControlError::unavailable("not_ready", "sync link missing"))?;
        let mut operation = Request::load(&dir)?;
        if let Some(op) = &operation {
            if !identity_matches(op, &entry, &cfg) {
                return Err(ControlError::unavailable(
                    "mode_journal_invalid",
                    "Mode request identity differs; retained",
                ));
            }
            if let Some(requested_target) = p.target_mode.as_deref()
                && op.target != requested_target
            {
                return Err(ControlError::invalid(
                    "mode_change_in_progress",
                    format!(
                        "a switch to {} is already in progress; finish or cancel it first",
                        mode_label(&op.target)
                    ),
                ));
            }
        }
        if operation.is_none() {
            let status = ctx
                .cloud
                .collection_mode_status(&p.collection, &current)
                .await
                .map_err(cloud_refusal)?;
            let active = status.get("change").filter(|v| !v.is_null());
            if p.cancel {
                if active
                    .is_some_and(|v| v.get("phase").and_then(Value::as_str) == Some("abandoned"))
                {
                    let target = active
                        .and_then(|v| v.get("target_mode"))
                        .and_then(Value::as_str)
                        .or(p.target_mode.as_deref())
                        .unwrap_or("private");
                    return Ok(json!({"phase": "abandoned", "target_mode": target}));
                }
                let Some(active) = active else {
                    let mut reply = json!({"phase": "cancelled"});
                    if let Some(target) = p.target_mode.as_deref() {
                        reply["target_mode"] = json!(target);
                    }
                    return Ok(reply);
                };
                let active_target = active
                    .get("target_mode")
                    .and_then(Value::as_str)
                    .filter(|t| matches!(*t, "private" | "cloud_copy"))
                    .ok_or_else(|| ControlError::internal("active switch target missing"))?;
                if let Some(requested_target) = p.target_mode.as_deref()
                    && requested_target != active_target
                {
                    return Err(ControlError::invalid(
                        "mode_change_in_progress",
                        format!(
                            "a switch to {} is in progress, not {}",
                            mode_label(active_target),
                            mode_label(requested_target)
                        ),
                    ));
                }
                let request = active
                    .get("request_id")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .ok_or_else(|| ControlError::internal("active switch request missing"))?;
                let op = self
                    .new_request(
                        &entry,
                        &runtime,
                        guard.clone(),
                        cfg.genesis_hash,
                        request,
                        active_target.to_string(),
                        true,
                    )
                    .await?;
                op.save(&dir)?;
                operation = Some(op);
            } else {
                let target_mode = p.target_mode.as_deref().expect("validated above");
                let private = target_mode == "private";
                // An abandoned Private switch is reported until an excluding rekey
                // follows it. Native policy runs that rekey; leaving e2e first would
                // consume every switch-set device's exception, so neither direction starts.
                if active
                    .is_some_and(|v| v.get("phase").and_then(Value::as_str) == Some("abandoned"))
                {
                    return Ok(json!({"phase": "abandoned", "target_mode": target_mode}));
                }
                if active.is_some_and(|v| {
                    v.get("target_mode").and_then(Value::as_str) != Some(target_mode)
                }) {
                    let in_flight = active
                        .and_then(|v| v.get("target_mode"))
                        .and_then(Value::as_str)
                        .map(mode_label);
                    let message = match in_flight {
                        Some(mode) => format!(
                            "a switch to {mode} is already in progress; finish or cancel it first"
                        ),
                        None => "finish the current switch first".into(),
                    };
                    return Err(ControlError::invalid("mode_change_in_progress", message));
                }
                if active.is_none()
                    && status.get("current_mode").and_then(Value::as_str) == Some(target_mode)
                {
                    let selected = if private {
                        runtime
                            .mode_source(true, true, guard.clone())
                            .await
                            .is_some()
                    } else {
                        runtime
                            .private_switch(PrivateSwitchOp::CloudSelected, guard.clone())
                            .await
                            .is_some_and(|v| matches!(v, Ok(Some(_))))
                    };
                    return Ok(json!({
                        "phase": if selected { "complete" } else { "waiting_for_device" },
                        "target_mode": target_mode
                    }));
                }
                // Ask only for a switch that can run: without the server's executor
                // the confirmed switch could only be rolled back.
                if status.get("execution_available") != Some(&Value::Bool(true)) {
                    return Err(ControlError::unavailable(
                        "mode_switch_unavailable",
                        "Switching this collection isn't available yet.",
                    ));
                }
                self.confirm(&crate::confirm::Prompt::CollectionMode {
                    collection: entry.name.clone(),
                    private,
                })
                .await?;
                let request = active
                    .and_then(|v| v.get("request_id"))
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .unwrap_or(
                        crate::secrets::new_uuid()
                            .map_err(|e| ControlError::internal(e.to_string()))?,
                    );
                let op = self
                    .new_request(
                        &entry,
                        &runtime,
                        guard.clone(),
                        cfg.genesis_hash,
                        request,
                        target_mode.to_string(),
                        false,
                    )
                    .await?;
                op.save(&dir)?;
                operation = Some(op);
            }
        }
        let mut op = operation.expect("created above");
        if p.cancel && !op.cancel_requested {
            op.cancel_requested = true;
            op.save(&dir)?;
        }
        self.advance_mode_step(&ctx, col, &entry, &runtime, &dir, &current, guard, op)
            .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn new_request(
        &self,
        entry: &crate::registry::Entry,
        runtime: &crate::runtime::Runtime,
        guard: AccountKeyGuard,
        genesis: String,
        request: String,
        target: String,
        cancel_requested: bool,
    ) -> Result<Request, ControlError> {
        Ok(Request {
            collection: entry.id.clone(),
            account: entry
                .owner_account
                .clone()
                .ok_or_else(|| ControlError::unavailable("not_ready", "account missing"))?,
            device: entry
                .device
                .clone()
                .ok_or_else(|| ControlError::unavailable("not_ready", "device missing"))?,
            genesis,
            generation: crate::secrets::hex(
                &runtime
                    .mode_generation(guard)
                    .await
                    .ok_or_else(|| {
                        ControlError::unavailable(
                            "not_ready",
                            "Native privacy state is unavailable",
                        )
                    })?
                    .0,
            ),
            request,
            target,
            cancel_requested,
            native_started: false,
        })
    }

    #[allow(clippy::too_many_arguments)]
    async fn advance_mode_step(
        &self,
        ctx: &crate::collections::SyncCtx,
        col: [u8; 16],
        entry: &crate::registry::Entry,
        runtime: &crate::runtime::Runtime,
        dir: &Path,
        current: &(dyn Fn() -> Result<(), String> + Send + Sync),
        guard: AccountKeyGuard,
        mut op: Request,
    ) -> Result<Value, ControlError> {
        let private = op.target == "private";
        // Reserve idempotently before native mutation (and before cancel so a
        // cancellation tombstone exists even if an original POST reply was lost).
        // Once native_started is set, read the request status instead of
        // re-posting intent so driver retries never burn POST /mode's 10/min limit.
        let reserved = if !op.native_started || op.cancel_requested {
            match ctx
                .cloud
                .collection_mode_intent(&entry.id, &op.request, private, current)
                .await
            {
                Ok(value) => value,
                Err(error) => {
                    // Intent alone cannot publish. A definite 4xx refusal before any
                    // native mutation must not strand a new local request.
                    if !op.native_started
                        && matches!(&error, CloudError::Server(status, _) if (400..500).contains(status))
                    {
                        Request::clear(dir)?;
                        self.mode_driver.clear(&entry.id);
                        self.bump();
                        if op.cancel_requested {
                            return Ok(json!({
                                "phase": "cancelled",
                                "request_id": op.request,
                                "target_mode": op.target,
                            }));
                        }
                        if matches!(&error, CloudError::Server(409, code) if code == "mode_abandoned")
                        {
                            return Ok(json!({
                                "phase": "abandoned",
                                "request_id": op.request,
                                "target_mode": op.target,
                            }));
                        }
                    } else {
                        self.schedule_driver_for_error(
                            &entry.id,
                            &op,
                            "waiting_for_device",
                            &error,
                        );
                    }
                    return Err(cloud_refusal(error));
                }
            }
        } else {
            match ctx
                .cloud
                .collection_mode_request_status(&entry.id, &op.request, current)
                .await
            {
                Ok(value) => value,
                Err(error) => {
                    self.schedule_driver_for_error(&entry.id, &op, "finishing", &error);
                    return Err(cloud_refusal(error));
                }
            }
        };

        if reserved.get("phase").and_then(Value::as_str) == Some("abandoned") {
            Request::clear(dir)?;
            self.mode_driver.clear(&entry.id);
            self.bump();
            return Ok(json!({
                "phase": "abandoned",
                "request_id": op.request,
                "target_mode": op.target,
            }));
        }

        if reserved.get("phase").and_then(Value::as_str) == Some("complete") {
            Request::clear(dir)?;
            self.mode_driver.clear(&entry.id);
            self.reconcile_private_choices_locked().await;
            if private {
                self.account_keys.wake();
            }
            self.bump();
            if op.cancel_requested {
                return Err(cloud_refusal(CloudError::Server(
                    409,
                    "mode_already_published".into(),
                )));
            }
            return Ok(json!({
                "phase": "complete",
                "request_id": op.request,
                "target_mode": op.target,
            }));
        }

        if op.cancel_requested || reserved.get("phase").and_then(Value::as_str) == Some("cancelled")
        {
            op.cancel_requested = true;
            op.save(dir)?;
            if let Err(error) = ctx
                .cloud
                .collection_mode_cancel(&entry.id, &op.request, current)
                .await
            {
                if matches!(&error, CloudError::Server(409, code) if code == "mode_already_published")
                {
                    op.cancel_requested = false;
                    op.save(dir)?;
                    self.mode_driver.schedule_in_progress(
                        &entry.id,
                        &op.request,
                        &op.target,
                        "finishing",
                        None,
                        Some(Duration::ZERO),
                    );
                } else {
                    self.schedule_driver_for_error(&entry.id, &op, "waiting_for_device", &error);
                }
                return Err(cloud_refusal(error));
            }
            self.cancel_local_switch(&entry.id, runtime, private, guard.clone())
                .await?;
            current()
                .map_err(|_| ControlError::unavailable("account_changed", "account changed"))?;
            Request::clear(dir)?;
            self.mode_driver.clear(&entry.id);
            self.bump();
            return Ok(json!({
                "phase": "cancelled",
                "request_id": op.request,
                "target_mode": op.target,
            }));
        }

        let receipt = runtime.mode_source(private, true, guard.clone()).await;
        let intent = runtime.mode_source(private, false, guard.clone()).await;
        if receipt.is_none() && intent.is_none() {
            op.native_started = true;
            op.save(dir)?;
            if private {
                let requested = runtime
                    .private_switch(PrivateSwitchOp::Request, guard.clone())
                    .await
                    .ok_or_else(|| ControlError::unavailable("not_ready", "collection stopped"))?;
                if requested.is_err() {
                    self.mode_driver.stop(
                        &entry.id,
                        &op.request,
                        &op.target,
                        DriverState::NeedsKeyedOwner,
                    );
                    self.bump();
                    return Err(ControlError::unavailable(
                        "keyed_owner_required",
                        "use an owner device holding this collection’s trusted key",
                    ));
                }
            } else if let Err(error) = self
                .choose_cloud_copy_locally(
                    &entry.id,
                    runtime,
                    guard.clone(),
                    mdbn_wire::common::B32(
                        crate::secrets::hex_decode(&op.generation)
                            .ok()
                            .and_then(|bytes| bytes.try_into().ok())
                            .ok_or_else(|| {
                                ControlError::unavailable(
                                    "mode_journal_invalid",
                                    "Privacy generation is invalid",
                                )
                            })?,
                    ),
                )
                .await
            {
                if error.reason.as_deref() == Some("keyed_owner_required") {
                    self.mode_driver.stop(
                        &entry.id,
                        &op.request,
                        &op.target,
                        DriverState::NeedsKeyedOwner,
                    );
                    self.bump();
                } else {
                    self.mode_driver.schedule_retry_error(
                        &entry.id,
                        &op.request,
                        &op.target,
                        "waiting_for_device",
                        None,
                    );
                }
                return Err(error);
            }
        } else if !op.native_started {
            op.native_started = true;
            op.save(dir)?;
        }

        let server_phase = reserved.get("phase").and_then(Value::as_str);
        if server_phase == Some("waiting_for_token_expiry") {
            let retry_at = reserved
                .get("retry_at")
                .and_then(Value::as_str)
                .map(str::to_owned);
            if let Some(delay) = retry_at_delay(retry_at.as_deref(), crate::fsutil::now_ms() as u64)
            {
                self.mode_driver.schedule_in_progress(
                    &entry.id,
                    &op.request,
                    &op.target,
                    "waiting_for_token_expiry",
                    retry_at,
                    Some(delay),
                );
                self.bump();
                return Ok(reserved);
            }
        }

        let receipt = runtime.mode_source(private, true, guard.clone()).await;
        if server_phase == Some("finishing") && receipt.is_none() {
            // Policy is already appended; wait for this replica to apply it (and
            // write its CloudCopyOff rekey when switching to Private) before /finish.
            if private {
                self.reconcile_private_choices_locked().await;
            }
            self.mode_driver.schedule_in_progress(
                &entry.id,
                &op.request,
                &op.target,
                "finishing",
                None,
                None,
            );
            self.bump();
            return Ok(reserved);
        }

        let (finish, epoch, head, members) = if let Some((epoch, head, members)) = receipt {
            (true, epoch, head, members)
        } else {
            let Some((epoch, head, members)) =
                runtime.mode_source(private, false, guard.clone()).await
            else {
                if matches!(server_phase, Some("publishing_policy" | "finishing")) {
                    // Partial keyring rebuild may still be running; keep polling.
                    self.mode_driver.schedule_in_progress(
                        &entry.id,
                        &op.request,
                        &op.target,
                        server_phase.unwrap_or("finishing"),
                        None,
                        None,
                    );
                    self.bump();
                    return Ok(reserved);
                }
                self.mode_driver.stop(
                    &entry.id,
                    &op.request,
                    &op.target,
                    DriverState::WaitingForDevice,
                );
                self.bump();
                return Ok(json!({
                    "phase": "waiting_for_device",
                    "request_id": op.request,
                    "target_mode": op.target,
                }));
            };
            (false, epoch, head, members)
        };

        let identity = self.identity.get().ok_or_else(|| {
            ControlError::unavailable("device_identity_missing", "device key unavailable")
        })?;
        let request = B16(crate::attest::uuid_bytes(&op.request).ok_or_else(|| {
            ControlError::unavailable("mode_journal_invalid", "request UUID invalid")
        })?);
        let proof = ModeProof {
            request,
            private,
            finish,
            epoch,
            seq: head.seq,
            chain: head.chain,
            members,
        };
        let result = ctx
            .cloud
            .collection_mode_post(&ctx.connector_id, &col, &proof, &identity, current)
            .await;

        match result {
            Ok(mut answer) => {
                if answer.get("target_mode").is_none() {
                    answer["target_mode"] = json!(op.target);
                }
                let phase = answer
                    .get("phase")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                match phase.as_str() {
                    "complete" => {
                        Request::clear(dir)?;
                        self.mode_driver.clear(&entry.id);
                        self.reconcile_private_choices_locked().await;
                        if private {
                            self.account_keys.wake();
                        }
                        self.bump();
                    }
                    "abandoned" => {
                        Request::clear(dir)?;
                        self.mode_driver.clear(&entry.id);
                        self.bump();
                    }
                    "cancelled" => {
                        self.cancel_local_switch(&entry.id, runtime, private, guard.clone())
                            .await?;
                        Request::clear(dir)?;
                        self.mode_driver.clear(&entry.id);
                        self.bump();
                    }
                    "waiting_for_devices" => {
                        let devices: Vec<String> = answer
                            .get("devices")
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten()
                            .filter_map(Value::as_str)
                            .map(str::to_owned)
                            .collect();
                        let device_names = resolve_device_names(ctx, &devices, current).await;
                        if !device_names.is_empty() {
                            answer["device_names"] = json!(device_names);
                        }
                        self.mode_driver.stop(
                            &entry.id,
                            &op.request,
                            &op.target,
                            DriverState::WaitingForDevices {
                                devices,
                                device_names,
                            },
                        );
                        self.bump();
                    }
                    "waiting_for_token_expiry" => {
                        let retry_at = answer
                            .get("retry_at")
                            .and_then(Value::as_str)
                            .map(str::to_owned);
                        let delay =
                            retry_at_delay(retry_at.as_deref(), crate::fsutil::now_ms() as u64);
                        self.mode_driver.schedule_in_progress(
                            &entry.id,
                            &op.request,
                            &op.target,
                            "waiting_for_token_expiry",
                            retry_at,
                            delay,
                        );
                        self.bump();
                    }
                    "publishing_policy" | "finishing" => {
                        if private {
                            self.reconcile_private_choices_locked().await;
                        }
                        self.mode_driver.schedule_in_progress(
                            &entry.id,
                            &op.request,
                            &op.target,
                            &phase,
                            None,
                            None,
                        );
                        self.bump();
                    }
                    _ => {
                        self.mode_driver.stop(
                            &entry.id,
                            &op.request,
                            &op.target,
                            DriverState::WaitingForDevice,
                        );
                        self.bump();
                    }
                }
                Ok(answer)
            }
            Err(error) => {
                // `/finish` returning 503 not_ready while Workers catch up is a
                // normal in-progress state, not a failure or cancellation.
                if finish && matches!(&error, CloudError::Server(503, code) if code == "not_ready")
                {
                    self.mode_driver.schedule_in_progress(
                        &entry.id,
                        &op.request,
                        &op.target,
                        "finishing",
                        None,
                        None,
                    );
                    self.bump();
                    return Ok(json!({
                        "collection_id": entry.id,
                        "request_id": op.request,
                        "target_mode": op.target,
                        "phase": "finishing",
                    }));
                }
                // `409 mode_source_changed` during `/prepare` means the log head
                // moved concurrently; keep the request and retry with a fresh
                // native preflight once the replica catches up.
                if !finish
                    && matches!(&error, CloudError::Server(409, code) if code == "mode_source_changed")
                {
                    self.mode_driver.schedule_in_progress(
                        &entry.id,
                        &op.request,
                        &op.target,
                        "publishing_policy",
                        None,
                        None,
                    );
                    self.bump();
                    return Ok(json!({
                        "collection_id": entry.id,
                        "request_id": op.request,
                        "target_mode": op.target,
                        "phase": "publishing_policy",
                    }));
                }
                // An abandoned switch is post-publication terminal: clear the
                // local request without cancelling on the server or rolling back.
                if matches!(&error, CloudError::Server(409, code) if code == "mode_abandoned") {
                    Request::clear(dir)?;
                    self.mode_driver.clear(&entry.id);
                    self.bump();
                    return Ok(json!({
                        "collection_id": entry.id,
                        "request_id": op.request,
                        "target_mode": op.target,
                        "phase": "abandoned",
                    }));
                }
                // `keyed_owner_required` needs a keyed owner device; stop the
                // driver and surface a notice without cancelling the switch.
                if matches!(&error, CloudError::Server(409, code) if code == "keyed_owner_required")
                {
                    self.mode_driver.stop(
                        &entry.id,
                        &op.request,
                        &op.target,
                        DriverState::NeedsKeyedOwner,
                    );
                    self.bump();
                    return Err(ControlError::unavailable(
                        "keyed_owner_required",
                        "use an owner device holding this collection’s trusted key",
                    ));
                }
                // Auto-cancel ONLY on explicitly enumerated terminal
                // pre-publication refusals. An assigned/unknown batch refuses
                // cancellation (`mode_already_published`), so its intent stays.
                if is_terminal_pre_publication_refusal(finish, &error) {
                    match ctx
                        .cloud
                        .collection_mode_cancel(&entry.id, &op.request, current)
                        .await
                    {
                        Ok(_) => {
                            op.cancel_requested = true;
                            op.save(dir)?;
                            self.cancel_local_switch(&entry.id, runtime, private, guard.clone())
                                .await?;
                            Request::clear(dir)?;
                            self.mode_driver.clear(&entry.id);
                            self.bump();
                        }
                        Err(CloudError::Server(409, ref code))
                            if code == "mode_already_published" =>
                        {
                            self.mode_driver.schedule_in_progress(
                                &entry.id,
                                &op.request,
                                &op.target,
                                "finishing",
                                None,
                                None,
                            );
                            self.bump();
                        }
                        Err(_) => {
                            self.mode_driver.stop(
                                &entry.id,
                                &op.request,
                                &op.target,
                                DriverState::Attention {
                                    code: "mode_switch_attention".into(),
                                    message: format!(
                                        "Switch to {} stopped ({}).",
                                        mode_label(&op.target),
                                        error
                                    ),
                                    wake_on_sign_in: false,
                                    wake_on_resume: false,
                                },
                            );
                            self.bump();
                        }
                    }
                    return Err(cloud_refusal(error));
                }
                self.schedule_driver_for_error(
                    &entry.id,
                    &op,
                    if finish {
                        "finishing"
                    } else {
                        "publishing_policy"
                    },
                    &error,
                );
                Err(cloud_refusal(error))
            }
        }
    }

    async fn cancel_local_switch(
        &self,
        id: &str,
        runtime: &crate::runtime::Runtime,
        private: bool,
        guard: AccountKeyGuard,
    ) -> Result<(), ControlError> {
        if private {
            runtime
                .private_switch(PrivateSwitchOp::Cancel, guard)
                .await
                .ok_or_else(|| ControlError::unavailable("not_ready", "collection stopped"))?
                .map_err(|_| {
                    ControlError::unavailable(
                        "mode_cancel_pending",
                        "Native policy must confirm cancellation",
                    )
                })?;
        } else {
            self.project_cancelled_cloud(id, runtime, guard).await?;
        }
        Ok(())
    }

    fn schedule_driver_for_error(
        &self,
        id: &str,
        op: &Request,
        fallback_phase: &str,
        error: &CloudError,
    ) {
        match error {
            CloudError::RateLimited(retry_after) => {
                let attempts = self
                    .mode_driver
                    .entries
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .get(id)
                    .map_or(1, |e| e.attempts.saturating_add(1));
                self.mode_driver.schedule_retry_error(
                    id,
                    &op.request,
                    &op.target,
                    fallback_phase,
                    Some(rate_limit_delay(*retry_after, attempts)),
                );
            }
            CloudError::Network(_) | CloudError::Server(500..=599, _) => {
                self.mode_driver.schedule_retry_error(
                    id,
                    &op.request,
                    &op.target,
                    fallback_phase,
                    None,
                );
            }
            CloudError::Unauthenticated => {
                self.mode_driver.stop(
                    id,
                    &op.request,
                    &op.target,
                    DriverState::Attention {
                        code: "mode_switch_sign_in_required".into(),
                        message: format!(
                            "Switch to {} is paused until this computer is signed in.",
                            mode_label(&op.target)
                        ),
                        wake_on_sign_in: true,
                        wake_on_resume: false,
                    },
                );
                self.bump();
            }
            CloudError::Local(_) => {}
            CloudError::Server(_, code) => {
                self.mode_driver.stop(
                    id,
                    &op.request,
                    &op.target,
                    DriverState::Attention {
                        code: "mode_switch_attention".into(),
                        message: format!(
                            "Switch to {} needs attention ({code}).",
                            mode_label(&op.target)
                        ),
                        wake_on_sign_in: false,
                        wake_on_resume: false,
                    },
                );
                self.bump();
            }
        }
    }
}

fn identity_matches(
    op: &Request,
    entry: &crate::registry::Entry,
    cfg: &crate::sync::SyncConfig,
) -> bool {
    op.collection == entry.id
        && Some(op.account.as_str()) == entry.owner_account.as_deref()
        && Some(op.device.as_str()) == entry.device.as_deref()
        && op.genesis == cfg.genesis_hash
        && crate::attest::uuid_bytes(&op.request).is_some()
}

async fn resolve_device_names(
    ctx: &crate::collections::SyncCtx,
    devices: &[String],
    current: &(dyn Fn() -> Result<(), String> + Send + Sync),
) -> BTreeMap<String, String> {
    let mut names = BTreeMap::new();
    for id in devices.iter().take(MAX_DEVICE_NAME_LOOKUPS) {
        let Some(bytes) = crate::attest::uuid_bytes(id) else {
            continue;
        };
        if let Ok(Some(name)) = ctx.cloud.computer_name(&bytes, current).await {
            names.insert(id.clone(), name);
        }
    }
    names
}
