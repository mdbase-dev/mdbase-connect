//! `P(p)` itself: the device, grant and policy state, and the device and signature checks every item shares.

use super::*;

/// A device in `P`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceState {
    /// Member account (or [`SERVICE_ACCOUNT`]).
    pub account: Uuid,
    /// Kind.
    pub kind: DeviceKind,
    /// Ed25519 signing key.
    pub sign_pk: B32,
    /// X25519 KEM key.
    pub kem_pk: B32,
    /// X25519 Noise key.
    pub noise_pk: B32,
    /// Enrolled and not revoked.
    pub active: bool,
    /// Holds the current epoch key (per the log).
    pub keyed: bool,
    /// The device whose item first keyed this one (an initial rekey or a key
    /// grant). Device-local trust walks these links.
    pub introduced_by: Option<Uuid>,
    /// The device whose item delivered the current epoch key (rekey or key grant).
    pub delivered_by: Option<Uuid>,
    /// The local root this device would govern a device-located log with
    /// (`policy.md` §2.1), from its enrolment.
    pub local_root: Option<B32>,
    /// The device's current SAS commitment: from its `device-enrol` (key 7), replaced
    /// by each later `approval-request` (`sealed-envelope.md` §5.3).
    pub sas_commit: Option<B32>,
}

/// A grant in `P`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrantState {
    /// App installation.
    pub installation: Uuid,
    /// App ID (informational).
    pub app_id: String,
    /// Granting member.
    pub account: Uuid,
    /// Capabilities.
    pub capabilities: BTreeSet<String>,
    /// The installation's Noise static key.
    pub client_pk: B32,
    /// Folder restriction of the file namespace, if any (cloud copy only).
    pub file_folders: Option<Vec<String>>,
    /// The approval carries the folder scope (`e2e` only).
    pub folder_scoped: bool,
    /// Not revoked.
    pub active: bool,
    /// Capabilities of the first valid `grant_approval` (`e2e`), if any.
    pub approved: Option<BTreeSet<String>>,
    /// Folder scope from that approval.
    pub approved_folders: Option<Vec<String>>,
    /// Log position of that approval.
    pub approved_seq: Option<u64>,
    /// Device that signed that approval.
    pub approved_by: Option<Uuid>,
}

/// `P(p)`: policy state after items `1..p` (`policy.md` §6.1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PolicyState {
    /// Position of the last item applied (valid or void).
    pub seq: u64,
    /// Genesis root key ID (`None` before genesis).
    pub root: Option<B16>,
    /// The root's public key (from the trusted set).
    pub root_pk: Option<B32>,
    /// Owner account at genesis.
    pub owner: Option<Uuid>,
    /// Collection state.
    pub cstate: Option<CState>,
    /// Writers compress (default true).
    pub compress: bool,
    /// Explicit ratchet floor.
    pub min_sem_major: u64,
    /// Content appends refused.
    pub frozen: bool,
    /// `issued_at` of the last valid policy item.
    pub last_issued_at: Option<i64>,
    /// Revoked control-plane policy keys: key ID → revoked_from.
    pub revoked_cp_keys: BTreeMap<B16, i64>,
    /// Members and roles.
    pub members: BTreeMap<Uuid, Role>,
    /// Every device ever enrolled.
    pub devices: BTreeMap<Uuid, DeviceState>,
    /// Every grant ever issued.
    pub grants: BTreeMap<Uuid, GrantState>,
    /// Current key epoch (0 before the initial rekey).
    pub epoch: u64,
    /// A revocation happened with no rekey since.
    pub rekey_required: bool,
    /// Highest `sem.major` of applied entries (or `min_sem_major`, if higher).
    pub sem_ratchet: u64,
    /// `log_time(p)` (`snapshot.md` §6).
    pub log_time: i64,
    /// An `entry` or `base` has been applied (a later `base` is void).
    pub content_seen: bool,
    /// Position of the `migration-cutover`, once applied.
    pub cutover: Option<u64>,
    /// Void items so far.
    pub voids: u64,
    /// Control-chain accumulator `ctl(p)` over every control item (kinds 2–6,
    /// valid or void): `ctl(p) = H("mdbase/v1/ctl-chain", ctl(p') ‖ u64be(p) ‖
    /// chain(p))`, from 32 zero bytes (`snapshot.md` §8.1). A bootstrapping replica that read only control
    /// items compares it with the value committed for the snapshot position.
    pub ctl_chain: B32,
    /// Positions and `issued_at` of every valid policy item, by signing key ID,
    /// for the `policy_key_compromised` incident.
    pub signed_by_key: BTreeMap<B16, Vec<(u64, i64)>>,
    /// Control-plane roots that have been in force (genesis, or a handover to a
    /// pinned root). A `cp-key-revoke` may be signed by any of them (§2.1, §3).
    pub cp_roots: BTreeSet<B32>,
    /// Every (policy key ID, certifying root ID) pair of a valid policy item, as
    /// applied. `None` for a state persisted before this witness existed: its
    /// root/key attribution is unproven (a pinned warm reopen refuses it).
    pub cert_roots: Option<BTreeSet<(B16, B16)>>,
    /// Root IDs a verified `root-handover` to an owner device's local root has
    /// put in force, ever: their certified witness pairs stay attributed
    /// after a later handover. Empty for states persisted before format 3.
    pub handover_roots: BTreeSet<B16>,
}

