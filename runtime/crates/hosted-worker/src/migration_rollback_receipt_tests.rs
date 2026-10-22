//! Real in-memory SQLite tests of metadata retention, NOT provider/native authority.
use super::*;
use mdbn_migrate_portable::hosted_import::{
    Action, Checkpoint, Driver, Outcome, Spill, SqlSpill, Step,
};
use mdbn_store_file::index::{
    IndexDurability, IndexError, IndexErrorKind, IndexInfo, OpenState, StmtResult,
};

struct Sqlite {
    db: rusqlite::Connection,
    fail_after_insert_commit: bool,
}
impl Sqlite {
    fn new() -> Self {
        Self {
            db: rusqlite::Connection::open_in_memory().unwrap(),
            fail_after_insert_commit: false,
        }
    }
}
fn to_sql(value: &SqlValue) -> rusqlite::types::Value {
    use rusqlite::types::Value;
    match value {
        SqlValue::Null => Value::Null,
        SqlValue::Integer(v) => Value::Integer(*v),
        SqlValue::Real(v) => Value::Real(*v),
        SqlValue::Text(v) => Value::Text(v.clone()),
        SqlValue::Blob(v) => Value::Blob(v.clone()),
    }
}
fn from_sql(value: rusqlite::types::ValueRef<'_>) -> SqlValue {
    use rusqlite::types::ValueRef;
    match value {
        ValueRef::Null => SqlValue::Null,
        ValueRef::Integer(v) => SqlValue::Integer(v),
        ValueRef::Real(v) => SqlValue::Real(v),
        ValueRef::Text(v) => SqlValue::Text(std::str::from_utf8(v).unwrap().to_owned()),
        ValueRef::Blob(v) => SqlValue::Blob(v.to_vec()),
    }
}
impl IndexStorage for Sqlite {
    fn info(&self) -> IndexInfo {
        // In-memory SQL is not a physical durability/DO output-gate qualification.
        IndexInfo {
            durability: IndexDurability::Disposable,
            opened: OpenState::Existing,
            sqlite_version: 0,
        }
    }
    fn run(&mut self, batch: &Batch) -> std::result::Result<Vec<StmtResult>, IndexError> {
        let err = |e: rusqlite::Error| IndexError::new(IndexErrorKind::Sql, e.to_string());
        let transaction = batch.mode == BatchMode::Transaction;
        if transaction {
            self.db.execute_batch("BEGIN IMMEDIATE").map_err(err)?;
        }
        let result = (|| {
            let mut results = Vec::new();
            for statement in &batch.stmts {
                let mut prepared = self.db.prepare(&statement.sql).map_err(err)?;
                let columns = u32::try_from(prepared.column_count()).unwrap();
                let params: Vec<_> = statement.params.iter().map(to_sql).collect();
                let mut rows = prepared
                    .query(rusqlite::params_from_iter(params))
                    .map_err(err)?;
                let mut values = Vec::new();
                while let Some(row) = rows.next().map_err(err)? {
                    for column in 0..columns {
                        values.push(from_sql(row.get_ref(column as usize).map_err(err)?));
                    }
                }
                results.push(StmtResult {
                    columns,
                    values,
                    changes: 0,
                    last_insert_rowid: 0,
                });
            }
            Ok(results)
        })();
        if transaction {
            self.db
                .execute_batch(if result.is_ok() { "COMMIT" } else { "ROLLBACK" })
                .map_err(err)?;
        }
        if self.fail_after_insert_commit
            && result.is_ok()
            && batch
                .stmts
                .iter()
                .any(|s| s.sql.starts_with("INSERT INTO mig_rollback_receipt_data"))
        {
            self.fail_after_insert_commit = false;
            return Err(IndexError::new(
                IndexErrorKind::Other,
                "synthetic lost commit acknowledgement",
            ));
        }
        result
    }
    fn reset(&mut self) -> std::result::Result<(), IndexError> {
        // Simulate the DO host's st_* cache reset, not deletion of its mig_* state.
        self.db
            .execute_batch("DROP TABLE IF EXISTS st_synthetic_cache")
            .map_err(|_| IndexError::new(IndexErrorKind::Sql, "synthetic cache reset"))
    }
}
fn id(value: u64) -> Uuid {
    let mut bytes = [0; 16];
    bytes[8..].copy_from_slice(&value.to_be_bytes());
    B16(bytes)
}
fn fixture() -> OriginalRollbackReceiptData {
    OriginalRollbackReceiptData {
        key: ReceiptDataKey {
            collection_id: id(1),
            provider_migration_id: id(2),
            driver_id: id(3),
        },
        owner_account_id: id(4),
        authority_epoch: 5,
        fixed_head: 54,
        action_id: id(6),
        replica_ids: vec![id(11), id(12)],
        restored_ids: vec![id(11)],
        recorded_at: "2026-10-10T17:40:00.123456+00:00".into(),
    }
}

