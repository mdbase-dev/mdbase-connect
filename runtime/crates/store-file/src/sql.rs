//! `SqlStore`: the replicated state of a replica in SQLite, over
//! [`IndexStorage`]. It is the production inner store of [`crate::FileStore`]
//! (native SQLite, and sqlite-wasm in webviews), and passes the replica's
//! `Store` conformance suite.
//!
//! Rows are stored as canonical CBOR blobs keyed and indexed by the columns
//! lookups need (ID, path key, bucket, seq, link key, unique key, type). SQLite
//! compares BLOBs with `memcmp` and TEXT bytewise, so `ORDER BY id` and
//! `ORDER BY path` match the `Store` ordering rules.
//!
//! A commit is one `BatchMode::Transaction`: atomic, and durable when the
//! backend is `IndexDurability::Durable`. Public constructors reject Disposable
//! before any SQL. An evictable projection needs a separately typed journal-backed
//! composition, not a raw `Store` escape hatch.

#[path = "sql_mirror_candidate.rs"]
mod mirror_candidate;
#[path = "sql_tail.rs"]
mod tail;

use std::cell::RefCell;
use std::collections::BTreeSet;
use std::ops::Range;
use std::rc::Rc;

use mdbn_replica::mem::candidate_matches;
use mdbn_replica::store::{
    AliasRow, BoundedResource, Candidate, CommitReport, ConflictRow, FileLocal, FileRow, Head,
    LocalReceipt, Page, PendingRow, RESOURCE_PATH_BYTES, RESOURCE_SOURCE_BYTES, ReceiptRow,
    RecordMeta, RecordRow, ResourcePathPage, Stage, Store, StoreError, StoreResult, TombstoneLast,
    TombstoneRow, TransferRow, Tx,
};
use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::client::{Hold, Problem, ReceiptState};
use mdbn_wire::common::{B16, DataMap, Hash, Uuid, Value};
use mdbn_wire::entry::Status;
use mdbn_wire::intent::{FileInclusion, MediaClass};
use mdbn_wire::schema::Wire;
use mdbn_wire::snapshot::EntityKind;

use crate::index::{
    Batch, BatchMode, IndexError, IndexErrorKind, IndexStorage, SqlValue, Stmt, StmtResult,
};

const SCHEMA: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS st_kv(k TEXT PRIMARY KEY, v BLOB NOT NULL) WITHOUT ROWID",
    "CREATE TABLE IF NOT EXISTS st_meta(k TEXT PRIMARY KEY, v BLOB NOT NULL) WITHOUT ROWID",
    "CREATE TABLE IF NOT EXISTS st_rec(id BLOB PRIMARY KEY, path_key TEXT NOT NULL, bucket INTEGER NOT NULL, row BLOB NOT NULL) WITHOUT ROWID",
    "CREATE INDEX IF NOT EXISTS st_rec_pk ON st_rec(path_key)",
    "CREATE INDEX IF NOT EXISTS st_rec_b ON st_rec(bucket, id)",
    "CREATE TABLE IF NOT EXISTS st_link(k TEXT NOT NULL, id BLOB NOT NULL, PRIMARY KEY(k, id)) WITHOUT ROWID",
    "CREATE INDEX IF NOT EXISTS st_link_id ON st_link(id)",
    "CREATE TABLE IF NOT EXISTS st_uniq(f TEXT NOT NULL, v TEXT NOT NULL, id BLOB NOT NULL, PRIMARY KEY(f, v, id)) WITHOUT ROWID",
    "CREATE INDEX IF NOT EXISTS st_uniq_id ON st_uniq(id)",
    "CREATE TABLE IF NOT EXISTS st_file(id BLOB PRIMARY KEY, path_key TEXT NOT NULL, bucket INTEGER NOT NULL, row BLOB NOT NULL) WITHOUT ROWID",
    "CREATE INDEX IF NOT EXISTS st_file_pk ON st_file(path_key)",
    "CREATE INDEX IF NOT EXISTS st_file_b ON st_file(bucket, id)",
    "CREATE TABLE IF NOT EXISTS st_res(path TEXT PRIMARY KEY, doc TEXT NOT NULL) WITHOUT ROWID",
    "CREATE TABLE IF NOT EXISTS st_tomb(id BLOB PRIMARY KEY, path_key TEXT NOT NULL, seq INTEGER NOT NULL, time INTEGER NOT NULL, row BLOB NOT NULL) WITHOUT ROWID",
    "CREATE INDEX IF NOT EXISTS st_tomb_pk ON st_tomb(path_key, id)",
    "CREATE INDEX IF NOT EXISTS st_tomb_seq ON st_tomb(seq)",
    "CREATE TABLE IF NOT EXISTS st_alias(path_key TEXT PRIMARY KEY, path TEXT NOT NULL, row BLOB NOT NULL) WITHOUT ROWID",
    "CREATE TABLE IF NOT EXISTS st_conflict(m BLOB NOT NULL, cid BLOB NOT NULL, row BLOB NOT NULL, PRIMARY KEY(m, cid)) WITHOUT ROWID",
    "CREATE TABLE IF NOT EXISTS st_receipt(m BLOB PRIMARY KEY, seq INTEGER NOT NULL, time INTEGER NOT NULL) WITHOUT ROWID",
    "CREATE INDEX IF NOT EXISTS st_receipt_seq ON st_receipt(seq)",
    "CREATE TABLE IF NOT EXISTS st_pending(ord INTEGER PRIMARY KEY, m BLOB NOT NULL UNIQUE, row BLOB NOT NULL)",
    "CREATE TABLE IF NOT EXISTS st_lreceipt(m BLOB PRIMARY KEY, resolved INTEGER NOT NULL, row BLOB NOT NULL) WITHOUT ROWID",
    "CREATE TABLE IF NOT EXISTS st_hold(id BLOB PRIMARY KEY, row BLOB NOT NULL) WITHOUT ROWID",
    "CREATE TABLE IF NOT EXISTS st_transfer(id BLOB PRIMARY KEY, row BLOB NOT NULL) WITHOUT ROWID",
    "CREATE TABLE IF NOT EXISTS st_chunk(id BLOB NOT NULL, i INTEGER NOT NULL, b BLOB NOT NULL, PRIMARY KEY(id, i)) WITHOUT ROWID",
    "CREATE TABLE IF NOT EXISTS st_blob(d BLOB PRIMARY KEY, b BLOB NOT NULL) WITHOUT ROWID",
];

/// Tables holding confirmed replicated state (what `Tx::clear_confirmed` drops),
/// besides the `settings` row of `kv`. Each has a persistent staging twin `sg_*`
/// with the same columns and indexes (snapshot-install staging, `Tx::stage`).
const CONFIRMED: &[&str] = &[
    "rec", "link", "uniq", "file", "res", "tomb", "alias", "conflict", "receipt",
];

/// The staging twins: `kv` (settings only) plus every confirmed table, derived
/// from [`SCHEMA`] so they can never drift from it.
fn staging_schema() -> Vec<String> {
    let mut tables: Vec<&str> = vec!["kv"];
    tables.extend_from_slice(CONFIRMED);
    SCHEMA
        .iter()
        .filter(|stmt| {
            tables.iter().any(|t| {
                stmt.contains(&format!(" st_{t}(")) || stmt.contains(&format!(" ON st_{t}("))
            })
        })
        .map(|stmt| stmt.replace("st_", "sg_"))
        .collect()
}

/// `st_`-prefixed table names a statement references.
fn tables_of(sql: &str) -> Vec<&str> {
    sql.match_indices("st_")
        .filter(|(i, _)| {
            *i == 0
                || !sql.as_bytes()[i - 1].is_ascii_alphanumeric() && sql.as_bytes()[i - 1] != b'_'
        })
        .map(|(i, _)| {
            let rest = &sql[i + 3..];
            let end = rest
                .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
                .unwrap_or(rest.len());
            &rest[..end]
        })
        .collect()
}

/// Redirect confirmed-row statements to the staging twins. Derived query-index
/// maintenance has no twin: staged rows are not indexed, and the swap
/// invalidates the index, which is rebuilt from the swapped-in records.
fn staged_stmts(stmts: Vec<Stmt>) -> StoreResult<Vec<Stmt>> {
    let mut out = Vec::with_capacity(stmts.len());
    for mut x in stmts {
        let tables = tables_of(&x.sql);
        if tables.iter().all(|t| CONFIRMED.contains(t) || *t == "kv") {
            x.sql = x.sql.replace("st_", "sg_");
            out.push(x);
        } else if !tables.iter().all(|t| t.starts_with('q') || *t == "field") {
            return Err(StoreError::Io(format!(
                "sql store: no staging twin for {:?}",
                tables
            )));
        }
    }
    Ok(out)
}

/// Explicit memory bounds for the current whole-row blob cache. These are
/// implementation limits, not sync eligibility or paid-plan limits. Streaming
/// storage is needed for blobs larger than the host's configured row bound.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SqlStoreLimits {
    /// Maximum assembled blob row (including sparse zero padding).
    pub max_blob_bytes: u64,
    /// Maximum input bytes and total assembled blob bytes held by one commit;
    /// also bounds one blob_read allocation. Parts are borrowed, not cloned.
    pub max_blob_patch_bytes: u64,
}

impl SqlStoreLimits {
    /// Safe default for webviews and mobile hosts: at most 32 MiB per row and
    /// 32 MiB of assembled blob working data in a commit.
    pub const MOBILE: Self = Self {
        max_blob_bytes: 32 << 20,
        max_blob_patch_bytes: 32 << 20,
    };
    /// Desktop opt-in; hosts must explicitly accept the larger memory budget.
    pub const DESKTOP: Self = Self {
        max_blob_bytes: 128 << 20,
        max_blob_patch_bytes: 128 << 20,
    };
}

