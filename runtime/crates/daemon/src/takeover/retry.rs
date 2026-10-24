//! The shared rollout retry schedule for status polling and the old-connector watch.

use std::time::{Duration, Instant};

#[derive(Debug, Default)]
pub struct Retry {
    deadline: Option<Instant>,
    attempt: u32,
}

impl Retry {
    pub fn due(&self, now: Instant, refresh: bool) -> bool {
        refresh || self.deadline.is_none_or(|deadline| now >= deadline)
    }

    pub fn denied(&mut self, now: Instant) {
        self.deadline = Some(now + Duration::from_secs(30 << self.attempt.min(3)));
        self.attempt = self.attempt.saturating_add(1);
    }

    pub fn reset(&mut self) {
        *self = Self::default();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn denial_backs_off_and_caps_at_four_minutes() {
        let mut retry = Retry::default();
        let mut now = Instant::now();
        assert!(retry.due(now, false));
        for seconds in [30, 60, 120, 240, 240, 240] {
            retry.denied(now);
            assert!(!retry.due(now, false));
            now += Duration::from_secs(seconds);
            assert!(!retry.due(now - Duration::from_millis(1), false));
            assert!(retry.due(now, false));
        }
    }

    #[test]
    fn focus_can_refresh_without_resetting_backoff_and_success_resets_it() {
        let mut retry = Retry::default();
        let now = Instant::now();
        retry.denied(now);
        assert!(retry.due(now, true));
        assert!(!retry.due(now, false));
        retry.denied(now);
        assert!(!retry.due(now + Duration::from_secs(30), false));
        assert!(retry.due(now + Duration::from_secs(60), false));
        retry.reset();
        assert!(retry.due(now, false));
        retry.denied(now);
        assert!(retry.due(now + Duration::from_secs(30), false));
    }
}