#[test]
fn exact_original_replay_is_immutable_and_never_renews_timestamp() {
    let mut index = Sqlite::new();
    let data = fixture();
    let mut store = RollbackReceiptDataStore::open(&mut index).unwrap();
    assert_eq!(store.load_original_data(data.key).unwrap(), None);
    store.record_original_data(&data).unwrap();
    store.record_original_data(&data).unwrap();
    assert_eq!(
        store.load_original_data(data.key).unwrap(),
        Some(data.clone())
    );
    for changed in [
        OriginalRollbackReceiptData {
            action_id: id(7),
            ..data.clone()
        },
        OriginalRollbackReceiptData {
            recorded_at: "2026-10-10T17:41:00Z".into(),
            ..data.clone()
        },
        OriginalRollbackReceiptData {
            owner_account_id: id(8),
            ..data.clone()
        },
        OriginalRollbackReceiptData {
            authority_epoch: 6,
            ..data.clone()
        },
        OriginalRollbackReceiptData {
            fixed_head: 55,
            ..data.clone()
        },
        OriginalRollbackReceiptData {
            restored_ids: vec![id(11), id(12)],
            ..data.clone()
        },
        OriginalRollbackReceiptData {
            replica_ids: vec![id(11), id(12), id(13)],
            ..data.clone()
        },
    ] {
        assert_eq!(
            store.record_original_data(&changed),
            Err(ReceiptDataError::Conflict)
        );
    }
    assert_eq!(store.load_original_data(data.key).unwrap(), Some(data));
}

#[test]
fn original_binding_survives_driver_id_clearing_unfence_terminal_and_cache_reset() {
    let data = fixture();
    let mut spill = SqlSpill::open(Sqlite::new()).unwrap();
    let mut checkpoint = Checkpoint::new(&data.key.collection_id.to_uuid_string());
    checkpoint.fence_first = true;
    checkpoint.step = Step::RollingBack;
    checkpoint.fenced = true;
    checkpoint.s_final = Some(data.fixed_head);
    checkpoint.revoked = data
        .replica_ids
        .iter()
        .map(|id| id.to_uuid_string())
        .collect();
    spill.save(&checkpoint.to_bytes().unwrap()).unwrap();
    let mut driver = Driver::resume_mode(&mut spill, &checkpoint.collection, true).unwrap();
    assert!(matches!(
        driver.poll(&mut spill).unwrap(),
        Action::Unrevoke { .. }
    ));
    // Production MUST independently qualify provider/pending/currentness and the
    // host commit before completion. These calls simulate metadata progression only.
    let mut index = spill.into_inner();
    RollbackReceiptDataStore::open(&mut index)
        .unwrap()
        .record_original_data(&data)
        .unwrap();
    let mut spill = SqlSpill::open(index).unwrap();
    driver.complete(&mut spill, Outcome::Ok).unwrap();
    assert!(driver.checkpoint().revoked.is_empty());
    assert_eq!(driver.poll(&mut spill).unwrap(), Action::Unfence);
    let later_unfence_action = id(7);
    assert_ne!(later_unfence_action, data.action_id);
    driver.complete(&mut spill, Outcome::Ok).unwrap();
    assert_eq!(
        driver.poll(&mut spill).unwrap(),
        Action::Done(Step::RolledBack)
    );
    let mut index = spill.into_inner();
    index
        .db
        .execute_batch("CREATE TABLE st_synthetic_cache(k INTEGER)")
        .unwrap();
    index.reset().unwrap();
    assert_eq!(
        RollbackReceiptDataStore::open(&mut index)
            .unwrap()
            .load_original_data(data.key)
            .unwrap(),
        Some(data.clone())
    );
    let mut spill = SqlSpill::open(index).unwrap();
    let reopened = Driver::resume_mode(&mut spill, &checkpoint.collection, true).unwrap();
    assert_eq!(reopened.status_step(), Step::RolledBack);
    assert!(reopened.checkpoint().revoked.is_empty());
}

