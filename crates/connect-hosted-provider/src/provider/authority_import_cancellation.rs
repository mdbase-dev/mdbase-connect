use super::*;

// Serializes cancellation with preparation, including the case where no import
// row exists to lock. The cancellation record deliberately has no cleanup FK.
pub(super) async fn lock_import_identity(
    transaction: &mut Transaction<'_, Postgres>,
    transfer_id: Uuid,
) -> ApiResult<()> {
    sqlx::query(
        "SELECT pg_advisory_xact_lock(hashtextextended('mdbase-authority-import:' || $1::text, 0))",
    )
    .bind(transfer_id.to_string())
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

impl HostedProvider {
    pub async fn reconcile_authority_import_cancellation(
        &self,
        transfer_id: Uuid,
        collection_id: Uuid,
        authority_epoch: u64,
    ) -> ApiResult<()> {
        if authority_epoch <= 1 {
            return Err(ApiError::bad_request(
                "invalid_authority_epoch",
                "Invalid transfer epoch.",
            ));
        }
        let epoch = to_i64(authority_epoch, "authority epoch")?;
        let mut transaction = self.pool.begin().await?;
        lock_import_identity(&mut transaction, transfer_id).await?;
        if let Some(receipt) = sqlx::query(
            "SELECT collection_id, authority_epoch FROM hosted_provider_authority_import_cancellations WHERE transfer_id = $1",
        ).bind(transfer_id).fetch_optional(&mut *transaction).await? {
            if receipt.get::<Uuid, _>("collection_id") != collection_id || receipt.get::<i64, _>("authority_epoch") != epoch {
                return Err(cancellation_conflict());
            }
            // Recheck current collection authority even on an exact retry.
        }
        let cleanup = match authority_import_row(&mut transaction, transfer_id).await {
            Ok(row) => {
                if row.get::<Uuid, _>("collection_id") != collection_id
                    || row.get::<i64, _>("next_authority_epoch") != epoch
                    || row.get::<String, _>("collection_state") != "importing"
                {
                    return Err(cancellation_conflict());
                }
                let (_, cleanup) =
                    super::authority_imports::abort_import_in(&mut transaction, transfer_id, &row)
                        .await?;
                cleanup
            }
            Err(error) if error.code == "authority_import_not_found" => {
                // Absence is not acknowledgement. Check current authority, then
                // install a permanent prepare fence before acknowledging it.
                if let Some(row) = sqlx::query("SELECT state, authority_epoch FROM hosted_provider_collections WHERE id = $1 FOR UPDATE")
                    .bind(collection_id).fetch_optional(&mut *transaction).await? {
                    if row.get::<String, _>("state") != "transferred" || row.get::<i64, _>("authority_epoch") != epoch - 1 {
                        return Err(cancellation_conflict());
                    }
                    let other: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM hosted_provider_authority_imports WHERE collection_id = $1)")
                        .bind(collection_id).fetch_one(&mut *transaction).await?;
                    if other { return Err(cancellation_conflict()); }
                }
                Vec::new()
            }
            Err(error) => return Err(error),
        };
        sqlx::query("INSERT INTO hosted_provider_authority_import_cancellations (transfer_id, collection_id, authority_epoch) VALUES ($1, $2, $3) ON CONFLICT (transfer_id) DO NOTHING")
            .bind(transfer_id).bind(collection_id).bind(epoch).execute(&mut *transaction).await?;
        transaction.commit().await?;
        self.abort_authority_import_multipart(cleanup).await;
        Ok(())
    }
}

fn cancellation_conflict() -> ApiError {
    ApiError::conflict(
        "authority_import_recovery_conflict",
        "The transfer cannot be safely cancelled against the current authority.",
    )
}
