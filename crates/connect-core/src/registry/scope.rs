use super::*;

pub(super) fn parse_application_scope(encoded: &str) -> Result<GrantScope, ConnectError> {
    let scope = serde_json::from_str(encoded)?;
    validate_application_scope(&scope)?;
    Ok(scope)
}

pub(super) fn validate_grant_application_authorization(
    grant: &GrantPolicy,
) -> Result<(), ConnectError> {
    if grant.scope.access != mdbase_connect_protocol::ApplicationAccess::FullCollection
        || !grant.scope.contracts.is_empty()
    {
        return Err(invalid_grant_security(
            "application grants must use full_collection access with an empty contract set",
        ));
    }
    grant.validate_application_security().map_err(|error| {
        invalid_grant_security(format!(
            "grant does not match its application proof: {error}"
        ))
    })?;
    Ok(())
}

// Local upsert installs authority, even when an installation ID already exists.
// Snapshot restore and runtime proof validation deliberately do not call this gate.
pub(super) fn validate_fresh_grant_issuance(grant: &GrantPolicy) -> Result<(), ConnectError> {
    let version = grant
        .application_authorization
        .binding
        .contracts
        .semantic_capabilities;
    if !mdbase_connect_protocol::permits_fresh_application_authorization(version) {
        return Err(ConnectError::AccessDenied(format!(
            "Fresh application authorization issuance is unavailable for semantic capability version {version}."
        )));
    }
    Ok(())
}

pub(super) fn invalid_grant_security(message: impl Into<String>) -> ConnectError {
    ConnectError::InvalidInput(format!(
        "Invalid application authorization: {}",
        message.into()
    ))
}

