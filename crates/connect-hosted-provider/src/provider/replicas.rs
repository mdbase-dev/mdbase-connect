use super::*;

impl HostedProvider {
    pub async fn register_replica(
        &self,
        collection_id: Uuid,
        mut input: RegisterReplica,
    ) -> ApiResult<()> {
        if input.name.trim().is_empty() || input.token.len() < 32 {
            return Err(ApiError::bad_request(
                "invalid_replica",
                "Replica name and credential are required.",
            ));
        }
        input.allowed_types.sort();
        input.allowed_types.dedup();
        input.allowed_operations.sort();
        input.allowed_operations.dedup();
        validate_replica_capability(&input)?;
        let file_capability = input
            .file_capability
            .as_ref()
            .map(serde_json::to_value)
            .transpose()
            .map_err(|error| {
                ApiError::internal(format!("File capability could not be serialized: {error}"))
            })?;
        let contract_scope = serde_json::to_value(&input.contract_scope).map_err(|error| {
            ApiError::internal(format!("Contract scope could not be serialized: {error}"))
        })?;
        let token_ttl_seconds = input.token_ttl_seconds.unwrap_or(30 * 24 * 60 * 60);
        if !(60..=30 * 24 * 60 * 60).contains(&token_ttl_seconds) {
            return Err(ApiError::bad_request(
                "invalid_replica_ttl",
                "Replica credential lifetime must be between one minute and 30 days.",
            ));
        }
        let mode = replica_mode(input.mode);
        let purpose = replica_purpose(input.purpose);
        let name = input.name.trim().to_string();
        let requested_token_hash = token_hash(&input.token);
        let mut transaction = self.pool.begin().await?;
        let collection = sqlx::query(
            r#"SELECT max_mirror_replicas, max_application_replicas
               FROM hosted_provider_collections WHERE id = $1 FOR UPDATE"#,
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
        let (max_replicas, quota_code, quota_message) = match input.purpose {
            ReplicaPurpose::Mirror => (
                number(
                    collection.get::<i64, _>("max_mirror_replicas"),
                    "mirror replica quota",
                )?,
                "mirror_replica_quota_exceeded",
                "The hosted collection has reached its active mirror replica limit.",
            ),
            ReplicaPurpose::Application => (
                number(
                    collection.get::<i64, _>("max_application_replicas"),
                    "application replica quota",
                )?,
                "application_replica_quota_exceeded",
                "The hosted collection has reached its active application replica limit.",
            ),
        };
        if let Some(existing) = sqlx::query(
            r#"SELECT collection_id, name, purpose, mode, allowed_types, contract_scope,
                      full_collection,
                      allowed_operations, file_capability, allowed_origin, proof_public_key, grant_id,
                      application_declaration_id, application_declaration_digest,
                      token_hash, revoked_at
               FROM hosted_provider_replicas WHERE id = $1 FOR UPDATE"#,
        )
        .bind(input.replica_id)
        .fetch_optional(&mut *transaction)
        .await?
        {
            let existing_hash: Vec<u8> = existing.get("token_hash");
            let exact_match = existing.get::<Uuid, _>("collection_id") == collection_id
                && existing.get::<String, _>("name") == name
                && existing.get::<String, _>("purpose") == purpose
                && existing.get::<String, _>("mode") == mode
                && existing.get::<Vec<String>, _>("allowed_types") == input.allowed_types
                && existing.get::<Value, _>("contract_scope") == contract_scope
                && existing.get::<bool, _>("full_collection") == input.full_collection
                && existing.get::<Vec<String>, _>("allowed_operations") == input.allowed_operations
                && existing.get::<Option<Value>, _>("file_capability") == file_capability
                && existing
                    .get::<Option<String>, _>("allowed_origin")
                    .as_deref()
                    == input.allowed_origin.as_deref()
                && existing
                    .get::<Option<String>, _>("proof_public_key")
                    .as_deref()
                    == input.proof_public_key.as_deref()
                && existing.get::<Option<Uuid>, _>("grant_id") == input.grant_id
                && existing
                    .get::<Option<String>, _>("application_declaration_id")
                    .as_deref()
                    == input.application_declaration_id.as_deref()
                && existing
                    .get::<Option<String>, _>("application_declaration_digest")
                    .as_deref()
                    == input.application_declaration_digest.as_deref()
                && existing
                    .get::<Option<chrono::DateTime<Utc>>, _>("revoked_at")
                    .is_none()
                && existing_hash.len() == requested_token_hash.len()
                && bool::from(existing_hash.as_slice().ct_eq(&requested_token_hash));
            if exact_match {
                transaction.commit().await?;
                return Ok(());
            }
            return Err(ApiError::conflict(
                "replica_conflict",
                "Replica already exists with a different capability.",
            ));
        }
        let replica_count: i64 = sqlx::query_scalar(
            r#"SELECT count(*) FROM hosted_provider_replicas
               WHERE collection_id = $1 AND purpose = $2 AND revoked_at IS NULL"#,
        )
        .bind(collection_id)
        .bind(replica_purpose(input.purpose))
        .fetch_one(&mut *transaction)
        .await?;
        if number(replica_count, "replica count")? >= max_replicas {
            return Err(ApiError::quota(quota_code, quota_message));
        }
        let result = sqlx::query(
            r#"INSERT INTO hosted_provider_replicas
                 (id, collection_id, name, purpose, mode, allowed_types, contract_scope,
                  full_collection,
                  allowed_operations, file_capability, allowed_origin, proof_public_key, grant_id,
                  application_declaration_id, application_declaration_digest, token_hash,
                  token_expires_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                       $14, $15, $16, now() + ($17 * interval '1 second'))"#,
        )
        .bind(input.replica_id)
        .bind(collection_id)
        .bind(name)
        .bind(purpose)
        .bind(mode)
        .bind(input.allowed_types)
        .bind(contract_scope)
        .bind(input.full_collection)
        .bind(input.allowed_operations)
        .bind(file_capability)
        .bind(input.allowed_origin)
        .bind(input.proof_public_key)
        .bind(input.grant_id)
        .bind(input.application_declaration_id)
        .bind(input.application_declaration_digest)
        .bind(requested_token_hash)
        .bind(to_i64(token_ttl_seconds, "replica credential lifetime")?)
        .execute(&mut *transaction)
        .await;
        match result {
            Ok(_) => {
                transaction.commit().await?;
                Ok(())
            }
            Err(sqlx::Error::Database(error)) if error.is_foreign_key_violation() => {
                Err(ApiError::not_found(
                    "hosted_collection_not_found",
                    "Hosted collection not found.",
                ))
            }
            Err(sqlx::Error::Database(error)) if error.is_unique_violation() => Err(
                ApiError::conflict("replica_conflict", "Replica already exists."),
            ),
            Err(error) => Err(error.into()),
        }
    }

    pub async fn replica_statuses(
        &self,
        collection_id: Uuid,
    ) -> ApiResult<Vec<ProviderReplicaStatus>> {
        let rows = sqlx::query(
            r#"SELECT replica.id, collection.head, replica.acknowledged_sequence,
                      replica.last_seen_at, replica.token_expires_at
               FROM hosted_provider_replicas replica
               JOIN hosted_provider_collections collection
                 ON collection.id = replica.collection_id
               WHERE replica.collection_id = $1
                 AND replica.purpose = 'mirror'
                 AND replica.revoked_at IS NULL
               ORDER BY replica.created_at"#,
        )
        .bind(collection_id)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| {
                Ok(ProviderReplicaStatus {
                    id: row.get("id"),
                    head: number(row.get::<i64, _>("head"), "collection head")?,
                    acknowledged_sequence: number(
                        row.get::<i64, _>("acknowledged_sequence"),
                        "acknowledged sequence",
                    )?,
                    last_seen_at: row.get("last_seen_at"),
                    token_expires_at: row.get("token_expires_at"),
                })
            })
            .collect()
    }

