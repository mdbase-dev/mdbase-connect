//! `DiskDb`: where the file store keeps its own state.
//!
//! The replicated state (records, pending, receipts, holds, ...) lives in an
//! inner [`mdbn_replica::store::Store`]. The file store adds what only it knows,
//! all of it small and keyed:
//! - the disk state of every path it published or ingested (revision, size,
//!   times, file ID), so a warm open stats instead of hashing;
//! - publish intents (journaled before the inner commit, cleared after);
//! - retained files awaiting settlement;
//! - unacknowledged observations and their evidence;
//! - counters for private names and observation IDs;
//! - what attachment-class files were last hashed to (size, times, file ID ->
//!   revision), so a scan re-offers an unacknowledged attachment without
//!   hashing it again while its metadata is unchanged.
//!
//! The interface is a keyed table with atomic, durable batches, so it maps
//! onto SQLite ([`SqlDiskDb`] over [`IndexStorage`]) and onto memory
//! ([`MemDiskDb`], shared across simulated crashes).

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;

use crate::index::{Batch, BatchMode, IndexError, IndexStorage, SqlValue, Stmt};

/// Kinds of rows (the `kind` column).
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
#[repr(u8)]
pub enum Kind {
    /// path → disk state.
    Disk = 1,
    /// publish number → intent.
    Intent = 2,
    /// private path → retained file.
    Retained = 3,
    /// observation ID → observation record.
    Observation = 4,
    /// name → counter.
    Counter = 5,
    /// path → disk state of an attachment-class file as last hashed (not an
    /// acknowledgement). Kept in its own table (`fs_seen`): older readers of
    /// `fs_state` never see the kind.
    Seen = 6,
}

impl Kind {
    fn from_u8(v: u8) -> Option<Kind> {
        Some(match v {
            1 => Kind::Disk,
            2 => Kind::Intent,
            3 => Kind::Retained,
            4 => Kind::Observation,
            5 => Kind::Counter,
            6 => Kind::Seen,
            _ => return None,
        })
    }
}

/// One row.
pub type Row = (Kind, Vec<u8>, Vec<u8>);

/// One change: set (`Some`) or delete (`None`).
pub type Change = (Kind, Vec<u8>, Option<Vec<u8>>);

/// Errors from a [`DiskDb`].
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct DbError(pub String);

/// The file store's own keyed state.
pub trait DiskDb {
    /// Every row, sorted by `(kind, key)`.
    fn load(&self) -> Result<Vec<Row>, DbError>;
    /// Apply changes atomically and durably.
    fn apply(&mut self, changes: Vec<Change>) -> Result<(), DbError>;
    /// Follow the inner store into (`true`) or out of (`false`) a
    /// deferred-durability window. Returns whether this database defers with
    /// it. The file store opens a window only when it does, and closes the
    /// inner store's window first, so an acknowledgement is never durable
    /// before the commit it acknowledges. The default does not defer.
    fn defer_sync(&mut self, _on: bool) -> Result<bool, DbError> {
        Ok(false)
    }
}

/// In-memory [`DiskDb`]. Clones share the same rows, so a test can drop a store
/// and reopen the same state ("crash").
#[derive(Clone, Default)]
pub struct MemDiskDb(Rc<RefCell<MemRows>>);

type MemRows = BTreeMap<(Kind, Vec<u8>), Vec<u8>>;

impl DiskDb for MemDiskDb {
    fn load(&self) -> Result<Vec<Row>, DbError> {
        Ok(self
            .0
            .borrow()
            .iter()
            .map(|((k, key), v)| (*k, key.clone(), v.clone()))
            .collect())
    }

    fn apply(&mut self, changes: Vec<Change>) -> Result<(), DbError> {
        let mut m = self.0.borrow_mut();
        for (k, key, v) in changes {
            match v {
                Some(v) => {
                    m.insert((k, key), v);
                }
                None => {
                    m.remove(&(k, key));
                }
            }
        }
        Ok(())
    }

    /// Memory has nothing to make durable: it follows any window.
    fn defer_sync(&mut self, _on: bool) -> Result<bool, DbError> {
        Ok(true)
    }
}

