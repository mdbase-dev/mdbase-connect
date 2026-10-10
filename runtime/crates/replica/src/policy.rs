//! Deterministic policy evaluation at replay (`docs/contracts/policy.md` §2–§7).
//!
//! [`PolicyState`] is `P(p)`: the policy, membership, device, grant and key-epoch
//! state after applying log items `1..p`. It is a pure function of the items, so
//! two replicas at the same position always agree on it, and therefore on which
//! items are void (`log-entry.md` §4.3).
//!
//! How the replica uses it, for the item at position `p` (authorized under
//! `P(p − 1)`):
//!
//! | Item | Call | Checks |
//! |---|---|---|
//! | `policy`, `rekey`, `key_grant` | [`PolicyState::apply_control`] | signer, cp-cert, per-op validity, recipient sets; applies atomically or is void; advances `ctl_chain` |
//! | `entry` (header, before opening) | [`PolicyState::check_entry_header`] | V1 signer and signature, V2 epoch, frozen |
//! | `entry` (payload, after opening) | [`PolicyState::check_entry_payload`] | V5 semantics ratchet, V6 `on_behalf` grant |
//! | `entry` (applied) | [`PolicyState::note_entry`] | advances the ratchet and `log_time` |
//! | `base` | [`PolicyState::check_base_header`], [`PolicyState::check_base_payload`], [`PolicyState::note_base`] | `snapshot.md` §7 |
//! | `grant_approval` | [`PolicyState::apply_grant_approval`] | `policy.md` §5.1; approval required unless cloud copy with a keyed escrow |
//! | void item | [`PolicyState::note_void`] | control items still advance `ctl_chain` |
//!
//! Unknown formats and variants **stall** ([`Rejected::Stall`]): nothing is applied
//! and the replica stops before that position. Only malformed bytes are void (V4).
//!
//! Signature verification is injected ([`SigVerifier`]) so this module needs no
//! cryptography crate; the crypto layer supplies Ed25519 `verify_strict`
//! (`sealed-envelope.md` §6). Nothing here reads a clock: `issued_at` is the
//! control plane's assertion, and `log_time` comes from entries' captured instants.
//!
//! The client API uses [`PolicyState::grant_allows`] and [`capability_for`] to
//! check calls against a session's grant (`policy.md` §7).

use std::collections::{BTreeMap, BTreeSet};

use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::common::{B16, B32, Uuid};
use mdbn_wire::entry::EntryPayload;
use mdbn_wire::envelope::{Item, ItemKind, KeyGrantPayload, RekeyPayload, RekeyReason};
use mdbn_wire::hash::{h, sha256};
use mdbn_wire::intent::{Op, Source};
use mdbn_wire::policy::{
    CState, CpCert, DeviceKind, GrantApprovalPayload, PolicyOp, PolicyPayload, Role,
};
use mdbn_wire::schema::{SchemaError, Wire};

/// Verifies an Ed25519 signature over a 32-byte digest (strict, deterministic).
pub trait SigVerifier {
    /// True when `sig` is a valid signature of `digest` under `pk`.
    fn verify(&self, pk: &[u8; 32], digest: &[u8; 32], sig: &[u8; 64]) -> bool;
}

/// Inputs every check needs besides the state.
pub struct Env<'a> {
    /// Signature verification.
    pub verifier: &'a dyn SigVerifier,
    /// Control-plane root public keys this runtime trusts (`policy.md` §2): the
    /// pinned roots plus any the user added explicitly.
    pub trusted_roots: &'a [[u8; 32]],
    /// The published control-plane pins, when the host has them: every policy item's
    /// certificate must then be by a pinned root and certify a pinned policy key.
    pub policy_pins: Option<&'a PolicyPins>,
}

/// A pinned control-plane root: its key ID and public key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RootPin {
    /// `key_id(root_pk)`.
    pub root_id: B16,
    /// Ed25519 public key.
    pub root_pk: B32,
}

/// A pinned policy key, certified by a pinned root.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PolicyKeyPin {
    /// `key_id(policy_pk)`.
    pub key_id: B16,
    /// Ed25519 public key.
    pub policy_pk: B32,
    /// The root that certifies it.
    pub root_id: B16,
}

/// The control-plane keys an authenticated release publishes for an environment
/// (host-supplied, never learned from the log). Identity, not freshness: certificate
/// windows and root signatures are still checked at each item's signed time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PolicyPins {
    /// Pinned roots.
    pub roots: Vec<RootPin>,
    /// Pinned policy keys.
    pub policy_keys: Vec<PolicyKeyPin>,
}

impl PolicyPins {
    /// Well-formed pins: non-empty, IDs derived from their keys, every key a strong
    /// (canonical, not small-order) Ed25519 point, every policy key certified by a
    /// pinned root, no duplicates.
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.roots.is_empty() || self.policy_keys.is_empty() {
            return Err("policy pins need roots and policy keys");
        }
        let mut seen = BTreeSet::new();
        for r in &self.roots {
            if key_id(&r.root_pk.0) != r.root_id {
                return Err("root id is not derived from its key");
            }
            if !crate::crypto::sign::strong_public_key(&r.root_pk.0) {
                return Err("weak or non-canonical root key");
            }
            if !seen.insert(r.root_id) {
                return Err("duplicate root pin");
            }
        }
        let mut keys = BTreeSet::new();
        for k in &self.policy_keys {
            if key_id(&k.policy_pk.0) != k.key_id {
                return Err("policy key id is not derived from its key");
            }
            if !crate::crypto::sign::strong_public_key(&k.policy_pk.0) {
                return Err("weak or non-canonical policy key");
            }
            if !seen.contains(&k.root_id) {
                return Err("policy key certified by an unpinned root");
            }
            if !keys.insert(k.key_id) {
                return Err("duplicate policy key pin");
            }
        }
        Ok(())
    }

    fn root(&self, id: &B16, pk: &B32) -> bool {
        self.roots
            .iter()
            .any(|r| r.root_id == *id && r.root_pk == *pk)
    }

    fn policy_key(&self, id: &B16, pk: &B32, root: &B16) -> bool {
        self.policy_keys
            .iter()
            .any(|k| k.key_id == *id && k.policy_pk == *pk && k.root_id == *root)
    }
}

/// The all-zero account of mdbase service devices (`hosted`, `escrow`).
pub const SERVICE_ACCOUNT: Uuid = B16([0; 16]);

/// Capability groups (`policy.md` §5).
pub mod capability {
    /// Read everything.
    pub const READ: &str = "collection.read";
    /// Create records and files.
    pub const CREATE: &str = "records.create";
    /// Edit records and files.
    pub const EDIT: &str = "records.edit";
    /// Delete records and files.
    pub const DELETE: &str = "records.delete";
    /// Saved views.
    pub const VIEWS: &str = "views.manage";
    /// Resources and sync settings.
    pub const DEFINITIONS: &str = "definitions.manage";
    /// Reserved.
    pub const BACKGROUND: &str = "background.schedule";
    /// First-party offline replicas.
    pub const OFFLINE: &str = "offline.replica";
}

/// Why an item is void. `rule` is stable (`V1`..`V7`, or a policy rule name);
/// `detail` is for logs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Void {
    /// Stable rule identifier.
    pub rule: &'static str,
    /// Human-readable detail.
    pub detail: String,
}

/// Why an item could not be applied as valid.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Rejected {
    /// Void: a deterministic no-op that still occupies its position.
    Void(Void),
    /// Stall (`00-overview.md` §6.1–6.2): an unknown format or variant. The replica
    /// stops **before** this position (`upgrade_required`); nothing is applied, not
    /// even the position or the control chain. Voiding instead would let replicas
    /// of different versions disagree on `P`.
    Stall(String),
}

impl Rejected {
    /// The stable rule (`"stall"` for a stall).
    pub fn rule(&self) -> &'static str {
        match self {
            Rejected::Void(v) => v.rule,
            Rejected::Stall(_) => "stall",
        }
    }

    /// True for a stall.
    pub fn is_stall(&self) -> bool {
        matches!(self, Rejected::Stall(_))
    }
}

/// The verdict on an item.
pub type Verdict = Result<(), Rejected>;

fn void(rule: &'static str, detail: impl Into<String>) -> Rejected {
    Rejected::Void(Void {
        rule,
        detail: detail.into(),
    })
}

/// A payload decode error: unknown formats and variants stall, anything else is
/// malformed (V4).
fn decode_err(e: SchemaError) -> Rejected {
    if e.is_unknown() {
        Rejected::Stall(e.to_string())
    } else {
        void("V4", e.to_string())
    }
}

/// Something a replica must surface after applying a control item.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolicyEvent {
    /// A `cp-key-revoke` was applied (`policy.md` §3, "Revocation is not
    /// retroactive"): earlier items signed by the key with `issued_at ≥
    /// revoked_from` stay applied. Record a `policy_key_compromised` incident with
    /// their positions so an operator can check the compensating ops.
    PolicyKeyCompromised {
        /// The revoked key.
        key_id: B16,
        /// Earlier positions it signed at or after `revoked_from`.
        positions: Vec<u64>,
    },
    /// The collection state changed. Every device alerts unless its own user
    /// requested the change (`policy.md` §4.4).
    CollectionStateChanged {
        /// Before.
        from: Option<CState>,
        /// After.
        to: CState,
    },
}

