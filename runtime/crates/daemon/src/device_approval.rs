//! Opening a private collection on another computer (`replica-client-api.md`
//! §8.3, `sealed-envelope.md` §5.3).
//!
//! The new computer enrols with a commitment and waits. A computer that already
//! has the collection prepares the exchange when listing it (`device.pending`):
//! it sends a signed challenge and takes the new computer's signed reveal.
//! Both computers show the existing six-digit code. One Allow after a visual
//! comparison (`device.approve`) appends the `key_grant`; nothing is typed.
//! The waiting side ([`Daemon::device_approval_requests`]) watches its inbox
//! and answers. The replicas make
//! every protocol check; this module only moves signed messages.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use mdbn_replica::replica::{
    ApprovalDisposition, ApprovalPeerEnvelope, ApprovalPeerMessage, ApprovalSecretJournal,
};
use mdbn_wire::common::{B16, B32};
use mdbn_wire::policy::DeviceKind;
use serde_json::{Value, json};

use super::{Daemon, HostSession, cloud_refusal, problem_error, to_value};
use crate::cloud::CloudError;
use crate::control::{ApproveDevice, ControlError, DevicePending, PendingDevice};
use crate::registry::SyncMode;
use crate::runtime::{DeviceApprovalOp as Op, DeviceApprovalReply as Reply, Runtime};

/// How often the approving computer reads its inbox for the reveal.
const APPROVER_POLL: Duration = Duration::from_secs(3);
/// How long a failed challenge send is retried.
const SEND_RETRY: Duration = Duration::from_secs(30);
/// How long `device.approve` waits for the key grant to be applied.
const APPLY_WAIT: Duration = Duration::from_secs(60);
/// How often a waiting computer reads its inbox, at first and later.
const REQUESTER_POLL: Duration = Duration::from_secs(10);
const REQUESTER_POLL_LATER: Duration = Duration::from_secs(30);
/// After this long waiting, the slower poll.
const REQUESTER_PATIENT: Duration = Duration::from_secs(600);
/// How often the loop looks for waiting collections when none waits.
const REQUESTER_IDLE: Duration = Duration::from_secs(15);
/// An inbox gap this long may have hidden a whole challenge (they live 120 s):
/// the waiting computer then logs a fresh commitment.
const GAP_MS: u64 = 90_000;
/// The same commitment is logged again at most this often.
const RELOG_MS: u64 = 300_000;

fn stopped() -> ControlError {
    ControlError::unavailable("runtime_stopped", "the collection stopped")
}

fn unexpected() -> ControlError {
    ControlError::internal("unexpected device approval reply")
}

async fn run(rt: &Runtime, op: Op) -> Result<Reply, ControlError> {
    rt.device_approval(op)
        .await
        .ok_or_else(stopped)?
        .map_err(|p| problem_error(*p))
}

fn uuid(s: &str, what: &str) -> Result<B16, ControlError> {
    crate::attest::uuid_bytes(s)
        .filter(|b| *b != [0; 16])
        .map(B16)
        .ok_or_else(|| ControlError::invalid("invalid_id", format!("invalid {what} ID")))
}

fn kind(k: DeviceKind) -> &'static str {
    match k {
        DeviceKind::Desktop => "desktop",
        DeviceKind::Mobile => "mobile",
        DeviceKind::AppRuntime => "app",
        DeviceKind::Cli => "cli",
        _ => "other",
    }
}

fn now_ms() -> u64 {
    crate::fsutil::now_ms() as u64
}

/// A failed send worth retrying (nothing definite came back).
fn retryable(e: &CloudError) -> bool {
    matches!(e, CloudError::Network(_))
        || matches!(e, CloudError::Server(s, _) if *s == 429 || *s >= 500)
}

/// One waiting collection, as the requester loop last saw it.
struct Waiting {
    /// When this run first saw it waiting.
    since: Instant,
    /// The last successful inbox read (0: not since this daemon started).
    read_ms: u64,
    /// The commitment last logged, and when.
    logged: Option<(B32, u64)>,
    /// Last request renewal, independent of whether it needed logging here.
    renewed_ms: u64,
}

