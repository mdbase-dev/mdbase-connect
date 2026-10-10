//! The store's task loop: a single-threaded set of futures polled with a no-op
//! waker, and timers driven by the host's `now_ms`.
//!
//! There is no async runtime. A host calls [`Tasks::run`] after anything that
//! can unblock a task (an operation completed on the host queue, an event
//! arrived, time passed). Native platforms complete operations inside the
//! call, so a native task runs to its next [`Timers::sleep_until`] in one pass.
//! [`Tasks::run`] returns the finished tasks' outputs, and
//! [`Timers::next_wake`] says when to call again if nothing else happens.

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;
use std::task::{Context, Poll, Waker};

/// Shared time source for tasks: the host sets `now`, tasks sleep on it.
#[derive(Clone, Default)]
pub struct Timers(Rc<TimerState>);

#[derive(Default)]
struct TimerState {
    now: Cell<u64>,
    wakes: RefCell<BTreeSet<u64>>,
}

impl Timers {
    /// The current time as last set by the host (milliseconds).
    pub fn now(&self) -> u64 {
        self.0.now.get()
    }

    /// Advance time. Time never goes backwards: an earlier value is ignored.
    pub fn set_now(&self, now_ms: u64) {
        if now_ms > self.0.now.get() {
            self.0.now.set(now_ms);
        }
    }

    /// The earliest deadline a sleeping task is waiting for, if any.
    pub fn next_wake(&self) -> Option<u64> {
        let now = self.now();
        let mut w = self.0.wakes.borrow_mut();
        // Deadlines already passed have been (or will be) seen by their task.
        *w = w.split_off(&(now + 1));
        w.first().copied()
    }

    /// A future that completes once `now >= deadline_ms`.
    pub fn sleep_until(&self, deadline_ms: u64) -> Sleep {
        Sleep {
            until: deadline_ms,
            timers: self.clone(),
        }
    }

    /// A future that completes `ms` after the current time.
    pub fn sleep(&self, ms: u64) -> Sleep {
        self.sleep_until(self.now().saturating_add(ms))
    }
}

/// See [`Timers::sleep_until`].
pub struct Sleep {
    until: u64,
    timers: Timers,
}

impl Future for Sleep {
    type Output = ();

    fn poll(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<()> {
        if self.timers.now() >= self.until {
            Poll::Ready(())
        } else {
            self.timers.0.wakes.borrow_mut().insert(self.until);
            Poll::Pending
        }
    }
}

/// Identifies a spawned task.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub struct TaskId(pub u64);

type BoxTask<T> = Pin<Box<dyn Future<Output = T>>>;

/// A set of tasks producing `T`.
pub struct Tasks<T> {
    next: u64,
    tasks: BTreeMap<TaskId, BoxTask<T>>,
}

impl<T> Default for Tasks<T> {
    fn default() -> Self {
        Tasks {
            next: 0,
            tasks: BTreeMap::new(),
        }
    }
}

impl<T> Tasks<T> {
    /// Add a task. It is first polled by the next [`Tasks::run`].
    pub fn spawn(&mut self, fut: impl Future<Output = T> + 'static) -> TaskId {
        let id = TaskId(self.next);
        self.next += 1;
        self.tasks.insert(id, Box::pin(fut));
        id
    }

    /// Number of unfinished tasks.
    pub fn len(&self) -> usize {
        self.tasks.len()
    }

    /// True when no task is unfinished.
    pub fn is_empty(&self) -> bool {
        self.tasks.is_empty()
    }

    /// Poll every task once, in spawn order, and return the outputs of those
    /// that finished.
    pub fn run(&mut self) -> Vec<(TaskId, T)> {
        let mut cx = Context::from_waker(Waker::noop());
        let mut done = Vec::new();
        let ids: Vec<TaskId> = self.tasks.keys().copied().collect();
        for id in ids {
            let Some(t) = self.tasks.get_mut(&id) else {
                continue;
            };
            if let Poll::Ready(v) = t.as_mut().poll(&mut cx) {
                self.tasks.remove(&id);
                done.push((id, v));
            }
        }
        done
    }
}

/// Run one future to completion on a platform that completes every operation
/// immediately (native, in-memory). Returns `None` if it suspends on something
/// other than a timer, which on such a platform is a bug. Timers are advanced
/// to their deadline instead of waited for.
pub fn run_ready<F: Future>(timers: &Timers, fut: F) -> Option<F::Output> {
    let mut fut = std::pin::pin!(fut);
    let mut cx = Context::from_waker(Waker::noop());
    loop {
        if let Poll::Ready(v) = fut.as_mut().poll(&mut cx) {
            return Some(v);
        }
        let wake = timers.next_wake()?;
        timers.set_now(wake);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sleeps_follow_host_time() {
        let timers = Timers::default();
        let mut tasks = Tasks::default();
        let t = timers.clone();
        tasks.spawn(async move {
            t.sleep(100).await;
            t.now()
        });
        assert!(tasks.run().is_empty());
        assert_eq!(timers.next_wake(), Some(100));
        timers.set_now(99);
        assert!(tasks.run().is_empty());
        timers.set_now(150);
        let done = tasks.run();
        assert_eq!(done, vec![(TaskId(0), 150)]);
        assert!(tasks.is_empty());
        assert_eq!(timers.next_wake(), None);
    }

    #[test]
    fn run_ready_skips_timers() {
        let timers = Timers::default();
        let t = timers.clone();
        let out = run_ready(&timers, async move {
            t.sleep(2000).await;
            t.sleep(500).await;
            t.now()
        });
        assert_eq!(out, Some(2500));
    }
}
