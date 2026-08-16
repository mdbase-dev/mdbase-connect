pub(super) async fn cleanup_expired_query_cursors<'e, E>(
    executor: E,
    collection_id: Option<Uuid>,
) -> ApiResult<()>
where
    E: sqlx::Executor<'e, Database = Postgres>,
{
    let cleanup_rows = to_i64(
        HostedExecutionBudgetManifest::published()
            .defaults
            .cursor_cleanup_rows,
        "query cursor cleanup row budget",
    )?;
    sqlx::query(
        r#"WITH expired AS (
             SELECT cursor_id
             FROM hosted_provider_query_cursors
             WHERE ($1::uuid IS NULL OR collection_id = $1)
               AND (expires_at <= now() OR hard_expires_at <= now())
             ORDER BY LEAST(expires_at, hard_expires_at), cursor_id
             LIMIT $2
             FOR UPDATE SKIP LOCKED
           )
           DELETE FROM hosted_provider_query_cursors cursor
           USING expired
           WHERE cursor.cursor_id = expired.cursor_id"#,
    )
    .bind(collection_id)
    .bind(cleanup_rows)
    .execute(executor)
    .await?;
    Ok(())
}

pub(super) async fn cleanup_base_query_invocations<'e, E>(
    executor: E,
    collection_id: Uuid,
    protected_invocation_id: Option<Uuid>,
) -> ApiResult<()>
where
    E: sqlx::Executor<'e, Database = Postgres>,
{
    let cleanup_rows = to_i64(
        HostedExecutionBudgetManifest::published()
            .defaults
            .cursor_cleanup_rows,
        "base invocation cleanup row budget",
    )?;
    sqlx::query(
        r#"WITH expired AS (
             SELECT invocation_id
             FROM hosted_provider_base_query_invocations i
             WHERE i.collection_id = $1
               AND ($2::uuid IS NULL OR i.invocation_id <> $2)
               AND (i.hard_expires_at <= now() OR NOT EXISTS (
                 SELECT 1 FROM hosted_provider_query_cursors c
                 WHERE c.base_invocation_id = i.invocation_id
               ))
             ORDER BY i.hard_expires_at, i.invocation_id
             LIMIT $3
             FOR UPDATE SKIP LOCKED
           )
           DELETE FROM hosted_provider_base_query_invocations invocation
           USING expired
           WHERE invocation.invocation_id = expired.invocation_id"#,
    )
    .bind(collection_id)
    .bind(protected_invocation_id)
    .bind(cleanup_rows)
    .execute(executor)
    .await?;
    Ok(())
}
