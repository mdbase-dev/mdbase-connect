//! The helpers against the vendored spec fixtures (`conformance/spec`), the
//! same digests the conformance ratchet checks.

use serde_json::{Value, json};

/// Vendored spec fixtures, compiled in (portable crates do no I/O, not even in
/// tests).
const SPEC: &[(&str, &str)] = &[
    (
        "examples/v0.3/tasknotes-migration/v0.3/_contracts/tasknotes.task.md",
        include_str!(
            "../../../conformance/spec/examples/v0.3/tasknotes-migration/v0.3/_contracts/tasknotes.task.md"
        ),
    ),
    (
        "examples/v0.3/tasknotes-migration/v0.3/_types/task.md",
        include_str!(
            "../../../conformance/spec/examples/v0.3/tasknotes-migration/v0.3/_types/task.md"
        ),
    ),
    (
        "examples/v0.3/tasknotes-migration/v0.3/mdbase-pack.yaml",
        include_str!(
            "../../../conformance/spec/examples/v0.3/tasknotes-migration/v0.3/mdbase-pack.yaml"
        ),
    ),
    (
        "tests/v0.3/fixtures/data-contracts/json-pointer-contact.contract.md",
        include_str!(
            "../../../conformance/spec/tests/v0.3/fixtures/data-contracts/json-pointer-contact.contract.md"
        ),
    ),
    (
        "tests/v0.3/fixtures/data-contracts/json-pointer-contact.yml",
        include_str!(
            "../../../conformance/spec/tests/v0.3/fixtures/data-contracts/json-pointer-contact.yml"
        ),
    ),
];

fn spec_file(p: &str) -> String {
    SPEC.iter()
        .find(|(k, _)| *k == p)
        .map(|(_, s)| (*s).to_owned())
        .unwrap_or_else(|| panic!("{p}: not in SPEC"))
}

fn call(op: &str, input: Value) -> Value {
    let out = mdbase_wasm::call(op, &input.to_string());
    serde_json::from_str(&out).unwrap()
}

fn ok(op: &str, input: Value) -> Value {
    let v = call(op, input);
    assert!(v.get("error").is_none(), "{op}: {v}");
    v["ok"].clone()
}

const CONTRACT: &str = "examples/v0.3/tasknotes-migration/v0.3/_contracts/tasknotes.task.md";
const TYPE: &str = "examples/v0.3/tasknotes-migration/v0.3/_types/task.md";

#[test]
fn info_lists_ops() {
    let i = ok("info", json!({}));
    assert_eq!(i["abi"], 1);
    assert!(i["ops"].as_array().unwrap().len() > 5);
    assert_eq!(i["spec_versions"][0], "0.3.0");
}

#[test]
fn contract_digest_matches_the_spec_fixture() {
    let c = ok("contract_digest", json!({"source": spec_file(CONTRACT)}));
    assert_eq!(
        c["digest"],
        "sha256:a49d25136bf3024e146017771d068cdf59abfddbcdd1bfbf8010018c7f13f476"
    );
    assert_eq!(c["id"], "tasknotes.task");
    assert_eq!(c["contract_type"], "record");
}

#[test]
fn contract_digest_from_frontmatter_object_equals_the_file() {
    let from_file = ok("contract_digest", json!({"source": spec_file(CONTRACT)}));
    let fm: Value = {
        let src = spec_file(CONTRACT);
        let yaml = src
            .trim_start_matches("---\n")
            .split("\n---")
            .next()
            .unwrap();
        // Round-trip through the core: parse YAML → JSON object via load_catalog's raw.
        let cat = ok(
            "load_catalog",
            json!({"resources": {"_contracts/c.md": src}}),
        );
        let _ = yaml;
        let c = &cat["contracts"][0];
        // Rebuild the frontmatter the way an app holds it: top-level fields plus
        // schema wrappers with inline values.
        let mut fm = json!({
            "kind": "mdbase.contract",
            "contract_type": c["contract_type"],
            "id": c["id"],
            "version": c["version"],
            "name": c["name"],
        });
        for (member, s) in c["schemas"].as_object().unwrap() {
            fm[member] = json!({"dialect": "json-schema-2020-12", "value": s["value"]});
        }
        fm
    };
    let from_object = ok("contract_digest", json!({"frontmatter": fm}));
    assert_eq!(from_object["digest"], from_file["digest"]);
}

#[test]
fn implementation_digest_matches_the_spec_fixture() {
    let i = ok(
        "implementation_digest",
        json!({"contract": {"source": spec_file(CONTRACT)}, "type": {"source": spec_file(TYPE)}}),
    );
    assert_eq!(
        i["digest"],
        "sha256:b994d1fdbc6e7a787393e033520afbcfbe6b715ae87ab62a09e24981811c4730"
    );
    assert_eq!(
        i["contract_digest"],
        "sha256:a49d25136bf3024e146017771d068cdf59abfddbcdd1bfbf8010018c7f13f476"
    );
}

