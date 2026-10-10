//! Bounded metadata-only SQL selection. Predicate lowering is explicit and
//! canonical; total ordering is never substituted for CEL type eligibility.
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;

use crate::index::{Batch, BatchMode, IndexStorage, SqlValue, Stmt, StmtResult};
use mdbn_core::query::indexed::SortAtom;
use mdbn_replica::store::{StoreError, StoreResult};
use mdbn_replica::store_query::{
    QueryAtom, QueryColumn, QueryCompare, QueryField, QueryIndexPage, QueryIndexRequest,
    QueryKeyedId, QueryPredicate, QueryProjectionRequest,
};
use mdbn_wire::common::B16;

fn invalid() -> StoreError {
    StoreError::Io("unsupported or invalid indexed query".into())
}
fn stale() -> StoreError {
    StoreError::Io("query selection stale; restart required".into())
}
fn corrupt() -> StoreError {
    StoreError::Io("corrupt indexed selection result".into())
}
fn atom(a: &QueryAtom) -> StoreResult<()> {
    SortAtom::from_parts(a.kind, &a.key, 8192)
        .map(|_| ())
        .map_err(|_| invalid())
}
struct Builder {
    fields: BTreeMap<QueryField, usize>,
    params: Vec<SqlValue>,
    nodes: usize,
    bytes: usize,
}
impl Builder {
    fn parameter(&mut self, p: SqlValue) -> StoreResult<String> {
        self.bytes = self
            .bytes
            .checked_add(match &p {
                SqlValue::Blob(b) => b.len(),
                SqlValue::Text(t) => t.len(),
                _ => 8,
            })
            .ok_or(StoreError::Full)?;
        if self.params.len() >= 100 || self.bytes > 1 << 20 {
            return Err(StoreError::Full);
        }
        self.params.push(p);
        Ok("?".into())
    }
    fn column(&mut self, c: &QueryColumn) -> StoreResult<(String, String)> {
        match c {
            QueryColumn::Path => Ok(("4".into(), "q.path".into())),
            QueryColumn::Field(f) => {
                if f.source > 1 || f.path_key.len() > 1024 {
                    return Err(invalid());
                }
                let next = self.fields.len();
                let n = *self.fields.entry(f.clone()).or_insert(next);
                if self.fields.len() > 16 {
                    return Err(StoreError::Full);
                }
                Ok((format!("f{n}.kind"), format!("f{n}.sort")))
            }
        }
    }
    fn field_joins(
        &self,
        fields: &[QueryField],
        params: &mut Vec<SqlValue>,
    ) -> StoreResult<String> {
        let mut joins = String::new();
        for (f, n) in &self.fields {
            if !fields.contains(f) {
                return Err(invalid());
            }
            // Ready coverage includes Null255 for every field/ID, so this
            // shared indexed join never discards missing/null records.
            joins.push_str(&format!(
                " JOIN st_field f{n} ON f{n}.id=q.id AND f{n}.source=? AND f{n}.field=?"
            ));
            params.extend([
                SqlValue::Integer(i64::from(f.source)),
                SqlValue::Blob(f.path_key.clone()),
            ]);
        }
        Ok(joins)
    }
    fn predicate(&mut self, p: &QueryPredicate, depth: usize) -> StoreResult<String> {
        self.nodes += 1;
        if self.nodes > 128 || depth > 16 {
            return Err(StoreError::Full);
        }
        match p {
            QueryPredicate::All => Ok("1".into()),
            QueryPredicate::Types(names) => {
                if names.is_empty() {
                    return Ok("0".into());
                }
                if names.len() > 16 || names.iter().any(|n| n.len() > 256) {
                    return Err(StoreError::Full);
                }
                let mut terms = Vec::new();
                for n in names {
                    terms.push(self.parameter(SqlValue::Text(n.clone()))?);
                }
                Ok(format!(
                    "EXISTS(SELECT 1 FROM st_qtype t WHERE t.id=q.id AND t.name IN ({}))",
                    terms.join(",")
                ))
            }
            QueryPredicate::Compare { column, op, value } => {
                atom(value)?;
                // Ne, structured equality and temporal predicates require a
                // separately proven canonical lowering; never guess them here.
                if *op == QueryCompare::Ne
                    || !matches!(value.kind, 1 | 2 | 4 | 255)
                    || (*op != QueryCompare::Eq && !matches!(value.kind, 2 | 4))
                {
                    return Err(invalid());
                }
                let (kind, key) = self.column(column)?;
                let cmp = match op {
                    QueryCompare::Eq => "=",
                    QueryCompare::Lt => "<",
                    QueryCompare::Le => "<=",
                    QueryCompare::Gt => ">",
                    QueryCompare::Ge => ">=",
                    QueryCompare::Ne => return Err(invalid()),
                };
                let parameter = self.parameter(SqlValue::Blob(value.key.clone()))?;
                Ok(format!("({kind}={} AND {key}{cmp}{parameter})", value.kind))
            }
            // Ready coverage has an explicit atom (Null255 for missing) for every
            // field/ID joined, so the inner clause is never SQL NULL.
            QueryPredicate::Not(inner) => {
                Ok(format!("(NOT {})", self.predicate(inner, depth + 1)?))
            }
            QueryPredicate::And(ps) | QueryPredicate::Or(ps) => {
                let and = matches!(p, QueryPredicate::And(_));
                if ps.is_empty() {
                    return Ok(if and { "1" } else { "0" }.into());
                }
                if ps.len() > 128 {
                    return Err(StoreError::Full);
                }
                let mut clauses = Vec::new();
                for p in ps {
                    clauses.push(self.predicate(p, depth + 1)?);
                }
                Ok(format!(
                    "({})",
                    clauses.join(if and { " AND " } else { " OR " })
                ))
            }
        }
    }
}
fn run<I: IndexStorage>(index: &Rc<RefCell<I>>, stmts: Vec<Stmt>) -> StoreResult<Vec<StmtResult>> {
    let n = stmts.len();
    let results = index
        .borrow_mut()
        .run(&Batch {
            mode: BatchMode::Autocommit,
            stmts,
        })
        .map_err(|e| {
            if e.kind == crate::index::IndexErrorKind::Full {
                StoreError::Full
            } else {
                // Only the error kind: the engine's text names schema and
                // statements, and this reaches clients (client diagnostics).
                StoreError::Io(format!("indexed query SQL failed ({:?})", e.kind))
            }
        })?;
    if results.len() != n {
        return Err(corrupt());
    }
    Ok(results)
}
fn count(r: &StmtResult) -> StoreResult<u64> {
    match (r.columns, r.values.as_slice()) {
        (1, [SqlValue::Integer(n)]) => u64::try_from(*n).map_err(|_| corrupt()),
        _ => Err(corrupt()),
    }
}
fn id(v: &SqlValue) -> StoreResult<B16> {
    let SqlValue::Blob(b) = v else {
        return Err(corrupt());
    };
    Ok(B16(b.as_slice().try_into().map_err(|_| corrupt())?))
}
fn integer(v: &SqlValue) -> StoreResult<u64> {
    let SqlValue::Integer(n) = v else {
        return Err(corrupt());
    };
    u64::try_from(*n).map_err(|_| corrupt())
}
fn validate_snapshot<I: IndexStorage>(
    index: &Rc<RefCell<I>>,
    req: &QueryIndexRequest,
) -> StoreResult<()> {
    let Some(s) = crate::sql_fields::state(index)? else {
        return Err(invalid());
    };
    if !s.ready {
        return Err(StoreError::Io(
            "query index not ready; rebuild required".into(),
        ));
    }
    if s.generation != req.generation || s.head != req.head {
        return Err(stale());
    }
    Ok(())
}

