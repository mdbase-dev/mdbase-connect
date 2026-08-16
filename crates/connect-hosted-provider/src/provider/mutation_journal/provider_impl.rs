impl HostedProvider {
    pub(super) async fn load_operation_preparation(
        &self,
        collection_id: Uuid,
        lease: &HostedMutationLease,
    ) -> ApiResult<Option<PreparedRecordOperation>> {
        let row = sqlx::query(
            r#"SELECT journal.prepared_ciphertext, collection.wrapped_data_key
               FROM hosted_provider_mutation_journal journal
               JOIN hosted_provider_replicas replica ON replica.id = journal.replica_id
               JOIN hosted_provider_collections collection ON collection.id = replica.collection_id
               WHERE journal.replica_id = $1 AND journal.request_id = $2
                 AND journal.input_digest = $3 AND replica.collection_id = $4"#,
        )
        .bind(lease.replica_id)
        .bind(lease.request_id)
        .bind(&lease.input_digest)
        .bind(collection_id)
        .fetch_optional(&self.pool)
        .await?;
        let Some(row) = row else {
            return Err(mutation_fence_lost(lease.request_id));
        };
        let Some(ciphertext) = row.get::<Option<Vec<u8>>, _>("prepared_ciphertext") else {
            return Ok(None);
        };
        let wrapped_data_key: Vec<u8> = row.get("wrapped_data_key");
        let data_key = self
            .collection_key(collection_id, &wrapped_data_key)
            .await?;
        self.crypto
            .decrypt_json(
                &data_key,
                &ciphertext,
                &hosted_mutation_prepared_aad(lease.replica_id, lease.request_id),
            )
            .map(Some)
    }

    pub(super) async fn store_operation_preparation_in(
        &self,
        transaction: &mut Transaction<'_, Postgres>,
        data_key: &[u8; 32],
        lease: &HostedMutationLease,
        prepared: &PreparedRecordOperation,
    ) -> ApiResult<()> {
        let ciphertext = self.crypto.encrypt_json(
            data_key,
            prepared,
            &hosted_mutation_prepared_aad(lease.replica_id, lease.request_id),
        )?;
        let updated = sqlx::query(
            r#"UPDATE hosted_provider_mutation_journal
               SET prepared_ciphertext = $7, updated_at = now()
               WHERE replica_id = $1 AND request_id = $2 AND input_digest = $3
                 AND process_epoch = $4 AND lease_owner = $5
                 AND fencing_generation = $6 AND state = 'prepared'
                 AND prepared_ciphertext IS NULL"#,
        )
        .bind(lease.replica_id)
        .bind(lease.request_id)
        .bind(&lease.input_digest)
        .bind(lease.process_epoch)
        .bind(lease.owner)
        .bind(lease.generation)
        .bind(ciphertext)
        .execute(&mut **transaction)
        .await?
        .rows_affected();
        if updated != 1 {
            return Err(mutation_fence_lost(lease.request_id));
        }
        Ok(())
    }

    pub async fn acknowledge_operation_mutation(
        &self,
        replica_id: Uuid,
        request_id: Uuid,
    ) -> ApiResult<()> {
        let updated = sqlx::query(
            r#"UPDATE hosted_provider_mutation_journal
               SET state = 'acknowledged', acknowledged_at = now(), updated_at = now()
               WHERE replica_id = $1 AND request_id = $2 AND state = 'completed'"#,
        )
        .bind(replica_id)
        .bind(request_id)
        .execute(&self.pool)
        .await?
        .rows_affected();
        if updated == 0 {
            let exists: bool = sqlx::query_scalar(
                r#"SELECT EXISTS (
                     SELECT 1 FROM hosted_provider_mutation_journal
                     WHERE replica_id = $1 AND request_id = $2
                       AND state = 'acknowledged'
                   )"#,
            )
            .bind(replica_id)
            .bind(request_id)
            .fetch_one(&self.pool)
            .await?;
            if !exists {
                return Err(ApiError::not_found(
                    "mutation_receipt_not_found",
                    "Completed mutation receipt not found.",
                ));
            }
        }
        Ok(())
    }

    pub async fn compact_operation_mutations(&self) -> ApiResult<u64> {
        let mut transaction = self.pool.begin().await?;
        let tombstoned = sqlx::query(
            r#"WITH eligible AS (
                 SELECT replica_id, grant_id, request_id, operation_kind,
                        fingerprint_schema_version, input_schema_version,
                        input_digest, state, receipt_digest,
                        accepted_at, completed_at
                 FROM hosted_provider_mutation_journal
                 WHERE state IN ('completed', 'acknowledged', 'abandoned')
                   AND completed_at <= now() - interval '180 days'
                   AND (acknowledged_at IS NULL
                        OR acknowledged_at <= now() - interval '30 days')
                 FOR UPDATE
               ), inserted AS (
                 INSERT INTO hosted_provider_mutation_tombstones (
                   replica_id, grant_id, request_id, operation_kind,
                   fingerprint_schema_version, input_schema_version,
                   input_digest, terminal_state,
                   receipt_digest, accepted_at, completed_at, expires_at
                 )
                 SELECT replica_id, grant_id, request_id, operation_kind,
                        fingerprint_schema_version, input_schema_version,
                        input_digest, state,
                        receipt_digest, accepted_at, completed_at,
                        now() + interval '365 days'
                 FROM eligible
                 ON CONFLICT (replica_id, request_id) DO NOTHING
                 RETURNING replica_id, request_id
               )
               DELETE FROM hosted_provider_mutation_journal journal
               USING inserted
               WHERE journal.replica_id = inserted.replica_id
                 AND journal.request_id = inserted.request_id"#,
        )
        .execute(&mut *transaction)
        .await?
        .rows_affected();
        sqlx::query(
            "DELETE FROM hosted_provider_retired_replay_credentials WHERE expires_at <= now()",
        )
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(tombstoned)
    }

    pub async fn operation_mutation_diagnostics(
        &self,
    ) -> ApiResult<HostedMutationJournalDiagnostics> {
        let rows = sqlx::query(
            "SELECT state, count(*) AS count FROM hosted_provider_mutation_journal GROUP BY state",
        )
        .fetch_all(&self.pool)
        .await?;
        let mut state_counts = BTreeMap::new();
        for row in rows {
            state_counts.insert(
                row.get::<String, _>("state"),
                number(row.get::<i64, _>("count"), "mutation journal state count")?,
            );
        }
        let oldest_unfinished_seconds: Option<i64> = sqlx::query_scalar(
            r#"SELECT extract(epoch FROM now() - min(accepted_at))::bigint
               FROM hosted_provider_mutation_journal
               WHERE state IN ('claimed', 'prepared', 'applied')"#,
        )
        .fetch_one(&self.pool)
        .await?;
        let tombstones: i64 =
            sqlx::query_scalar("SELECT count(*) FROM hosted_provider_mutation_tombstones")
                .fetch_one(&self.pool)
                .await?;
        Ok(HostedMutationJournalDiagnostics {
            state_counts,
            oldest_unfinished_seconds: oldest_unfinished_seconds
                .map(|seconds| number(seconds.max(0), "oldest unfinished mutation age"))
                .transpose()?,
            tombstones: number(tombstones, "mutation tombstone count")?,
            database_pool_size: self.pool.size(),
            database_pool_idle: self.pool.num_idle(),
        })
    }

    pub(super) async fn replay_retired_operation_mutation(
        &self,
        collection_id: Uuid,
        token: &str,
        operation: &str,
        request_id: Uuid,
        input: &Value,
        authentication_error: ApiError,
    ) -> ApiResult<Value> {
        let Some(operation_kind) =
            mdbase_connect_protocol::mutation_operation_identifier(operation, input)
        else {
            return Err(authentication_error);
        };
        let Some(input_schema_version) =
            mdbase_connect_protocol::operation_input_schema_version(operation, input)
        else {
            return Err(authentication_error);
        };
        let input_digest =
            match mdbase_connect_protocol::mutation_fingerprint_bytes(operation, input) {
                Ok(digest) => digest.to_vec(),
                Err(_) => return Err(authentication_error),
            };
        let credential_hash = token_hash(token);
        let replica_id: Option<Uuid> = sqlx::query_scalar(
            r#"SELECT replica.id
               FROM hosted_provider_replicas replica
               WHERE replica.collection_id = $1 AND replica.purpose = 'application'
                 AND (
                   replica.token_hash = $2
                   OR EXISTS (
                     SELECT 1 FROM hosted_provider_retired_replay_credentials retired
                     WHERE retired.replica_id = replica.id
                       AND retired.token_hash = $2 AND retired.expires_at > now()
                   )
                 )
               ORDER BY (replica.token_hash = $2) DESC
               LIMIT 1"#,
        )
        .bind(collection_id)
        .bind(&credential_hash)
        .fetch_optional(&self.pool)
        .await?;
        let Some(replica_id) = replica_id else {
            return Err(authentication_error);
        };
        if let Some(row) = sqlx::query(
            r#"SELECT operation_kind, fingerprint_schema_version,
                      input_schema_version, input_digest
               FROM hosted_provider_mutation_tombstones
               WHERE replica_id = $1 AND request_id = $2"#,
        )
        .bind(replica_id)
        .bind(request_id)
        .fetch_optional(&self.pool)
        .await?
        {
            let same = row.get::<String, _>("operation_kind") == operation_kind
                && row.get::<i32, _>("fingerprint_schema_version") == 1
                && row.get::<i32, _>("input_schema_version")
                    == i32::try_from(input_schema_version).unwrap_or(i32::MAX)
                && bool::from(row.get::<Vec<u8>, _>("input_digest").ct_eq(&input_digest));
            return Err(if same {
                ApiError::new(
                    StatusCode::GONE,
                    "mutation_recovery_expired",
                    "The mutation is outside the supported online recovery horizon.",
                )
            } else {
                mutation_conflict(request_id)
            });
        }
        let Some(row) = sqlx::query(
            r#"SELECT operation_kind, fingerprint_schema_version,
                      input_schema_version, input_digest, state,
                      final_receipt_ciphertext
               FROM hosted_provider_mutation_journal
               WHERE replica_id = $1 AND request_id = $2"#,
        )
        .bind(replica_id)
        .bind(request_id)
        .fetch_optional(&self.pool)
        .await?
        else {
            return Err(authentication_error);
        };
        let same = row.get::<String, _>("operation_kind") == operation_kind
            && row.get::<i32, _>("fingerprint_schema_version") == 1
            && row.get::<i32, _>("input_schema_version")
                == i32::try_from(input_schema_version).unwrap_or(i32::MAX)
            && bool::from(row.get::<Vec<u8>, _>("input_digest").ct_eq(&input_digest));
        if !same {
            return Err(mutation_conflict(request_id));
        }
        let state: String = row.get("state");
        if !matches!(
            state.as_str(),
            "completed" | "acknowledged" | "abandoned" | "outcome_unknown"
        ) {
            return Err(authentication_error);
        }
        let wrapped_data_key: Vec<u8> = sqlx::query_scalar(
            "SELECT wrapped_data_key FROM hosted_provider_collections WHERE id = $1",
        )
        .bind(collection_id)
        .fetch_one(&self.pool)
        .await?;
        let data_key = self
            .collection_key(collection_id, &wrapped_data_key)
            .await?;
        let receipt: StoredMutationReceipt = self.crypto.decrypt_json(
            &data_key,
            &row.get::<Vec<u8>, _>("final_receipt_ciphertext"),
            &hosted_mutation_receipt_aad(replica_id, request_id),
        )?;
        receipt.into_result()
    }

    pub(super) async fn claim_operation_mutation(
        &self,
        collection_id: Uuid,
        replica: &Replica,
        operation: &str,
        request_id: Uuid,
        input: &Value,
    ) -> ApiResult<HostedMutationClaim> {
        let operation_kind = mdbase_connect_protocol::mutation_operation_identifier(
            operation, input,
        )
        .ok_or_else(|| {
            ApiError::bad_request("invalid_request", "Operation is not a canonical mutation.")
        })?;
        let input_schema_version = mdbase_connect_protocol::operation_input_schema_version(
            operation, input,
        )
        .ok_or_else(|| {
            ApiError::bad_request(
                "invalid_request",
                "Mutation input schema version is unavailable.",
            )
        })?;
        let input_digest = mdbase_connect_protocol::mutation_fingerprint_bytes(operation, input)
            .map_err(|error| ApiError::bad_request("invalid_request", error.to_string()))?
            .to_vec();
        let mut transaction = self.pool.begin().await?;
        sqlx::query("SELECT id FROM hosted_provider_replicas WHERE id = $1 FOR UPDATE")
            .bind(replica.id)
            .fetch_one(&mut *transaction)
            .await?;
        let wrapped_data_key: Vec<u8> = sqlx::query_scalar(
            "SELECT wrapped_data_key FROM hosted_provider_collections WHERE id = $1 AND state = 'active' FOR SHARE",
        )
        .bind(collection_id)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or_else(|| ApiError::not_found("hosted_collection_not_found", "Hosted collection not found."))?;
        let data_key = self
            .collection_key(collection_id, &wrapped_data_key)
            .await?;

        if let Some(row) = sqlx::query(
            r#"SELECT operation_kind, fingerprint_schema_version,
                      input_schema_version, input_digest, terminal_state
               FROM hosted_provider_mutation_tombstones
               WHERE replica_id = $1 AND request_id = $2"#,
        )
        .bind(replica.id)
        .bind(request_id)
        .fetch_optional(&mut *transaction)
        .await?
        {
            let same = row.get::<String, _>("operation_kind") == operation_kind
                && row.get::<i32, _>("fingerprint_schema_version") == 1
                && row.get::<i32, _>("input_schema_version")
                    == i32::try_from(input_schema_version).unwrap_or(i32::MAX)
                && bool::from(row.get::<Vec<u8>, _>("input_digest").ct_eq(&input_digest));
            transaction.commit().await?;
            return Err(if same {
                ApiError::new(
                    StatusCode::GONE,
                    "mutation_recovery_expired",
                    "The mutation is outside the supported online recovery horizon.",
                )
            } else {
                mutation_conflict(request_id)
            });
        }

        if let Some(row) = sqlx::query(
            r#"SELECT operation_kind, fingerprint_schema_version,
                      input_schema_version, input_digest, state,
                      process_epoch, lease_expires_at, fencing_generation,
                      prepared_head, evidence_ciphertext, evidence_kind,
                      final_receipt_ciphertext
               FROM hosted_provider_mutation_journal
               WHERE replica_id = $1 AND request_id = $2 FOR UPDATE"#,
        )
        .bind(replica.id)
        .bind(request_id)
        .fetch_optional(&mut *transaction)
        .await?
        {
            let same = row.get::<String, _>("operation_kind") == operation_kind
                && row.get::<i32, _>("fingerprint_schema_version") == 1
                && row.get::<i32, _>("input_schema_version")
                    == i32::try_from(input_schema_version).unwrap_or(i32::MAX)
                && bool::from(row.get::<Vec<u8>, _>("input_digest").ct_eq(&input_digest));
            if !same {
                return Err(mutation_conflict(request_id));
            }
            let state: String = row.get("state");
            if matches!(
                state.as_str(),
                "completed" | "acknowledged" | "abandoned" | "outcome_unknown"
            ) {
                let ciphertext: Vec<u8> = row.get("final_receipt_ciphertext");
                let receipt: StoredMutationReceipt = self.crypto.decrypt_json(
                    &data_key,
                    &ciphertext,
                    &hosted_mutation_receipt_aad(replica.id, request_id),
                )?;
                transaction.commit().await?;
                return Ok(HostedMutationClaim::Terminal(receipt.into_result()));
            }
            let lease_expires_at: DateTime<Utc> = row.get("lease_expires_at");
            if lease_expires_at > Utc::now() {
                transaction.commit().await?;
                return Ok(HostedMutationClaim::Live);
            }
            let owner = Uuid::new_v4();
            let previous_generation: i64 = row.get("fencing_generation");
            let generation = previous_generation.checked_add(1).ok_or_else(|| {
                ApiError::internal("Hosted mutation fencing generation is exhausted.")
            })?;
            let updated = sqlx::query(
                r#"UPDATE hosted_provider_mutation_journal
                   SET process_epoch = $3, lease_owner = $4,
                       lease_expires_at = now() + ($5 * interval '1 second'),
                       fencing_generation = $6, updated_at = now()
                   WHERE replica_id = $1 AND request_id = $2
                     AND fencing_generation = $7
                     AND state IN ('claimed', 'prepared', 'applied')"#,
            )
            .bind(replica.id)
            .bind(request_id)
            .bind(self.process_epoch)
            .bind(owner)
            .bind(MUTATION_LEASE_SECONDS)
            .bind(generation)
            .bind(previous_generation)
            .execute(&mut *transaction)
            .await?
            .rows_affected();
            if updated != 1 {
                return Err(mutation_fence_lost(request_id));
            }
            let prepared_head = number(
                row.get::<Option<i64>, _>("prepared_head")
                    .ok_or_else(|| ApiError::internal("Hosted mutation has no prepared head."))?,
                "prepared mutation head",
            )?;
            let applied_result = if state == "applied"
                && row.get::<Option<String>, _>("evidence_kind").as_deref() == Some("public_result")
            {
                let ciphertext = row
                    .get::<Option<Vec<u8>>, _>("evidence_ciphertext")
                    .ok_or_else(|| {
                        ApiError::internal("Applied hosted mutation has no result evidence.")
                    })?;
                let receipt: StoredMutationReceipt = self.crypto.decrypt_json(
                    &data_key,
                    &ciphertext,
                    &hosted_mutation_applied_aad(replica.id, request_id),
                )?;
                Some(receipt.into_result())
            } else {
                None
            };
            transaction.commit().await?;
            return Ok(HostedMutationClaim::Owned {
                lease: HostedMutationLease {
                    replica_id: replica.id,
                    request_id,
                    input_digest,
                    process_epoch: self.process_epoch,
                    owner,
                    generation,
                },
                prepared_head,
                takeover: true,
                applied_result,
            });
        }

        let prepared_head: i64 = sqlx::query_scalar(
            "SELECT head FROM hosted_provider_collections WHERE id = $1 AND state = 'active' FOR SHARE",
        )
        .bind(collection_id)
        .fetch_one(&mut *transaction)
        .await?;
        let owner = Uuid::new_v4();
        sqlx::query(
            r#"INSERT INTO hosted_provider_mutation_journal (
                 replica_id, grant_id, request_id, operation_kind,
                 input_schema_version, input_digest, state, process_epoch,
                 lease_owner, lease_expires_at, fencing_generation, prepared_head
               ) VALUES ($1, $2, $3, $4, $5, $6, 'prepared', $7, $8,
                         now() + ($9 * interval '1 second'), 1, $10)"#,
        )
        .bind(replica.id)
        .bind(replica.grant_id)
        .bind(request_id)
        .bind(operation_kind)
        .bind(i32::try_from(input_schema_version).map_err(|_| {
            ApiError::bad_request(
                "invalid_request",
                "Mutation input schema version is too large.",
            )
        })?)
        .bind(&input_digest)
        .bind(self.process_epoch)
        .bind(owner)
        .bind(MUTATION_LEASE_SECONDS)
        .bind(prepared_head)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(HostedMutationClaim::Owned {
            lease: HostedMutationLease {
                replica_id: replica.id,
                request_id,
                input_digest,
                process_epoch: self.process_epoch,
                owner,
                generation: 1,
            },
            prepared_head: number(prepared_head, "prepared mutation head")?,
            takeover: false,
            applied_result: None,
        })
    }

    pub(super) async fn claim_sync_mutation(
        &self,
        collection_id: Uuid,
        replica: &Replica,
        mutation: &SyncMutation,
    ) -> ApiResult<HostedMutationClaim> {
        if let Some(row) = sqlx::query(
            r#"SELECT fingerprint_schema_version, operation_kind, input_digest
               FROM hosted_provider_mutation_tombstones
               WHERE replica_id = $1 AND request_id = $2"#,
        )
        .bind(replica.id)
        .bind(mutation.mutation_id)
        .fetch_optional(&self.pool)
        .await?
        {
            if row.get::<i32, _>("fingerprint_schema_version") == 0 {
                let same = row.get::<String, _>("operation_kind") == "sync:mutate"
                    && bool::from(
                        row.get::<Vec<u8>, _>("input_digest")
                            .ct_eq(&mutation_hash(mutation)?),
                    );
                return Err(if same {
                    ApiError::new(
                        StatusCode::GONE,
                        "mutation_recovery_expired",
                        "The mutation is outside the supported online recovery horizon.",
                    )
                } else {
                    mutation_conflict(mutation.mutation_id)
                });
            }
        }
        if let Some(row) = sqlx::query(
            r#"SELECT fingerprint_schema_version, operation_kind, input_digest,
                      state, final_receipt_ciphertext
               FROM hosted_provider_mutation_journal
               WHERE replica_id = $1 AND request_id = $2"#,
        )
        .bind(replica.id)
        .bind(mutation.mutation_id)
        .fetch_optional(&self.pool)
        .await?
        {
            if row.get::<i32, _>("fingerprint_schema_version") == 0 {
                let same = row.get::<String, _>("operation_kind") == "sync:mutate"
                    && bool::from(
                        row.get::<Vec<u8>, _>("input_digest")
                            .ct_eq(&mutation_hash(mutation)?),
                    );
                if !same {
                    return Err(mutation_conflict(mutation.mutation_id));
                }
                let state: String = row.get("state");
                if !matches!(state.as_str(), "completed" | "acknowledged") {
                    return Err(ApiError::internal(
                        "Migrated sync receipt is not in a terminal state.",
                    ));
                }
                let wrapped_data_key: Vec<u8> = sqlx::query_scalar(
                    "SELECT wrapped_data_key FROM hosted_provider_collections WHERE id = $1",
                )
                .bind(collection_id)
                .fetch_one(&self.pool)
                .await?;
                let data_key = self
                    .collection_key(collection_id, &wrapped_data_key)
                    .await?;
                let receipt: StoredMutationReceipt = self.crypto.decrypt_json(
                    &data_key,
                    &row.get::<Vec<u8>, _>("final_receipt_ciphertext"),
                    &hosted_mutation_receipt_aad(replica.id, mutation.mutation_id),
                )?;
                return Ok(HostedMutationClaim::Terminal(receipt.into_result()));
            }
        }
        self.claim_operation_mutation(
            collection_id,
            replica,
            "sync",
            mutation.mutation_id,
            &json!({ "action": "mutate", "mutation": mutation }),
        )
        .await
    }

    pub(super) async fn mark_operation_mutation_applied_in(
        &self,
        transaction: &mut Transaction<'_, Postgres>,
        data_key: &[u8; 32],
        lease: &HostedMutationLease,
        result: &ApiResult<Value>,
    ) -> ApiResult<()> {
        let receipt = StoredMutationReceipt::from_result(result);
        let plaintext = serde_json::to_vec(&receipt).map_err(|error| {
            ApiError::internal(format!(
                "Hosted mutation applied result could not serialize: {error}"
            ))
        })?;
        let ciphertext = self.crypto.encrypt_bytes(
            data_key,
            &plaintext,
            &hosted_mutation_applied_aad(lease.replica_id, lease.request_id),
        )?;
        let updated = sqlx::query(
            r#"UPDATE hosted_provider_mutation_journal
               SET state = 'applied', evidence_ciphertext = $7,
                   evidence_kind = 'public_result', effect_applied = true,
                   updated_at = now()
               WHERE replica_id = $1 AND request_id = $2 AND input_digest = $3
                 AND process_epoch = $4 AND lease_owner = $5
                 AND fencing_generation = $6 AND state = 'prepared'"#,
        )
        .bind(lease.replica_id)
        .bind(lease.request_id)
        .bind(&lease.input_digest)
        .bind(lease.process_epoch)
        .bind(lease.owner)
        .bind(lease.generation)
        .bind(ciphertext)
        .execute(&mut **transaction)
        .await?
        .rows_affected();
        if updated != 1 {
            return Err(mutation_fence_lost(lease.request_id));
        }
        Ok(())
    }

    pub(super) async fn store_sync_effect_in(
        &self,
        transaction: &mut Transaction<'_, Postgres>,
        data_key: &[u8; 32],
        lease: &HostedMutationLease,
        receipt: &SyncMutationReceipt,
        semantic_result: Option<&OperationResult>,
        public_result: bool,
    ) -> ApiResult<()> {
        if public_result {
            let value = serde_json::to_value(receipt).map_err(|error| {
                ApiError::internal(format!("Sync receipt could not serialize: {error}"))
            })?;
            let stored = StoredMutationReceipt::Success { value };
            let plaintext = serde_json::to_vec(&stored).map_err(|error| {
                ApiError::internal(format!("Sync applied result could not serialize: {error}"))
            })?;
            let ciphertext = self.crypto.encrypt_bytes(
                data_key,
                &plaintext,
                &hosted_mutation_applied_aad(lease.replica_id, lease.request_id),
            )?;
            return self
                .store_sync_evidence_update(
                    transaction,
                    lease,
                    ciphertext,
                    "public_result",
                    sync_receipt_applied(receipt),
                )
                .await;
        }
        let ciphertext = self.crypto.encrypt_json(
            data_key,
            &StoredSyncEffect {
                schema_version: 1,
                receipt: receipt.clone(),
                semantic_result: semantic_result.cloned(),
            },
            &hosted_sync_effect_aad(lease.replica_id, lease.request_id),
        )?;
        self.store_sync_evidence_update(
            transaction,
            lease,
            ciphertext,
            "sync_effect",
            sync_receipt_applied(receipt),
        )
        .await
    }

    async fn store_sync_evidence_update(
        &self,
        transaction: &mut Transaction<'_, Postgres>,
        lease: &HostedMutationLease,
        ciphertext: Vec<u8>,
        evidence_kind: &str,
        effect_applied: bool,
    ) -> ApiResult<()> {
        let updated = sqlx::query(
            r#"UPDATE hosted_provider_mutation_journal
               SET state = 'applied', evidence_ciphertext = $7,
                   evidence_kind = $8, effect_applied = $9, updated_at = now()
               WHERE replica_id = $1 AND request_id = $2 AND input_digest = $3
                 AND process_epoch = $4 AND lease_owner = $5
                 AND fencing_generation = $6 AND state = 'prepared'"#,
        )
        .bind(lease.replica_id)
        .bind(lease.request_id)
        .bind(&lease.input_digest)
        .bind(lease.process_epoch)
        .bind(lease.owner)
        .bind(lease.generation)
        .bind(ciphertext)
        .bind(evidence_kind)
        .bind(effect_applied)
        .execute(&mut **transaction)
        .await?
        .rows_affected();
        if updated != 1 {
            return Err(mutation_fence_lost(lease.request_id));
        }
        Ok(())
    }

    pub(super) async fn load_sync_effect(
        &self,
        collection_id: Uuid,
        lease: &HostedMutationLease,
    ) -> ApiResult<Option<(SyncMutationReceipt, Option<OperationResult>)>> {
        let row = sqlx::query(
            r#"SELECT journal.state, journal.evidence_kind,
                      journal.evidence_ciphertext, collection.wrapped_data_key
               FROM hosted_provider_mutation_journal journal
               JOIN hosted_provider_replicas replica ON replica.id = journal.replica_id
               JOIN hosted_provider_collections collection ON collection.id = replica.collection_id
               WHERE journal.replica_id = $1 AND journal.request_id = $2
                 AND journal.input_digest = $3 AND replica.collection_id = $4"#,
        )
        .bind(lease.replica_id)
        .bind(lease.request_id)
        .bind(&lease.input_digest)
        .bind(collection_id)
        .fetch_optional(&self.pool)
        .await?;
        let Some(row) = row else {
            return Err(mutation_fence_lost(lease.request_id));
        };
        if row.get::<String, _>("state") != "applied"
            || row.get::<Option<String>, _>("evidence_kind").as_deref() != Some("sync_effect")
        {
            return Ok(None);
        }
        let data_key = self
            .collection_key(collection_id, row.get("wrapped_data_key"))
            .await?;
        let stored: CompatibleStoredSyncEffect = self.crypto.decrypt_json(
            &data_key,
            &row.get::<Vec<u8>, _>("evidence_ciphertext"),
            &hosted_sync_effect_aad(lease.replica_id, lease.request_id),
        )?;
        Ok(Some(match stored {
            CompatibleStoredSyncEffect::Current(effect) => {
                if effect.schema_version != 1 {
                    return Err(ApiError::internal(
                        "Stored hosted sync effect has an unsupported schema version.",
                    ));
                }
                (effect.receipt, effect.semantic_result)
            }
            CompatibleStoredSyncEffect::Legacy(receipt) => (receipt, None),
        }))
    }

    pub(super) async fn complete_operation_mutation(
        &self,
        collection_id: Uuid,
        lease: &HostedMutationLease,
        result: &ApiResult<Value>,
    ) -> ApiResult<()> {
        let wrapped_data_key: Vec<u8> = sqlx::query_scalar(
            "SELECT wrapped_data_key FROM hosted_provider_collections WHERE id = $1",
        )
        .bind(collection_id)
        .fetch_one(&self.pool)
        .await?;
        let data_key = self
            .collection_key(collection_id, &wrapped_data_key)
            .await?;
        let receipt = StoredMutationReceipt::from_result(result);
        let plaintext = serde_json::to_vec(&receipt).map_err(|error| {
            ApiError::internal(format!(
                "Hosted mutation receipt could not serialize: {error}"
            ))
        })?;
        let ciphertext = self.crypto.encrypt_bytes(
            &data_key,
            &plaintext,
            &hosted_mutation_receipt_aad(lease.replica_id, lease.request_id),
        )?;
        let receipt_digest = Sha256::digest(&plaintext).to_vec();
        let updated = sqlx::query(
            r#"UPDATE hosted_provider_mutation_journal
               SET state = 'completed', final_receipt_ciphertext = $7,
                   receipt_digest = $8, completed_at = now(), updated_at = now(),
                   lease_expires_at = now()
               WHERE replica_id = $1 AND request_id = $2 AND input_digest = $3
                 AND process_epoch = $4 AND lease_owner = $5
                 AND fencing_generation = $6
                 AND state IN ('claimed', 'prepared', 'applied')"#,
        )
        .bind(lease.replica_id)
        .bind(lease.request_id)
        .bind(&lease.input_digest)
        .bind(lease.process_epoch)
        .bind(lease.owner)
        .bind(lease.generation)
        .bind(ciphertext)
        .bind(receipt_digest)
        .execute(&self.pool)
        .await?
        .rows_affected();
        if updated != 1 {
            return Err(mutation_fence_lost(lease.request_id));
        }
        Ok(())
    }

    pub(super) async fn current_collection_head(&self, collection_id: Uuid) -> ApiResult<u64> {
        let head: i64 =
            sqlx::query_scalar("SELECT head FROM hosted_provider_collections WHERE id = $1")
                .bind(collection_id)
                .fetch_one(&self.pool)
                .await?;
        number(head, "collection head")
    }

    pub(super) async fn mark_operation_mutation_unknown(
        &self,
        collection_id: Uuid,
        lease: &HostedMutationLease,
    ) -> ApiResult<Value> {
        outcome_unknown();
        let result = Err(ApiError::conflict(
            "operation_outcome_unknown",
            "The hosted mutation may have applied, but its exact result cannot be recovered safely.",
        )
        .with_details(json!({ "request_id": lease.request_id })));
        self.finish_operation_mutation(collection_id, lease, &result, "outcome_unknown")
            .await?;
        result
    }

    async fn finish_operation_mutation(
        &self,
        collection_id: Uuid,
        lease: &HostedMutationLease,
        result: &ApiResult<Value>,
        state: &str,
    ) -> ApiResult<()> {
        let wrapped_data_key: Vec<u8> = sqlx::query_scalar(
            "SELECT wrapped_data_key FROM hosted_provider_collections WHERE id = $1",
        )
        .bind(collection_id)
        .fetch_one(&self.pool)
        .await?;
        let data_key = self
            .collection_key(collection_id, &wrapped_data_key)
            .await?;
        let receipt = StoredMutationReceipt::from_result(result);
        let plaintext = serde_json::to_vec(&receipt).map_err(|error| {
            ApiError::internal(format!(
                "Hosted mutation receipt could not serialize: {error}"
            ))
        })?;
        let ciphertext = self.crypto.encrypt_bytes(
            &data_key,
            &plaintext,
            &hosted_mutation_receipt_aad(lease.replica_id, lease.request_id),
        )?;
        let updated = sqlx::query(
            r#"UPDATE hosted_provider_mutation_journal
               SET state = $7, final_receipt_ciphertext = $8,
                   receipt_digest = $9, completed_at = now(), updated_at = now(),
                   lease_expires_at = now()
               WHERE replica_id = $1 AND request_id = $2 AND input_digest = $3
                 AND process_epoch = $4 AND lease_owner = $5
                 AND fencing_generation = $6 AND state IN ('prepared', 'applied')"#,
        )
        .bind(lease.replica_id)
        .bind(lease.request_id)
        .bind(&lease.input_digest)
        .bind(lease.process_epoch)
        .bind(lease.owner)
        .bind(lease.generation)
        .bind(state)
        .bind(ciphertext)
        .bind(Sha256::digest(&plaintext).to_vec())
        .execute(&self.pool)
        .await?
        .rows_affected();
        if updated != 1 {
            return Err(mutation_fence_lost(lease.request_id));
        }
        Ok(())
    }
}