impl Waiting {
    fn should_renew(&self, now: u64, gap: bool, answered: bool, needs_logging: bool) -> bool {
        (gap || now.saturating_sub(self.renewed_ms) >= RELOG_MS) && !answered && !needs_logging
    }
}

/// Keep the exchange's host session alive between listing and final Allow.
/// Replaced when the collection runtime changes; no authority survives a restart.
pub(super) struct ApprovalSession {
    host: Arc<HostSession>,
    preparing: std::collections::BTreeSet<B16>,
}

impl Daemon {
    async fn approval_host(
        &self,
        id: &str,
        rt: &Arc<Runtime>,
    ) -> Result<Arc<HostSession>, ControlError> {
        let mut sessions = self.device_approvals.lock().await;
        if let Some(s) = sessions.get(id)
            && Arc::ptr_eq(&s.host.rt, rt)
        {
            return Ok(s.host.clone());
        }
        let host = Arc::new(HostSession::open(rt).await?);
        sessions.insert(
            id.into(),
            ApprovalSession {
                host: host.clone(),
                preparing: Default::default(),
            },
        );
        Ok(host)
    }

    /// Read-only code projection for the waiting computer's local status.
    pub(crate) async fn requester_code(rt: &Arc<Runtime>) -> Option<String> {
        let host = HostSession::open(rt).await.ok()?;
        match run(rt, Op::Code(host.id)).await.ok()? {
            Reply::Code(code) => code,
            _ => None,
        }
    }

    /// Private collections served here: (ID, name, runtime). One named
    /// collection must be a served private one.
    async fn private_hosts(
        &self,
        only: Option<&str>,
    ) -> Result<Vec<(String, String, Arc<Runtime>)>, ControlError> {
        if let Some(id) = only {
            self.e2e_collection(id).await?;
        }
        let inner = self.inner.lock().await;
        let hosts = inner
            .hosts
            .iter()
            .filter(|h| {
                h.entry().mode == SyncMode::SyncedE2e
                    && h.is_serving()
                    && only.is_none_or(|id| h.entry().id == id)
            })
            .filter_map(|h| Some((h.entry().id.clone(), h.entry().name.clone(), h.runtime()?)))
            .collect::<Vec<_>>();
        if only.is_some() && hosts.is_empty() {
            return Err(stopped());
        }
        Ok(hosts)
    }

    /// `device.pending`.
    pub(super) async fn device_pending(&self, p: DevicePending) -> Result<Value, ControlError> {
        let hosts = self.private_hosts(p.collection.as_deref()).await?;
        if p.collection.is_none() {
            self.device_approvals.lock().await.retain(|id, session| {
                hosts
                    .iter()
                    .any(|(h, _, rt)| h == id && Arc::ptr_eq(&session.host.rt, rt))
            });
        }
        if hosts.is_empty() {
            return to_value(&Vec::<PendingDevice>::new());
        }
        // Names come from the server; without it the list still shows.
        let account = self.account_parts().ok();
        let mut names: HashMap<B16, Option<String>> = HashMap::new();
        let mut out = Vec::new();
        for (id, collection_name, rt) in hosts {
            let listed = async {
                let host = self.approval_host(&id, &rt).await?;
                match run(&rt, Op::Pending(host.id)).await? {
                    Reply::Pending(list) => Ok(list),
                    _ => Err(unexpected()),
                }
            }
            .await;
            let list = match listed {
                Ok(list) => list,
                Err(e) if p.collection.is_some() => return Err(e),
                Err(e) => {
                    tracing::debug!(collection = %id, reason = ?e.reason, "pending devices unavailable");
                    continue;
                }
            };
            for d in list {
                if d.sas.is_none() {
                    self.prepare_in_background(&id, &rt, d.device).await;
                }
                let name = match (names.get(&d.device), &account) {
                    (Some(n), _) => n.clone(),
                    (None, Some((ctx, inc, _))) => {
                        let n = ctx
                            .cloud
                            .computer_name(&d.device.0, &self.current_account(*inc))
                            .await
                            .unwrap_or(None);
                        names.insert(d.device, n.clone());
                        n
                    }
                    (None, None) => None,
                };
                out.push(PendingDevice {
                    collection: id.clone(),
                    collection_name: collection_name.clone(),
                    device: d.device.to_uuid_string(),
                    name,
                    kind: kind(d.kind).into(),
                    sas: d.sas,
                });
            }
        }
        to_value(&out)
    }

