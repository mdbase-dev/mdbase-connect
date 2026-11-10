//! Account link: sign-in and sign-out, pairing, device registration and identity replacement, and the relay connection.

use super::*;

/// Resume only an atomically published account epoch; missing/error fence denies.
pub(super) async fn resume_relay(d: &Arc<Daemon>) {
    let _gate = d.account_gate.lock().await;
    let record = match crate::cloud::AccountRecord::load(&d.profile.account_file()) {
        Ok(record) => record,
        Err(e) => {
            tracing::warn!(error = %e, "account state unreadable");
            d.set_account_error("account_state");
            return;
        }
    };
    {
        let mut a = d.account.lock().unwrap_or_else(|p| p.into_inner());
        if a.epoch > record.epoch {
            return;
        }
        a.epoch = record.epoch;
    }
    if let Some(account) = record.account_id.as_deref().filter(|_| record.signed_in)
        && let Err(e) = d.use_identity_of(account).await
    {
        tracing::warn!(error = %e.message, "device identity unavailable for the account");
        d.set_account_error(e.reason.as_deref().unwrap_or("device_identity_missing"));
        return;
    }
    if let Ok(Some(cfg)) = crate::cloud::CloudConfig::load(&d.profile.cloud_file())
        && record.permits(&cfg)
    {
        d.drop_foreign_policy_cursor(cfg.connector_id.as_deref())
            .await;
    }
    start_relay_locked(d, &record);
}

/// Caller holds account_gate. No await between epoch check and task publication.
fn start_relay_locked(d: &Arc<Daemon>, record: &crate::cloud::AccountRecord) {
    let Ok(Some(cfg)) = crate::cloud::CloudConfig::load(&d.profile.cloud_file()) else {
        return;
    };
    if !record.permits(&cfg)
        || d.account.lock().unwrap_or_else(|p| p.into_inner()).epoch != record.epoch
    {
        return;
    }
    // Account state signed in by another environment's build (its credential and
    // connector belong to that control plane) never reconnects from this one.
    if crate::trust::sign_in_server(Some(&cfg.server_url)).as_deref() != Ok(cfg.server_url.as_str())
    {
        tracing::error!(server = %cfg.server_url, "account state is not this build's environment; relay not started");
        d.set_account_error("environment_mismatch");
        return;
    }
    let epoch = record.epoch;
    let Some(identity) = d.identity.get() else {
        return;
    };
    let tls = match crate::cloud::tls_config() {
        Ok(t) => t,
        Err(e) => {
            tracing::error!(error = %e, "TLS unavailable; relay not started");
            return;
        }
    };
    let cloud = match crate::cloud::Cloud::new(&tls, &cfg.server_url, d.secrets.as_ref()) {
        Ok(c) => Arc::new(c),
        Err(e) => {
            tracing::warn!(error = %e, "no account credential; relay not started");
            return;
        }
    };
    if d.authority
        .publish_account_identity(record, &cfg, &identity)
        .is_err()
    {
        return;
    }
    let d2 = d.clone();
    let stop = d.shutdown.subscribe();
    let task = d.spawn(async move {
        let mut cfg = cfg;
        if !cfg.device_registered {
            match d2.register_device(epoch, &cloud, &mut cfg, &identity).await {
                Registered::Yes => {}
                // Not fatal: the relay still serves grants; pipes wait for it.
                Registered::No => {
                    d2.retry_registration(epoch, cloud.clone(), cfg.clone(), identity.clone())
                }
                Registered::Stop => return,
            }
        }
        if let crate::relay::Ended::Terminal(why) =
            crate::relay::run(d2.clone(), cloud, cfg, identity, stop).await
        {
            d2.set_epoch_error(epoch, relay_stop_reason(&why));
        }
    });
    let mut a = d.account.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(old) = std::mem::replace(&mut a.relay, task) {
        old.abort();
    }
    a.signed_in = true;
}

/// The outcome of a device registration attempt.
enum Registered {
    Yes,
    /// Failed for now; retried in the background.
    No,
    /// Stale, signed out, or a new identity is being registered instead.
    Stop,
}

/// Device registration retries: 5 s doubling to a 5 minute cap, equal jitter.
fn registration_backoff(attempt: u32) -> Duration {
    let cap = (5_000u64 << attempt.saturating_sub(1).min(6)).min(300_000);
    let mut r = [0u8; 8];
    let _ = getrandom::fill(&mut r);
    Duration::from_millis(cap / 2 + u64::from_le_bytes(r) % (cap / 2 + 1))
}