/// What a grant may actually do now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EffectiveGrant {
    /// Granting member.
    pub account: Uuid,
    /// The member's role.
    pub role: Role,
    /// Capabilities in force.
    pub capabilities: BTreeSet<String>,
    /// Folder scope of the file namespace, if any.
    pub file_folders: Option<Vec<String>>,
    /// The client's Noise static key.
    pub client_pk: B32,
}

impl EffectiveGrant {
    /// Whether it holds `cap` now, bounded by its member's role.
    pub fn allows(&self, cap: &str) -> bool {
        (cap == capability::READ || self.role >= Role::Editor) && self.capabilities.contains(cap)
    }
}

/// Grants of a local-only collection, held by the host (the daemon's access list):
/// a local-only collection has no log, so no policy items carry its grants.
pub trait GrantSource {
    /// The grant as it stands now; `None` when unknown, revoked or expired.
    /// Its account must come from authenticated grant metadata, not a default.
    fn grant(&self, grant: &Uuid) -> Option<EffectiveGrant>;

    /// Independently host-authenticated local ownership, loaded from trusted
    /// durable identity/registration metadata, never inferred from a grant,
    /// policy-free local log, device UUID or SERVICE_ACCOUNT/Owner fallback.
    /// Missing provenance fails closed. Re-read for every admission/use/commit.
    fn owner_identity(&self) -> Option<LocalOwnerIdentity> {
        None
    }

    /// The daemon's currently active paired account: authenticated login response,
    /// persisted under the account activation fence and cleared on logout.
    /// Never infer this from the grant or collection registration.
    fn active_account(&self) -> Option<Uuid> {
        None
    }

    /// Durable, monotonic authority incarnation of the currently valid source.
    /// Logout/re-pair/source replacement must never revive an old stamp (even
    /// same-account ABA). Never infer from a UUID or use a configured fallback.
    /// This is a lifecycle fence, NOT authorization, freshness or readiness.
    /// Missing provenance denies private device approval.
    fn authority_epoch(&self) -> Option<u64> {
        None
    }

    /// Public Noise key of the CURRENT HOST-held device identity, bound to this
    /// valid source's account epoch/device. Never infer from policy, client data
    /// or configured constants. Native hosts publish OS-keychain-loaded custody.
    /// Missing provenance denies private approval; not PoP or readiness by itself.
    fn device_noise_pk(&self) -> Option<B32> {
        None
    }
}

/// Trusted-host local ownership binding. Merely constructing these fields is
/// not authentication: the host must establish their provenance independently
/// of the app/grant and must not synthesize a permissive fallback.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocalOwnerIdentity {
    /// Owner account recorded at LOCAL-ONLY collection registration.
    pub account: Uuid,
    /// Collection bound to that registration.
    pub collection: Uuid,
    /// Keychain device bound to that registration.
    pub device: Uuid,
}

/// Whether this device may use the collection key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyTrust {
    /// Use it.
    Trusted,
    /// This device is not keyed (yet).
    NotKeyed,
    /// The key reached this device through devices the user never approved here:
    /// `key_untrusted` incident; don't use the key.
    Untrusted {
        /// The device whose item delivered the current key.
        delivered_by: Option<Uuid>,
    },
}

/// How much of a receipt a session may see.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReceiptScope {
    /// Everything: state, position, status, record views, conflicts.
    Full,
    /// State, position and status only; no record views or conflict values.
    StateOnly,
    /// Not this session's mutation: answer `not_found`.
    Hidden,
}

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
    /// Not revoked.
    pub active: bool,
    /// Capabilities of the first valid `grant_approval` (`e2e`), if any.
    pub approved: Option<BTreeSet<String>>,
    /// Folder scope from that approval.
    pub approved_folders: Option<Vec<String>>,
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

