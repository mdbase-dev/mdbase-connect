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

mod access;
mod content;
mod control;
mod encoding;
mod keys;
mod op_capability;
mod pins;
mod policy_op;
mod state;

pub use access::{
    DeclaredSetupAuthorization, EffectiveGrant, GrantSource, KeyTrust, LocalOwnerIdentity,
    ReceiptScope,
};
pub use control::PolicyEvent;
use op_capability::AnyOp;
pub use op_capability::{OpContext, capability_for, file_paths, within_folders};
pub use pins::{PolicyKeyPin, PolicyPins, RootPin};
pub use state::{DeviceState, GrantState, POLICY_STATE_FORMAT, PolicyState};

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
    /// Stall (`00-overview.md` §6.1–6.2): an unknown format/variant or missing
    /// local trust. The replica stops **before** this position (`upgrade_required`);
    /// nothing is applied, not even the position or the control chain. Voiding
    /// instead would let replicas of different builds disagree on `P`.
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

/// Only entry bytes and log-authoritative state may determine a void verdict.
/// Local trust configuration and planner/build limitations must stall instead.
/// New void sites require classification in the void-site inventory test.
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

/// Control-plane and root key ID: the first 16 bytes of `SHA-256(pk)`.
pub fn key_id(pk: &[u8; 32]) -> B16 {
    let d = sha256(pk);
    let mut id = [0u8; 16];
    id.copy_from_slice(&d.0[..16]);
    B16(id)
}

#[cfg(test)]
mod tests;
