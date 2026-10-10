//! Capture and the optimistic plan (`replica-client-api.md` §5, `intent.md` §1, §4).

use mdbn_core::plan::{PlanOptions, Stage};
use mdbn_wire::client::{
    Confirmation, Include, Receipt, ReceiptState, RecordState, RecordView, SubmitParams,
};
use mdbn_wire::common::{B16, B32, Uuid};
use mdbn_wire::intent::{Level, Mutation, Op, OpClock, Source};

use super::{Replica, i64_meta};
use crate::api::{ApiError, ApiResult, ErrorCode, SessionId};
use crate::convert;
use crate::layer::LayerView;
use crate::plan::{StoreView, effect_keys, mutation_keys};
use crate::store::{LocalReceipt, PendingRow, Store, Tx, meta_keys};

/// A rejection from the planner, as a client problem.
pub(crate) fn rejection_problem(r: &mdbn_core::plan::Rejection) -> mdbn_wire::client::Problem {
    let code = ErrorCode::parse(r.code.as_str()).unwrap_or(ErrorCode::InvalidRequest);
    let mut p = code.problem(r.message.clone());
    p.reason = r.reason.clone();
    p.details = r.details.as_ref().map(convert::wvalue);
    // Problem.issues is the submitted-record diagnostic envelope. Global
    // catalog issues need a separately authorized describe/diagnostics route.
    if code == ErrorCode::InvalidRecord && !r.issues.is_empty() {
        p.issues = Some(
            r.issues
                .iter()
                .map(|issue| mdbn_wire::client::Issue {
                    code: issue.code.clone(),
                    severity: match issue.severity {
                        mdbn_core::validate::Severity::Error => mdbn_wire::client::Severity::Error,
                        mdbn_core::validate::Severity::Warning => {
                            mdbn_wire::client::Severity::Warning
                        }
                    },
                    message: issue.message.clone(),
                    details: issue.details.as_ref().map(convert::wvalue),
                })
                .collect(),
        );
    }
    p
}

#[cfg(test)]
mod tests;

/// A store failure as a client error: the kind only (opaque diagnostics).
/// The adapter's text (SQL engine messages naming tables, columns and
/// statements, file paths) never reaches a client session.
pub(crate) fn store_err(e: crate::store::StoreError) -> ApiError {
    use crate::store::StoreError as E;
    match e {
        E::Full => ErrorCode::QuotaExceeded.err("device storage is full"),
        E::Io(_) => ErrorCode::Unavailable.err("store: i/o failure"),
        E::Corrupt(_) => ErrorCode::Unavailable.err("store: stored state is unreadable"),
        E::CommitAborted(_) => ErrorCode::Unavailable.err("store: transaction aborted"),
    }
}

impl<S: Store> Replica<S> {
    /// Capture time with the monotonic clamp (`00-overview.md` §7).
    pub(super) fn capture_instant(&mut self) -> i64 {
        let t = self.now().max(self.clock_floor + 1).max(self.log_time + 1);
        self.clock_floor = t;
        t
    }

    /// The current receipt of a mutation, as `viewer` may see it: the hosting app
    /// (`None`) sees every receipt; a grant sees only receipts of mutations submitted
    /// under it. `Err(true)`-like visibility is reported by
    /// [`Replica::receipt_exists`].
    pub(crate) fn known_receipt_for(
        &self,
        id: &Uuid,
        viewer: Option<Uuid>,
    ) -> Result<Option<Receipt>, crate::store::StoreError> {
        if viewer.is_none() {
            return self.known_receipt(id);
        }
        if let Some(p) = self.store.pending_get(id)? {
            return Ok((p.grant == viewer).then(|| self.pending_receipt(id)));
        }
        if let Some(l) = self.store.local_receipt(id)? {
            if l.grant != viewer {
                return Ok(None);
            }
            return self.known_receipt(id);
        }
        Ok(None)
    }

