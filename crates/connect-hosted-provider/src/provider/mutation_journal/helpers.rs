pub(super) fn hosted_mutation_receipt_aad(replica_id: Uuid, request_id: Uuid) -> Vec<u8> {
    format!("hosted-provider/mutation-journal/v1/{replica_id}/{request_id}").into_bytes()
}

fn hosted_mutation_applied_aad(replica_id: Uuid, request_id: Uuid) -> Vec<u8> {
    format!("hosted-provider/mutation-applied/v1/{replica_id}/{request_id}").into_bytes()
}

fn hosted_mutation_prepared_aad(replica_id: Uuid, request_id: Uuid) -> Vec<u8> {
    format!("hosted-provider/mutation-prepared/v1/{replica_id}/{request_id}").into_bytes()
}

fn hosted_sync_effect_aad(replica_id: Uuid, request_id: Uuid) -> Vec<u8> {
    format!("hosted-provider/sync-effect/v1/{replica_id}/{request_id}").into_bytes()
}

pub(super) fn sync_receipt_applied(receipt: &SyncMutationReceipt) -> bool {
    matches!(
        receipt,
        SyncMutationReceipt::Applied { .. } | SyncMutationReceipt::PreviouslyApplied { .. }
    )
}

fn mutation_conflict(request_id: Uuid) -> ApiError {
    super::mutation_metrics::request_id_conflict();
    ApiError::conflict(
        "mutation_request_conflict",
        "This request ID was already bound to different mutation input.",
    )
    .with_details(json!({ "request_id": request_id }))
}

fn mutation_fence_lost(request_id: Uuid) -> ApiError {
    ApiError::conflict(
        "pending_mutation_unresolved",
        "The hosted mutation lease was taken over by another recovery owner.",
    )
    .with_details(json!({ "request_id": request_id }))
}