/// A plain reason code for why the relay stopped for good.
fn relay_stop_reason(why: &str) -> &'static str {
    for reason in [
        "authentication_required",
        "incompatible_version",
        "policy_authority_mismatch",
    ] {
        if why.starts_with(reason) {
            return reason;
        }
    }
    "relay_stopped"
}

impl Daemon {
    /// Rename this computer in the account, then remember the stored name.
    pub(super) async fn rename_computer(&self, name: &str) -> Result<Value, ControlError> {
        let name = checked_name(name, "a computer name")?;
        let _gate = self.account_gate.lock().await;
        let path = self.profile.cloud_file();
        let mut cfg = crate::cloud::CloudConfig::load(&path)
            .map_err(|e| ControlError::unavailable("account_state", e.to_string()))?
            .ok_or_else(|| {
                ControlError::new(
                    "unauthenticated",
                    "not_signed_in",
                    "sign this computer in first",
                )
            })?;
        let ctx = self.sync_ctx().ok_or_else(|| {
            ControlError::new(
                "unauthenticated",
                "not_signed_in",
                "sign this computer in first",
            )
        })?;
        let stored = ctx.cloud.rename_self(&name).await.map_err(|e| match e {
            crate::cloud::CloudError::Unauthenticated => {
                ControlError::new("unauthenticated", "authentication_required", e.to_string())
            }
            e => ControlError::unavailable("account_unreachable", e.to_string()),
        })?;
        cfg.computer_name = Some(stored.clone());
        cfg.save(&path)
            .map_err(|e| ControlError::unavailable("account_state", e.to_string()))?;
        drop(_gate);
        self.bump();
        Ok(json!({ "name": stored }))
    }

    /// The apps approved anywhere in the account. A read: no account gate, no
    /// status bump, no activity entry.
    pub(super) async fn account_applications(&self) -> Result<Value, ControlError> {
        let ctx = self.sync_ctx().ok_or_else(|| {
            ControlError::new(
                "unauthenticated",
                "not_signed_in",
                "sign this computer in first",
            )
        })?;
        let applications = ctx
            .cloud
            .account_applications()
            .await
            .map_err(|e| match e {
                crate::cloud::CloudError::Unauthenticated => {
                    ControlError::new("unauthenticated", "authentication_required", e.to_string())
                }
                e => ControlError::unavailable("account_unreachable", e.to_string()),
            })?;
        Ok(json!({ "applications": applications }))
    }

    fn set_account_error(&self, e: &str) {
        self.account
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .last_error = Some(e.to_string());
        self.bump();
    }

    /// Ask the control plane to revoke a grant the user refused here, so it leaves
    /// the feed. Best effort: the local refusal already holds (sticky tombstone).
    pub(super) fn revoke_upstream(&self, grant: String) {
        let Ok(Some(cfg)) = crate::cloud::CloudConfig::load(&self.profile.cloud_file()) else {
            return;
        };
        let Ok(tls) = crate::cloud::tls_config() else {
            return;
        };
        let Ok(cloud) = crate::cloud::Cloud::new(&tls, &cfg.server_url, self.secrets.as_ref())
        else {
            return;
        };
        self.spawn(async move {
            if let Err(e) = cloud.revoke_grant(&grant).await {
                tracing::warn!(error = %e, "upstream revocation failed; the local refusal holds");
            }
        });
    }

    fn set_epoch_error(&self, epoch: u64, error: &str) {
        let mut a = self.account.lock().unwrap_or_else(|p| p.into_inner());
        if a.epoch == epoch {
            a.pairing_allowed = false;
            a.pairing = None;
            a.last_error = Some(error.into());
            drop(a);
            self.bump();
        }
    }

