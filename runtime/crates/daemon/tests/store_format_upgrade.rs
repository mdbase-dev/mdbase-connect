//! On-disk upgrade guard for a collection's private replica store
//! (`<private dir>/index.sqlite`: `SqlStore` over the native `SqliteIndex`).
//!
//! The store has no format-version number. Its schema is additive
//! (`CREATE ... IF NOT EXISTS` on every open), and rows are canonical CBOR blobs.
//! mdbase-next has not released a build yet (its tags come from the old
//! mdbase-connect history and are not ancestors of `main`), so no released
//! "previous version" exists. These tests stand in for one:
//!
//! - `fixtures/store-format-v1.sql` is a dump of the current on-disk format
//!   (schema and rows), pinned. [`current_writer_still_produces_the_pinned_format`]
//!   fails as soon as the schema or any row encoding changes. Whoever changes
//!   it must keep this file as the N-1 fixture (with the open test below
//!   pointing at it, so the upgrade path is proven), and pin a new one.
//! - [`pinned_v1_state_opens_with_data_and_sync_position`] opens that state
//!   with the current code: records, pending writes, receipts, tombstones,
//!   resources, metadata and the applied head (the sync position) survive, and
//!   the store stays writable.
//! - [`first_format_state_upgrades_in_place`] opens the same state restricted
//!   to the tables the first `SqlStore` (8a99c23ae, 2026-10-04) created, before
//!   staging twins, the retained tail, derived fields, raw Bases and mirror
//!   candidates were added. The current open adds the missing tables and keeps
//!   the data and head.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::atomic::{AtomicU32, Ordering};

use mdbn_platform_native::SqliteIndex;
use mdbn_replica::store::{
    Head, Page, PendingRow, ReceiptRow, RecordMeta, RecordRow, Store, TailRow, TombstoneLast,
    TombstoneRow, Tx, bucket16, meta_keys,
};
use mdbn_store_file::index::IndexDurability;
use mdbn_store_file::{SqlStore, SqlStoreLimits};
use mdbn_wire::common::{B16, B32};
use mdbn_wire::intent::{Delete, Mutation, Op, OpClock, Source};
use mdbn_wire::snapshot::EntityKind;

const FIXTURE: &str = include_str!("fixtures/store-format-v1.sql");

/// Tables (and their indexes) the first `SqlStore` schema created
/// (`git show 8a99c23ae:crates/store-file/src/sql.rs`). Their DDL is unchanged.
const FIRST_FORMAT_TABLES: &[&str] = &[
    "st_kv",
    "st_meta",
    "st_rec",
    "st_link",
    "st_uniq",
    "st_file",
    "st_res",
    "st_tomb",
    "st_alias",
    "st_conflict",
    "st_receipt",
    "st_pending",
    "st_lreceipt",
    "st_hold",
    "st_transfer",
    "st_chunk",
    "st_blob",
];

/// The sync position the fixture holds.
const HEAD: Head = Head {
    seq: 42,
    chain: B32([0x42; 32]),
};

