use super::*;
use mdbase_connect_protocol::MUTATING_OPERATION_IDENTIFIERS;
use tempfile::TempDir;

fn request() -> MutationClaimRequest {
    MutationClaimRequest {
        application_installation_id: Uuid::parse_str("01911111-1111-7111-8111-111111111111")
            .unwrap(),
        grant_id: Uuid::parse_str("01922222-2222-7222-8222-222222222222").unwrap(),
        request_id: Uuid::parse_str("01933333-3333-7333-8333-333333333333").unwrap(),
        operation_kind: "create".to_string(),
        input_schema_version: 1,
        input_digest: "fingerprint-v1".to_string(),
        grant_snapshot_digest: "grant-snapshot-v1".to_string(),
        allow_new: true,
    }
}

fn owned(claim: MutationClaim) -> (MutationLease, MutationRecoveryData) {
    match claim {
        MutationClaim::Owned { lease, recovery } => (lease, *recovery),
        other => panic!("expected owned mutation, got {other:?}"),
    }
}

#[test]
fn restart_takeover_recovers_state_and_fences_the_stale_owner() {
    let state = TempDir::new().unwrap();
    let first = CollectionRegistry::open(state.path()).unwrap();
    let (old_lease, recovery) = owned(first.claim_mutation(&request()).unwrap());
    assert_eq!(recovery.state, MutationJournalState::Claimed);
    first
        .prepare_mutation(
            &old_lease,
            Some(&json!({"plan": "content-digest-only"})),
            Some(&json!({"before": "missing"})),
        )
        .unwrap();
    assert!(matches!(
        first.claim_mutation(&request()).unwrap(),
        MutationClaim::Live {
            fencing_generation: 1,
            ..
        }
    ));

    let restarted = CollectionRegistry::open(state.path()).unwrap();
    let (new_lease, recovery) = owned(restarted.claim_mutation(&request()).unwrap());
    assert_eq!(new_lease.fencing_generation, 2);
    assert_eq!(recovery.state, MutationJournalState::Prepared);
    assert_eq!(
        recovery.prepared_data,
        Some(json!({"plan": "content-digest-only"}))
    );
    assert!(matches!(
        first.mark_mutation_applied(&old_lease, None, None),
        Err(ConnectError::MutationFenceLost { .. })
    ));

    restarted
        .mark_mutation_applied(
            &new_lease,
            Some(&json!({"after": "sha256:new"})),
            Some(&json!({"path": "record.md"})),
        )
        .unwrap();
    restarted
        .complete_mutation(
            &new_lease,
            "encrypted-final-receipt",
            Some(&json!({"ok": true})),
        )
        .unwrap();
    assert_eq!(
        restarted.claim_mutation(&request()).unwrap(),
        MutationClaim::Terminal {
            state: MutationJournalState::Completed,
            receipt: "encrypted-final-receipt".to_string(),
        }
    );
}

#[test]
fn concurrent_duplicates_conflicting_reuse_and_terminal_cardinality_fail_closed() {
    let state = TempDir::new().unwrap();
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let (lease, _) = owned(registry.claim_mutation(&request()).unwrap());
    assert!(matches!(
        registry.claim_mutation(&request()).unwrap(),
        MutationClaim::Live { .. }
    ));

    let mut conflict = request();
    conflict.input_digest = "different".to_string();
    assert!(matches!(
        registry.claim_mutation(&conflict),
        Err(ConnectError::MutationRequestConflict { .. })
    ));

    registry
        .complete_mutation(&lease, "one receipt", None)
        .unwrap();
    assert!(matches!(
        registry.complete_mutation(&lease, "second receipt", None),
        Err(ConnectError::MutationFenceLost { .. })
    ));
}

