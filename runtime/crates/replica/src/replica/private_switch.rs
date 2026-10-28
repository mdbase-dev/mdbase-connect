//! Device-local, one-shot cloud-copy-off acceptance. No policy/wire validity
//! changes. The frozen set and intent commit with the applied prefix.
use super::Replica;
use crate::api::{ErrorCode, SessionId};
use crate::seal::KeyEvent;
use crate::store::{Head, Store, Tx};
use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::common::{B16, B32, Uuid};
use mdbn_wire::envelope::{Item, RekeyPayload, RekeyReason};
use mdbn_wire::policy::{CState, DeviceKind, Role};
use std::collections::BTreeSet;

pub(super) const META: &str = "replica.private-switch.v1";
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct PrivateSwitch {
    requested: bool,
    state: State,
}
#[derive(Clone, Debug, Default, PartialEq, Eq)]
enum State {
    #[default]
    None,
    Pending {
        at: Head,
        epoch: u64,
        members: BTreeSet<Uuid>,
        owners: BTreeSet<Uuid>,
    },
    Accepted {
        at: Head,
        signer: Uuid,
        epoch: u64,
        acknowledged: bool,
    },
    Refused,
}
impl PrivateSwitch {
    pub(super) fn to_bytes(&self) -> Vec<u8> {
        let state = match &self.state {
            State::None => Cbor::Null,
            State::Refused => Cbor::Array(vec![Cbor::Uint(2)]),
            State::Accepted {
                at,
                signer,
                epoch,
                acknowledged,
            } => Cbor::Array(vec![
                Cbor::Uint(1),
                Cbor::Uint(at.seq),
                Cbor::Bytes(at.chain.0.to_vec()),
                Cbor::Bytes(signer.0.to_vec()),
                Cbor::Uint(*epoch),
                Cbor::Bool(*acknowledged),
            ]),
            State::Pending {
                at,
                epoch,
                members,
                owners,
            } => Cbor::Array(vec![
                Cbor::Uint(0),
                Cbor::Uint(at.seq),
                Cbor::Bytes(at.chain.0.to_vec()),
                Cbor::Uint(*epoch),
                Cbor::Array(
                    members
                        .iter()
                        .map(|id| Cbor::Bytes(id.0.to_vec()))
                        .collect(),
                ),
                Cbor::Array(owners.iter().map(|id| Cbor::Bytes(id.0.to_vec())).collect()),
            ]),
        };
        cbor::encode(&Cbor::Array(vec![Cbor::Bool(self.requested), state]))
            .expect("private switch encodes")
    }
    pub(super) fn from_bytes(bytes: &[u8]) -> Option<Self> {
        let Cbor::Array(values) = cbor::decode(bytes).ok()? else {
            return None;
        };
        let [Cbor::Bool(requested), state] = values.as_slice() else {
            return None;
        };
        let hash = |v: &Cbor| {
            if let Cbor::Bytes(b) = v {
                Some(B32(b.as_slice().try_into().ok()?))
            } else {
                None
            }
        };
        let id = |v: &Cbor| {
            if let Cbor::Bytes(b) = v {
                Some(B16(b.as_slice().try_into().ok()?))
            } else {
                None
            }
        };
        let ids = |v: &Cbor| -> Option<BTreeSet<Uuid>> {
            let Cbor::Array(v) = v else {
                return None;
            };
            let out = v.iter().map(id).collect::<Option<BTreeSet<_>>>()?;
            (out.len() == v.len()).then_some(out)
        };
        let state = match state {
            Cbor::Null => State::None,
            Cbor::Array(v) => match v.as_slice() {
                [Cbor::Uint(2)] => State::Refused,
                [
                    Cbor::Uint(1),
                    Cbor::Uint(seq),
                    chain,
                    signer,
                    Cbor::Uint(epoch),
                    Cbor::Bool(acknowledged),
                ] if *seq > 0 && *epoch > 0 => State::Accepted {
                    at: Head {
                        seq: *seq,
                        chain: hash(chain)?,
                    },
                    signer: id(signer)?,
                    epoch: *epoch,
                    acknowledged: *acknowledged,
                },
                [
                    Cbor::Uint(0),
                    Cbor::Uint(seq),
                    chain,
                    Cbor::Uint(epoch),
                    members,
                    owners,
                ] => {
                    let members = ids(members)?;
                    let owners = ids(owners)?;
                    if *seq == 0 || *epoch == 0 || members.is_empty() || !owners.is_subset(&members)
                    {
                        return None;
                    }
                    State::Pending {
                        at: Head {
                            seq: *seq,
                            chain: hash(chain)?,
                        },
                        epoch: *epoch,
                        members,
                        owners,
                    }
                }
                _ => return None,
            },
            _ => return None,
        };
        Some(Self {
            requested: *requested,
            state,
        })
    }
    pub(super) fn waiting(&self) -> bool {
        matches!(self.state, State::Pending { .. })
    }
    pub(super) fn blocked(&self) -> bool {
        matches!(self.state, State::Pending { .. } | State::Refused)
    }
}
impl<S: Store> Replica<S> {
    /// Host-only durable local intent. Must succeed BEFORE asking the control
    /// plane to switch. Repeating it on a surviving owner lets that owner finish.
    pub fn request_private_switch(&mut self, session: SessionId) -> crate::api::ApiResult<()> {
        self.host_only(session)?;
        self.check_apply_store_health()
            .map_err(|_| ErrorCode::Unavailable.err("reopen required"))?;
        let me = self
            .policy
            .devices
            .get(&self.cfg.device_id)
            .ok_or_else(|| ErrorCode::Forbidden.err("not enrolled"))?;
        let eligible = if let State::Pending { owners, .. } = &self.private_switch.state {
            owners.contains(&self.cfg.device_id)
        } else {
            self.policy.cstate == Some(CState::CloudCopy)
                && self.cfg.user_enabled_cloud_copy
                && !self.key_untrusted
        };
        if !eligible
            || !matches!(
                me.kind,
                DeviceKind::Desktop | DeviceKind::Mobile | DeviceKind::AppRuntime | DeviceKind::Cli
            )
            || !me.active
            || !me.keyed
            || self.policy.members.get(&me.account) != Some(&Role::Owner)
            || self.sealer.current_epoch() != Some(self.policy.epoch)
        {
            return Err(ErrorCode::Forbidden.err("a keyed owner device is required"));
        }
        let mut next = self.private_switch.clone();
        next.requested = true;
        self.save_private_switch(next)
    }

