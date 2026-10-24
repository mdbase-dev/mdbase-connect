//! The account key on the replica side (AK1, account-key bundle design).
//!
//! The account-key device of a private collection is the account's recovery device
//! for it ([`RecoveryKeys`], derived from the account secret `R`). Two operations:
//!
//! - [`Replica::key_account_key_device`] (setup): a keyed editor device checks that the
//!   enrolled recovery device carries exactly the derived keys and queues an
//!   ordinary `key_grant` to it for the append loop's control slot. From then on
//!   rekeys include it.
//! - [`Replica::self_grant_with_account_key`] (unlock): a same-account user device
//!   that is not keyed **first reads the control items ahead to the log's head**
//!   and evaluates them on a copy of its policy, so every check is made against the
//!   head, not against the prefix it has applied (it may be waiting for a key at an
//!   early entry). At the head: the collection is private; this device is an active
//!   user device of the recovery device's account; the recovery device is active,
//!   keyed and exactly the one derived from `R`; and its wrap is of the head's epoch,
//!   matching that epoch's commitment. Only then are the head key and the older keys
//!   (from the head rekey's history box, each checked against its commitment)
//!   installed, durably, and the `key_grant` to this device signed by the recovery
//!   device queued for the control slot. A revoked or replaced account key is
//!   refused with a typed reason and nothing is installed.
//!
//! The replica keeps device-locally (not in `P`): the latest wrap addressed to each
//! recovery device, the commitments of every epoch, and the rekey that created the
//! current epoch (all public log data, bounded). It also keeps the account-key
//! devices its user unlocked, which device-local key trust treats as
//! trusted signers, together with the one same-account user device that keyed each.

use std::collections::{BTreeMap, BTreeSet};

use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::common::{B32, Bytes, Uuid};
use mdbn_wire::envelope::{Item, ItemKind, KeyGrantPayload, KeyWrap, RekeyPayload};
use mdbn_wire::log_service::ReadParams;
use mdbn_wire::policy::{CState, DeviceKind, Role};
use mdbn_wire::schema::Wire;

use super::Replica;
use crate::crypto::keys::{self, Recipient};
use crate::crypto::recovery::RecoveryKeys;
use crate::log::{LogReply, LogRequest, LogResponse};
use crate::policy::PolicyState;
use crate::store::Store;

/// Persisted under this meta key (public data only).
pub(crate) const META: &str = "replica.account_key";

/// Bounds on the persisted state (it is reloaded at open).
const MAX_WRAPS: usize = 256;
const MAX_TRUSTED: usize = 64;
const MAX_COMMITS: usize = 1 << 16;
/// Control items per read-ahead page.
const AHEAD_PAGE: u64 = 256;

/// Why an account-key operation was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccountKeyRefusal {
    /// The collection is not private (e2e) in the applied policy, or this replica
    /// never can (local-only, hosted). Settled: retrying does not change it.
    NotPrivate,
    /// Not yet: this replica has not applied the collection's policy (just joined
    /// or opened, no genesis applied) or is installing a snapshot. Nothing is
    /// decided about the collection; retry shortly.
    NotReady,
    /// This device is not an active user device of a member account at the head.
    NotEnrolled,
    /// This device may not key others (not keyed, or not an editor).
    NotAuthorized,
    /// The account's recovery device for this collection is not enrolled, or was
    /// revoked, at the head.
    DeviceMissing,
    /// The enrolled recovery device does not carry the keys derived from `R`
    /// or belongs to another account: never key it, never trust it.
    EnrolmentMismatch,
    /// The recovery device holds no key for the head's epoch.
    NotKeyed,
    /// No wrap of the head's epoch for the recovery device was found.
    NoWrap,
    /// A wrap or history key does not match its commitment.
    Inconsistent,
    /// The item could not be built, or a local commit was refused with nothing
    /// written (the state is restored).
    Failed,
    /// A local commit's outcome is unknown: the replica stops serving and sealing
    /// until it is reopened (no key use after an unknown commit).
    OutcomeUnknown,
}

