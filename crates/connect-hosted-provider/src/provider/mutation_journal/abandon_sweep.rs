// Expired `prepared` sweep (ADR 0005, decision by Callum, 2026-11-07).
//
// A `prepared` row whose handler crashed stays unresolved until the same
// request is retried, and some never are. Rows past their lease and older than
// one day are closed here with a final `mutation_abandoned` receipt.

/// Kinds whose effect commits in the same transaction that moves the journal
/// row out of `prepared` (fenced on the lease), so a `prepared` row proves the
/// change was not applied.
///
/// `sync:mutate` is atomic too, but is not swept: sync clients (the mirror and
/// the offline replica) resend a pending mutation automatically, and a terminal
/// error receipt would block their queue for good, while a takeover retry still
/// completes it.
const NOT_APPLIED_WHEN_PREPARED: &[&str] = &[
    "create",
    "update",
    "delete",
    "rename",
    "create_type",
    "update_type",
    "apply_type_pack",
    "apply_collection_setup",
    "create_view_source",
    "update_view_source",
    "delete_view_source",
];

/// Timer kinds, abandoned unproven: their timer-store effect runs outside the
/// journal transaction. `cancel_timer` is swept by recorded decision even
/// though the journal keeps no `generation` (only the input digest): a request
/// untouched for a day is not a live retry, and the app recovers by sending its
/// current desired timers.
///
/// `file_control:*` kinds are not swept. Their effect runs in the file
/// lifecycle's own transactions (and object storage) between the claim, which
/// writes `prepared`, and the journal's move to `completed`, so `prepared`
/// proves nothing. Takeover resumes their keyed inner lifecycle instead.
const UNVERIFIED_TIMER_KINDS: &[&str] = &["put_timer", "cancel_timer", "reconcile_timers"];

/// Counts from one sweep tick (serialized for tests). Counts only: no
/// identifiers.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct HostedMutationSweep {
    abandoned_not_applied: u64,
    abandoned_unverified: u64,
    skipped_migrating: u64,
    skipped_other_inactive: u64,
    skipped_kind: u64,
    skipped_record_exists: u64,
    failed_key_unwrap: u64,
    errors: u64,
}

impl HostedMutationSweep {
    fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

enum SweepRow {
    Abandoned(AbandonedApplication),
    SkippedMigrating,
    SkippedOtherInactive,
    SkippedKind,
    SkippedRecordExists,
    FailedKeyUnwrap,
    /// Finished, retried, renewed or locked by a live request since the
    /// candidate query: nothing to do this tick.
    Resolved,
}

fn sweep_application(operation_kind: &str) -> Option<AbandonedApplication> {
    if NOT_APPLIED_WHEN_PREPARED.contains(&operation_kind) {
        Some(AbandonedApplication::NotApplied)
    } else if UNVERIFIED_TIMER_KINDS.contains(&operation_kind) {
        Some(AbandonedApplication::Unverified)
    } else {
        None
    }
}

fn sweepable_kinds() -> Vec<String> {
    NOT_APPLIED_WHEN_PREPARED
        .iter()
        .chain(UNVERIFIED_TIMER_KINDS)
        .map(|kind| (*kind).to_string())
        .collect()
}

/// Lease expired more than a day ago. A takeover sets a fresh lease, so a row
/// a handler took over recently is never swept under it, however old the
/// request. Shared by the candidate query and the locked re-check.
const SWEEP_AGE_PREDICATE: &str = "journal.state = 'prepared' \
     AND journal.lease_expires_at < now() - interval '1 day'";

impl HostedProvider {
    /// ADR 0005: a taken-over timer request without a timer generation is
    /// abandoned unproven, because re-running its stale input could overwrite
    /// a newer timer change. Other requests return `None` and are recovered.
    pub(super) async fn abandon_timer_takeover(
        &self,
        collection_id: Uuid,
        operation: &str,
        input: &Value,
        lease: &HostedMutationLease,
    ) -> Option<ApiResult<Value>> {
        if !timer_takeover_is_abandoned(operation, input) {
            return None;
        }
        Some(
            self.abandon_operation_mutation(collection_id, lease, AbandonedApplication::Unverified)
                .await,
        )
    }

