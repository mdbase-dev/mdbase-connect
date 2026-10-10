//! Device-local metadata-move fence. This is not a new Wire operation: a
//! FileMove preserves the authenticated native descriptor; edits/reverse follow
//! only after that move confirms, through fresh same-path capture.

use mdbn_core::plan::{PlanOptions, Stage};
use mdbn_wire::{
    attachment::FileContent,
    attachment_runtime_v1 as rt,
    cbor::{self, Cbor},
    client::Problem,
    common::{Hash, Uuid},
    intent::{FileMove, Op, Source},
    schema::Wire,
    unindexed_markdown::FileKindV1,
};

use super::{
    Replica,
    submit::store_err,
    unindexed_inventory::{Inventory, Roots},
};
use crate::{
    api::{ApiResult, ErrorCode},
    convert,
    layer::LayerView,
    plan::StoreView,
    store::{PendingRow, Store, StoreError, Tx, meta_keys},
};

mod recovery;

pub(super) enum MoveAdmission {
    /// Fresh complete current source refs for verified lost-tail recovery.
    Ready(Vec<Hash>),
    /// Ordinary head refusal; the unacknowledged disk evidence remains.
    Reject(Problem),
    /// Acknowledged recovery ownership must remain pending, not silently skipped.
    Hold(Problem),
}

const MAX_FENCE: usize = 16 * 1024;
const MAX_PATH: usize = 2048;
// Local fences remain available while pending OR own-retained (lost-tail
// fallback input). Bound their total ownership rather than leaking one forever
// per confirmed move. Exhaustion holds the disk evidence, never evicts an owner.
const INDEX_KEY: &str = "native_move_index";
const MAX_FENCES: usize = 256;
const RETAINED_SCAN_PAGES: usize = 64;
type FenceMetadata = Vec<(String, Option<Vec<u8>>)>;

pub(super) fn key(id: &Uuid) -> String {
    format!("native_move/{}", id.to_hex())
}

struct Fence {
    file: Uuid,
    from: String,
    to: String,
    prior: FileContent,
    modified_seq: u64,
    epoch: u64,
    policy_seq: u64,
    catalog: Hash,
}
impl Fence {
    fn bytes(&self) -> ApiResult<Vec<u8>> {
        let bytes = cbor::encode(&Cbor::Array(vec![
            Cbor::Uint(1),
            self.file.to_cbor(),
            self.from.to_cbor(),
            self.to.to_cbor(),
            self.prior.to_cbor(),
            self.modified_seq.to_cbor(),
            self.epoch.to_cbor(),
            self.policy_seq.to_cbor(),
            self.catalog.to_cbor(),
        ]))
        .map_err(|_| ErrorCode::Internal.err("native move fence encoding"))?;
        if bytes.len() > MAX_FENCE {
            return Err(ErrorCode::TooLarge.err("native move fence"));
        }
        Ok(bytes)
    }
    fn read(bytes: &[u8]) -> Result<Self, StoreError> {
        let bad = || StoreError::Corrupt("native move fence".into());
        if bytes.len() > MAX_FENCE {
            return Err(bad());
        }
        let Cbor::Array(v) = cbor::decode(bytes).map_err(|_| bad())? else {
            return Err(bad());
        };
        if v.len() != 9 || v[0] != Cbor::Uint(1) {
            return Err(bad());
        }
        let out = Self {
            file: Uuid::from_cbor(&v[1]).map_err(|_| bad())?,
            from: String::from_cbor(&v[2]).map_err(|_| bad())?,
            to: String::from_cbor(&v[3]).map_err(|_| bad())?,
            prior: FileContent::from_cbor(&v[4]).map_err(|_| bad())?,
            modified_seq: u64::from_cbor(&v[5]).map_err(|_| bad())?,
            epoch: u64::from_cbor(&v[6]).map_err(|_| bad())?,
            policy_seq: u64::from_cbor(&v[7]).map_err(|_| bad())?,
            catalog: Hash::from_cbor(&v[8]).map_err(|_| bad())?,
        };
        if out.from.len() > MAX_PATH || out.to.len() > MAX_PATH || out.epoch == 0 {
            return Err(bad());
        }
        Ok(out)
    }
}
fn changed() -> Problem {
    ErrorCode::Conflict.problem_with_reason(
        "native_move_changed",
        "native move holder or authority changed",
    )
}

