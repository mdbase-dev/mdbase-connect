//! Local takeover from the old connector: runs, mirror import and join, automatic Private sync and retiring the old service.

use super::*;

impl Daemon {
    /// The takeover record, if readable (status decoration only).
    pub(super) fn takeover_record(&self) -> Option<crate::takeover::record::Record> {
        crate::takeover::record::Record::load(&self.takeover_paths().record)
            .ok()
            .flatten()
    }

    pub(super) fn takeover_paths(&self) -> crate::takeover::Paths {
        crate::takeover::Paths::new(&self.profile.state_dir, self.profile.store_ids_file())
    }

    /// Background takeover (startup, after sign-in): errors are logged and kept for
    /// `doctor`.
    pub(super) async fn takeover_task(self: Arc<Self>, stop_mirrors: bool) {
        if let Err(e) = self.clone().takeover_run(stop_mirrors, true).await {
            tracing::warn!(error = %e.message, "local takeover did not run");
        }
        self.import_mirrors().await;
        self.auto_private().await;
    }

    /// Polling and the existing watch share one backoff. The run mutex also
    /// prevents concurrent polls (or focus events) from queuing rollout queries.
    pub(super) async fn retry_takeover(self: Arc<Self>, refresh: bool) {
        let Ok(run) = self.takeover.run.try_lock() else {
            return;
        };
        let waiting = self
            .takeover
            .waiting_for_batch
            .load(std::sync::atomic::Ordering::Relaxed)
            || self
                .takeover_record()
                .is_some_and(|r| r.waiting_for_old_daemon());
        if !waiting
            || !self
                .takeover
                .retry
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .due(std::time::Instant::now(), refresh)
        {
            return;
        }
        let result = self.clone().takeover_run_locked(false, true).await;
        drop(run);
        if let Err(e) = result {
            tracing::warn!(error = %e.message, "local takeover retry did not run");
        }
        if !self
            .takeover
            .waiting_for_batch
            .load(std::sync::atomic::Ordering::Relaxed)
        {
            self.import_mirrors().await;
            self.auto_private().await;
        }
    }

    /// Turn Private sync on for taken-over collections that are still local
    /// (`auto_private`), so apps that reached them through mdbase Connect keep
    /// working. Runs after every takeover attempt (daemon start, sign-in, an
    /// explicit move) and after a held file is resolved. A pass that leaves
    /// collections waiting arms one retry timer with backoff.
    pub(super) async fn auto_private(self: Arc<Self>) {
        if self.auto_private_pass().await.pending() {
            self.arm_auto_private_retry();
        }
    }

    pub(super) fn spawn_auto_private(&self) {
        if let Some(d) = self.self_weak.get().and_then(std::sync::Weak::upgrade) {
            self.spawn(d.auto_private());
        }
    }

    fn arm_auto_private_retry(self: Arc<Self>) {
        use std::sync::atomic::Ordering;
        if self.auto_private.retrying.swap(true, Ordering::SeqCst) {
            return;
        }
        self.clone().spawn(async move {
            let mut shutdown = self.shutdown.subscribe();
            let mut attempt = 0u32;
            loop {
                tokio::select! {
                    _ = tokio::time::sleep(crate::auto_private::backoff(attempt)) => {}
                    _ = shutdown.wait_for(|stop| *stop) => break,
                }
                if *self.shutdown.borrow() || !self.auto_private_pass().await.pending() {
                    break;
                }
                attempt = attempt.saturating_add(1);
            }
            self.auto_private.retrying.store(false, Ordering::SeqCst);
        });
    }

