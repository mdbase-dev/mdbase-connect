use super::*;

impl HostedProvider {
    pub async fn open_session(
        &self,
        collection_id: Uuid,
        token: &str,
        request_origin: Option<&str>,
    ) -> ApiResult<SyncSession> {
        let replica = self
            .authenticate_for_sync(collection_id, token, "read", request_origin)
            .await?;
        let row = sqlx::query(
            r#"SELECT head, retained_after, resource_revision, wrapped_data_key, resources_ciphertext
               FROM hosted_provider_collections collection
               WHERE id = $1 AND (
                 state = 'active'
                 OR (
                   state = 'transferring'
                   AND EXISTS (
                     SELECT 1 FROM hosted_provider_authority_transfers transfer
                     WHERE transfer.collection_id = collection.id
                       AND transfer.replica_id = $2
                       AND transfer.state = 'prepared'
                       AND transfer.expires_at > now()
                   )
                 )
               )"#,
        )
        .bind(collection_id)
        .bind(replica.id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| {
            ApiError::not_found(
                "hosted_collection_not_found",
                "Hosted collection not found.",
            )
        })?;
        let head = number(row.get::<i64, _>("head"), "collection head")?;
        let retained_after = number(row.get::<i64, _>("retained_after"), "retained cursor")?;
        let resource_revision: String = row.get("resource_revision");
        let data_key = self.collection_key(collection_id, row.get("wrapped_data_key"))?;
        let mut resources: SyncCollectionResources = self.crypto.decrypt_json(
            &data_key,
            row.get("resources_ciphertext"),
            &resources_aad(collection_id),
        )?;
        resources.documents =
            load_sync_resource_documents(&self.pool, &self.crypto, &data_key, collection_id)
                .await?;
        let snapshot_id = Uuid::new_v4();
        let mut transaction = self.pool.begin().await?;
        sqlx::query("DELETE FROM hosted_provider_snapshot_leases WHERE expires_at <= now()")
            .execute(&mut *transaction)
            .await?;
        sqlx::query(
            r#"INSERT INTO hosted_provider_snapshot_leases
                 (id, collection_id, replica_id, scope_epoch, cursor, resource_revision, expires_at)
               VALUES ($1, $2, $3, $4, $5, $6, now() + interval '15 minutes')"#,
        )
        .bind(snapshot_id)
        .bind(collection_id)
        .bind(replica.id)
        .bind(to_i64(replica.scope_epoch, "scope epoch")?)
        .bind(to_i64(head, "collection head")?)
        .bind(resource_revision)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(SyncSession {
            protocol_version: SYNC_PROTOCOL_VERSION,
            session_id: Uuid::new_v4(),
            replica_id: replica.id,
            collection_id,
            mode: replica.mode,
            scope_epoch: replica.scope_epoch,
            retained_after,
            head,
            snapshot_id,
            resources: scoped_resources(resources, &replica.allowed_types),
        })
    }

