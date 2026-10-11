//! Bounded raw local records, not confirmed store rows or persisted index facts.
use super::*;
use crate::{
    convert,
    layer::LayerView,
    plan::StoreView,
    store::{Head, StoreError, StoreResult},
    store_query::QueryRecordSize,
};
use mdbn_core::state::{PathHolder, StateView};

pub(super) struct LocalRecord {
    pub id: Uuid,
    pub path: String,
    pub path_key: String,
    pub doc: String,
    pub revision: Hash,
}
impl From<RecordRow> for LocalRecord {
    fn from(row: RecordRow) -> Self {
        Self {
            id: row.id,
            path: row.path,
            path_key: row.path_key,
            doc: row.doc,
            revision: row.revision,
        }
    }
}
impl<S: Store> Replica<S> {
    fn check_bases_overlay_bound(&self) -> StoreResult<()> {
        if self.layer.touched_count() > 1000 {
            return Err(StoreError::Full);
        }
        Ok(())
    }
    /// Precharge bounded scan/tree work and both store/merged metadata pages.
    /// Sources are independently precharged before hydration, never here.
    pub(super) fn bases_local_metadata_cost(&self, limit: u32) -> ApiResult<(u64, u64)> {
        self.check_bases_overlay_bound()
            .map_err(|_| unavailable())?;
        if limit == 0 || limit > 128 {
            return Err(invalid());
        }
        let entries = u64::from(limit);
        let touched = self.layer.touched_count() as u64;
        Ok(((entries + touched * 2) * 16 + 1, (entries + 1) * 256))
    }
    pub(super) fn bases_local_sizes(
        &self,
        page: Page,
        head: Head,
    ) -> StoreResult<Vec<QueryRecordSize>> {
        self.check_bases_overlay_bound()?;
        if page.limit == 0 || page.limit > 128 || self.store.head()? != head {
            return Err(StoreError::Full);
        }
        // Gather only one metadata page. Skip overwritten confirmed identities;
        // actual pending record identities are merged in the same UUID order.
        let mut selected = std::collections::BTreeMap::new();
        let mut after = page.after;
        let mut scanned = 0usize;
        loop {
            let rows = self.store.query_record_sizes_at(
                Page {
                    after,
                    limit: page.limit,
                },
                head,
            )?;
            if rows.len() > page.limit as usize {
                return Err(StoreError::Corrupt("oversized Bases metadata page".into()));
            }
            let count = rows.len();
            for row in rows {
                if after.is_some_and(|after| row.id <= after) {
                    return Err(StoreError::Corrupt("unordered Bases metadata page".into()));
                }
                after = Some(row.id);
                scanned += 1;
                if scanned > page.limit as usize + self.layer.touched_count() {
                    return Err(StoreError::Full);
                }
                if !self.layer.touches(&convert::uuid(&row.id)) {
                    selected.insert(row.id, row);
                }
                if selected.len() == page.limit as usize {
                    break;
                }
            }
            if selected.len() == page.limit as usize || count < page.limit as usize {
                break;
            }
        }
        for (id, record) in self.layer.record_changes() {
            let id = convert::wuuid(id);
            let Some(record) = record else {
                continue;
            };
            if page.after.is_some_and(|after| id <= after) {
                continue;
            }
            if record.source.len() > 1 << 20 || record.path.len() > 4096 {
                return Err(StoreError::Full);
            }
            // A conservative source-copy charge, not a persisted-row witness.
            let bytes = record.source.len() as u64 + record.path.len() as u64 * 2 + 512;
            selected.insert(
                id,
                QueryRecordSize {
                    id,
                    encoded_bytes: bytes,
                },
            );
            if selected.len() > page.limit as usize {
                selected.pop_last();
            }
        }
        Ok(selected.into_values().collect())
    }
    /// Admit selected identity/size BEFORE a source copy. Pending metadata
    /// comes from the actual layer; its source CAS is checked after hydration.
    pub(super) fn bases_local_source_bytes(
        &self,
        selection: BasesViewSelection,
        head: Head,
    ) -> ApiResult<u64> {
        if let Some(change) = self.layer.record_change(&convert::uuid(&selection.record)) {
            let record = change.as_ref().ok_or_else(invalid)?;
            if record.source.len() > 1 << 20 || record.path.len() > 4096 {
                return Err(failure(EvaluationFailure::BudgetExceeded(
                    "selected_local_source",
                )));
            }
            return Ok(record.source.len() as u64);
        }
        if self.layer.file_known(&convert::uuid(&selection.record)) {
            return Err(invalid());
        }
        // Probe the primary identity page before selecting/hydrating an ID.
        // A missing selected identity is a caller conflict, not SQL corruption.
        let after = u128::from_be_bytes(selection.record.0)
            .checked_sub(1)
            .map(|id| mdbn_wire::common::B16(id.to_be_bytes()));
        let rows = self
            .store
            .query_record_sizes_at(Page { after, limit: 1 }, head)
            .map_err(|_| unavailable())?;
        let row = rows
            .first()
            .filter(|_| rows.len() == 1)
            .ok_or_else(invalid)?;
        if row.id != selection.record {
            return Err(invalid());
        }
        Ok(row.encoded_bytes)
    }
    pub(super) fn bases_local_hydrate(
        &self,
        ids: &[Uuid],
        head: Head,
        budget: &mut QueryBudget,
    ) -> StoreResult<Vec<LocalRecord>> {
        self.check_bases_overlay_bound()?;
        if ids.len() > 128 || self.store.head()? != head {
            return Err(StoreError::Full);
        }
        let mut confirmed = Vec::new();
        let mut local = std::collections::BTreeMap::new();
        for id in ids {
            if self.layer.touches(&convert::uuid(id)) {
                if let Some(record) = self
                    .layer
                    .record_change(&convert::uuid(id))
                    .and_then(Option::as_ref)
                {
                    let bytes = record.source.len() as u64 + record.path.len() as u64 * 2 + 512;
                    if record.source.len() > 1 << 20 || record.path.len() > 4096 {
                        return Err(StoreError::Full);
                    }
                    budget.charge(1, bytes)?;
                    let row = LocalRecord {
                        id: *id,
                        path: record.path.clone(),
                        path_key: mdbn_core::paths::path_key(&record.path),
                        doc: record.source.to_string(),
                        revision: mdbn_wire::hash::sha256(record.source.as_bytes()),
                    };
                    local.insert(*id, row);
                }
            } else {
                confirmed.push(*id);
            }
        }
        if !confirmed.is_empty() {
            for row in self.store.hydrate_query_at(&confirmed, head, budget)? {
                local.insert(row.id, row.into());
            }
        }
        Ok(local.into_values().collect())
    }
    pub(super) fn bases_local_holder_matches(&self, row: &LocalRecord) -> ApiResult<bool> {
        if self.layer.is_empty() {
            return Ok(self
                .store
                .record_at(&row.path_key)
                .map_err(|_| unavailable())?
                == Some(row.id)
                && self
                    .store
                    .file_at(&row.path_key)
                    .map_err(|_| unavailable())?
                    .is_none());
        }
        let base = StoreView::new(&self.store, self.catalog.clone());
        let view = LayerView {
            base: &base,
            layer: &self.layer,
        };
        Ok(view.at_path_key(&row.path_key) == Some(PathHolder::Record(convert::uuid(&row.id))))
    }
}
