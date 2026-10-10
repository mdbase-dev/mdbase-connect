//! Timing, percentiles and the JSON report.

use std::time::Instant;

use serde_json::{Value, json};

/// The timings of one scenario at one corpus size.
#[derive(Clone, Debug)]
pub struct Sample {
    /// Stable scenario name (`area.what`, e.g. `native.edit_visible`).
    pub scenario: String,
    /// Corpus size in notes.
    pub size: u32,
    /// Per-iteration wall time in milliseconds.
    pub ms: Vec<f64>,
    /// What one iteration does, and anything unusual.
    pub note: String,
}

impl Sample {
    /// A new, empty sample.
    pub fn new(scenario: &str, size: u32, note: &str) -> Sample {
        Sample {
            scenario: scenario.into(),
            size,
            ms: Vec::new(),
            note: note.into(),
        }
    }

    /// Time `f` once and record it.
    pub fn time<T>(&mut self, f: impl FnOnce() -> T) -> T {
        let t = Instant::now();
        let out = f();
        self.ms.push(t.elapsed().as_secs_f64() * 1e3);
        out
    }

    /// Nearest-rank percentile (`p` in 0..=100).
    pub fn pct(&self, p: f64) -> f64 {
        percentile(&self.ms, p)
    }

    /// Mean.
    pub fn mean(&self) -> f64 {
        if self.ms.is_empty() {
            return f64::NAN;
        }
        self.ms.iter().sum::<f64>() / self.ms.len() as f64
    }

    /// Coefficient of variation (stddev / mean).
    pub fn cv(&self) -> f64 {
        let m = self.mean();
        if self.ms.len() < 2 || m == 0.0 {
            return 0.0;
        }
        let var =
            self.ms.iter().map(|x| (x - m) * (x - m)).sum::<f64>() / (self.ms.len() - 1) as f64;
        var.sqrt() / m
    }

    /// JSON summary.
    pub fn to_json(&self) -> Value {
        json!({
            "scenario": self.scenario,
            "size": self.size,
            "n": self.ms.len(),
            "p50_ms": round(self.pct(50.0)),
            "p95_ms": round(self.pct(95.0)),
            "min_ms": round(self.pct(0.0)),
            "max_ms": round(self.pct(100.0)),
            "mean_ms": round(self.mean()),
            "cv": round(self.cv()),
            "note": self.note,
        })
    }
}

fn round(x: f64) -> f64 {
    (x * 1000.0).round() / 1000.0
}

/// Nearest-rank percentile of `xs` (`p` in 0..=100). NaN when empty.
pub fn percentile(xs: &[f64], p: f64) -> f64 {
    if xs.is_empty() {
        return f64::NAN;
    }
    let mut v = xs.to_vec();
    v.sort_by(f64::total_cmp);
    if p <= 0.0 {
        return v[0];
    }
    let rank = ((p / 100.0) * v.len() as f64).ceil() as usize;
    v[rank.clamp(1, v.len()) - 1]
}

/// The 1-minute load average, or NaN where `/proc/loadavg` is missing.
pub fn loadavg() -> f64 {
    std::fs::read_to_string("/proc/loadavg")
        .ok()
        .and_then(|s| s.split_whitespace().next()?.parse().ok())
        .unwrap_or(f64::NAN)
}

/// A fixed single-threaded workload (hashing, a B-tree, string building),
/// median of five runs, in milliseconds. Dividing a scenario's time by this
/// makes results roughly comparable across machines; the CI gate compares
/// those ratios rather than raw times.
pub fn calibrate() -> f64 {
    let mut runs = Vec::new();
    for _ in 0..5 {
        let t = Instant::now();
        let mut buf = vec![0u8; 4 << 20];
        let mut x = 0x9e37_79b9_7f4a_7c15u64;
        for b in buf.iter_mut() {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            *b = x as u8;
        }
        let h = mdbn_wire::hash::sha256(&buf);
        let mut m = std::collections::BTreeMap::new();
        for i in 0..200_000u64 {
            m.insert(format!("k{}", i.wrapping_mul(2_654_435_761) % 1_000_003), i);
        }
        std::hint::black_box((h, m.len()));
        runs.push(t.elapsed().as_secs_f64() * 1e3);
    }
    percentile(&runs, 50.0)
}

/// Machine and run metadata for a report.
pub fn meta(calibration_ms: f64) -> Value {
    let cpu = std::fs::read_to_string("/proc/cpuinfo")
        .ok()
        .and_then(|s| {
            s.lines()
                .find(|l| l.starts_with("model name"))
                .and_then(|l| l.split(':').nth(1))
                .map(|s| s.trim().to_string())
        })
        .unwrap_or_default();
    json!({
        "cpu": cpu,
        "threads": std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "debug_build": cfg!(debug_assertions),
        "calibration_ms": round(calibration_ms),
        "loadavg_start": loadavg(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nearest_rank() {
        let xs: Vec<f64> = (1..=100).map(f64::from).collect();
        assert_eq!(percentile(&xs, 50.0), 50.0);
        assert_eq!(percentile(&xs, 95.0), 95.0);
        assert_eq!(percentile(&xs, 100.0), 100.0);
        assert_eq!(percentile(&xs, 0.0), 1.0);
        assert_eq!(percentile(&[3.0], 95.0), 3.0);
    }
}
