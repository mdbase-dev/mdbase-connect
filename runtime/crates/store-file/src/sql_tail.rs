//! Persistent retained entries and own intents. Sequence keys are ordered,
//! lossless big-endian BLOBs; no signed SQLite integer conversion or MAX+1.
//! Only source/copy bounds are supplied here, not aggregate heap qualification.
use super::*;
use mdbn_replica::store::{TailRow, TailStats};

const PAGE_ROWS: u32 = 1_000;
pub(super) const SCHEMA: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS st_tail(seq BLOB PRIMARY KEY CHECK(length(seq)=8), applied INTEGER NOT NULL, item BLOB NOT NULL) WITHOUT ROWID",
    "CREATE TABLE IF NOT EXISTS st_own(seq BLOB PRIMARY KEY CHECK(length(seq)=8), row BLOB NOT NULL) WITHOUT ROWID",
    "CREATE TABLE IF NOT EXISTS st_retained_stats(kind TEXT PRIMARY KEY, n INTEGER NOT NULL CHECK(n>=0), bytes INTEGER NOT NULL CHECK(bytes>=0)) WITHOUT ROWID",
    "INSERT OR IGNORE INTO st_retained_stats SELECT 'tail',count(*),coalesce(sum(length(item)),0) FROM st_tail WHERE NOT EXISTS (SELECT 1 FROM st_retained_stats WHERE kind='tail')",
    "INSERT OR IGNORE INTO st_retained_stats SELECT 'own',count(*),coalesce(sum(length(row)),0) FROM st_own WHERE NOT EXISTS (SELECT 1 FROM st_retained_stats WHERE kind='own')",
    "CREATE TRIGGER IF NOT EXISTS st_tail_ai AFTER INSERT ON st_tail BEGIN UPDATE st_retained_stats SET n=n+1,bytes=bytes+length(new.item) WHERE kind='tail'; END",
    "CREATE TRIGGER IF NOT EXISTS st_tail_ad AFTER DELETE ON st_tail BEGIN UPDATE st_retained_stats SET n=n-1,bytes=bytes-length(old.item) WHERE kind='tail'; END",
    "CREATE TRIGGER IF NOT EXISTS st_own_ai AFTER INSERT ON st_own BEGIN UPDATE st_retained_stats SET n=n+1,bytes=bytes+length(new.row) WHERE kind='own'; END",
    "CREATE TRIGGER IF NOT EXISTS st_own_ad AFTER DELETE ON st_own BEGIN UPDATE st_retained_stats SET n=n-1,bytes=bytes-length(old.row) WHERE kind='own'; END",
    "CREATE TRIGGER IF NOT EXISTS st_tail_au AFTER UPDATE ON st_tail BEGIN UPDATE st_retained_stats SET bytes=bytes+length(new.item)-length(old.item) WHERE kind='tail'; END",
    "CREATE TRIGGER IF NOT EXISTS st_own_au AFTER UPDATE ON st_own BEGIN UPDATE st_retained_stats SET bytes=bytes+length(new.row)-length(old.row) WHERE kind='own'; END",
];
fn key(seq: u64) -> SqlValue {
    blob(seq.to_be_bytes().to_vec())
}
fn position(v: &SqlValue) -> StoreResult<u64> {
    match v {
        SqlValue::Blob(v) => Ok(u64::from_be_bytes(
            v.as_slice()
                .try_into()
                .map_err(|_| corrupt("retained position"))?,
        )),
        _ => Err(corrupt("retained position")),
    }
}
fn drops(table: &str, below: Option<u64>, above: Option<u64>, out: &mut Vec<Stmt>) {
    if let Some(n) = below {
        out.push(st(
            &format!("DELETE FROM {table} WHERE seq < ?"),
            vec![key(n)],
        ));
    }
    if let Some(n) = above {
        if n == 0 {
            out.push(st(&format!("DELETE FROM {table}"), vec![]));
        } else {
            out.push(st(
                &format!("DELETE FROM {table} WHERE seq > ?"),
                vec![key(n)],
            ));
        }
    }
}
pub(super) fn append(tx: &Tx, cap: u64, out: &mut Vec<Stmt>) -> StoreResult<()> {
    if tx
        .tail_put
        .len()
        .checked_add(tx.own_retained_put.len())
        .is_none_or(|n| n > PAGE_ROWS as usize)
    {
        return Err(StoreError::Full);
    }
    if tx.tail_put.iter().any(|r| r.seq == 0)
        || tx.own_retained_put.iter().any(|(seq, _)| *seq == 0)
    {
        return Err(corrupt("zero retained position"));
    }
    let mut bytes = 0u64;
    for r in &tx.tail_put {
        bytes = bytes
            .checked_add(r.item.len() as u64)
            .filter(|n| *n <= cap)
            .ok_or(StoreError::Full)?;
    }
    drops("st_tail", tx.tail_drop_below, tx.tail_drop_above, out);
    drops(
        "st_own",
        tx.own_retained_drop_below,
        tx.own_retained_drop_above,
        out,
    );
    for r in &tx.tail_put {
        // Explicit delete ensures accounting also works with recursive_triggers
        // disabled; SQLite REPLACE implicit deletions do not promise that.
        out.push(st("DELETE FROM st_tail WHERE seq = ?", vec![key(r.seq)]));
        out.push(st(
            "INSERT INTO st_tail(seq,applied,item) VALUES (?,?,?)",
            vec![
                key(r.seq),
                SqlValue::Integer(r.applied_at),
                blob(r.item.clone()),
            ],
        ));
    }
    for (seq, p) in &tx.own_retained_put {
        // Existing canonical PendingRow codec. This serialized copy is bounded,
        // but its internal CBOR construction is not a complete allocation meter.
        let encoded = p.to_bytes();
        bytes = bytes
            .checked_add(encoded.len() as u64)
            .filter(|n| *n <= cap)
            .ok_or(StoreError::Full)?;
        out.push(st("DELETE FROM st_own WHERE seq = ?", vec![key(*seq)]));
        out.push(st(
            "INSERT INTO st_own(seq,row) VALUES (?,?)",
            vec![key(*seq), blob(encoded)],
        ));
    }
    Ok(())
}