    /// Whether any receipt exists for a mutation ID (whoever submitted it).
    pub(crate) fn receipt_exists(&self, id: &Uuid) -> Result<bool, crate::store::StoreError> {
        Ok(self.known_receipt(id)?.is_some())
    }

    pub(super) fn pending_receipt(&self, id: &Uuid) -> Receipt {
        Receipt {
            relocated_from: None,
            mutation: *id,
            state: ReceiptState::Pending,
            seq: None,
            status: None,
            conflicts: None,
            records: None,
            problem: None,
            published: None,
        }
    }

    /// The current receipt of a mutation this replica knows, if any (unscoped).
    pub(crate) fn known_receipt(
        &self,
        id: &Uuid,
    ) -> Result<Option<Receipt>, crate::store::StoreError> {
        if self.store.pending_get(id)?.is_some() {
            return Ok(Some(Receipt {
                relocated_from: None,
                mutation: *id,
                state: ReceiptState::Pending,
                seq: None,
                status: None,
                conflicts: None,
                records: None,
                problem: None,
                published: None,
            }));
        }
        if let Some(l) = self.store.local_receipt(id)? {
            return Ok(Some(Receipt {
                relocated_from: None,
                mutation: *id,
                state: l.state,
                seq: l.seq,
                status: l.status,
                conflicts: if l.conflicts.is_empty() {
                    None
                } else {
                    Some(l.conflicts)
                },
                records: None,
                problem: l.problem,
                published: None,
            }));
        }
        if let Some(r) = self.store.receipt(id)? {
            return Ok(Some(Receipt {
                relocated_from: None,
                mutation: *id,
                state: ReceiptState::Confirmed,
                seq: Some(r.seq),
                status: None,
                conflicts: None,
                records: None,
                problem: None,
                published: None,
            }));
        }
        Ok(None)
    }

