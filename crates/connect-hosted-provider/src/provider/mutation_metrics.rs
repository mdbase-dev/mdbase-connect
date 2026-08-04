use super::*;

pub(super) fn duplicate_replay(operation: &str) {
    tracing::info!(
        target: "mdbase_connect::metrics",
        metric = "mutation_event",
        mutation_event = "duplicate_replay",
        operation,
        "privacy-safe hosted provider metric"
    );
}

pub(super) fn lease_takeover(operation: &str) {
    tracing::warn!(
        target: "mdbase_connect::metrics",
        metric = "mutation_event",
        mutation_event = "lease_takeover",
        operation,
        "privacy-safe hosted provider metric"
    );
}

pub(super) fn outcome_unknown() {
    tracing::warn!(
        target: "mdbase_connect::metrics",
        metric = "mutation_event",
        mutation_event = "outcome_unknown",
        "privacy-safe hosted provider metric"
    );
}

pub(super) fn request_id_conflict() {
    tracing::warn!(
        target: "mdbase_connect::metrics",
        metric = "mutation_event",
        mutation_event = "request_id_conflict",
        "privacy-safe hosted provider metric"
    );
}

impl HostedProvider {
    /// Emit one privacy-safe aggregate snapshot for deployment monitoring.
    pub async fn log_operation_mutation_metrics(&self) {
        match self.operation_mutation_diagnostics().await {
            Ok(diagnostics) => tracing::info!(
                target: "mdbase_connect::metrics",
                metric = "mutation_journal_snapshot",
                state_counts = ?diagnostics.state_counts,
                oldest_unfinished_seconds = ?diagnostics.oldest_unfinished_seconds,
                tombstones = diagnostics.tombstones,
                database_pool_size = diagnostics.database_pool_size,
                database_pool_idle = diagnostics.database_pool_idle,
                "privacy-safe hosted provider metric"
            ),
            Err(error) => tracing::warn!(
                target: "mdbase_connect::metrics",
                metric = "mutation_journal_snapshot_failure",
                error_code = %error.code,
                "privacy-safe hosted provider metric"
            ),
        }
    }
}
