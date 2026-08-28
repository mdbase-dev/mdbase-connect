use super::*;

pub(super) fn validate_collection_setup_binding(
    input: &serde_json::Value,
    grant: &mdbase_connect_protocol::GrantSummary,
) -> Result<(), ConnectError> {
    if input.get("setup").is_some() {
        return Err(declaration_mismatch());
    }
    let application_id = input["application_id"].as_str();
    let declaration_digest = input["declaration_digest"].as_str();
    if application_id != Some(grant.application_declaration_id.as_str())
        || declaration_digest
            != Some(format!("sha256:{}", grant.application_manifest_digest).as_str())
    {
        return Err(declaration_mismatch());
    }
    Ok(())
}

fn declaration_mismatch() -> ConnectError {
    ConnectError::ApplicationDeclarationMismatch(
        "Collection setup must use canonical top-level fields matching the exact application declaration bound to this grant."
            .to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use mdbase_connect_protocol::{ConnectContractRequirements, GrantScope, GrantSummary};
    use uuid::Uuid;

    #[test]
    fn collection_setup_mismatch_uses_the_authorization_recovery_code() {
        let grant = GrantSummary {
            id: Uuid::new_v4(),
            application_id: Uuid::new_v4(),
            application_declaration_id: "dev.mdbase.tasks".to_string(),
            application_manifest_digest: "a".repeat(64),
            application_name: "Tasks".to_string(),
            application_distribution: "web".to_string(),
            application_homepage: "https://tasks.example".to_string(),
            application_project_url: None,
            application_origin: Some("https://tasks.example".to_string()),
            application_icon: None,
            collection_id: Uuid::new_v4(),
            collection_name: "Tasks".to_string(),
            operations: vec!["assess_collection_setup".to_string()],
            scope: GrantScope::full_collection(),
            notification_criteria: Vec::new(),
            created_at: "2026-08-23T00:00:00Z".to_string(),
            encryption: None,
            file_capability: None,
            contracts: ConnectContractRequirements::current(false),
        };
        let exact = serde_json::json!({
            "application_id": "dev.mdbase.tasks",
            "declaration_digest": format!("sha256:{}", "a".repeat(64)),
        });
        validate_collection_setup_binding(&exact, &grant).unwrap();

        for ambiguous in [
            serde_json::json!({
                "application_id": "dev.mdbase.other",
                "declaration_digest": format!("sha256:{}", "b".repeat(64)),
                "setup": {
                    "application_id": "dev.mdbase.tasks",
                    "declaration_digest": format!("sha256:{}", "a".repeat(64)),
                }
            }),
            serde_json::json!({
                "application_id": "dev.mdbase.tasks",
                "declaration_digest": format!("sha256:{}", "a".repeat(64)),
                "setup": {
                    "application_id": "dev.mdbase.other",
                    "declaration_digest": format!("sha256:{}", "b".repeat(64)),
                }
            }),
        ] {
            assert_eq!(
                validate_collection_setup_binding(&ambiguous, &grant)
                    .unwrap_err()
                    .code(),
                "application_declaration_mismatch"
            );
        }

        for mismatch in [
            serde_json::json!({
                "application_id": "dev.mdbase.other",
                "declaration_digest": format!("sha256:{}", "a".repeat(64)),
            }),
            serde_json::json!({
                "application_id": "dev.mdbase.tasks",
                "declaration_digest": format!("sha256:{}", "b".repeat(64)),
            }),
        ] {
            assert_eq!(
                validate_collection_setup_binding(&mismatch, &grant)
                    .unwrap_err()
                    .code(),
                "application_declaration_mismatch"
            );
        }
    }
}
