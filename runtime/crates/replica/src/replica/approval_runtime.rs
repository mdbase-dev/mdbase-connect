//! Host-only private SAS exchanges. No endpoint is implied by these peer objects.
//! A lost RAM exchange requires a fresh *logged* commitment: its durable consumed
//! marker prevents restarting the three-attempt budget with the old commitment.

use super::Replica;
use crate::api::{ApiResult, ErrorCode, PendingDevice, Push, SessionId};
use crate::approval::{ApprovalError, Approver};
use crate::crypto::{hpke::KemKeyPair, sign::DeviceSigner};
use crate::policy::{DeviceState, SERVICE_ACCOUNT};
use crate::store::{Store, Tx};
use mdbn_wire::common::{B32, Uuid};
use mdbn_wire::envelope::KeyGrantPayload;
use mdbn_wire::policy::{CState, DeviceKind, Role};
use mdbn_wire::schema::Wire;
use std::collections::BTreeMap;
use zeroize::Zeroizing;

/// Authenticated host account epoch, not a policy member inferred from a device.
/// Epochs must never be reused across logout/re-pair, including same-account ABA.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ApprovalAuthorityStamp {
    /// Canonical current active account.
    pub account: Uuid,
    /// Durable host account activation epoch.
    pub epoch: u64,
}

/// Complete public enrolment tuple; IDs alone cannot bind a SAS exchange.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovalDevice {
    /// Enrolled device.
    pub device: Uuid,
    /// Verified policy member.
    pub account: Uuid,
    /// USER device kind.
    pub kind: DeviceKind,
    /// Signing key.
    pub sign_pk: B32,
    /// KEM key.
    pub kem_pk: B32,
    /// Noise key.
    pub noise_pk: B32,
}
impl ApprovalDevice {
    fn from_policy(device: Uuid, d: &DeviceState) -> Self {
        Self {
            device,
            account: d.account,
            kind: d.kind,
            sign_pk: d.sign_pk,
            kem_pk: d.kem_pk,
            noise_pk: d.noise_pk,
        }
    }
}

/// Public peer-channel binding. The receiving replica rechecks its own applied
/// policy; neither Control metadata nor this object is a grant or policy proof.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovalBinding {
    /// Exact collection.
    pub collection: Uuid,
    /// Held/current private epoch.
    pub epoch: u64,
    /// Current approving USER device.
    pub approver: ApprovalDevice,
    /// Current unkeyed USER device.
    pub requester: ApprovalDevice,
    /// Requester's latest applied SAS commitment.
    pub commitment: B32,
}

/// Approver challenge, for metadata mediation only. Contains no computed code.
#[derive(Clone, PartialEq, Eq)]
pub struct ApprovalChallenge {
    /// Full current tuple and commitment.
    pub binding: ApprovalBinding,
    /// Fresh challenge; never telemetry/debug.
    pub r_a: B32,
    /// Bounded host wall-clock lifetime; rollback before creation also cancels.
    pub expires_at_ms: i64,
}
impl std::fmt::Debug for ApprovalChallenge {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ApprovalChallenge")
            .field("binding", &self.binding)
            .finish_non_exhaustive()
    }
}

/// Requester answer. The requester must persist its revealed state/selected
/// approver under OS-secret custody BEFORE making this object available to I/O.
#[derive(Clone, PartialEq, Eq)]
pub struct ApprovalReveal {
    /// Exact challenge answered, fencing delayed/retargeted delivery.
    pub challenge: ApprovalChallenge,
    /// Reveal; never telemetry/debug.
    pub r_n: B32,
}
impl std::fmt::Debug for ApprovalReveal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ApprovalReveal")
            .field("challenge", &self.challenge)
            .finish_non_exhaustive()
    }
}

