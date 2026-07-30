use super::*;
pub(super) fn required_string<'a>(input: &'a Value, key: &str) -> Result<&'a str, ConnectError> {
    input.get(key).and_then(Value::as_str).ok_or_else(|| {
        ConnectError::AccessDenied(format!("Scoped operation requires a valid '{key}' value."))
    })
}

pub(super) fn required_uuid(input: &Value, key: &str) -> Result<Uuid, ConnectError> {
    let value = required_string(input, key)?;
    Uuid::parse_str(value)
        .map_err(|_| ConnectError::AccessDenied(format!("Sync request '{key}' must be a UUID.")))
}

pub(super) fn sync_resources(
    snapshot: &mdbase::runtime::CollectionSnapshot,
    mut description: CollectionDescription,
    allowed_types: &BTreeSet<String>,
) -> SyncCollectionResources {
    if !allowed_types.is_empty() {
        description
            .types
            .retain(|type_definition| allowed_types.contains(&type_definition.name));
        for contract in &mut description.contracts {
            contract
                .implementations
                .retain(|implementation| allowed_types.contains(&implementation.type_name));
        }
        description
            .contracts
            .retain(|contract| !contract.implementations.is_empty());
    }
    let type_paths = description
        .types
        .iter()
        .filter_map(|type_definition| type_definition.path.as_deref())
        .collect::<BTreeSet<_>>();
    let documents = snapshot
        .resources
        .iter()
        .filter(|resource| {
            matches!(
                resource.kind,
                mdbase::runtime::CollectionSnapshotResourceKind::Configuration
                    | mdbase::runtime::CollectionSnapshotResourceKind::Contract
                    | mdbase::runtime::CollectionSnapshotResourceKind::Schema
                    | mdbase::runtime::CollectionSnapshotResourceKind::View
            ) || type_paths.contains(resource.path.as_str())
        })
        .map(|resource| SyncResourceDocument {
            path: resource.path.clone(),
            kind: match resource.kind {
                mdbase::runtime::CollectionSnapshotResourceKind::Configuration => {
                    "configuration".to_string()
                }
                mdbase::runtime::CollectionSnapshotResourceKind::Contract => "contract".to_string(),
                mdbase::runtime::CollectionSnapshotResourceKind::Schema => "schema".to_string(),
                mdbase::runtime::CollectionSnapshotResourceKind::Type => "type".to_string(),
                mdbase::runtime::CollectionSnapshotResourceKind::View => "view".to_string(),
            },
            revision: resource.revision.clone(),
            document: resource.document.clone(),
        })
        .collect::<Vec<_>>();
    SyncCollectionResources {
        revision: snapshot.resource_revision.clone(),
        spec_version: snapshot.spec_version.clone(),
        types: description.types,
        contracts: description.contracts,
        documents,
    }
}

pub(super) fn contract_scope_error(error: ContractScopeError) -> ConnectError {
    ConnectError::AccessDenied(error.0)
}

pub(super) fn ensure_result_in_scope(
    result: &Value,
    allowed_types: &BTreeSet<String>,
) -> Result<(), ConnectError> {
    let types = result.pointer("/result/types").and_then(Value::as_array);
    let Some(types) = types else {
        if result.get("valid").and_then(Value::as_bool) == Some(false)
            && result.pointer("/result/frontmatter").is_none()
        {
            return Ok(());
        }
        return Err(ConnectError::AccessDenied(
            "The connector could not verify the record's type scope.".to_string(),
        ));
    };
    let types = types
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect::<Vec<_>>();
    ensure_types_in_scope(&types, allowed_types)
}

pub(super) fn ensure_types_in_scope(
    types: &[String],
    allowed_types: &BTreeSet<String>,
) -> Result<(), ConnectError> {
    if types
        .iter()
        .any(|type_name| allowed_types.contains(&type_name.to_lowercase()))
    {
        return Ok(());
    }
    Err(ConnectError::AccessDenied(
        "The requested record is outside this application's record scope.".to_string(),
    ))
}

pub(super) fn result_types(result: &Value) -> BTreeSet<String> {
    result
        .pointer("/result/types")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_lowercase)
        .collect()
}

pub(super) fn ensure_no_new_out_of_scope_types(
    prospective_types: &[String],
    current_types: &BTreeSet<String>,
    allowed_types: &BTreeSet<String>,
) -> Result<(), ConnectError> {
    let introduces_out_of_scope_type = prospective_types.iter().any(|type_name| {
        let type_name = type_name.to_lowercase();
        !allowed_types.contains(&type_name) && !current_types.contains(&type_name)
    });
    if introduces_out_of_scope_type {
        return Err(ConnectError::AccessDenied(
            "The write would add the record to a type outside this application's scope."
                .to_string(),
        ));
    }
    Ok(())
}

pub(super) fn change_is_in_scope(
    event: &CollectionChange,
    allowed_types: &BTreeSet<String>,
    collection: Option<&Collection>,
) -> bool {
    if event.event_type == "mdbase.config.changed" {
        return true;
    }
    if event.event_type == "mdbase.type.changed" {
        return event
            .payload
            .get("path")
            .and_then(Value::as_str)
            .and_then(|path| Path::new(path).file_stem())
            .and_then(|name| name.to_str())
            .is_some_and(|name| allowed_types.contains(&name.to_lowercase()));
    }
    let types = ["types", "previous_types"]
        .into_iter()
        .filter_map(|key| event.payload.get(key).and_then(Value::as_array))
        .flatten()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>();
    if !types.is_empty() {
        return types
            .iter()
            .any(|type_name| allowed_types.contains(&type_name.to_lowercase()));
    }
    let current_path = match event.event_type.as_str() {
        "mdbase.record.created" | "mdbase.record.modified" => {
            event.payload.get("path").and_then(Value::as_str)
        }
        "mdbase.record.renamed" => event.payload.get("to").and_then(Value::as_str),
        _ => None,
    };
    let (Some(collection), Some(path)) = (collection, current_path) else {
        return false;
    };
    collection
        .read(&json!({ "path": path }))
        .get("types")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .any(|type_name| allowed_types.contains(&type_name.to_lowercase()))
}