#[test]
fn ref_wrappers_resolve_through_resources() {
    let dir = "tests/v0.3/fixtures/data-contracts";
    let c = ok(
        "contract_digest",
        json!({
            "path": "_contracts/json-pointer-contact.contract.md",
            "source": spec_file(&format!("{dir}/json-pointer-contact.contract.md")),
            "resources": {
                "_contracts/json-pointer-contact.yml": spec_file(&format!("{dir}/json-pointer-contact.yml")),
            }
        }),
    );
    assert_eq!(c["id"], "example.typed-contact");
    assert!(c["schemas"]["record_schema"]["value"]["properties"].is_object());
}

#[test]
fn invalid_contract_is_an_error_with_a_code() {
    let v = call(
        "contract_digest",
        json!({"source": "---\nkind: nope\n---\n"}),
    );
    assert!(v["error"]["code"].is_string(), "{v}");
    assert!(v["error"]["message"].as_str().unwrap().len() > 10);
}

#[test]
fn catalog_loads_types_and_contracts() {
    let cat = ok(
        "load_catalog",
        json!({"resources": {
            "mdbase.yaml": "spec_version: \"0.3.0\"\n",
            "_contracts/tasknotes.task.md": spec_file(CONTRACT),
            "_types/task.md": spec_file(TYPE),
        }}),
    );
    assert_eq!(cat["valid"], true, "{}", cat["issues"]);
    assert_eq!(cat["spec_version"], "0.3.0");
    assert_eq!(cat["types"][0]["name"], "task");
    assert_eq!(cat["implementations"][0]["contract"], "tasknotes.task");
    assert_eq!(cat["settings"]["types_folder"], "_types");
}

#[test]
fn validate_record_reports_schema_issues() {
    let resources = json!({
        "mdbase.yaml": "spec_version: \"0.3.0\"\n",
        "_types/task.md": spec_file(TYPE),
    });
    let bad = ok(
        "validate_record",
        json!({"resources": resources, "path": "tasks/a.md", "source": "---\ntype: task\ntitle: 1\n---\n"}),
    );
    assert!(!bad["issues"].as_array().unwrap().is_empty(), "{bad}");
    assert_eq!(bad["types"][0], "task");
}

#[test]
fn validate_schema_checks_an_instance() {
    let schema = json!({"type": "object", "required": ["title"], "properties": {"title": {"type": "string"}}});
    let r = ok(
        "validate_schema",
        json!({"schema": schema, "instance": {"title": "x"}}),
    );
    assert_eq!(r["valid"], true);
    let r = ok("validate_schema", json!({"schema": schema, "instance": {}}));
    assert_eq!(r["valid"], false);
    assert_eq!(r["issues"][0]["code"], "schema_required");
    let e = call(
        "validate_schema",
        json!({"schema": {"type": "nope"}, "instance": 1}),
    );
    assert_eq!(e["error"]["code"], "invalid_schema");
}

#[test]
fn check_query_rejects_unknown_members() {
    let r = ok(
        "check_query",
        json!({"query": {"types": ["task"], "where": "status == 'open'"}}),
    );
    assert_eq!(r["valid"], true);
    let e = call("check_query", json!({"query": {"typo": 1}}));
    assert_eq!(e["error"]["code"], "invalid_query");
}

fn pack_input() -> Value {
    let dir = "examples/v0.3/tasknotes-migration/v0.3";
    let manifest = spec_file(&format!("{dir}/mdbase-pack.yaml"));
    let mut sources = serde_json::Map::new();
    for line in manifest.lines() {
        if let Some(src) = line.trim().strip_prefix("source: ") {
            let src = src.trim_matches('"');
            sources.insert(src.to_owned(), json!(spec_file(&format!("{dir}/{src}"))));
        }
    }
    json!({
        "manifest": manifest,
        "sources": sources,
        "resources": {"mdbase.yaml": "spec_version: \"0.3.0\"\nsettings:\n  validation: error\n"},
        "options": {"installed_by": "dev.mdbase.test"},
    })
}