/// The six digits the approving user typed, compared against the internally
/// computed code and zeroized on drop. Never a `String`, never displayed.
pub struct ApproverCode(Zeroizing<[u8; 6]>);
impl ApproverCode {
    /// Exactly six ASCII digits; spaces and dashes between groups are ignored.
    pub fn parse(typed: &str) -> Option<ApproverCode> {
        let mut out = [0u8; 6];
        let mut n = 0;
        for c in typed.bytes() {
            match c {
                b'0'..=b'9' => {
                    if n == 6 {
                        return None;
                    }
                    out[n] = c;
                    n += 1;
                }
                b' ' | b'-' => {}
                _ => return None,
            }
        }
        (n == 6).then(|| ApproverCode(Zeroizing::new(out)))
    }
    fn as_str(&self) -> &str {
        std::str::from_utf8(&self.0[..]).unwrap_or("")
    }
}
impl std::fmt::Debug for ApproverCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ApproverCode(..)")
    }
}

/// Handle of one confirmed approval: the signed `key_grant` intent it produced.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct ApprovalIntent(pub u64);

/// Why a confirmed approval did not (or will not) key the device.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalRefusal {
    /// The typed code differs from the computed one; the requester must commit
    /// afresh (`approval-request`) before another attempt.
    CodeMismatch,
    /// Three failures against this logged commitment: a fresh commitment is required.
    Exhausted,
    /// No completed reveal for this exchange under this session.
    NotReady,
    /// The account, policy tuple, control chain, epoch or lifecycle changed between
    /// confirmation and the append turn: nothing was sent.
    ContextChanged,
    /// The device was keyed by someone else (or revoked) before our grant landed.
    Superseded,
    /// The signed grant was sent `MAX_GRANT_SENDS` times without landing (head
    /// moved, duplicate or refused each time): confirm again rather than re-append
    /// forever.
    NotAppended,
}

/// Control turns a confirmed grant may be sent before it is refused.
const MAX_GRANT_SENDS: u8 = 3;

/// Where a confirmed approval's `key_grant` is. Only `Applied` means keyed in P.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalDisposition {
    /// Built and signed under the current context; waits for the append turn.
    Queued,
    /// Appended; waiting for the log to carry it back through apply.
    Sent,
    /// Applied at `seq`: the device is keyed in the applied policy.
    Applied {
        /// Log position of the `key_grant`.
        seq: u64,
    },
    /// Refused; nothing further happens for this intent.
    Refused(ApprovalRefusal),
}

/// A confirmed approval awaiting its single control append.
struct PendingGrant {
    intent: ApprovalIntent,
    target: Uuid,
    payload: KeyGrantPayload,
    stamp: ApprovalAuthorityStamp,
    binding: ApprovalBinding,
    control_chain: B32,
    /// Control turns that sent this grant so far.
    sends: u8,
}

