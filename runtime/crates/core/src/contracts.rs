//! Data contracts (spec 05A): the contract registry, type implementations,
//! contract views and stable digests.
//!
//! [`crate::types::Catalog`] loads contracts from the contracts folder,
//! resolves every type `implements` entry to one exact contract version, and
//! validates it. Applications discover implementations with
//! [`crate::types::Catalog::implementations_of`] and read a record through a
//! contract with [`Implementation::view`].

// Diagnostics are the cold path; boxing them would only complicate callers.
#![allow(clippy::result_large_err)]

use std::cmp::Ordering;
use std::collections::BTreeMap;

use crate::doc::{Document, RecordFormat};
use crate::ids::Hash;
use crate::types::{TypeDef, parse_field_ref, select_one, top_level_field};
use crate::validate::{Issue, Severity, Tier};
use crate::value::{Map, Value};

// ------------------------------------------------------------- JCS digests

/// RFC 8785 JSON Canonicalization Scheme text of `v`: object keys sorted by
/// UTF-16 code units, numbers per ECMAScript, minimal string escapes.
pub fn jcs(v: &Value) -> String {
    let mut out = String::new();
    write_jcs(v, &mut out);
    out
}

fn write_jcs(v: &Value, out: &mut String) {
    match v {
        Value::Map(m) => {
            let mut keys: Vec<&str> = m.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            out.push('{');
            for (i, k) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                crate::value::write_json_string(out, k);
                out.push(':');
                if let Some(x) = m.get(k) {
                    write_jcs(x, out);
                }
            }
            out.push('}');
        }
        Value::List(l) => {
            out.push('[');
            for (i, x) in l.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_jcs(x, out);
            }
            out.push(']');
        }
        other => out.push_str(&other.to_json()),
    }
}

/// `sha256:` digest of the JCS bytes of `v`.
pub fn jcs_digest(v: &Value) -> Hash {
    Hash::of(jcs(v).as_bytes())
}

// ------------------------------------------------------------------ semver

/// A SemVer 2.0.0 version (build metadata dropped).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version {
    /// Major.
    pub major: u64,
    /// Minor.
    pub minor: u64,
    /// Patch.
    pub patch: u64,
    /// Pre-release identifiers.
    pub pre: Vec<String>,
}

impl Version {
    /// Parse `1.2.3`, `1.2.3-rc.1`, `1.2.3+build`.
    pub fn parse(s: &str) -> Option<Version> {
        let s = s.split_once('+').map_or(s, |(v, _)| v);
        let (core, pre) = match s.split_once('-') {
            Some((c, p)) => (c, p.split('.').map(str::to_owned).collect::<Vec<_>>()),
            None => (s, Vec::new()),
        };
        if pre.iter().any(|p| p.is_empty()) {
            return None;
        }
        let nums: Vec<u64> = core
            .split('.')
            .map(|n| {
                (!n.is_empty()
                    && n.bytes().all(|b| b.is_ascii_digit())
                    && (n == "0" || !n.starts_with('0')))
                .then(|| n.parse().ok())
                .flatten()
            })
            .collect::<Option<_>>()?;
        let [major, minor, patch] = nums[..] else {
            return None;
        };
        Some(Version {
            major,
            minor,
            patch,
            pre,
        })
    }

    fn bump(major: u64, minor: u64, patch: u64) -> Version {
        // `X.Y.Z-0`: the lowest version with that core.
        Version {
            major,
            minor,
            patch,
            pre: vec!["0".into()],
        }
    }
}

impl std::fmt::Display for Version {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)?;
        if !self.pre.is_empty() {
            write!(f, "-{}", self.pre.join("."))?;
        }
        Ok(())
    }
}

impl Ord for Version {
    fn cmp(&self, o: &Version) -> Ordering {
        (self.major, self.minor, self.patch)
            .cmp(&(o.major, o.minor, o.patch))
            .then_with(|| match (self.pre.is_empty(), o.pre.is_empty()) {
                (true, true) => Ordering::Equal,
                (true, false) => Ordering::Greater,
                (false, true) => Ordering::Less,
                (false, false) => {
                    for (a, b) in self.pre.iter().zip(&o.pre) {
                        let c = match (a.parse::<u64>(), b.parse::<u64>()) {
                            (Ok(x), Ok(y)) => x.cmp(&y),
                            (Ok(_), Err(_)) => Ordering::Less,
                            (Err(_), Ok(_)) => Ordering::Greater,
                            (Err(_), Err(_)) => a.cmp(b),
                        };
                        if c != Ordering::Equal {
                            return c;
                        }
                    }
                    self.pre.len().cmp(&o.pre.len())
                }
            })
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, o: &Version) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}

