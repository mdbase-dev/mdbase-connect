//! Native account/collection authority for the replica's dynamic grant seam.
//!
//! Published only after durable account/registry/access publication by the daemon.
//! Sources pin an account epoch: logout/re-pair cannot revive an old source. Reads
//! fail closed on lock poisoning, missing metadata or missing monotonic leases.
//! Local owner equality is NEVER used for synced/shared authority. A synced role
//! must come from the current verified policy of the explicitly bound collection.
//! The trait wrapper follows its final interface; these methods are directly
//! testable independently of that unmerged portable interface.

use std::collections::BTreeMap;
use std::sync::{Arc, RwLock};

use mdbn_replica::policy::{EffectiveGrant, PolicyState, capability};
use mdbn_wire::common::{B16, B32};
use mdbn_wire::policy::Role;

use crate::access::AccessList;
use crate::cloud::{AccountRecord, CloudConfig};
use crate::registry::{Entry, Registry, SyncMode};

/// Canonical nonzero account UUID; zero is the replica's SERVICE_ACCOUNT.
pub fn account_id(value: &str) -> Option<B16> {
    let bytes = crate::attest::uuid_bytes(value)?;
    (bytes != [0; 16] && crate::secrets::uuid_string(&bytes) == value).then_some(B16(bytes))
}

/// Typed authority failures; no account/credential values are placed in messages.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Deny {
    /// No published authenticated account, or this source belongs to an old epoch.
    AccountMissing,
    /// Missing registration identity or a different account/device/collection.
    RegistrationMismatch,
    /// Synced/shared requires the current verified policy, not owner metadata.
    PolicyRequired,
    /// Not a current member or not that account's active native device.
    MembershipMissing,
}
impl Deny {
    /// Stable control/client problem reason.
    pub fn reason(self) -> &'static str {
        match self {
            Self::AccountMissing => "account_identity_missing",
            Self::RegistrationMismatch => "collection_account_mismatch",
            Self::PolicyRequired => "collection_policy_required",
            Self::MembershipMissing => "collection_membership_missing",
        }
    }
}

#[derive(Clone, Copy)]
struct PairedIdentity {
    account: B16,
    device: B16,
    noise_pk: Option<B32>,
}
#[derive(Default)]
struct State {
    epoch: u64,
    paired: Option<PairedIdentity>,
    entries: BTreeMap<String, Entry>,
    access: AccessList,
}

/// An account incarnation (see [`Authority::incarnation`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Incarnation {
    /// Paired account.
    pub account: B16,
    /// Durable account epoch.
    pub epoch: u64,
    /// Paired keychain device.
    pub device: B16,
}

/// Shared fail-closed projection of durably published daemon authority.
#[derive(Clone, Default)]
pub struct Authority(Arc<RwLock<State>>);
impl Authority {
    /// Fence live callers before attempting logout/credential cleanup.
    pub fn invalidate(&self, epoch: u64) {
        if let Ok(mut state) = self.0.write() {
            state.epoch = state.epoch.max(epoch);
            state.paired = None;
            state.access.leases.clear();
            state.access.monotonic_leases.clear();
        }
    }

    /// Called only after the active account fence is durable (or verified reopen).
    pub fn publish_account(
        &self,
        record: &AccountRecord,
        config: &CloudConfig,
        device: B16,
    ) -> Result<(), Deny> {
        self.publish_account_inner(record, config, device, None)
    }

    /// Native publication after OS-keychain identity load/readback. Public Noise
    /// custody comes from that held identity, never a policy/JSON mirror.
    pub fn publish_account_identity(
        &self,
        record: &AccountRecord,
        config: &CloudConfig,
        identity: &crate::secrets::DeviceIdentity,
    ) -> Result<(), Deny> {
        let key = x25519_dalek::PublicKey::from(&x25519_dalek::StaticSecret::from(
            *identity.noise_secret(),
        ));
        self.publish_account_inner(
            record,
            config,
            B16(identity.device_id),
            Some(B32(*key.as_bytes())),
        )
    }

