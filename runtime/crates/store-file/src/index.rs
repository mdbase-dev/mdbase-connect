//! `IndexStorage`: a SQLite database the store owns.
//!
//! Both targets run real SQLite: bundled SQLite natively (`mdbn-platform-native`)
//! and the official sqlite-wasm on the `opfs-sahpool` VFS in webviews. So
//! the interface is SQL text plus bound values, and the schema and every query
//! live in this crate, portable and shared. A backend only executes statements.
//!
//! # Sync, and why
//!
//! Unlike [`crate::FilePlatform`], this interface is **synchronous**. The
//! replica plans intents against the local view (record lookups, path
//! collisions, unique holders, link targets) inside one synchronous call, and
//! the `Store` reads behind that view come from here. Making them async would
//! push async through planning and the core.
//!
//! This is implementable on both targets:
//! - natively, rusqlite calls block;
//! - in a webview, `opfs-sahpool` is itself synchronous, but only inside a
//!   Worker. **The WASM host must run `runtime.wasm` in the same dedicated
//!   Worker as sqlite-wasm**, so an `IndexStorage` call is a synchronous JS call
//!   from a WASM import. The vault API and the editor stay on the main thread
//!   and are reached asynchronously through the host queue
//!   ([`crate::host`]).
//!
//! To reduce per-call JS boundary overhead, work
//! is submitted as a [`Batch`] of statements and results come back flattened.
//!
//! # Durability classes
//!
//! - [`IndexDurability::Durable`]: the backend must qualify every acknowledged
//!   commit with required physical barriers and fence uncertain errors. SQLite
//!   flags (FULL, or NORMAL plus a checkpoint) alone are not qualification. The
//!   store may keep non-derived state here as well as in the [`crate::Journal`].
//! - [`IndexDurability::Disposable`] (webview): the database can vanish at any
//!   time (eviction, "clear storage", quota misreports, corruption after a kill).
//!   The store keeps only derived data here, records the generation it was built
//!   from in the same transaction, and rebuilds from files plus the journal when
//!   it is missing, stale, corrupt or over quota.
//!
//! # SQL dialect
//!
//! SQLite 3.45 or newer, no loadable extensions, and no JSON functions, so the
//! same statements run on the bundled native build and sqlite-wasm 3.53.x.
//! Values use SQLite's dynamic typing ([`SqlValue`]); the slim schema (derived index schema)
//! relies on numbers sorting before text.

use std::fmt;

/// A SQLite value.
#[derive(Clone, PartialEq, Debug)]
pub enum SqlValue {
    /// `NULL`.
    Null,
    /// `INTEGER` (64-bit).
    Integer(i64),
    /// `REAL`. Never used for anything replicas must agree on.
    Real(f64),
    /// `TEXT` (UTF-8).
    Text(String),
    /// `BLOB`.
    Blob(Vec<u8>),
}

/// One statement with positional (`?`) parameters.
#[derive(Clone, PartialEq, Debug)]
pub struct Stmt {
    /// The SQL. Backends cache prepared statements by this text, so callers use
    /// a small fixed set of statements with parameters, never interpolated
    /// values.
    pub sql: String,
    /// Bound values, in order.
    pub params: Vec<SqlValue>,
}

impl Stmt {
    /// A statement with parameters.
    pub fn new(sql: impl Into<String>, params: Vec<SqlValue>) -> Stmt {
        Stmt {
            sql: sql.into(),
            params,
        }
    }
}

/// How a [`Batch`] is executed.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum BatchMode {
    /// All statements in one transaction (`BEGIN IMMEDIATE` … `COMMIT`).
    /// Pre-COMMIT statement failures may roll back; COMMIT/storage/barrier
    /// failures can have an unknown outcome and never imply rollback.
    Transaction,
    /// Each statement on its own (reads, pragmas, `VACUUM`). Stops at the first
    /// error.
    Autocommit,
}

/// Statements submitted together, to cross the host boundary once.
#[derive(Clone, PartialEq, Debug)]
pub struct Batch {
    /// Transactional or not.
    pub mode: BatchMode,
    /// Executed in order.
    pub stmts: Vec<Stmt>,
}

/// The result of one statement.
#[derive(Clone, PartialEq, Debug, Default)]
pub struct StmtResult {
    /// Number of result columns (0 for statements without rows).
    pub columns: u32,
    /// Row-major values: `values.len()` is a multiple of `columns`.
    pub values: Vec<SqlValue>,
    /// Rows changed by an `INSERT`/`UPDATE`/`DELETE`.
    pub changes: u64,
    /// `last_insert_rowid()` after the statement.
    pub last_insert_rowid: i64,
}

impl StmtResult {
    /// Number of rows returned.
    pub fn row_count(&self) -> u64 {
        if self.columns == 0 {
            0
        } else {
            (self.values.len() / self.columns as usize) as u64
        }
    }

    /// Iterate rows as slices.
    pub fn rows(&self) -> std::slice::Chunks<'_, SqlValue> {
        // With no columns `values` is empty, so this yields nothing.
        self.values.chunks((self.columns as usize).max(1))
    }
}

/// Maximum borrowed blob bound for one synchronous private write.
pub const MAX_BORROWED_BLOB_BYTES: usize = 4 * 1024 * 1024;