impl<S: Store> Replica<S> {
    #[cfg(test)]
    pub(crate) fn test_capture_native_move(
        &mut self,
        file: Uuid,
        from: &str,
        to: &str,
    ) -> ApiResult<()> {
        self.capture_native_move(file, from, to)
    }

    #[cfg(test)]
    pub(crate) fn test_native_move_pending_check(
        &self,
        row: &PendingRow,
    ) -> Result<Option<Problem>, StoreError> {
        self.native_move_pending_check(row)
            .map(|admission| match admission {
                Some(MoveAdmission::Reject(p) | MoveAdmission::Hold(p)) => Some(p),
                Some(MoveAdmission::Ready(_)) | None => None,
            })
    }

    #[cfg(test)]
    pub(crate) fn test_native_move_recovery_refs(
        &self,
        row: &PendingRow,
    ) -> Result<Option<Vec<Hash>>, StoreError> {
        self.native_move_pending_check(row)
            .map(|admission| match admission {
                Some(MoveAdmission::Ready(refs)) => Some(refs),
                _ => None,
            })
    }

    #[cfg(test)]
    pub(crate) fn test_native_move_plan(
        &self,
        row: &PendingRow,
        planned: &mdbn_core::plan::Planned,
    ) -> Result<Option<bool>, StoreError> {
        self.native_move_planned_check(row, planned)
    }

    fn native_move_fences(&self) -> Result<(Vec<Uuid>, FenceMetadata), StoreError> {
        use std::collections::BTreeSet;
        let mut ids = match self.store.meta(INDEX_KEY)? {
            None => Vec::new(),
            Some(raw) => {
                if raw.len() > MAX_FENCES * 17 + 8 {
                    return Err(StoreError::Corrupt("native move index bound".into()));
                }
                let Cbor::Array(values) = cbor::decode(&raw)
                    .map_err(|_| StoreError::Corrupt("native move index".into()))?
                else {
                    return Err(StoreError::Corrupt("native move index".into()));
                };
                if values.len() > MAX_FENCES {
                    return Err(StoreError::Corrupt("native move index count".into()));
                }
                values
                    .iter()
                    .map(|v| {
                        Uuid::from_cbor(v)
                            .map_err(|_| StoreError::Corrupt("native move index ID".into()))
                    })
                    .collect::<Result<Vec<_>, _>>()?
            }
        };
        if ids.iter().copied().collect::<BTreeSet<_>>().len() != ids.len() {
            return Err(StoreError::Corrupt("duplicate native move index ID".into()));
        }
        let mut retained = BTreeSet::new();
        let mut after = 0;
        let mut complete = ids.is_empty();
        if !ids.is_empty() {
            for _ in 0..RETAINED_SCAN_PAGES {
                let page = self.store.own_retained(after, 256)?;
                retained.extend(page.iter().filter_map(|(_, row)| {
                    ids.contains(&row.mutation.id).then_some(row.mutation.id)
                }));
                if page.len() < 256 {
                    complete = true;
                    break;
                }
                let next = page.last().expect("full retained page").0;
                if next <= after {
                    return Err(StoreError::Corrupt(
                        "native move retention pagination".into(),
                    ));
                }
                after = next;
            }
        }
        let mut remove = Vec::new();
        if complete {
            let mut live = Vec::new();
            for id in ids {
                if retained.contains(&id) || self.store.pending_get(&id)?.is_some() {
                    live.push(id);
                } else {
                    remove.push((key(&id), None));
                }
            }
            ids = live;
        }
        // An incomplete bounded scan proves no absence: preserve ALL owners.
        Ok((ids, remove))
    }

