use super::*;
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
        self.operation_synchronized(id, operation, input, |_| {})
    }

    pub fn operation_synchronized(
        &self,
        id: Uuid,
        operation: &str,
        input: &Value,
        synchronize: impl FnOnce(&CollectionInvalidation),
    ) -> Result<Value, ConnectError> {
        let registered = self.get(id)?;
        assert_local_authority_folder(Path::new(&registered.path))?;
        if operation == "changes" {
            return serde_json::to_value(self.changes(id, input)?).map_err(ConnectError::from);
        }
        let provider = self.provider_for(&registered)?;
        let sync_store = crate::LocalSyncStore::for_registry(self);
        let execute = |collection: &Collection| {
            sync_store.assert_authority_available(id)?;
            if operation == "describe" {
                return serde_json::to_value(self.describe_loaded(&registered, collection)?)
                    .map_err(ConnectError::from);
            }
            execute_loaded(collection, operation, input)
        };
        if is_collection_mutation(operation) {
            provider.with_collection(|collection| {
                sync_store.assert_mutation_allowed(id)?;
                let result = execute(collection)?;
                let invalidation = operation_invalidation(operation, input, &result);
                synchronize(&invalidation);
                Ok(result)
            })
        } else {
            provider.with_collection_read(execute)
        }
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
                available.id == required.id && available.version == required.version
            })
        }))
    }

    pub fn provision_type_packs(
        &self,
        id: Uuid,
        requirements: &ApplicationRequirements,
        provisions: &[TypePackProvision],
        contract_setups: &[ContractSetupChoice],
    ) -> Result<Vec<CollectionContractDescriptor>, ConnectError> {
        let description = self.describe(id)?;
        let missing = requirements
            .contracts
            .iter()
            .filter(|required| !has_contract(&description.contracts, required))
            .cloned()
            .collect::<Vec<_>>();
        if missing.iter().any(|required| {
            !provisions
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
        if !effective_setups.is_empty() {
            let relevant = effective_setups
                .iter()
                .map(|setup| (setup.contract.id.as_str(), setup.contract.version.as_str()))
                .collect::<BTreeSet<_>>();
            let packs = provisions
                .iter()
                .filter(|provision| {
                    provision.provides.iter().any(|provided| {
                        relevant.contains(&(provided.id.as_str(), provided.version.as_str()))
                    })
                })
                .map(Self::engine_type_pack)
                .collect::<Result<Vec<_>, _>>()?;
            let setups = effective_setups
                .iter()
                .map(Self::engine_contract_setup)
                .collect::<Vec<_>>();
            let registered = self.get(id)?;
            let provider = self.provider_for(&registered)?;
            let result = provider.with_collection(|collection| {
                Ok::<_, ConnectError>(
                    collection.install_type_packs_with_contract_setups(&packs, &setups),
                )
            })?;
            if !result.valid {
                return Err(ConnectError::AccessDenied(
                    result
                        .diagnostics
                        .first()
                        .map(|diagnostic| diagnostic.message.clone())
                        .unwrap_or_else(|| "Contract setup was rejected.".to_string()),
                ));
            }
        }

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
        Ok(description.contracts)
    }

    fn engine_type_pack(
        provision: &TypePackProvision,
    ) -> Result<mdbase::v03::TypePackInstall, ConnectError> {
        Ok(mdbase::v03::TypePackInstall {
            manifest: serde_json::to_value(&provision.manifest)?,
            resources: provision
                .resources
                .iter()
                .map(|resource| mdbase::v03::TypePackResource {
                    source: resource.source.clone(),
                    document: resource.document.clone(),
                })
                .collect(),
            provides: provision
                .provides
                .iter()
                .map(|contract| mdbase::v03::ContractIdentity {
                    id: contract.id.clone(),
                    version: contract.version.clone(),
                })
                .collect(),
        })
    }

    fn engine_contract_setup(setup: &ContractSetupChoice) -> mdbase::v03::ContractSetupChoice {
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
        self.scoped_operation_synchronized(id, operation, input, scope, |_| {})
    }

    pub fn scoped_operation_synchronized(
        &self,
        id: Uuid,
        operation: &str,
        input: &Value,
        scope: &GrantScope,
        synchronize: impl FnOnce(&CollectionInvalidation),
    ) -> Result<Value, ConnectError> {
        let registered = self.get(id)?;
        if !registered.enabled {
            return Err(ConnectError::AccessDenied(
                "This collection is disabled on its computer.".to_string(),
            ));
        }
        let provider = self.provider_for(&registered)?;
        let sync_store = crate::LocalSyncStore::for_registry(self);
        let execute = |collection: &Collection| {
            sync_store.assert_authority_available(id)?;
            self.scoped_operation_loaded(&registered, collection, operation, input, scope)
        };
        if is_collection_mutation(operation) {
            provider.with_collection(|collection| {
                sync_store.assert_mutation_allowed(id)?;
                let result = execute(collection)?;
                let invalidation = operation_invalidation(operation, input, &result);
                synchronize(&invalidation);
                Ok(result)
            })
        } else {
            provider.with_collection_read(execute)
        }
    }

    pub fn sync_operation_synchronized(
        &self,
        id: Uuid,
        input: &Value,
        mut replica: crate::LocalReplica,
        scope: &GrantScope,
        synchronize: impl FnOnce(&CollectionInvalidation),
    ) -> Result<Value, ConnectError> {
        if scope.access == mdbase_connect_protocol::ApplicationAccess::Contract {
            return Err(ConnectError::AccessDenied(
                "Contract-scoped replicas are not available because the sync document format contains whole records. Use projected read/query/create/update operations, or request explicit full-collection access."
                    .to_string(),
            ));
        }
        let registered = self.get(id)?;
        if !registered.enabled {
            return Err(ConnectError::AccessDenied(
                "This collection is disabled on its computer.".to_string(),
            ));
        }
        let action = input.get("action").and_then(Value::as_str).ok_or_else(|| {
            ConnectError::AccessDenied("Sync request action is required.".to_string())
        })?;
        let provider = self.provider_for(&registered)?;
        let store = crate::LocalSyncStore::for_registry(self);
        let execute = |collection: &Collection| -> Result<Value, ConnectError> {
            store.assert_authority_available(id)?;
            replica.allowed_types = self
                .resolve_scope_types_loaded(&registered, collection, scope)?
                .unwrap_or_default();
            let snapshot = collection.snapshot()?;
            store.reconcile(id, &snapshot, &HashMap::new())?;
            match action {
                "open_session" => {
                    let description = self.describe_loaded(&registered, collection)?;
                    let resources = sync_resources(&snapshot, description, &replica.allowed_types);
                    serde_json::to_value(store.open_session(id, &replica, resources, &snapshot)?)
                        .map_err(Into::into)
                }
                "snapshot" => {
                    store.ensure_replica(id, &replica)?;
                    let snapshot_id = required_uuid(input, "snapshot_id")?;
                    let page = input.get("page").and_then(Value::as_str);
                    serde_json::to_value(store.snapshot(id, replica.id, snapshot_id, page)?)
                        .map_err(Into::into)
                }
                "changes" => {
                    store.ensure_replica(id, &replica)?;
                    let after = input.get("after").and_then(Value::as_u64).ok_or_else(|| {
                        ConnectError::AccessDenied("Sync changes cursor is required.".to_string())
                    })?;
                    let limit = input
                        .get("limit")
                        .and_then(Value::as_u64)
                        .unwrap_or(200)
                        .clamp(1, 500) as usize;
                    serde_json::to_value(store.changes(id, replica.id, after, limit)?)
                        .map_err(Into::into)
                }
                "mutate" => {
                    store.assert_mutation_allowed(id)?;
                    store.ensure_replica(id, &replica)?;
                    let mutation: SyncMutation = serde_json::from_value(
                        input.get("mutation").cloned().ok_or_else(|| {
                            ConnectError::AccessDenied(
                                "Sync mutation body is required.".to_string(),
                            )
                        })?,
                    )?;
                    let plan = store.plan_mutation(id, replica.id, &mutation)?;
                    let crate::local_sync::MutationPlan::Apply {
                        operation,
                        input: operation_input,
                        preferred_path,
                    } = plan
                    else {
                        let crate::local_sync::MutationPlan::Return(receipt) = plan else {
                            unreachable!()
                        };
                        store.store_receipt(replica.id, &receipt)?;
                        return serde_json::to_value(receipt).map_err(Into::into);
                    };
                    let result = self.scoped_operation_loaded(
                        &registered,
                        collection,
                        operation,
                        &operation_input,
                        scope,
                    )?;
                    if result.get("valid").and_then(Value::as_bool) != Some(true) {
                        let receipt = SyncMutationReceipt::Rejected {
                            mutation_id: mutation.mutation_id,
                            error: mdbase_connect_protocol::SyncMutationError {
                                code: result
                                    .pointer("/diagnostics/0/code")
                                    .and_then(Value::as_str)
                                    .unwrap_or("mutation_rejected")
                                    .to_string(),
                                message: error_message(&result, "The mutation was rejected."),
                            },
                        };
                        store.store_receipt(replica.id, &receipt)?;
                        return serde_json::to_value(receipt).map_err(Into::into);
                    }
                    let invalidation = operation_invalidation(operation, &operation_input, &result);
                    synchronize(&invalidation);
                    let after = collection.snapshot()?;
                    let preferred = preferred_path
                        .map(|path| HashMap::from([(path, mutation.record_id)]))
                        .unwrap_or_default();
                    store.reconcile(id, &after, &preferred)?;
                    let receipt = store.applied_receipt(id, &mutation)?;
                    store.store_receipt(replica.id, &receipt)?;
                    serde_json::to_value(receipt).map_err(Into::into)
                }
                other => Err(ConnectError::AccessDenied(format!(
                    "Unsupported sync action: {other}"
                ))),
            }
        };
        if action == "mutate" {
            provider.with_collection(execute)
        } else {
            provider.with_collection_read(execute)
        }
    }

    fn scoped_operation_loaded(
        &self,
        registered: &CollectionSummary,
        collection: &Collection,
        operation: &str,
        input: &Value,
        scope: &GrantScope,
    ) -> Result<Value, ConnectError> {
        let Some(resolved_scope) =
            self.resolve_contract_scope_loaded(registered, collection, scope)?
        else {
            return match operation {
                "describe" => serde_json::to_value(self.describe_loaded(registered, collection)?)
                    .map_err(ConnectError::from),
                "changes" => serde_json::to_value(self.changes(registered.id, input)?)
                    .map_err(ConnectError::from),
                _ => execute_loaded(collection, operation, input),
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
                        pinned.id == contract.id && pinned.version == contract.version
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
                let result = execute_loaded(collection, operation, &input)?;
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
                let result = execute_loaded(collection, operation, &input)?;
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
                let result = execute_loaded(collection, operation, &input)?;
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
                let current = execute_loaded(collection, "read", &json!({ "path": path }))?;
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
                let result = execute_loaded(collection, operation, &input)?;
                resolved_scope
                    .project_result(collection, result, Some(&selector))
                    .map_err(contract_scope_error)
            }
            "delete" => {
                let (scoped_input, selector) = resolved_scope
                    .identity_input(input)
                    .map_err(contract_scope_error)?;
                let path = required_string(&scoped_input, "path")?;
                let current = execute_loaded(collection, "read", &json!({ "path": path }))?;
                ensure_result_in_scope(&current, allowed_types)?;
                resolved_scope
                    .authorize_record_result(collection, &current, selector.as_ref())
                    .map_err(contract_scope_error)?;
                let mut scoped_input = scoped_input;
                if let Some(object) = scoped_input.as_object_mut() {
                    object.insert("check_backlinks".to_string(), Value::Bool(false));
                }
                execute_loaded(collection, operation, &scoped_input)
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
                let current = execute_loaded(collection, "read", &json!({ "path": from }))?;
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
                let result = execute_loaded(collection, operation, &scoped_input)?;
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
            | "install_type_pack" => Err(
                ConnectError::AccessDenied(
                    "Collection schemas can only be managed by an application with full collection access."
                        .to_string(),
                ),
            ),
            other => Err(ConnectError::UnsupportedOperation(other.to_string())),
        }
    }

    pub(super) fn provider_for(
        &self,
        registered: &CollectionSummary,
    ) -> Result<Arc<FilesystemProvider>, ConnectError> {
        assert_local_authority_folder(Path::new(&registered.path))?;
        let mut providers = self
            .providers
            .lock()
            .map_err(|_| ConnectError::CollectionOpen("provider registry lock poisoned".into()))?;
        if let Some(provider) = providers.get(&registered.id) {
            return Ok(provider.clone());
        }
        let provider = Arc::new(FilesystemProvider::open(Path::new(&registered.path))?);
        providers.insert(registered.id, provider.clone());
        Ok(provider)
    }

    fn resolve_scope_types_loaded(
        &self,
        registered: &CollectionSummary,
        collection: &Collection,
        scope: &GrantScope,
    ) -> Result<Option<BTreeSet<String>>, ConnectError> {
        Ok(self
            .resolve_contract_scope_loaded(registered, collection, scope)?
            .map(|scope| scope.allowed_types))
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
            let Some(current) = description
                .contracts
                .iter()
                .find(|contract| contract.id == pinned.id && contract.version == pinned.version)
            else {
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
