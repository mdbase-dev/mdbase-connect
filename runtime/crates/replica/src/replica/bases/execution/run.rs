//! Actor-held, all-or-nothing whole-view evaluation; no asynchronous side registry.
use super::*;
use mdbn_core::views::bases::{
    AdmittedBasesView, BasesDisplayCell, BasesProjectedRow, BasesTimezone, CapturedClock,
    CapturedFileBindings, DateGroupMode, FileTimeAvailability, OrderingCapture, PropertySelector,
    RawFrontmatter, RuntimeValue, TypedSortRow, order_typed_rows, partition_typed,
};
/// Explicit frozen ordering policies. No locale/null/day/tie defaults.
#[derive(Clone, Copy)]
pub struct BasesExecutionPolicies {
    /// Captured null and string comparison behavior.
    pub ordering: OrderingCapture,
    /// Captured date partition semantics (unavailable until qualified).
    pub date_groups: DateGroupMode,
    /// Caller explicitly accepts this complete confirmed inventory's stable input
    /// order for equal keys. Not an assertion of Obsidian filesystem ordering.
    pub inventory_ties: bool,
}
/// Exact result row identity and source revision, with visible display slots.
pub struct BasesExecutionRow {
    /// Actual confirmed record UUID.
    pub record: Uuid,
    /// Exact captured record path.
    pub path: String,
    /// Exact source SHA256.
    pub revision: Hash,
    /// Display cells in original source order.
    pub cells: Vec<BasesDisplayCell>,
}
/// Typed partition; no JSON coercion or guessed label.
pub struct BasesExecutionGroup {
    /// Exact typed group key; Null differs from empty string/false.
    pub key: RuntimeValue,
    /// Row indices into the globally ordered result, in that order.
    pub rows: Vec<usize>,
}
/// Complete fenced result; never returned on any source/authority/work failure.
pub struct BasesExecutionResult {
    /// Actual selected source identity/ordinal.
    pub view: BasesViewDescriptor,
    /// Trusted captured collection revision.
    pub collection_revision: Hash,
    /// One immutable clock for admission/filter/formulas/all rows.
    pub clock: OpClock,
    /// Original normalized display column selectors including repeated slots.
    pub columns: Vec<PropertySelector>,
    /// Display-only unavailable slots with a fixed safe diagnostic.
    pub unavailable_columns: Vec<(usize, &'static str)>,
    /// Explicit independent display-window placement, absent for full result.
    pub window: Option<BasesWindowInfo>,
    /// Filtered and globally ordered rows (requested window when present).
    pub rows: Vec<BasesExecutionRow>,
    /// Whole typed grouping in source requested group direction.
    pub groups: Vec<BasesExecutionGroup>,
}
impl<S: Store> Replica<S> {
    /// Execute an immutable selected-source capture against the actual confirmed
    /// Replica inventory. Consume it, preserving the SAME sticky capture meter.
    /// Recheck full source inventory/authority before admission and final return.
    pub fn execute_captured_bases_view(
        &self,
        mut input: CapturedBasesExecutionInputs,
        policies: BasesExecutionPolicies,
        cancelled: &dyn Fn() -> bool,
    ) -> ApiResult<BasesExecutionResult> {
        self.recheck_bases_execution_inputs(&input)?;
        if cancelled() {
            return Err(failure(EvaluationFailure::Cancelled));
        }
        if !policies.inventory_ties {
            return Err(failure(EvaluationFailure::MetadataUnavailable(
                "view_tie_order_not_captured",
            )));
        }
        let descriptor = input.view().clone();
        let source = input
            .capture
            .records
            .iter()
            .position(|row| row.id == descriptor.record)
            .ok_or_else(invalid)?;
        let work = &mut input.work;
        let zone = BasesTimezone::capture(&input.capture.clock.tz, work).map_err(failure)?;
        let clock =
            CapturedClock::new(input.capture.clock.instant_ms, zone, work).map_err(failure)?;
        let base = discover_base_record(
            &self.catalog,
            &descriptor.path,
            &input.documents[source],
            &input.capture.clock,
            work,
        )
        .map_err(failure)?
        .ok_or_else(invalid)?;
        let view = base
            .views
            .get(descriptor.index as usize)
            .ok_or_else(invalid)?;
        let plan = AdmittedBasesView::compile(
            &base.fields,
            view,
            FileTimeAvailability {
                created: false,
                modified: false,
                tags: input.tags.iter().all(|v| v.is_some()),
            },
            work,
        )
        .map_err(|e| ErrorCode::InvalidRequest.err_with_reason(e.code(), e.detail()))?;
        let types = CapturedPropertyTypes::capture(&input.property_types, work).map_err(failure)?;
        let mut projected: Vec<(usize, BasesProjectedRow)> = Vec::new();
        if !work.charge(
            input.capture.records.len() as u64,
            (input.capture.records.len() * std::mem::size_of::<(usize, BasesProjectedRow)>())
                as u64,
        ) {
            return Err(failure(work.failure().expect("projected rows")));
        }
        for (index, document) in input.documents.iter().enumerate() {
            if cancelled() {
                return Err(failure(EvaluationFailure::Cancelled));
            }
            let bindings = RawFrontmatter::capture(document, Some(types), work)
                .map_err(failure)?
                .bindings()
                .with_clock(clock)
                .with_file(
                    CapturedFileBindings::capture(
                        &input.files[index],
                        input.tags[index].as_deref(),
                        work,
                    )
                    .map_err(failure)?,
                );
            if let Some(row) = plan.project(bindings, work, cancelled).map_err(failure)? {
                projected.push((index, row));
            }
        }
        let directions = plan.sort_directions();
        let keys = projected
            .iter()
            .map(|(_, row)| TypedSortRow { keys: &row.sort })
            .collect::<Vec<_>>();
        let order =
            order_typed_rows(&keys, &directions, policies.ordering, work).map_err(failure)?;
        let mut groups = Vec::new();
        if let Some(direction) = plan.group_direction() {
            let group_keys = order
                .iter()
                .map(|i| {
                    projected[*i]
                        .1
                        .group
                        .as_ref()
                        .expect("admitted group root")
                        .clone()
                })
                .collect::<Vec<_>>();
            let partitions =
                partition_typed(&group_keys, policies.date_groups, work).map_err(failure)?;
            let group_sort = partitions
                .iter()
                .map(|p| TypedSortRow {
                    keys: std::slice::from_ref(p.key),
                })
                .collect::<Vec<_>>();
            for index in order_typed_rows(&group_sort, &[direction], policies.ordering, work)
                .map_err(failure)?
            {
                let partition = &partitions[index];
                groups.push(BasesExecutionGroup {
                    key: partition.key.clone(),
                    rows: partition.rows.clone(),
                });
            }
        }
        let mut rows = Vec::with_capacity(order.len());
        for index in order {
            let (record_index, row) = &mut projected[index];
            let record = &input.capture.records[*record_index];
            if !work.charge(
                record.path.len() as u64,
                (record.path.len() + std::mem::size_of::<BasesExecutionRow>()) as u64,
            ) {
                return Err(failure(work.failure().expect("output identities")));
            }
            rows.push(BasesExecutionRow {
                record: record.id,
                path: record.path.clone(),
                revision: record.revision,
                cells: std::mem::take(&mut row.cells),
            });
        }
        if cancelled() {
            return Err(failure(EvaluationFailure::Cancelled));
        }
        let revision = input.collection_revision();
        let columns = plan.columns().to_vec();
        let unavailable_columns = plan.unavailable_columns().collect();
        // Re-read full bounded sources too: unchanged-head illicit store drift cannot
        // turn a good evaluation into a successful stale/partial result.
        self.recheck_bases_execution_inputs(&input)?;
        Ok(BasesExecutionResult {
            window: None,
            view: descriptor,
            collection_revision: revision,
            clock: input.capture.clock.clone(),
            columns,
            unavailable_columns,
            rows,
            groups,
        })
    }
}
