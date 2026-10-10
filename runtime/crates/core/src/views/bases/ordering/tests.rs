use super::*;
use crate::views::bases::{BasesTimezone, DateValue, EvaluatedDate};
fn capture() -> OrderingCapture {
    OrderingCapture {
        nulls: NullOrder::Last,
        strings: StringOrder::Utf16,
    }
}
fn date(source: &str) -> RuntimeValue {
    let mut budget = WorkBudget::new();
    let zone = BasesTimezone::capture("UTC", &mut budget).unwrap();
    RuntimeValue::Date(
        EvaluatedDate::new(
            DateValue::parse(source, zone, &mut budget).unwrap(),
            &mut budget,
        )
        .unwrap(),
    )
}
#[test]
fn multilevel_sort_preserves_term_direction_and_stable_input_ties() {
    let keys = [
        vec![RuntimeValue::Number(1.0), RuntimeValue::Number(2.0)],
        vec![RuntimeValue::Number(0.0), RuntimeValue::Number(7.0)],
        vec![RuntimeValue::Number(1.0), RuntimeValue::Number(3.0)],
        vec![RuntimeValue::Number(1.0), RuntimeValue::Number(3.0)],
    ];
    let rows: Vec<_> = keys.iter().map(|keys| TypedSortRow { keys }).collect();
    let mut budget = WorkBudget::new();
    assert_eq!(
        order_typed_rows(
            &rows,
            &[SortDirection::Asc, SortDirection::Desc],
            capture(),
            &mut budget
        )
        .unwrap(),
        vec![1, 2, 3, 0]
    );
}
#[test]
fn null_placement_is_explicit_and_descending_reverses_comparison() {
    let mut budget = WorkBudget::new();
    assert_eq!(
        compare_typed(
            &RuntimeValue::Null,
            &RuntimeValue::Number(1.0),
            capture(),
            &mut budget
        )
        .unwrap(),
        Ordering::Greater
    );
    let unknown = OrderingCapture {
        nulls: NullOrder::Unavailable,
        strings: StringOrder::Unavailable,
    };
    assert_eq!(
        compare_typed(
            &RuntimeValue::Null,
            &RuntimeValue::Null,
            unknown,
            &mut budget
        )
        .unwrap(),
        Ordering::Equal
    );
    assert_eq!(
        compare_typed(
            &RuntimeValue::Null,
            &RuntimeValue::Number(1.0),
            unknown,
            &mut budget
        )
        .unwrap_err(),
        EvaluationFailure::MetadataUnavailable("sort_null_order_not_captured")
    );
    assert_eq!(
        order_typed_rows(&[], &[], capture(), &mut budget).unwrap_err(),
        EvaluationFailure::MetadataUnavailable("sort_null_order_not_captured")
    );
}
#[test]
fn string_utf16_is_not_rust_scalar_order_or_ambient_locale_collation() {
    let mut budget = WorkBudget::new();
    let a = RuntimeValue::String("\u{1f600}".into());
    let b = RuntimeValue::String("\u{e000}".into());
    assert_eq!(
        compare_typed(&a, &b, capture(), &mut budget).unwrap(),
        Ordering::Less
    );
    let unknown = OrderingCapture {
        nulls: NullOrder::Last,
        strings: StringOrder::Unavailable,
    };
    assert_eq!(
        compare_typed(&a, &a, unknown, &mut budget).unwrap(),
        Ordering::Equal
    );
    assert_eq!(
        compare_typed(&a, &b, unknown, &mut budget).unwrap_err(),
        EvaluationFailure::MetadataUnavailable("sort_collation_not_captured")
    );
}
#[test]
fn dates_compare_typed_instants_not_plain_date_or_datetime_strings() {
    let a = date("2026-06-10");
    let b = date("2026-06-10T00:00:00Z");
    let c = date("2026-06-10T01:00:00Z");
    assert_ne!(a, b);
    let mut budget = WorkBudget::new();
    assert_eq!(
        compare_typed(&a, &b, capture(), &mut budget).unwrap(),
        Ordering::Equal
    );
    assert_eq!(
        compare_typed(&a, &c, capture(), &mut budget).unwrap(),
        Ordering::Less
    );
}
#[test]
fn grouping_preserves_scalar_type_tags_and_input_order_with_signed_zero_equality() {
    let values = [
        RuntimeValue::Number(1.0),
        RuntimeValue::String("1".into()),
        RuntimeValue::Null,
        RuntimeValue::String(String::new()),
        RuntimeValue::Bool(false),
        RuntimeValue::Number(-0.0),
        RuntimeValue::Number(0.0),
        RuntimeValue::Number(1.0),
    ];
    let mut budget = WorkBudget::new();
    let groups = partition_typed(&values, DateGroupMode::Unavailable, &mut budget).unwrap();
    assert_eq!(
        groups.iter().map(|g| g.rows.clone()).collect::<Vec<_>>(),
        vec![vec![0, 7], vec![1], vec![2], vec![3], vec![4], vec![5, 6]]
    );
    assert_eq!(groups[0].key, &RuntimeValue::Number(1.0));
}
#[test]
fn date_grouping_requires_capture_and_does_not_use_display_strings_as_keys() {
    let values = [
        date("2026-06-10"),
        date("2026-06-10T00:00:00Z"),
        RuntimeValue::String("2026-06-10".into()),
    ];
    let mut budget = WorkBudget::new();
    let groups = partition_typed(&values, DateGroupMode::ExactMillis, &mut budget).unwrap();
    assert_eq!(groups.len(), 2);
    assert_eq!(groups[0].rows, vec![0, 1]);
    assert_eq!(groups[1].rows, vec![2]);
    let mut budget = WorkBudget::new();
    assert_eq!(
        partition_typed(&values, DateGroupMode::Unavailable, &mut budget)
            .err()
            .unwrap(),
        EvaluationFailure::MetadataUnavailable("date_group_mode_not_captured")
    );
    assert_eq!(
        partition_typed(&[], DateGroupMode::ExactMillis, &mut budget)
            .err()
            .unwrap(),
        EvaluationFailure::MetadataUnavailable("date_group_mode_not_captured")
    );
}
#[test]
fn structured_errors_nonfinite_and_mixed_types_never_get_json_fallback_order() {
    for value in [
        RuntimeValue::List(vec![]),
        RuntimeValue::Object(BTreeMap::new()),
        RuntimeValue::Error("synthetic".into()),
        RuntimeValue::Number(f64::NAN),
    ] {
        let mut budget = WorkBudget::new();
        assert!(matches!(
            compare_typed(&value, &RuntimeValue::Null, capture(), &mut budget),
            Err(EvaluationFailure::UnsupportedConstruct(
                "typed_ordering_value"
            ))
        ));
    }
    let mut budget = WorkBudget::new();
    assert_eq!(
        compare_typed(
            &RuntimeValue::Number(1.0),
            &RuntimeValue::String("1".into()),
            capture(),
            &mut budget
        )
        .unwrap_err(),
        EvaluationFailure::UnsupportedConstruct("mixed_ordering_types")
    );
}
#[test]
fn incomplete_keys_bounds_and_cancellation_suppress_whole_results() {
    let row = TypedSortRow { keys: &[] };
    let mut budget = WorkBudget::new();
    assert_eq!(
        order_typed_rows(&[row], &[SortDirection::Asc], capture(), &mut budget).unwrap_err(),
        EvaluationFailure::MetadataUnavailable("sort_keys_incomplete")
    );
    let mut budget = WorkBudget::new();
    assert!(matches!(
        order_typed_rows(
            &[],
            &[SortDirection::Asc; MAX_SORT_TERMS + 1],
            capture(),
            &mut budget
        ),
        Err(EvaluationFailure::BudgetExceeded("ordering_shape"))
    ));
    let mut budget = WorkBudget::new();
    budget.fail(EvaluationFailure::Cancelled);
    assert_eq!(
        order_typed_rows(&[], &[], capture(), &mut budget).unwrap_err(),
        EvaluationFailure::Cancelled
    );
    assert_eq!(
        partition_typed(&[], DateGroupMode::Unavailable, &mut budget)
            .err()
            .unwrap(),
        EvaluationFailure::Cancelled
    );
    let values: Vec<_> = (0..MAX_TYPED_GROUPS + 1)
        .map(|i| RuntimeValue::Number(i as f64))
        .collect();
    let mut budget = WorkBudget::new();
    assert_eq!(
        partition_typed(&values, DateGroupMode::Unavailable, &mut budget)
            .err()
            .unwrap(),
        EvaluationFailure::BudgetExceeded("typed_groups")
    );
}