    fn native_move_refs(&self, content: &FileContent) -> Result<Option<Vec<Hash>>, StoreError> {
        let mut roots = Roots::default();
        roots.add(content)?;
        match self.native_snapshot_inventory(&roots)? {
            Inventory::Complete(refs) => Ok(Some(refs)),
            Inventory::Pending(_) => Ok(None),
        }
    }

    /// A metadata move never acknowledges disk evidence. Its continuation owns
    /// that evidence until the confirmed holder admits a fresh capture/echo.
    pub(super) fn capture_native_move(
        &mut self,
        file: Uuid,
        from: &str,
        to: &str,
    ) -> ApiResult<()> {
        self.unindexed_capture_admission(from)?;
        self.unindexed_capture_admission(to)?;
        if from.len() > MAX_PATH
            || to.len() > MAX_PATH
            || self.policy.epoch == 0
            || self.policy.seq > self.head.seq
        {
            return Err(ErrorCode::Unavailable.err("native move context is not current"));
        }
        let row = self
            .store
            .file(&file)
            .map_err(store_err)?
            .ok_or_else(|| ErrorCode::Conflict.err("native move holder gone"))?;
        let from_key = mdbn_core::paths::path_key(from);
        let to_key = mdbn_core::paths::path_key(to);
        let reserved = [
            crate::plan::id_key(&file),
            format!("p:{from_key}"),
            format!("p:{to_key}"),
        ];
        // Native metadata rows deliberately carry empty legacy effects. The
        // optimistic Layer therefore cannot reserve these IDs/destinations.
        if self.pending_keys.values().any(|keys| {
            keys.iter()
                .any(|k| reserved.contains(k) || k.starts_with("r:") || k == "s:")
        }) {
            return Err(ErrorCode::Conflict.err("native move has overlapping pending work"));
        }
        if row.kind != FileKindV1::UnindexedOversizedMarkdown
            || row.path != from
            || self.store.file_at(&from_key).map_err(store_err)? != Some(file)
            || self
                .store
                .file_at(&to_key)
                .map_err(store_err)?
                .is_some_and(|id| id != file)
            || self.store.record_at(&to_key).map_err(store_err)?.is_some()
            || self.store.hold(&file).map_err(store_err)?.is_some()
        {
            return Err(ErrorCode::Conflict.err("native move holder/path is not available"));
        }
        let refs = self
            .native_move_refs(&row.content)
            .map_err(store_err)?
            .ok_or_else(|| {
                ErrorCode::Unavailable.err_with_reason(
                    "native_move_inventory_missing",
                    "native source inventory unavailable",
                )
            })?;
        let (mut fence_ids, mut fence_meta) = self.native_move_fences().map_err(store_err)?;
        if fence_ids.len() >= MAX_FENCES {
            return Err(ErrorCode::Unavailable.err_with_reason(
                "native_move_fences_full",
                "native move retention is full; disk evidence remains held",
            ));
        }
        let fence = Fence {
            file,
            from: row.path.clone(),
            to: to.into(),
            prior: row.content.clone(),
            modified_seq: row.modified_seq,
            epoch: self.policy.epoch,
            policy_seq: self.policy.seq,
            catalog: self.unindexed_catalog_stamp()?,
        };
        let fence_bytes = fence.bytes()?;
        // All custody, bounds, descriptor and path checks precede entropy.
        let mut m = self.capture(
            vec![Op::FileMove(FileMove {
                id: file,
                from: from.into(),
                to: to.into(),
                update_refs: false,
                if_revision: Some(row.content.plain_hash()),
            })],
            Source::External,
        );
        m.validated_at = None;
        let m: rt::Mutation = m.into();
        fence_ids.push(m.id);
        let index = cbor::encode(&Cbor::Array(fence_ids.iter().map(Wire::to_cbor).collect()))
            .map_err(|_| ErrorCode::Internal.err("native move index encoding"))?;
        fence_meta.extend([
            (key(&m.id), Some(fence_bytes)),
            (INDEX_KEY.into(), Some(index)),
            (
                meta_keys::COUNTERS.into(),
                super::i64_meta(self.clock_floor),
            ),
        ]);
        let cm = convert::runtime_mutation(&m, &convert::inline_only)
            .map_err(|e| ErrorCode::Internal.err(e.to_string()))?;
        let planned = {
            let view = StoreView::new(&self.store, self.catalog.clone());
            let lv = LayerView {
                base: &view,
                layer: &self.layer,
            };
            let p = self.planner.plan(
                &cm,
                &lv,
                &PlanOptions {
                    stage: Stage::Submit {
                        level: mdbn_core::intent::Level::Error,
                    },
                },
            );
            if let Some(e) = view.error() {
                return Err(store_err(e));
            }
            super::check_paths(p)
                .map_err(|r| crate::api::ApiError::from(super::submit::rejection_problem(&r)))?
        };
        let payload = super::attachment_upload::entry_payload(m.clone(), &planned, None)?;
        if payload.effects.len() != 1
            || !matches!(&payload.effects[0], rt::Effect::PutUnindexedMarkdown(f)
            if f.id == file && f.path == to && f.payload.content == fence.prior)
        {
            return Err(
                ErrorCode::Conflict.err("native move must preserve exact holder and descriptor")
            );
        }
        let mut touches = crate::plan::runtime_mutation_keys(&m);
        touches.extend([format!("p:{from_key}"), format!("p:{to_key}")]);
        touches.sort();
        touches.dedup();
        let order = self.next_order;
        self.commit_unindexed_capture(Tx {
            pending_put: vec![PendingRow {
                order,
                mutation: m.clone(),
                effects: vec![],
                touches: touches.clone(),
                grant: None,
                uploads: vec![],
                refs,
            }],
            meta: fence_meta,
            ..Tx::default()
        })?;
        self.next_order += 1;
        self.touch.add(order, &touches);
        self.pending_keys.insert(order, touches);
        self.status_dirty = true;
        Ok(())
    }

