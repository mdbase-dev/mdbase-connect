use super::files::{descriptor, HostedFilePayload};
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
            let files_out_of_scope =
                replica.purpose == ReplicaPurpose::Application && replica.file_capability.is_none();
            sqlx::query(
                r#"UPDATE hosted_provider_snapshot_leases
                   SET records_complete = true,
                       files_complete = files_complete OR $2 OR NOT EXISTS (
                         SELECT 1 FROM hosted_provider_file_versions version
                         WHERE version.collection_id = hosted_provider_snapshot_leases.collection_id
                           AND version.sequence <= hosted_provider_snapshot_leases.cursor
                           AND version.deleted = false
                       )
                   WHERE id = $1"#,
            )
            .bind(snapshot_id)
            .bind(files_out_of_scope)
            .execute(&self.pool)
            .await?;
            acknowledge_complete_snapshot(&self.pool, snapshot_id, replica.id, cursor).await?;
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

    pub async fn file_snapshot(
        &self,
        collection_id: Uuid,
        token: &str,
        snapshot_id: Uuid,
        page: Option<&str>,
        request_origin: Option<&str>,
    ) -> ApiResult<SyncFileSnapshotPage> {
        let replica = self
            .authenticate_for_sync(collection_id, token, "read", request_origin)
            .await?;
        let after_file_id = page
            .map(|value| {
                Uuid::parse_str(value).map_err(|_| {
                    ApiError::bad_request("invalid_page", "File snapshot page token is invalid.")
                })
            })
            .transpose()?;
        let lease = sqlx::query(
            r#"SELECT lease.cursor, lease.scope_epoch, collection.wrapped_data_key
               FROM hosted_provider_snapshot_leases lease
               JOIN hosted_provider_collections collection ON collection.id = lease.collection_id
               WHERE lease.id = $1 AND lease.collection_id = $2 AND lease.replica_id = $3
                 AND lease.expires_at > now() AND collection.state = 'active'"#,
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
        let cursor = number(lease.get("cursor"), "snapshot cursor")?;
        let scope_epoch = number(lease.get("scope_epoch"), "scope epoch")?;
        if scope_epoch != replica.scope_epoch {
            return Err(ApiError::conflict(
                "snapshot_expired",
                "The replica scope changed; open a new sync session.",
            ));
        }
        let data_key = self.collection_key(collection_id, lease.get("wrapped_data_key"))?;
        let rows = sqlx::query(
            r#"SELECT file_id, revision, size, object_key, payload_ciphertext, sequence
               FROM (
                 SELECT DISTINCT ON (file_id)
                   file_id, revision, size, object_key, payload_ciphertext, sequence, deleted
                 FROM hosted_provider_file_versions
                 WHERE collection_id = $1 AND sequence <= $2
                 ORDER BY file_id, sequence DESC
               ) versions
               WHERE deleted = false AND ($3::uuid IS NULL OR file_id > $3)
               ORDER BY file_id LIMIT $4"#,
        )
        .bind(collection_id)
        .bind(to_i64(cursor, "snapshot cursor")?)
        .bind(after_file_id)
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
                .expect("a full file snapshot page has a final file")
                .get::<Uuid, _>("file_id")
                .to_string()
        });
        let mut files = Vec::new();
        for row in page_rows {
            let file_id: Uuid = row.get("file_id");
            let sequence = number(row.get("sequence"), "file sequence")?;
            let payload: HostedFilePayload = self.crypto.decrypt_json(
                &data_key,
                row.get("payload_ciphertext"),
                &file_version_aad(collection_id, file_id, sequence),
            )?;
            let file = descriptor(
                file_id,
                row.get("revision"),
                number(row.get("size"), "file size")?,
                payload,
            );
            if authorize_file_access(&replica, FileAction::List, Some(&file.path), request_origin)
                .is_ok()
            {
                files.push(file);
            }
        }
        if next_page.is_none() {
            sqlx::query(
                "UPDATE hosted_provider_snapshot_leases SET files_complete = true WHERE id = $1",
            )
            .bind(snapshot_id)
            .execute(&self.pool)
            .await?;
            acknowledge_complete_snapshot(&self.pool, snapshot_id, replica.id, cursor).await?;
        }
        Ok(SyncFileSnapshotPage {
            protocol_version: SYNC_PROTOCOL_VERSION,
            message_type: SyncFileSnapshotPageKind::FileSnapshotPage,
            snapshot_id,
            scope_epoch,
            cursor,
            files,
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
            r#"SELECT sequence, 'record'::text AS kind, record_id AS item_id,
                      before_ciphertext, after_ciphertext, revision,
                      NULL::bigint AS before_size, NULL::bigint AS after_size
               FROM hosted_provider_changes
               WHERE collection_id = $1 AND sequence > $2
               UNION ALL
               SELECT sequence, 'file'::text AS kind, file_id AS item_id,
                      before_ciphertext, after_ciphertext, revision,
                      before_size, after_size
               FROM hosted_provider_file_changes
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
            let item_id: Uuid = row.get("item_id");
            if row.get::<String, _>("kind") == "record" {
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
                        record_id: item_id,
                        previous_path: before.path,
                        revision: row.get("revision"),
                    });
                }
            } else {
                let before = optional_file_change_payload(
                    &self.crypto,
                    &data_key,
                    row.get("before_ciphertext"),
                    &change_file_aad(collection_id, sequence, "before"),
                )?;
                let after_file = optional_file_change_payload(
                    &self.crypto,
                    &data_key,
                    row.get("after_ciphertext"),
                    &change_file_aad(collection_id, sequence, "after"),
                )?;
                let before_visible = before.as_ref().is_some_and(|file| {
                    authorize_file_access(
                        &replica,
                        FileAction::List,
                        Some(&file.path),
                        request_origin,
                    )
                    .is_ok()
                });
                let after_visible = after_file.as_ref().is_some_and(|file| {
                    authorize_file_access(
                        &replica,
                        FileAction::List,
                        Some(&file.path),
                        request_origin,
                    )
                    .is_ok()
                });
                if after_visible {
                    let payload = after_file.expect("visibility checked above");
                    events.push(SyncChange::FilePut {
                        sequence,
                        file: descriptor(
                            item_id,
                            row.get("revision"),
                            number(row.get("after_size"), "file size")?,
                            payload,
                        ),
                    });
                } else if before_visible {
                    events.push(SyncChange::FileRemove {
                        sequence,
                        file_id: item_id,
                        previous_path: before.expect("visibility checked above").path,
                        revision: row.get("revision"),
                    });
                }
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

async fn acknowledge_complete_snapshot(
    pool: &PgPool,
    snapshot_id: Uuid,
    replica_id: Uuid,
    cursor: u64,
) -> ApiResult<()> {
    sqlx::query(
        r#"UPDATE hosted_provider_replicas replica
           SET acknowledged_sequence = GREATEST(replica.acknowledged_sequence, $3),
               last_seen_at = now()
           FROM hosted_provider_snapshot_leases lease
           WHERE replica.id = $2 AND lease.id = $1
             AND lease.records_complete AND lease.files_complete"#,
    )
    .bind(snapshot_id)
    .bind(replica_id)
    .bind(to_i64(cursor, "snapshot cursor")?)
    .execute(pool)
    .await?;
    Ok(())
}

fn optional_file_change_payload(
    crypto: &ProviderCrypto,
    data_key: &[u8; 32],
    value: Option<&[u8]>,
    aad: &[u8],
) -> ApiResult<Option<HostedFilePayload>> {
    value
        .map(|value| crypto.decrypt_json(data_key, value, aad))
        .transpose()
}
