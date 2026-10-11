//! Retained FileStore startup: poll the same future after host IO completes.

use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll, Waker};

use mdbn_replica::store::{Store, StoreError, StoreResult};

use crate::diskdb::DiskDb;
use crate::exec::{Timers, run_ready};
use crate::platform::FilePlatform;
use crate::store::FileStore;

type OpenFuture<'a, T> = Pin<Box<dyn Future<Output = StoreResult<T>> + 'a>>;

/// A not-yet-open file store. No ready store is exposed before recovery finishes.
///
/// Keep this owner alive while its host operations are pending. Dropping it is
/// not a host-IO cancellation or drain acknowledgement; a host must separately
/// drain its original operations before releasing filesystem ownership.
pub struct Opening<'a, P: FilePlatform, M: Store, D: DiskDb> {
    timers: Timers,
    future: Option<OpenFuture<'a, FileStore<P, M, D>>>,
}

impl<'a, P: FilePlatform, M: Store, D: DiskDb> Opening<'a, P, M, D> {
    pub(crate) fn new(
        timers: Timers,
        future: impl Future<Output = StoreResult<FileStore<P, M, D>>> + 'a,
    ) -> Self {
        Self {
            timers,
            future: Some(Box::pin(future)),
        }
    }

    /// Poll the retained startup after host completions or a timer wake.
    /// Returns a ready store exactly once; pending never restarts recovery.
    pub fn poll(&mut self, now_ms: u64) -> Poll<StoreResult<FileStore<P, M, D>>> {
        self.timers.set_now(now_ms);
        let Some(future) = self.future.as_mut() else {
            return Poll::Ready(Err(StoreError::Io(
                "file store opening already completed".into(),
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

    /// Next host-time deadline, if startup is waiting on a timer.
    pub fn next_wakeup(&self) -> Option<u64> {
        self.timers.next_wake()
    }

    /// Whether the ready result (success or failure) has already been delivered.
    pub fn is_complete(&self) -> bool {
        self.future.is_none()
    }

    pub(crate) fn finish_immediate(mut self) -> StoreResult<FileStore<P, M, D>> {
        let future = self.future.take().expect("new opening has a future");
        run_ready(&self.timers, future)
            .ok_or_else(|| StoreError::Io("platform suspended: use FileStore::start_open".into()))?
    }
}
