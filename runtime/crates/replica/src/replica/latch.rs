//! The device-local revocation latch (lost-tail §5.3).
//!
//! Revocations this replica applied in a rolled-back window `(L, H]` are
//! remembered here, persisted in the same commit as the rollback, and enforced
//! locally until the applied log shows them again. The latch only adds
//! restrictions: it never changes an apply, void or verify verdict (those stay
//! deterministic from the log), so it can't cause divergence. While any subject
//! is latched:
//! - sessions of latched grants are refused and closed;
//! - the replica plans and seals nothing (it never seals for an epoch a latched
//!   device may hold); it serves reads only.
//!
//! A subject clears when the applied policy shows it revoked (or gone) again.
//! A grant does not clear by supersession here: that needs the user.

use std::collections::BTreeSet;

use mdbn_wire::common::{B16, Uuid};
use mdbn_wire::policy::{PolicyOp, PolicyPayload};
use mdbn_wire::schema::Wire;

use super::Replica;
use crate::store::{MetaPut, Store, StoreError, Tx, meta_keys};

/// Subjects seen revoked at an applied position that the current log lacks.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Latch {
    /// Revoked devices.
    pub devices: BTreeSet<Uuid>,
    /// Removed member accounts.
    pub members: BTreeSet<Uuid>,
    /// Revoked grants.
    pub grants: BTreeSet<Uuid>,
    /// Revoked control-plane policy keys.
    pub cp_keys: BTreeSet<B16>,
    /// A freeze.
    pub frozen: bool,
}

impl Latch {
    /// Nothing latched.
    pub fn is_empty(&self) -> bool {
        self.devices.is_empty()
            && self.members.is_empty()
            && self.grants.is_empty()
            && self.cp_keys.is_empty()
            && !self.frozen
    }

    /// Add the revocations of one policy item's ops.
    pub(crate) fn note(&mut self, payload: &PolicyPayload) {
        for op in &payload.ops {
            match op {
                PolicyOp::DeviceRevoke(r) => {
                    self.devices.insert(r.device);
                }
                PolicyOp::MemberRemove(m) => {
                    self.members.insert(m.account);
                }
                PolicyOp::GrantRevoke(r) => {
                    self.grants.insert(r.grant);
                }
                PolicyOp::CpKeyRevoke(r) => {
                    self.cp_keys.insert(r.key_id);
                }
                PolicyOp::Freeze(f) if f.frozen => self.frozen = true,
                _ => {}
            }
        }
    }

    /// Records: tag ‖ 16 bytes (tag 5, freeze, has no body).
    pub(crate) fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::new();
        for (tag, set) in [
            (1u8, &self.devices),
            (2, &self.members),
            (3, &self.grants),
            (4, &self.cp_keys),
        ] {
            for id in set {
                out.push(tag);
                out.extend_from_slice(&id.0);
            }
        }
        if self.frozen {
            out.push(5);
        }
        out
    }

    pub(crate) fn from_bytes(mut b: &[u8]) -> Result<Latch, &'static str> {
        let mut l = Latch::default();
        while let Some((&tag, rest)) = b.split_first() {
            if tag == 5 {
                l.frozen = true;
                b = rest;
                continue;
            }
            if rest.len() < 16 {
                return Err("short record");
            }
            let mut id = [0u8; 16];
            id.copy_from_slice(&rest[..16]);
            let set = match tag {
                1 => &mut l.devices,
                2 => &mut l.members,
                3 => &mut l.grants,
                4 => &mut l.cp_keys,
                _ => return Err("unknown tag"),
            };
            set.insert(B16(id));
            b = &rest[16..];
        }
        Ok(l)
    }

    pub(crate) fn meta(&self) -> MetaPut {
        (
            meta_keys::LATCH.into(),
            (!self.is_empty()).then(|| self.to_bytes()),
        )
    }
}

/// The latch for a rolled-back window, from its retained control items (`None`
/// only for an undecodable one). Device-authored control items need no latch:
/// - a lost `rekey` is re-created by the protocol itself: a restored (or
///   surviving) revocation leaves `rekey_required` set, and control work comes
///   first (`log-entry.md` §3.1); a non-revocation rekey is simply gone, and
///   resurrected content is re-sealed under the epoch in force;
/// - a lost `key_grant` is re-sent: the replayed policy shows its recipient
///   unkeyed, and the key-grant duty applies again;
/// - a lost `grant_approval` fails closed: the grant is unapproved in the new
///   history until the user approves it again (a latch could only restrict
///   what is already refused).
pub(crate) fn latch_from_window(items: &[Vec<u8>]) -> Option<Latch> {
    use mdbn_wire::envelope::ItemKind;
    let mut latch = Latch::default();
    for raw in items {
        let item = mdbn_wire::envelope::Item::from_bytes(raw).ok()?;
        match item.kind {
            ItemKind::Policy => latch.note(&PolicyPayload::from_bytes(&item.body.0).ok()?),
            ItemKind::Rekey | ItemKind::KeyGrant | ItemKind::GrantApproval => {}
            k if k.is_control() => return None,
            _ => {}
        }
    }
    Some(latch)
}

impl<S: Store> Replica<S> {
    /// The current latch.
    pub fn latch(&self) -> &Latch {
        &self.latch
    }

    /// lost control is latched, or a fallback is still rolling back
    /// or held: only the hosting app is served, and no grant is effective.
    pub(crate) fn lost_control_pending(&self) -> bool {
        !self.latch.is_empty()
            || matches!(
                self.repair_status().map(|s| s.phase),
                Some(super::RepairPhase::RollingBack | super::RepairPhase::FallbackRequired)
            )
    }

    /// Whether `grant` is latched (refused locally whatever the log says).
    pub(crate) fn grant_latched(&self, grant: &Uuid) -> bool {
        self.latch.grants.contains(grant)
    }

    /// Drop subjects the applied policy shows revoked (or gone) again; persist
    /// the change. Not while a rollback replays (the head is behind by design).
    pub(crate) fn clear_latch(&mut self) -> Result<(), StoreError> {
        if self.latch.is_empty() || self.rolling_back() {
            return Ok(());
        }
        let p = &self.policy;
        let mut next = self.latch.clone();
        next.devices
            .retain(|d| p.devices.get(d).is_some_and(|s| s.active));
        next.members.retain(|m| p.members.contains_key(m));
        next.grants
            .retain(|g| p.grants.get(g).is_some_and(|s| s.active));
        next.cp_keys.retain(|k| !p.revoked_cp_keys.contains_key(k));
        next.frozen = next.frozen && !p.frozen;
        if next == self.latch {
            return Ok(());
        }
        self.store.commit(Tx {
            meta: vec![next.meta()],
            ..Tx::default()
        })?;
        self.latch = next;
        self.status_dirty = true;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn latch_round_trips() {
        let mut l = Latch::default();
        l.devices.insert(B16([1; 16]));
        l.grants.insert(B16([2; 16]));
        l.cp_keys.insert(B16([3; 16]));
        l.members.insert(B16([4; 16]));
        l.frozen = true;
        assert_eq!(Latch::from_bytes(&l.to_bytes()), Ok(l.clone()));
        assert_eq!(Latch::from_bytes(&[]), Ok(Latch::default()));
        assert!(Latch::from_bytes(&[1, 0]).is_err());
        assert!(Latch::from_bytes(&[9]).is_err());
        assert_eq!(l.meta().1, Some(l.to_bytes()));
        assert_eq!(Latch::default().meta().1, None);
    }
}