    /// A bounded pending-row hint routes cold/new observations to native ingest.
    /// It proves no current authority: capture/append recheck the full fence.
    pub(super) fn pending_native_move_hint(
        &self,
        path: &str,
    ) -> Result<Option<(String, Uuid)>, StoreError> {
        let path = mdbn_core::paths::path_key(path);
        let reserved = format!("p:{path}");
        if !self
            .pending_keys
            .values()
            .any(|keys| keys.contains(&reserved))
        {
            return Ok(None);
        }
        let mut after = None;
        loop {
            let rows = self.store.pending(after, 256)?;
            for row in &rows {
                let [rt::Op::Legacy(Op::FileMove(op))] = row.mutation.ops.as_slice() else {
                    continue;
                };
                if row.mutation.source != Source::External
                    || mdbn_core::paths::path_key(&op.to) != path
                {
                    continue;
                }
                let Some(raw) = self.store.meta(&key(&row.mutation.id))? else {
                    if !row.refs.is_empty() {
                        return Err(StoreError::Corrupt(
                            "native pending move missing fence".into(),
                        ));
                    }
                    continue;
                };
                let fence = Fence::read(&raw)?;
                if fence.file != op.id || fence.from != op.from || fence.to != op.to {
                    return Err(StoreError::Corrupt("native move hint binding".into()));
                }
                return Ok(Some((fence.from, fence.file)));
            }
            if rows.len() < 256 {
                return Ok(None);
            }
            after = rows.last().map(|row| row.order);
        }
    }

