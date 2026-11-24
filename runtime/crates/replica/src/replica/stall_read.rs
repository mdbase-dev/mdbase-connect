//! Bounded ordinary read probes while apply is stalled, of any kind.
//! A deadline is scheduling state, never key or policy authority.
//!
//! A stalled entry is re-read only by these probes: a read reply or a tick
//! never re-reads it sooner than its backoff deadline. Waiting for a key
//! resolves through a key event; every other stall (an unknown format, an
//! unpinned key, a planner this build cannot verify) depends only on the log
//! and this build's code and configuration, which change only on reopen. The
//! probes keep a stalled replica hearing of the log (its head, a snapshot it
//! has fallen behind).
//!
//! The probe interval doubles while nothing changes. A known head past the one
//! the last probe saw (a push: entries were appended, perhaps this device's
//! `key_grant`) brings the next probe forward to `now` immediately, while
//! repeated identical or lower hints keep waiting on the backoff. The hint
//! only schedules a read; the read is judged as ever.
const FIRST_MS: i64 = 1_000;
const MAX_MS: i64 = 30_000;

#[derive(Default)]
pub(super) struct ReadBackoff {
    position: Option<u64>,
    deadline: i64,
    interval: i64,
    /// The highest log head the last probe (or the stall) has already seen.
    probed_head: u64,
}
impl ReadBackoff {
    pub(super) fn due(&mut self, position: u64, now: i64, head_known: u64) -> bool {
        if self.position != Some(position) {
            self.position = Some(position);
            self.interval = FIRST_MS;
            self.deadline = now.saturating_add(FIRST_MS);
            self.probed_head = head_known;
            return false;
        }
        self.hint(head_known, now);
        if now < self.deadline || now == i64::MAX {
            return false;
        }
        self.interval = self.interval.saturating_mul(2).min(MAX_MS);
        self.deadline = now.saturating_add(self.interval);
        self.probed_head = head_known;
        true
    }
    /// The log grew past what the last probe saw: probe immediately, keeping
    /// the doubled no-news interval.
    fn hint(&mut self, head_known: u64, now: i64) {
        if self.position.is_none() || head_known <= self.probed_head {
            return;
        }
        self.probed_head = head_known;
        self.deadline = self.deadline.min(now);
    }
    /// Record the head reported by a completed read so the reply itself does
    /// not look like a newer hint and bypass the backoff deadline.
    pub(super) fn observe_head(&mut self, head: u64) {
        if self.position.is_some() {
            self.probed_head = self.probed_head.max(head);
        }
    }
    pub(super) fn deadline(&self, position: u64) -> Option<i64> {
        (self.position == Some(position)).then_some(self.deadline)
    }
    pub(super) fn clear(&mut self) {
        *self = Self::default();
    }
}

#[cfg(test)]
mod runtime_tests;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repeated_attempts_wait_and_probes_remain_bounded_but_never_stop() {
        let mut state = ReadBackoff::default();
        assert!(!state.due(4, 0, 9));
        assert_eq!(state.deadline(4), Some(FIRST_MS));
        for now in 0..FIRST_MS {
            assert!(!state.due(4, now, 9));
        }
        let mut last = 0;
        for _ in 0..20 {
            let deadline = state.deadline(4).unwrap();
            assert!(deadline > last);
            assert!(!state.due(4, deadline - 1, 9));
            assert!(state.due(4, deadline, 9));
            assert!(!state.due(4, deadline, 9));
            assert!(state.deadline(4).unwrap() - deadline <= MAX_MS);
            last = deadline;
        }
        assert_eq!(state.interval, MAX_MS);
    }
    #[test]
    fn new_blocked_position_and_verified_progress_reset_the_backoff() {
        let mut state = ReadBackoff::default();
        assert!(!state.due(4, 0, 9));
        assert!(state.due(4, FIRST_MS, 9));
        assert!(!state.due(5, FIRST_MS, 9));
        assert_eq!(state.deadline(4), None);
        assert_eq!(state.deadline(5), Some(FIRST_MS * 2));
        state.clear();
        assert_eq!(state.deadline(5), None);
        assert!(!state.due(5, 10_000, 9));
        assert_eq!(state.deadline(5), Some(11_000));
    }
    #[test]
    fn an_advancing_head_triggers_an_immediate_probe_while_identical_hints_keep_backoff() {
        let mut state = ReadBackoff::default();
        assert!(!state.due(4, 0, 9));
        assert_eq!(state.deadline(4), Some(FIRST_MS));
        // An advancing head right after stalling is due immediately, without
        // waiting out FIRST_MS.
        assert!(state.due(4, 50, 10));
        assert_eq!(state.deadline(4), Some(50 + 2 * FIRST_MS));
        // Repeated identical or lower hints do not schedule another probe.
        assert!(!state.due(4, 50, 10));
        assert!(!state.due(4, 100, 10));
        assert!(!state.due(4, 100, 9));
        assert_eq!(state.deadline(4), Some(50 + 2 * FIRST_MS));
        // Without further hints, the doubled backoff governs the next probe.
        assert!(!state.due(4, 50 + 2 * FIRST_MS - 1, 10));
        assert!(state.due(4, 50 + 2 * FIRST_MS, 10));
        assert_eq!(state.deadline(4), Some(50 + 6 * FIRST_MS));
        // A later advancing head immediately triggers another probe, keeping
        // the doubled no-news interval.
        let at = 50 + 2 * FIRST_MS + 10;
        assert!(state.due(4, at, 12));
        assert_eq!(state.deadline(4), Some(at + 8 * FIRST_MS));
        assert!(!state.due(4, at + 1, 12));
    }
    #[test]
    fn observe_head_records_a_reply_head_without_bypassing_backoff() {
        let mut state = ReadBackoff::default();
        assert!(!state.due(4, 0, 9));
        assert!(state.due(4, FIRST_MS, 9));
        assert_eq!(state.deadline(4), Some(3 * FIRST_MS));
        state.observe_head(100);
        // The head reported by the reply itself does not trigger an immediate re-read.
        assert!(!state.due(4, FIRST_MS, 100));
        assert_eq!(state.deadline(4), Some(3 * FIRST_MS));
        // A push past what the reply saw still triggers immediately.
        assert!(state.due(4, FIRST_MS + 5, 101));
        assert_eq!(state.deadline(4), Some(FIRST_MS + 5 + 4 * FIRST_MS));
    }
}
