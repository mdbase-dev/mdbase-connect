//! Retained observation scan. Pending retains both the store borrow and IO.

use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll, Waker};

use mdbn_replica::store::{Observation, StoreError, StoreResult};

use crate::exec::{Timers, run_ready};

type ObserveFuture<'a> = Pin<Box<dyn Future<Output = StoreResult<Vec<Observation>>> + 'a>>;

/// Own one scan until its original host operations and metadata persistence finish.
///
/// The pending future exclusively borrows the store: no partial observation batch
/// or concurrently ready store is exposed. Dropping this owner is not host-IO
/// cancellation/drain acknowledgement. Retain it until a terminal result and drain
/// original host operations before releasing filesystem ownership.
pub struct Observing<'a> {
    timers: Timers,
    future: Option<ObserveFuture<'a>>,
}

impl<'a> Observing<'a> {
    pub(crate) fn new(
        timers: Timers,
        future: impl Future<Output = StoreResult<Vec<Observation>>> + 'a,
    ) -> Self {
        Self {
            timers,
            future: Some(Box::pin(future)),
        }
    }

    /// Resume the original scan after host completions. Terminal result once.
    pub fn poll(&mut self, now_ms: u64) -> Poll<StoreResult<Vec<Observation>>> {
        self.timers.set_now(now_ms);
        let Some(future) = self.future.as_mut() else {
            return Poll::Ready(Err(StoreError::Io(
                "file store observation already completed".into(),
            )));
        };
        let result = future
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()));
        if result.is_ready() {
            self.future = None;
        }
        result
    }

    /// Timer deadline for the retained scan, if any.
    pub fn next_wakeup(&self) -> Option<u64> {
        self.timers.next_wake()
    }

    /// Whether the terminal result has been delivered.
    pub fn is_complete(&self) -> bool {
        self.future.is_none()
    }

    pub(crate) fn finish_immediate(mut self) -> StoreResult<Vec<Observation>> {
        let future = self.future.take().expect("new observing has a future");
        run_ready(&self.timers, future).ok_or_else(|| {
            StoreError::Io("platform suspended: use FileStore::start_observe".into())
        })?
    }
}
