//! Simulated time and the event queue.
//!
//! Time moves only when the world pops the next event. Events at the same instant
//! run in the order they were scheduled, so a run is a pure function of the seed.

use std::cell::Cell;
use std::cmp::Reverse;
use std::collections::BinaryHeap;
use std::rc::Rc;

use mdbn_core::host::Clock;

/// Where simulated time starts: 2026-09-21T...Z in Unix ms. Any fixed value works;
/// a realistic one keeps formatted timestamps plausible.
pub const EPOCH_MS: u64 = 1_790_000_000_000;

/// The shared simulated clock. Cloning shares the same instant.
#[derive(Debug, Clone)]
pub struct SimTime(Rc<Cell<u64>>);

impl Default for SimTime {
    fn default() -> Self {
        SimTime(Rc::new(Cell::new(EPOCH_MS)))
    }
}

impl SimTime {
    /// Current time, ms.
    pub fn now(&self) -> u64 {
        self.0.get()
    }
    /// Milliseconds since the world started.
    pub fn elapsed(&self) -> u64 {
        self.0.get() - EPOCH_MS
    }
    pub(crate) fn set(&self, t: u64) {
        debug_assert!(t >= self.0.get(), "time never goes backwards");
        self.0.set(t);
    }
}

impl Clock for SimTime {
    fn now_ms(&self) -> u64 {
        self.now()
    }
}

/// A host clock that can be skewed: what a device's own wall clock reads.
#[derive(Debug, Clone)]
pub struct SkewedClock {
    /// The world's clock.
    pub time: SimTime,
    /// Offset added to the world's time (may be negative).
    pub skew_ms: i64,
}

impl Clock for SkewedClock {
    fn now_ms(&self) -> u64 {
        self.time.now().saturating_add_signed(self.skew_ms)
    }
}

#[derive(Debug)]
struct Entry<E> {
    at: u64,
    seq: u64,
    ev: E,
}

impl<E> PartialEq for Entry<E> {
    fn eq(&self, o: &Self) -> bool {
        (self.at, self.seq) == (o.at, o.seq)
    }
}
impl<E> Eq for Entry<E> {}
impl<E> PartialOrd for Entry<E> {
    fn partial_cmp(&self, o: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(o))
    }
}
impl<E> Ord for Entry<E> {
    fn cmp(&self, o: &Self) -> std::cmp::Ordering {
        (self.at, self.seq).cmp(&(o.at, o.seq))
    }
}

/// A deterministic priority queue of timed events.
#[derive(Debug)]
pub struct Queue<E> {
    heap: BinaryHeap<Reverse<Entry<E>>>,
    seq: u64,
}

impl<E> Default for Queue<E> {
    fn default() -> Self {
        Queue {
            heap: BinaryHeap::new(),
            seq: 0,
        }
    }
}

impl<E> Queue<E> {
    /// Schedule `ev` at absolute time `at`.
    pub fn push(&mut self, at: u64, ev: E) {
        self.seq += 1;
        self.heap.push(Reverse(Entry {
            at,
            seq: self.seq,
            ev,
        }));
    }
    /// The time of the next event.
    pub fn peek_time(&self) -> Option<u64> {
        self.heap.peek().map(|Reverse(e)| e.at)
    }
    /// Pop the next event.
    pub fn pop(&mut self) -> Option<(u64, E)> {
        self.heap.pop().map(|Reverse(e)| (e.at, e.ev))
    }
    /// Events waiting.
    pub fn len(&self) -> usize {
        self.heap.len()
    }
    /// No events waiting.
    pub fn is_empty(&self) -> bool {
        self.heap.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_instant_is_fifo() {
        let mut q = Queue::default();
        q.push(5, "b1");
        q.push(3, "a");
        q.push(5, "b2");
        assert_eq!(q.pop(), Some((3, "a")));
        assert_eq!(q.pop(), Some((5, "b1")));
        assert_eq!(q.pop(), Some((5, "b2")));
    }
}
