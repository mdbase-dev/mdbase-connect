//! Ordinary native selection on the original Store/layer, not a second engine.
//! Canonical CEL link reads share ONE bounded source account with candidate reads.
//! Candidates are the Store's index-entry superset, as on the per-record path.
//! A record is hydrated and charged at most once per invocation; there is no
//! cross-query source cache, all-record hydration shortcut, SQL or compiler change.
use super::*;
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use mdbn_core::ids::{FileId, Hash as CoreHash, RecordId};
use mdbn_core::intent::FileInclusion;
use mdbn_core::links::{CelLinks, LinkKey};
use mdbn_core::query::{Candidate, QueryPlan};
use mdbn_core::state::{PathHolder, StoredFile, StoredRecord, Tombstone};
use mdbn_core::types::Catalog;
use mdbn_core::value::Value as CoreValue;

use crate::api::ApiError;
use crate::store::{Head, RecordRow, StoreError};
use crate::store_query::QueryBudget;

const MAX_IDS: usize = 1000;

fn exhausted() -> ApiError {
    ErrorCode::TooLarge.err_with_reason(
        "query_budget_exceeded",
        "ordinary selection exceeds its bounded source or retained-value query budget",
    )
}

// A separate deterministic retention account prevents small source rows from
// multiplying large constant selections/projections/sort keys across the scan.
// Fixed structural slack is deliberately conservative and architecture-neutral.
fn retain_bytes(left: &mut u64, bytes: u64) -> ApiResult<()> {
    *left = left.checked_sub(bytes).ok_or_else(exhausted)?;
    Ok(())
}
fn retain_value(left: &mut u64, value: &CoreValue) -> ApiResult<()> {
    retain_bytes(left, 128)?;
    match value {
        CoreValue::Text(text) => retain_bytes(left, text.len() as u64),
        CoreValue::List(values) => values
            .iter()
            .try_for_each(|value| retain_value(left, value)),
        CoreValue::Map(map) => retain_map(left, map),
        _ => Ok(()),
    }
}
fn retain_map(left: &mut u64, map: &mdbn_core::value::Map) -> ApiResult<()> {
    map.iter().try_for_each(|(key, value)| {
        retain_bytes(left, 128 + key.len() as u64)?;
        retain_value(left, value)
    })
}

/// Borrowed, per-invocation reader. Infallible Core lookups latch the FIRST
/// original failure; callers discard every evaluated value on failure.
struct QueryState<'a> {
    store: &'a dyn Store,
    view: &'a LayerView<'a>,
    head: Head,
    budget: RefCell<QueryBudget>,
    error: RefCell<Option<ApiError>>,
    /// Records already admitted by THIS invocation at its captured head, so a
    /// target reached by many links is charged once. Holds only charged source.
    hydrated: RefCell<BTreeMap<RecordId, Option<(StoredRecord, u64)>>>,
}