#[test]
fn unknown_requires_prepare_and_compaction_keeps_conflict_tombstones() {
    let state = TempDir::new().unwrap();
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let (lease, _) = owned(registry.claim_mutation(&request()).unwrap());
    assert!(matches!(
        registry.mark_mutation_outcome_unknown(&lease, "too early", None),
        Err(ConnectError::MutationFenceLost { .. })
    ));
    registry
        .prepare_mutation(&lease, None, Some(&json!({"before": "sha256:old"})))
        .unwrap();
    registry
        .mark_mutation_outcome_unknown(
            &lease,
            "durable unknown receipt",
            Some(&json!({"reason": "external interference"})),
        )
        .unwrap();

    let now = now_ms();
    registry
        .connection()
        .unwrap()
        .execute(
            "UPDATE mutation_journal
             SET completed_at_ms = ?1, updated_at_ms = ?1
             WHERE request_id = ?2",
            params![
                now.saturating_sub(ONLINE_RECOVERY_MS + 1),
                request().request_id.to_string()
            ],
        )
        .unwrap();
    assert_eq!(registry.compact_mutation_journal(now).unwrap(), 0);
    assert!(matches!(
        registry.claim_mutation(&request()).unwrap(),
        MutationClaim::Terminal {
            state: MutationJournalState::OutcomeUnknown,
            ..
        }
    ));

    let second = MutationClaimRequest {
        request_id: Uuid::new_v4(),
        ..request()
    };
    let (lease, _) = owned(registry.claim_mutation(&second).unwrap());
    registry
        .complete_mutation(&lease, "completed", None)
        .unwrap();
    registry
        .connection()
        .unwrap()
        .execute(
            "UPDATE mutation_journal
             SET completed_at_ms = ?1, updated_at_ms = ?1
             WHERE request_id = ?2",
            params![
                now.saturating_sub(ONLINE_RECOVERY_MS + 1),
                second.request_id.to_string()
            ],
        )
        .unwrap();
    assert_eq!(registry.compact_mutation_journal(now).unwrap(), 1);
    assert!(matches!(
        registry.claim_mutation(&second),
        Err(ConnectError::MutationRecoveryExpired { .. })
    ));
    let mut conflicting = second;
    conflicting.operation_kind = "delete".to_string();
    assert!(matches!(
        registry.claim_mutation(&conflicting),
        Err(ConnectError::MutationRequestConflict { .. })
    ));
}

#[test]
fn acknowledgement_and_diagnostics_are_privacy_safe() {
    let state = TempDir::new().unwrap();
    let registry = CollectionRegistry::open(state.path()).unwrap();
    let request = request();
    let (lease, _) = owned(registry.claim_mutation(&request).unwrap());
    registry.complete_mutation(&lease, "receipt", None).unwrap();
    registry
        .acknowledge_mutation(
            request.application_installation_id,
            request.grant_id,
            request.request_id,
            &request.input_digest,
        )
        .unwrap();
    let diagnostics = registry.mutation_journal_diagnostics().unwrap();
    assert_eq!(diagnostics.state_counts.get("acknowledged"), Some(&1));
    assert_eq!(diagnostics.live_leases, 0);
    assert_eq!(diagnostics.stale_leases, 0);
    let serialized = serde_json::to_string(&diagnostics).unwrap();
    assert!(!serialized.contains("receipt"));
    assert!(!serialized.contains(&request.request_id.to_string()));
}

#[test]
fn every_canonical_mutator_uses_the_same_state_machine_contract() {
    let state = TempDir::new().unwrap();
    let registry = CollectionRegistry::open(state.path()).unwrap();
    for operation in MUTATING_OPERATION_IDENTIFIERS {
        let request = MutationClaimRequest {
            request_id: Uuid::new_v4(),
            operation_kind: (*operation).to_string(),
            input_digest: format!("fingerprint:{operation}"),
            ..request()
        };
        let (lease, recovery) = owned(registry.claim_mutation(&request).unwrap());
        assert_eq!(recovery.state, MutationJournalState::Claimed, "{operation}");
        registry
            .prepare_mutation(&lease, Some(&json!({ "operation": operation })), None)
            .unwrap();
        registry
            .mark_mutation_applied(&lease, None, Some(&json!({ "applied": true })))
            .unwrap();
        registry
            .complete_mutation(&lease, &format!("receipt:{operation}"), None)
            .unwrap();
        assert!(matches!(
            registry.claim_mutation(&request).unwrap(),
            MutationClaim::Terminal {
                state: MutationJournalState::Completed,
                ..
            }
        ));
    }
    let diagnostics = registry.mutation_journal_diagnostics().unwrap();
    assert_eq!(
        diagnostics.state_counts.get("completed"),
        Some(&(MUTATING_OPERATION_IDENTIFIERS.len() as u64))
    );
}