/// A version requirement (the portable npm-semver subset of spec 05A).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Requirement {
    comparators: Vec<(Ordering, bool, Version)>,
    source: String,
}

impl Requirement {
    /// Parse `1.4.2`, `=1.4.2`, `^1.4.2`, `~1.4.2`, or space-separated
    /// comparators (`>=1.2.0 <2.0.0`).
    pub fn parse(s: &str) -> Option<Requirement> {
        let s = s.trim();
        let mut c = Vec::new();
        if let Some(v) = s.strip_prefix('^') {
            let v = Version::parse(v)?;
            let upper = if v.major > 0 {
                Version::bump(v.major.checked_add(1)?, 0, 0)
            } else if v.minor > 0 {
                Version::bump(0, v.minor.checked_add(1)?, 0)
            } else {
                Version::bump(0, 0, v.patch.checked_add(1)?)
            };
            c.push((Ordering::Greater, true, v));
            c.push((Ordering::Less, false, upper));
        } else if let Some(v) = s.strip_prefix('~') {
            let v = Version::parse(v)?;
            let upper = Version::bump(v.major, v.minor.checked_add(1)?, 0);
            c.push((Ordering::Greater, true, v));
            c.push((Ordering::Less, false, upper));
        } else if !s.contains(' ') && !s.starts_with(['<', '>']) {
            c.push((
                Ordering::Equal,
                true,
                Version::parse(s.strip_prefix('=').unwrap_or(s))?,
            ));
        } else {
            for part in s.split(' ') {
                let (ord, eq, rest) = if let Some(r) = part.strip_prefix(">=") {
                    (Ordering::Greater, true, r)
                } else if let Some(r) = part.strip_prefix("<=") {
                    (Ordering::Less, true, r)
                } else if let Some(r) = part.strip_prefix('>') {
                    (Ordering::Greater, false, r)
                } else if let Some(r) = part.strip_prefix('<') {
                    (Ordering::Less, false, r)
                } else if let Some(r) = part.strip_prefix('=') {
                    (Ordering::Equal, true, r)
                } else {
                    return None;
                };
                c.push((ord, eq, Version::parse(rest)?));
            }
        }
        Some(Requirement {
            comparators: c,
            source: s.to_owned(),
        })
    }

    /// Whether `v` satisfies every comparator.
    pub fn matches(&self, v: &Version) -> bool {
        self.comparators.iter().all(|(ord, eq, bound)| {
            let c = v.cmp(bound);
            c == *ord && *ord != Ordering::Equal || (*eq && c == Ordering::Equal)
        })
    }
}

impl std::fmt::Display for Requirement {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.source)
    }
}

// --------------------------------------------------------------- contracts

/// The schema members digested per `contract_type` (spec 05A).
fn schema_members(contract_type: &str) -> &'static [&'static str] {
    match contract_type {
        "record" => &["record_schema", "binding_schema"],
        "event" => &["data_schema", "source_schema"],
        "action" => &[
            "input_schema",
            "output_schema",
            "error_schema",
            "provider_schema",
        ],
        _ => &[],
    }
}

/// A resolved schema: the document and the entry pointer.
#[derive(Debug, Clone, PartialEq)]
pub struct SchemaSource {
    /// The schema document.
    pub document: Value,
    /// Pointer to the schema in the document.
    pub entry: String,
}

impl SchemaSource {
    /// The schema value itself (the digested form).
    pub fn value(&self) -> Value {
        crate::types::pointer_value(&self.document, &self.entry)
            .cloned()
            .unwrap_or(Value::Null)
    }
}

/// One registered contract version.
#[derive(Debug, Clone, PartialEq)]
pub struct Contract {
    /// `id`.
    pub id: String,
    /// Exact `version`.
    pub version: Version,
    /// `contract_type`: `record`, `event` or `action`.
    pub contract_type: String,
    /// `name`, for display.
    pub name: Option<String>,
    /// Schemas by member (`record_schema`, `binding_schema`, ...).
    pub schemas: BTreeMap<String, SchemaSource>,
    /// The contract digest.
    pub digest: Hash,
    /// The contract file's resource path.
    pub source_path: String,
}

