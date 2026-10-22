//! Atomic device-mediated capture from an opaque, authenticated client review.
//! Pending authority stays instance-local; reopening cannot revive an unsent review.
use super::{PreparedCollectionSetupPlan, Replica, Store};
use crate::{
    api::{ApiResult, ErrorCode, SessionId},
    convert,
    store::{PendingRow, Tx},
};
use mdbn_wire::{
    attachment_runtime_v1 as rt,
    client::Receipt,
    common::{B32, Text, Uuid},
    intent as wi,
};

pub(crate) struct PendingSetup {
    plan: PreparedCollectionSetupPlan,
    mutation: rt::Mutation,
}
fn operation(op: &mdbn_core::intent::Op) -> ApiResult<rt::Op> {
    use mdbn_core::intent::Op;
    Ok(match op {
        Op::Create(c) => rt::Op::Legacy(wi::Op::Create(wi::Create {
            id: convert::wuuid(&c.id),
            path: c.path.clone(),
            type_name: c.type_name.clone(),
            frontmatter: c.frontmatter.as_ref().map(|m| {
                mdbn_wire::common::DataMap(
                    m.iter()
                        .map(|(k, v)| (k.to_owned(), convert::wvalue(v)))
                        .collect(),
                )
            }),
            body: c.body.as_ref().map(|s| Text::Inline(s.clone())),
            document: c.document.as_ref().map(|s| Text::Inline(s.clone())),
        })),
        Op::ResourcePut(r) => rt::Op::Legacy(wi::Op::ResourcePut(wi::ResourcePut {
            path: r.path.clone(),
            doc: Text::Inline(r.doc.clone()),
            base_revision: r.base_revision.as_ref().map(convert::whash),
            must_not_exist: r.must_not_exist.then_some(true),
        })),
        Op::ResourceDelete(r) => rt::Op::Legacy(wi::Op::ResourceDelete(wi::ResourceDelete {
            path: r.path.clone(),
            base_revision: r.base_revision.as_ref().map(convert::whash),
        })),
        Op::OrdinaryFileToRecord(r) => {
            rt::Op::OrdinaryFileToRecord(mdbn_wire::ordinary_file_promotion::OrdinaryFileToRecord {
                id: convert::wuuid(&r.id),
                path: r.path.clone(),
                doc: Text::Inline(r.doc.clone()),
                prior: convert::wfile_content(&r.prior),
            })
        }
        _ => {
            return Err(
                ErrorCode::InvalidRequest.err("unsupported operation in declared setup plan")
            );
        }
    })
}
impl<S: Store> Replica<S> {
    /// Capture the COMPLETE reviewed plan under this device's real keyed role.
    /// App scope is not widened; ordinary submit remains grant-authorized. The
    /// caller supplies only its original MID, never mutation headers or operations.
    pub fn capture_prepared_collection_setup(
        &mut self,
        session: SessionId,
        plan: PreparedCollectionSetupPlan,
        mutation: Uuid,
    ) -> ApiResult<Receipt> {
        self.retire_completed_setups();
        if !self.declared_setup_pending.is_empty() {
            return Err(ErrorCode::RateLimited.err("another declared setup is pending"));
        }
        self.recheck_prepared_collection_setup(&plan)?;
        let grant = plan
            .initiating_grant()
            .ok_or_else(|| ErrorCode::Forbidden.err("setup requires an initiating grant"))?;
        if plan.initiating_client() != Some(session) {
            return Err(ErrorCode::Forbidden.err("setup review belongs to another client"));
        }
        if self
            .receipt_exists(&mutation)
            .map_err(super::super::submit::store_err)?
        {
            return Err(ErrorCode::Conflict.err_with_reason(
                "mutation_id_in_use",
                "reconcile the original mutation; do not replay setup",
            ));
        }
        let mut seed = [0; 32];
        self.host.entropy.fill(&mut seed);
        let clock = plan.clock();
        let body = rt::Mutation {
            id: mutation,
            origin: self.cfg.replica_id,
            base_seq: self.head.seq,
            clock: wi::OpClock {
                instant: clock.instant_ms,
                tz: clock.tz.clone(),
                local_date: clock.local_date.clone(),
            },
            seed: B32(seed),
            source: wi::Source::Api,
            ops: plan
                .operations()
                .iter()
                .map(operation)
                .collect::<ApiResult<_>>()?,
            on_behalf: None,
            conflict_mode: Some(wi::ConflictMode::Reject),
            validated_at: Some(wi::Level::Error),
            room: None,
        };
        let cm = convert::runtime_mutation(&body, &convert::inline_only)
            .map_err(|e| ErrorCode::UpgradeRequired.err(e.to_string()))?;
        let planned = {
            let view = crate::plan::StoreView::new(&self.store, self.catalog.clone());
            let planned = self.planner.plan(
                &cm,
                &view,
                &mdbn_core::plan::PlanOptions {
                    stage: mdbn_core::plan::Stage::Submit {
                        level: mdbn_core::intent::Level::Error,
                    },
                },
            );
            if let Some(e) = view.error() {
                return Err(super::super::submit::store_err(e));
            }
            super::super::check_paths(planned)
                .map_err(|r| super::super::submit::rejection_problem(&r))?
        };
        super::super::attachment_upload::entry_plain(body.clone(), &planned, None)?;
        self.recheck_prepared_collection_setup(&plan)?;
        let mut touches = crate::plan::runtime_mutation_keys(&body);
        touches.sort();
        touches.dedup();
        let order = self.next_order;
        let row = PendingRow {
            order,
            mutation: body.clone(),
            effects: vec![],
            touches: touches.clone(),
            grant: Some(grant),
            uploads: vec![],
            refs: plan.source_refs().to_vec(),
        };
        // Certified abort is retryable only through a new explicit review. An
        // uncertain commit permanently fences this actor; never replay its MID.
        if let Err(error) = self.commit_native_capture_tx(
            Tx {
                pending_put: vec![row],
                meta: vec![(
                    crate::store::meta_keys::COUNTERS.into(),
                    super::super::i64_meta(self.clock_floor),
                )],
                ..Default::default()
            },
            "collection_setup_capture_durability_unknown",
        ) {
            return Err(
                if matches!(error, crate::store::StoreError::CommitAborted(_)) {
                    super::super::submit::store_err(error)
                } else {
                    ErrorCode::OutcomeUnknown.err_with_reason(
                        "setup_outcome_unknown",
                        "reconcile the original setup mutation before any new attempt",
                    )
                },
            );
        }
        self.declared_setup_pending.insert(
            mutation,
            PendingSetup {
                plan,
                mutation: body,
            },
        );
        self.next_order += 1;
        self.touch.add(order, &touches);
        self.pending_keys.insert(order, touches);
        self.submitted_by.insert(mutation, session);
        self.status_dirty = true;
        self.pump();
        Ok(self.pending_receipt(&mutation))
    }
    pub(crate) fn declared_setup_receipt_grant(
        &self,
        pending: Option<&PendingRow>,
        mutation: &rt::Mutation,
        writer: Option<Uuid>,
    ) -> Option<Uuid> {
        let row = pending?;
        if self.is_hosted()
            || mutation.on_behalf.is_some()
            || writer != Some(self.cfg.device_id)
            || mutation.origin != self.cfg.replica_id
            || row.mutation != *mutation
        {
            return None;
        }
        row.grant
    }
    pub(crate) fn retire_completed_setups(&mut self) {
        let store = &self.store;
        self.declared_setup_pending
            .retain(|id, _| store.pending_get(id).map_or(true, |row| row.is_some()));
    }
    pub(crate) fn check_declared_setup_pending(&self, row: &PendingRow) -> ApiResult<bool> {
        let mediated = row.grant.is_some() && row.mutation.on_behalf.is_none();
        if !mediated {
            return Ok(false);
        }
        let held = self
            .declared_setup_pending
            .get(&row.mutation.id)
            .ok_or_else(|| {
                ErrorCode::Conflict.err_with_reason(
                    "setup_changed",
                    "the original setup review was retired; review again",
                )
            })?;
        if held.mutation != row.mutation
            || held.plan.initiating_grant() != row.grant
            || row.refs != held.plan.source_refs()
            || !row.uploads.is_empty()
            || !row.effects.is_empty()
        {
            return Err(ErrorCode::Conflict
                .err_with_reason("setup_changed", "setup pending identity changed"));
        }
        self.recheck_prepared_collection_setup(&held.plan)?;
        Ok(true)
    }
}