    /// One pass of [`Daemon::auto_private`]: each candidate goes through the
    /// ordinary `sync.enable` (Private for a taken-over collection; an
    /// interrupted adopt resumes from its journal). Held files are never accepted
    /// here. The pass never touches the takeover or the folder's bytes itself.
    async fn auto_private_pass(&self) -> crate::auto_private::Pass {
        use crate::auto_private as auto;
        let _pass = self.auto_private.pass.lock().await;
        let candidates = {
            let inner = self.inner.lock().await;
            auto::candidates(
                &inner.registry.collections,
                &self.profile.state_dir.join("collections"),
            )
        };
        if candidates.is_empty() || *self.shutdown.borrow() {
            return auto::run(
                &self.auto_private,
                candidates,
                |_| async { Ok(()) },
                || true,
            )
            .await;
        }
        if self.sync_ctx().is_none() {
            // Signing in runs another pass.
            auto::defer(&self.auto_private, &candidates, "not_signed_in");
            return auto::Pass::default();
        }
        // Only for an account already moved to the new sync engine (the same
        // answer that permitted the takeover). It also checks the server is
        // reachable before a step that stops serving the folder while it adopts.
        match self.takeover_rollout().await {
            crate::takeover::RolloutGate::Allowed => {}
            crate::takeover::RolloutGate::Unknown => {
                auto::defer(&self.auto_private, &candidates, "sync_unreachable");
                return auto::Pass {
                    enabled: Vec::new(),
                    failed: candidates
                        .into_iter()
                        .map(|id| (id, "sync_unreachable".to_owned()))
                        .collect(),
                };
            }
            crate::takeover::RolloutGate::Legacy => {
                auto::defer(&self.auto_private, &candidates, "account_not_ready");
                return auto::Pass::default();
            }
        }
        let pass = auto::run(
            &self.auto_private,
            candidates,
            |id| async move {
                let enabled = self
                    .enable_sync(EnableSync {
                        collection: id.clone(),
                        // Private for a taken-over collection, or the mode an
                        // interrupted adopt journal was started with.
                        mode: None,
                        accept_takeover_holds: false,
                    })
                    .await;
                match enabled {
                    Ok(status) => {
                        self.account_keys.wake();
                        let mut e = crate::activity::ActivityEntry::now("sync_enabled");
                        e.collection = Some(id.clone());
                        e.collection_name = status
                            .get("name")
                            .and_then(Value::as_str)
                            .map(str::to_owned);
                        e.detail = status
                            .get("mode")
                            .and_then(Value::as_str)
                            .map(str::to_owned);
                        self.activity.record(e);
                        tracing::info!(collection = %id, "sync turned on for a taken-over collection");
                        Ok(())
                    }
                    Err(e) => {
                        let why = e.reason.unwrap_or(e.code);
                        tracing::info!(collection = %id, reason = %why, "taken-over collection not synced yet; retried later");
                        Err(why)
                    }
                }
            },
            || *self.shutdown.borrow(),
        )
        .await;
        self.bump();
        pass
    }

    /// Import old hosted mirrors' captured unsent edits into their collections
    /// once those are registered here and serving (`takeover::mirror_import`).
    /// Each pass is idempotent; one that cannot finish (offline, not yet joined)
    /// is simply repeated later.
    pub(super) async fn import_mirrors(&self) {
        use crate::takeover::mirror_import::{self, Capture, Progress};
        use crate::takeover::mirror_join;
        let paths = self.takeover_paths();
        let legacy = paths.legacy.clone();
        let Ok(ids) = mirror_import::captured(&legacy) else {
            return;
        };
        if ids.is_empty() {
            return;
        }
        // Only once the old engine is retired on this device: before that, an old
        // mirror could still upload the same edits itself.
        if !matches!(
            crate::takeover::record::Record::load(&paths.record),
            Ok(Some(r)) if r.state == crate::takeover::record::State::Complete
        ) {
            return;
        }
        for id in ids {
            // Bring the collection back here (the ordinary join), when due.
            let now = fsutil::now_ms() as u64;
            match mirror_join::step(&legacy, &id, &mut DaemonJoiner { d: self }, now).await {
                Ok(mirror_join::Step::Registered(_)) => {}
                Ok(mirror_join::Step::Removed | mirror_join::Step::NotDue) => continue,
                Ok(mirror_join::Step::Waiting { reason, .. }) => {
                    tracing::info!(collection = %id, %reason, "hosted collection not joined yet; its unsent edits stay captured");
                    continue;
                }
                Err(e) => {
                    tracing::warn!(collection = %id, error = %e, "joining the hosted collection paused; retried later");
                    continue;
                }
            }
            let complete = match (Capture::load(&legacy, &id), Progress::load(&legacy, &id)) {
                (Ok(Some(c)), Ok(p)) => p.complete(&c),
                _ => true, // unreadable: reported by status, never written over
            };
            if complete {
                continue;
            }
            let Ok(rt) = self.runtime_of(&id).await else {
                continue; // not caught up yet
            };
            if !self.mirror_cut_over(&legacy, &id).await {
                continue;
            }
            // Serialized with takeover runs and hold resolutions.
            let Ok(_run) = self.takeover.run.try_lock() else {
                continue;
            };
            let mut target = HostTarget { rt };
            match mirror_import::import(&legacy, &id, &mut target, &mut new_uuid_v7).await {
                Ok(pass) => {
                    if pass.settled > 0 {
                        tracing::info!(
                            collection = %id,
                            settled = pass.settled,
                            waiting = pass.waiting,
                            complete = pass.complete,
                            "unsent hosted mirror edits imported"
                        );
                        drop(_run);
                        self.bump();
                    }
                }
                Err(e) => {
                    tracing::warn!(collection = %id, error = %e, "unsent edit import paused; retried later")
                }
            }
        }
    }

