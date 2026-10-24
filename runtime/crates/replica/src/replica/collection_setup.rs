//! Initial device-only setup capture admission and lifetime fence. No source
//! reads, frozen inventory, SetupStateView, installer or publication activation.
use super::{Replica, Store};
use crate::{
    api::{ApiResult, ErrorCode},
    policy::DeviceState,
    seal::SealerIdentity,
    store::Head,
};
use mdbn_core::types::Catalog;
use mdbn_wire::{
    common::{B32, Hash, Uuid},
    policy::{DeviceKind, Role},
};
use sha2::{Digest, Sha256};
use std::sync::Arc;

// Setup observations always retain the immutable catalogue allocation.
#[cfg(test)]
mod catalog_pin_tests {
    use super::*;
    #[test]
    fn default_identity_keeps_strong_catalog_contents_until_capture_drops() {
        let catalog = Arc::new(Catalog::empty());
        let observer = Arc::downgrade(&catalog);
        let identity = CatalogCapture::Strong(catalog.clone());
        assert!(identity.matches(&catalog));
        assert_eq!(Arc::strong_count(&catalog), 2);
        drop(catalog);
        assert!(observer.upgrade().is_some());
        drop(identity);
        assert!(observer.upgrade().is_none());
    }
}

enum CatalogCapture {
    Strong(Arc<Catalog>),
}
impl CatalogCapture {
    fn matches(&self, current: &Arc<Catalog>) -> bool {
        match self {
            Self::Strong(catalog) => Arc::ptr_eq(catalog, current),
        }
    }
}

mod capture;
mod publication;
mod rpc;
mod rpc_source;
mod session;
pub use capture::{SetupCapturedInventory, SetupSourceRead};
pub(crate) use publication::PendingSetup;
pub(crate) use rpc::{FEATURE as SETUP_RPC_FEATURE, Job as SetupRpcJob};
pub use session::{
    CollectionSetupSession, PreparedCollectionSetupPlan, PreparedCollectionSetupReview,
};

