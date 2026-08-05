use super::*;

pub(super) fn validate_collection_setup_binding(
    input: &serde_json::Value,
    grant: &mdbase_connect_protocol::GrantSummary,
) -> Result<(), ConnectError> {
    let setup = if input.get("setup").is_some() {
        &input["setup"]
    } else {
        input
    };
    let application_id = setup["application_id"].as_str();
    let declaration_digest = setup["declaration_digest"].as_str();
    if application_id != Some(grant.application_declaration_id.as_str())
        || declaration_digest
            != Some(format!("sha256:{}", grant.application_manifest_digest).as_str())
    {
        return Err(ConnectError::AccessDenied(
            "Collection setup must match the exact application declaration bound to this grant."
                .to_string(),
        ));
    }
    Ok(())
}