    pub async fn snapshot(
        &self,
        collection_id: Uuid,
        token: &str,
        snapshot_id: Uuid,
        page: Option<&str>,
        request_origin: Option<&str>,
    ) -> ApiResult<SyncSnapshotPage> {
        let replica = self
            .authenticate_for_sync(collection_id, token, "read", request_origin)
            .await?;
        let after_record_id = page
            .map(|value| {
                Uuid::parse_str(value).map_err(|_| {
                    ApiError::bad_request("invalid_page", "Snapshot page token is invalid.")
                })
            })
            .transpose()?;
        let lease = sqlx::query(
            r#"SELECT lease.cursor, lease.scope_epoch, collection.wrapped_data_key
               FROM hosted_provider_snapshot_leases lease
               JOIN hosted_provider_collections collection ON collection.id = lease.collection_id
               WHERE lease.id = $1 AND lease.collection_id = $2 AND lease.replica_id = $3
                 AND lease.expires_at > now()
                 AND (
                   collection.state = 'active'
                   OR (
                     collection.state = 'transferring'
                     AND EXISTS (
                       SELECT 1 FROM hosted_provider_authority_transfers transfer
                       WHERE transfer.collection_id = collection.id
                         AND transfer.replica_id = $3
                         AND transfer.state = 'prepared'
                         AND transfer.expires_at > now()
                     )
                   )
                 )"#,
        )
        .bind(snapshot_id)
        .bind(collection_id)
        .bind(replica.id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| {
            ApiError::conflict(
                "snapshot_expired",
                "The snapshot is unavailable; open a new sync session.",
            )
        })?;
        let cursor = number(lease.get::<i64, _>("cursor"), "snapshot cursor")?;
        let scope_epoch = number(lease.get::<i64, _>("scope_epoch"), "scope epoch")?;
        if scope_epoch != replica.scope_epoch {
            return Err(ApiError::conflict(
                "snapshot_expired",
                "The replica scope changed; open a new sync session.",
            ));
        }
        let data_key = self.collection_key(collection_id, lease.get("wrapped_data_key"))?;
        let rows = sqlx::query(
            r#"SELECT record_id, revision, types, sequence, payload_ciphertext
               FROM (
                 SELECT DISTINCT ON (record_id)
                   record_id, revision, types, sequence, payload_ciphertext, deleted
                 FROM hosted_provider_record_versions
                 WHERE collection_id = $1 AND sequence <= $2
                 ORDER BY record_id, sequence DESC
               ) versions
               WHERE deleted = false
                 AND (cardinality($3::text[]) = 0 OR types && $3::text[])
                 AND ($4::uuid IS NULL OR record_id > $4)
               ORDER BY record_id
               LIMIT $5"#,
        )
        .bind(collection_id)
        .bind(to_i64(cursor, "snapshot cursor")?)
        .bind(&replica.allowed_types)
        .bind(after_record_id)
        .bind(SNAPSHOT_PAGE_SIZE + 1)
        .fetch_all(&self.pool)
        .await?;
        let has_more = rows.len() > SNAPSHOT_PAGE_SIZE as usize;
        let page_rows = rows
            .into_iter()
            .take(SNAPSHOT_PAGE_SIZE as usize)
            .collect::<Vec<_>>();
        let next_page = has_more.then(|| {
            page_rows
                .last()
                .expect("a full snapshot page has a final record")
                .get::<Uuid, _>("record_id")
                .to_string()
        });
        let records = page_rows
            .into_iter()
            .map(|row| {
                let sequence = number(row.get::<i64, _>("sequence"), "record sequence")?;
                let payload: PersistedRecord = self.crypto.decrypt_json(
                    &data_key,
                    row.get("payload_ciphertext"),
                    &record_version_aad(collection_id, row.get("record_id"), sequence),
                )?;
                Ok(SyncSnapshotRecord {
                    record: payload.record,
                    document: payload.document,
                })
            })
            .collect::<ApiResult<Vec<_>>>()?;
        if next_page.is_none() {
            sqlx::query(
                r#"UPDATE hosted_provider_replicas
                   SET acknowledged_sequence = GREATEST(acknowledged_sequence, $2),
                       last_seen_at = now()
                   WHERE id = $1"#,
            )
            .bind(replica.id)
            .bind(to_i64(cursor, "snapshot cursor")?)
            .execute(&self.pool)
            .await?;
        }
        Ok(SyncSnapshotPage {
            protocol_version: SYNC_PROTOCOL_VERSION,
            snapshot_id,
            scope_epoch,
            cursor,
            records,
            next_page,
        })
    }

