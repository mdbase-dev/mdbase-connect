//! Pending-record raw projections, precharged before parsing/copying values.
use super::*;
use crate::store_query::QueryProjectionRow;
impl<S: Store> Replica<S> {
    pub(super) fn bases_pending_ids(
        &self,
        ledger: &mut IncrementalBasesBudget,
    ) -> ApiResult<Vec<Uuid>> {
        let count = self.layer.touched_count();
        if count > 1000 {
            return Err(failure(EvaluationFailure::BudgetExceeded(
                "bases_pending_records",
            )));
        }
        ledger.retain(count as u64 * 32).map_err(failure)?;
        ledger
            .admit(|work| {
                if !work.charge(count as u64 + 1, count as u64 * 32) {
                    return Err(work.failure().expect("pending identity admission"));
                }
                Ok(self
                    .layer
                    .record_changes()
                    .filter(|(_, record)| record.is_some())
                    .map(|(id, _)| crate::convert::wuuid(id))
                    .collect())
            })
            .map_err(failure)
    }
    pub(super) fn bases_pending_projection(
        &self,
        id: Uuid,
        fields: &[String],
        tags: bool,
        ledger: &mut IncrementalBasesBudget,
    ) -> ApiResult<Option<QueryProjectionRow>> {
        let Some(record) = self
            .layer
            .record_change(&crate::convert::uuid(&id))
            .and_then(Option::as_ref)
        else {
            return Ok(None);
        };
        let bytes = record.source.len() as u64;
        if bytes > 1 << 20 || record.path.len() > 4096 {
            return Err(failure(EvaluationFailure::BudgetExceeded(
                "bases_pending_source",
            )));
        }
        ledger
            .retain(bytes * 2 + record.path.len() as u64 + 512)
            .map_err(failure)?;
        let (document, footprint) = ledger
            .admit(|work| {
                if !work.charge(bytes, bytes) {
                    return Err(work.failure().expect("pending source parse"));
                }
                Document::parse_at_bounded(&record.path, &record.source)
                    .map_err(|_| EvaluationFailure::BudgetExceeded("pending_source_structure"))
            })
            .map_err(failure)?;
        ledger
            .retain(footprint.estimated_heap_bytes * 2 + fields.len() as u64 * 128)
            .map_err(failure)?;
        ledger
            .admit(|work| {
                if !work.charge(
                    footprint.values,
                    footprint.estimated_heap_bytes * 2 + fields.len() as u64 * 128,
                ) {
                    return Err(work.failure().expect("pending raw projection"));
                }
                let values = fields
                    .iter()
                    .map(|name| {
                        document
                            .frontmatter()
                            .get(name)
                            .map_or(RawField::Missing, |value| RawField::Present(value.clone()))
                    })
                    .collect();
                let qualified_tags = if tags {
                    super::super::tags::capture(&document, work)?
                } else {
                    None
                };
                Ok(Some(QueryProjectionRow {
                    id,
                    path: record.path.clone(),
                    source_sha: mdbn_wire::hash::sha256(record.source.as_bytes()),
                    source_bytes: bytes,
                    fields: values,
                    tags: qualified_tags,
                }))
            })
            .map_err(failure)
    }
}
