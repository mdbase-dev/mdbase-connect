//! Private, non-activating deletion-currentness foundation.
//!
//! There is deliberately no production positive-window issuer or proof input.
//! Carrying this gate is NOT integration of every Engine/adapter/destination
//! effect site. The test model specifies the proposed fence-before-floor
//! protocol, not the behavior of the currently independent deployed actors.

/// Unknown until a separately qualified native/destination protocol exists.
/// No Clone, Default, public constructor, ABI input or positive transition.
pub(super) struct ReceiverGate;

impl ReceiverGate {
    pub(super) fn unknown() -> Self {
        Self
    }

    /// Absence, elapsed time and caller labels cannot mint effect authority.
    pub(super) fn permits_effect(&self) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::ReceiverGate;
    use std::collections::BTreeSet;

    const DRAIN_MS: u64 = 30_000;

    // Synthetic fixtures ONLY. No enrollment/key/provider/currentness evidence.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    struct Binding {
        namespace: u64,
        collection: u64,
        wake: u64,
        generation: u64,
        operation: u64,
        session: u64,
    }

    impl Binding {
        fn valid(self) -> bool {
            self.namespace > 0
                && self.collection > 0
                && self.wake > 0
                && self.generation > 0
                && self.operation > 0
                && self.session > 0
        }
    }

    // Non-Clone, non-Default and private; moved out on entry, never replayed.
    struct Window {
        binding: Binding,
        deadline: u64,
        nonce: u64,
    }

    struct TestReceiver {
        binding: Binding,
        window: Option<Window>,
        last_nonce: u64,
        last_time: u64,
        closing_at: Option<u64>,
        entered: bool,
        unresolved: bool,
        fenced: bool,
    }

    impl TestReceiver {
        fn unknown(binding: Binding) -> Self {
            Self {
                binding,
                window: None,
                last_nonce: 0,
                last_time: 0,
                closing_at: None,
                entered: false,
                unresolved: false,
                fenced: false,
            }
        }

        fn fixture_window(&mut self, window: Window, now: u64) -> bool {
            if self.closing_at.is_some()
                || !window.binding.valid()
                || window.binding != self.binding
                || window.nonce <= self.last_nonce
                || now < self.last_time
                || window.deadline <= now
                || window.deadline - now > DRAIN_MS
                || self.entered
                || self.unresolved
                || self.window.is_some()
            {
                return false;
            }
            self.last_nonce = window.nonce;
            self.last_time = now;
            self.window = Some(window);
            true
        }

        fn enter(&mut self, expected: Binding, now: u64) -> bool {
            // Every failed entry consumes the original window too.
            let window = self.window.take();
            if now < self.last_time {
                self.close(now);
                return false;
            }
            self.last_time = now;
            let Some(window) = window else { return false };
            if self.closing_at.is_some()
                || self.entered
                || self.unresolved
                || expected != self.binding
                || expected != window.binding
                || now >= window.deadline
            {
                return false;
            }
            self.entered = true;
            true
        }

        fn finish(&mut self) -> bool {
            !self.unresolved && std::mem::take(&mut self.entered)
        }

        fn invalidate_for_await(&mut self) {
            self.window = None;
            // Illegal await after entry cannot be treated as a proven abort.
            // Keep unknown work outstanding until actual destination fencing.
            self.unresolved |= self.entered;
        }

        fn close(&mut self, now: u64) {
            self.closing_at.get_or_insert(now);
            self.window = None;
        }

        fn fence_ack(&mut self) -> bool {
            if self.closing_at.is_none() || self.entered || self.unresolved {
                return false;
            }
            self.fenced = true;
            true
        }

        fn bound_reached(&self, now: u64) -> bool {
            self.closing_at
                .and_then(|start| start.checked_add(DRAIN_MS))
                .is_some_and(|deadline| now >= deadline)
        }

        fn restart(&mut self, new_wake: u64) {
            self.window = None;
            // An unknown in-flight outcome stays unresolved, not replayable.
            // Closing/fence/nonce history must survive outside disposable RAM.
            self.unresolved |= self.entered;
            self.binding.wake = new_wake;
        }
    }

    fn binding() -> Binding {
        Binding {
            namespace: 1,
            collection: 2,
            wake: 3,
            generation: 4,
            operation: 5,
            session: 6,
        }
    }

    fn window(binding: Binding, nonce: u64, deadline: u64) -> Window {
        Window {
            binding,
            nonce,
            deadline,
        }
    }

    #[test]
    fn production_gate_has_no_positive_transition() {
        let gate = ReceiverGate::unknown();
        for _ in 0..100 {
            assert!(!gate.permits_effect());
        }
    }

    #[test]
    fn unknown_and_every_binding_mismatch_deny() {
        let b = binding();
        let mut r = TestReceiver::unknown(b);
        assert!(!r.enter(b, 0));
        for wrong in [
            Binding { namespace: 9, ..b },
            Binding { collection: 9, ..b },
            Binding { wake: 9, ..b },
            Binding { generation: 9, ..b },
            Binding { operation: 9, ..b },
            Binding { session: 9, ..b },
            Binding { generation: 0, ..b },
        ] {
            assert!(!r.fixture_window(window(wrong, 1, 10), 0));
        }
        assert!(r.fixture_window(window(b, 1, 10), 0));
        assert!(!r.enter(Binding { session: 9, ..b }, 0));
        assert!(!r.enter(b, 0), "failed entry must consume the slot");
    }

    #[test]
    fn exact_window_is_single_use_and_unknown_outcome_is_not_replayed() {
        let b = binding();
        let mut r = TestReceiver::unknown(b);
        assert!(r.fixture_window(window(b, 1, 10), 0));
        assert!(r.enter(b, 1));
        assert!(!r.enter(b, 1));
        r.restart(7);
        assert!(!r.fixture_window(window(r.binding, 2, 10), 1));
        assert!(!r.finish(), "restarted owner has no completion proof");
        assert!(!r.fixture_window(window(r.binding, 1, 10), 1));
        assert!(!r.enter(b, 1));
        r.close(2);
        assert!(!r.fence_ack(), "unknown completion is not an abort");
    }

    #[test]
    fn closing_is_terminal_forward_and_ack_requires_actual_drain() {
        let b = binding();
        let mut r = TestReceiver::unknown(b);
        assert!(r.fixture_window(window(b, 1, 10), 0));
        assert!(r.enter(b, 1));
        r.close(2);
        assert!(!r.fence_ack(), "entered effect has not drained");
        r.close(100);
        assert_eq!(r.closing_at, Some(2));
        assert!(r.finish());
        assert!(r.fence_ack());
        r.restart(7);
        assert!(r.fenced);
        assert!(!r.fixture_window(window(r.binding, 2, 110), 100));
        assert!(!r.enter(r.binding, 100));
    }

    #[test]
    fn thirty_second_bound_never_synthesizes_a_fence() {
        let mut r = TestReceiver::unknown(binding());
        assert!(!r.bound_reached(u64::MAX));
        r.close(5);
        assert!(!r.bound_reached(30_004));
        assert!(r.bound_reached(30_005));
        assert!(!r.fenced, "timeout alone cannot authorize the floor");
        assert!(r.fence_ack());
        assert!(r.fenced);
        r.close(40_000);
        assert_eq!(r.closing_at, Some(5));
        let mut overflow = TestReceiver::unknown(binding());
        overflow.close(u64::MAX - 1);
        assert!(!overflow.bound_reached(u64::MAX));
        assert!(!overflow.fenced);
    }

    #[test]
    fn expiry_rollback_and_oversized_duration_deny() {
        let b = binding();
        let mut r = TestReceiver::unknown(b);
        assert!(!r.fixture_window(window(b, 1, DRAIN_MS + 1), 0));
        assert!(r.fixture_window(window(b, 1, 10), 1));
        assert!(!r.enter(b, 10));
        assert!(r.fixture_window(window(b, 2, 20), 10));
        assert!(!r.enter(b, 9));
        assert!(r.closing_at.is_some());
        assert!(!r.fixture_window(window(b, 3, 20), 10));
    }

    #[test]
    fn awaits_and_late_replies_do_not_restore_slots() {
        let b = binding();
        let mut r = TestReceiver::unknown(b);
        assert!(r.fixture_window(window(b, 1, 10), 0));
        r.invalidate_for_await();
        assert!(!r.enter(b, 0));
        assert!(!r.fixture_window(window(b, 1, 10), 0));
        assert!(r.fixture_window(window(b, 2, 10), 0));
        assert!(r.enter(b, 0));
        r.invalidate_for_await();
        assert!(!r.finish());
        r.close(1);
        assert!(!r.fence_ack(), "awaited effect has an unknown outcome");
        assert!(!r.fixture_window(window(b, 3, 10), 1));
    }

    // Finite two-receiver authority model. Every edge is an atomic modeled
    // event; native/destination atomicity is an obligation, NOT platform proof.
    #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
    struct Schedule {
        registered: [bool; 2],
        windows: [bool; 2],
        entered: [bool; 2],
        closed: bool,
        receiver_closed: [bool; 2],
        fenced: [bool; 2],
        floor: bool,
        deadline: bool,
        effect_count: u8,
    }

    #[test]
    fn exhaustive_two_receiver_schedules_require_fences_not_deadlines() {
        let initial = Schedule {
            registered: [false; 2],
            windows: [false; 2],
            entered: [false; 2],
            closed: false,
            receiver_closed: [false; 2],
            fenced: [false; 2],
            floor: false,
            deadline: false,
            effect_count: 0,
        };
        let mut seen = BTreeSet::from([initial]);
        let mut pending = vec![initial];
        let mut terminal = false;
        let mut undrained_timeout = false;
        while let Some(s) = pending.pop() {
            terminal |= s.floor;
            undrained_timeout |= s.closed
                && s.deadline
                && !s.floor
                && s.registered.iter().zip(s.fenced).any(|(r, f)| *r && !f);
            let mut next = Vec::new();
            if !s.closed {
                let mut close = s;
                close.closed = true;
                next.push(close);
            }
            if s.closed && !s.deadline {
                let mut timeout = s;
                timeout.deadline = true;
                // No fabricated receiver acknowledgement or floor.
                next.push(timeout);
            }
            if s.closed && !s.floor && s.registered.iter().zip(s.fenced).all(|(r, f)| !*r || f) {
                assert!(!s.entered.iter().any(|entered| *entered));
                let mut floor = s;
                floor.floor = true;
                next.push(floor);
            }
            for i in 0..2 {
                if !s.closed && !s.registered[i] {
                    let mut register = s;
                    register.registered[i] = true;
                    next.push(register);
                }
                if !s.closed
                    && s.registered[i]
                    && !s.windows[i]
                    && !s.entered[i]
                    && s.effect_count < 2
                {
                    let mut issue = s;
                    issue.windows[i] = true;
                    next.push(issue);
                }
                if s.windows[i] && !s.receiver_closed[i] && !s.entered[i] {
                    assert!(!s.floor, "every issued window needs its receiver fence");
                    let mut enter = s;
                    enter.windows[i] = false;
                    enter.entered[i] = true;
                    next.push(enter);
                }
                if s.entered[i] && s.effect_count < 2 {
                    assert!(!s.floor, "positive effect after independent floor");
                    let mut effect = s;
                    effect.entered[i] = false;
                    effect.effect_count += 1;
                    next.push(effect);
                }
                if s.closed && s.registered[i] && !s.receiver_closed[i] {
                    let mut close_receiver = s;
                    close_receiver.receiver_closed[i] = true;
                    close_receiver.windows[i] = false;
                    next.push(close_receiver);
                }
                if s.receiver_closed[i] && !s.entered[i] && !s.fenced[i] {
                    let mut fence = s;
                    fence.fenced[i] = true;
                    next.push(fence);
                }
                // Receiver restart may lose only disposable windows; holder/
                // entered-unknown/fence/Closing history is not garbage-collected.
                if s.windows[i] {
                    let mut restart = s;
                    restart.windows[i] = false;
                    next.push(restart);
                }
            }
            for n in next {
                if seen.insert(n) {
                    pending.push(n);
                }
            }
        }
        assert!(seen.len() > 100);
        assert!(terminal, "enumeration must reach a valid floor");
        assert!(
            undrained_timeout,
            "enumeration must cover missing fence at30s"
        );
    }

    #[test]
    fn terminal_or_legacy_gone_cannot_be_a_positive_window() {
        for typed in [false, true] {
            let b = binding();
            let mut r = TestReceiver::unknown(b);
            assert!(r.fixture_window(window(b, 1, 10), 0));
            // Both Gone shapes deny. Typed identity is needed for a receipt,
            // but its absence does not turn a legacy Gone into admission.
            r.close(1);
            assert!(!r.enter(b, 1), "typed={typed}");
            assert!(r.fence_ack());
        }
    }
}
