use serde_json::Value;

use crate::{is_collection_operation, FILE_CONTROL_MESSAGE_TYPES};

/// Validates protocol-level operation discriminators before replay or mutation
/// state is touched. Operation-specific payload validation remains owned by the
/// provider or collection runtime.
pub fn validate_operation_discriminators(
    operation: &str,
    input: &Value,
) -> Result<(), &'static str> {
    let object = input
        .as_object()
        .ok_or("Operation input must be an object.")?;
    if operation == "file_control" {
        let message_type = object.get("type").and_then(Value::as_str).unwrap_or("");
        if !FILE_CONTROL_MESSAGE_TYPES.contains(&message_type) {
            return Err("Unknown file-control message type.");
        }
        if object.contains_key("action") {
            return Err("File-control input must not contain a sync action discriminator.");
        }
        return Ok(());
    }
    if !is_collection_operation(operation) {
        return Err("Unknown collection operation.");
    }
    if operation == "sync" {
        match object.get("action").and_then(Value::as_str) {
            Some("changes" | "mutate") => {}
            _ => return Err("Unknown sync action."),
        }
        if object.contains_key("type") {
            return Err("Sync input must not contain a file-control type discriminator.");
        }
    } else if object.contains_key("action") {
        return Err("Collection operation input must not contain a sync action discriminator.");
    }
    if object.contains_key("operation") {
        return Err("Operation input must not contain a nested operation discriminator.");
    }
    Ok(())
}
