use super::mutation_journal::HostedMutationLease;
use super::operation_reads::compile_point_catalog;
use super::projections::invalidate_projection_catalog_binding;
use super::*;

impl HostedProvider {
    pub(super) async fn write_hosted_resource_mutation(
        &self,
        collection_id: Uuid,
        operation: &str,
        input: Value,
        mutation_lease: Option<&HostedMutationLease>,
        commit_replica: Option<&Replica>,
    ) -> ApiResult<Value> {
        let mut transaction = self.pool.begin().await?;
        if let Some(replica) = commit_replica {
            reauthorize_full_collection_mutation_in(
                &mut transaction,
                collection_id,
                replica,
                operation,
            )
            .await?;
        }
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
                "The resource document exceeds the hosted document size limit.",
            ));
        }
        let data_key = self
            .collection_key(collection_id, collection.get("wrapped_data_key"))
            .await?;
        let mut resources: SyncCollectionResources = self.crypto.decrypt_json(
            &data_key,
            collection.get("resources_ciphertext"),
            &resources_aad(collection_id),
        )?;
        let resource_documents = load_hosted_resource_documents(
            &mut transaction,
            &self.crypto,
            &data_key,
            collection_id,
        )
        .await?;
        let exact_documents = resource_documents
            .iter()
            .map(|resource| (resource.path.clone(), resource.document.clone()))
            .collect::<Vec<_>>();
        let catalog = compile_point_catalog(resources.clone(), exact_documents)?;
        let plan = catalog
            .plan_hosted_resource_mutation(operation, &input, &resource_documents)
            .map_err(|error| {
                if error.code.contains("budget_exceeded") {
                    ApiError::quota(error.code, error.message)
                } else {
                    ApiError::internal(format!(
                        "Canonical hosted resource mutation failed ({}): {}",
                        error.code, error.message
                    ))
                }
            })?;
        let result = serde_json::to_value(&plan.result).map_err(|error| {
            ApiError::internal(format!("Hosted operation could not serialize: {error}"))
        })?;
        if !plan.result.valid {
            transaction.commit().await?;
            return Ok(result);
        }

        let head = number(collection.get::<i64, _>("head"), "collection head")?
            .checked_add(1)
            .ok_or_else(|| ApiError::internal("The hosted collection sequence is exhausted."))?;
        let resource_revision = format!("hosted:1:{head}:resources");
        resources.revision = resource_revision.clone();
        resources.types = plan
            .types
            .iter()
            .map(hosted_type_descriptor)
            .collect::<ApiResult<Vec<_>>>()?;
        resources.contracts = plan
            .contracts
            .iter()
            .map(hosted_contract_descriptor)
            .collect();
        let resources_ciphertext =
            self.crypto
                .encrypt_json(&data_key, &resources, &resources_aad(collection_id))?;

        let paths = plan
            .documents
            .iter()
            .map(|resource| resource.path.clone())
            .collect::<Vec<_>>();
        sqlx::query(
            "DELETE FROM hosted_provider_resources WHERE collection_id = $1 AND NOT (path = ANY($2::text[]))",
        )
        .bind(collection_id)
        .bind(&paths)
        .execute(&mut *transaction)
        .await?;
        for resource in &plan.documents {
            let document_ciphertext = self.crypto.encrypt_bytes(
                &data_key,
                resource.document.as_bytes(),
                &resource_document_aad(collection_id, &resource.path),
            )?;
            sqlx::query(
                r#"INSERT INTO hosted_provider_resources
                     (collection_id, path, kind, revision, document_ciphertext)
                   VALUES ($1, $2, $3, $4, $5)
                   ON CONFLICT (collection_id, path) DO UPDATE SET
                     kind = EXCLUDED.kind, revision = EXCLUDED.revision,
                     document_ciphertext = EXCLUDED.document_ciphertext,
                     updated_at = now()"#,
            )
            .bind(collection_id)
            .bind(&resource.path)
            .bind(hosted_resource_kind(resource.kind))
            .bind(&resource.revision)
            .bind(document_ciphertext)
            .execute(&mut *transaction)
            .await?;
        }
        let path = result_string(&plan.result.result, "path")?;
        let is_type = matches!(operation, "create_type" | "update_type");
        let type_name = is_type
            .then(|| result_string(&plan.result.result, "name").map(str::to_string))
            .transpose()?;
        let event_revision = plan
            .result
            .result
            .get("revision")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("hosted:1:{head}:view-deleted"));
        sqlx::query(
            r#"INSERT INTO hosted_provider_resource_changes
                 (collection_id, sequence, resource_kind, type_name, path, revision)
               VALUES ($1, $2, $3, $4, $5, $6)"#,
        )
        .bind(collection_id)
        .bind(to_i64(head, "resource change sequence")?)
        .bind(if is_type { "type" } else { "view" })
        .bind(type_name)
        .bind(path)
        .bind(event_revision)
        .execute(&mut *transaction)
        .await?;
        if is_type {
            invalidate_projection_catalog_binding(&mut transaction, collection_id).await?;
        }
        sqlx::query(
            r#"UPDATE hosted_provider_collections
               SET head = $2,
                   retained_after = CASE WHEN $5 THEN $2 ELSE retained_after END,
                   resource_revision = $3, resources_ciphertext = $4, updated_at = now()
               WHERE id = $1"#,
        )
        .bind(collection_id)
        .bind(to_i64(head, "collection head")?)
        .bind(resource_revision)
        .bind(resources_ciphertext)
        .bind(is_type)
        .execute(&mut *transaction)
        .await?;
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
        self.remove_working_set(collection_id).await;
        if is_type {
            let provider = self.clone();
            tokio::spawn(async move {
                if let Err(error) = provider.recover_projection_generations(1).await {
                    tracing::warn!(
                        %collection_id,
                        error_code = %error.code,
                        "semantic projection rebuild recovery deferred"
                    );
                }
            });
        }
        Ok(result)
    }
}

