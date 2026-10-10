//! Operation adapters for core-B's capabilities: catalog and type matching,
//! links, validation, intent planning and queries. Same rules as [`crate::ops`]:
//! translate fixture input into a core call and the result back, no semantics.

use mdbn_core::doc::Document;
use mdbn_core::links::{self, Resolution};
use mdbn_core::state::{MemState, StateView};
use mdbn_core::validate::{Issue, Severity};
use serde_json::{Map, Value, json};

use crate::collection::{self, id_at};
use crate::ops::{Group, Unsupported, from_core, matches};

/// An issue in the fixtures' diagnostic shape.
pub fn issue_json(i: &Issue) -> Value {
    let mut m = Map::new();
    m.insert("code".into(), json!(i.code));
    m.insert(
        "severity".into(),
        json!(match i.severity {
            Severity::Warning => "warning",
            Severity::Error => "error",
        }),
    );
    m.insert("message".into(), json!(i.message));
    if let Some(l) = &i.location {
        if let Some(field) = l.strip_prefix('/') {
            m.insert("field".into(), json!(field));
        } else {
            m.insert("path".into(), json!(l));
        }
    }
    if let Some(t) = &i.type_name {
        m.insert("type".into(), json!(t));
    }
    if let Some(d) = &i.details {
        m.insert("details".into(), from_core(d));
    }
    Value::Object(m)
}

fn path_of(state: &MemState, id: &mdbn_core::ids::Uuid) -> Value {
    state
        .record(id)
        .map(|r| json!(r.path))
        .or_else(|| state.file(id).map(|f| json!(f.path)))
        .unwrap_or(Value::Null)
}

/// `resolve_link`: resolve the link held by `input.field` of the record at
/// `input.path`.
pub fn resolve_link(group: Group<'_>, input: &Value) -> Result<Value, Unsupported> {
    let state = collection::build(group.setup);
    let path = input["path"].as_str().unwrap_or("");
    let field = input["field"].as_str().unwrap_or("");
    let Some(id) = id_at(&state, path) else {
        return Ok(json!({"valid": false, "error": {"code": "not_found"}}));
    };
    let rec = state
        .record(&id)
        .ok_or(Unsupported::NotImplemented("record"))?;
    let catalog = state.catalog();
    let doc = Document::parse_at(&rec.path, &*rec.source);
    let types = catalog.membership(&rec.path, doc.frontmatter()).types;
    let link = links::frontmatter_links(&catalog, &types, doc.frontmatter())
        .into_iter()
        .find(|l| l.field.as_ref().is_some_and(|(f, _)| f == field));
    let Some(link) = link else {
        return Ok(json!({"valid": true, "resolved": null, "diagnostics": []}));
    };
    let (resolved, diagnostics) = match links::resolve(&link, &rec.path, &state) {
        Resolution::Record(t) | Resolution::File(t) => (path_of(&state, &t), vec![]),
        Resolution::Ambiguous(c) => (
            Value::Null,
            vec![json!({"code": "ambiguous_link", "field": field, "details": {"candidates": c}})],
        ),
        Resolution::NotFound => (Value::Null, vec![]),
        Resolution::Invalid => (
            Value::Null,
            vec![json!({"code": "invalid_link", "field": field})],
        ),
    };
    Ok(json!({"valid": true, "resolved": resolved, "diagnostics": diagnostics}))
}

/// `get_types`: the matched types of the record at `input.path`.
pub fn get_types(group: Group<'_>, input: &Value) -> Result<Value, Unsupported> {
    let state = collection::build(group.setup);
    let path = input["path"].as_str().unwrap_or("");
    let catalog = state.catalog();
    let fm = match id_at(&state, path).and_then(|id| state.record(&id)) {
        Some(r) => Document::parse_at(&r.path, &*r.source)
            .frontmatter()
            .clone(),
        None => match input.get("frontmatter") {
            Some(f) => match crate::ops::to_core(f) {
                mdbn_core::value::Value::Map(m) => m,
                _ => mdbn_core::value::Map::new(),
            },
            None => mdbn_core::value::Map::new(),
        },
    };
    let clock = mdbn_core::intent::OpClock {
        instant_ms: FIXTURE_INSTANT,
        tz: "UTC".into(),
        local_date: "2026-01-01".into(),
    };
    let m = catalog.membership_at(path, &fm, Some(&clock));
    Ok(json!({
        "valid": true,
        "types": m.types,
        "diagnostics": m.issues.iter().map(issue_json).collect::<Vec<_>>(),
    }))
}

/// `load_types`: load the catalog and report its diagnostics.
pub fn load_types(group: Group<'_>, input: &Value, expect: &Value) -> Result<Value, Unsupported> {
    let _ = input;
    let state = collection::build(group.setup);
    let catalog = state.catalog();
    let diagnostics: Vec<Value> = catalog.issues().iter().map(issue_json).collect();
    let mut out = json!({
        "valid": catalog.is_valid()
            && !catalog.issues().iter().any(|i| i.severity == Severity::Error),
        "types": catalog.types().iter().map(|t| t.name.clone()).collect::<Vec<_>>(),
        "diagnostics": diagnostics,
    });
    // `diagnostics_contain` is a subset assertion: report the expected entries
    // that some actual diagnostic satisfies.
    if let Some(want) = expect.get("diagnostics_contain").and_then(Value::as_array) {
        let found: Vec<Value> = want
            .iter()
            .filter(|w| diagnostics.iter().any(|d| matches(w, d)))
            .cloned()
            .collect();
        out["diagnostics_contain"] = Value::Array(found);
    }
    Ok(out)
}