/// The persisted [`PolicyState`] format [`PolicyState::to_bytes`] writes (3: with
/// the cert-root witness and the handover roots). Formats 1 (unproven) and 2 (no
/// handover roots recorded) are still read.
pub const POLICY_STATE_FORMAT: u64 = 3;

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

    fn role_of_device(&self, d: &DeviceState) -> Option<Role> {
        self.members.get(&d.account).copied()
    }

    fn active_device(&self, id: &Uuid) -> Option<&DeviceState> {
        self.devices.get(id).filter(|d| d.active)
    }

    /// A device of a member with role ≥ editor (not a service device). The match is
    /// exhaustive on purpose: a new kind (such as `recovery`) must decide here.
    fn editor_device(&self, d: &DeviceState) -> bool {
        match d.kind {
            DeviceKind::Desktop | DeviceKind::Mobile | DeviceKind::AppRuntime | DeviceKind::Cli => {
                self.role_of_device(d).is_some_and(|r| r >= Role::Editor)
            }
            DeviceKind::Hosted | DeviceKind::Escrow | DeviceKind::Recovery => false,
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
    fn advance_ctl(&mut self, seq: u64, chain: &B32) {
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

    fn verify_item_sig(&self, item: &Item, pk: &B32, env: &Env<'_>) -> bool {
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
            ItemKind::Policy => PolicyPayload::from_bytes(&item.body.0)
                .is_ok_and(|p| self.check_cert(&p, item, env).is_ok()),
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

    // ------------------------------------------------------------ content items

    /// V1 and V2 for an `entry`, from the clear header (`log-entry.md` §4.3).
    pub fn check_entry_header(&self, item: &Item, env: &Env<'_>) -> Verdict {
        if item.kind != ItemKind::Entry {
            return Err(void("kind", "not an entry"));
        }
        let signer = self.check_device_signature(item, env)?;
        if !self.device_can_write(&signer) {
            return Err(void("V1", "signer may not write content"));
        }
        if self.frozen {
            return Err(void("frozen", "collection is frozen"));
        }
        if self.rekey_required {
            return Err(void("V2", "rekey required"));
        }
        if item.epoch != Some(self.epoch) || self.epoch == 0 {
            return Err(void("V2", "epoch is not current"));
        }
        Ok(())
    }

    /// V5 and V6 for an opened `entry` signed by `signer`. `ctx` resolves path keys
    /// and current file paths at `p − 1` for the `file_folders` check.
    pub fn check_entry_payload(
        &self,
        payload: &EntryPayload,
        signer: &Uuid,
        ctx: &OpContext<'_>,
    ) -> Verdict {
        let ops: Vec<AnyOp<'_>> = payload.mutation.ops.iter().map(AnyOp::Legacy).collect();
        self.check_payload_ops(
            payload.sem.major,
            payload.mutation.on_behalf,
            payload.mutation.source,
            &ops,
            signer,
            ctx,
        )
    }

    /// [`Self::check_entry_payload`] for a runtime-family entry (`intent.md`
    /// §3.11): a `file_attach` needs exactly what a `file_put` of the same File
    /// needs (create or edit, and `file_folders`).
    pub fn check_runtime_entry_payload(
        &self,
        payload: &mdbn_wire::attachment_runtime_v1::EntryPayload,
        signer: &Uuid,
        ctx: &OpContext<'_>,
    ) -> Verdict {
        use mdbn_wire::attachment_runtime_v1::Op as R;
        let native = |o: &R| {
            matches!(
                o,
                R::UnindexedMarkdownPut(_)
                    | R::RecordToUnindexedMarkdown(_)
                    | R::UnindexedMarkdownToRecord(_)
            )
        };
        let native_body = payload.mutation.ops.iter().any(native)
            || payload.effects.iter().any(|e| {
                matches!(
                    e,
                    mdbn_wire::attachment_runtime_v1::Effect::PutUnindexedMarkdown(_)
                        | mdbn_wire::attachment_runtime_v1::Effect::ReindexUnindexedMarkdown(_)
                )
            })
            || payload.conflicts.iter().flatten().any(|c| {
                [Some(&c.kept), Some(&c.lost), c.base.as_ref()]
                    .into_iter()
                    .flatten()
                    .any(|v| {
                        matches!(
                            v,
                            mdbn_wire::attachment_runtime_v1::ConflictValue::UnindexedMarkdown(_)
                        )
                    })
            });
        if native_body {
            if payload.mutation.on_behalf.is_some() {
                return Err(Rejected::Stall(
                    "delegated T6b mediation is not supported".into(),
                ));
            }
            let d = self
                .active_device(signer)
                .ok_or_else(|| void("V1", "unknown T6b writer"))?;
            if !d.keyed || !self.editor_device(d) {
                return Err(void("V1", "T6b requires a keyed editor device"));
            }
            if self.frozen || self.rekey_required {
                return Err(void("V2", "T6b requires current healthy write authority"));
            }
        }
        let ops: Vec<AnyOp<'_>> = payload
            .mutation
            .ops
            .iter()
            .filter(|o| !native(o))
            .map(|o| match o {
                R::Legacy(o) => Ok(AnyOp::Legacy(o)),
                R::FileAttach(f) => Ok(AnyOp::Attach(f)),
                R::UnindexedMarkdownPut(_)
                | R::RecordToUnindexedMarkdown(_)
                | R::UnindexedMarkdownToRecord(_)
                | R::OrdinaryFileToRecord(_)
                | R::OrdinaryAttachmentContinuation(_) => Err(Rejected::Stall(
                    "extended runtime operation mediation not yet supported".into(),
                )),
            })
            .collect::<Result<_, _>>()?;
        self.check_payload_ops(
            payload.sem.major,
            payload.mutation.on_behalf,
            payload.mutation.source,
            &ops,
            signer,
            ctx,
        )
    }

    fn check_payload_ops(
        &self,
        sem_major: u64,
        on_behalf: Option<Uuid>,
        source: Source,
        ops: &[AnyOp<'_>],
        signer: &Uuid,
        ctx: &OpContext<'_>,
    ) -> Verdict {
        if sem_major < self.sem_ratchet {
            return Err(void("V5", "semantics major below the ratchet"));
        }
        let Some(grant) = on_behalf else {
            return Ok(());
        };
        let g = self
            .effective_grant(&grant)
            .ok_or_else(|| void("V6", "on_behalf grant is not active, or not approved"))?;
        // The writer is bound to the grant. Only a device of the grant's
        // own account, or the hosted replica in `cloud-copy`, writes on its behalf.
        self.devices
            .get(signer)
            .filter(|d| d.active)
            .ok_or_else(|| void("V6", "on_behalf entry from an unknown device"))?;
        if !self.writer_serves_account(signer, &g.account) {
            return Err(void(
                "V6",
                "on_behalf entry from a device of another account",
            ));
        }
        let role = g.role;
        if source != Source::Api {
            return Err(void("V6", "external mutation on behalf of a grant"));
        }
        for op in ops {
            let cap = op.capability(ctx);
            if !g.capabilities.contains(cap) {
                return Err(void("V6", format!("grant lacks {cap}")));
            }
            if cap != capability::READ && role < Role::Editor {
                return Err(void("V6", "granting member may not write"));
            }
            if let Some(folders) = &g.file_folders {
                for p in op.file_paths(ctx) {
                    if !within_folders(&p, folders, ctx.path_key) {
                        return Err(void("V6", format!("{p} is outside file_folders")));
                    }
                }
            }
        }
        Ok(())
    }

    /// Record an applied (valid) entry: semantics ratchet and log time.
    pub fn note_entry(&mut self, seq: u64, sem_major: u64, instant: i64) {
        self.seq = seq;
        self.sem_ratchet = self.sem_ratchet.max(sem_major);
        self.log_time = self.log_time.max(instant);
        self.content_seen = true;
    }

    /// Header checks for a `base` item (`snapshot.md` §7).
    pub fn check_base_header(&self, item: &Item, env: &Env<'_>) -> Verdict {
        if item.kind != ItemKind::Base {
            return Err(void("kind", "not a base"));
        }
        let signer = self.check_device_signature(item, env)?;
        let d = &self.devices[&signer];
        // Hosted signs only a `hosted-import` base, in cloud copy
        // ([`PolicyState::check_base_source`]).
        let hosted = d.kind == DeviceKind::Hosted && self.cstate == Some(CState::CloudCopy);
        if !d.keyed || !(self.editor_device(d) || hosted) {
            return Err(void(
                "V1",
                "base signer must be a keyed editor device, or hosted in cloud copy",
            ));
        }
        if self.content_seen {
            return Err(void("base", "an entry or base precedes it"));
        }
        if self.frozen {
            return Err(void("frozen", "collection is frozen"));
        }
        if self.rekey_required {
            return Err(void("V2", "rekey required"));
        }
        if item.epoch != Some(self.epoch) || self.epoch == 0 {
            return Err(void("V2", "epoch is not current"));
        }
        Ok(())
    }

    /// An opened `base` payload's source fits its signer: hosted signs only a
    /// `hosted-import` base, and only in cloud copy (policy.md, hosted migration).
    pub fn check_base_source(
        &self,
        item: &Item,
        source: mdbn_wire::snapshot::BaseSource,
    ) -> Verdict {
        let hosted = item
            .signer
            .and_then(|s| self.devices.get(&s))
            .is_some_and(|d| d.kind == DeviceKind::Hosted);
        let import = source == mdbn_wire::snapshot::BaseSource::HostedImport;
        if hosted && !(import && self.cstate == Some(CState::CloudCopy)) {
            return Err(void(
                "base",
                "hosted signs only a hosted-import base in cloud copy",
            ));
        }
        Ok(())
    }

    /// The manifest named by an opened `base` payload must be in the item's refs.
    pub fn check_base_payload(&self, item: &Item, manifest: &B32) -> Verdict {
        if item.refs.as_ref().is_some_and(|r| r.contains(manifest)) {
            Ok(())
        } else {
            Err(void("base", "manifest not in refs"))
        }
    }

    /// Borrowed equivalent of check_base_header; same OLD typed signature,
    /// predicate order/errors, role/epoch rules. No currentness/install authority.
    /// Caller precharges shared input/metadata/hash work before invocation.
    pub fn check_base_header_borrowed(
        &self,
        item: &crate::crypto::raw::BorrowedEnvelope<'_>,
        env: &Env<'_>,
    ) -> Verdict {
        if item.kind() != ItemKind::Base {
            return Err(void("kind", "not a base"));
        }
        let signer = self.check_device_signature_borrowed(item, env)?;
        let d = &self.devices[&signer];
        let hosted = d.kind == DeviceKind::Hosted && self.cstate == Some(CState::CloudCopy);
        if !d.keyed || !(self.editor_device(d) || hosted) {
            return Err(void(
                "V1",
                "base signer must be a keyed editor device, or hosted in cloud copy",
            ));
        }
        if self.content_seen {
            return Err(void("base", "an entry or base precedes it"));
        }
        if self.frozen {
            return Err(void("frozen", "collection is frozen"));
        }
        if self.rekey_required {
            return Err(void("V2", "rekey required"));
        }
        if item.epoch() != Some(self.epoch) || self.epoch == 0 {
            return Err(void("V2", "epoch is not current"));
        }
        Ok(())
    }
    /// Borrowed equivalent of check_base_source; signer/source data is NOT a
    /// signature or current policy proof. Header checks remain separately required.
    pub fn check_base_source_borrowed(
        &self,
        item: &crate::crypto::raw::BorrowedEnvelope<'_>,
        source: mdbn_wire::snapshot::BaseSource,
    ) -> Verdict {
        let hosted = item
            .signer()
            .and_then(|s| self.devices.get(&s))
            .is_some_and(|d| d.kind == DeviceKind::Hosted);
        let import = source == mdbn_wire::snapshot::BaseSource::HostedImport;
        if hosted && !(import && self.cstate == Some(CState::CloudCopy)) {
            return Err(void(
                "base",
                "hosted signs only a hosted-import base in cloud copy",
            ));
        }
        Ok(())
    }
    /// Borrowed equivalent of check_base_payload. Ref presence is not complete
    /// authenticated reference/source closure or a native install capability.
    pub fn check_base_payload_borrowed(
        &self,
        item: &crate::crypto::raw::BorrowedEnvelope<'_>,
        manifest: &B32,
    ) -> Verdict {
        if item.refs().is_some_and(|r| r.contains(manifest)) {
            Ok(())
        } else {
            Err(void("base", "manifest not in refs"))
        }
    }

    /// Record an applied `base` at `seq` with chain hash `chain` (a control item:
    /// it advances `ctl_chain`).
    pub fn note_base(&mut self, seq: u64, chain: &B32) {
        self.advance_ctl(seq, chain);
        self.seq = seq;
        self.content_seen = true;
    }

    /// Record a void item: it still occupies its position. Pass `chain` for a
    /// control item (kinds 2–6, including a void `base` or `grant_approval`), so the
    /// control chain covers it; `None` for an `entry`.
    pub fn note_void(&mut self, seq: u64, control_chain: Option<&B32>) {
        if let Some(c) = control_chain {
            self.advance_ctl(seq, c);
        }
        self.seq = seq;
        self.voids += 1;
    }

    // ------------------------------------------------------------ control items

    /// Apply a control item (`policy`, `rekey`, `key_grant`) at position `seq`,
    /// whose complete item bytes hash to `chain` (`chain(seq)`).
    ///
    /// - **Valid:** applied atomically; returns events to surface.
    /// - **Void:** only the position, the void count and the control chain change.
    /// - **Stall** ([`Rejected::Stall`]): nothing changes at all; the replica stops
    ///   before `seq` and reports `upgrade_required`.
    pub fn apply_control(
        &mut self,
        seq: u64,
        chain: &B32,
        item: &Item,
        env: &Env<'_>,
    ) -> Result<Vec<PolicyEvent>, Rejected> {
        let mut next = self.clone();
        let mut events = Vec::new();
        let r = match item.kind {
            ItemKind::Policy => next.policy_item(seq, item, env, &mut events),
            ItemKind::Rekey => next.rekey_item(item, env),
            ItemKind::KeyGrant => next.key_grant_item(item, env),
            _ => Err(void("kind", "not a control item")),
        };
        match r {
            Ok(()) => {
                next.advance_ctl(seq, chain);
                next.seq = seq;
                *self = next;
                Ok(events)
            }
            Err(Rejected::Stall(s)) => Err(Rejected::Stall(s)),
            Err(v) => {
                self.note_void(seq, Some(chain));
                Err(v)
            }
        }
    }

    /// Apply a `grant_approval` item (kind 6, `policy.md` §5.1) at `seq`. The item
    /// is sealed, so the replica opens it first and passes the decoded payload, or
    /// the decode error (unknown → stall, malformed → void; an AEAD failure is the
    /// caller's V3 void via [`PolicyState::note_void`]). Void and valid items
    /// advance the control chain.
    pub fn apply_grant_approval(
        &mut self,
        seq: u64,
        chain: &B32,
        item: &Item,
        approval: Result<&GrantApprovalPayload, SchemaError>,
        env: &Env<'_>,
    ) -> Verdict {
        let r = approval
            .map_err(decode_err)
            .and_then(|a| self.check_grant_approval(item, a, env).map(|()| a));
        match r {
            Ok(a) => {
                if let Some(g) = self.grants.get_mut(&a.grant) {
                    g.approved = Some(a.capabilities.iter().cloned().collect());
                    g.approved_folders = a.file_folders.clone();
                }
                self.advance_ctl(seq, chain);
                self.seq = seq;
                Ok(())
            }
            Err(Rejected::Stall(s)) => Err(Rejected::Stall(s)),
            Err(v) => {
                self.note_void(seq, Some(chain));
                Err(v)
            }
        }
    }

    fn check_grant_approval(
        &self,
        item: &Item,
        a: &GrantApprovalPayload,
        env: &Env<'_>,
    ) -> Verdict {
        if item.kind != ItemKind::GrantApproval {
            return Err(void("kind", "not a grant_approval"));
        }
        let signer = self.check_device_signature(item, env)?;
        let d = &self.devices[&signer];
        if !d.keyed || self.role_of_device(d).is_none() {
            return Err(void(
                "grant_approval",
                "signer is not a keyed member device",
            ));
        }
        if !matches!(
            d.kind,
            DeviceKind::Desktop | DeviceKind::Mobile | DeviceKind::AppRuntime | DeviceKind::Cli
        ) {
            return Err(void(
                "grant_approval",
                "service devices never approve grants",
            ));
        }
        if self.rekey_required || item.epoch != Some(self.epoch) || self.epoch == 0 {
            return Err(void("V2", "rekey required, or epoch is not current"));
        }
        let g = self
            .grants
            .get(&a.grant)
            .filter(|g| g.active)
            .ok_or_else(|| void("grant_approval", "grant is not active"))?;
        if g.account != d.account || !self.members.contains_key(&g.account) {
            return Err(void(
                "grant_approval",
                "signer is not a device of the granting member",
            ));
        }
        if g.approved.is_some() {
            return Err(void("grant_approval", "already approved"));
        }
        if g.client_pk != a.client_pk {
            return Err(void("grant_approval", "client_pk differs from the grant"));
        }
        if a.capabilities.is_empty() || !a.capabilities.iter().all(|c| g.capabilities.contains(c)) {
            return Err(void(
                "grant_approval",
                "capabilities are not a non-empty subset",
            ));
        }
        Ok(())
    }

    fn policy_item(
        &mut self,
        seq: u64,
        item: &Item,
        env: &Env<'_>,
        events: &mut Vec<PolicyEvent>,
    ) -> Verdict {
        let p = PolicyPayload::from_bytes(&item.body.0).map_err(decode_err)?;
        let is_genesis_item = p.ops.iter().any(|o| matches!(o, PolicyOp::Genesis(_)));
        if seq == 1 {
            let Some(PolicyOp::Genesis(g)) = p.ops.first() else {
                return Err(void("genesis", "the first item must be a genesis policy"));
            };
            let pk = env
                .trusted_roots
                .iter()
                .find(|pk| key_id(pk) == g.root)
                .ok_or_else(|| void("genesis", "root is not trusted"))?;
            self.root = Some(g.root);
            self.root_pk = Some(B32(*pk));
            self.cp_roots.insert(B32(*pk));
        } else if is_genesis_item {
            return Err(void("genesis", "genesis only at position 1"));
        }
        self.check_cert(&p, item, env)?;
        let cstate_before = self.cstate;
        for op in &p.ops {
            self.policy_op(seq, item.collection, op, env, events)?;
        }
        // Service devices are allowed only in cloud copy: an escrow or hosted device
        // enrolled while the collection stays e2e is void.
        if self.cstate != Some(CState::CloudCopy)
            && p.ops.iter().any(|o| {
                matches!(o, PolicyOp::DeviceEnrol(e) if matches!(e.kind, DeviceKind::Escrow | DeviceKind::Hosted))
            })
        {
            return Err(void("device-enrol", "service device in an e2e collection"));
        }
        if let Some(to) = self.cstate
            && cstate_before.is_some()
            && cstate_before != Some(to)
        {
            events.push(PolicyEvent::CollectionStateChanged {
                from: cstate_before,
                to,
            });
        }
        let kid = p.cert.key_id();
        self.signed_by_key
            .entry(kid)
            .or_default()
            .push((seq, p.issued_at));
        if let Some(w) = self.cert_roots.as_mut() {
            w.insert((kid, p.cert.root));
        }
        // Switching to e2e: no escrow/hosted may remain active after the item.
        if p.ops
            .iter()
            .any(|o| matches!(o, PolicyOp::CollectionState(c) if c.state == CState::E2e))
            && self
                .devices
                .values()
                .any(|d| d.active && matches!(d.kind, DeviceKind::Escrow | DeviceKind::Hosted))
        {
            return Err(void(
                "collection-state",
                "escrow or hosted device still active",
            ));
        }
        self.last_issued_at = Some(p.issued_at);
        Ok(())
    }

    fn check_cert(&self, p: &PolicyPayload, item: &Item, env: &Env<'_>) -> Verdict {
        let (Some(root), Some(root_pk)) = (self.root, self.root_pk) else {
            return Err(void("cp-cert", "no genesis"));
        };
        let c: &CpCert = &p.cert;
        if c.root != root {
            return Err(void(
                "cp-cert",
                "certificate root differs from genesis root",
            ));
        }
        // Pins publish the control plane's roots and keys. Under an owner device's
        // local root (after a root handover verified under the pinned root) the
        // local root certifies its own keys, so pins do not apply (`policy.md` §2.1).
        if let Some(pins) = env.policy_pins
            && !self.local_root_in_force()
        {
            if !pins.root(&root, &root_pk) {
                return Err(void("cp-cert", "root is not a published pin"));
            }
            if !pins.policy_key(&c.key_id(), &c.policy_pk, &root) {
                return Err(void("cp-cert", "policy key is not a published pin"));
            }
        }
        let digest = c
            .signed_digest()
            .map_err(|e| void("cp-cert", e.to_string()))?;
        if !env.verifier.verify(&root_pk.0, &digest.0, &c.sig.0) {
            return Err(void("cp-cert", "bad root signature on certificate"));
        }
        if item.signer != Some(c.key_id()) {
            return Err(void("cp-cert", "signer is not the certified key"));
        }
        if !self.verify_item_sig(item, &c.policy_pk, env) {
            return Err(void("cp-cert", "bad item signature"));
        }
        if p.issued_at < c.not_before || p.issued_at > c.not_after {
            return Err(void("cp-cert", "issued outside the certificate window"));
        }
        if self.last_issued_at.is_some_and(|t| p.issued_at < t) {
            return Err(void("cp-cert", "issued_at goes backwards"));
        }
        if self
            .revoked_cp_keys
            .get(&c.key_id())
            .is_some_and(|from| *from <= p.issued_at)
        {
            return Err(void("cp-cert", "policy key revoked"));
        }
        Ok(())
    }

    fn only_owner(&self, account: &Uuid) -> bool {
        self.members.get(account) == Some(&Role::Owner)
            && self.members.values().filter(|r| **r == Role::Owner).count() == 1
    }

    fn revoke_device(&mut self, id: &Uuid) {
        if let Some(d) = self.devices.get_mut(id)
            && d.active
        {
            d.active = false;
            d.keyed = false;
            self.rekey_required = true;
        }
    }

    fn policy_op(
        &mut self,
        seq: u64,
        collection: Uuid,
        op: &PolicyOp,
        env: &Env<'_>,
        events: &mut Vec<PolicyEvent>,
    ) -> Verdict {
        match op {
            PolicyOp::Genesis(g) => {
                if seq != 1 || self.owner.is_some() {
                    return Err(void("genesis", "exactly one genesis, at position 1"));
                }
                self.owner = Some(g.owner);
                self.cstate = Some(g.state);
            }
            PolicyOp::DeviceEnrol(e) => {
                if self.devices.contains_key(&e.device) {
                    return Err(void("device-enrol", "device ID already enrolled"));
                }
                let service = matches!(e.kind, DeviceKind::Hosted | DeviceKind::Escrow);
                let ok = if service {
                    e.account == SERVICE_ACCOUNT
                } else {
                    self.members.contains_key(&e.account)
                };
                if !ok {
                    return Err(void("device-enrol", "account is not a member"));
                }
                // A `recovery` device has an all-zero `noise_pk`; no other kind may.
                let zero_noise = e.noise_pk.0.iter().all(|b| *b == 0);
                if zero_noise != (e.kind == DeviceKind::Recovery) {
                    return Err(void(
                        "device-enrol",
                        "noise_pk is all-zero exactly for recovery",
                    ));
                }
                self.devices.insert(
                    e.device,
                    DeviceState {
                        account: e.account,
                        kind: e.kind,
                        sign_pk: e.sign_pk,
                        kem_pk: e.kem_pk,
                        noise_pk: e.noise_pk,
                        active: true,
                        keyed: false,
                        introduced_by: None,
                        delivered_by: None,
                        local_root: e.local_root,
                        sas_commit: e.sas_commit,
                    },
                );
            }
            PolicyOp::DeviceRevoke(r) => {
                if self.active_device(&r.device).is_none() {
                    return Err(void("device-revoke", "device is not active"));
                }
                self.revoke_device(&r.device);
            }
            PolicyOp::MemberSet(m) => {
                if m.account == SERVICE_ACCOUNT {
                    return Err(void("member-set", "the service account is never a member"));
                }
                if m.role != Role::Owner && self.only_owner(&m.account) {
                    return Err(void("member-set", "would demote the only owner"));
                }
                self.members.insert(m.account, m.role);
            }
            PolicyOp::MemberRemove(m) => {
                if !self.members.contains_key(&m.account) || self.only_owner(&m.account) {
                    return Err(void("member-remove", "not a member, or the only owner"));
                }
                self.members.remove(&m.account);
                let devs: Vec<Uuid> = self
                    .devices
                    .iter()
                    .filter(|(_, d)| d.account == m.account)
                    .map(|(id, _)| *id)
                    .collect();
                for d in devs {
                    self.revoke_device(&d);
                }
                for g in self.grants.values_mut() {
                    if g.account == m.account {
                        g.active = false;
                    }
                }
                self.rekey_required = true;
            }
            PolicyOp::Grant(g) => {
                if self.grants.contains_key(&g.grant) {
                    return Err(void("grant", "grant ID already used"));
                }
                let read_only = g.capabilities.iter().all(|c| c == capability::READ);
                let ok = match self.members.get(&g.account) {
                    Some(r) if *r >= Role::Editor => true,
                    Some(Role::Viewer) => read_only,
                    _ => false,
                };
                if !ok {
                    return Err(void("grant", "granting account may not grant this"));
                }
                // In e2e the folder scope travels sealed in the approval.
                if self.grant_approval_required() && g.file_folders.is_some() {
                    return Err(void("grant", "file_folders in clear in an e2e collection"));
                }
                self.grants.insert(
                    g.grant,
                    GrantState {
                        installation: g.installation,
                        app_id: g.app_id.clone(),
                        account: g.account,
                        capabilities: g.capabilities.iter().cloned().collect(),
                        client_pk: g.client_pk,
                        file_folders: g.file_folders.clone(),
                        active: true,
                        approved: None,
                        approved_folders: None,
                    },
                );
            }
            PolicyOp::GrantRevoke(r) => match self.grants.get_mut(&r.grant) {
                Some(g) if g.active => g.active = false,
                _ => return Err(void("grant-revoke", "grant is not active")),
            },
            PolicyOp::CollectionState(c) => {
                if c.state == CState::CloudCopy
                    && !self
                        .devices
                        .values()
                        .any(|d| d.active && d.kind == DeviceKind::Escrow)
                {
                    return Err(void(
                        "collection-state",
                        "cloud copy needs an escrow device",
                    ));
                }
                self.cstate = Some(c.state);
                if let Some(cmp) = c.compress {
                    self.compress = cmp;
                }
                if let Some(m) = c.min_sem_major {
                    self.min_sem_major = self.min_sem_major.max(m);
                    self.sem_ratchet = self.sem_ratchet.max(m);
                }
            }
            PolicyOp::CpKeyRevoke(r) => {
                if self.cp_roots.is_empty() {
                    return Err(void("cp-key-revoke", "no genesis"));
                }
                let msg = Cbor::Array(vec![r.key_id.to_cbor(), Cbor::int(r.revoked_from)]);
                let bytes = cbor::encode(&msg).map_err(|e| void("cp-key-revoke", e.to_string()))?;
                let d = h("mdbase/v1/cp-key-revoke", &bytes);
                if !self
                    .cp_roots
                    .iter()
                    .any(|pk| env.verifier.verify(&pk.0, &d.0, &r.root_sig.0))
                {
                    return Err(void("cp-key-revoke", "bad root signature"));
                }
                let positions: Vec<u64> = self
                    .signed_by_key
                    .get(&r.key_id)
                    .into_iter()
                    .flatten()
                    .filter(|(_, at)| *at >= r.revoked_from)
                    .map(|(p, _)| *p)
                    .collect();
                events.push(PolicyEvent::PolicyKeyCompromised {
                    key_id: r.key_id,
                    positions,
                });
                let e = self
                    .revoked_cp_keys
                    .entry(r.key_id)
                    .or_insert(r.revoked_from);
                *e = (*e).min(r.revoked_from);
            }
            PolicyOp::RootHandover(rh) => {
                let consent = rh.consent_digest(&collection, seq);
                let od = self
                    .active_device(&rh.owner_device)
                    .filter(|d| d.keyed && self.members.get(&d.account) == Some(&Role::Owner))
                    .ok_or_else(|| {
                        void("root-handover", "owner_device is not a keyed owner device")
                    })?;
                if !matches!(
                    od.kind,
                    DeviceKind::Desktop
                        | DeviceKind::Mobile
                        | DeviceKind::AppRuntime
                        | DeviceKind::Cli
                ) {
                    return Err(void(
                        "root-handover",
                        "owner_device is a service or recovery device",
                    ));
                }
                if !env
                    .verifier
                    .verify(&od.sign_pk.0, &consent.0, &rh.consent.0)
                {
                    return Err(void("root-handover", "bad owner consent"));
                }
                let to_cp = env.trusted_roots.contains(&rh.new_root.0);
                let to_local = od.local_root == Some(rh.new_root);
                if !(to_cp || to_local) {
                    return Err(void("root-handover", "target root not allowed"));
                }
                // In a cloud copy the control plane
                // (enrolling an owner-account device with its own sign key and
                // local root) plus escrow (keying it) must not reach a local root,
                // which would take the log out from under the pins. A local root
                // is reachable only from an owner device a user's device vouched
                // for (its `introduced_by` chain never passes a service device).
                if to_local
                    && self.cstate == Some(CState::CloudCopy)
                    && self.introduced_via_service(&rh.owner_device)
                {
                    return Err(void(
                        "root-handover",
                        "owner device keyed through a service device",
                    ));
                }
                self.root = Some(key_id(&rh.new_root.0));
                self.root_pk = Some(rh.new_root);
                if to_cp {
                    self.cp_roots.insert(rh.new_root);
                } else {
                    self.handover_roots.insert(key_id(&rh.new_root.0));
                }
            }
            PolicyOp::MigrationCutover(_) => {
                if self.cutover.is_some() {
                    return Err(void("migration-cutover", "already cut over"));
                }
                self.cutover = Some(seq);
            }
            PolicyOp::Freeze(f) => self.frozen = f.frozen,
            PolicyOp::ApprovalRequest(r) => {
                let Some(d) = self.devices.get_mut(&r.device).filter(|d| d.active) else {
                    return Err(void("approval-request", "device is not active"));
                };
                if d.keyed {
                    return Err(void("approval-request", "device is already keyed"));
                }
                if !matches!(
                    d.kind,
                    DeviceKind::Desktop
                        | DeviceKind::Mobile
                        | DeviceKind::AppRuntime
                        | DeviceKind::Cli
                ) {
                    return Err(void("approval-request", "only member devices are approved"));
                }
                d.sas_commit = Some(r.sas_commit);
            }
        }
        Ok(())
    }

    /// Devices a non-initial rekey must wrap for: enrolled, active and keyed.
    pub fn rekey_recipients(&self) -> BTreeSet<Uuid> {
        self.devices
            .iter()
            .filter(|(_, d)| d.active && d.keyed)
            .map(|(id, _)| *id)
            .collect()
    }

    fn rekey_item(&mut self, item: &Item, env: &Env<'_>) -> Verdict {
        let p = RekeyPayload::from_bytes(&item.body.0).map_err(decode_err)?;
        let signer = self.check_device_signature(item, env)?;
        if self.root.is_none() {
            return Err(void("rekey", "no genesis"));
        }
        if p.from != self.epoch || p.epoch != p.from + 1 {
            return Err(void(
                "rekey",
                "from is not the current epoch, or epoch != from + 1",
            ));
        }
        let recipients: BTreeSet<Uuid> = p.wraps.iter().map(|w| w.device).collect();
        if recipients.len() != p.wraps.len() {
            return Err(void("rekey", "more than one wrap per recipient"));
        }
        let d = &self.devices[&signer];
        let cloud = self.cstate == Some(CState::CloudCopy);
        let service = |kind: DeviceKind| matches!(kind, DeviceKind::Hosted | DeviceKind::Escrow);
        // Private (e2e) mode: no hosted or escrow signer or recipient for any rekey
        // Inactive service rows stay as history.
        if !cloud
            && (service(d.kind)
                || recipients
                    .iter()
                    .any(|r| self.devices.get(r).is_some_and(|x| service(x.kind))))
        {
            return Err(void(
                "rekey",
                "no hosted or escrow signer or recipient in e2e",
            ));
        }
        if p.from == 0 {
            if p.reason != RekeyReason::Initial {
                return Err(void("rekey", "the first rekey must be initial"));
            }
            // An owner/editor user device, or in cloud copy hosted as the first keyed
            // replica of a service-created collection (sealed-envelope.md §5.2, §7.1).
            if !(self.editor_device(d) || (cloud && d.kind == DeviceKind::Hosted)) {
                return Err(void(
                    "rekey",
                    "initial rekey signer must be an editor device, or hosted in cloud copy",
                ));
            }
            if !recipients.iter().all(|r| self.active_device(r).is_some()) {
                return Err(void("rekey", "initial recipients must be active devices"));
            }
            if !recipients.contains(&signer) {
                return Err(void("rekey", "initial rekey must include the signer"));
            }
            // Cloud copy: the initial epoch reaches the escrow and every active hosted.
            if cloud
                && (!self.devices.iter().any(|(id, d)| {
                    d.active && d.kind == DeviceKind::Escrow && recipients.contains(id)
                }) || self.devices.iter().any(|(id, d)| {
                    d.active && d.kind == DeviceKind::Hosted && !recipients.contains(id)
                }))
            {
                return Err(void(
                    "rekey",
                    "initial rekey in cloud copy must include the escrow and hosted",
                ));
            }
        } else {
            if !d.keyed {
                return Err(void("rekey", "signer is not keyed"));
            }
            // The account key is a rekey recipient only; it
            // never signs one. A user device of the account rekeys after recovery.
            if d.kind == DeviceKind::Recovery {
                return Err(void("rekey", "a recovery device does not sign rekeys"));
            }
            if recipients != self.rekey_recipients() {
                return Err(void(
                    "rekey",
                    "recipients are not exactly the keyed active devices",
                ));
            }
        }
        for dev in self.devices.values_mut() {
            dev.keyed = false;
        }
        for r in &recipients {
            if let Some(dev) = self.devices.get_mut(r) {
                dev.keyed = true;
                dev.introduced_by.get_or_insert(signer);
                dev.delivered_by = Some(signer);
            }
        }
        self.epoch = p.epoch;
        self.rekey_required = false;
        Ok(())
    }

    fn key_grant_item(&mut self, item: &Item, env: &Env<'_>) -> Verdict {
        let p = KeyGrantPayload::from_bytes(&item.body.0).map_err(decode_err)?;
        let signer = self.check_device_signature(item, env)?;
        let d = &self.devices[&signer];
        if !d.keyed {
            return Err(void("key_grant", "signer is not keyed"));
        }
        let cloud = self.cstate == Some(CState::CloudCopy);
        let editor = self.editor_device(d);
        // Cloud copy only: hosted, or escrow if hosted is
        // unavailable, keys control-approved account devices (enrolled for a member
        // account), never service or recovery devices.
        let service = cloud && matches!(d.kind, DeviceKind::Hosted | DeviceKind::Escrow);
        // The account key (AK1, private-account-key.md §4): a member account's
        // recovery device keys only that account's own user devices, and only in
        // private (e2e) mode. The user's password or recovery key is the approval.
        // Any member role: a viewer's own devices need the epoch
        // key to read, and the recipient is always the signer's own account.
        let recovery = d.kind == DeviceKind::Recovery && self.members.contains_key(&d.account);
        if !(editor || service || recovery) {
            return Err(void("key_grant", "signer may not grant keys"));
        }
        if recovery {
            if cloud {
                return Err(void("key_grant", "recovery devices grant keys only in e2e"));
            }
            let same_account_user_device = self.devices.get(&p.recipient).is_some_and(|r| {
                matches!(
                    r.kind,
                    DeviceKind::Desktop
                        | DeviceKind::Mobile
                        | DeviceKind::AppRuntime
                        | DeviceKind::Cli
                ) && r.account == d.account
            });
            if !same_account_user_device {
                return Err(void(
                    "key_grant",
                    "a recovery device keys only its own account's user devices",
                ));
            }
        }
        // Private (e2e) mode: never to a hosted or escrow device.
        if !cloud
            && self
                .devices
                .get(&p.recipient)
                .is_some_and(|r| matches!(r.kind, DeviceKind::Hosted | DeviceKind::Escrow))
        {
            return Err(void("key_grant", "no hosted or escrow recipient in e2e"));
        }
        if service
            && !self.devices.get(&p.recipient).is_some_and(|r| {
                matches!(
                    r.kind,
                    DeviceKind::Desktop
                        | DeviceKind::Mobile
                        | DeviceKind::AppRuntime
                        | DeviceKind::Cli
                ) && self.members.contains_key(&r.account)
            })
        {
            return Err(void(
                "key_grant",
                "hosted and escrow grant keys only to a member account's device",
            ));
        }
        if p.epoch != self.epoch || self.epoch == 0 {
            return Err(void("key_grant", "epoch is not current"));
        }
        if p.wrap.device != p.recipient {
            return Err(void("key_grant", "wrap is for another device"));
        }
        let Some(r) = self.devices.get_mut(&p.recipient).filter(|r| r.active) else {
            return Err(void("key_grant", "recipient is not an active device"));
        };
        r.keyed = true;
        r.introduced_by.get_or_insert(signer);
        r.delivered_by = Some(signer);
        Ok(())
    }

    // ------------------------------------------------------------ client API

    /// Whether grants need a device approval at this position (`policy.md` §5.1):
    /// always, except in a `cloud-copy` collection whose escrow
    /// device is active and keyed (proof that a user's device handed it the key)
    /// and whose log is not device-located (governed by a device's local root).
    pub fn grant_approval_required(&self) -> bool {
        let escrow_keyed = self
            .devices
            .values()
            .any(|d| d.kind == DeviceKind::Escrow && d.active && d.keyed);
        !(self.cstate == Some(CState::CloudCopy) && escrow_keyed && !self.device_located())
    }

    /// Whether `device`'s keying chain (`introduced_by`) fails to reach a
    /// self-introduced device (the creator's initial rekey) through user devices
    /// only. Fails closed: a service device on the chain, a missing link
    /// (`introduced_by` unset or an unknown device) and a cycle all count as
    /// "via service". Bounded by the number of devices.
    fn introduced_via_service(&self, device: &Uuid) -> bool {
        let mut cur = *device;
        let mut seen = BTreeSet::new();
        loop {
            if !seen.insert(cur) {
                return true; // cycle
            }
            let Some(d) = self.devices.get(&cur) else {
                return true; // unknown device
            };
            if matches!(d.kind, DeviceKind::Escrow | DeviceKind::Hosted) {
                return true;
            }
            match d.introduced_by {
                Some(next) if next == cur => return false, // self-introduced
                Some(next) => cur = next,
                None => return true, // missing link: unproven
            }
        }
    }

    /// The root in force is an enrolled device's `local_root` and not a control-plane
    /// root (the only way there is a root handover to it).
    fn local_root_in_force(&self) -> bool {
        let Some(root_pk) = self.root_pk else {
            return false;
        };
        // The root ID and key are one identity, as for a published pin.
        self.root == Some(key_id(&root_pk.0))
            && !self.cp_roots.contains(&root_pk)
            && self.device_located()
    }

    /// The root in force is some enrolled device's `local_root` (`policy.md` §2.1).
    pub fn device_located(&self) -> bool {
        let Some(root) = self.root_pk else {
            return false;
        };
        self.devices.values().any(|d| d.local_root == Some(root))
    }

    /// What a grant may do now (`policy.md` §5.1, §7): active, its member still a
    /// member. Where approval is required ([`PolicyState::grant_approval_required`])
    /// only with a valid approval, and then the approved capabilities and folders;
    /// an unapproved grant authorizes nothing. Otherwise the grant op as
    /// written.
    pub fn effective_grant(&self, grant: &Uuid) -> Option<EffectiveGrant> {
        let g = self.grants.get(grant).filter(|g| g.active)?;
        let role = *self.members.get(&g.account)?;
        let (capabilities, file_folders) = if !self.grant_approval_required() {
            (g.capabilities.clone(), g.file_folders.clone())
        } else {
            let approved = g.approved.as_ref()?;
            (
                g.capabilities.intersection(approved).cloned().collect(),
                g.approved_folders.clone(),
            )
        };
        Some(EffectiveGrant {
            account: g.account,
            role,
            capabilities,
            file_folders,
            client_pk: g.client_pk,
        })
    }

    /// Whether a grant holds a capability now, bounded by its member's role.
    pub fn grant_allows(&self, grant: &Uuid, cap: &str) -> bool {
        self.effective_grant(grant).is_some_and(|g| g.allows(cap))
    }

    /// An active device serves grants of its own account, or any member
    /// account only when it is the hosted device of a cloud-copy collection.
    pub fn writer_serves_account(&self, device: &Uuid, account: &Uuid) -> bool {
        self.devices.get(device).is_some_and(|d| {
            d.active
                && (d.account == *account
                    || (d.kind == DeviceKind::Hosted && self.cstate == Some(CState::CloudCopy)))
        })
    }

    /// The effective grant for a session whose Noise static key is `client_pk`
    /// (`replica-client-api.md` §12.3). `None`: refuse the session.
    pub fn grant_for_client(&self, grant: &Uuid, client_pk: &[u8; 32]) -> Option<EffectiveGrant> {
        self.effective_grant(grant)
            .filter(|g| g.client_pk.0 == *client_pk)
    }

    /// Device-local key trust (`sealed-envelope.md` §5.2 local acceptance rule).
    /// This device uses the current key only if the chain of devices
    /// that delivered it (the current key's deliverer, then each device's
    /// introducer) reaches this device itself or a device in `trusted_signers`:
    /// devices approved through SAS here in either direction, and a recovery device
    /// whose keys this device derived. All of that is replica-local, never part of
    /// `P`.
    ///
    /// `user_enabled_cloud_copy` is a **device-local** flag: this device's user
    /// turned cloud copy on here. Only then is the escrow trusted by choice. The
    /// log's `cstate` is never enough: the control plane writes it.
    pub fn key_trust(
        &self,
        me: &Uuid,
        trusted_signers: &BTreeSet<Uuid>,
        user_enabled_cloud_copy: bool,
    ) -> KeyTrust {
        let Some(d) = self.devices.get(me).filter(|d| d.active && d.keyed) else {
            return KeyTrust::NotKeyed;
        };
        if user_enabled_cloud_copy && self.cstate == Some(CState::CloudCopy) {
            return KeyTrust::Trusted;
        }
        let mut seen = BTreeSet::new();
        let mut cur = d.delivered_by;
        while let Some(x) = cur {
            if x == *me || trusted_signers.contains(&x) {
                return KeyTrust::Trusted;
            }
            if !seen.insert(x) {
                break;
            }
            cur = self.devices.get(&x).and_then(|d| d.introduced_by);
        }
        KeyTrust::Untrusted {
            delivered_by: d.delivered_by,
        }
    }

    /// What a session may see of a mutation's receipt. The hosting app
    /// (`session_grant = None`) sees every receipt in full. A granted session sees
    /// only receipts of mutations submitted under its own grant, and without record
    /// views or conflict values unless the grant can read the collection.
    pub fn receipt_scope(
        &self,
        session_grant: Option<&Uuid>,
        mutation_grant: Option<&Uuid>,
    ) -> ReceiptScope {
        match session_grant {
            None => ReceiptScope::Full,
            Some(g) if mutation_grant == Some(g) => {
                if self.grant_allows(g, capability::READ) {
                    ReceiptScope::Full
                } else {
                    ReceiptScope::StateOnly
                }
            }
            Some(_) => ReceiptScope::Hidden,
        }
    }

    // ------------------------------------------------------------ encoding

    /// Canonical bytes, for the store's `replica.policy` meta key. Always written
    /// as format [`POLICY_STATE_FORMAT`] (26 elements; element 24 is the
    /// cert-root witness, `null` while unproven; element 25 the handover roots).
    pub fn to_bytes(&self) -> Result<Vec<u8>, cbor::CborError> {
        let opt = |o: Option<Cbor>| o.unwrap_or(Cbor::Null);
        let devices = self
            .devices
            .iter()
            .map(|(id, d)| {
                Cbor::Array(vec![
                    id.to_cbor(),
                    d.account.to_cbor(),
                    d.kind.to_cbor(),
                    d.sign_pk.to_cbor(),
                    d.kem_pk.to_cbor(),
                    d.noise_pk.to_cbor(),
                    Cbor::Bool(d.active),
                    Cbor::Bool(d.keyed),
                    opt(d.introduced_by.map(|k| k.to_cbor())),
                    opt(d.delivered_by.map(|k| k.to_cbor())),
                    opt(d.local_root.map(|k| k.to_cbor())),
                    opt(d.sas_commit.map(|k| k.to_cbor())),
                ])
            })
            .collect();
        let grants =
            self.grants
                .iter()
                .map(|(id, g)| {
                    Cbor::Array(vec![
                        id.to_cbor(),
                        g.installation.to_cbor(),
                        Cbor::Text(g.app_id.clone()),
                        g.account.to_cbor(),
                        Cbor::Array(
                            g.capabilities
                                .iter()
                                .map(|c| Cbor::Text(c.clone()))
                                .collect(),
                        ),
                        g.client_pk.to_cbor(),
                        opt(g.file_folders.as_ref().map(|f| f.to_cbor())),
                        Cbor::Bool(g.active),
                        opt(g.approved.as_ref().map(|a| {
                            Cbor::Array(a.iter().map(|c| Cbor::Text(c.clone())).collect())
                        })),
                        opt(g.approved_folders.as_ref().map(|f| f.to_cbor())),
                    ])
                })
                .collect();
        let c = Cbor::Array(vec![
            Cbor::Uint(POLICY_STATE_FORMAT),
            Cbor::Uint(self.seq),
            opt(self.root.map(|r| r.to_cbor())),
            opt(self.root_pk.map(|r| r.to_cbor())),
            opt(self.owner.map(|r| r.to_cbor())),
            opt(self.cstate.map(|r| r.to_cbor())),
            Cbor::Bool(self.compress),
            Cbor::Uint(self.min_sem_major),
            Cbor::Bool(self.frozen),
            opt(self.last_issued_at.map(Cbor::int)),
            Cbor::Array(
                self.revoked_cp_keys
                    .iter()
                    .map(|(k, t)| Cbor::Array(vec![k.to_cbor(), Cbor::int(*t)]))
                    .collect(),
            ),
            Cbor::Array(
                self.members
                    .iter()
                    .map(|(a, r)| Cbor::Array(vec![a.to_cbor(), r.to_cbor()]))
                    .collect(),
            ),
            Cbor::Array(devices),
            Cbor::Array(grants),
            Cbor::Uint(self.epoch),
            Cbor::Bool(self.rekey_required),
            Cbor::Uint(self.sem_ratchet),
            Cbor::int(self.log_time),
            Cbor::Bool(self.content_seen),
            opt(self.cutover.map(Cbor::Uint)),
            Cbor::Uint(self.voids),
            self.ctl_chain.to_cbor(),
            Cbor::Array(
                self.signed_by_key
                    .iter()
                    .map(|(k, v)| {
                        Cbor::Array(vec![
                            k.to_cbor(),
                            Cbor::Array(
                                v.iter()
                                    .map(|(p, t)| Cbor::Array(vec![Cbor::Uint(*p), Cbor::int(*t)]))
                                    .collect(),
                            ),
                        ])
                    })
                    .collect(),
            ),
            Cbor::Array(self.cp_roots.iter().map(|r| r.to_cbor()).collect()),
            opt(self.cert_roots.as_ref().map(|w| {
                Cbor::Array(
                    w.iter()
                        .map(|(k, r)| Cbor::Array(vec![k.to_cbor(), r.to_cbor()]))
                        .collect(),
                )
            })),
            Cbor::Array(self.handover_roots.iter().map(|r| r.to_cbor()).collect()),
        ]);
        cbor::encode(&c)
    }

    /// Decode [`PolicyState::to_bytes`].
    pub fn from_bytes(bytes: &[u8]) -> Result<PolicyState, SchemaError> {
        let c = cbor::decode(bytes)?;
        let a = arr(&c)?;
        // Format 3 (current): 26 elements, element 25 the handover roots.
        // Format 2: 25 elements, read with no handover roots recorded (a state
        // bricked by a later handover recovers by a cold rebuild, which replays
        // the handover and records it).
        // Element 24 is the cert-root witness.
        // Format 1: 24 elements, persisted before the witness existed; it is read
        // as unproven (`cert_roots: None`) and rewritten as the current format on the next
        // commit. A pinned warm reopen refuses an unproven state (rebuild and
        // replay under the pins). Readers that predate format 2 accept only
        // `[1, ..24 elements]`, so they refuse format 2 as an unknown format.
        //
        // `[1, ..25 elements]` is a pre-release format-1 state with the witness
        // in format 2's position. It is read as format 2 and rewritten as the
        // current format on the next commit.
        match (a.first(), a.len()) {
            (Some(Cbor::Uint(1)), 24 | 25)
            | (Some(Cbor::Uint(2)), 25)
            | (Some(Cbor::Uint(POLICY_STATE_FORMAT)), 26) => {}
            _ => return Err(bad("PolicyState: unknown format")),
        }
        let mut s = PolicyState::new();
        s.seq = u64::from_cbor(&a[1])?;
        s.root = opt(&a[2])?;
        s.root_pk = opt(&a[3])?;
        s.owner = opt(&a[4])?;
        s.cstate = opt(&a[5])?;
        s.compress = bool::from_cbor(&a[6])?;
        s.min_sem_major = u64::from_cbor(&a[7])?;
        s.frozen = bool::from_cbor(&a[8])?;
        s.last_issued_at = opt(&a[9])?;
        for kv in arr(&a[10])? {
            let kv = arr(kv)?;
            if kv.len() != 2 {
                return Err(bad("revoked key"));
            }
            s.revoked_cp_keys
                .insert(B16::from_cbor(&kv[0])?, i64::from_cbor(&kv[1])?);
        }
        for kv in arr(&a[11])? {
            let kv = arr(kv)?;
            if kv.len() != 2 {
                return Err(bad("member"));
            }
            s.members
                .insert(Uuid::from_cbor(&kv[0])?, Role::from_cbor(&kv[1])?);
        }
        for d in arr(&a[12])? {
            let d = arr(d)?;
            // 12 elements since `sas_commit`; 11 before.
            if d.len() != 11 && d.len() != 12 {
                return Err(bad("device"));
            }
            s.devices.insert(
                Uuid::from_cbor(&d[0])?,
                DeviceState {
                    account: Uuid::from_cbor(&d[1])?,
                    kind: DeviceKind::from_cbor(&d[2])?,
                    sign_pk: B32::from_cbor(&d[3])?,
                    kem_pk: B32::from_cbor(&d[4])?,
                    noise_pk: B32::from_cbor(&d[5])?,
                    active: bool::from_cbor(&d[6])?,
                    keyed: bool::from_cbor(&d[7])?,
                    introduced_by: opt(&d[8])?,
                    delivered_by: opt(&d[9])?,
                    local_root: opt(&d[10])?,
                    sas_commit: match d.get(11) {
                        Some(c) => opt(c)?,
                        None => None,
                    },
                },
            );
        }
        for g in arr(&a[13])? {
            let g = arr(g)?;
            if g.len() != 10 {
                return Err(bad("grant"));
            }
            s.grants.insert(
                Uuid::from_cbor(&g[0])?,
                GrantState {
                    installation: Uuid::from_cbor(&g[1])?,
                    app_id: String::from_cbor(&g[2])?,
                    account: Uuid::from_cbor(&g[3])?,
                    capabilities: Vec::<String>::from_cbor(&g[4])?.into_iter().collect(),
                    client_pk: B32::from_cbor(&g[5])?,
                    file_folders: opt(&g[6])?,
                    active: bool::from_cbor(&g[7])?,
                    approved: opt::<Vec<String>>(&g[8])?.map(|v| v.into_iter().collect()),
                    approved_folders: opt(&g[9])?,
                },
            );
        }
        s.epoch = u64::from_cbor(&a[14])?;
        s.rekey_required = bool::from_cbor(&a[15])?;
        s.sem_ratchet = u64::from_cbor(&a[16])?;
        s.log_time = i64::from_cbor(&a[17])?;
        s.content_seen = bool::from_cbor(&a[18])?;
        s.cutover = opt(&a[19])?;
        s.voids = u64::from_cbor(&a[20])?;
        s.ctl_chain = B32::from_cbor(&a[21])?;
        for kv in arr(&a[22])? {
            let kv = arr(kv)?;
            if kv.len() != 2 {
                return Err(bad("signed_by_key"));
            }
            let mut v = Vec::new();
            for pt in arr(&kv[1])? {
                let pt = arr(pt)?;
                if pt.len() != 2 {
                    return Err(bad("signed_by_key"));
                }
                v.push((u64::from_cbor(&pt[0])?, i64::from_cbor(&pt[1])?));
            }
            s.signed_by_key.insert(B16::from_cbor(&kv[0])?, v);
        }
        for r in arr(&a[23])? {
            s.cp_roots.insert(B32::from_cbor(r)?);
        }
        s.cert_roots = match a.get(24) {
            None | Some(Cbor::Null) => None,
            Some(w) => {
                let mut set = BTreeSet::new();
                for kv in arr(w)? {
                    let kv = arr(kv)?;
                    if kv.len() != 2 {
                        return Err(bad("cert_roots"));
                    }
                    set.insert((B16::from_cbor(&kv[0])?, B16::from_cbor(&kv[1])?));
                }
                Some(set)
            }
        };
        if let Some(h) = a.get(25) {
            for r in arr(h)? {
                s.handover_roots.insert(B16::from_cbor(r)?);
            }
        }
        Ok(s)
    }
}

fn bad(reason: &'static str) -> SchemaError {
    SchemaError::Invalid {
        ty: "PolicyState",
        reason,
    }
}

fn arr(c: &Cbor) -> Result<&[Cbor], SchemaError> {
    mdbn_wire::schema::array(c, "PolicyState")
}

fn opt<T: Wire>(c: &Cbor) -> Result<Option<T>, SchemaError> {
    match c {
        Cbor::Null => Ok(None),
        c => Ok(Some(T::from_cbor(c)?)),
    }
}

/// Control-plane and root key ID: the first 16 bytes of `SHA-256(pk)`.
pub fn key_id(pk: &[u8; 32]) -> B16 {
    let d = sha256(pk);
    let mut id = [0u8; 16];
    id.copy_from_slice(&d.0[..16]);
    B16(id)
}

// ---------------------------------------------------------------- capabilities

/// State lookups a capability check needs at the planning position.
pub struct OpContext<'a> {
    /// The path key of a path (spec 02), from the core.
    pub path_key: &'a dyn Fn(&str) -> String,
    /// The current path of a live file, if it exists.
    pub file_path: &'a dyn Fn(&Uuid) -> Option<String>,
}

/// The capability an operation needs (`policy.md` §5).
///
/// Saved-view sources are records or files, so they are covered by the record
/// capabilities here; `views.manage` narrowing needs the catalog and is applied
/// by the replica's API layer, not at replay.
pub fn capability_for(op: &Op, ctx: &OpContext<'_>) -> &'static str {
    match op {
        Op::Create(_) => capability::CREATE,
        Op::Update(_) | Op::Rename(_) | Op::ConflictDismiss(_) | Op::FileMove(_) => {
            capability::EDIT
        }
        Op::Document(d) => match (&d.base, &d.new) {
            (_, None) => capability::DELETE,
            (None, Some(_)) => capability::CREATE,
            _ => capability::EDIT,
        },
        Op::Delete(_) | Op::FileDelete(_) => capability::DELETE,
        Op::ResourcePut(_) | Op::ResourceDelete(_) | Op::SyncSettings(_) => capability::DEFINITIONS,
        Op::FilePut(f) => {
            if (ctx.file_path)(&f.id).is_some() {
                capability::EDIT
            } else {
                capability::CREATE
            }
        }
    }
}

/// A legacy operation or an attachment-v1 `file_attach`, for authorization.
enum AnyOp<'a> {
    Legacy(&'a Op),
    Attach(&'a mdbn_wire::attachment::FileAttach),
}

impl AnyOp<'_> {
    fn capability(&self, ctx: &OpContext<'_>) -> &'static str {
        match self {
            AnyOp::Legacy(o) => capability_for(o, ctx),
            AnyOp::Attach(f) => {
                if (ctx.file_path)(&f.id).is_some() {
                    capability::EDIT
                } else {
                    capability::CREATE
                }
            }
        }
    }

    fn file_paths(&self, ctx: &OpContext<'_>) -> Vec<String> {
        match self {
            AnyOp::Legacy(o) => file_paths(o, ctx),
            AnyOp::Attach(f) => {
                let mut v = vec![f.path.clone()];
                v.extend((ctx.file_path)(&f.id));
                v
            }
        }
    }
}

/// Paths in the file namespace an operation touches (its target and the file's
/// current path).
pub fn file_paths(op: &Op, ctx: &OpContext<'_>) -> Vec<String> {
    match op {
        Op::FilePut(f) => {
            let mut v = vec![f.path.clone()];
            v.extend((ctx.file_path)(&f.id));
            v
        }
        Op::FileMove(m) => {
            let mut v = vec![m.from.clone(), m.to.clone()];
            v.extend((ctx.file_path)(&m.id));
            v
        }
        Op::FileDelete(d) => (ctx.file_path)(&d.id).into_iter().collect(),
        _ => Vec::new(),
    }
}

/// Whether `path` is within one of `folders`, comparing path keys at segment
/// boundaries.
pub fn within_folders(path: &str, folders: &[String], path_key: &dyn Fn(&str) -> String) -> bool {
    let k = path_key(path);
    folders.iter().any(|f| {
        let fk = path_key(f.trim_end_matches('/'));
        fk.is_empty()
            || k.strip_prefix(fk.as_str())
                .is_some_and(|r| r.starts_with('/'))
    })
}

#[cfg(test)]
mod tests;
