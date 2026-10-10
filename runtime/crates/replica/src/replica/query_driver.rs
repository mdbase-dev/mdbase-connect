//! The shared indexed query driver: one path for every replica (daemon, Obsidian,
//! hosted) over any [`Store`] that maintains the query index.
//!
//! The driver answers only when it can answer **exactly**:
//! - Core's closed profile (`query::profile::lower`) proves membership and order;
//! - the maintained index is ready, under the same generation as the captured
//!   projection context, at the replica's confirmed head;
//! - the requested window fits the 1000-record selection limit.
//!
//! Anything else returns `Ok(None)` and the caller uses the per-record path, which
//! is complete. Budget overruns on the indexed path are explicit errors, never a
//! truncated answer presented as complete.
//!
//! Pending local edits (the layer) are exact too: touched IDs are dropped from the
//! confirmed selection (over-selecting by the layer size), the layered records are
//! evaluated with the plan itself, and the merge uses the plan's own comparator.

use std::collections::{BTreeMap, BTreeSet};

use mdbn_core::query::profile::{self, Predicate};
use mdbn_core::query::{QueryEnv, QueryPlan, QueryRecord, Verdict};
use mdbn_core::state::StateView;
use mdbn_wire::client::{Include, QueryResult, RecordView};
use mdbn_wire::common::Uuid;

use super::Replica;
use super::submit::{record_view, store_err};
use crate::api::{ApiError, ApiResult, ErrorCode};
use crate::convert;
use crate::layer::LayerView;
use crate::plan::QueryProjectionContext;
use crate::store::{RecordRow, Store, StoreError};
use crate::store_query::{QueryBudget, QueryIndexRequest, QueryKeyedId};

pub(crate) struct IndexedQueryPage {
    pub(crate) result: QueryResult,
    pub(crate) frontier: Option<QueryKeyedId>,
}

/// Most identities one indexed selection may return (the store's own cap).
pub(crate) const MAX_SELECTED: u64 = 1000;
/// Aggregate selected key bytes and hydrated source bytes, per request.
pub(crate) const MAX_BYTES: u64 = 1 << 20;
/// Deepest `offset` a memory-constrained (or hosted) replica serves: skipping
/// matches costs index work proportional to the offset on every page, so deep
/// offset pagination remains refused (bounded paging); resident keyset pages use0.
pub(crate) const MAX_CONSTRAINED_OFFSET: u64 = 10_000;

/// Why the indexed path declined; the caller then uses the per-record path.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decline {
    /// A snapshot install is in progress.
    Installing,
    /// Projections, selections, groups or summaries need the full evaluator.
    Shape,
    /// No limit, or a window beyond the selection cap.
    Window,
    /// Pending resource edits change the catalogue.
    LayeredCatalog,
    /// The index is absent, not ready, stale or under another generation.
    NotReady,
    /// Core's profile does not cover this query.
    Unsupported(profile::Unsupported),
    /// A field the profile needs is not materialized.
    Field,
    /// The store has no bounded raw projection.
    Projection,
}

impl Decline {
    /// A fixed label for diagnostics and measurement.
    pub fn label(self) -> &'static str {
        match self {
            Self::Installing => "installing",
            Self::Shape => "shape",
            Self::Window => "window",
            Self::LayeredCatalog => "layered_catalog",
            Self::NotReady => "not_ready",
            Self::Unsupported(profile::Unsupported::Expression) => "unsupported_expression",
            Self::Unsupported(profile::Unsupported::Field) => "unsupported_field",
            Self::Unsupported(profile::Unsupported::Order) => "unsupported_order",
            Self::Unsupported(profile::Unsupported::Budget) => "unsupported_budget",
            Self::Unsupported(profile::Unsupported::Types) => "unsupported_types",
            Self::Field => "field_not_indexed",
            Self::Projection => "projection_unsupported",
        }
    }
}

fn budget_error(what: &str) -> ApiError {
    ErrorCode::TooLarge.err_with_reason(
        "query_budget_exceeded",
        format!(
            "{what} exceeds the query budget of {MAX_SELECTED} records and {MAX_BYTES} bytes; \
             narrow the query or page it"
        ),
    )
}

/// Map a store error on the indexed path: `Full` there means a request budget.
fn indexed_err(e: StoreError, what: &str) -> ApiError {
    match e {
        StoreError::Full => budget_error(what),
        e => store_err(e),
    }
}

