//! Trusted projection glue. Optional derived-data failures do not refuse valid
//! authoritative writes. Storage errors are never recategorized as optional.
use super::Replica;
use crate::plan::QueryProjectionContext;
use crate::store::{Store, StoreResult, Tx};
use crate::store_query::QueryIndexTx;
use mdbn_core::query::FieldRef;
use mdbn_wire::common::Sem;
use std::collections::BTreeMap;
use std::sync::Arc;

/// Deliberately bounded initial profile, not an ALL-field feature declaration.
fn capture(resources: &[(String, String)]) -> Option<Arc<QueryProjectionContext>> {
    let sem = mdbn_core::semantics::SEM;
    let preferred = [
        FieldRef::Effective(vec!["priority".into()]),
        FieldRef::Effective(vec!["points".into()]),
    ];
    let context = QueryProjectionContext::capture_declared(
        resources,
        Sem {
            major: sem.major,
            minor: sem.minor,
        },
        &preferred,
        16,
        8192,
    )
    .ok()?;
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
            capture(&resources.into_iter().collect::<Vec<_>>())
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
            bytes = match bytes.checked_add(projected.path.len()).and_then(|n| {
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
        });
        Ok(Some(context))
    }
}

/// Records per backfill transaction; `Store::records` copies whole rows.
/// The page bounds row count; records must also satisfy separate size admission.
/// This count-only request does not enforce pre-copy byte admission.
const BACKFILL_PAGE: u32 = 16;

impl<S: Store> Replica<S> {
    /// Make the maintained index complete for the current confirmed state, when it
    /// is absent, unready, or under another generation (a pre-index store, a
    /// snapshot install, an invalidating transaction). Index-only transactions:
    /// no record, head or receipt changes. The first page replaces the specs; the
    /// last publishes at the current head, and the backend alone decides readiness
    /// from verified coverage. A projection failure leaves the index unready, so
    /// queries keep using the per-record path; store errors propagate.
    pub(crate) fn backfill_query_index(&mut self) -> StoreResult<()> {
        if self.install.is_some() || !self.store.query_index_supported() {
            return Ok(());
        }
        let resources = self.store.resources()?;
        let Some(context) = capture(&resources) else {
            self.query_context = None;
            return Ok(());
        };
        let head = self.store.head()?;
        let fields_ready = self.store.query_index_state()?.is_some_and(|s| {
            s.ready
                && s.generation == context.generation()
                && s.fields == context.fields()
                && s.head == head
        });
        // A newly installed or invalidated raw payload cannot be certified by
        // existing sort-field coverage. Reuse this same bounded backfill loop.
        // None preserves stores that do not implement raw projection reads.
        let raw_ready = self
            .store
            .query_projection_state()?
            .is_none_or(|s| s.ready && s.generation == context.generation() && s.head == head);
        if fields_ready && raw_ready {
            self.query_context = Some(context);
            return Ok(());
        }
        self.query_cursors.clear();
        let mut after = None;
        let mut first = true;
        loop {
            let page = self.store.records(crate::store::Page {
                after,
                limit: BACKFILL_PAGE,
            })?;
            let done = page.len() < BACKFILL_PAGE as usize;
            after = page.last().map(|r| r.id);
            let mut rows = Vec::with_capacity(page.len());
            for row in &page {
                match context.project_row(row) {
                    Ok(r) => rows.push(r),
                    Err(_) => {
                        // Optional: stays unready; the per-record path answers.
                        self.query_context = Some(context);
                        return Ok(());
                    }
                }
            }
            self.store.commit(Tx {
                query_index: Some(QueryIndexTx {
                    generation: context.generation(),
                    replace_specs: first.then(|| context.fields().to_vec()),
                    rows,
                    publish_at: done.then_some(head),
                }),
                ..Tx::default()
            })?;
            first = false;
            if done {
                break;
            }
        }
        self.query_context = Some(context);
        Ok(())
    }
}
