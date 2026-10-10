//! Native `IndexStorage` and `Journal` on bundled SQLite.
//! Durable connections disable implicit checkpoints and fail closed on an
//! uncertain commit. macOS adds strict pinned DB/WAL device barriers because
//! SQLite's own fullfsync silently falls back to ordinary fsync.

use std::cell::RefCell;
use std::future::{Future, ready};
use std::path::{Path, PathBuf};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use crate::durability::CommitBarrier;
use mdbn_store_file::index::{
    Batch, BatchMode, BorrowedBlob, IndexDurability, IndexError, IndexErrorKind, IndexInfo,
    IndexStorage, OpenState, SqlValue, StmtResult,
};
use mdbn_store_file::journal::{Journal, JournalEntry, JournalError, Space};
use rusqlite::config::DbConfig;
use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
use rusqlite::types::{ToSqlOutput, Value, ValueRef};
use rusqlite::{Connection, ErrorCode, OpenFlags, OptionalExtension, params_from_iter};

#[cfg(test)]
#[path = "sqlite_borrowed_tests.rs"]
mod borrowed_tests;

fn index_err(e: rusqlite::Error) -> IndexError {
    let kind = match &e {
        rusqlite::Error::SqliteFailure(f, _) => match f.code {
            ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase => IndexErrorKind::Corrupt,
            ErrorCode::DiskFull => IndexErrorKind::Full,
            ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked => IndexErrorKind::Busy,
            ErrorCode::ConstraintViolation | ErrorCode::Unknown => IndexErrorKind::Sql,
            _ => IndexErrorKind::Other,
        },
        rusqlite::Error::SqlInputError { .. } | rusqlite::Error::InvalidParameterCount(..) => {
            IndexErrorKind::Sql
        }
        _ => IndexErrorKind::Other,
    };
    IndexError::new(kind, e.to_string())
}
fn barrier_err(e: std::io::Error) -> IndexError {
    IndexError::new(
        IndexErrorKind::Other,
        format!("required device commit failed (unknown outcome; reopen required): {e}"),
    )
}
fn to_sql(v: &SqlValue) -> Value {
    match v {
        SqlValue::Null => Value::Null,
        SqlValue::Integer(i) => Value::Integer(*i),
        SqlValue::Real(f) => Value::Real(*f),
        SqlValue::Text(s) => Value::Text(s.clone()),
        SqlValue::Blob(b) => Value::Blob(b.clone()),
    }
}
fn to_sql_ref(v: &SqlValue) -> ValueRef<'_> {
    match v {
        SqlValue::Null => ValueRef::Null,
        SqlValue::Integer(i) => ValueRef::Integer(*i),
        SqlValue::Real(f) => ValueRef::Real(*f),
        SqlValue::Text(s) => ValueRef::Text(s.as_bytes()),
        SqlValue::Blob(b) => ValueRef::Blob(b),
    }
}
fn from_sql(v: Value) -> SqlValue {
    match v {
        Value::Null => SqlValue::Null,
        Value::Integer(i) => SqlValue::Integer(i),
        Value::Real(f) => SqlValue::Real(f),
        Value::Text(s) => SqlValue::Text(s),
        Value::Blob(b) => SqlValue::Blob(b),
    }
}

/// Checkpoint access exists only inside the journal's ordered compaction.
/// No raw IndexStorage batch can checkpoint, VACUUM or attach another DB.
#[derive(Clone)]
struct Checkpoints(Arc<AtomicBool>);
impl Checkpoints {
    fn allow<T>(&self, f: impl FnOnce() -> rusqlite::Result<T>) -> rusqlite::Result<T> {
        struct Reset(Arc<AtomicBool>);
        impl Drop for Reset {
            fn drop(&mut self) {
                self.0.store(false, Ordering::SeqCst);
            }
        }
        self.0.store(true, Ordering::SeqCst);
        let _reset = Reset(self.0.clone());
        f()
    }
}

fn verify_policy(c: &Connection) -> Result<(), IndexError> {
    let mode: String = c
        .pragma_query_value(None, "journal_mode", |r| r.get(0))
        .map_err(index_err)?;
    for (name, want) in [
        ("synchronous", 2),
        ("fullfsync", 1),
        ("checkpoint_fullfsync", 1),
        ("wal_autocheckpoint", 0),
    ] {
        let got: i64 = c
            .pragma_query_value(None, name, |r| r.get(0))
            .map_err(index_err)?;
        if got != want {
            return Err(IndexError::new(
                IndexErrorKind::Other,
                "required SQLite durability policy changed",
            ));
        }
    }
    if mode != "wal"
        || !c
            .db_config(DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE)
            .map_err(index_err)?
    {
        return Err(IndexError::new(
            IndexErrorKind::Other,
            "required SQLite WAL/close policy unavailable",
        ));
    }
    Ok(())
}

