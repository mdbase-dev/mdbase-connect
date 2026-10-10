//! Device approval in end-to-end collections (`sealed-envelope.md` §5.3,
//! `replica-client-api.md` §8.3): the commit-then-reveal six-digit code, and the
//! `key_grant` the approver appends.
//!
//! Two sides, both pure state machines over the policy state in the device's own view
//! of the log. Messages (`r_A` to the new device, `r_N` back) travel over any channel
//! the host has (the control plane's pending-approval channel); the channel needs no
//! integrity, since tampering only produces codes that don't match.
//!
//! - [`Approver`] runs on a keyed device `A` of an owner or editor: it lists devices
//!   waiting for a key, draws `r_A` only after seeing the new device's commitment in
//!   its own view, checks the revealed `r_N` internally, and checks the code the
//!   user TYPES from the new device before building `key_grant`. The approving
//!   device never displays or logs its computed code. At most 3 failed
//!   attempts per commitment.
//! - [`NewDevice`] runs on the device being approved `N`: it commits to `r_N` for its
//!   enrolment, checks that the log carries exactly its keys and commitment, reveals
//!   `r_N` at most once, shows the code, and accepts a key only from the approver it
//!   compared codes with (step 6).
//!
//! Persist [`NewDevice::state`] before sending `r_N` (the reveal-once rule survives a
//! crash). Approver state is in memory: a lost challenge just needs a new one.

use std::collections::BTreeMap;

use mdbn_wire::common::Uuid;
use mdbn_wire::envelope::KeyGrantPayload;
use mdbn_wire::policy::{CState, DeviceKind, Role};
use zeroize::Zeroizing;

use crate::crypto::keys::{self, EnrolledKeys, Recipient, Reveal, SasApprover, SasCommitter};
use crate::crypto::{CryptoError, CsprngEntropy, Secret32};
use crate::policy::PolicyState;

/// A device waiting for its key.
#[derive(Clone, PartialEq, Eq)]
pub struct Waiting {
    /// Device ID.
    pub device: Uuid,
    /// Its member account.
    pub account: Uuid,
    /// Kind.
    pub kind: DeviceKind,
    /// Internal comparison value, once the exchange completed. Never expose it
    /// through a producer DTO, push, CLI, debug or telemetry.
    pub sas: Option<String>,
}

impl std::fmt::Debug for Waiting {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Waiting")
            .field("device", &self.device)
            .field("account", &self.account)
            .field("kind", &self.kind)
            .field("exchange_ready", &self.sas.is_some())
            .finish()
    }
}

/// Why an approval step was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalError {
    /// This device may not approve (not keyed, not an owner or editor device, or the
    /// collection is not end-to-end).
    NotApprover,
    /// Only owners approve another account's device.
    OtherAccount,
    /// The device is not waiting: unknown, revoked, already keyed, or no commitment.
    NotWaiting,
    /// No challenge outstanding for this device.
    NoChallenge,
    /// `r_N` does not match the commitment (counts as a failed attempt).
    BadReveal,
    /// Three failed attempts: the new device must commit afresh.
    Exhausted,
    /// The code the user confirmed differs (counts as a failed attempt).
    CodeMismatch,
    /// No code computed yet.
    NotReady,
    /// Crypto failure building the grant.
    Crypto,
}

impl From<CryptoError> for ApprovalError {
    fn from(_: CryptoError) -> ApprovalError {
        ApprovalError::Crypto
    }
}

fn enrolled(policy: &PolicyState, id: &Uuid) -> Option<EnrolledKeys> {
    policy.devices.get(id).map(|d| EnrolledKeys {
        device: *id,
        sign_pk: d.sign_pk.0,
        kem_pk: d.kem_pk.0,
        noise_pk: d.noise_pk.0,
    })
}

struct Attempt {
    commit: [u8; 32],
    sas: SasApprover,
    code: Option<String>,
}

