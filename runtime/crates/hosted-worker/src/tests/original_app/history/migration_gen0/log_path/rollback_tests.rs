use super::*;

fn drain(r: &Run) -> Vec<u8> {
    enc(vec![
        Cbor::Uint(3),
        b(r.c().0),
        t("migrating"),
        b(RUN),
        Cbor::Uint(HEAD),
        t(STARTED),
        Cbor::Null,
        Cbor::Uint(0),
        Cbor::Uint(0),
        Cbor::Uint(0),
    ])
}
fn request(r: &mut Run) {
    assert!(r.refresh());
    let source = drain(r);
    r.d.request_rollback(1, &binding(&r.target), &source, &mut r.h.e, &r.target)
        .unwrap();
    assert_eq!(r.d.test_checkpoint().step, Step::RollingBack);
    assert_eq!(
        r.d.test_checkpoint().failure.as_deref(),
        Some("operator_rollback")
    );
}
fn rollback(revoked: bool) -> Run {
    let mut r = shadowed();
    if revoked {
        r.reach_revoked();
    } else {
        let fence = enc(vec![
            Cbor::Uint(2),
            b(r.c().0),
            t("migrating"),
            b(RUN),
            t(STARTED),
            Cbor::Null,
            Cbor::Array(vec![]),
        ]);
        r.d.settle_provider(&r.p, &fence).unwrap();
    }
    request(&mut r);
    r.advance(180);
    assert_eq!(r.p.data().kind, if revoked { 20 } else { 21 });
    r
}
fn receipt(r: &mut Run, revoked: bool) -> Vec<Cbor> {
    let scope = r.d.rollback_scope(&r.p).unwrap();
    let Cbor::Array(wire) = cbor::decode(&scope.to_bytes().unwrap()).unwrap() else {
        unreachable!()
    };
    assert_eq!(wire.len(), 7);
    assert_eq!(wire[5], scope.epoch.map(Cbor::Uint).unwrap_or(Cbor::Null));
    vec![
        b(r.c().0),
        b(r.target.genesis_owner().0),
        b(scope.provider.0),
        Cbor::Uint(17),
        Cbor::Uint(scope.head),
        b(scope.driver.0),
        b(scope.action.0),
        Cbor::Array(if revoked {
            vec![b(replica_id())]
        } else {
            vec![]
        }),
        Cbor::Array(vec![]),
        t("2026-10-12T22:00:00Z"),
    ]
}
fn reopen(mut r: Run) -> Run {
    r.d = JournalDriver::resume(
        r.d.into_index(),
        binding(&r.target),
        &mut TestEntropy::new(220),
    )
    .unwrap();
    r
}

#[test]
fn full_original_unrevoke_then_different_unfence_and_explicit_retry() {
    let mut r = rollback(true);
    let original_action = r.p.data().action;
    let body = enc(receipt(&mut r, true));
    assert!(matches!(
        r.d.settle(&r.p, Outcome::Ok),
        Err(LedgerError::Unsupported)
    ));
    r.d.settle_rollback(&r.p, &body).unwrap();
    assert!(r.d.test_checkpoint().revoked.is_empty());
    assert!(r.d.test_checkpoint().fenced);
    r = reopen(r);
    r.advance(182);
    assert_eq!(r.action(), Action::Unfence);
    assert_ne!(r.p.data().action, original_action);
    let scope = r.d.rollback_scope(&r.p).unwrap();
    assert!(scope.original);
    assert_eq!(scope.action, original_action);
    assert_eq!(scope.epoch, Some(17));
    let mut changed = cbor::decode(&body).unwrap();
    if let Cbor::Array(fields) = &mut changed {
        fields[9] = t("2026-10-12T22:01:00Z");
    }
    assert_eq!(
        r.d.settle_rollback(&r.p, &cbor::encode(&changed).unwrap()),
        Err(LedgerError::Conflict)
    );
    r.d.settle_rollback(&r.p, &body).unwrap();
    assert!(!r.d.test_checkpoint().fenced);
    assert!(matches!(
        r.d.prepare(&mut TestEntropy::new(225)),
        Err(LedgerError::Unsupported)
    ));
    assert_eq!(r.d.test_checkpoint().step, Step::RolledBack);
    assert!(r.refresh());
    r.d.restart_on_target(
        1,
        &binding(&r.target),
        &mut TestEntropy::new(227),
        &mut r.h.e,
        &r.target,
    )
    .unwrap();
    assert_eq!(r.d.run_sequence(), 2);
    assert_eq!(
        r.d.read_run(1).unwrap().unwrap().checkpoint.step,
        Step::RolledBack
    );
}

