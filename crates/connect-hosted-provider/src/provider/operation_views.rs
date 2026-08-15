use super::mutation_journal::HostedMutationLease;
use super::*;

impl HostedProvider {
    pub(super) async fn write_view_source_operation(
        &self,
        collection_id: Uuid,
        operation: &str,
        input: Value,
        mutation_lease: Option<&HostedMutationLease>,
    ) -> ApiResult<Value> {
        let mut transaction = self.pool.begin().await?;
        let collection = sqlx::query(
            r#"SELECT head, wrapped_data_key, resources_ciphertext, max_document_bytes
               FROM hosted_provider_collections
               WHERE id = $1 AND state = 'active' FOR UPDATE"#,
        )
        .bind(collection_id)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or_else(|| {
            ApiError::not_found(
                "hosted_collection_not_found",
                "Hosted collection not found.",
            )
        })?;
        let mut head = number(collection.get::<i64, _>("head"), "collection head")?;
        let max_document_bytes = number(
            collection.get::<i64, _>("max_document_bytes"),
            "maximum document size",
        )?;
        if input
            .get("document")
            .and_then(Value::as_str)
            .is_some_and(|document| document.len() as u64 > max_document_bytes)
        {
            return Err(ApiError::bad_request(
                "document_quota_exceeded",
                "The saved-view source exceeds the hosted document size limit.",
            ));
        }
        let data_key = self
            .collection_key(collection_id, collection.get("wrapped_data_key"))
            .await?;
        let working_set = self.working_set(collection_id).await?;
        let mut cached = working_set.lock().await;
        if cached
            .as_ref()
            .is_none_or(|working_set| working_set.head != Some(head))
        {
            let resources =
                load_resource_documents(&mut transaction, &self.crypto, &data_key, collection_id)
                    .await?;
            let records =
                load_records(&mut transaction, &self.crypto, &data_key, collection_id).await?;
            let workspace = WorkingSet::materialize(
                resources,
                records.values().map(|record| StoredDocument {
                    record_id: record.record_id,
                    path: record.path.clone(),
                    document: record.document.clone(),
                }),
            )?;
            *cached = Some(CachedCollection::new(Some(head), workspace, records));
        }
        let cached = cached
            .as_mut()
            .expect("hosted working set was initialized above");
        let envelope = cached.workspace.view_source_operation(operation, &input)?;
        if !envelope.valid {
            transaction.commit().await?;
            return serde_json::to_value(envelope).map_err(|error| {
                ApiError::internal(format!("Hosted operation could not serialize: {error}"))
            });
        }
        cached.head = None;
        let path = result_string(&envelope.result, "path")?.to_string();
        head = head
            .checked_add(1)
            .ok_or_else(|| ApiError::internal("The hosted collection sequence is exhausted."))?;
        let event_revision = if operation == "delete_view_source" {
            sqlx::query(
                "DELETE FROM hosted_provider_resources WHERE collection_id = $1 AND path = $2 AND kind = 'view'",
            )
            .bind(collection_id)
            .bind(&path)
            .execute(&mut *transaction)
            .await?;
            format!("hosted:1:{head}:view-deleted")
        } else {
            let revision = result_string(&envelope.result, "revision")?.to_string();
            let document = cached.workspace.resource_document(&path)?;
            let document_ciphertext = self.crypto.encrypt_bytes(
                &data_key,
                document.as_bytes(),
                &resource_document_aad(collection_id, &path),
            )?;
            sqlx::query(
                r#"INSERT INTO hosted_provider_resources
                     (collection_id, path, kind, revision, document_ciphertext)
                   VALUES ($1, $2, 'view', $3, $4)
                   ON CONFLICT (collection_id, path) DO UPDATE SET
                     kind = 'view', revision = EXCLUDED.revision,
                     document_ciphertext = EXCLUDED.document_ciphertext,
                     updated_at = now()"#,
            )
            .bind(collection_id)
            .bind(&path)
            .bind(&revision)
            .bind(document_ciphertext)
            .execute(&mut *transaction)
            .await?;
            revision
        };

        let resource_revision = format!("hosted:1:{head}:resources");
        let mut resources: SyncCollectionResources = self.crypto.decrypt_json(
            &data_key,
            collection.get("resources_ciphertext"),
            &resources_aad(collection_id),
        )?;
        resources.revision = resource_revision.clone();
        let resources_ciphertext =
            self.crypto
                .encrypt_json(&data_key, &resources, &resources_aad(collection_id))?;
        sqlx::query(
            r#"INSERT INTO hosted_provider_resource_changes
                 (collection_id, sequence, resource_kind, type_name, path, revision)
               VALUES ($1, $2, 'view', NULL, $3, $4)"#,
        )
        .bind(collection_id)
        .bind(to_i64(head, "resource change sequence")?)
        .bind(&path)
        .bind(event_revision)
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            r#"UPDATE hosted_provider_collections
               SET head = $2, resource_revision = $3, resources_ciphertext = $4, updated_at = now()
               WHERE id = $1"#,
        )
        .bind(collection_id)
        .bind(to_i64(head, "collection head")?)
        .bind(resource_revision)
        .bind(resources_ciphertext)
        .execute(&mut *transaction)
        .await?;
        let result = serde_json::to_value(envelope).map_err(|error| {
            ApiError::internal(format!("Hosted operation could not serialize: {error}"))
        })?;
        if let Some(lease) = mutation_lease {
            self.mark_operation_mutation_applied_in(
                &mut transaction,
                &data_key,
                lease,
                &Ok(result.clone()),
            )
            .await?;
        }
        transaction.commit().await?;
        cached.head = Some(head);
        Ok(result)
    }
}