/// Opaque, instance-scoped admission fence for later setup observations.
/// This is not an assessment, complete inventory, source or publication proof.
/// Fields cannot be supplied by an app, grant or descriptor holder. Recheck
/// after EVERY external await and before using/publishing any observation.
pub struct SetupCaptureFence {
    collection: Uuid,
    device: Uuid,
    head: Head,
    store_generation: u64,
    repair_generation: u64,
    epoch: u64,
    ctl_chain: Hash,
    identity: SealerIdentity,
    authority: DeviceState,
    role: Role,
    delegation: Option<SetupDelegationFence>,
    client: Option<(crate::api::SessionId, [u8; 32])>,
    // Immutable allocation identity scopes this token to its replica lifetime.
    // Strong captures retain contents. Pointers are NEVER hashed.
    catalog: CatalogCapture,
    revision: Hash,
}
#[derive(PartialEq)]
struct SetupDelegationFence {
    grant: Uuid,
    effective: crate::policy::EffectiveGrant,
    authorization: crate::policy::DeclaredSetupAuthorization,
}
impl SetupCaptureFence {
    /// Trusted collection/head revision, not an app-declared token. The opaque
    /// fence separately binds instance/catalog/generation and current authority.
    pub fn collection_revision(&self) -> Hash {
        self.revision
    }
}
fn unavailable() -> crate::api::ApiError {
    ErrorCode::Unavailable.err_with_reason(
        "collection_setup_not_ready",
        "setup capture requires healthy current keyed device state",
    )
}
fn changed() -> crate::api::ApiError {
    ErrorCode::Conflict.err_with_reason(
        "concurrent_modification",
        "trusted setup capture state or authority changed",
    )
}
impl<S: Store> Replica<S> {
    fn setup_capture_authority(
        &self,
        on_behalf: Option<Uuid>,
    ) -> ApiResult<(SealerIdentity, DeviceState, Role)> {
        if on_behalf.is_some() {
            return Err(ErrorCode::Forbidden.err_with_reason(
                "collection_setup_delegated_unsupported",
                "delegated setup requires qualified composite mediation",
            ));
        }
        let denied = || {
            ErrorCode::Forbidden.err_with_reason(
                "collection_setup_requires_keyed_editor_device",
                "setup capture requires a keyed editor device",
            )
        };
        if self.is_hosted()
            || self.local_only()
            || !self.policy.device_can_write(&self.cfg.device_id)
        {
            return Err(denied());
        }
        let device = self
            .policy
            .devices
            .get(&self.cfg.device_id)
            .filter(|device| device.active)
            .ok_or_else(denied)?;
        if !matches!(
            device.kind,
            DeviceKind::Desktop | DeviceKind::Mobile | DeviceKind::AppRuntime | DeviceKind::Cli
        ) {
            return Err(denied());
        }
        let role = *self
            .policy
            .members
            .get(&device.account)
            .ok_or_else(denied)?;
        let identity = self.sealer.public_identity().ok_or_else(denied)?;
        if identity.collection != self.cfg.collection
            || identity.device != self.cfg.device_id
            || identity.sign_pk != device.sign_pk
            || identity.kem_pk != device.kem_pk
        {
            return Err(denied());
        }
        self.check_apply_health()?;
        if self.serves_apps().is_err()
            || self.regressed_at.is_some()
            || self.policy.frozen
            || self.policy.rekey_required
            || self.sealer.current_epoch() != Some(self.policy.epoch)
            || self.policy.epoch == 0
            || self.stalled.is_some()
            || self.repair.is_some()
            || self.install.is_some()
            || !self.caught_up
            || !self.layer.is_empty()
        {
            return Err(unavailable());
        }
        Ok((identity, device.clone(), role))
    }
    pub(super) fn supports_declared_setup(&self, grant: Uuid) -> bool {
        self.setup_delegation(grant).is_ok()
    }
    fn setup_delegation(&self, grant: Uuid) -> ApiResult<SetupDelegationFence> {
        let denied = || {
            ErrorCode::Forbidden.err_with_reason(
                "declared_collection_setup_not_authorized",
                "current declaration-bound setup authority is unavailable",
            )
        };
        let source = self.grant_source.as_ref().ok_or_else(denied)?;
        let effective = self.grant_now(&grant).ok_or_else(denied)?;
        let authorization = source.declared_setup(&grant).ok_or_else(denied)?;
        if authorization.generation == 0
            || authorization.lease_generation == 0
            || authorization.authority_epoch == 0
            || source.authority_epoch() != Some(authorization.authority_epoch)
            || source.active_account() != Some(authorization.account)
            || effective.account != authorization.account
            || effective.client_pk != authorization.client_pk
            || effective.role < Role::Editor
            || !self.serving_account_matches(&authorization.account)
        {
            return Err(denied());
        }
        Ok(SetupDelegationFence {
            grant,
            effective,
            authorization,
        })
    }
    fn declared_setup_capture_fence(
        &self,
        setup: &mdbn_core::setup::envelope::CollectionSetup,
        grant: Uuid,
        client: Option<(crate::api::SessionId, [u8; 32])>,
    ) -> ApiResult<SetupCaptureFence> {
        let delegation = self.setup_delegation(grant)?;
        if delegation.authorization.setup != *setup {
            return Err(ErrorCode::Forbidden.err_with_reason(
                "declared_collection_setup_mismatch",
                "setup must exactly match the original authenticated declaration",
            ));
        }
        // Only this checked entry point mediates through the device. The ordinary
        // on_behalf capture API stays closed; no caller gains an owner session.
        let mut fence = self.collection_setup_capture_fence(None)?;
        fence.delegation = Some(delegation);
        fence.client = client;
        self.recheck_collection_setup_capture(&fence)?;
        Ok(fence)
    }
    fn setup_capture_head(&self) -> ApiResult<Head> {
        let head = self.store.head().map_err(|_| {
            ErrorCode::Unavailable.err_with_reason(
                "collection_setup_metadata_unavailable",
                "trusted setup metadata could not be read",
            )
        })?;
        if head != self.head || self.policy.seq != head.seq {
            return Err(changed());
        }
        Ok(head)
    }
    /// Begin only for an actual healthy keyed editor device, `on_behalf=None`.
    /// No caller-provided revision/role/device keys or source metadata are trusted.
    /// This data-only API does not expose an SDK/facade or activate setup writes.
    pub fn collection_setup_capture_fence(
        &self,
        on_behalf: Option<Uuid>,
    ) -> ApiResult<SetupCaptureFence> {
        let (identity, authority, role) = self.setup_capture_authority(on_behalf)?;
        let head = self.setup_capture_head()?;
        let mut h = Sha256::new();
        h.update(b"mdbase/v1/collection-setup-capture-revision");
        h.update(self.cfg.collection.0);
        h.update(head.seq.to_be_bytes());
        h.update(head.chain.0);
        Ok(SetupCaptureFence {
            collection: self.cfg.collection,
            device: self.cfg.device_id,
            head,
            store_generation: self.store_generation,
            repair_generation: self.repair_generation,
            epoch: self.policy.epoch,
            ctl_chain: self.policy.ctl_chain,
            identity,
            authority,
            role,
            delegation: None,
            client: None,
            catalog: CatalogCapture::Strong(self.catalog.clone()),
            revision: B32(h.finalize().into()),
        })
    }
    /// Re-admit current authority and compare the complete trusted lifetime fence.
    /// A failed recheck invalidates every associated observation; it must never
    /// be interpreted as missing inventory, a parse refusal or empty success.
    pub fn recheck_collection_setup_capture(&self, fence: &SetupCaptureFence) -> ApiResult<()> {
        let (identity, authority, role) = self.setup_capture_authority(None)?;
        let head = self.setup_capture_head()?;
        if let Some((session, client_pk)) = fence.client {
            let Some(expected) = &fence.delegation else {
                return Err(changed());
            };
            if self.session(session)?.auth
                != (crate::api::SessionAuth::Grant {
                    grant: expected.grant,
                    client_pk,
                })
            {
                return Err(changed());
            }
            self.grant_for_client(&expected.grant, &client_pk)
                .ok_or_else(changed)?;
        }
        if let Some(expected) = &fence.delegation
            && self.setup_delegation(expected.grant)? != *expected
        {
            return Err(changed());
        }
        if fence.collection != self.cfg.collection
            || fence.device != self.cfg.device_id
            || fence.head != head
            || fence.store_generation != self.store_generation
            || fence.repair_generation != self.repair_generation
            || fence.epoch != self.policy.epoch
            || fence.ctl_chain != self.policy.ctl_chain
            || fence.identity != identity
            || fence.authority != authority
            || fence.role != role
            || !fence.catalog.matches(&self.catalog)
        {
            return Err(changed());
        }
        Ok(())
    }
}
