//! [`Spill`] over SQLite through the shared index ABI (`mdbn_store_file::index`):
//! the hosted DO's SQLite (`DoIndex`) in the Worker, or any native index.
//!
//! The tables live beside the replica's cache, prefixed `mig_`, so a cache reset
//! (which drops the replica's `st_*` tables) never touches migration state. They
//! hold paths, IDs, hashes and sizes only. Every method is one batch of fixed
//! statements with bound parameters; writes are one transaction; reads return at
//! most the caller's `limit` rows (at most 1,000).
//!
//! Ordering matches [`MemSpill`](super::MemSpill) exactly: kinds as their integer
//! order, IDs and paths in SQLite's default BINARY collation (UTF-8 byte order,
//! which is Rust's `String` order).

use mdbn_store_file::index::{Batch, BatchMode, IndexStorage, SqlValue, Stmt, StmtResult};
use mdbn_wire::common::{B32, Hash};

use super::spill::SpillResult;
use super::{Class, DiffRow, Generation, Key, Meta, Spill};
use crate::preflight::{EntityKind, PathEntity};

const SCHEMA: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS mig_checkpoint (k INTEGER PRIMARY KEY CHECK (k = 0), v BLOB NOT NULL)",
    "CREATE TABLE IF NOT EXISTS mig_claim (g INTEGER NOT NULL, h BLOB NOT NULL, PRIMARY KEY (g, h)) WITHOUT ROWID",
    "CREATE TABLE IF NOT EXISTS mig_place (g INTEGER NOT NULL, kind INTEGER NOT NULL, id TEXT NOT NULL, class INTEGER NOT NULL, path TEXT NOT NULL, content BLOB NOT NULL, size INTEGER NOT NULL, bucket INTEGER NOT NULL DEFAULT -1, PRIMARY KEY (g, kind, id)) WITHOUT ROWID",
    "CREATE TABLE IF NOT EXISTS mig_deferred (g INTEGER NOT NULL, kind INTEGER NOT NULL, eid TEXT NOT NULL, epath TEXT NOT NULL, class INTEGER NOT NULL, path TEXT NOT NULL, content BLOB NOT NULL, size INTEGER NOT NULL, PRIMARY KEY (g, kind, eid, epath)) WITHOUT ROWID",
];

/// The SQL spill. See the module docs.
pub struct SqlSpill<I: IndexStorage> {
    index: I,
}

impl<I: IndexStorage> std::fmt::Debug for SqlSpill<I> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SqlSpill(..)")
    }
}

fn gen_of(g: Generation) -> i64 {
    match g {
        Generation::S0 => 0,
        Generation::Final => 1,
    }
}

fn kind_of(k: EntityKind) -> i64 {
    k as i64
}

fn kind_from(v: i64) -> SpillResult<EntityKind> {
    Ok(match v {
        0 => EntityKind::Resource,
        1 => EntityKind::Record,
        2 => EntityKind::File,
        _ => return Err(format!("mig: unknown kind {v}")),
    })
}

fn class_of(c: Class) -> i64 {
    match c {
        Class::Resource => 0,
        Class::Record => 1,
        Class::Attachment => 2,
        Class::UnindexedMarkdown => 3,
    }
}

fn class_from(v: i64) -> SpillResult<Class> {
    Ok(match v {
        0 => Class::Resource,
        1 => Class::Record,
        2 => Class::Attachment,
        3 => Class::UnindexedMarkdown,
        _ => return Err(format!("mig: unknown class {v}")),
    })
}

fn int(v: &SqlValue) -> SpillResult<i64> {
    match v {
        SqlValue::Integer(i) => Ok(*i),
        _ => Err("mig: expected an integer".into()),
    }
}

fn text(v: &SqlValue) -> SpillResult<String> {
    match v {
        SqlValue::Text(s) => Ok(s.clone()),
        _ => Err("mig: expected text".into()),
    }
}

fn hash(v: &SqlValue) -> SpillResult<Hash> {
    match v {
        SqlValue::Blob(b) if b.len() == 32 => {
            let mut h = [0u8; 32];
            h.copy_from_slice(b);
            Ok(B32(h))
        }
        _ => Err("mig: expected a 32-byte hash".into()),
    }
}

