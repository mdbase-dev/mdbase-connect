use super::mutation_journal::{HostedMutationClaim, HostedMutationLease};
use super::*;

struct MutationExecution<'a> {
    journal_lease: Option<&'a HostedMutationLease>,
    journal_result_is_public: bool,
    semantic: Option<(String, serde_json::Map<String, Value>)>,
}

impl HostedProvider {
    pub async fn mutate(
        &self,
        collection_id: Uuid,
        token: &str,
        mutation: SyncMutation,
        request_origin: Option<&str>,
    ) -> ApiResult<SyncMutationReceipt> {
        self.mutate_for_sync(collection_id, token, mutation, request_origin)
            .await
    }

    pub(super) async fn mutate_for_sync(
        &self,
        collection_id: Uuid,
        token: &str,
        mutation: SyncMutation,
        request_origin: Option<&str>,
    ) -> ApiResult<SyncMutationReceipt> {
        let required_operation = match mutation.operation {
            SyncMutationOperation::Put if mutation.base_revision.is_none() => "create",
            SyncMutationOperation::Put => "update",
            SyncMutationOperation::Move => "rename",
            SyncMutationOperation::Delete => "delete",
        };
        let replica = self
            .authenticate_for_sync(collection_id, token, required_operation, request_origin)
            .await?;
        let claim = self
            .claim_sync_mutation(collection_id, &replica, &mutation)
            .await?;
        let lease = match claim {
            HostedMutationClaim::Terminal(result) => {
                return sync_receipt_from_value(result?);
            }
            HostedMutationClaim::Live => {
                return Err(ApiError::conflict(
                    "pending_mutation_unresolved",
                    "The sync mutation is still owned by an active request handler.",
                )
                .with_details(json!({ "request_id": mutation.mutation_id })));
            }
            HostedMutationClaim::Owned {
                lease,
                applied_result: Some(result),
                ..
            } => {
                self.complete_operation_mutation(collection_id, &lease, &result)
                    .await?;
                return sync_receipt_from_value(result?);
            }
            HostedMutationClaim::Owned { lease, .. } => lease,
        };
        let transaction = self.pool.begin().await?;
        let result = self
            .mutate_in_transaction(
                transaction,
                collection_id,
                mutation,
                replica,
                MutationExecution {
                    journal_lease: Some(&lease),
                    journal_result_is_public: true,
                    semantic: None,
                },
            )
            .await;
        let value_result = result
            .as_ref()
            .map_err(|error| ApiError::new(error.status, error.code.clone(), error.message.clone()))
            .and_then(|receipt| {
                serde_json::to_value(receipt).map_err(|error| {
                    ApiError::internal(format!("Sync receipt could not serialize: {error}"))
                })
            });
        self.complete_operation_mutation(collection_id, &lease, &value_result)
            .await?;
        result
    }

    pub(super) async fn mutate_for(
        &self,
        collection_id: Uuid,
        token: &str,
        mutation: SyncMutation,
        purpose: ReplicaPurpose,
        journal_lease: Option<&HostedMutationLease>,
        semantic: Option<(String, serde_json::Map<String, Value>)>,
    ) -> ApiResult<SyncMutationReceipt> {
        let mut transaction = self.pool.begin().await?;
        let replica = authenticate_in(&mut transaction, collection_id, token, purpose).await?;
        if let Some(lease) = journal_lease {
            if let Some(receipt) = self.load_sync_effect(collection_id, lease).await? {
                return Ok(receipt);
            }
        }
        self.mutate_in_transaction(
            transaction,
            collection_id,
            mutation,
            replica,
            MutationExecution {
                journal_lease,
                journal_result_is_public: false,
                semantic,
            },
        )
        .await
    }