/// `validate`: single-record and cross-record issues of the record at
/// `input.path` (or of `input.frontmatter`/`input.document` at that path when
/// the record does not exist), under the collection's validation level.
pub fn validate(group: Group<'_>, input: &Value) -> Result<Value, Unsupported> {
    use mdbn_core::validate as v;
    let mut state = collection::build(group.setup);
    let catalog = state.catalog();
    let path = input["path"].as_str().unwrap_or("");
    let id = match id_at(&state, path) {
        Some(id) => id,
        None => {
            let src = match (input.get("document"), input.get("frontmatter")) {
                (Some(Value::String(d)), _) => d.clone(),
                (_, Some(f)) => {
                    let fm = match crate::ops::to_core(f) {
                        mdbn_core::value::Value::Map(m) => m,
                        _ => mdbn_core::value::Map::new(),
                    };
                    mdbn_core::writer::render_new(
                        &fm,
                        input["body"].as_str().unwrap_or(""),
                        mdbn_core::doc::RecordFormat::for_path(path),
                        mdbn_core::doc::LineEnding::Lf,
                    )
                    .map_err(|_| Unsupported::NotImplemented("render"))?
                }
                _ => return Ok(json!({"valid": false, "error": {"code": "not_found"}})),
            };
            let id = collection::fixture_id(path);
            state.insert_record(id, path, &src);
            id
        }
    };
    let rec = state
        .record(&id)
        .ok_or(Unsupported::NotImplemented("record"))?;
    let mut issues = v::validate_record(&catalog, &rec.path, &rec.source);
    issues.extend(v::cross_record_issues(&state, id));
    let issues = v::apply_level(issues, catalog.settings().validation, true);
    let valid = !issues.iter().any(|i| i.severity == Severity::Error);
    let list: Vec<Value> = issues.iter().map(issue_json).collect();
    let doc = Document::parse_at(&rec.path, &*rec.source);
    let types = catalog.membership(&rec.path, doc.frontmatter()).types;
    let mut resolved = Map::new();
    for l in links::frontmatter_links(&catalog, &types, doc.frontmatter()) {
        if let (Some((field, _)), Some(t)) =
            (&l.field, links::resolve(&l, &rec.path, &state).target())
        {
            resolved.insert(field.clone(), path_of(&state, &t));
        }
    }
    Ok(
        json!({"valid": valid, "issues": list, "diagnostics": list, "types": types, "resolved_links": resolved}),
    )
}

// ------------------------------------------------------------------ writes

use mdbn_core::ids::{Hash, Uuid};
use mdbn_core::intent::{self as it, Mutation, Op, OpClock, Source};
use mdbn_core::plan::{PlanOptions, Planned, RejectCode, Rejection, Stage};

/// The captured clock fixtures plan under: 2026-01-01T00:00:00Z, UTC.
const FIXTURE_INSTANT: i64 = 1_767_225_600_000;

fn core_map(v: &Value) -> mdbn_core::value::Map {
    match crate::ops::to_core(v) {
        mdbn_core::value::Value::Map(m) => m,
        _ => mdbn_core::value::Map::new(),
    }
}

fn str_list(v: &Value) -> Vec<String> {
    v.as_array()
        .into_iter()
        .flatten()
        .filter_map(|x| x.as_str().map(str::to_owned))
        .collect()
}

fn pairs(v: &Value) -> Vec<(String, Vec<mdbn_core::value::Value>)> {
    v.as_object()
        .into_iter()
        .flatten()
        .map(|(k, items)| {
            let list = match crate::ops::to_core(items) {
                mdbn_core::value::Value::List(l) => l,
                other => vec![other],
            };
            (k.clone(), list)
        })
        .collect()
}

fn hash_of(v: &Value) -> Option<Hash> {
    v.as_str().and_then(Hash::parse)
}

/// One fixture write (`kind` + `input`) as an op.
fn op_of(state: &MemState, kind: &str, input: &Value) -> Result<Op, Value> {
    let path = input["path"].as_str().unwrap_or("");
    let existing =
        || id_at(state, path).ok_or_else(|| json!({"code": "not_found", "message": "no record"}));
    Ok(match kind {
        "create" => Op::Create(it::Create {
            id: collection::fixture_id(&format!("new:{path}:{}", input["frontmatter"])),
            path: input["path"].as_str().map(str::to_owned),
            type_name: input["type"].as_str().map(str::to_owned),
            frontmatter: input.get("frontmatter").map(core_map),
            body: input["body"].as_str().map(str::to_owned),
            document: input["document"].as_str().map(str::to_owned),
        }),
        "update" if input.get("document").is_some() => {
            let id = existing()?;
            let rec = state.record(&id).ok_or(Value::Null)?;
            Op::Document(it::DocumentOp {
                id,
                base: Some(it::DocVersion {
                    path: rec.path.clone(),
                    doc: rec.source.to_string(),
                }),
                new: Some(it::DocVersion {
                    path: rec.path.clone(),
                    doc: input["document"].as_str().unwrap_or("").to_owned(),
                }),
                if_revision: hash_of(&input["if_revision"]),
            })
        }
        "update" => Op::Update(it::Update {
            id: existing()?,
            patch: input.get("patch").map(core_map),
            unset: str_list(&input["unset"]),
            add: pairs(&input["add"]),
            remove: pairs(&input["remove"]),
            body: input["body"].as_str().map(str::to_owned),
            body_edits: input["body_edits"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|e| it::BodyEdit {
                    start: e["start"].as_u64().unwrap_or(0),
                    end: e["end"].as_u64().unwrap_or(0),
                    insert: e["text"].as_str().unwrap_or("").to_owned(),
                })
                .collect(),
            body_base: hash_of(&input["body_base"]),
            body_base_text: input["body_base_text"].as_str().map(str::to_owned),
            base: Vec::new(),
            if_revision: hash_of(&input["if_revision"]),
        }),
        "delete" => Op::Delete(it::Delete {
            id: existing()?,
            base_revision: None,
            if_revision: hash_of(&input["if_revision"]),
        }),
        "rename" => {
            let from = input["from"].as_str().unwrap_or("");
            Op::Rename(it::Rename {
                id: id_at(state, from)
                    .ok_or_else(|| json!({"code": "not_found", "message": "no record"}))?,
                from: from.to_owned(),
                to: input["to"].as_str().unwrap_or("").to_owned(),
                update_refs: input["update_refs"].as_bool().unwrap_or(false),
                if_revision: hash_of(&input["if_revision"]),
            })
        }
        other => return Err(json!({"code": "unsupported", "message": other})),
    })
}

