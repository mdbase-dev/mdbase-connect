//! Published control-plane pins: roots and the policy keys they certify.

use super::*;

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

    pub(super) fn root(&self, id: &B16, pk: &B32) -> bool {
        self.roots
            .iter()
            .any(|r| r.root_id == *id && r.root_pk == *pk)
    }

    pub(super) fn policy_key(&self, id: &B16, pk: &B32, root: &B16) -> bool {
        self.policy_keys
            .iter()
            .any(|k| k.key_id == *id && k.policy_pk == *pk && k.root_id == *root)
    }
}
