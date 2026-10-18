//! Freezing and retaining a hosted collection while it migrates to mdbase-next
//! (mdbase-next `docs/ship/migration.md` H6-H10 and §6 rollback).
//!
//! - `migrating`: every mutation, upload and read is refused (they all require
//!   `state = 'active'`). Entering it takes the collection row lock, so it waits for
//!   in-flight writers, which hold that lock until they commit.
//! - `migrated`: the same, plus deletion, compaction and blob removal are refused until
//!   `legacy_retain_until`, at least 90 days after cutover (Callum, 2026-10-06).
//! - Rollback restores only replicas whose current revocation belongs to this run.

use super::*;
use chrono::Duration as ChronoDuration;
use serde::Deserialize;
use sqlx::postgres::PgRow;

mod notification_watermark;
mod rollback;
use rollback::{
    check_rollback_owner, existing_rollback_receipt, record_rollback_receipt,
    rollback_binding_conflict,
};
pub use rollback::{LegacyRollbackEnvelope, LegacyRollbackReceipt, LegacyRollbackRequest};

/// Minimum retention of a migrated collection's legacy rows and objects.
const LEGACY_RETENTION_MIN_DAYS: i64 = 90;

// Count blocking rows, not distinct reminders. Expiry cannot settle a dispatch.
// Missing runtime schema fails closed; migration must never initialize it.
//
// A terminal `failed` run is settled only while it holds no lease, has no active
// attempt and every recorded attempt has a durable outcome (`succeeded` or
// `failed`). The runtime records an interrupted or unknown dispatch as
// `indeterminate`, never `failed`, and effect admission requires a running,
// leased run, so such a run can never deliver again. Any other shape blocks.
// `timers/hosted-copy.ts` in the server applies the same run rule.
const NOTIFICATION_BLOCKERS_SQL: &str = r#"
    SELECT CASE WHEN (SELECT version FROM mdbase_runtime_schema WHERE singleton = TRUE) = 2 THEN
      (SELECT count(*) FROM mdbase_runtime_timers t
       WHERE t.namespace = 'connect-hosted:' || ($1::uuid)::text || ':notifications'
         AND (t.status NOT IN ('scheduled','fired','cancelled') OR t.lease_token IS NOT NULL
           OR t.lease_worker IS NOT NULL OR t.lease_expires_at IS NOT NULL))
      + (SELECT count(*) FROM mdbase_runtime_runs r
         WHERE r.namespace = 'connect-hosted:' || ($1::uuid)::text || ':notifications'
           AND (r.status NOT IN ('succeeded','cancelled','failed') OR r.lease_token IS NOT NULL
             OR r.lease_worker IS NOT NULL OR r.lease_expires_at IS NOT NULL
             OR (r.status = 'failed' AND (
               jsonb_typeof(r.record_json->'attempts') IS DISTINCT FROM 'array'
               OR COALESCE(jsonb_typeof(r.record_json->'active_attempt'), 'null') <> 'null'
               OR EXISTS (SELECT 1 FROM jsonb_array_elements(
                   CASE WHEN jsonb_typeof(r.record_json->'attempts') = 'array'
                     THEN r.record_json->'attempts' ELSE '[]'::jsonb END) a
                 WHERE (a->>'status') IS NULL OR (a->>'status') NOT IN ('succeeded','failed'))))))
      + (SELECT count(*) FROM hosted_provider_runtime_outbox o
         WHERE o.collection_id = $1 AND (o.processed_at IS NULL
           OR o.lease_token IS NOT NULL OR o.leased_until IS NOT NULL))
    END
"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LegacyMigrationState {
    Active,
    Migrating,
    Migrated,
}

impl LegacyMigrationState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Migrating => "migrating",
            Self::Migrated => "migrated",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct LegacyMigrationStatus {
    pub collection_id: Uuid,
    pub state: LegacyMigrationState,
    pub migration_id: Option<Uuid>,
    pub started_at: Option<DateTime<Utc>>,
    pub retain_until: Option<DateTime<Utc>>,
    /// Replicas restored by this transition (rollback to active).
    pub restored: Vec<Uuid>,
}