pub(super) fn validate_application_scope(scope: &GrantScope) -> Result<(), ConnectError> {
    if scope.access != mdbase_connect_protocol::ApplicationAccess::FullCollection
        || !scope.contracts.is_empty()
    {
        return Err(ConnectError::AccessDenied(
            "The application grant is not a canonical full-collection grant.".to_string(),
        ));
    }
    Ok(())
}

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
            ) || (resource.kind == mdbase::runtime::CollectionSnapshotResourceKind::Lock
                && allowed_types.is_empty())
                || type_paths.contains(resource.path.as_str())
        })
        .map(|resource| SyncResourceDocument {
            path: resource.path.clone(),
            kind: match resource.kind {
                mdbase::runtime::CollectionSnapshotResourceKind::Configuration => {
                    "configuration".to_string()
                }
                mdbase::runtime::CollectionSnapshotResourceKind::Lock => "lock".to_string(),
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

pub(super) fn validate_scoped_mutation_request(
    operation: &str,
    input: &Value,
) -> Result<(), ConnectError> {
    let object = input.as_object().ok_or_else(|| {
        ConnectError::InvalidInput("The scoped mutation input must be an object.".to_string())
    })?;
    let allowed: &[&str] = match operation {
        "update" => &[
            "path",
            "patch",
            "if_revision",
            "include_document",
            "dry_run",
        ],
        "delete" => &["path", "check_backlinks", "if_revision", "dry_run"],
        "rename" => &[
            "from",
            "to",
            "update_refs",
            "if_revision",
            "include_document",
            "dry_run",
            "last_known_mtime",
        ],
        _ => return Ok(()),
    };
    if let Some(field) = object
        .keys()
        .find(|field| !allowed.contains(&field.as_str()))
    {
        return Err(ConnectError::InvalidInput(format!(
            "Scoped {operation} does not accept the '{field}' field."
        )));
    }
    let path_fields: &[&str] = if operation == "rename" {
        &["from", "to"]
    } else {
        &["path"]
    };
    for field in path_fields {
        let value = required_string(input, field)?;
        mdbase::api::CollectionPath::new(value).map_err(|error| {
            ConnectError::InvalidInput(format!("The scoped mutation {field} is invalid: {error}"))
        })?;
    }
    for field in [
        "include_document",
        "dry_run",
        "check_backlinks",
        "update_refs",
    ] {
        if object.get(field).is_some_and(|value| !value.is_boolean()) {
            return Err(ConnectError::InvalidInput(format!(
                "Scoped {operation} field '{field}' must be a boolean."
            )));
        }
    }
    if object
        .get("last_known_mtime")
        .is_some_and(|value| !value.is_u64())
    {
        return Err(ConnectError::InvalidInput(
            "Scoped rename field 'last_known_mtime' must be an unsigned integer.".to_string(),
        ));
    }
    if let Some(revision) = object.get("if_revision") {
        serde_json::from_value::<mdbase::api::Revision>(revision.clone()).map_err(|error| {
            ConnectError::InvalidInput(format!(
                "The scoped mutation if_revision is invalid: {error}"
            ))
        })?;
    }
    Ok(())
}

pub(super) fn authorize_scoped_mutation_preflight(
    collection: &Collection,
    operation: &str,
    input: &Value,
    scope: &ContractScope,
    selector: Option<&ContractSelector>,
    current: &mdbase::api::RecordDocument,
) -> Result<(), ConnectError> {
    let allowed_types = &scope.allowed_types;
    ensure_types_in_scope(&current.types, allowed_types)?;
    let current_types = current
        .types
        .iter()
        .map(|name| name.to_lowercase())
        .collect::<BTreeSet<_>>();
    match operation {
        "update" => {
            let path = required_string(input, "path")?;
            let mut prospective = current.frontmatter.as_object().cloned().unwrap_or_default();
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
            ensure_no_new_out_of_scope_types(&prospective_types, &current_types, allowed_types)
        }
        "delete" => authorize_typed_record(scope, current, selector),
        "rename" => {
            authorize_typed_record(scope, current, selector)?;
            let to = required_string(input, "to")?;
            let prospective_types =
                collection.determine_types_for_path(&current.frontmatter, Some(to));
            ensure_types_in_scope(&prospective_types, allowed_types)?;
            ensure_no_new_out_of_scope_types(&prospective_types, &current_types, allowed_types)
        }
        _ => Ok(()),
    }
}

fn authorize_typed_record(
    scope: &ContractScope,
    record: &mdbase::api::RecordDocument,
    selector: Option<&ContractSelector>,
) -> Result<(), ConnectError> {
    scope
        .authorize_record_result(
            &json!({"valid": true, "result": record, "diagnostics": []}),
            selector,
        )
        .map_err(contract_scope_error)
}

pub(super) fn ensure_operation_in_scope(
    operation: &mdbase::runtime::CanonicalOperationOutcome,
    allowed_types: &BTreeSet<String>,
) -> Result<(), ConnectError> {
    use mdbase::runtime::CanonicalOperationValue;

    if !operation.is_valid() {
        return Ok(());
    }
    match operation.value() {
        CanonicalOperationValue::Read(Some(record))
        | CanonicalOperationValue::Create(Some(record))
        | CanonicalOperationValue::Update(Some(record)) => {
            ensure_types_in_scope(&record.types, allowed_types)
        }
        CanonicalOperationValue::Query(Some(query)) => {
            for row in &query.records {
                let types = row
                    .get("types")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect::<Vec<_>>();
                ensure_types_in_scope(&types, allowed_types)?;
            }
            Ok(())
        }
        _ => Err(ConnectError::AccessDenied(
            "The connector could not verify the record's type scope.".to_string(),
        )),
    }
}

pub(super) fn operation_record(
    operation: &mdbase::runtime::CanonicalOperationOutcome,
) -> Option<&mdbase::api::RecordDocument> {
    use mdbase::runtime::CanonicalOperationValue;
    match operation.value() {
        CanonicalOperationValue::Read(Some(record))
        | CanonicalOperationValue::Create(Some(record))
        | CanonicalOperationValue::Update(Some(record)) => Some(record),
        _ => None,
    }
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