    /// `device.approve`: on the named collection, or on each private collection
    /// here the computer waits for.
    pub(super) async fn device_approve(&self, p: ApproveDevice) -> Result<Value, ControlError> {
        let target = uuid(&p.device, "device")?;
        let code = p.sas.as_deref().ok_or_else(|| {
            ControlError::invalid(
                "verification_code_required",
                "visually check the code on both computers before allowing",
            )
        })?;
        let mut approved = Vec::new();
        for (id, _, rt) in self.private_hosts(p.collection.as_deref()).await? {
            if p.collection.is_none() && !self.waits_here(&rt, target).await {
                continue;
            }
            self.approve_on(&id, &rt, target, code).await?;
            approved.push(id);
        }
        if approved.is_empty() {
            return Err(ControlError::not_found(
                "that computer is not waiting to open a private collection here",
            ));
        }
        Ok(json!({ "approved": approved }))
    }

    /// `device.reject`.
    pub(super) async fn device_reject(&self, p: ApproveDevice) -> Result<Value, ControlError> {
        let target = uuid(&p.device, "device")?;
        let mut rejected = false;
        for (_, _, rt) in self.private_hosts(p.collection.as_deref()).await? {
            if !self.waits_here(&rt, target).await {
                continue;
            }
            let host = HostSession::open(&rt).await?;
            run(&rt, Op::Reject(host.id, target)).await?;
            rejected = true;
        }
        if !rejected {
            return Err(ControlError::not_found(
                "that computer is not waiting to open a private collection here",
            ));
        }
        Ok(json!({}))
    }

    /// Whether `target` waits for approval on this collection.
    async fn waits_here(&self, rt: &Arc<Runtime>, target: B16) -> bool {
        let Ok(host) = HostSession::open(rt).await else {
            return false;
        };
        matches!(
            run(rt, Op::Pending(host.id)).await,
            Ok(Reply::Pending(list)) if list.iter().any(|d| d.device == target)
        )
    }

    /// Listing starts the exchange, not a key grant. Only final Allow grants.
    async fn prepare_in_background(&self, id: &str, rt: &Arc<Runtime>, target: B16) {
        let Some(daemon) = self.arc() else { return };
        let mut sessions = self.device_approvals.lock().await;
        let Some(session) = sessions.get_mut(id) else {
            return;
        };
        if !session.preparing.insert(target) {
            return;
        }
        let host = session.host.clone();
        let rt = rt.clone();
        let id = id.to_string();
        tokio::spawn(async move {
            let mut stop = daemon.shutdown.subscribe();
            tokio::select! {
                _ = stop.wait_for(|s| *s) => {}
                result = daemon.prepare_on(&id, &rt, target, &host) => {
                    if let Err(e) = result {
                        tracing::debug!(collection = %id, reason = ?e.reason, "device check unavailable");
                    }
                }
            }
            if let Some(session) = daemon.device_approvals.lock().await.get_mut(&id)
                && Arc::ptr_eq(&session.host, &host)
            {
                session.preparing.remove(&target);
            }
        });
    }

