//! JSON ⇄ core value conversion and the JSON shapes of core types.

use mdbn_core::contracts::{Contract, Implementation};
use mdbn_core::ids::Hash;
use mdbn_core::packs::{Assessment, Lock, Pack, Receipt};
use mdbn_core::types::{Catalog, Settings, TypeDef};
use mdbn_core::validate::{Issue, Severity, Tier};
use mdbn_core::value::Value as CoreValue;
use serde_json::{Map, Value, json};

/// A JSON value as a core value. Integers stay exact; other numbers become
/// floats; NaN and infinities (not JSON anyway) become null.
pub fn to_core(v: &Value) -> CoreValue {
    match v {
        Value::Null => CoreValue::Null,
        Value::Bool(b) => CoreValue::Bool(*b),
        Value::Number(n) => match n.as_i64() {
            Some(i) => CoreValue::Int(i),
            None => n
                .as_f64()
                .and_then(CoreValue::float)
                .unwrap_or(CoreValue::Null),
        },
        Value::String(s) => CoreValue::Text(s.clone()),
        Value::Array(a) => CoreValue::List(a.iter().map(to_core).collect()),
        Value::Object(o) => {
            CoreValue::Map(o.iter().map(|(k, v)| (k.clone(), to_core(v))).collect())
        }
    }
}

/// A core value as JSON. Object keys come out sorted (JSON objects are
/// unordered; digests use JCS anyway).
pub fn from_core(v: &CoreValue) -> Value {
    match v {
        CoreValue::Null => Value::Null,
        CoreValue::Bool(b) => Value::Bool(*b),
        CoreValue::Int(i) => json!(i),
        CoreValue::Float(f) => json!(f),
        CoreValue::Text(s) => Value::String(s.clone()),
        CoreValue::List(l) => Value::Array(l.iter().map(from_core).collect()),
        CoreValue::Map(m) => Value::Object(
            m.iter()
                .map(|(k, v)| (k.to_owned(), from_core(v)))
                .collect(),
        ),
    }
}

/// `sha256:<hex>`.
pub fn hash(h: &Hash) -> Value {
    Value::String(h.to_string())
}

/// An issue (spec 14 diagnostic): `code`, `severity`, `tier`, `message`,
/// `location`?, `type`?, `details`?.
pub fn issue(i: &Issue) -> Value {
    let mut m = Map::new();
    m.insert("code".into(), json!(i.code));
    m.insert(
        "severity".into(),
        json!(match i.severity {
            Severity::Warning => "warning",
            Severity::Error => "error",
        }),
    );
    m.insert(
        "tier".into(),
        json!(match i.tier {
            Tier::Request => "request",
            Tier::SingleRecord => "single_record",
            Tier::CrossRecord => "cross_record",
        }),
    );
    m.insert("message".into(), json!(i.message));
    if let Some(l) = &i.location {
        m.insert("location".into(), json!(l));
    }
    if let Some(t) = &i.type_name {
        m.insert("type".into(), json!(t));
    }
    if let Some(d) = &i.details {
        m.insert("details".into(), from_core(d));
    }
    Value::Object(m)
}

/// Issues as a JSON array.
pub fn issues(list: &[Issue]) -> Value {
    Value::Array(list.iter().map(issue).collect())
}

/// `settings` with defaults applied.
pub fn settings(s: &Settings) -> Value {
    json!({
        "timezone": s.timezone,
        "types_folder": s.types_folder,
        "contracts_folder": s.contracts_folder,
        "record_extensions": s.record_extensions,
        "validation": level(s.validation),
        "explicit_type_keys": s.explicit_type_keys,
        "id_field": s.id_field,
        "exclude": s.exclude,
    })
}

fn level(l: mdbn_core::intent::Level) -> &'static str {
    use mdbn_core::intent::Level;
    match l {
        Level::Off => "off",
        Level::Warn => "warn",
        Level::Error => "error",
    }
}

/// A type definition: `name`, `path`, `version`?, `schema {document, entry}`,
/// `merge`, `link_fields`, `path_pattern`?, and `raw` (the whole frontmatter).
pub fn type_def(t: &TypeDef) -> Value {
    json!({
        "name": t.name,
        "path": t.source_path,
        "version": t.version,
        "schema": { "document": from_core(&t.schema_document), "entry": t.schema_entry },
        "merge": t.merge,
        "link_fields": t.link_fields.keys().collect::<Vec<_>>(),
        "path_pattern": t.path_pattern,
        "raw": from_core(&CoreValue::Map(t.raw.clone())),
    })
}

