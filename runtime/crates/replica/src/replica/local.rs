//! Local-only execution: trusted host authority, no log transport, and the same
//! validated payload/effects engine. Local positions are not log confirmations.

use std::cell::RefCell;
use std::collections::BTreeSet;

use mdbn_core::plan::{PlanOptions, Stage};
use mdbn_core::state::Overlay;
use mdbn_wire::client::{IncidentKind, Problem, ReceiptState, SyncMode};
use mdbn_wire::common::{Text, Uuid, Value, Version};
use mdbn_wire::entry::EntryPayload;
use mdbn_wire::intent::Op;

use super::Replica;
use super::apply::Outcome;
use super::apply_checkpoint::Checkpoint;
use super::submit::rejection_problem;
use crate::api::ErrorCode;
#[cfg(test)]
use crate::api::Push;
use crate::convert;
use crate::plan::StoreView;
use crate::store::{Head, LocalReceipt, PendingRow, Store, StoreError, Tx};

const LOCAL_BATCH: u32 = 64;

enum GrantError {
    Denied(Box<Problem>),
    Store(StoreError),
}

impl<S: Store> Replica<S> {
    pub(crate) fn local_only(&self) -> bool {
        self.cfg.mode == SyncMode::LocalOnly
    }

    fn local_grant_check(&self, grant: &Uuid, ops: &[Op]) -> Result<(), GrantError> {
        let Some(g) = self.grant_now(grant) else {
            return Err(GrantError::Denied(Box::new(
                ErrorCode::Unauthenticated.problem("the grant is no longer active"),
            )));
        };
        if !self.serving_account_matches(&g.account) {
            return Err(GrantError::Denied(Box::new(
                ErrorCode::Forbidden.problem_with_reason(
                    "grant_account_mismatch",
                    "missing or mismatched local account/collection/device authority",
                ),
            )));
        }
        let error = RefCell::new(None);
        let path_key = |p: &str| mdbn_core::paths::path_key(p);
        let file_path = |id: &Uuid| match self.store.file(id) {
            Ok(row) => row.map(|f| f.path),
            Err(e) => {
                *error.borrow_mut() = Some(e);
                None
            }
        };
        let ctx = crate::policy::OpContext {
            path_key: &path_key,
            file_path: &file_path,
        };
        let mut denied = None;
        for op in ops {
            let cap = crate::policy::capability_for(op, &ctx);
            if !g.allows(cap) {
                denied = Some(ErrorCode::Forbidden.problem(format!("the grant lacks {cap}")));
                break;
            }
            if let Some(folders) = &g.file_folders {
                for path in crate::policy::file_paths(op, &ctx) {
                    if !crate::policy::within_folders(&path, folders, &mdbn_core::paths::path_key) {
                        denied = Some(ErrorCode::Forbidden.problem_with_reason(
                            "file_folders",
                            format!("{path} is outside the grant's folders"),
                        ));
                        break;
                    }
                }
            }
            if denied.is_some() {
                break;
            }
        }
        if let Some(e) = error.into_inner() {
            return Err(GrantError::Store(e));
        }
        if let Some(problem) = denied {
            return Err(GrantError::Denied(Box::new(problem)));
        }
        Ok(())
    }

    fn local_row_check(&self, row: &PendingRow) -> Result<(), GrantError> {
        if row.grant != row.mutation.on_behalf || row.mutation.origin != self.cfg.replica_id {
            return Err(GrantError::Denied(Box::new(
                ErrorCode::InvalidRequest
                    .problem("pending grant/on_behalf/origin provenance mismatch"),
            )));
        }
        if let Some(grant) = row.grant {
            // Granted rows are only ever legacy operations (plain submit).
            let Ok(m) = super::attachment_runtime::legacy_mutation(row.mutation.clone()) else {
                return Err(GrantError::Denied(Box::new(
                    ErrorCode::UpgradeRequired.problem("attachment operations need a synced log"),
                )));
            };
            self.local_grant_check(&grant, &m.ops)?;
        }
        Ok(())
    }

    /// Before any reopen-time pending projection or disk reconciliation. A missing
    /// source never turns an app-granted row into an authorized Host mutation.
    pub(crate) fn validate_local_pending_on_open(&mut self) -> Result<(), StoreError> {
        let mut rejected = Vec::new();
        for row in self.all_pending()? {
            match self.local_row_check(&row) {
                Ok(()) => {}
                Err(GrantError::Denied(problem)) => {
                    rejected.push((row.mutation.id, row.grant, *problem))
                }
                Err(GrantError::Store(e)) => return Err(e),
            }
        }
        // No notify/replan/materialize here: only one atomic rejection commit.
        self.commit_local_rejections(rejected, None)
    }

