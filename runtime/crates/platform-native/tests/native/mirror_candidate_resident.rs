//! Real resident candidate DATA reads, not authenticated install authority.
use super::*;
use mdbn_store_file::testing::replica::mirror_admission::candidate::StorageRefusal;
use mdbn_store_file::testing::wire::hash::sha256;

fn filled(
    name: &str,
    bytes: &[u8],
) -> (PathBuf, Ledger, Rc<RefCell<Injection>>, Request, WorkingSet) {
    let (path, mut s, hook, r, w) = fixture(name);
    s.mirror_candidate_begin(&r, &w).unwrap();
    s.mirror_candidate_reserve(&r, 0, bytes.len() as u64, &w)
        .unwrap();
    s.mirror_candidate_write(&r, 0, body(&w, bytes), &w)
        .unwrap();
    (path, s, hook, r, w)
}

#[test]
fn resident_bytes_share_the_account_and_outlive_only_their_own_charge() {
    for length in [4, 4096, MAX_PART_BYTES as usize] {
        let payload = vec![23; length];
        let (path, mut s, hook, r, w) = filled(&format!("resident-success-{length}"), &payload);
        let saved = ledger(&s);
        let original = originals(&s);
        hook.borrow_mut().resident_live = Some((w.clone(), length as u64));
        let work = w.work_used().unwrap();
        let output = s
            .mirror_candidate_read(&r, 0, &sha256(&payload), &w)
            .unwrap();
        assert_eq!(output.as_slice(), payload);
        assert_eq!(output.capacity(), length);
        assert!(w.owns_buffer(&output));
        assert_eq!(w.used().unwrap(), length as u64);
        assert_eq!(
            w.work_used().unwrap().pass_bytes - work.pass_bytes,
            16 * 64 * 1024 + 16 * length as u64 + 64 * 1024
        );
        assert_eq!(ledger(&s), saved);
        assert_eq!(originals(&s), original);
        drop(s);
        let reopened = open(&path, &hook);
        assert_eq!(ledger(&reopened), saved);
        assert_eq!(originals(&reopened), original);
        assert_eq!(Fence::load(&reopened).unwrap(), Some(r.fence));
        drop(reopened);
        let account = w.clone();
        drop(w);
        assert_eq!(output.as_slice(), payload);
        assert_eq!(account.used().unwrap(), length as u64);
        drop(output);
        assert_eq!(account.used().unwrap(), 0);
    }
}

#[test]
fn resident_control_and_work_refusals_precede_all_index_calls_and_allocate_nothing() {
    for work in [false, true] {
        let (_, mut s, hook, r, w) = filled(&format!("resident-zero-io-{work}"), b"body");
        let saved = ledger(&s);
        let original = originals(&s);
        let held = if work {
            w.precharge(install_budget::Work {
                pass_bytes: install_budget::MAX_PASS_BYTES - w.work_used().unwrap().pass_bytes,
                ..install_budget::Work::default()
            })
            .unwrap();
            None
        } else {
            Some(
                w.reserve(install_budget::MAX_WORKING_BYTES - 64 * 1024 + 1)
                    .unwrap(),
            )
        };
        let calls = hook.borrow().calls;
        let address = sha256(b"body");
        let mut result = None;
        let measured = allocation_counter::measure(|| {
            result = Some(s.mirror_candidate_read(&r, 0, &address, &w));
        });
        assert_eq!(measured.count_total, 0);
        assert_eq!(
            result.unwrap().unwrap_err(),
            Error::Budget(if work {
                install_budget::Error::PassBytes
            } else {
                install_budget::Error::WorkingSet
            })
        );
        assert_eq!(hook.borrow().calls, calls);
        assert_eq!(ledger(&s), saved);
        assert_eq!(originals(&s), original);
        drop(held);
        assert_eq!(w.used().unwrap(), 0);
        if work {
            assert_eq!(
                w.reserve(0).unwrap_err(),
                install_budget::Error::WorkExhausted
            );
        }
    }
}

#[test]
fn resident_exact_and_one_over_memory_and_work_never_return_partial_bytes() {
    for memory in [false, true] {
        for over in [false, true] {
            let (_, mut s, hook, r, w) =
                filled(&format!("resident-boundary-{memory}-{over}"), b"body");
            let saved = ledger(&s);
            let original = originals(&s);
            let held = if memory {
                Some(
                    w.reserve(
                        install_budget::MAX_WORKING_BYTES - (64 * 1024 + 3 * 4 + 4096)
                            + u64::from(over),
                    )
                    .unwrap(),
                )
            } else {
                let required = 16 * 64 * 1024 + 16 * 4 + 64 * 1024;
                w.precharge(install_budget::Work {
                    pass_bytes: install_budget::MAX_PASS_BYTES
                        - w.work_used().unwrap().pass_bytes
                        - required
                        + u64::from(over),
                    ..install_budget::Work::default()
                })
                .unwrap();
                None
            };
            let result = s.mirror_candidate_read(&r, 0, &sha256(b"body"), &w);
            if over {
                assert_eq!(
                    result.unwrap_err(),
                    Error::Budget(if memory {
                        install_budget::Error::WorkingSet
                    } else {
                        install_budget::Error::PassBytes
                    })
                );
                assert_eq!(
                    hook.borrow().resident_calls,
                    0,
                    "refused before the body query"
                );
            } else {
                let output = result.unwrap();
                assert_eq!(output.as_slice(), b"body");
                assert_eq!(hook.borrow().resident_calls, 1);
                drop(output);
            }
            assert_eq!(ledger(&s), saved);
            assert_eq!(originals(&s), original);
            drop(held);
            assert_eq!(w.used().unwrap(), 0);
        }
    }
}

