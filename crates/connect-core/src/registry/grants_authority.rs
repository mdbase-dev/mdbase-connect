use super::*;

/// Digest the exact normalized policy authority represented by the wire type.
/// Array order is normalized by grant ID; serde decides optional field presence,
/// including the retained consenting account. No local reconstruction of identity.
pub fn canonical_policy_authority_digest(
    connector_id: Uuid,
    grants: &[GrantPolicy],
) -> Result<String, ConnectError> {
    let mut grants = grants.to_vec();
    grants.sort_by_key(|grant| grant.id);
    let body = serde_json::json!({
        "connector_id": connector_id,
        "grants": grants,
    });
    let canonical = serde_jcs::to_vec(&body)?;
    Ok(format!("sha256:{:x}", Sha256::digest(canonical)))
}