/// A member replica's signed attestation of applied revoke + VALID excluding rekey.
/// The control plane aggregates these; it never evaluates replica policy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StrictWitness {
    /// Account whose strict generation is completing.
    pub account: Uuid,
    /// Private collection this replica hosts.
    pub collection: Uuid,
    /// Recovery device that was revoked and excluded.
    pub recovery_device: Uuid,
    /// Stable control-plane strict generation.
    pub version: u64,
    /// CP-appended revocation position, observed in this replica's applied prefix.
    pub revoked_at: u64,
    /// This replica's durably applied position (not a log admission receipt).
    pub applied_at: u64,
    /// Valid applied rekey epoch, excluding the recovery device.
    pub epoch: u64,
    /// Active keyed member device making the attestation.
    pub reporter: Uuid,
    /// Signature over `H("mdbase/v1/account-key-strict-witness", cbor(fields))`.
    pub signature: mdbn_wire::common::B64,
}
impl StrictWitness {
    /// Canonical signed fields, also used by Connect's proof codec.
    pub fn fields(&self) -> Cbor {
        Cbor::Array(vec![
            Cbor::Uint(1),
            Cbor::Bytes(self.account.0.to_vec()),
            Cbor::Bytes(self.collection.0.to_vec()),
            Cbor::Bytes(self.recovery_device.0.to_vec()),
            Cbor::Uint(self.version),
            Cbor::Uint(self.revoked_at),
            Cbor::Uint(self.applied_at),
            Cbor::Uint(self.epoch),
            Cbor::Bytes(self.reporter.0.to_vec()),
        ])
    }
    /// Domain-separated digest; all fields including the generation are signed.
    pub fn digest(&self) -> B32 {
        mdbn_wire::hash::h(
            "mdbase/v1/account-key-strict-witness",
            &cbor::encode(&self.fields()).expect("fixed witness fields"),
        )
    }
}

/// An unlocked account key whose self-grant waits for the control slot (RAM only;
/// the recovery device's secrets are zeroized on drop).
#[derive(Debug)]
pub(crate) struct PendingSelfGrant {
    keys: RecoveryKeys,
    attempts: u32,
}

/// A control read-ahead for an unlock, verified at the head before anything is used.
#[derive(Debug)]
pub(crate) struct Ahead {
    keys: RecoveryKeys,
    after: u64,
    target: u64,
    reading: bool,
    policy: PolicyState,
    wrap: Option<(u64, KeyWrap)>,
    commits: BTreeMap<u64, B32>,
    last_rekey: Option<RekeyPayload>,
    rekeys: Vec<RekeyPayload>,
}

/// Appends of a self-grant before giving up (a voided grant is not retried forever).
const MAX_SELF_GRANT_ATTEMPTS: u32 = 3;

/// Device-local account-key state.
#[derive(Debug, Default)]
pub(crate) struct AccountKeyState {
    /// Latest wrap seen for each recovery device: (epoch, wrap).
    wraps: BTreeMap<Uuid, (u64, KeyWrap)>,
    /// Every epoch's commitment, from its rekey.
    commits: BTreeMap<u64, B32>,
    /// The rekey that created the current epoch (its history box holds the older
    /// keys under the current key).
    last_rekey: Option<RekeyPayload>,
    /// Account-key devices this device's user unlocked, and the same-account user
    /// devices that keyed them (trusted signers).
    trusted: BTreeSet<Uuid>,
    /// RAM only: an unlock reading ahead to the head.
    ahead: Option<Ahead>,
    /// RAM only: the self-grant to append once caught up.
    pending: Option<PendingSelfGrant>,
    /// RAM only: a setup grant to the account-key device for the control slot.
    setup: Option<(Uuid, u64, KeyGrantPayload)>,
    /// RAM only: why the last unlock can never complete.
    refused: Option<AccountKeyRefusal>,
}

impl AccountKeyState {
    pub(crate) fn to_bytes(&self) -> Vec<u8> {
        let wraps = self
            .wraps
            .iter()
            .map(|(d, (e, w))| {
                Cbor::Array(vec![
                    Cbor::Bytes(d.0.to_vec()),
                    Cbor::Uint(*e),
                    Cbor::Bytes(w.enc.0.to_vec()),
                    Cbor::Bytes(w.ct.0.clone()),
                ])
            })
            .collect();
        let commits = self
            .commits
            .iter()
            .map(|(e, c)| Cbor::Array(vec![Cbor::Uint(*e), Cbor::Bytes(c.0.to_vec())]))
            .collect();
        let rekey = match self.last_rekey.as_ref().and_then(|r| r.to_bytes().ok()) {
            Some(b) => Cbor::Bytes(b),
            None => Cbor::Null,
        };
        let trusted = self
            .trusted
            .iter()
            .map(|d| Cbor::Bytes(d.0.to_vec()))
            .collect();
        cbor::encode(&Cbor::Array(vec![
            Cbor::Uint(2),
            Cbor::Array(wraps),
            Cbor::Array(commits),
            rekey,
            Cbor::Array(trusted),
        ]))
        .unwrap_or_default()
    }