    /// Close up to `batch` expired `prepared` mutations with their final
    /// abandoned receipts. Only collections in `active` or `migrated` are
    /// swept; `migrating` is skipped so a migration drain or archive never sees
    /// the journal change under it. Each tick continues from a keyset cursor
    /// and wraps at the end, so rows left in place (a record that exists, a
    /// key that will not unwrap, an error) cannot starve rows behind them.
    pub async fn sweep_abandoned_operation_mutations(
        &self,
        batch: i64,
    ) -> ApiResult<HostedMutationSweep> {
        let kinds = sweepable_kinds();
        let skipped = sqlx::query(AssertSqlSafe(format!(
            r#"SELECT
                 count(*) FILTER (WHERE collection.state = 'migrating') AS migrating,
                 count(*) FILTER (
                   WHERE collection.state NOT IN ('active', 'migrated', 'migrating')
                 ) AS other_inactive,
                 count(*) FILTER (
                   WHERE collection.state IN ('active', 'migrated')
                     AND NOT (journal.operation_kind = ANY($1))
                 ) AS skipped_kind
               FROM hosted_provider_mutation_journal journal
               JOIN hosted_provider_replicas replica ON replica.id = journal.replica_id
               JOIN hosted_provider_collections collection
                 ON collection.id = replica.collection_id
               WHERE {SWEEP_AGE_PREDICATE}"#
        )))
        .bind(&kinds)
        .fetch_one(&self.pool)
        .await?;
        let mut sweep = HostedMutationSweep {
            skipped_migrating: sweep_count(skipped.get("migrating")),
            skipped_other_inactive: sweep_count(skipped.get("other_inactive")),
            skipped_kind: sweep_count(skipped.get("skipped_kind")),
            ..HostedMutationSweep::default()
        };
        let mut cursor_guard = self.mutation_sweep_cursor.lock().await;
        let cursor = *cursor_guard;
        let candidates = sqlx::query(AssertSqlSafe(format!(
            r#"SELECT journal.accepted_at, journal.replica_id, journal.request_id,
                      replica.collection_id
               FROM hosted_provider_mutation_journal journal
               JOIN hosted_provider_replicas replica ON replica.id = journal.replica_id
               JOIN hosted_provider_collections collection
                 ON collection.id = replica.collection_id
               WHERE {SWEEP_AGE_PREDICATE}
                 AND journal.operation_kind = ANY($1)
                 AND collection.state IN ('active', 'migrated')
                 AND ($3::timestamptz IS NULL
                   OR (journal.accepted_at, journal.replica_id, journal.request_id)
                      > ($3, $4, $5))
               ORDER BY journal.accepted_at, journal.replica_id, journal.request_id
               LIMIT $2"#
        )))
        .bind(&kinds)
        .bind(batch)
        .bind(cursor.map(|key| key.0))
        .bind(cursor.map(|key| key.1))
        .bind(cursor.map(|key| key.2))
        .fetch_all(&self.pool)
        .await?;
        // A short page reached the end: the next tick starts over.
        let mut next = None;
        let full_page = i64::try_from(candidates.len()).is_ok_and(|len| len >= batch);
        for candidate in &candidates {
            if full_page {
                next = Some((
                    candidate.get("accepted_at"),
                    candidate.get("replica_id"),
                    candidate.get("request_id"),
                ));
            }
            match self
                .sweep_abandoned_operation_mutation(
                    candidate.get("collection_id"),
                    candidate.get("replica_id"),
                    candidate.get("request_id"),
                )
                .await
            {
                Ok(SweepRow::Abandoned(AbandonedApplication::NotApplied)) => {
                    sweep.abandoned_not_applied += 1
                }
                Ok(SweepRow::Abandoned(AbandonedApplication::Unverified)) => {
                    sweep.abandoned_unverified += 1
                }
                Ok(SweepRow::SkippedMigrating) => sweep.skipped_migrating += 1,
                Ok(SweepRow::SkippedOtherInactive) => sweep.skipped_other_inactive += 1,
                Ok(SweepRow::SkippedKind) => sweep.skipped_kind += 1,
                Ok(SweepRow::SkippedRecordExists) => sweep.skipped_record_exists += 1,
                Ok(SweepRow::FailedKeyUnwrap) => sweep.failed_key_unwrap += 1,
                Ok(SweepRow::Resolved) => {}
                Err(_) => sweep.errors += 1,
            }
        }
        *cursor_guard = next;
        Ok(sweep)
    }