/// The current provider run and the replicas whose unchanged revocation it
/// owns: exactly the set a control-plane `migration-cutover` must name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct MigrationRevokedReplicas {
    collection_id: Uuid,
    migration_id: Uuid,
    revoked: Vec<Uuid>,
}

/// What the migration driver reads to drain a fenced collection (H6) and to fix
/// `S_final`: the lifecycle state, the head and the accepted mutations that could
/// still change it, plus its complete content-free notification watermark,
/// all from one REPEATABLE READ READ ONLY snapshot.
#[derive(Debug, Clone, Serialize)]
pub struct LegacyMigrationDrain {
    /// Authenticated response header DATA, never a permission or receipt.
    #[serde(skip)]
    pub(crate) notification_watermark: String,
    pub collection_id: Uuid,
    /// The raw lifecycle state (`active`, `migrating`, `migrated`, or another).
    pub state: String,
    pub migration_id: Option<Uuid>,
    pub head: i64,
    pub started_at: Option<DateTime<Utc>>,
    pub retain_until: Option<DateTime<Utc>>,
    /// Accepted mutations (`claimed`/`prepared`) whose lease is still live: their
    /// request may still be applying. Draining waits for zero. An expired lease
    /// cannot apply once the collection is fenced: every apply path requires
    /// `state = 'active'` under the collection row lock that the fence takes.
    /// Also includes notification firing/unfinished delivery/lease rows, even
    /// when their lease expired or the runtime labels an UNKNOWN terminal. An
    /// unleased `failed` run whose attempts all have outcomes is settled.
    pub in_flight: i64,
    /// Accepted mutations and notification work not yet resolved, live or not.
    pub unresolved: i64,
    /// Mutations applied (already in `head`) whose receipt is not yet final.
    pub applied_unreceipted: i64,
}

fn requested_state(value: &str) -> ApiResult<LegacyMigrationState> {
    match value {
        "active" => Ok(LegacyMigrationState::Active),
        "migrating" => Ok(LegacyMigrationState::Migrating),
        "migrated" => Ok(LegacyMigrationState::Migrated),
        _ => Err(ApiError::bad_request(
            "legacy_migration_state_invalid",
            "state must be active, migrating or migrated.",
        )),
    }
}

fn migration_state(value: &str) -> ApiResult<LegacyMigrationState> {
    match value {
        "active" => Ok(LegacyMigrationState::Active),
        "migrating" => Ok(LegacyMigrationState::Migrating),
        "migrated" => Ok(LegacyMigrationState::Migrated),
        _ => Err(ApiError::conflict(
            "collection_not_migratable",
            "The hosted collection is in a lifecycle state that cannot migrate.",
        )),
    }
}

fn not_found() -> ApiError {
    ApiError::not_found(
        "hosted_collection_not_found",
        "Hosted collection not found.",
    )
}

