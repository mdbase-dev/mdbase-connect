use super::*;

impl HostedProvider {
    pub async fn prepare_authority_transfer(
        &self,
        collection_id: Uuid,
        input: PrepareAuthorityTransfer,
    ) -> ApiResult<ProviderAuthorityTransfer> {
        if !(60..=60 * 60).contains(&input.ttl_seconds) {
            return Err(ApiError::bad_request(
                "invalid_authority_transfer_ttl",
                "Authority transfer preparation must expire between one minute and one hour.",
            ));
        }
        let mut transaction = self.pool.begin().await?;
        recover_expired_authority_transfers_in(&mut transaction).await?;
        let collection = sqlx::query(
            r#"SELECT state, authority_epoch, head, wrapped_data_key
               FROM hosted_provider_collections
               WHERE id = $1
               FOR UPDATE"#,
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
        if let Some(existing) = sqlx::query(
            r#"SELECT id, collection_id, replica_id, final_head, next_authority_epoch,
                      manifest_digest, state, expires_at
               FROM hosted_provider_authority_transfers
               WHERE id = $1"#,
        )
        .bind(input.transfer_id)
        .fetch_optional(&mut *transaction)
        .await?
        {
            if existing.get::<Uuid, _>("collection_id") != collection_id
                || existing.get::<Uuid, _>("replica_id") != input.replica_id
            {
                return Err(ApiError::conflict(
                    "authority_transfer_conflict",
                    "Authority transfer already exists for another collection or mirror.",
                ));
            }
            let result = provider_authority_transfer(&existing)?;
            transaction.commit().await?;
            return Ok(result);
        }
        if hosted_collection_state(&collection, "state")? != HostedCollectionState::Active {
            return Err(ApiError::conflict(
                "authority_transfer_unavailable",
                "The hosted collection is not available for authority transfer.",
            ));
        }
        let replica = sqlx::query(
            r#"SELECT purpose, mode, allowed_types, revoked_at
               FROM hosted_provider_replicas
               WHERE id = $1 AND collection_id = $2
               FOR UPDATE"#,
        )
        .bind(input.replica_id)
        .bind(collection_id)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or_else(|| {
            ApiError::not_found("replica_not_found", "The promotion mirror was not found.")
        })?;
        let eligible = replica.get::<String, _>("purpose") == "mirror"
            && replica.get::<String, _>("mode") == "read_write"
            && replica.get::<Vec<String>, _>("allowed_types").is_empty()
            && replica
                .get::<Option<DateTime<Utc>>, _>("revoked_at")
                .is_none();
        if !eligible {
            return Err(ApiError::conflict(
                "promotion_mirror_ineligible",
                "Authority can move only to an active, two-way, full collection mirror.",
            ));
        }
        let head = number(collection.get::<i64, _>("head"), "collection head")?;
        let current_epoch = number(
            collection.get::<i64, _>("authority_epoch"),
            "authority epoch",
        )?;
        let next_epoch = current_epoch
            .checked_add(1)
            .ok_or_else(|| ApiError::internal("The collection authority epoch is exhausted."))?;
        let data_key = self
            .collection_key(collection_id, collection.get("wrapped_data_key"))
            .await?;
        let resources =
            load_resource_documents(&mut transaction, &self.crypto, &data_key, collection_id)
                .await?;
        let records =
            load_records(&mut transaction, &self.crypto, &data_key, collection_id).await?;
        let files =
            load_authority_files(&mut transaction, &self.crypto, &data_key, collection_id).await?;
        let manifest_digest = authority_manifest_digest(resources, records, files);
        let expires_at = Utc::now()
            + chrono::Duration::seconds(to_i64(input.ttl_seconds, "authority transfer lifetime")?);
        sqlx::query(
            r#"INSERT INTO hosted_provider_authority_transfers
                 (id, collection_id, replica_id, final_head, next_authority_epoch,
                  manifest_digest, expires_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7)"#,
        )
        .bind(input.transfer_id)
        .bind(collection_id)
        .bind(input.replica_id)
        .bind(to_i64(head, "collection head")?)
        .bind(to_i64(next_epoch, "authority epoch")?)
        .bind(&manifest_digest)
        .bind(expires_at)
        .execute(&mut *transaction)
        .await
        .map_err(|error| match error {
            sqlx::Error::Database(ref database) if database.is_unique_violation() => {
                ApiError::conflict(
                    "authority_transfer_in_progress",
                    "Another authority transfer is already in progress.",
                )
            }
            other => other.into(),
        })?;
        sqlx::query(
            "UPDATE hosted_provider_collections SET state = 'transferring', updated_at = now() WHERE id = $1",
        )
        .bind(collection_id)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(ProviderAuthorityTransfer {
            id: input.transfer_id,
            collection_id,
            replica_id: input.replica_id,
            final_head: head,
            authority_epoch: next_epoch,
            manifest_digest,
            state: ProviderAuthorityTransferState::Prepared,
            expires_at,
        })
    }

    pub async fn complete_authority_transfer(
        &self,
        transfer_id: Uuid,
        manifest_digest: &str,
    ) -> ApiResult<ProviderAuthorityTransfer> {
        let mut transaction = self.pool.begin().await?;
        let row = sqlx::query(
            r#"SELECT transfer.id, transfer.collection_id, transfer.replica_id,
                      transfer.final_head, transfer.next_authority_epoch,
                      transfer.manifest_digest, transfer.state, transfer.expires_at,
                      collection.state AS collection_state,
                      replica.acknowledged_sequence
               FROM hosted_provider_authority_transfers transfer
               JOIN hosted_provider_collections collection
                 ON collection.id = transfer.collection_id
               JOIN hosted_provider_replicas replica
                 ON replica.id = transfer.replica_id
               WHERE transfer.id = $1
               FOR UPDATE OF transfer, collection, replica"#,
        )
        .bind(transfer_id)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or_else(|| {
            ApiError::not_found(
                "authority_transfer_not_found",
                "Authority transfer was not found.",
            )
        })?;
        let transfer = provider_authority_transfer(&row)?;
        if transfer.state == ProviderAuthorityTransferState::Completed {
            transaction.commit().await?;
            return Ok(transfer);
        }
        if transfer.state != ProviderAuthorityTransferState::Prepared {
            return Err(ApiError::conflict(
                "authority_transfer_inactive",
                "Authority transfer is no longer active.",
            ));
        }
        if transfer.expires_at <= Utc::now() {
            sqlx::query(
                "UPDATE hosted_provider_authority_transfers SET state = 'aborted', aborted_at = now() WHERE id = $1",
            )
            .bind(transfer_id)
            .execute(&mut *transaction)
            .await?;
            sqlx::query(
                "UPDATE hosted_provider_collections SET state = 'active', updated_at = now() WHERE id = $1 AND state = 'transferring'",
            )
            .bind(transfer.collection_id)
            .execute(&mut *transaction)
            .await?;
            transaction.commit().await?;
            return Err(ApiError::conflict(
                "authority_transfer_expired",
                "Authority transfer expired and hosted writes were restored.",
            ));
        }
        if hosted_collection_state(&row, "collection_state")? != HostedCollectionState::Transferring
        {
            return Err(ApiError::conflict(
                "authority_transfer_inactive",
                "The hosted collection is no longer fenced for this transfer.",
            ));
        }
        if !constant_time_text_equal(&transfer.manifest_digest, manifest_digest) {
            return Err(ApiError::conflict(
                "authority_manifest_mismatch",
                "The local folder does not exactly match the fenced hosted collection.",
            ));
        }
        let acknowledged = number(
            row.get::<i64, _>("acknowledged_sequence"),
            "replica acknowledged sequence",
        )?;
        if acknowledged < transfer.final_head {
            return Err(ApiError::conflict(
                "promotion_mirror_behind",
                "The local mirror has not acknowledged the final hosted sequence.",
            ));
        }
        sqlx::query(
            r#"UPDATE hosted_provider_collections
               SET state = 'transferred', authority_epoch = $2, updated_at = now()
               WHERE id = $1 AND state = 'transferring'"#,
        )
        .bind(transfer.collection_id)
        .bind(to_i64(transfer.authority_epoch, "authority epoch")?)
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            r#"UPDATE hosted_provider_authority_transfers
               SET state = 'completed', completed_at = now()
               WHERE id = $1"#,
        )
        .bind(transfer_id)
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            "UPDATE hosted_provider_replicas SET revoked_at = COALESCE(revoked_at, now()) WHERE collection_id = $1",
        )
        .bind(transfer.collection_id)
        .execute(&mut *transaction)
        .await?;
        sqlx::query("DELETE FROM hosted_provider_snapshot_leases WHERE collection_id = $1")
            .bind(transfer.collection_id)
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
        self.working_sets
            .lock()
            .await
            .remove(&transfer.collection_id);
        Ok(ProviderAuthorityTransfer {
            state: ProviderAuthorityTransferState::Completed,
            ..transfer
        })
    }

    pub async fn abort_authority_transfer(
        &self,
        transfer_id: Uuid,
    ) -> ApiResult<ProviderAuthorityTransfer> {
        let mut transaction = self.pool.begin().await?;
        let row = sqlx::query(
            r#"SELECT id, collection_id, replica_id, final_head, next_authority_epoch,
                      manifest_digest, state, expires_at
               FROM hosted_provider_authority_transfers
               WHERE id = $1
               FOR UPDATE"#,
        )
        .bind(transfer_id)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or_else(|| {
            ApiError::not_found(
                "authority_transfer_not_found",
                "Authority transfer was not found.",
            )
        })?;
        let transfer = provider_authority_transfer(&row)?;
        if transfer.state == ProviderAuthorityTransferState::Completed {
            return Err(ApiError::conflict(
                "authority_transfer_completed",
                "Completed authority transfer cannot be cancelled.",
            ));
        }
        if transfer.state == ProviderAuthorityTransferState::Prepared {
            sqlx::query(
                "UPDATE hosted_provider_authority_transfers SET state = 'aborted', aborted_at = now() WHERE id = $1",
            )
            .bind(transfer_id)
            .execute(&mut *transaction)
            .await?;
            sqlx::query(
                "UPDATE hosted_provider_collections SET state = 'active', updated_at = now() WHERE id = $1 AND state = 'transferring'",
            )
            .bind(transfer.collection_id)
            .execute(&mut *transaction)
            .await?;
        }
        transaction.commit().await?;
        Ok(ProviderAuthorityTransfer {
            state: ProviderAuthorityTransferState::Aborted,
            ..transfer
        })
    }

    pub async fn recover_expired_authority_transfers(&self) -> ApiResult<usize> {
        let mut transaction = self.pool.begin().await?;
        let recovered = recover_expired_authority_transfers_in(&mut transaction).await?;
        transaction.commit().await?;
        Ok(recovered)
    }
}
