use super::operation_setup::{
    add_reviewable_setup_adoptions, required_setup_string, type_pack_setup_error,
};
use super::*;
use std::collections::BTreeMap;

impl CollectionRegistry {
    pub fn validate(&self, id: Uuid) -> Result<Value, ConnectError> {
        self.operation(id, "validate", &json!({}))
    }

    pub fn operation(
        &self,
        id: Uuid,
        operation: &str,
        input: &Value,
    ) -> Result<Value, ConnectError> {
        self.operation_synchronized(id, operation, input, || Ok(()))
    }

    pub fn operation_synchronized(
        &self,
        id: Uuid,
        operation: &str,
        input: &Value,
        synchronize: impl FnOnce() -> Result<(), ConnectError>,
    ) -> Result<Value, ConnectError> {
        self.operation_synchronized_cancellable(
            id,
            operation,
            input,
            &mdbase::OperationCancellation::new(),
            synchronize,
        )
    }

    pub fn operation_synchronized_cancellable(
        &self,
        id: Uuid,
        operation: &str,
        input: &Value,
        cancellation: &mdbase::OperationCancellation,
        synchronize: impl FnOnce() -> Result<(), ConnectError>,
    ) -> Result<Value, ConnectError> {
        cancellation
            .check()
            .map_err(|_| ConnectError::OperationCancelled)?;
        let registered = self.get(id)?;
        assert_local_authority_folder(Path::new(&registered.path))?;
        if operation == "changes" {
            return serde_json::to_value(self.changes(id, input)?).map_err(ConnectError::from);
        }
        let sync_store = crate::LocalSyncStore::for_registry(self);
        sync_store.assert_authority_available(id)?;
        let executor = self.executor_for(&registered)?;
        let context = operation_context(cancellation);
        let result = if registered.spec_version.starts_with("0.3") && operation != "describe" {
            let request = runtime_operation_request(operation, input)?;
            if request.operation.is_mutation() {
                sync_store.assert_mutation_allowed(id)?;
                let result = executor.with_mutation(&context, |runtime| {
                    execute_runtime_request(require_runtime(runtime)?, &request, None, &context)
                })?;
                synchronize()?;
                Ok(serde_json::to_value(result.result)?)
            } else {
                let execution = execute_runtime_read(
                    &executor,
                    &request,
                    input,
                    &scope_binding(&GrantScope::full_collection())?,
                    &context,
                )?;
                serde_json::to_value(execution.result).map_err(ConnectError::from)
            }
        } else {
            let provider = executor.provider();
            let execute = |collection: &Collection| {
                if operation == "describe" {
                    return serde_json::to_value(self.describe_loaded(&registered, collection)?)
                        .map_err(ConnectError::from);
                }
                execute_loaded_cancellable(
                    collection,
                    &registered.spec_version,
                    operation,
                    input,
                    cancellation,
                )
            };
            if operation == "batch" || is_mutating_operation(operation, input) {
                let result = executor.with_mutation(&context, |_| {
                    provider.with_collection::<_, ConnectError>(|collection| {
                        sync_store.assert_mutation_allowed(id)?;
                        execute(collection)
                    })
                })?;
                executor.synchronize(&context)?;
                synchronize()?;
                Ok(result)
            } else {
                executor.with_foreground(&context, |_| provider.with_collection_read(execute))
            }
        };
        result.map_err(|error| classify_collection_error(&registered, error))
    }

    pub fn is_compatible(
        &self,
        id: Uuid,
        requirements: &ApplicationRequirements,
    ) -> Result<bool, ConnectError> {
        if requirements.contracts.is_empty() {
            return Ok(true);
        }
        let description = self.describe(id)?;
        Ok(requirements.contracts.iter().all(|required| {
            description.contracts.iter().any(|available| {
                available.id == required.id
                    && available.version == required.version
                    && available.digest == required.digest
            })
        }))
    }

