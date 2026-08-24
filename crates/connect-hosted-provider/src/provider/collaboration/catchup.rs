//! Durable room-sequence catch-up for hosted collaboration delivery.
//!
//! Notifications are only hints: every delivery round reloads and decrypts the
//! authoritative snapshot and update rows from PostgreSQL inside one short
//! transaction, validates the epoch fence, active lifecycle, record and
//! materialized revisions, ciphertext AAD bindings, digests, and contiguous
//! sequence metadata, and returns plaintext Yjs updates in durable order. When
//! a session cursor fell behind compaction, the full snapshot is returned as
//! an idempotent Yjs update followed by the later rows.
//!
//! Page count and bytes are bounded; an oversized or inauthentic frame fences
//! the room for repair instead of ever reaching a socket.

use super::*;
use crate::collaboration::{decrypt_room_bytes, AadKind};

/// Delivery page bound. Backlogs larger than one page are drained by repeated
/// rounds within the same wake, so this bounds per-round memory rather than
/// total convergence time.
pub(crate) const COLLABORATION_CATCHUP_PAGE_UPDATES: i64 = 8;
const COLLABORATION_CATCHUP_PAGE_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug)]
pub(crate) struct CollaborationCatchUpItem {
    pub sequence: u64,
    /// Internal provenance used solely to suppress origin echo through stored
    /// identities. Snapshot items carry none. These identifiers are never sent
    /// to clients.
    pub replica_id: Option<Uuid>,
    pub client_mutation_id: Option<Uuid>,
    /// Plaintext Yjs update (or full-state snapshot) ready for framing.
    pub plaintext: Vec<u8>,
}