fn scratch(tag: &str) -> PathBuf {
    static NEXT: AtomicU32 = AtomicU32::new(0);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let p = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
        .join(format!("store-format-{tag}-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&p);
    std::fs::create_dir_all(&p).unwrap();
    p
}

fn open(path: &Path) -> SqlStore<SqliteIndex> {
    let index = SqliteIndex::open(path, IndexDurability::Durable).expect("index opens");
    SqlStore::open_with_limits(Rc::new(RefCell::new(index)), SqlStoreLimits::DESKTOP)
        .expect("store opens")
}

fn record(n: u8, path: &str, doc: &str, seq: u64) -> RecordRow {
    let id = B16([n; 16]);
    RecordRow {
        id,
        path: path.into(),
        path_key: path.to_lowercase(),
        revision: mdbn_wire::hash::sha256(doc.as_bytes()),
        doc: doc.into(),
        modified_seq: seq,
        bucket: bucket16(&id),
        meta: RecordMeta::default(),
    }
}

fn records() -> Vec<RecordRow> {
    vec![
        record(1, "Notes/Alpha.md", "---\ntitle: Alpha\n---\nbody\n", 40),
        // CRLF and non-ASCII text must come back byte-for-byte.
        record(
            2,
            "Notes/Beta.md",
            "---\r\ntitle: Bêta ✓\r\n---\r\nline\r\n",
            41,
        ),
    ]
}

/// A pending (captured, unconfirmed) write: losing it loses an acknowledged
/// edit. Without `refs` it uses the earlier six-element row encoding.
fn pending() -> PendingRow {
    PendingRow {
        order: 7,
        mutation: Mutation {
            id: B16([0x70; 16]),
            origin: B16([0x71; 16]),
            base_seq: 42,
            clock: OpClock {
                instant: 1_700_000_000_000,
                tz: "UTC".into(),
                local_date: "2023-11-14".into(),
            },
            seed: B32([0x72; 32]),
            source: Source::Api,
            ops: vec![Op::Delete(Delete {
                id: B16([1; 16]),
                base_revision: None,
                if_revision: None,
            })],
            on_behalf: None,
            conflict_mode: None,
            validated_at: None,
            room: None,
        }
        .into(),
        effects: Vec::new(),
        touches: vec!["i:01010101010101010101010101010101".into()],
        grant: None,
        uploads: Vec::new(),
        refs: Vec::new(),
    }
}

fn receipt() -> ReceiptRow {
    ReceiptRow {
        mutation: B16([0x60; 16]),
        seq: 41,
        time: 1_699_999_999_000,
    }
}

fn tombstone() -> TombstoneRow {
    TombstoneRow {
        id: B16([3; 16]),
        kind: EntityKind::Record,
        path: "Gone.md".into(),
        path_key: "gone.md".into(),
        last: TombstoneLast::Doc("last words\n".into()),
        seq: 39,
        time: 1_699_999_998_000,
    }
}

fn resource() -> (String, String) {
    ("mdbase.yaml".into(), "spec_version: '0.3.0'\n".into())
}

fn meta() -> Vec<(String, Vec<u8>)> {
    vec![
        (meta_keys::GENESIS.into(), vec![0x9a; 32]),
        (meta_keys::LOG_STATE.into(), b"opaque log state".to_vec()),
    ]
}

/// The retained tail: the applied item at the head, kept for repair.
fn tail() -> TailRow {
    TailRow {
        seq: 42,
        item: b"applied item envelope".to_vec(),
        applied_at: 1_700_000_000_500,
    }
}

/// Write the fixture's logical content with the current code.
fn populate(store: &mut SqlStore<SqliteIndex>) {
    store
        .commit(Tx {
            head: Some(HEAD),
            records_put: records(),
            resources_put: vec![resource()],
            tombstones_put: vec![tombstone()],
            receipts_put: vec![receipt()],
            pending_put: vec![pending()],
            tail_put: vec![tail()],
            meta: meta().into_iter().map(|(k, v)| (k, Some(v))).collect(),
            ..Tx::default()
        })
        .expect("populate");
}

/// The applied head, every replicated row kind and the pending queue are intact.
fn assert_fixture_content(store: &SqlStore<SqliteIndex>) {
    assert_eq!(store.head().unwrap(), HEAD, "sync position survives");
    let all = Page {
        after: None,
        limit: 100,
    };
    assert_eq!(store.records(all).unwrap(), records());
    for r in records() {
        assert_eq!(store.record_at(&r.path_key).unwrap(), Some(r.id));
    }
    assert_eq!(store.pending(None, 100).unwrap(), vec![pending()]);
    assert_eq!(store.receipt(&receipt().mutation).unwrap(), Some(receipt()));
    assert_eq!(store.tombstones(all).unwrap(), vec![tombstone()]);
    assert_eq!(store.resources().unwrap(), vec![resource()]);
    for (k, v) in meta() {
        assert_eq!(store.meta(&k).unwrap(), Some(v), "meta {k}");
    }
}

/// After the upgrade the store accepts writes and keeps them across a reopen.
fn assert_writable(path: &Path) {
    {
        let mut store = open(path);
        store
            .commit(Tx {
                head: Some(Head {
                    seq: 43,
                    chain: B32([0x43; 32]),
                }),
                records_put: vec![record(4, "New.md", "new\n", 43)],
                pending_del: vec![pending().mutation.id],
                ..Tx::default()
            })
            .expect("write after upgrade");
    }
    let store = open(path);
    assert_eq!(store.head().unwrap().seq, 43);
    assert_eq!(store.record_count().unwrap(), 3);
    assert_eq!(store.pending_count().unwrap(), 0);
}

// ------------------------------------------------------------ SQL dump

fn literal(v: rusqlite::types::ValueRef<'_>) -> String {
    use rusqlite::types::ValueRef;
    let hex = |b: &[u8]| b.iter().map(|x| format!("{x:02x}")).collect::<String>();
    match v {
        ValueRef::Null => "NULL".into(),
        ValueRef::Integer(i) => i.to_string(),
        ValueRef::Real(f) => panic!("unexpected REAL {f} in the store"),
        ValueRef::Text(t) => {
            if t.iter().all(|c| (0x20..0x7f).contains(c)) {
                format!("'{}'", String::from_utf8_lossy(t).replace('\'', "''"))
            } else {
                format!("CAST(X'{}' AS TEXT)", hex(t))
            }
        }
        ValueRef::Blob(b) => format!("X'{}'", hex(b)),
    }
}

/// Schema and (with `rows`) every row, deterministically
/// ordered, one statement per line. Excludes SQLite internals and the index's
/// clean-shutdown marker (`mdbn_open`).
fn dump(path: &Path, rows: bool) -> String {
    let c = rusqlite::Connection::open(path).unwrap();
    let mut out = String::new();
    let mut tables = Vec::new();
    let mut st = c
        .prepare(
            "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL \
             AND name NOT LIKE 'sqlite_%' AND tbl_name <> 'mdbn_open' \
             ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name",
        )
        .unwrap();
    let schema: Vec<(String, String, String)> = st
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    // Tables and indexes, then rows, then triggers and views: loading rows
    // must not fire triggers (they maintain counters already in the rows).
    let mut late = String::new();
    for (ty, name, sql) in schema {
        let target = if ty == "table" || ty == "index" {
            &mut out
        } else {
            &mut late
        };
        target.push_str(&sql.replace('\n', " "));
        target.push_str(";\n");
        if ty == "table" {
            tables.push(name);
        }
    }
    for t in tables.iter().filter(|_| rows) {
        let q = c.prepare(&format!("SELECT * FROM {t}")).unwrap();
        let n = q.column_count();
        let order: Vec<String> = (1..=n).map(|i| i.to_string()).collect();
        let mut q = c
            .prepare(&format!("SELECT * FROM {t} ORDER BY {}", order.join(",")))
            .unwrap();
        let mut rs = q.query([]).unwrap();
        while let Some(r) = rs.next().unwrap() {
            let vals: Vec<String> = (0..n).map(|i| literal(r.get_ref(i).unwrap())).collect();
            out.push_str(&format!("INSERT INTO {t} VALUES({});\n", vals.join(",")));
        }
    }
    out.push_str(&late);
    out
}

/// The statements of a dump file (comments and blank lines dropped).
fn statements(sql: &str) -> impl Iterator<Item = &str> {
    sql.lines()
        .map(str::trim_end)
        .filter(|l| !l.is_empty() && !l.starts_with("--"))
}

/// Recreate a database file from dump statements, outside the store code.
fn load<'a>(path: &Path, stmts: impl Iterator<Item = &'a str>) {
    let c = rusqlite::Connection::open(path).unwrap();
    let mut batch = String::from("BEGIN;\n");
    for s in stmts {
        batch.push_str(s);
        batch.push('\n');
    }
    batch.push_str("COMMIT;\n");
    c.execute_batch(&batch).expect("fixture loads");
}

fn fresh_dump(rows: bool) -> String {
    let dir = scratch(if rows { "fresh-rows" } else { "fresh-schema" });
    let path = dir.join("index.sqlite");
    {
        let mut store = open(&path);
        if rows {
            populate(&mut store);
        }
    }
    dump(&path, rows)
}

// ------------------------------------------------------------ tests

#[test]
fn current_writer_still_produces_the_pinned_format() {
    let pinned: String = statements(FIXTURE).map(|s| format!("{s}\n")).collect();
    let actual = fresh_dump(true);
    if actual != pinned {
        println!(
            "----- BEGIN current store dump -----\n{actual}----- END current store dump -----"
        );
        panic!(
            "the on-disk store format changed (schema or row encoding). Do not just \
             re-pin: keep tests/fixtures/store-format-v1.sql as the N-1 fixture with \
             a test proving the current code opens it and keeps its data and head \
             (an upgrade path), then pin the new format as store-format-v2.sql. The \
             current dump is printed above."
        );
    }
}

#[test]
fn pinned_v1_state_opens_with_data_and_sync_position() {
    let dir = scratch("v1");
    let path = dir.join("index.sqlite");
    load(&path, statements(FIXTURE));
    {
        let store = open(&path);
        assert_fixture_content(&store);
        assert_eq!(store.tail(0, 10).unwrap(), vec![tail()]);
        assert_eq!(store.tail_stats().unwrap().count, 1);
    }
    // Opening converged the schema to the current one.
    assert_eq!(dump(&path, false), fresh_dump(false));
    assert_writable(&path);
}

#[test]
fn first_format_state_upgrades_in_place() {
    let table_of = |s: &str| -> Option<String> {
        let rest = s
            .strip_prefix("INSERT INTO ")
            .or_else(|| s.split_once(" ON ").map(|(_, r)| r))
            .or_else(|| s.strip_prefix("CREATE TABLE "))?;
        Some(
            rest.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
                .next()?
                .to_owned(),
        )
    };
    let first: Vec<&str> = statements(FIXTURE)
        .filter(|s| table_of(s).is_some_and(|t| FIRST_FORMAT_TABLES.contains(&t.as_str())))
        .collect();
    // The restriction really removed later tables and kept the populated rows.
    assert!(first.len() < statements(FIXTURE).count());
    assert!(
        first
            .iter()
            .any(|s| s.starts_with("INSERT INTO st_pending"))
    );
    assert!(
        !first
            .iter()
            .any(|s| s.contains("sg_") || s.contains("st_tail"))
    );

    let dir = scratch("first");
    let path = dir.join("index.sqlite");
    load(&path, first.into_iter());
    {
        let store = open(&path);
        assert_fixture_content(&store);
    }
    assert_eq!(
        dump(&path, false),
        fresh_dump(false),
        "opening added every table created since the first format"
    );
    assert_writable(&path);
}
