//! # mdbn-store-pg: the Postgres store
//!
//! **Responsibility.** The `Store` implementation for the hosted replica, where
//! rows are the documents: bulk paths, candidate pushdown over a derived index, and
//! running the unmodified replica service (Postgres backend). Tested against real
//! Postgres only (no in-memory substitute): set `MDBN_TEST_PG_URL`.
//!
//! **Layout.** One set of tables for every collection in the database ([`schema`]);
//! each [`PgStore`] is one collection's view, keyed by a surrogate `c`. A hosted
//! process runs many collections over a few connections: a [`PgConn`] is shared by
//! every store on one worker thread (stores are single-threaded, like the replica).
//!
//! **Rules.**
//! - Native only.
//! - **No global locks.** A commit locks its own collection's row and nothing else.
//! - **Fencing.** [`PgStore::open`] takes ownership of the collection by bumping its
//!   epoch; a commit from an older owner (a process that lost the collection during
//!   a deploy or rebalance) fails with [`is_fenced`] true and writes nothing.
//! - **Bulk paths.** A commit issues a fixed number of statements per table it
//!   touches, whatever the row count (`unnest` arrays, set-based deletes), so a
//!   snapshot install of 100k records is a handful of round trips per chunk.
//!
//! **Allowed dependencies.** Internal: `mdbn-core`, `mdbn-wire`, `mdbn-replica`.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

pub mod codec;
pub mod query;
pub mod schema;

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use std::ops::Range;
use std::rc::Rc;

use mdbn_replica::store::{
    AliasRow, BoundedResource, Candidate, CommitReport, ConflictRow, FileRow, Head, LocalReceipt,
    Page, PendingRow, RESOURCE_PATH_BYTES, RESOURCE_SOURCE_BYTES, ReceiptRow, RecordRow,
    ResourcePathPage, Store, StoreError, StoreResult, TombstoneRow, TransferRow, Tx,
};
use mdbn_wire::client::Hold;
use mdbn_wire::common::{Hash, Uuid, Value};
use mdbn_wire::intent::FileInclusion;
use postgres::types::ToSql;
use postgres::{Client, NoTls, Row, Statement, Transaction};

use crate::codec::{
    bytes, corrupt, enum_code, enum_from, from_bytes, hash, i64_of, last_bytes, last_from,
    local_code, local_from, local_receipt_bytes, local_receipt_from, meta_bytes, meta_from,
    transfer_bytes, transfer_from, u64_of, uuid, value_columns,
};
use crate::query::{Params, core_where};
use crate::schema::kind;

pub use crate::schema::migrate;

const FENCED: &str = "fenced: another process owns this collection";

/// Whether a store error means this store lost ownership of its collection.
pub fn is_fenced(e: &StoreError) -> bool {
    matches!(e, StoreError::Io(m) if m.starts_with(FENCED))
}

fn io(e: postgres::Error) -> StoreError {
    if let Some(db) = e.as_db_error() {
        // 53100 disk_full, 53200 out_of_memory, 54000 program_limit_exceeded.
        if db.code().code() == "53100" {
            return StoreError::Full;
        }
        return StoreError::Io(format!(
            "postgres: {} ({}): {}",
            db.severity(),
            db.code().code(),
            db.message()
        ));
    }
    StoreError::Io(format!("postgres: {e}"))
}

/// One Postgres connection with its prepared statements, shared by every store on
/// a worker thread.
pub struct PgConn {
    client: Client,
    stmts: HashMap<&'static str, Statement>,
}

/// A shared connection.
pub type SharedConn = Rc<RefCell<PgConn>>;

impl PgConn {
    /// Connect (no TLS: the hosted process reaches Postgres over a private network
    /// or a local socket; use [`PgConn::from_client`] for TLS).
    pub fn connect(url: &str) -> StoreResult<SharedConn> {
        let client = Client::connect(url, NoTls).map_err(io)?;
        Ok(PgConn::from_client(client))
    }

    /// Wrap an existing client.
    pub fn from_client(client: Client) -> SharedConn {
        Rc::new(RefCell::new(PgConn {
            client,
            stmts: HashMap::new(),
        }))
    }

    /// The raw client (maintenance, tests).
    pub fn client(&mut self) -> &mut Client {
        &mut self.client
    }

    fn query(&mut self, sql: &'static str, args: &[&(dyn ToSql + Sync)]) -> StoreResult<Vec<Row>> {
        let st = self.stmt(sql)?;
        self.client.query(&st, args).map_err(io)
    }

    fn query_opt(
        &mut self,
        sql: &'static str,
        args: &[&(dyn ToSql + Sync)],
    ) -> StoreResult<Option<Row>> {
        let st = self.stmt(sql)?;
        self.client.query_opt(&st, args).map_err(io)
    }

    fn stmt(&mut self, sql: &'static str) -> StoreResult<Statement> {
        if let Some(s) = self.stmts.get(sql) {
            return Ok(s.clone());
        }
        let s = self.client.prepare(sql).map_err(io)?;
        self.stmts.insert(sql, s.clone());
        Ok(s)
    }
}

/// Run a cached statement inside a transaction.
fn exec(
    t: &mut Transaction<'_>,
    stmts: &mut HashMap<&'static str, Statement>,
    sql: &'static str,
    args: &[&(dyn ToSql + Sync)],
) -> Result<u64, postgres::Error> {
    let st = match stmts.get(sql) {
        Some(s) => s.clone(),
        None => {
            let s = t.prepare(sql)?;
            stmts.insert(sql, s.clone());
            s
        }
    };
    t.execute(&st, args)
}

/// Collection-level information, without opening a store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CollectionInfo {
    /// Surrogate key.
    pub key: i64,
    /// Ownership epoch.
    pub epoch: i64,
    /// Applied head position.
    pub head_seq: u64,
}

/// One collection's replica state in Postgres.
pub struct PgStore {
    conn: SharedConn,
    collection: Uuid,
    c: i64,
    epoch: i64,
    commits: u64,
    secrets: RefCell<BTreeMap<String, Vec<u8>>>,
}

/// Meta keys whose values are secrets (the epoch keyring). They are kept in this
/// process's memory only and never written to Postgres (control-plane.md §4.2: the
/// hosted replica caches epoch keys in memory only). After a restart the replica
/// re-derives them from its key wraps in the log, using the hosted device's
/// KMS-unwrapped KEM key. A database dump therefore yields no collection key.
pub const SECRET_META: &[&str] = &[mdbn_replica::store::meta_keys::KEYRING];

impl std::fmt::Debug for PgStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PgStore")
            .field("collection", &self.collection)
            .field("c", &self.c)
            .field("epoch", &self.epoch)
            .finish_non_exhaustive()
    }
}

fn b(u: &Uuid) -> &[u8] {
    &u.0
}

fn ids(v: &[Uuid]) -> Vec<Vec<u8>> {
    v.iter().map(|u| u.0.to_vec()).collect()
}

fn lim(limit: u32) -> i64 {
    i64::from(limit)
}

fn after(p: &Page) -> Vec<u8> {
    p.after.map(|a| a.0.to_vec()).unwrap_or_default()
}

