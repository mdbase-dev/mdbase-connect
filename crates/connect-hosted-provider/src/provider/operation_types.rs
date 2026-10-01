use super::mutation_journal::HostedMutationLease;
use super::mutations::classify_exact_sync_record;
use super::operation_reads::compile_point_catalog;
use super::operation_resource_mutations::{hosted_contract_descriptor, hosted_type_descriptor};
use super::projections::invalidate_projection_catalog_binding;
use super::*;

#[derive(Clone, Copy)]
enum DefinitionMutation<'a> {
    TypePack(&'a ApplyTypePackInput),
    CollectionSetup(&'a ApplyCollectionSetupInput),
}

impl HostedProvider {
    pub(super) async fn write_type_pack_apply_operation(
        &self,
        collection_id: Uuid,
        input: &ApplyTypePackInput,
        mutation_lease: Option<&HostedMutationLease>,
        commit_replica: Option<&Replica>,
    ) -> ApiResult<Value> {
        self.write_definition_mutation(
            collection_id,
            DefinitionMutation::TypePack(input),
            mutation_lease,
            commit_replica.map(|replica| (replica, "apply_type_pack")),
        )
        .await
    }

    pub(super) async fn write_collection_setup_apply_operation(
        &self,
        collection_id: Uuid,
        input: &ApplyCollectionSetupInput,
        mutation_lease: Option<&HostedMutationLease>,
        commit_replica: Option<&Replica>,
    ) -> ApiResult<Value> {
        self.write_definition_mutation(
            collection_id,
            DefinitionMutation::CollectionSetup(input),
            mutation_lease,
            commit_replica.map(|replica| (replica, "apply_collection_setup")),
        )
        .await
    }

    async fn write_definition_mutation(
        &self,
        collection_id: Uuid,
        input: DefinitionMutation<'_>,
        mutation_lease: Option<&HostedMutationLease>,
        commit_authorization: Option<(&Replica, &str)>,
    ) -> ApiResult<Value> {
        let mut transaction = self.pool.begin().await?;
        if let Some((replica, operation)) = commit_authorization {
            reauthorize_full_collection_mutation_in(
                &mut transaction,
                collection_id,
                replica,
                operation,
            )
            .await?;
        }
        // Definitions change the catalog/head, never the collection's key.
        // Keep writers serialized without blocking projection INSERTs' implicit
        // FK KEY SHARE lock: a batch already holds its generation row, which
        // catalog invalidation below needs before this transaction can commit.
        let collection = sqlx::query(
            r#"SELECT head, wrapped_data_key, resources_ciphertext, max_document_bytes
               FROM hosted_provider_collections
               WHERE id = $1 AND state = 'active' FOR NO KEY UPDATE"#,
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
        let head = number(collection.get::<i64, _>("head"), "collection head")?;
        let max_document_bytes = number(
            collection.get::<i64, _>("max_document_bytes"),
            "maximum document size",
        )?;
        let oversized_resource = match input {
            DefinitionMutation::TypePack(input) => input
                .provision
                .resources
                .iter()
                .any(|resource| resource.document.len() as u64 > max_document_bytes),
            DefinitionMutation::CollectionSetup(input) => input
                .setup
                .provisions
                .type_packs
                .iter()
                .flat_map(|provision| provision.resources.iter())
                .any(|resource| resource.document.len() as u64 > max_document_bytes),
        };
        if oversized_resource {
            return Err(ApiError::bad_request(
                "document_quota_exceeded",
                "A type pack resource exceeds the hosted document size limit.",
            ));
        }
        let data_key = self
            .collection_key(collection_id, collection.get("wrapped_data_key"))
            .await?;
        let result = self
            .prepare_candidate_b_definition_mutation(
                &mut transaction,
                collection_id,
                &collection,
                head,
                max_document_bytes,
                &data_key,
                input,
                mutation_lease,
            )
            .await?;
        transaction.commit().await?;
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
        Ok(result)
    }

    #[allow(clippy::too_many_arguments)]
    async fn prepare_candidate_b_definition_mutation(
        &self,
        transaction: &mut Transaction<'_, Postgres>,
        collection_id: Uuid,
        collection: &PgRow,
        mut head: u64,
        max_document_bytes: u64,
        data_key: &[u8; 32],
        input: DefinitionMutation<'_>,
        mutation_lease: Option<&HostedMutationLease>,
    ) -> ApiResult<Value> {
        let resources: SyncCollectionResources = self.crypto.decrypt_json(
            data_key,
            collection.get("resources_ciphertext"),
            &resources_aad(collection_id),
        )?;
        let resource_documents =
            load_resource_documents(transaction, &self.crypto, data_key, collection_id).await?;
        let catalog = compile_point_catalog(resources.clone(), resource_documents.clone())?;
        let plan = match input {
            DefinitionMutation::TypePack(input) => {
                let provision = engine_type_pack_provision(&input.provision)?;
                let options = mdbase::v03::TypePackApplyOptions {
                    installed_by: input.installed_by.clone(),
                    expected_assessment_digest: input.expected_assessment_digest.clone(),
                    allow_downgrade: input.allow_downgrade,
                    adopt_resources: input.adopt_resources.clone(),
                    preserve_seed_targets: input.preserve_seed_targets.clone(),
                    target_overrides: input.target_overrides.clone(),
                    contract_setups: input
                        .contract_setups
                        .iter()
                        .map(engine_contract_setup)
                        .collect(),
                };
                catalog.plan_hosted_definition_operation_typed(
                    HostedDefinitionOperation::ApplyTypePack {
                        provision: &provision,
                        options: &options,
                    },
                    &resource_documents,
                )
            }
            DefinitionMutation::CollectionSetup(input) => {
                let setup = engine_collection_setup(&input.setup)?;
                let options = mdbase::v03::CollectionSetupApplyOptions {
                    expected_assessment_digest: input.expected_assessment_digest.clone(),
                    expected_collection_revision: input.expected_collection_revision.clone(),
                    expected_provision_digest: input.expected_provision_digest.clone(),
                    allow_type_pack_downgrades: input.allow_type_pack_downgrades.clone(),
                };
                catalog.plan_hosted_definition_operation_typed(
                    HostedDefinitionOperation::ApplyCollectionSetup {
                        setup: &setup,
                        options: &options,
                    },
                    &resource_documents,
                )
            }
        }
        .map_err(|error| {
            if error.code.contains("budget_exceeded") {
                ApiError::quota(error.code, error.message)
            } else {
                ApiError::internal(format!(
                    "Canonical hosted definition mutation failed ({}): {}",
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
            "definition mutation",
        )?;
        let envelope = plan.operation.to_v03();
        if !plan.operation.is_valid() {
            return serde_json::to_value(envelope).map_err(|error| {
                ApiError::internal(format!("Hosted definition could not serialize: {error}"))
            });
        }
        let changed_resources = plan.changes;
        let documents = plan.documents.into_iter().collect::<BTreeMap<_, _>>();
        if changed_resources.iter().any(|resource| {
            resource.after_revision.is_some()
                && documents
                    .get(&resource.path.to_string())
                    .is_some_and(|document| document.len() as u64 > max_document_bytes)
        }) {
            return Err(ApiError::bad_request(
                "document_quota_exceeded",
                "A contract setup resource exceeds the hosted document size limit.",
            ));
        }
        if changed_resources.is_empty() {
            return serde_json::to_value(envelope).map_err(|error| {
                ApiError::internal(format!("Hosted definition could not serialize: {error}"))
            });
        }

        let configuration_changed = changed_resources
            .iter()
            .any(|resource| resource.kind == mdbase::runtime::ResourceChangeKind::Configuration);
        let deleted_paths = changed_resources
            .iter()
            .filter(|resource| resource.after_revision.is_none())
            .map(|resource| resource.path.to_string())
            .collect::<std::collections::BTreeSet<_>>();
        for resource in changed_resources {
            let target = resource.path.to_string();
            let kind = match resource.kind {
                mdbase::runtime::ResourceChangeKind::Configuration => "configuration",
                mdbase::runtime::ResourceChangeKind::TypeDefinition => "type",
                mdbase::runtime::ResourceChangeKind::Contract => "contract",
                mdbase::runtime::ResourceChangeKind::ViewSource => "view",
                mdbase::runtime::ResourceChangeKind::File => {
                    if matches!(
                        target.as_str(),
                        "mdbase.lock.yaml" | "mdbase.provisions.yaml"
                    ) {
                        "lock"
                    } else {
                        "schema"
                    }
                }
                mdbase::runtime::ResourceChangeKind::Other => "other",
            };
            head = head.checked_add(1).ok_or_else(|| {
                ApiError::internal("The hosted collection sequence is exhausted.")
            })?;
            let revision = if resource.after_revision.is_none() {
                sqlx::query(
                    "DELETE FROM hosted_provider_resources WHERE collection_id = $1 AND path = $2",
                )
                .bind(collection_id)
                .bind(&target)
                .execute(&mut **transaction)
                .await?;
                resource
                    .before_revision
                    .as_ref()
                    .map(ToString::to_string)
                    .unwrap_or_else(|| "deleted".to_string())
            } else {
                let document = documents.get(&target).ok_or_else(|| {
                    ApiError::internal(format!(
                        "Canonical definition plan omitted changed resource '{target}'."
                    ))
                })?;
                let revision = resource
                    .after_revision
                    .as_ref()
                    .map(ToString::to_string)
                    .ok_or_else(|| {
                        ApiError::internal("Canonical resource change omitted its revision.")
                    })?;
                let ciphertext = self.crypto.encrypt_bytes(
                    data_key,
                    document.as_bytes(),
                    &resource_document_aad(collection_id, &target),
                )?;
                sqlx::query(
                    r#"INSERT INTO hosted_provider_resources
                         (collection_id, path, kind, revision, document_ciphertext)
                       VALUES ($1, $2, $3, $4, $5)
                       ON CONFLICT (collection_id, path) DO UPDATE SET
                         kind = EXCLUDED.kind,
                         revision = EXCLUDED.revision,
                         document_ciphertext = EXCLUDED.document_ciphertext,
                         updated_at = now()"#,
                )
                .bind(collection_id)
                .bind(&target)
                .bind(kind)
                .bind(&revision)
                .bind(ciphertext)
                .execute(&mut **transaction)
                .await?;
                revision
            };
            let type_name = (kind == "type").then(|| {
                target
                    .rsplit('/')
                    .next()
                    .unwrap_or(&target)
                    .strip_suffix(".md")
                    .unwrap_or(&target)
                    .to_string()
            });
            if kind != "lock" {
                sqlx::query(
                    r#"INSERT INTO hosted_provider_resource_changes
                         (collection_id, sequence, resource_kind, type_name, path, revision)
                       VALUES ($1, $2, $3, $4, $5, $6)"#,
                )
                .bind(collection_id)
                .bind(to_i64(head, "resource change sequence")?)
                .bind(kind)
                .bind(type_name)
                .bind(&target)
                .bind(&revision)
                .execute(&mut **transaction)
                .await?;
            }
        }

        let mut next_resources = resources;
        next_resources.types = plan
            .types
            .iter()
            .map(hosted_type_descriptor)
            .collect::<ApiResult<_>>()?;
        next_resources.contracts = plan
            .contracts
            .iter()
            .map(hosted_contract_descriptor)
            .collect();
        if configuration_changed {
            let mut next_documents = resource_documents
                .into_iter()
                .filter(|(path, _)| !deleted_paths.contains(path))
                .collect::<BTreeMap<_, _>>();
            next_documents.extend(documents);
            let catalog = compile_point_catalog(
                next_resources.clone(),
                next_documents.into_iter().collect(),
            )?;
            self.convert_view_resources_to_records(
                transaction,
                collection_id,
                data_key,
                &catalog,
                &mut head,
            )
            .await?;
        }
        let resource_revision = format!("hosted:1:{head}:resources");
        next_resources.revision = resource_revision.clone();
        let resources_ciphertext =
            self.crypto
                .encrypt_json(data_key, &next_resources, &resources_aad(collection_id))?;
        invalidate_projection_catalog_binding(transaction, collection_id).await?;
        sqlx::query(
            r#"UPDATE hosted_provider_collections
               SET head = $2, retained_after = $2, resource_revision = $3,
                   resources_ciphertext = $4, updated_at = now()
               WHERE id = $1"#,
        )
        .bind(collection_id)
        .bind(to_i64(head, "collection head")?)
        .bind(resource_revision)
        .bind(resources_ciphertext)
        .execute(&mut **transaction)
        .await?;
        let result = serde_json::to_value(envelope).map_err(|error| {
            ApiError::internal(format!("Hosted definition could not serialize: {error}"))
        })?;
        if let Some(lease) = mutation_lease {
            self.mark_operation_mutation_applied_in(
                transaction,
                data_key,
                lease,
                &Ok(result.clone()),
            )
            .await?;
        }
        Ok(result)
    }

    /// A Base stored as a view resource becomes a record once the collection's
    /// configuration makes its extension a record extension, which only
    /// reviewed collection setup changes. Local collections read the same file
    /// as a record, so hosted storage follows.
    async fn convert_view_resources_to_records(
        &self,
        transaction: &mut Transaction<'_, Postgres>,
        collection_id: Uuid,
        data_key: &[u8; 32],
        catalog: &mdbase::runtime::CompiledCatalog,
        head: &mut u64,
    ) -> ApiResult<()> {
        let views = sqlx::query(
            r#"SELECT path, revision, document_ciphertext
               FROM hosted_provider_resources
               WHERE collection_id = $1 AND kind = 'view'
               ORDER BY path"#,
        )
        .bind(collection_id)
        .fetch_all(&mut **transaction)
        .await?;
        let (mut added_records, mut added_bytes) = (0_u64, 0_u64);
        for view in views {
            let path: String = view.get("path");
            let document = String::from_utf8(self.crypto.decrypt_bytes(
                data_key,
                view.get("document_ciphertext"),
                &resource_document_aad(collection_id, &path),
            )?)
            .map_err(|_| ApiError::internal("A hosted view resource is not UTF-8."))?;
            let record =
                match classify_exact_sync_record(Some(catalog), Uuid::now_v7(), &path, &document) {
                    Ok(record) => record,
                    // Still not a record under this configuration.
                    Err(error) if error.code == "invalid_path" => continue,
                    Err(error) => return Err(error),
                };
            *head = head.checked_add(2).ok_or_else(|| {
                ApiError::internal("The hosted collection sequence is exhausted.")
            })?;
            sqlx::query(
                "DELETE FROM hosted_provider_resources WHERE collection_id = $1 AND path = $2",
            )
            .bind(collection_id)
            .bind(&path)
            .execute(&mut **transaction)
            .await?;
            sqlx::query(
                r#"INSERT INTO hosted_provider_resource_changes
                     (collection_id, sequence, resource_kind, type_name, path, revision)
                   VALUES ($1, $2, 'view', NULL, $3, $4)"#,
            )
            .bind(collection_id)
            .bind(to_i64(*head - 1, "resource change sequence")?)
            .bind(&path)
            .bind(view.get::<String, _>("revision"))
            .execute(&mut **transaction)
            .await?;
            persist_live_record(
                transaction,
                &self.crypto,
                data_key,
                collection_id,
                *head,
                &record,
            )
            .await?;
            let after_ciphertext = self.crypto.encrypt_json(
                data_key,
                &record,
                &change_record_aad(collection_id, *head, "after"),
            )?;
            sqlx::query(
                r#"INSERT INTO hosted_provider_changes
                     (collection_id, sequence, record_id, before_types, after_types,
                      before_ciphertext, after_ciphertext, revision, source_replica_id)
                   VALUES ($1, $2, $3, '{}', $4, NULL, $5, $6, NULL)"#,
            )
            .bind(collection_id)
            .bind(to_i64(*head, "change sequence")?)
            .bind(record.record_id)
            .bind(&record.types)
            .bind(after_ciphertext)
            .bind(&record.revision)
            .execute(&mut **transaction)
            .await?;
            added_records += 1;
            added_bytes += record.document.len() as u64;
        }
        if added_records > 0 {
            sqlx::query(
                r#"UPDATE hosted_provider_collections
                   SET record_count = record_count + $2, content_bytes = content_bytes + $3
                   WHERE id = $1"#,
            )
            .bind(collection_id)
            .bind(to_i64(added_records, "record count")?)
            .bind(to_i64(added_bytes, "content size")?)
            .execute(&mut **transaction)
            .await?;
        }
        Ok(())
    }
}