    pub async fn rotate_replica_token(
        &self,
        replica_id: Uuid,
        token: &str,
        token_ttl_seconds: Option<u64>,
    ) -> ApiResult<()> {
        if token.len() < 32 {
            return Err(ApiError::bad_request(
                "invalid_replica_token",
                "Replica credential is too short.",
            ));
        }
        let token_ttl_seconds = token_ttl_seconds.unwrap_or(30 * 24 * 60 * 60);
        if !(60..=30 * 24 * 60 * 60).contains(&token_ttl_seconds) {
            return Err(ApiError::bad_request(
                "invalid_replica_ttl",
                "Replica credential lifetime must be between one minute and 30 days.",
            ));
        }
        let mut transaction = self.pool.begin().await?;
        archive_application_replay_credential(&mut transaction, replica_id).await?;
        let result = sqlx::query(
            r#"UPDATE hosted_provider_replicas
               SET token_hash = $2, token_expires_at = now() + ($3 * interval '1 second')
               WHERE id = $1 AND revoked_at IS NULL"#,
        )
        .bind(replica_id)
        .bind(token_hash(token))
        .bind(to_i64(token_ttl_seconds, "replica credential lifetime")?)
        .execute(&mut *transaction)
        .await?;
        if result.rows_affected() == 0 {
            return Err(ApiError::not_found(
                "replica_not_found",
                "Active replica not found.",
            ));
        }
        transaction.commit().await?;
        Ok(())
    }

