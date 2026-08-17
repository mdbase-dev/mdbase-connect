use super::mutation_journal::{HostedMutationClaim, HostedMutationLease};
use super::operation_reads::{compile_point_catalog, load_direct_record, DirectRecordIdentity};
use super::projections::ActiveProjectionChange;
use super::*;

struct MutationExecution<'a> {
    journal_lease: Option<&'a HostedMutationLease>,
    journal_result_is_public: bool,
    semantic: Option<(String, serde_json::Map<String, Value>)>,
    semantic_result: Option<&'a mut Option<OperationResult>>,
}

pub(super) struct ApplicationMutationResult {
    pub receipt: SyncMutationReceipt,
    pub semantic_result: Option<OperationResult>,
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
        let presented_token_hash = token_hash(token);
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
        let mut transaction = self.pool.begin().await?;
        let reauthorized = reauthorize_sync_mutation_in(
            &mut transaction,
            collection_id,
            replica.id,
            &presented_token_hash,
            required_operation,
            request_origin,
        )
        .await;
        let result = match reauthorized {
            Ok(replica) => {
                self.mutate_in_transaction(
                    transaction,
                    collection_id,
                    mutation,
                    replica,
                    MutationExecution {
                        journal_lease: Some(&lease),
                        journal_result_is_public: true,
                        semantic: None,
                        semantic_result: None,
                    },
                )
                .await
            }
            Err(error) => Err(error),
        };
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
    ) -> ApiResult<ApplicationMutationResult> {
        let mut transaction = self.pool.begin().await?;
        let replica =
            authenticate_mutation_in(&mut transaction, collection_id, token, purpose).await?;
        if let Some(lease) = journal_lease {
            if let Some((receipt, semantic_result)) =
                self.load_sync_effect(collection_id, lease).await?
            {
                return Ok(ApplicationMutationResult {
                    receipt,
                    semantic_result,
                });
            }
        }
        let mut semantic_result = None;
        let receipt = self
            .mutate_in_transaction(
                transaction,
                collection_id,
                mutation,
                replica,
                MutationExecution {
                    journal_lease,
                    journal_result_is_public: false,
                    semantic,
                    semantic_result: Some(&mut semantic_result),
                },
            )
            .await?;
        Ok(ApplicationMutationResult {
            receipt,
            semantic_result,
        })
    }

    pub(super) async fn preflight_semantic_mutation(
        &self,
        collection_id: Uuid,
        mutation: &SyncMutation,
        operation: &str,
        input: serde_json::Map<String, Value>,
        allowed_types: &[String],
    ) -> ApiResult<OperationResult> {
        let mut transaction = self.pool.begin().await?;
        let collection = sqlx::query(
            r#"SELECT resource_revision, resources_ciphertext, wrapped_data_key,
                      active_projection_generation_id
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
        let wrapped_data_key: Vec<u8> = collection.get("wrapped_data_key");
        let data_key = self
            .collection_key(collection_id, &wrapped_data_key)
            .await?;
        let current = load_direct_record(
            &mut transaction,
            &self.crypto,
            &data_key,
            collection_id,
            DirectRecordIdentity::StableId(mutation.record_id),
        )
        .await?
        .map(|(record, _, _)| record);
        let (execution, before_records) = execute_direct_semantic(
            &mut transaction,
            self,
            &data_key,
            collection_id,
            &collection,
            mutation.record_id,
            operation,
            input,
            current,
        )
        .await?;
        for (record_id, after, _) in &execution.changed {
            let before = before_records.get(record_id);
            if before.is_some_and(|record| !visible(record, allowed_types))
                || after
                    .as_ref()
                    .is_some_and(|record| !visible(record, allowed_types))
            {
                return Ok(invalid_operation_result(
                    "scope_denied",
                    "The mutation would change a record outside the replica scope.",
                    None,
                    None,
                ));
            }
        }
        Ok(execution.envelope)
    }

    async fn mutate_in_transaction(
        &self,
        mut transaction: Transaction<'_, Postgres>,
        collection_id: Uuid,
        mutation: SyncMutation,
        replica: Replica,
        execution: MutationExecution<'_>,
    ) -> ApiResult<SyncMutationReceipt> {
        let mutation_started = Instant::now();
        if mutation.replica_id != replica.id {
            return Err(ApiError::forbidden(
                "replica_scope_denied",
                "Mutation belongs to another replica.",
            ));
        }
        // Serialize a replica's mutation stream before consulting its receipt
        // table. A concurrent retry must observe the first transaction's
        // committed receipt instead of executing the same effect twice.
        // Both sync and application paths already hold this row FOR UPDATE
        // from their commit-time authorization check. Keep this assertion next
        // to receipt handling so future entry points cannot omit the mutation
        // stream serializer, but never rely on a shared-to-exclusive upgrade.
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
                      max_content_bytes, max_document_bytes, resource_revision,
                      resources_ciphertext, active_projection_generation_id
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
        let (current, current_ciphertext_bytes) = load_direct_record(
            &mut transaction,
            &self.crypto,
            &data_key,
            collection_id,
            DirectRecordIdentity::StableId(mutation.record_id),
        )
        .await?
        .map_or((None, 0), |(record, bytes, _)| (Some(record), bytes));
        let semantic_requested = execution.semantic.is_some();

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
            if !semantic_requested && !visible(current, &replica.allowed_types) {
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
                store_receipt(&mut transaction, &data_key, &journal, &receipt, None).await?;
                transaction.commit().await?;
                return Ok(receipt);
            }
        }

        let MutationExecution {
            semantic,
            semantic_result,
            ..
        } = execution;
        let direct_sync = semantic.is_none();
        let (execution, before_records) = if let Some((operation, input)) = semantic {
            execute_direct_semantic(
                &mut transaction,
                self,
                &data_key,
                collection_id,
                &collection,
                mutation.record_id,
                &operation,
                input,
                current.clone(),
            )
            .await?
        } else {
            let destination_owner = if matches!(
                mutation.operation,
                SyncMutationOperation::Put | SyncMutationOperation::Move
            ) {
                let path = mutation.path.as_deref().ok_or_else(|| {
                    ApiError::bad_request(
                        "invalid_mutation",
                        "Put and move mutations require a path.",
                    )
                })?;
                sqlx::query_scalar::<_, Uuid>(
                    "SELECT record_id FROM hosted_provider_records
                     WHERE collection_id = $1 AND path_token = $2",
                )
                .bind(collection_id)
                .bind(path_token(&data_key, path))
                .fetch_optional(&mut *transaction)
                .await?
            } else {
                None
            };
            let catalog = if matches!(
                mutation.operation,
                SyncMutationOperation::Put | SyncMutationOperation::Move
            ) {
                let resources: SyncCollectionResources = self.crypto.decrypt_json(
                    &data_key,
                    collection.get("resources_ciphertext"),
                    &resources_aad(collection_id),
                )?;
                let resource_revision: String = collection.get("resource_revision");
                if resources.revision != resource_revision {
                    return Err(ApiError::internal(
                        "The encrypted resource catalog revision does not match collection metadata.",
                    ));
                }
                let resource_documents = load_resource_documents(
                    &mut transaction,
                    &self.crypto,
                    &data_key,
                    collection_id,
                )
                .await?;
                Some(compile_point_catalog(resources, resource_documents)?)
            } else {
                None
            };
            let execution = match execute_direct_sync(
                catalog.as_ref(),
                &mutation,
                current.as_ref(),
                destination_owner,
            ) {
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
            };
            let before_records = current
                .clone()
                .map(|record| BTreeMap::from([(record.record_id, record)]))
                .unwrap_or_default();
            (execution, before_records)
        };
        if let Some(result) = semantic_result {
            *result = Some(execution.envelope.clone());
        }
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
            let before = before_records.get(record_id);
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
        for (record_id, after, _) in &execution.changed {
            let before = before_records.get(record_id);
            let before_bytes = before
                .map(|record| record.document.len() as i128)
                .unwrap_or_default();
            let after_bytes = after
                .as_ref()
                .map(|record| record.document.len() as i128)
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
        let mut projection_changes = Vec::with_capacity(execution.changed.len());
        for (record_id, after, document) in execution.changed {
            head = head.checked_add(1).ok_or_else(|| {
                ApiError::internal("The hosted collection sequence is exhausted.")
            })?;
            let before = before_records.get(&record_id).cloned();
            let notification_event = notification_runtime_active
                .then(|| application_change(before.as_ref(), after.as_ref()));
            let (revision, file_mtime) = if let Some(record) = &after {
                let modified_at = persist_live_record(
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
                (
                    record.revision.clone(),
                    Some(modified_at.to_rfc3339_opts(SecondsFormat::Micros, true)),
                )
            } else {
                let before = before.as_ref().ok_or_else(|| {
                    ApiError::internal("The hosted write set deleted an unknown record.")
                })?;
                let revision = format!("hosted:1:{head}:tombstone");
                persist_deleted_record(&mut transaction, collection_id, head, before, &revision)
                    .await?;
                (revision, None)
            };
            projection_changes.push(ActiveProjectionChange {
                record_id,
                record_sequence: head,
                sequence: head,
                was_present: before.is_some(),
                force_relationship_resolution: false,
                file_mtime,
                record: after.clone(),
            });
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
            }
        }
        self.maintain_active_projection_changes(
            &mut transaction,
            collection_id,
            &data_key,
            &projection_changes,
        )
        .await?;
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
            &data_key,
            &journal,
            &receipt,
            semantic_requested.then_some(&execution.envelope),
        )
        .await?;
        transaction.commit().await?;
        self.remove_working_set(collection_id).await;
        if direct_sync {
            let memory = crate::HostedProcessMemory::capture();
            tracing::info!(
                target: "mdbase_connect::metrics",
                metric = "hosted_direct_sync_mutation",
                operation = ?mutation.operation,
                records_decrypted = u64::from(current.is_some()),
                ciphertext_bytes = current_ciphertext_bytes,
                elapsed_ms = mutation_started.elapsed().as_millis() as u64,
                database_pool_size = self.pool.size(),
                database_pool_idle = self.pool.num_idle(),
                rss_bytes = memory.rss_bytes.unwrap_or(0),
                pss_bytes = memory.pss_bytes.unwrap_or(0),
                cgroup_current_bytes = memory.cgroup_current_bytes.unwrap_or(0),
                cgroup_peak_bytes = memory.cgroup_peak_bytes.unwrap_or(0),
                "privacy-safe hosted provider metric"
            );
        }
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

include!("mutations/direct_execution.rs");
