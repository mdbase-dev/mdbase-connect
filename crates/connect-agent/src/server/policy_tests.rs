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
    state_with_lease(60_000)
}

fn state_with_lease(lease_ms: i64) -> (tempfile::TempDir, Arc<AgentState>) {
    let directory = tempdir().unwrap();
    let registry = CollectionRegistry::open(directory.path()).unwrap();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    registry
        .replace_remote_grants_at_revision(Uuid::nil(), "old", 1, now, now + lease_ms, &[])
        .unwrap();
    let watcher = CollectionWatchService::start(registry.clone());
    let state = Arc::new(AgentState::new(registry, watcher, None));
    (directory, state)
}

fn snapshot(sequence: u64) -> PolicySnapshot {
    snapshot_for(Uuid::nil(), sequence, 60_000)
}

fn snapshot_for(connector_id: Uuid, sequence: u64, lease_ms: i64) -> PolicySnapshot {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    snapshot_at(connector_id, sequence, now, lease_ms)
}

fn snapshot_at(connector_id: Uuid, sequence: u64, now: i64, lease_ms: i64) -> PolicySnapshot {
    let expires = now + lease_ms;
    let grants = Vec::<GrantPolicy>::new();
    let body = serde_json::json!({
        "connector_id": connector_id,
        "sequence": sequence,
        "lease_issued_at_ms": now,
        "lease_expires_at_ms": expires,
        "grants": &grants,
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
        grants,
    }
}

fn bind_snapshot(snapshot: &mut PolicySnapshot) {
    let mut grants = snapshot.grants.clone();
    grants.sort_by_key(|grant| grant.id);
    let body = serde_json::json!({
        "connector_id": snapshot.connector_id,
        "sequence": snapshot.sequence,
        "lease_issued_at_ms": snapshot.lease_issued_at_ms,
        "lease_expires_at_ms": snapshot.lease_expires_at_ms,
        "grants": grants,
    });
    use sha2::Digest;
    snapshot.revision = format!(
        "sha256:{:x}",
        sha2::Sha256::digest(serde_jcs::to_vec(&body).unwrap())
    );
}

fn authenticated_state(
    lease_ms: i64,
) -> (tempfile::TempDir, Arc<AgentState>, Uuid, PolicySnapshot) {
    let directory = tempdir().unwrap();
    let registry = CollectionRegistry::open(directory.path()).unwrap();
    let connector_id = Uuid::new_v4();
    let initial = snapshot_for(connector_id, 1, lease_ms);
    registry
        .replace_remote_grants_at_revision(
            connector_id,
            &initial.revision,
            initial.sequence,
            initial.lease_issued_at_ms,
            initial.lease_expires_at_ms,
            &initial.grants,
        )
        .unwrap();
    let watcher = CollectionWatchService::start(registry.clone());
    let state = Arc::new(AgentState::new(registry, watcher, None));
    (directory, state, connector_id, initial)
}

fn fixture_grant() -> (Uuid, GrantPolicy) {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../test-fixtures/protocol-v1-policy-canonical.json"
    ))
    .unwrap();
    let wire = &fixture["normalized_wire_body"];
    let connector_id: Uuid = serde_json::from_value(wire["connector_id"].clone()).unwrap();
    let grants: Vec<GrantPolicy> = serde_json::from_value(wire["grants"].clone()).unwrap();
    let grant = grants.into_iter().nth(1).unwrap();
    grant.validate_application_security().unwrap();
    (connector_id, grant)
}

fn authenticated_grant_state() -> (tempfile::TempDir, Arc<AgentState>, Uuid) {
    let (connector_id, grant) = fixture_grant();
    let directory = tempdir().unwrap();
    let registry = CollectionRegistry::open(directory.path()).unwrap();
    let initial = snapshot_for(connector_id, 1, 55_000);
    registry
        .replace_remote_grants_at_revision(
            connector_id,
            &initial.revision,
            initial.sequence,
            initial.lease_issued_at_ms,
            initial.lease_expires_at_ms,
            &[grant],
        )
        .unwrap();
    let watcher = CollectionWatchService::start(registry.clone());
    let state = Arc::new(AgentState::new(registry, watcher, None));
    (directory, state, connector_id)
}

