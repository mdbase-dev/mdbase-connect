//! Reference-store parity with store-file bounded source selection/hydration.
//! Computes exact existing CBOR row length without encoding/cloning documents.
use super::*;
use mdbn_wire::common::Value;
fn header(n: u64) -> u64 {
    match n {
        0..=23 => 1,
        24..=255 => 2,
        256..=65535 => 3,
        65536..=4294967295 => 5,
        _ => 9,
    }
}
fn add(a: u64, b: u64) -> StoreResult<u64> {
    a.checked_add(b).ok_or(StoreError::Full)
}
fn text(s: &str) -> StoreResult<u64> {
    add(header(s.len() as u64), s.len() as u64)
}
fn strings(values: &[String]) -> StoreResult<u64> {
    let mut n = header(values.len() as u64);
    for value in values {
        n = add(n, text(value)?)?;
    }
    Ok(n)
}
fn value_size(value: &Value, depth: usize) -> StoreResult<u64> {
    if depth > mdbn_wire::cbor::MAX_DEPTH {
        return Err(StoreError::Corrupt("query row value depth".into()));
    }
    match value {
        Value::Null | Value::Bool(_) => Ok(1),
        Value::Int(n) => Ok(header(if *n >= 0 {
            *n as u64
        } else {
            (-1i128 - i128::from(*n)) as u64
        })),
        Value::Float(n) if n.is_finite() => Ok(9),
        Value::Float(_) => Err(StoreError::Corrupt("query row nonfinite value".into())),
        Value::Text(s) => text(s),
        Value::List(values) => {
            let mut n = header(values.len() as u64);
            for value in values {
                n = add(n, value_size(value, depth + 1)?)?;
            }
            Ok(n)
        }
        Value::Map(map) => {
            let mut n = header(map.len() as u64);
            for (key, value) in map {
                n = add(n, text(key)?)?;
                n = add(n, value_size(value, depth + 1)?)?;
            }
            Ok(n)
        }
    }
}
fn record_size(row: &RecordRow) -> StoreResult<u64> {
    let mut n = 1 + 17 + 34;
    for s in [&row.path, &row.path_key, &row.doc] {
        n = add(n, text(s)?)?;
    }
    n = add(
        n,
        header(row.modified_seq) + header(u64::from(row.bucket)) + 1,
    )?;
    for v in [&row.meta.types, &row.meta.links, &row.meta.tags] {
        n = add(n, strings(v)?)?;
    }
    n = add(n, header(row.meta.effective.0.len() as u64))?;
    for (key, value) in &row.meta.effective.0 {
        n = add(n, text(key)?)?;
        n = add(n, value_size(value, 3)?)?;
    }
    n = add(n, header(row.meta.unique.len() as u64))?;
    for (field, value) in &row.meta.unique {
        n = add(n, 1 + text(field)?)?;
        n = add(n, text(value)?)?;
    }
    Ok(n)
}
pub(super) fn sizes(
    store: &MemStore,
    page: Page,
    head: Head,
) -> StoreResult<Vec<crate::store_query::QueryRecordSize>> {
    if page.limit > 1000 {
        return Err(StoreError::Full);
    }
    let data = store.data.borrow();
    if data.head != head {
        return Err(StoreError::Io(
            "query selection stale; restart required".into(),
        ));
    }
    let mut rows = Vec::new();
    for (id, row) in data
        .records
        .iter()
        .filter(|(id, _)| page.after.is_none_or(|after| **id > after))
        .take(page.limit as usize)
    {
        if row.id != *id {
            return Err(StoreError::Corrupt("query row identity".into()));
        }
        rows.push(crate::store_query::QueryRecordSize {
            id: *id,
            encoded_bytes: record_size(row)?,
        });
    }
    Ok(rows)
}
pub(super) fn hydrate(
    store: &MemStore,
    ids: &[Uuid],
    head: Head,
    budget: &mut crate::store_query::QueryBudget,
) -> StoreResult<Vec<RecordRow>> {
    let count = u32::try_from(ids.len()).map_err(|_| StoreError::Full)?;
    if count > 1000 || count > budget.records_left() {
        return Err(StoreError::Full);
    }
    let data = store.data.borrow();
    if data.head != head {
        return Err(StoreError::Io(
            "query selection stale; restart required".into(),
        ));
    }
    let distinct: BTreeSet<_> = ids.iter().copied().collect();
    if distinct.len() != ids.len() {
        return Err(StoreError::Io("duplicate query selection IDs".into()));
    }
    let mut bytes = 0u64;
    for id in ids {
        let row = data
            .records
            .get(id)
            .ok_or_else(|| StoreError::Io("query selection stale; restart required".into()))?;
        if row.id != *id {
            return Err(StoreError::Corrupt("query row identity".into()));
        }
        bytes = add(bytes, record_size(row)?)?;
        if bytes > budget.bytes_left() {
            return Err(StoreError::Full);
        }
    }
    // ALL admitted work charged before the first RecordRow/source clone. One
    // immutable borrow binds preflight+copy, so no changed-size growth window.
    budget.charge(count, bytes)?;
    Ok(ids
        .iter()
        .map(|id| {
            data.records
                .get(id)
                .expect("preflight under same immutable borrow")
                .clone()
        })
        .collect())
}
#[cfg(test)]
mod tests;