    /// Whether a hosted collection's migration cutover is confirmed, so captured
    /// edits may be written to it. Checked once (then remembered), only for a
    /// collection that syncs with the hosted log, with backoff while pending.
    async fn mirror_cut_over(&self, legacy: &std::path::Path, id: &str) -> bool {
        use crate::takeover::mirror_join::{self, JoinState};
        let synced = {
            let inner = self.inner.lock().await;
            inner
                .registry
                .get(id)
                .is_some_and(|e| matches!(e.mode, SyncMode::Synced | SyncMode::SyncedE2e))
        };
        if !synced {
            return true;
        }
        let Ok(state) = JoinState::load(legacy, id) else {
            return false;
        };
        if state.cut_over {
            return true;
        }
        let now = fsutil::now_ms() as u64;
        if now < state.next_attempt_ms() {
            return false;
        }
        let reason = match self.read_migration_record(id).await {
            Ok(()) => return mirror_join::confirm_cut_over(legacy, id).is_ok(),
            Err(reason) => reason,
        };
        tracing::info!(collection = %id, %reason, "migration cutover not confirmed; unsent edits wait");
        let _ = mirror_join::cut_over_pending(legacy, id, &reason, now);
        false
    }

    /// Read the collection's migration record as this paired device. `Err` is a
    /// snake_case reason.
    async fn read_migration_record(&self, id: &str) -> Result<(), String> {
        let (ctx, _) = self.sync_parts().map_err(|e| e.reason.unwrap_or(e.code))?;
        let collection = crate::attest::uuid_bytes(id).ok_or("invalid_collection")?;
        let source = self
            .authority
            .source(mdbn_wire::common::B16(collection))
            .map_err(|_| "account_changed".to_string())?;
        let owner = source.active_account().ok_or("account_changed")?;
        let current = || {
            source
                .active_account()
                .filter(|a| a == &owner)
                .map(|_| ())
                .ok_or_else(|| "account_changed".to_string())
        };
        let tls = crate::cloud::tls_config().map_err(|_| "tls_unavailable".to_string())?;
        ctx.cloud
            .migration_record(&tls, id, id, &current)
            .await
            .map(|_| ())
            .map_err(|e| match e {
                crate::cloud::CloudError::Server(_, code) => code,
                crate::cloud::CloudError::Network(_) => "sync_unreachable".into(),
                crate::cloud::CloudError::RateLimited(_) => "rate_limited".into(),
                crate::cloud::CloudError::Unauthenticated => "not_signed_in".into(),
                crate::cloud::CloudError::Local(m) => m,
            })
    }

