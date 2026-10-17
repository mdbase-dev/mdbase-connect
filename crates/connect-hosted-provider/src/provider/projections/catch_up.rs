impl HostedProvider {
    /// Try to complete a resolved generation that fell behind the collection
    /// head by replaying the delta (see `activate_generation_with_catch_up`).
    ///
    /// Replaying a small delta through the write-path maintenance yields the
    /// state those writes would have produced had the generation already been
    /// active; restarting would re-project the whole collection and, under
    /// steady writes, never converge. Returns `None` after rolling the
    /// savepoint back when catch-up declines, so the caller restarts the
    /// rebuild at the new head. The caller commits on `Some`.
    #[allow(clippy::too_many_arguments)]
    async fn complete_generation_with_catch_up(
        &self,
        transaction: &mut Transaction<'_, Postgres>,
        collection_id: Uuid,
        generation_id: Uuid,
        catalog_revision: String,
        format_version: u64,
        engine_version: String,
        source_head: u64,
        current_head: u64,
        fence: u64,
        data_key: &[u8; 32],
        records_resolved: u64,
        projection_bytes: u64,
        started: Instant,
    ) -> ApiResult<Option<HostedProjectionBatch>> {
        let mut savepoint = sqlx::Acquire::begin(&mut *transaction).await?;
        let caught_up = match self
            .activate_generation_with_catch_up(
                &mut savepoint,
                collection_id,
                generation_id,
                &catalog_revision,
                format_version,
                &engine_version,
                source_head,
                current_head,
                fence,
                data_key,
            )
            .await
        {
            Ok(caught_up) => caught_up,
            Err(error) => {
                savepoint.rollback().await?;
                tracing::info!(
                    %collection_id,
                    %generation_id,
                    error_code = %error.code,
                    "projection catch-up declined; the rebuild restarts at the new head"
                );
                return Ok(None);
            }
        };
        savepoint.commit().await?;
        tracing::info!(
            target: "mdbase_connect::metrics",
            metric = "hosted_projection_resolution_batch",
            records_resolved,
            records_caught_up = caught_up,
            projection_bytes,
            completed = true,
            elapsed_ms = started.elapsed().as_millis() as u64,
            "privacy-safe hosted provider metric"
        );
        Ok(Some(HostedProjectionBatch {
            generation: HostedProjectionGeneration {
                collection_id,
                generation_id,
                catalog_revision,
                projection_format_version: format_version as u32,
                semantic_engine_version: engine_version,
                source_head,
                phase: "resolution".to_string(),
                status: "complete".to_string(),
                lease_fencing_generation: fence,
            },
            records_projected: 0,
            records_resolved,
            ciphertext_bytes: 0,
            projection_bytes,
            phase_advanced: true,
        }))
    }

    /// Activate a resolved generation whose source head fell behind the
    /// collection head, replaying the records changed since its snapshot
    /// through the same maintenance a write applies to an active generation.
    ///
    /// Runs inside the caller's savepoint while it holds the collection row
    /// lock and the generation lease, so the head cannot move underneath it.
    /// Any error leaves the caller to roll the savepoint back and fall back to
    /// abandoning the generation, so oversized deltas, semantic failures and
    /// budget errors keep their existing restart and quarantine behaviour.
    #[allow(clippy::too_many_arguments)]
    async fn activate_generation_with_catch_up(
        &self,
        transaction: &mut Transaction<'_, Postgres>,
        collection_id: Uuid,
        generation_id: Uuid,
        catalog_revision: &str,
        format_version: u64,
        engine_version: &str,
        source_head: u64,
        current_head: u64,
        fence: u64,
        data_key: &[u8; 32],
    ) -> ApiResult<u64> {
        // The latest version of every record is never compacted, so a record
        // changed after the snapshot always has a version above source_head.
        let changed = sqlx::query(
            r#"SELECT DISTINCT ON (version.record_id)
                      version.record_id, version.sequence, version.deleted,
                      record.sequence AS current_sequence, record.content_bytes,
                      EXISTS (
                        SELECT 1 FROM hosted_provider_record_projections projection
                        WHERE projection.collection_id = version.collection_id
                          AND projection.generation_id = $4
                          AND projection.record_id = version.record_id
                          AND projection.valid_to_sequence IS NULL
                      ) AS projected
               FROM hosted_provider_record_versions version
               LEFT JOIN hosted_provider_records record
                 ON record.collection_id = version.collection_id
                AND record.record_id = version.record_id
               WHERE version.collection_id = $1
                 AND version.sequence > $2 AND version.sequence <= $3
               ORDER BY version.record_id, version.sequence DESC
               LIMIT $5"#,
        )
        .bind(collection_id)
        .bind(to_i64(source_head, "source head")?)
        .bind(to_i64(current_head, "collection head")?)
        .bind(generation_id)
        .bind(MAX_PROJECTION_CATCH_UP_RECORDS + 1)
        .fetch_all(&mut **transaction)
        .await?;
        if changed.len() as i64 > MAX_PROJECTION_CATCH_UP_RECORDS {
            return Err(projection_budget("projection_catch_up_records"));
        }

        struct Pending {
            record_id: Uuid,
            sequence: u64,
            was_present: bool,
            live: bool,
        }
        let mut pending = Vec::with_capacity(changed.len());
        let mut plaintext_bytes = 0_u64;
        for row in changed {
            let record_id: Uuid = row.get("record_id");
            let sequence = number(row.get::<i64, _>("sequence"), "record sequence")?;
            let deleted: bool = row.get("deleted");
            let current_sequence = row.get::<Option<i64>, _>("current_sequence");
            let was_present: bool = row.get("projected");
            if deleted {
                if current_sequence.is_some() {
                    return Err(projection_binding_changed());
                }
                if !was_present {
                    // Created and deleted after the snapshot: nothing to do.
                    continue;
                }
            } else {
                if current_sequence != Some(to_i64(sequence, "record sequence")?) {
                    return Err(projection_binding_changed());
                }
                plaintext_bytes = plaintext_bytes.saturating_add(number(
                    row.get::<Option<i64>, _>("content_bytes")
                        .unwrap_or_default(),
                    "record content bytes",
                )?);
                if plaintext_bytes > MAX_RELATIONSHIP_REVALIDATION_BYTES {
                    return Err(projection_budget("projection_catch_up_bytes"));
                }
            }
            pending.push(Pending {
                record_id,
                sequence,
                was_present,
                live: !deleted,
            });
        }

        let activated = sqlx::query(
            r#"UPDATE hosted_provider_collections
               SET active_catalog_revision = $3,
                   active_projection_format_version = $4,
                   active_semantic_engine_version = $5,
                   active_projection_generation_id = $2,
                   active_projection_head = $6,
                   state = 'active', updated_at = now()
               WHERE id = $1 AND state IN ('active', 'indexing') AND head = $6"#,
        )
        .bind(collection_id)
        .bind(generation_id)
        .bind(catalog_revision)
        .bind(to_i64(format_version, "projection format version")?)
        .bind(engine_version)
        .bind(to_i64(current_head, "collection head")?)
        .execute(&mut **transaction)
        .await?;
        if activated.rows_affected() != 1 {
            return Err(projection_source_changed());
        }
        // A type change abandons building generations, so a resource revision
        // that moved while this one stayed building can only be a view change,
        // which carries the binding forward exactly as on an active generation.
        let completed = sqlx::query(
            r#"UPDATE hosted_provider_projection_generations generation
               SET checkpoint_record_id = NULL,
                   status = 'complete',
                   source_resource_revision = collection.resource_revision,
                   integrity_verified_epoch = generation.integrity_epoch,
                   completed_at = now(),
                   lease_owner = NULL,
                   lease_expires_at = NULL,
                   last_error_code = NULL,
                   updated_at = now()
               FROM hosted_provider_collections collection
               WHERE collection.id = generation.collection_id
                 AND generation.collection_id = $1 AND generation.generation_id = $2
                 AND generation.status = 'building' AND generation.phase = 'resolution'
                 AND generation.lease_owner = $3
                 AND generation.lease_fencing_generation = $4
                 AND generation.lease_expires_at > now()
                 AND generation.target_catalog_revision = $5"#,
        )
        .bind(collection_id)
        .bind(generation_id)
        .bind(self.process_epoch)
        .bind(to_i64(fence, "projection lease fence")?)
        .bind(catalog_revision)
        .execute(&mut **transaction)
        .await?;
        if completed.rows_affected() != 1 {
            return Err(projection_lease_unavailable());
        }

        let live_ids = pending
            .iter()
            .filter(|change| change.live)
            .map(|change| change.record_id)
            .collect::<Vec<_>>();
        let mut live_records = HashMap::new();
        if !live_ids.is_empty() {
            let rows = sqlx::query(
                r#"SELECT record_id, sequence, revision, payload_ciphertext, updated_at
                   FROM hosted_provider_records
                   WHERE collection_id = $1 AND record_id = ANY($2::uuid[])"#,
            )
            .bind(collection_id)
            .bind(&live_ids)
            .fetch_all(&mut **transaction)
            .await?;
            for row in rows {
                let record_id: Uuid = row.get("record_id");
                let sequence = number(row.get::<i64, _>("sequence"), "record sequence")?;
                let record: PersistedRecord = self.crypto.decrypt_json(
                    data_key,
                    row.get("payload_ciphertext"),
                    &current_record_aad(collection_id, record_id, sequence),
                )?;
                if record.record_id != record_id
                    || record.revision != row.get::<String, _>("revision")
                {
                    return Err(projection_authority_invalid());
                }
                let file_mtime = row
                    .get::<DateTime<Utc>, _>("updated_at")
                    .to_rfc3339_opts(SecondsFormat::Micros, true);
                live_records.insert(record_id, (sequence, file_mtime, record));
            }
        }

        let mut changes = Vec::with_capacity(pending.len());
        for change in pending {
            let (file_mtime, record) = if change.live {
                let (sequence, file_mtime, record) = live_records
                    .remove(&change.record_id)
                    .ok_or_else(projection_binding_changed)?;
                if sequence != change.sequence {
                    return Err(projection_binding_changed());
                }
                (Some(file_mtime), Some(record))
            } else {
                (None, None)
            };
            changes.push(ActiveProjectionChange {
                record_id: change.record_id,
                record_sequence: change.sequence,
                sequence: change.sequence,
                was_present: change.was_present,
                force_relationship_resolution: false,
                file_mtime,
                record,
            });
        }
        changes.sort_by_key(|change| change.sequence);
        let caught_up = changes.len() as u64;
        self.maintain_active_projection_changes(transaction, collection_id, data_key, &changes)
            .await?;

        sqlx::query(
            r#"UPDATE hosted_provider_projection_generations
               SET projected_records = (
                     SELECT count(*) FROM hosted_provider_record_projections projection
                     WHERE projection.collection_id = $1 AND projection.generation_id = $2
                       AND projection.valid_to_sequence IS NULL
                   ),
                   resolved_records = (
                     SELECT count(*) FROM hosted_provider_record_projections projection
                     WHERE projection.collection_id = $1 AND projection.generation_id = $2
                       AND projection.valid_to_sequence IS NULL
                       AND projection.resolution_complete
                   ),
                   updated_at = now()
               WHERE collection_id = $1 AND generation_id = $2 AND status = 'complete'"#,
        )
        .bind(collection_id)
        .bind(generation_id)
        .execute(&mut **transaction)
        .await?;
        Ok(caught_up)
    }
}