const RECORD_COLS: &str =
    "r.id, r.path, r.path_key, r.doc, r.revision, r.modified_seq, r.bucket, r.meta";

fn record_row(r: &Row) -> StoreResult<RecordRow> {
    let bucket: i32 = r.get(6);
    Ok(RecordRow {
        id: uuid(r.get(0))?,
        path: r.get(1),
        path_key: r.get(2),
        doc: r.get(3),
        revision: hash(r.get(4))?,
        modified_seq: u64_of(r.get(5))?,
        bucket: u16::try_from(bucket).map_err(|_| corrupt("bucket", bucket))?,
        meta: meta_from(r.get(7))?,
    })
}

fn file_row(r: &Row) -> StoreResult<FileRow> {
    let bucket: i32 = r.get(6);
    let (kind, content) = codec::file_payload_from(r.get(3))?;
    Ok(FileRow {
        kind,
        id: uuid(r.get(0))?,
        path: r.get(1),
        path_key: r.get(2),
        content,
        media: enum_from(r.get(4), "media")?,
        modified_seq: u64_of(r.get(5))?,
        bucket: u16::try_from(bucket).map_err(|_| corrupt("bucket", bucket))?,
        local: local_from(r.get(7))?,
    })
}

fn tomb_row(r: &Row) -> StoreResult<TombstoneRow> {
    Ok(TombstoneRow {
        id: uuid(r.get(0))?,
        kind: enum_from(r.get(1), "tombstone kind")?,
        path: r.get(2),
        path_key: r.get(3),
        last: last_from(r.get(4))?,
        seq: u64_of(r.get(5))?,
        time: r.get(6),
    })
}

fn receipt_row(r: &Row) -> StoreResult<ReceiptRow> {
    Ok(ReceiptRow {
        mutation: uuid(r.get(0))?,
        seq: u64_of(r.get(1))?,
        time: r.get(2),
    })
}

fn conflict_row(r: &Row) -> StoreResult<ConflictRow> {
    Ok(ConflictRow {
        mutation: uuid(r.get(0))?,
        seq: u64_of(r.get(1))?,
        conflict: from_bytes::<mdbn_wire::attachment_runtime_v1::Conflict>(r.get(2), "conflict")?,
    })
}

impl PgStore {
    /// Open a collection's store, creating it if needed, and take ownership of it:
    /// any earlier owner is fenced from then on.
    pub fn open(conn: SharedConn, collection: Uuid) -> StoreResult<PgStore> {
        let (c, epoch) = {
            let mut g = conn.borrow_mut();
            let row = g
                .query_opt(
                    "INSERT INTO rs_collections (id, epoch) VALUES ($1, 1) \
                     ON CONFLICT (id) DO UPDATE SET epoch = rs_collections.epoch + 1 \
                     RETURNING k, epoch",
                    &[&b(&collection)],
                )?
                .ok_or_else(|| StoreError::Io("open returned no row".into()))?;
            (row.get::<_, i64>(0), row.get::<_, i64>(1))
        };
        Ok(PgStore {
            conn,
            collection,
            c,
            epoch,
            commits: 0,
            secrets: RefCell::new(BTreeMap::new()),
        })
    }

    /// The collection's row, if the database has state for it.
    pub fn info(conn: &SharedConn, collection: &Uuid) -> StoreResult<Option<CollectionInfo>> {
        let row = conn.borrow_mut().query_opt(
            "SELECT k, epoch, head_seq FROM rs_collections WHERE id = $1",
            &[&b(collection)],
        )?;
        row.map(|r| {
            Ok(CollectionInfo {
                key: r.get(0),
                epoch: r.get(1),
                head_seq: u64_of(r.get(2))?,
            })
        })
        .transpose()
    }

    /// Delete everything stored for a collection (decommission, failed migration).
    /// Fences any owner.
    pub fn destroy(conn: &SharedConn, collection: &Uuid) -> StoreResult<()> {
        let mut g = conn.borrow_mut();
        let g = &mut *g;
        let mut t = g.client.transaction().map_err(io)?;
        let row = t
            .query_opt(
                "SELECT k FROM rs_collections WHERE id = $1 FOR UPDATE",
                &[&b(collection)],
            )
            .map_err(io)?;
        if let Some(row) = row {
            let c: i64 = row.get(0);
            for table in ALL_TABLES {
                t.execute(&format!("DELETE FROM {table} WHERE c = $1"), &[&c])
                    .map_err(io)?;
            }
            t.execute("DELETE FROM rs_collections WHERE k = $1", &[&c])
                .map_err(io)?;
        }
        t.commit().map_err(io)
    }

    /// The collection.
    pub fn collection(&self) -> Uuid {
        self.collection
    }

    /// The ownership epoch this store holds.
    pub fn epoch(&self) -> i64 {
        self.epoch
    }

    /// Successful commits through this handle.
    pub fn commits(&self) -> u64 {
        self.commits
    }

    /// The shared connection.
    pub fn conn(&self) -> &SharedConn {
        &self.conn
    }

    fn q(&self, sql: &'static str, args: &[&(dyn ToSql + Sync)]) -> StoreResult<Vec<Row>> {
        self.conn.borrow_mut().query(sql, args)
    }

    fn q1(&self, sql: &'static str, args: &[&(dyn ToSql + Sync)]) -> StoreResult<Option<Row>> {
        self.conn.borrow_mut().query_opt(sql, args)
    }

    /// Candidate records in ID order, and whether the SQL selected exactly the
    /// candidate's records (`Store::candidates` returns only the rows).
    pub fn candidates_exact(
        &self,
        q: &Candidate,
        page: Page,
    ) -> StoreResult<(Vec<RecordRow>, bool)> {
        let mut p = Params::new(self.c);
        let (filter, exact) = core_where(q, &mut p);
        Ok((self.select_records(&filter, p, page)?, exact))
    }

    fn select_records(
        &self,
        filter: &str,
        mut p: Params,
        page: Page,
    ) -> StoreResult<Vec<RecordRow>> {
        let a = p.bind(after(&page));
        let l = p.bind(lim(page.limit));
        let sql = format!(
            "SELECT {RECORD_COLS} FROM rs_records r WHERE r.c = $1 AND r.id > {a} AND {filter} \
             ORDER BY r.id LIMIT {l}"
        );
        let rows = self
            .conn
            .borrow_mut()
            .client
            .query(&sql, &p.refs())
            .map_err(io)?;
        rows.iter().map(record_row).collect()
    }