#[test]
fn equivalent_pre_expiry_renewals_preserve_admitted_and_publishing_work() {
    let (_directory, state, connector_id, _initial) = authenticated_state(55_000);
    let permit = state.capture_policy_revision().unwrap();
    state.admit_policy_revision(&permit).unwrap();
    let cancellation = mdbase::OperationCancellation::new();
    let registration = state.register_remote_operation(&cancellation);
    let publication = state
        .acquire_publication_permit(
            &permit,
            tokio::time::Instant::now() + Duration::from_secs(1),
        )
        .unwrap();
    let epoch = state.policy_revision_gate.0.read().unwrap().epoch;

    let second = snapshot_for(connector_id, 2, 55_000);
    let second_revision = second.revision.clone();
    let second_expiry = second.lease_expires_at_ms;
    assert!(matches!(
        apply_policy_snapshot(&state, CONTROL_PROTOCOL_VERSION, second),
        RelayMessage::PolicyApplied { ok: true, .. }
    ));
    let third = snapshot_for(connector_id, 3, 55_000);
    let third_revision = third.revision.clone();
    let third_expiry = third.lease_expires_at_ms;
    assert!(matches!(
        apply_policy_snapshot(&state, CONTROL_PROTOCOL_VERSION, third),
        RelayMessage::PolicyApplied { ok: true, .. }
    ));

    assert!(!cancellation.is_cancelled());
    assert_eq!(state.policy_revision_gate.0.read().unwrap().epoch, epoch);
    state.admit_policy_revision(&permit).unwrap();
    assert!(state.publication_is_current(&publication));
    let durable = state.registry.remote_policy_authority().unwrap();
    assert_eq!(durable.sequence, 3);
    assert_eq!(durable.revision, third_revision);
    assert_eq!(durable.lease_expires_at_ms, third_expiry);
    assert_ne!(durable.revision, second_revision);
    assert!(durable.lease_expires_at_ms >= second_expiry);
    state.unregister_remote_operation(registration);
}

#[test]
fn equal_authority_renewal_after_expiry_fences_every_old_permit() {
    let (_directory, state, connector_id, initial) = authenticated_state(200);
    let clock = state.manual_policy_clock(initial.lease_issued_at_ms);
    let old = state.capture_policy_revision().unwrap();
    state.admit_policy_revision(&old).unwrap();
    let old_publication = state
        .acquire_publication_permit(&old, tokio::time::Instant::now() + Duration::from_secs(1))
        .unwrap();
    let old_epoch = old.authority_epoch;

    clock.advance_to(initial.lease_expires_at_ms);
    assert!(state.admit_policy_revision(&old).is_err());
    assert!(!state.publication_is_current(&old_publication));

    // T2 is realistic wall time and remains inside the production storage
    // skew allowance rather than relying on an unbounded process clock.
    let t2 = initial.lease_expires_at_ms;
    let renewal = snapshot_at(connector_id, 2, t2, 55_000);
    assert!(matches!(
        apply_policy_snapshot(&state, CONTROL_PROTOCOL_VERSION, renewal),
        RelayMessage::PolicyApplied { ok: true, .. }
    ));
    assert_eq!(
        state.policy_revision_gate.0.read().unwrap().epoch,
        old_epoch + 1
    );
    let new = state.capture_policy_revision().unwrap();
    state.admit_policy_revision(&new).unwrap();
    let new_publication = state
        .acquire_publication_permit(&new, tokio::time::Instant::now() + Duration::from_secs(1))
        .unwrap();
    assert!(state.publication_is_current(&new_publication));
    assert!(state.admit_policy_revision(&old).is_err());
    assert!(!state.publication_is_current(&old_publication));
    assert!(state
        .acquire_publication_permit(&old, tokio::time::Instant::now() + Duration::from_secs(1),)
        .is_err());
}

#[test]
fn failed_pinned_connector_replacement_has_no_runtime_side_effects() {
    let (_directory, state, _connector_id, _initial) = authenticated_state(55_000);
    let permit = state.capture_policy_revision().unwrap();
    let cancellation = mdbase::OperationCancellation::new();
    let registration = state.register_remote_operation(&cancellation);
    let publication = state
        .acquire_publication_permit(
            &permit,
            tokio::time::Instant::now() + Duration::from_secs(1),
        )
        .unwrap();
    let before = state.registry.remote_policy_authority().unwrap();
    let old_epoch = permit.authority_epoch;
    let conflicting = snapshot_for(Uuid::new_v4(), 2, 55_000);
    assert!(matches!(
        apply_policy_snapshot(&state, CONTROL_PROTOCOL_VERSION, conflicting),
        RelayMessage::PolicyApplied { ok: false, .. }
    ));
    let after = state.registry.remote_policy_authority().unwrap();
    assert_eq!(
        state.policy_revision_gate.0.read().unwrap().epoch,
        old_epoch
    );
    assert_eq!(
        state.policy_revision_gate.0.read().unwrap().digest,
        before.authority_digest
    );
    assert_eq!(after.revision, before.revision);
    assert_eq!(after.sequence, before.sequence);
    assert!(
        !state
            .publication_gate
            .state
            .lock()
            .unwrap()
            .snapshot_pending
    );
    assert!(!cancellation.is_cancelled());
    state.admit_policy_revision(&permit).unwrap();
    assert!(state.publication_is_current(&publication));
    state.unregister_remote_operation(registration);
}

