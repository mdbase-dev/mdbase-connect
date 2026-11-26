//! Daemon-driven native collection mode switches. The identity-bound request
//! journal is durable before reservation/consent; unknown HTTP outcomes retain
//! the same request, and one background loop drives every confirmed request to
//! completion (or to a phase that requires a person).
use super::{Daemon, cloud_refusal};
use crate::cloud::CloudError;
use crate::control::{CollectionState, ControlError, Notice};
use crate::runtime::{AccountKeyGuard, PrivateSwitchOp};
use mdbn_replica::crypto::proof::ModeProof;
use mdbn_wire::common::{B16, B32};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::time::Instant;

const FILE: &str = "mode-request.json";
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
    generation: Option<String>,
    #[serde(default)]
    confirmed: bool,
    request: String,
    target: String,
    cancel_requested: bool,
    native_started: bool,
}

impl Request {
    fn load(dir: &Path) -> Result<Option<Self>, ControlError> {
        let path = dir.join(FILE);
        let invalid = || {
            ControlError::unavailable(
                "mode_journal_invalid",
                "Mode request journal is unreadable; retained",
            )
        };
        let Some(bytes) = crate::fsutil::read_optional(&path).map_err(|_| invalid())? else {
            return Ok(None);
        };
        crate::fsutil::verify_owner_only(&path).map_err(|_| invalid())?;
        let value: Self = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
        if [
            &value.collection,
            &value.account,
            &value.device,
            &value.request,
        ]
        .iter()
        .any(|id| crate::attest::uuid_bytes(id).is_none_or(|id| id == [0; 16]))
            || std::iter::once(&value.genesis)
                .chain(value.generation.as_ref())
                .any(|hash| {
                    hash.len() != 64
                        || !hash
                            .bytes()
                            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
                })
            || (value.confirmed && value.generation.is_none())
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
    #[serde(default)]
    include_local: bool,
}

#[derive(Deserialize)]
pub(super) struct ModeStatus {
    pub(super) collection: String,
    #[serde(default)]
    pub(super) include_local: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Blocker {
    SignIn,
    Resume,
    Manual,
}

#[derive(Clone, Copy)]
enum Schedule {
    Due(Instant),
    Parked(Blocker),
}

#[derive(Clone)]
struct Slot {
    request: String,
    schedule: Schedule,
    backoff: u32,
    notice: Option<Notice>,
}

impl Slot {
    fn due(request: String) -> Self {
        Self {
            request,
            schedule: Schedule::Due(Instant::now()),
            backoff: 0,
            notice: Some(in_progress_notice()),
        }
    }
}

#[derive(Default)]
pub(crate) struct ModeDriver {
    wake: tokio::sync::Notify,
    slots: Mutex<BTreeMap<String, Slot>>,
}

impl ModeDriver {
    fn slot(&self, id: &str) -> Option<Slot> {
        self.slots.lock().unwrap().get(id).cloned()
    }

    fn set(&self, id: &str, slot: Slot) -> bool {
        let mut slots = self.slots.lock().unwrap();
        let changed = slots
            .get(id)
            .is_none_or(|old| old.request != slot.request || old.notice != slot.notice);
        slots.insert(id.into(), slot);
        changed
    }

    pub(crate) fn clear(&self, id: &str) -> bool {
        self.slots.lock().unwrap().remove(id).is_some()
    }

    pub(crate) fn wake(&self) {
        self.wake.notify_one();
    }

    pub(crate) fn wake_on_sign_in(&self) {
        self.unpark(None, Blocker::SignIn);
    }

    pub(crate) fn wake_collection(&self, id: &str) {
        self.unpark(Some(id), Blocker::Resume);
    }

    fn unpark(&self, collection: Option<&str>, blocker: Blocker) {
        for (id, slot) in self.slots.lock().unwrap().iter_mut() {
            if collection.is_none_or(|collection| collection == id)
                && matches!(slot.schedule, Schedule::Parked(current) if current == blocker)
            {
                slot.schedule = Schedule::Due(Instant::now());
            }
        }
        self.wake();
    }

    pub(crate) fn notices(&self, id: &str) -> Vec<Notice> {
        self.slot(id)
            .and_then(|slot| slot.notice)
            .into_iter()
            .collect()
    }

    fn attach(&self, id: &str, reply: &mut Value, status: bool) {
        let record = if status { &reply["change"] } else { &*reply };
        if let Some(slot) = self.slot(id)
            && record["request_id"].as_str() == Some(slot.request.as_str())
            && !matches!(
                record["phase"].as_str(),
                Some("complete" | "cancelled" | "abandoned")
            )
        {
            reply["local"] = json!(slot.notice);
        }
    }

    fn due(&self, now: Instant) -> Vec<(String, String)> {
        self.slots
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, slot)| matches!(slot.schedule, Schedule::Due(at) if at <= now))
            .map(|(id, slot)| (id.clone(), slot.request.clone()))
            .collect()
    }

