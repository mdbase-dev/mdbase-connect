//! Instance-local READ cut: a verified applied prefix plus this device's layer.
//! Setup admission stays separate. Pending writes and catch-up are not read faults.
use super::*;
use crate::{policy::DeviceState, seal::SealerIdentity, store::Head};
use mdbn_core::types::Catalog;
use mdbn_wire::policy::{DeviceKind, Role};
use std::sync::{Arc, Weak};

enum CatalogPin {
    Strong(Arc<Catalog>),
    Discovery(Weak<Catalog>),
}
impl CatalogPin {
    fn matches(&self, catalog: &Arc<Catalog>) -> bool {
        match self {
            Self::Strong(original) => Arc::ptr_eq(original, catalog),
            Self::Discovery(original) => original
                .upgrade()
                .is_some_and(|original| Arc::ptr_eq(&original, catalog)),
        }
    }
}
#[cfg(test)]
#[path = "read_fence_pin_tests.rs"]
mod discovery_pin_tests;
pub(super) struct BasesReadFence {
    collection: Uuid,
    device: Uuid,
    head: Head,
    view_version: u64,
    store_generation: u64,
    repair_generation: u64,
    epoch: u64,
    ctl_chain: Hash,
    identity: SealerIdentity,
    authority: DeviceState,
    role: Role,
    catalog: CatalogPin,
    revision: Hash,
}
impl BasesReadFence {
    pub(super) fn release_discovery_catalog_pin(&mut self) {
        if let CatalogPin::Strong(catalog) = &self.catalog {
            self.catalog = CatalogPin::Discovery(Arc::downgrade(catalog));
        }
    }
    pub(super) fn discovery_catalog_allocation_bytes() -> u64 {
        (std::mem::size_of::<Catalog>() + 2 * std::mem::size_of::<usize>() + 64) as u64
    }
    pub(super) fn collection_revision(&self) -> Hash {
        self.revision
    }
}
fn not_ready() -> crate::api::ApiError {
    ErrorCode::Unavailable.err_with_reason(
        "view_read_not_ready",
        "Bases read requires healthy current keyed device state",
    )
}
impl<S: Store> Replica<S> {
    pub(super) fn bases_read_catalog(&self) -> &Arc<Catalog> {
        self.layer.catalog_ref().unwrap_or(&self.catalog)
    }
    fn bases_read_authority(&self) -> ApiResult<(SealerIdentity, DeviceState, Role)> {
        let denied = || {
            ErrorCode::Forbidden.err_with_reason(
                "view_requires_keyed_device",
                "Bases read requires a current keyed device",
            )
        };
        // Preserve the original admitted device subset; this change is about
        // local-view freshness, not extending grants or device authority.
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
        {
            return Err(not_ready());
        }
        Ok((identity, device.clone(), role))
    }
    fn bases_read_head(&self) -> ApiResult<Head> {
        let head = self.store.head().map_err(|_| not_ready())?;
        if head != self.head || self.policy.seq != head.seq {
            return Err(invalid());
        }
        Ok(head)
    }
    pub(super) fn bases_read_capture_fence(&self) -> ApiResult<BasesReadFence> {
        let (identity, authority, role) = self.bases_read_authority()?;
        let head = self.bases_read_head()?;
        let mut hash = Sha256::new();
        hash.update(b"mdbase/v1/bases-local-read-revision");
        hash.update(self.cfg.collection.0);
        hash.update(head.seq.to_be_bytes());
        hash.update(head.chain.0);
        hash.update(self.view_version.to_be_bytes());
        Ok(BasesReadFence {
            collection: self.cfg.collection,
            device: self.cfg.device_id,
            head,
            view_version: self.view_version,
            store_generation: self.store_generation,
            repair_generation: self.repair_generation,
            epoch: self.policy.epoch,
            ctl_chain: self.policy.ctl_chain,
            identity,
            authority,
            role,
            catalog: CatalogPin::Strong(self.bases_read_catalog().clone()),
            revision: B32(hash.finalize().into()),
        })
    }
    pub(super) fn recheck_bases_read_capture(&self, fence: &BasesReadFence) -> ApiResult<()> {
        let (identity, authority, role) = self.bases_read_authority()?;
        let head = self.bases_read_head()?;
        if fence.collection != self.cfg.collection
            || fence.device != self.cfg.device_id
            || fence.head != head
            || fence.view_version != self.view_version
            || fence.store_generation != self.store_generation
            || fence.repair_generation != self.repair_generation
            || fence.epoch != self.policy.epoch
            || fence.ctl_chain != self.policy.ctl_chain
            || fence.identity != identity
            || fence.authority != authority
            || fence.role != role
            || !fence.catalog.matches(self.bases_read_catalog())
        {
            return Err(invalid());
        }
        Ok(())
    }
}
