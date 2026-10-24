//! Atomic exact raw-source materialization for the shared indexed query driver.
//! This is optional derived data, never authority or reconstructed sort atoms.

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::rc::Rc;

use mdbn_core::doc::Document;
use mdbn_core::ids::Hash;
use mdbn_core::views::bases::{
    BASES_TAG_CAPTURE_VERSION, MAX_ALLOCATION_BYTES, WorkBudget, capture_source_tags,
};
use mdbn_replica::convert;
use mdbn_replica::store::{RecordRow, Stage, StoreError, StoreResult, Tx};
use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::schema::Wire;

use crate::index::{Batch, BatchMode, IndexError, IndexErrorKind, IndexStorage, SqlValue, Stmt};

pub(crate) const SCHEMA: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS st_qraw_state(slot INTEGER PRIMARY KEY CHECK(slot=0),generation BLOB NOT NULL,ready INTEGER NOT NULL CHECK(ready IN (0,1)),version INTEGER NOT NULL)",
    "CREATE TABLE IF NOT EXISTS st_qraw(id BLOB PRIMARY KEY,path BLOB NOT NULL,source_sha BLOB NOT NULL,source_bytes INTEGER NOT NULL,fields BLOB NOT NULL,tags BLOB NOT NULL) WITHOUT ROWID",
    "CREATE TABLE IF NOT EXISTS st_qraw_fact(id BLOB PRIMARY KEY,known INTEGER NOT NULL CHECK(known IN (0,1))) WITHOUT ROWID",
    "CREATE TABLE IF NOT EXISTS st_qraw_atom(id BLOB NOT NULL,name BLOB NOT NULL,kind INTEGER NOT NULL,text BLOB NOT NULL,PRIMARY KEY(id,name)) WITHOUT ROWID",
    "CREATE TABLE IF NOT EXISTS st_qraw_tag(id BLOB NOT NULL,tag BLOB NOT NULL,PRIMARY KEY(id,tag)) WITHOUT ROWID",
    "CREATE INDEX IF NOT EXISTS st_qraw_tag_lookup ON st_qraw_tag(tag,id)",
];
mod candidate;
const MAX_SOURCE: usize = 1 << 20;
const MAX_PAYLOAD: usize = 1 << 20;
const MAX_TX_BYTES: usize = 8 << 20;
const MAX_RECORD_BLOB: i64 = 4 << 20;
const MAX_TX_TAG_STEPS: u64 = 64_000_000;
// Increment when the raw encoding or source observation algorithm changes.
const VERSION: i64 = 256 + BASES_TAG_CAPTURE_VERSION as i64;

fn blob(bytes: &[u8]) -> SqlValue {
    SqlValue::Blob(bytes.to_vec())
}
fn error(e: IndexError) -> StoreError {
    match e.kind {
        IndexErrorKind::Full => StoreError::Full,
        IndexErrorKind::Corrupt => StoreError::Corrupt(format!("SQL raw projection: {e}")),
        _ => StoreError::Io(format!("SQL raw projection: {e}")),
    }
}
fn corrupt() -> StoreError {
    StoreError::Corrupt("invalid SQL raw projection metadata".into())
}

struct Payload {
    fields: Vec<u8>,
    tags: Vec<u8>,
    facts: Vec<Stmt>,
    fact_bytes: usize,
}

/// None means unavailable, not empty frontmatter or known-empty tags.
fn capture(row: &RecordRow, tag_steps_left: &mut u64) -> Option<Payload> {
    if *tag_steps_left == 0
        || row.doc.len() > MAX_SOURCE
        || row.path.len() > 4096
        || Hash::of(row.doc.as_bytes()).0 != row.revision.0
    {
        return None;
    }
    let (document, _) = Document::parse_at_bounded(&row.path, &row.doc).ok()?;
    if document.problem().is_some() {
        return None;
    }
    let fields = cbor::encode(&convert::wmap(document.frontmatter()).to_cbor()).ok()?;
    if fields.len() > MAX_PAYLOAD {
        return None;
    }
    let mut budget = WorkBudget::constrained(*tag_steps_left, MAX_ALLOCATION_BYTES);
    let initial_steps = budget.remaining_steps();
    let tags = capture_source_tags(&document, &mut budget);
    *tag_steps_left -= initial_steps - budget.remaining_steps();
    let tags = tags.ok()?;
    let mut facts = Vec::new();
    let fact_bytes = candidate::capture(row, &document, tags.as_deref(), &mut facts);
    let tags = cbor::encode(&match tags {
        Some(tags) => tags.to_cbor(),
        None => Cbor::Null,
    })
    .ok()?;
    (fields.len().checked_add(tags.len())? <= MAX_PAYLOAD).then_some(Payload {
        fields,
        tags,
        facts,
        fact_bytes,
    })
}

