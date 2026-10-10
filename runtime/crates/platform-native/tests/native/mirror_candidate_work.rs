//! Prospective work and bounded retained-evidence scans on real SQLite.
use super::*;

#[test]
fn duplicate_begin_and_reserve_close_the_actual_deferred_transaction_before_success() {
    for reserve in [false, true] {
        for acknowledge in [false, true] {
            let (path, mut s, hook, r, w) = fixture(&format!(
                "candidate-duplicate-barrier-{reserve}-{acknowledge}"
            ));
            s.mirror_candidate_begin(&r, &w).unwrap();
            s.mirror_candidate_reserve(&r, 0, 4, &w).unwrap();
            let original = originals(&s);
            let before = ledger(&s);
            s.defer_durability(true).unwrap();
            sql(&s, Stmt::new("UPDATE mi_part SET body=x'01020304'", vec![]));
            assert_eq!(
                read(&s, "SELECT body FROM mi_part"),
                vec![SqlValue::Blob(vec![1, 2, 3, 4])]
            );
            let barriers = hook.borrow().barrier_calls;
            if acknowledge {
                if reserve {
                    s.mirror_candidate_reserve(&r, 0, 4, &w).unwrap();
                } else {
                    s.mirror_candidate_begin(&r, &w).unwrap();
                }
                assert_eq!(hook.borrow().barrier_calls, barriers + 1);
            } else {
                assert_eq!(hook.borrow().barrier_calls, barriers);
            }
            let after = ledger(&s);
            assert_eq!(originals(&s), original);
            assert_eq!(w.used().unwrap(), 0);
            // A clean SqliteIndex drop itself commits a window. Use its actual
            // unclean-close seam so that only the acknowledgment can commit it.
            hook.borrow_mut().close_unclean = true;
            drop(s);
            let reopened = open(&path, &hook);
            assert_eq!(ledger(&reopened), if acknowledge { after } else { before });
            assert_eq!(
                read(&reopened, "SELECT body FROM mi_part"),
                if acknowledge {
                    vec![SqlValue::Blob(vec![1, 2, 3, 4])]
                } else {
                    vec![SqlValue::Null]
                }
            );
            assert_eq!(originals(&reopened), original);
            assert_eq!(Fence::load(&reopened).unwrap(), Some(r.fence));
        }
    }
}

#[test]
fn duplicate_candidate_barrier_errors_are_fixed_refusals_with_closed_reopen() {
    use mdbn_store_file::testing::replica::mirror_admission::candidate::StorageRefusal;
    for reserve in [false, true] {
        for after in [false, true] {
            for (kind, expected) in [
                (IndexErrorKind::Full, StorageRefusal::Full),
                (IndexErrorKind::Corrupt, StorageRefusal::Corrupt),
                (IndexErrorKind::Other, StorageRefusal::Io),
            ] {
                let (path, mut s, hook, r, w) = fixture(&format!(
                    "candidate-duplicate-fault-{reserve}-{after}-{kind:?}"
                ));
                s.mirror_candidate_begin(&r, &w).unwrap();
                s.mirror_candidate_reserve(&r, 0, 4, &w).unwrap();
                let saved = ledger(&s);
                let original = originals(&s);
                s.defer_durability(true).unwrap();
                hook.borrow_mut().barrier_failure = Some((
                    IndexError::new(kind, "x".repeat(256 * 1024)),
                    w.clone(),
                    after,
                ));
                let mut result = None;
                let measured = allocation_counter::measure(|| {
                    result = Some(if reserve {
                        s.mirror_candidate_reserve(&r, 0, 4, &w)
                    } else {
                        s.mirror_candidate_begin(&r, &w)
                    });
                });
                assert_eq!(result.unwrap(), Err(Error::Storage(expected)));
                assert!(hook.borrow().barrier_failure.is_none());
                assert!(
                    measured.bytes_total < 256 * 1024,
                    "no diagnostic formatting"
                );
                assert_eq!(w.used().unwrap(), 0);
                drop(s);
                let reopened = open(&path, &hook);
                assert_eq!(ledger(&reopened), saved);
                assert_eq!(originals(&reopened), original);
                assert_eq!(Fence::load(&reopened).unwrap(), Some(r.fence));
            }
        }
    }
}