impl Default for SqlStoreLimits {
    fn default() -> Self {
        Self::MOBILE
    }
}

/// The SQL store.
pub struct SqlStore<I: IndexStorage> {
    index: Rc<RefCell<I>>,
    limits: SqlStoreLimits,
}

fn idx_err(e: IndexError) -> StoreError {
    match e.kind {
        IndexErrorKind::Full => StoreError::Full,
        IndexErrorKind::Corrupt => StoreError::Corrupt(e.to_string()),
        _ => StoreError::Io(e.to_string()),
    }
}

fn corrupt(what: &str) -> StoreError {
    StoreError::Corrupt(format!("sql store: bad {what}"))
}

// ------------------------------------------------------------ values

fn b(u: &Uuid) -> SqlValue {
    SqlValue::Blob(u.0.to_vec())
}
fn t(s: &str) -> SqlValue {
    SqlValue::Text(s.to_string())
}
fn int(v: u32) -> SqlValue {
    SqlValue::Integer(i64::from(v))
}
fn wide_int(v: u64) -> StoreResult<SqlValue> {
    i64::try_from(v)
        .map(SqlValue::Integer)
        .map_err(|_| StoreError::Io("integer exceeds SQLite's signed range".into()))
}

// SQLite's default per-value limit. Check before converting offsets or growing
// a Vec; a larger blob needs a streaming/chunked storage representation.
const MAX_BLOB_BYTES: u64 = 1_000_000_000;
// Protocol blob parts are at most 16 MiB (replica::crypto::blob::MAX_PART_SIZE).
const MAX_BLOB_PART_BYTES: u64 = 16 << 20;
const MAX_BLOB_PARTS_PER_TX: usize = 4096;
fn blob(v: Vec<u8>) -> SqlValue {
    SqlValue::Blob(v)
}
fn st(sql: &str, params: Vec<SqlValue>) -> Stmt {
    Stmt::new(sql, params)
}

/// `st_link` rows per multi-row insert: two parameters each, within the
/// 100-parameter limit of the hosted and app index codecs (`CodecLimits`).
const LINK_ROWS_PER_STMT: usize = 50;

/// Insert a record's link keys. Full chunks share one multi-row statement and
/// the remainder uses the single-row one, so backends see two statement texts
/// and a link-dense note (a map of content, a long index) costs one statement
/// per 50 keys instead of one per key: a batch of such notes no longer
/// overflows the 16,384-statement transaction budget.
fn link_stmts(id: &Uuid, links: &[String], out: &mut Vec<Stmt>) {
    let keys: Vec<&String> = links.iter().collect::<BTreeSet<_>>().into_iter().collect();
    let mut chunks = keys.chunks_exact(LINK_ROWS_PER_STMT);
    for chunk in chunks.by_ref() {
        let mut sql = String::from("INSERT OR IGNORE INTO st_link(k, id) VALUES (?, ?)");
        let mut params = Vec::with_capacity(2 * LINK_ROWS_PER_STMT);
        for (i, k) in chunk.iter().enumerate() {
            if i > 0 {
                sql.push_str(", (?, ?)");
            }
            params.push(t(k));
            params.push(b(id));
        }
        out.push(Stmt::new(sql, params));
    }
    for k in chunks.remainder() {
        out.push(st(
            "INSERT OR IGNORE INTO st_link(k, id) VALUES (?, ?)",
            vec![t(k), b(id)],
        ));
    }
}

fn enc(c: Cbor) -> StoreResult<Vec<u8>> {
    cbor::encode(&c).map_err(|_| corrupt("CBOR input"))
}

fn dec(v: &SqlValue, what: &str) -> StoreResult<Vec<Cbor>> {
    let SqlValue::Blob(bytes) = v else {
        return Err(corrupt(what));
    };
    match cbor::decode(bytes).map_err(|_| corrupt(what))? {
        Cbor::Array(a) => Ok(a),
        _ => Err(corrupt(what)),
    }
}

fn w<T: Wire>(c: &Cbor, what: &str) -> StoreResult<T> {
    T::from_cbor(c).map_err(|_| corrupt(what))
}

fn opt_c<T: Wire>(v: &Option<T>) -> Cbor {
    v.as_ref().map_or(Cbor::Null, Wire::to_cbor)
}

fn opt_w<T: Wire>(c: &Cbor, what: &str) -> StoreResult<Option<T>> {
    match c {
        Cbor::Null => Ok(None),
        c => Ok(Some(w(c, what)?)),
    }
}

fn uuid_of(v: &SqlValue) -> StoreResult<Uuid> {
    match v {
        SqlValue::Blob(b) => Ok(B16(b.as_slice().try_into().map_err(|_| corrupt("id"))?)),
        _ => Err(corrupt("id")),
    }
}

fn u64_of(v: &SqlValue) -> StoreResult<u64> {
    match v {
        SqlValue::Integer(i) => u64::try_from(*i).map_err(|_| corrupt("integer")),
        _ => Err(corrupt("integer")),
    }
}

// ------------------------------------------------------------ row codecs

fn meta_c(m: &RecordMeta) -> Cbor {
    Cbor::Array(vec![
        m.types.to_cbor(),
        m.effective.to_cbor(),
        m.links.to_cbor(),
        m.tags.to_cbor(),
        Cbor::Array(
            m.unique
                .iter()
                .map(|(f, v)| Cbor::Array(vec![f.to_cbor(), v.to_cbor()]))
                .collect(),
        ),
    ])
}

fn meta_d(c: &Cbor) -> StoreResult<RecordMeta> {
    let Cbor::Array(a) = c else {
        return Err(corrupt("meta"));
    };
    let [types, eff, links, tags, uniq] = a.as_slice() else {
        return Err(corrupt("meta"));
    };
    let Cbor::Array(u) = uniq else {
        return Err(corrupt("meta"));
    };
    let mut unique = Vec::new();
    for p in u {
        let Cbor::Array(p) = p else {
            return Err(corrupt("meta"));
        };
        let [f, v] = p.as_slice() else {
            return Err(corrupt("meta"));
        };
        unique.push((w::<String>(f, "meta")?, w::<String>(v, "meta")?));
    }
    Ok(RecordMeta {
        types: w(types, "meta")?,
        effective: w::<DataMap<Value>>(eff, "meta")?,
        links: w(links, "meta")?,
        tags: w(tags, "meta")?,
        unique,
    })
}

fn record_c(r: &RecordRow) -> StoreResult<Vec<u8>> {
    enc(Cbor::Array(vec![
        r.id.to_cbor(),
        r.path.to_cbor(),
        r.path_key.to_cbor(),
        r.doc.to_cbor(),
        r.revision.to_cbor(),
        r.modified_seq.to_cbor(),
        u64::from(r.bucket).to_cbor(),
        meta_c(&r.meta),
    ]))
}

pub(crate) fn record_d(v: &SqlValue) -> StoreResult<RecordRow> {
    let a = dec(v, "record")?;
    let [id, path, pk, doc, rev, ms, bucket, meta] = a.as_slice() else {
        return Err(corrupt("record"));
    };
    Ok(RecordRow {
        id: w(id, "record")?,
        path: w(path, "record")?,
        path_key: w(pk, "record")?,
        doc: w(doc, "record")?,
        revision: w(rev, "record")?,
        modified_seq: w(ms, "record")?,
        bucket: u16::try_from(w::<u64>(bucket, "record")?).map_err(|_| corrupt("record"))?,
        meta: meta_d(meta)?,
    })
}

fn local_c(l: FileLocal) -> Cbor {
    Cbor::Uint(match l {
        FileLocal::Materialized => 0,
        FileLocal::Remote => 1,
        FileLocal::Fetching => 2,
    })
}

fn local_d(c: &Cbor) -> StoreResult<FileLocal> {
    Ok(match w::<u64>(c, "file")? {
        0 => FileLocal::Materialized,
        1 => FileLocal::Remote,
        2 => FileLocal::Fetching,
        _ => return Err(corrupt("file")),
    })
}

fn file_c(f: &FileRow) -> StoreResult<Vec<u8>> {
    use mdbn_wire::unindexed_markdown::{FileKindV1, UnindexedMarkdownPayloadV1};
    let content = match f.kind {
        FileKindV1::Ordinary => f.content.to_cbor(),
        FileKindV1::UnindexedOversizedMarkdown => {
            let c = UnindexedMarkdownPayloadV1 {
                content: f.content.clone(),
            }
            .to_cbor();
            UnindexedMarkdownPayloadV1::from_cbor(&c)
                .map_err(|_| corrupt("unindexed file payload"))?;
            c
        }
    };
    enc(Cbor::Array(vec![
        f.id.to_cbor(),
        f.path.to_cbor(),
        f.path_key.to_cbor(),
        content,
        f.media.to_cbor(),
        f.modified_seq.to_cbor(),
        u64::from(f.bucket).to_cbor(),
        local_c(f.local),
    ]))
}

fn file_d(v: &SqlValue) -> StoreResult<FileRow> {
    let a = dec(v, "file")?;
    let [id, path, pk, content, media, ms, bucket, local] = a.as_slice() else {
        return Err(corrupt("file"));
    };
    use mdbn_wire::unindexed_markdown::{
        FileKindV1, PAYLOAD_DISCRIMINATOR, UnindexedMarkdownPayloadV1,
    };
    let (kind, content) = match content {
        Cbor::Array(a) if a.first() == Some(&Cbor::Uint(PAYLOAD_DISCRIMINATOR)) => {
            let p = w::<UnindexedMarkdownPayloadV1>(content, "unindexed file payload")?;
            (FileKindV1::UnindexedOversizedMarkdown, p.content)
        }
        _ => (
            FileKindV1::Ordinary,
            w::<mdbn_wire::attachment::FileContent>(content, "file")?,
        ),
    };
    Ok(FileRow {
        kind,
        id: w(id, "file")?,
        path: w(path, "file")?,
        path_key: w(pk, "file")?,
        content,
        media: w::<MediaClass>(media, "file")?,
        modified_seq: w(ms, "file")?,
        bucket: u16::try_from(w::<u64>(bucket, "file")?).map_err(|_| corrupt("file"))?,
        local: local_d(local)?,
    })
}

