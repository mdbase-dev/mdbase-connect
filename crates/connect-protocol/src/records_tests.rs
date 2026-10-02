use super::*;
use serde::de::DeserializeOwned;

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../packages/protocol/test/fixtures/authority-features-v1.json"
    ))
    .unwrap()
}

fn roundtrip<T: DeserializeOwned + Serialize>(key: &str) {
    let value = fixture()[key].clone();
    let parsed: T = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(serde_json::to_value(parsed).unwrap(), value, "{key}");
}

#[test]
fn authority_features_rust_ts_fixture_parity() {
    for key in ["legacy_description", "description"] {
        roundtrip::<CollectionDescription>(key);
    }
    for key in ["legacy_files_page", "files_page"] {
        roundtrip::<ListFilesPage>(key);
    }
    for key in ["legacy_query_record", "query_record"] {
        roundtrip::<QueryRecord>(key);
    }
    roundtrip::<QueryMetadataResult>("metadata_result");
    roundtrip::<ReadInput>("batch_input");
    roundtrip::<ReadManyDocumentsResult>("batch_result");
    for key in ["stat_path", "stat_id"] {
        roundtrip::<StatFileRequest>(key);
    }
    for key in ["stat_found", "stat_missing"] {
        roundtrip::<FileStat>(key);
    }
}

#[test]
fn extended_requests_reject_ambiguous_targets_nulls_and_extras() {
    let fixture = fixture();
    for value in fixture["invalid_stat_inputs"].as_array().unwrap() {
        assert!(
            serde_json::from_value::<StatFileRequest>(value.clone()).is_err(),
            "{value}"
        );
    }
    for value in fixture["invalid_read_inputs"].as_array().unwrap() {
        assert!(
            serde_json::from_value::<ReadInput>(value.clone()).is_err(),
            "{value}"
        );
    }
    assert!(serde_json::from_value::<ReadInput>(serde_json::json!({
        "paths": vec!["a.md"; MAX_READ_MANY_PATHS]
    }))
    .is_ok());
    assert!(serde_json::from_value::<ReadInput>(serde_json::json!({
        "paths": vec!["a.md"; MAX_READ_MANY_PATHS + 1]
    }))
    .is_err());
    assert_eq!(MAX_READ_MANY_RESPONSE_BYTES, 8 * 1024 * 1024);
}

#[test]
fn metadata_requires_revision_and_values_and_forbids_document_fields() {
    let row = fixture()["metadata_result"]["results"][0].clone();
    for key in ["revision", "values"] {
        let mut invalid = row.clone();
        invalid.as_object_mut().unwrap().remove(key);
        assert!(serde_json::from_value::<QueryMetadataRecord>(invalid).is_err());
    }
    for key in [
        "file",
        "frontmatter",
        "effective_frontmatter",
        "body",
        "document",
    ] {
        let mut invalid = row.clone();
        invalid[key] = serde_json::json!({});
        assert!(serde_json::from_value::<QueryMetadataRecord>(invalid).is_err());
    }
}

// Consumer: N-1 Rust response readers. Remove once minimum-version and rollback
// windows close. Their normal serde structs ignore additive response members.
#[test]
fn predecessor_readers_ignore_additive_responses() {
    #[derive(Serialize, Deserialize)]
    struct LegacyDescription {
        protocol_version: u32,
        collection_id: Uuid,
        display_name: String,
        spec_version: String,
        operations: Vec<String>,
        change_cursor: u64,
        types: Vec<Value>,
        contracts: Vec<Value>,
    }
    #[derive(Serialize, Deserialize)]
    struct LegacyFilesPage {
        protocol_version: u32,
        r#type: String,
        files: Vec<Value>,
    }
    #[derive(Serialize, Deserialize)]
    struct LegacyQueryRecord {
        path: String,
        types: Vec<String>,
        file: Value,
        values: Value,
    }
    let fixture = fixture();
    let description: LegacyDescription =
        serde_json::from_value(fixture["description"].clone()).unwrap();
    assert_eq!(
        serde_json::to_value(description).unwrap(),
        fixture["legacy_description"]
    );
    let page: LegacyFilesPage = serde_json::from_value(fixture["files_page"].clone()).unwrap();
    assert_eq!(
        serde_json::to_value(page).unwrap(),
        fixture["legacy_files_page"]
    );
    let record: LegacyQueryRecord =
        serde_json::from_value(fixture["query_record"].clone()).unwrap();
    assert_eq!(
        serde_json::to_value(record).unwrap(),
        fixture["legacy_query_record"]
    );
}

#[test]
fn stat_uses_canonical_nonmutating_discriminator() {
    let input = fixture()["stat_path"].clone();
    assert!(FILE_CONTROL_MESSAGE_TYPES.contains(&"stat_file"));
    assert!(validate_operation_discriminators("file_control", &input).is_ok());
    assert_eq!(
        operation_input_schema_version("file_control", &input),
        Some(1)
    );
    assert!(!is_mutating_operation("file_control", &input));
}
