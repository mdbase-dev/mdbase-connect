//! Trusted projection glue. Optional derived-data failures do not refuse valid
//! authoritative writes. Storage errors are never recategorized as optional.
use super::Replica;
use crate::plan::QueryProjectionContext;
use crate::store::{Head, RecordRow, Store, StoreResult, Tx};
use crate::store_query::QueryIndexTx;
use mdbn_core::query::FieldRef;
use mdbn_wire::common::Sem;
use std::collections::BTreeMap;
use std::sync::Arc;

/// Deliberately bounded initial profile, not an ALL-field feature declaration.
/// `excluded` fields are left out: a record's value of each is longer than an
/// index key, so the index cannot cover it (queries naming it use the
/// per-record path) but still serves every other query.
fn capture(
    resources: &[(String, String)],
    excluded: &[FieldRef],
) -> Option<Arc<QueryProjectionContext>> {
    let sem = mdbn_core::semantics::SEM;
    let sem = Sem {
        major: sem.major,
        minor: sem.minor,
    };
    let preferred = [
        FieldRef::Effective(vec!["priority".into()]),
        FieldRef::Effective(vec!["points".into()]),
    ];
    let mut context =
        QueryProjectionContext::capture_declared(resources, sem, &preferred, 16, MAX_KEY_BYTES)
            .ok()?;
    if context.field_refs().iter().any(|f| excluded.contains(f)) {
        let kept: Vec<FieldRef> = context
            .field_refs()
            .iter()
            .filter(|f| !excluded.contains(f))
            .cloned()
            .collect();
        context = QueryProjectionContext::capture(resources, sem, &kept, MAX_KEY_BYTES).ok()?;
    }
    // Type-match expressions need clock/dependency eligibility qualification.
    // Conservatively disable this optional profile rather than label ClockNone
    // membership as complete/current for arbitrary expressions.
    if context
        .catalog()
        .types()
        .iter()
        .any(|t| t.match_spec.as_ref().is_some_and(|m| m.expr.is_some()))
    {
        return None;
    }
    Some(Arc::new(context))
}
/// Longest sort key one indexed field value may have.
const MAX_KEY_BYTES: usize = 8192;
impl<S: Store> Replica<S> {
    /// Prepare the exact post-resource-effect context and rows for SAME-Tx
    /// maintenance. Publish the returned context only after commit succeeds.
    pub(crate) fn prepare_query_index(
        &self,
        tx: &mut Tx,
    ) -> StoreResult<Option<Arc<QueryProjectionContext>>> {
        let resources_changed =
            !tx.resources_put.is_empty() || !tx.resources_del.is_empty() || tx.clear_confirmed;
        let context = if resources_changed || self.query_context.is_none() {
            let mut resources: BTreeMap<String, String> = if tx.clear_confirmed {
                BTreeMap::new()
            } else {
                self.store.resources()?.into_iter().collect()
            };
            for path in &tx.resources_del {
                resources.remove(path);
            }
            for (path, doc) in &tx.resources_put {
                resources.insert(path.clone(), doc.clone());
            }
            capture(
                &resources.into_iter().collect::<Vec<_>>(),
                &self.query_index_excluded,
            )
        } else {
            self.query_context.clone()
        };
        let Some(context) = context else {
            tx.query_index = None;
            return Ok(None);
        };
        let mut rows = Vec::new();
        // Validation before retaining optional projections. Backend also caps
        // statements/total bytes; a too-wide projection must not lose the ACK.
        if tx.records_put.len() > 500 {
            tx.query_index = None;
            return Ok(Some(context));
        }
        let mut bytes = 0usize;
        for row in &tx.records_put {
            let Ok(projected) = context.project_row(row) else {
                tx.query_index = None;
                return Ok(Some(context));
            };
            // The store writes the path once for the record and once per field.
            bytes = match projected
                .path
                .len()
                .checked_mul(1 + projected.fields.len())
                .and_then(|n| bytes.checked_add(n))
                .and_then(|n| {
                    projected.fields.iter().try_fold(n, |n, f| {
                        n.checked_add(f.atom.key.len() + f.field.path_key.len())
                    })
                }) {
                Some(n) if n <= 512 << 10 => n,
                _ => {
                    tx.query_index = None;
                    return Ok(Some(context));
                }
            };
            rows.push(projected);
        }
        // Genuine SQL/storage failures propagate. None is not a full-row fallback.
        let existing = self.store.query_index_state()?;
        let replace = resources_changed
            || existing.as_ref().is_none_or(|s| {
                s.generation != context.generation() || s.fields != context.fields()
            });
        tx.query_index = Some(QueryIndexTx {
            generation: context.generation(),
            replace_specs: replace.then(|| context.fields().to_vec()),
            rows,
            publish_at: Some(tx.head.unwrap_or(self.head)),
            completes_backfill: false,
        });
        Ok(Some(context))
    }
}