    pub fn provision_application_setup(
        &self,
        id: Uuid,
        application_id: &str,
        declaration_digest: &str,
        requirements: &ApplicationRequirements,
        provisions: &ApplicationProvisions,
        contract_setups: &[ContractSetupChoice],
    ) -> Result<ApplicationSetupResult, ConnectError> {
        let description = self.describe(id)?;
        let missing = requirements
            .contracts
            .iter()
            .filter(|required| !has_contract(&description.contracts, required))
            .cloned()
            .collect::<Vec<_>>();
        if missing.iter().any(|required| {
            !provisions
                .type_packs
                .iter()
                .any(|provision| provision.provides.contains(required))
        }) {
            return Err(ConnectError::AccessDenied(
                "This collection is missing a required contract that the application cannot install."
                    .to_string(),
            ));
        }

        let setup_contracts = contract_setups
            .iter()
            .map(|setup| (setup.contract.id.clone(), setup.contract.version.clone()))
            .collect::<BTreeSet<_>>();
        if setup_contracts.len() != contract_setups.len() {
            return Err(ConnectError::InvalidInput(
                "Each required contract must have exactly one setup choice.".to_string(),
            ));
        }
        if contract_setups
            .iter()
            .any(|setup| !requirements.contracts.contains(&setup.contract))
        {
            return Err(ConnectError::AccessDenied(
                "Contract setup may only configure a contract required by this application."
                    .to_string(),
            ));
        }
        let missing_contracts = missing
            .iter()
            .map(|contract| (contract.id.clone(), contract.version.clone()))
            .collect::<BTreeSet<_>>();
        if !contract_setups.is_empty() && setup_contracts != missing_contracts {
            return Err(ConnectError::InvalidInput(
                "Choose starter or existing-type setup for each missing contract only.".to_string(),
            ));
        }
        let effective_setups = if contract_setups.is_empty() {
            missing
                .iter()
                .cloned()
                .map(|contract| ContractSetupChoice {
                    contract,
                    mode: ContractSetupMode::Starter,
                })
                .collect::<Vec<_>>()
        } else {
            contract_setups.to_vec()
        };
        let relevant_contracts = missing
            .iter()
            .map(|contract| (contract.id.as_str(), contract.version.as_str()))
            .collect::<BTreeSet<_>>();
        let type_packs = provisions
            .type_packs
            .iter()
            .filter(|provision| {
                provision.provides.iter().any(|provided| {
                    relevant_contracts
                        .contains(&(provided.id.as_str(), provided.version.as_str()))
                })
            })
            .map(|provision| {
                let provision_setups = effective_setups
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
                    return Err(ConnectError::InvalidInput(
                        "A type pack with shared seed resources cannot mix starter and existing-type setup. Split the pack by contract."
                            .to_string(),
                    ));
                }
                let preserve_seed_targets = if has_existing {
                    provision
                        .manifest
                        .resources
                        .iter()
                        .filter(|resource| resource.mode == "seed")
                        .map(|resource| resource.target.clone())
                        .collect::<BTreeSet<_>>()
                } else {
                    BTreeSet::new()
                };
                Ok(mdbase::v03::CollectionSetupTypePack {
                    provision: Self::engine_type_pack_provision(provision)?,
                    options: mdbase::v03::CollectionSetupTypePackOptions {
                        adopt_resources: BTreeMap::new(),
                        preserve_seed_targets,
                        target_overrides: BTreeMap::new(),
                        contract_setups: provision_setups
                            .into_iter()
                            .filter(|setup| {
                                matches!(setup.mode, ContractSetupMode::Existing { .. })
                            })
                            .map(Self::engine_contract_setup)
                            .collect(),
                    },
                })
            })
            .collect::<Result<Vec<_>, ConnectError>>()?;
        let mut setup = mdbase::v03::CollectionSetup {
            application_id: application_id.to_string(),
            declaration_digest: declaration_digest.to_string(),
            requirements: mdbase::v03::CollectionSetupRequirements {
                configuration: requirements
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
                configuration: provisions
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
        };
        let registered = self.get(id)?;
        let executor = self.executor_for(&registered)?;
        let provider = executor.provider();
        let (setup, options) = provider.with_collection_read(|collection| {
            let mut assessment = collection.assess_collection_setup(&setup);
            if assessment.result["applicable"].as_bool() != Some(true)
                && add_reviewable_setup_adoptions(&mut setup, &assessment)
            {
                assessment = collection.assess_collection_setup(&setup);
            }
            if !assessment.valid || assessment.result["applicable"].as_bool() != Some(true) {
                return Err(type_pack_setup_error(&assessment));
            }
            let expected_assessment_digest =
                required_setup_string(&assessment.result, "assessment_digest")?;
            let expected_collection_revision =
                required_setup_string(&assessment.result, "collection_revision")?;
            let expected_provision_digest =
                required_setup_string(&assessment.result, "provision_digest")?;
            Ok::<_, ConnectError>((
                setup,
                mdbase::v03::CollectionSetupApplyOptions {
                    expected_assessment_digest,
                    expected_collection_revision,
                    expected_provision_digest,
                    allow_type_pack_downgrades: BTreeSet::new(),
                },
            ))
        })?;
        let request = mdbase::runtime::OperationRequest::new(
            mdbase::runtime::OperationKind::ApplyCollectionSetup,
            json!({"setup": setup, "options": options}),
        );
        let context = operation_context(&mdbase::OperationCancellation::new());
        let applied = executor.with_mutation(&context, |runtime| {
            let result =
                execute_runtime_request(require_runtime(runtime)?, &request, None, &context)?
                    .result;
            if !result.valid {
                return Err(type_pack_setup_error(&result));
            }
            Ok(result.result)
        })?;

        let description = self.describe(id)?;
        if requirements
            .contracts
            .iter()
            .any(|required| !has_contract(&description.contracts, required))
        {
            return Err(ConnectError::AccessDenied(
                "The installed type definitions did not provide every required contract."
                    .to_string(),
            ));
        }
        Ok(ApplicationSetupResult {
            contracts: description.contracts,
            assessment: applied["assessment"].clone(),
            receipt: applied["receipt"].clone(),
        })
    }