fn mutation(ops: Vec<Op>) -> Mutation {
    Mutation {
        id: Uuid::NIL,
        origin: Uuid::NIL,
        base_seq: 0,
        clock: OpClock {
            instant_ms: FIXTURE_INSTANT,
            tz: "UTC".into(),
            local_date: "2026-01-01".into(),
        },
        seed: [0; 32],
        source: Source::Api,
        ops,
        on_behalf: None,
        conflict_mode: it::ConflictMode::Record,
        validated_at: None,
        room: None,
    }
}

/// The spec code a rejection corresponds to (spec 12 / 14 diagnostics).
fn spec_code(r: &Rejection) -> String {
    let reason = r.reason.as_deref().unwrap_or("");
    match r.code {
        RejectCode::Conflict => match reason {
            "path_taken" => "path_conflict",
            "duplicate_value" => "duplicate_value",
            _ => "concurrent_modification",
        }
        .to_owned(),
        RejectCode::InvalidRequest => match reason {
            "duplicate_batch_path"
            | "invalid_frontmatter"
            | "type_membership_changed"
            | "path_value_invalid"
            | "path_value_missing"
            | "path_traversal"
            | "type_conflict"
            | "lifecycle_expression_error"
            | "invalid_timezone" => reason.to_owned(),
            _ => "invalid_request".to_owned(),
        },
        RejectCode::InvalidRecord => "invalid_record".to_owned(),
        other => other.as_str().to_owned(),
    }
}

fn rejection_json(r: &Rejection) -> Value {
    let mut details = r.details.as_ref().map(from_core).unwrap_or(json!({}));
    if let (Some(reason), Value::Object(d)) = (&r.reason, &mut details)
        && !d.contains_key("reason")
    {
        d.insert("reason".into(), json!(reason));
    }
    if r.code == RejectCode::Conflict
        && let Value::Object(d) = &mut details
        && matches!(r.reason.as_deref(), Some("body"))
    {
        d.insert("reason".into(), json!("body_conflict"));
    }
    let mut out = json!({
        "code": spec_code(r),
        "message": r.message,
        "details": details,
    });
    if let Some(f) = out["details"].get("field").cloned() {
        out["field"] = f;
    }
    out
}

/// A record as the fixtures read it.
fn record_json(state: &dyn StateView, id: &Uuid) -> Value {
    let Some(rec) = state.record(id) else {
        return json!({});
    };
    let catalog = state.catalog();
    let doc = Document::parse_at(&rec.path, &*rec.source);
    let fm = doc.frontmatter();
    let types = catalog.membership(&rec.path, fm).types;
    let effective = catalog.effective_frontmatter(&types, fm);
    json!({
        "path": rec.path,
        "frontmatter": from_core(&mdbn_core::value::Value::Map(fm.clone())),
        "effective_frontmatter": from_core(&mdbn_core::value::Value::Map(effective)),
        "body": doc.body(),
        "document": &*rec.source,
        "types": types,
    })
}

/// Fill the subset-assertion keys of `expect` from `actual`.
fn assertions(expect: &Value, out: &mut Value) {
    let fm = out["frontmatter"].clone();
    if let Some(keys) = expect
        .get("frontmatter_not_contains")
        .and_then(Value::as_array)
    {
        let absent: Vec<Value> = keys
            .iter()
            .filter(|k| k.as_str().is_some_and(|k| fm.get(k).is_none()))
            .cloned()
            .collect();
        out["frontmatter_not_contains"] = Value::Array(absent);
    }
    if let Some(Value::Object(want)) = expect.get("frontmatter_contains") {
        let mut got = Map::new();
        for (k, w) in want {
            let Some(actual) = fm.get(k) else { continue };
            let ok = match w {
                Value::Object(m) if m.contains_key("matches") || m.contains_key("format") => {
                    let s = actual.as_str().unwrap_or("");
                    m.get("matches")
                        .and_then(Value::as_str)
                        .is_none_or(|p| mdbn_core::regex::is_match(p, s).unwrap_or(false))
                        && m.get("format").and_then(Value::as_str).is_none_or(|f| {
                            let schema = mdbn_core::value::Value::Map(
                                [("format".to_owned(), mdbn_core::value::Value::string(f))]
                                    .into_iter()
                                    .collect(),
                            );
                            mdbn_core::jsonschema::compile(&schema, "")
                                .map(|c| c.validate(&crate::ops::to_core(actual)).is_empty())
                                .unwrap_or(false)
                        })
                }
                other => matches(other, actual),
            };
            if ok {
                got.insert(k.clone(), w.clone());
            }
        }
        out["frontmatter_contains"] = Value::Object(got);
    }
    if let Some(Value::String(want)) = expect.get("body_contains") {
        let body = out["body"].as_str().unwrap_or("");
        out["body_contains"] = json!(if body.contains(want.as_str()) {
            want.as_str()
        } else {
            ""
        });
    }
}

