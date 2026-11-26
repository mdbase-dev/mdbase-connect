//! Contract inspection uses Core projection and the existing bounded query cursor.
use super::super::Replica;
use crate::api::{
    ApiResult, ContractProjection, ContractQuery, ContractQueryRecord, ContractQueryResult,
    ErrorCode, SessionId,
};
use crate::layer::LayerView;
use crate::plan::StoreView;
use crate::{Store, convert};
use mdbn_core::query::{Direction, FieldRef, OrderTerm};
use mdbn_core::state::StateView;
use mdbn_wire::client::{Include, Issue, QueryResult, Severity};
use mdbn_wire::common::Value;
use std::collections::BTreeMap;

const MAX_PAGE_SIZE: u32 = 1000;
const MAX_ORDER_TERMS: usize = 8;
const MAX_ORDER_FIELD_BYTES: usize = 256;
const PROJECTION_BYTES: usize = 1024 * 1024;
const RESPONSE_BYTES: usize = 2 * 1024 * 1024;

fn invalid_order(message: impl Into<String>) -> crate::api::ApiError {
    ErrorCode::InvalidRequest.err_with_reason("invalid_query", message)
}

fn direction_str(direction: Direction) -> &'static str {
    match direction {
        Direction::Asc => "asc",
        Direction::Desc => "desc",
    }
}

fn order_term_value(field: String, direction: Direction) -> Value {
    Value::Map(vec![
        ("field".into(), Value::Text(field)),
        (
            "direction".into(),
            Value::Text(direction_str(direction).into()),
        ),
    ])
}

/// Validate and parse spec 11 `order_by` terms using Core's own parser.
/// Returns the parsed terms and a canonical wire value for cursor binding.
fn parse_contract_order(raw: &Value) -> ApiResult<(Vec<OrderTerm>, Value)> {
    let Value::List(entries) = raw else {
        return Err(invalid_order(
            "`order_by` must be a non-empty list of order terms.",
        ));
    };
    if entries.is_empty() || entries.len() > MAX_ORDER_TERMS {
        return Err(invalid_order(format!(
            "`order_by` must contain 1..={MAX_ORDER_TERMS} terms."
        )));
    }
    for entry in entries {
        let Value::Map(fields) = entry else {
            return Err(invalid_order("each `order_by` term must be a map."));
        };
        let mut seen_field = false;
        let mut seen_direction = false;
        for (key, value) in fields {
            match key.as_str() {
                "field" if !seen_field => {
                    seen_field = true;
                    let Value::Text(name) = value else {
                        return Err(invalid_order("`order_by[].field` must be a string."));
                    };
                    if name.is_empty() || name.len() > MAX_ORDER_FIELD_BYTES {
                        return Err(invalid_order("`order_by[].field` is empty or too long."));
                    }
                }
                "direction" if !seen_direction => {
                    seen_direction = true;
                    let Value::Text(dir) = value else {
                        return Err(invalid_order("`order_by[].direction` must be asc or desc."));
                    };
                    if dir != "asc" && dir != "desc" {
                        return Err(invalid_order("`order_by[].direction` must be asc or desc."));
                    }
                }
                _ => {
                    return Err(invalid_order(
                        "unexpected or duplicate `order_by` term member.",
                    ));
                }
            }
        }
        if !seen_field {
            return Err(invalid_order("each `order_by` term requires `field`."));
        }
    }
    let query_value = convert::value(&Value::Map(vec![("order_by".into(), raw.clone())]))
        .map_err(|e| invalid_order(e.to_string()))?;
    let parsed = mdbn_core::query::Query::from_value(&query_value)
        .map_err(|e| invalid_order(format!("{e:?}")))?;
    if parsed.order_by.len() != entries.len() {
        return Err(invalid_order("invalid `order_by` terms."));
    }
    let mut canonical = Vec::with_capacity(parsed.order_by.len());
    for term in &parsed.order_by {
        let canonical_field = match &term.field {
            FieldRef::Path => "file.path".to_owned(),
            FieldRef::File(name) => format!("file.{name}"),
            FieldRef::Effective(parts) => parts.join("."),
            FieldRef::Persisted(_) | FieldRef::Projection(_) | FieldRef::Types => {
                return Err(invalid_order(
                    "contract `order_by` supports contract fields and `file.*` only.",
                ));
            }
        };
        canonical.push(order_term_value(canonical_field, term.direction));
    }
    Ok((parsed.order_by, Value::List(canonical)))
}

