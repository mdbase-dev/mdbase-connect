//! Operation adapters: fixture `operation` + `input` → a core call → a value in
//! the fixture's `expect` shape.
//!
//! The fixture `input`/`expect` format is the spec's adapter-facing assertion DSL
//! (`conformance/spec/tests/v0.3/README.md`), not the core API. Each adapter
//! translates; none implements semantics.
//!
//! **To make a fixture pass:** implement the core function, call it from the
//! adapter below, run `cargo run -p mdbn-conformance --bin spec-conformance --
//! --bless`, and commit the updated `conformance/spec-expectations.txt`.

use mdbn_core::value::{Map as CoreMap, Value as CoreValue};
use serde_json::{Value, json};

/// Why an operation produced no result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Unsupported {
    /// The spec defines the operation; the core does not implement it yet.
    NotImplemented(&'static str),
    /// The runner does not know the operation at all.
    UnknownOperation(String),
}

/// Context shared by the tests of one fixture group.
#[derive(Debug, Clone, Copy)]
pub struct Group<'a> {
    /// The group's `setup` (config, types, files), or `Null`.
    pub setup: &'a Value,
    /// The test's `expect` block, for adapters whose expectations are subset
    /// assertions (`diagnostics_contain`).
    pub expect: &'a Value,
}

/// Run `operation` with `input`.
///
/// Returns the actual outcome in the shape of the fixture's `expect` block.
pub fn run(operation: &str, group: Group<'_>, input: &Value) -> Result<Value, Unsupported> {
    // Each arm names the core capability it will call (core semantics).
    match operation {
        // merge/merge.yaml (Chapter 12A)
        "merge_records" => Ok(merge_records(group, input)),
        "merge_strategies" => Ok(merge_strategies(group, input)),
        // merge/body-edits.yaml
        "apply_body_edits" => Ok(apply_body_edits(input)),
        // core/paths.yaml (Chapters 02, 07)
        "path_equivalence" => Ok(path_equivalence(input)),
        "allocate_path" => Ok(allocate_path(input)),
        "derive_path" => Ok(derive_path(input)),
        // core/link-ambiguity.yaml, core/rename-references.yaml (Chapters 08, 12)
        "resolve_link" => crate::ops_b::resolve_link(group, input),
        "rename" => crate::ops_b::write(group, "rename", input),
        "create" | "update" | "delete" => crate::ops_b::write(group, operation, input),
        "read" => crate::ops_b::read(group, input),
        "query" => crate::ops_b::query(group, input),
        "get_type" => crate::ops_b::get_type(group, input),
        "data_contract_implementation_validate" => {
            crate::ops_b::data_contract_implementation_validate(input, group.expect)
        }
        "data_contract_digest" => crate::ops_b::data_contract_digest(input),
        "data_contract_implementation_digest" => {
            crate::ops_b::data_contract_implementation_digest(input)
        }
        "data_contract_registry_validate" => {
            crate::ops_b::data_contract_registry_validate(input, group.expect)
        }
        "get_data_contracts" => crate::ops_b::get_data_contracts(group, input),
        "assess_type_pack" => crate::ops_b::type_pack(group, input, false),
        "apply_type_pack" => crate::ops_b::type_pack(group, input, true),
        "get_contract_view" => crate::ops_b::get_contract_view(group, input),
        "batch" => crate::ops_b::batch(group, input),
        // watch/move-detection.yaml
        "detect_moves" => Ok(detect_moves(input)),
        // cel/regex-profile.yaml (Chapter 10)
        "regex_match" => Ok(regex_match(input)),
        "evaluate_cel" => Ok(evaluate_cel(group, input)),
        "evaluate_workflow_input" => Ok(evaluate_workflow_input(group, input)),
        "validate" => crate::ops_b::validate(group, input),
        "get_types" => crate::ops_b::get_types(group, input),
        "load_types" => crate::ops_b::load_types(group, input, group.expect),
        other => Err(Unsupported::UnknownOperation(other.to_owned())),
    }
}

/// The group's catalog (core-B's `types::Catalog`, built from `setup`).
fn catalog(group: Group<'_>) -> std::sync::Arc<mdbn_core::types::Catalog> {
    use mdbn_core::state::StateView;
    crate::collection::build(group.setup).catalog()
}

