use mdbase_connect_protocol::{ContractSetupChoice, ContractSetupMode, TypePackProvision};

use crate::error::{ApiError, ApiResult};

pub(super) fn engine_type_pack_provision(
    provision: &TypePackProvision,
) -> ApiResult<mdbase::v03::TypePackProvision> {
    let manifest = serde_json::to_value(&provision.manifest).map_err(|error| {
        ApiError::internal(format!(
            "The type pack manifest could not serialize: {error}"
        ))
    })?;
    Ok(mdbase::v03::TypePackProvision {
        manifest,
        resources: provision
            .resources
            .iter()
            .map(|resource| mdbase::v03::TypePackResource {
                source: resource.source.clone(),
                document: resource.document.clone(),
            })
            .collect(),
    })
}

pub(super) fn engine_contract_setup(
    setup: &ContractSetupChoice,
) -> mdbase::v03::ContractSetupChoice {
    let contract = mdbase::v03::ContractIdentity {
        id: setup.contract.id.clone(),
        version: setup.contract.version.clone(),
    };
    let mode = match &setup.mode {
        ContractSetupMode::Starter => mdbase::v03::ContractSetupMode::Starter,
        ContractSetupMode::Existing {
            type_name,
            type_revision,
            fields,
            binding,
        } => {
            mdbase::v03::ContractSetupMode::Existing(mdbase::v03::ExistingContractImplementation {
                type_name: type_name.clone(),
                type_revision: type_revision.clone(),
                fields: fields.clone(),
                binding: binding.clone(),
            })
        }
    };
    mdbase::v03::ContractSetupChoice { contract, mode }
}
