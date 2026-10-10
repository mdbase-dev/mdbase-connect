//! Join-ahead: control read-ahead while waiting for a key (`log-entry.md` §4.2).
//!
//! A device enrolled and keyed after content was written stops at the first sealed
//! item it cannot open (`waiting_for_key`). Its `key_grant` is later in the log, so
//! ordered apply alone never reaches it. While stalled at position `N`, the replica
//! reads **control items only** after its applied prefix (bounded pages, up to the
//! known head) and evaluates them on a copy of its policy state with the same
//! signature, certificate and authority checks ordered apply makes. Each
//! `key_grant` is therefore judged under the policy in force at its own position.
//! Nothing read ahead changes the applied policy, the head or any content. Content
//! is never applied out of order, and ordered apply later re-evaluates every item,
//! grants included.
//!
//! Only epoch keys are installed, and only keys checked against the commitment of a
//! `rekey` this replica has already applied in order:
//! - a valid grant to this device of the applied epoch is accepted as ordered apply
//!   accepts it (unwrapped, checked against the applied rekey's commitment);
//! - a valid grant of a later epoch (a rekey ahead) is checked against that rekey's
//!   commitment only to open its history box (`sealed-envelope.md` §5.2). Of the
//!   older keys, only those whose commitment came from an applied rekey are
//!   installed ([`crate::Sealer::accept_key_grant_ahead`]).
//!
//! A key whose commitment was only read ahead is never installed. A service that
//! hides or reorders control items can therefore withhold keys, but cannot plant
//! one that would make ordered apply void content (V3).
//!
//! Scheduling: the scan starts when apply first stalls at `N`. It is extended only
//! when a bounded key-wait probe re-stalls at `N` and the known head has
//! grown. A head hint alone never starts reads, and transport failures pause the
//! scan until the next probe. A void grant, an item ahead that ordered apply could
//! not pass either, or the work bound leaves the replica in a typed
//! `waiting_for_key` ([`KeyWaitReason`], also in the incident's details).

use mdbn_wire::client::IncidentKind;
use mdbn_wire::common::Value;
use mdbn_wire::envelope::{Item, ItemKind, KeyGrantPayload, RekeyPayload};
use mdbn_wire::log_service::{ReadKinds, ReadParams};
use mdbn_wire::schema::Wire;

use super::append::Inflight;
use super::{LogMove, Replica};
use crate::log::{LogReply, LogRequest, LogResponse};
use crate::policy::{PolicyState, Rejected};
use crate::seal::KeyEvent;
use crate::store::Store;

/// Control items per read-ahead page.
const PAGE: u64 = 256;
/// Control items evaluated ahead for one stall position, at most.
const MAX_ITEMS: u64 = 1 << 16;

/// Why a replica is still waiting for a key after reading control items ahead.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyWaitReason {
    /// Control items ahead are being read and evaluated.
    Reading,
    /// Read ahead through `through`: no `key_grant` to this device yet.
    NoGrant {
        /// Last position evaluated.
        through: u64,
    },
    /// The latest `key_grant` to this device ahead is void under the policy at its
    /// position (for example, its recipient or signer was revoked first).
    GrantVoid {
        /// The grant's position.
        seq: u64,
    },
    /// A valid grant to this device whose key does not match its epoch's
    /// commitment, or whose history box does not open (`key_inconsistent`).
    KeyInconsistent {
        /// The grant's position.
        seq: u64,
    },
    /// A valid grant to this device that cannot supply the waiting epoch's key
    /// (its history lacks it, or this sealer keeps no history).
    Unusable {
        /// The grant's position.
        seq: u64,
    },
    /// A control item ahead that ordered apply could not pass either (unknown
    /// variant, malformed, a `base`, or an inconsistent read). Reading stops there.
    Blocked {
        /// The item's position.
        seq: u64,
    },
    /// The work bound for this stall position was reached.
    Limit {
        /// Last position evaluated.
        through: u64,
    },
}