fn merge_records(group: Group<'_>, input: &Value) -> Value {
    use mdbn_core::merge::{Version, merge_records};
    let path = |side: &str| {
        input["paths"][side]
            .as_str()
            .or_else(|| input["path"].as_str())
            .unwrap_or("")
    };
    let version = |side: &'static str| Version {
        path: path(side),
        source: input[side].as_str().unwrap_or(""),
    };
    let m = merge_records(
        version("base"),
        version("first"),
        version("second"),
        &*catalog(group),
    );
    let conflicts: Vec<Value> = m
        .conflicts
        .iter()
        .map(|c| {
            let mut o = serde_json::Map::new();
            o.insert("kind".into(), json!(c.kind.as_str()));
            if let Some(f) = &c.field {
                o.insert("field".into(), json!(f));
            }
            Value::Object(o)
        })
        .collect();
    json!({ "document": m.document, "conflicts": conflicts, "path": m.path })
}

fn merge_strategies(group: Group<'_>, input: &Value) -> Value {
    use mdbn_core::merge::MergeTypes;
    let cat = catalog(group);
    let path = input["path"].as_str().unwrap_or("");
    let doc = mdbn_core::doc::Document::parse_at(path, input["document"].as_str().unwrap_or(""));
    let facts = cat.merge_facts(path, doc.frontmatter());
    let fields: std::collections::BTreeSet<String> = match input["fields"].as_array() {
        Some(fs) => fs
            .iter()
            .filter_map(|f| f.as_str().map(str::to_owned))
            .collect(),
        None => {
            let mut all: std::collections::BTreeSet<String> =
                doc.frontmatter().keys().map(str::to_owned).collect();
            all.insert("tags".into());
            all.extend(facts.declared.keys().cloned());
            all.extend(facts.time_fields.iter().cloned());
            all.extend(facts.unique_items.iter().cloned());
            let names = cat.membership(path, doc.frontmatter()).types;
            for t in cat.types().iter().filter(|t| names.contains(&t.name)) {
                all.extend(t.schema.0.top_level_properties());
            }
            all
        }
    };
    let mut strategies = serde_json::Map::new();
    for f in &fields {
        match facts.strategy(f) {
            Ok(s) => {
                strategies.insert(f.clone(), json!(s.as_str()));
            }
            Err(e) => return json!({ "error": { "code": "type_conflict", "field": e.field } }),
        }
    }
    json!({ "strategies": strategies })
}

fn apply_body_edits(input: &Value) -> Value {
    use mdbn_core::merge::{BodyBase, BodyEdit, apply_body_edits};
    let base = input["base"].as_str().unwrap_or("");
    let current = input["current"].as_str().unwrap_or("");
    let available = input["base_available"].as_bool().unwrap_or(true);
    let edits: Vec<BodyEdit> = input["edits"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|e| BodyEdit {
            start: e["start"].as_u64().unwrap_or(0),
            end: e["end"].as_u64().unwrap_or(0),
            insert: e["text"].as_str().unwrap_or("").to_owned(),
        })
        .collect();
    // The engine compares digests: the current body is the base when they are
    // equal, whether or not it holds a separate copy of the base.
    let b = if current == base {
        BodyBase::Text(current)
    } else if available {
        BodyBase::Text(base)
    } else {
        BodyBase::Unavailable
    };
    match apply_body_edits(current, b, &edits) {
        Ok(body) => json!({ "body": body }),
        Err(e) => json!({ "error": { "code": e.code, "details": { "reason": e.reason } } }),
    }
}

fn detect_moves(input: &Value) -> Value {
    use mdbn_core::moves::{Observed, detect_moves};
    let side = |k: &str| -> Vec<Observed<'_>> {
        input[k]
            .as_array()
            .into_iter()
            .flatten()
            .map(|o| Observed {
                path: o["path"].as_str().unwrap_or(""),
                content: o["content"].as_str().unwrap_or(""),
                file_id: o["file_id"].as_str().map(str::as_bytes),
            })
            .collect()
    };
    let r = detect_moves(
        &side("disappeared"),
        &side("appeared"),
        input["id_field"].as_str(),
    );
    let moves: Vec<Value> = r
        .moves
        .iter()
        .map(|m| json!({ "from": m.from, "to": m.to }))
        .collect();
    json!({ "moves": moves, "deleted": r.deleted, "created": r.created })
}

