//! Native projection of a replica-verified private choice. The private sidecar
//! closes the crash gap between sync.json and the registration; it is not remote
//! policy authority. Only an actor's committed acceptance creates it.
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
        cfg.chosen_state = "private".into();
        cfg.user_enabled_cloud_copy = false;
        if !cfg.trusted_signers.contains(&choice.signer) {
            cfg.trusted_signers.push(choice.signer);
        }
        cfg.save(&path, &collection, trust).map_err(|e| e.0)?;
        let mut next = registry.clone();
        let changed = next.get_mut(&entry.id).ok_or("registration disappeared")?;
        changed.mode = SyncMode::SyncedE2e;
        changed.ever_e2e = true;
        next.save(&profile.registry_file())
            .map_err(|e| e.to_string())?;
        *registry = next;
        std::fs::remove_file(&journal).map_err(|e| e.to_string())?;
        crate::fsutil::sync_dir(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

impl Daemon {
    /// Called before a native status observation. If a host has not yet observed
    /// acceptance, its signed-prefix META will recover it on the next open.
    pub(super) async fn reconcile_private_choices(&self) {
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
            let Some(Ok(Some(signer))) = runtime
                .private_switch(PrivateSwitchOp::Accepted, guard.clone())
                .await
            else {
                continue;
            };
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
                    };
                    let path = dir.join(FILE);
                    if let Some(existing) = load(&path)? {
                        if existing != choice {
                            return Err("different private choice is already pending".to_string());
                        }
                    } else {
                        crate::fsutil::write_atomic(
                            &path,
                            &serde_json::to_vec(&choice).map_err(|_| "private choice encoding")?,
                        )
                        .map_err(|e| e.to_string())?;
                    }
                    replay(&self.profile, &mut inner.registry, trust)?;
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
                let _ = runtime
                    .private_switch(PrivateSwitchOp::Acknowledge, guard)
                    .await;
            } else {
                tracing::warn!(collection = %entry.id, "verified private choice projection pending; retained for restart");
            }
        }
    }
}
