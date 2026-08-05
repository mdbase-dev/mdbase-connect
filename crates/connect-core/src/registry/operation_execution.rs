use super::*;
pub(super) fn error_message(value: &Value, fallback: &str) -> String {
    value
        .pointer("/error/message")
        .or_else(|| value.pointer("/diagnostics/0/message"))
        .or_else(|| value.get("message"))
        .and_then(Value::as_str)
        .unwrap_or(fallback)
        .to_string()
}

pub(super) fn has_contract(
    available: &[CollectionContractDescriptor],
    required: &ContractRequirement,
) -> bool {
    available.iter().any(|contract| {
        contract.id == required.id
            && contract.version == required.version
            && contract.digest == required.digest
    })
}

pub(super) fn execute_loaded(
    collection: &Collection,
    current_version: &str,
    operation: &str,
    input: &Value,
) -> Result<Value, ConnectError> {
    if collection.spec_profile() == SpecProfile::V03 {
        if operation == "assess_collection_setup" || operation == "apply_collection_setup" {
            let result = if operation == "assess_collection_setup" {
                let request = serde_json::from_value::<AssessCollectionSetupInput>(input.clone())
                    .map_err(|error| {
                    ConnectError::InvalidInput(format!(
                        "The collection setup assessment is invalid: {error}"
                    ))
                })?;
                collection.assess_collection_setup(&engine_collection_setup(&request)?)
            } else {
                let request = serde_json::from_value::<ApplyCollectionSetupInput>(input.clone())
                    .map_err(|error| {
                        ConnectError::InvalidInput(format!(
                            "The collection setup apply request is invalid: {error}"
                        ))
                    })?;
                collection.apply_collection_setup(
                    &engine_collection_setup(&request.setup)?,
                    &mdbase::v03::CollectionSetupApplyOptions {
                        expected_assessment_digest: request.expected_assessment_digest,
                        expected_collection_revision: request.expected_collection_revision,
                        expected_provision_digest: request.expected_provision_digest,
                        allow_type_pack_downgrades: request.allow_type_pack_downgrades,
                    },
                )
            };
            return serde_json::to_value(result).map_err(ConnectError::from);
        }
        if operation == "assess_type_pack" || operation == "apply_type_pack" {
            let (
                provision,
                installed_by,
                provision_adoptions,
                preserve_seed_targets,
                target_overrides,
                contract_setups,
                expected,
                allow_downgrade,
            ) = if operation == "assess_type_pack" {
                let request = serde_json::from_value::<AssessTypePackInput>(input.clone())
                    .map_err(|error| {
                        ConnectError::InvalidInput(format!(
                            "The type-pack assessment is invalid: {error}"
                        ))
                    })?;
                (
                    request.provision,
                    request.installed_by,
                    request.adopt_resources,
                    request.preserve_seed_targets,
                    request.target_overrides,
                    request.contract_setups,
                    None,
                    false,
                )
            } else {
                let request = serde_json::from_value::<ApplyTypePackInput>(input.clone()).map_err(
                    |error| {
                        ConnectError::InvalidInput(format!(
                            "The type-pack apply request is invalid: {error}"
                        ))
                    },
                )?;
                (
                    request.provision,
                    request.installed_by,
                    request.adopt_resources,
                    request.preserve_seed_targets,
                    request.target_overrides,
                    request.contract_setups,
                    Some(request.expected_assessment_digest),
                    request.allow_downgrade,
                )
            };
            let contract_setups = contract_setups
                .iter()
                .map(CollectionRegistry::engine_contract_setup)
                .collect::<Vec<_>>();
            let engine_provision = mdbase::v03::TypePackProvision {
                manifest: serde_json::to_value(&provision.manifest)?,
                resources: provision
                    .resources
                    .iter()
                    .map(|resource| mdbase::v03::TypePackResource {
                        source: resource.source.clone(),
                        document: resource.document.clone(),
                    })
                    .collect::<Vec<_>>(),
            };
            let result = match expected {
                Some(expected) => collection.apply_type_pack(
                    &engine_provision,
                    &mdbase::v03::TypePackApplyOptions {
                        installed_by,
                        expected_assessment_digest: expected,
                        allow_downgrade,
                        adopt_resources: provision_adoptions,
                        preserve_seed_targets,
                        target_overrides,
                        contract_setups,
                    },
                ),
                None => collection.assess_type_pack(
                    &engine_provision,
                    &mdbase::v03::TypePackAssessmentOptions {
                        installed_by,
                        adopt_resources: provision_adoptions,
                        preserve_seed_targets,
                        target_overrides,
                        contract_setups,
                    },
                ),
            };
            return serde_json::to_value(result).map_err(ConnectError::from);
        }
        let operations = collection
            .v03_operations()
            .map_err(|diagnostic| ConnectError::invalid_collection(vec![*diagnostic]))?;
        let result = match operation {
            "read" => operations.read(input),
            "query" => operations.query(input),
            "list_views" => operations.list_views(input),
            "execute_view" => operations.execute_view(input),
            "read_view_source" => operations.read_view_source(input),
            "create_view_source" => operations.create_view_source(input),
            "update_view_source" => operations.update_view_source(input),
            "delete_view_source" => operations.delete_view_source(input),
            "validate" => operations.validate(input),
            "batch" => operations.batch(input),
            "create" => operations.create(input),
            "update" => operations.update(input),
            "delete" => operations.delete(input),
            "rename" => operations.rename(input),
            "list_types" => operations.list_types(input),
            "read_type" => operations.read_type(input),
            "create_type" => operations.create_type(input),
            "update_type" => operations.update_type(input),
            other => return Err(ConnectError::UnsupportedOperation(other.to_string())),
        };
        return serde_json::to_value(result).map_err(ConnectError::from);
    }

    let result = match operation {
        "read" => {
            let request = serde_json::from_value::<mdbase::api::ReadRequest>(input.clone())
                .map_err(|error| mdbase::api::MdbaseError::InvalidRequest {
                    message: error.to_string(),
                });
            typed_result(collection, request, |typed, request| typed.read(request))
        }
        "query" => {
            let request = parse_v02_query(input);
            typed_result(collection, request, |typed, request| typed.query(request))
        }
        "validate" => collection.validate_op(input),
        "create" | "update" | "delete" | "rename" => {
            migration_required_result(operation, current_version)
        }
        other => return Err(ConnectError::UnsupportedOperation(other.to_string())),
    };
    Ok(result)
}

