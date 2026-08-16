use super::projections::prune_unpinned_projection_generations_in;
use super::snapshot_leases::cleanup_expired_snapshot_leases;
use super::*;

impl HostedProvider {
    pub async fn compact_through(&self, collection_id: Uuid, through: u64) -> ApiResult<()> {
        let mut transaction = self.pool.begin().await?;
        cleanup_expired_snapshot_leases(&mut *transaction, Some(collection_id)).await?;
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
            "DELETE FROM hosted_provider_file_changes WHERE collection_id = $1 AND sequence <= $2",
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
            r#"SELECT min(snapshot_head) FROM (
                 SELECT cursor AS snapshot_head
                 FROM hosted_provider_snapshot_leases
                 WHERE collection_id = $1 AND expires_at > now()
                 UNION ALL
                 SELECT snapshot_head
                 FROM hosted_provider_query_cursors
                 WHERE collection_id = $1 AND hard_expires_at > now()
               ) live_snapshots"#,
        )
        .bind(collection_id)
        .fetch_one(&mut *transaction)
        .await?;
        let prune_boundary = oldest_live_snapshot
            .map(|cursor| cursor.min(through_i64))
            .unwrap_or(through_i64);
        sqlx::query(
            "DELETE FROM hosted_provider_record_relationships
             WHERE collection_id = $1 AND valid_to_sequence IS NOT NULL
               AND valid_to_sequence <= $2",
        )
        .bind(collection_id)
        .bind(prune_boundary)
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            "DELETE FROM hosted_provider_record_resolution_keys
             WHERE collection_id = $1 AND valid_to_sequence IS NOT NULL
               AND valid_to_sequence <= $2",
        )
        .bind(collection_id)
        .bind(prune_boundary)
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            "DELETE FROM hosted_provider_record_projections
             WHERE collection_id = $1 AND valid_to_sequence IS NOT NULL
               AND valid_to_sequence <= $2",
        )
        .bind(collection_id)
        .bind(prune_boundary)
        .execute(&mut *transaction)
        .await?;
        prune_unpinned_projection_generations_in(&mut transaction, collection_id).await?;
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
        let pruned_files = sqlx::query(
            r#"DELETE FROM hosted_provider_file_versions version
               WHERE version.collection_id = $1
                 AND version.sequence <= $2
                 AND version.sequence < (
                   SELECT max(anchor.sequence)
                   FROM hosted_provider_file_versions anchor
                   WHERE anchor.collection_id = version.collection_id
                     AND anchor.file_id = version.file_id
                     AND anchor.sequence <= $2
                 )
               RETURNING object_key, size"#,
        )
        .bind(collection_id)
        .bind(prune_boundary)
        .fetch_all(&mut *transaction)
        .await?;
        let mut pruned_objects = HashMap::<String, u64>::new();
        for row in pruned_files {
            let Some(key) = row.get::<Option<String>, _>("object_key") else {
                continue;
            };
            let size = number(
                row.get::<Option<i64>, _>("size")
                    .ok_or_else(|| ApiError::internal("Stored file version size is missing."))?,
                "file version size",
            )?;
            match pruned_objects.entry(key) {
                std::collections::hash_map::Entry::Vacant(entry) => {
                    entry.insert(size);
                }
                std::collections::hash_map::Entry::Occupied(entry) if *entry.get() == size => {}
                std::collections::hash_map::Entry::Occupied(_) => {
                    return Err(ApiError::internal(
                        "One immutable file object has conflicting stored sizes.",
                    ));
                }
            }
        }
        let mut released_bytes = 0_u64;
        for (key, size) in pruned_objects {
            let referenced: bool = sqlx::query_scalar(
                r#"SELECT EXISTS (
                     SELECT 1 FROM hosted_provider_files
                     WHERE object_key = $1
                     UNION ALL
                     SELECT 1 FROM hosted_provider_file_versions
                     WHERE object_key = $1
                   )"#,
            )
            .bind(&key)
            .fetch_one(&mut *transaction)
            .await?;
            if referenced {
                continue;
            }
            let queued = sqlx::query(
                r#"INSERT INTO hosted_provider_blob_deletions
                     (object_key, byte_length, reason)
                   VALUES ($1, $2, 'version_compaction')
                   ON CONFLICT (object_key) DO NOTHING"#,
            )
            .bind(&key)
            .bind(to_i64(size, "file version size")?)
            .execute(&mut *transaction)
            .await?;
            if queued.rows_affected() == 1 {
                released_bytes = released_bytes
                    .checked_add(size)
                    .ok_or_else(|| ApiError::internal("Released file bytes overflowed."))?;
            }
        }
        if released_bytes > 0 {
            sqlx::query(
                r#"UPDATE hosted_provider_collections
                   SET stored_file_bytes = stored_file_bytes - $2
                   WHERE id = $1 AND stored_file_bytes >= $2"#,
            )
            .bind(collection_id)
            .bind(to_i64(released_bytes, "released file bytes")?)
            .execute(&mut *transaction)
            .await?;
        }
        transaction.commit().await?;
        if let Err(error) = self.delete_pending_blobs(500).await {
            tracing::warn!(%error, "deferred hosted blob deletion failed after compaction");
        }
        Ok(())
    }

    /// Bounds the durable change log without relying on a control-plane cron.
    /// Replicas behind the retained cursor deliberately use the ordinary
    /// snapshot-reset path on their next pull.
    pub async fn compact_stale_history(&self, retain_changes: u64) -> ApiResult<usize> {
        self.compact_operation_mutations().await?;
        self.compact_expired_query_page_receipts(i64::MAX).await?;
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

    /// Delete a deterministic, bounded expiry window. This runs on every
    /// maintenance tick even when no collection has enough change history to
    /// trigger ordinary compaction, so retry receipts cannot become a durable
    /// encrypted-response archive.
    pub async fn compact_expired_query_page_receipts(&self, limit: i64) -> ApiResult<usize> {
        let budgets = &crate::HostedExecutionBudgetManifest::published().defaults;
        let limit = limit.clamp(
            1,
            to_i64(
                budgets.query_receipt_cleanup_rows,
                "query receipt cleanup row budget",
            )?,
        );
        let deleted = sqlx::query(
            r#"WITH candidates AS MATERIALIZED (
                 SELECT replica_id, request_id, collection_id, expires_at,
                        response_ciphertext_bytes AS receipt_bytes
                 FROM hosted_provider_query_page_receipts
                 WHERE expires_at <= now()
                 ORDER BY expires_at, collection_id, replica_id, request_id
                 LIMIT $1
               ), expired AS MATERIALIZED (
                 SELECT replica_id, request_id
                 FROM (
                   SELECT *, sum(receipt_bytes) OVER (
                     ORDER BY expires_at, collection_id, replica_id, request_id
                     ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                   ) AS cumulative_bytes
                   FROM candidates
                 ) bounded
                 WHERE cumulative_bytes <= $2
               )
               DELETE FROM hosted_provider_query_page_receipts receipt
               USING expired
               WHERE receipt.replica_id = expired.replica_id
                 AND receipt.request_id = expired.request_id"#,
        )
        .bind(limit)
        .bind(to_i64(
            budgets.query_receipt_cleanup_bytes,
            "query receipt cleanup byte budget",
        )?)
        .execute(&self.pool)
        .await?
        .rows_affected();
        usize::try_from(deleted)
            .map_err(|_| ApiError::internal("Expired query receipt count overflowed."))
    }

    pub async fn delete_pending_blobs(&self, limit: u32) -> ApiResult<usize> {
        let rows = sqlx::query(
            r#"SELECT object_key FROM hosted_provider_blob_deletions
               ORDER BY created_at LIMIT $1"#,
        )
        .bind(i64::from(limit.clamp(1, 1_000)))
        .fetch_all(&self.pool)
        .await?;
        let mut deleted = 0;
        for row in rows {
            let key: String = row.get("object_key");
            let mut transaction = self.pool.begin().await?;
            if lock_blob_deletion(&mut transaction).await? {
                transaction.commit().await?;
                break;
            }
            let claimed = sqlx::query_scalar::<_, String>(
                "SELECT object_key FROM hosted_provider_blob_deletions WHERE object_key = $1 FOR UPDATE",
            )
            .bind(&key)
            .fetch_optional(&mut *transaction)
            .await?;
            if claimed.is_none() {
                transaction.commit().await?;
                continue;
            }
            let referenced: bool = sqlx::query_scalar(
                r#"SELECT EXISTS (
                     SELECT 1 FROM hosted_provider_files WHERE object_key = $1
                     UNION ALL
                     SELECT 1 FROM hosted_provider_file_versions WHERE object_key = $1
                     UNION ALL
                     SELECT 1 FROM hosted_provider_file_changes
                       WHERE before_object_key = $1 OR after_object_key = $1
                     UNION ALL
                     SELECT 1 FROM hosted_provider_authority_import_file_transfers
                       WHERE staging_object_key = $1 OR committed_object_key = $1
                   )"#,
            )
            .bind(&key)
            .fetch_one(&mut *transaction)
            .await?;
            if referenced {
                sqlx::query("DELETE FROM hosted_provider_blob_deletions WHERE object_key = $1")
                    .bind(&key)
                    .execute(&mut *transaction)
                    .await?;
                transaction.commit().await?;
                tracing::warn!("removed a referenced hosted blob from the deletion queue");
                continue;
            }
            match self.blob_store.delete(&key).await {
                Ok(()) => {
                    sqlx::query("DELETE FROM hosted_provider_blob_deletions WHERE object_key = $1")
                        .bind(&key)
                        .execute(&mut *transaction)
                        .await?;
                    transaction.commit().await?;
                    deleted += 1;
                }
                Err(error) => {
                    sqlx::query(
                        r#"UPDATE hosted_provider_blob_deletions
                           SET attempts = attempts + 1, last_attempt_at = now()
                           WHERE object_key = $1"#,
                    )
                    .bind(&key)
                    .execute(&mut *transaction)
                    .await?;
                    transaction.commit().await?;
                    return Err(error);
                }
            }
        }
        Ok(deleted)
    }
}
