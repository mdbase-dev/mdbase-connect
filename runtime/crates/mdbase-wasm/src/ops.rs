//! The operations behind [`crate::call`]. Each one translates JSON input into
//! a core call and the result back; no semantics live here.

use std::collections::BTreeMap;

use mdbn_core::contracts;
use mdbn_core::ids::{Hash, Uuid};
use mdbn_core::intent::{ConflictMode, Mutation, Op, OpClock, Source};
use mdbn_core::jsonschema;
use mdbn_core::packs::{self, AssessOptions};
use mdbn_core::plan::{PlanOptions, Stage, plan};
use mdbn_core::query::Query;
use mdbn_core::state::{MemState, StateView};
use mdbn_core::types::Catalog;
use mdbn_core::validate::{self, Issue};
use serde_json::{Value, json};

use crate::json as j;

mod collection;

/// Why an operation failed.
#[derive(Debug, Clone, PartialEq)]
pub struct OpError {
    /// A stable code: `invalid_input`, `unknown_op`, a spec issue code, ...
    pub code: String,
    /// What went wrong and, where possible, what to do.
    pub message: String,
    /// Where (a resource path, a JSON Pointer, a query member).
    pub location: Option<String>,
    /// Structured details (issues, schema load errors).
    pub details: Option<Value>,
}

impl OpError {
    fn new(code: &str, message: impl Into<String>) -> OpError {
        OpError {
            code: code.into(),
            message: message.into(),
            location: None,
            details: None,
        }
    }

    fn input(message: impl Into<String>) -> OpError {
        OpError::new("invalid_input", message)
    }

    fn from_issue(i: Issue) -> OpError {
        OpError {
            code: i.code.clone(),
            message: i.message.clone(),
            location: i.location.clone(),
            details: Some(j::issue(&i)),
        }
    }

    fn from_issues(code: &str, message: &str, issues: &[Issue]) -> OpError {
        let text = issues
            .iter()
            .map(|i| format!("{}: {}", i.code, i.message))
            .collect::<Vec<_>>()
            .join("; ");
        OpError {
            code: code.into(),
            message: if text.is_empty() {
                message.to_owned()
            } else {
                format!("{message}: {text}")
            },
            location: None,
            details: Some(j::issues(issues)),
        }
    }

    /// The error as JSON.
    pub fn to_json(&self) -> Value {
        let mut v = json!({ "code": self.code, "message": self.message });
        if let Some(l) = &self.location {
            v["location"] = json!(l);
        }
        if let Some(d) = &self.details {
            v["details"] = d.clone();
        }
        v
    }
}

type OpResult = Result<Value, OpError>;

/// Dispatch `op`.
pub fn dispatch(op: &str, input: &Value) -> OpResult {
    match op {
        "info" => Ok(info()),
        "contract_digest" => contract_digest(input),
        "implementation_digest" => implementation_digest(input),
        "load_catalog" => load_catalog(input),
        "validate_record" => validate_record(input),
        "validate_schema" => validate_schema(input),
        "check_query" => check_query(input),
        "load_pack" => load_pack(input),
        "parse_lock" => parse_lock(input),
        "assess_type_pack" => type_pack(input, false),
        "apply_type_pack" => type_pack(input, true),
        "assess_collection_resources" => collection::resources(input, false),
        "apply_collection_resources" => collection::resources(input, true),
        _ => Err(OpError::new(
            "unknown_op",
            format!(
                "unknown operation `{op}`; this build knows: {}",
                OPS.join(", ")
            ),
        )),
    }
}

/// Every operation name.
pub const OPS: &[&str] = &[
    "info",
    "contract_digest",
    "implementation_digest",
    "load_catalog",
    "validate_record",
    "validate_schema",
    "check_query",
    "load_pack",
    "parse_lock",
    "assess_type_pack",
    "apply_type_pack",
    "assess_collection_resources",
    "apply_collection_resources",
];

/// `info`: `{abi, version, sem: [major, minor], spec_versions, ops}`.
fn info() -> Value {
    let sem = mdbn_core::semantics::SEM;
    json!({
        "abi": crate::ABI_MAJOR,
        "version": env!("CARGO_PKG_VERSION"),
        "sem": [sem.major, sem.minor],
        "spec_versions": mdbn_core::types::SUPPORTED_SPEC_VERSIONS,
        "ops": OPS,
    })
}