    /// Clear an intent only before the switch policy has applied. A committed
    /// switch is never silently rolled back by an HTTP failure.
    pub fn cancel_private_switch(&mut self, session: SessionId) -> crate::api::ApiResult<()> {
        self.host_only(session)?;
        if matches!(
            self.private_switch.state,
            State::Pending { .. } | State::Refused
        ) {
            return Err(ErrorCode::Conflict.err("switch already committed"));
        }
        let mut next = self.private_switch.clone();
        next.requested = false;
        self.save_private_switch(next)
    }

    /// Called only after the native host durably copied the verified choice into
    /// its link and registration. Until then META recovers that choice on reopen.
    pub fn acknowledge_private_switch(&mut self, session: SessionId) -> crate::api::ApiResult<()> {
        self.host_only(session)?;
        let mut next = self.private_switch.clone();
        let State::Accepted {
            at, acknowledged, ..
        } = &mut next.state
        else {
            return Err(ErrorCode::Conflict.err("private choice is not applied"));
        };
        if at.seq > self.head.seq {
            return Err(ErrorCode::Conflict.err("private choice is not applied"));
        }
        *acknowledged = true;
        // Retain the accepted prefix witness for cold keyring/control rebuilds.
        self.save_private_switch(next)
    }

    fn save_private_switch(&mut self, next: PrivateSwitch) -> crate::api::ApiResult<()> {
        self.check_apply_store_health()
            .map_err(|_| ErrorCode::Unavailable.err("reopen required"))?;
        let checkpoint = super::apply_checkpoint::Checkpoint::capture(self);
        self.private_switch = next;
        if let Err(error) = self.store.commit(Tx {
            meta: vec![self.private_switch_meta()],
            ..Tx::default()
        }) {
            self.failed_apply(
                checkpoint,
                self.head.seq,
                matches!(error, crate::store::StoreError::CommitAborted(_)),
            );
            return Err(ErrorCode::OutcomeUnknown
                .err("private switch save is not confirmed; reopen required"));
        }
        Ok(())
    }
    /// The verified and durably applied acceptance for the native host to copy
    /// into its link/registration. The replica META remains authoritative across
    /// a crash between those host writes. No remote flag can manufacture this.
    pub fn accepted_private_switch(&self) -> Option<Uuid> {
        if self.check_apply_store_health().is_err() {
            return None;
        }
        match self.private_switch.state {
            State::Accepted {
                at,
                signer,
                acknowledged: false,
                ..
            } if self.head.seq >= at.seq => Some(signer),
            _ => None,
        }
    }
    pub(super) fn restore_private_choice(&mut self) {
        if let State::Accepted { at, signer, .. } = self.private_switch.state
            && at.seq <= self.head.seq
        {
            self.cfg.chosen_state = Some(CState::E2e);
            self.cfg.e2e = true;
            self.cfg.user_enabled_cloud_copy = false;
            if !self.cfg.trusted_signers.contains(&signer) {
                self.cfg.trusted_signers.push(signer);
            }
        }
    }
    pub(super) fn private_switch_meta(&self) -> (String, Option<Vec<u8>>) {
        (META.into(), Some(self.private_switch.to_bytes()))
    }
    pub(super) fn capture_private_switch(&mut self, p: u64, chain: B32, eligible: bool) {
        if !eligible
            || matches!(
                self.private_switch.state,
                State::Pending { .. } | State::Refused
            )
        {
            return;
        }
        let members = self
            .policy
            .devices
            .iter()
            .filter(|(_, d)| {
                d.active
                    && d.keyed
                    && matches!(
                        d.kind,
                        DeviceKind::Desktop
                            | DeviceKind::Mobile
                            | DeviceKind::AppRuntime
                            | DeviceKind::Cli
                    )
            })
            .map(|(id, _)| *id)
            .collect::<BTreeSet<_>>();
        if !members.contains(&self.cfg.device_id) {
            return;
        }
        let owners = members
            .iter()
            .filter(|id| {
                self.policy.members.get(&self.policy.devices[id].account) == Some(&Role::Owner)
            })
            .copied()
            .collect();
        self.private_switch.state = State::Pending {
            at: Head { seq: p, chain },
            epoch: self.policy.epoch,
            members,
            owners,
        };
    }
    pub(super) fn can_author_private_switch(&self) -> bool {
        let State::Pending {
            at, epoch, owners, ..
        } = &self.private_switch.state
        else {
            return false;
        };
        self.private_switch.requested
            && owners.contains(&self.cfg.device_id)
            && self.head == *at
            && self.policy.seq == at.seq
            && self.policy.cstate == Some(CState::E2e)
            && self.policy.rekey_required
            && self.check_apply_store_health().is_ok()
            && self.policy.epoch == *epoch
            && self.sealer.current_epoch() == Some(*epoch)
    }
    pub(super) fn accept_private_switch(
        &mut self,
        p: u64,
        chain: B32,
        item: &Item,
        rekey: &RekeyPayload,
        event: KeyEvent,
    ) {
        let State::Pending {
            at,
            epoch,
            members,
            owners,
        } = &self.private_switch.state
        else {
            return;
        };
        let valid = at.seq.checked_add(1) == Some(p)
            && self.head == *at
            && item.prev == Some(at.chain)
            && rekey.from == *epoch
            && rekey.reason == RekeyReason::CloudCopyOff
            && item.signer.is_some_and(|signer| owners.contains(&signer))
            && members.contains(&self.cfg.device_id)
            && matches!(event, KeyEvent::Keyed { epoch } if epoch == rekey.epoch);
        if valid {
            self.private_switch.state = State::Accepted {
                at: Head { seq: p, chain },
                signer: item.signer.expect("checked signer"),
                epoch: rekey.epoch,
                acknowledged: false,
            };
            self.private_switch.requested = false;
            self.restore_private_choice();
        } else {
            self.private_switch.state = State::Refused;
        }
    }
    pub(super) fn expire_private_switch(&mut self, head: Head) {
        if matches!(&self.private_switch.state, State::Pending { at, .. } if head.seq > at.seq) {
            self.private_switch.state = State::Refused;
        }
        if matches!(self.private_switch.state, State::Refused) {
            self.key_untrusted = true;
            self.incident(
                mdbn_wire::client::IncidentKind::KeyInconsistent,
                Some(mdbn_wire::common::Value::Text("key_untrusted".into())),
            );
            self.incident(
                mdbn_wire::client::IncidentKind::Integrity,
                Some(mdbn_wire::common::Value::Text(
                    "collection_state_changed: E2e".into(),
                )),
            );
        }
    }
    pub(crate) fn private_switch_waiting(&self) -> bool {
        self.private_switch.waiting()
    }
    pub(super) fn private_switch_covers(&self, position: u64) -> bool {
        matches!(self.private_switch.state, State::Accepted { at, .. } if position <= at.seq && at.seq <= self.head.seq)
    }

    pub(super) fn private_switch_blocks(&self) -> bool {
        self.private_switch.blocked()
            || matches!(self.private_switch.state, State::Accepted { epoch, .. }
                if self.policy.epoch < epoch || self.policy.cstate != Some(CState::E2e))
    }
}
