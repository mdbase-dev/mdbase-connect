use super::*;

impl HostedProvider {
    pub async fn collection_usage(
        &self,
        collection_id: Uuid,
    ) -> ApiResult<ProviderCollectionUsage> {
        let row = sqlx::query(
            r#"SELECT record_count, content_bytes, max_records,
                      max_content_bytes, max_document_bytes
               FROM hosted_provider_collections
               WHERE id = $1 AND state <> 'deleting'"#,
        )
        .bind(collection_id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| {
            ApiError::not_found(
                "hosted_collection_not_found",
                "Hosted collection not found.",
            )
        })?;
        Ok(ProviderCollectionUsage {
            collection_id,
            record_count: number(row.get::<i64, _>("record_count"), "record count")?,
            content_bytes: number(row.get::<i64, _>("content_bytes"), "content size")?,
            max_records: number(row.get::<i64, _>("max_records"), "record quota")?,
            max_content_bytes: number(row.get::<i64, _>("max_content_bytes"), "content quota")?,
            max_document_bytes: number(row.get::<i64, _>("max_document_bytes"), "document quota")?,
        })
    }

    pub async fn create_collection(
        &self,
        collection_id: Uuid,
        template_name: &str,
        display_name: &str,
    ) -> ApiResult<ProviderCollection> {
        let display_name = display_name.trim();
        if display_name.is_empty() || display_name.chars().count() > 200 {
            return Err(ApiError::bad_request(
                "invalid_collection_name",
                "Hosted collection names must contain between 1 and 200 characters.",
            ));
        }
        let (resources, documents) = template::resources(template_name)?;
        let data_key = self.crypto.generate_data_key();
        let wrapped_data_key = self
            .crypto
            .wrap_data_key(&data_key, &collection_key_aad(collection_id))?;
        let resources_ciphertext =
            self.crypto
                .encrypt_json(&data_key, &resources, &resources_aad(collection_id))?;
        let mut transaction = self.pool.begin().await?;
        let inserted = sqlx::query(
            r#"INSERT INTO hosted_provider_collections
                 (id, template, display_name, spec_version, resource_revision, wrapped_data_key,
                  resources_ciphertext, max_records, max_content_bytes,
                  max_document_bytes, max_replicas, max_files, max_file_bytes,
                  max_stored_file_bytes, max_single_file_bytes)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                       $13, $14, $15)
               ON CONFLICT (id) DO NOTHING"#,
        )
        .bind(collection_id)
        .bind(template_name)
        .bind(display_name)
        .bind(&resources.spec_version)
        .bind(&resources.revision)
        .bind(wrapped_data_key)
        .bind(resources_ciphertext)
        .bind(to_i64(
            self.limits.max_records_per_collection,
            "record quota",
        )?)
        .bind(to_i64(
            self.limits.max_bytes_per_collection,
            "collection byte quota",
        )?)
        .bind(to_i64(
            self.limits.max_bytes_per_document,
            "document byte quota",
        )?)
        .bind(to_i64(
            self.limits.max_replicas_per_collection,
            "replica quota",
        )?)
        .bind(to_i64(self.limits.max_files_per_collection, "file quota")?)
        .bind(to_i64(
            self.limits.max_file_bytes_per_collection,
            "current file byte quota",
        )?)
        .bind(to_i64(
            self.limits.max_stored_file_bytes_per_collection,
            "stored file byte quota",
        )?)
        .bind(to_i64(
            self.limits.max_bytes_per_file,
            "single file byte quota",
        )?)
        .execute(&mut *transaction)
        .await?;
        if inserted.rows_affected() == 0 {
            let existing = sqlx::query(
                "SELECT template, display_name, spec_version, resource_revision FROM hosted_provider_collections WHERE id = $1",
            )
            .bind(collection_id)
            .fetch_one(&mut *transaction)
            .await?;
            let existing_template: String = existing.get("template");
            if existing_template != template_name
                || existing.get::<String, _>("display_name") != display_name
            {
                return Err(ApiError::conflict(
                    "hosted_collection_conflict",
                    "Hosted collection already exists with different metadata.",
                ));
            }
            let result = ProviderCollection {
                id: collection_id,
                display_name: existing.get("display_name"),
                spec_version: existing.get("spec_version"),
                resource_revision: existing.get("resource_revision"),
            };
            transaction.commit().await?;
            return Ok(result);
        }
        for document in documents {
            sqlx::query(
                r#"INSERT INTO hosted_provider_resources
                     (collection_id, path, kind, revision, document_ciphertext)
                   VALUES ($1, $2, $3, $4, $5)
                   ON CONFLICT (collection_id, path) DO NOTHING"#,
            )
            .bind(collection_id)
            .bind(document.path)
            .bind(document.kind)
            .bind(document.revision)
            .bind(self.crypto.encrypt_bytes(
                &data_key,
                document.document.as_bytes(),
                &resource_document_aad(collection_id, document.path),
            )?)
            .execute(&mut *transaction)
            .await?;
        }
        transaction.commit().await?;
        Ok(ProviderCollection {
            id: collection_id,
            display_name: display_name.to_string(),
            spec_version: resources.spec_version,
            resource_revision: resources.revision,
        })
    }

    pub async fn rename_collection(
        &self,
        collection_id: Uuid,
        display_name: &str,
    ) -> ApiResult<()> {
        let display_name = display_name.trim();
        if display_name.is_empty() || display_name.chars().count() > 200 {
            return Err(ApiError::bad_request(
                "invalid_collection_name",
                "Hosted collection names must contain between 1 and 200 characters.",
            ));
        }
        let result = sqlx::query(
            "UPDATE hosted_provider_collections SET display_name = $2, updated_at = now() WHERE id = $1 AND state = 'active'",
        )
        .bind(collection_id)
        .bind(display_name)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(ApiError::not_found(
                "hosted_collection_not_found",
                "Hosted collection not found.",
            ));
        }
        Ok(())
    }

    pub async fn delete_collection(&self, collection_id: Uuid) -> ApiResult<()> {
        let mut transaction = self.pool.begin().await?;
        sqlx::query("UPDATE hosted_provider_collections SET state = 'deleting' WHERE id = $1")
            .bind(collection_id)
            .execute(&mut *transaction)
            .await?;
        sqlx::query(
            r#"INSERT INTO hosted_provider_blob_deletions (object_key, byte_length, reason)
               SELECT object_key, max(size), 'collection_deletion'
               FROM hosted_provider_file_versions
               WHERE collection_id = $1 AND object_key IS NOT NULL
               GROUP BY object_key
               ON CONFLICT (object_key) DO NOTHING"#,
        )
        .bind(collection_id)
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            r#"INSERT INTO hosted_provider_blob_deletions (object_key, byte_length, reason)
               SELECT object_key, 0, 'collection_deletion'
               FROM (
                 SELECT staging_object_key AS object_key
                 FROM hosted_provider_file_transfers
                 WHERE collection_id = $1 AND staging_object_key IS NOT NULL
                 UNION
                 SELECT committed_object_key AS object_key
                 FROM hosted_provider_file_transfers
                 WHERE collection_id = $1
               ) objects
               ON CONFLICT (object_key) DO NOTHING"#,
        )
        .bind(collection_id)
        .execute(&mut *transaction)
        .await?;
        sqlx::query("DELETE FROM hosted_provider_collections WHERE id = $1")
            .bind(collection_id)
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
        self.working_sets.lock().await.remove(&collection_id);
        if let Err(error) = self.delete_pending_blobs(1_000).await {
            tracing::warn!(collection_id = %collection_id, %error, "deferred collection blob deletion failed");
        }
        Ok(())
    }
}
