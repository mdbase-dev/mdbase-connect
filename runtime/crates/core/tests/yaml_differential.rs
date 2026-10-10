//! Differential test: the profile parser against `yaml-rust2` on generated and
//! mutated documents. Where both accept a document they must agree on its value.
//! The profile is deliberately stricter (duplicate keys, unknown tags, explicit
//! keys...), so a document only `yaml-rust2` accepts is not a failure; the
//! reverse (only the profile accepts) is, unless it is a known leniency.

mod support;

use mdbn_core::value::{Map, Value};
use mdbn_core::yaml::parse_value;
use support::{Rng, gen_frontmatter};
use yaml_rust2::{Yaml, YamlLoader};

/// `yaml-rust2`'s value in the profile's data model, or `None` when it uses
/// something the profile represents differently (non-string keys, specials).
fn convert(y: &Yaml) -> Option<Value> {
    Some(match y {
        Yaml::Null => Value::Null,
        Yaml::Boolean(b) => Value::Bool(*b),
        Yaml::Integer(i) => Value::int(*i),
        Yaml::Real(s) => s.parse::<f64>().ok().and_then(Value::float)?,
        Yaml::String(s) => Value::string(s.clone()),
        Yaml::Array(a) => Value::List(a.iter().map(convert).collect::<Option<_>>()?),
        Yaml::Hash(h) => {
            let mut m = Map::new();
            for (k, v) in h {
                let Yaml::String(k) = k else { return None };
                m.insert(k.clone(), convert(v)?);
            }
            Value::Map(m)
        }
        Yaml::Alias(_) | Yaml::BadValue => return None,
    })
}

/// Equality, except for two `yaml-rust2` deviations from YAML 1.2 (where
/// PyYAML agrees with the profile): it does not resolve the capitalised core
/// schema forms (`Null`, `TRUE`, ...), and it gives a clipped block scalar with
/// no content lines a line break instead of the empty string.
fn eq_modulo(ours: &Value, theirs: &Value) -> bool {
    match (ours, theirs) {
        (Value::Text(a), Value::Text(b)) if a.is_empty() => b.is_empty() || b == "\n",
        (Value::Null, Value::Text(t)) => matches!(t.as_str(), "Null" | "NULL"),
        (Value::Bool(true), Value::Text(t)) => matches!(t.as_str(), "True" | "TRUE"),
        (Value::Bool(false), Value::Text(t)) => matches!(t.as_str(), "False" | "FALSE"),
        (Value::List(a), Value::List(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(x, y)| eq_modulo(x, y))
        }
        (Value::Map(a), Value::Map(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(k, v)| b.get(k).is_some_and(|w| eq_modulo(v, w)))
        }
        (a, b) => a == b,
    }
}

fn check(text: &str, seed: u64, stats: &mut [u32; 4]) {
    // A block scalar at the end of input without a final line break: the YAML
    // spec (and PyYAML) clip to no line break, yaml-rust2 adds one. The profile
    // follows the spec; that case is covered by unit tests, so compare complete
    // lines only.
    let owned;
    let text = if text.ends_with('\n') {
        text
    } else {
        owned = format!("{text}\n");
        &owned
    };
    let ours = parse_value(text);
    let theirs = YamlLoader::load_from_str(text);
    match (ours, theirs) {
        (Ok(v), Ok(docs)) => {
            let v = v.unwrap_or(Value::Null);
            let Some(t) = docs.first().map_or(Some(Value::Null), convert) else {
                stats[3] += 1;
                return;
            };
            if docs.len() > 1 {
                stats[3] += 1;
                return;
            }
            assert!(
                eq_modulo(&v, &t),
                "seed {seed}: values differ\n{text}\nours:   {}\ntheirs: {}",
                v.to_json(),
                t.to_json()
            );
            stats[0] += 1;
        }
        (Err(_), Err(_)) => stats[1] += 1,
        (Err(_), Ok(_)) => stats[2] += 1,
        // The profile accepts and yaml-rust2 rejects. Every category seen so far
        // is a yaml-rust2 deviation where PyYAML agrees with the profile
        // (` -` before a flow indicator in a plain scalar, `[k: {..}]`), or a
        // deliberate leniency (a closing bracket at the parent's indentation).
        // Counted, and bounded below.
        (Ok(_), Err(_)) => stats[3] += 1,
    }
}

#[test]
fn profile_agrees_with_yaml_rust2() {
    let mut stats = [0u32; 4];
    for seed in 0..3000u64 {
        let mut r = Rng::new(seed);
        let (text, _) = gen_frontmatter(&mut r);
        check(&text, seed, &mut stats);
        // Mutations.
        let mut bytes = text.into_bytes();
        for _ in 0..1 + r.usize(3) {
            if bytes.is_empty() {
                break;
            }
            let i = r.usize(bytes.len());
            match r.below(3) {
                0 => {
                    bytes.remove(i);
                }
                1 => bytes.insert(i, *r.pick(b" \n-:#[]{}'\"|>,")),
                _ => bytes[i] = *r.pick(b" \n:-[{"),
            }
        }
        if let Ok(t) = String::from_utf8(bytes) {
            check(&t, seed, &mut stats);
        }
    }
    // Most documents must be comparable for the test to mean anything, and
    // profile-only acceptance must stay rare.
    assert!(stats[0] > 3000, "{stats:?}");
    assert!(stats[3] * 100 < stats[0], "{stats:?}");
}