    // Caller holds account_gate. Invalidate before cleanup; never silently report
    // success on a failed fence/keychain/config/access persistence operation.
    async fn invalidate_account(
        &self,
        remove_cloud: impl FnOnce(&std::path::Path) -> std::io::Result<()>,
    ) -> Result<u64, ControlError> {
        use crate::cloud::AccountRecord;
        let previous = AccountRecord::load(&self.profile.account_file());
        let (epoch, exhausted) = {
            let mut a = self.account.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(t) = a.pairing_task.take() {
                t.abort();
            }
            for t in [a.relay.take(), a.registration.take()]
                .into_iter()
                .flatten()
            {
                t.abort();
            }
            let high = a.epoch.max(previous.as_ref().map(|r| r.epoch).unwrap_or(0));
            let next = high.checked_add(1);
            let epoch = next.unwrap_or(high);
            *a = Account {
                epoch,
                ..Account::default()
            };
            (epoch, next.is_none())
        };
        self.authority.invalidate(epoch);
        self.online
            .store(false, std::sync::atomic::Ordering::Relaxed);
        let fence = previous.and_then(|_| {
            if exhausted {
                return Err(crate::cloud::CloudError::Local(
                    "account epoch exhausted".into(),
                ));
            }
            AccountRecord {
                schema_version: 1,
                epoch,
                signed_in: false,
                connector_id: None,
                account_id: None,
            }
            .save(&self.profile.account_file())
        });
        let access = {
            let mut inner = self.inner.lock().await;
            inner.access.leases.clear();
            inner.access.monotonic_leases.clear();
            inner.access.feed_cursor = None;
            // Nothing is served under cached grants once signed out, and no
            // session (host ones included) outlives the account epoch: runtimes
            // close and reopen with a new source after the next sign-in.
            for h in inner.hosts.iter_mut() {
                h.close().await;
                h.refresh();
            }
            inner.access.save(&self.profile.access_file())
        };
        let token = self.secrets.delete(crate::cloud::CONNECTOR_TOKEN);
        let cloud = remove_cloud(&self.profile.cloud_file());
        self.bump();
        let error = fence
            .err()
            .map(|e| e.to_string())
            .or_else(|| access.err().map(|e| e.to_string()))
            .or_else(|| token.err().map(|e| e.to_string()))
            .or_else(|| {
                cloud
                    .err()
                    .filter(|e| e.kind() != std::io::ErrorKind::NotFound)
                    .map(|e| e.to_string())
            });
        if let Some(error) = error {
            self.set_epoch_error(epoch, "account_cleanup_failed");
            return Err(ControlError::unavailable("account_cleanup_failed", error));
        }
        Ok(epoch)
    }

    /// Sign-out and sign-in clear the saved policy cursor. One naming another
    /// connector (left by an interrupted cleanup) would stop the relay for good,
    /// so it is dropped with its leases, as sign-out does: nothing is served
    /// until this connector's first policy snapshot. Caller holds account_gate.
    async fn drop_foreign_policy_cursor(&self, connector: Option<&str>) {
        let mut inner = self.inner.lock().await;
        if inner
            .access
            .feed_cursor
            .as_ref()
            .is_none_or(|c| Some(c.connector.as_str()) == connector)
        {
            return;
        }
        inner.access.leases.clear();
        inner.access.monotonic_leases.clear();
        inner.access.feed_cursor = None;
        self.authority.publish_access(&inner.access);
        if let Err(e) = inner.access.save(&self.profile.access_file()) {
            tracing::warn!(error = %e, "access list not saved after dropping an old policy cursor");
        }
        tracing::info!("dropped a policy cursor from a previous sign-in");
    }

    pub(super) async fn begin_pairing(&self) -> Result<u64, ControlError> {
        let _gate = self.account_gate.lock().await;
        let epoch = self
            .invalidate_account(|path| std::fs::remove_file(path))
            .await?;
        self.account
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .pairing_allowed = true;
        Ok(epoch)
    }