    /// Ask the existing authenticated rollout endpoint, never infer permission
    /// from finding old state. Caller holds account_gate through the takeover.
    /// Also records whether the account is (still, or again) on legacy Connect,
    /// so status can say why nothing moved.
    async fn takeover_rollout(&self) -> crate::takeover::RolloutGate {
        use crate::takeover::RolloutGate;
        let Some(inc) = self.authority.incarnation() else {
            return RolloutGate::Unknown;
        };
        let Ok(Some(cfg)) = crate::cloud::CloudConfig::load(&self.profile.cloud_file()) else {
            return RolloutGate::Unknown;
        };
        let Ok(record) = crate::cloud::AccountRecord::load(&self.profile.account_file()) else {
            return RolloutGate::Unknown;
        };
        if !record.permits(&cfg)
            || record.active_account() != Some(inc.account)
            || record.epoch != inc.epoch
        {
            return RolloutGate::Unknown;
        }
        let Ok(tls) = crate::cloud::tls_config() else {
            return RolloutGate::Unknown;
        };
        let Ok(cloud) = crate::cloud::Cloud::new(&tls, &cfg.server_url, self.secrets.as_ref())
        else {
            return RolloutGate::Unknown;
        };
        let current = || {
            (self.authority.incarnation() == Some(inc))
                .then_some(())
                .ok_or_else(|| "account_changed".to_owned())
        };
        let gate = match cloud.rollout(&tls, &current).await {
            Ok(r) => RolloutGate::from_rollout(&r),
            Err(_) => RolloutGate::Unknown,
        };
        if gate != RolloutGate::Unknown {
            self.takeover.account_legacy.store(
                gate == RolloutGate::Legacy,
                std::sync::atomic::Ordering::Relaxed,
            );
        }
        gate
    }

    /// Run (or resume) the local takeover, then register what it took over.
    /// Every run requires fresh server permission before the old connector is
    /// touched: the server only retires it for an upgraded account.
    pub(super) async fn takeover_run(
        self: Arc<Self>,
        stop_mirrors: bool,
        automatic: bool,
    ) -> Result<Value, ControlError> {
        let _run = self.takeover.run.lock().await;
        self.clone()
            .takeover_run_locked(stop_mirrors, automatic)
            .await
    }