    pub(super) fn engine_type_pack_provision(
        provision: &TypePackProvision,
    ) -> Result<mdbase::v03::TypePackProvision, ConnectError> {
        Ok(mdbase::v03::TypePackProvision {
            manifest: serde_json::to_value(&provision.manifest)?,
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
            } => mdbase::v03::ContractSetupMode::Existing(
                mdbase::v03::ExistingContractImplementation {
                    type_name: type_name.clone(),
                    type_revision: type_revision.clone(),
                    fields: fields.clone(),
                    binding: binding.clone(),
                },
            ),
        };
        mdbase::v03::ContractSetupChoice { contract, mode }
    }

    pub fn scoped_operation(
        &self,
        id: Uuid,
        operation: &str,
        input: &Value,
        scope: &GrantScope,
    ) -> Result<Value, ConnectError> {
        self.scoped_operation_synchronized(id, operation, input, scope, || Ok(()))
    }

    pub fn scoped_operation_synchronized(
        &self,
        id: Uuid,
        operation: &str,
        input: &Value,
        scope: &GrantScope,
        synchronize: impl FnOnce() -> Result<(), ConnectError>,
    ) -> Result<Value, ConnectError> {
        self.scoped_operation_synchronized_cancellable(
            id,
            operation,
            input,
            scope,
            &mdbase::OperationCancellation::new(),
            synchronize,
        )
    }