fn evaluate_cel(group: Group<'_>, input: &Value) -> Value {
    use mdbn_core::cel::{Activation, CelValue, compile, record_activation};
    use mdbn_core::state::StateView;
    let path = input["path"].as_str().unwrap_or("");
    let source = group.setup["files"][path].as_str().unwrap_or("");
    let doc = mdbn_core::doc::Document::parse_at(path, source);
    let state = crate::collection::build(group.setup);
    let links = mdbn_core::links::CelLinks::new(&state);
    let workflow = input["context"].as_str() == Some("workflow");
    let mut act = if workflow {
        let mut act = Activation::new();
        for name in ["event", "steps"] {
            if let Some(v) = group.setup.get(name) {
                act.bind(name, CelValue::from_value(&to_core(v)));
            }
        }
        act
    } else {
        let catalog = state.catalog();
        let types = catalog.membership(path, doc.frontmatter()).types;
        let effective = catalog.effective_frontmatter(&types, doc.frontmatter());
        let file = links.file_value(path, doc.frontmatter(), doc.body());
        record_activation(doc.frontmatter(), &effective, CelValue::from_value(&file))
    };
    act.with_links(&links);
    act.with_clock(captured_clock(input));
    let program = match compile(input["expression"].as_str().unwrap_or("")) {
        Ok(p) => p,
        Err(e) => {
            return json!({ "valid": false, "diagnostics": [{ "code": "expression_compile_error", "message": e.to_string() }] });
        }
    };
    match program.evaluate(&act) {
        Ok(v) => {
            json!({ "valid": true, "value": v.to_value().map_or(Value::Null, |v| from_core(&v)), "diagnostics": [] })
        }
        Err(e) => {
            // Record-query projection errors produce null with a diagnostic;
            // workflow evaluation errors instead fail the step (spec 10).
            json!({ "valid": !workflow, "value": null, "diagnostics": [{ "code": "expression_evaluation_error", "message": e.message }] })
        }
    }
}

/// The same captured fixture clock for CEL record/workflow and template input.
/// Never reads the host clock, and unavailable zones never silently become UTC.
fn captured_clock(input: &Value) -> mdbn_core::cel::Clock {
    use mdbn_core::cel::time::{FixedOffset, Timestamp, Utc};
    use std::sync::Arc;
    // IANA rules remain unavailable until the pinned tzdb integration lands.
    let tz: Option<Arc<dyn mdbn_core::cel::time::TimeZoneRules>> =
        match input["timezone"].as_str().unwrap_or("UTC") {
            "UTC" | "Z" => Some(Arc::new(Utc)),
            zone => Timestamp::parse(&format!("1970-01-01T00:00:00{zone}"))
                .ok()
                .and_then(|t| i32::try_from(-t.seconds).ok())
                .map(|offset| Arc::new(FixedOffset(offset)) as Arc<_>),
        };
    mdbn_core::cel::Clock {
        instant: input["clock"]["instant"]
            .as_str()
            .or(Some("2026-01-01T00:00:00Z"))
            .and_then(|s| Timestamp::parse(s).ok()),
        local_date: input["clock"]["local_date"].as_str().map(str::to_owned),
        tz,
    }
}

fn evaluate_workflow_input(group: Group<'_>, input: &Value) -> Value {
    let mut activation = mdbn_core::cel::Activation::new();
    for name in ["event", "steps"] {
        activation.bind(
            name,
            mdbn_core::cel::CelValue::from_value(&to_core(&group.setup[name])),
        );
    }
    activation.with_clock(captured_clock(input));
    match mdbn_core::cel::template::evaluate(&to_core(&input["template"]), &activation) {
        Ok(value) => json!({ "valid": true, "value": from_core(&value) }),
        Err(error) => {
            json!({ "valid": false, "diagnostics": [{ "code": error.code, "message": error.message }] })
        }
    }
}

