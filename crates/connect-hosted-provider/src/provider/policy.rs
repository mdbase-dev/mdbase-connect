use super::*;
pub(super) fn ensure_canonical_application_replica(replica: &Replica) -> ApiResult<()> {
    if replica.purpose == ReplicaPurpose::Application
        && (!replica.full_collection
            || !replica.allowed_types.is_empty()
            || !replica.contract_scope.is_empty())
    {
        return Err(ApiError::forbidden(
            "application_reauthorization_required",
            "This legacy scoped application capability must be revoked and reauthorized.",
        ));
    }
    Ok(())
}

pub(super) fn authorize_application_operation(
    replica: &Replica,
    operation: &str,
    request_origin: Option<&str>,
) -> ApiResult<()> {
    ensure_canonical_application_replica(replica)?;
    if operation == "batch" {
        return Err(ApiError::bad_request(
            "unsupported_operation",
            "Hosted batch operations are owner-only and cannot be executed through an application grant.",
        ));
    }
    if !replica
        .allowed_operations
        .iter()
        .any(|allowed| allowed == operation)
    {
        return Err(insufficient_access(
            "The application is not allowed to perform this operation.",
            [operation.to_owned()],
            replica.allowed_operations.clone(),
        ));
    }
    authorize_application_origin(replica, request_origin)
}

pub(super) fn authorize_application_origin(
    replica: &Replica,
    request_origin: Option<&str>,
) -> ApiResult<()> {
    if replica.allowed_origin.as_deref() != request_origin {
        return Err(ApiError::forbidden(
            "origin_denied",
            "The application origin does not match this capability.",
        ));
    }
    Ok(())
}

pub(super) fn authorize_sync_access(
    replica: &Replica,
    required_operation: &str,
    request_origin: Option<&str>,
) -> ApiResult<()> {
    ensure_canonical_application_replica(replica)?;
    match replica.purpose {
        ReplicaPurpose::Application => {
            authorize_application_operation(replica, required_operation, request_origin)
        }
        ReplicaPurpose::Mirror if request_origin.is_none() => Ok(()),
        ReplicaPurpose::Mirror => Err(ApiError::forbidden(
            "origin_denied",
            "Mirror credentials cannot be used by browser applications.",
        )),
    }
}

pub(super) fn authorize_file_access(
    replica: &Replica,
    action: FileAction,
    path: Option<&str>,
    request_origin: Option<&str>,
) -> ApiResult<()> {
    match replica.purpose {
        ReplicaPurpose::Mirror => {
            if request_origin.is_some() {
                return Err(ApiError::forbidden(
                    "origin_denied",
                    "Mirror credentials cannot be used by browser applications.",
                ));
            }
            if replica.mode == SyncReplicaMode::ReadOnly
                && matches!(
                    action,
                    FileAction::Add | FileAction::Replace | FileAction::Move | FileAction::Delete
                )
            {
                return Err(insufficient_access(
                    "This mirror is read-only.",
                    [file_action_name(action).to_owned()],
                    ["list".to_owned(), "read".to_owned()],
                ));
            }
            Ok(())
        }
        ReplicaPurpose::Application => {
            ensure_canonical_application_replica(replica)?;
            authorize_application_origin(replica, request_origin)?;
            let capability = replica.file_capability.as_ref().ok_or_else(|| {
                insufficient_access(
                    "This application has no collection file access.",
                    [file_action_name(action).to_owned()],
                    [],
                )
            })?;
            if !capability.actions.contains(&action) {
                return Err(insufficient_access(
                    "This application is not allowed to perform that file action.",
                    [file_action_name(action).to_owned()],
                    capability
                        .actions
                        .iter()
                        .map(|allowed| file_action_name(*allowed).to_owned()),
                ));
            }
            match (&capability.scope, path) {
                (FileScope::Collection, _) | (_, None) => Ok(()),
                (FileScope::SelectedFolders { folders }, Some(path))
                    if folders
                        .iter()
                        .any(|folder| file_path_below_folder(path, folder)) =>
                {
                    Ok(())
                }
                _ => Err(ApiError::forbidden(
                    "scope_denied",
                    "The file is outside this application's approved folders.",
                )),
            }
        }
    }
}

