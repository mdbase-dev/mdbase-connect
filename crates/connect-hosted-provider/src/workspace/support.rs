use std::{
    fs,
    path::{Component, Path, PathBuf},
};

#[cfg(test)]
use serde_json::{Map, Value};

use crate::error::{ApiError, ApiResult};

#[cfg(test)]
pub(super) fn operation_input(
    operation: &str,
    source: &Map<String, Value>,
    current_path: Option<&str>,
) -> ApiResult<(Value, Option<String>)> {
    let value = Value::Object(source.clone());
    match operation {
        "create" => {
            let path = required_string(&value, "path")?;
            safe_relative(path)?;
            let mut input = source.clone();
            input.remove("types");
            Ok((Value::Object(input), None))
        }
        "update" => {
            let path = current_path.ok_or_else(|| {
                ApiError::not_found("record_not_found", "The hosted record does not exist.")
            })?;
            let mut input = source.clone();
            // Connect exposes `patch`; the embedded Collection API consumes
            // the equivalent `fields` object. Keep that translation isolated
            // at this engine adapter.
            if let Some(patch) = input.remove("patch") {
                input.insert("fields".to_string(), patch);
            }
            input.insert("path".to_string(), Value::String(path.to_string()));
            Ok((Value::Object(input), Some(path.to_string())))
        }
        "rename" => {
            let from = current_path.ok_or_else(|| {
                ApiError::not_found("record_not_found", "The hosted record does not exist.")
            })?;
            let to = required_string(&value, "path")?;
            safe_relative(to)?;
            let mut input = source.clone();
            input.insert("from".to_string(), Value::String(from.to_string()));
            input.insert("to".to_string(), Value::String(to.to_string()));
            Ok((Value::Object(input), Some(from.to_string())))
        }
        "delete" => {
            let path = current_path.ok_or_else(|| {
                ApiError::not_found("record_not_found", "The hosted record does not exist.")
            })?;
            let mut input = source.clone();
            input.insert("path".to_string(), Value::String(path.to_string()));
            Ok((Value::Object(input), Some(path.to_string())))
        }
        _ => Err(ApiError::bad_request(
            "unsupported_operation",
            "The hosted record operation is unsupported.",
        )),
    }
}

#[cfg(test)]
fn required_string<'a>(value: &'a Value, field: &str) -> ApiResult<&'a str> {
    value.get(field).and_then(Value::as_str).ok_or_else(|| {
        ApiError::bad_request(
            "invalid_mutation",
            format!("Hosted mutation input requires {field}."),
        )
    })
}

pub(super) fn write_document(root: &Path, relative: &str, document: &str) -> ApiResult<()> {
    let path = safe_path(root, relative)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, document)?;
    Ok(())
}

pub(super) fn safe_path(root: &Path, relative: &str) -> ApiResult<PathBuf> {
    safe_relative(relative)?;
    Ok(root.join(relative))
}

fn safe_relative(relative: &str) -> ApiResult<()> {
    let path = Path::new(relative);
    if relative.is_empty()
        || relative.contains('\\')
        || path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir
                    | Component::CurDir
                    | Component::RootDir
                    | Component::Prefix(_)
            )
        })
    {
        return Err(ApiError::bad_request(
            "invalid_path",
            "Hosted record paths must be safe collection-relative paths.",
        ));
    }
    Ok(())
}