enum MigrationRestore<'a> {
    Unreceipted(&'a [Uuid]),
    Receipted(&'a LegacyRollbackRequest, Uuid),
}

impl HostedProvider {
    /// The cutover state of `collection_id` when `token` was ever issued for one
    /// of its replicas (revoked and expired tokens included), so a refused old
    /// client can be told why. Unknown tokens learn nothing.
    pub(crate) async fn cutover_state_for_token(
        &self,
        collection_id: Uuid,
        token: &str,
    ) -> ApiResult<Option<String>> {
        Ok(sqlx::query_scalar(
            r#"SELECT c.state
               FROM hosted_provider_collections c
               JOIN hosted_provider_replicas r ON r.collection_id = c.id
               WHERE c.id = $1 AND r.token_hash = $2
                 AND c.state IN ('migrating', 'migrated')
               LIMIT 1"#,
        )
        .bind(collection_id)
        .bind(token_hash(token))
        .fetch_optional(&self.pool)
        .await?)
    }

    /// Move a collection between `active`, `migrating` and `migrated`.
    ///
    /// Allowed: active → migrating → migrated, and back (rollback). Repeating the
    /// current state is a no-op, except that `migrated` may extend its retention.
    ///
    /// - `migrated` requires `retain_until` at least 90 days ahead (never shortened)
    ///   and a drained collection: no accepted mutation may still hold a live lease.
    /// - Once a collection has been `migrated` (it has `legacy_retain_until`), it was
    ///   cut over: returning to `active` by any path (directly, or through
    ///   `migrating`) requires `reverse_verified`, the runbook's statement that the
    ///   reverse export was verified at R (mdbase-next `docs/ship/migration.md` §6.2).
    ///   Rollback before cutover (`migrating` → `active`, never migrated) is direct.
    /// - `restore_replica_ids`, on a transition to `active`, restores exactly those
    ///   replicas whose unchanged revocation belongs to this run, atomically, so
    ///   a crash can never leave the collection active with its mirrors still
    ///   revoked and no way to restore them.
    pub async fn set_legacy_migration_state(
        &self,
        collection_id: Uuid,
        target: &str,
        retain_until: Option<DateTime<Utc>>,
        reverse_verified: bool,
        restore_replica_ids: &[Uuid],
    ) -> ApiResult<LegacyMigrationStatus> {
        self.transition_legacy_migration_state(
            collection_id,
            target,
            retain_until,
            reverse_verified,
            MigrationRestore::Unreceipted(restore_replica_ids),
        )
        .await
        .map(|(status, _)| status)
    }

    async fn transition_legacy_migration_state(
        &self,
        collection_id: Uuid,
        target: &str,
        retain_until: Option<DateTime<Utc>>,
        reverse_verified: bool,
        restore: MigrationRestore<'_>,
    ) -> ApiResult<(LegacyMigrationStatus, Option<LegacyRollbackReceipt>)> {
        use LegacyMigrationState::{Active, Migrated, Migrating};
        let (restore_replica_ids, rollback) = match restore {
            MigrationRestore::Unreceipted(ids) => (ids, None),
            MigrationRestore::Receipted(input, owner) => {
                (input.replica_ids.as_slice(), Some((input, owner)))
            }
        };
        let target = requested_state(target)?;
        check_replica_ids(restore_replica_ids)?;
        let mut transaction = self.pool.begin().await?;
        let row = lock_migration_collection(&mut transaction, collection_id).await?;
        let current = migration_state(&row.get::<String, _>("state"))?;
        let migration_id: Option<Uuid> = row.get("legacy_migration_id");
        let started_at: Option<DateTime<Utc>> = row.get("legacy_migration_started_at");
        let retained: Option<DateTime<Utc>> = row.get("legacy_retain_until");
        if let Some((input, owner)) = rollback {
            check_rollback_owner(&row, input, owner)?;
            if let Some(receipt) =
                existing_rollback_receipt(&mut transaction, collection_id, &row, input, owner)
                    .await?
            {
                transaction.commit().await?;
                return Ok((
                    LegacyMigrationStatus {
                        collection_id,
                        state: current,
                        migration_id,
                        started_at,
                        retain_until: retained,
                        restored: receipt.restored_ids.clone(),
                    },
                    Some(receipt),
                ));
            }
            if current != Migrating
                || migration_id != Some(input.provider_migration_id)
                || started_at.is_none()
                || retained.is_some()
                || row.get::<i64, _>("head") != input.fixed_head
            {
                return Err(rollback_binding_conflict());
            }
            let foreign: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM hosted_provider_replicas WHERE id = ANY($1) AND collection_id <> $2",
            ).bind(&input.replica_ids).bind(collection_id)
                .fetch_one(&mut *transaction).await?;
            if foreign != 0 {
                return Err(rollback_binding_conflict());
            }
        }
        let allowed = current == target
            || matches!(
                (current, target),
                (Active, Migrating)
                    | (Migrating, Active)
                    | (Migrating, Migrated)
                    | (Migrated, Migrating)
                    | (Migrated, Active)
            );
        if !allowed {
            return Err(ApiError::conflict(
                "legacy_migration_transition_invalid",
                format!(
                    "A hosted collection cannot move from {} to {}.",
                    current.as_str(),
                    target.as_str()
                ),
            ));
        }
        let cut_over = current == Migrated || retained.is_some();
        if target == Active && current != Active && cut_over && !reverse_verified {
            return Err(ApiError::conflict(
                "legacy_rollback_unverified",
                "Rolling back a collection that was cut over needs the reverse export verified at R first (reverse_verified).",
            ));
        }
        if !restore_replica_ids.is_empty() && (target != Active || current == Active) {
            return Err(ApiError::bad_request(
                "legacy_restore_requires_rollback",
                "Replicas are restored only by the rollback to active.",
            ));
        }
        if (current, target) == (Active, Migrating)
            || (current, target) == (Migrating, Migrated)
            || rollback.is_some()
        {
            let pending: Option<i64> = sqlx::query_scalar(NOTIFICATION_BLOCKERS_SQL)
                .bind(collection_id)
                .fetch_one(&mut *transaction)
                .await?;
            let pending = pending.ok_or_else(|| {
                ApiError::conflict(
                    "legacy_notification_schema_unavailable",
                    "The original notification runtime schema is not supported for migration.",
                )
            })?;
            if pending != 0 {
                // No state/run/retention/revocation update has happened: this
                // collection remains active so legacy can genuinely finish.
                return Err(ApiError::conflict(
                    "legacy_notifications_not_drained",
                    "Notification delivery is unsettled; retry migration after legacy completion.",
                ));
            }
        }
        if (current, target) == (Migrating, Migrated) || rollback.is_some() {
            let in_flight: i64 = sqlx::query_scalar(
                r#"SELECT count(*) FROM hosted_provider_mutation_journal j
                   JOIN hosted_provider_replicas r ON r.id = j.replica_id
                   WHERE r.collection_id = $1 AND j.state IN ('claimed', 'prepared')
                     AND j.lease_expires_at > now()"#,
            )
            .bind(collection_id)
            .fetch_one(&mut *transaction)
            .await?;
            if in_flight > 0 {
                return Err(ApiError::conflict(
                    "legacy_migration_not_drained",
                    "Accepted writes are still in flight; drain before cutover.",
                ));
            }
        }
        let retain_until = match target {
            Migrated => {
                let requested = retain_until.ok_or_else(|| {
                    ApiError::bad_request(
                        "legacy_retention_required",
                        "A migrated collection needs retain_until.",
                    )
                })?;
                if requested < Utc::now() + ChronoDuration::days(LEGACY_RETENTION_MIN_DAYS) {
                    return Err(ApiError::bad_request(
                        "legacy_retention_too_short",
                        "Legacy collections are retained for at least 90 days after cutover.",
                    ));
                }
                Some(retained.map_or(requested, |existing| existing.max(requested)))
            }
            Migrating => retained,
            Active => None,
        };
        let restored = if target == Active && current != Active && !restore_replica_ids.is_empty() {
            match migration_id {
                Some(run) => {
                    restore_owned_revocations(
                        &mut transaction,
                        collection_id,
                        restore_replica_ids,
                        run,
                    )
                    .await?
                }
                None => Vec::new(),
            }
        } else {
            Vec::new()
        };
        // Every new provider run invalidates old replay eligibility in the same
        // transaction; rolling a later run back to active cannot revive it.
        if (current, target) == (Active, Migrating) {
            sqlx::query("UPDATE hosted_provider_legacy_rollback_receipts SET superseded_at = clock_timestamp() WHERE collection_id = $1 AND superseded_at IS NULL")
                .bind(collection_id).execute(&mut *transaction).await?;
        }
        let receipt = match rollback {
            Some((input, owner)) => Some(
                record_rollback_receipt(&mut transaction, collection_id, input, &restored, owner)
                    .await?,
            ),
            None => None,
        };
        let migration_id = match target {
            Active => None,
            _ if current == Active => Some(Uuid::now_v7()),
            _ => migration_id,
        };
        let started_at = match target {
            Active => None,
            _ if current == Active => Some(Utc::now()),
            _ => started_at,
        };
        let persisted = sqlx::query(
            r#"UPDATE hosted_provider_collections
               SET state = $2, legacy_migration_started_at = $3, legacy_retain_until = $4, legacy_migration_id = $5
               WHERE id = $1
               RETURNING legacy_migration_started_at, legacy_retain_until"#,
        )
        .bind(collection_id)
        .bind(target.as_str())
        .bind(started_at)
        .bind(retain_until)
        .bind(migration_id)
        .fetch_one(&mut *transaction)
        .await?;
        // PostgreSQL persists microseconds; returning the nanosecond input clock
        // would give fence and drain different serialized identities for one run.
        let started_at = persisted.get("legacy_migration_started_at");
        let retain_until = persisted.get("legacy_retain_until");
        transaction.commit().await?;
        Ok((
            LegacyMigrationStatus {
                collection_id,
                state: target,
                migration_id,
                started_at,
                retain_until,
                restored,
            },
            receipt,
        ))
    }

    /// H8: revoke only currently live replicas and record this provider run as
    /// the owner of the revocation in the same transaction. A retry does not
    /// adopt a revocation made by a user or another provider path.
    pub async fn revoke_migration_replicas(
        &self,
        collection_id: Uuid,
        replica_ids: &[Uuid],
    ) -> ApiResult<Vec<Uuid>> {
        check_replica_ids(replica_ids)?;
        let mut transaction = self.pool.begin().await?;
        sqlx::query("SET LOCAL lock_timeout = '5s'")
            .execute(&mut *transaction)
            .await?;
        let row = sqlx::query("SELECT state, legacy_migration_id FROM hosted_provider_collections WHERE id = $1 FOR UPDATE")
            .bind(collection_id).fetch_optional(&mut *transaction).await?.ok_or_else(not_found)?;
        if row.get::<String, _>("state") != "migrating" {
            return Err(ApiError::conflict(
                "legacy_migration_not_started",
                "Migration replica revocation requires a fenced collection.",
            ));
        }
        let run = row
            .get::<Option<Uuid>, _>("legacy_migration_id")
            .ok_or_else(|| {
                ApiError::conflict(
                    "legacy_migration_not_started",
                    "The migration has no provider run identity.",
                )
            })?;
        let live: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM hosted_provider_replicas WHERE collection_id = $1 AND id = ANY($2) AND revoked_at IS NULL ORDER BY id FOR UPDATE")
            .bind(collection_id).bind(replica_ids).fetch_all(&mut *transaction).await?;
        for id in &live {
            crate::provider::replicas::archive_application_replay_credential(&mut transaction, *id)
                .await?;
        }
        sqlx::query("UPDATE hosted_provider_replicas SET revoked_at = now(), revoked_by_migration = $3, migration_revoked_at = now() WHERE collection_id = $1 AND id = ANY($2) AND revoked_at IS NULL")
            .bind(collection_id).bind(&live).bind(run).execute(&mut *transaction).await?;
        let owned = sqlx::query_scalar("SELECT id FROM hosted_provider_replicas WHERE collection_id = $1 AND id = ANY($2) AND revoked_by_migration = $3 AND revoked_at = migration_revoked_at ORDER BY id")
            .bind(collection_id).bind(replica_ids).bind(run).fetch_all(&mut *transaction).await?;
        transaction.commit().await?;
        Ok(owned)
    }

    /// Read-only: the revocations the CURRENT run owns, under a share lock on
    /// the collection row so no revoke, restore or run change interleaves.
    /// Independent and pre-existing revocations are never included.
    pub(crate) async fn migration_revoked_replicas(
        &self,
        collection_id: Uuid,
    ) -> ApiResult<MigrationRevokedReplicas> {
        let mut transaction = self.pool.begin().await?;
        sqlx::query("SET LOCAL lock_timeout = '5s'")
            .execute(&mut *transaction)
            .await?;
        let row = sqlx::query("SELECT state, legacy_migration_id FROM hosted_provider_collections WHERE id = $1 FOR SHARE")
            .bind(collection_id).fetch_optional(&mut *transaction).await?.ok_or_else(not_found)?;
        let run = match (
            row.get::<String, _>("state").as_str(),
            row.get::<Option<Uuid>, _>("legacy_migration_id"),
        ) {
            ("migrating", Some(run)) => run,
            _ => {
                return Err(ApiError::conflict(
                    "legacy_migration_not_started",
                    "Migration revocations are read only for a fenced, uncut collection.",
                ))
            }
        };
        let revoked = sqlx::query_scalar("SELECT id FROM hosted_provider_replicas WHERE collection_id = $1 AND revoked_by_migration = $2 AND revoked_at IS NOT NULL AND revoked_at = migration_revoked_at ORDER BY id")
            .bind(collection_id).bind(run).fetch_all(&mut *transaction).await?;
        transaction.commit().await?;
        Ok(MigrationRevokedReplicas {
            collection_id,
            migration_id: run,
            revoked,
        })
    }

    /// Rollback: restore only listed replicas whose current revocation is owned
    /// by this run. Independent and pre-existing revocations stay revoked.
    pub async fn restore_migration_revoked_replicas(
        &self,
        collection_id: Uuid,
        replica_ids: &[Uuid],
    ) -> ApiResult<Vec<Uuid>> {
        check_replica_ids(replica_ids)?;
        let mut transaction = self.pool.begin().await?;
        let row = sqlx::query(
            r#"SELECT state, legacy_migration_id, legacy_migration_started_at
               FROM hosted_provider_collections WHERE id = $1 FOR UPDATE"#,
        )
        .bind(collection_id)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or_else(not_found)?;
        let started_at: Option<DateTime<Utc>> = row.get("legacy_migration_started_at");
        match (migration_state(&row.get::<String, _>("state"))?, started_at) {
            (LegacyMigrationState::Active, _) | (_, None) => {
                return Err(ApiError::conflict(
                    "legacy_migration_not_started",
                    "Replicas are restored only while a migration can be rolled back.",
                ))
            }
            (_, Some(_)) => (),
        };
        let restored = match row.get::<Option<Uuid>, _>("legacy_migration_id") {
            Some(run) => {
                restore_owned_revocations(&mut transaction, collection_id, replica_ids, run).await?
            }
            None => Vec::new(),
        };
        transaction.commit().await?;
        Ok(restored)
    }
}

