//! The per-record query path: the complete answer for a query the index
//! declines. Every candidate is evaluated where the scan decoded it, and a match
//! keeps the view built from that one parse, so no record is read by id or
//! parsed a second time.
use super::*;
use std::cmp::Ordering;

use mdbn_core::doc::Document;
use mdbn_core::ids::RecordId;
use mdbn_core::query::QueryPlan;
use mdbn_core::types::Catalog;
use mdbn_core::value::Map;

use crate::replica::submit::{RecordPosition, parsed_record_view};

/// The matches of one query: each with the frontmatter its order reads and its
/// finished view.
///
/// A limited query returns only its first `offset + limit` matches in order,
/// so no more than twice that many are held. The rest are counted for
/// `has_more`, and one that sorts after the rows already kept is counted before
/// a view is built for it.
struct Matched<'p> {
    plan: &'p QueryPlan,
    offset: usize,
    limit: Option<usize>,
    rows: Vec<(Map, RecordView)>,
    /// Every match, held or not.
    total: usize,
    /// `rows[..offset + limit]` is sorted and holds the first matches seen so far.
    settled: bool,
}

fn key(row: &(Map, RecordView)) -> (RecordId, QueryRecord<'_>) {
    (
        convert::uuid(&row.1.id),
        QueryRecord {
            path: &row.1.path,
            types: &row.1.types,
            frontmatter: &row.0,
            body: None,
        },
    )
}

impl<'p> Matched<'p> {
    fn new(plan: &'p QueryPlan) -> Self {
        let size = |n: u64| usize::try_from(n).unwrap_or(usize::MAX);
        Self {
            plan,
            offset: size(plan.query.offset),
            limit: plan.query.limit.map(size),
            rows: Vec::new(),
            total: 0,
            settled: false,
        }
    }

    fn keep(&self) -> Option<usize> {
        self.limit.map(|limit| self.offset.saturating_add(limit))
    }

    fn sort(&mut self) {
        let plan = self.plan;
        self.rows.sort_by(|a, b| {
            let (a, b) = (key(a), key(b));
            plan.compare_by_id((a.0, &a.1), (b.0, &b.1))
        });
    }

    /// Count a match, and say whether it can still be among the rows returned.
    fn admit(&mut self, id: &Uuid, record: &QueryRecord<'_>) -> bool {
        self.total += 1;
        let Some(keep) = self.keep() else {
            return true;
        };
        if keep == 0 {
            return false;
        }
        if !self.settled {
            return true;
        }
        let last = key(&self.rows[keep - 1]);
        let record = QueryRecord {
            body: None,
            ..record.clone()
        };
        self.plan
            .compare_by_id((convert::uuid(id), &record), (last.0, &last.1))
            == Ordering::Less
    }

    fn push(&mut self, frontmatter: Map, view: RecordView) {
        self.rows.push((frontmatter, view));
        if let Some(keep) = self.keep()
            && self.rows.len() >= keep.saturating_mul(2)
        {
            self.sort();
            self.rows.truncate(keep);
            self.settled = true;
        }
    }

    /// The requested window in order, and whether matches remain after it.
    fn window(mut self) -> (Vec<RecordView>, bool) {
        self.sort();
        let start = self.offset.min(self.total);
        let end = match self.limit {
            Some(limit) => start.saturating_add(limit).min(self.total),
            None => self.total,
        };
        let records = self
            .rows
            .into_iter()
            .skip(start)
            .take(end - start)
            .map(|row| row.1)
            .collect();
        (records, end < self.total)
    }
}

impl<S: Store> Replica<S> {
    /// The query's window of matching records and whether more follow it.
    ///
    /// Candidates are the confirmed rows the layer does not override, then the
    /// layer's own records. A budgeted profile charges every source copy (each
    /// candidate row, then each record parsed) and pages small, so it stops near
    /// the budget with an explicit error instead of a partial answer.
    pub(super) fn per_record_window(
        &self,
        plan: &QueryPlan,
        lv: &LayerView<'_>,
        catalog: &Catalog,
        env: &QueryEnv,
        include: &Include,
    ) -> ApiResult<(Vec<RecordView>, bool)> {
        let mut budget = self.fallback_budget();
        let page_limit = if budget.is_some() { 32 } else { 1024 };
        let mut matched = Matched::new(plan);
        let mut consider =
            |id: &Uuid, path: &str, doc: &Document, position: &dyn Fn() -> RecordPosition| {
                let types = catalog.membership(path, doc.frontmatter()).types;
                let record = QueryRecord {
                    path,
                    types: &types,
                    frontmatter: doc.frontmatter(),
                    body: Some(doc.body()),
                };
                if plan.matches(&record, env) != Verdict::Match || !matched.admit(id, &record) {
                    return;
                }
                let pending = self.layer.touches(&convert::uuid(id));
                let view =
                    parsed_record_view(catalog, id, path, doc, types, position(), pending, include);
                matched.push(doc.frontmatter().clone(), view);
            };
        let mut after = None;
        loop {
            let page = self
                .store
                .candidates(
                    &plan.candidate,
                    Page {
                        after,
                        limit: page_limit,
                    },
                )
                .map_err(store_err)?;
            let Some(last) = page.last() else {
                break;
            };
            after = Some(last.id);
            for row in page {
                Self::charge_fallback(&mut budget, row.doc.len())?;
                if self.layer.touches(&convert::uuid(&row.id)) {
                    continue;
                }
                Self::charge_fallback(&mut budget, row.doc.len())?;
                let position = (row.modified_seq, row.mtime);
                let doc = Document::parse_at(&row.path, row.doc);
                consider(&row.id, &row.path, &doc, &|| position);
            }
        }
        for id in self.layer.touched_ids() {
            let Some(record) = lv.record(&id) else {
                continue;
            };
            Self::charge_fallback(&mut budget, record.source.len())?;
            let doc = Document::parse_at(&record.path, &*record.source);
            let id = convert::wuuid(&id);
            consider(&id, &record.path, &doc, &|| {
                // A layered record reports the position of the confirmed row it overrides.
                let confirmed = self.store.record(&id).ok().flatten();
                confirmed.map_or((0, None), |c| (c.modified_seq, c.mtime))
            });
        }
        Ok(matched.window())
    }
}