#[test]
fn wrong_full_receipt_fields_never_clear_the_original_pending() {
    let mut r = rollback(true);
    let original = receipt(&mut r, true);
    let before = r.d.test_checkpoint();
    let pending = r.d.saved_pending().unwrap();
    for (at, wrong) in [
        (0, b(id(0xe1))),
        (1, b(id(0xe2))),
        (2, b(id(0xe3))),
        (3, Cbor::Uint(0)),
        (4, Cbor::Uint(HEAD + 1)),
        (5, b(id(0xe4))),
        (6, b(id(0xe5))),
        (7, Cbor::Array(vec![])),
        (8, Cbor::Array(vec![b(id(0xe6))])),
        (9, t("not a timestamp")),
    ] {
        let mut fields = original.clone();
        fields[at] = wrong;
        assert!(r.d.settle_rollback(&r.p, &enc(fields)).is_err());
        assert_eq!(r.d.test_checkpoint(), before);
        assert_eq!(r.d.saved_pending().unwrap(), pending);
    }
    assert!(
        r.d.settle_rollback(&r.p, &enc(vec![Cbor::Bool(true)]))
            .is_err()
    );
    r.d.settle_rollback(&r.p, &enc(original)).unwrap();
}

#[test]
fn empty_scope_unfence_and_unknown_receipt_recovery_are_settlement_only() {
    for revoked in [false, true] {
        let mut r = rollback(revoked);
        let body = enc(receipt(&mut r, revoked));
        let sequence = r.p.data().sequence;
        r = reopen(r);
        assert!(matches!(
            r.d.prepare(&mut TestEntropy::new(222)),
            Err(LedgerError::OutstandingUnknown)
        ));
        let scope = r.d.unknown_rollback_scope(sequence).unwrap();
        assert_eq!(scope.action, r.p.data().action);
        assert!(r.refresh());
        let (settled, result) =
            r.d.resolve_rollback(sequence, &body, &mut r.h.e, &r.target)
                .unwrap();
        assert!(r.d.assert_prepared(&settled).is_err());
        r.d.assert_settled(&settled, result).unwrap();
        assert!(r.d.saved_pending().unwrap().is_none());
        if revoked {
            r.advance(224);
            r.d.settle_rollback(&r.p, &body).unwrap();
        }
        assert!(!r.d.test_checkpoint().fenced);
    }
}

#[test]
fn receipt_checkpoint_and_original_action_are_atomic_even_after_lost_ack() {
    let mut r = rollback(true);
    let body = enc(receipt(&mut r, true));
    r.d.test_lose_settlement();
    assert_eq!(
        r.d.settle_rollback(&r.p, &body),
        Err(LedgerError::StorageUnknown)
    );
    assert!(r.d.prepare(&mut TestEntropy::new(221)).is_err());
    r = reopen(r);
    assert!(r.d.saved_pending().unwrap().is_none());
    assert!(r.d.test_checkpoint().revoked.is_empty());
    r.advance(224);
    let original = r.d.rollback_scope(&r.p).unwrap();
    assert!(original.original);
    assert_ne!(original.action, r.p.data().action);
    r.d.settle_rollback(&r.p, &body).unwrap();
}