impl QueryState<'_> {
    fn attempt<T>(&self, read: impl FnOnce() -> ApiResult<T>) -> Option<T> {
        if self.error.borrow().is_some() {
            return None;
        }
        match read() {
            Ok(value) => Some(value),
            Err(error) => {
                *self.error.borrow_mut() = Some(error);
                None
            }
        }
    }

    fn charge(&self, source: &str) -> ApiResult<()> {
        self.budget
            .borrow_mut()
            .charge(1, source.len() as u64)
            .map_err(|_| exhausted())
    }

    fn confirmed(&self, id: &RecordId) -> ApiResult<Option<RecordRow>> {
        // Reserve before entering the Store adapter: a query-account denial is
        // NOT physical storage Full and must never fence TentativeStore.
        // The existing size seam is ID-ordered and head-bound, without BLOBs.
        let wanted = convert::wuuid(id);
        let mut before = wanted;
        let mut has_before = false;
        for byte in before.0.iter_mut().rev() {
            if *byte != 0 {
                *byte -= 1;
                has_before = true;
                break;
            }
            *byte = 255;
        }
        let sizes = self
            .store
            .query_record_sizes_at(
                Page {
                    after: has_before.then_some(before),
                    limit: 1,
                },
                self.head,
            )
            .map_err(store_err)?;
        if sizes.len() > 1 {
            return Err(ErrorCode::Internal.err("invalid query size lookup"));
        }
        let Some(size) = sizes.first().filter(|size| size.id == wanted) else {
            return Ok(None);
        };
        {
            let budget = self.budget.borrow();
            if budget.records_left() == 0 || size.encoded_bytes > budget.bytes_left() {
                return Err(exhausted());
            }
        }
        // hydrate_query_at performs the actual cumulative charge itself, before
        // copying source, under the SAME head and unchanged per-query account.
        let mut rows = self
            .store
            .hydrate_query_at(
                &[convert::wuuid(id)],
                self.head,
                &mut self.budget.borrow_mut(),
            )
            .map_err(|error| match error {
                StoreError::Full => exhausted(),
                other => store_err(other),
            })?;
        if rows.len() > 1
            || rows
                .first()
                .is_some_and(|row| convert::uuid(&row.id) != *id)
        {
            return Err(ErrorCode::Internal.err("invalid bounded query hydration"));
        }
        Ok(rows.pop())
    }

    fn read(&self, id: &RecordId) -> Option<(StoredRecord, u64)> {
        if let Some(hit) = self.hydrated.borrow().get(id) {
            return hit.clone();
        }
        let read = self.attempt(|| {
            if let Some(change) = self.view.layer.record_change(id) {
                let Some(record) = change else {
                    return Ok(None);
                };
                // Charge before cloning an overlay source or deriving its values.
                self.charge(&record.source)?;
                let seq = self.confirmed(id)?.map_or(0, |row| row.modified_seq);
                return Ok(Some((record.clone(), seq)));
            }
            Ok(self.confirmed(id)?.map(|row| {
                (
                    StoredRecord {
                        id: *id,
                        path: row.path,
                        source: Arc::from(row.doc),
                    },
                    row.modified_seq,
                )
            }))
        })?;
        self.hydrated.borrow_mut().insert(*id, read.clone());
        read
    }

    /// Confirmed candidates the layer does not override, plus layered records.
    /// MAX_IDS bounds these candidates, not the whole collection.
    fn ids(&self, candidate: &Candidate) -> ApiResult<Vec<RecordId>> {
        if self.view.layer.touched_count() > MAX_IDS {
            return Err(exhausted());
        }
        let mut ids = BTreeSet::new();
        let mut after = None;
        let all = *candidate == Candidate::All;
        let limit = if all { 128 } else { 32 };
        loop {
            let page: Vec<_> = if all {
                // Metadata only, before any source BLOB is fetched or decoded.
                self.store
                    .query_record_sizes_at(Page { after, limit }, self.head)
                    .map_err(store_err)?
                    .into_iter()
                    .map(|meta| meta.id)
                    .collect()
            } else {
                // The per-record path's index-entry superset, in small pages.
                // Only IDs are kept; each source is admitted later by `read`.
                self.store
                    .candidates(candidate, Page { after, limit })
                    .map_err(store_err)?
                    .into_iter()
                    .map(|row| row.id)
                    .collect()
            };
            if page.len() > limit as usize {
                return Err(ErrorCode::Internal.err("invalid query size page"));
            }
            if page.is_empty() {
                break;
            }
            for id in page {
                if after.is_some_and(|after| id <= after) {
                    return Err(ErrorCode::Internal.err("invalid query size frontier"));
                }
                after = Some(id);
                if !self.view.layer.touches(&convert::uuid(&id)) {
                    if ids.len() == MAX_IDS {
                        return Err(exhausted());
                    }
                    ids.insert(convert::uuid(&id));
                }
            }
        }
        for (id, change) in self.view.layer.record_changes() {
            if change.is_some() {
                if ids.len() == MAX_IDS {
                    return Err(exhausted());
                }
                ids.insert(*id);
            }
        }
        Ok(ids.into_iter().collect())
    }

    fn index_ids(&self, lookup: impl FnOnce() -> Vec<RecordId>) -> Vec<RecordId> {
        self.attempt(|| {
            // The existing index contains record identities, with unique (key,id).
            // Preflight its maximum possible output BEFORE that index allocates.
            // Layer indexes parse source, so admit those reads before delegating.
            let count = self.store.record_count().map_err(store_err)?;
            if count.saturating_add(self.view.layer.touched_count() as u64) > MAX_IDS as u64 {
                return Err(exhausted());
            }
            for (_, change) in self.view.layer.record_changes() {
                if let Some(record) = change {
                    self.charge(&record.source)?
                }
            }
            let ids = lookup();
            if ids.len() > MAX_IDS {
                return Err(exhausted());
            }
            Ok(ids)
        })
        .unwrap_or_default()
    }
}

