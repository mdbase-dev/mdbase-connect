impl HostedProvider {
    /// Maintain the active complete generation in the same transaction as an
    /// ordinary exact write. Rebuild generations are immutable snapshots and
    /// are never modified here.
    pub(super) async fn maintain_active_projection_changes(
        &self,
        transaction: &mut Transaction<'_, Postgres>,
        collection_id: Uuid,
        data_key: &[u8; 32],
        changes: &[ActiveProjectionChange],
    ) -> ApiResult<()> {
        if changes.is_empty() {
            return Ok(());
        }
        enable_projection_digest_write(transaction).await?;
        let binding = sqlx::query(
            r#"SELECT c.active_projection_generation_id AS generation_id,
                      c.active_catalog_revision AS catalog_revision,
                      c.active_projection_format_version AS format_version,
                      c.active_semantic_engine_version AS engine_version,
                      c.resources_ciphertext,
                      g.status AS generation_status,
                      g.target_catalog_revision,
                      g.projection_format_version AS generation_format_version,
                      g.semantic_engine_version AS generation_engine_version
               FROM hosted_provider_collections c
               LEFT JOIN hosted_provider_projection_generations g
                 ON g.collection_id = c.id
                AND g.generation_id = c.active_projection_generation_id
               WHERE c.id = $1 AND c.state = 'active'"#,
        )
        .bind(collection_id)
        .fetch_optional(&mut **transaction)
        .await?;
        let Some(binding) = binding else {
            return Err(ApiError::not_found(
                "hosted_collection_not_found",
                "Hosted collection not found.",
            ));
        };
        let Some(generation_id) = binding.get::<Option<Uuid>, _>("generation_id") else {
            return Ok(());
        };
        let catalog_revision = binding
            .get::<Option<String>, _>("catalog_revision")
            .ok_or_else(projection_binding_changed)?;
        let format_version = number(
            binding
                .get::<Option<i32>, _>("format_version")
                .map(i64::from)
                .ok_or_else(projection_binding_changed)?,
            "projection format version",
        )?;
        let engine_version = binding
            .get::<Option<String>, _>("engine_version")
            .ok_or_else(projection_binding_changed)?;
        if binding
            .get::<Option<String>, _>("generation_status")
            .as_deref()
            != Some("complete")
            || binding
                .get::<Option<String>, _>("target_catalog_revision")
                .as_deref()
                != Some(catalog_revision.as_str())
            || binding.get::<Option<i32>, _>("generation_format_version")
                != Some(i32::try_from(format_version).map_err(|_| {
                    ApiError::internal("Projection format version is outside integer range.")
                })?)
            || binding
                .get::<Option<String>, _>("generation_engine_version")
                .as_deref()
                != Some(engine_version.as_str())
        {
            return Err(projection_binding_changed());
        }
        let integrity: (i64, i64) = sqlx::query_as(
            r#"SELECT integrity_epoch, integrity_verified_epoch
               FROM hosted_provider_projection_generations
               WHERE collection_id = $1 AND generation_id = $2 AND status = 'complete'
               FOR UPDATE"#,
        )
        .bind(collection_id)
        .bind(generation_id)
        .fetch_one(&mut **transaction)
        .await?;
        let prior_integrity_verified = integrity.0 == integrity.1;
        if format_version != u64::from(mdbase::runtime::SEMANTIC_PROJECTION_FORMAT_VERSION)
            || engine_version != mdbase::VERSION
        {
            return Err(ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "projection_engine_mismatch",
                "The active projection requires a different semantic engine.",
            ));
        }
        let resources: SyncCollectionResources = self.crypto.decrypt_json(
            data_key,
            binding.get("resources_ciphertext"),
            &resources_aad(collection_id),
        )?;
        let resource_documents =
            load_resource_documents(transaction, &self.crypto, data_key, collection_id).await?;
        let catalog = compile_point_catalog(resources, resource_documents)?;
        if catalog.resource_revision() != catalog_revision {
            return Err(projection_binding_changed());
        }

        let mut active_changes = changes.to_vec();
        let changed_ids = changes
            .iter()
            .map(|change| change.record_id)
            .collect::<Vec<_>>();
        let old_key_rows = sqlx::query(
            r#"SELECT record_id, key_kind, lookup_key
               FROM hosted_provider_record_resolution_keys
               WHERE collection_id = $1 AND generation_id = $2
                 AND valid_to_sequence IS NULL AND record_id = ANY($3::uuid[])"#,
        )
        .bind(collection_id)
        .bind(generation_id)
        .bind(&changed_ids)
        .fetch_all(&mut **transaction)
        .await?;
        let mut old_keys = HashMap::<Uuid, BTreeSet<(String, String)>>::new();
        for row in old_key_rows {
            old_keys
                .entry(row.get("record_id"))
                .or_default()
                .insert((row.get("key_kind"), row.get("lookup_key")));
        }
        let mut identity_changed = BTreeSet::new();
        let mut affected_values = BTreeSet::new();
        for change in &active_changes {
            let new_keys = if let Some(record) = change.record.as_ref() {
                catalog
                    .project_record(&mdbase::runtime::CanonicalRecordInput {
                        stable_id: Some(change.record_id.to_string()),
                        path: record.path.clone(),
                        document: record.document.clone(),
                        file_size: 0,
                        file_mtime: None,
                    })
                    .map_err(projection_semantic_error)?
                    .facts
                    .resolution_keys
                    .into_iter()
                    .map(|key| (resolution_key_kind(key.kind).to_string(), key.value))
                    .collect::<BTreeSet<_>>()
            } else {
                BTreeSet::new()
            };
            let previous = old_keys.get(&change.record_id).cloned().unwrap_or_default();
            if !change.was_present || change.record.is_none() || previous != new_keys {
                identity_changed.insert(change.record_id);
                affected_values.extend(previous.into_iter().map(|(_, value)| value));
                affected_values.extend(new_keys.into_iter().map(|(_, value)| value));
            }
        }
        for change in &mut active_changes {
            change.force_relationship_resolution = identity_changed.contains(&change.record_id)
                || (!identity_changed.is_empty() && changes.len() > 1);
        }
        if !identity_changed.is_empty() {
            let identity_ids = identity_changed.iter().copied().collect::<Vec<_>>();
            let lookup_values = affected_values.into_iter().collect::<Vec<_>>();
            let source_rows = sqlx::query(
                r#"SELECT DISTINCT source_record_id
                   FROM hosted_provider_record_relationships
                   WHERE collection_id = $1 AND generation_id = $2
                     AND valid_to_sequence IS NULL
                     AND (target_record_id = ANY($3::uuid[])
                          OR normalized_target = ANY($4::text[]))
                     AND NOT (source_record_id = ANY($5::uuid[]))
                   ORDER BY source_record_id
                   LIMIT $6"#,
            )
            .bind(collection_id)
            .bind(generation_id)
            .bind(&identity_ids)
            .bind(&lookup_values)
            .bind(&changed_ids)
            .bind((MAX_RELATIONSHIP_REVALIDATION_RECORDS + 1) as i64)
            .fetch_all(&mut **transaction)
            .await?;
            if source_rows.len() > MAX_RELATIONSHIP_REVALIDATION_RECORDS {
                return Err(projection_budget("relationship_revalidation_records"));
            }
            let source_ids = source_rows
                .into_iter()
                .map(|row| row.get::<Uuid, _>("source_record_id"))
                .collect::<Vec<_>>();
            if !source_ids.is_empty() {
                // Keep large TOAST values out of the provider process until the
                // complete revalidation set has passed its plaintext budget.
                let source_metadata = sqlx::query(
                    r#"SELECT r.record_id, r.content_bytes
                       FROM hosted_provider_records r
                       JOIN hosted_provider_record_projections p
                         ON p.collection_id = r.collection_id
                        AND p.generation_id = $2 AND p.record_id = r.record_id
                        AND p.valid_to_sequence IS NULL
                       WHERE r.collection_id = $1 AND r.record_id = ANY($3::uuid[])
                       ORDER BY r.record_id"#,
                )
                .bind(collection_id)
                .bind(generation_id)
                .bind(&source_ids)
                .fetch_all(&mut **transaction)
                .await?;
                if source_metadata.len() != source_ids.len() {
                    return Err(projection_binding_changed());
                }
                let mut plaintext_bytes = 0_u64;
                for row in source_metadata {
                    plaintext_bytes = plaintext_bytes.saturating_add(number(
                        row.get::<i64, _>("content_bytes"),
                        "record content bytes",
                    )?);
                    if plaintext_bytes > MAX_RELATIONSHIP_REVALIDATION_BYTES {
                        return Err(projection_budget("relationship_revalidation_bytes"));
                    }
                }
                let source_records = sqlx::query(
                    r#"SELECT r.record_id, r.sequence, r.revision,
                              r.payload_ciphertext, r.updated_at
                       FROM hosted_provider_records r
                       JOIN hosted_provider_record_projections p
                         ON p.collection_id = r.collection_id
                        AND p.generation_id = $2 AND p.record_id = r.record_id
                        AND p.valid_to_sequence IS NULL
                       WHERE r.collection_id = $1 AND r.record_id = ANY($3::uuid[])
                       ORDER BY r.record_id"#,
                )
                .bind(collection_id)
                .bind(generation_id)
                .bind(&source_ids)
                .fetch_all(&mut **transaction)
                .await?;
                if source_records.len() != source_ids.len() {
                    return Err(projection_binding_changed());
                }
                let final_sequence = changes
                    .iter()
                    .map(|change| change.sequence)
                    .max()
                    .ok_or_else(|| ApiError::internal("Projection write set is empty."))?;
                for row in source_records {
                    let record_id: Uuid = row.get("record_id");
                    let record_sequence = number(row.get::<i64, _>("sequence"), "record sequence")?;
                    let record: PersistedRecord = self.crypto.decrypt_json(
                        data_key,
                        row.get("payload_ciphertext"),
                        &current_record_aad(collection_id, record_id, record_sequence),
                    )?;
                    if record.revision != row.get::<String, _>("revision") {
                        return Err(ApiError::internal(
                            "The exact relationship source revision is inconsistent.",
                        ));
                    }
                    active_changes.push(ActiveProjectionChange {
                        record_id,
                        record_sequence,
                        sequence: final_sequence,
                        was_present: true,
                        force_relationship_resolution: true,
                        file_mtime: Some(
                            row.get::<DateTime<Utc>, _>("updated_at")
                                .to_rfc3339_opts(SecondsFormat::Micros, true),
                        ),
                        record: Some(record),
                    });
                }
            }
        }

        let mut needs_resolution = Vec::new();
        for change in &active_changes {
            let Some(record) = change.record.as_ref() else {
                let projected: bool = sqlx::query_scalar(
                    r#"SELECT EXISTS (
                         SELECT 1 FROM hosted_provider_record_projections
                         WHERE collection_id = $1 AND generation_id = $2 AND record_id = $3
                           AND valid_to_sequence IS NULL
                       )"#,
                )
                .bind(collection_id)
                .bind(generation_id)
                .bind(change.record_id)
                .fetch_one(&mut **transaction)
                .await?;
                if !change.was_present || !projected {
                    return Err(projection_binding_changed());
                }
                close_or_replace_projection_versions(
                    transaction,
                    collection_id,
                    generation_id,
                    change.record_id,
                    change.sequence,
                    true,
                )
                .await?;
                continue;
            };
            let prepared = catalog
                .project_record(&mdbase::runtime::CanonicalRecordInput {
                    stable_id: Some(change.record_id.to_string()),
                    path: record.path.clone(),
                    document: record.document.clone(),
                    file_size: record.document.len() as u64,
                    file_mtime: change.file_mtime.clone(),
                })
                .map_err(projection_semantic_error)?;
            let structural_digest = decode_sha256(&prepared.structure.structural_digest)?;
            let previous = sqlx::query(
                r#"SELECT structural_digest, semantic_projection, resolution_complete
                   FROM hosted_provider_record_projections
                   WHERE collection_id = $1 AND generation_id = $2 AND record_id = $3
                     AND valid_to_sequence IS NULL"#,
            )
            .bind(collection_id)
            .bind(generation_id)
            .bind(change.record_id)
            .fetch_optional(&mut **transaction)
            .await?;
            if change.was_present && previous.is_none() {
                return Err(projection_binding_changed());
            }
            let unchanged = !change.force_relationship_resolution
                && previous.as_ref().is_some_and(|row| {
                    row.get::<bool, _>("resolution_complete")
                        && row.get::<Vec<u8>, _>("structural_digest") == structural_digest
                });
            if unchanged {
                let previous: mdbase::runtime::SemanticProjection = serde_json::from_value(
                    previous
                        .expect("unchanged projection has a row")
                        .get("semantic_projection"),
                )
                .map_err(|error| {
                    ApiError::internal(format!(
                        "Current semantic projection could not decode: {error}"
                    ))
                })?;
                let final_projection = catalog
                    .finalize_projection(prepared, previous.structure)
                    .map_err(projection_semantic_error)?;
                let bytes = final_projection.canonical_json().map_err(|error| {
                    ApiError::internal(format!(
                        "Final semantic projection could not serialize: {error}"
                    ))
                })?;
                insert_active_projection_version(
                    transaction,
                    collection_id,
                    generation_id,
                    &catalog_revision,
                    change,
                    &final_projection.facts,
                    &final_projection.structure.structural_digest,
                    true,
                    &bytes,
                    false,
                )
                .await?;
            } else {
                let bytes = serde_jcs::to_vec(&prepared).map_err(|error| {
                    ApiError::internal(format!(
                        "Prepared semantic projection could not serialize: {error}"
                    ))
                })?;
                insert_active_projection_version(
                    transaction,
                    collection_id,
                    generation_id,
                    &catalog_revision,
                    change,
                    &prepared.facts,
                    &prepared.structure.structural_digest,
                    false,
                    &bytes,
                    true,
                )
                .await?;
                needs_resolution.push((
                    change.record_id,
                    change.record_sequence,
                    change.sequence,
                    record.revision.clone(),
                ));
            }
        }

        for (record_id, record_sequence, sequence, revision) in needs_resolution {
            let value: Value = sqlx::query_scalar(
                r#"SELECT semantic_projection
                   FROM hosted_provider_record_projections
                   WHERE collection_id = $1 AND generation_id = $2 AND record_id = $3
                     AND valid_from_sequence = $4 AND valid_to_sequence IS NULL
                     AND resolution_complete = false"#,
            )
            .bind(collection_id)
            .bind(generation_id)
            .bind(record_id)
            .bind(to_i64(sequence, "record sequence")?)
            .fetch_one(&mut **transaction)
            .await?;
            let prepared: mdbase::runtime::PreparedSemanticProjection =
                serde_json::from_value(value).map_err(|error| {
                    ApiError::internal(format!(
                        "Prepared semantic projection could not decode: {error}"
                    ))
                })?;
            let plan = catalog
                .plan_record_resolution(&prepared.structure)
                .map_err(projection_semantic_error)?;
            let candidates =
                load_resolution_candidates(transaction, collection_id, generation_id, &plan)
                    .await?;
            let resolved = catalog
                .resolve_record_structure(&prepared.structure, &plan, &candidates)
                .map_err(projection_semantic_error)?;
            let final_projection = catalog
                .finalize_projection(prepared, resolved)
                .map_err(projection_semantic_error)?;
            let bytes = final_projection.canonical_json().map_err(|error| {
                ApiError::internal(format!(
                    "Final semantic projection could not serialize: {error}"
                ))
            })?;
            persist_active_resolved_projection(
                transaction,
                collection_id,
                generation_id,
                &catalog_revision,
                record_id,
                record_sequence,
                sequence,
                &revision,
                &final_projection,
                &bytes,
            )
            .await?;
        }
        if prior_integrity_verified {
            let verified = sqlx::query(
                r#"UPDATE hosted_provider_projection_generations
                   SET integrity_verified_epoch = integrity_epoch, updated_at = now()
                   WHERE collection_id = $1 AND generation_id = $2 AND status = 'complete'"#,
            )
            .bind(collection_id)
            .bind(generation_id)
            .execute(&mut **transaction)
            .await?;
            if verified.rows_affected() != 1 {
                return Err(projection_binding_changed());
            }
        }
        Ok(())
    }
}