/// [`DiskDb`] in a SQLite database through [`IndexStorage`].
pub struct SqlDiskDb<I: IndexStorage> {
    index: Rc<RefCell<I>>,
}

const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS fs_state(kind INTEGER NOT NULL, k BLOB NOT NULL, v BLOB NOT NULL, PRIMARY KEY(kind, k)) WITHOUT ROWID";
const SEEN_SCHEMA: &str =
    "CREATE TABLE IF NOT EXISTS fs_seen(k BLOB PRIMARY KEY, v BLOB NOT NULL) WITHOUT ROWID";

impl<I: IndexStorage> SqlDiskDb<I> {
    /// Use (and create if needed) the `fs_state` table.
    pub fn open(index: Rc<RefCell<I>>) -> Result<SqlDiskDb<I>, DbError> {
        index
            .borrow_mut()
            .run(&Batch {
                mode: BatchMode::Autocommit,
                stmts: vec![Stmt::new(SCHEMA, vec![]), Stmt::new(SEEN_SCHEMA, vec![])],
            })
            .map_err(err)?;
        Ok(SqlDiskDb { index })
    }
}

fn err(e: IndexError) -> DbError {
    DbError(e.to_string())
}

impl<I: IndexStorage> DiskDb for SqlDiskDb<I> {
    fn load(&self) -> Result<Vec<Row>, DbError> {
        let r = self
            .index
            .borrow_mut()
            .run(&Batch {
                mode: BatchMode::Autocommit,
                stmts: vec![
                    Stmt::new("SELECT kind, k, v FROM fs_state ORDER BY kind, k", vec![]),
                    Stmt::new(
                        format!("SELECT {}, k, v FROM fs_seen ORDER BY k", Kind::Seen as u8),
                        vec![],
                    ),
                ],
            })
            .map_err(err)?;
        let mut out = Vec::new();
        for row in r.iter().flat_map(|r| r.rows()) {
            if let [SqlValue::Integer(k), SqlValue::Blob(key), SqlValue::Blob(v)] = row
                && let Some(kind) = u8::try_from(*k).ok().and_then(Kind::from_u8)
            {
                out.push((kind, key.clone(), v.clone()));
            } else {
                return Err(DbError("fs_state: malformed row".into()));
            }
        }
        Ok(out)
    }

    fn defer_sync(&mut self, on: bool) -> Result<bool, DbError> {
        // Shares the inner store's index in the native composition, where this
        // is a no-op after the inner store's own call; on its own index, it
        // keeps its own window, closed after the inner one. Follows only when
        // the backend really defers (supports windows).
        self.index.borrow_mut().defer_sync(on).map_err(err)
    }

    fn apply(&mut self, changes: Vec<Change>) -> Result<(), DbError> {
        if changes.is_empty() {
            return Ok(());
        }
        let stmts = changes
            .into_iter()
            .map(|(k, key, v)| match (k, v) {
                (Kind::Seen, Some(v)) => Stmt::new(
                    "INSERT OR REPLACE INTO fs_seen(k, v) VALUES (?, ?)",
                    vec![SqlValue::Blob(key), SqlValue::Blob(v)],
                ),
                (Kind::Seen, None) => {
                    Stmt::new("DELETE FROM fs_seen WHERE k = ?", vec![SqlValue::Blob(key)])
                }
                (k, Some(v)) => Stmt::new(
                    "INSERT OR REPLACE INTO fs_state(kind, k, v) VALUES (?, ?, ?)",
                    vec![
                        SqlValue::Integer(k as i64),
                        SqlValue::Blob(key),
                        SqlValue::Blob(v),
                    ],
                ),
                (k, None) => Stmt::new(
                    "DELETE FROM fs_state WHERE kind = ? AND k = ?",
                    vec![SqlValue::Integer(k as i64), SqlValue::Blob(key)],
                ),
            })
            .collect();
        self.index
            .borrow_mut()
            .run(&Batch {
                mode: BatchMode::Transaction,
                stmts,
            })
            .map_err(err)?;
        Ok(())
    }
}
