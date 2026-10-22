//! Test-only faulting of ONE original native actor/store. No row/counter seeding.
//! Native pending rows must originate in the ordinary owner client submit.
//! Lost ACK below is storage-ACK uncertainty, not a remote-log outcome proof.
use super::Store as NativeStore;
use mdbn_replica::Replica;
use mdbn_replica::store::{CommitReport, Head, LocalReceipt, PendingRow, Store, StoreError, Tx};
use mdbn_wire::client::{ReceiptState, SyncMode};
use mdbn_wire::common::B16;
use std::sync::Arc;

#[derive(Clone)]
pub(crate) struct Scope {
    pub collection: B16,
    pub replica: B16,
    pub device: B16,
    pub account: B16,
    pub epoch: u64,
    // Constructed from ORIGINAL CollectionAuthority, never a fake GrantSource.
    pub current: Arc<dyn Fn(B16, u64) -> bool + Send + Sync>,
}

pub(crate) enum Op {
    Arm {
        scope: Scope,
        target: B16,
        lose_capture_ack: bool,
    },
    Ledger(B16),
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Ledger {
    pub head: Head,
    pub identity: Vec<u8>,
    pub pending: Vec<(B16, Vec<u8>)>,
    pub receipt: Option<LocalReceipt>,
}

pub(crate) enum Reply {
    Done,
    Ledger {
        ledger: Box<Ledger>,
        witness: Option<Box<PendingRow>>,
        lost_ack: bool,
        aborts: u64,
        reopen: bool,
    },
}

pub(crate) struct Fault {
    scope: Scope,
    target: B16,
    lose_capture_ack: bool,
    witness: Option<PendingRow>,
    lost_ack: bool,
    aborts: u64,
}

impl Fault {
    pub(crate) fn witness(&self) -> (Option<PendingRow>, bool, u64) {
        (self.witness.clone(), self.lost_ack, self.aborts)
    }

    pub(crate) fn commit<S: Store>(
        &mut self,
        inner: &mut S,
        tx: Tx,
    ) -> Result<CommitReport, StoreError> {
        if !(self.scope.current)(self.scope.account, self.scope.epoch) {
            return Err(StoreError::Io(
                "fixture original account epoch ended".into(),
            ));
        }
        // No finalize/reject/delete of this ORIGINAL captured ID while latched.
        // CommitAborted is truthful: the inner transaction is NEVER called.
        if self.witness.is_some()
            && (tx.pending_del.contains(&self.target)
                || tx
                    .local_receipts_put
                    .iter()
                    .any(|r| r.mutation == self.target && r.state != ReceiptState::Pending))
        {
            self.aborts += 1;
            return Err(StoreError::CommitAborted(
                "fixture original finalization blocked before commit".into(),
            ));
        }
        let captured = tx
            .pending_put
            .iter()
            .find(|r| r.mutation.id == self.target)
            .cloned();
        if let Some(row) = &captured
            && (row.mutation.origin != self.scope.replica
                || row.grant.is_some()
                || row.mutation.on_behalf.is_some())
        {
            return Err(StoreError::Io("fixture wrong original owner/origin".into()));
        }
        let report = inner.commit(tx)?;
        if let Some(row) = captured {
            let durable = inner
                .pending_get(&self.target)?
                .ok_or_else(|| StoreError::Io("fixture original capture not durable".into()))?;
            if durable.to_bytes() != row.to_bytes() {
                return Err(StoreError::Io(
                    "fixture captured bytes changed at native delegation".into(),
                ));
            }
            // Witness only AFTER the genuine NativeStore capture succeeded.
            if self.witness.is_none() {
                self.witness = Some(durable);
                if self.lose_capture_ack {
                    self.lost_ack = true;
                    return Err(StoreError::Io(
                        "fixture lost original durable capture ACK".into(),
                    ));
                }
            }
        }
        Ok(report)
    }
}

fn check(rep: &Replica<NativeStore>, scope: &Scope) -> Result<(), String> {
    let cfg = rep.config();
    if cfg.mode != SyncMode::LocalOnly
        || cfg.collection != scope.collection
        || cfg.replica_id != scope.replica
        || cfg.device_id != scope.device
        || !(scope.current)(scope.account, scope.epoch)
    {
        return Err("fixture scope differs from original native actor/account epoch".into());
    }
    let actual = rep
        .store()
        .meta(mdbn_replica::store::meta_keys::IDENTITY)
        .map_err(|e| e.to_string())?;
    if actual.as_deref() != Some([scope.collection.0, scope.replica.0].concat().as_slice()) {
        return Err("fixture original durable store identity mismatch".into());
    }
    Ok(())
}

pub(crate) fn ledger<S: Store>(store: &S, target: B16) -> Result<Ledger, String> {
    let rows = store.pending(None, 128).map_err(|e| e.to_string())?;
    let count = store.pending_count().map_err(|e| e.to_string())?;
    if count != rows.len() as u64 {
        return Err("fixture ledger exceeds its bounded page".into());
    }
    Ok(Ledger {
        head: store.head().map_err(|e| e.to_string())?,
        identity: store
            .meta(mdbn_replica::store::meta_keys::IDENTITY)
            .map_err(|e| e.to_string())?
            .ok_or("fixture original identity absent")?,
        pending: rows.iter().map(|r| (r.mutation.id, r.to_bytes())).collect(),
        receipt: store.local_receipt(&target).map_err(|e| e.to_string())?,
    })
}

pub(crate) fn handle(rep: &mut Replica<NativeStore>, op: Op) -> Result<Reply, String> {
    match op {
        Op::Arm {
            scope,
            target,
            lose_capture_ack,
        } => {
            check(rep, &scope)?;
            if rep.store().pending_count().map_err(|e| e.to_string())? != 0 {
                return Err("fixture must arm after original startup has settled".into());
            }
            rep.store_mut().capture_fixture_arm(Fault {
                scope,
                target,
                lose_capture_ack,
                witness: None,
                lost_ack: false,
                aborts: 0,
            })?;
            Ok(Reply::Done)
        }
        Op::Ledger(target) => {
            let ledger = ledger(rep.store(), target)?;
            let (witness, lost_ack, aborts) = rep.store().capture_fixture_witness();
            Ok(Reply::Ledger {
                ledger: Box::new(ledger),
                witness: witness.map(Box::new),
                lost_ack,
                aborts,
                reopen: rep.requires_reopen(),
            })
        }
    }
}
