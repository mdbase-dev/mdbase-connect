//! Thin resource-DATA boundary. No file inventory, capture or head authority.
use super::{OpError, OpResult, assess_options, pack_of, pack_op};
use crate::json as j;
use mdbn_core::ids::Hash;
use mdbn_core::setup::envelope::{
    self, CollectionResourceAssessment, CollectionSetup, CollectionSetupTypePack,
    MAX_RESOURCE_INVENTORY_BYTES, MAX_RESOURCE_INVENTORY_ROWS, MAX_RESOURCE_PATH_BYTES,
    MAX_RESOURCE_SOURCE_BYTES,
};
use mdbn_core::state::MemState;
use mdbn_core::validate::{Issue, Severity, Tier};
use serde_json::{Value, json};
use std::collections::BTreeSet;

fn invalid() -> OpError {
    OpError::new("invalid_collection_setup", "invalid resource setup input")
}
fn limit() -> OpError {
    OpError::new(
        "collection_setup_limit_exceeded",
        "resource setup capacity exceeded",
    )
}
fn boxed(e: OpError) -> Box<Issue> {
    Box::new(Issue::new(
        &e.code,
        Severity::Error,
        Tier::Request,
        e.message,
    ))
}

// Validate all rows and capacities before MemState clones a single source.
fn state(input: &Value) -> Result<MemState, OpError> {
    let rows = input
        .get("resources")
        .and_then(Value::as_array)
        .ok_or_else(invalid)?;
    if rows.len() > MAX_RESOURCE_INVENTORY_ROWS {
        return Err(limit());
    }
    let mut paths = BTreeSet::new();
    let mut bytes = 0usize;
    for row in rows {
        let map = row.as_object().ok_or_else(invalid)?;
        if map.len() != 2 || !map.contains_key("path") || !map.contains_key("source") {
            return Err(invalid());
        }
        let path = row["path"].as_str().ok_or_else(invalid)?;
        let source = row["source"].as_str().ok_or_else(invalid)?;
        bytes = bytes.checked_add(source.len()).ok_or_else(limit)?;
        if path.len() > MAX_RESOURCE_PATH_BYTES
            || source.len() > MAX_RESOURCE_SOURCE_BYTES
            || bytes > MAX_RESOURCE_INVENTORY_BYTES
        {
            return Err(limit());
        }
        mdbn_core::paths::check_path(path).map_err(|_| invalid())?;
        if !paths.insert(path) {
            return Err(invalid());
        }
    }
    let mut state = MemState::new();
    for row in rows {
        state.insert_resource(
            row["path"].as_str().expect("validated path"),
            row["source"].as_str().expect("validated source"),
        );
    }
    Ok(state)
}

// Existing standalone pack options are permissive for backwards compatibility.
// This new envelope bridge is strict before delegating their translation.
fn nested_pack(value: &mdbn_core::value::Value) -> Result<CollectionSetupTypePack, Box<Issue>> {
    let value = j::from_core(value);
    let provision = value
        .get("provision")
        .and_then(Value::as_object)
        .ok_or_else(|| boxed(invalid()))?;
    if provision.len() != 2
        || !provision.contains_key("manifest")
        || !provision.contains_key("sources")
    {
        return Err(boxed(invalid()));
    }
    if provision["manifest"].as_str().is_none()
        || provision["sources"]
            .as_object()
            .is_none_or(|m| m.values().any(|v| !v.is_string()))
    {
        return Err(boxed(invalid()));
    }
    let options = value
        .get("options")
        .and_then(Value::as_object)
        .ok_or_else(|| boxed(invalid()))?;
    if options.keys().any(|k| {
        !matches!(
            k.as_str(),
            "installed_by"
                | "target_overrides"
                | "adopt"
                | "preserve_seed_targets"
                | "allow_downgrade"
        )
    }) || options
        .get("installed_by")
        .and_then(Value::as_str)
        .is_none()
    {
        return Err(boxed(invalid()));
    }
    for key in ["target_overrides", "adopt"] {
        if let Some(v) = options.get(key) {
            let map = v.as_object().ok_or_else(|| boxed(invalid()))?;
            if map.values().any(|v| !v.is_string()) {
                return Err(boxed(invalid()));
            }
            if key == "adopt"
                && map
                    .values()
                    .any(|v| v.as_str().and_then(Hash::parse).is_none())
            {
                return Err(boxed(invalid()));
            }
        }
    }
    if let Some(v) = options.get("preserve_seed_targets") {
        let a = v.as_array().ok_or_else(|| boxed(invalid()))?;
        let mut seen = BTreeSet::new();
        for v in a {
            let path = v.as_str().ok_or_else(|| boxed(invalid()))?;
            if !seen.insert(path) {
                return Err(boxed(invalid()));
            }
        }
    }
    if options
        .get("allow_downgrade")
        .is_some_and(|v| !v.is_boolean())
    {
        return Err(boxed(invalid()));
    }
    Ok(CollectionSetupTypePack {
        pack: pack_of(&value["provision"]).map_err(boxed)?,
        options: assess_options(value.get("options")).map_err(boxed)?,
    })
}

fn assessment(a: &CollectionResourceAssessment) -> Value {
    let mut dto = j::from_core(&a.to_value());
    let c = &a.configuration;
    dto["configuration"] = json!({
        "configuration": c.configuration.iter().map(|r| json!({
            "requirement": r.requirement, "path": r.path, "value": j::from_core(&r.value),
            "action": r.action, "conflict": r.conflict.as_ref().map(|x| json!({
                "code": x.code, "path": x.path, "expected": x.expected, "observed": x.observed
            }))
        })).collect::<Vec<_>>(),
        "document": c.document,
        "source_digest": c.source_digest.as_ref().map(j::hash),
        "assessment_digest": j::hash(&c.assessment_digest),
        "applicable": c.applicable(),
    });
    dto["type_packs"] = json!(a.type_packs.iter().map(j::assessment).collect::<Vec<_>>());
    dto
}

pub(super) fn resources(input: &Value, apply: bool) -> OpResult {
    let map = input.as_object().ok_or_else(invalid)?;
    if map
        .keys()
        .any(|k| !matches!(k.as_str(), "resources" | "setup" | "expected_digest"))
        || (!apply && map.contains_key("expected_digest"))
    {
        return Err(invalid());
    }
    let state = state(input)?;
    let setup = input.get("setup").ok_or_else(invalid)?;
    let setup = CollectionSetup::from_value(&j::to_core(setup), &nested_pack)
        .map_err(|e| OpError::from_issue(*e))?;
    if !apply {
        let a = envelope::assess_collection_resources(&state, &setup)
            .map_err(|e| OpError::from_issue(*e))?;
        return Ok(assessment(&a));
    }
    let expected = input
        .get("expected_digest")
        .and_then(Value::as_str)
        .and_then(Hash::parse)
        .ok_or_else(invalid)?;
    let (a, ops) = envelope::apply_collection_resources(&state, &setup, expected)
        .map_err(|e| OpError::from_issue(*e))?;
    // Do not plan a fake collection or derive snapshot writes: the actual native
    // atomic mutation must enforce these original guards and explicit creates.
    Ok(json!({
        "assessment": assessment(&a),
        "ops": ops.iter().map(pack_op).collect::<Result<Vec<_>, _>>()?,
    }))
}