    pub(super) async fn publish_pairing(
        self: &Arc<Self>,
        epoch: u64,
        cfg: crate::cloud::CloudConfig,
        account_id: &str,
        token: &[u8],
    ) -> Result<(), ControlError> {
        let _gate = self.account_gate.lock().await;
        let record = crate::cloud::AccountRecord::load(&self.profile.account_file())
            .map_err(|e| ControlError::unavailable("account_state", e.to_string()))?;
        let allowed = {
            let a = self.account.lock().unwrap_or_else(|p| p.into_inner());
            a.epoch == epoch && a.pairing_allowed
        };
        if !allowed
            || cfg.connector_id.is_none()
            || record.epoch != epoch
            || record.signed_in
            || cfg.account_epoch != epoch
        {
            return Err(ControlError::unavailable(
                "sign_in_cancelled",
                "account generation changed",
            ));
        }
        crate::authority::account_id(account_id).ok_or_else(|| {
            ControlError::unavailable(
                "account_identity_missing",
                "pairing did not provide a canonical account UUID",
            )
        })?;
        // This account's own device identity, before anything is published for it.
        self.use_identity_of(account_id).await?;
        // The durable fence is still signed out throughout partial publication.
        self.secrets
            .set(crate::cloud::CONNECTOR_TOKEN, token)
            .map_err(|e| ControlError::unavailable("account_state", e.to_string()))?;
        cfg.save(&self.profile.cloud_file())
            .map_err(|e| ControlError::unavailable("account_state", e.to_string()))?;
        let active = crate::cloud::AccountRecord {
            schema_version: 1,
            epoch,
            signed_in: true,
            connector_id: cfg.connector_id.clone(),
            account_id: Some(account_id.into()),
        };
        active
            .save(&self.profile.account_file())
            .map_err(|e| ControlError::unavailable("account_state", e.to_string()))?;
        if let Some(identity) = self.identity.get() {
            self.authority
                .publish_account_identity(&active, &cfg, &identity)
                .map_err(|reason| {
                    ControlError::unavailable(
                        reason.reason(),
                        "account authority publication failed",
                    )
                })?;
        }
        {
            let mut a = self.account.lock().unwrap_or_else(|p| p.into_inner());
            a.signed_in = true;
            a.pairing_allowed = false;
            a.pairing = None;
            a.pairing_task = None;
            a.last_error = None;
        }
        start_relay_locked(self, &active);
        self.reopen_hosts().await;
        self.bump();
        tracing::info!("signed in");
        Ok(())
    }

    /// Use `account`'s own device identity from now on. Caller holds account_gate,
    /// with no account published (sign-in) or the same account (reopen). An identity
    /// nothing has claimed yet is claimed for this account, unless collections here
    /// show it is another account's; another account's identity is set aside for
    /// it, never used for this one.
    async fn use_identity_of(&self, account: &str) -> Result<(), ControlError> {
        let store_error = |e: secrets::SecretError| {
            ControlError::unavailable("credential_store_unavailable", e.to_string())
        };
        let file = self.profile.identity_file();
        let current = self.identity.get().ok_or_else(|| {
            ControlError::unavailable("device_identity_missing", "keychain device unavailable")
        })?;
        let owner = match secrets::identity_account(&file).map_err(store_error)? {
            Some(owner) => owner,
            None => match self.unclaimed_owner(current.device_id, account).await {
                Some(other) => other,
                None => {
                    return secrets::bind_identity(self.secrets.as_ref(), &file, &current, account)
                        .map_err(store_error);
                }
            },
        };
        if owner == account {
            return Ok(());
        }
        let next = secrets::switch_identity(
            self.secrets.as_ref(),
            &file,
            &current,
            Some(&owner),
            account,
            false,
        )
        .map_err(store_error)?;
        tracing::info!("using this account's own device identity");
        self.activate_identity(next).await;
        Ok(())
    }

    /// The account an identity from before identities were per account belongs to,
    /// when collections registered here with it say it is not `account`'s.
    async fn unclaimed_owner(&self, device: [u8; 16], account: &str) -> Option<String> {
        let device = secrets::uuid_string(&device);
        let inner = self.inner.lock().await;
        let owners: Vec<&str> = inner
            .registry
            .collections
            .iter()
            .filter(|e| e.device.as_deref() == Some(device.as_str()))
            .filter_map(|e| e.owner_account.as_deref())
            .collect();
        if owners.contains(&account) {
            return None;
        }
        owners.first().map(|o| o.to_string())
    }

    /// Another account that registered collections here with `device`.
    async fn other_owner(&self, device: [u8; 16], account: &str) -> Option<String> {
        let device = secrets::uuid_string(&device);
        self.inner
            .lock()
            .await
            .registry
            .collections
            .iter()
            .filter(|e| e.device.as_deref() == Some(device.as_str()))
            .filter_map(|e| e.owner_account.clone())
            .find(|o| o != account)
    }

    /// Serve with `identity`: status, hosts opened from now on, the relay started
    /// next, and the localhost link (restarted, as its Noise key changed).
    async fn activate_identity(&self, identity: DeviceIdentity) {
        let public = identity.public();
        let identity = Arc::new(identity);
        self.identity.set(identity.clone());
        self.inner.lock().await.device = Some(public);
        let old = self.link.lock().unwrap_or_else(|p| p.into_inner()).take();
        let Some(old) = old else {
            return;
        };
        old.stop();
        let Some(d) = self.self_weak.get().and_then(std::sync::Weak::upgrade) else {
            return;
        };
        match crate::link::Link::start(self.profile.local_link_file(), identity, d).await {
            Ok(l) => *self.link.lock().unwrap_or_else(|p| p.into_inner()) = Some(l),
            Err(e) => tracing::warn!(error = %e, "localhost link unavailable"),
        }
    }

