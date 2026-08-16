#[allow(clippy::too_many_arguments)]
async fn persist_prepared_projection(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
    generation_id: Uuid,
    catalog_revision: &str,
    engine_version: &str,
    fence: u64,
    record_id: Uuid,
    sequence: u64,
    revision: &str,
    prepared: &mdbase::runtime::PreparedSemanticProjection,
    canonical_bytes: &[u8],
) -> ApiResult<()> {
    let cas_matches: bool = sqlx::query_scalar(
        r#"SELECT EXISTS (
             SELECT 1 FROM hosted_provider_record_versions r
             JOIN hosted_provider_projection_generations g
               ON g.collection_id = r.collection_id AND g.generation_id = $3
             JOIN hosted_provider_collections c
               ON c.id = r.collection_id
             WHERE r.collection_id = $1 AND r.record_id = $2
               AND r.sequence = $4 AND r.revision = $5
               AND r.deleted = false
               AND g.status = 'building' AND g.phase = 'projection'
               AND g.lease_fencing_generation = $6
               AND g.lease_expires_at > now()
               AND g.target_catalog_revision = $7
               AND c.state = 'active'
           )"#,
    )
    .bind(collection_id)
    .bind(record_id)
    .bind(generation_id)
    .bind(to_i64(sequence, "record sequence")?)
    .bind(revision)
    .bind(to_i64(fence, "projection lease fence")?)
    .bind(catalog_revision)
    .fetch_one(&mut **transaction)
    .await?;
    if !cas_matches {
        return Err(ApiError::conflict(
            "projection_cas_lost",
            "The exact record or projection generation changed during projection.",
        ));
    }
    close_or_replace_projection_versions(
        transaction,
        collection_id,
        generation_id,
        record_id,
        sequence,
        true,
    )
    .await?;
    let projection_value: Value = serde_json::from_slice(canonical_bytes).map_err(|error| {
        ApiError::internal(format!(
            "Semantic projection JSON could not decode: {error}"
        ))
    })?;
    let structural_digest = decode_sha256(&prepared.structure.structural_digest)?;
    let file_modified_at = projected_file_modified_at(&prepared.facts)?;
    sqlx::query(
        r#"INSERT INTO hosted_provider_record_projections
             (collection_id, record_id, record_sequence, valid_from_sequence, record_revision,
              catalog_revision, projection_format_version, semantic_engine_version,
              generation_id, canonical_path, matched_types, file_size_bytes,
              file_modified_at, semantic_complete, resolution_complete,
              semantic_projection, projection_digest, structural_digest, projection_bytes)
           VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                   false, false, $13, $14, $15, $16)"#,
    )
    .bind(collection_id)
    .bind(record_id)
    .bind(to_i64(sequence, "record sequence")?)
    .bind(revision)
    .bind(catalog_revision)
    .bind(i64::from(prepared.facts.format_version))
    .bind(engine_version)
    .bind(generation_id)
    .bind(&prepared.facts.path)
    .bind(&prepared.facts.types)
    .bind(to_i64(prepared.facts.file.size, "projected file size")?)
    .bind(file_modified_at)
    .bind(projection_value)
    .bind(vec![0_u8; 32])
    .bind(structural_digest)
    .bind(to_i64(canonical_bytes.len() as u64, "projection size")?)
    .execute(&mut **transaction)
    .await?;
    for key in &prepared.facts.resolution_keys {
        sqlx::query(
            r#"INSERT INTO hosted_provider_record_resolution_keys
                 (collection_id, record_id, key_kind, lookup_key, record_revision, record_sequence,
                  catalog_revision, projection_format_version, semantic_engine_version,
                  generation_id, valid_from_sequence)
               VALUES ($1, $2, $3, $4, $5, $10, $6, $7, $8, $9, $10)"#,
        )
        .bind(collection_id)
        .bind(record_id)
        .bind(resolution_key_kind(key.kind))
        .bind(&key.value)
        .bind(revision)
        .bind(catalog_revision)
        .bind(i64::from(prepared.facts.format_version))
        .bind(engine_version)
        .bind(generation_id)
        .bind(to_i64(sequence, "record sequence")?)
        .execute(&mut **transaction)
        .await?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn persist_resolved_projection(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
    generation_id: Uuid,
    catalog_revision: &str,
    lease_owner: Uuid,
    fence: u64,
    record_id: Uuid,
    valid_from: u64,
    record_revision: &str,
    projection: &mdbase::runtime::SemanticProjection,
    canonical_bytes: &[u8],
) -> ApiResult<()> {
    let projection_value: Value = serde_json::from_slice(canonical_bytes).map_err(|error| {
        ApiError::internal(format!(
            "Final semantic projection JSON could not decode: {error}"
        ))
    })?;
    let updated = sqlx::query(
        r#"UPDATE hosted_provider_record_projections p
           SET semantic_complete = $8, resolution_complete = true,
               semantic_projection = $9, projection_digest = $10,
               projection_bytes = $11, updated_at = now()
           FROM hosted_provider_projection_generations g,
                hosted_provider_collections c,
                hosted_provider_record_versions r
           WHERE p.collection_id = $1 AND p.record_id = $2
             AND p.generation_id = $3 AND p.valid_from_sequence = $4
             AND p.valid_to_sequence IS NULL AND p.record_revision = $5
             AND g.collection_id = p.collection_id AND g.generation_id = p.generation_id
             AND g.status = 'building' AND g.phase = 'resolution'
             AND g.lease_owner = $6 AND g.lease_fencing_generation = $7
             AND g.lease_expires_at > now()
             AND g.target_catalog_revision = $12
             AND c.id = p.collection_id
             AND c.state = 'active'
             AND r.collection_id = p.collection_id AND r.record_id = p.record_id
             AND r.sequence = p.record_sequence AND r.revision = p.record_revision
             AND r.deleted = false"#,
    )
    .bind(collection_id)
    .bind(record_id)
    .bind(generation_id)
    .bind(to_i64(valid_from, "projection sequence")?)
    .bind(record_revision)
    .bind(lease_owner)
    .bind(to_i64(fence, "projection lease fence")?)
    .bind(projection.facts.semantic_complete)
    .bind(projection_value)
    .bind(vec![0_u8; 32])
    .bind(to_i64(canonical_bytes.len() as u64, "projection size")?)
    .bind(catalog_revision)
    .execute(&mut **transaction)
    .await?;
    if updated.rows_affected() != 1 {
        return Err(ApiError::conflict(
            "projection_cas_lost",
            "The record or generation changed during relationship resolution.",
        ));
    }
    insert_relationships(
        transaction,
        collection_id,
        generation_id,
        catalog_revision,
        record_id,
        valid_from,
        valid_from,
        record_revision,
        projection,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn insert_relationships(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
    generation_id: Uuid,
    catalog_revision: &str,
    record_id: Uuid,
    valid_from: u64,
    source_record_sequence: u64,
    record_revision: &str,
    projection: &mdbase::runtime::SemanticProjection,
) -> ApiResult<()> {
    for occurrence in &projection.structure.occurrences {
        let Some(resolution_state) = relationship_resolution_state(occurrence.resolution) else {
            continue;
        };
        let target_record_id = occurrence
            .target_record_id
            .as_deref()
            .map(Uuid::parse_str)
            .transpose()
            .map_err(|_| {
                ApiError::internal("Resolved relationship target identity is not a UUID.")
            })?;
        let occurrence_bytes = serde_jcs::to_vec(&occurrence.occurrence).map_err(|error| {
            ApiError::internal(format!(
                "Relationship occurrence could not serialize: {error}"
            ))
        })?;
        sqlx::query(
            r#"INSERT INTO hosted_provider_record_relationships
                 (collection_id, source_record_id, occurrence_key, valid_from_sequence,
                  source_record_revision, source_record_sequence, catalog_revision,
                  projection_format_version,
                  semantic_engine_version, generation_id, relationship_kind, source_field,
                  raw_target, normalized_target, alias, anchor, is_relative,
                  resolution_state, target_record_id, target_path)
               VALUES ($1, $2, $3, $4, $5, $20, $6, $7, $8, $9, $10, $11, $12,
                       $13, $14, $15, $16, $17, $18, $19)"#,
        )
        .bind(collection_id)
        .bind(record_id)
        .bind(Sha256::digest(occurrence_bytes).to_vec())
        .bind(to_i64(valid_from, "projection sequence")?)
        .bind(record_revision)
        .bind(catalog_revision)
        .bind(i64::from(projection.facts.format_version))
        .bind(&projection.facts.semantic_engine_version)
        .bind(generation_id)
        .bind(relationship_kind(occurrence.occurrence.kind))
        .bind(&occurrence.occurrence.field)
        .bind(&occurrence.occurrence.raw_target)
        .bind(
            occurrence
                .occurrence
                .normalized_target
                .as_deref()
                .unwrap_or(&occurrence.occurrence.raw_target),
        )
        .bind(&occurrence.occurrence.alias)
        .bind(&occurrence.occurrence.anchor)
        .bind(occurrence.occurrence.relative)
        .bind(resolution_state)
        .bind(target_record_id)
        .bind(&occurrence.target_path)
        .bind(to_i64(source_record_sequence, "source record sequence")?)
        .execute(&mut **transaction)
        .await?;
    }
    Ok(())
}

async fn close_or_replace_projection_versions(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
    generation_id: Uuid,
    record_id: Uuid,
    sequence: u64,
    close_relationships: bool,
) -> ApiResult<()> {
    let sequence = to_i64(sequence, "record sequence")?;
    if close_relationships {
        sqlx::query(
            r#"DELETE FROM hosted_provider_record_relationships
               WHERE collection_id = $1 AND source_record_id = $2
                 AND generation_id = $4
                 AND valid_to_sequence IS NULL AND valid_from_sequence >= $3"#,
        )
        .bind(collection_id)
        .bind(record_id)
        .bind(sequence)
        .bind(generation_id)
        .execute(&mut **transaction)
        .await?;
        sqlx::query(
            r#"UPDATE hosted_provider_record_relationships SET valid_to_sequence = $3
               WHERE collection_id = $1 AND source_record_id = $2
                 AND generation_id = $4
                 AND valid_to_sequence IS NULL AND valid_from_sequence < $3"#,
        )
        .bind(collection_id)
        .bind(record_id)
        .bind(sequence)
        .bind(generation_id)
        .execute(&mut **transaction)
        .await?;
    }
    sqlx::query(
        r#"DELETE FROM hosted_provider_record_resolution_keys
           WHERE collection_id = $1 AND record_id = $2
             AND generation_id = $4
             AND valid_to_sequence IS NULL AND valid_from_sequence >= $3"#,
    )
    .bind(collection_id)
    .bind(record_id)
    .bind(sequence)
    .bind(generation_id)
    .execute(&mut **transaction)
    .await?;
    sqlx::query(
        r#"UPDATE hosted_provider_record_resolution_keys SET valid_to_sequence = $3
           WHERE collection_id = $1 AND record_id = $2
             AND generation_id = $4
             AND valid_to_sequence IS NULL AND valid_from_sequence < $3"#,
    )
    .bind(collection_id)
    .bind(record_id)
    .bind(sequence)
    .bind(generation_id)
    .execute(&mut **transaction)
    .await?;
    sqlx::query(
        r#"DELETE FROM hosted_provider_record_projections
           WHERE collection_id = $1 AND record_id = $2
             AND generation_id = $4
             AND valid_to_sequence IS NULL AND valid_from_sequence >= $3"#,
    )
    .bind(collection_id)
    .bind(record_id)
    .bind(sequence)
    .bind(generation_id)
    .execute(&mut **transaction)
    .await?;
    sqlx::query(
        r#"UPDATE hosted_provider_record_projections SET valid_to_sequence = $3
           WHERE collection_id = $1 AND record_id = $2
             AND generation_id = $4
             AND valid_to_sequence IS NULL AND valid_from_sequence < $3"#,
    )
    .bind(collection_id)
    .bind(record_id)
    .bind(sequence)
    .bind(generation_id)
    .execute(&mut **transaction)
    .await?;
    // The temporal end is part of the v2 integrity envelope. Refresh expected
    // only after the close update has caused the observer trigger to compute
    // the new row digest; combining these assignments would hash the OLD row.
    sqlx::query(
        r#"UPDATE hosted_provider_record_projections projection
           SET projection_digest = hosted_provider_projection_digest(projection)
           WHERE collection_id = $1 AND record_id = $2
             AND generation_id = $4
             AND valid_to_sequence = $3 AND valid_from_sequence < $3"#,
    )
    .bind(collection_id)
    .bind(record_id)
    .bind(sequence)
    .bind(generation_id)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

fn resolution_key_kind(kind: mdbase::runtime::RecordResolutionKeyKind) -> &'static str {
    match kind {
        mdbase::runtime::RecordResolutionKeyKind::Path => "path",
        mdbase::runtime::RecordResolutionKeyKind::Basename => "basename",
        mdbase::runtime::RecordResolutionKeyKind::Id => "id",
        mdbase::runtime::RecordResolutionKeyKind::Title => "title",
    }
}

fn parse_resolution_key_kind(kind: &str) -> ApiResult<mdbase::runtime::RecordResolutionKeyKind> {
    match kind {
        "path" => Ok(mdbase::runtime::RecordResolutionKeyKind::Path),
        "basename" => Ok(mdbase::runtime::RecordResolutionKeyKind::Basename),
        "id" => Ok(mdbase::runtime::RecordResolutionKeyKind::Id),
        "title" => Ok(mdbase::runtime::RecordResolutionKeyKind::Title),
        _ => Err(ApiError::internal(
            "Stored relationship lookup key kind is unsupported.",
        )),
    }
}

fn relationship_kind(kind: mdbase::runtime::StructuralLinkKind) -> &'static str {
    match kind {
        mdbase::runtime::StructuralLinkKind::Wikilink => "wikilink",
        mdbase::runtime::StructuralLinkKind::MarkdownLink => "markdown_link",
        mdbase::runtime::StructuralLinkKind::WikilinkEmbed
        | mdbase::runtime::StructuralLinkKind::MarkdownImage => "embed",
        mdbase::runtime::StructuralLinkKind::Path => "frontmatter_link",
    }
}

fn relationship_resolution_state(
    state: mdbase::runtime::StructuralResolution,
) -> Option<&'static str> {
    match state {
        mdbase::runtime::StructuralResolution::Resolved => Some("resolved"),
        mdbase::runtime::StructuralResolution::Missing => Some("missing"),
        mdbase::runtime::StructuralResolution::Ambiguous => Some("ambiguous"),
        mdbase::runtime::StructuralResolution::UnsafeTraversal => Some("unsafe"),
        mdbase::runtime::StructuralResolution::External => Some("external"),
        mdbase::runtime::StructuralResolution::Malformed => None,
        mdbase::runtime::StructuralResolution::Unresolved => None,
    }
}

fn decode_sha256(value: &str) -> ApiResult<Vec<u8>> {
    let encoded = value.strip_prefix("sha256:").ok_or_else(|| {
        ApiError::internal("Semantic structural digest has an unsupported algorithm.")
    })?;
    if encoded.len() != 64 {
        return Err(ApiError::internal(
            "Semantic structural digest has an invalid length.",
        ));
    }
    (0..32)
        .map(|index| {
            u8::from_str_radix(&encoded[index * 2..index * 2 + 2], 16)
                .map_err(|_| ApiError::internal("Semantic structural digest is not hexadecimal."))
        })
        .collect()
}

fn projected_file_modified_at(
    facts: &mdbase::runtime::SemanticProjectionFacts,
) -> ApiResult<Option<DateTime<Utc>>> {
    facts
        .file
        .mtime
        .as_deref()
        .map(DateTime::parse_from_rfc3339)
        .transpose()
        .map_err(|_| ApiError::internal("Projected file mtime is not valid RFC 3339."))
        .map(|value| value.map(|value| value.with_timezone(&Utc)))
}

fn projection_lease_unavailable() -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT,
        "projection_lease_unavailable",
        "The projection generation lease is unavailable or fenced.",
    )
}