/// Records per backfill transaction; `Store::records` returns whole rows.
/// SqlStore transports them in byte-bounded groups, but this requested page is
/// still retained in memory. Record admission and heap bounds remain separate.
const BACKFILL_PAGE: u32 = 16;
/// Documents one transaction may rewrite or project. A hosted request carries at
/// most 4 MiB, and a row's SQL (links, index rows, raw fields) costs more than
/// its document, so this leaves the room a full 128-record page would not.
const TX_DOCUMENT_BYTES: usize = 1 << 20;

/// `rows` in order, split so no transaction exceeds [`TX_DOCUMENT_BYTES`]. A
/// single larger document keeps its own transaction. No rows make one empty
/// batch: a backfill's last page may have only publication left to do.
pub(crate) fn byte_batches(rows: Vec<RecordRow>) -> Vec<Vec<RecordRow>> {
    let mut batches = vec![Vec::new()];
    let mut bytes = 0usize;
    for row in rows {
        let cost = row.doc.len().saturating_add(row.path.len());
        let current = batches.last_mut().expect("at least one batch");
        if !current.is_empty() && cost > TX_DOCUMENT_BYTES.saturating_sub(bytes) {
            batches.push(vec![row]);
            bytes = cost;
        } else {
            current.push(row);
            bytes = bytes.saturating_add(cost);
        }
    }
    batches
}

impl<S: Store> Replica<S> {
    /// Make the maintained index complete for the current confirmed state, when it
    /// is absent, unready, or under another generation (a pre-index store, a
    /// snapshot install, an invalidating transaction). Index-only transactions:
    /// no record, head or receipt changes. The first page replaces the specs; the
    /// last publishes at the current head, and the backend alone decides readiness
    /// from verified coverage. A projection failure leaves the index unready, so
    /// queries keep using the per-record path; store errors propagate.
    ///
    /// A raw projection the backend reports settled (a complete pass found some
    /// records unprojectable and nothing invalidated it since) is not rebuilt:
    /// another pass would end in the same unready state. It is still unready, so
    /// raw pages are never served for it.
    pub(crate) fn backfill_query_index(&mut self) -> StoreResult<()> {
        if self.install.is_some() || !self.store.query_index_supported() {
            return Ok(());
        }
        let resources = self.store.resources()?;
        let Some(mut context) = capture(&resources, &self.query_index_excluded) else {
            self.query_context = None;
            return Ok(());
        };
        let head = self.store.head()?;
        let state = self.store.query_index_state()?;
        // A ready index built without some declared fields (a value too long
        // for an index key) is reused on reopen, not rebuilt to find them again.
        if let Some(s) = state
            .as_ref()
            .filter(|s| s.ready && s.head == head && s.generation != context.generation())
        {
            let missing: Vec<FieldRef> = context
                .field_refs()
                .iter()
                .zip(context.fields())
                .filter(|(_, declared)| !s.fields.contains(declared))
                .map(|(field, _)| field.clone())
                .collect();
            if !missing.is_empty() {
                let excluded = [self.query_index_excluded.clone(), missing].concat();
                if let Some(narrower) = capture(&resources, &excluded)
                    && narrower.generation() == s.generation
                {
                    self.query_index_excluded = excluded;
                    context = narrower;
                }
            }
        }
        let fields_ready = state.is_some_and(|s| {
            s.ready
                && s.generation == context.generation()
                && s.fields == context.fields()
                && s.head == head
        });
        // A newly installed or invalidated raw payload cannot be certified by
        // existing sort-field coverage. Reuse this same bounded backfill loop.
        // None preserves stores that do not implement raw projection reads.
        let raw_complete = self.store.query_projection_state()?.is_none_or(|s| {
            (s.ready || s.settled) && s.generation == context.generation() && s.head == head
        });
        if fields_ready && raw_complete {
            self.query_context = Some(context);
            return Ok(());
        }
        self.query_cursors.clear();
        // Each pass that meets a too-long value leaves that field out and starts
        // again; every restart drops at least one of the bounded declared fields.
        while let Some(wide) = self.with_deferred_durability(|r| r.backfill_pass(&context, head))? {
            self.query_index_excluded.extend(wide);
            let Some(narrower) = capture(&resources, &self.query_index_excluded) else {
                self.query_context = None;
                return Ok(());
            };
            context = narrower;
        }
        self.query_context = Some(context);
        Ok(())
    }