#[derive(Clone, PartialEq, Eq)]
struct Context {
    stamp: ApprovalAuthorityStamp,
    binding: ApprovalBinding,
    control_chain: B32,
    approver_role: Role,
    requester_role: Role,
    root: Option<mdbn_wire::common::B16>,
    root_pk: Option<B32>,
    session: SessionId,
}
struct Exchange {
    context: Context,
    challenge: ApprovalChallenge,
    started: i64,
    ready: bool,
    reveal_fingerprint: Option<B32>,
}
pub(super) struct ApprovalRuntime {
    approver: Approver,
    exchanges: BTreeMap<Uuid, Exchange>,
    outbox: Vec<ApprovalChallenge>,
    pub(super) poisoned: bool,
    /// At most one confirmed grant is in flight; a second confirmation waits.
    pending_grant: Option<PendingGrant>,
    next_intent: u64,
    /// Recent intents and where they ended (bounded).
    dispositions: BTreeMap<ApprovalIntent, ApprovalDisposition>,
    /// Own `key_grant`s evaluated into the policy but not yet durably committed:
    /// (signer, recipient, seq). Published only after the commit that persists
    /// that policy succeeds; discarded otherwise (evaluation is not application).
    staged_applied: Vec<(Option<Uuid>, Uuid, u64)>,
}
impl ApprovalRuntime {
    pub(super) fn new(collection: Uuid, device: Uuid) -> Self {
        Self {
            approver: Approver::new(collection, device),
            exchanges: BTreeMap::new(),
            outbox: Vec::new(),
            poisoned: false,
            pending_grant: None,
            next_intent: 1,
            dispositions: BTreeMap::new(),
            staged_applied: Vec::new(),
        }
    }
    fn record(&mut self, intent: ApprovalIntent, d: ApprovalDisposition) {
        self.dispositions.insert(intent, d);
        while self.dispositions.len() > 32 {
            let oldest = *self.dispositions.keys().next().expect("non-empty");
            self.dispositions.remove(&oldest);
        }
    }
}
fn user(kind: DeviceKind) -> bool {
    matches!(
        kind,
        DeviceKind::Desktop | DeviceKind::Mobile | DeviceKind::AppRuntime | DeviceKind::Cli
    )
}
fn denied() -> crate::api::ApiError {
    ErrorCode::Forbidden.err_with_reason(
        "approval_context_invalid",
        "current private USER-device approval authority is required",
    )
}
fn approval_error(e: ApprovalError) -> crate::api::ApiError {
    let reason = match e {
        ApprovalError::Exhausted => "approval_commit_required",
        ApprovalError::BadReveal => "approval_reveal_invalid",
        ApprovalError::CodeMismatch => "approval_code_mismatch",
        _ => "approval_context_invalid",
    };
    ErrorCode::Conflict.err_with_reason(reason, "device approval step was refused")
}
fn marker(binding: &ApprovalBinding) -> String {
    // Independent of mutable epoch/account context: the SAME commitment must not
    // recover its failed-attempt budget after either restart or context ABA.
    let bytes = [
        binding.collection.0.as_slice(),
        binding.requester.device.0.as_slice(),
        binding.commitment.0.as_slice(),
    ]
    .concat();
    format!(
        "approval.consumed.{}",
        mdbn_wire::render::hex(&mdbn_wire::hash::h("mdbase/v1/approval-consumed", &bytes).0)
    )
}

impl<S: Store> Replica<S> {
    fn approval_context(&self, session: SessionId, target: Uuid) -> ApiResult<Context> {
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
            || self.sealer.current_epoch() != Some(self.policy.epoch)
            || !self.private_state_current()
        {
            return Err(denied());
        }
        let source = self.grant_source.as_ref().ok_or_else(denied)?;
        let stamp = ApprovalAuthorityStamp {
            account: source.active_account().ok_or_else(denied)?,
            epoch: source.authority_epoch().ok_or_else(denied)?,
        };
        // Same as the requester: authority incarnation 0 is never a source.
        if stamp.account == SERVICE_ACCOUNT || stamp.account.0 == [0; 16] || stamp.epoch == 0 {
            return Err(denied());
        }
        let me = self
            .policy
            .devices
            .get(&self.cfg.device_id)
            .ok_or_else(denied)?;
        let n = self.policy.devices.get(&target).ok_or_else(denied)?;
        let role = self
            .policy
            .members
            .get(&stamp.account)
            .copied()
            .ok_or_else(denied)?;
        if !me.active
            || !me.keyed
            || !user(me.kind)
            || me.account != stamp.account
            || role < Role::Editor
            || me.sign_pk.0 != DeviceSigner::from_seed(&self.secrets.sign_sk).public()
            || me.kem_pk.0 != KemKeyPair::from_secret(&self.secrets.kem_sk).pk
            || source.device_noise_pk() != Some(me.noise_pk)
            || target.0 == [0; 16]
            || target == self.cfg.device_id
            || !n.active
            || n.keyed
            || !user(n.kind)
            || n.account == SERVICE_ACCOUNT
            || !self.policy.members.contains_key(&n.account)
            || (n.account != stamp.account && role != Role::Owner)
        {
            return Err(denied());
        }
        let binding = ApprovalBinding {
            collection: self.cfg.collection,
            epoch: self.policy.epoch,
            approver: ApprovalDevice::from_policy(self.cfg.device_id, me),
            requester: ApprovalDevice::from_policy(target, n),
            commitment: n.sas_commit.ok_or_else(denied)?,
        };
        Ok(Context {
            stamp,
            binding,
            session,
            // Control changes (including ABA) cancel; ordinary record entries do
            // not erase a human's challenge merely by advancing seq/log_time.
            control_chain: self.policy.ctl_chain,
            approver_role: role,
            requester_role: *self.policy.members.get(&n.account).ok_or_else(denied)?,
            root: self.policy.root,
            root_pk: self.policy.root_pk,
        })
    }

