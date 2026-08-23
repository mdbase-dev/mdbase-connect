//! Transactional hosted collaboration room state.
//!
//! This module deliberately stops at the persistence/rehydration boundary. It
//! has no transport or public capability advertisement. In particular, the
//! batch writer remains disabled until the ordinary mutation write-set
//! committer can be shared by both paths.

use super::*;
use crate::collaboration::{decrypt_room_bytes, encrypt_room_bytes, AadKind, RoomIdentity};
use mdbase_connect_collaboration::{CollaborationError, MarkdownBodyDocument};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CollaborationRoomLifecycle {
    Active,
    Closed,
    Rebuilding,
}

pub struct CollaborationRoom {
    pub identity: RoomIdentity,
    pub document: MarkdownBodyDocument,
    pub materialized_revision: String,
    pub current_sequence: u64,
    pub snapshot_sequence: u64,
    pub lifecycle: CollaborationRoomLifecycle,
}

#[derive(Debug, Clone)]
pub struct CollaborationBatch {
    pub room: RoomIdentity,
    pub contributing_replica_ids: Vec<Uuid>,
    pub client_mutation_ids: Vec<Uuid>,
    pub updates: Vec<Vec<u8>>,
}

impl HostedProvider {
    /// Load or create a room in its own transaction. Fencing errors are
    /// committed deliberately, so repair-required state survives the failed
    /// load attempt.
    pub async fn load_collaboration_room(
        &self,
        data_key: &[u8; 32],
        room: RoomIdentity,
    ) -> ApiResult<CollaborationRoom> {
        let mut transaction = self.pool.begin().await?;
        match self
            .load_collaboration_room_in(&mut transaction, data_key, room)
            .await
        {
            Ok(room) => {
                transaction.commit().await?;
                Ok(room)
            }
            Err(error) => {
                transaction.commit().await?;
                Err(error)
            }
        }
    }

    /// Load or create a room while the caller's transaction owns the stable
    /// record lock. The record is the authority for both exact frontmatter
    /// bytes and the materialized body; CRDT state is accepted only after the
    /// latter has been checked.
    pub async fn load_collaboration_room_in(
        &self,
        transaction: &mut Transaction<'_, Postgres>,
        data_key: &[u8; 32],
        room: RoomIdentity,
    ) -> ApiResult<CollaborationRoom> {
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
                    retained_update_bytes, state
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
            .bind(snapshot_ciphertext)
            .bind(vector_ciphertext)
            .bind(&record.revision)
            .bind(to_i64(
                (snapshot.len() + vector.len()) as u64,
                "collaboration bytes",
            )?)
            .execute(&mut **transaction)
            .await?;
            return Ok(CollaborationRoom {
                identity: room,
                document,
                materialized_revision: record.revision,
                current_sequence: 0,
                snapshot_sequence: 0,
                lifecycle: CollaborationRoomLifecycle::Active,
            });
        };