/// The persisted [`PolicyState`] format [`PolicyState::to_bytes`] writes (4:
/// grant rows also record the folder-scoped flag and the position and signer of
/// the first valid approval). Formats 1 (unproven), 2 (no handover roots
/// recorded) and 3 are still read, with those grant fields unset.
pub const POLICY_STATE_FORMAT: u64 = 4;

impl Default for PolicyState {
    fn default() -> PolicyState {
        PolicyState::new()
    }
}

impl PolicyState {
    /// A persisted state is consistent with `pins`, checked when a store reopens
    /// under pins: its current root and every control-plane root that has been in
    /// force are pinned, and every (policy key, certifying root) pair of a valid
    /// item it applied is a published pin. Attribution comes from the persisted
    /// witness (`cert_roots`); a state without it (persisted before the witness
    /// existed) is unproven and refused: rebuild and replay under the pins. This is
    /// a store-identity check, not a cryptographic proof of currentness.
    pub fn consistent_with(&self, pins: &PolicyPins) -> bool {
        if self.seq == 0 {
            return true;
        }
        let (Some(root), Some(root_pk)) = (self.root, self.root_pk) else {
            return false;
        };
        let Some(witness) = &self.cert_roots else {
            return false;
        };
        // The owner device's local root in force now (reached only by a root
        // handover verified under the pinned root before it) certifies its own
        // keys, which are not published pins.
        let local = self.local_root_in_force().then_some(root);
        // A local root that WAS in force (R -> L, then
        // a later verified handover L -> R or L -> L') still attributes the items
        // it certified then. Only roots recorded by an applied, verified
        // `root-handover` to a local root count (`handover_roots`); a device's
        // enrolled `local_root` alone establishes nothing, and the root in force
        // must still be pinned or the local root in force.
        let handed_over = |by: &B16| self.handover_roots.contains(by);
        (pins.root(&root, &root_pk) || local.is_some())
            && self
                .cp_roots
                .iter()
                .all(|pk| pins.roots.iter().any(|r| r.root_pk == *pk))
            && witness.iter().all(|(key, by)| {
                local == Some(*by)
                    || handed_over(by)
                    || pins
                        .policy_keys
                        .iter()
                        .any(|k| k.key_id == *key && k.root_id == *by)
            })
            && self
                .signed_by_key
                .keys()
                .all(|id| witness.iter().any(|(k, _)| k == id))
    }

    /// The state before position 1.
    pub fn new() -> PolicyState {
        PolicyState {
            seq: 0,
            root: None,
            root_pk: None,
            owner: None,
            cstate: None,
            compress: true,
            min_sem_major: 0,
            frozen: false,
            last_issued_at: None,
            revoked_cp_keys: BTreeMap::new(),
            members: BTreeMap::new(),
            devices: BTreeMap::new(),
            grants: BTreeMap::new(),
            epoch: 0,
            rekey_required: false,
            sem_ratchet: 0,
            log_time: 0,
            content_seen: false,
            cutover: None,
            voids: 0,
            ctl_chain: B32([0; 32]),
            signed_by_key: BTreeMap::new(),
            cert_roots: Some(BTreeSet::new()),
            handover_roots: BTreeSet::new(),
            cp_roots: BTreeSet::new(),
        }
    }

    pub(super) fn role_of_device(&self, d: &DeviceState) -> Option<Role> {
        self.members.get(&d.account).copied()
    }

    pub(super) fn active_device(&self, id: &Uuid) -> Option<&DeviceState> {
        self.devices.get(id).filter(|d| d.active)
    }

    /// A device of a member with role ≥ editor (not a service device). The match is
    /// exhaustive on purpose: a new kind (such as `recovery`) must decide here.
    pub(super) fn editor_device(&self, d: &DeviceState) -> bool {
        match d.kind {
            DeviceKind::Desktop | DeviceKind::Mobile | DeviceKind::AppRuntime | DeviceKind::Cli => {
                self.role_of_device(d).is_some_and(|r| r >= Role::Editor)
            }
            DeviceKind::Hosted | DeviceKind::Escrow | DeviceKind::Recovery => false,
        }
    }

    /// Whether an active keyed device may serve attachment plaintext. User
    /// devices require current membership (viewers may read); hosted serves only
    /// cloud copy. Key-only escrow/recovery devices never serve file bytes.
    pub fn device_can_read(&self, device: &Uuid) -> bool {
        let Some(d) = self.active_device(device).filter(|d| d.keyed) else {
            return false;
        };
        match d.kind {
            DeviceKind::Desktop | DeviceKind::Mobile | DeviceKind::AppRuntime | DeviceKind::Cli => {
                self.role_of_device(d).is_some()
            }
            DeviceKind::Hosted => self.cstate == Some(CState::CloudCopy),
            DeviceKind::Escrow | DeviceKind::Recovery => false,
        }
    }

