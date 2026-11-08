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
pub(super) struct RequesterCode {
    context: Context,
    code: Zeroizing<String>,
    started: i64,
    expires: i64,
}
/// Requester trust in its selected approver (`sealed-envelope.md` §5.3 step 6).
/// Answering a challenge trusts nobody: the selected approver's key grant is
/// accepted only while the log still carries that exchange's commitment, and
/// the approver becomes a trusted signer only when that grant keys this device.
/// Memory only; checkpointed with apply.
#[derive(Clone, Copy, Default)]
pub(super) struct RequesterTrust {
    /// The latest revealed exchange: its selected approver and commitment.
    exchange: Option<(Uuid, B32)>,
    /// The approver whose grant keyed this device, for the host to persist.
    signer: Option<Uuid>,
    /// The saved exchange was consulted for a keyed, untrusted device.
    restored: bool,
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
/// Length of an unrevealed [`NewDevice::state`] saved on its own at enrolment.
const BARE_STATE: usize = 33;

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
        context: &Context,
    ) -> ApiResult<Option<Record>> {
        match journal.load() {
            // The enrolment commitment, saved before the device was enrolled
            // (no policy context existed yet): the bare unrevealed NewDevice
            // state. The host's journal is bound to this collection, account,
            // device and account incarnation; restoring it below checks it
            // against this device's keys and the logged commitment.
            Ok(Some(b)) if b.len() == BARE_STATE => Ok(Some(Record {
                context: context.clone(),
                state: Zeroizing::new(b.to_vec()),
                peer: None,
            })),
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
        let record = match self.requester_load(journal, &context)? {
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
    /// The saved revealed exchange under the SAME current context, policy and
    /// latest commitment: its full selected approver, and the code shown for it
    /// rebuilt from the saved reveal.
    fn requester_saved_exchange(
        &self,
        context: &Context,
        record: &Record,
    ) -> ApiResult<Option<(ApprovalDevice, B32, RequesterCode)>> {
        let Some(peer) = &record.peer else {
            return Ok(None);
        };
        if record.context != *context || !peer.verify_for_policy(self.cfg.collection, &self.policy)
        {
            return Err(denied());
        }
        let ApprovalPeerMessage::Challenge(challenge) = &peer.message else {
            return Err(denied());
        };
        let n = NewDevice::restore(context.collection, context.keys(), &record.state)
            .map_err(|_| denied())?;
        let approver = &challenge.binding.approver;
        if n.approver() != Some(approver.device)
            || B32(n.commitment()) != challenge.binding.commitment
            || challenge.binding.requester != context.me
        {
            return Err(denied());
        }
        let code = n.code(&self.policy, &challenge.r_a.0).ok_or_else(denied)?;
        let display = RequesterCode {
            context: context.clone(),
            code: Zeroizing::new(code),
            started: self.now(),
            expires: challenge.expires_at_ms,
        };
        Ok(Some((
            approver.clone(),
            challenge.binding.commitment,
            display,
        )))
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
        let Some(record) = self.requester_load(journal, &context)? else {
            return Ok(None);
        };
        if !record.context.identity_matches(&context) {
            return Err(denied());
        }
        let Some((approver, ..)) = self.requester_saved_exchange(&context, &record)? else {
            return Ok(None);
        };
        if self.requester_context(session)? != context {
            return Err(denied());
        }
        Ok(Some(approver))
    }

    /// Live six-digit visual comparison code for the trusted host's status UI.
    /// Never exposed to an application session or after authority/expiry changes.
    pub fn requester_approval_code(&self, session: SessionId) -> ApiResult<Option<String>> {
        self.host_only(session)?;
        let Some(display) = &self.approval.requester_code else {
            return Ok(None);
        };
        let now = self.now();
        if now < display.started
            || now >= display.expires
            || self.requester_context(session).as_ref() != Ok(&display.context)
        {
            return Ok(None);
        }
        Ok(Some(display.code.to_string()))
    }

    /// Whether this device is an enrolled, unkeyed approval requester here now.
    pub fn awaiting_device_approval(&self, session: SessionId) -> bool {
        self.requester_context(session).is_ok()
    }

    /// The commitment this requester must log through the control plane
    /// (`approval-request`), if any: a FRESH one once its revealed exchange
    /// expired without a key, or when `renew` (the host could not watch for an
    /// approver's challenge for longer than one may live, so an approver may
    /// have spent the commitment unseen), saved before it is returned; else the
    /// saved one while the applied policy does not carry it yet. Never while a
    /// revealed exchange is still live.
    pub fn device_approval_commitment_to_log(
        &mut self,
        session: SessionId,
        journal: &mut dyn ApprovalSecretJournal,
        renew: bool,
    ) -> ApiResult<Option<B32>> {
        let context = self.requester_context(session)?;
        let Some(mut record) = self.requester_load(journal, &context)? else {
            return Ok(None);
        };
        if !record.context.identity_matches(&context) {
            return Err(denied());
        }
        let mut n = NewDevice::restore(context.collection, context.keys(), &record.state)
            .map_err(|_| denied())?;
        let live = match &record.peer {
            Some(peer) => {
                let ApprovalPeerMessage::Challenge(challenge) = &peer.message else {
                    return Err(denied());
                };
                self.now() < challenge.expires_at_ms
            }
            None => false,
        };
        // After a restart, the saved exchange's approver may still key this
        // device while the log carries its commitment, and its code comes back
        // while it is live (#1072).
        if self.approval.requester_trust.exchange.is_none()
            && let Ok(Some((approver, commitment, display))) =
                self.requester_saved_exchange(&context, &record)
        {
            self.approval.requester_trust.exchange = Some((approver.device, commitment));
            if live && self.approval.requester_code.is_none() {
                self.approval.requester_code = Some(display);
                self.status_dirty = true;
            }
        }
        if live {
            return Ok(None);
        }
        if record.peer.is_some() || renew {
            // The old code is gone at once. Its approver's grant stays usable
            // only until the fresh commitment reaches the log: an Allow the
            // approver sent in time may still be applied.
            self.approval.requester_code = None;
            let fresh = n.fresh(self.host.entropy.as_mut());
            record.context = context.clone();
            record.state = n.state();
            record.peer = None;
            self.requester_save(journal, &record)?;
            if self.requester_context(session)? != context {
                return Err(denied());
            }
            return Ok(Some(B32(fresh)));
        }
        if n.approver().is_some() {
            return Err(denied());
        }
        let logged = self
            .policy
            .devices
            .get(&self.cfg.device_id)
            .and_then(|d| d.sas_commit);
        let saved = B32(n.commitment());
        Ok((logged != Some(saved)).then_some(saved))
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
        let mut record = self.requester_load(journal, &context)?.ok_or_else(denied)?;
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
        // Answering trusts nobody (`RequesterTrust`).
        let envelope = ApprovalPeerMessage::Reveal(super::ApprovalReveal {
            challenge: challenge.clone(),
            r_n: B32(*r_n),
        })
        .sign(&DeviceSigner::from_seed(&self.secrets.sign_sk))
        .map_err(|_| denied())?;
        if self.requester_context(session)? != context {
            return Err(denied());
        }
        self.approval.requester_trust.exchange = Some((
            challenge.binding.approver.device,
            challenge.binding.commitment,
        ));
        self.approval.requester_code = Some(RequesterCode {
            context,
            code: code.clone(),
            started: now,
            expires: challenge.expires_at_ms,
        });
        self.status_dirty = true;
        Ok(RequesterApprovalReveal { code, envelope })
    }

    /// After each applied item: the selected approver becomes a trusted signer
    /// exactly when its key grant keys this device while the log still carries
    /// the exchange's commitment. A commitment replaced in the log (renewed
    /// after expiry, Deny or an unseen challenge), or a key from anyone else,
    /// ends the exchange with no trust.
    pub(super) fn latch_requester_signer(&mut self) {
        let Some((approver, commitment)) = self.approval.requester_trust.exchange else {
            return;
        };
        let Some(me) = self.policy.devices.get(&self.cfg.device_id) else {
            return;
        };
        if me.sas_commit != Some(commitment) {
            self.approval.requester_trust.exchange = None;
            return;
        }
        if !(me.active && me.keyed) {
            return;
        }
        self.approval.requester_trust.exchange = None;
        if me.delivered_by == Some(approver) {
            self.trust_requester_signer(approver);
        }
    }
    fn trust_requester_signer(&mut self, approver: Uuid) {
        if !self.cfg.trusted_signers.contains(&approver) {
            self.cfg.trusted_signers.push(approver);
        }
        self.approval.requester_trust.signer = Some(approver);
        self.status_dirty = true;
    }
    pub(super) fn requester_trust(&self) -> RequesterTrust {
        self.approval.requester_trust
    }
    pub(super) fn set_requester_trust(&mut self, trust: RequesterTrust) {
        self.approval.requester_trust = trust;
    }

    /// The approver whose key grant keyed this device after the user's Allow,
    /// for the host to keep as a trusted signer; repeated until this replica
    /// closes, so a failed save is retried. After a restart that lost it before
    /// the save, the saved exchange names it once, only for this account
    /// incarnation, this device's keys and its latest logged commitment.
    pub fn requester_approval_signer(
        &mut self,
        session: SessionId,
        journal: &mut dyn ApprovalSecretJournal,
    ) -> ApiResult<Option<Uuid>> {
        self.host_only(session)?;
        let trust = self.approval.requester_trust;
        if trust.signer.is_none() && !trust.restored && self.key_untrusted {
            let delivered = self
                .policy
                .devices
                .get(&self.cfg.device_id)
                .filter(|d| d.active && d.keyed)
                .and_then(|d| d.delivered_by);
            if delivered.is_some() {
                let saved = self.requester_saved_approver(journal)?;
                self.approval.requester_trust.restored = true;
                if let Some(approver) = saved.filter(|a| delivered == Some(*a)) {
                    self.trust_requester_signer(approver);
                    self.check_key_trust();
                }
            }
        }
        Ok(self.approval.requester_trust.signer)
    }

    /// The saved exchange's approver for a keyed device (restart after the
    /// grant applied): only for this account incarnation, this device's keys and
    /// its latest logged commitment, signed by that approver's current key.
    fn requester_saved_approver(
        &mut self,
        journal: &mut dyn ApprovalSecretJournal,
    ) -> ApiResult<Option<Uuid>> {
        // Unlike `requester_load`, a failed read here never blocks approvals.
        let Some(bytes) = journal
            .load()
            .map_err(|_| ErrorCode::Unavailable.err("requester secret journal unavailable"))?
        else {
            return Ok(None);
        };
        if bytes.len() == BARE_STATE {
            return Ok(None);
        }
        let record = Record::decode(&bytes)?;
        let Some(peer) = &record.peer else {
            return Ok(None);
        };
        let ApprovalPeerMessage::Challenge(challenge) = &peer.message else {
            return Err(denied());
        };
        let source = self.grant_source.as_ref().ok_or_else(denied)?;
        let stamp = ApprovalAuthorityStamp {
            account: source.active_account().ok_or_else(denied)?,
            epoch: source.authority_epoch().ok_or_else(denied)?,
        };
        let current = |t: &ApprovalDevice| {
            self.policy
                .devices
                .get(&t.device)
                .is_some_and(|d| d.active && ApprovalDevice::from_policy(t.device, d) == *t)
        };
        let me = &record.context.me;
        let n = NewDevice::restore(
            record.context.collection,
            record.context.keys(),
            &record.state,
        )
        .map_err(|_| denied())?;
        let b = &challenge.binding;
        if record.context.collection != self.cfg.collection
            || record.context.stamp != stamp
            || me.device != self.cfg.device_id
            || b.collection != self.cfg.collection
            || b.requester != *me
            || !current(me)
            || !current(&b.approver)
            || self
                .policy
                .devices
                .get(&me.device)
                .and_then(|d| d.sas_commit)
                != Some(b.commitment)
            || B32(n.commitment()) != b.commitment
            || n.approver() != Some(b.approver.device)
            || !peer.verify_signature()
        {
            // Not the exchange that keyed this device.
            return Ok(None);
        }
        Ok(Some(b.approver.device))
    }
}
