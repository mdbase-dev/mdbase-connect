//! Pure configuration component of the CollectionSetup port. Callers must use
//! the whole setup assessment/transaction, not commit this component separately.
//!
//! Ported from mdbase-rs `v03/collection_setup.rs` (MIT, see LICENSE.port).
//! Only contains/set_add over scalar sequence members; the sole core-namespace
//! exception is `/settings/record_extensions`. No ambient collection reads.

use std::collections::{BTreeMap, BTreeSet};

use crate::contracts::jcs_digest;
use crate::doc::{Document, RecordFormat};
use crate::ids::{Hash, revision};
use crate::types::Settings;
use crate::validate::{Issue, Severity, Tier};
use crate::value::{Map, Value};
use crate::writer::{self, Change};

/// Maximum configuration requirements and provisions, independently.
pub const MAX_CLAUSES: usize = 128;
/// Maximum aggregate declaration string bytes, counted before cloning.
pub const MAX_DECLARATION_BYTES: usize = 65_536;
/// Maximum configuration source/result UTF-8 bytes.
pub const MAX_CONFIG_BYTES: usize = 1_048_576;

/// The first configuration predicate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigurationPredicate {
    /// A scalar is a member of the selected sequence.
    Contains,
}
/// The first configuration operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigurationOperation {
    /// Preserve order; append only if the scalar is absent.
    SetAdd,
}
/// One application-declared requirement.
#[derive(Debug, Clone, PartialEq)]
pub struct ConfigurationRequirement {
    /// Stable, lowercase hyphenated identifier.
    pub id: String,
    /// Confined RFC 6901 pointer.
    pub path: String,
    /// Contains only in this profile.
    pub predicate: ConfigurationPredicate,
    /// Public declared JSON scalar.
    pub value: Value,
}
/// One provision linked exactly to its requirement.
#[derive(Debug, Clone, PartialEq)]
pub struct ConfigurationProvision {
    /// Requirement ID.
    pub requirement: String,
    /// Set-add only in this profile.
    pub operation: ConfigurationOperation,
    /// Must repeat the requirement's pointer exactly.
    pub path: String,
    /// Must repeat its scalar exactly under canonical scalar equality.
    pub value: Value,
}
/// Configuration arrays lifted from the catalog carrier into CollectionSetup.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ConfigurationDeclaration {
    /// CollectionSetup.requirements.configuration.
    pub requirements: Vec<ConfigurationRequirement>,
    /// CollectionSetup.provisions.configuration, in declaration order.
    pub provisions: Vec<ConfigurationProvision>,
}
/// Shape-only conflict: no observed collection value or parser text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigurationConflict {
    /// configuration_path_conflict or configuration_type_conflict.
    pub code: &'static str,
    /// Public declaration pointer.
    pub path: String,
    /// Required shape.
    pub expected: &'static str,
    /// Observed JSON type, never the value.
    pub observed: &'static str,
}
/// One visible configuration action.
#[derive(Debug, Clone, PartialEq)]
pub struct ConfigurationSetupAssessment {
    /// Public requirement ID.
    pub requirement: String,
    /// Public pointer.
    pub path: String,
    /// Public declared value (never an observed secret).
    pub value: Value,
    /// current, add, or conflict.
    pub action: &'static str,
    /// Shape-only conflict if blocked.
    pub conflict: Option<ConfigurationConflict>,
}
/// Component evidence. Not an apply capability or a complete setup assessment.
#[derive(Debug, Clone, PartialEq)]
pub struct ConfigurationPlan {
    /// Visible actions, in provision order.
    pub configuration: Vec<ConfigurationSetupAssessment>,
    /// Proposed source only when applicable and changed. Commit with packs and
    /// contribution receipts in the enclosing setup transaction, never alone.
    pub document: Option<String>,
    /// Exact prior source digest, including absence.
    pub source_digest: Option<Hash>,
    /// Binds actual declarations and source/result bytes; no caller digest trust.
    pub assessment_digest: Hash,
}
impl ConfigurationPlan {
    /// Whether all component clauses are conflict-free.
    pub fn applicable(&self) -> bool {
        self.configuration.iter().all(|a| a.conflict.is_none())
    }
}

