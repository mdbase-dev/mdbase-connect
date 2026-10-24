//! The SQL spill against SQLite, cross-checked operation by operation against the
//! in-memory spill: every driver run through [`Both`] proves the two agree.

use mdbn_store_file::index::{
    Batch, BatchMode, IndexDurability, IndexError, IndexErrorKind, IndexInfo, IndexStorage,
    OpenState, SqlValue, StmtResult,
};
use mdbn_wire::common::Hash;

use super::super::spill::SpillResult;
use super::super::sql_spill::SqlSpill;
use super::super::{DiffRow, Generation, Key, MemSpill, Meta, Spill};
use super::world::{Faults, World};
use super::*;
use crate::preflight::PathEntity;

/// A native [`IndexStorage`] over an in-memory SQLite database, for tests.
pub(crate) struct Sqlite(rusqlite::Connection);

impl Sqlite {
    pub(crate) fn new() -> Self {
        Self(rusqlite::Connection::open_in_memory().unwrap())
    }
}

fn to_sql(v: &SqlValue) -> rusqlite::types::Value {
    use rusqlite::types::Value;
    match v {
        SqlValue::Null => Value::Null,
        SqlValue::Integer(i) => Value::Integer(*i),
        SqlValue::Real(r) => Value::Real(*r),
        SqlValue::Text(s) => Value::Text(s.clone()),
        SqlValue::Blob(b) => Value::Blob(b.clone()),
    }
}