fn plan_on(state: &MemState, ops: Vec<Op>, dry: bool) -> (Result<Planned, Rejection>, MemState) {
    let level = state.catalog().settings().validation;
    let m = mutation(ops);
    let res = mdbn_core::plan(
        &m,
        state,
        &PlanOptions {
            stage: Stage::Submit { level },
        },
    );
    let mut after = state.clone();
    if let (Ok(p), false) = (&res, dry) {
        after.apply(p);
    }
    (res, after)
}

fn issues_json(p: &Planned) -> Vec<Value> {
    p.issues.iter().map(|i| issue_json(&i.issue)).collect()
}

/// `create`, `update`, `delete`, `rename`.
pub fn write(group: Group<'_>, kind: &str, input: &Value) -> Result<Value, Unsupported> {
    let state = collection::build(group.setup);
    let op = match op_of(&state, kind, input) {
        Ok(op) => op,
        Err(e) => return Ok(json!({"valid": false, "error": e})),
    };
    let target = match &op {
        Op::Create(c) => c.id,
        Op::Update(u) => u.id,
        Op::Document(d) => d.id,
        Op::Delete(d) => d.id,
        Op::Rename(r) => r.id,
        _ => Uuid::NIL,
    };
    let before = record_json(&state, &target);
    let (res, after) = plan_on(&state, vec![op], false);
    let mut out = match res {
        Ok(p) => {
            let mut r = record_json(&after, &target);
            r["valid"] = json!(true);
            r["diagnostics"] = Value::Array(issues_json(&p));
            r["references_updated"] = Value::Array(
                p.link_rewrites
                    .iter()
                    .map(|w| {
                        let mut m = json!({"path": w.path, "old_value": w.old_value, "new_value": w.new_value});
                        match &w.field {
                            Some(f) => m["field"] = json!(f),
                            None => m["location"] = json!("body"),
                        }
                        m
                    })
                    .collect(),
            );
            r["broken_links"] = Value::Array(
                p.broken_links
                    .iter()
                    .map(|b| json!({"path": b.path, "field": b.field, "value": b.value}))
                    .collect(),
            );
            r
        }
        Err(e) => {
            let error = rejection_json(&e);
            let mut diags: Vec<Value> = e.issues.iter().map(issue_json).collect();
            if diags.is_empty() {
                let mut d = json!({"code": error["code"], "severity": "error", "message": error["message"]});
                if let Some(f) = error.get("field") {
                    d["field"] = f.clone();
                }
                diags.push(d);
            }
            json!({"valid": false, "error": error, "diagnostics": diags, "issues": diags})
        }
    };
    if let Some(want) = group
        .expect
        .get("frontmatter_changed")
        .and_then(Value::as_array)
    {
        let changed: Vec<Value> = want
            .iter()
            .filter(|k| {
                k.as_str()
                    .is_some_and(|k| before["frontmatter"].get(k) != out["frontmatter"].get(k))
            })
            .cloned()
            .collect();
        out["frontmatter_changed"] = Value::Array(changed);
    }
    assertions(group.expect, &mut out);
    Ok(out)
}

/// `read`.
pub fn read(group: Group<'_>, input: &Value) -> Result<Value, Unsupported> {
    use mdbn_core::validate as v;
    let state = collection::build(group.setup);
    let path = input["path"].as_str().unwrap_or("");
    let Some(id) = id_at(&state, path) else {
        return Ok(json!({"valid": false, "error": {"code": "not_found"}}));
    };
    let catalog = state.catalog();
    let rec = state
        .record(&id)
        .ok_or(Unsupported::NotImplemented("record"))?;
    let mut issues = v::validate_record(&catalog, &rec.path, &rec.source);
    issues.extend(v::cross_record_issues(&state, id));
    let issues = v::apply_level(issues, catalog.settings().validation, false);
    let mut out = record_json(&state, &id);
    out["valid"] = json!(!issues.iter().any(|i| i.severity == Severity::Error));
    out["diagnostics"] = Value::Array(issues.iter().map(issue_json).collect());
    assertions(group.expect, &mut out);
    Ok(out)
}

/// `batch`: atomic (one mutation), partial (one mutation per item), or dry run.
pub fn batch(group: Group<'_>, input: &Value) -> Result<Value, Unsupported> {
    let state = collection::build(group.setup);
    let items: Vec<&Value> = input["operations"]
        .as_array()
        .into_iter()
        .flatten()
        .collect();
    let dry = input["dry_run"].as_bool().unwrap_or(false);
    let partial = input["allow_partial"].as_bool().unwrap_or(false);
    let mut ops = Vec::new();
    for it in &items {
        match op_of(&state, it["kind"].as_str().unwrap_or(""), &it["input"]) {
            Ok(op) => ops.push(op),
            Err(e) => return Ok(json!({"valid": false, "error": e})),
        }
    }
    let n = ops.len();
    if partial {
        let mut cur = state;
        let mut results = Vec::new();
        let mut ok = 0u64;
        for (i, op) in ops.into_iter().enumerate() {
            let (res, after) = plan_on(&cur, vec![op], dry);
            results.push(json!({"index": i, "kind": items[i]["kind"], "valid": res.is_ok()}));
            if res.is_ok() {
                ok += 1;
                cur = after;
            }
        }
        let failed = n as u64 - ok;
        return Ok(
            json!({"valid": failed == 0, "succeeded": ok, "failed": failed, "operations": results, "dry_run": dry, "preflight": dry}),
        );
    }
    let (res, _) = plan_on(&state, ops, dry);
    Ok(match res {
        Ok(_) => {
            json!({"valid": true, "succeeded": n, "failed": 0, "preflight": dry, "dry_run": dry})
        }
        Err(e) => {
            let code = spec_code(&e);
            if code == "duplicate_batch_path" {
                json!({"valid": false, "error": {"code": code}})
            } else {
                let i = e.op_index.unwrap_or(0);
                json!({
                    "valid": false,
                    "failed": 1,
                    "preflight": true,
                    "error": rejection_json(&e),
                    "operations": [{"index": i, "kind": items.get(i as usize).map(|x| x["kind"].clone()), "valid": false}],
                })
            }
        }
    })
}