    fn apply(
        &self,
        t: &mut Transaction<'_>,
        st: &mut HashMap<&'static str, Statement>,
        tx: Tx,
    ) -> Result<(), TxError> {
        let c = &self.c;
        if tx.clear_confirmed {
            for table in CONFIRMED_TABLES {
                t.execute(&format!("DELETE FROM {table} WHERE c = $1"), &[c])?;
            }
            exec(
                t,
                st,
                "UPDATE rs_collections SET settings = NULL WHERE k = $1",
                &[c],
            )?;
        }
        if let Some(h) = tx.head {
            exec(
                t,
                st,
                "UPDATE rs_collections SET head_seq = $2, head_chain = $3 WHERE k = $1",
                &[c, &i64_of(h.seq)?, &h.chain.0.as_slice()],
            )?;
        }

        // ---- records: deletes first, then puts (last put of an ID wins) ----
        if !tx.records_del.is_empty() {
            let d = ids(&tx.records_del);
            exec(
                t,
                st,
                "DELETE FROM rs_records WHERE c = $1 AND id = ANY($2)",
                &[c, &d],
            )?;
            exec(
                t,
                st,
                "DELETE FROM rs_terms WHERE c = $1 AND id = ANY($2)",
                &[c, &d],
            )?;
        }
        if !tx.records_put.is_empty() {
            let mut last: BTreeMap<Uuid, RecordRow> = BTreeMap::new();
            for r in tx.records_put {
                last.insert(r.id, r);
            }
            put_records(t, st, *c, last.into_values().collect())?;
        }

        // ---- files ----
        if !tx.files_del.is_empty() {
            exec(
                t,
                st,
                "DELETE FROM rs_files WHERE c = $1 AND id = ANY($2)",
                &[c, &ids(&tx.files_del)],
            )?;
        }
        if !tx.files_put.is_empty() {
            let mut last: BTreeMap<Uuid, FileRow> = BTreeMap::new();
            for f in tx.files_put {
                last.insert(f.id, f);
            }
            let rows: Vec<FileRow> = last.into_values().collect();
            let mut cols = (
                vec![],
                vec![],
                vec![],
                vec![],
                vec![],
                vec![],
                vec![],
                vec![],
            );
            for f in &rows {
                cols.0.push(f.id.0.to_vec());
                cols.1.push(f.path.clone());
                cols.2.push(f.path_key.clone());
                cols.3.push(codec::file_payload_bytes(f.kind, &f.content)?);
                cols.4.push(enum_code(&f.media));
                cols.5.push(i64_of(f.modified_seq)?);
                cols.6.push(i32::from(f.bucket));
                cols.7.push(local_code(f.local));
            }
            exec(
                t,
                st,
                "INSERT INTO rs_files (c, id, path, path_key, blob, media, modified_seq, bucket, local) \
                 SELECT $1, * FROM unnest($2::bytea[], $3::text[], $4::text[], $5::bytea[], $6::int2[], $7::int8[], $8::int4[], $9::int2[]) \
                 ON CONFLICT (c, id) DO UPDATE SET path = EXCLUDED.path, path_key = EXCLUDED.path_key, \
                 blob = EXCLUDED.blob, media = EXCLUDED.media, modified_seq = EXCLUDED.modified_seq, \
                 bucket = EXCLUDED.bucket, local = EXCLUDED.local",
                &[
                    c, &cols.0, &cols.1, &cols.2, &cols.3, &cols.4, &cols.5, &cols.6, &cols.7,
                ],
            )?;
        }

        // ---- resources and settings ----
        if !tx.resources_del.is_empty() {
            exec(
                t,
                st,
                "DELETE FROM rs_resources WHERE c = $1 AND path = ANY($2)",
                &[c, &tx.resources_del],
            )?;
        }
        if !tx.resources_put.is_empty() {
            let mut last: BTreeMap<String, String> = BTreeMap::new();
            for (p, d) in tx.resources_put {
                last.insert(p, d);
            }
            let (ps, ds): (Vec<String>, Vec<String>) = last.into_iter().unzip();
            exec(
                t,
                st,
                "INSERT INTO rs_resources (c, path, doc) SELECT $1, * FROM unnest($2::text[], $3::text[]) \
                 ON CONFLICT (c, path) DO UPDATE SET doc = EXCLUDED.doc",
                &[c, &ps, &ds],
            )?;
        }
        if let Some(s) = &tx.settings {
            exec(
                t,
                st,
                "UPDATE rs_collections SET settings = $2 WHERE k = $1",
                &[c, &bytes(s)?],
            )?;
        }

        // ---- tombstones ----
        if !tx.tombstones_del.is_empty() {
            exec(
                t,
                st,
                "DELETE FROM rs_tombstones WHERE c = $1 AND id = ANY($2)",
                &[c, &ids(&tx.tombstones_del)],
            )?;
        }
        if !tx.tombstones_put.is_empty() {
            let mut last: BTreeMap<Uuid, TombstoneRow> = BTreeMap::new();
            for r in tx.tombstones_put {
                last.insert(r.id, r);
            }
            let mut cols = (vec![], vec![], vec![], vec![], vec![], vec![], vec![]);
            for r in last.values() {
                cols.0.push(r.id.0.to_vec());
                cols.1.push(enum_code(&r.kind));
                cols.2.push(r.path.clone());
                cols.3.push(r.path_key.clone());
                cols.4.push(last_bytes(&r.last)?);
                cols.5.push(i64_of(r.seq)?);
                cols.6.push(r.time);
            }
            exec(
                t,
                st,
                "INSERT INTO rs_tombstones (c, id, kind, path, path_key, last, seq, time) \
                 SELECT $1, * FROM unnest($2::bytea[], $3::int2[], $4::text[], $5::text[], $6::bytea[], $7::int8[], $8::int8[]) \
                 ON CONFLICT (c, id) DO UPDATE SET kind = EXCLUDED.kind, path = EXCLUDED.path, \
                 path_key = EXCLUDED.path_key, last = EXCLUDED.last, seq = EXCLUDED.seq, time = EXCLUDED.time",
                &[
                    c, &cols.0, &cols.1, &cols.2, &cols.3, &cols.4, &cols.5, &cols.6,
                ],
            )?;
        }

        // ---- aliases ----
        if !tx.aliases_put.is_empty() {
            let mut last: BTreeMap<String, AliasRow> = BTreeMap::new();
            for a in tx.aliases_put {
                last.insert(a.path_key.clone(), a);
            }
            let mut cols = (vec![], vec![], vec![]);
            for a in last.values() {
                cols.0.push(a.path_key.clone());
                cols.1.push(a.path.clone());
                cols.2.push(a.record.0.to_vec());
            }
            exec(
                t,
                st,
                "INSERT INTO rs_aliases (c, path_key, path, record) SELECT $1, * FROM unnest($2::text[], $3::text[], $4::bytea[]) \
                 ON CONFLICT (c, path_key) DO UPDATE SET path = EXCLUDED.path, record = EXCLUDED.record",
                &[c, &cols.0, &cols.1, &cols.2],
            )?;
        }

        // ---- conflicts ----
        if !tx.conflicts_del.is_empty() {
            let (ms, cs): (Vec<Vec<u8>>, Vec<Vec<u8>>) = tx
                .conflicts_del
                .iter()
                .map(|(m, i)| (m.0.to_vec(), i.0.to_vec()))
                .unzip();
            exec(
                t,
                st,
                "DELETE FROM rs_conflicts x USING unnest($2::bytea[], $3::bytea[]) AS d(m, i) \
                 WHERE x.c = $1 AND x.mutation = d.m AND x.cid = d.i",
                &[c, &ms, &cs],
            )?;
        }
        if !tx.conflicts_put.is_empty() {
            let mut last: BTreeMap<(Uuid, Uuid), ConflictRow> = BTreeMap::new();
            for r in tx.conflicts_put {
                last.insert((r.mutation, r.conflict.id), r);
            }
            let mut cols = (vec![], vec![], vec![], vec![]);
            for r in last.values() {
                cols.0.push(r.mutation.0.to_vec());
                cols.1.push(r.conflict.id.0.to_vec());
                cols.2.push(i64_of(r.seq)?);
                cols.3.push(bytes(&r.conflict)?);
            }
            exec(
                t,
                st,
                "INSERT INTO rs_conflicts (c, mutation, cid, seq, conflict) \
                 SELECT $1, * FROM unnest($2::bytea[], $3::bytea[], $4::int8[], $5::bytea[]) \
                 ON CONFLICT (c, mutation, cid) DO UPDATE SET seq = EXCLUDED.seq, conflict = EXCLUDED.conflict",
                &[c, &cols.0, &cols.1, &cols.2, &cols.3],
            )?;
        }

        // ---- receipts and pruning ----
        if !tx.receipts_put.is_empty() {
            let mut last: BTreeMap<Uuid, ReceiptRow> = BTreeMap::new();
            for r in tx.receipts_put {
                last.insert(r.mutation, r);
            }
            let mut cols = (vec![], vec![], vec![]);
            for r in last.values() {
                cols.0.push(r.mutation.0.to_vec());
                cols.1.push(i64_of(r.seq)?);
                cols.2.push(r.time);
            }
            exec(
                t,
                st,
                "INSERT INTO rs_receipts (c, mutation, seq, time) SELECT $1, * FROM unnest($2::bytea[], $3::int8[], $4::int8[]) \
                 ON CONFLICT (c, mutation) DO UPDATE SET seq = EXCLUDED.seq, time = EXCLUDED.time",
                &[c, &cols.0, &cols.1, &cols.2],
            )?;
        }
        if let Some(p) = tx.prune {
            let seq = i64_of(p.seq_floor)?;
            exec(
                t,
                st,
                "DELETE FROM rs_receipts WHERE c = $1 AND seq < $2 AND time < $3",
                &[c, &seq, &p.time_floor],
            )?;
            exec(
                t,
                st,
                "DELETE FROM rs_tombstones WHERE c = $1 AND seq < $2 AND time < $3",
                &[c, &seq, &p.time_floor],
            )?;
        }

        // ---- pending queue: deletes, then puts (replace by mutation or order) ----
        if !tx.pending_del.is_empty() {
            exec(
                t,
                st,
                "DELETE FROM rs_pending WHERE c = $1 AND mutation = ANY($2)",
                &[c, &ids(&tx.pending_del)],
            )?;
        }
        if !tx.pending_put.is_empty() {
            // Apply the puts in order in memory, so the rows written are exactly
            // what sequential replacement would leave.
            let mut by_order: BTreeMap<u64, PendingRow> = BTreeMap::new();
            let mut by_mutation: BTreeMap<Uuid, u64> = BTreeMap::new();
            let mut muts: Vec<Vec<u8>> = vec![];
            let mut ords: Vec<i64> = vec![];
            for p in tx.pending_put {
                muts.push(p.mutation.id.0.to_vec());
                ords.push(i64_of(p.order)?);
                if let Some(o) = by_mutation.remove(&p.mutation.id) {
                    by_order.remove(&o);
                }
                if let Some(old) = by_order.remove(&p.order) {
                    by_mutation.remove(&old.mutation.id);
                }
                by_mutation.insert(p.mutation.id, p.order);
                by_order.insert(p.order, p);
            }
            exec(
                t,
                st,
                "DELETE FROM rs_pending WHERE c = $1 AND (mutation = ANY($2) OR ord = ANY($3))",
                &[c, &muts, &ords],
            )?;
            let mut cols = (vec![], vec![], vec![]);
            for (o, p) in &by_order {
                cols.0.push(i64_of(*o)?);
                cols.1.push(p.mutation.id.0.to_vec());
                cols.2.push(p.to_bytes());
            }
            exec(
                t,
                st,
                "INSERT INTO rs_pending (c, ord, mutation, row) SELECT $1, * FROM unnest($2::int8[], $3::bytea[], $4::bytea[])",
                &[c, &cols.0, &cols.1, &cols.2],
            )?;
        }

        // ---- local receipts, holds, meta ----
        if !tx.local_receipts_put.is_empty() {
            let mut last: BTreeMap<Uuid, LocalReceipt> = BTreeMap::new();
            for r in tx.local_receipts_put {
                last.insert(r.mutation, r);
            }
            let mut cols = (vec![], vec![], vec![]);
            for r in last.values() {
                cols.0.push(r.mutation.0.to_vec());
                cols.1.push(r.resolved_at);
                cols.2.push(local_receipt_bytes(r)?);
            }
            exec(
                t,
                st,
                "INSERT INTO rs_local_receipts (c, mutation, resolved_at, row) SELECT $1, * FROM unnest($2::bytea[], $3::int8[], $4::bytea[]) \
                 ON CONFLICT (c, mutation) DO UPDATE SET resolved_at = EXCLUDED.resolved_at, row = EXCLUDED.row",
                &[c, &cols.0, &cols.1, &cols.2],
            )?;
        }
        if let Some(at) = tx.local_receipts_prune {
            exec(
                t,
                st,
                "DELETE FROM rs_local_receipts WHERE c = $1 AND resolved_at < $2",
                &[c, &at],
            )?;
        }
        if !tx.holds_del.is_empty() {
            exec(
                t,
                st,
                "DELETE FROM rs_holds WHERE c = $1 AND id = ANY($2)",
                &[c, &ids(&tx.holds_del)],
            )?;
        }
        if !tx.holds_put.is_empty() {
            let mut last: BTreeMap<Uuid, Hold> = BTreeMap::new();
            for h in tx.holds_put {
                last.insert(h.id, h);
            }
            let mut cols = (vec![], vec![]);
            for h in last.values() {
                cols.0.push(h.id.0.to_vec());
                cols.1.push(bytes(h)?);
            }
            exec(
                t,
                st,
                "INSERT INTO rs_holds (c, id, hold) SELECT $1, * FROM unnest($2::bytea[], $3::bytea[]) \
                 ON CONFLICT (c, id) DO UPDATE SET hold = EXCLUDED.hold",
                &[c, &cols.0, &cols.1],
            )?;
        }
        for (k, v) in &tx.meta {
            if SECRET_META.contains(&k.as_str()) {
                continue; // memory only; applied after the commit succeeds
            }
            match v {
                Some(v) => exec(
                    t,
                    st,
                    "INSERT INTO rs_meta (c, key, v) VALUES ($1, $2, $3) ON CONFLICT (c, key) DO UPDATE SET v = EXCLUDED.v",
                    &[c, k, v],
                )?,
                None => exec(
                    t,
                    st,
                    "DELETE FROM rs_meta WHERE c = $1 AND key = $2",
                    &[c, k],
                )?,
            };
        }

        // ---- transfers, chunks, blobs ----
        if !tx.transfers_put.is_empty() {
            let mut last: BTreeMap<Uuid, TransferRow> = BTreeMap::new();
            for r in tx.transfers_put {
                last.insert(r.id, r);
            }
            let mut cols = (vec![], vec![]);
            for r in last.values() {
                cols.0.push(r.id.0.to_vec());
                cols.1.push(transfer_bytes(r)?);
            }
            exec(
                t,
                st,
                "INSERT INTO rs_transfers (c, id, row) SELECT $1, * FROM unnest($2::bytea[], $3::bytea[]) \
                 ON CONFLICT (c, id) DO UPDATE SET row = EXCLUDED.row",
                &[c, &cols.0, &cols.1],
            )?;
        }
        for (id, idx, data) in &tx.transfer_chunks {
            exec(
                t,
                st,
                "INSERT INTO rs_chunks (c, id, idx, bytes) VALUES ($1, $2, $3, $4) \
                 ON CONFLICT (c, id, idx) DO UPDATE SET bytes = EXCLUDED.bytes",
                &[c, &b(id), &i64_of(*idx)?, data],
            )?;
        }
        if !tx.transfers_del.is_empty() {
            let d = ids(&tx.transfers_del);
            exec(
                t,
                st,
                "DELETE FROM rs_transfers WHERE c = $1 AND id = ANY($2)",
                &[c, &d],
            )?;
            exec(
                t,
                st,
                "DELETE FROM rs_chunks WHERE c = $1 AND id = ANY($2)",
                &[c, &d],
            )?;
        }
        for (digest, off, data) in &tx.blob_parts {
            exec(
                t,
                st,
                "INSERT INTO rs_blob_parts (c, digest, off, bytes) VALUES ($1, $2, $3, $4) \
                 ON CONFLICT (c, digest, off) DO UPDATE SET bytes = EXCLUDED.bytes",
                &[c, &digest.0.as_slice(), &i64_of(*off)?, data],
            )?;
        }
        if !tx.blobs_del.is_empty() {
            let d: Vec<Vec<u8>> = tx.blobs_del.iter().map(|h| h.0.to_vec()).collect();
            exec(
                t,
                st,
                "DELETE FROM rs_blob_parts WHERE c = $1 AND digest = ANY($2)",
                &[c, &d],
            )?;
        }
        // `ack_observations` and `publish` concern file-backed stores only.
        Ok(())
    }
}

