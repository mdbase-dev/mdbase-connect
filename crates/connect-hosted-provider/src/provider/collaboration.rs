//! Transactional hosted collaboration room state.
//!
//! This module deliberately stops at the persistence/rehydration boundary. It
//! has no transport or public capability advertisement. In particular, the
//! batch writer remains disabled until the ordinary mutation write-set
//! committer can be shared by both paths.
#![allow(dead_code)] // Phase 3 room state is wired by the disabled Phase 4 transport.

use super::*;
use crate::collaboration::{decrypt_room_bytes, encrypt_room_bytes, AadKind, RoomIdentity};
use mdbase_connect_collaboration::{CollaborationError, MarkdownBodyDocument};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CollaborationRoomLifecycle {
    Active,
    Closed,
    Rebuilding,
}

pub(super) struct CollaborationRoom {
    pub identity: RoomIdentity,
    pub document: MarkdownBodyDocument,
    pub record: SyncRecord,
    pub materialized_revision: String,
    pub current_sequence: u64,
    pub snapshot_sequence: u64,
    pub retained_update_bytes: u64,
    pub lifecycle: CollaborationRoomLifecycle,
}

impl HostedProvider {
    /// Load or create a room while the caller's transaction owns the stable
    /// record lock. The record is the authority for both exact frontmatter
    /// bytes and the materialized body; CRDT state is accepted only after the
    /// latter has been checked.
    /// The caller must already have performed replica authorization. This
    /// helper acquires locks in the ordinary order: collection, record,
    /// collaboration document. It never resolves or accepts a caller key.
    pub(super) async fn load_collaboration_room_in(
        &self,
        transaction: &mut Transaction<'_, Postgres>,
        data_key: &[u8; 32],
        room: RoomIdentity,
    ) -> ApiResult<CollaborationRoom> {
        sqlx::query("SELECT id FROM hosted_provider_collections WHERE id = $1 FOR UPDATE")
            .bind(room.collection_id)
            .fetch_optional(&mut **transaction)
            .await?
            .ok_or_else(|| {
                ApiError::not_found(
                    "collection_not_found",
                    "The hosted collection does not exist.",
                )
            })?;
        let record_row = sqlx::query(
            "SELECT revision, sequence, payload_ciphertext FROM hosted_provider_records
             WHERE collection_id = $1 AND record_id = $2 FOR UPDATE",
        )
        .bind(room.collection_id)
        .bind(room.record_id)
        .fetch_optional(&mut **transaction)
        .await?
        .ok_or_else(|| {
            ApiError::not_found("record_not_found", "The hosted record does not exist.")
        })?;
        let record_sequence = number(record_row.get::<i64, _>("sequence"), "record sequence")?;
        let record: SyncRecord = self.crypto.decrypt_json(
            data_key,
            record_row.get("payload_ciphertext"),
            &current_record_aad(room.collection_id, room.record_id, record_sequence),
        )?;
        let existing = sqlx::query(
            "SELECT snapshot_ciphertext, state_vector_ciphertext, current_sequence,
                    materialized_revision, snapshot_sequence, retained_update_count,
                    retained_update_bytes, collaboration_bytes, state
             FROM hosted_provider_collaboration_documents
             WHERE collection_id = $1 AND record_id = $2 AND collaboration_epoch = $3
               AND profile = $4 FOR UPDATE",
        )
        .bind(room.collection_id)
        .bind(room.record_id)
        .bind(to_i64(room.epoch, "collaboration epoch")?)
        .bind(room.profile)
        .fetch_optional(&mut **transaction)
        .await?;

        let Some(row) = existing else {
            let document = MarkdownBodyDocument::new(
                &record.body,
                self.limits.collaboration.max_document_bytes as usize,
            )
            .map_err(profile_error)?;
            let snapshot = document.snapshot_v1();
            let vector = document.state_vector_v1();
            ensure_snapshot_limit(&snapshot, &self.limits.collaboration)?;
            let snapshot_ciphertext = encrypt_room_bytes(
                &self.crypto,
                data_key,
                &room,
                AadKind::Snapshot,
                0,
                None,
                &snapshot,
            )?;
            let vector_ciphertext = encrypt_room_bytes(
                &self.crypto,
                data_key,
                &room,
                AadKind::StateVector,
                0,
                None,
                &vector,
            )?;
            sqlx::query(
                "INSERT INTO hosted_provider_collaboration_documents
                 (collection_id, record_id, collaboration_epoch, profile,
                  snapshot_ciphertext, state_vector_ciphertext, materialized_revision,
                  snapshot_sequence, current_sequence, retained_update_count,
                  retained_update_bytes, collaboration_bytes)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,0,0,0,0,$8)",
            )
            .bind(room.collection_id)
            .bind(room.record_id)
            .bind(to_i64(room.epoch, "collaboration epoch")?)
            .bind(room.profile)
            .bind(&snapshot_ciphertext)
            .bind(&vector_ciphertext)
            .bind(&record.revision)
            .bind(to_i64(
                (snapshot_ciphertext.len() + vector_ciphertext.len()) as u64,
                "collaboration bytes",
            )?)
            .execute(&mut **transaction)
            .await?;
            return Ok(CollaborationRoom {
                identity: room,
                document,
                record: record.clone(),
                materialized_revision: record.revision,
                current_sequence: 0,
                snapshot_sequence: 0,
                retained_update_bytes: 0,
                lifecycle: CollaborationRoomLifecycle::Active,
            });
        };

