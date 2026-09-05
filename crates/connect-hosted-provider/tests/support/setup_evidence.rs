use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use mdbase_connect_protocol::{
    application_installation_id, ApplicationAuthorizationBinding, ApplicationAuthorizationProof,
};
use p256::ecdsa::{signature::Signer, Signature, SigningKey};
use serde_json::{json, Value};
use uuid::Uuid;

pub fn setup_evidence(collection_id: Uuid) -> (Value, Value, String) {
    let (evidence, input, grant_key, _) = setup_evidence_with_signer(collection_id);
    (evidence, input, grant_key)
}

// The same fixture module is included by unit tests that only need revision A.
#[allow(dead_code)]
pub fn setup_evidence_revisions(collection_id: Uuid) -> (Value, Value, Value, String) {
    use sha2::{Digest, Sha256};
    let (a, input, grant_key, signer) = setup_evidence_with_signer(collection_id);
    let mut b = a.clone();
    b["application_declaration"]["name"] = json!("Revision B");
    // This fixture has only ASCII object keys, strings and integer 1/2: serde's
    // sorted-key JSON bytes match the Node canonical declaration serialization.
    let digest = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&b["application_declaration"]).unwrap())
    );
    let mut binding: ApplicationAuthorizationBinding =
        serde_json::from_value(a["application_authorization"]["binding"].clone()).unwrap();
    binding.authorization_id = Uuid::new_v4();
    binding.application_manifest_digest = digest;
    let signature: Signature = signer.sign(&binding.signing_message().unwrap());
    let signature = signature.normalize_s().unwrap_or(signature);
    let proof = ApplicationAuthorizationProof {
        binding,
        signature: URL_SAFE_NO_PAD.encode(signature.to_bytes()),
    };
    proof.verify().unwrap();
    mdbase_connect_protocol::verify_application_setup_declaration_v2(
        &b["application_declaration"],
        &proof.binding.application_declaration_id,
        &proof.binding.application_manifest_digest,
    )
    .unwrap();
    b["application_authorization"] = serde_json::to_value(proof).unwrap();
    (a, b, input, grant_key)
}

fn setup_evidence_with_signer(collection_id: Uuid) -> (Value, Value, String, SigningKey) {
    let key = SigningKey::random(&mut rand_core::OsRng);
    let public = |key: &SigningKey| {
        URL_SAFE_NO_PAD.encode(key.verifying_key().to_encoded_point(false).as_bytes())
    };
    let installation_key = public(&key);
    let grant_key = public(&SigningKey::random(&mut rand_core::OsRng));
    let declaration = json!({
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
    });
    let digest = "5a89bc3776758737e20c3606fc21c77bdfe8f3e795e6bd8c54233fc6ed2baaec";
    let binding: ApplicationAuthorizationBinding = serde_json::from_value(json!({
        "protocol_version": 5, "authorization_id": Uuid::new_v4(), "application_id": Uuid::new_v4(),
        "application_declaration_id": "dev.mdbase.fixture", "application_manifest_digest": digest,
        "application_installation_id": application_installation_id(&installation_key).unwrap(),
        "installation_signing_public_key": installation_key,
        "grant_agreement_public_key": public(&SigningKey::random(&mut rand_core::OsRng)),
        "grant_signing_public_key": grant_key, "flow": "device_code",
        "authorization_nonce": URL_SAFE_NO_PAD.encode([1_u8;32]),
        "issued_at": "2026-01-01T00:00:00Z", "expires_at": "2026-01-01T00:10:00Z",
        "code_challenge": URL_SAFE_NO_PAD.encode([2_u8;32]),
        "contracts": {"operation_transport":3, "operation_transport_recovery":[2], "authorization_binding":5, "semantic_capabilities":2, "durable_mutation":1},
        "requested_operations": ["assess_collection_setup", "apply_collection_setup"],
        "collection_id": collection_id
    })).unwrap();
    let signature: Signature = key.sign(&binding.signing_message().unwrap());
    let signature = signature.normalize_s().unwrap_or(signature);
    let proof = ApplicationAuthorizationProof {
        binding,
        signature: URL_SAFE_NO_PAD.encode(signature.to_bytes()),
    };
    proof.verify().unwrap();
    let input = json!({
        "application_id": "dev.mdbase.fixture", "declaration_digest": format!("sha256:{digest}"),
        "requirements": {"configuration": declaration["requirements"]["configuration"]},
        "provisions": declaration["provisions"]
    });
    (
        json!({"application_declaration":declaration, "application_authorization":proof}),
        input,
        grant_key,
        key,
    )
}