fn open_conn(
    path: &Path,
    durability: IndexDurability,
) -> Result<(Connection, CommitBarrier, Checkpoints), IndexError> {
    let c = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(index_err)?;
    let required = durability == IndexDurability::Durable;
    if required {
        c.set_db_config(DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, true)
            .map_err(index_err)?;
    }
    let barrier = CommitBarrier::open(path, required).map_err(barrier_err)?;
    // Before any SQL can start a writer and recycle an existing WAL, confirm
    // all visible DB/WAL/namespace writes. Reopen is not permission to trust
    // a committed-but-unflushed receipt left by a failed previous handle.
    barrier.sync().map_err(barrier_err)?;
    let sync = if required { "FULL" } else { "NORMAL" };
    let full = if required { "ON" } else { "OFF" };
    c.execute_batch(&format!(
        "PRAGMA locking_mode=EXCLUSIVE; PRAGMA fullfsync={full}; PRAGMA checkpoint_fullfsync={full}; PRAGMA wal_autocheckpoint={}; PRAGMA journal_mode=WAL; PRAGMA synchronous={sync}; PRAGMA foreign_keys=OFF; PRAGMA secure_delete=ON;",
        if required { 0 } else { 1000 }
    )).map_err(index_err)?;
    if required {
        verify_policy(&c)?;
    }
    c.execute_batch("BEGIN EXCLUSIVE; COMMIT;")
        .map_err(index_err)?;
    barrier.sync().map_err(barrier_err)?;
    let checkpoints = Checkpoints(Arc::new(AtomicBool::new(false)));
    if required {
        let permission = checkpoints.0.clone();
        c.authorizer(Some(move |ctx: AuthContext<'_>| match ctx.action {
            AuthAction::Pragma { pragma_name, .. }
                if pragma_name.eq_ignore_ascii_case("wal_checkpoint") =>
            {
                if permission.load(Ordering::SeqCst) {
                    Authorization::Allow
                } else {
                    Authorization::Deny
                }
            }
            AuthAction::Pragma {
                pragma_name,
                pragma_value: Some(_),
            } if [
                "synchronous",
                "fullfsync",
                "checkpoint_fullfsync",
                "wal_autocheckpoint",
                "journal_mode",
                "locking_mode",
                "secure_delete",
            ]
            .iter()
            .any(|p| pragma_name.eq_ignore_ascii_case(p)) =>
            {
                Authorization::Deny
            }
            AuthAction::Attach { .. } | AuthAction::Detach { .. } => Authorization::Deny,
            _ => Authorization::Allow,
        }));
    }
    Ok((c, barrier, checkpoints))
}

/// [`IndexStorage`] in one SQLite file. Requires a stable, owned private path.
/// On an uncertain commit/barrier failure all I/O fails until a fresh open
/// completes its required barrier. An error does not promise rollback.
pub struct SqliteIndex {
    path: PathBuf,
    conn: Option<Connection>,
    info: IndexInfo,
    barrier: CommitBarrier,
    checkpoints: Checkpoints,
    wal_limit_bytes: u64,
    /// A deferred-sync window is open: one outer write transaction holds
    /// every batch since [`IndexStorage::defer_sync`] opened it, each batch a
    /// savepoint inside it, until closing the window commits it (FULL).
    deferred: bool,
    /// The page cache size outside a window (`PRAGMA cache_size`).
    cache_size: i64,
}
// Match the usual ~1000 x 4KiB SQLite autocheckpoint scale, but only recycle
// WAL after our required physical DB barrier. One batch may exceed this limit.
const INDEX_WAL_LIMIT_BYTES: u64 = 4 * 1024 * 1024;
// A deferred-sync window keeps its dirty pages in a larger page cache so each
// page reaches the WAL once per window instead of once per spill, and keeps
// savepoint (statement) journals in memory; both revert when it closes.
const WINDOW_OPEN: &str = "PRAGMA cache_size=-65536; PRAGMA temp_store=MEMORY; BEGIN IMMEDIATE;";
const CLEAN_TABLE: &str =
    "CREATE TABLE IF NOT EXISTS mdbn_open(k INTEGER PRIMARY KEY, clean INTEGER NOT NULL)";