fn compare_keys(
    a: &QueryKeyedId,
    b: &QueryKeyedId,
    request: &QueryIndexRequest,
) -> std::cmp::Ordering {
    for ((a, b), order) in a.keys.iter().zip(&b.keys).zip(&request.order) {
        let cmp = a.kind.cmp(&b.kind).then_with(|| a.key.cmp(&b.key));
        let cmp = if order.descending { cmp.reverse() } else { cmp };
        if !cmp.is_eq() {
            return cmp;
        }
    }
    // Never reverse the final ID, including when every term is DESC.
    a.id.cmp(&b.id)
}

fn validate_keyset_page(
    request: &QueryIndexRequest,
    page: &crate::store_query::QueryIndexPage,
) -> ApiResult<()> {
    let bad = || {
        ErrorCode::Unavailable
            .err_with_reason("query_index_stale", "invalid keyset page; restart query")
    };
    if page.rows.len() > request.limit as usize || (page.has_more && page.rows.is_empty()) {
        return Err(bad());
    }
    let mut bytes = 0u64;
    let mut previous = request.after.as_ref();
    let mut ids = BTreeSet::new();
    for row in &page.rows {
        if row.keys.len() != request.order.len() || row.keys.len() > 8 || !ids.insert(row.id) {
            return Err(bad());
        }
        bytes = bytes.checked_add(16).ok_or_else(bad)?;
        for key in &row.keys {
            // Canonical kind/key, not host scalar casts or guessed dates.
            mdbn_core::query::indexed::SortAtom::from_parts(key.kind, &key.key, 8192)
                .map_err(|_| bad())?;
            bytes = bytes
                .checked_add(key.key.len() as u64 + 1)
                .ok_or_else(bad)?;
        }
        if bytes > request.max_key_bytes
            || previous.is_some_and(|p| !compare_keys(row, p, request).is_gt())
        {
            return Err(bad());
        }
        previous = Some(row);
    }
    Ok(())
}

/// Counts of how queries were answered.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct QueryStats {
    /// Answered from the maintained index.
    pub indexed: u64,
    /// Declined; answered by the per-record path.
    pub declined: u64,
    /// Explicit errors on the indexed path (budget, stale, store).
    pub failed: u64,
    /// Why the most recent declined query was declined.
    pub last_decline: Option<&'static str>,
}

/// A candidate in the final merge: confirmed (from the index) or layered.
enum Source {
    Confirmed(Box<RecordRow>),
    Layered(mdbn_core::state::StoredRecord),
}

impl<S: Store> Replica<S> {
    /// The ready index context, or why there is none.
    /// A genuine store error is an error, never a decline.
    pub(crate) fn ready_context(&self) -> ApiResult<Result<&QueryProjectionContext, Decline>> {
        let Some(context) = self.query_context.as_deref() else {
            return Ok(Err(Decline::NotReady));
        };
        let Some(state) = self.store.query_index_state().map_err(store_err)? else {
            return Ok(Err(Decline::NotReady));
        };
        if !state.ready
            || state.generation != context.generation()
            || state.head != self.head
            || state.fields != context.fields()
        {
            return Ok(Err(Decline::NotReady));
        }
        Ok(Ok(context))
    }

    /// The confirmed seq a layered record's view shows (as the per-record path
    /// does). Only for layered rows in the answered window. The store has no
    /// metadata-only lookup yet, so the base row is read and then charged to the
    /// request budget (file: a pre-admission accessor is requested).
    fn base_seq(&self, id: &Uuid, budget: &mut QueryBudget) -> ApiResult<u64> {
        match self.store.record(id).map_err(store_err)? {
            Some(r) => {
                budget
                    .charge(1, r.doc.len() as u64)
                    .map_err(|e| indexed_err(e, "the pending records"))?;
                Ok(r.modified_seq)
            }
            None => Ok(0),
        }
    }

    /// Answer `plan` from the maintained index, or decline. `lv` is the layered
    /// view the per-record path would use.
    pub(crate) fn indexed_query(
        &self,
        plan: &QueryPlan,
        lv: &LayerView<'_>,
        env: &QueryEnv,
        include: &Include,
    ) -> ApiResult<Result<QueryResult, Decline>> {
        self.indexed_query_page(plan, lv, env, include, None)
            .map(|out| out.map(|page| page.result))
    }