fn from_sql(v: rusqlite::types::ValueRef<'_>) -> SqlValue {
    use rusqlite::types::ValueRef;
    match v {
        ValueRef::Null => SqlValue::Null,
        ValueRef::Integer(i) => SqlValue::Integer(i),
        ValueRef::Real(r) => SqlValue::Real(r),
        ValueRef::Text(t) => SqlValue::Text(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => SqlValue::Blob(b.to_vec()),
    }
}

impl IndexStorage for Sqlite {
    fn info(&self) -> IndexInfo {
        IndexInfo {
            durability: IndexDurability::Disposable,
            opened: OpenState::Fresh,
            sqlite_version: 0,
        }
    }
    fn run(&mut self, batch: &Batch) -> Result<Vec<StmtResult>, IndexError> {
        let err = |e: rusqlite::Error| IndexError::new(IndexErrorKind::Sql, e.to_string());
        let tx = batch.mode == BatchMode::Transaction;
        if tx {
            self.0.execute_batch("BEGIN").map_err(err)?;
        }
        let mut out = Vec::new();
        for s in &batch.stmts {
            let mut st = self.0.prepare(&s.sql).map_err(err)?;
            let columns = st.column_count();
            let params: Vec<rusqlite::types::Value> = s.params.iter().map(to_sql).collect();
            let mut rows = st.query(rusqlite::params_from_iter(params)).map_err(err)?;
            let mut values = Vec::new();
            while let Some(row) = rows.next().map_err(err)? {
                for i in 0..columns {
                    values.push(from_sql(row.get_ref(i).map_err(err)?));
                }
            }
            out.push(StmtResult {
                columns: columns as u32,
                values,
                changes: 0,
                last_insert_rowid: 0,
            });
        }
        if tx {
            self.0.execute_batch("COMMIT").map_err(err)?;
        }
        Ok(out)
    }
    fn reset(&mut self) -> Result<(), IndexError> {
        Ok(())
    }
}

/// Both spills; every answer must agree.
pub(crate) struct Both {
    mem: MemSpill,
    sql: SqlSpill<Sqlite>,
}

impl Both {
    pub(crate) fn new() -> Self {
        Self {
            mem: MemSpill::default(),
            sql: SqlSpill::open(Sqlite::new()).unwrap(),
        }
    }
}

macro_rules! same {
    ($self:ident . $m:ident ( $($a:expr),* )) => {{
        let a = $self.mem.$m($($a),*);
        let b = $self.sql.$m($($a),*);
        assert_eq!(a, b, concat!("spills disagree on ", stringify!($m)));
        a
    }};
}

impl Spill for Both {
    fn load(&mut self) -> SpillResult<Option<Vec<u8>>> {
        same!(self.load())
    }
    fn save(&mut self, c: &[u8]) -> SpillResult<()> {
        same!(self.save(c))
    }
    fn clear(&mut self, g: Generation) -> SpillResult<()> {
        same!(self.clear(g))
    }
    fn is_claimed(&mut self, g: Generation, k: &Hash) -> SpillResult<bool> {
        same!(self.is_claimed(g, k))
    }
    fn claim(&mut self, g: Generation, k: &Hash) -> SpillResult<()> {
        same!(self.claim(g, k))
    }
    fn put_placement(&mut self, g: Generation, k: &Key, m: &Meta) -> SpillResult<()> {
        same!(self.put_placement(g, k, m))
    }
    fn push_deferred(&mut self, g: Generation, e: &PathEntity, m: &Meta) -> SpillResult<()> {
        same!(self.push_deferred(g, e, m))
    }
    fn deferred_page(
        &mut self,
        g: Generation,
        after: Option<&PathEntity>,
        n: usize,
    ) -> SpillResult<Vec<(PathEntity, Meta)>> {
        same!(self.deferred_page(g, after, n))
    }
    fn placements_page(
        &mut self,
        g: Generation,
        after: Option<&Key>,
        n: usize,
    ) -> SpillResult<Vec<(Key, Meta)>> {
        same!(self.placements_page(g, after, n))
    }
    fn placements_in_bucket(
        &mut self,
        g: Generation,
        bits: u64,
        bucket: Option<u64>,
        after: Option<&Key>,
        n: usize,
    ) -> SpillResult<Vec<(Key, Meta)>> {
        same!(self.placements_in_bucket(g, bits, bucket, after, n))
    }
    fn diff_page(&mut self, after: Option<&Key>, n: usize) -> SpillResult<Vec<DiffRow>> {
        same!(self.diff_page(after, n))
    }
}

#[test]
fn bucket_schema_upgrade_preserves_checkpoint_and_requires_old_rows_to_be_reread() {
    let index = Sqlite::new();
    index.0.execute_batch("CREATE TABLE mig_place (g INTEGER NOT NULL, kind INTEGER NOT NULL, id TEXT NOT NULL, class INTEGER NOT NULL, path TEXT NOT NULL, content BLOB NOT NULL, size INTEGER NOT NULL, PRIMARY KEY (g,kind,id)) WITHOUT ROWID").unwrap();
    let key = Key {
        kind: crate::preflight::EntityKind::Record,
        id: "00000000-0000-0000-0000-000000000001".into(),
    };
    let meta = Meta {
        class: Class::Record,
        path: "a.md".into(),
        content: mdbn_wire::common::B32([0; 32]),
        size: 5,
    };
    index.0.execute("INSERT INTO mig_place (g,kind,id,class,path,content,size) VALUES (0,1,?1,1,'a.md',?2,5)", rusqlite::params![key.id, meta.content.0.as_slice()]).unwrap();
    let mut spill = SqlSpill::open(index).unwrap();
    spill.save(b"saved-intent").unwrap();
    assert_eq!(
        spill.placements_page(Generation::S0, None, 1).unwrap(),
        vec![(key.clone(), meta.clone())]
    );
    assert!(
        spill
            .placements_in_bucket(Generation::S0, 0, Some(0), None, 1)
            .unwrap_err()
            .contains("restart")
    );
    assert_eq!(spill.load().unwrap(), Some(b"saved-intent".to_vec()));
    // The driver's pre-base restart drops only this generation's scratch rows.
    spill.clear(Generation::S0).unwrap();
    spill.put_placement(Generation::S0, &key, &meta).unwrap();
    let mut reopened = SqlSpill::open(spill.into_inner()).unwrap();
    assert_eq!(reopened.load().unwrap(), Some(b"saved-intent".to_vec()));
    assert_eq!(
        reopened
            .placements_in_bucket(Generation::S0, 0, Some(0), None, 1)
            .unwrap(),
        vec![(key, meta)]
    );
}

#[test]
fn the_sql_spill_agrees_with_the_memory_spill_through_faulty_runs() {
    for seed in 0..60 {
        let mut world = World::new(seed, super::faults());
        let mut spill = Both::new();
        let r = run(&mut world, &mut spill, None);
        if r.step == Step::Routed {
            assert_routed(&world, &mut spill);
        }
    }
}

#[test]
fn the_sql_spill_survives_a_crash_at_every_action() {
    let n = baseline(17);
    for k in 0..n + 10 {
        let mut world = World::new(
            17,
            Faults {
                writes: 30,
                crash_at: Some(k),
                crash_after: true,
                ..Faults::default()
            },
        );
        let mut spill = Both::new();
        assert_eq!(
            run(&mut world, &mut spill, None).step,
            Step::Routed,
            "crash at {k}"
        );
        assert_routed(&world, &mut spill);
    }
}
