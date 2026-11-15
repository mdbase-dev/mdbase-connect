//! Fixture envelopes must measure Core results, not manufacture successful assertions.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use mdbn_conformance::ops::{self, Group, Unsupported};
use serde_json::{Value, json};

fn run(
    operation: &str,
    setup: &Value,
    input: &Value,
    expect: &Value,
) -> Result<Value, Unsupported> {
    ops::run(operation, Group { setup, expect }, input)
}

#[test]
fn diagnostic_subsets_are_derived_from_actual_errors() {
    let expect =
        json!({"diagnostics_contain": [{"code": "invalid_query"}, {"code": "fabricated"}]});
    let result = run(
        "query",
        &Value::Null,
        &json!({"unknown_query_member": true}),
        &expect,
    )
    .unwrap();
    assert_eq!(result["valid"], false);
    assert_eq!(result["error"]["code"], "invalid_query");
    assert_eq!(
        result["diagnostics_contain"],
        json!([{"code": "invalid_query"}])
    );
}

#[test]
fn body_returned_tracks_real_body_for_selected_rows_too() {
    let setup = json!({"files": {"a.md": "---\ntitle: A\n---\nbody text\n"}});
    for selection in [json!({}), json!({"select": ["title"]})] {
        let without = run("query", &setup, &selection, &Value::Null).unwrap();
        assert_eq!(without["body_returned"], false);
        assert!(without["results"][0].get("body").is_none());
        let mut input = selection;
        input["include_body"] = json!(true);
        let with = run("query", &setup, &input, &Value::Null).unwrap();
        assert_eq!(with["body_returned"], true);
        assert_eq!(with["results"][0]["body"], "body text\n");
    }
}

#[test]
fn unsupported_schema_keywords_do_not_masquerade_as_instance_failures() {
    let result = run(
        "yaml_document_schema_validate",
        &Value::Null,
        &json!({
            "schema": "schemas/v0.3/conformance-claim.schema.json",
            "paths": ["tests/v0.3/fixtures/conformance/valid-core-read.yml"]
        }),
        &json!({"valid": false}),
    );
    assert!(matches!(result, Err(Unsupported::NotImplemented(_))));
}

#[test]
fn missing_artifacts_cannot_vacuously_pass() {
    let result = run(
        "json_document_valid",
        &Value::Null,
        &json!({"paths": ["missing/**/*.json"]}),
        &json!({"valid": true}),
    );
    assert!(matches!(result, Err(Unsupported::NotImplemented(_))));
}

#[test]
fn collection_root_contracts_keep_their_schema_relative_paths() {
    let result = run(
        "data_contract_registry_validate",
        &Value::Null,
        &json!({"paths": ["_contracts/mdbase.view/1.0.0.md"]}),
        &json!({"valid": true}),
    )
    .unwrap();
    assert_eq!(result["valid"], true);
}