fn size(v: &SqlValue) -> SpillResult<u64> {
    u64::try_from(int(v)?).map_err(|_| "mig: negative size".into())
}

fn meta_params(m: &Meta) -> SpillResult<Vec<SqlValue>> {
    Ok(vec![
        SqlValue::Integer(class_of(m.class)),
        SqlValue::Text(m.path.clone()),
        SqlValue::Blob(m.content.0.to_vec()),
        SqlValue::Integer(i64::try_from(m.size).map_err(|_| "mig: size")?),
    ])
}

fn meta_at(row: &[SqlValue], at: usize) -> SpillResult<Meta> {
    Ok(Meta {
        class: class_from(int(&row[at])?)?,
        path: text(&row[at + 1])?,
        content: hash(&row[at + 2])?,
        size: size(&row[at + 3])?,
    })
}

fn opt_meta_at(row: &[SqlValue], at: usize) -> SpillResult<Option<Meta>> {
    if matches!(row[at], SqlValue::Null) {
        return Ok(None);
    }
    meta_at(row, at).map(Some)
}

fn limit(n: usize) -> SqlValue {
    SqlValue::Integer(n.min(crate::budget::MAX_HYDRATE_RECORDS) as i64)
}

impl<I: IndexStorage> SqlSpill<I> {
    /// A spill over `index`, creating its tables if needed.
    pub fn open(index: I) -> SpillResult<Self> {
        let mut s = Self { index };
        s.write(SCHEMA.iter().map(|q| Stmt::new(*q, vec![])).collect())?;
        // Schema upgrade: never discard a saved checkpoint or placement.
        // Pre-base driver recovery clears and re-reads S0, computing its buckets.
        let columns = s.read("PRAGMA table_info(mig_place)", vec![])?;
        if !columns
            .rows()
            .any(|r| matches!(r.get(1), Some(SqlValue::Text(n)) if n == "bucket"))
        {
            s.write(vec![Stmt::new(
                "ALTER TABLE mig_place ADD COLUMN bucket INTEGER NOT NULL DEFAULT -1",
                vec![],
            )])?;
        }
        s.write(vec![Stmt::new(
            "CREATE INDEX IF NOT EXISTS mig_place_bucket ON mig_place (g, bucket, kind, id)",
            vec![],
        )])?;
        Ok(s)
    }

    /// The index back (for the host).
    pub fn into_inner(self) -> I {
        self.index
    }

    fn write(&mut self, stmts: Vec<Stmt>) -> SpillResult<()> {
        self.index
            .run(&Batch {
                mode: BatchMode::Transaction,
                stmts,
            })
            .map(|_| ())
            .map_err(|e| format!("mig: {:?}: {}", e.kind, e.detail))
    }

    fn read(&mut self, sql: &str, params: Vec<SqlValue>) -> SpillResult<StmtResult> {
        let mut r = self
            .index
            .run(&Batch {
                mode: BatchMode::Autocommit,
                stmts: vec![Stmt::new(sql, params)],
            })
            .map_err(|e| format!("mig: {:?}: {}", e.kind, e.detail))?;
        r.pop().ok_or_else(|| "mig: no result".into())
    }
}

impl<I: IndexStorage> Spill for SqlSpill<I> {
    fn load(&mut self) -> SpillResult<Option<Vec<u8>>> {
        let r = self.read("SELECT v FROM mig_checkpoint WHERE k = 0", vec![])?;
        Ok(match r.rows().next() {
            Some([SqlValue::Blob(b)]) => Some(b.clone()),
            Some(_) => return Err("mig: checkpoint is not a blob".into()),
            None => None,
        })
    }

    fn save(&mut self, checkpoint: &[u8]) -> SpillResult<()> {
        self.write(vec![Stmt::new(
            "INSERT INTO mig_checkpoint (k, v) VALUES (0, ?1) ON CONFLICT (k) DO UPDATE SET v = excluded.v",
            vec![SqlValue::Blob(checkpoint.to_vec())],
        )])
    }

    fn clear(&mut self, g: Generation) -> SpillResult<()> {
        let g = SqlValue::Integer(gen_of(g));
        self.write(vec![
            Stmt::new("DELETE FROM mig_claim WHERE g = ?1", vec![g.clone()]),
            Stmt::new("DELETE FROM mig_place WHERE g = ?1", vec![g.clone()]),
            Stmt::new("DELETE FROM mig_deferred WHERE g = ?1", vec![g]),
        ])
    }