fn str_field<'a>(input: &'a Value, key: &str) -> Result<&'a str, OpError> {
    input
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| OpError::input(format!("`{key}` (a string) is required")))
}

/// `{path: source}` → sorted map. Missing means empty.
fn resources_of(v: Option<&Value>) -> Result<BTreeMap<String, String>, OpError> {
    let mut out = BTreeMap::new();
    match v {
        None | Some(Value::Null) => {}
        Some(Value::Object(m)) => {
            for (k, v) in m {
                let Some(s) = v.as_str() else {
                    return Err(OpError::input(format!(
                        "`resources[{k:?}]` must be the file's text"
                    )));
                };
                out.insert(k.clone(), s.to_owned());
            }
        }
        Some(_) => {
            return Err(OpError::input(
                "`resources` is an object of resource path → file text",
            ));
        }
    }
    Ok(out)
}

fn catalog_of(resources: &BTreeMap<String, String>) -> Catalog {
    Catalog::load(resources.iter().map(|(p, s)| (p.as_str(), s.as_str())))
}

/// A document from `source` (file text) or `frontmatter` (an object rendered
/// as a Markdown frontmatter block).
fn document_of(input: &Value) -> Result<String, OpError> {
    match (input.get("source"), input.get("frontmatter")) {
        (Some(Value::String(s)), _) => Ok(s.clone()),
        (None, Some(Value::Object(_))) => {
            let mdbn_core::value::Value::Map(m) = j::to_core(&input["frontmatter"]) else {
                unreachable!("an object converts to a map")
            };
            mdbn_core::writer::render_new(
                &m,
                "",
                mdbn_core::doc::RecordFormat::Markdown,
                mdbn_core::doc::LineEnding::Lf,
            )
            .map_err(|e| OpError::input(format!("`frontmatter` cannot be rendered: {e:?}")))
        }
        _ => Err(OpError::input(
            "`source` (the file's text) or `frontmatter` (an object) is required",
        )),
    }
}

/// `contract_digest`: `{source | frontmatter, path?, resources?}` →
/// the contract (`digest`, `id`, `version`, `contract_type`, `schemas`, …).
/// `resources` holds the files `ref` wrappers point at, by collection path.
fn contract_digest(input: &Value) -> OpResult {
    let resources = resources_of(input.get("resources"))?;
    let path = input
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or("_contracts/contract.md");
    let source = document_of(input)?;
    let refs: BTreeMap<&str, &str> = resources
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    let c = contracts::load_contract(path, &source, &refs).map_err(OpError::from_issue)?;
    Ok(j::contract(&c))
}

/// `implementation_digest`: `{contract: {path?, source}, type: {path?, source},
/// resources?}` → the implementation (`digest`, `contract_digest`, …).
fn implementation_digest(input: &Value) -> OpResult {
    let mut resources = resources_of(input.get("resources"))?;
    for (key, default) in [
        ("contract", "_contracts/contract.md"),
        ("type", "_types/type.md"),
    ] {
        let obj = input
            .get(key)
            .ok_or_else(|| OpError::input(format!("`{key}` {{path?, source}} is required")))?;
        let path = obj.get("path").and_then(Value::as_str).unwrap_or(default);
        resources.insert(path.to_owned(), document_of(obj)?);
    }
    let catalog = catalog_of(&resources);
    match catalog.implementations().first() {
        Some(i) => Ok(j::implementation(i)),
        None => Err(OpError::from_issues(
            "invalid_implementation",
            "the type does not implement the contract",
            catalog.issues(),
        )),
    }
}

/// `load_catalog`: `{resources}` → the catalog (config, types, contracts,
/// implementations, issues).
fn load_catalog(input: &Value) -> OpResult {
    let resources = resources_of(input.get("resources"))?;
    Ok(j::catalog(&catalog_of(&resources)))
}

/// `validate_record`: `{resources, path, source}` → `{issues, types}`.
/// Issues follow `settings.validation` (`off` still reports, as warnings).
fn validate_record(input: &Value) -> OpResult {
    let resources = resources_of(input.get("resources"))?;
    let path = str_field(input, "path")?;
    let source = str_field(input, "source")?;
    let catalog = catalog_of(&resources);
    let issues = validate::apply_level(
        validate::validate_record(&catalog, path, source),
        catalog.settings().validation,
        true,
    );
    let doc = mdbn_core::doc::Document::parse_at(path, source);
    let types = catalog.membership(path, doc.frontmatter()).types;
    Ok(json!({ "issues": j::issues(&issues), "types": types }))
}