impl KeyWaitReason {
    fn code(self) -> &'static str {
        match self {
            KeyWaitReason::Reading => "reading",
            KeyWaitReason::NoGrant { .. } => "no_grant",
            KeyWaitReason::GrantVoid { .. } => "grant_void",
            KeyWaitReason::KeyInconsistent { .. } => "key_inconsistent",
            KeyWaitReason::Unusable { .. } => "unusable",
            KeyWaitReason::Blocked { .. } => "blocked",
            KeyWaitReason::Limit { .. } => "limit",
        }
    }

    fn at(self) -> Option<u64> {
        match self {
            KeyWaitReason::Reading => None,
            KeyWaitReason::NoGrant { through } | KeyWaitReason::Limit { through } => Some(through),
            KeyWaitReason::GrantVoid { seq }
            | KeyWaitReason::KeyInconsistent { seq }
            | KeyWaitReason::Unusable { seq }
            | KeyWaitReason::Blocked { seq } => Some(seq),
        }
    }
}

/// The read-ahead for one stall position (RAM only).
#[derive(Debug)]
pub(crate) struct JoinAhead {
    /// The stalled position `N`.
    position: u64,
    /// The next read starts after this position.
    after: u64,
    /// Read up to here (the known head when the scan started or was extended).
    target: u64,
    reading: bool,
    /// Transport trouble: wait for the next key-wait probe.
    paused: bool,
    /// No more reading for this position (blocked, limit, or a key installed).
    done: bool,
    /// `P` evaluated through `after`; dropped once done.
    policy: Option<Box<PolicyState>>,
    /// The valid rekey that created `policy`'s epoch, if read ahead.
    last_rekey: Option<RekeyPayload>,
    /// Control items evaluated.
    scanned: u64,
    reason: KeyWaitReason,
    /// The worst grant outcome so far (kept over a later "no grant").
    grant: Option<KeyWaitReason>,
    /// The grant whose key was installed: a re-stall here never rescans.
    keyed_by: Option<u64>,
}

/// The outcome of evaluating one control item ahead.
enum Step {
    Next,
    Stop(KeyWaitReason),
    Keyed,
}

impl<S: Store> Replica<S> {
    fn join_ahead_eligible(&self) -> bool {
        !self.apply_fault
            && !self.local_only()
            && !self.is_hosted()
            && !self.hosted_blocked()
            && self.install.is_none()
            && self.log_move == LogMove::None
            && !self.repairing()
    }

    /// Why this replica is waiting for a key, once a read-ahead has run for the
    /// current stall (`None` when not waiting for a key).
    pub fn key_wait_reason(&self) -> Option<KeyWaitReason> {
        let Some((IncidentKind::WaitingForKey, position)) = self.stalled else {
            return None;
        };
        self.join_ahead
            .as_ref()
            .filter(|a| a.position == position)
            .map(|a| a.reason)
    }

    /// Apply stalled at `position` waiting for a key: start the read-ahead, or
    /// extend it to the known head (a key-wait probe re-stalled here).
    pub(crate) fn join_ahead_on_stall(&mut self, position: u64) {
        if !self.join_ahead_eligible() {
            return;
        }
        let head_known = self.head_known;
        match self.join_ahead.as_mut() {
            Some(a) if a.position == position => {
                a.paused = false;
                if let Some(seq) = a.keyed_by {
                    // The installed key did not open `N` after all: no loop.
                    a.reason = KeyWaitReason::Unusable { seq };
                } else if !a.done && head_known > a.target {
                    a.target = head_known;
                    a.reason = KeyWaitReason::Reading;
                }
            }
            _ => {
                let after = self.head.seq.max(self.policy.seq);
                self.join_ahead = Some(JoinAhead {
                    position,
                    after,
                    target: head_known.max(after),
                    reading: false,
                    paused: false,
                    done: false,
                    policy: Some(Box::new(self.policy.clone())),
                    last_rekey: None,
                    scanned: 0,
                    reason: KeyWaitReason::Reading,
                    grant: None,
                    keyed_by: None,
                });
            }
        }
        self.join_ahead_settle();
        self.note_key_wait_reason();
    }

