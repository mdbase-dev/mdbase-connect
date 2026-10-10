//! Read-only hosted evidence. Log replies arrive through the host's same-account
//! service binding authenticated with a role-0 token and ls-http PoP.
//! trusts that service for ordering/head; no independent CP freshness certificate.
//!
//! Re-observe at every operation boundary. Bootstrap eligibility is NOT app-serving
//! admission, an app grant, or permission to bypass a fault/quarantined cache.

use mdbn_wire::client::SyncMode;
use mdbn_wire::common::{B16, B32, Uuid};
use mdbn_wire::envelope::{Item, ItemKind, KeyGrantPayload};
use mdbn_wire::policy::{CState, DeviceKind};
use mdbn_wire::schema::Wire;

use super::{PolicyOrigin, Replica};
use crate::crypto::{hpke::KemKeyPair, sign::DeviceSigner};
use crate::policy::SERVICE_ACCOUNT;
use crate::seal::{KeyEvent, SealerIdentity};
use crate::store::{Head, Store};

/// RAM-only actual key-delivery provenance, never imported from POLICY. Minted
/// only after policy accepts authenticated cloud-copy key control and the sealer
/// successfully unwraps/commitment-checks the key. An outer checkpoint rolls back
/// an attempted successor; admission additionally requires the committed prefix.
#[derive(Debug, Clone, Copy)]
pub(crate) struct HostedKeyDelivery {
    collection: Uuid,
    recipient: Uuid,
    signer: Uuid,
    epoch: u64,
    seq: u64,
}

/// Live serving observation; it cannot be installed back into a replica.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostedAdmission {
    /// Serving must be denied.
    Deny(HostedAdmissionDenial),
    /// Current verified key and state, not an app grant.
    Verified(Box<VerifiedHostedAdmission>),
}

/// Initial-epoch eligibility, explicitly distinct from app-serving admission.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostedBootstrapAdmission {
    /// Do not create an initial epoch.
    Deny(HostedAdmissionDenial),
    /// Healthy authenticated epoch-zero state. No epoch key or serving right.
    Eligible(Box<VerifiedHostedBootstrap>),
}

/// Why evidence is unavailable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostedAdmissionDenial {
    /// Not the bounded, synced hosted profile.
    NotHosted,
    /// Cache fenced, stalled, installing or recovering.
    CacheUnavailable,
    /// No current-wake authenticated head observation applied through.
    HeadUnproven,
    /// No live genesis/control replay proof; snapshot activation is separate.
    PolicyOriginUnproven,
    /// Policy/head/root do not describe the same committed collection state.
    PolicyMismatch,
    /// Not an active hosted SERVICE_ACCOUNT device in cloud copy.
    MembershipInvalid,
    /// No independently derived cryptographic custody identity.
    IdentityUnavailable,
    /// Custody, host secrets or verified enrollment disagree.
    IdentityMismatch,
    /// No trusted current epoch key.
    KeyUnavailable,
    /// No actual authenticated cloud-legal delivery/unwrap in the committed prefix.
    KeyDeliveryUnproven,
    /// This collection already has an epoch; bootstrap is not a rekey API.
    EpochAlreadyCreated,
}

/// Read-only common evidence. This type does NOT attest an epoch key or serving.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VerifiedHostedBootstrap {
    identity: SealerIdentity,
    noise_pk: B32,
    applied: Head,
    authenticated: Head,
    instance: u64,
    generation: u64,
    root: B16,
    root_pk: B32,
    control_chain: B32,
}