    /// Whether an item's signer device may write content (`entry`) now.
    pub fn device_can_write(&self, device: &Uuid) -> bool {
        let Some(d) = self.active_device(device) else {
            return false;
        };
        if !d.keyed {
            return false;
        }
        match d.kind {
            DeviceKind::Desktop | DeviceKind::Mobile | DeviceKind::AppRuntime | DeviceKind::Cli => {
                self.editor_device(d)
            }
            DeviceKind::Hosted => self.cstate == Some(CState::CloudCopy),
            DeviceKind::Escrow | DeviceKind::Recovery => false,
        }
    }

    /// Whether this device would be allowed to write content once keyed: an active
    /// device of an editor or owner (or the hosted device in cloud copy).
    pub fn device_can_write_if_keyed(&self, device: &Uuid) -> bool {
        let Some(d) = self.active_device(device) else {
            return false;
        };
        match d.kind {
            DeviceKind::Desktop | DeviceKind::Mobile | DeviceKind::AppRuntime | DeviceKind::Cli => {
                self.editor_device(d)
            }
            DeviceKind::Hosted => self.cstate == Some(CState::CloudCopy),
            DeviceKind::Escrow | DeviceKind::Recovery => false,
        }
    }

    /// Advance the control-chain accumulator for the control item at `seq`.
    pub(super) fn advance_ctl(&mut self, seq: u64, chain: &B32) {
        let mut m = Vec::with_capacity(72);
        m.extend_from_slice(&self.ctl_chain.0);
        m.extend_from_slice(&seq.to_be_bytes());
        m.extend_from_slice(&chain.0);
        self.ctl_chain = h("mdbase/v1/ctl-chain", &m);
    }

    /// Whether content appends are possible at all now.
    pub fn content_open(&self) -> bool {
        !self.frozen && !self.rekey_required && self.epoch >= 1
    }

    pub(super) fn verify_item_sig(&self, item: &Item, pk: &B32, env: &Env<'_>) -> bool {
        let (Some(sig), Ok(d)) = (item.sig.as_ref(), item.signed_digest()) else {
            return false;
        };
        env.verifier.verify(&pk.0, &d.0, &sig.0)
    }

    /// Whether `item` carries a valid signature from a signer this policy knows:
    /// a device ever enrolled (active or not), or a control-plane key certified
    /// from the trusted root (`policy` items). NOT a verdict: revocation, epochs,
    /// roles and every rule are apply's job. Used before a service-observed item
    /// may count as prefix evidence (lost-tail observer), so a service cannot
    /// fabricate a linking item without a signer's key.
    pub(crate) fn observed_signature_valid(&self, item: &Item, env: &Env<'_>) -> bool {
        match item.kind {
            ItemKind::Policy => PolicyPayload::from_bytes(&item.body.0).is_ok_and(|p| {
                let mut stall = None;
                self.check_cert(&p, item, env, &mut stall).is_ok() && stall.is_none()
            }),
            _ => item
                .signer
                .and_then(|s| self.devices.get(&s))
                .is_some_and(|d| self.verify_item_sig(item, &d.sign_pk, env)),
        }
    }

    pub(crate) fn check_device_signature(
        &self,
        item: &Item,
        env: &Env<'_>,
    ) -> Result<Uuid, Rejected> {
        let signer = item.signer.ok_or_else(|| void("V1", "no signer"))?;
        let d = self
            .active_device(&signer)
            .ok_or_else(|| void("V1", "signer is not an active device"))?;
        if !self.verify_item_sig(item, &d.sign_pk, env) {
            return Err(void("V1", "bad signature"));
        }
        Ok(signer)
    }

    /// Additive device signature check over OLD typed-known-field semantics.
    /// Parsed DATA is not authority. Caller precharges repeated hashing/work in
    /// its shared ledger and retains input/metadata leases; no owned body copy.
    pub(crate) fn check_device_signature_borrowed(
        &self,
        item: &crate::crypto::raw::BorrowedEnvelope<'_>,
        env: &Env<'_>,
    ) -> Result<Uuid, Rejected> {
        let signer = item.signer().ok_or_else(|| void("V1", "no signer"))?;
        let d = self
            .active_device(&signer)
            .ok_or_else(|| void("V1", "signer is not an active device"))?;
        let valid = match (item.signature(), item.typed_signed_digest()) {
            (Some(sig), Ok(digest)) => env.verifier.verify(&d.sign_pk.0, &digest, &sig.0),
            _ => false,
        };
        if !valid {
            return Err(void("V1", "bad signature"));
        }
        Ok(signer)
    }
}
