//! Per-socket push backpressure.
//!
//! The Workers runtime queues every WebSocket send without limit and reports
//! no buffered amount, so this object bounds what it hands each socket instead:
//! at most [`WINDOW_BYTES`] per [`WINDOW_MS`]. Over budget, an `items` push is
//! replaced by its `head` push (the client reads the items itself: a resync),
//! ephemeral stream traffic is dropped, and state pushes (`head`, `closed`) are
//! always sent, so a socket never misses that the log moved or ended.

use std::collections::BTreeMap;

use mdbn_log_service::hub::PushClass;

/// Bytes one socket may be sent per window before pushes degrade.
pub const WINDOW_BYTES: u64 = 1 << 20;
/// Window length.
pub const WINDOW_MS: i64 = 1_000;

/// What to send for one push.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// The push itself.
    Send,
    /// Its `head` fallback: the client resyncs by reading.
    Resync,
    /// Nothing.
    Drop,
}

/// Bytes sent per socket in its current window.
#[derive(Debug, Default)]
pub struct PushBudget {
    sockets: BTreeMap<u64, (i64, u64)>,
}

impl PushBudget {
    /// Decide for a push of `bytes` to `to`, and charge what is sent. `fallback`
    /// is the size of the push's `head` fallback, when it has one.
    pub fn admit(
        &mut self,
        to: u64,
        now: i64,
        class: PushClass,
        bytes: u64,
        fallback: Option<u64>,
    ) -> Verdict {
        let (start, used) = self.sockets.entry(to).or_insert((now, 0));
        if now - *start >= WINDOW_MS || now < *start {
            *start = now;
            *used = 0;
        }
        let fits = used.saturating_add(bytes) <= WINDOW_BYTES;
        let (verdict, charged) = match class {
            PushClass::State => (Verdict::Send, bytes),
            _ if fits => (Verdict::Send, bytes),
            PushClass::Items => match fallback {
                Some(head) => (Verdict::Resync, head),
                None => (Verdict::Drop, 0),
            },
            PushClass::Ephemeral => (Verdict::Drop, 0),
        };
        *used = used.saturating_add(charged);
        verdict
    }

    /// The socket closed.
    pub fn forget(&mut self, to: u64) {
        self.sockets.remove(&to);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_flooded_socket_resyncs_instead_of_buffering_and_recovers_next_window() {
        let mut b = PushBudget::default();
        let item = WINDOW_BYTES / 4;
        let sent: Vec<_> = (0..6)
            .map(|_| b.admit(1, 0, PushClass::Items, item, Some(40)))
            .collect();
        assert_eq!(&sent[..4], &[Verdict::Send; 4]);
        assert_eq!(&sent[4..], &[Verdict::Resync; 2]);
        // State is never dropped; stream traffic is.
        assert_eq!(b.admit(1, 10, PushClass::State, 40, None), Verdict::Send);
        assert_eq!(
            b.admit(1, 10, PushClass::Ephemeral, 10, None),
            Verdict::Drop
        );
        // Another socket has its own budget.
        assert_eq!(
            b.admit(2, 10, PushClass::Items, item, Some(40)),
            Verdict::Send
        );
        // The next window sends items again.
        assert_eq!(
            b.admit(1, WINDOW_MS, PushClass::Items, item, Some(40)),
            Verdict::Send
        );
    }
}
