//! Exact declaration-to-setup binding for capability contract v2 only.
//!
//! This module does NOT verify signatures, proofs, grant scope, or authorization.
//! Callers must supply the ID and unprefixed digest from an already verified,
//! exact grant-bound proof, and retained complete, normalized declaration evidence.
//! Manifest/schema validation remains a registration responsibility. Operation
//! schema validation, runtime choice consent, CAS, and execution authorization
//! remain caller responsibilities. This primitive does not change v1 transcripts.
//!
//! Canonicalization here uses UTF-16 object-key order and ECMAScript binary64
//! number serialization. It is local to this verifier; existing signed transcript
//! canonicalizers are unchanged. Input must already be parsed as valid Unicode
//! JSON; duplicate keys and original numeric lexemes cannot be recovered from a
//! `Value`. As in Node/RFC 8785, numbers are not arbitrary-precision integers.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ApplicationDeclarationError {
    #[error("missing or malformed normalized application declaration evidence")]
    InvalidEvidence,
    #[error("application setup requires capability contract version 2 without legacy operations")]
    UnsupportedCapabilityVersion,
    #[error("application declaration does not match the verified grant binding")]
    BindingMismatch,
    #[error("submitted setup does not match the authenticated declaration projection")]
    SetupMismatch,
    #[error("application declaration is not canonicalizable JSON: {0}")]
    InvalidCanonicalJson(#[from] serde_json::Error),
}

/// Authenticated projection with private fields: construct only by verifying the
/// complete declaration against independently authenticated binding values.
#[derive(Debug, Clone)]
pub struct VerifiedApplicationSetupDeclaration {
    application_id: String,
    declaration_digest: String,
    projection: Value,
}

impl VerifiedApplicationSetupDeclaration {
    /// Exactly `{requirements:{configuration}, provisions:{configuration,type_packs}}`.
    pub fn projection(&self) -> &Value {
        &self.projection
    }

    /// Compare canonical top-level setup input, rejecting nested `setup` and
    /// unknown top-level fields. Requirements/provisions must match in full,
    /// including every nested field and array position.
    ///
    /// Known separate runtime choices and CAS fields are deliberately NOT
    /// validated here, even for type correctness. The caller must validate their
    /// schemas, authorization, consent, and freshness separately before execution.
    pub fn validate_setup_input(&self, input: &Value) -> Result<(), ApplicationDeclarationError> {
        let object = input
            .as_object()
            .ok_or(ApplicationDeclarationError::SetupMismatch)?;
        if object.keys().any(|key| {
            !matches!(
                key.as_str(),
                "application_id"
                    | "declaration_digest"
                    | "requirements"
                    | "provisions"
                    | "contract_setups"
                    | "type_pack_adoptions"
                    | "allow_type_pack_downgrades"
                    | "expected_assessment_digest"
                    | "expected_collection_revision"
                    | "expected_provision_digest"
            )
        }) || input.get("application_id").and_then(Value::as_str)
            != Some(self.application_id.as_str())
            || input.get("declaration_digest").and_then(Value::as_str)
                != Some(self.declaration_digest.as_str())
            || input.get("requirements") != self.projection.get("requirements")
            || input.get("provisions") != self.projection.get("provisions")
        {
            return Err(ApplicationDeclarationError::SetupMismatch);
        }
        Ok(())
    }
}