    /// Generic Query metadata only. Projection/Bases continuations are unrelated.
    pub(crate) fn indexed_query_page(
        &self,
        plan: &QueryPlan,
        lv: &LayerView<'_>,
        env: &QueryEnv,
        include: &Include,
        after: Option<&QueryKeyedId>,
    ) -> ApiResult<Result<IndexedQueryPage, Decline>> {
        let out = self.indexed_query_inner(plan, lv, env, include, after);
        let mut stats = self.query_stats.get();
        match &out {
            Ok(Ok(_)) => stats.indexed += 1,
            Ok(Err(why)) => {
                stats.declined += 1;
                stats.last_decline = Some(why.label());
            }
            Err(_) => stats.failed += 1,
        }
        self.query_stats.set(stats);
        out
    }

    /// One bounded raw projection page (streaming Bases) under the SAME fence as
    /// [`Self::indexed_query`]: a ready index under the captured generation at the
    /// confirmed head, no install in progress, a store that implements it, and
    /// a raw payload ready under that generation at that head.
    /// Otherwise a [`Decline`]. The predicate is a necessary condition only; the
    /// caller evaluates its full query on every row. A page that breaks the
    /// contract (order, cursor, bounds, field shape) is an error, never used.
    pub fn indexed_projection(
        &self,
        predicate: crate::store_query::QueryPredicate,
        fields: Vec<String>,
        tags: bool,
        after: Option<Uuid>,
        limit: u32,
        max_bytes: u64,
    ) -> ApiResult<Result<crate::store_query::QueryProjectionPage, Decline>> {
        if self.install.is_some() {
            return Ok(Err(Decline::Installing));
        }
        let Some(state) = self.store.query_projection_state().map_err(store_err)? else {
            return Ok(Err(Decline::Projection));
        };
        // A predicate reads the field index: it must be ready under the same
        // generation. `All` reads only the raw payload.
        let context = if predicate == crate::store_query::QueryPredicate::All {
            match self.query_context.as_deref() {
                Some(c) => c,
                None => return Ok(Err(Decline::NotReady)),
            }
        } else {
            match self.ready_context()? {
                Ok(c) => c,
                Err(why) => return Ok(Err(why)),
            }
        };
        // Raw payload not (yet) complete, stale or of another generation: a
        // visible decline, never a page.
        if !state.ready || state.generation != context.generation() || state.head != self.head {
            return Ok(Err(Decline::NotReady));
        }
        let request = crate::store_query::QueryProjectionRequest {
            generation: context.generation(),
            head: self.head,
            predicate,
            bases_candidate: None,
            bases_records: None,
            after,
            limit,
            max_bytes,
            fields,
            tags,
        };
        request
            .check()
            .map_err(|e| indexed_err(e, "the projection request"))?;
        let page = self
            .store
            .query_projection_page(&request)
            .map_err(|e| indexed_err(e, "the projection page"))?;
        page.check(&request)
            .map_err(|why| store_err(StoreError::Corrupt(why.into())))?;
        Ok(Ok(page))
    }

    /// Raw-only Bases candidate pages: no effective/CEL field-index predicate,
    /// ordinary query lifting or fallback. Exact Rust residuals remain required.
    pub(crate) fn indexed_bases_projection(
        &self,
        request: crate::store_query::QueryProjectionRequest,
    ) -> ApiResult<Result<crate::store_query::QueryProjectionPage, Decline>> {
        if self.install.is_some() {
            return Ok(Err(Decline::Installing));
        }
        request
            .check()
            .map_err(|e| indexed_err(e, "the projection request"))?;
        if request.predicate != crate::store_query::QueryPredicate::All {
            return Ok(Err(Decline::Shape));
        }
        let Some(context) = self.query_context.as_deref() else {
            return Ok(Err(Decline::NotReady));
        };
        let Some(state) = self.store.query_projection_state().map_err(store_err)? else {
            return Ok(Err(Decline::Projection));
        };
        if !state.ready
            || state.generation != context.generation()
            || state.head != self.head
            || request.generation != state.generation
            || request.head != state.head
        {
            return Ok(Err(Decline::NotReady));
        }
        let page = self
            .store
            .query_projection_page(&request)
            .map_err(|e| indexed_err(e, "the projection page"))?;
        page.check(&request)
            .map_err(|why| store_err(StoreError::Corrupt(why.into())))?;
        Ok(Ok(page))
    }

