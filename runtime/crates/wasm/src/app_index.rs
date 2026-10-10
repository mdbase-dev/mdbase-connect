//! First-party same-Worker SQL import, using the shared bounded binary index ABI.
//! Disposable is honest; only `TentativeStore` may accept pending app edits here.
//! All errors fence this handle. Reset is never an automatic recovery operation.

use mdbn_store_file::index::{
    Batch, IndexDurability, IndexError, IndexErrorKind, IndexInfo, IndexStorage, OpenState,
    StmtResult,
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
    fn execute(&mut self, batch: &Batch) -> Result<Vec<StmtResult>, IndexError> {
        let request = encode_request(&IndexRequest::Run(batch.clone()), LIMITS)
            .map_err(|_| self.failure())?;
        let reply = self.host.run(&request).ok_or_else(|| self.failure())?;
        match decode_reply(&reply, LIMITS, Some(batch.stmts.len())).map_err(|_| self.failure())? {
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
        self.execute(batch)
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