/// `query`: the reference executor over the fixture collection.
pub fn query(group: Group<'_>, input: &Value) -> Result<Value, Unsupported> {
    use mdbn_core::query::{self as q, QueryEnv};
    let state = collection::build(group.setup);
    let parsed = match q::Query::from_value(&crate::ops::to_core(input)) {
        Ok(p) => p,
        Err(e) => {
            return Ok(json!({"valid": false, "error": {"code": e.code, "message": e.message}}));
        }
    };
    let plan = match q::compile(&parsed, &state.catalog()) {
        Ok(p) => p,
        Err(e) => {
            return Ok(json!({"valid": false, "error": {"code": e.code, "message": e.message}}));
        }
    };
    let env = QueryEnv {
        now_ms: FIXTURE_INSTANT,
        tz: "UTC".into(),
        today: "2026-01-01".into(),
    };
    let page = match q::execute(&plan, &state, &env) {
        Ok(page) => page,
        Err(e) => {
            return Ok(json!({"valid": false, "error": {"code": e.code, "message": e.message}}));
        }
    };
    let mut meta = json!({"total_count": page.total_count, "has_more": page.has_more});
    if let Some(groups) = &page.groups {
        meta["groups"] = json!(
            groups
                .iter()
                .map(|g| json!({
                    "values": from_core(&mdbn_core::value::Value::Map(g.values.clone())),
                    "count": g.count,
                    "summaries": from_core(&mdbn_core::value::Value::Map(g.summaries.clone())),
                }))
                .collect::<Vec<_>>()
        );
    }
    let paths: Vec<Value> = page.ids.iter().map(|id| path_of(&state, id)).collect();
    Ok(json!({
        "valid": true,
        "results": paths
            .iter()
            .zip(&page.values)
            .map(|(p, v)| {
                if plan.select.is_empty() {
                    json!({"path": p})
                } else {
                    json!({"path": p, "values": from_core(&mdbn_core::value::Value::Map(v.clone()))})
                }
            })
            .collect::<Vec<_>>(),
        "paths": paths,
        "meta": meta,
        "diagnostics": page.diagnostics.iter().map(issue_json).collect::<Vec<_>>(),
    }))
}

/// `get_type`: a type definition as loaded (its frontmatter).
pub fn get_type(group: Group<'_>, input: &Value) -> Result<Value, Unsupported> {
    let state = collection::build(group.setup);
    let catalog = state.catalog();
    Ok(
        match catalog.type_named(input["name"].as_str().unwrap_or("")) {
            Some(t) => {
                json!({"valid": true, "type": from_core(&mdbn_core::value::Value::Map(t.raw.clone()))})
            }
            None => json!({"valid": false, "error": {"code": "not_found"}}),
        },
    )
}

// ---------------------------------------------------------- data contracts

/// A vendored spec file (`examples/...`, `tests/v0.3/fixtures/...`).
fn spec_file(path: &str) -> String {
    std::fs::read_to_string(crate::repo_root().join("conformance/spec").join(path))
        .unwrap_or_default()
}

/// A contract and a type loaded together as a two-resource catalog.
fn contract_and_type(input: &Value) -> mdbn_core::types::Catalog {
    let mut resources: Vec<(String, String)> = Vec::new();
    if let Some(c) = input["contract"].as_str() {
        resources.push(("_contracts/contract.md".into(), spec_file(c)));
    }
    if let Some(t) = input["type"].as_str() {
        resources.push(("_types/type.md".into(), spec_file(t)));
    }
    mdbn_core::types::Catalog::load(resources.iter().map(|(p, s)| (p.as_str(), s.as_str())))
}

fn error_text(issues: &[mdbn_core::validate::Issue]) -> String {
    issues
        .iter()
        .filter(|i| i.severity == Severity::Error)
        .map(|i| format!("{}: {}", i.code.replace('_', " "), i.message))
        .collect::<Vec<_>>()
        .join("; ")
}

/// `data_contract_implementation_validate`: a type's implementation of a
/// contract, and optionally a record's contract view.
pub fn data_contract_implementation_validate(
    input: &Value,
    expect: &Value,
) -> Result<Value, Unsupported> {
    let catalog = contract_and_type(input);
    let mut problems = error_text(catalog.issues());
    let imps = catalog.implementations();
    if problems.is_empty() && imps.len() != 1 {
        problems = format!(
            "the type must declare exactly one implementation of the contract, found {}",
            imps.len()
        );
    }
    if problems.is_empty()
        && let Some(r) = input["record"].as_str()
    {
        let imp = &imps[0];
        let contract = catalog
            .contract(&imp.contract, &imp.version)
            .ok_or(Unsupported::NotImplemented("contract"))?;
        let fm = match mdbn_core::yaml::parse_value(&spec_file(r)) {
            Ok(Some(mdbn_core::value::Value::Map(m))) => m,
            _ => mdbn_core::value::Map::new(),
        };
        let effective = catalog.effective_frontmatter(std::slice::from_ref(&imp.type_name), &fm);
        if let Err(errs) = imp.view(contract, &effective) {
            problems = error_text(&errs);
        }
    }
    let mut out = json!({"valid": problems.is_empty()});
    if let Some(want) = expect["error_contains"].as_str() {
        out["error_contains"] = json!(if problems.contains(want) {
            want
        } else {
            problems.as_str()
        });
    }
    Ok(out)
}

