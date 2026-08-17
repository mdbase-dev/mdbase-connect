use super::*;

impl HostedProvider {
    pub async fn prepare_authority_import(
        &self,
        input: PrepareAuthorityImport,
    ) -> ApiResult<ProviderAuthorityImport> {
        if input.token.len() < 32 {
            return Err(ApiError::bad_request(
                "invalid_authority_import",
                "Authority import credential is invalid.",
            ));
        }
        if input.authority_epoch <= 1 || !(60..=60 * 60).contains(&input.ttl_seconds) {
            return Err(ApiError::bad_request(
                "invalid_authority_import",
                "Authority import epoch or lifetime is invalid.",
            ));
        }
        // Expiry cascades delete abandoned import targets. Recover first so a
        // replacement target cannot be mistaken for the expired one.
        self.recover_expired_authority_imports().await?;
        let existing_state = sqlx::query_scalar::<_, String>(
            "SELECT state FROM hosted_provider_collections WHERE id = $1",
        )
        .bind(input.collection_id)
        .fetch_optional(&self.pool)
        .await?;
        if existing_state.is_none() {
            self.create_collection(
                input.account_id,
                input.collection_id,
                "mdbase",
                &input.display_name,
                "UTC",
            )
            .await?;
        } else if !matches!(
            existing_state.as_deref(),
            Some("active" | "importing" | "transferred")
        ) {
            return Err(ApiError::conflict(
                "authority_import_target_unavailable",
                "The target collection already has an active authority.",
            ));
        }
        let expires_at = Utc::now()
            + chrono::Duration::seconds(to_i64(input.ttl_seconds, "authority import lifetime")?);
        let requested_token_hash = token_hash(&input.token);
        let mut transaction = self.pool.begin().await?;
        if let Some(existing) = sqlx::query(
            r#"SELECT id, collection_id, token_hash, next_authority_epoch, state,
                      manifest_digest, source_revision, source_head, expires_at
               FROM hosted_provider_authority_imports WHERE id = $1 FOR UPDATE"#,
        )
        .bind(input.transfer_id)
        .fetch_optional(&mut *transaction)
        .await?
        {
            let exact = existing.get::<Uuid, _>("collection_id") == input.collection_id
                && existing.get::<i64, _>("next_authority_epoch")
                    == to_i64(input.authority_epoch, "authority epoch")?
                && authority_import_state(&existing, "state")?.accepts_upload();
            if !exact {
                return Err(ApiError::conflict(
                    "authority_import_conflict",
                    "Authority import already exists with different parameters.",
                ));
            }
            let rotated = sqlx::query(
                r#"UPDATE hosted_provider_authority_imports
                   SET token_hash = $2, expires_at = $3
                   WHERE id = $1
                   RETURNING id, collection_id, next_authority_epoch, state,
                             manifest_digest, source_revision, source_head, expires_at"#,
            )
            .bind(input.transfer_id)
            .bind(requested_token_hash)
            .bind(expires_at)
            .fetch_one(&mut *transaction)
            .await?;
            let result = provider_authority_import(&rotated)?;
            transaction.commit().await?;
            return Ok(result);
        }
        // A later epoch supersedes the completed import receipt for this
        // collection. Keeping only the current import preserves the useful
        // collection-level uniqueness without preventing round trips.
        sqlx::query(
            r#"DELETE FROM hosted_provider_authority_imports
               WHERE collection_id = $1 AND state = 'completed'
                 AND next_authority_epoch < $2"#,
        )
        .bind(input.collection_id)
        .bind(to_i64(input.authority_epoch, "authority epoch")?)
        .execute(&mut *transaction)
        .await?;
        let collection = sqlx::query(
            r#"UPDATE hosted_provider_collections
               SET state = 'importing', authority_epoch = $2,
                   display_name = $3, updated_at = now()
               WHERE id = $1 AND state = 'transferred'
               RETURNING id"#,
        )
        .bind(input.collection_id)
        .bind(to_i64(input.authority_epoch, "authority epoch")?)
        .bind(input.display_name.trim())
        .fetch_optional(&mut *transaction)
        .await?;
        let collection = if collection.is_some() {
            collection
        } else {
            sqlx::query(
                r#"UPDATE hosted_provider_collections
                   SET state = 'importing', authority_epoch = $2,
                       display_name = $3, updated_at = now()
                   WHERE id = $1 AND state = 'active' AND head = 0 AND record_count = 0
                   RETURNING id"#,
            )
            .bind(input.collection_id)
            .bind(to_i64(input.authority_epoch, "authority epoch")?)
            .bind(input.display_name.trim())
            .fetch_optional(&mut *transaction)
            .await?
        };
        if collection.is_none() {
            return Err(ApiError::conflict(
                "authority_import_target_unavailable",
                "The target collection cannot receive an authority import.",
            ));
        }
        let row = sqlx::query(
            r#"INSERT INTO hosted_provider_authority_imports
                 (id, collection_id, token_hash, next_authority_epoch,
                  restore_state, expires_at)
               VALUES ($1, $2, $3, $4, $5, $6)
               RETURNING id, collection_id, next_authority_epoch, state,
                         manifest_digest, source_revision, source_head, expires_at"#,
        )
        .bind(input.transfer_id)
        .bind(input.collection_id)
        .bind(requested_token_hash)
        .bind(to_i64(input.authority_epoch, "authority epoch")?)
        .bind(if existing_state.as_deref() == Some("transferred") {
            Some("transferred")
        } else {
            None
        })
        .bind(expires_at)
        .fetch_one(&mut *transaction)
        .await?;
        let result = provider_authority_import(&row)?;
        transaction.commit().await?;
        Ok(result)
    }
}