#[test]
fn resident_missing_unfilled_and_wrong_address_are_not_success_or_trusted_absence() {
    for shape in 0..3 {
        let (_, mut s, _, r, w) = fixture(&format!("resident-unavailable-{shape}"));
        s.mirror_candidate_begin(&r, &w).unwrap();
        if shape != 0 {
            s.mirror_candidate_reserve(&r, 0, 4, &w).unwrap();
        }
        if shape == 2 {
            s.mirror_candidate_write(&r, 0, body(&w, b"body"), &w)
                .unwrap();
        }
        let saved = ledger(&s);
        let original = originals(&s);
        assert_eq!(
            s.mirror_candidate_read(&r, 0, &sha256(b"wrong"), &w)
                .unwrap_err(),
            Error::Conflict
        );
        assert_eq!(ledger(&s), saved);
        assert_eq!(originals(&s), original);
        assert_eq!(w.used().unwrap(), 0);
    }
}

#[test]
fn resident_invalid_shapes_are_refused_before_an_unbounded_body_copy_or_cleanup() {
    for statement in [
        "UPDATE mi_part SET body=CAST(x'626f6479' AS TEXT)",
        "UPDATE mi_part SET body=x''",
        "UPDATE mi_part SET body=zeroblob(65536)",
        "UPDATE mi_part SET bound=4194305",
        "UPDATE mi_part SET charge=0",
    ] {
        let (_, mut s, hook, r, w) = filled("resident-invalid-shape", b"body");
        sql(&s, Stmt::new("PRAGMA ignore_check_constraints=ON", vec![]));
        sql(&s, Stmt::new(statement, vec![]));
        let saved = ledger(&s);
        let original = originals(&s);
        let address = sha256(b"body");
        let mut result = None;
        let measured = allocation_counter::measure(|| {
            result = Some(s.mirror_candidate_read(&r, 0, &address, &w));
        });
        assert_eq!(
            result.unwrap().unwrap_err(),
            Error::Storage(StorageRefusal::Corrupt)
        );
        assert!(
            measured.bytes_total < 65536,
            "no oversized body copied into Rust"
        );
        assert_eq!(hook.borrow().resident_calls, 0);
        assert_eq!(ledger(&s), saved);
        assert_eq!(originals(&s), original);
        assert_eq!(w.used().unwrap(), 0);
    }
}

#[test]
fn resident_query_faults_keep_live_allowances_fixed_errors_and_original_evidence() {
    for stage in 0..3 {
        for (kind, expected) in [
            (IndexErrorKind::Full, StorageRefusal::Full),
            (IndexErrorKind::Corrupt, StorageRefusal::Corrupt),
            (IndexErrorKind::Other, StorageRefusal::Io),
        ] {
            let (path, mut s, hook, r, w) =
                filled(&format!("resident-query-fault-{stage}-{kind:?}"), b"body");
            let saved = ledger(&s);
            let original = originals(&s);
            hook.borrow_mut().resident_live = Some((w.clone(), 4));
            let error = IndexError::new(kind, "x".repeat(256 * 1024));
            if stage == 2 {
                hook.borrow_mut().resident_after = Some(error);
            } else {
                hook.borrow_mut().query_failure = Some(QueryFailure {
                    prefix: if stage == 0 {
                        "SELECT CASE WHEN typeof(bound)"
                    } else {
                        "SELECT CASE WHEN typeof(body)"
                    },
                    skip: 0,
                    error,
                    working: w.clone(),
                    input_bytes: if stage == 0 { 0 } else { 4 },
                });
            }
            let address = sha256(b"body");
            let mut result = None;
            let measured = allocation_counter::measure(|| {
                result = Some(s.mirror_candidate_read(&r, 0, &address, &w));
            });
            assert_eq!(result.unwrap().unwrap_err(), Error::Storage(expected));
            assert!(
                measured.bytes_total < 256 * 1024,
                "native diagnostic is not copied or formatted"
            );
            assert!(hook.borrow().query_failure.is_none());
            assert!(hook.borrow().resident_after.is_none());
            assert_eq!(w.used().unwrap(), 0);
            assert_eq!(ledger(&s), saved);
            assert_eq!(originals(&s), original);
            drop(s);
            let reopened = open(&path, &hook);
            assert_eq!(ledger(&reopened), saved);
            assert_eq!(originals(&reopened), original);
            assert_eq!(Fence::load(&reopened).unwrap(), Some(r.fence));
        }
    }
}

