//! Contract inspection uses Core projection and the existing bounded query cursor.
use super::super::Replica;
use crate::api::{
    ApiResult, ContractProjection, ContractQuery, ContractQueryRecord, ContractQueryResult,
    ErrorCode, SessionId,
};
use crate::layer::LayerView;
use crate::plan::StoreView;
use crate::{Store, convert};
use mdbn_core::state::StateView;
use mdbn_wire::client::{Include, Issue, QueryResult, Severity};
use mdbn_wire::common::Value;

const PROJECTION_BYTES: usize = 1024 * 1024;

impl<S: Store> Replica<S> {
    pub(super) fn inspect_contract_page(
        &mut self,
        session: SessionId,
        request: ContractQuery,
    ) -> ApiResult<ContractQueryResult> {
        self.require(session, crate::policy::capability::READ)?;
        if !(1..=128).contains(&request.limit)
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
        let env = filter.as_ref().map(|_| {
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
        // The ordinary cursor fingerprints context too: callers cannot reuse a
        // continuation for another contract/version even with identical types.
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
            (
                "context".into(),
                Value::Map(
                    [
                        ("contract".into(), Value::Text(request.contract)),
                        ("version".into(), Value::Text(request.version)),
                        ("digest".into(), Value::Text(digest.to_hex())),
                    ]
                    .into_iter()
                    .chain(
                        request
                            .where_
                            .clone()
                            .map(|w| ("where".into(), Value::Text(w))),
                    )
                    .collect(),
                ),
            ),
        ];
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
            let effective = catalog.effective_frontmatter(&record.types, &raw);
            let bytes = mdbn_core::value::Value::Map(effective.clone())
                .to_json()
                .len();
            let mut projections = Vec::new();
            for implementation in implementations
                .iter()
                .filter(|i| record.types.contains(&i.type_name))
            {
                // Charge a conservative clone bound before Core copies mapped values.
                let charge = bytes
                    .checked_mul(implementation.fields.len().max(1))
                    .and_then(|n| {
                        n.checked_add(
                            implementation
                                .fields
                                .iter()
                                .map(|(a, b)| a.len() + b.len())
                                .sum::<usize>(),
                        )
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
                if let (Some(plan), Some(env)) = (&filter, &env) {
                    let candidate = mdbn_core::query::QueryRecord {
                        path: &record.path,
                        types: &[],
                        frontmatter: &fields,
                        body: None,
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
            if filter.is_some() && projections.is_empty() {
                continue;
            }
            records.push(ContractQueryRecord {
                id: record.id,
                implementations: projections,
            });
        }
        let mut page = page;
        if filter.is_some() {
            let kept: Vec<_> = records.iter().map(|r| r.id).collect();
            page.records.retain(|r| kept.contains(&r.id));
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
            > PROJECTION_BYTES
        {
            return Err(ErrorCode::TooLarge.err_with_reason(
                "contract_projection_budget",
                "Contract page exceeds its response budget.",
            ));
        }
        Ok(result)
    }
}
