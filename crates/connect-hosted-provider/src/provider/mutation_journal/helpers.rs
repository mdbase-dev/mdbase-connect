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

/// Kinds whose failed attempt releases its lease instead of storing the error
/// as the final receipt: `sync:mutate` and every `file_control:*` kind. Their
/// clients resend the same request ID until it succeeds, so a stored error
/// would be replayed to them forever. The SQL in this module, diagnostics and
/// compaction matches the same kinds as
/// `split_part(operation_kind, ':', 1) IN ('sync', 'file_control')`.
fn releases_failed_attempts(operation_kind: &str) -> bool {
    operation_kind == "sync:mutate" || operation_kind.starts_with("file_control:")
}

/// Reopen a stored failure of a releasing kind so the claim takes it over like
/// any expired lease. A row without evidence re-runs as `prepared`: for a sync
/// mutation nothing committed (the effect and its evidence commit together);
/// a file control never writes journal evidence, and re-running it resumes or
/// replays its own transfer or file mutation, keyed by the same public ID. A
/// sync row with evidence committed and then had an error stored over it, so
/// it replays as `applied`.
async fn reopen_stored_failure_in(
    transaction: &mut Transaction<'_, Postgres>,
    replica_id: Uuid,
    request_id: Uuid,
) -> ApiResult<String> {
    sqlx::query_scalar(
        r#"UPDATE hosted_provider_mutation_journal
           SET state = CASE WHEN evidence_kind IS NULL THEN 'prepared' ELSE 'applied' END,
               final_receipt_ciphertext = NULL, receipt_digest = NULL,
               completed_at = NULL, lease_expires_at = now(), updated_at = now()
           WHERE replica_id = $1 AND request_id = $2
             AND split_part(operation_kind, ':', 1) IN ('sync', 'file_control')
             AND state = 'completed'
           RETURNING state"#,
    )
    .bind(replica_id)
    .bind(request_id)
    .fetch_optional(&mut **transaction)
    .await?
    .ok_or_else(|| mutation_fence_lost(request_id))
}

/// Delete released sync mutations and file controls 30 days after release.
///
/// A released sync mutation never applied: the effect and its evidence commit
/// in one transaction, and this row has no evidence. A causal successor
/// already treats a `prepared` predecessor as missing, and a retry of the same
/// mutation ID after deletion claims a fresh row and runs once.
///
/// A file control's effect lives in its own transfer or file mutation record,
/// keyed by the public transfer or mutation ID, which this does not touch. A
/// retry after deletion claims a fresh row and re-runs the control, which
/// resumes or replays that record (or fails its revision precondition), so it
/// still takes effect at most once.
///
/// The lease condition keeps a live owner's row; a concurrent claim re-locks
/// the row and moves `updated_at`, so the delete re-checks and skips it.
async fn compact_released_mutations_in(
    transaction: &mut Transaction<'_, Postgres>,
) -> ApiResult<u64> {
    Ok(sqlx::query(
        r#"DELETE FROM hosted_provider_mutation_journal
           WHERE split_part(operation_kind, ':', 1) IN ('sync', 'file_control')
             AND state = 'prepared'
             AND evidence_kind IS NULL AND lease_expires_at <= now()
             AND updated_at <= now() - interval '30 days'"#,
    )
    .execute(&mut **transaction)
    .await?
    .rows_affected())
}

impl HostedProvider {
    /// Give up a lease without a final receipt, so the next attempt takes the
    /// row over at once. Fenced on this lease: a lost lease releases nothing.
    /// Best effort: if this write fails too, the lease simply expires.
    pub(super) async fn release_operation_mutation(&self, lease: &HostedMutationLease) {
        let released = sqlx::query(
            r#"UPDATE hosted_provider_mutation_journal
               SET lease_expires_at = now(), updated_at = now()
               WHERE replica_id = $1 AND request_id = $2 AND input_digest = $3
                 AND process_epoch = $4 AND lease_owner = $5
                 AND fencing_generation = $6
                 AND state IN ('claimed', 'prepared', 'applied')"#,
        )
        .bind(lease.replica_id)
        .bind(lease.request_id)
        .bind(&lease.input_digest)
        .bind(lease.process_epoch)
        .bind(lease.owner)
        .bind(lease.generation)
        .execute(&self.pool)
        .await;
        if released.is_err() {
            tracing::warn!("hosted mutation lease release deferred to lease expiry");
        }
    }
}
