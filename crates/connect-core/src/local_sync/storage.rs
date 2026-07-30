use super::*;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum AuthorityRole {
    Active,
    Transferring(Uuid),
    Retired,
}

pub(super) fn authority_role(
    connection: &Connection,
    collection_id: Uuid,
) -> Result<AuthorityRole, ConnectError> {
    let row = connection
        .query_row(
            "SELECT authority_state, transfer_id
             FROM local_sync_collections WHERE collection_id = ?1",
            [collection_id.to_string()],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()?;
    let Some((state, transfer_id)) = row else {
        return Ok(AuthorityRole::Active);
    };
    match state.as_str() {
        "active" => Ok(AuthorityRole::Active),
        "retired" => Ok(AuthorityRole::Retired),
        "transferring" => {
            let transfer_id = transfer_id
                .as_deref()
                .and_then(|value| Uuid::parse_str(value).ok())
                .ok_or_else(|| {
                    ConnectError::CollectionOpen(
                        "Local authority transfer state is corrupt.".to_string(),
                    )
                })?;
            Ok(AuthorityRole::Transferring(transfer_id))
        }
        _ => Err(ConnectError::CollectionOpen(
            "Local authority role is invalid.".to_string(),
        )),
    }
}

pub(super) fn collection_state(
    connection: &Connection,
    collection_id: Uuid,
) -> Result<Option<CollectionState>, ConnectError> {
    connection
        .query_row(
            "SELECT head, retained_after
             FROM local_sync_collections WHERE collection_id = ?1",
            [collection_id.to_string()],
            |row| {
                Ok(CollectionState {
                    head: row.get(0)?,
                    retained_after: row.get(1)?,
                })
            },
        )
        .optional()
        .map_err(Into::into)
}

pub(super) fn required_collection_state(
    connection: &Connection,
    collection_id: Uuid,
) -> Result<CollectionState, ConnectError> {
    collection_state(connection, collection_id)?.ok_or_else(|| {
        ConnectError::CollectionOpen("Local sync authority is not initialized.".to_string())
    })
}

pub(super) fn upsert_replica(
    transaction: &Transaction<'_>,
    collection_id: Uuid,
    replica: &LocalReplica,
) -> Result<ReplicaState, ConnectError> {
    let mode = replica_mode(replica.mode);
    let allowed_types = serde_json::to_string(&replica.allowed_types)?;
    transaction.execute(
        "INSERT INTO local_sync_replicas
           (id, collection_id, name, mode, allowed_types)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET
           scope_epoch = scope_epoch + CASE
             WHEN mode <> excluded.mode OR allowed_types <> excluded.allowed_types
             THEN 1 ELSE 0 END,
           name = excluded.name,
           mode = excluded.mode,
           allowed_types = excluded.allowed_types,
           revoked = 0
         WHERE collection_id = excluded.collection_id",
        params![
            replica.id.to_string(),
            collection_id.to_string(),
            replica.name,
            mode,
            allowed_types,
        ],
    )?;
    required_replica(transaction, collection_id, replica.id)
}

pub(super) fn required_replica(
    connection: &Connection,
    collection_id: Uuid,
    replica_id: Uuid,
) -> Result<ReplicaState, ConnectError> {
    let row = connection
        .query_row(
            "SELECT mode, allowed_types, scope_epoch, revoked
             FROM local_sync_replicas WHERE id = ?1 AND collection_id = ?2",
            params![replica_id.to_string(), collection_id.to_string()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, u64>(2)?,
                    row.get::<_, bool>(3)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| ConnectError::AccessDenied("Replica was not found.".to_string()))?;
    if row.3 {
        return Err(ConnectError::AccessDenied(
            "Replica access was revoked.".to_string(),
        ));
    }
    Ok(ReplicaState {
        id: replica_id,
        mode: parse_replica_mode(&row.0)?,
        allowed_types: serde_json::from_str(&row.1)?,
        scope_epoch: row.2,
    })
}

pub(super) fn records(
    connection: &Connection,
    collection_id: Uuid,
) -> Result<BTreeMap<Uuid, SyncRecord>, ConnectError> {
    let mut statement = connection.prepare(
        "SELECT record_id, record FROM local_sync_records
         WHERE collection_id = ?1 ORDER BY record_id",
    )?;
    let rows = statement.query_map([collection_id.to_string()], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    rows.map(|row| {
        let (record_id, record) = row?;
        let record_id = Uuid::parse_str(&record_id).map_err(|error| {
            ConnectError::CollectionOpen(format!("invalid local sync record ID: {error}"))
        })?;
        Ok((record_id, serde_json::from_str(&record)?))
    })
    .collect()
}

pub(super) fn record(
    connection: &Connection,
    collection_id: Uuid,
    record_id: Uuid,
) -> Result<Option<SyncRecord>, ConnectError> {
    connection
        .query_row(
            "SELECT record FROM local_sync_records
             WHERE collection_id = ?1 AND record_id = ?2",
            params![collection_id.to_string(), record_id.to_string()],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .map(|record| serde_json::from_str(&record).map_err(Into::into))
        .transpose()
}

pub(super) fn persist_record(
    transaction: &Transaction<'_>,
    collection_id: Uuid,
    record_id: Uuid,
    mut record: SyncRecord,
) -> Result<(), ConnectError> {
    record.record_id = record_id;
    transaction.execute(
        "INSERT INTO local_sync_records
           (collection_id, record_id, path, revision, record)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            collection_id.to_string(),
            record_id.to_string(),
            record.path,
            record.revision,
            serde_json::to_string(&record)?,
        ],
    )?;
    Ok(())
}

pub(super) fn assign_initial_record_ids(
    transaction: &Transaction<'_>,
    collection_id: Uuid,
) -> Result<(), ConnectError> {
    // persist_record already replaces the sentinel before serialization. This
    // assertion query documents and verifies that invariant during migration.
    let invalid: u64 = transaction.query_row(
        "SELECT count(*) FROM local_sync_records
         WHERE collection_id = ?1 AND record_id = ?2",
        params![collection_id.to_string(), Uuid::nil().to_string()],
        |row| row.get(0),
    )?;
    if invalid != 0 {
        return Err(ConnectError::CollectionOpen(
            "Local sync record identity initialization failed.".to_string(),
        ));
    }
    Ok(())
}

pub(super) fn snapshot_record(
    record: &mdbase::runtime::CollectionSnapshotRecord,
    record_id: Uuid,
) -> SyncRecord {
    SyncRecord {
        record_id,
        path: record.path.clone(),
        revision: record.revision.clone(),
        frontmatter: record.frontmatter.clone(),
        body: record.body.clone(),
        types: record.types.clone(),
    }
}

pub(super) fn visible(record: &SyncRecord, allowed_types: &BTreeSet<String>) -> bool {
    allowed_types.is_empty()
        || record
            .types
            .iter()
            .any(|type_name| allowed_types.contains(&type_name.to_lowercase()))
}

pub(super) fn change_sequence(change: &SyncChange) -> u64 {
    match change {
        SyncChange::Put { sequence, .. } | SyncChange::Remove { sequence, .. } => *sequence,
    }
}

pub(super) fn replica_mode(mode: SyncReplicaMode) -> &'static str {
    match mode {
        SyncReplicaMode::ReadOnly => "read_only",
        SyncReplicaMode::ReadWrite => "read_write",
    }
}

pub(super) fn parse_replica_mode(value: &str) -> Result<SyncReplicaMode, ConnectError> {
    match value {
        "read_only" => Ok(SyncReplicaMode::ReadOnly),
        "read_write" => Ok(SyncReplicaMode::ReadWrite),
        _ => Err(ConnectError::CollectionOpen(
            "Local sync replica mode is invalid.".to_string(),
        )),
    }
}

pub(super) fn required_input_string<'a>(
    input: &'a serde_json::Map<String, Value>,
    key: &str,
) -> Result<&'a str, ConnectError> {
    input.get(key).and_then(Value::as_str).ok_or_else(|| {
        ConnectError::AccessDenied(format!("Sync mutation requires string input '{key}'."))
    })
}