    /// Queue the next page, if one is due (from the pump while waiting for a key).
    pub(crate) fn join_ahead_step(&mut self) {
        let waiting = match self.stalled {
            Some((IncidentKind::WaitingForKey, p)) => Some(p),
            _ => None,
        };
        if !self.join_ahead_eligible() {
            return;
        }
        let head = self.head.seq;
        let Some(a) = self.join_ahead.as_mut() else {
            return;
        };
        if head >= a.position {
            // Applied past `N` in order: the scan has served its purpose.
            self.join_ahead = None;
            return;
        }
        if waiting != Some(a.position) {
            return;
        }
        if a.reading || a.paused || a.done || a.after >= a.target {
            return;
        }
        a.reading = true;
        let (position, after) = (a.position, a.after);
        let call = self.queue(LogRequest::Read(ReadParams {
            collection: self.cfg.collection,
            after,
            limit: PAGE,
            kinds: Some(ReadKinds::Control),
            max_bytes: None,
        }));
        self.inflight.insert(call, Inflight::JoinAhead(position));
    }

    /// A page of control items read ahead for the stall at `position`.
    pub(crate) fn on_join_ahead(&mut self, position: u64, reply: LogReply) {
        let Some(mut a) = self.join_ahead.take() else {
            return;
        };
        if a.position != position {
            self.join_ahead = Some(a);
            return;
        }
        a.reading = false;
        if self.stalled != Some((IncidentKind::WaitingForKey, position))
            || !self.join_ahead_eligible()
        {
            // Stale: the stall cleared or moved, or the replica changed mode.
            return;
        }
        let r = match reply {
            Ok(LogResponse::Read(r)) if !r.behind => r,
            _ => {
                // Transport trouble or an unusable answer: wait for the next probe.
                a.paused = true;
                self.join_ahead = Some(a);
                return;
            }
        };
        let mut last = None;
        let mut outcome = Step::Next;
        let mut keyed_by = None;
        for it in &r.items {
            if it.seq <= last.unwrap_or(a.after) {
                outcome = Step::Stop(KeyWaitReason::Blocked { seq: it.seq });
                break;
            }
            outcome = self.join_ahead_item(&mut a, it.seq, &it.item.0);
            if !matches!(outcome, Step::Next) {
                keyed_by = Some(it.seq);
                break;
            }
            last = Some(it.seq);
            a.scanned += 1;
            if a.scanned >= MAX_ITEMS {
                outcome = Step::Stop(KeyWaitReason::Limit { through: it.seq });
                break;
            }
        }
        if let Some(l) = last {
            a.after = l;
        }
        match outcome {
            Step::Keyed => {
                a.done = true;
                a.keyed_by = keyed_by;
                a.policy = None;
                a.last_rekey = None;
                a.reason = KeyWaitReason::Reading;
                self.join_ahead = Some(a);
                // Clears the stall; the pump resumes ordered reads from `N`.
                self.on_key_event(KeyEvent::Keyed {
                    epoch: self.policy.epoch,
                });
                return;
            }
            Step::Stop(reason) => {
                a.done = true;
                a.policy = None;
                a.last_rekey = None;
                a.reason = reason;
            }
            Step::Next => {
                if !r.more {
                    // Every control item up to the service's head was evaluated.
                    a.after = a.after.max(r.head);
                    a.target = a.target.max(a.after);
                } else if last.is_none() {
                    // `more` with nothing usable: never spin.
                    a.paused = true;
                }
            }
        }
        self.join_ahead = Some(a);
        self.join_ahead_settle();
        self.note_key_wait_reason();
    }