impl VerifiedHostedBootstrap {
    /// Bound collection.
    pub fn collection(&self) -> Uuid {
        self.identity.collection
    }
    /// Bound service device.
    pub fn device(&self) -> Uuid {
        self.identity.device
    }
    /// Independently derived signing/KEM custody matched to verified enrollment.
    pub fn identity(&self) -> SealerIdentity {
        self.identity
    }
    /// Enrolled Noise public key; the host must independently check Noise custody.
    pub fn noise_pk(&self) -> B32 {
        self.noise_pk
    }
    /// Current committed applied head.
    pub fn applied_head(&self) -> Head {
        self.applied
    }
    /// Head authenticated in this wake/fault generation.
    pub fn authenticated_head(&self) -> Head {
        self.authenticated
    }
    /// Fresh wake instance; generation alone is meaningless across wakes.
    pub fn wake_instance(&self) -> u64 {
        self.instance
    }
    /// Fault generation of the head observation.
    pub fn generation(&self) -> u64 {
        self.generation
    }
    /// Verified genesis trust-root ID.
    pub fn root_id(&self) -> B16 {
        self.root
    }
    /// Independently pinned genesis trust root.
    pub fn root_pk(&self) -> B32 {
        self.root_pk
    }
    /// Verified control accumulator.
    pub fn control_chain(&self) -> B32 {
        self.control_chain
    }
}

/// Serving evidence: common authenticated context plus an actually held epoch.
/// No public constructor/setter; callers must observe again at serving boundaries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VerifiedHostedAdmission {
    context: VerifiedHostedBootstrap,
    epoch: u64,
    key_delivery_device: Uuid,
    key_delivery_seq: u64,
}

impl std::ops::Deref for VerifiedHostedAdmission {
    type Target = VerifiedHostedBootstrap;
    fn deref(&self) -> &Self::Target {
        &self.context
    }
}

impl VerifiedHostedAdmission {
    /// Current epoch with a held, commitment-checked key.
    pub fn epoch(&self) -> u64 {
        self.epoch
    }
    /// Authenticated signer that actually delivered the current epoch key.
    pub fn key_delivery_device(&self) -> Uuid {
        self.key_delivery_device
    }
    /// Authenticated control position of that delivery.
    pub fn key_delivery_seq(&self) -> u64 {
        self.key_delivery_seq
    }
}

/// Current verified approval for service delivery to one account device. This is
/// read-only context, not a caller-supplied approval/public key or reusable permit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VerifiedHostedKeyRecipient {
    sender: VerifiedHostedAdmission,
    recipient: Uuid,
    account: Uuid,
    sign_pk: B32,
    kem_pk: B32,
    noise_pk: B32,
}

impl VerifiedHostedKeyRecipient {
    /// Current serving producer proof; re-observe after any await/fault.
    pub fn sender(&self) -> &VerifiedHostedAdmission {
        &self.sender
    }
    /// Exact control-enrolled recipient ID.
    pub fn recipient(&self) -> Uuid {
        self.recipient
    }
    /// Current member account of that recipient.
    pub fn account(&self) -> Uuid {
        self.account
    }
    /// Control-enrolled signing public key.
    pub fn sign_pk(&self) -> B32 {
        self.sign_pk
    }
    /// Control-enrolled KEM public key; never taken from a request.
    pub fn kem_pk(&self) -> B32 {
        self.kem_pk
    }
    /// Control-enrolled Noise public key; host separately checks Noise custody.
    pub fn noise_pk(&self) -> B32 {
        self.noise_pk
    }
}

/// Why an account-device delivery cannot be prepared.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostedKeyOperationDenial {
    /// Producer is not currently admitted.
    Admission(HostedAdmissionDenial),
    /// Recipient is not active/currently enrolled for a member account/user kind.
    RecipientUnproven,
}

