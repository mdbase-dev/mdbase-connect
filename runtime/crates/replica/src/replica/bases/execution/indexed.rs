//! Actor-held R6 raw streaming, exact Rust residuals, whole-output suppression.
use super::*;
use crate::store_query::{QueryPredicate, RawField};
use mdbn_core::views::bases::{
    AdmittedBasesView, BasesProjectedRow, BasesTimezone, CapturedClock, CapturedFileBindings,
    FileTimeAvailability, IncrementalBasesBudget, OrderingCapture, RuntimeValue, TypedSortRow,
    order_incremental_typed_rows, partition_incremental_typed_refs,
};
mod ownership;
mod source;
mod window;
fn reference_policies() -> BasesExecutionPolicies {
    BasesExecutionPolicies {
        ordering: OrderingCapture {
            nulls: mdbn_core::views::bases::NullOrder::Last,
            strings: mdbn_core::views::bases::StringOrder::Utf16,
        },
        date_groups: mdbn_core::views::bases::DateGroupMode::Unavailable,
        inventory_ties: true,
    }
}
fn cancelled(check: &dyn Fn() -> bool) -> ApiResult<()> {
    if check() {
        Err(failure(EvaluationFailure::Cancelled))
    } else {
        Ok(())
    }
}
impl<S: Store> Replica<S> {
    /// Synchronous actor-held on-device view execution. Only the selected source
    /// is hydrated; remaining sources flow through bounded raw R6 projections.
    /// No caller YAML, facade, async escape or partial result/publication path.
    /// Unsupported raw backends visibly refuse; never whole-source fallback.
    pub fn execute_indexed_bases_view(
        &mut self,
        selection: BasesViewSelection,
        property_types: Option<&BTreeMap<String, String>>,
        timezone: Option<&str>,
        policies: BasesExecutionPolicies,
        check_cancelled: &dyn Fn() -> bool,
    ) -> ApiResult<BasesExecutionResult> {
        self.execute_indexed_bases_view_publish(
            (selection, None),
            property_types,
            timezone,
            policies,
            check_cancelled,
            |_, result, _| Ok(result),
        )
    }
    /// Independent requested display window after a whole semantic scan. No
    /// cross-request clock/cursor or native tie qualification is conferred.
    pub fn execute_indexed_bases_window_view(
        &mut self,
        selection: BasesViewSelection,
        property_types: Option<&BTreeMap<String, String>>,
        timezone: Option<&str>,
        window: BasesExecutionWindow,
        check_cancelled: &dyn Fn() -> bool,
    ) -> ApiResult<BasesExecutionResult> {
        self.execute_indexed_bases_view_publish(
            (selection, Some(window)),
            property_types,
            timezone,
            reference_policies(),
            check_cancelled,
            |_, result, _| Ok(result),
        )
    }
    /// Session-gated full-view synthetic/reference-profile producer. The sole
    /// native codec measures first; its output is charged to the SAME retained
    /// ledger before allocation. Encoding runs before the existing final CAS,
    /// snapshot and actor checks, not in a post-fence publication gap.
    /// No caller budgets, policy overrides, sources or authority are admitted.
    pub fn encode_indexed_bases_read(
        &mut self,
        session: crate::api::SessionId,
        selection: BasesViewSelection,
        property_types: &BTreeMap<String, String>,
        timezone: &str,
        measure: impl FnOnce(&BasesExecutionResult) -> ApiResult<usize>,
        encode: impl FnOnce(&BasesExecutionResult, usize) -> ApiResult<Vec<u8>>,
    ) -> ApiResult<Vec<u8>> {
        self.encode_indexed_bases_read_request(
            session,
            BasesReadRequest {
                selection,
                property_types,
                timezone,
                window: None,
            },
            measure,
            encode,
        )
    }
    /// Same bounded read producer with an explicitly requested independent
    /// window; absent window preserves the complete-result contract.
    pub fn encode_indexed_bases_read_request(
        &mut self,
        session: crate::api::SessionId,
        request: BasesReadRequest<'_>,
        measure: impl FnOnce(&BasesExecutionResult) -> ApiResult<usize>,
        encode: impl FnOnce(&BasesExecutionResult, usize) -> ApiResult<Vec<u8>>,
    ) -> ApiResult<Vec<u8>> {
        self.authorize_bases_read(session)?;
        self.execute_indexed_bases_view_publish(
            (request.selection, request.window),
            Some(request.property_types),
            Some(request.timezone),
            reference_policies(),
            &|| false,
            |replica, result, ledger| {
                replica.authorize_bases_read(session)?;
                let size = measure(&result)?;
                let retained = (size as u64)
                    .checked_add(64)
                    .ok_or_else(|| failure(EvaluationFailure::BudgetExceeded("resident_bytes")))?;
                ledger.retain(retained).map_err(failure)?;
                // Abandoned serialized output is wiped, including any final
                // source/snapshot/actor failure after the last authority gate.
                let bytes = zeroize::Zeroizing::new(encode(&result, size)?);
                if bytes.len() != size || bytes.capacity() > size {
                    return Err(invalid());
                }
                replica.authorize_bases_read(session)?;
                Ok(bytes)
            },
        )
        .map(|mut bytes| std::mem::take(&mut *bytes))
    }
    fn execute_indexed_bases_view_publish<T>(
        &mut self,
        selection: (BasesViewSelection, Option<BasesExecutionWindow>),
        property_types: Option<&BTreeMap<String, String>>,
        timezone: Option<&str>,
        policies: BasesExecutionPolicies,
        check_cancelled: &dyn Fn() -> bool,
        publish: impl FnOnce(
            &mut Self,
            BasesExecutionResult,
            &mut IncrementalBasesBudget,
        ) -> ApiResult<T>,
    ) -> ApiResult<T> {
        let (selection, window) = selection;
        if let Some(window) = window {
            window.check()?;
        }
        let fence = self.collection_setup_capture_fence(None)?;
        cancelled(check_cancelled)?;
        if !policies.inventory_ties {
            return Err(failure(EvaluationFailure::MetadataUnavailable(
                "view_tie_order_not_captured",
            )));
        }
        if !self.catalog.is_valid()
            || !self
                .catalog
                .contracts()
                .iter()
                .any(|c| c.id == BASES_CONTRACT)
        {
            return Err(failure(EvaluationFailure::MetadataUnavailable(
                "bases_contract_not_installed",
            )));
        }
        let snapshot = self.indexed_bases_state()?;
        let mut ledger = IncrementalBasesBudget::new();
        let hints = property_types.ok_or_else(|| {
            failure(EvaluationFailure::MetadataUnavailable(
                "property_types_not_captured",
            ))
        })?;
        ledger
            .admit(|work| CapturedPropertyTypes::capture(hints, work).map(|_| ()))
            .map_err(failure)?;
        ledger
            .retain(
                hints
                    .iter()
                    .map(|(k, v)| k.len() as u64 + v.len() as u64 + 128)
                    .sum(),
            )
            .map_err(failure)?;
        let hints = ledger
            .admit(|work| {
                let bytes = hints
                    .iter()
                    .map(|(k, v)| k.len() as u64 + v.len() as u64 + 128)
                    .sum::<u64>();
                if !work.charge(hints.len() as u64, bytes) {
                    return Err(work.failure().expect("captured hints"));
                }
                Ok(hints.clone())
            })
            .map_err(failure)?;
        let zone = timezone
            .map(str::to_owned)
            .unwrap_or_else(|| self.host.zones.default_zone());
        if zone.len() > 128 {
            return Err(ErrorCode::InvalidRequest
                .err_with_reason("invalid_timezone", "invalid Bases capture timezone"));
        }
        let instant_ms = self.capture_instant();
        let local_date = self
            .host
            .zones
            .local_date(instant_ms, &zone)
            .ok_or_else(|| {
                ErrorCode::InvalidRequest
                    .err_with_reason("invalid_timezone", "unknown Bases capture timezone")
            })?;
        let clock = OpClock {
            instant_ms,
            tz: zone,
            local_date,
        };
        let captured_clock = ledger
            .admit(|work| {
                let zone = BasesTimezone::capture(&clock.tz, work)?;
                CapturedClock::new(clock.instant_ms, zone, work)
            })
            .map_err(failure)?;
        let types = ledger
            .admit(|work| CapturedPropertyTypes::capture(&hints, work))
            .map_err(failure)?;
        // One cumulative legacy-bounded source budget for initial/final selected
        // source reads, never used/reset to capture the rest of the inventory.
        let mut source_budget = QueryBudget::new(2, 1 << 20);
        let source = self.indexed_bases_source(selection, &mut source_budget, &mut ledger)?;
        self.recheck_collection_setup_capture(&fence)?;
        let (document, footprint) = ledger
            .admit(|work| {
                if !work.charge(source.doc.len() as u64, source.doc.len() as u64) {
                    return Err(work.failure().expect("selected document"));
                }
                Document::parse_at_bounded(&source.path, &source.doc)
                    .map_err(|_| EvaluationFailure::BudgetExceeded("base_source_structure"))
            })
            .map_err(failure)?;
        ledger
            .retain(
                2 * source.doc.len() as u64
                    + footprint.estimated_heap_bytes
                    + source.path.len() as u64
                    + 256,
            )
            .map_err(failure)?;
        let base = ledger
            .admit(|work| {
                if !work.charge(footprint.values, footprint.estimated_heap_bytes) {
                    return Err(work.failure().expect("source structure"));
                }
                discover_base_record(&self.catalog, &source.path, &document, &clock, work)
            })
            .map_err(failure)?
            .ok_or_else(invalid)?;
        let view = base
            .views
            .get(selection.index as usize)
            .ok_or_else(invalid)?;
        if !matches!(
            view.view_type,
            "table" | "tasknotesTaskList" | "tasknotesKanban"
        ) {
            return Err(failure(EvaluationFailure::UnsupportedConstruct(
                "bases_view_renderer",
            )));
        }
        ledger
            .retain(
                source.path.len() as u64
                    + view.name.map_or(0, |name| name.len() as u64)
                    + view.view_type.len() as u64
                    + base
                        .implementations
                        .iter()
                        .map(|i| i.type_name.len() as u64 + 256)
                        .sum::<u64>()
                    + 1024,
            )
            .map_err(failure)?;
        let descriptor = BasesViewDescriptor {
            record: source.id,
            path: source.path.clone(),
            revision: source.revision,
            index: view.index,
            name: view.name.map(str::to_owned),
            view_type: view.view_type.to_owned(),
            implementations: base
                .implementations
                .iter()
                .map(|i| BasesImplementationDescriptor {
                    type_name: i.type_name.clone(),
                    version: i.version.to_string(),
                    contract_digest: B32(i.contract_digest.0),
                    implementation_digest: B32(i.digest.0),
                })
                .collect(),
        };
        ledger.retain(1 << 20).map_err(failure)?; // fixed retained program/library/requirements admission
        let plan = ledger
            .admit(|work| {
                Ok(AdmittedBasesView::compile(
                    &base.fields,
                    view,
                    FileTimeAvailability {
                        created: false,
                        modified: false,
                        tags: true,
                    },
                    work,
                ))
            })
            .map_err(failure)?
            .map_err(|e| ErrorCode::InvalidRequest.err_with_reason(e.code(), e.detail()))?;
        let display_requirements = ledger
            .admit(|work| plan.projection_requirements(work))
            .map_err(failure)?;
        let semantic_requirements = if window.is_some() {
            Some(
                ledger
                    .admit(|work| plan.semantic_projection_requirements(work))
                    .map_err(failure)?,
            )
        } else {
            None
        };
        let requirements = semantic_requirements
            .as_ref()
            .unwrap_or(&display_requirements);
        let candidate = ledger
            .admit(|work| plan.candidate(&hints, captured_clock, work))
            .map_err(failure)?;
        ledger.retain(candidate.clone_bytes()).map_err(failure)?;
        let request_bytes = candidate.clone_bytes()
            + requirements
                .fields
                .iter()
                .map(|name| name.len() as u64 + 32)
                .sum::<u64>();
        let mut staged: Vec<(BasesExecutionRow, BasesProjectedRow, u64)> = Vec::new();
        let mut after = None;
        loop {
            cancelled(check_cancelled)?;
            self.recheck_collection_setup_capture(&fence)?;
            if self.indexed_bases_state()? != snapshot {
                return Err(invalid());
            }
            ledger
                .admit(|work| {
                    if work.charge(request_bytes, request_bytes) {
                        Ok(())
                    } else {
                        Err(work.failure().expect("projection request"))
                    }
                })
                .map_err(failure)?;
            let page = self
                .indexed_bases_projection(crate::store_query::QueryProjectionRequest {
                    generation: snapshot.generation,
                    head: snapshot.head,
                    predicate: QueryPredicate::All,
                    bases_candidate: Some(candidate.clone()),
                    bases_records: None,
                    fields: requirements.fields.clone(),
                    tags: requirements.tags,
                    after,
                    limit: 128,
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
            let more = page.has_more;
            for row in page.rows {
                after = Some(row.id);
                let projected = ledger
                    .row(row.source_bytes, |work| {
                        let raw = ownership::fields(&requirements.fields, row.fields, work)?;
                        let file =
                            CapturedFile::new(&row.path, Some(row.source_bytes), None, None, work)?;
                        let file = CapturedFileBindings::capture(&file, row.tags.as_deref(), work)?;
                        let bindings = types
                            .projected_bindings(&raw, work)?
                            .with_clock(captured_clock)
                            .with_file(file);
                        if window.is_some() {
                            plan.project_semantic(bindings, work, check_cancelled)
                        } else {
                            plan.project(bindings, work, check_cancelled)
                        }
                    })
                    .map_err(failure)?;
                if let Some(projected) = projected {
                    ledger
                        .retain(
                            row.path.len() as u64
                                // Core row() already billed projected keys/cells
                                // and their bookkeeping. Charge only EXTRA identity.
                                + std::mem::size_of::<BasesExecutionRow>() as u64+8,
                        )
                        .map_err(failure)?;
                    staged.push((
                        BasesExecutionRow {
                            record: row.id,
                            path: row.path,
                            revision: row.source_sha,
                            cells: Vec::new(),
                        },
                        projected,
                        row.source_bytes,
                    ));
                }
            }
            if !more {
                break;
            }
        }
        cancelled(check_cancelled)?;
        let directions = plan.sort_directions();
        ledger
            .retain(staged.len() as u64 * std::mem::size_of::<TypedSortRow<'_>>() as u64)
            .map_err(failure)?;
        let keys = staged
            .iter()
            .map(|(_, row, _)| TypedSortRow { keys: &row.sort })
            .collect::<Vec<_>>();
        let order =
            order_incremental_typed_rows(&keys, &directions, policies.ordering, &mut ledger)
                .map_err(failure)?;
        drop(keys);
        let mut groups = Vec::new();
        if let Some(direction) = plan.group_direction() {
            ledger
                .retain(order.len() as u64 * std::mem::size_of::<&RuntimeValue>() as u64)
                .map_err(failure)?;
            let mut group_keys = Vec::with_capacity(order.len());
            for index in &order {
                group_keys.push(staged[*index].1.group.as_ref().ok_or_else(invalid)?);
            }
            let mut partitions =
                partition_incremental_typed_refs(&group_keys, policies.date_groups, &mut ledger)
                    .map_err(failure)?;
            ledger
                .retain(partitions.len() as u64 * std::mem::size_of::<TypedSortRow<'_>>() as u64)
                .map_err(failure)?;
            let keys = partitions
                .iter()
                .map(|group| TypedSortRow {
                    keys: std::slice::from_ref(group.key),
                })
                .collect::<Vec<_>>();
            let group_order =
                order_incremental_typed_rows(&keys, &[direction], policies.ordering, &mut ledger)
                    .map_err(failure)?;
            ledger
                .retain(partitions.len() as u64 * std::mem::size_of::<BasesExecutionGroup>() as u64)
                .map_err(failure)?;
            drop(keys);
            for index in group_order {
                groups.push(BasesExecutionGroup {
                    key: ownership::scalar_copy(partitions[index].key, &mut ledger)?,
                    rows: std::mem::take(&mut partitions[index].rows),
                });
            }
        }
        ledger
            .retain(
                order.len() as u64 * std::mem::size_of::<BasesExecutionRow>() as u64
                    + plan.columns().len() as u64 * 2048,
            )
            .map_err(failure)?;
        let (rows, groups, window_info) = if let Some(request) = window {
            window::render(
                self,
                window::Context {
                    request,
                    plan: &plan,
                    requirements: &display_requirements,
                    types: &types,
                    clock: captured_clock,
                    snapshot: &snapshot,
                    fence: &fence,
                },
                &mut staged,
                order,
                groups,
                &mut ledger,
                check_cancelled,
            )?
        } else {
            let mut rows = Vec::with_capacity(order.len());
            for index in order {
                let (identity, projected, _) = &mut staged[index];
                rows.push(BasesExecutionRow {
                    record: identity.record,
                    path: std::mem::take(&mut identity.path),
                    revision: identity.revision,
                    cells: std::mem::take(&mut projected.cells),
                });
            }
            (rows, groups, None)
        };
        cancelled(check_cancelled)?;
        let output = publish(
            self,
            BasesExecutionResult {
                window: window_info,
                view: descriptor,
                collection_revision: fence.collection_revision(),
                clock,
                columns: plan.columns().to_vec(),
                unavailable_columns: plan.unavailable_columns().collect(),
                rows,
                groups,
            },
            &mut ledger,
        )?;
        cancelled(check_cancelled)?;
        // Whole-output suppression through final independent source CAS, raw
        // snapshot and strict actor/catalogue/custody/authority fences.
        let final_source = self.indexed_bases_source(selection, &mut source_budget, &mut ledger)?;
        if final_source.path != source.path
            || final_source.doc != source.doc
            || self.indexed_bases_state()? != snapshot
        {
            return Err(invalid());
        }
        self.recheck_collection_setup_capture(&fence)?;
        Ok(output)
    }
}