fn issue(code: &str, msg: impl Into<String>, path: &str) -> Issue {
    Issue::new(code, Severity::Error, Tier::Request, msg).at(path)
}

/// Load one contract file.
pub fn load_contract(
    path: &str,
    src: &str,
    resources: &BTreeMap<&str, &str>,
) -> Result<Contract, Issue> {
    let bad = |m: String| issue("invalid_data_contract", m, path);
    let doc = Document::parse(src, RecordFormat::Markdown);
    if doc.problem().is_some() || !doc.has_frontmatter() {
        return Err(bad("contract frontmatter is missing or invalid".into()));
    }
    let fm = doc.frontmatter();
    if fm.get("kind").and_then(Value::as_str) != Some("mdbase.contract") {
        return Err(bad("not a data contract (`kind: mdbase.contract`)".into()));
    }
    let text = |k: &str| fm.get(k).and_then(Value::as_str).map(str::to_owned);
    let id = text("id").ok_or_else(|| bad("`id` is required".into()))?;
    if id.is_empty()
        || id
            .chars()
            .any(|c| c.is_ascii_uppercase() || c.is_whitespace())
    {
        return Err(bad(format!(
            "`{id}` is not a lower-case namespaced identifier"
        )));
    }
    let version = text("version")
        .and_then(|v| Version::parse(&v))
        .ok_or_else(|| bad("`version` must be a semantic version".into()))?;
    let contract_type =
        text("contract_type").ok_or_else(|| bad("`contract_type` is required".into()))?;
    let members = schema_members(&contract_type);
    if members.is_empty() {
        return Err(bad(format!("unknown contract_type `{contract_type}`")));
    }
    let mut schemas = BTreeMap::new();
    for m in members {
        let Some(wrapper) = fm.get(m) else { continue };
        let Value::Map(w) = wrapper else {
            return Err(bad(format!("`{m}` must be a schema wrapper")));
        };
        if w.get("dialect").and_then(Value::as_str) != Some("json-schema-2020-12") {
            return Err(bad(format!("`{m}.dialect` must be json-schema-2020-12")));
        }
        let (document, entry) = match (w.get("value"), w.get("ref")) {
            (Some(v), None) => (v.clone(), String::new()),
            (None, Some(Value::Text(r))) => crate::types::resolve_schema_ref(path, r, resources)
                .map_err(|(code, m)| issue(code, m, path))?,
            _ => return Err(bad(format!("`{m}` needs exactly one of `value` and `ref`"))),
        };
        crate::jsonschema::compile(&document, &entry)
            .map_err(|e| issue(e[0].code, format!("`{m}`: {}", e[0].message), path))?;
        schemas.insert((*m).to_owned(), SchemaSource { document, entry });
    }
    if contract_type == "record" && !schemas.contains_key("record_schema") {
        return Err(bad("a record contract needs `record_schema`".into()));
    }
    let mut digest_obj = Map::new();
    digest_obj.insert("kind", Value::string("mdbase.contract"));
    digest_obj.insert("contract_type", Value::string(contract_type.clone()));
    digest_obj.insert("id", Value::string(id.clone()));
    digest_obj.insert("version", Value::string(version.to_string()));
    for (m, s) in &schemas {
        digest_obj.insert(m.clone(), s.value());
    }
    if contract_type == "action"
        && let Some(b) = fm.get("behavior")
    {
        digest_obj.insert("behavior", b.clone());
    }
    Ok(Contract {
        id,
        version,
        contract_type,
        name: text("name"),
        schemas,
        digest: jcs_digest(&Value::Map(digest_obj)),
        source_path: path.to_owned(),
    })
}

/// A type's resolved, validated implementation of a record contract.
#[derive(Debug, Clone, PartialEq)]
pub struct Implementation {
    /// The implementing type (name as written).
    pub type_name: String,
    /// The contract ID.
    pub contract: String,
    /// The requirement as written.
    pub requirement: String,
    /// The exact version it resolved to.
    pub version: Version,
    /// Contract field reference → record field reference, in order.
    pub fields: Vec<(String, String)>,
    /// `binding` (empty when omitted).
    pub binding: Map,
    /// The resolved contract's digest.
    pub contract_digest: Hash,
    /// The implementation digest (spec 05A "Stable Digests").
    pub digest: Hash,
}