impl<S: Store> Replica<S> {
    /// Resolve account-device approval exclusively from authenticated, current
    /// policy and exact public tuple, after proving the actual held sender epoch.
    /// This does not queue/ack a key control, and must be observed at its boundary.
    pub fn verified_hosted_key_recipient(
        &self,
        recipient: Uuid,
    ) -> Result<Box<VerifiedHostedKeyRecipient>, HostedKeyOperationDenial> {
        let sender = match self.verified_hosted_admission() {
            HostedAdmission::Verified(sender) => *sender,
            HostedAdmission::Deny(denial) => {
                return Err(HostedKeyOperationDenial::Admission(denial));
            }
        };
        let device = self
            .policy
            .devices
            .get(&recipient)
            .filter(|device| {
                device.active
                    && device.account != SERVICE_ACCOUNT
                    && self.policy.members.contains_key(&device.account)
                    && matches!(
                        device.kind,
                        DeviceKind::Desktop
                            | DeviceKind::Mobile
                            | DeviceKind::AppRuntime
                            | DeviceKind::Cli
                    )
            })
            .ok_or(HostedKeyOperationDenial::RecipientUnproven)?;
        Ok(Box::new(VerifiedHostedKeyRecipient {
            sender,
            recipient,
            account: device.account,
            sign_pk: device.sign_pk,
            kem_pk: device.kem_pk,
            noise_pk: device.noise_pk,
        }))
    }

    /// Only called after accepted policy control and real key handling. The cloud
    /// state here is live authenticated control state, not a caller's mode flag.
    pub(crate) fn note_hosted_key_delivery(&mut self, p: u64, item: &Item, event: KeyEvent) {
        if !self.is_hosted() {
            return;
        }
        let for_me = match item.kind {
            ItemKind::Rekey => true,
            ItemKind::KeyGrant => KeyGrantPayload::from_bytes(&item.body.0)
                .is_ok_and(|payload| payload.recipient == self.cfg.device_id),
            _ => false,
        };
        if !for_me {
            return;
        }
        self.hosted_key_delivery = None;
        let KeyEvent::Keyed { epoch } = event else {
            return;
        };
        let Some(signer) = item.signer else {
            return;
        };
        if self.cfg.mode != SyncMode::Synced
            || self.policy.cstate != Some(CState::CloudCopy)
            || epoch != self.policy.epoch
            || !self
                .policy
                .devices
                .get(&signer)
                .is_some_and(|sender| sender.active)
            || !self
                .policy
                .devices
                .get(&self.cfg.device_id)
                .is_some_and(|device| {
                    device.active
                        && device.kind == DeviceKind::Hosted
                        && device.account == SERVICE_ACCOUNT
                        && device.keyed
                        && device.delivered_by == Some(signer)
                })
        {
            return;
        }
        self.hosted_key_delivery = Some(HostedKeyDelivery {
            collection: self.cfg.collection,
            recipient: self.cfg.device_id,
            signer,
            epoch,
            seq: p,
        });
    }

    /// Common pre-key proof. Does not treat a missing first epoch as a fault, and
    /// never treats an actual fault/unknown outcome as healthy bootstrap state.
    fn verified_hosted_context(&self) -> Result<VerifiedHostedBootstrap, HostedAdmissionDenial> {
        use HostedAdmissionDenial as D;
        if !self.is_hosted() || self.cfg.mode != SyncMode::Synced {
            return Err(D::NotHosted);
        }
        if self.check_apply_store_health().is_err()
            || self.install.is_some()
            || self.stalled.is_some()
            || self.hosted_needs_reset()
        {
            return Err(D::CacheUnavailable);
        }
        let fresh = self.hosted_fresh_head().ok_or(D::HeadUnproven)?;
        if fresh.instance != self.live.instance
            || !self.caught_up
            || self.head.seq < self.head_known
            || self.head.seq < fresh.applied.0
            || (self.head.seq == fresh.applied.0 && self.head.chain != fresh.applied.1)
            || self.head.seq < fresh.fetched.0
            || (self.head.seq == fresh.fetched.0 && self.head.chain != fresh.fetched.1)
        {
            return Err(D::HeadUnproven);
        }
        match self.hosted_policy_origin() {
            PolicyOrigin::Unproven => return Err(D::PolicyOriginUnproven),
            PolicyOrigin::Replayed { target } if target > self.head.seq => {
                return Err(D::PolicyOriginUnproven);
            }
            _ => {}
        }
        let (Some(root), Some(root_pk)) = (self.policy.root, self.policy.root_pk) else {
            return Err(D::PolicyMismatch);
        };
        if self.policy.seq != self.head.seq
            || self.cfg.collection.0 == [0; 16]
            || self.cfg.device_id.0 == [0; 16]
            || !self.cfg.trusted_roots.contains(&root_pk.0)
        {
            return Err(D::PolicyMismatch);
        }
        let device = self
            .policy
            .devices
            .get(&self.cfg.device_id)
            .ok_or(D::MembershipInvalid)?;
        if self.policy.cstate != Some(CState::CloudCopy)
            || !device.active
            || device.kind != DeviceKind::Hosted
            || device.account != SERVICE_ACCOUNT
        {
            return Err(D::MembershipInvalid);
        }
        let identity = self
            .sealer
            .public_identity()
            .ok_or(D::IdentityUnavailable)?;
        if identity.collection != self.cfg.collection
            || identity.device != self.cfg.device_id
            || identity.sign_pk != device.sign_pk
            || identity.kem_pk != device.kem_pk
            || identity.sign_pk.0 != DeviceSigner::from_seed(&self.secrets.sign_sk).public()
            || identity.kem_pk.0 != KemKeyPair::from_secret(&self.secrets.kem_sk).pk
        {
            return Err(D::IdentityMismatch);
        }
        Ok(VerifiedHostedBootstrap {
            identity,
            noise_pk: device.noise_pk,
            applied: self.head,
            authenticated: Head {
                seq: fresh.fetched.0,
                chain: fresh.fetched.1,
            },
            instance: fresh.instance,
            generation: fresh.generation,
            root,
            root_pk,
            control_chain: self.policy.ctl_chain,
        })
    }

