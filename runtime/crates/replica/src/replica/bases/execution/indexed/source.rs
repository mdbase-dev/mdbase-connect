//! Selected-source CAS and independent raw snapshot fences; no whole inventory.
use super::*;
use crate::store_query::QueryProjectionState;
impl<S: Store> Replica<S> {
    pub(super) fn indexed_bases_state(&self) -> ApiResult<QueryProjectionState> {
        let state = self
            .store
            .query_projection_state()
            .map_err(|_| unavailable())?
            .ok_or_else(|| {
                failure(EvaluationFailure::MetadataUnavailable(
                    "view_raw_projection_unavailable",
                ))
            })?;
        if !state.ready
            || state.head != self.head
            || self
                .query_context
                .as_deref()
                .is_none_or(|context| context.generation() != state.generation)
        {
            return Err(failure(EvaluationFailure::MetadataUnavailable(
                "view_raw_projection_not_ready",
            )));
        }
        Ok(state)
    }
    pub(super) fn indexed_bases_source(
        &self,
        selection: BasesViewSelection,
        budget: &mut QueryBudget,
        ledger: &mut IncrementalBasesBudget,
    ) -> ApiResult<RecordRow> {
        let mut rows = self
            .store
            .hydrate_query_at(&[selection.record], self.head, budget)
            .map_err(|error| match error {
                crate::store::StoreError::Full => {
                    failure(EvaluationFailure::BudgetExceeded("selected_source_reads"))
                }
                _ => unavailable(),
            })?;
        if rows.len() != 1 {
            return Err(invalid());
        }
        let row = rows.remove(0);
        if row.id != selection.record
            || row.revision != selection.revision
            || row.path.len() > 4096
            || row.doc.len() > 1 << 20
        {
            return Err(invalid());
        }
        ledger
            .admit(|work| {
                if !work.charge(row.doc.len() as u64, 0) {
                    return Err(work.failure().expect("source hash work"));
                }
                Ok(())
            })
            .map_err(failure)?;
        if mdbn_wire::hash::sha256(row.doc.as_bytes()) != row.revision {
            return Err(invalid());
        }
        Ok(row)
    }
}