    /// One device registration attempt for this sign-in.
    async fn register_device(
        self: &Arc<Self>,
        epoch: u64,
        cloud: &crate::cloud::Cloud,
        cfg: &mut crate::cloud::CloudConfig,
        identity: &Arc<DeviceIdentity>,
    ) -> Registered {
        let Some(cid) = cfg.connector_id.clone() else {
            self.set_registration_error(epoch, Some("sign_in_required"));
            return Registered::Stop;
        };
        match cloud.register_device(&cid, identity).await {
            Ok(()) => {
                cfg.device_registered = true;
                if let Err(e) = self.save_registered(epoch, cfg).await {
                    self.set_epoch_error(epoch, e.reason.as_deref().unwrap_or("account_state"));
                    return Registered::Stop;
                }
                self.set_registration_error(epoch, None);
                tracing::info!("device registered with the account");
                Registered::Yes
            }
            // This identity can never be this account's device here: the account
            // removed this computer, or the device is another account's. Register a
            // new device instead (once per sign-in); Private collections approve it
            // as they approve any new device.
            Err(crate::cloud::CloudError::Server(409, code))
                if code == "device_removed" || code == "device_already_bound" =>
            {
                tracing::warn!(reason = %code, "device registration refused; registering a new device");
                if self.begin_identity_replacement(epoch) {
                    let other = code == "device_already_bound";
                    self.spawn(
                        self.clone()
                            .replace_identity(epoch, identity.device_id, other),
                    );
                    return Registered::Stop;
                }
                self.set_registration_error(epoch, Some("device_registration_failed"));
                Registered::No
            }
            Err(crate::cloud::CloudError::Unauthenticated) => {
                self.set_registration_error(epoch, Some("authentication_required"));
                Registered::Stop
            }
            Err(e) => {
                tracing::warn!(error = %e, "device registration failed");
                self.set_registration_error(epoch, Some("device_registration_failed"));
                Registered::No
            }
        }
    }

    /// Keep registering in the background with capped, jittered backoff, then
    /// restart the relay so it binds the device.
    fn retry_registration(
        self: &Arc<Self>,
        epoch: u64,
        cloud: Arc<crate::cloud::Cloud>,
        mut cfg: crate::cloud::CloudConfig,
        identity: Arc<DeviceIdentity>,
    ) {
        let d = self.clone();
        let mut stop = self.shutdown.subscribe();
        let Some(task) = self.spawn(async move {
            let mut attempt = 0u32;
            loop {
                attempt = attempt.saturating_add(1);
                tokio::select! {
                    _ = tokio::time::sleep(registration_backoff(attempt)) => {}
                    _ = stop.wait_for(|s| *s) => return,
                }
                if d.account.lock().unwrap_or_else(|p| p.into_inner()).epoch != epoch {
                    return;
                }
                match d.register_device(epoch, &cloud, &mut cfg, &identity).await {
                    Registered::No => continue,
                    Registered::Stop => return,
                    Registered::Yes => {
                        let _gate = d.account_gate.lock().await;
                        if let Ok(record) =
                            crate::cloud::AccountRecord::load(&d.profile.account_file())
                            && record.epoch == epoch
                            && d.account.lock().unwrap_or_else(|p| p.into_inner()).epoch == epoch
                        {
                            start_relay_locked(&d, &record);
                        }
                        return;
                    }
                }
            }
        }) else {
            return;
        };
        let mut a = self.account.lock().unwrap_or_else(|p| p.into_inner());
        if a.epoch != epoch {
            task.abort();
        } else if let Some(old) = a.registration.replace(task) {
            old.abort();
        }
    }

    fn set_registration_error(&self, epoch: u64, reason: Option<&str>) {
        let mut a = self.account.lock().unwrap_or_else(|p| p.into_inner());
        if a.epoch == epoch && a.registration_error.as_deref() != reason {
            a.registration_error = reason.map(str::to_string);
            drop(a);
            self.bump();
        }
    }