    pub(super) fn cancel_stale_approvals(&mut self) {
        let now = self.now();
        let stale: Vec<_> = self
            .approval
            .exchanges
            .iter()
            .filter_map(|(target, x)| {
                (now < x.started
                    || now >= x.challenge.expires_at_ms
                    || self.approval_context(x.context.session, *target).as_ref() != Ok(&x.context))
                .then_some(*target)
            })
            .collect();
        for target in stale {
            if let Some(x) = self.approval.exchanges.remove(&target) {
                self.approval.approver.cancel(&target);
                self.approval
                    .outbox
                    .retain(|c| c.binding.requester.device != target);
                self.pushes.retain(|(s, p)| {
                    !(*s == x.context.session
                        && matches!(p, Push::ApprovalReady { device, .. } if *device == target))
                });
                if self.host_only(x.context.session).is_ok() {
                    self.pushes.push((
                        x.context.session,
                        Push::ApprovalReady {
                            device: target,
                            exchange_ready: false,
                        },
                    ));
                }
            }
        }
    }

    /// Begin a host-only exchange. Consume the commit DURABLY before drawing or
    /// emitting its challenge. Restart/context loss requires a fresh logged commit.
    pub fn start_device_approval(
        &mut self,
        session: SessionId,
        target: Uuid,
    ) -> ApiResult<ApprovalChallenge> {
        self.cancel_stale_approvals();
        let context = self.approval_context(session, target)?;
        if let Some(x) = self.approval.exchanges.get(&target) {
            if x.context == context {
                return Ok(x.challenge.clone());
            }
            return Err(denied());
        }
        if self.approval.exchanges.len() >= 16 {
            return Err(ErrorCode::RateLimited.err("too many approval exchanges"));
        }
        let key = marker(&context.binding);
        let checkpoint = super::apply_checkpoint::Checkpoint::capture(self);
        match self.store.meta(&key) {
            Ok(None) => {}
            Ok(Some(_)) => return Err(approval_error(ApprovalError::Exhausted)),
            Err(_) => {
                self.approval.poisoned = true;
                self.failed_apply(checkpoint, self.head.seq, false);
                return Err(
                    ErrorCode::Unavailable.err("approval storage is unavailable; reopen required")
                );
            }
        }
        match self.store.commit(Tx {
            meta: vec![(key, Some(vec![1]))],
            ..Tx::default()
        }) {
            Ok(_) => {}
            Err(crate::store::StoreError::CommitAborted(_)) => {
                return Err(ErrorCode::Unavailable.err("approval save was durably aborted"));
            }
            Err(_) => {
                self.approval.poisoned = true;
                // Metadata uncertainty is uncertainty in this SAME Store. Use the
                // existing global terminal path: close sessions, purge outbound
                // plaintext/append calls and dispose this replica/sealer on reopen.
                self.failed_apply(checkpoint, self.head.seq, false);
                return Err(ErrorCode::OutcomeUnknown
                    .err("approval persistence outcome is unknown; reopen storage"));
            }
        }
        // Account/authority may change while the injected store commits.
        if self.approval_context(session, target)? != context {
            return Err(denied());
        }
        let r_a = self
            .approval
            .approver
            .start(&self.policy, &target, self.host.entropy.as_mut())
            .map_err(approval_error)?;
        if self.approval_context(session, target)? != context {
            self.approval.approver.cancel(&target);
            return Err(denied());
        }
        let started = self.now();
        let challenge = ApprovalChallenge {
            binding: context.binding.clone(),
            r_a: B32(r_a),
            expires_at_ms: started.saturating_add(120_000),
        };
        self.approval.exchanges.insert(
            target,
            Exchange {
                context,
                challenge: challenge.clone(),
                started,
                ready: false,
                reveal_fingerprint: None,
            },
        );
        self.approval.outbox.push(challenge.clone());
        Ok(challenge)
    }

