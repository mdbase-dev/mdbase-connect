//! Bounded SQL query-driver primitives: select IDs/sizes before hydrating rows.
//!
//! These APIs do not parse YAML or change candidate semantics. An index/top-k
//! driver selects bounded IDs and carries one [`HydrationBudget`] through the
//! entire request. Sizes are checked before selecting BLOBs; the BLOB SELECT
//! additionally requires the preflight size so concurrent growth cannot bypass
//! the byte limit. A captured head fences stale selections. Catalogue/index
//! generation and cursor bindings remain the caller's responsibility.

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::rc::Rc;

use mdbn_replica::store::{Head, Page, RecordRow, StoreError, StoreResult};
use mdbn_wire::common::Uuid;

use crate::index::{Batch, BatchMode, IndexStorage, SqlValue, Stmt, StmtResult};
use crate::sql::{head_d, record_d};

const PAGE_IDS: u32 = 1_000;
const PARAM_IDS: usize = 100;

/// Standalone SQL compatibility name for neutral source-selection metadata.
pub use mdbn_replica::store_query::QueryRecordSize as RecordSize;

/// Cumulative request work, not a per-page or response-size cap.
///
/// Charge before fetching BLOBs. A later read/decode failure does not refund
/// work already attempted, so restarting cannot silently multiply the budget.
pub use mdbn_replica::store_query::QueryBudget as HydrationBudget;

fn corrupt() -> StoreError {
    StoreError::Corrupt("invalid SQL query preflight/result".into())
}
fn stale() -> StoreError {
    StoreError::Io("query selection stale; restart required".into())
}
fn sql_error(e: crate::index::IndexError) -> StoreError {
    match e.kind {
        crate::index::IndexErrorKind::Full => StoreError::Full,
        crate::index::IndexErrorKind::Corrupt => StoreError::Corrupt(e.to_string()),
        _ => StoreError::Io(e.to_string()),
    }
}
fn id(value: &SqlValue) -> StoreResult<Uuid> {
    let SqlValue::Blob(b) = value else {
        return Err(corrupt());
    };
    let bytes: [u8; 16] = b.as_slice().try_into().map_err(|_| corrupt())?;
    Ok(mdbn_wire::common::B16(bytes))
}
fn size(value: &SqlValue) -> StoreResult<u64> {
    let SqlValue::Integer(n) = value else {
        return Err(corrupt());
    };
    u64::try_from(*n).map_err(|_| corrupt())
}
fn single(results: Vec<StmtResult>, columns: u32) -> StoreResult<StmtResult> {
    if columns == 0 {
        return Err(corrupt());
    }
    let mut results = results.into_iter();
    let result = results.next().ok_or_else(corrupt)?;
    if results.next().is_some()
        || result.columns != columns
        || !result.values.len().is_multiple_of(columns as usize)
    {
        return Err(corrupt());
    }
    Ok(result)
}

/// Read-only query access to the shared SQL projection. Implements no Store and
/// makes no physical durability claim; usable with SqlStore::index() or the typed
/// hosted LogCache::index(), without constructing a raw Disposable SqlStore.
pub struct SqlQuery<I: IndexStorage> {
    index: Rc<RefCell<I>>,
}
impl<I: IndexStorage> SqlQuery<I> {
    /// Borrow the store-owned index; creates no schema and performs no SQL.
    pub fn new(index: Rc<RefCell<I>>) -> Self {
        Self { index }
    }

    fn head(&self) -> StoreResult<Head> {
        let result = self.query_statement("SELECT v FROM st_kv WHERE k = 'head'", vec![], 1)?;
        match result.values.as_slice() {
            [] => Ok(Head::GENESIS),
            [value] => head_d(value),
            _ => Err(corrupt()),
        }
    }
    fn query_statement(
        &self,
        sql: impl Into<String>,
        params: Vec<SqlValue>,
        columns: u32,
    ) -> StoreResult<StmtResult> {
        single(
            self.index
                .borrow_mut()
                .run(&Batch {
                    mode: BatchMode::Autocommit,
                    stmts: vec![Stmt::new(sql, params)],
                })
                .map_err(sql_error)?,
            columns,
        )
    }

    /// ID-order metadata page (at most 1000 IDs), never hydrate/return record BLOBs.
    /// This is selection metadata, not an exact total-count or query-result claim.
    pub fn record_ids_with_sizes(&self, page: Page) -> StoreResult<Vec<RecordSize>> {
        if page.limit == 0 {
            return Ok(Vec::new());
        }
        let mut sql = "SELECT id, length(row) FROM st_rec".to_string();
        let mut params = Vec::new();
        if let Some(after) = page.after {
            sql.push_str(" WHERE id > ?");
            params.push(SqlValue::Blob(after.0.to_vec()));
        }
        sql.push_str(" ORDER BY id LIMIT ?");
        let limit = page.limit.min(PAGE_IDS);
        params.push(SqlValue::Integer(i64::from(limit)));
        let result = self.query_statement(sql, params, 2)?;
        if result.row_count() > u64::from(limit) {
            return Err(corrupt());
        }
        result
            .rows()
            .map(|row| {
                Ok(RecordSize {
                    id: id(&row[0])?,
                    encoded_bytes: size(&row[1])?,
                })
            })
            .collect()
    }

    /// Head-fenced metadata selection for a bounded fallback or index rebuild.
    /// Reject oversized requests rather than silently shortening their pages.
    /// Even zero-limit scans verify the head, and no record BLOB is selected.
    pub fn record_ids_with_sizes_at(&self, page: Page, head: Head) -> StoreResult<Vec<RecordSize>> {
        if page.limit > PAGE_IDS {
            return Err(StoreError::Full);
        }
        if self.head()? != head {
            return Err(stale());
        }
        let rows = self.record_ids_with_sizes(page)?;
        if self.head()? != head {
            return Err(stale());
        }
        Ok(rows)
    }

