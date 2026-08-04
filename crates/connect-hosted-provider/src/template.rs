use mdbase_connect_protocol::SyncCollectionResources;
use sha2::{Digest, Sha256};

use crate::error::{ApiError, ApiResult};

const MDBASE_TEMPLATE_REVISION: &str = "mdbase-template:2";
const MDBASE_CONFIGURATION: &str = r#"spec_version: 0.3.0
settings:
  types_folder: _types
  default_validation: error
x-obsidian:
  bases:
    include:
      - views/**/*.base
    create_folder: views
    default_for_new_views: true
"#;

#[derive(Debug, Clone)]
pub struct ResourceDocument {
    pub path: &'static str,
    pub kind: &'static str,
    pub revision: String,
    pub document: &'static str,
}

pub fn resources(template: &str) -> ApiResult<(SyncCollectionResources, Vec<ResourceDocument>)> {
    match template {
        "mdbase" => Ok(mdbase()),
        _ => Err(ApiError::bad_request(
            "unsupported_template",
            "The hosted provider does not support that collection template.",
        )),
    }
}

fn mdbase() -> (SyncCollectionResources, Vec<ResourceDocument>) {
    (
        SyncCollectionResources {
            revision: MDBASE_TEMPLATE_REVISION.to_string(),
            spec_version: "0.3.0".to_string(),
            types: Vec::new(),
            contracts: Vec::new(),
            documents: Vec::new(),
        },
        vec![ResourceDocument {
            path: "mdbase.yaml",
            kind: "configuration",
            revision: format!(
                "sha256:{:x}",
                Sha256::digest(MDBASE_CONFIGURATION.as_bytes())
            ),
            document: MDBASE_CONFIGURATION,
        }],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generic_mdbase_template_enables_portable_base_views_without_app_contracts() {
        let (resources, documents) = resources("mdbase").unwrap();
        assert_eq!(resources.revision, MDBASE_TEMPLATE_REVISION);
        assert!(resources.types.is_empty());
        assert!(resources.contracts.is_empty());
        assert_eq!(documents.len(), 1);
        assert_eq!(documents[0].path, "mdbase.yaml");
        assert_eq!(
            documents[0].revision,
            format!("sha256:{:x}", Sha256::digest(documents[0].document))
        );
        assert!(documents[0].document.contains("spec_version: 0.3.0"));
        assert!(documents[0]
            .document
            .contains("include:\n      - views/**/*.base"));
        assert!(documents[0].document.contains("create_folder: views"));
        assert!(documents[0]
            .document
            .contains("default_for_new_views: true"));
    }
}
