use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::{postgres::PgPoolOptions, PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::{
    error::{ApiError, ApiResult},
    provider::hosted_migrator,
};

const MINIMUM_HOLD_SECONDS: u64 = 60;
const MAXIMUM_HOLD_SECONDS: u64 = 6 * 60 * 60;
const BACKUP_DELETION_LOCK: i64 = 0x4d44_4241_5345_424b;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct BackupHold {
    pub hold_id: Uuid,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct BackupHoldInventory {
    pub observed_at: DateTime<Utc>,
    pub active_holds: u64,
    pub earliest_expiry: Option<DateTime<Utc>>,
    pub latest_expiry: Option<DateTime<Utc>>,
}

#[derive(sqlx::FromRow)]
struct BackupHoldInventoryRow {
    observed_at: DateTime<Utc>,
    active_holds: i64,
    earliest_expiry: Option<DateTime<Utc>>,
    latest_expiry: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct BackupHoldRelease {
    pub released: bool,
}

pub struct HostedBackupAdmin {
    pool: PgPool,
}

impl HostedBackupAdmin {
    pub async fn connect(database_url: &str) -> ApiResult<Self> {
        let pool = PgPoolOptions::new()
            .max_connections(2)
            .acquire_timeout(std::time::Duration::from_secs(5))
            .idle_timeout(std::time::Duration::from_secs(10 * 60))
            .max_lifetime(std::time::Duration::from_secs(30 * 60))
            .after_connect(|connection, _metadata| {
                Box::pin(async move {
                    sqlx::query("SET statement_timeout = 300000")
                        .execute(&mut *connection)
                        .await?;
                    sqlx::query("SET lock_timeout = 30000")
                        .execute(&mut *connection)
                        .await?;
                    sqlx::query("SET idle_in_transaction_session_timeout = 30000")
                        .execute(&mut *connection)
                        .await?;
                    Ok(())
                })
            })
            .connect(database_url)
            .await?;
        hosted_migrator().run(&pool).await.map_err(|error| {
            tracing::error!(%error, "hosted backup administration migration check failed");
            ApiError::internal("The hosted provider database migration check failed.")
        })?;
        Ok(Self { pool })
    }

    pub async fn acquire(&self, ttl_seconds: u64) -> ApiResult<BackupHold> {
        validate_ttl(ttl_seconds)?;
        let mut transaction = self.pool.begin().await?;
        lock_exclusive(&mut transaction).await?;
        remove_expired(&mut transaction).await?;
        let hold_id = Uuid::now_v7();
        let (created_at, expires_at): (DateTime<Utc>, DateTime<Utc>) = sqlx::query_as(
            r#"INSERT INTO hosted_provider_backup_holds (id, expires_at)
               VALUES ($1, now() + ($2 * interval '1 second'))
               RETURNING created_at, expires_at"#,
        )
        .bind(hold_id)
        .bind(i64::try_from(ttl_seconds).map_err(|_| invalid_ttl())?)
        .fetch_one(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(BackupHold {
            hold_id,
            created_at,
            expires_at,
        })
    }

    pub async fn release(&self, hold_id: Uuid) -> ApiResult<BackupHoldRelease> {
        let mut transaction = self.pool.begin().await?;
        lock_exclusive(&mut transaction).await?;
        remove_expired(&mut transaction).await?;
        let released = sqlx::query("DELETE FROM hosted_provider_backup_holds WHERE id = $1")
            .bind(hold_id)
            .execute(&mut *transaction)
            .await?
            .rows_affected()
            == 1;
        transaction.commit().await?;
        Ok(BackupHoldRelease { released })
    }

    pub async fn inspect(&self) -> ApiResult<BackupHoldInventory> {
        let mut transaction = self.pool.begin().await?;
        lock_exclusive(&mut transaction).await?;
        remove_expired(&mut transaction).await?;
        let row: BackupHoldInventoryRow = sqlx::query_as(
            r#"SELECT now() AS observed_at,
                      count(*) AS active_holds,
                      min(expires_at) AS earliest_expiry,
                      max(expires_at) AS latest_expiry
               FROM hosted_provider_backup_holds
               WHERE expires_at > now()"#,
        )
        .fetch_one(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(BackupHoldInventory {
            observed_at: row.observed_at,
            active_holds: u64::try_from(row.active_holds)
                .map_err(|_| ApiError::internal("The active backup hold count is invalid."))?,
            earliest_expiry: row.earliest_expiry,
            latest_expiry: row.latest_expiry,
        })
    }
}

pub(crate) async fn lock_blob_deletion(
    transaction: &mut Transaction<'_, Postgres>,
) -> ApiResult<bool> {
    sqlx::query("SELECT pg_advisory_xact_lock_shared($1)")
        .bind(BACKUP_DELETION_LOCK)
        .execute(&mut **transaction)
        .await?;
    let active: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM hosted_provider_backup_holds WHERE expires_at > now())",
    )
    .fetch_one(&mut **transaction)
    .await?;
    Ok(active)
}

async fn lock_exclusive(transaction: &mut Transaction<'_, Postgres>) -> ApiResult<()> {
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(BACKUP_DELETION_LOCK)
        .execute(&mut **transaction)
        .await?;
    Ok(())
}

async fn remove_expired(transaction: &mut Transaction<'_, Postgres>) -> ApiResult<()> {
    sqlx::query("DELETE FROM hosted_provider_backup_holds WHERE expires_at <= now()")
        .execute(&mut **transaction)
        .await?;
    Ok(())
}

fn validate_ttl(ttl_seconds: u64) -> ApiResult<()> {
    if !(MINIMUM_HOLD_SECONDS..=MAXIMUM_HOLD_SECONDS).contains(&ttl_seconds) {
        return Err(invalid_ttl());
    }
    Ok(())
}

fn invalid_ttl() -> ApiError {
    ApiError::bad_request(
        "invalid_backup_hold_ttl",
        "The backup hold TTL must be between 60 and 21600 seconds.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backup_hold_ttl_is_strictly_bounded() {
        assert_eq!(
            validate_ttl(59).unwrap_err().code,
            "invalid_backup_hold_ttl"
        );
        validate_ttl(60).unwrap();
        validate_ttl(21_600).unwrap();
        assert_eq!(
            validate_ttl(21_601).unwrap_err().code,
            "invalid_backup_hold_ttl"
        );
    }
}