fn tomb_c(t: &TombstoneRow) -> StoreResult<Vec<u8>> {
    let last = match &t.last {
        TombstoneLast::Doc(d) => Cbor::Array(vec![Cbor::Uint(0), d.to_cbor()]),
        TombstoneLast::Blob(b) => Cbor::Array(vec![Cbor::Uint(1), b.to_cbor()]),
        TombstoneLast::Attachment(a) => Cbor::Array(vec![Cbor::Uint(2), a.to_cbor()]),
        TombstoneLast::UnindexedMarkdown(p) => {
            if t.kind != EntityKind::File {
                return Err(corrupt("unindexed tombstone kind"));
            }
            let p = p.to_cbor();
            mdbn_wire::unindexed_markdown::UnindexedMarkdownPayloadV1::from_cbor(&p)
                .map_err(|_| corrupt("unindexed tombstone payload"))?;
            Cbor::Array(vec![Cbor::Uint(3), p])
        }
    };
    enc(Cbor::Array(vec![
        t.id.to_cbor(),
        t.kind.to_cbor(),
        t.path.to_cbor(),
        t.path_key.to_cbor(),
        last,
        t.seq.to_cbor(),
        t.time.to_cbor(),
    ]))
}

fn tomb_d(v: &SqlValue) -> StoreResult<TombstoneRow> {
    let a = dec(v, "tombstone")?;
    let [id, kind, path, pk, last, seq, time] = a.as_slice() else {
        return Err(corrupt("tombstone"));
    };
    let Cbor::Array(l) = last else {
        return Err(corrupt("tombstone"));
    };
    let last = match l.as_slice() {
        [Cbor::Uint(0), d] => TombstoneLast::Doc(w(d, "tombstone")?),
        [Cbor::Uint(1), b] => TombstoneLast::Blob(w(b, "tombstone")?),
        [Cbor::Uint(2), a] => TombstoneLast::Attachment(w(a, "tombstone")?),
        [Cbor::Uint(3), p] => {
            if w::<EntityKind>(kind, "tombstone")? != EntityKind::File {
                return Err(corrupt("unindexed tombstone kind"));
            }
            TombstoneLast::UnindexedMarkdown(w(p, "unindexed tombstone payload")?)
        }
        _ => return Err(corrupt("tombstone")),
    };
    Ok(TombstoneRow {
        id: w(id, "tombstone")?,
        kind: w::<EntityKind>(kind, "tombstone")?,
        path: w(path, "tombstone")?,
        path_key: w(pk, "tombstone")?,
        last,
        seq: w(seq, "tombstone")?,
        time: w(time, "tombstone")?,
    })
}

fn alias_c(a: &AliasRow) -> StoreResult<Vec<u8>> {
    enc(Cbor::Array(vec![
        a.path.to_cbor(),
        a.path_key.to_cbor(),
        a.record.to_cbor(),
    ]))
}

fn alias_d(v: &SqlValue) -> StoreResult<AliasRow> {
    let a = dec(v, "alias")?;
    let [p, pk, r] = a.as_slice() else {
        return Err(corrupt("alias"));
    };
    Ok(AliasRow {
        path: w(p, "alias")?,
        path_key: w(pk, "alias")?,
        record: w(r, "alias")?,
    })
}

fn conflict_c(c: &ConflictRow) -> StoreResult<Vec<u8>> {
    enc(Cbor::Array(vec![
        c.mutation.to_cbor(),
        c.seq.to_cbor(),
        c.conflict.to_cbor(),
    ]))
}

fn conflict_d(v: &SqlValue) -> StoreResult<ConflictRow> {
    let a = dec(v, "conflict")?;
    let [m, s, c] = a.as_slice() else {
        return Err(corrupt("conflict"));
    };
    Ok(ConflictRow {
        mutation: w(m, "conflict")?,
        seq: w(s, "conflict")?,
        conflict: w::<mdbn_wire::attachment_runtime_v1::Conflict>(c, "conflict")?,
    })
}

fn lreceipt_c(r: &LocalReceipt) -> StoreResult<Vec<u8>> {
    enc(Cbor::Array(vec![
        r.mutation.to_cbor(),
        r.state.to_cbor(),
        opt_c(&r.seq),
        opt_c(&r.status),
        r.conflicts.to_cbor(),
        opt_c(&r.problem),
        r.resolved_at.to_cbor(),
        opt_c(&r.grant),
    ]))
}

fn lreceipt_d(v: &SqlValue) -> StoreResult<LocalReceipt> {
    let a = dec(v, "local receipt")?;
    // 7 elements before `grant` existed.
    let (m, state, seq, status, conflicts, problem, at, grant) = match a.as_slice() {
        [m, state, seq, status, conflicts, problem, at] => {
            (m, state, seq, status, conflicts, problem, at, &Cbor::Null)
        }
        [m, state, seq, status, conflicts, problem, at, grant] => {
            (m, state, seq, status, conflicts, problem, at, grant)
        }
        _ => return Err(corrupt("local receipt")),
    };
    Ok(LocalReceipt {
        mutation: w(m, "local receipt")?,
        state: w::<ReceiptState>(state, "local receipt")?,
        seq: opt_w(seq, "local receipt")?,
        status: opt_w::<Status>(status, "local receipt")?,
        conflicts: w(conflicts, "local receipt")?,
        problem: opt_w::<Problem>(problem, "local receipt")?,
        resolved_at: w(at, "local receipt")?,
        grant: opt_w(grant, "local receipt")?,
    })
}

fn transfer_c(t: &TransferRow) -> StoreResult<Vec<u8>> {
    enc(Cbor::Array(vec![
        t.id.to_cbor(),
        t.path.to_cbor(),
        t.size.to_cbor(),
        opt_c(&t.digest),
        opt_c(&t.file),
        opt_c(&t.if_revision),
        opt_c(&t.mutation),
        t.chunk_size.to_cbor(),
        t.received.iter().copied().collect::<Vec<u64>>().to_cbor(),
        t.expires_at.to_cbor(),
        opt_c(&t.grant),
    ]))
}

fn transfer_d(v: &SqlValue) -> StoreResult<TransferRow> {
    let a = dec(v, "transfer")?;
    let [id, path, size, digest, file, ifr, m, cs, rec, exp, grant] = a.as_slice() else {
        return Err(corrupt("transfer"));
    };
    Ok(TransferRow {
        id: w(id, "transfer")?,
        path: w(path, "transfer")?,
        size: w(size, "transfer")?,
        digest: opt_w(digest, "transfer")?,
        file: opt_w(file, "transfer")?,
        if_revision: opt_w(ifr, "transfer")?,
        mutation: opt_w(m, "transfer")?,
        chunk_size: w(cs, "transfer")?,
        received: w::<Vec<u64>>(rec, "transfer")?
            .into_iter()
            .collect::<BTreeSet<u64>>(),
        expires_at: w(exp, "transfer")?,
        grant: opt_w(grant, "transfer")?,
    })
}

fn head_c(h: &Head) -> StoreResult<Vec<u8>> {
    enc(Cbor::Array(vec![h.seq.to_cbor(), h.chain.to_cbor()]))
}

pub(crate) fn head_d(v: &SqlValue) -> StoreResult<Head> {
    let a = dec(v, "head")?;
    let [s, c] = a.as_slice() else {
        return Err(corrupt("head"));
    };
    Ok(Head {
        seq: w(s, "head")?,
        chain: w::<Hash>(c, "head")?,
    })
}

// ------------------------------------------------------------ the store

impl<I: IndexStorage> SqlStore<I> {
    /// Open a durable store; reject Disposable before creating any tables.
    pub fn open(index: Rc<RefCell<I>>) -> StoreResult<SqlStore<I>> {
        Self::open_with_limits(index, SqlStoreLimits::default())
    }

    /// Open with explicit host memory bounds. Over-budget writes/reads fail
    /// with Full; they never silently truncate bytes or partially commit.
    pub fn open_with_limits(
        index: Rc<RefCell<I>>,
        limits: SqlStoreLimits,
    ) -> StoreResult<SqlStore<I>> {
        if index.borrow().info().durability != crate::index::IndexDurability::Durable {
            return Err(StoreError::Io(
                "raw SqlStore requires a Durable index; Disposable is derived-only".into(),
            ));
        }
        Self::open_schema(index, limits)
    }

    /// Validate limits and create the schema, whatever the index durability. Only
    /// the typed log-derived cache ([`crate::log_cache::LogCache`]) calls this
    /// without the Durable guard above.
    pub(crate) fn open_schema(
        index: Rc<RefCell<I>>,
        limits: SqlStoreLimits,
    ) -> StoreResult<SqlStore<I>> {
        if limits.max_blob_bytes == 0
            || limits.max_blob_bytes > limits.max_blob_patch_bytes
            || limits.max_blob_patch_bytes > MAX_BLOB_BYTES
        {
            return Err(StoreError::Io("invalid SQL blob memory limits".into()));
        }
        index
            .borrow_mut()
            .run(&Batch {
                mode: BatchMode::Transaction,
                stmts: SCHEMA
                    .iter()
                    .chain(crate::sql_fields::SCHEMA)
                    .chain(crate::sql_bases::SCHEMA)
                    .chain(tail::SCHEMA)
                    .map(|s| st(s, vec![]))
                    .chain(staging_schema().iter().map(|s| st(s, vec![])))
                    .collect(),
            })
            .map_err(idx_err)?;
        Ok(SqlStore { index, limits })
    }

