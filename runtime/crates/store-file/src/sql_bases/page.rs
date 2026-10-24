//! Bounded UUID paging over exact raw payloads, sharing R6 candidate selection.
use super::*;
use mdbn_replica::store::Head;
use mdbn_replica::store_query::{
    QueryPredicate, QueryProjectionPage, QueryProjectionRequest, QueryProjectionRow,
    QueryProjectionState,
};
use mdbn_wire::common::{B16, B32, Uuid};
#[path = "values.rs"]
mod values;

fn run<I: IndexStorage>(
    index: &Rc<RefCell<I>>,
    statement: Stmt,
) -> StoreResult<crate::index::StmtResult> {
    let mut results = index
        .borrow_mut()
        .run(&Batch {
            mode: BatchMode::Autocommit,
            stmts: vec![statement],
        })
        .map_err(error)?;
    if results.len() != 1 {
        return Err(corrupt());
    }
    Ok(results.remove(0))
}
pub(super) fn head<I: IndexStorage>(index: &Rc<RefCell<I>>) -> StoreResult<Head> {
    let result = run(
        index,
        Stmt::new(
            "SELECT CASE WHEN length(v)<=128 THEN v ELSE NULL END FROM st_kv WHERE k='head'",
            vec![],
        ),
    )?;
    if result.columns != 1 {
        return Err(corrupt());
    }
    match result.values.as_slice() {
        [] => Ok(Head::GENESIS),
        [value] => crate::sql::head_d(value),
        _ => Err(corrupt()),
    }
}
/// An installed backend reports an explicit unready state before backfill,
/// rather than claiming the whole backend unsupported or empty success.
pub(crate) fn projection_state<I: IndexStorage>(
    index: &Rc<RefCell<I>>,
) -> StoreResult<QueryProjectionState> {
    let snapshot = head(index)?;
    let (generation, ready) = state(index)?.unwrap_or(([0; 32], false));
    Ok(QueryProjectionState {
        generation,
        head: snapshot,
        ready,
    })
}
fn fence<I: IndexStorage>(
    index: &Rc<RefCell<I>>,
    request: &QueryProjectionRequest,
) -> StoreResult<()> {
    let state = projection_state(index)?;
    if !state.ready || state.generation != request.generation || state.head != request.head {
        return Err(StoreError::Io(
            "SQL raw projection snapshot changed or is not ready".into(),
        ));
    }
    Ok(())
}
fn number(value: &SqlValue) -> StoreResult<u64> {
    match value {
        SqlValue::Integer(n) => u64::try_from(*n).map_err(|_| corrupt()),
        _ => Err(corrupt()),
    }
}
fn bytes(value: &SqlValue) -> StoreResult<&[u8]> {
    match value {
        SqlValue::Blob(bytes) => Ok(bytes),
        _ => Err(corrupt()),
    }
}
#[derive(Clone)]
struct Meta {
    id: Uuid,
    sha: B32,
    source_bytes: u64,
    path_bytes: u64,
    field_bytes: u64,
    tag_bytes: u64,
    billed: u64,
}
fn metadata(row: &[SqlValue], request: &QueryProjectionRequest) -> StoreResult<Meta> {
    let [id, sha, source, path, fields, tags] = row else {
        return Err(corrupt());
    };
    let id = B16(bytes(id)?.try_into().map_err(|_| corrupt())?);
    let sha = B32(bytes(sha)?.try_into().map_err(|_| corrupt())?);
    let source_bytes = number(source)?;
    let path_bytes = number(path)?;
    let field_bytes = number(fields)?;
    let tag_bytes = number(tags)?;
    if source_bytes > MAX_SOURCE as u64
        || path_bytes > 4096
        || field_bytes
            .checked_add(tag_bytes)
            .is_none_or(|n| n > MAX_PAYLOAD as u64)
    {
        return Err(corrupt());
    }
    // Conservative complete retained payload accounting, including presence
    // markers for requested names absent from the stored map. Never source text.
    let billed = 128
        + path_bytes
        + 8 * request.fields.len() as u64
        + if request.fields.is_empty() {
            0
        } else {
            field_bytes
        }
        + if request.tags { tag_bytes } else { 0 };
    Ok(Meta {
        id,
        sha,
        source_bytes,
        path_bytes,
        field_bytes,
        tag_bytes,
        billed,
    })
}