    async fn sweep_abandoned_operation_mutation(
        &self,
        collection_id: Uuid,
        replica_id: Uuid,
        request_id: Uuid,
    ) -> ApiResult<SweepRow> {
        let mut transaction = self.pool.begin().await?;
        sqlx::query("SET LOCAL lock_timeout = '5s'")
            .execute(&mut *transaction)
            .await?;
        // Lock order: collection row, then journal row. Every transaction
        // that locks both takes the collection first (claim: FOR SHARE;
        // record, sync, type and resource writes: FOR UPDATE or FOR NO KEY
        // UPDATE, before their journal UPDATE); none locks a journal row and
        // then the collection. The journal row is also taken SKIP LOCKED, so
        // the sweep never waits on a live request: the only lock it can wait
        // on is this first one, while it holds nothing.
        // FOR SHARE holds off a concurrent move to `migrating` until commit,
        // and a move that won the lock first is seen here and skipped.
        let Some(collection) = sqlx::query(
            "SELECT state, wrapped_data_key FROM hosted_provider_collections WHERE id = $1 FOR SHARE",
        )
        .bind(collection_id)
        .fetch_optional(&mut *transaction)
        .await?
        else {
            return Ok(SweepRow::Resolved);
        };
        match collection.get::<String, _>("state").as_str() {
            "active" | "migrated" => {}
            "migrating" => return Ok(SweepRow::SkippedMigrating),
            _ => return Ok(SweepRow::SkippedOtherInactive),
        }
        let Some(row) = sqlx::query(AssertSqlSafe(format!(
            r#"SELECT journal.operation_kind, journal.input_digest,
                      journal.fencing_generation
               FROM hosted_provider_mutation_journal journal
               WHERE journal.replica_id = $1 AND journal.request_id = $2
                 AND {SWEEP_AGE_PREDICATE}
               FOR UPDATE SKIP LOCKED"#
        )))
        .bind(replica_id)
        .bind(request_id)
        .fetch_optional(&mut *transaction)
        .await?
        else {
            return Ok(SweepRow::Resolved);
        };
        let operation_kind: String = row.get("operation_kind");
        let Some(application) = sweep_application(&operation_kind) else {
            return Ok(SweepRow::SkippedKind);
        };
        if operation_kind == "create" {
            // A create's record id is its request id. Any trace of that record
            // contradicts `prepared`, so the row is left alone.
            let created: bool = sqlx::query_scalar(
                r#"SELECT EXISTS (
                     SELECT 1 FROM hosted_provider_records
                     WHERE collection_id = $1 AND record_id = $2
                   ) OR EXISTS (
                     SELECT 1 FROM hosted_provider_record_versions
                     WHERE collection_id = $1 AND record_id = $2
                   )"#,
            )
            .bind(collection_id)
            .bind(request_id)
            .fetch_one(&mut *transaction)
            .await?;
            if created {
                return Ok(SweepRow::SkippedRecordExists);
            }
        }
        let Ok(data_key) = self
            .collection_key(collection_id, collection.get("wrapped_data_key"))
            .await
        else {
            return Ok(SweepRow::FailedKeyUnwrap);
        };
        let lease = self
            .take_over_operation_mutation_in(
                &mut transaction,
                replica_id,
                request_id,
                row.get("input_digest"),
                row.get("fencing_generation"),
            )
            .await?;
        self.finish_operation_mutation_in(
            &mut transaction,
            &data_key,
            &lease,
            &Err(mutation_abandoned(request_id, application)),
            "abandoned",
        )
        .await?;
        transaction.commit().await?;
        Ok(SweepRow::Abandoned(application))
    }

    /// One maintenance tick of the sweep, logged as counts only.
    pub async fn log_abandoned_operation_mutation_sweep(&self, batch: i64) {
        match self.sweep_abandoned_operation_mutations(batch).await {
            Ok(sweep) => log_mutation_sweep(&sweep),
            Err(error) => tracing::warn!(
                target: "mdbase_connect::metrics",
                metric = "mutation_abandon_sweep_failure",
                error_code = %error.code,
                "privacy-safe hosted provider metric"
            ),
        }
    }
}

/// Timer requests not guarded by a timer generation.
fn timer_takeover_is_abandoned(operation: &str, input: &Value) -> bool {
    match operation {
        "put_timer" | "reconcile_timers" => true,
        "cancel_timer" => input.get("generation").is_none_or(Value::is_null),
        _ => false,
    }
}

fn sweep_count(value: i64) -> u64 {
    u64::try_from(value).unwrap_or(0)
}

