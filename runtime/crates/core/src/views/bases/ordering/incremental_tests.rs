use super::super::{
    IncrementalBasesBudget, MAX_INCREMENTAL_OUTPUT_BYTES, MAX_INCREMENTAL_ROWS, MAX_WORK_STEPS,
};
use super::*;
fn capture() -> OrderingCapture {
    OrderingCapture {
        nulls: NullOrder::Last,
        strings: StringOrder::Utf16,
    }
}
fn typed(rows: &[Vec<RuntimeValue>]) -> Vec<TypedSortRow<'_>> {
    rows.iter().map(|row| TypedSortRow { keys: row }).collect()
}

#[test]
fn fifty_thousand_typed_rows_sort_stably_without_lifting_legacy_limits() {
    let values: Vec<_> = (0..50_000)
        .map(|i| {
            vec![
                RuntimeValue::Number(f64::from(i % 271)),
                RuntimeValue::String(format!("{:04}", i % 29)),
            ]
        })
        .collect();
    let rows = typed(&values);
    let directions = [SortDirection::Asc, SortDirection::Desc];
    let result = order_incremental_typed_rows(
        &rows,
        &directions,
        capture(),
        &mut IncrementalBasesBudget::new(),
    )
    .unwrap();
    assert_eq!(result.len(), 50_000);
    let mut permutation = result.clone();
    permutation.sort_unstable();
    assert_eq!(permutation, (0..50_000).collect::<Vec<_>>());
    for pair in result.windows(2) {
        let a = &values[pair[0]];
        let b = &values[pair[1]];
        let key = compare_typed(&a[0], &b[0], capture(), &mut WorkBudget::new())
            .unwrap()
            .then_with(|| {
                compare_typed(&a[1], &b[1], capture(), &mut WorkBudget::new())
                    .unwrap()
                    .reverse()
            });
        assert_ne!(key, Ordering::Greater);
        if key == Ordering::Equal {
            assert!(pair[0] < pair[1]);
        }
    }
    assert_eq!(
        order_typed_rows(&rows, &directions, capture(), &mut WorkBudget::new()).unwrap_err(),
        EvaluationFailure::BudgetExceeded("ordering_shape")
    );
    assert_eq!(MAX_ORDERED_ROWS, 10_000);
    assert_eq!(MAX_WORK_STEPS, 2_000_000);
}
#[test]
fn exact_order_matches_frozen_comparator_for_small_null_and_direction_fixtures() {
    let values: Vec<_> = (0..300)
        .map(|i| {
            vec![
                if i % 5 == 0 {
                    RuntimeValue::Null
                } else {
                    RuntimeValue::Number(f64::from(i % 13))
                },
                RuntimeValue::String(format!("{:04}", i % 17)),
            ]
        })
        .collect();
    let rows = typed(&values);
    for directions in [
        [SortDirection::Asc, SortDirection::Desc],
        [SortDirection::Desc, SortDirection::Asc],
    ] {
        assert_eq!(
            order_typed_rows(&rows, &directions, capture(), &mut WorkBudget::new()).unwrap(),
            order_incremental_typed_rows(
                &rows,
                &directions,
                capture(),
                &mut IncrementalBasesBudget::new()
            )
            .unwrap()
        );
    }
}
#[test]
fn inventory_boundary_and_incomplete_or_mixed_keys_fail_stickily() {
    let rows: Vec<_> = (0..MAX_INCREMENTAL_ROWS)
        .map(|_| TypedSortRow { keys: &[] })
        .collect();
    assert_eq!(
        order_incremental_typed_rows(&rows, &[], capture(), &mut IncrementalBasesBudget::new())
            .unwrap()
            .len(),
        MAX_INCREMENTAL_ROWS as usize
    );
    let rows: Vec<_> = (0..=MAX_INCREMENTAL_ROWS)
        .map(|_| TypedSortRow { keys: &[] })
        .collect();
    let mut budget = IncrementalBasesBudget::new();
    let error = order_incremental_typed_rows(&rows, &[], capture(), &mut budget).unwrap_err();
    assert_eq!(error, EvaluationFailure::BudgetExceeded("ordering_shape"));
    assert_eq!(
        order_incremental_typed_rows(&[], &[], capture(), &mut budget).unwrap_err(),
        error
    );
    let values = vec![vec![RuntimeValue::Number(1.0)], vec![]];
    let mut budget = IncrementalBasesBudget::new();
    assert_eq!(
        order_incremental_typed_rows(
            &typed(&values),
            &[SortDirection::Asc],
            capture(),
            &mut budget
        )
        .unwrap_err(),
        EvaluationFailure::MetadataUnavailable("sort_keys_incomplete")
    );
    let values = vec![
        vec![RuntimeValue::Number(1.0)],
        vec![RuntimeValue::String("1".into())],
    ];
    let mut budget = IncrementalBasesBudget::new();
    assert_eq!(
        order_incremental_typed_rows(
            &typed(&values),
            &[SortDirection::Asc],
            capture(),
            &mut budget
        )
        .unwrap_err(),
        EvaluationFailure::UnsupportedConstruct("mixed_ordering_types")
    );
}
#[test]
fn row_and_helper_work_share_one_aggregate_ledger_without_reset_or_refund() {
    let mut budget = IncrementalBasesBudget::new();
    for _ in 0..32 {
        budget
            .row(1, |scratch| {
                assert!(scratch.charge(MAX_WORK_STEPS, 0));
                Ok(None)
            })
            .unwrap();
    }
    assert_eq!(
        order_incremental_typed_rows(&[], &[], capture(), &mut budget).unwrap_err(),
        EvaluationFailure::BudgetExceeded("work")
    );
    assert_eq!(
        budget.row(0, |_| Ok(None)).err().unwrap(),
        EvaluationFailure::BudgetExceeded("work")
    );
}
#[test]
fn fifty_thousand_scalar_groups_keep_exact_types_signed_zero_and_encounter_order() {
    let sample = [
        RuntimeValue::Null,
        RuntimeValue::Number(-0.0),
        RuntimeValue::Number(0.0),
        RuntimeValue::String("0".into()),
        RuntimeValue::Bool(false),
        RuntimeValue::Number(1.0),
        RuntimeValue::String("open".into()),
        RuntimeValue::String("done".into()),
    ];
    let values: Vec<_> = (0..50_000)
        .map(|i| sample[i % sample.len()].clone())
        .collect();
    let groups = partition_incremental_typed(
        &values,
        DateGroupMode::Unavailable,
        &mut IncrementalBasesBudget::new(),
    )
    .unwrap();
    assert_eq!(groups.len(), 7);
    assert_eq!(groups.iter().map(|g| g.rows.len()).sum::<usize>(), 50_000);
    assert!(matches!(groups[0].key, RuntimeValue::Null));
    assert!(matches!(groups[1].key,RuntimeValue::Number(value) if *value==0.0));
    assert!(matches!(groups[2].key,RuntimeValue::String(value) if value=="0"));
    assert!(matches!(groups[3].key, RuntimeValue::Bool(false)));
    for group in &groups {
        assert!(group.rows.windows(2).all(|pair| pair[0] < pair[1]));
    }
    let frozen = partition_typed(
        &values[..300],
        DateGroupMode::Unavailable,
        &mut WorkBudget::new(),
    )
    .unwrap();
    let incremental = partition_incremental_typed(
        &values[..300],
        DateGroupMode::Unavailable,
        &mut IncrementalBasesBudget::new(),
    )
    .unwrap();
    for (a, b) in frozen.iter().zip(&incremental) {
        assert_eq!(a.key, b.key);
        assert_eq!(a.rows, b.rows);
    }
    assert_eq!(
        partition_typed(&values, DateGroupMode::Unavailable, &mut WorkBudget::new())
            .err()
            .unwrap(),
        EvaluationFailure::BudgetExceeded("group_rows")
    );
}
#[test]
fn borrowed_staged_group_keys_match_owned_scalar_groups_without_key_clones() {
    let values = [
        RuntimeValue::Null,
        RuntimeValue::Number(-0.0),
        RuntimeValue::String("0".into()),
        RuntimeValue::Number(0.0),
    ];
    let refs = values.iter().collect::<Vec<_>>();
    let owned = partition_incremental_typed(
        &values,
        DateGroupMode::Unavailable,
        &mut IncrementalBasesBudget::new(),
    )
    .unwrap();
    let borrowed = partition_incremental_typed_refs(
        &refs,
        DateGroupMode::Unavailable,
        &mut IncrementalBasesBudget::new(),
    )
    .unwrap();
    assert_eq!(owned.len(), borrowed.len());
    for (a, b) in owned.iter().zip(&borrowed) {
        assert_eq!(a.key, b.key);
        assert_eq!(a.rows, b.rows);
    }
}

