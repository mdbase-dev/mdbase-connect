//! Prometheus text metrics for the gateway (`/metrics`).
//!
//! Counters by method and outcome (`ok` or the §10 error code), a latency
//! histogram per method, live connections, and pushes queued or dropped by the
//! outbox. No collection IDs or content appear in labels (the service is blind,
//! and per-collection labels would be unbounded).

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::sync::Mutex;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};

/// Histogram bucket bounds, ms.
pub const BUCKETS_MS: [f64; 11] = [
    1.0, 2.0, 5.0, 10.0, 25.0, 50.0, 100.0, 250.0, 500.0, 1000.0, 5000.0,
];

#[derive(Default)]
struct Hist {
    counts: [u64; BUCKETS_MS.len()],
    sum_ms: f64,
    n: u64,
}

/// Gateway metrics.
#[derive(Default)]
pub struct Metrics {
    requests: Mutex<BTreeMap<(String, String), u64>>,
    latency: Mutex<BTreeMap<String, Hist>>,
    /// Open WebSocket connections.
    pub connections: AtomicI64,
    /// Pushes delivered to outboxes.
    pub pushes: AtomicU64,
    /// Pushes dropped or coalesced under backpressure.
    pub pushes_dropped: AtomicU64,
    /// Commits observed (appends, admin writes).
    pub commits: AtomicU64,
    /// Repair appends (`service_lost_tail`): batches and restored items.
    pub repairs: AtomicU64,
    /// Items restored by repair appends.
    pub repaired_items: AtomicU64,
}

const KNOWN: &[&str] = &[
    "hello",
    "append",
    "read",
    "head",
    "put_object",
    "commit_object",
    "get_object",
    "has_objects",
    "put_snapshot",
    "get_snapshot",
    "endorse_snapshot",
    "subscribe",
    "unsubscribe",
    "stream_join",
    "stream_leave",
    "stream_send",
    "create_log",
    "set_quota",
    "delete_log",
    "revoke_device_credentials",
    "export",
    "export_objects",
    "import",
    "import_object",
    "import_snapshot",
    "compact",
    "gc",
];

impl Metrics {
    /// Record one request.
    pub fn observe(&self, method: &str, outcome: &str, ms: f64) {
        let method = if KNOWN.contains(&method) {
            method
        } else {
            "other"
        };
        *self
            .requests
            .lock()
            .unwrap()
            .entry((method.to_string(), outcome.to_string()))
            .or_default() += 1;
        let mut l = self.latency.lock().unwrap();
        let h = l.entry(method.to_string()).or_default();
        for (i, b) in BUCKETS_MS.iter().enumerate() {
            if ms <= *b {
                h.counts[i] += 1;
            }
        }
        h.sum_ms += ms;
        h.n += 1;
    }

    /// Prometheus exposition text.
    pub fn render(&self) -> String {
        let mut s = String::new();
        s.push_str("# TYPE logsvc_requests_total counter\n");
        for ((m, o), n) in self.requests.lock().unwrap().iter() {
            let _ = writeln!(
                s,
                "logsvc_requests_total{{method=\"{m}\",outcome=\"{o}\"}} {n}"
            );
        }
        s.push_str("# TYPE logsvc_request_duration_ms histogram\n");
        for (m, h) in self.latency.lock().unwrap().iter() {
            for (i, b) in BUCKETS_MS.iter().enumerate() {
                let _ = writeln!(
                    s,
                    "logsvc_request_duration_ms_bucket{{method=\"{m}\",le=\"{b}\"}} {}",
                    h.counts[i]
                );
            }
            let _ = writeln!(
                s,
                "logsvc_request_duration_ms_bucket{{method=\"{m}\",le=\"+Inf\"}} {}",
                h.n
            );
            let _ = writeln!(
                s,
                "logsvc_request_duration_ms_sum{{method=\"{m}\"}} {}",
                h.sum_ms
            );
            let _ = writeln!(
                s,
                "logsvc_request_duration_ms_count{{method=\"{m}\"}} {}",
                h.n
            );
        }
        let g = |s: &mut String, name: &str, kind: &str, v: i64| {
            let _ = writeln!(s, "# TYPE {name} {kind}\n{name} {v}");
        };
        g(
            &mut s,
            "logsvc_connections",
            "gauge",
            self.connections.load(Ordering::Relaxed),
        );
        g(
            &mut s,
            "logsvc_pushes_total",
            "counter",
            self.pushes.load(Ordering::Relaxed) as i64,
        );
        g(
            &mut s,
            "logsvc_pushes_dropped_total",
            "counter",
            self.pushes_dropped.load(Ordering::Relaxed) as i64,
        );
        g(
            &mut s,
            "logsvc_commits_total",
            "counter",
            self.commits.load(Ordering::Relaxed) as i64,
        );
        g(
            &mut s,
            "logsvc_lost_tail_repairs_total",
            "counter",
            self.repairs.load(Ordering::Relaxed) as i64,
        );
        g(
            &mut s,
            "logsvc_lost_tail_repaired_items_total",
            "counter",
            self.repaired_items.load(Ordering::Relaxed) as i64,
        );
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders() {
        let m = Metrics::default();
        m.observe("append", "ok", 3.0);
        m.observe("weird", "invalid", 700.0);
        m.observe("revoke_device_credentials", "ok", 1.0);
        m.repairs.store(2, Ordering::Relaxed);
        m.repaired_items.store(7, Ordering::Relaxed);
        let t = m.render();
        assert!(t.contains("logsvc_requests_total{method=\"append\",outcome=\"ok\"} 1"));
        assert!(t.contains("method=\"other\""));
        assert!(t.contains(
            "logsvc_requests_total{method=\"revoke_device_credentials\",outcome=\"ok\"} 1"
        ));
        assert!(
            t.contains("logsvc_lost_tail_repairs_total counter\nlogsvc_lost_tail_repairs_total 2")
        );
        assert!(t.contains(
            "logsvc_lost_tail_repaired_items_total counter\nlogsvc_lost_tail_repaired_items_total 7"
        ));
        assert!(t.contains("logsvc_request_duration_ms_bucket{method=\"append\",le=\"5\"} 1"));
    }
}