    /// The exchange, before the user visually checks and allows it.
    async fn prepare_on(
        &self,
        id: &str,
        rt: &Arc<Runtime>,
        target: B16,
        host: &HostSession,
    ) -> Result<(), ControlError> {
        let (ctx, inc, identity) = self.account_parts()?;
        let current = self.current_account(inc);
        let collection = uuid(id, "collection")?;
        let s = host.id;
        let challenge = match run(rt, Op::Start(s, target)).await? {
            Reply::Envelope(e) => e,
            _ => return Err(unexpected()),
        };
        let expires = u64::try_from(challenge.message.challenge().expires_at_ms).unwrap_or(0);
        let sending = Instant::now();
        loop {
            match ctx
                .cloud
                .send_approval_peer(collection, &challenge, &identity, &current)
                .await
            {
                Ok(_) => break,
                Err(e) if retryable(&e) && sending.elapsed() < SEND_RETRY => {
                    tracing::debug!(error = %e, "approval challenge send failed; retrying");
                    tokio::time::sleep(APPROVER_POLL).await;
                }
                Err(e) => return Err(cloud_refusal(e)),
            }
        }
        // The other computer answers within the challenge's lifetime.
        'reveal: loop {
            if now_ms() >= expires {
                return Err(ControlError::unavailable(
                    "computer_did_not_answer",
                    "the other computer did not answer; keep mdbase open on it and try again",
                ));
            }
            tokio::time::sleep(APPROVER_POLL).await;
            let inbox = match ctx
                .cloud
                .approval_peer_inbox(collection, &ctx.connector_id, &identity, &current)
                .await
            {
                Ok(inbox) => inbox,
                Err(CloudError::Local(_)) => {
                    return Err(cloud_refusal(CloudError::Unauthenticated));
                }
                Err(e) => {
                    tracing::debug!(error = %e, "approval inbox unavailable");
                    continue;
                }
            };
            let mut done = Vec::new();
            let mut revealed = false;
            for c in inbox {
                let ApprovalPeerMessage::Reveal(r) = &c.envelope().message else {
                    continue;
                };
                if r.challenge.binding.requester.device != target {
                    continue; // another computer's exchange
                }
                match run(rt, Op::Reveal(s, Box::new(c.envelope().clone()))).await {
                    Ok(_) => revealed = true,
                    Err(e) if e.reason.as_deref() == Some("runtime_stopped") => return Err(e),
                    Err(e) => tracing::debug!(reason = ?e.reason, "approval reveal not taken"),
                }
                done.push(c.id());
            }
            if !done.is_empty() {
                let _ = ctx
                    .cloud
                    .acknowledge_approval_peers(
                        collection,
                        &ctx.connector_id,
                        &identity,
                        &done,
                        &current,
                    )
                    .await;
            }
            if revealed {
                break 'reveal;
            }
        }
        Ok(())
    }

    /// Final Allow uses the exact exchange whose code the user has checked.
    async fn approve_on(
        &self,
        id: &str,
        rt: &Arc<Runtime>,
        target: B16,
        code: &str,
    ) -> Result<(), ControlError> {
        let host = self.approval_host(id, rt).await?;
        let s = host.id;
        let (intent, mut state) = match run(rt, Op::Allow(s, target, code.to_string())).await? {
            Reply::Allowed(i, d) => (i, d),
            _ => return Err(unexpected()),
        };
        let waiting = Instant::now();
        loop {
            match state {
                ApprovalDisposition::Applied { .. } => return Ok(()),
                ApprovalDisposition::Refused(r) => {
                    tracing::info!(refusal = ?r, "device approval refused");
                    return Err(ControlError::new(
                        "conflict",
                        "approval_refused",
                        "the collection changed while approving; try again",
                    ));
                }
                ApprovalDisposition::Queued | ApprovalDisposition::Sent => {}
            }
            if waiting.elapsed() >= APPLY_WAIT {
                return Err(ControlError::unavailable(
                    "approval_not_confirmed",
                    "the approval is saved here and finishes when this computer is back online",
                ));
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
            state = match run(rt, Op::Disposition(s, intent)).await? {
                Reply::Disposition(d) => d,
                _ => return Err(unexpected()),
            };
        }
    }

    /// On a computer waiting to open private collections: answer an approving
    /// computer's challenge, and log a fresh commitment when the old one may be
    /// spent. Runs for the daemon's life.
    pub(super) async fn device_approval_requests(self: Arc<Self>) {
        let mut stop = self.shutdown.subscribe();
        let mut waiting: HashMap<String, Waiting> = HashMap::new();
        let mut started = true;
        loop {
            let delay = tokio::select! {
                _ = stop.wait_for(|s| *s) => break,
                d = self.requester_pass(&mut waiting, started) => d,
            };
            started = false;
            tokio::select! {
                _ = stop.wait_for(|s| *s) => break,
                _ = tokio::time::sleep(delay) => {}
            }
        }
    }

    /// One pass over the private collections here; the delay before the next.
    async fn requester_pass(
        &self,
        waiting: &mut HashMap<String, Waiting>,
        started: bool,
    ) -> Duration {
        let Ok((ctx, inc, identity)) = self.account_parts() else {
            waiting.clear();
            return REQUESTER_IDLE;
        };
        let current = self.current_account(inc);
        let hosts = self.private_hosts(None).await.unwrap_or_default();
        waiting.retain(|id, _| hosts.iter().any(|(h, _, _)| h == id));
        for (id, _, rt) in hosts {
            let Ok(collection) = uuid(&id, "collection") else {
                continue;
            };
            let journal = || -> Option<Box<dyn ApprovalSecretJournal + Send>> {
                crate::approval_journal::RequesterJournal::new(
                    self.secrets.clone(),
                    collection.0,
                    inc.account.0,
                    identity.device_id,
                    inc.epoch,
                )
                .ok()
                .map(|j| Box::new(j) as Box<dyn ApprovalSecretJournal + Send>)
            };
            let Ok(host) = HostSession::open(&rt).await else {
                continue;
            };
            let Some(j) = journal() else {
                continue;
            };
            let mut to_log = match run(&rt, Op::Waiting(host.id, j, false)).await {
                Ok(Reply::Waiting {
                    waiting: true,
                    to_log,
                }) => to_log,
                Ok(_) => {
                    waiting.remove(&id);
                    continue;
                }
                Err(e) => {
                    tracing::debug!(collection = %id, reason = ?e.reason, "approval request state unavailable");
                    continue;
                }
            };
            let now = now_ms();
            let w = waiting.entry(id.clone()).or_insert(Waiting {
                since: Instant::now(),
                read_ms: if started { 0 } else { now },
                logged: None,
                renewed_ms: now,
            });
            match ctx
                .cloud
                .approval_peer_inbox(collection, &ctx.connector_id, &identity, &current)
                .await
            {
                Ok(inbox) => {
                    let gap = now.saturating_sub(w.read_ms) > GAP_MS;
                    w.read_ms = now;
                    let mut answered = false;
                    let mut done = Vec::new();
                    for c in inbox {
                        if !matches!(c.envelope().message, ApprovalPeerMessage::Challenge(_)) {
                            continue;
                        }
                        let Some(j) = journal() else {
                            break;
                        };
                        match run(
                            &rt,
                            Op::Challenge(host.id, Box::new(c.envelope().clone()), j),
                        )
                        .await
                        {
                            Ok(Reply::Envelope(reveal)) => {
                                answered = true;
                                // Its key grant is trusted after a restart too.
                                let approver =
                                    c.envelope().message.challenge().binding.approver.device;
                                match self.trust_signer(&id, &collection, approver) {
                                    Ok(()) => {
                                        send_reveal(
                                            &ctx.cloud, collection, &reveal, &identity, &current,
                                        )
                                        .await
                                    }
                                    Err(e) => {
                                        tracing::warn!(collection = %id, reason = ?e.reason, "approver not saved; reveal not sent")
                                    }
                                }
                            }
                            Ok(_) => {}
                            Err(e) if e.reason.as_deref() == Some("runtime_stopped") => break,
                            // Not for this computer's current commitment: drop it.
                            Err(e) => {
                                tracing::debug!(reason = ?e.reason, "approval challenge not answered")
                            }
                        }
                        done.push(c.id());
                    }
                    if !done.is_empty() {
                        let _ = ctx
                            .cloud
                            .acknowledge_approval_peers(
                                collection,
                                &ctx.connector_id,
                                &identity,
                                &done,
                                &current,
                            )
                            .await;
                    }
                    // A challenge may have been spent by the approver but never
                    // delivered. Renew even when inbox polling has no gap.
                    if w.should_renew(now, gap, answered, to_log.is_some())
                        && let Some(j) = journal()
                        && let Ok(Reply::Waiting { to_log: fresh, .. }) =
                            run(&rt, Op::Waiting(host.id, j, true)).await
                    {
                        to_log = fresh;
                        w.renewed_ms = now;
                    }
                }
                Err(e) => {
                    tracing::debug!(collection = %id, error = %e, "approval inbox unavailable")
                }
            }
            if let Some(commit) = to_log
                && w.logged
                    .is_none_or(|(c, at)| c != commit || now.saturating_sub(at) >= RELOG_MS)
            {
                w.logged = Some((commit, now));
                if let Err(e) = ctx
                    .cloud
                    .request_private_approval(
                        &ctx.connector_id,
                        &collection.0,
                        &commit.0,
                        &identity,
                        &current,
                    )
                    .await
                {
                    tracing::debug!(collection = %id, error = %e, "approval request not logged");
                }
            }
        }
        match waiting.values().map(|w| w.since.elapsed()).min() {
            None => REQUESTER_IDLE,
            Some(d) if d < REQUESTER_PATIENT => REQUESTER_POLL,
            Some(_) => REQUESTER_POLL_LATER,
        }
    }
}