    fn is_claimed(&mut self, g: Generation, key: &Hash) -> SpillResult<bool> {
        let r = self.read(
            "SELECT 1 FROM mig_claim WHERE g = ?1 AND h = ?2",
            vec![SqlValue::Integer(gen_of(g)), SqlValue::Blob(key.0.to_vec())],
        )?;
        Ok(r.row_count() > 0)
    }

    fn claim(&mut self, g: Generation, key: &Hash) -> SpillResult<()> {
        self.write(vec![Stmt::new(
            "INSERT OR IGNORE INTO mig_claim (g, h) VALUES (?1, ?2)",
            vec![SqlValue::Integer(gen_of(g)), SqlValue::Blob(key.0.to_vec())],
        )])
    }

    fn put_placement(&mut self, g: Generation, key: &Key, meta: &Meta) -> SpillResult<()> {
        let mut params = vec![
            SqlValue::Integer(gen_of(g)),
            SqlValue::Integer(kind_of(key.kind)),
            SqlValue::Text(key.id.clone()),
        ];
        params.extend(meta_params(meta)?);
        let bucket = if key.kind == EntityKind::Resource {
            -1
        } else {
            i64::from(super::bucket16(key).map_err(|e| e.to_string())?)
        };
        params.push(SqlValue::Integer(bucket));
        self.write(vec![Stmt::new(
            "INSERT INTO mig_place (g, kind, id, class, path, content, size, bucket) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) \
             ON CONFLICT (g, kind, id) DO UPDATE SET class = excluded.class, path = excluded.path, content = excluded.content, size = excluded.size, bucket = excluded.bucket",
            params,
        )])
    }

    fn push_deferred(
        &mut self,
        g: Generation,
        entity: &PathEntity,
        meta: &Meta,
    ) -> SpillResult<()> {
        let mut params = vec![
            SqlValue::Integer(gen_of(g)),
            SqlValue::Integer(kind_of(entity.kind)),
            SqlValue::Text(entity.id.clone().unwrap_or_default()),
            SqlValue::Text(entity.path.clone()),
        ];
        params.extend(meta_params(meta)?);
        self.write(vec![Stmt::new(
            "INSERT INTO mig_deferred (g, kind, eid, epath, class, path, content, size) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) \
             ON CONFLICT (g, kind, eid, epath) DO UPDATE SET class = excluded.class, path = excluded.path, content = excluded.content, size = excluded.size",
            params,
        )])
    }

    fn deferred_page(
        &mut self,
        g: Generation,
        after: Option<&PathEntity>,
        n: usize,
    ) -> SpillResult<Vec<(PathEntity, Meta)>> {
        let (k, id, path) = match after {
            Some(e) => (
                kind_of(e.kind),
                e.id.clone().unwrap_or_default(),
                e.path.clone(),
            ),
            None => (-1, String::new(), String::new()),
        };
        let r = self.read(
            "SELECT kind, eid, epath, class, path, content, size FROM mig_deferred \
             WHERE g = ?1 AND (kind, eid, epath) > (?2, ?3, ?4) ORDER BY kind, eid, epath LIMIT ?5",
            vec![
                SqlValue::Integer(gen_of(g)),
                SqlValue::Integer(k),
                SqlValue::Text(id),
                SqlValue::Text(path),
                limit(n),
            ],
        )?;
        r.rows()
            .map(|row| {
                let kind = kind_from(int(&row[0])?)?;
                let eid = text(&row[1])?;
                Ok((
                    PathEntity {
                        kind,
                        id: (kind != EntityKind::Resource).then_some(eid),
                        path: text(&row[2])?,
                    },
                    meta_at(row, 3)?,
                ))
            })
            .collect()
    }