/// Invalidation is constant work and poisons the version until a full rebuild;
/// ID coverage alone cannot certify retained rows after an unprojected write.
pub(crate) fn invalidate() -> Vec<Stmt> {
    vec![Stmt::new(
        "UPDATE st_qraw_state SET ready=0,version=0 WHERE slot=0",
        vec![],
    )]
}

pub(crate) fn delete_row(id: &[u8], out: &mut Vec<Stmt>) {
    out.push(Stmt::new("DELETE FROM st_qraw WHERE id=?", vec![blob(id)]));
    candidate::delete(id, out);
}

fn state<I: IndexStorage>(index: &Rc<RefCell<I>>) -> StoreResult<Option<([u8; 32], bool)>> {
    let result = index.borrow_mut().run(&Batch {
        mode: BatchMode::Autocommit,
        stmts: vec![Stmt::new("SELECT CASE WHEN length(generation)=32 THEN generation ELSE NULL END,ready,version FROM st_qraw_state WHERE slot=0", vec![])],
    }).map_err(error)?;
    let [result] = result.as_slice() else {
        return Err(corrupt());
    };
    if result.columns != 3 {
        return Err(corrupt());
    }
    if result.values.is_empty() {
        return Ok(None);
    }
    let [
        SqlValue::Blob(generation),
        SqlValue::Integer(ready),
        SqlValue::Integer(version),
    ] = result.values.as_slice()
    else {
        return Err(corrupt());
    };
    if !matches!(ready, 0 | 1) {
        return Err(corrupt());
    }
    Ok(Some((
        generation.as_slice().try_into().map_err(|_| corrupt())?,
        *ready == 1 && *version == VERSION,
    )))
}

/// A cold R6 index-only backfill may read one bounded authoritative row. Warm
/// projection reads will use only `st_qraw`, never this document-blob path.
fn backfill_row<I: IndexStorage>(
    index: &Rc<RefCell<I>>,
    id: &[u8],
) -> StoreResult<Option<RecordRow>> {
    let result = index
        .borrow_mut()
        .run(&Batch {
            mode: BatchMode::Autocommit,
            stmts: vec![Stmt::new(
                "SELECT CASE WHEN length(row)<=? THEN row ELSE NULL END FROM st_rec WHERE id=?",
                vec![SqlValue::Integer(MAX_RECORD_BLOB), blob(id)],
            )],
        })
        .map_err(error)?;
    let [result] = result.as_slice() else {
        return Err(corrupt());
    };
    if result.columns != 1 {
        return Err(corrupt());
    }
    match result.values.as_slice() {
        [] | [SqlValue::Null] => Ok(None),
        [value] => crate::sql::record_d(value).map(Some),
        _ => Err(corrupt()),
    }
}

// Coverage certification is global ONLY on an initial/final rebuild; normal
// ready-generation commits verify the touched IDs, not the whole collection.
const COVERAGE: &str = "UPDATE st_qraw_state SET ready=CASE WHEN NOT EXISTS(SELECT 1 FROM st_rec r LEFT JOIN st_qraw q ON q.id=r.id WHERE q.id IS NULL) AND NOT EXISTS(SELECT 1 FROM st_qraw q LEFT JOIN st_rec r ON r.id=q.id WHERE r.id IS NULL) THEN 1 ELSE 0 END WHERE slot=0 AND generation=? AND version=?";
const TOUCHED: &str = "UPDATE st_qraw_state SET ready=0 WHERE slot=0 AND (EXISTS(SELECT 1 FROM st_rec WHERE id=?) IS NOT EXISTS(SELECT 1 FROM st_qraw WHERE id=?))";