#[allow(clippy::too_many_arguments)]
async fn insert_active_projection_version(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
    generation_id: Uuid,
    catalog_revision: &str,
    change: &ActiveProjectionChange,
    facts: &mdbase::runtime::SemanticProjectionFacts,
    structural_digest: &str,
    resolution_complete: bool,
    canonical_bytes: &[u8],
    close_relationships: bool,
) -> ApiResult<()> {
    if canonical_bytes.len() > 262_144 {
        return Err(projection_budget("projection_bytes"));
    }
    let record = change
        .record
        .as_ref()
        .ok_or_else(|| ApiError::internal("A live projection change omitted its exact record."))?;
    let active_matches: bool = sqlx::query_scalar(
        r#"SELECT EXISTS (
             SELECT 1
             FROM hosted_provider_collections c
             JOIN hosted_provider_projection_generations g
               ON g.collection_id = c.id
              AND g.generation_id = c.active_projection_generation_id
             JOIN hosted_provider_records r
               ON r.collection_id = c.id AND r.record_id = $3
             WHERE c.id = $1 AND c.active_projection_generation_id = $2
               AND c.active_catalog_revision = $4
               AND g.status = 'complete'
               AND r.sequence = $5 AND r.revision = $6
           )"#,
    )
    .bind(collection_id)
    .bind(generation_id)
    .bind(change.record_id)
    .bind(catalog_revision)
    .bind(to_i64(change.record_sequence, "record sequence")?)
    .bind(&record.revision)
    .fetch_one(&mut **transaction)
    .await?;
    if !active_matches {
        return Err(ApiError::conflict(
            "projection_cas_lost",
            "The exact record or active projection binding changed during the write.",
        ));
    }
    close_or_replace_projection_versions(
        transaction,
        collection_id,
        generation_id,
        change.record_id,
        change.sequence,
        close_relationships,
    )
    .await?;
    let projection_value: Value = serde_json::from_slice(canonical_bytes).map_err(|error| {
        ApiError::internal(format!(
            "Semantic projection JSON could not decode: {error}"
        ))
    })?;
    let file_modified_at = projected_file_modified_at(facts)?;
    sqlx::query(
        r#"INSERT INTO hosted_provider_record_projections
             (collection_id, record_id, record_sequence, valid_from_sequence, record_revision,
              catalog_revision, projection_format_version, semantic_engine_version,
              generation_id, canonical_path, matched_types, file_size_bytes,
              file_modified_at, semantic_complete, resolution_complete,
              semantic_projection, projection_digest, structural_digest, projection_bytes)
           VALUES ($1, $2, $3, $19, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                   $13, $14, $15, $16, $17, $18)"#,
    )
    .bind(collection_id)
    .bind(change.record_id)
    .bind(to_i64(change.record_sequence, "record sequence")?)
    .bind(&record.revision)
    .bind(catalog_revision)
    .bind(i64::from(facts.format_version))
    .bind(&facts.semantic_engine_version)
    .bind(generation_id)
    .bind(&facts.path)
    .bind(&facts.types)
    .bind(to_i64(facts.file.size, "projected file size")?)
    .bind(file_modified_at)
    .bind(resolution_complete && facts.semantic_complete)
    .bind(resolution_complete)
    .bind(projection_value)
    .bind(vec![0_u8; 32])
    .bind(decode_sha256(structural_digest)?)
    .bind(to_i64(canonical_bytes.len() as u64, "projection size")?)
    .bind(to_i64(change.sequence, "projection sequence")?)
    .execute(&mut **transaction)
    .await?;
    for key in &facts.resolution_keys {
        sqlx::query(
            r#"INSERT INTO hosted_provider_record_resolution_keys
                 (collection_id, record_id, key_kind, lookup_key, record_revision, record_sequence,
                  catalog_revision, projection_format_version, semantic_engine_version,
                  generation_id, valid_from_sequence)
               VALUES ($1, $2, $3, $4, $5, $11, $6, $7, $8, $9, $10)"#,
        )
        .bind(collection_id)
        .bind(change.record_id)
        .bind(resolution_key_kind(key.kind))
        .bind(&key.value)
        .bind(&record.revision)
        .bind(catalog_revision)
        .bind(i64::from(facts.format_version))
        .bind(&facts.semantic_engine_version)
        .bind(generation_id)
        .bind(to_i64(change.sequence, "projection sequence")?)
        .bind(to_i64(change.record_sequence, "record sequence")?)
        .execute(&mut **transaction)
        .await?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn persist_active_resolved_projection(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
    generation_id: Uuid,
    catalog_revision: &str,
    record_id: Uuid,
    record_sequence: u64,
    sequence: u64,
    record_revision: &str,
    projection: &mdbase::runtime::SemanticProjection,
    canonical_bytes: &[u8],
) -> ApiResult<()> {
    if canonical_bytes.len() > 262_144 {
        return Err(projection_budget("projection_bytes"));
    }
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
           FROM hosted_provider_collections c,
                hosted_provider_projection_generations g,
                hosted_provider_records r
           WHERE p.collection_id = $1 AND p.generation_id = $2
             AND p.record_id = $3 AND p.valid_from_sequence = $4
             AND p.valid_to_sequence IS NULL AND p.record_revision = $5
             AND c.id = p.collection_id AND c.active_projection_generation_id = p.generation_id
             AND c.active_catalog_revision = $6
             AND g.collection_id = p.collection_id AND g.generation_id = p.generation_id
             AND g.status = 'complete' AND g.semantic_engine_version = $7
             AND r.collection_id = p.collection_id AND r.record_id = p.record_id
             AND r.sequence = p.record_sequence AND r.revision = p.record_revision"#,
    )
    .bind(collection_id)
    .bind(generation_id)
    .bind(record_id)
    .bind(to_i64(sequence, "record sequence")?)
    .bind(record_revision)
    .bind(catalog_revision)
    .bind(&projection.facts.semantic_engine_version)
    .bind(projection.facts.semantic_complete)
    .bind(projection_value)
    .bind(vec![0_u8; 32])
    .bind(to_i64(canonical_bytes.len() as u64, "projection size")?)
    .execute(&mut **transaction)
    .await?;
    if updated.rows_affected() != 1 {
        return Err(ApiError::conflict(
            "projection_cas_lost",
            "The exact record or active projection binding changed during relationship resolution.",
        ));
    }
    insert_relationships(
        transaction,
        collection_id,
        generation_id,
        catalog_revision,
        record_id,
        sequence,
        record_sequence,
        record_revision,
        projection,
    )
    .await
}