    /// Own-intent count/bytes remain independent of raw-tail erasure. This is
    /// sequence/encoded-size accounting, not host-clock age or GC eligibility.
    pub fn own_retained_stats(&self) -> StoreResult<mdbn_replica::store::TailStats> {
        tail::stats(self, "st_own", "own")
    }

    /// The shared index (the file store's `SqlDiskDb` uses the same database).
    pub fn index(&self) -> Rc<RefCell<I>> {
        self.index.clone()
    }

    fn q(&self, sql: &str, params: Vec<SqlValue>) -> StoreResult<StmtResult> {
        let mut r = self
            .index
            .borrow_mut()
            .run(&Batch {
                mode: BatchMode::Autocommit,
                stmts: vec![st(sql, params)],
            })
            .map_err(idx_err)?;
        r.pop().ok_or_else(|| corrupt("result"))
    }

    fn resource_query(
        &self,
        sql: &'static str,
        params: Vec<SqlValue>,
        columns: u32,
        max_rows: u32,
    ) -> StoreResult<StmtResult> {
        let mut reports = self
            .index
            .borrow_mut()
            .run(&Batch {
                mode: BatchMode::Autocommit,
                stmts: vec![st(sql, params)],
            })
            .map_err(|_| StoreError::Io("bounded resource query unavailable".into()))?;
        if reports.len() != 1 {
            return Err(corrupt("bounded resource statement count"));
        }
        let report = reports
            .pop()
            .ok_or_else(|| corrupt("bounded resource result"))?;
        if report.columns != columns
            || report.values.len() % columns as usize != 0
            || report.values.len() > columns as usize * max_rows as usize
        {
            return Err(corrupt("bounded resource result shape"));
        }
        Ok(report)
    }

    fn one<T>(
        &self,
        sql: &str,
        params: Vec<SqlValue>,
        f: impl Fn(&[SqlValue]) -> StoreResult<T>,
    ) -> StoreResult<Option<T>> {
        let r = self.q(sql, params)?;
        r.rows().next().map(f).transpose()
    }

    fn all<T>(
        &self,
        sql: &str,
        params: Vec<SqlValue>,
        f: impl Fn(&[SqlValue]) -> StoreResult<T>,
    ) -> StoreResult<Vec<T>> {
        self.q(sql, params)?.rows().map(f).collect()
    }

    fn page_sql(base: &str, where_: &str, p: Page, params: &mut Vec<SqlValue>) -> String {
        let mut sql = format!("{base} WHERE {where_}");
        if let Some(a) = p.after {
            sql.push_str(" AND id > ?");
            params.push(b(&a));
        }
        sql.push_str(" ORDER BY id LIMIT ?");
        params.push(int(p.limit));
        sql
    }

    /// Statements putting and removing a transaction's confirmed-state rows.
    fn confirmed_stmts(tx: &Tx, s: &mut Vec<Stmt>) -> StoreResult<()> {
        for id in &tx.records_del {
            Self::del_record_stmts(id, s);
        }
        for r in &tx.records_put {
            Self::del_record_stmts(&r.id, s);
            s.push(st(
                "INSERT INTO st_rec(id, path_key, bucket, row) VALUES (?, ?, ?, ?)",
                vec![
                    b(&r.id),
                    t(&r.path_key),
                    int(u32::from(r.bucket)),
                    blob(record_c(r)?),
                ],
            ));
            link_stmts(&r.id, &r.meta.links, s);
            for (f, v) in &r.meta.unique {
                s.push(st(
                    "INSERT OR IGNORE INTO st_uniq(f, v, id) VALUES (?, ?, ?)",
                    vec![t(f), t(v), b(&r.id)],
                ));
            }
        }
        for id in &tx.files_del {
            s.push(st("DELETE FROM st_file WHERE id = ?", vec![b(id)]));
        }
        for f in &tx.files_put {
            s.push(st(
                "INSERT OR REPLACE INTO st_file(id, path_key, bucket, row) VALUES (?, ?, ?, ?)",
                vec![
                    b(&f.id),
                    t(&f.path_key),
                    int(u32::from(f.bucket)),
                    blob(file_c(f)?),
                ],
            ));
        }
        for p in &tx.resources_del {
            s.push(st("DELETE FROM st_res WHERE path = ?", vec![t(p)]));
        }
        for (p, d) in &tx.resources_put {
            s.push(st(
                "INSERT OR REPLACE INTO st_res(path, doc) VALUES (?, ?)",
                vec![t(p), t(d)],
            ));
        }
        if let Some(set) = &tx.settings {
            s.push(st(
                "INSERT OR REPLACE INTO st_kv(k, v) VALUES ('settings', ?)",
                vec![blob(enc(set.to_cbor())?)],
            ));
        }
        for id in &tx.tombstones_del {
            s.push(st("DELETE FROM st_tomb WHERE id = ?", vec![b(id)]));
        }
        for tb in &tx.tombstones_put {
            s.push(st(
                "INSERT OR REPLACE INTO st_tomb(id, path_key, seq, time, row) VALUES (?, ?, ?, ?, ?)",
                vec![b(&tb.id), t(&tb.path_key), wide_int(tb.seq)?, SqlValue::Integer(tb.time), blob(tomb_c(tb)?)],
            ));
        }
        for a in &tx.aliases_put {
            s.push(st(
                "INSERT OR REPLACE INTO st_alias(path_key, path, row) VALUES (?, ?, ?)",
                vec![t(&a.path_key), t(&a.path), blob(alias_c(a)?)],
            ));
        }
        for (m, id) in &tx.conflicts_del {
            s.push(st(
                "DELETE FROM st_conflict WHERE m = ? AND cid = ?",
                vec![b(m), b(id)],
            ));
        }
        for c in &tx.conflicts_put {
            s.push(st(
                "INSERT OR REPLACE INTO st_conflict(m, cid, row) VALUES (?, ?, ?)",
                vec![b(&c.mutation), b(&c.conflict.id), blob(conflict_c(c)?)],
            ));
        }
        for r in &tx.receipts_put {
            s.push(st(
                "INSERT OR REPLACE INTO st_receipt(m, seq, time) VALUES (?, ?, ?)",
                vec![b(&r.mutation), wide_int(r.seq)?, SqlValue::Integer(r.time)],
            ));
        }
        Ok(())
    }

    fn del_record_stmts(id: &Uuid, out: &mut Vec<Stmt>) {
        out.push(st("DELETE FROM st_rec WHERE id = ?", vec![b(id)]));
        out.push(st("DELETE FROM st_link WHERE id = ?", vec![b(id)]));
        out.push(st("DELETE FROM st_uniq WHERE id = ?", vec![b(id)]));
        crate::sql_fields::delete_row(&id.0, out);
        crate::sql_bases::delete_row(&id.0, out);
    }
}

fn row0(r: &[SqlValue]) -> StoreResult<&SqlValue> {
    r.first().ok_or_else(|| corrupt("row"))
}

