//! In-memory SQLite `IndexStorage` test adapter for hosted-worker tests.

use mdbn_store_file::index::{
    Batch, BatchMode, IndexDurability, IndexError, IndexErrorKind, IndexInfo, IndexStorage,
    OpenState, SqlValue, StmtResult,
};

pub(crate) struct Sqlite {
    pub(crate) db: rusqlite::Connection,
}

impl Sqlite {
    pub(crate) fn new() -> Self {
        Self {
            db: rusqlite::Connection::open_in_memory().unwrap(),
        }
    }
}

fn to_sql(v: &SqlValue) -> rusqlite::types::Value {
    use rusqlite::types::Value;
    match v {
        SqlValue::Null => Value::Null,
        SqlValue::Integer(n) => Value::Integer(*n),
        SqlValue::Real(n) => Value::Real(*n),
        SqlValue::Text(s) => Value::Text(s.clone()),
        SqlValue::Blob(b) => Value::Blob(b.clone()),
    }
}

fn from_sql(v: rusqlite::types::ValueRef<'_>) -> SqlValue {
    use rusqlite::types::ValueRef;
    match v {
        ValueRef::Null => SqlValue::Null,
        ValueRef::Integer(n) => SqlValue::Integer(n),
        ValueRef::Real(n) => SqlValue::Real(n),
        ValueRef::Text(s) => SqlValue::Text(std::str::from_utf8(s).unwrap().into()),
        ValueRef::Blob(b) => SqlValue::Blob(b.to_vec()),
    }
}

impl IndexStorage for Sqlite {
    fn info(&self) -> IndexInfo {
        IndexInfo {
            durability: IndexDurability::Disposable,
            opened: OpenState::Existing,
            sqlite_version: 0,
        }
    }

    fn run(&mut self, b: &Batch) -> std::result::Result<Vec<StmtResult>, IndexError> {
        let err = |e: rusqlite::Error| IndexError::new(IndexErrorKind::Sql, e.to_string());
        let tx = b.mode == BatchMode::Transaction;
        if tx {
            self.db.execute_batch("BEGIN IMMEDIATE").map_err(err)?;
        }
        let result = (|| {
            let mut out = vec![];
            for s in &b.stmts {
                let mut p = self.db.prepare(&s.sql).map_err(err)?;
                let columns = p.column_count() as u32;
                let mut rows = p
                    .query(rusqlite::params_from_iter(s.params.iter().map(to_sql)))
                    .map_err(err)?;
                let mut values = vec![];
                while let Some(row) = rows.next().map_err(err)? {
                    for c in 0..columns {
                        values.push(from_sql(row.get_ref(c as usize).map_err(err)?));
                    }
                }
                out.push(StmtResult {
                    columns,
                    values,
                    changes: self.db.changes(),
                    last_insert_rowid: self.db.last_insert_rowid(),
                });
            }
            Ok(out)
        })();
        if tx {
            self.db
                .execute_batch(if result.is_ok() { "COMMIT" } else { "ROLLBACK" })
                .map_err(err)?;
        }
        result
    }

    fn reset(&mut self) -> std::result::Result<(), IndexError> {
        self.db
            .execute_batch("DROP TABLE IF EXISTS st_synthetic")
            .map_err(|_| IndexError::new(IndexErrorKind::Other, "reset"))
    }
}