fn regex_match(input: &Value) -> Value {
    let pattern = input["pattern"].as_str().unwrap_or("");
    let text = input["text"].as_str().unwrap_or("");
    match mdbn_core::regex::is_match(pattern, text) {
        Ok(m) => json!({ "matches": m }),
        Err(e) => json!({ "error": { "code": "invalid_pattern", "message": e.message } }),
    }
}

fn str_list(v: &Value) -> Vec<&str> {
    v.as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect()
}

fn path_equivalence(input: &Value) -> Value {
    let groups = mdbn_core::paths::equivalence_groups(str_list(&input["paths"]));
    json!({ "groups": groups })
}

fn allocate_path(input: &Value) -> Value {
    let requested = input["requested"].as_str().unwrap_or("");
    json!({ "path": mdbn_core::paths::allocate_path(requested, str_list(&input["existing"])) })
}

fn derive_path(input: &Value) -> Value {
    let pattern = input["pattern"].as_str().unwrap_or("");
    let fm = match to_core(&input["frontmatter"]) {
        CoreValue::Map(m) => m,
        _ => CoreMap::new(),
    };
    match mdbn_core::paths::derive_path(pattern, &fm) {
        Ok(path) => json!({ "path": path }),
        Err(e) => json!({ "error": { "code": e.code(), "field": e.field() } }),
    }
}

/// A fixture value (JSON) as a core value.
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

/// A core value as JSON (for comparison with fixture expectations).
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