async fn load_resolution_candidates(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
    generation_id: Uuid,
    plan: &mdbase::runtime::RecordResolutionPlan,
) -> ApiResult<Vec<mdbase::runtime::ResolutionCandidate>> {
    let requested = plan
        .lookups
        .iter()
        .flat_map(|lookup| {
            lookup.alternatives.iter().map(move |alternative| {
                json!({
                    "occurrence_ordinal": lookup.occurrence_ordinal,
                    "priority": alternative.priority,
                    "key_kind": resolution_key_kind(alternative.kind),
                    "lookup_key": alternative.value,
                })
            })
        })
        .collect::<Vec<_>>();
    if requested.is_empty() {
        return Ok(Vec::new());
    }
    let rows = sqlx::query(
        r#"WITH requested AS (
             SELECT * FROM jsonb_to_recordset($3::jsonb) AS q(
               occurrence_ordinal bigint,
               priority integer,
               key_kind text,
               lookup_key text
             )
           )
           SELECT q.occurrence_ordinal, q.priority, q.key_kind, q.lookup_key,
                  k.record_id, p.canonical_path
           FROM requested q
           JOIN hosted_provider_record_resolution_keys k
             ON k.collection_id = $1 AND k.generation_id = $2
            AND k.valid_to_sequence IS NULL
            AND k.key_kind = q.key_kind AND k.lookup_key = q.lookup_key
           JOIN hosted_provider_record_projections p
             ON p.collection_id = k.collection_id AND p.record_id = k.record_id
            AND p.generation_id = k.generation_id AND p.valid_to_sequence IS NULL
           ORDER BY q.occurrence_ordinal, q.priority, k.record_id
           LIMIT $4"#,
    )
    .bind(collection_id)
    .bind(generation_id)
    .bind(Value::Array(requested))
    .bind((mdbase::runtime::MAX_RESOLUTION_CANDIDATES + 1) as i64)
    .fetch_all(&mut **transaction)
    .await?;
    if rows.len() > mdbase::runtime::MAX_RESOLUTION_CANDIDATES {
        return Err(projection_budget("relationship_candidates"));
    }
    rows.into_iter()
        .map(|row| {
            let kind: String = row.get("key_kind");
            Ok(mdbase::runtime::ResolutionCandidate {
                occurrence_ordinal: number(
                    row.get::<i64, _>("occurrence_ordinal"),
                    "relationship occurrence ordinal",
                )? as usize,
                lookup: mdbase::runtime::ResolutionLookupKey {
                    priority: number(
                        i64::from(row.get::<i32, _>("priority")),
                        "relationship lookup priority",
                    )? as u16,
                    kind: parse_resolution_key_kind(&kind)?,
                    value: row.get("lookup_key"),
                },
                record_id: row.get::<Uuid, _>("record_id").to_string(),
                path: row.get("canonical_path"),
            })
        })
        .collect()
}