pub(super) fn hosted_type_descriptor(
    resource: &mdbase::runtime::ResolvedTypeResource,
) -> ApiResult<CollectionTypeDescriptor> {
    let definition = resource.definition.as_object().ok_or_else(|| {
        ApiError::internal("A canonical hosted type definition is not an object.")
    })?;
    Ok(CollectionTypeDescriptor {
        name: definition
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        version: definition.get("version").and_then(Value::as_u64),
        description: definition
            .get("description")
            .and_then(Value::as_str)
            .map(str::to_string),
        revision: Some(resource.revision.clone()),
        path: Some(resource.path.clone()),
        definition: Some(resource.definition.clone()),
        schema: resource.schema.clone(),
        collection: definition.get("collection").cloned(),
        lifecycle: definition.get("lifecycle").cloned(),
        extensions: definition
            .iter()
            .filter(|(key, _)| key.starts_with("x-"))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect(),
    })
}

pub(super) fn hosted_contract_descriptor(
    contract: &mdbase::data_contracts::ResolvedRecordContract,
) -> CollectionContractDescriptor {
    CollectionContractDescriptor {
        contract_type: "record".to_string(),
        id: contract.id.clone(),
        version: contract.version.clone(),
        digest: contract.digest.clone(),
        schema: contract.record_schema.clone(),
        binding_schema: contract.binding_schema.clone(),
        implementations: contract
            .implementations
            .iter()
            .map(
                |implementation| CollectionContractImplementationDescriptor {
                    type_name: implementation.type_name.clone(),
                    type_version: implementation.type_version,
                    type_path: implementation.source_path.clone(),
                    digest: implementation.digest.clone(),
                    fields: implementation.fields.clone(),
                    binding: implementation.binding.clone(),
                },
            )
            .collect(),
    }
}

fn hosted_resource_kind(kind: mdbase::runtime::HostedResourceKind) -> &'static str {
    match kind {
        mdbase::runtime::HostedResourceKind::Configuration => "configuration",
        mdbase::runtime::HostedResourceKind::Lock => "lock",
        mdbase::runtime::HostedResourceKind::Contract => "contract",
        mdbase::runtime::HostedResourceKind::Schema => "schema",
        mdbase::runtime::HostedResourceKind::Type => "type",
        mdbase::runtime::HostedResourceKind::View => "view",
    }
}
