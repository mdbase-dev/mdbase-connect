//! Bounded, immutable ORIGINAL rollback receipt DATA beside `SqlSpill`.
//!
//! This journal does not authenticate a provider, prove a current claim, settle
//! an effect, qualify a pending action or call `Driver::complete`. On the DO,
//! successful `IndexStorage::run` is still an unconfirmed output-gate write.
//! The native shell must independently qualify that commit and its actual
//! native/CPP/physical/pending context before completing any outcome.
//!
//! Retain the complete original binding before Unrevoke clears revoked IDs.
//! Later Unfence uses that ORIGINAL action binding for read-only provider lookup;
//! it must qualify its own different pending action separately. No restore retry,
//! active-only inference, target keys, record payloads or file bytes live here.

use mdbn_store_file::index::{Batch, BatchMode, IndexStorage, SqlValue, Stmt};
use mdbn_wire::common::{B16, Uuid};

const MAX_IDS: usize = 1_000;
const MAX_JSON_INTEGER: u64 = 9_007_199_254_740_991;
const TABLE: &str = "CREATE TABLE IF NOT EXISTS mig_rollback_receipt_data (
 collection_id BLOB NOT NULL CHECK(length(collection_id)=16),
 provider_migration_id BLOB NOT NULL CHECK(length(provider_migration_id)=16),
 driver_id BLOB NOT NULL CHECK(length(driver_id)=16),
 owner_account_id BLOB NOT NULL CHECK(length(owner_account_id)=16),
 authority_epoch INTEGER NOT NULL CHECK(authority_epoch BETWEEN 1 AND 9007199254740991),
 fixed_head INTEGER NOT NULL CHECK(fixed_head BETWEEN 0 AND 9007199254740991),
 action_id BLOB NOT NULL CHECK(length(action_id)=16),
 replica_ids BLOB NOT NULL CHECK(typeof(replica_ids)='blob' AND length(replica_ids)<=16000 AND length(replica_ids)%16=0),
 restored_ids BLOB NOT NULL CHECK(typeof(restored_ids)='blob' AND length(restored_ids)<=16000 AND length(restored_ids)%16=0),
 recorded_at TEXT NOT NULL CHECK(length(recorded_at) BETWEEN 20 AND 64),
 PRIMARY KEY(collection_id,provider_migration_id,driver_id)) WITHOUT ROWID";
const SELECT: &str = "SELECT collection_id,provider_migration_id,driver_id,owner_account_id,
 authority_epoch,fixed_head,action_id,
 CASE WHEN typeof(replica_ids)='blob' AND length(replica_ids)<=16000 THEN replica_ids ELSE NULL END,
 CASE WHEN typeof(restored_ids)='blob' AND length(restored_ids)<=16000 THEN restored_ids ELSE NULL END,
 CASE WHEN length(recorded_at)<=64 THEN recorded_at ELSE NULL END
 FROM mig_rollback_receipt_data
 WHERE collection_id=?1 AND provider_migration_id=?2 AND driver_id=?3 LIMIT 1";

/// Lookup correlation, not permission. One original provider effect per run.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReceiptDataKey {
    /// The collection's UUID; physical DO mapping remains independent.
    pub collection_id: Uuid,
    /// The actual provider migration UUID, not the Driver's UUID.
    pub provider_migration_id: Uuid,
    /// The native Driver's correlation UUID.
    pub driver_id: Uuid,
}

/// Complete provider receipt metadata, NOT a verified native authority object.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OriginalRollbackReceiptData {
    /// Original run correlation.
    pub key: ReceiptDataKey,
    /// Original owner binding.
    pub owner_account_id: Uuid,
    /// Exact v1 provider epoch, representable without JSON number rounding.
    pub authority_epoch: u64,
    /// Exact original fixed drained head.
    pub fixed_head: u64,
    /// Original Unrevoke (or empty-scope Unfence) action, never the later one.
    pub action_id: Uuid,
    /// Complete canonical original requested set, at most 1,000 nonnil IDs.
    pub replica_ids: Vec<Uuid>,
    /// Actual canonical restored subset; independent revocations are preserved.
    pub restored_ids: Vec<Uuid>,
    /// Exact original provider database timestamp; never refreshed on replay.
    pub recorded_at: String,
}

/// Journal failures confer no completion or rollback inference.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReceiptDataError {
    /// Invalid or out-of-budget metadata; refused before a write.
    Invalid,
    /// A different original receipt already exists at this run correlation.
    Conflict,
    /// Storage failure; a write's outcome may be UNKNOWN, never assumed undone.
    StorageUnknown,
    /// Malformed metadata/results; a write's outcome may still be UNKNOWN.
    Corrupt,
}

type Result<T> = std::result::Result<T, ReceiptDataError>;