    fn next(&self) -> Option<Instant> {
        self.slots
            .lock()
            .unwrap()
            .values()
            .filter_map(|slot| match slot.schedule {
                Schedule::Due(at) => Some(at),
                Schedule::Parked(_) => None,
            })
            .min()
    }
}

enum Next {
    Terminal,
    Retry(Option<Duration>),
    Park(Blocker),
}

struct Outcome {
    next: Next,
    reply: Result<Value, ControlError>,
    notice: Option<Notice>,
}

impl Outcome {
    fn terminal(reply: Result<Value, ControlError>) -> Self {
        Self {
            next: Next::Terminal,
            reply,
            notice: None,
        }
    }

    fn retry(reply: Result<Value, ControlError>, delay: Option<Duration>) -> Self {
        Self {
            next: Next::Retry(delay),
            reply,
            notice: None,
        }
    }

    fn park(
        blocker: Blocker,
        code: &str,
        message: impl Into<String>,
        reply: Result<Value, ControlError>,
    ) -> Self {
        Self {
            next: Next::Park(blocker),
            reply,
            notice: Some(notice(code, message)),
        }
    }

    fn local(error: ControlError) -> Self {
        let (blocker, code) = match error.reason.as_deref() {
            Some("not_signed_in" | "account_changed" | "collection_account_mismatch") => {
                (Blocker::SignIn, "mode_switch_sign_in_required")
            }
            Some("not_serving") => (Blocker::Resume, "mode_switch_paused"),
            Some("keyed_owner_required") => (Blocker::Manual, "mode_switch_keyed_owner_required"),
            Some(
                "mode_journal_invalid"
                | "sync_config_invalid"
                | "trust_missing"
                | "not_registered"
                | "device_identity_missing",
            ) => (Blocker::Manual, "mode_switch_attention"),
            _ => return Self::retry(Err(error), None),
        };
        Self::park(blocker, code, error.message.clone(), Err(error))
    }

    fn cloud(error: CloudError) -> Self {
        let delay = match &error {
            CloudError::RateLimited(seconds) => seconds.map(|s| Duration::from_secs(s.max(1))),
            CloudError::Network(_) | CloudError::Server(500..=599 | 200..=299, _) => None,
            CloudError::Unauthenticated | CloudError::Local(_) => {
                return Self::local(mode_refusal(error));
            }
            CloudError::Server(409, code) if code == "keyed_owner_required" => {
                return Self::local(mode_refusal(error));
            }
            _ => {
                let error = mode_refusal(error);
                return Self::park(
                    Blocker::Manual,
                    "mode_switch_attention",
                    error.message.clone(),
                    Err(error),
                );
            }
        };
        Self::retry(Err(mode_refusal(error)), delay)
    }
}

fn notice(code: &str, message: impl Into<String>) -> Notice {
    Notice {
        path: None,
        code: code.into(),
        message: message.into(),
    }
}

fn in_progress_notice() -> Notice {
    notice(
        "mode_switch_in_progress",
        "This computer is continuing the mode switch.",
    )
}

fn mode_refusal(error: CloudError) -> ControlError {
    match error {
        CloudError::Server(status, code) => {
            ControlError::unavailable(&code, format!("Mode switch refused ({status} {code})."))
        }
        CloudError::Local(_) => {
            ControlError::unavailable("account_changed", "Account changed during the mode switch.")
        }
        other => cloud_refusal(other),
    }
}

type Current<'a> = &'a (dyn Fn() -> Result<(), String> + Send + Sync);

struct ModeLink {
    ctx: crate::collections::SyncCtx,
    source: crate::authority::CollectionAuthority,
    collection: [u8; 16],
}

impl ModeLink {
    fn current(&self) -> Result<(), String> {
        self.source
            .current_synced()
            .map_err(|_| "account_changed".into())
    }
}

struct ModeContext {
    link: ModeLink,
    entry: crate::registry::Entry,
    runtime: Arc<crate::runtime::Runtime>,
    dir: std::path::PathBuf,
    genesis: String,
    guard: AccountKeyGuard,
}

impl ModeContext {
    fn validate(&self, op: &Request) -> Result<(), ControlError> {
        if op.collection == self.entry.id
            && Some(op.account.as_str()) == self.entry.owner_account.as_deref()
            && Some(op.device.as_str()) == self.entry.device.as_deref()
            && op.genesis == self.genesis
        {
            return Ok(());
        }
        Err(ControlError::unavailable(
            "mode_journal_invalid",
            "Mode request identity differs; retained.",
        ))
    }