    async fn mutate_in_transaction(
        &self,
        mut transaction: Transaction<'_, Postgres>,
        collection_id: Uuid,
        mutation: SyncMutation,
        replica: Replica,
        execution: MutationExecution<'_>,
    ) -> ApiResult<SyncMutationReceipt> {
        if mutation.replica_id != replica.id {
            return Err(ApiError::forbidden(
                "replica_scope_denied",
                "Mutation belongs to another replica.",
            ));
        }
        // Serialize a replica's mutation stream before consulting its receipt
        // table. A concurrent retry must observe the first transaction's
        // committed receipt instead of executing the same effect twice.
        sqlx::query("SELECT id FROM hosted_provider_replicas WHERE id = $1 FOR UPDATE")
            .bind(replica.id)
            .fetch_one(&mut *transaction)
            .await?;
        let wrapped_data_key: Vec<u8> = sqlx::query_scalar(
            "SELECT wrapped_data_key FROM hosted_provider_collections WHERE id = $1 AND state = 'active'",
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
            .collection_key(collection_id, &wrapped_data_key)
            .await?;
        let journal = SyncJournalContext {
            provider: self,
            lease: execution
                .journal_lease
                .ok_or_else(|| ApiError::internal("Hosted sync mutation has no journal lease."))?,
            public_result: execution.journal_result_is_public,
        };
        if replica.mode != SyncReplicaMode::ReadWrite {
            return store_rejection(
                transaction,
                &self.crypto,
                &data_key,
                &mutation,
                &journal,
                "replica_read_only",
                "This replica is read-only.",
            )
            .await;
        }
        if mutation.scope_epoch != replica.scope_epoch {
            return store_rejection(
                transaction,
                &self.crypto,
                &data_key,
                &mutation,
                &journal,
                "scope_epoch_stale",
                "Replica scope changed; open a new sync session.",
            )
            .await;
        }
        if let Some(predecessor) = mutation.causal_predecessor {
            let predecessor_applied: Option<bool> = sqlx::query_scalar(
                r#"SELECT effect_applied FROM hosted_provider_mutation_journal
                   WHERE replica_id = $1 AND request_id = $2
                     AND operation_kind = 'sync:mutate'
                     AND state IN ('applied', 'completed', 'acknowledged')"#,
            )
            .bind(replica.id)
            .bind(predecessor)
            .fetch_optional(&mut *transaction)
            .await?;
            let Some(predecessor_applied) = predecessor_applied else {
                return store_rejection(
                    transaction,
                    &self.crypto,
                    &data_key,
                    &mutation,
                    &journal,
                    "causal_predecessor_missing",
                    "The mutation's causal predecessor has not been applied.",
                )
                .await;
            };
            if !predecessor_applied {
                return store_rejection(
                    transaction,
                    &self.crypto,
                    &data_key,
                    &mutation,
                    &journal,
                    "causal_predecessor_not_applied",
                    "The mutation's causal predecessor did not apply.",
                )
                .await;
            }
        }

        let collection = sqlx::query(
            r#"SELECT head, record_count, content_bytes, max_records,
                      max_content_bytes, max_document_bytes
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
        let record_count = number(collection.get::<i64, _>("record_count"), "record count")?;
        let content_bytes = number(
            collection.get::<i64, _>("content_bytes"),
            "collection content bytes",
        )?;
        let max_records = number(collection.get::<i64, _>("max_records"), "record quota")?;
        let max_content_bytes = number(
            collection.get::<i64, _>("max_content_bytes"),
            "collection byte quota",
        )?;
        let max_document_bytes = number(
            collection.get::<i64, _>("max_document_bytes"),
            "document byte quota",
        )?;
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
                    record_id: record.record_id,
                    path: record.path.clone(),
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
        let current = cached.records.get(&mutation.record_id).cloned();

        if mutation.operation == SyncMutationOperation::Put
            && mutation.base_revision.is_none()
            && current.is_some()
        {
            return store_rejection(
                transaction,
                &self.crypto,
                &data_key,
                &mutation,
                &journal,
                "record_conflict",
                "The hosted record ID already exists.",
            )
            .await;
        }
        if !(mutation.operation == SyncMutationOperation::Put && mutation.base_revision.is_none()) {
            let Some(current) = &current else {
                return store_rejection(
                    transaction,
                    &self.crypto,
                    &data_key,
                    &mutation,
                    &journal,
                    "record_not_found",
                    "The hosted record does not exist.",
                )
                .await;
            };
            if !visible(current, &replica.allowed_types) {
                return store_rejection(
                    transaction,
                    &self.crypto,
                    &data_key,
                    &mutation,
                    &journal,
                    "scope_denied",
                    "The replica cannot mutate that record.",
                )
                .await;
            }
            let Some(base_revision) = mutation.base_revision.as_deref() else {
                return store_rejection(
                    transaction,
                    &self.crypto,
                    &data_key,
                    &mutation,
                    &journal,
                    "base_revision_required",
                    "Conditional mutations require a base revision.",
                )
                .await;
            };
            if base_revision != current.revision {
                let receipt = SyncMutationReceipt::Conflicted {
                    mutation_id: mutation.mutation_id,
                    conflict: Box::new(SyncConflict {
                        record_id: mutation.record_id,
                        mutation: mutation.clone(),
                        current: Some(current.clone()),
                        current_revision: Some(current.revision.clone()),
                    }),
                };
                store_receipt(
                    &mut transaction,
                    &self.crypto,
                    &data_key,
                    replica.id,
                    &mutation,
                    &journal,
                    &receipt,
                )
                .await?;
                transaction.commit().await?;
                return Ok(receipt);
            }
        }

        cached.head = None;
        cached.query_cache.clear();
        cached.query_order.clear();
        let execution = if let Some((operation, input)) = execution.semantic {
            cached
                .workspace
                .execute_semantic(mutation.record_id, &operation, &input)?
        } else {
            match cached.workspace.execute_sync(&mutation) {
                Ok(execution) => execution,
                Err(error) if error.status.is_client_error() => {
                    return store_rejection(
                        transaction,
                        &self.crypto,
                        &data_key,
                        &mutation,
                        &journal,
                        &error.code,
                        &error.message,
                    )
                    .await;
                }
                Err(error) => return Err(error),
            }
        };
        if !execution.envelope.valid {
            let (code, message) = operation_error(&execution.envelope);
            return store_rejection(
                transaction,
                &self.crypto,
                &data_key,
                &mutation,
                &journal,
                &code,
                &message,
            )
            .await;
        }
        if execution.changed.is_empty() {
            return Err(ApiError::internal(
                "mdbase-rs accepted a mutation without producing a write set.",
            ));
        }
        for (record_id, after, _) in &execution.changed {
            let before = cached.records.get(record_id);
            if before.is_some_and(|record| !visible(record, &replica.allowed_types))
                || after
                    .as_ref()
                    .is_some_and(|record| !visible(record, &replica.allowed_types))
            {
                return store_rejection(
                    transaction,
                    &self.crypto,
                    &data_key,
                    &mutation,
                    &journal,
                    "scope_denied",
                    "The mutation would change a record outside the replica scope.",
                )
                .await;
            }
        }
        let mut next_record_count = i128::from(record_count);
        let mut next_content_bytes = i128::from(content_bytes);
        for (record_id, after, document) in &execution.changed {
            let before = cached.records.get(record_id);
            let before_bytes = before
                .map(|record| record.document.len() as i128)
                .unwrap_or_default();
            let after_bytes = document
                .as_ref()
                .map(|value| value.len() as i128)
                .unwrap_or_default();
            if after.is_some()
                && u64::try_from(after_bytes).unwrap_or(u64::MAX) > max_document_bytes
            {
                return store_rejection(
                    transaction,
                    &self.crypto,
                    &data_key,
                    &mutation,
                    &journal,
                    "document_quota_exceeded",
                    "The canonical Markdown document exceeds the hosted document size limit.",
                )
                .await;
            }
            next_content_bytes += after_bytes - before_bytes;
            next_record_count += match (before.is_some(), after.is_some()) {
                (false, true) => 1,
                (true, false) => -1,
                _ => 0,
            };
        }
        if next_record_count < 0
            || next_record_count > i128::from(max_records)
            || next_content_bytes < 0
            || next_content_bytes > i128::from(max_content_bytes)
        {
            return store_rejection(
                transaction,
                &self.crypto,
                &data_key,
                &mutation,
                &journal,
                "collection_quota_exceeded",
                "The mutation would exceed the hosted collection quota.",
            )
            .await;
        }

        let notification_runtime_active = if self.notifications.is_some() {
            sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(
                    SELECT 1 FROM hosted_provider_notification_grants
                    WHERE collection_id = $1
                 )",
            )
            .bind(collection_id)
            .fetch_one(&mut *transaction)
            .await?
        } else {
            false
        };
        let mut primary = None;
        for (record_id, after, document) in execution.changed {
            head = head.checked_add(1).ok_or_else(|| {
                ApiError::internal("The hosted collection sequence is exhausted.")
            })?;
            let before = cached.records.get(&record_id).cloned();
            let notification_event = notification_runtime_active
                .then(|| application_change(before.as_ref(), after.as_ref()));
            let revision = if let Some(record) = &after {
                persist_live_record(
                    &mut transaction,
                    &self.crypto,
                    &data_key,
                    collection_id,
                    head,
                    record,
                )
                .await?;
                if record_id == execution.primary_record_id {
                    primary = Some(record.clone());
                }
                record.revision.clone()
            } else {
                let before = before.as_ref().ok_or_else(|| {
                    ApiError::internal("The hosted write set deleted an unknown record.")
                })?;
                let revision = format!("hosted:1:{head}:tombstone");
                persist_deleted_record(&mut transaction, collection_id, head, before, &revision)
                    .await?;
                revision
            };
            let before_ciphertext = before
                .as_ref()
                .map(|record| {
                    self.crypto.encrypt_json(
                        &data_key,
                        record,
                        &change_record_aad(collection_id, head, "before"),
                    )
                })
                .transpose()?;
            let after_ciphertext = after
                .as_ref()
                .map(|record| {
                    self.crypto.encrypt_json(
                        &data_key,
                        record,
                        &change_record_aad(collection_id, head, "after"),
                    )
                })
                .transpose()?;
            sqlx::query(
                r#"INSERT INTO hosted_provider_changes
                     (collection_id, sequence, record_id, before_types, after_types,
                      before_ciphertext, after_ciphertext, revision,
                      source_replica_id)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)"#,
            )
            .bind(collection_id)
            .bind(to_i64(head, "change sequence")?)
            .bind(record_id)
            .bind(
                before
                    .as_ref()
                    .map(|record| record.types.clone())
                    .unwrap_or_default(),
            )
            .bind(
                after
                    .as_ref()
                    .map(|record| record.types.clone())
                    .unwrap_or_default(),
            )
            .bind(before_ciphertext)
            .bind(after_ciphertext)
            .bind(revision)
            .bind(replica.id)
            .execute(&mut *transaction)
            .await?;
            if let Some((event_type, payload)) = notification_event {
                sqlx::query(
                    "INSERT INTO hosted_provider_runtime_outbox
                        (collection_id, sequence, event_type, payload)
                     VALUES ($1, $2, $3, $4)
                     ON CONFLICT(collection_id, sequence) DO NOTHING",
                )
                .bind(collection_id)
                .bind(to_i64(head, "runtime event sequence")?)
                .bind(event_type)
                .bind(payload)
                .execute(&mut *transaction)
                .await?;
            }
            if let Some(record) = after {
                let document = document.ok_or_else(|| {
                    ApiError::internal("The hosted write set omitted its exact document.")
                })?;
                if record.document != document {
                    return Err(ApiError::internal(
                        "The hosted write set disagrees with its exact document.",
                    ));
                }
                cached.records.insert(record_id, record);
            } else {
                cached.records.remove(&record_id);
            }
        }
        sqlx::query(
            r#"UPDATE hosted_provider_collections
               SET head = $2, record_count = $3, content_bytes = $4, updated_at = now()
               WHERE id = $1"#,
        )
        .bind(collection_id)
        .bind(to_i64(head, "collection head")?)
        .bind(i64::try_from(next_record_count).map_err(|_| {
            ApiError::internal("The hosted record count is outside the supported range.")
        })?)
        .bind(i64::try_from(next_content_bytes).map_err(|_| {
            ApiError::internal("The hosted content size is outside the supported range.")
        })?)
        .execute(&mut *transaction)
        .await?;
        let receipt = SyncMutationReceipt::Applied {
            mutation_id: mutation.mutation_id,
            sequence: head,
            record: primary,
        };
        store_receipt(
            &mut transaction,
            &self.crypto,
            &data_key,
            replica.id,
            &mutation,
            &journal,
            &receipt,
        )
        .await?;
        transaction.commit().await?;
        cached.head = Some(head);
        if notification_runtime_active {
            let provider = self.clone();
            tokio::spawn(async move {
                if let Err(error) = provider.recover_notifications(100).await {
                    tracing::warn!(
                        error_code = %error.code,
                        "hosted notification recovery deferred"
                    );
                }
            });
        }
        Ok(receipt)
    }
}

fn sync_receipt_from_value(value: Value) -> ApiResult<SyncMutationReceipt> {
    serde_json::from_value(value).map_err(|error| {
        ApiError::internal(format!("Stored sync mutation receipt is invalid: {error}"))
    })
}