/// Every per-collection table.
const ALL_TABLES: &[&str] = &[
    "rs_records",
    "rs_terms",
    "rs_files",
    "rs_resources",
    "rs_tombstones",
    "rs_aliases",
    "rs_conflicts",
    "rs_receipts",
    "rs_pending",
    "rs_local_receipts",
    "rs_holds",
    "rs_meta",
    "rs_transfers",
    "rs_chunks",
    "rs_blob_parts",
];

/// Confirmed replicated state, dropped by `Tx::clear_confirmed`.
const CONFIRMED_TABLES: &[&str] = &[
    "rs_records",
    "rs_terms",
    "rs_files",
    "rs_resources",
    "rs_tombstones",
    "rs_aliases",
    "rs_conflicts",
    "rs_receipts",
];

/// A commit failure: Postgres, or a row that can't be encoded.
enum TxError {
    Pg(postgres::Error),
    Store(StoreError),
}

impl From<postgres::Error> for TxError {
    fn from(e: postgres::Error) -> TxError {
        TxError::Pg(e)
    }
}

impl From<StoreError> for TxError {
    fn from(e: StoreError) -> TxError {
        TxError::Store(e)
    }
}

impl From<TxError> for StoreError {
    fn from(e: TxError) -> StoreError {
        match e {
            TxError::Pg(e) => io(e),
            TxError::Store(e) => e,
        }
    }
}