/// Count-free UUID projection candidates. The SAME bounded predicate compiler,
/// ready-field joins and generation/head fence serve both R6 result adapters.
/// A single LIMIT+1 probe supplies continuation without per-page full counts.
pub(crate) fn projection_ids<I: IndexStorage>(
    index: &Rc<RefCell<I>>,
    req: &QueryProjectionRequest,
) -> StoreResult<(Vec<B16>, bool)> {
    req.check()?;
    let state = crate::sql_fields::state(index)?.ok_or_else(invalid)?;
    if !state.ready || state.head != req.head || state.generation != req.generation {
        return Err(stale());
    }
    let mut b = Builder {
        fields: BTreeMap::new(),
        params: vec![],
        nodes: 0,
        bytes: 0,
    };
    let predicate = b.predicate(&req.predicate, 0)?;
    let mut params = Vec::new();
    let joins = b.field_joins(&state.fields, &mut params)?;
    params.append(&mut b.params);
    let after = if let Some(after) = req.after {
        params.push(SqlValue::Blob(after.0.to_vec()));
        " AND q.id>?"
    } else {
        ""
    };
    params.push(SqlValue::Integer(i64::from(req.limit) + 1));
    if params.len() > 100 {
        return Err(StoreError::Full);
    }
    let results = run(
        index,
        vec![Stmt::new(
            format!(
                "SELECT CASE WHEN length(q.id)=16 THEN q.id ELSE NULL END FROM st_qrecord q JOIN st_rec r ON r.id=q.id{joins} WHERE {predicate}{after} ORDER BY q.id ASC LIMIT ?"
            ),
            params,
        )],
    )?;
    let result = &results[0];
    if result.columns != 1 || result.values.len() > req.limit as usize + 1 {
        return Err(corrupt());
    }
    let mut ids = Vec::with_capacity(result.values.len());
    let mut previous = req.after;
    for value in &result.values {
        let next = id(value)?;
        if previous.is_some_and(|prev| next <= prev) {
            return Err(corrupt());
        }
        previous = Some(next);
        ids.push(next);
    }
    let after_state = crate::sql_fields::state(index)?.ok_or_else(stale)?;
    if !after_state.ready
        || after_state.generation != req.generation
        || after_state.head != req.head
    {
        return Err(stale());
    }
    let has_more = ids.len() > req.limit as usize;
    ids.truncate(req.limit as usize);
    Ok((ids, has_more))
}