/// The approving device's side.
pub struct Approver {
    collection: Uuid,
    me: Uuid,
    attempts: BTreeMap<Uuid, Attempt>,
    rejected: std::collections::BTreeSet<Uuid>,
}

impl std::fmt::Debug for Approver {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Approver")
            .field("collection", &self.collection)
            .field("device", &self.me)
            .field("attempts", &self.attempts.len())
            .field("rejected", &self.rejected.len())
            .finish()
    }
}

impl Approver {
    /// The approver for device `me`.
    pub fn new(collection: Uuid, me: Uuid) -> Approver {
        Approver {
            collection,
            me,
            attempts: BTreeMap::new(),
            rejected: Default::default(),
        }
    }

    /// Custody binding for the sealer bridge; never exposes comparison state.
    pub(crate) fn bound_to(&self, collection: Uuid, device: Uuid) -> bool {
        self.collection == collection && self.me == device
    }

    /// Whether this device may approve `device` now (`policy.md` §4.4): an
    /// active, keyed device of an owner or editor, in an `e2e` collection; another
    /// account's device only if this device's account is an owner.
    fn may_approve(&self, p: &PolicyState, device: &Uuid) -> Result<(), ApprovalError> {
        let me = p
            .devices
            .get(&self.me)
            .filter(|d| d.active && d.keyed)
            .ok_or(ApprovalError::NotApprover)?;
        if p.cstate != Some(CState::E2e) {
            return Err(ApprovalError::NotApprover);
        }
        let role = p
            .members
            .get(&me.account)
            .copied()
            .ok_or(ApprovalError::NotApprover)?;
        if !matches!(
            me.kind,
            DeviceKind::Desktop | DeviceKind::Mobile | DeviceKind::AppRuntime | DeviceKind::Cli
        ) || role < Role::Editor
        {
            return Err(ApprovalError::NotApprover);
        }
        let n = p.devices.get(device).ok_or(ApprovalError::NotWaiting)?;
        if n.account != me.account && role != Role::Owner {
            return Err(ApprovalError::OtherAccount);
        }
        Ok(())
    }

    /// Devices enrolled, active, not keyed, with a commitment (`pending_devices`).
    pub fn pending(&self, p: &PolicyState) -> Vec<Waiting> {
        p.devices
            .iter()
            .filter(|(id, d)| {
                d.active && !d.keyed && d.sas_commit.is_some() && !self.rejected.contains(id)
            })
            .filter(|(id, _)| self.may_approve(p, id).is_ok())
            .map(|(id, d)| Waiting {
                device: *id,
                account: d.account,
                kind: d.kind,
                sas: self
                    .attempts
                    .get(id)
                    .filter(|a| Some(a.commit) == d.sas_commit.map(|c| c.0))
                    .and_then(|a| a.code.clone()),
            })
            .collect()
    }

    /// Draw `r_A` for `device` (`start_approval`). Uses the latest commitment in this
    /// device's view; a new commitment resets the attempt count.
    pub fn start(
        &mut self,
        p: &PolicyState,
        device: &Uuid,
        entropy: &mut dyn CsprngEntropy,
    ) -> Result<[u8; 32], ApprovalError> {
        self.may_approve(p, device)?;
        let d = p
            .devices
            .get(device)
            .filter(|d| d.active && !d.keyed)
            .ok_or(ApprovalError::NotWaiting)?;
        let commit = d.sas_commit.ok_or(ApprovalError::NotWaiting)?.0;
        let a = self.attempts.entry(*device).or_insert_with(|| Attempt {
            commit,
            sas: SasApprover::new(commit),
            code: None,
        });
        if a.commit != commit {
            *a = Attempt {
                commit,
                sas: SasApprover::new(commit),
                code: None,
            };
        }
        a.code = None;
        a.sas.challenge(entropy).ok_or(ApprovalError::Exhausted)
    }