fn ref_key_segments(reference: &str) -> Option<Vec<String>> {
    let steps = mdbn_core::types::parse_field_ref(reference)?;
    let mut keys = Vec::with_capacity(steps.len());
    for step in steps {
        match step {
            mdbn_core::types::FieldStep::Key(k) if !k.is_empty() && !k.contains('.') => {
                keys.push(k);
            }
            _ => return None,
        }
    }
    (!keys.is_empty()).then_some(keys)
}

/// Map a contract field reference (spec 11 effective segments) through one
/// implementation's `fields` mapping (JSON Pointers or dotted field refs).
/// Returns `Ok(None)` when the field is unmapped on this implementation,
/// `Ok(Some(dotted))` when it maps cleanly to a dotted record field path,
/// or `Err(...)` when the mapping uses an array/index/non-dotted step that
/// cannot be expressed in spec 11 `order_by`.
fn map_contract_field(
    implementation: &mdbn_core::contracts::Implementation,
    contract_parts: &[String],
) -> ApiResult<Option<String>> {
    let mut best: Option<(usize, Vec<String>)> = None;
    for (cf, rf) in &implementation.fields {
        let Some(cf_keys) = ref_key_segments(cf) else {
            continue;
        };
        if contract_parts.len() >= cf_keys.len()
            && contract_parts[..cf_keys.len()] == cf_keys[..]
            && best.as_ref().is_none_or(|(len, _)| cf_keys.len() > *len)
        {
            let Some(rf_keys) = ref_key_segments(rf) else {
                return Err(ErrorCode::InvalidRequest.err_with_reason(
                    "contract_order_unsupported",
                    format!(
                        "Contract order field `{}` maps to a non-orderable record reference `{rf}`.",
                        contract_parts.join(".")
                    ),
                ));
            };
            let mut mapped = rf_keys;
            mapped.extend_from_slice(&contract_parts[cf_keys.len()..]);
            best = Some((cf_keys.len(), mapped));
        }
    }
    Ok(best.map(|(_, keys)| keys.join(".")))
}

/// Resolve contract `order_by` terms into record-query `order_by` terms when
/// every active implementation maps each ordered contract field identically.
fn resolve_contract_order(
    terms: &[OrderTerm],
    implementations: &[&mdbn_core::contracts::Implementation],
) -> ApiResult<Vec<Value>> {
    let mut resolved = Vec::with_capacity(terms.len());
    for term in terms {
        match &term.field {
            FieldRef::Path => resolved.push(order_term_value("file.path".into(), term.direction)),
            FieldRef::File(name) => {
                resolved.push(order_term_value(format!("file.{name}"), term.direction))
            }
            FieldRef::Effective(parts) => {
                let mut first: Option<Option<String>> = None;
                for imp in implementations {
                    let mapped = map_contract_field(imp, parts)?;
                    match &first {
                        None => first = Some(mapped),
                        Some(prev) if *prev != mapped => {
                            return Err(ErrorCode::InvalidRequest.err_with_reason(
                                "contract_order_unsupported",
                                format!(
                                    "Contract order field `{}` maps differently across implementing types.",
                                    parts.join(".")
                                ),
                            ));
                        }
                        Some(_) => {}
                    }
                }
                if let Some(Some(record_field)) = first {
                    resolved.push(order_term_value(record_field, term.direction));
                }
            }
            FieldRef::Persisted(_) | FieldRef::Projection(_) | FieldRef::Types => {
                return Err(invalid_order(
                    "contract `order_by` supports contract fields and `file.*` only.",
                ));
            }
        }
    }
    Ok(resolved)
}

