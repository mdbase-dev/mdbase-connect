use super::*;

impl HostedProvider {
    pub(super) async fn describe_operation(
        &self,
        collection_id: Uuid,
        replica: &Replica,
    ) -> ApiResult<Value> {
        let row = sqlx::query(
            r#"SELECT head, display_name, wrapped_data_key, resources_ciphertext
               FROM hosted_provider_collections WHERE id = $1 AND state = 'active'"#,
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
        let data_key = self
            .collection_key(collection_id, row.get("wrapped_data_key"))
            .await?;
        let resources: SyncCollectionResources = self.crypto.decrypt_json(
            &data_key,
            row.get("resources_ciphertext"),
            &resources_aad(collection_id),
        )?;
        let resources = scoped_resources(resources, &replica.allowed_types);
        let description = CollectionDescription {
            protocol_version: CONTROL_PROTOCOL_VERSION,
            collection_id,
            display_name: row.get("display_name"),
            spec_version: resources.spec_version,
            operations: replica.allowed_operations.clone(),
            change_cursor: number(row.get::<i64, _>("head"), "collection head")?,
            types: resources.types,
            contracts: resources.contracts,
            configuration: None,
        };
        serde_json::to_value(description).map_err(|error| {
            ApiError::internal(format!("Hosted description could not serialize: {error}"))
        })
    }

    pub(super) async fn changes_operation(
        &self,
        collection_id: Uuid,
        replica: &Replica,
        input: &Value,
    ) -> ApiResult<Value> {
        let collection = sqlx::query(
            r#"SELECT head, retained_after, wrapped_data_key
               FROM hosted_provider_collections WHERE id = $1 AND state = 'active'"#,
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
        let head = number(collection.get::<i64, _>("head"), "collection head")?;
        let retained_after = number(
            collection.get::<i64, _>("retained_after"),
            "retained cursor",
        )?;
        let Some(after) = input.get("after").and_then(Value::as_u64) else {
            return serde_json::to_value(CollectionChangesPage {
                events: Vec::new(),
                cursor: head,
                has_more: false,
                reset: false,
            })
            .map_err(|error| {
                ApiError::internal(format!("Hosted changes could not serialize: {error}"))
            });
        };
        if after > head {
            return Err(ApiError::bad_request(
                "invalid_cursor",
                "Change cursor is ahead of the hosted collection.",
            ));
        }
        if after < retained_after {
            return serde_json::to_value(CollectionChangesPage {
                events: Vec::new(),
                cursor: head,
                has_more: false,
                reset: true,
            })
            .map_err(|error| {
                ApiError::internal(format!("Hosted changes could not serialize: {error}"))
            });
        }
        let limit = input
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(100)
            .clamp(1, 500);
        let record_rows = sqlx::query(
            r#"SELECT sequence, before_ciphertext, after_ciphertext, created_at::text AS occurred_at
               FROM hosted_provider_changes
               WHERE collection_id = $1 AND sequence > $2
                 AND (cardinality($3::text[]) = 0
                      OR before_types && $3::text[] OR after_types && $3::text[])
               ORDER BY sequence LIMIT $4"#,
        )
        .bind(collection_id)
        .bind(to_i64(after, "change cursor")?)
        .bind(&replica.allowed_types)
        .bind(to_i64(limit + 1, "change page limit")?)
        .fetch_all(&self.pool)
        .await?;
        let resource_rows = sqlx::query(
            r#"SELECT sequence, resource_kind, type_name, path, revision, created_at::text AS occurred_at
               FROM hosted_provider_resource_changes
               WHERE collection_id = $1 AND sequence > $2
                 AND (cardinality($3::text[]) = 0 OR type_name = ANY($3::text[]))
               ORDER BY sequence LIMIT $4"#,
        )
        .bind(collection_id)
        .bind(to_i64(after, "change cursor")?)
        .bind(&replica.allowed_types)
        .bind(to_i64(limit + 1, "change page limit")?)
        .fetch_all(&self.pool)
        .await?;
        let mut has_more =
            record_rows.len() > limit as usize || resource_rows.len() > limit as usize;
        let data_key = self
            .collection_key(collection_id, collection.get("wrapped_data_key"))
            .await?;
        let mut events = Vec::new();
        for row in record_rows {
            let sequence = number(row.get::<i64, _>("sequence"), "change sequence")?;
            let before = optional_encrypted_record(
                &self.crypto,
                &data_key,
                row.get("before_ciphertext"),
                &change_record_aad(collection_id, sequence, "before"),
            )?;
            let after_record = optional_encrypted_record(
                &self.crypto,
                &data_key,
                row.get("after_ciphertext"),
                &change_record_aad(collection_id, sequence, "after"),
            )?;
            if !before
                .as_ref()
                .is_some_and(|record| visible(record, &replica.allowed_types))
                && !after_record
                    .as_ref()
                    .is_some_and(|record| visible(record, &replica.allowed_types))
            {
                continue;
            }
            let (event_type, payload) = application_change(before.as_ref(), after_record.as_ref());
            events.push(CollectionChange {
                cursor: sequence,
                event_type: event_type.to_string(),
                occurred_at: row.get("occurred_at"),
                payload,
            });
        }
        for row in resource_rows {
            let kind: String = row.get("resource_kind");
            events.push(CollectionChange {
                cursor: number(row.get::<i64, _>("sequence"), "resource change sequence")?,
                event_type: if kind == "view" {
                    "mdbase.view_source.changed".to_string()
                } else {
                    "mdbase.type.changed".to_string()
                },
                occurred_at: row.get("occurred_at"),
                payload: json!({
                    "name": row.get::<Option<String>, _>("type_name"),
                    "path": row.get::<String, _>("path"),
                    "revision": row.get::<String, _>("revision"),
                }),
            });
        }
        events.sort_by_key(|event| event.cursor);
        if events.len() > limit as usize {
            events.truncate(limit as usize);
            has_more = true;
        }
        let cursor = events.last().map(|event| event.cursor).unwrap_or_else(|| {
            if has_more {
                after
            } else {
                head
            }
        });
        serde_json::to_value(CollectionChangesPage {
            events,
            cursor,
            has_more,
            reset: false,
        })
        .map_err(|error| ApiError::internal(format!("Hosted changes could not serialize: {error}")))
    }

    pub(super) async fn execute_read_operation(
        &self,
        collection_id: Uuid,
        operation: &str,
        input: &Value,
    ) -> ApiResult<OperationResult> {
        if operation == "read" {
            return self.execute_direct_point_read(collection_id, input).await;
        }
        let snapshot_started = Instant::now();
        let mut transaction = self.pool.begin().await?;
        let collection = sqlx::query(
            r#"SELECT head, wrapped_data_key FROM hosted_provider_collections
               WHERE id = $1 AND state = 'active'"#,
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
        let result = cached.workspace.read_operation(operation, input)?;
        transaction.commit().await?;
        let memory = crate::HostedProcessMemory::capture();
        tracing::info!(
            target: "mdbase_connect::metrics",
            metric = "hosted_legacy_read",
            operation,
            snapshot_ms = snapshot_started.elapsed().as_millis() as u64,
            database_pool_size = self.pool.size(),
            database_pool_idle = self.pool.num_idle(),
            working_set_plaintext_bytes = cached.plaintext_bytes,
            rss_bytes = memory.rss_bytes.unwrap_or(0),
            pss_bytes = memory.pss_bytes.unwrap_or(0),
            cgroup_current_bytes = memory.cgroup_current_bytes.unwrap_or(0),
            cgroup_peak_bytes = memory.cgroup_peak_bytes.unwrap_or(0),
            "privacy-safe hosted provider metric"
        );
        Ok(result)
    }

    async fn execute_direct_point_read(
        &self,
        collection_id: Uuid,
        input: &Value,
    ) -> ApiResult<OperationResult> {
        self.execute_direct_point_read_for_identity(collection_id, input, None)
            .await
    }

    pub(super) async fn execute_direct_point_read_by_id(
        &self,
        collection_id: Uuid,
        record_id: Uuid,
        input: &Value,
    ) -> ApiResult<OperationResult> {
        self.execute_direct_point_read_for_identity(collection_id, input, Some(record_id))
            .await
    }

    async fn execute_direct_point_read_for_identity(
        &self,
        collection_id: Uuid,
        input: &Value,
        stable_id: Option<Uuid>,
    ) -> ApiResult<OperationResult> {
        let started = Instant::now();
        let mut transaction = self.pool.begin().await?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            .execute(&mut *transaction)
            .await?;
        let collection = sqlx::query(
            r#"SELECT head, resource_revision, wrapped_data_key, resources_ciphertext
               FROM hosted_provider_collections
               WHERE id = $1 AND state = 'active'"#,
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
        let data_key = self
            .collection_key(collection_id, collection.get("wrapped_data_key"))
            .await?;
        let resources: SyncCollectionResources = self.crypto.decrypt_json(
            &data_key,
            collection.get("resources_ciphertext"),
            &resources_aad(collection_id),
        )?;
        let stored_resource_revision: String = collection.get("resource_revision");
        if resources.revision != stored_resource_revision {
            return Err(ApiError::internal(
                "The encrypted resource catalog revision does not match collection metadata.",
            ));
        }
        let resource_documents =
            load_resource_documents(&mut transaction, &self.crypto, &data_key, collection_id)
                .await?;
        let catalog = compile_point_catalog(resources, resource_documents)?;
        let path = input.get("path").and_then(Value::as_str);
        let identity = stable_id.map(DirectRecordIdentity::StableId).or_else(|| {
            path.map(|path| DirectRecordIdentity::PathToken(path_token(&data_key, path)))
        });
        let lookup_kind = if stable_id.is_some() {
            "stable_id"
        } else {
            "path_token"
        };
        let (result, records_fetched, ciphertext_bytes) = if let Some(identity) = identity {
            match load_direct_record(
                &mut transaction,
                &self.crypto,
                &data_key,
                collection_id,
                identity,
            )
            .await?
            {
                Some((record, ciphertext_bytes)) => {
                    if path.is_some_and(|path| record.path != path) {
                        return Err(ApiError::internal(
                            "The hosted encrypted record path does not match the requested identity.",
                        ));
                    }
                    let canonical = mdbase::runtime::CanonicalRecordInput {
                        stable_id: Some(record.record_id.to_string()),
                        path: record.path.clone(),
                        document: record.document.clone(),
                        file_size: record.document.len() as u64,
                        file_mtime: None,
                    };
                    (
                        catalog.read_record(input, &canonical),
                        1_u64,
                        ciphertext_bytes,
                    )
                }
                None => (catalog.read_record_not_found(input), 0, 0),
            }
        } else {
            (catalog.read_record_not_found(input), 0, 0)
        };
        transaction.commit().await?;
        let memory = crate::HostedProcessMemory::capture();
        tracing::info!(
            target: "mdbase_connect::metrics",
            metric = "hosted_direct_point_read",
            lookup_kind,
            records_fetched,
            records_decrypted = records_fetched,
            ciphertext_bytes,
            snapshot_ms = started.elapsed().as_millis() as u64,
            database_pool_size = self.pool.size(),
            database_pool_idle = self.pool.num_idle(),
            rss_bytes = memory.rss_bytes.unwrap_or(0),
            pss_bytes = memory.pss_bytes.unwrap_or(0),
            cgroup_current_bytes = memory.cgroup_current_bytes.unwrap_or(0),
            cgroup_peak_bytes = memory.cgroup_peak_bytes.unwrap_or(0),
            "privacy-safe hosted provider metric"
        );
        Ok(result)
    }
}

enum DirectRecordIdentity {
    StableId(Uuid),
    PathToken(Vec<u8>),
}

async fn load_direct_record(
    transaction: &mut Transaction<'_, Postgres>,
    crypto: &ProviderCrypto,
    data_key: &[u8; 32],
    collection_id: Uuid,
    identity: DirectRecordIdentity,
) -> ApiResult<Option<(PersistedRecord, u64)>> {
    let row = match identity {
        DirectRecordIdentity::StableId(record_id) => {
            sqlx::query(
                r#"SELECT record_id, sequence, payload_ciphertext
                   FROM hosted_provider_records
                   WHERE collection_id = $1 AND record_id = $2"#,
            )
            .bind(collection_id)
            .bind(record_id)
            .fetch_optional(&mut **transaction)
            .await?
        }
        DirectRecordIdentity::PathToken(token) => {
            sqlx::query(
                r#"SELECT record_id, sequence, payload_ciphertext
                   FROM hosted_provider_records
                   WHERE collection_id = $1 AND path_token = $2"#,
            )
            .bind(collection_id)
            .bind(token)
            .fetch_optional(&mut **transaction)
            .await?
        }
    };
    let Some(row) = row else {
        return Ok(None);
    };
    let record_id: Uuid = row.get("record_id");
    let sequence = number(row.get::<i64, _>("sequence"), "record sequence")?;
    let ciphertext: Vec<u8> = row.get("payload_ciphertext");
    let ciphertext_bytes = ciphertext.len() as u64;
    let record: PersistedRecord = crypto.decrypt_json(
        data_key,
        &ciphertext,
        &current_record_aad(collection_id, record_id, sequence),
    )?;
    if record.record_id != record_id {
        return Err(ApiError::internal(
            "The hosted encrypted record identity does not match its metadata.",
        ));
    }
    Ok(Some((record, ciphertext_bytes)))
}

fn compile_point_catalog(
    resources: SyncCollectionResources,
    resource_documents: Vec<(String, String)>,
) -> ApiResult<mdbase::runtime::CompiledCatalog> {
    let configuration_document = resource_documents
        .iter()
        .find(|(path, _)| path == "mdbase.yaml")
        .map(|(_, document)| document.clone())
        .ok_or_else(|| ApiError::internal("The hosted resource catalog has no mdbase.yaml."))?;
    let types = resources
        .types
        .into_iter()
        .map(|type_resource| {
            let path = type_resource.path.ok_or_else(|| {
                ApiError::internal("A hosted type catalog entry has no source path.")
            })?;
            let definition = type_resource.definition.ok_or_else(|| {
                ApiError::internal(format!(
                    "Hosted type catalog entry '{}' has no exact definition.",
                    type_resource.name
                ))
            })?;
            Ok(mdbase::runtime::ResolvedTypeResource {
                path,
                revision: type_resource.revision.unwrap_or_default(),
                definition,
                schema: type_resource.schema,
            })
        })
        .collect::<ApiResult<Vec<_>>>()?;
    let contracts = resources
        .contracts
        .into_iter()
        .filter(|contract| contract.contract_type == "record")
        .map(|contract| mdbase::runtime::ResolvedRecordContract {
            id: contract.id,
            version: contract.version,
            digest: contract.digest,
            record_schema: contract.schema,
            binding_schema: contract.binding_schema,
            implementations: contract
                .implementations
                .into_iter()
                .map(
                    |implementation| mdbase::runtime::ResolvedRecordContractImplementation {
                        type_name: implementation.type_name,
                        type_version: implementation.type_version,
                        digest: implementation.digest,
                        fields: implementation.fields,
                        binding: implementation.binding,
                        source_path: implementation.type_path,
                    },
                )
                .collect(),
        })
        .collect();
    mdbase::runtime::CompiledCatalog::compile(mdbase::runtime::CatalogInput {
        resource_revision: resources.revision,
        configuration_document,
        types,
        contracts,
    })
    .map_err(|error| {
        ApiError::internal(format!(
            "The hosted resource catalog could not compile: {error}"
        ))
    })
}