#[test]
fn malformed_and_stale_snapshots_have_no_runtime_side_effects() {
    let (_directory, state, connector_id, initial) = authenticated_state(55_000);
    let permit = state.capture_policy_revision().unwrap();
    let cancellation = mdbase::OperationCancellation::new();
    let registration = state.register_remote_operation(&cancellation);
    let publication = state
        .acquire_publication_permit(
            &permit,
            tokio::time::Instant::now() + Duration::from_secs(1),
        )
        .unwrap();
    let before = state.registry.remote_policy_authority().unwrap();
    let epoch = permit.authority_epoch;

    let mut malformed = snapshot_for(connector_id, 2, 60_000);
    malformed.lease_expires_at_ms = malformed.lease_issued_at_ms;
    bind_snapshot(&mut malformed);
    let lower = snapshot_for(connector_id, 0, 55_000);
    let equal_conflict = snapshot_for(connector_id, initial.sequence, 55_000);
    let (_, mut wrong_connector_grant) = fixture_grant();
    wrong_connector_grant
        .encryption
        .as_mut()
        .unwrap()
        .connector_id = Uuid::new_v4();
    let mut wrong_connector = snapshot_for(connector_id, 2, 55_000);
    wrong_connector.grants = vec![wrong_connector_grant];
    bind_snapshot(&mut wrong_connector);
    let (_, mut invalid_proof_grant) = fixture_grant();
    invalid_proof_grant
        .encryption
        .as_mut()
        .unwrap()
        .connector_id = connector_id;
    invalid_proof_grant.application_authorization.signature = "invalid".to_string();
    let mut invalid_proof = snapshot_for(connector_id, 2, 55_000);
    invalid_proof.grants = vec![invalid_proof_grant];
    bind_snapshot(&mut invalid_proof);
    for candidate in [
        malformed,
        lower,
        equal_conflict,
        wrong_connector,
        invalid_proof,
    ] {
        assert!(matches!(
            apply_policy_snapshot(&state, CONTROL_PROTOCOL_VERSION, candidate),
            RelayMessage::PolicyApplied { ok: false, .. }
        ));
    }
    let after = state.registry.remote_policy_authority().unwrap();
    assert_eq!(after.revision, before.revision);
    assert_eq!(after.sequence, before.sequence);
    assert_eq!(state.policy_revision_gate.0.read().unwrap().epoch, epoch);
    assert_eq!(
        state.policy_revision_gate.0.read().unwrap().digest,
        before.authority_digest
    );
    assert!(
        !state
            .publication_gate
            .state
            .lock()
            .unwrap()
            .snapshot_pending
    );
    assert!(!cancellation.is_cancelled());
    state.admit_policy_revision(&permit).unwrap();
    assert!(state.publication_is_current(&publication));
    state.unregister_remote_operation(registration);
}

#[test]
fn genuine_revocation_cancels_and_fences_old_authority() {
    let (_directory, state, connector_id) = authenticated_grant_state();
    let old = state.capture_policy_revision().unwrap();
    let cancellation = mdbase::OperationCancellation::new();
    let registration = state.register_remote_operation(&cancellation);
    let old_epoch = old.authority_epoch;

    assert!(matches!(
        apply_policy_snapshot(
            &state,
            CONTROL_PROTOCOL_VERSION,
            snapshot_for(connector_id, 2, 55_000)
        ),
        RelayMessage::PolicyApplied { ok: true, .. }
    ));
    assert!(cancellation.is_cancelled());
    assert_eq!(
        state.policy_revision_gate.0.read().unwrap().epoch,
        old_epoch + 1
    );
    assert!(state.admit_policy_revision(&old).is_err());
    assert!(
        !state
            .publication_gate
            .state
            .lock()
            .unwrap()
            .snapshot_pending
    );
    state.unregister_remote_operation(registration);
}