/// Append to the SAME authoritative transaction. Invalid optional input fences
/// this derived payload, but does not reject a valid record write.
pub(crate) fn maintenance<I: IndexStorage>(
    index: &Rc<RefCell<I>>,
    tx: &Tx,
) -> StoreResult<Vec<Stmt>> {
    if matches!(tx.stage, Stage::Put | Stage::Discard) {
        return Ok(vec![]);
    }
    if tx.stage == Stage::Swap || tx.clear_confirmed {
        let mut out = invalidate();
        out.push(Stmt::new("DELETE FROM st_qraw", vec![]));
        candidate::clear(&mut out);
        return Ok(out);
    }
    let changed = !tx.records_put.is_empty()
        || !tx.records_del.is_empty()
        || !tx.resources_put.is_empty()
        || !tx.resources_del.is_empty();
    let Some(update) = &tx.query_index else {
        return Ok(if changed { invalidate() } else { vec![] });
    };
    if update.rows.len() > 500 {
        return Ok(invalidate());
    }
    // Raw readiness is independent of field specs, NOT publication authority.
    // Match R6's publication-head proof before certifying raw coverage. An
    // invalid optional proof poisons readiness, never rejects valid authority.
    if let Some(published) = update.publish_at {
        let expected = match tx.head {
            Some(head) => head,
            None => paging::head(index)?,
        };
        if expected != published {
            return Ok(invalidate());
        }
    }
    let existing = state(index)?;
    let reset = update.replace_specs.is_some()
        || existing.is_none_or(|(generation, _)| generation != update.generation);
    let already_ready = !reset && existing.is_some_and(|(_, ready)| ready);
    let put: BTreeMap<_, _> = tx.records_put.iter().map(|r| (r.id, r)).collect();
    let mut ids = BTreeSet::new();
    let mut bytes = 0usize;
    let mut source_bytes = 0usize;
    let mut fact_bytes = 0usize;
    let mut tag_steps_left = MAX_TX_TAG_STEPS;
    let mut out = Vec::new();
    if reset {
        out.push(Stmt::new("DELETE FROM st_qraw", vec![]));
        candidate::clear(&mut out);
        out.push(Stmt::new(
            "INSERT OR REPLACE INTO st_qraw_state(slot,generation,ready,version) VALUES(0,?,0,?)",
            vec![blob(&update.generation), SqlValue::Integer(VERSION)],
        ));
    }
    let mut unavailable = false;
    for projected in &update.rows {
        if !ids.insert(projected.id) {
            return Ok(invalidate());
        }
        let old;
        let row = if let Some(row) = put.get(&projected.id) {
            *row
        } else {
            old = backfill_row(index, &projected.id.0)?;
            let Some(row) = old.as_ref() else {
                unavailable = true;
                delete_row(&projected.id.0, &mut out);
                continue;
            };
            row
        };
        if row.id != projected.id || row.path != projected.path {
            return Ok(invalidate());
        }
        source_bytes = match source_bytes.checked_add(row.doc.len()) {
            Some(n) if n <= MAX_TX_BYTES => n,
            _ => return Ok(invalidate()),
        };
        let Some(payload) = capture(row, &mut tag_steps_left) else {
            unavailable = true;
            delete_row(&row.id.0, &mut out);
            continue;
        };
        bytes = match bytes
            .checked_add(payload.fields.len())
            .and_then(|n| n.checked_add(payload.tags.len()))
            .and_then(|n| n.checked_add(row.path.len()))
        {
            Some(n) if n <= MAX_TX_BYTES => n,
            _ => return Ok(invalidate()),
        };
        if fact_bytes.saturating_add(payload.fact_bytes) <= MAX_TX_BYTES {
            fact_bytes += payload.fact_bytes;
            out.extend(payload.facts);
        } else {
            // Optional facts that cannot fit remain UNKNOWN, never a partial
            // field/tag inventory certified as complete.
            candidate::delete(&row.id.0, &mut out);
            out.push(Stmt::new(
                "INSERT INTO st_qraw_fact(id,known) VALUES(?,0)",
                vec![blob(&row.id.0)],
            ));
        }
        out.push(Stmt::new("INSERT OR REPLACE INTO st_qraw(id,path,source_sha,source_bytes,fields,tags) VALUES(?,?,?,?,?,?)",vec![blob(&row.id.0),blob(row.path.as_bytes()),blob(&row.revision.0),SqlValue::Integer(i64::try_from(row.doc.len()).map_err(|_| StoreError::Full)?),SqlValue::Blob(payload.fields),SqlValue::Blob(payload.tags)]));
    }
    if put.keys().any(|id| !ids.contains(id)) {
        return Ok(invalidate());
    }
    ids.extend(tx.records_del.iter().copied());
    if unavailable {
        out.extend(invalidate());
    } else if update.publish_at.is_some() {
        if already_ready {
            for id in &ids {
                out.push(Stmt::new(TOUCHED, vec![blob(&id.0), blob(&id.0)]));
            }
        } else {
            out.push(Stmt::new(
                COVERAGE,
                vec![blob(&update.generation), SqlValue::Integer(VERSION)],
            ));
        }
    }
    Ok(out)
}

#[path = "sql_bases/page.rs"]
mod paging;
pub(crate) use paging::{page, projection_state};

#[cfg(test)]
#[path = "sql_bases/tests.rs"]
mod tests;
