//! Atomic derived field-index maintenance. Invalid optional projections fence
//! indexed reads, but never reject otherwise valid authoritative record writes.
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::rc::Rc;

use crate::index::{Batch, BatchMode, IndexError, IndexErrorKind, IndexStorage, SqlValue, Stmt};
use crate::sql::head_d;
use mdbn_core::query::indexed::SortAtom;
use mdbn_replica::store::{Head, StoreError, StoreResult, Tx};
use mdbn_replica::store_query::{
    MAX_ROW_BODY_BYTES, MAX_TX_BODY_BYTES, QueryField, QueryIndexState,
};

pub(crate) const SCHEMA: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS st_qstate(slot INTEGER PRIMARY KEY CHECK(slot=0), generation BLOB NOT NULL, ready INTEGER NOT NULL CHECK(ready IN (0,1)))",
    "CREATE TABLE IF NOT EXISTS st_qspec(source INTEGER NOT NULL, field BLOB NOT NULL, PRIMARY KEY(source,field)) WITHOUT ROWID",
    "CREATE TABLE IF NOT EXISTS st_qrecord(id BLOB PRIMARY KEY, path BLOB NOT NULL) WITHOUT ROWID",
    "CREATE INDEX IF NOT EXISTS st_qrecord_path ON st_qrecord(path,id)",
    "CREATE TABLE IF NOT EXISTS st_qtype(name TEXT NOT NULL,id BLOB NOT NULL,PRIMARY KEY(name,id)) WITHOUT ROWID",
    "CREATE INDEX IF NOT EXISTS st_qtype_id ON st_qtype(id)",
];

/// The body index: each live record's body index text, under an FTS5 rowid
/// that `st_qbody_n` maps to the record. Exact substring search for needles of
/// at least three characters. Contentless: the text is not stored again.
///
/// Created at every open, not by a schema version: these tables are derived,
/// and a runtime from before them ignores them and keeps the store openable,
/// so a rollback stays possible. Its index rows carry an older query
/// generation, which makes a later runtime rebuild them. Move these statements
/// into the next numbered migration.
pub(crate) const BODY_SCHEMA: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS st_qbody_n(n INTEGER PRIMARY KEY, id BLOB NOT NULL UNIQUE)",
    "CREATE VIRTUAL TABLE IF NOT EXISTS st_qbody USING fts5(t, tokenize='trigram case_sensitive 1', content='', contentless_delete=1)",
];

/// The mtime index: each live record's `file.mtime` sort atom and exact path,
/// with ascending and descending B-tree indexes ending in `path ASC`.
///
/// Created at every open, not by a schema version, like [`BODY_SCHEMA`]: it is
/// derived, so an older runtime ignores it and keeps the store openable. Its
/// rows are populated under projection version 4, which makes a newer runtime
/// rebuild an earlier index once.
pub(crate) const MTIME_SCHEMA: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS st_qmtime(id BLOB PRIMARY KEY,kind INTEGER NOT NULL,sort BLOB NOT NULL,path BLOB NOT NULL) WITHOUT ROWID",
    "CREATE INDEX IF NOT EXISTS st_qmtime_asc ON st_qmtime(kind,sort,path)",
    "CREATE INDEX IF NOT EXISTS st_qmtime_desc ON st_qmtime(kind DESC,sort DESC,path ASC)",
];

/// Schema version 2 replaces the field index: each row carries its record's
/// exact path, so one B-tree seek yields a field's order with the final
/// ascending path tie-break. Version 1 rows (ID tie-break) are dropped with
/// their coverage; the replica rebuilds under the new key version.
pub(crate) const FIELD_SCHEMA: &[&str] = &[
    "DROP TABLE IF EXISTS st_field",
    "CREATE TABLE st_field(id BLOB NOT NULL,source INTEGER NOT NULL,field BLOB NOT NULL,kind INTEGER NOT NULL,sort BLOB NOT NULL,hint INTEGER NOT NULL,path BLOB NOT NULL,PRIMARY KEY(id,source,field)) WITHOUT ROWID",
    "CREATE INDEX st_field_asc ON st_field(source,field,kind,sort,path)",
    "CREATE INDEX st_field_desc ON st_field(source,field,kind DESC,sort DESC,path ASC)",
    "DELETE FROM st_qrecord",
    "DELETE FROM st_qmtime",
    "DELETE FROM st_qtype",
    "UPDATE st_qstate SET ready=0 WHERE slot=0",
];