impl StateView for QueryState<'_> {
    fn catalog(&self) -> Arc<Catalog> {
        self.view.catalog()
    }
    fn record(&self, id: &RecordId) -> Option<StoredRecord> {
        self.read(id).map(|(record, _)| record)
    }
    // asFile's domain is records. Do not expand a record READ into file access,
    // especially for a grant's independently folder-scoped file namespace.
    fn file(&self, _: &FileId) -> Option<StoredFile> {
        None
    }
    fn tombstone(&self, _: &RecordId) -> Option<Tombstone> {
        None
    }
    fn at_path_key(&self, path: &str) -> Option<PathHolder> {
        match self.view.at_path_key(path) {
            Some(holder @ PathHolder::Record(_)) => Some(holder),
            _ => None,
        }
    }
    fn alias(&self, path: &str) -> Option<RecordId> {
        self.view.alias(path)
    }
    fn resource(&self, _: &str) -> Option<Arc<str>> {
        None
    }
    fn resource_paths(&self) -> Vec<String> {
        Vec::new()
    }
    fn settings(&self) -> FileInclusion {
        self.view.settings()
    }
    fn retained_body(&self, _: &CoreHash) -> Option<String> {
        None
    }
    fn referrers(&self, keys: &[LinkKey]) -> Vec<RecordId> {
        self.index_ids(|| self.view.referrers(keys))
    }
    fn link_targets(&self, keys: &[LinkKey]) -> Vec<RecordId> {
        self.index_ids(|| self.view.link_targets(keys))
    }
    fn with_value(&self, field: &str, value: &CoreValue) -> Vec<RecordId> {
        self.index_ids(|| self.view.with_value(field, value))
    }
    fn record_ids(&self) -> Vec<RecordId> {
        self.attempt(|| self.ids(&Candidate::All))
            .unwrap_or_default()
    }
}

