use super::*;

impl HostedProvider {
    pub(super) async fn schedule_uncommitted_upload_cleanup(&self, cleanup: HostedUploadCleanup) {
        if let Err(error) = self.enqueue_uncommitted_upload_cleanup(&cleanup).await {
            tracing::warn!(transfer_id = %cleanup.id, %error, "could not persist upload cleanup intent");
            return;
        }
        let multipart_complete = match cleanup.multipart_upload_id.as_deref() {
            Some(upload_id) => match self
                .blob_store
                .abort_multipart(&cleanup.staging_object_key, upload_id)
                .await
            {
                Ok(()) => true,
                Err(error) => {
                    tracing::warn!(transfer_id = %cleanup.id, %error, "could not abort R2 multipart upload");
                    false
                }
            },
            None => true,
        };
        if multipart_complete {
            if let Err(error) = sqlx::query(
                r#"UPDATE hosted_provider_file_transfers
                   SET cleanup_completed_at = now(), updated_at = now()
                   WHERE id = $1 AND state IN ('aborted', 'expired')"#,
            )
            .bind(cleanup.id)
            .execute(&self.pool)
            .await
            {
                tracing::warn!(transfer_id = %cleanup.id, %error, "could not complete upload cleanup checkpoint");
            }
        }
        if let Err(error) = self.delete_pending_blobs(2).await {
            tracing::warn!(transfer_id = %cleanup.id, %error, "deferred upload object deletion failed");
        }
    }

    async fn enqueue_uncommitted_upload_cleanup(
        &self,
        cleanup: &HostedUploadCleanup,
    ) -> ApiResult<()> {
        let mut transaction = self.pool.begin().await?;
        let terminal: bool = sqlx::query_scalar(
            r#"SELECT state IN ('aborted', 'expired')
               FROM hosted_provider_file_transfers WHERE id = $1 FOR UPDATE"#,
        )
        .bind(cleanup.id)
        .fetch_optional(&mut *transaction)
        .await?
        .unwrap_or(false);
        if !terminal {
            transaction.commit().await?;
            return Ok(());
        }
        for key in [&cleanup.staging_object_key, &cleanup.committed_object_key] {
            sqlx::query(
                r#"INSERT INTO hosted_provider_blob_deletions
                     (object_key, byte_length, reason)
                   VALUES ($1, 0, 'file_transfer_cleanup')
                   ON CONFLICT (object_key) DO NOTHING"#,
            )
            .bind(key)
            .execute(&mut *transaction)
            .await?;
        }
        transaction.commit().await?;
        Ok(())
    }

    /// Expires abandoned ordinary transfers and resumes any cleanup that was
    /// interrupted after the terminal database transition. Work is bounded
    /// and cooperates across provider instances through row-level claims.
    pub async fn recover_expired_file_transfers(&self, limit: u32) -> ApiResult<usize> {
        let limit = i64::from(limit.clamp(1, 1_000));
        let expired = sqlx::query(
            r#"WITH candidates AS (
                 SELECT id FROM hosted_provider_file_transfers
                 WHERE state IN ('open', 'completing') AND expires_at <= now()
                 ORDER BY expires_at, id
                 FOR UPDATE SKIP LOCKED
                 LIMIT $1
               )
               UPDATE hosted_provider_file_transfers transfer
               SET state = 'expired', updated_at = now()
               FROM candidates
               WHERE transfer.id = candidates.id
               RETURNING transfer.id"#,
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        let cleanup_rows = sqlx::query(
            r#"SELECT id, staging_object_key, committed_object_key, multipart_upload_id
               FROM hosted_provider_file_transfers
               WHERE direction = 'upload'
                 AND state IN ('aborted', 'expired')
                 AND cleanup_completed_at IS NULL
               ORDER BY updated_at, id
               LIMIT $1"#,
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        for row in cleanup_rows {
            self.schedule_uncommitted_upload_cleanup(HostedUploadCleanup {
                id: row.get("id"),
                staging_object_key: row.get("staging_object_key"),
                committed_object_key: row.get("committed_object_key"),
                multipart_upload_id: row.get("multipart_upload_id"),
            })
            .await;
        }
        Ok(expired.len())
    }
}