fn selected<I: IndexStorage>(
    store: &SqlStore<I>,
    table: &str,
    column: &str,
    after: u64,
    limit: u32,
) -> StoreResult<Vec<(u64, u64)>> {
    // Probe one extra metadata row to reject oversized requested envelopes,
    // never silently return a capped prefix of the requested source page.
    let result = store.q(
        &format!("SELECT seq,length({column}) FROM {table} WHERE seq > ? ORDER BY seq LIMIT ?"),
        vec![key(after), int(limit.min(PAGE_ROWS + 1))],
    )?;
    if result.columns != 2 || !result.values.len().is_multiple_of(2) {
        return Err(corrupt("retained metadata"));
    }
    if result.row_count() > u64::from(PAGE_ROWS) {
        return Err(StoreError::Full);
    }
    let mut total = 0u64;
    let mut last = after;
    result
        .rows()
        .map(|row| {
            let seq = position(&row[0])?;
            if seq <= last {
                return Err(corrupt("retained order"));
            }
            last = seq;
            let n = u64_of(&row[1])?;
            total = total
                .checked_add(n)
                .filter(|n| *n <= store.limits.max_blob_patch_bytes)
                .ok_or(StoreError::Full)?;
            Ok((seq, n))
        })
        .collect()
}
pub(super) fn read<I: IndexStorage>(
    store: &SqlStore<I>,
    after: u64,
    limit: u32,
) -> StoreResult<Vec<TailRow>> {
    let chosen = selected(store, "st_tail", "item", after, limit)?;
    chosen
        .into_iter()
        .map(|(seq, n)| {
            store
                .one(
                    "SELECT applied,item FROM st_tail WHERE seq=? AND length(item)=?",
                    vec![key(seq), wide_int(n)?],
                    |row| match row {
                        [SqlValue::Integer(applied), SqlValue::Blob(item)]
                            if item.len() as u64 == n =>
                        {
                            Ok(TailRow {
                                seq,
                                item: item.clone(),
                                applied_at: *applied,
                            })
                        }
                        _ => Err(corrupt("retained entry")),
                    },
                )?
                .ok_or_else(|| corrupt("retained selection changed"))
        })
        .collect()
}
pub(super) fn own<I: IndexStorage>(
    store: &SqlStore<I>,
    after: u64,
    limit: u32,
) -> StoreResult<Vec<(u64, PendingRow)>> {
    let chosen = selected(store, "st_own", "row", after, limit)?;
    chosen
        .into_iter()
        .map(|(seq, n)| {
            let p = store
                .one(
                    "SELECT row FROM st_own WHERE seq=? AND length(row)=?",
                    vec![key(seq), wide_int(n)?],
                    pending_row,
                )?
                .ok_or_else(|| corrupt("retained selection changed"))?;
            Ok((seq, p))
        })
        .collect()
}
pub(super) fn stats<I: IndexStorage>(
    store: &SqlStore<I>,
    table: &str,
    kind: &str,
) -> StoreResult<TailStats> {
    store.one(&format!("SELECT (SELECT seq FROM {table} ORDER BY seq LIMIT 1),(SELECT seq FROM {table} ORDER BY seq DESC LIMIT 1),n,bytes FROM st_retained_stats WHERE kind=?"),vec![t(kind)],|row| {
        match row {
            [SqlValue::Null,SqlValue::Null,n,bytes] if u64_of(n)?==0 && u64_of(bytes)?==0 => Ok(TailStats::default()),
            [first,last,n,bytes] => {
                let first=position(first)?;
                let last=position(last)?;
                let count=u64_of(n)?;
                if first==0 || last<first || count==0 {return Err(corrupt("retained stats"));}
                Ok(TailStats{first,last,count,bytes:u64_of(bytes)?})
            }
            _ => Err(corrupt("retained stats")),
        }
    })?.ok_or_else(||corrupt("missing retained stats"))
}