    pub fn scoped_operation_synchronized_cancellable(
        &self,
        id: Uuid,
        operation: &str,
        input: &Value,
        scope: &GrantScope,
        cancellation: &mdbase::OperationCancellation,
        synchronize: impl FnOnce() -> Result<(), ConnectError>,
    ) -> Result<Value, ConnectError> {
        cancellation
            .check()
            .map_err(|_| ConnectError::OperationCancelled)?;
        let registered = self.get(id)?;
        if !registered.enabled {
            return Err(ConnectError::AccessDenied(
                "This collection is disabled on its computer.".to_string(),
            ));
        }
        let sync_store = crate::LocalSyncStore::for_registry(self);
        sync_store.assert_authority_available(id)?;
        let executor = self.executor_for(&registered)?;
        let context = operation_context(cancellation);
        if registered.spec_version.starts_with("0.3") {
            let result = self.scoped_runtime_operation(
                &registered,
                &executor,
                operation,
                input,
                scope,
                cancellation,
                None,
            )?;
            if is_mutating_operation(operation, input) || operation == "batch" {
                synchronize()?;
            }
            return Ok(result);
        }
        let provider = executor.provider();
        let execute = |collection: &Collection| {
            sync_store.assert_authority_available(id)?;
            self.scoped_operation_loaded(
                &registered,
                collection,
                operation,
                input,
                scope,
                cancellation,
            )
        };
        if operation == "batch" || is_mutating_operation(operation, input) {
            let result = executor.with_mutation(&context, |_| {
                provider.with_collection(|collection| {
                    sync_store.assert_mutation_allowed(id)?;
                    execute(collection)
                })
            })?;
            executor.synchronize(&context)?;
            synchronize()?;
            Ok(result)
        } else {
            executor.with_foreground(&context, |_| provider.with_collection_read(execute))
        }
    }

