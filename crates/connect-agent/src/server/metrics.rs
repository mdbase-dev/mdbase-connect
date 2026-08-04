use mdbase_connect_core::{ConnectError, MutationJournalState};

pub(super) fn duplicate_replay(operation: &str, terminal_state: MutationJournalState) {
    tracing::info!(
        target: "mdbase_connect::metrics",
        metric = "mutation_event",
        mutation_event = "duplicate_replay",
        operation,
        terminal_state = ?terminal_state,
        "privacy-safe connector metric"
    );
}

pub(super) fn lease_takeover(operation: &str, recovery_state: MutationJournalState) {
    tracing::warn!(
        target: "mdbase_connect::metrics",
        metric = "mutation_event",
        mutation_event = "lease_takeover",
        operation,
        recovery_state = ?recovery_state,
        "privacy-safe connector metric"
    );
}

pub(super) fn outcome_unknown() {
    tracing::warn!(
        target: "mdbase_connect::metrics",
        metric = "mutation_event",
        mutation_event = "outcome_unknown",
        "privacy-safe connector metric"
    );
}

pub(super) fn claim_error(operation: &str, error: &ConnectError) {
    if !matches!(error, ConnectError::MutationRequestConflict { .. }) {
        return;
    }
    tracing::warn!(
        target: "mdbase_connect::metrics",
        metric = "mutation_event",
        mutation_event = "request_id_conflict",
        operation,
        "privacy-safe connector metric"
    );
}