fn error(e: IndexError) -> StoreError {
    if e.kind == IndexErrorKind::Full {
        StoreError::Full
    } else {
        StoreError::Io(format!("SQL query index: {e}"))
    }
}
fn corrupt() -> StoreError {
    StoreError::Io("corrupt SQL query index metadata".into())
}
fn blob(bytes: &[u8]) -> SqlValue {
    SqlValue::Blob(bytes.to_vec())
}
pub(crate) fn invalidate() -> Vec<Stmt> {
    // Coverage alone cannot distinguish a retained OLD projection from a
    // changed authoritative row. Erase derived coverage on invalidation so a
    // later valid incremental write cannot silently reactivate stale fields.
    let mut out = vec![
        Stmt::new("DELETE FROM st_field", vec![]),
        Stmt::new("DELETE FROM st_qrecord", vec![]),
        Stmt::new("DELETE FROM st_qmtime", vec![]),
        Stmt::new("DELETE FROM st_qtype", vec![]),
    ];
    clear_bodies(&mut out);
    out.push(Stmt::new(
        "UPDATE st_qstate SET ready=0 WHERE slot=0",
        vec![],
    ));
    out
}
fn clear_bodies(out: &mut Vec<Stmt>) {
    out.push(Stmt::new("DELETE FROM st_qbody_n", vec![]));
    out.push(Stmt::new(
        "INSERT INTO st_qbody(st_qbody) VALUES('delete-all')",
        vec![],
    ));
}

/// Read-only shared schema status; does not create tables or claim durability.
pub fn state<I: IndexStorage>(index: &Rc<RefCell<I>>) -> StoreResult<Option<QueryIndexState>> {
    let results = index
        .borrow_mut()
        .run(&Batch {
            mode: BatchMode::Autocommit,
            stmts: vec![
                Stmt::new(
                    "SELECT CASE WHEN length(generation)=32 THEN generation ELSE NULL END,ready FROM st_qstate WHERE slot=0",
                    vec![],
                ),
                Stmt::new(
                    "SELECT source,CASE WHEN length(field)<=1024 THEN field ELSE NULL END FROM st_qspec ORDER BY source,field LIMIT 17",
                    vec![],
                ),
                Stmt::new("SELECT CASE WHEN length(v)<=128 THEN v ELSE NULL END FROM st_kv WHERE k='head'", vec![]),
            ],
        })
        .map_err(error)?;
    if results.len() != 3
        || results[0].columns != 2
        || results[1].columns != 2
        || results[2].columns != 1
    {
        return Err(corrupt());
    }
    if results[0].values.is_empty() {
        return Ok(None);
    }
    let [SqlValue::Blob(g), SqlValue::Integer(ready)] = results[0].values.as_slice() else {
        return Err(corrupt());
    };
    let generation = g.as_slice().try_into().map_err(|_| corrupt())?;
    if !matches!(*ready, 0 | 1) || results[1].values.len() % 2 != 0 || results[1].values.len() > 32
    {
        return Err(corrupt());
    }
    let mut fields = Vec::new();
    for pair in results[1].values.chunks_exact(2) {
        let [SqlValue::Integer(source), SqlValue::Blob(path_key)] = pair else {
            return Err(corrupt());
        };
        let source = u8::try_from(*source).map_err(|_| corrupt())?;
        if source > 1 || path_key.len() > 1024 {
            return Err(corrupt());
        }
        fields.push(QueryField {
            source,
            path_key: path_key.clone(),
        });
    }
    let head = match results[2].values.as_slice() {
        [] => Head::GENESIS,
        [v] => head_d(v)?,
        _ => return Err(corrupt()),
    };
    Ok(Some(QueryIndexState {
        generation,
        head,
        fields,
        ready: *ready == 1,
    }))
}