    fn begin_identity_replacement(&self, epoch: u64) -> bool {
        let mut a = self.account.lock().unwrap_or_else(|p| p.into_inner());
        if a.epoch != epoch || a.identity_replaced {
            return false;
        }
        a.identity_replaced = true;
        true
    }

    /// The account refused this computer's device (`refused`). Mint a new identity
    /// for the account, move the account's local-only collections here to it, and
    /// sign in again with it under a new account epoch, so nothing that used the old
    /// identity carries on. Collections synced with the old device are not reused:
    /// this computer joins them again as a new device. When the refused device is
    /// another account's (`other`), it is kept for that account.
    async fn replace_identity(self: Arc<Self>, epoch: u64, refused: [u8; 16], other: bool) {
        let _gate = self.account_gate.lock().await;
        let (Ok(record), Ok(Some(mut cfg))) = (
            crate::cloud::AccountRecord::load(&self.profile.account_file()),
            crate::cloud::CloudConfig::load(&self.profile.cloud_file()),
        ) else {
            return;
        };
        let Some(current) = self.identity.get().filter(|i| i.device_id == refused) else {
            return;
        };
        let (Some(account), Some(next)) = (record.account_id.clone(), epoch.checked_add(1)) else {
            return;
        };
        if record.epoch != epoch
            || !record.permits(&cfg)
            || self.account.lock().unwrap_or_else(|p| p.into_inner()).epoch != epoch
        {
            return;
        }
        let keep = if other {
            self.other_owner(refused, &account).await
        } else {
            None
        };
        let fresh = match secrets::switch_identity(
            self.secrets.as_ref(),
            &self.profile.identity_file(),
            &current,
            keep.as_deref(),
            &account,
            true,
        ) {
            Ok(id) => id,
            Err(e) => {
                tracing::warn!(error = %e, "could not store a new device identity");
                self.set_registration_error(epoch, Some("credential_store_unavailable"));
                return;
            }
        };
        let device = secrets::uuid_string(&fresh.device_id);
        // Fence everything that captured this epoch or the old identity.
        {
            let mut a = self.account.lock().unwrap_or_else(|p| p.into_inner());
            for t in [a.relay.take(), a.registration.take()]
                .into_iter()
                .flatten()
            {
                t.abort();
            }
            a.epoch = next;
            a.registration_error = None;
        }
        self.authority.invalidate(next);
        self.online
            .store(false, std::sync::atomic::Ordering::Relaxed);
        {
            let mut inner = self.inner.lock().await;
            for h in inner.hosts.iter_mut() {
                h.close().await;
                h.refresh();
            }
            let old = secrets::uuid_string(&refused);
            let mut registry = inner.registry.clone();
            for e in registry.collections.iter_mut().filter(|e| {
                e.mode == SyncMode::Local
                    && e.owner_account.as_deref() == Some(account.as_str())
                    && e.device.as_deref() == Some(old.as_str())
            }) {
                e.device = Some(device.clone());
            }
            if registry != inner.registry {
                match self.save_registry(&registry) {
                    Ok(()) => {
                        inner.registry = registry;
                        self.authority.publish_registry(&inner.registry);
                    }
                    Err(e) => {
                        tracing::warn!(error = %e.message, "local collections not moved to the new device")
                    }
                }
            }
        }
        self.activate_identity(fresh).await;
        cfg.account_epoch = next;
        cfg.device_registered = false;
        let active = crate::cloud::AccountRecord {
            epoch: next,
            ..record
        };
        if let Err(e) = cfg
            .save(&self.profile.cloud_file())
            .map_err(|e| e.to_string())
            .and_then(|()| {
                active
                    .save(&self.profile.account_file())
                    .map_err(|e| e.to_string())
            })
        {
            tracing::warn!(error = %e, "account state not saved after a new device identity");
            self.set_epoch_error(next, "account_state");
            return;
        }
        let Some(identity) = self.identity.get() else {
            return;
        };
        if let Err(reason) = self
            .authority
            .publish_account_identity(&active, &cfg, &identity)
        {
            self.set_epoch_error(next, reason.reason());
            return;
        }
        self.authority
            .publish_access(&self.inner.lock().await.access);
        start_relay_locked(&self, &active);
        self.reopen_hosts().await;
        self.bump();
        tracing::info!("registering this computer again as a new device");
    }