impl ReceiptDataKey {
    fn valid(self) -> bool {
        [
            self.collection_id,
            self.provider_migration_id,
            self.driver_id,
        ]
        .iter()
        .all(|id| id.0 != [0; 16])
    }
    fn params(self) -> Vec<SqlValue> {
        [
            self.collection_id,
            self.provider_migration_id,
            self.driver_id,
        ]
        .iter()
        .map(|id| SqlValue::Blob(id.0.to_vec()))
        .collect()
    }
}

impl OriginalRollbackReceiptData {
    fn valid(&self) -> bool {
        self.key.valid()
            && self.owner_account_id.0 != [0; 16]
            && self.action_id.0 != [0; 16]
            && (1..=MAX_JSON_INTEGER).contains(&self.authority_epoch)
            && self.fixed_head <= MAX_JSON_INTEGER
            && canonical_ids(&self.replica_ids)
            && canonical_ids(&self.restored_ids)
            && self
                .restored_ids
                .iter()
                .all(|id| self.replica_ids.binary_search(id).is_ok())
            && timestamp_shape(&self.recorded_at)
    }
    fn params(&self) -> Vec<SqlValue> {
        let mut values = self.key.params();
        values.extend([
            SqlValue::Blob(self.owner_account_id.0.to_vec()),
            // Checked by valid before conversion: neither rounding nor wrap.
            SqlValue::Integer(self.authority_epoch as i64),
            SqlValue::Integer(self.fixed_head as i64),
            SqlValue::Blob(self.action_id.0.to_vec()),
            SqlValue::Blob(encode_ids(&self.replica_ids)),
            SqlValue::Blob(encode_ids(&self.restored_ids)),
            SqlValue::Text(self.recorded_at.clone()),
        ]);
        values
    }
}

/// One bounded metadata journal over the SAME index backing the migration spill.
/// Borrow it between `SqlSpill::into_inner` / `SqlSpill::open` when composing.
/// Opening or acknowledging a write does not qualify DO commit durability.
pub struct RollbackReceiptDataStore<'a> {
    index: &'a mut dyn IndexStorage,
}

impl<'a> RollbackReceiptDataStore<'a> {
    /// Idempotent schema creation; no checkpoint or historical record is reset.
    pub fn open(index: &'a mut dyn IndexStorage) -> Result<Self> {
        index.run(&Batch { mode: BatchMode::Transaction, stmts: vec![
            Stmt::new(TABLE, vec![]),
            Stmt::new("CREATE TRIGGER IF NOT EXISTS mig_rollback_receipt_no_update BEFORE UPDATE ON mig_rollback_receipt_data BEGIN SELECT RAISE(ABORT,'immutable rollback receipt data'); END", vec![]),
            Stmt::new("CREATE TRIGGER IF NOT EXISTS mig_rollback_receipt_no_delete BEFORE DELETE ON mig_rollback_receipt_data BEGIN SELECT RAISE(ABORT,'immutable rollback receipt data'); END", vec![]),
        ] }).map_err(|_| ReceiptDataError::StorageUnknown)?;
        Ok(Self { index })
    }

    /// Persist exact ORIGINAL metadata, never renew/replace it. No effect call.
    /// Any post-write error may follow a commit: use independent exact readback,
    /// never a blind write retry or an assumption that the write was undone.
    pub fn record_original_data(&mut self, data: &OriginalRollbackReceiptData) -> Result<()> {
        if !data.valid() {
            return Err(ReceiptDataError::Invalid);
        }
        let mut results = self.index.run(&Batch {
            mode: BatchMode::Transaction,
            stmts: vec![
                Stmt::new("INSERT INTO mig_rollback_receipt_data (collection_id,provider_migration_id,driver_id,owner_account_id,authority_epoch,fixed_head,action_id,replica_ids,restored_ids,recorded_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(collection_id,provider_migration_id,driver_id) DO NOTHING", data.params()),
                Stmt::new(SELECT, data.key.params()),
            ],
        }).map_err(|_| ReceiptDataError::StorageUnknown)?;
        if results.len() != 2 {
            return Err(ReceiptDataError::Corrupt);
        }
        let row = results.pop().ok_or(ReceiptDataError::Corrupt)?;
        if row.columns != 10 || row.row_count() != 1 {
            return Err(ReceiptDataError::Corrupt);
        }
        if decode_row(&row.values)? != *data {
            return Err(ReceiptDataError::Conflict);
        }
        Ok(()) // acknowledged metadata write, NOT a durable permit/completion
    }