    /// Caller holds `takeover.run`, including when retrying a waiting account.
    async fn takeover_run_locked(
        self: Arc<Self>,
        stop_mirrors: bool,
        automatic: bool,
    ) -> Result<Value, ControlError> {
        let Some(old) = crate::takeover::old_state_dir(&self.profile) else {
            return self.takeover_status().await;
        };
        if !old.join("connector.sqlite").is_file() && !self.takeover_paths().record.is_file() {
            return self.takeover_status().await;
        }
        let account_gate = self.account_gate.lock().await;
        let gate = self.takeover_rollout().await;
        if gate != crate::takeover::RolloutGate::Allowed {
            self.refence_old_service(old).await;
            let signed_in = self.authority.incarnation().is_some()
                && matches!(
                    crate::cloud::CloudConfig::load(&self.profile.cloud_file()),
                    Ok(Some(_))
                );
            let reason = if gate == crate::takeover::RolloutGate::Legacy {
                crate::takeover::WAIT_ACCOUNT_LEGACY
            } else if !signed_in {
                crate::takeover::WAIT_SIGN_IN
            } else {
                crate::takeover::WAIT_UNREACHABLE
            };
            *self
                .takeover
                .waiting_reason
                .lock()
                .unwrap_or_else(|p| p.into_inner()) = Some(reason);
            self.takeover
                .waiting_for_batch
                .store(true, std::sync::atomic::Ordering::Relaxed);
            self.takeover
                .retry
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .denied(std::time::Instant::now());
            if automatic {
                return self.takeover_status().await;
            }
            if reason == crate::takeover::WAIT_SIGN_IN {
                return Err(ControlError::new(
                    "unauthenticated",
                    "not_signed_in",
                    "Sign in to finish moving your collections (`mdbase account sign-in`). Nothing was changed.",
                ));
            }
            return Err(crate::takeover::not_allowed_error(
                gate == crate::takeover::RolloutGate::Legacy,
            ));
        }
        *self
            .takeover
            .waiting_reason
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = None;
        if self
            .takeover
            .waiting_for_batch
            .swap(false, std::sync::atomic::Ordering::Relaxed)
        {
            self.takeover
                .retry
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .reset();
        }
        let paths = self.takeover_paths();
        let isolated = self.profile.target == crate::paths::Target::IsolatedProfile;
        let opts = crate::takeover::Options {
            stop_mirrors,
            // Every run above passed fresh moved-account permission, including
            // an explicit retry. `automatic` changes refusal presentation only.
            account_moved: true,
            drain: crate::takeover::DRAIN,
            now: crate::takeover::now_rfc3339(),
            registered: registered_roots(&self.inner.lock().await.registry),
        };
        let p2 = paths.clone();
        let _own = self.takeover.holding_old_lock();
        let ran = self
            .run_blocking(move || {
                let mut old_service: Box<dyn mdbn_takeover::OldService> = if isolated {
                    Box::new(crate::service::legacy::ForegroundOldService(old.clone()))
                } else {
                    Box::new(crate::service::legacy::OldConnectorService::new())
                };
                crate::takeover::run(&p2, &old, old_service.as_mut(), &opts)
            })
            .await
            .ok_or_else(|| ControlError::internal("the takeover stopped"))?;
        let ran = match ran {
            Ok(r) => {
                *self
                    .takeover
                    .error
                    .lock()
                    .unwrap_or_else(|p| p.into_inner()) = None;
                r
            }
            Err(e) => {
                *self
                    .takeover
                    .error
                    .lock()
                    .unwrap_or_else(|p| p.into_inner()) = Some(e.to_string());
                return Err(ControlError::unavailable("takeover_failed", e.to_string()));
            }
        };
        {
            let mut retry = self
                .takeover
                .retry
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            if ran
                .record
                .as_ref()
                .is_some_and(|r| r.waiting_for_old_daemon())
            {
                retry.denied(std::time::Instant::now());
            } else {
                retry.reset();
            }
        }
        self.takeover
            .revived
            .store(ran.revived, std::sync::atomic::Ordering::Relaxed);
        if ran.revived {
            tracing::error!(
                "old_connector_revived: the old mdbase Connect daemon is running again"
            );
        }
        // add() serializes registration with account changes itself.
        drop(account_gate);
        for t in &ran.register {
            let now = crate::takeover::now_rfc3339();
            let known = self
                .inner
                .lock()
                .await
                .registry
                .get(&t.collection)
                .is_some();
            let outcome = if known {
                Ok(())
            } else {
                self.add_with_pause(
                    AddCollection {
                        path: t.root.clone(),
                        name: Some(t.name.clone()),
                        remove_legacy_identity: false,
                    },
                    t.paused,
                )
                .await
                .map(|_| ())
            };
            if outcome.is_ok() && !known {
                let mut e = crate::activity::ActivityEntry::now("collection_taken_over");
                e.collection = Some(t.collection.clone());
                e.collection_name = Some(t.name.clone());
                self.activity.record(e);
            }
            let saved = match outcome {
                Ok(()) => crate::takeover::mark_registered(&paths, &t.collection, &now),
                Err(e) => {
                    let why = e.reason.unwrap_or(e.code);
                    tracing::info!(collection = %t.collection, reason = %why, "taken-over collection not registered yet");
                    crate::takeover::note_registration(
                        &paths,
                        &t.collection,
                        &format!("registration_pending:{why}"),
                        &now,
                    )
                }
            };
            if let Err(e) = saved {
                tracing::warn!(error = %e, "takeover record not updated");
            }
        }
        self.retire_legacy().await;
        self.bump();
        self.takeover_status().await
    }

    /// Without a run, still keep a started takeover's old service stopped and
    /// report a revived old connector (the rollout gate only guards starting).
    async fn refence_old_service(&self, old: std::path::PathBuf) {
        let paths = self.takeover_paths();
        let isolated = self.profile.target == crate::paths::Target::IsolatedProfile;
        let fenced = self
            .run_blocking(move || {
                let mut old_service: Box<dyn mdbn_takeover::OldService> = if isolated {
                    Box::new(crate::service::legacy::ForegroundOldService(old.clone()))
                } else {
                    Box::new(crate::service::legacy::OldConnectorService::new())
                };
                crate::takeover::refence(&paths, &old, old_service.as_mut())
            })
            .await;
        match fenced {
            Some(Ok(Some(revived))) => {
                self.takeover
                    .revived
                    .store(revived, std::sync::atomic::Ordering::Relaxed);
                if revived {
                    tracing::error!(
                        "old_connector_revived: the old mdbase Connect daemon is running again"
                    );
                }
            }
            Some(Ok(None)) => {}
            Some(Err(e)) => tracing::warn!(error = %e, "could not re-fence the old connector"),
            None => tracing::warn!("could not re-fence the old connector: stopped"),
        }
    }