    pub(super) fn scoped_operation_loaded(
        &self,
        registered: &CollectionSummary,
        collection: &Collection,
        operation: &str,
        input: &Value,
        scope: &GrantScope,
        cancellation: &mdbase::OperationCancellation,
    ) -> Result<Value, ConnectError> {
        let Some(resolved_scope) = self.resolve_operation_contract_scope_loaded(
            registered, collection, scope, operation, input,
        )?
        else {
            return match operation {
                "describe" => serde_json::to_value(self.describe_loaded(registered, collection)?)
                    .map_err(ConnectError::from),
                "changes" => serde_json::to_value(self.changes(registered.id, input)?)
                    .map_err(ConnectError::from),
                _ => execute_loaded_cancellable(
                    collection,
                    &registered.spec_version,
                    operation,
                    input,
                    cancellation,
                ),
            };
        };
        let allowed_types = &resolved_scope.allowed_types;

        match operation {
            "describe" => {
                let mut description = self.describe_loaded(registered, collection)?;
                description
                    .types
                    .retain(|type_definition| allowed_types.contains(&type_definition.name));
                description.contracts.retain(|contract| {
                    scope.contracts.iter().any(|pinned| {
                        pinned.id == contract.id
                            && pinned.version == contract.version
                            && pinned.digest == contract.digest
                    })
                });
                serde_json::to_value(description).map_err(ConnectError::from)
            }
            "changes" => {
                let mut page = self.changes(registered.id, input)?;
                page.events
                    .retain(|event| change_is_in_scope(event, allowed_types, Some(collection)));
                serde_json::to_value(page).map_err(ConnectError::from)
            }
            "query" => {
                let (input, selector) = resolved_scope
                    .query_input(input)
                    .map_err(contract_scope_error)?;
                let result = execute_loaded_cancellable(
                    collection,
                    &registered.spec_version,
                    operation,
                    &input,
                    cancellation,
                )?;
                resolved_scope
                    .project_result(collection, result, selector.as_ref())
                    .map_err(contract_scope_error)
            }
            "list_views"
            | "execute_view"
            | "read_view_source"
            | "create_view_source"
            | "update_view_source"
            | "delete_view_source" => Err(ConnectError::AccessDenied(
                "Saved views require full collection access because their source may select any record type."
                    .to_string(),
            )),
            "read" => {
                let (input, selector) = resolved_scope
                    .read_input(input)
                    .map_err(contract_scope_error)?;
                let result = execute_loaded_cancellable(
                    collection,
                    &registered.spec_version,
                    operation,
                    &input,
                    cancellation,
                )?;
                ensure_result_in_scope(&result, allowed_types)?;
                resolved_scope
                    .project_result(collection, result, selector.as_ref())
                    .map_err(contract_scope_error)
            }
            "create" => {
                let (input, selector) = resolved_scope
                    .map_write_input(input, true)
                    .map_err(contract_scope_error)?;
                let frontmatter = input
                    .get("frontmatter")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                let path = input.get("path").and_then(Value::as_str);
                let mut prospective_types = collection.determine_types_for_path(&frontmatter, path);
                if let Some(requested_type) = input.get("type").and_then(Value::as_str) {
                    prospective_types.push(requested_type.to_lowercase());
                }
                ensure_types_in_scope(&prospective_types, allowed_types)?;
                ensure_no_new_out_of_scope_types(
                    &prospective_types,
                    &BTreeSet::new(),
                    allowed_types,
                )?;
                let result = execute_loaded_cancellable(
                    collection,
                    &registered.spec_version,
                    operation,
                    &input,
                    cancellation,
                )?;
                if result.get("valid").and_then(Value::as_bool) != Some(false) {
                    ensure_result_in_scope(&result, allowed_types)?;
                }
                resolved_scope
                    .project_result(collection, result, Some(&selector))
                    .map_err(contract_scope_error)
            }
            "update" => {
                let (input, selector) = resolved_scope
                    .map_write_input(input, false)
                    .map_err(contract_scope_error)?;
                let path = required_string(&input, "path")?;
                let current = execute_loaded_cancellable(
                    collection,
                    &registered.spec_version,
                    "read",
                    &json!({ "path": path }),
                    cancellation,
                )?;
                ensure_result_in_scope(&current, allowed_types)?;
                let current_types = result_types(&current);
                let mut prospective = current
                    .pointer("/result/frontmatter")
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                if let Some(fields) = input.get("patch").and_then(Value::as_object) {
                    for (field, value) in fields {
                        if value.is_null() {
                            prospective.remove(field);
                        } else {
                            prospective.insert(field.clone(), value.clone());
                        }
                    }
                }
                let prospective_types =
                    collection.determine_types_for_path(&Value::Object(prospective), Some(path));
                ensure_types_in_scope(&prospective_types, allowed_types)?;
                ensure_no_new_out_of_scope_types(
                    &prospective_types,
                    &current_types,
                    allowed_types,
                )?;
                let result = execute_loaded_cancellable(
                    collection,
                    &registered.spec_version,
                    operation,
                    &input,
                    cancellation,
                )?;
                resolved_scope
                    .project_result(collection, result, Some(&selector))
                    .map_err(contract_scope_error)
            }
            "delete" => {
                let (scoped_input, selector) = resolved_scope
                    .identity_input(input)
                    .map_err(contract_scope_error)?;
                let path = required_string(&scoped_input, "path")?;
                let current = execute_loaded_cancellable(
                    collection,
                    &registered.spec_version,
                    "read",
                    &json!({ "path": path }),
                    cancellation,
                )?;
                ensure_result_in_scope(&current, allowed_types)?;
                resolved_scope
                    .authorize_record_result(collection, &current, selector.as_ref())
                    .map_err(contract_scope_error)?;
                let mut scoped_input = scoped_input;
                if let Some(object) = scoped_input.as_object_mut() {
                    object.insert("check_backlinks".to_string(), Value::Bool(false));
                }
                execute_loaded_cancellable(
                    collection,
                    &registered.spec_version,
                    operation,
                    &scoped_input,
                    cancellation,
                )
            }
            "rename" => {
                let (scoped_input, selector) = resolved_scope
                    .identity_input(input)
                    .map_err(contract_scope_error)?;
                let from = required_string(&scoped_input, "from")?;
                let to = required_string(&scoped_input, "to")?;
                if scoped_input.get("update_refs").and_then(Value::as_bool) == Some(true) {
                    return Err(ConnectError::AccessDenied(
                        "Reference updates can affect records outside this application's scope."
                            .to_string(),
                    ));
                }
                let current = execute_loaded_cancellable(
                    collection,
                    &registered.spec_version,
                    "read",
                    &json!({ "path": from }),
                    cancellation,
                )?;
                ensure_result_in_scope(&current, allowed_types)?;
                resolved_scope
                    .authorize_record_result(collection, &current, selector.as_ref())
                    .map_err(contract_scope_error)?;
                let current_types = result_types(&current);
                let frontmatter = current
                    .pointer("/result/frontmatter")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                let prospective_types = collection.determine_types_for_path(&frontmatter, Some(to));
                ensure_types_in_scope(&prospective_types, allowed_types)?;
                ensure_no_new_out_of_scope_types(
                    &prospective_types,
                    &current_types,
                    allowed_types,
                )?;
                let result = execute_loaded_cancellable(
                    collection,
                    &registered.spec_version,
                    operation,
                    &scoped_input,
                    cancellation,
                )?;
                resolved_scope
                    .project_result(collection, result, selector.as_ref())
                    .map_err(contract_scope_error)
            }
            "validate" => Err(ConnectError::AccessDenied(
                "Collection-wide validation is unavailable to a contract-scoped application."
                    .to_string(),
            )),
            "batch" => Err(ConnectError::AccessDenied(
                "Batch operations require full collection access.".to_string(),
            )),
            "list_types"
            | "read_type"
            | "create_type"
            | "update_type"
            | "apply_type_pack" => Err(
                ConnectError::AccessDenied(
                    "Collection schemas can only be managed by an application with full collection access."
                        .to_string(),
                ),
            ),
            other => Err(ConnectError::UnsupportedOperation(other.to_string())),
        }
    }

