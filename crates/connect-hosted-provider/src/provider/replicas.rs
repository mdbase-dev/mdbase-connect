use super::*;

#[cfg(test)]
#[path = "setup_evidence_tests.rs"]
mod setup_evidence_tests;

impl HostedProvider {
    pub async fn register_replica(
        &self,
        collection_id: Uuid,
        input: RegisterReplica,
    ) -> ApiResult<()> {
        self.register_replica_with_semantics(collection_id, input, 1)
            .await
    }

    /// Retained v2 retry only; never fresh authorization or an operation discriminator.
    pub async fn register_application_replica_v2(
        &self,
        collection_id: Uuid,
        input: RegisterReplica,
    ) -> ApiResult<()> {
        self.register_replica_with_semantics(collection_id, input, 2)
            .await
    }

    async fn register_replica_with_semantics(
        &self,
        collection_id: Uuid,
        mut input: RegisterReplica,
        semantics: i32,
    ) -> ApiResult<()> {
        validate_policy_semantics(&input, semantics)?;
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
        validate_setup_evidence_policy(collection_id, &input)?;
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
                      allowed_operations, operation_transport_protocol,
                      operation_transport_recovery_protocols,
                      file_capability, allowed_origin, proof_public_key, grant_id,
                      application_declaration_id, application_declaration_digest,
                      application_setup_evidence, application_semantic_version, token_hash, revoked_at
               FROM hosted_provider_replicas WHERE id = $1 FOR UPDATE"#,
        )
        .bind(input.replica_id)
        .fetch_optional(&mut *transaction)
        .await?
        {
            let requested_semantics = (input.purpose == ReplicaPurpose::Application).then_some(semantics);
            if decode_persisted_semantics(
                &existing.get::<String, _>("purpose"),
                existing.get("application_semantic_version"),
                existing.get::<Option<Value>, _>("application_setup_evidence").as_ref(),
            )? != requested_semantics {
                return Err(semantic_policy_mismatch());
            }
            let existing_hash: Vec<u8> = existing.get("token_hash");
            let exact_match = existing.get::<Option<Value>, _>("application_setup_evidence")
                == input.application_setup_evidence
                && existing.get::<Uuid, _>("collection_id") == collection_id
                && existing.get::<String, _>("name") == name
                && existing.get::<String, _>("purpose") == purpose
                && existing.get::<String, _>("mode") == mode
                && existing.get::<Vec<String>, _>("allowed_types") == input.allowed_types
                && existing.get::<Value, _>("contract_scope") == contract_scope
                && existing.get::<bool, _>("full_collection") == input.full_collection
                && existing.get::<Vec<String>, _>("allowed_operations") == input.allowed_operations
                && existing.get::<Option<i32>, _>("operation_transport_protocol")
                    == input
                        .operation_transport_protocol
                        .map(|version| version as i32)
                && existing.get::<Vec<i32>, _>("operation_transport_recovery_protocols")
                    == input
                        .operation_transport_recovery_protocols
                        .iter()
                        .map(|version| *version as i32)
                        .collect::<Vec<_>>()
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
        if input.purpose == ReplicaPurpose::Application {
            ensure_fresh_application_issuance(semantics)?;
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
                  allowed_operations, operation_transport_protocol,
                  operation_transport_recovery_protocols,
                  file_capability, allowed_origin, proof_public_key, grant_id,
                  application_declaration_id, application_declaration_digest, token_hash,
                  token_expires_at, application_setup_evidence, application_semantic_version)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                       $13, $14, $15, $16, $17, $18,
                       now() + ($19 * interval '1 second'), $20, $21)"#,
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
        .bind(
            input
                .operation_transport_protocol
                .map(|version| version as i32),
        )
        .bind(
            input
                .operation_transport_recovery_protocols
                .into_iter()
                .map(|version| version as i32)
                .collect::<Vec<_>>(),
        )
        .bind(file_capability)
        .bind(input.allowed_origin)
        .bind(input.proof_public_key)
        .bind(input.grant_id)
        .bind(input.application_declaration_id)
        .bind(input.application_declaration_digest)
        .bind(requested_token_hash)
        .bind(to_i64(token_ttl_seconds, "replica credential lifetime")?)
        .bind(input.application_setup_evidence)
        .bind((input.purpose == ReplicaPurpose::Application).then_some(semantics))
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
        reject_legacy_application_replica(&mut transaction, replica_id).await?;
        archive_application_replay_credential(&mut transaction, replica_id).await?;
        let result = sqlx::query(
            r#"UPDATE hosted_provider_replicas
               SET token_hash = $2, token_expires_at = now() + ($3 * interval '1 second')
               WHERE id = $1 AND revoked_at IS NULL
                 AND (purpose <> 'application'
                      OR (full_collection = true
                          AND cardinality(allowed_types) = 0
                          AND contract_scope = '[]'::jsonb))"#,
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
    ) -> ApiResult<AuthorizedRequest> {
        self.authorize_request_with_retired_replay(
            collection_id,
            token,
            request_origin,
            proof,
            false,
            true,
        )
        .await
    }

