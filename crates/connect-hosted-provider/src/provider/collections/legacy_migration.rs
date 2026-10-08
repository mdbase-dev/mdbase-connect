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

/// Minimum retention of a migrated collection's legacy rows and objects.
const LEGACY_RETENTION_MIN_DAYS: i64 = 90;

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

/// What the migration driver reads to drain a fenced collection (H6) and to fix
/// `S_final`: the lifecycle state, the head and the accepted mutations that could
/// still change it, all from one statement (one snapshot).
#[derive(Debug, Clone, Serialize)]
pub struct LegacyMigrationDrain {
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
    pub in_flight: i64,
    /// Accepted mutations not yet resolved, live or not.
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

impl HostedProvider {
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
        use LegacyMigrationState::{Active, Migrated, Migrating};
        let target = requested_state(target)?;
        check_replica_ids(restore_replica_ids)?;
        let mut transaction = self.pool.begin().await?;
        sqlx::query("SET LOCAL lock_timeout = '5s'")
            .execute(&mut *transaction)
            .await?;
        let row = sqlx::query(
            r#"SELECT state, legacy_migration_id, legacy_migration_started_at, legacy_retain_until
               FROM hosted_provider_collections WHERE id = $1 FOR UPDATE"#,
        )
        .bind(collection_id)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or_else(not_found)?;
        let current = migration_state(&row.get::<String, _>("state"))?;
        let migration_id: Option<Uuid> = row.get("legacy_migration_id");
        let started_at: Option<DateTime<Utc>> = row.get("legacy_migration_started_at");
        let retained: Option<DateTime<Utc>> = row.get("legacy_retain_until");
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
        if (current, target) == (Migrating, Migrated) {
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
        sqlx::query(
            r#"UPDATE hosted_provider_collections
               SET state = $2, legacy_migration_started_at = $3, legacy_retain_until = $4, legacy_migration_id = $5
               WHERE id = $1"#,
        )
        .bind(collection_id)
        .bind(target.as_str())
        .bind(started_at)
        .bind(retain_until)
        .bind(migration_id)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(LegacyMigrationStatus {
            collection_id,
            state: target,
            migration_id,
            started_at,
            retain_until,
            restored,
        })
    }

    /// The drain status of one collection (H6).
    pub async fn legacy_migration_drain(
        &self,
        collection_id: Uuid,
    ) -> ApiResult<LegacyMigrationDrain> {
        let row = sqlx::query(
            r#"SELECT c.state, c.head, c.legacy_migration_id, c.legacy_migration_started_at, c.legacy_retain_until,
                      count(j.request_id) FILTER (
                        WHERE j.state IN ('claimed', 'prepared') AND j.lease_expires_at > now()
                      ) AS in_flight,
                      count(j.request_id) FILTER (
                        WHERE j.state IN ('claimed', 'prepared')
                      ) AS unresolved,
                      count(j.request_id) FILTER (WHERE j.state = 'applied') AS applied
               FROM hosted_provider_collections c
               LEFT JOIN hosted_provider_replicas r ON r.collection_id = c.id
               LEFT JOIN hosted_provider_mutation_journal j ON j.replica_id = r.id
               WHERE c.id = $1
               GROUP BY c.id"#,
        )
        .bind(collection_id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(not_found)?;
        Ok(LegacyMigrationDrain {
            collection_id,
            state: row.get("state"),
            migration_id: row.get("legacy_migration_id"),
            head: row.get("head"),
            started_at: row.get("legacy_migration_started_at"),
            retain_until: row.get("legacy_retain_until"),
            in_flight: row.get("in_flight"),
            unresolved: row.get("unresolved"),
            applied_unreceipted: row.get("applied"),
        })
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
        "The hosted collection is moving to mdbase-next; update the client.",
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
