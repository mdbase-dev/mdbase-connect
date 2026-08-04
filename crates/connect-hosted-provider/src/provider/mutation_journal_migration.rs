use super::mutation_journal::{hosted_mutation_receipt_aad, sync_receipt_applied};
use super::mutation_receipt::StoredMutationReceipt;
use super::*;

impl HostedProvider {
    pub(super) async fn migrate_legacy_sync_receipts(&self) -> ApiResult<u64> {
        let rows = sqlx::query(
            r#"SELECT legacy.replica_id, legacy.mutation_id, legacy.mutation_hash,
                      legacy.receipt_ciphertext, legacy.created_at,
                      replica.grant_id, replica.collection_id,
                      collection.wrapped_data_key
               FROM archived_hosted_mutation_receipts legacy
               JOIN hosted_provider_replicas replica ON replica.id = legacy.replica_id
               JOIN hosted_provider_collections collection ON collection.id = replica.collection_id
               WHERE legacy.migrated_at IS NULL
               ORDER BY legacy.created_at, legacy.replica_id, legacy.mutation_id"#,
        )
        .fetch_all(&self.pool)
        .await?;
        let mut migrated = 0_u64;
        for row in rows {
            let replica_id: Uuid = row.get("replica_id");
            let request_id: Uuid = row.get("mutation_id");
            let collection_id: Uuid = row.get("collection_id");
            let data_key = self
                .collection_key(collection_id, row.get("wrapped_data_key"))
                .await?;
            let receipt: SyncMutationReceipt = self.crypto.decrypt_json(
                &data_key,
                row.get("receipt_ciphertext"),
                &receipt_aad(replica_id, request_id),
            )?;
            let effect_applied = sync_receipt_applied(&receipt);
            let value = serde_json::to_value(receipt).map_err(|error| {
                ApiError::internal(format!("Legacy sync receipt could not serialize: {error}"))
            })?;
            let stored = StoredMutationReceipt::Success { value };
            let plaintext = serde_json::to_vec(&stored).map_err(|error| {
                ApiError::internal(format!(
                    "Migrated sync receipt could not serialize: {error}"
                ))
            })?;
            let ciphertext = self.crypto.encrypt_bytes(
                &data_key,
                &plaintext,
                &hosted_mutation_receipt_aad(replica_id, request_id),
            )?;
            let mut transaction = self.pool.begin().await?;
            let inserted = sqlx::query(
                r#"INSERT INTO hosted_provider_mutation_journal (
                     replica_id, grant_id, request_id, operation_kind,
                     fingerprint_schema_version, input_schema_version, input_digest,
                     state, process_epoch, lease_owner, lease_expires_at,
                     fencing_generation, final_receipt_ciphertext, receipt_digest,
                     effect_applied, accepted_at, updated_at, completed_at
                   ) VALUES ($1, $2, $3, 'sync:mutate', 0, 1, $4, 'completed',
                             $5, $6, $7, 1, $8, $9, $10, $11, $11, $11)
                   ON CONFLICT (replica_id, request_id) DO NOTHING"#,
            )
            .bind(replica_id)
            .bind(row.get::<Option<Uuid>, _>("grant_id"))
            .bind(request_id)
            .bind(row.get::<Vec<u8>, _>("mutation_hash"))
            .bind(self.process_epoch)
            .bind(Uuid::new_v4())
            .bind(row.get::<DateTime<Utc>, _>("created_at"))
            .bind(ciphertext)
            .bind(Sha256::digest(&plaintext).to_vec())
            .bind(effect_applied)
            .bind(row.get::<DateTime<Utc>, _>("created_at"))
            .execute(&mut *transaction)
            .await?
            .rows_affected();
            if inserted == 0 {
                let existing = sqlx::query(
                    r#"SELECT operation_kind, fingerprint_schema_version, input_digest,
                              state, receipt_digest
                       FROM hosted_provider_mutation_journal
                       WHERE replica_id = $1 AND request_id = $2 FOR UPDATE"#,
                )
                .bind(replica_id)
                .bind(request_id)
                .fetch_one(&mut *transaction)
                .await?;
                let same = existing.get::<String, _>("operation_kind") == "sync:mutate"
                    && existing.get::<i32, _>("fingerprint_schema_version") == 0
                    && bool::from(
                        existing
                            .get::<Vec<u8>, _>("input_digest")
                            .ct_eq(&row.get::<Vec<u8>, _>("mutation_hash")),
                    )
                    && matches!(
                        existing.get::<String, _>("state").as_str(),
                        "completed" | "acknowledged"
                    )
                    && bool::from(
                        existing
                            .get::<Vec<u8>, _>("receipt_digest")
                            .ct_eq(&Sha256::digest(&plaintext)),
                    );
                if !same {
                    return Err(ApiError::internal(format!(
                        "Legacy sync receipt {request_id} collides with incompatible mutation journal state."
                    )));
                }
            }
            sqlx::query(
                r#"UPDATE archived_hosted_mutation_receipts SET migrated_at = now()
                   WHERE replica_id = $1 AND mutation_id = $2 AND migrated_at IS NULL"#,
            )
            .bind(replica_id)
            .bind(request_id)
            .execute(&mut *transaction)
            .await?;
            transaction.commit().await?;
            migrated += 1;
        }
        Ok(migrated)
    }
}