    /// A fresh request budget for the fallback scan, when budgeted.
    /// Replica's per-host profile (`QueryExecutionProfile`) decides; a hosted
    /// replica is always memory-constrained whatever was selected.
    pub(crate) fn fallback_budget(&self) -> Option<QueryBudget> {
        let profile = if self.is_hosted() {
            super::QueryExecutionProfile::MemoryConstrained
        } else {
            self.query_execution_profile()
        };
        profile
            .fallback_source_limits()
            .map(|l| QueryBudget::new(l.records, l.bytes))
    }

    /// Charge one source copy to the fallback budget, if any.
    pub(crate) fn charge_fallback(budget: &mut Option<QueryBudget>, bytes: usize) -> ApiResult<()> {
        match budget {
            Some(b) => b
                .charge(1, bytes as u64)
                .map_err(|_| budget_error("the records this query has to read")),
            None => Ok(()),
        }
    }

    /// How queries were answered since open (diagnostics and measurement).
    pub fn query_stats(&self) -> QueryStats {
        self.query_stats.get()
    }

    fn indexed_query_inner(
        &self,
        plan: &QueryPlan,
        lv: &LayerView<'_>,
        env: &QueryEnv,
        include: &Include,
        after: Option<&QueryKeyedId>,
    ) -> ApiResult<Result<IndexedQueryPage, Decline>> {
        let q = &plan.query;
        if self.install.is_some() {
            return Ok(Err(Decline::Installing));
        }
        if !q.projections.is_empty()
            || !q.select.is_empty()
            || !q.group_by.is_empty()
            || !q.summaries.is_empty()
        {
            return Ok(Err(Decline::Shape));
        }
        let Some(limit) = q.limit else {
            return Ok(Err(Decline::Window));
        };
        let window = q.offset.saturating_add(limit);
        if self.layer.catalog().is_some() {
            return Ok(Err(Decline::LayeredCatalog));
        }
        let context = match self.ready_context()? {
            Ok(c) => c,
            Err(d) => return Ok(Err(d)),
        };
        let catalog = context.catalog();
        let profile = match profile::lower(plan, catalog) {
            Ok(p) => p,
            Err(u) => return Ok(Err(Decline::Unsupported(u))),
        };
        let touched: BTreeSet<Uuid> = self
            .layer
            .touched_ids()
            .iter()
            .map(convert::wuuid)
            .collect();
        // Without pending edits the index order is final: the store skips
        // `offset` matches by key (no source reads) and selects only the page, so
        // a deep page costs its own rows. With pending edits the layered records
        // merge into the confirmed order, so the whole window is selected.
        if q.offset > MAX_CONSTRAINED_OFFSET && self.fallback_budget().is_some() {
            return Err(ErrorCode::TooLarge.err_with_reason(
                "query_budget_exceeded",
                format!(
                    "an offset beyond {MAX_CONSTRAINED_OFFSET} exceeds the query budget on \
                     this host; narrow the query"
                ),
            ));
        }
        let paged = touched.is_empty();
        if after.is_some() && !paged {
            return Ok(Err(Decline::Window));
        }
        let (skip, need) = if paged {
            (q.offset, limit)
        } else {
            (0, window.saturating_add(touched.len() as u64))
        };
        if need > MAX_SELECTED {
            return Ok(Err(Decline::Window));
        }
        // File's adapter: an unmaterialized field is a decline, and so is a
        // complexity overflow: the per-record path answers it (bounded complexity).
        let request = if profile.predicate == Predicate::None {
            None
        } else {
            match QueryIndexRequest::from_profile(
                &profile,
                context,
                self.head,
                u32::try_from(need).unwrap_or(u32::MAX),
                MAX_BYTES.saturating_sub(after.map_or(0, |row| {
                    16 + row
                        .keys
                        .iter()
                        .map(|key| key.key.len() as u64 + 1)
                        .sum::<u64>()
                })),
            ) {
                Ok(r) => Some(QueryIndexRequest {
                    offset: if after.is_some() { 0 } else { skip },
                    after: after.cloned(),
                    ..r
                }),
                Err(StoreError::Full) => {
                    return Ok(Err(Decline::Unsupported(profile::Unsupported::Budget)));
                }
                Err(_) => return Ok(Err(Decline::Field)),
            }
        };

        // ONE cumulative budget (1000 records AND 1 MiB) covers every source this
        // request touches: layered documents, their confirmed bases, and the
        // selected confirmed rows. Charged before copying, never refunded.
        let mut budget = QueryBudget::new(MAX_SELECTED as u32, MAX_BYTES);

        // Confirmed: the first `window` untouched identities in index order.
        let mut confirmed = Vec::new();
        let mut has_more = false;
        if let Some(request) = &request {
            self.trace_query("seek_start");
            let page = self
                .store
                .query_index_page(request)
                .map_err(|e| indexed_err(e, "the selected keys"))?
                .ok_or_else(|| ErrorCode::Unavailable.err("query index unavailable"))?;
            self.trace_query("seek_end");
            if paged {
                validate_keyset_page(request, &page)?;
            }
            has_more = page.has_more;
            confirmed.extend(
                page.rows
                    .into_iter()
                    .filter(|r| !touched.contains(&r.id))
                    .take(usize::try_from(window).unwrap_or(usize::MAX)),
            );
        }

        // Layered: the layered documents, charged before they are parsed and
        // evaluated by the plan itself.
        let mut layered = Vec::new();
        for id in &touched {
            let Some(rec) = lv.record(&convert::uuid(id)) else {
                continue;
            };
            budget
                .charge(1, rec.source.len() as u64)
                .map_err(|e| indexed_err(e, "the pending records"))?;
            let doc = mdbn_core::doc::Document::parse_at(&rec.path, &*rec.source);
            let fm = doc.frontmatter();
            let types = catalog.membership(&rec.path, fm).types;
            let verdict = plan.matches(
                &QueryRecord {
                    path: &rec.path,
                    types: &types,
                    frontmatter: fm,
                    body: Some(doc.body()),
                },
                env,
            );
            if verdict == Verdict::Match {
                layered.push((*id, rec));
            }
        }

        // The store already skipped `offset` when paged.
        let (offset, end) = if paged {
            (0, usize::try_from(limit).unwrap_or(usize::MAX))
        } else {
            (
                usize::try_from(q.offset).unwrap_or(usize::MAX),
                usize::try_from(window).unwrap_or(usize::MAX),
            )
        };
        // Without layered matches the index order is final: hydrate only the page.
        let hydrate: Vec<_> = if layered.is_empty() {
            confirmed
                .iter()
                .skip(offset)
                .take(end - offset.min(end))
                .collect()
        } else {
            confirmed.iter().collect()
        };
        let bytes = hydrate
            .iter()
            .try_fold(0u64, |n, r| n.checked_add(r.encoded_bytes))
            .unwrap_or(u64::MAX);
        if bytes > budget.bytes_left() || hydrate.len() as u64 > u64::from(budget.records_left()) {
            return Err(budget_error("the matching records"));
        }
        let ids: Vec<Uuid> = hydrate.iter().map(|r| r.id).collect();
        self.trace_query("hydrate_start");
        let rows = self
            .store
            .hydrate_query_at(&ids, self.head, &mut budget)
            .map_err(|e| indexed_err(e, "the matching records"))?;
        self.trace_query("hydrate_end");
        let mut by_id: BTreeMap<Uuid, RecordRow> = rows.into_iter().map(|r| (r.id, r)).collect();
        if by_id.len() != ids.len() {
            return Err(ErrorCode::Unavailable.err_with_reason(
                "query_index_stale",
                "the query index changed during the query; retry",
            ));
        }

        let confirmed_view = |r: &RecordRow| {
            record_view(
                catalog,
                &r.id,
                &r.path,
                &r.doc,
                r.modified_seq,
                false,
                include,
            )
        };
        self.trace_query("project_start");
        let records: Vec<RecordView> = if layered.is_empty() {
            ids.iter()
                .filter_map(|id| by_id.remove(id))
                .map(|r| confirmed_view(&r))
                .collect()
        } else {
            let mut keyed = Vec::with_capacity(ids.len() + layered.len());
            for id in &ids {
                if let Some(r) = by_id.remove(id) {
                    let doc = mdbn_core::doc::Document::parse_at(&r.path, &r.doc);
                    let fm = doc.frontmatter().clone();
                    let types = catalog.membership(&r.path, &fm).types;
                    keyed.push((
                        *id,
                        r.path.clone(),
                        fm,
                        types,
                        Source::Confirmed(Box::new(r)),
                    ));
                }
            }
            for (id, rec) in layered {
                let doc = mdbn_core::doc::Document::parse_at(&rec.path, &*rec.source);
                let fm = doc.frontmatter().clone();
                let types = catalog.membership(&rec.path, &fm).types;
                keyed.push((id, rec.path.clone(), fm, types, Source::Layered(rec)));
            }
            keyed.sort_by(|a, b| {
                plan.compare_by_id(
                    (
                        convert::uuid(&a.0),
                        &QueryRecord {
                            path: &a.1,
                            types: &a.3,
                            frontmatter: &a.2,
                            body: None,
                        },
                    ),
                    (
                        convert::uuid(&b.0),
                        &QueryRecord {
                            path: &b.1,
                            types: &b.3,
                            frontmatter: &b.2,
                            body: None,
                        },
                    ),
                )
            });
            keyed
                .into_iter()
                .skip(offset)
                .take(end - offset.min(end))
                .map(|(id, _, _, _, src)| match src {
                    Source::Confirmed(r) => Ok(confirmed_view(&r)),
                    // Already charged above; no second read.
                    Source::Layered(rec) => Ok(record_view(
                        catalog,
                        &id,
                        &rec.path,
                        &rec.source,
                        self.base_seq(&id, &mut budget)?,
                        true,
                        include,
                    )),
                })
                .collect::<ApiResult<_>>()?
        };
        self.trace_query("project_end");
        let frontier = paged.then(|| confirmed.pop()).flatten();
        Ok(Ok(IndexedQueryPage {
            frontier,
            result: QueryResult {
                records,
                cursor: None,
                complete: true,
                as_of: self.view_version,
                // Same as the per-record path for now; exact counts need the layer
                // adjustment (follow-up).
                columns: None,
                total_count: None,
                diagnostics: None,
                view: None,
                groups: None,
                // Exact from the index when paged (no pending edits); otherwise left
                // to the per-record path's semantics.
                has_more: paged.then_some(has_more),
            },
        }))
    }
}