fn engine_collection_setup(
    input: &AssessCollectionSetupInput,
) -> Result<mdbase::v03::CollectionSetup, ConnectError> {
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
                    .collect()
            } else {
                Default::default()
            };
            Ok(mdbase::v03::CollectionSetupTypePack {
                provision: CollectionRegistry::engine_type_pack_provision(provision)?,
                options: mdbase::v03::CollectionSetupTypePackOptions {
                    preserve_seed_targets,
                    contract_setups: provision_setups
                        .into_iter()
                        .filter(|setup| {
                            matches!(setup.mode, ContractSetupMode::Existing { .. })
                        })
                        .map(CollectionRegistry::engine_contract_setup)
                        .collect(),
                    ..Default::default()
                },
            })
        })
        .collect::<Result<Vec<_>, ConnectError>>()?;
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

pub(super) fn typed_result<Request, Output>(
    collection: &Collection,
    request: Result<Request, mdbase::api::MdbaseError>,
    execute: impl FnOnce(
        mdbase::api::TypedCollection<'_>,
        Request,
    ) -> mdbase::api::MdbaseResult<mdbase::api::OperationOutcome<Output>>,
) -> Value
where
    Output: serde::Serialize,
{
    let result =
        request.and_then(|request| collection.typed().and_then(|typed| execute(typed, request)));
    match result {
        Ok(outcome) => json!({
            "valid": true,
            "result": outcome.value,
            "diagnostics": outcome.diagnostics,
        }),
        Err(error) => typed_error_result(error),
    }
}

pub(super) fn typed_error_result(error: mdbase::api::MdbaseError) -> Value {
    use mdbase::api::MdbaseError;

    let (code, message, diagnostics) = match error {
        MdbaseError::InvalidPath(error) => ("invalid_path", error.to_string(), Vec::<Value>::new()),
        MdbaseError::UnsupportedProfile => (
            "migration_required",
            "This operation requires migrating the collection to v0.3.".to_string(),
            Vec::new(),
        ),
        MdbaseError::MigrationRequired { operation } => (
            "migration_required",
            format!("Operation '{operation}' requires migrating this v0.2 collection to v0.3."),
            Vec::new(),
        ),
        MdbaseError::LossyMigration { diagnostics } => (
            "migration_lossy",
            "The v0.2 migration requires explicit approval for lossy translations.".to_string(),
            diagnostics
                .into_iter()
                .map(|diagnostic| json!(diagnostic))
                .collect(),
        ),
        MdbaseError::InvalidRequest { message } => ("invalid_request", message, Vec::new()),
        MdbaseError::Operation { diagnostics } => (
            "operation_failed",
            "The mdbase operation failed.".to_string(),
            diagnostics
                .into_iter()
                .map(|diagnostic| json!(diagnostic))
                .collect(),
        ),
        MdbaseError::InvalidResult { message } => ("invalid_result", message, Vec::new()),
    };
    let diagnostics = if diagnostics.is_empty() {
        let mut diagnostic = json!({
            "severity": "error",
            "code": code,
            "message": message,
        });
        if code == "migration_required" || code == "migration_lossy" {
            diagnostic["details"] =
                json!({ "current_version": "0.2.x", "required_version": "0.3.0" });
        }
        vec![diagnostic]
    } else {
        diagnostics
    };
    json!({
        "valid": false,
        "result": {},
        "diagnostics": diagnostics,
    })
}