    /// Submit for a session (the client API's `submit`).
    pub(crate) fn submit_ops(
        &mut self,
        session: SessionId,
        p: SubmitParams,
    ) -> ApiResult<Vec<Receipt>> {
        let s = self
            .sessions
            .get(&session)
            .ok_or_else(|| ErrorCode::Unauthenticated.err("no such session"))?
            .clone();
        // Capabilities per operation, against the grant in the confirmed policy
        // (`policy.md` §7.2). The writer re-checks at head and replicas at replay (V6).
        if s.grant().is_some() {
            let store = &self.store;
            let path_key = |p: &str| mdbn_core::paths::path_key(p);
            let file_path = |id: &Uuid| store.file(id).ok().flatten().map(|f| f.path);
            let ctx = crate::policy::OpContext {
                path_key: &path_key,
                file_path: &file_path,
            };
            let caps: Vec<&'static str> = p
                .ops
                .iter()
                .map(|o| crate::policy::capability_for(o, &ctx))
                .collect();
            // Folder scope of the file namespace: every path a file op
            // touches, its target and the file's current path, must be in scope. A
            // file outside it does not exist for this session.
            let paths: Vec<String> = p
                .ops
                .iter()
                .flat_map(|o| crate::policy::file_paths(o, &ctx))
                .collect();
            if let Some(folders) = self.file_scope(session) {
                let out = paths.iter().find(|p| {
                    !crate::policy::within_folders(p, &folders, &mdbn_core::paths::path_key)
                });
                if let Some(p) = out {
                    let mut pr =
                        ErrorCode::Forbidden.problem(format!("{p} is outside the grant's folders"));
                    pr.reason = Some("file_folders".into());
                    return Err(pr.into());
                }
            }
            for cap in caps {
                self.require(session, cap)?;
            }
        }
        // Borrow NEW sources before the grouping clone or Core's parser. A retry
        // of an existing receipt is not a new write under the current policy.
        if p.allow_partial == Some(true) {
            let ids = p.mutation_ids.as_deref().unwrap_or_default();
            if !ids.is_empty() && ids.len() != p.ops.len() {
                return Err(ErrorCode::InvalidRequest.err("mutation_ids must have one ID per op"));
            }
            for (i, op) in p.ops.iter().enumerate() {
                let known = match ids.get(i) {
                    Some(id) => self
                        .known_receipt_for(id, s.grant())
                        .map_err(store_err)?
                        .is_some(),
                    None => false,
                };
                if !known {
                    self.check_new_record_sources(std::slice::from_ref(op))
                        .map_err(super::record_admission::record_too_large)?;
                }
            }
        } else {
            let known = match p.mutation_id {
                Some(id) => self
                    .known_receipt_for(&id, s.grant())
                    .map_err(store_err)?
                    .is_some(),
                None => false,
            };
            if !known {
                self.check_new_record_sources(&p.ops)
                    .map_err(super::record_admission::record_too_large)?;
            }
        }
        let groups: Vec<(Vec<Op>, Option<Uuid>)> = if p.allow_partial == Some(true) {
            let ids = p.mutation_ids.clone().unwrap_or_default();
            if !ids.is_empty() && ids.len() != p.ops.len() {
                return Err(ErrorCode::InvalidRequest.err("mutation_ids must have one ID per op"));
            }
            p.ops
                .iter()
                .enumerate()
                .map(|(i, o)| (vec![o.clone()], ids.get(i).copied()))
                .collect()
        } else {
            vec![(p.ops.clone(), p.mutation_id)]
        };
        let tz = p
            .timezone
            .clone()
            .or(s.tz.clone())
            .unwrap_or_else(|| self.host.zones.default_zone());
        let include = p.include.clone().unwrap_or(Include {
            effective: None,
            body: None,
            document: None,
            diagnostics: None,
        });
        let mut out = Vec::new();
        for (ops, id) in groups {
            // A partial group's known zero-effect refusal must not hide earlier
            // durable captures. Name each group before planning so its rejection
            // and any retry use the same MID, including server-generated IDs.
            let id = if p.allow_partial == Some(true) {
                Some(id.unwrap_or_else(|| self.mint_v7()))
            } else {
                id
            };
            match self.submit_one(
                session,
                s.grant(),
                ops,
                id,
                p.conflict_mode,
                &tz,
                p.dry_run == Some(true),
                &include,
            ) {
                Ok(receipt) => out.push(receipt),
                Err(error)
                    if p.allow_partial == Some(true)
                        && error.problem().reason.as_deref() == Some("record_too_large") =>
                {
                    let mutation = id.expect("partial groups have an assigned MID");
                    let problem = error.into_problem();
                    if p.dry_run != Some(true) {
                        self.store
                            .commit(Tx {
                                local_receipts_put: vec![LocalReceipt {
                                    mutation,
                                    state: ReceiptState::Rejected,
                                    seq: None,
                                    status: None,
                                    conflicts: vec![],
                                    problem: Some(problem.clone()),
                                    resolved_at: self.now(),
                                    grant: s.grant(),
                                }],
                                ..Tx::default()
                            })
                            .map_err(store_err)?;
                    }
                    let receipt = Receipt {
                        relocated_from: None,
                        mutation,
                        state: ReceiptState::Rejected,
                        seq: None,
                        status: None,
                        conflicts: None,
                        records: None,
                        problem: Some(problem),
                        published: None,
                    };
                    if p.dry_run != Some(true) {
                        self.push_durable_receipt(receipt.clone());
                    }
                    out.push(receipt);
                }
                Err(error) => return Err(error),
            }
        }
        self.pump();
        Ok(out)
    }