fn issue(code: &str, detail: &'static str) -> Box<Issue> {
    Box::new(Issue::new(code, Severity::Error, Tier::Request, detail))
}
fn invalid() -> Box<Issue> {
    issue(
        "invalid_collection_setup",
        "invalid configuration declaration",
    )
}
fn limit() -> Box<Issue> {
    issue(
        "collection_setup_limit_exceeded",
        "configuration component limit exceeded",
    )
}
fn scalar(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(_) | Value::Int(_) | Value::Text(_) => true,
        Value::Float(f) => f.is_finite(),
        _ => false,
    }
}
fn identifier(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id.as_bytes()[0].is_ascii_lowercase()
        && id.split('-').all(|s| {
            !s.is_empty()
                && s.bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        })
}
fn pointer(path: &str) -> Result<Vec<String>, Box<Issue>> {
    if path.len() > 1024 || !path.starts_with('/') {
        return Err(invalid());
    }
    let mut segments = Vec::new();
    for encoded in path[1..].split('/') {
        if segments.len() == 16 {
            return Err(invalid());
        }
        let mut decoded = String::new();
        let mut chars = encoded.chars();
        while let Some(c) = chars.next() {
            decoded.push(if c == '~' {
                match chars.next() {
                    Some('0') => '~',
                    Some('1') => '/',
                    _ => return Err(invalid()),
                }
            } else {
                c
            });
        }
        if decoded.is_empty()
            || decoded == "-"
            || decoded.bytes().all(|b| b.is_ascii_digit())
            || decoded.chars().any(char::is_control)
        {
            return Err(invalid());
        }
        segments.push(decoded);
    }
    if segments.len() < 2 {
        return Err(invalid());
    }
    let namespace = &segments[0];
    let extension = namespace.strip_prefix("x-").is_some_and(|rest| {
        !rest.is_empty()
            && rest.as_bytes()[0].is_ascii_alphanumeric()
            && rest
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    });
    if !extension && path != "/settings/record_extensions" {
        return Err(invalid());
    }
    Ok(segments)
}
fn scalar_bytes(value: &Value) -> usize {
    value.as_str().map_or(0, str::len)
}
impl ConfigurationDeclaration {
    /// Validate public mutable inputs at every planning call, before cloning.
    pub fn validate(&self) -> Result<(), Box<Issue>> {
        if self.requirements.len() > MAX_CLAUSES || self.provisions.len() > MAX_CLAUSES {
            return Err(limit());
        }
        let mut bytes = 0usize;
        let mut requirements = BTreeMap::new();
        for r in &self.requirements {
            bytes = bytes
                .saturating_add(r.id.len())
                .saturating_add(r.path.len())
                .saturating_add(scalar_bytes(&r.value));
            if bytes > MAX_DECLARATION_BYTES {
                return Err(limit());
            }
            if !identifier(&r.id) || !scalar(&r.value) || requirements.insert(&r.id, r).is_some() {
                return Err(invalid());
            }
            pointer(&r.path)?;
            if r.path == "/settings/record_extensions"
                && !r.value.as_str().is_some_and(|s| {
                    !s.is_empty()
                        && s.as_bytes()[0].is_ascii_alphanumeric()
                        && s.bytes().all(|b| {
                            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'_' | b'-')
                        })
                })
            {
                return Err(invalid());
            }
        }
        let mut linked = BTreeSet::new();
        for p in &self.provisions {
            bytes = bytes
                .saturating_add(p.requirement.len())
                .saturating_add(p.path.len())
                .saturating_add(scalar_bytes(&p.value));
            if bytes > MAX_DECLARATION_BYTES {
                return Err(limit());
            }
            if !scalar(&p.value) {
                return Err(invalid());
            }
            let r = requirements.get(&p.requirement).ok_or_else(invalid)?;
            if r.path != p.path || r.value != p.value || !linked.insert(&p.requirement) {
                return Err(invalid());
            }
        }
        if linked.len() != requirements.len() {
            return Err(invalid());
        }
        Ok(())
    }
    /// Canonical declaration input for enclosing setup digests.
    pub fn to_value(&self) -> Value {
        object([
            (
                "requirements",
                Value::List(
                    self.requirements
                        .iter()
                        .map(|r| {
                            object([
                                ("id", Value::string(r.id.clone())),
                                ("path", Value::string(r.path.clone())),
                                ("predicate", Value::string("contains")),
                                ("value", r.value.clone()),
                            ])
                        })
                        .collect(),
                ),
            ),
            (
                "provisions",
                Value::List(
                    self.provisions
                        .iter()
                        .map(|p| {
                            object([
                                ("requirement", Value::string(p.requirement.clone())),
                                ("path", Value::string(p.path.clone())),
                                ("operation", Value::string("set_add")),
                                ("value", p.value.clone()),
                            ])
                        })
                        .collect(),
                ),
            ),
        ])
    }
    /// Decode the catalog configuration block. Unknown fields/operations refuse.
    pub fn from_value(value: &Value) -> Result<Self, Box<Issue>> {
        let root = members(value, &["requirements", "provisions"])?;
        let reqs = root
            .get("requirements")
            .and_then(Value::as_list)
            .ok_or_else(invalid)?;
        let provs = root
            .get("provisions")
            .and_then(Value::as_list)
            .ok_or_else(invalid)?;
        if reqs.len() > MAX_CLAUSES || provs.len() > MAX_CLAUSES {
            return Err(limit());
        }
        // Preflight borrowed strings and scalar shapes before any owned clone.
        let mut bytes = 0usize;
        for v in reqs.iter().chain(provs) {
            let m = v.as_map().ok_or_else(invalid)?;
            for (key, value) in m.iter() {
                if !scalar(value) {
                    return Err(invalid());
                }
                bytes = bytes
                    .saturating_add(key.len())
                    .saturating_add(scalar_bytes(value));
                if bytes > MAX_DECLARATION_BYTES {
                    return Err(limit());
                }
            }
        }
        let mut result = Self::default();
        for v in reqs {
            let m = members(v, &["id", "path", "predicate", "value"])?;
            if text(m, "predicate")? != "contains" {
                return Err(invalid());
            }
            result.requirements.push(ConfigurationRequirement {
                id: text(m, "id")?.to_owned(),
                path: text(m, "path")?.to_owned(),
                predicate: ConfigurationPredicate::Contains,
                value: m.get("value").ok_or_else(invalid)?.clone(),
            });
        }
        for v in provs {
            let m = members(v, &["requirement", "path", "operation", "value"])?;
            if text(m, "operation")? != "set_add" {
                return Err(invalid());
            }
            result.provisions.push(ConfigurationProvision {
                requirement: text(m, "requirement")?.to_owned(),
                path: text(m, "path")?.to_owned(),
                operation: ConfigurationOperation::SetAdd,
                value: m.get("value").ok_or_else(invalid)?.clone(),
            });
        }
        result.validate()?;
        Ok(result)
    }
}
fn members<'a>(v: &'a Value, keys: &[&str]) -> Result<&'a Map, Box<Issue>> {
    let m = v.as_map().ok_or_else(invalid)?;
    if m.len() != keys.len() || keys.iter().any(|k| !m.contains_key(k)) {
        return Err(invalid());
    }
    Ok(m)
}
fn text<'a>(m: &'a Map, key: &str) -> Result<&'a str, Box<Issue>> {
    m.get(key).and_then(Value::as_str).ok_or_else(invalid)
}
fn object<const N: usize>(pairs: [(&str, Value); N]) -> Value {
    Value::Map(pairs.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
}
fn conflict(path: &str, intermediate: bool, v: &Value) -> ConfigurationConflict {
    ConfigurationConflict {
        code: if intermediate {
            "configuration_path_conflict"
        } else {
            "configuration_type_conflict"
        },
        path: path.to_owned(),
        expected: if intermediate { "object" } else { "array" },
        observed: v.type_name(),
    }
}
fn sequence<'a>(
    root: &'a Map,
    path: &str,
    segments: &[String],
) -> Result<Option<&'a [Value]>, ConfigurationConflict> {
    let mut m = root;
    for (index, key) in segments.iter().enumerate() {
        let Some(v) = m.get(key) else {
            return Ok(None);
        };
        if index + 1 == segments.len() {
            return v
                .as_list()
                .map(Some)
                .ok_or_else(|| conflict(path, false, v));
        }
        m = v.as_map().ok_or_else(|| conflict(path, true, v))?;
    }
    Ok(None)
}
fn append(
    root: &mut Map,
    segments: &[String],
    value: &Value,
    initial: Vec<Value>,
) -> Result<(), Box<Issue>> {
    let (first, rest) = segments.split_first().ok_or_else(invalid)?;
    if rest.is_empty() {
        if !root.contains_key(first) {
            root.insert(first.clone(), Value::List(initial));
        }
        match root.get_mut(first) {
            Some(Value::List(values)) => {
                values.push(value.clone());
                Ok(())
            }
            _ => Err(invalid()),
        }
    } else {
        if !root.contains_key(first) {
            root.insert(first.clone(), Value::Map(Map::new()));
        }
        match root.get_mut(first) {
            Some(Value::Map(m)) => append(m, rest, value, initial),
            _ => Err(invalid()),
        }
    }
}