    pub async fn authorize_replay_request(
        &self,
        collection_id: Uuid,
        token: &str,
        request_origin: Option<&str>,
        proof: Option<&AuthorityRequestProof>,
    ) -> ApiResult<AuthorizedRequest> {
        self.authorize_request_with_retired_replay(
            collection_id,
            token,
            request_origin,
            proof,
            true,
            true,
        )
        .await
    }

    pub(crate) async fn authorize_cursor_release_request(
        &self,
        collection_id: Uuid,
        token: &str,
        request_origin: Option<&str>,
        proof: Option<&AuthorityRequestProof>,
    ) -> ApiResult<AuthorizedRequest> {
        self.authorize_request_with_retired_replay(
            collection_id,
            token,
            request_origin,
            proof,
            false,
            false,
        )
        .await
    }

    async fn authorize_request_with_retired_replay(
        &self,
        collection_id: Uuid,
        token: &str,
        request_origin: Option<&str>,
        proof: Option<&AuthorityRequestProof>,
        allow_retired_replay: bool,
        consume_proof_nonce: bool,
    ) -> ApiResult<AuthorizedRequest> {
        // Originless mirror traffic is authenticated again inside the requested
        // operation. Avoid a duplicate database round trip for that hot path.
        // Application capabilities with an allowed origin still fail closed in
        // the operation-level origin check when the header is omitted.
        if request_origin.is_none() && proof.is_none() {
            return Ok(AuthorizedRequest {
                operation_transport_protocol: None,
                operation_transport_recovery_protocols: Vec::new(),
            });
        }
        let mut transaction = self.pool.begin().await?;
        let row = sqlx::query(
            r#"SELECT id, purpose, mode, allowed_types, contract_scope, full_collection, allowed_operations,
                      operation_transport_protocol, operation_transport_recovery_protocols, file_capability,
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
        let (replica, retired_credential) = if row.is_some() {
            (replica_from_row(row)?, false)
        } else {
            let retired = sqlx::query(
                r#"SELECT replica.id, replica.purpose, replica.mode,
                          replica.allowed_types, replica.contract_scope,
                          replica.full_collection, replica.allowed_operations,
                          replica.operation_transport_protocol,
                          replica.operation_transport_recovery_protocols,
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
            (replica_from_row(retired)?, true)
        };
        if retired_credential && !allow_retired_replay {
            return Err(ApiError::unauthorized(
                "invalid_replica_token",
                "Replica credential is invalid, expired, or revoked.",
            ));
        }
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
                if !retired_credential {
                    ensure_canonical_application_replica(&replica)?;
                }
                authorize_application_origin(&replica, request_origin)?;
                if let Some(public_key) = replica.proof_public_key.as_deref() {
                    let proof = proof.ok_or_else(|| {
                        ApiError::unauthorized(
                            "authority_proof_required",
                            "The hosted capability requires proof from its approved application key.",
                        )
                    })?;
                    verify_hosted_request_proof(public_key, token, proof)?;
                    if !retired_credential && consume_proof_nonce {
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
        }
        let authorized = AuthorizedRequest {
            operation_transport_protocol: replica.operation_transport_protocol,
            operation_transport_recovery_protocols: replica
                .operation_transport_recovery_protocols
                .clone(),
        };
        transaction.commit().await?;
        Ok(authorized)
    }

    pub async fn update_application_replica(
        &self,
        replica_id: Uuid,
        input: UpdateApplicationReplica,
    ) -> ApiResult<()> {
        self.update_application_replica_with_semantics(replica_id, input, 1)
            .await
    }

    pub async fn update_application_replica_v2(
        &self,
        replica_id: Uuid,
        input: UpdateApplicationReplica,
    ) -> ApiResult<()> {
        self.update_application_replica_with_semantics(replica_id, input, 2)
            .await
    }

    async fn update_application_replica_with_semantics(
        &self,
        replica_id: Uuid,
        mut input: UpdateApplicationReplica,
        semantics: i32,
    ) -> ApiResult<()> {
        input.allowed_types.sort();
        input.allowed_types.dedup();
        input.allowed_operations.sort();
        input.allowed_operations.dedup();
        let policy = RegisterReplica {
            replica_id,
            name: "updated application capability".to_owned(),
            purpose: ReplicaPurpose::Application,
            mode: input.mode,
            allowed_types: input.allowed_types.clone(),
            contract_scope: input.contract_scope.clone(),
            full_collection: input.full_collection,
            allowed_operations: input.allowed_operations.clone(),
            operation_transport_protocol: Some(input.operation_transport_protocol),
            operation_transport_recovery_protocols: input
                .operation_transport_recovery_protocols
                .clone(),
            file_capability: input.file_capability.clone(),
            allowed_origin: input.allowed_origin.clone(),
            proof_public_key: input.proof_public_key.clone(),
            grant_id: Some(input.grant_id),
            application_declaration_id: Some(input.application_declaration_id.clone()),
            application_declaration_digest: Some(input.application_declaration_digest.clone()),
            application_setup_evidence: input.application_setup_evidence.clone(),
            token: "unused".to_owned(),
            token_ttl_seconds: None,
        };
        validate_policy_semantics(&policy, semantics)?;
        validate_replica_capability(&policy)?;
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
        let installed =
            sqlx::query("SELECT * FROM hosted_provider_replicas WHERE id = $1 FOR UPDATE")
                .bind(replica_id)
                .fetch_optional(&mut *transaction)
                .await?
                .ok_or_else(|| {
                    ApiError::not_found(
                        "replica_not_found",
                        "Active application capability not found.",
                    )
                })?;
        let collection_id: Uuid = installed.get("collection_id");
        let installed_semantics = decode_persisted_semantics(
            &installed.get::<String, _>("purpose"),
            installed.get("application_semantic_version"),
            installed
                .get::<Option<Value>, _>("application_setup_evidence")
                .as_ref(),
        )?;
        if !matches!(installed_semantics, Some(1 | 2))
            || (installed_semantics == Some(2) && semantics == 1)
        {
            return Err(semantic_policy_mismatch());
        }
        if semantics == 2
            && (installed_semantics != Some(2)
                || !retains_application_authority(&installed, &policy)?)
        {
            ensure_fresh_application_issuance(semantics)?;
        }
        validate_setup_evidence_policy(collection_id, &policy)?;
        reject_legacy_application_replica(&mut transaction, replica_id).await?;
        archive_application_replay_credential(&mut transaction, replica_id).await?;
        let result = sqlx::query(
            r#"UPDATE hosted_provider_replicas
               SET scope_epoch = scope_epoch + CASE
                     WHEN mode IS DISTINCT FROM $2
                       OR allowed_types IS DISTINCT FROM $3
                       OR contract_scope IS DISTINCT FROM $4
                       OR full_collection IS DISTINCT FROM $5
                       OR allowed_operations IS DISTINCT FROM $6
                       OR operation_transport_protocol IS DISTINCT FROM $7
                       OR operation_transport_recovery_protocols IS DISTINCT FROM $8
                       OR file_capability IS DISTINCT FROM $9
                       OR grant_id IS DISTINCT FROM $10
                       OR allowed_origin IS DISTINCT FROM $11
                       OR proof_public_key IS DISTINCT FROM $12
                       OR application_declaration_id IS DISTINCT FROM $13
                       OR application_declaration_digest IS DISTINCT FROM $14
                       OR application_setup_evidence IS DISTINCT FROM $15
                       OR $17::integer IS DISTINCT FROM $16
                     THEN 1 ELSE 0 END,
                   mode = $2,
                   allowed_types = $3,
                   contract_scope = $4,
                   full_collection = $5,
                   allowed_operations = $6,
                   operation_transport_protocol = $7,
                   operation_transport_recovery_protocols = $8,
                   file_capability = $9,
                   grant_id = $10,
                   allowed_origin = $11,
                   proof_public_key = $12,
                   application_declaration_id = $13,
                   application_declaration_digest = $14,
                   application_setup_evidence = $15,
                   application_semantic_version = $16
               WHERE id = $1 AND purpose = 'application' AND revoked_at IS NULL
                 AND full_collection = true
                 AND cardinality(allowed_types) = 0
                 AND contract_scope = '[]'::jsonb"#,
        )
        .bind(replica_id)
        .bind(replica_mode(input.mode))
        .bind(input.allowed_types)
        .bind(contract_scope)
        .bind(input.full_collection)
        .bind(input.allowed_operations)
        .bind(input.operation_transport_protocol as i32)
        .bind(
            input
                .operation_transport_recovery_protocols
                .into_iter()
                .map(|version| version as i32)
                .collect::<Vec<_>>(),
        )
        .bind(file_capability)
        .bind(input.grant_id)
        .bind(input.allowed_origin)
        .bind(input.proof_public_key)
        .bind(input.application_declaration_id)
        .bind(input.application_declaration_digest)
        .bind(input.application_setup_evidence)
        .bind(semantics)
        .bind(installed_semantics)
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
        let replica = replica_from_row(row)?;
        ensure_canonical_application_replica(&replica)?;
        Ok(replica)
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

/// Decode stored authority, not evidence validity. SQL NULL differs from JSON null.
/// Explicit v2 never falls back; its evidence must still pass signature verification.
pub(super) fn decode_persisted_semantics(
    purpose: &str,
    version: Option<i32>,
    evidence: Option<&Value>,
) -> ApiResult<Option<i32>> {
    match (purpose, version, evidence) {
        ("application", None | Some(1), None) => Ok(Some(1)),
        ("application", Some(2), _) => Ok(Some(2)),
        ("mirror", None, None) => Ok(None),
        _ => Err(semantic_policy_mismatch()),
    }
}

fn semantic_policy_mismatch() -> ApiError {
    ApiError::forbidden(
        "application_semantic_version_mismatch",
        "Application policy semantics cannot be downgraded or inferred from evidence.",
    )
}

fn validate_policy_semantics(policy: &RegisterReplica, semantics: i32) -> ApiResult<()> {
    match semantics {
        1 if policy.application_setup_evidence.is_none() => Ok(()),
        2 if policy.purpose == ReplicaPurpose::Application
            && policy.application_setup_evidence.is_some() =>
        {
            Ok(())
        }
        _ => Err(semantic_policy_mismatch()),
    }
}

pub(super) fn validate_setup_evidence_policy(
    collection_id: Uuid,
    policy: &RegisterReplica,
) -> ApiResult<()> {
    let Some(evidence) = &policy.application_setup_evidence else {
        return Ok(());
    };
    verified_setup_evidence(
        collection_id,
        policy.purpose,
        policy.proof_public_key.as_deref(),
        policy.application_declaration_id.as_deref(),
        policy.application_declaration_digest.as_deref(),
        policy.operation_transport_protocol,
        &policy.operation_transport_recovery_protocols,
        &policy.allowed_operations,
        policy.file_capability.as_ref(),
        evidence,
    )?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(super) fn verified_setup_evidence(
    collection_id: Uuid,
    purpose: ReplicaPurpose,
    public_key: Option<&str>,
    declaration_id: Option<&str>,
    declaration_digest: Option<&str>,
    transport: Option<u32>,
    recovery: &[u32],
    operations: &[String],
    files: Option<&FileCapability>,
    evidence: &Value,
) -> ApiResult<mdbase_connect_protocol::VerifiedApplicationSetupDeclaration> {
    let deny = || {
        ApiError::forbidden("application_declaration_mismatch", "Installed application setup evidence is missing or does not match the application policy.")
    };
    let proof: mdbase_connect_protocol::ApplicationAuthorizationProof = serde_json::from_value(
        evidence
            .get("application_authorization")
            .cloned()
            .ok_or_else(deny)?,
    )
    .map_err(|_| deny())?;
    proof.verify().map_err(|_| deny())?;
    let binding = &proof.binding;
    let digest = format!("sha256:{}", binding.application_manifest_digest);
    let files_match = match (files, binding.requested_files.as_ref()) {
        (None, _) => true,
        (Some(granted), Some(requested)) => {
            granted.protocol_version == mdbase_connect_protocol::FILE_PROTOCOL_VERSION
                && granted.kind == mdbase_connect_protocol::FileCapabilityKind::Files
                && granted.scope == requested.scope
                && granted
                    .actions
                    .iter()
                    .all(|action| requested.actions.contains(action))
        }
        _ => false,
    };
    if purpose != ReplicaPurpose::Application
        || public_key != Some(binding.grant_signing_public_key.as_str())
        || declaration_id != Some(binding.application_declaration_id.as_str())
        || declaration_digest != Some(digest.as_str())
        || transport != Some(binding.contracts.operation_transport)
        || recovery != binding.contracts.operation_transport_recovery
        || binding.contracts.semantic_capabilities != 2
        || binding.collection_id.is_some_and(|id| id != collection_id)
        || operations
            .iter()
            .any(|op| !binding.requested_operations.contains(op))
        || !files_match
    {
        return Err(deny());
    }
    mdbase_connect_protocol::verify_application_setup_declaration_v2(
        evidence.get("application_declaration").ok_or_else(deny)?,
        &binding.application_declaration_id,
        &binding.application_manifest_digest,
    )
    .map_err(|_| deny())
}

pub(super) fn validate_setup_runtime_choices(input: &Value) -> ApiResult<()> {
    // Conversion only after exact raw declaration comparison. Unknown pack/contract
    // choices must not be silently discarded by engine_collection_setup's filters.
    let setup: AssessCollectionSetupInput = serde_json::from_value(input.clone())
        .map_err(|_| collection_setup_declaration_mismatch())?;
    let packs = &setup.provisions.type_packs;
    let mut contracts = BTreeSet::new();
    for choice in &setup.contract_setups {
        if !packs
            .iter()
            .any(|pack| pack.provides.contains(&choice.contract))
            || !contracts.insert((
                &choice.contract.id,
                &choice.contract.version,
                &choice.contract.digest,
            ))
        {
            return Err(collection_setup_declaration_mismatch());
        }
    }
    for (id, targets) in &setup.type_pack_adoptions {
        let pack = packs
            .iter()
            .find(|pack| &pack.manifest.id == id)
            .ok_or_else(collection_setup_declaration_mismatch)?;
        if targets.keys().any(|target| {
            !pack
                .manifest
                .resources
                .iter()
                .any(|resource| &resource.target == target && resource.mode == "managed")
        }) {
            return Err(collection_setup_declaration_mismatch());
        }
    }
    if let Some(downgrades) = input.get("allow_type_pack_downgrades") {
        let ids: Vec<String> = serde_json::from_value(downgrades.clone())
            .map_err(|_| collection_setup_declaration_mismatch())?;
        if ids
            .iter()
            .any(|id| !packs.iter().any(|pack| &pack.manifest.id == id))
        {
            return Err(collection_setup_declaration_mismatch());
        }
    }
    // Engine assessment/apply remain authoritative for adoption digest ownership,
    // existing-type revision/field mappings, and the three apply CAS digests.
    Ok(())
}

pub(super) fn collection_setup_declaration_mismatch() -> ApiError {
    ApiError::forbidden(
        "application_declaration_mismatch",
        "Collection setup must exactly match the application declaration bound to this capability.",
    )
}

async fn reject_legacy_application_replica(
    transaction: &mut Transaction<'_, Postgres>,
    replica_id: Uuid,
) -> ApiResult<()> {
    let legacy: Option<Uuid> = sqlx::query_scalar(
        r#"SELECT id FROM hosted_provider_replicas
           WHERE id = $1 AND purpose = 'application' AND revoked_at IS NULL
             AND (full_collection = false
                  OR cardinality(allowed_types) <> 0
                  OR contract_scope <> '[]'::jsonb)
           FOR UPDATE"#,
    )
    .bind(replica_id)
    .fetch_optional(&mut **transaction)
    .await?;
    if legacy.is_some() {
        return Err(ApiError::forbidden(
            "application_reauthorization_required",
            "This legacy scoped application capability must be revoked and reauthorized.",
        ));
    }
    Ok(())
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