#[test]
fn resident_serialized_projection_rechecks_drift_and_growth_without_partial_success() {
    for drift in [false, true] {
        let (_, mut s, hook, r, w) = filled(&format!("resident-serialized-{drift}"), b"body");
        sql(&s, Stmt::new("PRAGMA ignore_check_constraints=ON", vec![]));
        hook.borrow_mut().resident_before = Some(Stmt::new(
            if drift {
                "DELETE FROM mi_candidate"
            } else {
                "UPDATE mi_part SET body=zeroblob(65536)"
            },
            vec![],
        ));
        let original = originals(&s);
        let result = s.mirror_candidate_read(&r, 0, &sha256(b"body"), &w);
        assert_eq!(
            result.unwrap_err(),
            if drift {
                Error::Conflict
            } else {
                Error::Storage(StorageRefusal::Corrupt)
            }
        );
        assert_eq!(originals(&s), original);
        assert_eq!(w.used().unwrap(), 0);
        if drift {
            assert!(read(&s, "SELECT * FROM mi_candidate").is_empty());
        } else {
            assert_eq!(
                read(&s, "SELECT length(body) FROM mi_part"),
                vec![SqlValue::Integer(65536)]
            );
        }
    }
}

#[test]
fn resident_success_barrier_closes_the_actual_deferred_window_before_delivery() {
    for acknowledge in [false, true] {
        let (path, mut s, hook, r, w) =
            filled(&format!("resident-read-barrier-{acknowledge}"), b"body");
        let original = originals(&s);
        assert!(s.index().borrow_mut().defer_sync(true).unwrap());
        sql(&s, Stmt::new("UPDATE mi_part SET body=x'6e657874'", vec![]));
        assert_eq!(
            read(&s, "SELECT body FROM mi_part"),
            vec![SqlValue::Blob(b"next".to_vec())]
        );
        let before = hook.borrow().barrier_calls;
        let output = if acknowledge {
            hook.borrow_mut().resident_live = Some((w.clone(), 4));
            let output = s
                .mirror_candidate_read(&r, 0, &sha256(b"next"), &w)
                .unwrap();
            assert_eq!(hook.borrow().barrier_calls, before + 1);
            assert_eq!(output.as_slice(), b"next");
            Some(output)
        } else {
            None
        };
        hook.borrow_mut().close_unclean = true;
        drop(s);
        let reopened = open(&path, &hook);
        assert_eq!(
            read(&reopened, "SELECT body FROM mi_part"),
            vec![SqlValue::Blob(
                if acknowledge { b"next" } else { b"body" }.to_vec()
            )]
        );
        assert_eq!(originals(&reopened), original);
        assert_eq!(Fence::load(&reopened).unwrap(), Some(r.fence));
        drop(output);
        assert_eq!(w.used().unwrap(), 0);
    }
}

#[test]
fn resident_barrier_faults_return_no_body_with_full_live_charges_and_unclean_controls() {
    for after in [false, true] {
        let (path, mut s, hook, r, w) = filled(&format!("resident-barrier-fault-{after}"), b"body");
        let original = originals(&s);
        assert!(s.index().borrow_mut().defer_sync(true).unwrap());
        sql(&s, Stmt::new("UPDATE mi_part SET body=x'6e657874'", vec![]));
        hook.borrow_mut().resident_live = Some((w.clone(), 4));
        hook.borrow_mut().barrier_failure = Some((
            IndexError::new(IndexErrorKind::Other, "x".repeat(256 * 1024)),
            w.clone(),
            after,
        ));
        let address = sha256(b"next");
        let mut result = None;
        let measured = allocation_counter::measure(|| {
            result = Some(s.mirror_candidate_read(&r, 0, &address, &w));
        });
        assert_eq!(
            result.unwrap().unwrap_err(),
            Error::Storage(StorageRefusal::Io)
        );
        assert!(measured.bytes_total < 256 * 1024);
        assert!(hook.borrow().barrier_failure.is_none());
        assert_eq!(w.used().unwrap(), 0);
        assert_eq!(originals(&s), original);
        hook.borrow_mut().close_unclean = true;
        drop(s);
        let reopened = open(&path, &hook);
        assert_eq!(
            read(&reopened, "SELECT body FROM mi_part"),
            vec![SqlValue::Blob(
                if after { b"next" } else { b"body" }.to_vec()
            )]
        );
        assert_eq!(originals(&reopened), original);
        assert_eq!(Fence::load(&reopened).unwrap(), Some(r.fence));
    }
}