    async fn confirm(&self, daemon: &Daemon, op: &mut Request) -> Result<(), ControlError> {
        daemon
            .confirm(&crate::confirm::Prompt::CollectionMode {
                collection: self.entry.name.clone(),
                private: op.target == "private",
            })
            .await?;
        let generation = self
            .runtime
            .mode_generation(self.guard.clone())
            .await
            .ok_or_else(|| {
                ControlError::unavailable("not_ready", "Native privacy state is unavailable")
            })?;
        op.generation = Some(crate::secrets::hex(&generation.0));
        op.confirmed = true;
        Ok(())
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Action {
    Reserve,
    Read,
    ReadAfterAbandon,
    Prepare,
    Finish,
    Delete,
}

impl Daemon {
    pub(super) async fn collection_mode_drive(self: Arc<Self>) {
        let mut stop = self.shutdown.subscribe();
        let mut ready = self.readiness.subscribe();
        tokio::select! {
            _ = stop.wait_for(|s| *s) => return,
            _ = ready.wait_for(|r| r.ready) => {}
        }
        self.load_mode_requests().await;
        loop {
            for (id, request) in self.mode_driver.due(Instant::now()) {
                tokio::select! {
                    _ = stop.wait_for(|s| *s) => return,
                    _ = self.drive_mode_request(&id, &request) => {}
                }
            }
            let next = self.mode_driver.next();
            tokio::select! {
                _ = stop.wait_for(|s| *s) => return,
                _ = self.mode_driver.wake.notified() => {}
                _ = async {
                    match next {
                        Some(at) => tokio::time::sleep_until(at).await,
                        None => std::future::pending().await,
                    }
                } => {}
            }
        }
    }

    async fn load_mode_requests(&self) {
        let _gate = self.account_gate.lock().await;
        let ids: Vec<_> = self
            .inner
            .lock()
            .await
            .registry
            .collections
            .iter()
            .map(|e| e.id.clone())
            .collect();
        for id in ids {
            if self.mode_driver.slot(&id).is_some() {
                continue;
            }
            match Request::load(&self.profile.collection_dir(&id)) {
                Ok(Some(op)) => {
                    self.track_mode_request(&id, &op);
                }
                Ok(None) => {}
                Err(error) => {
                    let _ = self.apply_mode_outcome(
                        &id,
                        &Slot::due(String::new()),
                        Outcome::local(error),
                    );
                }
            }
        }
    }

    fn track_mode_request(&self, id: &str, op: &Request) -> Slot {
        let slot = Slot::due(op.request.clone());
        if self.mode_driver.set(id, slot.clone()) {
            self.bump();
        }
        self.mode_driver.wake();
        slot
    }

    async fn drive_mode_request(&self, id: &str, request: &str) {
        let _gate = self.account_gate.lock().await;
        let Some(slot) = self.mode_driver.slot(id).filter(|slot| {
            slot.request == request
                && matches!(slot.schedule, Schedule::Due(at) if at <= Instant::now())
        }) else {
            return;
        };
        match Request::load(&self.profile.collection_dir(id)) {
            Ok(Some(op)) if op.request == request => {
                let context = self.mode_context(id).await;
                let _ = self.run_mode_step(id, op, &slot, context).await;
            }
            Ok(_) => {
                if self.mode_driver.clear(id) {
                    self.bump();
                }
            }
            Err(error) => {
                let _ = self.apply_mode_outcome(id, &slot, Outcome::local(error));
            }
        }
    }

    fn mode_link(&self, id: &str) -> Result<ModeLink, ControlError> {
        let collection = crate::attest::uuid_bytes(id)
            .ok_or_else(|| ControlError::invalid("collection", "collection UUID required"))?;
        let source = self.authority.source(B16(collection)).map_err(|_| {
            ControlError::unavailable("not_signed_in", "Sign this computer in to continue.")
        })?;
        let (ctx, _) = self.sync_parts()?;
        let link = ModeLink {
            ctx,
            source,
            collection,
        };
        link.current().map_err(|_| {
            ControlError::unavailable("not_serving", "Resume the synced collection to continue.")
        })?;
        Ok(link)
    }

    async fn mode_context(&self, id: &str) -> Result<ModeContext, ControlError> {
        let (entry, (state, reason), runtime) = {
            let inner = self.inner.lock().await;
            let host = inner
                .hosts
                .iter()
                .find(|h| h.entry().id == id)
                .ok_or_else(|| {
                    ControlError::unavailable("not_registered", "Collection not registered.")
                })?;
            (host.entry().clone(), host.current(), host.runtime())
        };
        if state == CollectionState::Paused {
            return Err(ControlError::unavailable(
                "not_serving",
                "Resume the collection to continue.",
            ));
        }
        let link = self.mode_link(id)?;
        let runtime = runtime.ok_or_else(|| match reason.as_deref() {
            Some("collection_account_mismatch") => ControlError::unavailable(
                "collection_account_mismatch",
                "Sign in with the account that owns this collection.",
            ),
            Some("sync_config_invalid") => ControlError::unavailable(
                "sync_config_invalid",
                "Check the collection’s sync configuration.",
            ),
            reason
                if state == CollectionState::Opening
                    || matches!(reason, Some("runtime_pending" | "sync_unreachable")) =>
            {
                ControlError::unavailable("not_ready", "Waiting for the collection to open.")
            }
            _ => ControlError::unavailable("not_serving", "Resume the collection to continue."),
        })?;
        let dir = self.profile.collection_dir(id);
        let cfg = crate::sync::SyncConfig::load(&dir.join(crate::sync::FILE))
            .ok()
            .flatten()
            .ok_or_else(|| {
                ControlError::unavailable("sync_config_invalid", "Sync link is missing or invalid.")
            })?;
        let fence = link.source.clone();
        let guard: AccountKeyGuard = Arc::new(move || fence.current_synced().is_ok());
        Ok(ModeContext {
            link,
            entry,
            runtime,
            dir,
            genesis: cfg.genesis_hash,
            guard,
        })
    }

    pub(super) async fn collection_mode_status(
        &self,
        id: &str,
        include_local: bool,
    ) -> Result<Value, ControlError> {
        let link = self.mode_link(id)?;
        let mut result = link
            .ctx
            .cloud
            .collection_mode_status(id, &|| link.current())
            .await
            .map_err(mode_refusal)?;
        if include_local {
            self.mode_driver.attach(id, &mut result, true);
        }
        Ok(result)
    }

    pub(super) async fn change_collection_mode(
        &self,
        p: ChangeMode,
    ) -> Result<Value, ControlError> {
        let id = &p.collection;
        let valid_target = match p.target_mode.as_deref() {
            Some("private" | "cloud_copy") => true,
            None => p.cancel,
            _ => false,
        };
        if !valid_target {
            return Err(ControlError::invalid(
                "target_mode",
                "choose private or cloud_copy",
            ));
        }
        if crate::attest::uuid_bytes(id).is_none() {
            return Err(ControlError::invalid(
                "collection",
                "collection UUID required",
            ));
        }
        let _gate = self.account_gate.lock().await;
        let retained = Request::load(&self.profile.collection_dir(id))?;
        let new_request = retained.is_none();
        let ctx = self.mode_context(id).await?;
        let mut op = match retained {
            Some(op) => {
                ctx.validate(&op)?;
                check_target(p.target_mode.as_deref(), &op.target)?;
                op
            }
            None => {
                let status = ctx
                    .link
                    .ctx
                    .cloud
                    .collection_mode_status(id, &|| ctx.link.current())
                    .await
                    .map_err(mode_refusal)?;
                let active = status.get("change").filter(|change| !change.is_null());
                let target = match (active, p.cancel) {
                    (Some(active), _) if active["phase"] == "abandoned" => {
                        return Ok(active.clone());
                    }
                    (Some(active), _) => {
                        let target = required_target(active)?;
                        check_target(p.target_mode.as_deref(), target)?;
                        target
                    }
                    (None, true) => return Ok(json!({"phase":"cancelled"})),
                    (None, false) => p.target_mode.as_deref().expect("validated target"),
                };
                if active.is_none() && status["current_mode"] == target {
                    let selected = if target == "private" {
                        ctx.runtime
                            .mode_source(true, true, ctx.guard.clone())
                            .await
                            .is_some()
                    } else {
                        matches!(
                            ctx.runtime
                                .private_switch(PrivateSwitchOp::CloudSelected, ctx.guard.clone())
                                .await,
                            Some(Ok(Some(_)))
                        )
                    };
                    return Ok(
                        json!({"phase": if selected { "complete" } else { "waiting_for_device" }, "target_mode":target}),
                    );
                }
                if !p.cancel && status["execution_available"] != true {
                    return Err(ControlError::unavailable(
                        "mode_switch_unavailable",
                        mode_switch_unavailable_message(target),
                    ));
                }
                let request = match active {
                    Some(active) => active["request_id"]
                        .as_str()
                        .filter(|id| crate::attest::uuid_bytes(id).is_some_and(|id| id != [0; 16]))
                        .ok_or_else(|| ControlError::internal("active switch request missing"))?
                        .to_owned(),
                    None => crate::secrets::new_uuid()
                        .map_err(|e| ControlError::internal(e.to_string()))?,
                };
                Request {
                    collection: id.clone(),
                    account: ctx.entry.owner_account.clone().ok_or_else(|| {
                        ControlError::unavailable("not_ready", "Account missing.")
                    })?,
                    device: ctx
                        .entry
                        .device
                        .clone()
                        .ok_or_else(|| ControlError::unavailable("not_ready", "Device missing."))?,
                    genesis: ctx.genesis.clone(),
                    generation: None,
                    request,
                    target: target.into(),
                    confirmed: false,
                    cancel_requested: p.cancel,
                    native_started: false,
                }
            }
        };
        let new_cancel = p.cancel && !op.cancel_requested;
        if new_cancel {
            op.cancel_requested = true;
            op.save(&ctx.dir)?;
        }
        let slot = self
            .mode_driver
            .slot(id)
            .filter(|slot| slot.request == op.request);
        // Explicit cancellation may end token drain early. HTTP backoff and
        // Retry-After still apply to the same request.
        if slot.as_ref().is_some_and(|slot| {
            matches!(slot.schedule, Schedule::Due(at) if at > Instant::now())
                && !(new_cancel
                    && slot
                        .notice
                        .as_ref()
                        .is_some_and(|n| n.code == "mode_switch_token_drain"))
        }) {
            let mut reply =
                json!({"request_id":op.request, "target_mode":op.target, "retry_scheduled":true});
            if op.cancel_requested {
                reply["cancel_requested"] = json!(true);
            }
            if p.include_local {
                self.mode_driver.attach(id, &mut reply, false);
            }
            return Ok(reply);
        }
        let needs_confirmation = !p.cancel && !op.confirmed && !op.cancel_requested;
        if needs_confirmation {
            ctx.confirm(self, &mut op).await?;
        }
        if new_request || needs_confirmation {
            op.save(&ctx.dir)?;
        }
        let slot = slot.unwrap_or_else(|| self.track_mode_request(id, &op));
        let mut reply = self.run_mode_step(id, op, &slot, Ok(ctx)).await?;
        if p.include_local {
            self.mode_driver.attach(id, &mut reply, false);
        }
        Ok(reply)
    }

    async fn run_mode_step(
        &self,
        id: &str,
        op: Request,
        slot: &Slot,
        ctx: Result<ModeContext, ControlError>,
    ) -> Result<Value, ControlError> {
        let outcome = match ctx {
            Ok(ctx) => self
                .mode_step(&ctx, op, slot)
                .await
                .unwrap_or_else(Outcome::local),
            Err(error) => Outcome::local(error),
        };
        self.apply_mode_outcome(id, slot, outcome)
    }

    fn apply_mode_outcome(
        &self,
        id: &str,
        slot: &Slot,
        outcome: Outcome,
    ) -> Result<Value, ControlError> {
        let mut next_slot = slot.clone();
        next_slot.notice = outcome.notice;
        let changed = match outcome.next {
            Next::Terminal => self.mode_driver.clear(id),
            Next::Park(blocker) => {
                next_slot.schedule = Schedule::Parked(blocker);
                next_slot.backoff = 0;
                self.mode_driver.set(id, next_slot)
            }
            Next::Retry(delay) => {
                next_slot.notice.get_or_insert_with(in_progress_notice);
                next_slot.backoff = if next_slot.notice == slot.notice {
                    (slot.backoff + 1).min(5)
                } else {
                    1
                };
                let delay = delay.unwrap_or_else(|| backoff_delay(next_slot.backoff));
                if let Some(at) = Instant::now().checked_add(delay) {
                    next_slot.schedule = Schedule::Due(at);
                } else {
                    next_slot.schedule = Schedule::Parked(Blocker::Manual);
                    next_slot.notice = Some(notice(
                        "mode_switch_attention",
                        "The server's retry deadline is out of range.",
                    ));
                }
                self.mode_driver.set(id, next_slot)
            }
        };
        if changed {
            self.bump();
        }
        self.mode_driver.wake();
        outcome.reply
    }

    async fn mode_step(
        &self,
        ctx: &ModeContext,
        mut op: Request,
        slot: &Slot,
    ) -> Result<Outcome, ControlError> {
        ctx.validate(&op)?;
        let id = ctx.entry.id.as_str();
        let cloud = &ctx.link.ctx.cloud;
        let current: Current<'_> = &|| ctx.link.current();
        let private = op.target == "private";
        let expected = B16(crate::attest::uuid_bytes(&op.request).expect("validated request UUID"));
        let mut action = if op.confirmed && !op.native_started && !op.cancel_requested {
            Action::Reserve
        } else {
            Action::Read
        };
        let mut result = match action {
            Action::Reserve => {
                cloud
                    .collection_mode_intent(id, &op.request, private, current)
                    .await
            }
            _ => {
                cloud
                    .collection_mode_request_status(id, &op.request, current)
                    .await
            }
        };
        // A confirmed request may have lost its reservation reply. Establish its
        // exact row before deleting it, even if cancellation arrived before POST.
        if action == Action::Read
            && op.confirmed
            && !op.native_started
            && op.cancel_requested
            && matches!(&result, Err(CloudError::Server(404, code)) if code == "not_found")
        {
            action = Action::Reserve;
            result = cloud
                .collection_mode_intent(id, &op.request, private, current)
                .await;
        }
        let cancel_refusal =
            || mode_refusal(CloudError::Server(409, "mode_already_published".into()));
        let mut cancel_refused = false;
        let mut prepare_refusal = None;
        let mut prepare_phase = "waiting_for_device";
        loop {
            let mut reply = match result {
                Ok(reply)
                    if reply["request_id"]
                        .as_str()
                        .and_then(crate::attest::uuid_bytes)
                        == Some(expected.0)
                        && reply
                            .get("target_mode")
                            .is_none_or(|value| value == &op.target)
                        && reply.get("collection_id").is_none_or(|value| value == id) =>
                {
                    reply
                }
                Ok(_) => {
                    return Err(ControlError::internal(
                        "Mode reply did not identify the retained request.",
                    ));
                }
                Err(CloudError::Server(409, code))
                    if action == Action::Delete && code == "mode_already_published" =>
                {
                    cancel_refused = true;
                    action = Action::Read;
                    result = cloud
                        .collection_mode_request_status(id, &op.request, current)
                        .await;
                    continue;
                }
                Err(CloudError::Server(409, code))
                    if matches!(action, Action::Prepare | Action::Finish)
                        && code == "mode_abandoned" =>
                {
                    action = Action::ReadAfterAbandon;
                    result = cloud
                        .collection_mode_request_status(id, &op.request, current)
                        .await;
                    continue;
                }
                Err(CloudError::Server(503, code))
                    if action == Action::Finish && code == "not_ready" =>
                {
                    return Ok(Outcome::retry(
                        Ok(
                            json!({"request_id":op.request, "target_mode":op.target, "phase":"finishing"}),
                        ),
                        None,
                    ));
                }
                Err(CloudError::Server(409, code))
                    if action == Action::Prepare && code == "mode_source_changed" =>
                {
                    let mut outcome = Outcome::retry(
                        Ok(
                            json!({"request_id":op.request, "target_mode":op.target, "phase":prepare_phase}),
                        ),
                        None,
                    );
                    outcome.notice = Some(notice(
                        "mode_switch_refreshing",
                        "This computer is refreshing the replica before retrying.",
                    ));
                    return Ok(outcome);
                }
                Err(CloudError::Server(404, code))
                    if op.cancel_requested
                        && matches!(action, Action::Read | Action::Reserve | Action::Delete)
                        && code == "not_found" =>
                {
                    if op.native_started {
                        let gone = json!({"phase":"cancelled", "request_id":op.request, "target_mode":op.target});
                        return self
                            .finish_mode_request(ctx, &op, gone, prepare_refusal)
                            .await;
                    }
                    Request::clear(&ctx.dir)?;
                    return Ok(Outcome::terminal(Ok(json!({"phase":"cancelled"}))));
                }
                Err(error @ CloudError::Server(400 | 403 | 404, _))
                    if action == Action::Reserve =>
                {
                    Request::clear(&ctx.dir)?;
                    return Ok(Outcome::terminal(Err(mode_refusal(error))));
                }
                Err(CloudError::Server(409, code))
                    if action == Action::Reserve
                        && matches!(
                            code.as_str(),
                            "mode_abandoned"
                                | "mode_request_conflict"
                                | "mode_change_in_progress"
                                | "mode_already_current"
                        ) =>
                {
                    Request::clear(&ctx.dir)?;
                    return Ok(Outcome::terminal(Err(mode_refusal(CloudError::Server(
                        409, code,
                    )))));
                }
                Err(error)
                    if action == Action::Prepare
                        && prepare_phase != "publishing_policy"
                        && is_terminal_pre_publication_refusal(&error) =>
                {
                    op.cancel_requested = true;
                    op.save(&ctx.dir)?;
                    prepare_refusal = Some(mode_refusal(error));
                    action = Action::Delete;
                    result = cloud.collection_mode_cancel(id, &op.request, current).await;
                    continue;
                }
                Err(error) => return Ok(Outcome::cloud(error)),
            };
            reply["target_mode"] = json!(op.target);
            let phase = reply["phase"].as_str().unwrap_or("");
            match phase {
                "cancelled" | "abandoned" | "complete" => {
                    let terminal_error = if op.cancel_requested && phase == "complete" {
                        Some(cancel_refusal())
                    } else {
                        prepare_refusal
                    };
                    return self
                        .finish_mode_request(ctx, &op, reply, terminal_error)
                        .await;
                }
                _ if action == Action::Delete => {
                    return Err(ControlError::internal(
                        "DELETE did not return a terminal mode phase.",
                    ));
                }
                _ if action == Action::ReadAfterAbandon => {
                    return Ok(Outcome::retry(Ok(reply), None));
                }
                "publishing_policy" | "finishing"
                    if op.cancel_requested && (cancel_refused || phase == "finishing") =>
                {
                    if !op.confirmed && !op.native_started {
                        Request::clear(&ctx.dir)?;
                        return Ok(Outcome::terminal(Err(cancel_refusal())));
                    }
                    op.cancel_requested = false;
                    op.save(&ctx.dir)?;
                    return Ok(Outcome::retry(Err(cancel_refusal()), None));
                }
                "waiting_for_device"
                | "waiting_for_devices"
                | "waiting_for_token_expiry"
                | "publishing_policy"
                    if op.cancel_requested && !cancel_refused =>
                {
                    action = Action::Delete;
                    result = cloud.collection_mode_cancel(id, &op.request, current).await;
                    continue;
                }
                _ if cancel_refused => return Ok(Outcome::retry(Err(cancel_refusal()), None)),
                _ if !op.confirmed => {
                    // Old journals encoded a refused cancel and a confirmed
                    // switch identically, even after setting native_started.
                    let next = if op.native_started
                        && matches!(phase, "publishing_policy" | "finishing")
                    {
                        Next::Retry(None)
                    } else {
                        Next::Park(Blocker::Manual)
                    };
                    return Ok(Outcome {
                        next,
                        reply: Ok(reply),
                        notice: Some(notice(
                            "mode_switch_confirmation_required",
                            "Run the mode command to confirm this switch on this computer.",
                        )),
                    });
                }
                "publishing_policy"
                    if private && matches!(action, Action::Read | Action::Reserve) =>
                {
                    // A deferred Private outbox row can still hold a stale
                    // source head. The executor accepts a refreshed proof only
                    // while the row is unassigned. Use existing intent here.
                    let Some(source) = ctx
                        .runtime
                        .mode_source(private, false, ctx.guard.clone())
                        .await
                    else {
                        return Ok(Outcome::retry(Ok(reply), None));
                    };
                    prepare_phase = "publishing_policy";
                    action = Action::Prepare;
                    result = self
                        .post_mode_proof(ctx, expected, private, false, source)
                        .await?;
                }
                "publishing_policy" => return Ok(Outcome::retry(Ok(reply), None)),
                "finishing" if matches!(action, Action::Prepare | Action::Finish) => {
                    return Ok(Outcome::retry(Ok(reply), None));
                }
                "finishing" => {
                    let Some(source) = ctx
                        .runtime
                        .mode_source(private, true, ctx.guard.clone())
                        .await
                    else {
                        return Ok(Outcome::retry(Ok(reply), None));
                    };
                    action = Action::Finish;
                    result = self
                        .post_mode_proof(ctx, expected, private, true, source)
                        .await?;
                }
                "waiting_for_devices" => {
                    let list = format_mode_devices(&reply);
                    let message =
                        format!("Update or remove older devices before continuing: {list}.");
                    return Ok(Outcome::park(
                        Blocker::Manual,
                        "mode_switch_devices_need_update",
                        message,
                        Ok(reply),
                    ));
                }
                "waiting_for_device" | "waiting_for_token_expiry" => {
                    let delay = reply["retry_at"]
                        .as_str()
                        .and_then(|raw| retry_at_delay(Some(raw), crate::fsutil::now_ms() as u64));
                    if action == Action::Prepare || delay.is_some() {
                        let mut outcome = Outcome::retry(Ok(reply), delay);
                        if delay.is_some() {
                            outcome.notice = Some(notice(
                                "mode_switch_token_drain",
                                "This computer will continue after older app connections expire.",
                            ));
                        }
                        return Ok(outcome);
                    }
                    let mut source = ctx
                        .runtime
                        .mode_source(private, false, ctx.guard.clone())
                        .await;
                    if source.is_none()
                        && slot
                            .notice
                            .as_ref()
                            .is_some_and(|notice| notice.code == "mode_switch_refreshing")
                        && slot.backoff < 5
                    {
                        let mut outcome = Outcome::retry(Ok(reply), None);
                        outcome.notice = slot.notice.clone();
                        return Ok(outcome);
                    }
                    if !op.native_started {
                        // Fence the reservation and the exact consent generation
                        // before invoking a native action that can survive a crash.
                        op.native_started = true;
                        op.save(&ctx.dir)?;
                    }
                    if source.is_none() {
                        self.begin_native_mode(ctx, &op, private).await?;
                        source = ctx
                            .runtime
                            .mode_source(private, false, ctx.guard.clone())
                            .await;
                    }
                    let Some(source) = source else {
                        return Ok(Outcome::park(
                            Blocker::Manual,
                            "mode_switch_waiting_for_device",
                            "Use an owner device holding this collection’s trusted key.",
                            Ok(reply),
                        ));
                    };
                    prepare_phase = if phase == "waiting_for_token_expiry" {
                        "waiting_for_token_expiry"
                    } else {
                        "waiting_for_device"
                    };
                    action = Action::Prepare;
                    result = self
                        .post_mode_proof(ctx, expected, private, false, source)
                        .await?;
                }
                _ => {
                    return Err(ControlError::internal(
                        "Mode reply had an unexpected phase.",
                    ));
                }
            }
        }
    }

    async fn begin_native_mode(
        &self,
        ctx: &ModeContext,
        op: &Request,
        private: bool,
    ) -> Result<(), ControlError> {
        if private {
            ctx.runtime
                .private_switch(PrivateSwitchOp::Request, ctx.guard.clone())
                .await
                .ok_or_else(|| ControlError::unavailable("not_ready", "Collection stopped."))?
                .map_err(|_| {
                    ControlError::unavailable(
                        "keyed_owner_required",
                        "Use an owner device holding this collection’s trusted key.",
                    )
                })?;
        } else {
            let generation = op
                .generation
                .as_deref()
                .and_then(|value| crate::secrets::hex_decode(value).ok())
                .and_then(|bytes| bytes.try_into().ok())
                .expect("confirmed request has a validated generation");
            self.choose_cloud_copy_locally(
                &ctx.entry.id,
                &ctx.runtime,
                ctx.guard.clone(),
                B32(generation),
            )
            .await?;
        }
        Ok(())
    }

    async fn post_mode_proof(
        &self,
        ctx: &ModeContext,
        request: B16,
        private: bool,
        finish: bool,
        (epoch, head, members): (u64, mdbn_replica::store::Head, Vec<B16>),
    ) -> Result<Result<Value, CloudError>, ControlError> {
        let identity = self.identity.get().ok_or_else(|| {
            ControlError::unavailable("device_identity_missing", "Device key unavailable.")
        })?;
        let proof = ModeProof {
            request,
            private,
            finish,
            epoch,
            seq: head.seq,
            chain: head.chain,
            members,
        };
        Ok(ctx
            .link
            .ctx
            .cloud
            .collection_mode_post(
                &ctx.link.ctx.connector_id,
                &ctx.link.collection,
                &proof,
                &identity,
                &|| ctx.link.current(),
            )
            .await)
    }

    async fn finish_mode_request(
        &self,
        ctx: &ModeContext,
        op: &Request,
        reply: Value,
        error: Option<ControlError>,
    ) -> Result<Outcome, ControlError> {
        let kind = match reply["phase"].as_str() {
            Some("cancelled") => {
                if op.native_started {
                    if op.target == "private" {
                        ctx.runtime
                            .private_switch(PrivateSwitchOp::Cancel, ctx.guard.clone())
                            .await
                            .ok_or_else(|| {
                                ControlError::unavailable("not_ready", "Collection stopped.")
                            })?
                            .map_err(|_| {
                                ControlError::unavailable(
                                    "mode_cancel_pending",
                                    "Native policy must confirm cancellation.",
                                )
                            })?;
                    } else {
                        self.project_cancelled_cloud(
                            &ctx.entry.id,
                            &ctx.runtime,
                            ctx.guard.clone(),
                        )
                        .await?;
                    }
                }
                Some("collection_mode_cancelled")
            }
            Some("complete") if op.generation.is_some() => Some("collection_mode_changed"),
            _ => None,
        };
        ctx.link
            .current()
            .map_err(|_| ControlError::unavailable("account_changed", "Account changed."))?;
        Request::clear(&ctx.dir)?;
        if let Some(kind) = kind {
            let mut entry = crate::activity::ActivityEntry::now(kind);
            entry.collection = Some(ctx.entry.id.clone());
            entry.collection_name = Some(ctx.entry.name.clone());
            entry.detail = Some(op.target.clone());
            self.activity.record(entry);
        }
        if kind == Some("collection_mode_changed") {
            self.reconcile_private_choices_locked().await;
            if op.target == "private" {
                self.account_keys.wake();
            }
        }
        Ok(Outcome::terminal(error.map_or(Ok(reply), Err)))
    }
}

fn required_target(record: &Value) -> Result<&str, ControlError> {
    record["target_mode"]
        .as_str()
        .filter(|target| matches!(*target, "private" | "cloud_copy"))
        .ok_or_else(|| ControlError::internal("Active switch target missing."))
}

fn check_target(requested: Option<&str>, active: &str) -> Result<(), ControlError> {
    if requested.is_some_and(|target| target != active) {
        return Err(ControlError::invalid(
            "mode_change_in_progress",
            format!(
                "A switch to {} is already in progress. Finish or cancel it first.",
                mode_label(active)
            ),
        ));
    }
    Ok(())
}

pub(crate) fn mode_label(mode: &str) -> &str {
    match mode {
        "private" => "Private",
        "cloud_copy" => "Cloud copy",
        _ => "Unknown mode",
    }
}

pub(crate) fn mode_switch_unavailable_message(target: &str) -> &'static str {
    if target == "private" {
        "Switching this collection isn't available yet. Create a new collection as Private from the start (`mdbase collection add <folder>`, then `mdbase sync enable <collection> --mode private`) and copy or move your notes into it."
    } else {
        "Switching this collection isn't available yet. Create a new collection with Cloud copy (`mdbase collection add <folder>`, then `mdbase sync enable <collection> --mode cloud-copy`) and copy or move your notes into it."
    }
}

pub(crate) fn format_mode_devices(record: &Value) -> String {
    record["devices"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(|id| {
            let short = id.split('-').next().unwrap_or(id);
            match record["device_names"][id].as_str() {
                Some(name) => format!("{name} ({short})"),
                None => short.to_owned(),
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}

pub(crate) fn format_wait_phrase(retry_at: &str, now_ms: u64) -> Option<String> {
    let secs = (parse_rfc3339_ms(retry_at)?.checked_sub(now_ms)?).div_ceil(1000);
    match secs {
        0 => None,
        1..=44 => Some(format!("about {secs} s")),
        45..=89 => Some("about 1 min".into()),
        _ => Some(format!("about {} min", secs.div_ceil(60))),
    }
}

fn parse_rfc3339_ms(raw: &str) -> Option<u64> {
    let dt =
        time::OffsetDateTime::parse(raw, &time::format_description::well_known::Rfc3339).ok()?;
    u64::try_from(dt.unix_timestamp_nanos() / 1_000_000).ok()
}

fn retry_at_delay(retry_at: Option<&str>, now_ms: u64) -> Option<Duration> {
    let ms = parse_rfc3339_ms(retry_at?)?.checked_sub(now_ms)?;
    (ms > 0).then(|| Duration::from_millis(ms) + Duration::from_millis(250))
}

fn backoff_delay(attempt: u32) -> Duration {
    Duration::from_secs((2 << attempt.saturating_sub(1).min(4)).min(30))
}

fn is_terminal_pre_publication_refusal(error: &CloudError) -> bool {
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
