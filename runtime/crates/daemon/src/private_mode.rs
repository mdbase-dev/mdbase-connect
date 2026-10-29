//! Native projection of a replica-verified private choice. The private sidecar
//! closes the crash gap between sync.json and the registration; it is not remote
//! policy authority. Private/receiver projections require committed acceptance;
//! explicit owner Cloud intent commits both host files before core source consent.
use super::*;
use crate::runtime::{AccountKeyGuard, PrivateSwitchOp};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[cfg(test)]
#[path = "private_mode_tests.rs"]
mod tests;

const FILE: &str = "verified-private-choice.json";
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Choice {
    collection: String,
    account: String,
    device: String,
    genesis: String,
    signer: String,
    trusted_signers: Vec<String>,
    #[serde(default)]
    cloud_copy: bool,
    #[serde(default)]
    receiver_read: bool,
}
fn load(path: &Path) -> Result<Option<Choice>, String> {
    let Some(bytes) = crate::fsutil::read_optional(path).map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    crate::fsutil::verify_owner_only(path).map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| "private choice is malformed".into())
}

/// Replay at startup before opening any host. Either file may already have been
/// written; the same identity/genesis-bound choice is idempotently applied again.
pub(super) fn replay(
    profile: &Profile,
    registry: &mut Registry,
    trust: &crate::trust::Trust,
) -> Result<(), String> {
    for entry in registry.collections.clone() {
        let dir = profile.state_dir.join("collections").join(&entry.id);
        let journal = dir.join(FILE);
        let Some(choice) = load(&journal)? else {
            continue;
        };
        if choice.collection != entry.id
            || Some(choice.account.as_str()) != entry.owner_account.as_deref()
            || Some(choice.device.as_str()) != entry.device.as_deref()
            || !matches!(entry.mode, SyncMode::Synced | SyncMode::SyncedE2e)
            || crate::attest::uuid_bytes(&choice.signer).is_none_or(|id| id == [0; 16])
        {
            return Err("private choice differs from local registration".into());
        }
        let collection = crate::attest::uuid_bytes(&entry.id).ok_or("collection identifier")?;
        let path = dir.join(crate::sync::FILE);
        let mut cfg = crate::sync::SyncConfig::load(&path)
            .map_err(|e| e.0)?
            .ok_or("missing sync link")?;
        cfg.validate(&collection, trust).map_err(|e| e.0)?;
        if cfg.genesis_hash != choice.genesis {
            return Err("private choice differs from pinned genesis".into());
        }
        cfg.chosen_state = if choice.cloud_copy {
            "cloud_copy"
        } else {
            "private"
        }
        .into();
        cfg.user_enabled_cloud_copy = choice.cloud_copy;
        for signer in choice.trusted_signers {
            if crate::attest::uuid_bytes(&signer).is_none_or(|id| id == [0; 16]) {
                return Err("invalid private signer".into());
            }
            if !cfg.trusted_signers.contains(&signer) {
                cfg.trusted_signers.push(signer);
            }
        }
        cfg.save(&path, &collection, trust).map_err(|e| e.0)?;
        let mut next = registry.clone();
        let changed = next.get_mut(&entry.id).ok_or("registration disappeared")?;
        changed.mode = if choice.cloud_copy {
            SyncMode::Synced
        } else {
            SyncMode::SyncedE2e
        };
        changed.ever_e2e |= !choice.cloud_copy;
        next.save(&profile.registry_file())
            .map_err(|e| e.to_string())?;
        *registry = next;
        // Cloud consent is enabled in the actor only AFTER both files commit.
        // Keep its explicit user intent until that actor operation succeeds.
        if !choice.cloud_copy || choice.receiver_read {
            std::fs::remove_file(&journal).map_err(|e| e.to_string())?;
            crate::fsutil::sync_dir(&dir).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn persist(
    profile: &Profile,
    registry: &mut Registry,
    trust: &crate::trust::Trust,
    dir: &Path,
    choice: &Choice,
) -> Result<(), String> {
    let path = dir.join(FILE);
    if let Some(old) = load(&path)? {
        if old.collection != choice.collection
            || old.account != choice.account
            || old.device != choice.device
            || old.genesis != choice.genesis
        {
            return Err("mode choice differs from local identity".into());
        }
        if old != *choice && !old.receiver_read && (!choice.cloud_copy || old.cloud_copy) {
            return Err("different mode choice is already pending".into());
        }
    }
    crate::fsutil::write_atomic(
        &path,
        &serde_json::to_vec(choice).map_err(|_| "mode choice encoding")?,
    )
    .map_err(|e| e.to_string())?;
    replay(profile, registry, trust)
}

impl Daemon {
    /// Persist both host files BEFORE the core consent can authorize key release.
    /// A retained owner-only journal resumes this ordering after either crash gap.
    pub(super) async fn choose_cloud_copy_locally(
        &self,
        id: &str,
        runtime: &crate::runtime::Runtime,
        guard: AccountKeyGuard,
        generation: mdbn_wire::common::B32,
    ) -> Result<(), crate::control::ControlError> {
        use crate::control::ControlError;
        let Some(Ok(Some(device))) = runtime
            .private_switch(PrivateSwitchOp::CloudCandidate, guard.clone())
            .await
        else {
            return Err(ControlError::unavailable(
                "keyed_owner_required",
                "use an owner device holding this collection's trusted key",
            ));
        };
        let signers = runtime
            .private_switch_signers(guard.clone())
            .await
            .ok_or_else(|| ControlError::unavailable("account_changed", "account changed"))?;
        let trust = self
            .trust
            .as_ref()
            .ok_or_else(|| ControlError::unavailable("not_ready", "trust is unavailable"))?;
        let choice = {
            let mut inner = self.inner.lock().await;
            if !guard() {
                return Err(ControlError::unavailable(
                    "account_changed",
                    "account changed",
                ));
            }
            let entry = inner.registry.get(id).cloned().ok_or_else(|| {
                ControlError::unavailable("not_registered", "collection not registered")
            })?;
            let dir = self.profile.state_dir.join("collections").join(id);
            let result = (|| {
                let collection = crate::attest::uuid_bytes(id).ok_or("collection identifier")?;
                let cfg = crate::sync::SyncConfig::load(&dir.join(crate::sync::FILE))
                    .map_err(|e| e.0)?
                    .ok_or("missing sync link")?;
                cfg.validate(&collection, trust).map_err(|e| e.0)?;
                let account = self
                    .authority
                    .source(mdbn_wire::common::B16(collection))
                    .ok()
                    .and_then(|source| source.active_account())
                    .ok_or("active account missing")?;
                if entry.owner_account.as_deref() != Some(account.to_uuid_string().as_str())
                    || self
                        .identity
                        .get()
                        .is_none_or(|identity| identity.device_id != device.0)
                {
                    return Err("mode choice differs from active identity".into());
                }
                if entry.device.as_deref() != Some(device.to_uuid_string().as_str()) {
                    return Err("mode device differs from registration".into());
                }
                let fresh = Choice {
                    collection: id.into(),
                    account: entry
                        .owner_account
                        .clone()
                        .ok_or("registration account missing")?,
                    device: device.to_uuid_string(),
                    genesis: cfg.genesis_hash,
                    signer: device.to_uuid_string(),
                    trusted_signers: signers.iter().map(|id| id.to_uuid_string()).collect(),
                    cloud_copy: true,
                    receiver_read: false,
                };
                let choice = match load(&dir.join(FILE))? {
                    Some(pending)
                        if pending.cloud_copy
                            && pending.collection == fresh.collection
                            && pending.account == fresh.account
                            && pending.device == fresh.device
                            && pending.genesis == fresh.genesis =>
                    {
                        pending
                    }
                    _ => fresh,
                };
                persist(&self.profile, &mut inner.registry, trust, &dir, &choice)?;
                self.authority.publish_registry(&inner.registry);
                if let Some(updated) = inner.registry.get(id).cloned()
                    && let Some(host) = inner.hosts.iter_mut().find(|h| h.entry().id == id)
                {
                    host.set_entry(updated);
                }
                Ok::<_, String>(choice)
            })();
            result.map_err(|_| {
                ControlError::unavailable(
                    "mode_projection_pending",
                    "Cloud choice is pending; retry to finish",
                )
            })?
        };
        match runtime
            .private_switch(PrivateSwitchOp::ChooseCloudAt(generation), guard.clone())
            .await
        {
            Some(Ok(_)) if guard() => {}
            _ => {
                return Err(ControlError::unavailable(
                    "mode_projection_pending",
                    "Cloud choice is pending; retry to finish",
                ));
            }
        }
        let dir = self.profile.state_dir.join("collections").join(id);
        let _inner = self.inner.lock().await;
        if !guard() {
            return Err(ControlError::unavailable(
                "account_changed",
                "account changed",
            ));
        }
        let pending = load(&dir.join(FILE)).map_err(|_| {
            ControlError::unavailable(
                "mode_projection_pending",
                "Cloud choice is pending; retry to finish",
            )
        })?;
        if pending.as_ref().is_some_and(|other| other != &choice) {
            return Err(ControlError::unavailable(
                "mode_projection_pending",
                "a different choice is pending",
            ));
        }
        if pending.is_some() {
            std::fs::remove_file(dir.join(FILE))
                .and_then(|_| crate::fsutil::sync_dir(&dir))
                .map_err(|_| {
                    ControlError::unavailable(
                        "mode_projection_pending",
                        "Cloud choice is pending; retry to finish",
                    )
                })?;
        }
        Ok(())
    }

    pub(super) async fn project_cancelled_cloud(
        &self,
        id: &str,
        runtime: &crate::runtime::Runtime,
        guard: AccountKeyGuard,
    ) -> Result<(), crate::control::ControlError> {
        use crate::control::ControlError;
        let result = runtime
            .private_switch(PrivateSwitchOp::CancelCloud, guard.clone())
            .await;
        if !matches!(result, Some(Ok(_))) || !guard() {
            return Err(ControlError::unavailable(
                "mode_cancel_pending",
                "Native policy must confirm cancellation",
            ));
        }
        if !matches!(
            runtime
                .private_switch(PrivateSwitchOp::CloudCandidate, guard.clone())
                .await,
            Some(Ok(Some(_)))
        ) {
            // No local source permission to revoke, or verified Cloud reading
            // selected elsewhere: cancellation must not roll reading back.
            return Ok(());
        }
        let signers = runtime
            .private_switch_signers(guard.clone())
            .await
            .ok_or_else(|| ControlError::unavailable("account_changed", "account changed"))?;
        let mut inner = self.inner.lock().await;
        if !guard() {
            return Err(ControlError::unavailable(
                "account_changed",
                "account changed",
            ));
        }
        let entry = inner.registry.get(id).cloned().ok_or_else(|| {
            ControlError::unavailable("not_registered", "collection not registered")
        })?;
        let trust = self
            .trust
            .as_ref()
            .ok_or_else(|| ControlError::unavailable("not_ready", "trust unavailable"))?;
        let dir = self.profile.collection_dir(id);
        let cfg = crate::sync::SyncConfig::load(&dir.join(crate::sync::FILE))
            .map_err(|e| ControlError::internal(e.0))?
            .ok_or_else(|| ControlError::unavailable("not_ready", "sync link missing"))?;
        let choice = Choice {
            collection: id.into(),
            account: entry
                .owner_account
                .clone()
                .ok_or_else(|| ControlError::unavailable("not_ready", "account missing"))?,
            device: entry
                .device
                .clone()
                .ok_or_else(|| ControlError::unavailable("not_ready", "device missing"))?,
            genesis: cfg.genesis_hash,
            signer: entry.device.clone().unwrap(),
            trusted_signers: signers.iter().map(|s| s.to_uuid_string()).collect(),
            cloud_copy: false,
            receiver_read: false,
        };
        if let Some(old) = load(&dir.join(FILE)).map_err(ControlError::internal)? {
            if old.collection != choice.collection
                || old.account != choice.account
                || old.device != choice.device
                || old.genesis != choice.genesis
            {
                return Err(ControlError::unavailable(
                    "mode_cancel_pending",
                    "journal identity differs",
                ));
            }
            std::fs::remove_file(dir.join(FILE))
                .map_err(|e| ControlError::internal(e.to_string()))?;
        }
        persist(&self.profile, &mut inner.registry, trust, &dir, &choice)
            .map_err(ControlError::internal)?;
        self.authority.publish_registry(&inner.registry);
        if let Some(updated) = inner.registry.get(id).cloned()
            && let Some(host) = inner.hosts.iter_mut().find(|h| h.entry().id == id)
        {
            host.set_entry(updated);
        }
        Ok(())
    }

    /// Called before a native status observation. If a host has not yet observed
    /// acceptance, its signed-prefix META will recover it on the next open.
    pub(super) async fn reconcile_private_choices(&self) {
        // Status must not wait behind a foreground confirmation/account change.
        // A later poll retries the same durable journal, without stale replays.
        let Ok(_gate) = self.account_gate.try_lock() else {
            return;
        };
        self.reconcile_private_choices_locked().await;
    }

    pub(super) async fn reconcile_private_choices_locked(&self) {
        let Some(trust) = &self.trust else {
            return;
        };
        let runtimes = {
            let inner = self.inner.lock().await;
            inner
                .hosts
                .iter()
                .filter_map(|h| h.runtime().map(|rt| (h.entry().clone(), rt)))
                .collect::<Vec<_>>()
        };
        for (entry, runtime) in runtimes {
            let Some(collection) = crate::attest::uuid_bytes(&entry.id) else {
                continue;
            };
            let Ok(source) = self.authority.source(mdbn_wire::common::B16(collection)) else {
                continue;
            };
            let fenced = source.clone();
            let guard: AccountKeyGuard = Arc::new(move || fenced.current_synced().is_ok());
            let dir = self.profile.state_dir.join("collections").join(&entry.id);
            match load(&dir.join(FILE)) {
                Err(_) => {
                    tracing::warn!(collection = %entry.id, "verified mode choice journal is unreadable; retained for recovery");
                    continue;
                }
                Ok(Some(choice)) if choice.cloud_copy && !choice.receiver_read => {
                    let cfg = crate::sync::SyncConfig::load(&dir.join(crate::sync::FILE))
                        .ok()
                        .flatten();
                    if choice.collection != entry.id
                        || entry.owner_account.as_deref() != Some(&choice.account)
                        || entry.device.as_deref() != Some(&choice.device)
                        || cfg
                            .as_ref()
                            .is_none_or(|cfg| cfg.genesis_hash != choice.genesis)
                    {
                        continue;
                    }
                    // Request/generation validation owns source resumption. Drop
                    // only this bound projection journal; keep the request and
                    // reconcile verified facts without reviving source consent.
                    if std::fs::remove_file(dir.join(FILE)).is_err()
                        || crate::fsutil::sync_dir(&dir).is_err()
                    {
                        continue;
                    }
                }
                _ => {}
            }
            let read_owner = runtime
                .private_switch(PrivateSwitchOp::CloudRead, guard.clone())
                .await
                .and_then(Result::ok)
                .flatten();
            let receiver_read = read_owner.is_some();
            let signer = if let Some(signer) = read_owner {
                signer
            } else {
                let Some(Ok(Some(signer))) = runtime
                    .private_switch(PrivateSwitchOp::Accepted, guard.clone())
                    .await
                else {
                    continue;
                };
                signer
            };
            let Some(signers) = runtime.private_switch_signers(guard.clone()).await else {
                continue;
            };
            let trusted_signers = signers
                .iter()
                .map(|id| id.to_uuid_string())
                .collect::<Vec<_>>();
            let signer = signer.to_uuid_string();
            let result = {
                let mut inner = self.inner.lock().await;
                if source.current_synced().is_err() || inner.registry.get(&entry.id) != Some(&entry)
                {
                    continue;
                }
                let dir = self.profile.state_dir.join("collections").join(&entry.id);
                (|| {
                    let cfg = crate::sync::SyncConfig::load(&dir.join(crate::sync::FILE))
                        .map_err(|e| e.0)?
                        .ok_or("missing sync link")?;
                    cfg.validate(&collection, trust).map_err(|e| e.0)?;
                    let choice = Choice {
                        collection: entry.id.clone(),
                        account: entry
                            .owner_account
                            .clone()
                            .ok_or("registration account missing")?,
                        device: entry.device.clone().ok_or("registration device missing")?,
                        genesis: cfg.genesis_hash,
                        signer,
                        trusted_signers,
                        cloud_copy: receiver_read,
                        receiver_read,
                    };
                    if !(receiver_read
                        && entry.mode == SyncMode::Synced
                        && cfg.chosen_state == "cloud_copy"
                        && cfg.user_enabled_cloud_copy)
                    {
                        persist(&self.profile, &mut inner.registry, trust, &dir, &choice)?;
                    }
                    self.authority.publish_registry(&inner.registry);
                    if let Some(updated) = inner.registry.get(&entry.id).cloned()
                        && updated != entry
                        && let Some(host) =
                            inner.hosts.iter_mut().find(|h| h.entry().id == entry.id)
                    {
                        host.set_entry(updated);
                    }
                    Ok::<_, String>(())
                })()
            };
            if result.is_ok() {
                if !receiver_read {
                    let _ = runtime
                        .private_switch(PrivateSwitchOp::Acknowledge, guard)
                        .await;
                }
            } else {
                tracing::warn!(collection = %entry.id, "verified private choice projection pending; retained for restart");
            }
        }
    }
}