    pub async fn authorize_request(
        &self,
        collection_id: Uuid,
        token: &str,
        request_origin: Option<&str>,
        proof: Option<&AuthorityRequestProof>,
    ) -> ApiResult<()> {
        // Originless mirror traffic is authenticated again inside the requested
        // operation. Avoid a duplicate database round trip for that hot path.
        // Application capabilities with an allowed origin still fail closed in
        // the operation-level origin check when the header is omitted.
        if request_origin.is_none() && proof.is_none() {
            return Ok(());
        }
        let mut transaction = self.pool.begin().await?;
        let row = sqlx::query(
            r#"SELECT id, purpose, mode, allowed_types, contract_scope, full_collection, allowed_operations, file_capability,
                      allowed_origin, proof_public_key, grant_id, scope_epoch
               FROM hosted_provider_replicas
               WHERE collection_id = $1 AND token_hash = $2
                 AND revoked_at IS NULL AND token_expires_at > now()
               FOR SHARE"#,
        )
        .bind(collection_id)
        .bind(token_hash(token))
        .fetch_optional(&mut *transaction)
        .await?;
        let replica = if row.is_some() {
            replica_from_row(row)?
        } else {
            let retired = sqlx::query(
                r#"SELECT replica.id, replica.purpose, replica.mode,
                          replica.allowed_types, replica.contract_scope,
                          replica.full_collection, replica.allowed_operations,
                          replica.file_capability, retired.allowed_origin,
                          retired.proof_public_key, replica.grant_id, replica.scope_epoch
                   FROM hosted_provider_retired_replay_credentials retired
                   JOIN hosted_provider_replicas replica ON replica.id = retired.replica_id
                   WHERE replica.collection_id = $1 AND replica.purpose = 'application'
                     AND retired.token_hash = $2 AND retired.expires_at > now()
                   ORDER BY retired.retired_at DESC LIMIT 1
                   FOR SHARE OF replica"#,
            )
            .bind(collection_id)
            .bind(token_hash(token))
            .fetch_optional(&mut *transaction)
            .await?;
            replica_from_row(retired)?
        };
        match replica.purpose {
            ReplicaPurpose::Mirror => {
                if request_origin.is_some() || proof.is_some() {
                    return Err(ApiError::forbidden(
                        "origin_denied",
                        "Mirror credentials cannot be used by browser applications.",
                    ));
                }
            }
            ReplicaPurpose::Application => {
                authorize_application_origin(&replica, request_origin)?;
                if let Some(public_key) = replica.proof_public_key.as_deref() {
                    let proof = proof.ok_or_else(|| {
                        ApiError::unauthorized(
                            "authority_proof_required",
                            "The hosted capability requires proof from its approved application key.",
                        )
                    })?;
                    verify_hosted_request_proof(public_key, token, proof)?;
                    let inserted = sqlx::query(
                        r#"INSERT INTO hosted_provider_request_proofs (replica_id, nonce)
                           VALUES ($1, $2)
                           ON CONFLICT (replica_id, nonce) DO NOTHING
                           RETURNING nonce"#,
                    )
                    .bind(replica.id)
                    .bind(proof.nonce)
                    .fetch_optional(&mut *transaction)
                    .await?;
                    if inserted.is_none() {
                        return Err(ApiError::unauthorized(
                            "authority_proof_replayed",
                            "The authority request proof has already been used.",
                        ));
                    }
                    sqlx::query(
                        "DELETE FROM hosted_provider_request_proofs WHERE created_at < now() - interval '10 minutes'",
                    )
                    .execute(&mut *transaction)
                    .await?;
                }
            }
        }
        transaction.commit().await?;
        Ok(())
    }

