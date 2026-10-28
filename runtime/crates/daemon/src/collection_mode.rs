//! Resumable native controller. Only an explicit native user action creates
//! intent. Resume never turns a server request/flag into local consent.
use super::{Daemon, cloud_refusal};
use crate::control::ControlError;
use crate::runtime::{AccountKeyGuard, PrivateSwitchOp};
use mdbn_replica::crypto::proof::ModeProof;
use mdbn_wire::common::B16;
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ChangeMode {
    collection: String,
    target_mode: String,
    #[serde(default)]
    resume: bool,
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
        // Same account/config serialization as enable-sync. Each invocation is a
        // bounded step, not a background task holding an account lock indefinitely.
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
        let runtime = self
            .inner
            .lock()
            .await
            .hosts
            .iter()
            .find(|h| h.entry().id == p.collection)
            .and_then(|h| h.runtime())
            .ok_or_else(|| {
                ControlError::unavailable("not_serving", "resume this collection first")
            })?;
        let mut status = ctx
            .cloud
            .collection_mode_status(&p.collection, &current)
            .await
            .map_err(cloud_refusal)?;
        let active = status.get("change").filter(|v| !v.is_null());
        if active
            .is_some_and(|v| v.get("target_mode").and_then(Value::as_str) != Some(&p.target_mode))
        {
            return Err(ControlError::invalid(
                "mode_change_in_progress",
                "finish the current switch first",
            ));
        }
        let receipt = runtime.mode_source(private, true, guard.clone()).await;
        let intent = runtime.mode_source(private, false, guard.clone()).await;
        if receipt.is_none() && intent.is_none() {
            if p.resume {
                return Ok(json!({"phase":"waiting_for_device", "target_mode":p.target_mode}));
            }
            self.confirm(if private {"Make private"} else {"Turn on cloud copy"}, if private {
                "Only your devices will read new content. mdbase may still read older content. Keep an owner device with its keys."
            } else { "mdbase will be able to read and serve this collection, including its existing history, even when your devices are off." }).await?;
            if !private {
                self.choose_cloud_copy_locally(&p.collection, &runtime, guard.clone())
                    .await?;
            } else {
                runtime
                    .private_switch(PrivateSwitchOp::Request, guard.clone())
                    .await
                    .ok_or_else(|| ControlError::unavailable("not_ready", "collection stopped"))?
                    .map_err(|_| {
                        ControlError::unavailable(
                            "keyed_owner_required",
                            "use an owner device holding this collection's trusted key",
                        )
                    })?;
            }
        }
        let current_mode = status.get("current_mode").and_then(Value::as_str);
        let mut request = active
            .and_then(|v| v.get("request_id"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        if request.is_none() && current_mode == Some(&p.target_mode) {
            // Never turn a catalog result into local Private acceptance.
            if runtime
                .mode_source(private, true, guard.clone())
                .await
                .is_none()
            {
                return Ok(json!({"phase":"waiting_for_device", "target_mode":p.target_mode}));
            }
            self.reconcile_private_choices_locked().await;
            return Ok(json!({"phase":"complete", "target_mode":p.target_mode}));
        }
        if request.is_none() {
            let id =
                crate::secrets::new_uuid().map_err(|e| ControlError::internal(e.to_string()))?;
            status = ctx
                .cloud
                .collection_mode_intent(&p.collection, &id, private, &current)
                .await
                .map_err(cloud_refusal)?;
            request = status
                .get("request_id")
                .and_then(Value::as_str)
                .map(str::to_owned);
        }
        let request = request
            .and_then(|id| crate::attest::uuid_bytes(&id))
            .ok_or_else(|| {
                ControlError::unavailable("mode_status_invalid", "switch status unavailable")
            })?;
        let receipt = runtime.mode_source(private, true, guard.clone()).await;
        let (finish, epoch, head, members) = if let Some((epoch, head, members)) = receipt {
            (true, epoch, head, members)
        } else {
            let Some((epoch, head, members)) =
                runtime.mode_source(private, false, guard.clone()).await
            else {
                return Ok(json!({"phase":"waiting_for_device", "target_mode":p.target_mode}));
            };
            (false, epoch, head, members)
        };
        let identity = self.identity.get().ok_or_else(|| {
            ControlError::unavailable("device_identity_missing", "device key unavailable")
        })?;
        let proof = ModeProof {
            request: B16(request),
            private,
            finish,
            epoch,
            seq: head.seq,
            chain: head.chain,
            members,
        };
        let answer = ctx
            .cloud
            .collection_mode_post(&ctx.connector_id, &col, &proof, identity, &current)
            .await
            .map_err(cloud_refusal)?;
        if private {
            self.reconcile_private_choices_locked().await;
        }
        // No optimistic local Cloud projection: the committed replica choice is
        // authoritative; host-file projection is reconciled independently.
        self.bump();
        Ok(answer)
    }
}