    fn placements_page(
        &mut self,
        g: Generation,
        after: Option<&Key>,
        n: usize,
    ) -> SpillResult<Vec<(Key, Meta)>> {
        let (k, id) = after.map_or((-1, String::new()), |a| (kind_of(a.kind), a.id.clone()));
        let r = self.read(
            "SELECT kind, id, class, path, content, size FROM mig_place \
             WHERE g = ?1 AND (kind, id) > (?2, ?3) ORDER BY kind, id LIMIT ?4",
            vec![
                SqlValue::Integer(gen_of(g)),
                SqlValue::Integer(k),
                SqlValue::Text(id),
                limit(n),
            ],
        )?;
        r.rows()
            .map(|row| {
                Ok((
                    Key {
                        kind: kind_from(int(&row[0])?)?,
                        id: text(&row[1])?,
                    },
                    meta_at(row, 2)?,
                ))
            })
            .collect()
    }

    fn placements_in_bucket(
        &mut self,
        g: Generation,
        bits: u64,
        bucket: Option<u64>,
        after: Option<&Key>,
        n: usize,
    ) -> SpillResult<Vec<(Key, Meta)>> {
        let (lo, hi) = super::bucket_range(bits, bucket.unwrap_or(0)).map_err(|e| e.to_string())?;
        if n > crate::budget::MAX_HYDRATE_RECORDS {
            return Err("bucket page over row budget".into());
        }
        let (k, id) = after.map_or((-1, String::new()), |a| (kind_of(a.kind), a.id.clone()));
        let r = if bucket.is_none() {
            self.read(
                "SELECT kind, id, class, path, content, size FROM mig_place \
                 WHERE g = ?1 AND kind = 0 AND (kind, id) > (?2, ?3) ORDER BY kind, id LIMIT ?4",
                vec![
                    SqlValue::Integer(gen_of(g)),
                    SqlValue::Integer(k),
                    SqlValue::Text(id),
                    limit(n),
                ],
            )?
        } else {
            // An upgraded pre-base checkpoint must restart its source read.
            // Never silently omit rows lacking the newly computed bucket index.
            if self
                .read(
                    "SELECT 1 FROM mig_place WHERE g = ?1 AND kind <> 0 AND bucket = -1 LIMIT 1",
                    vec![SqlValue::Integer(gen_of(g))],
                )?
                .row_count()
                > 0
            {
                return Err("bucket index missing; restart the source read".into());
            }
            self.read(
                "SELECT kind, id, class, path, content, size FROM mig_place \
                 WHERE g = ?1 AND kind <> 0 AND bucket BETWEEN ?2 AND ?3 AND (kind, id) > (?4, ?5) \
                 ORDER BY kind, id LIMIT ?6",
                vec![
                    SqlValue::Integer(gen_of(g)),
                    SqlValue::Integer(i64::from(lo)),
                    SqlValue::Integer(i64::from(hi)),
                    SqlValue::Integer(k),
                    SqlValue::Text(id),
                    limit(n),
                ],
            )?
        };
        r.rows()
            .map(|row| {
                Ok((
                    Key {
                        kind: kind_from(int(&row[0])?)?,
                        id: text(&row[1])?,
                    },
                    meta_at(row, 2)?,
                ))
            })
            .collect()
    }

    fn diff_page(&mut self, after: Option<&Key>, n: usize) -> SpillResult<Vec<DiffRow>> {
        let (k, id) = after.map_or((-1, String::new()), |a| (kind_of(a.kind), a.id.clone()));
        let r = self.read(
            "SELECT k.kind, k.id, a.class, a.path, a.content, a.size, b.class, b.path, b.content, b.size \
             FROM (SELECT DISTINCT kind, id FROM mig_place WHERE g IN (0, 1) AND (kind, id) > (?1, ?2)) k \
             LEFT JOIN mig_place a ON a.g = 0 AND a.kind = k.kind AND a.id = k.id \
             LEFT JOIN mig_place b ON b.g = 1 AND b.kind = k.kind AND b.id = k.id \
             WHERE a.id IS NULL OR b.id IS NULL OR a.class <> b.class OR a.path <> b.path \
                OR a.content <> b.content OR a.size <> b.size \
             ORDER BY k.kind, k.id LIMIT ?3",
            vec![SqlValue::Integer(k), SqlValue::Text(id), limit(n)],
        )?;
        r.rows()
            .map(|row| {
                Ok((
                    Key {
                        kind: kind_from(int(&row[0])?)?,
                        id: text(&row[1])?,
                    },
                    opt_meta_at(row, 2)?,
                    opt_meta_at(row, 6)?,
                ))
            })
            .collect()
    }
}