/// All uses only raw readiness. Other necessary predicates use R6's existing
/// selector, under its independent field-index generation/head fence.
pub(crate) fn page<I: IndexStorage>(
    index: &Rc<RefCell<I>>,
    request: &QueryProjectionRequest,
) -> StoreResult<QueryProjectionPage> {
    request.check()?;
    fence(index, request)?;
    let mut params = vec![];
    let (condition, candidates_more, expected) = if let Some(ids) = &request.bases_records {
        params.extend(ids.iter().map(|id| blob(&id.0)));
        (
            format!("q.id IN ({})", vec!["?"; ids.len()].join(",")),
            false,
            Some(ids.clone()),
        )
    } else if request.predicate == QueryPredicate::All {
        let condition = match request.bases_candidate.as_ref() {
            Some(p) => {
                let (condition, candidate_params) = candidate::condition(p)?;
                params.extend(candidate_params);
                condition
            }
            None => "1".to_owned(),
        };
        match request.after {
            Some(after) => {
                params.push(blob(&after.0));
                (format!("({condition}) AND q.id>?"), false, None)
            }
            None => (condition, false, None),
        }
    } else {
        let (ids, has_more) = crate::sql_select::projection_ids(index, request)?;
        if ids.is_empty() {
            fence(index, request)?;
            if has_more {
                return Err(corrupt());
            }
            return Ok(QueryProjectionPage::default());
        }
        params.extend(ids.iter().map(|id| blob(&id.0)));
        (
            format!("id IN ({})", vec!["?"; ids.len()].join(",")),
            has_more,
            Some(ids),
        )
    };
    // The bound limit is already an Integer. Keep its exact value while hiding
    // it from SQLite's prepare-time LIMIT estimation, which otherwise expires
    // the cached metadata statement on every bind and reparses every raw page.
    params.push(SqlValue::Integer(i64::from(request.limit) + 1));
    let result = run(
        index,
        Stmt::new(
            format!(
                "SELECT CASE WHEN length(id)=16 THEN id ELSE NULL END,CASE WHEN length(source_sha)=32 THEN source_sha ELSE NULL END,source_bytes,length(path),length(fields),length(tags) FROM st_qraw q WHERE {condition} ORDER BY id LIMIT CAST(? AS INTEGER)"
            ),
            params,
        ),
    )?;
    if result.columns != 6
        || result.values.len() % 6 != 0
        || result.values.len() / 6 > request.limit as usize + 1
    {
        return Err(corrupt());
    }
    let mut meta = Vec::new();
    let mut previous = request.after;
    for row in result.values.chunks_exact(6) {
        let row = metadata(row, request)?;
        if previous.is_some_and(|id| row.id <= id) {
            return Err(corrupt());
        }
        previous = Some(row.id);
        meta.push(row);
    }
    if expected.as_ref().is_some_and(|ids| {
        ids.len() != meta.len() || ids.iter().zip(&meta).any(|(id, row)| *id != row.id)
    }) {
        return Err(corrupt());
    }
    let mut has_more = candidates_more || meta.len() > request.limit as usize;
    meta.truncate(request.limit as usize);
    let mut encoded_bytes = 0u64;
    let mut admitted = 0usize;
    for row in &meta {
        let next = encoded_bytes
            .checked_add(row.billed)
            .ok_or(StoreError::Full)?;
        if next > request.max_bytes {
            has_more = true;
            break;
        }
        encoded_bytes = next;
        admitted += 1;
    }
    if admitted == 0 {
        if !meta.is_empty() {
            return Err(StoreError::Full);
        }
        fence(index, request)?;
        return Ok(QueryProjectionPage::default());
    }
    meta.truncate(admitted);
    let mut params = vec![
        SqlValue::Integer(i64::from(!request.fields.is_empty())),
        SqlValue::Integer(i64::from(request.tags)),
    ];
    params.extend(meta.iter().map(|row| blob(&row.id.0)));
    let result = run(
        index,
        Stmt::new(
            format!(
                "SELECT id,path,source_sha,source_bytes,CASE WHEN ?=1 THEN fields ELSE NULL END,CASE WHEN ?=1 THEN tags ELSE NULL END FROM st_qraw WHERE id IN ({}) ORDER BY id",
                vec!["?"; meta.len()].join(",")
            ),
            params,
        ),
    )?;
    if result.columns != 6 || result.values.len() != meta.len() * 6 {
        return Err(corrupt());
    }
    let mut rows = Vec::with_capacity(meta.len());
    for (values, meta) in result.values.chunks_exact(6).zip(&meta) {
        let [id, path, sha, source, fields, tags] = values else {
            return Err(corrupt());
        };
        if bytes(id)? != meta.id.0
            || bytes(sha)? != meta.sha.0
            || number(source)? != meta.source_bytes
            || bytes(path)?.len() as u64 != meta.path_bytes
        {
            return Err(corrupt());
        }
        let path = String::from_utf8(bytes(path)?.to_vec()).map_err(|_| corrupt())?;
        let fields = if request.fields.is_empty() {
            if !matches!(fields, SqlValue::Null) {
                return Err(corrupt());
            }
            vec![]
        } else {
            let encoded = bytes(fields)?;
            if encoded.len() as u64 != meta.field_bytes {
                return Err(corrupt());
            }
            values::fields(encoded, &request.fields)?
        };
        let tags = if !request.tags {
            if !matches!(tags, SqlValue::Null) {
                return Err(corrupt());
            }
            None
        } else {
            let encoded = bytes(tags)?;
            if encoded.len() as u64 != meta.tag_bytes {
                return Err(corrupt());
            }
            values::tags(encoded)?
        };
        rows.push(QueryProjectionRow {
            id: meta.id,
            path,
            source_sha: meta.sha,
            source_bytes: meta.source_bytes,
            fields,
            tags,
        });
    }
    fence(index, request)?;
    let page = QueryProjectionPage {
        rows,
        encoded_bytes,
        has_more,
    };
    page.check(request).map_err(|_| corrupt())?;
    Ok(page)
}
