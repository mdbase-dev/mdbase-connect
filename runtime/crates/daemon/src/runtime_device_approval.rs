//! Second-computer approval on a private collection (`replica-client-api.md`
//! §8.3), run on the serialized runtime actor. Each op names the daemon's host
//! session; the replica owns every check (current policy, custody, commitment,
//! expiry). Peer transport and polling live in the daemon (`device_approval.rs`).
use mdbn_replica::api::{ClientApi, PendingDevice, SessionId};
use mdbn_replica::replica::{
    ApprovalDisposition, ApprovalIntent, ApprovalPeerEnvelope, ApprovalSecretJournal,
};
use mdbn_replica::{Replica, store::Store as ReplicaStore};
use mdbn_wire::client::Problem;
use mdbn_wire::common::{B16, B32};

/// A device-approval operation for the runtime thread.
pub enum DeviceApprovalOp {
    /// Approver: computers of this account waiting for a key here.
    Pending(SessionId),
    /// Requester: the verified exchange's code for the local host UI.
    Code(SessionId),
    /// Approver: begin the exchange; the signed challenge to send the requester.
    Start(SessionId, B16),
    /// Approver: the requester's signed reveal from the peer inbox.
    Reveal(SessionId, Box<ApprovalPeerEnvelope>),
    /// Approver: the user allowed it; queue the key grant.
    Allow(SessionId, B16, String),
    /// Approver: where an allowed approval stands.
    Disposition(SessionId, ApprovalIntent),
    /// Approver: the user denied it.
    Reject(SessionId, B16),
    /// Requester: whether this computer waits for a key, and the commitment it
    /// must log (if any); `true` renews an unanswered one.
    Waiting(SessionId, Box<dyn ApprovalSecretJournal + Send>, bool),
    /// Requester: answer an approver's signed challenge; the reveal to send back.
    Challenge(
        SessionId,
        Box<ApprovalPeerEnvelope>,
        Box<dyn ApprovalSecretJournal + Send>,
    ),
}

/// A device-approval operation's answer.
pub enum DeviceApprovalReply {
    /// Waiting computers.
    Pending(Vec<PendingDevice>),
    /// Requester's display code, once a challenge has been answered.
    Code(Option<String>),
    /// A signed peer message to send.
    Envelope(Box<ApprovalPeerEnvelope>),
    /// Allowed: the intent and its first disposition.
    Allowed(ApprovalIntent, ApprovalDisposition),
    /// An intent's disposition.
    Disposition(ApprovalDisposition),
    /// Done, nothing to return.
    Done,
    /// Requester state.
    Waiting {
        /// This computer is enrolled here without the collection key.
        waiting: bool,
        /// A commitment the control plane does not carry yet.
        to_log: Option<B32>,
    },
}

pub(crate) fn handle<S: ReplicaStore>(
    rep: &mut Replica<S>,
    op: DeviceApprovalOp,
) -> Result<DeviceApprovalReply, Box<Problem>> {
    let problem = |e: mdbn_replica::api::ApiError| Box::new(e.problem().clone());
    Ok(match op {
        DeviceApprovalOp::Pending(s) => {
            DeviceApprovalReply::Pending(rep.pending_devices(s).map_err(problem)?)
        }
        DeviceApprovalOp::Code(s) => {
            DeviceApprovalReply::Code(rep.requester_approval_code(s).map_err(problem)?)
        }
        DeviceApprovalOp::Start(s, target) => {
            let challenge = rep.start_device_approval(s, target).map_err(problem)?;
            // The returned challenge is the one to send; the outbox copy is
            // drained so it is never sent twice.
            rep.take_device_approval_challenges();
            DeviceApprovalReply::Envelope(Box::new(
                rep.sign_device_approval_challenge(s, &challenge)
                    .map_err(problem)?,
            ))
        }
        DeviceApprovalOp::Reveal(s, envelope) => {
            rep.receive_device_approval_peer(s, &envelope)
                .map_err(problem)?;
            DeviceApprovalReply::Done
        }
        DeviceApprovalOp::Allow(s, target, code) => {
            let (intent, d) = rep
                .allow_device_approval_checked(s, target, &code)
                .map_err(problem)?;
            DeviceApprovalReply::Allowed(intent, d)
        }
        DeviceApprovalOp::Disposition(s, intent) => DeviceApprovalReply::Disposition(
            rep.device_approval_disposition(s, intent)
                .map_err(problem)?,
        ),
        DeviceApprovalOp::Reject(s, target) => {
            rep.reject_device(s, target).map_err(problem)?;
            DeviceApprovalReply::Done
        }
        DeviceApprovalOp::Waiting(s, mut journal, renew) => {
            if !rep.awaiting_device_approval(s) {
                DeviceApprovalReply::Waiting {
                    waiting: false,
                    to_log: None,
                }
            } else {
                DeviceApprovalReply::Waiting {
                    waiting: true,
                    to_log: rep
                        .device_approval_commitment_to_log(s, journal.as_mut(), renew)
                        .map_err(problem)?,
                }
            }
        }
        DeviceApprovalOp::Challenge(s, envelope, mut journal) => {
            DeviceApprovalReply::Envelope(Box::new(
                rep.receive_device_approval_challenge(s, &envelope, journal.as_mut())
                    .map_err(problem)?
                    .envelope,
            ))
        }
    })
}
