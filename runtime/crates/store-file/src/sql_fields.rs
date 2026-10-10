//! Atomic derived field-index maintenance. Invalid optional projections fence
//! indexed reads, but never reject otherwise valid authoritative record writes.
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::rc::Rc;

use crate::index::{Batch, BatchMode, IndexError, IndexErrorKind, IndexStorage, SqlValue, Stmt};
use crate::sql::head_d;
use mdbn_core::query::indexed::SortAtom;
use mdbn_replica::store::{Head, StoreError, StoreResult, Tx};
use mdbn_replica::store_query::{QueryField, QueryIndexState};

pub(crate) const SCHEMA: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS st_qstate(slot INTEGER PRIMARY KEY CHECK(slot=0), generation BLOB NOT NULL, ready INTEGER NOT NULL CHECK(ready IN (0,1)))",
    "CREATE TABLE IF NOT EXISTS st_qspec(source INTEGER NOT NULL, field BLOB NOT NULL, PRIMARY KEY(source,field)) WITHOUT ROWID",
    "CREATE TABLE IF NOT EXISTS st_qrecord(id BLOB PRIMARY KEY, path BLOB NOT NULL) WITHOUT ROWID",
    "CREATE INDEX IF NOT EXISTS st_qrecord_path ON st_qrecord(path,id)",
    "CREATE TABLE IF NOT EXISTS st_qtype(name TEXT NOT NULL,id BLOB NOT NULL,PRIMARY KEY(name,id)) WITHOUT ROWID",
    "CREATE INDEX IF NOT EXISTS st_qtype_id ON st_qtype(id)",
    "CREATE TABLE IF NOT EXISTS st_field(id BLOB NOT NULL,source INTEGER NOT NULL,field BLOB NOT NULL,kind INTEGER NOT NULL,sort BLOB NOT NULL,hint INTEGER NOT NULL,PRIMARY KEY(id,source,field)) WITHOUT ROWID",
    "CREATE INDEX IF NOT EXISTS st_field_asc ON st_field(source,field,kind,sort,id)",
    "CREATE INDEX IF NOT EXISTS st_field_desc ON st_field(source,field,kind DESC,sort DESC,id ASC)",
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
    vec![
        Stmt::new("DELETE FROM st_field", vec![]),
        Stmt::new("DELETE FROM st_qrecord", vec![]),
        Stmt::new("DELETE FROM st_qtype", vec![]),
        Stmt::new("UPDATE st_qstate SET ready=0 WHERE slot=0", vec![]),
    ]
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
/// a live record has exactly one `st_qrecord` row and one `st_field` row per
/// declared spec, all of them declared; a removed record has none.
const TOUCHED_COVERAGE: &str = "UPDATE st_qstate SET ready=0 WHERE slot=0 AND (EXISTS(SELECT 1 FROM st_rec WHERE id=?) IS NOT EXISTS(SELECT 1 FROM st_qrecord WHERE id=?) OR (SELECT count(*) FROM st_field WHERE id=?) IS NOT CASE WHEN EXISTS(SELECT 1 FROM st_rec WHERE id=?) THEN (SELECT count(*) FROM st_qspec) ELSE 0 END OR EXISTS(SELECT 1 FROM st_field f LEFT JOIN st_qspec s ON s.source=f.source AND s.field=f.field WHERE f.id=? AND s.field IS NULL) OR (SELECT count(*) FROM st_qrecord WHERE id=?) > 1)";

pub(crate) fn delete_row(id: &[u8], stmts: &mut Vec<Stmt>) {
    for table in ["st_field", "st_qrecord", "st_qtype"] {
        stmts.push(Stmt::new(
            format!("DELETE FROM {table} WHERE id=?"),
            vec![blob(id)],
        ));
    }
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
    let mut statement_count = 32usize;
    for r in &update.rows {
        statement_count = match statement_count.checked_add(4 + r.types.len() + r.fields.len()) {
            Some(n) if n <= 8192 => n,
            _ => return Ok(invalidate()),
        };
        if !ids.insert(r.id)
            || r.fields.len() != fields.len()
            || r.types.len() > 64
            || r.fields
                .iter()
                .any(|v| v.field.source > 1 || v.field.path_key.len() > 1024)
            || put.get(&r.id).is_some_and(|base| base.path != r.path)
        {
            return Ok(invalidate());
        }
        let present: BTreeSet<_> = r.fields.iter().map(|v| v.field.clone()).collect();
        if present != declared {
            return Ok(invalidate());
        }
        bytes = match bytes.checked_add(r.path.len()) {
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
        for table in ["st_field", "st_qtype", "st_qrecord", "st_qspec"] {
            out.push(Stmt::new(format!("DELETE FROM {table}"), vec![]));
        }
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
        delete_row(&r.id.0, &mut out);
        out.push(Stmt::new(
            "INSERT INTO st_qrecord(id,path) VALUES(?,?)",
            vec![blob(&r.id.0), blob(r.path.as_bytes())],
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
                "INSERT INTO st_field(id,source,field,kind,sort,hint) VALUES(?,?,?,?,?,?)",
                vec![
                    blob(&r.id.0),
                    SqlValue::Integer(i64::from(v.field.source)),
                    blob(&v.field.path_key),
                    SqlValue::Integer(i64::from(v.atom.kind)),
                    blob(&v.atom.key),
                    SqlValue::Integer(i64::from(v.temporal_hint)),
                ],
            ));
        }
    }
    // Even an index-only incremental update must preserve backend-verified
    // live/field coverage. In particular, inserting a nonexistent ID cannot
    // retain readiness merely because the caller omitted publication.
    if update.publish_at.is_none() {
        out.push(Stmt::new("UPDATE st_qstate SET ready=0 WHERE slot=0 AND (EXISTS(SELECT 1 FROM st_qrecord q LEFT JOIN st_rec r ON r.id=q.id WHERE r.id IS NULL) OR EXISTS(SELECT 1 FROM st_field f LEFT JOIN st_qspec s ON s.source=f.source AND s.field=f.field LEFT JOIN st_rec r ON r.id=f.id WHERE s.field IS NULL OR r.id IS NULL))", vec![]));
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
                out.push(Stmt::new(TOUCHED_COVERAGE, vec![blob(&id.0); 6]));
            }
            out.push(Stmt::new(
                "UPDATE st_qstate SET ready=0 WHERE slot=0 AND generation IS NOT ?",
                vec![blob(&update.generation)],
            ));
            return Ok(out);
        }
        // Exact cardinality + unique PK + declared-field/live-record membership
        // establish complete coverage, not a caller-provided ready boolean.
        out.push(Stmt::new("UPDATE st_qstate SET ready=CASE WHEN (SELECT count(*) FROM st_qrecord)=(SELECT count(*) FROM st_rec) AND NOT EXISTS(SELECT 1 FROM st_qrecord q LEFT JOIN st_rec r ON r.id=q.id WHERE r.id IS NULL) AND (SELECT count(*) FROM st_field)=(SELECT count(*) FROM st_rec)*(SELECT count(*) FROM st_qspec) AND NOT EXISTS(SELECT 1 FROM st_field f LEFT JOIN st_qspec s ON s.source=f.source AND s.field=f.field LEFT JOIN st_rec r ON r.id=f.id WHERE s.field IS NULL OR r.id IS NULL) THEN 1 ELSE 0 END WHERE slot=0 AND generation=?", vec![blob(&update.generation)]));
    }
    Ok(out)
}
