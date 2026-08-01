use super::*;
pub(super) fn authorize_application_operation(
    replica: &Replica,
    operation: &str,
    request_origin: Option<&str>,
) -> ApiResult<()> {
    if !replica
        .allowed_operations
        .iter()
        .any(|allowed| allowed == operation)
    {
        return Err(ApiError::forbidden(
            "insufficient_access",
            "The application is not allowed to perform this operation.",
        )
        .with_details(json!({
            "required_operations": [operation],
            "granted_operations": replica.allowed_operations,
            "missing_operations": [operation],
        })));
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
    if replica.purpose == ReplicaPurpose::Application && !replica.full_collection {
        return Err(ApiError::forbidden(
            "scope_denied",
            "Contract-scoped replicas are unavailable because the sync document format contains whole records. Use projected collection operations or request explicit full-collection access.",
        ));
    }
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

pub(super) fn scope_error(error: impl std::fmt::Display) -> ApiError {
    ApiError::forbidden("scope_denied", error.to_string())
}

pub(super) fn mutation_operation_name(operation: SyncMutationOperation) -> &'static str {
    match operation {
        SyncMutationOperation::Create => "create",
        SyncMutationOperation::Update => "update",
        SyncMutationOperation::Rename => "rename",
        SyncMutationOperation::Delete => "delete",
    }
}

pub(super) fn result_string<'a>(value: &'a Value, field: &str) -> ApiResult<&'a str> {
    value.get(field).and_then(Value::as_str).ok_or_else(|| {
        ApiError::internal(format!(
            "The hosted collection operation omitted its {field} result."
        ))
    })
}

pub(super) fn scope_read_input(
    operation: &str,
    input: Value,
    allowed_types: &[String],
) -> ApiResult<Value> {
    if operation != "query" || allowed_types.is_empty() {
        return Ok(input);
    }
    let mut scoped = input.as_object().cloned().ok_or_else(|| {
        ApiError::forbidden("scope_denied", "Scoped query input must be an object.")
    })?;
    if query_crosses_record_boundary(&Value::Object(scoped.clone())) {
        return Err(ApiError::forbidden(
            "scope_denied",
            "Cross-record traversal is unavailable to a scoped application.",
        ));
    }
    if let Some(requested) = scoped.get("types") {
        let requested = requested.as_array().ok_or_else(|| {
            ApiError::forbidden("scope_denied", "Scoped query types must be a list.")
        })?;
        if requested.is_empty() {
            scoped.insert(
                "types".to_string(),
                Value::Array(allowed_types.iter().cloned().map(Value::String).collect()),
            );
        } else if requested.iter().any(|value| {
            value
                .as_str()
                .is_none_or(|name| !allowed_types.iter().any(|allowed| allowed == name))
        }) {
            return Err(ApiError::forbidden(
                "scope_denied",
                "The query requests a record type outside this application's scope.",
            ));
        }
    } else {
        scoped.insert(
            "types".to_string(),
            Value::Array(allowed_types.iter().cloned().map(Value::String).collect()),
        );
    }
    Ok(Value::Object(scoped))
}

pub(super) fn query_crosses_record_boundary(value: &Value) -> bool {
    match value {
        Value::String(source) => {
            let compact = source
                .chars()
                .filter(|character| !character.is_whitespace())
                .collect::<String>();
            compact.contains(".asFile") || compact.contains(".backlinks")
        }
        Value::Array(values) => values.iter().any(query_crosses_record_boundary),
        Value::Object(values) => values.values().any(query_crosses_record_boundary),
        _ => false,
    }
}

pub(super) fn ensure_operation_result_visible(
    result: &OperationResult,
    allowed_types: &[String],
) -> ApiResult<()> {
    if allowed_types.is_empty() || !result.valid {
        return Ok(());
    }
    let visible = result
        .result
        .get("types")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .any(|record_type| allowed_types.iter().any(|allowed| allowed == record_type));
    if visible {
        Ok(())
    } else {
        Err(ApiError::forbidden(
            "scope_denied",
            "The requested record is outside this application's record scope.",
        ))
    }
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

pub(super) fn previously_applied(receipt: SyncMutationReceipt) -> SyncMutationReceipt {
    match receipt {
        SyncMutationReceipt::Applied {
            mutation_id,
            sequence,
            record,
        }
        | SyncMutationReceipt::PreviouslyApplied {
            mutation_id,
            sequence,
            record,
        } => SyncMutationReceipt::PreviouslyApplied {
            mutation_id,
            sequence,
            record,
        },
        receipt => receipt,
    }
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
