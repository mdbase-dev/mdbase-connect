use super::AgentState;
use mdbase_connect_core::ConnectError;
use mdbase_connect_protocol::{ControlError, GrantPolicy, RelayMessage, CONTROL_PROTOCOL_VERSION};
use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex, RwLock};
use std::time::Instant;
use uuid::Uuid;

/// Linearizes exact-revision admission with snapshot replacement. Its shared
/// side is never held while admitted work executes.
#[derive(Debug, Default)]
pub(crate) struct PolicyRevisionGate(RwLock<()>);

#[derive(Clone, Debug)]
pub(crate) struct PolicyRevisionPermit {
    revision: String,
}

#[derive(Debug, Default)]
struct PublicationState {
    active: HashMap<Uuid, Instant>,
    snapshot_pending: bool,
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
    deadline: Instant,
    gate: Arc<PublicationGate>,
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

    /// Capture before queueing. Admission later rechecks this exact revision
    /// under the shared replacement gate.
    pub(crate) fn capture_policy_revision(&self) -> Result<PolicyRevisionPermit, ConnectError> {
        self.registry
            .remote_policy_revision_if_fresh()?
            .map(|revision| PolicyRevisionPermit { revision })
            .ok_or_else(policy_changed)
    }

    /// Explicit authorization linearization point. The gate is released before
    /// any collection or durable mutation work starts.
    pub(crate) fn admit_policy_revision(
        &self,
        permit: &PolicyRevisionPermit,
    ) -> Result<(), ConnectError> {
        let _gate = self
            .policy_revision_gate
            .0
            .read()
            .expect("policy gate poisoned");
        if self
            .registry
            .remote_policy_matches_fresh(&permit.revision)?
        {
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
        let now = Instant::now();
        if now >= deadline {
            return Err(policy_changed());
        }
        let mut state = self
            .publication_gate
            .state
            .lock()
            .expect("publication gate poisoned");
        state.active.retain(|_, bound| *bound > now);
        if state.snapshot_pending {
            return Err(policy_changed());
        }
        if !self
            .registry
            .remote_policy_matches_fresh(&permit.revision)?
        {
            return Err(policy_changed());
        }
        let id = Uuid::new_v4();
        state.active.insert(id, deadline);
        Ok(PublicationPermit {
            id,
            revision: permit.revision.clone(),
            deadline,
            gate: self.publication_gate.clone(),
        })
    }

    pub(crate) fn publication_is_current(&self, permit: &PublicationPermit) -> bool {
        Instant::now() < permit.deadline
            && self
                .registry
                .remote_policy_matches_fresh(&permit.revision)
                .unwrap_or(false)
    }

    #[cfg(test)]
    pub(crate) fn publication_snapshot_pending(&self) -> bool {
        self.publication_gate
            .state
            .lock()
            .expect("publication gate poisoned")
            .snapshot_pending
    }
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
    let policy_body = serde_json::json!({
        "connector_id": connector_id,
        "sequence": sequence,
        "lease_issued_at_ms": lease_issued_at_ms,
        "lease_expires_at_ms": lease_expires_at_ms,
        "grants": &grants,
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

    // Cancellation starts immediately. Durable work may ignore it and drain,
    // but it owns no publication permit and cannot delay replacement.
    state.cancel_remote_operations();
    let mut publications = state
        .publication_gate
        .state
        .lock()
        .expect("publication gate poisoned");
    // Close publication admission before waiting so a stream of newly finished
    // old-revision operations cannot starve replacement.
    publications.snapshot_pending = true;
    loop {
        let now = Instant::now();
        publications.active.retain(|_, deadline| *deadline > now);
        let Some(next) = publications.active.values().copied().min() else {
            break;
        };
        let wait = next.saturating_duration_since(now);
        let (guard, _) = state
            .publication_gate
            .changed
            .wait_timeout(publications, wait)
            .expect("publication gate poisoned");
        publications = guard;
    }
    let _admission = state
        .policy_revision_gate
        .0
        .write()
        .expect("policy gate poisoned");
    let result = state.registry.replace_remote_grants_at_revision(
        connector_id,
        &revision,
        sequence,
        lease_issued_at_ms,
        lease_expires_at_ms,
        &grants,
    );
    state.cancel_remote_operations();
    drop(_admission);
    publications.snapshot_pending = false;
    drop(publications);
    state.publication_gate.changed.notify_all();

    match result {
        Ok(()) => {
            tracing::debug!(grants = grants.len(), "relay policy snapshot applied");
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
mod tests {
    use super::*;
    use crate::watcher::CollectionWatchService;
    use mdbase_connect_core::CollectionRegistry;
    use std::sync::Arc;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};
    use tempfile::tempdir;

    fn install_revision(state: &AgentState, revision: &str, sequence: u64) {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        state
            .registry
            .replace_grants_at_revision(revision, sequence, now, now + 60_000, &[])
            .unwrap();
    }

    fn state() -> (tempfile::TempDir, Arc<AgentState>) {
        let directory = tempdir().unwrap();
        let registry = CollectionRegistry::open(directory.path()).unwrap();
        let watcher = CollectionWatchService::start(registry.clone());
        let state = Arc::new(AgentState::new(registry, watcher, None));
        install_revision(&state, "old", 1);
        (directory, state)
    }

    fn snapshot(sequence: u64) -> PolicySnapshot {
        let connector_id = Uuid::nil();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let expires = now + 60_000;
        let body = serde_json::json!({
            "connector_id": connector_id,
            "sequence": sequence,
            "lease_issued_at_ms": now,
            "lease_expires_at_ms": expires,
            "grants": Vec::<GrantPolicy>::new(),
        });
        use sha2::Digest;
        let revision = format!(
            "sha256:{:x}",
            sha2::Sha256::digest(serde_jcs::to_vec(&body).unwrap())
        );
        PolicySnapshot {
            request_id: Uuid::new_v4(),
            revision,
            connector_id,
            sequence,
            lease_issued_at_ms: now,
            lease_expires_at_ms: expires,
            grants: Vec::new(),
        }
    }

    #[test]
    fn admission_releases_before_durable_work_and_successor_wins_publication() {
        let (_directory, state) = state();
        let permit = state.capture_policy_revision().unwrap();
        state.admit_policy_revision(&permit).unwrap();
        {
            let _publication = state.publication_gate.state.lock().unwrap();
            let _admission = state.policy_revision_gate.0.write().unwrap();
            install_revision(&state, "new", 2);
        }
        assert!(state
            .acquire_publication_permit(
                &permit,
                tokio::time::Instant::now() + Duration::from_secs(1)
            )
            .is_err());
    }

    #[test]
    fn stuck_admitted_durable_work_does_not_delay_snapshot_or_publish_receipt() {
        let (_directory, state) = state();
        let old = state.capture_policy_revision().unwrap();
        state.admit_policy_revision(&old).unwrap();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let durable = std::thread::spawn(move || release_rx.recv().unwrap());

        let started = Instant::now();
        let applied = apply_policy_snapshot(&state, CONTROL_PROTOCOL_VERSION, snapshot(2));
        assert!(matches!(
            applied,
            RelayMessage::PolicyApplied { ok: true, .. }
        ));
        assert!(started.elapsed() < Duration::from_millis(100));
        assert!(state
            .acquire_publication_permit(&old, tokio::time::Instant::now() + Duration::from_secs(1),)
            .is_err());

        release_tx.send(()).unwrap();
        durable.join().unwrap();
    }

    #[test]
    fn publication_winner_delays_successor_only_until_bounded_send_drops() {
        let (_directory, state) = state();
        let old = state.capture_policy_revision().unwrap();
        let publication = state
            .acquire_publication_permit(&old, tokio::time::Instant::now() + Duration::from_secs(1))
            .unwrap();
        let next_state = state.clone();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let successor = std::thread::spawn(move || {
            let result = apply_policy_snapshot(&next_state, CONTROL_PROTOCOL_VERSION, snapshot(2));
            done_tx.send(result).unwrap();
        });
        assert!(done_rx.recv_timeout(Duration::from_millis(20)).is_err());
        for _ in 0..100 {
            if state
                .publication_gate
                .state
                .lock()
                .unwrap()
                .snapshot_pending
            {
                break;
            }
            std::thread::yield_now();
        }
        assert!(
            state
                .publication_gate
                .state
                .lock()
                .unwrap()
                .snapshot_pending
        );
        assert!(state
            .acquire_publication_permit(&old, tokio::time::Instant::now() + Duration::from_secs(1),)
            .is_err());
        drop(publication);
        assert!(matches!(
            done_rx.recv_timeout(Duration::from_millis(200)).unwrap(),
            RelayMessage::PolicyApplied { ok: true, .. }
        ));
        successor.join().unwrap();
    }

    #[test]
    fn publication_permit_expires_without_drop() {
        let (_directory, state) = state();
        let revision = state.capture_policy_revision().unwrap();
        let publication = state
            .acquire_publication_permit(
                &revision,
                tokio::time::Instant::now() + Duration::from_millis(5),
            )
            .unwrap();
        std::thread::sleep(Duration::from_millis(10));
        assert!(!state.publication_is_current(&publication));
    }
}
