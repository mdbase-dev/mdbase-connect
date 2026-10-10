//! Bounded ordinary read probes while waiting for a verified epoch key.
//! A deadline is scheduling state, never key or policy authority.
const FIRST_MS: i64 = 1_000;
const MAX_MS: i64 = 30_000;

#[derive(Default)]
pub(super) struct ReadBackoff {
    position: Option<u64>,
    deadline: i64,
    interval: i64,
}
impl ReadBackoff {
    pub(super) fn due(&mut self, position: u64, now: i64) -> bool {
        if self.position != Some(position) {
            self.position = Some(position);
            self.interval = FIRST_MS;
            self.deadline = now.saturating_add(FIRST_MS);
            return false;
        }
        if now < self.deadline || now == i64::MAX {
            return false;
        }
        self.interval = self.interval.saturating_mul(2).min(MAX_MS);
        self.deadline = now.saturating_add(self.interval);
        true
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
        assert!(!state.due(4, 0));
        assert_eq!(state.deadline(4), Some(FIRST_MS));
        for now in 0..FIRST_MS {
            assert!(!state.due(4, now));
        }
        let mut last = 0;
        for _ in 0..20 {
            let deadline = state.deadline(4).unwrap();
            assert!(deadline > last);
            assert!(!state.due(4, deadline - 1));
            assert!(state.due(4, deadline));
            assert!(!state.due(4, deadline));
            assert!(state.deadline(4).unwrap() - deadline <= MAX_MS);
            last = deadline;
        }
        assert_eq!(state.interval, MAX_MS);
    }
    #[test]
    fn new_blocked_position_and_verified_progress_reset_the_backoff() {
        let mut state = ReadBackoff::default();
        assert!(!state.due(4, 0));
        assert!(state.due(4, FIRST_MS));
        assert!(!state.due(5, FIRST_MS));
        assert_eq!(state.deadline(4), None);
        assert_eq!(state.deadline(5), Some(FIRST_MS * 2));
        state.clear();
        assert_eq!(state.deadline(5), None);
        assert!(!state.due(5, 10_000));
        assert_eq!(state.deadline(5), Some(11_000));
    }
}