    pub async fn update_application_replica(
        &self,
        replica_id: Uuid,
        mut input: UpdateApplicationReplica,
    ) -> ApiResult<()> {
        input.allowed_types.sort();
        input.allowed_types.dedup();
        input.allowed_operations.sort();
        input.allowed_operations.dedup();
        validate_replica_capability(&RegisterReplica {
            replica_id,
            name: "updated application capability".to_owned(),
            purpose: ReplicaPurpose::Application,
            mode: input.mode,
            allowed_types: input.allowed_types.clone(),
            contract_scope: input.contract_scope.clone(),
            full_collection: input.full_collection,
            allowed_operations: input.allowed_operations.clone(),
            file_capability: input.file_capability.clone(),
            allowed_origin: input.allowed_origin.clone(),
            proof_public_key: input.proof_public_key.clone(),
            grant_id: Some(input.grant_id),
            application_declaration_id: Some(input.application_declaration_id.clone()),
            application_declaration_digest: Some(input.application_declaration_digest.clone()),
            token: "unused".to_owned(),
            token_ttl_seconds: None,
        })?;
        let contract_scope = serde_json::to_value(&input.contract_scope).map_err(|error| {
            ApiError::internal(format!("Contract scope could not be serialized: {error}"))
        })?;
        let file_capability = input
            .file_capability
            .as_ref()
            .map(serde_json::to_value)
            .transpose()
            .map_err(|error| {
                ApiError::internal(format!("File capability could not be serialized: {error}"))
            })?;
        let mut transaction = self.pool.begin().await?;
        archive_application_replay_credential(&mut transaction, replica_id).await?;
        let result = sqlx::query(
            r#"UPDATE hosted_provider_replicas
               SET scope_epoch = scope_epoch + CASE
                     WHEN mode IS DISTINCT FROM $2
                       OR allowed_types IS DISTINCT FROM $3
                       OR contract_scope IS DISTINCT FROM $4
                       OR full_collection IS DISTINCT FROM $5
                       OR allowed_operations IS DISTINCT FROM $6
                       OR file_capability IS DISTINCT FROM $7
                       OR grant_id IS DISTINCT FROM $8
                       OR allowed_origin IS DISTINCT FROM $9
                       OR proof_public_key IS DISTINCT FROM $10
                       OR application_declaration_id IS DISTINCT FROM $11
                       OR application_declaration_digest IS DISTINCT FROM $12
                     THEN 1 ELSE 0 END,
                   mode = $2,
                   allowed_types = $3,
                   contract_scope = $4,
                   full_collection = $5,
                   allowed_operations = $6,
                   file_capability = $7,
                   grant_id = $8,
                   allowed_origin = $9,
                   proof_public_key = $10,
                   application_declaration_id = $11,
                   application_declaration_digest = $12
               WHERE id = $1 AND purpose = 'application' AND revoked_at IS NULL"#,
        )
        .bind(replica_id)
        .bind(replica_mode(input.mode))
        .bind(input.allowed_types)
        .bind(contract_scope)
        .bind(input.full_collection)
        .bind(input.allowed_operations)
        .bind(file_capability)
        .bind(input.grant_id)
        .bind(input.allowed_origin)
        .bind(input.proof_public_key)
        .bind(input.application_declaration_id)
        .bind(input.application_declaration_digest)
        .execute(&mut *transaction)
        .await?;
        if result.rows_affected() == 0 {
            return Err(ApiError::not_found(
                "replica_not_found",
                "Active application capability not found.",
            ));
        }
        transaction.commit().await?;
        Ok(())
    }

    pub async fn revoke_replica(&self, replica_id: Uuid) -> ApiResult<()> {
        let mut transaction = self.pool.begin().await?;
        archive_application_replay_credential(&mut transaction, replica_id).await?;
        sqlx::query(
            "UPDATE hosted_provider_replicas SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL",
        )
        .bind(replica_id)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(())
    }

    pub(super) async fn authenticate_for(
        &self,
        collection_id: Uuid,
        token: &str,
        purpose: ReplicaPurpose,
    ) -> ApiResult<Replica> {
        let row = sqlx::query(
            r#"SELECT id, purpose, mode, allowed_types, contract_scope, full_collection, allowed_operations, file_capability,
                      allowed_origin, proof_public_key, grant_id, scope_epoch
               FROM hosted_provider_replicas
               WHERE collection_id = $1 AND token_hash = $2 AND purpose = $3
                 AND revoked_at IS NULL AND token_expires_at > now()"#,
        )
        .bind(collection_id)
        .bind(token_hash(token))
        .bind(replica_purpose(purpose))
        .fetch_optional(&self.pool)
        .await?;
        replica_from_row(row)
    }

    pub(super) async fn authenticate_for_sync(
        &self,
        collection_id: Uuid,
        token: &str,
        required_operation: &str,
        request_origin: Option<&str>,
    ) -> ApiResult<Replica> {
        let row = sqlx::query(
            r#"SELECT id, purpose, mode, allowed_types, contract_scope, full_collection, allowed_operations, file_capability,
                      allowed_origin, proof_public_key, grant_id, scope_epoch
               FROM hosted_provider_replicas
               WHERE collection_id = $1 AND token_hash = $2
                 AND revoked_at IS NULL AND token_expires_at > now()"#,
        )
        .bind(collection_id)
        .bind(token_hash(token))
        .fetch_optional(&self.pool)
        .await?;
        let replica = replica_from_row(row)?;
        authorize_sync_access(&replica, required_operation, request_origin)?;
        Ok(replica)
    }
}

async fn archive_application_replay_credential(
    transaction: &mut Transaction<'_, Postgres>,
    replica_id: Uuid,
) -> ApiResult<()> {
    sqlx::query(
        r#"INSERT INTO hosted_provider_retired_replay_credentials (
             replica_id, token_hash, allowed_origin, proof_public_key, expires_at
           )
           SELECT id, token_hash, allowed_origin, proof_public_key,
                  now() + interval '365 days'
           FROM hosted_provider_replicas
           WHERE id = $1 AND purpose = 'application' AND revoked_at IS NULL"#,
    )
    .bind(replica_id)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}