    fn publish_account_inner(
        &self,
        record: &AccountRecord,
        config: &CloudConfig,
        device: B16,
        noise_pk: Option<B32>,
    ) -> Result<(), Deny> {
        let mut state = self.0.write().map_err(|_| Deny::AccountMissing)?;
        if record.epoch < state.epoch {
            return Err(Deny::AccountMissing);
        }
        if !record.permits(config) || device.0 == [0; 16] {
            state.paired = None;
            return Err(Deny::AccountMissing);
        }
        if record.epoch == state.epoch
            && state.paired.is_some_and(|paired| {
                Some(paired.account) != record.active_account() || paired.device != device
            })
        {
            return Err(Deny::AccountMissing);
        }
        state.epoch = record.epoch;
        state.paired = Some(PairedIdentity {
            account: record.active_account().ok_or(Deny::AccountMissing)?,
            device,
            noise_pk,
        });
        Ok(())
    }

    /// Publish only a successfully persisted registry, never app-supplied metadata.
    pub fn publish_registry(&self, registry: &Registry) {
        if let Ok(mut state) = self.0.write() {
            state.entries = registry
                .collections
                .iter()
                .map(|entry| (entry.id.clone(), entry.clone()))
                .collect();
        }
    }

    /// Publish only a successful atomic feed/access commit. Caller serializes it
    /// with account invalidation; account changes also invalidate the epoch.
    pub fn publish_access(&self, access: &AccessList) {
        if let Ok(mut state) = self.0.write() {
            state.access = access.clone();
        }
    }

    /// Current authenticated account (not derived from grants or registration).
    pub fn active_account(&self) -> Option<B16> {
        self.0.read().ok()?.paired.map(|paired| paired.account)
    }

    /// The current account incarnation: the paired account and device under the
    /// durable account epoch. An operation captures it once and compares the whole
    /// value around every await; a re-pair of the same account is a new incarnation.
    pub fn incarnation(&self) -> Option<Incarnation> {
        let state = self.0.read().ok()?;
        let paired = state.paired?;
        Some(Incarnation {
            account: paired.account,
            epoch: state.epoch,
            device: paired.device,
        })
    }

    /// Make a source bound to this collection and the current account epoch.
    /// Its methods must be called before pending app-row materialization on open.
    pub fn source(&self, collection: B16) -> Result<CollectionAuthority, Deny> {
        let state = self.0.read().map_err(|_| Deny::AccountMissing)?;
        let paired = state.paired.ok_or(Deny::AccountMissing)?;
        Ok(CollectionAuthority {
            authority: self.clone(),
            epoch: state.epoch,
            device: paired.device,
            collection,
        })
    }
}

/// Registration's local-only account/collection/keychain-device binding.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OwnerIdentity {
    /// Authenticated paired account recorded at registration.
    pub account: B16,
    /// Registered collection.
    pub collection: B16,
    /// Registered keychain device.
    pub device: B16,
}