/// One borrowed blob replacing a NULL parameter in a single transactional write.
/// This is parameter DATA, not a resource lease or a storage capability. The
/// caller must retain and account for the source throughout the synchronous call.
#[derive(Clone, Copy)]
pub struct BorrowedBlob<'a> {
    /// Zero-based parameter slot; the original parameter must be NULL.
    pub parameter: usize,
    /// Immutable, bounded source bytes; no owned extraction is provided.
    pub bytes: &'a [u8],
}
impl fmt::Debug for BorrowedBlob<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("BorrowedBlob")
            .field("parameter", &self.parameter)
            .field("bytes", &self.bytes.len())
            .finish_non_exhaustive()
    }
}
impl BorrowedBlob<'_> {
    /// Refuse shape/size before backend execution. Native implementations also
    /// require a write with no result columns, so readback cannot copy the blob.
    pub fn validate(&self, batch: &Batch) -> Result<(), IndexError> {
        if self.bytes.len() > MAX_BORROWED_BLOB_BYTES
            || batch.mode != BatchMode::Transaction
            || batch.stmts.len() != 1
            || !matches!(
                batch.stmts[0].params.get(self.parameter),
                Some(SqlValue::Null)
            )
        {
            return Err(IndexError::new(
                IndexErrorKind::Sql,
                "invalid borrowed blob write",
            ));
        }
        Ok(())
    }
}

/// Whether the database survives what the store must survive.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum IndexDurability {
    /// Committed transactions survive process kill and power loss.
    Durable,
    /// May be lost or rolled back at any time; derived data only.
    Disposable,
}

/// What the backend found when it opened the database.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum OpenState {
    /// Created empty (first open, or after eviction or a reset).
    Fresh,
    /// Opened an existing database that was closed cleanly.
    Existing,
    /// Opened an existing database after an unclean shutdown. The store runs
    /// `PRAGMA quick_check` and rebuilds on failure.
    Unclean,
}

/// Facts about the open database.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct IndexInfo {
    /// Durability class.
    pub durability: IndexDurability,
    /// What open found.
    pub opened: OpenState,
    /// `sqlite3_libversion_number()`, e.g. 3_053_004.
    pub sqlite_version: u32,
}

/// Index error categories the store branches on.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum IndexErrorKind {
    /// `SQLITE_CORRUPT`/`SQLITE_NOTADB` or a failed integrity check. Disposable:
    /// rebuild. Durable: an incident.
    Corrupt,
    /// Disk full or quota exceeded. In webviews treat like `Corrupt` (OPFS
    /// misreports quota after force-stops), not as "disk full".
    Full,
    /// Another connection holds the database (a second runtime). Fatal for this
    /// opener: the collection is owned elsewhere.
    Busy,
    /// Constraint or SQL error: a bug in this crate's statements.
    Sql,
    /// Anything else (I/O).
    Other,
}

/// An index error.
#[derive(Clone, PartialEq, Eq)]
pub struct IndexError {
    /// What went wrong.
    pub kind: IndexErrorKind,
    /// Index of the failing statement in its batch, if known.
    pub stmt: Option<u32>,
    /// Detail for diagnostics only.
    pub detail: String,
}

impl IndexError {
    /// Build an error.
    pub fn new(kind: IndexErrorKind, detail: impl Into<String>) -> IndexError {
        IndexError {
            kind,
            stmt: None,
            detail: detail.into(),
        }
    }
}

impl fmt::Debug for IndexError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}", self.kind)?;
        if let Some(s) = self.stmt {
            write!(f, "@{s}")?;
        }
        write!(f, "({})", self.detail)
    }
}

impl fmt::Display for IndexError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(self, f)
    }
}

/// A SQLite connection owned by one store. Single connection, single thread.
///
/// The backend applies its own pragmas at open (for webviews:
/// `locking_mode=EXCLUSIVE`, `journal_mode=WAL`, `synchronous=NORMAL`), names
/// the database by collection ID, and fails with `Busy` if another runtime
/// holds it.
pub trait IndexStorage {
    /// Facts about the open database.
    fn info(&self) -> IndexInfo;

    /// Run a batch. Results are one per statement, in order. In
    /// [`BatchMode::Transaction`] success is atomic (and physically durable for
    /// Durable). An error does NOT certify rollback: COMMIT or required barrier
    /// failure may follow applied effects. Callers must treat the outcome as
    /// unknown; the backend fences uncertain handles until fresh open/recovery.
    fn run(&mut self, batch: &Batch) -> Result<Vec<StmtResult>, IndexError>;

    /// Synchronous single transactional write with one bounded borrowed blob.
    /// Implementations must validate the NULL slot/size before effects, borrow
    /// rather than clone the Rust body, and reject readback/RETURNING statements.
    /// All normal transaction, durability and uncertain-handle fences still
    /// apply. SQLite/page/WAL allocations are not certified by this interface.
    /// Unsupported hosts refuse without invoking run or an owned-copy fallback.
    fn run_with_borrowed_blob(
        &mut self,
        _batch: &Batch,
        _blob: BorrowedBlob<'_>,
    ) -> Result<Vec<StmtResult>, IndexError> {
        Err(IndexError::new(
            IndexErrorKind::Other,
            "borrowed blob writes unsupported",
        ))
    }

    /// Drop the database and start empty (rebuild after corruption, quota
    /// errors or a schema change). [`IndexInfo::opened`] becomes `Fresh`.
    fn reset(&mut self) -> Result<(), IndexError>;

    /// Open (`true`) or close (`false`) a deferred-sync window on a
    /// [`IndexDurability::Durable`] database. Inside one, committed
    /// transactions stay atomic and prefix-ordered but may wait for the next
    /// barrier to become physically durable; closing the window is that
    /// barrier (everything committed before it is durable on `Ok`). Returns
    /// whether this backend supports such windows; backends without them keep
    /// every transaction durable (the default, `false`).
    fn defer_sync(&mut self, _on: bool) -> Result<bool, IndexError> {
        Ok(false)
    }
}

#[cfg(test)]
#[path = "index_borrowed_tests.rs"]
mod borrowed_tests;
