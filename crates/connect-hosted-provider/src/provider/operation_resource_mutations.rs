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
            .plan_hosted_resource_mutation_typed(operation, &input, &resource_documents)
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
        verify_canonical_change_set(
            &plan.change_set,
            plan.changes
                .iter()
                .cloned()
                .map(mdbase::runtime::CanonicalChange::Resource)
                .collect(),
            "resource mutation",
        )?;
        let result = serde_json::to_value(plan.operation.to_v03()).map_err(|error| {
            ApiError::internal(format!("Hosted operation could not serialize: {error}"))
        })?;
        if !plan.operation.valid {
            transaction.commit().await?;
            return Ok(result);
        }

        let mut head = number(collection.get::<i64, _>("head"), "collection head")?;
        if plan.changes.is_empty() {
            return Err(ApiError::internal(
                "mdbase-rs accepted a resource mutation without exact change evidence.",
            ));
        }
        let resource_revision = format!(
            "hosted:1:{}:resources",
            head.checked_add(plan.changes.len() as u64)
                .ok_or_else(|| ApiError::internal(
                    "The hosted collection sequence is exhausted."
                ))?
        );
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
        let is_type = matches!(operation, "create_type" | "update_type");
        for change in &plan.changes {
            head = head.checked_add(1).ok_or_else(|| {
                ApiError::internal("The hosted collection sequence is exhausted.")
            })?;
            let path = change.path.to_string();
            let resource_kind = match change.kind {
                mdbase::runtime::ResourceChangeKind::TypeDefinition => "type",
                mdbase::runtime::ResourceChangeKind::ViewSource => "view",
                mdbase::runtime::ResourceChangeKind::Configuration => "configuration",
                mdbase::runtime::ResourceChangeKind::Contract => "contract",
                mdbase::runtime::ResourceChangeKind::File => "file",
                mdbase::runtime::ResourceChangeKind::Other => "other",
            };
            let type_name = (resource_kind == "type").then(|| {
                path.rsplit('/')
                    .next()
                    .unwrap_or(&path)
                    .strip_suffix(".md")
                    .unwrap_or(&path)
                    .to_string()
            });
            let event_revision = change
                .after_revision
                .as_ref()
                .or(change.before_revision.as_ref())
                .map(ToString::to_string)
                .unwrap_or_else(|| "deleted".to_string());
            sqlx::query(
                r#"INSERT INTO hosted_provider_resource_changes
                     (collection_id, sequence, resource_kind, type_name, path, revision)
                   VALUES ($1, $2, $3, $4, $5, $6)"#,
            )
            .bind(collection_id)
            .bind(to_i64(head, "resource change sequence")?)
            .bind(resource_kind)
            .bind(type_name)
            .bind(path)
            .bind(event_revision)
            .execute(&mut *transaction)
            .await?;
        }
        // Every resource mutation advances `resource_revision`, and a generation
        // is current only while its `source_resource_revision` still matches.
        //
        // A type mutation changes the semantic catalog, so its projections are
        // genuinely superseded and the binding is invalidated for rebuild.
        //
        // A view mutation does not: an Obsidian Base source is a query
        // definition, and no projected fact is derived from it. Previously the
        // revision advanced while the generation kept the old value, leaving the
        // collection permanently stale with no rebuild scheduled -- which failed
        // readiness forever. Carry the generation forward instead. Invalidating
        // here would be worse than the bug: it drops a large collection into
        // canonical exact fallback and its Base queries start returning
        // `hosted_exact_document_budget_exceeded` until the rebuild completes.
        if is_type {
            invalidate_projection_catalog_binding(&mut transaction, collection_id).await?;
        } else {
            sqlx::query(
                r#"UPDATE hosted_provider_projection_generations generation
                   SET source_resource_revision = $2, updated_at = now()
                   FROM hosted_provider_collections collection
                   WHERE collection.id = $1
                     AND generation.collection_id = collection.id
                     AND generation.generation_id
                           = collection.active_projection_generation_id"#,
            )
            .bind(collection_id)
            .bind(&resource_revision)
            .execute(&mut *transaction)
            .await?;
        }
        sqlx::query(
            r#"UPDATE hosted_provider_collections
               SET head = $2,
                   active_projection_head = CASE
                     WHEN active_projection_generation_id IS NULL THEN NULL
                     ELSE $2
                   END,
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