    /// Atomically delete pending/effects and persist rejected receipts. When a
    /// local payload is void, its local head/policy advance shares this same Tx.
    fn commit_local_rejections(
        &mut self,
        rejected: Vec<(Uuid, Option<Uuid>, Problem)>,
        head: Option<Head>,
    ) -> Result<(), StoreError> {
        if rejected.is_empty() {
            return Ok(());
        }
        let mut tx = Tx {
            head,
            ..Tx::default()
        };
        if let Some(head) = head {
            self.policy.note_void(head.seq, None);
            tx.meta.push(self.policy_meta());
        }
        let mut notifications = Vec::new();
        for (id, grant, problem) in &rejected {
            tx.pending_del.push(*id);
            tx.local_receipts_put.push(LocalReceipt {
                mutation: *id,
                state: ReceiptState::Rejected,
                seq: None,
                status: None,
                conflicts: Vec::new(),
                problem: Some(problem.clone()),
                resolved_at: self.now(),
                grant: *grant,
            });
            notifications.push(mdbn_wire::client::Receipt {
                relocated_from: None,
                mutation: *id,
                state: ReceiptState::Rejected,
                seq: None,
                status: None,
                conflicts: None,
                records: None,
                problem: Some(problem.clone()),
                published: None,
            });
        }
        self.store.commit(tx)?;
        if let Some(head) = head {
            self.head = head;
        }
        for receipt in notifications {
            self.push_durable_receipt(receipt);
        }
        Ok(())
    }

    pub(crate) fn commit_local_void(
        &mut self,
        head: Head,
        payload: &mdbn_wire::attachment_runtime_v1::EntryPayload,
        reason: &'static str,
    ) -> Result<Outcome, StoreError> {
        self.commit_local_rejections(
            vec![(
                payload.mutation.id,
                payload.mutation.on_behalf,
                ErrorCode::InvalidRequest.problem_with_reason("local_void", reason),
            )],
            Some(head),
        )?;
        Ok(Outcome::Void(reason))
    }

    pub(crate) fn local_commit(&mut self) {
        if let Err(e) = self.local_commit_batch() {
            self.incident(
                IncidentKind::Integrity,
                Some(Value::Text(format!("store: {e}"))),
            );
        }
    }

    fn local_commit_batch(&mut self) -> Result<(), StoreError> {
        if self.apply_fault {
            return Ok(());
        }
        // A typed known abort retries ONLY existing pending work. Public Store
        // observations and client calls remain gated by the applied-prefix barrier.
        let mut changed = BTreeSet::new();
        let mut any = false;
        // Pages bound allocation, not progress: drain the captured queue in this
        // pump and rebuild its local projection once, instead of once per page.
        loop {
            let rows = match self.store.pending(None, LOCAL_BATCH) {
                Ok(rows) => rows,
                Err(e) => {
                    let checkpoint = Checkpoint::capture(self);
                    self.failed_apply(checkpoint, self.head.seq.saturating_add(1), false);
                    self.apply_deferred_changed.extend(changed);
                    return Err(e);
                }
            };
            if rows.is_empty() {
                break;
            }
            for row in rows {
                let checkpoint = Checkpoint::capture(self);
                let position = match self.head.seq.checked_add(1) {
                    Some(p) => p,
                    None => {
                        self.failed_apply(checkpoint, self.head.seq, false);
                        return Err(StoreError::Corrupt("local position exhausted".into()));
                    }
                };
                let before_changed = changed.clone();
                let result = self.local_commit_row(&row, position, &mut changed);
                if let Err(e) = result {
                    changed = before_changed;
                    self.failed_apply(
                        checkpoint,
                        position,
                        matches!(&e, StoreError::CommitAborted(_)),
                    );
                    self.apply_deferred_changed.extend(changed);
                    return Err(e);
                }
                changed.extend(row.touches.iter().cloned());
                if self
                    .apply_blocked
                    .is_some_and(|blocked| self.head.seq >= blocked)
                {
                    self.apply_blocked = None;
                }
                any = true;
            }
        }
        if any {
            changed.extend(std::mem::take(&mut self.apply_deferred_changed));
            let checkpoint = Checkpoint::capture(self);
            let result = (|| {
                let mut ids = super::live::ids_from_keys(&changed);
                ids.extend(self.rebuild_local_view(&changed)?);
                self.status_dirty = true;
                self.notify(&ids);
                self.materialize()
            })();
            if let Err(e) = result {
                // A committed prefix precedes this maintenance failure. Reopen
                // rather than roll back derived state to a pre-prefix checkpoint.
                self.failed_apply(checkpoint, self.head.seq, false);
                return Err(e);
            }
        }
        Ok(())
    }

