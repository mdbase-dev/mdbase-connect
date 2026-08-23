use super::*;
use crate::provider::projections::ActiveProjectionChange;

/// The already-staged exact records and documents for one hosted write set.
pub(crate) struct HostedWriteSet {
    pub(crate) before_records: BTreeMap<Uuid, SyncRecord>,
    pub(crate) changed: Vec<(Uuid, Option<SyncRecord>, Option<String>)>,
    pub(crate) primary_record_id: Uuid,
}

pub(crate) struct HostedWriteSetCommit {
    pub(crate) head: u64,
    pub(crate) primary: Option<SyncRecord>,
}

/// Persist an exact hosted write set into a caller-owned transaction.
///
/// This function deliberately does not perform authorization, journal work, receipt
/// work, transaction control, logging, or notification recovery.
pub(crate) async fn commit_hosted_write_set_in(
    transaction: &mut Transaction<'_, Postgres>,
    provider: &HostedProvider,
    collection_id: Uuid,
    data_key: &[u8; 32],
    collection: &PgRow,
    source_replica_id: Option<Uuid>,
    write_set: HostedWriteSet,
    notification_runtime_active: bool,
) -> ApiResult<HostedWriteSetCommit> {
    let mut head = number(collection.get::<i64, _>("head"), "collection head")?;
    let record_count = number(collection.get::<i64, _>("record_count"), "record count")?;
    let content_bytes = number(
        collection.get::<i64, _>("content_bytes"),
        "collection content bytes",
    )?;
    let max_records = number(collection.get::<i64, _>("max_records"), "record quota")?;
    let max_content_bytes = number(
        collection.get::<i64, _>("max_content_bytes"),
        "collection byte quota",
    )?;
    let max_document_bytes = number(
        collection.get::<i64, _>("max_document_bytes"),
        "document byte quota",
    )?;

    let mut deltas = Vec::with_capacity(write_set.changed.len());
    let mut changed_ids = BTreeSet::new();
    for (record_id, after, document) in &write_set.changed {
        if !changed_ids.insert(*record_id) {
            return Err(ApiError::internal(
                "The hosted write set contains a duplicate record identity.",
            ));
        }
        let before = write_set.before_records.get(record_id);
        if before.is_some_and(|record| record.record_id != *record_id)
            || after
                .as_ref()
                .is_some_and(|record| record.record_id != *record_id)
            || (before.is_none() && after.is_none())
        {
            return Err(ApiError::internal(
                "The hosted write set contains an inconsistent record identity.",
            ));
        }
        match (after, document) {
            (Some(record), Some(document)) if record.document.as_str() == document.as_str() => {}
            (None, _) => {}
            _ => {
                return Err(ApiError::internal(
                    "The hosted write set disagrees with its exact document.",
                ))
            }
        }
        let before_bytes = before
            .map(|record| record.document.len() as u64)
            .unwrap_or_default();
        let after_bytes = after
            .as_ref()
            .map(|record| record.document.len() as u64)
            .unwrap_or_default();
        if after.is_some() && after_bytes > max_document_bytes {
            return Err(ApiError::quota(
                "document_quota_exceeded",
                "The canonical Markdown document exceeds the hosted document size limit.",
            ));
        }
        deltas.push((before.is_some(), before_bytes, after.is_some(), after_bytes));
    }
    if !changed_ids.contains(&write_set.primary_record_id) {
        return Err(ApiError::internal(
            "The hosted write set omits its primary record identity.",
        ));
    }
    let (next_record_count, next_content_bytes) =
        quota_totals(record_count, content_bytes, &deltas);
    if next_record_count < 0
        || next_record_count > i128::from(max_records)
        || next_content_bytes < 0
        || next_content_bytes > i128::from(max_content_bytes)
    {
        return Err(ApiError::quota(
            "collection_quota_exceeded",
            "The mutation would exceed the hosted collection quota.",
        ));
    }

    let mut primary = None;
    let mut projection_changes = Vec::with_capacity(write_set.changed.len());
    for (record_id, after, document) in write_set.changed {
        head = head
            .checked_add(1)
            .ok_or_else(|| ApiError::internal("The hosted collection sequence is exhausted."))?;
        let before = write_set.before_records.get(&record_id).cloned();
        let notification_event = notification_runtime_active
            .then(|| application_change(before.as_ref(), after.as_ref()));
        let (revision, file_mtime) = if let Some(record) = &after {
            let modified_at = persist_live_record(
                transaction,
                &provider.crypto,
                data_key,
                collection_id,
                head,
                record,
            )
            .await?;
            if record_id == write_set.primary_record_id {
                primary = Some(record.clone());
            }
            (
                record.revision.clone(),
                Some(modified_at.to_rfc3339_opts(SecondsFormat::Micros, true)),
            )
        } else {
            let before = before.as_ref().ok_or_else(|| {
                ApiError::internal("The hosted write set deleted an unknown record.")
            })?;
            let revision = format!("hosted:1:{head}:tombstone");
            persist_deleted_record(transaction, collection_id, head, before, &revision).await?;
            (revision, None)
        };
        projection_changes.push(ActiveProjectionChange {
            record_id,
            record_sequence: head,
            sequence: head,
            was_present: before.is_some(),
            force_relationship_resolution: false,
            file_mtime,
            record: after.clone(),
        });
        let before_ciphertext = before
            .as_ref()
            .map(|record| {
                provider.crypto.encrypt_json(
                    data_key,
                    record,
                    &change_record_aad(collection_id, head, "before"),
                )
            })
            .transpose()?;
        let after_ciphertext = after
            .as_ref()
            .map(|record| {
                provider.crypto.encrypt_json(
                    data_key,
                    record,
                    &change_record_aad(collection_id, head, "after"),
                )
            })
            .transpose()?;
        sqlx::query(
            r#"INSERT INTO hosted_provider_changes
                 (collection_id, sequence, record_id, before_types, after_types,
                  before_ciphertext, after_ciphertext, revision, source_replica_id)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)"#,
        )
        .bind(collection_id)
        .bind(to_i64(head, "change sequence")?)
        .bind(record_id)
        .bind(
            before
                .as_ref()
                .map(|record| record.types.clone())
                .unwrap_or_default(),
        )
        .bind(
            after
                .as_ref()
                .map(|record| record.types.clone())
                .unwrap_or_default(),
        )
        .bind(before_ciphertext)
        .bind(after_ciphertext)
        .bind(revision)
        .bind(source_replica_id)
        .execute(&mut **transaction)
        .await?;
        if let Some((event_type, payload)) = notification_event {
            sqlx::query(
                "INSERT INTO hosted_provider_runtime_outbox
                    (collection_id, sequence, event_type, payload)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT(collection_id, sequence) DO NOTHING",
            )
            .bind(collection_id)
            .bind(to_i64(head, "runtime event sequence")?)
            .bind(event_type)
            .bind(payload)
            .execute(&mut **transaction)
            .await?;
        }
        debug_assert!(after.is_none() || document.is_some());
    }
    provider
        .maintain_active_projection_changes(
            transaction,
            collection_id,
            data_key,
            &projection_changes,
        )
        .await?;
    sqlx::query(
        r#"UPDATE hosted_provider_collections
           SET head = $2, record_count = $3, content_bytes = $4,
               active_projection_head = CASE
                 WHEN active_projection_generation_id IS NULL THEN NULL
                 ELSE $2
               END,
               updated_at = now()
           WHERE id = $1"#,
    )
    .bind(collection_id)
    .bind(to_i64(head, "collection head")?)
    .bind(i64::try_from(next_record_count).map_err(|_| {
        ApiError::internal("The hosted record count is outside the supported range.")
    })?)
    .bind(i64::try_from(next_content_bytes).map_err(|_| {
        ApiError::internal("The hosted content size is outside the supported range.")
    })?)
    .execute(&mut **transaction)
    .await?;
    Ok(HostedWriteSetCommit { head, primary })
}

fn quota_totals(
    record_count: u64,
    content_bytes: u64,
    deltas: &[(bool, u64, bool, u64)],
) -> (i128, i128) {
    deltas.iter().fold(
        (i128::from(record_count), i128::from(content_bytes)),
        |(records, bytes), (before_present, before_bytes, after_present, after_bytes)| {
            (
                records
                    + match (before_present, after_present) {
                        (false, true) => 1,
                        (true, false) => -1,
                        _ => 0,
                    },
                bytes + i128::from(*after_bytes) - i128::from(*before_bytes),
            )
        },
    )
}

#[cfg(test)]
mod tests {
    use super::quota_totals;

    #[test]
    fn quota_deltas_cover_create_update_delete_and_multi_record_sets() {
        assert_eq!(quota_totals(0, 0, &[(false, 0, true, 12)]), (1, 12));
        assert_eq!(quota_totals(1, 12, &[(true, 12, true, 20)]), (1, 20));
        assert_eq!(quota_totals(1, 20, &[(true, 20, false, 0)]), (0, 0));
        assert_eq!(
            quota_totals(2, 30, &[(false, 0, true, 8), (true, 20, false, 0)]),
            (2, 18)
        );
    }
}