    /// Full-device retirement is independent of takeover success: until Connect
    /// confirms the exact old connector, status stays pending, never synthetic.
    async fn retire_legacy(&self) {
        let result = self.retire_legacy_inner().await;
        let value = match result {
            Ok(id) => json!({"retired":true,"legacy_connector_id":id}),
            Err(reason) => json!({"retired":false,"reason":reason}),
        };
        *self
            .takeover
            .retirement
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some(value);
    }

    async fn retire_legacy_inner(&self) -> Result<String, &'static str> {
        let _account_gate = self.account_gate.lock().await;
        let inc = self
            .authority
            .incarnation()
            .ok_or("retirement_account_missing")?;
        let cfg = crate::cloud::CloudConfig::load(&self.profile.cloud_file())
            .map_err(|_| "retirement_account_missing")?
            .ok_or("retirement_account_missing")?;
        let record = crate::cloud::AccountRecord::load(&self.profile.account_file())
            .map_err(|_| "retirement_account_missing")?;
        if !record.permits(&cfg)
            || record.active_account() != Some(inc.account)
            || record.epoch != inc.epoch
        {
            return Err("retirement_account_changed");
        }
        let connector = cfg
            .connector_id
            .as_deref()
            .ok_or("current_connector_missing")?;
        let paths = self.takeover_paths();
        let plan = crate::takeover::retirement::Plan::capture(&paths, connector)?;
        let isolated = self.profile.target == crate::paths::Target::IsolatedProfile;
        let p2 = plan.clone();
        let paths2 = paths.clone();
        let connector2 = connector.to_owned();
        let _own = self.takeover.holding_old_lock();
        let locks = self
            .run_blocking(move || {
                if !isolated {
                    crate::service::legacy::OldConnectorService::new()
                        .stop_and_disable()
                        .map_err(|_| "legacy_service_not_disabled")?;
                }
                let mut locks = vec![
                    mdbn_legacy::lock::try_exclusive(&mdbn_legacy::lock::daemon_lock_path(
                        &p2.old_state_dir,
                    ))
                    .map_err(|_| "legacy_lock_unavailable")?
                    .ok_or("old_connector_revived")?,
                ];
                for root in &p2.roots {
                    locks.push(
                        mdbn_legacy::lock::try_exclusive(&mdbn_legacy::lock::write_lock_path(root))
                            .map_err(|_| "legacy_lock_unavailable")?
                            .ok_or("legacy_folder_busy")?,
                    );
                }
                if !p2.still_current(&paths2, &connector2) {
                    return Err("retirement_source_changed");
                }
                Ok::<_, &'static str>(locks)
            })
            .await
            .ok_or("retirement_local_gate_failed")??;
        let current = || {
            if self.authority.incarnation() == Some(inc) && plan.still_current(&paths, connector) {
                Ok(())
            } else {
                Err("retirement_source_changed".into())
            }
        };
        let tls = crate::cloud::tls_config().map_err(|_| "retirement_endpoint_unavailable")?;
        let cloud = crate::cloud::Cloud::new(&tls, &cfg.server_url, self.secrets.as_ref())
            .map_err(|_| "retirement_account_missing")?;
        let result = cloud.retire_legacy_connector(&tls, &plan, &current).await;
        drop(locks);
        result.map_err(|e| match e {
            crate::cloud::CloudError::Server(404, _) | crate::cloud::CloudError::Network(_) => {
                "retirement_endpoint_unavailable"
            }
            _ => "retirement_not_confirmed",
        })?;
        Ok(plan.legacy_connector_id)
    }

    pub(super) async fn takeover_status(&self) -> Result<Value, ControlError> {
        let paths = self.takeover_paths();
        let record = crate::takeover::record::Record::load(&paths.record)
            .map_err(|e| ControlError::internal(format!("takeover record: {e}")))?;
        let mut holds = serde_json::Map::new();
        if let Some(r) = &record {
            for id in r.collections.keys() {
                // Open ones only: resolved holds are gone from the list.
                if let Ok(open) = crate::takeover::held::open(&paths.legacy, id)
                    && !open.is_empty()
                {
                    let open: Vec<Value> = open
                        .iter()
                        .map(|h| json!({"id": h.id, "path": h.path, "reason": h.cause}))
                        .collect();
                    holds.insert(id.clone(), json!(open));
                }
            }
        }
        let mut mirror_imports = serde_json::Map::new();
        for id in crate::takeover::mirror_import::captured(&paths.legacy).unwrap_or_default() {
            let entry = match crate::takeover::mirror_import::status(&paths.legacy, &id) {
                Ok(Some(mut v)) => {
                    let inner = self.inner.lock().await;
                    let registered = inner.registry.get(&id);
                    v["registered"] = json!(registered.is_some());
                    v["join"] = crate::takeover::mirror_join::status(&paths.legacy, &id)
                        .unwrap_or_else(|e| json!({"state": "error", "reason": e.to_string()}));
                    if let Some(e) = registered {
                        v["name"] = json!(e.name);
                        v["root"] = json!(e.root);
                    }
                    v
                }
                Ok(None) => continue,
                Err(e) => json!({"error": e.to_string()}),
            };
            mirror_imports.insert(id, entry);
        }
        Ok(json!({
            "record": record,
            "mirror_imports": mirror_imports,
            "revived": self.takeover.revived.load(std::sync::atomic::Ordering::Relaxed),
            "error": self.takeover.error.lock().unwrap_or_else(|p| p.into_inner()).clone(),
            "holds": holds,
            "held_interrupted_writes": record.as_ref().map(|r| r.held_interrupted_writes()).unwrap_or(0),
            "waiting_for_migration_batch": self.takeover.waiting_for_batch.load(std::sync::atomic::Ordering::Relaxed),
            "waiting_reason": *self.takeover.waiting_reason.lock().unwrap_or_else(|p| p.into_inner()),
            "account_legacy": self.takeover.account_legacy.load(std::sync::atomic::Ordering::Relaxed),
            "retirement": self.takeover.retirement.lock().unwrap_or_else(|p| p.into_inner()).clone(),
            "private_sync_pending": self.private_sync_pending().await,
        }))
    }

    /// Taken-over collections still waiting for Private sync, each with its last
    /// attempt's refusal reason (`null` before the first attempt finishes).
    async fn private_sync_pending(&self) -> Value {
        let inner = self.inner.lock().await;
        let ids = crate::auto_private::candidates(
            &inner.registry.collections,
            &self.profile.state_dir.join("collections"),
        );
        drop(inner);
        Value::Object(
            ids.into_iter()
                .map(|id| {
                    let reason = self.auto_private.failure(&id);
                    (id, json!({ "reason": reason }))
                })
                .collect(),
        )
    }
}

