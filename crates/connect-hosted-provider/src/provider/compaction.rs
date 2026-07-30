use super::*;

impl HostedProvider {
    pub async fn compact_through(&self, collection_id: Uuid, through: u64) -> ApiResult<()> {
        let mut transaction = self.pool.begin().await?;
        sqlx::query("DELETE FROM hosted_provider_snapshot_leases WHERE expires_at <= now()")
            .execute(&mut *transaction)
            .await?;
        let row = sqlx::query(
            "SELECT head, retained_after FROM hosted_provider_collections WHERE id = $1 FOR UPDATE",
        )
        .bind(collection_id)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or_else(|| {
            ApiError::not_found(
                "hosted_collection_not_found",
                "Hosted collection not found.",
            )
        })?;
        let head = number(row.get::<i64, _>("head"), "collection head")?;
        let retained = number(row.get::<i64, _>("retained_after"), "retained cursor")?;
        if through < retained || through > head {
            return Err(ApiError::bad_request(
                "invalid_cursor",
                "Compaction cursor is outside retained history.",
            ));
        }
        sqlx::query(
            "UPDATE hosted_provider_collections SET retained_after = $2, updated_at = now() WHERE id = $1",
        )
        .bind(collection_id)
        .bind(to_i64(through, "compaction cursor")?)
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            "DELETE FROM hosted_provider_changes WHERE collection_id = $1 AND sequence <= $2",
        )
        .bind(collection_id)
        .bind(to_i64(through, "compaction cursor")?)
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            "DELETE FROM hosted_provider_resource_changes WHERE collection_id = $1 AND sequence <= $2",
        )
        .bind(collection_id)
        .bind(to_i64(through, "compaction cursor")?)
        .execute(&mut *transaction)
        .await?;
        let through_i64 = to_i64(through, "compaction cursor")?;
        let oldest_live_snapshot: Option<i64> = sqlx::query_scalar(
            r#"SELECT min(cursor) FROM hosted_provider_snapshot_leases
               WHERE collection_id = $1 AND expires_at > now()"#,
        )
        .bind(collection_id)
        .fetch_one(&mut *transaction)
        .await?;
        let prune_boundary = oldest_live_snapshot
            .map(|cursor| cursor.min(through_i64))
            .unwrap_or(through_i64);
        sqlx::query(
            r#"DELETE FROM hosted_provider_record_versions version
               WHERE version.collection_id = $1
                 AND version.sequence <= $2
                 AND version.sequence < (
                   SELECT max(anchor.sequence)
                   FROM hosted_provider_record_versions anchor
                   WHERE anchor.collection_id = version.collection_id
                     AND anchor.record_id = version.record_id
                     AND anchor.sequence <= $2
                 )"#,
        )
        .bind(collection_id)
        .bind(prune_boundary)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(())
    }

    /// Bounds the durable change log without relying on a control-plane cron.
    /// Replicas behind the retained cursor deliberately use the ordinary
    /// snapshot-reset path on their next pull.
    pub async fn compact_stale_history(&self, retain_changes: u64) -> ApiResult<usize> {
        let rows = sqlx::query(
            r#"SELECT id, head
               FROM hosted_provider_collections
               WHERE state = 'active' AND head - retained_after > $1
               ORDER BY updated_at"#,
        )
        .bind(to_i64(retain_changes, "history retention")?)
        .fetch_all(&self.pool)
        .await?;
        let mut compacted = 0;
        for row in rows {
            let collection_id: Uuid = row.get("id");
            let head = number(row.get::<i64, _>("head"), "collection head")?;
            self.compact_through(collection_id, head.saturating_sub(retain_changes))
                .await?;
            compacted += 1;
        }
        Ok(compacted)
    }
}
