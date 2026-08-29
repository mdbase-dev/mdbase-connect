use super::AgentState;
use mdbase_connect_core::ConnectError;
use mdbase_connect_protocol::{ControlError, GrantPolicy, RelayMessage, CONTROL_PROTOCOL_VERSION};
use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex, RwLock};
use std::time::Instant;
use uuid::Uuid;

/// Linearizes authority admission with snapshot replacement. Its shared side
/// is never held while admitted work executes. The epoch is process-local: it
/// prevents a permit from becoming valid again after an expiry discontinuity.
#[derive(Debug)]
pub(crate) struct PolicyRevisionGate(RwLock<PolicyAuthorityState>);

#[derive(Debug)]
struct PolicyAuthorityState {
    epoch: u64,
    digest: Option<String>,
    #[cfg(test)]
    manual_now_ms: Option<i64>,
}

impl PolicyRevisionGate {
    pub(crate) fn new(registry: &mdbase_connect_core::CollectionRegistry) -> Self {
        let digest = registry
            .remote_policy_authority()
            .ok()
            .and_then(|authority| authority.authority_digest);
        Self(RwLock::new(PolicyAuthorityState {
            epoch: 1,
            digest,
            #[cfg(test)]
            manual_now_ms: None,
        }))
    }
}

#[derive(Clone, Debug)]
pub(crate) struct PolicyRevisionPermit {
    /// Exact wire snapshot revision retained as admission/publication evidence.
    revision: String,
    authority_digest: String,
    authority_epoch: u64,
}

#[derive(Debug, Default)]
struct PublicationState {
    active: HashMap<Uuid, Instant>,
    snapshot_pending: bool,
    #[cfg(test)]
    manual_now: Option<Instant>,
}

#[derive(Debug, Default)]
pub(crate) struct PublicationGate {
    state: Mutex<PublicationState>,
    changed: Condvar,
}

#[derive(Debug)]
pub(crate) struct PublicationPermit {
    id: Uuid,
    revision: String,
    authority_digest: String,
    authority_epoch: u64,
    deadline: Instant,
    gate: Arc<PublicationGate>,
}

#[cfg(test)]
pub(crate) struct ManualPublicationClock {
    gate: Arc<PublicationGate>,
}

#[cfg(test)]
pub(crate) struct ManualPolicyClock<'a> {
    gate: &'a PolicyRevisionGate,
}

#[cfg(test)]
impl ManualPublicationClock {
    pub(crate) fn advance_to(&self, now: Instant) {
        let mut state = self.gate.state.lock().expect("publication gate poisoned");
        let current = state.manual_now.expect("manual publication clock missing");
        assert!(now >= current, "manual publication clock moved backwards");
        state.manual_now = Some(now);
        self.gate.changed.notify_all();
    }

    pub(crate) fn wait_until_snapshot_pending(&self) {
        let mut state = self.gate.state.lock().expect("publication gate poisoned");
        while !state.snapshot_pending {
            state = self
                .gate
                .changed
                .wait(state)
                .expect("publication gate poisoned");
        }
    }
}

#[cfg(test)]
impl Drop for ManualPublicationClock {
    fn drop(&mut self) {
        let mut state = self
            .gate
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.manual_now = None;
        self.gate.changed.notify_all();
    }
}

#[cfg(test)]
impl ManualPolicyClock<'_> {
    pub(crate) fn advance_to(&self, now_ms: i64) {
        let mut state = self.gate.0.write().expect("policy gate poisoned");
        let current = state.manual_now_ms.expect("manual policy clock missing");
        assert!(now_ms >= current, "manual policy clock moved backwards");
        state.manual_now_ms = Some(now_ms);
    }
}

#[cfg(test)]
impl Drop for ManualPolicyClock<'_> {
    fn drop(&mut self) {
        self.gate
            .0
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .manual_now_ms = None;
    }
}

impl Drop for PublicationPermit {
    fn drop(&mut self) {
        let mut state = self.gate.state.lock().expect("publication gate poisoned");
        state.active.remove(&self.id);
        self.gate.changed.notify_all();
    }
}

