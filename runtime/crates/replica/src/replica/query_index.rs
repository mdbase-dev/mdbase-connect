//! Trusted projection glue. Optional derived-data failures do not refuse valid
//! authoritative writes. Storage errors are never recategorized as optional.
use super::Replica;
use crate::plan::QueryProjectionContext;
use crate::store::{Head, RecordRow, Store, StoreResult, Tx};
use crate::store_query::{MAX_TX_BODY_BYTES, QueryIndexTx, QueryIndexedRow};
use mdbn_core::query::FieldRef;
use mdbn_wire::common::Sem;
use std::collections::BTreeMap;
use std::sync::Arc;

/// Deliberately bounded initial profile, not an ALL-field feature declaration.
/// `excluded` fields are left out: a record's value of each is longer than an
/// index key, so the index cannot cover it (queries naming it use the
/// per-record path) but still serves every other query. `file.body` among
/// them leaves out the body index the same way.
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
    if excluded.contains(&body_field()) {
        context = context.without_body();
    }
    // A `match.expr` type is indexed like any other: the catalog drops one that
    // reads the clock, file times or other records (`nondeterministic_match`),
    // so membership is a function of the record and the captured resources.
    Some(Arc::new(context))
}
/// Longest sort key one indexed field value may have.
const MAX_KEY_BYTES: usize = 8192;
/// `file.body`, as an exclusion: some body is too long for the body index.
fn body_field() -> FieldRef {
    FieldRef::File("body".into())
}
impl<S: Store> Replica<S> {
    /// Prepare the exact post-resource-effect context and rows for SAME-Tx
    /// maintenance. Publish the returned context only after commit succeeds.
    pub(crate) fn prepare_query_index(
        &self,
        tx: &mut Tx,
    ) -> StoreResult<Option<Arc<QueryProjectionContext>>> {
        if self.is_hosted() && !self.store.query_index_supported() {
            return Ok(None);
        }
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
        let mut body_bytes = 0usize;
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
            body_bytes += projected.body.as_ref().map_or(0, String::len);
            if body_bytes > MAX_TX_BODY_BYTES {
                tx.query_index = None;
                return Ok(Some(context));
            }
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
/// Records per page of a device's catalog rebuild, which always held this many.
const REINDEX_PAGE: u32 = 128;
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

/// Projected `rows` in order, split so no transaction writes more than
/// [`MAX_TX_BODY_BYTES`] of body text. Each body is at most half of that.
/// No rows make one empty batch, as [`byte_batches`].
fn body_batches(rows: Vec<QueryIndexedRow>) -> Vec<Vec<QueryIndexedRow>> {
    let mut batches = vec![Vec::new()];
    let mut bytes = 0usize;
    for row in rows {
        let cost = row.body.as_ref().map_or(0, String::len);
        let current = batches.last_mut().expect("at least one batch");
        if bytes + cost > MAX_TX_BODY_BYTES {
            batches.push(vec![row]);
            bytes = cost;
        } else {
            current.push(row);
            bytes += cost;
        }
    }
    batches
}

/// Project `rows` for `context`, or the fields whose value is too long for a
/// key when one cannot be (none when it fails for another reason).
fn project(
    context: &QueryProjectionContext,
    rows: &[RecordRow],
) -> Result<Vec<QueryIndexedRow>, Option<Vec<FieldRef>>> {
    rows.iter()
        .map(|row| {
            // Optional: stays unready; the per-record path answers.
            context.project_row(row).map_err(|_| {
                let wide = context.too_wide_fields(row);
                (!wide.is_empty()).then_some(wide)
            })
        })
        .collect()
}

/// Which records a [`Replica::reindex`] writes back.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum Reindex {
    /// Every record: the stored representation of their metadata changed.
    All,
    /// Records whose metadata the catalog changed.
    Changed,
}

impl<S: Store> Replica<S> {
    pub(super) fn backfill_query_index_within_budget(&mut self) -> StoreResult<()> {
        match self.backfill_query_index() {
            Err(crate::store::StoreError::Full) => {
                self.query_context = None;
                self.incident(
                    mdbn_wire::client::IncidentKind::Integrity,
                    Some(mdbn_wire::common::Value::Text(
                        "store: query index backfill: over budget".into(),
                    )),
                );
                Ok(())
            }
            result => result,
        }
    }

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
            // It may also have been built without bodies.
            let without_body = context
                .indexes_body()
                .then(|| [missing.clone(), vec![body_field()]].concat());
            for left_out in [missing].into_iter().chain(without_body) {
                if left_out.is_empty() {
                    continue;
                }
                let excluded = [self.query_index_excluded.clone(), left_out].concat();
                if let Some(narrower) = capture(&resources, &excluded)
                    && narrower.generation() == s.generation
                {
                    self.query_index_excluded = excluded;
                    context = narrower;
                    break;
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
        while let Some(wide) = self.with_deferred_durability(|r| {
            r.backfill_pass(Some(&context), head, None, BACKFILL_PAGE)
        })? {
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

    /// Rebuild a device's derived data under the current catalog in one pass:
    /// one read of each record, one publication of the query index at the end.
    /// With `rederive`, every record's metadata is computed again and the rows
    /// it selects are written back, and the catalog's stamp is written last, so
    /// a crash leaves the stamp missing and the next open reindexes again. A
    /// too-long value leaves the index unready for the caller's backfill to
    /// narrow; the metadata pass still completes. Without a maintained index
    /// (unsupported, installing) only metadata is written.
    pub(super) fn reindex(&mut self, rederive: Option<Reindex>) -> StoreResult<()> {
        self.with_deferred_durability(|r| {
            let context = if r.install.is_some() || !r.store.query_index_supported() {
                None
            } else {
                capture(&r.store.resources()?, &r.query_index_excluded)
            };
            if rederive.is_none() && context.is_none() {
                return Ok(());
            }
            let head = r.store.head()?;
            r.backfill_pass(context.as_deref(), head, rederive, REINDEX_PAGE)?;
            Ok(())
        })
    }

    /// One full pass in record order, `page` records at a time. With `rederive`, every record's metadata
    /// is computed again and the rows it selects are written in the same
    /// transaction as their projection. With `context`, every record is
    /// projected for it: the first transaction replaces the specs, the last
    /// publishes at `head`.
    ///
    /// A record that cannot be projected for the field index stops the
    /// projection, leaving the index unready: the result is the fields whose
    /// value is too long for a key, so the caller can leave them out, else
    /// none. Without `rederive` the pass returns there; with it, the remaining
    /// pages still rederive metadata, and the catalog's stamp is written last.
    fn backfill_pass(
        &mut self,
        mut context: Option<&QueryProjectionContext>,
        head: Head,
        rederive: Option<Reindex>,
        page: u32,
    ) -> StoreResult<Option<Vec<FieldRef>>> {
        let mut after = None;
        let mut first = true;
        let mut wide = None;
        loop {
            let rows = self
                .store
                .records(crate::store::Page { after, limit: page })?;
            let done = rows.len() < page as usize;
            after = rows.last().map(|r| r.id);
            if rederive.is_some() {
                self.stats.reindexed += rows.len() as u64;
            }
            let mut txs = Vec::new();
            for mut batch in byte_batches(rows) {
                let mut write = vec![false; batch.len()];
                if let Some(which) = rederive {
                    for (row, write) in batch.iter_mut().zip(&mut write) {
                        let meta = crate::plan::record_meta(&self.catalog, &row.path, &row.doc);
                        *write = which == Reindex::All || row.meta != meta;
                        row.meta = meta;
                    }
                }
                let projected = match context {
                    Some(c) => match project(c, &batch) {
                        Ok(rows) => Some((c, rows)),
                        Err(too_wide) => {
                            if rederive.is_none() {
                                return Ok(too_wide);
                            }
                            wide = too_wide;
                            context = None;
                            None
                        }
                    },
                    None => None,
                };
                let mut put: BTreeMap<_, _> = batch
                    .into_iter()
                    .zip(write)
                    .filter(|(_, write)| *write)
                    .map(|(row, _)| (row.id, row))
                    .collect();
                let Some((c, rows)) = projected else {
                    if !put.is_empty() {
                        txs.push(Tx {
                            records_put: put.into_values().collect(),
                            ..Tx::default()
                        });
                    }
                    continue;
                };
                for rows in body_batches(rows) {
                    txs.push(Tx {
                        // A written row carries its projection in the same
                        // transaction, as the store requires.
                        records_put: rows.iter().filter_map(|r| put.remove(&r.id)).collect(),
                        query_index: Some(QueryIndexTx {
                            generation: c.generation(),
                            replace_specs: first.then(|| c.fields().to_vec()),
                            rows,
                            publish_at: None,
                            completes_backfill: false,
                        }),
                        ..Tx::default()
                    });
                    first = false;
                }
            }
            if done {
                if let Some(update) = txs.last_mut().and_then(|tx| tx.query_index.as_mut())
                    && context.is_some()
                {
                    update.publish_at = Some(head);
                    update.completes_backfill = true;
                }
                if rederive.is_some() {
                    let stamp = crate::plan::record_meta_stamp(&self.catalog);
                    if txs.is_empty() {
                        txs.push(Tx::default());
                    }
                    let last = txs.last_mut().expect("a transaction");
                    last.meta
                        .push((crate::store::meta_keys::RECORD_META.into(), Some(stamp)));
                }
            }
            for tx in txs {
                self.store.commit(tx)?;
            }
            if done {
                return Ok(wide);
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