        let state = match parse_lifecycle(row.get("state")) {
            Ok(state) => state,
            Err(_) => {
                return self
                    .fence_room(transaction, &room, "collaboration lifecycle is corrupt")
                    .await
            }
        };
        if state != CollaborationRoomLifecycle::Active {
            return Err(ApiError::conflict(
                "collaboration_repair_required",
                "The collaboration room is not writable.",
            ));
        }
        let current_sequence = number(
            row.get::<i64, _>("current_sequence"),
            "collaboration sequence",
        )?;
        let snapshot_sequence =
            number(row.get::<i64, _>("snapshot_sequence"), "snapshot sequence")?;
        if snapshot_sequence > current_sequence {
            return self
                .fence_room(
                    transaction,
                    &room,
                    "snapshot sequence is ahead of the collaboration sequence",
                )
                .await;
        }
        let snapshot_ciphertext: Vec<u8> = row.get("snapshot_ciphertext");
        let snapshot = match decrypt_room_bytes(
            &self.crypto,
            data_key,
            &room,
            AadKind::Snapshot,
            snapshot_sequence,
            None,
            &snapshot_ciphertext,
        ) {
            Ok(value) => value,
            Err(_) => {
                return self
                    .fence_room(
                        transaction,
                        &room,
                        "collaboration snapshot authentication failed",
                    )
                    .await
            }
        };
        if ensure_snapshot_limit(&snapshot, &self.limits.collaboration).is_err() {
            return self
                .fence_room(
                    transaction,
                    &room,
                    "collaboration snapshot exceeds the configured limit",
                )
                .await;
        }
        let mut document = match MarkdownBodyDocument::from_snapshot(
            &snapshot,
            self.limits.collaboration.max_snapshot_bytes as usize,
            self.limits.collaboration.max_document_bytes as usize,
        ) {
            Ok(document) => document,
            Err(_) => {
                return self
                    .fence_room(transaction, &room, "collaboration snapshot is malformed")
                    .await
            }
        };
        let vector_ciphertext: Vec<u8> = row.get("state_vector_ciphertext");
        let stored_vector = match decrypt_room_bytes(
            &self.crypto,
            data_key,
            &room,
            AadKind::StateVector,
            snapshot_sequence,
            None,
            &vector_ciphertext,
        ) {
            Ok(value) => value,
            Err(_) => {
                return self
                    .fence_room(
                        transaction,
                        &room,
                        "collaboration state vector authentication failed",
                    )
                    .await
            }
        };
        if stored_vector != document.state_vector_v1() {
            return self
                .fence_room(
                    transaction,
                    &room,
                    "collaboration state vector is inconsistent",
                )
                .await;
        }
        let updates = sqlx::query(
            "SELECT sequence, update_ciphertext, update_digest, client_mutation_id, materialized_revision
             FROM hosted_provider_collaboration_updates
             WHERE collection_id=$1 AND record_id=$2 AND collaboration_epoch=$3 AND profile=$4
               AND sequence > $5 ORDER BY sequence LIMIT $6",
        )
        .bind(room.collection_id)
        .bind(room.record_id)
        .bind(to_i64(room.epoch, "collaboration epoch")?)
        .bind(room.profile)
        .bind(to_i64(snapshot_sequence, "snapshot sequence")?)
        .bind(to_i64(self.limits.collaboration.max_retained_updates.saturating_add(1), "retained update count")?)
        .fetch_all(&mut **transaction)
        .await?;
        if updates.len() as u64 > self.limits.collaboration.max_retained_updates {
            return self
                .fence_room(
                    transaction,
                    &room,
                    "retained collaboration update count exceeds the configured limit",
                )
                .await;
        }
        let update_count = updates.len() as u64;
        let mut expected = snapshot_sequence + 1;
        let mut retained_bytes = 0_u64;
        let mut last_update_revision: Option<String> = None;
        for update in updates {
            let sequence = number(update.get::<i64, _>("sequence"), "update sequence")?;
            if sequence != expected || sequence > current_sequence {
                return self
                    .fence_room(
                        transaction,
                        &room,
                        "collaboration update sequence is not continuous",
                    )
                    .await;
            }
            let ciphertext: Vec<u8> = update.get("update_ciphertext");
            retained_bytes = retained_bytes.saturating_add(ciphertext.len() as u64);
            if retained_bytes > self.limits.collaboration.max_retained_update_bytes {
                return self
                    .fence_room(
                        transaction,
                        &room,
                        "retained collaboration updates exceed the configured limit",
                    )
                    .await;
            }
            let digest: Vec<u8> = update.get("update_digest");
            let mutation_id: Uuid = update.get("client_mutation_id");
            // Intermediate rows may each materialize a different ordinary
            // revision. Only the final replayed update must name the room's
            // authoritative materialized revision.
            last_update_revision = Some(update.get("materialized_revision"));
            let plaintext = match decrypt_room_bytes(
                &self.crypto,
                data_key,
                &room,
                AadKind::Update,
                sequence,
                Some(mutation_id),
                &ciphertext,
            ) {
                Ok(plaintext) => plaintext,
                Err(_) => {
                    return self
                        .fence_room(
                            transaction,
                            &room,
                            "collaboration update authentication failed",
                        )
                        .await
                }
            };
            if digest != digest_bytes(&plaintext) {
                return self
                    .fence_room(transaction, &room, "collaboration update digest is invalid")
                    .await;
            }
            if document
                .apply_update_v1(
                    &plaintext,
                    self.limits.collaboration.max_update_bytes as usize,
                    self.limits.collaboration.max_document_bytes as usize,
                )
                .is_err()
            {
                return self
                    .fence_room(transaction, &room, "collaboration update is malformed")
                    .await;
            }
            expected += 1;
        }
        if update_count
            != number(
                row.get::<i64, _>("retained_update_count"),
                "retained update count",
            )?
            || retained_bytes
                != number(
                    row.get::<i64, _>("retained_update_bytes"),
                    "retained update bytes",
                )?
        {
            return self
                .fence_room(
                    transaction,
                    &room,
                    "stored retained update metadata is inconsistent",
                )
                .await;
        }
        let receipt_bytes: i64 = sqlx::query_scalar(
            "SELECT COALESCE(sum(octet_length(receipt_ciphertext)), 0) FROM hosted_provider_collaboration_receipts WHERE collection_id=$1 AND record_id=$2 AND collaboration_epoch=$3 AND profile=$4",
        )
        .bind(room.collection_id).bind(room.record_id).bind(to_i64(room.epoch, "collaboration epoch")?).bind(room.profile)
        .fetch_one(&mut **transaction).await?;
        let expected_collaboration_bytes = snapshot_ciphertext.len() as u64
            + vector_ciphertext.len() as u64
            + retained_bytes
            + number(receipt_bytes, "receipt bytes")?;
        if expected_collaboration_bytes
            != number(
                row.get::<i64, _>("collaboration_bytes"),
                "collaboration bytes",
            )?
        {
            return self
                .fence_room(
                    transaction,
                    &room,
                    "stored collaboration bytes are inconsistent",
                )
                .await;
        }
        if expected != current_sequence.saturating_add(1) {
            return self
                .fence_room(
                    transaction,
                    &room,
                    "collaboration update sequence has a gap",
                )
                .await;
        }
        let materialized_revision: String = row.get("materialized_revision");
        if materialized_revision != record.revision
            || last_update_revision
                .as_ref()
                .is_some_and(|revision| revision != &record.revision)
            || document.body().as_bytes() != record.body.as_bytes()
        {
            return self
                .fence_room(
                    transaction,
                    &room,
                    "collaboration state disagrees with the authoritative record",
                )
                .await;
        }
        Ok(CollaborationRoom {
            identity: room,
            document,
            record,
            materialized_revision,
            current_sequence,
            snapshot_sequence,
            retained_update_bytes: retained_bytes,
            lifecycle: state,
        })
    }

    /// Replace the durable snapshot at a bounded checkpoint. The full Yrs
    /// state is retained, so clients with an old state vector can still ask
    /// for a diff after incremental rows are removed.
    pub(super) async fn compact_collaboration_room_in(
        &self,
        transaction: &mut Transaction<'_, Postgres>,
        data_key: &[u8; 32],
        room: RoomIdentity,
    ) -> ApiResult<bool> {
        let loaded = self
            .load_collaboration_room_in(transaction, data_key, room)
            .await?;
        let retained = loaded
            .current_sequence
            .saturating_sub(loaded.snapshot_sequence);
        if retained < self.limits.collaboration.compaction_threshold {
            return Ok(false);
        }
        let snapshot = loaded.document.snapshot_v1();
        ensure_snapshot_limit(&snapshot, &self.limits.collaboration)?;
        let vector = loaded.document.state_vector_v1();
        let snapshot_ciphertext = encrypt_room_bytes(
            &self.crypto,
            data_key,
            &room,
            AadKind::Snapshot,
            loaded.current_sequence,
            None,
            &snapshot,
        )?;
        let vector_ciphertext = encrypt_room_bytes(
            &self.crypto,
            data_key,
            &room,
            AadKind::StateVector,
            loaded.current_sequence,
            None,
            &vector,
        )?;
        // Remove obsolete retained ciphertext first; each trigger refresh is
        // authoritative, so a transient snapshot-plus-old-updates total can
        // never bypass the collection quota.
        sqlx::query(
            "DELETE FROM hosted_provider_collaboration_updates
             WHERE collection_id=$1 AND record_id=$2 AND collaboration_epoch=$3 AND profile=$4 AND sequence <= $5",
        )
        .bind(room.collection_id).bind(room.record_id).bind(to_i64(room.epoch, "collaboration epoch")?).bind(room.profile)
        .bind(to_i64(loaded.current_sequence, "collaboration sequence")?).execute(&mut **transaction).await?;
        sqlx::query(
            "UPDATE hosted_provider_collaboration_documents
             SET snapshot_ciphertext=$5, state_vector_ciphertext=$6,
                 snapshot_sequence=$7, retained_update_count=0,
                 retained_update_bytes=0, collaboration_bytes=$8, updated_at=now()
             WHERE collection_id=$1 AND record_id=$2 AND collaboration_epoch=$3 AND profile=$4",
        )
        .bind(room.collection_id)
        .bind(room.record_id)
        .bind(to_i64(room.epoch, "collaboration epoch")?)
        .bind(room.profile)
        .bind(&snapshot_ciphertext)
        .bind(&vector_ciphertext)
        .bind(to_i64(loaded.current_sequence, "collaboration sequence")?)
        .bind(to_i64(
            (snapshot_ciphertext.len() + vector_ciphertext.len()) as u64,
            "collaboration bytes",
        )?)
        .execute(&mut **transaction)
        .await?;
        Ok(true)
    }

    pub(super) async fn repair_collaboration_room_in(
        &self,
        transaction: &mut Transaction<'_, Postgres>,
        data_key: &[u8; 32],
        collection_id: Uuid,
        record_id: Uuid,
    ) -> ApiResult<RoomIdentity> {
        sqlx::query("SELECT id FROM hosted_provider_collections WHERE id=$1 FOR UPDATE")
            .bind(collection_id)
            .fetch_optional(&mut **transaction)
            .await?
            .ok_or_else(|| {
                ApiError::not_found(
                    "collection_not_found",
                    "The hosted collection does not exist.",
                )
            })?;
        let record_row = sqlx::query("SELECT revision, payload_ciphertext, sequence FROM hosted_provider_records WHERE collection_id=$1 AND record_id=$2 FOR UPDATE")
            .bind(collection_id).bind(record_id).fetch_one(&mut **transaction).await?;
        let sequence = number(record_row.get::<i64, _>("sequence"), "record sequence")?;
        let record: SyncRecord = self.crypto.decrypt_json(
            data_key,
            record_row.get("payload_ciphertext"),
            &current_record_aad(collection_id, record_id, sequence),
        )?;
        let old_epoch: Option<i64> = sqlx::query_scalar("SELECT max(collaboration_epoch) FROM hosted_provider_collaboration_documents WHERE collection_id=$1 AND record_id=$2 AND profile=$3")
            .bind(collection_id).bind(record_id).bind(crate::COLLABORATION_PROFILE)
            .fetch_one(&mut **transaction).await?;
        let document = MarkdownBodyDocument::new(
            &record.body,
            self.limits.collaboration.max_document_bytes as usize,
        )
        .map_err(profile_error)?;
        let snapshot = document.snapshot_v1();
        ensure_snapshot_limit(&snapshot, &self.limits.collaboration)?;
        let vector = document.state_vector_v1();
        let epoch = u64::try_from(old_epoch.unwrap_or(0))
            .map_err(|_| ApiError::internal("invalid collaboration repair epoch"))?
            .checked_add(1)
            .ok_or_else(|| ApiError::internal("collaboration repair epoch overflow"))?;
        let room = RoomIdentity::new(
            collection_id,
            record_id,
            epoch,
            crate::COLLABORATION_PROFILE,
        )
        .ok_or_else(|| ApiError::internal("invalid collaboration repair epoch"))?;
        sqlx::query("UPDATE hosted_provider_collaboration_documents SET state='closed', updated_at=now() WHERE collection_id=$1 AND record_id=$2 AND profile=$3 AND state <> 'closed'")
            .bind(collection_id).bind(record_id).bind(room.profile).execute(&mut **transaction).await?;
        sqlx::query("DELETE FROM hosted_provider_collaboration_documents WHERE collection_id=$1 AND record_id=$2 AND profile=$3")
            .bind(collection_id).bind(record_id).bind(room.profile).execute(&mut **transaction).await?;
        let snapshot_ciphertext = encrypt_room_bytes(
            &self.crypto,
            data_key,
            &room,
            AadKind::Snapshot,
            0,
            None,
            &snapshot,
        )?;
        let vector_ciphertext = encrypt_room_bytes(
            &self.crypto,
            data_key,
            &room,
            AadKind::StateVector,
            0,
            None,
            &vector,
        )?;
        sqlx::query("INSERT INTO hosted_provider_collaboration_documents (collection_id,record_id,collaboration_epoch,profile,snapshot_ciphertext,state_vector_ciphertext,materialized_revision,collaboration_bytes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)")
            .bind(collection_id).bind(record_id).bind(to_i64(epoch, "collaboration epoch")?).bind(room.profile)
            .bind(&snapshot_ciphertext).bind(&vector_ciphertext).bind(record.revision)
            .bind(to_i64((snapshot_ciphertext.len()+vector_ciphertext.len()) as u64,"collaboration bytes")?).execute(&mut **transaction).await?;
        Ok(room)
    }

    async fn fence_room(
        &self,
        transaction: &mut Transaction<'_, Postgres>,
        room: &RoomIdentity,
        reason: &str,
    ) -> ApiResult<CollaborationRoom> {
        sqlx::query("UPDATE hosted_provider_collaboration_documents SET state='rebuilding', updated_at=now() WHERE collection_id=$1 AND record_id=$2 AND collaboration_epoch=$3 AND profile=$4")
            .bind(room.collection_id).bind(room.record_id).bind(to_i64(room.epoch,"collaboration epoch")?).bind(room.profile).execute(&mut **transaction).await?;
        Err(ApiError::conflict("collaboration_repair_required", reason))
    }
}