impl AgentState {
    pub fn handle_direct_file_upload_frame(
        &self,
        origin: &str,
        frame: mdbase_connect_protocol::FileFrame,
    ) -> Result<(), ConnectError> {
        self.handle_file_upload(Some(origin), frame)
    }

    pub fn handle_relay_file_frame(
        &self,
        request: mdbase_connect_protocol::RelayFileFrame,
    ) -> mdbase_connect_protocol::RelayFileFrame {
        self.handle_relay_file_frame_inner(request)
    }

    pub fn direct_file_download_chunk(
        &self,
        origin: &str,
        grant_id: Uuid,
        transfer_id: Uuid,
        chunk_index: u64,
    ) -> Result<Vec<u8>, ConnectError> {
        self.file_download_chunk(Some(origin), grant_id, transfer_id, chunk_index)
    }

    pub(crate) fn handle_direct_encrypted_operation_cancellable(
        &self,
        origin: &str,
        envelope: mdbase_connect_protocol::EncryptedRelayEnvelope,
        cancellation: &mdbase::OperationCancellation,
        execution_state: &super::OperationExecutionState,
    ) -> RelayMessage {
        let origin_matches = self
            .registry
            .grant_replay_context(envelope.grant_id, &envelope.key_id)
            .ok()
            .flatten()
            .is_some_and(|context| context.grant.application_origin.as_deref() == Some(origin));
        if !origin_matches {
            return super::encrypted_rejection(envelope.protocol_version, envelope.request_id);
        }
        super::metrics::direct_operation_transport(envelope.protocol_version);
        let registration = self.register_remote_operation(cancellation);
        let response = self.handle_encrypted_operation(envelope, cancellation, execution_state);
        self.unregister_remote_operation(registration);
        response
    }

    pub fn handle_relay_message(&self, message: RelayMessage) -> Option<RelayMessage> {
        self.handle_relay_message_cancellable(
            message,
            &mdbase::OperationCancellation::new(),
            &super::OperationExecutionState::default(),
        )
    }

    pub(crate) fn handle_relay_message_cancellable(
        &self,
        message: RelayMessage,
        cancellation: &mdbase::OperationCancellation,
        execution_state: &super::OperationExecutionState,
    ) -> Option<RelayMessage> {
        self.handle_relay_message_cancellable_inner(message, cancellation, execution_state)
    }

    /// Capture before queueing. Admission later rechecks the authority digest
    /// and instance-scoped continuity epoch under the shared replacement gate.
    pub(crate) fn capture_policy_revision(&self) -> Result<PolicyRevisionPermit, ConnectError> {
        let mut gate = self
            .policy_revision_gate
            .0
            .write()
            .expect("policy gate poisoned");
        let authority = self.registry.remote_policy_authority()?;
        if !authority_is_fresh(&gate, &authority) {
            return Err(policy_changed());
        }
        let digest = authority.authority_digest.ok_or_else(policy_changed)?;
        if gate.digest.as_deref() != Some(&digest) {
            gate.epoch = gate.epoch.checked_add(1).ok_or_else(policy_changed)?;
            gate.digest = Some(digest.clone());
        }
        Ok(PolicyRevisionPermit {
            revision: authority.revision,
            authority_digest: digest,
            authority_epoch: gate.epoch,
        })
    }

    /// Explicit authorization linearization point. The gate is released before
    /// any collection or durable mutation work starts.
    pub(crate) fn admit_policy_revision(
        &self,
        permit: &PolicyRevisionPermit,
    ) -> Result<(), ConnectError> {
        let gate = self
            .policy_revision_gate
            .0
            .read()
            .expect("policy gate poisoned");
        if permit_matches(&self.registry, &gate, permit)? {
            Ok(())
        } else {
            Err(policy_changed())
        }
    }