    pub(super) fn resolve_scope_types_loaded(
        &self,
        registered: &CollectionSummary,
        collection: &Collection,
        scope: &GrantScope,
    ) -> Result<Option<BTreeSet<String>>, ConnectError> {
        Ok(self
            .resolve_contract_scope_loaded(registered, collection, scope)?
            .map(|scope| scope.allowed_types))
    }

    pub(super) fn resolve_operation_contract_scope_loaded(
        &self,
        registered: &CollectionSummary,
        collection: &Collection,
        scope: &GrantScope,
        operation: &str,
        input: &Value,
    ) -> Result<Option<ContractScope>, ConnectError> {
        let portable_selector = matches!(
            operation,
            "query" | "read" | "create" | "update" | "delete" | "rename"
        ) && input.get("contract").is_some();
        if scope.access == mdbase_connect_protocol::ApplicationAccess::FullCollection {
            if !portable_selector {
                return Ok(None);
            }
            let contracts = self.describe_loaded(registered, collection)?.contracts;
            return ContractScope::new(contracts)
                .map(Some)
                .map_err(contract_scope_error);
        }
        self.resolve_contract_scope_loaded(registered, collection, scope)
    }

    fn resolve_contract_scope_loaded(
        &self,
        registered: &CollectionSummary,
        collection: &Collection,
        scope: &GrantScope,
    ) -> Result<Option<ContractScope>, ConnectError> {
        if scope.access == mdbase_connect_protocol::ApplicationAccess::FullCollection {
            return Ok(None);
        }
        if scope.contracts.is_empty() {
            return Err(ConnectError::AccessDenied(
                "Contract-scoped grants must declare at least one required contract.".to_string(),
            ));
        }
        let description = self.describe_loaded(registered, collection)?;
        let mut allowed_types = BTreeSet::new();
        for pinned in &scope.contracts {
            let Some(current) = description.contracts.iter().find(|contract| {
                contract.id == pinned.id
                    && contract.version == pinned.version
                    && contract.digest == pinned.digest
            }) else {
                return Err(ConnectError::AccessDenied(format!(
                    "The collection no longer provides {} version {}.",
                    pinned.id, pinned.version
                )));
            };
            if current != pinned {
                return Err(ConnectError::AccessDenied(format!(
                    "The approved provider set for {} version {} has changed.",
                    pinned.id, pinned.version
                )));
            }
            for implementation in &current.implementations {
                allowed_types.insert(implementation.type_name.to_lowercase());
            }
        }
        let resolved = ContractScope::new(scope.contracts.clone()).map_err(contract_scope_error)?;
        debug_assert_eq!(resolved.allowed_types, allowed_types);
        Ok(Some(resolved))
    }
}
