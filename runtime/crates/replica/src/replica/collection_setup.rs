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
use std::sync::{Arc, Weak};

// Strong by default. Only bounded discovery residency may release contents;
// Weak still reserves allocation identity and prevents pointer/address reuse.
#[cfg(test)]
mod discovery_pin_tests {
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
    #[test]
    fn discovery_identity_releases_contents_but_never_accepts_dead_or_new_catalog() {
        let catalog = Arc::new(Catalog::empty());
        let observer = Arc::downgrade(&catalog);
        let identity = CatalogCapture::Discovery(Arc::downgrade(&catalog));
        assert_eq!(Arc::strong_count(&catalog), 1);
        assert!(identity.matches(&catalog));
        let replacement = Arc::new(Catalog::empty());
        assert!(!identity.matches(&replacement));
        drop(catalog);
        assert!(observer.upgrade().is_none());
        assert!(!identity.matches(&replacement));
    }
    #[test]
    fn weak_control_block_and_inline_catalog_are_inside_slot_accounting() {
        let bytes = SetupCaptureFence::discovery_catalog_allocation_bytes();
        assert!(
            bytes >= (std::mem::size_of::<Catalog>() + 2 * std::mem::size_of::<usize>()) as u64
        );
        assert!(bytes < 4096);
    }
}

enum CatalogCapture {
    Strong(Arc<Catalog>),
    Discovery(Weak<Catalog>),
}
impl CatalogCapture {
    fn matches(&self, current: &Arc<Catalog>) -> bool {
        match self {
            Self::Strong(catalog) => Arc::ptr_eq(catalog, current),
            Self::Discovery(catalog) => catalog
                .upgrade()
                .is_some_and(|original| Arc::ptr_eq(&original, current)),
        }
    }
}

mod capture;
mod session;
pub use capture::{SetupCapturedInventory, SetupSourceRead};
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
    // Immutable allocation identity scopes this token to its replica lifetime.
    // Default strong captures retain contents; discovery-only Weak residency
    // reserves identity without retaining catalog maps. Pointers are NEVER hashed.
    catalog: CatalogCapture,
    revision: Hash,
}
impl SetupCaptureFence {
    /// Discovery-only residency: preserve allocation identity/full rechecks,
    /// but do not keep replaced catalogs' owned maps/resources alive.
    pub(in crate::replica) fn release_discovery_catalog_pin(&mut self) {
        if let CatalogCapture::Strong(catalog) = &self.catalog {
            self.catalog = CatalogCapture::Discovery(Arc::downgrade(catalog));
        }
    }
    /// Weak retains the Arc control block and inline Catalog allocation even
    /// after its contents drop. Charge both conservatively to each slot.
    pub(in crate::replica) fn discovery_catalog_allocation_bytes() -> u64 {
        (std::mem::size_of::<Catalog>() + 2 * std::mem::size_of::<usize>() + 64) as u64
    }
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
