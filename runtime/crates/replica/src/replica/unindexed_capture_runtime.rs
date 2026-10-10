//! Explicit native capture from an opaque completed upload. Preparation proves
//! data only: final capture repeats current authority and fresh Core admission.
use super::{PreparedUnindexedUpload, Replica};
use crate::{
    api::{ApiError, ApiResult, ErrorCode},
    convert,
    store::{ObservationId, PendingRow, Store, StoreError, StoreResult, Tx, meta_keys},
};
use mdbn_wire::{
    attachment::{AttachmentContentV1, FileContent},
    attachment_runtime_v1 as rt,
    client::Receipt,
    common::B32,
    intent::{Level, OpClock, Source},
};
impl<S: Store> Replica<S> {
    /// Capture a completed native upload after current holder, authority and Core
    /// checks. This does not enable automatic filesystem observation conversion.
    pub fn capture_prepared_unindexed_upload(
        &mut self,
        p: PreparedUnindexedUpload,
    ) -> ApiResult<Receipt> {
        self.capture_unindexed_upload_body(p, None)
    }
    /// Only the trusted store observation driver supplies acknowledgements.
    /// Pending ownership, inventory and evidence retirement share one commit.
    pub(super) fn capture_observed_unindexed_upload(
        &mut self,
        p: PreparedUnindexedUpload,
        token: ObservationId,
    ) -> ApiResult<Receipt> {
        self.capture_unindexed_upload_body(p, Some(token))
    }
    /// A certified abort permits a fresh capture; every other error leaves
    /// durability unknown and requires reopening before any further output.
    pub(super) fn commit_unindexed_capture(&mut self, tx: Tx) -> ApiResult<()> {
        self.commit_unindexed_tx(tx)
            .map_err(super::submit::store_err)
    }
    pub(super) fn commit_unindexed_tx(&mut self, tx: Tx) -> StoreResult<()> {
        match self.store.commit(tx) {
            Ok(_) => Ok(()),
            Err(e) => {
                if !matches!(e, StoreError::CommitAborted(_)) {
                    self.terminal_store_fault("unindexed_capture_durability_unknown");
                }
                Err(e)
            }
        }
    }
    fn capture_unindexed_upload_body(
        &mut self,
        p: PreparedUnindexedUpload,
        token: Option<ObservationId>,
    ) -> ApiResult<Receipt> {
        self.recheck_prepared_unindexed_upload(&p)?;
        let op = p
            .proof
            .operation(FileContent::AttachmentV1(p.content.clone()))?;
        self.capture_unindexed_body(op, p.refs, Some(p.content), token)
    }
    fn capture_unindexed_body(
        &mut self,
        op: rt::Op,
        refs: Vec<mdbn_wire::common::Hash>,
        attachment: Option<AttachmentContentV1>,
        token: Option<ObservationId>,
    ) -> ApiResult<Receipt> {
        use mdbn_core::plan::{PlanOptions, Stage};
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
            source: if token.is_some() {
                Source::External
            } else {
                Source::Api
            },
            ops: vec![op],
            on_behalf: None,
            conflict_mode: None,
            validated_at: token.is_none().then_some(Level::Error),
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
        super::attachment_upload::entry_plain(m.clone(), &planned, None)?;
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
            uploads: Vec::new(),
            refs: refs.clone(),
        };
        // Reuse the append row checker; complete closure came only from the
        // opaque uploader, never from caller-declared refs.
        if attachment.is_some() {
            super::attachment_upload::check_row_refs(&row)?;
        } else if !refs.is_empty() {
            return Err(ErrorCode::Internal.err("reverse capture unexpectedly uploads objects"));
        }
        let mut meta = vec![(
            meta_keys::COUNTERS.into(),
            super::i64_meta(self.clock_floor),
        )];
        if let Some(c) = attachment {
            meta.push(super::attachment_inventory::inventory_meta_of_refs(
                c.reference.manifest_cipher_hash,
                &refs,
            ));
        }
        self.commit_unindexed_capture(Tx {
            pending_put: vec![row],
            meta,
            ack_observations: token.into_iter().collect(),
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