/// Authenticate the complete retained normalized JSON, without typed
/// reconstruction, dropping unknown content, supplying defaults, or reordering
/// arrays. `expected_digest` is exactly 64 lowercase hex characters (no prefix).
/// The expected values MUST come from an already verified grant-bound proof,
/// never from the request or from the retained declaration itself.
pub fn verify_application_setup_declaration_v2(
    declaration: &Value,
    expected_id: &str,
    expected_digest: &str,
) -> Result<VerifiedApplicationSetupDeclaration, ApplicationDeclarationError> {
    if expected_id.is_empty()
        || expected_digest.len() != 64
        || !expected_digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        || declaration.get("id").and_then(Value::as_str) != Some(expected_id)
    {
        return Err(ApplicationDeclarationError::BindingMismatch);
    }
    let requirements = declaration
        .get("requirements")
        .and_then(Value::as_object)
        .ok_or(ApplicationDeclarationError::InvalidEvidence)?;
    let capabilities = requirements
        .get("capabilities")
        .and_then(Value::as_object)
        .ok_or(ApplicationDeclarationError::UnsupportedCapabilityVersion)?;
    if capabilities.get("contract_version").and_then(Value::as_u64) != Some(2)
        || requirements.contains_key("operations")
        || capabilities
            .keys()
            .any(|key| !matches!(key.as_str(), "contract_version" | "required" | "optional"))
    {
        return Err(ApplicationDeclarationError::UnsupportedCapabilityVersion);
    }
    if !capabilities.get("required").is_some_and(string_array)
        || capabilities
            .get("optional")
            .is_some_and(|v| !string_array(v))
    {
        return Err(ApplicationDeclarationError::InvalidEvidence);
    }
    // These arrays are supplied by declaration normalization. Missing is not empty.
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
            return Err(ApplicationDeclarationError::InvalidEvidence);
        }
    }
    let digest = format!(
        "{:x}",
        Sha256::digest(canonical_declaration_bytes(declaration)?)
    );
    if digest != expected_digest {
        return Err(ApplicationDeclarationError::BindingMismatch);
    }
    Ok(VerifiedApplicationSetupDeclaration {
        application_id: expected_id.to_owned(),
        declaration_digest: format!("sha256:{expected_digest}"),
        projection: json!({
            "requirements": {"configuration": declaration["requirements"]["configuration"]},
            "provisions": {
                "configuration": declaration["provisions"]["configuration"],
                "type_packs": declaration["provisions"]["type_packs"]
            }
        }),
    })
}

// serde_jcs 0.1 orders serialized object keys by bytes. Traverse containers
// ourselves so every nesting level uses raw UTF-16 key ordering instead. Scalars
// still use its ECMAScript-compatible string escaping and float formatter.
fn canonical_declaration_bytes(value: &Value) -> Result<Vec<u8>, ApplicationDeclarationError> {
    let mut output = Vec::new();
    write_canonical_declaration(value, &mut output)?;
    Ok(output)
}

fn write_canonical_declaration(
    value: &Value,
    output: &mut Vec<u8>,
) -> Result<(), ApplicationDeclarationError> {
    match value {
        Value::Object(object) => {
            let mut entries: Vec<_> = object.iter().collect();
            entries.sort_by(|(left, _), (right, _)| left.encode_utf16().cmp(right.encode_utf16()));
            output.push(b'{');
            for (index, (key, child)) in entries.into_iter().enumerate() {
                if index != 0 {
                    output.push(b',');
                }
                serde_jcs::to_writer(&mut *output, key)?;
                output.push(b':');
                write_canonical_declaration(child, output)?;
            }
            output.push(b'}');
        }
        Value::Array(array) => {
            output.push(b'[');
            for (index, child) in array.iter().enumerate() {
                if index != 0 {
                    output.push(b',');
                }
                write_canonical_declaration(child, output)?;
            }
            output.push(b']');
        }
        Value::Number(number) => {
            // Node parses all JSON numbers as binary64. In particular, do not
            // use serde_jcs's integer serializer for serde_json's i64/u64 values:
            // it would preserve integer precision that ECMAScript does not.
            let number = number
                .as_f64()
                .filter(|number| number.is_finite())
                .ok_or(ApplicationDeclarationError::InvalidEvidence)?;
            serde_jcs::to_writer(output, &number)?;
        }
        _ => serde_jcs::to_writer(output, value)?,
    }
    Ok(())
}