/// `data_contract_digest`.
pub fn data_contract_digest(input: &Value) -> Result<Value, Unsupported> {
    let catalog = contract_and_type(input);
    Ok(match catalog.contracts().first() {
        Some(c) => json!({"digest": c.digest.to_string()}),
        None => json!({"valid": false, "error": error_text(catalog.issues())}),
    })
}

/// `data_contract_implementation_digest`.
pub fn data_contract_implementation_digest(input: &Value) -> Result<Value, Unsupported> {
    let catalog = contract_and_type(input);
    Ok(match catalog.implementations().first() {
        Some(i) => json!({"digest": i.digest.to_string()}),
        None => json!({"valid": false, "error": error_text(catalog.issues())}),
    })
}

/// `data_contract_registry_validate`: load several contract files together.
pub fn data_contract_registry_validate(
    input: &Value,
    expect: &Value,
) -> Result<Value, Unsupported> {
    let files: Vec<(String, String)> = input["paths"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(i, p)| {
            p.as_str()
                .map(|p| (format!("_contracts/c{i}.md"), spec_file(p)))
        })
        .collect();
    let catalog =
        mdbn_core::types::Catalog::load(files.iter().map(|(p, s)| (p.as_str(), s.as_str())));
    let problems = error_text(catalog.issues());
    let mut out = json!({"valid": problems.is_empty()});
    if let Some(want) = expect["error_contains"].as_str() {
        out["error_contains"] = json!(if problems.contains(want) {
            want
        } else {
            problems.as_str()
        });
    }
    Ok(out)
}

/// `get_data_contracts`: the implementations of a contract.
pub fn get_data_contracts(group: Group<'_>, input: &Value) -> Result<Value, Unsupported> {
    let state = collection::build(group.setup);
    let catalog = state.catalog();
    Ok(
        match catalog.implementations_of(
            input["contract"].as_str().unwrap_or(""),
            input["version"].as_str(),
        ) {
            Ok(imps) => json!({
                "valid": true,
                "implementations": imps.iter().map(|i| json!({
                    "type": i.type_name,
                    "contract": i.contract,
                    "version": i.version.to_string(),
                    "contract_digest": i.contract_digest.to_string(),
                    "implementation_digest": i.digest.to_string(),
                })).collect::<Vec<_>>(),
            }),
            Err(e) => json!({"valid": false, "error": issue_json(&e)}),
        },
    )
}

/// `get_contract_view`: a record seen through a contract.
pub fn get_contract_view(group: Group<'_>, input: &Value) -> Result<Value, Unsupported> {
    let state = collection::build(group.setup);
    let catalog = state.catalog();
    let path = input["path"].as_str().unwrap_or("");
    let Some(rec) = id_at(&state, path).and_then(|id| state.record(&id)) else {
        return Ok(json!({"valid": false, "error": {"code": "not_found"}}));
    };
    let doc = Document::parse_at(&rec.path, &*rec.source);
    let types = catalog.membership(&rec.path, doc.frontmatter()).types;
    let imps = match catalog.implementations_of(
        input["contract"].as_str().unwrap_or(""),
        input["version"].as_str(),
    ) {
        Ok(i) => i,
        Err(e) => return Ok(json!({"valid": false, "error": issue_json(&e)})),
    };
    let Some(imp) = imps
        .into_iter()
        .find(|i| types.iter().any(|t| t.eq_ignore_ascii_case(&i.type_name)))
    else {
        return Ok(json!({"valid": false, "error": {"code": "data_contract_not_found"}}));
    };
    let contract = catalog
        .contract(&imp.contract, &imp.version)
        .ok_or(Unsupported::NotImplemented("contract"))?;
    let effective = catalog.effective_frontmatter(&types, doc.frontmatter());
    Ok(match imp.view(contract, &effective) {
        Ok(v) => {
            json!({"valid": true, "view": from_core(&mdbn_core::value::Value::Map(v)), "type": imp.type_name})
        }
        Err(errs) => {
            json!({"valid": false, "diagnostics": errs.iter().map(issue_json).collect::<Vec<_>>()})
        }
    })
}

// -------------------------------------------------------------- type packs

const INSTALLER: &str = "dev.mdbase.conformance";

#[allow(clippy::result_large_err)]
fn load_spec_pack(
    manifest_path: &str,
    corrupt: bool,
) -> Result<mdbn_core::packs::Pack, mdbn_core::validate::Issue> {
    let dir = manifest_path
        .rsplit_once('/')
        .map_or("", |(d, _)| d)
        .to_owned();
    let mut manifest = spec_file(manifest_path);
    if corrupt {
        // Flip one hex digit of the first resource digest.
        if let Some(i) = manifest.find("sha256:") {
            let at = i + 7;
            let c = if &manifest[at..=at] == "0" { "1" } else { "0" };
            manifest.replace_range(at..=at, c);
        }
    }
    mdbn_core::packs::load_pack(&manifest, &|src| {
        let p = crate::repo_root()
            .join("conformance/spec")
            .join(&dir)
            .join(src);
        std::fs::read_to_string(p).ok()
    })
}