    /// One full backfill pass. Returns early, leaving the index unready, when a
    /// record cannot be projected for the field index: with the fields whose
    /// value is too long for a key, so the caller can leave them out, else none.
    fn backfill_pass(
        &mut self,
        context: &QueryProjectionContext,
        head: Head,
    ) -> StoreResult<Option<Vec<FieldRef>>> {
        let mut after = None;
        let mut first = true;
        loop {
            let page = self.store.records(crate::store::Page {
                after,
                limit: BACKFILL_PAGE,
            })?;
            let done = page.len() < BACKFILL_PAGE as usize;
            after = page.last().map(|r| r.id);
            let batches = byte_batches(page);
            let last = batches.len() - 1;
            for (at, batch) in batches.iter().enumerate() {
                let mut rows = Vec::with_capacity(batch.len());
                for row in batch {
                    match context.project_row(row) {
                        Ok(r) => rows.push(r),
                        // Optional: stays unready; the per-record path answers.
                        Err(_) => {
                            let wide = context.too_wide_fields(row);
                            return Ok((!wide.is_empty()).then_some(wide));
                        }
                    }
                }
                let completes = done && at == last;
                self.store.commit(Tx {
                    query_index: Some(QueryIndexTx {
                        generation: context.generation(),
                        replace_specs: first.then(|| context.fields().to_vec()),
                        rows,
                        publish_at: completes.then_some(head),
                        completes_backfill: completes,
                    }),
                    ..Tx::default()
                })?;
                first = false;
            }
            if done {
                return Ok(None);
            }
        }
    }

    /// Run derived-data rebuild commits (backfill, reindex) inside one
    /// deferred-durability window: one barrier instead of one per page. Safe
    /// because every commit in it can be redone from authoritative rows: their
    /// completion stamps (index publication, derived/record-meta versions) are
    /// written last, and durability is prefix-ordered, so a crash leaves them
    /// unstamped and the next open redoes the work. A window the caller already
    /// holds is left to the caller. Closing is a barrier and is attempted even
    /// after a failure.
    pub(super) fn with_deferred_durability<T>(
        &mut self,
        work: impl FnOnce(&mut Self) -> StoreResult<T>,
    ) -> StoreResult<T> {
        if self.store.durability_deferred() {
            return work(self);
        }
        self.store.defer_durability(true)?;
        let result = work(self);
        let closed = self.store.defer_durability(false);
        let value = result?;
        closed?;
        Ok(value)
    }
}
