use std::{
    fs,
    path::{Component, Path, PathBuf},
};

use mdbase_connect_protocol::{SyncMutation, SyncMutationOperation};
use serde_json::{Map, Value};

use crate::error::{ApiError, ApiResult};

pub(super) fn operation_input(
    mutation: &SyncMutation,
    current_path: Option<&str>,
) -> ApiResult<(Value, Option<String>)> {
    let value = Value::Object(mutation.input.clone());
    match mutation.operation {
        SyncMutationOperation::Create => {
            let path = required_string(&value, "path")?;
            safe_relative(path)?;
            let mut input = mutation.input.clone();
            input.remove("types");
            Ok((Value::Object(input), None))
        }
        SyncMutationOperation::Update => {
            let path = current_path.ok_or_else(|| {
                ApiError::not_found("record_not_found", "The hosted record does not exist.")
            })?;
            let mut input = mutation.input.clone();
            // Connect exposes `patch`; the embedded Collection API consumes
            // the equivalent `fields` object. Keep that translation isolated
            // at this engine adapter.
            if let Some(patch) = input.remove("patch") {
                input.insert("fields".to_string(), patch);
            }
            input.insert("path".to_string(), Value::String(path.to_string()));
            if let Some(revision) = &mutation.base_revision {
                input.insert("if_revision".to_string(), Value::String(revision.clone()));
            }
            Ok((Value::Object(input), Some(path.to_string())))
        }
        SyncMutationOperation::Rename => {
            let from = current_path.ok_or_else(|| {
                ApiError::not_found("record_not_found", "The hosted record does not exist.")
            })?;
            let to = required_string(&value, "path")?;
            safe_relative(to)?;
            let mut input = Map::from_iter([
                ("from".to_string(), Value::String(from.to_string())),
                ("to".to_string(), Value::String(to.to_string())),
                ("update_refs".to_string(), Value::Bool(true)),
            ]);
            if let Some(revision) = &mutation.base_revision {
                input.insert("if_revision".to_string(), Value::String(revision.clone()));
            }
            if mutation
                .input
                .get("include_document")
                .and_then(Value::as_bool)
                == Some(true)
            {
                input.insert("include_document".to_string(), Value::Bool(true));
            }
            Ok((Value::Object(input), Some(from.to_string())))
        }
        SyncMutationOperation::Delete => {
            let path = current_path.ok_or_else(|| {
                ApiError::not_found("record_not_found", "The hosted record does not exist.")
            })?;
            let mut input = Map::from_iter([("path".to_string(), Value::String(path.to_string()))]);
            if let Some(revision) = &mutation.base_revision {
                input.insert("if_revision".to_string(), Value::String(revision.clone()));
            }
            Ok((Value::Object(input), Some(path.to_string())))
        }
    }
}

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