impl<I: IndexStorage> Store for SqlStore<I> {
    fn head(&self) -> StoreResult<Head> {
        Ok(self
            .one("SELECT v FROM st_kv WHERE k = 'head'", vec![], |r| {
                head_d(row0(r)?)
            })?
            .unwrap_or(Head::GENESIS))
    }
    fn query_index_supported(&self) -> bool {
        true
    }
    fn query_projection_state(
        &self,
    ) -> StoreResult<Option<mdbn_replica::store_query::QueryProjectionState>> {
        crate::sql_bases::projection_state(&self.index).map(Some)
    }
    fn query_projection_page(
        &self,
        request: &mdbn_replica::store_query::QueryProjectionRequest,
    ) -> StoreResult<mdbn_replica::store_query::QueryProjectionPage> {
        crate::sql_bases::page(&self.index, request)
    }
    fn query_index_state(&self) -> StoreResult<Option<mdbn_replica::store_query::QueryIndexState>> {
        crate::sql_fields::state(&self.index)
    }
    fn query_index_page(
        &self,
        request: &mdbn_replica::store_query::QueryIndexRequest,
    ) -> StoreResult<Option<mdbn_replica::store_query::QueryIndexPage>> {
        crate::sql_select::select(&self.index, request).map(Some)
    }
    fn hydrate_query_at(
        &self,
        ids: &[Uuid],
        head: Head,
        budget: &mut mdbn_replica::store_query::QueryBudget,
    ) -> StoreResult<Vec<RecordRow>> {
        crate::sql_query::SqlQuery::new(self.index.clone()).hydrate_records_at(ids, head, budget)
    }
    fn query_record_sizes_at(
        &self,
        page: Page,
        head: Head,
    ) -> StoreResult<Vec<mdbn_replica::store_query::QueryRecordSize>> {
        crate::sql_query::SqlQuery::new(self.index.clone()).record_ids_with_sizes_at(page, head)
    }
    fn record(&self, id: &Uuid) -> StoreResult<Option<RecordRow>> {
        self.one("SELECT row FROM st_rec WHERE id = ?", vec![b(id)], |r| {
            record_d(row0(r)?)
        })
    }
    fn record_at(&self, path_key: &str) -> StoreResult<Option<Uuid>> {
        self.one(
            "SELECT id FROM st_rec WHERE path_key = ? ORDER BY id LIMIT 1",
            vec![t(path_key)],
            |r| uuid_of(row0(r)?),
        )
    }
    fn records(&self, p: Page) -> StoreResult<Vec<RecordRow>> {
        let mut params = vec![];
        let sql = Self::page_sql("SELECT row FROM st_rec", "1", p, &mut params);
        self.all(&sql, params, |r| record_d(row0(r)?))
    }
    fn records_in_buckets(&self, range: Range<u32>, p: Page) -> StoreResult<Vec<RecordRow>> {
        let mut params = vec![int(range.start), int(range.end)];
        let sql = Self::page_sql(
            "SELECT row FROM st_rec",
            "bucket >= ? AND bucket < ?",
            p,
            &mut params,
        );
        self.all(&sql, params, |r| record_d(row0(r)?))
    }
    fn record_count(&self) -> StoreResult<u64> {
        Ok(self
            .one("SELECT count(*) FROM st_rec", vec![], |r| u64_of(row0(r)?))?
            .unwrap_or(0))
    }
    fn file(&self, id: &Uuid) -> StoreResult<Option<FileRow>> {
        self.one("SELECT row FROM st_file WHERE id = ?", vec![b(id)], |r| {
            file_d(row0(r)?)
        })
    }
    fn file_at(&self, path_key: &str) -> StoreResult<Option<Uuid>> {
        self.one(
            "SELECT id FROM st_file WHERE path_key = ? ORDER BY id LIMIT 1",
            vec![t(path_key)],
            |r| uuid_of(row0(r)?),
        )
    }
    fn files(&self, p: Page) -> StoreResult<Vec<FileRow>> {
        let mut params = vec![];
        let sql = Self::page_sql("SELECT row FROM st_file", "1", p, &mut params);
        self.all(&sql, params, |r| file_d(row0(r)?))
    }
    fn files_in_buckets(&self, range: Range<u32>, p: Page) -> StoreResult<Vec<FileRow>> {
        let mut params = vec![int(range.start), int(range.end)];
        let sql = Self::page_sql(
            "SELECT row FROM st_file",
            "bucket >= ? AND bucket < ?",
            p,
            &mut params,
        );
        self.all(&sql, params, |r| file_d(row0(r)?))
    }
    fn resource(&self, path: &str) -> StoreResult<Option<String>> {
        self.one(
            "SELECT doc FROM st_res WHERE path = ?",
            vec![t(path)],
            |r| match row0(r)? {
                SqlValue::Text(s) => Ok(s.clone()),
                _ => Err(corrupt("resource")),
            },
        )
    }
    fn resource_paths_page(&self, page: ResourcePathPage<'_>) -> StoreResult<Vec<String>> {
        page.validate()?;
        let report = self.resource_query(
            "SELECT CASE WHEN typeof(path) = 'text' AND length(CAST(path AS BLOB)) <= 4096 \
             THEN path ELSE NULL END, \
             CASE WHEN typeof(path) = 'text' THEN length(CAST(path AS BLOB)) ELSE NULL END \
             FROM st_res WHERE (?1 IS NULL OR path > ?1) \
             AND (?2 IS NULL OR substr(path, 1, length(?2)) = ?2) ORDER BY path LIMIT ?3",
            vec![
                page.after.map(t).unwrap_or(SqlValue::Null),
                page.prefix.map(t).unwrap_or(SqlValue::Null),
                int(page.limit),
            ],
            2,
            page.limit,
        )?;
        report
            .rows()
            .map(|row| match row {
                [_, SqlValue::Integer(n)] if *n > RESOURCE_PATH_BYTES as i64 => {
                    Err(StoreError::Full)
                }
                [SqlValue::Text(path), SqlValue::Integer(n)]
                    if *n >= 0 && path.len() <= RESOURCE_PATH_BYTES && path.len() as i64 == *n =>
                {
                    Ok(path.clone())
                }
                _ => Err(corrupt("bounded resource path")),
            })
            .collect()
    }
    fn resource_bounded(
        &self,
        path: &str,
        copy_limit: usize,
    ) -> StoreResult<Option<BoundedResource>> {
        if path.len() > RESOURCE_PATH_BYTES || copy_limit > RESOURCE_SOURCE_BYTES {
            return Err(StoreError::Full);
        }
        let report = self.resource_query(
            "SELECT CASE WHEN typeof(doc) = 'text' THEN length(CAST(doc AS BLOB)) ELSE NULL END, \
             CASE WHEN typeof(doc) = 'text' AND length(CAST(doc AS BLOB)) <= ?2 \
             THEN doc ELSE NULL END FROM st_res WHERE path = ?1 LIMIT 2",
            vec![t(path), SqlValue::Integer(copy_limit as i64)],
            2,
            2,
        )?;
        if report.row_count() > 1 {
            return Err(corrupt("bounded resource duplicate"));
        }
        report
            .rows()
            .next()
            .map(|row| match row {
                [SqlValue::Integer(n), SqlValue::Null] if *n > copy_limit as i64 => {
                    Ok(BoundedResource {
                        size: *n as u64,
                        text: None,
                    })
                }
                [SqlValue::Integer(n), SqlValue::Text(doc)]
                    if *n >= 0 && doc.len() <= copy_limit && doc.len() as i64 == *n =>
                {
                    Ok(BoundedResource {
                        size: *n as u64,
                        text: Some(doc.clone()),
                    })
                }
                _ => Err(corrupt("bounded resource source")),
            })
            .transpose()
    }
    fn resources(&self) -> StoreResult<Vec<(String, String)>> {
        self.all(
            "SELECT path, doc FROM st_res ORDER BY path",
            vec![],
            |r| match r {
                [SqlValue::Text(p), SqlValue::Text(d)] => Ok((p.clone(), d.clone())),
                _ => Err(corrupt("resource")),
            },
        )
    }
    fn settings(&self) -> StoreResult<Option<FileInclusion>> {
        self.one(
            "SELECT v FROM st_kv WHERE k = 'settings'",
            vec![],
            |r| match row0(r)? {
                SqlValue::Blob(bytes) => {
                    let c = cbor::decode(bytes).map_err(|_| corrupt("settings"))?;
                    w::<FileInclusion>(&c, "settings")
                }
                _ => Err(corrupt("settings")),
            },
        )
    }
    fn tombstone(&self, id: &Uuid) -> StoreResult<Option<TombstoneRow>> {
        self.one("SELECT row FROM st_tomb WHERE id = ?", vec![b(id)], |r| {
            tomb_d(row0(r)?)
        })
    }
    fn tombstones_at(&self, path_key: &str) -> StoreResult<Vec<TombstoneRow>> {
        self.all(
            "SELECT row FROM st_tomb WHERE path_key = ? ORDER BY id",
            vec![t(path_key)],
            |r| tomb_d(row0(r)?),
        )
    }
    fn tombstones(&self, p: Page) -> StoreResult<Vec<TombstoneRow>> {
        let mut params = vec![];
        let sql = Self::page_sql("SELECT row FROM st_tomb", "1", p, &mut params);
        self.all(&sql, params, |r| tomb_d(row0(r)?))
    }
    fn alias(&self, path_key: &str) -> StoreResult<Option<Uuid>> {
        Ok(self
            .one(
                "SELECT row FROM st_alias WHERE path_key = ?",
                vec![t(path_key)],
                |r| alias_d(row0(r)?),
            )?
            .map(|a| a.record))
    }
    fn aliases(&self) -> StoreResult<Vec<AliasRow>> {
        self.all(
            "SELECT row FROM st_alias ORDER BY path, path_key",
            vec![],
            |r| alias_d(row0(r)?),
        )
    }
    fn conflicts(&self, of: Option<&Uuid>) -> StoreResult<Vec<ConflictRow>> {
        let all = self.all("SELECT row FROM st_conflict ORDER BY m, cid", vec![], |r| {
            conflict_d(row0(r)?)
        })?;
        Ok(all
            .into_iter()
            .filter(|c| of.is_none_or(|id| c.conflict.id == *id))
            .collect())
    }
    fn conflict_count(&self) -> StoreResult<u64> {
        Ok(self
            .one("SELECT count(*) FROM st_conflict", vec![], |r| {
                u64_of(row0(r)?)
            })?
            .unwrap_or(0))
    }
    fn receipt(&self, mutation: &Uuid) -> StoreResult<Option<ReceiptRow>> {
        self.one(
            "SELECT m, seq, time FROM st_receipt WHERE m = ?",
            vec![b(mutation)],
            receipt_row,
        )
    }
    fn receipts(&self, after: Option<Uuid>, limit: u32) -> StoreResult<Vec<ReceiptRow>> {
        let mut params = vec![];
        let mut sql = "SELECT m, seq, time FROM st_receipt".to_string();
        if let Some(a) = after {
            sql.push_str(" WHERE m > ?");
            params.push(b(&a));
        }
        sql.push_str(" ORDER BY m LIMIT ?");
        params.push(int(limit));
        self.all(&sql, params, receipt_row)
    }
    fn referrers(&self, target_keys: &[String]) -> StoreResult<Vec<Uuid>> {
        let mut out = BTreeSet::new();
        for k in target_keys {
            for id in self.all("SELECT id FROM st_link WHERE k = ?", vec![t(k)], |r| {
                uuid_of(row0(r)?)
            })? {
                out.insert(id);
            }
        }
        Ok(out.into_iter().collect())
    }
    fn unique_holders(&self, field: &str, value_key: &str) -> StoreResult<Vec<Uuid>> {
        self.all(
            "SELECT id FROM st_uniq WHERE f = ? AND v = ? ORDER BY id",
            vec![t(field), t(value_key)],
            |r| uuid_of(row0(r)?),
        )
    }
    fn candidates(&self, q: &Candidate, p: Page) -> StoreResult<Vec<RecordRow>> {
        if p.limit == 0 {
            return Ok(Vec::new());
        }
        // A superset is allowed; filter in ID order, in chunks.
        let mut out = Vec::new();
        let mut after = p.after;
        let limit = p.limit as usize;
        loop {
            let chunk = self.records(Page { after, limit: 512 })?;
            let Some(last) = chunk.last().map(|r| r.id) else {
                break;
            };
            for r in chunk {
                if candidate_matches(q, &r) {
                    out.push(r);
                    if out.len() >= limit {
                        return Ok(out);
                    }
                }
            }
            after = Some(last);
        }
        Ok(out)
    }
    fn pending(&self, after_order: Option<u64>, limit: u32) -> StoreResult<Vec<PendingRow>> {
        let (sql, params) = match after_order {
            Some(o) => (
                "SELECT row FROM st_pending WHERE ord > ? ORDER BY ord LIMIT ?",
                vec![wide_int(o)?, int(limit)],
            ),
            None => (
                "SELECT row FROM st_pending ORDER BY ord LIMIT ?",
                vec![int(limit)],
            ),
        };
        self.all(sql, params, pending_row)
    }
    fn pending_get(&self, mutation: &Uuid) -> StoreResult<Option<PendingRow>> {
        self.one(
            "SELECT row FROM st_pending WHERE m = ?",
            vec![b(mutation)],
            pending_row,
        )
    }
    fn pending_count(&self) -> StoreResult<u64> {
        Ok(self
            .one("SELECT count(*) FROM st_pending", vec![], |r| {
                u64_of(row0(r)?)
            })?
            .unwrap_or(0))
    }
    fn local_receipt(&self, mutation: &Uuid) -> StoreResult<Option<LocalReceipt>> {
        self.one(
            "SELECT row FROM st_lreceipt WHERE m = ?",
            vec![b(mutation)],
            |r| lreceipt_d(row0(r)?),
        )
    }
    fn holds(&self) -> StoreResult<Vec<Hold>> {
        self.all("SELECT row FROM st_hold ORDER BY id", vec![], hold_row)
    }
    fn hold(&self, id: &Uuid) -> StoreResult<Option<Hold>> {
        self.one(
            "SELECT row FROM st_hold WHERE id = ?",
            vec![b(id)],
            hold_row,
        )
    }
    fn meta(&self, key: &str) -> StoreResult<Option<Vec<u8>>> {
        self.one(
            "SELECT v FROM st_meta WHERE k = ?",
            vec![t(key)],
            |r| match row0(r)? {
                SqlValue::Blob(v) => Ok(v.clone()),
                _ => Err(corrupt("meta")),
            },
        )
    }
    fn transfer(&self, id: &Uuid) -> StoreResult<Option<TransferRow>> {
        self.one(
            "SELECT row FROM st_transfer WHERE id = ?",
            vec![b(id)],
            |r| transfer_d(row0(r)?),
        )
    }
    fn transfer_chunk(&self, id: &Uuid, index: u64) -> StoreResult<Option<Vec<u8>>> {
        self.one(
            "SELECT b FROM st_chunk WHERE id = ? AND i = ?",
            vec![b(id), wide_int(index)?],
            |r| match row0(r)? {
                SqlValue::Blob(v) => Ok(v.clone()),
                _ => Err(corrupt("chunk")),
            },
        )
    }
    /// Snapshot-install staging is persistent: staged rows survive a reopen
    /// until a swap or a discard (`Tx::stage`).
    fn stages(&self) -> bool {
        true
    }
    fn blob_size(&self, digest: &Hash) -> StoreResult<Option<u64>> {
        self.one(
            "SELECT length(b) FROM st_blob WHERE d = ?",
            vec![blob(digest.0.to_vec())],
            |r| u64_of(row0(r)?),
        )
    }
    fn blob_read(&self, digest: &Hash, offset: u64, len: u64) -> StoreResult<Vec<u8>> {
        if len == 0 || offset >= MAX_BLOB_BYTES {
            return Ok(Vec::new());
        }
        let size = self.blob_size(digest)?.unwrap_or(0);
        let len = len.min(size.saturating_sub(offset));
        if len == 0 {
            return Ok(Vec::new());
        }
        if size > MAX_BLOB_BYTES || len > self.limits.max_blob_patch_bytes {
            return Err(StoreError::Full);
        }
        // substr is 1-based; offset and length are bounded before conversion.
        Ok(self
            .one(
                "SELECT substr(b, ?, ?) FROM st_blob WHERE d = ?",
                vec![
                    wide_int(offset + 1)?,
                    wide_int(len)?,
                    blob(digest.0.to_vec()),
                ],
                |r| match row0(r)? {
                    SqlValue::Blob(v) => Ok(v.clone()),
                    SqlValue::Null => Ok(Vec::new()),
                    _ => Err(corrupt("blob")),
                },
            )?
            .unwrap_or_default())
    }