/// Select IDs/keys after preflighting returned key lengths. Copies no record BLOB.
pub fn select<I: IndexStorage>(
    index: &Rc<RefCell<I>>,
    req: &QueryIndexRequest,
) -> StoreResult<QueryIndexPage> {
    if req.limit > 1000
        || req.order.len() > 8
        || req.max_key_bytes > 1 << 20
        || i64::try_from(req.offset).is_err()
    {
        return Err(StoreError::Full);
    }
    if let Some(after) = &req.after {
        if after.keys.len() != req.order.len() {
            return Err(invalid());
        }
        for a in &after.keys {
            atom(a)?;
        }
    }
    let mut b = Builder {
        fields: BTreeMap::new(),
        params: vec![],
        nodes: 0,
        bytes: 0,
    };
    let mut order = Vec::new();
    for term in &req.order {
        order.push((b.column(&term.column)?, term.descending));
    }
    let predicate = b.predicate(&req.predicate, 0)?;
    let predicate_params = std::mem::take(&mut b.params);
    let mut params = Vec::new();
    let mut prefix = String::new();
    if let Some(after) = &req.after {
        let mut names = Vec::new();
        for (i, a) in after.keys.iter().enumerate() {
            names.extend([format!("k{i}"), format!("s{i}")]);
            params.extend([
                SqlValue::Integer(i64::from(a.kind)),
                SqlValue::Blob(a.key.clone()),
            ]);
        }
        names.push("id".into());
        params.push(SqlValue::Blob(after.id.0.to_vec()));
        prefix = format!(
            "WITH c({}) AS (VALUES({})) ",
            names.join(","),
            vec!["?"; names.len()].join(",")
        );
    }
    let state = crate::sql_fields::state(index)?.ok_or_else(invalid)?;
    if !state.ready || state.head != req.head || state.generation != req.generation {
        return Err(stale());
    }
    // Generic selection only: drive the ready, fully covered ORDER field's
    // existing B-tree, rather than the predicate field then a whole-result sort.
    // CROSS JOIN pins loop order; coverage includes explicit Null255, so these
    // are the SAME exact joins/predicate, not a necessary-candidate shortcut.
    let leading = req.order.first().and_then(|term| match &term.column {
        QueryColumn::Field(field) => b.fields.get(field).map(|n| (*n, term.descending)),
        QueryColumn::Path => None,
    });
    let (mut from, final_id) = if let Some((lead, descending)) = leading {
        let (field, _) = b
            .fields
            .iter()
            .find(|(_, n)| **n == lead)
            .ok_or_else(invalid)?;
        if !state.fields.contains(field) {
            return Err(invalid());
        }
        let index = if descending {
            "st_field_desc"
        } else {
            "st_field_asc"
        };
        let mut from = format!(
            " /* generic ordered seek */ FROM st_field f{lead} INDEXED BY {index} CROSS JOIN st_qrecord q ON q.id=f{lead}.id AND f{lead}.source=? AND f{lead}.field=? CROSS JOIN st_rec r ON r.id=q.id"
        );
        params.extend([
            SqlValue::Integer(i64::from(field.source)),
            SqlValue::Blob(field.path_key.clone()),
        ]);
        for (field, n) in &b.fields {
            if *n == lead {
                continue;
            }
            if !state.fields.contains(field) {
                return Err(invalid());
            }
            from.push_str(&format!(
                " CROSS JOIN st_field f{n} ON f{n}.id=q.id AND f{n}.source=? AND f{n}.field=?"
            ));
            params.extend([
                SqlValue::Integer(i64::from(field.source)),
                SqlValue::Blob(field.path_key.clone()),
            ]);
        }
        (from, format!("f{lead}.id"))
    } else {
        let joins = b.field_joins(&state.fields, &mut params)?;
        (
            format!(" FROM st_qrecord q JOIN st_rec r ON r.id=q.id{joins}"),
            "q.id".into(),
        )
    };
    if req.after.is_some() {
        from.push_str(" CROSS JOIN c");
    }
    params.extend(predicate_params);
    from.push_str(&format!(" WHERE {predicate}"));
    let mut after_sql = String::new();
    if req.after.is_some() {
        let mut terms = Vec::new();
        let mut equal = Vec::new();
        for (i, ((k, s), desc)) in order.iter().enumerate() {
            let cmp = if *desc { "<" } else { ">" };
            for (expr, cursor) in [(k, format!("c.k{i}")), (s, format!("c.s{i}"))] {
                terms.push(format!(
                    "({}{}{} {cmp} {cursor})",
                    equal.join(" AND "),
                    if equal.is_empty() { "" } else { " AND " },
                    expr
                ));
                equal.push(format!("{expr}={cursor}"));
            }
        }
        terms.push(format!(
            "({}{}q.id>c.id)",
            equal.join(" AND "),
            if equal.is_empty() { "" } else { " AND " }
        ));
        after_sql = format!(" AND ({})", terms.join(" OR "));
        if let Some((lead, descending)) = leading {
            // The inclusive leading-term bound is necessary for every full
            // multi-term continuation. KEEP the exact residual above. With a
            // single ASC term the complete (kind,key,ID) bound is exclusive.
            // Scalar references to the one-row CTE let SQLite seek before its
            // nested loops, without extra key copies or caller budget credit.
            if !descending && order.len() == 1 {
                after_sql.push_str(&format!(" AND (f{lead}.kind,f{lead}.sort,f{lead}.id) > ((SELECT k0 FROM c),(SELECT s0 FROM c),(SELECT id FROM c))"));
            } else {
                let cmp = if descending { "<=" } else { ">=" };
                after_sql.push_str(&format!(
                    " AND (f{lead}.kind,f{lead}.sort) {cmp} ((SELECT k0 FROM c),(SELECT s0 FROM c))"
                ));
            }
        }
    }
    let mut ordering = Vec::new();
    let mut metadata = vec!["q.id".into(), "length(r.row)".into()];
    let mut data = metadata.clone();
    for ((kind, key), desc) in &order {
        // A constant kind (the path column's literal `4`) must not appear in
        // ORDER BY: SQLite reads a constant integer there as a result-column
        // index, which differs between the metadata and data selects.
        if kind.parse::<u8>().is_err() {
            ordering.push(format!("{kind} {}", if *desc { "DESC" } else { "ASC" }));
        }
        ordering.push(format!("{key} {}", if *desc { "DESC" } else { "ASC" }));
        metadata.extend([kind.clone(), format!("length({key})")]);
        data.extend([kind.clone(), key.clone()]);
    }
    ordering.push(format!("{final_id} ASC"));
    let tail = format!(
        "{after_sql} ORDER BY {} LIMIT ? OFFSET ?",
        ordering.join(",")
    );
    let offset = SqlValue::Integer(i64::try_from(req.offset).map_err(|_| invalid())?);
    let mut page_params = params.clone();
    page_params.extend([SqlValue::Integer(i64::from(req.limit)), offset.clone()]);
    // The metadata select reads one row past the page: that row (never returned,
    // never copied) is `has_more`, so no count over every match is needed.
    let mut lookahead_params = params.clone();
    lookahead_params.extend([SqlValue::Integer(i64::from(req.limit) + 1), offset]);
    if page_params.len() > 100 {
        return Err(StoreError::Full);
    }
    let mut stmts = vec![Stmt::new(
        format!("{prefix}SELECT {}{from}{tail}", metadata.join(",")),
        lookahead_params,
    )];
    if req.count_matches {
        stmts.push(Stmt::new(format!("{prefix}SELECT count(*){from}"), params));
    }
    let results = run(index, std::mem::take(&mut stmts))?;
    let total_matches = match results.get(1) {
        Some(c) => Some(count(c)?),
        None => None,
    };
    let columns = 2 + 2 * order.len();
    let meta = &results[0];
    if usize::try_from(meta.columns).map_err(|_| corrupt())? != columns
        || meta.values.len() % columns != 0
        || meta.values.len() / columns > req.limit as usize + 1
    {
        return Err(corrupt());
    }
    let has_more = meta.values.len() / columns > req.limit as usize;
    let page_values = &meta.values[..meta.values.len().min(columns * req.limit as usize)];
    let mut bytes = 0u64;
    for row in page_values.chunks_exact(columns) {
        id(&row[0])?;
        integer(&row[1])?;
        for pair in row[2..].chunks_exact(2) {
            let kind = integer(&pair[0])?;
            if !matches!(kind, 1 | 2 | 3 | 4 | 5 | 6 | 255) {
                return Err(corrupt());
            }
            bytes = bytes
                .checked_add(integer(&pair[1])?)
                .ok_or(StoreError::Full)?;
            if bytes > req.max_key_bytes {
                return Err(StoreError::Full);
            }
        }
    }
    // Only after the complete metadata key budget fits may keys be copied.
    let fetched = run(
        index,
        vec![Stmt::new(
            format!("{prefix}SELECT {}{from}{tail}", data.join(",")),
            page_params,
        )],
    )?;
    let result = &fetched[0];
    if result.columns != meta.columns || result.values.len() != page_values.len() {
        return Err(stale());
    }
    let mut rows = Vec::new();
    for (r, m) in result
        .values
        .chunks_exact(columns)
        .zip(page_values.chunks_exact(columns))
    {
        if r[..2] != m[..2] {
            return Err(stale());
        }
        let mut keys = Vec::new();
        for (pair, expected) in r[2..].chunks_exact(2).zip(m[2..].chunks_exact(2)) {
            let SqlValue::Blob(key) = &pair[1] else {
                return Err(corrupt());
            };
            if pair[0] != expected[0] || key.len() as u64 != integer(&expected[1])? {
                return Err(stale());
            }
            let value = QueryAtom {
                kind: u8::try_from(integer(&pair[0])?).map_err(|_| corrupt())?,
                key: key.clone(),
            };
            atom(&value)?;
            keys.push(value);
        }
        rows.push(QueryKeyedId {
            id: id(&r[0])?,
            encoded_bytes: integer(&r[1])?,
            keys,
        });
    }
    validate_snapshot(index, req)?;
    Ok(QueryIndexPage {
        has_more,
        rows,
        total_matches,
    })
}