/// The device's own `collection.join`, as the mirror join drives it.
struct DaemonJoiner<'a> {
    d: &'a Daemon,
}

impl crate::takeover::mirror_join::Joiner for DaemonJoiner<'_> {
    async fn registered(&mut self, collection: &str) -> Option<std::path::PathBuf> {
        let inner = self.d.inner.lock().await;
        inner.registry.get(collection).map(|e| e.root.clone())
    }

    async fn join(
        &mut self,
        collection: &str,
        folder: &std::path::Path,
        name: &str,
    ) -> Result<(), crate::takeover::mirror_join::Refused> {
        self.d
            .join(JoinCollection {
                collection: collection.to_owned(),
                path: folder.to_path_buf(),
                name: Some(name.to_owned()),
                private: false,
            })
            .await
            .map(|_| ())
            .map_err(|e| crate::takeover::mirror_join::Refused(e.reason.unwrap_or(e.code)))
    }
}

/// The replica a mirror import writes to: a serving collection runtime, as the
/// hosting app (this device's own writes).
pub(super) struct HostTarget {
    pub(super) rt: Arc<crate::runtime::Runtime>,
}

fn import_io(e: ControlError) -> std::io::Error {
    std::io::Error::other(format!(
        "{}: {}",
        e.reason.as_deref().unwrap_or(&e.code),
        e.message
    ))
}