/// A contract: `id`, `version`, `contract_type`, `name`?, `digest`, `path`,
/// `schemas {member: {entry, value}}`.
pub fn contract(c: &Contract) -> Value {
    let schemas: Map<String, Value> = c
        .schemas
        .iter()
        .map(|(k, s)| {
            (
                k.clone(),
                json!({ "entry": s.entry, "value": from_core(&s.value()) }),
            )
        })
        .collect();
    json!({
        "id": c.id,
        "version": c.version.to_string(),
        "contract_type": c.contract_type,
        "name": c.name,
        "digest": hash(&c.digest),
        "path": c.source_path,
        "schemas": schemas,
    })
}

/// An implementation: `type`, `contract`, `requirement`, `version`, `fields`,
/// `binding`, `contract_digest`, `digest`.
pub fn implementation(i: &Implementation) -> Value {
    json!({
        "type": i.type_name,
        "contract": i.contract,
        "requirement": i.requirement,
        "version": i.version.to_string(),
        "fields": i.fields.iter().map(|(a, b)| json!([a, b])).collect::<Vec<_>>(),
        "binding": from_core(&CoreValue::Map(i.binding.clone())),
        "contract_digest": hash(&i.contract_digest),
        "digest": hash(&i.digest),
    })
}

/// A catalog: `valid`, `spec_version`, `settings`, `types`, `contracts`,
/// `implementations`, `issues`.
pub fn catalog(c: &Catalog) -> Value {
    json!({
        "valid": c.is_valid(),
        "spec_version": c.spec_version(),
        "settings": settings(c.settings()),
        "types": c.types().iter().map(type_def).collect::<Vec<_>>(),
        "contracts": c.contracts().iter().map(contract).collect::<Vec<_>>(),
        "implementations": c.implementations().iter().map(implementation).collect::<Vec<_>>(),
        "issues": issues(c.issues()),
    })
}

/// A validated pack: `id`, `version`, `digest`, `resources`.
pub fn pack(p: &Pack) -> Value {
    json!({
        "id": p.id,
        "version": p.version.to_string(),
        "digest": hash(&p.digest),
        "resources": p.resources.iter().map(|r| json!({
            "kind": r.kind,
            "mode": mode(r.mode),
            "source": r.source,
            "target": r.target,
            "digest": hash(&r.digest),
            "document": r.document,
            "baselines": r.baselines.iter().map(|b| json!({
                "digest": hash(&b.digest), "version": b.version
            })).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
    })
}

fn mode(m: mdbn_core::packs::Mode) -> &'static str {
    match m {
        mdbn_core::packs::Mode::Managed => "managed",
        mdbn_core::packs::Mode::Seed => "seed",
    }
}

/// An installed-pack receipt from the lock.
pub fn receipt(r: &Receipt) -> Value {
    json!({
        "id": r.id,
        "version": r.version,
        "digest": hash(&r.digest),
        "installed_by": r.installed_by,
        "resources": r.resources.iter().map(|x| json!({
            "kind": x.kind,
            "mode": mode(x.mode),
            "source": x.source,
            "target": x.target,
            "digest": hash(&x.digest),
            "origin_digest": x.origin_digest.as_ref().map(hash),
        })).collect::<Vec<_>>(),
    })
}

/// A parsed lock document.
pub fn lock(l: &Lock) -> Value {
    json!({ "packs": l.packs.iter().map(receipt).collect::<Vec<_>>() })
}

/// An assessment: `status`, `applicable`, `pack`, `current`?, `resources`,
/// `lock_action`, `lock_document`, `lock_digest`, `issues`, `assessment_digest`.
pub fn assessment(a: &Assessment) -> Value {
    json!({
        "status": a.status.as_str(),
        "applicable": a.applicable(),
        "pack": { "id": a.pack.0, "version": a.pack.1, "digest": hash(&a.pack.2) },
        "current": a.current.as_ref().map(receipt),
        "resources": a.resources.iter().map(|r| json!({
            "kind": r.kind,
            "mode": mode(r.mode),
            "source": r.source,
            "target": r.target,
            "action": r.action.as_str(),
            "live": r.live.as_ref().map(hash),
            "document": r.document,
            "result": r.result.as_ref().map(hash),
            "origin": r.origin.as_ref().map(hash),
            "reason": r.reason,
            "upgrade_baseline": r.upgrade_baseline.as_ref().map(|(d, v)| json!({
                "digest": hash(d), "version": v
            })),
        })).collect::<Vec<_>>(),
        "lock_action": a.lock_action.as_str(),
        "lock_document": a.lock_document,
        "lock_digest": hash(&a.lock_digest),
        "issues": issues(&a.issues),
        "assessment_digest": hash(&a.assessment_digest),
    })
}