impl HostedProvider {
    /// Load every durable update beyond `after_exclusive` up to `through` in
    /// contiguous order. `through` may be [`super::wakes::WAKE_RECONCILE`] to
    /// catch up to whatever the authoritative row currently stores. Stale or
    /// retired rooms fail closed; future-dated notices are clamped with a
    /// warning because they cannot exceed the stored sequence.
    pub(crate) async fn collaboration_catch_up(
        &self,
        room: RoomIdentity,
        after_exclusive: u64,
        through: u64,
    ) -> ApiResult<Vec<CollaborationCatchUpItem>> {
        let mut transaction = self.pool.begin().await?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
            .execute(&mut *transaction)
            .await?;
        // One immutable MVCC snapshot validates the fence, record, document,
        // and update rows without convoying writers or other local sessions.
        let fence_epoch: Option<i64> = sqlx::query_scalar(
            "SELECT current_epoch FROM hosted_provider_collaboration_epoch_fences
             WHERE collection_id = $1 AND record_id = $2",
        )
        .bind(room.collection_id)
        .bind(room.record_id)
        .fetch_optional(&mut *transaction)
        .await?;
        if fence_epoch != Some(to_i64(room.epoch, "collaboration epoch")?) {
            return Err(stale_epoch_error());
        }
        let revision: String = sqlx::query_scalar(
            "SELECT revision FROM hosted_provider_records
             WHERE collection_id = $1 AND record_id = $2",
        )
        .bind(room.collection_id)
        .bind(room.record_id)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or_else(|| {
            ApiError::not_found("record_not_found", "The hosted record does not exist.")
        })?;
        let row = sqlx::query(
            "SELECT state, current_sequence, snapshot_sequence, materialized_revision,
                    snapshot_ciphertext
             FROM hosted_provider_collaboration_documents
             WHERE collection_id = $1 AND record_id = $2 AND collaboration_epoch = $3 AND profile = $4",
        )
        .bind(room.collection_id)
        .bind(room.record_id)
        .bind(to_i64(room.epoch, "collaboration epoch")?)
        .bind(room.profile)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or_else(|| {
            ApiError::conflict(
                "collaboration_repair_required",
                "The collaboration room is missing.",
            )
        })?;
        let state: String = row.get("state");
        if state != "active" {
            return Err(ApiError::conflict(
                "collaboration_repair_required",
                "The collaboration room is not active.",
            ));
        }
        let current_sequence = number(
            row.get::<i64, _>("current_sequence"),
            "collaboration sequence",
        )?;
        let snapshot_sequence =
            number(row.get::<i64, _>("snapshot_sequence"), "snapshot sequence")?;
        let stored_revision: String = row.get("materialized_revision");
        if stored_revision != revision || snapshot_sequence > current_sequence {
            return self
                .fence_delivery_corruption(
                    transaction,
                    &room,
                    "collaboration state disagrees with the authoritative record",
                )
                .await;
        }
        let effective_through = if through == super::wakes::WAKE_RECONCILE {
            current_sequence
        } else {
            if through > current_sequence {
                tracing::warn!(
                    "collaboration wake high-water exceeded the durable sequence; clamping"
                );
            }
            through.min(current_sequence)
        };
        if effective_through <= after_exclusive {
            transaction.commit().await?;
            return Ok(Vec::new());
        }

        let mut items = Vec::new();
        let mut cursor = after_exclusive;
        let mut page_bytes = 0_u64;
        let wrapped: Vec<u8> = sqlx::query_scalar(
            "SELECT wrapped_data_key FROM hosted_provider_collections WHERE id=$1 AND state='active'",
        )
        .bind(room.collection_id)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or_else(|| {
            ApiError::not_found("hosted_collection_not_found", "Hosted collection not found.")
        })?;
        let data_key = self.collection_key(room.collection_id, &wrapped).await?;

        // A cursor behind the compacted snapshot means the covered update rows
        // no longer exist. The full snapshot is itself a valid Yjs update, so
        // delivering it is idempotent for any replica state.
        if snapshot_sequence > cursor {
            let ciphertext: Vec<u8> = row.get("snapshot_ciphertext");
            let plaintext = match decrypt_room_bytes(
                &self.crypto,
                &data_key,
                &room,
                AadKind::Snapshot,
                snapshot_sequence,
                None,
                &ciphertext,
            ) {
                Ok(plaintext) => plaintext,
                Err(_) => {
                    return self
                        .fence_delivery_corruption(
                            transaction,
                            &room,
                            "collaboration snapshot authentication failed during catch-up",
                        )
                        .await
                }
            };
            if ensure_snapshot_limit(&plaintext, &self.limits.collaboration).is_err() {
                return self
                    .fence_delivery_corruption(
                        transaction,
                        &room,
                        "collaboration snapshot exceeds the configured limit during catch-up",
                    )
                    .await;
            }
            cursor = snapshot_sequence;
            page_bytes += plaintext.len() as u64;
            items.push(CollaborationCatchUpItem {
                sequence: snapshot_sequence,
                replica_id: None,
                client_mutation_id: None,
                plaintext,
            });
        }

        let rows = sqlx::query(
            "SELECT sequence, update_ciphertext, update_digest, replica_id, client_mutation_id,
                    materialized_revision
             FROM hosted_provider_collaboration_updates
             WHERE collection_id=$1 AND record_id=$2 AND collaboration_epoch=$3 AND profile=$4
               AND sequence > $5 AND sequence <= $6
             ORDER BY sequence LIMIT $7",
        )
        .bind(room.collection_id)
        .bind(room.record_id)
        .bind(to_i64(room.epoch, "collaboration epoch")?)
        .bind(room.profile)
        .bind(to_i64(cursor, "collaboration sequence")?)
        .bind(to_i64(effective_through, "collaboration sequence")?)
        .bind(COLLABORATION_CATCHUP_PAGE_UPDATES)
        .fetch_all(&mut *transaction)
        .await?;
        let mut expected = cursor.saturating_add(1);
        for row in rows {
            let sequence = number(row.get::<i64, _>("sequence"), "update sequence")?;
            if sequence != expected {
                return self
                    .fence_delivery_corruption(
                        transaction,
                        &room,
                        "collaboration updates are not contiguous during catch-up",
                    )
                    .await;
            }
            let ciphertext: Vec<u8> = row.get("update_ciphertext");
            let mutation_id: Uuid = row.get("client_mutation_id");
            let plaintext = match decrypt_room_bytes(
                &self.crypto,
                &data_key,
                &room,
                AadKind::Update,
                sequence,
                Some(mutation_id),
                &ciphertext,
            ) {
                Ok(plaintext) => plaintext,
                Err(_) => {
                    return self
                        .fence_delivery_corruption(
                            transaction,
                            &room,
                            "collaboration update authentication failed during catch-up",
                        )
                        .await
                }
            };
            if row.get::<Vec<u8>, _>("update_digest") != digest_bytes(&plaintext) {
                return self
                    .fence_delivery_corruption(
                        transaction,
                        &room,
                        "collaboration update digest is invalid during catch-up",
                    )
                    .await;
            }
            if plaintext.len() as u64 > self.limits.collaboration.max_update_bytes {
                return self
                    .fence_delivery_corruption(
                        transaction,
                        &room,
                        "collaboration update exceeds the configured limit during catch-up",
                    )
                    .await;
            }
            // Only the final durable update must name the authoritative
            // revision; intermediate rows legitimately materialize older ones.
            if sequence == current_sequence
                && row.get::<String, _>("materialized_revision") != revision
            {
                return self
                    .fence_delivery_corruption(
                        transaction,
                        &room,
                        "collaboration update disagrees with the materialized revision",
                    )
                    .await;
            }
            page_bytes += ciphertext.len() as u64 + plaintext.len() as u64;
            if page_bytes > COLLABORATION_CATCHUP_PAGE_BYTES {
                break;
            }
            expected = sequence.saturating_add(1);
            cursor = sequence;
            items.push(CollaborationCatchUpItem {
                sequence,
                replica_id: Some(row.get("replica_id")),
                client_mutation_id: Some(mutation_id),
                plaintext,
            });
            if cursor == effective_through {
                break;
            }
        }
        transaction.commit().await?;
        Ok(items)
    }

    /// Fence a room whose durable state failed delivery validation, commit the
    /// fence, and surface the repair conflict. The fence must be committed
    /// here because the caller aborts on error.
    async fn fence_delivery_corruption(
        &self,
        transaction: Transaction<'_, Postgres>,
        room: &RoomIdentity,
        reason: &'static str,
    ) -> ApiResult<Vec<CollaborationCatchUpItem>> {
        transaction.rollback().await?;
        let mut transaction = self.pool.begin().await?;
        sqlx::query(
            "UPDATE hosted_provider_collaboration_documents SET state='rebuilding', updated_at=now()
             WHERE collection_id=$1 AND record_id=$2 AND collaboration_epoch=$3 AND profile=$4",
        )
        .bind(room.collection_id)
        .bind(room.record_id)
        .bind(to_i64(room.epoch, "collaboration epoch")?)
        .bind(room.profile)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        tracing::warn!(
            reason,
            "fenced collaboration room after failed delivery validation"
        );
        Err(ApiError::conflict("collaboration_repair_required", reason))
    }
}
