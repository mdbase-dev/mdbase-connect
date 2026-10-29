//! Bounded native mode steps. The identity-bound request journal is durable
//! before reservation/consent. Unknown HTTP outcomes retain the same request.
use super::{Daemon, cloud_refusal};
use crate::control::ControlError;
use crate::runtime::{AccountKeyGuard, PrivateSwitchOp};
use mdbn_replica::crypto::proof::ModeProof;
use mdbn_wire::common::B16;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{path::Path, sync::Arc};
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
    target_mode: String,
    #[serde(default)]
    resume: bool,
    #[serde(default)]
    cancel: bool,
}
impl Daemon {
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
            let cancelled = op.cancel_requested
                || terminal
                    .as_ref()
                    .is_some_and(|v| v.get("phase").and_then(Value::as_str) == Some("cancelled"));
            if !cancelled
                && terminal
                    .as_ref()
                    .is_some_and(|v| v.get("phase").and_then(Value::as_str) == Some("complete"))
            {
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
                    }
                }
            }
            if cancelled {
                self.change_collection_mode(ChangeMode {
                    collection: id.into(),
                    target_mode: op.target,
                    resume: true,
                    cancel: true,
                })
                .await?;
            }
        }
        let mut result = ctx
            .cloud
            .collection_mode_status(id, &current)
            .await
            .map_err(cloud_refusal)?;
        current().map_err(|_| ControlError::unavailable("account_changed", "account changed"))?;
        if let Some(entry) = self.inner.lock().await.registry.get(id) {
            result
                .as_object_mut()
                .ok_or_else(|| {
                    ControlError::unavailable("mode_status_invalid", "Switch status is unavailable")
                })?
                .insert(
                    "current_mode".into(),
                    json!(if entry.mode == crate::registry::SyncMode::SyncedE2e {
                        "private"
                    } else {
                        "cloud_copy"
                    }),
                );
        }
        Ok(result)
    }
    pub(super) async fn change_collection_mode(
        &self,
        p: ChangeMode,
    ) -> Result<Value, ControlError> {
        let private = match p.target_mode.as_str() {
            "private" => true,
            "cloud_copy" => false,
            _ => {
                return Err(ControlError::invalid(
                    "target_mode",
                    "choose private or cloud_copy",
                ));
            }
        };
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
        if let Some(op) = &operation
            && (op.collection != entry.id
                || Some(op.account.as_str()) != entry.owner_account.as_deref()
                || Some(op.device.as_str()) != entry.device.as_deref()
                || op.genesis != cfg.genesis_hash
                || op.target != p.target_mode
                || crate::attest::uuid_bytes(&op.request).is_none())
        {
            return Err(ControlError::unavailable(
                "mode_journal_invalid",
                "Mode request identity differs; retained",
            ));
        }
        let status = ctx
            .cloud
            .collection_mode_status(&p.collection, &current)
            .await
            .map_err(cloud_refusal)?;
        let active = status.get("change").filter(|v| !v.is_null());
        if operation.is_none()
            && active.is_some_and(|v| {
                v.get("target_mode").and_then(Value::as_str) != Some(&p.target_mode)
            })
        {
            return Err(ControlError::invalid(
                "mode_change_in_progress",
                "finish the current switch first",
            ));
        }
        if operation.is_none() {
            if active.is_none()
                && status.get("current_mode").and_then(Value::as_str) == Some(&p.target_mode)
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
                return Ok(
                    json!({"phase":if p.cancel {"cancelled"}else if selected {"complete"}else{"waiting_for_device"},"target_mode":p.target_mode}),
                );
            }
            if p.resume && !p.cancel {
                return Ok(json!({"phase":"waiting_for_device","target_mode":p.target_mode}));
            }
            if !p.cancel {
                self.confirm(if private {"Make private"}else{"Turn on cloud copy"},if private {"Only your devices will read new content after the switch finishes. mdbase may still read older content."}else{"mdbase will be able to read and serve this collection, including its existing history, even when your devices are off."}).await?;
            }
            let request = active
                .and_then(|v| v.get("request_id"))
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or(
                    crate::secrets::new_uuid()
                        .map_err(|e| ControlError::internal(e.to_string()))?,
                );
            let op = Request {
                collection: entry.id.clone(),
                account: entry
                    .owner_account
                    .clone()
                    .ok_or_else(|| ControlError::unavailable("not_ready", "account missing"))?,
                device: entry
                    .device
                    .clone()
                    .ok_or_else(|| ControlError::unavailable("not_ready", "device missing"))?,
                genesis: cfg.genesis_hash,
                generation: crate::secrets::hex(
                    &runtime
                        .mode_generation(guard.clone())
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
                target: p.target_mode.clone(),
                cancel_requested: p.cancel,
                native_started: false,
            };
            op.save(&dir)?;
            operation = Some(op);
        }
        let mut op = operation.expect("created above");
        if p.cancel {
            op.cancel_requested = true;
            op.save(&dir)?;
        }
        // Reservation is idempotent even after a lost reply. This also ensures a
        // cancellation tombstone exists before a delayed original POST arrives.
        let reserved = match ctx
            .cloud
            .collection_mode_intent(&p.collection, &op.request, private, &current)
            .await
        {
            Ok(value) => value,
            Err(error) => {
                // Intent alone cannot publish. A definite refusal before any
                // native mutation must not strand a new local request.
                if !op.native_started
                    && matches!(&error,crate::cloud::CloudError::Server(status,_) if (400..500).contains(status))
                {
                    Request::clear(&dir)?;
                    if op.cancel_requested {
                        return Ok(json!({"phase":"cancelled","request_id":op.request}));
                    }
                }
                return Err(cloud_refusal(error));
            }
        };
        if op.cancel_requested || reserved.get("phase").and_then(Value::as_str) == Some("cancelled")
        {
            op.cancel_requested = true;
            op.save(&dir)?;
            if let Err(error) = ctx
                .cloud
                .collection_mode_cancel(&p.collection, &op.request, &current)
                .await
            {
                if matches!(&error,crate::cloud::CloudError::Server(409,code) if code=="mode_already_published")
                {
                    op.cancel_requested = false;
                    op.save(&dir)?;
                }
                return Err(cloud_refusal(error));
            }
            if private {
                runtime
                    .private_switch(PrivateSwitchOp::Cancel, guard.clone())
                    .await
                    .ok_or_else(|| ControlError::unavailable("not_ready", "collection stopped"))?
                    .map_err(|_| {
                        ControlError::unavailable(
                            "mode_cancel_pending",
                            "Native policy must confirm cancellation",
                        )
                    })?;
            } else {
                self.project_cancelled_cloud(&p.collection, &runtime, guard.clone())
                    .await?;
            }
            current()
                .map_err(|_| ControlError::unavailable("account_changed", "account changed"))?;
            Request::clear(&dir)?;
            self.bump();
            return Ok(json!({"phase":"cancelled","request_id":op.request}));
        }
        if reserved.get("phase").and_then(Value::as_str) == Some("complete") {
            Request::clear(&dir)?;
            self.reconcile_private_choices_locked().await;
            return Ok(json!({"phase":"complete","request_id":op.request}));
        }
        let receipt = runtime.mode_source(private, true, guard.clone()).await;
        let intent = runtime.mode_source(private, false, guard.clone()).await;
        if receipt.is_none() && intent.is_none() {
            op.native_started = true;
            op.save(&dir)?;
            if private {
                runtime
                    .private_switch(PrivateSwitchOp::Request, guard.clone())
                    .await
                    .ok_or_else(|| ControlError::unavailable("not_ready", "collection stopped"))?
                    .map_err(|_| {
                        ControlError::unavailable(
                            "keyed_owner_required",
                            "use an owner device holding this collection’s trusted key",
                        )
                    })?;
            } else {
                self.choose_cloud_copy_locally(
                    &p.collection,
                    &runtime,
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
                .await?;
            }
        }
        let receipt = runtime.mode_source(private, true, guard.clone()).await;
        let (finish, epoch, head, members) = if let Some((epoch, head, members)) = receipt {
            (true, epoch, head, members)
        } else {
            let Some((epoch, head, members)) =
                runtime.mode_source(private, false, guard.clone()).await
            else {
                return Ok(json!({"phase":"waiting_for_device","target_mode":p.target_mode}));
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
            .collection_mode_post(&ctx.connector_id, &col, &proof, &identity, &current)
            .await;
        // A definitive pre-publication refusal can be cancelled atomically. An
        // assigned/unknown batch refuses cancellation, so its intent is retained.
        if matches!(&result,Err(crate::cloud::CloudError::Server(code,_)) if (400..500).contains(code))
            && ctx
                .cloud
                .collection_mode_cancel(&p.collection, &op.request, &current)
                .await
                .is_ok()
        {
            op.cancel_requested = true;
            op.save(&dir)?;
            if private {
                runtime
                    .private_switch(PrivateSwitchOp::Cancel, guard.clone())
                    .await
                    .ok_or_else(|| {
                        ControlError::unavailable("mode_cancel_pending", "collection stopped")
                    })?
                    .map_err(|_| {
                        ControlError::unavailable(
                            "mode_cancel_pending",
                            "Native policy must confirm cancellation",
                        )
                    })?;
            } else {
                self.project_cancelled_cloud(&p.collection, &runtime, guard.clone())
                    .await?;
            }
            Request::clear(&dir)?;
        }
        let answer = result.map_err(cloud_refusal)?;
        if private {
            self.reconcile_private_choices_locked().await;
        }
        if answer.get("phase").and_then(Value::as_str) == Some("complete") {
            Request::clear(&dir)?;
        }
        self.bump();
        Ok(answer)
    }
}