#[test]
fn grouping_limits_and_structured_keys_suppress_all_buckets() {
    let values: Vec<_> = (0..=MAX_TYPED_GROUPS)
        .map(|i| RuntimeValue::Number(i as f64))
        .collect();
    let mut budget = IncrementalBasesBudget::new();
    assert_eq!(
        partition_incremental_typed(&values, DateGroupMode::Unavailable, &mut budget)
            .err()
            .unwrap(),
        EvaluationFailure::BudgetExceeded("typed_groups")
    );
    assert_eq!(
        partition_incremental_typed(&[], DateGroupMode::Unavailable, &mut budget)
            .err()
            .unwrap(),
        EvaluationFailure::BudgetExceeded("typed_groups")
    );
    let values = vec![RuntimeValue::Null, RuntimeValue::List(vec![])];
    let mut budget = IncrementalBasesBudget::new();
    assert_eq!(
        partition_incremental_typed(&values, DateGroupMode::Unavailable, &mut budget)
            .err()
            .unwrap(),
        EvaluationFailure::UnsupportedConstruct("typed_ordering_value")
    );
    assert_eq!(MAX_TYPED_GROUPS, 4096);
}

#[test]
fn retained_ownership_shares_output_cap_and_poisoned_helpers_never_revive() {
    let mut budget = IncrementalBasesBudget::new();
    budget.retain(MAX_INCREMENTAL_OUTPUT_BYTES).unwrap();
    let values = vec![vec![]];
    assert_eq!(
        order_incremental_typed_rows(&typed(&values), &[], capture(), &mut budget).unwrap_err(),
        EvaluationFailure::BudgetExceeded("incremental_output")
    );
    assert_eq!(
        budget.retain(0).unwrap_err(),
        EvaluationFailure::BudgetExceeded("incremental_output")
    );
    let mut budget = IncrementalBasesBudget::new();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = budget.helper::<()>(|_| panic!("owned synthetic helper"));
    }));
    assert!(result.is_err());
    assert_eq!(
        budget.retain(0).unwrap_err(),
        EvaluationFailure::BudgetExceeded("incremental_scratch_unfinished")
    );
}