impl<S: Store> Replica<S> {
    pub(super) fn inspect_contract_page(
        &mut self,
        session: SessionId,
        request: ContractQuery,
    ) -> ApiResult<ContractQueryResult> {
        self.require(session, crate::policy::capability::READ)?;
        if !(1..=MAX_PAGE_SIZE).contains(&request.limit)
            || request.contract.len() > 1024
            || request.version.len() > 128
            || request.cursor.as_ref().is_some_and(|c| c.len() > 4096)
            || request
                .where_
                .as_ref()
                .is_some_and(|w| w.is_empty() || w.len() > 4096)
        {
            return Err(ErrorCode::InvalidRequest.err("Invalid contract page selection."));
        }
        let version = mdbn_core::contracts::Version::parse(&request.version).ok_or_else(|| {
            ErrorCode::InvalidRequest.err("An exact contract version is required.")
        })?;
        let parsed_order = request
            .order_by
            .as_ref()
            .map(parse_contract_order)
            .transpose()?;
        // Admission, selection and projection use the same actual local view
        // as ordinary reads, including pending definition changes.
        let catalog = {
            let view = StoreView::new(&self.store, self.catalog.clone());
            LayerView {
                base: &view,
                layer: &self.layer,
            }
            .catalog()
        };
        if !catalog.is_valid() {
            return Err(ErrorCode::CollectionInvalid.err("The contract catalog is invalid."));
        }
        let contract = catalog
            .contract(&request.contract, &version)
            .ok_or_else(|| {
                ErrorCode::NotFound
                    .err_with_reason("data_contract_not_found", "No such registered contract.")
            })?;
        if contract.contract_type != "record" {
            return Err(ErrorCode::InvalidRequest.err("A record contract is required."));
        }
        let digest = convert::whash(&contract.digest);
        // The filter runs on contract views (no types), in the record CEL dialect.
        let filter = request
            .where_
            .as_ref()
            .map(|w| {
                let query = mdbn_core::query::Query {
                    where_: Some(w.clone()),
                    ..Default::default()
                };
                mdbn_core::query::compile(&query, &catalog).map_err(|e| {
                    ErrorCode::InvalidRequest.err_with_reason("invalid_query", format!("{e:?}"))
                })
            })
            .transpose()?;
        // Narrow index pushdown: `has(file.mtime)` and `!has(file.mtime)` depend
        // only on the record's own capture time, so qualify rows in the index
        // before pagination to yield full pages instead of short/empty ones.
        let index_mtime_where = filter.as_ref().and_then(|p| p.where_mtime_presence());
        let residual_filter = if index_mtime_where.is_some() {
            None
        } else {
            filter.as_ref()
        };
        let env = residual_filter.map(|_| {
            let now = self.now();
            let tz = self.host.zones.default_zone();
            mdbn_core::query::QueryEnv {
                now_ms: now,
                today: self
                    .host
                    .zones
                    .local_date(now, &tz)
                    .unwrap_or_else(|| super::super::utc_date(now)),
                tz,
            }
        });
        let implementations: Vec<_> = catalog
            .implementations()
            .iter()
            .filter(|i| i.contract == request.contract && i.version == version)
            .collect();
        if implementations.len() > 128 || implementations.iter().any(|i| i.fields.len() > 128) {
            return Err(ErrorCode::TooLarge
                .err_with_reason("contract_projection_budget", "Too many contract mappings."));
        }
        if implementations.is_empty() {
            if request.cursor.is_some() {
                return Err(ErrorCode::InvalidRequest
                    .err_with_reason("cursor_stale", "Contract implementations changed."));
            }
            return Ok(ContractQueryResult {
                page: QueryResult {
                    records: vec![],
                    cursor: None,
                    complete: self.install.is_none(),
                    as_of: self.view_version,
                    columns: None,
                    total_count: Some(0),
                    diagnostics: None,
                    view: None,
                    groups: None,
                    has_more: Some(false),
                },
                records: vec![],
                contract_digest: digest,
            });
        }
        let resolved_order = parsed_order
            .as_ref()
            .map(|(terms, _)| resolve_contract_order(terms, &implementations))
            .transpose()?;
        // The ordinary cursor fingerprints context too: callers cannot reuse a
        // continuation for another contract/version/filter/order even with identical types.
        let mut context_entries = vec![
            ("contract".into(), Value::Text(request.contract)),
            ("version".into(), Value::Text(request.version)),
            ("digest".into(), Value::Text(digest.to_hex())),
        ];
        if let Some(where_) = request.where_.clone() {
            context_entries.push(("where".into(), Value::Text(where_)));
        }
        if let Some((_, canonical_order)) = parsed_order {
            context_entries.push(("order_by".into(), canonical_order));
        }
        let mut query = vec![
            (
                "types".into(),
                Value::List(
                    implementations
                        .iter()
                        .map(|i| Value::Text(i.type_name.clone()))
                        .collect(),
                ),
            ),
            ("limit".into(), Value::Int(i64::from(request.limit))),
            ("context".into(), Value::Map(context_entries)),
        ];
        if let Some(present) = index_mtime_where {
            query.push((
                "where".into(),
                Value::Text(
                    if present {
                        "has(file.mtime)"
                    } else {
                        "!has(file.mtime)"
                    }
                    .into(),
                ),
            ));
        }
        if let Some(order_terms) = resolved_order
            && !order_terms.is_empty()
        {
            query.push(("order_by".into(), Value::List(order_terms)));
        }
        if let Some(cursor) = request.cursor {
            query.push(("cursor".into(), Value::Text(cursor)));
        }
        let page = self.query_keyset(
            session,
            &Value::Map(query),
            &Include {
                effective: None,
                body: None,
                document: None,
                diagnostics: None,
            },
        )?;
        // Whole-scan stores do not mint cursors. A short fixed-type page is
        // complete; a full window without terminal metadata is NOT a directory.
        if page.cursor.is_none()
            && (page.has_more == Some(true)
                || (page.has_more.is_none() && page.records.len() >= request.limit as usize))
        {
            return Err(ErrorCode::UpgradeRequired.err_with_reason(
                "contract_query_cursor_required",
                "This contract inventory requires a maintained query index.",
            ));
        }
        let mut remaining = PROJECTION_BYTES;
        let mut records = Vec::new();
        for record in &page.records {
            let raw = convert::value(&Value::Map(record.frontmatter.0.clone()))
                .map_err(|e| ErrorCode::Internal.err(e.to_string()))?;
            let mdbn_core::value::Value::Map(raw) = raw else {
                unreachable!("frontmatter is a map")
            };
            let effective = catalog.effective_values(&record.path, &record.types, &raw);
            // Each record field's size is measured once, however many contract
            // fields map it.
            let mut sizes: BTreeMap<&str, usize> = BTreeMap::new();
            let mut projections = Vec::new();
            for implementation in implementations
                .iter()
                .filter(|i| record.types.contains(&i.type_name))
            {
                // Charge what Core is about to copy, before it copies: every
                // mapping clones the one value it selects. Unmapped fields are
                // never copied, so they cost nothing here.
                let charge = implementation
                    .fields
                    .iter()
                    .try_fold(0usize, |total, (a, b)| {
                        let value = *sizes.entry(b.as_str()).or_insert_with(|| {
                            mdbn_core::types::select_one(&effective, b)
                                .map_or(0, |v| v.to_json().len())
                        });
                        total
                            .checked_add(value)?
                            .checked_add(a.len())?
                            .checked_add(b.len())
                    });
                remaining = charge
                    .and_then(|n| remaining.checked_sub(n))
                    .ok_or_else(|| {
                        ErrorCode::TooLarge.err_with_reason(
                            "contract_projection_budget",
                            "Contract projection exceeds its page budget.",
                        )
                    })?;
                let (fields, issues) = implementation
                    .inspect_view(contract, &effective)
                    .map_err(|_| ErrorCode::Internal.err("A resolved contract mapping failed."))?;
                if let (Some(plan), Some(env)) = (residual_filter, &env) {
                    let candidate = mdbn_core::query::QueryRecord {
                        path: &record.path,
                        types: &[],
                        frontmatter: &fields,
                        body: None,
                        mtime: record.mtime,
                    };
                    if plan.matches(&candidate, env) != mdbn_core::query::Verdict::Match {
                        continue;
                    }
                }
                projections.push(ContractProjection {
                    type_name: implementation.type_name.clone(),
                    fields: convert::wmap(&fields),
                    issues: issues
                        .into_iter()
                        .map(|i| Issue {
                            code: i.code,
                            message: i.message,
                            severity: if i.severity == mdbn_core::validate::Severity::Error {
                                Severity::Error
                            } else {
                                Severity::Warning
                            },
                            details: None,
                        })
                        .collect(),
                });
            }
            if residual_filter.is_some() && projections.is_empty() {
                continue;
            }
            records.push(ContractQueryRecord {
                id: record.id,
                implementations: projections,
            });
        }
        let mut page = page;
        if filter.is_some() {
            if residual_filter.is_some() {
                let kept: Vec<_> = records.iter().map(|r| r.id).collect();
                page.records.retain(|r| kept.contains(&r.id));
            }
            page.total_count = None;
        }
        self.require(session, crate::policy::capability::READ)?;
        // Include validation diagnostics/encoding in the same fixed output cap.
        let result = ContractQueryResult {
            page,
            records,
            contract_digest: digest,
        };
        if mdbn_wire::cbor::encode(&result.to_cbor())
            .map_err(|_| ErrorCode::Internal.err("Contract page encoding failed."))?
            .len()
            > RESPONSE_BYTES
        {
            return Err(ErrorCode::TooLarge.err_with_reason(
                "contract_projection_budget",
                "Contract page exceeds its response budget.",
            ));
        }
        Ok(result)
    }
}