#[test]
fn every_candidate_query_failure_uses_fixed_categories_without_diagnostic_copy() {
    use mdbn_store_file::testing::replica::mirror_admission::candidate::StorageRefusal;
    let queries = [
        ("SELECT EXISTS", 0),
        (
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='mi_candidate'",
            0,
        ),
        ("SELECT CASE WHEN length(binding)", 0),
        ("SELECT CASE WHEN typeof(bound)", 0),
        (
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='mi_candidate'",
            1,
        ),
        (
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='mi_part'",
            0,
        ),
        ("SELECT CASE WHEN typeof(id)", 0),
    ];
    for (stage, (prefix, skip)) in queries.into_iter().enumerate() {
        for (kind, expected) in [
            (IndexErrorKind::Full, StorageRefusal::Full),
            (IndexErrorKind::Corrupt, StorageRefusal::Corrupt),
            (IndexErrorKind::Other, StorageRefusal::Io),
        ] {
            let mut baseline = None;
            for diagnostic_bytes in [1, 256 * 1024] {
                let (path, mut s, hook, r, w) = fixture(&format!(
                    "candidate-query-error-{stage}-{kind:?}-{diagnostic_bytes}"
                ));
                s.mirror_candidate_begin(&r, &w).unwrap();
                s.mirror_candidate_reserve(&r, 0, 4, &w).unwrap();
                let saved = ledger(&s);
                let original = originals(&s);
                // Evidence reads churn the randomized native statement cache.
                // Warm the candidate queries via successful, idempotent operations
                // before comparing independent connections: cache growth during a
                // successful query is unrelated to diagnostic retention. No other
                // index calls may occur between this warmup and measurement.
                s.mirror_candidate_begin(&r, &w).unwrap();
                s.mirror_candidate_reserve(&r, 0, 4, &w).unwrap();
                assert_eq!(w.used().unwrap(), 0);
                let input = body(&w, b"body");
                hook.borrow_mut().query_failure = Some(QueryFailure {
                    prefix,
                    skip,
                    error: IndexError::new(kind, "x".repeat(diagnostic_bytes)),
                    working: w.clone(),
                    input_bytes: input.capacity() as u64,
                });
                let mut result = None;
                let measured = allocation_counter::measure(|| {
                    result = Some(s.mirror_candidate_write(&r, 0, input, &w));
                });
                let result = result.unwrap();
                assert_eq!(result, Err(Error::Storage(expected)));
                assert!(hook.borrow().query_failure.is_none(), "query fault reached");
                let allocations = (measured.count_total, measured.bytes_total);
                if let Some(baseline) = baseline {
                    assert_eq!(allocations, baseline, "diagnostics never formatted/copied");
                } else {
                    baseline = Some(allocations);
                }
                assert_eq!(ledger(&s), saved);
                assert_eq!(originals(&s), original);
                assert_eq!(w.used().unwrap(), 0);
                drop(s);
                let reopened = open(&path, &hook);
                assert_eq!(ledger(&reopened), saved);
                assert_eq!(originals(&reopened), original);
                assert_eq!(Fence::load(&reopened).unwrap(), Some(r.fence));
                drop(reopened);
                drop(w);
                let measured = allocation_counter::measure(|| {
                    assert_eq!(result.clone(), Err(Error::Storage(expected)));
                });
                assert_eq!(measured.count_total, 0);
            }
        }
    }
}

#[test]
fn work_refusal_mid_scan_never_returns_partial_usage_or_writes_a_candidate() {
    let (_, mut s, _, r, w) = fixture("candidate-mid-scan-refusal");
    s.mirror_candidate_begin(&r, &w).unwrap();
    sql(
        &s,
        Stmt::new(
            "WITH RECURSIVE n(i) AS(VALUES(0) UNION ALL SELECT i+1 FROM n WHERE i<127) INSERT INTO mi_candidate(id,binding,charge) SELECT CAST(printf('%032x',i) AS BLOB),x'00',1024 FROM n",
            vec![],
        ),
    );
    let saved = ledger(&s);
    let original = originals(&s);
    let available = 16 * 64 * 1024 + 64 * 4096 + 64 * 1024;
    w.precharge(install_budget::Work {
        pass_bytes: install_budget::MAX_PASS_BYTES - w.work_used().unwrap().pass_bytes - available,
        ..install_budget::Work::default()
    })
    .unwrap();
    let mut request = r.clone();
    request.candidate = [7; 16];
    assert_eq!(
        s.mirror_candidate_begin(&request, &w),
        Err(Error::Budget(install_budget::Error::PassBytes))
    );
    assert_eq!(
        w.work_used().unwrap().pass_bytes,
        install_budget::MAX_PASS_BYTES
    );
    assert_eq!(
        w.reserve(0).unwrap_err(),
        install_budget::Error::WorkExhausted
    );
    assert_eq!(ledger(&s), saved);
    assert_eq!(originals(&s), original);
    assert_eq!(w.used().unwrap(), 0);
}

#[test]
fn invalid_charges_cannot_be_ignored_by_bounded_sum_or_repaired() {
    for race in [false, true] {
        let (_, mut s, hook, r, w) = fixture(&format!("candidate-charge-shape-{race}"));
        s.mirror_candidate_begin(&r, &w).unwrap();
        s.mirror_candidate_reserve(&r, 0, 4, &w).unwrap();
        sql(&s, Stmt::new("PRAGMA ignore_check_constraints=ON", vec![]));
        let change = Stmt::new("UPDATE mi_part SET charge=0", vec![]);
        if race {
            hook.borrow_mut().before = Some(change);
        } else {
            sql(&s, change);
        }
        let original = originals(&s);
        assert_eq!(s.mirror_candidate_write(&r,0,body(&w,b"body"),&w),Err(Error::Storage(mdbn_store_file::testing::replica::mirror_admission::candidate::StorageRefusal::Corrupt)));
        assert_eq!(
            read(&s, "SELECT charge,body FROM mi_part"),
            vec![SqlValue::Integer(0), SqlValue::Null]
        );
        assert_eq!(originals(&s), original);
        assert_eq!(w.used().unwrap(), 0);
    }
}

