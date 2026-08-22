use super::*;

pub(super) fn validate_hosted_operation_input(operation: &str, input: &Value) -> ApiResult<()> {
    let object = input
        .as_object()
        .ok_or_else(|| invalid_operation_field(operation, "input", "must be an object"))?;
    let allowed = match operation {
        "create" => &[
            "path",
            "type",
            "contract",
            "frontmatter",
            "body",
            "if_revision",
            "include_document",
            "dry_run",
        ][..],
        "changes" => &["after", "limit"][..],
        _ => return Ok(()),
    };
    if let Some(field) = object
        .keys()
        .find(|field| !allowed.contains(&field.as_str()))
    {
        return Err(invalid_operation_field(
            operation,
            field,
            "is not supported",
        ));
    }

    match operation {
        "create" => {
            for field in ["path", "type", "body", "if_revision"] {
                if object.get(field).is_some_and(|value| !value.is_string()) {
                    return Err(invalid_operation_field(
                        operation,
                        field,
                        "must be a string",
                    ));
                }
            }
            if object
                .get("contract")
                .is_some_and(|value| !value.is_object())
            {
                return Err(invalid_operation_field(
                    operation,
                    "contract",
                    "must be an object",
                ));
            }
            if object
                .get("frontmatter")
                .is_some_and(|value| !value.is_object())
            {
                return Err(invalid_operation_field(
                    operation,
                    "frontmatter",
                    "must be an object",
                ));
            }
            for field in ["include_document", "dry_run"] {
                if object.get(field).is_some_and(|value| !value.is_boolean()) {
                    return Err(invalid_operation_field(
                        operation,
                        field,
                        "must be a boolean",
                    ));
                }
            }
        }
        "changes" => {
            if object
                .get("after")
                .is_some_and(|value| value.as_u64().is_none())
            {
                return Err(invalid_operation_field(
                    operation,
                    "after",
                    "must be a non-negative integer",
                ));
            }
            if let Some(limit) = object.get("limit") {
                let valid = limit.as_u64().is_some_and(|limit| limit > 0);
                if !valid {
                    return Err(invalid_operation_field(
                        operation,
                        "limit",
                        "must be a positive integer",
                    ));
                }
            }
        }
        _ => unreachable!(),
    }
    Ok(())
}

fn invalid_operation_field(operation: &str, field: &str, reason: &str) -> ApiError {
    ApiError::bad_request(
        "invalid_request",
        format!("Hosted {operation} input field `{field}` {reason}."),
    )
}