pub(super) fn conflict(
    mutation: &SyncMutation,
    current: Option<SyncRecord>,
) -> SyncMutationReceipt {
    SyncMutationReceipt::Conflicted {
        mutation_id: mutation.mutation_id,
        conflict: SyncConflict {
            record_id: mutation.record_id,
            mutation: mutation.clone(),
            current_revision: current.as_ref().map(|record| record.revision.clone()),
            current,
        },
    }
}

pub(super) fn receipt_mutation_id(receipt: &SyncMutationReceipt) -> Uuid {
    match receipt {
        SyncMutationReceipt::Applied { mutation_id, .. }
        | SyncMutationReceipt::PreviouslyApplied { mutation_id, .. }
        | SyncMutationReceipt::Conflicted { mutation_id, .. }
        | SyncMutationReceipt::Rejected { mutation_id, .. } => *mutation_id,
    }
}

pub(super) fn previously_applied(receipt: SyncMutationReceipt) -> SyncMutationReceipt {
    match receipt {
        SyncMutationReceipt::Applied {
            mutation_id,
            sequence,
            record,
        }
        | SyncMutationReceipt::PreviouslyApplied {
            mutation_id,
            sequence,
            record,
        } => SyncMutationReceipt::PreviouslyApplied {
            mutation_id,
            sequence,
            record,
        },
        other => other,
    }
}