    /// Trusted host peer ingress, checked against exact current context before and
    /// after comparison. Only a boolean leaves the INTERNAL computed-code path.
    pub(super) fn receive_device_reveal(
        &mut self,
        session: SessionId,
        reveal: &ApprovalReveal,
    ) -> ApiResult<()> {
        self.cancel_stale_approvals();
        let target = reveal.challenge.binding.requester.device;
        let context = self.approval_context(session, target)?;
        let x = self.approval.exchanges.get(&target).ok_or_else(denied)?;
        if x.context != context || x.challenge != reveal.challenge {
            return Err(denied());
        }
        let fingerprint = mdbn_wire::hash::h("mdbase/v1/approval-reveal", &reveal.r_n.0);
        if x.ready && x.reveal_fingerprint == Some(fingerprint) {
            return Ok(()); // Exact at-least-once peer retry; never consume the single-shot r_A twice.
        }
        self.approval
            .exchanges
            .get_mut(&target)
            .ok_or_else(denied)?
            .ready = false;
        match self
            .approval
            .approver
            .on_reveal(&self.policy, &target, &reveal.r_n.0)
        {
            Ok(internal_code) => drop(internal_code),
            Err(e) => {
                self.pushes.retain(|(s, p)| {
                    !(*s == session
                        && matches!(p, Push::ApprovalReady { device, .. } if *device == target))
                });
                self.pushes.push((
                    session,
                    Push::ApprovalReady {
                        device: target,
                        exchange_ready: false,
                    },
                ));
                // SasApprover consumes r_A even on invalid reveal. That exchange
                // is lost: require a fresh logged commitment, never reset its budget.
                self.approval.exchanges.remove(&target);
                self.approval.approver.cancel(&target);
                self.approval
                    .outbox
                    .retain(|c| c.binding.requester.device != target);
                return Err(approval_error(e));
            }
        }
        if self.approval_context(session, target)? != context {
            self.cancel_stale_approvals();
            return Err(denied());
        }
        let x = self
            .approval
            .exchanges
            .get_mut(&target)
            .ok_or_else(denied)?;
        x.ready = true;
        x.reveal_fingerprint = Some(fingerprint);
        // Coalesce repeated peer delivery: at most one queued boolean per exchange.
        self.pushes.retain(|(s, p)| {
            !(*s == session && matches!(p, Push::ApprovalReady { device, .. } if *device == target))
        });
        self.pushes.push((
            session,
            Push::ApprovalReady {
                device: target,
                exchange_ready: true,
            },
        ));
        Ok(())
    }

    /// Sign a still-current challenge with the ACTUAL held signing seed. Origin
    /// proof binds exact canonical peer body, not a Control metadata projection.
    pub fn sign_device_approval_challenge(
        &mut self,
        session: SessionId,
        challenge: &ApprovalChallenge,
    ) -> ApiResult<super::ApprovalPeerEnvelope> {
        if !self.device_approval_challenge_current(session, challenge) {
            return Err(denied());
        }
        let signed = super::ApprovalPeerMessage::Challenge(challenge.clone())
            .sign(&DeviceSigner::from_seed(&self.secrets.sign_sk))
            .map_err(|_| denied())?;
        if !self.device_approval_challenge_current(session, challenge) {
            return Err(denied());
        }
        Ok(signed)
    }

