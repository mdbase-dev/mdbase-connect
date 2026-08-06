use mdbase_connect_protocol::SyncCollectionResources;
use sha2::{Digest, Sha256};

use crate::error::{ApiError, ApiResult};

#[derive(Debug, Clone)]
pub struct ResourceDocument {
    pub path: &'static str,
    pub kind: &'static str,
    pub revision: String,
    pub document: String,
}

pub fn resources(
    template: &str,
    timezone: &str,
) -> ApiResult<(SyncCollectionResources, Vec<ResourceDocument>)> {
    if timezone.parse::<chrono_tz::Tz>().is_err() {
        return Err(ApiError::bad_request(
            "invalid_timezone",
            "Hosted collection timezone must be a valid IANA identifier.",
        ));
    }
    match template {
        "mdbase" => Ok(mdbase(timezone)),
        _ => Err(ApiError::bad_request(
            "unsupported_template",
            "The hosted provider does not support that collection template.",
        )),
    }
}

fn mdbase(timezone: &str) -> (SyncCollectionResources, Vec<ResourceDocument>) {
    let configuration = format!(
        "spec_version: 0.3.0\nsettings:\n  types_folder: _types\n  default_validation: error\n  timezone: {timezone}\n"
    );
    (
        SyncCollectionResources {
            revision: "mdbase-template:1".to_string(),
            spec_version: "0.3.0".to_string(),
            types: Vec::new(),
            contracts: Vec::new(),
            documents: Vec::new(),
        },
        vec![ResourceDocument {
            path: "mdbase.yaml",
            kind: "configuration",
            revision: format!("sha256:{:x}", Sha256::digest(configuration.as_bytes())),
            document: configuration,
        }],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generic_mdbase_template_has_no_application_contracts() {
        let (resources, documents) = resources("mdbase", "Australia/Melbourne").unwrap();
        assert_eq!(resources.revision, "mdbase-template:1");
        assert!(resources.types.is_empty());
        assert!(resources.contracts.is_empty());
        assert_eq!(documents.len(), 1);
        assert_eq!(documents[0].path, "mdbase.yaml");
        assert_eq!(
            documents[0].revision,
            format!(
                "sha256:{:x}",
                Sha256::digest(documents[0].document.as_bytes())
            )
        );
        assert!(documents[0].document.contains("spec_version: 0.3.0"));
        assert!(documents[0]
            .document
            .contains("timezone: Australia/Melbourne"));
    }
}
