//! The re-seal cost and time estimate (migration estimates). Pure arithmetic
//! over metadata (`mdbn_legacy::hosted::source::FileTotals`), never content.

/// Model parameters. Defaults are illustrative; measured values may replace
/// them.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Model {
    /// R2 Class A (PUT) price per million operations, USD.
    pub class_a_per_million: f64,
    /// R2 Class B (GET) price per million operations, USD.
    pub class_b_per_million: f64,
    /// R2 storage per GB-month, USD.
    pub storage_per_gb_month: f64,
    /// Months the old objects are kept beside the new ones: the 90-day retention
    /// (for the configured overlap period).
    pub overlap_months: f64,
    /// Sustained read+write throughput per worker, bytes per second.
    pub throughput: f64,
    /// Per-object latency (GET, has, PUT, commit), seconds.
    pub latency: f64,
    /// Objects in flight per worker.
    pub concurrency: f64,
    /// Collections processed in parallel.
    pub workers: f64,
}

impl Default for Model {
    fn default() -> Self {
        Self {
            class_a_per_million: 4.50,
            class_b_per_million: 0.36,
            storage_per_gb_month: 0.015,
            overlap_months: 3.0,
            throughput: 40e6,
            latency: 0.25,
            concurrency: 16.0,
            workers: 8.0,
        }
    }
}

/// Inputs: live files only; historical versions are not imported.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Totals {
    /// Live files.
    pub files: u64,
    /// Their bytes.
    pub bytes: u64,
    /// 8 MiB parts (at least one per file).
    pub parts: u64,
    /// Collections they belong to.
    pub collections: u64,
}

/// The estimate.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Estimate {
    /// GET cost, USD.
    pub get_usd: f64,
    /// PUT cost, USD.
    pub put_usd: f64,
    /// Storage overlap cost, USD.
    pub storage_usd: f64,
    /// Total, USD.
    pub total_usd: f64,
    /// Wall time with the model's parallelism, seconds.
    pub seconds: f64,
}

/// `cost = GET per file + PUT per part + overlap storage`;
/// `time = (bytes / throughput + files × latency / concurrency) / workers`.
pub fn estimate(t: &Totals, m: &Model) -> Estimate {
    let get_usd = t.files as f64 * m.class_b_per_million / 1e6;
    let put_usd = t.parts as f64 * m.class_a_per_million / 1e6;
    let storage_usd = t.bytes as f64 / 1e9 * m.storage_per_gb_month * m.overlap_months;
    let serial = t.bytes as f64 / m.throughput + t.files as f64 * m.latency / m.concurrency;
    let parallel = m.workers.min(t.collections.max(1) as f64);
    Estimate {
        get_usd,
        put_usd,
        storage_usd,
        total_usd: get_usd + put_usd + storage_usd,
        seconds: serial / parallel,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Example: one collection at the tier limit, 2,000 files in 1 GiB, takes
    /// about a minute and costs about five cents (90 days of double storage).
    #[test]
    fn tier_limit_row() {
        let gib = 1u64 << 30;
        let e = estimate(
            &Totals {
                files: 2000,
                bytes: gib,
                parts: 2000,
                collections: 1,
            },
            &Model::default(),
        );
        assert!((50.0..70.0).contains(&e.seconds), "{e:?}");
        assert!((0.04..0.06).contains(&e.total_usd), "{e:?}");
    }

    #[test]
    fn parallelism_is_capped_by_collections() {
        let t = Totals {
            files: 100,
            bytes: 100 << 20,
            parts: 100,
            collections: 1,
        };
        let one = estimate(&t, &Model::default()).seconds;
        let many = estimate(
            &Totals {
                collections: 50,
                ..t
            },
            &Model::default(),
        )
        .seconds;
        assert!(one > many);
    }
}