    #[allow(clippy::too_many_arguments)]
    fn submit_one(
        &mut self,
        session: SessionId,
        grant: Option<Uuid>,
        ops: Vec<Op>,
        id: Option<Uuid>,
        conflict_mode: Option<mdbn_wire::intent::ConflictMode>,
        tz: &str,
        dry_run: bool,
        include: &Include,
    ) -> ApiResult<Receipt> {
        if let Some(id) = id {
            self.hosted_owner_check(&id, grant)?;
            if let Some(r) = self.known_receipt_for(&id, grant).map_err(store_err)? {
                return Ok(r);
            }
            if self.receipt_exists(&id).map_err(store_err)? {
                return Err(ErrorCode::InvalidRequest.err_with_reason(
                    "mutation_id_in_use",
                    "this mutation ID belongs to another client",
                ));
            }
        }
        let instant = self.capture_instant();
        let local_date = self.host.zones.local_date(instant, tz).ok_or_else(|| {
            ErrorCode::InvalidRequest
                .err_with_reason("invalid_timezone", format!("unknown time zone {tz}"))
        })?;
        let id = match id {
            Some(i) => i,
            None => self.mint_v7(),
        };
        let mut seed = [0u8; 32];
        self.host.entropy.fill(&mut seed);
        let m = Mutation {
            id,
            origin: self.cfg.replica_id,
            base_seq: self.head.seq,
            clock: OpClock {
                instant,
                tz: tz.to_string(),
                local_date,
            },
            seed: B32(seed),
            source: Source::Api,
            ops,
            on_behalf: grant,
            conflict_mode,
            validated_at: Some(Level::Error),
            room: None,
        };
        let planned = {
            let cm = convert::mutation(&m, &convert::inline_only)
                .map_err(|e| ErrorCode::InvalidRequest.err(e.to_string()))?;
            let view = StoreView::new(&self.store, self.catalog.clone());
            let lv = LayerView {
                base: &view,
                layer: &self.layer,
            };
            let r = self.planner.plan(
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
            r
        };
        let planned = super::check_paths(planned);
        let planned = match planned {
            Ok(p) => p,
            Err(rej) => {
                let problem = rejection_problem(&rej);
                if !dry_run {
                    let lr = LocalReceipt {
                        mutation: id,
                        state: ReceiptState::Rejected,
                        seq: None,
                        status: None,
                        conflicts: Vec::new(),
                        problem: Some(problem.clone()),
                        resolved_at: self.now(),
                        grant,
                    };
                    self.store
                        .commit(Tx {
                            local_receipts_put: vec![lr],
                            ..Tx::default()
                        })
                        .map_err(store_err)?;
                }
                let receipt = Receipt {
                    relocated_from: None,
                    mutation: id,
                    state: ReceiptState::Rejected,
                    seq: None,
                    status: None,
                    conflicts: None,
                    records: None,
                    problem: Some(problem),
                    published: None,
                };
                if !dry_run {
                    self.push_durable_receipt(receipt.clone());
                }
                return Ok(receipt);
            }
        };
        self.record_write_admission()
            .check_planned(&planned)
            .map_err(super::record_admission::record_too_large)?;
        // A result carrying attachment-v1 content (a move or replace of an
        // attachment file) is appended in the runtime family; it layers nothing
        // locally until it is confirmed (layering attachment content is later
        // work). Any other unencodable result is refused.
        let effects: Vec<mdbn_wire::entry::Effect> = if super::carries_attachment(&planned) {
            Vec::new()
        } else {
            planned
                .effects
                .iter()
                .map(convert::weffect)
                .collect::<Result<_, _>>()
                .map_err(|e| ApiError::from(super::unencodable_result(&e)))?
        };
        let ids = super::effect_ids(&effects);
        if dry_run {
            // Show the result without capturing: plan on a scratch layer.
            let mut scratch = self.layer.clone();
            let view = StoreView::new(&self.store, self.catalog.clone());
            for e in &planned.effects {
                scratch.apply_effect(&view, e);
            }
            let lv = LayerView {
                base: &view,
                layer: &scratch,
            };
            let records = ids
                .iter()
                .filter_map(|i| self.view_of(&lv, i, include, true))
                .collect();
            return Ok(Receipt {
                relocated_from: None,
                mutation: id,
                state: ReceiptState::Pending,
                seq: None,
                status: None,
                conflicts: None,
                records: Some(records),
                problem: None,
                published: None,
            });
        }
        let mut touches = mutation_keys(&m);
        touches.extend(effect_keys(&effects));
        touches.extend(super::path_keys(&effects));
        touches.sort();
        touches.dedup();
        let order = self.next_order;
        self.next_order += 1;
        let effects_for_disk = effects.clone();
        let row = PendingRow {
            order,
            mutation: m.into(),
            effects,
            touches: touches.clone(),
            grant,
            uploads: Vec::new(),
            refs: Vec::new(),
        };
        self.store
            .commit(Tx {
                pending_put: vec![row],
                meta: vec![(meta_keys::COUNTERS.into(), i64_meta(self.clock_floor))],
                ..Tx::default()
            })
            .map_err(store_err)?;
        self.capture_effects(&effects_for_disk);
        self.wait_published(id, &effects_for_disk);
        {
            let view = StoreView::new(&self.store, self.catalog.clone());
            for e in &planned.effects {
                self.layer.apply_effect(&view, e);
            }
            for a in &planned.aliases {
                self.layer.apply_alias(&a.path, a.id);
            }
        }
        self.touch.add(order, &touches);
        self.pending_keys.insert(order, touches);
        self.submitted_by.insert(id, session);
        self.status_dirty = true;
        let changed: std::collections::BTreeSet<B16> = ids.iter().copied().collect();
        self.notify(&changed);
        self.materialize().map_err(store_err)?;
        let records = {
            let view = StoreView::new(&self.store, self.catalog.clone());
            let lv = LayerView {
                base: &view,
                layer: &self.layer,
            };
            ids.iter()
                .filter_map(|i| self.view_of(&lv, i, include, true))
                .collect()
        };
        // Asynchronous capture pushes carry metadata only, not optimistic record
        // views whose read scope might change before delivery. RPC views stay intact.
        self.push_durable_receipt(self.pending_receipt(&id));
        Ok(Receipt {
            relocated_from: None,
            mutation: id,
            state: ReceiptState::Pending,
            seq: None,
            status: None,
            conflicts: None,
            records: Some(records),
            problem: None,
            published: None,
        })
    }

    /// A record view from a state view.
    pub(crate) fn view_of(
        &self,
        v: &dyn mdbn_core::state::StateView,
        id: &B16,
        include: &Include,
        pending_hint: bool,
    ) -> Option<RecordView> {
        let r = v.record(&convert::uuid(id))?;
        let confirmed = self.store.record(id).ok().flatten();
        let pending = pending_hint && self.layer.touches(&convert::uuid(id));
        Some(record_view(
            &v.catalog(),
            id,
            &r.path,
            &r.source,
            confirmed.map(|c| c.modified_seq).unwrap_or(0),
            pending,
            include,
        ))
    }
}

/// One record's client view from its path and source. Shared by the per-record
/// path and the indexed query driver, so the two can never disagree on shape.
pub(crate) fn record_view(
    catalog: &mdbn_core::types::Catalog,
    id: &B16,
    path: &str,
    source: &str,
    confirmed_seq: u64,
    pending: bool,
    include: &Include,
) -> RecordView {
    let doc = mdbn_core::doc::Document::parse_at(path, source);
    let types = catalog.membership(path, doc.frontmatter()).types;
    RecordView {
        id: *id,
        path: path.to_string(),
        revision: mdbn_wire::hash::sha256(source.as_bytes()),
        frontmatter: convert::wmap(doc.frontmatter()),
        effective: if include.effective == Some(true) {
            Some(convert::wmap(doc.frontmatter()))
        } else {
            None
        },
        body: if include.body == Some(true) {
            Some(doc.body().to_string())
        } else {
            None
        },
        document: if include.document == Some(true) {
            Some(source.to_string())
        } else {
            None
        },
        types,
        state: RecordState {
            state: if pending {
                Confirmation::Pending
            } else {
                Confirmation::Confirmed
            },
            confirmed_seq,
            hold: None,
            unresolved: None,
        },
        diagnostics: None,
        values: None,
    }
}