pub(super) fn migration_required_result(operation: &str, current_version: &str) -> Value {
    json!({
        "valid": false,
        "result": {},
        "diagnostics": [{
            "severity": "error",
            "code": "migration_required",
            "message": format!(
                "Operation '{operation}' requires migrating this v0.2 collection to v0.3."
            ),
            "details": {
                "current_version": current_version,
                "required_version": "0.3.0"
            }
        }],
    })
}

pub(super) fn parse_v02_query(
    input: &Value,
) -> mdbase::api::MdbaseResult<mdbase::api::QueryRequest> {
    use mdbase::api::MdbaseError;

    let input = input.get("query").unwrap_or(input);
    let source = input
        .as_object()
        .ok_or_else(|| MdbaseError::InvalidRequest {
            message: "query input must be an object".to_string(),
        })?;
    const SUPPORTED: &[&str] = &[
        "types",
        "context",
        "projections",
        "where",
        "select",
        "order_by",
        "group_by",
        "groupBy",
        "limit",
        "offset",
        "snapshot",
        "include_body",
        "frontmatter",
    ];
    if let Some(field) = source
        .keys()
        .find(|field| !SUPPORTED.contains(&field.as_str()))
    {
        return Err(MdbaseError::InvalidRequest {
            message: format!("v0.2 compatibility queries do not support the '{field}' constraint"),
        });
    }

    let mut typed = source.clone();
    if let Some(context) = typed.get("context").cloned() {
        let path = context
            .as_str()
            .or_else(|| context.pointer("/this/path").and_then(Value::as_str))
            .ok_or_else(|| MdbaseError::InvalidRequest {
                message: "query context must identify this.path".to_string(),
            })?;
        typed.insert("context".to_string(), Value::String(path.to_string()));
    }
    if let Some(projections) = typed.get("projections").and_then(Value::as_object) {
        let projections = projections
            .iter()
            .map(|(name, value)| {
                value
                    .as_str()
                    .or_else(|| value.get("expr").and_then(Value::as_str))
                    .map(|expression| (name.clone(), Value::String(expression.to_string())))
                    .ok_or_else(|| MdbaseError::InvalidRequest {
                        message: format!("query projection '{name}' must contain an expression"),
                    })
            })
            .collect::<Result<serde_json::Map<_, _>, _>>()?;
        typed.insert("projections".to_string(), Value::Object(projections));
    }
    if !typed.contains_key("group_by") {
        if let Some(group_by) = typed.remove("groupBy") {
            typed.insert("group_by".to_string(), group_by);
        }
    } else {
        typed.remove("groupBy");
    }

    serde_json::from_value(Value::Object(typed)).map_err(|error| MdbaseError::InvalidRequest {
        message: error.to_string(),
    })
}

pub(super) fn operation_invalidation(
    operation: &str,
    input: &Value,
    output: &Value,
) -> CollectionInvalidation {
    if input.get("dry_run").and_then(Value::as_bool) == Some(true)
        || !(operation == "batch" || is_mutating_operation(operation, input))
        || output.get("valid").and_then(Value::as_bool) == Some(false)
        || output.get("error").is_some()
    {
        return CollectionInvalidation::None;
    }
    if matches!(
        operation,
        "create_type"
            | "update_type"
            | "apply_type_pack"
            | "apply_collection_setup"
            | "create_view_source"
            | "update_view_source"
            | "delete_view_source"
    ) {
        return CollectionInvalidation::All;
    }

    let Ok(kind) = operation.parse::<mdbase::runtime::OperationKind>() else {
        return CollectionInvalidation::All;
    };
    let Ok(result) = serde_json::from_value::<mdbase::v03::OperationResult>(output.clone()) else {
        // Legacy profiles do not expose the portable operation envelope. The
        // operation is still valid, but a full reload is the only safe hint.
        return CollectionInvalidation::All;
    };
    let paths = mdbase::runtime::OperationRequest::new(kind, input.clone()).affected_paths(&result);
    if paths.is_empty() {
        CollectionInvalidation::All
    } else {
        CollectionInvalidation::Records(paths)
    }
}

pub(super) fn supported_operations(profile: SpecProfile) -> &'static [&'static str] {
    if profile != SpecProfile::V03 {
        return &[
            "describe",
            "changes",
            "read",
            "query",
            "validate",
            "list_timers",
            "put_timer",
            "cancel_timer",
            "reconcile_timers",
            "sync",
        ];
    }
    &[
        "describe",
        "changes",
        "read",
        "query",
        "list_views",
        "execute_view",
        "read_view_source",
        "create_view_source",
        "update_view_source",
        "delete_view_source",
        "validate",
        "create",
        "update",
        "delete",
        "rename",
        "read_type",
        "create_type",
        "update_type",
        "assess_type_pack",
        "apply_type_pack",
        "assess_collection_setup",
        "apply_collection_setup",
        "list_timers",
        "put_timer",
        "cancel_timer",
        "reconcile_timers",
        "sync",
    ]
}