    /// Authenticated peer ingress. The envelope key is compared to current signed
    /// policy BEFORE accepting its proof; private unsigned ingress is not exported.
    pub fn receive_device_approval_peer(
        &mut self,
        session: SessionId,
        envelope: &super::ApprovalPeerEnvelope,
    ) -> ApiResult<()> {
        self.host_only(session)?;
        self.cancel_stale_approvals();
        if !envelope.verify_for_policy(self.cfg.collection, &self.policy) {
            return Err(ErrorCode::Unauthenticated.err_with_reason(
                "approval_peer_invalid",
                "current device-origin proof is required",
            ));
        }
        match &envelope.message {
            super::ApprovalPeerMessage::Reveal(reveal) => {
                self.receive_device_reveal(session, reveal)
            }
            super::ApprovalPeerMessage::Challenge(_) => Err(ErrorCode::InvalidRequest
                .err("requester challenge ingress is not this approver method")),
        }
    }

    /// Recheck immediately before peer I/O and after every await. A previously
    /// drained challenge is not a current-authority witness by itself.
    pub fn device_approval_challenge_current(
        &mut self,
        session: SessionId,
        challenge: &ApprovalChallenge,
    ) -> bool {
        self.cancel_stale_approvals();
        let target = challenge.binding.requester.device;
        self.approval.exchanges.get(&target).is_some_and(|x| {
            x.context.session == session
                && x.challenge == *challenge
                && self.approval_context(session, target).as_ref() == Ok(&x.context)
        })
    }

    /// Drain only still-current challenges. Neither an app grant nor stale account
    /// source can receive them. Hosts must recheck again immediately before I/O.
    pub fn take_device_approval_challenges(&mut self) -> Vec<ApprovalChallenge> {
        self.cancel_stale_approvals();
        std::mem::take(&mut self.approval.outbox)
    }

    /// The user confirmed the code shown on both devices. Typed six digits are
    /// compared with the internally computed code under the sealer's epoch
    /// custody; a match builds the signed `key_grant` for the requester and queues
    /// it for the ordinary control append turn (`send_batch`), never appended
    /// from this call. Only the returned disposition's `Applied` means keyed.
    pub fn submit_device_approval(
        &mut self,
        session: SessionId,
        target: Uuid,
        code: &ApproverCode,
    ) -> ApiResult<(ApprovalIntent, ApprovalDisposition)> {
        self.cancel_stale_approvals();
        let context = self.approval_context(session, target)?;
        let x = self.approval.exchanges.get(&target).ok_or_else(denied)?;
        if x.context != context {
            return Err(denied());
        }
        if !x.ready {
            return Err(ErrorCode::Conflict.err_with_reason(
                "approval_not_ready",
                "the requester's reveal has not completed for this exchange",
            ));
        }
        if self
            .approval
            .pending_grant
            .as_ref()
            .is_some_and(|g| g.target != target)
        {
            return Err(ErrorCode::Conflict.err_with_reason(
                "approval_grant_pending",
                "another confirmed approval is still being appended",
            ));
        }
        let result = self.sealer.approve_private_device(
            &mut self.approval.approver,
            &self.policy,
            context.stamp.account,
            &target,
            code.as_str(),
            self.host.entropy.as_mut(),
        );
        let intent = ApprovalIntent(self.approval.next_intent);
        self.approval.next_intent += 1;
        let payload = match result {
            Ok(p) => p,
            Err(e) => {
                let refusal = match e {
                    ApprovalError::CodeMismatch => ApprovalRefusal::CodeMismatch,
                    ApprovalError::Exhausted => ApprovalRefusal::Exhausted,
                    ApprovalError::NotReady | ApprovalError::NoChallenge => {
                        ApprovalRefusal::NotReady
                    }
                    _ => ApprovalRefusal::ContextChanged,
                };
                // A wrong code consumes the exchange: the requester reveals at most
                // once per commitment, so a fresh logged commitment is needed. The
                // attempt budget lives with the commitment, never reset here.
                self.approval.exchanges.remove(&target);
                self.approval
                    .outbox
                    .retain(|c| c.binding.requester.device != target);
                self.pushes.retain(|(s, p)| {
                    !(*s == session
                        && matches!(p, Push::ApprovalReady { device, .. } if *device == target))
                });
                let d = ApprovalDisposition::Refused(refusal);
                self.approval.record(intent, d);
                return Ok((intent, d));
            }
        };
        // Account/authority may have changed while the code was compared.
        if self.approval_context(session, target)? != context {
            self.approval.exchanges.remove(&target);
            let d = ApprovalDisposition::Refused(ApprovalRefusal::ContextChanged);
            self.approval.record(intent, d);
            return Ok((intent, d));
        }
        self.approval.exchanges.remove(&target);
        self.approval
            .outbox
            .retain(|c| c.binding.requester.device != target);
        self.approval.pending_grant = Some(PendingGrant {
            intent,
            target,
            payload,
            stamp: context.stamp,
            binding: context.binding,
            control_chain: context.control_chain,
            sends: 0,
        });
        self.approval.record(intent, ApprovalDisposition::Queued);
        self.status_dirty = true;
        Ok((intent, ApprovalDisposition::Queued))
    }