/// `validate_schema`: `{schema, entry?, instance}` → `{issues}`.
fn validate_schema(input: &Value) -> OpResult {
    let schema = input
        .get("schema")
        .ok_or_else(|| OpError::input("`schema` (a JSON Schema document) is required"))?;
    let entry = input.get("entry").and_then(Value::as_str).unwrap_or("");
    let instance = input
        .get("instance")
        .ok_or_else(|| OpError::input("`instance` (the value to validate) is required"))?;
    let compiled = jsonschema::compile(&j::to_core(schema), entry).map_err(|errs| OpError {
        code: "invalid_schema".into(),
        message: errs
            .iter()
            .map(|e| format!("{} at {}: {}", e.code, e.location, e.message))
            .collect::<Vec<_>>()
            .join("; "),
        location: errs.first().map(|e| e.location.clone()),
        details: Some(Value::Array(
            errs.iter()
                .map(|e| json!({"code": e.code, "message": e.message, "location": e.location}))
                .collect(),
        )),
    })?;
    let issues: Vec<Value> = compiled
        .validate(&j::to_core(instance))
        .iter()
        .map(|i| {
            json!({
                "code": i.code,
                "keyword": i.keyword,
                "instance_path": i.instance_path,
                "schema_path": i.schema_path,
                "message": i.message,
            })
        })
        .collect();
    Ok(json!({ "valid": issues.is_empty(), "issues": issues }))
}

/// `check_query`: `{query, resources?}` → `{valid: true, types}`. With
/// `resources`, the query is also compiled against that catalog.
fn check_query(input: &Value) -> OpResult {
    let q = input
        .get("query")
        .ok_or_else(|| OpError::input("`query` (a spec 11 query object) is required"))?;
    let query = Query::from_value(&j::to_core(q)).map_err(query_error)?;
    if input.get("resources").is_some_and(|r| !r.is_null()) {
        let catalog = catalog_of(&resources_of(input.get("resources"))?);
        mdbn_core::query::compile(&query, &catalog).map_err(query_error)?;
    }
    Ok(json!({ "valid": true, "types": query.types }))
}

fn query_error(e: mdbn_core::query::QueryError) -> OpError {
    OpError {
        code: e.code,
        message: e.message,
        location: e.location,
        details: None,
    }
}

fn pack_of(input: &Value) -> Result<packs::Pack, OpError> {
    let manifest = str_field(input, "manifest")?;
    let sources = resources_of(input.get("sources"))?;
    packs::load_pack(manifest, &|p| sources.get(p).cloned()).map_err(OpError::from_issue)
}

/// `load_pack`: `{manifest, sources}` → the validated pack. `sources` maps
/// the manifest's pack-relative source paths to their text.
fn load_pack(input: &Value) -> OpResult {
    Ok(j::pack(&pack_of(input)?))
}

/// `parse_lock`: `{source}` → the lock's receipts.
fn parse_lock(input: &Value) -> OpResult {
    let l = packs::Lock::parse(str_field(input, "source")?).map_err(OpError::from_issue)?;
    Ok(j::lock(&l))
}

fn assess_options(v: Option<&Value>) -> Result<AssessOptions, OpError> {
    let mut o = AssessOptions::default();
    let Some(v) = v else {
        return Err(OpError::input("`options.installed_by` is required"));
    };
    o.installed_by = v
        .get("installed_by")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            OpError::input("`options.installed_by` (a reverse-domain installer id) is required")
        })?
        .to_owned();
    if let Some(Value::Object(m)) = v.get("target_overrides") {
        for (k, t) in m {
            let t = t
                .as_str()
                .ok_or_else(|| OpError::input("`options.target_overrides` values are paths"))?;
            o.target_overrides.insert(k.clone(), t.to_owned());
        }
    }
    if let Some(Value::Object(m)) = v.get("adopt") {
        for (k, d) in m {
            let h = d.as_str().and_then(Hash::parse).ok_or_else(|| {
                OpError::input(format!("`options.adopt[{k:?}]` is a `sha256:…` digest"))
            })?;
            o.adopt.insert(k.clone(), h);
        }
    }
    if let Some(Value::Array(a)) = v.get("preserve_seed_targets") {
        for t in a {
            let t = t
                .as_str()
                .ok_or_else(|| OpError::input("`options.preserve_seed_targets` are paths"))?;
            o.preserve_seed_targets.insert(t.to_owned());
        }
    }
    o.allow_downgrade = v
        .get("allow_downgrade")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Ok(o)
}