/// Whether `actual` satisfies `expect`.
///
/// Objects: every expected key is present in `actual` and matches (extra keys in
/// `actual` are ignored, so adapters may return more, e.g. conflict values).
/// Arrays: same length, element-wise match. Scalars: equal, with numbers compared
/// as `f64` when either side is not an integer.
pub fn matches(expect: &Value, actual: &Value) -> bool {
    match (expect, actual) {
        (Value::Object(e), Value::Object(a)) => e
            .iter()
            .all(|(k, ev)| a.get(k).is_some_and(|av| matches(ev, av))),
        (Value::Array(e), Value::Array(a)) => {
            e.len() == a.len() && e.iter().zip(a).all(|(ev, av)| matches(ev, av))
        }
        (Value::Number(e), Value::Number(a)) => match (e.as_i64(), a.as_i64()) {
            (Some(x), Some(y)) => x == y,
            _ => e.as_f64() == a.as_f64(),
        },
        _ => expect == actual,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn cel_record_context_uses_defaults_and_file_helpers() {
        let setup = json!({
            "config": "spec_version: \"0.3.0\"\n",
            "types": { "task.md": "---\nkind: mdbase.type\nname: task\nversion: 1\nmatch: { path_glob: 'tasks/*.md' }\nschema: { dialect: json-schema-2020-12, value: { type: object } }\ncollection: { read_defaults: { status: open } }\n---\n" },
            "files": { "tasks/a.md": "---\ntags: [project/alpha]\n---\n" }
        });
        let group = Group {
            setup: &setup,
            expect: &Value::Null,
        };
        for expression in [
            "!has(raw.status) && has(record.status) && status == 'open'",
            "file.path == 'tasks/a.md' && file.inFolder('tasks') && file.hasTag('project')",
            "now() == timestamp('2026-01-01T00:00:00Z')",
        ] {
            let actual = evaluate_cel(
                group,
                &json!({ "path": "tasks/a.md", "expression": expression }),
            );
            assert_eq!(
                actual,
                json!({ "valid": true, "value": true, "diagnostics": [] }),
                "{expression}"
            );
        }
        let actual = evaluate_cel(
            group,
            &json!({ "path": "tasks/a.md", "expression": "raw.status" }),
        );
        assert_eq!(actual["valid"], true);
        assert_eq!(actual["value"], Value::Null);
        assert_eq!(
            actual["diagnostics"][0]["code"],
            "expression_evaluation_error"
        );
    }

    #[test]
    fn cel_workflow_context_and_captured_time() {
        let setup = json!({
            "event": { "data": { "types": ["task"] } },
            "steps": { "patch": { "status": "succeeded" } }
        });
        let group = Group {
            setup: &setup,
            expect: &Value::Null,
        };
        let actual = evaluate_cel(
            group,
            &json!({
                "context": "workflow",
                "timezone": "+10:00",
                "clock": { "instant": "2026-06-20T15:30:00Z", "local_date": "2026-06-21" },
                "expression": "'task' in event.data.types && steps['patch'].status == 'succeeded' && today() == '2026-06-21' && date(now()) == '2026-06-21'"
            }),
        );
        assert_eq!(
            actual,
            json!({ "valid": true, "value": true, "diagnostics": [] })
        );
        let actual = evaluate_cel(
            group,
            &json!({ "context": "workflow", "expression": "event.missing" }),
        );
        assert_eq!(actual["valid"], false);
        let actual = evaluate_cel(
            group,
            &json!({
                "context": "workflow", "timezone": "Australia/Melbourne", "expression": "date(now())"
            }),
        );
        assert_eq!(
            actual["valid"], false,
            "unknown zone must not silently use UTC"
        );
    }

    #[test]
    fn workflow_input_adapter_keeps_literals_and_reports_failures() {
        let setup = json!({"event": {"data": {"file": {"path": "tasks/card-001.md"}}}, "steps": {"patch": {"status": "succeeded"}}});
        let group = Group {
            setup: &setup,
            expect: &Value::Null,
        };
        let actual = run(
            "evaluate_workflow_input",
            group,
            &json!({"template": {
                "path": {"$expr": "event.data.file.path"},
                "literal": "event.data.file.path",
                "status": {"$expr": "steps.patch.status"}
            }}),
        )
        .unwrap();
        assert_eq!(
            actual,
            json!({"valid": true, "value": {"path": "tasks/card-001.md", "literal": "event.data.file.path", "status": "succeeded"}})
        );
        let error = run(
            "evaluate_workflow_input",
            group,
            &json!({"template": {"$expr": "1 / 0"}}),
        )
        .unwrap();
        assert_eq!(error["valid"], false);
        assert_eq!(
            error["diagnostics"][0]["code"],
            "expression_evaluation_error"
        );
        assert!(error.get("value").is_none());
    }

    #[test]
    fn workflow_template_shares_captured_time_and_unavailable_zone_errors() {
        let setup = json!({"event": {"data": {"types": ["task"]}}, "steps": {"patch": {"status": "succeeded"}}});
        let group = Group {
            setup: &setup,
            expect: &Value::Null,
        };
        let input = json!({
            "timezone": "+10:00",
            "clock": {"instant": "2026-06-20T15:30:00Z", "local_date": "2026-06-21"},
            "template": {
                "date": {"$expr": "date(now())"},
                "today": {"$expr": "today()"},
                "status": {"$expr": "steps.patch.status"},
                "task": {"$expr": "'task' in event.data.types"}
            }
        });
        let actual = run("evaluate_workflow_input", group, &input).unwrap();
        assert_eq!(
            actual,
            json!({"valid": true, "value": {"date": "2026-06-21", "today": "2026-06-21", "status": "succeeded", "task": true}})
        );
        assert_eq!(
            actual,
            run("evaluate_workflow_input", group, &input).unwrap(),
            "same captured inputs remain deterministic"
        );
        let unsupported = run(
            "evaluate_workflow_input",
            group,
            &json!({"timezone": "Australia/Melbourne", "template": {"$expr": "date(now())"}}),
        )
        .unwrap();
        assert_eq!(
            unsupported["valid"], false,
            "unavailable zones must not silently use UTC"
        );
        assert_eq!(
            unsupported["diagnostics"][0]["code"],
            "expression_evaluation_error"
        );
        assert!(unsupported.get("value").is_none());
    }

    #[test]
    fn subset_matching() {
        let actual =
            json!({"document": "x", "conflicts": [{"kind": "field", "field": "s", "first": 1}]});
        assert!(matches(
            &json!({"conflicts": [{"kind": "field", "field": "s"}]}),
            &actual
        ));
        assert!(!matches(&json!({"conflicts": []}), &actual));
        assert!(!matches(&json!({"path": "a.md"}), &actual));
        assert!(matches(&json!({"n": 1}), &json!({"n": 1.0})));
    }
}