fn string_array(value: &Value) -> bool {
    value
        .as_array()
        .is_some_and(|items| items.iter().all(Value::is_string))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn declaration() -> Value {
        json!({
            "manifest_version": 1, "id": "dev.mdbase.fixture", "name": "Café 🦀",
            "distribution": "portable", "description": "e\u{301} ≠ é",
            "requirements": {
                "access": "full_collection", "contracts": [],
                "capabilities": {"contract_version": 2, "required": []},
                "configuration": [{"id":"tags", "path":"/x-fixture/tags", "predicate":"contains", "value":"é"}]
            },
            "provisions": {
                "configuration": [{"requirement":"tags", "operation":"set_add", "path":"/x-fixture/tags", "value":"é"}],
                "type_packs": []
            },
            "notifications": {"criteria": []}
        })
    }

    fn digest(value: &Value) -> String {
        format!(
            "{:x}",
            Sha256::digest(canonical_declaration_bytes(value).unwrap())
        )
    }

    fn verify(
        value: &Value,
        hash: &str,
    ) -> Result<VerifiedApplicationSetupDeclaration, ApplicationDeclarationError> {
        verify_application_setup_declaration_v2(value, "dev.mdbase.fixture", hash)
    }

    fn input(verified: &VerifiedApplicationSetupDeclaration) -> Value {
        let mut input = verified.projection().clone();
        input["application_id"] = json!("dev.mdbase.fixture");
        input["declaration_digest"] = json!(verified.declaration_digest);
        input
    }

    #[test]
    fn exact_projection_and_separate_runtime_choices() {
        let value = declaration();
        let verified = verify(&value, &digest(&value)).unwrap();
        let mut submitted = input(&verified);
        verified.validate_setup_input(&submitted).unwrap();
        for field in [
            "contract_setups",
            "type_pack_adoptions",
            "allow_type_pack_downgrades",
            "expected_assessment_digest",
            "expected_collection_revision",
            "expected_provision_digest",
        ] {
            // Deliberately invalid: accepting binding does NOT validate choices/CAS.
            submitted[field] = json!({"not_validated_here": true});
        }
        verified.validate_setup_input(&submitted).unwrap();
        assert!(verified.projection()["requirements"]
            .get("capabilities")
            .is_none());
    }

    #[test]
    fn complete_declaration_is_hashed_before_projection() {
        let original = declaration();
        for pointer in [
            "/provisions/configuration/0/value",
            "/requirements/configuration/0/value",
            "/name",
            "/description",
        ] {
            let mut changed = original.clone();
            *changed.pointer_mut(pointer).unwrap() = json!("changed");
            assert!(matches!(
                verify(&changed, &digest(&original)),
                Err(ApplicationDeclarationError::BindingMismatch)
            ));
        }
        let mut changed = original.clone();
        changed["provisions"]["type_packs"] = json!([{"extra": "content"}]);
        assert!(verify(&changed, &digest(&original)).is_err());
        changed = original.clone();
        changed["unknown_content"] = json!(true);
        assert!(verify(&changed, &digest(&original)).is_err());
    }

    #[test]
    fn reject_changed_projection_extra_content_and_nested_setup() {
        let value = declaration();
        let verified = verify(&value, &digest(&value)).unwrap();
        let original = input(&verified);
        for pointer in [
            "/requirements/configuration/0/value",
            "/provisions/configuration/0/value",
            "/application_id",
            "/declaration_digest",
        ] {
            let mut changed = original.clone();
            *changed.pointer_mut(pointer).unwrap() = json!("changed");
            assert!(verified.validate_setup_input(&changed).is_err());
        }
        for section in ["requirements", "provisions"] {
            let mut changed = original.clone();
            changed[section]["extra"] = json!([]);
            assert!(verified.validate_setup_input(&changed).is_err());
            changed = original.clone();
            changed[section]["configuration"][0]["extra"] = json!(true);
            assert!(verified.validate_setup_input(&changed).is_err());
        }
        for field in ["setup", "unknown"] {
            let mut changed = original.clone();
            changed[field] = Value::Null;
            assert!(verified.validate_setup_input(&changed).is_err());
        }
        for field in [
            "requirements",
            "provisions",
            "application_id",
            "declaration_digest",
        ] {
            let mut changed = original.clone();
            changed.as_object_mut().unwrap().remove(field);
            assert!(verified.validate_setup_input(&changed).is_err());
        }
        assert!(verified.validate_setup_input(&Value::Null).is_err());
    }

    #[test]
    fn missing_malformed_and_mixed_version_evidence_fails_closed() {
        for pointer in [
            "/requirements/configuration",
            "/provisions/configuration",
            "/provisions/type_packs",
        ] {
            for invalid in [Value::Null, json!({}), json!("[]"), json!([null])] {
                let mut value = declaration();
                *value.pointer_mut(pointer).unwrap() = invalid;
                assert!(verify(&value, &digest(&value)).is_err());
            }
            let mut value = declaration();
            let (parent, field) = pointer.rsplit_once('/').unwrap();
            value
                .pointer_mut(parent)
                .unwrap()
                .as_object_mut()
                .unwrap()
                .remove(field);
            assert!(verify(&value, &digest(&value)).is_err());
        }
        for version in [Value::Null, json!(1), json!(3), json!("2"), json!([1, 2])] {
            let mut value = declaration();
            value["requirements"]["capabilities"]["contract_version"] = version;
            assert!(verify(&value, &digest(&value)).is_err());
        }
        for field in ["contract_version", "required"] {
            let mut value = declaration();
            value["requirements"]["capabilities"]
                .as_object_mut()
                .unwrap()
                .remove(field);
            assert!(verify(&value, &digest(&value)).is_err());
        }
        let mut value = declaration();
        value["requirements"]["operations"] = json!(["read"]);
        assert!(verify(&value, &digest(&value)).is_err());
        value = declaration();
        value["requirements"]
            .as_object_mut()
            .unwrap()
            .remove("capabilities");
        assert!(verify(&value, &digest(&value)).is_err());
        assert!(verify(&Value::Null, &"a".repeat(64)).is_err());
        assert!(verify(
            &declaration(),
            &format!("sha256:{}", digest(&declaration()))
        )
        .is_err());
    }

    #[test]
    fn node_canonical_declaration_fixture() {
        // Generated with Node 22 --experimental-strip-types, importing
        // canonicalSha256 from services/server/src/canonical-json.ts and passing
        // declaration()'s complete object (including composed/decomposed Unicode).
        let expected = "5a89bc3776758737e20c3606fc21c77bdfe8f3e795e6bd8c54233fc6ed2baaec";
        assert_eq!(digest(&declaration()), expected);
        let verified = verify(&declaration(), expected).unwrap();
        verified.validate_setup_input(&input(&verified)).unwrap();
    }

    #[test]
    fn node_nested_unicode_and_numeric_edges_fixture() {
        // Node 22 canonicalJson/canonicalSha256 from
        // services/server/src/canonical-json.ts, using these same numeric
        // literals and adding {embedded: nested} to declaration.provisions.type_packs.
        let numbers = json!([
            -0.0,
            1e-7,
            1e-6,
            1e20,
            1e21,
            f64::from_bits(1),
            f64::MAX,
            333333333.33333329_f64,
            9007199254740991_u64,
            9007199254740993_u64,
            u64::MAX,
            i64::MIN
        ]);
        assert_eq!(
            String::from_utf8(canonical_declaration_bytes(&numbers).unwrap()).unwrap(),
            "[0,1e-7,0.000001,100000000000000000000,1e+21,5e-324,1.7976931348623157e+308,333333333.3333333,9007199254740991,9007199254740992,18446744073709552000,-9223372036854776000]"
        );
        assert_eq!(
            digest(&numbers),
            "5d88dd6e70dc2f6168b5db1d164b20675b880cbbd6275df839b0d6421fb2e9e1"
        );
        let nested = json!({
            "\u{e000}": [{"🦀": numbers, "\u{e000}": "\u{000f}\n\\\"/"}],
            "🦀": {"\u{e000}": true, "😀": null}
        });
        let mut value = declaration();
        value["provisions"]["type_packs"] = json!([{"embedded": nested}]);
        let expected = "5fa7b6c7492e1b9c5c215e245a7c8bccd35989e3b36ea1a4b083c3d28b87199e";
        assert_eq!(digest(&value), expected);
        let verified = verify(&value, expected).unwrap();
        verified.validate_setup_input(&input(&verified)).unwrap();
        assert_eq!(verified.projection()["provisions"], value["provisions"]);
        // No Unicode normalization or dropping unrecognized embedded content.
        value["provisions"]["type_packs"][0]["embedded"]["🦀"]["😀"] = json!(false);
        assert!(verify(&value, expected).is_err());
    }

    #[test]
    fn unicode_object_order_and_array_order() {
        let a: Value = serde_json::from_str(r#"{"🦀":1,"\ue000":2,"a":"é","z":"é"}"#).unwrap();
        let b: Value = serde_json::from_str(r#"{"z":"é","a":"é","\ue000":2,"🦀":1}"#).unwrap();
        assert_eq!(digest(&a), digest(&b));
        // Independently generated with Node canonicalSha256.
        let node_hash = "06fb9cad162ea1afe614c0130ae461d96d35380286998ca6fa49932fd8719773";
        assert_eq!(digest(&a), node_hash);
        assert_eq!(
            String::from_utf8(canonical_declaration_bytes(&a).unwrap()).unwrap(),
            "{\"a\":\"é\",\"z\":\"é\",\"🦀\":1,\"\u{e000}\":2}"
        );
        assert_ne!(
            digest(&json!(["é", "e\u{301}"])),
            digest(&json!(["e\u{301}", "é"]))
        );
        let mut value = declaration();
        value["requirements"]["configuration"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id": "second"}));
        let verified = verify(&value, &digest(&value)).unwrap();
        let mut submitted = input(&verified);
        submitted["requirements"]["configuration"]
            .as_array_mut()
            .unwrap()
            .reverse();
        assert!(verified.validate_setup_input(&submitted).is_err());
        let hash = digest(&value);
        value["requirements"]["configuration"]
            .as_array_mut()
            .unwrap()
            .reverse();
        assert!(verify(&value, &hash).is_err());
    }
}
