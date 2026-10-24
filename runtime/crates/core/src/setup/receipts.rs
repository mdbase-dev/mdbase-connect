//! Configuration contribution ledger component. Contributions are shared, not
//! pack-owned resources: adding a contributor never subtracts another or changes
//! configuration. Commit this ledger only with the complete setup transaction.
//! Ported from mdbase-rs v03/collection_setup.rs; see LICENSE.port.

use super::configuration::{
    ConfigurationDeclaration, ConfigurationOperation, ConfigurationPredicate,
    ConfigurationProvision, ConfigurationRequirement,
};
use crate::contracts::jcs;
use crate::ids::Hash;
use crate::validate::{Issue, Severity, Tier};
use crate::value::{Map, Value};
use std::collections::BTreeSet;

/// Historical contribution lock path; a resource when the installer is wired.
pub const PROVISION_LOCK_PATH: &str = crate::types::PROVISION_LOCK_PATH;
/// Immutable source/result capacity.
pub const MAX_RECEIPT_BYTES: usize = 1_048_576;
/// Maximum distinct path/scalar contribution groups.
pub const MAX_CONTRIBUTIONS: usize = 1_024;
/// Maximum contributor versions across the complete ledger.
pub const MAX_CONTRIBUTORS: usize = 4_096;

/// One exact declaration/provision version's contribution, not ownership.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Contributor {
    /// Stable installer/application identity.
    pub application_id: String,
    /// Publisher's declaration identity, separately bound to actual setup inputs.
    pub declaration_digest: Hash,
    /// Digest of the actual enclosing setup provision.
    pub provision_digest: Hash,
    /// Exact requirement ID.
    pub requirement: String,
}
/// One shared scalar sequence contribution.
#[derive(Debug, Clone, PartialEq)]
pub struct Contribution {
    /// Approved declaration pointer.
    pub path: String,
    /// Public declared scalar, never an observed private configuration value.
    pub value: Value,
    /// All exact contributing versions; no implicit uninstall subtraction.
    pub contributors: Vec<Contributor>,
}
/// Version-one contribution ledger. Public fields are revalidated at every use.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ProvisionLock {
    /// Distinct path/canonical-scalar groups.
    pub contributions: Vec<Contribution>,
}
fn bad() -> Box<Issue> {
    Box::new(Issue::new(
        "invalid_collection_setup",
        Severity::Error,
        Tier::Request,
        "invalid configuration contribution ledger",
    ))
}
fn limit() -> Box<Issue> {
    Box::new(Issue::new(
        "collection_setup_limit_exceeded",
        Severity::Error,
        Tier::Request,
        "configuration contribution ledger limit exceeded",
    ))
}
fn identity(s: &str) -> bool {
    (3..=150).contains(&s.len())
        && s.as_bytes()[0].is_ascii_lowercase()
        && s.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-')
        })
        && s.contains(['.', '_', '-'])
        && !s.ends_with(['.', '_', '-'])
        && !s.contains("..")
}
fn clause(path: &str, value: &Value, requirement: &str) -> Result<(), Box<Issue>> {
    if path.len() > 1_024 || requirement.len() > 128 {
        return Err(bad());
    }
    if matches!(value, Value::Text(s) if s.len() > super::configuration::MAX_DECLARATION_BYTES) {
        return Err(limit());
    }
    if !matches!(
        value,
        Value::Null | Value::Bool(_) | Value::Int(_) | Value::Float(_) | Value::Text(_)
    ) {
        return Err(bad());
    }
    ConfigurationDeclaration {
        requirements: vec![ConfigurationRequirement {
            id: requirement.into(),
            path: path.into(),
            predicate: ConfigurationPredicate::Contains,
            value: value.clone(),
        }],
        provisions: vec![ConfigurationProvision {
            requirement: requirement.into(),
            operation: ConfigurationOperation::SetAdd,
            path: path.into(),
            value: value.clone(),
        }],
    }
    .validate()
}
fn closed(m: &Map, keys: &[&str]) -> Result<(), Box<Issue>> {
    if m.len() != keys.len() || m.keys().any(|k| !keys.contains(&k)) {
        Err(bad())
    } else {
        Ok(())
    }
}
fn text<'a>(m: &'a Map, key: &str) -> Result<&'a str, Box<Issue>> {
    m.get(key).and_then(Value::as_str).ok_or_else(bad)
}
fn hash(m: &Map, key: &str) -> Result<Hash, Box<Issue>> {
    let s = text(m, key)?;
    if s.len() != 71
        || !s.starts_with("sha256:")
        || !s[7..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(bad());
    }
    Hash::parse(s).ok_or_else(bad)
}
impl ProvisionLock {
    /// Strict, bounded YAML/JSON decode with private-safe diagnostics.
    pub fn parse(source: &str) -> Result<Self, Box<Issue>> {
        if source.len() > MAX_RECEIPT_BYTES {
            return Err(limit());
        }
        let (Some(Value::Map(m)), _) =
            crate::yaml::parse_value_bounded(source).map_err(|_| bad())?
        else {
            return Err(bad());
        };
        closed(&m, &["kind", "lock_version", "contributions"])?;
        if text(&m, "kind")? != "mdbase.provision-lock"
            || m.get("lock_version") != Some(&Value::Int(1))
        {
            return Err(bad());
        }
        let entries = m
            .get("contributions")
            .and_then(Value::as_list)
            .ok_or_else(bad)?;
        if entries.len() > MAX_CONTRIBUTIONS {
            return Err(limit());
        }
        let mut lock = Self::default();
        let mut count = 0usize;
        for entry in entries {
            let e = entry.as_map().ok_or_else(bad)?;
            closed(e, &["path", "value", "contributors"])?;
            let values = e
                .get("contributors")
                .and_then(Value::as_list)
                .ok_or_else(bad)?;
            count = count.checked_add(values.len()).ok_or_else(limit)?;
            if count > MAX_CONTRIBUTORS {
                return Err(limit());
            }
            let mut contributors = Vec::new();
            for value in values {
                let c = value.as_map().ok_or_else(bad)?;
                closed(
                    c,
                    &[
                        "application_id",
                        "declaration_digest",
                        "provision_digest",
                        "requirement",
                    ],
                )?;
                contributors.push(Contributor {
                    application_id: text(c, "application_id")?.into(),
                    declaration_digest: hash(c, "declaration_digest")?,
                    provision_digest: hash(c, "provision_digest")?,
                    requirement: text(c, "requirement")?.into(),
                });
            }
            lock.contributions.push(Contribution {
                path: text(e, "path")?.into(),
                value: e.get("value").ok_or_else(bad)?.clone(),
                contributors,
            });
        }
        lock.validate()?;
        Ok(lock)
    }
    /// Validate mutable typed inputs before cloning, rendering or adding entries.
    pub fn validate(&self) -> Result<(), Box<Issue>> {
        if self.contributions.len() > MAX_CONTRIBUTIONS {
            return Err(limit());
        }
        let mut groups = BTreeSet::new();
        let mut count = 0usize;
        let mut bytes = 0usize;
        for entry in &self.contributions {
            bytes = bytes.checked_add(entry.path.len()).ok_or_else(limit)?;
            if let Value::Text(s) = &entry.value {
                bytes = bytes.checked_add(s.len()).ok_or_else(limit)?;
            }
            count = count
                .checked_add(entry.contributors.len())
                .ok_or_else(limit)?;
            if count > MAX_CONTRIBUTORS || bytes > MAX_RECEIPT_BYTES {
                return Err(limit());
            }
            if entry.contributors.is_empty() {
                return Err(bad());
            }
            clause(&entry.path, &entry.value, "receipt")?;
            if !groups.insert((&entry.path, jcs(&entry.value))) {
                return Err(bad());
            }
            let mut contributors = BTreeSet::new();
            for contributor in &entry.contributors {
                bytes = bytes
                    .checked_add(contributor.application_id.len())
                    .and_then(|n| n.checked_add(contributor.requirement.len()))
                    .ok_or_else(limit)?;
                if bytes > MAX_RECEIPT_BYTES {
                    return Err(limit());
                }
                if !identity(&contributor.application_id) || !contributors.insert(contributor) {
                    return Err(bad());
                }
                clause(&entry.path, &entry.value, &contributor.requirement)?;
            }
        }
        Ok(())
    }
    /// Add one exact contributor version idempotently. Historical versions and
    /// all other applications remain. Failure leaves this lock unchanged.
    pub fn contribute(
        &mut self,
        path: &str,
        value: &Value,
        contributor: Contributor,
    ) -> Result<bool, Box<Issue>> {
        self.validate()?;
        if !identity(&contributor.application_id) {
            return Err(bad());
        }
        clause(path, value, &contributor.requirement)?;
        let key = jcs(value);
        let index = self
            .contributions
            .iter()
            .position(|e| e.path == path && jcs(&e.value) == key);
        if index.is_some_and(|i| self.contributions[i].contributors.contains(&contributor)) {
            return Ok(false);
        }
        let mut next = self.clone();
        if let Some(i) = index {
            next.contributions[i].contributors.push(contributor);
        } else {
            next.contributions.push(Contribution {
                path: path.into(),
                value: value.clone(),
                contributors: vec![contributor],
            });
        }
        next.validate()?;
        *self = next;
        Ok(true)
    }
    /// Canonical ledger value, sorted independently of insertion order.
    pub fn to_value(&self) -> Result<Value, Box<Issue>> {
        self.validate()?;
        let mut entries: Vec<_> = self.contributions.iter().collect();
        entries.sort_by_key(|e| (&e.path, jcs(&e.value)));
        let mut root = Map::new();
        root.insert("kind", Value::string("mdbase.provision-lock"));
        root.insert("lock_version", Value::Int(1));
        root.insert(
            "contributions",
            Value::List(
                entries
                    .into_iter()
                    .map(|e| {
                        let mut contributors: Vec<_> = e.contributors.iter().collect();
                        contributors.sort_by_key(|c| {
                            (
                                &c.application_id,
                                &c.requirement,
                                c.declaration_digest,
                                c.provision_digest,
                            )
                        });
                        let mut entry = Map::new();
                        entry.insert("path", Value::string(e.path.clone()));
                        entry.insert("value", e.value.clone());
                        entry.insert(
                            "contributors",
                            Value::List(
                                contributors
                                    .into_iter()
                                    .map(|c| {
                                        let mut m = Map::new();
                                        m.insert(
                                            "application_id",
                                            Value::string(c.application_id.clone()),
                                        );
                                        m.insert(
                                            "declaration_digest",
                                            Value::string(c.declaration_digest.to_string()),
                                        );
                                        m.insert(
                                            "provision_digest",
                                            Value::string(c.provision_digest.to_string()),
                                        );
                                        m.insert(
                                            "requirement",
                                            Value::string(c.requirement.clone()),
                                        );
                                        Value::Map(m)
                                    })
                                    .collect(),
                            ),
                        );
                        Value::Map(entry)
                    })
                    .collect(),
            ),
        );
        Ok(Value::Map(root))
    }
    /// JSON is valid YAML; exact deterministic output, never parser text.
    pub fn render(&self) -> Result<String, Box<Issue>> {
        let mut source = self.to_value()?.to_json();
        source.push('\n');
        if source.len() > MAX_RECEIPT_BYTES {
            return Err(limit());
        }
        Ok(source)
    }
}