    /// Acquire the distinct exact-revision publication permit at a transport
    /// boundary. Snapshot replacement cannot win while this bounded permit is
    /// live; after its absolute deadline the permit no longer blocks or allows
    /// publication even if its owner is never polled again.
    pub(crate) fn acquire_publication_permit(
        &self,
        permit: &PolicyRevisionPermit,
        deadline: tokio::time::Instant,
    ) -> Result<PublicationPermit, ConnectError> {
        let deadline = deadline.into_std();
        #[cfg(not(test))]
        let now = Instant::now();
        #[cfg(not(test))]
        if now >= deadline {
            return Err(policy_changed());
        }
        let mut state = self
            .publication_gate
            .state
            .lock()
            .expect("publication gate poisoned");
        #[cfg(test)]
        let now = publication_now(&state);
        #[cfg(test)]
        if now >= deadline {
            return Err(policy_changed());
        }
        state.active.retain(|_, bound| *bound > now);
        if state.snapshot_pending {
            return Err(policy_changed());
        }
        let authority = self
            .policy_revision_gate
            .0
            .read()
            .expect("policy gate poisoned");
        if !permit_matches(&self.registry, &authority, permit)? {
            return Err(policy_changed());
        }
        let id = Uuid::new_v4();
        state.active.insert(id, deadline);
        Ok(PublicationPermit {
            id,
            revision: permit.revision.clone(),
            authority_digest: permit.authority_digest.clone(),
            authority_epoch: permit.authority_epoch,
            deadline,
            gate: self.publication_gate.clone(),
        })
    }

    pub(crate) fn publication_is_current(&self, permit: &PublicationPermit) -> bool {
        #[cfg(not(test))]
        let now = Instant::now();
        #[cfg(test)]
        let now = {
            let state = self
                .publication_gate
                .state
                .lock()
                .expect("publication gate poisoned");
            publication_now(&state)
        };
        if now >= permit.deadline {
            return false;
        }
        let authority = self
            .policy_revision_gate
            .0
            .read()
            .expect("policy gate poisoned");
        publication_permit_matches(&self.registry, &authority, permit).unwrap_or(false)
    }

    #[cfg(test)]
    pub(crate) fn policy_lease_expiry_for_test(&self) -> i64 {
        self.registry
            .remote_policy_authority()
            .expect("policy authority missing")
            .lease_expires_at_ms
    }

    #[cfg(test)]
    pub(crate) fn manual_policy_clock(&self, now_ms: i64) -> ManualPolicyClock<'_> {
        let mut state = self
            .policy_revision_gate
            .0
            .write()
            .expect("policy gate poisoned");
        assert!(
            state.manual_now_ms.is_none(),
            "manual policy clock installed twice"
        );
        state.manual_now_ms = Some(now_ms);
        ManualPolicyClock {
            gate: &self.policy_revision_gate,
        }
    }

    #[cfg(test)]
    pub(crate) fn manual_publication_clock(&self, now: Instant) -> ManualPublicationClock {
        let mut state = self
            .publication_gate
            .state
            .lock()
            .expect("publication gate poisoned");
        assert!(
            state.active.is_empty(),
            "publication permits already active"
        );
        assert!(
            state.manual_now.is_none(),
            "manual publication clock installed twice"
        );
        state.manual_now = Some(now);
        ManualPublicationClock {
            gate: self.publication_gate.clone(),
        }
    }
}

#[cfg(test)]
fn publication_now(state: &PublicationState) -> Instant {
    state.manual_now.unwrap_or_else(Instant::now)
}

fn authority_is_fresh(
    _state: &PolicyAuthorityState,
    authority: &mdbase_connect_core::RemotePolicyAuthority,
) -> bool {
    #[cfg(not(test))]
    {
        authority.fresh
    }
    #[cfg(test)]
    {
        _state.manual_now_ms.map_or(authority.fresh, |now_ms| {
            authority.lease_expires_at_ms > now_ms.max(authority.observed_at_ms)
        })
    }
}

fn authority_matches(
    registry: &mdbase_connect_core::CollectionRegistry,
    state: &PolicyAuthorityState,
    digest: &str,
    epoch: u64,
) -> Result<bool, ConnectError> {
    let authority = registry.remote_policy_authority()?;
    Ok(authority_is_fresh(state, &authority)
        && authority.authority_digest.as_deref() == Some(digest)
        && state.digest.as_deref() == Some(digest)
        && state.epoch == epoch)
}