    fn local_commit_row(
        &mut self,
        row: &PendingRow,
        position: u64,
        changed: &mut BTreeSet<String>,
    ) -> Result<(), StoreError> {
        let head = Head {
            seq: position,
            chain: mdbn_wire::hash::CHAIN_ZERO,
        };
        let denied = match self.local_row_check(row) {
            Ok(()) => None,
            Err(GrantError::Denied(problem)) => Some(*problem),
            Err(GrantError::Store(e)) => return Err(e),
        };
        if let Some(problem) = denied {
            return self
                .commit_local_rejections(vec![(row.mutation.id, row.grant, problem)], Some(head));
        }
        // A local-only log carries no attachment objects (`intent.md` §3.9): the
        // dedicated upload refuses there, so such a row is never committed here.
        let Ok(legacy) = super::attachment_runtime::legacy_mutation(row.mutation.clone()) else {
            return self.commit_local_rejections(
                vec![(
                    row.mutation.id,
                    row.grant,
                    ErrorCode::UpgradeRequired.problem("attachment operations need a synced log"),
                )],
                Some(head),
            );
        };
        let cm = match convert::mutation(&legacy, &convert::inline_only) {
            Ok(cm) => cm,
            Err(_) => {
                return self.commit_local_rejections(
                    vec![(
                        row.mutation.id,
                        row.grant,
                        ErrorCode::InvalidRequest.problem("unconvertible mutation"),
                    )],
                    Some(head),
                );
            }
        };
        let planned = {
            let view = StoreView::new(&self.store, self.catalog.clone());
            let overlay = Overlay::new(&view);
            let result = self
                .planner
                .plan(&cm, &overlay, &PlanOptions { stage: Stage::Head });
            if let Some(e) = view.error() {
                return Err(e);
            }
            super::check_paths(result)
        };
        let planned = match planned {
            Ok(plan) => plan,
            Err(rejection) => {
                return self.commit_local_rejections(
                    vec![(row.mutation.id, row.grant, rejection_problem(&rejection))],
                    Some(head),
                );
            }
        };
        let mut mutation = legacy;
        for fill in &planned.base_text_fills {
            if let Some(Op::Update(update)) = mutation.ops.get_mut(fill.op_index as usize) {
                update.body_base_text = Some(Text::Inline(fill.text.clone()));
            }
        }
        let encoded = planned
            .effects
            .iter()
            .map(convert::weffect)
            .collect::<Result<Vec<_>, _>>()
            .and_then(|effects| {
                let conflicts = (!planned.conflicts.is_empty())
                    .then(|| {
                        planned
                            .conflicts
                            .iter()
                            .map(convert::wconflict)
                            .collect::<Result<Vec<_>, _>>()
                    })
                    .transpose()?;
                Ok((effects, conflicts))
            });
        let (effects, conflicts) = match encoded {
            Ok(e) => e,
            Err(e) => {
                return self.commit_local_rejections(
                    vec![(row.mutation.id, row.grant, super::unencodable_result(&e))],
                    Some(head),
                );
            }
        };
        let payload = EntryPayload {
            resurrect: None,
            sem: Version {
                major: planned.sem.major,
                minor: planned.sem.minor,
            },
            mutation,
            status: convert::wstatus(planned.status),
            effects,
            conflicts,
            aliases: (!planned.aliases.is_empty())
                .then(|| planned.aliases.iter().map(convert::walias).collect()),
            texts: None,
        };
        // Planning can outlive a lease/account epoch. Check again at the apply
        // boundary rather than treating the pre-plan grant as a durable allow.
        match self.local_row_check(row) {
            Ok(()) => {}
            Err(GrantError::Denied(problem)) => {
                return self.commit_local_rejections(
                    vec![(row.mutation.id, row.grant, *problem)],
                    Some(head),
                );
            }
            Err(GrantError::Store(e)) => return Err(e),
        }
        match self.apply_payload(position, head, payload.into(), changed)? {
            Outcome::Applied => self.stats.applied += 1,
            Outcome::Void(_) => self.stats.voided += 1,
            Outcome::Stall(_, _)
            | Outcome::Integrity(_)
            | Outcome::Diverged
            | Outcome::SourcePending => {
                return Err(StoreError::Corrupt(
                    "unexpected local payload outcome".into(),
                ));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
