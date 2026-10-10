//! A fixture group's `setup` (config, types, files) as an in-memory collection.
//!
//! The spec fixtures describe a collection on disk. This builds the same
//! collection as a [`MemState`]: `mdbase.yaml` and the type files become
//! resources, files under the types or contracts folder become resources, and
//! every record path becomes a record with an ID derived from its path. Files
//! that are not records (excluded paths, other extensions) are left out.

use mdbn_core::ids::{Hash, Uuid};
use mdbn_core::state::{MemState, StateView};
use mdbn_core::types::{CONFIG_PATH, Catalog};
use serde_json::Value;

/// A deterministic record ID for a fixture path.
pub fn fixture_id(path: &str) -> Uuid {
    let h = Hash::of(path.as_bytes()).0;
    let mut b = [0u8; 16];
    b.copy_from_slice(&h[..16]);
    Uuid::v4_from_bytes(b)
}

/// Build the collection a fixture group's `setup` describes.
pub fn build(setup: &Value) -> MemState {
    let mut state = MemState::new();
    let config = setup.get("config").and_then(Value::as_str);
    if let Some(c) = config {
        state.insert_resource(CONFIG_PATH, c);
    }
    // The types folder comes from the config.
    let types_folder = Catalog::load(config.map(|c| (CONFIG_PATH, c)))
        .settings()
        .types_folder
        .clone();
    if let Some(types) = setup.get("types").and_then(Value::as_object) {
        for (name, src) in types {
            if let Some(src) = src.as_str() {
                state.insert_resource(&format!("{types_folder}/{name}"), src);
            }
        }
    }
    let contracts_folder = Catalog::load(config.map(|c| (CONFIG_PATH, c)))
        .settings()
        .contracts_folder
        .clone();
    if let Some(contracts) = setup.get("contracts").and_then(Value::as_object) {
        for (name, src) in contracts {
            if let Some(src) = src.as_str() {
                state.insert_resource(&format!("{contracts_folder}/{name}"), src);
            }
        }
    }
    let catalog = state.catalog();
    if let Some(files) = setup.get("files").and_then(Value::as_object) {
        for (path, src) in files {
            let Some(src) = src.as_str() else { continue };
            if catalog.is_resource_path(path) {
                state.insert_resource(path, src);
            }
        }
        let catalog = state.catalog();
        for (path, src) in files {
            let Some(src) = src.as_str() else { continue };
            if catalog.is_record_path(path) {
                state.insert_record(fixture_id(path), path, src);
            }
        }
    }
    state
}

/// The record ID at `path` in `state`, if a record lives there.
pub fn id_at(state: &MemState, path: &str) -> Option<Uuid> {
    match state.at_path_key(&mdbn_core::paths::path_key(path)) {
        Some(mdbn_core::state::PathHolder::Record(id)) => Some(id),
        _ => state
            .record_ids()
            .into_iter()
            .find(|id| state.record(id).is_some_and(|r| r.path == path)),
    }
}
