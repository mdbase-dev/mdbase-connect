//! Typed, fallible multi-key ordering and exact scalar partitioning.
//! No serde/JSON fallback, ambient collation, guessed null order or cell defaults.
use super::{
    EvaluationFailure, MAX_CAPTURE_TEXT_BYTES, MAX_SORT_TERMS, RuntimeValue, SortDirection,
    WorkBudget,
};
use std::{cmp::Ordering, collections::BTreeMap};
/// Maximum rows in this component profile, before allocating index buffers.
pub const MAX_ORDERED_ROWS: usize = 10_000;
/// Maximum exact groups before allocating another result bucket.
pub const MAX_TYPED_GROUPS: usize = 4096;
/// Explicit captured placement of null relative to non-null ascending keys.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NullOrder {
    /// Capture unavailable; only equal-null comparisons work.
    Unavailable,
    /// Null compares below non-null (descending reverses this).
    First,
    /// Null compares above non-null (descending reverses this).
    Last,
}
/// Explicit string ordering capture. Binary UTF16 is a component mode, not a
/// claim that every Obsidian locale/collator uses it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StringOrder {
    /// Distinct strings cannot be compared without capture.
    Unavailable,
    /// ECMAScript binary UTF16 code-unit ordering, not locale/natural.
    Utf16,
}
/// Frozen comparison inputs. This data does not authenticate a host capture.
#[derive(Clone, Copy, Debug)]
pub struct OrderingCapture {
    /// Ascending null placement, never defaulted.
    pub nulls: NullOrder,
    /// Captured string comparison policy, never defaulted.
    pub strings: StringOrder,
}
/// A fully materialized set of typed key cells in declaration order.
/// Missing capture is not represented by an omitted key; actual absence is Null.
pub struct TypedSortRow<'a> {
    /// One cell for each requested sort term.
    pub keys: &'a [RuntimeValue],
}
fn fail<T>(budget: &mut WorkBudget, error: EvaluationFailure) -> Result<T, EvaluationFailure> {
    budget.fail(error);
    Err(budget.failure().expect("sticky ordering failure"))
}
fn work(budget: &mut WorkBudget, steps: u64, bytes: u64) -> Result<(), EvaluationFailure> {
    if budget.charge(steps, bytes) {
        Ok(())
    } else {
        Err(budget.failure().expect("ordering budget failure"))
    }
}
fn cell(value: &RuntimeValue, budget: &mut WorkBudget) -> Result<(), EvaluationFailure> {
    work(budget, 1, 0)?;
    match value {
        RuntimeValue::Null | RuntimeValue::Bool(_) | RuntimeValue::Date(_) => Ok(()),
        RuntimeValue::Number(n) if n.is_finite() => Ok(()),
        RuntimeValue::String(s) if s.len() <= MAX_CAPTURE_TEXT_BYTES => Ok(()),
        RuntimeValue::String(_) => fail(
            budget,
            EvaluationFailure::BudgetExceeded("ordering_key_bytes"),
        ),
        _ => fail(
            budget,
            EvaluationFailure::UnsupportedConstruct("typed_ordering_value"),
        ),
    }
}
/// Compare qualified same-type scalar values. Unsupported mixed/structured/error
/// values cannot turn into serialized JSON, a falsey cell or an arbitrary rank.
pub fn compare_typed(
    left: &RuntimeValue,
    right: &RuntimeValue,
    capture: OrderingCapture,
    budget: &mut WorkBudget,
) -> Result<Ordering, EvaluationFailure> {
    cell(left, budget)?;
    cell(right, budget)?;
    match (left, right) {
        (RuntimeValue::Null, RuntimeValue::Null) => Ok(Ordering::Equal),
        (RuntimeValue::Null, _) | (_, RuntimeValue::Null) => {
            let ascending = match capture.nulls {
                NullOrder::Unavailable => {
                    return fail(
                        budget,
                        EvaluationFailure::MetadataUnavailable("sort_null_order_not_captured"),
                    );
                }
                NullOrder::First => Ordering::Less,
                NullOrder::Last => Ordering::Greater,
            };
            Ok(if matches!(left, RuntimeValue::Null) {
                ascending
            } else {
                ascending.reverse()
            })
        }
        (RuntimeValue::Bool(a), RuntimeValue::Bool(b)) => Ok(a.cmp(b)),
        (RuntimeValue::Number(a), RuntimeValue::Number(b)) => {
            Ok(a.partial_cmp(b).expect("finite keys"))
        }
        (RuntimeValue::Date(a), RuntimeValue::Date(b)) => {
            Ok(a.value().millis().cmp(&b.value().millis()))
        }
        (RuntimeValue::String(a), RuntimeValue::String(b)) => {
            work(budget, (a.len() + b.len()) as u64, 0)?;
            if a == b {
                return Ok(Ordering::Equal);
            }
            match capture.strings {
                StringOrder::Unavailable => fail(
                    budget,
                    EvaluationFailure::MetadataUnavailable("sort_collation_not_captured"),
                ),
                StringOrder::Utf16 => Ok(a.encode_utf16().cmp(b.encode_utf16())),
            }
        }
        _ => fail(
            budget,
            EvaluationFailure::UnsupportedConstruct("mixed_ordering_types"),
        ),
    }
}
/// Stable fallible merge-sort of row indices: multilevel ASC/DESC, preserving
/// original captured input order for equal keys. Partial/budget-failed output
/// is suppressed. A fallible comparator never enters std's infallible sort.
pub fn order_typed_rows(
    rows: &[TypedSortRow<'_>],
    directions: &[SortDirection],
    capture: OrderingCapture,
    budget: &mut WorkBudget,
) -> Result<Vec<usize>, EvaluationFailure> {
    if rows.len() > MAX_ORDERED_ROWS || directions.len() > MAX_SORT_TERMS {
        return fail(budget, EvaluationFailure::BudgetExceeded("ordering_shape"));
    }
    for row in rows {
        work(budget, 1, 0)?;
        if row.keys.len() != directions.len() {
            return fail(
                budget,
                EvaluationFailure::MetadataUnavailable("sort_keys_incomplete"),
            );
        }
        for value in row.keys {
            cell(value, budget)?;
        }
    }
    work(budget, 1, (rows.len() as u64) * 16)?;
    merge_indices(rows.len(), |pair| {
        compare_or_tick(rows, directions, capture, pair, budget)
    })
}
fn compare_or_tick(
    rows: &[TypedSortRow<'_>],
    directions: &[SortDirection],
    capture: OrderingCapture,
    pair: Option<(usize, usize)>,
    budget: &mut WorkBudget,
) -> Result<Ordering, EvaluationFailure> {
    let mut ordering = Ordering::Equal;
    if let Some((left, right)) = pair {
        for (column, direction) in directions.iter().enumerate() {
            ordering = compare_typed(
                &rows[left].keys[column],
                &rows[right].keys[column],
                capture,
                budget,
            )?;
            if *direction == SortDirection::Desc {
                ordering = ordering.reverse();
            }
            if ordering != Ordering::Equal {
                break;
            }
        }
    }
    work(budget, 1, 0)?;
    Ok(ordering)
}
fn merge_indices(
    count: usize,
    mut compare: impl FnMut(Option<(usize, usize)>) -> Result<Ordering, EvaluationFailure>,
) -> Result<Vec<usize>, EvaluationFailure> {
    let mut indices: Vec<usize> = (0..count).collect();
    let mut scratch = vec![0; count];
    let mut width = 1usize;
    while width < count {
        let mut start = 0usize;
        while start < count {
            let mid = (start + width).min(count);
            let end = (mid + width).min(count);
            let (mut a, mut b, mut dest) = (start, mid, start);
            while a < mid && b < end {
                let ordering = compare(Some((indices[a], indices[b])))?;
                if ordering != Ordering::Greater {
                    scratch[dest] = indices[a];
                    a += 1;
                } else {
                    scratch[dest] = indices[b];
                    b += 1;
                }
                dest += 1;
            }
            while a < mid {
                compare(None)?;
                scratch[dest] = indices[a];
                a += 1;
                dest += 1;
            }
            while b < end {
                compare(None)?;
                scratch[dest] = indices[b];
                b += 1;
                dest += 1;
            }
            start = end;
        }
        std::mem::swap(&mut indices, &mut scratch);
        width *= 2;
    }
    Ok(indices)
}
/// Separate incremental profile: same typed comparator/stable merge, fixed
/// 65,536-row inventory and cumulative request work/output ownership. Frozen
/// legacy MAX_ORDERED_ROWS and WorkBudget ceilings are NOT widened or refunded.
/// Returns no partial indices on any comparison/shape/sticky failure.
pub fn order_incremental_typed_rows(
    rows: &[TypedSortRow<'_>],
    directions: &[SortDirection],
    capture: OrderingCapture,
    budget: &mut super::IncrementalBasesBudget,
) -> Result<Vec<usize>, EvaluationFailure> {
    if rows.len() as u64 > super::MAX_INCREMENTAL_ROWS || directions.len() > MAX_SORT_TERMS {
        return budget
            .helper(|scratch| fail(scratch, EvaluationFailure::BudgetExceeded("ordering_shape")));
    }
    for row in rows {
        budget.helper(|scratch| {
            work(scratch, 1, 0)?;
            if row.keys.len() != directions.len() {
                return fail(
                    scratch,
                    EvaluationFailure::MetadataUnavailable("sort_keys_incomplete"),
                );
            }
            for value in row.keys {
                cell(value, scratch)?;
            }
            Ok(())
        })?;
    }
    // Both owned index buffers fit even the unchanged 1MiB scratch ceiling at
    // the maximum inventory; keep the same conservative 16B/index accounting.
    let bytes = rows.len() as u64 * 16;
    budget.retain(bytes)?;
    budget.helper(|scratch| work(scratch, 1, bytes))?;
    merge_indices(rows.len(), |pair| {
        budget.helper(|scratch| compare_or_tick(rows, directions, capture, pair, scratch))
    })
}

/// Date grouping is not inferred from formatting or a string serialization.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DateGroupMode {
    /// A date requires named/captured group qualification.
    Unavailable,
    /// Explicit exact-instant partitioning, independent of display labels.
    ExactMillis,
}
/// Exact group bucket, in first-encounter order. Ordering buckets is separate.
pub struct TypedGroup<'a> {
    /// Original typed key, never replaced by a display name.
    pub key: &'a RuntimeValue,
    /// Original input indices, preserving encounter order.
    pub rows: Vec<usize>,
}
#[derive(PartialEq, Eq, PartialOrd, Ord)]
enum GroupKey<'a> {
    Null,
    Bool(bool),
    Number(u64),
    String(&'a str),
    Date(i64),
}
/// Exact scalar partitioning with type tags: number1 != string"1", Null !="".
/// Signed zeros share a number bucket; Date instant grouping must be captured.
/// Lists/objects/durations/errors visibly refuse instead of guessed grouping.
pub fn partition_typed<'a>(
    values: &'a [RuntimeValue],
    dates: DateGroupMode,
    budget: &mut WorkBudget,
) -> Result<Vec<TypedGroup<'a>>, EvaluationFailure> {
    work(budget, 1, 0)?;
    if values.len() > MAX_ORDERED_ROWS {
        return fail(budget, EvaluationFailure::BudgetExceeded("group_rows"));
    }
    partition_inner(
        values.iter().enumerate(),
        dates,
        PartitionBudget::Legacy(budget),
    )
}
/// Same exact scalar grouping under the separate incremental inventory/work/
/// ownership ledger. The qualified 4,096-group limit is unchanged.
pub fn partition_incremental_typed<'a>(
    values: &'a [RuntimeValue],
    dates: DateGroupMode,
    budget: &mut super::IncrementalBasesBudget,
) -> Result<Vec<TypedGroup<'a>>, EvaluationFailure> {
    budget.helper(|scratch| work(scratch, 1, 0))?;
    if values.len() as u64 > super::MAX_INCREMENTAL_ROWS {
        return budget
            .helper(|scratch| fail(scratch, EvaluationFailure::BudgetExceeded("group_rows")));
    }
    partition_inner(
        values.iter().enumerate(),
        dates,
        PartitionBudget::Incremental(budget),
    )
}
/// Group borrowed staged keys without cloning one RuntimeValue per result row.
/// Same inventory, scalar qualification, ownership/work ledger and semantics.
pub fn partition_incremental_typed_refs<'a>(
    values: &[&'a RuntimeValue],
    dates: DateGroupMode,
    budget: &mut super::IncrementalBasesBudget,
) -> Result<Vec<TypedGroup<'a>>, EvaluationFailure> {
    budget.helper(|scratch| work(scratch, 1, 0))?;
    if values.len() as u64 > super::MAX_INCREMENTAL_ROWS {
        return budget
            .helper(|scratch| fail(scratch, EvaluationFailure::BudgetExceeded("group_rows")));
    }
    partition_inner(
        values.iter().copied().enumerate(),
        dates,
        PartitionBudget::Incremental(budget),
    )
}
enum PartitionBudget<'a> {
    Legacy(&'a mut WorkBudget),
    Incremental(&'a mut super::IncrementalBasesBudget),
}
impl PartitionBudget<'_> {
    fn work(&mut self, steps: u64, bytes: u64) -> Result<(), EvaluationFailure> {
        match self {
            Self::Legacy(budget) => work(budget, steps, bytes),
            Self::Incremental(budget) => {
                budget.retain(bytes)?;
                budget.helper(|scratch| work(scratch, steps, bytes))
            }
        }
    }
    fn cell(&mut self, value: &RuntimeValue) -> Result<(), EvaluationFailure> {
        match self {
            Self::Legacy(budget) => cell(value, budget),
            Self::Incremental(budget) => budget.helper(|scratch| cell(value, scratch)),
        }
    }
    fn fail<T>(&mut self, error: EvaluationFailure) -> Result<T, EvaluationFailure> {
        match self {
            Self::Legacy(budget) => fail(budget, error),
            Self::Incremental(budget) => budget.helper(|scratch| fail(scratch, error)),
        }
    }
}
fn partition_inner<'a>(
    values: impl Iterator<Item = (usize, &'a RuntimeValue)>,
    dates: DateGroupMode,
    mut budget: PartitionBudget<'_>,
) -> Result<Vec<TypedGroup<'a>>, EvaluationFailure> {
    let mut lookup = BTreeMap::new();
    let mut groups: Vec<TypedGroup<'a>> = Vec::new();
    for (index, value) in values {
        budget.cell(value)?;
        let key = match value {
            RuntimeValue::Null => GroupKey::Null,
            RuntimeValue::Bool(n) => GroupKey::Bool(*n),
            RuntimeValue::Number(n) => GroupKey::Number(if *n == 0.0 { 0 } else { n.to_bits() }),
            RuntimeValue::String(s) => {
                budget.work((s.len() as u64) * 14, 0)?;
                GroupKey::String(s)
            }
            RuntimeValue::Date(d) => {
                if dates == DateGroupMode::Unavailable {
                    return budget.fail(EvaluationFailure::MetadataUnavailable(
                        "date_group_mode_not_captured",
                    ));
                }
                GroupKey::Date(d.value().millis())
            }
            _ => unreachable!("validated scalar key"),
        };
        let slot = match lookup.get(&key) {
            Some(slot) => *slot,
            None => {
                if groups.len() == MAX_TYPED_GROUPS {
                    return budget.fail(EvaluationFailure::BudgetExceeded("typed_groups"));
                }
                budget.work(1, 128)?;
                let slot = groups.len();
                groups.push(TypedGroup {
                    key: value,
                    rows: Vec::new(),
                });
                lookup.insert(key, slot);
                slot
            }
        };
        budget.work(1, 16)?;
        groups[slot].rows.push(index);
    }
    Ok(groups)
}
#[cfg(test)]
#[path = "ordering/incremental_tests.rs"]
mod incremental_tests;
#[cfg(test)]
mod tests;
pub(crate) mod witness;
