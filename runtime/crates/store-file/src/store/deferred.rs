//! Explicit queued publication accounting; native immediate mode is unchanged.
use mdbn_replica::store::{
    ObservationId, Publish, PublishBatch, PublishResult, StoreError, StoreResult,
};
use mdbn_wire::common::Hash;
use std::collections::{BTreeMap, VecDeque};

pub(super) const MAX_BATCHES: usize = 64;
pub(super) const MAX_OPERATIONS: u64 = 1024;
pub(super) const MAX_BYTES: u64 = 8 * 1024 * 1024;
pub(super) const MAX_TEXT_BYTES: usize = 1024 * 1024;
pub(super) const MAX_PATH_BYTES: usize = 4096;

pub(super) struct Work {
    pub batch: Option<PublishBatch>,
    pub publishes: Vec<Publish>,
    pub acks: Vec<ObservationId>,
    pub charge: Charge,
    pub blobs: BTreeMap<Hash, Vec<u8>>,
}
#[derive(Clone, Copy)]
pub(super) struct Charge {
    pub bytes: u64,
    pub operations: u64,
}
#[derive(Default)]
pub(super) struct Deferred {
    next: u64,
    pub queue: VecDeque<Work>,
    pub results: Vec<PublishResult>,
    pub fault: bool,
    pub active_blobs: BTreeMap<Hash, Vec<u8>>,
    charges: BTreeMap<PublishBatch, Charge>,
    slots: usize,
    bytes: u64,
    operations: u64,
}
fn budget() -> StoreError {
    StoreError::CommitAborted("queued file publication exceeds bounded ownership budget".into())
}
impl Deferred {
    /// Precharge before inner commit. Results retain their ORIGINAL charge until
    /// drained, including drift payloads; no peak-heap/allocation guarantee.
    pub fn reserve(
        &mut self,
        charge: Charge,
        publication: bool,
    ) -> StoreResult<Option<PublishBatch>> {
        let bytes = self.bytes.checked_add(charge.bytes).ok_or_else(budget)?;
        let operations = self
            .operations
            .checked_add(charge.operations)
            .ok_or_else(budget)?;
        if self.slots >= MAX_BATCHES || bytes > MAX_BYTES || operations > MAX_OPERATIONS {
            return Err(budget());
        }
        let batch = if publication {
            self.next = self.next.checked_add(1).ok_or_else(budget)?;
            let batch = PublishBatch(self.next);
            self.charges.insert(batch, charge);
            Some(batch)
        } else {
            None
        };
        self.slots += 1;
        self.bytes = bytes;
        self.operations = operations;
        Ok(batch)
    }
    pub fn release(&mut self, batch: Option<PublishBatch>, charge: Charge) {
        if let Some(batch) = batch {
            self.charges.remove(&batch);
        }
        self.slots -= 1;
        self.bytes -= charge.bytes;
        self.operations -= charge.operations;
    }
    pub fn is_idle(&self) -> bool {
        self.slots == 0
    }
    pub fn take_results(&mut self) -> Vec<PublishResult> {
        // No publication result can certify readiness ahead of original ACKs
        // or another pending/failed required fence in this drive.
        if self.fault || !self.queue.is_empty() {
            return Vec::new();
        }
        let results = std::mem::take(&mut self.results);
        for result in &results {
            if let Some(charge) = self.charges.get(&result.batch).copied() {
                self.release(Some(result.batch), charge);
            }
        }
        results
    }
}
pub(super) fn bounds_error() -> StoreError {
    budget()
}
