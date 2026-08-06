use crate::MirrorError;
use serde::Serialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

pub fn canonical_json<T: Serialize>(value: &T) -> Result<String, MirrorError> {
    let value = serde_json::to_value(value).map_err(MirrorError::from)?;
    serde_json::to_string(&sort_value(value)).map_err(MirrorError::from)
}

pub fn fingerprint<T: Serialize>(value: &T) -> Result<String, MirrorError> {
    let canonical = canonical_json(value)?;
    Ok(format!("sha256:{:x}", Sha256::digest(canonical.as_bytes())))
}

fn sort_value(value: Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.into_iter().map(sort_value).collect()),
        Value::Object(values) => {
            let mut keys = values.keys().cloned().collect::<Vec<_>>();
            keys.sort();
            let mut sorted = Map::new();
            for key in keys {
                sorted.insert(key.clone(), sort_value(values[&key].clone()));
            }
            Value::Object(sorted)
        }
        scalar => scalar,
    }
}