fn permit_matches(
    registry: &mdbase_connect_core::CollectionRegistry,
    state: &PolicyAuthorityState,
    permit: &PolicyRevisionPermit,
) -> Result<bool, ConnectError> {
    // The exact revision remains attached as evidence, while continuity is
    // intentionally decided by authority identity plus the local epoch.
    let _exact_wire_revision = &permit.revision;
    authority_matches(
        registry,
        state,
        &permit.authority_digest,
        permit.authority_epoch,
    )
}

fn publication_permit_matches(
    registry: &mdbase_connect_core::CollectionRegistry,
    state: &PolicyAuthorityState,
    permit: &PublicationPermit,
) -> Result<bool, ConnectError> {
    let _exact_wire_revision = &permit.revision;
    authority_matches(
        registry,
        state,
        &permit.authority_digest,
        permit.authority_epoch,
    )
}

pub(crate) struct PolicySnapshot {
    pub request_id: Uuid,
    pub revision: String,
    pub connector_id: Uuid,
    pub sequence: u64,
    pub lease_issued_at_ms: i64,
    pub lease_expires_at_ms: i64,
    pub grants: Vec<GrantPolicy>,
}

pub(crate) fn apply_policy_snapshot(
    state: &AgentState,
    protocol_version: u32,
    snapshot: PolicySnapshot,
) -> RelayMessage {
    let PolicySnapshot {
        request_id,
        revision,
        connector_id,
        sequence,
        lease_issued_at_ms,
        lease_expires_at_ms,
        grants,
    } = snapshot;
    if protocol_version != CONTROL_PROTOCOL_VERSION {
        return rejected(
            request_id,
            revision,
            "unsupported_protocol_version",
            format!(
                "Relay protocol {protocol_version} is unsupported; expected {}.",
                CONTROL_PROTOCOL_VERSION
            ),
        );
    }
    let mut normalized_grants = grants.clone();
    normalized_grants.sort_by_key(|grant| grant.id);
    let policy_body = serde_json::json!({
        "connector_id": connector_id,
        "sequence": sequence,
        "lease_issued_at_ms": lease_issued_at_ms,
        "lease_expires_at_ms": lease_expires_at_ms,
        "grants": &normalized_grants,
    });
    let bound_revision = serde_jcs::to_vec(&policy_body)
        .map(|body| {
            use sha2::Digest;
            format!("sha256:{:x}", sha2::Sha256::digest(body))
        })
        .unwrap_or_default();
    if bound_revision != revision {
        return rejected(
            request_id,
            revision,
            "invalid_policy_revision",
            "The policy lease did not match its bound revision.".to_string(),
        );
    }
    let authority_digest = match mdbase_connect_core::canonical_policy_authority_digest(
        connector_id,
        &normalized_grants,
    ) {
        Ok(digest) => digest,
        Err(error) => {
            return rejected(request_id, revision, error.code(), error.to_string());
        }
    };
    if let Err(error) = state.registry.prevalidate_remote_grants_at_revision(
        connector_id,
        &revision,
        sequence,
        lease_issued_at_ms,
        lease_expires_at_ms,
        &normalized_grants,
    ) {
        return rejected(request_id, revision, error.code(), error.to_string());
    }

    // Every apply takes publication state before the policy gate. This
    // serializes equivalent renewals with genuine replacement and matches the
    // publication admission lock order.
    let mut publications = state
        .publication_gate
        .state
        .lock()
        .expect("publication gate poisoned");
    let mut authority = state
        .policy_revision_gate
        .0
        .write()
        .expect("policy gate poisoned");
    let current = match state.registry.remote_policy_authority() {
        Ok(current) => current,
        Err(error) => {
            return rejected(request_id, revision, error.code(), error.to_string());
        }
    };
    if authority.digest != current.authority_digest {
        let Some(next_epoch) = authority.epoch.checked_add(1) else {
            return rejected(
                request_id,
                revision,
                "policy_epoch_exhausted",
                "The local policy continuity epoch is exhausted.".to_string(),
            );
        };
        authority.epoch = next_epoch;
        authority.digest = current.authority_digest.clone();
    }
    if sequence < current.sequence || (sequence == current.sequence && revision != current.revision)
    {
        return rejected(
            request_id,
            revision,
            "invalid_request",
            "Stale or conflicting policy snapshot.".to_string(),
        );
    }
    if sequence == current.sequence {
        return RelayMessage::PolicyApplied {
            protocol_version: CONTROL_PROTOCOL_VERSION,
            request_id,
            revision,
            ok: true,
            error: None,
        };
    }

    let equivalent_renewal = authority_is_fresh(&authority, &current)
        && current.connector_id == Some(connector_id)
        && current.authority_digest.as_deref() == Some(&authority_digest);
    if equivalent_renewal {
        let result = state.registry.replace_remote_grants_at_revision(
            connector_id,
            &revision,
            sequence,
            lease_issued_at_ms,
            lease_expires_at_ms,
            &normalized_grants,
        );
        drop(authority);
        drop(publications);
        return applied(request_id, revision, normalized_grants.len(), result);
    }

    // Close publication admission before waiting so a stream of newly finished
    // old-authority operations cannot starve replacement. Durable work may
    // ignore cancellation, but the epoch prevents later resurrection.
    publications.snapshot_pending = true;
    #[cfg(test)]
    state.publication_gate.changed.notify_all();
    state.cancel_remote_operations();
    drop(authority);
    loop {
        #[cfg(not(test))]
        let now = Instant::now();
        #[cfg(test)]
        let now = publication_now(&publications);
        publications.active.retain(|_, deadline| *deadline > now);
        let Some(next) = publications.active.values().copied().min() else {
            break;
        };
        #[cfg(test)]
        if publications.manual_now.is_some() {
            publications = state
                .publication_gate
                .changed
                .wait(publications)
                .expect("publication gate poisoned");
            continue;
        }
        let wait = next.saturating_duration_since(now);
        let (guard, _) = state
            .publication_gate
            .changed
            .wait_timeout(publications, wait)
            .expect("publication gate poisoned");
        publications = guard;
    }
    let mut authority = state
        .policy_revision_gate
        .0
        .write()
        .expect("policy gate poisoned");
    let next_epoch = authority.epoch.checked_add(1);
    let result = if next_epoch.is_some() {
        state.registry.replace_remote_grants_at_revision(
            connector_id,
            &revision,
            sequence,
            lease_issued_at_ms,
            lease_expires_at_ms,
            &normalized_grants,
        )
    } else {
        Err(ConnectError::InvalidInput(
            "The local policy continuity epoch is exhausted.".to_string(),
        ))
    };
    if result.is_ok() {
        authority.epoch = next_epoch.expect("epoch checked before replacement");
        authority.digest = Some(authority_digest);
    }
    state.cancel_remote_operations();
    drop(authority);
    publications.snapshot_pending = false;
    drop(publications);
    state.publication_gate.changed.notify_all();

    applied(request_id, revision, normalized_grants.len(), result)
}

fn applied(
    request_id: Uuid,
    revision: String,
    grant_count: usize,
    result: Result<(), ConnectError>,
) -> RelayMessage {
    match result {
        Ok(()) => {
            tracing::debug!(grants = grant_count, "relay policy snapshot applied");
            RelayMessage::PolicyApplied {
                protocol_version: CONTROL_PROTOCOL_VERSION,
                request_id,
                revision,
                ok: true,
                error: None,
            }
        }
        Err(error) => {
            tracing::error!(code = error.code(), "relay policy snapshot rejected");
            rejected(request_id, revision, error.code(), error.to_string())
        }
    }
}

fn policy_changed() -> ConnectError {
    ConnectError::AccessDenied(
        "The remote application policy revision changed or expired.".to_string(),
    )
}

fn rejected(request_id: Uuid, revision: String, code: &str, message: String) -> RelayMessage {
    RelayMessage::PolicyApplied {
        protocol_version: CONTROL_PROTOCOL_VERSION,
        request_id,
        revision,
        ok: false,
        error: Some(ControlError {
            code: code.to_string(),
            message,
            details: None,
        }),
    }
}

#[cfg(test)]
#[path = "policy_tests.rs"]
mod tests;
