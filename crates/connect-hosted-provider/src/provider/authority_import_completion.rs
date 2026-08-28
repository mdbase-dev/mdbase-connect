use super::*;

impl HostedProvider {
    pub async fn complete_authority_import(
        &self,
        import_id: Uuid,
        manifest_digest: &str,
        source_revision: &str,
    ) -> ApiResult<ProviderAuthorityImport> {
        let mut transaction = self.pool.begin().await?;
        let row = authority_import_row(&mut transaction, import_id).await?;
        let state: String = row.get("import_state");
        if state == "completed" {
            return self
                .completed_authority_import_receipt(
                    transaction,
                    &row,
                    row.get("collection_id"),
                    manifest_digest,
                    source_revision,
                )
                .await;
        }
        if !matches!(state.as_str(), "uploaded" | "indexing")
            || row.get::<Option<String>, _>("manifest_digest").as_deref() != Some(manifest_digest)
            || row.get::<Option<String>, _>("source_revision").as_deref() != Some(source_revision)
        {
            return Err(ApiError::conflict(
                "authority_import_not_ready",
                "Authority import does not match the fenced source snapshot.",
            ));
        }
        let collection_id: Uuid = row.get("collection_id");
        let authority_epoch = number(row.get::<i64, _>("next_authority_epoch"), "authority epoch")?;
        if state == "uploaded" {
            let indexing = sqlx::query(
                r#"UPDATE hosted_provider_collections
                   SET state = 'indexing', authority_epoch = $2, updated_at = now()
                   WHERE id = $1 AND state = 'importing'"#,
            )
            .bind(collection_id)
            .bind(to_i64(authority_epoch, "authority epoch")?)
            .execute(&mut *transaction)
            .await?;
            if indexing.rows_affected() != 1 {
                return Err(ApiError::conflict(
                    "authority_import_target_unavailable",
                    "Authority import target is no longer pending.",
                ));
            }
            sqlx::query(
                "UPDATE hosted_provider_authority_imports SET state = 'indexing' WHERE id = $1",
            )
            .bind(import_id)
            .execute(&mut *transaction)
            .await?;
        }
        transaction.commit().await?;

        let binding = sqlx::query(
            "SELECT head, resource_revision FROM hosted_provider_collections WHERE id = $1 AND state IN ('indexing', 'active')",
        )
        .bind(collection_id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| {
            ApiError::conflict(
                "authority_import_target_unavailable",
                "Authority import target is no longer indexing.",
            )
        })?;
        let projection = self
            .request_projection_indexing(
                collection_id,
                number(binding.get::<i64, _>("head"), "collection head")?,
                binding.get("resource_revision"),
            )
            .await?;
        let expected_generation_id = if projection.ready {
            projection.active_generation_id
        } else {
            projection
                .building_generation
                .as_ref()
                .map(|generation| generation.generation_id)
        };
        if !projection.ready {
            let generation = projection.building_generation.as_ref().ok_or_else(|| {
                ApiError::internal("Authority import indexing has no building generation.")
            })?;
            #[cfg(feature = "test-hooks")]
            crate::test_hooks::pause_authority_import(
                import_id,
                crate::test_hooks::AuthorityImportHookPoint::BeforeProjectionAdvance,
            )
            .await;
            match self
                .advance_projection_generation(collection_id, generation.generation_id)
                .await
            {
                Ok(_) => {}
                Err(error)
                    if matches!(
                        error.code.as_str(),
                        "projection_lease_unavailable" | "projection_generation_not_building"
                    ) => {}
                Err(error) => return Err(error),
            };
        }

        self.projection_status(collection_id).await?;
        #[cfg(feature = "test-hooks")]
        crate::test_hooks::pause_authority_import(
            import_id,
            crate::test_hooks::AuthorityImportHookPoint::BeforeSecondPhaseLock,
        )
        .await;
        // A projection batch takes the generation row before reading the
        // collection. The import finalizer deliberately takes the exact import
        // and collection locks first, then probes the generation with NOWAIT to
        // avoid inverting that order into a deadlock. Yield the whole lock set
        // and retry only that typed contention while the request still has a
        // bounded budget.
        // Keep this well inside the provider client's 15-second request
        // deadline; longer generation work is resumed by the exact-ID client
        // handoff below the public authority operation.
        let retry_deadline = Instant::now() + Duration::from_secs(2);
        let mut retry_delay = Duration::from_millis(10);
        loop {
            // This timeout owns the entire subordinate future: pool acquire,
            // transaction locks, key/contract awaits, and commit. Elapsing
            // drops the future and transaction synchronously, so no detached
            // database or key work survives the absolute deadline.
            let outcome = match tokio::time::timeout_at(
                tokio::time::Instant::from_std(retry_deadline),
                self.complete_authority_import_second_phase(
                    import_id,
                    collection_id,
                    manifest_digest,
                    source_revision,
                    expected_generation_id,
                    retry_deadline,
                ),
            )
            .await
            {
                Ok(outcome) => outcome,
                Err(_) => Err(projection_lease_unavailable()),
            };
            match outcome {
                Err(error)
                    if error.code == "projection_lease_unavailable"
                        && Instant::now() < retry_deadline =>
                {
                    // The subordinate transaction has returned and dropped all
                    // import/collection locks before this observable boundary.
                    #[cfg(feature = "test-hooks")]
                    crate::test_hooks::pause_authority_import(
                        import_id,
                        crate::test_hooks::AuthorityImportHookPoint::AfterProjectionLeaseUnavailable,
                    )
                    .await;
                    let remaining = retry_deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        return Err(error);
                    }
                    tokio::time::sleep(retry_delay.min(remaining)).await;
                    retry_delay = (retry_delay * 2).min(Duration::from_millis(200));
                }
                outcome => return outcome,
            }
        }
    }

    async fn complete_authority_import_second_phase(
        &self,
        import_id: Uuid,
        collection_id: Uuid,
        manifest_digest: &str,
        source_revision: &str,
        expected_generation_id: Option<Uuid>,
        retry_deadline: Instant,
    ) -> ApiResult<ProviderAuthorityImport> {
        let mut transaction = self.pool.begin().await?;
        let remaining = retry_deadline.saturating_duration_since(Instant::now());
        if remaining < Duration::from_millis(1) {
            return Err(projection_lease_unavailable());
        }
        // This is a subordinate budget inside the client's single 14-second
        // authority-operation deadline. Short lock waits avoid both busy-spin
        // and import/collection -> generation lock-order deadlocks.
        let lock_wait_ms = remaining.as_millis().min(100);
        sqlx::query("SELECT set_config('lock_timeout', $1, true)")
            .bind(format!("{lock_wait_ms}ms"))
            .execute(&mut *transaction)
            .await?;
        let row = match authority_import_row(&mut transaction, import_id).await {
            Ok(row) => row,
            Err(error) if exact_database_lock_timeout(&error) => {
                return Err(projection_lease_unavailable());
            }
            Err(error) => return Err(error),
        };
        let state: String = row.get("import_state");
        if state == "completed" {
            return self
                .completed_authority_import_receipt(
                    transaction,
                    &row,
                    collection_id,
                    manifest_digest,
                    source_revision,
                )
                .await;
        }
        let collection_state: String = row.get("collection_state");
        if state != "indexing"
            || row.get::<Uuid, _>("collection_id") != collection_id
            || row.get::<Option<String>, _>("manifest_digest").as_deref() != Some(manifest_digest)
            || row.get::<Option<String>, _>("source_revision").as_deref() != Some(source_revision)
            || !matches!(collection_state.as_str(), "indexing" | "active")
            || row.get::<i64, _>("collection_authority_epoch")
                != row.get::<i64, _>("next_authority_epoch")
        {
            return Err(ApiError::conflict(
                "authority_import_target_unavailable",
                "Authority import indexing state changed before completion.",
            ));
        }
        #[cfg(feature = "test-hooks")]
        crate::test_hooks::pause_authority_import(
            import_id,
            crate::test_hooks::AuthorityImportHookPoint::AfterCollectionBeforeGenerationLock,
        )
        .await;
        let generations = lock_authority_import_projection_generations(
            &mut transaction,
            &row,
            expected_generation_id,
        )
        .await?;
        if !locked_authority_import_projection_ready(&row, &generations) {
            if locked_authority_import_projection_building(
                &row,
                &generations,
                expected_generation_id,
            ) {
                let mut result = provider_authority_import(&row)?;
                result.contracts = authority_import_contracts(self, &row).await?;
                transaction.commit().await?;
                return Ok(result);
            }
            let terminal_error_code =
                locked_authority_import_terminal_error(&row, &generations, expected_generation_id);
            return Err(authority_import_projection_handoff_error(
                terminal_error_code.as_deref(),
            ));
        }
        let saved = sqlx::query(
            r#"UPDATE hosted_provider_authority_imports
               SET state = 'completed', completed_at = now()
               WHERE id = $1 AND state = 'indexing'
               RETURNING id, collection_id, next_authority_epoch, state,
                         manifest_digest, source_revision, source_head, expires_at"#,
        )
        .bind(import_id)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or_else(|| {
            ApiError::conflict(
                "authority_import_target_unavailable",
                "Authority import indexing state changed before completion.",
            )
        })?;
        let mut result = provider_authority_import(&saved)?;
        result.contracts = authority_import_contracts(self, &row).await?;
        transaction.commit().await?;
        Ok(result)
    }

    async fn completed_authority_import_receipt(
        &self,
        mut transaction: Transaction<'_, Postgres>,
        row: &PgRow,
        collection_id: Uuid,
        manifest_digest: &str,
        source_revision: &str,
    ) -> ApiResult<ProviderAuthorityImport> {
        #[cfg(feature = "test-hooks")]
        crate::test_hooks::pause_authority_import(
            row.get("id"),
            crate::test_hooks::AuthorityImportHookPoint::AfterCollectionBeforeGenerationLock,
        )
        .await;
        let active_generation_id = row.get("active_projection_generation_id");
        let generations = lock_authority_import_projection_generations(
            &mut transaction,
            row,
            active_generation_id,
        )
        .await?;
        if !locked_authority_import_projection_ready(row, &generations)
            || row.get::<Uuid, _>("collection_id") != collection_id
            || row.get::<Option<String>, _>("manifest_digest").as_deref() != Some(manifest_digest)
            || row.get::<Option<String>, _>("source_revision").as_deref() != Some(source_revision)
            || row.get::<String, _>("collection_state") != "active"
            || row.get::<i64, _>("collection_authority_epoch")
                != row.get::<i64, _>("next_authority_epoch")
        {
            return Err(ApiError::conflict(
                "authority_import_not_ready",
                "Completed authority import does not match this snapshot.",
            ));
        }
        let mut result = provider_authority_import(row)?;
        result.contracts = authority_import_contracts(self, row).await?;
        transaction.commit().await?;
        Ok(result)
    }

    pub(super) async fn finalize_indexed_authority_imports(&self, limit: u32) -> ApiResult<u64> {
        let mut finalized = 0_u64;
        let mut after = None;
        for _ in 0..limit.clamp(1, 100) {
            let mut transaction = self.pool.begin().await?;
            let candidate: Option<Uuid> = sqlx::query_scalar(
                r#"SELECT id
                   FROM hosted_provider_authority_imports
                   WHERE state = 'indexing'
                     AND ($1::uuid IS NULL OR id > $1)
                   ORDER BY id
                   LIMIT 1
                   FOR UPDATE SKIP LOCKED"#,
            )
            .bind(after)
            .fetch_optional(&mut *transaction)
            .await?;
            let Some(import_id) = candidate else {
                transaction.commit().await?;
                break;
            };
            after = Some(import_id);
            #[cfg(feature = "test-hooks")]
            crate::test_hooks::pause_authority_import(
                import_id,
                crate::test_hooks::AuthorityImportHookPoint::BeforeRecoveryFinalizerLock,
            )
            .await;
            let row = authority_import_row(&mut transaction, import_id).await?;
            #[cfg(feature = "test-hooks")]
            crate::test_hooks::pause_authority_import(
                import_id,
                crate::test_hooks::AuthorityImportHookPoint::AfterCollectionBeforeGenerationLock,
            )
            .await;
            let active_generation_id = row.get("active_projection_generation_id");
            let generations = lock_authority_import_projection_generations(
                &mut transaction,
                &row,
                active_generation_id,
            )
            .await?;
            if row.get::<String, _>("import_state") == "indexing"
                && row.get::<i64, _>("collection_authority_epoch")
                    == row.get::<i64, _>("next_authority_epoch")
                && locked_authority_import_projection_ready(&row, &generations)
            {
                let completed = sqlx::query(
                    r#"UPDATE hosted_provider_authority_imports
                       SET state = 'completed', completed_at = now()
                       WHERE id = $1 AND state = 'indexing'"#,
                )
                .bind(import_id)
                .execute(&mut *transaction)
                .await?;
                finalized += completed.rows_affected();
            }
            transaction.commit().await?;
        }
        Ok(finalized)
    }
}