/// The derived index terms of one record.
fn terms(r: &RecordRow, out: &mut TermCols) {
    let m = &r.meta;
    let id = r.id.0.to_vec();
    let mut push = |k: i16, k1: &str, k2: Option<String>, v: Option<Vec<u8>>, num: Option<f64>| {
        out.kind.push(k);
        out.k1.push(k1.to_string());
        out.k2.push(k2);
        out.v.push(v);
        out.num.push(num);
        out.id.push(id.clone());
    };
    for l in &m.links {
        push(kind::LINK, l, None, None, None);
    }
    for (f, vk) in &m.unique {
        push(kind::UNIQUE, f, Some(vk.clone()), None, None);
    }
    for t in &m.types {
        push(kind::TYPE, t, None, None, None);
    }
    for t in &m.tags {
        push(kind::TAG, t, None, None, None);
    }
    for (k, v) in &m.effective.0 {
        let (bytes, txt, num) = value_columns(v);
        push(kind::FIELD, k, txt, bytes, num);
        if let Value::List(items) = v {
            for it in items {
                let (bytes, txt, num) = value_columns(it);
                if bytes.is_some() {
                    push(kind::ELEM, k, txt, bytes, num);
                }
            }
        }
    }
}

#[derive(Default)]
struct TermCols {
    kind: Vec<i16>,
    k1: Vec<String>,
    k2: Vec<Option<String>>,
    v: Vec<Option<Vec<u8>>>,
    num: Vec<Option<f64>>,
    id: Vec<Vec<u8>>,
}

/// Rows per statement in bulk writes: bounds statement size and memory.
const CHUNK: usize = 5_000;

fn put_records(
    t: &mut Transaction<'_>,
    st: &mut HashMap<&'static str, Statement>,
    c: i64,
    rows: Vec<RecordRow>,
) -> Result<(), TxError> {
    for chunk in rows.chunks(CHUNK) {
        let mut cols = (
            vec![],
            vec![],
            vec![],
            vec![],
            vec![],
            vec![],
            vec![],
            vec![],
        );
        let mut tc = TermCols::default();
        for r in chunk {
            cols.0.push(r.id.0.to_vec());
            cols.1.push(r.path.clone());
            cols.2.push(r.path_key.clone());
            cols.3.push(r.doc.clone());
            cols.4.push(r.revision.0.to_vec());
            cols.5.push(i64_of(r.modified_seq)?);
            cols.6.push(i32::from(r.bucket));
            cols.7.push(meta_bytes(&r.meta)?);
            terms(r, &mut tc);
        }
        exec(
            t,
            st,
            "DELETE FROM rs_terms WHERE c = $1 AND id = ANY($2)",
            &[&c, &cols.0],
        )?;
        exec(
            t,
            st,
            "INSERT INTO rs_records (c, id, path, path_key, doc, revision, modified_seq, bucket, meta) \
             SELECT $1, * FROM unnest($2::bytea[], $3::text[], $4::text[], $5::text[], $6::bytea[], $7::int8[], $8::int4[], $9::bytea[]) \
             ON CONFLICT (c, id) DO UPDATE SET path = EXCLUDED.path, path_key = EXCLUDED.path_key, \
             doc = EXCLUDED.doc, revision = EXCLUDED.revision, modified_seq = EXCLUDED.modified_seq, \
             bucket = EXCLUDED.bucket, meta = EXCLUDED.meta",
            &[
                &c, &cols.0, &cols.1, &cols.2, &cols.3, &cols.4, &cols.5, &cols.6, &cols.7,
            ],
        )?;
        if !tc.id.is_empty() {
            exec(
                t,
                st,
                "INSERT INTO rs_terms (c, kind, k1, k2, v, num, id) \
                 SELECT $1, * FROM unnest($2::int2[], $3::text[], $4::text[], $5::bytea[], $6::float8[], $7::bytea[])",
                &[&c, &tc.kind, &tc.k1, &tc.k2, &tc.v, &tc.num, &tc.id],
            )?;
        }
    }
    Ok(())
}