#[test]
fn nil_noncanonical_partial_and_over_budget_data_refuse_before_insert() {
    let mut index = Sqlite::new();
    let data = fixture();
    let mut invalid = vec![
        OriginalRollbackReceiptData {
            key: ReceiptDataKey {
                collection_id: id(0),
                ..data.key
            },
            ..data.clone()
        },
        OriginalRollbackReceiptData {
            key: ReceiptDataKey {
                provider_migration_id: id(0),
                ..data.key
            },
            ..data.clone()
        },
        OriginalRollbackReceiptData {
            key: ReceiptDataKey {
                driver_id: id(0),
                ..data.key
            },
            ..data.clone()
        },
        OriginalRollbackReceiptData {
            owner_account_id: id(0),
            ..data.clone()
        },
        OriginalRollbackReceiptData {
            action_id: id(0),
            ..data.clone()
        },
        OriginalRollbackReceiptData {
            authority_epoch: 0,
            ..data.clone()
        },
        OriginalRollbackReceiptData {
            authority_epoch: MAX_JSON_INTEGER + 1,
            ..data.clone()
        },
        OriginalRollbackReceiptData {
            fixed_head: MAX_JSON_INTEGER + 1,
            ..data.clone()
        },
        OriginalRollbackReceiptData {
            replica_ids: vec![id(12), id(11)],
            ..data.clone()
        },
        OriginalRollbackReceiptData {
            replica_ids: vec![id(11), id(11)],
            ..data.clone()
        },
        OriginalRollbackReceiptData {
            replica_ids: vec![id(0), id(11)],
            ..data.clone()
        },
        OriginalRollbackReceiptData {
            restored_ids: vec![id(13)],
            ..data.clone()
        },
        OriginalRollbackReceiptData {
            restored_ids: vec![id(11), id(11)],
            ..data.clone()
        },
        OriginalRollbackReceiptData {
            recorded_at: "record payload".into(),
            ..data.clone()
        },
        OriginalRollbackReceiptData {
            recorded_at: "2026-10-10T17:40:00Z\n".into(),
            ..data.clone()
        },
    ];
    invalid.push(OriginalRollbackReceiptData {
        replica_ids: (1..=1_001).map(id).collect(),
        restored_ids: vec![],
        ..data.clone()
    });
    let mut store = RollbackReceiptDataStore::open(&mut index).unwrap();
    for bad in invalid {
        assert_eq!(
            store.record_original_data(&bad),
            Err(ReceiptDataError::Invalid)
        );
    }
    assert_eq!(store.load_original_data(data.key).unwrap(), None);
}

#[test]
fn maximum_binary_scopes_fit_a_bounded_row_and_empty_scope_is_retained() {
    let mut index = Sqlite::new();
    let mut data = fixture();
    data.replica_ids = (1..=1_000).map(id).collect();
    data.restored_ids = data.replica_ids.clone();
    let mut store = RollbackReceiptDataStore::open(&mut index).unwrap();
    store.record_original_data(&data).unwrap();
    assert_eq!(
        store.load_original_data(data.key).unwrap(),
        Some(data.clone())
    );
    assert!(
        data.params()
            .iter()
            .map(|v| match v {
                SqlValue::Blob(b) => b.len(),
                SqlValue::Text(s) => s.len(),
                _ => 8,
            })
            .sum::<usize>()
            < 64 * 1024
    );
    data.key.provider_migration_id = id(20);
    data.replica_ids.clear();
    data.restored_ids.clear();
    store.record_original_data(&data).unwrap();
    assert_eq!(store.load_original_data(data.key).unwrap(), Some(data));
}

#[test]
fn lost_commit_acknowledgement_is_unknown_and_only_explicit_readback_finds_data() {
    let mut index = Sqlite::new();
    let data = fixture();
    index.fail_after_insert_commit = true;
    assert_eq!(
        RollbackReceiptDataStore::open(&mut index)
            .unwrap()
            .record_original_data(&data),
        Err(ReceiptDataError::StorageUnknown)
    );
    // No write retry, active-only result or provider restoration is inferred.
    assert_eq!(
        RollbackReceiptDataStore::open(&mut index)
            .unwrap()
            .load_original_data(data.key)
            .unwrap(),
        Some(data)
    );
}

#[test]
fn different_run_driver_collection_are_not_receipt_aliases_and_history_is_preserved() {
    let mut index = Sqlite::new();
    let data = fixture();
    let mut store = RollbackReceiptDataStore::open(&mut index).unwrap();
    store.record_original_data(&data).unwrap();
    for key in [
        ReceiptDataKey {
            collection_id: id(21),
            ..data.key
        },
        ReceiptDataKey {
            provider_migration_id: id(22),
            ..data.key
        },
        ReceiptDataKey {
            driver_id: id(23),
            ..data.key
        },
    ] {
        assert_eq!(store.load_original_data(key).unwrap(), None);
        let other = OriginalRollbackReceiptData {
            key,
            ..data.clone()
        };
        store.record_original_data(&other).unwrap();
        assert_eq!(store.load_original_data(key).unwrap(), Some(other));
    }
    assert_eq!(store.load_original_data(data.key).unwrap(), Some(data));
}

#[test]
fn raw_sql_cannot_replace_or_delete_original_data() {
    let mut index = Sqlite::new();
    let data = fixture();
    RollbackReceiptDataStore::open(&mut index)
        .unwrap()
        .record_original_data(&data)
        .unwrap();
    assert!(
        index
            .db
            .execute("UPDATE mig_rollback_receipt_data SET fixed_head=55", [])
            .is_err()
    );
    assert!(
        index
            .db
            .execute("DELETE FROM mig_rollback_receipt_data", [])
            .is_err()
    );
    assert_eq!(
        RollbackReceiptDataStore::open(&mut index)
            .unwrap()
            .load_original_data(data.key)
            .unwrap(),
        Some(data)
    );
}
