//! Wrapper-boundary regression only: fake index replies, not SQL/native runtime
//! admission evidence. The separate actual-WASM test owns positive composition.
use mdbn_replica::store::Store;
use mdbn_store_file::index::{
    Batch, IndexDurability, IndexError, IndexInfo, IndexStorage, OpenState, SqlValue, StmtResult,
};
use mdbn_store_file::{LogCache, SqlStoreLimits};
use std::cell::{Cell, RefCell};
use std::rc::Rc;

struct IndexSpy(Rc<Cell<u32>>);
impl IndexStorage for IndexSpy {
    fn info(&self) -> IndexInfo {
        IndexInfo {
            durability: IndexDurability::Disposable,
            opened: OpenState::Fresh,
            sqlite_version: 0,
        }
    }
    fn run(&mut self, batch: &Batch) -> Result<Vec<StmtResult>, IndexError> {
        self.0.set(self.0.get() + 1);
        Ok(batch
            .stmts
            .iter()
            .map(|stmt| {
                if stmt.sql.starts_with("SELECT seq,length(item) FROM st_tail") {
                    StmtResult {
                        columns: 2,
                        ..StmtResult::default()
                    }
                } else if stmt.sql.starts_with("SELECT (SELECT seq FROM st_tail") {
                    StmtResult {
                        columns: 4,
                        values: vec![
                            SqlValue::Null,
                            SqlValue::Null,
                            SqlValue::Integer(0),
                            SqlValue::Integer(0),
                        ],
                        ..StmtResult::default()
                    }
                } else {
                    StmtResult::default()
                }
            })
            .collect())
    }
    fn reset(&mut self) -> Result<(), IndexError> {
        Ok(())
    }
}

#[test]
fn hosted_log_cache_reads_actual_tail_and_stats_instead_of_trait_empty_defaults() {
    let calls = Rc::new(Cell::new(0));
    let index = Rc::new(RefCell::new(IndexSpy(calls.clone())));
    let cache = LogCache::open(index, SqlStoreLimits::default()).unwrap();
    let opened = calls.get();
    assert!(
        cache.tail(4, 1).unwrap().is_empty(),
        "fake index returned no rows"
    );
    assert_eq!(
        calls.get(),
        opened + 1,
        "tail must query the actual index, not manufacture default empty history"
    );
    let _ = cache.tail_stats().unwrap();
    assert_eq!(
        calls.get(),
        opened + 2,
        "tail statistics must use the same index inventory"
    );
}