impl Store for PgStore {
    fn head(&self) -> StoreResult<Head> {
        let r = self
            .q1(
                "SELECT head_seq, head_chain FROM rs_collections WHERE k = $1",
                &[&self.c],
            )?
            .ok_or_else(|| corrupt("collection", "row missing"))?;
        Ok(Head {
            seq: u64_of(r.get(0))?,
            chain: hash(r.get(1))?,
        })
    }

    fn record(&self, id: &Uuid) -> StoreResult<Option<RecordRow>> {
        self.q1(
            "SELECT r.id, r.path, r.path_key, r.doc, r.revision, r.modified_seq, r.bucket, r.meta \
             FROM rs_records r WHERE r.c = $1 AND r.id = $2",
            &[&self.c, &b(id)],
        )?
        .as_ref()
        .map(record_row)
        .transpose()
    }

    fn record_at(&self, path_key: &str) -> StoreResult<Option<Uuid>> {
        self.q1(
            "SELECT id FROM rs_records WHERE c = $1 AND path_key = $2 ORDER BY id LIMIT 1",
            &[&self.c, &path_key],
        )?
        .map(|r| uuid(r.get(0)))
        .transpose()
    }

    fn records(&self, page: Page) -> StoreResult<Vec<RecordRow>> {
        self.q(
            "SELECT r.id, r.path, r.path_key, r.doc, r.revision, r.modified_seq, r.bucket, r.meta \
             FROM rs_records r WHERE r.c = $1 AND r.id > $2 ORDER BY r.id LIMIT $3",
            &[&self.c, &after(&page), &lim(page.limit)],
        )?
        .iter()
        .map(record_row)
        .collect()
    }

    fn records_in_buckets(&self, range: Range<u32>, page: Page) -> StoreResult<Vec<RecordRow>> {
        let (lo, hi) = bucket_bounds(&range);
        self.q(
            "SELECT r.id, r.path, r.path_key, r.doc, r.revision, r.modified_seq, r.bucket, r.meta \
             FROM rs_records r WHERE r.c = $1 AND r.bucket >= $2 AND r.bucket < $3 AND r.id > $4 \
             ORDER BY r.id LIMIT $5",
            &[&self.c, &lo, &hi, &after(&page), &lim(page.limit)],
        )?
        .iter()
        .map(record_row)
        .collect()
    }

    fn record_count(&self) -> StoreResult<u64> {
        let r = self.q1("SELECT count(*) FROM rs_records WHERE c = $1", &[&self.c])?;
        u64_of(r.map_or(0, |r| r.get(0)))
    }

    fn file(&self, id: &Uuid) -> StoreResult<Option<FileRow>> {
        self.q1(
            "SELECT id, path, path_key, blob, media, modified_seq, bucket, local FROM rs_files \
             WHERE c = $1 AND id = $2",
            &[&self.c, &b(id)],
        )?
        .as_ref()
        .map(file_row)
        .transpose()
    }

    fn file_at(&self, path_key: &str) -> StoreResult<Option<Uuid>> {
        self.q1(
            "SELECT id FROM rs_files WHERE c = $1 AND path_key = $2 ORDER BY id LIMIT 1",
            &[&self.c, &path_key],
        )?
        .map(|r| uuid(r.get(0)))
        .transpose()
    }

    fn files(&self, page: Page) -> StoreResult<Vec<FileRow>> {
        self.q(
            "SELECT id, path, path_key, blob, media, modified_seq, bucket, local FROM rs_files \
             WHERE c = $1 AND id > $2 ORDER BY id LIMIT $3",
            &[&self.c, &after(&page), &lim(page.limit)],
        )?
        .iter()
        .map(file_row)
        .collect()
    }

    fn files_in_buckets(&self, range: Range<u32>, page: Page) -> StoreResult<Vec<FileRow>> {
        let (lo, hi) = bucket_bounds(&range);
        self.q(
            "SELECT id, path, path_key, blob, media, modified_seq, bucket, local FROM rs_files \
             WHERE c = $1 AND bucket >= $2 AND bucket < $3 AND id > $4 ORDER BY id LIMIT $5",
            &[&self.c, &lo, &hi, &after(&page), &lim(page.limit)],
        )?
        .iter()
        .map(file_row)
        .collect()
    }

    fn resource(&self, path: &str) -> StoreResult<Option<String>> {
        Ok(self
            .q1(
                "SELECT doc FROM rs_resources WHERE c = $1 AND path = $2",
                &[&self.c, &path],
            )?
            .map(|r| r.get(0)))
    }