    /// Evaluate one control item read ahead, as ordered apply would at `seq`.
    fn join_ahead_item(&mut self, a: &mut JoinAhead, seq: u64, raw: &[u8]) -> Step {
        let blocked = Step::Stop(KeyWaitReason::Blocked { seq });
        let Some(policy) = a.policy.as_deref_mut() else {
            return blocked;
        };
        let Ok(item) = Item::from_bytes(raw) else {
            return blocked;
        };
        if item.seq != Some(seq)
            || item.collection != self.cfg.collection
            || !item.kind.is_control()
            || !item.kind.is_log_item()
            || item.check_shape().is_err()
        {
            return blocked;
        }
        match item.kind {
            // Sealed; it changes only grants (never devices, members, epochs or
            // keys), so it cannot change a `key_grant`'s validity.
            ItemKind::GrantApproval => return Step::Next,
            ItemKind::Policy | ItemKind::Rekey | ItemKind::KeyGrant => {}
            // Ordered apply stops at a `base` in this build.
            _ => return blocked,
        }
        let chain = mdbn_wire::hash::chain_hash(raw);
        let env = crate::policy::Env {
            verifier: self.sealer.verifier(),
            trusted_roots: &self.cfg.trusted_roots,
            policy_pins: self.cfg.policy_pins.as_ref(),
        };
        let verdict = policy.apply_control(seq, &chain, &item, &env);
        let mine = (item.kind == ItemKind::KeyGrant)
            .then(|| KeyGrantPayload::from_bytes(&item.body.0).ok())
            .flatten()
            .filter(|g| g.recipient == self.cfg.device_id);
        match verdict {
            Err(Rejected::Stall(_)) => blocked,
            Err(Rejected::Void(_)) => {
                if mine.is_some() {
                    a.grant = Some(KeyWaitReason::GrantVoid { seq });
                }
                Step::Next
            }
            Ok(_) => {
                if item.kind == ItemKind::Rekey {
                    a.last_rekey = RekeyPayload::from_bytes(&item.body.0).ok();
                }
                let Some(grant) = mine else {
                    return Step::Next;
                };
                let want = self.policy.epoch;
                let ev = if grant.epoch == want {
                    // Checked against the commitment of the applied rekey.
                    self.sealer.accept_key_grant(&grant)
                } else if let Some(rk) = a.last_rekey.as_ref().filter(|r| r.epoch == grant.epoch) {
                    self.sealer.accept_key_grant_ahead(&grant, rk, want)
                } else {
                    KeyEvent::None
                };
                match ev {
                    KeyEvent::Keyed { .. } => Step::Keyed,
                    KeyEvent::Inconsistent => {
                        a.grant = Some(KeyWaitReason::KeyInconsistent { seq });
                        Step::Next
                    }
                    KeyEvent::None => {
                        a.grant = Some(KeyWaitReason::Unusable { seq });
                        Step::Next
                    }
                }
            }
        }
    }

    /// An idle scan that read everything due reports its result.
    fn join_ahead_settle(&mut self) {
        if let Some(a) = self.join_ahead.as_mut()
            && !a.done
            && !a.reading
            && a.after >= a.target
        {
            a.reason = a
                .grant
                .unwrap_or(KeyWaitReason::NoGrant { through: a.after });
        }
    }

    /// The typed reason in the `waiting_for_key` incident's details.
    fn note_key_wait_reason(&mut self) {
        let Some(reason) = self.key_wait_reason() else {
            return;
        };
        let Some((_, position)) = self.stalled else {
            return;
        };
        let int = |v: u64| Value::Int(i64::try_from(v).unwrap_or(i64::MAX));
        let mut details = vec![
            ("position".into(), int(position)),
            ("reason".into(), Value::Text(reason.code().into())),
        ];
        if let Some(at) = reason.at() {
            details.push(("at".into(), int(at)));
        }
        self.incident(IncidentKind::WaitingForKey, Some(Value::Map(details)));
    }
}