fn log_mutation_sweep(sweep: &HostedMutationSweep) {
    if sweep.is_empty() {
        return;
    }
    tracing::info!(
        target: "mdbase_connect::metrics",
        metric = "mutation_abandon_sweep",
        abandoned_not_applied = sweep.abandoned_not_applied,
        abandoned_unverified = sweep.abandoned_unverified,
        skipped_migrating = sweep.skipped_migrating,
        skipped_other_inactive = sweep.skipped_other_inactive,
        skipped_kind = sweep.skipped_kind,
        skipped_record_exists = sweep.skipped_record_exists,
        failed_key_unwrap = sweep.failed_key_unwrap,
        errors = sweep.errors,
        "privacy-safe hosted provider metric"
    );
}

#[cfg(test)]
mod abandon_sweep_tests {
    use std::io::Write;
    use std::sync::{Arc, Mutex};

    use super::{
        log_mutation_sweep, sweep_application, timer_takeover_is_abandoned, AbandonedApplication,
        HostedMutationSweep,
    };

    #[derive(Clone, Default)]
    struct Captured(Arc<Mutex<Vec<u8>>>);

    impl Write for Captured {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn sweep_log_line_carries_counts_only() {
        let captured = Captured::default();
        let writer = captured.clone();
        let subscriber = tracing_subscriber::fmt()
            .with_writer(move || writer.clone())
            .with_ansi(false)
            .without_time()
            .finish();
        tracing::subscriber::with_default(subscriber, || {
            log_mutation_sweep(&HostedMutationSweep::default());
            log_mutation_sweep(&HostedMutationSweep {
                abandoned_not_applied: 3,
                abandoned_unverified: 2,
                skipped_migrating: 1,
                skipped_other_inactive: 4,
                skipped_kind: 5,
                skipped_record_exists: 8,
                failed_key_unwrap: 6,
                errors: 7,
            });
        });
        let output = String::from_utf8(captured.0.lock().unwrap().clone()).unwrap();
        let lines: Vec<&str> = output.lines().collect();
        assert_eq!(lines.len(), 1, "an empty sweep logs nothing: {output}");
        let line = lines[0];
        let fields = line
            .split_once("privacy-safe hosted provider metric")
            .unwrap()
            .1
            .split_whitespace()
            .collect::<Vec<_>>();
        assert_eq!(fields[0], "metric=\"mutation_abandon_sweep\"", "{line}");
        let counts = &fields[1..];
        assert_eq!(counts.len(), 8, "{line}");
        for field in counts {
            let (name, value) = field.split_once('=').unwrap();
            assert!(
                name.chars().all(|c| c.is_ascii_lowercase() || c == '_'),
                "{line}"
            );
            value
                .parse::<u64>()
                .unwrap_or_else(|_| panic!("non-count field in {line}"));
        }
    }

    #[test]
    fn sweep_classifies_kinds() {
        assert_eq!(
            sweep_application("create"),
            Some(AbandonedApplication::NotApplied)
        );
        assert_eq!(
            sweep_application("put_timer"),
            Some(AbandonedApplication::Unverified)
        );
        for kind in ["reconcile_timers", "cancel_timer"] {
            assert_eq!(
                sweep_application(kind),
                Some(AbandonedApplication::Unverified),
                "{kind}"
            );
        }
        for kind in [
            "sync:mutate",
            "file_control:delete_file",
            "file_control:move_file",
            "file_control:commit_file_upload",
            "file_control:abort_file_transfer",
            "file_control:open_file_upload",
            "unknown",
        ] {
            assert_eq!(sweep_application(kind), None, "{kind}");
        }
    }

    #[test]
    fn only_generation_guarded_timer_cancels_are_rerun_on_takeover() {
        let input = serde_json::json!({ "namespace": "reminders", "id": "task-1" });
        assert!(timer_takeover_is_abandoned("put_timer", &input));
        assert!(timer_takeover_is_abandoned("reconcile_timers", &input));
        assert!(timer_takeover_is_abandoned("cancel_timer", &input));
        assert!(timer_takeover_is_abandoned(
            "cancel_timer",
            &serde_json::json!({ "namespace": "reminders", "id": "task-1", "generation": null })
        ));
        assert!(!timer_takeover_is_abandoned(
            "cancel_timer",
            &serde_json::json!({ "namespace": "reminders", "id": "task-1", "generation": 3 })
        ));
        for operation in ["create", "update", "sync", "apply_type_pack"] {
            assert!(
                !timer_takeover_is_abandoned(operation, &input),
                "{operation}"
            );
        }
    }
}