    /// Check the new device's `r_N`, returning the INTERNAL comparison value.
    /// The approving UI must discard this value, not display or log it.
    pub fn on_reveal(
        &mut self,
        p: &PolicyState,
        device: &Uuid,
        r_n: &[u8; 32],
    ) -> Result<String, ApprovalError> {
        let me = enrolled(p, &self.me).ok_or(ApprovalError::NotApprover)?;
        let n = enrolled(p, device).ok_or(ApprovalError::NotWaiting)?;
        let a = self
            .attempts
            .get_mut(device)
            .ok_or(ApprovalError::NoChallenge)?;
        match a.sas.on_reveal(&self.collection, &me, &n, r_n) {
            Some(code) => {
                a.code = Some(code.clone());
                Ok(code)
            }
            None if a.sas.exhausted() => Err(ApprovalError::Exhausted),
            None => Err(ApprovalError::BadReveal),
        }
    }

    /// The user confirmed `typed` matches on both devices: build the `key_grant`
    /// payload for `device` under the current epoch key. The caller appends it as a
    /// `key_grant` item signed by this device.
    pub fn approve(
        &mut self,
        p: &PolicyState,
        device: &Uuid,
        typed: &str,
        epoch_key: &Secret32,
        entropy: &mut dyn CsprngEntropy,
    ) -> Result<KeyGrantPayload, ApprovalError> {
        self.may_approve(p, device)?;
        let d = p
            .devices
            .get(device)
            .filter(|d| d.active && !d.keyed)
            .ok_or(ApprovalError::NotWaiting)?;
        let a = self
            .attempts
            .get_mut(device)
            .ok_or(ApprovalError::NoChallenge)?;
        if Some(a.commit) != d.sas_commit.map(|c| c.0) {
            return Err(ApprovalError::NotWaiting);
        }
        let code = a.code.clone().ok_or(ApprovalError::NotReady)?;
        if !keys::sas_matches(&code, typed) {
            a.sas.mismatch();
            a.code = None;
            return Err(if a.sas.exhausted() {
                ApprovalError::Exhausted
            } else {
                ApprovalError::CodeMismatch
            });
        }
        let r = Recipient {
            device: *device,
            kem_pk: d.kem_pk.0,
        };
        let g = keys::build_key_grant(&self.collection, p.epoch, epoch_key, &r, entropy)?;
        self.attempts.remove(device);
        Ok(g)
    }

    /// Drop a fenced exchange; the runtime's durable consumed-commit marker
    /// prevents this from resetting the failed-attempt budget after context loss.
    pub(crate) fn cancel(&mut self, device: &Uuid) {
        self.attempts.remove(device);
        self.rejected.remove(device);
    }

    /// Stop offering `device` here (`reject_device`).
    pub fn reject(&mut self, device: &Uuid) {
        self.attempts.remove(device);
        self.rejected.insert(*device);
    }
}

/// The new device's side.
pub struct NewDevice {
    collection: Uuid,
    me: EnrolledKeys,
    committer: SasCommitter,
    approver: Option<Uuid>,
}

impl std::fmt::Debug for NewDevice {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NewDevice")
            .field("device", &self.me.device)
            .field("approver", &self.approver)
            .finish_non_exhaustive()
    }
}

/// Length of [`SasCommitter::state`].
const COMMITTER_STATE: usize = 33;

/// What the new device does with a challenge.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Answer {
    /// Persist `state` (it now names the approver), then send `r_n` to the approver
    /// and show `code`.
    Reveal {
        /// `r_N`.
        r_n: [u8; 32],
        /// Code to show.
        code: String,
        /// New persisted state.
        state: Zeroizing<Vec<u8>>,
    },
    /// `r_N` was revealed before: ask the control plane for an `approval-request`
    /// with [`NewDevice::fresh`]'s commitment.
    CommitAfresh,
    /// The log does not carry exactly this device's keys and commitment: a control
    /// plane substituted something. Show no code.
    NotLogged,
}

