use std::collections::BTreeSet;

use sqlx::{PgPool, Row};
use uuid::Uuid;

use super::ControlledBlobStore;

pub async fn assert_storage_consistent(
    pool: &PgPool,
    blobs: &ControlledBlobStore,
    collection_id: Uuid,
) {
    let references: BTreeSet<String> = sqlx::query_scalar(
        r#"SELECT object_key FROM hosted_provider_files WHERE collection_id = $1
           UNION
           SELECT object_key FROM hosted_provider_file_versions
             WHERE collection_id = $1 AND object_key IS NOT NULL"#,
    )
    .bind(collection_id)
    .fetch_all(pool)
    .await
    .expect("object references can be read")
    .into_iter()
    .collect();
    let actual: BTreeSet<String> = blobs
        .keys()
        .await
        .into_iter()
        .filter(|key| key.starts_with(&format!("v1/blobs/{collection_id}/")))
        .collect();
    assert_eq!(
        actual, references,
        "R2 objects and durable references diverged"
    );

    let aggregate = sqlx::query(
        r#"SELECT count(*)::bigint AS file_count, coalesce(sum(size), 0)::bigint AS file_bytes
           FROM hosted_provider_files WHERE collection_id = $1"#,
    )
    .bind(collection_id)
    .fetch_one(pool)
    .await
    .expect("file aggregates can be read");
    let counters =
        sqlx::query("SELECT file_count, file_bytes FROM hosted_provider_collections WHERE id = $1")
            .bind(collection_id)
            .fetch_one(pool)
            .await
            .expect("collection counters can be read");
    assert_eq!(
        aggregate.get::<i64, _>("file_count"),
        counters.get::<i64, _>("file_count"),
        "collection file_count drifted"
    );
    assert_eq!(
        aggregate.get::<i64, _>("file_bytes"),
        counters.get::<i64, _>("file_bytes"),
        "collection file_bytes drifted"
    );
    let stored_bytes: i64 = sqlx::query_scalar(
        r#"SELECT coalesce(sum(size), 0)::bigint
           FROM hosted_provider_file_versions
           WHERE collection_id = $1 AND NOT deleted"#,
    )
    .bind(collection_id)
    .fetch_one(pool)
    .await
    .expect("stored file bytes can be aggregated");
    let stored_counter: i64 = sqlx::query_scalar(
        "SELECT stored_file_bytes FROM hosted_provider_collections WHERE id = $1",
    )
    .bind(collection_id)
    .fetch_one(pool)
    .await
    .expect("stored file counter can be read");
    assert_eq!(stored_bytes, stored_counter, "stored_file_bytes drifted");

    let invalid_terminal_count: i64 = sqlx::query_scalar(
        r#"SELECT count(*) FROM hosted_provider_file_transfers
           WHERE collection_id = $1 AND (
             (state = 'committed' AND receipt_ciphertext IS NULL) OR
             (state IN ('aborted', 'expired') AND receipt_ciphertext IS NOT NULL)
           )"#,
    )
    .bind(collection_id)
    .fetch_one(pool)
    .await
    .expect("transfer states can be audited");
    assert_eq!(invalid_terminal_count, 0, "invalid terminal transfer state");
    let incomplete_upload_cleanup: i64 = sqlx::query_scalar(
        r#"SELECT count(*) FROM hosted_provider_file_transfers
           WHERE collection_id = $1 AND direction = 'upload'
             AND state IN ('aborted', 'expired')
             AND cleanup_completed_at IS NULL"#,
    )
    .bind(collection_id)
    .fetch_one(pool)
    .await
    .expect("upload cleanup checkpoints can be audited");
    assert_eq!(
        incomplete_upload_cleanup, 0,
        "terminal upload cleanup was not checkpointed"
    );

    for staging_key in sqlx::query_scalar::<_, String>(
        r#"SELECT staging_object_key FROM hosted_provider_file_transfers
           WHERE collection_id = $1 AND direction = 'upload'
             AND state IN ('committed', 'aborted', 'expired')"#,
    )
    .bind(collection_id)
    .fetch_all(pool)
    .await
    .expect("terminal staging keys can be audited")
    {
        assert!(
            !blobs.contains(&staging_key).await,
            "terminal transfer retained staging object {staging_key}"
        );
    }
}