/// Coverage of one record ID, given complete coverage before the transaction:
/// a live record has exactly one `st_qrecord` row, one `st_qmtime` row, and
/// one `st_field` row per declared spec, all of them declared; a removed record
/// has none.
const TOUCHED_COVERAGE: &str = "UPDATE st_qstate SET ready=0 WHERE slot=0 AND (EXISTS(SELECT 1 FROM st_rec WHERE id=?) IS NOT EXISTS(SELECT 1 FROM st_qrecord WHERE id=?) OR EXISTS(SELECT 1 FROM st_rec WHERE id=?) IS NOT EXISTS(SELECT 1 FROM st_qmtime WHERE id=?) OR (SELECT count(*) FROM st_field WHERE id=?) IS NOT CASE WHEN EXISTS(SELECT 1 FROM st_rec WHERE id=?) THEN (SELECT count(*) FROM st_qspec) ELSE 0 END OR EXISTS(SELECT 1 FROM st_field f LEFT JOIN st_qspec s ON s.source=f.source AND s.field=f.field WHERE f.id=? AND s.field IS NULL) OR (SELECT count(*) FROM st_qrecord WHERE id=?) > 1)";

pub(crate) fn delete_row(id: &[u8], stmts: &mut Vec<Stmt>) {
    delete_fields(id, stmts);
    delete_bodies(&[id], stmts);
}
fn delete_fields(id: &[u8], stmts: &mut Vec<Stmt>) {
    for table in ["st_field", "st_qrecord", "st_qmtime", "st_qtype"] {
        stmts.push(Stmt::new(
            format!("DELETE FROM {table} WHERE id=?"),
            vec![blob(id)],
        ));
    }
}
/// IDs per body statement: a hosted statement binds at most 100 values.
const BODY_IDS: usize = 100;
fn delete_bodies(ids: &[&[u8]], stmts: &mut Vec<Stmt>) {
    for chunk in ids.chunks(BODY_IDS) {
        let marks = vec!["?"; chunk.len()].join(",");
        let params: Vec<_> = chunk.iter().map(|id| blob(id)).collect();
        stmts.push(Stmt::new(
            format!("DELETE FROM st_qbody WHERE rowid IN (SELECT n FROM st_qbody_n WHERE id IN ({marks}))"),
            params.clone(),
        ));
        stmts.push(Stmt::new(
            format!("DELETE FROM st_qbody_n WHERE id IN ({marks})"),
            params,
        ));
    }
}
/// Replace these records' bodies: a few multi-row statements per hundred
/// records, not several per record.
fn put_bodies(rows: &[(&[u8], &str)], stmts: &mut Vec<Stmt>) {
    let ids: Vec<_> = rows.iter().map(|(id, _)| *id).collect();
    delete_bodies(&ids, stmts);
    for chunk in ids.chunks(BODY_IDS) {
        stmts.push(Stmt::new(
            format!(
                "INSERT INTO st_qbody_n(id) VALUES {}",
                vec!["(?)"; chunk.len()].join(",")
            ),
            chunk.iter().map(|id| blob(id)).collect(),
        ));
    }
    for chunk in rows.chunks(BODY_IDS / 2) {
        stmts.push(Stmt::new(
            format!(
                "INSERT INTO st_qbody(rowid,t) VALUES {}",
                vec!["((SELECT n FROM st_qbody_n WHERE id=?),?)"; chunk.len()].join(",")
            ),
            chunk
                .iter()
                .flat_map(|(id, body)| [blob(id), SqlValue::Text((*body).to_owned())])
                .collect(),
        ));
    }
}
/// Statements [`put_bodies`] writes for `n` records, at most.
fn body_statements(n: usize) -> usize {
    4 * n.div_ceil(BODY_IDS) + n.div_ceil(BODY_IDS / 2)
}