    /// Where a confirmed approval stands. Unknown intents (never issued, or aged
    /// out of the bounded history) are `not_found`.
    pub fn device_approval_disposition(
        &mut self,
        session: SessionId,
        intent: ApprovalIntent,
    ) -> ApiResult<ApprovalDisposition> {
        self.host_only(session)?;
        self.approval
            .dispositions
            .get(&intent)
            .copied()
            .ok_or_else(|| ErrorCode::NotFound.err("unknown approval intent"))
    }

    /// Whether the queued grant's authority, tuple and lifecycle are exactly what
    /// the user confirmed. Checked immediately before signing and sending.
    fn private_grant_current(&self, g: &PendingGrant) -> bool {
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
            || self.policy.epoch != g.binding.epoch
            || self.policy.ctl_chain != g.control_chain
            || self.sealer.current_epoch() != Some(self.policy.epoch)
            || !self.private_state_current()
            || g.stamp.epoch == 0
        {
            return false;
        }
        let Some(source) = self.grant_source.as_ref() else {
            return false;
        };
        if source.active_account() != Some(g.stamp.account)
            || source.authority_epoch() != Some(g.stamp.epoch)
        {
            return false;
        }
        let (Some(me), Some(n)) = (
            self.policy.devices.get(&self.cfg.device_id),
            self.policy.devices.get(&g.target),
        ) else {
            return false;
        };
        me.active
            && me.keyed
            && n.active
            && !n.keyed
            && source.device_noise_pk() == Some(me.noise_pk)
            && ApprovalDevice::from_policy(self.cfg.device_id, me) == g.binding.approver
            && ApprovalDevice::from_policy(g.target, n) == g.binding.requester
            && n.sas_commit == Some(g.binding.commitment)
    }

