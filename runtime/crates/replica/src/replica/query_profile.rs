//! Trusted host resource policy, independent of query or grant authority.

/// Source admission limits for one entire constrained query, including overlays,
/// indexed and fallback reads, retries and rereads. Allocation limits are separate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QuerySourceLimits {
    /// Maximum admitted records across the whole query.
    pub records: u32,
    /// Maximum admitted encoded/source bytes across the whole query.
    pub bytes: u64,
}

/// Per-replica fallback policy selected by the trusted host, never a query input.
/// Indexed execution retains its own limits under either profile.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub enum QueryExecutionProfile {
    /// Hosted DO and mobile/webview: budget before all source access; fail the
    /// whole request explicitly on exhaustion, never publish partial results.
    #[default]
    MemoryConstrained,
    /// Temporary desktop compatibility for shapes the index cannot answer.
    /// Only desktop hosts may explicitly select this unbounded fallback policy.
    Desktop,
}

impl QueryExecutionProfile {
    /// The fallback's source policy. `None` is the explicit desktop exception,
    /// not index eligibility, storage health, authorization or a partial-result flag.
    pub const fn fallback_source_limits(self) -> Option<QuerySourceLimits> {
        match self {
            Self::MemoryConstrained => Some(QuerySourceLimits {
                records: 1000,
                bytes: 1 << 20,
            }),
            Self::Desktop => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_constrained_and_desktop_exception_is_explicit() {
        assert_eq!(
            QueryExecutionProfile::default(),
            QueryExecutionProfile::MemoryConstrained
        );
        assert_eq!(
            QueryExecutionProfile::default().fallback_source_limits(),
            Some(QuerySourceLimits {
                records: 1000,
                bytes: 1 << 20
            })
        );
        assert_eq!(
            QueryExecutionProfile::Desktop.fallback_source_limits(),
            None
        );
    }
}