    fn tail(&self, after: u64, limit: u32) -> StoreResult<Vec<mdbn_replica::store::TailRow>> {
        tail::read(self, after, limit)
    }
    fn tail_stats(&self) -> StoreResult<mdbn_replica::store::TailStats> {
        tail::stats(self, "st_tail", "tail")
    }
    fn own_retained(&self, after: u64, limit: u32) -> StoreResult<Vec<(u64, PendingRow)>> {
        tail::own(self, after, limit)
    }

    fn defer_durability(&mut self, on: bool) -> StoreResult<()> {
        self.index.borrow_mut().defer_sync(on).map_err(idx_err)?;
        Ok(())
    }
    fn mirror_candidate_begin(
        &mut self,
        request: &mdbn_replica::mirror_admission::candidate::Request,
        working: &mdbn_replica::mirror_admission::install_budget::WorkingSet,
    ) -> Result<(), mdbn_replica::mirror_admission::candidate::Error> {
        mirror_candidate::begin(self, request, working)
    }
    fn mirror_candidate_reserve(
        &mut self,
        request: &mdbn_replica::mirror_admission::candidate::Request,
        ordinal: u64,
        bytes: u64,
        working: &mdbn_replica::mirror_admission::install_budget::WorkingSet,
    ) -> Result<(), mdbn_replica::mirror_admission::candidate::Error> {
        mirror_candidate::reserve(self, request, ordinal, bytes, working)
    }
    fn mirror_candidate_read(
        &mut self,
        request: &mdbn_replica::mirror_admission::candidate::Request,
        ordinal: u64,
        expected_address: &Hash,
        working: &mdbn_replica::mirror_admission::install_budget::WorkingSet,
    ) -> Result<
        mdbn_replica::mirror_admission::install_budget::Buffer,
        mdbn_replica::mirror_admission::candidate::Error,
    > {
        mirror_candidate::read(self, request, ordinal, expected_address, working)
    }
    fn mirror_candidate_write(
        &mut self,
        request: &mdbn_replica::mirror_admission::candidate::Request,
        ordinal: u64,
        body: mdbn_replica::mirror_admission::install_budget::Buffer,
        working: &mdbn_replica::mirror_admission::install_budget::WorkingSet,
    ) -> Result<(), mdbn_replica::mirror_admission::candidate::Error> {
        mirror_candidate::write(self, request, ordinal, body, working)
    }
    fn commit(&mut self, mut tx: Tx) -> StoreResult<CommitReport> {
        // Preserve the gate shape before Stage::Put moves confirmed rows. Only
        // metadata is copied; payloads are never cloned. Reject invalid input
        // before this new metadata read, preserving the pre-I/O bounds contract.
        let mut admission_shape = Tx {
            meta: tx.meta.clone(),
            ..Tx::default()
        };
        if tx != admission_shape {
            admission_shape.clear_confirmed = true;
        }
        if tx.blob_parts.len() > MAX_BLOB_PARTS_PER_TX {
            return Err(StoreError::Full);
        }
        let mut input_bytes = 0u64;
        for (_, off, bytes) in &tx.blob_parts {
            let len = bytes.len() as u64;
            if len > MAX_BLOB_PART_BYTES
                || off
                    .checked_add(len)
                    .is_none_or(|end| end > self.limits.max_blob_bytes)
            {
                return Err(StoreError::Full);
            }
            input_bytes = input_bytes
                .checked_add(len)
                .filter(|n| *n <= self.limits.max_blob_patch_bytes)
                .ok_or(StoreError::Full)?;
        }
        let mut s: Vec<Stmt> = Vec::new();
        // Snapshot-install staging (`snapshot.md` §8, `Tx::stage`): durable like
        // everything else, and in this one transaction with the rest.
        match tx.stage {
            Stage::None => {}
            Stage::Put => {
                let rows = tx.take_confirmed_rows();
                let mut staged = Vec::new();
                Self::confirmed_stmts(&rows, &mut staged)?;
                s.extend(staged_stmts(staged)?);
            }
            Stage::Swap => {
                // Confirmed state becomes the staging area, which ends empty.
                for t in CONFIRMED {
                    s.push(st(&format!("DELETE FROM st_{t}"), vec![]));
                    s.push(st(
                        &format!("INSERT INTO st_{t} SELECT * FROM sg_{t}"),
                        vec![],
                    ));
                    s.push(st(&format!("DELETE FROM sg_{t}"), vec![]));
                }
                s.push(st("DELETE FROM st_kv WHERE k = 'settings'", vec![]));
                s.push(st(
                    "INSERT INTO st_kv(k, v) SELECT k, v FROM sg_kv WHERE k = 'settings'",
                    vec![],
                ));
                s.push(st("DELETE FROM sg_kv", vec![]));
            }
            Stage::Discard => {
                for t in CONFIRMED {
                    s.push(st(&format!("DELETE FROM sg_{t}"), vec![]));
                }
                s.push(st("DELETE FROM sg_kv", vec![]));
            }
        }
        tail::append(&tx, self.limits.max_blob_patch_bytes, &mut s)?;
        if tx.clear_confirmed {
            for table in [
                "st_rec",
                "st_link",
                "st_uniq",
                "st_file",
                "st_res",
                "st_tomb",
                "st_alias",
                "st_conflict",
                "st_receipt",
            ] {
                s.push(st(&format!("DELETE FROM {table}"), vec![]));
            }
            s.push(st("DELETE FROM st_kv WHERE k = 'settings'", vec![]));
        }
        if let Some(h) = tx.head {
            s.push(st(
                "INSERT OR REPLACE INTO st_kv(k, v) VALUES ('head', ?)",
                vec![blob(head_c(&h)?)],
            ));
        }
        Self::confirmed_stmts(&tx, &mut s)?;
        if let Some(p) = tx.prune {
            s.push(st(
                "DELETE FROM st_receipt WHERE seq < ? AND time < ?",
                vec![wide_int(p.seq_floor)?, SqlValue::Integer(p.time_floor)],
            ));
            s.push(st(
                "DELETE FROM st_tomb WHERE seq < ? AND time < ?",
                vec![wide_int(p.seq_floor)?, SqlValue::Integer(p.time_floor)],
            ));
        }
        for id in &tx.pending_del {
            s.push(st("DELETE FROM st_pending WHERE m = ?", vec![b(id)]));
        }
        for p in &tx.pending_put {
            s.push(st(
                "DELETE FROM st_pending WHERE m = ? OR ord = ?",
                vec![b(&p.mutation.id), wide_int(p.order)?],
            ));
            s.push(st(
                "INSERT INTO st_pending(ord, m, row) VALUES (?, ?, ?)",
                vec![wide_int(p.order)?, b(&p.mutation.id), blob(p.to_bytes())],
            ));
        }
        for r in &tx.local_receipts_put {
            s.push(st(
                "INSERT OR REPLACE INTO st_lreceipt(m, resolved, row) VALUES (?, ?, ?)",
                vec![
                    b(&r.mutation),
                    SqlValue::Integer(r.resolved_at),
                    blob(lreceipt_c(r)?),
                ],
            ));
        }
        if let Some(tm) = tx.local_receipts_prune {
            s.push(st(
                "DELETE FROM st_lreceipt WHERE resolved < ?",
                vec![SqlValue::Integer(tm)],
            ));
        }
        for id in &tx.holds_del {
            s.push(st("DELETE FROM st_hold WHERE id = ?", vec![b(id)]));
        }
        for h in &tx.holds_put {
            s.push(st(
                "INSERT OR REPLACE INTO st_hold(id, row) VALUES (?, ?)",
                vec![b(&h.id), blob(enc(h.to_cbor())?)],
            ));
        }
        for (k, v) in &tx.meta {
            match v {
                Some(v) => s.push(st(
                    "INSERT OR REPLACE INTO st_meta(k, v) VALUES (?, ?)",
                    vec![t(k), blob(v.clone())],
                )),
                None => s.push(st("DELETE FROM st_meta WHERE k = ?", vec![t(k)])),
            }
        }
        for tr in &tx.transfers_put {
            s.push(st(
                "INSERT OR REPLACE INTO st_transfer(id, row) VALUES (?, ?)",
                vec![b(&tr.id), blob(transfer_c(tr)?)],
            ));
        }
        for (id, i, bytes) in &tx.transfer_chunks {
            s.push(st(
                "INSERT OR REPLACE INTO st_chunk(id, i, b) VALUES (?, ?, ?)",
                vec![b(id), wide_int(*i)?, blob(bytes.clone())],
            ));
        }
        for id in &tx.transfers_del {
            s.push(st("DELETE FROM st_transfer WHERE id = ?", vec![b(id)]));
            s.push(st("DELETE FROM st_chunk WHERE id = ?", vec![b(id)]));
        }
        // Blob parts patch bytes at an offset, growing with zeros (as MemStore).
        let mut parts: Vec<_> = tx.blob_parts.iter().collect();
        // Stable grouping only: overlapping writes to one digest must retain
        // Tx Vec order exactly, as MemStore does. Never sort by offset.
        parts.sort_by_key(|(d, _, _)| *d);
        let mut patched: Vec<(Hash, Vec<u8>)> = Vec::new();
        let mut working_bytes = 0u64;
        for (d, off, bytes) in parts {
            let end = off
                .checked_add(bytes.len() as u64)
                .filter(|end| *end <= self.limits.max_blob_bytes)
                .ok_or(StoreError::Full)?;
            if patched.last().is_none_or(|(x, _)| *x != *d) {
                // a failed read is never an absent/empty blob. All
                // reads and encoding finish before the write batch executes.
                let size = self.blob_size(d)?.unwrap_or(0);
                if size > self.limits.max_blob_bytes {
                    return Err(StoreError::Full);
                }
                working_bytes = working_bytes
                    .checked_add(size)
                    .filter(|n| *n <= self.limits.max_blob_patch_bytes)
                    .ok_or(StoreError::Full)?;
                let cur = self.blob_read(d, 0, size)?;
                if cur.len() as u64 != size {
                    return Err(corrupt("blob length"));
                }
                patched.push((*d, cur));
            }
            if let Some((_, buf)) = patched.last_mut() {
                let off = usize::try_from(*off).map_err(|_| StoreError::Full)?;
                let end = usize::try_from(end).map_err(|_| StoreError::Full)?;
                if buf.len() < end {
                    working_bytes = working_bytes
                        .checked_add((end - buf.len()) as u64)
                        .filter(|n| *n <= self.limits.max_blob_patch_bytes)
                        .ok_or(StoreError::Full)?;
                    buf.try_reserve_exact(end - buf.len())
                        .map_err(|_| StoreError::Full)?;
                    buf.resize(end, 0);
                }
                buf[off..end].copy_from_slice(bytes);
            }
        }
        for (d, bytes) in patched {
            s.push(st(
                "INSERT OR REPLACE INTO st_blob(d, b) VALUES (?, ?)",
                vec![blob(d.0.to_vec()), blob(bytes)],
            ));
        }
        for d in &tx.blobs_del {
            s.push(st(
                "DELETE FROM st_blob WHERE d = ?",
                vec![blob(d.0.to_vec())],
            ));
        }
        let mut derived = crate::sql_fields::maintenance(&self.index, &tx)?;
        derived.extend(crate::sql_bases::maintenance(&self.index, &tx)?);
        // This is optional derived-maintenance admission, not a new native
        // authoritative-write cap. Pending-only transactions have no derived
        // work and retain the existing durable 10k-queue contract.
        if derived.is_empty()
            || s.len()
                .checked_add(derived.len())
                .is_some_and(|n| n <= 16_384)
        {
            s.extend(derived);
        } else {
            let mut invalidation = crate::sql_fields::invalidate();
            invalidation.extend(crate::sql_bases::invalidate());
            if s.len()
                .checked_add(invalidation.len())
                .is_none_or(|n| n > 16_384)
            {
                return Err(StoreError::Full);
            }
            s.extend(invalidation);
        }
        mdbn_replica::mirror_admission::check_tx(
            self.meta(mdbn_replica::mirror_admission::META)?.as_deref(),
            &admission_shape,
        )?;
        if !s.is_empty() {
            self.index
                .borrow_mut()
                .run(&Batch {
                    mode: BatchMode::Transaction,
                    stmts: s,
                })
                .map_err(idx_err)?;
        }
        Ok(CommitReport::default())
    }
}

