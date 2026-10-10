use super::*;
fn small_row() -> BasesProjectedRow {
    BasesProjectedRow {
        sort: vec![RuntimeValue::Number(1.0)],
        group: None,
        cells: (0..12)
            .map(|_| BasesDisplayCell::Value(RuntimeValue::Null))
            .collect(),
    }
}
#[test]
fn fifty_thousand_discarded_scratch_rows_keep_cumulative_source_work_and_output() {
    let mut ledger = IncrementalBasesBudget::new();
    for _ in 0..50_000 {
        let row = ledger
            .row(1024, |scratch| {
                assert!(scratch.charge(100, 80_000));
                Ok(Some(small_row()))
            })
            .unwrap()
            .unwrap();
        assert_eq!(row.cells.len(), 12);
    }
    assert_eq!(ledger.rows, 50_000);
    assert_eq!(ledger.source, 50_000 * 1024);
    assert_eq!(ledger.steps, 50_000 * (100 + 14));
    assert_eq!(ledger.output, 50_000 * (128 + 128 + 12 * 128));
}
#[test]
fn request_admission_shares_work_without_source_rows_and_ignored_failure_stays_sticky() {
    let mut ledger = IncrementalBasesBudget::new();
    ledger
        .admit(|scratch| {
            assert!(scratch.charge(123, 456));
            Ok(())
        })
        .unwrap();
    assert_eq!(
        (ledger.steps, ledger.rows, ledger.source, ledger.output),
        (123, 0, 0, 0)
    );
    let failure = ledger
        .admit(|scratch| {
            assert!(!scratch.charge(1, (1 << 20) + 1));
            Ok(())
        })
        .unwrap_err();
    assert_eq!(ledger.admit(|_| Ok(())).unwrap_err(), failure);
    assert_eq!(ledger.row(1, |_| Ok(None)).err().unwrap(), failure);
    let mut ledger = IncrementalBasesBudget::new();
    assert_eq!(
        ledger
            .admit(|scratch| {
                scratch.fail(EvaluationFailure::Cancelled);
                Ok(())
            })
            .unwrap_err(),
        EvaluationFailure::Cancelled
    );
    assert_eq!(ledger.failure(), Some(EvaluationFailure::Cancelled));
}

#[test]
fn individual_scratch_ceiling_is_unchanged_and_failure_poisoned() {
    let mut ledger = IncrementalBasesBudget::new();
    let failure = ledger
        .row(10, |scratch| {
            assert!(!scratch.charge(1, (1 << 20) + 1));
            Ok(None)
        })
        .err()
        .unwrap();
    assert_eq!(
        failure,
        EvaluationFailure::BudgetExceeded("allocation_estimate")
    );
    assert_eq!(
        ledger
            .row(0, |_| panic!("failed ledger ran callback"))
            .err(),
        Some(failure)
    );
}
#[test]
fn global_work_is_not_reset_with_row_scratch() {
    let mut ledger = IncrementalBasesBudget::new();
    for _ in 0..32 {
        ledger
            .row(1, |scratch| {
                assert!(scratch.charge(2_000_000, 0));
                Ok(None)
            })
            .unwrap();
    }
    assert_eq!(ledger.steps, MAX_INCREMENTAL_STEPS);
    assert_eq!(
        ledger
            .row(1, |scratch| {
                scratch.charge(1, 0);
                Ok(None)
            })
            .err(),
        Some(EvaluationFailure::BudgetExceeded("work"))
    );
}
#[test]
fn oversized_source_refuses_before_loading_and_aggregate_source_stays_bounded() {
    let mut ledger = IncrementalBasesBudget::new();
    assert_eq!(
        ledger
            .row((1 << 20) + 1, |_| panic!("preflight failed"))
            .err(),
        Some(EvaluationFailure::BudgetExceeded("incremental_source"))
    );
    let mut ledger = IncrementalBasesBudget::new();
    for _ in 0..1024 {
        ledger.row(1 << 20, |_| Ok(None)).unwrap();
    }
    assert_eq!(
        ledger
            .row(1, |_| panic!("aggregate preflight failed"))
            .err(),
        Some(EvaluationFailure::BudgetExceeded("incremental_source"))
    );
}
#[test]
fn output_is_cumulative_not_a_per_row_allowance() {
    let mut ledger = IncrementalBasesBudget::new();
    for _ in 0..1000 {
        let result = ledger.row(1, |_| {
            Ok(Some(BasesProjectedRow {
                sort: vec![],
                group: None,
                cells: (0..64)
                    .map(|_| BasesDisplayCell::Value(RuntimeValue::String("x".repeat(4096))))
                    .collect(),
            }))
        });
        if let Err(failure) = result {
            assert_eq!(
                failure,
                EvaluationFailure::BudgetExceeded("incremental_output")
            );
            assert!(ledger.output <= MAX_INCREMENTAL_OUTPUT_BYTES);
            return;
        }
    }
    panic!("output ledger failed to enforce cumulative bound");
}
#[test]
fn cancelled_and_unfinished_scopes_cannot_resume() {
    let mut ledger = IncrementalBasesBudget::new();
    assert_eq!(
        ledger.row(1, |_| Err(EvaluationFailure::Cancelled)).err(),
        Some(EvaluationFailure::Cancelled)
    );
    assert_eq!(
        ledger.row(1, |_| panic!("cancelled callback ran")).err(),
        Some(EvaluationFailure::Cancelled)
    );
    let mut ledger = IncrementalBasesBudget::new();
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        ledger.row(1, |_| panic!("abandoned"))
    }));
    assert_eq!(
        ledger.row(1, |_| panic!("unfinished callback ran")).err(),
        Some(EvaluationFailure::BudgetExceeded(
            "incremental_scratch_unfinished"
        ))
    );
}
