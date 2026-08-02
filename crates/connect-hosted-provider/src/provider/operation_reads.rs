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
        let result = if operation == "query" {
            let cache_key: [u8; 32] =
                Sha256::digest(serde_json::to_vec(input).map_err(|error| {
                    ApiError::internal(format!("Hosted query input could not serialize: {error}"))
                })?)
                .into();
            if let Some(result) = cached.query_cache.get(&cache_key) {
                result.clone()
            } else {
                let result = cached.workspace.read_operation(operation, input)?;
                if cached.query_order.len() >= 128 {
                    if let Some(expired) = cached.query_order.pop_front() {
                        cached.query_cache.remove(&expired);
                    }
                }
                cached.query_order.push_back(cache_key);
                cached.query_cache.insert(cache_key, result.clone());
                result
            }
        } else {
            cached.workspace.read_operation(operation, input)?
        };
        transaction.commit().await?;
        Ok(result)
    }

    pub(super) async fn load_record_operation(
        &self,
        collection_id: Uuid,
        replica: &Replica,
        operation: &str,
        request_id: Uuid,
        input: &Value,
    ) -> ApiResult<Option<StoredRecordOperation>> {
        let Some(row) = sqlx::query(
            r#"SELECT request.operation, request.request_hash,
                      request.prepared_mutation_ciphertext,
                      request.response_ciphertext, collection.wrapped_data_key
               FROM hosted_provider_operation_requests request
               JOIN hosted_provider_replicas replica ON replica.id = request.replica_id
               JOIN hosted_provider_collections collection
                 ON collection.id = replica.collection_id
               WHERE request.replica_id = $1 AND request.request_id = $2
                 AND replica.collection_id = $3"#,
        )
        .bind(replica.id)
        .bind(request_id)
        .bind(collection_id)
        .fetch_optional(&self.pool)
        .await?
        else {
            return Ok(None);
        };
        let submitted_hash = operation_request_hash(operation, input)?;
        let stored_hash: Vec<u8> = row.get("request_hash");
        if row.get::<String, _>("operation") != operation
            || !bool::from(stored_hash.ct_eq(&submitted_hash))
        {
            return Err(ApiError::conflict(
                "operation_request_id_reused",
                "Operation request ID was already used for a different operation.",
            ));
        }
        let wrapped_data_key: Vec<u8> = row.get("wrapped_data_key");
        let data_key = self
            .collection_key(collection_id, &wrapped_data_key)
            .await?;
        if let Some(ciphertext) = row.get::<Option<Vec<u8>>, _>("response_ciphertext") {
            let response = self.crypto.decrypt_json(
                &data_key,
                &ciphertext,
                &operation_response_aad(replica.id, request_id),
            )?;
            return Ok(Some(StoredRecordOperation::Completed(response)));
        }
        let ciphertext = row
            .get::<Option<Vec<u8>>, _>("prepared_mutation_ciphertext")
            .ok_or_else(|| {
                ApiError::internal("The hosted operation request has no prepared mutation.")
            })?;
        let prepared = self.crypto.decrypt_json(
            &data_key,
            &ciphertext,
            &operation_prepared_aad(replica.id, request_id),
        )?;
        Ok(Some(StoredRecordOperation::Prepared(prepared)))
    }
}