/// The implementation digest object's `type` member.
fn type_digest_value(t: &TypeDef) -> Value {
    let mut m = Map::new();
    m.insert("name", Value::string(t.name.clone()));
    if let Some(v) = t.raw.get("version") {
        m.insert("version", v.clone());
    }
    if let Some(v) = t.raw.get("match") {
        m.insert("match", v.clone());
    }
    // The type's `schema` member as written (the wrapper), as the spec's
    // reference implementation and fixture digest have it. Spec 05A's prose
    // could be read as the resolved schema; see docs/spec-notes.md.
    if let Some(v) = t.raw.get("schema") {
        m.insert("schema", v.clone());
    }
    if let Some(Value::Map(c)) = t.raw.get("collection") {
        let mut c = c.clone();
        c.remove("display");
        m.insert("collection", Value::Map(c));
    }
    if let Some(v) = t.raw.get("lifecycle") {
        m.insert("lifecycle", v.clone());
    }
    Value::Map(m)
}

/// The implementation digest of `entry` (an `implements` item of `t`)
/// against `contract`.
pub fn implementation_digest(contract: &Contract, t: &TypeDef, entry: &Value) -> Hash {
    let mut m = Map::new();
    m.insert(
        "contract_digest",
        Value::string(contract.digest.to_string()),
    );
    m.insert("type", type_digest_value(t));
    m.insert("implementation", entry.clone());
    jcs_digest(&Value::Map(m))
}

/// The highest registered version of `id` satisfying `req`.
pub fn resolve<'a>(contracts: &'a [Contract], id: &str, req: &Requirement) -> Option<&'a Contract> {
    contracts
        .iter()
        .filter(|c| c.id == id && req.matches(&c.version))
        .max_by(|a, b| a.version.cmp(&b.version))
}

/// Top-level property names a schema declares (following local refs).
fn declared(doc: &Value, entry: &str) -> Vec<String> {
    crate::jsonschema::compile(doc, entry)
        .map(|c| c.top_level_properties())
        .unwrap_or_default()
}

/// Resolve and validate every `implements` entry of `t` (spec 05A "Type
/// Implementations"). Valid implementations are returned; problems are
/// pushed to `issues`.
pub fn implementations_of_type(
    t: &TypeDef,
    contracts: &[Contract],
    issues: &mut Vec<Issue>,
) -> Vec<Implementation> {
    let Some(entries) = t.raw.get("implements") else {
        return Vec::new();
    };
    let at = |code: &str, m: String| issue(code, m, &t.source_path).with_type(&t.name);
    let Some(entries) = entries.as_list() else {
        issues.push(at(
            "data_contract_field_invalid",
            "`implements` must be a list".into(),
        ));
        return Vec::new();
    };
    let mut out: Vec<Implementation> = Vec::new();
    let mut seen: Vec<&str> = Vec::new();
    for entry in entries {
        let Some(id) = entry.get("contract").and_then(Value::as_str) else {
            issues.push(at(
                "data_contract_field_invalid",
                "an implementation needs `contract`".into(),
            ));
            continue;
        };
        if seen.contains(&id) {
            issues.push(at(
                "data_contract_conflict",
                format!("type `{}` implements `{id}` more than once", t.name),
            ));
            continue;
        }
        seen.push(id);
        let req_src = entry.get("version").and_then(Value::as_str).unwrap_or("");
        let Some(req) = Requirement::parse(req_src) else {
            issues.push(at(
                "data_contract_version_mismatch",
                format!("`{req_src}` is not a portable version requirement"),
            ));
            continue;
        };
        if !contracts.iter().any(|c| c.id == id) {
            issues.push(at(
                "data_contract_not_found",
                format!("no contract `{id}` is registered"),
            ));
            continue;
        }
        let Some(contract) = resolve(contracts, id, &req) else {
            issues.push(at(
                "data_contract_version_mismatch",
                format!("no version of `{id}` satisfies `{req_src}`"),
            ));
            continue;
        };
        match validate_implementation(contract, t, entry) {
            Ok(imp) => out.push(imp),
            Err(mut errs) => issues.append(&mut errs),
        }
    }
    out
}

