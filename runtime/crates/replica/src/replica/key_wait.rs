//! Bounded ordinary read probes while waiting for a verified epoch key.
//! A deadline is scheduling state, never key or policy authority.
//!
//! The probe interval doubles while nothing changes. A known head past the one
//! the last probe saw (a push: entries were appended, perhaps this device's
//! `key_grant`) brings the next probe forward, still at most one per
//! `FIRST_MS`. The hint only schedules a read; the read is judged as ever.
const FIRST_MS: i64 = 1_000;
const MAX_MS: i64 = 30_000;

#[derive(Default)]
pub(super) struct ReadBackoff {
    position: Option<u64>,
    deadline: i64,
    interval: i64,
    /// The known head when the last probe (or the stall) was read.
    probed_head: u64,
    /// When the last probe (or the stall) was read.
    probed_at: i64,
}
impl ReadBackoff {
    pub(super) fn due(&mut self, position: u64, now: i64, head_known: u64) -> bool {
        if self.position != Some(position) {
            self.position = Some(position);
            self.interval = FIRST_MS;
            self.deadline = now.saturating_add(FIRST_MS);
            self.probed_head = head_known;
            self.probed_at = now;
            return false;
        }
        self.hint(head_known, now);
        if now < self.deadline || now == i64::MAX {
            return false;
        }
        self.interval = self.interval.saturating_mul(2).min(MAX_MS);
        self.deadline = now.saturating_add(self.interval);
        self.probed_head = head_known;
        self.probed_at = now;
        true
    }
    /// The log grew past what the last probe saw: probe again soon (no sooner
    /// than `FIRST_MS` after the last one), keeping the doubled interval.
    fn hint(&mut self, head_known: u64, now: i64) {
        if self.position.is_none() || head_known <= self.probed_head {
            return;
        }
        self.probed_head = head_known;
        let at = self.probed_at.saturating_add(FIRST_MS).max(now);
        self.deadline = self.deadline.min(at);
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
    fn a_grown_head_brings_the_next_probe_forward_at_most_once_a_second() {
        let mut state = ReadBackoff::default();
        assert!(!state.due(4, 0, 9));
        assert!(state.due(4, FIRST_MS, 9));
        assert!(state.due(4, 3 * FIRST_MS, 9));
        assert_eq!(state.deadline(4), Some(7 * FIRST_MS));
        // The same head schedules nothing new.
        assert!(!state.due(4, 3 * FIRST_MS + 10, 9));
        assert_eq!(state.deadline(4), Some(7 * FIRST_MS));
        // Entries appended: the next probe is a second after the last one.
        assert!(!state.due(4, 3 * FIRST_MS + 10, 12));
        assert_eq!(state.deadline(4), Some(4 * FIRST_MS));
        assert!(state.due(4, 4 * FIRST_MS, 12));
        // Doubling continues from where it was; a later head again pulls it in.
        assert_eq!(state.deadline(4), Some(12 * FIRST_MS));
        assert!(
            state.due(4, 9 * FIRST_MS, 13),
            "a later head is due at once"
        );
        assert_eq!(state.deadline(4), Some(25 * FIRST_MS));
    }
}