    /// Strict, bounded decoding (reloaded at open from store meta).
    pub(crate) fn from_bytes(b: &[u8]) -> Option<AccountKeyState> {
        let Cbor::Array(a) = cbor::decode(b).ok()? else {
            return None;
        };
        let [
            Cbor::Uint(2),
            Cbor::Array(wraps),
            Cbor::Array(commits),
            rekey,
            Cbor::Array(trusted),
        ] = a.as_slice()
        else {
            return None;
        };
        if wraps.len() > MAX_WRAPS || commits.len() > MAX_COMMITS || trusted.len() > MAX_TRUSTED {
            return None;
        }
        let uuid = |c: &Cbor| match c {
            Cbor::Bytes(b) => Some(mdbn_wire::common::B16(b.as_slice().try_into().ok()?)),
            _ => None,
        };
        let b32 = |c: &Cbor| match c {
            Cbor::Bytes(b) => Some(B32(b.as_slice().try_into().ok()?)),
            _ => None,
        };
        let mut s = AccountKeyState::default();
        for w in wraps {
            let Cbor::Array(w) = w else { return None };
            let [d, Cbor::Uint(e), enc, Cbor::Bytes(ct)] = w.as_slice() else {
                return None;
            };
            if ct.len() > 1024 {
                return None;
            }
            let device = uuid(d)?;
            let w = KeyWrap {
                device,
                enc: b32(enc)?,
                ct: Bytes(ct.clone()),
            };
            if s.wraps.insert(device, (*e, w)).is_some() {
                return None;
            }
        }
        for c in commits {
            let Cbor::Array(c) = c else { return None };
            let [Cbor::Uint(e), c] = c.as_slice() else {
                return None;
            };
            if s.commits.insert(*e, b32(c)?).is_some() {
                return None;
            }
        }
        s.last_rekey = match rekey {
            Cbor::Null => None,
            Cbor::Bytes(b) => Some(RekeyPayload::from_bytes(b).ok()?),
            _ => return None,
        };
        for t in trusted {
            if !s.trusted.insert(uuid(t)?) {
                return None;
            }
        }
        Some(s)
    }

    pub(crate) fn trusted(&self) -> &BTreeSet<Uuid> {
        &self.trusted
    }

    /// Restore the persisted part from a checkpoint; RAM-only state is kept. False
    /// if the bytes do not decode (never expected: they came from `to_bytes`).
    pub(crate) fn restore_persisted(&mut self, bytes: &[u8]) -> bool {
        match AccountKeyState::from_bytes(bytes) {
            Some(s) => {
                self.wraps = s.wraps;
                self.commits = s.commits;
                self.last_rekey = s.last_rekey;
                self.trusted = s.trusted;
                true
            }
            None => false,
        }
    }
}

/// Refusals that are evidence of tampering (raised as an incident), as opposed to
/// an account key that is not available for this collection (yet).
pub(crate) fn account_key_tampering(reason: AccountKeyRefusal) -> bool {
    matches!(
        reason,
        AccountKeyRefusal::Inconsistent | AccountKeyRefusal::EnrolmentMismatch
    )
}

fn user(kind: DeviceKind) -> bool {
    matches!(
        kind,
        DeviceKind::Desktop | DeviceKind::Mobile | DeviceKind::AppRuntime | DeviceKind::Cli
    )
}

/// Note a control item's account-key data into `wraps`/`commits`/`last_rekey`.
fn note_item(
    policy: &PolicyState,
    item: &Item,
    wraps: &mut dyn FnMut(Uuid, u64, &KeyWrap),
    commits: &mut BTreeMap<u64, B32>,
    last_rekey: &mut Option<RekeyPayload>,
) {
    match item.kind {
        ItemKind::Rekey => {
            if let Ok(rk) = RekeyPayload::from_bytes(&item.body.0) {
                commits.insert(rk.epoch, rk.commit);
                for w in &rk.wraps {
                    if policy
                        .devices
                        .get(&w.device)
                        .is_some_and(|d| d.kind == DeviceKind::Recovery)
                    {
                        wraps(w.device, rk.epoch, w);
                    }
                }
                *last_rekey = Some(rk);
            }
        }
        ItemKind::KeyGrant => {
            if let Ok(kg) = KeyGrantPayload::from_bytes(&item.body.0)
                && policy
                    .devices
                    .get(&kg.recipient)
                    .is_some_and(|d| d.kind == DeviceKind::Recovery)
            {
                wraps(kg.recipient, kg.epoch, &kg.wrap);
            }
        }
        _ => {}
    }
}

impl<S: Store> Replica<S> {
    /// Remember account-key data of an applied control item (after the policy
    /// accepted it). Called from `evaluate_control`.
    pub(crate) fn note_account_key_item(&mut self, item: &Item) {
        let state = &mut self.account_key;
        let mut wraps = std::mem::take(&mut state.wraps);
        let mut note = |d: Uuid, e: u64, w: &KeyWrap| {
            if wraps.len() < MAX_WRAPS || wraps.contains_key(&d) {
                wraps.insert(d, (e, w.clone()));
            }
        };
        note_item(
            &self.policy,
            item,
            &mut note,
            &mut state.commits,
            &mut state.last_rekey,
        );
        state.wraps = wraps;
    }

    /// The persisted account-key state.
    pub(crate) fn account_key_meta(&self) -> (String, Option<Vec<u8>>) {
        (META.into(), Some(self.account_key.to_bytes()))
    }