fn projection_binding_changed() -> ApiError {
    ApiError::conflict(
        "projection_binding_changed",
        "The collection projection binding changed during rebuild.",
    )
}

fn projection_source_changed() -> ApiError {
    ApiError::conflict(
        "projection_source_head_changed",
        "The collection changed during rebuild; start a new projection generation.",
    )
}

fn projection_budget(kind: &str) -> ApiError {
    ApiError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        "hosted_execution_budget_exceeded",
        "The hosted projection or relationship operation exceeds an execution budget.",
    )
    .with_details(json!({"budget_kind": kind}))
}

fn projection_record_too_large(budget: &str, limit: u64, observed: u64) -> ApiError {
    ApiError::quota(
        "projection_record_too_large",
        "One exact record cannot fit the bounded semantic projection rebuild window.",
    )
    .with_details(json!({
        "budget": budget,
        "limit": limit,
        "observed": observed,
        "terminal": true,
    }))
}

fn projection_authority_invalid() -> ApiError {
    ApiError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        "projection_authority_invalid",
        "A live exact-authority record is missing, corrupt, or does not match its revision binding.",
    )
    .with_details(json!({"terminal": true}))
}

fn projection_semantic_error(error: mdbase::runtime::CatalogError) -> ApiError {
    ApiError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        "projection_semantic_failure",
        "The structural projection could not be resolved canonically.",
    )
    .with_details(json!({"semantic_code": error.code}))
}

fn projection_generation_semantic_error(error: mdbase::runtime::CatalogError) -> ApiError {
    ApiError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        "projection_semantic_failure",
        "The exact record could not produce a canonical semantic projection.",
    )
    .with_details(json!({"semantic_code": error.code, "terminal": true}))
}

fn projection_generation_state_invalid(message: impl Into<String>) -> ApiError {
    ApiError::new(StatusCode::CONFLICT, "projection_state_invalid", message)
        .with_details(json!({"terminal": true}))
}