#[allow(clippy::result_large_err)]
fn run_ops(state: &mut MemState, ops: Vec<Op>) -> Result<(), Rejection> {
    if ops.is_empty() {
        return Ok(());
    }
    let p = mdbn_core::plan(&mutation(ops), &*state, &PlanOptions { stage: Stage::Head })?;
    state.apply(&p);
    Ok(())
}

fn pack_opts(adopt: &BTreeMap<String, Hash>) -> mdbn_core::packs::AssessOptions {
    mdbn_core::packs::AssessOptions {
        installed_by: INSTALLER.into(),
        adopt: adopt.clone(),
        ..Default::default()
    }
}

use std::collections::BTreeMap;

fn assessment_json(a: &mdbn_core::packs::Assessment) -> Value {
    json!({
        "valid": true,
        "status": a.status.as_str(),
        "applicable": a.applicable(),
        "actions": a.resources.iter().map(|r| r.action.as_str()).collect::<Vec<_>>(),
        "resources": a.resources.iter().map(|r| {
            let mut m = json!({"target": r.target, "action": r.action.as_str(), "reason": r.reason.is_some()});
            if let Some((_, v)) = r.upgrade_baseline {
                m["upgrade_baseline_version"] = json!(v);
            }
            m
        }).collect::<Vec<_>>(),
    })
}

/// Run `input.history` steps on `state`.
fn pack_history(state: &mut MemState, input: &Value) -> Result<(), String> {
    for step in input["history"].as_array().into_iter().flatten() {
        if let Some(p) = step["apply"].as_str() {
            let pack = load_spec_pack(p, false).map_err(|e| e.message)?;
            let opts = pack_opts(&BTreeMap::new());
            let a =
                mdbn_core::packs::assess_type_pack(&*state, &pack, &opts).map_err(|e| e.message)?;
            let (_, ops) =
                mdbn_core::packs::apply_type_pack(&*state, &pack, &opts, &a.assessment_digest)
                    .map_err(|e| e.message)?;
            run_ops(state, ops).map_err(|e| e.message)?;
        } else if let Some(w) = step.get("write") {
            let path = w["path"].as_str().unwrap_or("");
            state.insert_resource(path, w["content"].as_str().unwrap_or(""));
        } else if let Some(r) = step.get("replace") {
            let path = r["path"].as_str().unwrap_or("");
            let cur = state
                .resource(path)
                .map(|s| s.to_string())
                .unwrap_or_default();
            let (old, new) = (
                r["old"].as_str().unwrap_or(""),
                r["new"].as_str().unwrap_or(""),
            );
            if cur.matches(old).count() != 1 {
                return Err(format!(
                    "replace: `{old}` does not occur exactly once in {path}"
                ));
            }
            state.insert_resource(path, &cur.replacen(old, new, 1));
        }
    }
    Ok(())
}

/// Fixture files under `setup.files` that are resources (`_types/...`).
fn pack_state(group: Group<'_>) -> MemState {
    collection::build(group.setup)
}