        let state = parse_lifecycle(row.get("state"))?;
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
        let snapshot = decrypt_room_bytes(
            &self.crypto,
            data_key,
            &room,
            AadKind::Snapshot,
            snapshot_sequence,
            None,
            &snapshot_ciphertext,
        )?;
        ensure_snapshot_limit(&snapshot, &self.limits.collaboration)?;
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
        let stored_vector = decrypt_room_bytes(
            &self.crypto,
            data_key,
            &room,
            AadKind::StateVector,
            snapshot_sequence,
            None,
            &vector_ciphertext,
        )?;
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
            "SELECT sequence, update_ciphertext, update_digest, client_mutation_id
             FROM hosted_provider_collaboration_updates
             WHERE collection_id=$1 AND record_id=$2 AND collaboration_epoch=$3 AND profile=$4
               AND sequence > $5 ORDER BY sequence",
        )
        .bind(room.collection_id)
        .bind(room.record_id)
        .bind(to_i64(room.epoch, "collaboration epoch")?)
        .bind(room.profile)
        .bind(to_i64(snapshot_sequence, "snapshot sequence")?)
        .fetch_all(&mut **transaction)
        .await?;
        let mut expected = snapshot_sequence + 1;
        let mut retained_bytes = 0_u64;
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
            if digest != digest_bytes(&ciphertext) {
                return self
                    .fence_room(transaction, &room, "collaboration update digest is invalid")
                    .await;
            }
            let mutation_id: Uuid = update.get("client_mutation_id");
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
            materialized_revision,
            current_sequence,
            snapshot_sequence,
            lifecycle: state,
        })
    }

    /// Replace the durable snapshot at a bounded checkpoint. The full Yrs
    /// state is retained, so clients with an old state vector can still ask
    /// for a diff after incremental rows are removed.
    pub async fn compact_collaboration_room_in(
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
        .bind(snapshot_ciphertext)
        .bind(vector_ciphertext)
        .bind(to_i64(loaded.current_sequence, "collaboration sequence")?)
        .bind(to_i64(
            (snapshot.len() + vector.len()) as u64,
            "collaboration bytes",
        )?)
        .execute(&mut **transaction)
        .await?;
        sqlx::query(
            "DELETE FROM hosted_provider_collaboration_updates
             WHERE collection_id=$1 AND record_id=$2 AND collaboration_epoch=$3 AND profile=$4 AND sequence <= $5",
        )
        .bind(room.collection_id).bind(room.record_id).bind(to_i64(room.epoch, "collaboration epoch")?).bind(room.profile)
        .bind(to_i64(loaded.current_sequence, "collaboration sequence")?).execute(&mut **transaction).await?;
        Ok(true)
    }

    /// Explicitly disabled until the ordinary write-set committer is shared.
    /// Keeping this method absent from HTTP/WS routing proves that no partial
    /// collaboration write can acknowledge or broadcast state.
    pub async fn apply_collaboration_batch_in(
        &self,
        _transaction: Transaction<'_, Postgres>,
        _batch: CollaborationBatch,
    ) -> ApiResult<()> {
        Err(ApiError::conflict(
            "collaboration_not_enabled",
            "Hosted collaboration writes are not enabled.",
        ))
    }

    pub async fn repair_collaboration_room_in(
        &self,
        transaction: &mut Transaction<'_, Postgres>,
        data_key: &[u8; 32],
        collection_id: Uuid,
        record_id: Uuid,
    ) -> ApiResult<RoomIdentity> {
        let record_row = sqlx::query("SELECT revision, payload_ciphertext, sequence FROM hosted_provider_records WHERE collection_id=$1 AND record_id=$2 FOR UPDATE")
            .bind(collection_id).bind(record_id).fetch_one(&mut **transaction).await?;
        let sequence = number(record_row.get::<i64, _>("sequence"), "record sequence")?;
        let record: SyncRecord = self.crypto.decrypt_json(
            data_key,
            record_row.get("payload_ciphertext"),
            &current_record_aad(collection_id, record_id, sequence),
        )?;
        let old_epoch: Option<i64> = sqlx::query_scalar("SELECT max(collaboration_epoch) FROM hosted_provider_collaboration_documents WHERE collection_id=$1 AND record_id=$2")
            .bind(collection_id).bind(record_id).fetch_one(&mut **transaction).await?;
        let epoch = number(old_epoch.unwrap_or(0), "collaboration epoch")?.saturating_add(1);
        let room = RoomIdentity::new(
            collection_id,
            record_id,
            epoch,
            crate::COLLABORATION_PROFILE,
        )
        .ok_or_else(|| ApiError::internal("invalid collaboration repair epoch"))?;
        let document = MarkdownBodyDocument::new(
            &record.body,
            self.limits.collaboration.max_document_bytes as usize,
        )
        .map_err(profile_error)?;
        let snapshot = document.snapshot_v1();
        let vector = document.state_vector_v1();
        sqlx::query("UPDATE hosted_provider_collaboration_documents SET state='rebuilding', updated_at=now() WHERE collection_id=$1 AND record_id=$2 AND state='active'").bind(collection_id).bind(record_id).execute(&mut **transaction).await?;
        sqlx::query("INSERT INTO hosted_provider_collaboration_documents (collection_id,record_id,collaboration_epoch,profile,snapshot_ciphertext,state_vector_ciphertext,materialized_revision,collaboration_bytes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)")
            .bind(collection_id).bind(record_id).bind(to_i64(epoch, "collaboration epoch")?).bind(room.profile)
            .bind(encrypt_room_bytes(&self.crypto,data_key,&room,AadKind::Snapshot,0,None,&snapshot)?).bind(encrypt_room_bytes(&self.crypto,data_key,&room,AadKind::StateVector,0,None,&vector)?).bind(record.revision)
            .bind(to_i64((snapshot.len()+vector.len()) as u64,"collaboration bytes")?).execute(&mut **transaction).await?;
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