async fn lock_migration_collection(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
) -> ApiResult<PgRow> {
    sqlx::query("SET LOCAL lock_timeout = '5s'")
        .execute(&mut **transaction)
        .await?;
    sqlx::query(
        r#"SELECT state, account_id, authority_epoch, head, legacy_migration_id,
                  legacy_migration_started_at, legacy_retain_until
           FROM hosted_provider_collections WHERE id = $1 FOR UPDATE"#,
    )
    .bind(collection_id)
    .fetch_optional(&mut **transaction)
    .await?
    .ok_or_else(not_found)
}

/// Serialize independent revocations with migration revoke/restore using the
/// same collection-first lock order. Revocation remains allowed while fenced.
pub(in crate::provider) async fn lock_replica_for_revocation(
    transaction: &mut Transaction<'_, Postgres>,
    replica_id: Uuid,
) -> ApiResult<()> {
    let _: Option<Uuid> = sqlx::query_scalar(
        "SELECT c.id FROM hosted_provider_collections c JOIN hosted_provider_replicas r ON r.collection_id = c.id WHERE r.id = $1 FOR UPDATE OF c",
    ).bind(replica_id).fetch_optional(&mut **transaction).await?;
    Ok(())
}

fn check_replica_ids(ids: &[Uuid]) -> ApiResult<()> {
    if ids.len() > 1000 {
        return Err(ApiError::bad_request(
            "legacy_replica_limit",
            "At most 1000 replica IDs are accepted per migration request.",
        ));
    }
    Ok(())
}