#[cfg(test)]
mod keyset_validation_tests {
    use super::*;
    use crate::store_query::{QueryAtom, QueryColumn, QueryIndexPage, QueryOrder, QueryPredicate};
    use mdbn_wire::common::B16;

    #[test]
    fn keyset_metadata_requires_canonical_keys_strict_advancement_and_exact_bounds() {
        let row = |n| QueryKeyedId {
            id: B16([n; 16]),
            keys: vec![QueryAtom {
                kind: 255,
                key: vec![],
            }],
            encoded_bytes: 1,
        };
        let mut request = QueryIndexRequest {
            generation: [0; 32],
            head: crate::store::Head::GENESIS,
            predicate: QueryPredicate::All,
            order: vec![QueryOrder {
                column: QueryColumn::Path,
                descending: true,
            }],
            after: Some(row(1)),
            limit: 2,
            offset: 0,
            max_key_bytes: 34,
            count_matches: false,
        };
        let page = |rows, has_more| QueryIndexPage {
            rows,
            has_more,
            total_matches: None,
        };
        // DESC does NOT reverse UUID ties; 2*(16-byte UUID+1-byte kind) fits exactly.
        assert!(validate_keyset_page(&request, &page(vec![row(2), row(3)], true)).is_ok());
        for bad in [
            page(vec![], true),
            page(vec![row(1)], false),
            page(vec![row(2), row(2)], false),
            page(vec![row(3), row(2)], false),
            page(vec![row(2), row(3), row(4)], false),
        ] {
            assert!(validate_keyset_page(&request, &bad).is_err());
        }
        request.max_key_bytes = 33;
        assert!(validate_keyset_page(&request, &page(vec![row(2), row(3)], false)).is_err());
        request.max_key_bytes = 34;
        let mut invalid_atom = row(2);
        invalid_atom.keys[0].key.push(0);
        assert!(validate_keyset_page(&request, &page(vec![invalid_atom], false)).is_err());
        let mut wrong_arity = row(2);
        wrong_arity.keys.clear();
        assert!(validate_keyset_page(&request, &page(vec![wrong_arity], false)).is_err());
    }
}
