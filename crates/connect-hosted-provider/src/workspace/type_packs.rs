use mdbase_connect_protocol::{
    AssessCollectionSetupInput, ContractSetupChoice, ContractSetupMode, TypePackProvision,
};

use crate::error::{ApiError, ApiResult};

pub(crate) fn engine_type_pack_provision(
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

pub(crate) fn engine_contract_setup(
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

pub(crate) fn engine_collection_setup(
    input: &AssessCollectionSetupInput,
) -> ApiResult<mdbase::v03::CollectionSetup> {
    let type_packs = input
        .provisions
        .type_packs
        .iter()
        .map(|provision| {
            let provision_setups = input
                .contract_setups
                .iter()
                .filter(|setup| provision.provides.contains(&setup.contract))
                .collect::<Vec<_>>();
            let has_existing = provision_setups
                .iter()
                .any(|setup| matches!(setup.mode, ContractSetupMode::Existing { .. }));
            let has_starter = provision_setups
                .iter()
                .any(|setup| matches!(setup.mode, ContractSetupMode::Starter));
            if has_existing
                && has_starter
                && provision
                    .manifest
                    .resources
                    .iter()
                    .any(|resource| resource.mode == "seed")
            {
                return Err(ApiError::bad_request(
                    "ambiguous_seed_setup",
                    "A type pack with shared seed resources cannot mix starter and existing-type setup. Split the pack by contract.",
                ));
            }
            let preserve_seed_targets = if has_existing {
                provision
                    .manifest
                    .resources
                    .iter()
                    .filter(|resource| resource.mode == "seed")
                    .map(|resource| resource.target.clone())
                    .collect()
            } else {
                Default::default()
            };
            Ok(mdbase::v03::CollectionSetupTypePack {
                provision: engine_type_pack_provision(provision)?,
                options: mdbase::v03::CollectionSetupTypePackOptions {
                    adopt_resources: input
                        .type_pack_adoptions
                        .get(&provision.manifest.id)
                        .cloned()
                        .unwrap_or_default(),
                    preserve_seed_targets,
                    contract_setups: provision_setups
                        .into_iter()
                        .filter(|setup| {
                            matches!(setup.mode, ContractSetupMode::Existing { .. })
                        })
                        .map(engine_contract_setup)
                        .collect(),
                    ..Default::default()
                },
            })
        })
        .collect::<ApiResult<Vec<_>>>()?;
    Ok(mdbase::v03::CollectionSetup {
        application_id: input.application_id.clone(),
        declaration_digest: input.declaration_digest.clone(),
        requirements: mdbase::v03::CollectionSetupRequirements {
            configuration: input
                .requirements
                .configuration
                .iter()
                .map(|requirement| mdbase::v03::ConfigurationRequirement {
                    id: requirement.id.clone(),
                    path: requirement.path.clone(),
                    predicate: mdbase::v03::ConfigurationPredicate::Contains,
                    value: requirement.value.clone(),
                })
                .collect(),
        },
        provisions: mdbase::v03::CollectionSetupProvisions {
            configuration: input
                .provisions
                .configuration
                .iter()
                .map(|provision| mdbase::v03::ConfigurationProvision {
                    requirement: provision.requirement.clone(),
                    operation: mdbase::v03::ConfigurationOperation::SetAdd,
                    path: provision.path.clone(),
                    value: provision.value.clone(),
                })
                .collect(),
            type_packs,
        },
    })
}
