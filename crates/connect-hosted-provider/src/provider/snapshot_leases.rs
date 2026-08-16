use super::*;

/// Remove only one published-budget batch of expired sync snapshot leases.
///
/// Both session admission and compaction call this inside their existing
/// transaction. Ordered `SKIP LOCKED` selection bounds lock ownership and lets
/// concurrent maintenance make progress without waiting on the same leases.
pub(super) async fn cleanup_expired_snapshot_leases<'e, E>(
    executor: E,
    collection_id: Option<Uuid>,
) -> ApiResult<()>
where
    E: sqlx::Executor<'e, Database = Postgres>,
{
    let cleanup_rows = to_i64(
        crate::HostedExecutionBudgetManifest::published()
            .defaults
            .cursor_cleanup_rows,
        "snapshot lease cleanup row budget",
    )?;
    sqlx::query(
        r#"WITH expired AS (
             SELECT id
             FROM hosted_provider_snapshot_leases
             WHERE ($1::uuid IS NULL OR collection_id = $1)
               AND expires_at <= now()
             ORDER BY expires_at, id
             LIMIT $2
             FOR UPDATE SKIP LOCKED
           )
           DELETE FROM hosted_provider_snapshot_leases lease
           USING expired
           WHERE lease.id = expired.id"#,
    )
    .bind(collection_id)
    .bind(cleanup_rows)
    .execute(executor)
    .await?;
    Ok(())
}
