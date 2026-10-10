//! Describe projects only registered contracts and valid resolved implementations.

use mdbn_core::types::Catalog;
use mdbn_core::value::Value;
use mdbn_wire::common::DataMap;

use crate::api::{ContractImplementation, ContractSummary, TypeSummary};
use crate::convert;

pub(super) fn summaries(cat: &Catalog) -> (Vec<TypeSummary>, Vec<ContractSummary>) {
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
                })
                .collect(),
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
        })
        .collect();
    (types, contracts)
}
