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