impl SqliteIndex {
    /// Open the database, verify policy, and complete required startup barriers.
    pub fn open(path: impl Into<PathBuf>, durability: IndexDurability) -> Result<Self, IndexError> {
        let path = path.into();
        let existed = path.exists();
        let (conn, barrier, checkpoints) = open_conn(&path, durability)?;
        let cache_size: i64 = conn
            .pragma_query_value(None, "cache_size", |r| r.get(0))
            .map_err(index_err)?;
        conn.execute_batch(CLEAN_TABLE).map_err(index_err)?;
        let clean: Option<i64> = conn
            .query_row("SELECT clean FROM mdbn_open WHERE k = 1", [], |r| r.get(0))
            .optional()
            .map_err(index_err)?;
        conn.execute(
            "INSERT OR REPLACE INTO mdbn_open(k, clean) VALUES (1, 0)",
            [],
        )
        .map_err(index_err)?;
        barrier.sync().map_err(barrier_err)?;
        let opened = match (existed, clean) {
            (false, _) | (true, None) => OpenState::Fresh,
            (true, Some(1)) => OpenState::Existing,
            (true, Some(_)) => OpenState::Unclean,
        };
        let mut index = Self {
            path,
            conn: Some(conn),
            barrier,
            checkpoints,
            wal_limit_bytes: INDEX_WAL_LIMIT_BYTES,
            deferred: false,
            cache_size,
            info: IndexInfo {
                durability,
                opened,
                sqlite_version: u32::try_from(rusqlite::version_number()).unwrap_or(0),
            },
        };
        // The startup writes have crossed the required commit barrier too.
        if durability == IndexDurability::Durable
            && let Err(e) = index.maintain_wal()
        {
            index.conn = None;
            return Err(e);
        }
        Ok(index)
    }
    /// Close without a clean-shutdown hint (tests and crash emulation).
    pub fn close_unclean(mut self) {
        self.conn = None;
    }
    /// The configured database path.
    pub fn path(&self) -> &Path {
        &self.path
    }
    fn conn(&mut self) -> Result<&mut Connection, IndexError> {
        self.conn.as_mut().ok_or_else(|| {
            IndexError::new(
                IndexErrorKind::Other,
                "closed or uncertain durability; reopen required",
            )
        })
    }
    // Called only after the current committed WAL has crossed barrier.sync().
    // Exclusive ownership and a synchronous &mut run prevent another writer
    // from resetting a fully-backfilled WAL between PASSIVE and the DB barrier.
    fn maintain_wal(&self) -> Result<(), IndexError> {
        let mut wal_path = self.path.as_os_str().to_os_string();
        wal_path.push("-wal");
        let size = std::fs::metadata(wal_path)
            .map_err(|e| IndexError::new(IndexErrorKind::Other, e.to_string()))?
            .len();
        if size < self.wal_limit_bytes {
            return Ok(());
        }
        let c = self.conn.as_ref().ok_or_else(|| {
            IndexError::new(IndexErrorKind::Other, "closed index; reopen required")
        })?;
        let (busy, frames, copied): (i32, i32, i32) = self
            .checkpoints
            .allow(|| {
                c.query_row("PRAGMA wal_checkpoint(PASSIVE)", [], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                })
            })
            .map_err(index_err)?;
        // PASSIVE copies pages but does not truncate/reset WAL. SQLite's own
        // sync may silently downgrade on macOS: our strict barrier is mandatory
        // before TRUNCATE or any following writer can recycle those frames.
        self.barrier.sync().map_err(barrier_err)?;
        if busy != 0 || frames < 0 || frames != copied {
            return Err(IndexError::new(
                IndexErrorKind::Other,
                "checkpoint incomplete; no WAL recycle permitted; reopen required",
            ));
        }
        let status: (i32, i32, i32) = self
            .checkpoints
            .allow(|| {
                c.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                })
            })
            .map_err(index_err)?;
        if status != (0, 0, 0) {
            return Err(IndexError::new(
                IndexErrorKind::Other,
                "WAL truncate incomplete; reopen required",
            ));
        }
        self.barrier.sync().map_err(barrier_err)?;
        Ok(())
    }
    fn exec_all(
        conn: &Connection,
        batch: &Batch,
        wrote: &mut bool,
        borrowed: Option<BorrowedBlob<'_>>,
    ) -> Result<Vec<StmtResult>, IndexError> {
        let mut out = Vec::with_capacity(batch.stmts.len());
        for (i, s) in batch.stmts.iter().enumerate() {
            let at = |mut e: IndexError| {
                e.stmt = u32::try_from(i).ok();
                e
            };
            let mut st = conn.prepare_cached(&s.sql).map_err(index_err).map_err(at)?;
            let columns = st.column_count();
            if borrowed.is_some() && (st.readonly() || columns != 0) {
                return Err(at(IndexError::new(
                    IndexErrorKind::Sql,
                    "borrowed blob requires write without readback",
                )));
            }
            *wrote |= !st.readonly();
            let mut values = Vec::new();
            {
                let mut rows = match borrowed {
                    Some(blob) => st.query(params_from_iter(s.params.iter().enumerate().map(
                        |(parameter, value)| {
                            ToSqlOutput::Borrowed(if parameter == blob.parameter {
                                ValueRef::Blob(blob.bytes)
                            } else {
                                to_sql_ref(value)
                            })
                        },
                    ))),
                    None => st.query(params_from_iter(s.params.iter().map(to_sql))),
                }
                .map_err(index_err)
                .map_err(at)?;
                while let Some(r) = rows.next().map_err(index_err).map_err(at)? {
                    for c in 0..columns {
                        values.push(from_sql(
                            r.get::<_, Value>(c).map_err(index_err).map_err(at)?,
                        ));
                    }
                }
            }
            out.push(StmtResult {
                columns: u32::try_from(columns).unwrap_or(u32::MAX),
                values,
                changes: conn.changes(),
                last_insert_rowid: conn.last_insert_rowid(),
            });
        }
        Ok(out)
    }
    fn run_checked(
        conn: &Connection,
        batch: &Batch,
        required: bool,
        deferred: bool,
        wrote: &mut bool,
        poison: &mut bool,
        borrowed: Option<BorrowedBlob<'_>>,
    ) -> Result<Vec<StmtResult>, IndexError> {
        // A batch of plain queries can neither commit nor change the policy
        // (the authorizer denies policy pragmas anyway): skip the ten pragma
        // round trips that would otherwise dominate small reads.
        let required = required && !Self::plain_reads(conn, batch);
        if required && let Err(e) = verify_policy(conn) {
            *poison = true;
            return Err(e);
        }
        let result = match batch.mode {
            BatchMode::Autocommit => Self::exec_all(conn, batch, wrote, borrowed),
            // Inside the window's outer transaction: atomic as a savepoint,
            // durable only when the window commits.
            BatchMode::Transaction if deferred => {
                conn.execute_batch("SAVEPOINT mdbn_batch")
                    .map_err(index_err)?;
                match Self::exec_all(conn, batch, wrote, borrowed) {
                    Ok(r) => match conn.execute_batch("RELEASE mdbn_batch") {
                        Ok(()) => Ok(r),
                        Err(e) => {
                            *poison = true;
                            Err(index_err(e))
                        }
                    },
                    Err(e) => {
                        if conn
                            .execute_batch("ROLLBACK TO mdbn_batch; RELEASE mdbn_batch")
                            .is_err()
                        {
                            *poison = true;
                        }
                        Err(e)
                    }
                }
            }
            BatchMode::Transaction => {
                conn.execute_batch("BEGIN IMMEDIATE").map_err(index_err)?;
                match Self::exec_all(conn, batch, wrote, borrowed) {
                    Ok(r) => match conn.execute_batch("COMMIT") {
                        Ok(()) => Ok(r),
                        Err(e) => {
                            *poison = true;
                            Err(index_err(e))
                        }
                    },
                    Err(e) => {
                        if conn.execute_batch("ROLLBACK").is_err() {
                            *poison = true;
                        }
                        *wrote = false;
                        Err(e)
                    }
                }
            }
        };
        if conn.is_autocommit() == deferred {
            *poison = true;
            return Err(IndexError::new(
                IndexErrorKind::Other,
                if deferred {
                    "batch ended the deferred-sync window"
                } else {
                    "batch left an uncommitted transaction"
                },
            ));
        }
        if required && let Err(e) = verify_policy(conn) {
            *poison = true;
            return Err(e);
        }
        result
    }
    /// Every statement is a `SELECT`/`WITH` query that SQLite reports as
    /// read-only. Statements are prepared through the cache `exec_all` uses.
    fn plain_reads(conn: &Connection, batch: &Batch) -> bool {
        batch.stmts.iter().all(|s| {
            let head = s.sql.trim_start();
            let query = head
                .get(..6)
                .is_some_and(|h| h.eq_ignore_ascii_case("select"))
                || head
                    .get(..4)
                    .is_some_and(|h| h.eq_ignore_ascii_case("with"));
            query && conn.prepare_cached(&s.sql).is_ok_and(|st| st.readonly())
        })
    }
    /// Commit the window's outer transaction (FULL: its WAL sync covers every
    /// batch in it), cross the commit barrier and maintain the WAL.
    fn end_deferred(&mut self) -> Result<(), IndexError> {
        self.deferred = false;
        let cache_size = self.cache_size;
        let c = self.conn()?;
        verify_policy(c)?;
        c.execute_batch("COMMIT").map_err(index_err)?;
        if !c.is_autocommit() {
            return Err(IndexError::new(
                IndexErrorKind::Other,
                "deferred-sync window did not commit",
            ));
        }
        c.execute_batch(&format!(
            "PRAGMA cache_size={cache_size}; PRAGMA temp_store=DEFAULT;"
        ))
        .map_err(index_err)?;
        self.barrier.sync().map_err(barrier_err)?;
        self.maintain_wal()
    }
}
impl SqliteIndex {
    fn run_inner(
        &mut self,
        batch: &Batch,
        borrowed: Option<BorrowedBlob<'_>>,
    ) -> Result<Vec<StmtResult>, IndexError> {
        let required = self.info.durability == IndexDurability::Durable;
        // Statements outside a savepoint (Autocommit mode) that may write
        // close the window first: they keep their own commit semantics.
        if self.deferred
            && batch.mode == BatchMode::Autocommit
            && !Self::plain_reads(self.conn()?, batch)
        {
            self.defer_sync(false)?;
        }
        let deferred = self.deferred;
        let mut wrote = false;
        let mut poison = false;
        let mut result = Self::run_checked(
            self.conn()?,
            batch,
            required,
            deferred,
            &mut wrote,
            &mut poison,
            borrowed,
        );
        if deferred {
            // Nothing is durable before the window commits: no barrier and no
            // WAL recycling inside it.
            if poison {
                self.conn = None;
                self.deferred = false;
            }
            return result;
        }
        if wrote && let Err(e) = self.barrier.sync() {
            poison = true;
            result = Err(barrier_err(e));
        }
        if result
            .as_ref()
            .is_err_and(|e| e.kind != IndexErrorKind::Sql)
        {
            poison = true;
        }
        if required
            && wrote
            && !poison
            && let Err(e) = self.maintain_wal()
        {
            // Even if the user transaction already committed, an uncertain
            // checkpoint/barrier may not be followed by another WAL writer.
            poison = true;
            result = Err(e);
        }
        if poison {
            self.conn = None;
        }
        result
    }
}
impl IndexStorage for SqliteIndex {
    fn info(&self) -> IndexInfo {
        self.info
    }
    fn run(&mut self, batch: &Batch) -> Result<Vec<StmtResult>, IndexError> {
        self.run_inner(batch, None)
    }
    fn run_with_borrowed_blob(
        &mut self,
        batch: &Batch,
        blob: BorrowedBlob<'_>,
    ) -> Result<Vec<StmtResult>, IndexError> {
        blob.validate(batch)?;
        self.run_inner(batch, Some(blob))
    }
    fn defer_sync(&mut self, on: bool) -> Result<bool, IndexError> {
        if self.info.durability != IndexDurability::Durable {
            // Nothing durable to defer: never part of a window.
            return Ok(false);
        }
        if on == self.deferred {
            return Ok(true);
        }
        let r = if on {
            let c = self.conn()?;
            verify_policy(c)
                .and_then(|()| c.execute_batch(WINDOW_OPEN).map_err(index_err))
                .map(|()| self.deferred = true)
        } else {
            self.end_deferred()
        };
        if r.is_err() {
            // The window's outcome is unknown: fence until a fresh open.
            self.conn = None;
            self.deferred = false;
        }
        r.map(|()| true)
    }
    fn reset(&mut self) -> Result<(), IndexError> {
        // Never turn uncertain durability into silent destructive recovery.
        self.conn()?;
        self.conn = None;
        for suffix in ["", "-wal", "-shm", "-journal"] {
            let mut p = self.path.clone().into_os_string();
            p.push(suffix);
            match std::fs::remove_file(&p) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(IndexError::new(IndexErrorKind::Other, e.to_string())),
            }
        }
        *self = Self::open(self.path.clone(), self.info.durability)?;
        Ok(())
    }
}
impl Drop for SqliteIndex {
    fn drop(&mut self) {
        // A clean close commits an open window rather than discarding it.
        if self.deferred && self.end_deferred().is_err() {
            return;
        }
        if let Some(c) = &self.conn {
            // A best-effort shutdown hint, not a new acknowledgement. No close
            // checkpoint can recycle previously-durable WAL frames.
            let _ = c.execute("UPDATE mdbn_open SET clean = 1 WHERE k = 1", []);
        }
    }
}