/// Clear only an unchanged, migration-owned revocation from the current run.
async fn restore_owned_revocations(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
    replica_ids: &[Uuid],
    run: Uuid,
) -> ApiResult<Vec<Uuid>> {
    Ok(sqlx::query_scalar(
        r#"UPDATE hosted_provider_replicas
           SET revoked_at = NULL, revoked_by_migration = NULL, migration_revoked_at = NULL
           WHERE collection_id = $1 AND id = ANY($2)
             AND revoked_at IS NOT NULL AND revoked_by_migration = $3
             AND revoked_at = migration_revoked_at
           RETURNING id"#,
    )
    .bind(collection_id)
    .bind(replica_ids)
    .bind(run)
    .fetch_all(&mut **transaction)
    .await?)
}

/// The fence's answer to a legacy client or control-plane call on a migrating or
/// migrated collection: distinct from `hosted_collection_not_found`, so nothing
/// mistakes the freeze for deletion (and quarantines the collection).
fn collection_migrating() -> ApiError {
    ApiError::conflict(
        "collection_migrating",
        "This collection is being upgraded. Your data is safe, and editing will resume \
         once the upgrade finishes. Try again in a few minutes.",
    )
}

/// Refuse a legacy replica change on a collection in `state` if it is migrating
/// or migrated, with the distinct code.
pub(in crate::provider) fn refuse_migrating(state: &str) -> ApiResult<()> {
    if matches!(state, "migrating" | "migrated") {
        return Err(collection_migrating());
    }
    Ok(())
}

