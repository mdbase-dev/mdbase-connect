//! Bounded metadata-only SQL selection. Predicate lowering is explicit and
//! canonical; total ordering is never substituted for CEL type eligibility.
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;

use crate::index::{Batch, BatchMode, IndexStorage, SqlValue, Stmt, StmtResult};
use crate::index_codec::CodecLimits;
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
    needs_mtime: bool,
    path_col: &'static str,
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
            QueryColumn::Path => Ok(("4".into(), self.path_col.into())),
            QueryColumn::Mtime => {
                self.needs_mtime = true;
                Ok(("m.kind".into(), "m.sort".into()))
            }
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
            // An FTS5 phrase: the trigram tokenizer matches it as a substring.
            // Shorter needles have no trigram; SQL text cannot hold a NUL.
            QueryPredicate::BodyContains(needle) => {
                if needle.chars().nth(2).is_none() || needle.contains('\0') {
                    return Err(invalid());
                }
                let phrase = self.parameter(SqlValue::Text(format!(
                    "\"{}\"",
                    needle.replace('"', "\"\"")
                )))?;
                Ok(format!(
                    "q.id IN (SELECT b.id FROM st_qbody_n b WHERE b.n IN (SELECT rowid FROM st_qbody WHERE st_qbody MATCH {phrase}))"
                ))
            }
            // Ready coverage has an explicit atom (Null255 for missing) for every
            // field/ID joined, so the inner clause is never SQL NULL.
            // `st_qmtime` only holds kind 3 (Temporal) or kind 255 (Null, sort=X''),
            // so `NOT (mtime == Null)` (`has(file.mtime)`) lowers directly to
            // `m.kind=3` so SQLite seeks `st_qmtime_{asc,desc}` without scanning
            // null rows.
            QueryPredicate::Not(inner) => match inner.as_ref() {
                QueryPredicate::Compare {
                    column: QueryColumn::Mtime,
                    op: QueryCompare::Eq,
                    value,
                } if value.kind == 255 && value.key.is_empty() => {
                    self.needs_mtime = true;
                    Ok("(m.kind=3)".into())
                }
                _ => Ok(format!("(NOT {})", self.predicate(inner, depth + 1)?)),
            },
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
        needs_mtime: false,
        path_col: "q.path",
        params: vec![],
        nodes: 0,
        bytes: 0,
    };
    let predicate = b.predicate(&req.predicate, 0)?;
    let mut params = Vec::new();
    let mut joins = b.field_joins(&state.fields, &mut params)?;
    if b.needs_mtime {
        joins.push_str(" JOIN st_qmtime m ON m.id=q.id");
    }
    params.append(&mut b.params);
    let after = if let Some(after) = req.after {
        params.push(SqlValue::Blob(after.0.to_vec()));
        " AND q.id>?"
    } else {
        ""
    };
    params.push(SqlValue::Integer(i64::from(req.limit) + 1));
    if params.len() > CodecLimits::HOSTED.max_parameters {
        return Err(StoreError::Full);
    }
    let results = run(
        index,
        vec![Stmt::new(
            format!(
                "SELECT CASE WHEN length(q.id)=16 THEN q.id ELSE NULL END FROM st_qrecord q JOIN st_rec r ON r.id=q.id{joins} WHERE ({predicate}){after} AND NOT EXISTS(SELECT 1 FROM st_qraw s WHERE s.id=q.id AND length(s.fields)=0) ORDER BY q.id ASC LIMIT ?"
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

fn requires_null_mtime(p: &QueryPredicate) -> bool {
    match p {
        QueryPredicate::Compare {
            column: QueryColumn::Mtime,
            op: QueryCompare::Eq,
            value,
        } => value.kind == 255 && value.key.is_empty(),
        QueryPredicate::And(ps) => ps.iter().any(requires_null_mtime),
        _ => false,
    }
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
    let null_mtime_path_order = requires_null_mtime(&req.predicate)
        && (req.order.is_empty()
            || (req.order.len() == 1
                && req.order[0].column == QueryColumn::Path
                && !req.order[0].descending));
    let mut b = Builder {
        fields: BTreeMap::new(),
        needs_mtime: false,
        path_col: if null_mtime_path_order {
            "m.path"
        } else {
            "q.path"
        },
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
    let mut cte_params = Vec::new();
    let mut prefix = String::new();
    if let Some(after) = &req.after {
        let mut names = Vec::new();
        for (i, a) in after.keys.iter().enumerate() {
            names.extend([format!("k{i}"), format!("s{i}")]);
            cte_params.extend([
                SqlValue::Integer(i64::from(a.kind)),
                SqlValue::Blob(a.key.clone()),
            ]);
        }
        names.push("path".into());
        cte_params.push(SqlValue::Blob(after.path.as_bytes().to_vec()));
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
    #[derive(Clone, Copy)]
    enum Leading {
        Field(usize, bool),
        Mtime(bool),
        /// `!has(file.mtime)` in ascending path order: every matching row has
        /// `(kind=255, sort=X'')`, so `st_qmtime_asc(kind, sort, path)` yields
        /// exact ascending path order without scanning known-mtime rows.
        MtimeNullPath,
    }
    let leading = if null_mtime_path_order {
        Some(Leading::MtimeNullPath)
    } else {
        req.order.first().and_then(|term| match &term.column {
            QueryColumn::Field(field) => b
                .fields
                .get(field)
                .map(|n| Leading::Field(*n, term.descending)),
            QueryColumn::Mtime => Some(Leading::Mtime(term.descending)),
            QueryColumn::Path => None,
        })
    };
    let mut body_params = Vec::new();
    // The final ascending path tie-break. A leading field's or mtime's index
    // rows carry the path, so the seek yields the complete order without a sort.
    let (mut from_base, final_path) = match leading {
        Some(Leading::Field(lead, descending)) => {
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
            body_params.extend([
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
                body_params.extend([
                    SqlValue::Integer(i64::from(field.source)),
                    SqlValue::Blob(field.path_key.clone()),
                ]);
            }
            if b.needs_mtime {
                from.push_str(" CROSS JOIN st_qmtime m ON m.id=q.id");
            }
            (from, format!("f{lead}.path"))
        }
        Some(Leading::Mtime(descending)) => {
            let index = if descending {
                "st_qmtime_desc"
            } else {
                "st_qmtime_asc"
            };
            let mut from = format!(
                " /* generic ordered seek */ FROM st_qmtime m INDEXED BY {index} CROSS JOIN st_qrecord q ON q.id=m.id CROSS JOIN st_rec r ON r.id=q.id"
            );
            for (field, n) in &b.fields {
                if !state.fields.contains(field) {
                    return Err(invalid());
                }
                from.push_str(&format!(
                    " CROSS JOIN st_field f{n} ON f{n}.id=q.id AND f{n}.source=? AND f{n}.field=?"
                ));
                body_params.extend([
                    SqlValue::Integer(i64::from(field.source)),
                    SqlValue::Blob(field.path_key.clone()),
                ]);
            }
            (from, "m.path".into())
        }
        Some(Leading::MtimeNullPath) => {
            let mut from = " /* generic ordered seek */ FROM st_qmtime m INDEXED BY st_qmtime_asc CROSS JOIN st_qrecord q ON q.id=m.id CROSS JOIN st_rec r ON r.id=q.id".to_string();
            for (field, n) in &b.fields {
                if !state.fields.contains(field) {
                    return Err(invalid());
                }
                from.push_str(&format!(
                    " CROSS JOIN st_field f{n} ON f{n}.id=q.id AND f{n}.source=? AND f{n}.field=?"
                ));
                body_params.extend([
                    SqlValue::Integer(i64::from(field.source)),
                    SqlValue::Blob(field.path_key.clone()),
                ]);
            }
            (from, "m.path".into())
        }
        None => {
            let mut joins = b.field_joins(&state.fields, &mut body_params)?;
            if b.needs_mtime {
                joins.push_str(" JOIN st_qmtime m ON m.id=q.id");
            }
            (
                format!(" FROM st_qrecord q JOIN st_rec r ON r.id=q.id{joins}"),
                "q.path".into(),
            )
        }
    };
    body_params.extend(predicate_params);
    let mut from_with_c = from_base.clone();
    if req.after.is_some() {
        from_with_c.push_str(" CROSS JOIN c");
    }
    from_base.push_str(&format!(" WHERE {predicate}"));
    from_with_c.push_str(&format!(" WHERE {predicate}"));
    let mut ordering = Vec::new();
    let mut metadata = vec![
        "q.id".into(),
        "length(r.row)".into(),
        format!("length({final_path})"),
    ];
    let mut data = vec!["q.id".into(), "length(r.row)".into(), final_path.clone()];
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
    let final_path_order = format!("{final_path} ASC");
    if ordering.last().map(String::as_str) != Some(final_path_order.as_str()) {
        ordering.push(final_path_order);
    }
    let order_clause = ordering.join(",");

    // Single-term DESC continuations (`offset == 0`): SQLite row-value bounds
    // cannot mix `(kind DESC, sort DESC)` with `path ASC`, so an inclusive
    // `(kind, sort) <= (k0, s0)` bound revisits every earlier path in a tied
    // bucket (quadratic in large tie/null groups). Partition into disjoint,
    // strictly ordered index seeks concatenated by `UNION ALL`:
    //   1) same bucket with `path > c.path`
    //   2) same kind with `sort < c.s0` (omitted for Null, whose key is always empty)
    //   3) smaller kind `kind < k0` (omitted when no smaller kind exists)
    // Each branch seeks directly into the covering `*_desc` index without a sort.
    let desc_branches: Option<Vec<String>> = match (&req.after, leading) {
        (Some(after), Some(Leading::Mtime(true))) if req.offset == 0 && order.len() == 1 => {
            let k0 = after.keys[0].kind;
            let mut branches = vec![format!(
                "m.kind={k0} AND m.sort=(SELECT s0 FROM c) AND m.path>(SELECT path FROM c)"
            )];
            if k0 != 255 {
                branches.push(format!("m.kind={k0} AND m.sort<(SELECT s0 FROM c)"));
            }
            if k0 > 3 {
                branches.push(format!("m.kind<{k0}"));
            }
            let total_params = cte_params.len() + branches.len() * (body_params.len() + 1) + 1;
            (total_params <= CodecLimits::HOSTED.max_parameters).then_some(branches)
        }
        (Some(after), Some(Leading::Field(n, true))) if req.offset == 0 && order.len() == 1 => {
            let alias = format!("f{n}");
            let k0 = after.keys[0].kind;
            let mut branches = vec![format!(
                "{alias}.kind={k0} AND {alias}.sort=(SELECT s0 FROM c) AND {alias}.path>(SELECT path FROM c)"
            )];
            if k0 != 255 {
                branches.push(format!(
                    "{alias}.kind={k0} AND {alias}.sort<(SELECT s0 FROM c)"
                ));
            }
            if k0 > 1 {
                branches.push(format!("{alias}.kind<{k0}"));
            }
            let total_params = cte_params.len() + branches.len() * (body_params.len() + 1) + 1;
            (total_params <= CodecLimits::HOSTED.max_parameters).then_some(branches)
        }
        _ => None,
    };

    let (meta_stmt, data_stmt) = if let Some(branches) = desc_branches {
        let build_branched = |cols: &str, row_limit: i64| -> Stmt {
            let parts: Vec<String> = branches
                .iter()
                .map(|b| {
                    format!(
                        "SELECT * FROM (SELECT {cols}{from_base} AND ({b}) ORDER BY {order_clause} LIMIT ?)"
                    )
                })
                .collect();
            let mut p = cte_params.clone();
            for _ in &branches {
                p.extend(body_params.iter().cloned());
                p.push(SqlValue::Integer(row_limit));
            }
            p.push(SqlValue::Integer(row_limit));
            Stmt::new(format!("{prefix}{} LIMIT ?", parts.join(" UNION ALL ")), p)
        };
        (
            build_branched(&metadata.join(","), i64::from(req.limit) + 1),
            build_branched(&data.join(","), i64::from(req.limit)),
        )
    } else {
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
                "({}{}{final_path}>c.path)",
                equal.join(" AND "),
                if equal.is_empty() { "" } else { " AND " }
            ));
            after_sql = format!(" AND ({})", terms.join(" OR "));
            if let Some(lead) = leading {
                match lead {
                    Leading::MtimeNullPath => {
                        after_sql.push_str(" AND m.path>(SELECT path FROM c)");
                    }
                    Leading::Field(n, descending) => {
                        let alias = format!("f{n}");
                        if !descending && order.len() == 1 {
                            after_sql.push_str(&format!(" AND ({alias}.kind,{alias}.sort,{alias}.path) > ((SELECT k0 FROM c),(SELECT s0 FROM c),(SELECT path FROM c))"));
                        } else {
                            let cmp = if descending { "<=" } else { ">=" };
                            after_sql.push_str(&format!(
                                " AND ({alias}.kind,{alias}.sort) {cmp} ((SELECT k0 FROM c),(SELECT s0 FROM c))"
                            ));
                        }
                    }
                    Leading::Mtime(descending) => {
                        if !descending && order.len() == 1 {
                            after_sql.push_str(" AND (m.kind,m.sort,m.path) > ((SELECT k0 FROM c),(SELECT s0 FROM c),(SELECT path FROM c))");
                        } else {
                            let cmp = if descending { "<=" } else { ">=" };
                            after_sql.push_str(&format!(
                                " AND (m.kind,m.sort) {cmp} ((SELECT k0 FROM c),(SELECT s0 FROM c))"
                            ));
                        }
                    }
                }
            }
        }
        let tail = format!("{after_sql} ORDER BY {order_clause} LIMIT ? OFFSET ?");
        let offset = SqlValue::Integer(i64::try_from(req.offset).map_err(|_| invalid())?);
        let mut base_params = cte_params.clone();
        base_params.extend(body_params.iter().cloned());
        let mut page_params = base_params.clone();
        page_params.extend([SqlValue::Integer(i64::from(req.limit)), offset.clone()]);
        // The metadata select reads one row past the page: that row (never returned,
        // never copied) is `has_more`, so no count over every match is needed.
        let mut lookahead_params = base_params;
        lookahead_params.extend([SqlValue::Integer(i64::from(req.limit) + 1), offset]);
        if page_params.len() > CodecLimits::HOSTED.max_parameters {
            return Err(StoreError::Full);
        }
        (
            Stmt::new(
                format!("{prefix}SELECT {}{from_with_c}{tail}", metadata.join(",")),
                lookahead_params,
            ),
            Stmt::new(
                format!("{prefix}SELECT {}{from_with_c}{tail}", data.join(",")),
                page_params,
            ),
        )
    };

    let mut stmts = vec![meta_stmt];
    if req.count_matches {
        let mut count_params = cte_params;
        count_params.extend(body_params);
        if count_params.len() > CodecLimits::HOSTED.max_parameters {
            return Err(StoreError::Full);
        }
        stmts.push(Stmt::new(
            format!("{prefix}SELECT count(*){from_with_c}"),
            count_params,
        ));
    }
    let results = run(index, std::mem::take(&mut stmts))?;
    let total_matches = match results.get(1) {
        Some(c) => Some(count(c)?),
        None => None,
    };
    let columns = 3 + 2 * order.len();
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
        // The returned path counts toward the key budget before it is copied.
        bytes = bytes
            .checked_add(integer(&row[2])?)
            .ok_or(StoreError::Full)?;
        if bytes > req.max_key_bytes {
            return Err(StoreError::Full);
        }
        for pair in row[3..].chunks_exact(2) {
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
    let fetched = run(index, vec![data_stmt])?;
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
        let SqlValue::Blob(path) = &r[2] else {
            return Err(corrupt());
        };
        if path.len() as u64 != integer(&m[2])? {
            return Err(stale());
        }
        let path = String::from_utf8(path.clone()).map_err(|_| corrupt())?;
        let mut keys = Vec::new();
        for (pair, expected) in r[3..].chunks_exact(2).zip(m[3..].chunks_exact(2)) {
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
            path,
        });
    }
    validate_snapshot(index, req)?;
    Ok(QueryIndexPage {
        has_more,
        rows,
        total_matches,
    })
}