impl NewDevice {
    /// A new commitment for this device's enrolment (`device-enrol` key 7).
    pub fn new(collection: Uuid, me: EnrolledKeys, entropy: &mut dyn CsprngEntropy) -> NewDevice {
        NewDevice {
            collection,
            me,
            committer: SasCommitter::new(&collection, &me, entropy),
            approver: None,
        }
    }

    /// Restore from [`NewDevice::state`] after a restart, including the approver it
    /// revealed to: after a restart it still accepts a key only from that device.
    pub fn restore(
        collection: Uuid,
        me: EnrolledKeys,
        state: &[u8],
    ) -> Result<NewDevice, CryptoError> {
        let (committer, approver) = match state.len() {
            COMMITTER_STATE => (state, None),
            n if n == COMMITTER_STATE + 16 => {
                let mut a = [0u8; 16];
                a.copy_from_slice(&state[COMMITTER_STATE..]);
                (&state[..COMMITTER_STATE], Some(mdbn_wire::common::B16(a)))
            }
            _ => return Err(CryptoError::Encoding),
        };
        let committer = SasCommitter::restore(&collection, &me, committer)?;
        // A revealed r_N always has an approver; one without is from a host that kept
        // the approver elsewhere, so it can't be trusted to name one: commit afresh.
        if committer.is_revealed() && approver.is_none() {
            return Err(CryptoError::Encoding);
        }
        Ok(NewDevice {
            collection,
            me,
            committer,
            approver,
        })
    }

    /// The commitment to enrol with (or to send in an `approval-request`).
    pub fn commitment(&self) -> [u8; 32] {
        self.committer.commitment()
    }

    /// Persisted state: `r_N` (secret until revealed), whether it was revealed, and
    /// the approver it was revealed to. Keep it with the device secrets.
    pub fn state(&self) -> Zeroizing<Vec<u8>> {
        let mut s = self.committer.state();
        if let Some(a) = self.approver {
            s.extend_from_slice(&a.0);
        }
        s
    }

    /// A fresh commitment after a reveal, a failure, or abandonment.
    pub fn fresh(&mut self, entropy: &mut dyn CsprngEntropy) -> [u8; 32] {
        self.committer = SasCommitter::new(&self.collection, &self.me, entropy);
        self.approver = None;
        self.committer.commitment()
    }

    /// Answer a challenge `r_A` from `approver`, checking first that this device's own
    /// enrolment (or latest `approval-request`) in its view carries exactly its keys
    /// and commitment.
    pub fn on_challenge(&mut self, p: &PolicyState, approver: &Uuid, r_a: &[u8; 32]) -> Answer {
        let logged = p.devices.get(&self.me.device).filter(|d| {
            d.active
                && d.sign_pk.0 == self.me.sign_pk
                && d.kem_pk.0 == self.me.kem_pk
                && d.noise_pk.0 == self.me.noise_pk
        });
        let Some(d) = logged else {
            return Answer::NotLogged;
        };
        if !d
            .sas_commit
            .is_some_and(|c| self.committer.check_logged(&c.0))
        {
            return Answer::NotLogged;
        }
        let Some(a) = enrolled(p, approver) else {
            return Answer::NotLogged;
        };
        match self.committer.reveal(&self.collection, &a, &self.me, r_a) {
            Reveal::Reveal { r_n, code, .. } => {
                self.approver = Some(*approver);
                Answer::Reveal {
                    r_n,
                    code,
                    state: self.state(),
                }
            }
            Reveal::AlreadyRevealed => Answer::CommitAfresh,
        }
    }