impl<S: Store> Replica<S> {
    pub(super) fn run_projected_query(
        &self,
        plan: &QueryPlan,
        view: &StoreView<'_>,
        layer: &LayerView<'_>,
        env: &QueryEnv,
        include: &Include,
    ) -> ApiResult<QueryResult> {
        // This previously unsupported producer is bounded even for a desktop
        // host's explicit legacy unbounded non-selection compatibility path.
        let state = QueryState {
            store: &self.store,
            view: layer,
            head: self.head,
            budget: RefCell::new(self.fallback_budget().unwrap_or(QueryBudget::HOSTED)),
            error: RefCell::new(None),
            hydrated: RefCell::new(BTreeMap::new()),
        };
        let catalog = state.catalog();
        // Stored index entries follow the confirmed, clock-free catalogue. A
        // layered catalogue or a time-dependent `match.expr` can change this
        // query's membership, so those keep the complete scan.
        let candidate = if self.layer.catalog_ref().is_some()
            || catalog
                .issues()
                .iter()
                .any(|issue| issue.code == "nondeterministic_match")
        {
            &Candidate::All
        } else {
            &plan.candidate
        };
        let links = CelLinks::new(&state);
        let mut rows = Vec::new();
        let mut diagnostics = Vec::new();
        let mut retained_left = 1 << 20;
        for id in state.ids(candidate)? {
            let Some((record, seq)) = state.read(&id) else {
                continue;
            };
            let doc = mdbn_core::doc::Document::parse_at(&record.path, &*record.source);
            let fm = doc.frontmatter();
            let types = catalog
                .membership_at(&record.path, fm, Some(&env.op_clock()))
                .types;
            let mut evaluated = plan.evaluate(
                &QueryRecord {
                    path: &record.path,
                    types: &types,
                    frontmatter: fm,
                    body: Some(doc.body()),
                },
                env,
                Some(&links),
            );
            if let Some(error) = state.error.borrow_mut().take() {
                return Err(error);
            }
            for issue in &evaluated.diagnostics {
                retain_bytes(
                    &mut retained_left,
                    256 + issue.code.len() as u64 + issue.message.len() as u64,
                )?;
                if let Some(details) = &issue.details {
                    retain_value(&mut retained_left, details)?;
                }
            }
            if let Verdict::Error(issue) = &evaluated.verdict {
                retain_bytes(
                    &mut retained_left,
                    256 + issue.code.len() as u64 + issue.message.len() as u64,
                )?;
                if let Some(details) = &issue.details {
                    retain_value(&mut retained_left, details)?;
                }
            }
            if evaluated.verdict == Verdict::Match {
                retain_map(&mut retained_left, &evaluated.projections)?;
                retain_map(&mut retained_left, &evaluated.values)?;
                for key in evaluated.sort_keys.iter().flatten() {
                    retain_value(&mut retained_left, key)?;
                }
                retain_bytes(
                    &mut retained_left,
                    256 + 128 * evaluated.sort_hints.len() as u64,
                )?;
            }
            diagnostics.append(&mut evaluated.diagnostics);
            match &evaluated.verdict {
                Verdict::Match => rows.push((record, seq, evaluated)),
                Verdict::Error(issue) => diagnostics.push(issue.clone()),
                Verdict::NoMatch => {}
            }
        }
        if let Some(error) = state.error.borrow_mut().take() {
            return Err(error);
        }
        if let Some(error) = view.error() {
            return Err(store_err(error));
        }
        if self.store.head().map_err(store_err)? != state.head {
            return Err(ErrorCode::Conflict
                .err_with_reason("query_index_stale", "original query head changed"));
        }
        rows.sort_by(|a, b| plan.compare_evaluated_by_id((a.0.id, &a.2), (b.0.id, &b.2)));
        let start = usize::try_from(plan.query.offset)
            .unwrap_or(usize::MAX)
            .min(rows.len());
        let end = plan.query.limit.map_or(rows.len(), |limit| {
            start
                .saturating_add(usize::try_from(limit).unwrap_or(usize::MAX))
                .min(rows.len())
        });
        let records = rows[start..end]
            .iter()
            .map(|(record, seq, evaluated)| {
                let id = convert::wuuid(&record.id);
                let mut value = super::super::submit::record_view(
                    &catalog,
                    &id,
                    &record.path,
                    &record.source,
                    *seq,
                    self.layer.touches(&record.id),
                    include,
                );
                if !plan.query.select.is_empty() {
                    value.values = Some(convert::wmap(&evaluated.values))
                }
                value
            })
            .collect();
        let diagnostics = diagnostics
            .iter()
            .map(|issue| Issue {
                code: issue.code.clone(),
                severity: match issue.severity {
                    mdbn_core::validate::Severity::Error => mdbn_wire::client::Severity::Error,
                    mdbn_core::validate::Severity::Warning => mdbn_wire::client::Severity::Warning,
                },
                message: issue.message.clone(),
                details: issue.details.as_ref().map(convert::wvalue),
            })
            .collect();
        Ok(QueryResult {
            records,
            cursor: None,
            complete: self.install.is_none(),
            as_of: self.view_version,
            columns: (!plan.query.select.is_empty())
                .then(|| plan.columns().into_iter().map(|(name, _)| name).collect()),
            total_count: None,
            diagnostics: Some(diagnostics),
            view: None,
            groups: None,
            has_more: None,
        })
    }
}