fn receipt_row(r: &[SqlValue]) -> StoreResult<ReceiptRow> {
    match r {
        [m, SqlValue::Integer(seq), SqlValue::Integer(time)] => Ok(ReceiptRow {
            mutation: uuid_of(m)?,
            seq: u64::try_from(*seq).map_err(|_| corrupt("receipt"))?,
            time: *time,
        }),
        _ => Err(corrupt("receipt")),
    }
}

fn pending_row(r: &[SqlValue]) -> StoreResult<PendingRow> {
    match row0(r)? {
        SqlValue::Blob(bytes) => PendingRow::from_bytes(bytes).map_err(|_| corrupt("pending")),
        _ => Err(corrupt("pending")),
    }
}

fn hold_row(r: &[SqlValue]) -> StoreResult<Hold> {
    match row0(r)? {
        SqlValue::Blob(bytes) => {
            let c = cbor::decode(bytes).map_err(|_| corrupt("hold"))?;
            w::<Hold>(&c, "hold")
        }
        _ => Err(corrupt("hold")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::{IndexDurability, IndexInfo, OpenState};
    use std::cell::Cell;

    #[test]
    fn typed_content_codec_keeps_legacy_bytes_and_refuses_unknown_attachment_profile() {
        use mdbn_wire::attachment::{AttachmentContentV1, AttachmentRefV1, FileContent};
        use mdbn_wire::common::B32;
        let blob = mdbn_wire::intent::BlobRef {
            plain_hash: B32([1; 32]),
            size: 12,
            blob_id: B32([2; 32]),
            id_epoch: 1,
            part_size: 1024,
        };
        let mut row = FileRow {
            kind: mdbn_wire::unindexed_markdown::FileKindV1::Ordinary,
            id: B16([3; 16]),
            path: "legacy.bin".into(),
            path_key: "legacy.bin".into(),
            content: FileContent::Blob(blob.clone()),
            media: MediaClass::Other,
            modified_seq: 7,
            bucket: 5,
            local: FileLocal::Remote,
        };
        let original_layout = Cbor::Array(vec![
            row.id.to_cbor(),
            row.path.to_cbor(),
            row.path_key.to_cbor(),
            blob.to_cbor(),
            row.media.to_cbor(),
            row.modified_seq.to_cbor(),
            u64::from(row.bucket).to_cbor(),
            local_c(row.local),
        ]);
        assert_eq!(
            file_c(&row).unwrap(),
            enc(original_layout).unwrap(),
            "legacy eight-tuple bytes unchanged"
        );
        assert_eq!(file_d(&SqlValue::Blob(file_c(&row).unwrap())).unwrap(), row);
        let content = AttachmentContentV1 {
            reference: AttachmentRefV1 {
                collection: B16([4; 16]),
                key_epoch: 2,
                attachment_id: B32([5; 32]),
                manifest_cipher_hash: B32([6; 32]),
            },
            whole_plain_hash: B32([7; 32]),
            total_plain_bytes: 1 << 30,
        };
        row.content = FileContent::AttachmentV1(content.clone());
        assert_eq!(file_d(&SqlValue::Blob(file_c(&row).unwrap())).unwrap(), row);
        let mut encoded = dec(&SqlValue::Blob(file_c(&row).unwrap()), "file").unwrap();
        let Cbor::Array(tuple) = &mut encoded[3] else {
            panic!("attachment tuple");
        };
        tuple[0] = Cbor::Uint(99);
        assert!(
            matches!(
                file_d(&SqlValue::Blob(enc(Cbor::Array(encoded)).unwrap())),
                Err(StoreError::Corrupt(_))
            ),
            "future critical profile never falls back to Blob"
        );
        let mut tomb = TombstoneRow {
            id: row.id,
            kind: EntityKind::File,
            path: row.path.clone(),
            path_key: row.path_key.clone(),
            last: TombstoneLast::Blob(blob.clone()),
            seq: 9,
            time: 123,
        };
        let original_tomb = Cbor::Array(vec![
            tomb.id.to_cbor(),
            tomb.kind.to_cbor(),
            tomb.path.to_cbor(),
            tomb.path_key.to_cbor(),
            Cbor::Array(vec![Cbor::Uint(1), blob.to_cbor()]),
            tomb.seq.to_cbor(),
            tomb.time.to_cbor(),
        ]);
        assert_eq!(
            tomb_c(&tomb).unwrap(),
            enc(original_tomb).unwrap(),
            "legacy Blob tomb bytes unchanged"
        );
        tomb.last = TombstoneLast::Attachment(content);
        assert_eq!(
            tomb_d(&SqlValue::Blob(tomb_c(&tomb).unwrap())).unwrap(),
            tomb
        );
        let mut encoded = dec(&SqlValue::Blob(tomb_c(&tomb).unwrap()), "tombstone").unwrap();
        let Cbor::Array(last) = &mut encoded[4] else {
            panic!("last content tuple");
        };
        assert_eq!(last[0], Cbor::Uint(2));
        last[0] = Cbor::Uint(99);
        assert!(matches!(
            tomb_d(&SqlValue::Blob(enc(Cbor::Array(encoded)).unwrap())),
            Err(StoreError::Corrupt(_))
        ));
    }

    #[test]
    fn unindexed_native_rows_and_tombs_keep_kind_and_full_content_without_fallback() {
        use mdbn_wire::attachment::{AttachmentContentV1, AttachmentRefV1, FileContent};
        use mdbn_wire::common::B32;
        use mdbn_wire::unindexed_markdown::{FileKindV1, UnindexedMarkdownPayloadV1};
        let blob = mdbn_wire::intent::BlobRef {
            plain_hash: B32([1; 32]),
            size: 2_000_000,
            blob_id: B32([2; 32]),
            id_epoch: 1,
            part_size: 8_388_608,
        };
        let attachment = AttachmentContentV1 {
            reference: AttachmentRefV1 {
                collection: B16([4; 16]),
                key_epoch: 2,
                attachment_id: B32([5; 32]),
                manifest_cipher_hash: B32([6; 32]),
            },
            whole_plain_hash: B32([7; 32]),
            total_plain_bytes: 2_000_000,
        };
        for content in [
            FileContent::Blob(blob),
            FileContent::AttachmentV1(attachment),
        ] {
            let row = FileRow {
                kind: FileKindV1::UnindexedOversizedMarkdown,
                id: B16([3; 16]),
                path: "notes/huge.md".into(),
                path_key: "notes/huge.md".into(),
                content,
                media: MediaClass::Other,
                modified_seq: 7,
                bucket: 5,
                local: FileLocal::Remote,
            };
            let bytes = file_c(&row).unwrap();
            assert_eq!(file_d(&SqlValue::Blob(bytes.clone())).unwrap(), row);
            let original = dec(&SqlValue::Blob(bytes), "file").unwrap();
            assert!(
                FileContent::from_cbor(&original[3])
                    .unwrap_err()
                    .is_unknown(),
                "older attachment/Blob decoder whole-refuses native payload envelope"
            );
            let Cbor::Array(payload) = &original[3] else {
                panic!("payload")
            };
            assert_eq!(
                &payload[..3],
                &[Cbor::Uint(2), Cbor::Uint(1), Cbor::Uint(1)]
            );
            for (index, value) in [(0, 99), (1, 2), (2, 0), (2, 2)] {
                let mut bad = original.clone();
                let Cbor::Array(p) = &mut bad[3] else {
                    panic!("payload")
                };
                p[index] = Cbor::Uint(value);
                assert!(matches!(
                    file_d(&SqlValue::Blob(enc(Cbor::Array(bad)).unwrap())),
                    Err(StoreError::Corrupt(_))
                ));
            }
            let last = TombstoneLast::from_file(&row).unwrap();
            assert_eq!(
                last,
                TombstoneLast::UnindexedMarkdown(UnindexedMarkdownPayloadV1 {
                    content: row.content.clone()
                })
            );
            let mut t = TombstoneRow {
                id: row.id,
                kind: EntityKind::File,
                path: row.path,
                path_key: row.path_key,
                last,
                seq: 9,
                time: 123,
            };
            let encoded = tomb_c(&t).unwrap();
            assert_eq!(tomb_d(&SqlValue::Blob(encoded.clone())).unwrap(), t);
            let mut bad = dec(&SqlValue::Blob(encoded), "tombstone").unwrap();
            bad[1] = EntityKind::Record.to_cbor();
            assert!(matches!(
                tomb_d(&SqlValue::Blob(enc(Cbor::Array(bad)).unwrap())),
                Err(StoreError::Corrupt(_))
            ));
            t.kind = EntityKind::Record;
            assert!(tomb_c(&t).is_err());
        }
    }

    struct CountingIndex(Rc<Cell<u32>>, IndexDurability);
    impl IndexStorage for CountingIndex {
        fn info(&self) -> IndexInfo {
            IndexInfo {
                durability: self.1,
                opened: OpenState::Fresh,
                sqlite_version: 3_045_000,
            }
        }
        fn run(&mut self, batch: &Batch) -> Result<Vec<StmtResult>, IndexError> {
            self.0.set(self.0.get() + 1);
            Ok(vec![StmtResult::default(); batch.stmts.len()])
        }
        fn reset(&mut self) -> Result<(), IndexError> {
            self.0.set(self.0.get() + 1);
            Ok(())
        }
    }

    #[test]
    fn disposable_raw_store_is_rejected_before_schema_or_reset_io() {
        for explicit_limits in [false, true] {
            let calls = Rc::new(Cell::new(0));
            let index = Rc::new(RefCell::new(CountingIndex(
                calls.clone(),
                IndexDurability::Disposable,
            )));
            let result = if explicit_limits {
                SqlStore::open_with_limits(index, SqlStoreLimits::DESKTOP)
            } else {
                SqlStore::open(index)
            };
            assert!(matches!(result, Err(StoreError::Io(_))));
            assert_eq!(
                calls.get(),
                0,
                "reject before any schema SQL or destructive reset"
            );
        }
    }

    #[test]
    fn durable_raw_store_constructor_executes_schema() {
        for explicit_limits in [false, true] {
            let calls = Rc::new(Cell::new(0));
            let index = Rc::new(RefCell::new(CountingIndex(
                calls.clone(),
                IndexDurability::Durable,
            )));
            let result = if explicit_limits {
                SqlStore::open_with_limits(index, SqlStoreLimits::DESKTOP)
            } else {
                SqlStore::open(index)
            };
            assert!(result.is_ok());
            assert_eq!(calls.get(), 1);
        }
    }

    #[test]
    fn invalid_cbor_input_never_becomes_an_empty_stored_row() {
        let calls = Rc::new(Cell::new(0));
        let mut s = SqlStore::open(Rc::new(RefCell::new(CountingIndex(
            calls.clone(),
            IndexDurability::Durable,
        ))))
        .unwrap();
        let mut r = mdbn_replica::conformance::record(1, "a.md", "a");
        r.meta.effective = DataMap(vec![("n".into(), Value::Float(f64::NAN))]);
        let before = calls.get();
        assert!(
            s.commit(Tx {
                records_put: vec![r],
                meta: vec![("must-not-commit".into(), Some(vec![1]))],
                ..Tx::default()
            })
            .is_err()
        );
        assert_eq!(calls.get(), before, "encoding must finish before writes");
        assert!(enc(Cbor::Float(f64::INFINITY)).is_err());
    }

    #[test]
    fn protocol_part_and_count_limits_fail_before_io() {
        let calls = Rc::new(Cell::new(0));
        let mut s = SqlStore::open(Rc::new(RefCell::new(CountingIndex(
            calls.clone(),
            IndexDurability::Durable,
        ))))
        .unwrap();
        assert_eq!(s.limits, SqlStoreLimits::MOBILE);
        let hash = crate::publish::revision(b"blob");
        let before = calls.get();
        for parts in [
            vec![(hash, 0, vec![0; MAX_BLOB_PART_BYTES as usize + 1])],
            vec![(hash, 0, Vec::new()); MAX_BLOB_PARTS_PER_TX + 1],
            vec![(hash, SqlStoreLimits::MOBILE.max_blob_bytes, vec![1])],
        ] {
            assert!(matches!(
                s.commit(Tx {
                    blob_parts: parts,
                    ..Tx::default()
                }),
                Err(StoreError::Full)
            ));
            assert_eq!(calls.get(), before, "reject bounds before any I/O");
        }
    }

    #[test]
    fn sql_integer_conversion_is_checked_not_saturated() {
        assert_eq!(
            wide_int(i64::MAX as u64).unwrap(),
            SqlValue::Integer(i64::MAX)
        );
        assert!(wide_int(i64::MAX as u64 + 1).is_err());
        assert!(wide_int(u64::MAX).is_err());
        assert_eq!(int(u32::MAX), SqlValue::Integer(i64::from(u32::MAX)));
    }
}
