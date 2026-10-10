//! YAML fixture loading into `serde_json::Value`.

use serde_json::{Map, Number, Value};
use yaml_rust2::{Yaml, YamlLoader};

/// Parse one YAML document into JSON. Mapping keys become strings.
pub fn parse(src: &str) -> Result<Value, String> {
    let docs = YamlLoader::load_from_str(src).map_err(|e| e.to_string())?;
    match docs.as_slice() {
        [doc] => to_json(doc),
        _ => Err(format!("expected one YAML document, found {}", docs.len())),
    }
}

fn to_json(y: &Yaml) -> Result<Value, String> {
    Ok(match y {
        Yaml::Null => Value::Null,
        Yaml::Boolean(b) => Value::Bool(*b),
        Yaml::Integer(i) => Value::Number((*i).into()),
        Yaml::Real(s) => match y.as_f64().and_then(Number::from_f64) {
            Some(n) => Value::Number(n),
            None => Value::String(s.clone()),
        },
        Yaml::String(s) => Value::String(s.clone()),
        Yaml::Array(a) => Value::Array(a.iter().map(to_json).collect::<Result<_, _>>()?),
        Yaml::Hash(h) => {
            let mut m = Map::new();
            for (k, v) in h {
                let key = match k {
                    Yaml::String(s) | Yaml::Real(s) => s.clone(),
                    Yaml::Integer(i) => i.to_string(),
                    Yaml::Boolean(b) => b.to_string(),
                    Yaml::Null => "null".into(),
                    other => return Err(format!("unsupported mapping key {other:?}")),
                };
                m.insert(key, to_json(v)?);
            }
            Value::Object(m)
        }
        Yaml::Alias(_) | Yaml::BadValue => return Err(format!("unsupported YAML node {y:?}")),
    })
}
