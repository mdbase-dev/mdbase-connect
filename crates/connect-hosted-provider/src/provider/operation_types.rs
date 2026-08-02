use super::*;

impl HostedProvider {
    pub(super) async fn write_type_operation(
        &self,
        collection_id: Uuid,
        operation: &str,
        input: Value,
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
                "The type definition exceeds the hosted document size limit.",
            ));
        }
        let data_key = self
            .collection_key(collection_id, collection.get("wrapped_data_key"))
            .await?;
        let working_set = self.working_set(collection_id).await;
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
                    record_id: record.record.record_id,
                    path: record.record.path.clone(),
                    document: record.document.clone(),
                }),
            )?;
            *cached = Some(CachedCollection {
                head: Some(head),
                workspace,
                records,
                query_cache: HashMap::new(),
                query_order: VecDeque::new(),
            });
        }
        let cached = cached
            .as_mut()
            .expect("hosted working set was initialized above");
        let envelope = cached.workspace.type_operation(operation, &input)?;
        if !envelope.valid {
            transaction.commit().await?;
            return serde_json::to_value(envelope).map_err(|error| {
                ApiError::internal(format!("Hosted operation could not serialize: {error}"))
            });
        }
        // The workspace has already changed. Keep the cache invalid until the
        // matching database transaction commits so a failed persistence step
        // cannot leave a stale in-memory collection serving future requests.
        cached.head = None;
        let path = result_string(&envelope.result, "path")?.to_string();
        let type_name = result_string(&envelope.result, "name")?.to_string();
        let revision = result_string(&envelope.result, "revision")?.to_string();
        let document = cached.workspace.resource_document(&path)?;
        let (types, contracts) = cached.workspace.type_resources()?;
        let record_inputs = cached
            .records
            .iter()
            .map(|(id, persisted)| {
                (
                    *id,
                    persisted.record.path.clone(),
                    persisted.record.frontmatter.clone(),
                )
            })
            .collect::<Vec<_>>();
        let classifications = cached.workspace.classify_records(&record_inputs)?;

        head = head
            .checked_add(1)
            .ok_or_else(|| ApiError::internal("The hosted collection sequence is exhausted."))?;
        let resource_revision = format!("hosted:1:{head}:resources");
        let mut resources: SyncCollectionResources = self.crypto.decrypt_json(
            &data_key,
            collection.get("resources_ciphertext"),
            &resources_aad(collection_id),
        )?;
        resources.revision = resource_revision.clone();
        resources.types = types;
        resources.contracts = contracts;
        let resources_ciphertext =
            self.crypto
                .encrypt_json(&data_key, &resources, &resources_aad(collection_id))?;
        let document_ciphertext = self.crypto.encrypt_bytes(
            &data_key,
            document.as_bytes(),
            &resource_document_aad(collection_id, &path),
        )?;
        sqlx::query(
            r#"INSERT INTO hosted_provider_resources
                 (collection_id, path, kind, revision, document_ciphertext)
               VALUES ($1, $2, 'type', $3, $4)
               ON CONFLICT (collection_id, path) DO UPDATE SET
                 revision = EXCLUDED.revision,
                 document_ciphertext = EXCLUDED.document_ciphertext,
                 updated_at = now()"#,
        )
        .bind(collection_id)
        .bind(&path)
        .bind(&revision)
        .bind(document_ciphertext)
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            r#"INSERT INTO hosted_provider_resource_changes
                 (collection_id, sequence, type_name, path, revision)
               VALUES ($1, $2, $3, $4, $5)"#,
        )
        .bind(collection_id)
        .bind(to_i64(head, "resource change sequence")?)
        .bind(&type_name)
        .bind(&path)
        .bind(&revision)
        .execute(&mut *transaction)
        .await?;

        for (record_id, next_types) in classifications {
            let Some(persisted) = cached.records.get_mut(&record_id) else {
                continue;
            };
            if persisted.record.types == next_types {
                continue;
            }
            persisted.record.types = next_types;
            let sequence: i64 = sqlx::query_scalar(
                "SELECT sequence FROM hosted_provider_records WHERE collection_id = $1 AND record_id = $2",
            )
            .bind(collection_id)
            .bind(record_id)
            .fetch_one(&mut *transaction)
            .await?;
            let sequence_u64 = number(sequence, "record sequence")?;
            let current_ciphertext = self.crypto.encrypt_json(
                &data_key,
                persisted,
                &current_record_aad(collection_id, record_id, sequence_u64),
            )?;
            let version_ciphertext = self.crypto.encrypt_json(
                &data_key,
                persisted,
                &record_version_aad(collection_id, record_id, sequence_u64),
            )?;
            sqlx::query(
                r#"UPDATE hosted_provider_records
                   SET types = $3, payload_ciphertext = $4, updated_at = now()
                   WHERE collection_id = $1 AND record_id = $2"#,
            )
            .bind(collection_id)
            .bind(record_id)
            .bind(&persisted.record.types)
            .bind(current_ciphertext)
            .execute(&mut *transaction)
            .await?;
            sqlx::query(
                r#"UPDATE hosted_provider_record_versions
                   SET types = $4, payload_ciphertext = $5
                   WHERE collection_id = $1 AND record_id = $2 AND sequence = $3"#,
            )
            .bind(collection_id)
            .bind(record_id)
            .bind(sequence)
            .bind(&persisted.record.types)
            .bind(version_ciphertext)
            .execute(&mut *transaction)
            .await?;
        }

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
        transaction.commit().await?;
        cached.head = Some(head);
        cached.query_cache.clear();
        cached.query_order.clear();
        serde_json::to_value(envelope).map_err(|error| {
            ApiError::internal(format!("Hosted operation could not serialize: {error}"))
        })
    }

    pub(super) async fn write_contract_setup_operation(
        &self,
        collection_id: Uuid,
        provisions: &[TypePackProvision],
        contract_setups: &[ContractSetupChoice],
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
        if provisions
            .iter()
            .flat_map(|provision| provision.resources.iter())
            .any(|resource| resource.document.len() as u64 > max_document_bytes)
        {
            return Err(ApiError::bad_request(
                "document_quota_exceeded",
                "A type pack resource exceeds the hosted document size limit.",
            ));
        }
        let data_key = self
            .collection_key(collection_id, collection.get("wrapped_data_key"))
            .await?;
        let working_set = self.working_set(collection_id).await;
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
                    record_id: record.record.record_id,
                    path: record.record.path.clone(),
                    document: record.document.clone(),
                }),
            )?;
            *cached = Some(CachedCollection {
                head: Some(head),
                workspace,
                records,
                query_cache: HashMap::new(),
                query_order: VecDeque::new(),
            });
        }
        let cached = cached
            .as_mut()
            .expect("hosted working set was initialized above");
        let envelope = cached
            .workspace
            .install_type_packs_with_contract_setups(provisions, contract_setups)?;
        if !envelope.valid {
            transaction.commit().await?;
            return serde_json::to_value(envelope).map_err(|error| {
                ApiError::internal(format!("Hosted type pack could not serialize: {error}"))
            });
        }
        let changed_resources = envelope
            .result
            .get("resources")
            .and_then(Value::as_array)
            .ok_or_else(|| ApiError::internal("Contract setup returned no resource plan."))?
            .iter()
            .filter(|resource| resource.get("action").and_then(Value::as_str) != Some("unchanged"))
            .collect::<Vec<_>>();
        if changed_resources.iter().any(|resource| {
            resource
                .get("target")
                .and_then(Value::as_str)
                .and_then(|target| cached.workspace.resource_document(target).ok())
                .is_some_and(|document| document.len() as u64 > max_document_bytes)
        }) {
            cached.head = None;
            return Err(ApiError::bad_request(
                "document_quota_exceeded",
                "A contract setup resource exceeds the hosted document size limit.",
            ));
        }
        if changed_resources.is_empty() {
            transaction.commit().await?;
            return serde_json::to_value(envelope).map_err(|error| {
                ApiError::internal(format!("Hosted type pack could not serialize: {error}"))
            });
        }
        cached.head = None;
        let (types, contracts) = cached.workspace.type_resources()?;
        let record_inputs = cached
            .records
            .iter()
            .map(|(id, persisted)| {
                (
                    *id,
                    persisted.record.path.clone(),
                    persisted.record.frontmatter.clone(),
                )
            })
            .collect::<Vec<_>>();
        let classifications = cached.workspace.classify_records(&record_inputs)?;

        for resource in changed_resources {
            let target = resource
                .get("target")
                .and_then(Value::as_str)
                .ok_or_else(|| ApiError::internal("Contract setup returned an invalid target."))?;
            let kind = resource
                .get("kind")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    ApiError::internal("Contract setup returned an invalid resource kind.")
                })?;
            head = head.checked_add(1).ok_or_else(|| {
                ApiError::internal("The hosted collection sequence is exhausted.")
            })?;
            let document = cached.workspace.resource_document(target)?;
            let revision = format!("sha256:{:x}", Sha256::digest(document.as_bytes()));
            let ciphertext = self.crypto.encrypt_bytes(
                &data_key,
                document.as_bytes(),
                &resource_document_aad(collection_id, target),
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
            .bind(target)
            .bind(kind)
            .bind(&revision)
            .bind(ciphertext)
            .execute(&mut *transaction)
            .await?;
            let type_name = if kind == "type" {
                target
                    .rsplit('/')
                    .next()
                    .and_then(|file| file.strip_suffix(".md"))
            } else {
                None
            };
            sqlx::query(
                r#"INSERT INTO hosted_provider_resource_changes
                     (collection_id, sequence, resource_kind, type_name, path, revision)
                   VALUES ($1, $2, $3, $4, $5, $6)"#,
            )
            .bind(collection_id)
            .bind(to_i64(head, "resource change sequence")?)
            .bind(kind)
            .bind(type_name)
            .bind(target)
            .bind(&revision)
            .execute(&mut *transaction)
            .await?;
        }

        let resource_revision = format!("hosted:1:{head}:resources");
        let mut resources: SyncCollectionResources = self.crypto.decrypt_json(
            &data_key,
            collection.get("resources_ciphertext"),
            &resources_aad(collection_id),
        )?;
        resources.revision = resource_revision.clone();
        resources.types = types;
        resources.contracts = contracts;
        let resources_ciphertext =
            self.crypto
                .encrypt_json(&data_key, &resources, &resources_aad(collection_id))?;

        for (record_id, next_types) in classifications {
            let Some(persisted) = cached.records.get_mut(&record_id) else {
                continue;
            };
            if persisted.record.types == next_types {
                continue;
            }
            persisted.record.types = next_types;
            let sequence: i64 = sqlx::query_scalar(
                "SELECT sequence FROM hosted_provider_records WHERE collection_id = $1 AND record_id = $2",
            )
            .bind(collection_id)
            .bind(record_id)
            .fetch_one(&mut *transaction)
            .await?;
            let sequence_u64 = number(sequence, "record sequence")?;
            let current_ciphertext = self.crypto.encrypt_json(
                &data_key,
                persisted,
                &current_record_aad(collection_id, record_id, sequence_u64),
            )?;
            let version_ciphertext = self.crypto.encrypt_json(
                &data_key,
                persisted,
                &record_version_aad(collection_id, record_id, sequence_u64),
            )?;
            sqlx::query(
                r#"UPDATE hosted_provider_records
                   SET types = $3, payload_ciphertext = $4, updated_at = now()
                   WHERE collection_id = $1 AND record_id = $2"#,
            )
            .bind(collection_id)
            .bind(record_id)
            .bind(&persisted.record.types)
            .bind(current_ciphertext)
            .execute(&mut *transaction)
            .await?;
            sqlx::query(
                r#"UPDATE hosted_provider_record_versions
                   SET types = $4, payload_ciphertext = $5
                   WHERE collection_id = $1 AND record_id = $2 AND sequence = $3"#,
            )
            .bind(collection_id)
            .bind(record_id)
            .bind(sequence)
            .bind(&persisted.record.types)
            .bind(version_ciphertext)
            .execute(&mut *transaction)
            .await?;
        }

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
        transaction.commit().await?;
        cached.head = Some(head);
        cached.query_cache.clear();
        cached.query_order.clear();
        serde_json::to_value(envelope).map_err(|error| {
            ApiError::internal(format!("Hosted type pack could not serialize: {error}"))
        })
    }
}