/// A provider-owned batch contribution. This is deliberately crate-private: a
/// future transport must authenticate each contributor before constructing it.
#[derive(Debug, Clone)]
pub(super) struct CollaborationBatchContribution {
    pub replica_id: Uuid,
    pub expected_scope_epoch: u64,
    pub client_mutation_id: Uuid,
    pub update: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct CollaborationBatchReceipt {
    pub replica_id: Uuid,
    pub client_mutation_id: Uuid,
    pub sequence: u64,
    pub mutation_digest: Vec<u8>,
    pub record_sequence: u64,
}

#[derive(Debug, Clone)]
pub(super) struct CollaborationBatchInput {
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
    pub(super) async fn commit_collaboration_batch_in(
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
            let binding_complete = row.get::<Option<Uuid>, _>("grant_id").is_some()
                && row.get::<Option<String>, _>("allowed_origin").is_some()
                && row.get::<Option<Vec<u8>>, _>("proof_public_key").is_some()
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
            let existing = sqlx::query("SELECT mutation_digest, receipt_ciphertext FROM hosted_provider_collaboration_receipts WHERE collection_id=$1 AND record_id=$2 AND collaboration_epoch=$3 AND profile=$4 AND replica_id=$5 AND client_mutation_id=$6")
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
                receipts.push(
                    serde_json::from_slice(&plaintext).map_err(|_| {
                        ApiError::internal("Stored collaboration receipt is invalid.")
                    })?,
                );
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
        let notification_runtime_active = if self.notifications.is_some() {
            sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(SELECT 1 FROM hosted_provider_notification_grants WHERE collection_id=$1)",
            )
            .bind(input.collection_id)
            .fetch_one(&mut **transaction)
            .await?
        } else {
            false
        };
        let committed = super::mutations::commit_hosted_write_set_in(
            transaction,
            self,
            input.collection_id,
            &data_key,
            &collection,
            (lock_ids.len() == 1).then_some(lock_ids[0]),
            super::mutations::HostedWriteSet {
                before_records: BTreeMap::from([(input.record_id, room_state.record.clone())]),
                changed: vec![(input.record_id, Some(classified), Some(document))],
                primary_record_id: input.record_id,
            },
            notification_runtime_active,
        )
        .await?;
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
            sqlx::query("INSERT INTO hosted_provider_collaboration_updates (collection_id,record_id,collaboration_epoch,profile,sequence,update_ciphertext,update_digest,replica_id,client_mutation_id,materialized_revision) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)").bind(input.collection_id).bind(input.record_id).bind(to_i64(input.epoch, "collaboration epoch")?).bind(room.profile).bind(to_i64(sequence, "collaboration sequence")?).bind(&update_ciphertext).bind(&digest).bind(contribution.replica_id).bind(contribution.client_mutation_id).bind(committed.primary.as_ref().map(|r| r.revision.clone()).ok_or_else(|| ApiError::internal("Collaboration commit did not return the primary record."))?).execute(&mut **transaction).await?;
            let receipt = CollaborationBatchReceipt {
                replica_id: contribution.replica_id,
                client_mutation_id: contribution.client_mutation_id,
                sequence,
                mutation_digest: digest,
                record_sequence: committed.head,
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
        let vector = scratch.state_vector_v1();
        let vector_ciphertext = encrypt_room_bytes(
            &self.crypto,
            &data_key,
            &room,
            AadKind::StateVector,
            room_state.snapshot_sequence,
            None,
            &vector,
        )?;
        sqlx::query("UPDATE hosted_provider_collaboration_documents SET state_vector_ciphertext=$5,current_sequence=$6,materialized_revision=$7,retained_update_count=retained_update_count+$8,retained_update_bytes=retained_update_bytes+$9,collaboration_bytes=collaboration_bytes,updated_at=now() WHERE collection_id=$1 AND record_id=$2 AND collaboration_epoch=$3 AND profile=$4").bind(input.collection_id).bind(input.record_id).bind(to_i64(input.epoch, "collaboration epoch")?).bind(room.profile).bind(vector_ciphertext).bind(to_i64(sequence, "collaboration sequence")?).bind(committed.primary.as_ref().unwrap().revision.clone()).bind(pending_count as i64).bind(to_i64(total_updates, "retained collaboration bytes")?).execute(&mut **transaction).await?;
        // Compaction is bounded and remains in this transaction. The full
        // snapshot preserves old state-vector diff semantics.
        let _ = self
            .compact_collaboration_room_in(transaction, &data_key, room)
            .await?;
        Ok(receipts)
    }
}

fn parse_lifecycle(value: String) -> ApiResult<CollaborationRoomLifecycle> {
    match value.as_str() {
        "active" => Ok(CollaborationRoomLifecycle::Active),
        "closed" => Ok(CollaborationRoomLifecycle::Closed),
        "rebuilding" => Ok(CollaborationRoomLifecycle::Rebuilding),
        _ => Err(ApiError::internal(
            "Stored collaboration lifecycle is invalid.",
        )),
    }
}

fn profile_error(error: CollaborationError) -> ApiError {
    ApiError::bad_request("invalid_collaboration_state", error.to_string())
}
fn ensure_snapshot_limit(snapshot: &[u8], limits: &CollaborationLimits) -> ApiResult<()> {
    if snapshot.len() as u64 > limits.max_snapshot_bytes {
        Err(ApiError::quota(
            "collaboration_snapshot_too_large",
            "The collaboration snapshot exceeds the configured limit.",
        ))
    } else {
        Ok(())
    }
}
fn digest_bytes(value: &[u8]) -> Vec<u8> {
    Sha256::digest(value).to_vec()
}
