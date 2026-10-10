//! Explicit reverse16 capture after fresh bounded-source and Core admission.
use super::{PreparedUnindexedReindexUpload, Replica};
use crate::{
    api::{ApiError, ApiResult, ErrorCode},
    convert,
    store::{ObservationId, PendingRow, Store, Tx, meta_keys},
};
use mdbn_wire::{
    attachment_runtime_v1 as rt,
    client::Receipt,
    common::B32,
    intent::{Level, OpClock, Source},
};
impl<S: Store> Replica<S> {
    /// Prepared objects prove data only; repeat current authority and Core checks.
    pub fn capture_prepared_unindexed_reindex_upload(
        &mut self,
        p: PreparedUnindexedReindexUpload,
    ) -> ApiResult<Receipt> {
        self.capture_unindexed_reverse_body(p, None)
    }
    pub(super) fn capture_observed_unindexed_reindex_upload(
        &mut self,
        p: PreparedUnindexedReindexUpload,
        token: ObservationId,
    ) -> ApiResult<Receipt> {
        self.capture_unindexed_reverse_body(p, Some(token))
    }
    #[cfg(test)]
    pub(crate) fn test_capture_prepared_unindexed_reindex_upload(
        &mut self,
        p: PreparedUnindexedReindexUpload,
    ) -> ApiResult<Receipt> {
        self.capture_unindexed_reverse_body(p, None)
    }
    fn capture_unindexed_reverse_body(
        &mut self,
        p: PreparedUnindexedReindexUpload,
        observation: Option<ObservationId>,
    ) -> ApiResult<Receipt> {
        use mdbn_core::plan::{PlanOptions, Stage};
        self.recheck_prepared_unindexed_reindex_upload(&p)?;
        let id = self.mint_v7();
        let instant = self.capture_instant();
        let tz = self.host.zones.default_zone();
        let local_date = self
            .host
            .zones
            .local_date(instant, &tz)
            .ok_or_else(|| ErrorCode::Internal.err("no local date"))?;
        let mut seed = [0; 32];
        self.host.entropy.fill(&mut seed);
        let m = rt::Mutation {
            id,
            origin: self.cfg.replica_id,
            base_seq: self.head.seq,
            clock: OpClock {
                instant,
                tz,
                local_date,
            },
            seed: B32(seed),
            source: if observation.is_some() {
                Source::External
            } else {
                Source::Api
            },
            ops: vec![p.proof.operation()],
            on_behalf: None,
            conflict_mode: None,
            validated_at: observation.is_none().then_some(Level::Error),
            room: None,
        };
        let planned = {
            let cm = convert::runtime_mutation(&m, &convert::inline_only)
                .map_err(|e| ErrorCode::InvalidRequest.err(e.to_string()))?;
            let view = crate::plan::StoreView::new(&self.store, self.catalog.clone());
            let lv = crate::layer::LayerView {
                base: &view,
                layer: &self.layer,
            };
            let result = self.planner.plan(
                &cm,
                &lv,
                &PlanOptions {
                    stage: Stage::Submit {
                        level: mdbn_core::intent::Level::Error,
                    },
                },
            );
            if let Some(e) = view.error() {
                return Err(super::submit::store_err(e));
            }
            super::check_paths(result)
                .map_err(|r| ApiError::from(super::submit::rejection_problem(&r)))?
        };
        let mut touches = crate::plan::runtime_mutation_keys(&m);
        touches.sort();
        touches.dedup();
        let order = self.next_order;
        let row = PendingRow {
            order,
            mutation: m,
            effects: Vec::new(),
            touches: touches.clone(),
            grant: None,
            uploads: vec![p.source],
            refs: p.refs,
        };
        // The pending inline text is data for Core replanning; only wire emission
        // externalizes it. Preflight includes BOTH op/result references and GC refs.
        super::unindexed_reverse_entry::entry_plain(&row, &planned, None, &*self.sealer)?;
        self.recheck_unindexed_markdown_reindex(&p.proof)?;
        self.commit_unindexed_capture(Tx {
            pending_put: vec![row],
            ack_observations: observation.into_iter().collect(),
            meta: vec![(
                meta_keys::COUNTERS.into(),
                super::i64_meta(self.clock_floor),
            )],
            ..Tx::default()
        })?;
        self.next_order += 1;
        self.touch.add(order, &touches);
        self.pending_keys.insert(order, touches);
        self.status_dirty = true;
        self.pump();
        Ok(self.pending_receipt(&id))
    }
}
