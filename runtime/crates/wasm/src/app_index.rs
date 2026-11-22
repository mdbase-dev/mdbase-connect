//! First-party same-Worker SQL import, using the shared bounded binary index ABI.
//! Disposable is honest; only `TentativeStore` may accept pending app edits here.
//! All errors fence this handle. Reset is never an automatic recovery operation.
//!
//! A deferred-sync window ([`IndexStorage::defer_sync`]) is one outer write
//! transaction on the host connection: the batches inside it run as its
//! statements, and closing the window is its `COMMIT`, the one point where the
//! host writes and flushes them. A handle that dies with a window open (a tab
//! closed, a Worker killed, a trap) never commits it, so the database reopens
//! at the state before the window.

use mdbn_store_file::index::{
    Batch, BatchMode, IndexDurability, IndexError, IndexErrorKind, IndexInfo, IndexStorage,
    OpenState, Stmt, StmtResult,
};
use mdbn_store_file::index_codec::{
    CodecLimits, IndexReply, IndexRequest, decode_reply, encode_request,
};

/// Must equal the optional TS app-storage bridge's envelope.
pub const LIMITS: CodecLimits = CodecLimits {
    max_rows: 4_096,
    ..CodecLimits::HOSTED
};
/// Synchronous host only; the runtime and sqlite-wasm share a dedicated Worker.
pub trait AppSqlHost {
    /// Own the returned bytes. None/trap is not proof of rollback.
    fn run(&mut self, request: &[u8]) -> Option<Vec<u8>>;
}
/// One owned app database handle. No filesystem or platform calls.
pub struct AppIndex {
    host: Box<dyn AppSqlHost>,
    opened: OpenState,
    version: u32,
    fenced: bool,
    /// A deferred-sync window is open: the host connection is inside the
    /// transaction `defer_sync(true)` began.
    deferred: bool,
}
impl std::fmt::Debug for AppIndex {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AppIndex")
            .field("fenced", &self.fenced)
            .finish_non_exhaustive()
    }
}
impl AppIndex {
    /// Facts come from the already-opened host index, never a durability flag.
    pub fn new(host: Box<dyn AppSqlHost>, opened: OpenState, version: u32) -> Self {
        Self {
            host,
            opened,
            version,
            fenced: false,
            deferred: false,
        }
    }
    /// A fenced handle must be dropped and reopened, not reset/retried.
    pub fn fenced(&self) -> bool {
        self.fenced
    }
    fn failure(&mut self) -> IndexError {
        self.fenced = true;
        IndexError::new(
            IndexErrorKind::Other,
            "app index fenced; reopen and reconcile",
        )
    }
    fn execute(&mut self, batch: Batch) -> Result<Vec<StmtResult>, IndexError> {
        let stmts = batch.stmts.len();
        let request =
            encode_request(&IndexRequest::Run(batch), LIMITS).map_err(|_| self.failure())?;
        let reply = self.host.run(&request).ok_or_else(|| self.failure())?;
        match decode_reply(&reply, LIMITS, Some(stmts)).map_err(|_| self.failure())? {
            IndexReply::Results(results) => Ok(results),
            IndexReply::Error(error) => {
                self.fenced = true;
                Err(IndexError {
                    detail: "app SQLite operation failed; reopen and reconcile".into(),
                    ..error
                })
            }
            IndexReply::ResetOk => Err(self.failure()),
        }
    }
    /// One transaction-control statement on the host connection.
    fn control(&mut self, sql: &str) -> Result<(), IndexError> {
        self.execute(Batch {
            mode: BatchMode::Autocommit,
            stmts: vec![Stmt::new(sql, Vec::new())],
        })
        .map(|_| ())
    }
}
/// Every statement is a `SELECT`: it cannot write, so inside a window it
/// needs no commit of its own.
fn plain_reads(batch: &Batch) -> bool {
    batch.stmts.iter().all(|s| {
        s.sql
            .trim_start()
            .get(..6)
            .is_some_and(|head| head.eq_ignore_ascii_case("select"))
    })
}
impl IndexStorage for AppIndex {
    fn info(&self) -> IndexInfo {
        IndexInfo {
            durability: IndexDurability::Disposable,
            opened: self.opened,
            sqlite_version: self.version,
        }
    }
    fn run(&mut self, batch: &Batch) -> Result<Vec<StmtResult>, IndexError> {
        if self.fenced {
            return Err(self.failure());
        }
        if !self.deferred {
            return self.execute(batch.clone());
        }
        match batch.mode {
            // Inside the window's transaction. It needs no savepoint to stay
            // atomic: a statement that fails fences this handle for good, so
            // the window holding the cut-short batch is never committed.
            BatchMode::Transaction => self.execute(Batch {
                mode: BatchMode::Autocommit,
                stmts: batch.stmts.clone(),
            }),
            BatchMode::Autocommit => {
                // Statements outside a transaction that may write keep their
                // own commit: the window closes first.
                if !plain_reads(batch) {
                    self.defer_sync(false)?;
                }
                self.execute(batch.clone())
            }
        }
    }
    fn defer_sync(&mut self, on: bool) -> Result<bool, IndexError> {
        if self.fenced {
            return Err(self.failure());
        }
        if on != self.deferred {
            // A failed `COMMIT` may still have applied: `execute` fences.
            self.control(if on { "BEGIN IMMEDIATE" } else { "COMMIT" })?;
            self.deferred = on;
        }
        Ok(true)
    }
    fn reset(&mut self) -> Result<(), IndexError> {
        self.fenced = true;
        Err(IndexError::new(
            IndexErrorKind::Other,
            "app database reset requires explicit recovery; automatic wipe refused",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mdbn_store_file::index::{BatchMode, SqlValue, Stmt};
    use mdbn_store_file::index_codec::{decode_request, encode_reply};
    use std::{cell::Cell, rc::Rc};
    struct Echo;
    impl AppSqlHost for Echo {
        fn run(&mut self, request: &[u8]) -> Option<Vec<u8>> {
            let IndexRequest::Run(batch) = decode_request(request, LIMITS).ok()? else {
                return None;
            };
            encode_reply(
                &IndexReply::Results(
                    batch
                        .stmts
                        .iter()
                        .map(|s| StmtResult {
                            columns: s.params.len() as u32,
                            values: s.params.clone(),
                            changes: u64::MAX,
                            last_insert_rowid: i64::MIN,
                        })
                        .collect(),
                ),
                LIMITS,
            )
            .ok()
        }
    }
    fn batch() -> Batch {
        Batch {
            mode: BatchMode::Transaction,
            stmts: vec![Stmt::new(
                "SELECT ?,?,?,?,?",
                vec![
                    SqlValue::Integer(i64::MAX),
                    SqlValue::Real(1.0),
                    SqlValue::Null,
                    SqlValue::Text("ü".into()),
                    SqlValue::Blob(vec![0, 255]),
                ],
            )],
        }
    }
    #[test]
    fn exact_binary_values_and_honest_info() {
        let mut index = AppIndex::new(Box::new(Echo), OpenState::Unclean, 3_053_004);
        let result = index.run(&batch()).unwrap();
        assert_eq!(result[0].values, batch().stmts[0].params);
        assert_eq!(result[0].changes, u64::MAX);
        assert_eq!(result[0].last_insert_rowid, i64::MIN);
        assert_eq!(index.info().durability, IndexDurability::Disposable);
        assert_eq!(index.info().opened, OpenState::Unclean);
    }
    struct Bad(Rc<Cell<usize>>);
    impl AppSqlHost for Bad {
        fn run(&mut self, _: &[u8]) -> Option<Vec<u8>> {
            self.0.set(self.0.get() + 1);
            Some(vec![0])
        }
    }
    #[test]
    fn decode_error_fences_and_never_calls_host_again_or_resets() {
        let count = Rc::new(Cell::new(0));
        let mut index = AppIndex::new(Box::new(Bad(count.clone())), OpenState::Existing, 0);
        assert!(index.run(&batch()).is_err());
        assert!(index.fenced());
        assert!(index.run(&batch()).is_err());
        assert!(index.reset().is_err());
        assert_eq!(count.get(), 1);
    }
    /// Records each batch's mode and statements, and fails one on request.
    #[derive(Default)]
    struct Log {
        batches: Vec<(BatchMode, Vec<String>)>,
        fail_at: Option<usize>,
    }
    struct Recording(Rc<std::cell::RefCell<Log>>);
    impl AppSqlHost for Recording {
        fn run(&mut self, request: &[u8]) -> Option<Vec<u8>> {
            let IndexRequest::Run(batch) = decode_request(request, LIMITS).ok()? else {
                return None;
            };
            let mut log = self.0.borrow_mut();
            let at = log.batches.len();
            log.batches.push((
                batch.mode,
                batch.stmts.iter().map(|s| s.sql.clone()).collect(),
            ));
            let reply = if log.fail_at == Some(at) {
                IndexReply::Error(IndexError::new(IndexErrorKind::Other, "host"))
            } else {
                IndexReply::Results(vec![StmtResult::default(); batch.stmts.len()])
            };
            encode_reply(&reply, LIMITS).ok()
        }
    }
    fn recording(fail_at: Option<usize>) -> (AppIndex, Rc<std::cell::RefCell<Log>>) {
        let log = Rc::new(std::cell::RefCell::new(Log {
            fail_at,
            ..Log::default()
        }));
        let index = AppIndex::new(Box::new(Recording(log.clone())), OpenState::Fresh, 0);
        (index, log)
    }
    fn write(sql: &str) -> Batch {
        Batch {
            mode: BatchMode::Transaction,
            stmts: vec![Stmt::new(sql, vec![])],
        }
    }
    fn auto(sql: &str) -> Batch {
        Batch {
            mode: BatchMode::Autocommit,
            stmts: vec![Stmt::new(sql, vec![])],
        }
    }
    /// The host's transactions: `Transaction` batches plus explicit `COMMIT`s.
    fn host_commits(log: &Log) -> usize {
        log.batches
            .iter()
            .filter(|(mode, stmts)| {
                *mode == BatchMode::Transaction || stmts.iter().any(|s| s == "COMMIT")
            })
            .count()
    }
    #[test]
    fn a_window_is_one_host_transaction_whatever_it_holds() {
        let (mut index, log) = recording(None);
        index.run(&write("INSERT 0")).unwrap();
        assert_eq!(host_commits(&log.borrow()), 1, "outside a window: its own");

        assert!(index.defer_sync(true).unwrap());
        assert!(
            index.defer_sync(true).unwrap(),
            "opening twice is one window"
        );
        for n in 1..=50 {
            index.run(&write(&format!("INSERT {n}"))).unwrap();
            index.run(&auto(" select 1")).unwrap();
        }
        assert_eq!(
            host_commits(&log.borrow()),
            1,
            "nothing is committed while the window is open"
        );
        assert!(index.defer_sync(false).unwrap());
        assert!(
            index.defer_sync(false).unwrap(),
            "closing twice is one commit"
        );
        index.run(&write("INSERT 51")).unwrap();

        let log = log.borrow();
        assert_eq!(host_commits(&log), 3, "before, the window, after");
        let sql: Vec<&str> = log
            .batches
            .iter()
            .flat_map(|(_, stmts)| stmts.iter().map(String::as_str))
            .filter(|s| !s.contains("select"))
            .collect();
        assert_eq!(sql[..3], ["INSERT 0", "BEGIN IMMEDIATE", "INSERT 1"]);
        assert_eq!(sql[sql.len() - 3..], ["INSERT 50", "COMMIT", "INSERT 51"]);
        // Inside the window the host never begins or commits a transaction
        // of its own: every batch arrives as plain statements.
        let begin = log
            .batches
            .iter()
            .position(|(_, s)| s[0] == "BEGIN IMMEDIATE")
            .unwrap();
        let commit = log
            .batches
            .iter()
            .position(|(_, s)| s[0] == "COMMIT")
            .unwrap();
        assert!(
            log.batches[begin..=commit]
                .iter()
                .all(|(mode, _)| *mode == BatchMode::Autocommit)
        );
        assert_eq!(log.batches.last().unwrap().0, BatchMode::Transaction);
    }
    #[test]
    fn a_write_outside_a_transaction_closes_the_window_first() {
        let (mut index, log) = recording(None);
        index.defer_sync(true).unwrap();
        index.run(&write("INSERT 1")).unwrap();
        index.run(&auto("PRAGMA optimize")).unwrap();
        index.run(&write("INSERT 2")).unwrap();
        // Already closed: closing again sends nothing.
        index.defer_sync(false).unwrap();
        let log = log.borrow();
        let sql: Vec<&str> = log.batches.iter().map(|(_, s)| s[0].as_str()).collect();
        assert_eq!(
            sql,
            [
                "BEGIN IMMEDIATE",
                "INSERT 1",
                "COMMIT",
                "PRAGMA optimize",
                "INSERT 2"
            ]
        );
        assert_eq!(log.batches[4].0, BatchMode::Transaction);
        assert_eq!(host_commits(&log), 2);
    }
    #[test]
    fn a_failure_inside_a_window_never_commits_it() {
        // Batch 0 opens the window, 1 succeeds, 2 fails.
        let (mut index, log) = recording(Some(2));
        index.defer_sync(true).unwrap();
        index.run(&write("INSERT 1")).unwrap();
        assert!(index.run(&write("INSERT 2")).is_err());
        assert!(index.fenced());
        assert!(index.defer_sync(false).is_err(), "the closer learns");
        assert!(index.defer_sync(true).is_err());
        assert!(index.run(&auto("select 1")).is_err());
        let log = log.borrow();
        assert_eq!(
            log.batches.len(),
            3,
            "a fenced handle reaches the host no more"
        );
        assert_eq!(host_commits(&log), 0);
    }
    #[test]
    fn a_commit_that_fails_fences_the_handle() {
        // Batch 0 opens the window, 1 is the write, 2 is the COMMIT.
        let (mut index, log) = recording(Some(2));
        index.defer_sync(true).unwrap();
        index.run(&write("INSERT 1")).unwrap();
        assert!(index.defer_sync(false).is_err());
        assert!(index.fenced());
        assert!(index.run(&write("INSERT 2")).is_err());
        assert_eq!(log.borrow().batches.len(), 3);
    }
    #[test]
    fn oversized_input_fences_before_host_effects() {
        let count = Rc::new(Cell::new(0));
        let mut index = AppIndex::new(Box::new(Bad(count.clone())), OpenState::Fresh, 0);
        let b = Batch {
            mode: BatchMode::Transaction,
            stmts: vec![Stmt::new("INSERT", vec![SqlValue::Blob(vec![0; 5 << 20])])],
        };
        assert!(index.run(&b).is_err());
        assert!(index.fenced());
        assert_eq!(count.get(), 0);
    }
}
