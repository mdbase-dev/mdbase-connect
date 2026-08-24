use super::*;

const MAX_COLLABORATION_BATCH_UPDATES: usize = 64;
const MAX_COLLABORATION_BATCH_BYTES: u64 = 1024 * 1024;

/// A provider-owned batch contribution. This is deliberately crate-private: a
/// future transport must authenticate each contributor before constructing it.
#[derive(Debug, Clone)]
pub(crate) struct CollaborationBatchContribution {
    pub replica_id: Uuid,
    pub expected_scope_epoch: u64,
    pub client_mutation_id: Uuid,
    pub update: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct CollaborationBatchReceipt {
    pub replica_id: Uuid,
    pub client_mutation_id: Uuid,
    pub sequence: u64,
    pub mutation_digest: Vec<u8>,
    pub record_sequence: u64,
}

#[derive(Debug, Clone)]
pub(crate) struct CollaborationBatchInput {
    pub collection_id: Uuid,
    pub record_id: Uuid,
    pub epoch: u64,
    pub contributions: Vec<CollaborationBatchContribution>,
}

impl HostedProvider {
    /// Apply an already-authenticated collaboration batch in a caller-owned
    /// transaction. The caller must supply the exact room identity and
    /// contributors from a transport authorization context; this method never
    /// accepts a data key and resolves it only after locking and revalidating
    /// every replica. The caller commits the transaction and may expose the
    /// returned receipts only after that commit.
    pub(crate) async fn commit_collaboration_batch_in(
        &self,
        transaction: &mut Transaction<'_, Postgres>,
        input: CollaborationBatchInput,
    ) -> ApiResult<Vec<CollaborationBatchReceipt>> {
        if input.contributions.is_empty() {
            return Err(ApiError::bad_request(
                "empty_collaboration_batch",
                "A collaboration batch must contain an update.",
            ));
        }
        if input.contributions.len() > MAX_COLLABORATION_BATCH_UPDATES {
            return Err(ApiError::quota(
                "collaboration_batch_too_large",
                "The collaboration batch contains too many updates.",
            ));
        }
        let mut mutation_ids = BTreeSet::new();
        if input.contributions.iter().any(|contribution| {
            !mutation_ids.insert((contribution.replica_id, contribution.client_mutation_id))
        }) {
            return Err(ApiError::bad_request(
                "duplicate_collaboration_mutation_id",
                "A collaboration batch contains a duplicate mutation identity.",
            ));
        }
        let room = RoomIdentity::new(
            input.collection_id,
            input.record_id,
            input.epoch,
            crate::COLLABORATION_PROFILE,
        )
        .ok_or_else(|| {
            ApiError::bad_request(
                "invalid_collaboration_room",
                "The collaboration room identity is invalid.",
            )
        })?;
        let mut lock_ids = input
            .contributions
            .iter()
            .map(|c| c.replica_id)
            .collect::<Vec<_>>();
        lock_ids.sort_unstable();
        lock_ids.dedup();
        if lock_ids.len() != 1 {
            return Err(ApiError::bad_request(
                "multi_replica_collaboration_batch_unsupported",
                "Each durable collaboration batch must have one contributing replica.",
            ));
        }
        // Replica is the first lock in the global order. Do not resolve the
        // collection key until these rows have all passed capability checks.
        for replica_id in &lock_ids {
            let row = sqlx::query(
                "SELECT id, collection_id, purpose, mode, full_collection, allowed_types,
                        contract_scope, allowed_operations, collaboration_capability,
                        allowed_origin, proof_public_key, grant_id,
                        application_declaration_id, application_declaration_digest, scope_epoch
                 FROM hosted_provider_replicas
                 WHERE id=$1 AND revoked_at IS NULL AND token_expires_at > now() FOR UPDATE",
            )
            .bind(replica_id)
            .fetch_optional(&mut **transaction)
            .await?;
            let Some(row) = row else {
                return Err(ApiError::forbidden(
                    "collaboration_scope_denied",
                    "The collaboration replica is not authorized.",
                ));
            };
            let collection_matches = row.get::<Uuid, _>("collection_id") == input.collection_id;
            let purpose = row.get::<String, _>("purpose");
            let mode = row.get::<String, _>("mode");
            let operations: Vec<String> = row.get("allowed_operations");
            let capability: Option<ReplicaCollaborationCapability> = row
                .get::<Option<Value>, _>("collaboration_capability")
                .map(serde_json::from_value)
                .transpose()
                .map_err(|_| ApiError::internal("Stored collaboration capability is invalid."))?;
            let exact_profile = capability.as_ref().is_some_and(|cap| {
                cap.contract_version == 1
                    && cap.profiles == vec![crate::COLLABORATION_PROFILE.to_owned()]
                    && cap.access == CollaborationAccess::ReadWrite
            });
            let unscoped = row.get::<Vec<String>, _>("allowed_types").is_empty()
                && row.get::<Value, _>("contract_scope") == Value::Array(Vec::new());
            let binding_complete = row.get::<Option<Uuid>, _>("grant_id").is_some()
                && row.get::<Option<String>, _>("allowed_origin").is_some()
                && row.get::<Option<String>, _>("proof_public_key").is_some()
                && row
                    .get::<Option<String>, _>("application_declaration_id")
                    .is_some()
                && row
                    .get::<Option<String>, _>("application_declaration_digest")
                    .is_some();
            if !collection_matches
                || purpose != "application"
                || mode != "read_write"
                || !row.get::<bool, _>("full_collection")
                || !unscoped
                || !operations.iter().any(|op| op == "read")
                || !operations.iter().any(|op| op == "update")
                || !exact_profile
                || !binding_complete
            {
                return Err(ApiError::forbidden(
                    "collaboration_scope_denied",
                    "The collaboration replica is not authorized for durable collaboration.",
                ));
            }
            if !input
                .contributions
                .iter()
                .filter(|c| c.replica_id == *replica_id)
                .all(|c| {
                    number(row.get::<i64, _>("scope_epoch"), "scope epoch")
                        .is_ok_and(|epoch| epoch == c.expected_scope_epoch)
                })
            {
                return Err(ApiError::conflict(
                    "scope_epoch_stale",
                    "The collaboration replica scope changed.",
                ));
            }
        }
        let collection = sqlx::query(
            "SELECT head, record_count, content_bytes, max_records, max_content_bytes,
                    max_document_bytes, resource_revision, resources_ciphertext,
                    active_projection_generation_id, wrapped_data_key
             FROM hosted_provider_collections WHERE id=$1 AND state='active' FOR UPDATE",
        )
        .bind(input.collection_id)
        .fetch_optional(&mut **transaction)
        .await?
        .ok_or_else(|| {
            ApiError::not_found(
                "hosted_collection_not_found",
                "Hosted collection not found.",
            )
        })?;
        let wrapped: Vec<u8> = collection.get("wrapped_data_key");
        let data_key = self.collection_key(input.collection_id, &wrapped).await?;
        let resources: SyncCollectionResources = self.crypto.decrypt_json(
            &data_key,
            collection.get("resources_ciphertext"),
            &resources_aad(input.collection_id),
        )?;
        let resource_documents = super::load_resource_documents(
            transaction,
            &self.crypto,
            &data_key,
            input.collection_id,
        )
        .await?;
        let catalog = super::operation_reads::compile_point_catalog(resources, resource_documents)?;
        let room_state = self
            .load_collaboration_room_in(transaction, &data_key, room)
            .await?;
        let mut scratch = MarkdownBodyDocument::from_snapshot(
            &room_state.document.snapshot_v1(),
            self.limits.collaboration.max_snapshot_bytes as usize,
            self.limits.collaboration.max_document_bytes as usize,
        )
        .map_err(profile_error)?;
        let mut pending = Vec::new();
        let mut receipts = Vec::new();
        let mut total_updates = 0_u64;
        for contribution in &input.contributions {
            if contribution.update.len() as u64 > self.limits.collaboration.max_update_bytes {
                return Err(ApiError::quota(
                    "collaboration_update_too_large",
                    "The collaboration update exceeds the configured limit.",
                ));
            }
            let digest = digest_bytes(&contribution.update);
            let existing = sqlx::query("SELECT mutation_digest, receipt_ciphertext, sequence FROM hosted_provider_collaboration_receipts WHERE collection_id=$1 AND record_id=$2 AND collaboration_epoch=$3 AND profile=$4 AND replica_id=$5 AND client_mutation_id=$6")
                .bind(input.collection_id).bind(input.record_id).bind(to_i64(input.epoch, "collaboration epoch")?).bind(room.profile).bind(contribution.replica_id).bind(contribution.client_mutation_id).fetch_optional(&mut **transaction).await?;
            if let Some(row) = existing {
                let stored: Vec<u8> = row.get("mutation_digest");
                if stored != digest {
                    return Err(ApiError::conflict("collaboration_mutation_id_conflict", "The collaboration mutation id was already used with different update bytes."));
                }
                let plaintext = decrypt_room_bytes(
                    &self.crypto,
                    &data_key,
                    &room,
                    AadKind::Receipt,
                    row.get::<i64, _>("sequence") as u64,
                    Some(contribution.client_mutation_id),
                    row.get("receipt_ciphertext"),
                )?;
                let receipt: CollaborationBatchReceipt = serde_json::from_slice(&plaintext)
                    .map_err(|_| ApiError::internal("Stored collaboration receipt is invalid."))?;
                if receipt.replica_id != contribution.replica_id
                    || receipt.client_mutation_id != contribution.client_mutation_id
                    || receipt.sequence
                        != number(row.get::<i64, _>("sequence"), "collaboration sequence")?
                    || receipt.mutation_digest != digest
                {
                    return Err(ApiError::internal(
                        "Stored collaboration receipt binding is invalid.",
                    ));
                }
                receipts.push(receipt);
                continue;
            }
            scratch
                .apply_update_v1(
                    &contribution.update,
                    self.limits.collaboration.max_update_bytes as usize,
                    self.limits.collaboration.max_document_bytes as usize,
                )
                .map_err(|_| {
                    ApiError::bad_request(
                        "invalid_collaboration_update",
                        "The collaboration update is malformed or exceeds the document limit.",
                    )
                })?;
            total_updates = total_updates
                .checked_add(contribution.update.len() as u64)
                .filter(|bytes| *bytes <= MAX_COLLABORATION_BATCH_BYTES)
                .ok_or_else(|| {
                    ApiError::quota(
                        "collaboration_batch_too_large",
                        "The collaboration batch exceeds the configured limit.",
                    )
                })?;
            pending.push((contribution, digest));
        }
        if pending.is_empty() {
            return Ok(receipts);
        }
        if room_state
            .current_sequence
            .saturating_sub(room_state.snapshot_sequence)
            .saturating_add(pending.len() as u64)
            > self.limits.collaboration.max_retained_updates
            || total_updates.saturating_add(room_state.retained_update_bytes)
                > self.limits.collaboration.max_retained_update_bytes
        {
            return Err(ApiError::quota(
                "collaboration_retention_limit_exceeded",
                "The retained collaboration update limit would be exceeded.",
            ));
        }
        let body = scratch.body();
        let prefix = room_state
            .record
            .document
            .strip_suffix(room_state.record.body.as_str())
            .ok_or_else(|| {
                ApiError::conflict(
                    "collaboration_record_mismatch",
                    "The authoritative record does not end in its classified body.",
                )
            })?;
        let document = format!("{prefix}{body}");
        if document.len() as u64 > self.limits.collaboration.max_document_bytes {
            return Err(ApiError::quota(
                "collaboration_document_too_large",
                "The collaboration document exceeds the configured limit.",
            ));
        }
        let classified = super::mutations::classify_exact_sync_record(
            Some(&catalog),
            input.record_id,
            &room_state.record.path,
            &document,
        )?;
        let pending_count = pending.len();
        let body_changed = document.as_bytes() != room_state.record.document.as_bytes();
        let notification_runtime_active = if body_changed && self.notifications.is_some() {
            sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(SELECT 1 FROM hosted_provider_notification_grants WHERE collection_id=$1)",
            )
            .bind(input.collection_id)
            .fetch_one(&mut **transaction)
            .await?
        } else {
            false
        };
        let committed = if body_changed {
            Some(
                super::mutations::commit_hosted_write_set_in(
                    transaction,
                    self,
                    input.collection_id,
                    &data_key,
                    &collection,
                    Some(lock_ids[0]),
                    super::mutations::HostedWriteSet {
                        before_records: BTreeMap::from([(
                            input.record_id,
                            room_state.record.clone(),
                        )]),
                        changed: vec![(input.record_id, Some(classified), Some(document))],
                        primary_record_id: input.record_id,
                    },
                    notification_runtime_active,
                )
                .await?,
            )
        } else {
            None
        };
        let materialized_revision = committed
            .as_ref()
            .and_then(|commit| commit.primary.as_ref())
            .map(|record| record.revision.clone())
            .unwrap_or_else(|| room_state.record.revision.clone());
        let record_sequence = committed
            .as_ref()
            .map(|commit| commit.head)
            .unwrap_or(room_state.record_sequence);
        let mut sequence = room_state.current_sequence;
        for (contribution, digest) in pending {
            sequence = sequence
                .checked_add(1)
                .ok_or_else(|| ApiError::internal("Collaboration sequence is exhausted."))?;
            let update_ciphertext = encrypt_room_bytes(
                &self.crypto,
                &data_key,
                &room,
                AadKind::Update,
                sequence,
                Some(contribution.client_mutation_id),
                &contribution.update,
            )?;
            sqlx::query("INSERT INTO hosted_provider_collaboration_updates (collection_id,record_id,collaboration_epoch,profile,sequence,update_ciphertext,update_digest,replica_id,client_mutation_id,materialized_revision) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)").bind(input.collection_id).bind(input.record_id).bind(to_i64(input.epoch, "collaboration epoch")?).bind(room.profile).bind(to_i64(sequence, "collaboration sequence")?).bind(&update_ciphertext).bind(&digest).bind(contribution.replica_id).bind(contribution.client_mutation_id).bind(&materialized_revision).execute(&mut **transaction).await?;
            let receipt = CollaborationBatchReceipt {
                replica_id: contribution.replica_id,
                client_mutation_id: contribution.client_mutation_id,
                sequence,
                mutation_digest: digest,
                record_sequence,
            };
            let receipt_plaintext = serde_json::to_vec(&receipt)
                .map_err(|_| ApiError::internal("Collaboration receipt could not be encoded."))?;
            let receipt_ciphertext = encrypt_room_bytes(
                &self.crypto,
                &data_key,
                &room,
                AadKind::Receipt,
                sequence,
                Some(contribution.client_mutation_id),
                &receipt_plaintext,
            )?;
            sqlx::query("INSERT INTO hosted_provider_collaboration_receipts (collection_id,record_id,collaboration_epoch,profile,replica_id,client_mutation_id,mutation_digest,receipt_ciphertext,sequence) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)").bind(input.collection_id).bind(input.record_id).bind(to_i64(input.epoch, "collaboration epoch")?).bind(room.profile).bind(contribution.replica_id).bind(contribution.client_mutation_id).bind(&receipt.mutation_digest).bind(&receipt_ciphertext).bind(to_i64(sequence, "collaboration sequence")?).execute(&mut **transaction).await?;
            receipts.push(receipt);
        }
        let retained_update_bytes: i64 = sqlx::query_scalar(
            "SELECT COALESCE(sum(octet_length(update_ciphertext)),0) FROM hosted_provider_collaboration_updates WHERE collection_id=$1 AND record_id=$2 AND collaboration_epoch=$3 AND profile=$4 AND sequence>$5",
        )
        .bind(input.collection_id).bind(input.record_id).bind(to_i64(input.epoch, "collaboration epoch")?).bind(room.profile)
        .bind(to_i64(room_state.snapshot_sequence, "snapshot sequence")?).fetch_one(&mut **transaction).await?;
        if number(retained_update_bytes, "retained collaboration bytes")?
            > self.limits.collaboration.max_retained_update_bytes
        {
            return Err(ApiError::quota(
                "collaboration_retention_limit_exceeded",
                "The retained collaboration update limit would be exceeded.",
            ));
        }
        let collaboration_bytes: i64 = sqlx::query_scalar(
            "SELECT octet_length(snapshot_ciphertext)+octet_length(state_vector_ciphertext)
               + COALESCE((SELECT sum(octet_length(update_ciphertext)) FROM hosted_provider_collaboration_updates u WHERE u.collection_id=d.collection_id AND u.record_id=d.record_id AND u.collaboration_epoch=d.collaboration_epoch AND u.profile=d.profile),0)
               + COALESCE((SELECT sum(octet_length(receipt_ciphertext)) FROM hosted_provider_collaboration_receipts r WHERE r.collection_id=d.collection_id AND r.record_id=d.record_id AND r.collaboration_epoch=d.collaboration_epoch AND r.profile=d.profile),0)
             FROM hosted_provider_collaboration_documents d WHERE collection_id=$1 AND record_id=$2 AND collaboration_epoch=$3 AND profile=$4",
        )
        .bind(input.collection_id).bind(input.record_id).bind(to_i64(input.epoch, "collaboration epoch")?).bind(room.profile)
        .fetch_one(&mut **transaction).await?;
        sqlx::query("UPDATE hosted_provider_collaboration_documents SET current_sequence=$5,materialized_revision=$6,retained_update_count=retained_update_count+$7,retained_update_bytes=$8,collaboration_bytes=$9,updated_at=now() WHERE collection_id=$1 AND record_id=$2 AND collaboration_epoch=$3 AND profile=$4").bind(input.collection_id).bind(input.record_id).bind(to_i64(input.epoch, "collaboration epoch")?).bind(room.profile).bind(to_i64(sequence, "collaboration sequence")?).bind(&materialized_revision).bind(pending_count as i64).bind(retained_update_bytes).bind(collaboration_bytes).execute(&mut **transaction).await?;
        // Compaction is bounded and remains in this transaction. The full
        // snapshot preserves old state-vector diff semantics.
        let _ = self
            .compact_collaboration_room_in(transaction, &data_key, room)
            .await?;
        Ok(receipts)
    }
}
