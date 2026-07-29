use crate::{CollectionRegistry, ConnectError};
use mdbase::runtime::CollectionSnapshot;
use mdbase_connect_protocol::{
    authority_manifest_digest, AuthoritySnapshot, AuthoritySnapshotRecord, SyncChange,
    SyncChangesPage, SyncCollectionResources, SyncConflict, SyncMutation, SyncMutationOperation,
    SyncMutationReceipt, SyncRecord, SyncReplicaMode, SyncSession, SyncSnapshotPage,
    SyncSnapshotRecord, CONTROL_PROTOCOL_VERSION,
};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use uuid::Uuid;

const SNAPSHOT_PAGE_SIZE: usize = 200;
const RETAINED_CHANGES: u64 = 10_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalReplica {
    pub id: Uuid,
    pub name: String,
    pub mode: SyncReplicaMode,
    /// Empty means full collection access.
    pub allowed_types: BTreeSet<String>,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct CollectionState {
    pub(crate) head: u64,
    pub(crate) retained_after: u64,
}

#[derive(Debug, Clone)]
struct ReplicaState {
    id: Uuid,
    mode: SyncReplicaMode,
    allowed_types: BTreeSet<String>,
    scope_epoch: u64,
}

#[derive(Debug)]
pub(crate) enum MutationPlan {
    Return(Box<SyncMutationReceipt>),
    Apply {
        operation: &'static str,
        input: Value,
        preferred_path: Option<String>,
    },
}

/// Durable provider-neutral sync metadata for filesystem authorities.
///
/// Canonical Markdown remains in the collection directory. SQLite retains only
/// stable IDs, ordered change records, short-lived snapshots, replica scope,
/// and idempotency receipts.
#[derive(Debug, Clone)]
pub struct LocalSyncStore {
    db_path: std::path::PathBuf,
}

impl LocalSyncStore {
    pub(crate) fn for_registry(registry: &CollectionRegistry) -> Self {
        Self {
            db_path: registry.db_path().to_path_buf(),
        }
    }

    fn connection(&self) -> Result<Connection, ConnectError> {
        let connection = Connection::open(&self.db_path)?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        Ok(connection)
    }

    fn authority_role(&self, collection_id: Uuid) -> Result<AuthorityRole, ConnectError> {
        authority_role(&self.connection()?, collection_id)
    }

    pub(crate) fn ensure_replica(
        &self,
        collection_id: Uuid,
        replica: &LocalReplica,
    ) -> Result<(), ConnectError> {
        let mut connection = self.connection()?;
        let transaction =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        upsert_replica(&transaction, collection_id, replica)?;
        transaction.commit()?;
        Ok(())
    }

    pub(crate) fn assert_authority_available(
        &self,
        collection_id: Uuid,
    ) -> Result<(), ConnectError> {
        match self.authority_role(collection_id)? {
            AuthorityRole::Active | AuthorityRole::Transferring(_) => Ok(()),
            AuthorityRole::Retired => Err(ConnectError::AuthorityRetired),
        }
    }

    pub(crate) fn assert_mutation_allowed(&self, collection_id: Uuid) -> Result<(), ConnectError> {
        match self.authority_role(collection_id)? {
            AuthorityRole::Active => Ok(()),
            AuthorityRole::Transferring(transfer_id) => {
                Err(ConnectError::AuthorityTransferInProgress { transfer_id })
            }
            AuthorityRole::Retired => Err(ConnectError::AuthorityRetired),
        }
    }

    pub(crate) fn assert_not_transferring(&self, collection_id: Uuid) -> Result<(), ConnectError> {
        match self.authority_role(collection_id)? {
            AuthorityRole::Active | AuthorityRole::Retired => Ok(()),
            AuthorityRole::Transferring(transfer_id) => {
                Err(ConnectError::AuthorityTransferInProgress { transfer_id })
            }
        }
    }

    pub(crate) fn is_retired(&self, collection_id: Uuid) -> Result<bool, ConnectError> {
        Ok(matches!(
            self.authority_role(collection_id)?,
            AuthorityRole::Retired
        ))
    }

    pub(crate) fn fence(&self, collection_id: Uuid, transfer_id: Uuid) -> Result<(), ConnectError> {
        let connection = self.connection()?;
        let role = authority_role(&connection, collection_id)?;
        match role {
            AuthorityRole::Active => {
                let changed = connection.execute(
                    "UPDATE local_sync_collections
                     SET authority_state = 'transferring', transfer_id = ?2
                     WHERE collection_id = ?1 AND authority_state = 'active'",
                    params![collection_id.to_string(), transfer_id.to_string()],
                )?;
                if changed != 1 {
                    return Err(ConnectError::AuthorityTransferMismatch);
                }
                Ok(())
            }
            AuthorityRole::Transferring(existing) if existing == transfer_id => Ok(()),
            AuthorityRole::Transferring(_) => Err(ConnectError::AuthorityTransferMismatch),
            AuthorityRole::Retired => Err(ConnectError::AuthorityRetired),
        }
    }

    pub(crate) fn resume(
        &self,
        collection_id: Uuid,
        transfer_id: Uuid,
    ) -> Result<(), ConnectError> {
        let connection = self.connection()?;
        match authority_role(&connection, collection_id)? {
            AuthorityRole::Active => Ok(()),
            AuthorityRole::Transferring(existing) if existing == transfer_id => {
                connection.execute(
                    "UPDATE local_sync_collections
                     SET authority_state = 'active', transfer_id = NULL
                     WHERE collection_id = ?1 AND transfer_id = ?2",
                    params![collection_id.to_string(), transfer_id.to_string()],
                )?;
                Ok(())
            }
            AuthorityRole::Transferring(_) => Err(ConnectError::AuthorityTransferMismatch),
            AuthorityRole::Retired => Err(ConnectError::AuthorityRetired),
        }
    }

    pub(crate) fn retire(
        &self,
        collection_id: Uuid,
        transfer_id: Uuid,
        authority_epoch: u64,
    ) -> Result<(), ConnectError> {
        let connection = self.connection()?;
        match authority_role(&connection, collection_id)? {
            AuthorityRole::Retired => Ok(()),
            AuthorityRole::Transferring(existing) if existing == transfer_id => {
                let changed = connection.execute(
                    "UPDATE local_sync_collections
                     SET authority_state = 'retired', authority_epoch = ?3
                     WHERE collection_id = ?1 AND transfer_id = ?2",
                    params![
                        collection_id.to_string(),
                        transfer_id.to_string(),
                        authority_epoch,
                    ],
                )?;
                if changed != 1 {
                    return Err(ConnectError::AuthorityTransferMismatch);
                }
                Ok(())
            }
            AuthorityRole::Active | AuthorityRole::Transferring(_) => {
                Err(ConnectError::AuthorityTransferMismatch)
            }
        }
    }

    pub(crate) fn export_snapshot(
        &self,
        collection_id: Uuid,
        snapshot: &CollectionSnapshot,
        resources: SyncCollectionResources,
    ) -> Result<AuthoritySnapshot, ConnectError> {
        let connection = self.connection()?;
        let state = required_collection_state(&connection, collection_id)?;
        let records_by_path = records(&connection, collection_id)?
            .into_values()
            .map(|record| (record.path.clone(), record))
            .collect::<BTreeMap<_, _>>();
        let records = snapshot
            .records
            .iter()
            .map(|source| {
                let record = records_by_path.get(&source.path).cloned().ok_or_else(|| {
                    ConnectError::CollectionOpen(format!(
                        "Local sync identity is missing for {}.",
                        source.path
                    ))
                })?;
                Ok(AuthoritySnapshotRecord {
                    record,
                    document: source.document.clone(),
                })
            })
            .collect::<Result<Vec<_>, ConnectError>>()?;
        let manifest_digest = authority_manifest_digest(&resources.documents, &records);
        Ok(AuthoritySnapshot {
            protocol_version: CONTROL_PROTOCOL_VERSION,
            collection_id,
            source_head: state.head,
            source_revision: snapshot.revision.clone(),
            manifest_digest,
            resources,
            records,
        })
    }

    pub(crate) fn reconcile(
        &self,
        collection_id: Uuid,
        snapshot: &CollectionSnapshot,
        preferred_ids: &HashMap<String, Uuid>,
    ) -> Result<CollectionState, ConnectError> {
        let mut connection = self.connection()?;
        let transaction =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let existing = collection_state(&transaction, collection_id)?;
        let mut state = existing.unwrap_or(CollectionState {
            head: 0,
            retained_after: 0,
        });
        if existing.is_none() {
            transaction.execute(
                "INSERT INTO local_sync_collections
                   (collection_id, head, retained_after, resource_revision, authority_epoch)
                 VALUES (?1, 0, 0, ?2, 1)",
                params![collection_id.to_string(), snapshot.resource_revision],
            )?;
            for record in &snapshot.records {
                persist_record(
                    &transaction,
                    collection_id,
                    preferred_ids
                        .get(&record.path)
                        .copied()
                        .unwrap_or_else(Uuid::new_v4),
                    snapshot_record(record, Uuid::nil()),
                )?;
            }
            // Replace the sentinel IDs written by snapshot_record.
            assign_initial_record_ids(&transaction, collection_id)?;
            transaction.commit()?;
            return Ok(state);
        }

        let previous_resource_revision: String = transaction.query_row(
            "SELECT resource_revision FROM local_sync_collections WHERE collection_id = ?1",
            [collection_id.to_string()],
            |row| row.get(0),
        )?;
        if previous_resource_revision != snapshot.resource_revision {
            transaction.execute(
                "UPDATE local_sync_replicas
                 SET scope_epoch = scope_epoch + 1
                 WHERE collection_id = ?1 AND revoked = 0",
                [collection_id.to_string()],
            )?;
            transaction.execute(
                "DELETE FROM local_sync_snapshots WHERE collection_id = ?1",
                [collection_id.to_string()],
            )?;
        }

        let previous = records(&transaction, collection_id)?;
        let mut previous_by_path = previous
            .values()
            .map(|record| (record.path.clone(), record.record_id))
            .collect::<BTreeMap<_, _>>();
        let current_by_path = snapshot
            .records
            .iter()
            .map(|record| (record.path.clone(), record))
            .collect::<BTreeMap<_, _>>();
        let mut assignments = BTreeMap::<String, Uuid>::new();

        for path in current_by_path.keys() {
            if let Some(preferred) = preferred_ids.get(path) {
                assignments.insert(path.clone(), *preferred);
                continue;
            }
            if let Some(record_id) = previous_by_path.remove(path) {
                assignments.insert(path.clone(), record_id);
            }
        }

        // A filesystem rename keeps identity when one deleted and one created
        // path share the same opaque content revision.
        let unassigned = current_by_path
            .iter()
            .filter(|(path, _)| !assignments.contains_key(*path))
            .map(|(path, record)| (path.clone(), record.revision.clone()))
            .collect::<Vec<_>>();
        for (path, revision) in unassigned {
            let matches = previous_by_path
                .iter()
                .filter(|(_, record_id)| {
                    previous
                        .get(record_id)
                        .is_some_and(|record| record.revision == revision)
                })
                .map(|(path, record_id)| (path.clone(), *record_id))
                .collect::<Vec<_>>();
            let matching_current = current_by_path
                .iter()
                .filter(|(candidate, record)| {
                    !assignments.contains_key(*candidate) && record.revision == revision
                })
                .count();
            if matches.len() == 1 && matching_current == 1 {
                let (old_path, record_id) = &matches[0];
                assignments.insert(path, *record_id);
                previous_by_path.remove(old_path);
            }
        }
        for path in current_by_path.keys() {
            assignments.entry(path.clone()).or_insert_with(Uuid::new_v4);
        }

        let mut after_by_id = BTreeMap::new();
        for (path, snapshot_record_value) in &current_by_path {
            let record_id = assignments[path];
            after_by_id.insert(record_id, snapshot_record(snapshot_record_value, record_id));
        }

        let ids = previous
            .keys()
            .chain(after_by_id.keys())
            .copied()
            .collect::<BTreeSet<_>>();
        for record_id in ids {
            let before = previous.get(&record_id);
            let after = after_by_id.get(&record_id);
            if before == after {
                continue;
            }
            state.head = state
                .head
                .checked_add(1)
                .ok_or_else(|| ConnectError::CollectionOpen("sync sequence exhausted".into()))?;
            let revision = after
                .map(|record| record.revision.clone())
                .unwrap_or_else(|| format!("local:{}:{record_id}:tombstone", state.head));
            transaction.execute(
                "INSERT INTO local_sync_changes
                   (collection_id, sequence, record_id, before_record, after_record, revision)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    collection_id.to_string(),
                    state.head,
                    record_id.to_string(),
                    before.map(serde_json::to_string).transpose()?,
                    after.map(serde_json::to_string).transpose()?,
                    revision,
                ],
            )?;
        }
        transaction.execute(
            "DELETE FROM local_sync_records WHERE collection_id = ?1",
            [collection_id.to_string()],
        )?;
        for (record_id, record) in after_by_id {
            persist_record(&transaction, collection_id, record_id, record)?;
        }
        let retained_after = state.head.saturating_sub(RETAINED_CHANGES);
        if retained_after > state.retained_after {
            transaction.execute(
                "DELETE FROM local_sync_changes
                 WHERE collection_id = ?1 AND sequence <= ?2",
                params![collection_id.to_string(), retained_after],
            )?;
            state.retained_after = retained_after;
        }
        transaction.execute(
            "UPDATE local_sync_collections
             SET head = ?2, retained_after = ?3, resource_revision = ?4
             WHERE collection_id = ?1",
            params![
                collection_id.to_string(),
                state.head,
                state.retained_after,
                snapshot.resource_revision,
            ],
        )?;
        transaction.commit()?;
        Ok(state)
    }

    pub(crate) fn open_session(
        &self,
        collection_id: Uuid,
        replica: &LocalReplica,
        resources: SyncCollectionResources,
        collection_snapshot: &CollectionSnapshot,
    ) -> Result<SyncSession, ConnectError> {
        let mut connection = self.connection()?;
        let transaction =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let replica = upsert_replica(&transaction, collection_id, replica)?;
        let state = required_collection_state(&transaction, collection_id)?;
        let documents = collection_snapshot
            .records
            .iter()
            .map(|record| (record.path.as_str(), record.document.as_str()))
            .collect::<HashMap<_, _>>();
        let records = records(&transaction, collection_id)?
            .into_values()
            .filter(|record| visible(record, &replica.allowed_types))
            .map(|record| {
                let document = documents.get(record.path.as_str()).ok_or_else(|| {
                    ConnectError::CollectionOpen(format!(
                        "Local sync snapshot is missing exact Markdown for {}.",
                        record.path
                    ))
                })?;
                Ok(SyncSnapshotRecord {
                    record,
                    document: (*document).to_string(),
                })
            })
            .collect::<Result<Vec<_>, ConnectError>>()?;
        let snapshot_id = Uuid::new_v4();
        transaction.execute(
            "DELETE FROM local_sync_snapshots WHERE expires_at <= CURRENT_TIMESTAMP",
            [],
        )?;
        transaction.execute(
            "INSERT INTO local_sync_snapshots
               (id, collection_id, replica_id, scope_epoch, cursor, records, expires_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now', '+10 minutes'))",
            params![
                snapshot_id.to_string(),
                collection_id.to_string(),
                replica.id.to_string(),
                replica.scope_epoch,
                state.head,
                serde_json::to_string(&records)?,
            ],
        )?;
        transaction.execute(
            "UPDATE local_sync_replicas SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?1",
            [replica.id.to_string()],
        )?;
        transaction.commit()?;
        Ok(SyncSession {
            protocol_version: CONTROL_PROTOCOL_VERSION,
            session_id: Uuid::new_v4(),
            replica_id: replica.id,
            collection_id,
            mode: replica.mode,
            scope_epoch: replica.scope_epoch,
            retained_after: state.retained_after,
            head: state.head,
            snapshot_id,
            resources,
        })
    }

    pub(crate) fn snapshot(
        &self,
        collection_id: Uuid,
        replica_id: Uuid,
        snapshot_id: Uuid,
        page: Option<&str>,
    ) -> Result<SyncSnapshotPage, ConnectError> {
        let offset = page
            .map(|value| {
                value.parse::<usize>().map_err(|_| {
                    ConnectError::AccessDenied("Invalid snapshot page token.".to_string())
                })
            })
            .transpose()?
            .unwrap_or_default();
        let connection = self.connection()?;
        let row = connection
            .query_row(
                "SELECT scope_epoch, cursor, records
                 FROM local_sync_snapshots
                 WHERE id = ?1 AND collection_id = ?2 AND replica_id = ?3
                   AND expires_at > CURRENT_TIMESTAMP",
                params![
                    snapshot_id.to_string(),
                    collection_id.to_string(),
                    replica_id.to_string(),
                ],
                |row| {
                    Ok((
                        row.get::<_, u64>(0)?,
                        row.get::<_, u64>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()?
            .ok_or_else(|| {
                ConnectError::AccessDenied(
                    "Snapshot expired or belongs to another replica.".to_string(),
                )
            })?;
        let records = serde_json::from_str::<Vec<SyncSnapshotRecord>>(&row.2)?;
        if offset > records.len() {
            return Err(ConnectError::AccessDenied(
                "Snapshot page is outside the result set.".to_string(),
            ));
        }
        let end = offset.saturating_add(SNAPSHOT_PAGE_SIZE).min(records.len());
        Ok(SyncSnapshotPage {
            protocol_version: CONTROL_PROTOCOL_VERSION,
            snapshot_id,
            scope_epoch: row.0,
            cursor: row.1,
            records: records[offset..end].to_vec(),
            next_page: (end < records.len()).then(|| end.to_string()),
        })
    }

    pub(crate) fn changes(
        &self,
        collection_id: Uuid,
        replica_id: Uuid,
        after: u64,
        limit: usize,
    ) -> Result<SyncChangesPage, ConnectError> {
        let mut connection = self.connection()?;
        let transaction =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let replica = required_replica(&transaction, collection_id, replica_id)?;
        let state = required_collection_state(&transaction, collection_id)?;
        if after < state.retained_after {
            transaction.commit()?;
            return Ok(SyncChangesPage {
                protocol_version: CONTROL_PROTOCOL_VERSION,
                scope_epoch: replica.scope_epoch,
                events: Vec::new(),
                cursor: state.head,
                head: state.head,
                has_more: false,
                reset_required: true,
            });
        }
        let mut statement = transaction.prepare(
            "SELECT sequence, record_id, before_record, after_record, revision
             FROM local_sync_changes
             WHERE collection_id = ?1 AND sequence > ?2
             ORDER BY sequence",
        )?;
        let rows = statement.query_map(params![collection_id.to_string(), after], |row| {
            Ok((
                row.get::<_, u64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, String>(4)?,
            ))
        })?;
        let mut events = Vec::new();
        for row in rows {
            let (sequence, record_id, before, after_record, revision) = row?;
            let before = before
                .as_deref()
                .map(serde_json::from_str::<SyncRecord>)
                .transpose()?;
            let after_record = after_record
                .as_deref()
                .map(serde_json::from_str::<SyncRecord>)
                .transpose()?;
            let before_visible = before
                .as_ref()
                .is_some_and(|record| visible(record, &replica.allowed_types));
            let after_visible = after_record
                .as_ref()
                .is_some_and(|record| visible(record, &replica.allowed_types));
            if after_visible {
                events.push(SyncChange::Put {
                    sequence,
                    record: after_record.expect("visible record exists"),
                });
            } else if before_visible {
                let before = before.expect("visible record exists");
                events.push(SyncChange::Remove {
                    sequence,
                    record_id: Uuid::parse_str(&record_id).map_err(|error| {
                        ConnectError::CollectionOpen(format!(
                            "invalid local sync record ID: {error}"
                        ))
                    })?,
                    previous_path: before.path,
                    revision,
                });
            }
        }
        drop(statement);
        let has_more = events.len() > limit;
        events.truncate(limit);
        let cursor = if has_more {
            events.last().map(change_sequence).unwrap_or(after)
        } else {
            state.head
        };
        transaction.execute(
            "UPDATE local_sync_replicas
             SET acknowledged_sequence = MAX(acknowledged_sequence, ?2),
                 last_seen_at = CURRENT_TIMESTAMP
             WHERE id = ?1",
            params![replica_id.to_string(), cursor],
        )?;
        transaction.commit()?;
        Ok(SyncChangesPage {
            protocol_version: CONTROL_PROTOCOL_VERSION,
            scope_epoch: replica.scope_epoch,
            events,
            cursor,
            head: state.head,
            has_more,
            reset_required: false,
        })
    }

    pub(crate) fn plan_mutation(
        &self,
        collection_id: Uuid,
        replica_id: Uuid,
        mutation: &SyncMutation,
    ) -> Result<MutationPlan, ConnectError> {
        let connection = self.connection()?;
        if let Some(receipt) = connection
            .query_row(
                "SELECT receipt FROM local_sync_receipts
                 WHERE replica_id = ?1 AND mutation_id = ?2",
                params![replica_id.to_string(), mutation.mutation_id.to_string()],
                |row| row.get::<_, String>(0),
            )
            .optional()?
        {
            return Ok(MutationPlan::Return(Box::new(previously_applied(
                serde_json::from_str(&receipt)?,
            ))));
        }
        let replica = required_replica(&connection, collection_id, replica_id)?;
        let reject = |code: &str, message: &str| {
            MutationPlan::Return(Box::new(SyncMutationReceipt::Rejected {
                mutation_id: mutation.mutation_id,
                error: mdbase_connect_protocol::SyncMutationError {
                    code: code.to_string(),
                    message: message.to_string(),
                },
            }))
        };
        if replica.mode != SyncReplicaMode::ReadWrite {
            return Ok(reject(
                "read_only_replica",
                "This replica cannot submit mutations.",
            ));
        }
        if mutation.replica_id != replica_id || mutation.scope_epoch != replica.scope_epoch {
            return Ok(reject(
                "scope_epoch_changed",
                "Replica scope changed; rebuild before uploading mutations.",
            ));
        }
        if let Some(predecessor) = mutation.causal_predecessor {
            let applied = connection
                .query_row(
                    "SELECT receipt FROM local_sync_receipts
                     WHERE replica_id = ?1 AND mutation_id = ?2",
                    params![replica_id.to_string(), predecessor.to_string()],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
                .and_then(|receipt| serde_json::from_str::<SyncMutationReceipt>(&receipt).ok())
                .is_some_and(|receipt| {
                    matches!(
                        receipt,
                        SyncMutationReceipt::Applied { .. }
                            | SyncMutationReceipt::PreviouslyApplied { .. }
                    )
                });
            if !applied {
                return Ok(reject(
                    "causal_predecessor_not_applied",
                    "The mutation's causal predecessor did not apply.",
                ));
            }
        }
        let current = record(&connection, collection_id, mutation.record_id)?;
        if mutation.operation == SyncMutationOperation::Create {
            if current.is_some() {
                return Ok(MutationPlan::Return(Box::new(conflict(mutation, current))));
            }
            let path = required_input_string(&mutation.input, "path")?;
            let input = serde_json::json!({
                "path": path,
                "frontmatter": mutation.input.get("frontmatter").cloned().unwrap_or_else(|| serde_json::json!({})),
                "body": mutation.input.get("body").cloned().unwrap_or_else(|| Value::String(String::new())),
            });
            return Ok(MutationPlan::Apply {
                operation: "create",
                input,
                preferred_path: Some(path.to_string()),
            });
        }
        let Some(current) = current else {
            return Ok(MutationPlan::Return(Box::new(conflict(mutation, None))));
        };
        if !visible(&current, &replica.allowed_types) {
            return Ok(reject(
                "scope_denied",
                "The record is outside this replica's scope.",
            ));
        }
        if mutation.base_revision.as_deref() != Some(current.revision.as_str()) {
            return Ok(MutationPlan::Return(Box::new(conflict(
                mutation,
                Some(current),
            ))));
        }
        let (operation, input, preferred_path) = match mutation.operation {
            SyncMutationOperation::Update => (
                "update",
                serde_json::json!({
                    "path": current.path,
                    "patch": mutation.input.get("patch").cloned().unwrap_or_else(|| serde_json::json!({})),
                    "if_revision": current.revision,
                    "body": mutation.input.get("body").cloned(),
                }),
                Some(current.path),
            ),
            SyncMutationOperation::Rename => {
                let path = required_input_string(&mutation.input, "path")?.to_string();
                (
                    "rename",
                    serde_json::json!({
                        "from": current.path,
                        "to": path,
                        "if_revision": current.revision,
                        "update_refs": false,
                    }),
                    Some(path),
                )
            }
            SyncMutationOperation::Delete => (
                "delete",
                serde_json::json!({
                    "path": current.path,
                    "if_revision": current.revision,
                    "check_backlinks": false,
                }),
                None,
            ),
            SyncMutationOperation::Create => unreachable!(),
        };
        Ok(MutationPlan::Apply {
            operation,
            input,
            preferred_path,
        })
    }

    pub(crate) fn store_receipt(
        &self,
        replica_id: Uuid,
        receipt: &SyncMutationReceipt,
    ) -> Result<(), ConnectError> {
        self.connection()?.execute(
            "INSERT INTO local_sync_receipts (replica_id, mutation_id, receipt)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(replica_id, mutation_id) DO NOTHING",
            params![
                replica_id.to_string(),
                receipt_mutation_id(receipt).to_string(),
                serde_json::to_string(receipt)?,
            ],
        )?;
        Ok(())
    }

    pub(crate) fn applied_receipt(
        &self,
        collection_id: Uuid,
        mutation: &SyncMutation,
    ) -> Result<SyncMutationReceipt, ConnectError> {
        let connection = self.connection()?;
        let state = required_collection_state(&connection, collection_id)?;
        let record = record(&connection, collection_id, mutation.record_id)?;
        Ok(SyncMutationReceipt::Applied {
            mutation_id: mutation.mutation_id,
            sequence: state.head,
            record,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AuthorityRole {
    Active,
    Transferring(Uuid),
    Retired,
}

fn authority_role(
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

fn collection_state(
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

fn required_collection_state(
    connection: &Connection,
    collection_id: Uuid,
) -> Result<CollectionState, ConnectError> {
    collection_state(connection, collection_id)?.ok_or_else(|| {
        ConnectError::CollectionOpen("Local sync authority is not initialized.".to_string())
    })
}

fn upsert_replica(
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

fn required_replica(
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

fn records(
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

fn record(
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

fn persist_record(
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

fn assign_initial_record_ids(
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

fn snapshot_record(
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

fn visible(record: &SyncRecord, allowed_types: &BTreeSet<String>) -> bool {
    allowed_types.is_empty()
        || record
            .types
            .iter()
            .any(|type_name| allowed_types.contains(&type_name.to_lowercase()))
}

fn change_sequence(change: &SyncChange) -> u64 {
    match change {
        SyncChange::Put { sequence, .. } | SyncChange::Remove { sequence, .. } => *sequence,
    }
}

fn replica_mode(mode: SyncReplicaMode) -> &'static str {
    match mode {
        SyncReplicaMode::ReadOnly => "read_only",
        SyncReplicaMode::ReadWrite => "read_write",
    }
}

fn parse_replica_mode(value: &str) -> Result<SyncReplicaMode, ConnectError> {
    match value {
        "read_only" => Ok(SyncReplicaMode::ReadOnly),
        "read_write" => Ok(SyncReplicaMode::ReadWrite),
        _ => Err(ConnectError::CollectionOpen(
            "Local sync replica mode is invalid.".to_string(),
        )),
    }
}

fn required_input_string<'a>(
    input: &'a serde_json::Map<String, Value>,
    key: &str,
) -> Result<&'a str, ConnectError> {
    input.get(key).and_then(Value::as_str).ok_or_else(|| {
        ConnectError::AccessDenied(format!("Sync mutation requires string input '{key}'."))
    })
}

fn conflict(mutation: &SyncMutation, current: Option<SyncRecord>) -> SyncMutationReceipt {
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

fn receipt_mutation_id(receipt: &SyncMutationReceipt) -> Uuid {
    match receipt {
        SyncMutationReceipt::Applied { mutation_id, .. }
        | SyncMutationReceipt::PreviouslyApplied { mutation_id, .. }
        | SyncMutationReceipt::Conflicted { mutation_id, .. }
        | SyncMutationReceipt::Rejected { mutation_id, .. } => *mutation_id,
    }
}

fn previously_applied(receipt: SyncMutationReceipt) -> SyncMutationReceipt {
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

#[cfg(test)]
mod tests {
    use super::*;
    use mdbase::runtime::FilesystemProvider;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn reconciler_preserves_ids_across_renames_and_emits_tombstones() {
        let state = tempdir().unwrap();
        let collection_root = tempdir().unwrap();
        fs::write(
            collection_root.path().join("mdbase.yaml"),
            "spec_version: 0.3.0\n",
        )
        .unwrap();
        fs::write(
            collection_root.path().join("one.md"),
            "---\ntitle: One\n---\n",
        )
        .unwrap();
        let registry = CollectionRegistry::open(state.path()).unwrap();
        let collection = registry.add(collection_root.path()).unwrap();
        let store = LocalSyncStore::for_registry(&registry);
        let provider = FilesystemProvider::open(collection_root.path()).unwrap();
        store
            .reconcile(
                collection.id,
                &provider.snapshot().unwrap(),
                &HashMap::new(),
            )
            .unwrap();
        let before = records(&store.connection().unwrap(), collection.id)
            .unwrap()
            .into_values()
            .next()
            .unwrap();

        fs::rename(
            collection_root.path().join("one.md"),
            collection_root.path().join("renamed.md"),
        )
        .unwrap();
        let renamed_state = store
            .reconcile(
                collection.id,
                &provider.snapshot().unwrap(),
                &HashMap::new(),
            )
            .unwrap();
        let renamed = records(&store.connection().unwrap(), collection.id)
            .unwrap()
            .into_values()
            .next()
            .unwrap();
        assert_eq!(renamed.record_id, before.record_id);
        assert_eq!(renamed.path, "renamed.md");
        assert_eq!(renamed_state.head, 1);

        fs::remove_file(collection_root.path().join("renamed.md")).unwrap();
        let deleted = store
            .reconcile(
                collection.id,
                &provider.snapshot().unwrap(),
                &HashMap::new(),
            )
            .unwrap();
        assert_eq!(deleted.head, 2);
        assert!(records(&store.connection().unwrap(), collection.id)
            .unwrap()
            .is_empty());
    }
}