    pub(super) async fn save_registered(
        &self,
        epoch: u64,
        cfg: &crate::cloud::CloudConfig,
    ) -> Result<(), ControlError> {
        let _gate = self.account_gate.lock().await;
        let record = crate::cloud::AccountRecord::load(&self.profile.account_file())
            .map_err(|e| ControlError::unavailable("account_state", e.to_string()))?;
        if self.account.lock().unwrap_or_else(|p| p.into_inner()).epoch != epoch
            || !record.permits(cfg)
        {
            return Err(ControlError::unavailable(
                "sign_in_cancelled",
                "account generation changed",
            ));
        }
        cfg.save(&self.profile.cloud_file())
            .map_err(|e| ControlError::unavailable("account_state", e.to_string()))
    }

    pub(super) async fn sign_in(self: &Arc<Self>, req: &Request) -> Result<Value, ControlError> {
        // The build's environment decides the control plane: the default, and the
        // only one accepted.
        let server =
            crate::trust::sign_in_server(req.params.get("server_url").and_then(Value::as_str))
                .map_err(|e| ControlError::invalid("server_url", e))?;
        let name = req
            .params
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("mdbase on this computer")
            .to_string();
        let tls = crate::cloud::tls_config()
            .map_err(|e| ControlError::unavailable("tls", e.to_string()))?;
        // Capture the epoch BEFORE any network await, including pairing_start.
        let epoch = self.begin_pairing().await?;
        let pairing = match crate::cloud::pairing_start(&tls, &server, &name).await {
            Ok(p) => p,
            Err(e) => {
                self.set_epoch_error(epoch, "sign_in_failed");
                return Err(ControlError::unavailable("sign_in_failed", e.to_string()));
            }
        };
        let _gate = self.account_gate.lock().await;
        let allowed = {
            let a = self.account.lock().unwrap_or_else(|p| p.into_inner());
            a.epoch == epoch && a.pairing_allowed
        };
        if !allowed {
            return Err(ControlError::unavailable(
                "sign_in_cancelled",
                "account generation changed",
            ));
        }
        self.account
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .pairing = Some(pairing.verification_uri.clone());
        let d = self.clone();
        let p2 = pairing.clone();
        let computer_name = name.clone();
        let task = self.spawn(async move {
            let deadline =
                tokio::time::Instant::now() + Duration::from_secs(p2.expires_in.min(3600));
            let result = loop {
                if tokio::time::Instant::now() > deadline {
                    break Err("sign_in_expired");
                }
                match crate::cloud::pairing_exchange(&tls, &server, &p2).await {
                    Ok(Some(done)) => break Ok(done),
                    Ok(None) => tokio::time::sleep(Duration::from_millis(1500)).await,
                    Err(e) => {
                        tracing::warn!(error = %e, "sign-in failed");
                        break Err("sign_in_failed");
                    }
                }
            };
            match result {
                Err(reason) => d.set_epoch_error(epoch, reason),
                Ok(paired) => {
                    let cfg = crate::cloud::CloudConfig {
                        schema_version: 1,
                        account_epoch: epoch,
                        server_url: server,
                        connector_id: Some(paired.connector_id),
                        computer_name: Some(computer_name),
                        ..Default::default()
                    };
                    if let Err(e) = d
                        .publish_pairing(epoch, cfg, &paired.account_id, paired.token.as_bytes())
                        .await
                    {
                        tracing::warn!(error = %e.message, "sign-in not published");
                        d.set_epoch_error(epoch, e.reason.as_deref().unwrap_or("sign_in_failed"));
                    } else {
                        d.activity
                            .record(crate::activity::ActivityEntry::now("signed_in"));
                        // Taken-over collections wait for an account to register.
                        d.spawn(d.clone().takeover_task(false));
                    }
                }
            }
        });
        self.account
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .pairing_task = task;
        self.bump();
        Ok(
            json!({ "verification_uri": pairing.verification_uri, "expires_in": pairing.expires_in }),
        )
    }

    pub(super) async fn sign_out(&self) -> Result<Value, ControlError> {
        self.sign_out_with_remove(|path| std::fs::remove_file(path))
            .await
    }

    pub(super) async fn sign_out_with_remove(
        &self,
        remove: impl FnOnce(&std::path::Path) -> std::io::Result<()>,
    ) -> Result<Value, ControlError> {
        let _gate = self.account_gate.lock().await;
        self.invalidate_account(remove).await?;
        tracing::info!("signed out");
        Ok(json!({}))
    }
}
