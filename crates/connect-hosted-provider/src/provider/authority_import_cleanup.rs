use super::*;

#[derive(Debug)]
pub(super) struct AuthorityImportBlobCleanup {
    staging_object_key: String,
    multipart_upload_id: Option<String>,
}

pub(super) async fn authority_import_blob_cleanup(
    transaction: &mut Transaction<'_, Postgres>,
    import_id: Uuid,
) -> ApiResult<Vec<AuthorityImportBlobCleanup>> {
    Ok(sqlx::query(
        r#"SELECT staging_object_key, multipart_upload_id
           FROM hosted_provider_authority_import_file_transfers WHERE import_id = $1"#,
    )
    .bind(import_id)
    .fetch_all(&mut **transaction)
    .await?
    .into_iter()
    .map(blob_cleanup_row)
    .collect())
}

pub(super) async fn expired_authority_import_blob_cleanup(
    transaction: &mut Transaction<'_, Postgres>,
) -> ApiResult<Vec<AuthorityImportBlobCleanup>> {
    Ok(sqlx::query(
        r#"SELECT transfer.staging_object_key, transfer.multipart_upload_id
           FROM hosted_provider_authority_import_file_transfers transfer
           JOIN hosted_provider_authority_imports import ON import.id = transfer.import_id
           WHERE import.state IN ('receiving', 'uploaded') AND import.expires_at <= now()"#,
    )
    .fetch_all(&mut **transaction)
    .await?
    .into_iter()
    .map(blob_cleanup_row)
    .collect())
}

fn blob_cleanup_row(row: PgRow) -> AuthorityImportBlobCleanup {
    AuthorityImportBlobCleanup {
        staging_object_key: row.get("staging_object_key"),
        multipart_upload_id: row.get("multipart_upload_id"),
    }
}

pub(super) async fn enqueue_authority_import_blob_cleanup(
    transaction: &mut Transaction<'_, Postgres>,
    import_id: Uuid,
) -> ApiResult<()> {
    sqlx::query(
        r#"INSERT INTO hosted_provider_blob_deletions (object_key, byte_length, reason)
           SELECT staging_object_key, expected_size, 'abandoned authority import staging object'
           FROM hosted_provider_authority_import_file_transfers WHERE import_id = $1
           ON CONFLICT DO NOTHING"#,
    )
    .bind(import_id)
    .execute(&mut **transaction)
    .await?;
    sqlx::query(
        r#"INSERT INTO hosted_provider_blob_deletions (object_key, byte_length, reason)
           SELECT committed_object_key, expected_size, 'abandoned authority import object'
           FROM hosted_provider_authority_import_file_transfers WHERE import_id = $1
           ON CONFLICT DO NOTHING"#,
    )
    .bind(import_id)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

impl HostedProvider {
    pub(super) async fn abort_authority_import_multipart(
        &self,
        cleanups: Vec<AuthorityImportBlobCleanup>,
    ) {
        for cleanup in cleanups {
            let Some(upload_id) = cleanup.multipart_upload_id else {
                continue;
            };
            if let Err(error) = self
                .blob_store
                .abort_multipart(&cleanup.staging_object_key, &upload_id)
                .await
            {
                tracing::warn!(%error, "could not abort abandoned authority import multipart upload");
            }
        }
    }
}