    fn resource_paths_page(&self, page: ResourcePathPage<'_>) -> StoreResult<Vec<String>> {
        page.validate()?;
        let corrupt = |what| crate::codec::corrupt(what, "invalid bounded resource result");
        let rows = self
            .q(
                "SELECT CASE WHEN octet_length(path) <= 4096 THEN path ELSE NULL END, \
             octet_length(path) FROM rs_resources WHERE c = $1 \
             AND ($2::text IS NULL OR path COLLATE \"C\" > $2 COLLATE \"C\") \
             AND ($3::text IS NULL OR left(path, char_length($3)) = $3) \
             ORDER BY path COLLATE \"C\" LIMIT $4",
                &[&self.c, &page.after, &page.prefix, &i64::from(page.limit)],
            )
            .map_err(|_| StoreError::Io("bounded resource query unavailable".into()))?;
        if rows.len() > page.limit as usize {
            return Err(corrupt("bounded resource path count"));
        }
        rows.iter()
            .map(|row| {
                if row.len() != 2 {
                    return Err(corrupt("bounded resource path shape"));
                }
                let size: i32 = row
                    .try_get(1)
                    .map_err(|_| corrupt("bounded resource path size"))?;
                if size > RESOURCE_PATH_BYTES as i32 {
                    return Err(StoreError::Full);
                }
                let path: Option<&str> = row
                    .try_get(0)
                    .map_err(|_| corrupt("bounded resource path"))?;
                let path = path.ok_or_else(|| corrupt("bounded resource path"))?;
                if size < 0 || path.len() > RESOURCE_PATH_BYTES || path.len() as i32 != size {
                    return Err(corrupt("bounded resource path size"));
                }
                Ok(path.to_owned())
            })
            .collect()
    }
    fn resource_bounded(
        &self,
        path: &str,
        copy_limit: usize,
    ) -> StoreResult<Option<BoundedResource>> {
        let corrupt = |what| crate::codec::corrupt(what, "invalid bounded resource result");
        if path.len() > RESOURCE_PATH_BYTES || copy_limit > RESOURCE_SOURCE_BYTES {
            return Err(StoreError::Full);
        }
        let rows = self.q(
            "SELECT octet_length(doc), CASE WHEN octet_length(doc) <= $3 THEN doc ELSE NULL END \
             FROM rs_resources WHERE c = $1 AND path = $2 LIMIT 2",
            &[&self.c, &path, &(copy_limit as i32)],
        ).map_err(|_| StoreError::Io("bounded resource query unavailable".into()))?;
        if rows.len() > 1 {
            return Err(corrupt("bounded resource duplicate"));
        }
        rows.first()
            .map(|row| {
                if row.len() != 2 {
                    return Err(corrupt("bounded resource source shape"));
                }
                let size: i32 = row
                    .try_get(0)
                    .map_err(|_| corrupt("bounded resource source size"))?;
                let text: Option<&str> = row
                    .try_get(1)
                    .map_err(|_| corrupt("bounded resource source"))?;
                match (size, text) {
                    (size, None) if size > copy_limit as i32 => Ok(BoundedResource {
                        size: size as u64,
                        text: None,
                    }),
                    (size, Some(text))
                        if size >= 0 && text.len() <= copy_limit && text.len() as i32 == size =>
                    {
                        Ok(BoundedResource {
                            size: size as u64,
                            text: Some(text.to_owned()),
                        })
                    }
                    _ => Err(corrupt("bounded resource source size")),
                }
            })
            .transpose()
    }
    fn resources(&self) -> StoreResult<Vec<(String, String)>> {
        Ok(self
            .q(
                "SELECT path, doc FROM rs_resources WHERE c = $1 ORDER BY path",
                &[&self.c],
            )?
            .iter()
            .map(|r| (r.get(0), r.get(1)))
            .collect())
    }

    fn settings(&self) -> StoreResult<Option<FileInclusion>> {
        let r = self.q1(
            "SELECT settings FROM rs_collections WHERE k = $1",
            &[&self.c],
        )?;
        match r.and_then(|r| r.get::<_, Option<Vec<u8>>>(0)) {
            Some(b) => Ok(Some(from_bytes(&b, "settings")?)),
            None => Ok(None),
        }
    }

    fn tombstone(&self, id: &Uuid) -> StoreResult<Option<TombstoneRow>> {
        self.q1(
            "SELECT id, kind, path, path_key, last, seq, time FROM rs_tombstones WHERE c = $1 AND id = $2",
            &[&self.c, &b(id)],
        )?
        .as_ref()
        .map(tomb_row)
        .transpose()
    }

    fn tombstones_at(&self, path_key: &str) -> StoreResult<Vec<TombstoneRow>> {
        self.q(
            "SELECT id, kind, path, path_key, last, seq, time FROM rs_tombstones \
             WHERE c = $1 AND path_key = $2 ORDER BY id",
            &[&self.c, &path_key],
        )?
        .iter()
        .map(tomb_row)
        .collect()
    }

    fn tombstones(&self, page: Page) -> StoreResult<Vec<TombstoneRow>> {
        self.q(
            "SELECT id, kind, path, path_key, last, seq, time FROM rs_tombstones \
             WHERE c = $1 AND id > $2 ORDER BY id LIMIT $3",
            &[&self.c, &after(&page), &lim(page.limit)],
        )?
        .iter()
        .map(tomb_row)
        .collect()
    }

    fn alias(&self, path_key: &str) -> StoreResult<Option<Uuid>> {
        self.q1(
            "SELECT record FROM rs_aliases WHERE c = $1 AND path_key = $2",
            &[&self.c, &path_key],
        )?
        .map(|r| uuid(r.get(0)))
        .transpose()
    }

    fn aliases(&self) -> StoreResult<Vec<AliasRow>> {
        self.q(
            "SELECT path, path_key, record FROM rs_aliases WHERE c = $1 ORDER BY path, path_key",
            &[&self.c],
        )?
        .iter()
        .map(|r| {
            Ok(AliasRow {
                path: r.get(0),
                path_key: r.get(1),
                record: uuid(r.get(2))?,
            })
        })
        .collect()
    }

    fn conflicts(&self, of: Option<&Uuid>) -> StoreResult<Vec<ConflictRow>> {
        let rows = match of {
            Some(id) => self.q(
                "SELECT mutation, seq, conflict FROM rs_conflicts WHERE c = $1 AND cid = $2 \
                 ORDER BY mutation, cid",
                &[&self.c, &b(id)],
            )?,
            None => self.q(
                "SELECT mutation, seq, conflict FROM rs_conflicts WHERE c = $1 ORDER BY mutation, cid",
                &[&self.c],
            )?,
        };
        rows.iter().map(conflict_row).collect()
    }

    fn conflict_count(&self) -> StoreResult<u64> {
        let r = self.q1("SELECT count(*) FROM rs_conflicts WHERE c = $1", &[&self.c])?;
        u64_of(r.map_or(0, |r| r.get(0)))
    }

    fn receipt(&self, mutation: &Uuid) -> StoreResult<Option<ReceiptRow>> {
        self.q1(
            "SELECT mutation, seq, time FROM rs_receipts WHERE c = $1 AND mutation = $2",
            &[&self.c, &b(mutation)],
        )?
        .as_ref()
        .map(receipt_row)
        .transpose()
    }

    fn receipts(&self, after_id: Option<Uuid>, limit: u32) -> StoreResult<Vec<ReceiptRow>> {
        let a = after_id.map(|a| a.0.to_vec()).unwrap_or_default();
        self.q(
            "SELECT mutation, seq, time FROM rs_receipts WHERE c = $1 AND mutation > $2 \
             ORDER BY mutation LIMIT $3",
            &[&self.c, &a, &lim(limit)],
        )?
        .iter()
        .map(receipt_row)
        .collect()
    }

    fn referrers(&self, target_keys: &[String]) -> StoreResult<Vec<Uuid>> {
        self.q(
            "SELECT DISTINCT id FROM rs_terms WHERE c = $1 AND kind = 1 AND k1 = ANY($2) ORDER BY id",
            &[&self.c, &target_keys],
        )?
        .iter()
        .map(|r| uuid(r.get(0)))
        .collect()
    }

    fn unique_holders(&self, field: &str, value_key: &str) -> StoreResult<Vec<Uuid>> {
        self.q(
            "SELECT DISTINCT id FROM rs_terms WHERE c = $1 AND kind = 2 AND k1 = $2 AND k2 = $3 ORDER BY id",
            &[&self.c, &field, &value_key],
        )?
        .iter()
        .map(|r| uuid(r.get(0)))
        .collect()
    }

    fn candidates(&self, q: &Candidate, page: Page) -> StoreResult<Vec<RecordRow>> {
        Ok(self.candidates_exact(q, page)?.0)
    }

