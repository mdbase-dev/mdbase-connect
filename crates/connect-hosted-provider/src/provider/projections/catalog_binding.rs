pub(super) async fn invalidate_projection_catalog_binding(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
) -> ApiResult<()> {
    sqlx::query(
        r#"UPDATE hosted_provider_projection_generations
           SET status = 'abandoned', abandoned_at = now(), updated_at = now(),
               lease_owner = NULL, lease_expires_at = NULL,
               last_error_code = 'catalog_changed'
           WHERE collection_id = $1 AND status = 'building'"#,
    )
    .bind(collection_id)
    .execute(&mut **transaction)
    .await?;
    sqlx::query("DELETE FROM hosted_provider_query_cursors WHERE collection_id = $1")
        .bind(collection_id)
        .execute(&mut **transaction)
        .await?;
    sqlx::query("DELETE FROM hosted_provider_base_query_invocations WHERE collection_id = $1")
        .bind(collection_id)
        .execute(&mut **transaction)
        .await?;
    sqlx::query(
        r#"UPDATE hosted_provider_collections
           SET active_catalog_revision = NULL,
               active_projection_format_version = NULL,
               active_semantic_engine_version = NULL,
               active_projection_generation_id = NULL,
               active_projection_head = NULL,
               updated_at = now()
           WHERE id = $1"#,
    )
    .bind(collection_id)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

/// Unbind an active generation built by another semantic engine. The
/// generation itself is kept, so cursors pinned to it by a provider still
/// running that engine can finish paging.
pub(super) async fn unbind_foreign_engine_projection(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
) -> ApiResult<()> {
    sqlx::query(
        r#"UPDATE hosted_provider_collections
           SET active_catalog_revision = NULL,
               active_projection_format_version = NULL,
               active_semantic_engine_version = NULL,
               active_projection_generation_id = NULL,
               active_projection_head = NULL,
               updated_at = now()
           WHERE id = $1"#,
    )
    .bind(collection_id)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

/// Errors after which a fresh indexing start from the current head can succeed.
const UPGRADE_RETRYABLE: [&str; 4] = [
    "projection_index_binding_changed",
    "projection_source_head_changed",
    "projection_lease_unavailable",
    "projection_generation_not_building",
];

impl HostedProvider {
    /// Drive one collection that is not ready, typically one indexed by
    /// another semantic engine, to a ready generation of this engine. The
    /// collection stays available on exact fallback throughout, and the
    /// completed generation binds atomically. Returns the last error code
    /// when the collection is still not ready after every attempt.
    pub async fn upgrade_projection_engine(
        &self,
        mut status: HostedProjectionStatus,
        attempts: u32,
        batches_per_attempt: u32,
    ) -> ApiResult<Option<String>> {
        let collection_id = status.collection_id;
        let mut last_code = "projection_not_ready".to_string();
        for _ in 0..attempts {
            match self
                .request_projection_indexing(
                    collection_id,
                    status.head,
                    status.resource_revision.clone(),
                )
                .await
            {
                Ok(requested) => status = requested,
                Err(error) if UPGRADE_RETRYABLE.contains(&error.code.as_str()) => {
                    last_code = error.code;
                    status = self.projection_status(collection_id).await?;
                    continue;
                }
                // Quarantined or otherwise refused collections are reported,
                // not retried; they stay available on exact fallback.
                Err(error) => return Ok(Some(error.code)),
            }
            let mut batches = 0_u32;
            while !status.ready && batches < batches_per_attempt {
                let Some(generation) = status.building_generation.as_ref() else {
                    break;
                };
                match self
                    .advance_projection_generation(collection_id, generation.generation_id)
                    .await
                {
                    Ok(_) => {}
                    Err(error) if UPGRADE_RETRYABLE.contains(&error.code.as_str()) => {
                        last_code = error.code;
                        break;
                    }
                    Err(error) => return Ok(Some(error.code)),
                }
                batches += 1;
                status = self.projection_status(collection_id).await?;
            }
            status = self.projection_status(collection_id).await?;
            if status.ready {
                return Ok(None);
            }
        }
        Ok(Some(last_code))
    }

    /// Abandon a building generation of another semantic engine once its
    /// lease is free. A live lease means its owner is still building it.
    async fn abandon_foreign_engine_generation(
        &self,
        collection_id: Uuid,
        generation_id: Uuid,
    ) -> ApiResult<()> {
        sqlx::query(
            r#"UPDATE hosted_provider_projection_generations
               SET status = 'abandoned', abandoned_at = now(), updated_at = now(),
                   lease_owner = NULL, lease_expires_at = NULL,
                   last_error_code = 'superseded'
               WHERE collection_id = $1 AND generation_id = $2
                 AND status = 'building'
                 AND (projection_format_version <> $3 OR semantic_engine_version <> $4)
                 AND (lease_owner IS NULL OR lease_expires_at <= now())"#,
        )
        .bind(collection_id)
        .bind(generation_id)
        .bind(i64::from(mdbase::runtime::SEMANTIC_PROJECTION_FORMAT_VERSION))
        .bind(mdbase::VERSION)
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn structural_digest_decoder_is_strict() {
        assert_eq!(
            decode_sha256(&format!("sha256:{}", "ab".repeat(32))).unwrap(),
            vec![0xab; 32]
        );
        assert!(decode_sha256("sha256:00").is_err());
        assert!(decode_sha256(&format!("sha256:{}", "zz".repeat(32))).is_err());
        assert!(decode_sha256(&format!("sha512:{}", "00".repeat(32))).is_err());
    }

    #[test]
    fn projection_batch_is_hard_bounded() {
        assert_eq!(1_u64.clamp(1, MAX_PROJECTION_BATCH), 1);
        assert_eq!(u64::MAX.clamp(1, MAX_PROJECTION_BATCH), 200);
    }

    #[test]
    fn relationship_wire_mappings_are_closed() {
        assert_eq!(
            relationship_kind(mdbase::runtime::StructuralLinkKind::MarkdownImage),
            "embed"
        );
        assert_eq!(
            relationship_resolution_state(mdbase::runtime::StructuralResolution::UnsafeTraversal),
            Some("unsafe")
        );
        assert_eq!(
            relationship_resolution_state(mdbase::runtime::StructuralResolution::Malformed),
            None
        );
        assert!(parse_resolution_key_kind("invented").is_err());
    }
}