    /// Control turn: sign and append the one confirmed `key_grant`, if any, at
    /// the current head. Returns whether a control append was sent. A grant whose
    /// context moved is refused here, never sent on stale authority; a grant whose
    /// target got keyed meanwhile is superseded.
    pub(super) fn send_private_key_grant_if_needed(&mut self) -> bool {
        // One batch at a time (log-entry.md §3.1): a sent grant is resolved by its
        // own reply/apply, never by sending it again alongside.
        if self.append.in_flight() {
            return false;
        }
        let Some(g) = self.approval.pending_grant.take() else {
            return false;
        };
        if self.policy.devices.get(&g.target).is_some_and(|d| d.keyed) {
            // Either our own grant landed (apply recorded it) or another approver's.
            if !matches!(
                self.approval.dispositions.get(&g.intent),
                Some(ApprovalDisposition::Applied { .. })
            ) {
                self.approval.record(
                    g.intent,
                    ApprovalDisposition::Refused(ApprovalRefusal::Superseded),
                );
            }
            self.status_dirty = true;
            return false;
        }
        if !self.private_grant_current(&g) {
            self.approval.record(
                g.intent,
                ApprovalDisposition::Refused(ApprovalRefusal::ContextChanged),
            );
            self.status_dirty = true;
            return false;
        }
        if g.sends >= MAX_GRANT_SENDS {
            // Bounded: a grant the log keeps not carrying is not re-appended on
            // every turn; the user confirms again from a fresh exchange.
            self.approval.record(
                g.intent,
                ApprovalDisposition::Refused(ApprovalRefusal::NotAppended),
            );
            self.status_dirty = true;
            return false;
        }
        let Ok(body) = g.payload.to_bytes() else {
            self.approval.record(
                g.intent,
                ApprovalDisposition::Refused(ApprovalRefusal::ContextChanged),
            );
            return false;
        };
        let intent = g.intent;
        let mut g = g;
        let sent = self.append_control(mdbn_wire::envelope::ItemKind::KeyGrant, body);
        if sent {
            g.sends += 1;
        }
        // Not sent (signing/encoding refused): the grant stays queued for the next
        // turn under a fresh context check. Sent: resolved by apply, or re-sent
        // after the append machinery drops the batch (head moved, duplicate).
        self.approval.pending_grant = Some(g);
        if sent {
            self.approval.record(intent, ApprovalDisposition::Sent);
        }
        sent
    }

    /// A `key_grant` evaluated into the policy at `seq` (not yet durable).
    pub(super) fn stage_private_key_grant_applied(
        &mut self,
        signer: Option<Uuid>,
        recipient: Uuid,
        seq: u64,
    ) {
        if signer == Some(self.cfg.device_id) && self.approval.staged_applied.len() < 64 {
            self.approval.staged_applied.push((signer, recipient, seq));
        }
    }

    /// The commit persisting the staged evaluations succeeded: resolve them.
    pub(super) fn publish_staged_key_grants(&mut self) {
        for (signer, recipient, seq) in std::mem::take(&mut self.approval.staged_applied) {
            self.note_private_key_grant_applied(signer, recipient, seq);
        }
    }

    /// The evaluation did not become durable (aborted, unknown, or an
    /// evaluation that never commits): nothing is resolved.
    pub(super) fn discard_staged_key_grants(&mut self) {
        self.approval.staged_applied.clear();
    }

    /// A `key_grant` signed by this device for `recipient` applied at `seq`.
    pub(super) fn note_private_key_grant_applied(
        &mut self,
        signer: Option<Uuid>,
        recipient: Uuid,
        seq: u64,
    ) {
        if signer != Some(self.cfg.device_id) {
            return;
        }
        if let Some(g) = self.approval.pending_grant.as_ref()
            && g.target == recipient
            && g.payload.recipient == recipient
        {
            let intent = g.intent;
            self.approval.pending_grant = None;
            self.approval
                .record(intent, ApprovalDisposition::Applied { seq });
            self.status_dirty = true;
        }
    }

    pub(super) fn pending_private_devices(
        &mut self,
        session: SessionId,
    ) -> ApiResult<Vec<PendingDevice>> {
        self.host_only(session)?;
        self.cancel_stale_approvals();
        Ok(self
            .approval
            .approver
            .pending(&self.policy)
            .into_iter()
            .filter_map(|w| {
                self.approval_context(session, w.device).ok()?;
                Some(PendingDevice {
                    device: w.device,
                    account: w.account,
                    kind: w.kind,
                    exchange_ready: self
                        .approval
                        .exchanges
                        .get(&w.device)
                        .is_some_and(|x| x.ready && x.context.session == session),
                })
            })
            .collect())
    }
}

#[cfg(test)]
#[path = "approval_runtime_tests.rs"]
mod tests;
