//! The simulated network: latency, loss, partitions and reordering.
//!
//! Two link kinds, matching the transports in `log-service-api.md` §2:
//!
//! - **Stream** (a WebSocket): FIFO per direction. Losing a message *resets the
//!   connection*: everything in flight in both directions is discarded and both ends
//!   learn the connection closed. A request's fate is then unknown to its sender,
//!   which is exactly the case the append protocol's same-bytes retry exists for.
//! - **Datagram** (HTTPS unary requests): each message has an independent fate, and
//!   messages may overtake each other.
//!
//! A partition isolates an endpoint for a while: sends from or to it are lost and
//! its stream connections reset.

use std::collections::BTreeMap;

use crate::rng::{Ppm, SimRng};

/// An endpoint: a replica, a thin client, the log service, the policy authority.
pub type Endpoint = u32;

/// Network parameters.
#[derive(Debug, Clone)]
pub struct NetConfig {
    /// One-way latency range, ms.
    pub latency_ms: (u64, u64),
    /// Chance a message is lost (stream links: the connection resets).
    pub p_drop: Ppm,
    /// Datagram links: chance a message is held back by an extra delay, letting
    /// later ones overtake it.
    pub p_reorder: Ppm,
    /// The extra delay for a reordered message, ms.
    pub reorder_ms: (u64, u64),
    /// Datagram links: chance a message is delivered twice.
    pub p_duplicate: Ppm,
}

impl NetConfig {
    /// A perfect LAN: 1–5 ms, nothing lost.
    pub fn calm() -> Self {
        NetConfig {
            latency_ms: (1, 5),
            p_drop: 0,
            p_reorder: 0,
            reorder_ms: (0, 0),
            p_duplicate: 0,
        }
    }
    /// A lossy WAN.
    pub fn lossy() -> Self {
        NetConfig {
            latency_ms: (2, 60),
            p_drop: 20_000,
            p_reorder: 50_000,
            reorder_ms: (20, 400),
            p_duplicate: 5_000,
        }
    }
}

/// What happens to one message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fate {
    /// Deliver at this time. Stream links: only if the connection `epoch` is still
    /// current then (see [`Net::deliverable`]).
    Deliver {
        /// Delivery time, ms.
        at: u64,
        /// The connection epoch the message was sent in.
        epoch: u64,
        /// Also deliver a copy at this time (datagram duplicates).
        dup_at: Option<u64>,
    },
    /// Lost silently (datagram).
    Lost,
    /// Lost, and the stream connection between the two ends reset.
    Reset,
}

#[derive(Debug, Default, Clone)]
struct Link {
    epoch: u64,
    /// Last scheduled delivery per direction (FIFO).
    last: [u64; 2],
}

/// The network state.
#[derive(Debug)]
pub struct Net {
    /// Parameters (may change during a run).
    pub cfg: NetConfig,
    rng: SimRng,
    links: BTreeMap<(Endpoint, Endpoint), Link>,
    partitioned_until: BTreeMap<Endpoint, u64>,
    /// Counters.
    pub stats: NetStats,
}

/// Network counters.
#[derive(Debug, Default, Clone)]
pub struct NetStats {
    /// Messages offered.
    pub sent: u64,
    /// Messages lost.
    pub lost: u64,
    /// Connection resets.
    pub resets: u64,
    /// Messages reordered.
    pub reordered: u64,
}

fn key(a: Endpoint, b: Endpoint) -> ((Endpoint, Endpoint), usize) {
    if a <= b { ((a, b), 0) } else { ((b, a), 1) }
}

impl Net {
    /// A network.
    pub fn new(cfg: NetConfig, rng: SimRng) -> Self {
        Net {
            cfg,
            rng,
            links: BTreeMap::new(),
            partitioned_until: BTreeMap::new(),
            stats: NetStats::default(),
        }
    }

    /// Is `e` cut off at `now`?
    pub fn partitioned(&self, e: Endpoint, now: u64) -> bool {
        self.partitioned_until.get(&e).is_some_and(|t| now < *t)
    }

