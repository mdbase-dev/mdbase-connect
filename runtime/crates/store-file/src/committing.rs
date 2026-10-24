//! Retained commit/publication foundation, including original evidence ACK IO.
use std::cell::Cell;
use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;
use std::task::{Context, Poll, Waker};

use crate::exec::{Timers, run_ready};
use mdbn_replica::store::{CommitReport, StoreError, StoreResult};

type CommitFuture<'a> = Pin<Box<dyn Future<Output = StoreResult<CommitReport>> + 'a>>;

/// Own one ORIGINAL commit until its metadata, evidence and publication IO finish.
/// Pending exclusively borrows the store. Dropping a pending owner is NOT IO
/// cancellation/drain acknowledgement: the store stays fenced until reopening.
/// `FileStore::start_progress` reuses this owner for explicit queued batches;
/// release it before Replica::on_store_progress consumes original outcomes.
pub struct Committing<'a> {
    timers: Timers,
    future: Option<CommitFuture<'a>>,
    lease: Option<Rc<Cell<bool>>>,
}
impl<'a> Committing<'a> {
    pub(crate) fn new(
        timers: Timers,
        lease: Option<Rc<Cell<bool>>>,
        future: impl Future<Output = StoreResult<CommitReport>> + 'a,
    ) -> Self {
        Self {
            timers,
            future: Some(Box::pin(future)),
            lease,
        }
    }
    /// Poll the same original future. The terminal outcome is delivered once.
    pub fn poll(&mut self, now_ms: u64) -> Poll<StoreResult<CommitReport>> {
        self.timers.set_now(now_ms);
        let Some(future) = self.future.as_mut() else {
            return Poll::Ready(Err(StoreError::Io(
                "file store commit already completed".into(),
            )));
        };
        let result = future
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()));
        if result.is_ready() {
            self.future = None;
            if let Some(lease) = self.lease.take() {
                lease.set(false);
            }
        }
        result
    }
    /// Earliest deadline for the retained operation, if any.
    pub fn next_wakeup(&self) -> Option<u64> {
        self.timers.next_wake()
    }
    /// Whether the original terminal outcome was delivered.
    pub fn is_complete(&self) -> bool {
        self.future.is_none()
    }
    pub(crate) fn finish_immediate(mut self) -> StoreResult<CommitReport> {
        let future = self.future.take().expect("new committing has a future");
        match run_ready(&self.timers, future) {
            Some(result) => {
                if let Some(lease) = self.lease.take() { lease.set(false); }
                result
            }
            None => Err(StoreError::Io("platform suspended: retain FileStore::start_commit; reopen after abandoning original IO".into())),
        }
    }
}
