#[allow(clippy::too_many_arguments)]
async fn abandon_oversized_projection_candidate(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
    generation_id: Uuid,
    checkpoint: Option<Uuid>,
    source_head: u64,
    process_epoch: Uuid,
    fence: u64,
    catalog_revision: &str,
) -> ApiResult<Option<u64>> {
    // The batch byte window excludes a live first record whose ciphertext alone
    // exceeds its ceiling. Detect that state before the ordinary stale-proof
    // restart so the UUID checkpoint cannot reset forever.
    let oversized_ciphertext_bytes: Option<i64> = sqlx::query_scalar(
        r#"WITH candidate_ids AS MATERIALIZED (
             SELECT record_id
             FROM hosted_provider_record_versions
             WHERE collection_id = $1 AND sequence <= $3
               AND ($2::uuid IS NULL OR record_id > $2)
             GROUP BY record_id
             ORDER BY record_id
             LIMIT 1
           )
           SELECT CASE WHEN version.deleted THEN 0
                       ELSE octet_length(version.payload_ciphertext)::bigint END
           FROM candidate_ids
           CROSS JOIN LATERAL (
             SELECT payload_ciphertext, deleted
             FROM hosted_provider_record_versions
             WHERE collection_id = $1
               AND record_id = candidate_ids.record_id
               AND sequence <= $3
             ORDER BY sequence DESC
             LIMIT 1
           ) version"#,
    )
    .bind(collection_id)
    .bind(checkpoint)
    .bind(to_i64(source_head, "source head")?)
    .fetch_optional(&mut **transaction)
    .await?;
    let Some(observed) = oversized_ciphertext_bytes
        .filter(|bytes| *bytes > MAX_PROJECTION_BATCH_CIPHERTEXT_BYTES as i64)
    else {
        return Ok(None);
    };
    let observed = number(observed, "oversized projection ciphertext")?;
    abandon_projection_generation_for_oversized_record(
        transaction,
        collection_id,
        generation_id,
        process_epoch,
        fence,
        catalog_revision,
    )
    .await?;
    Ok(Some(observed))
}

async fn abandon_projection_generation_for_oversized_record(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
    generation_id: Uuid,
    process_epoch: Uuid,
    fence: u64,
    catalog_revision: &str,
) -> ApiResult<()> {
    let abandoned = sqlx::query(
        r#"UPDATE hosted_provider_projection_generations
           SET status = 'abandoned', abandoned_at = now(), updated_at = now(),
               lease_owner = NULL, lease_expires_at = NULL,
               last_error_code = 'projection_record_too_large'
           WHERE collection_id = $1 AND generation_id = $2
             AND status = 'building' AND phase = 'projection'
             AND lease_owner = $3 AND lease_fencing_generation = $4
             AND lease_expires_at > now()
             AND target_catalog_revision = $5"#,
    )
    .bind(collection_id)
    .bind(generation_id)
    .bind(process_epoch)
    .bind(to_i64(fence, "projection lease fence")?)
    .bind(catalog_revision)
    .execute(&mut **transaction)
    .await?;
    if abandoned.rows_affected() != 1 {
        return Err(projection_lease_unavailable());
    }
    Ok(())
}