#[test]
fn shared_work_refusal_precedes_all_candidate_index_calls_and_never_resets() {
    for operation in 0..3 {
        let (_, mut s, hook, r, w) = fixture(&format!("candidate-work-{operation}"));
        s.mirror_candidate_begin(&r, &w).unwrap();
        s.mirror_candidate_reserve(&r, 0, 4, &w).unwrap();
        let mut input = Some(body(&w, b"body"));
        let saved = ledger(&s);
        let original = originals(&s);
        let calls = hook.borrow().calls;
        w.precharge(install_budget::Work {
            pass_bytes: install_budget::MAX_PASS_BYTES - w.work_used().unwrap().pass_bytes,
            ..install_budget::Work::default()
        })
        .unwrap();
        let work = w.work_used().unwrap();
        let result = match operation {
            0 => s.mirror_candidate_begin(&r, &w),
            1 => s.mirror_candidate_reserve(&r, 1, 4, &w),
            _ => s.mirror_candidate_write(&r, 0, input.take().unwrap(), &w),
        };
        assert_eq!(result, Err(Error::Budget(install_budget::Error::PassBytes)));
        assert_eq!(hook.borrow().calls, calls);
        assert_eq!(w.work_used().unwrap(), work);
        assert_eq!(
            w.reserve(0).unwrap_err(),
            install_budget::Error::WorkExhausted
        );
        assert_eq!(
            s.mirror_candidate_begin(&r, &w),
            Err(Error::Budget(install_budget::Error::WorkExhausted))
        );
        assert_eq!(ledger(&s), saved);
        assert_eq!(originals(&s), original);
        drop(input);
        assert_eq!(w.used().unwrap(), 0);
    }
}

#[test]
fn bounded_atomic_quota_guard_detects_growth_without_ignoring_new_rows() {
    let (_, mut s, hook, r, w) = fixture("candidate-bounded-growth");
    s.mirror_candidate_begin(&r, &w).unwrap();
    s.mirror_candidate_reserve(&r, 0, 4, &w).unwrap();
    let original = originals(&s);
    hook.borrow_mut().before = Some(Stmt::new(
        "INSERT INTO mi_part(candidate,ordinal,bound,charge) VALUES(x'00',0,1,129)",
        vec![],
    ));
    assert_eq!(
        s.mirror_candidate_write(&r, 0, body(&w, b"body"), &w),
        Err(Error::Conflict)
    );
    assert_eq!(
        read(&s, "SELECT body FROM mi_part WHERE candidate<>x'00'"),
        vec![SqlValue::Null]
    );
    assert_eq!(
        read(&s, "SELECT charge,body FROM mi_part WHERE candidate=x'00'"),
        vec![SqlValue::Integer(129), SqlValue::Null]
    );
    assert_eq!(originals(&s), original);
    assert_eq!(w.used().unwrap(), 0);
}

#[test]
fn quota_scan_refuses_oversized_keys_and_orphan_tables_without_partial_usage_or_cleanup() {
    for orphan in [false, true] {
        let (_, mut s, _, r, w) = fixture(&format!("candidate-quota-shape-{orphan}"));
        s.mirror_candidate_begin(&r, &w).unwrap();
        if orphan {
            sql(&s, Stmt::new("DROP TABLE mi_candidate", vec![]));
        } else {
            sql(
                &s,
                Stmt::new(
                    "INSERT INTO mi_candidate(id,binding,charge) VALUES(?,x'00',1024)",
                    vec![SqlValue::Blob(vec![3; 1025])],
                ),
            );
        }
        let original = originals(&s);
        let retained = read(&s, "SELECT * FROM mi_part");
        let mut request = r.clone();
        request.candidate = [7; 16];
        let refusal = s.mirror_candidate_begin(&request, &w);
        if orphan {
            assert_eq!(refusal, Err(Error::Unsupported));
        } else {
            assert_eq!(refusal,Err(Error::Storage(mdbn_store_file::testing::replica::mirror_admission::candidate::StorageRefusal::Corrupt)));
        }
        assert_eq!(read(&s, "SELECT * FROM mi_part"), retained);
        assert_eq!(originals(&s), original);
        if !orphan {
            assert_eq!(
                read(&s, "SELECT count(*) FROM mi_candidate"),
                vec![SqlValue::Integer(2)]
            );
        }
        assert_eq!(w.used().unwrap(), 0);
    }
}
