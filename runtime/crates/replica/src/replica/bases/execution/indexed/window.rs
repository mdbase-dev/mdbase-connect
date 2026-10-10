//! Global semantic order/group placement, exact selected display hydration.
use super::*;
use crate::store_query::{QueryProjectionRequest, QueryProjectionState};
use mdbn_core::views::bases::BasesProjectionRequirements;
pub(super) struct Context<'a> {
    pub request: BasesExecutionWindow,
    pub plan: &'a AdmittedBasesView,
    pub requirements: &'a BasesProjectionRequirements,
    pub types: &'a CapturedPropertyTypes<'a>,
    pub clock: CapturedClock,
    pub snapshot: &'a QueryProjectionState,
    pub fence: &'a SetupCaptureFence,
}
pub(super) fn render<S: Store>(
    replica: &mut Replica<S>,
    context: Context<'_>,
    staged: &mut [(BasesExecutionRow, BasesProjectedRow, u64)],
    order: Vec<usize>,
    groups: Vec<BasesExecutionGroup>,
    ledger: &mut IncrementalBasesBudget,
    check_cancelled: &dyn Fn() -> bool,
) -> ApiResult<(
    Vec<BasesExecutionRow>,
    Vec<BasesExecutionGroup>,
    Option<BasesWindowInfo>,
)> {
    let total = u32::try_from(order.len()).map_err(|_| invalid())?;
    if total > 65_536 {
        return Err(invalid());
    }
    let start = (context.request.offset as usize).min(order.len());
    let end = start
        .saturating_add(context.request.limit as usize)
        .min(order.len());
    let chosen = &order[start..end];
    ledger
        .admit(|work| {
            // Membership selection and placement visit existing bounded metadata;
            // debit the same cumulative work ledger before these native loops.
            let steps = order.len() as u64 + groups.len() as u64 + chosen.len() as u64 * 128 + 1;
            if work.charge(steps, 0) {
                Ok(())
            } else {
                Err(work.failure().expect("window metadata work"))
            }
        })
        .map_err(failure)?;
    // Sorted membership/position metadata only, never all display payloads.
    ledger
        .retain(
            chosen.len() as u64 * (std::mem::size_of::<Option<BasesExecutionRow>>() as u64 + 96),
        )
        .map_err(failure)?;
    let wanted = chosen
        .iter()
        .enumerate()
        .map(|(local, index)| (staged[*index].0.record, (local, *index)))
        .collect::<BTreeMap<_, _>>();
    let ids = wanted.keys().copied().collect::<Vec<_>>();
    let mut rows = (0..chosen.len()).map(|_| None).collect::<Vec<_>>();
    for chunk in ids.chunks(128) {
        let mut consumed = 0usize;
        while consumed < chunk.len() {
            cancelled(check_cancelled)?;
            replica.recheck_collection_setup_capture(context.fence)?;
            if replica.indexed_bases_state()? != *context.snapshot {
                return Err(invalid());
            }
            let remaining = &chunk[consumed..];
            ledger
                .admit(|work| {
                    let bytes = remaining.len() as u64 * 16
                        + context
                            .requirements
                            .fields
                            .iter()
                            .map(|name| name.len() as u64 + 32)
                            .sum::<u64>();
                    if work.charge(bytes, bytes) {
                        Ok(())
                    } else {
                        Err(work.failure().expect("window projection request"))
                    }
                })
                .map_err(failure)?;
            let page = replica
                .indexed_bases_projection(QueryProjectionRequest {
                    generation: context.snapshot.generation,
                    head: context.snapshot.head,
                    predicate: QueryPredicate::All,
                    bases_candidate: None,
                    bases_records: Some(remaining.to_vec()),
                    fields: context.requirements.fields.clone(),
                    tags: context.requirements.tags,
                    after: None,
                    limit: remaining.len() as u32,
                    max_bytes: 1 << 20,
                })?
                .map_err(|_| {
                    failure(EvaluationFailure::MetadataUnavailable(
                        "view_raw_projection_not_ready",
                    ))
                })?;
            ledger
                .admit(|work| ownership::frame(&page, work))
                .map_err(failure)?;
            if page.rows.is_empty() {
                return Err(invalid());
            }
            let count = page.rows.len();
            for row in page.rows {
                let (local, index) = *wanted.get(&row.id).ok_or_else(invalid)?;
                let (identity, keys, source_bytes) = &mut staged[index];
                if row.source_sha != identity.revision
                    || row.path != identity.path
                    || row.source_bytes != *source_bytes
                    || rows[local].is_some()
                {
                    return Err(invalid());
                }
                // Same previously-admitted inventory identity. Source cardinality
                // isn't doubled; work and retained projection are charged AGAIN.
                let projected = ledger
                    .project_admitted(|work| {
                        let raw =
                            ownership::fields(&context.requirements.fields, row.fields, work)?;
                        let file =
                            CapturedFile::new(&row.path, Some(row.source_bytes), None, None, work)?;
                        let file = CapturedFileBindings::capture(&file, row.tags.as_deref(), work)?;
                        let bindings = context
                            .types
                            .projected_bindings(&raw, work)?
                            .with_clock(context.clock)
                            .with_file(file);
                        context.plan.project(bindings, work, check_cancelled)
                    })
                    .map_err(failure)?
                    .ok_or_else(invalid)?;
                if projected.sort != keys.sort || projected.group != keys.group {
                    return Err(invalid());
                }
                rows[local] = Some(BasesExecutionRow {
                    record: identity.record,
                    path: std::mem::take(&mut identity.path),
                    revision: identity.revision,
                    cells: projected.cells,
                });
            }
            consumed += count;
            if !page.has_more && consumed != chunk.len() {
                return Err(invalid());
            }
        }
    }
    let rows = rows
        .into_iter()
        .map(|row| row.ok_or_else(invalid))
        .collect::<ApiResult<Vec<_>>>()?;
    let mut visible = Vec::new();
    let mut placements = Vec::new();
    for (ordinal, group) in groups.into_iter().enumerate() {
        let total_rows = u32::try_from(group.rows.len()).map_err(|_| invalid())?;
        let represented = group
            .rows
            .iter()
            .filter(|global| (start..end).contains(global))
            .count();
        if represented > 0 {
            // Debit before allocating the new retained window placements.
            ledger
                .retain(128 + represented as u64 * (std::mem::size_of::<usize>() as u64 + 4))
                .map_err(failure)?;
        }
        let mut local = Vec::with_capacity(represented);
        let mut ordinals = Vec::with_capacity(represented);
        for (inside, global) in group.rows.into_iter().enumerate() {
            if global >= order.len() {
                return Err(invalid());
            }
            if (start..end).contains(&global) {
                local.push(global - start);
                ordinals.push(u32::try_from(inside).map_err(|_| invalid())?);
            }
        }
        if !local.is_empty() {
            visible.push(BasesExecutionGroup {
                key: group.key,
                rows: local,
            });
            placements.push(BasesGroupPlacement {
                ordinal: u32::try_from(ordinal).map_err(|_| invalid())?,
                total_rows,
                row_ordinals: ordinals,
            });
        }
    }
    Ok((
        rows,
        visible,
        Some(BasesWindowInfo {
            request: context.request,
            total_rows: total,
            groups: placements,
        }),
    ))
}