    /// Read ONLY the original receipt. Missing data never infers active/success.
    /// Caller still needs fresh provider/CPP/native/pending/settlement guards.
    pub fn load_original_data(
        &mut self,
        key: ReceiptDataKey,
    ) -> Result<Option<OriginalRollbackReceiptData>> {
        if !key.valid() {
            return Err(ReceiptDataError::Invalid);
        }
        let mut results = self
            .index
            .run(&Batch {
                mode: BatchMode::Autocommit,
                stmts: vec![Stmt::new(SELECT, key.params())],
            })
            .map_err(|_| ReceiptDataError::StorageUnknown)?;
        if results.len() != 1 {
            return Err(ReceiptDataError::Corrupt);
        }
        let row = results.pop().ok_or(ReceiptDataError::Corrupt)?;
        if row.columns != 10 || row.row_count() > 1 {
            return Err(ReceiptDataError::Corrupt);
        }
        if row.values.is_empty() {
            return Ok(None);
        }
        let data = decode_row(&row.values)?;
        if data.key != key {
            return Err(ReceiptDataError::Corrupt);
        }
        Ok(Some(data))
    }
}

fn canonical_ids(ids: &[Uuid]) -> bool {
    ids.len() <= MAX_IDS
        && ids.iter().all(|id| id.0 != [0; 16])
        && ids.windows(2).all(|pair| pair[0] < pair[1])
}
fn encode_ids(ids: &[Uuid]) -> Vec<u8> {
    ids.iter().flat_map(|id| id.0).collect()
}
fn decode_ids(value: &SqlValue) -> Result<Vec<Uuid>> {
    let SqlValue::Blob(bytes) = value else {
        return Err(ReceiptDataError::Corrupt);
    };
    if bytes.len() > MAX_IDS * 16 || bytes.len() % 16 != 0 {
        return Err(ReceiptDataError::Corrupt);
    }
    bytes
        .chunks_exact(16)
        .map(|chunk| {
            chunk
                .try_into()
                .map(B16)
                .map_err(|_| ReceiptDataError::Corrupt)
        })
        .collect()
}
fn uuid(value: &SqlValue) -> Result<Uuid> {
    match value {
        SqlValue::Blob(bytes) => bytes
            .as_slice()
            .try_into()
            .map(B16)
            .map_err(|_| ReceiptDataError::Corrupt),
        _ => Err(ReceiptDataError::Corrupt),
    }
}
fn counter(value: &SqlValue) -> Result<u64> {
    match value {
        SqlValue::Integer(value) => u64::try_from(*value).map_err(|_| ReceiptDataError::Corrupt),
        _ => Err(ReceiptDataError::Corrupt),
    }
}
fn decode_row(row: &[SqlValue]) -> Result<OriginalRollbackReceiptData> {
    let [
        collection,
        run,
        driver,
        owner,
        epoch,
        head,
        action,
        requested,
        restored,
        time,
    ] = row
    else {
        return Err(ReceiptDataError::Corrupt);
    };
    let SqlValue::Text(time) = time else {
        return Err(ReceiptDataError::Corrupt);
    };
    if !timestamp_shape(time) {
        return Err(ReceiptDataError::Corrupt);
    }
    let data = OriginalRollbackReceiptData {
        key: ReceiptDataKey {
            collection_id: uuid(collection)?,
            provider_migration_id: uuid(run)?,
            driver_id: uuid(driver)?,
        },
        owner_account_id: uuid(owner)?,
        authority_epoch: counter(epoch)?,
        fixed_head: counter(head)?,
        action_id: uuid(action)?,
        replica_ids: decode_ids(requested)?,
        restored_ids: decode_ids(restored)?,
        recorded_at: time.clone(),
    };
    if !data.valid() {
        return Err(ReceiptDataError::Corrupt);
    }
    Ok(data)
}

// Bounded timestamp syntax only: no clock, freshness or authority is inferred.
fn timestamp_shape(value: &str) -> bool {
    let bytes = value.as_bytes();
    if !(20..=64).contains(&bytes.len())
        || !bytes.is_ascii()
        || [4, 7, 10, 13, 16]
            .into_iter()
            .zip(b"--T::")
            .any(|(at, want)| bytes[at] != *want)
        || bytes[..19]
            .iter()
            .enumerate()
            .any(|(at, b)| ![4, 7, 10, 13, 16].contains(&at) && !b.is_ascii_digit())
    {
        return false;
    }
    let mut at = 19;
    if bytes[at] == b'.' {
        at += 1;
        let start = at;
        while at < bytes.len() && bytes[at].is_ascii_digit() {
            at += 1;
        }
        if !(1..=9).contains(&(at - start)) {
            return false;
        }
    }
    let rest = &bytes[at..];
    rest == b"Z"
        || (rest.len() == 6
            && matches!(rest[0], b'+' | b'-')
            && rest[3] == b':'
            && [1, 2, 4, 5].iter().all(|at| rest[*at].is_ascii_digit()))
}

#[cfg(test)]
#[path = "migration_rollback_receipt_tests.rs"]
mod tests;
