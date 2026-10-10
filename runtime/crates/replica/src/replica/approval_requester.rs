//! Requester-side composition of EXISTING NewDevice and signed peer metadata.
//! Persistence is mandatory before commitment/code/reveal output; native supplies
//! OS-secret storage. No journal bytes or embedded peer keys become authority.
use super::{
    ApprovalAuthorityStamp, ApprovalDevice, ApprovalPeerEnvelope, ApprovalPeerMessage, Replica,
};
use crate::api::{ApiResult, ErrorCode};
use crate::approval::{Answer, NewDevice};
use crate::crypto::{hpke::KemKeyPair, keys::EnrolledKeys, sign::DeviceSigner};
use crate::policy::SERVICE_ACCOUNT;
use crate::{SessionId, Store};
use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::common::{B32, Uuid};
use mdbn_wire::policy::{CState, DeviceKind, Role};
use mdbn_wire::schema::Wire;
use zeroize::{Zeroize, Zeroizing};

/// Secret persistence failure; never implies rollback or that old state is safe.
#[derive(Debug, Clone, Copy)]
pub struct ApprovalPersistenceError;
/// Trusted host secret-state port. Native must use OS-keychain-only custody and
/// serialize the one owning actor. Not a remote RPC parameter or permission.
pub trait ApprovalSecretJournal {
    /// Restore the whole blob, or None (fresh commitment required).
    fn load(&mut self) -> Result<Option<Zeroizing<Vec<u8>>>, ApprovalPersistenceError>;
    /// Persist/read-verify the whole blob before any output. Uncertainty is error.
    fn save(&mut self, state: &[u8]) -> Result<(), ApprovalPersistenceError>;
}
/// Requester-only output AFTER secret persistence; never approver/pending/push DTO.
pub struct RequesterApprovalReveal {
    /// Requester-displayed six digits.
    pub code: Zeroizing<String>,
    /// Device-origin-signed reveal for metadata transport, not key delivery.
    pub envelope: ApprovalPeerEnvelope,
}
impl std::fmt::Debug for RequesterApprovalReveal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RequesterApprovalReveal { <redacted> }")
    }
}
#[derive(Clone, PartialEq, Eq)]
struct Context {
    collection: Uuid,
    stamp: ApprovalAuthorityStamp,
    me: ApprovalDevice,
    chain: B32,
    root: Option<Uuid>,
    root_pk: Option<B32>,
    epoch: u64,
    role: Role,
}
impl Context {
    fn identity_matches(&self, b: &Self) -> bool {
        self.collection == b.collection && self.stamp == b.stamp && self.me == b.me
    }
    fn keys(&self) -> EnrolledKeys {
        EnrolledKeys {
            device: self.me.device,
            sign_pk: self.me.sign_pk.0,
            kem_pk: self.me.kem_pk.0,
            noise_pk: self.me.noise_pk.0,
        }
    }
    fn cbor(&self) -> Cbor {
        Cbor::Array(vec![
            self.collection.to_cbor(),
            self.stamp.account.to_cbor(),
            self.stamp.epoch.to_cbor(),
            self.me.device.to_cbor(),
            self.me.kind.to_cbor(),
            self.me.sign_pk.to_cbor(),
            self.me.kem_pk.to_cbor(),
            self.me.noise_pk.to_cbor(),
            self.chain.to_cbor(),
            self.root.as_ref().map(Wire::to_cbor).unwrap_or(Cbor::Null),
            self.root_pk
                .as_ref()
                .map(Wire::to_cbor)
                .unwrap_or(Cbor::Null),
            self.epoch.to_cbor(),
            self.role.to_cbor(),
        ])
    }
    fn decode(c: &Cbor) -> ApiResult<Self> {
        let Cbor::Array(v) = c else {
            return Err(denied());
        };
        if v.len() != 13 {
            return Err(denied());
        }
        let account = field(&v[1])?;
        Ok(Self {
            collection: field(&v[0])?,
            stamp: ApprovalAuthorityStamp {
                account,
                epoch: field(&v[2])?,
            },
            me: ApprovalDevice {
                device: field(&v[3])?,
                account,
                kind: field(&v[4])?,
                sign_pk: field(&v[5])?,
                kem_pk: field(&v[6])?,
                noise_pk: field(&v[7])?,
            },
            chain: field(&v[8])?,
            root: optional(&v[9])?,
            root_pk: optional(&v[10])?,
            epoch: field(&v[11])?,
            role: field(&v[12])?,
        })
    }
}
struct Record {
    context: Context,
    state: Zeroizing<Vec<u8>>,
    peer: Option<ApprovalPeerEnvelope>,
}
fn optional<T: Wire>(v: &Cbor) -> ApiResult<Option<T>> {
    if *v == Cbor::Null {
        Ok(None)
    } else {
        field(v).map(Some)
    }
}
fn field<T: Wire>(v: &Cbor) -> ApiResult<T> {
    T::from_cbor(v).map_err(|_| denied())
}
fn denied() -> crate::api::ApiError {
    ErrorCode::Forbidden.err_with_reason(
        "requester_approval_invalid",
        "current private requester state is required",
    )
}
fn scrub(c: &mut Cbor) {
    match c {
        Cbor::Bytes(b) => b.zeroize(),
        Cbor::Text(t) => t.zeroize(),
        Cbor::Array(v) => v.iter_mut().for_each(scrub),
        Cbor::Map(v) => v.iter_mut().for_each(|(k, v)| {
            scrub(k);
            scrub(v);
        }),
        _ => {}
    }
}
impl Record {
    fn encode(&self) -> ApiResult<Zeroizing<Vec<u8>>> {
        let peer = match &self.peer {
            Some(p) => Cbor::Bytes(p.to_bytes().map_err(|_| denied())?),
            None => Cbor::Null,
        };
        let mut c = Cbor::Array(vec![
            Cbor::Uint(1),
            self.context.cbor(),
            Cbor::Bytes(self.state.to_vec()),
            peer,
        ]);
        let result = cbor::encode(&c).map(Zeroizing::new).map_err(|_| denied());
        scrub(&mut c);
        result
    }
    fn decode(bytes: &[u8]) -> ApiResult<Self> {
        if bytes.len() > 4096 {
            return Err(denied());
        }
        let mut c = cbor::decode(bytes).map_err(|_| denied())?;
        let result = (|| {
            let Cbor::Array(v) = &c else {
                return Err(denied());
            };
            if v.len() != 4 || v[0] != Cbor::Uint(1) {
                return Err(denied());
            }
            let Cbor::Bytes(state) = &v[2] else {
                return Err(denied());
            };
            if !matches!(state.len(), 33 | 49) {
                return Err(denied());
            }
            let peer = match &v[3] {
                Cbor::Null => None,
                Cbor::Bytes(b) => Some(ApprovalPeerEnvelope::from_bytes(b).map_err(|_| denied())?),
                _ => return Err(denied()),
            };
            Ok(Self {
                context: Context::decode(&v[1])?,
                state: Zeroizing::new(state.clone()),
                peer,
            })
        })();
        scrub(&mut c);
        result
    }
}
impl<S: Store> Replica<S> {
    fn requester_context(&self, session: SessionId) -> ApiResult<Context> {
        self.host_only(session)?;
        if self.approval.poisoned
            || self.apply_fault
            || self.is_apply_recovering()
            || self.stalled.is_some()
            || self.install.is_some()
            || self.hosted.is_some()
            || self.local_only()
            || self.key_untrusted
            || self.policy.frozen
            || self.policy.rekey_required
            || self.policy.cstate != Some(CState::E2e)
            || self.policy.epoch == 0
            || !self.log_state_healthy()
        {
            return Err(denied());
        }
        let source = self.grant_source.as_ref().ok_or_else(denied)?;
        let stamp = ApprovalAuthorityStamp {
            account: source.active_account().ok_or_else(denied)?,
            epoch: source.authority_epoch().ok_or_else(denied)?,
        };
        let me = self
            .policy
            .devices
            .get(&self.cfg.device_id)
            .ok_or_else(denied)?;
        let role = *self.policy.members.get(&stamp.account).ok_or_else(denied)?;
        if stamp.account == SERVICE_ACCOUNT
            || stamp.epoch == 0
            || !me.active
            || me.keyed
            || me.account != stamp.account
            || !matches!(
                me.kind,
                DeviceKind::Desktop | DeviceKind::Mobile | DeviceKind::AppRuntime | DeviceKind::Cli
            )
            || me.sign_pk.0 != DeviceSigner::from_seed(&self.secrets.sign_sk).public()
            || me.kem_pk.0 != KemKeyPair::from_secret(&self.secrets.kem_sk).pk
            || source.device_noise_pk() != Some(me.noise_pk)
        {
            return Err(denied());
        }
        Ok(Context {
            collection: self.cfg.collection,
            stamp,
            me: ApprovalDevice {
                device: self.cfg.device_id,
                account: me.account,
                kind: me.kind,
                sign_pk: me.sign_pk,
                kem_pk: me.kem_pk,
                noise_pk: me.noise_pk,
            },
            chain: self.policy.ctl_chain,
            root: self.policy.root,
            root_pk: self.policy.root_pk,
            epoch: self.policy.epoch,
            role,
        })
    }
    fn requester_load(
        &mut self,
        journal: &mut dyn ApprovalSecretJournal,
    ) -> ApiResult<Option<Record>> {
        match journal.load() {
            Ok(Some(b)) => Record::decode(&b).map(Some),
            Ok(None) => Ok(None),
            Err(_) => {
                self.approval.poisoned = true;
                Err(ErrorCode::Unavailable
                    .err("requester secret journal unavailable; reopen required"))
            }
        }
    }
    fn requester_save(
        &mut self,
        journal: &mut dyn ApprovalSecretJournal,
        record: &Record,
    ) -> ApiResult<()> {
        if journal.save(&record.encode()?).is_err() {
            self.approval.poisoned = true;
            return Err(
                ErrorCode::OutcomeUnknown.err("requester persistence uncertain; reopen required")
            );
        }
        Ok(())
    }
    /// Restore/create a commitment, saving EXISTING NewDevice.state BEFORE it can
    /// be sent in authenticated enrolment/renewal. No old revealed budget resets.
    pub fn request_device_approval_commitment(
        &mut self,
        session: SessionId,
        journal: &mut dyn ApprovalSecretJournal,
    ) -> ApiResult<B32> {
        let context = self.requester_context(session)?;
        let record = match self.requester_load(journal)? {
            Some(r) => {
                if !r.context.identity_matches(&context) {
                    return Err(denied());
                }
                r
            }
            None => {
                let n = NewDevice::new(
                    context.collection,
                    context.keys(),
                    self.host.entropy.as_mut(),
                );
                let r = Record {
                    context: context.clone(),
                    state: n.state(),
                    peer: None,
                };
                self.requester_save(journal, &r)?;
                r
            }
        };
        let n = NewDevice::restore(context.collection, context.keys(), &record.state)
            .map_err(|_| denied())?;
        if n.approver().is_some() {
            return Err(ErrorCode::Conflict.err_with_reason(
                "approval_commit_required",
                "already revealed; a fresh logged commitment is required",
            ));
        }
        if self.requester_context(session)? != context {
            return Err(denied());
        }
        Ok(B32(n.commitment()))
    }
    /// Restore the FULL selected approver only under the SAME current account,
    /// incarnation, custody, security-control witness and latest commitment.
    /// This is a pending key-delivery signer pin, not approval/keyed/Ready success.
    pub fn restore_requester_approval_peer(
        &mut self,
        session: SessionId,
        journal: &mut dyn ApprovalSecretJournal,
    ) -> ApiResult<Option<ApprovalDevice>> {
        let context = self.requester_context(session)?;
        let Some(record) = self.requester_load(journal)? else {
            return Ok(None);
        };
        if !record.context.identity_matches(&context) {
            return Err(denied());
        }
        let Some(peer) = record.peer else {
            return Ok(None);
        };
        if record.context != context || !peer.verify_for_policy(self.cfg.collection, &self.policy) {
            return Err(denied());
        }
        let ApprovalPeerMessage::Challenge(challenge) = &peer.message else {
            return Err(denied());
        };
        let n = NewDevice::restore(context.collection, context.keys(), &record.state)
            .map_err(|_| denied())?;
        if n.approver() != Some(challenge.binding.approver.device)
            || B32(n.commitment()) != challenge.binding.commitment
            || challenge.binding.requester != context.me
            || self.requester_context(session)? != context
        {
            return Err(denied());
        }
        Ok(Some(challenge.binding.approver.clone()))
    }