fn state_of(resources: &BTreeMap<String, String>) -> MemState {
    let mut state = MemState::new();
    for (p, s) in resources {
        state.insert_resource(p, s);
    }
    state
}

/// `assess_type_pack` / `apply_type_pack`: `{manifest, sources, resources,
/// options, expected_digest (apply)}`. Assess returns the assessment; apply
/// returns `{assessment, ops, writes: [{path, document}], deletes: [path]}`.
/// `ops` preserves the core's ordered resource operations and guards in SDK
/// shape; writes/deletes retain the existing snapshot-diff API.
fn type_pack(input: &Value, apply: bool) -> OpResult {
    let pack = pack_of(input)?;
    let resources = resources_of(input.get("resources"))?;
    let opts = assess_options(input.get("options"))?;
    let mut state = state_of(&resources);
    if !apply {
        let a = packs::assess_type_pack(&state, &pack, &opts).map_err(OpError::from_issue)?;
        return Ok(j::assessment(&a));
    }
    let expected = input
        .get("expected_digest")
        .and_then(Value::as_str)
        .and_then(Hash::parse)
        .ok_or_else(|| {
            OpError::input(
                "`expected_digest` (the assessment digest from `assess_type_pack`) is required",
            )
        })?;
    let (a, ops) =
        packs::apply_type_pack(&state, &pack, &opts, &expected).map_err(OpError::from_issue)?;
    // Capture the original guarded intent before planning consumes it. The
    // resulting snapshot diff cannot recover CAS or create-only conditions.
    let guarded_ops = ops.iter().map(pack_op).collect::<Result<Vec<_>, _>>()?;
    let before: BTreeMap<String, String> = state
        .resource_paths()
        .into_iter()
        .filter_map(|p| state.resource(&p).map(|s| (p, s.to_string())))
        .collect();
    run_ops(&mut state, ops)?;
    let after: BTreeMap<String, String> = state
        .resource_paths()
        .into_iter()
        .filter_map(|p| state.resource(&p).map(|s| (p, s.to_string())))
        .collect();
    let writes: Vec<Value> = after
        .iter()
        .filter(|(p, s)| before.get(*p) != Some(*s))
        .map(|(p, s)| json!({ "path": p, "document": s }))
        .collect();
    let deletes: Vec<&String> = before.keys().filter(|p| !after.contains_key(*p)).collect();
    Ok(
        json!({ "assessment": j::assessment(&a), "ops": guarded_ops, "writes": writes, "deletes": deletes }),
    )
}

/// Translate, never reconstruct, the pack core's resource intents. No wire/SDK
/// dependency is needed: hashes are the same explicit `sha256:` strings.
fn pack_op(op: &Op) -> Result<Value, OpError> {
    let (mut value, base_revision) = match op {
        Op::ResourcePut(p) => (
            json!({ "kind": "resource_put", "path": p.path, "doc": p.doc, "mustNotExist": p.must_not_exist }),
            p.base_revision,
        ),
        Op::ResourceDelete(d) => (
            json!({ "kind": "resource_delete", "path": d.path }),
            d.base_revision,
        ),
        _ => {
            return Err(OpError::input(
                "the type pack returned a non-resource operation",
            ));
        }
    };
    if let Some(revision) = base_revision {
        value["baseRevision"] = json!(revision.to_string());
    }
    Ok(value)
}

fn run_ops(state: &mut MemState, ops: Vec<Op>) -> Result<(), OpError> {
    if ops.is_empty() {
        return Ok(());
    }
    let m = Mutation {
        id: Uuid::NIL,
        origin: Uuid::NIL,
        base_seq: 0,
        clock: OpClock {
            instant_ms: 0,
            tz: "UTC".into(),
            local_date: "1970-01-01".into(),
        },
        seed: [0; 32],
        source: Source::Api,
        ops,
        on_behalf: None,
        conflict_mode: ConflictMode::Record,
        validated_at: None,
        room: None,
    };
    let p = plan(&m, &*state, &PlanOptions { stage: Stage::Head }).map_err(|r| OpError {
        code: "type_pack_apply_failed".into(),
        message: r.message.clone(),
        location: None,
        details: Some(json!({ "reason": r.reason, "issues": j::issues(&r.issues) })),
    })?;
    state.apply(&p);
    Ok(())
}