fn insufficient_access(
    message: impl Into<String>,
    required: impl IntoIterator<Item = String>,
    granted: impl IntoIterator<Item = String>,
) -> ApiError {
    let required_operations = required.into_iter().collect::<Vec<_>>();
    let granted_operations = granted.into_iter().collect::<Vec<_>>();
    let missing_operations = required_operations
        .iter()
        .filter(|operation| !granted_operations.contains(operation))
        .cloned()
        .collect::<Vec<_>>();
    ApiError::forbidden("insufficient_access", message).with_details(serde_json::json!({
        "required_operations": required_operations,
        "granted_operations": granted_operations,
        "missing_operations": missing_operations,
    }))
}

fn file_action_name(action: FileAction) -> &'static str {
    match action {
        FileAction::List => "list",
        FileAction::Read => "read",
        FileAction::Add => "add",
        FileAction::Replace => "replace",
        FileAction::Move => "move",
        FileAction::Delete => "delete",
    }
}

pub(super) fn scope_error(error: impl std::fmt::Display) -> ApiError {
    ApiError::forbidden("scope_denied", error.to_string())
}

pub(super) fn application_change(
    before: Option<&SyncRecord>,
    after: Option<&SyncRecord>,
) -> (&'static str, Value) {
    match (before, after) {
        (None, Some(record)) => (
            "mdbase.record.created",
            json!({
                "path": record.path,
                "after": record.frontmatter,
                "changed_fields": record.frontmatter.keys().collect::<Vec<_>>(),
                "revision": record.revision,
                "types": record.types
            }),
        ),
        (Some(record), None) => (
            "mdbase.record.deleted",
            json!({
                "path": record.path,
                "before": record.frontmatter,
                "previous_revision": record.revision,
                "types": record.types
            }),
        ),
        (Some(before), Some(after)) if before.path != after.path => (
            "mdbase.record.renamed",
            json!({
                "from": before.path,
                "to": after.path,
                "before": before.frontmatter,
                "after": after.frontmatter,
                "previous_revision": before.revision,
                "revision": after.revision,
                "types": after.types,
                "previous_types": before.types,
            }),
        ),
        (Some(before), Some(after)) => (
            "mdbase.record.modified",
            json!({
                "path": after.path,
                "before": before.frontmatter,
                "after": after.frontmatter,
                "changed_fields": changed_frontmatter_fields(before, after),
                "previous_revision": before.revision,
                "revision": after.revision,
                "previous_types": before.types,
                "types": after.types
            }),
        ),
        (None, None) => unreachable!("a persisted change must have a before or after record"),
    }
}

pub(super) fn changed_frontmatter_fields(before: &SyncRecord, after: &SyncRecord) -> Vec<String> {
    before
        .frontmatter
        .keys()
        .chain(after.frontmatter.keys())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .filter(|key| before.frontmatter.get(*key) != after.frontmatter.get(*key))
        .cloned()
        .collect()
}

pub(super) fn invalid_operation_result(
    code: &str,
    message: &str,
    path: Option<String>,
    details: Option<Value>,
) -> OperationResult {
    let mut diagnostic = Diagnostic::error(code, message, path);
    diagnostic.details = details;
    OperationResult {
        valid: false,
        result: json!({}),
        diagnostics: vec![diagnostic],
    }
}

pub(super) fn operation_error(envelope: &OperationResult) -> (String, String) {
    let diagnostic = envelope.diagnostics.first();
    let code = diagnostic
        .map(|value| value.code.as_str())
        .unwrap_or("validation_failed")
        .to_string();
    let message = diagnostic
        .map(|value| value.message.as_str())
        .unwrap_or("The hosted collection rejected the mutation.")
        .to_string();
    (code, message)
}

pub(super) fn scoped_resources(
    mut resources: SyncCollectionResources,
    allowed_types: &[String],
) -> SyncCollectionResources {
    if allowed_types.is_empty() {
        return resources;
    }
    let allowed = allowed_types.iter().collect::<BTreeSet<_>>();
    resources.types.retain(|item| allowed.contains(&item.name));
    for contract in &mut resources.contracts {
        contract
            .implementations
            .retain(|implementation| allowed.contains(&implementation.type_name));
    }
    resources
        .contracts
        .retain(|contract| !contract.implementations.is_empty());
    resources.documents.retain(|document| {
        document.kind == "configuration"
            || document
                .path
                .strip_prefix("_types/")
                .and_then(|path| path.strip_suffix(".md"))
                .is_some_and(|type_name| {
                    allowed.iter().any(|allowed| allowed.as_str() == type_name)
                })
    });
    resources
}

pub(super) fn visible(record: &SyncRecord, allowed_types: &[String]) -> bool {
    allowed_types.is_empty()
        || record
            .types
            .iter()
            .any(|record_type| allowed_types.contains(record_type))
}