    /// Signed requester ingress. Validate CURRENT public policy/own custody/latest
    /// commitment, persist revealed state + ENTIRE signed selected challenge in one
    /// secret transaction, recheck after I/O, THEN make code/reveal available.
    pub fn receive_device_approval_challenge(
        &mut self,
        session: SessionId,
        peer: &ApprovalPeerEnvelope,
        journal: &mut dyn ApprovalSecretJournal,
    ) -> ApiResult<RequesterApprovalReveal> {
        let context = self.requester_context(session)?;
        let ApprovalPeerMessage::Challenge(challenge) = &peer.message else {
            return Err(denied());
        };
        let now = self.now();
        if !peer.verify_for_policy(self.cfg.collection, &self.policy)
            || challenge.binding.requester != context.me
            || now >= challenge.expires_at_ms
            || challenge.expires_at_ms.saturating_sub(now) > 120_000
        {
            return Err(denied());
        }
        let mut record = self.requester_load(journal)?.ok_or_else(denied)?;
        if !record.context.identity_matches(&context) || record.peer.is_some() {
            return Err(ErrorCode::Conflict.err_with_reason(
                "approval_commit_required",
                "requester needs a fresh logged commitment",
            ));
        }
        let mut n = NewDevice::restore(context.collection, context.keys(), &record.state)
            .map_err(|_| denied())?;
        if B32(n.commitment()) != challenge.binding.commitment
            || self.requester_context(session)? != context
        {
            return Err(denied());
        }
        let Answer::Reveal { r_n, code, state } = n.on_challenge(
            &self.policy,
            &challenge.binding.approver.device,
            &challenge.r_a.0,
        ) else {
            return Err(denied());
        };
        let r_n = Zeroizing::new(r_n);
        let code = Zeroizing::new(code);
        record.context = context.clone();
        record.state = state;
        record.peer = Some(peer.clone());
        self.requester_save(journal, &record)?;
        if self.requester_context(session)? != context
            || self.now() < now
            || self.now() >= challenge.expires_at_ms
        {
            return Err(denied());
        }
        let envelope = ApprovalPeerMessage::Reveal(super::ApprovalReveal {
            challenge: challenge.clone(),
            r_n: B32(*r_n),
        })
        .sign(&DeviceSigner::from_seed(&self.secrets.sign_sk))
        .map_err(|_| denied())?;
        if self.requester_context(session)? != context {
            return Err(denied());
        }
        Ok(RequesterApprovalReveal { code, envelope })
    }
}