    /// Only a validated local fence selects native metadata-move emission.
    /// Check the actual overlay plan too: another row in this batch is not
    /// allowed to relocate the move or replace its captured descriptor.
    pub(super) fn native_move_planned_check(
        &self,
        row: &PendingRow,
        planned: &mdbn_core::plan::Planned,
    ) -> Result<Option<bool>, StoreError> {
        if row.mutation.source != Source::External
            || !matches!(
                row.mutation.ops.as_slice(),
                [rt::Op::Legacy(Op::FileMove(_))]
            )
        {
            return Ok(None);
        }
        let Some(raw) = self.store.meta(&key(&row.mutation.id))? else {
            return Ok(None);
        };
        let f = Fence::read(&raw)?;
        if self.resurrected.contains_key(&row.mutation.id) {
            let Some(current) = self.store.file(&f.file)? else {
                return Ok(Some(false));
            };
            let exact = current.kind == FileKindV1::UnindexedOversizedMarkdown
                && matches!(planned.effects.as_slice(),
                    [mdbn_core::plan::Effect::PutUnindexedMarkdown { id, path, content }]
                    if convert::wuuid(id) == f.file
                        && convert::wfile_content(content) == current.content
                        && self.unindexed_resurrect_admission(&row.mutation.id, path).is_ok());
            return Ok(Some(exact));
        }
        let exact = matches!(planned.effects.as_slice(),
            [mdbn_core::plan::Effect::PutUnindexedMarkdown { id, path, content }]
                if convert::wuuid(id) == f.file && path == &f.to
                    && convert::wfile_content(content) == f.prior);
        Ok(Some(exact))
    }

    /// Reopen/rebase cannot turn a local move fence into current authority.
    /// Read/corruption failures propagate to the append engine, never rejection.
    pub(super) fn native_move_pending_check(
        &self,
        row: &PendingRow,
    ) -> Result<Option<MoveAdmission>, StoreError> {
        if self.resurrected.contains_key(&row.mutation.id)
            && row.mutation.source == Source::External
            && matches!(
                row.mutation.ops.as_slice(),
                [rt::Op::Legacy(Op::FileMove(_))]
            )
        {
            return self.native_move_recovery_check(row);
        }
        self.native_move_head_check(row)
            .map(|problem| problem.map(MoveAdmission::Reject))
    }

    fn native_move_head_check(&self, row: &PendingRow) -> Result<Option<Problem>, StoreError> {
        if row.mutation.source != Source::External {
            return Ok(None);
        }
        let [rt::Op::Legacy(Op::FileMove(op))] = row.mutation.ops.as_slice() else {
            return Ok(None);
        };
        let raw = self.store.meta(&key(&row.mutation.id))?;
        let current = self.store.file(&op.id)?;
        if raw.is_none()
            && current
                .as_ref()
                .is_none_or(|f| f.kind != FileKindV1::UnindexedOversizedMarkdown)
        {
            return Ok(None);
        }
        let Some(raw) = raw else {
            return Ok(Some(changed()));
        };
        let f = Fence::read(&raw)?;
        if self.unindexed_capture_admission(&f.from).is_err()
            || self.unindexed_capture_admission(&f.to).is_err()
            || self.policy.seq > self.head.seq
            || self.policy.epoch != f.epoch
            || self.policy.seq != f.policy_seq
            || row.grant.is_some()
            || row.mutation.on_behalf.is_some()
            || row.mutation.origin != self.cfg.replica_id
            || op.id != f.file
            || op.from != f.from
            || op.to != f.to
            || op.update_refs
            || op.if_revision != Some(f.prior.plain_hash())
        {
            return Ok(Some(changed()));
        }
        let Some(current) = current else {
            return Ok(Some(changed()));
        };
        if current.kind != FileKindV1::UnindexedOversizedMarkdown
            || current.path != f.from
            || current.content != f.prior
            || current.modified_seq != f.modified_seq
            || self.store.file_at(&mdbn_core::paths::path_key(&f.from))? != Some(f.file)
            || self
                .store
                .file_at(&mdbn_core::paths::path_key(&f.to))?
                .is_some_and(|id| id != f.file)
            || self
                .store
                .record_at(&mdbn_core::paths::path_key(&f.to))?
                .is_some()
            || self.store.hold(&f.file)?.is_some()
        {
            return Ok(Some(changed()));
        }
        let catalog = self
            .unindexed_catalog_stamp()
            .map_err(|e| StoreError::Io(e.to_string()))?;
        if catalog != f.catalog || self.native_move_refs(&f.prior)?.as_ref() != Some(&row.refs) {
            return Ok(Some(changed()));
        }
        Ok(None)
    }
}