/// Plan ONLY optional derived statements; storage errors remain genuine errors.
/// Returned statements append to the SAME transaction after authoritative rows.
pub(crate) fn maintenance<I: IndexStorage>(
    index: &Rc<RefCell<I>>,
    tx: &Tx,
) -> StoreResult<Vec<Stmt>> {
    let changed = tx.stage == mdbn_replica::store::Stage::Swap
        || tx.clear_confirmed
        || !tx.records_put.is_empty()
        || !tx.resources_put.is_empty()
        || !tx.resources_del.is_empty();
    let Some(update) = &tx.query_index else {
        return Ok(if changed { invalidate() } else { vec![] });
    };
    // Optional-width checks precede cloning caller-controlled specs or sets.
    if update.rows.len() > 500
        || update.replace_specs.as_ref().is_some_and(|fields| {
            fields.len() > 16
                || fields
                    .iter()
                    .any(|f| f.source > 1 || f.path_key.len() > 1024)
        })
    {
        return Ok(invalidate());
    }
    let existing = state(index)?;
    let fields = match &update.replace_specs {
        Some(fields) => fields.clone(),
        None => match &existing {
            Some(s) if s.generation == update.generation => s.fields.clone(),
            _ => return Ok(invalidate()),
        },
    };
    let declared: BTreeSet<_> = fields.iter().cloned().collect();
    if fields.len() > 16
        || declared.len() != fields.len()
        || fields
            .iter()
            .any(|f| f.source > 1 || f.path_key.len() > 1024)
        || update.rows.len() > 500
    {
        return Ok(invalidate());
    }
    let put: BTreeMap<_, _> = tx.records_put.iter().map(|r| (r.id, r)).collect();
    let mut ids = BTreeSet::new();
    let mut bytes = 0usize;
    let mut body_bytes = 0usize;
    let mut statement_count = 32 + body_statements(update.rows.len());
    for r in &update.rows {
        statement_count = match statement_count.checked_add(6 + r.types.len() + r.fields.len()) {
            Some(n) if n <= 8192 => n,
            _ => return Ok(invalidate()),
        };
        if !ids.insert(r.id)
            || r.fields.len() != fields.len()
            || r.types.len() > 64
            || !matches!(r.mtime.kind, 3 | 255)
            || SortAtom::from_parts(r.mtime.kind, &r.mtime.key, 12).is_err()
            || r.fields
                .iter()
                .any(|v| v.field.source > 1 || v.field.path_key.len() > 1024)
            || put.get(&r.id).is_some_and(|base| {
                let expected = SortAtom::from_mtime(base.mtime);
                base.path != r.path
                    || r.mtime.kind != expected.kind() as u8
                    || r.mtime.key.as_slice() != expected.key()
            })
        {
            return Ok(invalidate());
        }
        let present: BTreeSet<_> = r.fields.iter().map(|v| v.field.clone()).collect();
        if present != declared {
            return Ok(invalidate());
        }
        // The generation decides whether rows carry bodies; one transaction
        // holds rows of one generation.
        if r.body.is_some() != update.rows[0].body.is_some() {
            return Ok(invalidate());
        }
        if let Some(body) = &r.body {
            body_bytes += body.len();
            if body.len() > MAX_ROW_BODY_BYTES
                || body_bytes > MAX_TX_BODY_BYTES
                || body.contains('\0')
            {
                return Ok(invalidate());
            }
        }
        // The path is written in `st_qrecord`, `st_qmtime`, and once per field row.
        bytes = match r
            .path
            .len()
            .checked_mul(2 + r.fields.len())
            .and_then(|n| n.checked_add(r.mtime.key.len()))
            .and_then(|n| bytes.checked_add(n))
        {
            Some(n) => n,
            None => return Ok(invalidate()),
        };
        for name in &r.types {
            bytes = match bytes.checked_add(name.len()) {
                Some(n) => n,
                None => return Ok(invalidate()),
            };
        }
        for v in &r.fields {
            if v.temporal_hint > 2 || SortAtom::from_parts(v.atom.kind, &v.atom.key, 8192).is_err()
            {
                return Ok(invalidate());
            }
            bytes = match bytes
                .checked_add(v.atom.key.len())
                .and_then(|n| n.checked_add(v.field.path_key.len()))
            {
                Some(n) => n,
                None => return Ok(invalidate()),
            };
        }
        if bytes > 512 << 10 {
            return Ok(invalidate());
        }
    }
    // Every live upsert must carry the matching complete trusted projection.
    if put.keys().any(|id| !ids.contains(id)) {
        return Ok(invalidate());
    }
    let mut out = Vec::new();
    if update.replace_specs.is_some() {
        for table in [
            "st_field",
            "st_qtype",
            "st_qrecord",
            "st_qmtime",
            "st_qspec",
        ] {
            out.push(Stmt::new(format!("DELETE FROM {table}"), vec![]));
        }
        clear_bodies(&mut out);
        out.push(Stmt::new(
            "INSERT OR REPLACE INTO st_qstate(slot,generation,ready) VALUES(0,?,0)",
            vec![blob(&update.generation)],
        ));
        for f in &fields {
            out.push(Stmt::new(
                "INSERT INTO st_qspec(source,field) VALUES(?,?)",
                vec![SqlValue::Integer(i64::from(f.source)), blob(&f.path_key)],
            ));
        }
    } else if !tx.resources_put.is_empty() || !tx.resources_del.is_empty() || tx.clear_confirmed {
        // Old catalogue projection cannot survive a resource change.
        return Ok(invalidate());
    }
    for r in &update.rows {
        delete_fields(&r.id.0, &mut out);
        out.push(Stmt::new(
            "INSERT INTO st_qrecord(id,path) VALUES(?,?)",
            vec![blob(&r.id.0), blob(r.path.as_bytes())],
        ));
        out.push(Stmt::new(
            "INSERT INTO st_qmtime(id,kind,sort,path) VALUES(?,?,?,?)",
            vec![
                blob(&r.id.0),
                SqlValue::Integer(i64::from(r.mtime.kind)),
                blob(&r.mtime.key),
                blob(r.path.as_bytes()),
            ],
        ));
        // Core's closed profile resolves query spelling to these exact canonical
        // catalogue membership names; the backend invents no folding semantics.
        for name in r.types.iter().cloned().collect::<BTreeSet<_>>() {
            out.push(Stmt::new(
                "INSERT INTO st_qtype(name,id) VALUES(?,?)",
                vec![SqlValue::Text(name), blob(&r.id.0)],
            ));
        }
        for v in &r.fields {
            out.push(Stmt::new(
                "INSERT INTO st_field(id,source,field,kind,sort,hint,path) VALUES(?,?,?,?,?,?,?)",
                vec![
                    blob(&r.id.0),
                    SqlValue::Integer(i64::from(v.field.source)),
                    blob(&v.field.path_key),
                    SqlValue::Integer(i64::from(v.atom.kind)),
                    blob(&v.atom.key),
                    SqlValue::Integer(i64::from(v.temporal_hint)),
                    blob(r.path.as_bytes()),
                ],
            ));
        }
    }
    let bodies: Vec<(&[u8], &str)> = update
        .rows
        .iter()
        .filter_map(|r| Some((&r.id.0[..], r.body.as_deref()?)))
        .collect();
    put_bodies(&bodies, &mut out);
    // Even an index-only incremental update must preserve backend-verified
    // live/field coverage. In particular, inserting a nonexistent ID cannot
    // retain readiness merely because the caller omitted publication. The scan
    // can only clear readiness, so it runs only when this transaction found
    // the index ready and does not reset it. Every page of a rebuild is
    // unready, and a whole-index scan per page would make a backfill
    // quadratic. Decided here, not by a `ready=1` term in the SQL, so it does
    // not depend on each SQLite engine skipping an uncorrelated subquery.
    if update.publish_at.is_none()
        && update.replace_specs.is_none()
        && existing.as_ref().is_some_and(|s| s.ready)
    {
        out.push(Stmt::new("UPDATE st_qstate SET ready=0 WHERE slot=0 AND (EXISTS(SELECT 1 FROM st_qrecord q LEFT JOIN st_rec r ON r.id=q.id WHERE r.id IS NULL) OR EXISTS(SELECT 1 FROM st_qmtime m LEFT JOIN st_rec r ON r.id=m.id WHERE r.id IS NULL) OR EXISTS(SELECT 1 FROM st_field f LEFT JOIN st_qspec s ON s.source=f.source AND s.field=f.field LEFT JOIN st_rec r ON r.id=f.id WHERE s.field IS NULL OR r.id IS NULL))", vec![]));
    }
    if let Some(head) = update.publish_at {
        let expected = if let Some(h) = tx.head {
            h
        } else if let Some(s) = &existing {
            s.head
        } else {
            let results = index
                .borrow_mut()
                .run(&Batch {
                    mode: BatchMode::Autocommit,
                    stmts: vec![Stmt::new("SELECT v FROM st_kv WHERE k='head'", vec![])],
                })
                .map_err(error)?;
            if results.len() != 1 || results[0].columns != 1 {
                return Err(corrupt());
            }
            match results[0].values.as_slice() {
                [] => Head::GENESIS,
                [v] => head_d(v)?,
                _ => return Err(corrupt()),
            }
        };
        if expected != head {
            out.extend(invalidate());
            return Ok(out);
        }
        // Incremental: coverage was backend-verified complete before this
        // transaction (ready under this generation), every upsert carries its
        // complete projection (checked above), record deletes drop their rows
        // and nothing else touches st_rec or the specs. Only the touched IDs
        // can break coverage, so verify those instead of rescanning the whole
        // collection on every local edit (O(touched), not O(collection)).
        let incremental = update.replace_specs.is_none()
            && !tx.clear_confirmed
            && tx.stage == mdbn_replica::store::Stage::None
            && existing
                .as_ref()
                .is_some_and(|s| s.ready && s.generation == update.generation);
        if incremental {
            let touched: BTreeSet<_> = update
                .rows
                .iter()
                .map(|r| r.id)
                .chain(tx.records_del.iter().copied())
                .collect();
            for id in &touched {
                out.push(Stmt::new(TOUCHED_COVERAGE, vec![blob(&id.0); 8]));
            }
            out.push(Stmt::new(
                "UPDATE st_qstate SET ready=0 WHERE slot=0 AND generation IS NOT ?",
                vec![blob(&update.generation)],
            ));
            return Ok(out);
        }
        // Exact cardinality + unique PK + declared-field/live-record membership
        // establish complete coverage, not a caller-provided ready boolean.
        out.push(Stmt::new("UPDATE st_qstate SET ready=CASE WHEN (SELECT count(*) FROM st_qrecord)=(SELECT count(*) FROM st_rec) AND NOT EXISTS(SELECT 1 FROM st_qrecord q LEFT JOIN st_rec r ON r.id=q.id WHERE r.id IS NULL) AND (SELECT count(*) FROM st_qmtime)=(SELECT count(*) FROM st_rec) AND NOT EXISTS(SELECT 1 FROM st_qmtime m LEFT JOIN st_rec r ON r.id=m.id WHERE r.id IS NULL) AND (SELECT count(*) FROM st_field)=(SELECT count(*) FROM st_rec)*(SELECT count(*) FROM st_qspec) AND NOT EXISTS(SELECT 1 FROM st_field f LEFT JOIN st_qspec s ON s.source=f.source AND s.field=f.field LEFT JOIN st_rec r ON r.id=f.id WHERE s.field IS NULL OR r.id IS NULL) THEN 1 ELSE 0 END WHERE slot=0 AND generation=?", vec![blob(&update.generation)]));
    }
    Ok(out)
}
