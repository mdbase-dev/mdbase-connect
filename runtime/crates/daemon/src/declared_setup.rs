//! Retained declaration-bound setup evidence from the authenticated grant feed.
//!
//! Mirrors Hosted's `verify_application_setup_declaration_v2`: this verifies
//! binding and projection, not collection semantics, liveness or publication.
//! Call only after verifying the original authorization and Noise attestation.
use crate::attest::{AttestError, Proof};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

mod bridge;

const SETUP: [&str; 2] = ["assess_collection_setup", "apply_collection_setup"];

/// Immutable evidence retained with one cached grant. Its presence alone never
/// authorizes execution: the current grant, account, lease and Replica must agree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeclaredSetupEvidence {
    declaration: Value,
    application_id: String,
    digest: String,
    operations: Vec<String>,
    // Includes original installation/request identity even if the same Noise key
    // and public declaration reappear. CachedGrant equality advances consent.
    authorization_binding_digest: String,
}
impl DeclaredSetupEvidence {
    /// Complete authenticated declaration, never reconstructed split metadata.
    pub fn declaration(&self) -> &Value {
        &self.declaration
    }
    /// Declaration identity, not Connect's application UUID.
    pub fn application_id(&self) -> &str {
        &self.application_id
    }
    /// Original declaration digest, with its canonical `sha256:` prefix.
    pub fn digest(&self) -> &str {
        &self.digest
    }
    /// Exact declaration projection. The trusted installer separately lifts
    /// each declared pack through Core's strict `{provision, options}` bridge.
    pub fn projection(&self) -> Value {
        json!({
            "application_id": self.application_id,
            "declaration_digest": self.digest,
            "requirements": {"configuration": self.declaration["requirements"]["configuration"]},
            "provisions": {
                "configuration": self.declaration["provisions"]["configuration"],
                "type_packs": self.declaration["provisions"]["type_packs"]
            }
        })
    }
}
fn invalid() -> AttestError {
    AttestError::Binding("application_declaration")
}

/// A valid original signed request is not approval of every requested operation.
/// Use the current approved operations from the authenticated feed as well.
pub(crate) fn from_feed(
    feed: &Value,
    proof: &Proof,
) -> Result<Option<DeclaredSetupEvidence>, AttestError> {
    if proof.binding.contracts.semantic_capabilities != 2 {
        return Ok(None);
    }
    let approved: Vec<String> = feed
        .get("operations")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    if !SETUP.iter().any(|op| approved.iter().any(|v| v == op)) {
        return Ok(None);
    }
    if !SETUP.iter().all(|op| approved.iter().any(|v| v == op))
        || approved
            .iter()
            .any(|op| !proof.binding.requested_operations.contains(op))
    {
        return Err(invalid());
    }
    let declaration = feed.get("application_declaration").ok_or_else(invalid)?;
    let binding = &proof.binding;
    if declaration.get("id").and_then(Value::as_str)
        != Some(binding.application_declaration_id.as_str())
        || declaration
            .pointer("/requirements/capabilities/contract_version")
            .and_then(Value::as_u64)
            != Some(2)
        || declaration.pointer("/requirements/operations").is_some()
    {
        return Err(invalid());
    }
    let capabilities = declaration
        .pointer("/requirements/capabilities")
        .and_then(Value::as_object)
        .ok_or_else(invalid)?;
    if capabilities
        .keys()
        .any(|k| !matches!(k.as_str(), "contract_version" | "required" | "optional"))
        || !capabilities.get("required").is_some_and(string_array)
        || capabilities
            .get("optional")
            .is_some_and(|v| !string_array(v))
    {
        return Err(invalid());
    }
    for pointer in [
        "/requirements/configuration",
        "/provisions/configuration",
        "/provisions/type_packs",
    ] {
        if !declaration
            .pointer(pointer)
            .and_then(Value::as_array)
            .is_some_and(|items| items.iter().all(Value::is_object))
        {
            return Err(invalid());
        }
    }
    if ["/provisions/configuration", "/provisions/type_packs"]
        .iter()
        .all(|p| {
            declaration
                .pointer(p)
                .and_then(Value::as_array)
                .is_none_or(Vec::is_empty)
        })
    {
        return Err(invalid());
    }
    let mut canonical = Vec::new();
    canonical_json(declaration, &mut canonical)?;
    let digest = format!("{:x}", Sha256::digest(&canonical));
    if digest != binding.application_manifest_digest {
        return Err(invalid());
    }
    Ok(Some(DeclaredSetupEvidence {
        declaration: declaration.clone(),
        application_id: binding.application_declaration_id.clone(),
        digest: format!("sha256:{digest}"),
        operations: approved,
        authorization_binding_digest: format!(
            "{:x}",
            Sha256::digest(serde_jcs::to_vec(binding).map_err(|_| invalid())?)
        ),
    }))
}
fn string_array(value: &Value) -> bool {
    value
        .as_array()
        .is_some_and(|v| v.iter().all(Value::is_string))
}

// Same UTF-16 object-key ordering and ECMAScript binary64 scalar serialization
// as Hosted's declaration verifier. Do not reuse a signed transcript serializer
// with different ordering, number precision or escaping rules.
fn canonical_json(value: &Value, output: &mut Vec<u8>) -> Result<(), AttestError> {
    match value {
        Value::Object(object) => {
            let mut entries: Vec<_> = object.iter().collect();
            entries.sort_by(|(a, _), (b, _)| a.encode_utf16().cmp(b.encode_utf16()));
            output.push(b'{');
            for (i, (key, child)) in entries.into_iter().enumerate() {
                if i != 0 {
                    output.push(b',');
                }
                serde_jcs::to_writer(&mut *output, key).map_err(|_| invalid())?;
                output.push(b':');
                canonical_json(child, output)?;
            }
            output.push(b'}');
        }
        Value::Array(array) => {
            output.push(b'[');
            for (i, child) in array.iter().enumerate() {
                if i != 0 {
                    output.push(b',');
                }
                canonical_json(child, output)?;
            }
            output.push(b']');
        }
        Value::Number(number) => {
            let number = number
                .as_f64()
                .filter(|n| n.is_finite())
                .ok_or_else(invalid)?;
            serde_jcs::to_writer(output, &number).map_err(|_| invalid())?;
        }
        _ => serde_jcs::to_writer(output, value).map_err(|_| invalid())?,
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_declaration_matches_hosted_utf16_key_order() {
        let value = json!({"\u{e000}": 2, "😀": 1});
        let mut bytes = Vec::new();
        canonical_json(&value, &mut bytes).unwrap();
        assert_eq!(
            String::from_utf8(bytes).unwrap(),
            "{\"😀\":1,\"\u{e000}\":2}"
        );
    }

    #[test]
    fn canonical_declaration_uses_ecmascript_binary64_numbers() {
        let value = json!([1e20, 1e21, 1e-7, -0.0]);
        let mut bytes = Vec::new();
        canonical_json(&value, &mut bytes).unwrap();
        assert_eq!(
            String::from_utf8(bytes).unwrap(),
            "[100000000000000000000,1e+21,1e-7,0]"
        );
    }
}
