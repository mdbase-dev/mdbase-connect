//! Resource-only JSON bridge: strict inputs, detailed evidence, original guards.
use mdbn_core::ids::{Hash, revision};
use serde_json::{Value, json};

fn call(op: &str, input: Value) -> Value {
    serde_json::from_str(&mdbase_wasm::call(op, &input.to_string())).unwrap()
}
fn setup() -> Value {
    json!({
        "application_id": "app.reader", "declaration_digest": Hash::of(b"declaration").to_string(),
        "requirements": {"configuration": [{"id": "base-extension", "path": "/settings/record_extensions", "predicate": "contains", "value": "base"}]},
        "provisions": {"configuration": [{"requirement": "base-extension", "path": "/settings/record_extensions", "operation": "set_add", "value": "base"}]}
    })
}
fn pack(name: &str) -> Value {
    let source = format!(
        "---\nkind: mdbase.type\nname: {name}\nschema:\n  dialect: json-schema-2020-12\n  value: {{type: object}}\n---\n"
    );
    json!({"provision": {
        "manifest": format!("kind: mdbase.type-pack\nid: example.{name}\nversion: 1.0.0\nresources:\n  - kind: type\n    mode: managed\n    source: type.md\n    target: _types/{name}.md\n    digest: {}\n", revision(&source)),
        "sources": {"type.md": source}
    }, "options": {"installed_by": "app.reader"}})
}
#[test]
fn detailed_resource_scope_preserves_configuration_and_original_guards() {
    let source = "spec_version: '0.3.0'\nsettings:\n  record_extensions: [md, txt]\nx-user: keep\n";
    let resources = json!([{"path": "mdbase.yaml", "source": source}]);
    let a = call(
        "assess_collection_resources",
        json!({"resources": resources, "setup": setup()}),
    );
    assert!(a.get("error").is_none(), "{a}");
    let a = &a["ok"];
    assert_eq!(a["scope"], "resources");
    assert_eq!(a["configuration"]["configuration"][0]["action"], "add");
    assert_eq!(
        a["configuration"]["source_digest"],
        revision(source).to_string()
    );
    assert!(
        a["configuration"]["document"]
            .as_str()
            .unwrap()
            .contains("x-user: keep")
    );
    for field in ["collection_revision", "files", "file_absence", "writable"] {
        assert!(a.get(field).is_none());
    }
    let applied = call(
        "apply_collection_resources",
        json!({"resources": resources, "setup": setup(), "expected_digest": a["assessment_digest"]}),
    );
    assert_eq!(applied["ok"]["assessment"], *a);
    let op = &applied["ok"]["ops"][0];
    assert_eq!(op["kind"], "resource_put");
    assert_eq!(op["path"], "mdbase.yaml");
    assert_eq!(op["baseRevision"], revision(source).to_string());
    assert_eq!(op["mustNotExist"], false);
    assert!(applied["ok"].get("writes").is_none());
}
#[test]
fn strict_nested_packs_emit_one_core_combined_lock() {
    let mut setup = setup();
    setup["provisions"]["type_packs"] = json!([pack("one"), pack("two")]);
    let a = call(
        "assess_collection_resources",
        json!({"resources": [], "setup": setup}),
    );
    assert!(a.get("error").is_none(), "{a}");
    assert_eq!(a["ok"]["type_packs"].as_array().unwrap().len(), 2);
    assert_eq!(a["ok"]["type_packs"][0]["resources"][0]["action"], "create");
    let result = call(
        "apply_collection_resources",
        json!({"resources": [], "setup": setup, "expected_digest": a["ok"]["assessment_digest"]}),
    );
    let ops = result["ok"]["ops"].as_array().unwrap();
    let locks: Vec<_> = ops
        .iter()
        .filter(|op| op["path"] == "mdbase.lock.yaml")
        .collect();
    assert_eq!(locks.len(), 1);
    assert_eq!(locks[0]["mustNotExist"], true);
    assert!(locks[0].get("baseRevision").is_none());
    let lock = mdbn_core::packs::Lock::parse(locks[0]["doc"].as_str().unwrap()).unwrap();
    assert!(lock.receipt("example.one").is_some());
    assert!(lock.receipt("example.two").is_some());
}
#[test]
fn missing_null_duplicate_and_malformed_inventory_never_default_to_empty() {
    let mut cases = vec![json!({"setup": setup()})];
    for resources in [
        Value::Null,
        json!({}),
        json!([{"path": "a", "source": "x"}, {"path": "a", "source": "y"}]),
        json!([{"path": "a"}]),
        json!([{"path": "a", "source": 1}]),
        json!([{"path": "a", "source": "x", "revision": "invented"}]),
        json!([{"path": "../a", "source": "x"}]),
    ] {
        cases.push(json!({"setup": setup(), "resources": resources}));
    }
    for input in cases {
        let r = call("assess_collection_resources", input);
        assert_eq!(r["error"]["code"], "invalid_collection_setup", "{r}");
        assert!(r.get("ok").is_none());
    }
}
#[test]
fn resource_caps_count_utf8_and_apply_before_cloning() {
    use mdbn_core::setup::envelope::*;
    for resources in [
        json!([{"path": "a", "source": "é".repeat(MAX_RESOURCE_SOURCE_BYTES / 2 + 1)}]),
        json!([{"path": "é".repeat(MAX_RESOURCE_PATH_BYTES / 2 + 1), "source": ""}]),
        json!(vec![json!({"path": "a", "source": ""}); MAX_RESOURCE_INVENTORY_ROWS + 1]),
        json!((0..9).map(|i| json!({"path": format!("_types/{i}.md"), "source": "x".repeat(MAX_RESOURCE_SOURCE_BYTES)})).collect::<Vec<_>>()),
    ] {
        let r = call("assess_collection_resources", json!({"setup": setup(), "resources": resources}));
        assert_eq!(r["error"]["code"], "collection_setup_limit_exceeded", "{r}");
    }
}
#[test]
fn stale_inputs_and_conflicts_cannot_produce_operations() {
    let a = call(
        "assess_collection_resources",
        json!({"setup": setup(), "resources": []}),
    );
    for resources in [
        json!([{"path": "_types/other.md", "source": "changed"}]),
        json!([{"path": "mdbase.yaml", "source": "settings:\n  record_extensions: bad\n"}]),
    ] {
        let r = call(
            "apply_collection_resources",
            json!({"setup": setup(), "resources": resources, "expected_digest": a["ok"]["assessment_digest"]}),
        );
        assert_eq!(r["error"]["code"], "concurrent_modification");
        assert!(r.get("ok").is_none());
    }
    let resources =
        json!([{"path": "mdbase.yaml", "source": "settings:\n  record_extensions: bad\n"}]);
    let a = call(
        "assess_collection_resources",
        json!({"setup": setup(), "resources": resources}),
    );
    assert_eq!(a["ok"]["applicable"], false);
    assert_eq!(
        a["ok"]["configuration"]["configuration"][0]["conflict"]["observed"],
        "string"
    );
    let r = call(
        "apply_collection_resources",
        json!({"setup": setup(), "resources": resources, "expected_digest": a["ok"]["assessment_digest"]}),
    );
    assert_eq!(r["error"]["code"], "collection_setup_conflict");
}
#[test]
fn malformed_options_and_provisions_are_not_silently_dropped() {
    let mut cases = Vec::new();
    for (key, value) in [
        ("allow_downgrade", json!("true")),
        ("adopt", Value::Null),
        ("target_overrides", json!([])),
        ("preserve_seed_targets", json!(["a", "a"])),
        ("typo", json!(true)),
    ] {
        let mut p = pack("one");
        p["options"][key] = value;
        cases.push(p);
    }
    let mut p = pack("one");
    p["provision"]["sources"] = Value::Null;
    cases.push(p);
    for p in cases {
        let mut setup = setup();
        setup["provisions"]["type_packs"] = json!([p]);
        let r = call(
            "assess_collection_resources",
            json!({"setup": setup, "resources": []}),
        );
        assert_eq!(r["error"]["code"], "invalid_collection_setup", "{r}");
    }
}