#[test]
fn pack_assess_then_apply_then_current() {
    let input = pack_input();
    let p = ok(
        "load_pack",
        json!({"manifest": input["manifest"], "sources": input["sources"]}),
    );
    assert_eq!(p["id"], "tasknotes.tasks");
    let a = ok("assess_type_pack", input.clone());
    assert_eq!(a["status"], "install", "{a}");
    assert_eq!(a["applicable"], true);
    let mut apply_in = input.clone();
    apply_in["expected_digest"] = a["assessment_digest"].clone();
    let r = ok("apply_type_pack", apply_in);
    let writes = r["writes"].as_array().unwrap();
    assert!(
        writes.iter().any(|w| w["path"] == "mdbase.lock.yaml"),
        "{r}"
    );
    assert_eq!(writes.len(), 3, "two resources plus the lock");
    // Re-assess with the writes applied: current, nothing to do.
    let mut again = input.clone();
    for w in writes {
        again["resources"][w["path"].as_str().unwrap()] = w["document"].clone();
    }
    let a2 = ok("assess_type_pack", again.clone());
    assert_eq!(a2["status"], "current", "{a2}");
    assert_core_pack_ops(&input, &r);
    assert_eq!(r["ops"].as_array().unwrap().len(), 3);
    for op in r["ops"].as_array().unwrap() {
        assert_eq!(op["kind"], "resource_put");
        assert_eq!(op["mustNotExist"], true);
        assert!(op.get("baseRevision").is_none());
    }
    again["expected_digest"] = a2["assessment_digest"].clone();
    let current = ok("apply_type_pack", again.clone());
    assert_eq!(current["ops"], json!([]));
    assert_eq!(current["writes"], json!([]));
    assert_eq!(current["deletes"], json!([]));
    assert_core_pack_ops(&again, &current);
    // A stale digest is refused.
    let mut stale = input;
    stale["expected_digest"] =
        json!("sha256:0000000000000000000000000000000000000000000000000000000000000000");
    let e = call("apply_type_pack", stale);
    assert_eq!(e["error"]["code"], "concurrent_modification", "{e}");
    assert!(e.get("ok").is_none(), "stale assessments expose no plan");
}

/// Independent comparison to the original core intents (not the output diff).
fn assert_core_pack_ops(input: &Value, result: &Value) {
    use mdbn_core::ids::Hash;
    use mdbn_core::intent::Op;
    use mdbn_core::packs::{AssessOptions, apply_type_pack, load_pack};
    use mdbn_core::state::MemState;

    let pack = load_pack(input["manifest"].as_str().unwrap(), &|p| {
        input["sources"][p].as_str().map(str::to_owned)
    })
    .unwrap();
    let mut state = MemState::new();
    for (path, doc) in input["resources"].as_object().unwrap() {
        state.insert_resource(path, doc.as_str().unwrap());
    }
    let options = AssessOptions {
        installed_by: input["options"]["installed_by"].as_str().unwrap().into(),
        ..AssessOptions::default()
    };
    let digest = Hash::parse(result["assessment"]["assessment_digest"].as_str().unwrap()).unwrap();
    let (_, core_ops) = apply_type_pack(&state, &pack, &options, &digest).unwrap();
    let actual = result["ops"].as_array().unwrap();
    assert_eq!(actual.len(), core_ops.len());
    for (actual, original) in actual.iter().zip(core_ops) {
        let (mut expected, revision) = match original {
            Op::ResourcePut(p) => (
                json!({"kind": "resource_put", "path": p.path, "doc": p.doc, "mustNotExist": p.must_not_exist}),
                p.base_revision,
            ),
            Op::ResourceDelete(d) => (
                json!({"kind": "resource_delete", "path": d.path}),
                d.base_revision,
            ),
            _ => panic!("unexpected pack op"),
        };
        if let Some(revision) = revision {
            expected["baseRevision"] = json!(revision.to_string());
        }
        assert_eq!(*actual, expected);
    }
}

#[test]
fn pack_retirement_preserves_delete_and_lock_cas() {
    use mdbn_core::ids::revision;

    let mut input = pack_input();
    let a = ok("assess_type_pack", input.clone());
    input["expected_digest"] = a["assessment_digest"].clone();
    let installed = ok("apply_type_pack", input.clone());
    for w in installed["writes"].as_array().unwrap() {
        input["resources"][w["path"].as_str().unwrap()] = w["document"].clone();
    }
    // The published spec fixture has two managed resources. Retire the type
    // in the next version, preserving the contract; no hand-built intent.
    input["manifest"] = json!(
        input["manifest"]
            .as_str()
            .unwrap()
            .split("  - kind: type")
            .next()
            .unwrap()
            .replace("version: 0.2.0", "version: 0.3.0")
    );
    let a = ok("assess_type_pack", input.clone());
    assert_eq!(a["status"], "upgrade", "{a}");
    input["expected_digest"] = a["assessment_digest"].clone();
    let upgraded = ok("apply_type_pack", input.clone());
    assert_core_pack_ops(&input, &upgraded);
    let ops = upgraded["ops"].as_array().unwrap();
    let delete = ops
        .iter()
        .find(|op| op["kind"] == "resource_delete")
        .unwrap();
    assert_eq!(delete["path"], "_types/task.md");
    assert_eq!(
        delete["baseRevision"],
        revision(input["resources"]["_types/task.md"].as_str().unwrap()).to_string()
    );
    assert!(delete.get("mustNotExist").is_none());
    let lock = ops.last().unwrap();
    assert_eq!(lock["path"], "mdbase.lock.yaml");
    assert_eq!(lock["mustNotExist"], false);
    assert_eq!(
        lock["baseRevision"],
        revision(input["resources"]["mdbase.lock.yaml"].as_str().unwrap()).to_string()
    );
    assert_eq!(upgraded["deletes"], json!(["_types/task.md"]));
}