#[test]
fn valid_snapshot_storage_failure_cleans_pending_without_advancing_epoch() {
    let (directory, state, connector_id) = authenticated_grant_state();
    let old = state.capture_policy_revision().unwrap();
    let cancellation = mdbase::OperationCancellation::new();
    let registration = state.register_remote_operation(&cancellation);
    let before = state.registry.remote_policy_authority().unwrap();
    let connection = rusqlite::Connection::open(directory.path().join("authority.sqlite")).unwrap();
    connection
        .execute_batch(
            "CREATE TRIGGER fail_policy_update BEFORE UPDATE ON policy_state
             BEGIN SELECT RAISE(FAIL, 'injected policy storage failure'); END;",
        )
        .unwrap();

    assert!(matches!(
        apply_policy_snapshot(
            &state,
            CONTROL_PROTOCOL_VERSION,
            snapshot_for(connector_id, 2, 55_000)
        ),
        RelayMessage::PolicyApplied { ok: false, .. }
    ));
    connection
        .execute_batch("DROP TRIGGER fail_policy_update;")
        .unwrap();
    let after = state.registry.remote_policy_authority().unwrap();
    assert!(cancellation.is_cancelled());
    assert_eq!(after.revision, before.revision);
    assert_eq!(after.sequence, before.sequence);
    assert_eq!(
        state.policy_revision_gate.0.read().unwrap().epoch,
        old.authority_epoch
    );
    assert_eq!(
        state.policy_revision_gate.0.read().unwrap().digest,
        before.authority_digest
    );
    assert!(
        !state
            .publication_gate
            .state
            .lock()
            .unwrap()
            .snapshot_pending
    );
    state.unregister_remote_operation(registration);
}

#[test]
fn concurrent_applies_serialize_to_the_highest_sequence() {
    let (_directory, state, connector_id, _initial) = authenticated_state(55_000);
    let barrier = Arc::new(std::sync::Barrier::new(3));
    let mut handles = Vec::new();
    for sequence in [2, 3] {
        let state = state.clone();
        let barrier = barrier.clone();
        handles.push(std::thread::spawn(move || {
            let candidate = snapshot_for(connector_id, sequence, 55_000);
            barrier.wait();
            apply_policy_snapshot(&state, CONTROL_PROTOCOL_VERSION, candidate)
        }));
    }
    barrier.wait();
    for handle in handles {
        assert!(matches!(
            handle.join().unwrap(),
            RelayMessage::PolicyApplied { .. }
        ));
    }
    assert_eq!(
        state.registry.remote_policy_authority().unwrap().sequence,
        3
    );
    assert!(
        !state
            .publication_gate
            .state
            .lock()
            .unwrap()
            .snapshot_pending
    );
}

#[test]
fn wire_revision_advance_alone_preserves_authority_permit() {
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
        .is_ok());
}

#[test]
fn stuck_admitted_durable_work_does_not_delay_snapshot_or_publish_receipt() {
    let (_directory, state) = state_with_lease(60_000);
    let old = state.capture_policy_revision().unwrap();
    state.admit_policy_revision(&old).unwrap();
    let expiry = state
        .registry
        .remote_policy_authority()
        .unwrap()
        .lease_expires_at_ms;
    let _clock = state.manual_policy_clock(expiry);
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
    let (_directory, state) = state_with_lease(60_000);
    let now = Instant::now();
    let clock = state.manual_publication_clock(now);
    let deadline = now + Duration::from_secs(1);
    let old = state.capture_policy_revision().unwrap();
    let publication = state
        .acquire_publication_permit(&old, tokio::time::Instant::from_std(deadline))
        .unwrap();
    let expiry = state
        .registry
        .remote_policy_authority()
        .unwrap()
        .lease_expires_at_ms;
    let _policy_clock = state.manual_policy_clock(expiry);
    let next_state = state.clone();
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let successor = std::thread::spawn(move || {
        let result = apply_policy_snapshot(&next_state, CONTROL_PROTOCOL_VERSION, snapshot(2));
        done_tx.send(result).unwrap();
    });
    clock.wait_until_snapshot_pending();
    assert!(matches!(
        done_rx.try_recv(),
        Err(std::sync::mpsc::TryRecvError::Empty)
    ));
    assert!(state
        .acquire_publication_permit(&old, tokio::time::Instant::from_std(deadline))
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
    let now = Instant::now();
    let clock = state.manual_publication_clock(now);
    let deadline = now + Duration::from_millis(5);
    let revision = state.capture_policy_revision().unwrap();
    let publication = state
        .acquire_publication_permit(&revision, tokio::time::Instant::from_std(deadline))
        .unwrap();
    clock.advance_to(deadline - Duration::from_nanos(1));
    assert!(state.publication_is_current(&publication));
    clock.advance_to(deadline);
    assert!(!state.publication_is_current(&publication));
}
