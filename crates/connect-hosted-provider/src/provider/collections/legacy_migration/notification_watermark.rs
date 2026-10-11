//! Complete content-free notification drain snapshot and watermark.
use super::*;
use futures_util::TryStreamExt;
use sha2::{Digest, Sha256};

// Stream every sorted content-free row, with no inventory/aggregate-byte cap.
// The complete (primary key, xmin) set detects inserts/deletes and ANY update,
// including replacement of an opaque lease with identical presence/expiry. No
// token, payload or token/payload hash is selected. A freeze/VACUUM-induced
// difference is conservatively CHANGED. The fence window is bounded: xid
// wraparound is outside that window, never an "unchanged" fallback.
// Decimal integers/xmin are text; schedules are UTC microsecond text. Frame each
// jsonb text row with its u64 byte length before hashing, in ONE RR RO snapshot.
const NOTIFICATION_WATERMARK_ROWS_SQL: &str = r#"
    SELECT metadata FROM (
      SELECT 0 AS kind, t.namespace, t.id,
        jsonb_build_array('timer', t.namespace, t.id, t.xmin::text,
          t.generation::text, t.status,
          to_char(t.fire_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          t.lease_token IS NOT NULL, t.lease_worker IS NOT NULL,
          to_char(t.lease_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))::text AS metadata
        FROM mdbase_runtime_timers t
        WHERE t.namespace = 'connect-hosted:' || ($1::uuid)::text || ':notifications'
      UNION ALL
      SELECT 1 AS kind, r.namespace, r.id,
        jsonb_build_array('run', r.namespace, r.id, r.xmin::text,
          r.revision::text, r.status, r.executor, r.workflow, r.trigger_id,
          to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          to_char(r.not_before AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          r.lease_token IS NOT NULL, r.lease_worker IS NOT NULL,
          to_char(r.lease_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))::text AS metadata
        FROM mdbase_runtime_runs r
        WHERE r.namespace = 'connect-hosted:' || ($1::uuid)::text || ':notifications'
    ) rows ORDER BY kind, namespace COLLATE "C", id COLLATE "C"
"#;

fn notification_watermark_frame(hash: &mut Sha256, value: &str) {
    hash.update((value.len() as u64).to_be_bytes());
    hash.update(value.as_bytes());
}

impl HostedProvider {
    /// The drain status of one collection (H6).
    pub async fn legacy_migration_drain(
        &self,
        collection_id: Uuid,
    ) -> ApiResult<LegacyMigrationDrain> {
        let mut transaction = self.pool.begin().await?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            .execute(&mut *transaction)
            .await?;
        sqlx::query("SET LOCAL statement_timeout = '5s'")
            .execute(&mut *transaction)
            .await?;
        let sql = format!(
            r#"SELECT c.state, c.head, c.legacy_migration_id, c.legacy_migration_started_at, c.legacy_retain_until,
                      count(j.request_id) FILTER (
                        WHERE j.state IN ('claimed', 'prepared') AND j.lease_expires_at > now()
                      ) + ({NOTIFICATION_BLOCKERS_SQL}) AS in_flight,
                      count(j.request_id) FILTER (
                        WHERE j.state IN ('claimed', 'prepared')
                      ) + ({NOTIFICATION_BLOCKERS_SQL}) AS unresolved,
                      count(j.request_id) FILTER (WHERE j.state = 'applied') AS applied
               FROM hosted_provider_collections c
               LEFT JOIN hosted_provider_replicas r ON r.collection_id = c.id
               LEFT JOIN hosted_provider_mutation_journal j ON j.replica_id = r.id
               WHERE c.id = $1
               GROUP BY c.id"#,
        );
        // Only constant audited SQL fragments are formatted; the UUID stays bound.
        let row = sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind(collection_id)
            .fetch_optional(&mut *transaction)
            .await?
            .ok_or_else(not_found)?;
        let in_flight = row.get::<Option<i64>, _>("in_flight").ok_or_else(|| {
            ApiError::conflict(
                "legacy_notification_schema_unavailable",
                "The original notification runtime schema is not supported for migration.",
            )
        })?;
        let unresolved = row.get::<Option<i64>, _>("unresolved").ok_or_else(|| {
            ApiError::conflict(
                "legacy_notification_schema_unavailable",
                "The original notification runtime schema is not supported for migration.",
            )
        })?;
        let mut hash = Sha256::new();
        notification_watermark_frame(&mut hash, "mdbase-legacy-notifications-watermark/v1");
        notification_watermark_frame(&mut hash, &collection_id.to_string());
        notification_watermark_frame(&mut hash, "schema:2");
        let mut rows = sqlx::query(NOTIFICATION_WATERMARK_ROWS_SQL)
            .bind(collection_id)
            .fetch(&mut *transaction);
        while let Some(metadata) = rows.try_next().await? {
            notification_watermark_frame(&mut hash, &metadata.get::<String, _>("metadata"));
        }
        drop(rows);
        let events: String = sqlx::query_scalar(
            r#"
            SELECT jsonb_build_array('events', COALESCE(max(cursor), 0)::text, count(*)::text)::text
            FROM mdbase_runtime_events
            WHERE namespace = 'connect-hosted:' || ($1::uuid)::text || ':notifications'
        "#,
        )
        .bind(collection_id)
        .fetch_one(&mut *transaction)
        .await?;
        notification_watermark_frame(&mut hash, &events);
        transaction.commit().await?;
        Ok(LegacyMigrationDrain {
            notification_watermark: format!(
                "\"mdbase-legacy-notifications-v1:{:x}\"",
                hash.finalize()
            ),
            collection_id,
            state: row.get("state"),
            migration_id: row.get("legacy_migration_id"),
            head: row.get("head"),
            started_at: row.get("legacy_migration_started_at"),
            retain_until: row.get("legacy_retain_until"),
            in_flight,
            unresolved,
            applied_unreceipted: row.get("applied"),
        })
    }
}