#[derive(Debug, Clone, Copy)]
enum TerminationBoundary {
    Claim,
    Prepare,
    SideEffectApply,
    Reconcile,
    ReceiptCommit,
    ResponseSend,
}

#[test]
fn every_canonical_mutator_recovers_at_every_termination_boundary() {
    const BOUNDARIES: &[TerminationBoundary] = &[
        TerminationBoundary::Claim,
        TerminationBoundary::Prepare,
        TerminationBoundary::SideEffectApply,
        TerminationBoundary::Reconcile,
        TerminationBoundary::ReceiptCommit,
        TerminationBoundary::ResponseSend,
    ];

    for operation in MUTATING_OPERATION_IDENTIFIERS {
        for boundary in BOUNDARIES {
            let state = TempDir::new().unwrap();
            let first = CollectionRegistry::open(state.path()).unwrap();
            let request = MutationClaimRequest {
                request_id: Uuid::new_v4(),
                operation_kind: (*operation).to_string(),
                input_digest: format!("fingerprint:{operation}"),
                ..request()
            };
            let receipt = format!("receipt:{operation}");
            let (stale_lease, _) = owned(first.claim_mutation(&request).unwrap());
            let mut logical_effects = 0;

            if !matches!(boundary, TerminationBoundary::Claim) {
                first
                    .prepare_mutation(
                        &stale_lease,
                        Some(&json!({ "operation": operation })),
                        Some(&json!({ "state": "before" })),
                    )
                    .unwrap();
            }
            if matches!(
                boundary,
                TerminationBoundary::SideEffectApply
                    | TerminationBoundary::Reconcile
                    | TerminationBoundary::ReceiptCommit
                    | TerminationBoundary::ResponseSend
            ) {
                logical_effects += 1;
            }
            if matches!(
                boundary,
                TerminationBoundary::Reconcile
                    | TerminationBoundary::ReceiptCommit
                    | TerminationBoundary::ResponseSend
            ) {
                first
                    .mark_mutation_applied(
                        &stale_lease,
                        Some(&json!({ "state": "after" })),
                        Some(&json!({ "receipt": receipt })),
                    )
                    .unwrap();
            }
            if matches!(
                boundary,
                TerminationBoundary::ReceiptCommit | TerminationBoundary::ResponseSend
            ) {
                first
                    .complete_mutation(&stale_lease, &receipt, Some(&json!({ "receipt": receipt })))
                    .unwrap();
            }

            let restarted = CollectionRegistry::open(state.path()).unwrap();
            let mut revoked_replay = request.clone();
            revoked_replay.allow_new = false;
            match restarted.claim_mutation(&revoked_replay).unwrap() {
                MutationClaim::Terminal {
                    state: MutationJournalState::Completed,
                    receipt: replayed,
                } => assert_eq!(replayed, receipt, "{operation} at {boundary:?}"),
                MutationClaim::Owned { lease, recovery } => {
                    if recovery.state == MutationJournalState::Claimed {
                        restarted
                            .prepare_mutation(
                                &lease,
                                Some(&json!({ "operation": operation })),
                                Some(&json!({ "state": "before" })),
                            )
                            .unwrap();
                    }
                    if recovery.state != MutationJournalState::Applied {
                        // A prepared effect is reconciled from durable external evidence.
                        // Only a claim/prepare termination needs to perform it now.
                        if !matches!(boundary, TerminationBoundary::SideEffectApply) {
                            logical_effects += 1;
                        }
                        restarted
                            .mark_mutation_applied(
                                &lease,
                                Some(&json!({ "state": "after" })),
                                Some(&json!({ "receipt": receipt })),
                            )
                            .unwrap();
                    }
                    restarted
                        .complete_mutation(&lease, &receipt, Some(&json!({ "receipt": receipt })))
                        .unwrap();
                }
                other => panic!("unexpected replay for {operation} at {boundary:?}: {other:?}"),
            }

            assert_eq!(logical_effects, 1, "{operation} at {boundary:?}");
            assert!(matches!(
                restarted.claim_mutation(&revoked_replay).unwrap(),
                MutationClaim::Terminal { receipt: replayed, .. } if replayed == receipt
            ));
            assert!(matches!(
                first.complete_mutation(&stale_lease, "stale", None),
                Err(ConnectError::MutationFenceLost { .. })
            ));
            let mut conflicting = request.clone();
            conflicting.input_digest.push_str(":different");
            assert!(matches!(
                restarted.claim_mutation(&conflicting),
                Err(ConnectError::MutationRequestConflict { .. })
            ));
        }
    }
}