/// Dynamic per-collection provider, independent of the app and its claimed grant.
#[derive(Clone)]
pub struct CollectionAuthority {
    authority: Authority,
    epoch: u64,
    device: B16,
    collection: B16,
}
impl CollectionAuthority {
    fn paired(&self, state: &State) -> Result<PairedIdentity, Deny> {
        let paired = state.paired.ok_or(Deny::AccountMissing)?;
        if state.epoch != self.epoch || paired.device != self.device {
            return Err(Deny::AccountMissing);
        }
        Ok(paired)
    }
    fn entry<'a>(&self, state: &'a State) -> Result<&'a Entry, Deny> {
        state
            .entries
            .get(&crate::secrets::uuid_string(&self.collection.0))
            .filter(|entry| !entry.paused)
            .ok_or(Deny::RegistrationMismatch)
    }
    fn owner(&self, state: &State) -> Result<OwnerIdentity, Deny> {
        let paired = self.paired(state)?;
        let entry = self.entry(state)?;
        if entry.mode != SyncMode::Local {
            return Err(Deny::PolicyRequired);
        }
        let account = entry
            .owner_account
            .as_deref()
            .and_then(account_id)
            .ok_or(Deny::RegistrationMismatch)?;
        let device = entry
            .device
            .as_deref()
            .and_then(account_id)
            .ok_or(Deny::RegistrationMismatch)?;
        if account != paired.account || device != paired.device {
            return Err(Deny::RegistrationMismatch);
        }
        Ok(OwnerIdentity {
            account,
            device,
            collection: self.collection,
        })
    }

    /// The paired identity is still the one this source was made for, and the
    /// registration is a current, unpaused synced collection. Re-read on every use;
    /// cached IDs are never authority on their own.
    pub fn current_synced(&self) -> Result<(), Deny> {
        let state = self.authority.0.read().map_err(|_| Deny::AccountMissing)?;
        self.paired(&state)?;
        if self.entry(&state)?.mode == SyncMode::Local {
            return Err(Deny::RegistrationMismatch);
        }
        Ok(())
    }

    /// Active independently authenticated paired account, re-read on every use.
    pub fn active_account(&self) -> Option<B16> {
        let state = self.authority.0.read().ok()?;
        self.paired(&state).ok().map(|paired| paired.account)
    }
    /// SAS lifecycle stamp, only while the pinned durable account epoch and
    /// enabled collection source are still valid. Not policy authorization.
    pub fn authority_epoch(&self) -> Option<u64> {
        let state = self.authority.0.read().ok()?;
        self.paired(&state).ok()?;
        self.entry(&state).ok()?;
        Some(self.epoch)
    }
    /// Public half of the CURRENT host-held Noise identity, account-epoch pinned.
    /// Missing keychain publication, stale account or disabled registration denies.
    pub fn device_noise_pk(&self) -> Option<B32> {
        let state = self.authority.0.read().ok()?;
        let paired = self.paired(&state).ok()?;
        self.entry(&state).ok()?;
        paired.noise_pk
    }
    /// Valid local-only registration. Synced/shared never consult local ownership.
    pub fn owner_identity(&self) -> Option<OwnerIdentity> {
        let state = self.authority.0.read().ok()?;
        self.owner(&state).ok()
    }
    /// Select collection authority by state. `policy` MUST be the replica's current
    /// verified signed-policy state, paired with that replica's collection ID;
    /// never a policy reconstructed from grants, registration or client JSON.
    pub fn authorize(&self, policy: Option<(B16, &PolicyState)>) -> Result<Role, Deny> {
        let state = self.authority.0.read().map_err(|_| Deny::AccountMissing)?;
        let paired = self.paired(&state)?;
        let entry = self.entry(&state)?;
        if entry.mode == SyncMode::Local {
            self.owner(&state)?;
            return Ok(Role::Owner);
        }
        let (collection, policy) = policy.ok_or(Deny::PolicyRequired)?;
        if collection != self.collection {
            return Err(Deny::RegistrationMismatch);
        }
        // A native daemon does not inherit the hosted-device cross-account rule.
        if !policy
            .devices
            .get(&paired.device)
            .is_some_and(|device| device.active && device.account == paired.account)
        {
            return Err(Deny::MembershipMissing);
        }
        policy
            .members
            .get(&paired.account)
            .copied()
            .ok_or(Deny::MembershipMissing)
    }

    /// Local grant under current identity, active consent, wall+monotonic lease,
    /// key and folder/capability bounds. No accountless or app-Owner fallback.
    pub fn grant(&self, grant: &B16) -> Option<EffectiveGrant> {
        let state = self.authority.0.read().ok()?;
        let owner = self.owner(&state).ok()?;
        let collection = crate::secrets::uuid_string(&self.collection.0);
        let id = crate::secrets::uuid_string(&grant.0);
        let entry = state
            .access
            .entries
            .iter()
            .find(|entry| entry.grant.collection == collection && entry.grant.grant == id)?;
        let cached = &entry.grant;
        if cached.account_id.as_deref().and_then(account_id)? != owner.account || cached.legacy_only
        {
            return None;
        }
        let client_pk: [u8; 32] = crate::secrets::hex_decode(&cached.client_pk)
            .ok()?
            .try_into()
            .ok()?;
        state
            .access
            .authorize(&collection, &id, &client_pk, crate::fsutil::now_ms() as u64)
            .ok()?;
        let writes = [
            capability::CREATE,
            capability::EDIT,
            capability::DELETE,
            capability::VIEWS,
            capability::DEFINITIONS,
        ];
        let role = if cached
            .capabilities
            .iter()
            .any(|cap| writes.contains(&cap.as_str()))
        {
            Role::Editor
        } else {
            Role::Viewer
        };
        Some(EffectiveGrant {
            account: owner.account,
            role,
            capabilities: cached.capabilities.iter().cloned().collect(),
            file_folders: cached.folders.clone(),
            client_pk: B32(client_pk),
        })
    }
}

#[cfg(test)]
#[path = "authority_tests.rs"]
mod tests;