/// Plan the configuration component without I/O. Any conflict suppresses the
/// proposed document; inputs are immutable and failures contain no observed data.
pub fn plan_configuration(
    source: Option<&str>,
    declaration: &ConfigurationDeclaration,
) -> Result<ConfigurationPlan, Box<Issue>> {
    declaration.validate()?;
    let src = source.unwrap_or("");
    if src.len() > MAX_CONFIG_BYTES {
        return Err(limit());
    }
    let (parsed, _) = crate::yaml::parse_value_bounded(src).map_err(|e| {
        if matches!(e.kind, crate::yaml::ErrorKind::ResourceLimit(_)) {
            limit()
        } else {
            issue(
                "configuration_type_conflict",
                "configuration must be a valid YAML mapping",
            )
        }
    })?;
    let mut root = match parsed {
        Some(Value::Map(m)) => m,
        None => Map::new(),
        _ => {
            return Err(issue(
                "configuration_type_conflict",
                "configuration must be a mapping",
            ));
        }
    };
    let original = root.clone();
    let mut actions = Vec::new();
    let mut blocked = false;
    for p in &declaration.provisions {
        let segments = pointer(&p.path)?;
        let mut a = ConfigurationSetupAssessment {
            requirement: p.requirement.clone(),
            path: p.path.clone(),
            value: p.value.clone(),
            action: "current",
            conflict: None,
        };
        match sequence(&root, &p.path, &segments) {
            Err(c) => {
                blocked = true;
                a.action = "conflict";
                a.conflict = Some(c);
            }
            Ok(found) => {
                let defaults: Vec<Value> =
                    if found.is_none() && p.path == "/settings/record_extensions" {
                        Settings::default()
                            .record_extensions
                            .into_iter()
                            .map(Value::string)
                            .collect()
                    } else {
                        Vec::new()
                    };
                let values = found.unwrap_or(&defaults);
                if !values.contains(&p.value) {
                    a.action = "add";
                    append(&mut root, &segments, &p.value, defaults)?;
                }
            }
        }
        actions.push(a);
    }
    let mut document = None;
    if !blocked && root != original {
        // An absent resource uses Core defaults. Materializing it must also
        // include the fixed supported spec version; never repair/replace an
        // existing resource's version through a configuration provision.
        if source.is_none() {
            let version = crate::types::SUPPORTED_SPEC_VERSIONS
                .first()
                .ok_or_else(invalid)?;
            root.insert("spec_version", Value::string(*version));
        }
        let changes: Vec<_> = root
            .iter()
            .filter(|(k, v)| original.get(k) != Some(*v))
            .map(|(k, v)| (k.to_owned(), Change::Set(v.clone())))
            .collect();
        let d = Document::parse(src, RecordFormat::YamlDocument);
        let rendered = writer::write(&d, &changes, None).map_err(|_| {
            issue(
                "invalid_collection_setup",
                "configuration could not be rendered",
            )
        })?;
        if rendered.len() > MAX_CONFIG_BYTES {
            return Err(limit());
        }
        document = Some(rendered);
    }
    let source_digest = source.map(revision);
    let digest = jcs_digest(&object([
        (
            "profile",
            Value::string("collection-setup-configuration-v1"),
        ),
        ("declaration", declaration.to_value()),
        (
            "source",
            source_digest.map_or(Value::Null, |h| Value::string(h.to_string())),
        ),
        (
            "result",
            document
                .as_deref()
                .map_or(Value::Null, |s| Value::string(revision(s).to_string())),
        ),
    ]));
    Ok(ConfigurationPlan {
        configuration: actions,
        document,
        source_digest,
        assessment_digest: digest,
    })
}

pub(crate) mod witness;

#[cfg(test)]
mod tests;