#[test]
fn original_receipt_insert_refusal_rolls_back_action_checkpoint_and_metadata() {
    let mut r = rollback(true);
    let body = enc(receipt(&mut r, true));
    let before = r.d.test_checkpoint();
    let pending = r.d.saved_pending().unwrap();
    r.d.test_index_mut().db.execute_batch("CREATE TRIGGER refuse_original BEFORE INSERT ON mig_rollback_receipt_data BEGIN SELECT RAISE(ABORT,'synthetic receipt insert refusal'); END").unwrap();
    assert_eq!(
        r.d.settle_rollback(&r.p, &body),
        Err(LedgerError::StorageUnknown)
    );
    r = reopen(r);
    assert_eq!(r.d.test_checkpoint(), before);
    assert_eq!(r.d.saved_pending().unwrap(), pending);
    let count: i64 =
        r.d.test_index_mut()
            .db
            .query_row(
                "SELECT count(*) FROM mig_rollback_receipt_data",
                [],
                |row| row.get(0),
            )
            .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn rollback_intent_refuses_pending_and_source_drift_before_mutation() {
    let mut r = shadowed();
    assert!(r.refresh());
    let original = drain(&r);
    let before = r.d.test_checkpoint();
    assert_eq!(
        r.d.request_rollback(1, &binding(&r.target), &original, &mut r.h.e, &r.target),
        Err(LedgerError::OutstandingUnknown)
    );
    assert_eq!(r.d.test_checkpoint(), before);
    let fence = enc(vec![
        Cbor::Uint(2),
        b(r.c().0),
        t("migrating"),
        b(RUN),
        t(STARTED),
        Cbor::Null,
        Cbor::Array(vec![]),
    ]);
    r.d.settle_provider(&r.p, &fence).unwrap();
    let checkpoint = r.d.test_checkpoint();
    let Cbor::Array(fields) = cbor::decode(&original).unwrap() else {
        unreachable!()
    };
    for (at, wrong) in [
        (1, b(id(0xe1))),
        (2, t("active")),
        (3, b(id(0xe2))),
        (4, Cbor::Uint(HEAD + 1)),
        (5, t("foreign-stamp")),
        (6, t("2026-10-13T00:00:00Z")),
        (7, Cbor::Uint(1)),
    ] {
        let mut bad = fields.clone();
        bad[at] = wrong;
        assert!(
            r.d.request_rollback(1, &binding(&r.target), &enc(bad), &mut r.h.e, &r.target)
                .is_err()
        );
        assert_eq!(r.d.test_checkpoint(), checkpoint);
    }
    assert_eq!(
        r.d.request_rollback(2, &binding(&r.target), &original, &mut r.h.e, &r.target),
        Err(LedgerError::Conflict)
    );
    assert_eq!(r.d.test_checkpoint().step, checkpoint.step);
    let count: i64 =
        r.d.test_index_mut()
            .db
            .query_row(
                "SELECT count(*) FROM mig_native_rollback_context",
                [],
                |row| row.get(0),
            )
            .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn fenced_gen0_rollback_cancels_staged_or_evicted_work_then_unfences() {
    for kind in [4, 5] {
        for evicted in [false, true] {
            SEED.set(140);
            let mut r = run();
            if kind == 5 {
                r.windows(&mut Objects::default(), 90);
                r.d.gen0_finish(&r.p, &mut r.h.e, &r.target).unwrap();
            } else {
                let input = window_input(r.c(), resource_rows(&r.l));
                r.d.gen0_window(&r.p, &mut r.h.e, &r.target, &input)
                    .unwrap();
            }
            let original = r.d.saved_pending().unwrap().unwrap();
            assert_eq!(original.kind, kind);
            assert!(r.d.test_checkpoint().fenced);
            if evicted {
                r = reopen(r);
            }
            let source = drain(&r);
            assert_eq!(
                r.d.request_rollback(2, &binding(&r.target), &source, &mut r.h.e, &r.target),
                Err(LedgerError::Conflict)
            );
            assert_eq!(
                r.d.request_rollback(1, &binding(&r.target), &[], &mut r.h.e, &r.target),
                Err(LedgerError::Invalid)
            );
            assert_eq!(r.d.saved_pending().unwrap(), Some(original.clone()));
            request(&mut r);
            assert!(r.d.saved_pending().unwrap().is_none());
            assert!(
                r.d.assert_prepared(&r.p).is_err(),
                "old gen0 ticket cannot replay"
            );
            let after: Vec<u8> =
                r.d.test_index_mut()
                    .db
                    .query_row(
                        "SELECT after_cp FROM mig_native_action WHERE seq=?1 AND settled=1",
                        [original.sequence],
                        |row| row.get(0),
                    )
                    .unwrap();
            assert_eq!(after, r.d.test_checkpoint().to_bytes().unwrap());
            r = reopen(r);
            r.advance(180);
            assert_eq!(r.p.data().kind, 21);
            let body = enc(receipt(&mut r, false));
            r.d.settle_rollback(&r.p, &body).unwrap();
            assert!(!r.d.test_checkpoint().fenced);
            assert!(r.d.prepare(&mut TestEntropy::new(224)).is_err());
            assert_eq!(r.d.test_checkpoint().step, Step::RolledBack);
            r.d.restart_on_target(
                1,
                &binding(&r.target),
                &mut TestEntropy::new(225),
                &mut r.h.e,
                &r.target,
            )
            .unwrap();
            assert_eq!(r.d.test_checkpoint().step, Step::Start);
        }
    }
}

#[test]
fn gen0_rollback_checkpoint_drift_never_clears_the_pending() {
    let mut r = run();
    let source = drain(&r);
    let original = r.d.saved_pending().unwrap();
    let settled = r.d.test_settled();
    r.d.test_index_mut()
        .db
        .execute("UPDATE mig_checkpoint SET v=x'00' WHERE k=0", [])
        .unwrap();
    assert_eq!(
        r.d.request_rollback(1, &binding(&r.target), &source, &mut r.h.e, &r.target),
        Err(LedgerError::StorageUnknown)
    );
    assert_eq!(r.d.saved_pending().unwrap(), original);
    assert_eq!(r.d.test_settled(), settled);
}

#[test]
fn gen0_rollback_lost_transaction_ack_reopens_cancelled_not_replayable() {
    let mut r = run();
    let source = drain(&r);
    r.d.test_lose_settlement();
    assert_eq!(
        r.d.request_rollback(1, &binding(&r.target), &source, &mut r.h.e, &r.target),
        Err(LedgerError::StorageUnknown)
    );
    r = reopen(r);
    assert!(r.d.saved_pending().unwrap().is_none());
    assert_eq!(r.d.test_checkpoint().step, Step::RollingBack);
    assert!(
        r.d.test_checkpoint().fenced,
        "unfence is still a required receipt-qualified action"
    );
}

#[test]
fn evicted_unknown_base_needs_actual_exact_native_log_and_cannot_be_replayed() {
    for sent in [false, true] {
        let mut r = run();
        r.reach_base();
        let sequence = r.p.data().sequence;
        if sent {
            r.append().unwrap();
            r.h.pump(false);
        }
        r = reopen(r);
        assert!(r.refresh());
        let resolved = r.d.resolve_base(sequence, &mut r.h.e, &r.target);
        if sent {
            let (settled, result) = resolved.unwrap();
            assert!(r.d.assert_prepared(&settled).is_err());
            r.d.assert_settled(&settled, result).unwrap();
            assert!(r.d.saved_pending().unwrap().is_none());
            assert_eq!(r.d.test_checkpoint().step, Step::BaseAppended);
        } else {
            assert!(matches!(resolved, Err(LedgerError::OutstandingUnknown)));
            assert_eq!(r.d.saved_pending().unwrap().unwrap().sequence, sequence);
            assert!(matches!(
                r.d.prepare(&mut TestEntropy::new(224)),
                Err(LedgerError::OutstandingUnknown)
            ));
        }
    }
}