/// Validate one `implements` entry of `t` against `contract`.
pub fn validate_implementation(
    contract: &Contract,
    t: &TypeDef,
    entry: &Value,
) -> Result<Implementation, Vec<Issue>> {
    let at = |code: &str, m: String| {
        issue(code, m, &t.source_path)
            .with_type(&t.name)
            .with_details(Value::Map(
                [
                    ("contract".to_owned(), Value::string(contract.id.clone())),
                    (
                        "version".to_owned(),
                        Value::string(contract.version.to_string()),
                    ),
                ]
                .into_iter()
                .collect(),
            ))
    };
    let mut errs = Vec::new();
    if contract.contract_type != "record" {
        return Err(vec![at(
            "data_contract_field_invalid",
            format!(
                "a type can implement only a record contract, not `{}`",
                contract.contract_type
            ),
        )]);
    }
    let record_schema = &contract.schemas["record_schema"];
    let contract_fields = declared(&record_schema.document, &record_schema.entry);
    let type_fields = declared(&t.schema_document, &t.schema_entry);
    let mut fields = Vec::new();
    match entry.get("fields") {
        Some(Value::Map(m)) => {
            for (cf, rf) in m.iter() {
                let Some(rf) = rf.as_str() else {
                    errs.push(at(
                        "data_contract_field_invalid",
                        format!("mapping of `{cf}` must be a field reference"),
                    ));
                    continue;
                };
                let first = |r: &str| -> Option<String> {
                    let steps = parse_field_ref(r)?;
                    match steps.first()? {
                        crate::types::FieldStep::Key(k) => Some(k.clone()),
                        crate::types::FieldStep::Index(i) => Some(i.to_string()),
                        crate::types::FieldStep::Each => None,
                    }
                };
                match first(cf) {
                    Some(k) if contract_fields.contains(&k) => {}
                    _ => errs.push(at(
                        "data_contract_field_invalid",
                        format!("contract field is not declared by the contract: `{cf}`"),
                    )),
                }
                match first(rf) {
                    Some(k) if type_fields.contains(&k) => {}
                    _ => errs.push(at(
                        "data_contract_field_invalid",
                        format!("record field is not declared by type `{}`: `{rf}`", t.name),
                    )),
                }
                fields.push((cf.to_owned(), rf.to_owned()));
            }
        }
        None => {}
        Some(_) => errs.push(at(
            "data_contract_field_invalid",
            "`fields` must be a mapping".into(),
        )),
    }
    // Every unconditionally required contract field is mapped.
    if let Some(Value::List(req)) = record_schema.value().get("required") {
        for r in req.iter().filter_map(Value::as_str) {
            let mapped = fields
                .iter()
                .any(|(cf, _)| top_level_field(cf).as_deref() == Some(r));
            if !mapped {
                errs.push(at(
                    "data_contract_field_invalid",
                    format!("required contract field `{r}` is not mapped"),
                ));
            }
        }
    }
    let binding = match entry.get("binding") {
        None => Map::new(),
        Some(Value::Map(b)) => b.clone(),
        Some(_) => {
            errs.push(at(
                "data_contract_binding_invalid",
                "`binding` must be a mapping".into(),
            ));
            Map::new()
        }
    };
    match contract.schemas.get("binding_schema") {
        Some(s) => {
            if let Ok(c) = crate::jsonschema::compile(&s.document, &s.entry) {
                for i in c.validate(&Value::Map(binding.clone())) {
                    errs.push(at(
                        "data_contract_binding_invalid",
                        format!("binding: {} at `{}`", i.message, i.instance_path),
                    ));
                }
            }
        }
        None if !binding.is_empty() => errs.push(at(
            "data_contract_binding_invalid",
            "binding given, but the contract has no binding_schema".into(),
        )),
        None => {}
    }
    if !errs.is_empty() {
        return Err(errs);
    }
    Ok(Implementation {
        type_name: t.name.clone(),
        contract: contract.id.clone(),
        requirement: entry
            .get("version")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned(),
        version: contract.version.clone(),
        fields,
        binding,
        contract_digest: contract.digest,
        digest: implementation_digest(contract, t, entry),
    })
}