    /// Observe initial-epoch eligibility. This does NOT authorize app traffic.
    /// Creating/signing/appending/applying the epoch control remains a separate
    /// operation; only subsequent actual unwrap/committed-prefix proof can serve.
    pub fn verified_hosted_bootstrap(&self) -> HostedBootstrapAdmission {
        use HostedBootstrapAdmission as B;
        let context = match self.verified_hosted_context() {
            Ok(context) => context,
            Err(denial) => return B::Deny(denial),
        };
        if self.policy.epoch != 0 {
            return B::Deny(HostedAdmissionDenial::EpochAlreadyCreated);
        }
        if self.key_untrusted
            || self.policy.rekey_required
            || self.policy.devices[&self.cfg.device_id].keyed
            || self.sealer.current_epoch().is_some()
        {
            return B::Deny(HostedAdmissionDenial::KeyUnavailable);
        }
        B::Eligible(Box::new(context))
    }

    /// Observe serving state. Metadata/caught-up/keyed bits cannot promote it.
    /// Unknown/Io/quarantine/Closed/wake invalidate currentness. A genuine known
    /// outer abort retains only the prior proof, never an attempted successor.
    pub fn verified_hosted_admission(&self) -> HostedAdmission {
        use HostedAdmissionDenial as D;
        let context = match self.verified_hosted_context() {
            Ok(context) => context,
            Err(denial) => return HostedAdmission::Deny(denial),
        };
        let device = &self.policy.devices[&self.cfg.device_id];
        if !device.keyed
            || self.key_untrusted
            || self.policy.rekey_required
            || self.policy.epoch == 0
            || self.sealer.current_epoch() != Some(self.policy.epoch)
        {
            return HostedAdmission::Deny(D::KeyUnavailable);
        }
        let Some(delivery) = self.hosted_key_delivery else {
            return HostedAdmission::Deny(D::KeyDeliveryUnproven);
        };
        if delivery.collection != self.cfg.collection
            || delivery.recipient != self.cfg.device_id
            || delivery.epoch != self.policy.epoch
            || delivery.seq > self.head.seq
            || device.delivered_by != Some(delivery.signer)
        {
            return HostedAdmission::Deny(D::KeyDeliveryUnproven);
        }
        HostedAdmission::Verified(Box::new(VerifiedHostedAdmission {
            context,
            epoch: self.policy.epoch,
            key_delivery_device: delivery.signer,
            key_delivery_seq: delivery.seq,
        }))
    }
}