    /// Lifecycle fences shared by every account-key operation.
    fn account_key_fences(&self) -> Result<(), AccountKeyRefusal> {
        if self.apply_fault {
            return Err(AccountKeyRefusal::OutcomeUnknown);
        }
        if self.local_only() || self.is_hosted() {
            return Err(AccountKeyRefusal::NotPrivate);
        }
        if self.install.is_some() {
            return Err(AccountKeyRefusal::NotReady);
        }
        Ok(())
    }

    /// The collection is private in `policy`: `NotReady` while no policy is
    /// applied (no cstate yet), `NotPrivate` when the applied cstate is not e2e.
    fn private_in(policy: &PolicyState) -> Result<(), AccountKeyRefusal> {
        match policy.cstate {
            Some(CState::E2e) => Ok(()),
            None => Err(AccountKeyRefusal::NotReady),
            Some(_) => Err(AccountKeyRefusal::NotPrivate),
        }
    }

    /// The enrolled recovery device for `keys` in `policy`, of `account`, checked
    /// against the derived keys.
    fn account_key_device_in<'p>(
        policy: &'p PolicyState,
        keys: &RecoveryKeys,
        account: Uuid,
    ) -> Result<&'p crate::policy::DeviceState, AccountKeyRefusal> {
        Self::private_in(policy)?;
        let d = policy
            .devices
            .get(&keys.device)
            .filter(|d| d.active && d.kind == DeviceKind::Recovery)
            .ok_or(AccountKeyRefusal::DeviceMissing)?;
        if d.account != account
            || !keys.matches_enrolment(&keys.device, &d.sign_pk.0, &d.kem_pk.0, &d.noise_pk.0)
        {
            return Err(AccountKeyRefusal::EnrolmentMismatch);
        }
        Ok(d)
    }

    /// This device, active and a user kind in `policy`: its account.
    fn own_user_account(&self, policy: &PolicyState) -> Result<Uuid, AccountKeyRefusal> {
        policy
            .devices
            .get(&self.cfg.device_id)
            .filter(|d| d.active && user(d.kind) && policy.members.contains_key(&d.account))
            .map(|d| d.account)
            .ok_or(AccountKeyRefusal::NotEnrolled)
    }

    /// Whether this collection's account-key device is enrolled, matching, and keyed
    /// (in the applied policy).
    pub fn account_key_device_keyed(&self, keys: &RecoveryKeys) -> Result<bool, AccountKeyRefusal> {
        let account = self.own_user_account(&self.policy)?;
        Ok(Self::account_key_device_in(&self.policy, keys, account)?.keyed)
    }

    /// This device may key its account's recovery device now: an active user
    /// device of a member account (in the applied policy), keyed for the current
    /// epoch with a trusted key, of an editor (or owner) account, with no rekey
    /// outstanding. Exactly the authority [`Replica::key_account_key_device`]
    /// requires, so the account-key device is only enrolled where it can be keyed.
    fn may_key_account_key_device(&self) -> bool {
        let Ok(account) = self.own_user_account(&self.policy) else {
            return false;
        };
        let keyed = self
            .policy
            .devices
            .get(&self.cfg.device_id)
            .is_some_and(|d| d.keyed);
        let editor = self
            .policy
            .members
            .get(&account)
            .is_some_and(|r| *r >= Role::Editor);
        keyed
            && editor
            && !self.key_untrusted
            && !self.policy.rekey_required
            && self.sealer.current_epoch() == Some(self.policy.epoch)
    }

    /// Whether this device may key its account's account-key device in this private
    /// collection now (`Ok(false)`: not keyed, not an editor, or a rekey is
    /// outstanding). Read-only; refused outside a private collection.
    pub fn account_key_can_key(&self) -> Result<bool, AccountKeyRefusal> {
        self.account_key_fences()?;
        Self::private_in(&self.policy)?;
        self.own_user_account(&self.policy)?;
        Ok(self.may_key_account_key_device())
    }

    /// Setup: queue a `key_grant` to this account's recovery device for the
    /// control slot. A no-op when it is already keyed.
    pub fn key_account_key_device(&mut self, keys: &RecoveryKeys) -> Result<(), AccountKeyRefusal> {
        self.account_key_fences()?;
        let account = self.own_user_account(&self.policy)?;
        let d = Self::account_key_device_in(&self.policy, keys, account)?;
        if d.keyed {
            return Ok(());
        }
        let kem_pk = d.kem_pk.0;
        if !self.may_key_account_key_device() {
            return Err(AccountKeyRefusal::NotAuthorized);
        }
        let payload = self
            .sealer
            .build_key_grant(
                self.policy.epoch,
                &Recipient {
                    device: keys.device,
                    kem_pk,
                },
                self.host.entropy.as_mut(),
            )
            .map_err(|_| AccountKeyRefusal::Failed)?;
        self.account_key.setup = Some((keys.device, self.policy.epoch, payload));
        self.status_dirty = true;
        Ok(())
    }

    /// The control-slot step for a queued setup grant. True when sent.
    pub(crate) fn send_account_key_setup_if_needed(&mut self) -> bool {
        let Some((device, epoch, payload)) = self.account_key.setup.take() else {
            return false;
        };
        let current = epoch == self.policy.epoch
            && self
                .policy
                .devices
                .get(&device)
                .is_some_and(|d| d.active && !d.keyed);
        if !current {
            return false;
        }
        let Ok(body) = payload.to_bytes() else {
            return false;
        };
        self.append_control(ItemKind::KeyGrant, body)
    }

    /// Unlock: start reading control items ahead to the head; the result is
    /// verified at the head before anything is installed (see the module docs).
    /// `Ok(())` means started; poll [`Replica::account_key_unlock_state`].
    pub fn self_grant_with_account_key(
        &mut self,
        keys: RecoveryKeys,
    ) -> Result<(), AccountKeyRefusal> {
        self.account_key_fences()?;
        self.account_key.refused = None;
        self.account_key.pending = None;
        let wrap = self.account_key.wraps.get(&keys.device).cloned();
        self.account_key.ahead = Some(Ahead {
            keys,
            after: self.head.seq,
            target: self.head_known.max(self.head.seq),
            reading: false,
            policy: self.policy.clone(),
            wrap,
            commits: self.account_key.commits.clone(),
            last_rekey: self.account_key.last_rekey.clone(),
            rekeys: Vec::new(),
        });
        self.status_dirty = true;
        self.account_key_ahead_step();
        Ok(())
    }

    /// Read the next page of control items ahead, or finish at the target.
    pub(crate) fn account_key_ahead_step(&mut self) {
        let Some(a) = self.account_key.ahead.as_mut() else {
            return;
        };
        if a.reading {
            return;
        }
        if a.after >= a.target {
            let a = self.account_key.ahead.take();
            if let Some(a) = a {
                self.account_key_finish(a);
            }
            return;
        }
        a.reading = true;
        let after = a.after;
        let call = self.queue(LogRequest::Read(ReadParams {
            collection: self.cfg.collection,
            after,
            limit: AHEAD_PAGE,
            kinds: Some(mdbn_wire::log_service::ReadKinds::Control),
            max_bytes: None,
        }));
        self.inflight
            .insert(call, super::append::Inflight::AccountKeyAhead);
    }

    /// A page of control items read ahead for an unlock.
    pub(crate) fn on_account_key_ahead(&mut self, reply: LogReply) {
        let Some(mut a) = self.account_key.ahead.take() else {
            return;
        };
        a.reading = false;
        let r = match reply {
            Ok(LogResponse::Read(r)) => r,
            // Transport trouble: retry on the next pump.
            _ => {
                self.account_key.ahead = Some(a);
                return;
            }
        };
        let env = crate::policy::Env {
            verifier: self.sealer.verifier(),
            trusted_roots: &self.cfg.trusted_roots,
            policy_pins: self.cfg.policy_pins.as_ref(),
        };
        let mut last = None;
        for it in &r.items {
            if it.seq > a.target {
                break;
            }
            if it.seq <= last.unwrap_or(a.after) {
                return self.account_key_refuse(AccountKeyRefusal::Inconsistent);
            }
            let Ok(item) = Item::from_bytes(&it.item.0) else {
                return self.account_key_refuse(AccountKeyRefusal::Inconsistent);
            };
            if item.seq != Some(it.seq)
                || item.collection != self.cfg.collection
                || !item.kind.is_control()
            {
                return self.account_key_refuse(AccountKeyRefusal::Inconsistent);
            }
            last = Some(it.seq);
            // Grant approvals are sealed and change only grants; they do not affect
            // devices, keys or epochs.
            if item.kind == ItemKind::GrantApproval {
                continue;
            }
            let chain = mdbn_wire::hash::chain_hash(&it.item.0);
            match a.policy.apply_control(it.seq, &chain, &item, &env) {
                Ok(_) => {}
                Err(crate::policy::Rejected::Void(_)) => continue,
                Err(crate::policy::Rejected::Stall(_)) => {
                    return self.account_key_refuse(AccountKeyRefusal::Inconsistent);
                }
            }
            let target = a.keys.device;
            let mut wrap = a.wrap.take();
            let mut note = |d: Uuid, e: u64, w: &KeyWrap| {
                if d == target {
                    wrap = Some((e, w.clone()));
                }
            };
            note_item(
                &a.policy,
                &item,
                &mut note,
                &mut a.commits,
                &mut a.last_rekey,
            );
            a.wrap = wrap;
            if item.kind == ItemKind::Rekey
                && let Ok(rk) = RekeyPayload::from_bytes(&item.body.0)
            {
                a.rekeys.push(rk);
            }
        }
        let done = !r.more || last.is_some_and(|l| l >= a.target) || r.items.is_empty();
        if let Some(l) = last {
            a.after = l;
        }
        if done {
            a.after = a.target;
        }
        self.account_key.ahead = Some(a);
        self.account_key_ahead_step();
    }

    /// End an unlock with a typed refusal (read by
    /// [`Replica::account_key_unlock_state`]). Only evidence of tampering (a wrap or
    /// history key that fails its commitment, or an enrolment that does not carry
    /// the keys derived from `R`) is raised as a `KeyInconsistent` incident. Every
    /// other refusal (no account-key device enrolled or keyed yet, revoked, this
    /// device not enrolled yet, a refused local commit) leaves the collection
    /// serving and waiting for a key: an unlock that cannot be done yet must never
    /// fail the collection.
    fn account_key_refuse(&mut self, reason: AccountKeyRefusal) {
        self.account_key.ahead = None;
        self.account_key.pending = None;
        self.account_key.refused = Some(reason);
        if account_key_tampering(reason) {
            self.incident(
                mdbn_wire::client::IncidentKind::KeyInconsistent,
                Some(mdbn_wire::common::Value::Text(
                    "account_key_unlock_refused".into(),
                )),
            );
        }
        self.status_dirty = true;
    }

    /// Verify at the head and install, or refuse with nothing installed.
    fn account_key_finish(&mut self, a: Ahead) {
        match self.account_key_verify(&a) {
            Ok(epoch_keys) => self.account_key_install(a, epoch_keys),
            Err(e) => self.account_key_refuse(e),
        }
    }

    /// The checks at the head; the head key and older keys, each against its
    /// commitment.
    fn account_key_verify(
        &self,
        a: &Ahead,
    ) -> Result<Vec<(u64, crate::crypto::Secret32)>, AccountKeyRefusal> {
        let p = &a.policy;
        // Read ahead to the head and still no policy: not applied yet, not refused.
        Self::private_in(p)?;
        if p.frozen || p.rekey_required || p.epoch == 0 {
            return Err(AccountKeyRefusal::NotPrivate);
        }
        let account = self.own_user_account(p)?;
        if p.devices[&self.cfg.device_id].keyed {
            // Already keyed at the head: nothing to install or grant.
            return Ok(Vec::new());
        }
        let d = Self::account_key_device_in(p, &a.keys, account)?;
        if !d.keyed {
            return Err(AccountKeyRefusal::NotKeyed);
        }
        let (wepoch, wrap) = a.wrap.clone().ok_or(AccountKeyRefusal::NoWrap)?;
        if wepoch != p.epoch {
            return Err(AccountKeyRefusal::NoWrap);
        }
        let commit = *a.commits.get(&p.epoch).ok_or(AccountKeyRefusal::NoWrap)?;
        let collection = self.cfg.collection;
        let key = keys::unwrap_key(&wrap, &collection, p.epoch, &a.keys.kem)
            .map_err(|_| AccountKeyRefusal::Inconsistent)?;
        keys::check_commit(&key, &collection, p.epoch, &commit)
            .map_err(|_| AccountKeyRefusal::Inconsistent)?;
        let mut out = Vec::new();
        if let Some(rk) = a
            .last_rekey
            .as_ref()
            .filter(|rk| rk.epoch == p.epoch && rk.from != 0)
        {
            let history = keys::open_history(&key, &collection, p.epoch, &rk.history)
                .map_err(|_| AccountKeyRefusal::Inconsistent)?;
            out = keys::verify_history(history, &collection, &a.commits)
                .map_err(|_| AccountKeyRefusal::Inconsistent)?;
        }
        out.push((p.epoch, key));
        Ok(out)
    }

    /// Install the verified keys (under a checkpoint) and queue the self-grant.
    fn account_key_install(&mut self, a: Ahead, epoch_keys: Vec<(u64, crate::crypto::Secret32)>) {
        if epoch_keys.is_empty() {
            self.check_key_trust();
            return;
        }
        let checkpoint = super::apply_checkpoint::Checkpoint::capture(self);
        // The epochs' commitments first (the rekeys read ahead), then each key.
        for rk in &a.rekeys {
            let _ = self.sealer.accept_rekey(rk);
        }
        let my_kem = self.sealer.kem_public().unwrap_or_else(|| {
            crate::crypto::hpke::KemKeyPair::from_secret(&self.secrets.kem_sk).pk
        });
        let me = Recipient {
            device: self.cfg.device_id,
            kem_pk: my_kem,
        };
        let mut ok = true;
        let mut last = crate::seal::KeyEvent::None;
        for (epoch, key) in &epoch_keys {
            let ev = keys::build_key_grant(
                &self.cfg.collection,
                *epoch,
                key,
                &me,
                self.host.entropy.as_mut(),
            )
            .map(|g| self.sealer.accept_key_grant(&g));
            match ev {
                Ok(e @ crate::seal::KeyEvent::Keyed { .. }) => last = e,
                _ => ok = false,
            }
        }
        // Trust the account-key device and the one device that keyed it, when that
        // is a user device of the same account: a
        // later rekey by the setup device stays trusted; nothing further up is.
        let rd = &a.policy.devices[&a.keys.device];
        let mut trusted = vec![a.keys.device];
        if let Some(x) = rd.introduced_by
            && a.policy
                .devices
                .get(&x)
                .is_some_and(|d| d.account == rd.account && user(d.kind))
        {
            trusted.push(x);
        }
        if !ok || self.account_key.trusted.len() + trusted.len() > MAX_TRUSTED {
            if checkpoint.restore(self, true).is_err() {
                self.account_key_fault("account_key_restore_failed");
            } else {
                self.account_key_refuse(AccountKeyRefusal::Inconsistent);
            }
            return;
        }
        self.account_key.trusted.extend(trusted);
        let mut meta = vec![self.account_key_meta()];
        meta.extend(self.keyring_meta());
        if let Err(e) = self.store.commit(crate::store::Tx {
            meta,
            ..crate::store::Tx::default()
        }) {
            let aborted = matches!(e, crate::store::StoreError::CommitAborted(_));
            let restored = checkpoint.restore(self, aborted);
            if aborted && restored.is_ok() {
                self.account_key_refuse(AccountKeyRefusal::Failed);
            } else {
                self.account_key_fault("account_key_commit_unknown");
            }
            return;
        }
        self.on_key_event(last);
        self.check_key_trust();
        self.account_key.pending = Some(PendingSelfGrant {
            keys: a.keys,
            attempts: 0,
        });
        self.status_dirty = true;
    }

    /// An account-key commit with an unknown outcome: stop serving, sealing and
    /// appending until reopened, as a failed apply with unknown durability does.
    fn account_key_fault(&mut self, reason: &str) {
        self.apply_fault = true;
        self.account_key.ahead = None;
        self.account_key.pending = None;
        self.account_key.refused = Some(AccountKeyRefusal::OutcomeUnknown);
        self.calls.clear();
        self.inflight.clear();
        self.append = super::append::AppendState::Stopped;
        self.incident(
            mdbn_wire::client::IncidentKind::Integrity,
            Some(mdbn_wire::common::Value::Text(reason.into())),
        );
    }

    /// The unlock's state: `Ok(true)` keyed in the applied policy and trusted,
    /// `Ok(false)` still in progress, `Err` refused for good.
    pub fn account_key_unlock_state(&self) -> Result<bool, AccountKeyRefusal> {
        if self.apply_fault {
            return Err(AccountKeyRefusal::OutcomeUnknown);
        }
        if self.account_key_unlocked() {
            return Ok(true);
        }
        match self.account_key.refused {
            Some(r) => Err(r),
            None => Ok(false),
        }
    }

    /// Whether this device is keyed in the applied policy and trusts its key.
    /// This is the authenticated end of an unlock, not its local install.
    pub fn account_key_unlocked(&self) -> bool {
        self.policy
            .devices
            .get(&self.cfg.device_id)
            .is_some_and(|d| d.active && d.keyed)
            && !self.key_untrusted
            && !self.apply_fault
    }

    /// Strict mode, per collection: whether `device` (a revoked account-key
    /// device) is inactive in the applied policy and the revocation was rekeyed.
    pub fn account_key_revoked_and_rekeyed(&self, device: &Uuid) -> Option<bool> {
        let d = self.policy.devices.get(device)?;
        Some(!d.active && !d.keyed && !self.policy.rekey_required)
    }

    /// The applied log state is healthy: no log-regression window, no lost-tail
    /// repair and no pending lost control (latched revocation, rollback or
    /// fallback). Unkeyed devices (an approval requester) need only this.
    pub(crate) fn log_state_healthy(&self) -> bool {
        self.regressed_at.is_none() && self.repair.is_none() && !self.lost_control_pending()
    }

    /// The applied private state is current enough to attest or approve: no
    /// log-regression window, no lost-tail repair, no pending lost control
    /// (latched revocation, rollback or fallback), and the sealer holds the
    /// policy's current epoch key (not only an older one).
    pub(crate) fn private_state_current(&self) -> bool {
        self.log_state_healthy()
            && self.policy.epoch != 0
            && self.sealer.current_epoch() == Some(self.policy.epoch)
    }

    /// Attest only from the healthy DURABLY APPLIED policy. A queued revocation,
    /// read-ahead, void rekey, unkeyed reporter or stale native source never signs.
    /// `revoked_at` and `version` come from the CP's current pending target.
    pub fn account_key_strict_witness(
        &self,
        account: Uuid,
        recovery_device: Uuid,
        version: u64,
        revoked_at: u64,
    ) -> Option<StrictWitness> {
        self.account_key_fences().ok()?;
        if !self.private_state_current() {
            return None;
        }
        if version == 0
            || revoked_at == 0
            || self.head.seq < revoked_at
            // `applied_at` is the head: never attest policy read past it (a
            // snapshot install reads control items ahead of the head).
            || self.policy.seq > self.head.seq
            || self.stalled.is_some()
            || self.is_apply_recovering()
            || self.policy.frozen
            || self.policy.cstate != Some(CState::E2e)
            || !self.account_key_unlocked()
            || self.policy.rekey_required
        {
            return None;
        }
        let source = self.grant_source.as_ref()?;
        let reporter_account = source.active_account()?;
        let source_epoch = source.authority_epoch()?;
        if source_epoch == 0 || self.own_user_account(&self.policy).ok()? != reporter_account {
            return None;
        }
        let revoked = self.policy.devices.get(&recovery_device)?;
        let rekey = self.account_key.last_rekey.as_ref()?;
        if revoked.account != account
            || revoked.kind != DeviceKind::Recovery
            || revoked.active
            || revoked.keyed
            || rekey.epoch != self.policy.epoch
            || rekey.epoch == 0
            || rekey.wraps.iter().any(|w| w.device == recovery_device)
        {
            return None;
        }
        let signer = crate::crypto::sign::DeviceSigner::from_seed(&self.secrets.sign_sk);
        if self.policy.devices.get(&self.cfg.device_id)?.sign_pk.0 != signer.public() {
            return None;
        }
        let mut witness = StrictWitness {
            account,
            collection: self.cfg.collection,
            recovery_device,
            version,
            revoked_at,
            applied_at: self.head.seq,
            epoch: self.policy.epoch,
            reporter: self.cfg.device_id,
            signature: mdbn_wire::common::B64([0; 64]),
        };
        witness.signature = mdbn_wire::common::B64(signer.sign_digest(&witness.digest().0));
        (source.active_account() == Some(reporter_account)
            && source.authority_epoch() == Some(source_epoch))
        .then_some(witness)
    }

    /// Append the pending self-grant once this device is caught up and enrolled,
    /// re-checked at the applied head. True when an item was sent.
    pub(crate) fn send_account_key_grant_if_needed(&mut self) -> bool {
        let Some(pending) = self.account_key.pending.take() else {
            return false;
        };
        let me = self.cfg.device_id;
        match self.policy.devices.get(&me) {
            // Keyed in P: done (the keys are dropped and zeroized).
            Some(d) if d.keyed => return false,
            Some(d) if d.active => {}
            _ => {
                self.account_key.pending = Some(pending);
                return false;
            }
        }
        if pending.attempts >= MAX_SELF_GRANT_ATTEMPTS {
            self.account_key_refuse(AccountKeyRefusal::Failed);
            return false;
        }
        let account = match self.own_user_account(&self.policy) {
            Ok(a) => a,
            Err(e) => {
                self.account_key_refuse(e);
                return false;
            }
        };
        let wrap = self.account_key.wraps.get(&pending.keys.device).cloned();
        let check =
            Self::account_key_device_in(&self.policy, &pending.keys, account).and_then(|d| {
                if !d.keyed {
                    return Err(AccountKeyRefusal::NotKeyed);
                }
                let (e, w) = wrap.ok_or(AccountKeyRefusal::NoWrap)?;
                if e != self.policy.epoch {
                    return Err(AccountKeyRefusal::NoWrap);
                }
                Ok(w)
            });
        let wrap = match check {
            Ok(w) => w,
            Err(e) => {
                // Revoked or replaced since the read-ahead: never completes.
                self.account_key_refuse(e);
                return false;
            }
        };
        let epoch = self.policy.epoch;
        let collection = self.cfg.collection;
        let Some(commit) = self.account_key.commits.get(&epoch).copied() else {
            self.account_key.pending = Some(pending);
            return false;
        };
        let key = match keys::unwrap_key(&wrap, &collection, epoch, &pending.keys.kem) {
            Ok(k) if keys::check_commit(&k, &collection, epoch, &commit).is_ok() => k,
            _ => {
                self.account_key_refuse(AccountKeyRefusal::Inconsistent);
                return false;
            }
        };
        let my_kem = self.sealer.kem_public().unwrap_or_else(|| {
            crate::crypto::hpke::KemKeyPair::from_secret(&self.secrets.kem_sk).pk
        });
        let Ok(payload) = keys::build_key_grant(
            &collection,
            epoch,
            &key,
            &Recipient {
                device: me,
                kem_pk: my_kem,
            },
            self.host.entropy.as_mut(),
        ) else {
            self.account_key.pending = Some(pending);
            return false;
        };
        drop(key);
        let Ok(body) = payload.to_bytes() else {
            return false;
        };
        let signer = pending.keys.device;
        let sent = {
            let k = &pending.keys;
            let sign = |item: &mut Item| k.signer.sign_item(item).is_ok();
            self.append_signed_control(ItemKind::KeyGrant, body, signer, &sign)
        };
        self.account_key.pending = Some(PendingSelfGrant {
            keys: pending.keys,
            attempts: pending.attempts + 1,
        });
        sent
    }
}
