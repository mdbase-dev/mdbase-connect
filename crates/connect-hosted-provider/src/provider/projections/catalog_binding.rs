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
               active_projection_generation_id = NULL
           WHERE id = $1"#,
    )
    .bind(collection_id)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

/// Canonically classify one exact point record for an authorization decision.
/// This is the fail-closed fallback until a current complete projection can be
/// proven against the same record/catalog binding. Persisted record `types` are
/// never accepted as current authorization evidence.
#[allow(clippy::too_many_arguments)]
pub(super) async fn canonical_record_scope_types(
    transaction: &mut Transaction<'_, Postgres>,
    provider: &HostedProvider,
    data_key: &[u8; 32],
    collection_id: Uuid,
    record_id: Uuid,
    sequence: u64,
    revision: String,
    ciphertext: Vec<u8>,
) -> ApiResult<Vec<String>> {
    let exact: PersistedRecord = provider.crypto.decrypt_json(
        data_key,
        &ciphertext,
        &current_record_aad(collection_id, record_id, sequence),
    )?;
    if exact.record_id != record_id || exact.revision != revision {
        return Err(ApiError::forbidden(
            "scope_classification_unavailable",
            "The current record could not be bound to canonical authorization evidence.",
        ));
    }
    let collection = sqlx::query(
        r#"SELECT resource_revision, resources_ciphertext
           FROM hosted_provider_collections
           WHERE id = $1 AND state = 'active'"#,
    )
    .bind(collection_id)
    .fetch_optional(&mut **transaction)
    .await?
    .ok_or_else(|| {
        ApiError::not_found(
            "hosted_collection_not_found",
            "Hosted collection not found.",
        )
    })?;
    let resources: SyncCollectionResources = provider.crypto.decrypt_json(
        data_key,
        collection.get("resources_ciphertext"),
        &resources_aad(collection_id),
    )?;
    if resources.revision != collection.get::<String, _>("resource_revision") {
        return Err(ApiError::forbidden(
            "scope_classification_unavailable",
            "The resource catalog could not be bound during authorization.",
        ));
    }
    let documents =
        load_resource_documents(transaction, &provider.crypto, data_key, collection_id).await?;
    let catalog = compile_point_catalog(resources, documents)?;
    let projection = catalog
        .project_record(&mdbase::runtime::CanonicalRecordInput {
            stable_id: Some(record_id.to_string()),
            path: exact.path,
            document: exact.document,
            file_size: 0,
            file_mtime: None,
        })
        .map_err(|_| {
            ApiError::forbidden(
                "scope_classification_unavailable",
                "The exact record could not be canonically classified for authorization.",
            )
        })?;
    if !projection.facts.semantic_complete {
        return Err(ApiError::forbidden(
            "scope_classification_unavailable",
            "The exact record has incomplete semantic authorization evidence.",
        ));
    }
    Ok(projection.facts.types)
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