/// `assess_type_pack` / `apply_type_pack`.
pub fn type_pack(group: Group<'_>, input: &Value, apply: bool) -> Result<Value, Unsupported> {
    use mdbn_core::packs::{apply_type_pack, assess_type_pack};
    let expect = group.expect;
    let mut state = pack_state(group);
    if let Err(e) = pack_history(&mut state, input) {
        return Ok(json!({"valid": false, "error": {"code": "history_failed", "message": e}}));
    }
    let pack_path = input["pack"].as_str().unwrap_or("");
    let pack = match load_spec_pack(
        pack_path,
        input["corrupt_digest"].as_bool().unwrap_or(false),
    ) {
        Ok(p) => p,
        Err(e) => {
            let targets = targets_exist(&state, pack_path);
            return Ok(
                json!({"valid": false, "error": {"code": e.code, "message": e.message}, "targets_exist": targets}),
            );
        }
    };
    let before: BTreeMap<String, Option<String>> = pack
        .resources
        .iter()
        .map(|r| {
            (
                r.target.clone(),
                state.resource(&r.target).map(|s| s.to_string()),
            )
        })
        .collect();
    // Install, then modify a managed target.
    if let Some(t) = input["install_then_modify"].as_str() {
        let opts = pack_opts(&BTreeMap::new());
        let a = assess_type_pack(&state, &pack, &opts)
            .map_err(|_| Unsupported::NotImplemented("assess"))?;
        if let Ok((_, ops)) = apply_type_pack(&state, &pack, &opts, &a.assessment_digest) {
            let _ = run_ops(&mut state, ops);
        }
        let cur = state.resource(t).map(|s| s.to_string()).unwrap_or_default();
        state.insert_resource(t, &format!("{cur}\nUser edit.\n"));
    }
    let mut adopt = BTreeMap::new();
    if input["adopt_conflicts"].as_bool().unwrap_or(false) {
        for r in &pack.resources {
            if let Some(cur) = state.resource(&r.target) {
                adopt.insert(r.target.clone(), mdbn_core::ids::revision(&cur));
            }
        }
    }
    let opts = pack_opts(&adopt);
    if !apply {
        return Ok(match assess_type_pack(&state, &pack, &opts) {
            Ok(a) => assessment_json(&a),
            Err(e) => json!({"valid": false, "error": {"code": e.code, "message": e.message}}),
        });
    }
    let repeat = input["repeat"].as_u64().unwrap_or(1);
    let mut runs = Vec::new();
    let mut first: Option<Value> = None;
    for _ in 0..repeat {
        let a = match assess_type_pack(&state, &pack, &opts) {
            Ok(a) => a,
            Err(e) => {
                return Ok(
                    json!({"valid": false, "error": {"code": e.code, "message": e.message}}),
                );
            }
        };
        if let Some(t) = input["mutate_after_assess"].as_str() {
            let cur = state.resource(t).map(|s| s.to_string()).unwrap_or_default();
            state.insert_resource(t, &format!("{cur}\nConcurrent edit.\n"));
        }
        match apply_type_pack(&state, &pack, &opts, &a.assessment_digest) {
            Ok((a, ops)) => {
                if let Err(r) = run_ops(&mut state, ops) {
                    return Ok(
                        json!({"valid": false, "error": {"code": "type_pack_apply_failed", "message": r.message}}),
                    );
                }
                let j = assessment_json(&a);
                first.get_or_insert_with(|| j.clone());
                runs.push(json!({"valid": true, "status": j["status"], "actions": j["actions"]}));
            }
            Err(e) => {
                return Ok(json!({
                    "valid": false,
                    "error": {"code": e.code, "message": e.message},
                    "targets_exist": targets_exist(&state, pack_path),
                }));
            }
        }
    }
    let mut out = json!({
        "valid": true,
        "runs": runs,
        "lock_exists": state.resource(mdbn_core::types::LOCK_PATH).is_some(),
        "implementations": state.catalog().implementations().len(),
        "resources": first.as_ref().map(|f| f["resources"].clone()).unwrap_or(Value::Null),
        "targets_exist": targets_exist(&state, pack_path),
    });
    let src_dir = |p: &str| crate::repo_root().join("conformance/spec").join(p);
    if let Some(Value::Object(m)) = expect.get("target_matches_source") {
        let mut got = Map::new();
        for (t, srcp) in m {
            let want =
                std::fs::read_to_string(src_dir(srcp.as_str().unwrap_or(""))).unwrap_or_default();
            if state.resource(t).as_deref() == Some(want.as_str()) {
                got.insert(t.clone(), srcp.clone());
            }
        }
        out["target_matches_source"] = Value::Object(got);
    }
    if let Some(list) = expect.get("target_unchanged").and_then(Value::as_array) {
        out["target_unchanged"] = Value::Array(
            list.iter()
                .filter(|t| {
                    t.as_str().is_some_and(|t| {
                        before.get(t).cloned().flatten() == state.resource(t).map(|s| s.to_string())
                    })
                })
                .cloned()
                .collect(),
        );
    }
    if let Some(Value::Object(m)) = expect.get("target_frontmatter") {
        let mut got = Map::new();
        for (t, ptrs) in m {
            let doc = state.resource(t).map(|s| s.to_string()).unwrap_or_default();
            let fm = Value::Object(
                from_core(&mdbn_core::value::Value::Map(
                    Document::parse_at(t, doc).frontmatter().clone(),
                ))
                .as_object()
                .cloned()
                .unwrap_or_default(),
            );
            let mut sub = Map::new();
            for (ptr, want) in ptrs.as_object().into_iter().flatten() {
                if fm.pointer(ptr).is_some_and(|v| matches(want, v)) {
                    sub.insert(ptr.clone(), want.clone());
                }
            }
            got.insert(t.clone(), Value::Object(sub));
        }
        out["target_frontmatter"] = Value::Object(got);
    }
    if let Some(Value::Object(m)) = expect.get("target_body_contains") {
        let mut got = Map::new();
        for (t, wants) in m {
            let doc = state.resource(t).map(|s| s.to_string()).unwrap_or_default();
            let found: Vec<Value> = wants
                .as_array()
                .into_iter()
                .flatten()
                .filter(|w| w.as_str().is_some_and(|w| doc.contains(w)))
                .cloned()
                .collect();
            got.insert(t.clone(), Value::Array(found));
        }
        out["target_body_contains"] = Value::Object(got);
    }
    if let Some(Value::Object(m)) = expect.get("lock_origin") {
        let lock = state
            .resource(mdbn_core::types::LOCK_PATH)
            .and_then(|s| mdbn_core::packs::Lock::parse(&s).ok())
            .unwrap_or_default();
        let mut got = Map::new();
        for (t, want) in m {
            let origin = lock
                .packs
                .iter()
                .flat_map(|p| &p.resources)
                .find(|r| r.target == *t)
                .and_then(|r| r.origin_digest);
            let ok = match (want.as_str(), origin) {
                (Some("absent"), None) => true,
                (Some(src), Some(o)) => {
                    mdbn_core::ids::revision(
                        &std::fs::read_to_string(src_dir(src)).unwrap_or_default(),
                    ) == o
                }
                _ => false,
            };
            if ok {
                got.insert(t.clone(), want.clone());
            }
        }
        out["lock_origin"] = Value::Object(got);
    }
    Ok(out)
}

/// Whether each target of the pack at `manifest_path` exists (manifest order).
fn targets_exist(state: &MemState, manifest_path: &str) -> Vec<bool> {
    let manifest = spec_file(manifest_path);
    let targets: Vec<String> = match mdbn_core::yaml::parse_value(&manifest) {
        Ok(Some(v)) => v
            .get("resources")
            .and_then(mdbn_core::value::Value::as_list)
            .into_iter()
            .flatten()
            .filter_map(|r| {
                r.get("target")
                    .and_then(mdbn_core::value::Value::as_str)
                    .map(str::to_owned)
            })
            .collect(),
        _ => Vec::new(),
    };
    targets
        .iter()
        .map(|t| state.resource(t).is_some())
        .collect()
}
