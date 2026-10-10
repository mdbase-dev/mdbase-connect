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

/// Exact provider-local rollback binding. Driver/action IDs are correlation,
/// never authority; the caller must separately qualify native rollback guards.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LegacyRollbackRequest {
    pub owner_account_id: Uuid,
    pub provider_migration_id: Uuid,
    pub authority_epoch: i64,
    pub fixed_head: i64,
    pub driver_id: Uuid,
    pub action_id: Uuid,
    pub replica_ids: Vec<Uuid>,
}

/// Persisted in the same transaction as restore + active. Historical evidence
/// is not a fresh permission, and active state alone is never a receipt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LegacyRollbackReceipt {
    pub collection_id: Uuid,
    pub binding: LegacyRollbackRequest,
    pub restored_ids: Vec<Uuid>,
    pub recorded_at: DateTime<Utc>,
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

enum MigrationRestore<'a> {
    Unreceipted(&'a [Uuid]),
    Receipted(&'a LegacyRollbackRequest),
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

    /// Provider-local atomic pre-cutover rollback. The CP/native adapter must
    /// authenticate its actual saved RollingBack/pending action and settle any
    /// competing target effects BEFORE dispatch; this receipt proves none of that.
    pub async fn rollback_legacy_migration(
        &self,
        collection_id: Uuid,
        input: &LegacyRollbackRequest,
    ) -> ApiResult<LegacyRollbackReceipt> {
        let input = canonical_rollback_request(input)?;
        let (_, receipt) = self
            .transition_legacy_migration_state(
                collection_id,
                "active",
                None,
                false,
                MigrationRestore::Receipted(&input),
            )
            .await?;
        receipt.ok_or_else(|| ApiError::internal("Atomic rollback did not produce its receipt."))
    }

    /// Read-only lost-response settlement. Missing or superseded receipts refuse;
    /// this NEVER retries a restore or interprets an active source as success.
    pub async fn legacy_migration_rollback_receipt(
        &self,
        collection_id: Uuid,
        input: &LegacyRollbackRequest,
    ) -> ApiResult<LegacyRollbackReceipt> {
        let input = canonical_rollback_request(input)?;
        let mut transaction = self.pool.begin().await?;
        let row = lock_migration_collection(&mut transaction, collection_id).await?;
        check_rollback_owner(&row, &input)?;
        let receipt = existing_rollback_receipt(&mut transaction, collection_id, &row, &input)
            .await?
            .ok_or_else(|| {
                ApiError::not_found(
                    "legacy_rollback_receipt_unknown",
                    "No exact atomic rollback receipt exists.",
                )
            })?;
        transaction.commit().await?;
        Ok(receipt)
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
            MigrationRestore::Receipted(input) => (input.replica_ids.as_slice(), Some(input)),
        };
        let target = requested_state(target)?;
        check_replica_ids(restore_replica_ids)?;
        let mut transaction = self.pool.begin().await?;
        let row = lock_migration_collection(&mut transaction, collection_id).await?;
        let current = migration_state(&row.get::<String, _>("state"))?;
        let migration_id: Option<Uuid> = row.get("legacy_migration_id");
        let started_at: Option<DateTime<Utc>> = row.get("legacy_migration_started_at");
        let retained: Option<DateTime<Utc>> = row.get("legacy_retain_until");
        if let Some(input) = rollback {
            check_rollback_owner(&row, input)?;
            if let Some(receipt) =
                existing_rollback_receipt(&mut transaction, collection_id, &row, input).await?
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
            Some(input) => Some(
                record_rollback_receipt(&mut transaction, collection_id, input, &restored).await?,
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

fn rollback_binding_conflict() -> ApiError {
    ApiError::conflict(
        "legacy_rollback_binding_conflict",
        "The provider source or rollback receipt does not match the exact pending action.",
    )
}

fn canonical_rollback_request(input: &LegacyRollbackRequest) -> ApiResult<LegacyRollbackRequest> {
    check_replica_ids(&input.replica_ids)?;
    let mut input = input.clone();
    input.replica_ids.sort_unstable();
    if input.authority_epoch <= 0
        || input.fixed_head < 0
        || [
            input.owner_account_id,
            input.provider_migration_id,
            input.driver_id,
            input.action_id,
        ]
        .iter()
        .any(Uuid::is_nil)
        || input.replica_ids.iter().any(Uuid::is_nil)
        || input.replica_ids.windows(2).any(|ids| ids[0] == ids[1])
    {
        return Err(ApiError::bad_request(
            "legacy_rollback_binding_invalid",
            "Rollback needs a valid exact source and replica scope.",
        ));
    }
    Ok(input)
}

fn check_rollback_owner(row: &PgRow, input: &LegacyRollbackRequest) -> ApiResult<()> {
    if row.get::<Option<Uuid>, _>("account_id") != Some(input.owner_account_id)
        || row.get::<i64, _>("authority_epoch") != input.authority_epoch
    {
        return Err(rollback_binding_conflict());
    }
    Ok(())
}

async fn existing_rollback_receipt(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
    source: &PgRow,
    input: &LegacyRollbackRequest,
) -> ApiResult<Option<LegacyRollbackReceipt>> {
    let Some(row) = sqlx::query(
        "SELECT * FROM hosted_provider_legacy_rollback_receipts WHERE collection_id = $1 AND provider_migration_id = $2",
    ).bind(collection_id).bind(input.provider_migration_id)
        .fetch_optional(&mut **transaction).await? else { return Ok(None) };
    let binding = LegacyRollbackRequest {
        owner_account_id: row.get("owner_account_id"),
        provider_migration_id: row.get("provider_migration_id"),
        authority_epoch: row.get("authority_epoch"),
        fixed_head: row.get("fixed_head"),
        driver_id: row.get("driver_id"),
        action_id: row.get("action_id"),
        replica_ids: row.get("requested_ids"),
    };
    // Old writes may legitimately have advanced the head after the atomic
    // rollback. They do not invalidate its historical receipt; a NEW migration
    // does, even if that later run has already returned to active.
    if binding != *input
        || row
            .get::<Option<DateTime<Utc>>, _>("superseded_at")
            .is_some()
        || source.get::<String, _>("state") != "active"
        || source
            .get::<Option<Uuid>, _>("legacy_migration_id")
            .is_some()
        || source
            .get::<Option<DateTime<Utc>>, _>("legacy_migration_started_at")
            .is_some()
        || source
            .get::<Option<DateTime<Utc>>, _>("legacy_retain_until")
            .is_some()
        || source.get::<i64, _>("head") < input.fixed_head
    {
        return Err(rollback_binding_conflict());
    }
    Ok(Some(LegacyRollbackReceipt {
        collection_id,
        binding,
        restored_ids: row.get("restored_ids"),
        recorded_at: row.get("recorded_at"),
    }))
}

async fn record_rollback_receipt(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
    input: &LegacyRollbackRequest,
    restored: &[Uuid],
) -> ApiResult<LegacyRollbackReceipt> {
    let mut restored_ids = restored.to_vec();
    restored_ids.sort_unstable();
    let recorded_at = sqlx::query_scalar(
        r#"INSERT INTO hosted_provider_legacy_rollback_receipts
           (collection_id, provider_migration_id, owner_account_id, authority_epoch,
            fixed_head, driver_id, action_id, requested_ids, restored_ids)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT DO NOTHING RETURNING recorded_at"#,
    )
    .bind(collection_id)
    .bind(input.provider_migration_id)
    .bind(input.owner_account_id)
    .bind(input.authority_epoch)
    .bind(input.fixed_head)
    .bind(input.driver_id)
    .bind(input.action_id)
    .bind(&input.replica_ids)
    .bind(&restored_ids)
    .fetch_optional(&mut **transaction)
    .await?
    .ok_or_else(rollback_binding_conflict)?;
    Ok(LegacyRollbackReceipt {
        collection_id,
        binding: input.clone(),
        restored_ids,
        recorded_at,
    })
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

#[cfg(test)]
mod rollback_binding_tests {
    use super::*;

    fn input() -> LegacyRollbackRequest {
        LegacyRollbackRequest {
            owner_account_id: Uuid::new_v4(),
            provider_migration_id: Uuid::new_v4(),
            authority_epoch: 1,
            fixed_head: 0,
            driver_id: Uuid::new_v4(),
            action_id: Uuid::new_v4(),
            replica_ids: vec![Uuid::new_v4(), Uuid::new_v4()],
        }
    }

    #[test]
    fn canonical_scope_is_a_bounded_distinct_nonzero_set() {
        let original = input();
        let mut reversed = original.clone();
        reversed.replica_ids.reverse();
        assert_eq!(
            canonical_rollback_request(&original).unwrap(),
            canonical_rollback_request(&reversed).unwrap()
        );
        let mut duplicate = original.clone();
        duplicate.replica_ids.push(duplicate.replica_ids[0]);
        assert_eq!(
            canonical_rollback_request(&duplicate).unwrap_err().code,
            "legacy_rollback_binding_invalid"
        );
        let mut oversized = original.clone();
        oversized.replica_ids = (0..1001).map(|_| Uuid::new_v4()).collect();
        assert_eq!(
            canonical_rollback_request(&oversized).unwrap_err().code,
            "legacy_replica_limit"
        );
        let mut empty = original;
        empty.replica_ids.clear();
        assert!(canonical_rollback_request(&empty).is_ok());
    }

    #[test]
    fn invalid_counters_and_nil_identities_are_not_bindings() {
        for field in [
            "owner", "provider", "driver", "action", "replica", "epoch", "head",
        ] {
            let mut wrong = input();
            match field {
                "owner" => wrong.owner_account_id = Uuid::nil(),
                "provider" => wrong.provider_migration_id = Uuid::nil(),
                "driver" => wrong.driver_id = Uuid::nil(),
                "action" => wrong.action_id = Uuid::nil(),
                "replica" => wrong.replica_ids[0] = Uuid::nil(),
                "epoch" => wrong.authority_epoch = 0,
                "head" => wrong.fixed_head = -1,
                _ => unreachable!(),
            }
            assert_eq!(
                canonical_rollback_request(&wrong).unwrap_err().code,
                "legacy_rollback_binding_invalid",
                "{field}"
            );
        }
    }

    #[test]
    fn flags_do_not_create_rollback_authority() {
        for field in ["reverse_verified", "verified", "ready", "pre_cutover"] {
            let mut value = serde_json::to_value(input()).unwrap();
            value[field] = serde_json::json!(true);
            assert!(
                serde_json::from_value::<LegacyRollbackRequest>(value).is_err(),
                "{field}"
            );
        }
    }
}
