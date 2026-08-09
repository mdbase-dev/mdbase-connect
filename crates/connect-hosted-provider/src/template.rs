use mdbase_connect_protocol::SyncCollectionResources;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::workspace::StoredDocument;

#[derive(Debug, Clone)]
pub struct ResourceDocument {
    pub path: &'static str,
    pub kind: &'static str,
    pub revision: String,
    pub document: String,
}

#[derive(Debug, Clone)]
pub struct CollectionTemplate {
    pub resources: SyncCollectionResources,
    pub documents: Vec<ResourceDocument>,
    pub records: Vec<StoredDocument>,
}

pub fn resources(template: &str, timezone: &str) -> ApiResult<CollectionTemplate> {
    if timezone.parse::<chrono_tz::Tz>().is_err() {
        return Err(ApiError::bad_request(
            "invalid_timezone",
            "Hosted collection timezone must be a valid IANA identifier.",
        ));
    }
    match template {
        "mdbase" => Ok(mdbase(timezone, Vec::new())),
        "onboarding" => Ok(mdbase(timezone, onboarding_records())),
        _ => Err(ApiError::bad_request(
            "unsupported_template",
            "The hosted provider does not support that collection template.",
        )),
    }
}

fn mdbase(timezone: &str, records: Vec<StoredDocument>) -> CollectionTemplate {
    let configuration = format!(
        "spec_version: 0.3.0\nsettings:\n  types_folder: _types\n  default_validation: error\n  timezone: {timezone}\n"
    );
    CollectionTemplate {
        resources: SyncCollectionResources {
            revision: "mdbase-template:1".to_string(),
            spec_version: "0.3.0".to_string(),
            types: Vec::new(),
            contracts: Vec::new(),
            documents: Vec::new(),
        },
        documents: vec![ResourceDocument {
            path: "mdbase.yaml",
            kind: "configuration",
            revision: format!("sha256:{:x}", Sha256::digest(configuration.as_bytes())),
            document: configuration,
        }],
        records,
    }
}

fn onboarding_records() -> Vec<StoredDocument> {
    let manifest: StarterTemplateManifest = serde_json::from_str(include_str!(
        "../../../templates/onboarding/v1/template.json"
    ))
    .expect("the embedded onboarding template manifest is valid");
    assert_eq!(manifest.id, "onboarding");
    assert_eq!(manifest.version, "starter-v1");
    assert_eq!(manifest.name, "Welcome to mdbase");
    manifest
        .records
        .into_iter()
        .map(|record| {
            let document = match record.path.as_str() {
                "Start here.md" => include_str!("../../../templates/onboarding/v1/Start here.md"),
                "How collections work.md" => {
                    include_str!("../../../templates/onboarding/v1/How collections work.md")
                }
                "Build with mdbase.md" => {
                    include_str!("../../../templates/onboarding/v1/Build with mdbase.md")
                }
                path => panic!("onboarding template record has no embedded document: {path}"),
            };
            starter_record(&record.record_id, &record.path, document)
        })
        .collect()
}

#[derive(Debug, Deserialize)]
struct StarterTemplateManifest {
    id: String,
    version: String,
    name: String,
    records: Vec<StarterTemplateRecord>,
}

#[derive(Debug, Deserialize)]
struct StarterTemplateRecord {
    record_id: String,
    path: String,
}

fn starter_record(record_id: &str, path: &str, document: &str) -> StoredDocument {
    StoredDocument {
        record_id: Uuid::parse_str(record_id).expect("starter record IDs are valid UUIDs"),
        path: path.to_string(),
        document: document.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn generic_mdbase_template_has_no_application_contracts() {
        let template = resources("mdbase", "Australia/Melbourne").unwrap();
        assert_eq!(template.resources.revision, "mdbase-template:1");
        assert!(template.resources.types.is_empty());
        assert!(template.resources.contracts.is_empty());
        assert!(template.records.is_empty());
        assert_eq!(template.documents.len(), 1);
        assert_eq!(template.documents[0].path, "mdbase.yaml");
        assert_eq!(
            template.documents[0].revision,
            format!(
                "sha256:{:x}",
                Sha256::digest(template.documents[0].document.as_bytes())
            )
        );
        assert!(template.documents[0]
            .document
            .contains("spec_version: 0.3.0"));
        assert!(template.documents[0]
            .document
            .contains("timezone: Australia/Melbourne"));
    }

    #[test]
    fn onboarding_template_contains_a_small_editable_start() {
        let template = resources("onboarding", "UTC").unwrap();
        assert_eq!(template.records.len(), 3);
        assert_eq!(
            template
                .records
                .iter()
                .map(|record| record.record_id)
                .collect::<HashSet<_>>()
                .len(),
            template.records.len()
        );
        assert_eq!(
            template
                .records
                .iter()
                .map(|record| record.path.as_str())
                .collect::<HashSet<_>>()
                .len(),
            template.records.len()
        );
        assert_eq!(template.records[0].path, "Start here.md");
        assert!(template.records[0].document.contains("Try the editor"));
        assert!(template.records[2]
            .document
            .contains("developer documentation"));
    }
}
