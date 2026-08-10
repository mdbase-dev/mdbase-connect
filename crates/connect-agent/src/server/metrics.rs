use mdbase_connect_core::{ConnectError, MutationJournalState};
use mdbase_connect_protocol::ProtocolUsageEntry;
use std::sync::atomic::{AtomicU64, Ordering};

static DIRECT_PROTOCOL_V2: AtomicU64 = AtomicU64::new(0);
static DIRECT_PROTOCOL_V3: AtomicU64 = AtomicU64::new(0);

pub(super) fn direct_operation_transport(version: u32) {
    match version {
        mdbase_connect_protocol::LEGACY_OPERATION_TRANSPORT_PROTOCOL_VERSION => {
            DIRECT_PROTOCOL_V2.fetch_add(1, Ordering::Relaxed);
        }
        mdbase_connect_protocol::OPERATION_TRANSPORT_PROTOCOL_VERSION => {
            DIRECT_PROTOCOL_V3.fetch_add(1, Ordering::Relaxed);
        }
        _ => {}
    }
}

pub(super) fn take_direct_protocol_usage() -> Vec<ProtocolUsageEntry> {
    [
        (
            mdbase_connect_protocol::LEGACY_OPERATION_TRANSPORT_PROTOCOL_VERSION,
            DIRECT_PROTOCOL_V2.swap(0, Ordering::Relaxed),
        ),
        (
            mdbase_connect_protocol::OPERATION_TRANSPORT_PROTOCOL_VERSION,
            DIRECT_PROTOCOL_V3.swap(0, Ordering::Relaxed),
        ),
    ]
    .into_iter()
    .filter_map(|(version, count)| {
        (count > 0).then_some(ProtocolUsageEntry {
            axis: "operation_transport".to_string(),
            version,
            count,
        })
    })
    .collect()
}

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
