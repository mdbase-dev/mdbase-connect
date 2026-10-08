//! Freezing and retaining a hosted collection while it migrates to mdbase-next
//! (mdbase-next `docs/ship/migration.md` H6-H10 and §6 rollback).
//!
//! - `migrating`: every mutation, upload and read is refused (they all require
//!   `state = 'active'`). Entering it takes the collection row lock, so it waits for
//!   in-flight writers, which hold that lock until they commit.
//! - `migrated`: the same, plus deletion, compaction and blob removal are refused until
//!   `legacy_retain_until`, at least 90 days after cutover (Callum, 2026-10-06).
//! - Rollback restores exactly the replicas revoked since the migration started.

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
    pub started_at: Option<DateTime<Utc>>,
    pub retain_until: Option<DateTime<Utc>>,
}

/// What the migration driver reads to drain a fenced collection (H6) and to fix
/// `S_final`: the lifecycle state, the head and the accepted mutations that could
/// still change it, all from one statement (one snapshot).
#[derive(Debug, Clone, Serialize)]
pub struct LegacyMigrationDrain {
    pub collection_id: Uuid,
    /// The raw lifecycle state (`active`, `migrating`, `migrated`, or another).
    pub state: String,
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
    /// `migrated` requires `retain_until` at least 90 days ahead, and retention is
    /// never shortened.
    ///
    /// Rollback before cutover (`migrating` → `active`) is direct. After cutover
    /// (`migrated` → `active`) the runbook must first reverse-export and verify the
    /// collection at R (mdbase-next `docs/ship/migration.md` §6.2) and say so with
    /// `reverse_verified`; the provider cannot check that itself, so it refuses the
    /// transition without the explicit statement.
    pub async fn set_legacy_migration_state(
        &self,
        collection_id: Uuid,
        target: &str,
        retain_until: Option<DateTime<Utc>>,
        reverse_verified: bool,
    ) -> ApiResult<LegacyMigrationStatus> {
        use LegacyMigrationState::{Active, Migrated, Migrating};
        let target = requested_state(target)?;
        let mut transaction = self.pool.begin().await?;
        let row = sqlx::query(
            r#"SELECT state, legacy_migration_started_at, legacy_retain_until
               FROM hosted_provider_collections WHERE id = $1 FOR UPDATE"#,
        )
        .bind(collection_id)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or_else(not_found)?;
        let current = migration_state(&row.get::<String, _>("state"))?;
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
        if (current, target) == (Migrated, Active) && !reverse_verified {
            return Err(ApiError::conflict(
                "legacy_rollback_unverified",
                "Rolling back a migrated collection needs the reverse export verified at R first (reverse_verified).",
            ));
        }
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
        let started_at = match target {
            Active => None,
            _ if current == Active => Some(Utc::now()),
            _ => started_at,
        };
        sqlx::query(
            r#"UPDATE hosted_provider_collections
               SET state = $2, legacy_migration_started_at = $3, legacy_retain_until = $4
               WHERE id = $1"#,
        )
        .bind(collection_id)
        .bind(target.as_str())
        .bind(started_at)
        .bind(retain_until)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(LegacyMigrationStatus {
            collection_id,
            state: target,
            started_at,
            retain_until,
        })
    }

    /// The drain status of one collection (H6).
    pub async fn legacy_migration_drain(
        &self,
        collection_id: Uuid,
    ) -> ApiResult<LegacyMigrationDrain> {
        let row = sqlx::query(
            r#"SELECT c.state, c.head, c.legacy_migration_started_at, c.legacy_retain_until,
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
            head: row.get("head"),
            started_at: row.get("legacy_migration_started_at"),
            retain_until: row.get("legacy_retain_until"),
            in_flight: row.get("in_flight"),
            unresolved: row.get("unresolved"),
            applied_unreceipted: row.get("applied"),
        })
    }

    /// Rollback: clear `revoked_at` for exactly the listed replicas of a migrating or
    /// migrated collection, and only those revoked since the migration started. A
    /// replica the user revoked before the migration stays revoked. Returns the
    /// restored IDs.
    pub async fn restore_migration_revoked_replicas(
        &self,
        collection_id: Uuid,
        replica_ids: &[Uuid],
    ) -> ApiResult<Vec<Uuid>> {
        let mut transaction = self.pool.begin().await?;
        let row = sqlx::query(
            r#"SELECT state, legacy_migration_started_at
               FROM hosted_provider_collections WHERE id = $1 FOR UPDATE"#,
        )
        .bind(collection_id)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or_else(not_found)?;
        let started_at: Option<DateTime<Utc>> = row.get("legacy_migration_started_at");
        let started_at = match (migration_state(&row.get::<String, _>("state"))?, started_at) {
            (LegacyMigrationState::Active, _) | (_, None) => {
                return Err(ApiError::conflict(
                    "legacy_migration_not_started",
                    "Replicas are restored only while a migration can be rolled back.",
                ))
            }
            (_, Some(started_at)) => started_at,
        };
        let restored: Vec<Uuid> = sqlx::query_scalar(
            r#"UPDATE hosted_provider_replicas SET revoked_at = NULL
               WHERE collection_id = $1 AND id = ANY($2)
                 AND revoked_at IS NOT NULL AND revoked_at >= $3
               RETURNING id"#,
        )
        .bind(collection_id)
        .bind(replica_ids)
        .bind(started_at)
        .fetch_all(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(restored)
    }
}

/// Refuse deletion and compaction of a collection whose legacy data must be kept:
/// while it migrates, and after cutover until its retention ends. Call inside the
/// transaction that deletes or compacts; it locks the collection row.
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
            "The collection is retained for migration rollback and cannot be deleted or compacted yet.",
        ));
    }
    Ok(())
}