    pub async fn changes(
        &self,
        collection_id: Uuid,
        token: &str,
        after: u64,
        limit: u32,
        request_origin: Option<&str>,
    ) -> ApiResult<SyncChangesPage> {
        let replica = self
            .authenticate_for_sync(collection_id, token, "changes", request_origin)
            .await?;
        let collection = sqlx::query(
            r#"SELECT head, retained_after, wrapped_data_key
               FROM hosted_provider_collections collection
               WHERE id = $1 AND (
                 state = 'active'
                 OR (
                   state = 'transferring'
                   AND EXISTS (
                     SELECT 1 FROM hosted_provider_authority_transfers transfer
                     WHERE transfer.collection_id = collection.id
                       AND transfer.replica_id = $2
                       AND transfer.state = 'prepared'
                       AND transfer.expires_at > now()
                   )
                 )
               )"#,
        )
        .bind(collection_id)
        .bind(replica.id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| {
            ApiError::not_found(
                "hosted_collection_not_found",
                "Hosted collection not found.",
            )
        })?;
        let head = number(collection.get::<i64, _>("head"), "collection head")?;
        let retained_after = number(
            collection.get::<i64, _>("retained_after"),
            "retained cursor",
        )?;
        let data_key = self.collection_key(collection_id, collection.get("wrapped_data_key"))?;
        if after < retained_after {
            return Ok(SyncChangesPage {
                protocol_version: SYNC_PROTOCOL_VERSION,
                scope_epoch: replica.scope_epoch,
                events: Vec::new(),
                cursor: after,
                head,
                has_more: false,
                reset_required: true,
            });
        }
        if after > head {
            return Err(ApiError::bad_request(
                "invalid_cursor",
                "Change cursor is ahead of the collection authority.",
            ));
        }
        let resource_changed = sqlx::query_scalar::<_, bool>(
            r#"SELECT EXISTS(
                 SELECT 1 FROM hosted_provider_resource_changes
                 WHERE collection_id = $1 AND sequence > $2
               )"#,
        )
        .bind(collection_id)
        .bind(to_i64(after, "change cursor")?)
        .fetch_one(&self.pool)
        .await?;
        if resource_changed {
            return Ok(SyncChangesPage {
                protocol_version: SYNC_PROTOCOL_VERSION,
                scope_epoch: replica.scope_epoch,
                events: Vec::new(),
                cursor: after,
                head,
                has_more: false,
                reset_required: true,
            });
        }
        let raw_limit = i64::from(limit.clamp(1, 500));
        let rows = sqlx::query(
            r#"SELECT sequence, record_id, before_ciphertext, after_ciphertext, revision
               FROM hosted_provider_changes
               WHERE collection_id = $1 AND sequence > $2
               ORDER BY sequence
               LIMIT $3"#,
        )
        .bind(collection_id)
        .bind(to_i64(after, "change cursor")?)
        .bind(raw_limit)
        .fetch_all(&self.pool)
        .await?;
        let cursor = rows
            .last()
            .map(|row| number(row.get::<i64, _>("sequence"), "change sequence"))
            .transpose()?
            .unwrap_or(after);
        let mut events = Vec::new();
        for row in rows {
            let sequence = number(row.get::<i64, _>("sequence"), "change sequence")?;
            let record_id: Uuid = row.get("record_id");
            let before = optional_encrypted_record(
                &self.crypto,
                &data_key,
                row.get("before_ciphertext"),
                &change_record_aad(collection_id, sequence, "before"),
            )?;
            let after_record = optional_encrypted_record(
                &self.crypto,
                &data_key,
                row.get("after_ciphertext"),
                &change_record_aad(collection_id, sequence, "after"),
            )?;
            let before_visible = before
                .as_ref()
                .is_some_and(|record| visible(record, &replica.allowed_types));
            let after_visible = after_record
                .as_ref()
                .is_some_and(|record| visible(record, &replica.allowed_types));
            if after_visible {
                events.push(SyncChange::Put {
                    sequence,
                    record: after_record.expect("visibility checked above"),
                });
            } else if before_visible {
                let before = before.expect("visibility checked above");
                events.push(SyncChange::Remove {
                    sequence,
                    record_id,
                    previous_path: before.path,
                    revision: row.get("revision"),
                });
            }
        }
        sqlx::query(
            r#"UPDATE hosted_provider_replicas
               SET acknowledged_sequence = GREATEST(acknowledged_sequence, $2), last_seen_at = now()
               WHERE id = $1"#,
        )
        .bind(replica.id)
        .bind(to_i64(cursor, "change cursor")?)
        .execute(&self.pool)
        .await?;
        Ok(SyncChangesPage {
            protocol_version: SYNC_PROTOCOL_VERSION,
            scope_epoch: replica.scope_epoch,
            events,
            cursor,
            head,
            has_more: cursor < head,
            reset_required: false,
        })
    }
}