/// [`refuse_migrating`] for the collection of `replica_id`.
pub(in crate::provider) async fn refuse_migrating_replica(
    transaction: &mut Transaction<'_, Postgres>,
    replica_id: Uuid,
) -> ApiResult<()> {
    let state: Option<String> = sqlx::query_scalar(
        r#"SELECT c.state FROM hosted_provider_replicas r
           JOIN hosted_provider_collections c ON c.id = r.collection_id
           WHERE r.id = $1"#,
    )
    .bind(replica_id)
    .fetch_optional(&mut **transaction)
    .await?;
    state.map_or(Ok(()), |s| refuse_migrating(&s))
}

/// Refuse compaction of a collection whose legacy data must be kept: while it
/// migrates, and after cutover until its retention ends. Call inside the
/// compaction transaction; it locks the collection row. Deletion is not refused:
/// a user's deletion (of the collection or the account) is terminal, overrides
/// retention and purges the retained data.
pub(in crate::provider) async fn ensure_legacy_data_disposable(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
) -> ApiResult<()> {
    let Some(row) = sqlx::query(
        r#"SELECT state, legacy_retain_until
           FROM hosted_provider_collections WHERE id = $1 FOR UPDATE"#,
    )
    .bind(collection_id)
    .fetch_optional(&mut **transaction)
    .await?
    else {
        return Ok(());
    };
    let retain_until: Option<DateTime<Utc>> = row.get("legacy_retain_until");
    let retained = match row.get::<String, _>("state").as_str() {
        "migrating" => true,
        "migrated" => retain_until.is_none_or(|until| until > Utc::now()),
        _ => false,
    };
    if retained {
        return Err(ApiError::conflict(
            "legacy_collection_retained",
            "The collection is retained for migration rollback and cannot be compacted yet.",
        ));
    }
    Ok(())
}

