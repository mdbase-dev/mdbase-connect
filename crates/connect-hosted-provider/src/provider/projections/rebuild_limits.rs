enum ProjectionCandidateTerminalIssue {
    Oversized(u64),
    InvalidAuthority,
}

#[allow(clippy::too_many_arguments)]
async fn abandon_invalid_projection_candidate(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
    generation_id: Uuid,
    checkpoint: Option<Uuid>,
    source_head: u64,
    process_epoch: Uuid,
    fence: u64,
    catalog_revision: &str,
) -> ApiResult<Option<ProjectionCandidateTerminalIssue>> {
    // The batch byte window excludes a live first record whose ciphertext alone
    // exceeds its ceiling. Detect that state before the ordinary stale-proof
    // restart so the UUID checkpoint cannot reset forever.
    let candidate = sqlx::query(
        r#"WITH candidate_ids AS MATERIALIZED (
             SELECT record_id
             FROM hosted_provider_record_versions
             WHERE collection_id = $1 AND sequence <= $3
               AND ($2::uuid IS NULL OR record_id > $2)
             GROUP BY record_id
             ORDER BY record_id
             LIMIT 1
           )
           SELECT version.deleted,
                  version.payload_ciphertext IS NULL AS ciphertext_missing,
                  COALESCE(octet_length(version.payload_ciphertext), 0)::bigint
                    AS ciphertext_bytes
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
    let Some(candidate) = candidate else {
        return Ok(None);
    };
    if candidate.get::<bool, _>("deleted") {
        return Ok(None);
    }
    let issue = if candidate.get::<bool, _>("ciphertext_missing") {
        ProjectionCandidateTerminalIssue::InvalidAuthority
    } else {
        let observed = number(
            candidate.get::<i64, _>("ciphertext_bytes"),
            "projection ciphertext bytes",
        )?;
        if observed <= MAX_PROJECTION_BATCH_CIPHERTEXT_BYTES {
            return Ok(None);
        }
        ProjectionCandidateTerminalIssue::Oversized(observed)
    };
    let error_code = match issue {
        ProjectionCandidateTerminalIssue::Oversized(_) => "projection_record_too_large",
        ProjectionCandidateTerminalIssue::InvalidAuthority => "projection_authority_invalid",
    };
    abandon_projection_generation_for_terminal_error(
        transaction,
        collection_id,
        generation_id,
        process_epoch,
        fence,
        catalog_revision,
        error_code,
    )
    .await?;
    Ok(Some(issue))
}

async fn abandon_projection_generation_for_terminal_error(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
    generation_id: Uuid,
    process_epoch: Uuid,
    fence: u64,
    catalog_revision: &str,
    error_code: &str,
) -> ApiResult<()> {
    let abandoned = sqlx::query(
        r#"UPDATE hosted_provider_projection_generations
           SET status = 'abandoned', abandoned_at = now(), updated_at = now(),
               lease_owner = NULL, lease_expires_at = NULL,
               last_error_code = $6
           WHERE collection_id = $1 AND generation_id = $2
             AND status = 'building'
             AND lease_owner = $3 AND lease_fencing_generation = $4
             AND lease_expires_at > now()
             AND target_catalog_revision = $5"#,
    )
    .bind(collection_id)
    .bind(generation_id)
    .bind(process_epoch)
    .bind(to_i64(fence, "projection lease fence")?)
    .bind(catalog_revision)
    .bind(error_code)
    .execute(&mut **transaction)
    .await?;
    if abandoned.rows_affected() != 1 {
        return Err(projection_lease_unavailable());
    }
    Ok(())
}