impl Implementation {
    /// The contract view of a record (spec 05A "Contract Views"): each mapped
    /// value copied from the effective frontmatter to its contract field;
    /// missing optional values stay missing. The view is validated against
    /// the contract's `record_schema`; failures are
    /// `data_contract_record_invalid`.
    pub fn view(&self, contract: &Contract, effective: &Map) -> Result<Map, Vec<Issue>> {
        let mut view = Map::new();
        for (cf, rf) in &self.fields {
            if let Some(v) = select_one(effective, rf) {
                crate::lifecycle::set_field(&mut view, cf, Some(v.clone())).map_err(|m| {
                    vec![Issue::new(
                        "data_contract_field_invalid",
                        Severity::Error,
                        Tier::SingleRecord,
                        m,
                    )]
                })?;
            }
        }
        let s = &contract.schemas["record_schema"];
        let issues: Vec<Issue> = crate::jsonschema::compile(&s.document, &s.entry)
            .map(|c| c.validate(&Value::Map(view.clone())))
            .unwrap_or_default()
            .into_iter()
            .map(|i| {
                Issue::new(
                    "data_contract_record_invalid",
                    Severity::Error,
                    Tier::SingleRecord,
                    format!("contract `{}` record view: {}", self.contract, i.message),
                )
                .at(i.instance_path)
                .with_type(&self.type_name)
            })
            .collect();
        if issues.is_empty() {
            Ok(view)
        } else {
            Err(issues)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semver_requirements() {
        let v = |s| Version::parse(s).unwrap();
        let r = |s| Requirement::parse(s).unwrap();
        assert!(r("^1.4.2").matches(&v("1.9.0")));
        assert!(!r("^1.4.2").matches(&v("2.0.0-0")));
        assert!(r("^1.4.2").matches(&v("1.5.0-beta")));
        assert!(r("^0.4.2").matches(&v("0.4.9")) && !r("^0.4.2").matches(&v("0.5.0")));
        assert!(r("^0.0.4").matches(&v("0.0.4")) && !r("^0.0.4").matches(&v("0.0.5")));
        assert!(r("~1.4.2").matches(&v("1.4.9")) && !r("~1.4.2").matches(&v("1.5.0")));
        assert!(r(">=1.2.0 <2.0.0").matches(&v("1.2.0")));
        assert!(!r(">=1.2.0 <2.0.0").matches(&v("2.0.0")));
        assert!(r("=1.0.0").matches(&v("1.0.0+build")));
        assert!(v("1.0.0-alpha") < v("1.0.0-alpha.1"));
        assert!(v("1.0.0-alpha.1") < v("1.0.0-beta"));
        assert!(v("1.0.0-rc.1") < v("1.0.0"));
        assert!(Requirement::parse("1.x").is_none());
        assert!(Requirement::parse("^1.0.0 || ^2.0.0").is_none());
    }

    #[test]
    fn requirement_upper_bounds_never_overflow() {
        // Every caret/tilde increment is checked; malformed remotely supplied
        // resource versions must behave identically in debug/release and WASM.
        for source in [
            "^18446744073709551615.0.0",
            "^0.18446744073709551615.0",
            "^0.0.18446744073709551615",
            "~1.18446744073709551615.0",
        ] {
            assert!(Requirement::parse(source).is_none(), "{source}");
        }
        for source in [
            "^18446744073709551614.0.0",
            "^0.18446744073709551614.0",
            "^0.0.18446744073709551614",
            "~1.18446744073709551614.0",
        ] {
            let requirement = Requirement::parse(source).unwrap();
            let lower = Version::parse(&source[1..]).unwrap();
            assert!(requirement.matches(&lower), "{source}");
            let upper = &requirement.comparators[1].2;
            assert!(!requirement.matches(upper), "{source}");
        }
        // An exact/comparator maximum is representable and needs no increment.
        let maximum =
            Version::parse("18446744073709551615.18446744073709551615.18446744073709551615")
                .unwrap();
        for prefix in ["", "=", ">="] {
            let source = format!("{prefix}{maximum}");
            assert!(Requirement::parse(&source).unwrap().matches(&maximum));
        }
    }

    #[test]
    fn jcs_sorts_by_utf16() {
        let v = crate::yaml::parse_value(
            "{b: 1, a: [true, null, 1.5], \"\u{e9}\": x, \"\u{1f600}\": y}\n",
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            jcs(&v),
            "{\"a\":[true,null,1.5],\"b\":1,\"\u{e9}\":\"x\",\"\u{1f600}\":\"y\"}"
        );
    }
}