/// [`Journal`] in its own SQLite file. Success follows the required commit
/// point; an uncertain commit poisons append/load/compact until fresh open.
pub struct SqliteJournal {
    conn: RefCell<Option<Connection>>,
    barrier: CommitBarrier,
    checkpoints: Checkpoints,
}
fn jerr(e: rusqlite::Error) -> JournalError {
    match &e {
        rusqlite::Error::SqliteFailure(f, _) if f.code == ErrorCode::DiskFull => {
            JournalError::Full(e.to_string())
        }
        rusqlite::Error::SqliteFailure(f, _)
            if matches!(f.code, ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase) =>
        {
            JournalError::Lost(e.to_string())
        }
        _ => JournalError::Other(e.to_string()),
    }
}
fn closed_journal() -> JournalError {
    JournalError::Other("uncertain durability; reopen journal required".into())
}
impl SqliteJournal {
    /// Open the journal and complete required startup barriers before loading.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, JournalError> {
        let (c, barrier, checkpoints) = open_conn(path.as_ref(), IndexDurability::Durable)
            .map_err(|e| JournalError::Other(e.to_string()))?;
        c.execute_batch("CREATE TABLE IF NOT EXISTS j(space INTEGER NOT NULL, k BLOB NOT NULL, version INTEGER NOT NULL, v BLOB, PRIMARY KEY(space, k)) WITHOUT ROWID").map_err(jerr)?;
        barrier
            .sync()
            .map_err(|e| JournalError::Other(barrier_err(e).to_string()))?;
        Ok(Self {
            conn: RefCell::new(Some(c)),
            barrier,
            checkpoints,
        })
    }
    fn insert_all(
        tx: &rusqlite::Transaction<'_>,
        batch: Vec<JournalEntry>,
    ) -> Result<(), JournalError> {
        let mut st = tx.prepare_cached("INSERT INTO j(space, k, version, v) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(space, k) DO UPDATE SET version = excluded.version, v = excluded.v WHERE excluded.version > j.version").map_err(jerr)?;
        for e in batch {
            let version = i64::try_from(e.version)
                .map_err(|_| JournalError::Other("version overflow".into()))?;
            st.execute(rusqlite::params![
                i64::from(e.space.0),
                e.key,
                version,
                e.value
            ])
            .map_err(jerr)?;
        }
        Ok(())
    }
    fn with_conn<T>(
        &self,
        f: impl FnOnce(&mut Connection) -> Result<T, JournalError>,
    ) -> Result<T, JournalError> {
        let mut slot = self.conn.borrow_mut();
        let result = (|| {
            let c = slot.as_mut().ok_or_else(closed_journal)?;
            verify_policy(c).map_err(|e| JournalError::Other(e.to_string()))?;
            f(c)
        })();
        if result.is_err() {
            *slot = None;
        }
        result
    }
    fn append_now(&self, batch: Vec<JournalEntry>) -> Result<(), JournalError> {
        self.with_conn(|c| {
            let tx = c.transaction().map_err(jerr)?;
            Self::insert_all(&tx, batch)?;
            tx.commit().map_err(jerr)?;
            self.barrier
                .sync()
                .map_err(|e| JournalError::Other(barrier_err(e).to_string()))
        })
    }
    fn load_now(&self) -> Result<Vec<JournalEntry>, JournalError> {
        self.with_conn(|c| {
            let mut st = c
                .prepare_cached(
                    "SELECT space, k, version, v FROM j WHERE v IS NOT NULL ORDER BY space, k",
                )
                .map_err(jerr)?;
            let rows = st
                .query_map([], |r| {
                    Ok(JournalEntry {
                        space: Space(r.get::<_, u8>(0)?),
                        key: r.get(1)?,
                        version: r.get::<_, u64>(2)?,
                        value: r.get(3)?,
                    })
                })
                .map_err(jerr)?;
            rows.collect::<Result<_, _>>().map_err(jerr)
        })
    }
    fn compact_now(&self, live: Vec<JournalEntry>) -> Result<(), JournalError> {
        self.with_conn(|c| {
            let tx = c.transaction().map_err(jerr)?;
            tx.execute("DELETE FROM j", []).map_err(jerr)?;
            Self::insert_all(&tx, live)?;
            tx.commit().map_err(jerr)?;
            // Confirm the replacement live set before any checkpoint can recycle
            // its predecessor. PASSIVE copies to DB without truncating WAL; a
            // strict DB/WAL barrier must succeed before TRUNCATE is permitted.
            let finish = || -> Result<(), JournalError> {
                self.barrier
                    .sync()
                    .map_err(|e| JournalError::Other(barrier_err(e).to_string()))?;
                let (busy, frames, copied): (i32, i32, i32) = self
                    .checkpoints
                    .allow(|| {
                        c.query_row("PRAGMA wal_checkpoint(PASSIVE)", [], |r| {
                            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                        })
                    })
                    .map_err(jerr)?;
                self.barrier
                    .sync()
                    .map_err(|e| JournalError::Other(barrier_err(e).to_string()))?;
                if busy != 0 || frames != copied {
                    return Err(JournalError::Other(
                        "checkpoint incomplete; no WAL recycle permitted".into(),
                    ));
                }
                let busy: i32 = self
                    .checkpoints
                    .allow(|| c.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| r.get(0)))
                    .map_err(jerr)?;
                if busy != 0 {
                    return Err(JournalError::Other("WAL truncate incomplete".into()));
                }
                self.barrier
                    .sync()
                    .map_err(|e| JournalError::Other(barrier_err(e).to_string()))?;
                Ok(())
            };
            finish()
        })
    }
}
impl Journal for SqliteJournal {
    fn append(&self, batch: Vec<JournalEntry>) -> impl Future<Output = Result<(), JournalError>> {
        ready(self.append_now(batch))
    }
    fn load(&self) -> impl Future<Output = Result<Vec<JournalEntry>, JournalError>> {
        ready(self.load_now())
    }
    fn compact(&self, live: Vec<JournalEntry>) -> impl Future<Output = Result<(), JournalError>> {
        ready(self.compact_now(live))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mdbn_store_file::index::Stmt;
    fn path(name: &str) -> PathBuf {
        let d = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/tmp/native-device")
            .join(name);
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d.join("state.db")
    }
    fn wal_len(p: &Path) -> u64 {
        let mut w = p.as_os_str().to_os_string();
        w.push("-wal");
        std::fs::metadata(w).unwrap().len()
    }
    fn batch(sql: &str) -> Batch {
        Batch {
            mode: BatchMode::Transaction,
            stmts: vec![Stmt::new(sql, vec![])],
        }
    }
    fn entry(key: u8) -> JournalEntry {
        JournalEntry {
            space: Space(1),
            key: vec![key],
            version: 1,
            value: Some(vec![key; 100]),
        }
    }
    #[test]
    fn durable_policy_disables_implicit_checkpoints_and_close_recycle() {
        let p = path("policy");
        let mut i = SqliteIndex::open(&p, IndexDurability::Durable).unwrap();
        verify_policy(i.conn.as_ref().unwrap()).unwrap();
        i.run(&batch("CREATE TABLE t(k INTEGER)")).unwrap();
        i.run(&batch("INSERT INTO t VALUES(1)")).unwrap();
        let n = wal_len(&p);
        assert!(n > 0);
        drop(i);
        assert!(
            wal_len(&p) >= n,
            "close must not checkpoint/recycle durable WAL"
        );
        let i = SqliteIndex::open(&p, IndexDurability::Durable).unwrap();
        verify_policy(i.conn.as_ref().unwrap()).unwrap();
    }
    #[test]
    fn ordered_index_checkpoints_bound_wal_and_preserve_rows_after_reopen() {
        let p = path("index-wal-bounded");
        let mut i = SqliteIndex::open(&p, IndexDurability::Durable).unwrap();
        i.run(&batch("CREATE TABLE t(k INTEGER PRIMARY KEY, v BLOB)"))
            .unwrap();
        let mut checkpoints = 0;
        for k in 0..600 {
            i.run(&batch(&format!(
                "INSERT INTO t VALUES({k}, zeroblob(8192))"
            )))
            .unwrap();
            let bytes = wal_len(&p);
            assert!(
                bytes < INDEX_WAL_LIMIT_BYTES,
                "maintenance after each write batch"
            );
            checkpoints += usize::from(bytes == 0);
        }
        assert!(checkpoints > 0, "cross the real production threshold");
        verify_policy(i.conn.as_ref().unwrap()).unwrap();
        // Temporary authorization never escapes the internal checkpoint call.
        assert!(
            i.run(&Batch {
                mode: BatchMode::Autocommit,
                stmts: vec![Stmt::new("PRAGMA wal_checkpoint(TRUNCATE)", vec![])],
            })
            .is_err()
        );
        drop(i);
        let mut i = SqliteIndex::open(&p, IndexDurability::Durable).unwrap();
        let rows = i
            .run(&batch(
                "SELECT count(*), min(k), max(k), sum(length(v)) FROM t",
            ))
            .unwrap();
        assert_eq!(
            rows[0].values,
            vec![
                SqlValue::Integer(600),
                SqlValue::Integer(0),
                SqlValue::Integer(599),
                SqlValue::Integer(600 * 8192),
            ]
        );
    }
    #[test]
    fn ordered_index_checkpoint_barrier_failures_poison_without_early_recycle() {
        for at in 1..=3 {
            let p = path(&format!("index-checkpoint-fail-{at}"));
            let mut i = SqliteIndex::open(&p, IndexDurability::Durable).unwrap();
            i.run(&batch("CREATE TABLE t(k INTEGER)")).unwrap();
            i.run(&batch("INSERT INTO t VALUES(1)")).unwrap();
            let before = wal_len(&p);
            i.wal_limit_bytes = 0;
            // 1 = current commit, 2 = copied DB before TRUNCATE,
            // 3 = post-TRUNCATE. Every failure fences the handle.
            i.barrier.fail_on_call(at);
            assert!(i.run(&batch("INSERT INTO t VALUES(2)")).is_err());
            assert!(i.conn.is_none());
            assert!(i.run(&batch("SELECT * FROM t")).is_err());
            assert!(i.run(&batch("INSERT INTO t VALUES(3)")).is_err());
            assert!(i.reset().is_err());
            if at <= 2 {
                assert!(
                    wal_len(&p) >= before,
                    "no recycle before required DB barrier"
                );
            } else {
                assert_eq!(wal_len(&p), 0, "post-truncate failure still poisons");
            }
            drop(i);
            let mut i = SqliteIndex::open(&p, IndexDurability::Durable).unwrap();
            let rows = i.run(&batch("SELECT k FROM t ORDER BY k")).unwrap();
            assert!(rows[0].values.contains(&SqlValue::Integer(1)));
            // The failed transaction may have committed; no rollback assertion.
            i.run(&batch("INSERT INTO t VALUES(3)")).unwrap();
        }
    }
    #[test]
    fn checkpoint_sql_failure_after_commit_poisons_index_until_reopen() {
        let p = path("index-checkpoint-sql-failure");
        let mut i = SqliteIndex::open(&p, IndexDurability::Durable).unwrap();
        i.run(&batch("CREATE TABLE t(k INTEGER)")).unwrap();
        i.run(&batch("INSERT INTO t VALUES(1)")).unwrap();
        let before = wal_len(&p);
        i.wal_limit_bytes = 0;
        // A real SQLite checkpoint error, not a successful stub. The ordinary
        // durability-policy checks and COMMIT still execute successfully.
        i.conn
            .as_ref()
            .unwrap()
            .authorizer(Some(|ctx: AuthContext<'_>| match ctx.action {
                AuthAction::Pragma { pragma_name, .. }
                    if pragma_name.eq_ignore_ascii_case("wal_checkpoint") =>
                {
                    Authorization::Deny
                }
                _ => Authorization::Allow,
            }));
        assert!(i.run(&batch("INSERT INTO t VALUES(2)")).is_err());
        assert!(wal_len(&p) >= before);
        assert!(i.conn.is_none());
        assert!(i.run(&batch("SELECT * FROM t")).is_err());
        assert!(i.reset().is_err());
        drop(i);
        let mut i = SqliteIndex::open(&p, IndexDurability::Durable).unwrap();
        let rows = i.run(&batch("SELECT k FROM t ORDER BY k")).unwrap();
        assert!(rows[0].values.contains(&SqlValue::Integer(1)));
        i.run(&batch("INSERT INTO t VALUES(3)")).unwrap();
    }
    #[test]
    fn startup_maintains_oversized_wal_only_after_required_barrier() {
        let p = path("index-wal-startup");
        let mut i = SqliteIndex::open(&p, IndexDurability::Durable).unwrap();
        i.wal_limit_bytes = u64::MAX;
        i.run(&batch("CREATE TABLE t(v BLOB)")).unwrap();
        i.run(&batch("INSERT INTO t VALUES(zeroblob(5000000))"))
            .unwrap();
        assert!(wal_len(&p) >= INDEX_WAL_LIMIT_BYTES);
        i.close_unclean();
        let mut i = SqliteIndex::open(&p, IndexDurability::Durable).unwrap();
        assert_eq!(wal_len(&p), 0);
        let rows = i.run(&batch("SELECT length(v) FROM t")).unwrap();
        assert_eq!(rows[0].values, vec![SqlValue::Integer(5000000)]);
    }
    #[test]
    #[ignore = "10k durable commits per policy; explicit performance evidence"]
    fn durable_index_wal_profile() {
        for (name, limit) in [("bounded", INDEX_WAL_LIMIT_BYTES), ("unbounded", u64::MAX)] {
            let p = path(&format!("index-wal-profile-{name}"));
            let mut i = SqliteIndex::open(&p, IndexDurability::Durable).unwrap();
            i.wal_limit_bytes = limit;
            i.run(&batch("CREATE TABLE t(k INTEGER PRIMARY KEY, v BLOB)"))
                .unwrap();
            let start = std::time::Instant::now();
            let mut peak = 0;
            let mut checkpoints = 0;
            for k in 0..10000 {
                i.run(&batch(&format!(
                    "INSERT INTO t VALUES({k}, zeroblob(4096))"
                )))
                .unwrap();
                let bytes = wal_len(&p);
                peak = peak.max(bytes);
                checkpoints += usize::from(bytes == 0);
                if [999, 2999, 9999].contains(&k) {
                    eprintln!(
                        "wal-profile policy={name} rows={} elapsed_ms={} wal_bytes={bytes} peak_bytes={peak} checkpoints={checkpoints}",
                        k + 1,
                        start.elapsed().as_millis()
                    );
                }
            }
        }
    }
    #[test]
    fn postcommit_full_failure_poison_index_including_reset_until_reopen() {
        let p = path("index-failure");
        let mut i = SqliteIndex::open(&p, IndexDurability::Durable).unwrap();
        i.run(&batch("CREATE TABLE t(k INTEGER)")).unwrap();
        i.run(&batch("INSERT INTO t VALUES(1)")).unwrap();
        i.barrier.fail_once();
        assert!(i.run(&batch("INSERT INTO t VALUES(2)")).is_err());
        assert!(i.run(&batch("SELECT * FROM t")).is_err());
        assert!(i.reset().is_err());
        drop(i);
        let mut i = SqliteIndex::open(&p, IndexDurability::Durable).unwrap();
        let rows = i.run(&batch("SELECT k FROM t ORDER BY k")).unwrap();
        assert!(
            rows[0].values.contains(&SqlValue::Integer(1)),
            "earlier acknowledged row remains"
        );
        // The failed commit may already exist. Never claim rollback or serve
        // further successes from the failed handle.
        i.run(&batch("INSERT INTO t VALUES(3)")).unwrap();
    }
    #[test]
    fn raw_batches_cannot_checkpoint_or_downgrade_durability() {
        for (name, sql) in [
            ("raw-checkpoint", "PRAGMA wal_checkpoint(TRUNCATE)"),
            ("raw-sync", "PRAGMA synchronous=OFF"),
            ("raw-vacuum", "VACUUM"),
        ] {
            let p = path(name);
            let mut i = SqliteIndex::open(&p, IndexDurability::Durable).unwrap();
            assert!(
                i.run(&Batch {
                    mode: BatchMode::Autocommit,
                    stmts: vec![Stmt::new(sql, vec![])]
                })
                .is_err()
            );
        }
    }
    #[test]
    fn autocommit_batch_cannot_ack_an_open_transaction() {
        let p = path("open-tx");
        let mut i = SqliteIndex::open(&p, IndexDurability::Durable).unwrap();
        assert!(
            i.run(&Batch {
                mode: BatchMode::Autocommit,
                stmts: vec![Stmt::new("BEGIN", vec![])]
            })
            .is_err()
        );
        assert!(i.run(&batch("SELECT 1")).is_err());
    }
    #[test]
    fn postcommit_full_failure_poison_every_journal_api_until_reopen() {
        let p = path("journal-failure");
        let j = SqliteJournal::open(&p).unwrap();
        j.append_now(vec![entry(1)]).unwrap();
        j.barrier.fail_once();
        assert!(j.append_now(vec![entry(2)]).is_err());
        assert!(j.load_now().is_err());
        assert!(j.append_now(vec![entry(3)]).is_err());
        assert!(j.compact_now(vec![entry(1)]).is_err());
        drop(j);
        let j = SqliteJournal::open(&p).unwrap();
        assert!(j.load_now().unwrap().iter().any(|r| r.key == vec![1]));
        j.append_now(vec![entry(3)]).unwrap();
    }
    #[test]
    fn compaction_failures_do_not_recycle_wal_before_confirmed_db() {
        for at in 1..=3 {
            let p = path(&format!("compact-fail-{at}"));
            let j = SqliteJournal::open(&p).unwrap();
            j.append_now(vec![entry(1), entry(2)]).unwrap();
            let before = wal_len(&p);
            j.barrier.fail_on_call(at);
            assert!(j.compact_now(vec![entry(1)]).is_err());
            assert!(j.load_now().is_err());
            if at <= 2 {
                assert!(
                    wal_len(&p) >= before,
                    "no truncate before required DB barrier"
                );
            }
            drop(j);
            let j = SqliteJournal::open(&p).unwrap();
            assert!(j.load_now().unwrap().iter().any(|r| r.key == vec![1]));
        }
    }
    #[test]
    fn ordered_compaction_releases_wal_and_preserves_live_after_reopen() {
        let p = path("compact-success");
        let j = SqliteJournal::open(&p).unwrap();
        j.append_now(vec![entry(1), entry(2)]).unwrap();
        assert!(wal_len(&p) > 0);
        j.compact_now(vec![entry(1)]).unwrap();
        assert_eq!(wal_len(&p), 0);
        drop(j);
        let j = SqliteJournal::open(&p).unwrap();
        let rows = j.load_now().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].key, vec![1]);
    }
    #[test]
    fn malformed_journal_integer_is_not_silently_space_or_version_zero() {
        let p = path("bad-int");
        let j = SqliteJournal::open(&p).unwrap();
        j.append_now(vec![entry(1)]).unwrap();
        j.conn
            .borrow()
            .as_ref()
            .unwrap()
            .execute("UPDATE j SET version=-1", [])
            .unwrap();
        assert!(j.load_now().is_err());
        assert!(j.append_now(vec![entry(2)]).is_err());
    }
}