impl Daemon {
    /// Add the approving computer to the collection link's trusted signers
    /// (`sync.json`), the devices whose key grants this computer uses.
    fn trust_signer(&self, id: &str, collection: &B16, signer: B16) -> Result<(), ControlError> {
        let (_, trust) = self.sync_parts()?;
        let path = crate::sync::SyncConfig::path(&self.profile.state_dir.join("collections"), id);
        let mut link = crate::sync::SyncConfig::load(&path)
            .map_err(|e| ControlError::internal(e.0))?
            .ok_or_else(|| ControlError::internal("the collection has no link"))?;
        let signer = signer.to_uuid_string();
        if link.trusted_signers.contains(&signer) {
            return Ok(());
        }
        link.trusted_signers.push(signer);
        link.save(&path, &collection.0, &trust)
            .map_err(|e| ControlError::internal(e.0))
    }
}

/// Send the reveal, retrying briefly: the exchange cannot be answered twice.
async fn send_reveal(
    cloud: &crate::cloud::Cloud,
    collection: B16,
    reveal: &ApprovalPeerEnvelope,
    identity: &crate::secrets::DeviceIdentity,
    current: &(dyn Fn() -> Result<(), String> + Send + Sync),
) {
    for _ in 0..5 {
        match cloud
            .send_approval_peer(collection, reveal, identity, current)
            .await
        {
            Ok(_) => return,
            Err(e) if retryable(&e) => {
                tracing::debug!(error = %e, "approval reveal send failed; retrying");
                tokio::time::sleep(Duration::from_secs(3)).await;
            }
            Err(e) => {
                tracing::debug!(error = %e, "approval reveal not sent");
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn blanket_deny_refuses_when_no_collection_has_a_waiting_request() {
        let dir = crate::testutil::TestDir::new("deny-no-request");
        let daemon = super::super::tests::daemon(&dir);
        let error = daemon
            .device_reject(ApproveDevice {
                device: B16([2; 16]).to_uuid_string(),
                collection: None,
                sas: None,
            })
            .await
            .unwrap_err();
        assert_eq!(error.code, "not_found");
    }

    #[test]
    fn lost_challenge_renews_on_timer_without_restart_or_inbox_gap() {
        let w = Waiting {
            since: Instant::now(),
            read_ms: 10_000,
            logged: None,
            renewed_ms: 10_000,
        };
        assert!(!w.should_renew(10_000 + RELOG_MS - 1, false, false, false));
        assert!(w.should_renew(10_000 + RELOG_MS, false, false, false));
        // Do not replace a commitment while answering a challenge, or before
        // its already prepared replacement has reached the control plane.
        assert!(!w.should_renew(10_000 + RELOG_MS, false, true, false));
        assert!(!w.should_renew(10_000 + RELOG_MS, false, false, true));
    }
}