    /// Cut `e` off until `until`. Its stream connections reset.
    pub fn partition(&mut self, e: Endpoint, until: u64) {
        let t = self.partitioned_until.entry(e).or_default();
        *t = (*t).max(until);
        let ks: Vec<_> = self
            .links
            .keys()
            .filter(|(a, b)| *a == e || *b == e)
            .copied()
            .collect();
        for k in ks {
            self.reset_key(k);
        }
    }

    /// Heal every partition.
    pub fn heal(&mut self) {
        self.partitioned_until.clear();
    }

    fn reset_key(&mut self, k: (Endpoint, Endpoint)) {
        let l = self.links.entry(k).or_default();
        l.epoch += 1;
        self.stats.resets += 1;
    }

    /// Reset the stream connection between `a` and `b` (a process restarting, a
    /// server closing a socket).
    pub fn reset(&mut self, a: Endpoint, b: Endpoint) {
        self.reset_key(key(a, b).0);
    }

    /// The current connection epoch between `a` and `b`.
    pub fn epoch(&self, a: Endpoint, b: Endpoint) -> u64 {
        self.links.get(&key(a, b).0).map_or(0, |l| l.epoch)
    }

    /// Decide the fate of a stream message from `from` to `to` sent at `now`.
    pub fn send_stream(&mut self, now: u64, from: Endpoint, to: Endpoint) -> Fate {
        self.stats.sent += 1;
        let (k, dir) = key(from, to);
        if self.partitioned(from, now) || self.partitioned(to, now) {
            self.stats.lost += 1;
            self.reset_key(k);
            return Fate::Reset;
        }
        if self.rng.chance(self.cfg.p_drop) {
            self.stats.lost += 1;
            self.reset_key(k);
            return Fate::Reset;
        }
        let lat = self
            .rng
            .between(self.cfg.latency_ms.0, self.cfg.latency_ms.1);
        let l = self.links.entry(k).or_default();
        let at = (now + lat).max(l.last[dir]);
        l.last[dir] = at;
        Fate::Deliver {
            at,
            epoch: l.epoch,
            dup_at: None,
        }
    }

    /// Decide the fate of a datagram (unary request or response).
    pub fn send_datagram(&mut self, now: u64, from: Endpoint, to: Endpoint) -> Fate {
        self.stats.sent += 1;
        if self.partitioned(from, now)
            || self.partitioned(to, now)
            || self.rng.chance(self.cfg.p_drop)
        {
            self.stats.lost += 1;
            return Fate::Lost;
        }
        let mut at = now
            + self
                .rng
                .between(self.cfg.latency_ms.0, self.cfg.latency_ms.1);
        if self.rng.chance(self.cfg.p_reorder) {
            self.stats.reordered += 1;
            at += self
                .rng
                .between(self.cfg.reorder_ms.0, self.cfg.reorder_ms.1);
        }
        let dup_at = self
            .rng
            .chance(self.cfg.p_duplicate)
            .then(|| at + self.rng.between(0, self.cfg.latency_ms.1));
        Fate::Deliver {
            at,
            epoch: 0,
            dup_at,
        }
    }

    /// May a stream message sent in `epoch` be delivered to `to` at `now`?
    pub fn deliverable(&self, now: u64, from: Endpoint, to: Endpoint, epoch: u64) -> bool {
        !self.partitioned(to, now) && !self.partitioned(from, now) && self.epoch(from, to) == epoch
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_is_fifo_and_resets_on_loss() {
        let mut cfg = NetConfig::calm();
        cfg.latency_ms = (1, 100);
        let mut n = Net::new(cfg, SimRng::new(3));
        let mut last = 0;
        for t in 0..200 {
            match n.send_stream(t, 1, 2) {
                Fate::Deliver { at, .. } => {
                    assert!(at >= last);
                    last = at;
                }
                _ => panic!("calm net lost a message"),
            }
        }
        let e = n.epoch(1, 2);
        n.partition(2, 500);
        assert_eq!(n.send_stream(300, 2, 1), Fate::Reset);
        assert!(n.epoch(1, 2) > e);
        assert!(!n.deliverable(600, 1, 2, e));
        assert!(matches!(n.send_stream(600, 1, 2), Fate::Deliver { .. }));
    }
}