    /// The device it compared codes with: the only signer whose `key_grant` it uses
    /// (step 6). Add it to the replica's `trusted_signers`.
    pub fn approver(&self) -> Option<Uuid> {
        self.approver
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::TestEntropy;
    use crate::policy::{DeviceState, PolicyState};
    use mdbn_wire::common::{B16, B32};

    const COL: Uuid = B16([7; 16]);
    const OWNER: Uuid = B16([0xa0; 16]);
    const OTHER: Uuid = B16([0xa1; 16]);

    #[test]
    fn approver_debug_and_waiting_debug_never_expose_computed_code() {
        let mut approver = Approver::new(COL, OWNER);
        approver.attempts.insert(
            OTHER,
            Attempt {
                commit: [0x42; 32],
                sas: SasApprover::new([0x42; 32]),
                code: Some("654321".into()),
            },
        );
        let debug = format!("{approver:?}");
        assert!(!debug.contains("654321"));
        assert!(!debug.contains("commit"));
        let waiting = Waiting {
            device: OTHER,
            account: OWNER,
            kind: DeviceKind::Desktop,
            sas: Some("123456".into()),
        };
        let debug = format!("{waiting:?}");
        assert!(!debug.contains("123456"));
        assert!(debug.contains("exchange_ready: true"));
    }

    fn keys(n: u8) -> EnrolledKeys {
        EnrolledKeys {
            device: B16([n; 16]),
            sign_pk: [n; 32],
            kem_pk: crate::crypto::hpke::KemKeyPair::from_secret(&[n; 32]).pk,
            noise_pk: [n + 1; 32],
        }
    }

    fn dev(k: &EnrolledKeys, account: Uuid, keyed: bool, commit: Option<[u8; 32]>) -> DeviceState {
        DeviceState {
            account,
            kind: DeviceKind::Desktop,
            sign_pk: B32(k.sign_pk),
            kem_pk: B32(k.kem_pk),
            noise_pk: B32(k.noise_pk),
            active: true,
            keyed,
            introduced_by: None,
            delivered_by: None,
            local_root: None,
            sas_commit: commit.map(B32),
        }
    }

    fn state(n_commit: [u8; 32], n_account: Uuid, a_role: Role) -> PolicyState {
        let mut p = PolicyState::new();
        p.cstate = Some(CState::E2e);
        p.epoch = 1;
        p.members.insert(OWNER, a_role);
        p.members.insert(OTHER, Role::Editor);
        p.devices
            .insert(keys(1).device, dev(&keys(1), OWNER, true, None));
        p.devices.insert(
            keys(2).device,
            dev(&keys(2), n_account, false, Some(n_commit)),
        );
        p
    }

    #[test]
    fn full_exchange_keys_the_new_device() {
        let mut e = TestEntropy::new(1);
        let mut n = NewDevice::new(COL, keys(2), &mut e);
        let p = state(n.commitment(), OWNER, Role::Owner);
        let mut a = Approver::new(COL, keys(1).device);
        assert_eq!(a.pending(&p).len(), 1);
        let r_a = a.start(&p, &keys(2).device, &mut e).unwrap();
        let Answer::Reveal { r_n, code, .. } = n.on_challenge(&p, &keys(1).device, &r_a) else {
            panic!("no reveal")
        };
        let code_a = a.on_reveal(&p, &keys(2).device, &r_n).unwrap();
        assert_eq!(code, code_a, "both devices show the same code");
        assert_eq!(a.pending(&p)[0].sas.as_deref(), Some(code.as_str()));
        let k = Secret32::random(&mut e);
        let g = a.approve(&p, &keys(2).device, &code, &k, &mut e).unwrap();
        assert_eq!(g.recipient, keys(2).device);
        // The new device can unwrap it.
        let kem = crate::crypto::hpke::KemKeyPair::from_secret(&[2; 32]);
        let commit = B32(keys::key_commit(&k, &COL, 1).unwrap());
        let got = keys::open_key_grant(&g, &COL, &kem, &commit).unwrap();
        assert_eq!(got.expose(), k.expose());
        assert_eq!(n.approver(), Some(keys(1).device));
    }

    /// The approver is persisted with the secret: after a restart the new device
    /// still names only the device it compared codes with, and still refuses a
    /// second reveal.
    #[test]
    fn restart_keeps_the_approver() {
        let mut e = TestEntropy::new(3);
        let mut n = NewDevice::new(COL, keys(2), &mut e);
        let p = state(n.commitment(), OWNER, Role::Owner);
        // Before any reveal: no approver, and the commitment survives.
        let fresh = NewDevice::restore(COL, keys(2), &n.state()).unwrap();
        assert_eq!(fresh.approver(), None);
        assert_eq!(fresh.commitment(), n.commitment());
        let Answer::Reveal { state: saved, .. } = n.on_challenge(&p, &keys(1).device, &[9; 32])
        else {
            panic!("no reveal")
        };
        let mut back = NewDevice::restore(COL, keys(2), &saved).unwrap();
        assert_eq!(back.approver(), Some(keys(1).device));
        assert_eq!(
            back.on_challenge(&p, &keys(1).device, &[8; 32]),
            Answer::CommitAfresh,
            "a restart does not allow a second reveal"
        );
        assert_eq!(back.approver(), Some(keys(1).device));
        // A revealed state that doesn't name its approver is refused.
        assert!(NewDevice::restore(COL, keys(2), &saved[..COMMITTER_STATE]).is_err());
        assert!(NewDevice::restore(COL, keys(2), &saved[..40]).is_err());
    }

    #[test]
    fn reveal_once_and_substitution() {
        let mut e = TestEntropy::new(2);
        let mut n = NewDevice::new(COL, keys(2), &mut e);
        let p = state(n.commitment(), OWNER, Role::Owner);
        assert!(matches!(
            n.on_challenge(&p, &keys(1).device, &[9; 32]),
            Answer::Reveal { .. }
        ));
        assert_eq!(
            n.on_challenge(&p, &keys(1).device, &[8; 32]),
            Answer::CommitAfresh,
            "r_N is revealed at most once"
        );
        // A control plane substituting the commitment: no code.
        let mut n2 = NewDevice::new(COL, keys(2), &mut e);
        let p2 = state([0x55; 32], OWNER, Role::Owner);
        assert_eq!(
            n2.on_challenge(&p2, &keys(1).device, &[9; 32]),
            Answer::NotLogged
        );
    }

    #[test]
    fn bad_reveals_and_mismatches_exhaust() {
        let mut e = TestEntropy::new(3);
        let n = NewDevice::new(COL, keys(2), &mut e);
        let p = state(n.commitment(), OWNER, Role::Owner);
        let mut a = Approver::new(COL, keys(1).device);
        for _ in 0..2 {
            a.start(&p, &keys(2).device, &mut e).unwrap();
            assert_eq!(
                a.on_reveal(&p, &keys(2).device, &[1; 32]),
                Err(ApprovalError::BadReveal)
            );
        }
        a.start(&p, &keys(2).device, &mut e).unwrap();
        assert_eq!(
            a.on_reveal(&p, &keys(2).device, &[1; 32]),
            Err(ApprovalError::Exhausted)
        );
        assert_eq!(
            a.start(&p, &keys(2).device, &mut e),
            Err(ApprovalError::Exhausted)
        );
        // A fresh commitment resets the count.
        let mut p2 = p.clone();
        p2.devices.get_mut(&keys(2).device).unwrap().sas_commit = Some(B32([0x66; 32]));
        assert!(a.start(&p2, &keys(2).device, &mut e).is_ok());
    }

    #[test]
    fn only_owners_approve_other_accounts() {
        let mut e = TestEntropy::new(4);
        let n = NewDevice::new(COL, keys(2), &mut e);
        let p = state(n.commitment(), OTHER, Role::Editor);
        let mut a = Approver::new(COL, keys(1).device);
        assert_eq!(
            a.start(&p, &keys(2).device, &mut e),
            Err(ApprovalError::OtherAccount)
        );
        assert!(a.pending(&p).is_empty());
        let mut cc = state(n.commitment(), OWNER, Role::Owner);
        cc.cstate = Some(CState::CloudCopy);
        assert_eq!(
            a.start(&cc, &keys(2).device, &mut e),
            Err(ApprovalError::NotApprover),
            "cloud copy: the escrow keys"
        );
    }
}
