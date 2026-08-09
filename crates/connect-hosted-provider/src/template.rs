use mdbase_connect_protocol::SyncCollectionResources;
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
    vec![
        starter_record(
            "019c0000-0000-7000-8000-000000000001",
            "Start here.md",
            r#"# Welcome to mdbase

This is your first hosted collection. It is private to your account until you explicitly give an app access.

## Try the editor

1. Change a sentence in this note and save it.
2. Create a new note of your own.
3. Move between notes using the collection list.

Everything here is ordinary Markdown. The editor is one view of the collection, not the place your data is locked away.

## When you are ready

- Read [[How collections work]].
- Open [[Build with mdbase]] when you want to connect another app or build one of your own.
"#,
        ),
        starter_record(
            "019c0000-0000-7000-8000-000000000002",
            "How collections work.md",
            r#"# How collections work

A collection is a set of Markdown records with one authority. This starter collection is hosted by mdbase connect, so it is available wherever you sign in.

Apps never receive access just because you have an account. When an app asks to connect, mdbase shows you the collection and permissions it wants. You approve that grant explicitly and can revoke it later.

You can also mirror a hosted collection to a local folder with the desktop connector. The Markdown stays useful with or without a particular app.
"#,
        ),
        starter_record(
            "019c0000-0000-7000-8000-000000000003",
            "Build with mdbase.md",
            r#"# Build with mdbase

The editor is your first mdbase app. It gives you a simple place to learn the model before you connect anything else.

From here you can:

- [install the desktop connector](https://mdbase.dev/downloads/) to mirror a collection to a folder;
- authorize another mdbase app for only the collection and permissions it needs; or
- [read the developer documentation](https://mdbase.dev/docs/) and build an app against mdbase connect.

Keep this collection, rename it, or delete it when it has done its job. Deleting it will not make another starter collection appear.
"#,
        ),
    ]
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
        assert_eq!(template.records[0].path, "Start here.md");
        assert!(template.records[0].document.contains("Try the editor"));
        assert!(template.records[2]
            .document
            .contains("developer documentation"));
    }
}
