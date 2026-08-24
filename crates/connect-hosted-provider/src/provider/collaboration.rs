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
    pub record_sequence: u64,
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
        // The durable epoch fence is authoritative for room identity and is
        // locked between the collection and record locks. A missing fence
        // means no room has ever been admitted for this record; first creation
        // initializes epoch 1 transactionally. Any other requested epoch is
        // stale or future and never resurrects a retired document.
        let fence_epoch: Option<i64> = sqlx::query_scalar(
            "SELECT current_epoch FROM hosted_provider_collaboration_epoch_fences
             WHERE collection_id = $1 AND record_id = $2 FOR UPDATE",
        )
        .bind(room.collection_id)
        .bind(room.record_id)
        .fetch_optional(&mut **transaction)
        .await?;
        let fence_epoch = match fence_epoch {
            Some(epoch) => epoch,
            None => {
                if room.epoch != 1 {
                    return Err(stale_epoch_error());
                }
                sqlx::query(
                    "INSERT INTO hosted_provider_collaboration_epoch_fences
                     (collection_id, record_id, current_epoch) VALUES ($1, $2, 1)",
                )
                .bind(room.collection_id)
                .bind(room.record_id)
                .execute(&mut **transaction)
                .await?;
                1
            }
        };
        if fence_epoch != to_i64(room.epoch, "collaboration epoch")? {
            return Err(stale_epoch_error());
        }
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
                record_sequence,
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
            record_sequence,
            lifecycle: state,
        })
    }

    /// Replace the durable snapshot at a bounded checkpoint. The full Yrs
    /// state is retained, so clients with an old state vector can still ask
    /// for a diff after incremental rows are removed.
    pub(crate) async fn compact_collaboration_room_in(
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
        let receipt_bytes: i64 = sqlx::query_scalar(
            "SELECT COALESCE(sum(octet_length(receipt_ciphertext)),0) FROM hosted_provider_collaboration_receipts WHERE collection_id=$1 AND record_id=$2 AND collaboration_epoch=$3 AND profile=$4",
        )
        .bind(room.collection_id).bind(room.record_id).bind(to_i64(room.epoch, "collaboration epoch")?).bind(room.profile)
        .fetch_one(&mut **transaction).await?;
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
            (snapshot_ciphertext.len() + vector_ciphertext.len()) as u64
                + number(receipt_bytes, "receipt bytes")?,
            "collaboration bytes",
        )?)
        .execute(&mut **transaction)
        .await?;
        Ok(true)
    }

    pub(crate) async fn repair_collaboration_room_in(
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
        let current_epoch: Option<i64> = sqlx::query_scalar(
            "SELECT current_epoch FROM hosted_provider_collaboration_epoch_fences
             WHERE collection_id=$1 AND record_id=$2 FOR UPDATE",
        )
        .bind(collection_id)
        .bind(record_id)
        .fetch_optional(&mut **transaction)
        .await?;
        let next_epoch = match current_epoch {
            Some(i64::MAX) => {
                return Err(ApiError::conflict(
                    "collaboration_epoch_exhausted",
                    "The collaboration epoch for this record is exhausted.",
                ));
            }
            Some(epoch) => epoch + 1,
            None => 1,
        };
        let record_row = sqlx::query("SELECT revision, payload_ciphertext, sequence FROM hosted_provider_records WHERE collection_id=$1 AND record_id=$2 FOR UPDATE")
            .bind(collection_id).bind(record_id).fetch_one(&mut **transaction).await?;
        let sequence = number(record_row.get::<i64, _>("sequence"), "record sequence")?;
        let record: SyncRecord = self.crypto.decrypt_json(
            data_key,
            record_row.get("payload_ciphertext"),
            &current_record_aad(collection_id, record_id, sequence),
        )?;
        let document = MarkdownBodyDocument::new(
            &record.body,
            self.limits.collaboration.max_document_bytes as usize,
        )
        .map_err(profile_error)?;
        let snapshot = document.snapshot_v1();
        ensure_snapshot_limit(&snapshot, &self.limits.collaboration)?;
        let vector = document.state_vector_v1();
        // Retire superseded rooms only after the replacement state validates.
        // The collection, fence, and record locks follow the common order.
        sqlx::query("DELETE FROM hosted_provider_collaboration_documents WHERE collection_id=$1 AND record_id=$2 AND profile=$3")
            .bind(collection_id).bind(record_id).bind(crate::COLLABORATION_PROFILE).execute(&mut **transaction).await?;
        match current_epoch {
            Some(_) => {
                sqlx::query(
                    "UPDATE hosted_provider_collaboration_epoch_fences
                     SET current_epoch=$3, updated_at=now()
                     WHERE collection_id=$1 AND record_id=$2",
                )
                .bind(collection_id)
                .bind(record_id)
                .bind(next_epoch)
                .execute(&mut **transaction)
                .await?;
            }
            None => {
                sqlx::query(
                    "INSERT INTO hosted_provider_collaboration_epoch_fences
                     (collection_id,record_id,current_epoch) VALUES ($1,$2,1)",
                )
                .bind(collection_id)
                .bind(record_id)
                .execute(&mut **transaction)
                .await?;
            }
        }
        let epoch_u64 = u64::try_from(next_epoch)
            .map_err(|_| ApiError::internal("invalid collaboration repair epoch"))?;
        let room = RoomIdentity::new(
            collection_id,
            record_id,
            epoch_u64,
            crate::COLLABORATION_PROFILE,
        )
        .ok_or_else(|| ApiError::internal("invalid collaboration repair epoch"))?;
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
            .bind(collection_id).bind(record_id).bind(to_i64(epoch_u64, "collaboration epoch")?).bind(room.profile)
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

mod batches;
mod catchup;
mod wakes;
pub(crate) use batches::{
    CollaborationBatchContribution, CollaborationBatchInput, CollaborationBatchReceipt,
};
pub(crate) use catchup::CollaborationCatchUpItem;
pub(crate) use tickets::{CollaborationTicketRequest, ConsumedCollaborationTicket};
pub(crate) use wakes::{
    spawn_wake_runtime, CollaborationWake, CollaborationWakeHub, CollaborationWakeRuntime,
    DEFAULT_WAKE_SWEEP_INTERVAL, WAKE_RECONCILE,
};

impl HostedProvider {
    pub(crate) async fn reauthorize_collaboration_session(
        &self,
        room: RoomIdentity,
        replica_id: Uuid,
        scope_epoch: u64,
        replica_token_hash: &[u8; 32],
    ) -> ApiResult<()> {
        // The session stays bound to the credential fingerprint observed at
        // ticket consumption. Token rotation rewrites the stored hash without
        // touching the scope epoch, so this comparison is what ends rotated
        // sessions; revocation and expiry are checked in the same row.
        let replica_epoch: Option<i64> = sqlx::query_scalar(
            "SELECT scope_epoch FROM hosted_provider_replicas WHERE id=$1 AND collection_id=$2 AND token_hash=$3 AND revoked_at IS NULL AND token_expires_at > now()",
        )
        .bind(replica_id)
        .bind(room.collection_id)
        .bind(replica_token_hash.as_slice())
        .fetch_optional(&self.pool)
        .await?;
        if replica_epoch != Some(to_i64(scope_epoch, "scope epoch")?) {
            return Err(collaboration_session_denied());
        }
        // A live session survives only while its room is still the fence's
        // current epoch, the durable document is active, and the materialized
        // revision still equals the authoritative record revision. All three
        // are checked without locks in one round trip; retirement by a
        // conventional writer ends the session on its next reauthorization.
        let row = sqlx::query(
            "SELECT f.current_epoch,
                    d.state AS document_state,
                    (d.materialized_revision IS NOT NULL
                     AND r.revision IS NOT NULL
                     AND d.materialized_revision = r.revision) AS materialized
             FROM hosted_provider_collaboration_epoch_fences f
             LEFT JOIN hosted_provider_records r
               ON r.collection_id = f.collection_id AND r.record_id = f.record_id
             LEFT JOIN hosted_provider_collaboration_documents d
               ON d.collection_id = f.collection_id AND d.record_id = f.record_id
              AND d.collaboration_epoch = f.current_epoch AND d.profile = $3
             WHERE f.collection_id = $1 AND f.record_id = $2",
        )
        .bind(room.collection_id)
        .bind(room.record_id)
        .bind(room.profile)
        .fetch_optional(&self.pool)
        .await?;
        let Some(row) = row else {
            return Err(collaboration_session_denied());
        };
        let current_epoch: i64 = row.get("current_epoch");
        let document_state: Option<String> = row.get("document_state");
        if current_epoch != to_i64(room.epoch, "collaboration epoch")?
            || document_state.as_deref() != Some("active")
            || !row.get::<bool, _>("materialized")
        {
            return Err(collaboration_session_denied());
        }
        Ok(())
    }

    pub(crate) async fn collaboration_sync_step2(
        &self,
        room: RoomIdentity,
        replica_id: Uuid,
        scope_epoch: u64,
        replica_token_hash: &[u8; 32],
        state_vector: &[u8],
    ) -> ApiResult<(Vec<u8>, u64)> {
        let mut transaction = self.pool.begin().await?;
        let replica_epoch: Option<i64> = sqlx::query_scalar(
            "SELECT scope_epoch FROM hosted_provider_replicas WHERE id=$1 AND collection_id=$2 AND token_hash=$3 AND revoked_at IS NULL AND token_expires_at > now() FOR UPDATE",
        )
        .bind(replica_id)
        .bind(room.collection_id)
        .bind(replica_token_hash.as_slice())
        .fetch_optional(&mut *transaction)
        .await?;
        if replica_epoch != Some(to_i64(scope_epoch, "scope epoch")?) {
            return Err(ApiError::forbidden(
                "collaboration_scope_denied",
                "The collaboration session is no longer authorized.",
            ));
        }
        let wrapped: Vec<u8> = sqlx::query_scalar("SELECT wrapped_data_key FROM hosted_provider_collections WHERE id=$1 AND state='active'")
            .bind(room.collection_id).fetch_one(&mut *transaction).await?;
        let data_key = self.collection_key(room.collection_id, &wrapped).await?;
        let loaded = self
            .load_collaboration_room_in(&mut transaction, &data_key, room)
            .await?;
        let diff = loaded
            .document
            .diff_v1(state_vector)
            .map_err(profile_error)?;
        // The durable sequence observed at sync time seeds the session's
        // catch-up cursor so wake-driven delivery never replays this diff.
        let current_sequence = loaded.current_sequence;
        transaction.commit().await?;
        Ok((diff, current_sequence))
    }

    pub(crate) async fn commit_collaboration_batch(
        &self,
        input: batches::CollaborationBatchInput,
    ) -> ApiResult<(Vec<batches::CollaborationBatchReceipt>, bool)> {
        let mut transaction = self.pool.begin().await?;
        let result = self
            .commit_collaboration_batch_result_in(&mut transaction, input)
            .await?;
        transaction.commit().await?;
        Ok(result)
    }
}

#[cfg(test)]
mod phase3_batch_tests;
#[cfg(test)]
mod phase4_transport_tests;
#[cfg(test)]
mod phase5_reconcile_tests;
#[cfg(test)]
mod phase6_multi_instance_tests;
#[cfg(test)]
mod phase6_wake_channel_tests;
#[cfg(test)]
mod phase7_drain_revoke_support;
#[cfg(test)]
mod phase7_drain_revoke_tests;
mod tickets;

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
fn stale_epoch_error() -> ApiError {
    ApiError::conflict(
        "collaboration_epoch_stale",
        "The requested collaboration epoch is not current.",
    )
}
fn collaboration_session_denied() -> ApiError {
    ApiError::forbidden(
        "collaboration_scope_denied",
        "The collaboration session is no longer authorized.",
    )
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