    fn pending(&self, after_order: Option<u64>, limit: u32) -> StoreResult<Vec<PendingRow>> {
        let a = match after_order {
            Some(o) => i64_of(o)?,
            None => -1,
        };
        self.q(
            "SELECT row FROM rs_pending WHERE c = $1 AND ord > $2 ORDER BY ord LIMIT $3",
            &[&self.c, &a, &lim(limit)],
        )?
        .iter()
        .map(|r| PendingRow::from_bytes(r.get(0)).map_err(|e| corrupt("pending", format!("{e:?}"))))
        .collect()
    }

    fn pending_get(&self, mutation: &Uuid) -> StoreResult<Option<PendingRow>> {
        self.q1(
            "SELECT row FROM rs_pending WHERE c = $1 AND mutation = $2",
            &[&self.c, &b(mutation)],
        )?
        .map(|r| PendingRow::from_bytes(r.get(0)).map_err(|e| corrupt("pending", format!("{e:?}"))))
        .transpose()
    }

    fn pending_count(&self) -> StoreResult<u64> {
        let r = self.q1("SELECT count(*) FROM rs_pending WHERE c = $1", &[&self.c])?;
        u64_of(r.map_or(0, |r| r.get(0)))
    }

    fn local_receipt(&self, mutation: &Uuid) -> StoreResult<Option<LocalReceipt>> {
        self.q1(
            "SELECT row FROM rs_local_receipts WHERE c = $1 AND mutation = $2",
            &[&self.c, &b(mutation)],
        )?
        .map(|r| local_receipt_from(r.get(0)))
        .transpose()
    }

    fn holds(&self) -> StoreResult<Vec<Hold>> {
        self.q(
            "SELECT hold FROM rs_holds WHERE c = $1 ORDER BY id",
            &[&self.c],
        )?
        .iter()
        .map(|r| from_bytes(r.get(0), "hold"))
        .collect()
    }

    fn hold(&self, id: &Uuid) -> StoreResult<Option<Hold>> {
        self.q1(
            "SELECT hold FROM rs_holds WHERE c = $1 AND id = $2",
            &[&self.c, &b(id)],
        )?
        .map(|r| from_bytes(r.get(0), "hold"))
        .transpose()
    }

    fn meta(&self, key: &str) -> StoreResult<Option<Vec<u8>>> {
        if SECRET_META.contains(&key) {
            return Ok(self.secrets.borrow().get(key).cloned());
        }
        let v: Option<Vec<u8>> = self
            .q1(
                "SELECT v FROM rs_meta WHERE c = $1 AND key = $2",
                &[&self.c, &key],
            )?
            .map(|r| r.get(0));
        Ok(v)
    }

    fn transfer(&self, id: &Uuid) -> StoreResult<Option<TransferRow>> {
        self.q1(
            "SELECT row FROM rs_transfers WHERE c = $1 AND id = $2",
            &[&self.c, &b(id)],
        )?
        .map(|r| transfer_from(r.get(0)))
        .transpose()
    }

    fn transfer_chunk(&self, id: &Uuid, index: u64) -> StoreResult<Option<Vec<u8>>> {
        Ok(self
            .q1(
                "SELECT bytes FROM rs_chunks WHERE c = $1 AND id = $2 AND idx = $3",
                &[&self.c, &b(id), &i64_of(index)?],
            )?
            .map(|r| r.get(0)))
    }

    fn blob_size(&self, digest: &Hash) -> StoreResult<Option<u64>> {
        let r = self.q1(
            "SELECT max(off + length(bytes)) FROM rs_blob_parts WHERE c = $1 AND digest = $2",
            &[&self.c, &digest.0.as_slice()],
        )?;
        r.and_then(|r| r.get::<_, Option<i64>>(0))
            .map(u64_of)
            .transpose()
    }

    fn blob_read(&self, digest: &Hash, offset: u64, len: u64) -> StoreResult<Vec<u8>> {
        let size = self
            .blob_size(digest)?
            .ok_or_else(|| StoreError::Io(format!("no blob {}", digest.to_hex())))?;
        let start = offset.min(size);
        let end = start.saturating_add(len).min(size);
        let rows = self.q(
            "SELECT off, bytes FROM rs_blob_parts WHERE c = $1 AND digest = $2 \
             AND off < $4 AND off + length(bytes) > $3 ORDER BY off",
            &[
                &self.c,
                &digest.0.as_slice(),
                &i64_of(start)?,
                &i64_of(end)?,
            ],
        )?;
        let n =
            usize::try_from(end - start).map_err(|_| StoreError::Io("read too large".into()))?;
        let mut out = vec![0u8; n];
        for r in &rows {
            let off = u64_of(r.get(0))?;
            let part: &[u8] = r.get(1);
            let part_end = off + part.len() as u64;
            let from = start.max(off);
            let to = end.min(part_end);
            if from < to {
                let src = usize::try_from(from - off).unwrap_or(0);
                let dst = usize::try_from(from - start).unwrap_or(0);
                let k = usize::try_from(to - from).unwrap_or(0);
                out[dst..dst + k].copy_from_slice(&part[src..src + k]);
            }
        }
        Ok(out)
    }

    fn commit(&mut self, tx: Tx) -> StoreResult<CommitReport> {
        if tx.is_empty() {
            return Ok(CommitReport::default());
        }
        let mut g = self.conn.borrow_mut();
        let PgConn { client, stmts } = &mut *g;
        let mut t = client.transaction().map_err(io)?;
        // The collection's row lock is its writer lock; nothing wider is taken.
        let st = match stmts.get("lock") {
            Some(s) => s.clone(),
            None => {
                let s = t
                    .prepare("SELECT epoch FROM rs_collections WHERE k = $1 FOR UPDATE")
                    .map_err(io)?;
                stmts.insert("lock", s.clone());
                s
            }
        };
        let epoch: Option<i64> = t.query_opt(&st, &[&self.c]).map_err(io)?.map(|r| r.get(0));
        if epoch != Some(self.epoch) {
            return Err(StoreError::Io(format!(
                "{FENCED} (epoch {:?}, ours {})",
                epoch, self.epoch
            )));
        }
        let secrets: Vec<(String, Option<Vec<u8>>)> = tx
            .meta
            .iter()
            .filter(|(k, _)| SECRET_META.contains(&k.as_str()))
            .cloned()
            .collect();
        self.apply(&mut t, stmts, tx)?;
        t.commit().map_err(io)?;
        let mut mem = self.secrets.borrow_mut();
        for (k, v) in secrets {
            match v {
                Some(v) => mem.insert(k, v),
                None => mem.remove(&k),
            };
        }
        drop(mem);
        drop(g);
        self.commits += 1;
        Ok(CommitReport::default())
    }
}

fn bucket_bounds(range: &Range<u32>) -> (i32, i32) {
    let lo = i32::try_from(range.start.min(1 << 16)).unwrap_or(1 << 16);
    let hi = i32::try_from(range.end.min(1 << 16)).unwrap_or(1 << 16);
    (lo, hi)
}