fn projection_lease_unavailable() -> ApiError {
    ApiError::conflict(
        "projection_lease_unavailable",
        "The projection generation lease is unavailable or fenced.",
    )
}

fn exact_database_lock_timeout(error: &ApiError) -> bool {
    error.code == "provider_database_timeout"
        && error
            .details
            .as_ref()
            .and_then(|details| details.get("timeout_class"))
            .and_then(Value::as_str)
            == Some("lock")
}

async fn lock_authority_import_projection_generations(
    transaction: &mut Transaction<'_, Postgres>,
    row: &PgRow,
    expected_generation_id: Option<Uuid>,
) -> ApiResult<Vec<PgRow>> {
    let mut generation_ids = vec![
        row.get::<Option<Uuid>, _>("active_projection_generation_id"),
        expected_generation_id,
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>();
    generation_ids.sort_unstable();
    generation_ids.dedup();
    if generation_ids.is_empty() {
        return Ok(Vec::new());
    }
    sqlx::query(
        r#"SELECT collection_id, generation_id, status, source_head,
                  source_resource_revision, projection_format_version,
                  semantic_engine_version, integrity_epoch,
                  integrity_verified_epoch, last_error_code
           FROM hosted_provider_projection_generations
           WHERE collection_id = $1 AND generation_id = ANY($2)
           ORDER BY generation_id
           FOR UPDATE NOWAIT"#,
    )
    .bind(row.get::<Uuid, _>("collection_id"))
    .bind(&generation_ids)
    .fetch_all(&mut **transaction)
    .await
    .map_err(|error| match &error {
        sqlx::Error::Database(database) if database.code().as_deref() == Some("55P03") => {
            ApiError::conflict(
                "projection_lease_unavailable",
                "The projection generation lease is unavailable or fenced.",
            )
        }
        _ => ApiError::from(error),
    })
}

fn locked_generation(generations: &[PgRow], generation_id: Uuid) -> Option<&PgRow> {
    generations
        .iter()
        .find(|generation| generation.get::<Uuid, _>("generation_id") == generation_id)
}

fn locked_authority_import_projection_ready(row: &PgRow, generations: &[PgRow]) -> bool {
    let Some(active_generation_id) = row.get::<Option<Uuid>, _>("active_projection_generation_id")
    else {
        return false;
    };
    let Some(generation) = locked_generation(generations, active_generation_id) else {
        return false;
    };
    let current_format = i64::from(mdbase::runtime::SEMANTIC_PROJECTION_FORMAT_VERSION);
    row.get::<String, _>("collection_state") == "active"
        && generation.get::<Uuid, _>("collection_id") == row.get::<Uuid, _>("collection_id")
        && generation.get::<String, _>("status") == "complete"
        && row.get::<Option<i64>, _>("active_projection_head")
            == Some(row.get::<i64, _>("collection_head"))
        && generation.get::<i64, _>("source_head") <= row.get::<i64, _>("active_projection_head")
        && generation.get::<String, _>("source_resource_revision")
            == row.get::<String, _>("collection_resource_revision")
        && i64::from(generation.get::<i32, _>("projection_format_version")) == current_format
        && row.get::<Option<i32>, _>("collection_projection_format_version")
            == Some(generation.get::<i32, _>("projection_format_version"))
        && generation.get::<String, _>("semantic_engine_version") == mdbase::VERSION
        && row.get::<Option<String>, _>("collection_projection_engine_version")
            == Some(generation.get::<String, _>("semantic_engine_version"))
        && generation.get::<i64, _>("integrity_epoch")
            == generation.get::<i64, _>("integrity_verified_epoch")
}

fn locked_authority_import_projection_building(
    row: &PgRow,
    generations: &[PgRow],
    expected_generation_id: Option<Uuid>,
) -> bool {
    let Some(generation_id) = expected_generation_id else {
        return false;
    };
    let Some(generation) = locked_generation(generations, generation_id) else {
        return false;
    };
    generation.get::<Uuid, _>("collection_id") == row.get::<Uuid, _>("collection_id")
        && generation.get::<String, _>("status") == "building"
        && generation.get::<i64, _>("source_head") == row.get::<i64, _>("collection_head")
        && generation.get::<String, _>("source_resource_revision")
            == row.get::<String, _>("collection_resource_revision")
        && i64::from(generation.get::<i32, _>("projection_format_version"))
            == i64::from(mdbase::runtime::SEMANTIC_PROJECTION_FORMAT_VERSION)
        && generation.get::<String, _>("semantic_engine_version") == mdbase::VERSION
        && generation.get::<i64, _>("integrity_verified_epoch")
            <= generation.get::<i64, _>("integrity_epoch")
}

fn locked_authority_import_terminal_error(
    row: &PgRow,
    generations: &[PgRow],
    expected_generation_id: Option<Uuid>,
) -> Option<String> {
    let generation = locked_generation(generations, expected_generation_id?)?;
    (generation.get::<Uuid, _>("collection_id") == row.get::<Uuid, _>("collection_id")
        && generation.get::<String, _>("status") == "abandoned"
        && generation.get::<i64, _>("source_head") == row.get::<i64, _>("collection_head")
        && generation.get::<String, _>("source_resource_revision")
            == row.get::<String, _>("collection_resource_revision")
        && i64::from(generation.get::<i32, _>("projection_format_version"))
            == i64::from(mdbase::runtime::SEMANTIC_PROJECTION_FORMAT_VERSION)
        && generation.get::<String, _>("semantic_engine_version") == mdbase::VERSION
        && generation.get::<i64, _>("integrity_verified_epoch")
            <= generation.get::<i64, _>("integrity_epoch"))
    .then(|| generation.get::<Option<String>, _>("last_error_code"))
    .flatten()
}

fn authority_import_projection_handoff_error(terminal_error_code: Option<&str>) -> ApiError {
    match terminal_error_code {
        Some("projection_authority_invalid") => ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "projection_authority_invalid",
            "The exact projection authority is invalid.",
        ),
        Some("projection_semantic_failure") => ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "projection_semantic_failure",
            "The exact authority could not produce a canonical semantic projection.",
        ),
        Some("projection_state_invalid") => ApiError::conflict(
            "projection_state_invalid",
            "The projection generation entered an invalid terminal state.",
        ),
        Some("projection_record_too_large") => ApiError::quota(
            "projection_record_too_large",
            "One exact record cannot fit the bounded projection rebuild window.",
        ),
        _ => ApiError::conflict(
            "projection_generation_not_building",
            "The requested projection generation is not the current building generation.",
        ),
    }
}