impl crate::takeover::mirror_import::Target for HostTarget {
    async fn get(
        &mut self,
        key: &str,
    ) -> std::io::Result<Option<crate::takeover::mirror_import::Current>> {
        use mdbn_wire::Wire;
        use mdbn_wire::cbor::Cbor;
        let include = mdbn_wire::client::Include {
            effective: None,
            body: None,
            document: Some(true),
            diagnostics: None,
        };
        let id = mdbn_legacy::is_uuid(key)
            .then(|| secrets::hex_decode(&key.replace('-', "")).ok())
            .flatten()
            .and_then(|v| <[u8; 16]>::try_from(v.as_slice()).ok());
        let reference = match id {
            Some(b) => mdbn_wire::common::B16(b).to_cbor(),
            None => Cbor::Text(key.into()),
        };
        let params = Cbor::Map(vec![
            (Cbor::Uint(0), reference),
            (Cbor::Uint(1), include.to_cbor()),
        ]);
        let view = match host_call(&self.rt, "get", params).await {
            Ok(v) => mdbn_wire::client::RecordView::from_cbor(&v)
                .map_err(|_| std::io::Error::other("the replica's record does not decode"))?,
            Err(e) if e.code == "not_found" => return Ok(None),
            Err(e) => return Err(import_io(e)),
        };
        let Some(document) = view.document else {
            return Err(std::io::Error::other("the replica returned no document"));
        };
        Ok(Some(crate::takeover::mirror_import::Current {
            id: view.id.0,
            path: view.path,
            revision: view.revision.0,
            document,
        }))
    }

    async fn submit(
        &mut self,
        ops: Vec<mdbn_wire::intent::Op>,
        mutation: [u8; 16],
    ) -> std::io::Result<crate::takeover::held::Outcome> {
        submit_as(&self.rt, ops, mutation).await.map_err(import_io)
    }

    async fn receipt(
        &mut self,
        mutation: [u8; 16],
    ) -> std::io::Result<Option<crate::takeover::held::Outcome>> {
        read_back(&self.rt, mutation).await.map_err(import_io)
    }
}

/// How often the daemon checks whether an old connector daemon has started.
const OLD_CONNECTOR_POLL: Duration = Duration::from_secs(5);

impl Daemon {
    /// Re-check, every [`OLD_CONNECTOR_POLL`], whether an old connector daemon runs.
    pub(super) async fn watch_old_connector(self: Arc<Self>) {
        loop {
            tokio::time::sleep(OLD_CONNECTOR_POLL).await;
            self.check_old_connector().await;
            self.clone().retry_takeover(false).await;
            self.import_mirrors().await;
        }
    }

    /// Probe the old connector's `daemon.lock`. When an old daemon starts, taken-over
    /// collections are closed (an old daemon from before the takeover marker check
    /// writes to them and takes no folder host lock); when it stops, they reopen.
    pub(super) async fn check_old_connector(&self) {
        let Some(old) = crate::takeover::old_state_dir(&self.profile) else {
            return;
        };
        // One non-blocking lock attempt on a local file.
        let Some(running) = self.takeover.probe_old_connector(&old) else {
            return;
        };
        let ordering = std::sync::atomic::Ordering::SeqCst;
        if self.takeover.old_running.load(ordering) == running {
            return;
        }
        let _gate = self.account_gate.lock().await;
        let mut inner = self.inner.lock().await;
        let inner = &mut *inner;
        self.takeover.old_running.store(running, ordering);
        if running {
            tracing::error!(
                "old_connector_running: the old mdbase Connect daemon is running; \
                 taken-over collections are closed until it stops"
            );
        } else {
            tracing::info!(
                "the old mdbase Connect daemon stopped; reopening taken-over collections"
            );
        }
        for h in inner.hosts.iter_mut() {
            if h.entry().origin != crate::registry::Origin::MigratedLocal {
                continue;
            }
            if running {
                h.close().await;
            }
            h.refresh();
            h.publish_grants(&inner.access);
        }
        drop(_gate);
        self.bump();
    }
}