/// The log service accepts at most this many owner timezones.
const MAX_OWNER_TIMEZONES: i64 = 1000;

/// The legacy timezones a migrated collection's storage region is chosen from
/// (mdbase-next `crates/log-service/src/timezone.rs`): the collection's own
/// creator-device timezone (`UTC` when unknown) and the owner's timezones across
/// their other hosted collections. Read-only and content-free.
#[derive(Debug, Clone, Serialize)]
pub struct LegacyMigrationPlacement {
    pub collection_id: Uuid,
    pub timezone: String,
    /// Newest first; empty when the collection has no provider account.
    pub owner_timezones: Vec<String>,
}

impl HostedProvider {
    pub async fn legacy_migration_placement(
        &self,
        collection_id: Uuid,
    ) -> ApiResult<LegacyMigrationPlacement> {
        let row = sqlx::query(
            r#"SELECT c.timezone,
                      COALESCE(ARRAY(
                        SELECT o.timezone FROM hosted_provider_collections o
                        WHERE o.account_id = c.account_id AND o.id <> c.id
                        ORDER BY o.created_at DESC, o.id
                        LIMIT $2
                      ), ARRAY[]::text[]) AS owner_timezones
               FROM hosted_provider_collections c
               WHERE c.id = $1"#,
        )
        .bind(collection_id)
        .bind(MAX_OWNER_TIMEZONES)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(not_found)?;
        Ok(LegacyMigrationPlacement {
            collection_id,
            timezone: row.get("timezone"),
            owner_timezones: row.get("owner_timezones"),
        })
    }
}