#[test]
fn lease_clock_bounds_and_compaction_edges_fail_safe() {
    let state = TempDir::new().unwrap();
    let registry = CollectionRegistry::open(state.path()).unwrap();

    let expired = request();
    let (expired_lease, _) = owned(registry.claim_mutation(&expired).unwrap());
    registry
        .connection()
        .unwrap()
        .execute(
            "UPDATE mutation_journal SET lease_expires_at_ms = ?1 WHERE request_id = ?2",
            params![now_ms().saturating_sub(1), expired.request_id.to_string()],
        )
        .unwrap();
    let (expired_takeover, _) = owned(registry.claim_mutation(&expired).unwrap());
    assert_eq!(expired_takeover.fencing_generation, 2);
    assert!(matches!(
        registry.complete_mutation(&expired_lease, "stale", None),
        Err(ConnectError::MutationFenceLost { .. })
    ));

    let future = MutationClaimRequest {
        request_id: Uuid::new_v4(),
        ..request()
    };
    let (future_lease, _) = owned(registry.claim_mutation(&future).unwrap());
    registry
        .connection()
        .unwrap()
        .execute(
            "UPDATE mutation_journal SET lease_expires_at_ms = ?1 WHERE request_id = ?2",
            params![
                now_ms().saturating_add(MAX_LEASE_MS).saturating_add(DAY_MS),
                future.request_id.to_string()
            ],
        )
        .unwrap();
    let (future_takeover, _) = owned(registry.claim_mutation(&future).unwrap());
    assert_eq!(future_takeover.fencing_generation, 2);
    assert!(matches!(
        registry.complete_mutation(&future_lease, "stale", None),
        Err(ConnectError::MutationFenceLost { .. })
    ));

    let compaction_at = now_ms();
    for (age, should_compact) in [
        (ONLINE_RECOVERY_MS.saturating_sub(1), false),
        (ONLINE_RECOVERY_MS, true),
    ] {
        let candidate = MutationClaimRequest {
            request_id: Uuid::new_v4(),
            ..request()
        };
        let (lease, _) = owned(registry.claim_mutation(&candidate).unwrap());
        registry.complete_mutation(&lease, "receipt", None).unwrap();
        registry
            .connection()
            .unwrap()
            .execute(
                "UPDATE mutation_journal SET completed_at_ms = ?1 WHERE request_id = ?2",
                params![
                    compaction_at.saturating_sub(age),
                    candidate.request_id.to_string()
                ],
            )
            .unwrap();
        let compacted = registry.compact_mutation_journal(compaction_at).unwrap();
        assert_eq!(compacted == 1, should_compact);
    }
}
