//! Describe projects only registered contracts and valid resolved implementations.

use mdbn_core::state::StateView;
use mdbn_core::types::Catalog;
use mdbn_core::value::Value;
use mdbn_wire::common::DataMap;

use crate::api::{ContractImplementation, ContractSummary, TypeSummary};
use crate::convert;

/// Encoded definitions and schemas one `describe` may carry.
pub(crate) const DEFINITIONS_BUDGET: usize = 8 << 20;

/// Refuse definitions whose encoding exceeds [`DEFINITIONS_BUDGET`]: the caller
/// reads them one by one with `get_resource` instead.
pub(super) fn within_budget(d: &crate::api::Describe) -> crate::api::ApiResult<()> {
    use crate::api::ErrorCode;
    use mdbn_wire::schema::Wire;
    let encoded = |v: &mdbn_wire::common::Value| {
        mdbn_wire::cbor::encode(&v.to_cbor())
            .map(|bytes| bytes.len())
            .map_err(|_| ErrorCode::Internal.err("unencodable definition"))
    };
    let mut total = 0usize;
    let values = d
        .types
        .iter()
        .flat_map(|t| t.definition.iter().chain(t.schema.iter()))
        .chain(
            d.contracts
                .iter()
                .flat_map(|c| c.schemas.iter().flat_map(|m| m.0.iter().map(|(_, v)| v))),
        );
    for v in values {
        total = total.saturating_add(encoded(v)?);
        if total > DEFINITIONS_BUDGET {
            return Err(ErrorCode::TooLarge.err_with_reason(
                "describe_budget_exceeded",
                "type and contract definitions exceed the describe budget; read them with get_resource",
            ));
        }
    }
    Ok(())
}

/// Summaries of `view`'s catalog. Revisions are of the same view's sources, so
/// they are valid resource CAS bases. `definitions` adds each type's definition
/// and schema and each contract's schemas.
pub(super) fn summaries(
    view: &dyn StateView,
    definitions: bool,
) -> (Vec<TypeSummary>, Vec<ContractSummary>) {
    let cat: std::sync::Arc<Catalog> = view.catalog();
    let types = cat
        .types()
        .iter()
        .map(|t| TypeSummary {
            name: t.name.clone(),
            path: t.source_path.clone(),
            implements: cat
                .implementations()
                .iter()
                .filter(|i| i.type_name == t.name)
                .map(|i| ContractImplementation {
                    contract: i.contract.clone(),
                    version: i.version.to_string(),
                    fields: DataMap(i.fields.clone()),
                    binding: (!i.binding.is_empty())
                        .then(|| convert::wvalue(&Value::Map(i.binding.clone()))),
                    digest: Some(convert::whash(&i.digest)),
                })
                .collect(),
            version: t.version,
            revision: view
                .resource(&t.source_path)
                .map(|source| convert::whash(&mdbn_core::ids::revision(&source))),
            definition: definitions.then(|| convert::wvalue(&Value::Map(t.raw.clone()))),
            schema: definitions.then(|| convert::wvalue(&t.schema_value())),
        })
        .collect();
    let contracts = cat
        .contracts()
        .iter()
        .map(|c| ContractSummary {
            id: c.id.clone(),
            version: c.version.to_string(),
            path: c.source_path.clone(),
            digest: convert::whash(&c.digest),
            contract_type: c.contract_type.clone(),
            implemented_by: cat
                .implementations()
                .iter()
                .filter(|i| i.contract == c.id && i.version == c.version)
                .map(|i| i.type_name.clone())
                .collect(),
            schemas: definitions.then(|| {
                DataMap(
                    c.schemas
                        .iter()
                        .map(|(member, source)| (member.clone(), convert::wvalue(&source.value())))
                        .collect(),
                )
            }),
        })
        .collect();
    (types, contracts)
}

impl<S: crate::store::Store> super::Replica<S> {
    /// `describe` over the local view: pending definition changes included, as
    /// `get_resource` reads them.
    pub(super) fn describe_view(
        &mut self,
        session: crate::api::SessionId,
        definitions: bool,
    ) -> crate::api::ApiResult<crate::api::Describe> {
        self.require(session, crate::policy::capability::READ)?;
        let base = crate::plan::StoreView::new(&self.store, self.catalog.clone());
        let local = crate::layer::LayerView {
            base: &base,
            layer: &self.layer,
        };
        let cat = local.catalog();
        let (types, contracts) = summaries(&local, definitions);
        // StoreView records read errors; never report a missing revision for one.
        if let Some(error) = base.error() {
            return Err(super::store_err(error));
        }
        Ok(crate::api::Describe {
            spec_version: cat.spec_version().unwrap_or("").to_string(),
            types,
            contracts,
            settings: mdbn_wire::common::Value::Null,
            inclusion: self
                .store
                .settings()
                .map_err(super::store_err)?
                .unwrap_or_else(|| convert::winclusion(&Default::default())),
            issues: cat
                .issues()
                .iter()
                .map(|i| mdbn_wire::client::Issue {
                    code: i.code.clone(),
                    severity: match i.severity {
                        mdbn_core::validate::Severity::Error => mdbn_wire::client::Severity::Error,
                        _ => mdbn_wire::client::Severity::Warning,
                    },
                    message: i.message.clone(),
                    details: Some(mdbn_wire::common::Value::Map(
                        i.location
                            .iter()
                            .map(|path| {
                                ("path".into(), mdbn_wire::common::Value::Text(path.clone()))
                            })
                            .chain(i.type_name.iter().map(|name| {
                                (
                                    "typeName".into(),
                                    mdbn_wire::common::Value::Text(name.clone()),
                                )
                            }))
                            .collect(),
                    )),
                })
                .collect(),
        })
    }
}