    /// Hydrate selected unique IDs in request order, only at `captured_head`,
    /// after aggregate count/byte preflight. Missing IDs or changed sizes are a
    /// stale selection, not an invitation to skip rows or return a partial page.
    ///
    /// Encoded row size includes the document and persisted metadata; it is a
    /// conservative source-byte budget, not a total-heap measurement. The caller
    /// must also bind catalogue/SEM/index generation and stream/reject oversized
    /// individual rows rather than increasing the hosted budget.
    pub fn hydrate_records_at(
        &self,
        ids: &[Uuid],
        captured_head: Head,
        budget: &mut HydrationBudget,
    ) -> StoreResult<Vec<RecordRow>> {
        if ids.is_empty() {
            return if self.head()? == captured_head {
                Ok(Vec::new())
            } else {
                Err(stale())
            };
        }
        let count = u32::try_from(ids.len()).map_err(|_| StoreError::Full)?;
        if count > budget.records_left() {
            return Err(StoreError::Full);
        }
        // One result envelope never exceeds the binding hosted record count.
        if count > PAGE_IDS {
            return Err(StoreError::Full);
        }
        if self.head()? != captured_head {
            return Err(stale());
        }
        let distinct: BTreeSet<_> = ids.iter().copied().collect();
        if distinct.len() != ids.len() {
            return Err(StoreError::Io("duplicate query selection IDs".into()));
        }
        let mut sizes = BTreeMap::new();
        let mut bytes = 0_u64;
        for chunk in ids.chunks(PARAM_IDS) {
            let placeholders = std::iter::repeat_n("?", chunk.len())
                .collect::<Vec<_>>()
                .join(",");
            let sql = format!("SELECT id, length(row) FROM st_rec WHERE id IN ({placeholders})");
            let params = chunk
                .iter()
                .map(|id| SqlValue::Blob(id.0.to_vec()))
                .collect();
            let result = self.query_statement(sql, params, 2)?;
            for row in result.rows() {
                let id = id(&row[0])?;
                if !distinct.contains(&id) || sizes.contains_key(&id) {
                    return Err(corrupt());
                }
                let n = size(&row[1])?;
                bytes = bytes.checked_add(n).ok_or(StoreError::Full)?;
                if bytes > budget.bytes_left() {
                    return Err(StoreError::Full);
                }
                sizes.insert(id, n);
            }
        }
        if sizes.len() != ids.len() {
            return Err(stale());
        }
        // Charge all selected work BEFORE any BLOB SELECT or CBOR decoding.
        budget.charge(count, bytes)?;
        // One host import for the admitted BLOB reads, not one import per ID.
        let stmts = ids
            .iter()
            .map(|id| {
                let n = *sizes.get(id).ok_or_else(corrupt)?;
                Ok(Stmt::new(
                    "SELECT row FROM st_rec WHERE id = ? AND length(row) = ?",
                    vec![
                        SqlValue::Blob(id.0.to_vec()),
                        SqlValue::Integer(i64::try_from(n).map_err(|_| corrupt())?),
                    ],
                ))
            })
            .collect::<StoreResult<Vec<_>>>()?;
        let results = self
            .index
            .borrow_mut()
            .run(&Batch {
                mode: BatchMode::Autocommit,
                stmts,
            })
            .map_err(sql_error)?;
        if results.len() != ids.len() {
            return Err(corrupt());
        }
        let mut records = Vec::with_capacity(ids.len());
        for (id, result) in ids.iter().zip(results) {
            let n = *sizes.get(id).ok_or_else(corrupt)?;
            if result.columns != 1 {
                return Err(corrupt());
            }
            if result.values.len() != 1 {
                return Err(stale());
            }
            let SqlValue::Blob(blob) = &result.values[0] else {
                return Err(corrupt());
            };
            if blob.len() as u64 != n {
                return Err(corrupt());
            }
            let record = record_d(&result.values[0])?;
            if record.id != *id {
                return Err(corrupt());
            }
            records.push(record);
        }
        if self.head()? != captured_head {
            return Err(stale());
        }
        Ok(records)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cumulative_budget_charge_is_atomic_and_failures_do_not_refund() {
        let mut budget = HydrationBudget::new(2, 10);
        budget.charge(1, 6).unwrap();
        assert_eq!(budget.records_left(), 1);
        assert_eq!(budget.bytes_left(), 4);
        assert_eq!(budget.charge(1, 5), Err(StoreError::Full));
        assert_eq!(budget, HydrationBudget::new(1, 4));
        assert_eq!(budget.charge(2, 1), Err(StoreError::Full));
        assert_eq!(budget, HydrationBudget::new(1, 4));
        budget.charge(1, 4).unwrap();
        assert_eq!(budget, HydrationBudget::new(0, 0));
    }
    #[test]
    fn invalid_preflight_and_result_shape_are_errors_not_panics() {
        assert!(id(&SqlValue::Blob(vec![0; 15])).is_err());
        assert!(size(&SqlValue::Integer(-1)).is_err());
        assert!(size(&SqlValue::Real(1.0)).is_err());
        assert!(single(vec![], 2).is_err());
        assert!(
            single(
                vec![StmtResult {
                    columns: 2,
                    values: vec![SqlValue::Null],
                    ..StmtResult::default()
                }],
                2
            )
            .is_err()
        );
    }
}
